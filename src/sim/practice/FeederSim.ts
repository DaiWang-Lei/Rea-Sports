/**
 * 发球机练习（纯逻辑，固定 240Hz 步长）：远端的发球机按难度送球到近端，玩家挥拍回球，
 * 统计每一球的结果（回进 / 出界 / 下网 / 没接到 / 挥早 / 挥晚 / 未落台击球）和时机偏差。
 */
import { createTuning, type Tuning } from '@/config/tuning';
import { clamp } from '@/core/math';
import { Rng } from '@/core/rng';
import { isFiniteVec, type Vec3, vec3 } from '@/core/vec3';
import { ballState, type BallEvent, type BallState, stepBall } from '../ball/physics';
import { SIM_DT, TABLE } from '../constants';
import { type ContactPlan, planContact } from '../hit/contactZone';
import {
  HitResolver,
  mapSwing,
  resolverConfig,
  type SwingFeatures,
  type SwingInput,
  type SwingOutcome,
} from '../hit/HitResolver';
import {
  bodyForContact,
  createPlayer,
  forehandSign,
  type PlayerSim,
  readyPosition,
  type Stroke,
} from '../players/PlayerSim';
import { buildShot, type ShotKind } from '../shot/ShotSpec';

export type FeedLevel = 1 | 2 | 3;
export type FeedZone = 'mixed' | 'fh' | 'bh';
export type FeedSpin = 'flat' | 'top' | 'back' | 'side' | 'high';

export interface FeederOptions {
  seed?: number;
  level?: FeedLevel;
  zone?: FeedZone;
  tune?: Tuning;
  /** 时机窗口 H（毫秒） */
  windowMs?: number;
  pace?: number;
  handed?: 1 | -1;
  /** 宽容度 0..1 */
  leniency?: number;
  /** 两球之间的间隔（秒） */
  interval?: number;
}

export type FeedResult = 'in' | 'out' | 'net' | 'own' | 'missed' | 'early' | 'late' | 'volley';

export const FEED_RESULT_TEXT: Record<FeedResult, string> = {
  in: '回进了',
  out: '出界',
  net: '下网',
  own: '落在本方',
  missed: '没接到',
  early: '挥早了',
  late: '挥晚了',
  volley: '未落台击球',
};

export interface ShotReport {
  result: FeedResult;
  /** 时机偏差（毫秒，负 = 早）；没挥拍时为 null */
  timingMs: number | null;
  stroke: Stroke | null;
  kind: ShotKind | null;
  /** 0..1 */
  power: number;
  /** −1..1：正 = 上旋 */
  spin: number;
  rushed: boolean;
  smash: boolean;
  /** 落点（世界坐标，回进时） */
  landing: Vec3 | null;
  feedSpin: FeedSpin;
}

export type FeederEvent =
  | { type: 'feed'; t: number; spin: FeedSpin; speed: number }
  | { type: 'bounce'; t: number; side: 'near' | 'far'; edge: boolean; impact: number; p: Vec3 }
  | { type: 'net'; t: number; part: 'cord' | 'body'; impact: number; p: Vec3 }
  | { type: 'floor'; t: number; impact: number; p: Vec3 }
  | { type: 'sideHit'; t: number; impact: number; p: Vec3 }
  | {
      type: 'hit';
      t: number;
      kind: ShotKind;
      speed: number;
      oops: boolean;
      smash: boolean;
      stroke: Stroke;
      timingMs: number;
      power: number;
      spin: number;
    }
  | { type: 'whiff'; t: number; reason: 'early' | 'late'; timingMs: number; stroke: Stroke }
  | { type: 'volley'; t: number; timingMs: number }
  | { type: 'result'; t: number; report: ShotReport };

export type FeederPhase =
  | { kind: 'wait'; until: number }
  | { kind: 'incoming'; since: number }
  | { kind: 'outgoing'; since: number }
  | { kind: 'paused' };

export interface FeederStats {
  feeds: number;
  results: Partial<Record<FeedResult, number>>;
  /** 每次挥中的时机偏差（毫秒） */
  timings: number[];
  /** 连续回进 */
  streak: number;
  bestStreak: number;
}

