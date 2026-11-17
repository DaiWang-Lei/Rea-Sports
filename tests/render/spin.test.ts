import { describe, expect, it } from 'vitest';
import { ballSpin } from '@/render/BallView';

describe('球的旋转（拖尾上色用）', () => {
  it('往远端飞、球顶往前转 = 上旋', () => {
    // 往 +y 飞，上旋的转轴是 −x（球顶朝 +y 转）
    expect(ballSpin({ x: 0, y: 5, z: 0 }, { x: -120, y: 0, z: 0 }).top).toBeCloseTo(120);
    expect(ballSpin({ x: 0, y: 5, z: 0 }, { x: 120, y: 0, z: 0 }).top).toBeCloseTo(-120);
  });

  it('往近端飞时方向反过来，斜着飞也只取垂直于飞行方向的分量', () => {
    expect(ballSpin({ x: 0, y: -5, z: 0 }, { x: 120, y: 0, z: 0 }).top).toBeCloseTo(120);
    // 斜 45° 飞：沿飞行方向的转动不算上旋
    const s = ballSpin({ x: 3, y: 3, z: 0 }, { x: 100, y: 100, z: 0 });
    expect(s.top).toBeCloseTo(0);
  });

  it('绕竖直轴的转动是侧旋', () => {
    expect(ballSpin({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 90 }).side).toBe(90);
  });
});
