/**
 * Joy-Con → 发球机练习 端到端冒烟测试（需要先 pnpm dev；不需要真手柄）：
 * 在页面里插一个模拟 Joy-Con（?debug=1 暴露的实例），每 15ms 送 3 个样本（和真手柄一样），陀螺带一点零点偏差。
 * 流程：平放 → 学到零点 → 回中（Y）→ 准备姿势（A）→ 在理想击球时刻附近合成正手挥拍（绕竖直轴逆时针转）。
 * 检查：平放这一步能走完、学到的零点接近设定的偏差、能正常回球、页面没有报错。
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

// 模拟手柄：平放（按键面朝上），陀螺 = 零点偏差 + 噪声 + 绕竖直轴的转速（°/s）。
// 以字符串注入：tsx 会给具名函数包一层 __name，页面里没有这个函数
await page.evaluate(`(() => {
  const bias = ${JSON.stringify(BIAS)};
  const input = window.__practice.input;
  const d = input.newDevice('sim-joycon', 'joycon', 'Joy-Con (R)（模拟）');
  input.activeKey = 'sim-joycon';
  window.__yawDps = 0;
  setInterval(() => {
    const now = performance.now();
    const r = () => (Math.random() - 0.5) * 0.6;
    const samples = [2, 1, 0].map((k) => ({
      t: now - k * 5,
      gyro: { x: bias.x + r(), y: bias.y + r(), z: bias.z + window.__yawDps + r() },
      accel: { x: r() * 0.01, y: r() * 0.01, z: 1 + r() * 0.01 },
      clipped: false,
    }));
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
await press('recenter');
await sleep(200);
console.log(`回中后步骤：${(await state()).step}`);
if ((await state()).step === 'ready') await press('confirm');
await sleep(200);
console.log(`校准后步骤：${(await state()).step}`);

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
  // 收拍：慢慢转回来
  for (const w of [2, 3, 3, 2, 1, 0]) {
    await page.evaluate(
      (dps) => {
        (window as unknown as { __yawDps: number }).__yawDps = dps;
      },
      (-w * 180) / Math.PI
    );
    await sleep(15);
  }
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
const biasOk =
  Math.abs(bias.x - BIAS.x) < 0.15 &&
  Math.abs(bias.y - BIAS.y) < 0.15 &&
  Math.abs(bias.z - BIAS.z) < 0.15;
console.log(
  `零点：${biasOk ? '正确' : '不对'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || !biasOk ? 1 : 0);
