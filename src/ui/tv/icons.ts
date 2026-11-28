/** 电视界面的图标（自己画的简单 SVG）：比赛、连续回击、练习、远程对打 */

const svg = (body: string) =>
  `<svg class="tv-icon" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

/** 比赛：两只交叉的球拍和一个球 */
export const ICON_MATCH = svg(`
  <circle cx="60" cy="60" r="56" fill="#e8f6ff"/>
  <g transform="rotate(-35 60 60)">
    <rect x="54" y="66" width="12" height="34" rx="5" fill="#c98f4e"/>
    <circle cx="60" cy="46" r="26" fill="#e63946"/>
  </g>
  <g transform="rotate(35 60 60)">
    <rect x="54" y="66" width="12" height="34" rx="5" fill="#a8743b"/>
    <circle cx="60" cy="46" r="26" fill="#2b2d42"/>
  </g>
  <circle cx="92" cy="26" r="9" fill="#fff" stroke="#ffb547" stroke-width="3"/>`);

/** 连续回击：一只球拍对着一摞纸杯 */
export const ICON_CHALLENGE = svg(`
  <circle cx="60" cy="60" r="56" fill="#fff3e0"/>
  <path d="M70 92 L76 64 L96 64 L102 92 Z" fill="#2a9d8f"/>
  <path d="M60 64 L66 38 L84 38 L90 64 Z" fill="#ff9f1c"/>
  <path d="M80 64 L86 38 L104 38 L110 64 Z" fill="#e63946" opacity="0.9"/>
  <g transform="rotate(-25 34 62)">
    <rect x="29" y="70" width="10" height="28" rx="4" fill="#c98f4e"/>
    <circle cx="34" cy="54" r="20" fill="#e63946"/>
  </g>
  <circle cx="56" cy="30" r="7" fill="#fff" stroke="#ffb547" stroke-width="3"/>`);

/** 练习：发球机和送出来的球 */
export const ICON_PRACTICE = svg(`
  <circle cx="60" cy="60" r="56" fill="#e7f8ef"/>
  <rect x="24" y="58" width="44" height="34" rx="8" fill="#457b9d"/>
  <rect x="36" y="42" width="20" height="20" rx="6" fill="#1d3557"/>
  <rect x="56" y="64" width="22" height="12" rx="6" fill="#1d3557"/>
  <circle cx="92" cy="58" r="8" fill="#fff" stroke="#ffb547" stroke-width="3"/>
  <circle cx="104" cy="42" r="6" fill="#fff" stroke="#ffb547" stroke-width="3" opacity="0.7"/>
  <rect x="30" y="92" width="8" height="10" rx="3" fill="#1d3557"/>
  <rect x="54" y="92" width="8" height="10" rx="3" fill="#1d3557"/>`);

/** 远程对打：两只球拍隔着两道信号弧 */
export const ICON_ONLINE = svg(`
  <circle cx="60" cy="60" r="56" fill="#e8fff2"/>
  <g transform="rotate(-30 30 64)">
    <rect x="25" y="72" width="10" height="26" rx="4" fill="#c98f4e"/>
    <circle cx="30" cy="56" r="18" fill="#e63946"/>
  </g>
  <g transform="rotate(30 90 64)">
    <rect x="85" y="72" width="10" height="26" rx="4" fill="#a8743b"/>
    <circle cx="90" cy="56" r="18" fill="#2b2d42"/>
  </g>
  <path d="M52 40 Q60 32 68 40" fill="none" stroke="#23b26d" stroke-width="5" stroke-linecap="round"/>
  <path d="M46 32 Q60 18 74 32" fill="none" stroke="#23b26d" stroke-width="5" stroke-linecap="round"/>
  <circle cx="60" cy="48" r="5" fill="#23b26d"/>`);
