import { describe, expect, it } from 'vitest';
import type { Quat } from '@/core/quat';
import type { PaddleModel } from '@/input/paddle/PaddleModel';
import { HumanPaddle, humanPaddle } from '@/app/shared/motionPlay';
import { TABLE } from '@/sim/constants';
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

describe('画面上的球拍：跟手柄和挥拍动画之间平滑过渡', () => {
  it('挥拍开始、结束时不瞬移，击球那一刻仍在挥拍动画的位置上', () => {
    const sim = new MatchSim({ seed: 1 });
    const p = sim.players.near;
    const body = { x: 0, y: -2 };
    // 拍头朝前上方（前倾 40°），和比赛里一样：识别出挥拍（t = 1.0）时动画已从 0.12 秒前开始，0.07 秒后击球
    const q: Quat = { w: Math.cos(0.35), x: Math.sin(0.35), y: 0, z: 0 };
    const swing = {
      start: 0.88,
      hit: 1.07,
      end: 1.37,
      height: TABLE.height + 0.15,
      kind: null,
      contact: { x: 0.45, y: -1.5, z: TABLE.height + 0.2 },
      stroke: 'fh' as const,
    };
    const view = new HumanPaddle();
    let prevRaw: { x: number; y: number; z: number } | null = null;
    let prevShown: { x: number; y: number; z: number } | null = null;
    let rawJumpIn = 0;
    let shownJumpIn = 0;
    let shownJumpOut = 0;
    let atHit: number | null = null;
    for (let i = 0; i <= 120; i++) {
      // 0.5 ～ 2.5 秒，60 帧每秒；t = 1.0 时识别出挥拍
      const t = 0.5 + i / 60;
      const detected = t >= 1 && !p.swing;
      if (detected) p.swing = swing;
      const raw = humanPaddle(device(q), p, body, t).pos;
      const shown = view.pose(device(q), p, body, t).pos;
      const d = (a: typeof raw, b: typeof raw) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (detected && prevRaw) rawJumpIn = d(raw, prevRaw);
      if (prevShown && t >= 1 && t < swing.hit)
        shownJumpIn = Math.max(shownJumpIn, d(shown, prevShown));
      if (prevShown && t > swing.end + 0.25)
        shownJumpOut = Math.max(shownJumpOut, d(shown, prevShown));
      if (atHit === null && t >= swing.hit) atHit = d(shown, raw);
      prevRaw = raw;
      prevShown = shown;
    }
    // 不过渡时：识别出挥拍那一帧瞬移几十厘米
    expect(rawJumpIn).toBeGreaterThan(0.25);
    // 过渡时：分到几帧里挥出去
    expect(shownJumpIn).toBeLessThan(0.6 * rawJumpIn);
    // 挥完滑回手柄：每帧不超过 4 厘米
    expect(shownJumpOut).toBeLessThan(0.04);
    // 击球那一刻已经完全在挥拍动画上（碰得到球）
    expect(atHit).toBeLessThan(1e-9);
  });
});
