/**
 * 和电脑对打：连接设备 → 校准（拍头指向电视，和练习共用）→ 选对手和分制 → 比赛 → 结算。
 * 比分按 WSR 只在两分之间显示。轮到你发球时按 A（手机「确认」、键盘空格）或向上抖手柄抛球，球落下时挥拍。
 * 暂停（Joy-Con + / 手机「暂停」/ Esc）或手柄断开时，正在进行的这一分作废，继续后重打。
 */
import '../practice/practice.css';
import './match.css';
import { CPU_LEVELS, cpuLevel } from '@/config/difficulty';
import { clamp } from '@/core/math';
import type { SwingCommit } from '@/input/paddle/SwingDetector';
import type { TossEvent } from '@/input/paddle/TossDetector';
import type { Side } from '@/sim/constants';
import type { SwingInput } from '@/sim/hit/HitResolver';
import { type MatchEvent, MatchSim } from '@/sim/MatchSim';
import { BUTTON_TOSS_HEIGHT } from '@/sim/players/HumanPlayer';
import { type PointReason, REASON_TEXT } from '@/sim/rally/Referee';
import { GameView } from '../GameView';
import { MotionInput, type SwingEventOut } from '../input/MotionInput';
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
import { deviceLine, deviceSwingInput, humanPaddle, keySwingInput } from '../shared/motionPlay';
import { deviceWords, SetupFlow } from '../shared/SetupFlow';

interface Settings {
  /** 电脑等级 1..5 */
  level: number;
  points: 6 | 11;
  leniency: number;
  /** 击球后小字提示时机 */
  timingHint: boolean;
}

const SETTINGS_KEY = 'rea-match';
/** 比赛录制：这一局打完或到这么久自动停止并下载 */
const RECORD_MAX_MS = 10 * 60 * 1000;

