/**
 * 联机测试页冒烟测试（需要先 pnpm dev，且能访问外网的公共 MQTT 服务器）：两个独立的浏览器上下文，
 * 一个打开 net.html 开房间，另一个打开分享链接加入；检查能连上、测到往返延迟、给出结论。
 * 同一台电脑上两边是「局域网直连」，延迟很低；真正的异地测试要两个人各自打开。
 * 用法：pnpm smoke:net [BASE 网址]，默认 https://localhost:5288；也可以测线上
 */
import { chromium } from 'playwright-core';
import { CHROME_ARGS } from './chromeArgs';

const BASE = (process.argv[2] ?? process.env.BASE ?? 'https://localhost:5288').replace(/\/$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: CHROME_ARGS,
});
const errors: string[] = [];
const open = async (tag: string, url: string) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`);
  });
  await page.goto(url);
  return page;
};

type Net = {
  state: { connected: boolean; failed: boolean; path: string | null; brokerOk: boolean };
  rtts: number[];
};
const read = (page: import('playwright-core').Page) =>
  page.evaluate(() => {
    const n = (window as unknown as { __net: Net }).__net;
    return {
      ...n.state,
      n: n.rtts.length,
      rtt: [...n.rtts].sort((a, b) => a - b)[n.rtts.length >> 1],
    };
  });

const host = await open('开房间', `${BASE}/net.html`);
await sleep(1500);
const room = (await host.locator('.nt-code').textContent())?.trim() ?? '';
const guest = await open('加入', `${BASE}/net.html?room=${room}`);
let h = await read(host);
let g = await read(guest);
const t0 = Date.now();
while (Date.now() - t0 < 40000) {
  h = await read(host);
  g = await read(guest);
  if ((h.n >= 20 && g.n >= 20) || h.failed || g.failed) break;
  await sleep(500);
}
await host.screenshot({ path: process.argv[3] ?? 'smoke-net.png', fullPage: true });
const verdictText = (await host.locator('.nt-verdict h2').textContent())?.trim();
console.log(`房间 ${room}：握手服务器 ${h.brokerOk ? '已连上' : '没连上'}`);
console.log(
  `开房间的一方：${h.connected ? '连上了' : '没连上'}，${h.path ?? '—'}，${h.n} 次往返，中位 ${h.rtt?.toFixed(1) ?? '—'}ms`
);
console.log(
  `加入的一方：${g.connected ? '连上了' : '没连上'}，${g.path ?? '—'}，${g.n} 次往返，中位 ${g.rtt?.toFixed(1) ?? '—'}ms`
);
console.log(`结论：${verdictText}`);
const ok = h.connected && g.connected && h.n >= 20 && g.n >= 20 && !!verdictText;
console.log(
  `联机测试页：${ok ? '正常' : '不正常'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || !ok ? 1 : 0);
