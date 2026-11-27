/**
 * 对打页：和电脑对打（1 人）、双人分屏对打（2 人）共用一个画面和一套体感输入。
 * 切换人数时不刷新页面，已连的 Joy-Con、手机都留着。
 * 在电视界面里（ctx）用界面共用的画面和输入，打完回到菜单；直接用网址打开时（开发用）自己建，网址跟着模式改。
 */
import { MatchSim } from '@/sim/MatchSim';
import { GameView } from './GameView';
import { MotionInput } from './input/MotionInput';
import type { PlayContext } from './shell/context';
import { MatchApp } from './match/MatchApp';
import { VersusApp } from './versus/VersusApp';

export type PlayMode = 'match' | 'versus';

export class PlayHost {
  readonly input: MotionInput;
  readonly view: GameView;
  private app: MatchApp | VersusApp | null = null;

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
    this.view.hud.clearFlash();
    this.view.hud.setHint('');
    if (!this.ctx) {
      const url = new URL(location.href);
      url.searchParams.set('mode', mode);
      history.replaceState(null, '', url);
    }
    this.app = mode === 'match' ? new MatchApp(this) : new VersusApp(this);
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
    this.view.hud.clearFlash();
    this.view.hud.setHint('');
    this.view.hud.setBadge('');
  }
}
