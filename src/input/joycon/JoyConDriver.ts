/**
 * Joy-Con WebHID 驱动：打开设备、按顺序发送初始化子命令（等待 ACK）、看门狗、震动。
 * 报告解析交给 JoyConStream（纯逻辑，可回放测试）。
 */
import type { Buttons, ImuSample, JoyConSide } from '../types';
import { DEFAULT_CALIBRATION, parseCalibrationBlock, parseUserCalibration } from './calibration';
import {
  buildRumblePayload,
  buildSubcommandPayload,
  IMU_SENSITIVITY_ARGS,
  IN_FULL,
  isAck,
  JOYCON_L_PRODUCT_ID,
  NEUTRAL_RUMBLE,
  OUT_RUMBLE_AND_SUBCMD,
  OUT_RUMBLE_ONLY,
  parseSpiRead,
  SPI_FACTORY_IMU_CAL,
  SPI_USER_IMU_CAL_MAGIC,
  spiReadArgs,
  Subcmd,
  type SubcmdReply,
} from './protocol';
import { encodeRumble, RUMBLE_MAX_AMP, type RumblePulse } from './rumble';
import { JoyConStream } from './stream';

export type DriverStatus = 'idle' | 'opening' | 'initializing' | 'streaming' | 'stalled' | 'closed';

export const STATUS_TEXT: Record<DriverStatus, string> = {
  idle: '未连接',
  opening: '正在打开设备…',
  initializing: '正在初始化…',
  streaming: '数据正常',
  stalled: '收不到体感数据',
  closed: '已断开',
};

export interface JoyConDriverEvents {
  onSamples?: (samples: ImuSample[]) => void;
  onButtons?: (buttons: Buttons, prev: Buttons) => void;
  onStatus?: (status: DriverStatus, detail?: string) => void;
  /** 原始输入报告（录制用） */
  onRawReport?: (reportId: number, data: Uint8Array, arrival: number) => void;
  onLog?: (message: string) => void;
}

