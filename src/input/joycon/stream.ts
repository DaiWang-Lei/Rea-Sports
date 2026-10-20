/**
 * 把 Joy-Con 的原始输入报告变成「带时间戳的 IMU 样本 + 按键状态」。
 * 纯逻辑，不依赖 WebHID：实机驱动和录制回放共用这一层。
 */
import { ImuClock } from '../clock/ImuClock';
import { type Buttons, emptyButtons, type ImuSample, type JoyConSide } from '../types';
import {
  computeScale,
  convertSample,
  DEFAULT_CALIBRATION,
  type ImuCalibration,
  type ImuScale,
  isImuAllZero,
} from './calibration';
import {
  IN_FULL,
  IN_SUBCMD_REPLY,
  parseButtons,
  parseFullReport,
  parseSubcmdReply,
  type SubcmdReply,
} from './protocol';

export interface JoyConStreamEvents {
  /** 每个 0x30 报告解析出的 3 个样本（最旧的在前） */
  onSamples?: (samples: ImuSample[]) => void;
  onButtons?: (buttons: Buttons, prev: Buttons) => void;
  onSubcmdReply?: (reply: SubcmdReply) => void;
}

export interface JoyConStreamStats {
  fullReports: number;
  samples: number;
  clippedSamples: number;
  zeroImuReports: number;
  consecutiveZeroImu: number;
  /** 最近一次 0x30 报告的到达时间 */
  lastFullReportAt: number;
  /** 最近一次 IMU 有效（非全零）报告的到达时间 */
  lastImuAt: number;
}

export class JoyConStream {
  readonly clock = new ImuClock();
  calibration: ImuCalibration = DEFAULT_CALIBRATION;
  private scale: ImuScale = computeScale(DEFAULT_CALIBRATION);
  buttons: Buttons = emptyButtons();
  battery = -1;
  charging = false;
  readonly stats: JoyConStreamStats = {
    fullReports: 0,
    samples: 0,
    clippedSamples: 0,
    zeroImuReports: 0,
    consecutiveZeroImu: 0,
    lastFullReportAt: -Infinity,
    lastImuAt: -Infinity,
  };

  constructor(
    readonly side: JoyConSide,
    public events: JoyConStreamEvents = {}
  ) {}

  setCalibration(cal: ImuCalibration): void {
    this.calibration = cal;
    this.scale = computeScale(cal);
  }

  handleReport(reportId: number, data: DataView, arrival: number): void {
    if (reportId === IN_FULL) {
      const r = parseFullReport(data);
      if (!r) return;
      this.stats.fullReports++;
      this.stats.lastFullReportAt = arrival;
      this.battery = r.battery;
      this.charging = r.charging;
      this.updateButtons(r.buttonBytes);
      if (isImuAllZero(r.imu)) {
        this.stats.zeroImuReports++;
        this.stats.consecutiveZeroImu++;
        return;
      }
      this.stats.consecutiveZeroImu = 0;
      this.stats.lastImuAt = arrival;
      const { times } = this.clock.onReport(arrival, r.timer);
      const samples: ImuSample[] = [];
      // 报告里第 0 个样本是最新的（实测录制数据：按「新 → 旧」排信号才连续，反过来会出现 5ms 级的锯齿），
      // 这里按时间先后输出
      for (let k = 0; k < 3; k++) {
        const s = convertSample(r.imu, 2 - k, this.scale, this.side, times[k]);
        if (s.clipped) this.stats.clippedSamples++;
        samples.push(s);
      }
      this.stats.samples += 3;
      this.events.onSamples?.(samples);
    } else if (reportId === IN_SUBCMD_REPLY) {
      const reply = parseSubcmdReply(data);
      if (!reply) return;
      this.updateButtons(reply.buttonBytes);
      this.events.onSubcmdReply?.(reply);
    }
  }

  private updateButtons(bytes: [number, number, number]): void {
    const next = parseButtons(bytes);
    let changed = false;
    for (const k in next) {
      if (next[k as keyof Buttons] !== this.buttons[k as keyof Buttons]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const prev = this.buttons;
    this.buttons = next;
    this.events.onButtons?.(next, prev);
  }
}
