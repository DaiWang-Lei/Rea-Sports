/**
 * 和电脑对打：连接设备 → 校准（拍头指向电视，和练习共用）→ 选对手和分制 → 比赛 → 结算。
 * 对手默认按你的熟练度配对（每个对手有自己的名字、样子、水平和打法，见 config/opponents.ts），
 * 也可以自己挑；只有配对的那一局计熟练度。
 * 比分按 WSR 只在两分之间显示。轮到你发球时按 A（手机「确认」、键盘空格）或向上抖手柄抛球，球落下时挥拍。
 * 暂停（Joy-Con + / 手机「暂停」/ Esc）或手柄断开时，正在进行的这一分作废，继续后重打。
 * 选对手、暂停、结算时可以换成 2 人（双人分屏，见 PlayHost），手柄不用重连。
 */
import '../practice/practice.css';
import './match.css';
import { cpuLevel, STYLE_TEXT } from '@/config/difficulty';
import {
  crowdFill,
  matchOpponent,
  type Opponent,
  OPPONENTS,
  rateGame,
  SKILL,
} from '@/config/opponents';
import { tuning } from '@/config/tuning';
import { avatarsInUse, createLookBody } from '@/render/avatar/roster';
import type { SwingCommit } from '@/input/paddle/SwingDetector';
import { opponentFace, playerFace, skillChart } from '@/ui/tv/faces';
import { howToSeen, howToView } from '@/ui/tv/howto';
import { spinRow, TvOverlay, tvButton } from '@/ui/tv/TvOverlay';
import type { TossEvent } from '@/input/paddle/TossDetector';
import type { Side } from '@/sim/constants';
import type { SwingInput } from '@/sim/hit/HitResolver';
import { type MatchEvent, MatchSim } from '@/sim/MatchSim';
import type { PointReason } from '@/sim/rally/Referee';
import type { GameView } from '../GameView';
import type { MotionInput, SwingEventOut } from '../input/MotionInput';
import type { PlayHost } from '../PlayHost';
import {
  calibLog,
  downloadJson,
  type PracticeSettingsLog,
  PracticeRecorder,
  RecordTicker,
  swingLog,
  v3,
} from '../practice/PracticeRecorder';
import { latencyMs, screenKey, setLatencyMs } from '../shared/latency';
import { median, serveText, strokeText, timingText, WHIFF_TEXT } from '../shared/matchText';
import { deviceLine, deviceSwingInput, HumanPaddle, keySwingInput } from '../shared/motionPlay';
import { deviceWords, SetupFlow } from '../shared/SetupFlow';
import { loadPrefs } from '../shared/prefs';
import { calibrateView, SettingsPanel } from '../shared/settingsView';
import { loadSkill, saveSkill, SKILL_HISTORY } from './skill';

interface Settings {
  points: 6 | 11;
}

const SETTINGS_KEY = 'rea-match';
/** 比赛录制：这一局打完或到这么久自动停止并下载 */
const RECORD_MAX_MS = 10 * 60 * 1000;

function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    return { points: s?.points === 11 ? 11 : 6 };
  } catch {
    return { points: 6 };
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 不保存
  }
}

/** setup = 连接 / 校准中；choose = 选对手；play = 比赛中（含暂停）；over = 结算 */
type Step = 'setup' | 'choose' | 'play' | 'over';

/** 这一局的统计（结算页） */
interface GameLog {
  points: { winner: Side; reason: PointReason; rallyHits: number }[];
  /** 你每一拍回球（不含发球）的时机偏差（毫秒） */
  timings: number[];
  hits: number;
  serves: number;
  whiffs: Record<string, number>;
}

const newGameLog = (): GameLog => ({ points: [], timings: [], hits: 0, serves: 0, whiffs: {} });

export class MatchApp {
  private readonly view: GameView;
  private readonly input: MotionInput;
  private readonly setup: SetupFlow;
  /** 这个模式自己的文字层（面板、状态行），换模式时整块拿掉 */
  private readonly layer: HTMLDivElement;
  private readonly abort = new AbortController();
  private disposed = false;
  /** 画面上你的球拍（挥拍开始、结束时平滑过渡） */
  private readonly paddleView = new HumanPaddle();
  private sim: MatchSim;
  private settings = loadSettings();
  private stage: Exclude<Step, 'setup'> = 'choose';
  private keyboard = false;
  private paused = false;
  /** device = 手柄断开（或没有数据）时自动暂停 */
  private pauseReason: 'user' | 'device' = 'user';
  private game: GameLog = newGameLog();
  /** 你的熟练度；按熟练度配对的对手、自己挑的对手（null = 用配对的）；这一局打完熟练度怎么变的 */
  private skill = loadSkill();
  private matched: Opponent = matchOpponent(this.skill.rating, Math.random());
  private picked: Opponent | null = null;
  private rating: { before: number; after: number } | null = null;
  private keyId = 1_000_000;
  private readonly keysDown = new Set<string>();

