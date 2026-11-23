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
  /** 自定义近端球拍（玩家的 1:1 球拍）；不传则按电脑动画 */
  nearPaddle?: (t: number, body: { x: number; y: number }) => PaddlePose;
  onEvent?: (e: MatchEvent) => void;
}

/** 观众声的音量：平时的低语、激动到顶时的欢呼层、全场安静后击球声的回声比例 */
const CROWD = { calm: 0.22, excited: 0.55, echo: 0.4 };

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
  private shakeUntil = 0;
  private trail: TrailStyle = 'normal';

  constructor(
    container: HTMLElement,
    sim: MatchSim,
    private readonly opts: GameViewOptions
  ) {
    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    container.appendChild(canvas);
    this.renderer = new Renderer(canvas);
    this.names = opts.names;
    this.hud = new Hud(container, opts.names);
    this.sim = sim;
    this.prev = this.snapshot();
    this.sfx.setCrowd(CROWD.calm, 0);
  }

  setSim(sim: MatchSim): void {
    this.sim = sim;
    this.acc = 0;
    this.prev = this.snapshot();
    this.hud.clearFlash();
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
          paddle: cpuPaddle(farBody, s.players.far, s.players.far.swing, t),
        },
      },
      serveCue: this.serveCue(),
      shake: s.t < this.shakeUntil ? 0.02 : 0,
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
   * 平时轻声低语；第 8 拍起越来越激动（第 8、14 拍各「哦——」一声）；第 20 拍起两三秒里慢慢静下来，
   * 击球声的回声慢慢浮现；得分时欢呼（见 point 事件）
   */
  private crowdFollow(n: number): void {
    if (n === 8 || n === 14) this.sfx.crowd('ooh');
    if (n < 8) {
      this.sfx.setCrowd(CROWD.calm, 0, 0.8);
    } else if (n < 20) {
      const k = (n - 7) / 12;
      this.sfx.setCrowd(CROWD.calm * (1 - 0.3 * k), CROWD.excited * k, 0.5);
    } else {
      this.sfx.setCrowd(0, 0, 1.2);
      this.sfx.setEcho(CROWD.echo, 1);
    }
  }

  /** 近端的人抛了球、还没发出去：最佳击球高度的提示圈（球是竖直抛的，圈就在球的正下方 / 正上方） */
  private serveCue(): ServeCue | null {
    const s = this.sim;
    const ph = s.phase;
    const at = s.human('near')?.serveAt;
    if (ph.kind !== 'toss' || ph.server !== 'near' || !at) return null;
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
          this.shakeUntil = this.sim.t + 0.12;
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
      case 'point': {
        // 得分：回声收掉、全场欢呼，再慢慢回到平时的低语
        this.sfx.setEcho(0);
        this.sfx.crowd('cheer', e.rallyHits >= 8 ? 1 : 0.6);
        this.sfx.setCrowd(CROWD.calm, 0, 1.5);
        this.renderer.pointReaction(e.winner);
        const who = e.winner === 'near' ? this.names.near : this.names.far;
        this.hud.flash(
          REASON_TEXT[e.reason],
          `${who}得分`,
          1.8,
          e.winner === 'near' ? 'good' : 'bad'
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
        if (e.result !== 'draw') this.renderer.pointReaction(e.result, true);
        break;
      }
      default:
        break;
    }
    this.opts.onEvent?.(e);
  }
}
