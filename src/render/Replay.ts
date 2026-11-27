/**
 * 得分回放（像 WSR 精彩的分打完后慢放一遍）：比赛时把每一帧画面上的球和两个人的姿势记下来（最近几秒），
 * 一分打完后截取这一分的最后几拍，慢放。只记画面上的东西，回放时不碰仿真。
 */
import type { Vec3 } from '@/core/vec3';
import type { Side } from '@/sim/constants';
import type { MatchEvent } from '@/sim/MatchSim';
import type { PointReason } from '@/sim/rally/Referee';
import type { AvatarPose } from './avatar/types';
import type { BallSpin, TrailStyle } from './BallView';

/** 画面上的一帧（t = 画面上的仿真时刻） */
export interface ReplayFrame {
  t: number;
  ball: Vec3;
  ballVisible: boolean;
  trail: TrailStyle;
  spin: BallSpin;
  poses: Partial<Record<Side, AvatarPose>>;
}

/** 回放里要重放的事件（击球、落台……：特效和声音） */
export type ReplayEvent = Extract<
  MatchEvent,
  { type: 'hit' | 'bounce' | 'net' | 'floor' | 'sideHit' | 'bodyHit' }
>;

export const REPLAY = {
  /** 记最近多少秒 */
  keep: 8,
  /** 慢放倍率 */
  speed: 0.6,
  /** 回放从这一分倒数第几拍前一点开始、最多往前多少秒 */
  lastHits: 3,
  lead: 0.3,
  maxLen: 3.5,
  /** 得分之后再放多久（球落地、人的反应开头） */
  tail: 0.6,
  /** 得分后先让欢呼演多久（秒，仿真时间）再开始回放 */
  delay: 1.2,
};

/** 这一分精彩吗：长回合、扣杀得分、球打到人、局点、整局最后一分 */
export function isHighlight(p: {
  rallyHits: number;
  reason: PointReason;
  /** 最后一拍是扣杀、并且是扣杀的一方得分 */
  smashWinner: boolean;
  /** 这一分开打前有人到了局点 */
  gamePoint: boolean;
  gameOver: boolean;
}): boolean {
  return (
    p.rallyHits >= 8 ||
    p.smashWinner ||
    p.reason === 'face' ||
    p.reason === 'body' ||
    p.gamePoint ||
    p.gameOver
  );
}

/** 最近几秒的画面和事件 */
export class ReplayRecorder {
  readonly frames: ReplayFrame[] = [];
  readonly events: ReplayEvent[] = [];

  push(f: ReplayFrame): void {
    // 时间往回走（新开一局）：之前的作废
    const last = this.frames[this.frames.length - 1];
    if (last && f.t < last.t) this.clear();
    this.frames.push(f);
    const cut = f.t - REPLAY.keep;
    while (this.frames.length && this.frames[0].t < cut) this.frames.shift();
    while (this.events.length && this.events[0].t < cut) this.events.shift();
  }

  event(e: ReplayEvent): void {
    this.events.push(e);
  }

  clear(): void {
    this.frames.length = 0;
    this.events.length = 0;
  }

  /** 截取一分的回放：从倒数第 lastHits 拍前一点开始（最多往前 maxLen 秒），到得分后 tail 秒 */
  clip(pointT: number): Replay | null {
    const hits = this.events.filter((e) => e.type === 'hit' && e.t <= pointT);
    const from = hits[Math.max(0, hits.length - REPLAY.lastHits)];
    const t0 = Math.max(
      (from ? from.t : pointT) - REPLAY.lead,
      pointT - REPLAY.maxLen,
      this.frames[0]?.t ?? Infinity
    );
    const t1 = Math.min(pointT + REPLAY.tail, this.frames[this.frames.length - 1]?.t ?? -Infinity);
    if (!(t1 > t0)) return null;
    const frames = this.frames.filter((f) => f.t >= t0 - 0.05 && f.t <= t1 + 0.05);
    if (frames.length < 2) return null;
    return new Replay(
      frames,
      this.events.filter((e) => e.t >= t0 && e.t <= t1),
      t0,
      t1
    );
  }
}

/** 一段回放：按慢放倍率往前走，给出这一刻插值后的画面和这段时间里发生的事件 */
export class Replay {
  /** 回放到的仿真时刻 */
  t: number;
  private next = 0;
  private nextEvent = 0;

  constructor(
    private readonly frames: ReplayFrame[],
    private readonly events: ReplayEvent[],
    readonly t0: number,
    readonly t1: number
  ) {
    this.t = t0;
  }

  get done(): boolean {
    return this.t >= this.t1;
  }

  /** 往前走 dtReal 秒（真实时间，按慢放倍率换算），返回新到的事件 */
  advance(dtReal: number): ReplayEvent[] {
    this.t = Math.min(this.t1, this.t + dtReal * REPLAY.speed);
    const out: ReplayEvent[] = [];
    while (this.nextEvent < this.events.length && this.events[this.nextEvent].t <= this.t)
      out.push(this.events[this.nextEvent++]);
    return out;
  }

  /** 这一刻的画面（相邻两帧之间插值） */
  frame(): ReplayFrame {
    const f = this.frames;
    while (this.next < f.length - 1 && f[this.next + 1].t <= this.t) this.next++;
    const a = f[this.next];
    const b = f[Math.min(this.next + 1, f.length - 1)];
    const u = b.t > a.t ? Math.min(1, Math.max(0, (this.t - a.t) / (b.t - a.t))) : 0;
    const poses: Partial<Record<Side, AvatarPose>> = {};
    for (const side of ['near', 'far'] as const) {
      const pa = a.poses[side];
      const pb = b.poses[side];
      if (pa && pb) poses[side] = lerpPose(pa, pb, u);
      else if (pa) poses[side] = pa;
    }
    return {
      t: this.t,
      ball: lerpDeep(a.ball, b.ball, u),
      ballVisible: u < 0.5 ? a.ballVisible : b.ballVisible,
      trail: u < 0.5 ? a.trail : b.trail,
      spin: lerpDeep(a.spin, b.spin, u),
      poses,
    };
  }
}

/** 两个姿势之间插值：数值线性插值，朝向（正负 1）取近的那一个，球拍的四元数插值后归一 */
export function lerpPose(a: AvatarPose, b: AvatarPose, u: number): AvatarPose {
  const p = lerpDeep(a, b, u);
  p.facing = u < 0.5 ? a.facing : b.facing;
  p.paddleSide = u < 0.5 ? a.paddleSide : b.paddleSide;
  // 四元数 q 和 −q 是同一个朝向：符号相反时把 b 翻过来再插值
  const qa = a.paddle.quat;
  const qb = b.paddle.quat;
  const s = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w < 0 ? -1 : 1;
  const q = {
    x: qa.x + (s * qb.x - qa.x) * u,
    y: qa.y + (s * qb.y - qa.y) * u,
    z: qa.z + (s * qb.z - qa.z) * u,
    w: qa.w + (s * qb.w - qa.w) * u,
  };
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  p.paddle.quat = { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
  return p;
}

/** 结构相同的两个对象（数值、数组、嵌套对象）逐个数值插值 */
function lerpDeep<T>(a: T, b: T, u: number): T {
  if (typeof a === 'number') return (a + ((b as number) - a) * u) as T;
  if (Array.isArray(a)) return a.map((x, i) => lerpDeep(x, (b as unknown[])[i], u)) as T;
  if (a && typeof a === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(a)) {
      out[k] = lerpDeep((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], u);
    }
    return out as T;
  }
  return a;
}
