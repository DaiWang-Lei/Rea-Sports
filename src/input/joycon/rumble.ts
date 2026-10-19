/**
 * Joy-Con HD 震动编码（单侧 4 字节：高频频率/幅度 + 低频频率/幅度）。
 * 参考 dekuNukem rumble_data_table 与 CTCaer jc_toolkit 的编码方式：
 *   频率：enc = round(32·log2(f/10))；高频码 = (enc − 0x60)·4，低频码 = enc − 0x40
 *   幅度：先编码成 0..100 的指数刻度 e，高频幅度字节 = 2e，低频幅度 = (e>>1)+0x40（e 为奇数时带 0x8000 标志）
 * 静止帧为 00 01 40 40。
 */
import { clamp } from '@/core/math';

export const HF_MIN_HZ = 81.75;
export const HF_MAX_HZ = 1252.57;
export const LF_MIN_HZ = 40.88;
export const LF_MAX_HZ = 626.29;

function encodeFreq(freq: number): number {
  return Math.round(32 * Math.log2(freq / 10));
}

/** 指数刻度 e（0..100）对应的实际幅度，三段式，与官方幅度表一致 */
export function decodeAmplitude(e: number): number {
  if (e <= 0) return 0;
  if (e >= 32) return Math.pow(2, e / 32) / 8.7;
  if (e >= 16) return Math.pow(2, e / 16) / 17;
  return 0.0083605 * Math.pow(2, e / 4);
}

const AMPLITUDE_TABLE = Array.from({ length: 101 }, (_, e) => decodeAmplitude(e));

/** 幅度 0..1 → 指数刻度 0..100：在官方表里找最接近的一档 */
export function encodeAmplitude(amp: number): number {
  if (!(amp > 0)) return 0;
  const a = Math.min(amp, 1);
  let best = 1;
  for (let e = 1; e <= 100; e++) {
    if (Math.abs(AMPLITUDE_TABLE[e] - a) < Math.abs(AMPLITUDE_TABLE[best] - a)) best = e;
  }
  return best;
}

export interface RumbleBand {
  /** 频率 Hz */
  freq: number;
  /** 幅度 0..1 */
  amp: number;
}

/** 编码单侧马达的 4 字节 */
export function encodeRumbleSide(hf: RumbleBand, lf: RumbleBand): [number, number, number, number] {
  const hfCode = clamp((encodeFreq(clamp(hf.freq, HF_MIN_HZ, HF_MAX_HZ)) - 0x60) * 4, 0x04, 0x1fc);
  const lfCode = clamp(encodeFreq(clamp(lf.freq, LF_MIN_HZ, LF_MAX_HZ)) - 0x40, 0x01, 0x7f);
  const eh = encodeAmplitude(hf.amp);
  const el = encodeAmplitude(lf.amp);
  const hfAmpByte = eh * 2;
  const lfAmp = ((el >> 1) + 0x40) | (el & 1 ? 0x8000 : 0);
  return [
    hfCode & 0xff,
    (hfAmpByte + ((hfCode >> 8) & 0xff)) & 0xff,
    (lfCode + ((lfAmp >> 8) & 0xff)) & 0xff,
    lfAmp & 0xff,
  ];
}

/** 8 字节震动数据（左右两个马达位都填同样的值；单只 Joy-Con 只用自己那一侧） */
export function encodeRumble(hf: RumbleBand, lf: RumbleBand): number[] {
  const side = encodeRumbleSide(hf, lf);
  return [...side, ...side];
}

/** 一个震动脉冲：持续时间 + 两个频段 */
export interface RumblePulse {
  durationMs: number;
  hf: RumbleBand;
  lf: RumbleBand;
}

export const RUMBLE_MAX_AMP = 0.8;
