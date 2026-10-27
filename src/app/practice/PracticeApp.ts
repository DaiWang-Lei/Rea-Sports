/**
 * 发球机练习页：连接设备 → 校准（拍头指向电视，Joy-Con 按住 X + ZR）→ 发球机送球，玩家挥拍回球。
 * 每一球给出结果卡片（时机早晚、正反手、力度、旋转），可以调难度、落点区域和画面延迟补偿。
 */
import './practice.css';
import { Sfx } from '@/audio/Sfx';
import { clamp } from '@/core/math';
import { type Vec3, vec3 } from '@/core/vec3';
import type { SwingCommit } from '@/input/paddle/SwingDetector';
import type { SwingInput, SwingOutcome } from '@/sim/hit/HitResolver';
import { SIM_DT } from '@/sim/constants';
import {
  FEED_RESULT_TEXT,
  type FeederEvent,
  FeederSim,
  type FeedLevel,
  type FeedZone,
  type ShotReport,
  type WhiffReason,
} from '@/sim/practice/FeederSim';
import { SHOT_KIND_TEXT } from '@/sim/shot/ShotSpec';
import { Renderer } from '@/render/Renderer';
import { Hud } from '@/ui/Hud';
import { MotionInput, type SwingEventOut } from '../input/MotionInput';
import { latencyMs, screenKey, setLatencyMs } from '../shared/latency';
import { deviceLine, deviceSwingInput, humanPaddle, keySwingInput } from '../shared/motionPlay';
import { deviceWords, SetupFlow } from '../shared/SetupFlow';
import {
  calibLog,
  downloadJson,
  type PracticeSettingsLog,
  PracticeRecorder,
  RECORD_MAX_BALLS,
  RECORD_MAX_MS,
  RecordTicker,
  swingLog,
  v3,
} from './PracticeRecorder';

// 画面延迟补偿按屏幕记，练习和比赛共用（见 shared/latency；以前存在这里的 latencyByScreen 会被搬过去）
interface Settings {
  level: FeedLevel;
  zone: FeedZone;
  leniency: number;
}

const SETTINGS_KEY = 'rea-practice';

function loadSettings(): Settings {
  const def: Settings = { level: 1, zone: 'mixed', leniency: 0.6 };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    return {
      level: s?.level ?? def.level,
      zone: s?.zone ?? def.zone,
      leniency: s?.leniency ?? def.leniency,
    };
  } catch {
    return def;
  }
}

function saveSettings(s: Settings): void {
  try {
    const old = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as object;
    // 保留旧的延迟字段：shared/latency 第一次读取时从这里搬
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...old, ...s }));
  } catch {
    // 不保存
  }
}

type Step = 'connect' | 'point' | 'play';

const LEVEL_TEXT: Record<FeedLevel, string> = { 1: '入门', 2: '进阶', 3: '高手' };
const ZONE_TEXT: Record<FeedZone, string> = { mixed: '全台', fh: '只送正手', bh: '只送反手' };
const WHIFF_TEXT: Record<WhiffReason, string> = {
  early: '挥早了',
  late: '挥晚了',
  reach: '够不着',
};
const SPIN_TEXT: Record<string, string> = {
  flat: '平送',
  top: '上旋',
  back: '下旋',
  side: '侧旋',
  high: '高球',
};

export class PracticeApp {
  private readonly renderer: Renderer;
  private readonly hud: Hud;
  private readonly sfx = new Sfx();
  private readonly input = new MotionInput();
  private sim: FeederSim;
  private settings = loadSettings();
  private readonly setup: SetupFlow;
  private keyboard = false;
  private paused = false;

  // 时间换算：输入（performance.now 毫秒）↔ 仿真时间
  private clockSim = 0;
  private clockReal = 0;
  private acc = 0;
  private last = performance.now();
  private prevBody = { x: 0, y: -2 };
  private prevBall: Vec3 = vec3();
  private keyId = 1_000_000;

  // 「录制这局」
  private rec: PracticeRecorder | null = null;
  private recTicker = new RecordTicker();
  private lastPlan: object | null = null;

