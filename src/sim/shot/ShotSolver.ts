/**
 * 击球求解器：已知出手点、旋转、目标落点和飞行时间，反推出手速度。
 * 与仿真共用同一个积分器（RK4、240Hz 步长网格），所以解出来的球会精确落在目标点（误差 < 1cm）。
 *
 *  - solveTarget：自由飞行到目标点（Broyden 拟牛顿迭代）；也用来瞄准「网上的某一点」做下网失误
 *  - solveRallyShot：普通回球，带过网高度 / 顶点高度检查与自动调整
 *  - solveServe：发球，两段（先落本方台再落对方台），有限差分牛顿迭代
 */
import { clamp } from '@/core/math';
import { type Vec3, vec3 } from '@/core/vec3';
import {
  ballState,
  type BallEvent,
  type BallState,
  cloneBall,
  flyFree,
  frictionBounce,
  type PhysicsParams,
  rk4,
  stepBall,
} from '../ball/physics';
import {
  BALL,
  GRAVITY,
  NET,
  type Side,
  sideOfY,
  SIM_DT,
  TABLE,
  TABLE_CONTACT_Z,
} from '../constants';

export interface SolveResult {
  ok: boolean;
  v0: Vec3;
  iterations: number;
  /** 终点误差（米） */
  error: number;
}

/** 3×3 线性方程组 A x = b（Cramer 法则）；奇异时返回 null */
function solve3(a: number[], b: Vec3): Vec3 | null {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const det =
    a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return vec3(
    inv *
      (b.x * (a11 * a22 - a12 * a21) -
        a01 * (b.y * a22 - a12 * b.z) +
        a02 * (b.y * a21 - a11 * b.z)),
    inv *
      (a00 * (b.y * a22 - a12 * b.z) -
        b.x * (a10 * a22 - a12 * a20) +
        a02 * (a10 * b.z - b.y * a20)),
    inv *
      (a00 * (a11 * b.z - b.y * a21) -
        a01 * (a10 * b.z - b.y * a20) +
        b.x * (a10 * a21 - a11 * a20))
  );
}

/** 不考虑空气的弹道初值 */
function ballisticGuess(p0: Vec3, target: Vec3, T: number): Vec3 {
  return vec3(
    (target.x - p0.x) / T,
    (target.y - p0.y) / T,
    (target.z - p0.z + 0.5 * GRAVITY * T * T) / T
  );
}

const S_FLY = ballState();

/**
 * 求出手速度 v0，使球自由飞行（忽略碰撞）T 秒后到达 target。
 */
