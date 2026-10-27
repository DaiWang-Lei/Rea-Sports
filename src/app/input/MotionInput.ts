/**
 * 游戏页的体感输入：管理 Joy-Con（WebHID）和手机（WebRTC / 本地中转），
 * 每个设备一条处理链：姿态融合 → 球拍模型 → 挥拍识别 / 抛球识别；当前设备的挥拍、抛球与按键交给游戏。
 */
import { HAPTICS, type HapticEvent } from '@/config/haptics';
import { MotionState } from '@/input/fusion/MotionState';
import {
  getGrantedJoyCons,
  isWebHidSupported,
  onJoyConConnect,
  onJoyConDisconnect,
  requestJoyCons,
} from '@/input/HidManager';
import { JoyConDriver } from '@/input/joycon/JoyConDriver';
import { PaddleModel } from '@/input/paddle/PaddleModel';
import {
  SWING_PROFILES,
  type SwingCommit,
  SwingDetector,
  type SwingPeak,
} from '@/input/paddle/SwingDetector';
import { type TossEvent, TossDetector } from '@/input/paddle/TossDetector';
import {
  devLanInfo,
  type PhoneDevice,
  PhoneHub,
  phonePageUrl,
  RelayGameLink,
  RtcGameLink,
} from '@/input/phone/PhoneHub';
import { type Buttons, isLogicalDown, type ImuSample, type LogicalButton } from '@/input/types';
import type { SwingFeatures } from '@/sim/hit/HitResolver';
import type { Stroke } from '@/sim/players/PlayerSim';
import { roomCode } from './room';

export type DeviceKind = 'joycon' | 'phone';

export interface InputDevice {
  key: string;
  kind: DeviceKind;
  name: string;
  joycon?: JoyConDriver;
  phone?: PhoneDevice;
  motion: MotionState;
  paddle: PaddleModel;
  detector: SwingDetector;
  toss: TossDetector;
  samples: number;
  lastSampleAt: number;
  lastActivityAt: number;
  /** 上次看到的陀螺仪零点学习时刻：变了就清掉偏航漂移速度 */
  biasSeenAt: number;
}

export interface SwingEventOut {
  device: InputDevice;
  commit: SwingCommit;
  /** 已按左右手镜像：正手 = +1 */
  dir: 1 | -1 | 0;
  stroke: Stroke;
  features: SwingFeatures;
}

export interface PeakEventOut {
  device: InputDevice;
  peak: SwingPeak;
  features: SwingFeatures;
  /** 这一下用的「平时拍面角度」基准（弧度，记下这一下之前的值） */
  neutralPitch: number;
}

/** 校准 / 回中（拍头指向电视）的结果：done 完成；notPointing 拍头朝上 / 朝下，看不出指向哪 */
export type CalibrateResult = 'done' | 'notPointing';

export interface MotionInputEvents {
  onSwing?: (e: SwingEventOut) => void;
  onPeak?: (e: PeakEventOut) => void;
  /** 向上抖手柄抛球（只在 tossEnabled 时给出） */
  onToss?: (device: InputDevice, toss: TossEvent) => void;
  /** 校准 / 回中（Joy-Con 按住 X + ZR / ↑ + ZL，或游戏调 requestCalibration）的结果 */
  onCalibrate?: (device: InputDevice, result: CalibrateResult) => void;
  onButton?: (b: LogicalButton, down: boolean, device: InputDevice) => void;
  onDevicesChanged?: () => void;
  onLinkStatus?: (text: string, ok: boolean) => void;
  /** 录制用：Joy-Con 的原始输入报告 */
  onRawReport?: (device: InputDevice, reportId: number, data: Uint8Array, arrival: number) => void;
  /** 录制用：手机样本（已换算到机体系） */
  onRawSample?: (device: InputDevice, sample: ImuSample) => void;
}

// 握法自 2026-10-23 起固定（见 DEVICE_GRIP），不再保存；以前存的 rea-grip-* 不再读取
const HANDED_KEY = 'rea-handed';
/** 校准 / 回中组合键（像 Nintendo Switch Sports）：Joy-Con R 按住 X + ZR，Joy-Con L 按住 ↑ + ZL */
function calibrateCombo(side: 'L' | 'R', b: Buttons): boolean {
  return side === 'R' ? b.x && b.zr : b.up && b.zl;
}

function loadJson<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式等：不保存
  }
}