  // DOM
  private readonly overlay: HTMLDivElement;
  private readonly statsEl: HTMLDivElement;
  private readonly cardEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly swingEl: HTMLDivElement;
  private readonly pauseEl: HTMLDivElement;

  constructor(root: HTMLElement) {
    root.className = 'game-root practice';
    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    root.appendChild(canvas);
    this.renderer = new Renderer(canvas);
    this.hud = new Hud(root, { near: '我', far: '发球机' });
    this.sim = this.makeSim();

    root.insertAdjacentHTML(
      'beforeend',
      `<div class="pr-stats"></div>
       <div class="pr-card"></div>
       <div class="pr-status"></div>
       <div class="pr-swing"></div>
       <div class="pr-overlay"></div>
       <div class="pr-pause" hidden></div>`
    );
    this.statsEl = root.querySelector('.pr-stats')!;
    this.cardEl = root.querySelector('.pr-card')!;
    this.statusEl = root.querySelector('.pr-status')!;
    this.swingEl = root.querySelector('.pr-swing')!;
    this.overlay = root.querySelector('.pr-overlay')!;
    this.pauseEl = root.querySelector('.pr-pause')!;
    this.setup = new SetupFlow(this.overlay, this.input, this.hud, this.sfx, {
      title: '发球机练习',
      keyboardHelp: 'F 正手、J 反手，按键时机 = 击球时机。',
      onDone: (msg) => this.startPlay(msg),
      onKeyboard: () => this.startKeyboard(),
    });

    this.input.events = {
      onSwing: (e) => this.onDeviceSwing(e),
      onPeak: (e) => {
        this.sim.refineSwing(e.peak.id, e.peak.w, e.features);
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
    window.addEventListener('pointerdown', () => this.sfx.unlock());
    this.setup.render();
    this.renderStats();
    void this.input.start().then(() => this.setup.render());
    // 冒烟测试 / 调试用：?debug=1 时把实例挂到 window 上
    if (new URLSearchParams(location.search).has('debug')) {
      (window as unknown as { __practice: PracticeApp }).__practice = this;
    }
    requestAnimationFrame(() => this.loop());
  }

  /** 调试：当前练习状态（冒烟测试读取） */
  debugState(): {
    step: Step;
    t: number;
    awaiting: boolean;
    planT: number | null;
    planX: number | null;
    bodyX: number;
    feeds: number;
    results: Record<string, number>;
  } {
    const s = this.sim;
    return {
      step: this.step,
      t: s.t,
      awaiting: s.awaitingSwing,
      planT: s.plan?.t ?? null,
      planX: s.plan?.p.x ?? null,
      bodyX: s.player.mover.x,
      feeds: s.stats.feeds,
      results: { ...(s.stats.results as Record<string, number>) },
    };
  }

  /** 连接、校准之后就是练习本身 */
  private get step(): Step {
    const s = this.setup.step;
    return s === 'done' ? 'play' : s;
  }

  /** 当前屏幕的画面延迟补偿（毫秒） */
  private get latencyMs(): number {
    return latencyMs();
  }

  private setLatency(ms: number): void {
    setLatencyMs(ms);
  }

  private makeSim(): FeederSim {
    const s = this.settings;
    const sim = new FeederSim({
      seed: Math.floor(Math.random() * 1e9),
      level: s.level,
      zone: s.zone,
      leniency: s.leniency,
      handed: this.input?.handed ?? 1,
    });
    sim.pause(true);
    return sim;
  }

  // ---------------------------------------------------------------- 主循环

  private loop(): void {
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    // 等球时自动校正电视方向：只在发球机练习进行中
    this.input.autoHeading = this.step === 'play' && !this.paused && !this.keyboard;
    if (!this.paused && this.step === 'play') {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < 12) {
        this.prevBody = { x: this.sim.player.mover.x, y: this.sim.player.mover.y };
        this.prevBall = { ...this.sim.ball.p };
        this.sim.tick();
        this.acc -= SIM_DT;
        steps++;
      }
      if (steps === 12) this.acc = 0;
    }
    // 仿真时间 clockSim 对应的真实时刻
    this.clockSim = this.sim.t;
    this.clockReal = now - this.acc * 1000;
    for (const e of this.sim.drainEvents()) {
      this.onSimEvent(e);
      this.rec?.push({ k: 'sim', rt: now, st: this.sim.t, e });
    }
    if (this.rec) this.recTick(now);
    this.draw();
    this.updateStatus(now);
    this.setup.tick();
    requestAnimationFrame(() => this.loop());
  }

  private simAt(ms: number): number {
    return this.clockSim + (ms - this.clockReal) / 1000;
  }

  private draw(): void {
    const s = this.sim;
    const alpha = this.acc / SIM_DT;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const body = {
      x: lerp(this.prevBody.x, s.player.mover.x),
      y: lerp(this.prevBody.y, s.player.mover.y),
    };
    const ball = {
      x: lerp(this.prevBall.x, s.ball.p.x),
      y: lerp(this.prevBall.y, s.ball.p.y),
      z: lerp(this.prevBall.z, s.ball.p.z),
    };
    const t = s.t - SIM_DT + alpha * SIM_DT;
    this.renderer.render({
      t,
      ball,
      ballVisible: s.ballFree || s.phase.kind === 'wait',
      trail: 'normal',
      players: { near: { player: s.player, body, paddle: this.nearPaddle(t, body) } },
      machine: s.machine,
      shake: 0,
    });
  }

  /** 玩家的球拍：已校准时朝向 1:1 跟随设备，位置在手上；挥拍时位置跟随挥拍动画 */
  private nearPaddle(t: number, body: { x: number; y: number }) {
    const paddle = this.keyboard ? null : (this.input.active?.paddle ?? null);
    return humanPaddle(paddle, this.sim.player, body, t);
  }

  // ---------------------------------------------------------------- 输入

  private onDeviceSwing(e: SwingEventOut): void {
    const c = e.commit;
    this.showSwing(e.dir, c.wPeak, c.path);
    if (this.step !== 'play' || this.paused) return;
    this.applySwing(
      deviceSwingInput(e, (ms) => this.simAt(ms), this.latencyMs),
      c
    );
  }

  private applySwing(sw: SwingInput, commit: SwingCommit | null): void {
    // 挥空、未落台的提示在判定算数时由 whiff / volley 事件给出（挥早会先挂起一小会儿，可能被前挥取代）
    const out = this.sim.swing(sw);
    this.logSwing(sw, out, commit);
  }

  private onKey(e: KeyboardEvent): void {
    this.sfx.unlock();
    const k = e.key.toLowerCase();
    if (k === 'escape' || k === 'p') {
      this.togglePause();
      return;
    }
    if (this.step !== 'play' || this.paused || e.repeat) return;
    if (k === 'f' || k === 'j') {
      // 键盘：F 正手、J 反手；按住 W 拉上旋、S 搓下旋；Shift 大力
      this.keyboard = true;
      const dir = k === 'f' ? 1 : -1;
      const sw = keySwingInput(
        dir,
        this.keysDown,
        e.shiftKey,
        this.keyId++,
        (ms) => this.simAt(ms),
        this.latencyMs
      );
      this.showSwing(dir, sw.wPeak, 'key');
      this.applySwing(sw, null);
    }
  }

  private readonly keysDown = new Set<string>();

  private onButton(b: string): void {
    this.rec?.push({ k: 'button', rt: performance.now(), name: b });
    this.handleButton(b);
    this.logCalib();
  }

  private handleButton(b: string): void {
    this.sfx.unlock();
    if (b === 'pause') {
      if (this.step === 'play') this.togglePause();
      return;
    }
    if (this.setup.onButton(b)) return;
    if (this.step === 'play' && b === 'recenter') {
      const head = deviceWords(this.input).head;
      if (this.input.recenter()) this.hud.flash('已回中', '', 0.8);
      else this.hud.flash('没能回中', `把${head}像遥控器一样指向电视再按`, 1.4, 'bad');
    }
  }

  // ---------------------------------------------------------------- 流程

  private startPlay(msg: string): void {
    this.paused = false;
    this.sim.pause(false);
    this.hud.flash(msg, '发球机开始送球', 1.4, 'good');
    this.renderStats();
  }

  private startKeyboard(): void {
    this.keyboard = true;
    this.startPlay('键盘练习：F 正手、J 反手');
  }

  private togglePause(): void {
    if (this.step !== 'play') return;
    this.paused = !this.paused;
    this.sim.pause(this.paused);
    this.rec?.push({ k: 'pause', rt: performance.now(), paused: this.paused });
    this.renderPause();
  }

  private restartSim(): void {
    this.sim = this.makeSim();
    if (this.step === 'play' && !this.paused) this.sim.pause(false);
    this.rec?.push({ k: 'settings', rt: performance.now(), settings: this.settingsLog() });
    this.lastPlan = null;
    this.renderStats();
  }

  // ---------------------------------------------------------------- 录制这局

  private settingsLog(): PracticeSettingsLog {
    const s = this.settings;
    const cfg = this.sim.resolver.cfg;
    return {
      level: s.level,
      zone: s.zone,
      leniency: s.leniency,
      latencyMs: this.latencyMs,
      screen: screenKey(),
      windowMs: this.sim.windowMs,
      handed: this.input.handed,
      tauMin: cfg.tauMin,
      tauMax: cfg.tauMax,
      holdEarly: cfg.holdEarly,
    };
  }

  private startRecording(): void {
    this.rec = new PracticeRecorder(this.keyboard ? null : this.input.active, this.settingsLog());
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
    downloadJson(data, `practice-${who}-${stamp}.json`);
    this.hud.flash(auto ? '录制结束，已下载' : '录制已下载', `${rec.results} 球`, 1.6, 'good');
    if (this.paused) this.renderPause();
  }

  private logCalib(): void {
    const d = this.rec?.device;
    if (d) this.rec!.push(calibLog(d, performance.now()));
  }

  private logSwing(input: SwingInput, outcome: SwingOutcome, commit: SwingCommit | null): void {
    const paddle = this.keyboard ? null : (this.input.active?.paddle ?? null);
    this.rec?.push(
      swingLog(performance.now(), this.sim.t, input, outcome, commit, this.sim.player, paddle)
    );
  }

  /** 每帧：时钟对应、理想击球点变化、姿态采样（约 10 次/秒），到量自动停止 */
  private recTick(now: number): void {
    const rec = this.rec!;
    this.recTicker.tick(rec, now, this.clockReal, this.clockSim);
    const plan = this.sim.plan;
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
    if (gone || rec.results >= RECORD_MAX_BALLS || rec.elapsedMs >= RECORD_MAX_MS) {
      this.stopRecording(true);
    }
  }

  // ---------------------------------------------------------------- 仿真事件

  private onSimEvent(e: FeederEvent): void {
    const pan = (p: { x: number }) => p.x / 1.5;
    switch (e.type) {
      case 'feed':
        this.sfx.beep(520, 0.05, 0.12);
        break;
      case 'hit':
        this.sfx.hit(e.power, pan(this.sim.ball.p), e.smash);
        this.input.rumble(e.smash ? 'smash' : e.oops ? 'oops' : 'hit');
        if (e.oops) this.hud.flash('哎呀!', '', 0.9, 'bad');
        if (e.smash) this.hud.flash('扣杀!', '', 0.9, 'big');
        break;
      case 'whiff':
        this.hud.flash(WHIFF_TEXT[e.reason], '', 0.9, 'bad');
        break;
      case 'volley':
        this.hud.flash('未落台击球', '球还没在你这边弹起', 1.4, 'bad');
        break;
      case 'bounce':
        this.sfx.table(e.impact, pan(e.p));
        break;
      case 'net':
        this.sfx.net(e.impact);
        break;
      case 'floor':
        this.sfx.floor(e.impact, pan(e.p));
        break;
      case 'result':
        this.showResult(e.report);
        this.renderStats();
        break;
      default:
        break;
    }
  }

  private showResult(r: ShotReport): void {
    const good = r.result === 'in';
    if (
      !good &&
      r.result !== 'early' &&
      r.result !== 'late' &&
      r.result !== 'reach' &&
      r.result !== 'volley'
    ) {
      this.hud.flash(FEED_RESULT_TEXT[r.result], '', 1.0, 'bad');
    } else if (good) {
      this.hud.flash('好球!', '', 0.7, 'good');
    }
    const timing = r.timingMs;
    const pos = timing === null ? 50 : clamp(50 + (timing / 160) * 50, 0, 100);
    const tText =
      timing === null
        ? '没挥拍'
        : Math.abs(timing) <= 20
          ? '时机正好'
          : `${timing < 0 ? '早' : '晚'} ${Math.abs(timing)}ms`;
    const spinText =
      r.kind === null
        ? '—'
        : r.smash
          ? '扣杀'
          : r.rushed
            ? '哎呀高球'
            : `${SHOT_KIND_TEXT[r.kind]}（旋转 ${r.spin >= 0.15 ? '上旋' : r.spin <= -0.15 ? '下旋' : '平'}）`;
    this.cardEl.innerHTML = `
      <div class="pr-card-title ${good ? 'ok' : 'bad'}">${FEED_RESULT_TEXT[r.result]}</div>
      <div class="pr-row"><span>时机</span><b>${tText}</b></div>
      <div class="pr-gauge"><i class="zone"></i><em style="left:${pos}%"></em><small class="l">早</small><small class="r">晚</small></div>
      <div class="pr-row"><span>正反手</span><b>${r.stroke === null ? '—' : r.stroke === 'fh' ? '正手' : '反手'}</b></div>
      <div class="pr-row"><span>力度</span><b>${r.kind === null ? '—' : `${Math.round(r.power * 100)}%`}</b></div>
      <div class="pr-row"><span>球路</span><b>${spinText}</b></div>
      <div class="pr-row dim"><span>来球</span><b>${SPIN_TEXT[r.feedSpin] ?? ''}</b></div>`;
    this.cardEl.classList.add('show');
  }

  private renderStats(): void {
    const st = this.sim.stats;
    const total = Object.values(st.results).reduce((a, b) => a + (b ?? 0), 0);
    const inN = st.results.in ?? 0;
    const med = this.sim.medianTiming();
    this.statsEl.innerHTML = `
      <div class="pr-title">发球机练习 · ${LEVEL_TEXT[this.settings.level]} · ${ZONE_TEXT[this.settings.zone]}</div>
      <div>回进 <b>${inN}</b> / ${total}${total ? `（${Math.round((inN / total) * 100)}%）` : ''} · 连续 <b>${st.streak}</b>（最佳 ${st.bestStreak}）</div>
      ${med === null ? '' : `<div class="dim">最近的时机中位数：${med === 0 ? '正好' : `${med < 0 ? '早' : '晚'} ${Math.abs(med)}ms`}</div>`}`;
  }

  private showSwing(dir: number, w: number, path: string): void {
    const side = dir > 0 ? '正手' : dir < 0 ? '反手' : '上下挥';
    this.swingEl.textContent = `挥拍：${side} · ${w.toFixed(0)} rad/s${path === 'gentle' ? '（慢）' : ''}`;
    this.swingEl.classList.add('show');
    window.clearTimeout(this.swingTimer);
    this.swingTimer = window.setTimeout(() => this.swingEl.classList.remove('show'), 1200);
  }

  private swingTimer = 0;

  private updateStatus(now: number): void {
    if (now - this.lastStatus < 300) return;
    this.lastStatus = now;
    const dev = deviceLine(
      this.input,
      this.keyboard,
      '键盘（F 正手 · J 反手 · 按住 W 上旋 / S 下旋 · Shift 大力）',
      now
    );
    const rec = this.rec;
    const recText = rec
      ? `<br/><span class="pr-rec">● 录制中 · 已录 ${rec.results} / ${RECORD_MAX_BALLS} 球 · ${Math.floor(rec.elapsedMs / 60000)}:${String(Math.floor(rec.elapsedMs / 1000) % 60).padStart(2, '0')}</span>`
      : '';
    this.statusEl.innerHTML = `${dev}<br/><span class="dim">暂停：手机「暂停」/ Joy-Con + / Esc · 回中（指向电视按）：Joy-Con X + ZR 或 Y / 手机「回中」 · 画面延迟补偿 ${this.latencyMs}ms</span>${recText}`;
  }

  private lastStatus = 0;

  private renderPause(): void {
    const p = this.pauseEl;
    p.hidden = !this.paused;
    if (!this.paused) return;
    const s = this.settings;
    const med = this.sim.medianTiming();
    const opt = <T extends string | number>(name: string, value: T, cur: T, text: string) =>
      `<button class="${value === cur ? 'on' : ''}" data-set="${name}" data-val="${value}">${text}</button>`;
    p.innerHTML = `
      <div class="pr-panel">
        <h2>暂停</h2>
        <div class="pr-setting"><span>难度</span>${([1, 2, 3] as FeedLevel[]).map((l) => opt('level', l, s.level, LEVEL_TEXT[l])).join('')}</div>
        <div class="pr-setting"><span>落点</span>${(['mixed', 'fh', 'bh'] as FeedZone[]).map((z) => opt('zone', z, s.zone, ZONE_TEXT[z])).join('')}</div>
        <div class="pr-setting"><span>宽容度</span>${[0.2, 0.6, 1].map((v) => opt('leniency', v, s.leniency, v < 0.4 ? '严格' : v < 0.8 ? '标准' : '宽松')).join('')}</div>
        <div class="pr-setting"><span>画面延迟补偿<small class="dim">（这块屏幕 ${screenKey()}）</small></span>
          <button data-lat="-10">−10</button><b class="pr-lat">${this.latencyMs} ms</b><button data-lat="10">+10</button>
          ${med === null ? '<span class="dim">（打满 5 球后可以按平均时机自动校准）</span>' : `<button data-act="autolat">按我的平均时机校准（${med < 0 ? '早' : '晚'} ${Math.abs(med)}ms）</button>`}
        </div>
        <div class="pr-setting"><span>持拍手</span>${opt('handed', 1, this.input.handed, '右手')}${opt('handed', -1, this.input.handed, '左手')}</div>
        <div class="pr-setting"><span>录制这局</span>
          ${this.rec ? `<button class="on" data-act="rec-stop">停止并下载（已录 ${this.rec.results} 球）</button>` : '<button data-act="rec-start">开始录制</button>'}
          <span class="dim">打满 ${RECORD_MAX_BALLS} 球或 ${RECORD_MAX_MS / 60000} 分钟自动停止并下载，把文件发给开发者分析</span>
        </div>
        <div class="pr-actions">
          <button class="primary" data-act="resume">继续练习</button>
          <button data-act="recal">重新校准拍面</button>
          <a href="./"><button>返回首页</button></a>
        </div>
      </div>`;
    p.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((b) =>
      b.addEventListener('click', () => {
        const name = b.dataset.set!;
        const raw = b.dataset.val!;
        if (name === 'handed') {
          this.input.setHanded(raw === '-1' ? -1 : 1);
          this.restartSim();
          this.sim.pause(true);
        } else {
          const v = name === 'zone' ? raw : Number(raw);
          (this.settings as unknown as Record<string, unknown>)[name] = v;
          saveSettings(this.settings);
          this.restartSim();
          this.sim.pause(true);
        }
        this.renderPause();
      })
    );
    p.querySelectorAll<HTMLButtonElement>('[data-lat]').forEach((b) =>
      b.addEventListener('click', () => {
        this.setLatency(this.latencyMs + Number(b.dataset.lat));
        this.renderPause();
      })
    );
    p.querySelector('[data-act="autolat"]')?.addEventListener('click', () => {
      const m = this.sim.medianTiming();
      if (m !== null) {
        this.setLatency(this.latencyMs + m);
        this.sim.stats.timings.length = 0;
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
    p.querySelector('[data-act="resume"]')?.addEventListener('click', () => this.togglePause());
    p.querySelector('[data-act="recal"]')?.addEventListener('click', () => {
      this.paused = false;
      this.pauseEl.hidden = true;
      this.sim.pause(true);
      this.setup.restart();
    });
  }
}
