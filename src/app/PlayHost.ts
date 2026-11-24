/**
 * 对打页：和电脑对打（1 人）、双人分屏对打（2 人）共用一个画面和一套体感输入。
 * 切换人数时不刷新页面，已连的 Joy-Con、手机都留着；网址跟着改（?mode=match / versus），刷新后还是这个模式。
 */
import { MatchSim } from '@/sim/MatchSim';
import { GameView } from './GameView';
import { MotionInput } from './input/MotionInput';
import { MatchApp } from './match/MatchApp';
import { VersusApp } from './versus/VersusApp';

export type PlayMode = 'match' | 'versus';

export class PlayHost {
  readonly input = new MotionInput();
  readonly view: GameView;
  private app: MatchApp | VersusApp | null = null;

  constructor(
    readonly root: HTMLElement,
    mode: PlayMode
  ) {
    // 画面先放一局空的比赛，模式接上后换成自己的
    this.view = new GameView(root, new MatchSim(), { names: { near: '', far: '' } });
    window.addEventListener('pointerdown', () => this.view.sfx.unlock());
    // 调参面板（?debug=1）：改的是正在打的这一局
    if (new URLSearchParams(location.search).has('debug')) {
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
    const url = new URL(location.href);
    url.searchParams.set('mode', mode);
    history.replaceState(null, '', url);
    this.app = mode === 'match' ? new MatchApp(this) : new VersusApp(this);
  }
}
