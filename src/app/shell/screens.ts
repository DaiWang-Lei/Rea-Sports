/**
 * 电视界面的几屏（像 WSR）：开机 → 谁来玩（拿起手柄指向电视按 A 加入）→ 选人物 → 主菜单（选玩法）。
 * 每屏一块铺满画面的文字层，叠在 3D 球场上；摇杆 / 方向键移动焦点，A 确定，B 返回；底部一条按键提示。
 */
import QRCode from 'qrcode';
import type { LogicalButton, NavDir } from '@/input/types';
import { type AvatarId, ROSTER } from '@/render/avatar/roster';
import { AVATAR_THUMBS } from '@/render/avatar/thumbs';
import { FocusNav } from '@/ui/tv/FocusNav';
import { TvOverlay } from '@/ui/tv/TvOverlay';
import { ICON_CHALLENGE, ICON_MATCH, ICON_ONLINE, ICON_PRACTICE } from '@/ui/tv/icons';
import type { CalibrateResult, InputDevice } from '../input/MotionInput';
import { SettingsPanel } from '../shared/settingsView';
import { deviceWords } from '../shared/SetupFlow';
import type { Shell } from './Shell';

export interface Screen {
  readonly el: HTMLElement;
  /** 按键（d = null：键盘） */
  button(b: LogicalButton, d: InputDevice | null): void;
  nav(dir: NavDir, d: InputDevice | null): void;
  calibrated?(d: InputDevice, result: CalibrateResult): void;
  devicesChanged?(): void;
  dispose(): void;
}

/** 底部的按键提示：[按键, 说明] */
function hints(items: [string, string][]): string {
  return `<div class="tv-hints">${items
    .map(
      ([k, t]) =>
        `<span><span class="tv-key${k.length > 1 ? ' tv-key-wide' : ''}">${k}</span>${t}</span>`
    )
    .join('')}</div>`;
}

/** 有焦点导航的一屏：摇杆 / 方向键移动，A 点当前这一项，B 返回 */
abstract class FocusScreen implements Screen {
  readonly el = document.createElement('div');
  protected nav0: FocusNav;

  constructor(
    protected readonly shell: Shell,
    className: string,
    html: string,
    onBack?: () => void
  ) {
    this.el.className = `tv-screen ${className}`;
    this.el.innerHTML = html;
    this.nav0 = new FocusNav(this.el, { sound: (k) => shell.sfx.ui(k), onBack });
  }

  button(b: LogicalButton, _d: InputDevice | null): void {
    if (b === 'confirm') this.nav0.activate();
    else if (b === 'back') this.nav0.back();
  }

  nav(dir: NavDir, _d: InputDevice | null): void {
    this.nav0.move(dir);
  }

  dispose(): void {
    this.el.remove();
  }
}

// ---------------------------------------------------------------- 开机

export class TitleScreen implements Screen {
  readonly el = document.createElement('div');

  constructor(private readonly shell: Shell) {
    this.el.className = 'tv-screen tv-sky';
    this.el.innerHTML = `
      <div class="tv-logo">体感乒乓</div>
      <div class="tv-press">按 <span class="tv-key">A</span> 开始</div>
      <div class="tv-footnote"></div>`;
    this.el.addEventListener('click', () => this.go());
    this.note();
  }

  /** 底下一行小字：声音还没打开（浏览器要先点一下鼠标或按一下键盘，Joy-Con 的按键不算）时先提醒这个 */
  private note(): void {
    const el = this.el.querySelector('.tv-footnote');
    if (!el) return;
    el.textContent = this.shell.sfx.unlocked
      ? '第一次用 Joy-Con：先在电脑的蓝牙设置里配对'
      : '先点一下鼠标或按一下键盘，打开声音';
    if (!this.shell.sfx.unlocked) window.setTimeout(() => this.note(), 500);
  }

  button(b: LogicalButton): void {
    if (b === 'confirm') this.go();
  }

  nav(): void {}

  private go(): void {
    this.shell.sfx.ui('ok');
    this.shell.show(new JoinScreen(this.shell));
  }

