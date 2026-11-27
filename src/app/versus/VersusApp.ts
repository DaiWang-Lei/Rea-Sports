/**
 * 双人分屏对打：左半屏 1P（近端），右半屏 2P（远端），各拿一个手柄（Joy-Con 或手机，Joy-Con L 也能当球拍）。
 * 进来先加入：拿着手柄、拍头像遥控器一样指向电视按 A（加入的同时定好电视方向），谁先按谁是 1P；
 * 两人到齐后按 A 开始。比赛和「和电脑对打」一样：轮到谁发球谁按 A 或向上抖手柄抛球，比分只在两分之间显示。
 * 任何一人暂停（+）或手柄断开，这一分作废，继续后重打；断开的手柄重新连上后按 A 回到原来的位置。
 * 加入页、暂停、结算时可以换成 1 人（和电脑对打，见 PlayHost），手柄不用重连。
 */
import '../practice/practice.css';
import '../match/match.css';
import './versus.css';
import QRCode from 'qrcode';
import { tuning } from '@/config/tuning';
import type { TossEvent } from '@/input/paddle/TossDetector';
import type { Side } from '@/sim/constants';
import { type MatchEvent, MatchSim } from '@/sim/MatchSim';
import { type PointReason, REASON_TEXT } from '@/sim/rally/Referee';
import type { GameView } from '../GameView';
import type { CalibrateResult, InputDevice, MotionInput } from '../input/MotionInput';
import type { PlayHost } from '../PlayHost';
import { bindCrowd, crowdRow } from '../shared/crowdVolume';
import { latencyMs, screenKey, setLatencyMs } from '../shared/latency';
import { median, serveText, strokeText, timingText, WHIFF_TEXT } from '../shared/matchText';
import { deviceSwingInput, HumanPaddle } from '../shared/motionPlay';
import { playersRow } from '../shared/players';
import { deviceWords } from '../shared/SetupFlow';

const SIDES = ['near', 'far'] as const;
const TAG: Record<Side, string> = { near: '1P', far: '2P' };

interface Settings {
  points: 6 | 11;
  leniency: number;
  /** 击球后在自己的半屏小字提示时机 */
  timingHint: boolean;
  handed: Record<Side, 1 | -1>;
}

const SETTINGS_KEY = 'rea-versus';

function loadSettings(): Settings {
  const def: Settings = {
    points: 6,
    leniency: 0.6,
    timingHint: true,
    handed: { near: 1, far: 1 },
  };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    return {
      points: s?.points === 11 ? 11 : 6,
      leniency: s?.leniency ?? def.leniency,
      timingHint: s?.timingHint ?? def.timingHint,
      handed: { near: s?.handed?.near === -1 ? -1 : 1, far: s?.handed?.far === -1 ? -1 : 1 },
    };
  } catch {
    return def;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 不保存
  }
}

/** lobby = 加入、选分制；play = 比赛中（含暂停）；over = 结算 */
type Step = 'lobby' | 'play' | 'over';

interface PlayerLog {
  /** 回球（不含发球）的时机偏差（毫秒） */
  timings: number[];
  hits: number;
  serves: number;
  whiffs: Record<string, number>;
}

interface GameLog {
  points: { winner: Side; reason: PointReason; rallyHits: number }[];
  players: Record<Side, PlayerLog>;
}

const newPlayerLog = (): PlayerLog => ({ timings: [], hits: 0, serves: 0, whiffs: {} });
const newGameLog = (): GameLog => ({
  points: [],
  players: { near: newPlayerLog(), far: newPlayerLog() },
});

/** 每半屏自己的小字：时机（击球后）、怎么抛球（轮到自己发球时） */
interface Half {
  timing: HTMLDivElement;
  hint: HTMLDivElement;
  timer: number;
  hintText: string;
}

