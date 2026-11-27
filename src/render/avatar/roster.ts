/**
 * 可选的人物：代码生成的 Q 版人物（两种配色）和 Kenney 的卡通人物（带骨骼的模型，四套衣服，CC0）。
 * 带骨骼的模型要先下载：开局前 preloadAvatars(选择)，之后 Renderer 按 avatarsInUse() 同步创建。
 * 看台上的观众也是这些人物（加上几种随机配色的 Q 版），所以四套衣服都下载。
 * 下载失败（离线等）时那一边退回 Q 版人物，观众也只有 Q 版。
 */
import type { OpponentLook } from '@/config/opponents';
import type { Side } from '@/sim/constants';
import { type BakedAvatar, bakeAvatar } from './bake';
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

const KENNEY_SKINS: KenneySkin[] = ['skater-boy', 'skater-girl', 'suit', 'cyborg'];

/** 开局前：记下两边用谁，带骨骼的模型（四套衣服，观众也要用）先下载好 */
export async function preloadAvatars(choice: Record<Side, AvatarId>): Promise<void> {
  inUse = { ...choice };
  if (kenney) return;
  try {
    const m = await import('./KenneyBody');
    const assets = await m.loadKenney(KENNEY_SKINS);
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

/** 电脑对手自己的样子（Q 版配色或 Kenney 人物；Kenney 没下载成就用 Q 版） */
export function createLookBody(look: OpponentLook, translucent: boolean): AvatarBody {
  if ('q' in look) return new ProceduralBody(look.q, translucent);
  if (kenney) return kenney.create(kenney.assets, look.kenney, translucent);
  return new ProceduralBody(LOOKS[DEFAULT_AVATARS.far]!, translucent);
}

/** 看台上 Q 版观众的随机配色 */
const CROWD_SHIRTS = [
  0xe63946, 0xf4a261, 0xe9c46a, 0x2a9d8f, 0x457b9d, 0xffffff, 0x8ecae6, 0xff8fab,
];
const CROWD_SKINS = [0xf1c9a5, 0xe0ac7e, 0xc68642, 0x8d5524, 0xffdbac];
const CROWD_HAIR = [0x2b1d14, 0x3a2a1f, 0x6b4423, 0xc9a35b, 0x111111];

/**
 * 观众用的人物：名单里的每个人（Kenney 没下载成就只有 Q 版），再加几种随机配色的 Q 版，各烘焙成两个姿势
 */
export function crowdKit(extraLooks = 4): BakedAvatar[] {
  const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const bodies: AvatarBody[] = ROSTER.filter((e) => isProcedural(e.id) || kenney).map((e) =>
    createAvatarBody(e.id, false)
  );
  for (let i = 0; i < extraLooks; i++)
    bodies.push(
      new ProceduralBody(
        {
          shirt: pick(CROWD_SHIRTS),
          shorts: 0x2b2d38,
          skin: pick(CROWD_SKINS),
          hair: pick(CROWD_HAIR),
          hairStyle: Math.random() < 0.5 ? 'short' : 'bun',
        },
        false
      )
    );
  return bodies.map(bakeAvatar);
}
