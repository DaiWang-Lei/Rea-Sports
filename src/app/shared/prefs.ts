/**
 * 玩家的偏好（存在本机，设置页里改，各个玩法都读）：两个人各自的持拍手、击球宽容度、击球后的时机小字。
 * 以前分散在 rea-handed、rea-match、rea-versus、rea-practice 里，第一次读的时候从那里搬过来。
 * 观众声见 crowdVolume.ts，画面延迟补偿（按屏幕记）见 latency.ts。
 */

export interface Prefs {
  /** 1P、2P 的持拍手：1 = 右手，−1 = 左手 */
  handed: [1 | -1, 1 | -1];
  /** 击球宽容度 0..1（严格 0.2 / 标准 0.6 / 宽松 1） */
  leniency: number;
  /** 击球后在画面下方小字提示时机 */
  timingHint: boolean;
}

export const LENIENCY_LEVELS: readonly { v: number; text: string }[] = [
  { v: 0.2, text: '严格' },
  { v: 0.6, text: '标准' },
  { v: 1, text: '宽松' },
];

const KEY = 'rea-prefs';

function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

export function loadPrefs(): Prefs {
  const p = read(KEY) as Partial<Prefs> | null;
  const old = (read('rea-match') ?? {}) as { leniency?: number; timingHint?: boolean };
  const oldVersus = (read('rea-versus') ?? {}) as { handed?: { far?: number } };
  const hand = (v: unknown): 1 | -1 => (v === -1 ? -1 : 1);
  return {
    handed: [
      hand(p?.handed?.[0] ?? read('rea-handed')),
      hand(p?.handed?.[1] ?? oldVersus.handed?.far),
    ],
    leniency: p?.leniency ?? old.leniency ?? 0.6,
    timingHint: p?.timingHint ?? old.timingHint ?? true,
  };
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 隐私模式等：不保存
  }
}

/** 改一项并存下来 */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Prefs {
  const p = loadPrefs();
  p[key] = value;
  savePrefs(p);
  return p;
}
