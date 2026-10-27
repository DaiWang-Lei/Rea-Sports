import { describe, expect, it } from 'vitest';
import { fromAxisAngle, quat, rotateInverse } from '@/core/quat';
import { vec3 } from '@/core/vec3';
import { TOSS, type TossEvent, TossDetector, tossHeight } from '@/input/paddle/TossDetector';

/** 5ms 一个样本（Joy-Con）。up(t) = 竖直比力（g），w = 角速度（rad/s，绕机体 x） */
function run(
  up: (ms: number) => number,
  ms: number,
  w: (ms: number) => number = () => 0,
  q = quat(),
  dt = 5
): TossEvent[] {
  const d = new TossDetector();
  const out: TossEvent[] = [];
  for (let t = 0; t <= ms; t += dt) {
    const e = d.process({
      t,
      q,
      // 机体系的加速度：世界系竖直方向的比力转回机体系
      accel: rotateInverse(q, vec3(0, 0, up(t))),
      gyro: vec3(w(t), 0, 0),
    });
    if (e) out.push(e);
  }
  return out;
}

/** 一次向上抖：从 start 开始 dur 毫秒内比力按正弦升到 peak 再回到 1G */
const flick = (start: number, dur: number, peak: number) => (t: number) =>
  t < start || t > start + dur ? 1 : 1 + (peak - 1) * Math.sin((Math.PI * (t - start)) / dur);

describe('向上抖手柄抛球', () => {
  it('静止、轻微晃动不触发', () => {
    expect(run(() => 1, 3000)).toHaveLength(0);
    expect(run((t) => 1 + 0.2 * Math.sin(t / 40), 3000)).toHaveLength(0);
  });

  it('向上抖一下触发一次，抖得越用力抛得越高', () => {
    const soft = run(flick(500, 90, 1.8), 1500);
    const hard = run(flick(500, 90, 4.5), 1500);
    expect(soft).toHaveLength(1);
    expect(hard).toHaveLength(1);
    expect(hard[0].height).toBeGreaterThan(soft[0].height + 0.2);
    expect(soft[0].peakG).toBeCloseTo(1.8, 1);
    // 在加速结束时触发（球离手）
    expect(soft[0].t).toBeGreaterThan(540);
    expect(soft[0].t).toBeLessThan(600);
  });

  it('高度在 0.45–1.0 米之间（按键抛 0.75 米）', () => {
    expect(tossHeight(1.3)).toBeCloseTo(0.45);
    expect(tossHeight(2.3)).toBeCloseTo(0.6);
    expect(tossHeight(20)).toBeCloseTo(1.0);
  });

  it('只超过阈值 1–2 个样本（一下磕碰）不触发', () => {
    expect(run(flick(500, 8, 3), 1500)).toHaveLength(0);
  });

  it('转得快（挥拍）不触发', () => {
    const e = run(flick(500, 90, 3), 1500, (t) => (t > 480 && t < 620 ? 10 : 0));
    expect(e).toHaveLength(0);
  });

  it('姿态任意：拍头朝上或平放时向上抖都能识别', () => {
    const tilted = fromAxisAngle(0, 1, 0, Math.PI / 2);
    expect(run(flick(500, 90, 2.5), 1500, () => 0, tilted)).toHaveLength(1);
  });

  it('持续向上加速超过 150ms：在 150ms 时触发，之后 0.6 秒内不再触发', () => {
    const e = run((t) => (t >= 500 && t < 900 ? 2 : 1), 2000);
    expect(e).toHaveLength(1);
    expect(e[0].durationMs).toBeGreaterThanOrEqual(TOSS.maxMs);
    expect(e[0].durationMs).toBeLessThan(TOSS.maxMs + 10);
  });

  it('手机 60Hz 采样也能识别', () => {
    expect(run(flick(500, 120, 2.5), 1500, () => 0, quat(), 1000 / 60)).toHaveLength(1);
  });
});
