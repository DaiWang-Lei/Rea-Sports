/**
 * 联机测试页：一方打开就开一个房间（房间码、链接、二维码），另一方打开链接加入。
 * 握手经公共 MQTT 服务器，之后 WebRTC 点对点直连；连上后两边每 0.25 秒互相「乒」一次（不重传的通道，和以后对打一样），
 * 显示往返延迟、丢包、连接方式（局域网 / 穿透 / 中转）、本机能不能拿到公网地址，最后给出结论，可以复制结果发给开发者。
 */
import '@/ui/tv/tokens.css';
import './nettest.css';
import QRCode from 'qrcode';
import { MqttClient } from '@/net/MqttClient';
import {
  lossRate,
  type NetSignal,
  PATH_TEXT,
  type PathKind,
  pathKind,
  summarizeRtt,
  topicGuest,
  topicHost,
  verdict,
  VERDICT_TEXT,
} from '@/net/netTest';
import { ICE_SERVERS, isValidRoom, randomCode, waitIceGathering } from '@/net/signal';

const PING_MS = 250;
/** 超过这么久没回来的「乒」算丢了 */
const LOST_MS = 2000;
/** 统计最近这么多次往返 */
const KEEP = 240;
/** 交换完连接信息后这么久还没连上，算打不通 */
const CONNECT_TIMEOUT_MS = 25000;

const params = new URLSearchParams(location.search);
const joinRoom = params.get('room');
const role: 'host' | 'guest' = isValidRoom(joinRoom) ? 'guest' : 'host';
const room = role === 'guest' ? (joinRoom as string) : randomCode(6);
const session = randomCode(8);
const shareLink = `${location.origin}${location.pathname}?room=${room}`;
const t0 = performance.now();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const roomEl = $('room');
const verdictEl = $('verdict');
const statsEl = $('stats');
const logEl = $('log');

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
  /** 拿到公网地址的 STUN 服务器 */
  stunOk: new Set<string>(),
  gatheredLocal: false,
};
const rtts: number[] = [];
const pending = new Map<number, number>();
let sent = 0;
let answered = 0;
let seq = 0;

let pc: RTCPeerConnection | null = null;
let fast: RTCDataChannel | null = null;
let pcSession = '';
let pingTimer = 0;
let connectTimer = 0;
const logged = new Set<string>();

function log(key: string, text: string): void {
  if (logged.has(key)) return;
  logged.add(key);
  const li = document.createElement('li');
  li.innerHTML = `${text}<small>${((performance.now() - t0) / 1000).toFixed(1)} 秒</small>`;
  logEl.appendChild(li);
}

// ---------------------------------------------------------------- 握手

const mqtt = new MqttClient(`rea-net-${randomCode(10)}`);
mqtt.subscribe(role === 'host' ? topicHost(room) : topicGuest(room));
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
mqtt.onMessage = (_topic, payload) => {
  let msg: NetSignal;
  try {
    msg = JSON.parse(payload) as NetSignal;
  } catch {
    return;
  }
  void handle(msg);
};
mqtt.connect();

function send(topic: string, msg: NetSignal): void {
  mqtt.publish(topic, JSON.stringify(msg));
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
      await startHost(msg.session);
    } else if (msg.type === 'answer' && pc && msg.session === pcSession) {
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      log('exchanged', '交换完连接信息，开始尝试直连');
      armConnectTimeout();
    }
  } else if (msg.type === 'host-here') {
    if (!state.connected) sayHello();
  } else if (msg.type === 'offer' && msg.session === session && !pc) {
    state.peerSeen = true;
    log('peer', '找到了房间');
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
      log('lost', '连接断了（对方关了页面或网络断了）');
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
  rtts.length = 0;
  pending.clear();
  sent = answered = 0;
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
    log('failed', `${CONNECT_TIMEOUT_MS / 1000} 秒还没连上，算打不通`);
    render();
  }, CONNECT_TIMEOUT_MS);
}

/** 从本机的连接信息里看：拿没拿到公网地址（srflx 候选） */
function noteLocalCandidates(): void {
  state.gatheredLocal = true;
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

// ---------------------------------------------------------------- 测延迟

function useChannel(ch: RTCDataChannel): void {
  fast = ch;
  ch.addEventListener('open', () => {
    log('channel', '开始测延迟');
    window.clearInterval(pingTimer);
    pingTimer = window.setInterval(ping, PING_MS);
  });
  ch.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as { k: 'p' | 'q'; s: number; t: number };
    if (m.k === 'p') ch.send(JSON.stringify({ k: 'q', s: m.s, t: m.t }));
    else if (pending.has(m.s)) {
      pending.delete(m.s);
      answered++;
      rtts.push(performance.now() - m.t);
      if (rtts.length > KEEP) rtts.shift();
    }
  });
}

