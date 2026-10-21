/**
 * 发球机练习录制（暂停菜单里的「录制这局」）。
 *
 * 文件 = 调试页同样的 IMU 录制（Joy-Con 原始报告 / 手机样本，可以直接用 analyze:imu、eval:swing 分析）
 * + practice 字段：每一球的判定细节，用来离线复盘「卡片为什么说早 / 晚」「拍子角度为什么不对」。
 *
 * 时间：rt = performance.now()（毫秒，和 IMU 报告到达时间、样本时间同一基准）；st = 仿真时间（秒）。
 * clock 事件给出两者的对应关系（暂停时仿真时间不走，所以要分段对应）。
 */
import type { InputDevice } from '@/app/input/MotionInput';
import type { Quat } from '@/core/quat';
import type { Vec3 } from '@/core/vec3';
import { DEFAULT_CALIBRATION } from '@/input/joycon/calibration';
import type { SwingCommit } from '@/input/paddle/SwingDetector';
import { ImuRecorder, type ImuRecording } from '@/input/replay/recording';
import type { SwingFeatures, SwingInput, SwingOutcome } from '@/sim/hit/HitResolver';
import type { FeederEvent } from '@/sim/practice/FeederSim';

/** 到这么多球或这么长时间就自动停止并下载 */
export const RECORD_MAX_BALLS = 30;
export const RECORD_MAX_MS = 5 * 60 * 1000;

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

export interface PracticeSettingsLog {
  level: number;
  zone: string;
  leniency: number;
  latencyMs: number;
  windowMs: number;
  handed: 1 | -1;
  tauMin: number;
  tauMax: number;
  holdEarly: number;
}

export type PracticeLogEvent =
  /** 仿真时间 st 对应真实时刻 rt */
  | { k: 'clock'; rt: number; st: number }
  /** 球拍校准（回中的偏航、准备姿势记下的握法） */
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
  | { k: 'peak'; rt: number; id: number; t: number; w: number; features: SwingFeatures }
  /** 仿真事件原样（送球、落台、击球、挥空、未落台、结果…） */
  | { k: 'sim'; rt: number; st: number; e: FeederEvent }
  /** 设备姿态（机体 → 融合世界系）与画面里的拍子朝向，约 10 次/秒 */
  | { k: 'pose'; rt: number; q: Q4; face: V3 | null; blade: V3 | null };

export interface PracticeLog {
  version: 1;
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
  /** 录制开始后出了几球结果 */
  results = 0;

  constructor(
    readonly device: InputDevice | null,
    settings: PracticeSettingsLog
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
  }

  finish(): PracticeRecording {
    return { ...this.imu.finish('发球机练习录制'), practice: this.log };
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