export function solveTarget(
  p0: Vec3,
  w0: Vec3,
  target: Vec3,
  T: number,
  pp: PhysicsParams,
  opts: { maxIter?: number; tol?: number; guess?: Vec3 } = {}
): SolveResult {
  const maxIter = opts.maxIter ?? 10;
  const tol = opts.tol ?? 0.005;
  let v = opts.guess ? { ...opts.guess } : ballisticGuess(p0, target, T);
  if (!opts.guess) {
    // 粗略补偿空气阻力：水平速度加一点
    const k = 1 + pp.dragK * Math.hypot(v.x, v.y) * T * 0.5;
    v.x *= k;
    v.y *= k;
  }
  // 初始雅可比 ∂p/∂v ≈ 0.85·T·I（阻力会让它略小于 T）
  const J = [0.85 * T, 0, 0, 0, 0.85 * T, 0, 0, 0, 0.85 * T];
  const start = ballState(p0, v, w0);

  const fly = (vel: Vec3): Vec3 => {
    start.v.x = vel.x;
    start.v.y = vel.y;
    start.v.z = vel.z;
    const p = flyFree(start, T, pp, S_FLY).p;
    return vec3(p.x, p.y, p.z);
  };

  let p = fly(v);
  let e = vec3(target.x - p.x, target.y - p.y, target.z - p.z);
  let err = Math.hypot(e.x, e.y, e.z);
  let it = 0;
  for (; it < maxIter && err >= tol; it++) {
    const dv = solve3(J, e);
    if (!dv) break;
    const vNew = vec3(v.x + dv.x, v.y + dv.y, v.z + dv.z);
    const pNew = fly(vNew);
    const dp = vec3(pNew.x - p.x, pNew.y - p.y, pNew.z - p.z);
    // Broyden 更新：J += ((Δp − J Δv) Δvᵀ) / |Δv|²
    const jdv = vec3(
      J[0] * dv.x + J[1] * dv.y + J[2] * dv.z,
      J[3] * dv.x + J[4] * dv.y + J[5] * dv.z,
      J[6] * dv.x + J[7] * dv.y + J[8] * dv.z
    );
    const n2 = dv.x * dv.x + dv.y * dv.y + dv.z * dv.z;
    if (n2 > 1e-14) {
      const r = vec3(dp.x - jdv.x, dp.y - jdv.y, dp.z - jdv.z);
      J[0] += (r.x * dv.x) / n2;
      J[1] += (r.x * dv.y) / n2;
      J[2] += (r.x * dv.z) / n2;
      J[3] += (r.y * dv.x) / n2;
      J[4] += (r.y * dv.y) / n2;
      J[5] += (r.y * dv.z) / n2;
      J[6] += (r.z * dv.x) / n2;
      J[7] += (r.z * dv.y) / n2;
      J[8] += (r.z * dv.z) / n2;
    }
    v = vNew;
    p = pNew;
    e = vec3(target.x - p.x, target.y - p.y, target.z - p.z);
    err = Math.hypot(e.x, e.y, e.z);
  }
  return { ok: err < tol && Number.isFinite(err), v0: v, iterations: it, error: err };
}

// ------------------------------------------------------------------ 校验

export interface ShotCheck {
  /** 第一个碰撞事件 */
  first: BallEvent | null;
  /** 第二个碰撞事件（发球用） */
  second: BallEvent | null;
  /** 过网时球心比「刚好擦到网带」高多少（米）；没过网为 NaN */
  clearance: number;
  /** 飞行中最高点（台面以上，米） */
  apex: number;
}

/** 用完整碰撞仿真检查一个出手速度：落点、过网高度、顶点 */
export function checkShot(
  p0: Vec3,
  v0: Vec3,
  w0: Vec3,
  pp: PhysicsParams,
  maxEvents = 1,
  maxT = 2.5
): ShotCheck {
  const s = ballState(p0, v0, w0);
  const events: BallEvent[] = [];
  let clearance = NaN;
  let apex = s.p.z - TABLE.height;
  let prevY = s.p.y;
  let prevZ = s.p.z;
  const steps = Math.ceil(maxT / SIM_DT);
  for (let i = 0; i < steps && events.length < maxEvents; i++) {
    stepBall(s, SIM_DT, i * SIM_DT, pp, null, events);
    if (Number.isNaN(clearance) && Math.sign(prevY) !== Math.sign(s.p.y) && prevY !== 0) {
      const f = prevY / (prevY - s.p.y);
      const zCross = prevZ + (s.p.z - prevZ) * f;
      clearance = zCross - (NET.top + BALL.radius);
    }
    apex = Math.max(apex, s.p.z - TABLE.height);
    prevY = s.p.y;
    prevZ = s.p.z;
  }
  // 撞网没过去：用撞网时的高度算一个负的过网高度
  const netHit = events.find((e) => e.type === 'net');
  if (Number.isNaN(clearance) && netHit)
    clearance = Math.min(0, netHit.p.z - (NET.top + BALL.radius));
  return { first: events[0] ?? null, second: events[1] ?? null, clearance, apex };
}

// ------------------------------------------------------------------ 普通回球

