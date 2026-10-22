import { describe, expect, it } from 'vitest';
import { SIM_DT } from '@/sim/constants';
import { FeederSim, type FeedLevel } from '@/sim/practice/FeederSim';

describe('理想击球点', () => {
  it('发球机各难度的来球：理想击球点都在弹起后的下降段（过了最高点）', () => {
    let n = 0;
    for (const level of [1, 2, 3] as FeedLevel[]) {
      for (let seed = 1; seed <= 6; seed++) {
        const sim = new FeederSim({ seed, level });
        let last = 0;
        while (sim.stats.feeds < 6 && sim.t < 60) {
          sim.tick();
          sim.drainEvents();
          const p = sim.plan;
          if (!p || sim.stats.feeds === last) continue;
          last = sim.stats.feeds;
          const st = p.prediction.states;
          const i = Math.round((p.t - p.prediction.t0) / SIM_DT);
          expect(st[i].v.z).toBeLessThanOrEqual(0);
          // 弹起后的最高点在理想时刻之前（或就是它）
          const iBounce = Math.ceil((p.bounceT - p.prediction.t0) / SIM_DT);
          const apex = st.findIndex((s, k) => k > iBounce && s.v.z <= 0);
          expect(apex).toBeLessThanOrEqual(i);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(90);
  });
});
