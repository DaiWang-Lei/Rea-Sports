/**
 * 「怎么玩」说明卡：每个玩法第一次进来先看一张（示意图 + 三四步），按 A 知道了；看过的记在本机，
 * 之后在暂停（或开始前的面板）里还能点「怎么玩」再看。示意图是自己画的简单 SVG。
 */
import type { OverlayView } from './TvOverlay';
import { tvButton } from './TvOverlay';

export type HowToKind = 'match' | 'versus' | 'challenge' | 'practice';

const KEY = 'rea-howto';

function seenSet(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.map(String) : []);
  } catch {
    return new Set();
  }
}

/** 这个玩法的说明卡看过没有 */
export function howToSeen(kind: HowToKind): boolean {
  return seenSet().has(kind);
}

function markSeen(kind: HowToKind): void {
  const s = seenSet();
  s.add(kind);
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // 隐私模式等：不保存
  }
}

const svg = (body: string) =>
  `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

/** 手里的手柄像球拍一样挥：手柄、挥拍弧线、迎面来的球 */
const SWING = `
  <circle cx="100" cy="100" r="96" fill="#e8f6ff"/>
  <path d="M38 132 Q100 40 166 120" fill="none" stroke="#ff9f1c" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 14"/>
  <path d="M158 104 L168 122 L148 124 Z" fill="#ff9f1c"/>
  <g transform="rotate(-28 82 120)">
    <rect x="70" y="84" width="24" height="70" rx="11" fill="#2f80ed"/>
    <circle cx="82" cy="100" r="5" fill="#fff"/>
    <rect x="76" y="78" width="12" height="8" rx="3" fill="#17324d"/>
  </g>
  <circle cx="150" cy="58" r="11" fill="#fff" stroke="#ffb547" stroke-width="4"/>`;

/** 手柄像遥控器一样指向电视（连接后的校准） */
const POINT = `
  <circle cx="100" cy="100" r="96" fill="#e8f6ff"/>
  <rect x="104" y="40" width="76" height="52" rx="8" fill="#17324d"/>
  <rect x="111" y="47" width="62" height="38" rx="4" fill="#5ec8ff"/>
  <rect x="134" y="92" width="16" height="10" fill="#17324d"/>
  <path d="M84 118 L120 84" stroke="#ff9f1c" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 10"/>
  <g transform="rotate(48 64 140)">
    <rect x="52" y="104" width="24" height="72" rx="11" fill="#2f80ed"/>
    <rect x="58" y="98" width="12" height="8" rx="3" fill="#17324d"/>
    <circle cx="64" cy="122" r="5" fill="#fff"/>
  </g>`;

/** 「指向电视」的示意图（连接页的校准这一步） */
export const POINT_ART = svg(POINT);

/** 两个人各拿一个手柄、各看半个屏幕 */
const SPLIT = `
  <circle cx="100" cy="100" r="96" fill="#e8f6ff"/>
  <rect x="30" y="44" width="140" height="80" rx="10" fill="#17324d"/>
  <rect x="38" y="52" width="60" height="64" rx="4" fill="#5ec8ff"/>
  <rect x="102" y="52" width="60" height="64" rx="4" fill="#ffb38a"/>
  <rect x="56" y="140" width="18" height="40" rx="8" fill="#2f80ed"/>
  <rect x="126" y="140" width="18" height="40" rx="8" fill="#ff7a45"/>`;

/** 教练供球、台上的纸杯靶子 */
const CUPS = `
  <circle cx="100" cy="100" r="96" fill="#fff3e0"/>
  <path d="M30 140 L170 140 L150 100 L50 100 Z" fill="#2a9d8f"/>
  <path d="M100 100 L100 140" stroke="#fff" stroke-width="3"/>
  <path d="M80 104 L84 86 L98 86 L102 104 Z" fill="#ff9f1c"/>
  <path d="M110 104 L114 86 L128 86 L132 104 Z" fill="#e63946"/>
  <path d="M40 60 Q100 20 150 80" fill="none" stroke="#ff9f1c" stroke-width="6" stroke-linecap="round" stroke-dasharray="2 12"/>
  <circle cx="150" cy="80" r="10" fill="#fff" stroke="#ffb547" stroke-width="4"/>
  <text x="152" y="54" font-size="26" font-weight="900" fill="#23b26d" font-family="sans-serif">+1</text>`;

/** 发球机 */
const MACHINE = `
  <circle cx="100" cy="100" r="96" fill="#e8f6ff"/>
  <rect x="120" y="70" width="44" height="56" rx="10" fill="#17324d"/>
  <rect x="112" y="84" width="16" height="16" rx="4" fill="#5f7590"/>
  <path d="M110 92 Q70 60 40 110" fill="none" stroke="#ff9f1c" stroke-width="6" stroke-linecap="round" stroke-dasharray="2 12"/>
  <circle cx="40" cy="110" r="10" fill="#fff" stroke="#ffb547" stroke-width="4"/>
  <rect x="120" y="126" width="10" height="40" fill="#5f7590"/>
  <rect x="154" y="126" width="10" height="40" fill="#5f7590"/>`;

const CARDS: Record<HowToKind, { title: string; art: string; steps: string[] }> = {
  match: {
    title: '和电脑对打',
    art: SWING,
    steps: [
      '手柄像球拍一样握着，像真的打球那样挥',
      '轮到你发球：<b>向上抖一下</b>手柄（或按 A）把球抛起来，球落下时挥拍',
      '来球在你右边就正手挥，左边就反手挥',
      '挥得快打得重；往上刷拉上旋，往下切搓下旋',
    ],
  },
  versus: {
    title: '两个人对打',
    art: SPLIT,
    steps: [
      '1P 看左半屏，2P 看右半屏',
      '轮到谁发球谁<b>向上抖手柄</b>（或按 A）抛球',
      '两个人站开一点，握紧手柄、最好挂上腕带',
    ],
  },
  challenge: {
    title: '连续回击',
    art: CUPS,
    steps: [
      '教练会不停把球打过来，<b>回进一球 1 分</b>',
      '漏一球（没接到、出界、下网）就结束',
      '满 10 分台上出现纸杯靶子，打中再加 3 分',
      '最多 4 个人轮流用同一个手柄打，比谁分高',
    ],
  },
  practice: {
    title: '练习',
    art: MACHINE,
    steps: [
      '发球机一个接一个送球，<b>随便挥、不计输赢</b>',
      '左右换难度和送球区域',
      '每一球都会告诉你挥早了还是晚了',
    ],
  },
};

/** 说明卡：A（或 B）知道了 → done */
export function howToView(kind: HowToKind, done: () => void): OverlayView {
  const c = CARDS[kind];
  const ok = () => {
    markSeen(kind);
    done();
  };
  return {
    className: 'tv-wide',
    html: `<h2>怎么玩 · ${c.title}</h2>
      <div class="tv-howto">${svg(c.art)}<ol>${c.steps.map((s) => `<li>${s}</li>`).join('')}</ol></div>
      <div class="tv-buttons tv-inline">${tvButton('ok', '知道了', true, true)}</div>`,
    hints: [['A', '知道了']],
    onBack: ok,
    onAct: ok,
  };
}
