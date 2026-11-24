import type { Vec3 } from '@/core/vec3';

export type JoyConSide = 'L' | 'R';

/**
 * 一个 IMU 采样。坐标为统一后的 Joy-Con 机体系（与 Linux hid-nintendo 一致，右手系）：
 *   +X 指向肩键（R/ZR 或 L/ZL）一端
 *   +Y 指向左
 *   +Z 从按键面朝外
 * 平放、按键面朝上静止时，加速度约为 (0, 0, +1) g。
 */
export interface ImuSample {
  /** 估计的采样时刻，毫秒，与 performance.now() 同一时间基准 */
  t: number;
  /** 角速度，度/秒 */
  gyro: Vec3;
  /** 加速度（比力），g */
  accel: Vec3;
  /** 任一轴接近量程上限（陀螺 ±2000dps / 加速度 ±16G） */
  clipped: boolean;
}

export const BUTTON_NAMES = [
  // Joy-Con R
  'y',
  'x',
  'b',
  'a',
  'srR',
  'slR',
  'r',
  'zr',
  // 共用
  'minus',
  'plus',
  'rStick',
  'lStick',
  'home',
  'capture',
  // Joy-Con L
  'down',
  'up',
  'right',
  'left',
  'srL',
  'slL',
  'l',
  'zl',
] as const;

export type ButtonName = (typeof BUTTON_NAMES)[number];
export type Buttons = Record<ButtonName, boolean>;

export function emptyButtons(): Buttons {
  const b = {} as Buttons;
  for (const n of BUTTON_NAMES) b[n] = false;
  return b;
}

/**
 * 游戏里用到的逻辑按键，左右手柄各自映射：
 * - confirm：确认 / 抛球（R: A，L: →）
 * - back：返回（R: B，L: ↓）
 * - recenter：回中（R: Y 或按下摇杆，L: ↑ 或按下摇杆）
 * - pause：暂停（R: +，L: −）
 * - players：对打里切换 1 人 / 2 人（R: X，L: ←）
 */
export type LogicalButton = 'confirm' | 'back' | 'recenter' | 'pause' | 'players';

export const LOGICAL_MAP: Record<JoyConSide, Record<LogicalButton, ButtonName[]>> = {
  R: { confirm: ['a'], back: ['b'], recenter: ['y', 'rStick'], pause: ['plus'], players: ['x'] },
  L: {
    confirm: ['right'],
    back: ['down'],
    recenter: ['up', 'lStick'],
    pause: ['minus'],
    players: ['left'],
  },
};

export function isLogicalDown(side: JoyConSide, b: Buttons, logical: LogicalButton): boolean {
  return LOGICAL_MAP[side][logical].some((n) => b[n]);
}

/**
 * 松开时才算按了一下的键（切换人数的 X 也是校准组合键 X + ZR 的一半）：按住期间碰过 spoil 就不算。
 * 每次手柄报告按键时调用，返回这一次是不是算按了一下
 */
export class TapOnRelease {
  private down = false;
  private armed = false;

  update(down: boolean, spoil: boolean): boolean {
    const was = this.down;
    this.down = down;
    if (down && !was) this.armed = true;
    if (spoil) this.armed = false;
    if (down || !was || !this.armed) return false;
    this.armed = false;
    return true;
  }
}