const MACHINE_Y = TABLE.halfLength + 0.45;
const MACHINE_Z = TABLE.height + 0.32;

export class FeederSim {
  readonly tune: Tuning;
  readonly rng: Rng;
  readonly player: PlayerSim;
  readonly resolver: HitResolver;
  readonly windowMs: number;
  readonly pace: number;
  level: FeedLevel;
  zone: FeedZone;
  leniency: number;
  interval: number;

  t = 0;
  ball: BallState = ballState();
  ballFree = false;
  phase: FeederPhase = { kind: 'wait', until: 1.2 };
  /** 发球机出球口位置（渲染用） */
  machine: Vec3 = vec3(0, MACHINE_Y, MACHINE_Z);
  plan: ContactPlan | null = null;
  events: FeederEvent[] = [];
  readonly stats: FeederStats = { feeds: 0, results: {}, timings: [], streak: 0, bestStreak: 0 };
  /** 最近一球的报告 */
  last: ShotReport | null = null;
  /** 本球的状态 */
  private feedSpin: FeedSpin = 'flat';
  private feedPopup = false;
  private hitInfo: Omit<ShotReport, 'result' | 'landing'> | null = null;
  private lastEventT = 0;
  private readonly ballEvents: BallEvent[] = [];
  private bouncedNear = false;
  private netTouched = false;
  private pendingWhiff: { reason: 'early' | 'late'; timingMs: number; stroke: Stroke } | null =
    null;
  /** 站位提示（来自球拍朝向）；null = 按来球位置 */
  stanceHint: Stroke | null = null;

  constructor(opts: FeederOptions = {}) {
    this.tune = opts.tune ?? createTuning();
    this.rng = new Rng(opts.seed ?? 7);
    this.level = opts.level ?? 1;
    this.zone = opts.zone ?? 'mixed';
    this.leniency = opts.leniency ?? 0.5;
    this.interval = opts.interval ?? 1.4;
    this.windowMs = opts.windowMs ?? this.tune.timing.window6Ms;
    this.pace = opts.pace ?? this.tune.shot.pace6;
    this.player = createPlayer(
      'near',
      opts.handed ?? 1,
      false,
      { vMax: 3.4, aMax: 16, gain: 6, yFactor: 0.6 },
      this.tune
    );
    this.resolver = new HitResolver(resolverConfig(this.tune, this.windowMs));
    this.parkBall();
  }

  get handed(): 1 | -1 {
    return this.player.handed;
  }

  // ---------------------------------------------------------------- 外部输入

  /** 玩家挥拍（时间已换算成仿真时间）。返回判定结果，供界面立即反馈 */
  swing(sw: SwingInput): SwingOutcome {
    const out = this.resolver.onSwing(sw);
    const me = this.player;
    const plan = this.plan;
    if (out.type === 'ignore' || !plan) return out;
    const timingMs = Math.round(out.tau * this.windowMs);
    if (out.type === 'hit') {
      me.swing = {
        start: this.t - 0.12,
        hit: out.execAt,
        end: out.execAt + 0.3,
        stroke: out.stroke,
        height: TABLE.height + 0.15,
        kind: null,
        contact: { ...plan.p },
      };
    } else {
      me.swing = {
        start: this.t - 0.12,
        hit: sw.tContact,
        end: sw.tContact + 0.3,
        stroke: out.stroke,
        height: TABLE.height + 0.15,
        kind: null,
        contact: { ...plan.p },
        whiff: true,
      };
      if (out.type === 'volley') {
        this.events.push({ type: 'volley', t: this.t, timingMs });
        this.finish({ result: 'volley', timingMs, stroke: out.stroke });
      } else {
        this.events.push({
          type: 'whiff',
          t: this.t,
          reason: out.reason,
          timingMs,
          stroke: out.stroke,
        });
        // 球继续飞，等它出界后再给结果
        this.pendingWhiff = { reason: out.reason, timingMs, stroke: out.stroke };
      }
    }
    return out;
  }

  /** 峰值细化 */
  refineSwing(id: number, wPeak: number, features: SwingFeatures | null): void {
    this.resolver.refine(id, wPeak, features);
  }

