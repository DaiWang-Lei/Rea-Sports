/**
 * 远程对打冒烟测试（需要先 pnpm dev，且能访问外网的公共 MQTT 服务器）：两个独立的浏览器上下文，
 * 一个开房间（直接用网址进远程对打），另一个像真的收到链接那样：打开链接 → 开机画面 → 谁来玩（键盘加入）→ 选人物
 * → 直接进房间。两边都用键盘；每条消息人为晚 40ms（?lag=40）。
 * 脚本当两边的人：轮到发球就抛球发球，来球在理想时刻按键，每一分打到第 2～6 拍时故意不接；
 * 检查两边记的比分一直一样、能打完好几分、页面没有报错。
 * 用法：pnpm smoke:online [BASE 网址] [截图前缀]
 */
import { chromium, type Page } from 'playwright-core';
import { CHROME_ARGS } from './chromeArgs';

const BASE = (process.argv[2] ?? process.env.BASE ?? 'https://localhost:5288').replace(/\/$/, '');
const shot = process.argv[3] ?? 'smoke-online';
const LAG = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: CHROME_ARGS,
});
const errors: string[] = [];
async function open(tag: string, url: string, shell = false): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 960, height: 540 });
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e}`));
  page.on('console', (m) => {
    // 公共握手服务器偶尔断一下会自动重连，不算页面的错
    if (m.type() === 'error' && !m.text().includes('WebSocket'))
      errors.push(`[${tag}] ${m.text()}`);
  });
  await page.addInitScript(() =>
    localStorage.setItem('rea-howto', JSON.stringify(['match', 'versus', 'challenge', 'practice']))
  );
  await page.goto(url);
  if (!shell) {
    await sleep(1200);
    await page.getByRole('button', { name: '用键盘试一试' }).click();
    return page;
  }
  // 电视界面：开机 → 谁来玩（键盘加入）→ 开始 → 选人物 → 直接进房间
  const key = async (k: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(k);
      await sleep(90);
    }
  };
  await sleep(2500);
  await key('Enter');
  await sleep(500);
  await page.click('[data-act="keyboard"]');
  await sleep(300);
  await key('ArrowLeft', 4);
  await key('Enter');
  await sleep(500);
  await key('Enter');
  await sleep(2000);
  return page;
}

type St = {
  step: string;
  t: number;
  phase: string;
  canToss: boolean;
  serveAt: number | null;
  awaiting: boolean;
  planT: number | null;
  stance: string;
  score: { near: number; far: number };
  rallyHits?: number;
};
const state = (p: Page) => p.evaluate('window.__match.debugState()') as Promise<St>;
const rally = (p: Page) => p.evaluate('window.__match.sim.rallyHits') as Promise<number>;

const host = await open('开房间', `${BASE}/?mode=online&debug=1&lag=${LAG}`);
const link = (await host.evaluate('window.__match.online.link')) as string;
const room = new URL(link).searchParams.get('room');
const guest = await open('加入', `${BASE}/?room=${room}&debug=1&lag=${LAG}`, true);

// 等两边连上、对方准备好了
let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  ready = (await host.evaluate(
    "window.__match.online.status === 'connected' && window.__match.peerReady"
  )) as boolean;
  await sleep(250);
}
const rtt = (await host.evaluate('window.__match.online.rtt')) as number;
console.log(
  `房间 ${room}：${ready ? `连上了，往返 ${rtt.toFixed(0)}ms（含模拟的 ${2 * LAG}ms）` : '没连上'}`
);
await host.screenshot({ path: `${shot}-lobby.png` });
if (ready) await host.locator('[data-act="start"]').click();
await sleep(500);

/** 一边的「人」：抛球、发球、回球；每一分打到 missAt 拍时不接 */
async function bot(page: Page, stopAt: number, tag: string) {
  let servedFor: number | null = null;
  let swungFor: number | null = null;
  let missAt = 3;
  let missFor = '';
  while (Date.now() < stopAt) {
    const s = await state(page);
    if (s.step === 'over') return;
    if (s.step !== 'play') {
      await sleep(30);
      continue;
    }
    const point = `${s.score.near}:${s.score.far}`;
    if (point !== missFor) {
      missFor = point;
      missAt = 2 + Math.floor(Math.random() * 5);
    }
    if (s.canToss) {
      await page.keyboard.press(' ');
      await sleep(30);
      continue;
    }
    if (s.serveAt !== null && servedFor !== s.serveAt && s.t >= s.serveAt + 0.03) {
      servedFor = s.serveAt;
      await page.keyboard.press('f');
      continue;
    }
    if (s.awaiting && s.planT !== null && swungFor !== s.planT && s.t >= s.planT + 0.03) {
      swungFor = s.planT;
      if ((await rally(page)) >= missAt) continue;
      await page.keyboard.down('w');
      await page.keyboard.press(s.stance === 'fh' ? 'f' : 'j');
      await page.keyboard.up('w');
      continue;
    }
    await sleep(4);
  }
  void tag;
}

const stopAt = Date.now() + 120000;
await Promise.all([bot(host, stopAt, '开房间'), bot(guest, stopAt, '加入')]);
await sleep(800);
const h = await state(host);
const g = await state(guest);
await host.screenshot({ path: `${shot}-host.png` });
await guest.screenshot({ path: `${shot}-guest.png` });
const same = h.score.near === g.score.far && h.score.far === g.score.near;
const played = h.score.near + h.score.far;
console.log(
  `开房间的一方：你 ${h.score.near} : ${h.score.far} 对方（${h.step}）；加入的一方：你 ${g.score.near} : ${g.score.far} 对方（${g.step}）`
);
console.log(`两边比分${same ? '一致' : '不一致'}，打了 ${played} 分`);

// 加入的一方关掉页面：开房间的一方看到「对方断开了」；再打开链接：回到等待页、重新连上
await guest.close({ runBeforeUnload: true });
await guest.context().close();
let dropped = false;
for (let i = 0; i < 20 && !dropped; i++) {
  await sleep(500);
  dropped = ((await host.locator('.tv-panel h2').textContent()) ?? '').includes('断开');
}
const again = await open('再加入', `${BASE}/?room=${room}&debug=1&lag=${LAG}`, true);
let back = false;
for (let i = 0; i < 80 && !back; i++) {
  await sleep(250);
  back = (await host.evaluate(
    "window.__match.debugState().step === 'choose' && window.__match.online.status === 'connected' && window.__match.peerReady"
  )) as boolean;
}
console.log(
  `对方关掉页面：${dropped ? '提示断开了' : '没提示'}；再打开链接：${back ? '回到等待页、重新连上' : '没连回来'}`
);

// 换玩法：远程连续回击，两边同时各打各的（开房间的一方打到 5 分、加入的一方打到 3 分就不接了），比分数
let chOk = false;
if (back) {
  // 和摇杆左右一样发「◀▶」（右边的调参面板会挡住鼠标）
  await host.evaluate(
    "document.querySelector('[data-spin=\"game\"]').dispatchEvent(new CustomEvent('tv-spin', { detail: 1, bubbles: true }))"
  );
  await sleep(200);
  await host.locator('[data-act="start"]').click();
  await sleep(800);
  type Ch = {
    step: string;
    t: number;
    score: number;
    awaiting: boolean;
    planT: number | null;
    stance: string;
  };
  const chState = (p: Page) => p.evaluate('window.__challenge.debugState()') as Promise<Ch>;
  async function chBot(page: Page, stopScore: number) {
    let swungFor: number | null = null;
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const s = await chState(page);
      if (s.step === 'done') return;
      if (
        s.score < stopScore &&
        s.awaiting &&
        s.planT !== null &&
        swungFor !== s.planT &&
        s.t >= s.planT + 0.03
      ) {
        swungFor = s.planT;
        await page.keyboard.down('w');
        await page.keyboard.press(s.stance === 'fh' ? 'f' : 'j');
        await page.keyboard.up('w');
        continue;
      }
      await sleep(4);
    }
  }
  await Promise.all([chBot(host, 5), chBot(again, 3)]);
  await sleep(1500);
  const mine = (p: Page) =>
    p.evaluate(
      '({ me: window.__challenge.scores[0], peer: window.__challenge.peer.score, over: window.__challenge.peer.over })'
    ) as Promise<{ me: number; peer: number; over: boolean }>;
  const hc = await mine(host);
  const gc = await mine(again);
  await host.screenshot({ path: `${shot}-challenge.png` });
  chOk = hc.me === gc.peer && gc.me === hc.peer && hc.over && gc.over && hc.me >= 5 && gc.me >= 3;
  console.log(
    `远程连续回击：开房间的一方 你 ${hc.me} : ${hc.peer} 对方；加入的一方 你 ${gc.me} : ${gc.peer} 对方 → ${chOk ? '两边一致' : '不对'}`
  );
} else console.log('没连回来，跳过远程连续回击');
await again.context().close();
const ok = ready && same && played >= 4 && dropped && back && chOk;
console.log(
  `远程对打：${ok ? '正常' : '不正常'}；页面报错：${errors.length ? errors.join('\n') : '无'}`
);
await browser.close();
process.exit(errors.length || !ok ? 1 : 0);
