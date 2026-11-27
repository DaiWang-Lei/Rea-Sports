import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng';
import { NO_FEATURES } from '@/sim/hit/HitResolver';
import { CHALLENGE, type ChallengeEvent, ChallengeSim } from '@/sim/practice/ChallengeSim';
import type { ShotReport } from '@/sim/practice/FeederSim';

/** 让脚本当人：来球在理想时刻附近挥拍；stopAt 分之后不再挥（这一轮该结束），结束后再看 3 秒 */
function play(stopAt: number, seed = 5, maxT = 400) {
  const sim = new ChallengeSim({ seed });
  const rng = new Rng(seed + 1);
  const events: ChallengeEvent[] = [];
  let feedsAfterOver = 0;
  let overAt = Infinity;
  let swungFor = -1;
  let id = 1;
  while (sim.t < maxT && sim.t < overAt + 3) {
    sim.tick();
    for (const e of sim.drainEvents()) if (e.type === 'feed' && sim.over) feedsAfterOver++;
    for (const e of sim.drainChallengeEvents()) {
      events.push(e);
      if (e.type === 'over') overAt = e.t;
    }
    const plan = sim.plan;
    if (sim.score < stopAt && plan && sim.awaitingSwing && swungFor !== sim.stats.feeds) {
      const tc = plan.t + rng.normal(0, 12) / 1000;
      if (sim.t >= tc - 0.07) {
        swungFor = sim.stats.feeds;
        sim.swing({
          id,
          motion: id++,
          path: 'fast',
          tDetect: sim.t,
          tContact: tc,
          dir: sim.player.stance === 'fh' ? 1 : -1,
          yawFrac: 0.85,
          wPeak: rng.uniform(13, 18),
          features: NO_FEATURES,
        });
      }
    }
  }
  return { sim, events, feedsAfterOver };
}

describe('连续回击', () => {
  it('回进一球 1 分，越往后越难；满 10 分摆出靶子；不挥拍就结束、教练不再供球', () => {
    const { sim, events, feedsAfterOver } = play(14);
    // 时机很准的人能回到 14 分（中间偶尔失误会提前结束，换个种子）
    expect(sim.score).toBeGreaterThanOrEqual(14);
    expect(events.some((e) => e.type === 'cupsOn')).toBe(true);
    expect(sim.level).toBeGreaterThanOrEqual(2);
    expect(sim.cups.length).toBeGreaterThan(0);
    const over = events.find((e) => e.type === 'over');
    expect(over && over.type === 'over' && over.reason).toBe('missed');
    expect(sim.over).toBe(true);
    // 结束时可能已经有一球在路上（多球节奏），之后不再供球
    expect(feedsAfterOver).toBeLessThanOrEqual(1);
  });

  it('回球落在靶子上：撞飞靶子，这一球多加 3 分', () => {
    const sim = new ChallengeSim({ seed: 2 });
    sim.score = CHALLENGE.cupsAt;
    sim.cups.push({ id: 1, x: 0.3, y: 0.8, knockedAt: null, spawnedAt: 0 });
    const report: ShotReport = {
      result: 'in',
      timingMs: 0,
      stroke: 'fh',
      kind: 'normal',
      power: 0.5,
      spin: 0,
      rushed: false,
      smash: false,
      landing: { x: 0.33, y: 0.78, z: 0.78 },
      feedSpin: 'flat',
    };
    (sim as unknown as { onResult(r: ShotReport): void }).onResult(report);
    expect(sim.score).toBe(CHALLENGE.cupsAt + 1 + CHALLENGE.cupBonus);
    expect(sim.cups[0].knockedAt).not.toBeNull();
    const ev = sim.drainChallengeEvents();
    expect(ev.some((e) => e.type === 'cup')).toBe(true);
  });
});
