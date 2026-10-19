/** 电脑对手的 5 级难度参数 */

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
    reaction: 0.3,
    vMax: 2.0,
    aMax: 7,
    timingMu: -30,
    timingSigma: 40,
    aimMargin: 0.25,
    landingSigma: 0.16,
    speedMin: 0.8,
    speedMax: 1.0,
    spinUse: 0.1,
    curveUse: 0,
    smashP: 0.3,
    smashReturnP: 0.05,
    predSigma: 0.25,
    feintP: 0,
    composure: 0.35,
    clearanceSigma: 0.04,
  },
  {
    name: '初级',
    reaction: 0.25,
    vMax: 2.4,
    aMax: 9,
    timingMu: -20,
    timingSigma: 32,
    aimMargin: 0.2,
    landingSigma: 0.13,
    speedMin: 0.85,
    speedMax: 1.1,
    spinUse: 0.25,
    curveUse: 0.05,
    smashP: 0.55,
    smashReturnP: 0.15,
    predSigma: 0.2,
    feintP: 0,
    composure: 0.5,
    clearanceSigma: 0.033,
  },
  {
    name: '中级',
    reaction: 0.2,
    vMax: 2.8,
    aMax: 11,
    timingMu: -10,
    timingSigma: 24,
    aimMargin: 0.14,
    landingSigma: 0.1,
    speedMin: 0.9,
    speedMax: 1.2,
    spinUse: 0.4,
    curveUse: 0.1,
    smashP: 0.75,
    smashReturnP: 0.3,
    predSigma: 0.15,
    feintP: 0.05,
    composure: 0.65,
    clearanceSigma: 0.026,
  },
  {
    name: '高级',
    reaction: 0.16,
    vMax: 3.2,
    aMax: 13,
    timingMu: -5,
    timingSigma: 17,
    aimMargin: 0.1,
    landingSigma: 0.075,
    speedMin: 0.95,
    speedMax: 1.35,
    spinUse: 0.55,
    curveUse: 0.15,
    smashP: 0.9,
    smashReturnP: 0.45,
    predSigma: 0.1,
    feintP: 0.1,
    composure: 0.72,
    clearanceSigma: 0.02,
  },
  {
    name: '冠军',
    reaction: 0.12,
    vMax: 3.6,
    aMax: 15,
    timingMu: 0,
    timingSigma: 12,
    aimMargin: 0.07,
    landingSigma: 0.055,
    speedMin: 1.0,
    speedMax: 1.5,
    spinUse: 0.7,
    curveUse: 0.2,
    smashP: 0.97,
    smashReturnP: 0.6,
    predSigma: 0.08,
    feintP: 0.15,
    composure: 0.85,
    clearanceSigma: 0.014,
  },
];

export function cpuLevel(level: number): CpuLevel {
  return CPU_LEVELS[Math.max(0, Math.min(CPU_LEVELS.length - 1, Math.round(level) - 1))];
}
