/** 球员在仿真里的状态（走位、正反手、挥拍动画时间轴） */
import type { Tuning } from '@/config/tuning';
import type { Vec3 } from '@/core/vec3';
import { type Side, TABLE } from '../constants';
import type { ShotKind } from '../shot/ShotSpec';
import { Mover, type MoverLimits } from './Mover';

export type Stroke = 'fh' | 'bh';

/** 挥拍动画（渲染用）：start 开始引拍，hit 击球，end 收拍 */
export interface SwingAnim {
  start: number;
  hit: number;
  end: number;
  stroke: Stroke;
  /** 引拍高度（台面以上）：高 = 下旋/侧旋，低 = 上旋 */
  height: number;
  kind: ShotKind | null;
  /** 击球点（世界坐标），击球前为预测值 */
  contact: Vec3;
  whiff?: boolean;
}

export interface PlayerSim {
  side: Side;
  /** 1 = 右手，−1 = 左手 */
  handed: 1 | -1;
  mover: Mover;
  limits: MoverLimits;
  stance: Stroke;
  swing: SwingAnim | null;
  /** 抛球动画 */
  tossAt: number;
  isCpu: boolean;
}

/** 某一侧球员的「右手方向」在世界 x 上的符号：近端面向 +y，右手是 +x；远端相反 */
export function rightSign(side: Side): 1 | -1 {
  return side === 'near' ? 1 : -1;
}

/** 正手在世界 x 上的方向 */
export function forehandSign(p: { side: Side; handed: 1 | -1 }): number {
  return rightSign(p.side) * p.handed;
}

/** 为了在 contact 处用某种站位击球，身体（脚下）应该在哪里 */
export function bodyForContact(
  p: { side: Side; handed: 1 | -1 },
  contact: { x: number; y: number },
  stroke: Stroke,
  tune: Tuning
): { x: number; y: number } {
  const m = tune.mover;
  const offset = stroke === 'fh' ? m.forehandOffset : -m.backhandOffset;
  const x = contact.x - offset * forehandSign(p);
  const y =
    p.side === 'near'
      ? Math.min(contact.y - 0.45, -m.minDepth)
      : Math.max(contact.y + 0.45, m.minDepth);
  return { x, y };
}

export function readyPosition(side: Side, x: number, tune: Tuning): { x: number; y: number } {
  return { x: 0.2 * x, y: side === 'near' ? -tune.mover.readyDepth : tune.mover.readyDepth };
}

export function createPlayer(
  side: Side,
  handed: 1 | -1,
  isCpu: boolean,
  limits: MoverLimits,
  tune: Tuning
): PlayerSim {
  const r = readyPosition(side, 0, tune);
  return {
    side,
    handed,
    mover: new Mover(r.x, r.y),
    limits,
    stance: 'fh',
    swing: null,
    tossAt: -Infinity,
    isCpu,
  };
}

/** 发球时持球的手的位置 */
export function serveHandPosition(p: PlayerSim): Vec3 {
  const dir = p.side === 'near' ? 1 : -1;
  return {
    x: p.mover.x + 0.12 * forehandSign(p),
    y: p.mover.y + dir * 0.42,
    z: TABLE.height + 0.18,
  };
}
