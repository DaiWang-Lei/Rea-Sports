import { describe, expect, it } from 'vitest';
import { createTuning } from '@/config/tuning';
import { DEG } from '@/core/math';
import { fromAxisAngle, multiply } from '@/core/quat';
import { type Vec3, vec3 } from '@/core/vec3';
import { PaddleModel } from '@/input/paddle/PaddleModel';
import { createPlayer } from '@/sim/players/PlayerSim';
import {
  elbowOf,
  FOREARM,
  GRIP_TO_CENTER,
  restElbow,
  shoulderOf,
  UPPER_ARM,
} from '@/render/paddlePose';
import { humanPaddle } from '@/app/shared/motionPlay';

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('两段手臂（肘按反向运动学弯曲）', () => {
  const body = { x: 0.1, y: -2 };
  const s = shoulderOf(body, 1, 1);

  it('够得着：上臂、前臂保持长度，肘在肩 → 手连线的下方、外侧', () => {
    for (const g of [vec3(0.35, -1.6, 0.95), vec3(0.0, -1.55, 1.1), vec3(0.6, -1.8, 0.9)]) {
      const e = elbowOf(s, g, 1, 1);
      expect(dist(s, e)).toBeCloseTo(UPPER_ARM, 6);
      expect(dist(e, g)).toBeCloseTo(FOREARM, 6);
      const mid = vec3((s.x + g.x) / 2, (s.y + g.y) / 2, (s.z + g.z) / 2);
      expect(e.z).toBeLessThan(mid.z);
    }
  });

  it('够不着：手臂伸直指向握拍处', () => {
    const g = vec3(1.2, -1.2, 1.0);
    const e = elbowOf(s, g, 1, 1);
    const k = dist(s, e) / dist(s, g);
    expect(k).toBeCloseTo(UPPER_ARM / (UPPER_ARM + FOREARM), 6);
    expect(e.x).toBeCloseTo(s.x + (g.x - s.x) * k, 6);
  });

  it('等球时的肘离肩一个上臂长，在身体前方、持拍手一侧', () => {
    const e = restElbow(body, 1, 1);
    expect(dist(s, e)).toBeCloseTo(UPPER_ARM, 6);
    expect(e.y).toBeGreaterThan(s.y);
    expect(e.x).toBeGreaterThan(s.x);
    // 远端、左手：镜像
    const e2 = restElbow(body, -1, 1);
    expect(e2.y).toBeLessThan(body.y);
  });
});

describe('等球时拍子跟着前臂绕肘转', () => {
  const tune = createTuning();
  const body = { x: 0, y: -2 };
  /** 拍头（设备 +X）的方向由设备姿态 q 决定；偏航 0：融合系 = 游戏系 */
  function pose(q: ReturnType<typeof fromAxisAngle>) {
    const m = new PaddleModel();
    m.hasHeading = true;
    m.yaw = 0;
    m.q = q;
    const p = createPlayer('near', 1, false, { vMax: 3, aMax: 10, gain: 6, yFactor: 0.6 }, tune);
    return humanPaddle(m, p, body, 0);
  }
  const e = restElbow(body, 1, 1);

  it('拍头指向正前方：手在肘前方一个前臂长，拍面中心再往前', () => {
    const r = pose(fromAxisAngle(0, 0, 1, Math.PI / 2));
    expect(r.pos.x).toBeCloseTo(e.x, 6);
    expect(r.pos.y).toBeCloseTo(e.y + FOREARM + GRIP_TO_CENTER, 6);
    expect(r.pos.z).toBeCloseTo(e.z, 6);
    expect(r.handle.y).toBeCloseTo(-1, 6);
  });

  it('拍头竖直朝上：前臂最多抬 50°，其余算手腕弯；拍面中心在手的正上方', () => {
    const r = pose(fromAxisAngle(0, 1, 0, -Math.PI / 2));
    expect(r.pos.y).toBeCloseTo(e.y + FOREARM * Math.cos(50 * DEG), 6);
    expect(r.pos.z).toBeCloseTo(e.z + FOREARM * Math.sin(50 * DEG) + GRIP_TO_CENTER, 6);
  });

  it('拍头接近竖直（偏 5°，偏向哪边都一样）：前臂朝正前方，不会左右乱跳', () => {
    const up = pose(fromAxisAngle(0, 1, 0, -Math.PI / 2));
    for (const dir of [0, 90, 180, -90]) {
      // 先竖起来，再往 dir 方向歪 5°
      const tilt = fromAxisAngle(Math.cos(dir * DEG), Math.sin(dir * DEG), 0, 5 * DEG);
      const q = multiply(tilt, fromAxisAngle(0, 1, 0, -Math.PI / 2));
      const r = pose(q);
      // 拍面中心随拍头歪一点（0.138 × sin5° ≈ 1.2cm），手不动
      expect(Math.abs(r.pos.x - up.pos.x)).toBeLessThan(0.015);
      expect(Math.abs(r.pos.y - up.pos.y)).toBeLessThan(0.015);
    }
  });

  it('等球时画出来的肘就是计算手的位置用的那个肘（前臂和拍柄对齐）', () => {
    const s = shoulderOf(body, 1, 1);
    for (const q of [
      fromAxisAngle(0, 0, 1, Math.PI / 2),
      fromAxisAngle(0, 1, 0, -Math.PI / 2),
      multiply(fromAxisAngle(0, 0, 1, Math.PI / 2 - 0.7), fromAxisAngle(0, 1, 0, -0.4)),
      multiply(fromAxisAngle(0, 0, 1, Math.PI / 2 + 0.7), fromAxisAngle(0, 1, 0, -0.3)),
    ]) {
      const r = pose(q);
      const g = vec3(
        r.pos.x + r.handle.x * GRIP_TO_CENTER,
        r.pos.y + r.handle.y * GRIP_TO_CENTER,
        r.pos.z + r.handle.z * GRIP_TO_CENTER
      );
      expect(dist(elbowOf(s, g, 1, 1), e)).toBeLessThan(1e-6);
    }
  });

  it('拍头指向反手侧（左）：前臂最多往里转 70°，手到了身体前面', () => {
    const r = pose(fromAxisAngle(0, 0, 1, Math.PI));
    const gx = e.x - FOREARM * Math.sin(70 * DEG);
    expect(r.pos.x).toBeCloseTo(gx - GRIP_TO_CENTER, 6);
    expect(r.pos.x).toBeLessThan(body.x);
  });
});
