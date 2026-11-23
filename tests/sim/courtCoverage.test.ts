import { describe, expect, it } from 'vitest';
import { TABLE } from '@/sim/constants';
import { MatchSim } from '@/sim/MatchSim';

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** 电脑对电脑打几局，记下每一拍的击球点、节奏 */
function play(level: number, games: number) {
  const side: number[] = [];
  const smashBack: number[] = [];
  const flight: number[] = [];
  const interval: number[] = [];
  for (let g = 0; g < games; g++) {
    const sim = new MatchSim({ points: 6, seed: 4200 + g, cpu: { near: level, far: level } });
    let last: { t: number; side: string; serve: boolean; kind: string } | null = null;
    while (sim.phase.kind !== 'gameOver') {
      sim.tick();
      for (const e of sim.drainEvents()) {
        if (e.type === 'bounce' && last && !last.serve && e.side !== last.side)
          flight.push(e.t - last.t);
        if (e.type === 'hit') {
          if (!e.serve) {
            side.push(Math.abs(e.p.x) - TABLE.halfWidth);
            if (last && last.side !== e.side) interval.push(e.t - last.t);
            if (last?.kind === 'smash') smashBack.push(Math.abs(e.p.y) - TABLE.halfLength);
          }
          last = { t: e.t, side: e.side, serve: e.serve, kind: e.kind };
        }
        if (e.type === 'point') last = null;
      }
    }
  }
  return { side, smashBack, flight, interval };
}

describe('跑动范围（像 WSR：打得开、接扣杀退到台后）', () => {
  it('高手对打：三成以上的球在边线外接，接扣杀退到台后 1 米以外，节奏不变', () => {
    const r = play(4, 8);
    const outside = r.side.filter((d) => d > 0).length / r.side.length;
    expect(outside).toBeGreaterThan(0.3);
    expect(r.smashBack.length).toBeGreaterThan(10);
    expect(median(r.smashBack)).toBeGreaterThan(1.0);
    // 节奏还是 NSSR 实测的样子：击球到落台约 0.57 秒，两拍间隔约 0.92 秒
    expect(median(r.flight)).toBeGreaterThan(0.5);
    expect(median(r.flight)).toBeLessThan(0.62);
    expect(median(r.interval)).toBeGreaterThan(0.85);
    expect(median(r.interval)).toBeLessThan(1.02);
  });
});
