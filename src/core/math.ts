export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 把 v 从 [a, b] 线性映射到 [0, 1] 并截断 */
export function invLerp01(a: number, b: number, v: number): number {
  return clamp01((v - a) / (b - a));
}

export function sign(v: number): number {
  return v < 0 ? -1 : 1;
}

/** 与帧率无关的指数平滑系数：每过 halfTime 秒，差距减半 */
export function halfLifeFactor(dt: number, halfTime: number): number {
  return halfTime <= 0 ? 0 : Math.pow(2, -dt / halfTime);
}

/** 把角度规范到 (-π, π] */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}
