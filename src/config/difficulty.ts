/**
 * 电脑对手的 5 级难度参数。
 * 2026-10-27 起各级的移动、反应都接近玩家（基本都能追到球），低级别的区别放在回球质量上：
 * 更慢、更居中、偶尔下网出界、偶尔回出高球给你扣杀。以前入门级每秒只跑 2 米、反应 0.3 秒，
 * 对时机误差 45ms 的玩家，约四成回球是「哎呀」高球，一半左右的失分是追不到球漏接，回合碎、像在欺负电脑。
 * 2026-11-16 起各级回球速度收拢到差不多：NSSR 实机视频里不论对手强弱，「击球 → 落到对方台」都在 0.53–0.62 秒、
 * 两次击球间隔约 0.9 秒，高等级不靠球快，靠落点、旋转和反应。以前冠军级快到 0.41 秒 / 0.64 秒。
 * 玩家的回球也放慢到同样的节奏后，电脑总能及时到位，不再因为追不上快球而回出高球，
 * 所以「被逼出高球」由抗压阈值 composure 产生。
 * 2026-11-17 起入门 / 初级 / 中级是「陪练」：自己几乎不犯错（过网、落点、时机误差都小，很少扣你的高球），
 * 每分约 12–14 拍，有来有回；但防守弱（抗压阈值低），你打出快球、大角度、旋转时容易被逼出高球。
 * 以前它们每分只有 6–8 拍，你的得分八成以上是电脑白送的（自己下网、出界、无故回高球），没有挑战。
 * 高级 / 冠军不变：会抢攻，失误多是抢攻出界；防守强。
 * 2026-11-23 去掉了「回合越长越容易被逼出高球」（长回合第 15 拍以后电脑三到六成是慢悠悠的高球，像慢动作），
 * 来球威胁的球速也按节奏换算了，抗压阈值按「回球带上旋的真人」重新标定（玩家的旋转改成以刷球为主后，
 * 八成回球带上旋，上旋计入威胁）：机器人（时机误差 70ms、刷球 25°±12°）对打时电脑的高球
 * 6 分制入门约 12%、中级 7%、高级 5%、冠军 4%，11 分制高级约 10%、冠军 8%，不随回合长度变化。
 */

export interface CpuLevel {
  name: string;
  /** 对方击球后多久开始反应（秒） */
  reaction: number;
  vMax: number;
  aMax: number;
  /** 击球时机误差：均值 / 标准差（毫秒，负数 = 偏早） */
  timingMu: number;
  timingSigma: number;
  /** 瞄准时离边线留的余量 / 落点散布（米） */
  aimMargin: number;
  landingSigma: number;
  /** 回球速度倍率范围 */
  speedMin: number;
  speedMax: number;
  /** 使用旋转 / 侧旋的概率；旋转球里拉上旋（其余是削下旋）的比例 */
  spinUse: number;
  curveUse: number;
  driveShare: number;
  /** 遇到高球扣杀的概率 / 接住对方扣杀的概率 */
  smashP: number;
  smashReturnP: number;
  /** 接不住扣杀时愣在原地（不躲）的概率：愣住的人可能被球打到脸上、身上 */
  flinchP: number;
  /** 预测落点的噪声（米） / 假动作概率 */
  predSigma: number;
  feintP: number;
  /** 抗压能力阈值：来球威胁超过它越多，越容易回出「哎呀」高球 */
  composure: number;
  /** 过网高度的随机误差（米）：太低会下网 */
  clearanceSigma: number;
}

