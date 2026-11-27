/**
 * 把一局 MatchSim 接到画面、声音、文字层：固定步长推进仿真，渲染时在两步之间插值，并消费比赛事件。
 */
import type { Vec3 } from '@/core/vec3';
import { Sfx } from '@/audio/Sfx';
import { type Side } from '@/sim/constants';
import type { MatchEvent, MatchSim } from '@/sim/MatchSim';
import { REASON_TEXT } from '@/sim/rally/Referee';
import { cpuPaddle, type PaddlePose } from '@/render/paddlePose';
import { type RenderFrame, Renderer } from '@/render/Renderer';
import { ballSpin, type TrailStyle } from '@/render/BallView';
import type { ServeCue } from '@/render/Effects';
import { Hud, type HudNames } from '@/ui/Hud';
import { CROWD_GAIN, loadCrowdVolume } from './shared/crowdVolume';
import { SIM_DT } from '@/sim/constants';

interface Snapshot {
  ball: Vec3;
  ballVisible: boolean;
  bodies: Record<Side, { x: number; y: number }>;
}

export interface GameViewOptions {
  names: HudNames;
  /** 回合中也显示比分（自动演示用）；正式比赛按 WSR 只在两分之间显示 */
  alwaysShowScore?: boolean;
  /** 自定义近端 / 远端球拍（玩家的 1:1 球拍）；不传则按电脑动画 */
  nearPaddle?: (t: number, body: { x: number; y: number }) => PaddlePose;
  farPaddle?: (t: number, body: { x: number; y: number }) => PaddlePose;
  /** 双人分屏（左近端、右远端） */
  split?: boolean;
  onEvent?: (e: MatchEvent) => void;
}

/**
 * 扣杀时镜头的顿挫：顺着球飞的方向轻轻一顶（push 米）、略往下沉（dip 米），dur 秒内按半个正弦回正。
 * 以前是 0.12 秒的随机乱晃，看着像画面在抖
 */
const KICK = { push: 0.04, dip: 0.012, dur: 0.15 };

/**
 * 观众声的音量：平时的低语、激动到顶时的欢呼层、全场安静后击球声的回声比例。
 * 低语一直在响，太大了像一层底噪（2026-11-24 从 0.22 减半）；整体再乘玩家设置的观众声大 / 小 / 关
 */
const CROWD = { calm: 0.11, excited: 0.55, echo: 0.4 };

export class GameView {
  readonly renderer: Renderer;
  readonly hud: Hud;
  readonly sfx = new Sfx();
  sim: MatchSim;
  timeScale = 1;
  /** 暂停：照常渲染，但不推进仿真 */
  paused = false;
  private names: HudNames;
  private acc = 0;
  private prev: Snapshot;
  /** 上一次扣杀的时刻（仿真时间）和球飞的水平方向 */
  private kickAt = -Infinity;
  private kickDir = { x: 0, y: 0 };
  private trail: TrailStyle = 'normal';
  private crowdOn = false;
  /** 最后一分是不是球打到人（一局结束时输的一方照样捂脸） */
  private lastPointHit = false;

  constructor(
    container: HTMLElement,
    sim: MatchSim,
    private opts: GameViewOptions
  ) {
    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    container.appendChild(canvas);
    this.renderer = new Renderer(canvas);
    this.renderer.setSplit(!!opts.split);
    this.names = opts.names;
    this.hud = new Hud(container, opts.names);
    this.sim = sim;
    this.prev = this.snapshot();
    this.sfx.setCrowd(CROWD.calm, 0);
    this.sfx.setCrowdLevel(CROWD_GAIN[loadCrowdVolume()]);
  }

  /** 换一套选项（对打里切换 1 人 / 2 人时共用同一个画面） */
  configure(opts: GameViewOptions): void {
    this.opts = opts;
    this.renderer.setSplit(!!opts.split);
    this.setNames(opts.names);
  }

  /** 换上新的一局：观众回到平时的低语（上一局可能停在长回合的屏息里） */
  setSim(sim: MatchSim): void {
    this.sim = sim;
    this.acc = 0;
    this.prev = this.snapshot();
    this.hud.clearFlash();
    this.sfx.setEcho(0);
    this.sfx.setCrowd(CROWD.calm, 0);
    this.renderer.crowd.mood(0);
  }

  setNames(names: HudNames): void {
    this.names = names;
    this.hud.setNames(names);
  }

  /** 还没推进的真实时间（秒）：画面上的仿真时刻 = sim.t − lag（换算输入时间用） */
  get lag(): number {
    return this.acc;
  }