export interface RallyShotRequest {
  /** 出手点 */
  p0: Vec3;
  /** 出手旋转（弧度/秒） */
  w0: Vec3;
  /** 目标落点（台面上的 x, y） */
  target: { x: number; y: number };
  /** 期望水平速度（米/秒） */
  speedH: number;
  /** 最低过网高度（米） */
  minClearance: number;
  /** 顶点上限（台面以上）；高球传 Infinity */
  maxApex: number;
  flightTimeFactor: number;
}

export interface RallyShotResult {
  v0: Vec3;
  ok: boolean;
  check: ShotCheck;
  attempts: number;
  /** 实际瞄准的落点（可能为了过网而加深） */
  target: { x: number; y: number };
  flightTime: number;
}

/**
 * 普通回球：先按速度定飞行时间 T0 解出手速度。
 * 过网太低：在 [T0, 4·T0] 里找「刚好够过网」的最短飞行时间（先倍增再二分），尽量保住原本的球速；
 * 还不行就把落点打深一点再试。顶点过高（非高球）时适当缩短时间。
 */
export function solveRallyShot(req: RallyShotRequest, pp: PhysicsParams): RallyShotResult {
  const target = { ...req.target };
  let attempts = 0;
  let best: RallyShotResult | null = null;

  const evaluate = (T: number, guess?: Vec3): RallyShotResult => {
    attempts++;
    const aim = vec3(target.x, target.y, TABLE_CONTACT_Z);
    const sol = solveTarget(req.p0, req.w0, aim, T, pp, { guess });
    const check = checkShot(req.p0, sol.v0, req.w0, pp);
    const landedRight =
      check.first?.type === 'table' && check.first.side === sideOfY(target.y) && !check.first.edge;
    const ok =
      sol.ok && landedRight && check.clearance >= req.minClearance && check.apex <= req.maxApex;
    const r: RallyShotResult = {
      v0: sol.v0,
      ok,
      check,
      attempts,
      target: { ...target },
      flightTime: T,
    };
    if (!best || ok || (sol.ok && check.clearance > best.check.clearance)) best = r;
    return r;
  };
  const clears = (r: RallyShotResult) => r.check.clearance >= req.minClearance;

  for (let deepen = 0; deepen < 3; deepen++) {
    const dist = Math.hypot(target.x - req.p0.x, target.y - req.p0.y);
    const T0 = (req.flightTimeFactor * dist) / Math.max(0.5, req.speedH);
    const first = evaluate(T0);
    if (first.ok) return first;

    if (!clears(first)) {
      // 倍增找到一个能过网的时间上界
      let lo = T0;
      let hi = T0;
      let hiRes: RallyShotResult | null = null;
      let guess = first.v0;
      while (hi < Math.min(4 * T0, 1.4)) {
        hi = Math.min(hi * 1.3, 1.4);
        const r = evaluate(hi, guess);
        guess = r.v0;
        if (clears(r)) {
          hiRes = r;
          break;
        }
        lo = hi;
      }
      if (hiRes) {
        // 二分：最短的能过网的飞行时间
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) / 2;
          const r = evaluate(mid, hiRes.v0);
          if (clears(r)) {
            hi = mid;
            hiRes = r;
          } else {
            lo = mid;
          }
        }
        if (hiRes.ok) return hiRes;
        // 过网了但顶点太高：只能接受（过网优先）
        if (clears(hiRes) && hiRes.check.first?.type === 'table') {
          if (hiRes.check.first.side === sideOfY(target.y)) return { ...hiRes, ok: true };
        }
      }
    } else if (first.check.apex > req.maxApex) {
      // 顶点太高：缩短时间
      let T = T0;
      for (let i = 0; i < 4; i++) {
        T *= 0.9;
        const r = evaluate(T, first.v0);
        if (r.ok) return r;
      }
    }
    // 打深一点再试
    target.y += Math.sign(target.y) * 0.15;
    target.y = clamp(target.y, -TABLE.halfLength + 0.08, TABLE.halfLength - 0.08);
  }
  return best!;
}

