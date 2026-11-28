/**
 * 远程对打的连接：开房间的一方生成房间码和链接，另一方打开链接加入。握手经公共 MQTT 服务器（同联机测试页），
 * 之后 WebRTC 点对点直连（两边都有 IPv6 时一般能连上，见 net.html 的诊断），不需要自己的服务器。
 *  - game 通道（可靠、保序）：打招呼、开始、抛球、击球、判分（丢了两边就对不上了）
 *  - clock 通道（不保序、不重传）：每 0.25 秒互相报一次时刻，测往返延迟和两边时钟的差
 * 网络短暂断开（换网、信号差）时自动重连：开房间的一方重新协商一条路（ICE 重启），通道和没送到的消息都还在；
 * 25 秒还没连上才算断了。一打开就先看本机有没有 IPv6、地址转换是不是对称型（连不上时提示怎么办）。
 * ?lag=毫秒：收到的消息再晚这么久才交出去（在本机模拟远程的延迟，开发用）。
 */
import { MqttClient } from '@/net/MqttClient';
import { type NatKind, natKind, parseCandidates } from '@/net/netTest';
import { ICE_SERVERS, isValidRoom, randomCode, waitIceGathering } from '@/net/signal';
import type { OnlineMsg } from '@/sim/online/link';

/** 两边交换的人物信息 */
export interface PeerInfo {
  avatar: string;
  handed: 1 | -1;
}

export type SessionMsg =
  | OnlineMsg
  | ({ k: 'hello' } & PeerInfo)
  /** 连好手柄、到了等待页（开房间的一方等对方准备好了才能开始） */
  | { k: 'ready' }
  /** 开房间的一方开始一局（玩法、分制） */
  | { k: 'start'; points: 6 | 11; game?: 'match' | 'challenge' }
  /** 远程连续回击：我现在的分数，打完了没有 */
  | { k: 'cscore'; score: number; over: boolean }
  /** 开房间的一方回到等待页（换玩法） */
  | { k: 'lobby' }
  | { k: 'bye' };

type Signal =
  | { type: 'hello'; session: string }
  | { type: 'offer'; session: string; sdp: string }
  | { type: 'answer'; session: string; sdp: string }
  | { type: 'host-here' };

/** reconnecting = 连上过、网络断了正在重连（这一局先不结束） */
export type SessionStatus =
  'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

const BASE = 'rea-sports/v1/online';
const CONNECT_TIMEOUT_MS = 25000;
/** 断开后多久开始重新协商、多久还没连上算断了 */
const RESTART_AFTER_MS = 3000;
const GIVE_UP_MS = 25000;
const CLOCK_MS = 250;
const KEEP = 40;

export class OnlineSession {
  readonly role: 'host' | 'guest';
  readonly room: string;
  readonly link: string;
  status: SessionStatus = 'waiting';
  /** 对方的人物（连上后对方打招呼才有） */
  peer: PeerInfo | null = null;
  /** 本机网络：有没有 IPv6、地址转换类型（一打开就测，测完前是 null） */
  net: { ipv6: boolean; nat: NatKind } | null = null;
  onStatus?: () => void;
  onMessage?: (m: SessionMsg) => void;

  private readonly session = randomCode(8);
  private readonly mqtt = new MqttClient(`rea-online-${randomCode(10)}`);
  private pc: RTCPeerConnection | null = null;
  private game: RTCDataChannel | null = null;
  private pcSession = '';
  private helloTimer = 0;
  private clockTimer = 0;
  private connectTimer = 0;
  private restartTimer = 0;
  private giveUpTimer = 0;
  /** 连上过（之后断开算重连，不算连不上） */
  private everConnected = false;
  private readonly rtts: number[] = [];
  private readonly offsets: number[] = [];
  private readonly lag = Number(new URLSearchParams(location.search).get('lag') ?? 0) || 0;

  /** room：加入别人的房间；不给就自己开一个 */
  constructor(
    private readonly me: PeerInfo,
    room: string | null
  ) {
    this.role = isValidRoom(room) ? 'guest' : 'host';
    this.room = this.role === 'guest' ? (room as string) : randomCode(6);
    // 对方打开链接走电视界面：开机、加入、选人物之后直接进这个房间
    this.link = `${location.origin}${location.pathname}?room=${this.room}`;
    void this.probe();
    // 关掉页面、刷新：马上告诉对方（不然对方要等连接超时才知道）
    window.addEventListener('pagehide', this.onPageHide);
    this.mqtt.subscribe(this.topic(this.role));
    this.mqtt.onStatus = (ok) => {
      if (!ok) return;
      if (this.role === 'host') this.signal('guest', { type: 'host-here' });
      else if (this.status !== 'connected') this.sayHello();
    };
    this.mqtt.onMessage = (_t, payload) => {
      try {
        void this.onSignal(JSON.parse(payload) as Signal);
      } catch {
        // 不认识的消息
      }
    };
    this.mqtt.connect();
  }