function ping(): void {
  if (!fast || fast.readyState !== 'open') return;
  const now = performance.now();
  seq++;
  sent++;
  pending.set(seq, now);
  fast.send(JSON.stringify({ k: 'p', s: seq, t: now }));
  // 太久没回来的就不等了
  for (const [s, t] of pending) if (now - t > LOST_MS * 3) pending.delete(s);
}

/** 还在路上（发出去不到 LOST_MS）的「乒」 */
function inFlight(): number {
  const now = performance.now();
  let n = 0;
  for (const t of pending.values()) if (now - t < LOST_MS) n++;
  return n;
}

/** 每秒看一次选中的是哪条路（局域网 / 穿透 / 中转） */
window.setInterval(() => {
  if (!pc || !state.connected) return;
  void pc.getStats().then((stats) => {
    let pairId = '';
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    if (!pairId) {
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id;
      });
    }
    const pair = pairId ? stats.get(pairId) : null;
    if (!pair) return;
    state.localType = stats.get(pair.localCandidateId)?.candidateType ?? '';
    state.remoteType = stats.get(pair.remoteCandidateId)?.candidateType ?? '';
    state.path = pathKind(state.localType, state.remoteType);
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

function summary() {
  const rtt = summarizeRtt(rtts);
  const loss = lossRate(sent, answered, inFlight());
  const connected = state.connected && !!rtt;
  const v = state.failed ? 'fail' : connected ? verdict(true, rtt, loss) : null;
  return { rtt, loss, v };
}

function render(): void {
  const { rtt, loss, v } = summary();
  const waiting = !state.peerSeen ? '等对方加入…' : !state.connected ? '正在连接…' : '正在测…';
  verdictEl.className = `nt-card nt-verdict ${v ?? ''}`;
  verdictEl.innerHTML = v
    ? `<h2>${VERDICT_TEXT[v].title}</h2><p class="nt-note">${VERDICT_TEXT[v].note}</p>`
    : `<h2>${waiting}</h2>`;
  const stun = state.stunOk.size
    ? `拿到了（${[...state.stunOk].join('、')}）`
    : state.gatheredLocal
      ? '没拿到（STUN 都连不上，多半打不通）'
      : '—';
  const rows: [string, string][] = [
    ['我是', role === 'host' ? '开房间的一方' : '加入的一方'],
    ['握手服务器', state.brokerOk ? `已连上（${state.broker}）` : '连接中…'],
    ['本机公网地址', stun],
    [
      '连接方式',
      state.path
        ? `${PATH_TEXT[state.path]}（本机 ${state.localType}，对方 ${state.remoteType}）`
        : '—',
    ],
    [
      '往返延迟',
      rtt
        ? `中位 ${Math.round(rtt.median)} ms，慢的时候 ${Math.round(rtt.p90)} ms，最快 ${Math.round(rtt.min)} ms`
        : '—',
    ],
    ['丢包', sent ? `${(loss * 100).toFixed(1)}%（发了 ${sent} 次）` : '—'],
  ];
  statsEl.innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
}

/** 复制给开发者看的结果 */
function resultText(): string {
  const { rtt, loss, v } = summary();
  const ua = navigator.userAgent;
  const browser = /Edg\/(\d+)/.exec(ua)
    ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua)
      ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
      : /Version\/(\d+).*Safari/.exec(ua)
        ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
        : ua.slice(0, 60);
  const os = /Mac OS X/.test(ua)
    ? 'macOS'
    : /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : '其他';
  return [
    `联机测试结果（${role === 'host' ? '开房间的一方' : '加入的一方'}，房间 ${room}）`,
    `结论：${v ? VERDICT_TEXT[v].title : '还没测完'}`,
    `握手服务器：${state.brokerOk ? state.broker : '没连上'}`,
    `本机公网地址：${state.stunOk.size ? [...state.stunOk].join('、') : '没拿到'}`,
    `连接方式：${state.path ? `${PATH_TEXT[state.path]}（本机 ${state.localType}，对方 ${state.remoteType}）` : '没连上'}`,
    `往返延迟：${rtt ? `中位 ${Math.round(rtt.median)}ms，慢的时候 ${Math.round(rtt.p90)}ms，最快 ${Math.round(rtt.min)}ms（${rtt.count} 次）` : '—'}`,
    `丢包：${(loss * 100).toFixed(1)}%（发了 ${sent} 次）`,
    `浏览器：${browser} / ${os}`,
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
(window as unknown as { __net: unknown }).__net = { state, rtts, summary };
