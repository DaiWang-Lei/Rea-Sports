/**
 * 发球机练习、比赛的录制（暂停菜单里的「录制这局」）。
 *
 * 文件 = 调试页同样的 IMU 录制（Joy-Con 原始报告 / 手机样本，可以直接用 analyze:imu、eval:swing 分析）
 * + practice 字段：每一球的判定细节，用来离线复盘「卡片为什么说早 / 晚」「拍子角度为什么不对」。
 * 比赛的录制 mode = 'match'：仿真事件是比赛事件（k: 'match'），另有抛球事件（k: 'toss'）。
 *
 * 时间：rt = performance.now()（毫秒，和 IMU 报告到达时间、样本时间同一基准）；st = 仿真时间（秒）。
 * clock 事件给出两者的对应关系（暂停时仿真时间不走，所以要分段对应）。
 */
import type { InputDevice } from '@/app/input/MotionInput';
import type { Quat } from '@/core/quat';
import type { Vec3 } from '@/core/vec3';
import { DEFAULT_CALIBRATION } from '@/input/joycon/calibration';
import type { PaddleModel } from '@/input/paddle/PaddleModel';
import type { SwingCommit } from '@/input/paddle/SwingDetector';
import { ImuRecorder, type ImuRecording } from '@/input/replay/recording';
import type { SwingFeatures, SwingInput, SwingOutcome } from '@/sim/hit/HitResolver';
import type { MatchEvent } from '@/sim/MatchSim';
import type { PlayerSim } from '@/sim/players/PlayerSim';
import type { FeederEvent } from '@/sim/practice/FeederSim';

/** 到这么多球或这么长时间就自动停止并下载 */
export const RECORD_MAX_BALLS = 30;
export const RECORD_MAX_MS = 5 * 60 * 1000;

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

export interface PracticeSettingsLog {
  /** 练习：发球机难度；比赛：电脑等级 */
  level: number;
  /** 练习：落点区域；比赛：'match' */
  zone: string;
  /** 比赛：6 / 11 分制 */
  points?: number;
  leniency: number;
  latencyMs: number;
  /** 画面延迟补偿按屏幕记，这是当时的屏幕（分辨率） */
  screen?: string;
  windowMs: number;
  handed: 1 | -1;
  tauMin: number;
  tauMax: number;
  holdEarly: number;
}

