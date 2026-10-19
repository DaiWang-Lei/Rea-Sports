/**
 * 电脑选球：根据来球（威胁、是否高球/扣杀）、自身水平、对手站位，决定回什么球、打到哪里，
 * 并把时机误差、落点散布、过网误差、被调动（哎呀）等失误加进去。
 */
import type { CpuLevel } from '@/config/difficulty';
import type { Tuning } from '@/config/tuning';
import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import { type Side, sideDir, TABLE } from '../constants';
import type { ContactPlan } from '../hit/contactZone';
import { rightSign, type Stroke } from '../players/PlayerSim';
import type { ServeSpec, ShotKind, ShotSpec } from '../shot/ShotSpec';

export interface ShotIntent {
  kind: ShotKind;
  /** 目标落点（已带落点散布，未加时机偏移） */
  target: { x: number; y: number };
  speedMul: number;
  topspin: number;
  sidespin: number;
  clearance: number;
}

export interface IncomingInfo {
  side: Side;
  handed: 1 | -1;
  stance: Stroke;
  contact: ContactPlan;
  popup: boolean;
  smash: boolean;
  oppX: number;
  /** 本回合已击球次数 */
  rallyHits: number;
}

/** 各类回球的基础水平速度（米/秒，再乘难度倍率与节奏 pace） */
const BASE_SPEED: Record<ShotKind, number> = {
  normal: 5.0,
  drive: 6.8,
  cut: 4.4,
  curve: 5.4,
  smash: 13,
  popup: 4.0,
  serve: 6.0,
};

/** 电脑的时机误差对左右落点的影响系数（玩家是 1，电脑略小一些） */
const CPU_TIMING_TO_AIM = 0.8;

/**
 * 回合越长越想「一板打死」：威胁加成（更容易被调动）、速度加成、角度更大、散布更大。
 * 避免两个强电脑无限对拉，也更像真人对打。
 */
function rallyPressure(rallyHits: number): {
  threat: number;
  speed: number;
  marginScale: number;
  sigmaScale: number;
} {
  const over = Math.max(0, rallyHits - 6);
  const aggression = clamp((rallyHits - 4) / 12, 0, 1);
  return {
    threat: 0.03 * over,
    speed: 1 + 0.25 * aggression,
    marginScale: 1 - 0.5 * aggression,
    sigmaScale: 1 + 0.5 * aggression,
  };
}

/** 来球威胁（越大越难接好） */
export function incomingThreat(contact: ContactPlan, smash: boolean): number {
  const vin = Math.hypot(contact.v.x, contact.v.y);
  const win = Math.hypot(contact.w.x, contact.w.y, contact.w.z);
  return (
    (0.4 * (vin - 8)) / 6 +
    (0.3 * win) / 250 +
    (0.2 * Math.abs(contact.p.x)) / TABLE.halfWidth +
    (smash ? 0.5 : 0)
  );
}

/** 来球的上旋分量（正 = 上旋）相对接球方前进方向而言 */
function incomingTopspin(contact: ContactPlan): number {
  const v = contact.v;
  const d = Math.hypot(v.x, v.y) || 1;
  // 上旋：ω·(ẑ × d)，d 为来球水平方向
  return (contact.w.x * (-v.y / d) + contact.w.y * (v.x / d)) / 250;
}

/** 在击球前（落台时或击球前 0.45 秒）决定这一板的意图 */
export function chooseIntent(info: IncomingInfo, lv: CpuLevel, rng: Rng): ShotIntent {
  const dir = sideDir(info.side);
  const pressure = rallyPressure(info.rallyHits);
  const margin = lv.aimMargin * pressure.marginScale;
  const sigma = lv.landingSigma * pressure.sigmaScale;
  const xMax = TABLE.halfWidth - margin;

  // 打向对手站位的另一侧
  let x: number;
  if (rng.chance(0.65)) {
    const away = info.oppX > 0 ? -1 : 1;
    x = away * rng.uniform(0.2, xMax);
  } else {
    x = rng.uniform(-xMax, xMax);
  }
  const depth = rng.uniform(0.55, TABLE.halfLength - Math.max(0.08, margin * 0.5));
  const target = {
    x: x + rng.normal(0, sigma),
    y: dir * (depth + rng.normal(0, sigma)),
  };

  let kind: ShotKind;
  const sIn = incomingTopspin(info.contact);
  if (sIn < -0.5) {
    kind = rng.chance(0.6) ? 'cut' : 'drive';
  } else {
    const w = [
      Math.max(0.1, 1 - lv.spinUse - lv.curveUse), // normal
      lv.spinUse * 0.6, // drive
      lv.spinUse * 0.4, // cut
      lv.curveUse, // curve
    ];
    kind = (['normal', 'drive', 'cut', 'curve'] as const)[rng.pickWeighted(w)];
  }

  let topspin = 0;
  let sidespin = 0;
  switch (kind) {
    case 'normal':
      topspin = rng.uniform(40, 110);
      break;
    case 'drive':
      topspin = rng.uniform(150, 260);
      break;
    case 'cut':
      topspin = -rng.uniform(110, 200);
      break;
    case 'curve':
      topspin = rng.uniform(40, 90);
      sidespin = (rng.chance(0.5) ? 1 : -1) * rng.uniform(100, 170);
      break;
    default:
      break;
  }
  return {
    kind,
    target,
    speedMul: rng.uniform(lv.speedMin, lv.speedMax) * pressure.speed,
    topspin,
    sidespin,
    clearance: 0.06 + rng.normal(0, lv.clearanceSigma * 1.5),
  };
}

