/**
 * 一次击球的「意图」（落点、速度、旋转、过网高度…）→ 交给求解器算出出手速度。
 * 玩家（挥拍映射）和电脑（ShotPlanner）都产出 ShotSpec，走同一条路径。
 */
import type { Tuning } from '@/config/tuning';
import { type Vec3, vec3 } from '@/core/vec3';
import { NET, TABLE, TABLE_CONTACT_Z } from '../constants';
import {
  checkShot,
  flightTimeForApex,
  solveIntoNet,
  solveRallyShot,
  solveServe,
  solveTarget,
} from './ShotSolver';

export type ShotKind = 'normal' | 'drive' | 'cut' | 'curve' | 'smash' | 'popup' | 'serve';

export const SHOT_KIND_TEXT: Record<ShotKind, string> = {
  normal: '平击',
  drive: '上旋拉球',
  cut: '下旋搓球',
  curve: '侧旋弧圈',
  smash: '扣杀',
  popup: '高球',
  serve: '发球',
};

export interface ShotSpec {
  kind: ShotKind;
  /** 目标落点（台面上的 x, y） */
  target: { x: number; y: number };
  /** 期望水平速度（米/秒） */
  speedH: number;
  /** 上旋（弧度/秒，正 = 上旋，负 = 下旋） */
  topspin: number;
  /** 侧旋（弧度/秒，正 = 从击球方看向左拐） */
  sidespin: number;
  /** 最低过网高度（米）；负数 = 故意下网，瞄准网顶以下这么多 */
  clearance: number;
  /** 高球的期望顶点（台面以上，米） */
  apex?: number;
  /** 被调动后回出的「哎呀」高球 */
  oops?: boolean;
  smash?: boolean;
}

export interface BuiltShot {
  v0: Vec3;
  w0: Vec3;
  ok: boolean;
  spec: ShotSpec;
}

/** 旋转向量：上旋沿 ẑ×d（d 为水平前进方向），侧旋沿 ẑ */
export function spinVector(
  from: Vec3,
  target: { x: number; y: number },
  topspin: number,
  sidespin: number
): Vec3 {
  let dx = target.x - from.x;
  let dy = target.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  // ẑ × d = (−dy, dx, 0)
  return vec3(-dy * topspin, dx * topspin, sidespin);
}

export function buildShot(p0: Vec3, spec: ShotSpec, tune: Tuning): BuiltShot {
  const pp = tune.physics;
  const w0 = spinVector(p0, spec.target, spec.topspin, spec.sidespin);

  if (spec.clearance < 0) {
    // 故意下网：沿出手点到目标的连线，在网平面处取 x
    const f = p0.y / (p0.y - spec.target.y || 1);
    const xAtNet = p0.x + (spec.target.x - p0.x) * Math.max(0, Math.min(1, f));
    const v0 = solveIntoNet(p0, w0, xAtNet, spec.clearance, spec.speedH, pp);
    return { v0, w0, ok: true, spec };
  }

  if (spec.apex !== undefined) {
    const T = flightTimeForApex(p0, spec.apex);
    const aim = vec3(spec.target.x, spec.target.y, TABLE_CONTACT_Z);
    const sol = solveTarget(p0, w0, aim, T, pp);
    const check = checkShot(p0, sol.v0, w0, pp);
    if (check.clearance >= Math.max(0, spec.clearance) || Number.isNaN(check.clearance)) {
      return { v0: sol.v0, w0, ok: sol.ok, spec };
    }
    // 高球都没过网（极少见）：退回普通求解
  }

  const r = solveRallyShot(
    {
      p0,
      w0,
      target: spec.target,
      speedH: spec.speedH,
      minClearance: Math.max(spec.clearance, 0),
      maxApex: spec.apex !== undefined ? Infinity : tune.shot.maxApex,
      flightTimeFactor: tune.shot.flightTimeFactor,
    },
    pp
  );
  // 求解器为了过网可能改了落点，重新按实际落点算旋转方向（变化很小）
  return { v0: r.v0, w0, ok: r.ok, spec: { ...spec, target: r.target } };
}

export interface ServeSpec {
  /** 第一落点（发球方半台）的 y */
  firstY: number;
  /** 第二落点（接发球方半台） */
  second: { x: number; y: number };
  speedH: number;
  topspin: number;
  sidespin: number;
  /** 强力发球（在抛球最高点附近击中）：画面上带拖尾 */
  power?: boolean;
}

export function buildServe(p0: Vec3, spec: ServeSpec, tune: Tuning): BuiltShot {
  const w0 = spinVector(p0, spec.second, spec.topspin, spec.sidespin);
  const r = solveServe(
    {
      p0,
      w0,
      first: { x: p0.x, y: spec.firstY },
      second: spec.second,
      speedH: spec.speedH,
      minClearance: 0.01,
    },
    tune.physics
  );
  return {
    v0: r.v0,
    w0,
    ok: r.ok,
    spec: {
      kind: 'serve',
      target: r.second,
      speedH: spec.speedH,
      topspin: spec.topspin,
      sidespin: spec.sidespin,
      clearance: 0.01,
    },
  };
}

/** 台面范围内（含一点余量）的 x、y 限制 */
export const TABLE_X_LIMIT = TABLE.halfWidth;
export const TABLE_Y_LIMIT = TABLE.halfLength;
export const NET_TOP = NET.top;
