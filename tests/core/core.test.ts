import { describe, expect, it } from 'vitest';
import {
  angleBetween,
  conjugate,
  fromAxisAngle,
  fromRotationVector,
  fromTwoVectors,
  multiply,
  rotate,
  slerp,
  toRotationVector,
  twistAngle,
} from '@/core/quat';
import { Rng } from '@/core/rng';
import { cross, length, normalize, vec3 } from '@/core/vec3';
import { wrapAngle } from '@/core/math';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('quat', () => {
  it('绕 Z 轴转 90° 把 +X 转到 +Y', () => {
    const q = fromAxisAngle(0, 0, 1, Math.PI / 2);
    const v = rotate(q, vec3(1, 0, 0));
    close(v.x, 0);
    close(v.y, 1);
    close(v.z, 0);
  });

  it('multiply(a, b) 先做 b 再做 a', () => {
    const a = fromAxisAngle(0, 0, 1, Math.PI / 2); // 绕 Z
    const b = fromAxisAngle(1, 0, 0, Math.PI / 2); // 绕 X
    const v = rotate(multiply(a, b), vec3(0, 1, 0));
    // 先绕 X：+Y → +Z；再绕 Z：+Z 不变
    close(v.x, 0);
    close(v.y, 0);
    close(v.z, 1);
  });

  it('共轭是逆旋转', () => {
    const q = fromAxisAngle(1, 2, 3, 0.7);
    const v = vec3(0.3, -0.2, 0.9);
    const back = rotate(conjugate(q), rotate(q, v));
    close(back.x, v.x);
    close(back.y, v.y);
    close(back.z, v.z);
  });

  it('旋转向量往返', () => {
    const r = vec3(0.4, -1.1, 0.25);
    const out = toRotationVector(fromRotationVector(r.x, r.y, r.z));
    close(out.x, r.x, 1e-9);
    close(out.y, r.y, 1e-9);
    close(out.z, r.z, 1e-9);
  });

  it('fromTwoVectors 把 a 转到 b（含反向）', () => {
    const cases = [
      [vec3(1, 0, 0), vec3(0, 1, 0)],
      [vec3(0, 0, 1), normalize(vec3(1, 1, 1))],
      [vec3(1, 0, 0), vec3(-1, 0, 0)],
    ];
    for (const [a, b] of cases) {
      const r = rotate(fromTwoVectors(a, b), a);
      close(r.x, b.x, 1e-9);
      close(r.y, b.y, 1e-9);
      close(r.z, b.z, 1e-9);
    }
  });

  it('twistAngle 取出绕轴分量', () => {
    const twist = fromAxisAngle(0, 0, 1, 0.6);
    const swing = fromAxisAngle(1, 0, 0, 0.3);
    close(twistAngle(multiply(swing, twist), vec3(0, 0, 1)), 0.6, 0.05);
    close(twistAngle(twist, vec3(0, 0, 1)), 0.6, 1e-9);
    close(twistAngle(fromAxisAngle(0, 0, 1, -0.8), vec3(0, 0, 1)), -0.8, 1e-9);
  });

  it('slerp 中点角度减半', () => {
    const a = fromAxisAngle(0, 1, 0, 0);
    const b = fromAxisAngle(0, 1, 0, 1.2);
    close(angleBetween(a, slerp(a, b, 0.5)), 0.6, 1e-9);
  });

  it('cross / length 基本正确', () => {
    const c = cross(vec3(1, 0, 0), vec3(0, 1, 0));
    expect(c).toEqual({ x: 0, y: 0, z: 1 });
    close(length(vec3(3, 4, 12)), 13);
  });

  it('wrapAngle', () => {
    close(wrapAngle(3 * Math.PI), Math.PI, 1e-9);
    close(wrapAngle((-3 * Math.PI) / 2), Math.PI / 2, 1e-9);
  });
});

describe('Rng', () => {
  it('同一种子序列相同，不同种子不同', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 20 }, () => a.nextU32());
    const sb = Array.from({ length: 20 }, () => b.nextU32());
    const sc = Array.from({ length: 20 }, () => c.nextU32());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('float 在 [0,1)，normal 的均值方差合理', () => {
    const r = new Rng(7);
    let sum = 0;
    let sumSq = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const g = r.normal(2, 3);
      sum += g;
      sumSq += g * g;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean - 2)).toBeLessThan(0.1);
    expect(Math.abs(sd - 3)).toBeLessThan(0.1);
  });

  it('状态可保存恢复', () => {
    const r = new Rng(9);
    r.normal();
    const st = r.getState();
    const x = [r.float(), r.normal(), r.nextU32()];
    r.setState(st);
    expect([r.float(), r.normal(), r.nextU32()]).toEqual(x);
  });
});
