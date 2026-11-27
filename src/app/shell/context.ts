/**
 * 电视界面里各个玩法共用的东西：一块画面（Renderer）、文字层、声音、体感输入（手柄全程不断开），
 * 退回菜单的办法，和在「谁来玩」里加入的玩家。直接用网址打开某个玩法（开发用）时没有这些，玩法自己建。
 */
import type { Sfx } from '@/audio/Sfx';
import type { Renderer } from '@/render/Renderer';
import type { Hud } from '@/ui/Hud';
import type { InputDevice, MotionInput } from '../input/MotionInput';

export interface ShellPlayer {
  /** 拿的手柄；null = 键盘（开发用） */
  device: InputDevice | null;
}

export interface PlayContext {
  renderer: Renderer;
  hud: Hud;
  sfx: Sfx;
  input: MotionInput;
  /** 回到电视菜单 */
  exit: () => void;
  players: readonly ShellPlayer[];
}
