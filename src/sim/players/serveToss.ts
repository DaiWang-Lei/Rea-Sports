/**
 * 抛球后的理想发球点（玩家和电脑共用）：按真实轨迹（带空气阻力）找球的最高点，
 * 球下落经过手上方 serve.sweetAboveHand 的时刻，以及球掉到重抛线（手下方 rules.tossDropBelow）之前的最后时刻。
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
  /** 最后还能击球的时刻（再晚球就掉到重抛线以下） */
  last: number;
}

/** ball = 刚离手的球 */
export function planToss(ball: BallState, now: number, tune: Tuning): TossPlan {
  const sweetZ = ball.p.z + tune.serve.sweetAboveHand;
  const floorZ = ball.p.z - tune.rules.tossDropBelow;
  const pred = predict(ball, now, 2.5, tune.physics);
  let apex = now;
  let topZ = -Infinity;
  let ideal = NaN;
  let at = ball;
  for (let i = 0; i < pred.states.length; i++) {
    const st = pred.states[i];
    const t = now + i * SIM_DT;
    if (st.p.z > topZ) {
      topZ = st.p.z;
      apex = t;
    }
    if (Number.isNaN(ideal) && st.v.z < 0 && st.p.z <= sweetZ) {
      ideal = t;
      at = st;
    }
    if (st.v.z < 0 && st.p.z < floorZ) return { apex, ideal, at, last: t - SIM_DT };
  }
  if (Number.isNaN(ideal)) ideal = apex + 0.3;
  return { apex, ideal, at, last: Infinity };
}
