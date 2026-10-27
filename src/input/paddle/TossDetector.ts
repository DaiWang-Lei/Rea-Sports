/**
 * 向上抖手柄抛球（WSR：按 A 或向上抖遥控器抛球，抖的力度决定抛多高）。纯逻辑，按样本处理。
 *
 * 判定用计划附录里的初值（还没有实测数据，阈值都在 TOSS 里，之后按录制调）：
 *  - 竖直方向的比力（含重力，静止 = 1G）≥ 1.3G，连续至少 3 个样本，期间转得不快（|ω| < 6 rad/s，排除挥拍）；
 *  - 这段向上的加速结束时（比力回落到阈值以下，或已经持续 150ms）触发，期间的峰值 a_pk 决定高度：
 *    h = clamp(0.45 + 0.15·(a_pk − 1.3), 0.45, 1.0) 米（2026-10-27 从 0.18–0.60 提高：抛得低发球太急）；
 *  - 触发后 0.6 秒内不再触发。
 */
import { clamp } from '@/core/math';
import { type Quat, rotate } from '@/core/quat';
import type { Vec3 } from '@/core/vec3';

export const TOSS = {
  /** 竖直比力阈值（g） */
  minG: 1.3,
  /** 至少连续这么多个样本超过阈值 */
  minSamples: 3,
  /** 期间角速度的上限（rad/s） */
  maxOmega: 6,
  /** 向上加速最多看这么久就触发（毫秒） */
  maxMs: 150,
  /** 两次抛球之间至少隔多久（毫秒） */
  refractoryMs: 600,
  /** 高度（米，手以上）：hMin + hSlope·(a_pk − minG)，限制在 hMin..hMax */
  hMin: 0.45,
  hMax: 1.0,
  hSlope: 0.15,
} as const;

export interface TossFrame {
  /** 样本时刻（毫秒） */
  t: number;
  /** 姿态：机体 → 世界（Z 向上） */
  q: Quat;
  /** 原始加速度，机体系，g */
  accel: Vec3;
  /** 角速度，机体系，弧度/秒 */
  gyro: Vec3;
}

export interface TossEvent {
  /** 触发时刻（样本时间，毫秒） */
  t: number;
  /** 竖直比力的峰值（g） */
  peakG: number;
  /** 抛球高度（米，手以上） */
  height: number;
  /** 向上加速持续了多久（毫秒） */
  durationMs: number;
  /** 期间的最大角速度（rad/s） */
  maxOmega: number;
}

/** 抖的力度 → 抛球高度（米） */
export function tossHeight(peakG: number): number {
  return clamp(TOSS.hMin + TOSS.hSlope * (peakG - TOSS.minG), TOSS.hMin, TOSS.hMax);
}

export class TossDetector {
  private run: { start: number; n: number; peak: number; maxW: number } | null = null;
  private lastAt = -Infinity;

  reset(): void {
    this.run = null;
  }

  process(f: TossFrame): TossEvent | null {
    const up = rotate(f.q, f.accel).z;
    const w = Math.hypot(f.gyro.x, f.gyro.y, f.gyro.z);
    const r = this.run;
    if (up >= TOSS.minG) {
      if (!r) {
        this.run = { start: f.t, n: 1, peak: up, maxW: w };
        return null;
      }
      r.n++;
      r.peak = Math.max(r.peak, up);
      r.maxW = Math.max(r.maxW, w);
      return f.t - r.start >= TOSS.maxMs ? this.finish(f.t) : null;
    }
    return r ? this.finish(f.t) : null;
  }

  private finish(t: number): TossEvent | null {
    const r = this.run!;
    this.run = null;
    if (r.n < TOSS.minSamples || r.maxW >= TOSS.maxOmega) return null;
    if (t - this.lastAt < TOSS.refractoryMs) return null;
    this.lastAt = t;
    return {
      t,
      peakG: r.peak,
      height: tossHeight(r.peak),
      durationMs: t - r.start,
      maxOmega: r.maxW,
    };
  }
}
