/**
 * 自动走位：每个轴上按「比例控制 + 限速 + 限加速度」靠近目标点。玩家与电脑共用，只是参数不同。
 * 位置是人物脚下在地面上的 (x, y)。
 */
import { clamp } from '@/core/math';

export interface MoverLimits {
  vMax: number;
  aMax: number;
  gain: number;
  /** y 方向的速度/加速度限制倍率 */
  yFactor: number;
}

export class Mover {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  tx: number;
  ty: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.tx = x;
    this.ty = y;
  }

  setTarget(x: number, y: number): void {
    this.tx = x;
    this.ty = y;
  }

  teleport(x: number, y: number): void {
    this.x = this.tx = x;
    this.y = this.ty = y;
    this.vx = this.vy = 0;
  }

  update(dt: number, lim: MoverLimits): void {
    const step = (pos: number, vel: number, target: number, vMax: number, aMax: number) => {
      const vd = clamp(lim.gain * (target - pos), -vMax, vMax);
      const a = clamp((vd - vel) / dt, -aMax, aMax);
      const v = vel + a * dt;
      return [pos + v * dt, v] as const;
    };
    [this.x, this.vx] = step(this.x, this.vx, this.tx, lim.vMax, lim.aMax);
    [this.y, this.vy] = step(
      this.y,
      this.vy,
      this.ty,
      lim.vMax * lim.yFactor,
      lim.aMax * lim.yFactor
    );
  }

  /** 到目标点的距离 */
  get error(): number {
    return Math.hypot(this.tx - this.x, this.ty - this.y);
  }
}
