import { describe, expect, it } from 'vitest';
import { type MatchEvent, MatchSim } from '@/sim/MatchSim';

/** 摆一个「近端扣杀过来、已经合法落在远端台面、远端的人接不住缩着头」的球，朝远端的人飞 */
function incoming(
  z: number,
  receiverX = 0,
  cowering = true
): { sim: MatchSim; events: MatchEvent[] } {
  const sim = new MatchSim({ seed: 1, cpu: { near: 3, far: 1 } });
  const s = sim as unknown as {
    phase: MatchSim['phase'];
    referee: { state: string };
    inFlight: MatchSim['inFlight'];
    ballFree: boolean;
  };
  s.phase = { kind: 'play', since: sim.t };
  s.referee.state = 'rallyBounced';
  s.inFlight = {
    hitter: 'near',
    kind: 'smash',
    popup: false,
    smash: true,
    serve: false,
    t: sim.t,
  };
  s.ballFree = true;
  sim.players.far.mover.teleport(receiverX, 2.2);
  sim.players.far.cowering = cowering;
  sim.ball.p = { x: 0, y: 1.8, z };
  sim.ball.v = { x: 0, y: 8, z: 0 };
  sim.ball.w = { x: 0, y: 0, z: 0 };
  const events: MatchEvent[] = [];
  for (let i = 0; i < 40; i++) {
    sim.tick();
    events.push(...sim.drainEvents());
  }
  return { sim, events };
}

describe('球打到人：落在接球方台面后没接住，打到了他', () => {
  it('打到头（缩着头，头心约 1.15 米）：打到脸上，击球方得分，球弹回来', () => {
    const { sim, events } = incoming(1.15);
    const hit = events.find((e) => e.type === 'bodyHit');
    expect(hit && hit.type === 'bodyHit' && hit.part).toBe('face');
    const point = events.find((e) => e.type === 'point');
    expect(point && point.type === 'point' && [point.winner, point.reason]).toEqual([
      'near',
      'face',
    ]);
    expect(sim.ball.v.y).toBeLessThan(0);
  });

  it('打到胸口：打到身上', () => {
    const { events } = incoming(0.8);
    const point = events.find((e) => e.type === 'point');
    expect(point && point.type === 'point' && point.reason).toBe('body');
  });

  it('从身边过去（离开半米）不算', () => {
    const { events } = incoming(1.0, 0.5);
    expect(events.some((e) => e.type === 'bodyHit')).toBe(false);
  });

  it('没缩头的人（正常站位，只是没打到）不算', () => {
    const { events } = incoming(1.0, 0, false);
    expect(events.some((e) => e.type === 'bodyHit')).toBe(false);
  });
});