  dispose(): void {
    this.el.remove();
  }
}

// ---------------------------------------------------------------- 谁来玩

/**
 * 谁来玩：两个位置。没加入的手柄拿起来指向电视按 A 就加入（同时定好电视方向）；
 * 加入了的按 A 点当前选中的按钮（默认「开始」），按 B 退出。第一次用 Joy-Con 要用鼠标点「连接 Joy-Con」
 * （浏览器规定选设备必须点一下）；手机扫「用手机玩」里的二维码
 */
export class JoinScreen extends FocusScreen {
  private qrOpen = false;

  constructor(shell: Shell) {
    super(shell, 'tv-sky', '', () => shell.show(new TitleScreen(shell)));
    this.render();
  }

  button(b: LogicalButton, d: InputDevice | null): void {
    const sh = this.shell;
    const i = d ? sh.players.findIndex((p) => p.device === d) : -1;
    if (b === 'confirm' && d && i < 0) {
      // 没加入的手柄：加入（同时指向电视定方向）
      if (sh.join(d)) {
        sh.sfx.ui('ok');
        this.render();
      }
      return;
    }
    if (b === 'back' && i >= 0) {
      sh.leave(i);
      sh.sfx.ui('back');
      this.render();
      return;
    }
    if (b === 'recenter' && d && i >= 0) {
      sh.input.requestCalibration(d);
      return;
    }
    super.button(b, d);
  }

  calibrated(d: InputDevice, result: CalibrateResult): void {
    const w = deviceWords(d);
    if (result === 'done') this.shell.hud.flash('已定好电视方向', '', 0.9, 'good');
    else this.shell.hud.flash(`${w.head}别朝上或朝下`, '像遥控器一样指向电视再按', 1.6, 'bad');
    this.render();
  }

  devicesChanged(): void {
    this.render();
  }

  private slot(i: number): string {
    const p = this.shell.players[i];
    const tag = i === 0 ? '1P' : '2P';
    if (!p) {
      return `<div class="tv-slot p${i + 1}"><div class="tv-slot-tag">${tag}</div>
        <div class="tv-slot-tip">拿起手柄，像遥控器一样<br/>指向电视按 <span class="tv-key">A</span> 加入</div></div>`;
    }
    const d = p.device;
    const ready = !d || d.paddle.calibrated;
    return `<div class="tv-slot p${i + 1} joined"><div class="tv-slot-tag">${tag}</div>
      <div class="tv-slot-dev">${d ? d.name : '键盘'}</div>
      <div class="tv-slot-tip">${ready ? '<span class="ok">准备好了</span>' : `<span class="warn">指向电视按 ${deviceWords(d).confirm} 定方向</span>`}</div></div>`;
  }

  private render(): void {
    const sh = this.shell;
    const n = sh.players.length;
    this.el.innerHTML = `
      <h1 class="tv-title">谁来玩？</h1>
      <p class="tv-sub">一个人和电脑打，两个人可以对打</p>
      <div class="tv-slots">${this.slot(0)}${this.slot(1)}</div>
      ${
        this.qrOpen
          ? `<div class="tv-qr"><canvas width="240" height="240"></canvas><div>
               <b>用手机当球拍</b><br/>手机和电脑连同一个 Wi-Fi，<br/>用相机或浏览器扫这个码<br/>
               <span class="dim">${sh.input.linkStatus.text}${sh.input.room ? ` · 房间 ${sh.input.room}` : ''}</span></div></div>`
          : ''
      }
      <div class="tv-row" style="margin-top:3vh">
        <button class="tv-btn tv-primary" data-focus data-focus-default data-act="go" ${n ? '' : 'disabled'}>开始</button>
        <button class="tv-small-btn" data-focus data-act="joycon" ${sh.input.webHidSupported ? '' : 'disabled'}>连接 Joy-Con</button>
        <button class="tv-small-btn" data-focus data-act="phone">${this.qrOpen ? '收起二维码' : '用手机玩'}</button>
        ${sh.dev ? '<button class="tv-small-btn" data-focus data-act="keyboard">用键盘（开发）</button>' : ''}
      </div>
      ${hints([
        ['A', n ? '加入 / 开始' : '加入'],
        ['B', n ? '退出这个位置' : '返回'],
      ])}`;
    const qr = this.el.querySelector<HTMLCanvasElement>('canvas');
    if (qr && sh.input.phoneUrl)
      void QRCode.toCanvas(qr, sh.input.phoneUrl, { width: 240, margin: 1 });
    this.el.querySelector('[data-act="go"]')?.addEventListener('click', () => {
      if (sh.players.length) sh.show(new CharacterScreen(sh));
    });
    this.el.querySelector('[data-act="joycon"]')?.addEventListener('click', () => {
      void sh.input.requestJoyCon().catch(() => {});
    });
    this.el.querySelector('[data-act="phone"]')?.addEventListener('click', () => {
      this.qrOpen = !this.qrOpen;
      this.render();
    });
    this.el.querySelector('[data-act="keyboard"]')?.addEventListener('click', () => {
      sh.join(null);
      this.render();
    });
    this.nav0.refresh();
  }
}

