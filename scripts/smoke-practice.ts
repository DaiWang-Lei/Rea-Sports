/**
 * 发球机练习冒烟测试（需要先 pnpm dev，或传线上网址）：用键盘模式，脚本在理想击球时刻附近按 F / J，
 * 检查每一球都有结果、大部分能回进，截图，打印页面报错。
 * 用法：pnpm smoke:practice [BASE 网址] [截图路径]
 */
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? process.env.BASE ?? 'https://localhost:5288').replace(/\/$/, '');
const shot = process.argv[3] ?? 'smoke-practice.png';
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
await page.goto(`${BASE}/?mode=practice&debug=1`);
await sleep(1500);
await page.screenshot({ path: shot.replace(/\.png$/, '-connect.png') });
await page.getByRole('button', { name: '用键盘试一试' }).click();

type St = {
  step: string;
  t: number;
  awaiting: boolean;
  planT: number | null;
  planX: number | null;
  bodyX: number;
  feeds: number;
  results: Record<string, number>;
};
const state = () =>
  page.evaluate(() =>
    (window as unknown as { __practice: { debugState(): unknown } }).__practice.debugState()
  ) as Promise<St>;

const target = 12;
let swungFeed = -1;
const t0 = Date.now();
let shotTaken = false;
while (Date.now() - t0 < 60000) {
  const s = await state();
  const done = Object.values(s.results).reduce((a, b) => a + b, 0);
  if (done >= target) break;
  if (s.awaiting && s.planT !== null && swungFeed !== s.feeds) {
    const dt = s.planT - s.t;
    // 画面延迟补偿默认 50ms：按键要比理想时刻晚 50ms 才「正好」
    if (dt <= -0.03) {
      swungFeed = s.feeds;
      const key = (s.planX ?? 0) - s.bodyX > -0.15 ? 'f' : 'j';
      await page.keyboard.press(key);
      if (!shotTaken && done >= 3) {
        await sleep(120);
        await page.screenshot({ path: shot });
        shotTaken = true;
      }
    }
  }
  await sleep(4);
}
const s = await state();
console.log(`送球 ${s.feeds}，结果：${JSON.stringify(s.results)}`);
console.log(`页面报错：${errors.length ? errors.join('\n') : '无'}`);
await browser.close();
const done = Object.values(s.results).reduce((a, b) => a + b, 0);
process.exit(done >= target && (s.results.in ?? 0) >= target * 0.6 && !errors.length ? 0 : 1);
