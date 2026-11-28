import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng';
import { NO_FEATURES, type SwingInput } from '@/sim/hit/HitResolver';
import { type MatchEvent, MatchSim } from '@/sim/MatchSim';
import { applyRemote, type OnlineMsg, outgoing } from '@/sim/online/link';

const swingAt = (id: number, tDetect: number, tContact: number, dir: 1 | -1): SwingInput => ({
  id,
  motion: id,
  path: 'fast',
  tDetect,
  tContact,
  dir,
  yawFrac: 0.9,
  wPeak: 16,
  features: NO_FEATURES,
});

/** 一台电脑上的人（脚本）：轮到发球就抛球、理想时刻发球，来球在理想时刻附近挥拍 */
class Bot {
  private id = 1;
  private servedFor: object | null = null;
  private swungFor = -1;
  private errFor = -1;
  private err = 0;
  constructor(
    private readonly sim: MatchSim,
    private readonly rng: Rng,
    private readonly sigmaMs: number
  ) {}

  step(): void {
    const sim = this.sim;
    const h = sim.human('near')!;
    if (h.canToss(sim)) sim.humanToss('near', sim.tune.serve.buttonTossHeight);
    const sa = h.serveAt;
    if (sa && this.servedFor !== sa && sim.t >= sa.ideal - 0.07) {
      this.servedFor = sa;
      sim.humanSwing('near', swingAt(this.id++, sim.t, sa.ideal, 1));
    }
    const plan = h.plan;
    if (plan && h.awaitingSwing && this.swungFor !== sim.rallyHits) {
      if (this.errFor !== sim.rallyHits) {
        this.errFor = sim.rallyHits;
        this.err = this.rng.normal(0, this.sigmaMs) / 1000;
      }
      const tc = plan.t + this.err;
      if (sim.t >= tc - 0.07) {
        this.swungFor = sim.rallyHits;
        sim.humanSwing(
          'near',
          swingAt(this.id++, sim.t, tc, sim.players.near.stance === 'fh' ? 1 : -1)
        );
      }
    }
  }
}

/**
 * 两台电脑：开房间的一方 A 先发球，加入的一方 B 晚 4 秒开始（两边的仿真时钟差 4 秒），
 * 消息单程延迟 latency 秒。各自把自己放在近端，对方在远端
 */
function playOnline(latency: number, maxT = 240, seed = 5) {
  const a = new MatchSim({ seed, remote: 'far', firstServer: 'near' });
  const b = new MatchSim({ seed: seed + 1, remote: 'far', firstServer: 'far' });
  for (let i = 0; i < 960; i++) b.tick();
  b.drainEvents();
  const clockAtoB = b.t - a.t;
  const bots = [new Bot(a, new Rng(seed), 70), new Bot(b, new Rng(seed + 7), 70)];
  const queues: { at: number; msg: OnlineMsg }[][] = [[], []];
  const logs: MatchEvent[][] = [[], []];
  const sims = [a, b];
  while (a.t < maxT && a.phase.kind !== 'gameOver') {
    for (let i = 0; i < 2; i++) {
      const sim = sims[i];
      const other = sims[1 - i];
      sim.tick();
      bots[i].step();
      for (const e of sim.drainEvents()) {
        logs[i].push(e);
        const msg = outgoing(e, 'near');
        // 对方收到的时刻（对方的仿真时间）
        if (msg) queues[1 - i].push({ at: other.t + latency, msg });
      }
      // 到时间的消息交给这一边
      const q = queues[i];
      const clock = i === 1 ? clockAtoB : -clockAtoB;
      while (q.length && q[0].at <= sim.t) applyRemote(sim, q.shift()!.msg, (t) => t + clock);
    }
  }
  const pts = (l: MatchEvent[]) =>
    l.filter((e): e is Extract<MatchEvent, { type: 'point' }> => e.type === 'point');
  return { a, b, pa: pts(logs[0]), pb: pts(logs[1]), logs };
}

describe('远程对打：两台电脑的比分一致', () => {
  for (const latency of [0.005, 0.04, 0.09]) {
    it(`单程延迟 ${latency * 1000}ms：每一分两边都记成同一个人得分，有来有回`, () => {
      const r = playOnline(latency);
      expect(r.pa.length).toBeGreaterThan(5);
      expect(r.pb.length).toBe(r.pa.length);
      for (let i = 0; i < r.pa.length; i++) {
        // A 的近端 = B 的远端
        expect(r.pb[i].winner === 'far').toBe(r.pa[i].winner === 'near');
        expect(r.pb[i].reason).toBe(r.pa[i].reason);
      }
      expect(r.b.scoring.score.far).toBe(r.a.scoring.score.near);
      expect(r.b.scoring.score.near).toBe(r.a.scoring.score.far);
      // 两边的击球都传过去了：平均每分不止一来一回
      const hits = r.logs[0].filter((e) => e.type === 'hit').length;
      expect(hits / r.pa.length).toBeGreaterThan(3);
    });
  }
});
