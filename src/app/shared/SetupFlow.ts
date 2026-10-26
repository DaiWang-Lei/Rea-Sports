/**
 * 连接与校准（练习、比赛共用）：连接设备 → 拍头像遥控器一样指向电视、按键（像 Nintendo Switch Sports）。
 *  - Joy-Con：肩键一端指向电视，按住 X + R（Joy-Con L：↑ + L）；按 Y / A 也行；
 *  - 手机：顶端指向电视，按「确认」。
 * 和打球中的回中是同一个动作，立即完成。陀螺仪零点不用专门测：Joy-Con 放在桌上不动 2 秒会在后台自动重测。
 * 画在给定的遮罩层里；校准完成（或跳过）后调 onDone，选了键盘调 onKeyboard。
 * 打球中按住 X + R 回中的结果也由这里给出提示（onCalibrate）。
 */
import QRCode from 'qrcode';
import type { Sfx } from '@/audio/Sfx';
import type { Hud } from '@/ui/Hud';
import type { CalibrateResult, MotionInput } from '../input/MotionInput';

export type SetupStep = 'connect' | 'point' | 'done';

/** 当前设备的叫法：拍头是哪一端、校准和回中按哪个键 */
export function deviceWords(input: MotionInput): {
  phone: boolean;
  head: string;
  combo: string;
  /** 回中键：手机「回中」，Joy-Con R 的 Y，Joy-Con L 的 ↑ */
  recenterKey: string;
} {
  const d = input.active;
  const phone = d?.kind === 'phone';
  const left = d?.joycon?.side === 'L';
  return {
    phone,
    head: phone ? '手机顶端' : '肩键一端',
    combo: phone ? '「确认」' : left ? '↑ + L' : 'X + R',
    recenterKey: phone ? '「回中」' : left ? '↑' : 'Y',
  };
}

export interface SetupOptions {
  /** 连接页标题里的模式名，例如「发球机练习」 */
  title: string;
  /** 校准完成或跳过；msg = 中央提示 */
  onDone: (msg: string) => void;
  /** 选了「用键盘试一试」 */
  onKeyboard: () => void;
  /** 键盘模式的说明（连接页上） */
  keyboardHelp: string;
}

export class SetupFlow {
  step: SetupStep = 'connect';
  private linkStatus = { text: '正在准备手机连接…', ok: false };
  private shownStep: SetupStep | null = null;
  private shownKind: string | null = null;

  constructor(
    private readonly overlay: HTMLDivElement,
    private readonly input: MotionInput,
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly opts: SetupOptions
  ) {}

  get done(): boolean {
    return this.step === 'done';
  }

  setLinkStatus(text: string, ok: boolean): void {
    this.linkStatus = { text, ok };
    this.render();
  }

  /** 重新校准（暂停菜单里） */
  restart(): void {
    this.step = 'point';
    this.shownStep = null;
    this.render();
  }

  /** 每帧调用：连上设备后进入校准 */
  tick(): void {
    if (this.step === 'done') return;
    if (this.step === 'connect' && this.input.streaming) this.render();
    if (this.step === 'point' && this.input.streaming) this.renderLive();
  }

  /**
   * 校准这一步的按键：「确认」「回中」（Joy-Con 的 A / Y、手机的按钮）都按指向电视校准；
   * Joy-Con 的 X + R 组合键由 MotionInput 识别，结果走 onCalibrate。返回 true = 已处理
   */
  onButton(b: string): boolean {
    if (this.step !== 'point' || (b !== 'confirm' && b !== 'recenter')) return false;
    this.input.requestCalibration();
    return true;
  }

  /** 校准 / 回中的结果：校准这一步里完成流程；打球中给出提示 */
  onCalibrate(result: CalibrateResult): void {
    const w = deviceWords(this.input);
    if (result === 'done') {
      this.sfx.beep(1040, 0.1);
      if (this.step === 'point') this.finish('校准完成');
      else if (this.step === 'done') this.hud.flash('已回中', '', 0.8);
    } else {
      this.hud.flash(`${w.head}别朝上或朝下`, `像遥控器一样指向电视再按`, 1.6, 'bad');
    }
  }

