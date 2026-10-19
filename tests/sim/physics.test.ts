import { describe, expect, it } from 'vitest';
import { createTuning } from '@/config/tuning';
import { Rng } from '@/core/rng';
import { vec3 } from '@/core/vec3';
import {
  ballState,
  type BallEvent,
  type BallState,
  cloneBall,
  flyFree,
  stepBall,
} from '@/sim/ball/physics';
import { BALL, NET, SIM_DT, TABLE, TABLE_CONTACT_Z } from '@/sim/constants';

const T = createTuning();
const PP = T.physics;

function run(s: BallState, seconds: number, rng: Rng | null = null) {
  const events: BallEvent[] = [];
  const traj: BallState[] = [];
  for (let i = 0; i < seconds / SIM_DT; i++) {
    stepBall(s, SIM_DT, i * SIM_DT, PP, rng, events);
    traj.push(cloneBall(s));
  }
  return { events, traj };
}

function energy(s: BallState) {
  const v2 = s.v.x ** 2 + s.v.y ** 2 + s.v.z ** 2;
  return 0.5 * v2 + 9.81 * s.p.z;
}

describe('台面反弹', () => {
  it('30cm 高度落下，反弹约 23cm（ITTF 球台规格）', () => {
    const s = ballState(vec3(0.2, -0.5, TABLE_CONTACT_Z + 0.3));
    const { events, traj } = run(s, 1.2);
    expect(events[0]?.type).toBe('table');
    const after = traj.filter((x) => x.p.z > TABLE_CONTACT_Z && x.v.z !== 0);
    // 第一次弹起后的最高点
    const i0 = traj.findIndex((x) => x.v.z > 0);
    let apex = 0;
    for (let i = i0; i < traj.length && traj[i].v.z > -0.01; i++)
      apex = Math.max(apex, traj[i].p.z);
    expect(after.length).toBeGreaterThan(0);
    expect(apex - TABLE_CONTACT_Z).toBeGreaterThan(0.22);
    expect(apex - TABLE_CONTACT_Z).toBeLessThan(0.24);
  });

  it('不旋转的球向 +y 落台后带上旋（ω_x < 0）', () => {
    const s = ballState(vec3(0, 0.6, TABLE_CONTACT_Z + 0.05), vec3(0, 4, -2));
    const { events, traj } = run(s, 0.05);
    expect(events[0].type).toBe('table');
    expect(traj[traj.length - 1].w.x).toBeLessThan(0);
  });

  it('上旋落台后向前更快；下旋按库仑摩擦与不转的球相同（都处于滑动），但旋转方向保持为下旋', () => {
    // 紧贴台面起步，排除飞行中马格努斯力的影响，只看碰撞本身
    const bounce = (wx: number) => {
      const s = ballState(vec3(0, 0.6, TABLE_CONTACT_Z + 0.001), vec3(0, 6, -2.5), vec3(wx, 0, 0));
      const events: BallEvent[] = [];
      stepBall(s, 0.002, 0, PP, null, events);
      expect(events[0]?.type).toBe('table');
      return s;
    };
    const flat = bounce(0);
    const top = bounce(-250);
    const back = bounce(250);
    expect(top.v.y).toBeGreaterThan(flat.v.y + 0.3);
    expect(Math.abs(back.v.y - flat.v.y)).toBeLessThan(0.02);
    expect(back.w.x).toBeGreaterThan(0);
    expect(back.w.x).toBeLessThan(250);
  });
});

