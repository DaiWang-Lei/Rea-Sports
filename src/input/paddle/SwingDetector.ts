/**
 * 挥拍识别（纯逻辑，可用录制数据回放测试）。
 *
 * 一次「动作」由若干「阶段」组成：阶段 = 绕竖直轴转向一致的一段（逆时针 / 顺时针）。
 * 实测（fixtures/imu 里 Joy-Con 与 iPhone 的正手录制）：
 *  - 前向挥拍之前常有反方向的引拍，引拍角速度最高约 10 rad/s；前向挥拍峰值 15–25 rad/s；
 *  - 前向挥拍越过 11 rad/s 到峰值：Joy-Con 平均 76ms（标准差 8ms），iPhone 平均 62ms（标准差 17ms）；
 *  - 挥完后约 0.3–0.6 秒会有一个反方向、速度约一半的收拍动作（像反手），由上层按「每个来球只算一次」过滤。
 *
 * 输出事件：
 *  - commit：确认一次挥拍（fast：前向挥拍越过阈值时立即确认，带预测的接触时刻；
 *            gentle：较慢的挥拍在峰值确认后才给出，接触时刻即峰值时刻）；
 *  - peak：已确认的挥拍到达峰值（细化速度、拍面角度）。
 * 方向 dir：+1 = 俯视逆时针（右手正手），−1 = 顺时针（右手反手）。左手由上层镜像。
 */
import { type Quat, quat } from '@/core/quat';
import { type Vec3, vec3 } from '@/core/vec3';

export interface SwingFrame {
  /** 样本时刻（毫秒） */
  t: number;
  /** 角速度，世界系（Z 向上），弧度/秒 */
  omegaWorld: Vec3;
  /** 姿态：机体 → 世界 */
  q: Quat;
}

export interface SwingProfile {
  /** 前向挥拍立即确认的阈值（rad/s） */
  fastThreshold: number;
  /** 慢挥拍至少要达到的峰值（rad/s） */
  gentleMin: number;
  /** 动作开始 / 结束的阈值（rad/s） */
  startThreshold: number;
  endThreshold: number;
  /** 低于结束阈值持续多久算动作结束（毫秒） */
  endHoldMs: number;
  /** 快速确认时刻 → 峰值（接触）的平均提前量（毫秒） */
  leadMs: number;
  /** 判定转向所需的最小竖直轴角速度（rad/s） */
  yawMin: number;
  /** 判定转向还要求竖直轴分量至少占总角速度的这个比例（上下挥的扣杀、搓球不会来回翻转方向） */
  yawFracMin: number;
  /** 动作最长时长（毫秒），超过强制结束 */
  maxMotionMs: number;
}

export const SWING_PROFILES = {
  joycon: {
    fastThreshold: 11,
    gentleMin: 6,
    startThreshold: 2,
    endThreshold: 2.5,
    endHoldMs: 15,
    leadMs: 76,
    yawMin: 1.5,
    yawFracMin: 0.3,
    maxMotionMs: 1500,
  },
  phone: {
    fastThreshold: 11,
    gentleMin: 6,
    startThreshold: 2,
    endThreshold: 2.5,
    endHoldMs: 30,
    leadMs: 62,
    yawMin: 1.5,
    yawFracMin: 0.3,
    maxMotionMs: 1500,
  },
} satisfies Record<string, SwingProfile>;

export interface SwingSnapshot {
  t: number;
  w: number;
  omegaWorld: Vec3;
  q: Quat;
}

export interface SwingCommit {
  type: 'commit';
  /** 挥拍编号（每次确认 +1） */
  id: number;
  /** 所属动作编号：同一动作里后来的、更快的反向挥拍可以取代先前的（引拍被误当挥拍时） */
  motion: number;
  path: 'fast' | 'gentle';
  /** 确认时刻（样本时间，毫秒） */
  t: number;
  /** 预测的接触时刻（毫秒） */
  tContact: number;
  /** +1 逆时针、−1 顺时针、0 方向不明（主要是上下挥） */
  dir: 1 | -1 | 0;
  /** 确认时的角速度大小 */
  w: number;
  /** 预测的峰值角速度（gentle 时为实际峰值） */
  wPeak: number;
  /** 绕竖直轴的分量占比（0..1），小 = 主要是上下挥（扣杀、搓球） */
  yawFrac: number;
  at: SwingSnapshot;
}

export interface SwingPeak {
  type: 'peak';
  id: number;
  motion: number;
  t: number;
  w: number;
  at: SwingSnapshot;
}

export type SwingEvent = SwingCommit | SwingPeak;

interface Phase {
  dir: 1 | -1 | 0;
  peak: number;
  peakAt: SwingSnapshot | null;
  /** 本阶段已确认的挥拍编号（0 = 未确认） */
  committedId: number;
  peakSent: boolean;
  /** 峰值之后连续下降的样本数 */
  falling: number;
}

function snap(f: SwingFrame, w: number): SwingSnapshot {
  return {
    t: f.t,
    w,
    omegaWorld: vec3(f.omegaWorld.x, f.omegaWorld.y, f.omegaWorld.z),
    q: quat(f.q.w, f.q.x, f.q.y, f.q.z),
  };
}

export class SwingDetector {
  private inMotion = false;
  private motion = 0;
  private motionStart = 0;
  private belowSince = NaN;
  private phase: Phase = SwingDetector.newPhase(0);
  private lastW = 0;
  private lastT = NaN;
  private nextId = 1;
  /** 最近一次确认挥拍的编号（供上层查询是否在挥拍中） */
  lastCommit: SwingCommit | null = null;

  constructor(public profile: SwingProfile = SWING_PROFILES.joycon) {}