const SUBCMD_TIMEOUT_MS = 150;
const SUBCMD_RETRIES = 3;
/** macOS 打开设备后系统还要和手柄握手，过早发命令会丢（SDL 等 250ms） */
const OPEN_SETTLE_MS = 300;
const WATCHDOG_PERIOD_MS = 100;
const NO_REPORT_MS = 500;
const NO_IMU_MS = 250;
const ZERO_IMU_REPORTS = 50;
const MAX_REINIT_ATTEMPTS = 3;
/** 输出报告最小间隔（避免把蓝牙塞满） */
const MIN_OUTPUT_INTERVAL_MS = 15;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Pending {
  subcmd: number;
  resolve: (r: SubcmdReply | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JoyConDriver {
  readonly side: JoyConSide;
  readonly stream: JoyConStream;
  status: DriverStatus = 'idle';
  reinitCount = 0;

  private counter = 0;
  private pending: Pending[] = [];
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private reinitAttempts = 0;
  private reinitInFlight = false;
  private lastReinitAt = 0;
  private sendChain: Promise<void> = Promise.resolve();
  private lastSendAt = 0;
  private rumbleTimers: Array<ReturnType<typeof setTimeout>> = [];
  private startedAt = 0;

  constructor(
    readonly device: HIDDevice,
    public events: JoyConDriverEvents = {}
  ) {
    this.side = device.productId === JOYCON_L_PRODUCT_ID ? 'L' : 'R';
    this.stream = new JoyConStream(this.side, {
      onSamples: (s) => this.events.onSamples?.(s),
      onButtons: (b, p) => this.events.onButtons?.(b, p),
      onSubcmdReply: (r) => this.resolvePending(r),
    });
  }

  get name(): string {
    return this.side === 'L' ? 'Joy-Con (L)' : 'Joy-Con (R)';
  }

  async start(): Promise<void> {
    this.setStatus('opening');
    try {
      if (!this.device.opened) await this.device.open();
    } catch (e) {
      this.setStatus('closed', `无法打开设备：${(e as Error).message}`);
      throw e;
    }
    this.device.addEventListener('inputreport', this.onInputReport);
    await sleep(OPEN_SETTLE_MS);
    this.setStatus('initializing');
    await this.readCalibration();
    await this.subcommand(Subcmd.EnableVibration, [0x01]);
    await this.configureImu();
    await this.subcommand(Subcmd.SetPlayerLights, [0x01]);
    this.startedAt = performance.now();
    this.startWatchdog();
  }

  async stop(): Promise<void> {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    for (const t of this.rumbleTimers) clearTimeout(t);
    this.rumbleTimers = [];
    this.device.removeEventListener('inputreport', this.onInputReport);
    for (const p of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending = [];
    try {
      if (this.device.opened) await this.device.close();
    } catch {
      // 设备已经不在了
    }
    this.setStatus('closed');
  }

  /** 设备被拔掉/断开时由上层调用 */
  markDisconnected(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.setStatus('closed', '手柄已断开');
  }

  /**
   * 播放一串震动片段（例如「哎呀」是两下短震）。幅度会被限制在 RUMBLE_MAX_AMP 以内，结束后发送停止帧。
   */
  rumble(pulses: RumblePulse[]): void {
    for (const t of this.rumbleTimers) clearTimeout(t);
    this.rumbleTimers = [];
    let at = 0;
    for (const p of pulses) {
      const data = encodeRumble(
        { freq: p.hf.freq, amp: Math.min(p.hf.amp, RUMBLE_MAX_AMP) },
        { freq: p.lf.freq, amp: Math.min(p.lf.amp, RUMBLE_MAX_AMP) }
      );
      const isGap = p.hf.amp <= 0 && p.lf.amp <= 0;
      this.rumbleTimers.push(setTimeout(() => this.sendRumble(isGap ? NEUTRAL_RUMBLE : data), at));
      at += Math.max(p.durationMs, MIN_OUTPUT_INTERVAL_MS);
    }
    this.rumbleTimers.push(setTimeout(() => this.sendRumble(NEUTRAL_RUMBLE), at));
  }

  private sendRumble(data: readonly number[]): void {
    void this.send(OUT_RUMBLE_ONLY, buildRumblePayload(this.nextCounter(), data)).catch(() => {});
  }

  private onInputReport = (e: HIDInputReportEvent): void => {
    const arrival = e.timeStamp;
    this.events.onRawReport?.(
      e.reportId,
      new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength),
      arrival
    );
    this.stream.handleReport(e.reportId, e.data, arrival);
  };

  private async readCalibration(): Promise<void> {
    const factory = await this.spiRead(SPI_FACTORY_IMU_CAL, 0x18);
    const user = await this.spiRead(SPI_USER_IMU_CAL_MAGIC, 0x1a);
    const cal =
      (user && parseUserCalibration(user)) ||
      (factory && parseCalibrationBlock(factory, 'factory')) ||
      DEFAULT_CALIBRATION;
    this.stream.setCalibration(cal);
    this.log(
      cal.source === 'default'
        ? '没读到 IMU 校准数据，使用默认值'
        : `使用${cal.source === 'user' ? '用户' : '出厂'}IMU 校准数据`
    );
  }

  /** 开 IMU → 设量程（必须在 0x40 之后，因为 0x40 会把量程重置为 ±8G）→ 全量报告模式 */
  private async configureImu(): Promise<boolean> {
    const a = await this.subcommand(Subcmd.EnableImu, [0x01]);
    const b = await this.subcommand(Subcmd.SetImuSensitivity, IMU_SENSITIVITY_ARGS);
    const c = await this.subcommand(Subcmd.SetInputMode, [IN_FULL]);
    return !!(a && b && c);
  }

  private async spiRead(address: number, size: number): Promise<Uint8Array | null> {
    const reply = await this.subcommand(Subcmd.SpiRead, spiReadArgs(address, size), (r) => {
      const spi = parseSpiRead(r.payload);
      return !!spi && spi.address === address;
    });
    if (!reply) return null;
    return parseSpiRead(reply.payload)?.bytes ?? null;
  }

  private async subcommand(
    id: number,
    args: ArrayLike<number>,
    accept: (r: SubcmdReply) => boolean = () => true
  ): Promise<SubcmdReply | null> {
    for (let attempt = 0; attempt < SUBCMD_RETRIES; attempt++) {
      const wait = this.waitReply(id, accept);
      try {
        await this.send(
          OUT_RUMBLE_AND_SUBCMD,
          buildSubcommandPayload(this.nextCounter(), NEUTRAL_RUMBLE, id, args)
        );
      } catch (e) {
        this.log(`发送子命令 0x${id.toString(16)} 失败：${(e as Error).message}`);
      }
      const reply = await wait;
      if (reply && isAck(reply)) return reply;
      if (reply) this.log(`子命令 0x${id.toString(16)} 被拒绝（ACK=0x${reply.ack.toString(16)}）`);
    }
    this.log(`子命令 0x${id.toString(16)} 没有回应`);
    return null;
  }

  private waitReply(
    subcmd: number,
    accept: (r: SubcmdReply) => boolean
  ): Promise<SubcmdReply | null> {
    return new Promise((resolve) => {
      const entry: Pending = {
        subcmd,
        resolve: (r) => {
          if (r && !accept(r)) return;
          clearTimeout(entry.timer);
          this.pending = this.pending.filter((p) => p !== entry);
          resolve(r);
        },
        timer: setTimeout(() => {
          this.pending = this.pending.filter((p) => p !== entry);
          resolve(null);
        }, SUBCMD_TIMEOUT_MS),
      };
      this.pending.push(entry);
    });
  }

  private resolvePending(reply: SubcmdReply): void {
    for (const p of [...this.pending]) {
      if (p.subcmd === reply.subcmd) p.resolve(reply);
    }
  }

  /** 输出报告串行发送，并保证最小间隔 */
  private send(reportId: number, payload: Uint8Array<ArrayBuffer>): Promise<void> {
    const run = async () => {
      const wait = this.lastSendAt + MIN_OUTPUT_INTERVAL_MS - performance.now();
      if (wait > 0) await sleep(wait);
      this.lastSendAt = performance.now();
      await this.device.sendReport(reportId, payload);
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => {});
    return p;
  }

  private nextCounter(): number {
    const c = this.counter;
    this.counter = (this.counter + 1) & 0x0f;
    return c;
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => void this.watchdogTick(), WATCHDOG_PERIOD_MS);
  }

  private async watchdogTick(): Promise<void> {
    if (this.reinitInFlight || this.status === 'closed') return;
    const now = performance.now();
    const st = this.stream.stats;
    const sinceStart = now - this.startedAt;
    const noReports = now - Math.max(st.lastFullReportAt, this.startedAt) > NO_REPORT_MS;
    const noImu =
      st.lastFullReportAt > now - NO_REPORT_MS &&
      now - Math.max(st.lastImuAt, this.startedAt) > NO_IMU_MS;
    const zeroImu = st.consecutiveZeroImu >= ZERO_IMU_REPORTS;

    if (!noReports && !noImu && !zeroImu) {
      if (st.samples > 0) {
        this.reinitAttempts = 0;
        if (this.status !== 'streaming') this.setStatus('streaming');
      }
      return;
    }
    if (sinceStart < NO_REPORT_MS) return;

    if (this.reinitAttempts >= MAX_REINIT_ATTEMPTS) {
      if (this.status !== 'stalled') {
        this.setStatus(
          'stalled',
          '多次重新初始化仍收不到体感数据：请按一下手柄按键唤醒，或在系统蓝牙里断开后重新配对'
        );
      }
      // 仍然每隔一段时间尝试一次
      if (now - this.lastReinitAt < 3000) return;
    }

    const reason = noReports ? '收不到报告' : zeroImu ? 'IMU 数据全为 0' : 'IMU 数据中断';
    this.reinitAttempts++;
    this.reinitCount++;
    this.lastReinitAt = now;
    this.log(`看门狗：${reason}，第 ${this.reinitAttempts} 次重新初始化 IMU`);
    this.reinitInFlight = true;
    try {
      await this.configureImu();
    } finally {
      this.reinitInFlight = false;
      this.startedAt = performance.now();
    }
  }

  private setStatus(status: DriverStatus, detail?: string): void {
    this.status = status;
    this.events.onStatus?.(status, detail);
    if (detail) this.log(detail);
  }

  private log(message: string): void {
    this.events.onLog?.(`[${this.name}] ${message}`);
  }
}