export interface HitContext {
  info: IncomingInfo;
  intent: ShotIntent;
  /** 时机偏差（归一化 τ，负 = 偏早） */
  tau: number;
  /** 击球时身体离理想位置的距离（米） */
  reachError: number;
  pace: number;
  /** 球当前高度（台面以上） */
  ballHeight: number;
}

export type WhiffReason = 'reach' | 'smash' | 'timing' | 'early' | 'notReady';

export type HitDecision =
  { type: 'whiff'; reason: WhiffReason } | { type: 'hit'; spec: ShotSpec; rushed: boolean };

/** 真正击球那一刻：把各种失误加进去，得到最终的 ShotSpec */
export function finalizeHit(ctx: HitContext, lv: CpuLevel, rng: Rng, tune: Tuning): HitDecision {
  const { info, intent, tau, reachError, pace } = ctx;
  const m = tune.mover;
  const dir = sideDir(info.side);
  if (reachError > m.reachRushed) return { type: 'whiff', reason: 'reach' };
  if (info.smash && !rng.chance(lv.smashReturnP)) return { type: 'whiff', reason: 'smash' };

  const pressure = rallyPressure(info.rallyHits);
  const threat = incomingThreat(info.contact, info.smash) + pressure.threat;
  const pRush = clamp(1.5 * (threat - lv.composure), 0, 0.6);
  const rushed =
    reachError > m.reachNormal || rng.chance(pRush) || (info.smash && Math.abs(tau) > 0.45);

  // 时机 → 左右：早打斜线（以击球者自己的左右为准，左手镜像）
  const sEff = (info.stance === 'fh' ? 1 : -1) * info.handed;
  const dxSelf = sEff * 0.85 * tau * TABLE.halfWidth * CPU_TIMING_TO_AIM;
  const dxWorld = dxSelf * rightSign(info.side);

  if (rushed) {
    const x = clamp(intent.target.x * 0.6 + dxWorld * 0.6, -0.9, 0.9);
    return {
      type: 'hit',
      rushed: true,
      spec: {
        kind: 'popup',
        target: { x, y: dir * rng.uniform(0.55, 1.05) },
        speedH: 4,
        topspin: rng.uniform(-30, 30),
        sidespin: rng.uniform(-30, 30),
        clearance: 0.05,
        apex: rng.uniform(0.65, 1.0),
        oops: true,
      },
    };
  }

  if (info.popup && ctx.ballHeight >= 0.3 && rng.chance(lv.smashP)) {
    return {
      type: 'hit',
      rushed: false,
      spec: {
        kind: 'smash',
        target: {
          x: clamp(intent.target.x + dxWorld, -1, 1),
          y: dir * rng.uniform(0.75, 1.15),
        },
        speedH: (BASE_SPEED.smash + rng.uniform(0, 3)) * pace,
        topspin: 80,
        sidespin: 0,
        clearance: 0.02,
        smash: true,
      },
    };
  }

  return {
    type: 'hit',
    rushed: false,
    spec: {
      kind: intent.kind,
      target: { x: intent.target.x + dxWorld, y: intent.target.y },
      speedH: BASE_SPEED[intent.kind] * intent.speedMul * pace,
      topspin: intent.topspin,
      sidespin: intent.sidespin,
      clearance: intent.clearance,
    },
  };
}

/** 电脑发球 */
export function chooseServe(side: Side, lv: CpuLevel, rng: Rng, pace: number): ServeSpec {
  const dir = sideDir(side);
  const xMax = TABLE.halfWidth - Math.max(0.1, lv.aimMargin);
  const fault = rng.chance(lv.clearanceSigma);
  const spin = rng.chance(lv.spinUse)
    ? (rng.chance(0.5) ? 1 : -1) * rng.uniform(80, 160)
    : rng.uniform(-40, 60);
  return {
    firstY: -dir * rng.uniform(0.5, 0.95),
    second: {
      x: (rng.chance(0.5) ? 1 : -1) * rng.uniform(0.1, xMax),
      // 少数情况发长出界（发球失误）
      y: dir * (fault ? TABLE.halfLength + 0.25 : rng.uniform(0.6, 1.15)),
    },
    speedH: rng.uniform(4.5, 7.5) * pace * rng.uniform(lv.speedMin, lv.speedMax),
    topspin: spin,
    sidespin: rng.chance(lv.curveUse) ? (rng.chance(0.5) ? 1 : -1) * rng.uniform(60, 120) : 0,
  };
}
