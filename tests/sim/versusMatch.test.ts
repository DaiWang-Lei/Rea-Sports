import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng';
import type { Side } from '@/sim/constants';
import { NO_FEATURES } from '@/sim/hit/HitResolver';
import { type MatchEvent, MatchSim } from '@/sim/MatchSim';

/** 两边都是人（双人对打）：脚本替两个人抛球、挥拍，时机带一点随机误差，打完一整局 */
function playVersus(sim: MatchSim, sigmaMs: number, seed = 5, maxT = 900): MatchEvent[] {
  const rng = new Rng(seed);
  const log: MatchEvent[] = [];
  let id = 1;
  const servedFor: Record<Side, object | null> = { near: null, far: null };
  const swungFor: Record<Side, number> = { near: -1, far: -1 };
  const err: Record<Side, number> = { near: 0, far: 0 };
  while (sim.phase.kind !== 'gameOver' && sim.t < maxT) {
    sim.tick();
    log.push(...sim.drainEvents());
    for (const side of ['near', 'far'] as const) {
      const h = sim.human(side)!;
      if (h.canToss(sim)) sim.humanToss(side, sim.tune.serve.buttonTossHeight);
      const swing = (tContact: number, dir: 1 | -1) =>
        sim.humanSwing(side, {
          id,
          motion: id++,
          path: 'fast',
          tDetect: sim.t,
          tContact,
          dir,
          yawFrac: 0.9,
          wPeak: rng.uniform(13, 20),
          features: NO_FEATURES,
        });
      const sa = h.serveAt;
      if (sa && servedFor[side] !== sa && sim.t >= sa.ideal - 0.07) {
        servedFor[side] = sa;
        swing(sa.ideal, 1);
      }
      const plan = h.plan;
      if (plan && h.awaitingSwing && swungFor[side] !== sim.rallyHits) {
        if (err[side] === 0) err[side] = rng.normal(0, sigmaMs) / 1000 || 1e-6;
        const tc = plan.t + err[side];
        if (sim.t >= tc - 0.07) {
          swungFor[side] = sim.rallyHits;
          err[side] = 0;
          swing(tc, sim.players[side].stance === 'fh' ? 1 : -1);
        }
      }
    }
  }
  return log;
}

describe('双人对打：两边都由人操作', () => {
  it('没有电脑也能打完一局：两人轮流发球，都能回球', () => {
    const sim = new MatchSim({ seed: 11, points: 6 });
    expect(sim.brains.near).toBeUndefined();
    expect(sim.brains.far).toBeUndefined();
    // 真人的时机误差大约这么大（练习录制里每球失误一两成）；误差小的两个人回合会很长
    const log = playVersus(sim, 90);
    expect(sim.phase.kind).toBe('gameOver');
    const tosses = log.filter((e) => e.type === 'toss');
    expect(tosses.some((e) => e.side === 'near')).toBe(true);
    expect(tosses.some((e) => e.side === 'far')).toBe(true);
    const returns = (side: Side) =>
      log.filter((e) => e.type === 'hit' && e.side === side && !e.serve && e.human).length;
    expect(returns('near')).toBeGreaterThan(5);
    expect(returns('far')).toBeGreaterThan(5);
    const points = log.filter((e) => e.type === 'point');
    expect(points.length).toBe(sim.scoring.score.near + sim.scoring.score.far);
  });
});
