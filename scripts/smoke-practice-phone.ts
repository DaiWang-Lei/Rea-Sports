/**
 * 手机 → 发球机练习 端到端冒烟测试（需要先 pnpm dev，走本地中转）：
 * 用 Node 模拟一台手机，屏幕朝上放平、顶端指向电视，按「确认」完成校准，
 * 然后在理想击球时刻附近合成一次正手挥拍（绕竖直轴逆时针转动），检查回球结果。
 * 同时测「录制这局」：暂停菜单里开始录制，打完后停止并下载，存到第二个参数给的路径。
 * 用法：pnpm smoke:practice-phone [截图路径] [录制文件路径]
 */
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'https://localhost:5288';
const shot = process.argv[2] ?? 'smoke-practice-phone.png';
const recOut = process.argv[3] ?? 'smoke-practice-record.json';
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
await sleep(1000);

const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/motion?role=phone&id=smokep&name=sim`, {
  rejectUnauthorized: false,
});
await new Promise((r, j) => {
  ws.once('open', r);
  ws.once('error', j);
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: m.t }));
});
const send = (o: object) => ws.send(JSON.stringify(o));
send({
  type: 'meta',
  platform: 'ios',
  ua: 'smoke',
  accelSign: 1,
  hz: 60,
  canVibrate: false,
  hasGyro: true,
  gyroAxes: 'xyz',
});

// 机体系：屏幕朝上放平、顶端指向电视 → 加速度 (0,0,1)，绕竖直轴的转动 = 机体 z
// home = true：按累计转过的角度慢慢转回准备姿势（172°/s，低于慢挥阈值），转完自动变回 false
let seq = 0;
let yawRate = 0; // 度/秒
let yawAcc = 0; // 度
let home = false;
const tStart = Date.now();
const timer = setInterval(() => {
  if (home && yawRate === 0) {
    if (Math.abs(yawAcc) > 0.2) {
      const r = -Math.sign(yawAcc) * Math.min(172, Math.abs(yawAcc) * 60);
      yawAcc += r / 60;
      send({
        type: 'imu',
        seq: seq++,
        t: Date.now() - tStart + 100000,
        g: [0, 0, r],
        a: [0, 0, 1],
      });
      return;
    }
    home = false;
  }
  yawAcc += yawRate / 60;
  send({
    type: 'imu',
    seq: seq++,
    t: Date.now() - tStart + 100000,
    g: [0, 0, yawRate],
    a: [0, 0, 1],
  });
}, 1000 / 60);

type St = {
  step: string;
  t: number;
  awaiting: boolean;
  planT: number | null;
  feeds: number;
  results: Record<string, number>;
};
const state = () =>
  page.evaluate(() =>
    (window as unknown as { __practice: { debugState(): unknown } }).__practice.debugState()
  ) as Promise<St>;

// 等页面进入校准步骤
for (let i = 0; i < 50 && (await state()).step === 'connect'; i++) await sleep(100);
console.log(`连接后步骤：${(await state()).step}`);
send({ type: 'btn', name: 'confirm', down: true });
send({ type: 'btn', name: 'confirm', down: false });
await sleep(300);
console.log(`校准后步骤：${(await state()).step}`);

// 暂停 → 开始录制 → 继续
await page.keyboard.press('Escape');
await sleep(200);
await page.click('[data-act="rec-start"]');
await page.click('[data-act="resume"]');
console.log(`录制：${(await page.locator('.pr-status').innerText()).split('\n').pop()}`);

/** 合成一次正手：0.2 秒内角速度升到 20 rad/s 再回落；dir = +1 逆时针 */
async function forehand(dir: 1 | -1) {
  const prof = [2, 5, 9, 13, 17, 20, 18, 13, 8, 4, 1, 0];
  for (const w of prof) {
    yawRate = (dir * w * 180) / Math.PI;
    await sleep(1000 / 60);
  }
  yawRate = 0;
  await sleep(150);
  // 收拍：慢慢转回准备姿势（真人每球都会回到准备姿势）
  home = true;
  for (let i = 0; i < 100 && home; i++) await sleep(20);
}

let swung = -1;
const t0 = Date.now();
while (Date.now() - t0 < 40000) {
  const s = await state();
  const done = Object.values(s.results).reduce((a, b) => a + b, 0);
  if (done >= 6) break;
  if (s.awaiting && s.planT !== null && swung !== s.feeds) {
    // 手机快速确认到接触约 62ms；越过 11 rad/s 大约在第 4 个样本（约 67ms）；画面延迟补偿 50ms
    const lead = (s.planT - s.t) * 1000 + 50 - 62 - 67;
    if (lead <= 10) {
      swung = s.feeds;
      await forehand(1);
    }
  }
  await sleep(5);
}
// 暂停 → 停止并下载
await page.keyboard.press('Escape');
await sleep(200);
const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-act="rec-stop"]'),
]);
await dl.saveAs(recOut);
console.log(`录制文件：${recOut}（${dl.suggestedFilename()}）`);
const s = await state();
await page.screenshot({ path: shot });
console.log(`送球 ${s.feeds}，结果：${JSON.stringify(s.results)}`);
console.log(`页面报错：${errors.length ? errors.join('\n') : '无'}`);
clearInterval(timer);
ws.close();
await browser.close();
process.exit(errors.length ? 1 : 0);
