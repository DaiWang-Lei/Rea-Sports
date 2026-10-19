/**
 * 理想击球点：对方击球后，预测轨迹，找到球在接球方半台弹起之后、最适合击球的那一刻。
 * 代价函数 J = ((z − z*)/0.12)² + ((y − y*)/0.30)²，z* 为台面以上 0.22m（高球 0.55m），y* 为台端外 1.62m。
 */
import type { Vec3 } from '@/core/vec3';
import type { Tuning } from '@/config/tuning';
import { type BallState, predict, type Prediction } from '../ball/physics';
import { type Side, sideDir, SIM_DT, TABLE } from '../constants';

export interface ContactPlan {
  /** false：球不会正常落在接球方半台（会出界/下网），不需要接 */
  ok: boolean;
  receiver: Side;
  /** 落在接球方半台的时刻（绝对仿真时间） */
  bounceT: number;
  bounceP: Vec3 | null;
  /** 理想击球时刻 T_ideal 与位置 C */
  t: number;
  p: Vec3;
  /** 理想击球时刻的球速（用于判断来球威胁） */
  v: Vec3;
  w: Vec3;
  popup: boolean;
  prediction: Prediction;
}

export function planContact(
  ball: BallState,
  now: number,
  receiver: Side,
  popup: boolean,
  tune: Tuning
): ContactPlan {
  const c = tune.contact;
  const pred = predict(ball, now, c.predictHorizon, tune.physics, 4);
  const fail = (): ContactPlan => ({
    ok: false,
    receiver,
    bounceT: NaN,
    bounceP: null,
    t: NaN,
    p: { ...ball.p },
    v: { ...ball.v },
    w: { ...ball.w },
    popup,
    prediction: pred,
  });

  // 第一个台面事件必须落在接球方半台（之前可以擦网带）
  let bounceIdx = -1;
  let bounceT = NaN;
  let bounceP: Vec3 | null = null;
  let endT = Infinity;
  for (let i = 0; i < pred.events.length; i++) {
    const e = pred.events[i];
    if (e.type === 'net' && e.part === 'cord') continue;
    if (e.type === 'table' && e.side === receiver && bounceIdx < 0) {
      bounceT = e.t;
      bounceP = e.p;
      bounceIdx = i;
      // 弹起后的下一个事件（第二跳/落地）是击球窗口的结束
      endT = pred.events[i + 1]?.t ?? Infinity;
      break;
    }
    return fail();
  }
  if (bounceIdx < 0) return fail();

  const zStar = TABLE.height + (popup ? c.idealHeightPopup : c.idealHeight);
  const yStar = -sideDir(receiver) * c.idealY;
  let best = -1;
  let bestJ = Infinity;
  const startI = Math.ceil((bounceT + c.minAfterBounce - now) / SIM_DT);
  for (let i = Math.max(0, startI); i < pred.states.length; i++) {
    const t = now + i * SIM_DT;
    if (t >= endT) break;
    const s = pred.states[i];
    const j = ((s.p.z - zStar) / 0.12) ** 2 + ((s.p.y - yStar) / 0.3) ** 2;
    if (j < bestJ) {
      bestJ = j;
      best = i;
    }
  }
  if (best < 0) return fail();
  const s = pred.states[best];
  return {
    ok: true,
    receiver,
    bounceT,
    bounceP,
    t: now + best * SIM_DT,
    p: { ...s.p },
    v: { ...s.v },
    w: { ...s.w },
    popup,
    prediction: pred,
  };
}

/** 预测结果里某个时刻的球状态（最近的仿真步） */
export function stateAt(pred: Prediction, t: number): BallState | null {
  const i = Math.round((t - pred.t0) / SIM_DT);
  return pred.states[Math.max(0, Math.min(pred.states.length - 1, i))] ?? null;
}
