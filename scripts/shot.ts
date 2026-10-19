/**
 * 截图工具（需要先 pnpm dev）：pnpm shot <路径或网址> <输出.png> [宽] [高] [等待毫秒]
 * 例：pnpm shot /phone.html phone.png 390 844
 */
import { chromium } from 'playwright-core';

const [target = '/', out = 'shot.png', w = '1280', h = '720', waitMs = '1500'] =
  process.argv.slice(2);
const BASE = process.env.BASE ?? 'https://localhost:5288';
const url = /^https?:/.test(target) ? target : `${BASE}${target}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: { width: Number(w), height: Number(h) },
  ignoreHTTPSErrors: true,
  isMobile: Number(w) < 600,
  hasTouch: Number(w) < 600,
  deviceScaleFactor: Number(w) < 600 ? 2 : 1,
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});
await page.goto(url);
await page.waitForTimeout(Number(waitMs));
await page.screenshot({ path: out });
console.log(`截图：${out}；页面报错：${errors.length ? errors.join(' | ') : '无'}`);
await browser.close();
