import { describe, expect, it } from 'vitest';
import { createTuning } from '@/config/tuning';
import { DEG } from '@/core/math';
import { Rng } from '@/core/rng';
import { vec3 } from '@/core/vec3';
import type { ContactPlan } from '@/sim/hit/contactZone';
import {
  HitResolver,
  mapSwing,
  type MapContext,
  NO_FEATURES,
  resolverConfig,
  type SwingInput,
} from '@/sim/hit/HitResolver';
import { TABLE } from '@/sim/constants';

const tune = createTuning();

function plan(bounceT = 1.0, t = 1.12): ContactPlan {
  return {
    ok: true,
    receiver: 'near',
    bounceT,
    bounceP: vec3(0.2, -0.9, TABLE.height),
    t,
    p: vec3(0.3, -1.62, TABLE.height + 0.22),
    v: vec3(0, -5, -0.5),
    w: vec3(),
    popup: false,
    prediction: { states: [], events: [], t0: 0 },
  };
}

function swing(over: Partial<SwingInput>): SwingInput {
  return {
    id: 1,
    motion: 1,
    path: 'fast',
    tDetect: 1.05,
    tContact: 1.12,
    dir: 1,
    yawFrac: 0.9,
    wPeak: 18,
    features: NO_FEATURES,
    ...over,
  };
}

function resolver() {
  const r = new HitResolver(resolverConfig(tune, 90));
  r.begin({ plan: plan(), popup: false, smash: false });
  return r;
}

describe('击球判定', () => {
  it('准时：击中，在理想时刻执行', () => {
    const r = resolver();
    const o = r.onSwing(swing({}));
    expect(o.type).toBe('hit');
    if (o.type === 'hit') {
      expect(o.execAt).toBeCloseTo(1.12, 5);
      expect(o.stroke).toBe('fh');
      expect(Math.abs(o.tau)).toBeLessThan(0.01);
    }
    expect(r.due(1.11)).toBeNull();
    expect(r.due(1.12)?.swing.id).toBe(1);
    // 每个来球只算一次
    expect(r.onSwing(swing({ id: 2, motion: 2 })).type).toBe('ignore');
  });

  it('偏早 / 偏晚 / 太早忽略 / 慢挥拍偏早忽略', () => {
    let r = resolver();
    expect(r.onSwing(swing({ tContact: 1.12 + 0.13 })).type).toBe('whiff');
    r = resolver();
    expect(r.onSwing(swing({ tContact: 1.12 - 0.4 })).type).toBe('ignore');
    r = resolver();
    expect(r.onSwing(swing({ path: 'gentle', tContact: 1.02 - 0.1 })).type).toBe('ignore');
    r = resolver();
    const early = r.onSwing(swing({ tContact: 1.12 - 0.25 }));
    // 比落台还早 130ms → 挥早（弹起前 100ms 以外），先挂起 0.45 秒，没人取代就算数
    expect(early.type === 'held' && early.miss.type === 'whiff' && early.miss.reason).toBe('early');
    expect(r.dueHeld(1.05 + 0.44)).toBeNull();
    expect(r.attempted).toBe(false);
    expect(r.dueHeld(1.05 + 0.45)?.type).toBe('whiff');
    expect(r.attempted).toBe(true);
  });

  it('未落台击球：弹起前 100ms 内挥得够快；落台前 20ms 以内不算', () => {
    let r = resolver();
    const v = r.onSwing(swing({ tContact: 0.95 }));
    expect(v.type === 'held' && v.miss.type).toBe('volley');
    expect(r.dueHeld(2)?.type).toBe('volley');
    r = resolver();
    expect(r.onSwing(swing({ tContact: 0.99 })).type).toBe('hit');
  });

  it('快的引拍落进「挥早」时先挂起，0.45 秒内反方向更快的前挥取代它', () => {
    // 引拍：顺时针 14 rad/s，比理想时刻早 250ms；前挥：逆时针 22 rad/s，晚 40ms
    const r = resolver();
    const back = r.onSwing(
      swing({ id: 1, motion: 1, dir: -1, wPeak: 14, tDetect: 0.79, tContact: 0.87 })
    );
    expect(back.type).toBe('held');
    const fwd = r.onSwing(
      swing({ id: 2, motion: 2, dir: 1, wPeak: 22, tDetect: 1.09, tContact: 1.16 })
    );
    expect(fwd.type).toBe('hit');
    expect(r.pending?.swing.id).toBe(2);
    expect(r.dueHeld(5)).toBeNull();
  });

  it('未落台也能被前挥取代', () => {
    const r = resolver();
    expect(
      r.onSwing(swing({ id: 1, dir: -1, wPeak: 12, tDetect: 0.88, tContact: 0.95 })).type
    ).toBe('held');
    expect(r.onSwing(swing({ id: 2, dir: 1, wPeak: 20, tDetect: 1.05 })).type).toBe('hit');
  });

  it('挂起期间：同方向、更慢、或隔得太久的挥拍不能取代，到期算挥早', () => {
    let r = resolver();
    r.onSwing(swing({ id: 1, dir: 1, wPeak: 18, tDetect: 0.79, tContact: 0.87 }));
    // 同方向更快：不取代（连挥两下正手，第一下挥早就是挥早）
    expect(r.onSwing(swing({ id: 2, dir: 1, wPeak: 24, tDetect: 1.0 })).type).toBe('ignore');
    // 反方向但更慢：不取代（收拍）
    expect(r.onSwing(swing({ id: 3, dir: -1, wPeak: 10, tDetect: 1.05 })).type).toBe('ignore');
    expect(r.dueHeld(0.79 + 0.45)?.type).toBe('whiff');
    r = resolver();
    expect(r.onSwing(swing({ id: 1, dir: -1, wPeak: 14, tDetect: 0.7, tContact: 0.85 })).type).toBe(
      'held'
    );
    // 0.5 秒后才来：不取代
    expect(r.onSwing(swing({ id: 2, dir: 1, wPeak: 22, tDetect: 1.2 })).type).toBe('ignore');
  });

  it('同一动作里更快的前向挥拍取代慢的引拍', () => {
    const r = resolver();
    const a = r.onSwing(
      swing({ id: 1, path: 'gentle', dir: -1, wPeak: 8, tContact: 1.05, tDetect: 1.07 })
    );
    expect(a.type).toBe('hit');
    const b = r.onSwing(swing({ id: 2, path: 'fast', dir: 1, wPeak: 20, tDetect: 1.09 }));
    expect(b.type).toBe('hit');
    expect(r.pending?.swing.id).toBe(2);
    expect(r.pending?.stroke).toBe('fh');
  });

  it('方向不明（上下挥）时按站位', () => {
    const r = resolver();
    r.stance = 'bh';
    const o = r.onSwing(swing({ dir: 0, yawFrac: 0.1 }));
    expect(o.type === 'hit' && o.stroke).toBe('bh');
  });
});