function loadSettings(): Settings {
  const def: Settings = { level: 1, points: 6, leniency: 0.6, timingHint: true };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    return {
      level: clamp(Math.round(s?.level ?? def.level), 1, CPU_LEVELS.length),
      points: s?.points === 11 ? 11 : 6,
      leniency: s?.leniency ?? def.leniency,
      timingHint: s?.timingHint ?? def.timingHint,
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

/** setup = 连接 / 校准中；choose = 选对手；play = 比赛中（含暂停）；over = 结算 */
type Step = 'setup' | 'choose' | 'play' | 'over';

const LEVEL_BLURB = [
  '反应慢、失误多，适合先熟悉手感',
  '回球稳一些，偶尔加旋转',
  '会用旋转和落点调动你',
  '速度快、旋转多，会扣杀',
  '反应快、落点刁、扣杀狠',
];

const WHIFF_TEXT: Record<string, string> = {
  early: '挥早了',
  late: '挥晚了',
  reach: '够不着',
};

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

function timingText(ms: number): string {
  return Math.abs(ms) <= 20 ? '时机正好' : `${ms < 0 ? '早' : '晚'} ${Math.abs(ms)}ms`;
}

function median(v: number[]): number | null {
  if (v.length < 5) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

export class MatchApp {
  private readonly view: GameView;
  private readonly input = new MotionInput();
  private readonly setup: SetupFlow;
  private sim: MatchSim;
  private settings = loadSettings();
  private stage: Exclude<Step, 'setup'> = 'choose';
  private keyboard = false;
  private paused = false;
  /** device = 手柄断开（或没有数据）时自动暂停 */
  private pauseReason: 'user' | 'device' = 'user';
  private game: GameLog = newGameLog();
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
  private readonly overlay: HTMLDivElement;
  private readonly panelEl: HTMLDivElement;
  private readonly pauseEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly timingEl: HTMLDivElement;
  private timingTimer = 0;
  private lastStatus = 0;

  constructor(root: HTMLElement) {
    root.className = 'game-root practice match';
    this.sim = this.makeSim();
    this.view = new GameView(root, this.sim, {
      names: this.names(),
      nearPaddle: (t, body) => {
        const paddle = this.keyboard ? null : (this.input.active?.paddle ?? null);
        return humanPaddle(paddle, this.sim.players.near, body, t);
      },
      onEvent: (e) => this.onMatchEvent(e),
    });
    root.insertAdjacentHTML(
      'beforeend',
      `<div class="pr-status"></div>
       <div class="mt-timing"></div>
       <div class="pr-overlay mt-panel" hidden></div>
       <div class="pr-overlay"></div>
       <div class="pr-pause" hidden></div>`
    );
    this.statusEl = root.querySelector('.pr-status')!;
    this.timingEl = root.querySelector('.mt-timing')!;
    this.panelEl = root.querySelector('.mt-panel')!;
    this.overlay = root.querySelector('.pr-overlay:not(.mt-panel)')!;
    this.pauseEl = root.querySelector('.pr-pause')!;
    this.setup = new SetupFlow(this.overlay, this.input, this.view.hud, this.view.sfx, {
      title: '和电脑对打',
      keyboardHelp: '空格抛球；F 正手、J 反手，按键时机 = 击球时机。',
      onDone: (msg) => this.afterSetup(msg),
      onKeyboard: () => {
        this.keyboard = true;
        this.afterSetup('键盘：空格抛球，F 正手、J 反手');
      },
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
      onRawReport: (d, id, data, arrival) => {
        if (this.rec?.device === d) this.rec.imu.addReport(id, data, arrival);
      },
      onRawSample: (d, sample) => {
        if (this.rec?.device === d) this.rec.imu.addSample(sample);
      },
      onCalibrate: (_d, result) => {
        this.setup.onCalibrate(result);
        if (result === 'done') this.logCalib();
      },
      onDevicesChanged: () => this.setup.render(),
      onLinkStatus: (text, ok) => this.setup.setLinkStatus(text, ok),
    };
    window.addEventListener('keydown', (e) => {
      this.keysDown.add(e.key.toLowerCase());
      this.onKey(e);
    });
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.key.toLowerCase()));
    window.addEventListener('pointerdown', () => this.view.sfx.unlock());
    this.setup.render();
    void this.input.start().then(() => this.setup.render());
    // 冒烟测试 / 调试用：?debug=1 时把实例挂到 window 上
    if (new URLSearchParams(location.search).has('debug')) {
      (window as unknown as { __match: MatchApp }).__match = this;
    }
    requestAnimationFrame(() => this.loop());
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
    return { near: '你', far: `电脑·${cpuLevel(this.settings.level).name}` };
  }

  private makeSim(): MatchSim {
    const s = this.settings;
    return new MatchSim({
      seed: Math.floor(Math.random() * 1e9),
      points: s.points,
      cpu: { far: s.level },
      handed: { near: this.input?.handed ?? 1 },
      leniency: s.leniency,
    });
  }

  // ---------------------------------------------------------------- 主循环

  private loop(): void {
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
    if (k === 'escape' || k === 'p') {
      if (this.step === 'play') this.togglePause();
      return;
    }
    const step = this.step;
    if (step === 'choose') {
      if (k === 'arrowleft' || k === 'arrowright') {
        const lv = this.settings.level + (k === 'arrowleft' ? -1 : 1);
        this.setSetting('level', clamp(lv, 1, CPU_LEVELS.length));
      } else if (k === 'arrowup' || k === 'arrowdown') {
        this.setSetting('points', this.settings.points === 6 ? 11 : 6);
      } else if (k === 'enter' || k === ' ') {
        e.preventDefault();
        this.startGame();
      }
      return;
    }
    if (step === 'over') {
      if (k === 'enter' || k === ' ') {
        e.preventDefault();
        this.startGame();
      }
      return;
    }
    if (step !== 'play' || this.paused || e.repeat) return;
    if (k === ' ') {
      e.preventDefault();
      if (!this.tryToss('key', BUTTON_TOSS_HEIGHT)) this.sim.skipBetweenPoints();
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
    const step = this.step;
    if (b === 'pause') {
      if (step === 'play') this.togglePause();
      return;
    }
    if (step === 'choose') {
      if (b === 'confirm') this.startGame();
      return;
    }
    if (step === 'over') {
      if (b === 'confirm') this.startGame();
      else if (b === 'back') this.showChoose();
      return;
    }
    if (step !== 'play') return;
    if (this.paused) {
      if (b === 'confirm') this.resume();
      return;
    }
    if (b === 'recenter') {
      const head = deviceWords(this.input).head;
      if (this.input.recenter()) this.view.hud.flash('已回中', '', 0.8);
      else this.view.hud.flash('没能回中', `把${head}像遥控器一样指向电视再按`, 1.4, 'bad');
      this.logCalib();
      return;
    }
    // A：轮到你发球时抛球；两分之间跳过停顿
    if (b === 'confirm' && !this.tryToss('button', BUTTON_TOSS_HEIGHT)) {
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
      this.renderPause();
    } else {
      this.showChoose();
    }
  }

  private showChoose(): void {
    this.stage = 'choose';
    this.paused = false;
    this.pauseEl.hidden = true;
    this.renderChoose();
  }

  private startGame(): void {
    this.sim = this.makeSim();
    this.view.setSim(this.sim);
    this.view.setNames(this.names());
    this.game = newGameLog();
    this.stage = 'play';
    this.paused = false;
    this.resultsAt = NaN;
    this.panelEl.hidden = true;
    this.pauseEl.hidden = true;
    const s = this.settings;
    this.view.hud.flash(`对手：${cpuLevel(s.level).name}`, `${s.points} 分制 · 你先发球`, 1.6);
    this.rec?.push({ k: 'settings', rt: performance.now(), settings: this.settingsLog() });
    this.lastPlan = null;
  }

  private showResults(): void {
    this.stage = 'over';
    this.resultsAt = NaN;
    if (this.rec) this.stopRecording(true);
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
    this.rec?.push({ k: 'pause', rt: performance.now(), paused: false });
    this.renderPause();
  }

  private setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings[key] = value;
    saveSettings(this.settings);
    if (key === 'leniency') {
      const h = this.sim.human('near');
      if (h) h.leniency = value as number;
    }
    if (this.step === 'choose') this.renderChoose();
    if (this.paused) this.renderPause();
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
          this.showTiming(
            `发球 · ${timingText(e.human.timingMs)}${e.powerServe ? ' · 强力发球' : ''}`
          );
        } else {
          g.hits++;
          g.timings.push(e.human.timingMs);
          const stroke = e.human.stroke === 'fh' ? '正手' : '反手';
          this.showTiming(`${stroke} · ${timingText(e.human.timingMs)}`);
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
    if (!this.settings.timingHint) return;
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
    this.statusEl.innerHTML = `${dev}<br/><span class="dim">对手：${cpuLevel(s.level).name} · ${s.points} 分制 · 暂停：手机「暂停」/ Joy-Con + / Esc · 回中（指向电视按）：Joy-Con X + ZR 或 Y / 手机「回中」 · 画面延迟补偿 ${latencyMs()}ms</span>${recText}`;
  }

  private opt<T extends string | number | boolean>(
    name: string,
    value: T,
    cur: T,
    text: string
  ): string {
    return `<button class="${value === cur ? 'on' : ''}" data-set="${name}" data-val="${value}">${text}</button>`;
  }

  /** 把面板里的 data-set 按钮接到设置上 */
  private bindSettings(el: HTMLElement): void {
    el.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((b) =>
      b.addEventListener('click', () => {
        const name = b.dataset.set!;
        const raw = b.dataset.val!;
        if (name === 'handed') {
          const h = raw === '-1' ? -1 : 1;
          this.input.setHanded(h);
          this.sim.players.near.handed = h;
          if (this.paused) this.renderPause();
        } else if (name === 'timingHint') {
          this.setSetting('timingHint', raw === 'true');
        } else if (name === 'points') {
          this.setSetting('points', raw === '11' ? 11 : 6);
        } else if (name === 'level' || name === 'leniency') {
          this.setSetting(name, Number(raw));
        }
      })
    );
  }

  private renderChoose(): void {
    const p = this.panelEl;
    p.hidden = false;
    const s = this.settings;
    p.innerHTML = `
      <div class="pr-panel">
        <h2>和电脑对打</h2>
        <div class="pr-setting"><span>对手</span>${CPU_LEVELS.map((l, i) => this.opt('level', i + 1, s.level, l.name)).join('')}</div>
        <p class="dim small mt-blurb">${LEVEL_BLURB[s.level - 1] ?? ''}</p>
        <div class="pr-setting"><span>分制</span>${this.opt('points', 6, s.points, '6 分')}${this.opt('points', 11, s.points, '11 分（球更快）')}</div>
        <div class="pr-actions">
          <button class="primary" data-act="start">开始（A）</button>
          <a href="./"><button>返回首页</button></a>
        </div>
        <p class="dim">发球：${this.tossHelp()}。每人连发 2 球，先到 ${s.points} 分并领先 2 分获胜，20 平算平局。</p>
        <p class="dim small">换对手：用鼠标点，或键盘 ← →（↑ ↓ 换分制）；开始：Joy-Con A / 手机「确认」/ Enter</p>
      </div>`;
    this.bindSettings(p);
    p.querySelector('[data-act="start"]')?.addEventListener('click', () => this.startGame());
  }

  private renderResults(): void {
    const p = this.panelEl;
    p.hidden = false;
    const sim = this.sim;
    const g = this.game;
    const { near, far } = sim.scoring.score;
    const result = sim.result;
    const title = result === 'draw' ? '平局' : result === 'near' ? '你赢了！' : '电脑赢了';
    const rallies = g.points.map((x) => x.rallyHits);
    const longest = rallies.length ? Math.max(...rallies) : 0;
    const avg = rallies.length ? rallies.reduce((a, b) => a + b, 0) / rallies.length : 0;
    const reasons = (winner: Side) => {
      const c: Partial<Record<PointReason, number>> = {};
      for (const x of g.points) if (x.winner === winner) c[x.reason] = (c[x.reason] ?? 0) + 1;
      const parts = Object.entries(c).map(([r, n]) => `${REASON_TEXT[r as PointReason]} ${n}`);
      return parts.length ? parts.join(' · ') : '没有';
    };
    const whiffs = Object.entries(g.whiffs)
      .map(([r, n]) => `${r === 'volley' ? '未落台' : (WHIFF_TEXT[r] ?? r)} ${n}`)
      .join('、');
    const med = median(g.timings.slice(-12));
    p.innerHTML = `
      <div class="pr-panel">
        <h2 class="mt-result ${result === 'near' ? 'ok' : result === 'far' ? 'bad' : ''}">${title}</h2>
        <div class="mt-final">你 <b>${near}</b> : <b>${far}</b> ${this.names().far}</div>
        <div class="pr-row"><span>回合</span><b>共 ${g.points.length} 分 · 最长 ${longest} 拍 · 平均 ${avg.toFixed(1)} 拍</b></div>
        <div class="pr-row"><span>你的失分</span><b>${reasons('far')}</b></div>
        <div class="pr-row"><span>电脑的失分</span><b>${reasons('near')}</b></div>
        <div class="pr-row"><span>你的击球</span><b>回球 ${g.hits} 拍 · 发球 ${g.serves} 次${whiffs ? ` · 挥空（${whiffs}）` : ''}</b></div>
        ${med === null ? '' : `<div class="pr-row"><span>回球时机</span><b>最近的中位数 ${med === 0 ? '正好' : `${med < 0 ? '早' : '晚'} ${Math.abs(med)}ms`}</b></div>`}
        <div class="pr-actions">
          <button class="primary" data-act="again">再来一局（A）</button>
          <button data-act="choose">换对手（B）</button>
          <a href="./"><button>返回首页</button></a>
        </div>
      </div>`;
    p.querySelector('[data-act="again"]')?.addEventListener('click', () => this.startGame());
    p.querySelector('[data-act="choose"]')?.addEventListener('click', () => this.showChoose());
  }

  private renderPause(): void {
    const p = this.pauseEl;
    p.hidden = !this.paused;
    if (!this.paused) return;
    const s = this.settings;
    const sc = this.sim.scoring.score;
    const med = median(this.game.timings.slice(-12));
    const lat = latencyMs();
    const device = this.pauseReason === 'device';
    p.innerHTML = `
      <div class="pr-panel">
        <h2>${device ? '手柄断开了' : '暂停'}</h2>
        ${device ? '<p class="pr-big">设备断开或没有数据。重新连上（Joy-Con 按一下任意键；手机重新打开页面）后按继续。</p>' : ''}
        <p class="dim">对手：${cpuLevel(s.level).name} · ${s.points} 分制 · 比分 你 ${sc.near} : ${sc.far} 电脑 · 正在打的这一分作废，继续后重打</p>
        <div class="pr-setting"><span>宽容度</span>${[0.2, 0.6, 1].map((v) => this.opt('leniency', v, s.leniency, v < 0.4 ? '严格' : v < 0.8 ? '标准' : '宽松')).join('')}</div>
        <div class="pr-setting"><span>画面延迟补偿<small class="dim">（这块屏幕 ${screenKey()}）</small></span>
          <button data-lat="-10">−10</button><b class="pr-lat">${lat} ms</b><button data-lat="10">+10</button>
          ${med === null ? '<span class="dim">（这一局回球满 5 拍后可以按平均时机自动校准）</span>' : `<button data-act="autolat">按我的平均时机校准（${med < 0 ? '早' : '晚'} ${Math.abs(med)}ms）</button>`}
        </div>
        <div class="pr-setting"><span>时机提示</span>${this.opt('timingHint', true, s.timingHint, '显示')}${this.opt('timingHint', false, s.timingHint, '不显示')}</div>
        <div class="pr-setting"><span>持拍手</span>${this.opt('handed', 1, this.input.handed, '右手')}${this.opt('handed', -1, this.input.handed, '左手')}</div>
        <div class="pr-setting"><span>录制这局</span>
          ${this.rec ? `<button class="on" data-act="rec-stop">停止并下载（已录 ${this.rec.results} 分）</button>` : '<button data-act="rec-start">开始录制</button>'}
          <span class="dim">这一局打完或 ${RECORD_MAX_MS / 60000} 分钟自动停止并下载，把文件发给开发者分析</span>
        </div>
        <div class="pr-actions">
          <button class="primary" data-act="resume">继续（A / +）</button>
          <button data-act="recal">重新校准拍面</button>
          <button data-act="quit">结束这一局，换对手</button>
          <a href="./"><button>返回首页</button></a>
        </div>
      </div>`;
    this.bindSettings(p);
    p.querySelectorAll<HTMLButtonElement>('[data-lat]').forEach((b) =>
      b.addEventListener('click', () => {
        setLatencyMs(latencyMs() + Number(b.dataset.lat));
        this.renderPause();
      })
    );
    p.querySelector('[data-act="autolat"]')?.addEventListener('click', () => {
      const m = median(this.game.timings.slice(-12));
      if (m !== null) {
        setLatencyMs(latencyMs() + m);
        this.game.timings.length = 0;
        this.renderPause();
      }
    });
    p.querySelector('[data-act="rec-start"]')?.addEventListener('click', () => {
      this.startRecording();
      this.renderPause();
    });
    p.querySelector('[data-act="rec-stop"]')?.addEventListener('click', () => {
      this.stopRecording();
      this.renderPause();
    });
    p.querySelector('[data-act="resume"]')?.addEventListener('click', () => this.resume());
    p.querySelector('[data-act="recal"]')?.addEventListener('click', () => {
      this.pauseEl.hidden = true;
      this.setup.restart();
    });
    p.querySelector('[data-act="quit"]')?.addEventListener('click', () => {
      if (this.rec) this.stopRecording();
      this.showChoose();
    });
  }

  // ---------------------------------------------------------------- 录制这局

  private settingsLog(): PracticeSettingsLog {
    const s = this.settings;
    const cfg = this.sim.human('near')!.resolver.cfg;
    return {
      level: s.level,
      zone: 'match',
      points: s.points,
      leniency: s.leniency,
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
