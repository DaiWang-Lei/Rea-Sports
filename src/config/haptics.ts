/** Joy-Con 震动预设（幅度会在驱动里被限制到 0.8 以内） */
import type { RumblePulse } from '@/input/joycon/rumble';

export type HapticEvent = 'hit' | 'smash' | 'oops' | 'toss';

const GAP: RumblePulse = { durationMs: 40, hf: { freq: 320, amp: 0 }, lf: { freq: 160, amp: 0 } };

export const HAPTICS: Record<HapticEvent, RumblePulse[]> = {
  hit: [{ durationMs: 35, hf: { freq: 320, amp: 0.45 }, lf: { freq: 160, amp: 0.35 } }],
  smash: [{ durationMs: 70, hf: { freq: 280, amp: 0.75 }, lf: { freq: 120, amp: 0.65 } }],
  oops: [
    { durationMs: 25, hf: { freq: 320, amp: 0.3 }, lf: { freq: 160, amp: 0.3 } },
    GAP,
    { durationMs: 25, hf: { freq: 320, amp: 0.3 }, lf: { freq: 160, amp: 0.3 } },
  ],
  toss: [{ durationMs: 15, hf: { freq: 320, amp: 0.2 }, lf: { freq: 160, amp: 0.2 } }],
};

export const HAPTIC_LABELS: Record<HapticEvent, string> = {
  hit: '击球',
  smash: '扣杀',
  oops: '哎呀',
  toss: '抛球',
};
