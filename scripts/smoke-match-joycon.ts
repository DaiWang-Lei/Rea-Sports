/**
 * Joy-Con → 和电脑对打 端到端冒烟测试（需要先 pnpm dev；不需要真手柄）：
 * 在页面里插一个模拟 Joy-Con（?debug=1 暴露的实例），每 15ms 送 3 个样本，陀螺带一点零点偏差。
 * 流程：指向电视按住 X + ZR 校准（直接调组合键的同一个入口）→ 立起来 → 按 A 开始比赛
 * → 轮到自己发球时「向上抖」（竖直比力 0.09 秒内升到 2.6G）
 * → 球落下时合成正手挥拍发球 → 来球按站位合成正手（逆时针）/ 反手（顺时针）挥拍。打 4 分。
 * 同时测「录制这局」：开局后暂停、开始录制，打完 4 分后停止并下载，存到第二个参数给的路径。
 * 检查：抖手柄能抛球（不是按键）、能发球和回球、比分正常推进、录制能下载、
 * 电视方向的自动校正没有乱拉（每球都回到准备姿势，偏航不该变）、页面没有报错。
 * 用法：pnpm smoke:match-joycon [截图路径] [录制文件路径]
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'https://localhost:5288';
const shot = process.argv[2] ?? 'smoke-match-joycon.png';
const recOut = process.argv[3] ?? 'smoke-match-record.json';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BIAS = { x: 0.6, y: -0.5, z: 0.4 };

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
await sleep(800);

// 模拟手柄（同 smoke-practice-joycon）：陀螺 = 零点偏差 + 噪声 + 绕竖直轴的转速（window.__yawDps，°/s）。
// window.__upright：0 平放 / 1 立着；window.__home：慢慢转回准备姿势；
// window.__flickUntil：在这个时刻（performance.now）之前叠加一次向上的加速（正弦，峰值 2.6G）。
// 以字符串注入：tsx 会给具名函数包一层 __name，页面里没有这个函数
await page.evaluate(`(() => {
  const bias = ${JSON.stringify(BIAS)};
  const input = window.__match.input;
  const d = input.newDevice('sim-joycon', 'joycon', 'Joy-Con (R)（模拟）');
  input.activeKey = 'sim-joycon';
  window.__yawDps = 0;
  window.__upright = 0;
  window.__home = false;
  window.__flickUntil = 0;
  let tilt = 0;
  let yawAcc = 0;
  // 转角按样本时间戳累计，和融合算法一致：定时器常常晚到，样本间隔不总是 5ms；融合把单个间隔限制在 0.5–50ms
  let lastT = performance.now();
  setInterval(() => {
    const now = performance.now();
    const r = () => (Math.random() - 0.5) * 0.6;
    const samples = [2, 1, 0].map((k) => {
      const t = now - k * 5;
      let wy = 0;
      if (tilt < window.__upright) { tilt = Math.min(window.__upright, tilt + 5 / 300); wy = -300; }
      else if (tilt > window.__upright) { tilt = Math.max(window.__upright, tilt - 5 / 300); wy = 300; }
      const a = (tilt * Math.PI) / 2;
      const up = { x: Math.sin(a), z: Math.cos(a) };
      const dt = Math.min(0.05, Math.max(0.0005, (t - lastT) / 1000));
      lastT = t;
      let yr = window.__yawDps;
      if (window.__home && yr === 0) {
        if (Math.abs(yawAcc) > 0.2) yr = -Math.sign(yawAcc) * Math.min(172, Math.abs(yawAcc) / dt);
        else window.__home = false;
      }
      yawAcc += yr * dt;
      // 向上抖：90ms 的正弦脉冲，竖直比力 1G → 2.6G → 1G
      const left = window.__flickUntil - t;
      const g = left > 0 && left < 90 ? 1 + 1.6 * Math.sin((Math.PI * (90 - left)) / 90) : 1;
      return {
        t,
        gyro: { x: bias.x + up.x * yr + r(), y: bias.y + wy + r(), z: bias.z + up.z * yr + r() },
        accel: { x: up.x * g + r() * 0.01, y: r() * 0.01, z: up.z * g + r() * 0.01 },
        clipped: false,
      };
    });
    input.onSamples(d, samples);
  }, 15);
})()`);

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
  lastToss: string | null;
};
const state = () =>
  page.evaluate(() =>
    (window as unknown as { __match: { debugState(): unknown } }).__match.debugState()
  ) as Promise<St>;
const press = (b: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __match: { onButton(n: string): void } }).__match.onButton(name),
    b
  );

// 指向电视按住 X + ZR → 立起来 → 选对手面板按 A 开始
await sleep(1000);
for (let i = 0; i < 60 && (await state()).step === 'setup'; i++) {
  if (i % 30 === 0) await page.evaluate('window.__match.input.requestCalibration()');
  await sleep(100);
}
console.log(`校准后步骤：${(await state()).step}`);
const blade = (await page.evaluate('window.__match.input.active.paddle.bladeUp()')) as {
  y: number;
};
const poseOk = blade.y > 0.95;
console.log(`校准后画面里拍头朝前（指向电视）：${poseOk ? '对' : '不对'}`);
await page.evaluate('window.__upright = 1');
await sleep(700);
await press('confirm');
await sleep(300);
console.log(`开始后步骤：${(await state()).step}`);
// 暂停 → 开始录制 → 继续
await page.keyboard.press('Escape');
await sleep(200);
await page.click('[data-act="rec-start"]');
await page.click('[data-act="resume"]');
await sleep(200);
console.log(`录制：${(await page.locator('.pr-status').innerText()).split('\n').pop()}`);

/** 合成一次挥拍：每 15ms 一档，角速度升到 20 rad/s 再回落；dir = +1 逆时针（正手）、−1 顺时针（反手） */
async function swing(dir: 1 | -1) {
  const prof = [2, 5, 9, 13, 17, 20, 18, 13, 8, 4, 1, 0];
  for (const w of prof) {
    await page.evaluate(
      (dps) => {
        (window as unknown as { __yawDps: number }).__yawDps = dps;
      },
      (dir * w * 180) / Math.PI
    );
    await sleep(15);
  }
  await sleep(150);
  await page.evaluate('window.__yawDps = 0; window.__home = true');
  for (let i = 0; i < 100 && (await page.evaluate('window.__home')); i++) await sleep(20);
}

