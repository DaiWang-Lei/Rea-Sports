/**
 * 连接与校准（练习、比赛共用）：连接设备 → 拍头像遥控器一样指向电视、按键（像 Nintendo Switch Sports）。
 *  - Joy-Con：肩键一端指向电视，按住 X + ZR（Joy-Con L：↑ + ZL）；按 Y / A 也行；
 *  - 手机：顶端指向电视，按「确认」。
 * 和打球中的回中是同一个动作，立即完成。陀螺仪零点不用专门测：Joy-Con 放在桌上不动 2 秒会在后台自动重测。
 * 画在玩法自己的电视面板上（摇杆 / 方向键选、A 确定、B 回到菜单）；校准完成（或跳过）后调 onDone，选了键盘调 onKeyboard。
 * 打球中按住 X + ZR 回中的结果也由这里给出提示（onCalibrate）。
 */
import QRCode from 'qrcode';
import type { Sfx } from '@/audio/Sfx';
import type { Hud } from '@/ui/Hud';
import { POINT_ART } from '@/ui/tv/howto';
import { type TvOverlay, tvButton } from '@/ui/tv/TvOverlay';
import type { CalibrateResult, InputDevice, MotionInput } from '../input/MotionInput';

export type SetupStep = 'connect' | 'point' | 'done';

/** 设备的叫法：拍头是哪一端、确认 / 校准 / 回中按哪个键 */
export function deviceWords(d: InputDevice | null): {
  phone: boolean;
  head: string;
  /** 确认键：手机「确认」，Joy-Con R 的 A，Joy-Con L 的 → */
  confirm: string;
  combo: string;
  /** 回中键：手机「回中」，Joy-Con R 的 Y，Joy-Con L 的 ↑ */
  recenterKey: string;
} {
  const phone = d?.kind === 'phone';
  const left = d?.joycon?.side === 'L';
  return {
    phone,
    head: phone ? '手机顶端' : '肩键一端',
    confirm: phone ? '「确认」' : left ? '→' : 'A',
    combo: phone ? '「确认」' : left ? '↑ + ZL' : 'X + ZR',
    recenterKey: phone ? '「回中」' : left ? '↑' : 'Y',
  };
}

export interface SetupOptions {
  /** 连接页的标题（玩法名，例如「练习」） */
  title: string;
  /** 校准完成或跳过；msg = 中央提示 */
  onDone: (msg: string) => void;
  /** 选了「用键盘试一试」 */
  onKeyboard: () => void;
  /** 键盘模式的说明（连接页上） */
  keyboardHelp: string;
  /** 给了就在连接页上放「两个人玩」（和电脑对打） */
  onTwoPlayers?: () => void;
  /** 「回到菜单」或 B */
  onBack: () => void;
}

export class SetupFlow {
  step: SetupStep = 'connect';
  private shownStep: SetupStep | null = null;
  private shownKind: string | null = null;

  constructor(
    private readonly tv: TvOverlay,
    private readonly input: MotionInput,
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly opts: SetupOptions
  ) {}

  get done(): boolean {
    return this.step === 'done';
  }

  /** 手机连接状态变了（状态本身在 input.linkStatus） */
  linkChanged(): void {
    this.render();
  }

  /** 不用连接、校准（电视界面里用键盘的玩家，开发用） */
  skip(): void {
    this.step = 'done';
    this.tv.hide();
  }

  /** 手柄已经连着、定过电视方向（电视界面里加入过、或从双人切过来）：不用再连接、校准。返回 true = 已跳过 */
  skipIfReady(): boolean {
    const d = this.input.active;
    if (!d || !this.input.streaming || !d.paddle.calibrated) return false;
    this.skip();
    return true;
  }

  /** 每帧调用：连上设备后进入校准 */
  tick(): void {
    if (this.step === 'done') return;
    if (this.step === 'connect' && this.input.streaming) this.render();
    if (this.step === 'point' && this.input.streaming) this.renderPoint();
  }

  /**
   * 校准这一步的按键：「确认」「回中」（Joy-Con 的 A / Y、手机的按钮）都按指向电视校准；
   * Joy-Con 的 X + ZR 组合键由 MotionInput 识别，结果走 onCalibrate。返回 true = 已处理
   */
  onButton(b: string): boolean {
    if (this.step !== 'point' || (b !== 'confirm' && b !== 'recenter')) return false;
    this.input.requestCalibration();
    return true;
  }