export type PracticeLogEvent =
  /** 仿真时间 st 对应真实时刻 rt */
  | { k: 'clock'; rt: number; st: number }
  /**
   * 球拍校准：校准 / 回中定下的偏航（2026-10-26 起由拍头指向电视定，以前由准备姿势的红面定）；
   * 握法（2026-10-23 起固定为 DEVICE_GRIP，以前在准备姿势时测出）
   */
  | { k: 'calib'; rt: number; hasHeading: boolean; yaw: number; grip: Q4 | null; handed: 1 | -1 }
  | { k: 'button'; rt: number; name: string }
  /** 中途改了设置（练习重新开始，仿真时间从 0 重新算） */
  | { k: 'settings'; rt: number; settings: PracticeSettingsLog }
  | { k: 'pause'; rt: number; paused: boolean }
  /** 来球的理想击球点（送球时，以及擦网等重新规划后） */
  | { k: 'plan'; rt: number; st: number; t: number; bounceT: number; p: V3; v: V3; popup: boolean }
  /** 一次挥拍：识别结果、换算成仿真时间的输入、判定结果，以及当时的站位和拍子朝向 */
  | {
      k: 'swing';
      rt: number;
      st: number;
      commit: {
        id: number;
        motion: number;
        path: string;
        /** 确认时刻 / 预测接触时刻（样本时间，毫秒） */
        t: number;
        tContact: number;
        dir: number;
        w: number;
        wPeak: number;
        yawFrac: number;
      } | null;
      input: SwingInput;
      outcome: SwingOutcome;
      stance: string;
      stanceHint: string | null;
      body: [number, number];
      /** 红面法向 / 拍头方向（游戏坐标），未校准时为 null */
      face: V3 | null;
      blade: V3 | null;
    }
  /** 挥拍峰值：拍面特征（facePitch 已减去 neutral = 你平时的拍面角度，弧度） */
  | {
      k: 'peak';
      rt: number;
      id: number;
      t: number;
      w: number;
      features: SwingFeatures;
      neutral?: number;
    }
  /** 陀螺仪零点（°/s）：录制开始时的值，以及之后每次重新测（平放）到的值 */
  | { k: 'gyroBias'; rt: number; bias: V3; mode: string; learnedAt: number | null }
  /** 仿真事件原样（送球、落台、击球、挥空、未落台、结果…） */
  | { k: 'sim'; rt: number; st: number; e: FeederEvent }
  /** 比赛的仿真事件原样（抛球、击球、落台、得分…） */
  | { k: 'match'; rt: number; st: number; e: MatchEvent }
  /**
   * 抛球输入：按键，或识别到向上抖手柄（peakG 竖直比力峰值、durationMs 向上加速持续时间、maxOmega 期间最大角速度）；
   * ok = 真的抛出去了（不是自己发球、或还没到能抛的时候就是 false）；ideal = 理想发球时刻（仿真时间，秒）
   */
  | {
      k: 'toss';
      rt: number;
      st: number;
      source: 'button' | 'flick' | 'key';
      height: number;
      ok: boolean;
      ideal?: number;
      peakG?: number;
      durationMs?: number;
      maxOmega?: number;
    }
  /**
   * 设备姿态（机体 → 融合世界系）与画面里的拍子朝向，约 10 次/秒。
   * yaw：融合系 → 游戏系的偏航（弧度，含自动校正）；drift：估计的偏航漂移速度（弧度/秒）。2026-10-23 起才有。
   * ready：学到的平时准备姿势里拍面的角度（弧度，红面朝前 / 背面朝前；null = 还没学到）。2026-10-26 起才有
   */
  | {
      k: 'pose';
      rt: number;
      q: Q4;
      face: V3 | null;
      blade: V3 | null;
      yaw?: number;
      drift?: number;
      ready?: [number | null, number | null];
    };

export interface PracticeLog {
  version: 1;
  /** 以前的录制没有这个字段 = 练习 */
  mode?: 'practice' | 'match';
  deviceKind: 'joycon' | 'phone' | 'keyboard';
  deviceName: string;
  settings: PracticeSettingsLog;
  events: PracticeLogEvent[];
}

export interface PracticeRecording extends ImuRecording {
  practice: PracticeLog;
}

export function commitLog(c: SwingCommit): Extract<PracticeLogEvent, { k: 'swing' }>['commit'] {
  return {
    id: c.id,
    motion: c.motion,
    path: c.path,
    t: c.t,
    tContact: c.tContact,
    dir: c.dir,
    w: c.w,
    wPeak: c.wPeak,
    yawFrac: c.yawFrac,
  };
}