export class MotionInput {
  readonly devices = new Map<string, InputDevice>();
  events: MotionInputEvents = {};
  hub: PhoneHub | null = null;
  /** 手机要打开的网址（二维码），本地开发为局域网地址 */
  phoneUrl: string | null = null;
  room: string | null = null;
  linkKind: 'relay' | 'rtc' | null = null;
  handed: 1 | -1 = 1;
  /** 等球时自动校正当前设备的电视方向（游戏进行中、未暂停时由游戏打开） */
  autoHeading = false;
  /** 识别向上抖手柄抛球（比赛里轮到玩家发球时由游戏打开） */
  tossEnabled = false;
  private activeKey: string | null = null;
  private hidKeys = new WeakMap<HIDDevice, string>();
  private hidCounter = 0;

  constructor() {
    const h = loadJson<number>(HANDED_KEY);
    if (h === -1) this.handed = -1;
  }

  get active(): InputDevice | null {
    return (this.activeKey && this.devices.get(this.activeKey)) || null;
  }

  get webHidSupported(): boolean {
    return isWebHidSupported();
  }

  setHanded(h: 1 | -1): void {
    this.handed = h;
    for (const d of this.devices.values()) d.paddle.handed = h;
    saveJson(HANDED_KEY, h);
  }

  async start(): Promise<void> {
    // 手机：本地开发服务器用中转，线上（或 ?link=rtc）用 WebRTC 直连
    const lan = await devLanInfo();
    const useRtc = new URLSearchParams(location.search).get('link') === 'rtc' || !lan;
    this.room = useRtc ? roomCode() : null;
    this.linkKind = useRtc ? 'rtc' : 'relay';
    this.hub = new PhoneHub(useRtc ? new RtcGameLink(this.room!) : new RelayGameLink());
    this.hub.onPhoneAdded = (p) => this.attachPhone(p);
    this.hub.onPhoneRemoved = (p) => this.detach(`phone-${p.id}`);
    this.hub.onStatus = (text, ok) => this.events.onLinkStatus?.(text, ok);
    this.hub.connect();
    this.phoneUrl = phonePageUrl(lan, this.room);

    if (isWebHidSupported()) {
      onJoyConConnect((d) => void this.attachJoyCon(d));
      onJoyConDisconnect((d) => {
        const key = this.hidKeys.get(d);
        if (key) {
          this.devices.get(key)?.joycon?.markDisconnected();
          this.detach(key);
        }
      });
      for (const d of await getGrantedJoyCons()) void this.attachJoyCon(d);
    }
  }

  /** 需要在点击事件里调用（浏览器要求用户手势） */
  async requestJoyCon(): Promise<void> {
    const ds = await requestJoyCons();
    for (const d of ds) void this.attachJoyCon(d);
  }

  rumble(event: HapticEvent): void {
    const d = this.active;
    if (!d) return;
    if (d.joycon) d.joycon.rumble(HAPTICS[event]);
    else if (d.phone) d.phone.rumble(HAPTICS[event]);
  }

  /** 当前设备最近是否有数据 */
  get streaming(): boolean {
    const d = this.active;
    return !!d && performance.now() - d.lastSampleAt < 800;
  }

  /** 回中：拍头（Joy-Con 肩键一端 / 手机顶端）像遥控器一样指向电视 */
  recenter(): boolean {
    const d = this.active;
    return !!d && d.paddle.setHeading();
  }

  /**
   * 校准 / 回中（开局，或打球中方向偏了）：拍头像遥控器一样指向电视，立即定方向，结果由 onCalibrate 给出。
   * 陀螺仪零点不在这里测：Joy-Con 放在桌上不动 2 秒会在后台自动重测（见 FlatStillCalibrator）
   */
  requestCalibration(d: InputDevice | null = this.active): void {
    if (!d) return;
    this.events.onCalibrate?.(d, d.paddle.setHeading() ? 'done' : 'notPointing');
  }

  // ---------------------------------------------------------------- 设备

  private newDevice(key: string, kind: DeviceKind, name: string): InputDevice {
    const paddle = new PaddleModel();
    paddle.handed = this.handed;
    const d: InputDevice = {
      key,
      kind,
      name,
      // Joy-Con 的陀螺仪零点只在平放不动时学（见 FlatStillCalibrator）；手机的读数系统已经去过零偏
      motion: new MotionState(kind === 'joycon' ? 'flat' : 'auto'),
      paddle,
      detector: new SwingDetector(kind === 'phone' ? SWING_PROFILES.phone : SWING_PROFILES.joycon),
      toss: new TossDetector(),
      samples: 0,
      lastSampleAt: -Infinity,
      lastActivityAt: -Infinity,
      biasSeenAt: -Infinity,
    };
    this.devices.set(key, d);
    if (!this.activeKey) this.activeKey = key;
    this.events.onDevicesChanged?.();
    return d;
  }

