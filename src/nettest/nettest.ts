/**
 * 联机测试页：一方打开就开一个房间（房间码、链接、二维码），另一方打开链接加入。
 * 握手经公共 MQTT 服务器，之后 WebRTC 点对点直连；连上后两边每 0.25 秒互相「乒」一次（不重传的通道，和以后对打一样）。
 * 同时经握手服务器转发来回「乒」（每 0.5 秒）：直连打不通时，对打可以改走这条路，不需要自己的服务器。
 * 显示两条路的往返延迟、丢包，连接方式（局域网 / 穿透 / 中转），两边的地址和地址转换类型（诊断打不通的原因），
 * 最后给出结论，可以复制结果发给开发者。
 */
import '@/ui/tv/tokens.css';
import './nettest.css';
import QRCode from 'qrcode';
import { MqttClient } from '@/net/MqttClient';
import {
  bestPath,
  type CandidateSummary,
  describeCandidates,
  lossRate,
  NAT_TEXT,
  natKind,
  type NetSignal,
  parseCandidates,
  PATH_TEXT,
  type PathKind,
  pathKind,
  type RttSummary,
  SLOW_BROKER_MS,
  summarizeRtt,
  topicGuest,
  topicHost,
  topicRelay,
  verdict,
  type Verdict,
  VERDICT_TEXT,
} from '@/net/netTest';
import { ICE_SERVERS, isValidRoom, randomCode, waitIceGathering } from '@/net/signal';

/** 直连、转发各多久「乒」一次 */
const PING_MS = 250;
const RELAY_PING_MS = 500;
/** 超过这么久没回来的「乒」算丢了 */
const LOST_MS = 2000;
/** 统计最近这么多次往返 */
const KEEP = 240;
/** 交换完连接信息后这么久还没连上，算打不通 */
const CONNECT_TIMEOUT_MS = 25000;
/** 直连测满这么多次（约 15 秒）、转发测满这么多次（约 10 秒）才给结论；刚连上的头几次不算丢包（路还没稳） */
const MIN_DIRECT = 60;
const MIN_RELAY = 20;
const WARMUP = 4;

const params = new URLSearchParams(location.search);
const joinRoom = params.get('room');
const role: 'host' | 'guest' = isValidRoom(joinRoom) ? 'guest' : 'host';
const other = role === 'host' ? 'guest' : 'host';
const room = role === 'guest' ? (joinRoom as string) : randomCode(6);
const session = randomCode(8);
const shareLink = `${location.origin}${location.pathname}?room=${room}`;
const t0 = performance.now();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const roomEl = $('room');
const verdictEl = $('verdict');
const statsEl = $('stats');
const logEl = $('log');

/** 一条路上的「乒」：发出去的、回来的、往返时间 */
class Pinger {
  readonly rtts: number[] = [];
  private readonly pending = new Map<number, number>();
  /** 发了几次；算丢包的那部分（去掉刚连上的头几次）发了几次、回来几次 */
  sent = 0;
  private counted = 0;
  private answered = 0;
  private seq = 0;

  /** 发一个「乒」，返回要发出去的内容 */
  next(): { k: 'p'; s: number; t: number } {
    const now = performance.now();
    this.seq++;
    this.sent++;
    if (this.seq > WARMUP) this.counted++;
    this.pending.set(this.seq, now);
    for (const [s, t] of this.pending) if (now - t > LOST_MS * 3) this.pending.delete(s);
    return { k: 'p', s: this.seq, t: now };
  }

  /** 回来一个「乓」 */
  back(s: number, t: number): void {
    if (!this.pending.delete(s)) return;
    if (s > WARMUP) this.answered++;
    this.rtts.push(performance.now() - t);
    if (this.rtts.length > KEEP) this.rtts.shift();
  }

  reset(): void {
    this.rtts.length = 0;
    this.pending.clear();
    this.sent = this.counted = this.answered = this.seq = 0;
  }

  /** 往返统计、丢包率（还在路上的不算） */
  stats(): { rtt: RttSummary | null; loss: number } {
    const now = performance.now();
    let inFlight = 0;
    for (const [s, t] of this.pending) if (s > WARMUP && now - t < LOST_MS) inFlight++;
    return {
      rtt: summarizeRtt(this.rtts),
      loss: lossRate(this.counted, this.answered, inFlight),
    };
  }
}

// ---------------------------------------------------------------- 状态

