/**
 * 连续回击：对面的教练不停用拍子把球打过来，回进一球 1 分，有一球没回好这一轮就结束（像 WSR 的 Return Challenge）。
 * 满 10 分后台上摆出纸杯靶子，回球落在靶子上再加 3 分；越往后球越难。最多 4 个人轮流用同一个手柄打，
 * 一轮打完出排行；最高分存在本机。连接、校准和发球机练习共用。
 */
import '../practice/practice.css';
import './challenge.css';
import { Sfx } from '@/audio/Sfx';
import { tuning } from '@/config/tuning';
import { type Vec3, vec3 } from '@/core/vec3';
import { SIM_DT } from '@/sim/constants';
import { type ChallengeEvent, ChallengeSim } from '@/sim/practice/ChallengeSim';
import { FEED_RESULT_TEXT, type FeederEvent } from '@/sim/practice/FeederSim';
import { ballSpin } from '@/render/BallView';
import { cpuPaddle } from '@/render/paddlePose';
import { Renderer } from '@/render/Renderer';
import { Hud } from '@/ui/Hud';
import { MotionInput, type SwingEventOut } from '../input/MotionInput';
import { CROWD_GAIN, loadCrowdVolume } from '../shared/crowdVolume';
import { latencyMs } from '../shared/latency';
import { deviceSwingInput, HumanPaddle, keySwingInput } from '../shared/motionPlay';
import { deviceWords, SetupFlow } from '../shared/SetupFlow';

interface Saved {
  /** 几个人轮流打（1..4） */
  players: number;
  /** 本机最高分 */
  best: number;
}

const SAVE_KEY = 'rea-challenge';

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Partial<Saved> | null;
    const players = Math.round(s?.players ?? 1);
    return { players: players >= 1 && players <= 4 ? players : 1, best: s?.best ?? 0 };
  } catch {
    return { players: 1, best: 0 };
  }
}

function save(s: Saved): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch {
    // 不保存
  }
}

/**
 * setup = 连接 / 校准；ready = 等这一位按 A 开始；run = 正在打；done = 这一位打完（看分数）；
 * round = 这一轮所有人都打完（排行）
 */
type Step = 'setup' | 'ready' | 'run' | 'done' | 'round';

/** 一轮结束后多久出分数面板（秒）：让最后一球飞完、观众反应一下 */
const DONE_DELAY = 1.6;

export class ChallengeApp {
  private readonly renderer: Renderer;
  private readonly hud: Hud;
  private readonly sfx = new Sfx();
  private readonly input = new MotionInput();
  private readonly paddleView = new HumanPaddle();
  private readonly setup: SetupFlow;
  private sim: ChallengeSim;
  private saved = load();
  private stage: Exclude<Step, 'setup'> = 'ready';
  private keyboard = false;
  private paused = false;
  /** 这一轮：第几位在打、每位的得分 */
  private turn = 0;
  private scores: number[] = [];
  private doneAt = NaN;
  private newBest = false;
  private crowdOn = false;

  // 时间换算：输入（performance.now 毫秒）↔ 仿真时间；插值
  private clockSim = 0;
  private clockReal = 0;
  private acc = 0;
  private last = performance.now();
  private prev = { body: { x: 0, y: -2 }, coach: { x: 0, y: 2 }, ball: vec3() as Vec3 };
  private keyId = 1_000_000;
  private readonly keysDown = new Set<string>();

  // DOM
  private readonly overlay: HTMLDivElement;
  private readonly boardEl: HTMLDivElement;
  private readonly panelEl: HTMLDivElement;
  private readonly pauseEl: HTMLDivElement;
  private readonly popEl: HTMLDivElement;
  private popTimer = 0;

