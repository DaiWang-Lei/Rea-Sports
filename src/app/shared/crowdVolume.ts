/** 观众声音量（存在本机）：大 / 小 / 关，默认小。在设置里调（各个玩法共用） */

export type CrowdVolume = 'big' | 'small' | 'off';

/** 各档的观众声总音量（小 = 1） */
export const CROWD_GAIN: Record<CrowdVolume, number> = { big: 1.5, small: 1, off: 0 };

const KEY = 'rea-crowd';
const TEXT: Record<CrowdVolume, string> = { big: '大', small: '小', off: '关' };

export function loadCrowdVolume(): CrowdVolume {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'big' || v === 'off' ? v : 'small';
  } catch {
    return 'small';
  }
}

export const CROWD_VOLUMES: readonly CrowdVolume[] = ['off', 'small', 'big'];
export const CROWD_TEXT = TEXT;

export function saveCrowdVolume(v: CrowdVolume): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // 隐私模式等：不保存
  }
}
