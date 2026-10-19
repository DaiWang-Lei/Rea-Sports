import { describe, expect, it } from 'vitest';
import { createTuning } from '@/config/tuning';
import { Rng } from '@/core/rng';
import { vec3 } from '@/core/vec3';
import { ballState, flyFree } from '@/sim/ball/physics';
import { TABLE_CONTACT_Z } from '@/sim/constants';
import {
  checkShot,
  solveIntoNet,
  solveRallyShot,
  solveServe,
  solveTarget,
} from '@/sim/shot/ShotSolver';

const T = createTuning();
const PP = T.physics;

function randomShot(rng: Rng) {
  const p0 = vec3(rng.uniform(-0.6, 0.6), rng.uniform(-1.9, -1.4), rng.uniform(0.85, 1.15));
  const target = { x: rng.uniform(-0.6, 0.6), y: rng.uniform(0.3, 1.25) };
  const speedH = rng.uniform(4, 12);
  const dx = target.x - p0.x;
  const dy = target.y - p0.y;
  const d = Math.hypot(dx, dy);
  // 旋转：上旋/下旋沿 ẑ×d，侧旋沿 ẑ
  const top = rng.uniform(-200, 250);
  const side = rng.uniform(-150, 150);
  const w0 = vec3((-dy / d) * top, (dx / d) * top, side);
  return { p0, target, speedH, w0 };
}

describe('solveTarget', () => {
  it('1 万次随机击球：≥99.5% 收敛，落点误差 < 1cm', () => {
    const rng = new Rng(123);
    let ok = 0;
    const N = 10000;
    let maxIter = 0;
    for (let i = 0; i < N; i++) {
      const { p0, target, speedH, w0 } = randomShot(rng);
      const Tf = (1.08 * Math.hypot(target.x - p0.x, target.y - p0.y)) / speedH;
      const r = solveTarget(p0, w0, vec3(target.x, target.y, TABLE_CONTACT_Z), Tf, PP);
      if (r.ok && r.error < 0.01) ok++;
      maxIter = Math.max(maxIter, r.iterations);
    }
    expect(ok / N).toBeGreaterThanOrEqual(0.995);
    expect(maxIter).toBeLessThanOrEqual(10);
  });

  it('解出的速度用同一积分器回放，终点就是目标点', () => {
    const p0 = vec3(0.2, -1.6, 1.0);
    const w0 = vec3(-150, 0, 40);
    const target = vec3(-0.4, 1.0, TABLE_CONTACT_Z);
    const r = solveTarget(p0, w0, target, 0.45, PP);
    const end = flyFree(ballState(p0, r.v0, w0), 0.45, PP).p;
    expect(Math.hypot(end.x - target.x, end.y - target.y, end.z - target.z)).toBeLessThan(0.005);
  });
});

describe('solveRallyShot', () => {
  it('正常回球落在目标半台且过网高度足够', () => {
    const rng = new Rng(7);
    let ok = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const { p0, target, speedH, w0 } = randomShot(rng);
      const r = solveRallyShot(
        { p0, w0, target, speedH, minClearance: 0.025, maxApex: Infinity, flightTimeFactor: 1.08 },
        PP
      );
      if (r.ok) {
        ok++;
        expect(r.check.first?.type).toBe('table');
        expect(r.check.first?.side).toBe('far');
        expect(r.check.clearance).toBeGreaterThanOrEqual(0.025);
      }
    }
    expect(ok / N).toBeGreaterThan(0.97);
  });

  it('低平球过网不够时会自动抬高弧线', () => {
    // 低出手点 + 近落点 + 快速：直接按时间解会下网
    const req = {
      p0: vec3(0, -1.5, 0.8),
      w0: vec3(250, 0, 0),
      target: { x: 0, y: 0.35 },
      speedH: 12,
      minClearance: 0.025,
      maxApex: Infinity,
      flightTimeFactor: 1.08,
    };
    const r = solveRallyShot(req, PP);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBeGreaterThan(1);
  });

  it('故意下网：瞄准网顶以下会撞网', () => {
    const p0 = vec3(0.1, -1.6, 1.0);
    const w0 = vec3(-100, 0, 0);
    const v0 = solveIntoNet(p0, w0, 0.05, -0.04, 7, PP);
    const c = checkShot(p0, v0, w0, PP);
    expect(c.first?.type).toBe('net');
  });
});

describe('solveServe', () => {
  it('发球先落本方台、再落对方台，落点误差 < 2cm', () => {
    const rng = new Rng(99);
    let ok = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const req = {
        p0: vec3(rng.uniform(-0.5, 0.5), rng.uniform(-1.6, -1.4), rng.uniform(0.95, 1.15)),
        w0: vec3(rng.uniform(-150, 150), 0, rng.uniform(-80, 80)),
        first: { x: 0, y: rng.uniform(-1.1, -0.5) },
        second: { x: rng.uniform(-0.55, 0.55), y: rng.uniform(0.55, 1.15) },
        speedH: rng.uniform(4, 8),
        minClearance: 0.01,
      };
      const r = solveServe(req, PP);
      if (r.ok) {
        ok++;
        // 落点与求解器实际采用的目标一致；目标本身离请求不超过 0.45m（为了过网可能调整过）
        expect(Math.abs(r.check.first!.p.y - r.first.y)).toBeLessThan(0.02);
        expect(Math.abs(r.check.second!.p.x - r.second.x)).toBeLessThan(0.02);
        expect(Math.abs(r.check.second!.p.y - r.second.y)).toBeLessThan(0.02);
        expect(Math.abs(r.first.y - req.first.y)).toBeLessThanOrEqual(0.45 + 1e-9);
        expect(r.check.clearance).toBeGreaterThanOrEqual(0.01);
      }
    }
    expect(ok / N).toBeGreaterThan(0.95);
  });
});
