/**
 * 裁判：根据「谁击球、球碰到了什么」判断回合是否结束、谁得分。
 *
 * 状态：
 *  idle          还没发球
 *  serve1        已发球，必须先落在发球方半台
 *  serve2        已落本方台，必须过网落在接发球方半台（擦网后落对方台 = 重发）
 *  rallyIn       last 击球后，必须落在对方半台
 *  rallyBounced  已落在 receiver 半台，receiver 必须在第二跳之前击球
 */
import { otherSide, type Side } from '../constants';

export type PointReason =
  'serveFault' | 'net' | 'out' | 'ownSide' | 'doubleBounce' | 'missed' | 'volley';

export const REASON_TEXT: Record<PointReason, string> = {
  serveFault: '发球失误',
  net: '下网',
  out: '出界',
  ownSide: '落在本方',
  doubleBounce: '两跳',
  missed: '没接到',
  volley: '未落台击球',
};

export type RefereeInput =
  | { type: 'serveHit'; side: Side }
  | { type: 'hit'; side: Side }
  | { type: 'table'; side: Side; edge?: boolean }
  | { type: 'net'; part: 'cord' | 'body' }
  | { type: 'side' }
  | { type: 'floor' }
  /** 死球：长时间没有事件、或飞出很远 */
  | { type: 'dead' };

export type RefereeOutput =
  { type: 'continue' } | { type: 'point'; winner: Side; reason: PointReason } | { type: 'let' };

export type RefereeState = 'idle' | 'serve1' | 'serve2' | 'rallyIn' | 'rallyBounced';

const CONTINUE: RefereeOutput = { type: 'continue' };

export class Referee {
  state: RefereeState = 'idle';
  server: Side = 'near';
  /** 最后击球的一方 */
  last: Side = 'near';
  netTouched = false;

  /** 下一个应该击球的一方（rallyBounced 时有意义） */
  get receiver(): Side {
    return otherSide(this.last);
  }

  reset(server: Side): void {
    this.state = 'idle';
    this.server = server;
    this.last = server;
    this.netTouched = false;
  }

  private point(winner: Side, reason: PointReason): RefereeOutput {
    this.state = 'idle';
    return { type: 'point', winner, reason };
  }

  /**
   * 犯规（玩家的未落台击球：判定比挥拍晚一点，见 HitResolver 的挂起）：回合还在进行就直接判给对方。
   * 不走 feed({ type: 'hit' })，因为判定时球可能已经在本方弹起，那样会被当成合法回球
   */
  foul(side: Side, reason: PointReason): RefereeOutput {
    if (this.state === 'idle') return CONTINUE;
    return this.point(otherSide(side), reason);
  }

  feed(input: RefereeInput): RefereeOutput {
    const server = this.server;
    const receiver = otherSide(server);
    switch (this.state) {
      case 'idle':
        if (input.type === 'serveHit' && input.side === server) {
          this.state = 'serve1';
          this.last = server;
          this.netTouched = false;
        }
        return CONTINUE;

      case 'serve1':
        switch (input.type) {
          case 'table':
            if (input.side === server) {
              this.state = 'serve2';
              return CONTINUE;
            }
            return this.point(receiver, 'serveFault');
          case 'hit':
            return input.side === receiver ? this.point(server, 'volley') : CONTINUE;
          case 'net':
          case 'side':
          case 'floor':
          case 'dead':
            return this.point(receiver, 'serveFault');
          default:
            return CONTINUE;
        }

      case 'serve2':
        switch (input.type) {
          case 'net':
            this.netTouched = true;
            return CONTINUE;
          case 'table':
            if (input.side === server) return this.point(receiver, 'serveFault');
            if (this.netTouched) {
              this.state = 'idle';
              return { type: 'let' };
            }
            this.state = 'rallyBounced';
            this.last = server;
            return CONTINUE;
          case 'hit':
            return input.side === receiver ? this.point(server, 'volley') : CONTINUE;
          case 'side':
          case 'floor':
          case 'dead':
            return this.point(receiver, 'serveFault');
          default:
            return CONTINUE;
        }

      case 'rallyIn': {
        const x = this.last;
        const y = otherSide(x);
        switch (input.type) {
          case 'net':
            this.netTouched = true;
            return CONTINUE;
          case 'table':
            if (input.side === y) {
              this.state = 'rallyBounced';
              return CONTINUE;
            }
            return this.point(y, this.netTouched ? 'net' : 'ownSide');
          case 'hit':
            return input.side === y ? this.point(x, 'volley') : CONTINUE;
          case 'side':
          case 'floor':
          case 'dead':
            return this.point(y, this.netTouched ? 'net' : 'out');
          default:
            return CONTINUE;
        }
      }

      case 'rallyBounced': {
        const x = this.last;
        const y = otherSide(x);
        switch (input.type) {
          case 'hit':
            if (input.side === y) {
              this.state = 'rallyIn';
              this.last = y;
              this.netTouched = false;
            }
            return CONTINUE;
          case 'table':
            return this.point(x, input.side === y ? 'doubleBounce' : 'missed');
          case 'side':
          case 'floor':
          case 'dead':
            return this.point(x, 'missed');
          default:
            return CONTINUE;
        }
      }
    }
  }
}
