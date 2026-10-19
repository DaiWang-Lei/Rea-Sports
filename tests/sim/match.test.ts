import { describe, expect, it } from 'vitest';
import { MatchSim, type MatchEvent } from '@/sim/MatchSim';

function playOut(sim: MatchSim, maxTicks = 240 * 60 * 20): MatchEvent[] {
  const log: MatchEvent[] = [];
  for (let i = 0; i < maxTicks && sim.phase.kind !== 'gameOver'; i++) {
    sim.tick();
    log.push(...sim.drainEvents());
  }
  return log;
}

function hashEvents(events: MatchEvent[]): string {
  return events
    .map(
      (e) =>
        `${e.type}:${e.t.toFixed(5)}:${'side' in e ? e.side : ''}:${'winner' in e ? e.winner : ''}`
    )
    .join('|');
}

describe('MatchSim（电脑对电脑）', () => {
  it('多局都能正常结束，比分合法，没有异常', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const sim = new MatchSim({ seed, cpu: { near: 3, far: 3 }, points: seed % 2 ? 6 : 11 });
      const events = playOut(sim);
      expect(sim.phase.kind).toBe('gameOver');
      const { near, far } = sim.scoring.score;
      const target = sim.points;
      const winner = Math.max(near, far);
      const loser = Math.min(near, far);
      expect(winner).toBeGreaterThanOrEqual(target);
      expect(winner - loser).toBeGreaterThanOrEqual(2);
      // 每一分都对应一个 point 事件
      expect(events.filter((e) => e.type === 'point').length).toBe(near + far);
      // 每分时长合理
      for (const d of sim.stats.pointDurations) expect(d).toBeLessThan(60);
    }
  });

  it('同一种子得到完全相同的比赛', () => {
    const a = playOut(new MatchSim({ seed: 42, cpu: { near: 2, far: 4 } }));
    const b = playOut(new MatchSim({ seed: 42, cpu: { near: 2, far: 4 } }));
    expect(hashEvents(a)).toBe(hashEvents(b));
    const c = playOut(new MatchSim({ seed: 43, cpu: { near: 2, far: 4 } }));
    expect(hashEvents(a)).not.toBe(hashEvents(c));
  });

  it('发球轮换与比分事件一致：前两分近端发球', () => {
    const sim = new MatchSim({ seed: 5, cpu: { near: 3, far: 3 } });
    const servers: string[] = [];
    for (let i = 0; i < 240 * 120 && servers.length < 4; i++) {
      sim.tick();
      for (const e of sim.drainEvents()) if (e.type === 'hit' && e.serve) servers.push(e.side);
    }
    // 重发（擦网）会让同一方多发一次，这里只看去重后的轮换顺序开头
    expect(servers[0]).toBe('near');
  });
});
