/** 比赛里的小字（和电脑对打、双人对打共用）：挥空原因、时机、这一拍是怎么打的 */
import type { HumanShot } from '@/sim/players/HumanPlayer';
import type { ShotKind } from '@/sim/shot/ShotSpec';

export const WHIFF_TEXT: Record<string, string> = {
  early: '挥早了',
  late: '挥晚了',
  reach: '够不着',
};

export function timingText(ms: number): string {
  return Math.abs(ms) <= 20 ? '时机正好' : `${ms < 0 ? '早' : '晚'} ${Math.abs(ms)}ms`;
}

/** 至少 5 个才算 */
export function median(v: number[]): number | null {
  if (v.length < 5) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** 回球：正手 / 反手、旋转、时机 */
export function strokeText(h: HumanShot, kind: ShotKind): string {
  const stroke = h.stroke === 'fh' ? '正手' : '反手';
  const spin =
    kind === 'curve' ? ' · 侧旋' : h.spin >= 0.3 ? ' · 上旋' : h.spin <= -0.3 ? ' · 下旋' : '';
  return `${stroke}${spin} · ${timingText(h.timingMs)}`;
}

/** 发球：时机、强力发球 */
export function serveText(h: HumanShot, powerServe: boolean): string {
  return `发球 · ${timingText(h.timingMs)}${powerServe ? ' · 强力发球' : ''}`;
}