export class VersusApp {
  private readonly view: GameView;
  private readonly input: MotionInput;
  /** 这个模式自己的文字层（分屏线、半屏小字、面板），换模式时整块拿掉 */
  private readonly layer: HTMLDivElement;
  private readonly abort = new AbortController();
  private disposed = false;
  /** 画面上两人的球拍（挥拍开始、结束时平滑过渡） */
  private readonly paddleViews = { near: new HumanPaddle(), far: new HumanPaddle() };
  private sim: MatchSim;
  private settings = loadSettings();
  private step: Step = 'lobby';
  /** 1P（近端）、2P（远端）拿的手柄 */
  private readonly slots: Record<Side, InputDevice | null> = { near: null, far: null };
  private paused = false;
  /** device = 有人的手柄断开（或没有数据）时自动暂停 */
  private pauseReason: 'user' | 'device' = 'user';
  private game: GameLog = newGameLog();

  // 时间换算：输入（performance.now 毫秒）↔ 仿真时间
  private clockSim = 0;
  private clockReal = 0;
  private last = performance.now();
  private lostSince = NaN;
  private resultsAt = NaN;
  /** 加入页上显示的状态（变了才重画） */
  private lobbyShown = '';
  private lastLobbyCheck = 0;

  // DOM
  private readonly panelEl: HTMLDivElement;
  private readonly pauseEl: HTMLDivElement;
  private readonly halves: Record<Side, Half>;

  constructor(private readonly host: PlayHost) {
    host.root.className = 'game-root practice match versus';
    this.input = host.input;
    this.input.multi = true;
    this.view = host.view;
    this.sim = this.makeSim();
    this.view.configure({
      names: { near: TAG.near, far: TAG.far },
      split: true,
      nearPaddle: (t, body) => this.paddle('near', t, body),
      farPaddle: (t, body) => this.paddle('far', t, body),
      onEvent: (e) => this.onMatchEvent(e),
    });
    this.view.setSim(this.sim);
    // 从和电脑对打切过来：远端换回首页选的人物，看台坐满
    this.view.renderer.resetAvatar('far');
    this.view.renderer.crowd.setFill(1);
    const root = (this.layer = document.createElement('div'));
    host.root.appendChild(root);
    root.insertAdjacentHTML(
      'beforeend',
      `<div class="vs-divider"></div>
       ${SIDES.map(
         (s) => `<div class="vs-half ${s}">
           <div class="vs-tag">${TAG[s]}</div>
           <div class="mt-timing"></div>
           <div class="vs-hint"></div>
         </div>`
       ).join('')}
       <div class="pr-overlay mt-panel"></div>
       <div class="pr-pause" hidden></div>`
    );
    this.panelEl = root.querySelector('.mt-panel')!;
    this.pauseEl = root.querySelector('.pr-pause')!;
    const half = (s: Side): Half => {
      const el = root.querySelector(`.vs-half.${s}`)!;
      return {
        timing: el.querySelector('.mt-timing')!,
        hint: el.querySelector('.vs-hint')!,
        timer: 0,
        hintText: '',
      };
    };
    this.halves = { near: half('near'), far: half('far') };

    this.input.events = {
      onSwing: (e) => {
        const side = this.sideOf(e.device);
        if (!side || !this.playing) return;
        this.sim.humanSwing(
          side,
          deviceSwingInput(e, (ms) => this.simAt(ms), latencyMs())
        );
      },
      onPeak: (e) => {
        const side = this.sideOf(e.device);
        if (side) this.sim.humanRefine(side, e.peak.id, e.peak.w, e.features);
      },
      onToss: (d, toss) => {
        const side = this.sideOf(d);
        if (side && this.playing) this.toss(side, toss.height, toss);
      },
      onButton: (b, down, d) => down && this.onButton(b, d),
      onCalibrate: (d, result) => this.onCalibrate(d, result),
      onDevicesChanged: () => this.onDevicesChanged(),
      onLinkStatus: () => this.renderLobby(true),
    };
    window.addEventListener('keydown', (e) => this.onKey(e), { signal: this.abort.signal });
    // 从 1 人切过来：正在用的手柄直接当 1P（定过电视方向就不用再定）
    const d = this.input.active;
    if (d && this.streaming(d)) this.join(d, false);
    this.renderLobby(true);
    void this.input.start().then(() => this.renderLobby(true));
    // 冒烟测试 / 调试用：?debug=1 时把实例挂到 window 上
    if (new URLSearchParams(location.search).has('debug')) {
      (window as unknown as { __versus: VersusApp }).__versus = this;
    }
    requestAnimationFrame(() => this.loop());
  }

