import { describe, expect, it } from 'vitest';
import { cpuLevel } from '@/config/difficulty';
import { Rng } from '@/core/rng';
import { chooseIntent, type IncomingInfo } from '@/sim/ai/ShotPlanner';
import type { ContactPlan } from '@/sim/hit/contactZone';

/** 远端电脑接的一个来球：前后速度 vy（m/s）、旋转 w（rad/s）、离中线 x */
const incoming = (vy: number, w: number, x: number): IncomingInfo => ({
  side: 'far',
  handed: 1,
  stance: 'fh',
  contact: {
    ok: true,
    receiver: 'far',
    p: { x, y: 1.9, z: 0.98 },
    v: { x: 0, y: vy, z: -0.5 },
    w: { x: w, y: 0, z: 0 },
  } as unknown as ContactPlan,
  popup: false,
  smash: false,
  smashBeaten: false,
  oppX: 0,
  rallyHits: 3,
  pace: 1,
});

/** 同一个来球选 n 次，各种快慢出现的比例和平均球速倍率 */
function sample(info: IncomingInfo, n = 600) {
  const rng = new Rng(7);
  const lv = cpuLevel(3);
  const count: Record<string, number> = {};
  let sum = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const it = chooseIntent(info, lv, rng);
    count[it.tempo] = (count[it.tempo] ?? 0) + 1;
    if (it.tempo !== 'angle') {
      sum += it.speedMul;
      k++;
    }
  }
  return { share: (t: string) => (count[t] ?? 0) / n, speed: sum / k };
}

describe('电脑回球的快慢由来球决定（不是随机）', () => {
  it('来球慢、不转、在中间：常抢攻打快；来球快、转、偏到边上：挡、搓，回得慢', () => {
    const easy = sample(incoming(1.8, 0, 0));
    const hard = sample(incoming(5, 250, 0.7));
    expect(easy.share('attack')).toBeGreaterThan(0.4);
    expect(hard.share('attack')).toBe(0);
    expect(hard.share('control')).toBeGreaterThan(0.7);
    expect(easy.speed).toBeGreaterThan(hard.speed * 1.2);
  });

  it('短斜线带往外拐的侧旋，落在靠网的地方', () => {
    const rng = new Rng(3);
    const lv = { ...cpuLevel(3), angleUse: 1 };
    for (let i = 0; i < 50; i++) {
      const it = chooseIntent(incoming(3, 50, 0.4), lv, rng);
      expect(it.tempo).toBe('angle');
      expect(Math.abs(it.target.y)).toBeLessThan(0.7);
      // 远端打过来（往 −y 飞）：落在 −x 一侧时侧旋为负（往 −x 拐），+x 一侧为正
      expect(Math.sign(it.sidespin)).toBe(Math.sign(it.target.x));
    }
  });
});
