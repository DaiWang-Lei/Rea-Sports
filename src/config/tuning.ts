/**
 * 所有「手感」参数集中在这里。游戏里读全局 tuning（调试面板可实时修改），
 * 测试和无界面模拟用 createTuning() 拿一份默认值，保证可复现。
 */

export function defaultTuning() {
  return {
    physics: {
      /** 空气阻力系数 k_D = ρ·C_D·A / (2m)，1/米（C_D≈0.47） */
      dragK: 0.13,
      /** 马格努斯系数 K = ρ·A / (2m)，1/米 */
      magnusK: 0.28,
      /** 旋转衰减，1/秒 */
      spinDecay: 0.3,
      /** 台面恢复系数 e = clamp(e0 − slope·|v_n|, min, max)；按 ITTF「30cm 落下反弹约 23cm」标定（含空气阻力） */
      tableE0: 0.965,
      tableESlope: 0.025,
      tableEMin: 0.7,
      tableEMax: 0.965,
      tableMu: 0.25,
      /** 擦边：接触法向的 z 分量 ≥ 该值算有效擦边，否则算打到台子侧面 */
      edgeMinNormalZ: 0.25,
      edgeJitterDeg: 10,
      edgeE: 0.7,
      edgeMu: 0.3,
      sideE: 0.5,
      /** 擦网带 */
      netCordE: 0.35,
      netCordTangential: 0.7,
      netCordSpin: 0.5,
      netCordJitterDeg: 8,
      /** 撞网身 */
      netBodyE: 0.1,
      netBodyDamp: 0.5,
      netBodySpin: 0.3,
      floorE: 0.75,
      floorMu: 0.4,
    },
    shot: {
      /** 6 分制 / 11 分制的整体节奏倍率（WSR 的 11 分制球速明显更快） */
      pace6: 1.0,
      pace11: 1.4,
      /** 最低过网高度（米，球心高出网顶的距离减去球半径） */
      minClearance: 0.025,
      /** 飞行时间 = flightTimeFactor × 水平距离 / 水平速度 */
      flightTimeFactor: 1.08,
      /** 非高球的顶点上限（台面以上） */
      maxApex: 0.9,
    },
    timing: {
      /** 时机归一化窗口 H（毫秒）：τ = Δt / H */
      window6Ms: 90,
      window11Ms: 75,
      /** 视为击中的 τ 范围 */
      tauMin: -1.7,
      tauMax: 1.4,
      /** 显示延迟默认值（毫秒），可在延迟校准里测量 */
      displayLatencyMs: 50,
      /** 挥拍开始到「接触」的预估提前量（毫秒） */
      leadMs: 55,
    },
    contact: {
      /** 理想击球点：台面以上高度、离台端的位置 */
      idealHeight: 0.22,
      idealHeightPopup: 0.55,
      idealY: 1.62,
      /** 弹台后多久才算进入击球区（秒） */
      minAfterBounce: 0.06,
      /** 预测轨迹的最长时间（秒） */
      predictHorizon: 1.4,
    },
    mover: {
      gain: 6.0,
      /** y 方向的速度/加速度限制倍率 */
      yFactor: 0.6,
      /** 正手 / 反手时身体相对击球点的横向偏移 */
      forehandOffset: 0.32,
      backhandOffset: 0.12,
      /** 站位最靠前（离台端的最小距离，|y| 的下限） */
      minDepth: 1.5,
      readyDepth: 2.0,
      /** 站位误差阈值：小于 normal 正常击球，小于 rushed 为「哎呀」，再大就够不着 */
      reachNormal: 0.2,
      reachRushed: 0.45,
    },
    rules: {
      /** 抛球后球落到手下方多少米、或多久没击球就重抛 */
      tossDropBelow: 0.25,
      tossTimeout: 1.2,
      /** 两分之间的停顿（秒），以及多久后允许跳过 */
      betweenPoints: 2.0,
      betweenPointsSkippable: 0.8,
      /** 发球前的停顿（电脑发球前等待） */
      serveDelay: 0.9,
      /** 球在一侧停留超过这么久没人碰（死球） */
      deadBallSeconds: 4,
    },
  };
}

export type Tuning = ReturnType<typeof defaultTuning>;

export function createTuning(): Tuning {
  return defaultTuning();
}

/** 全局可调参数（游戏运行时使用；调试面板直接改这个对象） */
export const tuning: Tuning = createTuning();
