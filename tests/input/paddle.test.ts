import { describe, expect, it } from 'vitest';
import { DEG } from '@/core/math';
import { fromAxisAngle, quat } from '@/core/quat';
import { vec3 } from '@/core/vec3';
import { PaddleModel } from '@/input/paddle/PaddleModel';
import type { SwingSnapshot } from '@/input/paddle/SwingDetector';

/** 已校准（握法 = 单位）、拍面绕 x 轴后仰 deg 度的快照：红面法向 (0, cos, sin) */
function snap(deg: number, t = 0): SwingSnapshot {
  return { t, w: 20, omegaWorld: vec3(), q: fromAxisAngle(1, 0, 0, deg * DEG) };
}

function model(): PaddleModel {
  const m = new PaddleModel();
  m.hasHeading = true;
  m.grip = quat();
  return m;
}

describe('拍面角度以平时的击球角度为基准', () => {
  it('不到 3 次时按绝对角度；记了几次 40° 后仰的正手后，40° 算平、60° 算后仰 20°、20° 算前压 20°', () => {
    const m = model();
    expect(m.features(snap(40), null, 'fh').facePitch / DEG).toBeCloseTo(40, 3);
    for (const d of [38, 41, 44, 40, 39]) m.recordContact('fh', m.facePitch(snap(d).q, 'fh'));
    expect(m.neutralPitch('fh') / DEG).toBeCloseTo(40, 3);
    expect(m.features(snap(40), null, 'fh').facePitch / DEG).toBeCloseTo(0, 3);
    expect(m.features(snap(60), null, 'fh').facePitch / DEG).toBeCloseTo(20, 3);
    expect(m.features(snap(20), null, 'fh').facePitch / DEG).toBeCloseTo(-20, 3);
    // 起止差（拧拍）不受基准影响
    expect(m.features(snap(30), snap(50, 5), 'fh').pitchChange / DEG).toBeCloseTo(20, 3);
  });

  it('正反手各算各的；回中（重定电视方向）不影响', () => {
    const m = model();
    for (let i = 0; i < 4; i++) m.recordContact('fh', 40 * DEG);
    expect(m.neutralPitch('bh')).toBe(0);
    for (let i = 0; i < 4; i++) m.recordContact('bh', -10 * DEG);
    expect(m.neutralPitch('bh') / DEG).toBeCloseTo(-10, 6);
    // 单位握法下拍头 = 机体 +Z：绕 x 转 −90° 让拍头水平（指向 +y）
    expect(m.setHeading(fromAxisAngle(1, 0, 0, -Math.PI / 2))).toBe(true);
    expect(m.neutralPitch('fh') / DEG).toBeCloseTo(40, 6);
    expect(m.neutralPitch('bh') / DEG).toBeCloseTo(-10, 6);
  });

  it('只看最近 9 次，偶尔一次反常不影响', () => {
    const m = model();
    for (let i = 0; i < 20; i++) m.recordContact('fh', 10 * DEG);
    for (const d of [35, 36, 34, 35, 80, 35, 36, 34, 35]) m.recordContact('fh', d * DEG);
    expect(m.neutralPitch('fh') / DEG).toBeCloseTo(35, 6);
  });
});
