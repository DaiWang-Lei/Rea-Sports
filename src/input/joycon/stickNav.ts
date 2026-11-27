/**
 * 摇杆 → 菜单方向（上下左右）：推过一半算按下，回到三成以内算松开（中间留一段，不会在边界上来回抖）。
 * 中心和行程用手柄里存的摇杆校准（连上时从 SPI 读，用户在主机上校准过就用用户的）；
 * 读到之前（或没读到）先用最初几份读数的平均当中心（摇杆这时没人碰），行程按约 1300 算（12 位读数，中间约 2048）。
 */
import type { NavDir } from '../types';
import { USER_CAL_MAGIC } from './protocol';

/** 摇杆校准：中心，往正、负两边推到头各离中心多远 */
export interface StickCalibration {
  center: [number, number];
  above: [number, number];
  below: [number, number];
}

const HALF_RANGE = 1300;
const PRESS = 0.5;
const RELEASE = 0.3;
/** 用来定中心的读数份数 */
const CENTER_SAMPLES = 10;

export class StickNav {
  dir: NavDir | null = null;
  private center: [number, number] | null = null;
  private above: [number, number] = [HALF_RANGE, HALF_RANGE];
  private below: [number, number] = [HALF_RANGE, HALF_RANGE];
  private readonly sum: [number, number] = [0, 0];
  private n = 0;

  /** 用手柄里存的校准（之后不再用最初的读数定中心） */
  calibrate(c: StickCalibration): void {
    this.center = [...c.center];
    this.above = [...c.above];
    this.below = [...c.below];
  }

  /** 新的一份读数；方向变了返回新方向（null = 松开），没变返回 undefined */
  update(x: number, y: number): NavDir | null | undefined {
    if (!this.center) {
      this.sum[0] += x;
      this.sum[1] += y;
      if (++this.n >= CENTER_SAMPLES) this.center = [this.sum[0] / this.n, this.sum[1] / this.n];
      return undefined;
    }
    const dx = x - this.center[0];
    const dy = y - this.center[1];
    const nx = dx / (dx > 0 ? this.above[0] : this.below[0]);
    const ny = dy / (dy > 0 ? this.above[1] : this.below[1]);
    const horizontal = Math.abs(nx) >= Math.abs(ny);
    const strongest: NavDir = horizontal ? (nx > 0 ? 'right' : 'left') : ny > 0 ? 'up' : 'down';
    const mag = Math.max(Math.abs(nx), Math.abs(ny));
    let next: NavDir | null = this.dir;
    if (this.dir === null) {
      if (mag > PRESS) next = strongest;
    } else {
      const along =
        this.dir === 'right' ? nx : this.dir === 'left' ? -nx : this.dir === 'up' ? ny : -ny;
      if (along < RELEASE) next = mag > PRESS ? strongest : null;
      else if (strongest !== this.dir && mag > PRESS && mag > along + 0.2) next = strongest;
    }
    if (next === this.dir) return undefined;
    this.dir = next;
    return next;
  }
}

/**
 * 解析 SPI 里的摇杆校准：9 字节 = 6 个 12 位数。左摇杆依次是「往上推到头离中心多远、中心、往下」，
 * 右摇杆依次是「中心、往下、往上」（各是 X、Y 两个数）。user = 前面带 2 字节魔数的用户校准。
 * 闪存没写过（0xFF）或数值离谱时返回 null。
 */
export function parseStickCalibration(
  bytes: Uint8Array,
  side: 'L' | 'R',
  user = false
): StickCalibration | null {
  if (user) {
    if (bytes[0] !== USER_CAL_MAGIC[0] || bytes[1] !== USER_CAL_MAGIC[1]) return null;
    bytes = bytes.subarray(2);
  }
  if (bytes.length < 9) return null;
  const v: number[] = [];
  for (let i = 0; i < 9; i += 3) {
    v.push(((bytes[i + 1] << 8) & 0xf00) | bytes[i], (bytes[i + 2] << 4) | (bytes[i + 1] >> 4));
  }
  const pair = (i: number): [number, number] => [v[i], v[i + 1]];
  const c: StickCalibration =
    side === 'L'
      ? { above: pair(0), center: pair(2), below: pair(4) }
      : { center: pair(0), below: pair(2), above: pair(4) };
  const ok = (n: number) => n >= 400 && n <= 2400;
  const centered = (n: number) => n >= 1000 && n <= 3100;
  if (![...c.above, ...c.below].every(ok) || !c.center.every(centered)) return null;
  return c;
}
