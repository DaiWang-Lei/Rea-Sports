/**
 * 电视界面冒烟测试（需要先 pnpm dev）：开机 → 谁来玩（键盘加入，?debug=1 才有）→ 选人物 → 主菜单，
 * 再从主菜单依次进比赛、连续回击、练习，每个都从「回到菜单」回来。全程用键盘方向键、回车操作（等同摇杆、A）。
 * 检查：每一屏的标题对、玩法打开后有自己的面板、回到菜单后又是主菜单、选的人物存下来了、页面没有报错。
 * 用法：pnpm smoke:tv [截图目录]
 */
import { chromium } from 'playwright-core';
import { CHROME_ARGS } from './chromeArgs';

const BASE = process.env.BASE ?? 'https://localhost:5288';
const dir = process.argv[2] ?? '.';
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
const fails: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) fails.push(what);
};
const title = () =>
  page.evaluate(
    `document.querySelector('.tv-screen .tv-title, .tv-screen .tv-logo')?.textContent ?? ''`
  ) as Promise<string>;
const key = async (k: string, n = 1) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(k);
    await sleep(90);
  }
};

await page.goto(`${BASE}/?debug=1`);
await page.evaluate(`localStorage.removeItem('rea-avatars')`);
await sleep(2500);
check((await title()) === '体感乒乓', '开机画面');
await key('Enter');
await sleep(500);
check((await title()) === '谁来玩？', '谁来玩');
await page.click('[data-act="keyboard"]');
await sleep(300);
check((await page.locator('.tv-slot.p1.joined').count()) === 1, '键盘加入 1P');
await key('ArrowLeft', 4);
await key('Enter');
await sleep(500);
check((await title()) === '选人物', '选人物');
await key('ArrowRight', 2);
await key('Enter');
await sleep(1500);
check((await title()) === '玩什么？', '选定人物后到主菜单');
const saved = (await page.evaluate(
  `JSON.parse(localStorage.getItem('rea-avatars') || '{}').near`
)) as string;
check(saved === 'skater-boy', `人物存下来了（${saved}）`);
await page.screenshot({ path: `${dir}/smoke-tv-menu.png` });

/** 从主菜单进一个玩法（第 i 张卡），看到它自己的面板，再回到菜单 */
async function visit(i: number, name: string, panel: string, howtoCard = true) {
  await key('ArrowLeft', 3);
  await key('ArrowRight', i);
  await key('Enter');
  await sleep(2500);
  // 第一次进来先是「怎么玩」：A 知道了
  const howto = await page.locator('.tv-howto').isVisible();
  if (howtoCard) check(howto, `${name}：先看「怎么玩」`);
  if (howto) {
    await page.screenshot({ path: `${dir}/smoke-tv-howto-${i}.png` });
    await key('Enter');
    await sleep(400);
  }
  const seen = await page.locator(panel).first().isVisible();
  check(seen, `${name}：打开了`);
  await page.screenshot({ path: `${dir}/smoke-tv-mode-${i}.png` });
  await page.locator('[data-act="home"]').first().click();
  await sleep(1200);
  check((await title()) === '玩什么？', `${name}：回到菜单`);
}
await visit(0, '比赛（和电脑）', '.tv-vs');
await visit(1, '连续回击', '[data-spin="players"]');
await visit(2, '练习', '[data-spin="level"]');
// 远程对打：等待页上有房间链接（这里只看能进去、能回来，联机本身见 smoke:online）
await visit(3, '远程对打', '.tv-qr canvas', false);

console.log(
  `电视界面：${fails.length ? '不正常' : '正常'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || fails.length ? 1 : 0);
