/**
 * M0 连接验证用的诊断工具（纯逻辑）：
 *  - AxisConsistencyCheck：陀螺仪和加速度计的坐标轴是否一致（换算有没有接错轴、接反符号）。
 *  - SixFaceCheck：手柄 6 个面分别朝上静止时的加速度模长（应为 1.00 ± 0.02 g）。
 *  - YawDriftCheck：静止时偏航角的漂移速度（度/分钟）。
 */
import { DEG, RAD } from '@/core/math';
import { type Quat, rotate } from '@/core/quat';
import { cross, length, type Vec3, vec3 } from '@/core/vec3';
import type { ImuSample } from './types';

/** 陀螺轴的一种接法：真实机体系 ω[j] = sign[j] · 读数[perm[j]] */
interface AxisMapping {
  perm: [number, number, number];
  sign: [number, number, number];
  label: string;
}

const AXIS_NAMES = ['X', 'Y', 'Z'];
const PERMS: Array<[number, number, number]> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
/** 48 种接法（6 种排列 × 8 种符号），第 0 个是「原样」 */
export const AXIS_MAPPINGS: AxisMapping[] = [];
for (const perm of PERMS) {
  for (let h = 0; h < 8; h++) {
    const sign: [number, number, number] = [h & 1 ? -1 : 1, h & 2 ? -1 : 1, h & 4 ? -1 : 1];
    const label = `(${perm.map((k, j) => (sign[j] > 0 ? '+' : '−') + AXIS_NAMES[k]).join(', ')})`;
    AXIS_MAPPINGS.push({ perm, sign, label });
  }
}

export interface AxisCheckResult {
  ready: boolean;
  /** 0..1，有效区间是否足够 */
  progress: number;
  /** 有效区间数（两次停稳之间转了足够角度） */
  intervals: number;
  /** 最吻合的接法，如 "(+X, +Y, +Z)"；含义：真实的 X、Y、Z 依次等于读数里的哪一轴 */
  best: string;
  /**
   * consistent：原样接法最吻合且误差小；inconsistent：另有一种接法明显更吻合（轴接错了）；
   * unclear：区间够了但看不出（多半是转动的方向太单一），继续收集
   */
  verdict: 'pending' | 'consistent' | 'inconsistent' | 'unclear';
  /** verdict === 'consistent' */
  consistent: boolean;
  /** 原样接法 / 最吻合接法的平均夹角误差（度） */
  errIdentity: number;
  errBest: number;
}

/**
 * 轴向一致性检查：设备在两次「停稳」之间转动时，用陀螺仪积分把上一次停稳时的重力方向推到这一次，
 * 和这一次加速度计实测的比夹角；对 48 种陀螺轴接法分别推算，接对了误差只有几度，接错了差几十度。
 * 停稳时加速度计只受重力，是可靠的参照；挥拍等剧烈动作期间只用陀螺积分，不受线加速度干扰。
 * 真机录制里 Joy-Con 原样接法平均误差约 7°；手机旧换算（alpha 当成绕 z）约 14–24°，改对后约 6°。
 */
export class AxisConsistencyCheck {
  /** 停稳：最近 STILL_MS 内 |ω| < STILL_W rad/s，且加速度模长接近 1g、波动小 */
  static readonly STILL_MS = 100;
  static readonly STILL_W = 0.6;
  /** 两次停稳之间至少转过这么多（度）才计入 */
  static readonly MIN_TURN = 30;
  /** 两次停稳之间最长间隔（秒），太长陀螺零偏会累积 */
  static readonly MAX_GAP = 6;
  /** 需要的有效区间数 */
  static readonly NEED = 6;

  private ups: Vec3[] = AXIS_MAPPINGS.map(() => vec3(0, 0, 1));
  private errSum = new Float64Array(AXIS_MAPPINGS.length);
  private n = 0;
  /** 上一次停稳之后是否在推算 */
  private active = false;
  private turned = 0;
  private movingFor = 0;
  private wasStill = false;
  private lastT = NaN;
  private win: Array<{ t: number; w: number; a: Vec3 }> = [];

  reset(): void {
    this.errSum.fill(0);
    this.n = 0;
    this.active = false;
    this.turned = 0;
    this.movingFor = 0;
    this.wasStill = false;
    this.lastT = NaN;
    this.win = [];
  }

