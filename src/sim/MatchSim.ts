/**
 * 一局比赛的完整仿真（纯逻辑，固定 240Hz 步长，可无界面运行）：
 * 发球流程、球的物理、裁判、记分、电脑 AI、走位，以及给渲染/音效/震动用的事件队列。
 */
import { cpuLevel } from '@/config/difficulty';
import { createTuning, type Tuning } from '@/config/tuning';
import { Rng } from '@/core/rng';
import { isFiniteVec, type Vec3, vec3 } from '@/core/vec3';
import { CpuBrain, type BrainHost } from './ai/CpuBrain';
import type { HitDecision, WhiffReason } from './ai/ShotPlanner';
import { ballState, type BallEvent, type BallState, stepBall } from './ball/physics';
import { GRAVITY, otherSide, type Side, SIM_DT } from './constants';
import {
  createPlayer,
  type PlayerSim,
  readyPosition,
  serveHandPosition,
} from './players/PlayerSim';
import type { MoverLimits } from './players/Mover';
import { type PointReason, Referee, type RefereeInput, type RefereeOutput } from './rally/Referee';
import { type GameResult, Scoring } from './rally/Scoring';
import {
  buildServe,
  buildShot,
  type ServeSpec,
  type ShotKind,
  type ShotSpec,
} from './shot/ShotSpec';

export interface MatchOptions {
  points?: 6 | 11;
  drawAt?: number | null;
  firstServer?: Side;
  seed?: number;
  /** 由电脑控制的一方及其等级（1..5） */
  cpu?: Partial<Record<Side, number>>;
  handed?: Partial<Record<Side, 1 | -1>>;
  tune?: Tuning;
  /** 人类玩家的走位参数 */
  humanLimits?: MoverLimits;
}

export type MatchEvent =
  | {
      type: 'hit';
      t: number;
      side: Side;
      kind: ShotKind;
      speed: number;
      oops: boolean;
      smash: boolean;
      serve: boolean;
      rallyHits: number;
    }
  | { type: 'whiff'; t: number; side: Side }
  | { type: 'bounce'; t: number; side: Side; edge: boolean; impact: number; p: Vec3 }
  | { type: 'net'; t: number; part: 'cord' | 'body'; impact: number; p: Vec3 }
  | { type: 'floor'; t: number; impact: number; p: Vec3 }
  | { type: 'sideHit'; t: number; impact: number; p: Vec3 }
  | { type: 'toss'; t: number; side: Side }
  | {
      type: 'point';
      t: number;
      winner: Side;
      reason: PointReason;
      score: Record<Side, number>;
      rallyHits: number;
    }
  | { type: 'let'; t: number }
  | { type: 'gameOver'; t: number; result: Exclude<GameResult, null>; score: Record<Side, number> };

export type MatchPhase =
  | { kind: 'preServe'; server: Side; since: number }
  | { kind: 'toss'; server: Side; since: number; handZ: number }
  | { kind: 'play'; since: number }
  | { kind: 'pointOver'; winner: Side; reason: PointReason; since: number }
  | { kind: 'let'; since: number }
  | { kind: 'gameOver'; result: Exclude<GameResult, null>; since: number };

/** 正在飞的这一球的信息 */
export interface InFlight {
  hitter: Side;
  kind: ShotKind;
  popup: boolean;
  smash: boolean;
  serve: boolean;
  /** 出手时刻 */
  t: number;
}

export interface MatchStats {
  hits: number;
  solverFailures: number;
  whiffs: number;
  /** 两次击球之间的间隔（秒） */
  hitIntervals: number[];
  pointDurations: number[];
  rallyLengths: number[];
  reasons: Partial<Record<PointReason, number>>;
  whiffReasons: Partial<Record<WhiffReason, number>>;
}

const DEFAULT_HUMAN_LIMITS: MoverLimits = { vMax: 3.4, aMax: 16, gain: 6, yFactor: 0.6 };
const LET_PAUSE = 1.2;

export class MatchSim implements BrainHost {
  readonly tune: Tuning;
  readonly rng: Rng;
  readonly scoring: Scoring;
  readonly referee = new Referee();
  readonly players: Record<Side, PlayerSim>;
  readonly brains: Partial<Record<Side, CpuBrain>> = {};
  readonly pace: number;
  readonly windowMs: number;
  readonly points: 6 | 11;

