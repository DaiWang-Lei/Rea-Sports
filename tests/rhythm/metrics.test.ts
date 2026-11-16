import { describe, expect, it } from 'vitest';
import { MatchSim } from '@/sim/MatchSim';
import {
  fromMatchEvents,
  type RhythmEvent,
  rhythmSamples,
  splitRallies,
  summarize,
} from '@/rhythm/metrics';

const ev = (t: number, kind: RhythmEvent['kind']): RhythmEvent => ({ t, kind });

describe('节奏指标', () => {
  // 一个回合：抛球 → 发球（落本方、落对方）→ 回球（落台）→ 扣杀（落台）→ 回合结束
  const rally: RhythmEvent[] = [
    ev(0.0, 'toss'),
    ev(0.6, 'serve'),
    ev(0.75, 'bounce'),
    ev(1.15, 'bounce'),
    ev(1.5, 'hit'),
    ev(1.95, 'bounce'),
    ev(2.3, 'smash'),
    ev(2.5, 'bounce'),
    ev(2.9, 'end'),
  ];

  it('各项指标按定义取样', () => {
    const s = rhythmSamples(rally);
    expect(s.tossToServe).toEqual([0.6]);
    expect(s.serveFlight[0]).toBeCloseTo(0.55);
    expect(s.interval.map((v) => +v.toFixed(3))).toEqual([0.9, 0.8]);
    expect(s.flight[0]).toBeCloseTo(0.45);
    expect(s.smashFlight[0]).toBeCloseTo(0.2);
    expect(s.bounceToHit.map((v) => +v.toFixed(3))).toEqual([0.35, 0.35]);
  });

  it('回合结束或者隔了 3 秒以上就切开，不跨回合算间隔', () => {
    const two = [...rally, ev(10, 'hit'), ev(10.4, 'bounce'), ev(10.8, 'hit')];
    expect(splitRallies(two)).toHaveLength(2);
    expect(rhythmSamples(two).interval.map((v) => +v.toFixed(3))).toEqual([0.9, 0.8, 0.8]);
  });

  it('打点顺序乱了（后补的点）也按时间排', () => {
    const shuffled = [...rally].reverse();
    expect(rhythmSamples(shuffled)).toEqual(rhythmSamples(rally));
  });

  it('中位数、平均数', () => {
    expect(summarize([3, 1, 2, 10])).toEqual({ n: 4, median: 2.5, mean: 4 });
    expect(summarize([]).n).toBe(0);
  });

  it('电脑对电脑的一局能算出所有常规指标，数值在合理范围', () => {
    const sim = new MatchSim({ seed: 3, cpu: { near: 3, far: 3 } });
    const log = [];
    while (sim.phase.kind !== 'gameOver' && sim.t < 600) {
      sim.tick();
      log.push(...sim.drainEvents());
    }
    const s = rhythmSamples(fromMatchEvents(log));
    for (const k of ['interval', 'flight', 'bounceToHit', 'tossToServe', 'serveFlight'] as const) {
      expect(s[k].length).toBeGreaterThan(5);
    }
    expect(summarize(s.interval).median).toBeGreaterThan(0.5);
    expect(summarize(s.interval).median).toBeLessThan(1.5);
    expect(summarize(s.flight).median).toBeLessThan(summarize(s.interval).median);
  });
});
