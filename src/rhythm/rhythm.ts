/**
 * 视频打点（计划 M4）：载入 WSR / Switch Sports Resort 的乒乓实机视频，逐帧在击球、落台、抛球等时刻按键打点，
 * 算出击球间隔、球的飞行时间、抛球滞空等节奏指标，和我们的仿真（电脑对电脑，用当前的手感参数）并排对比。
 * 打的点按视频（文件名 + 大小）记在本机，可以导出 / 导入 JSON。
 */
import '@/styles/base.css';
import './rhythm.css';
import { CPU_LEVELS } from '@/config/difficulty';
import { tuning } from '@/config/tuning';
import { type MatchEvent, MatchSim } from '@/sim/MatchSim';
import { loadOverrides } from '@/app/shared/tuningStore';
import {
  fromMatchEvents,
  METRICS,
  type MetricKey,
  type RhythmEvent,
  type RhythmKind,
  rhythmSamples,
  summarize,
} from './metrics';

loadOverrides();

const KEYS: Array<{ key: string; kind: RhythmKind; name: string }> = [
  { key: 'h', kind: 'hit', name: '击球' },
  { key: 'b', kind: 'bounce', name: '落台' },
  { key: 't', kind: 'toss', name: '抛球离手' },
  { key: 's', kind: 'serve', name: '发球击球' },
  { key: 'x', kind: 'smash', name: '扣杀击球' },
  { key: 'e', kind: 'end', name: '回合结束' },
];
const NAME: Record<RhythmKind, string> = Object.fromEntries(
  KEYS.map((k) => [k.kind, k.name])
) as Record<RhythmKind, string>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const fpsSel = $<HTMLSelectElement>('fps');

let marks: RhythmEvent[] = [];
let videoKey: string | null = null;
let simSamples: Record<MetricKey, number[]> | null = null;
let simLabel = '';

const fps = () => Number(fpsSel.value);
const frameOf = (t: number) => Math.round(t * fps());
const fmtTime = (t: number) => `${t.toFixed(3)}s · 第 ${frameOf(t)} 帧`;

// ---------------------------------------------------------------- 视频

function loadVideo(f: File): void {
  video.src = URL.createObjectURL(f);
  videoKey = `${f.name}|${f.size}`;
  $('drop-hint').hidden = true;
  try {
    const saved = JSON.parse(localStorage.getItem(`rea-rhythm:${videoKey}`) ?? 'null') as {
      marks?: RhythmEvent[];
    } | null;
    marks = saved?.marks ?? [];
  } catch {
    marks = [];
  }
  render();
}

function save(): void {
  if (!videoKey) return;
  try {
    localStorage.setItem(`rea-rhythm:${videoKey}`, JSON.stringify({ marks }));
  } catch {
    // 隐私模式等：不保存
  }
}

$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadVideo(f);
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (f) loadVideo(f);
});

function togglePlay(): void {
  if (!video.src) return;
  if (video.paused) void video.play();
  else video.pause();
}

/** 停下来时对齐到帧，打的点就是那一帧 */
function step(frames: number): void {
  if (!video.src) return;
  video.pause();
  video.currentTime = Math.max(0, (frameOf(video.currentTime) + frames) / fps());
}

$('play').addEventListener('click', togglePlay);
$<HTMLSelectElement>('rate').addEventListener('change', (e) => {
  video.playbackRate = Number((e.target as HTMLSelectElement).value);
});
fpsSel.addEventListener('change', render);
video.addEventListener('timeupdate', () => ($('time').textContent = fmtTime(video.currentTime)));
video.addEventListener('seeked', () => ($('time').textContent = fmtTime(video.currentTime)));

// ---------------------------------------------------------------- 打点

function mark(kind: RhythmKind): void {
  if (!video.src) return;
  const t = video.paused ? frameOf(video.currentTime) / fps() : video.currentTime;
  marks.push({ t, kind });
  marks.sort((a, b) => a.t - b.t);
  save();
  render();
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'SELECT' || tag === 'INPUT') (e.target as HTMLElement).blur();
  const k = e.key.toLowerCase();
  if (k === ' ') {
    e.preventDefault();
    togglePlay();
  } else if (k === 'arrowleft' || k === 'arrowright') {
    e.preventDefault();
    step((k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
  } else if (k === 'backspace' || k === 'z') {
    e.preventDefault();
    // 删掉离当前画面最近的一个点
    if (!marks.length) return;
    let best = 0;
    marks.forEach((m, i) => {
      if (Math.abs(m.t - video.currentTime) < Math.abs(marks[best].t - video.currentTime)) best = i;
    });
    marks.splice(best, 1);
    save();
    render();
  } else {
    const hit = KEYS.find((x) => x.key === k);
    if (hit && !e.metaKey && !e.ctrlKey) mark(hit.kind);
  }
});

$('keys').innerHTML = [
  '<span><kbd>空格</kbd>播放 / 暂停</span>',
  '<span><kbd>←</kbd><kbd>→</kbd>一帧（按住 Shift 十帧）</span>',
  ...KEYS.map((k) => `<span><kbd>${k.key.toUpperCase()}</kbd>${k.name}</span>`),
  '<span><kbd>⌫</kbd>删掉最近的点</span>',
].join('');

