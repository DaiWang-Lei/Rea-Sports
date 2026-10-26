/**
 * 比赛里由人操作的一方：和电脑（CpuBrain）挂在同样的钩子上（来球、取消、准备发球、每步推进），
 * 击球判定与映射沿用发球机练习（FeederSim）的那一套：
 *  - 接球：理想击球点只取弹起后的下降段；正反手站位在来球时按落点相对身体定一次；自动走位；
 *    HitResolver 判定时机（挥早先挂起，可被更快的反向挥拍取代），mapSwing 换算成落点、速度、旋转；
 *  - 和练习不同：未落台击球直接丢分；挥空 / 够不着时球照常飞，由裁判判「没接到」「两跳」；
 *  - 发球：抛球（按键或向上抖手柄）后挥拍。理想时刻 T_s = 最高点 + 0.12 秒，τ = Δt / 110ms 定左右（早打斜线），
 *    挥拍速度定长短快慢，拍面定旋转；落点限制在台内，保证先落本方台再过网。没打到的话球落下后重抛，不罚分。
 */
import type { Tuning } from '@/config/tuning';
import { clamp, lerp } from '@/core/math';
import type { Rng } from '@/core/rng';
import { vec3 } from '@/core/vec3';
import type { BallState } from '../ball/physics';
import { GRAVITY, type Side, sideDir, TABLE } from '../constants';
import { type ContactPlan, planContact } from '../hit/contactZone';
import {
  HitResolver,
  mapSwing,
  type MissOutcome,
  type PendingHit,
  resolverConfig,
  sideSpinAmount,
  spinSigma,
  type SwingFeatures,
  type SwingInput,
  type SwingOutcome,
  swingPower,
} from '../hit/HitResolver';
import type { MatchPhase } from '../MatchSim';
import type { ServeSpec, ShotSpec } from '../shot/ShotSpec';
import {
  bodyForContact,
  forehandSign,
  type PlayerSim,
  readyPosition,
  rightSign,
  type Stroke,
} from './PlayerSim';

/** 发球的时机窗口（毫秒）：τ = Δt / 110ms */
export const SERVE_WINDOW_MS = 110;
/** 理想发球时刻：抛球最高点之后这么久（秒） */
export const SERVE_AFTER_APEX = 0.12;
/** 按键抛球的高度（米，手以上）；向上抖手柄的高度按力度定（见 TossDetector） */
export const BUTTON_TOSS_HEIGHT = 0.3;

export type HumanMissReason = 'early' | 'late' | 'reach';

/** 玩家（人）这一拍的情况：画面上的时机提示、结算统计用 */
export interface HumanShot {
  /** 时机偏差（毫秒，负 = 早） */
  timingMs: number;
  stroke: Stroke;
  /** 0..1 */
  power: number;
  /** −1..1：正 = 上旋 */
  spin: number;
  serve: boolean;
}

export interface HumanHost {
  readonly t: number;
  readonly ball: BallState;
  readonly tune: Tuning;
  readonly pace: number;
  /** 回合中的时机窗口 H（毫秒） */
  readonly windowMs: number;
  readonly phase: MatchPhase;
  player(side: Side): PlayerSim;
  canHit(side: Side): boolean;
  /** 抛球，返回到最高点所需时间（秒）；不在可以抛球的状态返回 0 */
  toss(side: Side, height: number): number;
  serve(side: Side, spec: ServeSpec, shot?: HumanShot): void;
  hit(side: Side, spec: ShotSpec, shot?: HumanShot): void;
  /** 玩家挥空（挥早 / 挥晚 / 够不着）：球照常飞 */
  humanWhiff(
    side: Side,
    reason: HumanMissReason,
    timingMs: number,
    stroke: Stroke,
    serve: boolean
  ): void;
  /** 玩家犯规（未落台击球）：这一分直接判给对方 */
  foul(side: Side, reason: 'volley', timingMs: number, stroke: Stroke): void;
}

