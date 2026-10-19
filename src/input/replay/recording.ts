/**
 * IMU 录制格式与回放。录的是原始输入报告（不是换算后的样本），
 * 这样回放时能完整复现「解析 → 时间戳 → 融合 → 挥拍识别」整条链路，用于调参和回归测试。
 */
import type { ImuCalibration } from '../joycon/calibration';
import { IN_FULL, IN_SUBCMD_REPLY } from '../joycon/protocol';
import { JoyConStream, type JoyConStreamEvents } from '../joycon/stream';
import type { JoyConSide } from '../types';

export interface ImuMarker {
  /** 与报告到达时间同一时间基准，毫秒 */
  t: number;
  label: string;
}

export interface ImuRecording {
  format: 'rea-sports-imu';
  version: 1;
  createdAt: string;
  side: JoyConSide;
  calibration: ImuCalibration;
  note?: string;
  /** [报告 ID, 到达时间（毫秒）, 数据十六进制] */
  reports: Array<[number, number, string]>;
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
  private markers: ImuMarker[] = [];

  constructor(
    readonly side: JoyConSide,
    readonly calibration: ImuCalibration
  ) {}

  get reportCount(): number {
    return this.reports.length;
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
      side: this.side,
      calibration: this.calibration,
      note,
      reports: this.reports,
      markers: this.markers,
    };
  }
}

/** 把一段录制按顺序喂给新的 JoyConStream，事件同步触发 */
export function replayRecording(rec: ImuRecording, events: JoyConStreamEvents): JoyConStream {
  const stream = new JoyConStream(rec.side, events);
  stream.setCalibration(rec.calibration);
  for (const [id, arrival, hex] of rec.reports) {
    const bytes = fromHex(hex);
    stream.handleReport(id, new DataView(bytes.buffer), arrival);
  }
  return stream;
}

export function isImuRecording(x: unknown): x is ImuRecording {
  const r = x as ImuRecording;
  return !!r && r.format === 'rea-sports-imu' && r.version === 1 && Array.isArray(r.reports);
}
