/**
 * 乒乓球物理：重力 + 空气阻力 + 马格努斯力，RK4 积分（固定步长与仿真一致），
 * 碰撞：台面（含擦边/侧面）、球网（网带/网身）、地面，碰撞时刻用二分法精确定位，不会穿透。
 *
 * 台面反弹（Nakashima 2010 摩擦模型）：
 *   v_n = v·n（<0），v_t = v − v_n n，接触点滑移 u = v_t − r(ω × n)
 *   e = clamp(e0 − slope·|v_n|, emin, emax)
 *   α = min(2/5, μ(1+e)|v_n| / |u|)            （α = 2/5 即进入纯滚动）
 *   v⁺ = v_t − α u − e v_n n
 *   ω⁺ = ω + (3α / 2r)(n × u)                   （薄球壳 I = ⅔ m r²）
 * 马格努斯：a_M = K·C_L·|v|²·unit(ω × v)，C_L = S/(1+2S)，S = r|ω⊥|/|v|
 *   化简为 a_M = K·r·|v|·(ω × v) / (|v| + 2r|ω⊥|)，ω=0 时自然为 0。
 * 「上旋」：ω·(ẑ × d) > 0，d 为水平前进方向。
 */
import { type Rng } from '@/core/rng';
import { type Vec3, vec3 } from '@/core/vec3';
import type { Tuning } from '@/config/tuning';
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

export interface BallState {
  p: Vec3;
  v: Vec3;
  /** 角速度，弧度/秒 */
  w: Vec3;
}

export function ballState(p: Vec3 = vec3(), v: Vec3 = vec3(), w: Vec3 = vec3()): BallState {
  return { p: { ...p }, v: { ...v }, w: { ...w } };
}

export function copyBall(out: BallState, s: BallState): BallState {
  out.p.x = s.p.x;
  out.p.y = s.p.y;
  out.p.z = s.p.z;
  out.v.x = s.v.x;
  out.v.y = s.v.y;
  out.v.z = s.v.z;
  out.w.x = s.w.x;
  out.w.y = s.w.y;
  out.w.z = s.w.z;
  return out;
}

export function cloneBall(s: BallState): BallState {
  return copyBall(ballState(), s);
}

export type PhysicsParams = Tuning['physics'];

export type BallEventType = 'table' | 'side' | 'net' | 'floor';

export interface BallEvent {
  type: BallEventType;
  /** 事件发生时刻（秒，仿真时间） */
  t: number;
  p: Vec3;
  /** 台面事件：落在哪一侧的半台；是否擦边 */
  side?: Side;
  edge?: boolean;
  /** 网事件：网带还是网身 */
  part?: 'cord' | 'body';
  /** 撞击法向速度大小（用于音量） */
  impact: number;
}

// ------------------------------------------------------------------ 受力与积分

const R = BALL.radius;

/** 计算加速度到 out（不分配内存） */
function accel(
  vx: number,
  vy: number,
  vz: number,
  wx: number,
  wy: number,
  wz: number,
  pp: PhysicsParams,
  out: Float64Array
): void {
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  let ax = -pp.dragK * speed * vx;
  let ay = -pp.dragK * speed * vy;
  let az = -pp.dragK * speed * vz - GRAVITY;
  if (speed > 1e-6) {
    // c = ω × v
    const cx = wy * vz - wz * vy;
    const cy = wz * vx - wx * vz;
    const cz = wx * vy - wy * vx;
    const cLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (cLen > 0) {
      const wPerp = cLen / speed;
      const k = (pp.magnusK * R * speed) / (speed + 2 * R * wPerp);
      ax += k * cx;
      ay += k * cy;
      az += k * cz;
    }
  }
  out[0] = ax;
  out[1] = ay;
  out[2] = az;
}

const A1 = new Float64Array(3);
const A2 = new Float64Array(3);
const A3 = new Float64Array(3);
const A4 = new Float64Array(3);