export interface HumanOptions {
  /** 宽容度 0..1：越大噪声越小、拍面角度的死区越宽 */
  leniency?: number;
}

export class HumanPlayer {
  readonly resolver: HitResolver;
  /** 发球的判定：窗口 110ms，没有「未落台」 */
  readonly serveResolver: HitResolver;
  leniency: number;
  /** 当前来球的理想击球点 */
  plan: ContactPlan | null = null;
  /** 这次抛球：理想发球时刻、球到最高点的时刻 */
  serveAt: { ideal: number; apex: number } | null = null;
  private incoming = { popup: false, smash: false };
  /** 本球的站位：来球时按落点相对「当时身体位置」定一次（同 FeederSim） */
  private ballStance: Stroke | null = null;
  private stanceRefX = 0;
  /** 最早可以抛球的时刻；NaN = 现在不是我发球 */
  private tossFrom = NaN;

  constructor(
    readonly side: Side,
    private readonly rng: Rng,
    tune: Tuning,
    windowMs: number,
    opts: HumanOptions = {}
  ) {
    this.leniency = clamp(opts.leniency ?? 0.5, 0, 1);
    this.resolver = new HitResolver(resolverConfig(tune, windowMs));
    this.serveResolver = new HitResolver({
      ...resolverConfig(tune, SERVE_WINDOW_MS),
      tauMin: -2,
      tauMax: 2,
    });
  }

  // ---------------------------------------------------------------- 比赛的钩子（同 CpuBrain）

  cancel(): void {
    this.plan = null;
    this.ballStance = null;
    this.resolver.end();
    this.serveResolver.end();
    this.serveAt = null;
    this.tossFrom = NaN;
  }

  /** 轮到我发球：at 之后可以抛球 */
  prepareServe(at: number): void {
    this.serveResolver.end();
    this.serveAt = null;
    this.tossFrom = at;
  }

  /** 球正朝我飞来（对方击球后；或发球已在对方半台落台）。重复调用 = 轨迹变了（擦网等），重新规划 */
  onIncoming(host: HumanHost, popup: boolean, smash: boolean): void {
    const plan = planContact(host.ball, host.t, this.side, popup, host.tune);
    this.incoming = { popup, smash };
    if (!plan.ok) {
      // 这球不会落到我这边（出界 / 下网）：不用接
      this.plan = null;
      this.resolver.end();
      return;
    }
    const me = host.player(this.side);
    const first = !this.resolver.ball;
    if (first) this.stanceRefX = me.mover.x;
    this.plan = plan;
    const rel = (plan.p.x - this.stanceRefX) * forehandSign(me);
    this.ballStance = rel > -0.15 ? 'fh' : 'bh';
    const ab = { plan, popup, smash };
    if (first) this.resolver.begin(ab);
    else this.resolver.update(ab);
  }

  tick(host: HumanHost): void {
    const t = host.t;
    const ph = host.phase;
    if (ph.kind === 'toss' && ph.server === this.side) {
      const due = this.serveResolver.due(t);
      if (due) this.executeServe(host, due);
      const miss = this.serveResolver.dueHeld(t);
      if (miss) this.applyMiss(host, miss, true);
    }
    const due = this.resolver.due(t);
    if (due) this.executeHit(host, due);
    const miss = this.resolver.dueHeld(t);
    if (miss) this.applyMiss(host, miss, false);
    this.updateMover(host);
  }

  // ---------------------------------------------------------------- 玩家的输入

  /** 现在能不能抛球（轮到我发球、球在手里） */
  canToss(host: HumanHost): boolean {
    const ph = host.phase;
    return ph.kind === 'preServe' && ph.server === this.side && host.t >= this.tossFrom;
  }