const state = {
  broker: '',
  brokerOk: false,
  peerSeen: false,
  connected: false,
  failed: false,
  path: null as PathKind | null,
  localType: '',
  remoteType: '',
  /** 直连走的是 IPv4 还是 IPv6 */
  family: '',
  /** 拿到公网地址的 STUN 服务器 */
  stunOk: new Set<string>(),
  gatheredLocal: false,
  /** 两边连接信息里的地址 */
  mine: null as CandidateSummary | null,
  theirs: null as CandidateSummary | null,
  /** 试过的路：各种状态的条数 */
  pairs: '',
};
const direct = new Pinger();
const relay = new Pinger();
/** 本机到握手服务器的往返（发给自己的转发主题再收回来）：看是哪一边慢（比如开着代理绕到国外） */
const broker = new Pinger();

let pc: RTCPeerConnection | null = null;
let fast: RTCDataChannel | null = null;
let pcSession = '';
let pingTimer = 0;
let connectTimer = 0;
let relayTimer = 0;
const logLines: string[] = [];
const logged = new Set<string>();

function log(key: string, text: string): void {
  if (logged.has(key)) return;
  logged.add(key);
  const at = ((performance.now() - t0) / 1000).toFixed(1);
  logLines.push(`${at} 秒 ${text}`);
  const li = document.createElement('li');
  li.innerHTML = `${text}<small>${at} 秒</small>`;
  logEl.appendChild(li);
}

// ---------------------------------------------------------------- 握手、转发

const mqtt = new MqttClient(`rea-net-${randomCode(10)}`);
mqtt.subscribe(role === 'host' ? topicHost(room) : topicGuest(room));
mqtt.subscribe(topicRelay(room, role));
mqtt.onStatus = (ok, broker) => {
  state.brokerOk = ok;
  state.broker = new URL(broker).hostname;
  if (ok) {
    log('broker', `连上了握手服务器（${state.broker}）`);
    if (role === 'host') send(topicGuest(room), { type: 'host-here' });
    else if (!state.connected) sayHello();
  }
  render();
};
mqtt.onMessage = (topic, payload) => {
  let msg: unknown;
  try {
    msg = JSON.parse(payload);
  } catch {
    return;
  }
  if (topic === topicRelay(room, role))
    onRelay(msg as { k: 'p' | 'q' | 's'; s: number; t: number });
  else void handle(msg as NetSignal);
};
mqtt.connect();

function send(topic: string, msg: NetSignal): void {
  mqtt.publish(topic, JSON.stringify(msg));
}

/** 经握手服务器转发的「乒」：收到对方的就原样回给他，收到自己的就记往返时间 */
function onRelay(m: { k: 'p' | 'q' | 's'; s: number; t: number }): void {
  if (m.k === 'p')
    mqtt.publish(topicRelay(room, other), JSON.stringify({ k: 'q', s: m.s, t: m.t }));
  else if (m.k === 'q') relay.back(m.s, m.t);
  else broker.back(m.s, m.t);
}

/** 每秒发一个给自己的「乒」，测本机到握手服务器的往返 */
window.setInterval(() => {
  if (state.brokerOk)
    mqtt.publish(topicRelay(room, role), JSON.stringify({ ...broker.next(), k: 's' }));
}, 1000);

/** 知道对方在了：开始经握手服务器转发来回「乒」 */
function startRelay(): void {
  if (relayTimer) return;
  log('relay', '开始测经握手服务器转发的延迟');
  relayTimer = window.setInterval(() => {
    if (state.brokerOk) mqtt.publish(topicRelay(room, other), JSON.stringify(relay.next()));
  }, RELAY_PING_MS);
}

/** 加入的一方：每 2 秒打一次招呼，直到收到对方的连接信息 */
let helloTimer = 0;
function sayHello(): void {
  window.clearInterval(helloTimer);
  const hello = () => {
    if (pc) return;
    send(topicHost(room), { type: 'hello', session });
  };
  hello();
  helloTimer = window.setInterval(hello, 2000);
}

async function handle(msg: NetSignal): Promise<void> {
  if (role === 'host') {
    if (msg.type === 'hello') {
      // 对方刷新了页面：丢掉旧连接重新握手
      if (pc && msg.session === pcSession) return;
      state.peerSeen = true;
      log('peer', '对方加入了房间');
      startRelay();
      await startHost(msg.session);
    } else if (msg.type === 'answer' && pc && msg.session === pcSession) {
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      state.theirs = parseCandidates(msg.sdp);
      log('exchanged', '交换完连接信息，开始尝试直连');
      armConnectTimeout();
    }
  } else if (msg.type === 'host-here') {
    if (!state.connected) sayHello();
  } else if (msg.type === 'offer' && msg.session === session && !pc) {
    state.peerSeen = true;
    log('peer', '找到了房间');
    startRelay();
    await startGuest(msg.sdp);
  }
  render();
}

