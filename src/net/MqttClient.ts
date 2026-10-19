/**
 * 基于 WebSocket 的极简 MQTT 客户端（QoS 0），用公共服务器交换 WebRTC 握手消息。
 * 断线自动重连并重新订阅。
 */
import {
  connectPacket,
  DISCONNECT,
  parsePackets,
  PINGREQ,
  publishPacket,
  subscribePacket,
} from './mqttCodec';

/** 国内节点（腾讯云上海）的 EMQX 公共服务器；海外备用 */
export const PUBLIC_BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];

type WsCtor = new (url: string, protocols?: string | string[]) => WebSocket;

export interface MqttClientOptions {
  brokers?: string[];
  keepaliveSec?: number;
  /** Node 环境下可传入 ws 库的 WebSocket */
  WebSocketImpl?: WsCtor;
}

export class MqttClient {
  onMessage?: (topic: string, payload: string) => void;
  onStatus?: (connected: boolean, broker: string) => void;
  connected = false;
  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private readonly topics = new Set<string>();
  private packetId = 1;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private brokerIndex = 0;
  private closed = false;
  private readonly brokers: string[];
  private readonly keepalive: number;
  private readonly Ws: WsCtor;
  private pending: Uint8Array[] = [];

  constructor(
    readonly clientId: string,
    opts: MqttClientOptions = {}
  ) {
    this.brokers = opts.brokers ?? PUBLIC_BROKERS;
    this.keepalive = opts.keepaliveSec ?? 30;
    this.Ws = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsCtor);
  }

  get broker(): string {
    return this.brokers[this.brokerIndex % this.brokers.length];
  }

  connect(): void {
    this.closed = false;
    const ws = new this.Ws(this.broker, 'mqtt');
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      ws.send(connectPacket(this.clientId, this.keepalive));
    };
    ws.onmessage = (e: MessageEvent) => {
      const chunk = new Uint8Array(e.data as ArrayBuffer);
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      const { packets, consumed } = parsePackets(merged);
      this.buf = merged.slice(consumed);
      for (const p of packets) {
        if (p.type === 'connack') {
          if (p.returnCode !== 0) {
            ws.close();
            return;
          }
          this.connected = true;
          for (const t of this.topics) ws.send(subscribePacket(this.nextId(), t));
          for (const pkt of this.pending) ws.send(pkt);
          this.pending = [];
          this.startPing();
          this.onStatus?.(true, this.broker);
        } else if (p.type === 'publish') {
          this.onMessage?.(p.topic, p.payload);
        }
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.stopPing();
      this.onStatus?.(false, this.broker);
      if (this.closed) return;
      // 一直连不上就换一个服务器
      if (!opened) this.brokerIndex++;
      this.retryTimer = setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => {
      // 交给 onclose 处理重连
    };
  }

  subscribe(topic: string): void {
    this.topics.add(topic);
    if (this.connected && this.ws) this.ws.send(subscribePacket(this.nextId(), topic));
  }

  publish(topic: string, payload: string): void {
    const pkt = publishPacket(topic, payload);
    if (this.connected && this.ws) this.ws.send(pkt);
    else this.pending.push(pkt);
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopPing();
    try {
      if (this.connected) this.ws?.send(DISCONNECT);
    } catch {
      // 忽略
    }
    this.ws?.close();
  }

  private nextId(): number {
    this.packetId = (this.packetId % 65535) + 1;
    return this.packetId;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.connected) this.ws?.send(PINGREQ);
    }, this.keepalive * 500);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
