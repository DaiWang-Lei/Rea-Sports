/**
 * 四元数（Hamilton 约定）。rotate(q, v) = q·v·q⁻¹。
 * multiply(a, b) 表示先做 b 再做 a（作用在向量上时）。
 * 姿态四元数一律表示「机体系 → 世界系」。
 */
import { type Vec3, vec3, set as setV } from './vec3';

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

export function quat(w = 1, x = 0, y = 0, z = 0): Quat {
  return { w, x, y, z };
}

export function setQ(out: Quat, w: number, x: number, y: number, z: number): Quat {
  out.w = w;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyQ(out: Quat, q: Quat): Quat {
  return setQ(out, q.w, q.x, q.y, q.z);
}

export function cloneQ(q: Quat): Quat {
  return { w: q.w, x: q.x, y: q.y, z: q.z };
}

export function identity(out: Quat = quat()): Quat {
  return setQ(out, 1, 0, 0, 0);
}

export function multiply(a: Quat, b: Quat, out: Quat = quat()): Quat {
  return setQ(
    out,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  );
}

/** 单位四元数的逆 = 共轭 */
export function conjugate(q: Quat, out: Quat = quat()): Quat {
  return setQ(out, q.w, -q.x, -q.y, -q.z);
}

export function normalizeQ(q: Quat, out: Quat = quat()): Quat {
  const len = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  if (len === 0) return identity(out);
  const k = 1 / len;
  return setQ(out, q.w * k, q.x * k, q.y * k, q.z * k);
}

/** 绕任意（不必单位化的）轴旋转 angle 弧度；零轴返回单位四元数 */
export function fromAxisAngle(
  ax: number,
  ay: number,
  az: number,
  angle: number,
  out: Quat = quat()
): Quat {
  const len = Math.sqrt(ax * ax + ay * ay + az * az);
  if (len === 0 || angle === 0) return identity(out);
  const s = Math.sin(angle / 2) / len;
  return setQ(out, Math.cos(angle / 2), ax * s, ay * s, az * s);
}

/** 旋转向量（轴 × 角度，弧度）→ 四元数，即指数映射 */
export function fromRotationVector(rx: number, ry: number, rz: number, out: Quat = quat()): Quat {
  const angle = Math.sqrt(rx * rx + ry * ry + rz * rz);
  return fromAxisAngle(rx, ry, rz, angle, out);
}

/** 四元数 → 旋转向量（对数映射），结果角度在 [0, π] */
export function toRotationVector(q: Quat, out: Vec3 = vec3()): Vec3 {
  let { w, x, y, z } = q;
  if (w < 0) {
    w = -w;
    x = -x;
    y = -y;
    z = -z;
  }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-12) return setV(out, 2 * x, 2 * y, 2 * z);
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return setV(out, x * k, y * k, z * k);
}

export function rotate(q: Quat, v: Vec3, out: Vec3 = vec3()): Vec3 {
  // t = 2 * (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return setV(
    out,
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx)
  );
}

/** 用 q 的逆旋转向量（世界系 → 机体系） */
export function rotateInverse(q: Quat, v: Vec3, out: Vec3 = vec3()): Vec3 {
  return rotate({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, v, out);
}

/** 把单位向量 a 转到单位向量 b 的最短弧旋转 */
export function fromTwoVectors(a: Vec3, b: Vec3, out: Quat = quat()): Quat {
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  if (d < -0.999999) {
    // 反向：任找一个垂直轴转 180°
    let ax = 0;
    let ay = -a.z;
    let az = a.y;
    if (ax * ax + ay * ay + az * az < 1e-12) {
      ax = a.z;
      ay = 0;
      az = -a.x;
    }
    return fromAxisAngle(ax, ay, az, Math.PI, out);
  }
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return normalizeQ(setQ(out, 1 + d, cx, cy, cz), out);
}

/** 两个姿态之间的夹角（弧度，0..π） */
export function angleBetween(a: Quat, b: Quat): number {
  const d = Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z);
  return 2 * Math.acos(Math.min(1, d));
}

export function slerp(a: Quat, b: Quat, t: number, out: Quat = quat()): Quat {
  let bw = b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let cos = a.w * bw + a.x * bx + a.y * by + a.z * bz;
  if (cos < 0) {
    cos = -cos;
    bw = -bw;
    bx = -bx;
    by = -by;
    bz = -bz;
  }
  let k0: number;
  let k1: number;
  if (cos > 0.9995) {
    k0 = 1 - t;
    k1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    k0 = Math.sin((1 - t) * theta) / sin;
    k1 = Math.sin(t * theta) / sin;
  }
  return normalizeQ(
    setQ(out, a.w * k0 + bw * k1, a.x * k0 + bx * k1, a.y * k0 + by * k1, a.z * k0 + bz * k1),
    out
  );
}

/**
 * 摆动-扭转分解：q = swing · twist，其中 twist 是绕单位轴 axis 的旋转。
 * 返回 twist 的有符号角度（弧度，-π..π）。
 */
export function twistAngle(q: Quat, axis: Vec3): number {
  const p = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  let w = q.w;
  let proj = p;
  if (w < 0) {
    w = -w;
    proj = -proj;
  }
  if (w === 0 && proj === 0) return 0;
  return 2 * Math.atan2(proj, w);
}
