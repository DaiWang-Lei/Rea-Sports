import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromAxisAngle, multiply, quat, rotateInverse } from '@/core/quat';
import { Rng } from '@/core/rng';
import { type Vec3, vec3 } from '@/core/vec3';
import { AxisConsistencyCheck, SixFaceCheck } from '@/input/diagnostics';
import { DEFAULT_CALIBRATION } from '@/input/joycon/calibration';
import {
  fromHex,
  ImuRecorder,
  type ImuRecording,
  recordingSamples,
  replayRecording,
  toHex,
} from '@/input/replay/recording';
import type { ImuSample } from '@/input/types';

describe('录制与回放', () => {
  it('十六进制往返', () => {
    const b = new Uint8Array([0, 1, 0x7f, 0x80, 0xff]);
    expect(Array.from(fromHex(toHex(b)))).toEqual(Array.from(b));
  });

  it('录下的原始报告回放后得到同样数量、同样数值的样本', () => {
    const rec = new ImuRecorder('R', DEFAULT_CALIBRATION);
    for (let j = 0; j < 50; j++) {
      const bytes = new Uint8Array(48);
      bytes[0] = (3 * j) & 0xff;
      bytes[1] = 0x80;
      const dv = new DataView(bytes.buffer);
      for (let k = 0; k < 3; k++) {
        dv.setInt16(12 + k * 12 + 4, -2048, true); // az = −1g（右手柄取反后为 +1g）
        dv.setInt16(12 + k * 12 + 6, 100 + j, true); // gx
      }
      rec.addReport(0x30, bytes, 1000 + j * 15);
    }
    rec.mark(1200, 'swing');
    const data = JSON.parse(JSON.stringify(rec.finish('test')));
    const got: ImuSample[] = [];
    replayRecording(data, { onSamples: (s) => got.push(...s) });
    expect(got.length).toBe(150);
    expect(got[0].accel.z).toBeCloseTo(1, 6);
    expect(got[149].gyro.x).toBeCloseTo((149 * 936) / 13371, 3);
    expect(data.markers).toEqual([{ t: 1200, label: 'swing' }]);
  });
});

/**
 * 「换个朝向 → 停稳」反复 12 次的 IMU 数据：每次绕随机轴转 60–150°（0.6 秒，中间快两头慢），再停 0.4 秒，
 * 带一点噪声。mapGyro 模拟陀螺仪读数接错：输入正确的机体系角速度（度/秒），返回读数。
 */
function poseChanges(mapGyro: (w: Vec3) => Vec3 = (w) => w): ImuSample[] {
  const rng = new Rng(3);
  const out: ImuSample[] = [];
  let q = quat();
  const dt = 0.005;
  let t = 0;
  const push = (w: Vec3) => {
    const up = rotateInverse(q, vec3(0, 0, 1));
    const n = () => rng.normal(0, 0.01);
    const noisy = vec3(
      w.x + rng.normal(0, 0.4),
      w.y + rng.normal(0, 0.4),
      w.z + rng.normal(0, 0.4)
    );
    out.push({
      t: t * 1000,
      gyro: mapGyro(noisy),
      accel: vec3(up.x + n(), up.y + n(), up.z + n()),
      clipped: false,
    });
    t += dt;
  };
  for (let k = 0; k < 12; k++) {
    const ax = vec3(rng.normal(0, 1), rng.normal(0, 1), rng.normal(0, 1));
    const l = Math.hypot(ax.x, ax.y, ax.z);
    const total = rng.uniform(60, 150);
    for (let i = 0; i < 120; i++) {
      const rate = ((total * Math.PI) / (2 * 0.6)) * Math.sin((Math.PI * (i + 0.5)) / 120);
      const w = vec3((ax.x / l) * rate, (ax.y / l) * rate, (ax.z / l) * rate);
      q = multiply(q, fromAxisAngle(w.x, w.y, w.z, rate * (Math.PI / 180) * dt));
      push(w);
    }
    for (let i = 0; i < 80; i++) push(vec3());
  }
  return out;
}

function checkOn(samples: ImuSample[]) {
  const c = new AxisConsistencyCheck();
  for (const s of samples) c.add(s);
  return c.result();
}

describe('诊断', () => {
  it('陀螺与加速度计轴向一致时判定为一致', () => {
    const r = checkOn(poseChanges());
    expect(r.ready).toBe(true);
    expect(r.verdict).toBe('consistent');
    expect(r.best).toBe('(+X, +Y, +Z)');
    expect(r.errIdentity).toBeLessThan(3);
  });

  it('陀螺 Y、Z 接反时能识别出来', () => {
    const r = checkOn(poseChanges((w) => vec3(w.x, -w.y, -w.z)));
    expect(r.verdict).toBe('inconsistent');
    expect(r.best).toBe('(+X, −Y, −Z)');
  });

  it('轴的顺序接错（旧版手机页把 alpha 当成绕 z）也能识别出来', () => {
    // 旧版读数 l 与正确值 w 的关系：w = (−l.y, −l.z, l.x)，即 l = (w.z, −w.x, −w.y)
    const r = checkOn(poseChanges((w) => vec3(w.z, -w.x, -w.y)));
    expect(r.verdict).toBe('inconsistent');
    expect(r.best).toBe('(−Y, −Z, +X)');
  });

  it('真机录制：Joy-Con 与（换算正确的）手机都判为一致，手机还原成旧换算则判为不一致', () => {
    const load = (f: string) =>
      recordingSamples(JSON.parse(readFileSync(`fixtures/imu/${f}`, 'utf8')) as ImuRecording);
    expect(checkOn(load('joycon-R-beep-forehand.json')).verdict).toBe('consistent');
    const phone = load('iphone-beep-forehand-side.json');
    expect(checkOn(phone).verdict).toBe('consistent');
    const old = checkOn(phone.map((s) => ({ ...s, gyro: vec3(s.gyro.z, -s.gyro.x, -s.gyro.y) })));
    expect(old.verdict).toBe('inconsistent');
    expect(old.best).toBe('(−Y, −Z, +X)');
  });

  it('六面检查：按键面朝上静止 1 秒记录 |a|', () => {
    const c = new SixFaceCheck();
    for (let i = 0; i < 300; i++) {
      c.add({
        t: i * 5,
        gyro: vec3(0.5, -0.3, 0.2),
        accel: vec3(0.01, -0.02, 1.004),
        clipped: false,
      });
    }
    expect(c.cells['+Z']).toBeCloseTo(1.004, 2);
    expect(c.cells['-Z']).toBeNull();
  });
});