  /** 设备列表、连接状态变了：重画 */
  render(): void {
    if (this.step === 'done') return;
    const o = this.overlay;
    o.hidden = false;
    if (this.step === 'connect' && this.input.active && this.input.streaming) this.step = 'point';
    if (this.step !== 'connect') {
      this.renderLive(true);
      return;
    }
    o.innerHTML = `
      <div class="pr-panel">
        <h2>${this.opts.title} · 连接体感设备</h2>
        <div class="pr-connect">
          <div class="pr-box">
            <h3>用手机</h3>
            <canvas class="pr-qr" width="180" height="180"></canvas>
            <ol class="pr-steps">
              <li>手机和这台电脑连同一个 Wi-Fi，用相机（iPhone）或 Chrome（安卓）扫码，不要用微信扫。</li>
              <li>在手机上点「开始」，iPhone 选「允许」动作与方向。</li>
            </ol>
            <div class="pr-link ${this.linkStatus.ok ? 'ok' : 'warn'}">● ${this.linkStatus.text}</div>
            ${this.input.room ? `<div class="pr-room">房间号 ${this.input.room}</div>` : ''}
          </div>
          <div class="pr-box">
            <h3>用 Joy-Con</h3>
            <p class="dim">先在系统蓝牙里配对，再点下面的按钮选择手柄。</p>
            <button class="primary" data-act="joycon" ${this.input.webHidSupported ? '' : 'disabled'}>连接 Joy-Con</button>
            <h3 class="pr-gap">没有设备？</h3>
            <button data-act="keyboard">用键盘试一试</button>
            <p class="dim small">${this.opts.keyboardHelp}</p>
          </div>
        </div>
        <p class="dim small">⚠️ 握紧设备、最好挂上腕带 / 手机绳，注意周围的人和物品。</p>
        <p><a href="./">返回首页</a></p>
      </div>`;
    const qr = o.querySelector<HTMLCanvasElement>('.pr-qr');
    if (qr && this.input.phoneUrl) {
      void QRCode.toCanvas(qr, this.input.phoneUrl, { width: 180, margin: 1 });
    }
    o.querySelector('[data-act="joycon"]')?.addEventListener('click', () => {
      void this.input.requestJoyCon().catch(() => {});
    });
    o.querySelector('[data-act="keyboard"]')?.addEventListener('click', () => {
      this.step = 'done';
      o.hidden = true;
      this.opts.onKeyboard();
    });
  }

  private finish(msg: string): void {
    this.step = 'done';
    this.overlay.hidden = true;
    this.opts.onDone(msg);
  }

  /** 校准这一步：内容按设备类型给出按键提示 */
  private renderLive(force = false): void {
    const kind = `${this.input.active?.kind}-${this.input.active?.joycon?.side ?? ''}`;
    if (!force && this.shownStep === this.step && this.shownKind === kind) return;
    this.shownStep = this.step;
    this.shownKind = kind;
    const o = this.overlay;
    const dev = this.input.active;
    const w = deviceWords(this.input);
    const body = w.phone
      ? `<h2>校准：指向电视</h2>
         <p class="pr-big">把手机<b>顶端像遥控器一样指向电视</b>，按手机上的「确认」。</p>
         <p class="dim">这一步定下电视的方向。之后手机就是球拍：顶端是拍头，屏幕是正手面（红面）。
         打球中觉得拍子方向偏了，同样指向电视按手机上的${w.recenterKey}就能回中；等球时拿稳不动，游戏也会自动去掉漂移。</p>`
      : `<h2>校准：指向电视</h2>
         <p class="pr-big">把 Joy-Con 的<b>肩键一端像遥控器一样指向电视</b>，<b>按住 ${w.combo}</b>。</p>
         <p class="dim">这一步定下电视的方向。之后 Joy-Con 就是球拍：肩键一端是拍头，按键面是正手面（红面）。
         打球中觉得拍子方向偏了，同样指向电视按住 ${w.combo}（或按 ${w.recenterKey}）就能回中；等球时拿稳不动，游戏也会自动去掉漂移。
         放在桌上不动 2 秒会自动重测陀螺仪零点。</p>`;
    o.innerHTML = `
      <div class="pr-panel">
        ${body}
        <p class="dim">当前设备：${dev ? dev.name : '—'}</p>
        <div class="pr-actions">
          <button data-act="skip">跳过校准，直接开始（只判断时机和力度）</button>
        </div>
      </div>`;
    o.querySelector('[data-act="skip"]')?.addEventListener('click', () => {
      this.input.recenter();
      this.finish('已跳过拍面校准');
    });
  }
}
