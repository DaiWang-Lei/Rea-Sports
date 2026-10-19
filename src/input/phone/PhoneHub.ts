/**
 * 电脑这边：连上中转服务器，接收所有手机发来的体感数据，每台手机对应一个 PhoneDevice。
 * PhoneDevice 输出的 ImuSample 与 Joy-Con 驱动完全一样（同一机体坐标约定、本机时间基准），
 * 后面的姿态融合、挥拍识别不需要区分是手机还是 Joy-Con。
 */
import type { RumblePulse } from '../joycon/rumble';
import { OffsetClock } from '../clock/OffsetClock';
import type { ImuSample } from '../types';
import {
  type GameToPhoneMessage,
  type PhoneButton,
  type PhoneMetaMsg,
  type RelayMessage,
  vibratePattern,
} from './protocol';

export interface PhoneDeviceEvents {
  onSamples?: (samples: ImuSample[]) => void;
  onButton?: (name: PhoneButton, down: boolean) => void;
  onMeta?: (meta: PhoneMetaMsg) => void;
  onLog?: (message: string) => void;
}

export class PhoneDevice {
  connected = true;
  meta: PhoneMetaMsg | null = null;
  samples = 0;
  lastSampleAt = -Infinity;
  /** 网络往返延迟（毫秒） */
  rttMs = NaN;
  /** 最近一次样本相对「最快到达」的额外延迟（毫秒） */
  jitterMs = 0;
  lostSamples = 0;
  readonly buttons: Record<PhoneButton, boolean> = {
    confirm: false,
    recenter: false,
    pause: false,
    back: false,
  };
  events: PhoneDeviceEvents = {};
  private readonly clock = new OffsetClock();
  private lastSeq = -1;
  private lastT = -Infinity;

  constructor(
    readonly id: string,
    public name: string,
    private readonly send: (msg: GameToPhoneMessage) => void
  ) {}

  /** 处理一条来自这台手机的消息 */
  handle(msg: RelayMessage, arrival: number): void {
    switch (msg.type) {
      case 'imu': {
        if (this.lastSeq >= 0 && msg.seq > this.lastSeq + 1)
          this.lostSamples += msg.seq - this.lastSeq - 1;
        this.lastSeq = msg.seq;
        const t = this.clock.map(msg.t, arrival);
        this.jitterMs = this.clock.latency(msg.t, arrival);
        if (t <= this.lastT) return; // 乱序到达的旧样本丢掉
        this.lastT = t;
        this.samples++;
        this.lastSampleAt = arrival;
        const s: ImuSample = {
          t,
          gyro: { x: msg.g[0], y: msg.g[1], z: msg.g[2] },
          accel: { x: msg.a[0], y: msg.a[1], z: msg.a[2] },
          clipped: false,
        };
        this.events.onSamples?.([s]);
        break;
      }
      case 'btn':
        this.buttons[msg.name] = msg.down;
        this.events.onButton?.(msg.name, msg.down);
        break;
      case 'meta':
        this.meta = msg;
        this.events.onMeta?.(msg);
        break;
      case 'pong':
        this.rttMs = performance.now() - msg.t;
        break;
      default:
        break;
    }
  }

  ping(): void {
    this.send({ type: 'ping', t: performance.now() });
  }

  /** Joy-Con 的震动预设 → 手机震动（安卓有效，iPhone 浏览器不支持震动） */
  rumble(pulses: RumblePulse[]): void {
    const pattern = vibratePattern(
      pulses.map((p) => ({ durationMs: p.durationMs, on: p.hf.amp > 0 || p.lf.amp > 0 }))
    );
    this.send({ type: 'vibrate', pattern });
  }

  info(text: string): void {
    this.send({ type: 'info', text });
  }

  get platformText(): string {
    const p = this.meta?.platform;
    return p === 'ios' ? 'iPhone' : p === 'android' ? '安卓' : '手机';
  }
}

export class PhoneHub {
  readonly phones = new Map<string, PhoneDevice>();
  onPhoneAdded?: (d: PhoneDevice) => void;
  onPhoneRemoved?: (d: PhoneDevice) => void;
  onStatus?: (connected: boolean) => void;
  private ws: WebSocket | null = null;
  private retryTimer = 0;
  private pingTimer = 0;
  private closed = false;

  connect(): void {
    this.closed = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/motion?role=game`);
    this.ws = ws;
    ws.onopen = () => this.onStatus?.(true);
    ws.onmessage = (e) => {
      const arrival = performance.now();
      let msg: RelayMessage;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      this.route(msg, arrival);
    };
    ws.onclose = () => {
      this.onStatus?.(false);
      for (const d of this.phones.values()) {
        d.connected = false;
        this.onPhoneRemoved?.(d);
      }
      this.phones.clear();
      if (!this.closed) this.retryTimer = window.setTimeout(() => this.connect(), 1500);
    };
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      for (const d of this.phones.values()) d.ping();
    }, 1000);
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private sendTo(id: string, msg: GameToPhoneMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'to-phone', id, msg }));
    }
  }

  private add(id: string, name: string): PhoneDevice {
    let d = this.phones.get(id);
    if (d) {
      d.name = name;
      return d;
    }
    d = new PhoneDevice(id, name, (m) => this.sendTo(id, m));
    this.phones.set(id, d);
    this.onPhoneAdded?.(d);
    return d;
  }

  private route(msg: RelayMessage, arrival: number): void {
    switch (msg.type) {
      case 'phones':
        for (const p of msg.list) this.add(p.id, p.name);
        return;
      case 'phone-on':
        this.add(msg.id, msg.name);
        return;
      case 'phone-off': {
        const d = this.phones.get(msg.id);
        if (d) {
          d.connected = false;
          this.phones.delete(msg.id);
          this.onPhoneRemoved?.(d);
        }
        return;
      }
      default: {
        const d = this.phones.get(msg.from) ?? this.add(msg.from, '手机');
        d.handle(msg, arrival);
      }
    }
  }
}

/** 查询本机局域网地址，拼出手机要打开的网址 */
export async function phoneUrl(): Promise<string | null> {
  try {
    const res = await fetch('/api/lan');
    const info = (await res.json()) as { addresses: string[]; port: number; https: boolean };
    const ip = info.addresses[0];
    if (!ip) return null;
    return `${info.https ? 'https' : 'http'}://${ip}:${info.port ?? location.port}/phone.html`;
  } catch {
    return null;
  }
}
