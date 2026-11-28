/**
 * 连续回击：对面的教练不停用拍子把球打过来，回进一球 1 分，有一球没回好这一轮就结束（像 WSR 的 Return Challenge）。
 * 满 10 分后台上摆出纸杯靶子，回球落在靶子上再加 3 分；越往后球越难。最多 4 个人轮流用同一个手柄打，
 * 一轮打完出排行；最高分存在本机。连接、校准和发球机练习共用。
 * 开始前、打完、排行、暂停都是电视面板（摇杆 / 方向键选、A 确定、B 返回）；第一次进来先看「怎么玩」。
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
import { howToSeen, howToView } from '@/ui/tv/howto';
import { spinRow, TvOverlay, tvButton } from '@/ui/tv/TvOverlay';
import { MotionInput, type SwingEventOut } from '../input/MotionInput';
import type { PlayContext } from '../shell/context';
import { CROWD_GAIN, loadCrowdVolume } from '../shared/crowdVolume';
import { latencyMs } from '../shared/latency';
import { deviceSwingInput, HumanPaddle, keySwingInput } from '../shared/motionPlay';
import { loadPrefs } from '../shared/prefs';
import { deviceWords, SetupFlow } from '../shared/SetupFlow';
import { SettingsPanel } from '../shared/settingsView';
import type { OnlineSession, SessionMsg } from '../online/OnlineSession';

/** 远程连续回击：两边同时各打各的，比分数（连接由 PlayHost 持有；lobby = 回到远程对打的等待页） */
export interface OnlineChallenge {
  session: OnlineSession;
  lobby: () => void;
}

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
  private readonly sfx: Sfx;
  private readonly input: MotionInput;
  /** 这个页面自己的文字层、按键监听（离开时整块拿掉）；离开了就停 */
  private readonly layer: HTMLDivElement;
  private readonly abort = new AbortController();
  private disposed = false;
  private readonly paddleView = new HumanPaddle();
  private readonly setup: SetupFlow;
  private sim: ChallengeSim;
  private saved = load();
  private stage: Exclude<Step, 'setup'> = 'ready';
  private keyboard = false;
  private paused = false;
  /** 这一轮：第几位在打、每位的得分 */
  private turn = 0;
  /** 远程连续回击：对方现在的分数、打完了没有、断开了没有 */
  private peer = { score: 0, over: false, gone: false };
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
  private readonly boardEl: HTMLDivElement;
  /** 电视面板：开始前、打完、排行、暂停、设置、怎么玩 */
  private readonly tv: TvOverlay;
  private readonly settingsPanel: SettingsPanel;
  private readonly popEl: HTMLDivElement;
  private popTimer = 0;

  /** ctx：电视界面里用界面共用的画面、声音、输入，手柄已经连好；不给就自己建（直接用网址打开） */
  constructor(
    root: HTMLElement,
    private readonly ctx: PlayContext | null = null,
    private readonly online: OnlineChallenge | null = null
  ) {
    root.className = 'game-root practice challenge';
    if (ctx) {
      this.renderer = ctx.renderer;
      this.hud = ctx.hud;
      this.hud.setNames({ near: '你', far: '教练' });
      this.sfx = ctx.sfx;
      this.input = ctx.input;
      this.input.multi = false;
    } else {
      const canvas = document.createElement('canvas');
      canvas.className = 'game-canvas';
      root.appendChild(canvas);
      this.renderer = new Renderer(canvas);
      this.hud = new Hud(root, { near: '你', far: '教练' });
      this.sfx = new Sfx();
      this.input = new MotionInput();
    }
    this.layer = document.createElement('div');
    root.appendChild(this.layer);
    root = this.layer;
    this.sfx.setCrowd(0.11, 0);
    this.sfx.setCrowdLevel(CROWD_GAIN[loadCrowdVolume()]);
    this.sim = this.makeSim();
    root.insertAdjacentHTML(
      'beforeend',
      `<div class="ch-board"></div>
       <div class="ch-pop"></div>`
    );
    this.boardEl = root.querySelector('.ch-board')!;
    this.popEl = root.querySelector('.ch-pop')!;
    this.tv = new TvOverlay(root, (k) => this.sfx.ui(k));
    this.settingsPanel = new SettingsPanel(
      {
        sfx: this.sfx,
        input: this.input,
        players: 1,
        onChange: (p) => {
          this.sim.player.handed = p.handed[0];
          this.sim.clampLeniency(p.leniency);
        },
        onBack: () => this.renderPause(),
      },
      this.tv
    );
    this.setup = new SetupFlow(this.tv, this.input, this.hud, this.sfx, {
      title: '连续回击',
      keyboardHelp: 'F 正手、J 反手，按键时机 = 击球时机。',
      onDone: (msg) => this.afterSetup(msg),
      onKeyboard: () => {
        this.keyboard = true;
        this.afterSetup('键盘：F 正手、J 反手');
      },
      onBack: () => this.exit(),
    });
    this.input.events = {
      onSwing: (e) => this.onDeviceSwing(e),
      onPeak: (e) => this.sim.refineSwing(e.peak.id, e.peak.w, e.features),
      onButton: (b, down) => down && this.onButton(b),
      onNav: (dir, down) => this.tv.navInput(dir, down),
      onCalibrate: (_d, result) => this.setup.onCalibrate(result),
      onDevicesChanged: () => this.setup.render(),
      onLinkStatus: () => this.setup.linkChanged(),
    };
    const signal = this.abort.signal;
    window.addEventListener(
      'keydown',
      (e) => {
        this.keysDown.add(e.key.toLowerCase());
        this.onKey(e);
      },
      { signal }
    );
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.key.toLowerCase()), { signal });
    window.addEventListener('pointerdown', () => this.sfx.unlock(), { signal });
    // 电视界面里手柄已经加入、定过方向（或是键盘玩家，开发用）：直接到「按 A 开始」
    if (ctx && ctx.players[0]?.device === null) {
      this.setup.skip();
      this.keyboard = true;
      this.begin();
    } else if (ctx && this.setup.skipIfReady()) this.begin();
    else this.setup.render();
    void this.input.start().then(() => this.setup.render());
    if (online) {
      online.session.onMessage = (m) => this.onOnline(m);
      online.session.onStatus = () => {
        const st = online.session.status;
        if (st === 'closed' || st === 'failed') {
          this.peer.gone = true;
          this.hud.flash('对方断开了', '你可以打完这一轮', 1.6, 'bad');
          if (this.stage === 'done') this.renderPanel();
        }
      };
    }
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
      leniency: loadPrefs().leniency,
      tune: tuning,
    });
    sim.pause(true);
    return sim;
  }

  // ---------------------------------------------------------------- 主循环

  /** 回到菜单（电视界面）或首页（直接用网址打开时） */
  private exit(): void {
    if (this.ctx) this.ctx.exit();
    else location.href = './';
  }

  /** 离开连续回击（回到电视菜单）：停下主循环，拿掉文字层和按键监听 */
  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.layer.remove();
    this.hud.clearFlash();
    this.sfx.setCrowdOn(false);
  }

  private loop(): void {
    if (this.disposed) return;
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
    if (this.tv.key(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'escape' || k === 'p') {
      this.togglePause();
      return;
    }
    if (e.repeat || this.step !== 'run' || this.paused) return;
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
    if (this.setup.onButton(b)) return;
    // 面板上：A 确定、B 返回；暂停里再按 + 继续
    if (this.tv.visible) {
      if (b === 'confirm') this.tv.confirm();
      else if (b === 'back') this.tv.back();
      else if (b === 'pause' && this.paused) this.togglePause();
      return;
    }
    if (b === 'pause') {
      this.togglePause();
      return;
    }
    if (b === 'recenter' && this.step === 'run' && !this.paused) {
      const head = deviceWords(this.input.active).head;
      if (this.input.recenter()) this.hud.flash('已回中', '', 0.8);
      else this.hud.flash('没能回中', `把${head}像遥控器一样指向电视再按`, 1.4, 'bad');
    }
  }

  // ---------------------------------------------------------------- 流程

  private afterSetup(msg: string): void {
    this.hud.flash(msg, '', 1.2, 'good');
    this.begin();
  }

  /** 准备好了：第一次玩先看「怎么玩」；远程的两边已经在等待页准备好了，直接一起开打 */
  private begin(): void {
    if (this.online) this.startOnline();
    else if (howToSeen('challenge')) this.newRound();
    else this.tv.show(howToView('challenge', () => this.newRound()));
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
    this.tv.hide();
    this.sim.pause(false);
    this.hud.flash(
      this.multi ? `玩家 ${this.turn + 1}` : '开始',
      this.online ? '和对方同时打，比谁的分高' : '回一球 1 分，漏一球就结束',
      1.4
    );
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
    this.sendScore(true);
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
    return !this.online && this.saved.players > 1;
  }

  // ---------------------------------------------------------------- 远程

  /** 两边同时开打 */
  private startOnline(): void {
    this.peer = { score: 0, over: false, gone: this.peer.gone };
    this.turn = 0;
    this.scores = [];
    this.stage = 'ready';
    this.sim = this.makeSim();
    this.startTurn();
  }

  private onOnline(m: SessionMsg): void {
    const on = this.online!;
    if (m.k === 'cscore') {
      this.peer.score = m.score;
      this.peer.over = m.over;
      this.renderBoard();
      if (this.stage === 'done') this.renderPanel();
    } else if (m.k === 'start' && on.session.role === 'guest') {
      if (m.game === 'challenge') this.startOnline();
    } else if (m.k === 'lobby') on.lobby();
  }

  /** 把自己的分数告诉对方 */
  private sendScore(over: boolean): void {
    this.online?.session.send({ k: 'cscore', score: this.sim.score, over });
  }

  /** 远程连续回击打完：等对方，或两边的分数比一比 */
  private renderOnlinePanel(): void {
    const on = this.online!;
    const me = this.scores[0] ?? 0;
    const host = on.session.role === 'host';
    if (!this.peer.over && !this.peer.gone) {
      this.tv.show({
        html: `<h2>你打完了</h2><div class="tv-score"><b>${me}</b>分</div>
          <p class="tv-note">等对方打完…（对方现在 ${this.peer.score} 分）</p>
          <div class="tv-buttons">${tvButton('home', '回到菜单')}</div>`,
        hints: [['B', '回到菜单']],
        onBack: () => this.exit(),
        onAct: () => this.exit(),
      });
      return;
    }
    const them = this.peer.score;
    const title = me === them ? '平局' : me > them ? '你赢了！' : '对方赢了';
    this.tv.show({
      html: `<h2 class="tv-result ${me > them ? 'win' : me < them ? 'lose' : ''}">${title}</h2>
        <div class="tv-score">你 <b>${me}</b>:<b>${them}</b> 对方</div>
        ${this.peer.gone ? '<p class="tv-note">对方断开了</p>' : host ? '' : '<p class="tv-note">等对方选下一局</p>'}
        <div class="tv-buttons tv-inline">
          ${host && !this.peer.gone ? tvButton('again', '再来一次', true, true) + tvButton('lobby', '换玩法') : ''}
          ${tvButton('home', '回到菜单', !host || this.peer.gone, !host || this.peer.gone)}
        </div>`,
      hints: [
        ['A', '确定'],
        ['B', '回到菜单'],
      ],
      onBack: () => this.exit(),
      onAct: (act) => {
        if (act === 'again') {
          on.session.send({ k: 'start', points: 6, game: 'challenge' });
          this.startOnline();
        } else if (act === 'lobby') {
          on.session.send({ k: 'lobby' });
          on.lobby();
        } else this.exit();
      },
    });
  }

  private togglePause(): void {
    if (this.step !== 'run' || this.sim.over) return;
    this.paused = !this.paused;
    this.renderPause();
  }

  private restartRound(): void {
    this.paused = false;
    this.newRound();
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
        this.sendScore(false);
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
    const right = this.online
      ? `对方 ${this.peer.score}${this.peer.over ? '（打完了）' : ''}`
      : `最高 ${this.saved.best}`;
    this.boardEl.innerHTML = `
      ${who}
      <span class="ch-score">${this.sim.score}</span>
      <span class="ch-best">${right}</span>`;
  }

  /** 开始前（几个人轮流）、这一位打完、这一轮的排行 */
  private renderPanel(keep = false): void {
    const step = this.stage;
    const best = `<p class="tv-note">本机最高 ${this.saved.best} 分</p>`;
    if (step === 'ready') {
      const first = this.turn === 0;
      const n = this.saved.players;
      this.tv.show(
        {
          html: `
          <h2>${this.multi ? `玩家 ${this.turn + 1}` : '连续回击'}</h2>
          ${best}
          ${first ? spinRow('players', '几个人轮流', `${n} 人`) : '<p class="tv-note">把手柄交给这一位</p>'}
          <div class="tv-buttons">
            ${tvButton('start', '开始', true, true)}
            ${first ? tvButton('howto', '怎么玩') : ''}
            ${tvButton('home', '回到菜单')}
          </div>`,
          hints: first
            ? [
                ['◀▶', '几个人'],
                ['A', '开始'],
                ['B', '回到菜单'],
              ]
            : [
                ['A', '开始'],
                ['B', '回到菜单'],
              ],
          onBack: () => this.exit(),
          onSpin: (_name, d) => {
            this.saved.players = ((n - 1 + d + 4) % 4) + 1;
            save(this.saved);
            this.renderBoard();
            this.renderPanel(true);
          },
          onAct: (act) => {
            if (act === 'start') this.startTurn();
            else if (act === 'howto')
              this.tv.show(howToView('challenge', () => this.renderPanel()));
            else if (act === 'home') this.exit();
          },
        },
        keep
      );
    } else if (step === 'done' && this.online) {
      this.renderOnlinePanel();
    } else if (step === 'done') {
      const score = this.scores[this.turn] ?? 0;
      const last = this.turn + 1 >= this.saved.players;
      this.tv.show({
        html: `
          <h2>${this.multi ? `玩家 ${this.turn + 1}` : '这一轮'}</h2>
          <div class="tv-score"><b>${score}</b>分</div>
          ${this.newBest ? '<p class="tv-note"><span class="tv-tag gold">新纪录!</span></p>' : best}
          <div class="tv-buttons tv-inline">
            ${tvButton('next', last ? (this.multi ? '看排行' : '再来一次') : '下一位', true, true)}
            ${tvButton('home', '回到菜单')}
          </div>`,
        hints: [
          ['A', '确定'],
          ['B', '回到菜单'],
        ],
        onBack: () => this.exit(),
        onAct: (act) => {
          if (act === 'next') this.afterTurn();
          else if (act === 'home') this.exit();
        },
      });
    } else if (step === 'round') {
      const rank = this.scores
        .map((s, i) => ({ s, i }))
        .sort((a, b) => b.s - a.s)
        .map((r, k) => `<div><span>${k + 1}. 玩家 ${r.i + 1}</span><b>${r.s} 分</b></div>`)
        .join('');
      this.tv.show({
        html: `
          <h2>这一轮的排行</h2>
          <div class="tv-stats">${rank}</div>
          ${best}
          <div class="tv-buttons tv-inline">
            ${tvButton('again', '再来一轮', true, true)}
            ${tvButton('home', '回到菜单')}
          </div>`,
        hints: [
          ['A', '确定'],
          ['B', '回到菜单'],
        ],
        onBack: () => this.exit(),
        onAct: (act) => {
          if (act === 'again') this.newRound();
          else if (act === 'home') this.exit();
        },
      });
    }
  }

  /** 暂停：继续、重新开始这一轮、设置、怎么玩、回到菜单 */
  private renderPause(): void {
    if (!this.paused) {
      this.tv.hide();
      return;
    }
    this.tv.show({
      html: `
        <h2>暂停</h2>
        <p class="tv-note">这一轮 ${this.sim.score} 分 · 继续后教练接着供球</p>
        <div class="tv-buttons">
          ${tvButton('resume', '继续', true, true)}
          ${tvButton('restart', '重新开始这一轮')}
          ${tvButton('settings', '设置')}
          ${tvButton('howto', '怎么玩')}
          ${tvButton('home', '回到菜单')}
        </div>`,
      hints: [
        ['A', '确定'],
        ['B', '继续'],
      ],
      onBack: () => this.togglePause(),
      onAct: (act) => {
        if (act === 'resume') this.togglePause();
        else if (act === 'restart') this.restartRound();
        else if (act === 'settings') this.settingsPanel.show();
        else if (act === 'howto') this.tv.show(howToView('challenge', () => this.renderPause()));
        else if (act === 'home') this.exit();
      },
    });
  }
}
