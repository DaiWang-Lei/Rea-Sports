/**
 * 体感状态：把带时间戳的 IMU 样本喂给姿态融合，输出游戏需要的量（弧度制、世界系）。
 * 世界系为融合坐标系：Z 向上，偏航任意（由上层的「回中」决定朝向）。
 */
import { clamp, DEG } from '@/core/math';
import { type Quat, quat, rotate } from '@/core/quat';
import { type Vec3, scale, vec3 } from '@/core/vec3';
import type { ImuSample } from '../types';
import { CalibrationMode, GamepadMotion } from './GamepadMotion';

export interface MotionFrame {
  /** 样本时间，毫秒 */
  t: number;
  /** 采样间隔，秒 */
  dt: number;
  /** 姿态：机体 → 世界 */
  q: Quat;
  /** 去零偏角速度，机体系，弧度/秒 */
  gyro: Vec3;
  /** 角速度，世界系，弧度/秒 */
  omegaWorld: Vec3;
  /** 原始加速度，机体系，g */
  accel: Vec3;
  /** 去掉重力的线加速度，世界系，g */
  linAccWorld: Vec3;
  clipped: boolean;
  /** 融合库判断为静止（用于自动校准） */
  steady: boolean;
}

function emptyFrame(): MotionFrame {
  return {
    t: 0,
    dt: 0.005,
    q: quat(),
    gyro: vec3(),
    omegaWorld: vec3(),
    accel: vec3(0, 0, 1),
    linAccWorld: vec3(),
    clipped: false,
    steady: false,
  };
}

export class MotionState {
  readonly gm = new GamepadMotion();
  frame: MotionFrame = emptyFrame();
  samples = 0;
  private lastT = NaN;
  private layFlatUntil = -Infinity;
  private layFlatActive = false;

  constructor() {
    this.gm.setCalibrationMode(CalibrationMode.Stillness | CalibrationMode.SensorFusion);
  }

  reset(): void {
    this.gm.resetMotion();
    this.gm.resetContinuousCalibration();
    this.frame = emptyFrame();
    this.samples = 0;
    this.lastT = NaN;
    this.layFlatActive = false;
  }

  process(s: ImuSample): MotionFrame {
    const dtMs = Number.isNaN(this.lastT) ? 5 : s.t - this.lastT;
    this.lastT = s.t;
    const dt = clamp(dtMs, 0.5, 50) / 1000;

    if (this.layFlatActive && s.t >= this.layFlatUntil) {
      this.gm.pauseContinuousCalibration();
      this.gm.setAutoCalibrationConfidence(1);
      this.layFlatActive = false;
    }

    this.gm.processMotion(s.gyro, s.accel, dt);
    const q = this.gm.orientation;
    const gyro = scale(this.gm.calibratedGyro, DEG);
    const f = this.frame;
    f.t = s.t;
    f.dt = dt;
    f.q = q;
    f.gyro = gyro;
    f.omegaWorld = rotate(q, gyro);
    f.accel = { x: s.accel.x, y: s.accel.y, z: s.accel.z };
    f.linAccWorld = rotate(q, this.gm.linearAccel);
    f.clipped = s.clipped;
    f.steady = this.gm.autoCalibrationIsSteady;
    this.samples++;
    return f;
  }

  /** 平放校准：之后 durationMs 内的样本取平均作为陀螺零偏，然后交回自动校准 */
  beginLayFlat(nowMs: number, durationMs = 2000): void {
    this.gm.resetContinuousCalibration();
    this.gm.startContinuousCalibration();
    this.layFlatActive = true;
    this.layFlatUntil = nowMs + durationMs;
  }

  get isLayFlatCalibrating(): boolean {
    return this.layFlatActive;
  }

  /** 当前陀螺零偏（度/秒） */
  get gyroBias(): Vec3 {
    return this.gm.calibrationOffset;
  }

  get calibrationConfidence(): number {
    return this.gm.autoCalibrationConfidence;
  }
}
