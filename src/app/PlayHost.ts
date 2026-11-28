/**
 * 对打页：和电脑对打（1 人）、双人分屏对打（2 人）共用一个画面和一套体感输入。
 * 切换人数时不刷新页面，已连的 Joy-Con、手机都留着。
 * 在电视界面里（ctx）用界面共用的画面和输入，打完回到菜单；直接用网址打开时（开发用）自己建，网址跟着模式改。
 */
import { avatarsInUse } from '@/render/avatar/roster';
import { MatchSim } from '@/sim/MatchSim';
import { ChallengeApp } from './challenge/ChallengeApp';
import { GameView } from './GameView';
import { MotionInput } from './input/MotionInput';
import type { PlayContext } from './shell/context';
import { MatchApp } from './match/MatchApp';
import { OnlineSession } from './online/OnlineSession';
import { VersusApp } from './versus/VersusApp';

/** match = 和电脑对打，versus = 双人分屏，online = 远程对打（和另一台电脑上的人） */
export type PlayMode = 'match' | 'versus' | 'online';

export class PlayHost {
  readonly input: MotionInput;
  readonly view: GameView;
  private app: MatchApp | VersusApp | ChallengeApp | null = null;
  /** 远程对打的连接：换玩法（比赛 / 连续回击）时不断开 */
  online: OnlineSession | null = null;
  /** 直接用网址打开时选了键盘（开发用）：换玩法后不用再选 */
  keyboard = false;

  constructor(
    readonly root: HTMLElement,
    mode: PlayMode,
    readonly ctx: PlayContext | null = null
  ) {
    this.input = ctx?.input ?? new MotionInput();
    // 画面先放一局空的比赛，模式接上后换成自己的
    this.view = new GameView(
      root,
      new MatchSim(),
      { names: { near: '', far: '' } },
      ctx ?? undefined
    );
    if (!ctx) window.addEventListener('pointerdown', () => this.view.sfx.unlock());
    // 调参面板（直接用网址打开、带 ?debug=1 时）：改的是正在打的这一局
    if (!ctx && new URLSearchParams(location.search).has('debug')) {
      void import('@/debug/TuningPanel').then((m) =>
        m.createTuningPanel(() => this.view.sim.applyTuning())
      );
    }
    this.switchTo(mode);
  }

  /** 换成 1 人 / 2 人：正在打的这一局作废 */
  switchTo(mode: PlayMode): void {
    this.app?.dispose();
    if (mode === 'online' && !this.online) {
      const room = this.ctx
        ? (this.ctx.room ?? null)
        : new URLSearchParams(location.search).get('room');
      this.online = new OnlineSession(
        { avatar: avatarsInUse().near, handed: this.input.handed },
        room
      );
    }
    this.view.hud.clearFlash();
    this.view.hud.setHint('');
    if (!this.ctx) {
      const url = new URL(location.href);
      url.searchParams.set('mode', mode);
      history.replaceState(null, '', url);
    }
    this.app = mode === 'versus' ? new VersusApp(this) : new MatchApp(this, mode === 'online');
  }

  /** 远程连续回击：两边同时各打各的；打完可以回到远程对打的等待页换玩法 */
  startChallenge(): void {
    this.app?.dispose();
    this.view.hud.clearFlash();
    this.view.hud.setHint('');
    // 比赛的比分牌收起来（连续回击有自己的计分板）
    this.view.hud.showScore({ near: 0, far: 0 }, null, false);
    this.view.renderer.resetAvatar('far');
    const ctx: PlayContext = {
      renderer: this.view.renderer,
      hud: this.view.hud,
      sfx: this.view.sfx,
      input: this.input,
      exit: () => this.exit(),
      players: this.ctx?.players ?? [{ device: this.keyboard ? null : this.input.active }],
    };
    this.app = new ChallengeApp(this.root, ctx, {
      session: this.online!,
      lobby: () => this.switchTo('online'),
    });
  }

  /** 回到菜单（电视界面）或首页（直接用网址打开时） */
  exit(): void {
    if (this.ctx) this.ctx.exit();
    else location.href = './';
  }

  /** 离开对打（回到电视菜单） */
  dispose(): void {
    this.app?.dispose();
    this.app = null;
    this.online?.close();
    this.online = null;
    this.view.hud.clearFlash();
    this.view.hud.setHint('');
    this.view.hud.setBadge('');
  }
}
