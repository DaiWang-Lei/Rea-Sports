/** 菜单里的人物头像（pnpm thumbs:avatars 重新生成） */
import type { AvatarId } from '../roster';
import cyborg from './cyborg.png?url';
import qBlue from './q-blue.png?url';
import qRed from './q-red.png?url';
import skaterBoy from './skater-boy.png?url';
import skaterGirl from './skater-girl.png?url';
import suit from './suit.png?url';

export const AVATAR_THUMBS: Record<AvatarId, string> = {
  'q-blue': qBlue,
  'q-red': qRed,
  'skater-boy': skaterBoy,
  'skater-girl': skaterGirl,
  suit,
  cyborg,
};
