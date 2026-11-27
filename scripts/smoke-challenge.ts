/**
 * 连续回击冒烟测试（需要先 pnpm dev，或传线上网址）：用键盘模式打一轮。
 * 来球在理想击球时刻按 F（正手）/ J（反手）（按住 W 拉上旋，下旋来球才不下网），回到 12 分后停手，这一轮应当结束、出结算面板。
 * 脚本打球也会偶尔失误：没到 12 分就结束的话再来一轮，最多 3 轮。
 * 检查：分数一球一球涨、满 10 分摆出靶子、停手后这一轮结束、最高分存下来、页面没有报错。
 * 用法：pnpm smoke:challenge [BASE 网址] [截图路径]
 */
import { chromium } from 'playwright-core';
import { CHROME_ARGS } from './chromeArgs';

const BASE = (process.argv[2] ?? process.env.BASE ?? 'https://localhost:5288').replace(/\/$/, '');
const shot = process.argv[3] ?? 'smoke-challenge.png';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STOP_AT = 12;

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: CHROME_ARGS,
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  ignoreHTTPSErrors: true,
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto(`${BASE}/?mode=challenge&debug=1`);
await page.evaluate(`localStorage.removeItem('rea-challenge')`);
await sleep(1200);

interface St {
  step: string;
  t: number;
  score: number;
  over: boolean;
  level: number;
  cups: number;
  awaiting: boolean;
  planT: number | null;
  stance: string;
  best: number;
}
const state = () => page.evaluate('window.__challenge.debugState()') as Promise<St>;

await page.click('[data-act="keyboard"]');
await sleep(300);
console.log(`开始前：${(await state()).step}`);
// 第一次进来先是「怎么玩」，再是开始前的面板：按回车直到开打
for (let i = 0; i < 3 && (await state()).step !== 'run'; i++) {
  await page.keyboard.press('Enter');
  await sleep(200);
}

let swungFor: number | null = null;
let maxCups = 0;
let maxLevel = 1;
let shotTaken = false;
let tries = 1;
const t0 = Date.now();
let s = await state();
while (Date.now() - t0 < 300000) {
  s = await state();
  if (s.step === 'done') {
    if (s.score >= STOP_AT || tries >= 3) break;
    // 中途失误：再来一轮
    tries++;
    await page.keyboard.press('Enter');
    await sleep(200);
    await page.keyboard.press('Enter');
    await sleep(200);
    swungFor = null;
    continue;
  }
  maxCups = Math.max(maxCups, s.cups);
  maxLevel = Math.max(maxLevel, s.level);
  if (!shotTaken && s.cups >= 3) {
    shotTaken = true;
    await page.screenshot({ path: shot });
  }
  // 理想时刻按键（画面延迟补偿默认 50ms，按键要晚一点才「正好」）；到了 STOP_AT 分就不再挥
  if (
    s.score < STOP_AT &&
    s.awaiting &&
    s.planT !== null &&
    swungFor !== s.planT &&
    s.t >= s.planT + 0.03
  ) {
    swungFor = s.planT;
    await page.keyboard.down('w');
    await page.keyboard.press(s.stance === 'fh' ? 'f' : 'j');
    await page.keyboard.up('w');
    continue;
  }
  await sleep(4);
}
await sleep(400);
const panel = await page.locator('.tv-panel').innerText();
const reason = await page.locator('.hud-msg').innerText();
if (!shotTaken) await page.screenshot({ path: shot });
console.log(
  `第 ${tries} 轮 ${s.score} 分（第 ${STOP_AT} 分后停手），最高到难度 ${maxLevel}，台上最多 ${maxCups} 个靶子，结束：${s.step}（${reason}），本机最高 ${s.best}`
);
const ok =
  s.step === 'done' &&
  s.score >= STOP_AT &&
  maxCups > 0 &&
  maxLevel >= 2 &&
  s.best >= s.score &&
  panel.includes(`${s.score}`);
console.log(
  `连续回击：${ok ? '正常' : '不正常'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || !ok ? 1 : 0);