  // 时间换算：输入（performance.now 毫秒）↔ 仿真时间
  private clockSim = 0;
  private clockReal = 0;
  private last = performance.now();
  private lostSince = NaN;
  private resultsAt = NaN;
  /** 最近一次真的抛出去的球是怎么抛的（调试 / 冒烟测试） */
  private lastToss: 'button' | 'flick' | 'key' | null = null;

  // 「录制这局」
  private rec: PracticeRecorder | null = null;
  private recTicker = new RecordTicker();
  private lastPlan: object | null = null;

  // DOM
  /** 电视面板：对阵、暂停、校准、设置、结算 */
  private readonly tv: TvOverlay;
  private readonly settingsPanel: SettingsPanel;
  private readonly statusEl: HTMLDivElement;
  private readonly timingEl: HTMLDivElement;
  private timingTimer = 0;
  /** 暂停里正在「重新校准」 */
  private calibrating = false;
  private lastStatus = 0;

  constructor(private readonly host: PlayHost) {
    host.root.className = 'game-root practice match';
    this.input = host.input;
    this.input.multi = false;
    // 从双人切过来：每个手柄的持拍手回到这里的设置（双人时各自设过）
    this.input.setHanded(this.input.handed);
    this.view = host.view;
    this.sim = this.makeSim();
    this.view.configure({
      names: this.names(),
      nearPaddle: (t, body) => {
        const paddle = this.keyboard ? null : (this.input.active?.paddle ?? null);
        return this.paddleView.pose(paddle, this.sim.players.near, body, t);
      },
      onEvent: (e) => this.onMatchEvent(e),
    });
    this.view.setSim(this.sim);
    const root = (this.layer = document.createElement('div'));
    host.root.appendChild(root);
    // 「回到菜单」（各个面板里都有）
    root.addEventListener('click', (e) => {
      if ((e.target as Element).closest('[data-act="home"]')) this.host.exit();
    });
    root.insertAdjacentHTML(
      'beforeend',
      `<div class="pr-status"${host.ctx ? ' hidden' : ''}></div>
       <div class="mt-timing"></div>`
    );
    this.statusEl = root.querySelector('.pr-status')!;
    this.timingEl = root.querySelector('.mt-timing')!;
    this.tv = new TvOverlay(root, (k) => this.view.sfx.ui(k));
    this.settingsPanel = new SettingsPanel(
      {
        sfx: this.view.sfx,
        input: this.input,
        players: 1,
        onChange: (p) => {
          this.sim.players.near.handed = p.handed[0];
          const h = this.sim.human('near');
          if (h) h.leniency = p.leniency;
        },
        onBack: () => this.renderPause(),
      },
      this.tv
    );
    this.setup = new SetupFlow(this.tv, this.input, this.view.hud, this.view.sfx, {
      title: '和电脑对打',
      keyboardHelp: '空格抛球；F 正手、J 反手，按键时机 = 击球时机。',
      onDone: (msg) => this.afterSetup(msg),
      onKeyboard: () => {
        this.keyboard = true;
        this.afterSetup('键盘：空格抛球，F 正手、J 反手');
      },
      onTwoPlayers: () => this.host.switchTo('versus'),
      onBack: () => this.host.exit(),
    });

    this.input.events = {
      onSwing: (e) => this.onDeviceSwing(e),
      onPeak: (e) => {
        this.sim.humanRefine('near', e.peak.id, e.peak.w, e.features);
        this.rec?.push({
          k: 'peak',
          rt: performance.now(),
          id: e.peak.id,
          t: e.peak.t,
          w: e.peak.w,
          features: e.features,
          neutral: e.neutralPitch,
        });
      },
      onToss: (_d, toss) => {
        if (this.step === 'play' && !this.paused) this.tryToss('flick', toss.height, toss);
      },
      onButton: (b, down) => down && this.onButton(b),
      onNav: (dir, down) => this.tv.navInput(dir, down),
      onRawReport: (d, id, data, arrival) => {
        if (this.rec?.device === d) this.rec.imu.addReport(id, data, arrival);
      },
      onRawSample: (d, sample) => {
        if (this.rec?.device === d) this.rec.imu.addSample(sample);
      },
      onCalibrate: (_d, result) => {
        this.setup.onCalibrate(result);
        if (result === 'done') this.logCalib();
        // 暂停里「重新校准」：定好了回到暂停
        if (result === 'done' && this.paused && this.calibrating) this.renderPause();
      },
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
    // 电视界面里用键盘的玩家（开发用）、从双人切过来或电视界面里手柄已经定过电视方向：直接选对手
    if (host.ctx && host.ctx.players[0]?.device === null) {
      this.setup.skip();
      this.keyboard = true;
      this.showChoose();
    } else if (this.setup.skipIfReady()) this.showChoose();
    else this.setup.render();
    void this.input.start().then(() => this.setup.render());
    // 冒烟测试 / 调试用：?debug=1 时把实例挂到 window 上
    if (new URLSearchParams(location.search).has('debug')) {
      (window as unknown as { __match: MatchApp }).__match = this;
    }
    requestAnimationFrame(() => this.loop());
  }

  /** 换模式：这一局作废（录制中就停下并下载），拿掉自己的文字层和按键监听 */
  dispose(): void {
    if (this.rec) this.stopRecording();
    this.disposed = true;
    this.abort.abort();
    window.clearTimeout(this.timingTimer);
    this.layer.remove();
  }

  /** 调试：当前比赛状态（冒烟测试读取） */
  debugState(): {
    step: Step;
    paused: boolean;
    t: number;
    phase: string;
    canToss: boolean;
    serveAt: number | null;
    awaiting: boolean;
    planT: number | null;
    stance: string;
    score: Record<Side, number>;
    result: string | null;
    lastToss: string | null;
  } {
    const s = this.sim;
    const h = s.human('near')!;
    return {
      step: this.step,
      paused: this.paused,
      t: s.t,
      phase: s.phase.kind,
      canToss: h.canToss(s),
      serveAt: h.serveAt?.ideal ?? null,
      awaiting: h.awaitingSwing,
      planT: h.plan?.t ?? null,
      stance: s.players.near.stance,
      score: { ...s.scoring.score },
      result: s.result,
      lastToss: this.lastToss,
    };
  }

  private get step(): Step {
    return this.setup.done ? this.stage : 'setup';
  }

  private names() {
    return { near: '你', far: this.opponent.name };
  }

  /** 这一局的对手：自己挑的，或按熟练度配对的 */
  private get opponent(): Opponent {
    return this.picked ?? this.matched;
  }

  /** 这一局计不计熟练度：按熟练度配对的才计（自己挑的正好是配对的那个也算） */
  private get ranked(): boolean {
    return this.picked === null || this.picked === this.matched;
  }

  /** 换对手：画面上远端的人也换成他的样子（keep = 在对阵画面上左右换的，焦点留在「对手」上） */
  private pick(o: Opponent | null, keep = false): void {
    this.picked = o;
    const look = this.opponent.look;
    this.view.renderer.setAvatar('far', (t) => createLookBody(look, t));
    this.view.setNames(this.names());
    if (this.step === 'choose') this.renderChoose(keep);
  }

  private makeSim(): MatchSim {
    const s = this.settings;
    const o = this.opponent;
    return new MatchSim({
      seed: Math.floor(Math.random() * 1e9),
      points: s.points,
      cpu: { far: o.level },
      cpuStyle: { far: o.style },
      handed: { near: this.input?.handed ?? 1 },
      leniency: loadPrefs().leniency,
      tune: tuning,
    });
  }

  // ---------------------------------------------------------------- 主循环

  private loop(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    const playing = this.step === 'play' && !this.paused;
    // 等球时自动校正电视方向；轮到你发球时识别向上抖手柄
    this.input.autoHeading = playing && !this.keyboard;
    this.input.tossEnabled = playing && !this.keyboard && this.sim.human('near')!.canToss(this.sim);
    this.view.paused = !playing;
    this.view.frame(dt);
    // 仿真时间 clockSim 对应的真实时刻
    this.clockSim = this.sim.t;
    this.clockReal = now - this.view.lag * 1000;
    this.setup.tick();
    this.checkDevice(now);
    this.updateHint();
    this.updateStatus(now);
    if (this.rec) this.recTick(now);
    if (this.step === 'play' && this.sim.phase.kind === 'gameOver') {
      if (Number.isNaN(this.resultsAt)) this.resultsAt = now + 2500;
      else if (now >= this.resultsAt) this.showResults();
    }
    requestAnimationFrame(() => this.loop());
  }

  private simAt(ms: number): number {
    return this.clockSim + (ms - this.clockReal) / 1000;
  }

  /** 手柄断开、或超过 0.3 秒没有数据：自动暂停（这一分作废） */
  private checkDevice(now: number): void {
    if (this.keyboard || this.step !== 'play' || this.paused) {
      this.lostSince = NaN;
      return;
    }
    if (this.input.active && this.input.streaming) {
      this.lostSince = NaN;
      return;
    }
    if (Number.isNaN(this.lostSince)) this.lostSince = now;
    else if (now - this.lostSince > 300) this.pause('device');
  }

  /** 轮到你发球时右下角提示怎么抛球 */
  private updateHint(): void {
    const can = this.step === 'play' && !this.paused && this.sim.human('near')!.canToss(this.sim);
    const hint = can ? this.tossHelp() : '';
    if (hint === this.hint) return;
    this.hint = hint;
    this.view.hud.setHint(hint);
  }

  private hint = '';

  private tossHelp(): string {
    if (this.keyboard) return '按空格抛球，球落下时按 F（正手）/ J（反手）发球';
    return this.input.active?.kind === 'phone'
      ? '按手机上的「确认」或向上抖手机抛球，球落下时挥拍'
      : '按 A 或向上抖手柄抛球，球落下时挥拍';
  }

  // ---------------------------------------------------------------- 输入

  private onDeviceSwing(e: SwingEventOut): void {
    if (this.step !== 'play' || this.paused) return;
    this.applySwing(
      deviceSwingInput(e, (ms) => this.simAt(ms), latencyMs()),
      e.commit
    );
  }

  private applySwing(sw: SwingInput, commit: SwingCommit | null): void {
    const out = this.sim.humanSwing('near', sw);
    const paddle = this.keyboard ? null : (this.input.active?.paddle ?? null);
    this.rec?.push(
      swingLog(performance.now(), this.sim.t, sw, out, commit, this.sim.players.near, paddle)
    );
  }

  /** 抛球：按键（固定高度）或向上抖手柄（按力度定高度）。不是自己发球时返回 false */
  private tryToss(source: 'button' | 'flick' | 'key', height: number, toss?: TossEvent): boolean {
    const ok = this.sim.humanToss('near', height);
    this.rec?.push({
      k: 'toss',
      rt: performance.now(),
      st: this.sim.t,
      source,
      height,
      ok,
      ideal: this.sim.human('near')!.serveAt?.ideal,
      peakG: toss?.peakG,
      durationMs: toss?.durationMs,
      maxOmega: toss?.maxOmega,
    });
    if (ok) this.lastToss = source;
    if (ok && toss) {
      this.showTiming(`抛球：抖手柄 ${toss.peakG.toFixed(1)}G，抛高 ${Math.round(height * 100)}cm`);
    }
    return ok;
  }

  private onKey(e: KeyboardEvent): void {
    this.view.sfx.unlock();
    const k = e.key.toLowerCase();
    // 面板（对阵、暂停、设置、结算）
    if (this.tv.key(e)) return;
    if (k === 'escape' || k === 'p') {
      if (this.step === 'play') this.togglePause();
      return;
    }
    if (this.step !== 'play' || this.paused || e.repeat) return;
    if ((k === ' ' || k === 'enter') && this.view.skipReplay()) {
      e.preventDefault();
      return;
    }
    if (k === ' ') {
      e.preventDefault();
      if (!this.tryToss('key', this.sim.tune.serve.buttonTossHeight)) this.sim.skipBetweenPoints();
      return;
    }
    if (k === 'f' || k === 'j') {
      // 键盘：F 正手、J 反手；按住 W 拉上旋、S 搓下旋；Shift 大力
      this.keyboard = true;
      this.applySwing(
        keySwingInput(
          k === 'f' ? 1 : -1,
          this.keysDown,
          e.shiftKey,
          this.keyId++,
          (ms) => this.simAt(ms),
          latencyMs()
        ),
        null
      );
    }
  }

  private onButton(b: string): void {
    this.rec?.push({ k: 'button', rt: performance.now(), name: b });
    this.view.sfx.unlock();
    if (this.setup.onButton(b)) {
      this.logCalib();
      return;
    }
    // 面板上：A 确定、B 返回；暂停里再按 + 继续
    if (this.tv.visible) {
      if (b === 'confirm') this.tv.confirm();
      else if (b === 'back') this.tv.back();
      else if (b === 'pause' && this.paused) this.resume();
      else if (b === 'players' && !this.host.ctx) this.host.switchTo('versus');
      return;
    }
    if (b === 'pause') {
      if (this.step === 'play') this.togglePause();
      return;
    }
    if (this.step !== 'play' || this.paused) return;
    // A：正在回放（或马上要回放）就跳过
    if (b === 'confirm' && this.view.skipReplay()) return;
    if (b === 'recenter') {
      const head = deviceWords(this.input.active).head;
      if (this.input.recenter()) this.view.hud.flash('已回中', '', 0.8);
      else this.view.hud.flash('没能回中', `把${head}像遥控器一样指向电视再按`, 1.4, 'bad');
      this.logCalib();
      return;
    }
    // A：轮到你发球时抛球；两分之间跳过停顿
    if (b === 'confirm' && !this.tryToss('button', this.sim.tune.serve.buttonTossHeight)) {
      this.sim.skipBetweenPoints();
    }
  }

  // ---------------------------------------------------------------- 流程

  /** 连接、校准完成（或跳过、选了键盘） */
  private afterSetup(msg: string): void {
    this.view.hud.flash(msg, '', 1.2, 'good');
    if (this.stage === 'play') {
      // 比赛中途重新校准：回到暂停前的比赛
      this.paused = false;
      this.tv.hide();
    } else {
      this.showChoose();
    }
  }

  private showChoose(): void {
    this.stage = 'choose';
    this.paused = false;
    // 每次回到选对手都按现在的熟练度重新配对（自己挑的保留）
    this.matched = matchOpponent(this.skill.rating, Math.random());
    this.pick(this.picked);
    // 第一次玩：先看「怎么玩」
    if (!howToSeen('match')) this.tv.show(howToView('match', () => this.renderChoose()));
  }

  private startGame(): void {
    // 按熟练度配对的：按现在的熟练度重新配一个（上一局可能刚涨了分）
    if (this.picked === null && this.stage !== 'choose') {
      this.matched = matchOpponent(this.skill.rating, Math.random());
      this.pick(null);
    }
    this.sim = this.makeSim();
    this.view.setSim(this.sim);
    this.view.setNames(this.names());
    this.game = newGameLog();
    this.stage = 'play';
    this.paused = false;
    this.resultsAt = NaN;
    this.tv.hide();
    const s = this.settings;
    const o = this.opponent;
    this.rating = null;
    this.view.renderer.crowd.setFill(crowdFill(this.skill.rating));
    this.view.hud.flash(
      `对手：${o.name}`,
      `${cpuLevel(o.level).name} · ${STYLE_TEXT[o.style].name} · ${s.points} 分制 · 你先发球`,
      1.6
    );
    this.rec?.push({ k: 'settings', rt: performance.now(), settings: this.settingsLog() });
    this.lastPlan = null;
  }

  private showResults(): void {
    this.stage = 'over';
    this.resultsAt = NaN;
    this.rateGame();
    if (this.rec) this.stopRecording(true);
    this.renderResults();
  }

  /** 一局打完：配对的对手才计熟练度 */
  private rateGame(): void {
    const result = this.sim.result;
    if (!this.ranked || !result) return;
    const { near, far } = this.sim.scoring.score;
    const s = this.skill;
    const before = s.rating;
    s.rating = rateGame(
      before,
      this.opponent,
      result === 'near' ? 1 : result === 'draw' ? 0.5 : 0,
      { mine: near, theirs: far },
      this.settings.points
    );
    s.games++;
    if (result === 'near') s.wins++;
    s.history = [...s.history, s.rating].slice(-SKILL_HISTORY);
    saveSkill(s);
    this.rating = { before, after: s.rating };
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
    this.rec?.push({ k: 'pause', rt: performance.now(), paused: true });
    this.renderPause();
  }

  private resume(): void {
    if (!this.paused) return;
    if (!this.keyboard && !(this.input.active && this.input.streaming)) {
      this.view.hud.flash('设备还没连上', '重新连接后再继续', 1.4, 'bad');
      return;
    }
    this.paused = false;
    this.calibrating = false;
    this.rec?.push({ k: 'pause', rt: performance.now(), paused: false });
    this.tv.hide();
  }

  private setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings[key] = value;
    saveSettings(this.settings);
    if (this.step === 'choose') this.renderChoose(true);
  }