let flicks = 0;
let flickTosses = 0;
let serves = 0;
let returns = 0;
let servedFor: number | null = null;
let swungFor: number | null = null;
let lastFlickAt = 0;
const t0 = Date.now();
let s = await state();
while (Date.now() - t0 < 120000) {
  s = await state();
  if (s.step !== 'play' || s.result || s.score.near + s.score.far >= 4) break;
  if (s.canToss && Date.now() - lastFlickAt > 1500) {
    lastFlickAt = Date.now();
    flicks++;
    await page.evaluate('window.__flickUntil = performance.now() + 140');
    await sleep(250);
    const after = await state();
    if (after.phase === 'toss' && after.lastToss === 'flick') flickTosses++;
    continue;
  }
  // Joy-Con 快速确认到接触约 76ms；越过 11 rad/s 大约在第 4 档（约 50ms）；画面延迟补偿 50ms
  if (s.serveAt !== null && servedFor !== s.serveAt) {
    const lead = (s.serveAt - s.t) * 1000 + 50 - 76 - 50;
    if (lead <= 10) {
      servedFor = s.serveAt;
      serves++;
      await swing(1);
      continue;
    }
  }
  if (s.awaiting && s.planT !== null && swungFor !== s.planT) {
    const lead = (s.planT - s.t) * 1000 + 50 - 76 - 50;
    if (lead <= 10) {
      swungFor = s.planT;
      returns++;
      await swing(s.stance === 'fh' ? 1 : -1);
      continue;
    }
  }
  await sleep(5);
}
await page.screenshot({ path: shot });
// 暂停 → 停止并下载
await page.keyboard.press('Escape');
await sleep(200);
const [dl] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-act="rec-stop"]'),
]);
await dl.saveAs(recOut);
console.log(`录制文件：${recOut}（${dl.suggestedFilename()}）`);
console.log(
  `抖手柄 ${flicks} 次，抛出去 ${flickTosses} 次；发球挥拍 ${serves} 次，回球挥拍 ${returns} 次；比分 你 ${s.score.near} : ${s.score.far} 电脑`
);
const ok = flickTosses >= 2 && flickTosses === flicks && s.score.near + s.score.far >= 3;
// 校准时没等平放测零点：模拟的零点偏差（竖直分量约 0.6°/s）会让偏航真的漂，自动校正应当把它补上——
// 回到准备姿势时，画面里拍面的角度应当保持在校准后学到的习惯角度上
const track = (await page.evaluate(
  `(() => {
    const p = window.__match.input.active.paddle;
    const nan = (v) => (Number.isNaN(v) ? null : v);
    return { n: p.faceNormal(), front: nan(p.ready.front), back: nan(p.ready.back), drift: p.drift };
  })()`
)) as {
  n: { x: number; y: number; z: number };
  front: number | null;
  back: number | null;
  drift: number;
};
let e = Math.atan2(track.n.y, track.n.x) - Math.PI / 2;
e = Math.atan2(Math.sin(e), Math.cos(e));
const front = Math.abs(e) <= Math.PI / 2;
if (!front) e += e > 0 ? -Math.PI : Math.PI;
const ref = front ? track.front : track.back;
const errDeg = ref === null ? NaN : ((e - ref) * 180) / Math.PI;
const driftDps = (track.drift * 180) / Math.PI;
const trackOk = Number.isFinite(errDeg) && Math.abs(errDeg) < 3;
console.log(
  `自动校正：准备姿势的拍面和学到的习惯角度差 ${errDeg.toFixed(1)}°，估计的漂移速度 ${driftDps.toFixed(2)}°/s` +
    `（模拟零点偏差的竖直分量 0.6°/s）：${trackOk ? '正常' : '不正常'}`
);
console.log(
  `抛球与比赛：${ok ? '正常' : '不正常'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || !ok || !trackOk || !poseOk ? 1 : 0);