export function isPracticeRecording(x: unknown): x is PracticeRecording {
  const r = x as PracticeRecording;
  return !!r && r.format === 'rea-sports-imu' && !!r.practice && Array.isArray(r.practice.events);
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
export const v3 = (v: Vec3): V3 => [r4(v.x), r4(v.y), r4(v.z)];
export const q4 = (q: Quat): Q4 => [r4(q.w), r4(q.x), r4(q.y), r4(q.z)];

export class PracticeRecorder {
  readonly imu: ImuRecorder;
  readonly log: PracticeLog;
  readonly startedAt = performance.now();
  /** 录制开始后出了几球结果（比赛：打了几分） */
  results = 0;

  constructor(
    readonly device: InputDevice | null,
    settings: PracticeSettingsLog,
    readonly mode: 'practice' | 'match' = 'practice'
  ) {
    if (device?.kind === 'joycon' && device.joycon) {
      const j = device.joycon;
      this.imu = new ImuRecorder(j.side, j.stream.calibration, 'joycon', j.name);
    } else {
      const ua = device?.phone?.meta?.ua ?? '';
      this.imu = new ImuRecorder(
        'R',
        DEFAULT_CALIBRATION,
        'phone',
        device ? `${device.name}${ua ? ` · ${ua}` : ''}` : '键盘'
      );
    }
    this.log = {
      version: 1,
      mode,
      deviceKind: device?.kind ?? 'keyboard',
      deviceName: device?.name ?? '键盘',
      settings,
      events: [],
    };
  }

  get elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  push(e: PracticeLogEvent): void {
    this.log.events.push(e);
    if (e.k === 'sim' && e.e.type === 'feed') this.imu.mark(e.rt, 'feed');
    if (e.k === 'sim' && e.e.type === 'result') this.results++;
    if (e.k === 'match' && e.e.type === 'point') this.results++;
  }

  finish(): PracticeRecording {
    const title = this.mode === 'match' ? '比赛录制' : '发球机练习录制';
    return { ...this.imu.finish(title), practice: this.log };
  }
}

/** 球拍校准（准备姿势 / 回中）的记录 */
export function calibLog(d: InputDevice, rt: number): PracticeLogEvent {
  return {
    k: 'calib',
    rt,
    hasHeading: d.paddle.hasHeading,
    yaw: d.paddle.yaw,
    grip: q4(d.paddle.grip),
    handed: d.paddle.handed,
  };
}

/** 一次挥拍的记录：识别结果、换算后的输入、判定结果，以及当时的站位和拍子朝向（paddle = null：键盘） */
export function swingLog(
  rt: number,
  st: number,
  input: SwingInput,
  outcome: SwingOutcome,
  commit: SwingCommit | null,
  p: PlayerSim,
  paddle: PaddleModel | null
): PracticeLogEvent {
  const face = paddle?.faceNormal() ?? null;
  const blade = paddle?.bladeUp() ?? null;
  return {
    k: 'swing',
    rt,
    st,
    commit: commit ? commitLog(commit) : null,
    input,
    outcome,
    stance: p.stance,
    stanceHint: paddle?.stanceHint() ?? null,
    body: [p.mover.x, p.mover.y],
    face: face ? v3(face) : null,
    blade: blade ? v3(blade) : null,
  };
}

/** 录制时每帧记的公共部分：时钟对应（1 次/秒）、陀螺仪零点的变化、设备姿态与画面里的拍子朝向（约 10 次/秒） */
export class RecordTicker {
  private lastClock = 0;
  private lastPose = 0;
  private lastBias = NaN;

  tick(rec: PracticeRecorder, now: number, clockReal: number, clockSim: number): void {
    if (now - this.lastClock >= 1000) {
      this.lastClock = now;
      rec.push({ k: 'clock', rt: clockReal, st: clockSim });
    }
    const d = rec.device;
    if (!d) return;
    if (d.motion.biasLearnedAt !== this.lastBias) {
      this.lastBias = d.motion.biasLearnedAt;
      const at = d.motion.biasLearnedAt;
      rec.push({
        k: 'gyroBias',
        rt: now,
        bias: v3(d.motion.gyroBias),
        mode: d.motion.biasMode,
        learnedAt: Number.isFinite(at) ? at : null,
      });
    }
    if (now - this.lastPose >= 100) {
      this.lastPose = now;
      const f = d.paddle.faceNormal();
      const b = d.paddle.bladeUp();
      rec.push({
        k: 'pose',
        rt: now,
        q: q4(d.paddle.q),
        face: f ? v3(f) : null,
        blade: b ? v3(b) : null,
        yaw: d.paddle.yaw,
        drift: d.paddle.drift,
        ready: [d.paddle.ready.front, d.paddle.ready.back].map((v) =>
          Number.isNaN(v) ? null : v
        ) as [number | null, number | null],
      });
    }
  }
}

/** 把 JSON 存成文件（浏览器下载） */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