  pause(paused: boolean): void {
    if (paused) {
      this.phase = { kind: 'paused' };
      this.resolver.end();
      this.parkBall();
    } else if (this.phase.kind === 'paused') {
      this.phase = { kind: 'wait', until: this.t + 0.8 };
    }
  }

  // ---------------------------------------------------------------- 主循环

  tick(): void {
    const dt = SIM_DT;
    const ph = this.phase;
    if (ph.kind === 'wait' && this.t >= ph.until) this.feed();

    // 到期的击球
    const due = this.resolver.due(this.t);
    if (due && this.phase.kind === 'incoming') this.executeHit(due.swing, due.stroke, due.tau);

    this.updateMover();
    this.player.mover.update(dt, this.player.limits);

    if (this.ballFree) {
      this.ballEvents.length = 0;
      stepBall(this.ball, dt, this.t, this.tune.physics, this.rng, this.ballEvents);
      for (const e of this.ballEvents) this.onBallEvent(e);
      if (!isFiniteVec(this.ball.p) || !isFiniteVec(this.ball.v)) this.parkBall();
      const p = this.ball.p;
      const stale = this.t - this.lastEventT > 3;
      if (
        (this.phase.kind === 'incoming' || this.phase.kind === 'outgoing') &&
        (stale || Math.abs(p.y) > 6 || Math.abs(p.x) > 5 || p.z < -0.3)
      ) {
        this.onDead();
      }
    }
    this.t += dt;
  }

  private parkBall(): void {
    this.ball.p = { ...this.machine };
    this.ball.v = vec3();
    this.ball.w = vec3();
    this.ballFree = false;
  }

  private updateMover(): void {
    const me = this.player;
    const plan = this.plan;
    if (this.phase.kind === 'incoming' && plan && !this.resolver.attempted) {
      // 站位：球拍朝向提示优先，否则看来球在身体哪一侧；已经确认挥拍时朝挥拍那一侧跨步
      let stance: Stroke;
      if (this.stanceHint) stance = this.stanceHint;
      else {
        const rel = (plan.p.x - me.mover.x) * forehandSign(me);
        stance = rel > -0.15 ? 'fh' : 'bh';
      }
      if (!this.resolver.pending) {
        me.stance = stance;
        this.resolver.stance = stance;
      }
      const target = this.resolver.pending?.stroke ?? stance;
      const body = bodyForContact(me, plan.p, target, this.tune);
      me.mover.setTarget(body.x, body.y);
    } else if (this.phase.kind !== 'incoming') {
      const r = readyPosition('near', me.mover.x, this.tune);
      me.mover.setTarget(r.x, r.y);
    }
  }

  // ---------------------------------------------------------------- 送球

  private feed(): void {
    const rng = this.rng;
    const lv = this.level;
    this.machine = vec3(rng.uniform(-0.25, 0.25), MACHINE_Y, MACHINE_Z);
    // 落点：x 按区域（玩家视角的正手 / 反手半台），y 为近端半台
    const fhX = forehandSign(this.player);
    const spread = lv === 1 ? 0.45 : lv === 2 ? 0.58 : 0.66;
    let x: number;
    if (this.zone === 'fh') x = fhX * rng.uniform(0.15, spread);
    else if (this.zone === 'bh') x = -fhX * rng.uniform(0.15, spread);
    else x = rng.uniform(-spread, spread);
    const y = -rng.uniform(lv === 1 ? 0.75 : 0.6, lv === 1 ? 1.05 : 1.2);

    // 旋转与速度
    let spin: FeedSpin = 'flat';
    let topspin = rng.uniform(20, 60);
    let sidespin = 0;
    let speed = rng.uniform(3.8, 4.6);
    let apex: number | undefined;
    if (lv >= 2) {
      const r = rng.float();
      speed = rng.uniform(4.6, 6.0);
      if (r < 0.35) {
        spin = 'top';
        topspin = rng.uniform(120, 200);
      } else if (r < 0.65) {
        spin = 'back';
        topspin = -rng.uniform(80, 150);
        speed *= 0.9;
      }
    }
    if (lv >= 3) {
      speed = rng.uniform(5.5, 7.5);
      const r = rng.float();
      if (r < 0.2) {
        spin = 'side';
        sidespin = (rng.chance(0.5) ? 1 : -1) * rng.uniform(80, 140);
      } else if (r < 0.32) {
        spin = 'high';
        apex = rng.uniform(0.9, 1.25);
        topspin = rng.uniform(-20, 40);
        speed = 4;
      }
    }
    const built = buildShot(
      { ...this.machine },
      {
        kind: apex !== undefined ? 'popup' : 'normal',
        target: { x, y },
        speedH: speed * this.pace,
        topspin,
        sidespin,
        clearance: 0.06,
        apex,
      },
      this.tune
    );
    this.ball.p = { ...this.machine };
    this.ball.v = built.v0;
    this.ball.w = built.w0;
    this.ballFree = true;
    this.feedSpin = spin;
    this.feedPopup = apex !== undefined;
    this.hitInfo = null;
    this.pendingWhiff = null;
    this.bouncedNear = false;
    this.lastEventT = this.t;
    this.player.swing = null;
    this.stats.feeds++;
    this.events.push({ type: 'feed', t: this.t, spin, speed });
    this.replan();
    this.phase = { kind: 'incoming', since: this.t };
  }

