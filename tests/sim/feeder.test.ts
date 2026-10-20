import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng';
import { NO_FEATURES } from '@/sim/hit/HitResolver';
import { FeederSim, type FeedLevel, type ShotReport } from '@/sim/practice/FeederSim';
import { forehandSign } from '@/sim/players/PlayerSim';

function play(level: FeedLevel, sigmaMs: number | null, feeds: number, seed = 11) {
  const sim = new FeederSim({ seed, level });
  const rng = new Rng(seed + 1);
  const reports: ShotReport[] = [];
  let swungFor = -1;
  let id = 1;
  while (sim.stats.feeds < feeds || sim.phase.kind !== 'wait') {
    sim.tick();
    for (const e of sim.drainEvents()) if (e.type === 'result') reports.push(e.report);
    const plan = sim.plan;
    if (sigmaMs !== null && plan && sim.awaitingSwing && swungFor !== sim.stats.feeds) {
      const tc = plan.t + rng.normal(0, sigmaMs) / 1000;
      if (sim.t >= tc - 0.07) {
        swungFor = sim.stats.feeds;
        const rel = (plan.p.x - sim.player.mover.x) * forehandSign(sim.player);
        sim.swing({
          id,
          motion: id++,
          path: 'fast',
          tDetect: sim.t,
          tContact: tc,
          dir: rel > -0.15 ? 1 : -1,
          yawFrac: 0.85,
          wPeak: rng.uniform(13, 20),
          features: NO_FEATURES,
        });
      }
    }
    if (sim.t > 1000) throw new Error('练习没有正常推进');
  }
  return { sim, reports };
}

describe('发球机练习', () => {
  it('时机准（σ 15ms）时绝大多数球能回进', () => {
    for (const lv of [1, 2, 3] as FeedLevel[]) {
      const { sim, reports } = play(lv, 15, 50);
      expect(reports.length).toBe(50);
      expect(sim.inRate).toBeGreaterThan(0.9);
    }
  });

  it('不挥拍：每一球都是「没接到」', () => {
    const { reports } = play(1, null, 10);
    expect(reports.every((r) => r.result === 'missed')).toBe(true);
  });

  it('同一种子结果完全一样', () => {
    const a = play(2, 40, 30, 5).reports.map((r) => `${r.result}:${r.timingMs}`);
    const b = play(2, 40, 30, 5).reports.map((r) => `${r.result}:${r.timingMs}`);
    expect(a).toEqual(b);
  });
});
