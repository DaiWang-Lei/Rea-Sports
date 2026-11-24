/** 对打里的「人数」一排：1 人（和电脑）/ 2 人（分屏）。按钮带 data-players，由各自的页面接上切换 */
export function playersRow(cur: 1 | 2): string {
  const b = (n: 1 | 2, text: string) =>
    `<button class="${n === cur ? 'on' : ''}" data-players="${n}">${text}</button>`;
  return `<div class="pr-setting"><span>人数</span>${b(1, '1 人（和电脑）')}${b(2, '2 人（分屏）')}</div>`;
}
