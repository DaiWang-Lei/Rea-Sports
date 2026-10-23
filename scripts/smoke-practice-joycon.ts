/**
 * Joy-Con → 发球机练习 端到端冒烟测试（需要先 pnpm dev；不需要真手柄）：
 * 在页面里插一个模拟 Joy-Con（?debug=1 暴露的实例），每 15ms 送 3 个样本（和真手柄一样），陀螺带一点零点偏差。
 * 流程：平放 → 学到零点 → 立起来摆准备姿势（肩键一端朝上、按键面朝电视）按 A → 在理想击球时刻附近
 * 合成正手挥拍（绕竖直轴逆时针转）。
 * 检查：平放这一步能走完、学到的零点接近设定的偏差、校准后画面里拍头朝上红面朝前、能正常回球、页面没有报错。
 * 用法：pnpm smoke:practice-joycon [截图路径]（平放那一步另存一张 *-still.png）
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'https://localhost:5288';
const shot = process.argv[2] ?? 'smoke-practice-joycon.png';
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
await page.goto(`${BASE}/?mode=practice&debug=1`);
await sleep(800);

// 模拟手柄：陀螺 = 零点偏差 + 噪声 + 绕竖直轴的转速（window.__yawDps，°/s）。
// 姿态：window.__upright = 0 平放（按键面朝上）/ 1 立着（肩键一端朝上），改了以后绕机体 Y 用 0.3 秒转过去。
// window.__home = true：按累计转过的角度慢慢转回准备姿势（172°/s，低于慢挥阈值），转完自动变回 false。
// 以字符串注入：tsx 会给具名函数包一层 __name，页面里没有这个函数
await page.evaluate(`(() => {
  const bias = ${JSON.stringify(BIAS)};
  const input = window.__practice.input;
  const d = input.newDevice('sim-joycon', 'joycon', 'Joy-Con (R)（模拟）');
  input.activeKey = 'sim-joycon';
  window.__yawDps = 0;
  window.__upright = 0;
  window.__home = false;
  let tilt = 0;
  let yawAcc = 0;
  setInterval(() => {
    const now = performance.now();
    const r = () => (Math.random() - 0.5) * 0.6;
    const samples = [2, 1, 0].map((k) => {
      // 每个样本 5ms，转 1.5°（300°/s）；竖直轴在机体系里是 (sin a, 0, cos a)
      let wy = 0;
      if (tilt < window.__upright) { tilt = Math.min(window.__upright, tilt + 5 / 300); wy = -300; }
      else if (tilt > window.__upright) { tilt = Math.max(window.__upright, tilt - 5 / 300); wy = 300; }
      const a = (tilt * Math.PI) / 2;
      const up = { x: Math.sin(a), z: Math.cos(a) };
      let yr = window.__yawDps;
      if (window.__home && yr === 0) {
        if (Math.abs(yawAcc) > 0.2) yr = -Math.sign(yawAcc) * Math.min(172, Math.abs(yawAcc) / 0.005);
        else window.__home = false;
      }
      yawAcc += yr * 0.005;
      return {
        t: now - k * 5,
        gyro: { x: bias.x + up.x * yr + r(), y: bias.y + wy + r(), z: bias.z + up.z * yr + r() },
        accel: { x: up.x + r() * 0.01, y: r() * 0.01, z: up.z + r() * 0.01 },
        clipped: false,
      };
    });
    input.onSamples(d, samples);
  }, 15);
})()`);

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
const press = (b: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __practice: { onButton(n: string): void } }).__practice.onButton(
        name
      ),
    b
  );

for (let i = 0; i < 30 && (await state()).step === 'connect'; i++) await sleep(100);
console.log(`连接后步骤：${(await state()).step}`);
const t0 = Date.now();
await sleep(1200);
await page.screenshot({ path: shot.replace(/(\.png)?$/, '-still.png') });
for (let i = 0; i < 60 && (await state()).step === 'still'; i++) await sleep(100);
console.log(
  `平放后步骤：${(await state()).step}（用了 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
);
const bias = await page.evaluate(() => {
  const app = (
    window as unknown as { __practice: { input: { active: { motion: { gyroBias: unknown } } } } }
  ).__practice;
  return app.input.active.motion.gyroBias as { x: number; y: number; z: number };
});
console.log(
  `学到的零点：(${bias.x.toFixed(2)}, ${bias.y.toFixed(2)}, ${bias.z.toFixed(2)})，设定 (${BIAS.x}, ${BIAS.y}, ${BIAS.z})`
);
// 立起来：肩键一端朝上、按键面朝（模拟的）电视，按 A
await page.evaluate('window.__upright = 1');
await sleep(700);
await press('confirm');
await sleep(200);
console.log(`校准后步骤：${(await state()).step}`);
type Pose = {
  face: { x: number; y: number; z: number };
  blade: { x: number; y: number; z: number };
};
const pose = (await page.evaluate(
  '(() => { const p = window.__practice.input.active.paddle; return { face: p.faceNormal(), blade: p.bladeUp() }; })()'
)) as Pose;
const poseOk = pose.face.y > 0.95 && pose.blade.z > 0.95;
const yaw0 = (await page.evaluate('window.__practice.input.active.paddle.yaw')) as number;
console.log(
  `校准后画面里：红面 (${pose.face.x.toFixed(2)}, ${pose.face.y.toFixed(2)}, ${pose.face.z.toFixed(2)})，` +
    `拍头 (${pose.blade.x.toFixed(2)}, ${pose.blade.y.toFixed(2)}, ${pose.blade.z.toFixed(2)})：${poseOk ? '对' : '不对'}`
);

/** 合成一次正手：每 15ms 一档，角速度升到 20 rad/s 再回落；dir = +1 逆时针 */
async function forehand() {
  const prof = [2, 5, 9, 13, 17, 20, 18, 13, 8, 4, 1, 0];
  for (const w of prof) {
    await page.evaluate(
      (dps) => {
        (window as unknown as { __yawDps: number }).__yawDps = dps;
      },
      (w * 180) / Math.PI
    );
    await sleep(15);
  }
  await sleep(150);
  // 收拍：慢慢转回准备姿势（真人每球都会回到准备姿势；不回去的话自动校正会把它当成方向偏了）
  await page.evaluate('window.__yawDps = 0; window.__home = true');
  for (let i = 0; i < 100 && (await page.evaluate('window.__home')); i++) await sleep(20);
}

