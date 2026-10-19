/**
 * 手机这边的两种连接方式：
 *  - RelayPhoneLink：本地开发服务器里的 WebSocket 中转
 *  - RtcPhoneLink：公共 MQTT 握手 + WebRTC 直连（线上部署用）
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
import type { GameToPhoneMessage, PhoneMessage } from '@/input/phone/protocol';

export type LinkState = 'connecting' | 'signaling' | 'connected' | 'disconnected';

export interface PhoneLinkHandlers {
  onMessage(msg: GameToPhoneMessage): void;
  onState(state: LinkState, detail: string): void;
}

export interface PhoneSideLink {
  readonly kind: 'relay' | 'rtc';
  readonly ready: boolean;
  start(h: PhoneLinkHandlers): void;
  send(msg: PhoneMessage): void;
}

export class RelayPhoneLink implements PhoneSideLink {
  readonly kind = 'relay' as const;
  private ws: WebSocket | null = null;
  private h: PhoneLinkHandlers | null = null;

  constructor(
    private readonly id: string,
    private readonly name: string
  ) {}

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(h: PhoneLinkHandlers): void {
    this.h = h;
    this.open();
  }

  private open(): void {
    const h = this.h!;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/motion?role=phone&id=${this.id}&name=${encodeURIComponent(this.name)}`
    );
    this.ws = ws;
    h.onState('connecting', '正在连接电脑…');
    ws.onopen = () => h.onState('connected', '已连接电脑（本地中转）');
    ws.onmessage = (e) => {
      try {
        h.onMessage(JSON.parse(e.data as string));
      } catch {
        // 忽略
      }
    };
    ws.onclose = () => {
      h.onState('disconnected', '与电脑断开，正在重连…');
      setTimeout(() => this.open(), 1000);
    };
  }

  send(msg: PhoneMessage): void {
    if (this.ready) this.ws!.send(JSON.stringify(msg));
  }
}

export class RtcPhoneLink implements PhoneSideLink {
  readonly kind = 'rtc' as const;
  private session = randomCode(8);
  private mqtt: MqttClient | null = null;
  private pc: RTCPeerConnection | null = null;
  private ctl: RTCDataChannel | null = null;
  private imu: RTCDataChannel | null = null;
  private h: PhoneLinkHandlers | null = null;

  constructor(
    readonly room: string,
    private readonly id: string,
    private readonly name: string
  ) {}

  get ready(): boolean {
    return this.ctl?.readyState === 'open';
  }

  start(h: PhoneLinkHandlers): void {
    this.h = h;
    const mqtt = new MqttClient(`rea-phone-${this.id}-${randomCode(6)}`);
    this.mqtt = mqtt;
    h.onState('connecting', '正在连接握手服务器…');
    mqtt.onStatus = (ok) => {
      if (this.ready) return;
      if (ok) {
        h.onState('signaling', `正在寻找电脑（房间号 ${this.room}）…`);
        this.hello();
      } else {
        h.onState('connecting', '正在连接握手服务器…');
      }
    };
    mqtt.onMessage = (_topic, payload) => {
      let m: SignalMessage;
      try {
        m = JSON.parse(payload);
      } catch {
        return;
      }
      if (m.type === 'game-here' && !this.ready) this.hello();
      if (m.type === 'offer' && m.session === this.session) void this.answer(m.sdp);
    };
    mqtt.subscribe(topicPhone(this.room, this.id));
    mqtt.subscribe(topicPhones(this.room));
    mqtt.connect();
    // 电脑可能还没打开：没连上之前每 3 秒打一次招呼
    setInterval(() => {
      if (!this.ready && mqtt.connected) this.hello();
    }, 3000);
    window.addEventListener('pagehide', () => {
      mqtt.publish(
        topicGame(this.room),
        JSON.stringify({ type: 'bye', id: this.id, session: this.session } satisfies SignalMessage)
      );
    });
  }

  private hello(): void {
    this.mqtt?.publish(
      topicGame(this.room),
      JSON.stringify({
        type: 'hello',
        id: this.id,
        name: this.name,
        session: this.session,
      } satisfies SignalMessage)
    );
  }

  private async answer(sdp: string): Promise<void> {
    const h = this.h!;
    this.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    h.onState('signaling', '找到电脑了，正在建立直连…');
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'imu') {
        this.imu = ch;
        return;
      }
      this.ctl = ch;
      ch.onopen = () => h.onState('connected', '已直连电脑');
      ch.onmessage = (ev) => {
        try {
          h.onMessage(JSON.parse(ev.data as string));
        } catch {
          // 忽略
        }
      };
      ch.onclose = () => this.lost();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.lost();
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIceGathering(pc, 2000);
    } catch (e) {
      h.onState('disconnected', `建立直连失败：${(e as Error).message}`);
      return;
    }
    if (this.pc !== pc) return;
    this.mqtt?.publish(
      topicGame(this.room),
      JSON.stringify({
        type: 'answer',
        id: this.id,
        session: this.session,
        sdp: pc.localDescription!.sdp,
      } satisfies SignalMessage)
    );
  }

  /** 直连断了：换一个 session 重新打招呼（电脑那边会建新的连接） */
  private lost(): void {
    if (!this.ctl && !this.pc) return;
    this.ctl = null;
    this.imu = null;
    this.pc?.close();
    this.pc = null;
    this.session = randomCode(8);
    this.h?.onState('disconnected', '与电脑的直连断开，正在重连…');
    if (this.mqtt?.connected) this.hello();
  }

  send(msg: PhoneMessage): void {
    if (msg.type === 'imu') {
      // 不保序通道；积压太多（网络卡）就丢掉，避免越积越慢
      const ch = this.imu;
      if (ch?.readyState === 'open' && ch.bufferedAmount < 32 * 1024) ch.send(JSON.stringify(msg));
      return;
    }
    if (this.ctl?.readyState === 'open') this.ctl.send(JSON.stringify(msg));
  }
}
