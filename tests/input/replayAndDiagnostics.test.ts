import { describe, expect, it } from 'vitest';
import { fromAxisAngle, multiply, quat, rotateInverse } from '@/core/quat';
import { vec3 } from '@/core/vec3';
import { AxisConsistencyCheck, SixFaceCheck } from '@/input/diagnostics';
import { DEFAULT_CALIBRATION } from '@/input/joycon/calibration';
import { fromHex, ImuRecorder, replayRecording, toHex } from '@/input/replay/recording';
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

/** 产生一段「慢慢转动」的理想 IMU 数据；gyroSigns 用来模拟陀螺某些轴符号接反 */
function slowRotation(gyroSigns: [number, number, number]): ImuSample[] {
  const out: ImuSample[] = [];
  let q = quat();
  const dt = 0.005;
  const UP = vec3(0, 0, 1);
  for (let i = 0; i < 3000; i++) {
    const t = i * dt;
    // 角速度（机体系，度/秒）：三轴都有、缓慢变化
    const w = vec3(60 * Math.sin(t * 1.3), 50 * Math.cos(t * 0.9), 40 * Math.sin(t * 0.7 + 1));
    q = multiply(q, fromAxisAngle(w.x, w.y, w.z, Math.hypot(w.x, w.y, w.z) * (Math.PI / 180) * dt));
    const a = rotateInverse(q, UP);
    out.push({
      t: t * 1000,
      gyro: vec3(w.x * gyroSigns[0], w.y * gyroSigns[1], w.z * gyroSigns[2]),
      accel: a,
      clipped: false,
    });
  }
  return out;
}

describe('诊断', () => {
  it('陀螺与加速度计轴向一致时判定为一致', () => {
    const c = new AxisConsistencyCheck();
    for (const s of slowRotation([1, 1, 1])) c.add(s);
    const r = c.result();
    expect(r.ready).toBe(true);
    expect(r.consistent).toBe(true);
    expect(r.bestSigns).toEqual([1, 1, 1]);
  });

  it('陀螺 Y、Z 接反时能识别出来', () => {
    const c = new AxisConsistencyCheck();
    for (const s of slowRotation([1, -1, -1])) c.add(s);
    const r = c.result();
    expect(r.ready).toBe(true);
    expect(r.consistent).toBe(false);
    expect(r.bestSigns).toEqual([1, -1, -1]);
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