  t = 0;
  ball: BallState = ballState();
  /** 球是否在自由飞行（否则跟着发球手） */
  ballFree = false;
  phase: MatchPhase;
  inFlight: InFlight | null = null;
  rallyHits = 0;
  /** 渲染/音效/震动消费的事件队列 */
  events: MatchEvent[] = [];
  readonly stats: MatchStats = {
    hits: 0,
    solverFailures: 0,
    whiffs: 0,
    hitIntervals: [],
    pointDurations: [],
    rallyLengths: [],
    reasons: {},
    whiffReasons: {},
  };

  private lastBallEventT = 0;
  private lastHitT = NaN;
  private pointStartT = 0;
  private readonly ballEvents: BallEvent[] = [];

  constructor(opts: MatchOptions = {}) {
    this.tune = opts.tune ?? createTuning();
    this.rng = new Rng(opts.seed ?? 1);
    this.points = opts.points ?? 6;
    this.pace = this.points === 11 ? this.tune.shot.pace11 : this.tune.shot.pace6;
    this.windowMs = this.points === 11 ? this.tune.timing.window11Ms : this.tune.timing.window6Ms;
    this.scoring = new Scoring({
      target: this.points,
      drawAt: opts.drawAt === undefined ? 20 : opts.drawAt,
      firstServer: opts.firstServer ?? 'near',
    });
    const mk = (side: Side): PlayerSim => {
      const level = opts.cpu?.[side];
      const isCpu = level !== undefined;
      const limits = isCpu
        ? {
            vMax: cpuLevel(level).vMax,
            aMax: cpuLevel(level).aMax,
            gain: this.tune.mover.gain,
            yFactor: this.tune.mover.yFactor,
          }
        : (opts.humanLimits ?? DEFAULT_HUMAN_LIMITS);
      if (isCpu) this.brains[side] = new CpuBrain(side, level, this.rng);
      return createPlayer(side, opts.handed?.[side] ?? 1, isCpu, limits, this.tune);
    };
    this.players = { near: mk('near'), far: mk('far') };
    this.phase = { kind: 'preServe', server: this.scoring.server(), since: 0 };
    this.startPoint();
  }

  player(side: Side): PlayerSim {
    return this.players[side];
  }

  get server(): Side {
    return this.scoring.server();
  }

  get result(): GameResult {
    return this.scoring.result;
  }

  /** 推进一个仿真步（1/240 秒） */
  tick(): void {
    const dt = SIM_DT;
    this.updatePhase();

    for (const side of ['near', 'far'] as const) this.brains[side]?.tick(this);
    for (const side of ['near', 'far'] as const) {
      const p = this.players[side];
      p.mover.update(dt, p.limits);
    }

    if (this.ballFree) {
      this.ballEvents.length = 0;
      stepBall(this.ball, dt, this.t, this.tune.physics, this.rng, this.ballEvents);
      for (const e of this.ballEvents) this.onBallEvent(e);
      if (!isFiniteVec(this.ball.p) || !isFiniteVec(this.ball.v)) {
        throw new Error(`球的状态出现非法数值 t=${this.t.toFixed(3)}`);
      }
      // 落地后基本静止就不再模拟
      if (
        this.ball.p.z <= 0.021 &&
        Math.hypot(this.ball.v.x, this.ball.v.y, this.ball.v.z) < 0.05
      ) {
        this.ballFree = false;
      }
    } else if (this.phase.kind === 'preServe') {
      this.holdBall(this.phase.server);
    }

    this.t += dt;
  }

  // ---------------------------------------------------------------- 阶段流转

  private startPoint(): void {
    const server = this.scoring.server();
    this.phase = { kind: 'preServe', server, since: this.t };
    this.referee.reset(server);
    this.inFlight = null;
    this.rallyHits = 0;
    this.pointStartT = this.t;
    this.lastHitT = NaN;
    for (const side of ['near', 'far'] as const) {
      const p = this.players[side];
      p.swing = null;
      const r = readyPosition(side, 0, this.tune);
      // 发球方站在偏正手位一点
      const x = side === server ? this.rng.uniform(-0.35, 0.35) : r.x;
      p.mover.setTarget(x, r.y);
      this.brains[side]?.cancel();
    }
    this.holdBall(server);
    this.brains[server]?.prepareServe(this.t + this.tune.rules.serveDelay);
  }