  // ---------------------------------------------------------------- 比赛事件

  private onMatchEvent(e: MatchEvent): void {
    this.rec?.push({ k: 'match', rt: performance.now(), st: this.sim.t, e });
    const g = this.game;
    switch (e.type) {
      case 'toss':
        if (e.side === 'near') this.input.rumble('toss');
        break;
      case 'hit':
        if (e.side !== 'near') break;
        this.input.rumble(e.smash || e.powerServe ? 'smash' : e.oops ? 'oops' : 'hit');
        if (!e.human) break;
        if (e.serve) {
          g.serves++;
          this.showTiming(serveText(e.human, !!e.powerServe));
        } else {
          g.hits++;
          g.timings.push(e.human.timingMs);
          this.showTiming(strokeText(e.human, e.kind));
        }
        break;
      case 'whiff':
        if (e.side !== 'near' || !e.reason) break;
        g.whiffs[e.reason] = (g.whiffs[e.reason] ?? 0) + 1;
        if (e.reason === 'volley') {
          this.showTiming(`未落台击球 · ${timingText(e.timingMs ?? 0)}`);
        } else {
          this.view.hud.flash(WHIFF_TEXT[e.reason], e.serve ? '球落下后再抛一次' : '', 0.9, 'bad');
          const t = e.reason === 'reach' ? '够不着' : `挥空 · ${timingText(e.timingMs ?? 0)}`;
          this.showTiming(e.serve ? `发球${t}` : t);
        }
        break;
      case 'point':
        g.points.push({ winner: e.winner, reason: e.reason, rallyHits: e.rallyHits });
        break;
      default:
        break;
    }
  }

