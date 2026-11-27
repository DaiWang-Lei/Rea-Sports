/**
 * 电脑对手（像 WSR：每个对手有自己的名字、样子、水平和打法，按你的熟练度配对）。
 * 熟练度从 0 开始，赢了加、输了扣（Elo 那样：赢比自己强的加得多，比分差大的多一点），1000 分算 Pro；
 * 只有按熟练度配对的那一局才计（自己挑的对手不计）。熟练度越高看台上的观众越多。
 */
import type { CpuStyle } from './difficulty';

/** 对手的样子：Q 版人物的配色，或一套 Kenney 卡通人物 */
export type OpponentLook =
  | {
      q: {
        shirt: number;
        shorts: number;
        skin: number;
        hair: number;
        hairStyle: 'short' | 'bun';
      };
    }
  | { kenney: 'skater-boy' | 'skater-girl' | 'suit' | 'cyborg' };

export interface Opponent {
  id: string;
  name: string;
  /** 对手的熟练度（和你的放在同一把尺子上） */
  skill: number;
  /** 电脑等级 1..5 */
  level: number;
  style: CpuStyle;
  look: OpponentLook;
  /** 冠军 */
  champion?: boolean;
}

const q = (shirt: number, skin: number, hair: number, hairStyle: 'short' | 'bun' = 'short') => ({
  q: { shirt, shorts: 0x2b2d38, skin, hair, hairStyle },
});

/** 按熟练度从低到高 */
export const OPPONENTS: readonly Opponent[] = [
  {
    id: 'xiaodou',
    name: '小豆',
    skill: 0,
    level: 1,
    style: 'allround',
    look: q(0xffb703, 0xf1c9a5, 0x3a2a1f),
  },
  {
    id: 'azhen',
    name: '阿珍',
    skill: 100,
    level: 1,
    style: 'steady',
    look: q(0xff8fab, 0xe0ac7e, 0x2b1d14, 'bun'),
  },
  {
    id: 'dazhuang',
    name: '大壮',
    skill: 200,
    level: 2,
    style: 'attack',
    look: q(0x2a9d8f, 0xc68642, 0x111111),
  },
  {
    id: 'xiaoyu',
    name: '晓雨',
    skill: 320,
    level: 2,
    style: 'chop',
    look: q(0x8ecae6, 0xffdbac, 0x6b4423, 'bun'),
  },
  {
    id: 'ajie',
    name: '阿杰',
    skill: 450,
    level: 2,
    style: 'trick',
    look: q(0x6a4c93, 0xe0ac7e, 0x2b1d14),
  },
  {
    id: 'xiaolin',
    name: '小林',
    skill: 570,
    level: 3,
    style: 'steady',
    look: q(0xffffff, 0xf1c9a5, 0x111111),
  },
  {
    id: 'tiezhu',
    name: '铁柱',
    skill: 680,
    level: 3,
    style: 'attack',
    look: { kenney: 'skater-boy' },
  },
  {
    id: 'afang',
    name: '阿芳',
    skill: 790,
    level: 3,
    style: 'chop',
    look: { kenney: 'skater-girl' },
  },
  { id: 'laowang', name: '老王', skill: 920, level: 4, style: 'steady', look: { kenney: 'suit' } },
  { id: 'mia', name: '米娅', skill: 1060, level: 4, style: 'trick', look: { kenney: 'cyborg' } },
  {
    id: 'along',
    name: '阿龙',
    skill: 1200,
    level: 4,
    style: 'attack',
    look: q(0x1d3557, 0x8d5524, 0x111111),
  },
  {
    id: 'xuejie',
    name: '雪姐',
    skill: 1350,
    level: 5,
    style: 'chop',
    look: q(0xe63946, 0xffdbac, 0xc9a35b, 'bun'),
  },
  {
    id: 'suyao',
    name: '苏瑶',
    skill: 1500,
    level: 5,
    style: 'allround',
    look: q(0xf4a261, 0xe0ac7e, 0x2b1d14, 'bun'),
    champion: true,
  },
];

export const SKILL = {
  /** 多少分算 Pro */
  pro: 1000,
  max: 2500,
  /** 每局最多涨跌多少（低于 Pro 涨得快一点） */
  k: 120,
  kPro: 80,
  /** 配对时在最接近的几个里随机挑 */
  pickAmong: 2,
};

export function opponentById(id: string | null | undefined): Opponent | null {
  return OPPONENTS.find((o) => o.id === id) ?? null;
}

/** 按熟练度配对：离你最近的两个里随机挑一个（rand 0..1） */
export function matchOpponent(rating: number, rand: number): Opponent {
  const sorted = [...OPPONENTS].sort(
    (a, b) => Math.abs(a.skill - rating) - Math.abs(b.skill - rating)
  );
  const n = Math.min(SKILL.pickAmong, sorted.length);
  return sorted[Math.min(n - 1, Math.floor(rand * n))];
}

/**
 * 一局打完熟练度怎么变：result = 你赢 1 / 平 0.5 / 输 0；比分差越大变得越多一点。
 * 返回新的熟练度（0..max）
 */
export function rateGame(
  rating: number,
  opponent: Opponent,
  result: 0 | 0.5 | 1,
  score: { mine: number; theirs: number },
  target: number
): number {
  const expected = 1 / (1 + 10 ** ((opponent.skill - rating) / 400));
  const margin = 1 + (0.5 * Math.abs(score.mine - score.theirs)) / target;
  const k = rating >= SKILL.pro ? SKILL.kPro : SKILL.k;
  const next = Math.round(rating + k * margin * (result - expected));
  return Math.max(0, Math.min(SKILL.max, next));
}

/** 熟练度越高，看台上的观众越多（坐满的比例） */
export function crowdFill(rating: number): number {
  return 0.45 + 0.55 * Math.min(1, rating / 1500);
}