  private static newPhase(dir: 1 | -1 | 0): Phase {
    return { dir, peak: 0, peakAt: null, committedId: 0, peakSent: false, falling: 0 };
  }

  reset(): void {
    this.inMotion = false;
    this.belowSince = NaN;
    this.phase = SwingDetector.newPhase(0);
    this.lastW = 0;
    this.lastT = NaN;
    this.lastCommit = null;
  }

  /** 是否正在一个动作中 */
  get moving(): boolean {
    return this.inMotion;
  }

  /** 处理一个样本，返回产生的事件（通常为空） */
  process(f: SwingFrame): SwingEvent[] {
    const p = this.profile;
    const out: SwingEvent[] = [];
    const ow = f.omegaWorld;
    const w = Math.hypot(ow.x, ow.y, ow.z);
    const dtMs = Number.isNaN(this.lastT) ? 5 : f.t - this.lastT;
    const slope = dtMs > 0 ? ((w - this.lastW) / dtMs) * 1000 : 0;

    if (!this.inMotion) {
      if (w >= p.startThreshold) {
        this.inMotion = true;
        this.motion++;
        this.motionStart = f.t;
        this.belowSince = NaN;
        this.phase = SwingDetector.newPhase(0);
      } else {
        this.lastW = w;
        this.lastT = f.t;
        return out;
      }
    }

    // 转向：竖直轴角速度足够大、且占比足够时才算明确的方向
    const yawDir: 1 | -1 | 0 =
      Math.abs(ow.z) >= Math.max(p.yawMin, p.yawFracMin * w) ? (ow.z > 0 ? 1 : -1) : 0;
    let ph = this.phase;
    if (yawDir !== 0 && ph.dir !== yawDir) {
      // 进入新阶段（换向）：上一阶段若是慢挥拍且已到峰，补发确认
      this.finishPhase(ph, out);
      ph = this.phase = SwingDetector.newPhase(yawDir);
    }

    // 峰值跟踪
    if (w > ph.peak) {
      ph.peak = w;
      ph.peakAt = snap(f, w);
      ph.falling = 0;
    } else if (w < this.lastW) {
      ph.falling++;
    }

    // 快速确认：越过阈值即确认。方向不明（上下挥）时 dir = 0，由上层按站位决定正反手
    if (!ph.committedId && w >= p.fastThreshold) {
      const est = Math.min(
        Math.max(w + Math.max(0, slope) * (p.leadMs / 1000) * 0.6, w * 1.3),
        w * 2.3
      );
      const c: SwingCommit = {
        type: 'commit',
        id: this.nextId++,
        motion: this.motion,
        path: 'fast',
        t: f.t,
        tContact: f.t + p.leadMs,
        dir: ph.dir,
        w,
        wPeak: est,
        yawFrac: Math.abs(ow.z) / Math.max(w, 1e-6),
        at: snap(f, w),
      };
      ph.committedId = c.id;
      this.lastCommit = c;
      out.push(c);
    }

    // 已确认挥拍的峰值：跌到峰值的 85% 以下，或连续两个样本下降
    if (ph.committedId && !ph.peakSent && ph.peakAt && (w < 0.85 * ph.peak || ph.falling >= 2)) {
      ph.peakSent = true;
      out.push({
        type: 'peak',
        id: ph.committedId,
        motion: this.motion,
        t: ph.peakAt.t,
        w: ph.peak,
        at: ph.peakAt,
      });
    }

    // 慢挥拍：阶段峰值在 [gentleMin, fastThreshold) 且已明显回落
    if (!ph.committedId && ph.dir !== 0 && ph.peak >= p.gentleMin && w < 0.8 * ph.peak) {
      this.commitGentle(ph, out);
    }

    // 动作结束
    if (w < p.endThreshold) {
      if (Number.isNaN(this.belowSince)) this.belowSince = f.t;
    } else {
      this.belowSince = NaN;
    }
    if (
      (!Number.isNaN(this.belowSince) && f.t - this.belowSince >= p.endHoldMs) ||
      f.t - this.motionStart > p.maxMotionMs
    ) {
      this.finishPhase(ph, out);
      this.inMotion = false;
      this.phase = SwingDetector.newPhase(0);
    }

    this.lastW = w;
    this.lastT = f.t;
    return out;
  }

  private commitGentle(ph: Phase, out: SwingEvent[]): void {
    if (!ph.peakAt || ph.dir === 0) return;
    const at = ph.peakAt;
    const c: SwingCommit = {
      type: 'commit',
      id: this.nextId++,
      motion: this.motion,
      path: 'gentle',
      t: at.t,
      tContact: at.t,
      dir: ph.dir,
      w: at.w,
      wPeak: at.w,
      yawFrac: Math.abs(at.omegaWorld.z) / Math.max(at.w, 1e-6),
      at,
    };
    ph.committedId = c.id;
    ph.peakSent = true;
    this.lastCommit = c;
    out.push(c);
    out.push({ type: 'peak', id: c.id, motion: this.motion, t: at.t, w: at.w, at });
  }

  /** 阶段结束时：慢挥拍补确认；已确认但峰值没发出的补发 */
  private finishPhase(ph: Phase, out: SwingEvent[]): void {
    if (!ph.committedId && ph.dir !== 0 && ph.peak >= this.profile.gentleMin) {
      this.commitGentle(ph, out);
    } else if (ph.committedId && !ph.peakSent && ph.peakAt) {
      ph.peakSent = true;
      out.push({
        type: 'peak',
        id: ph.committedId,
        motion: this.motion,
        t: ph.peakAt.t,
        w: ph.peak,
        at: ph.peakAt,
      });
    }
  }
}