  /** 校准 / 回中的结果：校准这一步里完成流程；打球中给出提示 */
  onCalibrate(result: CalibrateResult): void {
    const w = deviceWords(this.input.active);
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
    if (this.step === 'connect' && this.input.active && this.input.streaming) this.step = 'point';
    if (this.step !== 'connect') {
      this.renderPoint(true);
      return;
    }
    const keep = this.shownStep === 'connect';
    this.shownStep = 'connect';
    const link = this.input.linkStatus;
    this.tv.show(
      {
        className: 'tv-wide',
        html: `<h2>${this.opts.title}</h2>
        <div class="tv-setup">
          <div class="tv-setup-box">
            <h3>用手机</h3>
            <canvas width="200" height="200"></canvas>
            <ol>
              <li>和电脑连同一个 Wi-Fi，用相机或浏览器扫码（不要用微信）</li>
              <li>点「开始」，iPhone 选「允许」</li>
            </ol>
            <div class="tv-link ${link.ok ? 'ok' : 'warn'}">● ${link.text}${this.input.room ? ` · 房间 ${this.input.room}` : ''}</div>
          </div>
          <div class="tv-setup-box">
            <h3>用 Joy-Con</h3>
            <p class="tv-note">先在电脑的蓝牙里配对，再用鼠标点这里</p>
            ${this.input.webHidSupported ? tvButton('joycon', '连接 Joy-Con', true, true) : '<p class="tv-note">这个浏览器连不了 Joy-Con，请用桌面版 Chrome</p>'}
            ${tvButton('keyboard', '用键盘试一试')}
            <p class="tv-note">${this.opts.keyboardHelp}</p>
          </div>
        </div>
        <p class="tv-note">握紧设备、最好挂上腕带 / 手机绳，注意周围的人和物品</p>
        <div class="tv-buttons tv-inline">
          ${this.opts.onTwoPlayers ? tvButton('versus', '两个人玩') : ''}
          ${tvButton('home', '回到菜单')}
        </div>`,
        hints: [
          ['A', '确定'],
          ['B', '回到菜单'],
        ],
        onBack: this.opts.onBack,
        onAct: (act) => {
          if (act === 'joycon') void this.input.requestJoyCon().catch(() => {});
          else if (act === 'versus') this.opts.onTwoPlayers?.();
          else if (act === 'home') this.opts.onBack();
          else if (act === 'keyboard') {
            this.step = 'done';
            this.tv.hide();
            this.opts.onKeyboard();
          }
        },
      },
      keep
    );
    const qr = this.tv.el.querySelector<HTMLCanvasElement>('.tv-setup canvas');
    if (qr && this.input.phoneUrl) {
      void QRCode.toCanvas(qr, this.input.phoneUrl, { width: 200, margin: 1 });
    }
  }

  private finish(msg: string): void {
    this.step = 'done';
    this.tv.hide();
    this.opts.onDone(msg);
  }

  /** 校准这一步：拍头像遥控器一样指向电视，按确认（按设备类型说哪一端、按哪个键） */
  private renderPoint(force = false): void {
    const dev = this.input.active;
    const kind = `${dev?.kind}-${dev?.joycon?.side ?? ''}`;
    if (!force && this.shownStep === this.step && this.shownKind === kind) return;
    this.shownStep = this.step;
    this.shownKind = kind;
    const w = deviceWords(dev);
    this.tv.show({
      className: 'tv-wide',
      html: `<h2>指向电视</h2>
        <div class="tv-howto">${POINT_ART}<ol>
          <li>把${w.phone ? '手机顶端' : ' Joy-Con 的肩键一端'}像遥控器一样<b>指向电视</b>，按 ${w.confirm}</li>
          <li>之后手柄就是球拍：${w.head}是拍头，${w.phone ? '屏幕' : '按键面'}是正手面</li>
          <li>打球中拍子方向偏了，同样指向电视按 ${w.recenterKey} 就能回中</li>
        </ol></div>
        <p class="tv-note">${dev ? dev.name : ''}</p>
        <div class="tv-buttons tv-inline">
          ${tvButton('calib', '指向电视了，校准', true, true)}
          ${tvButton('skip', '跳过（不判断拍面角度）')}
        </div>`,
      hints: [
        ['A', '校准'],
        ['B', '回到菜单'],
      ],
      onBack: this.opts.onBack,
      onAct: (act) => {
        if (act === 'calib') this.input.requestCalibration();
        else if (act === 'skip') {
          this.input.recenter();
          this.finish('已跳过拍面校准');
        }
      },
    });
  }
}