export const CPU_LEVELS: CpuLevel[] = [
  {
    name: '入门',
    reaction: 0.2,
    vMax: 3.2,
    aMax: 13,
    timingMu: -10,
    timingSigma: 25,
    aimMargin: 0.3,
    landingSigma: 0.09,
    speedMin: 0.87,
    speedMax: 1.02,
    spinUse: 0.1,
    curveUse: 0,
    driveShare: 0.6,
    smashP: 0.15,
    smashReturnP: 0.05,
    flinchP: 0.6,
    predSigma: 0.12,
    feintP: 0,
    composure: 0.21,
    clearanceSigma: 0.012,
  },
  {
    name: '初级',
    reaction: 0.18,
    vMax: 3.3,
    aMax: 14,
    timingMu: -8,
    timingSigma: 22,
    aimMargin: 0.24,
    landingSigma: 0.085,
    speedMin: 0.85,
    speedMax: 1.01,
    spinUse: 0.25,
    curveUse: 0.05,
    driveShare: 0.6,
    smashP: 0.3,
    smashReturnP: 0.15,
    flinchP: 0.45,
    predSigma: 0.1,
    feintP: 0,
    composure: 0.24,
    clearanceSigma: 0.014,
  },
  {
    name: '中级',
    reaction: 0.15,
    vMax: 3.4,
    aMax: 15,
    timingMu: -5,
    timingSigma: 18,
    aimMargin: 0.16,
    landingSigma: 0.08,
    speedMin: 0.86,
    speedMax: 1.02,
    spinUse: 0.4,
    curveUse: 0.1,
    driveShare: 0.6,
    smashP: 0.5,
    smashReturnP: 0.3,
    flinchP: 0.3,
    predSigma: 0.08,
    feintP: 0.05,
    composure: 0.26,
    clearanceSigma: 0.016,
  },
  {
    name: '高级',
    reaction: 0.13,
    vMax: 3.6,
    aMax: 16,
    timingMu: -5,
    timingSigma: 17,
    aimMargin: 0.1,
    landingSigma: 0.075,
    speedMin: 0.87,
    speedMax: 1.03,
    spinUse: 0.55,
    curveUse: 0.15,
    driveShare: 0.6,
    smashP: 0.9,
    smashReturnP: 0.45,
    flinchP: 0.2,
    predSigma: 0.07,
    feintP: 0.1,
    composure: 0.29,
    clearanceSigma: 0.02,
  },
  {
    name: '冠军',
    reaction: 0.1,
    vMax: 3.8,
    aMax: 17,
    timingMu: 0,
    timingSigma: 12,
    aimMargin: 0.07,
    landingSigma: 0.055,
    speedMin: 0.88,
    speedMax: 1.04,
    spinUse: 0.7,
    curveUse: 0.2,
    driveShare: 0.6,
    smashP: 0.97,
    smashReturnP: 0.6,
    flinchP: 0.1,
    predSigma: 0.06,
    feintP: 0.15,
    composure: 0.31,
    clearanceSigma: 0.014,
  },
];

export function cpuLevel(level: number): CpuLevel {
  return CPU_LEVELS[Math.max(0, Math.min(CPU_LEVELS.length - 1, Math.round(level) - 1))];
}

/**
 * 电脑的打法（像 WSR 里每个对手各有风格，比如专门的削球手）：在等级参数上修正，等级定水平、风格定打法。
 *  - allround 全面型：按等级不变
 *  - attack 进攻型：多拉上旋、多扣杀，球快，落点贴边；防守差一点
 *  - chop 削球型：大多回下旋（一直拉对他没用），球慢但稳，接扣杀好，很少扣杀
 *  - steady 稳健型：少用旋转，落点稳、少失误，不冒险
 *  - trick 旋转型：多侧旋、多假动作
 */
export type CpuStyle = 'allround' | 'attack' | 'chop' | 'steady' | 'trick';

export const STYLE_TEXT: Record<CpuStyle, { name: string; blurb: string }> = {
  allround: { name: '全面型', blurb: '什么球都会一点，没有明显的短板' },
  attack: { name: '进攻型', blurb: '爱拉上旋、爱扣杀，球快、落点贴边；防守差一点' },
  chop: { name: '削球型', blurb: '大多回下旋，一直拉对他没用；扣杀他也常能接回来' },
  steady: { name: '稳健型', blurb: '很少旋转，落点稳、失误少，要靠你主动拉开' },
  trick: { name: '旋转型', blurb: '侧旋多、假动作多，球会突然拐弯' },
};

const clamp01 = (v: number, max = 1) => Math.max(0, Math.min(max, v));

/** 带风格的电脑参数 */
export function styledLevel(base: CpuLevel, style: CpuStyle = 'allround'): CpuLevel {
  const lv = { ...base };
  switch (style) {
    case 'attack':
      lv.spinUse = clamp01(lv.spinUse + 0.25, 0.85);
      lv.driveShare = 0.85;
      lv.smashP = clamp01(lv.smashP * 1.6, 0.97);
      lv.speedMin += 0.05;
      lv.speedMax += 0.08;
      lv.aimMargin = Math.max(0.06, lv.aimMargin - 0.05);
      lv.smashReturnP *= 0.8;
      lv.composure -= 0.03;
      break;
    case 'chop':
      lv.spinUse = clamp01(lv.spinUse + 0.35, 0.85);
      lv.driveShare = 0.1;
      lv.speedMin -= 0.08;
      lv.speedMax -= 0.08;
      lv.landingSigma *= 0.85;
      lv.clearanceSigma *= 0.8;
      lv.smashP *= 0.4;
      lv.smashReturnP = clamp01(lv.smashReturnP * 1.4 + 0.1, 0.85);
      lv.composure += 0.03;
      break;
    case 'steady':
      lv.spinUse *= 0.6;
      lv.curveUse *= 0.5;
      lv.landingSigma *= 0.75;
      lv.clearanceSigma *= 0.7;
      lv.aimMargin += 0.05;
      lv.speedMax -= 0.04;
      lv.smashP *= 0.8;
      break;
    case 'trick':
      lv.curveUse = clamp01(lv.curveUse + 0.2, 0.4);
      lv.feintP = clamp01(lv.feintP + 0.15);
      break;
    default:
      break;
  }
  return lv;
}
