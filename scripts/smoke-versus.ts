/**
 * 双人分屏对打 端到端冒烟测试（需要先 pnpm dev；不需要真手柄）：
 * 在页面里插两个模拟 Joy-Con（?debug=1 暴露的实例），各自每 15ms 送 3 个样本，陀螺带一点零点偏差。按键走真实的输入路径。
 * 流程：从「和电脑对打」开始，手柄 a 平放指向电视校准 → 到选对手 → 按 X 换成 2 人（不刷新页面，a 自动当 1P）
 * → 手柄 b 平放指向电视按 A 加入 2P → 立起来 → 按 A 开始
 * → 轮到谁发球谁「向上抖」→ 球落下时合成正手挥拍发球 → 来球按站位合成正手 / 反手挥拍（两只手柄各挥各的，互不等待）。
 * 两边的时机都正好，回合打不完：每分回到第 2～6 拍时故意不挥。
 * 中途让 2P 的手柄停 1.4 秒（0.8 秒没数据算断开，再过 0.3 秒暂停）：应当自动暂停，数据恢复后按 A 继续。打 6 分。
 * 最后暂停、按 X 换回 1 人：手柄还连着、定过方向，应当直接到选对手。
 * 检查：换人数不刷新页面、手柄留着；两人都加入、都发过球、都回过球，比分正常推进，断开会暂停、能继续，页面没有报错。
 * 用法：pnpm smoke:versus [加入页截图] [对打截图]
 */
import { chromium } from 'playwright-core';
import { CHROME_ARGS } from './chromeArgs';

const BASE = process.env.BASE ?? 'https://localhost:5288';
const lobbyShot = process.argv[2] ?? 'smoke-versus-lobby.png';
const playShot = process.argv[3] ?? 'smoke-versus.png';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: CHROME_ARGS,
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
// 换人数时页面不能刷新：刷新的话这个标记就没了
await page.evaluate('window.__noReload = true');

// 两只模拟手柄 a（1P）、b（2P）。每只：零点偏差 + 噪声 + 绕竖直轴的转速。
// __sim[k].upright：0 平放 / 1 立着；swingAt / dir：在这个时刻（performance.now）开始一次挥拍
// （每 15ms 一档，角速度升到 20 rad/s 再回落；+1 逆时针 = 正手），挥完 0.15 秒后慢慢转回准备姿势；
// flickUntil：在这个时刻之前叠加一次向上的加速（正弦，峰值 2.6G）；mute：停止送数据（模拟断开）。
// 以字符串注入：tsx 会给具名函数包一层 __name，页面里没有这个函数
await page.evaluate(`(() => {
  const input = window.__match.input;
  const PROF = [2, 5, 9, 13, 17, 20, 18, 13, 8, 4, 1, 0];
  window.__sim = {};
  for (const [k, bias] of [['a', { x: 0.6, y: -0.5, z: 0.4 }], ['b', { x: -0.4, y: 0.3, z: -0.5 }]]) {
    const d = input.newDevice('sim-' + k, 'joycon', 'Joy-Con（模拟 ' + k + '）');
    const st = { upright: 0, swingAt: -1e9, dir: 1, flickUntil: 0, mute: false };
    window.__sim[k] = st;
    let tilt = 0;
    let yawAcc = 0;
    let lastT = performance.now();
    setInterval(() => {
      if (st.mute) return;
      const now = performance.now();
      const r = () => (Math.random() - 0.5) * 0.6;
      const samples = [2, 1, 0].map((j) => {
        const t = now - j * 5;
        let wy = 0;
        if (tilt < st.upright) { tilt = Math.min(st.upright, tilt + 5 / 300); wy = -300; }
        else if (tilt > st.upright) { tilt = Math.max(st.upright, tilt - 5 / 300); wy = 300; }
        const a = (tilt * Math.PI) / 2;
        const up = { x: Math.sin(a), z: Math.cos(a) };
        const dt = Math.min(0.05, Math.max(0.0005, (t - lastT) / 1000));
        lastT = t;
        const since = t - st.swingAt;
        let yr = 0;
        if (since >= 0 && since < PROF.length * 15) yr = (st.dir * PROF[Math.floor(since / 15)] * 180) / Math.PI;
        else if (since >= PROF.length * 15 + 150 && Math.abs(yawAcc) > 0.2)
          yr = -Math.sign(yawAcc) * Math.min(172, Math.abs(yawAcc) / dt);
        yawAcc += yr * dt;
        const left = st.flickUntil - t;
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
  }
})()`);

type Side = 'near' | 'far';
interface SideSt {
  canToss: boolean;
  serveAt: number | null;
  awaiting: boolean;
  planT: number | null;
  stance: string;
  hits: number;
  serves: number;
}
interface St {
  step: string;
  paused: boolean;
  phase: string;
  slots: Record<Side, string | null>;
  score: Record<Side, number>;
  rallyHits: number;
  result: string | null;
  sides: Record<Side, SideSt>;
}
const KEY: Record<Side, 'a' | 'b'> = { near: 'a', far: 'b' };
const state = () => page.evaluate('window.__versus.debugState()') as Promise<St>;
const simT = () => page.evaluate('window.__versus.sim.t') as Promise<number>;
/** 手柄 k 按一下（按下、松开）逻辑按键 b，走真实的输入路径 */
const press = (k: 'a' | 'b', b: string) =>
  page.evaluate(`(() => {
    const input = window.__match.input;
    const d = input.devices.get('sim-${k}');
    input.onButton(d, '${b}', true);
    input.onButton(d, '${b}', false);
  })()`);