function ctx(over: Partial<MapContext>): MapContext {
  return {
    side: 'near',
    handed: 1,
    stroke: 'fh',
    tau: 0,
    wPeak: 16,
    features: NO_FEATURES,
    contact: vec3(0.2, -1.6, TABLE.height + 0.22),
    vIn: vec3(0, -5, 0),
    wIn: vec3(),
    popupIn: false,
    smashIn: false,
    reachError: 0,
    pace: 1,
    leniency: 1,
    ...over,
  };
}

describe('击球映射', () => {
  const avgX = (o: Partial<MapContext>) => {
    const rng = new Rng(5);
    let sum = 0;
    for (let i = 0; i < 40; i++) sum += mapSwing(ctx(o), rng, tune).spec.target.x;
    return sum / 40;
  };

  it('早打斜线、晚打直线（右手正手：早 → 左，晚 → 右；反手相反）', () => {
    expect(avgX({ tau: -1 })).toBeLessThan(avgX({ tau: 0 }) - 0.3);
    expect(avgX({ tau: 1 })).toBeGreaterThan(avgX({ tau: 0 }) + 0.3);
    expect(avgX({ tau: -1, stroke: 'bh' })).toBeGreaterThan(avgX({ tau: 0, stroke: 'bh' }) + 0.3);
  });

  it('挥得越快球越快', () => {
    const rng = new Rng(1);
    const slow = mapSwing(ctx({ wPeak: 8 }), rng, tune).spec.speedH;
    const fast = mapSwing(ctx({ wPeak: 22 }), rng, tune).spec.speedH;
    expect(fast).toBeGreaterThan(slow * 1.6);
  });

  it('拍面前压 → 上旋；后仰 → 下旋', () => {
    const rng = new Rng(2);
    const top = mapSwing(ctx({ features: { ...NO_FEATURES, facePitch: -30 * DEG } }), rng, tune);
    const back = mapSwing(ctx({ features: { ...NO_FEATURES, facePitch: 35 * DEG } }), rng, tune);
    expect(top.spec.topspin).toBeGreaterThan(100);
    expect(back.spec.topspin).toBeLessThan(0);
    expect(back.spec.kind).toBe('cut');
  });

  it('向上刷球增加上旋（不需要校准）', () => {
    const rng = new Rng(3);
    const up = mapSwing(ctx({ features: { ...NO_FEATURES, brush: 40 * DEG } }), rng, tune);
    const down = mapSwing(ctx({ features: { ...NO_FEATURES, brush: -40 * DEG } }), rng, tune);
    expect(up.spec.topspin).toBeGreaterThan(down.spec.topspin + 50);
  });

  it('站位差太多 → 哎呀高球；对高球大力挥拍 → 扣杀', () => {
    const rng = new Rng(4);
    expect(mapSwing(ctx({ reachError: 0.3 }), rng, tune).spec.oops).toBe(true);
    const sm = mapSwing(
      ctx({ popupIn: true, contact: vec3(0, -1.5, TABLE.height + 0.6), wPeak: 20 }),
      rng,
      tune
    );
    expect(sm.spec.smash).toBe(true);
    expect(sm.spec.speedH).toBeGreaterThan(14);
  });
});