/** RK4 积分 dt 秒，结果写入 out（out 可以与 s 相同） */
export function rk4(s: BallState, dt: number, pp: PhysicsParams, out: BallState): BallState {
  const { x: px, y: py, z: pz } = s.p;
  const { x: vx, y: vy, z: vz } = s.v;
  const { x: wx, y: wy, z: wz } = s.w;
  const h = dt / 2;
  // 旋转按指数衰减（与平动解耦）
  const dHalf = Math.exp(-pp.spinDecay * h);
  const dFull = Math.exp(-pp.spinDecay * dt);

  accel(vx, vy, vz, wx, wy, wz, pp, A1);
  const v2x = vx + A1[0] * h;
  const v2y = vy + A1[1] * h;
  const v2z = vz + A1[2] * h;
  accel(v2x, v2y, v2z, wx * dHalf, wy * dHalf, wz * dHalf, pp, A2);
  const v3x = vx + A2[0] * h;
  const v3y = vy + A2[1] * h;
  const v3z = vz + A2[2] * h;
  accel(v3x, v3y, v3z, wx * dHalf, wy * dHalf, wz * dHalf, pp, A3);
  const v4x = vx + A3[0] * dt;
  const v4y = vy + A3[1] * dt;
  const v4z = vz + A3[2] * dt;
  accel(v4x, v4y, v4z, wx * dFull, wy * dFull, wz * dFull, pp, A4);

  const k = dt / 6;
  out.p.x = px + k * (vx + 2 * v2x + 2 * v3x + v4x);
  out.p.y = py + k * (vy + 2 * v2y + 2 * v3y + v4y);
  out.p.z = pz + k * (vz + 2 * v2z + 2 * v3z + v4z);
  out.v.x = vx + k * (A1[0] + 2 * A2[0] + 2 * A3[0] + A4[0]);
  out.v.y = vy + k * (A1[1] + 2 * A2[1] + 2 * A3[1] + A4[1]);
  out.v.z = vz + k * (A1[2] + 2 * A2[2] + 2 * A3[2] + A4[2]);
  out.w.x = wx * dFull;
  out.w.y = wy * dFull;
  out.w.z = wz * dFull;
  return out;
}

/** 无碰撞飞行 T 秒（与仿真同一步长网格：整步 + 最后一个零头步）。求解器用。 */
export function flyFree(
  s: BallState,
  T: number,
  pp: PhysicsParams,
  out: BallState = ballState()
): BallState {
  copyBall(out, s);
  let remaining = T;
  while (remaining > SIM_DT + 1e-12) {
    rk4(out, SIM_DT, pp, out);
    remaining -= SIM_DT;
  }
  if (remaining > 1e-12) rk4(out, remaining, pp, out);
  return out;
}

// ------------------------------------------------------------------ 碰撞检测

const HW = TABLE.halfWidth;
const HL = TABLE.halfLength;
const TOP = TABLE.height;
const BOTTOM = TABLE.height - TABLE.thickness;
const CORD_Z = NET.top - NET.cordRadius;

