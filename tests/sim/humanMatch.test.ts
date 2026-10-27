import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng';
import { NO_FEATURES, type SwingInput } from '@/sim/hit/HitResolver';
import { type MatchEvent, MatchSim } from '@/sim/MatchSim';
import { BUTTON_TOSS_HEIGHT } from '@/sim/players/HumanPlayer';

function swingAt(
  id: number,
  tDetect: number,
  tContact: number,
  dir: 1 | -1,
  wPeak = 16
): SwingInput {
  return {
    id,
    motion: id,
    path: 'fast',
    tDetect,
    tContact,
    dir,
    yawFrac: 0.9,
    wPeak,
    features: NO_FEATURES,
  };
}

interface Bot {
  /** 回球的时机误差（毫秒，标准差）；null = 不挥拍 */
  sigmaMs: number | null;
  /** 发球：抛球后在理想时刻 + serveOffsetMs 挥拍；null = 抛了也不挥；toss = false 不抛球 */
  serveOffsetMs?: number | null;
  toss?: boolean;
  /**
   * 回球时故意在弹台前这么多秒挥拍，用来造未落台击球。只对「弹台到理想击球点」不到 0.25 秒的快球这样做：
   * 慢球的理想击球点在弹起后约 0.45 秒（下降段），弹台前的挥拍比理想时刻早 5 个窗口以上，按准备动作忽略
   */
  volleyLead?: number;
}

/** 让脚本当人：轮到发球就抛球，来球在理想时刻附近挥拍。最多打 maxT 秒（仿真时间） */
function play(sim: MatchSim, bot: Bot, maxT = 600, seed = 3): MatchEvent[] {
  const h = sim.human('near')!;
  const rng = new Rng(seed);
  const log: MatchEvent[] = [];
  let id = 1;
  let servedFor: object | null = null;
  let swungFor = -1;
  // 每个来球只抽一次时机误差（每一帧重抽会偏早：哪一帧先抽到「到了」就挥）
  let errFor = -1;
  let err = 0;
  while (sim.phase.kind !== 'gameOver' && sim.t < maxT) {
    sim.tick();
    log.push(...sim.drainEvents());
    if (bot.toss !== false && h.canToss(sim)) sim.humanToss('near', BUTTON_TOSS_HEIGHT);
    const sa = h.serveAt;
    if (sa && bot.serveOffsetMs !== null && servedFor !== sa) {
      const tc = sa.ideal + (bot.serveOffsetMs ?? 0) / 1000;
      if (sim.t >= tc - 0.07) {
        servedFor = sa;
        sim.humanSwing('near', swingAt(id++, sim.t, tc, 1));
      }
    }
    const plan = h.plan;
    if (bot.sigmaMs !== null && plan && h.awaitingSwing && swungFor !== sim.rallyHits) {
      if (errFor !== sim.rallyHits) {
        errFor = sim.rallyHits;
        err = rng.normal(0, bot.sigmaMs) / 1000;
      }
      const volley = bot.volleyLead !== undefined && plan.t - plan.bounceT < 0.25;
      const tc = volley ? plan.bounceT - bot.volleyLead! : plan.t + err;
      if (sim.t >= tc - 0.07) {
        swungFor = sim.rallyHits;
        const dir = sim.players.near.stance === 'fh' ? 1 : -1;
        sim.humanSwing('near', swingAt(id++, sim.t, tc, dir, rng.uniform(13, 20)));
      }
    }
  }
  return log;
}

const points = (log: MatchEvent[]) =>
  log.filter((e): e is Extract<MatchEvent, { type: 'point' }> => e.type === 'point');

