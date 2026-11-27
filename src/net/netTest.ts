/**
 * 联机测试（纯逻辑）：两台电脑经公共 MQTT 服务器交换握手、WebRTC 点对点直连，看能不能连上、延迟多少、丢多少包，
 * 决定远程对打能不能不用自己的服务器做。页面见 src/nettest/。
 *
 * 主题（room 为开房间的一方生成的随机房间码）：
 *   rea-sports/v1/net/<room>/host    加入的一方 → 开房间的一方：hello、answer
 *   rea-sports/v1/net/<room>/guest   开房间的一方 → 加入的一方：offer、host-here（上线 / 重连，请对方重新打招呼）
 * session 是加入的一方每次打开页面生成的随机串：刷新页面后开房间的一方丢掉旧连接、重新握手。
 *
 * 直连之外，同时经握手服务器转发来回「乒」（各自订阅自己的转发主题）：直连打不通时，对打数据可以改走这条路，
 * 不需要自己的服务器，只是多绕一道
 *   rea-sports/v1/net/<room>/relay/host、.../relay/guest
 */

export type NetSignal =
  | { type: 'hello'; session: string }
  | { type: 'offer'; session: string; sdp: string }
  | { type: 'answer'; session: string; sdp: string }
  | { type: 'host-here' };

const BASE = 'rea-sports/v1/net';
export const topicHost = (room: string) => `${BASE}/${room}/host`;
export const topicGuest = (room: string) => `${BASE}/${room}/guest`;
export const topicRelay = (room: string, to: 'host' | 'guest') => `${BASE}/${room}/relay/${to}`;

/** 一份连接信息（SDP）里给出的地址：本机地址（mDNS 隐藏的 / IPv4 / IPv6）、公网地址（去重后）、中转地址 */
export interface CandidateSummary {
  host: { mdns: number; v4: number; v6: number };
  srflx: { v4: string[]; v6: string[] };
  relay: number;
}

