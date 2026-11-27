/**
 * 电视界面（像 WSR，坐在沙发上只用手柄玩）：开机 → 谁来玩 → 选人物 → 主菜单 → 比赛 / 连续回击 / 练习 → 回到菜单。
 * 整个过程在同一个页面里，画面、文字层、声音、体感输入只有一份，各个玩法共用，手柄和手机全程不断开。
 * 在菜单里：摇杆 / 方向键 / 键盘方向键移动焦点，A（Enter、空格）确定，B（Esc、退格）返回；背景是绕着球场转的镜头。
 */
import '@/ui/tv/tokens.css';
import '@/ui/tv/tv.css';
import { Sfx } from '@/audio/Sfx';
import type { LogicalButton } from '@/input/types';
import { type AvatarId, preloadAvatars } from '@/render/avatar/roster';
import { Renderer } from '@/render/Renderer';
import { Hud } from '@/ui/Hud';
import { KEY_NAV, NavRepeat } from '@/ui/tv/FocusNav';
import { loadAvatarChoice, saveAvatarChoice } from '../avatarChoice';
import { ChallengeApp } from '../challenge/ChallengeApp';
import { type InputDevice, MotionInput, type MotionInputEvents } from '../input/MotionInput';
import { PlayHost } from '../PlayHost';
import { PracticeApp } from '../practice/PracticeApp';
import { CROWD_GAIN, loadCrowdVolume } from '../shared/crowdVolume';
import type { PlayContext, ShellPlayer } from './context';
import { MainMenu, type Screen, TitleScreen } from './screens';
import { Showcase } from './Showcase';

export interface Player extends ShellPlayer {
  avatar: AvatarId;
}

export type ModeKind = 'match' | 'challenge' | 'practice';

export class Shell {
  readonly renderer: Renderer;
  readonly hud: Hud;
  readonly sfx = new Sfx();
  readonly input = new MotionInput();
  /** 加入的玩家（最多两个）：手柄（null = 键盘，开发用）和选的人物 */
  readonly players: Player[] = [];
  /** ?debug=1：谁来玩里可以用键盘加入（冒烟测试、没有手柄时用） */
  readonly dev = new URLSearchParams(location.search).has('debug');
  private screen: Screen | null = null;
  private mode: { dispose(): void } | null = null;
  private readonly showcase: Showcase;
  private readonly repeats = new Map<string, NavRepeat>();
  private last = performance.now();

  constructor(readonly root: HTMLElement) {
    root.className = 'game-root tv';
    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    root.appendChild(canvas);
    this.renderer = new Renderer(canvas);
    this.hud = new Hud(root, { near: '', far: '' });
    this.sfx.setCrowd(0.11, 0);
    this.sfx.setCrowdLevel(CROWD_GAIN[loadCrowdVolume()]);
    this.showcase = new Showcase(this.renderer);
    this.menuInput();
    void this.input.start().then(() => this.screen?.devicesChanged?.());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointerdown', () => this.sfx.unlock());
    this.showcase.start();
    this.show(new TitleScreen(this));
    if (this.dev) (window as unknown as { __shell: Shell }).__shell = this;
    requestAnimationFrame(() => this.loop());
  }

  /** 换一屏 */
  show(screen: Screen): void {
    this.screen?.dispose();
    this.screen = screen;
    this.root.appendChild(screen.el);
    screen.devicesChanged?.();
  }

  /** 当前这一屏（冒烟测试读） */
  get current(): Screen | null {
    return this.screen;
  }

  // ---------------------------------------------------------------- 玩家

  /** 加入一个玩家（null = 键盘）：手柄同时指向电视定方向；满两个人了返回 false */
  join(d: InputDevice | null): boolean {
    if (this.players.length >= 2 || this.players.some((p) => p.device === d)) return false;
    const saved = loadAvatarChoice();
    this.players.push({
      device: d,
      avatar: this.players.length === 0 ? saved.near : saved.far,
    });
    if (d) this.input.requestCalibration(d);
    return true;
  }