// ---------------------------------------------------------------- 选人物

/** 选人物：一排人物卡，每个玩家一个颜色的框，用自己的手柄选（键盘算 1P），A 选定、B 取消 / 返回 */
export class CharacterScreen implements Screen {
  readonly el = document.createElement('div');
  private readonly cursor: number[];
  private readonly locked: boolean[];

  constructor(private readonly shell: Shell) {
    this.el.className = 'tv-screen tv-sky';
    this.cursor = shell.players.map((p) =>
      Math.max(
        0,
        ROSTER.findIndex((e) => e.id === p.avatar)
      )
    );
    this.locked = shell.players.map(() => false);
    this.el.addEventListener('click', (e) => {
      const card = (e.target as Element).closest<HTMLElement>('[data-char]');
      if (!card) return;
      this.cursor[0] = Number(card.dataset.char);
      this.lock(0);
    });
    this.render();
  }

  /** 键盘（d = null）算 1P */
  private who(d: InputDevice | null): number {
    const i = this.shell.players.findIndex((p) => p.device === d);
    return i >= 0 ? i : d === null ? 0 : -1;
  }

  button(b: LogicalButton, d: InputDevice | null): void {
    const i = this.who(d);
    if (i < 0) return;
    if (b === 'confirm' && !this.locked[i]) this.lock(i);
    else if (b === 'back') {
      if (this.locked[i]) {
        this.locked[i] = false;
        this.shell.sfx.ui('back');
        this.render();
      } else {
        this.shell.sfx.ui('back');
        this.shell.show(new JoinScreen(this.shell));
      }
    }
  }

  nav(dir: NavDir, d: InputDevice | null): void {
    const i = this.who(d);
    if (i < 0 || this.locked[i] || (dir !== 'left' && dir !== 'right')) return;
    const n = ROSTER.length;
    this.cursor[i] = (this.cursor[i] + (dir === 'left' ? n - 1 : 1)) % n;
    this.shell.sfx.ui('move');
    this.render();
  }

  private lock(i: number): void {
    this.locked[i] = true;
    this.shell.players[i].avatar = ROSTER[this.cursor[i]].id;
    this.shell.sfx.ui('ok');
    if (this.locked.every(Boolean)) {
      void this.shell.setAvatars().then(() => this.shell.toMenu());
    }
    this.render();
  }