  add(s: ImuSample): void {
    const dt = Number.isNaN(this.lastT) ? 0 : (s.t - this.lastT) / 1000;
    this.lastT = s.t;
    const g = [s.gyro.x * DEG, s.gyro.y * DEG, s.gyro.z * DEG];
    const w = Math.hypot(g[0], g[1], g[2]);

    // 推算：每种接法各自积分
    if (this.active && dt > 0 && dt < 0.1) {
      for (let c = 0; c < AXIS_MAPPINGS.length; c++) {
        const m = AXIS_MAPPINGS[c];
        const wc = vec3(
          m.sign[0] * g[m.perm[0]],
          m.sign[1] * g[m.perm[1]],
          m.sign[2] * g[m.perm[2]]
        );
        this.ups[c] = rotateFixed(this.ups[c], wc, dt);
      }
      this.turned += w * dt * RAD;
    }

    // 停稳判断（最近 STILL_MS 的窗口）
    this.win.push({ t: s.t, w, a: s.accel });
    while (this.win.length > 2 && s.t - this.win[0].t > AxisConsistencyCheck.STILL_MS) {
      this.win.shift();
    }
    const still = this.isStill(s.t);
    if (still) {
      const up = this.meanUp();
      if (!this.wasStill && this.active && this.turned >= AxisConsistencyCheck.MIN_TURN) {
        // 一个有效区间：比较各接法推算的「上」和实测的「上」
        for (let c = 0; c < AXIS_MAPPINGS.length; c++) {
          const d = Math.max(-1, Math.min(1, dot(this.ups[c], up)));
          this.errSum[c] += Math.min(60, Math.acos(d) * RAD);
        }
        this.n++;
      }
      // 停稳期间参照一直取最新实测
      for (let c = 0; c < AXIS_MAPPINGS.length; c++) this.ups[c] = up;
      this.active = true;
      this.turned = 0;
      this.movingFor = 0;
    } else if (this.active && dt > 0) {
      this.movingFor += dt;
      if (this.movingFor > AxisConsistencyCheck.MAX_GAP) this.active = false;
    }
    this.wasStill = still;
  }

  private isStill(now: number): boolean {
    const win = this.win;
    if (win.length < 3 || now - win[0].t < AxisConsistencyCheck.STILL_MS * 0.8) return false;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const e of win) {
      if (e.w >= AxisConsistencyCheck.STILL_W) return false;
      mx += e.a.x;
      my += e.a.y;
      mz += e.a.z;
    }
    const n = win.length;
    const mag = Math.hypot(mx, my, mz) / n;
    if (mag < 0.9 || mag > 1.1) return false;
    // 加速度波动（手在晃）
    let v = 0;
    for (const e of win) v += (e.a.x - mx / n) ** 2 + (e.a.y - my / n) ** 2 + (e.a.z - mz / n) ** 2;
    return Math.sqrt(v / n) < 0.06;
  }

  private meanUp(): Vec3 {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const e of this.win) {
      x += e.a.x;
      y += e.a.y;
      z += e.a.z;
    }
    const l = Math.hypot(x, y, z) || 1;
    return vec3(x / l, y / l, z / l);
  }

  result(): AxisCheckResult {
    const n = this.n;
    let best = 0;
    for (let c = 1; c < AXIS_MAPPINGS.length; c++) if (this.errSum[c] < this.errSum[best]) best = c;
    let second = best === 0 ? 1 : 0;
    for (let c = 0; c < AXIS_MAPPINGS.length; c++) {
      if (c !== best && this.errSum[c] < this.errSum[second]) second = c;
    }
    const errIdentity = n ? this.errSum[0] / n : NaN;
    const errBest = n ? this.errSum[best] / n : NaN;
    const errSecond = n ? this.errSum[second] / n : NaN;
    const ready = n >= AxisConsistencyCheck.NEED;
    let verdict: AxisCheckResult['verdict'] = 'pending';
    if (ready) {
      // 「一致」还要求明显好过第二名：转动方向太单一时几种接法会差不多，看不出
      const clear = errSecond >= Math.max(1.3 * errBest, errBest + 3);
      if (best === 0 && errIdentity < 12 && clear) verdict = 'consistent';
      else if (best !== 0 && errBest < 12 && errBest < 0.6 * errIdentity) verdict = 'inconsistent';
      else verdict = 'unclear';
    }
    return {
      ready,
      progress: Math.min(1, n / AxisConsistencyCheck.NEED),
      intervals: n,
      best: AXIS_MAPPINGS[best].label,
      verdict,
      consistent: verdict === 'consistent',
      errIdentity,
      errBest,
    };
  }
}

