/**
 * 叠在画面上的一块电视面板（玩法里的对阵、暂停、设置、结算……）：一张居中的白色大卡片，
 * 摇杆 / 方向键在上面移动焦点，A 确定，B 返回（每次显示时指定 B 做什么）；「◀ 值 ▶」的设置左右直接改值。
 */
import './tokens.css';
import './tv.css';
import type { NavDir } from '@/input/types';
import { FocusNav, KEY_NAV, NavRepeat, type UiSound } from './FocusNav';

export interface OverlayView {
  /** 卡片里的内容 */
  html: string;
  /** B 返回；不给就没有返回 */
  onBack?: () => void;
  /** 「◀ 值 ▶」设置被改了（name = data-spin 的值，d = −1 / 1） */
  onSpin?: (name: string, d: -1 | 1) => void;
  /** 按钮（data-act）被点了 */
  onAct?: (act: string, el: HTMLElement) => void;
  /** 底部按键提示 */
  hints?: [string, string][];
  /** 卡片额外的 class（宽一点、对阵画面……） */
  className?: string;
}

export class TvOverlay {
  readonly el = document.createElement('div');
  private readonly focus: FocusNav;
  /** 摇杆 / 手机方向键按住不放：连续移动 */
  private readonly repeat = new NavRepeat((dir) => this.nav(dir));
  private view: OverlayView | null = null;

  /** background：'tv-dim'（压暗，叠在比赛画面上）或 'tv-sky'（菜单的天色） */
  constructor(parent: HTMLElement, sound: (k: UiSound) => void, background = 'tv-dim') {
    this.el.className = `tv-screen ${background} tv-overlay`;
    this.el.hidden = true;
    parent.appendChild(this.el);
    this.focus = new FocusNav(this.el, { sound, onBack: () => this.view?.onBack?.() });
    this.el.addEventListener('tv-spin', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-spin]');
      if (row) this.view?.onSpin?.(row.dataset.spin!, (e as CustomEvent<-1 | 1>).detail);
    });
    this.el.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-act]');
      if (b && this.el.contains(b) && !b.hasAttribute('disabled'))
        this.view?.onAct?.(b.dataset.act!, b);
    });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** 显示一块面板；keepFocus = 内容刷新（改了设置）时焦点留在原来那一项 */
  show(view: OverlayView, keepFocus = false): void {
    const prevKey = keepFocus ? this.focusKey() : null;
    this.view = view;
    this.el.hidden = false;
    this.el.innerHTML = `<div class="tv-panel ${view.className ?? ''}">${view.html}</div>${
      view.hints ? hintsBar(view.hints) : ''
    }`;
    this.focus.current = null;
    if (prevKey) {
      const el = this.el.querySelector<HTMLElement>(prevKey);
      if (el) el.setAttribute('data-focus-default', '');
    }
    this.focus.refresh();
  }

  hide(): void {
    this.el.hidden = true;
    this.view = null;
    this.repeat.release();
  }

  nav(dir: NavDir): void {
    if (this.visible) this.focus.move(dir);
  }

  /** 手柄的方向（摇杆、手机方向键）按下 / 松开：按住不放连续移动（键盘有自己的连发，走 key） */
  navInput(dir: NavDir, down: boolean): void {
    if (!down) this.repeat.release(dir);
    else if (this.visible) this.repeat.press(dir);
  }

  confirm(): void {
    if (this.visible) this.focus.activate();
  }

  back(): void {
    if (this.visible) this.focus.back();
  }

  /** 键盘：方向键移动、回车 / 空格确定、Esc / 退格返回；面板没显示时不管，返回 false */
  key(e: KeyboardEvent): boolean {
    if (!this.visible) return false;
    const k = e.key.toLowerCase();
    const dir = KEY_NAV[k];
    if (dir) this.nav(dir);
    else if (k === 'enter' || k === ' ') this.confirm();
    else if (k === 'escape' || k === 'backspace') this.back();
    else return true;
    e.preventDefault();
    return true;
  }

  /** 当前焦点那一项怎么在刷新后找回来 */
  private focusKey(): string | null {
    const c = this.focus.current;
    if (!c) return null;
    if (c.dataset.spin) return `[data-spin="${c.dataset.spin}"]`;
    if (c.dataset.act) return `[data-act="${c.dataset.act}"]`;
    return null;
  }
}

/** 底部的按键提示：[按键, 说明] */
export function hintsBar(items: [string, string][]): string {
  return `<div class="tv-hints">${items
    .map(
      ([k, t]) =>
        `<span><span class="tv-key${k.length > 1 ? ' tv-key-wide' : ''}">${k}</span>${t}</span>`
    )
    .join('')}</div>`;
}

/** 「◀ 值 ▶」一行设置 */
export function spinRow(name: string, label: string, value: string): string {
  return `<div class="tv-spin" data-focus data-spin="${name}">
    <span class="tv-spin-label">${label}</span>
    <span class="tv-spin-val"><i data-spin-dir="-1">◀</i><b>${value}</b><i data-spin-dir="1">▶</i></span>
  </div>`;
}

/** 一个大按钮（primary = 橙色主按钮；def = 默认焦点） */
export function tvButton(act: string, text: string, primary = false, def = false): string {
  return `<button class="tv-btn${primary ? ' tv-primary' : ''}" data-focus data-act="${act}"${
    def ? ' data-focus-default' : ''
  }>${text}</button>`;
}