  private detach(key: string): void {
    if (!this.devices.delete(key)) return;
    if (this.activeKey === key) {
      this.activeKey = null;
      for (const k of this.devices.keys()) {
        this.activeKey = k;
        break;
      }
    }
    this.events.onDevicesChanged?.();
  }

  private async attachJoyCon(hid: HIDDevice): Promise<void> {
    const known = this.hidKeys.get(hid);
    if (known && this.devices.has(known)) return;
    const key = `hid-${this.hidCounter++}`;
    this.hidKeys.set(hid, key);
    const driver = new JoyConDriver(hid);
    const d = this.newDevice(key, 'joycon', driver.name);
    d.joycon = driver;
    driver.events = {
      onSamples: (s) => this.onSamples(d, s),
      onRawReport: (id, data, arrival) => this.events.onRawReport?.(d, id, data, arrival),
      onButtons: (b, prev) => {
        for (const name of ['confirm', 'back', 'recenter', 'pause'] as LogicalButton[]) {
          const now = isLogicalDown(driver.side, b, name);
          const was = isLogicalDown(driver.side, prev, name);
          if (now !== was) this.onButton(d, name, now);
        }
        if (calibrateCombo(driver.side, b) && !calibrateCombo(driver.side, prev)) {
          this.makeActive(d);
          this.requestCalibration(d);
        }
      },
    };
    try {
      await driver.start();
    } catch {
      this.detach(key);
    }
  }

  private attachPhone(p: PhoneDevice): void {
    const key = `phone-${p.id}`;
    if (this.devices.has(key)) return;
    const d = this.newDevice(key, 'phone', `${p.platformText} · ${p.name}`);
    d.phone = p;
    p.events = {
      onSamples: (s) => this.onSamples(d, s),
      onButton: (name, down) => this.onButton(d, name, down),
      onMeta: () => {
        d.name = `${p.platformText} · ${p.name}`;
        this.events.onDevicesChanged?.();
      },
    };
  }

  private onButton(d: InputDevice, name: LogicalButton, down: boolean): void {
    if (down) this.makeActive(d);
    if (d !== this.active) return;
    this.events.onButton?.(name, down, d);
  }

  private makeActive(d: InputDevice): void {
    d.lastActivityAt = performance.now();
    if (this.activeKey !== d.key) {
      this.activeKey = d.key;
      this.events.onDevicesChanged?.();
    }
  }

  private onSamples(d: InputDevice, samples: ImuSample[]): void {
    for (const s of samples) {
      if (d.kind === 'phone') this.events.onRawSample?.(d, s);
      const f = d.motion.process(s);
      d.paddle.update(f);
      // 重新测过陀螺仪零点：之前估计的偏航漂移速度作废
      if (d.motion.biasLearnedAt !== d.biasSeenAt) {
        d.biasSeenAt = d.motion.biasLearnedAt;
        d.paddle.drift = 0;
      }
      d.paddle.trackHeading(f.gyro, f.dt, this.autoHeading && d === this.active);
      d.samples++;
      d.lastSampleAt = performance.now();
      const toss = d.toss.process(f);
      if (toss && this.tossEnabled && d === this.active) this.events.onToss?.(d, toss);
      const evs = d.detector.process(f);
      if (!evs.length) continue;
      // 有明显挥拍的设备成为当前设备
      if (evs.some((e) => e.type === 'commit' && e.path === 'fast')) this.makeActive(d);
      if (d !== this.active) continue;
      for (const e of evs) {
        if (e.type === 'commit') {
          const dir = (e.dir * this.handed) as 1 | -1 | 0;
          const hint = d.paddle.stanceHint();
          const stroke: Stroke =
            dir !== 0 && e.yawFrac >= 0.3 ? (dir > 0 ? 'fh' : 'bh') : (hint ?? 'fh');
          this.lastStroke.set(e.id, stroke);
          this.lastCommitAt.set(e.id, e.at);
          this.events.onSwing?.({
            device: d,
            commit: e,
            dir,
            stroke,
            features: d.paddle.features(e.at, e.path === 'gentle' ? e.at : null, stroke),
          });
        } else {
          const stroke = this.lastStroke.get(e.id) ?? 'fh';
          const onset = this.lastCommitAt.get(e.id) ?? e.at;
          const neutralPitch = d.paddle.neutralPitch(stroke);
          this.events.onPeak?.({
            device: d,
            peak: e,
            features: d.paddle.features(onset, e.at, stroke),
            neutralPitch,
          });
          if (d.paddle.calibrated)
            d.paddle.recordContact(stroke, d.paddle.facePitch(e.at.q, stroke));
        }
      }
    }
  }

  private lastStroke = new Map<number, Stroke>();
  private lastCommitAt = new Map<number, SwingCommit['at']>();
}
