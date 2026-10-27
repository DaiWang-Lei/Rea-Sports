/**
 * 玩家挥拍 → 击球判定与击球映射（纯逻辑）。
 *
 * 判定（每个来球只算一次「出手」）：
 *  - 预测接触时刻 tContact 与理想击球时刻 T_ideal 的偏差 τ = (tContact − T_ideal) / H；
 *  - 很早（τ < −3.5）的动作当作准备动作，忽略；慢挥拍偏早也忽略（多半是引拍）；
 *  - 球还没在本方台面弹起、且就在弹起前 100ms 内挥中 → 未落台击球（犯规）；
 *  - τ ∈ [τmin, τmax] 击中；偏早 / 偏晚 → 挥空；
 *  - 同一个动作里，后来的、更快的反向挥拍可以取代还没执行的击球（引拍被误认成挥拍时）；
 *  - 挥早 / 未落台先挂起 holdEarly 秒再算数：期间来一下反方向、更快的挥拍，就把前面那下当引拍丢掉。
 *    引拍挥得快（≥ 快速确认阈值）时，它比真正的击球早 0.3–0.45 秒，人一打晚就正好落进「挥早」区间。
 * 击中后在 max(T_ideal, 确认时刻) 执行，球在理想击球点被打出（与 WSR 一样不需要真的把拍子对准球）。
 *
 * 映射（见计划附录）：时机 → 左右（早打斜线）、峰值角速度 → 球速、拍面俯仰 / 翻腕 / 刷球方向 → 上下旋、
 * 绕前进方向的转动 → 侧旋；拍面过于后仰出长球、过于前压下网；来球旋转有轻度影响；
 * 被调动（站位差太多、接扣杀时机不好）→ 「哎呀」高球；对高球大力挥拍 → 扣杀。
 */
