import { describe, expect, it } from 'vitest';
import { ImuClock } from '@/input/clock/ImuClock';
import { Rng } from '@/core/rng';

/** 预热期：学会计时字节步长（100 个报告）+ 偏移窗口（2 秒）完全滑过之后再统计 */
const WARMUP_REPORTS = 400;

interface Sim {
  residuals: number[];
  trueDropsAfterWarmup: number;
  detectedDropsAfterWarmup: number;
  clock: ImuClock;
}

/**
 * 模拟：手柄每 sampleMs 采样一次，每 3 个样本打包成一个报告，报告在最后一个样本之后
 * 经过「基础延迟 + 随机抖动」到达；计时字节每个报告 +3（模 256）。
 */
function simulate(opts: {
  reports: number;
  sampleMs?: number;
  jitterMs?: number;
  dropEvery?: number;
  seed?: number;
}): Sim {
  const { reports, sampleMs = 5, jitterMs = 8, dropEvery = 0, seed = 1 } = opts;
  const rng = new Rng(seed);
  const clock = new ImuClock();
  const residuals: number[] = [];
  let trueDropsAfterWarmup = 0;
  let detectedDropsAfterWarmup = 0;
  for (let j = 0; j < reports; j++) {
    if (dropEvery && j > 0 && j % dropEvery === 0) {
      if (j > WARMUP_REPORTS) trueDropsAfterWarmup++;
      continue;
    }
    const trueNewest = 1000 + (3 * j + 2) * sampleMs;
    // 抖动偶尔很大（蓝牙重传），多数时候较小
    const jitter = rng.chance(0.1) ? rng.uniform(0, jitterMs * 3) : rng.uniform(0, jitterMs);
    const arrival = trueNewest + 6 + jitter;
    const timing = clock.onReport(arrival, (3 * j) & 0xff);
    if (j > WARMUP_REPORTS) {
      detectedDropsAfterWarmup += timing.dropped;
      for (let k = 0; k < 3; k++)
        residuals.push(timing.times[k] - (trueNewest - (2 - k) * sampleMs));
    }
  }
  return { residuals, trueDropsAfterWarmup, detectedDropsAfterWarmup, clock };
}

/** 去掉固定延迟（中位数）后的最大偏差 */
function spread(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const med = s[s.length >> 1];
  return Math.max(...xs.map((x) => Math.abs(x - med)));
}

describe('ImuClock', () => {
  it('抖动下样本时间误差（去掉固定延迟后）小于 2ms', () => {
    const { residuals, clock } = simulate({ reports: 1500 });
    expect(spread(residuals)).toBeLessThan(2);
    expect(clock.stats().sampleIntervalMs).toBeCloseTo(5, 1);
    expect(clock.stats().timerStep).toBe(3);
  });

  it('丢包后时间轴仍然连续，丢包数正确', () => {
    const r = simulate({ reports: 2000, dropEvery: 37 });
    expect(spread(r.residuals)).toBeLessThan(2);
    expect(r.detectedDropsAfterWarmup).toBe(r.trueDropsAfterWarmup);
  });

  it('11ms 报告间隔（部分蓝牙栈）也能自适应', () => {
    const { residuals, clock } = simulate({ reports: 2000, sampleMs: 11 / 3 });
    expect(spread(residuals)).toBeLessThan(2);
    expect(clock.stats().reportIntervalMs).toBeCloseTo(11, 0);
  });

  it('计时字节不符合模型时自动弃用，退回按到达间隔判断', () => {
    const clock = new ImuClock();
    const rng = new Rng(5);
    for (let j = 0; j < 600; j++) {
      // 前 150 个报告计时字节规律递增，之后变成随机数
      const timer = j < 150 ? (3 * j) & 0xff : rng.int(0, 255);
      clock.onReport(1000 + j * 15 + rng.uniform(0, 3), timer);
    }
    expect(clock.stats().timerStep).toBeNull();
  });

  it('输出时间不晚于到达时间，且严格递增', () => {
    const clock = new ImuClock();
    for (let j = 0; j < 200; j++) {
      const arrival = 500 + j * 15 + (j % 7);
      const t = clock.onReport(arrival, (3 * j) & 0xff);
      expect(t.times[2]).toBeLessThanOrEqual(arrival);
      expect(t.times[0]).toBeLessThan(t.times[1]);
      expect(t.times[1]).toBeLessThan(t.times[2]);
    }
  });
});
