import '@/styles/base.css';
import './app.css';
import { cpuLevel } from '@/config/difficulty';
import { preloadAvatars, ROSTER } from '@/render/avatar/roster';
import { AVATAR_THUMBS } from '@/render/avatar/thumbs';
import { MatchSim } from '@/sim/MatchSim';
import { loadAvatarChoice, saveAvatarChoice } from './avatarChoice';
import { GameView } from './GameView';
import { ChallengeApp } from './challenge/ChallengeApp';
import { PlayHost } from './PlayHost';
import { PracticeApp } from './practice/PracticeApp';
import { loadOverrides, overrideCount, resetOverrides } from './shared/tuningStore';
import { tuning } from '@/config/tuning';

// 调参面板改过的手感参数（存在本机）：所有模式都先套用
loadOverrides();

const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;

function num(name: string, def: number): number {
  const v = Number(params.get(name));
  return Number.isFinite(v) && params.has(name) ? v : def;
}

/** 电脑对电脑的自动演示：用来看物理、规则、AI 和画面，打完一局自动开下一局 */
function startAutoplay(): void {
  app.className = 'game-root';
  const a = num('a', 3);
  const b = num('b', 3);
  const points = num('points', 6) === 11 ? 11 : 6;
  let seed = num('seed', Math.floor(Math.random() * 1e9));
  const make = () => new MatchSim({ seed, points, cpu: { near: a, far: b }, tune: tuning });
  const view = new GameView(app, make(), {
    names: { near: `近端·${cpuLevel(a).name}`, far: `远端·${cpuLevel(b).name}` },
    alwaysShowScore: true,
  });
  if (params.has('debug')) {
    void import('@/debug/TuningPanel').then((m) =>
      m.createTuningPanel(() => view.sim.applyTuning())
    );
  }
  view.timeScale = num('speed', 1);
  // 调试用：开局先快进若干秒（截图/检查对打中的画面）
  const skip = num('skip', 0);
  for (let i = 0; i < skip * 240; i++) view.sim.tick();
  view.sim.drainEvents();
  const phaseText: Record<string, string> = {
    preServe: '准备发球',
    toss: '抛球',
    play: '对打中',
    pointOver: '得分',
    let: '重发',
    gameOver: '结束',
  };
  let lastCorner = 0;
  const updateCorner = (now: number) => {
    if (now - lastCorner < 250) return;
    lastCorner = now;
    const s = view.sim;
    view.hud.setCorner(
      `自动演示（电脑对电脑）· ${points} 分制 · 速度 ×${view.timeScale}<br/>` +
        `种子 ${seed} · 比赛时间 ${s.t.toFixed(1)} 秒 · ${phaseText[s.phase.kind]} · 本回合 ${s.rallyHits} 拍<br/>` +
        `点击画面开启声音`
    );
  };

  let restartAt = 0;
  let last = performance.now();
  const loop = () => {
    // 用 performance.now() 而不是 rAF 的时间戳：后者可能早于初始化时刻，导致 dt 为负
    const now = performance.now();
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    view.frame(dt);
    updateCorner(now);
    if (view.sim.phase.kind === 'gameOver') {
      if (!restartAt) restartAt = now + 4000;
      else if (now >= restartAt) {
        restartAt = 0;
        seed = (seed * 1103515245 + 12345) >>> 0;
        view.setSim(make());
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener('pointerdown', () => view.sfx.unlock());
  window.addEventListener('keydown', () => view.sfx.unlock());
}

/** 选人物：你、对手各一排，点一下就选中，存在本机 */
function avatarPicker(): string {
  const choice = loadAvatarChoice();
  const row = (side: 'near' | 'far', who: string) => `
    <div class="avatar-row" data-side="${side}">
      <span class="dim">${who}</span>
      <div class="avatar-cards">
        ${ROSTER.map(
          (e) => `
          <button class="avatar-card${choice[side] === e.id ? ' selected' : ''}" data-id="${e.id}">
            <img src="${AVATAR_THUMBS[e.id]}" alt="" />
            <span>${e.name}</span>
          </button>`
        ).join('')}
      </div>
    </div>`;
  return `<section class="avatar-pick"><h2>人物</h2>${row('near', '你')}${row('far', '对手')}</section>`;
}

function showMenu(): void {
  app.className = 'menu-root';
  app.innerHTML = `
    <div class="menu">
      <h1>体感乒乓</h1>
      <p class="dim">手感对标 Wii Sports Resort 乒乓球的净室重做 · 开发中</p>
      ${avatarPicker()}
      <div class="menu-items">
        <a class="menu-item" href="?mode=match">
          <strong>和电脑对打（手机 / Joy-Con / 键盘）</strong>
          <span>M3：5 个等级的电脑对手，6 分或 11 分一局。按 A 或向上抖手柄抛球发球</span>
        </a>
        <a class="menu-item" href="?mode=versus">
          <strong>双人对打（分屏，两个手柄）</strong>
          <span>左右分屏，各拿一只 Joy-Con 或手机。1P 用「你」的人物，2P 用「对手」的</span>
        </a>
        <a class="menu-item" href="?mode=challenge">
          <strong>连续回击（教练不停供球）</strong>
          <span>回一球 1 分、漏一球就结束；满 10 分后台上出现靶子，打中再加 3 分。最多 4 人轮流</span>
        </a>
        <a class="menu-item" href="?mode=practice">
          <strong>发球机练习（手机 / Joy-Con / 键盘）</strong>
          <span>M2：真正用挥拍回球。每一球告诉你早了还是晚了、正手还是反手、力度和旋转</span>
        </a>
        <a class="menu-item" href="?mode=match&debug=1">
          <strong>调手感（对打 + 调参面板）</strong>
          <span>M4：边打边改时机窗口、发球、球速、电脑各级等参数，改动存在本机，可以导出发给开发者</span>
        </a>
        <a class="menu-item" href="rhythm.html">
          <strong>视频打点（对照实机视频测节奏）</strong>
          <span>M4：在 WSR / Switch Sports Resort 的视频里给击球、落台、抛球打点，和我们的仿真比节奏</span>
        </a>
        <a class="menu-item" href="imu-debug.html">
          <strong>体感调试（手机 / Joy-Con）</strong>
          <span>M0：扫码连手机或配对 Joy-Con、看数据、跑检查清单、录挥拍样本</span>
        </a>
        <a class="menu-item" href="?mode=autoplay">
          <strong>观看电脑对打（自动演示）</strong>
          <span>M1：物理、规则、电脑 AI、画面与声音</span>
        </a>
        <a class="menu-item" href="?mode=autoplay&a=1&b=1">
          <strong>自动演示 · 入门 vs 入门</strong>
          <span>失误多、回合短</span>
        </a>
        <a class="menu-item" href="?mode=autoplay&a=5&b=5&points=11">
          <strong>自动演示 · 冠军 vs 冠军（11 分制）</strong>
          <span>节奏更快、回合更长</span>
        </a>
      </div>
      <p class="dim small">自动演示可加参数：a、b = 两边电脑等级 1–5，points = 6 或 11，speed = 慢放倍率（如 0.3）。</p>
      ${
        overrideCount()
          ? `<p class="small warn">正在用改过的手感参数（${overrideCount()} 项）<button data-act="reset-tuning">恢复默认</button></p>`
          : ''
      }
    </div>`;
  app.querySelector('[data-act="reset-tuning"]')?.addEventListener('click', () => {
    resetOverrides();
    showMenu();
  });
  app.querySelectorAll<HTMLElement>('.avatar-row').forEach((row) =>
    row.addEventListener('click', (ev) => {
      const card = (ev.target as HTMLElement).closest<HTMLElement>('.avatar-card');
      const id = ROSTER.find((e) => e.id === card?.dataset.id)?.id;
      if (!card || !id) return;
      const side = row.dataset.side === 'far' ? 'far' : 'near';
      saveAvatarChoice({ ...loadAvatarChoice(), [side]: id });
      row
        .querySelectorAll('.avatar-card')
        .forEach((c) => c.classList.toggle('selected', c === card));
    })
  );
}

const mode = params.get('mode');
// 进场前先把选的人物准备好（带骨骼的模型要下载）
if (['autoplay', 'match', 'practice', 'versus', 'challenge'].includes(mode ?? ''))
  await preloadAvatars(loadAvatarChoice());
if (mode === 'autoplay') startAutoplay();
else if (mode === 'match' || mode === 'versus') new PlayHost(app, mode);
else if (mode === 'practice') new PracticeApp(app);
else if (mode === 'challenge') new ChallengeApp(app);
else showMenu();
