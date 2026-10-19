/**
 * 世界坐标（米）：原点在球台中心正下方的地面；+x 为近端（玩家）的右手方向，+y 指向远端（对手），+z 向上。
 * 近端（near）= y < 0，远端（far）= y > 0。
 */

/** 国际乒联规格 */
export const TABLE = {
  length: 2.74,
  width: 1.525,
  halfLength: 1.37,
  halfWidth: 0.7625,
  /** 台面高度 */
  height: 0.76,
  /** 台面板厚度（用于擦边/侧面判定） */
  thickness: 0.025,
} as const;

export const NET = {
  height: 0.1525,
  /** 网顶（网带上缘）的绝对高度 */
  top: TABLE.height + 0.1525,
  /** 网在 x 方向的半宽（网柱在边线外 15.25cm） */
  halfSpan: TABLE.halfWidth + 0.1525,
  /** 网带（顶部包边）半径 */
  cordRadius: 0.003,
  /** 网身半厚 */
  halfThickness: 0.001,
} as const;

export const BALL = {
  radius: 0.02,
  mass: 0.0027,
} as const;

export const GRAVITY = 9.81;

/** 仿真步长：240Hz 固定步长 */
export const SIM_HZ = 240;
export const SIM_DT = 1 / SIM_HZ;

/** 球心落在台面上时的高度 */
export const TABLE_CONTACT_Z = TABLE.height + BALL.radius;

export type Side = 'near' | 'far';

export function otherSide(s: Side): Side {
  return s === 'near' ? 'far' : 'near';
}

/** 某一侧的「朝向」：近端朝 +y，远端朝 −y */
export function sideDir(s: Side): 1 | -1 {
  return s === 'near' ? 1 : -1;
}

/** 坐标 y 属于哪一侧的半台 */
export function sideOfY(y: number): Side {
  return y < 0 ? 'near' : 'far';
}
