/** 菜单里选的人物（你 / 对手），存在本机 */
import { type AvatarId, DEFAULT_AVATARS, isAvatarId } from '@/render/avatar/roster';
import type { Side } from '@/sim/constants';

const KEY = 'rea-avatars';

export function loadAvatarChoice(): Record<Side, AvatarId> {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<
      Record<Side, unknown>
    > | null;
    return {
      near: isAvatarId(s?.near) ? s.near : DEFAULT_AVATARS.near,
      far: isAvatarId(s?.far) ? s.far : DEFAULT_AVATARS.far,
    };
  } catch {
    return { ...DEFAULT_AVATARS };
  }
}

export function saveAvatarChoice(c: Record<Side, AvatarId>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // 隐私模式等：不保存
  }
}
