/**
 * 极简 MQTT 3.1.1 报文编解码（只用 QoS 0：CONNECT / SUBSCRIBE / PUBLISH / PING / DISCONNECT）。
 * 只用于 WebRTC 握手消息，量很小；纯函数，便于测试。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PacketType = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
} as const;

/** 剩余长度：每字节 7 位，最高位表示后面还有 */
export function encodeRemainingLength(n: number): number[] {
  const out: number[] = [];
  let x = n;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    out.push(byte);
  } while (x > 0);
  return out;
}

/** 从 buf[offset] 开始解剩余长度；数据不够时返回 null */
export function decodeRemainingLength(
  buf: Uint8Array,
  offset: number
): { value: number; bytes: number } | null {
  let value = 0;
  let mult = 1;
  for (let i = 0; i < 4; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    value += (b & 0x7f) * mult;
    if ((b & 0x80) === 0) return { value, bytes: i + 1 };
    mult *= 128;
  }
  throw new Error('MQTT 剩余长度格式错误');
}

function str(s: string): number[] {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function packet(header: number, body: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([header, ...encodeRemainingLength(body.length), ...body]);
}

export function connectPacket(clientId: string, keepaliveSec: number): Uint8Array<ArrayBuffer> {
  const body = [
    ...str('MQTT'),
    4, // 协议级别 3.1.1
    0x02, // clean session
    keepaliveSec >> 8,
    keepaliveSec & 0xff,
    ...str(clientId),
  ];
  return packet(PacketType.CONNECT << 4, body);
}

export function subscribePacket(packetId: number, topic: string): Uint8Array<ArrayBuffer> {
  return packet((PacketType.SUBSCRIBE << 4) | 0x02, [
    packetId >> 8,
    packetId & 0xff,
    ...str(topic),
    0,
  ]);
}

export function publishPacket(topic: string, payload: string): Uint8Array<ArrayBuffer> {
  return packet(PacketType.PUBLISH << 4, [...str(topic), ...enc.encode(payload)]);
}

export const PINGREQ = new Uint8Array([PacketType.PINGREQ << 4, 0]);
export const DISCONNECT = new Uint8Array([PacketType.DISCONNECT << 4, 0]);

export type MqttPacket =
  | { type: 'connack'; returnCode: number }
  | { type: 'publish'; topic: string; payload: string }
  | { type: 'suback'; packetId: number }
  | { type: 'pingresp' }
  | { type: 'other'; packetType: number };

/**
 * 从缓冲区里尽量多地解出完整报文，返回报文列表和已消费的字节数（剩下的留给下一次）。
 */
export function parsePackets(buf: Uint8Array): { packets: MqttPacket[]; consumed: number } {
  const packets: MqttPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    const rl = decodeRemainingLength(buf, off + 1);
    if (!rl) break;
    const start = off + 1 + rl.bytes;
    const end = start + rl.value;
    if (end > buf.length) break;
    const header = buf[off];
    const t = header >> 4;
    const body = buf.subarray(start, end);
    switch (t) {
      case PacketType.CONNACK:
        packets.push({ type: 'connack', returnCode: body[1] ?? 255 });
        break;
      case PacketType.PUBLISH: {
        const qos = (header >> 1) & 0x03;
        const tlen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        const payloadStart = 2 + tlen + (qos > 0 ? 2 : 0);
        packets.push({ type: 'publish', topic, payload: dec.decode(body.subarray(payloadStart)) });
        break;
      }
      case PacketType.SUBACK:
        packets.push({ type: 'suback', packetId: (body[0] << 8) | body[1] });
        break;
      case PacketType.PINGRESP:
        packets.push({ type: 'pingresp' });
        break;
      default:
        packets.push({ type: 'other', packetType: t });
    }
    off = end;
  }
  return { packets, consumed: off };
}
