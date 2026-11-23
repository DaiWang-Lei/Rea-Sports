import { describe, expect, it } from 'vitest';
import { AvatarMotion } from '@/render/avatar/motion';
import type { PaddlePose } from '@/render/paddlePose';

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
    const pose = settle(new AvatarMotion(), paddleAt(0.28, 0.42));
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
    expect(right.x).toBeGreaterThan(0.15 + 0.1);
    expect(left.x).toBeCloseTo(-0.15, 2);
  });

  it('脚踩在地上；远端（朝 −y）左右镜像', () => {
    const near = settle(new AvatarMotion(), paddleAt(0.28, 0.42));
    for (const f of near.feet) expect(f.z).toBeLessThan(0.1);
    const m = new AvatarMotion();
    const body = { x: 0, y: 2 };
    let far = m.update(
      body,
      -1,
      -1,
      {
        pos: { x: -0.28, y: 2 - 0.42, z: 0.95 },
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
          pos: { x: -0.28, y: 2 - 0.42, z: 0.95 },
          normal: { x: 0, y: -1, z: 0 },
          handle: { x: 0, y: 0.3, z: -1 },
        },
        1 / 60
      );
    // 远端的右手在世界 −x：同样的准备位置，上身也不转
    expect(far.paddleSide).toBe(1);
    expect(Math.abs(far.spine.yaw)).toBeLessThan(0.05);
  });
});