  constructor(root: HTMLElement) {
    root.className = 'game-root practice challenge';
    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    root.appendChild(canvas);
    this.renderer = new Renderer(canvas);
    this.hud = new Hud(root, { near: '你', far: '教练' });
    this.sfx.setCrowd(0.11, 0);
    this.sfx.setCrowdLevel(CROWD_GAIN[loadCrowdVolume()]);
    this.sim = this.makeSim();
    root.insertAdjacentHTML(
      'beforeend',
      `<div class="ch-board"></div>
       <div class="ch-pop"></div>
       <div class="pr-overlay ch-panel" hidden></div>
       <div class="pr-overlay"></div>
       <div class="pr-pause" hidden></div>`
    );
    this.boardEl = root.querySelector('.ch-board')!;
    this.popEl = root.querySelector('.ch-pop')!;
    this.panelEl = root.querySelector('.ch-panel')!;
    this.overlay = root.querySelector('.pr-overlay:not(.ch-panel)')!;
    this.pauseEl = root.querySelector('.pr-pause')!;
    this.setup = new SetupFlow(this.overlay, this.input, this.hud, this.sfx, {
      title: '连续回击',
      keyboardHelp: 'F 正手、J 反手，按键时机 = 击球时机。',
      onDone: (msg) => this.afterSetup(msg),
      onKeyboard: () => {
        this.keyboard = true;
        this.afterSetup('键盘：F 正手、J 反手');
      },
    });
    this.input.events = {
      onSwing: (e) => this.onDeviceSwing(e),
      onPeak: (e) => this.sim.refineSwing(e.peak.id, e.peak.w, e.features),
      onButton: (b, down) => down && this.onButton(b),
      onCalibrate: (_d, result) => this.setup.onCalibrate(result),
      onDevicesChanged: () => this.setup.render(),
      onLinkStatus: () => this.setup.linkChanged(),
    };
    window.addEventListener('keydown', (e) => {
      this.keysDown.add(e.key.toLowerCase());
      this.onKey(e);
    });
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.key.toLowerCase()));
    window.addEventListener('pointerdown', () => this.sfx.unlock());
    this.setup.render();
    void this.input.start().then(() => this.setup.render());
    // 冒烟测试 / 调试用：?debug=1 时把实例挂到 window 上
    if (new URLSearchParams(location.search).has('debug')) {
      (window as unknown as { __challenge: ChallengeApp }).__challenge = this;
    }
    this.renderBoard();
    requestAnimationFrame(() => this.loop());
  }

  /** 调试：当前状态（冒烟测试读取） */
  debugState(): {
    step: Step;
    paused: boolean;
    t: number;
    score: number;
    over: boolean;
    level: number;
    cups: number;
    awaiting: boolean;
    planT: number | null;
    stance: string;
    turn: number;
    scores: number[];
    best: number;
  } {
    const s = this.sim;
    return {
      step: this.step,
      paused: this.paused,
      t: s.t,
      score: s.score,
      over: s.over,
      level: s.level,
      cups: s.cups.filter((c) => c.knockedAt === null).length,
      awaiting: s.awaitingSwing,
      planT: s.plan?.t ?? null,
      stance: s.player.stance,
      turn: this.turn,
      scores: [...this.scores],
      best: this.saved.best,
    };
  }

  private get step(): Step {
    return this.setup.done ? this.stage : 'setup';
  }

  private makeSim(): ChallengeSim {
    const sim = new ChallengeSim({
      seed: Math.floor(Math.random() * 1e9),
      handed: this.input?.handed ?? 1,
      tune: tuning,
    });
    sim.pause(true);
    return sim;
  }

  // ---------------------------------------------------------------- 主循环

  private loop(): void {
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    const running = this.step === 'run' && !this.paused;
    this.input.autoHeading = running && !this.keyboard;
    // 循环的观众声只在打球时放
    if (running !== this.crowdOn) {
      this.crowdOn = running;
      this.sfx.setCrowdOn(running);
    }
    // 这一位打完后：最后一球飞完也继续推进（球落地、教练和人的反应）
    if (running || this.stage === 'done') {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < 12) {
        const s = this.sim;
        this.prev = {
          body: { x: s.player.mover.x, y: s.player.mover.y },
          coach: { x: s.coach.mover.x, y: s.coach.mover.y },
          ball: { ...s.ball.p },
        };
        s.tick();
        this.acc -= SIM_DT;
        steps++;
      }
      if (steps === 12) this.acc = 0;
    }
    this.clockSim = this.sim.t;
    this.clockReal = now - this.acc * 1000;
    for (const e of this.sim.drainEvents()) this.onSimEvent(e);
    for (const e of this.sim.drainChallengeEvents()) this.onChallengeEvent(e);
    if (this.stage === 'run' && this.sim.over && Number.isNaN(this.doneAt)) {
      this.doneAt = now + DONE_DELAY * 1000;
    }
    if (!Number.isNaN(this.doneAt) && now >= this.doneAt) {
      this.doneAt = NaN;
      this.finishTurn();
    }
    this.draw();
    this.setup.tick();
    requestAnimationFrame(() => this.loop());
  }

  private simAt(ms: number): number {
    return this.clockSim + (ms - this.clockReal) / 1000;
  }

  private draw(): void {
    const s = this.sim;
    const a = this.acc / SIM_DT;
    const lerp = (x: number, y: number) => x + (y - x) * a;
    const p = this.prev;
    const body = { x: lerp(p.body.x, s.player.mover.x), y: lerp(p.body.y, s.player.mover.y) };
    const coach = { x: lerp(p.coach.x, s.coach.mover.x), y: lerp(p.coach.y, s.coach.mover.y) };
    const ball = {
      x: lerp(p.ball.x, s.ball.p.x),
      y: lerp(p.ball.y, s.ball.p.y),
      z: lerp(p.ball.z, s.ball.p.z),
    };
    const t = s.t - SIM_DT + a * SIM_DT;
    const device = this.keyboard ? null : (this.input.active?.paddle ?? null);
    this.renderer.render({
      t,
      ball,
      // 教练还没把球打出来时不画球（球在他手里）
      ballVisible: s.ballFree,
      trail: 'normal',
      spin: ballSpin(s.ball.v, s.ball.w),
      players: {
        near: { player: s.player, body, paddle: this.paddleView.pose(device, s.player, body, t) },
        far: {
          player: s.coach,
          body: coach,
          paddle: cpuPaddle(coach, s.coach, s.coach.swing, t),
        },
      },
      extraBalls: [...s.flyers, ...s.spent].map((f) => f.ball.p),
      cups: s.cups,
    });
  }

  // ---------------------------------------------------------------- 输入

  private onDeviceSwing(e: SwingEventOut): void {
    if (this.step !== 'run' || this.paused) return;
    this.sim.swing(deviceSwingInput(e, (ms) => this.simAt(ms), latencyMs()));
  }

  private onKey(e: KeyboardEvent): void {
    this.sfx.unlock();
    const k = e.key.toLowerCase();
    if (k === 'escape' || k === 'p') {
      this.togglePause();
      return;
    }
    if (e.repeat) return;
    if (k === 'enter' || k === ' ') {
      e.preventDefault();
      this.onButton('confirm');
      return;
    }
    if (this.step !== 'run' || this.paused) return;
    if (k === 'f' || k === 'j') {
      // 键盘：F 正手、J 反手；按住 W 拉上旋、S 搓下旋；Shift 大力
      this.keyboard = true;
      this.sim.swing(
        keySwingInput(
          k === 'f' ? 1 : -1,
          this.keysDown,
          e.shiftKey,
          this.keyId++,
          (ms) => this.simAt(ms),
          latencyMs()
        )
      );
    }
  }

  private onButton(b: string): void {
    this.sfx.unlock();
    if (b === 'pause') {
      this.togglePause();
      return;
    }
    if (this.setup.onButton(b)) return;
    if (this.paused) {
      if (b === 'confirm') this.togglePause();
      return;
    }
    const step = this.step;
    if (b === 'recenter' && step === 'run') {
      const head = deviceWords(this.input.active).head;
      if (this.input.recenter()) this.hud.flash('已回中', '', 0.8);
      else this.hud.flash('没能回中', `把${head}像遥控器一样指向电视再按`, 1.4, 'bad');
      return;
    }
    if (b !== 'confirm') return;
    if (step === 'ready') this.startTurn();
    else if (step === 'done') this.afterTurn();
    else if (step === 'round') this.newRound();
  }

  // ---------------------------------------------------------------- 流程

  private afterSetup(msg: string): void {
    this.hud.flash(msg, '', 1.2, 'good');
    this.newRound();
  }

  private newRound(): void {
    this.turn = 0;
    this.scores = [];
    this.showReady();
  }

  private showReady(): void {
    this.stage = 'ready';
    this.sim = this.makeSim();
    this.renderBoard();
    this.renderPanel();
  }

  private startTurn(): void {
    this.stage = 'run';
    this.newBest = false;
    this.panelEl.hidden = true;
    this.sim.pause(false);
    this.hud.flash(this.multi ? `玩家 ${this.turn + 1}` : '开始', '回一球 1 分，漏一球就结束', 1.4);
    this.renderBoard();
  }

  /** 这一位打完：记分、看是不是新纪录 */
  private finishTurn(): void {
    const score = this.sim.score;
    this.scores[this.turn] = score;
    if (score > this.saved.best) {
      this.saved.best = score;
      this.newBest = true;
      save(this.saved);
    }
    this.stage = 'done';
    this.renderBoard();
    this.renderPanel();
  }

  /** 这一位看完分数：一个人打就直接再来一次，几个人轮流就轮到下一位（都打完出排行） */
  private afterTurn(): void {
    if (this.multi) this.nextTurn();
    else this.newRound();
  }

  private nextTurn(): void {
    if (this.turn + 1 < this.saved.players) {
      this.turn++;
      this.showReady();
    } else {
      this.stage = 'round';
      this.renderPanel();
    }
  }

  private get multi(): boolean {
    return this.saved.players > 1;
  }

  private togglePause(): void {
    if (this.step !== 'run' || this.sim.over) return;
    this.paused = !this.paused;
    this.renderPause();
  }

  // ---------------------------------------------------------------- 事件

  private onSimEvent(e: FeederEvent): void {
    const pan = (p: { x: number }) => p.x / 1.5;
    switch (e.type) {
      case 'feed':
        // 教练出拍
        this.sfx.hit(0.35, pan(this.sim.machine), false);
        this.renderer.hitEffect(this.sim.machine, false);
        break;
      case 'hit':
        this.sfx.hit(e.power, pan(e.p), e.smash);
        this.renderer.hitEffect(e.p, e.smash);
        this.input.rumble(e.smash ? 'smash' : e.oops ? 'oops' : 'hit');
        if (e.oops) this.hud.flash('哎呀!', '', 0.9, 'bad');
        if (e.smash) this.hud.flash('扣杀!', '', 0.9, 'big');
        break;
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
      default:
        break;
    }
  }

  private onChallengeEvent(e: ChallengeEvent): void {
    const pan = (p: { x: number }) => p.x / 1.5;
    switch (e.type) {
      case 'score': {
        this.pop(e.cup ? `+${e.gained} 打中靶子!` : '+1', e.cup);
        // 观众跟着分数越来越激动，10 分起每回一球齐喊一声
        const k = Math.min(1, e.total / 30);
        this.sfx.setCrowd(0.11 * (1 - 0.3 * k), 0.55 * k, 0.6);
        this.renderer.crowd.mood(k);
        if (e.total >= 10) {
          this.sfx.crowd('chant', k);
          this.renderer.crowd.chant();
        }
        this.renderBoard();
        break;
      }
      case 'cup':
        this.sfx.cup(pan(e.p));
        this.sfx.crowd('cheer', 0.4);
        break;
      case 'cupsOn':
        this.hud.flash('靶子出现了!', '回球落在纸杯上再加 3 分', 1.8, 'big');
        break;
      case 'coachHit':
        this.sfx.bonk(pan(e.p));
        this.sfx.crowd('ooh');
        this.renderer.avatars.far.react('ouch', 1.6);
        this.hud.flash('打到教练脸上了', '', 1.2);
        break;
      case 'over': {
        const best = e.score > this.saved.best;
        this.hud.flash(
          FEED_RESULT_TEXT[e.reason],
          `这一轮 ${e.score} 分`,
          1.6,
          best ? 'good' : 'bad'
        );
        this.sfx.crowd(best ? 'cheer' : 'ooh', best ? 1 : 0.6);
        this.renderer.crowd.mood(0);
        if (best) this.renderer.crowd.cheer(1);
        break;
      }
      default:
        break;
    }
  }

  /** 板子旁边弹一下的小字（+1、打中靶子） */
  private pop(text: string, big: boolean): void {
    this.popEl.textContent = text;
    this.popEl.className = `ch-pop show${big ? ' big' : ''}`;
    window.clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(() => {
      this.popEl.className = 'ch-pop';
    }, 700);
  }

  // ---------------------------------------------------------------- 界面

  /** 上方的计分板：这一轮的分数、本机最高分、轮到谁 */
  private renderBoard(): void {
    const who = this.multi ? `<span class="ch-who">玩家 ${this.turn + 1}</span>` : '';
    this.boardEl.innerHTML = `
      ${who}
      <span class="ch-score">${this.sim.score}</span>
      <span class="ch-best">最高 ${this.saved.best}</span>`;
  }

  private renderPanel(): void {
    const p = this.panelEl;
    const step = this.stage;
    p.hidden = false;
    const opt = (n: number) =>
      `<button class="${n === this.saved.players ? 'on' : ''}" data-players="${n}">${n} 人</button>`;
    if (step === 'ready') {
      const first = this.turn === 0;
      p.innerHTML = `
        <div class="pr-panel ch-card">
          <h2>${this.multi ? `玩家 ${this.turn + 1}` : '连续回击'}</h2>
          <p class="pr-big">教练会不停把球打过来：回进一球 1 分，漏一球（没接到、出界、下网）就结束。<br/>
          满 10 分后台上出现纸杯靶子，回球落在靶子上再加 3 分。</p>
          ${first ? `<div class="pr-setting"><span>几个人轮流打</span>${[1, 2, 3, 4].map(opt).join('')}</div>` : ''}
          <div class="pr-actions">
            <button class="primary" data-act="start">开始（A）</button>
            <a href="./"><button>返回首页</button></a>
          </div>
          ${this.multi ? '<p class="dim small">轮流用同一个手柄：一个人打完把手柄交给下一位。</p>' : ''}
        </div>`;
    } else if (step === 'done') {
      const score = this.scores[this.turn] ?? 0;
      const last = this.turn + 1 >= this.saved.players;
      p.innerHTML = `
        <div class="pr-panel ch-card">
          <h2>${this.multi ? `玩家 ${this.turn + 1} · ` : ''}这一轮</h2>
          <div class="ch-final"><b>${score}</b> 分${this.newBest ? '<span class="ch-new">新纪录!</span>' : ''}</div>
          <p class="dim">本机最高 ${this.saved.best} 分</p>
          <div class="pr-actions">
            <button class="primary" data-act="next">${last ? (this.multi ? '看排行（A）' : '再来一次（A）') : '下一位（A）'}</button>
            <a href="./"><button>返回首页</button></a>
          </div>
        </div>`;
    } else if (step === 'round') {
      const rank = this.scores
        .map((s, i) => ({ s, i }))
        .sort((a, b) => b.s - a.s)
        .map(
          (r, k) =>
            `<div class="pr-row ch-rank"><span>${k + 1}. 玩家 ${r.i + 1}</span><b>${r.s} 分</b></div>`
        )
        .join('');
      p.innerHTML = `
        <div class="pr-panel ch-card">
          <h2>这一轮的排行</h2>
          ${rank}
          <p class="dim">本机最高 ${this.saved.best} 分</p>
          <div class="pr-actions">
            <button class="primary" data-act="again">再来一轮（A）</button>
            <a href="./"><button>返回首页</button></a>
          </div>
        </div>`;
    }
    p.querySelector('[data-act="next"]')?.addEventListener('click', () => this.afterTurn());
    p.querySelector('[data-act="start"]')?.addEventListener('click', () => this.startTurn());
    p.querySelector('[data-act="again"]')?.addEventListener('click', () => this.newRound());
    p.querySelectorAll<HTMLButtonElement>('[data-players]').forEach((b) =>
      b.addEventListener('click', () => {
        this.saved.players = Number(b.dataset.players);
        save(this.saved);
        this.renderBoard();
        this.renderPanel();
      })
    );
  }

  private renderPause(): void {
    const p = this.pauseEl;
    p.hidden = !this.paused;
    if (!this.paused) return;
    p.innerHTML = `
      <div class="pr-panel">
        <h2>暂停</h2>
        <p class="dim">这一轮 ${this.sim.score} 分 · 继续后教练接着供球</p>
        <div class="pr-actions">
          <button class="primary" data-act="resume">继续（A / +）</button>
          <button data-act="restart">重新开始这一轮</button>
          <a href="./"><button>返回首页</button></a>
        </div>
      </div>`;
    p.querySelector('[data-act="resume"]')?.addEventListener('click', () => this.togglePause());
    p.querySelector('[data-act="restart"]')?.addEventListener('click', () => {
      this.paused = false;
      this.renderPause();
      this.newRound();
    });
  }
}