/** 球心到台面板（长方体）的最近点；返回距离 */
function tableBoxClosest(p: Vec3, out: Vec3): number {
  out.x = Math.max(-HW, Math.min(HW, p.x));
  out.y = Math.max(-HL, Math.min(HL, p.y));
  out.z = Math.max(BOTTOM, Math.min(TOP, p.z));
  const dx = p.x - out.x;
  const dy = p.y - out.y;
  const dz = p.z - out.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 最近点是否在台面上表面的内部（这种情况由「台面平面穿越」处理） */
function isTopInterior(q: Vec3): boolean {
  return q.z === TOP && Math.abs(q.x) < HW && Math.abs(q.y) < HL;
}

/** 球心到球网（网身 + 网带）的距离；不在网的 x 范围内返回 Infinity */
function netDistance(p: Vec3): number {
  if (Math.abs(p.x) > NET.halfSpan) return Infinity;
  if (p.z >= CORD_Z) {
    const dz = p.z - CORD_Z;
    return Math.sqrt(p.y * p.y + dz * dz) - NET.cordRadius;
  }
  if (p.z >= TOP) return Math.abs(p.y) - NET.halfThickness;
  return Infinity;
}

type HitKind = 'top' | 'box' | 'net' | 'floor';

const TMP_Q = vec3();
const S_MID = ballState();

/** 某个时刻的状态是否已经「接触」 */
function touching(kind: HitKind, s: BallState): boolean {
  switch (kind) {
    case 'top':
      return s.p.z <= TABLE_CONTACT_Z && Math.abs(s.p.x) <= HW && Math.abs(s.p.y) <= HL;
    case 'box':
      return tableBoxClosest(s.p, TMP_Q) <= R && !isTopInterior(TMP_Q);
    case 'net':
      return netDistance(s.p) <= R;
    case 'floor':
      return s.p.z <= R;
  }
}

/** 接触时球是否正在靠近（离开中的接触不算碰撞，避免重复触发） */
function approaching(kind: HitKind, s: BallState): boolean {
  switch (kind) {
    case 'top':
    case 'floor':
      return s.v.z < 0;
    case 'box': {
      const d = tableBoxClosest(s.p, TMP_Q);
      if (d < 1e-9) return true;
      return (
        (s.v.x * (s.p.x - TMP_Q.x) + s.v.y * (s.p.y - TMP_Q.y) + s.v.z * (s.p.z - TMP_Q.z)) / d < 0
      );
    }
    case 'net': {
      if (s.p.z >= CORD_Z) {
        return s.v.y * s.p.y + s.v.z * (s.p.z - CORD_Z) < 0;
      }
      return s.v.y * s.p.y < 0;
    }
  }
}

/**
 * 在 s0 →（dt 秒）→ s1 这一段里找第一次接触的时间比例 f ∈ [0, 1]；没有接触返回 −1。
 * 先用便宜的方法确定一个「肯定已接触」的上界，再用 RK4 局部步二分。
 */
function firstContact(
  kind: HitKind,
  s0: BallState,
  s1: BallState,
  dt: number,
  pp: PhysicsParams
): number {
  let upper = -1;
  switch (kind) {
    case 'top': {
      if (!(s0.p.z > TABLE_CONTACT_Z && s1.p.z <= TABLE_CONTACT_Z)) return -1;
      const f = (s0.p.z - TABLE_CONTACT_Z) / (s0.p.z - s1.p.z);
      const x = s0.p.x + (s1.p.x - s0.p.x) * f;
      const y = s0.p.y + (s1.p.y - s0.p.y) * f;
      if (Math.abs(x) > HW || Math.abs(y) > HL) return -1;
      upper = 1;
      break;
    }
    case 'floor':
      if (!(s0.p.z > R && s1.p.z <= R)) return -1;
      upper = 1;
      break;
    case 'box': {
      // 粗筛：离台子远就不必细查
      const stepLen = Math.hypot(s1.p.x - s0.p.x, s1.p.y - s0.p.y, s1.p.z - s0.p.z);
      if (tableBoxClosest(s0.p, TMP_Q) > R + stepLen + 0.005) return -1;
      for (const f of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]) {
        rk4(s0, dt * f, pp, S_MID);
        if (touching('box', S_MID)) {
          upper = f;
          break;
        }
      }
      if (upper < 0) return -1;
      break;
    }
    case 'net': {
      if (touching('net', s1)) {
        upper = 1;
      } else if (Math.sign(s0.p.y) !== Math.sign(s1.p.y) && s0.p.y !== 0) {
        // 一步之内穿过了网平面：二分找到穿越时刻，看那时是否在网的范围内
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          rk4(s0, dt * mid, pp, S_MID);
          if (Math.sign(S_MID.p.y) === Math.sign(s0.p.y)) lo = mid;
          else hi = mid;
        }
        rk4(s0, dt * hi, pp, S_MID);
        if (!touching('net', S_MID)) return -1;
        upper = hi;
      } else {
        return -1;
      }
      break;
    }
  }
  if (touching(kind, s0)) return approaching(kind, s0) ? 0 : -1;
  let lo = 0;
  let hi = upper;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    rk4(s0, dt * mid, pp, S_MID);
    if (touching(kind, S_MID)) hi = mid;
    else lo = mid;
  }
  rk4(s0, dt * hi, pp, S_MID);
  return approaching(kind, S_MID) ? hi : -1;
}

