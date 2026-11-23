import { describe, expect, it } from 'vitest';
import { AvatarMotion } from '@/render/avatar/motion';
import { type PaddlePose, READY_PADDLE } from '@/render/paddlePose';

/** 准备位置（身体局部） */
const RS = READY_PADDLE.side;
const RF = READY_PADDLE.fwd;

/** 近端、右手：身体在原点，朝 +y；球拍在身体局部 (x, y, z) */
const paddleAt = (x: number, y: number, z = 0.95): PaddlePose => ({
  pos: { x, y, z },
  normal: { x: 0, y: 1, z: 0 },
  handle: { x: 0, y: -0.3, z: -1 },
});

/** 拍子停在一个位置一段时间（让平滑跟上），返回最后的姿态 */
function settle(m: AvatarMotion, p: PaddlePose, frames = 40, body = { x: 0, y: -2 }) {
  let pose = m.update(body, 1, 1, { ...p, pos: { ...p.pos, y: p.pos.y + body.y } }, 1 / 60);
  for (let i = 0; i < frames; i++)
    pose = m.update(
      body,
      1,
      1,
      { ...p, pos: { x: p.pos.x + body.x, y: p.pos.y + body.y, z: p.pos.z } },
      1 / 60
    );
  return pose;
}

describe('人物动作（和模型无关）', () => {
  it('拍子在准备位置：上身基本不转，微蹲、微微前倾', () => {
    const pose = settle(new AvatarMotion(), paddleAt(RS, RF));
    expect(Math.abs(pose.spine.yaw)).toBeLessThan(0.05);
    expect(pose.spine.pitch).toBeGreaterThan(0.05);
    expect(pose.pelvis.drop).toBeGreaterThan(0.02);
  });

  it('正手引拍（拍子在右后方）上身往右转；随挥到左前方往左转', () => {
    const m = new AvatarMotion();
    const back = settle(m, paddleAt(0.55, 0.12));
    expect(back.spine.yaw).toBeLessThan(-0.2);
    const follow = settle(m, paddleAt(-0.15, 0.55));
    expect(follow.spine.yaw).toBeGreaterThan(0.2);
  });

  it('够远球（拍子偏出身体很多）：往那边倒、蹲下去，那一侧的脚跨出去', () => {
    const pose = settle(new AvatarMotion(), paddleAt(0.95, 0.4, 0.85));
    expect(pose.spine.roll).toBeGreaterThan(0.3);
    expect(pose.pelvis.drop).toBeGreaterThan(0.1);
    const [left, right] = pose.feet;
    expect(right.x).toBeGreaterThan(0.18 + 0.1);
    expect(left.x).toBeCloseTo(-0.18, 2);
  });

  it('脚踩在地上；远端（朝 −y）左右镜像', () => {
    const near = settle(new AvatarMotion(), paddleAt(RS, RF));
    for (const f of near.feet) expect(f.z).toBeLessThan(0.1);
    const m = new AvatarMotion();
    const body = { x: 0, y: 2 };
    let far = m.update(
      body,
      -1,
      -1,
      {
        pos: { x: -RS, y: 2 - RF, z: 0.95 },
        normal: { x: 0, y: -1, z: 0 },
        handle: { x: 0, y: 0.3, z: -1 },
      },
      1 / 60
    );
    for (let i = 0; i < 40; i++)
      far = m.update(
        body,
        -1,
        -1,
        {
          pos: { x: -RS, y: 2 - RF, z: 0.95 },
          normal: { x: 0, y: -1, z: 0 },
          handle: { x: 0, y: 0.3, z: -1 },
        },
        1 / 60
      );
    // 远端的右手在世界 −x：同样的准备位置，上身也不转
    expect(far.paddleSide).toBe(1);
    expect(Math.abs(far.spine.yaw)).toBeLessThan(0.05);
  });

  it('脚踩实了不滑：身体挪 5 厘米，两只脚都不动', () => {
    const m = new AvatarMotion();
    const p = (x: number) => ({
      pos: { x: x + RS, y: -2 + RF, z: 0.95 },
      normal: { x: 0, y: 1, z: 0 },
      handle: { x: 0, y: -0.3, z: -1 },
    });
    let pose = m.update({ x: 0, y: -2 }, 1, 1, p(0), 1 / 60);
    for (let i = 0; i < 20; i++) pose = m.update({ x: 0, y: -2 }, 1, 1, p(0), 1 / 60);
    const before = pose.feet.map((f) => ({ ...f }));
    for (let i = 1; i <= 10; i++)
      pose = m.update({ x: 0.005 * i, y: -2 }, 1, 1, p(0.005 * i), 1 / 60);
    for (let i = 0; i < 20; i++) pose = m.update({ x: 0.05, y: -2 }, 1, 1, p(0.05), 1 / 60);
    pose.feet.forEach((f, i) => {
      expect(f.x).toBeCloseTo(before[i].x, 3);
      expect(f.y).toBeCloseTo(before[i].y, 3);
    });
  });

  it('横向跑动：两只脚轮流迈（不同时离地），跑完脚跟上身体', () => {
    const m = new AvatarMotion();
    const p = (x: number) => ({
      pos: { x: x + RS, y: -2 + RF, z: 0.95 },
      normal: { x: 0, y: 1, z: 0 },
      handle: { x: 0, y: -0.3, z: -1 },
    });
    let pose = m.update({ x: 0, y: -2 }, 1, 1, p(0), 1 / 60);
    let both = 0,
      steps = 0,
      wasUp = [false, false];
    for (let i = 1; i <= 36; i++) {
      const x = Math.min(0.8, i * (1.5 / 60));
      pose = m.update({ x, y: -2 }, 1, 1, p(x), 1 / 60);
      const up = pose.feet.map((f) => f.z > 0.051);
      if (up[0] && up[1]) both++;
      up.forEach((u, k) => {
        if (u && !wasUp[k]) steps++;
      });
      wasUp = up;
    }
    for (let i = 0; i < 40; i++) pose = m.update({ x: 0.8, y: -2 }, 1, 1, p(0.8), 1 / 60);
    expect(steps).toBeGreaterThanOrEqual(4);
    expect(both).toBe(0);
    expect(pose.feet[0].x).toBeCloseTo(0.8 - 0.18, 1);
    expect(pose.feet[1].x).toBeCloseTo(0.8 + 0.18, 1);
  });

  it('头跟着球：球在左前方就往左转；球不在场上看前方', () => {
    const m = new AvatarMotion();
    const pp = paddleAt(RS, RF);
    const body = { x: 0, y: -2 };
    const pad = { ...pp, pos: { x: RS, y: -2 + RF, z: 0.95 } };
    let pose = m.update(body, 1, 1, pad, 1 / 60, { x: -1, y: -0.5, z: 1 });
    for (let i = 0; i < 30; i++) pose = m.update(body, 1, 1, pad, 1 / 60, { x: -1, y: -0.5, z: 1 });
    expect(pose.head.yaw).toBeGreaterThan(0.3);
    for (let i = 0; i < 30; i++) pose = m.update(body, 1, 1, pad, 1 / 60, null);
    expect(Math.abs(pose.head.yaw)).toBeLessThan(0.05);
  });

  it('得分举拳跳起，失分低头', () => {
    const body = { x: 0, y: -2 };
    const pad = { ...paddleAt(RS, RF), pos: { x: RS, y: -2 + RF, z: 0.95 } };
    const w = new AvatarMotion();
    w.update(body, 1, 1, pad, 1 / 60);
    w.react('win');
    let top = 0,
      pose = w.update(body, 1, 1, pad, 1 / 60);
    for (let i = 0; i < 40; i++) {
      pose = w.update(body, 1, 1, pad, 1 / 60);
      top = Math.max(top, pose.feet[0].z);
    }
    expect(pose.freeHand.upper.z).toBeGreaterThan(0.5);
    expect(top).toBeGreaterThan(0.12);
    const l = new AvatarMotion();
    l.update(body, 1, 1, pad, 1 / 60);
    l.react('lose');
    for (let i = 0; i < 40; i++) pose = l.update(body, 1, 1, pad, 1 / 60);
    expect(pose.head.pitch).toBeGreaterThan(0.3);
    expect(pose.spine.pitch).toBeGreaterThan(0.35);
    // 反应过后恢复
    for (let i = 0; i < 120; i++) pose = l.update(body, 1, 1, pad, 1 / 60);
    expect(pose.head.pitch).toBeLessThan(0.15);
  });
});
