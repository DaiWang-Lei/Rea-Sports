/**
 * WebRTC 直连端到端冒烟测试（需要先 pnpm dev，且能访问外网的公共 MQTT 服务器）：
 *  - 「电脑」：调试页 ?link=rtc（强制 WebRTC）
 *  - 「手机」：另一个独立的浏览器上下文打开手机页 ?room=…，点「开始」后用合成的 devicemotion 事件模拟传感器
 *  - 检查电脑页收到手机数据（数据正常、采样率），并测一次震动指令能回到手机
 * 用法：pnpm smoke:rtc [BASE 网址]，默认 https://localhost:5288；也可以测线上：pnpm smoke:rtc https://xxx.github.io/Rea-Sports
 */
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] ?? process.env.BASE ?? 'https://localhost:5288').replace(/\/$/, '');
const room = `smoke${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [];
const watch = (tag: string, page: import('playwright-core').Page) => {
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`);
  });
};

const gameCtx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 1400 },
});
const game = await gameCtx.newPage();
watch('电脑', game);
await game.goto(`${BASE}/imu-debug.html?link=rtc&room=${room}`);

const phoneCtx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const phone = await phoneCtx.newPage();
watch('手机', phone);
await phone.goto(`${BASE}/phone.html?room=${room}`);
await phone.getByRole('button', { name: /开始/ }).click();

// 模拟传感器：先平放静止 1 秒（让手机端判断加速度方向），再慢慢转
await phone.evaluate(() => {
  let i = 0;
  setInterval(() => {
    const t = i++ / 60;
    const moving = t > 1;
    const rate = moving
      ? { alpha: 30 * Math.sin(t), beta: 40 * Math.cos(t * 0.8), gamma: 25 * Math.sin(t * 1.3) }
      : { alpha: 0, beta: 0, gamma: 0 };
    window.dispatchEvent(
      new DeviceOrientationEvent('deviceorientation', {
        alpha: 0,
        beta: 0,
        gamma: 0,
        absolute: false,
      })
    );
    window.dispatchEvent(
      new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: 0.05, y: -0.03, z: 9.8 },
        acceleration: { x: 0, y: 0, z: 0 },
        rotationRate: rate,
        interval: 16,
      })
    );
  }, 1000 / 60);
});

// 等握手 + 直连
const t0 = Date.now();
let connected = false;
while (Date.now() - t0 < 30000) {
  const txt = await game.locator('#devices').innerText();
  if (txt.includes('数据正常')) {
    connected = true;
    break;
  }
  await sleep(500);
}
const connectMs = Date.now() - t0;
await sleep(2500);

// 电脑 → 手机：震动指令（无界面 Chrome 里 vibrate 存在即可）
const vibrated = await phone.evaluate(() => {
  const w = window as unknown as { __vib?: unknown[] };
  w.__vib = [];
  // 只记录手机收到的震动指令，不真的震动
  (navigator as unknown as { vibrate: (p: unknown) => boolean }).vibrate = (p: unknown) => {
    w.__vib!.push(p);
    return true;
  };
  return true;
});
await game.getByRole('button', { name: '击球' }).click();
await sleep(800);
const vib = await phone.evaluate(() => (window as unknown as { __vib?: unknown[] }).__vib);

const cards = await game.locator('#devices').innerText();
const hub = await game.locator('#hub-status').innerText();
const phoneStatus = await phone.locator('#status').innerText();
console.log(
  `房间号 ${room}；${connected ? `${(connectMs / 1000).toFixed(1)} 秒内连上` : '30 秒内没连上'}`
);
console.log(`电脑端握手状态：${hub}`);
console.log(`手机端状态：${phoneStatus}`);
console.log('—— 电脑端设备卡片 ——\n' + cards);
console.log(`手机收到的震动：${vibrated ? JSON.stringify(vib) : '—'}`);
console.log(`页面报错：${errors.length ? errors.join('\n') : '无'}`);
await game.screenshot({ path: 'smoke-rtc-game.png' }).catch(() => {});
await browser.close();
process.exit(connected ? 0 : 1);