describe('比赛：人对电脑', () => {
  it('时机准的人能打完一整局，比分合法，每一拍都带时机信息', () => {
    for (const [seed, level] of [
      [1, 1],
      [2, 3],
      [3, 5],
    ] as const) {
      const sim = new MatchSim({ seed, cpu: { far: level } });
      const log = play(sim, { sigmaMs: 15, serveOffsetMs: 0 }, 900, seed);
      expect(sim.phase.kind).toBe('gameOver');
      const { near, far } = sim.scoring.score;
      expect(Math.max(near, far)).toBeGreaterThanOrEqual(6);
      expect(Math.abs(near - far)).toBeGreaterThanOrEqual(2);
      expect(points(log).length).toBe(near + far);
      // 人发球、回球都带时机
      const mine = log.filter((e) => e.type === 'hit' && e.side === 'near');
      expect(mine.length).toBeGreaterThan(5);
      for (const e of mine) if (e.type === 'hit') expect(e.human).toBeDefined();
      expect(mine.some((e) => e.type === 'hit' && e.serve)).toBe(true);
      expect(mine.some((e) => e.type === 'hit' && !e.serve)).toBe(true);
      // 对入门电脑应该能赢
      if (level === 1) expect(near).toBeGreaterThan(far);
    }
  });

  it('人发球：先落本方台再过网落对方台（不会发球失误）', () => {
    for (const off of [-350, -200, -60, 0, 40, 70]) {
      const sim = new MatchSim({ seed: 9, cpu: { far: 3 } });
      const log: MatchEvent[] = [];
      let swung = false;
      const h = sim.human('near')!;
      while (sim.t < 20 && !log.some((e) => e.type === 'point')) {
        sim.tick();
        log.push(...sim.drainEvents());
        if (h.canToss(sim)) sim.humanToss('near', BUTTON_TOSS_HEIGHT);
        const sa = h.serveAt;
        if (sa && !swung && sim.t >= sa.ideal + off / 1000 - 0.07) {
          swung = true;
          sim.humanSwing('near', swingAt(1, sim.t, sa.ideal + off / 1000, 1));
        }
      }
      const serve = log.findIndex((e) => e.type === 'hit' && e.serve);
      expect(serve).toBeGreaterThanOrEqual(0);
      const bounces = log.slice(serve).filter((e) => e.type === 'bounce');
      expect(bounces[0]?.type === 'bounce' && bounces[0].side).toBe('near');
      expect(bounces[1]?.type === 'bounce' && bounces[1].side).toBe('far');
      const p = points(log)[0];
      if (p) expect(p.reason).not.toBe('serveFault');
    }
  });

  it('发球的时机定左右：正手早打斜线（对方左半台，x < 0），晚打直线（x > 0）', () => {
    const landingX = (offMs: number) => {
      const sim = new MatchSim({ seed: 4, cpu: { far: 3 } });
      const h = sim.human('near')!;
      let swung = false;
      let served = false;
      while (sim.t < 10) {
        sim.tick();
        for (const e of sim.drainEvents()) {
          if (e.type === 'hit' && e.serve) served = true;
          if (served && e.type === 'bounce' && e.side === 'far') return e.p.x;
        }
        if (h.canToss(sim)) sim.humanToss('near', BUTTON_TOSS_HEIGHT);
        const sa = h.serveAt;
        if (sa && !swung && sim.t >= sa.ideal + offMs / 1000 - 0.07) {
          swung = true;
          sim.humanSwing('near', swingAt(1, sim.t, sa.ideal + offMs / 1000, 1));
        }
      }
      throw new Error('发球没有落到对方台面');
    };
    // 理想时刻 = 球落回手上方 15cm；早的一侧到最高点前 0.1 秒，晚的一侧到球掉到台面高度（约 85ms）
    const early = landingX(-350);
    const center = landingX(0);
    const late = landingX(60);
    expect(early).toBeLessThan(center - 0.3);
    expect(late).toBeGreaterThan(center + 0.04);
    expect(late - early).toBeGreaterThan(0.4);
  });

  it('抛了球不挥拍：球落下后重抛，不罚分', () => {
    const sim = new MatchSim({ seed: 5, cpu: { far: 3 } });
    const log = play(sim, { sigmaMs: null, serveOffsetMs: null }, 8);
    expect(log.filter((e) => e.type === 'toss').length).toBeGreaterThanOrEqual(3);
    expect(points(log).length).toBe(0);
    expect(sim.scoring.score).toEqual({ near: 0, far: 0 });
  });

  it('发球挥得太早（比最高点早 0.1 秒以上）：当准备动作忽略，不算挥空，球落下来再挥照样发出去', () => {
    const sim = new MatchSim({ seed: 6, cpu: { far: 3 } });
    const h = sim.human('near')!;
    const log: MatchEvent[] = [];
    let early = false;
    let onTime = false;
    while (sim.t < 6 && !log.some((e) => e.type === 'hit' && e.serve)) {
      sim.tick();
      log.push(...sim.drainEvents());
      if (h.canToss(sim)) sim.humanToss('near', BUTTON_TOSS_HEIGHT);
      const sa = h.serveAt;
      if (sa && !early && sim.t >= sa.apex - 0.2 - 0.07) {
        early = true;
        expect(sim.humanSwing('near', swingAt(1, sim.t, sa.apex - 0.2, 1)).type).toBe('ignore');
      }
      if (sa && early && !onTime && sim.t >= sa.ideal - 0.07) {
        onTime = true;
        sim.humanSwing('near', swingAt(2, sim.t, sa.ideal, 1));
      }
    }
    expect(log.some((e) => e.type === 'whiff')).toBe(false);
    expect(log.filter((e) => e.type === 'toss').length).toBe(1);
    expect(log.some((e) => e.type === 'hit' && e.serve)).toBe(true);
  });

  it('理想时刻（球落回手上方 15cm）前后 70ms 内击中是强力发球，比早挥打在高处的普通发球快得多', () => {
    const serveAt = (offMs: number) => {
      const sim = new MatchSim({ seed: 13, cpu: { far: 3 } });
      const h = sim.human('near')!;
      let swung = false;
      while (sim.t < 6) {
        sim.tick();
        for (const e of sim.drainEvents()) if (e.type === 'hit' && e.serve) return e;
        if (h.canToss(sim)) sim.humanToss('near', BUTTON_TOSS_HEIGHT);
        const sa = h.serveAt;
        if (sa && !swung && sim.t >= sa.ideal + offMs / 1000 - 0.07) {
          swung = true;
          sim.humanSwing('near', swingAt(1, sim.t, sa.ideal + offMs / 1000, 1));
        }
      }
      throw new Error('没有发出去');
    };
    const power = serveAt(30);
    const normal = serveAt(-200);
    expect(power.type === 'hit' && power.powerServe).toBe(true);
    expect(normal.type === 'hit' && normal.powerServe).toBeFalsy();
    expect(power.speed).toBeGreaterThan(normal.speed * 1.3);
  });

  it('只发球不回球：对方得分，原因是没接到 / 两跳', () => {
    const sim = new MatchSim({ seed: 7, cpu: { far: 5 } });
    const log = play(sim, { sigmaMs: null, serveOffsetMs: 0 }, 900);
    expect(sim.phase.kind).toBe('gameOver');
    const ps = points(log);
    // 电脑接发球偶尔失误；其余每一分都是人没接
    const lost = ps.filter((p) => p.winner === 'far');
    expect(lost.length).toBeGreaterThanOrEqual(6);
    for (const p of lost) expect(['missed', 'doubleBounce']).toContain(p.reason);
  });

  it('来球还没在本方弹起就挥中：判未落台击球，对方得分', () => {
    const sim = new MatchSim({ seed: 8, cpu: { far: 5 } });
    const log = play(sim, { sigmaMs: 10, serveOffsetMs: 0, volleyLead: 0.04 }, 900);
    const ps = points(log);
    const volleys = ps.filter((p) => p.reason === 'volley');
    expect(volleys.length).toBeGreaterThan(0);
    for (const p of volleys) expect(p.winner).toBe('far');
    expect(log.some((e) => e.type === 'whiff' && e.reason === 'volley')).toBe(true);
  });

  it('中断这一分（暂停 / 手柄断开）：不记分，重新发球', () => {
    const sim = new MatchSim({ seed: 10, cpu: { far: 3 } });
    const h = sim.human('near')!;
    while (sim.phase.kind !== 'play' && sim.t < 10) {
      sim.tick();
      if (h.canToss(sim)) sim.humanToss('near', BUTTON_TOSS_HEIGHT);
      const sa = h.serveAt;
      if (sa && sim.t >= sa.ideal - 0.07) sim.humanSwing('near', swingAt(1, sim.t, sa.ideal, 1));
    }
    expect(sim.phase.kind).toBe('play');
    sim.drainEvents();
    sim.interruptPoint();
    expect(sim.drainEvents().some((e) => e.type === 'replay')).toBe(true);
    expect(sim.phase.kind).toBe('preServe');
    expect(sim.scoring.score).toEqual({ near: 0, far: 0 });
    expect(sim.ballFree).toBe(false);
  });

  it('同一种子、同样的输入得到同样的比赛', () => {
    const run = () => {
      const sim = new MatchSim({ seed: 12, cpu: { far: 2 } });
      return play(sim, { sigmaMs: 25, serveOffsetMs: 20 }, 120, 5)
        .map((e) => `${e.type}:${e.t.toFixed(4)}`)
        .join('|');
    };
    expect(run()).toBe(run());
  });
});