/** 机体系里一个固定在世界的方向，机体以角速度 w（rad/s）转动 dt 秒后的新坐标：v' = exp(−[w]× dt)·v */
function rotateFixed(v: Vec3, w: Vec3, dt: number): Vec3 {
  const wl = Math.hypot(w.x, w.y, w.z);
  const th = wl * dt;
  if (th < 1e-12) return v;
  const k = vec3(w.x / wl, w.y / wl, w.z / wl);
  const c = Math.cos(th);
  const s = -Math.sin(th);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return vec3(
    v.x * c + kv.x * s + k.x * kd,
    v.y * c + kv.y * s + k.y * kd,
    v.z * c + kv.z * s + k.z * kd
  );
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export type Face = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
export const FACES: Face[] = ['+Z', '-Z', '+X', '-X', '+Y', '-Y'];
export const FACE_LABELS: Record<Face, string> = {
  '+Z': '按键面朝上',
  '-Z': '按键面朝下',
  '+X': '肩键一端朝上',
  '-X': '肩键一端朝下',
  '+Y': '左侧朝上',
  '-Y': '右侧朝上',
};

/** 6 个面朝上静止时的 |a| */
export class SixFaceCheck {
  readonly cells: Record<Face, number | null> = {
    '+X': null,
    '-X': null,
    '+Y': null,
    '-Y': null,
    '+Z': null,
    '-Z': null,
  };
  private sum = vec3();
  private count = 0;
  private startT = 0;

  add(s: ImuSample): void {
    const still =
      Math.abs(s.gyro.x) < 3 && Math.abs(s.gyro.y) < 3 && Math.abs(s.gyro.z) < 3 && !s.clipped;
    if (!still) {
      this.count = 0;
      return;
    }
    if (this.count === 0) {
      this.sum = vec3();
      this.startT = s.t;
    }
    this.sum.x += s.accel.x;
    this.sum.y += s.accel.y;
    this.sum.z += s.accel.z;
    this.count++;
    if (s.t - this.startT >= 600 && this.count >= 60) {
      const m = vec3(this.sum.x / this.count, this.sum.y / this.count, this.sum.z / this.count);
      const ax = Math.abs(m.x);
      const ay = Math.abs(m.y);
      const az = Math.abs(m.z);
      const mag = length(m);
      // 必须明显是某一个面朝上（主轴分量占 95% 以上）
      const dom = Math.max(ax, ay, az);
      if (dom / mag > 0.95) {
        const face: Face =
          dom === ax
            ? m.x > 0
              ? '+X'
              : '-X'
            : dom === ay
              ? m.y > 0
                ? '+Y'
                : '-Y'
              : m.z > 0
                ? '+Z'
                : '-Z';
        this.cells[face] = mag;
      }
      this.count = 0;
    }
  }

  get done(): boolean {
    return FACES.every((f) => this.cells[f] !== null);
  }

  get allWithinTolerance(): boolean {
    return FACES.every((f) => this.cells[f] !== null && Math.abs(this.cells[f]! - 1) <= 0.02);
  }
}

/** 静止时的偏航漂移（度/分钟），用世界系里机体 X 轴的水平朝向变化来算 */
export class YawDriftCheck {
  private stillStart = 0;
  private startYaw = 0;
  private lastYaw = 0;
  private stillMs = 0;
  driftDegPerMin: number | null = null;

  add(t: number, q: Quat, omegaWorldMag: number): void {
    const fwd = rotate(q, vec3(1, 0, 0));
    const horizontal = Math.hypot(fwd.x, fwd.y);
    // 手柄竖直时 X 轴没有水平分量，改用 Z 轴
    const ref = horizontal > 0.3 ? fwd : rotate(q, vec3(0, 0, 1));
    const yaw = Math.atan2(ref.y, ref.x) * RAD;
    if (omegaWorldMag > 0.05) {
      this.stillMs = 0;
      return;
    }
    if (this.stillMs === 0) {
      this.stillStart = t;
      this.startYaw = yaw;
      this.lastYaw = yaw;
      this.stillMs = 1;
      return;
    }
    // 展开角度
    let d = yaw - this.lastYaw;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    this.lastYaw += d;
    this.stillMs = t - this.stillStart;
    if (this.stillMs >= 10000) {
      this.driftDegPerMin = Math.abs(this.lastYaw - this.startYaw) / (this.stillMs / 60000);
    }
  }

  get stillSeconds(): number {
    return this.stillMs / 1000;
  }
}
