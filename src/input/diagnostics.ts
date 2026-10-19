/**
 * M0 连接验证用的诊断工具（纯逻辑）：
 *  - AxisConsistencyCheck：慢慢转动手柄时，比较「加速度方向的变化」与「陀螺预测的变化」，
 *    在 8 种陀螺轴符号组合里找最吻合的；(+,+,+) 胜出说明两个传感器的坐标轴一致。
 *  - SixFaceCheck：手柄 6 个面分别朝上静止时的加速度模长（应为 1.00 ± 0.02 g）。
 *  - YawDriftCheck：静止时偏航角的漂移速度（度/分钟）。
 */
import { DEG, RAD } from '@/core/math';
import { type Quat, rotate } from '@/core/quat';
import { cross, length, type Vec3, vec3 } from '@/core/vec3';
import type { ImuSample } from './types';

const SIGNS: Array<[number, number, number]> = [];
for (let h = 0; h < 8; h++) SIGNS.push([h & 1 ? -1 : 1, h & 2 ? -1 : 1, h & 4 ? -1 : 1]);

export interface AxisCheckResult {
  ready: boolean;
  /** 0..1，转动量是否足够 */
  progress: number;
  bestSigns: [number, number, number];
  /** 陀螺与加速度计方向一致 */
  consistent: boolean;
  /** 最优假设误差 / 次优假设误差（越小越可信） */
  margin: number;
}

export class AxisConsistencyCheck {
  private err = new Float64Array(8);
  private prevUp: Vec3 | null = null;
  private prevT = 0;
  private used = 0;
  private rotation = 0;

  reset(): void {
    this.err.fill(0);
    this.prevUp = null;
    this.used = 0;
    this.rotation = 0;
  }

  add(s: ImuSample): void {
    const mag = length(s.accel);
    if (mag < 0.85 || mag > 1.15) {
      this.prevUp = null;
      return;
    }
    const u = vec3(s.accel.x / mag, s.accel.y / mag, s.accel.z / mag);
    const w = vec3(s.gyro.x * DEG, s.gyro.y * DEG, s.gyro.z * DEG);
    const wm = length(w);
    if (this.prevUp) {
      const dt = (s.t - this.prevT) / 1000;
      if (dt > 0 && dt < 0.02 && wm > 0.3 && wm < 4) {
        const meas = vec3(
          (u.x - this.prevUp.x) / dt,
          (u.y - this.prevUp.y) / dt,
          (u.z - this.prevUp.z) / dt
        );
        const mid = vec3(
          (u.x + this.prevUp.x) / 2,
          (u.y + this.prevUp.y) / 2,
          (u.z + this.prevUp.z) / 2
        );
        for (let h = 0; h < 8; h++) {
          const [sx, sy, sz] = SIGNS[h];
          // 重力在机体系里的变化率：du/dt = −ω × u
          const p = cross(vec3(sx * w.x, sy * w.y, sz * w.z), mid);
          const ex = meas.x + p.x;
          const ey = meas.y + p.y;
          const ez = meas.z + p.z;
          this.err[h] += ex * ex + ey * ey + ez * ez;
        }
        this.used++;
        this.rotation += wm * dt;
      }
    }
    this.prevUp = u;
    this.prevT = s.t;
  }

  result(): AxisCheckResult {
    let best = 0;
    for (let h = 1; h < 8; h++) if (this.err[h] < this.err[best]) best = h;
    let second = best === 0 ? 1 : 0;
    for (let h = 0; h < 8; h++) if (h !== best && this.err[h] < this.err[second]) second = h;
    const progress = Math.min(1, this.rotation / (4 * Math.PI));
    const margin = this.err[second] > 0 ? this.err[best] / this.err[second] : 1;
    const ready = progress >= 1 && this.used > 200;
    return {
      ready,
      progress,
      bestSigns: SIGNS[best],
      consistent: ready && best === 0 && margin < 0.5,
      margin,
    };
  }
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