  /** 屏幕下方的小字提示（时机、抛球），设置里可以关 */
  private showTiming(text: string): void {
    if (!loadPrefs().timingHint) return;
    this.timingEl.textContent = text;
    this.timingEl.classList.add('show');
    window.clearTimeout(this.timingTimer);
    this.timingTimer = window.setTimeout(() => this.timingEl.classList.remove('show'), 2000);
  }

  // ---------------------------------------------------------------- 界面

  private updateStatus(now: number): void {
    if (now - this.lastStatus < 300) return;
    this.lastStatus = now;
    const dev = deviceLine(
      this.input,
      this.keyboard,
      '键盘（空格抛球 · F 正手 · J 反手 · 按住 W 上旋 / S 下旋 · Shift 大力）',
      now
    );
    const s = this.settings;
    const rec = this.rec;
    const recText = rec
      ? `<br/><span class="pr-rec">● 录制中 · 已录 ${rec.results} 分 · ${Math.floor(rec.elapsedMs / 60000)}:${String(Math.floor(rec.elapsedMs / 1000) % 60).padStart(2, '0')}</span>`
      : '';
    this.statusEl.innerHTML = `${dev}<br/><span class="dim">对手：${this.opponent.name} · ${s.points} 分制 · 暂停：手机「暂停」/ Joy-Con + / Esc · 回中（指向电视按）：Joy-Con X + ZR 或 Y / 手机「回中」 · 画面延迟补偿 ${latencyMs()}ms</span>${recText}`;
  }

