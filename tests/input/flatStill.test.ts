import { describe, expect, it } from 'vitest';
import { DEG } from '@/core/math';
import { rotate } from '@/core/quat';
import { Rng } from '@/core/rng';
import { type Vec3, vec3 } from '@/core/vec3';
import { FLAT_COLLECT_MS, FlatStillCalibrator } from '@/input/fusion/FlatStillCalibrator';
import { MotionState } from '@/input/fusion/MotionState';
import type { ImuSample } from '@/input/types';

/** 静止样本：陀螺 = 零点 + 噪声（°/s），加速度 = 「上」在机体系的方向 + 噪声（g） */
function still(
  rng: Rng,
  t0: number,
  ms: number,
  bias: Vec3,
  up: Vec3,
  gyroNoise: number,
  accelNoise = 0.003
): ImuSample[] {
  const out: ImuSample[] = [];
  for (let t = t0; t < t0 + ms; t += 5) {
    out.push({
      t,
      gyro: vec3(
        bias.x + rng.normal(0, gyroNoise),
        bias.y + rng.normal(0, gyroNoise),
        bias.z + rng.normal(0, gyroNoise)
      ),
      accel: vec3(
        up.x + rng.normal(0, accelNoise),
        up.y + rng.normal(0, accelNoise),
        up.z + rng.normal(0, accelNoise)
      ),
      clipped: false,
    });
  }
  return out;
}

const BIAS = vec3(0.6, -0.8, 0.7);
const FLAT_UP = vec3(0, 0, 1);

describe('平放学陀螺仪零点', () => {
  it('按键面朝上平放在桌上 2.5 秒：学到零点', () => {
    const c = new FlatStillCalibrator();
    let got: Vec3 | null = null;
    for (const s of still(new Rng(1), 0, 2600, BIAS, FLAT_UP, 0.3)) got = c.add(s) ?? got;
    expect(got).not.toBeNull();
    expect(got!.x).toBeCloseTo(BIAS.x, 1);
    expect(got!.y).toBeCloseTo(BIAS.y, 1);
    expect(got!.z).toBeCloseTo(BIAS.z, 1);
    expect(c.learnedAt).toBeGreaterThan(2000);
  });

  it('拿在手里（抖动大）、或者斜放 30°：都不学', () => {
    let c = new FlatStillCalibrator();
    for (const s of still(new Rng(2), 0, 5000, BIAS, FLAT_UP, 2)) expect(c.add(s)).toBeNull();
    c = new FlatStillCalibrator();
    const tilted = vec3(Math.sin(30 * DEG), 0, Math.cos(30 * DEG));
    for (const s of still(new Rng(3), 0, 5000, BIAS, tilted, 0.3)) expect(c.add(s)).toBeNull();
    expect(c.status.phase).toBe('idle');
  });

  it('累计中途被碰了一下：从头再来，放稳后整整 2 秒才算', () => {
    const c = new FlatStillCalibrator();
    const rng = new Rng(4);
    const a = still(rng, 0, 1500, BIAS, FLAT_UP, 0.3);
    const bump = still(rng, 1500, 100, BIAS, FLAT_UP, 8);
    const b = still(rng, 1600, 3000, BIAS, FLAT_UP, 0.3);
    let learnedAt = -1;
    for (const s of [...a, ...bump, ...b]) if (c.add(s)) learnedAt = s.t;
    expect(learnedAt).toBeGreaterThan(1600 + FLAT_COLLECT_MS);
  });

  it('flat 模式：平放 3 秒学到零点后，拿在手里不动 60 秒航向几乎不漂；不平放就按零点的速度漂', () => {
    const run = (withTable: boolean) => {
      const m = new MotionState('flat');
      const rng = new Rng(5);
      let t = 0;
      if (withTable) {
        for (const s of still(rng, t, 3000, BIAS, FLAT_UP, 0.3)) m.process(s);
        t = 3000;
      }
      // 手里竖着拿（不平放）：机体 +X 朝上，噪声大一点
      const held = still(rng, t, 60000, BIAS, vec3(1, 0, 0), 0.8, 0.004);
      for (const s of held.slice(0, 400)) m.process(s);
      const yaw = () => {
        const z = rotate(m.frame.q, vec3(0, 0, 1));
        return Math.atan2(z.y, z.x) / DEG;
      };
      const y0 = yaw();
      for (const s of held.slice(400)) m.process(s);
      return Math.abs(yaw() - y0);
    };
    expect(run(true)).toBeLessThan(3);
    // 零点在竖直轴（机体 X）上是 0.6°/s：58 秒漂 30° 以上
    expect(run(false)).toBeGreaterThan(25);
  });
});