  private updatePhase(): void {
    const ph = this.phase;
    const rules = this.tune.rules;
    switch (ph.kind) {
      case 'toss': {
        const tooLow = this.ball.p.z < ph.handZ - rules.tossDropBelow && this.ball.v.z < 0;
        if (tooLow || this.t - ph.since > rules.tossTimeout) {
          // 没打到：重新抛球，不罚分
          this.ballFree = false;
          this.phase = { kind: 'preServe', server: ph.server, since: this.t };
          this.holdBall(ph.server);
          this.brains[ph.server]?.prepareServe(this.t + rules.serveDelay * 0.6);
        }
        break;
      }
      case 'play': {
        const p = this.ball.p;
        const stale = this.t - this.lastBallEventT > rules.deadBallSeconds;
        if (
          (stale || Math.abs(p.y) > 8 || Math.abs(p.x) > 6 || p.z < -0.5) &&
          this.referee.state !== 'idle'
        ) {
          this.handleReferee(this.referee.feed({ type: 'dead' }));
        }
        break;
      }
      case 'pointOver':
        if (this.t - ph.since >= rules.betweenPoints) {
          const result = this.scoring.result;
          if (result) {
            this.phase = { kind: 'gameOver', result, since: this.t };
            this.events.push({
              type: 'gameOver',
              t: this.t,
              result,
              score: { ...this.scoring.score },
            });
          } else {
            this.startPoint();
          }
        }
        break;
      case 'let':
        if (this.t - ph.since >= LET_PAUSE) this.startPoint();
        break;
      default:
        break;
    }
  }

  /** 两分之间：允许提前跳过停顿（玩家按键） */
  skipBetweenPoints(): void {
    const ph = this.phase;
    if (ph.kind === 'pointOver' && this.t - ph.since >= this.tune.rules.betweenPointsSkippable) {
      ph.since = this.t - this.tune.rules.betweenPoints;
    }
  }

  private holdBall(server: Side): void {
    const h = serveHandPosition(this.players[server]);
    this.ball.p = { ...h };
    this.ball.v = vec3();
    this.ball.w = vec3();
    this.ballFree = false;
  }

  // ---------------------------------------------------------------- 发球与击球

  /** 抛球（电脑或玩家）。返回到最高点所需时间 */
  toss(side: Side, height: number): number {
    if (this.phase.kind !== 'preServe' || this.phase.server !== side) return 0;
    const hand = serveHandPosition(this.players[side]);
    const vz = Math.sqrt(2 * GRAVITY * Math.max(0.05, height));
    this.ball.p = { ...hand };
    this.ball.v = vec3(0, 0, vz);
    this.ball.w = vec3();
    this.ballFree = true;
    this.phase = { kind: 'toss', server: side, since: this.t, handZ: hand.z };
    this.players[side].tossAt = this.t;
    this.lastBallEventT = this.t;
    this.events.push({ type: 'toss', t: this.t, side });
    return vz / GRAVITY;
  }

  cpuToss(side: Side, height: number): number {
    return this.toss(side, height);
  }

  /** 发球击球（电脑或玩家） */
  serve(side: Side, spec: ServeSpec): void {
    if (this.phase.kind !== 'toss' || this.phase.server !== side) return;
    const built = buildServe({ ...this.ball.p }, spec, this.tune);
    if (!built.ok) this.stats.solverFailures++;
    this.ball.v = built.v0;
    this.ball.w = built.w0;
    this.phase = { kind: 'play', since: this.t };
    this.rallyHits = 1;
    this.inFlight = {
      hitter: side,
      kind: 'serve',
      popup: false,
      smash: false,
      serve: true,
      t: this.t,
    };
    this.lastBallEventT = this.t;
    this.recordHit();
    this.events.push({
      type: 'hit',
      t: this.t,
      side,
      kind: 'serve',
      speed: Math.hypot(built.v0.x, built.v0.y),
      oops: false,
      smash: false,
      serve: true,
      rallyHits: this.rallyHits,
    });
    this.handleReferee(this.referee.feed({ type: 'serveHit', side }));
  }

  cpuServe(side: Side, spec: ServeSpec): void {
    this.serve(side, spec);
  }

  canHit(side: Side): boolean {
    return (
      this.phase.kind === 'play' &&
      this.referee.state === 'rallyBounced' &&
      this.referee.receiver === side
    );
  }

  cpuHit(side: Side, decision: HitDecision): void {
    if (decision.type === 'whiff') {
      this.stats.whiffs++;
      this.stats.whiffReasons[decision.reason] =
        (this.stats.whiffReasons[decision.reason] ?? 0) + 1;
      this.events.push({ type: 'whiff', t: this.t, side });
      return;
    }
    this.hit(side, decision.spec);
  }