// ---------------------------------------------------------------- 导出 / 导入

$('export').addEventListener('click', () => {
  const a = document.createElement('a');
  const data = { video: videoKey, fps: fps(), marks };
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  );
  a.download = `rhythm-${(videoKey ?? 'marks').split('|')[0]}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});
$<HTMLInputElement>('import').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  void f.text().then((txt) => {
    try {
      const d = JSON.parse(txt) as { fps?: number; marks?: RhythmEvent[] };
      marks = (d.marks ?? []).filter((m) => Number.isFinite(m.t) && m.kind in NAME);
      if (d.fps === 30 || d.fps === 60) fpsSel.value = String(d.fps);
      save();
      render();
    } catch {
      alert('读不了这个文件：不是导出的打点 JSON');
    }
    input.value = '';
  });
});
$('clear').addEventListener('click', () => {
  if (!marks.length || !confirm(`清空这个视频的 ${marks.length} 个点？`)) return;
  marks = [];
  save();
  render();
});

// ---------------------------------------------------------------- 和仿真对比

const levelSel = $<HTMLSelectElement>('level');
levelSel.innerHTML = CPU_LEVELS.map(
  (l, i) => `<option value="${i + 1}" ${i === 2 ? 'selected' : ''}>${l.name} vs ${l.name}</option>`
).join('');

$('run').addEventListener('click', () => void runSim());

async function runSim(): Promise<void> {
  const btn = $<HTMLButtonElement>('run');
  btn.disabled = true;
  const level = Number(levelSel.value);
  const points = $<HTMLSelectElement>('points').value === '11' ? 11 : 6;
  const all: RhythmEvent[] = [];
  for (let g = 0; g < 10; g++) {
    btn.textContent = `跑第 ${g + 1} / 10 局…`;
    // 让出主线程，按钮文字才刷得出来
    await new Promise((r) => setTimeout(r));
    const sim = new MatchSim({
      seed: 1000 + g,
      points,
      cpu: { near: level, far: level },
      tune: tuning,
    });
    const log: MatchEvent[] = [];
    while (sim.phase.kind !== 'gameOver' && sim.t < 900) {
      sim.tick();
      log.push(...sim.drainEvents());
    }
    // 每局错开时间，免得两局的事件混在一起
    const offset = all.length ? all[all.length - 1].t + 10 : 0;
    for (const e of fromMatchEvents(log)) all.push({ t: e.t + offset, kind: e.kind });
  }
  simSamples = rhythmSamples(all);
  simLabel = `${CPU_LEVELS[level - 1].name} vs ${CPU_LEVELS[level - 1].name} · ${points} 分制`;
  btn.disabled = false;
  btn.textContent = '跑 10 局电脑对电脑';
  render();
}

// ---------------------------------------------------------------- 界面

function render(): void {
  const list = $('marks');
  list.innerHTML = marks
    .map(
      (m, i) =>
        `<li data-i="${i}" class="${m.kind === 'end' ? 'end' : ''}"><span>${NAME[m.kind]}</span><span>${m.t.toFixed(3)}s · ${frameOf(m.t)}<button data-del="${i}">×</button></span></li>`
    )
    .join('');
  list.querySelectorAll<HTMLLIElement>('li').forEach((li) =>
    li.addEventListener('click', (e) => {
      const del = (e.target as HTMLElement).dataset.del;
      if (del !== undefined) {
        marks.splice(Number(del), 1);
        save();
        render();
        return;
      }
      video.pause();
      video.currentTime = marks[Number(li.dataset.i)].t;
    })
  );
  $('count').textContent = marks.length ? `${marks.length} 个` : '';

  const vid = rhythmSamples(marks);
  const ms = (s: number) => (Number.isFinite(s) ? `${Math.round(s * 1000)}ms` : '—');
  const rows = METRICS.map(({ key, name }) => {
    const v = summarize(vid[key]);
    const s = simSamples ? summarize(simSamples[key]) : null;
    const d = s && v.n && s.n ? s.median / v.median - 1 : NaN;
    const dCell = Number.isFinite(d)
      ? `<td class="${Math.abs(d) <= 0.1 ? 'ok' : 'warn'}">${d > 0 ? '+' : ''}${Math.round(d * 100)}%</td>`
      : '<td class="dim">—</td>';
    return `<tr>
      <td>${name}</td>
      <td>${ms(v.median)}</td>
      <td>${v.n ? frameOf(v.median) : '—'}</td>
      <td class="dim">${v.n}</td>
      ${simSamples ? `<td>${ms(s!.median)}</td><td class="dim">${s!.n}</td>${dCell}` : ''}
    </tr>`;
  });
  $('table').innerHTML = `
    <tr>
      <th></th><th>视频（中位）</th><th>帧</th><th>样本</th>
      ${simSamples ? `<th>仿真（${simLabel}）</th><th>样本</th><th>差</th>` : ''}
    </tr>
    ${rows.join('')}`;
}

render();
