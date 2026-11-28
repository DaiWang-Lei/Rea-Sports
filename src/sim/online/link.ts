/**
 * 远程对打的消息（纯逻辑，浏览器和测试共用）：本机的抛球、击球、判的分 → 发给对方；对方传来的 → 用到本机的仿真上。
 * 两边都把自己放在近端（near），所以对方的坐标绕竖直轴转 180°（x、y 取反）才是本机的；
 * 时间由调用方换算（toLocal：对方的时间 → 本机的仿真时间；浏览器里先按两边时钟的差换成本机的时刻，再换成仿真时间）。
 */
import type { Vec3 } from '@/core/vec3';
import { otherSide, type Side } from '../constants';
import type { MatchEvent, MatchSim } from '../MatchSim';
import type { Stroke } from '../players/PlayerSim';
import type { PointReason } from '../rally/Referee';
import type { ShotKind } from '../shot/ShotSpec';

export type OnlineMsg =
  | { k: 'toss'; t: number; height: number }
  | {
      k: 'hit';
      t: number;
      p: Vec3;
      v: Vec3;
      w: Vec3;
      kind: ShotKind;
      serve: boolean;
      smash: boolean;
      oops: boolean;
      power: boolean;
      stroke: Stroke;
    }
  /** winner：me = 发消息的一方，you = 收消息的一方 */
  | { k: 'point'; winner: 'me' | 'you'; reason: PointReason }
  | { k: 'let' };

/** 绕竖直轴转 180°：对方的近端就是本机的远端 */
const turn = (v: Vec3): Vec3 => ({ x: -v.x, y: -v.y, z: v.z });

/** 本机仿真的事件里要发给对方的（local = 本机这一边） */
export function outgoing(e: MatchEvent, local: Side): OnlineMsg | null {
  switch (e.type) {
    case 'toss':
      return e.side === local ? { k: 'toss', t: e.t, height: e.height } : null;
    case 'hit':
      if (e.side !== local || e.remote || !e.state) return null;
      return {
        k: 'hit',
        t: e.t,
        ...e.state,
        kind: e.kind,
        serve: e.serve,
        smash: e.smash,
        oops: e.oops,
        power: !!e.powerServe,
        stroke: e.stroke ?? 'fh',
      };
    case 'point':
      return e.remote
        ? null
        : { k: 'point', winner: e.winner === local ? 'me' : 'you', reason: e.reason };
    case 'let':
      return e.remote ? null : { k: 'let' };
    default:
      return null;
  }
}

/** 把对方传来的用到本机的仿真上（toLocal：消息里的时间 → 本机的仿真时间） */
export function applyRemote(sim: MatchSim, msg: OnlineMsg, toLocal: (t: number) => number): void {
  const remote = sim.remoteSide;
  if (!remote) return;
  switch (msg.k) {
    case 'toss':
      sim.remoteToss(msg.height, toLocal(msg.t));
      break;
    case 'hit':
      sim.remoteHit({
        at: toLocal(msg.t),
        p: turn(msg.p),
        v: turn(msg.v),
        w: turn(msg.w),
        kind: msg.kind,
        serve: msg.serve,
        smash: msg.smash,
        oops: msg.oops,
        power: msg.power,
        stroke: msg.stroke,
      });
      break;
    case 'point':
      sim.remotePoint(msg.winner === 'me' ? remote : otherSide(remote), msg.reason);
      break;
    case 'let':
      sim.remoteLet();
      break;
  }
}
