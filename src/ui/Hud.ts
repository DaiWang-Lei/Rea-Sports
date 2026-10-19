/** 画面上的文字层：比分（WSR 在两分之间才显示）、中央大字提示、发球方标记 */
import './hud.css';
import type { Side } from '@/sim/constants';

export interface HudNames {
  near: string;
  far: string;
}

export class Hud {
  readonly el: HTMLDivElement;
  private readonly score: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private readonly corner: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private messageTimer = 0;

  constructor(
    parent: HTMLElement,
    private names: HudNames
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-score"></div>
      <div class="hud-center"><div class="hud-msg"></div><div class="hud-sub"></div></div>
      <div class="hud-corner"></div>
      <div class="hud-hint"></div>`;
    parent.appendChild(this.el);
    this.score = this.el.querySelector('.hud-score')!;
    this.message = this.el.querySelector('.hud-msg')!;
    this.sub = this.el.querySelector('.hud-sub')!;
    this.corner = this.el.querySelector('.hud-corner')!;
    this.hint = this.el.querySelector('.hud-hint')!;
  }

  setNames(names: HudNames): void {
    this.names = names;
  }

  showScore(score: Record<Side, number>, server: Side | null, visible: boolean, label = ''): void {
    this.score.classList.toggle('visible', visible);
    const dot = (s: Side) => (server === s ? '<span class="serve-dot" title="发球方"></span>' : '');
    this.score.innerHTML = `
      ${label ? `<div class="score-label">${label}</div>` : ''}
      <div class="score-row">
        <span class="name near">${dot('near')}${this.names.near}</span>
        <span class="num">${score.near}</span>
        <span class="colon">:</span>
        <span class="num">${score.far}</span>
        <span class="name far">${this.names.far}${dot('far')}</span>
      </div>`;
  }

  /** 中央提示，duration 秒后淡出（0 = 一直显示） */
  flash(
    text: string,
    sub = '',
    duration = 1.6,
    tone: 'normal' | 'good' | 'bad' | 'big' = 'normal'
  ): void {
    this.message.textContent = text;
    this.sub.textContent = sub;
    this.message.className = `hud-msg show ${tone}`;
    this.sub.className = `hud-sub ${sub ? 'show' : ''}`;
    window.clearTimeout(this.messageTimer);
    if (duration > 0) {
      this.messageTimer = window.setTimeout(() => {
        this.message.className = `hud-msg ${tone}`;
        this.sub.className = 'hud-sub';
      }, duration * 1000);
    }
  }

  clearFlash(): void {
    window.clearTimeout(this.messageTimer);
    this.message.className = 'hud-msg';
    this.sub.className = 'hud-sub';
  }

  setCorner(html: string): void {
    this.corner.innerHTML = html;
  }

  setHint(text: string): void {
    this.hint.textContent = text;
    this.hint.classList.toggle('visible', !!text);
  }
}