  /** 抛球（按键或向上抖手柄），height = 手以上的高度（米） */
  toss(host: HumanHost, height: number): boolean {
    if (!this.canToss(host)) return false;
    const now = host.t;
    const tApex = host.toss(this.side, height);
    if (!(tApex > 0)) return false;
    this.tossFrom = NaN;
    const ideal = now + tApex + SERVE_AFTER_APEX;
    this.serveAt = { ideal, apex: now + tApex };
    const b = host.ball;
    const dt = ideal - now;
    const plan: ContactPlan = {
      ok: true,
      receiver: this.side,
      // 发球没有「未落台」
      bounceT: -Infinity,
      bounceP: null,
      t: ideal,
      p: vec3(b.p.x, b.p.y, b.p.z + b.v.z * dt - 0.5 * GRAVITY * dt * dt),
      v: vec3(0, 0, b.v.z - GRAVITY * dt),
      w: vec3(),
      popup: false,
      prediction: { states: [], events: [], t0: now },
    };
    this.serveResolver.begin({ plan, popup: false, smash: false });
    return true;
  }

  /** 玩家挥拍（时间已换算成仿真时间） */
  swing(host: HumanHost, sw: SwingInput): SwingOutcome {
    const ph = host.phase;
    const serving = ph.kind === 'toss' && ph.server === this.side;
    const out = (serving ? this.serveResolver : this.resolver).onSwing(sw);
    if (out.type === 'ignore') return out;
    const me = host.player(this.side);
    const contact = !serving && this.plan ? { ...this.plan.p } : { ...host.ball.p };
    const anim = { start: host.t - 0.12, height: TABLE.height + 0.15, kind: null, contact };
    if (out.type === 'hit') {
      me.swing = { ...anim, hit: out.execAt, end: out.execAt + 0.3, stroke: out.stroke };
    } else {
      // 挥空 / 未落台（包括先挂起的）：马上做挥空动作；挂起的到期后才算数（见 tick）
      const miss = out.type === 'held' ? out.miss : out;
      me.swing = {
        ...anim,
        hit: sw.tContact,
        end: sw.tContact + 0.3,
        stroke: miss.stroke,
        whiff: true,
      };
      if (out.type !== 'held') this.applyMiss(host, out, serving);
    }
    return out;
  }

  /** 峰值细化 */
  refine(id: number, wPeak: number, features: SwingFeatures | null): void {
    this.resolver.refine(id, wPeak, features);
    this.serveResolver.refine(id, wPeak, features);
  }

  /** 这个来球还能不能挥（调试 / 冒烟测试用） */
  get awaitingSwing(): boolean {
    return !!this.resolver.ball && !this.resolver.attempted;
  }

  /**
   * 这一分要结束了：还挂着的挥早 / 未落台立刻算数。挥早照常给出挥空事件；
   * 未落台击球原样返回，由调用方把这一分的失分原因改成「未落台击球」
   */
  flushHeld(host: HumanHost): MissOutcome | null {
    const miss = this.resolver.dueHeld(host.t, true);
    if (miss?.type === 'whiff') this.applyMiss(host, miss, false);
    return miss;
  }

  // ---------------------------------------------------------------- 内部

  private applyMiss(host: HumanHost, miss: MissOutcome, serve: boolean): void {
    const timingMs = Math.round(miss.tau * (serve ? SERVE_WINDOW_MS : host.windowMs));
    if (miss.type === 'volley') host.foul(this.side, 'volley', timingMs, miss.stroke);
    else host.humanWhiff(this.side, miss.reason, timingMs, miss.stroke, serve);
  }

