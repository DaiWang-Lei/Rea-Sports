import { describe, expect, it } from 'vitest';
import { createTuning } from '@/config/tuning';
import { TABLE } from '@/sim/constants';
import { MatchSim } from '@/sim/MatchSim';
import { Mover } from '@/sim/players/Mover';
import { bodyForContact, keepOffTable } from '@/sim/players/PlayerSim';

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** 电脑对电脑打几局，记下每一拍的击球点、节奏 */
function play(level: number, games: number) {
  const side: number[] = [];
  const smashBack: number[] = [];
  const flight: number[] = [];
  const interval: number[] = [];
  /** 击球时人站在球台侧面（离网比台端还近、在台面左右以外） */
  let beside = 0;
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
            const m = sim.players[e.side].mover;
            if (Math.abs(m.y) < 1.45 && Math.abs(m.x) > TABLE.halfWidth) beside++;
            if (last && last.side !== e.side) interval.push(e.t - last.t);
            if (last?.kind === 'smash') smashBack.push(Math.abs(e.p.y) - TABLE.halfLength);
          }
          last = { t: e.t, side: e.side, serve: e.serve, kind: e.kind };
        }
        if (e.type === 'point') last = null;
      }
    }
  }
  return { side, smashBack, flight, interval, beside };
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

describe('球台侧面（像 WSR：短斜线要跑到台边去接）', () => {
  const tune = createTuning();
  const near = { side: 'near' as const, handed: 1 as const };

  it('人不能走进球台：走进去了推回到最近的那条边（台端后面或台边外面）', () => {
    const behind = new Mover(0.3, -1.2);
    keepOffTable(behind, tune);
    expect(behind.y).toBeCloseTo(-tune.mover.minDepth);
    const side = new Mover(0.85, -0.6);
    keepOffTable(side, tune);
    expect(side.x).toBeCloseTo(TABLE.halfWidth + tune.mover.sideClear);
    const outside = new Mover(1.2, -0.6);
    keepOffTable(outside, tune);
    expect(outside.x).toBe(1.2);
  });

  it('击球点出了台边够远就站到球台侧面，否则站在台端后面', () => {
    const wide = bodyForContact(near, { x: -1.3, y: -1.05 }, 'bh', tune);
    expect(Math.abs(wide.x)).toBeGreaterThan(TABLE.halfWidth + tune.mover.sideClear);
    expect(Math.abs(wide.y)).toBeLessThan(TABLE.halfLength);
    const inside = bodyForContact(near, { x: 0.3, y: -0.9 }, 'fh', tune);
    expect(inside.y).toBeCloseTo(-tune.mover.minDepth);
  });

  it('高手对打：有的球要跑到球台侧面接', () => {
    const r = play(4, 8);
    expect(r.beside / r.side.length).toBeGreaterThan(0.005);
  });
});
