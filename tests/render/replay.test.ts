import { describe, expect, it } from 'vitest';
import { AvatarMotion } from '@/render/avatar/motion';
import type { AvatarPose } from '@/render/avatar/types';
import { READY_PADDLE } from '@/render/paddlePose';
import { isHighlight, lerpPose, REPLAY, type ReplayFrame, ReplayRecorder } from '@/render/Replay';

function pose(x: number): AvatarPose {
  const m = new AvatarMotion();
  const paddle = {
    pos: { x: x + READY_PADDLE.side, y: -2 + READY_PADDLE.fwd, z: READY_PADDLE.z },
    normal: { x: -0.2, y: 1, z: 0.05 },
    handle: { x: -0.25, y: -0.2, z: -1 },
  };
  let p = m.update({ x, y: -2 }, 1, 1, paddle, 1 / 60);
  for (let i = 0; i < 30; i++) p = m.update({ x, y: -2 }, 1, 1, paddle, 1 / 60);
  return structuredClone(p);
}

function frame(t: number, ballY: number, p: AvatarPose): ReplayFrame {
  return {
    t,
    ball: { x: 0, y: ballY, z: 1 },
    ballVisible: true,
    trail: 'normal',
    spin: { top: 0, side: 0 },
    poses: { near: p },
  };
}

describe('得分回放', () => {
  const base = { rallyHits: 3, reason: 'out' as const, smashWinner: false, gamePoint: false };

  it('只回放精彩的分：长回合、扣杀得分、打到人、局点、最后一分', () => {
    expect(isHighlight({ ...base, gameOver: false })).toBe(false);
    expect(isHighlight({ ...base, rallyHits: 8, gameOver: false })).toBe(true);
    expect(isHighlight({ ...base, smashWinner: true, gameOver: false })).toBe(true);
    expect(isHighlight({ ...base, reason: 'face', gameOver: false })).toBe(true);
    expect(isHighlight({ ...base, gamePoint: true, gameOver: false })).toBe(true);
    expect(isHighlight({ ...base, gameOver: true })).toBe(true);
  });

  it('截取从倒数第 3 拍前一点到得分后一会儿，慢放、按时间插值，事件按时间放出来', () => {
    const rec = new ReplayRecorder();
    const a = pose(0);
    const b = pose(0.5);
    for (let i = 0; i <= 600; i++) {
      const t = i / 60;
      rec.push(frame(t, t, i % 2 ? b : a));
    }
    const hitTimes = [2, 3, 4, 5, 6];
    for (const t of hitTimes)
      rec.event({
        type: 'hit',
        t,
        side: 'near',
        p: { x: 0, y: 0, z: 1 },
        kind: 'normal',
        speed: 8,
        oops: false,
        smash: false,
        serve: false,
        rallyHits: 1,
      });
    const r = rec.clip(6.5)!;
    // 最近 8 秒：从倒数第 3 拍（4 秒）前 0.3 秒开始，到得分后 0.6 秒
    expect(r.t0).toBeCloseTo(4 - REPLAY.lead, 6);
    expect(r.t1).toBeCloseTo(6.5 + REPLAY.tail, 6);
    // 1 秒真实时间 = 0.6 秒比赛时间；这段里有 4 秒那一拍
    const ev = r.advance(1);
    expect(r.t).toBeCloseTo(r.t0 + REPLAY.speed, 6);
    expect(ev.map((e) => e.t)).toEqual([4]);
    // 球的位置在两帧之间插值（录的时候 y = t）
    expect(r.frame().ball.y).toBeCloseTo(r.t, 6);
    r.advance(100);
    expect(r.done).toBe(true);
  });

  it('姿势插值：中间值、朝向取近的一个、球拍四元数是单位长度', () => {
    const a = pose(0);
    const b = pose(0.6);
    const m = lerpPose(a, b, 0.5);
    expect(m.root.x).toBeCloseTo((a.root.x + b.root.x) / 2, 6);
    expect(m.facing).toBe(a.facing);
    const q = m.paddle.quat;
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6);
  });
});
