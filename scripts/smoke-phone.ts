/**
 * 冒烟测试（需要先 pnpm dev）：
 *  1) 无界面 Chrome 打开调试页；
 *  2) 用 Node 模拟一台手机，经中转服务器发 60Hz 体感数据（换几个朝向、每次停稳，数据物理上自洽），再按一下「回中」；
 *  3) 检查调试页出现了手机卡片、样本频率正常、轴向检查通过，截图，打印页面报错。
 * 用法：pnpm smoke:phone [截图路径]
 */
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import { fromAxisAngle, multiply, quat, rotateInverse } from '../src/core/quat';
import { vec3 } from '../src/core/vec3';

const BASE = process.env.BASE ?? 'https://localhost:5288';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shot = process.argv[2] ?? 'smoke-phone.png';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 1600 },
  ignoreHTTPSErrors: true,
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});
await page.goto(`${BASE}/imu-debug.html`);
await sleep(800);

const ws = new WebSocket(
  `${BASE.replace(/^http/, 'ws')}/motion?role=phone&id=smoke&name=${encodeURIComponent('模拟手机')}`,
  { rejectUnauthorized: false }
);
await new Promise((r, j) => {
  ws.once('open', r);
  ws.once('error', j);
});
ws.send(
  JSON.stringify({
    type: 'meta',
    platform: 'android',
    ua: 'smoke-test',
    accelSign: 1,
    hz: 60,
    canVibrate: true,
    hasGyro: true,
    gyroAxes: 'xyz',
  })
);

const vibrations: unknown[] = [];
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
  if (msg.type === 'vibrate') vibrations.push(msg.pattern);
});

// 60Hz、约 8 秒：换个朝向（0.6 秒内绕不同的轴转约 90°）→ 停稳 0.4 秒，反复 8 次，
// 轴向检查靠「两次停稳之间」的对比
const AXES = [
  vec3(1, 0.3, 0),
  vec3(0, 1, 0.4),
  vec3(0.2, 0, 1),
  vec3(-1, 0.5, 0.3),
  vec3(0.4, -1, 0),
  vec3(0, 0.3, -1),
  vec3(1, 1, 0),
  vec3(0, -1, 1),
];
let q = quat();
const dt = 1 / 60;
const t0 = 5000;
const start = Date.now();
for (let i = 0; i < 480; i++) {
  const k = Math.floor(i / 60);
  const phase = (i % 60) / 60; // 前 0.6 秒转、后 0.4 秒停
  const ax = AXES[k];
  const l = Math.hypot(ax.x, ax.y, ax.z);
  // 0.6 秒内转 90°：角速度按 sin 形状，积分为 90°
  const rate = phase < 0.6 ? ((90 * Math.PI) / (2 * 0.6)) * Math.sin((Math.PI * phase) / 0.6) : 0;
  const w = vec3((ax.x / l) * rate, (ax.y / l) * rate, (ax.z / l) * rate);
  q = multiply(q, fromAxisAngle(w.x, w.y, w.z, rate * (Math.PI / 180) * dt));
  const a = rotateInverse(q, vec3(0, 0, 1));
  ws.send(
    JSON.stringify({
      type: 'imu',
      seq: i,
      t: t0 + i * 1000 * dt,
      g: [w.x, w.y, w.z],
      a: [a.x, a.y, a.z],
    })
  );
  if (i === 300) {
    ws.send(JSON.stringify({ type: 'btn', name: 'recenter', down: true }));
    ws.send(JSON.stringify({ type: 'btn', name: 'recenter', down: false }));
  }
  const due = start + (i + 1) * 1000 * dt;
  const wait = due - Date.now();
  if (wait > 0) await sleep(wait);
}

// 让调试页给手机发一次震动
await page.getByRole('button', { name: '击球' }).click();
await sleep(600);

const cards = await page.locator('#devices').innerText();
const axis = await page.locator('#axis-check').innerText();
const logText = await page.locator('#log').innerText();
await page.screenshot({ path: shot, fullPage: true });
await page.locator('#sec-connect').screenshot({ path: shot.replace(/\.png$/, '-connect.png') });
console.log('—— 设备卡片 ——\n' + cards);
console.log('—— 轴向检查 ——\n' + axis);
console.log('—— 日志（前几行）——\n' + logText.split('\n').slice(0, 6).join('\n'));
console.log(`手机收到的震动指令：${JSON.stringify(vibrations)}`);
console.log(`页面报错：${errors.length ? errors.join('\n') : '无'}`);
console.log(`截图：${shot}`);
ws.close();
await browser.close();
