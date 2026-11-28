/**
 * 远程对打里对方的那一边：击球在对方自己的电脑上判定，结果经网络传过来（见 MatchSim.remoteHit）。
 * 这里只负责画面上的人：球朝他飞时自动跑到接球的位置（和人、电脑一样的走位），没球时回准备位置。
 */
import type { Tuning } from '@/config/tuning';
import type { BallState } from '../ball/physics';
import type { Side } from '../constants';
import { type ContactPlan, planContact } from '../hit/contactZone';
import type { MatchPhase } from '../MatchSim';
import { bodyForContact, forehandSign, type PlayerSim, readyPosition } from './PlayerSim';

export interface RemoteHost {
  readonly t: number;
  readonly ball: BallState;
  readonly tune: Tuning;
  readonly phase: MatchPhase;
  player(side: Side): PlayerSim;
}

export class RemotePlayer {
  private plan: ContactPlan | null = null;

  constructor(readonly side: Side) {}

  cancel(): void {
    this.plan = null;
  }

  prepareServe(_at: number): void {
    // 对方自己决定什么时候抛球
  }

  /** 球朝他飞来：按预测的击球点跑位、定正反手 */
  onIncoming(host: RemoteHost, popup: boolean, smash: boolean): void {
    const plan = planContact(host.ball, host.t, this.side, popup, host.tune, smash);
    this.plan = plan.ok ? plan : null;
    if (!this.plan) return;
    const me = host.player(this.side);
    me.stance = (this.plan.p.x - me.mover.x) * forehandSign(me) > -0.15 ? 'fh' : 'bh';
  }

  tick(host: RemoteHost): void {
    const me = host.player(this.side);
    const ph = host.phase;
    if ((ph.kind === 'preServe' || ph.kind === 'toss') && ph.server === this.side) return;
    if (this.plan && host.t < this.plan.t + 0.2) {
      const body = bodyForContact(me, this.plan.p, me.stance, host.tune);
      me.mover.setTarget(body.x, body.y);
      return;
    }
    const r = readyPosition(this.side, me.mover.x, host.tune);
    me.mover.setTarget(r.x, r.y);
  }
}