let swung = -1;
const tPlay = Date.now();
while (Date.now() - tPlay < 40000) {
  const s = await state();
  const done = Object.values(s.results).reduce((a, b) => a + b, 0);
  if (done >= 5) break;
  if (s.awaiting && s.planT !== null && swung !== s.feeds) {
    // Joy-Con 快速确认到接触约 76ms；越过 11 rad/s 大约在第 4 档（约 50ms）；画面延迟补偿 50ms
    const lead = (s.planT - s.t) * 1000 + 50 - 76 - 50;
    if (lead <= 10) {
      swung = s.feeds;
      await forehand();
    }
  }
  await sleep(5);
}
const s = await state();
await page.screenshot({ path: shot });
console.log(`送球 ${s.feeds}，结果：${JSON.stringify(s.results)}`);
const track = (await page.evaluate(
  '(() => { const p = window.__practice.input.active.paddle; return { yaw: p.yaw, drift: p.drift }; })()'
)) as { yaw: number; drift: number };
const dYaw = ((((track.yaw - yaw0) * 180) / Math.PI + 540) % 360) - 180;
const driftDps = (track.drift * 180) / Math.PI;
// 零点已经测准、每球回到准备姿势：偏航不该被拉动，也不该估出漂移
const trackOk = Math.abs(dYaw) < 5 && Math.abs(driftDps) < 0.1;
console.log(
  `自动校正：偏航变了 ${dYaw.toFixed(1)}°，漂移速度 ${driftDps.toFixed(2)}°/s：${trackOk ? '正常' : '不正常'}`
);
const biasOk =
  Math.abs(bias.x - BIAS.x) < 0.15 &&
  Math.abs(bias.y - BIAS.y) < 0.15 &&
  Math.abs(bias.z - BIAS.z) < 0.15;
console.log(
  `零点：${biasOk ? '正确' : '不对'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || !biasOk || !poseOk || !trackOk ? 1 : 0);