describe('飞行', () => {
  it('上旋球下坠，下旋球上飘（马格努斯方向）', () => {
    const zAfter = (wx: number) => {
      const s = ballState(vec3(0, -1.5, 1.1), vec3(0, 8, 0.5), vec3(wx, 0, 0));
      flyFree(s, 0.25, PP, s);
      return s.p.z;
    };
    const flat = zAfter(0);
    expect(zAfter(-200)).toBeLessThan(flat - 0.02);
    expect(zAfter(200)).toBeGreaterThan(flat + 0.02);
  });

  it('侧旋让球拐弯（ω_z > 0 时向前飞的球偏向 −x）', () => {
    const s = ballState(vec3(0, -1.5, 1.1), vec3(0, 8, 0.5), vec3(0, 0, 200));
    flyFree(s, 0.3, PP, s);
    expect(s.p.x).toBeLessThan(-0.02);
  });

  it('关掉阻力与马格努斯时能量守恒；只开阻力时能量单调减少', () => {
    const noAir = { ...PP, dragK: 0, magnusK: 0, spinDecay: 0 };
    const s = ballState(vec3(0, -1.5, 1.2), vec3(0.3, 7, 2), vec3(0, 0, 0));
    const e0 = energy(s);
    flyFree(s, 0.6, noAir, s);
    expect(Math.abs(energy(s) - e0)).toBeLessThan(1e-9);

    const d = ballState(vec3(0, -1.5, 1.2), vec3(0.3, 7, 2));
    let prev = energy(d);
    for (let i = 0; i < 100; i++) {
      flyFree(d, SIM_DT, { ...PP, magnusK: 0 }, d);
      const e = energy(d);
      expect(e).toBeLessThanOrEqual(prev + 1e-12);
      prev = e;
    }
  });

  it('马格努斯力始终垂直于速度', () => {
    // 只有马格努斯（无重力影响速度大小的部分无法单独关掉，所以比较有无旋转时的速度大小变化）
    const a = ballState(vec3(0, -1.5, 1.2), vec3(0, 8, 0), vec3(-300, 0, 120));
    const b = ballState(vec3(0, -1.5, 1.2), vec3(0, 8, 0), vec3(0, 0, 0));
    flyFree(a, SIM_DT, PP, a);
    flyFree(b, SIM_DT, PP, b);
    const sa = Math.hypot(a.v.x, a.v.y, a.v.z);
    const sb = Math.hypot(b.v.x, b.v.y, b.v.z);
    expect(Math.abs(sa - sb)).toBeLessThan(2e-3);
  });
});

describe('碰撞', () => {
  it('30m/s 的球打向球网不会穿过去', () => {
    const s = ballState(vec3(0, -0.3, NET.top - 0.05), vec3(0, 30, 0));
    const { events } = run(s, 0.05);
    expect(events[0]?.type).toBe('net');
    expect(events[0]?.part).toBe('body');
    expect(s.p.y).toBeLessThan(0);
  });

  it('30m/s 竖直砸向台面不会穿透', () => {
    const s = ballState(vec3(0.3, 0.8, TABLE_CONTACT_Z + 0.2), vec3(0, 0, -30));
    const { events } = run(s, 0.03);
    expect(events[0]?.type).toBe('table');
    expect(s.p.z).toBeGreaterThan(TABLE.height);
  });

  it('擦网带：贴着网顶飞过会触发网带事件', () => {
    const s = ballState(vec3(0, -0.1, NET.top + BALL.radius - 0.006), vec3(0, 6, 0));
    const { events } = run(s, 0.05);
    expect(events.some((e) => e.type === 'net' && e.part === 'cord')).toBe(true);
  });

  it('落在台端边缘算有效擦边；从侧面撞台算无效', () => {
    const edge = ballState(
      vec3(0.2, TABLE.halfLength + 0.012, TABLE_CONTACT_Z + 0.3),
      vec3(0, 0, -2)
    );
    const e1 = run(edge, 0.3).events[0];
    expect(e1.type).toBe('table');
    expect(e1.edge).toBe(true);
    expect(e1.side).toBe('far');

    const side = ballState(vec3(0.2, TABLE.halfLength + 0.3, TABLE.height - 0.012), vec3(0, -5, 0));
    const e2 = run(side, 0.1).events[0];
    expect(e2.type).toBe('side');
  });

  it('掉到地上触发地面事件', () => {
    const s = ballState(vec3(0, -2, 0.5), vec3(0, -1, 0));
    const { events } = run(s, 0.6);
    expect(events[0]?.type).toBe('floor');
  });

  it('接触后离开时不会重复触发事件', () => {
    const s = ballState(vec3(0, 0.5, TABLE_CONTACT_Z + 0.1), vec3(0, 1, -1));
    const { events } = run(s, 0.12);
    const tableEvents = events.filter((e) => e.type === 'table');
    expect(tableEvents.length).toBe(1);
  });

  it('同一种子、同一初始状态得到完全相同的事件序列', () => {
    const mk = () =>
      ballState(vec3(0.6, -0.2, NET.top + 0.015), vec3(0.4, 5, -0.5), vec3(-100, 30, 50));
    const a = run(mk(), 1.5, new Rng(11)).events.map((e) => [e.type, e.t, e.p.x, e.p.y]);
    const b = run(mk(), 1.5, new Rng(11)).events.map((e) => [e.type, e.t, e.p.x, e.p.y]);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
