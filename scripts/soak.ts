/**
 * 无界面批量对局：电脑对电脑跑 N 局，统计回合长度、失分原因、击球间隔、求解器失败等。
 * 用法：pnpm soak --games 200 --a 3 --b 3 --seed 1 --points 6
 */
import { MatchSim } from '../src/sim/MatchSim';
import { REASON_TEXT, type PointReason } from '../src/sim/rally/Referee';

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

const games = arg('games', 200);
const a = arg('a', 3);
const b = arg('b', 3);
const seed = arg('seed', 1);
const points = arg('points', 6) === 11 ? 11 : 6;

const rally: number[] = [];
const intervals: number[] = [];
const pointDur: number[] = [];
const reasons: Partial<Record<PointReason, number>> = {};
let solverFailures = 0;
let hits = 0;
let whiffs = 0;
const whiffReasons: Record<string, number> = {};
let nearWins = 0;
let farWins = 0;
let draws = 0;
let maxPointDur = 0;
let maxTicks = 0;
const t0 = performance.now();

for (let g = 0; g < games; g++) {
  const sim = new MatchSim({ points, seed: seed * 100003 + g, cpu: { near: a, far: b } });
  let ticks = 0;
  while (sim.phase.kind !== 'gameOver') {
    sim.tick();
    sim.drainEvents();
    ticks++;
    if (ticks > 240 * 60 * 30) throw new Error(`第 ${g} 局超过 30 分钟仍未结束（卡住了？）`);
  }
  maxTicks = Math.max(maxTicks, ticks);
  const res = sim.phase.result;
  if (res === 'near') nearWins++;
  else if (res === 'far') farWins++;
  else draws++;
  rally.push(...sim.stats.rallyLengths);
  intervals.push(...sim.stats.hitIntervals);
  pointDur.push(...sim.stats.pointDurations);
  for (const [k, v] of Object.entries(sim.stats.reasons)) {
    reasons[k as PointReason] = (reasons[k as PointReason] ?? 0) + (v ?? 0);
  }
  solverFailures += sim.stats.solverFailures;
  hits += sim.stats.hits;
  whiffs += sim.stats.whiffs;
  for (const [k, v] of Object.entries(sim.stats.whiffReasons))
    whiffReasons[k] = (whiffReasons[k] ?? 0) + (v ?? 0);
  maxPointDur = Math.max(maxPointDur, ...sim.stats.pointDurations);
}

const ms = performance.now() - t0;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[s.length >> 1] ?? NaN;
};
const totalPoints = rally.length;
const hist = new Map<number, number>();
for (const r of rally) hist.set(Math.min(r, 20), (hist.get(Math.min(r, 20)) ?? 0) + 1);

console.log(
  `${games} 局（${points} 分制），近端 ${a} 级 vs 远端 ${b} 级，种子 ${seed}，用时 ${(ms / 1000).toFixed(1)} 秒`
);
console.log(`胜负：近端 ${nearWins} / 远端 ${farWins} / 平局 ${draws}`);
console.log(
  `回合长度（含发球的击球次数）：平均 ${mean(rally).toFixed(2)}，中位数 ${median(rally)}`
);
console.log(
  '  分布：' +
    [...hist.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([k, v]) => `${k === 20 ? '20+' : k}:${((v / totalPoints) * 100).toFixed(0)}%`)
      .join(' ')
);
console.log(
  `击球间隔：中位数 ${median(intervals).toFixed(3)} 秒，平均 ${mean(intervals).toFixed(3)} 秒`
);
console.log(`每分用时：平均 ${mean(pointDur).toFixed(2)} 秒，最长 ${maxPointDur.toFixed(2)} 秒`);
console.log('失分原因：');
for (const [k, v] of Object.entries(reasons).sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0))) {
  console.log(
    `  ${REASON_TEXT[k as PointReason]}：${(((v ?? 0) / totalPoints) * 100).toFixed(1)}%`
  );
}
console.log(`挥空原因：${JSON.stringify(whiffReasons)}`);
console.log(
  `挥空 ${whiffs} 次；求解器未完全满足约束 ${solverFailures} 次 / ${hits} 次击球（${((solverFailures / Math.max(1, hits)) * 100).toFixed(2)}%）`
);