export function parseCandidates(sdp: string): CandidateSummary {
  const out: CandidateSummary = {
    host: { mdns: 0, v4: 0, v6: 0 },
    srflx: { v4: [], v6: [] },
    relay: 0,
  };
  const seen = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    // a=candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
    const m = /^a=candidate:\S+ (\d+) (\S+) \d+ (\S+) (\d+) typ (\S+)/.exec(line);
    if (!m || m[1] !== '1' || m[2].toLowerCase() !== 'udp') continue;
    const [, , , address, port, type] = m;
    const key = `${type} ${address} ${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v6 = address.includes(':');
    if (type === 'host') {
      if (address.endsWith('.local')) out.host.mdns++;
      else if (v6) out.host.v6++;
      else out.host.v4++;
    } else if (type === 'srflx' || type === 'prflx') {
      out.srflx[v6 ? 'v6' : 'v4'].push(`${address}:${port}`);
    } else if (type === 'relay') out.relay++;
  }
  return out;
}

/**
 * 地址转换类型（打洞难易）：问不同的地址服务（STUN）时，同一个出口给出不同的公网端口 = 对称型（端口跟着目标变，
 * 两边都在路由器后面时很难直连，手机流量大多是这种）；给出同一个端口 = 普通型；没拿到公网地址 = 不知道
 */
export type NatKind = 'cone' | 'symmetric' | 'unknown';

export function natKind(c: CandidateSummary): NatKind {
  const fams = [c.srflx.v4, c.srflx.v6].filter((l) => l.length > 0);
  if (!fams.length) return 'unknown';
  // 每个本机地址（网卡）各问一遍，所以公网地址比本机地址多才说明端口跟着目标变
  const bases = Math.max(1, c.host.mdns + c.host.v4 + c.host.v6);
  return fams.some((l) => l.length > bases) ? 'symmetric' : 'cone';
}

/** 到握手服务器往返超过这么久（毫秒），多半是经过了代理（梯子）绕到国外再回来 */
export const SLOW_BROKER_MS = 250;

export const NAT_TEXT: Record<NatKind, string> = {
  cone: '普通型（容易打洞）',
  symmetric: '对称型（端口跟着目标变，很难打洞）',
  unknown: '不知道（没拿到公网地址）',
};

/** 地址一览，给人看 */
export function describeCandidates(c: CandidateSummary): string {
  const parts: string[] = [];
  const h = c.host;
  if (h.mdns + h.v4 + h.v6)
    parts.push(
      `本机地址 ${[h.mdns && `${h.mdns} 个隐藏的`, h.v4 && `${h.v4} 个 IPv4`, h.v6 && `${h.v6} 个 IPv6`].filter(Boolean).join('、')}`
    );
  const n4 = c.srflx.v4.length;
  const n6 = c.srflx.v6.length;
  parts.push(
    n4 + n6
      ? `公网地址 ${[n4 && `IPv4 ${n4} 个`, n6 && `IPv6 ${n6} 个`].filter(Boolean).join('、')}`
      : '没有公网地址'
  );
  if (c.relay) parts.push(`中转 ${c.relay} 个`);
  return parts.join('，');
}

/** 连接方式：同一个局域网直连 / 穿过路由器直连 / 经中转服务器 */
export type PathKind = 'lan' | 'p2p' | 'relay';

/** 由选中的候选对（本机、对方的候选类型：host / srflx / prflx / relay）判断连接方式 */
export function pathKind(local: string, remote: string): PathKind {
  if (local === 'relay' || remote === 'relay') return 'relay';
  if (local === 'host' && remote === 'host') return 'lan';
  return 'p2p';
}

export const PATH_TEXT: Record<PathKind, string> = {
  lan: '局域网直连',
  p2p: '穿透直连（不经过服务器）',
  relay: '经中转服务器',
};

export interface RttSummary {
  count: number;
  median: number;
  /** 九成的往返都比这快 */
  p90: number;
  min: number;
}

export function summarizeRtt(samples: readonly number[]): RttSummary | null {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const at = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { count: s.length, median: at(0.5), p90: at(0.9), min: s[0] };
}

/** 丢包率：发出去、超时还没回来的占比（还在路上的不算） */
export function lossRate(sent: number, answered: number, inFlight: number): number {
  const due = sent - inFlight;
  return due > 0 ? Math.max(0, (due - answered) / due) : 0;
}

export type Verdict = 'good' | 'ok' | 'slow' | 'fail';

/**
 * 结论：远程对打里每个人的击球在自己电脑上判定，对方晚收到半个往返，球在开头几帧快进追上。
 * 单程 40ms 以内（往返 80ms）几乎看不出来，75ms 以内（往返 150ms）球会略微一跳，再多就明显了；丢包多了球会不时卡一下
 */
export function verdict(connected: boolean, rtt: RttSummary | null, loss: number): Verdict {
  if (!connected || !rtt) return 'fail';
  if (rtt.median <= 80 && rtt.p90 <= 120 && loss <= 0.02) return 'good';
  if (rtt.median <= 150 && loss <= 0.05) return 'ok';
  return 'slow';
}

/** 直连打不通、或者转发比直连好时，看能不能走握手服务器转发 */
export function bestPath(
  direct: Verdict | null,
  relay: Verdict | null
): { path: 'direct' | 'relay'; v: Verdict } | null {
  const rank: Record<Verdict, number> = { good: 3, ok: 2, slow: 1, fail: 0 };
  if (direct && rank[direct] >= rank.ok) return { path: 'direct', v: direct };
  if (relay && rank[relay] >= rank.ok) return { path: 'relay', v: relay };
  if (direct) return { path: 'direct', v: direct };
  return null;
}

export const VERDICT_TEXT: Record<Verdict, { title: string; note: string }> = {
  good: { title: '适合远程对打', note: '直连、延迟低，对面打过来的球几乎看不出延迟' },
  ok: { title: '可以玩', note: '对面打过来的球开头会稍微快进一下追上延迟，影响不大' },
  slow: {
    title: '延迟偏高',
    note: '能连上，但对面的球会明显跳一下；换个网络（比如不用手机热点）再试试',
  },
  fail: {
    title: '打不通',
    note: '两边的网络之间没法直连，需要中转服务器；可以换个网络（家里的宽带、不用公司网 / 手机热点）再试',
  },
};
