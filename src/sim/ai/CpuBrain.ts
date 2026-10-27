/**
 * 电脑对手：反应延迟 → 带噪声地预测击球点并走位 → 落台时决定回什么球（引拍高度暗示旋转）→
 * 在「理想时刻 + 时机误差」挥拍。发球：抛球，到最高点后约 0.12 秒击球。
 */
import { type CpuLevel, cpuLevel } from '@/config/difficulty';
import type { Tuning } from '@/config/tuning';
import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { BallState } from '../ball/physics';
import { GRAVITY, otherSide, type Side, TABLE } from '../constants';
import { type ContactPlan, planContact } from '../hit/contactZone';
import { bodyForContact, forehandSign, type PlayerSim, readyPosition } from '../players/PlayerSim';
import type { ServeSpec } from '../shot/ShotSpec';
import {
  chooseIntent,
  chooseServe,
  finalizeHit,
  type HitDecision,
  type IncomingInfo,
  type ShotIntent,
} from './ShotPlanner';

export interface BrainHost {
  readonly t: number;
  readonly ball: BallState;
  readonly tune: Tuning;
  readonly pace: number;
  /** 时机归一化窗口 H（毫秒） */
  readonly windowMs: number;
  readonly rallyHits: number;
  player(side: Side): PlayerSim;
  /** 现在轮到 side 击球吗（球已在其半台落台、还没第二跳） */
  canHit(side: Side): boolean;
  cpuHit(side: Side, decision: HitDecision, tau: number): void;
  /** 抛球，返回球到达最高点所需时间（秒） */
  cpuToss(side: Side, height: number): number;
  cpuServe(side: Side, spec: ServeSpec): void;
}

export class CpuBrain {
  readonly lv: CpuLevel;
  private plan: ContactPlan | null = null;
  private incoming = { popup: false, smash: false };
  private reactAt = Infinity;
  private swingAt = NaN;
  private intent: ShotIntent | null = null;
  private noise = { x: 0, y: 0 };
  private nextNoiseAt = 0;
  private serveTossAt = Infinity;
  private serveHitAt = NaN;

  constructor(
    readonly side: Side,
    level: number,
    private readonly rng: Rng
  ) {
    this.lv = cpuLevel(level);
  }

  get contactPlan(): ContactPlan | null {
    return this.plan;
  }

  /** 球正朝我飞来（对方击球后；或发球已在对方半台落台），规划接球。重复调用 = 重新规划（如擦网后） */
  onIncoming(host: BrainHost, popup: boolean, smash: boolean): void {
    const plan = planContact(host.ball, host.t, this.side, popup, host.tune);
    this.incoming = { popup, smash };
    const replanning = this.plan !== null;
    if (!plan.ok) {
      this.plan = null;
      return;
    }
    this.plan = plan;
    this.reactAt = replanning
      ? Math.min(this.reactAt, host.t + this.lv.reaction * 0.5)
      : host.t + this.lv.reaction;
    this.swingAt = plan.t + this.rng.normal(this.lv.timingMu, this.lv.timingSigma) / 1000;
    this.intent = null;
    this.nextNoiseAt = 0;
    const me = host.player(this.side);
    const rel = (plan.p.x - me.mover.x) * forehandSign(me);
    me.stance = rel > -0.15 ? 'fh' : 'bh';
    me.swing = {
      start: this.swingAt - 0.35,
      hit: this.swingAt,
      end: this.swingAt + 0.3,
      stroke: me.stance,
      height: TABLE.height + 0.15,
      kind: null,
      contact: { ...plan.p },
    };
  }

  cancel(): void {
    this.plan = null;
    this.serveTossAt = Infinity;
    this.serveHitAt = NaN;
  }

  /** 准备发球：在 at 时刻抛球 */
  prepareServe(at: number): void {
    this.plan = null;
    this.serveTossAt = at;
    this.serveHitAt = NaN;
  }

