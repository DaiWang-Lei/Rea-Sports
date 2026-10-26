import { describe, expect, it } from 'vitest';
import { DEG } from '@/core/math';
import { fromAxisAngle, multiply, type Quat, rotate } from '@/core/quat';
import { vec3 } from '@/core/vec3';
import { DEVICE_GRIP, PaddleModel } from '@/input/paddle/PaddleModel';

/**
 * 设备拍头（+X，Joy-Con 肩键一端 / 手机顶端）指向 W 里方位角 az（从 +x 逆时针，弧度）、正面（+Z）朝上，
 * 再把拍头往上抬 pitch（像遥控器一样斜着指）。pitch = 0 就是平放在桌上指着那个方向。
 */
function pointing(az: number, pitch = 0): Quat {
  // 绕机体 +Y 转 −pitch：+X 往 +Z 那边抬
  return multiply(fromAxisAngle(0, 0, 1, az), fromAxisAngle(0, 1, 0, -pitch));
}

/**
 * 设备立着当球拍的姿态（机体 → 融合系 W）：顶端（+X）朝上，正面（+Z，Joy-Con 按键面 / 手机屏幕）
 * 朝 W 里方位角 az，再绕自身左右轴后仰 tilt（正面朝上抬）。
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
});

describe('校准 / 回中：拍头指向电视', () => {
  it('平放在桌上指着电视：画面里拍头朝前、红面朝上，与融合系的偏航无关', () => {
    for (const az of [0, 1, -2.5]) {
      const m = new PaddleModel();
      const q = pointing(az);
      expect(m.setHeading(q)).toBe(true);
      const b = m.bladeUp(q)!;
      const n = m.faceNormal(q)!;
      expect(b.y).toBeCloseTo(1, 6);
      expect(n.z).toBeCloseTo(1, 6);
    }
  });

  it('像遥控器一样斜着指（拍头抬起 40°）：只看水平方向，画面里照样抬着 40°', () => {
    const m = new PaddleModel();
    const q = pointing(0.7, 40 * DEG);
    expect(m.setHeading(q)).toBe(true);
    const b = m.bladeUp(q)!;
    expect(b.x).toBeCloseTo(0, 6);
    expect(Math.asin(b.z) / DEG).toBeCloseTo(40, 6);
  });

  it('拍头朝上（立着）看不出指向：拒绝', () => {
    const m = new PaddleModel();
    expect(m.setHeading(upright(0.3))).toBe(false);
    expect(m.setHeading(pointing(0.3, 70 * DEG))).toBe(false);
    expect(m.calibrated).toBe(false);
  });

  it('校准后拿起来摆正手准备姿势、按键面朝电视：画面里红面正对电视（同一个电视方向）', () => {
    const m = new PaddleModel();
    const tv = 1.2;
    m.setHeading(pointing(tv));
    expect(faceHeading(m, upright(tv))).toBeCloseTo(0, 6);
    expect(faceHeading(m, upright(tv + 25 * DEG))).toBeCloseTo(25, 6);
  });
});

describe('等球时自动校正：只去掉漂移，不改校准的方向', () => {
  const DT = 0.005;
  /**
   * 模拟一局：先拍头指向电视校准；融合系里的偏航以 driftDps（度/秒）匀速漂；每 2.6 秒一个来回，
   * 前 quietS 秒手安静地摆着准备姿势（红面相对电视的真实角度 = pose(t)，度），其余时间在挥拍（角速度大）。
   * 返回结束时画面里红面的角度（真实应为 pose(结束)）。
   */
  function run(opt: {
    seconds: number;
    driftDps: number;
    correct: boolean;
    quietS?: number;
    pose?: (t: number, cycle: number) => number;
    tilt?: number;
    m?: PaddleModel;
  }) {
    const tv = 0.4;
    const m = opt.m ?? new PaddleModel();
    if (!opt.m) m.setHeading(pointing(tv));
    const quietS = opt.quietS ?? 1.2;
    const pose = opt.pose ?? (() => 0);
    let shown = 0;
    for (let t = 0; t < opt.seconds; t += DT) {
      const real = pose(t, Math.floor(t / 2.6));
      const q = upright(tv + (opt.driftDps * t + real) * DEG, opt.tilt ?? 0);
      m.update({ t: t * 1000, dt: DT, q, linAccWorld: vec3() });
      const quiet = t % 2.6 < quietS;
      m.trackHeading(quiet ? vec3(0.1, -0.1, 0.05) : vec3(0, 20, 0), DT, opt.correct);
      shown = faceHeading(m, q) - real;
    }
    // shown = 画面角度 − 真实角度（理想为 0）
    return { m, err: shown };
  }

  it('习惯的准备姿势拍面偏 20°（没正对电视）：学到 20°，不去拉它，画面照实显示', () => {
    const { m, err } = run({ seconds: 30, driftDps: 0, correct: true, pose: () => 20 });
    expect(m.ready.front / DEG).toBeCloseTo(20, 3);
    expect(err).toBeCloseTo(0, 3);
    expect(m.drift).toBe(0);
  });

  it('偏航每秒漂 0.6°、习惯姿势偏 20°：不校正 2 分钟偏 72°；校正后误差不到 3°，并估计出漂移速度', () => {
    const pose = () => 20;
    expect(
      Math.abs(run({ seconds: 120, driftDps: 0.6, correct: false, pose }).err)
    ).toBeGreaterThan(70);
    const { m, err } = run({ seconds: 120, driftDps: 0.6, correct: true, pose });
    expect(Math.abs(err)).toBeLessThan(3);
    expect(m.drift / DEG).toBeCloseTo(0.6, 1);
  });

  it('一直在挥拍（手不安静）：学不到、不校正，只按已知漂移速度补', () => {
    const { m, err } = run({ seconds: 30, driftDps: 0.6, correct: true, quietS: 0 });
    expect(Number.isNaN(m.ready.front)).toBe(true);
    expect(err).toBeCloseTo(18, 0);
  });

  it('学到之后姿势突然偏了 60°（可能在做别的动作）：不自动拉', () => {
    const { m, err } = run({
      seconds: 20,
      driftDps: 0,
      correct: true,
      pose: (t) => (t < 6 ? 0 : 60),
    });
    expect(m.ready.front / DEG).toBeCloseTo(0, 3);
    expect(err).toBeCloseTo(0, 3);
  });

  it('正手、反手两种准备姿势（红面偏 10° / 背面偏 −15°）分开学，漂移照样去掉', () => {
    // 偶数个来回红面朝前偏 10°，奇数个来回背面朝前偏 −15°（红面在 165°）
    const pose = (_t: number, cycle: number) => (cycle % 2 === 0 ? 10 : 165);
    const { m, err } = run({ seconds: 90, driftDps: 0.6, correct: true, pose });
    expect(m.ready.front / DEG).toBeCloseTo(10, 0);
    // 背面姿势第一次出现在第 2 个来回（约 3 秒），学的时候已经漂了约 2°、还没开始校正：这点偏差留在学到的角度里
    expect(Math.abs(m.ready.back / DEG + 15)).toBeLessThan(3);
    expect(Math.abs(err)).toBeLessThan(3);
    expect(m.drift / DEG).toBeCloseTo(0.6, 1);
  });

  it('拍子平躺（正面朝上）时不学也不校正', () => {
    const { m, err } = run({
      seconds: 20,
      driftDps: 0.3,
      correct: true,
      pose: () => 20,
      tilt: 60 * DEG,
    });
    expect(Number.isNaN(m.ready.front)).toBe(true);
    expect(err).toBeCloseTo(6, 0);
  });

  it('回中（重新指向电视）后重新学平时的姿势', () => {
    const { m } = run({ seconds: 10, driftDps: 0, correct: true, pose: () => 20 });
    expect(m.ready.front / DEG).toBeCloseTo(20, 3);
    expect(m.setHeading(pointing(0.4))).toBe(true);
    expect(Number.isNaN(m.ready.front)).toBe(true);
    run({ seconds: 10, driftDps: 0, correct: true, pose: () => -5, m });
    expect(m.ready.front / DEG).toBeCloseTo(-5, 3);
  });
});
