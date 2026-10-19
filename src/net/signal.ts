/**
 * WebRTC 握手（信令）约定。握手消息经公共 MQTT 服务器转发，体感数据走 WebRTC 直连（同一 Wi-Fi 内点对点）。
 *
 * 主题（room 为电脑页面生成的随机房间号）：
 *   rea-sports/v1/<room>/game         手机 → 电脑：hello、answer、bye
 *   rea-sports/v1/<room>/phone/<id>   电脑 → 某台手机：offer
 *   rea-sports/v1/<room>/phones       电脑 → 所有手机：game-here（电脑上线/重连，等待中的手机重新打招呼）
 *
 * 电脑发起（offer），手机应答（answer）；两条数据通道：
 *   imu  不保序、不重传（体感样本，丢了就丢了，避免排队卡顿）
 *   ctl  可靠（按键、设备信息、震动、ping）
 * session 是手机每次打开页面时生成的随机串，用来区分「同一台手机刷新了页面」。
 */

export type SignalMessage =
  | { type: 'hello'; id: string; name: string; session: string }
  | { type: 'answer'; id: string; session: string; sdp: string }
  | { type: 'bye'; id: string; session: string }
  | { type: 'offer'; session: string; sdp: string }
  | { type: 'game-here' };

const BASE = 'rea-sports/v1';

export const topicGame = (room: string) => `${BASE}/${room}/game`;
export const topicPhone = (room: string, id: string) => `${BASE}/${room}/phone/${id}`;
export const topicPhones = (room: string) => `${BASE}/${room}/phones`;

/** 国内能用的 STUN 在前（同一 Wi-Fi 下一般用不到，作为局域网 mDNS 不通时的后备） */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/** 等 ICE 候选收集完（局域网很快），最多等 timeoutMs */
export function waitIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    pc.addEventListener('icegatheringstatechange', check);
    const timer = setTimeout(done, timeoutMs);
  });
}

/** 去掉容易看错的字符（0/O、1/I/L） */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomCode(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export function isValidRoom(room: string | null): room is string {
  return !!room && /^[a-z0-9]{4,16}$/.test(room);
}
