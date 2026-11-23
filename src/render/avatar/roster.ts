/**
 * 可选的人物：代码生成的 Q 版人物（两种配色）和 Kenney 的卡通人物（带骨骼的模型，四套衣服，CC0）。
 * 带骨骼的模型要先下载：开局前 preloadAvatars(选择)，之后 Renderer 按 avatarsInUse() 同步创建。
 * 下载失败（离线等）时那一边退回 Q 版人物。
 */
import type { Side } from '@/sim/constants';
import type { KenneyAssets, KenneySkin } from './KenneyBody';
import { ProceduralBody } from './ProceduralBody';
import type { AvatarBody, AvatarLook } from './types';

export type AvatarId = 'q-blue' | 'q-red' | KenneySkin;

export interface AvatarEntry {
  id: AvatarId;
  name: string;
}

const LOOKS: Partial<Record<AvatarId, AvatarLook>> = {
  'q-blue': {
    shirt: 0x2f80ed,
    shorts: 0x1f2a3c,
    skin: 0xf1c9a5,
    hair: 0x3a2a1f,
    hairStyle: 'short',
  },
  'q-red': { shirt: 0xe2583e, shorts: 0x2b2d38, skin: 0xe0ac7e, hair: 0x2b1d14, hairStyle: 'bun' },
};

export const ROSTER: readonly AvatarEntry[] = [
  { id: 'q-blue', name: '小蓝' },
  { id: 'q-red', name: '小红' },
  { id: 'skater-boy', name: '滑板少年' },
  { id: 'skater-girl', name: '滑板少女' },
  { id: 'suit', name: '西装大叔' },
  { id: 'cyborg', name: '机械少女' },
];

export const DEFAULT_AVATARS: Readonly<Record<Side, AvatarId>> = { near: 'q-blue', far: 'q-red' };

export function isAvatarId(x: unknown): x is AvatarId {
  return ROSTER.some((e) => e.id === x);
}

const isProcedural = (id: AvatarId) => LOOKS[id] !== undefined;

let inUse: Record<Side, AvatarId> = { ...DEFAULT_AVATARS };
let kenney: {
  assets: KenneyAssets;
  create: (a: KenneyAssets, s: KenneySkin, t: boolean) => AvatarBody;
} | null = null;

/** 开局前：记下两边用谁，带骨骼的模型先下载好 */
export async function preloadAvatars(choice: Record<Side, AvatarId>): Promise<void> {
  inUse = { ...choice };
  const skins = [...new Set(Object.values(choice))].filter(
    (id) => !isProcedural(id)
  ) as KenneySkin[];
  if (skins.length === 0) return;
  try {
    const m = await import('./KenneyBody');
    const assets = await m.loadKenney(skins);
    kenney = { assets, create: (a, s, t) => new m.KenneyBody(a, s, t) };
  } catch (e) {
    console.warn('人物模型下载失败，改用 Q 版人物', e);
    inUse = {
      near: isProcedural(choice.near) ? choice.near : DEFAULT_AVATARS.near,
      far: isProcedural(choice.far) ? choice.far : DEFAULT_AVATARS.far,
    };
  }
}

/** 这一局两边用的人物 */
export function avatarsInUse(): Readonly<Record<Side, AvatarId>> {
  return inUse;
}

export function createAvatarBody(id: AvatarId, translucent: boolean): AvatarBody {
  const look = LOOKS[id];
  if (look) return new ProceduralBody(look, translucent);
  if (!kenney) throw new Error(`人物「${id}」的模型还没下载（先 preloadAvatars）`);
  return kenney.create(kenney.assets, id as KenneySkin, translucent);
}
