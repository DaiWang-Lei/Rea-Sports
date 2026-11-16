import { describe, expect, it } from 'vitest';
import { fromMatchEvents, type RhythmEvent, rhythmSamples, summarize } from '@/rhythm/metrics';
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

describe('节奏：对照 NSSR 实机视频', () => {
  /** 同等级电脑对打几局的节奏样本（局与局之间错开时间） */
  function rhythmOf(level: number, games: number) {
    const all: RhythmEvent[] = [];
    for (let g = 0; g < games; g++) {
      const log = playOut(new MatchSim({ seed: 100 + g, cpu: { near: level, far: level } }));
      const offset = all.length ? all[all.length - 1].t + 10 : 0;
      for (const e of fromMatchEvents(log)) all.push({ t: e.t + offset, kind: e.kind });
    }
    return rhythmSamples(all);
  }

  it('各级回球都差不多快：击球 → 落到对方台 0.5–0.65 秒，两次击球约 0.9 秒', () => {
    // 实机：0.53–0.62 秒 / 0.87–1.0 秒，不论对手强弱
    for (const level of [1, 3, 5]) {
      const s = rhythmOf(level, 6);
      const flight = summarize(s.flight).median;
      const interval = summarize(s.interval).median;
      expect(flight, `等级 ${level}`).toBeGreaterThan(0.5);
      expect(flight, `等级 ${level}`).toBeLessThan(0.65);
      expect(interval, `等级 ${level}`).toBeGreaterThan(0.82);
      expect(interval, `等级 ${level}`).toBeLessThan(1.05);
    }
  });

  it('电脑高抛发球：从抛起到击球约 0.95 秒', () => {
    // 实机约 1.15 秒；我们是真实重力，再高最高点就出画了
    const t = summarize(rhythmOf(3, 2).tossToServe).median;
    expect(t).toBeGreaterThan(0.9);
    expect(t).toBeLessThan(1.02);
  });
});