  /** 对阵：你 VS 对手；对手、分制左右改；A 开始，B 回到菜单 */
  private renderChoose(keep = false): void {
    const o = this.opponent;
    const st = STYLE_TEXT[o.style];
    const r = this.skill.rating;
    const s = this.settings;
    this.tv.show(
      {
        className: 'tv-wide',
        html: `
        <div class="tv-vs">
          <div class="tv-vs-side">
            ${playerFace(avatarsInUse().near)}
            <b>你</b>
            <span>熟练度 ${r}</span>
            ${r >= SKILL.pro ? '<span class="tv-tag gold">Pro</span>' : ''}
          </div>
          <div class="tv-vs-mid">VS</div>
          <div class="tv-vs-side">
            ${opponentFace(o)}
            <b>${o.name}${o.champion ? ' <span class="tv-tag gold">冠军</span>' : ''}</b>
            <span>${cpuLevel(o.level).name} · ${st.name} · 熟练度 ${o.skill}</span>
            ${this.ranked ? '' : '<span class="tv-tag warn">这一局不计熟练度</span>'}
          </div>
        </div>
        ${spinRow('opp', '对手', o.name)}
        ${spinRow('points', '分制', s.points === 6 ? '6 分' : '11 分（球更快）')}
        <div class="tv-buttons tv-inline">
          ${tvButton('start', '开始', true, true)}
          ${this.host.ctx ? '' : tvButton('versus', '两个人玩')}
          ${tvButton('home', '回到菜单')}
        </div>`,
        hints: [
          ['▲▼', '选择'],
          ['◀▶', '换对手 / 分制'],
          ['A', '开始'],
          ['B', '回到菜单'],
        ],
        onBack: () => this.host.exit(),
        onSpin: (name, d) => {
          if (name === 'opp') {
            const i = (OPPONENTS.indexOf(o) + d + OPPONENTS.length) % OPPONENTS.length;
            this.pick(OPPONENTS[i] === this.matched ? null : OPPONENTS[i], true);
          } else if (name === 'points') this.setSetting('points', s.points === 6 ? 11 : 6);
        },
        onAct: (act) => {
          if (act === 'start') this.startGame();
          else if (act === 'versus') this.host.switchTo('versus');
          else if (act === 'home') this.host.exit();
        },
      },
      keep
    );
  }

