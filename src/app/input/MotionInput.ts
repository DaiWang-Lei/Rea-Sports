/**
 * 游戏页的体感输入：管理 Joy-Con（WebHID）和手机（WebRTC / 本地中转），
 * 每个设备一条处理链：姿态融合 → 球拍模型 → 挥拍识别；当前设备的挥拍与按键交给游戏。
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
import { PaddleModel, type PaddleCalibrationData } from '@/input/paddle/PaddleModel';
import {
  SWING_PROFILES,
  type SwingCommit,
  SwingDetector,
  type SwingPeak,
} from '@/input/paddle/SwingDetector';
import {
  devLanInfo,
  type PhoneDevice,
  PhoneHub,
  phonePageUrl,
  RelayGameLink,
  RtcGameLink,
} from '@/input/phone/PhoneHub';
import { isLogicalDown, type ImuSample, type LogicalButton } from '@/input/types';
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
  samples: number;
  lastSampleAt: number;
  lastActivityAt: number;
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
}

export interface MotionInputEvents {
  onSwing?: (e: SwingEventOut) => void;
  onPeak?: (e: PeakEventOut) => void;
  onButton?: (b: LogicalButton, down: boolean, device: InputDevice) => void;
  onDevicesChanged?: () => void;
  onLinkStatus?: (text: string, ok: boolean) => void;
}

/**
 * 握法的存储键。手机的握法在 2026-10-21 之前是按接错的陀螺轴算出来的（见 phoneToBody），
 * 换个键名让旧数据失效，回到需要重新做「准备姿势」
 */
const GRIP_KEYS: Record<DeviceKind, string> = {
  joycon: 'rea-grip-joycon',
  phone: 'rea-grip-phone-xyz',
};
const HANDED_KEY = 'rea-handed';

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

  /** 回中（设备顶端指向电视） */
  recenter(): boolean {
    const d = this.active;
    return !!d && d.paddle.setHeading();
  }

  /** 准备姿势：记下握法并保存 */
  captureReady(): boolean {
    const d = this.active;
    if (!d || !d.paddle.setReady()) return false;
    const data = d.paddle.saveGrip();
    if (data) saveJson(GRIP_KEYS[d.kind], data);
    return true;
  }

  // ---------------------------------------------------------------- 设备

  private newDevice(key: string, kind: DeviceKind, name: string): InputDevice {
    const paddle = new PaddleModel();
    paddle.handed = this.handed;
    paddle.loadGrip(loadJson<PaddleCalibrationData>(GRIP_KEYS[kind]));
    const d: InputDevice = {
      key,
      kind,
      name,
      motion: new MotionState(),
      paddle,
      detector: new SwingDetector(kind === 'phone' ? SWING_PROFILES.phone : SWING_PROFILES.joycon),
      samples: 0,
      lastSampleAt: -Infinity,
      lastActivityAt: -Infinity,
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
      onButtons: (b, prev) => {
        for (const name of ['confirm', 'back', 'recenter', 'pause'] as LogicalButton[]) {
          const now = isLogicalDown(driver.side, b, name);
          const was = isLogicalDown(driver.side, prev, name);
          if (now !== was) this.onButton(d, name, now);
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
      const f = d.motion.process(s);
      d.paddle.update(f);
      d.samples++;
      d.lastSampleAt = performance.now();
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
          this.events.onPeak?.({
            device: d,
            peak: e,
            features: d.paddle.features(onset, e.at, stroke),
          });
        }
      }
    }
  }

  private lastStroke = new Map<number, Stroke>();
  private lastCommitAt = new Map<number, SwingCommit['at']>();
}
