import { describe, expect, it } from 'vitest';
import type { Quat } from '@/core/quat';
import type { PaddleModel } from '@/input/paddle/PaddleModel';
import { humanPaddle } from '@/app/shared/motionPlay';
import { MatchSim } from '@/sim/MatchSim';

/** 只给出朝向的设备（设备坐标：+y = 指向电视的正手面法向，+z = 拍头，+x = 右手边） */
const device = (q: Quat) => ({ paddleQuat: () => q }) as unknown as PaddleModel;
const IDENTITY: Quat = { w: 1, x: 0, y: 0, z: 0 };
/** 绕设备 y 轴转 90°：拍头从朝上转到朝右手边 */
const HEAD_RIGHT: Quat = { w: Math.SQRT1_2, x: 0, y: Math.SQRT1_2, z: 0 };

describe('玩家的 1:1 球拍：近端、远端都按自己面朝的方向摆', () => {
  const sim = new MatchSim({ seed: 1 });
  const { near, far } = sim.players;

  it('拍面朝电视 = 朝对面：近端朝 +y，远端朝 −y', () => {
    expect(humanPaddle(device(IDENTITY), near, { x: 0, y: -2 }, 0).normal.y).toBeCloseTo(1, 5);
    expect(humanPaddle(device(IDENTITY), far, { x: 0, y: 2 }, 0).normal.y).toBeCloseTo(-1, 5);
  });

  it('拍头指向右手边：近端的右边是 +x，远端的右边是 −x，手也跟着到那一边', () => {
    const n = humanPaddle(device(HEAD_RIGHT), near, { x: 0, y: -2 }, 0);
    const f = humanPaddle(device(HEAD_RIGHT), far, { x: 0, y: 2 }, 0);
    expect(-n.handle.x).toBeCloseTo(1, 5);
    expect(-f.handle.x).toBeCloseTo(-1, 5);
    expect(n.pos.x).toBeGreaterThan(0.2);
    expect(f.pos.x).toBeLessThan(-0.2);
  });
});
