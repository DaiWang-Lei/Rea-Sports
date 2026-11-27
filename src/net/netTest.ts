/**
 * 联机测试（纯逻辑）：两台电脑经公共 MQTT 服务器交换握手、WebRTC 点对点直连，看能不能连上、延迟多少、丢多少包，
 * 决定远程对打能不能不用自己的服务器做。页面见 src/nettest/。
 *
 * 主题（room 为开房间的一方生成的随机房间码）：
 *   rea-sports/v1/net/<room>/host    加入的一方 → 开房间的一方：hello、answer
 *   rea-sports/v1/net/<room>/guest   开房间的一方 → 加入的一方：offer、host-here（上线 / 重连，请对方重新打招呼）
 * session 是加入的一方每次打开页面生成的随机串：刷新页面后开房间的一方丢掉旧连接、重新握手。
 */

export type NetSignal =
  | { type: 'hello'; session: string }
  | { type: 'offer'; session: string; sdp: string }
  | { type: 'answer'; session: string; sdp: string }
  | { type: 'host-here' };

const BASE = 'rea-sports/v1/net';
export const topicHost = (room: string) => `${BASE}/${room}/host`;
export const topicGuest = (room: string) => `${BASE}/${room}/guest`;

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