function newPeer(): RTCPeerConnection {
  resetPeer();
  const p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  p.addEventListener('connectionstatechange', () => {
    if (p !== pc) return;
    if (p.connectionState === 'connected') {
      state.connected = true;
      state.failed = false;
      window.clearTimeout(connectTimer);
      log('connected', '直连成功');
    } else if (p.connectionState === 'failed') {
      state.failed = true;
      log('failed', '直连失败');
    } else if (p.connectionState === 'disconnected' && state.connected) {
      log('lost', '直连断了（对方关了页面或网络断了）');
    }
    render();
  });
  return p;
}

function resetPeer(): void {
  window.clearInterval(pingTimer);
  window.clearTimeout(connectTimer);
  fast?.close();
  pc?.close();
  pc = null;
  fast = null;
  state.connected = false;
  state.failed = false;
  state.path = null;
  direct.reset();
}

async function startHost(guestSession: string): Promise<void> {
  const p = newPeer();
  pc = p;
  pcSession = guestSession;
  useChannel(p.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
  await p.setLocalDescription(await p.createOffer());
  await waitIceGathering(p, 5000);
  if (p !== pc) return;
  noteLocalCandidates();
  send(topicGuest(room), { type: 'offer', session: guestSession, sdp: p.localDescription!.sdp });
}

async function startGuest(offerSdp: string): Promise<void> {
  const p = newPeer();
  pc = p;
  pcSession = session;
  window.clearInterval(helloTimer);
  p.addEventListener('datachannel', (e) => useChannel(e.channel));
  await p.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  state.theirs = parseCandidates(offerSdp);
  await p.setLocalDescription(await p.createAnswer());
  await waitIceGathering(p, 5000);
  if (p !== pc) return;
  noteLocalCandidates();
  send(topicHost(room), { type: 'answer', session, sdp: p.localDescription!.sdp });
  log('exchanged', '交换完连接信息，开始尝试直连');
  armConnectTimeout();
}

function armConnectTimeout(): void {
  window.clearTimeout(connectTimer);
  connectTimer = window.setTimeout(() => {
    if (state.connected) return;
    state.failed = true;
    log('failed', `${CONNECT_TIMEOUT_MS / 1000} 秒还没直连上，算打不通`);
    render();
  }, CONNECT_TIMEOUT_MS);
}

/** 本机的连接信息：拿没拿到公网地址（从哪个 STUN）、有哪些地址 */
function noteLocalCandidates(): void {
  state.gatheredLocal = true;
  if (pc?.localDescription) state.mine = parseCandidates(pc.localDescription.sdp);
  void pc?.getStats().then((stats) => {
    stats.forEach((s) => {
      if (s.type === 'local-candidate' && s.candidateType === 'srflx' && s.url) {
        state.stunOk.add(
          String(s.url)
            .replace(/^stun:/, '')
            .replace(/:\d+$/, '')
        );
      }
    });
    render();
  });
}

// ---------------------------------------------------------------- 直连测延迟

function useChannel(ch: RTCDataChannel): void {
  fast = ch;
  ch.addEventListener('open', () => {
    log('channel', '开始测直连的延迟');
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(() => {
      if (fast?.readyState === 'open') fast.send(JSON.stringify(direct.next()));
    }, PING_MS);
  });
  ch.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as { k: 'p' | 'q'; s: number; t: number };
    if (m.k === 'p') ch.send(JSON.stringify({ k: 'q', s: m.s, t: m.t }));
    else direct.back(m.s, m.t);
  });
}