  private replan(): void {
    const plan = planContact(this.ball, this.t, 'near', this.feedPopup, this.tune);
    this.plan = plan.ok ? plan : null;
    if (!this.plan) {
      this.resolver.end();
      return;
    }
    const ab = { plan: this.plan, popup: this.feedPopup, smash: false };
    if (this.resolver.ball) this.resolver.update(ab);
    else this.resolver.begin(ab);
  }

  // ---------------------------------------------------------------- 击球

  private executeHit(sw: SwingInput, stroke: Stroke, tau: number): void {
    const me = this.player;
    const ideal = bodyForContact(me, this.ball.p, stroke, this.tune);
    // 换边（站位与挥拍方向不一致）时允许一次横向「跨步」
    const switched = stroke !== me.stance;
    const dx = Math.abs(me.mover.x - ideal.x) - (switched ? 0.44 : 0);
    const reachError = Math.hypot(Math.max(0, dx), 0.5 * (me.mover.y - ideal.y));
    const timingMs = Math.round(tau * this.windowMs);
    if (reachError > this.tune.mover.reachRushed) {
      // 够不着：挥空
      const reason = tau < 0 ? 'early' : 'late';
      this.pendingWhiff = { reason, timingMs, stroke };
      this.events.push({ type: 'whiff', t: this.t, reason, timingMs, stroke });
      if (me.swing) me.swing.whiff = true;
      return;
    }
    const mapped = mapSwing(
      {
        side: 'near',
        handed: me.handed,
        stroke,
        tau,
        wPeak: sw.wPeak,
        features: sw.features,
        contact: { ...this.ball.p },
        vIn: { ...this.ball.v },
        wIn: { ...this.ball.w },
        popupIn: this.feedPopup,
        smashIn: false,
        reachError,
        pace: this.pace,
        leniency: this.leniency,
      },
      this.rng,
      this.tune
    );
    const built = buildShot({ ...this.ball.p }, mapped.spec, this.tune);
    this.ball.v = built.v0;
    this.ball.w = built.w0;
    this.lastEventT = this.t;
    const speed = Math.hypot(built.v0.x, built.v0.y);
    if (me.swing) {
      me.swing.hit = this.t;
      me.swing.contact = { ...this.ball.p };
      me.swing.kind = mapped.spec.kind;
    }
    this.hitInfo = {
      timingMs,
      stroke,
      kind: mapped.spec.kind,
      power: mapped.power,
      spin: mapped.spin,
      rushed: mapped.rushed,
      smash: !!mapped.spec.smash,
      feedSpin: this.feedSpin,
    };
    this.stats.timings.push(timingMs);
    this.events.push({
      type: 'hit',
      t: this.t,
      kind: mapped.spec.kind,
      speed,
      oops: mapped.rushed,
      smash: !!mapped.spec.smash,
      stroke,
      timingMs,
      power: mapped.power,
      spin: mapped.spin,
    });
    this.phase = { kind: 'outgoing', since: this.t };
    this.plan = null;
    this.resolver.end();
  }

