/** 人物模型共用的小工具：两段骨骼的反向运动学 */
import type { Vec3 } from '@/core/vec3';

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export const addScaled = (a: Vec3, d: Vec3, k: number): Vec3 => ({
  x: a.x + d.x * k,
  y: a.y + d.y * k,
  z: a.z + d.z * k,
});

/**
 * 两段骨骼（a → 关节 → c，长 l1、l2）的关节位置，关节往 pole 方向弯。
 * 够不着时关节落在 a → c 连线上、按两段长度的比例分（能拉长的模型两段按比例拉长，手、脚仍然到目标位置）
 */
export function twoBone(a: Vec3, c: Vec3, l1: number, l2: number, pole: Vec3): Vec3 {
  const d = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-6) return addScaled(a, pole, l1);
  const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
  if (len >= l1 + l2) return addScaled(a, dir, (l1 / (l1 + l2)) * len);
  const l = Math.max(len, Math.abs(l1 - l2) + 1e-3);
  const cosA = clamp((l1 * l1 + l * l - l2 * l2) / (2 * l1 * l), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pd = pole.x * dir.x + pole.y * dir.y + pole.z * dir.z;
  let p = { x: pole.x - pd * dir.x, y: pole.y - pd * dir.y, z: pole.z - pd * dir.z };
  const pl = Math.hypot(p.x, p.y, p.z);
  p = pl < 1e-6 ? { x: 0, y: 0, z: 1 } : { x: p.x / pl, y: p.y / pl, z: p.z / pl };
  return {
    x: a.x + l1 * (cosA * dir.x + sinA * p.x),
    y: a.y + l1 * (cosA * dir.y + sinA * p.y),
    z: a.z + l1 * (cosA * dir.z + sinA * p.z),
  };
}
