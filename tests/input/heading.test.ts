import { describe, expect, it } from 'vitest';
import { DEG } from '@/core/math';
import { fromAxisAngle, multiply, type Quat, quat, rotate } from '@/core/quat';
import { vec3 } from '@/core/vec3';
import { DEVICE_GRIP, PaddleModel } from '@/input/paddle/PaddleModel';

/**
 * 设备立着当球拍的姿态（机体 → 融合系 W）：顶端（+X）朝上，正面（+Z，Joy-Con 按键面 / 手机屏幕）
 * 朝 W 里方位角 az（从 +x 逆时针，弧度），再绕自身左右轴后仰 tilt（正面朝上抬）。
 */
function upright(az: number, tilt = 0): Quat {
  // q0：+X → 上，+Z → +x，+Y → −y（绕 (1,0,1)/√2 转 180°）
  const q0 = { w: 0, x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
  // 后仰：绕机体 +Y 转 tilt（正面 +Z 往上抬，即往 +X 那边转）
  const back = fromAxisAngle(0, 1, 0, tilt);
  return multiply(fromAxisAngle(0, 0, 1, az), multiply(q0, back));
}

/** 红面在游戏系里的水平朝向（度，0 = 正对电视，逆时针为正） */
function faceHeading(m: PaddleModel, q?: Quat): number {
  const n = m.faceNormal(q)!;
  return Math.atan2(-n.x, n.y) / DEG;
}

describe('固定握法：设备就是球拍', () => {
  it('红面 = 机体 +Z（按键面 / 屏幕），拍头 = 机体 +X（顶端）', () => {
    const y = rotate(DEVICE_GRIP, vec3(0, 1, 0));
    const z = rotate(DEVICE_GRIP, vec3(0, 0, 1));
    expect([y.x, y.y, y.z].map((v) => +v.toFixed(6))).toEqual([0, 0, 1]);
    expect([z.x, z.y, z.z].map((v) => +v.toFixed(6))).toEqual([1, 0, 0]);
  });

  it('准备姿势（立着、正面朝电视）按回中：画面里拍头朝上、红面朝前，与融合系的偏航无关', () => {
    for (const az of [0, 1, -2.5]) {
      const m = new PaddleModel();
      const q = upright(az);
      expect(m.setHeading(q)).toBe(true);
      const n = m.faceNormal(q)!;
      const b = m.bladeUp(q)!;
      expect(n.y).toBeCloseTo(1, 6);
      expect(b.z).toBeCloseTo(1, 6);
    }
  });

  it('回中时拍面后仰 30°：只取水平朝向，画面里照样显示后仰 30°（不再把偏差记进握法）', () => {
    const m = new PaddleModel();
    const q = upright(0.7, 30 * DEG);
    expect(m.setHeading(q)).toBe(true);
    const n = m.faceNormal(q)!;
    expect(faceHeading(m, q)).toBeCloseTo(0, 6);
    expect(Math.asin(n.z) / DEG).toBeCloseTo(30, 6);
  });

  it('平放（正面朝上）按回中：拒绝', () => {
    const m = new PaddleModel();
    expect(m.setHeading(quat())).toBe(false);
    expect(m.calibrated).toBe(false);
  });
});

describe('等球时自动校正电视方向', () => {
  const DT = 0.005;
  /**
   * 模拟一局：融合系里的偏航以 driftDps（度/秒）匀速漂；每 2.6 秒一个来回，前 quietS 秒手安静地摆着
   * 准备姿势（姿态 = 漂移后的准备姿势，再加 offsetDeg），其余时间在挥拍（角速度大）。返回结束时的状态。
   */
  function run(opt: {
    seconds: number;
    driftDps: number;
    correct: boolean;
    quietS?: number;
    offsetDeg?: number;
    tilt?: number;
  }) {
    const m = new PaddleModel();
    const az0 = 0.4;
    m.setHeading(upright(az0));
    const quietS = opt.quietS ?? 1.2;
    let q = upright(az0);
    for (let t = 0; t < opt.seconds; t += DT) {
      const az = az0 + (opt.driftDps * t + (opt.offsetDeg ?? 0)) * DEG;
      q = upright(az, opt.tilt ?? 0);
      m.update({ t: t * 1000, dt: DT, q, linAccWorld: vec3() });
      const quiet = t % 2.6 < quietS;
      m.trackHeading(quiet ? vec3(0.1, -0.1, 0.05) : vec3(0, 20, 0), DT, opt.correct);
    }
    return { m, err: faceHeading(m, q) };
  }

  it('偏航每秒漂 0.6°：不校正 2 分钟偏 72°；校正后剩不到 3°，并且估计出漂移速度', () => {
    expect(Math.abs(run({ seconds: 120, driftDps: 0.6, correct: false }).err)).toBeGreaterThan(70);
    const { m, err } = run({ seconds: 120, driftDps: 0.6, correct: true });
    expect(Math.abs(err)).toBeLessThan(3);
    expect(m.drift / DEG).toBeCloseTo(0.6, 1);
  });

  it('一直在挥拍（手不安静）：不校正，只按已知漂移速度补', () => {
    const { err } = run({ seconds: 30, driftDps: 0.6, correct: true, quietS: 0 });
    expect(err).toBeCloseTo(18, 0);
  });

  it('偏得太多（60°，可能在做别的动作）：不自动拉', () => {
    const { m, err } = run({ seconds: 20, driftDps: 0, correct: true, offsetDeg: 60 });
    expect(err).toBeCloseTo(60, 3);
    expect(m.drift).toBe(0);
  });

  it('背面朝电视（反手准备姿势）也算：偏 10° 一分钟内拉回', () => {
    const { err } = run({ seconds: 60, driftDps: 0, correct: true, offsetDeg: 190 });
    // 红面朝后（±180°），背面正对电视
    expect(Math.abs(Math.abs(err) - 180)).toBeLessThan(1);
  });

  it('拍子平躺（正面朝上）时不校正', () => {
    const { err } = run({ seconds: 20, driftDps: 0, correct: true, offsetDeg: 20, tilt: 60 * DEG });
    expect(err).toBeCloseTo(20, 3);
  });
});
