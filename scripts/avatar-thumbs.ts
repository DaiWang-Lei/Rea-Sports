/**
 * 重新生成菜单里的人物头像（src/render/avatar/thumbs/*.png）：在浏览器里把每个人物摆好准备姿势拍下来。
 * 改了人物模型或配色后跑一下。需要开着开发服务器。
 * 用法：pnpm thumbs:avatars [BASE 网址]
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CHROME_ARGS } from './chromeArgs';

const BASE = (process.argv[2] ?? process.env.BASE ?? 'https://localhost:5288').replace(/\/$/, '');
const OUT = 'src/render/avatar/thumbs';

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: CHROME_ARGS,
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
// 页面一报错就停（不等到超时）
const failed = new Promise<never>((_, reject) => page.on('pageerror', reject));
// 一个只加载渲染页模块的空页面
await page.route(`${BASE}/__avatar-thumbs.html`, (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body style="margin:0"><script type="module" src="/scripts/avatar-thumbs.page.ts"></script></body></html>',
  })
);
await page.goto(`${BASE}/__avatar-thumbs.html`);
await Promise.race([
  page.waitForFunction('window.__thumbs !== undefined', null, { timeout: 60000 }),
  failed,
]);
const thumbs = (await page.evaluate('window.__thumbs')) as Record<string, string>;
for (const [id, url] of Object.entries(thumbs)) {
  writeFileSync(`${OUT}/${id}.png`, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`${OUT}/${id}.png`);
}
await browser.close();
