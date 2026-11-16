/**
 * M4 工具的冒烟测试（需要先 pnpm dev）：
 *  - 调参面板：对打页 ?debug=1 改一个参数（按键抛高），检查仿真立即用上、存进本机、刷新后还在、首页提示「改过」、恢复默认；
 *  - 视频打点：在页面里用 canvas + MediaRecorder 录一段 3 秒的测试视频，载入后逐帧打点，检查节奏指标，
 *    再跑 10 局电脑对电脑，检查对比表。
 * 用法：pnpm smoke:tools [截图目录]
 */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'https://localhost:5288';
const outDir = process.argv[2] ?? '.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: true,
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const fails: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) fails.push(what);
};

// ---------------------------------------------------------------- 调参面板
await page.goto(`${BASE}/?mode=match&debug=1`);
await page.evaluate('localStorage.removeItem("rea-tuning")');
await page.reload();
await page.waitForSelector('.lil-gui');
await page.getByRole('button', { name: '用键盘试一试' }).click();
const row = page.locator('.lil-gui .lil-controller', { hasText: '按键抛高' });
const input = row.locator('input').first();
await input.fill('1.05');
await input.press('Enter');
await sleep(200);
const live = await page.evaluate('window.__match.sim.tune.serve.buttonTossHeight');
check(live === 1.05, `面板改「按键抛高」后仿真立即用上（${live}）`);
const saved = await page.evaluate('JSON.parse(localStorage.getItem("rea-tuning") || "null")');
check(
  (saved as { tuning?: { serve?: { buttonTossHeight?: number } } })?.tuning?.serve
    ?.buttonTossHeight === 1.05,
  `存进本机：${JSON.stringify(saved)}`
);
check(
  (await page.locator('.lil-gui .lil-title').first().innerText()).includes('改了 1 项'),
  '面板标题显示改了 1 项'
);
await page.screenshot({ path: `${outDir}/tools-panel.png` });
await page.reload();
await page.waitForSelector('.lil-gui');
check(
  (await page.evaluate('window.__match.sim.tune.serve.buttonTossHeight')) === 1.05,
  '刷新后仍然生效'
);
await page.goto(`${BASE}/`);
const note = page.locator('[data-act="reset-tuning"]');
check((await note.count()) === 1, '首页提示正在用改过的参数');
await note.click();
check(
  (await page.evaluate('localStorage.getItem("rea-tuning")')) === null &&
    (await page.locator('[data-act="reset-tuning"]').count()) === 0,
  '首页「恢复默认」清掉了改动'
);

// ---------------------------------------------------------------- 视频打点
await page.goto(`${BASE}/rhythm.html`);
// 录一段 3 秒、30 帧/秒的测试视频（画面上有帧号）
const b64 = (await page.evaluate(`(async () => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const g = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start();
  const t0 = performance.now();
  await new Promise((done) => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = '#123'; g.fillRect(0, 0, 320, 180);
      g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(t.toFixed(2), 100, 100);
      if (t < 3.2) requestAnimationFrame(draw); else done();
    };
    draw();
  });
  rec.stop();
  await new Promise((r) => (rec.onstop = r));
  const buf = await new Blob(chunks).arrayBuffer();
  let s = ''; const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
})()`)) as string;
await page.evaluate('localStorage.clear()');
await page.selectOption('#fps', '30');
await page.setInputFiles('#file', {
  name: 'smoke.webm',
  mimeType: 'video/webm',
  buffer: Buffer.from(b64, 'base64'),
});
await page.waitForFunction('document.getElementById("video").readyState >= 1');
await page.locator('body').click({ position: { x: 5, y: 5 } });
// 每 10 帧（1/3 秒）打一个点：抛球、发球、落本方、落对方、回球、落台、回球、回合结束
for (const key of ['t', 's', 'b', 'b', 'h', 'b', 'h', 'e']) {
  await page.keyboard.press(key);
  await page.keyboard.press('Shift+ArrowRight');
  await page.waitForFunction('!document.getElementById("video").seeking');
}
const marks = await page.locator('#marks li').count();
check(marks === 8, `打了 8 个点（${marks}）`);
const cell = async (row: string, col: number) =>
  (await page.locator('#table tr', { hasText: row }).locator('td').nth(col).innerText()).trim();
check(
  (await cell('抛球 → 发球击球', 1)) === '333ms',
  `抛球 → 发球 333ms（${await cell('抛球 → 发球击球', 1)}）`
);
check(
  (await cell('两次击球的间隔', 1)) === '833ms',
  `击球间隔中位 833ms（${await cell('两次击球的间隔', 1)}）`
);
check(
  (await cell('发球 → 落到对方台', 2)) === '20',
  `发球 → 落对方台 20 帧（${await cell('发球 → 落到对方台', 2)}）`
);
await page.locator('#run').click();
await page.waitForFunction('!document.getElementById("run").disabled', null, { timeout: 120000 });
const simCell = await cell('两次击球的间隔', 4);
check(
  /^\d+ms$/.test(simCell),
  `仿真对比出来了：击球间隔 ${simCell}，差 ${await cell('两次击球的间隔', 6)}`
);
await page.reload();
check((await page.locator('#marks li').count()) === 0, '换页后没载入视频时不显示点');
await page.setInputFiles('#file', {
  name: 'smoke.webm',
  mimeType: 'video/webm',
  buffer: Buffer.from(b64, 'base64'),
});
await sleep(300);
check((await page.locator('#marks li').count()) === 8, '同一个视频再载入，点还在');
await page.screenshot({ path: `${outDir}/tools-rhythm.png`, fullPage: true });

console.log(`页面报错：${errors.length ? errors.join('\n') : '无'}`);
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