  /**
   * 击球：按 ShotSpec 解出手速度，交给裁判。玩家的击球也走这里。
   * 不在可击球状态（例如这一分已经结束）时忽略。
   */
  hit(side: Side, spec: ShotSpec): void {
    if (this.phase.kind !== 'play' || !this.ballFree) return;
    const built = buildShot({ ...this.ball.p }, spec, this.tune);
    if (!built.ok) this.stats.solverFailures++;
    this.ball.v = built.v0;
    this.ball.w = built.w0;
    this.rallyHits++;
    this.inFlight = {
      hitter: side,
      kind: spec.kind,
      popup: !!spec.oops,
      smash: !!spec.smash,
      serve: false,
      t: this.t,
    };
    this.lastBallEventT = this.t;
    this.recordHit();
    this.events.push({
      type: 'hit',
      t: this.t,
      side,
      kind: spec.kind,
      speed: Math.hypot(built.v0.x, built.v0.y),
      oops: !!spec.oops,
      smash: !!spec.smash,
      serve: false,
      rallyHits: this.rallyHits,
    });
    const out = this.handleReferee(this.referee.feed({ type: 'hit', side }));
    if (out.type === 'continue') {
      this.brains[otherSide(side)]?.onIncoming(this, !!spec.oops, !!spec.smash);
    }
  }

  private recordHit(): void {
    this.stats.hits++;
    if (!Number.isNaN(this.lastHitT)) this.stats.hitIntervals.push(this.t - this.lastHitT);
    this.lastHitT = this.t;
  }

  // ---------------------------------------------------------------- 球的事件 → 裁判

  private onBallEvent(e: BallEvent): void {
    this.lastBallEventT = e.t;
    let input: RefereeInput;
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
        input = { type: 'table', side: e.side!, edge: e.edge };
        break;
      case 'net':
        this.events.push({ type: 'net', t: e.t, part: e.part!, impact: e.impact, p: e.p });
        input = { type: 'net', part: e.part! };
        break;
      case 'floor':
        this.events.push({ type: 'floor', t: e.t, impact: e.impact, p: e.p });
        input = { type: 'floor' };
        break;
      case 'side':
        this.events.push({ type: 'sideHit', t: e.t, impact: e.impact, p: e.p });
        input = { type: 'side' };
        break;
    }
    if (this.phase.kind !== 'play') return;
    const before = this.referee.state;
    const out = this.handleReferee(this.referee.feed(input));
    if (out.type !== 'continue' || !this.inFlight) return;
    const receiver = otherSide(this.inFlight.hitter);
    // 发球已落在发球方半台：接发球方开始规划
    if (before === 'serve1' && this.referee.state === 'serve2') {
      this.brains[receiver]?.onIncoming(this, false, false);
    } else if (e.type === 'net' || (e.type === 'table' && e.edge)) {
      // 擦网、擦边会改变轨迹：重新规划
      if (
        this.referee.state === 'rallyIn' ||
        this.referee.state === 'serve2' ||
        this.referee.state === 'rallyBounced'
      ) {
        this.brains[receiver]?.onIncoming(this, this.inFlight.popup, this.inFlight.smash);
      }
    }
  }

  private handleReferee(out: RefereeOutput): RefereeOutput {
    if (out.type === 'point') {
      this.scoring.addPoint(out.winner);
      this.phase = { kind: 'pointOver', winner: out.winner, reason: out.reason, since: this.t };
      this.stats.reasons[out.reason] = (this.stats.reasons[out.reason] ?? 0) + 1;
      this.stats.pointDurations.push(this.t - this.pointStartT);
      this.stats.rallyLengths.push(this.rallyHits);
      for (const side of ['near', 'far'] as const) this.brains[side]?.cancel();
      this.events.push({
        type: 'point',
        t: this.t,
        winner: out.winner,
        reason: out.reason,
        score: { ...this.scoring.score },
        rallyHits: this.rallyHits,
      });
      this.inFlight = null;
    } else if (out.type === 'let') {
      this.phase = { kind: 'let', since: this.t };
      for (const side of ['near', 'far'] as const) this.brains[side]?.cancel();
      this.events.push({ type: 'let', t: this.t });
      this.inFlight = null;
    }
    return out;
  }

  /** 取走累计的事件 */
  drainEvents(): MatchEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}
