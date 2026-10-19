import { describe, expect, it } from 'vitest';
import { OffsetClock } from '@/input/clock/OffsetClock';
import { DEFAULT_CALIBRATION } from '@/input/joycon/calibration';
import {
  AccelSignDetector,
  phoneToBody,
  STANDARD_GRAVITY,
  vibratePattern,
} from '@/input/phone/protocol';
import { ImuRecorder, replayRecording } from '@/input/replay/recording';
import type { ImuSample } from '@/input/types';
import { Rng } from '@/core/rng';

describe('手机坐标 → 机体坐标', () => {
  it('屏幕朝上平放：机体 Z 轴加速度为 +1g', () => {
    const r = phoneToBody({ alpha: 0, beta: 0, gamma: 0 }, { x: 0, y: 0, z: STANDARD_GRAVITY }, 1);
    expect(r.accel.z).toBeCloseTo(1, 6);
    expect(r.accel.x).toBeCloseTo(0, 6);
  });

  it('竖直拿着、顶端朝上：机体 X 轴（相当于 Joy-Con 肩键一端）为 +1g', () => {
    const r = phoneToBody({ alpha: 0, beta: 0, gamma: 0 }, { x: 0, y: STANDARD_GRAVITY, z: 0 }, 1);
    expect(r.accel.x).toBeCloseTo(1, 6);
  });

  it('角速度轴：beta(绕手机 x) → 机体 −Y，gamma(绕手机 y) → 机体 X，alpha(绕 z) → 机体 Z', () => {
    const r = phoneToBody({ alpha: 30, beta: 10, gamma: 20 }, { x: 0, y: 0, z: 9.8 }, 1);
    expect(r.gyro).toEqual({ x: 20, y: -10, z: 30 });
  });

  it('加速度符号为 −1 时整体取反（修正反向约定的浏览器）', () => {
    const r = phoneToBody(
      { alpha: 0, beta: 0, gamma: 0 },
      { x: 0, y: 0, z: -STANDARD_GRAVITY },
      -1
    );
    expect(r.accel.z).toBeCloseTo(1, 6);
  });
});

describe('AccelSignDetector', () => {
  const run = (zSign: number, beta = 0, gamma = 0) => {
    const d = new AccelSignDetector();
    const b = (beta * Math.PI) / 180;
    const g = (gamma * Math.PI) / 180;
    const up = { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) };
    for (let i = 0; i < 40; i++) {
      d.add(
        { x: zSign * up.x * 9.8, y: zSign * up.y * 9.8, z: zSign * up.z * 9.8 },
        beta,
        gamma,
        2
      );
    }
    return d.sign;
  };

  it('标准约定（平放 z=+9.8）判为 1', () => expect(run(1)).toBe(1));
  it('反向约定判为 −1', () => expect(run(-1)).toBe(-1));
  it('倾斜着拿也能判断', () => {
    expect(run(1, 40, -25)).toBe(1);
    expect(run(-1, 40, -25)).toBe(-1);
  });
  it('在转动或没有倾角数据时不判断', () => {
    const d = new AccelSignDetector();
    for (let i = 0; i < 50; i++) d.add({ x: 0, y: 0, z: 9.8 }, null, null, 2);
    for (let i = 0; i < 50; i++) d.add({ x: 0, y: 0, z: 9.8 }, 0, 0, 200);
    expect(d.sign).toBe(0);
  });
});

describe('震动节奏', () => {
  it('开/关交替，太短的震动拉长到 20ms', () => {
    expect(
      vibratePattern([
        { durationMs: 15, on: true },
        { durationMs: 40, on: false },
        { durationMs: 25, on: true },
      ])
    ).toEqual([20, 40, 25]);
  });
  it('以停顿开头时补一个 0', () => {
    expect(
      vibratePattern([
        { durationMs: 30, on: false },
        { durationMs: 30, on: true },
      ])
    ).toEqual([0, 30, 30]);
  });
});

describe('OffsetClock', () => {
  it('Wi-Fi 抖动下，换算后的样本间隔仍然等于手机端的间隔', () => {
    const c = new OffsetClock();
    const rng = new Rng(3);
    const out: number[] = [];
    for (let i = 0; i < 600; i++) {
      const remote = 50_000 + i * 16.667;
      const arrival =
        remote - 49_000 + 8 + (rng.chance(0.1) ? rng.uniform(0, 60) : rng.uniform(0, 6));
      out.push(c.map(remote, arrival));
    }
    // 预热 2 秒后，相邻样本间隔恒定
    for (let i = 200; i < out.length; i++) {
      expect(Math.abs(out[i] - out[i - 1] - 16.667)).toBeLessThan(1.5);
    }
  });

  it('换算结果不晚于到达时间', () => {
    const c = new OffsetClock();
    for (let i = 0; i < 100; i++) {
      const arrival = 1000 + i * 16 + (i % 5);
      expect(c.map(i * 16, arrival)).toBeLessThanOrEqual(arrival);
    }
  });
});

describe('手机录制回放', () => {
  it('录下的样本原样回放', () => {
    const r = new ImuRecorder('R', DEFAULT_CALIBRATION, 'phone', 'test');
    const s: ImuSample = {
      t: 12.34,
      gyro: { x: 1.5, y: -2, z: 300 },
      accel: { x: 0.1, y: -0.2, z: 1.0005 },
      clipped: false,
    };
    r.addSample(s);
    r.addSample({ ...s, t: 29 });
    const data = JSON.parse(JSON.stringify(r.finish()));
    expect(data.source).toBe('phone');
    const got: ImuSample[] = [];
    replayRecording(data, { onSamples: (x) => got.push(...x) });
    expect(got.length).toBe(2);
    expect(got[0]).toEqual(s);
  });
});