  private render(): void {
    const players = this.shell.players;
    this.el.innerHTML = `
      <h1 class="tv-title">选人物</h1>
      <p class="tv-sub">${players.length > 1 ? '两个人各用自己的手柄选' : '用摇杆左右选，按 A 选定'}</p>
      <div class="tv-chars">${ROSTER.map((e, k) => {
        const here = players.map((_, i) => i).filter((i) => this.cursor[i] === k);
        const cls = here.map((i) => ` cur-p${i + 1}`).join('');
        const badges = here
          .map(
            (i) =>
              `<span class="tv-badge p${i + 1}${this.locked[i] ? ' locked' : ''}">${i + 1}P</span>`
          )
          .join('');
        return `<div class="tv-char${cls}" data-char="${k}"><div class="tv-char-badges">${badges}</div>
          <img src="${AVATAR_THUMBS[e.id as AvatarId]}" alt="" /><div>${e.name}</div></div>`;
      }).join('')}</div>
      ${hints([
        ['◀▶', '选人物'],
        ['A', '选定'],
        ['B', '返回'],
      ])}`;
  }

  dispose(): void {
    this.el.remove();
  }
}

// ---------------------------------------------------------------- 主菜单

/** 主菜单：比赛（一个人和电脑打、两个人对打）、连续回击、练习；右上角换人 */
export class MainMenu extends FocusScreen {
  constructor(shell: Shell) {
    const two = shell.players.length > 1;
    super(
      shell,
      'tv-sky',
      `
      <h1 class="tv-title">玩什么？</h1>
      <p class="tv-sub">${two ? '两个人' : '一个人'}玩 · 用摇杆选，按 A 开始</p>
      <div class="tv-row">
        <button class="tv-card" data-focus data-focus-default data-act="match">${ICON_MATCH}
          <b>比赛</b><span>${two ? '两个人对打<br/>左右分屏' : '和电脑对打<br/>按你的熟练度配对手'}</span></button>
        <button class="tv-card" data-focus data-act="challenge">${ICON_CHALLENGE}
          <b>连续回击</b><span>教练不停供球<br/>回一球 1 分，漏一球结束</span></button>
        <button class="tv-card" data-focus data-act="practice">${ICON_PRACTICE}
          <b>练习</b><span>发球机送球<br/>每一球告诉你早还是晚</span></button>
        <button class="tv-card" data-focus data-act="online">${ICON_ONLINE}
          <b>远程对打</b><span>和另一台电脑上的人打<br/>发个链接就行</span></button>
      </div>
      <div class="tv-corner">
        <button class="tv-small-btn" data-focus data-act="players">换人</button>
        <button class="tv-small-btn" data-focus data-act="settings">设置</button>
      </div>
      ${hints([
        ['◀▶', '选择'],
        ['A', '确定'],
        ['B', '返回'],
      ])}`,
      () => shell.show(new CharacterScreen(shell))
    );
    const on = (act: string, f: () => void) =>
      this.el.querySelector(`[data-act="${act}"]`)?.addEventListener('click', f);
    on('match', () => shell.launch('match'));
    on('challenge', () => shell.launch('challenge'));
    on('practice', () => shell.launch('practice'));
    on('online', () => shell.launch('online'));
    on('players', () => shell.show(new JoinScreen(shell)));
    on('settings', () => shell.show(new SettingsScreen(shell)));
  }
}

// ---------------------------------------------------------------- 设置

/** 设置（主菜单右上角）：和玩法暂停里的设置是同一个面板，多一项「手柄和手机」 */
export class SettingsScreen implements Screen {
  readonly el: HTMLElement;
  private readonly overlay: TvOverlay;
  private readonly panel: SettingsPanel;

  constructor(shell: Shell) {
    this.overlay = new TvOverlay(shell.root, (k) => shell.sfx.ui(k), 'tv-sky');
    this.el = this.overlay.el;
    this.panel = new SettingsPanel(
      {
        sfx: shell.sfx,
        input: shell.input,
        players: shell.players.length,
        devices: true,
        onBack: () => shell.show(new MainMenu(shell)),
      },
      this.overlay
    );
    this.panel.show();
  }

  button(b: LogicalButton): void {
    if (b === 'confirm') this.overlay.confirm();
    else if (b === 'back') this.overlay.back();
  }

  nav(dir: NavDir): void {
    this.overlay.nav(dir);
  }

  devicesChanged(): void {
    this.panel.show(true);
  }

  dispose(): void {
    this.el.remove();
  }
}
