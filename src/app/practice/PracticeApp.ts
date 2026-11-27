/**
 * 发球机练习页：连接设备 → 校准（拍头指向电视，Joy-Con 按住 X + ZR）→ 选难度和送球区域 → 发球机送球，玩家挥拍回球。
 * 每一球给出结果卡片（好球还是出界、时机早晚、正反手、球路）。开始前、暂停都是电视面板；
 * 多球训练和「录制这局」只在开发时（?debug=1）有。
 */
import './practice.css';
import { Sfx } from '@/audio/Sfx';
import { tuning } from '@/config/tuning';
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
import { ballSpin } from '@/render/BallView';
import { Renderer } from '@/render/Renderer';
import { Hud } from '@/ui/Hud';
import { howToSeen, howToView } from '@/ui/tv/howto';
import { spinRow, TvOverlay, tvButton } from '@/ui/tv/TvOverlay';
import { MotionInput, type SwingEventOut } from '../input/MotionInput';
import type { PlayContext } from '../shell/context';
import { latencyMs, screenKey, setLatencyMs } from '../shared/latency';
import { deviceLine, deviceSwingInput, HumanPaddle, keySwingInput } from '../shared/motionPlay';
import { loadPrefs } from '../shared/prefs';
import { deviceWords, SetupFlow } from '../shared/SetupFlow';
import { calibrateView, SettingsPanel } from '../shared/settingsView';
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
  /** 多球训练（开发用）：0 = 单球，1 = 多球（一击球就送下一球） */
  multi: number;
}

const SETTINGS_KEY = 'rea-practice';