/** 按期望顶点（台面以上）算高球的飞行时间（弹道近似） */
export function flightTimeForApex(p0: Vec3, apexAboveTable: number): number {
  const apexZ = TABLE.height + apexAboveTable;
  const up = Math.max(0.02, apexZ - p0.z);
  const vz = Math.sqrt(2 * GRAVITY * up);
  const down = Math.max(0.02, apexZ - TABLE_CONTACT_Z);
  return vz / GRAVITY + Math.sqrt((2 * down) / GRAVITY);
}

/** 故意下网：瞄准网平面上低于网顶的一点 */
export function solveIntoNet(
  p0: Vec3,
  w0: Vec3,
  x: number,
  clearance: number,
  speedH: number,
  pp: PhysicsParams
): Vec3 {
  const aim = vec3(x, 0, NET.top + BALL.radius + clearance);
  const T = Math.max(0.08, Math.hypot(aim.x - p0.x, aim.y - p0.y) / Math.max(0.5, speedH));
  return solveTarget(p0, w0, aim, T, pp).v0;
}

// ------------------------------------------------------------------ 发球

interface PlaneHit {
  ok: boolean;
  state: BallState;
}

const S_A = ballState();
const S_B = ballState();

/** 自由飞行直到球心下落穿过台面接触平面（不判断是否在台面范围内） */
function flyToTablePlane(s0: BallState, pp: PhysicsParams, maxT = 2): PlaneHit {
  const s = cloneBall(s0);
  for (let i = 0; i < maxT / SIM_DT; i++) {
    rk4(s, SIM_DT, pp, S_A);
    if (s.p.z > TABLE_CONTACT_Z && S_A.p.z <= TABLE_CONTACT_Z && S_A.v.z < 0) {
      let lo = 0;
      let hi = SIM_DT;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        rk4(s, mid, pp, S_B);
        if (S_B.p.z > TABLE_CONTACT_Z) lo = mid;
        else hi = mid;
      }
      rk4(s, hi, pp, S_B);
      return { ok: true, state: cloneBall(S_B) };
    }
    s.p = { ...S_A.p };
    s.v = { ...S_A.v };
    s.w = { ...S_A.w };
  }
  return { ok: false, state: s };
}

export interface ServeRequest {
  p0: Vec3;
  w0: Vec3;
  /** 第一落点（发球方半台） */
  first: { x: number; y: number };
  /** 第二落点（接发球方半台） */
  second: { x: number; y: number };
  /** 期望水平速度（用于初值） */
  speedH: number;
  minClearance: number;
}

export interface ServeResult {
  ok: boolean;
  v0: Vec3;
  iterations: number;
  error: number;
  check: ShotCheck;
  /** 实际采用的两个落点（为了过网可能调整过） */
  first: { x: number; y: number };
  second: { x: number; y: number };
}

function serveResidual(req: ServeRequest, v: Vec3, pp: PhysicsParams): Vec3 | null {
  const a = flyToTablePlane(ballState(req.p0, v, req.w0), pp);
  if (!a.ok) return null;
  const s = a.state;
  const y1 = s.p.y;
  frictionBounce(
    s,
    vec3(0, 0, 1),
    pp.tableE0,
    pp.tableESlope,
    pp.tableEMin,
    pp.tableEMax,
    pp.tableMu
  );
  s.p.z = TABLE_CONTACT_Z + 1e-6;
  const b = flyToTablePlane(s, pp);
  if (!b.ok) return null;
  return vec3(y1 - req.first.y, b.state.p.x - req.second.x, b.state.p.y - req.second.y);
}

/**
 * 发球：求 v0，使球先落在 first.y，再落在 (second.x, second.y)。
 * 两个落点定了以后弧线高度也就定了，可能擦网：此时在附近换第一落点（以及把第二落点打深一点）重新求解。
 */
