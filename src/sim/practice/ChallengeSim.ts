/**
 * 连续回击（像 WSR 的 Return Challenge）：对面的教练不停地用拍子把球打过来，回进一球 1 分，有一球没回好就结束。
 * 分数越高球越难（10 分起有上旋、下旋，25 分起有侧旋和送你扣杀的高球），供球也越紧凑。
 * 满 10 分后教练那半台上摆出纸杯靶子，回球落在靶子上把它撞飞，这一球再加 3 分。
 * 回过去的球落台后可能飞到教练脸上（只是好玩，不影响计分）。
 * 建在发球机练习（FeederSim）上：供球、判定、回球的飞行都一样，只是出球口换成教练的球拍。
 */
import { type Vec3, vec3 } from '@/core/vec3';
import { BALL, SIM_DT, TABLE } from '../constants';
import { bodyForContact, createPlayer, type PlayerSim } from '../players/PlayerSim';
import {
  type FeedLevel,
  type FeederOptions,
  FeederSim,
  type FeedResult,
  type ShotReport,
} from './FeederSim';

export const CHALLENGE = {
  /** 多少分后摆出靶子、球变难；再多少分后最难 */
  cupsAt: 10,
  hardAt: 25,
  /** 两次供球最少隔多久（秒）：按难度 1、2、3 */
  gap: { 1: 1.6, 2: 1.45, 3: 1.3 } as Record<FeedLevel, number>,
  /** 台上最多几个靶子、靶子被撞飞后多久补一个（秒）、靶子之间最少隔多远（米） */
  cups: 3,
  cupEvery: 1.0,
  cupSpacing: 0.3,
  /** 回球落点离靶子中心不超过这么远算打中（米）；打中加几分 */
  cupHitR: 0.11,
  cupBonus: 3,
  /** 最高分 */
  max: 999,
  /** 教练提前多久开始挥拍（秒，挥到击球点时球出拍） */
  swingLead: 0.35,
  /** 教练提前多久走到击球的位置（秒） */
  moveLead: 0.7,
};

/** 教练的头（球打到他脸上用）：头心高、半径（米） */
const COACH_HEAD = { z: 1.4, r: 0.2 };

export interface Cup {
  id: number;
  x: number;
  y: number;
  /** 被撞飞的时刻；null = 还立着 */
  knockedAt: number | null;
  spawnedAt: number;
}

export type ChallengeEvent =
  | { type: 'score'; t: number; total: number; gained: number; cup: boolean }
  /** 靶子出现了（满 10 分） */
  | { type: 'cupsOn'; t: number }
  | { type: 'cup'; t: number; p: Vec3 }
  | { type: 'coachHit'; t: number; p: Vec3 }
  /** 这一轮结束：哪一球没回好 */
  | { type: 'over'; t: number; score: number; reason: FeedResult };

export class ChallengeSim extends FeederSim {
  readonly coach: PlayerSim;
  score = 0;
  over = false;
  readonly cups: Cup[] = [];
  challengeEvents: ChallengeEvent[] = [];
  /** 教练已经开始挥的这一拍的击球点（下一球从这里出） */
  private nextOrigin: Vec3 | null = null;
  private cupsOn = false;
  private nextCupAt = 0;
  private cupId = 1;
  /** 已经打到过教练的球（一个球只算一次） */
  private readonly hitCoach = new WeakSet<object>();

  constructor(opts: Omit<FeederOptions, 'level' | 'multi' | 'zone'> = {}) {
    super({ ...opts, level: 1, zone: 'mixed', multi: CHALLENGE.gap[1] });
    this.coach = createPlayer(
      'far',
      1,
      true,
      { vMax: 3.6, aMax: 18, gain: 7, yFactor: 0.7 },
      this.tune
    );
    this.coach.mover.teleport(0.32, TABLE.halfLength + 0.9);
  }

  tick(): void {
    const ph = this.phase;
    // 结束了：不再供球
    if (this.over && ph.kind === 'wait') ph.until = Infinity;
    if (ph.kind === 'wait' && Number.isFinite(ph.until)) {
      // 下一球的击球点：提前走过去、挥拍，挥到击球点时球出拍
      if (!this.nextOrigin && this.t >= ph.until - CHALLENGE.moveLead) {
        this.nextOrigin = this.pickOrigin();
        const body = bodyForContact(this.coach, this.nextOrigin, 'fh', this.tune);
        this.coach.mover.setTarget(body.x, body.y);
      }
      if (this.nextOrigin && !this.coach.swing && this.t >= ph.until - CHALLENGE.swingLead) {
        this.coach.swing = {
          start: ph.until - CHALLENGE.swingLead,
          hit: ph.until,
          end: ph.until + 0.3,
          stroke: 'fh',
          height: TABLE.height + 0.15,
          kind: null,
          contact: { ...this.nextOrigin },
        };
      }
    }
    if (this.coach.swing && this.t > this.coach.swing.end + 0.25) this.coach.swing = null;
    super.tick();
    this.coach.mover.update(SIM_DT, this.coach.limits);
    this.updateCups();
    this.checkCoachFace();
  }

