import { describe, expect, it } from 'vitest';
import { GamepadMotion } from '@/input/fusion/GamepadMotion';
import {
  angleBetween,
  fromAxisAngle,
  multiply,
  type Quat,
  quat,
  rotate,
  rotateInverse,
} from '@/core/quat';
import { Rng } from '@/core/rng';
import { type Vec3, vec3 } from '@/core/vec3';

const DT = 0.005;
const UP = vec3(0, 0, 1);
const RAD = Math.PI / 180;

/** 给定真实姿态与机体角速度（度/秒），产生一个理想 IMU 样本 */
function sampleFor(trueQ: Quat, gyroDps: Vec3, rng?: Rng, bias = vec3()) {
  const accel = rotateInverse(trueQ, UP); // 静止/匀速转动时，加速度计读数 = 机体系里的「上」
  const n = (s: number) => (rng ? rng.normal(0, s) : 0);
  return {
    gyro: vec3(
      gyroDps.x + bias.x + n(0.05),
      gyroDps.y + bias.y + n(0.05),
      gyroDps.z + bias.z + n(0.05)
    ),
    accel: vec3(accel.x + n(0.002), accel.y + n(0.002), accel.z + n(0.002)),
  };
}

describe('GamepadMotion（移植版）', () => {
  it('静止时自动估计陀螺零偏', () => {
    const gm = new GamepadMotion();
    const rng = new Rng(3);
    const bias = vec3(1.5, -0.8, 0.3);
    const q = quat();
    for (let i = 0; i < 6 / DT; i++) {
      const s = sampleFor(q, vec3(), rng, bias);
      gm.processMotion(s.gyro, s.accel, DT);
    }
    const off = gm.calibrationOffset;
    expect(Math.abs(off.x - bias.x)).toBeLessThan(0.1);
    expect(Math.abs(off.y - bias.y)).toBeLessThan(0.1);
    expect(Math.abs(off.z - bias.z)).toBeLessThan(0.1);
    expect(gm.autoCalibrationConfidence).toBeGreaterThan(0.5);
  });

  it('跟踪匀速转动，姿态误差 < 1°', () => {
    const gm = new GamepadMotion();
    let trueQ = quat();
    // 先静止 1 秒
    for (let i = 0; i < 1 / DT; i++) {
      const s = sampleFor(trueQ, vec3());
      gm.processMotion(s.gyro, s.accel, DT);
    }
    // 绕机体 X 轴 90°/s 转 1 秒，再绕机体 Z 轴 -120°/s 转 0.5 秒
    const phases: Array<[Vec3, number]> = [
      [vec3(90, 0, 0), 1],
      [vec3(0, 0, -120), 0.5],
    ];
    for (const [w, dur] of phases) {
      for (let i = 0; i < dur / DT; i++) {
        const step = fromAxisAngle(w.x, w.y, w.z, Math.hypot(w.x, w.y, w.z) * RAD * DT);
        trueQ = multiply(trueQ, step);
        const s = sampleFor(trueQ, w);
        gm.processMotion(s.gyro, s.accel, DT);
      }
    }
    expect(angleBetween(gm.orientation, trueQ) / RAD).toBeLessThan(1);
  });

  it('初始姿态不对时，重力校正把「上」拉回来', () => {
    const gm = new GamepadMotion();
    // 实际上手柄侧放（机体 +Y 朝上），而滤波器初始以为机体 +Z 朝上
    const trueQ = fromAxisAngle(1, 0, 0, Math.PI / 2);
    expect(rotate(trueQ, vec3(0, 1, 0)).z).toBeCloseTo(1, 9);
    for (let i = 0; i < 3 / DT; i++) {
      const s = sampleFor(trueQ, vec3());
      gm.processMotion(s.gyro, s.accel, DT);
    }
    const upInBody = rotate(gm.orientation, vec3(0, 1, 0));
    expect(upInBody.z).toBeGreaterThan(Math.cos(2 * RAD));
  });

  it('线加速度去掉了重力（重力估计在最后 5% 会刻意放慢收敛，所以多给几秒）', () => {
    const gm = new GamepadMotion();
    const q = fromAxisAngle(0, 1, 0, 0.4);
    for (let i = 0; i < 8 / DT; i++) {
      const s = sampleFor(q, vec3());
      gm.processMotion(s.gyro, s.accel, DT);
    }
    const a = gm.linearAccel;
    expect(Math.hypot(a.x, a.y, a.z)).toBeLessThan(0.01);
  });
});
