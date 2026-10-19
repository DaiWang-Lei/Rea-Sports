/** 求解器性能：随机击球 / 发球各跑一批，输出平均、P95、最大耗时 */
import { createTuning } from '../src/config/tuning';
import { Rng } from '../src/core/rng';
import { vec3 } from '../src/core/vec3';
import { solveRallyShot, solveServe } from '../src/sim/shot/ShotSolver';

const pp = createTuning().physics;
const rng = new Rng(2024);

function stats(name: string, times: number[]) {
  const s = [...times].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  console.log(
    `${name}：${s.length} 次，平均 ${mean.toFixed(3)}ms，P50 ${p(0.5).toFixed(3)}ms，P95 ${p(0.95).toFixed(3)}ms，最大 ${s[s.length - 1].toFixed(3)}ms`
  );
}

const rally: number[] = [];
for (let i = 0; i < 3000; i++) {
  const p0 = vec3(rng.uniform(-0.6, 0.6), rng.uniform(-1.9, -1.4), rng.uniform(0.85, 1.15));
  const target = { x: rng.uniform(-0.6, 0.6), y: rng.uniform(0.3, 1.25) };
  const w0 = vec3(rng.uniform(-250, 250), rng.uniform(-50, 50), rng.uniform(-150, 150));
  const t0 = performance.now();
  solveRallyShot(
    {
      p0,
      w0,
      target,
      speedH: rng.uniform(4, 12),
      minClearance: 0.025,
      maxApex: 0.9,
      flightTimeFactor: 1.08,
    },
    pp
  );
  rally.push(performance.now() - t0);
}
stats('普通回球', rally);

const serve: number[] = [];
for (let i = 0; i < 500; i++) {
  const t0 = performance.now();
  solveServe(
    {
      p0: vec3(rng.uniform(-0.5, 0.5), -1.5, rng.uniform(0.95, 1.15)),
      w0: vec3(rng.uniform(-150, 150), 0, rng.uniform(-80, 80)),
      first: { x: 0, y: rng.uniform(-1.1, -0.5) },
      second: { x: rng.uniform(-0.55, 0.55), y: rng.uniform(0.55, 1.15) },
      speedH: 6,
      minClearance: 0.01,
    },
    pp
  );
  serve.push(performance.now() - t0);
}
stats('发球', serve);
