/**
 * 电脑这边：接收所有手机发来的体感数据，每台手机对应一个 PhoneDevice。
 * PhoneDevice 输出的 ImuSample 与 Joy-Con 驱动完全一样（同一机体坐标约定、本机时间基准），
 * 后面的姿态融合、挥拍识别不需要区分是手机还是 Joy-Con。
 *
 * 连接方式（GamePhoneLink）有两种：
 *  - RelayGameLink：本地开发服务器里的 WebSocket 中转（pnpm dev，不需要外网）
 *  - RtcGameLink：WebRTC 直连 + 公共 MQTT 服务器握手（线上部署用，如 GitHub Pages）
 */
import { MqttClient } from '@/net/MqttClient';
import {
  ICE_SERVERS,
  randomCode,
  type SignalMessage,
  topicGame,
  topicPhone,
  topicPhones,
  waitIceGathering,
} from '@/net/signal';
import { OffsetClock } from '../clock/OffsetClock';
import type { RumblePulse } from '../joycon/rumble';
import type { ImuSample } from '../types';
import {
  type GameToPhoneMessage,
  type PhoneButton,
  type PhoneMessage,
  type PhoneMetaMsg,
  type RelayMessage,
  vibratePattern,
} from './protocol';

// ---------------------------------------------------------------- 单台手机

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
  handle(msg: PhoneMessage, arrival: number): void {
    switch (msg.type) {
      case 'imu': {
        if (this.lastSeq >= 0 && msg.seq > this.lastSeq + 1) {
          this.lostSamples += msg.seq - this.lastSeq - 1;
        }
        if (msg.seq < this.lastSeq) this.lastSeq = -1; // 手机刷新了页面，序号重新开始
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

  /** 手机重新连上（例如刷新了页面）：时钟要重新对齐 */
  resetClock(): void {
    this.clock.reset();
    this.lastT = -Infinity;
    this.lastSeq = -1;
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

// ---------------------------------------------------------------- 连接方式

export interface PhoneLinkHost {
  onPhoneOn(id: string, name: string): void;
  onPhoneOff(id: string): void;
  onMessage(id: string, msg: PhoneMessage, arrival: number): void;
  onStatus(text: string, ok: boolean): void;
}

export interface GamePhoneLink {
  readonly kind: 'relay' | 'rtc';
  start(host: PhoneLinkHost): void;
  sendTo(id: string, msg: GameToPhoneMessage): void;
  stop(): void;
}

/** 本地开发服务器里的 WebSocket 中转 */
export class RelayGameLink implements GamePhoneLink {
  readonly kind = 'relay' as const;
  private ws: WebSocket | null = null;
  private retryTimer = 0;
  private closed = false;
  private host: PhoneLinkHost | null = null;
  private readonly known = new Set<string>();

  start(host: PhoneLinkHost): void {
    this.host = host;
    this.closed = false;
    this.open();
  }

  private open(): void {
    const host = this.host!;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/motion?role=game`);
    this.ws = ws;
    host.onStatus('正在连接本地中转服务…', false);
    ws.onopen = () => host.onStatus('等待手机连接（本地中转）', true);
    ws.onmessage = (e) => {
      const arrival = performance.now();
      let msg: RelayMessage;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'phones':
          for (const p of msg.list) this.on(p.id, p.name);
          return;
        case 'phone-on':
          this.on(msg.id, msg.name);
          return;
        case 'phone-off':
          this.known.delete(msg.id);
          host.onPhoneOff(msg.id);
          return;
        default:
          if (!this.known.has(msg.from)) this.on(msg.from, '手机');
          host.onMessage(msg.from, msg, arrival);
      }
    };
    ws.onclose = () => {
      for (const id of this.known) host.onPhoneOff(id);
      this.known.clear();
      host.onStatus('本地中转服务已断开，正在重连…', false);
      if (!this.closed) this.retryTimer = window.setTimeout(() => this.open(), 1500);
    };
  }

  private on(id: string, name: string): void {
    this.known.add(id);
    this.host!.onPhoneOn(id, name);
  }

  sendTo(id: string, msg: GameToPhoneMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'to-phone', id, msg }));
    }
  }

  stop(): void {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}

interface Peer {
  id: string;
  name: string;
  session: string;
  pc: RTCPeerConnection;
  ctl: RTCDataChannel;
  imu: RTCDataChannel;
  open: boolean;
  timer: number;
}

/** WebRTC 直连：公共 MQTT 服务器只用来交换握手消息 */
export class RtcGameLink implements GamePhoneLink {
  readonly kind = 'rtc' as const;
  private mqtt: MqttClient | null = null;
  private host: PhoneLinkHost | null = null;
  private readonly peers = new Map<string, Peer>();

  constructor(readonly room: string) {}

  start(host: PhoneLinkHost): void {
    this.host = host;
    const mqtt = new MqttClient(`rea-game-${randomCode(10)}`);
    this.mqtt = mqtt;
    host.onStatus('正在连接握手服务器…', false);
    mqtt.onStatus = (ok) => {
      if (ok) {
        host.onStatus(`等待手机连接（房间号 ${this.room}）`, true);
        mqtt.publish(
          topicPhones(this.room),
          JSON.stringify({ type: 'game-here' } satisfies SignalMessage)
        );
      } else {
        host.onStatus('握手服务器已断开，正在重连…（已连上的手机不受影响）', false);
      }
    };
    mqtt.onMessage = (_topic, payload) => {
      let m: SignalMessage;
      try {
        m = JSON.parse(payload);
      } catch {
        return;
      }
      void this.onSignal(m);
    };
    mqtt.subscribe(topicGame(this.room));
    mqtt.connect();
  }

  private async onSignal(m: SignalMessage): Promise<void> {
    if (m.type === 'hello') {
      const existing = this.peers.get(m.id);
      if (existing && existing.session === m.session) return; // 正在连 / 已连上
      if (existing) this.closePeer(existing);
      await this.createPeer(m.id, m.name, m.session);
    } else if (m.type === 'answer') {
      const p = this.peers.get(m.id);
      if (!p || p.session !== m.session || p.pc.signalingState !== 'have-local-offer') return;
      try {
        await p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      } catch {
        this.closePeer(p);
      }
    } else if (m.type === 'bye') {
      const p = this.peers.get(m.id);
      if (p && p.session === m.session) this.closePeer(p);
    }
  }

  private async createPeer(id: string, name: string, session: string): Promise<void> {
    const host = this.host!;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const imu = pc.createDataChannel('imu', { ordered: false, maxRetransmits: 0 });
    const ctl = pc.createDataChannel('ctl');
    const peer: Peer = { id, name, session, pc, imu, ctl, open: false, timer: 0 };
    this.peers.set(id, peer);
    const onMsg = (e: MessageEvent) => {
      const arrival = performance.now();
      let msg: PhoneMessage;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      host.onMessage(id, msg, arrival);
    };
    imu.onmessage = onMsg;
    ctl.onmessage = onMsg;
    ctl.onopen = () => {
      peer.open = true;
      window.clearTimeout(peer.timer);
      host.onPhoneOn(id, name);
    };
    ctl.onclose = () => this.closePeer(peer);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closePeer(peer);
    };
    // 20 秒还没连上就放弃，等手机重新打招呼
    peer.timer = window.setTimeout(() => {
      if (!peer.open) this.closePeer(peer);
    }, 20000);

    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGathering(pc, 2000);
    if (this.peers.get(id) !== peer) return;
    this.mqtt?.publish(
      topicPhone(this.room, id),
      JSON.stringify({
        type: 'offer',
        session,
        sdp: pc.localDescription!.sdp,
      } satisfies SignalMessage)
    );
  }

  private closePeer(peer: Peer): void {
    if (this.peers.get(peer.id) !== peer) return;
    this.peers.delete(peer.id);
    window.clearTimeout(peer.timer);
    try {
      peer.pc.close();
    } catch {
      // 忽略
    }
    if (peer.open) this.host?.onPhoneOff(peer.id);
  }

  sendTo(id: string, msg: GameToPhoneMessage): void {
    const p = this.peers.get(id);
    if (p?.ctl.readyState === 'open') p.ctl.send(JSON.stringify(msg));
  }

  stop(): void {
    for (const p of [...this.peers.values()]) this.closePeer(p);
    this.mqtt?.close();
  }
}

// ---------------------------------------------------------------- 管理所有手机

export class PhoneHub {
  readonly phones = new Map<string, PhoneDevice>();
  onPhoneAdded?: (d: PhoneDevice) => void;
  onPhoneRemoved?: (d: PhoneDevice) => void;
  onStatus?: (text: string, ok: boolean) => void;
  private pingTimer = 0;

  constructor(readonly link: GamePhoneLink) {}

  connect(): void {
    this.link.start({
      onPhoneOn: (id, name) => this.add(id, name),
      onPhoneOff: (id) => {
        const d = this.phones.get(id);
        if (!d) return;
        d.connected = false;
        this.phones.delete(id);
        this.onPhoneRemoved?.(d);
      },
      onMessage: (id, msg, arrival) => {
        const d = this.phones.get(id) ?? this.add(id, '手机');
        d.handle(msg, arrival);
      },
      onStatus: (text, ok) => this.onStatus?.(text, ok),
    });
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      for (const d of this.phones.values()) d.ping();
    }, 1000);
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    this.link.stop();
  }

  private add(id: string, name: string): PhoneDevice {
    let d = this.phones.get(id);
    if (d) {
      d.name = name;
      d.resetClock();
      return d;
    }
    d = new PhoneDevice(id, name, (m) => this.link.sendTo(id, m));
    this.phones.set(id, d);
    this.onPhoneAdded?.(d);
    return d;
  }
}

// ---------------------------------------------------------------- 手机该打开哪个网址

/** 本地开发服务器的局域网信息（线上部署时没有这个接口，返回 null） */
export async function devLanInfo(): Promise<{ addresses: string[]; port: number } | null> {
  if (!import.meta.env.DEV) return null; // 线上构建（如 GitHub Pages）没有这个接口
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/lan`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as { addresses: string[]; port: number };
  } catch {
    return null;
  }
}

/**
 * 手机要打开的网址：
 *  - 本地开发：用局域网 IP（手机访问不了 localhost）
 *  - 线上：当前网站地址
 *  WebRTC 方式在网址里带上房间号。
 */
export function phonePageUrl(
  lan: { addresses: string[]; port: number } | null,
  room: string | null
): string | null {
  let base: string;
  if (lan) {
    const ip = lan.addresses[0];
    if (!ip) return null;
    base = `${location.protocol}//${ip}:${lan.port}${import.meta.env.BASE_URL}`;
  } else {
    base = `${location.origin}${import.meta.env.BASE_URL}`;
  }
  return `${base}phone.html${room ? `?room=${room}` : ''}`;
}