/** 每秒看一次：选中的是哪条路（局域网 / 穿透 / 中转），试过的路各是什么状态 */
window.setInterval(() => {
  if (!pc) return;
  void pc.getStats().then((stats) => {
    let pairId = '';
    const counts: Record<string, number> = {};
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      if (s.type === 'candidate-pair') counts[s.state] = (counts[s.state] ?? 0) + 1;
    });
    const PAIR_TEXT: Record<string, string> = {
      succeeded: '通',
      failed: '不通',
      'in-progress': '正在试',
      waiting: '排队',
      frozen: '还没试',
    };
    // 直连失败后浏览器会把记录清掉：保留失败前的
    if (Object.keys(counts).length)
      state.pairs = Object.entries(counts)
        .map(([k, n]) => `${PAIR_TEXT[k] ?? k} ${n}`)
        .join('，');
    if (!pairId && state.connected) {
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id;
      });
    }
    const pair = pairId ? stats.get(pairId) : null;
    if (pair && state.connected) {
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      state.localType = local?.candidateType ?? '';
      state.remoteType = remote?.candidateType ?? '';
      state.path = pathKind(state.localType, state.remoteType);
      const addr = `${local?.address ?? ''} ${remote?.address ?? ''}`;
      state.family = addr.includes(':') ? 'IPv6' : /\d+\.\d+\.\d+\.\d+/.test(addr) ? 'IPv4' : '';
    }
    render();
  });
}, 1000);

// ---------------------------------------------------------------- 画面

function renderRoom(): void {
  if (role === 'host') {
    roomEl.innerHTML = `
      <canvas width="150" height="150"></canvas>
      <div>
        <div>房间码</div>
        <div class="nt-code">${room}</div>
        <div class="nt-link"><input readonly value="${shareLink}" /><button id="copy-link">复制链接</button></div>
        <p class="nt-note">把链接发给另一台电脑（在另一个地方、另一个网络）打开，两边保持这个页面开着。
        身边没有人时，可以用手机关掉 Wi-Fi、用流量扫码打开，大致试一下。</p>
      </div>`;
    void QRCode.toCanvas(roomEl.querySelector('canvas')!, shareLink, { width: 150, margin: 1 });
    roomEl.querySelector('#copy-link')!.addEventListener('click', () => {
      void navigator.clipboard?.writeText(shareLink);
    });
  } else {
    roomEl.innerHTML = `<div><div>加入房间</div><div class="nt-code">${room}</div>
      <p class="nt-note">保持这个页面开着，等连上后看下面的结果</p></div>`;
  }
}

/** 两条路的统计和结论 */
function summary() {
  const d = direct.stats();
  const r = relay.stats();
  const dv: Verdict | null = state.failed
    ? 'fail'
    : state.connected && d.rtt && direct.sent >= MIN_DIRECT
      ? verdict(true, d.rtt, d.loss)
      : null;
  const rv: Verdict | null = r.rtt && relay.sent >= MIN_RELAY ? verdict(true, r.rtt, r.loss) : null;
  // 直连连上了就等直连测满再下结论（转发先测满也不抢先）
  const best = state.connected && !dv ? null : bestPath(dv, rv);
  return { d, r, dv, rv, best };
}

const rttText = (rtt: RttSummary | null, loss: number, sent: number) =>
  rtt
    ? `中位 ${Math.round(rtt.median)} ms，慢的时候 ${Math.round(rtt.p90)} ms，最快 ${Math.round(rtt.min)} ms；丢包 ${(loss * 100).toFixed(1)}%（发了 ${sent} 次）`
    : '—';

/** 本机到握手服务器的往返；太慢多半是开着代理 */
function brokerText(): string {
  const b = summarizeRtt(broker.rtts);
  if (!b) return '—';
  const slow = b.median > SLOW_BROKER_MS;
  return `往返 ${Math.round(b.median)} ms${slow ? '（太慢：电脑上开着代理 / 梯子的话，先关掉或让 emqx.io 直连再测）' : ''}`;
}

