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
import type { TrailStyle } from '@/render/BallView';
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

export class GameView {
  readonly renderer: Renderer;
  readonly hud: Hud;
  readonly sfx = new Sfx();
  sim: MatchSim;
  timeScale = 1;
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
    this.hud = new Hud(container, opts.names);
    this.sim = sim;
    this.prev = this.snapshot();
  }

  setSim(sim: MatchSim): void {
    this.sim = sim;
    this.acc = 0;
    this.prev = this.snapshot();
    this.hud.clearFlash();
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
    this.acc += Math.max(0, Math.min(0.1, dtReal)) * this.timeScale;
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
    this.trail = inFlight?.popup ? 'wobble' : inFlight?.smash ? 'streak' : 'normal';
    const frame: RenderFrame = {
      t,
      ball: {
        x: lerp(this.prev.ball.x, cur.ball.x),
        y: lerp(this.prev.ball.y, cur.ball.y),
        z: lerp(this.prev.ball.z, cur.ball.z),
      },
      ballVisible: s.phase.kind !== 'gameOver',
      trail: this.trail,
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
      shake: s.t < this.shakeUntil ? 0.02 : 0,
    };
    this.renderer.render(frame);

    const showScore =
      this.opts.alwaysShowScore ||
      s.phase.kind === 'pointOver' ||
      s.phase.kind === 'gameOver' ||
      (s.phase.kind === 'preServe' && s.t - s.phase.since < 1.5);
    const gp = s.scoring.gamePointFor;
    const label =
      s.phase.kind === 'gameOver' ? '比赛结束' : gp ? '局点' : s.scoring.isDeuce ? '平分' : '';
    this.hud.showScore(
      s.scoring.score,
      s.phase.kind === 'gameOver' ? null : s.server,
      showScore,
      label
    );
  }

  private onEvent(e: MatchEvent): void {
    const pan = (p: { x: number }) => p.x / 1.5;
    switch (e.type) {
      case 'hit': {
        const p = this.sim.ball.p;
        this.sfx.hit(Math.min(1, e.speed / 15), pan(p), e.smash);
        if (e.oops) this.hud.flash('哎呀!', '', 0.9, 'bad');
        if (e.smash) {
          this.hud.flash('扣杀!', '', 0.9, 'big');
          this.shakeUntil = this.sim.t + 0.12;
        }
        // 长回合：观众跟拍喊，再长就安静下来、球声带回声
        if (e.rallyHits >= 8 && e.rallyHits < 20)
          this.sfx.crowd('chant', Math.min(1, (e.rallyHits - 6) / 8));
        this.sfx.setEcho(e.rallyHits >= 20 ? 0.45 : 0);
        break;
      }
      case 'bounce':
        this.sfx.table(e.impact, pan(e.p));
        break;
      case 'net':
        this.sfx.net(e.impact);
        break;
      case 'floor':
        this.sfx.floor(e.impact, pan(e.p));
        break;
      case 'point': {
        this.sfx.setEcho(0);
        this.sfx.crowd('cheer', e.rallyHits >= 8 ? 1 : 0.6);
        const who = e.winner === 'near' ? this.opts.names.near : this.opts.names.far;
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
      case 'gameOver': {
        const text =
          e.result === 'draw'
            ? '平局'
            : `${e.result === 'near' ? this.opts.names.near : this.opts.names.far}获胜`;
        this.hud.flash(text, `${e.score.near} : ${e.score.far}`, 0, 'big');
        this.sfx.crowd('cheer', 1);
        break;
      }
      default:
        break;
    }
    this.opts.onEvent?.(e);
  }
}
