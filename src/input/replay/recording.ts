/**
 * IMU 录制格式与回放。录的是原始输入报告（不是换算后的样本），
 * 这样回放时能完整复现「解析 → 时间戳 → 融合 → 挥拍识别」整条链路，用于调参和回归测试。
 */
import type { ImuCalibration } from '../joycon/calibration';
import { IN_FULL, IN_SUBCMD_REPLY } from '../joycon/protocol';
import { JoyConStream, type JoyConStreamEvents } from '../joycon/stream';
import type { ImuSample, JoyConSide } from '../types';

export interface ImuMarker {
  /** 与报告到达时间同一时间基准，毫秒 */
  t: number;
  label: string;
}

export interface ImuRecording {
  format: 'rea-sports-imu';
  version: 1;
  createdAt: string;
  /** 数据来源：Joy-Con 录原始报告；手机录换算后的样本 */
  source?: 'joycon' | 'phone';
  /** 手机型号/平台等说明 */
  device?: string;
  side: JoyConSide;
  calibration: ImuCalibration;
  note?: string;
  /** [报告 ID, 到达时间（毫秒）, 数据十六进制]（Joy-Con） */
  reports: Array<[number, number, string]>;
  /** [时间（毫秒）, gx, gy, gz（度/秒）, ax, ay, az（g）]（手机） */
  samples?: Array<[number, number, number, number, number, number, number]>;
  markers: ImuMarker[];
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export class ImuRecorder {
  private reports: Array<[number, number, string]> = [];
  private samples: Array<[number, number, number, number, number, number, number]> = [];
  private markers: ImuMarker[] = [];

  constructor(
    readonly side: JoyConSide,
    readonly calibration: ImuCalibration,
    readonly source: 'joycon' | 'phone' = 'joycon',
    readonly device?: string
  ) {}

  get reportCount(): number {
    return this.reports.length + this.samples.length;
  }

  /** 手机等没有原始报告的来源：直接录样本 */
  addSample(s: ImuSample): void {
    const r = (v: number, k: number) => Math.round(v * k) / k;
    this.samples.push([
      r(s.t, 100),
      r(s.gyro.x, 100),
      r(s.gyro.y, 100),
      r(s.gyro.z, 100),
      r(s.accel.x, 10000),
      r(s.accel.y, 10000),
      r(s.accel.z, 10000),
    ]);
  }

  get markerCount(): number {
    return this.markers.length;
  }

  addReport(reportId: number, data: Uint8Array, arrival: number): void {
    if (reportId !== IN_FULL && reportId !== IN_SUBCMD_REPLY) return;
    this.reports.push([reportId, Math.round(arrival * 100) / 100, toHex(data)]);
  }

  mark(t: number, label: string): void {
    this.markers.push({ t: Math.round(t * 100) / 100, label });
  }

  finish(note?: string): ImuRecording {
    return {
      format: 'rea-sports-imu',
      version: 1,
      createdAt: new Date().toISOString(),
      source: this.source,
      device: this.device,
      side: this.side,
      calibration: this.calibration,
      note,
      reports: this.reports,
      samples: this.samples.length ? this.samples : undefined,
      markers: this.markers,
    };
  }
}

/**
 * 把一段录制按顺序回放，事件同步触发：Joy-Con 录制走完整的报告解析链路，手机录制直接给出样本。
 */
export function replayRecording(rec: ImuRecording, events: JoyConStreamEvents): JoyConStream {
  const stream = new JoyConStream(rec.side, events);
  stream.setCalibration(rec.calibration);
  for (const [id, arrival, hex] of rec.reports) {
    const bytes = fromHex(hex);
    stream.handleReport(id, new DataView(bytes.buffer), arrival);
  }
  for (const [t, gx, gy, gz, ax, ay, az] of rec.samples ?? []) {
    events.onSamples?.([
      { t, gyro: { x: gx, y: gy, z: gz }, accel: { x: ax, y: ay, z: az }, clipped: false },
    ]);
  }
  return stream;
}

export function isImuRecording(x: unknown): x is ImuRecording {
  const r = x as ImuRecording;
  return !!r && r.format === 'rea-sports-imu' && r.version === 1 && Array.isArray(r.reports);
}
