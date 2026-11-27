/**
 * 电视面板里的头像和小图：玩家用自己选的人物头像，电脑对手用他的人物头像（Q 版配色的对手是一个衣服颜色的圆、写着名字的第一个字），
 * 熟练度最近几局的折线。
 */
import type { Opponent } from '@/config/opponents';
import type { AvatarId } from '@/render/avatar/roster';
import { AVATAR_THUMBS } from '@/render/avatar/thumbs';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** 玩家的头像（opp = 对面那一边的颜色） */
export function playerFace(id: AvatarId, opp = false): string {
  return `<div class="tv-face${opp ? ' opp' : ''}"><img src="${AVATAR_THUMBS[id]}" alt="" /></div>`;
}

/** 电脑对手的头像 */
export function opponentFace(o: Opponent): string {
  const look = o.look;
  if ('kenney' in look) return playerFace(look.kenney, true);
  return `<div class="tv-face opp" style="background:${hex(look.q.shirt)}">${o.name[0]}</div>`;
}

/** 熟练度最近几局的折线（不到两局不画） */
export function skillChart(history: readonly number[]): string {
  if (history.length < 2) return '';
  const w = 300;
  const h = 60;
  const lo = Math.min(...history);
  const hi = Math.max(...history, lo + 50);
  const pts = history.map((v, i) => [
    (i / (history.length - 1)) * (w - 12) + 6,
    h - 6 - ((v - lo) / (hi - lo)) * (h - 12),
  ]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="tv-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${line}" fill="none" stroke="var(--tv-p1)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="5" fill="var(--tv-accent)" />
  </svg>`;
}