  private snapshot(): Snapshot {
    const s = this.sim;
    return {
      ball: { ...s.ball.p },
      ballVisible: true,
      bodies: {
        near: { x: s.players.near.mover.x, y: s.players.near.mover.y },
        far: { x: s.players.far.mover.x, y: s.players.far.mover.y },
      },
    };
  }

  /** 每帧调用：推进仿真（最多 12 步，避免卡顿后狂追），处理事件，渲染 */
  frame(dtReal: number): void {
    if (!this.paused) this.acc += Math.max(0, Math.min(0.1, dtReal)) * this.timeScale;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < 12) {
      this.prev = this.snapshot();
      this.sim.tick();
      this.acc -= SIM_DT;
      steps++;
    }
    if (steps === 12) this.acc = 0;
    for (const e of this.sim.drainEvents()) this.onEvent(e);
    // 循环的观众声只在打球时放：连接、选对手、暂停、结算时淡出
    if (this.paused === this.crowdOn) {
      this.crowdOn = !this.paused;
      this.sfx.setCrowdOn(this.crowdOn);
    }
    this.draw(this.acc / SIM_DT);
  }

  private draw(alpha: number): void {
    const s = this.sim;
    const cur = this.snapshot();
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const t = s.t - SIM_DT + alpha * SIM_DT;
    const body = (side: Side) => ({
      x: lerp(this.prev.bodies[side].x, cur.bodies[side].x),
      y: lerp(this.prev.bodies[side].y, cur.bodies[side].y),
    });
    const nearBody = body('near');
    const farBody = body('far');
    const inFlight = s.inFlight;
    this.trail = inFlight?.popup
      ? 'wobble'
      : inFlight?.smash || inFlight?.power
        ? 'streak'
        : 'normal';
    const frame: RenderFrame = {
      t,
      ball: {
        x: lerp(this.prev.ball.x, cur.ball.x),
        y: lerp(this.prev.ball.y, cur.ball.y),
        z: lerp(this.prev.ball.z, cur.ball.z),
      },
      ballVisible: s.phase.kind !== 'gameOver',
      trail: this.trail,
      spin: ballSpin(s.ball.v, s.ball.w),
      players: {
        near: {
          player: s.players.near,
          body: nearBody,
          paddle: this.opts.nearPaddle
            ? this.opts.nearPaddle(t, nearBody)
            : cpuPaddle(nearBody, s.players.near, s.players.near.swing, t),
        },
        far: {
          player: s.players.far,
          body: farBody,
          paddle: this.opts.farPaddle
            ? this.opts.farPaddle(t, farBody)
            : cpuPaddle(farBody, s.players.far, s.players.far.swing, t),
        },
      },
      serveCue: this.serveCue(),
      kick: this.kick(t),
    };
    this.renderer.render(frame);

    const showScore =
      this.opts.alwaysShowScore ||
      s.phase.kind === 'pointOver' ||
      s.phase.kind === 'gameOver' ||
      (s.phase.kind === 'preServe' && s.t - s.phase.since < 1.5);
    const gp = s.scoring.gamePointFor;
    const label = s.result ? '比赛结束' : gp ? '局点' : s.scoring.isDeuce ? '平分' : '';
    this.hud.showScore(
      s.scoring.score,
      s.phase.kind === 'gameOver' ? null : s.server,
      showScore,
      label
    );
  }

  /**
   * 观众跟着回合走（模仿 WSR 长回合时「全场屏息」的感觉，层层推进而不是一下子安静）：
   * 平时轻声低语；第 8 拍「哦——」一声，之后越来越激动，每一拍齐喊一声「嘿！」、举着手的人跟着跳；
   * 第 20 拍起喊声停下，两三秒里慢慢静下来，击球声的回声慢慢浮现；得分时欢呼（见 point 事件）
   */
  private crowdFollow(n: number): void {
    if (n === 8) this.sfx.crowd('ooh');
    else if (n > 8 && n < 20) {
      this.sfx.crowd('chant', (n - 8) / 11);
      this.renderer.crowd.chant();
    }
    if (n < 8) {
      this.sfx.setCrowd(CROWD.calm, 0, 0.8);
      this.renderer.crowd.mood(0);
    } else if (n < 20) {
      const k = (n - 7) / 12;
      this.sfx.setCrowd(CROWD.calm * (1 - 0.3 * k), CROWD.excited * k, 0.5);
      // 看台上举手的人跟着越来越多
      this.renderer.crowd.mood(k);
    } else {
      this.sfx.setCrowd(0, 0, 1.2);
      this.sfx.setEcho(CROWD.echo, 1);
      this.renderer.crowd.mood(0, true);
    }
  }

  /** 扣杀顿挫这一刻镜头挪开多少（t = 画面上的仿真时刻） */
  private kick(t: number): Vec3 | undefined {
    const age = t - this.kickAt;
    if (!(age >= 0 && age < KICK.dur)) return undefined;
    const s = Math.sin((Math.PI * age) / KICK.dur);
    return {
      x: this.kickDir.x * KICK.push * s,
      y: this.kickDir.y * KICK.push * s,
      z: -KICK.dip * s,
    };
  }

  /** 人抛了球、还没发出去：最佳击球高度的提示圈（球是竖直抛的，圈就在球的正下方 / 正上方） */
  private serveCue(): ServeCue | null {
    const s = this.sim;
    const ph = s.phase;
    if (ph.kind !== 'toss') return null;
    const at = s.human(ph.server)?.serveAt;
    if (!at) return null;
    return {
      p: { x: s.ball.p.x, y: s.ball.p.y, z: ph.handZ + s.tune.serve.sweetAboveHand },
      ideal: at.ideal,
      window: s.tune.serve.powerMs / 1000,
    };
  }

  private onEvent(e: MatchEvent): void {
    const pan = (p: { x: number }) => p.x / 1.5;
    switch (e.type) {
      case 'hit': {
        this.sfx.hit(Math.min(1, e.speed / 15), pan(e.p), e.smash || !!e.powerServe);
        this.renderer.hitEffect(e.p, e.smash || !!e.powerServe);
        if (e.powerServe) this.hud.flash('强力发球!', '', 0.9, 'big');
        if (e.oops) this.hud.flash('哎呀!', '', 0.9, 'bad');
        if (e.smash) {
          this.hud.flash('扣杀!', '', 0.9, 'big');
          const v = this.sim.ball.v;
          const h = Math.hypot(v.x, v.y) || 1;
          this.kickAt = e.t;
          this.kickDir = { x: v.x / h, y: v.y / h };
        }
        this.crowdFollow(e.rallyHits);
        break;
      }
      case 'bounce':
        this.sfx.table(e.impact, pan(e.p));
        this.renderer.bounceEffect(e.p);
        break;
      case 'net':
        this.sfx.net(e.impact);
        break;
      case 'floor':
        this.sfx.floor(e.impact, pan(e.p));
        break;
      case 'bodyHit':
        // 球打到人：一声闷响，全场「哦——」（得分的欢呼见 point）
        this.sfx.bonk(pan(e.p));
        this.sfx.crowd('ooh');
        break;
      case 'point': {
        // 得分：回声收掉、全场欢呼，再慢慢回到平时的低语
        const hit = e.reason === 'face' || e.reason === 'body';
        this.lastPointHit = hit;
        this.sfx.setEcho(0);
        this.sfx.crowd('cheer', e.rallyHits >= 8 ? 1 : 0.6);
        this.sfx.setCrowd(CROWD.calm, 0, 1.5);
        this.renderer.crowd.mood(0);
        this.renderer.crowd.cheer(e.rallyHits >= 8 ? 1 : 0.4);
        this.renderer.pointReaction(e.winner, false, hit);
        const who = e.winner === 'near' ? this.names.near : this.names.far;
        // 和电脑打：你得分绿、电脑得分红；两个人打：谁得分都是绿
        const versus = !!(this.sim.humans.near && this.sim.humans.far);
        this.hud.flash(
          REASON_TEXT[e.reason],
          `${who}得分`,
          1.8,
          e.winner === 'near' || versus ? 'good' : 'bad'
        );
        break;
      }
      case 'let':
        this.hud.flash('擦网', '重新发球', 1.2);
        break;
      case 'replay':
        this.hud.flash('这一分重打', '', 1.2);
        break;
      case 'gameOver': {
        const text =
          e.result === 'draw'
            ? '平局'
            : `${e.result === 'near' ? this.names.near : this.names.far}获胜`;
        this.hud.flash(text, `${e.score.near} : ${e.score.far}`, 0, 'big');
        this.sfx.crowd('cheer', 1);
        this.renderer.crowd.cheer(1);
        if (e.result !== 'draw') this.renderer.pointReaction(e.result, true, this.lastPointHit);
        break;
      }
      default:
        break;
    }
    this.opts.onEvent?.(e);
  }
}
