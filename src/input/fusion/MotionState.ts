/**
 * 体感状态：把带时间戳的 IMU 样本喂给姿态融合，输出游戏需要的量（弧度制、世界系）。
 * 世界系为融合坐标系：Z 向上，偏航任意（由上层的「回中」决定朝向）。
 */
import { clamp, DEG } from '@/core/math';
import { type Quat, quat, rotate } from '@/core/quat';
import { type Vec3, scale, vec3 } from '@/core/vec3';
import type { ImuSample } from '../types';
import { FlatStillCalibrator, type FlatStillStatus } from './FlatStillCalibrator';
import { CalibrationMode, GamepadMotion } from './GamepadMotion';

/**
 * 陀螺仪零点怎么学：
 *  - auto：GamepadMotion 自带的静止 + 传感器融合自动校准（手机、调试页）；
 *  - flat：只在「平放在桌上不动 2 秒」时学（Joy-Con 玩游戏时），其余时候用出厂零点或上次学到的值。
 */
export type GyroBiasMode = 'auto' | 'flat';

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
  /** flat 模式：平放检测与学到的零点（°/s，在送进融合之前扣掉） */
  private readonly flat = new FlatStillCalibrator();
  private flatBias = vec3();

  constructor(readonly biasMode: GyroBiasMode = 'auto') {
    this.gm.setCalibrationMode(
      biasMode === 'auto' ? CalibrationMode.Stillness | CalibrationMode.SensorFusion : 0
    );
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

    let gyroIn = s.gyro;
    if (this.biasMode === 'flat') {
      const learned = this.flat.add(s);
      if (learned) this.flatBias = learned;
      const b = this.flatBias;
      gyroIn = vec3(s.gyro.x - b.x, s.gyro.y - b.y, s.gyro.z - b.z);
    }
    this.gm.processMotion(gyroIn, s.accel, dt);
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
    f.steady =
      this.biasMode === 'flat'
        ? this.flat.status.phase === 'collecting'
        : this.gm.autoCalibrationIsSteady;
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
    return this.biasMode === 'flat' ? { ...this.flatBias } : this.gm.calibrationOffset;
  }

  /** flat 模式：平放检测的状态（练习页的「平放」步骤显示进度用） */
  get flatStatus(): FlatStillStatus {
    return this.flat.status;
  }

  /** flat 模式：最近一次学到零点时的样本时间（毫秒），没学过为 −∞ */
  get biasLearnedAt(): number {
    return this.flat.learnedAt;
  }

  get calibrationConfidence(): number {
    return this.gm.autoCalibrationConfidence;
  }
}