// ------------------------------------------------------------------ 碰撞响应

export function frictionBounce(
  s: BallState,
  n: Vec3,
  e0: number,
  slope: number,
  eMin: number,
  eMax: number,
  mu: number
): number {
  const v = s.v;
  const w = s.w;
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  if (vn >= 0) return 0;
  const vtx = v.x - vn * n.x;
  const vty = v.y - vn * n.y;
  const vtz = v.z - vn * n.z;
  // ω × n
  const cx = w.y * n.z - w.z * n.y;
  const cy = w.z * n.x - w.x * n.z;
  const cz = w.x * n.y - w.y * n.x;
  const ux = vtx - R * cx;
  const uy = vty - R * cy;
  const uz = vtz - R * cz;
  const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const e = Math.max(eMin, Math.min(eMax, e0 - slope * Math.abs(vn)));
  const alpha = uLen < 1e-9 ? 0 : Math.min(0.4, (mu * (1 + e) * Math.abs(vn)) / uLen);
  v.x = vtx - alpha * ux - e * vn * n.x;
  v.y = vty - alpha * uy - e * vn * n.y;
  v.z = vtz - alpha * uz - e * vn * n.z;
  // ω += (3α / 2r)(n × u)
  const k = (3 * alpha) / (2 * R);
  w.x += k * (n.y * uz - n.z * uy);
  w.y += k * (n.z * ux - n.x * uz);
  w.z += k * (n.x * uy - n.y * ux);
  return -vn;
}

function jitterNormal(n: Vec3, deg: number, rng: Rng | null): Vec3 {
  if (!rng || deg <= 0) return n;
  const a = (deg * Math.PI) / 180;
  const j = vec3(n.x + rng.uniform(-a, a), n.y + rng.uniform(-a, a), n.z + rng.uniform(-a, a));
  const len = Math.hypot(j.x, j.y, j.z);
  return vec3(j.x / len, j.y / len, j.z / len);
}

function respond(
  kind: HitKind,
  s: BallState,
  t: number,
  pp: PhysicsParams,
  rng: Rng | null
): BallEvent {
  const p = { ...s.p };
  switch (kind) {
    case 'top': {
      s.p.z = TABLE_CONTACT_Z;
      const impact = frictionBounce(
        s,
        vec3(0, 0, 1),
        pp.tableE0,
        pp.tableESlope,
        pp.tableEMin,
        pp.tableEMax,
        pp.tableMu
      );
      return { type: 'table', t, p, side: sideOfY(p.y), edge: false, impact };
    }
    case 'box': {
      const q = vec3();
      const d = tableBoxClosest(s.p, q);
      const n0 =
        d > 1e-9
          ? vec3((s.p.x - q.x) / d, (s.p.y - q.y) / d, (s.p.z - q.z) / d)
          : vec3(0, Math.sign(s.p.y) || 1, 0);
      if (n0.z >= pp.edgeMinNormalZ) {
        const n = jitterNormal(n0, pp.edgeJitterDeg, rng);
        const impact = frictionBounce(s, n, pp.edgeE, 0, 0, 1, pp.edgeMu);
        return { type: 'table', t, p, side: sideOfY(q.y), edge: true, impact };
      }
      const vn = s.v.x * n0.x + s.v.y * n0.y + s.v.z * n0.z;
      if (vn < 0) {
        const k = (1 + pp.sideE) * vn;
        s.v.x -= k * n0.x;
        s.v.y -= k * n0.y;
        s.v.z -= k * n0.z;
      }
      return { type: 'side', t, p, side: sideOfY(q.y), impact: Math.abs(vn) };
    }
    case 'net': {
      const isCord = s.p.z >= CORD_Z;
      if (isCord) {
        const dz = s.p.z - CORD_Z;
        const len = Math.hypot(s.p.y, dz) || 1;
        const n = jitterNormal(vec3(0, s.p.y / len, dz / len), pp.netCordJitterDeg, rng);
        const vn = s.v.x * n.x + s.v.y * n.y + s.v.z * n.z;
        if (vn < 0) {
          const tx = s.v.x - vn * n.x;
          const ty = s.v.y - vn * n.y;
          const tz = s.v.z - vn * n.z;
          s.v.x = tx * pp.netCordTangential - pp.netCordE * vn * n.x;
          s.v.y = ty * pp.netCordTangential - pp.netCordE * vn * n.y;
          s.v.z = tz * pp.netCordTangential - pp.netCordE * vn * n.z;
        }
        s.w.x *= pp.netCordSpin;
        s.w.y *= pp.netCordSpin;
        s.w.z *= pp.netCordSpin;
        return { type: 'net', t, p, part: 'cord', impact: Math.abs(vn) };
      }
      const impact = Math.abs(s.v.y);
      // 网身：几乎吃掉前进速度，球掉在击球方一侧
      const sideSign = Math.sign(s.p.y) || -Math.sign(s.v.y) || 1;
      s.p.y = sideSign * (R + NET.halfThickness + 1e-4);
      s.v.y = -pp.netBodyE * s.v.y;
      s.v.x *= pp.netBodyDamp;
      s.v.z *= pp.netBodyDamp;
      s.w.x *= pp.netBodySpin;
      s.w.y *= pp.netBodySpin;
      s.w.z *= pp.netBodySpin;
      return { type: 'net', t, p, part: 'body', impact };
    }
    case 'floor': {
      s.p.z = R;
      const impact = frictionBounce(s, vec3(0, 0, 1), pp.floorE, 0, 0, 1, pp.floorMu);
      return { type: 'floor', t, p, impact };
    }
  }
}

