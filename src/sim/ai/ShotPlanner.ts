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
import {
  popupApex,
  type ServeSpec,
  SMASH_RETURN_TAU,
  type ShotKind,
  type ShotSpec,
} from '../shot/ShotSpec';

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
  /** 这一板扣杀接不住：一看到球飞来就定了，接不住的人愣在原地（不往球边上挪，球可能打到脸上） */
  smashBeaten: boolean;
  oppX: number;
  /** 本回合已击球次数 */
  rallyHits: number;
}

/**
 * 各类回球的基础水平速度（米/秒，再乘难度倍率与节奏 pace）。
 * 击球点在台后约 0.5 米（WSR 那样退后接球），每板飞得比贴着台端打远约 0.3 米，球速相应快一些，
 * 击球到落台仍约 0.57 秒（NSSR 实测）
 */
const BASE_SPEED: Record<ShotKind, number> = {
  normal: 5.4,
  drive: 7.3,
  cut: 4.75,
  curve: 5.8,
  smash: 10,
  popup: 4.0,
  serve: 6.0,
};

/** 电脑的时机误差对左右落点的影响系数（玩家是 1，电脑略小一些） */
const CPU_TIMING_TO_AIM = 0.8;

/**
 * 回合越长越想「一板打死」：速度加成、角度更大、散布更大（更容易出界），避免两个强电脑无限对拉，也更像真人对打。
 * 2026-11-23 去掉了「回合越长越容易被调动成高球」：第 15 拍以后电脑三到六成的回球是慢悠悠的高球，
 * 在 11 分制的快节奏里像进了慢动作。
 */
function rallyPressure(rallyHits: number): {
  speed: number;
  marginScale: number;
  sigmaScale: number;
} {
  // 第 16 拍后还继续加（到第 28 拍封顶）：不封顶得太早，两个电脑偶尔能对拉七八十拍
  const aggression = clamp((rallyHits - 4) / 12, 0, 2);
  return {
    speed: 1 + 0.1 * aggression,
    marginScale: 1 - 0.4 * aggression,
    sigmaScale: 1 + 0.35 * aggression,
  };
}

/**
 * 击球点来球水平速度的基准和跨度（米/秒）：比基准每快一个跨度，威胁 +0.4。
 * 按 NSSR 的节奏（回球约 0.6 秒落到对方台），击球点来球速度大多在 2.3–2.7 m/s。
 */
const THREAT_SPEED_REF = 3.3;
const THREAT_SPEED_SPAN = 2.2;

/**
 * 来球威胁（越大越难接好）。球速按节奏换算：11 分制所有球都快 40%，这不该让电脑整体更容易被逼出高球
 * （以前用绝对球速，11 分制里中级电脑 36% 的回球是高球，6 分制 12%；再加上回合越长越容易出高球，
 * 第 15 拍以后三到六成是慢悠悠的高球，像慢动作）。
 * 速度只算朝自己飞来的前后分量：斜线球为了节奏不变打得更快，多出来的是横向速度，人跑过去就行
 */
export function incomingThreat(contact: ContactPlan, smash: boolean, pace = 1): number {
  const vin = Math.abs(contact.v.y) / pace;
  const win = Math.hypot(contact.w.x, contact.w.y, contact.w.z);
  return (
    (0.4 * (vin - THREAT_SPEED_REF)) / THREAT_SPEED_SPAN +
    (0.3 * win) / 250 +
    // 跑出边线去接不额外加威胁（人会跑过去）：按台边封顶
    0.2 * Math.min(1, Math.abs(contact.p.x) / TABLE.halfWidth) +
    (smash ? 0.5 : 0)
  );
}

/** 从台边一侧击球时打大角度斜线的比例 */
const CROSS_COURT = 0.7;

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

  // 左右：常打大角度斜线——从自己击球的一侧打到对面另一侧的边线附近，球落台后带着横向速度往台外飞，
  // 对手得跑出边线去接（WSR 里很常见）；其余打向对手站位的另一侧，或者随便打
  const myX = info.contact.p.x;
  let x: number;
  if (Math.abs(myX) > 0.2 && rng.chance(CROSS_COURT)) {
    x = -Math.sign(myX) * rng.uniform(0.5 * xMax, 0.9 * xMax);
  } else if (rng.chance(0.65)) {
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
      lv.spinUse * lv.driveShare, // drive
      lv.spinUse * (1 - lv.driveShare), // cut
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

/** 扣杀时追身（瞄着对手站的位置打）的概率 */
const BODY_SMASH_P = 0.3;

export type WhiffReason = 'reach' | 'smash' | 'timing' | 'early' | 'notReady';

export type HitDecision =
  { type: 'whiff'; reason: WhiffReason } | { type: 'hit'; spec: ShotSpec; rushed: boolean };

/** 真正击球那一刻：把各种失误加进去，得到最终的 ShotSpec */
export function finalizeHit(ctx: HitContext, lv: CpuLevel, rng: Rng, tune: Tuning): HitDecision {
  const { info, intent, tau, reachError, pace } = ctx;
  const m = tune.mover;
  const dir = sideDir(info.side);
  if (reachError > m.reachRushed) return { type: 'whiff', reason: 'reach' };
  if (info.smash && info.smashBeaten) return { type: 'whiff', reason: 'smash' };

  const threat = incomingThreat(info.contact, info.smash, pace);
  const pRush = clamp(1.5 * (threat - lv.composure), 0, 0.6);
  const rushed =
    reachError > m.reachNormal ||
    rng.chance(pRush) ||
    (info.smash && Math.abs(tau) > SMASH_RETURN_TAU);

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
        apex: popupApex(rng, pace),
        oops: true,
      },
    };
  }

  if (info.popup && ctx.ballHeight >= 0.3 && rng.chance(lv.smashP)) {
    // 追身扣杀（打对手站的位置，躲都来不及）或按原来想打的落点
    const x = rng.chance(BODY_SMASH_P)
      ? clamp(info.oppX + rng.normal(0, 0.08), -0.6, 0.6)
      : clamp(intent.target.x + dxWorld, -1, 1);
    return {
      type: 'hit',
      rushed: false,
      spec: {
        kind: 'smash',
        target: { x, y: dir * rng.uniform(0.75, 1.15) },
        speedH: (BASE_SPEED.smash + rng.uniform(0, 2)) * pace,
        topspin: 80,
        sidespin: 0,
        clearance: 0.02,
        smash: true,
      },
    };
  }

  // 斜线比直线远，多出来的横向距离不该拖慢节奏：前后方向的速度和直线球一样
  const target = { x: intent.target.x + dxWorld, y: intent.target.y };
  const c = info.contact.p;
  const along = Math.abs(target.y - c.y);
  const slant = along > 0.5 ? Math.hypot(target.x - c.x, target.y - c.y) / along : 1;
  return {
    type: 'hit',
    rushed: false,
    spec: {
      kind: intent.kind,
      target,
      speedH: BASE_SPEED[intent.kind] * intent.speedMul * pace * slant,
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