  private executeHit(host: HumanHost, due: PendingHit): void {
    const me = host.player(this.side);
    const stroke = due.stroke;
    const timingMs = Math.round(due.tau * host.windowMs);
    if (!host.canHit(this.side)) {
      // 球的轨迹和预测不一样（还没落到本方台面）：这一下算挥早
      if (me.swing) me.swing.whiff = true;
      host.humanWhiff(this.side, 'early', timingMs, stroke, false);
      return;
    }
    const ideal = bodyForContact(me, host.ball.p, stroke, host.tune);
    // 换边（站位与挥拍方向不一致）时允许一次横向「跨步」
    const switched = stroke !== me.stance;
    const dx = Math.abs(me.mover.x - ideal.x) - (switched ? 0.44 : 0);
    const reachError = Math.hypot(Math.max(0, dx), 0.5 * (me.mover.y - ideal.y));
    if (reachError > host.tune.mover.reachRushed) {
      if (me.swing) me.swing.whiff = true;
      host.humanWhiff(this.side, 'reach', timingMs, stroke, false);
      return;
    }
    const mapped = mapSwing(
      {
        side: this.side,
        handed: me.handed,
        stroke,
        tau: due.tau,
        wPeak: due.swing.wPeak,
        features: due.swing.features,
        contact: { ...host.ball.p },
        vIn: { ...host.ball.v },
        wIn: { ...host.ball.w },
        popupIn: this.incoming.popup,
        smashIn: this.incoming.smash,
        reachError,
        pace: host.pace,
        leniency: this.leniency,
      },
      this.rng,
      host.tune
    );
    if (me.swing) {
      me.swing.hit = host.t;
      me.swing.contact = { ...host.ball.p };
      me.swing.kind = mapped.spec.kind;
    }
    this.plan = null;
    this.resolver.end();
    host.hit(this.side, mapped.spec, {
      timingMs,
      stroke,
      power: mapped.power,
      spin: mapped.spin,
      serve: false,
    });
  }

  private executeServe(host: HumanHost, due: PendingHit): void {
    const me = host.player(this.side);
    const at = this.serveAt;
    this.serveResolver.end();
    this.serveAt = null;
    const dir = sideDir(this.side);
    const rs = rightSign(this.side);
    const sw = due.swing;
    const q = swingPower(sw.wPeak);
    // 以发球者自己的左右为准：s = +1 正手，−1 反手；早打斜线
    const s = (due.stroke === 'fh' ? 1 : -1) * me.handed;
    const u = clamp(s * 0.8 * due.tau, -1, 1);
    const xMax = TABLE.halfWidth - 0.1;
    const nearApex = at ? clamp(1 - Math.abs(host.t - at.apex) / 0.18, 0, 1) : 0;
    const sigma = spinSigma(sw.features, this.leniency);
    const spec: ServeSpec = {
      firstY: -dir * (0.45 + 0.65 * q),
      second: { x: clamp(u * TABLE.halfWidth, -xMax, xMax) * rs, y: dir * (0.55 + 0.6 * q) },
      speedH: lerp(4.5, 8.5, q) * host.pace * (1 + 0.12 * nearApex),
      topspin: sigma === 0 ? 20 : 160 * sigma,
      sidespin: 120 * sideSpinAmount(sw.features, s),
    };
    if (me.swing) {
      me.swing.hit = host.t;
      me.swing.contact = { ...host.ball.p };
      me.swing.kind = 'serve';
    }
    host.serve(this.side, spec, {
      timingMs: Math.round(due.tau * SERVE_WINDOW_MS),
      stroke: due.stroke,
      power: q,
      spin: sigma,
      serve: true,
    });
  }

  private updateMover(host: HumanHost): void {
    const me = host.player(this.side);
    const ph = host.phase;
    // 发球时站在发球位（开局时由 MatchSim 定好）
    if ((ph.kind === 'preServe' || ph.kind === 'toss') && ph.server === this.side) return;
    const plan = this.plan;
    if (plan && this.resolver.ball) {
      // 已经出过手（挥空 / 够不着）：原地不动
      if (this.resolver.attempted) return;
      const stance = this.ballStance ?? 'fh';
      if (!this.resolver.pending) {
        me.stance = stance;
        this.resolver.stance = stance;
      }
      const target = this.resolver.pending?.stroke ?? stance;
      const body = bodyForContact(me, plan.p, target, host.tune);
      me.mover.setTarget(body.x, body.y);
      return;
    }
    const r = readyPosition(this.side, me.mover.x, host.tune);
    me.mover.setTarget(r.x, r.y);
  }
}