  /** 结算：胜负、比分、几行数、熟练度变化和最近几局的折线；A 再来一局，B 换对手 */
  private renderResults(): void {
    const g = this.game;
    const { near, far } = this.sim.scoring.score;
    const result = this.sim.result;
    const o = this.opponent;
    const title = result === 'draw' ? '平局' : result === 'near' ? '你赢了！' : `${o.name}赢了`;
    const rallies = g.points.map((x) => x.rallyHits);
    const longest = rallies.length ? Math.max(...rallies) : 0;
    const med = median(g.timings.slice(-12));
    const rt = this.rating;
    const rows = [
      `<div><span>回合</span><b>共 ${g.points.length} 分 · 最长 ${longest} 拍</b></div>`,
      med === null
        ? ''
        : `<div><span>你的回球时机</span><b>${med === 0 ? '正好' : `${med < 0 ? '早' : '晚'} ${Math.abs(med)}ms`}</b></div>`,
      rt
        ? `<div><span>熟练度</span><b>${rt.before} → ${rt.after}（${rt.after >= rt.before ? '+' : ''}${rt.after - rt.before}）${
            rt.before < SKILL.pro && rt.after >= SKILL.pro
              ? ' <span class="tv-tag gold">成为 Pro!</span>'
              : ''
          }</b></div>`
        : '<div><span>熟练度</span><b>自己挑的对手，不计</b></div>',
    ].join('');
    this.tv.show({
      html: `
        <h2 class="tv-result ${result === 'near' ? 'win' : result === 'far' ? 'lose' : ''}">${title}</h2>
        <div class="tv-score">你 <b>${near}</b>:<b>${far}</b> ${o.name}</div>
        <div class="tv-stats">${rows}</div>
        ${rt ? skillChart(this.skill.history) : ''}
        <div class="tv-buttons tv-inline">
          ${tvButton('again', '再来一局', true, true)}
          ${tvButton('choose', '换对手')}
          ${tvButton('home', '回到菜单')}
        </div>`,
      hints: [
        ['A', '确定'],
        ['B', '换对手'],
      ],
      onBack: () => this.showChoose(),
      onAct: (act) => {
        if (act === 'again') this.startGame();
        else if (act === 'choose') this.showChoose();
        else if (act === 'home') this.host.exit();
      },
    });
  }