  tick(host: BrainHost): void {
    const t = host.t;
    const me = host.player(this.side);

    // ---- 发球
    if (t >= this.serveTossAt) {
      this.serveTossAt = Infinity;
      // 和玩家一样抛得高一些，在球落回到手上方约 25cm 时击球（不打强力发球）。
      // 按不计阻力的公式算：实际抛得低一点、落得慢一点，算到手上方 35cm 大致就是实际的 25cm
      const h = this.rng.uniform(0.55, 0.85);
      const tApex = host.cpuToss(this.side, h);
      const fall = Math.sqrt((2 * (h - 0.35)) / GRAVITY);
      this.serveHitAt = t + tApex + fall + this.rng.normal(0, 0.03);
    }
    if (t >= this.serveHitAt) {
      this.serveHitAt = NaN;
      host.cpuServe(this.side, chooseServe(this.side, this.lv, this.rng, host.pace));
    }

    // ---- 接球
    const plan = this.plan;
    if (!plan) {
      if (Number.isNaN(this.serveHitAt) && this.serveTossAt === Infinity) {
        const r = readyPosition(this.side, me.mover.x, host.tune);
        me.mover.setTarget(r.x, r.y);
      }
      return;
    }

    if (t >= this.reactAt) {
      if (t >= this.nextNoiseAt) {
        const remain = Math.max(0, plan.t - t);
        const sigma = this.lv.predSigma * clamp(remain / 0.5, 0, 1.5);
        this.noise = { x: this.rng.normal(0, sigma), y: this.rng.normal(0, sigma * 0.5) };
        this.nextNoiseAt = t + 0.1;
      }
      const body = bodyForContact(
        me,
        { x: plan.p.x + this.noise.x, y: plan.p.y + this.noise.y },
        me.stance,
        host.tune
      );
      me.mover.setTarget(body.x, body.y);
    }

    if (!this.intent && (t >= plan.bounceT || t >= plan.t - 0.45)) {
      const info = this.info(host, plan);
      this.intent = chooseIntent(info, this.lv, this.rng);
      if (me.swing) {
        // 引拍高度暗示旋转：高 = 下旋/侧旋，低 = 上旋（高水平电脑偶尔做假动作）
        let high = this.intent.topspin < 0 || this.intent.kind === 'curve';
        if (this.rng.chance(this.lv.feintP)) high = !high;
        me.swing.kind = this.intent.kind;
        me.swing.height = TABLE.height + (high ? 0.4 : -0.05);
      }
    }

    if (t >= this.swingAt) {
      const tau = ((this.swingAt - plan.t) * 1000) / host.windowMs;
      const timing = host.tune.timing;
      this.plan = null;
      if (this.swingAt < plan.bounceT || tau < timing.tauMin || tau > timing.tauMax) {
        if (me.swing) me.swing.whiff = true;
        host.cpuHit(
          this.side,
          { type: 'whiff', reason: this.swingAt < plan.bounceT ? 'early' : 'timing' },
          tau
        );
        return;
      }
      if (!host.canHit(this.side)) {
        // 预测与实际有出入（例如还没落台）：这一板放弃
        if (me.swing) me.swing.whiff = true;
        host.cpuHit(this.side, { type: 'whiff', reason: 'notReady' }, tau);
        return;
      }
      const info = this.info(host, plan);
      const intent = this.intent ?? chooseIntent(info, this.lv, this.rng);
      const ideal = bodyForContact(me, host.ball.p, me.stance, host.tune);
      // 前后方向可以靠伸手弥补，按一半计
      const reachError = Math.hypot(me.mover.x - ideal.x, 0.5 * (me.mover.y - ideal.y));
      const decision = finalizeHit(
        {
          info,
          intent,
          tau,
          reachError,
          pace: host.pace,
          ballHeight: host.ball.p.z - TABLE.height,
        },
        this.lv,
        this.rng,
        host.tune
      );
      if (me.swing) {
        me.swing.contact = { ...host.ball.p };
        me.swing.hit = t;
        me.swing.end = t + 0.3;
        if (decision.type === 'whiff') me.swing.whiff = true;
      }
      host.cpuHit(this.side, decision, tau);
    }
  }

  private info(host: BrainHost, plan: ContactPlan): IncomingInfo {
    const me = host.player(this.side);
    return {
      side: this.side,
      handed: me.handed,
      stance: me.stance,
      contact: plan,
      popup: this.incoming.popup,
      smash: this.incoming.smash,
      oppX: host.player(otherSide(this.side)).mover.x,
      rallyHits: host.rallyHits,
    };
  }
}