  leave(i: number): void {
    this.players.splice(i, 1);
  }

  /** 选好人物：存下来，画面上换成这两个人 */
  async setAvatars(): Promise<void> {
    const saved = loadAvatarChoice();
    const choice = {
      near: this.players[0]?.avatar ?? saved.near,
      far: this.players[1]?.avatar ?? saved.far,
    };
    saveAvatarChoice(choice);
    await preloadAvatars(choice);
    this.showcase.stop();
    this.renderer.resetAvatar('near');
    this.renderer.resetAvatar('far');
    this.showcase.start();
  }

  // ---------------------------------------------------------------- 玩法

  launch(kind: ModeKind): void {
    this.screen?.dispose();
    this.screen = null;
    for (const r of this.repeats.values()) r.release();
    this.showcase.stop();
    const d = this.players[0]?.device;
    if (d) this.input.setActive(d);
    const ctx: PlayContext = {
      renderer: this.renderer,
      hud: this.hud,
      sfx: this.sfx,
      input: this.input,
      exit: () => this.backToMenu(),
      players: this.players,
    };
    if (kind === 'match')
      this.mode = new PlayHost(this.root, this.players.length > 1 ? 'versus' : 'match', ctx);
    else if (kind === 'challenge') {
      this.renderer.resetAvatar('far');
      this.mode = new ChallengeApp(this.root, ctx);
    } else this.mode = new PracticeApp(this.root, ctx);
  }

  /** 玩法里选了「回到菜单」：收回画面和输入，回到主菜单 */
  private backToMenu(): void {
    this.mode?.dispose();
    this.mode = null;
    this.root.className = 'game-root tv';
    this.menuInput();
    this.input.autoHeading = false;
    this.input.tossEnabled = false;
    this.sfx.setCrowdOn(false);
    this.hud.clearFlash();
    this.hud.showScore({ near: 0, far: 0 }, null, false);
    this.hud.setHint('');
    this.hud.setBadge('');
    this.renderer.setSplit(false);
    this.renderer.crowd.setFill(1);
    this.renderer.resetAvatar('far');
    this.showcase.start();
    this.show(new MainMenu(this));
  }

  // ---------------------------------------------------------------- 输入（菜单里）

  /** 菜单里所有手柄的按键、摇杆都交给当前这一屏 */
  private menuInput(): void {
    this.input.multi = true;
    const events: MotionInputEvents = {
      onButton: (b: LogicalButton, down, d) => {
        if (!down) return;
        this.sfx.unlock();
        this.screen?.button(b, d);
      },
      onNav: (dir, down, d) => {
        let r = this.repeats.get(d.key);
        if (!r) {
          r = new NavRepeat((x) => this.screen?.nav(x, d));
          this.repeats.set(d.key, r);
        }
        if (down) r.press(dir);
        else r.release(dir);
      },
      onCalibrate: (d, result) => this.screen?.calibrated?.(d, result),
      onDevicesChanged: () => {
        // 拔掉的手柄让出位置
        for (let i = this.players.length - 1; i >= 0; i--) {
          const dev = this.players[i].device;
          if (dev && !this.input.devices.has(dev.key)) this.players.splice(i, 1);
        }
        this.screen?.devicesChanged?.();
      },
      onLinkStatus: () => this.screen?.devicesChanged?.(),
    };
    this.input.events = events;
  }

  private onKey(e: KeyboardEvent): void {
    if (this.mode || !this.screen) return;
    this.sfx.unlock();
    const k = e.key.toLowerCase();
    const dir = KEY_NAV[k];
    if (dir) {
      e.preventDefault();
      this.screen.nav(dir, null);
    } else if (k === 'enter' || k === ' ') {
      e.preventDefault();
      this.screen.button('confirm', null);
    } else if (k === 'escape' || k === 'backspace') {
      e.preventDefault();
      this.screen.button('back', null);
    }
  }

  private loop(): void {
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    if (!this.mode) this.showcase.render(dt);
    requestAnimationFrame(() => this.loop());
  }
}