  /** 暂停里「重新校准」：拍头像遥控器一样指向电视，按 A */
  private showCalibrate(): void {
    this.calibrating = true;
    this.tv.show(calibrateView(this.input, () => this.renderPause()));
  }

  /** 暂停：继续、重新开始、重新校准、设置、回到菜单（开发时多「录制这局」） */
  private renderPause(): void {
    if (!this.paused) {
      this.tv.hide();
      return;
    }
    this.calibrating = false;
    const s = this.settings;
    const sc = this.sim.scoring.score;
    const device = this.pauseReason === 'device';
    const med = median(this.game.timings.slice(-12));
    const debug = new URLSearchParams(location.search).has('debug');
    this.tv.show({
      html: `
        <h2>${device ? '手柄断开了' : '暂停'}</h2>
        ${device ? '<p class="tv-note">重新连上手柄（Joy-Con 按一下任意键；手机重新打开页面），再选「继续」</p>' : ''}
        <p class="tv-note">${this.opponent.name} · ${s.points} 分制 · 比分 ${sc.near} : ${sc.far}<br/>正在打的这一分作废，继续后重打</p>
        <div class="tv-buttons">
          ${tvButton('resume', '继续', true, true)}
          ${tvButton('restart', '重新开始')}
          ${this.keyboard ? '' : tvButton('recal', '重新校准')}
          ${med === null ? '' : tvButton('autolat', `按我的平均时机校准画面延迟（${med < 0 ? '早' : '晚'} ${Math.abs(med)}ms）`)}
          ${tvButton('settings', '设置')}
          ${tvButton('howto', '怎么玩')}
          ${debug ? tvButton(this.rec ? 'rec-stop' : 'rec-start', this.rec ? `停止录制并下载（已录 ${this.rec.results} 分）` : '录制这局（开发）') : ''}
          ${tvButton('home', '回到菜单')}
        </div>`,
      hints: [
        ['A', '确定'],
        ['B', '继续'],
      ],
      onBack: () => this.resume(),
      onAct: (act) => {
        if (act === 'resume') this.resume();
        else if (act === 'restart') this.startGame();
        else if (act === 'recal') this.showCalibrate();
        else if (act === 'settings') this.settingsPanel.show();
        else if (act === 'howto') this.tv.show(howToView('match', () => this.renderPause()));
        else if (act === 'home') this.host.exit();
        else if (act === 'autolat') {
          const m = median(this.game.timings.slice(-12));
          if (m !== null) {
            setLatencyMs(latencyMs() + m);
            this.game.timings.length = 0;
            this.view.hud.flash('画面延迟已校准', `${latencyMs()} ms`, 1.2, 'good');
          }
          this.renderPause();
        } else if (act === 'rec-start') {
          this.startRecording();
          this.renderPause();
        } else if (act === 'rec-stop') {
          this.stopRecording();
          this.renderPause();
        }
      },
    });
  }

