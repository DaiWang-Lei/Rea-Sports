/**
 * 联机测试页冒烟测试（需要先 pnpm dev，且能访问外网的公共 MQTT 服务器）：两个独立的浏览器上下文，
 * 一个打开 net.html 开房间，另一个打开分享链接加入；检查能直连、直连和经握手服务器转发都测到往返延迟、给出结论。
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
  direct: { rtts: number[] };
  relay: { rtts: number[] };
};
// 以字符串注入：tsx 会给具名函数包一层 __name，页面里没有这个函数
const read = (page: import('playwright-core').Page) =>
  page.evaluate(`(() => {
    const n = window.__net;
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    return { ...n.state, n: n.direct.rtts.length, sent: n.direct.sent, rtt: med(n.direct.rtts), rn: n.relay.rtts.length, relayRtt: med(n.relay.rtts) };
  })()`) as Promise<
    Net['state'] & { n: number; sent: number; rtt?: number; rn: number; relayRtt?: number }
  >;

const host = await open('开房间', `${BASE}/net.html`);
await sleep(1500);
const room = (await host.locator('.nt-code').textContent())?.trim() ?? '';
const guest = await open('加入', `${BASE}/net.html?room=${room}`);
let h = await read(host);
let g = await read(guest);
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  h = await read(host);
  g = await read(guest);
  if ((h.sent >= 64 && g.sent >= 64 && h.rn >= 20 && g.rn >= 20) || h.failed || g.failed) break;
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
console.log(
  `经握手服务器转发：开房间的一方 ${h.rn} 次往返，中位 ${h.relayRtt?.toFixed(0) ?? '—'}ms；加入的一方 ${g.rn} 次，中位 ${g.relayRtt?.toFixed(0) ?? '—'}ms`
);
console.log(`结论：${verdictText}`);
const copied = (await host.evaluate('window.__net.resultText()')) as string;
console.log(`复制的结果：\n${copied}`);
const ok =
  h.connected &&
  g.connected &&
  h.n >= 60 &&
  g.n >= 60 &&
  h.rn >= 20 &&
  g.rn >= 20 &&
  !!verdictText &&
  !verdictText.startsWith('正在');
console.log(
  `联机测试页：${ok ? '正常' : '不正常'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || !ok ? 1 : 0);
