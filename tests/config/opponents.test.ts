import { describe, expect, it } from 'vitest';
import { cpuLevel, styledLevel } from '@/config/difficulty';
import { crowdFill, matchOpponent, OPPONENTS, rateGame, SKILL } from '@/config/opponents';
import { createTuning } from '@/config/tuning';
import { MatchSim } from '@/sim/MatchSim';

describe('电脑对手和熟练度', () => {
  it('按熟练度配对：离你最近的两个里挑一个', () => {
    for (const r of [0, 0.99]) expect(['xiaodou', 'azhen']).toContain(matchOpponent(0, r).id);
    for (const r of [0, 0.99]) expect(['suyao', 'xuejie']).toContain(matchOpponent(1500, r).id);
    expect(matchOpponent(2500, 0).champion).toBe(true);
    // 名单按熟练度从低到高，冠军在最后
    const skills = OPPONENTS.map((o) => o.skill);
    expect([...skills].sort((a, b) => a - b)).toEqual(skills);
  });

  it('熟练度：赢加输扣、赢强的加得多、比分差大的多一点、不低于 0', () => {
    const even = OPPONENTS.find((o) => o.skill === 0)!;
    const strong = OPPONENTS.find((o) => o.skill >= 400)!;
    const win = rateGame(0, even, 1, { mine: 6, theirs: 4 }, 6);
    expect(win).toBeGreaterThan(0);
    expect(rateGame(0, strong, 1, { mine: 6, theirs: 4 }, 6)).toBeGreaterThan(win);
    expect(rateGame(0, even, 1, { mine: 6, theirs: 0 }, 6)).toBeGreaterThan(win);
    expect(rateGame(500, even, 0, { mine: 3, theirs: 6 }, 6)).toBeLessThan(500);
    expect(rateGame(0, strong, 0, { mine: 0, theirs: 6 }, 6)).toBe(0);
    // Pro 以上涨得慢一点
    const nearPro = OPPONENTS.find((o) => o.skill >= SKILL.pro)!;
    expect(
      rateGame(nearPro.skill, nearPro, 1, { mine: 6, theirs: 4 }, 6) - nearPro.skill
    ).toBeLessThan(win);
  });

  it('熟练度越高看台越满', () => {
    expect(crowdFill(0)).toBeLessThan(crowdFill(800));
    expect(crowdFill(1500)).toBeCloseTo(1, 6);
    expect(crowdFill(2500)).toBeCloseTo(1, 6);
  });

  it('风格：削球型多削、进攻型多拉和扣杀', () => {
    const base = cpuLevel(3);
    expect(styledLevel(base, 'chop').driveShare).toBeLessThan(0.3);
    expect(styledLevel(base, 'attack').driveShare).toBeGreaterThan(0.7);
    expect(styledLevel(base, 'attack').smashP).toBeGreaterThan(base.smashP);
    expect(styledLevel(base, 'chop').smashReturnP).toBeGreaterThan(base.smashReturnP);
    expect(styledLevel(base)).toEqual(base);
  });

  it('打起来：削球型电脑的回球下旋多，进攻型上旋多', () => {
    const kinds = (style: 'chop' | 'attack') => {
      const c: Record<string, number> = {};
      for (let seed = 1; seed <= 3; seed++) {
        const sim = new MatchSim({
          seed,
          cpu: { near: 3, far: 3 },
          cpuStyle: { far: style },
          tune: createTuning(),
        });
        while (sim.phase.kind !== 'gameOver' && sim.t < 600) {
          sim.tick();
          for (const e of sim.drainEvents())
            if (e.type === 'hit' && e.side === 'far' && !e.serve) c[e.kind] = (c[e.kind] ?? 0) + 1;
        }
      }
      return c;
    };
    const chop = kinds('chop');
    const attack = kinds('attack');
    expect(chop.cut ?? 0).toBeGreaterThan(2 * (chop.drive ?? 0));
    expect(attack.drive ?? 0).toBeGreaterThan(2 * (attack.cut ?? 0));
  }, 20000);
});
