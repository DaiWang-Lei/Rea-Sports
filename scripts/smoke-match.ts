/**
 * 和电脑对打冒烟测试（需要先 pnpm dev，或传线上网址）：用键盘模式打完一整局（对手入门、6 分制）。
 * 轮到自己发球按空格抛球，球落下时按 F 发球；来球在理想击球时刻附近按 F / J。
 * 中途按一次 Esc 暂停（这一分作废）再继续。检查：能打完一局、出结算页、页面没有报错。
 * 用法：pnpm smoke:match [BASE 网址] [截图路径]
 */
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? process.env.BASE ?? 'https://localhost:5288').replace(/\/$/, '');
const shot = process.argv[3] ?? 'smoke-match.png';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
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
await page.goto(`${BASE}/?mode=match&debug=1`);
await sleep(1500);
await page.getByRole('button', { name: '用键盘试一试' }).click();
await sleep(300);
await page.getByRole('button', { name: '入门' }).click();
await page.getByRole('button', { name: '6 分', exact: true }).click();
await page.screenshot({ path: shot.replace(/(\.png)?$/, '-choose.png') });
await page.getByRole('button', { name: '开始（A）' }).click();

type St = {
  step: string;
  paused: boolean;
  t: number;
  phase: string;
  canToss: boolean;
  serveAt: number | null;
  awaiting: boolean;
  planT: number | null;
  stance: string;
  score: { near: number; far: number };
  result: string | null;
};
const state = () =>
  page.evaluate(() =>
    (window as unknown as { __match: { debugState(): unknown } }).__match.debugState()
  ) as Promise<St>;

let servedFor: number | null = null;
let swungFor: number | null = null;
let pausedOnce = false;
let midShot = false;
const t0 = Date.now();
let s = await state();
while (Date.now() - t0 < 240000) {
  s = await state();
  if (s.step === 'over') break;
  if (s.step !== 'play' || s.paused) {
    await sleep(20);
    continue;
  }
  // 第 2 分开始后的对打中暂停一次：这一分作废，继续后重打
  if (!pausedOnce && s.score.near + s.score.far >= 1 && s.phase === 'play') {
    pausedOnce = true;
    const before = s.score;
    await page.keyboard.press('Escape');
    await sleep(300);
    const p = await state();
    console.log(
      `暂停：${p.paused ? '已暂停' : '没暂停'}，阶段 ${p.phase}，比分 ${p.score.near}:${p.score.far}（暂停前 ${before.near}:${before.far}）`
    );
    if (!p.paused || p.phase !== 'preServe') errors.push('暂停后应该回到发球前');
    await page.keyboard.press('Escape');
    await sleep(200);
    continue;
  }
  if (s.canToss) {
    await page.keyboard.press(' ');
    await sleep(20);
    continue;
  }
  // 发球：球落下时（理想时刻）按 F；画面延迟补偿默认 50ms，按键要晚一点才「正好」
  if (s.serveAt !== null && servedFor !== s.serveAt && s.t >= s.serveAt + 0.03) {
    servedFor = s.serveAt;
    await page.keyboard.press('f');
    continue;
  }
  // 回球
  if (s.awaiting && s.planT !== null && swungFor !== s.planT && s.t >= s.planT + 0.03) {
    swungFor = s.planT;
    await page.keyboard.press(s.stance === 'fh' ? 'f' : 'j');
    if (!midShot && s.score.near + s.score.far >= 2) {
      midShot = true;
      await sleep(150);
      await page.screenshot({ path: shot.replace(/(\.png)?$/, '-play.png') });
    }
    continue;
  }
  await sleep(4);
}
await sleep(500);
await page.screenshot({ path: shot });
console.log(
  `结果：${s.result ?? '没打完'}，比分 你 ${s.score.near} : ${s.score.far} 电脑，用了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`
);
console.log(`页面报错：${errors.length ? errors.join('\n') : '无'}`);
await browser.close();
process.exit(s.step === 'over' && s.result && !errors.length ? 0 : 1);
