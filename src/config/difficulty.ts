/**
 * 电脑对手的 5 级难度参数。
 * 2026-10-27 起各级的移动、反应都接近玩家（基本都能追到球），低级别的区别放在回球质量上：
 * 更慢、更居中、偶尔下网出界、偶尔回出高球给你扣杀。以前入门级每秒只跑 2 米、反应 0.3 秒，
 * 对时机误差 45ms 的玩家，约四成回球是「哎呀」高球，一半左右的失分是追不到球漏接，回合碎、像在欺负电脑。
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
  /** 使用旋转 / 侧旋的概率 */
  spinUse: number;
  curveUse: number;
  /** 遇到高球扣杀的概率 / 接住对方扣杀的概率 */
  smashP: number;
  smashReturnP: number;
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
    timingMu: -30,
    timingSigma: 40,
    aimMargin: 0.3,
    landingSigma: 0.14,
    speedMin: 0.65,
    speedMax: 0.85,
    spinUse: 0.1,
    curveUse: 0,
    smashP: 0.3,
    smashReturnP: 0.05,
    predSigma: 0.12,
    feintP: 0,
    composure: 0.5,
    clearanceSigma: 0.04,
  },
  {
    name: '初级',
    reaction: 0.18,
    vMax: 3.3,
    aMax: 14,
    timingMu: -20,
    timingSigma: 32,
    aimMargin: 0.24,
    landingSigma: 0.12,
    speedMin: 0.75,
    speedMax: 0.95,
    spinUse: 0.25,
    curveUse: 0.05,
    smashP: 0.55,
    smashReturnP: 0.15,
    predSigma: 0.1,
    feintP: 0,
    composure: 0.6,
    clearanceSigma: 0.033,
  },
  {
    name: '中级',
    reaction: 0.15,
    vMax: 3.4,
    aMax: 15,
    timingMu: -10,
    timingSigma: 24,
    aimMargin: 0.16,
    landingSigma: 0.1,
    speedMin: 0.85,
    speedMax: 1.1,
    spinUse: 0.4,
    curveUse: 0.1,
    smashP: 0.75,
    smashReturnP: 0.3,
    predSigma: 0.08,
    feintP: 0.05,
    composure: 0.7,
    clearanceSigma: 0.026,
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
    speedMin: 0.95,
    speedMax: 1.3,
    spinUse: 0.55,
    curveUse: 0.15,
    smashP: 0.9,
    smashReturnP: 0.45,
    predSigma: 0.07,
    feintP: 0.1,
    composure: 0.78,
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
    speedMin: 1.0,
    speedMax: 1.45,
    spinUse: 0.7,
    curveUse: 0.2,
    smashP: 0.97,
    smashReturnP: 0.6,
    predSigma: 0.06,
    feintP: 0.15,
    composure: 0.88,
    clearanceSigma: 0.014,
  },
];

export function cpuLevel(level: number): CpuLevel {
  return CPU_LEVELS[Math.max(0, Math.min(CPU_LEVELS.length - 1, Math.round(level) - 1))];
}
