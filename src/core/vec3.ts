/**
 * 极简三维向量工具。函数式风格，最后一个参数 out 可选：
 * 传入 out 则写入 out（不分配内存，适合物理热循环），否则返回新对象。
 * 所有函数都允许 out 与输入是同一个对象。
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function add(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x + b.x, a.y + b.y, a.z + b.z);
}

export function sub(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scale(a: Vec3, s: number, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x * s, a.y * s, a.z * s);
}

/** a + b * s */
export function addScaled(a: Vec3, b: Vec3, s: number, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
}

export function negate(a: Vec3, out: Vec3 = vec3()): Vec3 {
  return set(out, -a.x, -a.y, -a.z);
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  return set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 单位化；零向量保持为零 */
export function normalize(a: Vec3, out: Vec3 = vec3()): Vec3 {
  const len = length(a);
  if (len === 0) return set(out, 0, 0, 0);
  return scale(a, 1 / len, out);
}

export function lerp(a: Vec3, b: Vec3, t: number, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

/** 去掉 a 在单位向量 n 方向上的分量 */
export function rejectUnit(a: Vec3, n: Vec3, out: Vec3 = vec3()): Vec3 {
  const d = dot(a, n);
  return set(out, a.x - n.x * d, a.y - n.y * d, a.z - n.z * d);
}

export function isFiniteVec(a: Vec3): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

export const ZERO: Readonly<Vec3> = Object.freeze(vec3(0, 0, 0));
export const UNIT_X: Readonly<Vec3> = Object.freeze(vec3(1, 0, 0));
export const UNIT_Y: Readonly<Vec3> = Object.freeze(vec3(0, 1, 0));
export const UNIT_Z: Readonly<Vec3> = Object.freeze(vec3(0, 0, 1));