function loadSettings(): Settings {
  const def: Settings = { level: 1, zone: 'mixed', multi: 0 };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    return {
      level: s?.level ?? def.level,
      zone: s?.zone ?? def.zone,
      multi: DEV ? (s?.multi ?? def.multi) : 0,
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

/** connect / point = 连接、校准；ready = 开始前（选难度和送球区域）；play = 送球中（含暂停） */
type Step = 'connect' | 'point' | 'ready' | 'play';

/** 开发用（?debug=1）：多球训练、录制这局、挥拍速度小字 */
const DEV = new URLSearchParams(location.search).has('debug');

const LEVELS: readonly FeedLevel[] = [1, 2, 3];
const ZONES: readonly FeedZone[] = ['mixed', 'fh', 'bh'];
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
  private readonly sfx: Sfx;
  private readonly input: MotionInput;
  /** 这个页面自己的文字层、按键监听（离开时整块拿掉）；离开了就停 */
  private readonly layer: HTMLDivElement;
  private readonly abort = new AbortController();
  private disposed = false;
  /** 画面上你的球拍（挥拍开始、结束时平滑过渡） */
  private readonly paddleView = new HumanPaddle();
  private sim: FeederSim;
  private settings = loadSettings();
  private readonly setup: SetupFlow;
  private keyboard = false;
  private paused = false;
  /** 开始前的面板按过「开始」了 */
  private started = false;
  /** 暂停里正在「重新校准」 */
  private calibrating = false;

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
  private readonly statsEl: HTMLDivElement;
  private readonly cardEl: HTMLDivElement;
  private readonly statusEl: HTMLDivElement;
  private readonly swingEl: HTMLDivElement;
  /** 电视面板：开始前、暂停、设置、校准、怎么玩 */
  private readonly tv: TvOverlay;
  private readonly settingsPanel: SettingsPanel;

  /** ctx：电视界面里用界面共用的画面、声音、输入，手柄已经连好；不给就自己建（直接用网址打开） */
  constructor(
    root: HTMLElement,
    private readonly ctx: PlayContext | null = null
  ) {
    root.className = 'game-root practice';
    if (ctx) {
      this.renderer = ctx.renderer;
      this.hud = ctx.hud;
      this.hud.setNames({ near: '我', far: '发球机' });
      this.sfx = ctx.sfx;
      this.input = ctx.input;
      this.input.multi = false;
    } else {
      const canvas = document.createElement('canvas');
      canvas.className = 'game-canvas';
      root.appendChild(canvas);
      this.renderer = new Renderer(canvas);
      this.hud = new Hud(root, { near: '我', far: '发球机' });
      this.sfx = new Sfx();
      this.input = new MotionInput();
    }
    this.sim = this.makeSim();
    this.layer = document.createElement('div');
    root.appendChild(this.layer);
    root = this.layer;

    root.insertAdjacentHTML(
      'beforeend',
      `<div class="pr-stats" hidden></div>
       <div class="pr-card"></div>
       <div class="pr-status"${ctx ? ' hidden' : ''}></div>
       <div class="pr-swing"${DEV ? '' : ' hidden'}></div>`
    );
    this.statsEl = root.querySelector('.pr-stats')!;
    this.cardEl = root.querySelector('.pr-card')!;
    this.statusEl = root.querySelector('.pr-status')!;
    this.swingEl = root.querySelector('.pr-swing')!;
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
      title: '练习',
      keyboardHelp: 'F 正手、J 反手，按键时机 = 击球时机。',
      onDone: (msg) => this.afterSetup(msg),
      onKeyboard: () => {
        this.keyboard = true;
        this.afterSetup('键盘练习：F 正手、J 反手');
      },
      onBack: () => this.exit(),
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
    window.addEventListener('pointerdown', () => this.sfx.unlock(), { signal });
    // 电视界面里手柄已经加入、定过方向：直接到开始前的面板；键盘玩家（开发用）也一样
    if (ctx && ctx.players[0]?.device === null) {
      this.setup.skip();
      this.keyboard = true;
      this.showReady();
    } else if (ctx && this.setup.skipIfReady()) this.showReady();
    else this.setup.render();
    this.renderStats();
    void this.input.start().then(() => this.setup.render());
    // 冒烟测试 / 调试用：?debug=1 时把实例挂到 window 上
    if (new URLSearchParams(location.search).has('debug')) {
      // 调参面板只在直接用网址打开时（电视界面里离开练习后它还会留着）
      if (!ctx)
        void import('@/debug/TuningPanel').then((m) =>
          m.createTuningPanel(() => this.sim.applyTuning())
        );
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

  /** 连接、校准之后：开始前的面板，按了开始就是练习本身 */
  private get step(): Step {
    const s = this.setup.step;
    return s !== 'done' ? s : this.started ? 'play' : 'ready';
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
      leniency: loadPrefs().leniency,
      multi: s.multi,
      handed: this.input?.handed ?? 1,
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

  /** 离开练习（回到电视菜单）：停下主循环，拿掉文字层和按键监听 */
  dispose(): void {
    if (this.rec) this.stopRecording();
    this.disposed = true;
    this.abort.abort();
    this.layer.remove();
    this.hud.clearFlash();
  }

  private loop(): void {
    if (this.disposed) return;
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
      spin: ballSpin(s.ball.v, s.ball.w),
      players: { near: { player: s.player, body, paddle: this.nearPaddle(t, body) } },
      machine: s.machine,
      extraBalls: [...s.flyers, ...s.spent].map((f) => f.ball.p),
    });
  }

  /** 玩家的球拍：已校准时朝向 1:1 跟随设备，位置在手上；挥拍时位置跟随挥拍动画（之间平滑过渡） */
  private nearPaddle(t: number, body: { x: number; y: number }) {
    const paddle = this.keyboard ? null : (this.input.active?.paddle ?? null);
    return this.paddleView.pose(paddle, this.sim.player, body, t);
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
    if (this.tv.key(e)) return;
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
    if (this.setup.onButton(b)) return;
    // 面板上：A 确定、B 返回；暂停里再按 + 继续
    if (this.tv.visible) {
      if (b === 'confirm') this.tv.confirm();
      else if (b === 'back') this.tv.back();
      else if (b === 'pause' && this.paused) this.togglePause();
      return;
    }
    if (b === 'pause') {
      if (this.step === 'play') this.togglePause();
      return;
    }
    if (this.step === 'play' && !this.paused && b === 'recenter') {
      const head = deviceWords(this.input.active).head;
      if (this.input.recenter()) this.hud.flash('已回中', '', 0.8);
      else this.hud.flash('没能回中', `把${head}像遥控器一样指向电视再按`, 1.4, 'bad');
    }
  }

  // ---------------------------------------------------------------- 流程

  private afterSetup(msg: string): void {
    this.hud.flash(msg, '', 1.2, 'good');
    this.showReady();
  }

  /** 开始前的面板（第一次玩先看「怎么玩」） */
  private showReady(): void {
    this.started = false;
    if (howToSeen('practice')) this.renderReady();
    else this.tv.show(howToView('practice', () => this.renderReady()));
  }

  private startPlay(): void {
    this.started = true;
    this.paused = false;
    this.tv.hide();
    this.sim.pause(false);
    this.hud.flash('开始', '发球机开始送球', 1.2, 'good');
    this.renderStats();
  }

  private togglePause(): void {
    if (this.step !== 'play') return;
    this.paused = !this.paused;
    this.calibrating = false;
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

  /** 难度、送球区域、多球改了：存下来，发球机换一台（这一组的统计清零） */
  private spinSetting(name: string, d: -1 | 1): void {
    const s = this.settings;
    const next = <T>(list: readonly T[], cur: T) =>
      list[(list.indexOf(cur) + d + list.length) % list.length];
    if (name === 'level') s.level = next(LEVELS, s.level);
    else if (name === 'zone') s.zone = next(ZONES, s.zone);
    else if (name === 'multi') s.multi = s.multi ? 0 : 1;
    saveSettings(s);
    this.restartSim();
    this.sim.pause(true);
  }

  /** 难度、送球区域（开发时多一行多球） */
  private settingRows(): string {
    const s = this.settings;
    return `${spinRow('level', '难度', LEVEL_TEXT[s.level])}
      ${spinRow('zone', '送球区域', ZONE_TEXT[s.zone])}
      ${DEV ? spinRow('multi', '多球（开发）', s.multi ? '多球' : '单球') : ''}`;
  }

  // ---------------------------------------------------------------- 录制这局

  private settingsLog(): PracticeSettingsLog {
    const s = this.settings;
    const cfg = this.sim.resolver.cfg;
    return {
      level: s.level,
      zone: s.zone,
      multi: s.multi,
      leniency: this.sim.leniency,
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
        this.sfx.hit(e.power, pan(e.p), e.smash);
        this.renderer.hitEffect(e.p, e.smash);
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
        this.renderer.bounceEffect(e.p);
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
    const shot =
      r.kind === null
        ? ''
        : [
            r.stroke === null ? '' : r.stroke === 'fh' ? '正手' : '反手',
            r.smash
              ? '扣杀'
              : r.rushed
                ? '哎呀高球'
                : `${SHOT_KIND_TEXT[r.kind]}${r.spin >= 0.15 ? ' · 上旋' : r.spin <= -0.15 ? ' · 下旋' : ''}`,
            `力度 ${Math.round(r.power * 100)}%`,
          ]
            .filter(Boolean)
            .join(' · ');
    this.cardEl.innerHTML = `
      <div class="pr-card-title ${good ? 'ok' : 'bad'}">${FEED_RESULT_TEXT[r.result]}</div>
      <div class="pr-card-timing">${tText}</div>
      <div class="pr-gauge"><i class="zone"></i><em style="left:${pos}%"></em><small class="l">早</small><small class="r">晚</small></div>
      ${shot ? `<div class="pr-card-shot">${shot}</div>` : ''}
      <div class="pr-card-feed">来球 ${SPIN_TEXT[r.feedSpin] ?? ''}</div>`;
    this.cardEl.classList.add('show');
  }

  /** 左上角：回进几球、连续几球 */
  private renderStats(): void {
    const st = this.sim.stats;
    const total = Object.values(st.results).reduce((a, b) => a + (b ?? 0), 0);
    const inN = st.results.in ?? 0;
    this.statsEl.hidden = this.step !== 'play';
    this.statsEl.innerHTML = `
      <div class="pr-stat"><span>回进</span><b>${inN}</b><small>/ ${total}</small></div>
      <div class="pr-stat"><span>连续</span><b>${st.streak}</b><small>最佳 ${st.bestStreak}</small></div>
      <div class="pr-stat-mode">${LEVEL_TEXT[this.settings.level]} · ${ZONE_TEXT[this.settings.zone]}${this.settings.multi ? ' · 多球' : ''}</div>`;
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

  /** 开始前：难度、送球区域，A 开始 */
  private renderReady(keep = false): void {
    this.tv.show(
      {
        html: `<h2>练习</h2>
          ${this.settingRows()}
          <div class="tv-buttons">
            ${tvButton('start', '开始', true, true)}
            ${tvButton('howto', '怎么玩')}
            ${tvButton('home', '回到菜单')}
          </div>`,
        hints: [
          ['▲▼', '选择'],
          ['◀▶', '修改'],
          ['A', '确定'],
          ['B', '回到菜单'],
        ],
        onBack: () => this.exit(),
        onSpin: (name, d) => {
          this.spinSetting(name, d);
          this.renderReady(true);
        },
        onAct: (act) => {
          if (act === 'start') this.startPlay();
          else if (act === 'howto') this.tv.show(howToView('practice', () => this.renderReady()));
          else if (act === 'home') this.exit();
        },
      },
      keep
    );
  }

  /** 暂停：难度、送球区域；继续、重新校准、设置、怎么玩、回到菜单（开发时多「录制这局」） */
  private renderPause(keep = false): void {
    if (!this.paused) {
      this.tv.hide();
      return;
    }
    this.calibrating = false;
    const st = this.sim.stats;
    const total = Object.values(st.results).reduce((a, b) => a + (b ?? 0), 0);
    const med = this.sim.medianTiming();
    this.tv.show(
      {
        html: `<h2>暂停</h2>
          <p class="tv-note">回进 ${st.results.in ?? 0} / ${total} · 最多连续 ${st.bestStreak}</p>
          ${this.settingRows()}
          <div class="tv-buttons">
            ${tvButton('resume', '继续', true, true)}
            ${this.keyboard ? '' : tvButton('recal', '重新校准')}
            ${med === null ? '' : tvButton('autolat', `按我的平均时机校准画面延迟（${med < 0 ? '早' : '晚'} ${Math.abs(med)}ms）`)}
            ${tvButton('settings', '设置')}
            ${tvButton('howto', '怎么玩')}
            ${DEV ? tvButton(this.rec ? 'rec-stop' : 'rec-start', this.rec ? `停止录制并下载（已录 ${this.rec.results} 球）` : '录制这局（开发）') : ''}
            ${tvButton('home', '回到菜单')}
          </div>`,
        hints: [
          ['▲▼', '选择'],
          ['◀▶', '修改'],
          ['A', '确定'],
          ['B', '继续'],
        ],
        onBack: () => this.togglePause(),
        onSpin: (name, d) => {
          this.spinSetting(name, d);
          this.renderPause(true);
        },
        onAct: (act) => {
          if (act === 'resume') this.togglePause();
          else if (act === 'recal') {
            this.calibrating = true;
            this.tv.show(calibrateView(this.input, () => this.renderPause()));
          } else if (act === 'settings') this.settingsPanel.show();
          else if (act === 'howto') this.tv.show(howToView('practice', () => this.renderPause()));
          else if (act === 'home') this.exit();
          else if (act === 'autolat') {
            const m = this.sim.medianTiming();
            if (m !== null) {
              this.setLatency(this.latencyMs + m);
              this.sim.stats.timings.length = 0;
              this.hud.flash('画面延迟已校准', `${this.latencyMs} ms`, 1.2, 'good');
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
      },
      keep
    );
  }
}
