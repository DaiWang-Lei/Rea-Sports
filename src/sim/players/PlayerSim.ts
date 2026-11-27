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
  /** 接不住扣杀、缩头弯腰躲着（站在原地不动） */
  cowering: boolean;
}

/** 缩头弯腰躲扣杀时整个人矮多少（米）：仿真里算球打不打得到人、画面上的姿势都用它 */
export const COWER_DROP = 0.25;

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
  // 自己这一边在 y 的哪个方向；身体一般在击球点后面 0.45 米，击球点出了台边越远，越是站在球的侧面而不是后面
  const own = p.side === 'near' ? -1 : 1;
  const out = Math.min(1, Math.max(0, (Math.abs(contact.x) - TABLE.halfWidth) / 0.5));
  const back = own * (contact.y + own * 0.45 * (1 - 0.6 * out));
  // 在台面左右以外可以往前站到球台侧面，否则站在台端后面
  const beside = Math.abs(x) >= TABLE.halfWidth + m.sideClear;
  return { x, y: own * Math.max(back, beside ? m.netMin : m.minDepth) };
}

/**
 * 人不能走进球台占的地方（台面加上身体离台边、台端的余量）：走进去了就推回到最近的那条边上。
 * 从台后去球台侧面时，先沿着台端往外走，绕过台角再往前
 */
export function keepOffTable(m: Mover, tune: Tuning): void {
  const xLim = TABLE.halfWidth + tune.mover.sideClear;
  const yLim = tune.mover.minDepth;
  const ax = Math.abs(m.x);
  const ay = Math.abs(m.y);
  if (ax >= xLim || ay >= yLim) return;
  if (xLim - ax < yLim - ay) {
    m.x = Math.sign(m.x || 1) * xLim;
    m.vx = 0;
  } else {
    m.y = Math.sign(m.y || 1) * yLim;
    m.vy = 0;
  }
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
    cowering: false,
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
