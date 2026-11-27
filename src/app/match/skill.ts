/** 你的熟练度（存在本机）：和按熟练度配对的电脑打完一局后更新，见 config/opponents.ts */

export interface SkillRecord {
  rating: number;
  /** 计熟练度的局数、赢的局数 */
  games: number;
  wins: number;
}

const KEY = 'rea-skill';

export function loadSkill(): SkillRecord {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<SkillRecord> | null;
    return {
      rating: Math.max(0, Math.round(s?.rating ?? 0)),
      games: s?.games ?? 0,
      wins: s?.wins ?? 0,
    };
  } catch {
    return { rating: 0, games: 0, wins: 0 };
  }
}

export function saveSkill(s: SkillRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 隐私模式等：不保存
  }
}
