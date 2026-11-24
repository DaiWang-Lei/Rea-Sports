/** 观众声音量（存在本机）：大 / 小 / 关，默认小。暂停菜单里调（和电脑对打、双人对打共用） */
import type { Sfx } from '@/audio/Sfx';

export type CrowdVolume = 'big' | 'small' | 'off';

/** 各档的观众声总音量（小 = 1） */
export const CROWD_GAIN: Record<CrowdVolume, number> = { big: 1.5, small: 1, off: 0 };

const KEY = 'rea-crowd';
const TEXT: Record<CrowdVolume, string> = { big: '大', small: '小', off: '关' };

export function loadCrowdVolume(): CrowdVolume {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'big' || v === 'off' ? v : 'small';
  } catch {
    return 'small';
  }
}

function saveCrowdVolume(v: CrowdVolume): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // 隐私模式等：不保存
  }
}

/** 设置面板里的一排「观众声：大 / 小 / 关」 */
export function crowdRow(): string {
  const cur = loadCrowdVolume();
  const b = (v: CrowdVolume) =>
    `<button class="${v === cur ? 'on' : ''}" data-crowd="${v}">${TEXT[v]}</button>`;
  return `<div class="pr-setting"><span>观众声</span>${b('big')}${b('small')}${b('off')}</div>`;
}

/** 接上面板里的「观众声」按钮：存下来、立即生效，再让面板重画 */
export function bindCrowd(el: HTMLElement, sfx: Sfx, rerender: () => void): void {
  el.querySelectorAll<HTMLButtonElement>('[data-crowd]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.crowd as CrowdVolume;
      saveCrowdVolume(v);
      sfx.setCrowdLevel(CROWD_GAIN[v]);
      rerender();
    })
  );
}
