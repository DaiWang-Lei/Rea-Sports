import { describe, expect, it } from 'vitest';
import {
  computeScale,
  convertSample,
  DEFAULT_CALIBRATION,
  parseCalibrationBlock,
  parseUserCalibration,
} from '@/input/joycon/calibration';
import {
  buildSubcommandPayload,
  NEUTRAL_RUMBLE,
  OUTPUT_PAYLOAD_LENGTH,
  parseButtons,
  parseFullReport,
  parseSpiRead,
  parseSubcmdReply,
  spiReadArgs,
  Subcmd,
} from '@/input/joycon/protocol';
import { encodeAmplitude, encodeRumble, encodeRumbleSide } from '@/input/joycon/rumble';
import { JoyConStream } from '@/input/joycon/stream';
import type { ImuSample } from '@/input/types';

function i16le(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const u = v & 0xffff;
    out.push(u & 0xff, (u >> 8) & 0xff);
  }
  return out;
}

/** 构造一个 0x30 报告的 WebHID data（不含报告 ID，48 字节） */
function fullReport(timer: number, imu: number[], buttons: [number, number, number] = [0, 0, 0]) {
  const bytes = new Uint8Array(48);
  bytes[0] = timer;
  bytes[1] = 0x80; // 电量 8，非充电
  bytes[2] = buttons[0];
  bytes[3] = buttons[1];
  bytes[4] = buttons[2];
  bytes.set(i16le(imu), 12);
  return new DataView(bytes.buffer);
}

