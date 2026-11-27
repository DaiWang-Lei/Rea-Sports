/**
 * 电视界面的焦点：摇杆 / 方向键在一屏里的可选项（带 data-focus 的元素）之间移动，A 确定（等于点一下）、B 返回。
 * 往哪个方向移：在那个方向上离当前这一项最近的（横向偏差按两倍算，免得斜着跳到远处）；那边没有了就原地不动、低音一声。
 * 鼠标移上去也会选中（鼠标真的动了才算）。默认选中带 data-focus-default 的那一项（没有就第一项）。
 * 带 data-spin 的一项（「◀ 值 ▶」那样的设置）：左右不移动焦点，而是在它上面发一个 tv-spin 事件（detail = −1 / 1），
 * 由面板去改值；点 ◀ / ▶ 也一样。
 */
import type { NavDir } from '@/input/types';

export type UiSound = 'move' | 'ok' | 'back' | 'deny';

/** 键盘的方向键 */
export const KEY_NAV: Readonly<Record<string, NavDir>> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

export interface FocusNavOptions {
  sound?: (k: UiSound) => void;
  /** B 返回；不给就没有返回 */
  onBack?: () => void;
}

export class FocusNav {
  current: HTMLElement | null = null;
  private items: HTMLElement[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly opts: FocusNavOptions = {}
  ) {
    root.addEventListener('click', (e) => {
      const arrow = (e.target as Element).closest<HTMLElement>('[data-spin-dir]');
      const row = arrow?.closest<HTMLElement>('[data-spin]');
      if (!arrow || !row) return;
      e.stopPropagation();
      this.spin(row, Number(arrow.dataset.spinDir) as -1 | 1);
    });
    // 鼠标真的动了才跟着选中：面板刚出现在一动不动的鼠标下面时，焦点留在默认那一项
    root.addEventListener('pointermove', (e) => {
      if (!e.movementX && !e.movementY) return;
      const el = (e.target as Element).closest<HTMLElement>('[data-focus]');
      if (el && root.contains(el) && !el.hasAttribute('disabled')) this.focus(el, false);
    });
    this.refresh();
  }

  /** 这一屏的内容变了：重新找可选项（当前那一项还在就留着） */
  refresh(): void {
    this.items = [...this.root.querySelectorAll<HTMLElement>('[data-focus]')].filter(
      (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0
    );
    if (!this.current || !this.items.includes(this.current)) {
      const def =
        this.items.find((el) => el.hasAttribute('data-focus-default')) ?? this.items[0] ?? null;
      this.current = null;
      this.focus(def, false);
    }
  }

  focus(el: HTMLElement | null, sound = true): void {
    if (el === this.current) return;
    this.current?.classList.remove('tv-focused');
    this.current = el;
    el?.classList.add('tv-focused');
    if (sound && el) this.opts.sound?.('move');
  }

  move(dir: NavDir): void {
    this.refresh();
    const cur = this.current;
    if (!cur) return;
    if (cur.hasAttribute('data-spin') && (dir === 'left' || dir === 'right')) {
      this.spin(cur, dir === 'left' ? -1 : 1);
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of this.items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - ax;
      const dy = b.top + b.height / 2 - ay;
      const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along <= 1) continue;
      const score = along + 2 * across;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) this.focus(best);
    else this.opts.sound?.('deny');
  }

  /** 改一项「◀ 值 ▶」设置 */
  private spin(row: HTMLElement, d: -1 | 1): void {
    this.opts.sound?.('move');
    row.dispatchEvent(new CustomEvent('tv-spin', { detail: d, bubbles: true }));
  }

  /** A：点一下当前这一项 */
  activate(): void {
    if (!this.current) return;
    this.opts.sound?.('ok');
    this.current.click();
  }

  /** B：返回（这一屏没有返回就不响） */
  back(): void {
    if (!this.opts.onBack) return;
    this.opts.sound?.('back');
    this.opts.onBack();
  }
}

/**
 * 按住方向连续移动：按下立刻走一步，0.4 秒后每 0.14 秒再走一步，松开就停
 * （键盘有自己的连发，摇杆和手机方向键用这个）
 */
export class NavRepeat {
  private timer = 0;
  private held: NavDir | null = null;

  constructor(private readonly step: (dir: NavDir) => void) {}

  press(dir: NavDir): void {
    this.release();
    this.held = dir;
    this.step(dir);
    this.timer = window.setTimeout(() => this.tick(), 400);
  }

  release(dir?: NavDir): void {
    if (dir && dir !== this.held) return;
    window.clearTimeout(this.timer);
    this.held = null;
  }

  private tick(): void {
    if (!this.held) return;
    this.step(this.held);
    this.timer = window.setTimeout(() => this.tick(), 140);
  }
}