  // ---------------------------------------------------------------- 录制这局

  private settingsLog(): PracticeSettingsLog {
    const s = this.settings;
    const cfg = this.sim.human('near')!.resolver.cfg;
    return {
      level: this.opponent.level,
      zone: 'match',
      points: s.points,
      leniency: loadPrefs().leniency,
      latencyMs: latencyMs(),
      screen: screenKey(),
      windowMs: this.sim.windowMs,
      handed: this.input.handed,
      tauMin: cfg.tauMin,
      tauMax: cfg.tauMax,
      holdEarly: cfg.holdEarly,
    };
  }

  private startRecording(): void {
    const dev = this.keyboard ? null : this.input.active;
    this.rec = new PracticeRecorder(dev, this.settingsLog(), 'match');
    this.recTicker = new RecordTicker();
    this.lastPlan = null;
    this.logCalib();
    this.rec.push({ k: 'pause', rt: performance.now(), paused: this.paused });
  }

  private stopRecording(auto = false): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    const data = rec.finish();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const who = rec.log.deviceKind === 'joycon' ? data.side : rec.log.deviceKind;
    downloadJson(data, `match-${who}-${stamp}.json`);
    this.view.hud.flash(auto ? '录制结束，已下载' : '录制已下载', `${rec.results} 分`, 1.6, 'good');
    if (this.paused) this.renderPause();
  }

  private logCalib(): void {
    const d = this.rec?.device;
    if (d) this.rec!.push(calibLog(d, performance.now()));
  }

  /** 每帧：时钟对应、你的理想击球点变化、姿态采样；设备断开或到时间自动停止 */
  private recTick(now: number): void {
    const rec = this.rec!;
    this.recTicker.tick(rec, now, this.clockReal, this.clockSim);
    const plan = this.sim.human('near')!.plan;
    if (plan && plan !== this.lastPlan) {
      this.lastPlan = plan;
      rec.push({
        k: 'plan',
        rt: now,
        st: this.sim.t,
        t: plan.t,
        bounceT: plan.bounceT,
        p: v3(plan.p),
        v: v3(plan.v),
        popup: plan.popup,
      });
    }
    const d = rec.device;
    const gone = d !== null && !this.input.devices.has(d.key);
    if (gone || rec.elapsedMs >= RECORD_MAX_MS) this.stopRecording(true);
  }
}
