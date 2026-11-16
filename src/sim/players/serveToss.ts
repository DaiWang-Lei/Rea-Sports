/**
 * 抛球后的理想发球点（玩家和电脑共用）：按真实轨迹（带空气阻力）找球的最高点，
 * 以及球下落经过手上方 serve.sweetAboveHand 的时刻。
 */
import type { Tuning } from '@/config/tuning';
import { type BallState, predict } from '../ball/physics';
import { SIM_DT } from '../constants';

export interface TossPlan {
  /** 球到最高点的时刻 */
  apex: number;
  /** 理想击球时刻 */
  ideal: number;
  /** 理想击球时刻的球 */
  at: BallState;
}

/** ball = 刚离手的球 */
export function planToss(ball: BallState, now: number, tune: Tuning): TossPlan {
  const sweetZ = ball.p.z + tune.serve.sweetAboveHand;
  const pred = predict(ball, now, 2, tune.physics);
  let apex = now;
  let topZ = -Infinity;
  for (let i = 0; i < pred.states.length; i++) {
    const st = pred.states[i];
    if (st.p.z > topZ) {
      topZ = st.p.z;
      apex = now + i * SIM_DT;
    }
    if (st.v.z < 0 && st.p.z <= sweetZ) return { apex, ideal: now + i * SIM_DT, at: st };
  }
  return { apex, ideal: apex + 0.3, at: ball };
}
