import { describe, expect, it } from 'vitest';
import {
  connectPacket,
  decodeRemainingLength,
  encodeRemainingLength,
  parsePackets,
  publishPacket,
  subscribePacket,
} from '@/net/mqttCodec';

describe('MQTT 编解码', () => {
  it('剩余长度编码（规范里的例子）', () => {
    expect(encodeRemainingLength(0)).toEqual([0x00]);
    expect(encodeRemainingLength(127)).toEqual([0x7f]);
    expect(encodeRemainingLength(128)).toEqual([0x80, 0x01]);
    expect(encodeRemainingLength(16383)).toEqual([0xff, 0x7f]);
    expect(encodeRemainingLength(16384)).toEqual([0x80, 0x80, 0x01]);
    for (const n of [0, 5, 127, 128, 300, 16383, 16384, 2097151, 2097152]) {
      const b = new Uint8Array(encodeRemainingLength(n));
      expect(decodeRemainingLength(b, 0)!.value).toBe(n);
    }
  });

  it('CONNECT 报文格式', () => {
    const p = connectPacket('ab', 30);
    expect(Array.from(p)).toEqual([
      0x10, 14, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x02, 0, 30, 0, 2, 0x61, 0x62,
    ]);
  });

  it('SUBSCRIBE 报文：固定头 0x82、报文 ID、主题、QoS 0', () => {
    const p = subscribePacket(7, 't/x');
    expect(Array.from(p)).toEqual([0x82, 8, 0, 7, 0, 3, 0x74, 0x2f, 0x78, 0]);
  });

  it('PUBLISH 往返（含中文），并能从拼在一起的多个报文里逐个解出', () => {
    const a = publishPacket('房间/1', '{"type":"offer"}');
    const b = new Uint8Array([0x20, 0x02, 0x00, 0x00]); // CONNACK 成功
    const c = publishPacket('t', 'x'.repeat(300)); // 剩余长度需要 2 字节
    const all = new Uint8Array([...a, ...b, ...c]);
    const { packets, consumed } = parsePackets(all);
    expect(consumed).toBe(all.length);
    expect(packets[0]).toEqual({ type: 'publish', topic: '房间/1', payload: '{"type":"offer"}' });
    expect(packets[1]).toEqual({ type: 'connack', returnCode: 0 });
    expect(packets[2]).toEqual({ type: 'publish', topic: 't', payload: 'x'.repeat(300) });
  });

  it('数据不完整时等下一块', () => {
    const a = publishPacket('t', 'hello');
    const { packets, consumed } = parsePackets(a.subarray(0, a.length - 2));
    expect(packets.length).toBe(0);
    expect(consumed).toBe(0);
  });
});