const KINDS: HitKind[] = ['top', 'box', 'net', 'floor'];
const S_TRY = ballState();
const S_LO = ballState();

/**
 * 推进 dt 秒并处理碰撞。事件追加到 events。rng 为 null 时不加随机扰动（用于预测）。
 * 返回推进后的状态（就地修改 s）。
 */
export function stepBall(
  s: BallState,
  dt: number,
  t0: number,
  pp: PhysicsParams,
  rng: Rng | null,
  events: BallEvent[]
): BallState {
  let remaining = dt;
  let t = t0;
  for (let contacts = 0; contacts < 4 && remaining > 1e-9; contacts++) {
    rk4(s, remaining, pp, S_TRY);
    let bestKind: HitKind | null = null;
    let bestF = 2;
    for (const kind of KINDS) {
      const f = firstContact(kind, s, S_TRY, remaining, pp);
      if (f >= 0 && f < bestF) {
        bestF = f;
        bestKind = kind;
      }
    }
    if (!bestKind) {
      copyBall(s, S_TRY);
      return s;
    }
    const used = remaining * bestF;
    if (used > 0) {
      rk4(s, used, pp, S_LO);
      copyBall(s, S_LO);
    }
    t += used;
    remaining -= used;
    events.push(respond(bestKind, s, t, pp, rng));
  }
  if (remaining > 1e-9) rk4(s, remaining, pp, s);
  return s;
}

/** 预测：从当前状态向前模拟（无随机扰动），记录每个仿真步的状态与事件 */
export interface Prediction {
  /** 第 i 个元素是 t0 + i·SIM_DT 时刻的状态 */
  states: BallState[];
  events: BallEvent[];
  t0: number;
}

export function predict(
  s0: BallState,
  t0: number,
  horizon: number,
  pp: PhysicsParams,
  stopAfterEvents = Infinity
): Prediction {
  const s = cloneBall(s0);
  const states: BallState[] = [cloneBall(s)];
  const events: BallEvent[] = [];
  const steps = Math.ceil(horizon / SIM_DT);
  for (let i = 0; i < steps; i++) {
    stepBall(s, SIM_DT, t0 + i * SIM_DT, pp, null, events);
    states.push(cloneBall(s));
    if (events.length >= stopAfterEvents) break;
    if (s.p.z < -1 || Math.abs(s.p.y) > 12) break;
  }
  return { states, events, t0 };
}

/** 球是否在台面以上的空间里（用于规则判断） */
export function isOverTable(p: Vec3): boolean {
  return Math.abs(p.x) <= HW && Math.abs(p.y) <= HL && p.z >= TOP;
}