function render(): void {
  const { d, r, dv, rv, best } = summary();
  const waiting = !state.peerSeen
    ? '等对方加入…'
    : !state.connected
      ? '正在连接…'
      : `正在测…（还要约 ${Math.max(1, Math.ceil(((MIN_DIRECT - direct.sent) * PING_MS) / 1000))} 秒）`;
  verdictEl.className = `nt-card nt-verdict ${best?.v ?? ''}`;
  if (!best) verdictEl.innerHTML = `<h2>${waiting}</h2>`;
  else if (best.path === 'relay') {
    verdictEl.innerHTML = `<h2>直连不通，可以走转发</h2>
      <p class="nt-note">两边没法直接连上，但经握手服务器转发往返约 ${Math.round(r.rtt!.median)} ms
      （${VERDICT_TEXT[best.v].title}），对打可以改走这条路，不需要自己的服务器</p>`;
  } else {
    verdictEl.innerHTML = `<h2>${VERDICT_TEXT[best.v].title}</h2><p class="nt-note">${VERDICT_TEXT[best.v].note}</p>`;
  }
  const stun = state.stunOk.size
    ? `拿到了（${[...state.stunOk].join('、')}）`
    : state.gatheredLocal
      ? '没拿到（STUN 都连不上，多半打不通）'
      : '—';
  const rows: [string, string][] = [
    ['我是', role === 'host' ? '开房间的一方' : '加入的一方'],
    ['握手服务器', state.brokerOk ? `已连上（${state.broker}）` : '连接中…'],
    ['到握手服务器', brokerText()],
    ['本机公网地址', stun],
    ['本机地址转换', state.mine ? NAT_TEXT[natKind(state.mine)] : '—'],
    ['对方地址转换', state.theirs ? NAT_TEXT[natKind(state.theirs)] : '—'],
    [
      '直连',
      state.path
        ? `${PATH_TEXT[state.path]}${state.family ? `，${state.family}` : ''}（本机 ${state.localType}，对方 ${state.remoteType}）`
        : dv === 'fail'
          ? `打不通（试过的路：${state.pairs || '没有'}）`
          : state.pairs
            ? `正在试（${state.pairs}）`
            : '—',
    ],
    ['直连延迟', rttText(d.rtt, d.loss, direct.sent)],
    [
      '转发延迟',
      `${rttText(r.rtt, r.loss, relay.sent)}${rv ? `（${VERDICT_TEXT[rv].title}）` : ''}`,
    ],
  ];
  statsEl.innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
}

/** 复制给开发者看的结果（带诊断信息和过程） */
function resultText(): string {
  const { d, r, dv, rv, best } = summary();
  const ua = navigator.userAgent;
  const ver = (re: RegExp) => re.exec(ua)?.[1];
  const browser = ver(/Edg\/(\d+)/)
    ? `Edge ${ver(/Edg\/(\d+)/)}`
    : ver(/Chrome\/(\d+)/)
      ? `Chrome ${ver(/Chrome\/(\d+)/)}`
      : ver(/Version\/(\d+).*Safari/)
        ? `Safari ${ver(/Version\/(\d+)/)}`
        : ua.slice(0, 60);
  const os =
    /Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)
      ? 'macOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad/.test(ua)
            ? 'iOS'
            : '其他';
  const conclusion = best
    ? best.path === 'relay'
      ? `直连不通，可以走转发（${VERDICT_TEXT[best.v].title}）`
      : VERDICT_TEXT[best.v].title
    : '还没测完';
  return [
    `联机测试结果（${role === 'host' ? '开房间的一方' : '加入的一方'}，房间 ${room}）`,
    `结论：${conclusion}`,
    `握手服务器：${state.brokerOk ? state.broker : '没连上'}，${brokerText()}`,
    `本机公网地址：${state.stunOk.size ? [...state.stunOk].join('、') : '没拿到'}`,
    `本机地址：${state.mine ? `${describeCandidates(state.mine)}；${NAT_TEXT[natKind(state.mine)]}` : '—'}`,
    `对方地址：${state.theirs ? `${describeCandidates(state.theirs)}；${NAT_TEXT[natKind(state.theirs)]}` : '没收到'}`,
    `直连：${state.path ? `${PATH_TEXT[state.path]}${state.family ? `，${state.family}` : ''}（本机 ${state.localType}，对方 ${state.remoteType}）` : `没连上（试过的路：${state.pairs || '没有'}）`}${dv ? ` → ${VERDICT_TEXT[dv].title}` : ''}`,
    `直连延迟：${rttText(d.rtt, d.loss, direct.sent)}`,
    `转发延迟：${rttText(r.rtt, r.loss, relay.sent)}${rv ? ` → ${VERDICT_TEXT[rv].title}` : ''}`,
    `浏览器：${browser} / ${os}`,
    '过程：',
    ...logLines.map((l) => `  ${l}`),
  ].join('\n');
}

$('copy').addEventListener('click', () => {
  const text = resultText();
  void navigator.clipboard?.writeText(text).then(
    () => ($('copy').textContent = '已复制，发给开发者就行'),
    () => window.prompt('复制下面的结果', text)
  );
});

renderRoom();
render();
window.setInterval(render, 1000);
// 调试 / 冒烟测试用
(window as unknown as { __net: unknown }).__net = {
  state,
  direct,
  relay,
  broker,
  summary,
  resultText,
};
