/**
 * TypeScript 移植：GamepadMotionHelpers（Version 10）
 * Copyright (c) 2020-2023 Julian "Jibb" Smart — MIT License（全文见仓库 NOTICE）
 * https://github.com/JibbSmart/GamepadMotionHelpers
 *
 * 与原版的差异：
 *  - 世界坐标系改为 Z 轴向上（原版 Y 轴向上），即「下」= (0, 0, −1)；
 *  - 用 TypeScript 的 number（双精度）；
 *  - 只移植了本项目用到的部分（陀螺零偏自动校准、重力校正姿态、线加速度）。
 * 单位：陀螺 度/秒，加速度 g。
 */
import {
  conjugate,
  fromAxisAngle,
  identity,
  multiply,
  normalizeQ,
  type Quat,
  quat,
  rotate,
} from '@/core/quat';
import type { Vec3 } from '@/core/vec3';

class V {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0
  ) {}
  static of(a: Vec3): V {
    return new V(a.x, a.y, a.z);
  }
  static splat(v: number): V {
    return new V(v, v, v);
  }
  clone(): V {
    return new V(this.x, this.y, this.z);
  }
  add(o: V): V {
    return new V(this.x + o.x, this.y + o.y, this.z + o.z);
  }
  sub(o: V): V {
    return new V(this.x - o.x, this.y - o.y, this.z - o.z);
  }
  mul(s: number): V {
    return new V(this.x * s, this.y * s, this.z * s);
  }
  div(s: number): V {
    return new V(this.x / s, this.y / s, this.z / s);
  }
  neg(): V {
    return new V(-this.x, -this.y, -this.z);
  }
  dot(o: V): number {
    return this.x * o.x + this.y * o.y + this.z * o.z;
  }
  cross(o: V): V {
    return new V(
      this.y * o.z - this.z * o.y,
      this.z * o.x - this.x * o.z,
      this.x * o.y - this.y * o.x
    );
  }
  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  normalized(): V {
    const len = this.length();
    return len === 0 ? this.clone() : this.div(len);
  }
  min(o: V): V {
    return new V(Math.min(this.x, o.x), Math.min(this.y, o.y), Math.min(this.z, o.z));
  }
  max(o: V): V {
    return new V(Math.max(this.x, o.x), Math.max(this.y, o.y), Math.max(this.z, o.z));
  }
  abs(): V {
    return new V(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z));
  }
  /** this + (o − this)·t */
  lerp(o: V, t: number): V {
    return new V(
      this.x + (o.x - this.x) * t,
      this.y + (o.y - this.y) * t,
      this.z + (o.z - this.z) * t
    );
  }
  lerpV(o: V, t: V): V {
    return new V(
      this.x + (o.x - this.x) * t.x,
      this.y + (o.y - this.y) * t.y,
      this.z + (o.z - this.z) * t.z
    );
  }
  isZero(): boolean {
    return this.x === 0 && this.y === 0 && this.z === 0;
  }
  rotatedBy(q: Quat): V {
    const r = rotate(q, this);
    return new V(r.x, r.y, r.z);
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const exp2 = (v: number) => Math.pow(2, v);
const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;
const WORLD_DOWN = new V(0, 0, -1);

function angleAxis(angle: number, axis: V): Quat {
  return fromAxisAngle(axis.x, axis.y, axis.z, angle);
}

export interface GamepadMotionSettings {
  minStillnessSamples: number;
  minStillnessCollectionTime: number;
  minStillnessCorrectionTime: number;
  maxStillnessError: number;
  stillnessSampleDeteriorationRate: number;
  stillnessErrorClimbRate: number;
  stillnessErrorDropOnRecalibrate: number;
  stillnessCalibrationEaseInTime: number;
  stillnessCalibrationHalfTime: number;
  stillnessConfidenceRate: number;
  stillnessGyroDelta: number;
  stillnessAccelDelta: number;
  sensorFusionCalibrationSmoothingStrength: number;
  sensorFusionAngularAccelerationThreshold: number;
  sensorFusionCalibrationEaseInTime: number;
  sensorFusionCalibrationHalfTime: number;
  sensorFusionConfidenceRate: number;
  gravityCorrectionShakinessMaxThreshold: number;
  gravityCorrectionShakinessMinThreshold: number;
  gravityCorrectionStillSpeed: number;
  gravityCorrectionShakySpeed: number;
  gravityCorrectionGyroFactor: number;
  gravityCorrectionGyroMinThreshold: number;
  gravityCorrectionGyroMaxThreshold: number;
  gravityCorrectionMinimumSpeed: number;
}

export function defaultMotionSettings(): GamepadMotionSettings {
  return {
    minStillnessSamples: 10,
    minStillnessCollectionTime: 0.5,
    minStillnessCorrectionTime: 2,
    maxStillnessError: 2,
    stillnessSampleDeteriorationRate: 0.2,
    stillnessErrorClimbRate: 0.1,
    stillnessErrorDropOnRecalibrate: 0.1,
    stillnessCalibrationEaseInTime: 3,
    stillnessCalibrationHalfTime: 0.1,
    stillnessConfidenceRate: 1,
    stillnessGyroDelta: -1,
    stillnessAccelDelta: -1,
    sensorFusionCalibrationSmoothingStrength: 2,
    sensorFusionAngularAccelerationThreshold: 20,
    sensorFusionCalibrationEaseInTime: 3,
    sensorFusionCalibrationHalfTime: 0.1,
    sensorFusionConfidenceRate: 1,
    gravityCorrectionShakinessMaxThreshold: 0.4,
    gravityCorrectionShakinessMinThreshold: 0.01,
    gravityCorrectionStillSpeed: 1,
    gravityCorrectionShakySpeed: 0.1,
    gravityCorrectionGyroFactor: 0.1,
    gravityCorrectionGyroMinThreshold: 0.05,
    gravityCorrectionGyroMaxThreshold: 0.25,
    gravityCorrectionMinimumSpeed: 0.01,
  };
}

/** 陀螺零偏的累计值（X/Y/Z 与 AccelMagnitude 均为「总和」，除以 numSamples 得均值） */
interface GyroCalibration {
  x: number;
  y: number;
  z: number;
  accelMagnitude: number;
  numSamples: number;
}

export const CalibrationMode = {
  Manual: 0,
  Stillness: 1,
  SensorFusion: 2,
} as const;

class SensorMinMaxWindow {
  minGyro = new V();
  maxGyro = new V();
  meanGyro = new V();
  minAccel = new V();
  maxAccel = new V();
  meanAccel = new V();
  startAccel = new V();
  numSamples = 0;
  timeSampled = 0;

  reset(remainder: number): void {
    this.numSamples = 0;
    this.timeSampled = remainder;
  }

  addSample(gyro: V, accel: V, dt: number): void {
    if (this.numSamples === 0) {
      this.maxGyro = gyro.clone();
      this.minGyro = gyro.clone();
      this.meanGyro = gyro.clone();
      this.maxAccel = accel.clone();
      this.minAccel = accel.clone();
      this.meanAccel = accel.clone();
      this.startAccel = accel.clone();
      this.numSamples = 1;
      this.timeSampled += dt;
      return;
    }
    this.maxGyro = this.maxGyro.max(gyro);
    this.minGyro = this.minGyro.min(gyro);
    this.maxAccel = this.maxAccel.max(accel);
    this.minAccel = this.minAccel.min(accel);
    this.numSamples++;
    this.timeSampled += dt;
    this.meanGyro = this.meanGyro.add(gyro.sub(this.meanGyro).mul(1 / this.numSamples));
    this.meanAccel = this.meanAccel.add(accel.sub(this.meanAccel).mul(1 / this.numSamples));
  }

  getMidGyro(): V {
    return this.meanGyro;
  }
}

class AutoCalibration {
  minMaxWindow = new SensorMinMaxWindow();
  smoothedAngularVelocityGyro = new V();
  smoothedAngularVelocityAccel = new V();
  smoothedPreviousAccel = new V();
  previousAccel = new V();
  confidence = 0;
  isSteady = false;

  private minDeltaGyro = V.splat(1);
  private minDeltaAccel = V.splat(0.25);
  private recalibrateThreshold = 1;
  private sensorFusionSkippedTime = 0;
  private timeSteadySensorFusion = 0;
  private timeSteadyStillness = 0;

  constructor(
    private readonly calibrationData: GyroCalibration,
    private readonly settings: GamepadMotionSettings
  ) {}

  reset(): void {
    this.minMaxWindow.reset(0);
    this.confidence = 0;
    this.isSteady = false;
    this.minDeltaGyro = V.splat(1);
    this.minDeltaAccel = V.splat(0.25);
    this.recalibrateThreshold = 1;
    this.sensorFusionSkippedTime = 0;
    this.timeSteadySensorFusion = 0;
    this.timeSteadyStillness = 0;
  }

  addSampleStillness(gyro: V, accel: V, dt: number, doSensorFusion: boolean): boolean {
    if (gyro.isZero() && accel.isZero()) return false;
    const s = this.settings;
    const cal = this.calibrationData;
    const stillnessCalibrationHalfTime = s.stillnessCalibrationHalfTime * this.confidence;

    this.minMaxWindow.addSample(gyro, accel, dt);
    const gyroDelta = this.minMaxWindow.maxGyro.sub(this.minMaxWindow.minGyro);
    const accelDelta = this.minMaxWindow.maxAccel.sub(this.minMaxWindow.minAccel);

    let calibrated = false;
    let isSteady = false;
    const climbThisTick = V.splat(s.stillnessSampleDeteriorationRate * dt);
    if (s.stillnessGyroDelta < 0) {
      if (this.confidence < 1) this.minDeltaGyro = this.minDeltaGyro.add(climbThisTick);
    } else {
      this.minDeltaGyro = V.splat(s.stillnessGyroDelta);
    }
    if (s.stillnessAccelDelta < 0) {
      if (this.confidence < 1) this.minDeltaAccel = this.minDeltaAccel.add(climbThisTick);
    } else {
      this.minDeltaAccel = V.splat(s.stillnessAccelDelta);
    }

    if (
      this.minMaxWindow.numSamples >= s.minStillnessSamples &&
      this.minMaxWindow.timeSampled >= s.minStillnessCollectionTime
    ) {
      this.minDeltaGyro = this.minDeltaGyro.min(gyroDelta);
      this.minDeltaAccel = this.minDeltaAccel.min(accelDelta);
    } else {
      this.recalibrateThreshold = Math.min(
        this.recalibrateThreshold + s.stillnessErrorClimbRate * dt,
        s.maxStillnessError
      );
      return false;
    }

    const th = this.recalibrateThreshold;
    if (
      gyroDelta.x <= this.minDeltaGyro.x * th &&
      gyroDelta.y <= this.minDeltaGyro.y * th &&
      gyroDelta.z <= this.minDeltaGyro.z * th &&
      accelDelta.x <= this.minDeltaAccel.x * th &&
      accelDelta.y <= this.minDeltaAccel.y * th &&
      accelDelta.z <= this.minDeltaAccel.z * th
    ) {
      if (
        this.minMaxWindow.numSamples >= s.minStillnessSamples &&
        this.minMaxWindow.timeSampled >= s.minStillnessCorrectionTime
      ) {
        this.timeSteadyStillness = Math.min(
          this.timeSteadyStillness + dt,
          s.stillnessCalibrationEaseInTime
        );
        const calibrationEaseIn =
          s.stillnessCalibrationEaseInTime <= 0
            ? 1
            : this.timeSteadyStillness / s.stillnessCalibrationEaseInTime;
        const calibratedGyro = this.minMaxWindow.getMidGyro();
        const oldGyroBias = new V(cal.x, cal.y, cal.z).div(Math.max(cal.numSamples, 1));
        const stillnessLerpFactor =
          stillnessCalibrationHalfTime <= 0
            ? 0
            : exp2((-calibrationEaseIn * dt) / stillnessCalibrationHalfTime);
        let newGyroBias = calibratedGyro.lerp(oldGyroBias, stillnessLerpFactor);
        this.confidence = Math.min(this.confidence + dt * s.stillnessConfidenceRate, 1);
        isSteady = true;

        if (doSensorFusion) {
          const previousNormal = this.minMaxWindow.startAccel.normalized();
          const thisNormal = accel.normalized();
          let angularVelocity = thisNormal.cross(previousNormal);
          const crossLength = angularVelocity.length();
          if (crossLength > 0) {
            const thisDotPrev = clamp(thisNormal.dot(previousNormal), -1, 1);
            const angleChange = Math.acos(thisDotPrev) * DEG_PER_RAD;
            const anglePerSecond = angleChange / this.minMaxWindow.timeSampled;
            angularVelocity = angularVelocity.mul(anglePerSecond / crossLength);
          }
          const axisCalibrationStrength = thisNormal.abs();
          const sensorFusionBias = calibratedGyro
            .sub(angularVelocity)
            .lerp(oldGyroBias, stillnessLerpFactor);
          newGyroBias = newGyroBias.clone();
          if (axisCalibrationStrength.x <= 0.7) newGyroBias.x = sensorFusionBias.x;
          if (axisCalibrationStrength.y <= 0.7) newGyroBias.y = sensorFusionBias.y;
          if (axisCalibrationStrength.z <= 0.7) newGyroBias.z = sensorFusionBias.z;
        }

        cal.x = newGyroBias.x;
        cal.y = newGyroBias.y;
        cal.z = newGyroBias.z;
        cal.accelMagnitude = this.minMaxWindow.meanAccel.length();
        cal.numSamples = 1;
        calibrated = true;
      } else {
        this.recalibrateThreshold = Math.min(
          this.recalibrateThreshold + s.stillnessErrorClimbRate * dt,
          s.maxStillnessError
        );
      }
    } else if (this.timeSteadyStillness > 0) {
      this.recalibrateThreshold -= s.stillnessErrorDropOnRecalibrate;
      if (this.recalibrateThreshold < 1) this.recalibrateThreshold = 1;
      this.timeSteadyStillness = 0;
      this.minMaxWindow.reset(0);
    } else {
      this.recalibrateThreshold = Math.min(
        this.recalibrateThreshold + s.stillnessErrorClimbRate * dt,
        s.maxStillnessError
      );
      this.minMaxWindow.reset(0);
    }

    this.isSteady = isSteady;
    return calibrated;
  }

  noSampleStillness(): void {
    this.minMaxWindow.reset(0);
  }

  addSampleSensorFusion(gyro: V, accel: V, dtIn: number): boolean {
    let dt = dtIn;
    if (dt <= 0) return false;
    if (gyro.isZero() && accel.isZero()) {
      this.timeSteadySensorFusion = 0;
      this.sensorFusionSkippedTime = 0;
      this.previousAccel = accel.clone();
      this.smoothedPreviousAccel = accel.clone();
      this.smoothedAngularVelocityGyro = new V();
      this.smoothedAngularVelocityAccel = new V();
      return false;
    }
    if (this.previousAccel.isZero()) {
      this.timeSteadySensorFusion = 0;
      this.sensorFusionSkippedTime = 0;
      this.previousAccel = accel.clone();
      this.smoothedPreviousAccel = accel.clone();
      this.smoothedAngularVelocityGyro = new V();
      this.smoothedAngularVelocityAccel = new V();
      return false;
    }
    if (
      accel.x === this.previousAccel.x &&
      accel.y === this.previousAccel.y &&
      accel.z === this.previousAccel.z
    ) {
      this.sensorFusionSkippedTime += dt;
      return false;
    }

    const s = this.settings;
    const cal = this.calibrationData;
    const sensorFusionCalibrationHalfTime = s.sensorFusionCalibrationHalfTime * this.confidence;

    dt += this.sensorFusionSkippedTime;
    this.sensorFusionSkippedTime = 0;
    let calibrated = false;
    let isSteady = false;

    const smoothingLerpFactor = exp2(-s.sensorFusionCalibrationSmoothingStrength * dt);
    const previousGyro = this.smoothedAngularVelocityGyro;
    this.smoothedAngularVelocityGyro = gyro.lerp(
      this.smoothedAngularVelocityGyro,
      smoothingLerpFactor
    );
    const gyroAccelerationMag = this.smoothedAngularVelocityGyro.sub(previousGyro).length() / dt;
    const previousNormal = this.smoothedPreviousAccel.normalized();
    const thisAccel = accel.lerp(this.smoothedPreviousAccel, smoothingLerpFactor);
    const thisNormal = thisAccel.normalized();
    let angularVelocity = thisNormal.cross(previousNormal);
    const crossLength = angularVelocity.length();
    if (crossLength > 0) {
      const thisDotPrev = clamp(thisNormal.dot(previousNormal), -1, 1);
      const angleChange = Math.acos(thisDotPrev) * DEG_PER_RAD;
      const anglePerSecond = angleChange / dt;
      angularVelocity = angularVelocity.mul(anglePerSecond / crossLength);
    }
    this.smoothedAngularVelocityAccel = angularVelocity;

    if (gyroAccelerationMag > s.sensorFusionAngularAccelerationThreshold) {
      this.timeSteadySensorFusion = 0;
    } else {
      this.timeSteadySensorFusion = Math.min(
        this.timeSteadySensorFusion + dt,
        s.sensorFusionCalibrationEaseInTime
      );
      const calibrationEaseIn =
        s.sensorFusionCalibrationEaseInTime <= 0
          ? 1
          : this.timeSteadySensorFusion / s.sensorFusionCalibrationEaseInTime;
      const oldGyroBias = new V(cal.x, cal.y, cal.z).div(Math.max(cal.numSamples, 1));
      const sensorFusionLerpFactor =
        sensorFusionCalibrationHalfTime <= 0
          ? 0
          : exp2((-calibrationEaseIn * dt) / sensorFusionCalibrationHalfTime);
      let newGyroBias = this.smoothedAngularVelocityGyro
        .sub(this.smoothedAngularVelocityAccel)
        .lerp(oldGyroBias, sensorFusionLerpFactor);
      this.confidence = Math.min(this.confidence + dt * s.sensorFusionConfidenceRate, 1);
      isSteady = true;
      const axisCalibrationStrength = thisNormal.abs();
      if (axisCalibrationStrength.x > 0.7) axisCalibrationStrength.x = 1;
      if (axisCalibrationStrength.y > 0.7) axisCalibrationStrength.y = 1;
      if (axisCalibrationStrength.z > 0.7) axisCalibrationStrength.z = 1;
      newGyroBias = newGyroBias.lerpV(oldGyroBias, axisCalibrationStrength.min(V.splat(1)));
      cal.x = newGyroBias.x;
      cal.y = newGyroBias.y;
      cal.z = newGyroBias.z;
      cal.accelMagnitude = thisAccel.length();
      cal.numSamples = 1;
      calibrated = true;
    }

    this.smoothedPreviousAccel = thisAccel;
    this.previousAccel = accel.clone();
    this.isSteady = isSteady;
    return calibrated;
  }

  noSampleSensorFusion(): void {
    this.timeSteadySensorFusion = 0;
    this.sensorFusionSkippedTime = 0;
    this.previousAccel = new V();
    this.smoothedPreviousAccel = new V();
    this.smoothedAngularVelocityGyro = new V();
    this.smoothedAngularVelocityAccel = new V();
  }
}

const SHORT_STEADINESS_HALF_TIME = 0.25;

class Motion {
  quaternion: Quat = quat();
  /** 去掉重力后的加速度（机体系，g） */
  accel = new V();
  /** 机体系下的重力向量（指向下方，模约为 1g） */
  grav = new V();
  smoothAccel = new V();
  shakiness = 0;

  constructor(private readonly settings: GamepadMotionSettings) {}

  reset(): void {
    identity(this.quaternion);
    this.accel = new V();
    this.grav = new V();
    this.smoothAccel = new V();
    this.shakiness = 0;
  }

  update(gyroIn: V, accelIn: V, gravityLength: number, dt: number): void {
    const s = this.settings;
    const axis = gyroIn;
    const accel = accelIn;
    const angleSpeed = axis.length() * RAD_PER_DEG;
    const angle = angleSpeed * dt;

    // 局部旋转：右乘
    const rotation = angleAxis(angle, axis);
    this.quaternion = multiply(this.quaternion, rotation);
    const rotationInv = conjugate(rotation);

    const accelMagnitude = accel.length();
    if (accelMagnitude > 0) {
      const accelNorm = accel.div(accelMagnitude);
      this.smoothAccel = this.smoothAccel.rotatedBy(rotationInv);
      const smoothFactor =
        SHORT_STEADINESS_HALF_TIME <= 0 ? 0 : exp2(-dt / SHORT_STEADINESS_HALF_TIME);
      this.shakiness *= smoothFactor;
      this.shakiness = Math.max(this.shakiness, accel.sub(this.smoothAccel).length());
      this.smoothAccel = accel.lerp(this.smoothAccel, smoothFactor);

      this.grav = this.grav.rotatedBy(rotationInv);
      const gravToAccel = accelNorm.mul(-gravityLength).sub(this.grav);
      const gravToAccelDir = gravToAccel.normalized();
      let gravCorrectionSpeed: number;
      if (s.gravityCorrectionShakinessMinThreshold < s.gravityCorrectionShakinessMaxThreshold) {
        gravCorrectionSpeed =
          s.gravityCorrectionStillSpeed +
          (s.gravityCorrectionShakySpeed - s.gravityCorrectionStillSpeed) *
            clamp(
              (this.shakiness - s.gravityCorrectionShakinessMinThreshold) /
                (s.gravityCorrectionShakinessMaxThreshold -
                  s.gravityCorrectionShakinessMinThreshold),
              0,
              1
            );
      } else {
        gravCorrectionSpeed =
          this.shakiness < s.gravityCorrectionShakinessMaxThreshold
            ? s.gravityCorrectionStillSpeed
            : s.gravityCorrectionShakySpeed;
      }
      const gyroGravCorrectionLimit = Math.max(
        angleSpeed * s.gravityCorrectionGyroFactor,
        s.gravityCorrectionMinimumSpeed
      );
      if (gravCorrectionSpeed > gyroGravCorrectionLimit) {
        let closeEnoughFactor: number;
        if (s.gravityCorrectionGyroMinThreshold < s.gravityCorrectionGyroMaxThreshold) {
          closeEnoughFactor = clamp(
            (gravToAccel.length() - s.gravityCorrectionGyroMinThreshold) /
              (s.gravityCorrectionGyroMaxThreshold - s.gravityCorrectionGyroMinThreshold),
            0,
            1
          );
        } else {
          closeEnoughFactor = gravToAccel.length() < s.gravityCorrectionGyroMaxThreshold ? 0 : 1;
        }
        gravCorrectionSpeed =
          gyroGravCorrectionLimit +
          (gravCorrectionSpeed - gyroGravCorrectionLimit) * closeEnoughFactor;
      }
      const gravToAccelDelta = gravToAccelDir.mul(gravCorrectionSpeed * dt);
      if (gravToAccelDelta.lengthSq() < gravToAccel.lengthSq()) {
        this.grav = this.grav.add(gravToAccelDelta);
      } else {
        this.grav = accelNorm.mul(-gravityLength);
      }

      // 让姿态里的「下」与估计出的重力方向对齐
      const gravityDirection = this.grav.normalized().rotatedBy(this.quaternion);
      const errorAngle = Math.acos(clamp(WORLD_DOWN.dot(gravityDirection), -1, 1));
      const flattened = gravityDirection.cross(WORLD_DOWN);
      const correction = angleAxis(errorAngle, flattened);
      this.quaternion = multiply(correction, this.quaternion);

      this.accel = accel.add(this.grav);
    } else {
      this.grav = this.grav.rotatedBy(rotationInv);
      this.accel = this.grav.clone();
    }
    this.quaternion = normalizeQ(this.quaternion);
  }
}

/**
 * 用法：每个 IMU 样本调用一次 processMotion(gyroDps, accelG, dtSeconds)，
 * 然后读 orientation（机体 → 世界，Z 向上）、calibratedGyro、gravity、linearAccel。
 */
export class GamepadMotion {
  readonly settings: GamepadMotionSettings;
  private gyro = new V();
  private rawAccel = new V();
  private readonly calibration: GyroCalibration = {
    x: 0,
    y: 0,
    z: 0,
    accelMagnitude: 0,
    numSamples: 0,
  };
  private readonly auto: AutoCalibration;
  private readonly motion: Motion;
  private calibrationMode: number = CalibrationMode.Stillness | CalibrationMode.SensorFusion;
  private isCalibrating = false;

  constructor(settings: Partial<GamepadMotionSettings> = {}) {
    this.settings = { ...defaultMotionSettings(), ...settings };
    this.auto = new AutoCalibration(this.calibration, this.settings);
    this.motion = new Motion(this.settings);
  }

  processMotion(gyroDps: Vec3, accelG: Vec3, dt: number): void {
    if (
      gyroDps.x === 0 &&
      gyroDps.y === 0 &&
      gyroDps.z === 0 &&
      accelG.x === 0 &&
      accelG.y === 0 &&
      accelG.z === 0
    ) {
      return;
    }
    const gyroIn = V.of(gyroDps);
    const accel = V.of(accelG);
    const accelMagnitude = accel.length();

    if (this.isCalibrating) {
      this.pushSensorSamples(gyroIn, accelMagnitude);
      this.auto.noSampleSensorFusion();
      this.auto.noSampleStillness();
    } else if (this.calibrationMode & CalibrationMode.Stillness) {
      this.auto.addSampleStillness(
        gyroIn,
        accel,
        dt,
        (this.calibrationMode & CalibrationMode.SensorFusion) !== 0
      );
      this.auto.noSampleSensorFusion();
    } else {
      this.auto.noSampleStillness();
      if (this.calibrationMode & CalibrationMode.SensorFusion) {
        this.auto.addSampleSensorFusion(gyroIn, accel, dt);
      } else {
        this.auto.noSampleSensorFusion();
      }
    }

    const { offset, accelMagnitude: gravityLength } = this.getCalibratedSensor();
    const gyro = gyroIn.sub(offset);
    this.motion.update(gyro, accel, gravityLength, dt);
    this.gyro = gyro;
    this.rawAccel = accel;
  }

  /** 去零偏后的角速度（机体系，度/秒） */
  get calibratedGyro(): Vec3 {
    return this.gyro.clone();
  }

  /** 机体系重力向量（指向下，约 1g） */
  get gravity(): Vec3 {
    return this.motion.grav.clone();
  }

  /** 去掉重力的线加速度（机体系，g） */
  get linearAccel(): Vec3 {
    return this.motion.accel.clone();
  }

  get rawAcceleration(): Vec3 {
    return this.rawAccel.clone();
  }

  /** 姿态（机体 → 世界，世界 Z 向上，偏航任意） */
  get orientation(): Quat {
    const q = this.motion.quaternion;
    return { w: q.w, x: q.x, y: q.y, z: q.z };
  }

  get shakiness(): number {
    return this.motion.shakiness;
  }

  get autoCalibrationConfidence(): number {
    return this.auto.confidence;
  }

  get autoCalibrationIsSteady(): boolean {
    return this.auto.isSteady;
  }

  get calibrationOffset(): Vec3 {
    return this.getCalibratedSensor().offset.clone();
  }

  setCalibrationOffset(offset: Vec3, weight: number): void {
    const c = this.calibration;
    if (c.numSamples > 1) c.accelMagnitude *= weight / c.numSamples;
    else c.accelMagnitude = weight;
    c.numSamples = weight;
    c.x = offset.x * weight;
    c.y = offset.y * weight;
    c.z = offset.z * weight;
  }

  /** 手动校准：开始累计（手柄需静止放好） */
  startContinuousCalibration(): void {
    this.isCalibrating = true;
  }

  pauseContinuousCalibration(): void {
    this.isCalibrating = false;
  }

  resetContinuousCalibration(): void {
    this.calibration.x = 0;
    this.calibration.y = 0;
    this.calibration.z = 0;
    this.calibration.accelMagnitude = 0;
    this.calibration.numSamples = 0;
    this.auto.reset();
  }

  setCalibrationMode(mode: number): void {
    this.calibrationMode = mode;
  }

  setAutoCalibrationConfidence(c: number): void {
    this.auto.confidence = c;
  }

  resetMotion(): void {
    this.motion.reset();
  }

  private pushSensorSamples(gyro: V, accelMagnitude: number): void {
    const c = this.calibration;
    c.numSamples++;
    c.x += gyro.x;
    c.y += gyro.y;
    c.z += gyro.z;
    c.accelMagnitude += accelMagnitude;
  }

  private getCalibratedSensor(): { offset: V; accelMagnitude: number } {
    const c = this.calibration;
    if (c.numSamples <= 0) return { offset: new V(), accelMagnitude: 1 };
    const inv = 1 / c.numSamples;
    return {
      offset: new V(c.x * inv, c.y * inv, c.z * inv),
      accelMagnitude: c.accelMagnitude * inv,
    };
  }
}