const matchStep = () => page.evaluate('window.__match.debugState().step') as Promise<string>;

// 和电脑对打：a 平放指向电视校准 → 选对手 → 按 X 换成 2 人
await sleep(600);
await page.evaluate(
  `window.__match.input.requestCalibration(window.__match.input.devices.get('sim-a'))`
);
await sleep(300);
const chooseStep = await matchStep();
await press('a', 'players');
await sleep(400);
let s = await state();
const switchOk =
  chooseStep === 'choose' &&
  s.step === 'lobby' &&
  s.slots.near === 'sim-a' &&
  (await page.evaluate('window.__noReload === true')) &&
  page.url().includes('mode=versus');
console.log(
  `1 人 → 2 人：${switchOk ? '没刷新页面，手柄 a 直接当 1P' : `不对（换之前 ${chooseStep}，换之后 ${s.step}，1P = ${s.slots.near}）`}`
);
// b 平放指向电视按 A 加入 2P
await press('b', 'confirm');
await sleep(400);
s = await state();
console.log(`加入：1P = ${s.slots.near}，2P = ${s.slots.far}`);
const joinedOk = s.slots.near === 'sim-a' && s.slots.far === 'sim-b';
await page.screenshot({ path: lobbyShot });
await page.evaluate('window.__sim.a.upright = 1; window.__sim.b.upright = 1');
await sleep(700);
await press('b', 'confirm');
await sleep(300);
s = await state();
console.log(`开始后：${s.step}`);

const lastFlick: Record<Side, number> = { near: 0, far: 0 };
const servedFor: Record<Side, number | null> = { near: null, far: null };
const swungFor: Record<Side, number | null> = { near: null, far: null };
let muted = false;
let pausedOnMute = false;
let resumed = false;
let shotTaken = false;
/** 这一分打到第几拍时不挥（2～6） */
let missAt = 2;
let missFor = '';
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  s = await state();
  if (s.step !== 'play' || s.result || s.score.near + s.score.far >= 6) break;
  // 打到第 2 分后：2P 的手柄停 1.4 秒 → 应当自动暂停；恢复后 1P 按 A 继续
  if (!muted && s.score.near + s.score.far >= 2 && s.phase === 'play') {
    muted = true;
    await page.evaluate('window.__sim.b.mute = true');
    await sleep(1400);
    pausedOnMute = (await state()).paused;
    await page.evaluate('window.__sim.b.mute = false');
    await sleep(300);
    await press('a', 'confirm');
    await sleep(200);
    resumed = !(await state()).paused;
    console.log(
      `2P 断开 1.4 秒：${pausedOnMute ? '自动暂停了' : '没有暂停'}；恢复后按 A：${resumed ? '继续了' : '没继续'}`
    );
    continue;
  }
  if (!shotTaken && s.phase === 'play' && s.sides.near.hits + s.sides.far.hits >= 3) {
    shotTaken = true;
    await page.screenshot({ path: playShot });
  }
  const point = `${s.score.near}:${s.score.far}`;
  if (missFor !== point) {
    missFor = point;
    missAt = 2 + Math.floor(Math.random() * 5);
  }
  const t = await simT();
  for (const side of ['near', 'far'] as const) {
    const x = s.sides[side];
    const k = KEY[side];
    if (x.canToss && Date.now() - lastFlick[side] > 1500) {
      lastFlick[side] = Date.now();
      await page.evaluate(`window.__sim.${k}.flickUntil = performance.now() + 140`);
      continue;
    }
    // Joy-Con 快速确认到接触约 76ms；画面延迟补偿 50ms
    const due = (at: number) => (at - t) * 1000 + 50 - 76 - 50 <= 10;
    if (x.serveAt !== null && servedFor[side] !== x.serveAt && due(x.serveAt)) {
      servedFor[side] = x.serveAt;
      await page.evaluate(
        `window.__sim.${k}.dir = 1; window.__sim.${k}.swingAt = performance.now()`
      );
    } else if (x.awaiting && x.planT !== null && swungFor[side] !== x.planT && due(x.planT)) {
      swungFor[side] = x.planT;
      if (s.rallyHits >= missAt) continue;
      const dir = x.stance === 'fh' ? 1 : -1;
      await page.evaluate(
        `window.__sim.${k}.dir = ${dir}; window.__sim.${k}.swingAt = performance.now()`
      );
    }
  }
  await sleep(4);
}
if (!shotTaken) await page.screenshot({ path: playShot });
const n = s.sides.near;
const f = s.sides.far;
console.log(
  `比分 1P ${s.score.near} : ${s.score.far} 2P；1P 发球 ${n.serves} 回球 ${n.hits}，2P 发球 ${f.serves} 回球 ${f.hits}`
);
const playOk =
  s.score.near + s.score.far >= 5 && n.serves > 0 && f.serves > 0 && n.hits > 0 && f.hits > 0;
// 暂停，按 X 换回 1 人：手柄 a 还连着、定过方向 → 直接选对手
await page.keyboard.press('Escape');
await sleep(200);
await press('a', 'players');
await sleep(400);
const backStep = await matchStep();
const backOk =
  backStep === 'choose' &&
  (await page.evaluate('window.__noReload === true')) &&
  page.url().includes('mode=match');
console.log(`2 人 → 1 人：${backOk ? '没刷新页面，直接到选对手' : `不对（到了 ${backStep}）`}`);
const ok = switchOk && joinedOk && playOk && pausedOnMute && resumed && backOk;
console.log(
  `双人对打：${ok ? '正常' : '不正常'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || !ok ? 1 : 0);