  pause(paused: boolean): void {
    super.pause(paused);
    this.nextOrigin = null;
    this.coach.swing = null;
  }

  drainChallengeEvents(): ChallengeEvent[] {
    const e = this.challengeEvents;
    this.challengeEvents = [];
    return e;
  }

  /** 这一球从教练的球拍出来 */
  protected feedOrigin(): Vec3 {
    const o = this.nextOrigin ?? this.pickOrigin();
    this.nextOrigin = null;
    return o;
  }

  /** 教练的击球点：台后一点、左右随机 */
  private pickOrigin(): Vec3 {
    return vec3(
      this.rng.uniform(-0.3, 0.3),
      TABLE.halfLength + this.rng.uniform(0.35, 0.55),
      TABLE.height + this.rng.uniform(0.2, 0.35)
    );
  }

  /** 每一球的结果：回进加分（落在靶子上再加），没回好就结束 */
  protected onResult(report: ShotReport): void {
    if (this.over) return;
    if (report.result !== 'in') {
      this.over = true;
      this.challengeEvents.push({
        type: 'over',
        t: this.t,
        score: this.score,
        reason: report.result,
      });
      return;
    }
    const cup = report.landing ? this.cupAt(report.landing) : null;
    if (cup && report.landing) {
      cup.knockedAt = this.t;
      this.nextCupAt = Math.max(this.nextCupAt, this.t + CHALLENGE.cupEvery);
      this.challengeEvents.push({ type: 'cup', t: this.t, p: { ...report.landing } });
    }
    const gained = 1 + (cup ? CHALLENGE.cupBonus : 0);
    this.score = Math.min(CHALLENGE.max, this.score + gained);
    this.challengeEvents.push({
      type: 'score',
      t: this.t,
      total: this.score,
      gained,
      cup: !!cup,
    });
    // 越往后球越难、供球越紧凑
    this.level = this.score >= CHALLENGE.hardAt ? 3 : this.score >= CHALLENGE.cupsAt ? 2 : 1;
    this.multi = CHALLENGE.gap[this.level];
    if (!this.cupsOn && this.score >= CHALLENGE.cupsAt) {
      this.cupsOn = true;
      this.nextCupAt = this.t;
      this.challengeEvents.push({ type: 'cupsOn', t: this.t });
    }
  }

  private cupAt(p: Vec3): Cup | null {
    for (const c of this.cups) {
      if (c.knockedAt === null && Math.hypot(p.x - c.x, p.y - c.y) <= CHALLENGE.cupHitR) return c;
    }
    return null;
  }

  /** 撞飞的靶子过一会儿收掉；台上不满就补一个（和别的靶子隔开） */
  private updateCups(): void {
    for (let i = this.cups.length - 1; i >= 0; i--) {
      const c = this.cups[i];
      if (c.knockedAt !== null && this.t - c.knockedAt > 1.5) this.cups.splice(i, 1);
    }
    if (!this.cupsOn || this.over || this.t < this.nextCupAt) return;
    const standing = this.cups.filter((c) => c.knockedAt === null);
    if (standing.length >= CHALLENGE.cups) return;
    for (let tries = 0; tries < 20; tries++) {
      const x = this.rng.uniform(-0.6, 0.6);
      const y = this.rng.uniform(0.35, 1.15);
      if (standing.every((c) => Math.hypot(c.x - x, c.y - y) >= CHALLENGE.cupSpacing)) {
        this.cups.push({ id: this.cupId++, x, y, knockedAt: null, spawnedAt: this.t });
        break;
      }
    }
    this.nextCupAt = this.t + CHALLENGE.cupEvery;
  }

  /** 回过去的球落台后飞到教练脸上：球弹开，教练捂脸（不影响计分） */
  private checkCoachFace(): void {
    const m = this.coach.mover;
    for (const s of this.spent) {
      if (this.hitCoach.has(s)) continue;
      const b = s.ball.p;
      const c = { x: m.x, y: m.y, z: COACH_HEAD.z };
      const d = Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z);
      if (d > COACH_HEAD.r + BALL.radius || d < 1e-6) continue;
      const n = { x: (b.x - c.x) / d, y: (b.y - c.y) / d, z: (b.z - c.z) / d };
      const v = s.ball.v;
      const vn = v.x * n.x + v.y * n.y + v.z * n.z;
      if (vn >= 0) continue;
      v.x -= 1.45 * vn * n.x;
      v.y -= 1.45 * vn * n.y;
      v.z -= 1.45 * vn * n.z;
      this.hitCoach.add(s);
      this.challengeEvents.push({ type: 'coachHit', t: this.t, p: { ...b } });
    }
  }
}