export function solveServe(req: ServeRequest, pp: PhysicsParams): ServeResult {
  const dir = Math.sign(req.second.y) || 1; // 接发球方在 y 的哪一侧
  const y1Lim = (y: number) => clamp(y, -dir * (TABLE.halfLength - 0.12), -dir * 0.25);
  const y1Offsets = [0, -0.1, 0.1, -0.2, 0.2, -0.3, 0.3, -0.45];
  const y2Offsets = [0, 0.15];
  let best: ServeResult | null = null;
  for (const d2 of y2Offsets) {
    const y2 = clamp(req.second.y + dir * d2, -(TABLE.halfLength - 0.1), TABLE.halfLength - 0.1);
    for (const d1 of y1Offsets) {
      // d1 < 0：第一落点离网更远（靠近发球方台端）
      const y1 =
        dir > 0
          ? Math.min(-0.25, Math.max(-(TABLE.halfLength - 0.12), req.first.y + d1))
          : y1Lim(req.first.y - d1);
      const r = solveServeOnce(
        { ...req, first: { x: req.first.x, y: y1 }, second: { x: req.second.x, y: y2 } },
        pp
      );
      if (r.ok) return r;
      if (!best || (r.error < 0.01 && !(r.check.clearance <= best.check.clearance))) best = r;
    }
  }
  return best!;
}

function solveServeOnce(req: ServeRequest, pp: PhysicsParams): ServeResult {
  // 初值：第一段按弹道打到第一落点（落点 x 取两点连线上）
  const frac = (req.first.y - req.p0.y) / (req.second.y - req.p0.y || 1);
  const x1 = req.p0.x + (req.second.x - req.p0.x) * clamp(frac, 0, 1);
  const T1 = Math.max(0.12, Math.abs(req.first.y - req.p0.y) / Math.max(1, req.speedH));
  let v = ballisticGuess(req.p0, vec3(x1, req.first.y, TABLE_CONTACT_Z), T1);
  let iterations = 0;
  let err = Infinity;
  const h = 0.01;
  for (; iterations < 12; iterations++) {
    const r = serveResidual(req, v, pp);
    if (!r) break;
    err = Math.hypot(r.x, r.y, r.z);
    if (err < 0.01) break;
    const cols: Vec3[] = [];
    let bad = false;
    for (const axis of ['x', 'y', 'z'] as const) {
      const vp = { ...v };
      vp[axis] += h;
      const rp = serveResidual(req, vp, pp);
      if (!rp) {
        bad = true;
        break;
      }
      cols.push(vec3((rp.x - r.x) / h, (rp.y - r.y) / h, (rp.z - r.z) / h));
    }
    if (bad) break;
    // J 的列是 ∂r/∂v_x, ∂r/∂v_y, ∂r/∂v_z
    const J = [
      cols[0].x,
      cols[1].x,
      cols[2].x,
      cols[0].y,
      cols[1].y,
      cols[2].y,
      cols[0].z,
      cols[1].z,
      cols[2].z,
    ];
    const step = solve3(J, vec3(-r.x, -r.y, -r.z));
    if (!step) break;
    // 限制单步幅度，避免跳到奇怪的解
    const len = Math.hypot(step.x, step.y, step.z);
    const k = len > 3 ? 3 / len : 1;
    v = vec3(v.x + step.x * k, v.y + step.y * k, v.z + step.z * k);
  }
  const check = checkShot(req.p0, v, req.w0, pp, 2);
  const serverSide: Side = sideOfY(req.first.y);
  const ok =
    err < 0.01 &&
    check.first?.type === 'table' &&
    check.first.side === serverSide &&
    check.second?.type === 'table' &&
    check.second.side !== serverSide &&
    !(check.clearance < req.minClearance);
  return { ok, v0: v, iterations, error: err, check, first: req.first, second: req.second };
}