describe('protocol', () => {
  it('子命令负载布局：计数器、震动、子命令、参数，补零到 48 字节', () => {
    const p = buildSubcommandPayload(17, NEUTRAL_RUMBLE, Subcmd.SetImuSensitivity, [3, 3, 1, 1]);
    expect(p.length).toBe(OUTPUT_PAYLOAD_LENGTH);
    expect(p[0]).toBe(1); // 17 & 0xF
    expect(Array.from(p.slice(1, 9))).toEqual(NEUTRAL_RUMBLE);
    expect(p[9]).toBe(0x41);
    expect(Array.from(p.slice(10, 14))).toEqual([3, 3, 1, 1]);
    expect(p[14]).toBe(0);
  });

  it('SPI 读取参数为小端地址 + 长度', () => {
    expect(spiReadArgs(0x6020, 0x18)).toEqual([0x20, 0x60, 0x00, 0x00, 0x18]);
  });

  it('解析 0x30 报告的 IMU 与电量', () => {
    const imu = [100, -200, 4096, 10, -20, 30, 1, 2, 3, 4, 5, 6, -7, -8, -9, -10, -11, -12];
    const r = parseFullReport(fullReport(42, imu))!;
    expect(r.timer).toBe(42);
    expect(r.battery).toBe(8);
    expect(r.charging).toBe(false);
    expect(Array.from(r.imu)).toEqual(imu);
  });

  it('解析 0x21 子命令回复与 SPI 数据', () => {
    const bytes = new Uint8Array(48);
    bytes[12] = 0x90; // ACK（最高位为 1）
    bytes[13] = 0x10; // SPI 读
    bytes.set([0x20, 0x60, 0, 0, 3, 0xaa, 0xbb, 0xcc], 14);
    const reply = parseSubcmdReply(new DataView(bytes.buffer))!;
    expect(reply.subcmd).toBe(0x10);
    expect(reply.ack & 0x80).toBe(0x80);
    const spi = parseSpiRead(reply.payload)!;
    expect(spi.address).toBe(0x6020);
    expect(Array.from(spi.bytes)).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('按键位：A=右字节 bit3，+=共用 bit1，↑=左字节 bit1', () => {
    const b = parseButtons([0b0000_1000, 0b0000_0010, 0b0000_0010]);
    expect(b.a).toBe(true);
    expect(b.plus).toBe(true);
    expect(b.up).toBe(true);
    expect(b.b).toBe(false);
    expect(b.down).toBe(false);
  });
});

describe('calibration', () => {
  it('解析出厂校准块；离谱数值（未写入 0xFF）返回 null', () => {
    const block = new Uint8Array(
      i16le([350, -120, 200, 16384, 16384, 16384, 12, -8, 3, 13371, 13371, 13371])
    );
    const cal = parseCalibrationBlock(block, 'factory')!;
    expect(cal.accelOrigin).toEqual([350, -120, 200]);
    expect(cal.gyroOffset).toEqual([12, -8, 3]);
    expect(parseCalibrationBlock(new Uint8Array(24).fill(0xff), 'factory')).toBeNull();
  });

  it('用户校准需要魔数 B2 A1', () => {
    const data = i16le([0, 0, 0, 16384, 16384, 16384, 0, 0, 0, 13371, 13371, 13371]);
    expect(parseUserCalibration(new Uint8Array([0xb2, 0xa1, ...data]))?.source).toBe('user');
    expect(parseUserCalibration(new Uint8Array([0xff, 0xff, ...data]))).toBeNull();
  });

  it('换算：±16G 下 2048 LSB = 1g；陀螺 13371 系数下 1000 LSB ≈ 70dps', () => {
    const scale = computeScale(DEFAULT_CALIBRATION);
    const imu = new Int16Array([0, 0, 2048, 1000, 0, 0, ...new Array(12).fill(0)]);
    const s = convertSample(imu, 0, scale, 'L', 0);
    expect(s.accel.z).toBeCloseTo(1, 6); // 2048 × 8/16384
    expect(s.gyro.x).toBeCloseTo((1000 * 936) / 13371, 6);
  });

  it('右手柄的 Y、Z 轴取反（与左手柄、Pro 手柄一致）', () => {
    const scale = computeScale(DEFAULT_CALIBRATION);
    const imu = new Int16Array([100, 200, 300, 400, 500, 600, ...new Array(12).fill(0)]);
    const l = convertSample(imu, 0, scale, 'L', 0);
    const r = convertSample(imu, 0, scale, 'R', 0);
    expect(r.accel.x).toBeCloseTo(l.accel.x);
    expect(r.accel.y).toBeCloseTo(-l.accel.y);
    expect(r.accel.z).toBeCloseTo(-l.accel.z);
    expect(r.gyro.x).toBeCloseTo(l.gyro.x);
    expect(r.gyro.y).toBeCloseTo(-l.gyro.y);
    expect(r.gyro.z).toBeCloseTo(-l.gyro.z);
  });

  it('接近量程时标记为顶格', () => {
    const scale = computeScale(DEFAULT_CALIBRATION);
    const imu = new Int16Array([0, 0, 0, 32000, 0, 0, ...new Array(12).fill(0)]);
    expect(convertSample(imu, 0, scale, 'L', 0).clipped).toBe(true);
  });
});

describe('rumble', () => {
  it('静止帧编码为 00 01 40 40', () => {
    expect(encodeRumbleSide({ freq: 320, amp: 0 }, { freq: 160, amp: 0 })).toEqual([
      0x00, 0x01, 0x40, 0x40,
    ]);
    expect(encodeRumble({ freq: 320, amp: 0 }, { freq: 160, amp: 0 })).toEqual(NEUTRAL_RUMBLE);
  });

  it('幅度刻度与官方表一致', () => {
    expect(encodeAmplitude(1)).toBe(100);
    expect(encodeAmplitude(0.2299)).toBe(32);
    expect(encodeAmplitude(0.122874)).toBe(17);
    expect(encodeAmplitude(0.033442)).toBe(8);
    expect(encodeAmplitude(0.112491)).toBe(15);
    expect(encodeAmplitude(0)).toBe(0);
  });

  it('满幅：高频幅度字节 0xC8，低频幅度 0x72', () => {
    const [b0, b1, b2, b3] = encodeRumbleSide({ freq: 320, amp: 1 }, { freq: 160, amp: 1 });
    expect(b0).toBe(0x00);
    expect(b1).toBe(0xc8 + 0x01);
    expect(b2).toBe(0x40);
    expect(b3).toBe(0x72);
  });

  it('奇数幅度刻度把 0x80 标志放进低频频率字节', () => {
    const [, , b2, b3] = encodeRumbleSide({ freq: 320, amp: 0 }, { freq: 160, amp: 0.122874 });
    expect(b2).toBe(0x40 + 0x80);
    expect(b3).toBe(0x48);
  });
});

describe('JoyConStream', () => {
  it('0x30 报告产生 3 个按时间递增的样本，并报告按键变化', () => {
    const got: ImuSample[] = [];
    let pressed = false;
    const s = new JoyConStream('R', {
      onSamples: (xs) => got.push(...xs),
      onButtons: (b) => (pressed = b.a),
    });
    const imu = [0, 0, -2048, 0, 0, 0, 0, 0, -2048, 0, 0, 0, 0, 0, -2048, 0, 0, 0];
    s.handleReport(0x30, fullReport(0, imu), 100);
    s.handleReport(0x30, fullReport(3, imu, [0x08, 0, 0]), 115);
    expect(got.length).toBe(6);
    for (let i = 1; i < got.length; i++) expect(got[i].t).toBeGreaterThan(got[i - 1].t);
    // 右手柄 Z 取反：原始 −2048（−1g）→ +1g
    expect(got[0].accel.z).toBeCloseTo(1, 6);
    expect(pressed).toBe(true);
  });

  it('IMU 全零的报告不产生样本，但计数', () => {
    const s = new JoyConStream('L');
    let n = 0;
    s.events.onSamples = (xs) => (n += xs.length);
    s.handleReport(0x30, fullReport(0, new Array(18).fill(0)), 0);
    expect(n).toBe(0);
    expect(s.stats.consecutiveZeroImu).toBe(1);
  });
});
