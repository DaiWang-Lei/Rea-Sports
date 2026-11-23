import { afterEach, describe, expect, it } from 'vitest';
import { loadAvatarChoice, saveAvatarChoice } from '@/app/avatarChoice';
import { DEFAULT_AVATARS } from '@/render/avatar/roster';

function stubStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
  return m;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('人物选择（存在本机）', () => {
  it('没存过、存的东西坏了或者不认识：用默认（你小蓝、对手小红）', () => {
    expect(loadAvatarChoice()).toEqual(DEFAULT_AVATARS);
    const m = stubStorage();
    m.set('rea-avatars', '{坏的');
    expect(loadAvatarChoice()).toEqual(DEFAULT_AVATARS);
    m.set('rea-avatars', JSON.stringify({ near: 'nobody', far: 'cyborg' }));
    expect(loadAvatarChoice()).toEqual({ near: DEFAULT_AVATARS.near, far: 'cyborg' });
  });

  it('存了就读回来', () => {
    stubStorage();
    saveAvatarChoice({ near: 'skater-girl', far: 'suit' });
    expect(loadAvatarChoice()).toEqual({ near: 'skater-girl', far: 'suit' });
  });
});