  /** 换模式：这一局作废，拿掉自己的文字层和按键监听 */
  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const s of SIDES) window.clearTimeout(this.halves[s].timer);
    this.layer.remove();
  }

  /** 调试：当前比赛状态（冒烟测试读取） */
  debugState(): {
    step: Step;
    paused: boolean;
    phase: string;
    slots: Record<Side, string | null>;
    score: Record<Side, number>;
    rallyHits: number;
    result: string | null;
    sides: Record<
      Side,
      {
        canToss: boolean;
        serveAt: number | null;
        awaiting: boolean;
        planT: number | null;
        stance: string;
        hits: number;
        serves: number;
      }
    >;
  } {
    const s = this.sim;
    const side = (x: Side) => {
      const h = s.human(x)!;
      return {
        canToss: h.canToss(s),
        serveAt: h.serveAt?.ideal ?? null,
        awaiting: h.awaitingSwing,
        planT: h.plan?.t ?? null,
        stance: s.players[x].stance,
        hits: this.game.players[x].hits,
        serves: this.game.players[x].serves,
      };
    };
    return {
      step: this.step,
      paused: this.paused,
      phase: s.phase.kind,
      slots: { near: this.slots.near?.key ?? null, far: this.slots.far?.key ?? null },
      score: { ...s.scoring.score },
      rallyHits: s.rallyHits,
      result: s.result,
      sides: { near: side('near'), far: side('far') },
    };
  }

  private get playing(): boolean {
    return this.step === 'play' && !this.paused;
  }

  private makeSim(): MatchSim {
    const s = this.settings;
    return new MatchSim({
      seed: Math.floor(Math.random() * 1e9),
      points: s.points,
      handed: { ...s.handed },
      leniency: s.leniency,
      tune: tuning,
    });
  }

  private paddle(side: Side, t: number, body: { x: number; y: number }) {
    return this.paddleViews[side].pose(
      this.slots[side]?.paddle ?? null,
      this.sim.players[side],
      body,
      t
    );
  }

  private sideOf(d: InputDevice): Side | null {
    return SIDES.find((s) => this.slots[s] === d) ?? null;
  }

  // ---------------------------------------------------------------- 主循环

  private loop(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    const playing = this.playing;
    // 等球时自动校正电视方向；轮到谁发球就识别谁向上抖手柄
    this.input.autoHeading = playing;
    this.input.tossEnabled = playing && SIDES.some((s) => this.sim.human(s)!.canToss(this.sim));
    this.view.paused = !playing;
    this.view.frame(dt);
    // 回放是全屏一个画面：分屏线和两边的小字先藏起来
    this.layer.classList.toggle('replaying', this.view.replaying);
    this.clockSim = this.sim.t;
    this.clockReal = now - this.view.lag * 1000;
    this.checkDevices(now);
    for (const s of SIDES) this.updateHint(s);
    if (this.step === 'lobby' && now - this.lastLobbyCheck > 300) {
      this.lastLobbyCheck = now;
      this.renderLobby();
    }
    if (this.step === 'play' && this.sim.phase.kind === 'gameOver') {
      if (Number.isNaN(this.resultsAt)) this.resultsAt = now + 2500;
      else if (now >= this.resultsAt) this.showResults();
    }
    requestAnimationFrame(() => this.loop());
  }

  private simAt(ms: number): number {
    return this.clockSim + (ms - this.clockReal) / 1000;
  }

  private streaming(d: InputDevice | null): boolean {
    return !!d && performance.now() - d.lastSampleAt < 800;
  }

  /** 有人的手柄断开、或超过 0.3 秒没有数据：自动暂停（这一分作废） */
  private checkDevices(now: number): void {
    if (!this.playing || SIDES.every((s) => this.streaming(this.slots[s]))) {
      this.lostSince = NaN;
      return;
    }
    if (Number.isNaN(this.lostSince)) this.lostSince = now;
    else if (now - this.lostSince > 300) this.pause('device');
  }

  /** 轮到这一边发球时，在这一边的半屏下方提示怎么抛球 */
  private updateHint(side: Side): void {
    const h = this.halves[side];
    const can = this.playing && this.sim.human(side)!.canToss(this.sim);
    const w = deviceWords(this.slots[side]);
    const text = can
      ? w.phone
        ? `按手机上的${w.confirm}或向上抖手机抛球，球落下时挥拍`
        : `按 ${w.confirm} 或向上抖手柄抛球，球落下时挥拍`
      : '';
    if (text === h.hintText) return;
    h.hintText = text;
    h.hint.textContent = text;
    h.hint.classList.toggle('visible', !!text);
  }

  // ---------------------------------------------------------------- 输入

  private onButton(b: string, d: InputDevice): void {
    this.view.sfx.unlock();
    if (b === 'players' && (this.step !== 'play' || this.paused)) {
      this.host.switchTo('match');
      return;
    }
    const side = this.sideOf(d);
    if (!side) {
      // 还没加入的手柄：加入页、或有人断开的暂停里按确认就加入
      if (b === 'confirm' && this.canJoin) this.join(d, true);
      return;
    }
    const step = this.step;
    if (step === 'lobby') {
      if (b === 'back') this.leave(side);
      else if (b === 'recenter') this.input.requestCalibration(d);
      else if (b === 'confirm') {
        if (this.bothJoined) this.startGame();
        else this.input.requestCalibration(d);
      }
      return;
    }
    if (step === 'over') {
      if (b === 'confirm') this.startGame();
      else if (b === 'back') this.showLobby();
      return;
    }
    if (b === 'pause') {
      this.togglePause();
      return;
    }
    if (this.paused) {
      if (b === 'confirm') this.resume();
      return;
    }
    // A：正在回放（或马上要回放）就跳过
    if (b === 'confirm' && this.view.skipReplay()) return;
    if (b === 'recenter') {
      this.input.requestCalibration(d);
      return;
    }
    // A：轮到自己发球时抛球；两分之间跳过停顿
    if (b === 'confirm' && !this.toss(side, this.sim.tune.serve.buttonTossHeight)) {
      this.sim.skipBetweenPoints();
    }
  }

  private onKey(e: KeyboardEvent): void {
    this.view.sfx.unlock();
    const k = e.key.toLowerCase();
    if (k === 'escape' || k === 'p') {
      if (this.step === 'play') this.togglePause();
    } else if (k === 'enter' || k === ' ') {
      if (this.step === 'play' && !this.paused) this.view.skipReplay();
      else if (k === ' ') return;
      else if (this.step === 'lobby' && this.bothJoined) this.startGame();
      else if (this.step === 'over') this.startGame();
    }
  }

  /** 校准 / 回中（加入时、按 Y、按住 X + ZR）：没加入的手柄按组合键也算加入 */
  private onCalibrate(d: InputDevice, result: CalibrateResult): void {
    let side = this.sideOf(d);
    if (!side && this.canJoin) side = this.join(d, false);
    if (!side) return;
    const w = deviceWords(d);
    if (result === 'done') {
      this.view.sfx.beep(1040, 0.1);
      this.note(side, this.step === 'lobby' ? '已定好电视方向' : '已回中', true);
    } else {
      this.note(side, `${w.head}别朝上或朝下，像遥控器一样指向电视再按`, true);
    }
    if (this.step === 'lobby') this.renderLobby(true);
  }

  private onDevicesChanged(): void {
    // 断开的手柄让出位置：重新连上后是一个新设备，按 A 回到空出来的位置
    for (const s of SIDES) {
      const d = this.slots[s];
      if (d && !this.input.devices.has(d.key)) this.slots[s] = null;
    }
    if (this.step === 'play' && !this.bothJoined) this.pause('device');
    if (this.step === 'lobby') this.renderLobby(true);
    if (this.paused) this.renderPause();
  }

  private get bothJoined(): boolean {
    return !!(this.slots.near && this.slots.far);
  }

  private get canJoin(): boolean {
    return this.step === 'lobby' || (this.step === 'play' && this.paused);
  }

  /** 加入空着的位置（1P 先）；calibrate = 同时按指向电视定方向 */
  private join(d: InputDevice, calibrate: boolean): Side | null {
    const side = SIDES.find((s) => !this.slots[s]);
    if (!side) return null;
    this.slots[side] = d;
    d.paddle.handed = this.settings.handed[side];
    this.view.sfx.beep(880, 0.08);
    if (calibrate) this.input.requestCalibration(d);
    if (this.step === 'lobby') this.renderLobby(true);
    if (this.paused) this.renderPause();
    return side;
  }

  private leave(side: Side): void {
    this.slots[side] = null;
    this.renderLobby(true);
  }

  /** 抛球：按键（固定高度）或向上抖手柄（按力度定高度）。不是自己发球时返回 false */
  private toss(side: Side, height: number, toss?: TossEvent): boolean {
    const ok = this.sim.humanToss(side, height);
    if (ok && toss) {
      this.note(side, `抛球：抖手柄 ${toss.peakG.toFixed(1)}G，抛高 ${Math.round(height * 100)}cm`);
    }
    return ok;
  }

  // ---------------------------------------------------------------- 流程

  private showLobby(): void {
    this.step = 'lobby';
    this.paused = false;
    this.pauseEl.hidden = true;
    this.renderLobby(true);
  }

  private startGame(): void {
    this.sim = this.makeSim();
    this.view.setSim(this.sim);
    this.game = newGameLog();
    this.step = 'play';
    this.paused = false;
    this.resultsAt = NaN;
    this.panelEl.hidden = true;
    this.pauseEl.hidden = true;
    this.view.hud.flash(`${this.settings.points} 分制`, '1P 先发球', 1.6);
  }

  private showResults(): void {
    this.step = 'over';
    this.resultsAt = NaN;
    this.renderResults();
  }

  private togglePause(): void {
    if (this.paused) this.resume();
    else this.pause('user');
  }

  private pause(reason: 'user' | 'device'): void {
    if (this.step !== 'play' || this.paused) return;
    this.paused = true;
    this.pauseReason = reason;
    // 正在发球或对打：这一分作废，继续后重打
    this.sim.interruptPoint();
    this.renderPause();
  }

  private resume(): void {
    if (!this.paused) return;
    const lost = SIDES.filter((s) => !this.streaming(this.slots[s]));
    if (lost.length) {
      const who = lost.map((s) => TAG[s]).join('、');
      this.view.hud.flash(`${who} 的手柄还没连上`, '重新连上后按 A 加入，再继续', 1.6, 'bad');
      return;
    }
    this.paused = false;
    this.renderPause();
  }

  private setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings[key] = value;
    saveSettings(this.settings);
    if (key === 'leniency') {
      for (const s of SIDES) this.sim.human(s)!.leniency = value as number;
    }
    if (this.step === 'lobby') this.renderLobby(true);
    if (this.paused) this.renderPause();
  }

  private setHanded(side: Side, h: 1 | -1): void {
    this.setSetting('handed', { ...this.settings.handed, [side]: h });
    const d = this.slots[side];
    if (d) d.paddle.handed = h;
    this.sim.players[side].handed = h;
  }

  // ---------------------------------------------------------------- 比赛事件

  private onMatchEvent(e: MatchEvent): void {
    switch (e.type) {
      case 'toss':
        this.input.rumble('toss', this.slots[e.side]);
        break;
      case 'hit': {
        this.input.rumble(
          e.smash || e.powerServe ? 'smash' : e.oops ? 'oops' : 'hit',
          this.slots[e.side]
        );
        if (!e.human) break;
        const p = this.game.players[e.side];
        if (e.serve) {
          p.serves++;
          this.note(e.side, serveText(e.human, !!e.powerServe));
        } else {
          p.hits++;
          p.timings.push(e.human.timingMs);
          this.note(e.side, strokeText(e.human, e.kind));
        }
        break;
      }
      case 'whiff': {
        if (!e.reason) break;
        const p = this.game.players[e.side];
        p.whiffs[e.reason] = (p.whiffs[e.reason] ?? 0) + 1;
        if (e.reason === 'volley') {
          this.note(e.side, `未落台击球 · ${timingText(e.timingMs ?? 0)}`);
        } else {
          const t = e.reason === 'reach' ? '够不着' : `挥空 · ${timingText(e.timingMs ?? 0)}`;
          this.note(e.side, `${e.serve ? `发球${t}` : t}${e.serve ? '，球落下后再抛一次' : ''}`);
        }
        break;
      }
      case 'point':
        this.game.points.push({ winner: e.winner, reason: e.reason, rallyHits: e.rallyHits });
        break;
      default:
        break;
    }
  }

  /** 这一边半屏下方的小字；时机提示可以在设置里关，force（校准结果）总是显示 */
  private note(side: Side, text: string, force = false): void {
    if (!force && !this.settings.timingHint) return;
    const h = this.halves[side];
    h.timing.textContent = text;
    h.timing.classList.add('show');
    window.clearTimeout(h.timer);
    h.timer = window.setTimeout(() => h.timing.classList.remove('show'), 2000);
  }

  // ---------------------------------------------------------------- 界面

  private opt<T extends string | number | boolean>(
    name: string,
    value: T,
    cur: T,
    text: string
  ): string {
    return `<button class="${value === cur ? 'on' : ''}" data-set="${name}" data-val="${value}">${text}</button>`;
  }

  /** 面板里的「1 人 / 2 人」按钮 */
  private bindPlayers(el: HTMLElement): void {
    el.querySelector('[data-players="1"]')?.addEventListener('click', () =>
      this.host.switchTo('match')
    );
  }

  /** 把面板里的 data-set 按钮接到设置上 */
  private bindSettings(el: HTMLElement): void {
    el.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((b) =>
      b.addEventListener('click', () => {
        const name = b.dataset.set!;
        const raw = b.dataset.val!;
        if (name === 'handed-near' || name === 'handed-far') {
          this.setHanded(name === 'handed-near' ? 'near' : 'far', raw === '-1' ? -1 : 1);
        } else if (name === 'timingHint') {
          this.setSetting('timingHint', raw === 'true');
        } else if (name === 'points') {
          this.setSetting('points', raw === '11' ? 11 : 6);
        } else if (name === 'leniency') {
          this.setSetting('leniency', Number(raw));
        }
      })
    );
  }

  /** 一个位置的状态：谁的手柄、有没有数据、定没定电视方向 */
  private slotText(side: Side): string {
    const d = this.slots[side];
    if (!d) return '<span class="dim">等待加入</span>';
    const w = deviceWords(d);
    const issue = !this.streaming(d)
      ? '没有数据'
      : !d.paddle.calibrated
        ? `还没定电视方向（指向电视按 ${w.confirm}）`
        : '';
    return `<b>${d.name}</b>${issue ? `<br/><span class="warn">${issue}</span>` : '<br/><span class="ok">准备好了</span>'}`;
  }

  /** 加入页：两个位置、连手柄、分制；状态变了才重画（force = 一定重画） */
  private renderLobby(force = false): void {
    if (this.step !== 'lobby') return;
    const waiting = [...this.input.devices.values()].filter((d) => !this.sideOf(d));
    const shown = JSON.stringify([
      SIDES.map((s) => this.slotText(s)),
      waiting.map((d) => d.name),
      this.settings.points,
    ]);
    if (!force && shown === this.lobbyShown) return;
    this.lobbyShown = shown;
    const p = this.panelEl;
    p.hidden = false;
    const s = this.settings;
    const both = this.bothJoined;
    p.innerHTML = `
      <div class="pr-panel vs-lobby">
        <h2>双人对打</h2>
        ${playersRow(2)}
        <div class="vs-slots">
          ${SIDES.map(
            (x) => `
            <div class="vs-slot ${x}${this.slots[x] ? ' joined' : ''}">
              <div class="vs-slot-tag">${TAG[x]}<span class="dim small">${x === 'near' ? '左半屏' : '右半屏'}</span></div>
              <div>${this.slotText(x)}</div>
            </div>`
          ).join('')}
        </div>
        <p class="pr-big">${
          both
            ? '两人都到齐了，按 A 开始'
            : '拿着手柄，拍头像遥控器一样<b>指向电视</b>，按 A 加入（Joy-Con L 按 →，手机按「确认」）'
        }</p>
        ${waiting.length ? `<p class="dim">已连接、还没加入：${waiting.map((d) => d.name).join('、')}</p>` : ''}
        <div class="pr-setting"><span>分制</span>${this.opt('points', 6, s.points, '6 分')}${this.opt('points', 11, s.points, '11 分（球更快）')}</div>
        <div class="pr-actions">
          <button class="primary" data-act="start" ${both ? '' : 'disabled'}>开始（A）</button>
          <a href="./"><button>返回首页</button></a>
        </div>
        <div class="pr-connect vs-connect">
          <div class="pr-box">
            <h3>连 Joy-Con</h3>
            <p class="dim small">先在系统蓝牙里配对。一次选一只，两只就点两次；一对拆开用时，左边那只（L）也能当球拍。</p>
            <button data-act="joycon" ${this.input.webHidSupported ? '' : 'disabled'}>连接 Joy-Con</button>
          </div>
          <div class="pr-box">
            <h3>连手机</h3>
            <canvas class="pr-qr" width="132" height="132"></canvas>
            <div class="pr-link ${this.input.linkStatus.ok ? 'ok' : 'warn'}">● ${this.input.linkStatus.text}</div>
            ${this.input.room ? `<div class="pr-room">房间号 ${this.input.room}</div>` : ''}
          </div>
        </div>
        <p class="dim small">两个人站开一点，握紧手柄、最好挂上腕带。人物在首页选：1P 用「你」，2P 用「对手」。换成 1 人：Joy-Con X（L 按 ←）。</p>
      </div>`;
    const qr = p.querySelector<HTMLCanvasElement>('.pr-qr');
    if (qr && this.input.phoneUrl) {
      void QRCode.toCanvas(qr, this.input.phoneUrl, { width: 132, margin: 1 });
    }
    this.bindSettings(p);
    this.bindPlayers(p);
    p.querySelector('[data-act="start"]')?.addEventListener('click', () => {
      if (this.bothJoined) this.startGame();
    });
    p.querySelector('[data-act="joycon"]')?.addEventListener('click', () => {
      void this.input.requestJoyCon().catch(() => {});
    });
  }

  private renderResults(): void {
    const p = this.panelEl;
    p.hidden = false;
    const sim = this.sim;
    const g = this.game;
    const { near, far } = sim.scoring.score;
    const result = sim.result;
    const title = result === 'draw' ? '平局' : `${TAG[result === 'far' ? 'far' : 'near']} 获胜！`;
    const rallies = g.points.map((x) => x.rallyHits);
    const longest = rallies.length ? Math.max(...rallies) : 0;
    const avg = rallies.length ? rallies.reduce((a, b) => a + b, 0) / rallies.length : 0;
    /** 这一边丢的分（对方得分）按原因数 */
    const lost = (side: Side) => {
      const c: Partial<Record<PointReason, number>> = {};
      for (const x of g.points) if (x.winner !== side) c[x.reason] = (c[x.reason] ?? 0) + 1;
      const parts = Object.entries(c).map(([r, n]) => `${REASON_TEXT[r as PointReason]} ${n}`);
      return parts.length ? parts.join(' · ') : '没有';
    };
    const hits = (side: Side) => {
      const pl = g.players[side];
      const whiffs = Object.entries(pl.whiffs)
        .map(([r, n]) => `${r === 'volley' ? '未落台' : (WHIFF_TEXT[r] ?? r)} ${n}`)
        .join('、');
      const med = median(pl.timings.slice(-12));
      return `回球 ${pl.hits} 拍 · 发球 ${pl.serves} 次${whiffs ? ` · 挥空（${whiffs}）` : ''}${
        med === null
          ? ''
          : ` · 时机中位数 ${med === 0 ? '正好' : `${med < 0 ? '早' : '晚'} ${Math.abs(med)}ms`}`
      }`;
    };
    p.innerHTML = `
      <div class="pr-panel">
        <h2 class="mt-result ${result === 'draw' ? '' : 'ok'}">${title}</h2>
        <div class="mt-final">1P <b>${near}</b> : <b>${far}</b> 2P</div>
        <div class="pr-row"><span>回合</span><b>共 ${g.points.length} 分 · 最长 ${longest} 拍 · 平均 ${avg.toFixed(1)} 拍</b></div>
        ${SIDES.map(
          (s) => `
          <div class="pr-row"><span>${TAG[s]} 的失分</span><b>${lost(s)}</b></div>
          <div class="pr-row"><span>${TAG[s]} 的击球</span><b>${hits(s)}</b></div>`
        ).join('')}
        <div class="pr-actions">
          <button class="primary" data-act="again">再来一局（A）</button>
          <button data-act="lobby">换人 / 换分制（B）</button>
          <button data-players="1">换成 1 人（X）</button>
          <a href="./"><button>返回首页</button></a>
        </div>
      </div>`;
    this.bindPlayers(p);
    p.querySelector('[data-act="again"]')?.addEventListener('click', () => this.startGame());
    p.querySelector('[data-act="lobby"]')?.addEventListener('click', () => this.showLobby());
  }

  private renderPause(): void {
    const p = this.pauseEl;
    p.hidden = !this.paused;
    if (!this.paused) return;
    const s = this.settings;
    const sc = this.sim.scoring.score;
    const lost = SIDES.filter((x) => !this.slots[x] || !this.streaming(this.slots[x]));
    const device = this.pauseReason === 'device';
    p.innerHTML = `
      <div class="pr-panel">
        <h2>${device ? '手柄断开了' : '暂停'}</h2>
        ${
          lost.length
            ? `<p class="pr-big">${lost.map((x) => TAG[x]).join('、')} 的手柄断开或没有数据。重新连上（Joy-Con 按一下任意键；手机重新打开页面）后按 A 加入，再按继续。</p>`
            : ''
        }
        <p class="dim">${s.points} 分制 · 比分 1P ${sc.near} : ${sc.far} 2P · 正在打的这一分作废，继续后重打</p>
        <div class="pr-setting"><span>宽容度</span>${[0.2, 0.6, 1].map((v) => this.opt('leniency', v, s.leniency, v < 0.4 ? '严格' : v < 0.8 ? '标准' : '宽松')).join('')}</div>
        <div class="pr-setting"><span>时机提示</span>${this.opt('timingHint', true, s.timingHint, '显示')}${this.opt('timingHint', false, s.timingHint, '不显示')}</div>
        ${crowdRow()}
        ${SIDES.map(
          (x) =>
            `<div class="pr-setting"><span>${TAG[x]} 持拍手</span>${this.opt(`handed-${x}`, 1, s.handed[x], '右手')}${this.opt(`handed-${x}`, -1, s.handed[x], '左手')}</div>`
        ).join('')}
        <div class="pr-setting"><span>画面延迟补偿<small class="dim">（这块屏幕 ${screenKey()}）</small></span>
          <button data-lat="-10">−10</button><b class="pr-lat">${latencyMs()} ms</b><button data-lat="10">+10</button>
        </div>
        <div class="pr-actions">
          <button class="primary" data-act="resume">继续（A / +）</button>
          <button data-act="quit">结束这一局</button>
          <button data-players="1">换成 1 人（X）</button>
          <a href="./"><button>返回首页</button></a>
        </div>
      </div>`;
    this.bindSettings(p);
    this.bindPlayers(p);
    bindCrowd(p, this.view.sfx, () => this.renderPause());
    p.querySelectorAll<HTMLButtonElement>('[data-lat]').forEach((b) =>
      b.addEventListener('click', () => {
        setLatencyMs(latencyMs() + Number(b.dataset.lat));
        this.renderPause();
      })
    );
    p.querySelector('[data-act="resume"]')?.addEventListener('click', () => this.resume());
    p.querySelector('[data-act="quit"]')?.addEventListener('click', () => this.showLobby());
  }
}