  /** 往返延迟（毫秒，最近的中位数） */
  get rtt(): number {
    return median(this.rtts);
  }

  /** 对方时钟 − 本机时钟（performance.now 毫秒） */
  get offset(): number {
    return median(this.offsets);
  }

  /** 对方的时刻 → 本机的时刻（毫秒） */
  toLocalMs(remoteMs: number): number {
    return remoteMs - this.offset;
  }

  send(m: SessionMsg): void {
    if (this.game?.readyState === 'open') this.game.send(JSON.stringify(m));
  }

  private readonly onPageHide = () => this.send({ k: 'bye' });

  close(): void {
    window.removeEventListener('pagehide', this.onPageHide);
    this.send({ k: 'bye' });
    window.clearInterval(this.helloTimer);
    window.clearInterval(this.clockTimer);
    window.clearTimeout(this.connectTimer);
    window.clearTimeout(this.restartTimer);
    window.clearTimeout(this.giveUpTimer);
    this.pc?.close();
    this.mqtt.close();
    this.setStatus('closed');
  }

  /** 本机网络：收一遍地址看有没有 IPv6、是不是对称型 */
  private async probe(): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    try {
      pc.createDataChannel('probe');
      await pc.setLocalDescription(await pc.createOffer());
      await waitIceGathering(pc, 5000);
      const c = parseCandidates(pc.localDescription?.sdp ?? '');
      this.net = { ipv6: c.srflx.v6.length > 0 || c.host.v6 > 0, nat: natKind(c) };
      this.onStatus?.();
    } catch {
      // 测不了就不提示
    } finally {
      pc.close();
    }
  }

  // ---------------------------------------------------------------- 握手

  private topic(to: 'host' | 'guest'): string {
    return `${BASE}/${this.room}/${to}`;
  }

  private signal(to: 'host' | 'guest', s: Signal): void {
    this.mqtt.publish(this.topic(to), JSON.stringify(s));
  }

  private sayHello(): void {
    window.clearInterval(this.helloTimer);
    const hello = () => {
      if (!this.pc) this.signal('host', { type: 'hello', session: this.session });
    };
    hello();
    this.helloTimer = window.setInterval(hello, 2000);
  }

  private async onSignal(s: Signal): Promise<void> {
    if (this.role === 'host') {
      if (s.type === 'hello') {
        if (this.pc && s.session === this.pcSession && this.status !== 'failed') return;
        await this.startHost(s.session);
      } else if (s.type === 'answer' && this.pc && s.session === this.pcSession) {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
        if (!this.everConnected) this.armTimeout();
      }
    } else if (s.type === 'host-here') {
      if (this.status !== 'connected') this.sayHello();
    } else if (s.type === 'offer' && s.session === this.session) {
      // 已经有连接：开房间的一方在重连（重新协商一条路）
      if (this.pc) await this.renegotiate(s.sdp);
      else await this.startGuest(s.sdp);
    }
  }

  private newPeer(): RTCPeerConnection {
    this.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.addEventListener('connectionstatechange', () => {
      if (pc !== this.pc) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        window.clearTimeout(this.restartTimer);
        window.clearTimeout(this.giveUpTimer);
        if (this.game?.readyState === 'open') this.setStatus('connected');
      } else if (st === 'disconnected' || st === 'failed') {
        if (this.everConnected) this.lost();
        else if (st === 'failed') this.setStatus('failed');
      } else if (st === 'closed' && this.everConnected) this.setStatus('closed');
    });
    this.pc = pc;
    this.setStatus('connecting');
    return pc;
  }

  private async startHost(guestSession: string): Promise<void> {
    const pc = this.newPeer();
    this.pcSession = guestSession;
    this.useGame(pc.createDataChannel('game'));
    this.useClock(pc.createDataChannel('clock', { ordered: false, maxRetransmits: 0 }));
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGathering(pc, 5000);
    if (pc !== this.pc) return;
    this.signal('guest', { type: 'offer', session: guestSession, sdp: pc.localDescription!.sdp });
  }

  /** 连上过又断了：等一下看会不会自己好；开房间的一方重新协商一条路；太久还没好算断了 */
  private lost(): void {
    if (this.status === 'reconnecting') return;
    this.setStatus('reconnecting');
    window.clearTimeout(this.restartTimer);
    window.clearTimeout(this.giveUpTimer);
    if (this.role === 'host')
      this.restartTimer = window.setTimeout(() => void this.restartIce(), RESTART_AFTER_MS);
    this.giveUpTimer = window.setTimeout(() => {
      if (this.status === 'reconnecting') this.setStatus('closed');
    }, GIVE_UP_MS);
  }

  /** 开房间的一方：重新收一遍地址、发给对方（通道不变，没送到的消息之后会补送） */
  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.status !== 'reconnecting') return;
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
    await waitIceGathering(pc, 5000);
    if (pc !== this.pc || this.status !== 'reconnecting') return;
    this.signal('guest', { type: 'offer', session: this.pcSession, sdp: pc.localDescription!.sdp });
    // 还没好就过一会儿再试
    this.restartTimer = window.setTimeout(() => void this.restartIce(), 8000);
  }

  /** 加入的一方：收到重新协商的连接信息，应答 */
  private async renegotiate(offer: string): Promise<void> {
    const pc = this.pc!;
    await pc.setRemoteDescription({ type: 'offer', sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceGathering(pc, 5000);
    if (pc !== this.pc) return;
    this.signal('host', { type: 'answer', session: this.session, sdp: pc.localDescription!.sdp });
  }

  private async startGuest(offer: string): Promise<void> {
    const pc = this.newPeer();
    this.pcSession = this.session;
    window.clearInterval(this.helloTimer);
    pc.addEventListener('datachannel', (e) => {
      if (e.channel.label === 'game') this.useGame(e.channel);
      else this.useClock(e.channel);
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceGathering(pc, 5000);
    if (pc !== this.pc) return;
    this.signal('host', { type: 'answer', session: this.session, sdp: pc.localDescription!.sdp });
    this.armTimeout();
  }

  private armTimeout(): void {
    window.clearTimeout(this.connectTimer);
    this.connectTimer = window.setTimeout(() => {
      if (this.status !== 'connected') this.setStatus('failed');
    }, CONNECT_TIMEOUT_MS);
  }

  private setStatus(s: SessionStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus?.();
  }

  // ---------------------------------------------------------------- 通道

  private useGame(ch: RTCDataChannel): void {
    this.game = ch;
    ch.addEventListener('open', () => {
      window.clearTimeout(this.connectTimer);
      this.everConnected = true;
      this.setStatus('connected');
      this.send({ k: 'hello', ...this.me });
    });
    // 通道关了就没法补救（对方关了页面）
    ch.addEventListener('close', () => {
      if (ch === this.game && this.everConnected) this.setStatus('closed');
    });
    ch.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as SessionMsg;
      const deliver = () => {
        if (m.k === 'hello') this.peer = { avatar: m.avatar, handed: m.handed };
        if (m.k === 'bye') this.setStatus('closed');
        this.onMessage?.(m);
      };
      if (this.lag > 0) window.setTimeout(deliver, this.lag);
      else deliver();
    });
  }

  /** 对时：发本机时刻，对方回「你的时刻 + 我的时刻」；往返一半算单程 */
  private useClock(ch: RTCDataChannel): void {
    ch.addEventListener('open', () => {
      window.clearInterval(this.clockTimer);
      this.clockTimer = window.setInterval(() => {
        if (ch.readyState === 'open') ch.send(JSON.stringify({ a: performance.now() }));
      }, CLOCK_MS);
    });
    ch.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { a: number; b?: number };
      const handle = () => {
        if (m.b === undefined) {
          ch.send(JSON.stringify({ a: m.a, b: performance.now() }));
          return;
        }
        const now = performance.now();
        const rtt = now - m.a;
        push(this.rtts, rtt);
        push(this.offsets, m.b - (m.a + rtt / 2));
      };
      // 模拟延迟时两个方向都晚 lag
      if (this.lag > 0) window.setTimeout(handle, this.lag);
      else handle();
    });
  }
}

function push(a: number[], v: number): void {
  a.push(v);
  if (a.length > KEEP) a.shift();
}

function median(a: readonly number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}