  // ---------------------------------------------------------------- 球的事件 → 结果

  private onBallEvent(e: BallEvent): void {
    this.lastEventT = e.t;
    switch (e.type) {
      case 'table':
        this.events.push({
          type: 'bounce',
          t: e.t,
          side: e.side!,
          edge: !!e.edge,
          impact: e.impact,
          p: e.p,
        });
        break;
      case 'net':
        this.events.push({ type: 'net', t: e.t, part: e.part!, impact: e.impact, p: e.p });
        break;
      case 'floor':
        this.events.push({ type: 'floor', t: e.t, impact: e.impact, p: e.p });
        break;
      case 'side':
        this.events.push({ type: 'sideHit', t: e.t, impact: e.impact, p: e.p });
        break;
    }
    const ph = this.phase.kind;
    if (ph === 'incoming') {
      if (e.type === 'table' && e.side === 'near') {
        if (this.bouncedNear) {
          // 第二跳：没接到
          this.onDead();
          return;
        }
        this.bouncedNear = true;
      } else if (e.type === 'floor') {
        this.onDead();
        return;
      }
      if (e.type === 'net' || (e.type === 'table' && e.edge)) this.replan();
    } else if (ph === 'outgoing') {
      if (e.type === 'table') {
        this.finish(e.side === 'far' ? { result: 'in', landing: { ...e.p } } : { result: 'own' });
      } else if (e.type === 'floor' || e.type === 'side') {
        // 先撞网身再落地 = 下网；否则出界
        this.finish({ result: this.netTouched ? 'net' : 'out' });
      } else if (e.type === 'net') {
        if (e.part === 'body') this.netTouched = true;
      }
    }
  }

  /** 球死了（落地、飞远、第二跳、长时间没事件） */
  private onDead(): void {
    if (this.phase.kind === 'incoming') {
      const w = this.pendingWhiff;
      this.finish(
        w ? { result: w.reason, timingMs: w.timingMs, stroke: w.stroke } : { result: 'missed' }
      );
    } else if (this.phase.kind === 'outgoing') {
      this.finish({ result: this.netTouched ? 'net' : 'out' });
    }
  }

  private finish(r: Partial<ShotReport> & { result: FeedResult }): void {
    const info = this.hitInfo;
    const report: ShotReport = {
      result: r.result,
      timingMs: r.timingMs ?? info?.timingMs ?? null,
      stroke: r.stroke ?? info?.stroke ?? null,
      kind: info?.kind ?? null,
      power: info?.power ?? 0,
      spin: info?.spin ?? 0,
      rushed: info?.rushed ?? false,
      smash: info?.smash ?? false,
      landing: r.landing ?? null,
      feedSpin: this.feedSpin,
    };
    this.last = report;
    const st = this.stats;
    st.results[report.result] = (st.results[report.result] ?? 0) + 1;
    if (report.result === 'in') {
      st.streak++;
      st.bestStreak = Math.max(st.bestStreak, st.streak);
    } else {
      st.streak = 0;
    }
    this.events.push({ type: 'result', t: this.t, report });
    this.resolver.end();
    this.plan = null;
    this.netTouched = false;
    this.pendingWhiff = null;
    this.phase = { kind: 'wait', until: this.t + this.interval };
    // 让球自然落下（不立刻收回），下一球出球时再重置
  }

  drainEvents(): FeederEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** 时机偏差的中位数（毫秒），用于「按我的平均时机校准延迟」 */
  medianTiming(lastN = 12): number | null {
    const v = this.stats.timings.slice(-lastN);
    if (v.length < 5) return null;
    const s = [...v].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  /** 已经回进的比例 */
  get inRate(): number {
    const n = Object.values(this.stats.results).reduce((a, b) => a + (b ?? 0), 0);
    return n ? (this.stats.results.in ?? 0) / n : 0;
  }

  /** 供 UI 用：本球是否还能挥拍 */
  get awaitingSwing(): boolean {
    return this.phase.kind === 'incoming' && !this.resolver.attempted;
  }

  clampLeniency(v: number): void {
    this.leniency = clamp(v, 0, 1);
  }
}