import type { Tuning } from '@/config/tuning';
import { clamp, DEG, lerp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { Vec3 } from '@/core/vec3';
import { type Side, sideDir, TABLE } from '../constants';
import { rightSign, type Stroke } from '../players/PlayerSim';
import type { ShotKind, ShotSpec } from '../shot/ShotSpec';
import type { ContactPlan } from './contactZone';

/** 挥拍特征（玩家自己的坐标系：x 右、y 朝对手、z 上；左手玩家已镜像为右手） */
export interface SwingFeatures {
  /** 击球面俯仰（弧度）：正 = 拍面后仰（朝上，搓球），负 = 前压（朝下，拉上旋）；未校准时为 NaN */
  facePitch: number;
  /** 挥拍过程中拍面俯仰的变化（峰值 − 起动，弧度）；前压（变小）= 上旋 */
  pitchChange: number;
  /** 刷球方向（弧度）：正 = 由下往上刷，负 = 由上往下切；未校准时为 NaN */
  brush: number;
  /** 绕前进方向的转动角速度（rad/s），用于侧旋；未校准时为 NaN */
  roll: number;
}

export const NO_FEATURES: SwingFeatures = {
  facePitch: NaN,
  pitchChange: NaN,
  brush: NaN,
  roll: NaN,
};

export interface SwingInput {
  id: number;
  motion: number;
  path: 'fast' | 'gentle' | 'key';
  /** 仿真时刻：这次挥拍被确认（数据到达）的时间 */
  tDetect: number;
  /** 仿真时刻：预测的接触时间（已扣除画面延迟） */
  tContact: number;
  /** +1 逆时针（右手正手）、−1 顺时针、0 方向不明；已按左右手镜像成「正手 = +1」 */
  dir: 1 | -1 | 0;
  yawFrac: number;
  /** 峰值角速度（估计或实际），rad/s */
  wPeak: number;
  features: SwingFeatures;
}

export interface AttemptBall {
  plan: ContactPlan;
  /** 来球是高球 / 扣杀 */
  popup: boolean;
  smash: boolean;
}

export type MissOutcome =
  | { type: 'whiff'; reason: 'early' | 'late'; tau: number; stroke: Stroke }
  | { type: 'volley'; tau: number; stroke: Stroke };

export type SwingOutcome =
  | { type: 'ignore' }
  | MissOutcome
  /** 挥早 / 未落台，先挂起到 until（见 dueHeld）；期间可能被反方向更快的挥拍取代 */
  | { type: 'held'; miss: MissOutcome; until: number }
  | { type: 'hit'; tau: number; stroke: Stroke; execAt: number };

export interface PendingHit {
  swing: SwingInput;
  stroke: Stroke;
  tau: number;
  execAt: number;
}

interface HeldMiss {
  swing: SwingInput;
  miss: MissOutcome;
  until: number;
}

export interface ResolverConfig {
  /** 时机窗口 H（秒） */
  window: number;
  tauMin: number;
  tauMax: number;
  /** 比这个更早的动作忽略 */
  tauIgnore: number;
  /** 慢挥拍确认后最少再等多久执行（给更快的前向挥拍留出取代的机会），秒 */
  gentleHold: number;
  /** 同一动作内允许取代的最长间隔，秒 */
  supersedeWithin: number;
  /** 比落台早这么一点点（秒）不算未落台击球，按刚弹起时击中处理 */
  bounceGrace: number;
  /** 挥早 / 未落台挂起多久（秒）才算数 */
  holdEarly: number;
}

export function resolverConfig(tune: Tuning, windowMs: number): ResolverConfig {
  return {
    window: windowMs / 1000,
    tauMin: tune.timing.tauMin,
    tauMax: tune.timing.tauMax,
    tauIgnore: -3.5,
    gentleHold: 0.05,
    supersedeWithin: 0.3,
    bounceGrace: 0.02,
    holdEarly: 0.45,
  };
}

/**
 * 一个来球内的挥拍判定状态机。来球开始时 begin()，每次挥拍 onSwing()，每个仿真步 due() 取出到期的击球。
 */
export class HitResolver {
  ball: AttemptBall | null = null;
  pending: PendingHit | null = null;
  held: HeldMiss | null = null;
  /** 这个来球已经出手过（击中 / 挥空 / 犯规） */
  attempted = false;
  /** 没有明确方向时用的站位（由上层按球拍朝向或来球位置更新） */
  stance: Stroke = 'fh';

  constructor(public cfg: ResolverConfig) {}

  begin(ball: AttemptBall): void {
    this.ball = ball;
    this.pending = null;
    this.held = null;
    this.attempted = false;
  }

  /** 来球轨迹变化（擦网等）后更新击球点，不改变出手状态 */
  update(ball: AttemptBall): void {
    this.ball = ball;
  }

  end(): void {
    this.ball = null;
    this.pending = null;
    this.held = null;
  }

  strokeOf(sw: SwingInput): Stroke {
    if (sw.dir !== 0 && sw.yawFrac >= 0.3) return sw.dir > 0 ? 'fh' : 'bh';
    return this.stance;
  }

  onSwing(sw: SwingInput): SwingOutcome {
    const ball = this.ball;
    if (!ball || this.attempted) return { type: 'ignore' };
    const c = this.cfg;
    const plan = ball.plan;
    const tau = (sw.tContact - plan.t) / c.window;
    const stroke = this.strokeOf(sw);

    // 挂起的挥早 / 未落台：反方向、更快的挥拍把它当引拍取代（不要求同一动作：引拍和前挥之间常有停顿）
    const h = this.held;
    if (h) {
      const replaces =
        sw.dir !== h.swing.dir &&
        sw.wPeak > h.swing.wPeak &&
        sw.tDetect - h.swing.tDetect <= c.holdEarly;
      if (!replaces) return { type: 'ignore' };
      this.held = null;
    }

    // 取代还没执行的击球（同一动作里的更快反向挥拍）
    const p = this.pending;
    if (p) {
      const sameMotion =
        p.swing.motion === sw.motion && sw.tDetect - p.swing.tDetect <= c.supersedeWithin;
      const better =
        p.swing.path === 'gentle'
          ? sw.path === 'fast'
          : sw.dir !== p.swing.dir && sw.wPeak > p.swing.wPeak;
      if (!sameMotion || !better) return { type: 'ignore' };
      this.pending = null;
    }

    if (tau < c.tauIgnore) return { type: 'ignore' };
    const strong = sw.path !== 'gentle';
    if (sw.tContact < plan.bounceT - c.bounceGrace) {
      // 还没落台：弹起前 100ms 内又挥得够快 → 未落台击球；更早算挥早（慢挥拍多半是引拍，忽略）
      if (strong && sw.tContact >= plan.bounceT - 0.1 && sw.wPeak >= 7) {
        return this.hold(sw, { type: 'volley', tau, stroke });
      }
      if (!strong) return { type: 'ignore' };
      return this.hold(sw, { type: 'whiff', reason: 'early', tau, stroke });
    }
    if (tau < c.tauMin) {
      if (!strong) return { type: 'ignore' };
      return this.hold(sw, { type: 'whiff', reason: 'early', tau, stroke });
    }
    if (tau > c.tauMax) {
      this.attempted = true;
      return { type: 'whiff', reason: 'late', tau, stroke };
    }
    const execAt = Math.max(plan.t, sw.tDetect + (sw.path === 'gentle' ? c.gentleHold : 0));
    this.pending = { swing: sw, stroke, tau, execAt };
    return { type: 'hit', tau, stroke, execAt };
  }

  private hold(sw: SwingInput, miss: MissOutcome): SwingOutcome {
    const until = sw.tDetect + this.cfg.holdEarly;
    this.held = { swing: sw, miss, until };
    return { type: 'held', miss, until };
  }

  /** 挂起到期（now ≥ until，或 force：球已经死了）的挥早 / 未落台：取出并标记已出手 */
  dueHeld(now: number, force = false): MissOutcome | null {
    const h = this.held;
    if (!h || (!force && now < h.until)) return null;
    this.held = null;
    this.attempted = true;
    return h.miss;
  }

  /** 峰值细化：更新还没执行的击球的峰值与拍面特征 */
  refine(id: number, wPeak: number, features: SwingFeatures | null): void {
    const p = this.pending;
    if (!p || p.swing.id !== id) return;
    p.swing = { ...p.swing, wPeak, features: features ?? p.swing.features };
  }

  /** 到期的击球（now ≥ execAt）：取出并标记已出手 */
  due(now: number): PendingHit | null {
    const p = this.pending;
    if (!p || now < p.execAt) return null;
    this.pending = null;
    this.attempted = true;
    return p;
  }
}

// ---------------------------------------------------------------- 击球映射

export interface MapContext {
  side: Side;
  handed: 1 | -1;
  stroke: Stroke;
  tau: number;
  wPeak: number;
  features: SwingFeatures;
  /** 击球点（世界坐标） */
  contact: Vec3;
  /** 来球速度 / 旋转（世界坐标） */
  vIn: Vec3;
  wIn: Vec3;
  popupIn: boolean;
  smashIn: boolean;
  /** 站位误差（米），> reachNormal 为「哎呀」 */
  reachError: number;
  pace: number;
  /** 宽容度 0..1：越大噪声越小、角度阈值越宽 */
  leniency: number;
}

export interface MappedShot {
  spec: ShotSpec;
  rushed: boolean;
  /** 0..1 力度 */
  power: number;
  /** −1..1：正 = 上旋 */
  spin: number;
}

const FULL_W = 22;
const MIN_W = 5;
/**
 * 时机对左右落点的影响：u（以半台宽为单位）每 1 个 τ 偏移多少。2026-10-27 从 0.85 降到 0.62：
 * 普通的时机偏差不再把球打出边线（早 / 晚约 90ms 打到离中线六成处），极早 / 极晚（τ 超过约 ±1.8）才出界
 */
const TIMING_TO_AIM = 0.62;

/** 来球相对接球方的上旋分量（rad/s，正 = 上旋） */
function incomingTopspin(v: Vec3, w: Vec3): number {
  const d = Math.hypot(v.x, v.y) || 1;
  return w.x * (-v.y / d) + w.y * (v.x / d);
}

/** 力度 0..1：峰值角速度 5 → 22 rad/s */
export function swingPower(wPeak: number): number {
  return clamp((wPeak - MIN_W) / (FULL_W - MIN_W), 0, 1);
}

/**
 * 上下旋程度 σ（−1..1，正 = 上旋）：拍面俯仰（以平时的角度为基准）为主，翻腕、刷球方向为辅；
 * |σ| < 0.15 算不转。宽容度越大，俯仰的死区越宽
 */
export function spinSigma(ft: SwingFeatures, leniency: number): number {
  const f = clamp(leniency, 0, 1);
  const thr = 6 * DEG + 15 * DEG * f * 0.5;
  const beta = ft.facePitch;
  const sigmaFace = Number.isNaN(beta)
    ? 0
    : -Math.sign(beta) * clamp((Math.abs(beta) - thr) / (24 * DEG), 0, 1);
  const sigmaTwist = Number.isNaN(ft.pitchChange) ? 0 : clamp(-ft.pitchChange / (25 * DEG), -1, 1);
  const sigmaBrush = Number.isNaN(ft.brush) ? 0 : clamp(ft.brush / (35 * DEG), -1, 1);
  const sigma = clamp(0.7 * sigmaFace + 0.3 * sigmaTwist + 0.25 * sigmaBrush, -1, 1);
  return Math.abs(sigma) < 0.15 ? 0 : sigma;
}

/** 侧旋程度（−1..1）：绕前进方向的转动；s = +1 正手、−1 反手（以击球者自己的左右为准） */
export function sideSpinAmount(ft: SwingFeatures, s: number): number {
  const roll = Number.isNaN(ft.roll) ? 0 : ft.roll;
  return Math.sign(roll) * clamp((Math.abs(roll) - 5) / 9, 0, 1) * s;
}

export function mapSwing(ctx: MapContext, rng: Rng, tune: Tuning): MappedShot {
  const dir = sideDir(ctx.side);
  const rs = rightSign(ctx.side);
  const m = tune.mover;
  const f = clamp(ctx.leniency, 0, 1);
  const noise = 1.3 - 0.6 * f;
  const q = swingPower(ctx.wPeak);
  // 以击球者自己的左右为准：s = +1 正手，−1 反手；左手玩家整体镜像
  const s = (ctx.stroke === 'fh' ? 1 : -1) * ctx.handed;
  const xSelf = (ctx.contact.x * rs) / TABLE.halfWidth;

  const rushed = ctx.reachError > m.reachNormal || (ctx.smashIn && Math.abs(ctx.tau) > 0.45);
  if (rushed) {
    const u = clamp(s * TIMING_TO_AIM * ctx.tau * 0.6 + 0.2 * xSelf, -1.1, 1.1);
    return {
      rushed: true,
      power: q,
      spin: 0,
      spec: {
        kind: 'popup',
        target: { x: u * TABLE.halfWidth * rs, y: dir * rng.uniform(0.55, 1.05) },
        speedH: 4,
        topspin: rng.uniform(-30, 30),
        sidespin: rng.uniform(-30, 30),
        clearance: 0.05,
        apex: rng.uniform(0.65, 1.0),
        oops: true,
      },
    };
  }

  const heightAboveTable = ctx.contact.z - TABLE.height;
  if (ctx.popupIn && heightAboveTable >= 0.3 && ctx.wPeak >= 15 && Math.abs(ctx.tau) <= 0.8) {
    const u = clamp(
      s * TIMING_TO_AIM * ctx.tau + 0.2 * xSelf + rng.normal(0, 0.05 * noise),
      -1.3,
      1.3
    );
    return {
      rushed: false,
      power: q,
      spin: 0.3,
      spec: {
        kind: 'smash',
        target: { x: u * TABLE.halfWidth * rs, y: dir * rng.uniform(0.75, 1.15) },
        speedH: (15.5 + 3 * clamp((ctx.wPeak - 18) / 10, 0, 1)) * ctx.pace,
        topspin: 80,
        sidespin: 0,
        clearance: 0.02,
        smash: true,
      },
    };
  }

  // ---- 旋转
  const ft = ctx.features;
  const beta = ft.facePitch;
  const sigma = spinSigma(ft, f);
  const topspin = sigma > 0 ? 40 + 220 * sigma * (0.6 + 0.4 * q) : 30 + 230 * sigma;
  const sidespin = 170 * sideSpinAmount(ft, s);

  // ---- 速度
  const vInH = Math.hypot(ctx.vIn.x, ctx.vIn.y);
  const speedH = Math.max(lerp(5.5, 12.5, q ** 0.85) * ctx.pace, 0.4 * vInH);

  // ---- 左右：时机（早打斜线）+ 击球点位置 + 噪声 + 来球侧旋
  const sIn = incomingTopspin(ctx.vIn, ctx.wIn) / 250;
  let u =
    s * TIMING_TO_AIM * ctx.tau +
    0.2 * xSelf +
    rng.normal(0, (0.04 + 0.06 * q) * noise) -
    (0.075 * ctx.wIn.z * rs) / 170;
  u = clamp(u, -1.6, 1.6);

  // ---- 深度
  const sp = Math.max(0, sigma);
  const sn = Math.max(0, -sigma);
  const eOver = 0.2 * clamp((q - 0.8) / 0.2, 0, 1) * clamp(1 - sp / 0.3, 0, 1);
  const betaDeg = Number.isNaN(beta) ? 0 : beta / DEG;
  const openLimit = 45 + 15 * f;
  const eOpen = 0.3 * clamp((betaDeg - openLimit) / 15, 0, 1);
  const eIn = 0.5 * sIn * (1 - clamp(sigma * Math.sign(sIn), 0, 1));
  let depth =
    0.95 +
    0.2 * (q - 0.5) +
    0.1 * sp -
    0.12 * sn +
    eOver +
    eOpen +
    0.35 * eIn +
    rng.normal(0, (0.05 + 0.05 * q) * noise);
  depth = clamp(depth, 0.25, 1.75);

  // ---- 过网高度：拍面压得太低下网；重下旋来球没有提拉也会下网
  let clearance = tune.shot.minClearance + 0.03;
  if (betaDeg < -openLimit) clearance = -0.03 - 0.05 * clamp((-betaDeg - openLimit) / 15, 0, 1);
  else if (eIn < -0.3) clearance = 0.02 + 0.1 * (eIn + 0.3);

  let kind: ShotKind = 'normal';
  if (Math.abs(sidespin) > 80) kind = 'curve';
  else if (sigma >= 0.45) kind = 'drive';
  else if (sigma <= -0.3) kind = 'cut';

  return {
    rushed: false,
    power: q,
    spin: sigma,
    spec: {
      kind,
      target: { x: u * TABLE.halfWidth * rs, y: dir * depth },
      speedH,
      topspin,
      sidespin,
      clearance,
    },
  };
}
