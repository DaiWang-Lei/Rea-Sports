import { describe, expect, it } from 'vitest';
import {
  bestPath,
  lossRate,
  natKind,
  parseCandidates,
  pathKind,
  summarizeRtt,
  verdict,
} from '@/net/netTest';

describe('联机测试', () => {
  it('连接方式：两边都是本机地址 = 局域网，有中转 = 中转，其余是穿透直连', () => {
    expect(pathKind('host', 'host')).toBe('lan');
    expect(pathKind('srflx', 'prflx')).toBe('p2p');
    expect(pathKind('host', 'srflx')).toBe('p2p');
    expect(pathKind('relay', 'srflx')).toBe('relay');
  });

  it('往返延迟的中位、慢的时候（九成）、最快', () => {
    const s = summarizeRtt([40, 42, 41, 45, 90, 43, 44, 41, 42, 120])!;
    expect(s.median).toBe(43);
    expect(s.p90).toBe(120);
    expect(s.min).toBe(40);
    expect(summarizeRtt([])).toBeNull();
  });

  it('丢包：还在路上的不算', () => {
    expect(lossRate(100, 95, 3)).toBeCloseTo(2 / 97);
    expect(lossRate(2, 0, 2)).toBe(0);
  });

  it('结论：低延迟少丢包适合对打，150ms 以内可以玩，再多偏高，没连上算打不通', () => {
    const r = (median: number, p90: number) => ({ count: 50, median, p90, min: median - 5 });
    expect(verdict(true, r(45, 60), 0)).toBe('good');
    expect(verdict(true, r(110, 140), 0.01)).toBe('ok');
    expect(verdict(true, r(220, 300), 0)).toBe('slow');
    expect(verdict(true, r(45, 60), 0.2)).toBe('slow');
    expect(verdict(false, null, 0)).toBe('fail');
  });
});

describe('联机测试：诊断', () => {
  const sdp = (lines: string[]) => ['v=0', ...lines.map((l) => `a=candidate:${l}`)].join('\r\n');

  it('解析连接信息里的地址：本机（隐藏的 / IPv4 / IPv6）、公网地址（去重）、中转', () => {
    const c = parseCandidates(
      sdp([
        '1 1 udp 2122260223 4b1f-abcd.local 54321 typ host generation 0',
        '2 1 udp 2122262783 2408:8207::1 54322 typ host generation 0',
        '3 1 udp 1686052607 1.2.3.4 40001 typ srflx raddr 0.0.0.0 rport 0',
        '3 1 udp 1686052607 1.2.3.4 40001 typ srflx raddr 0.0.0.0 rport 0',
        '4 1 tcp 1518280447 4b1f-abcd.local 9 typ host tcptype active',
        '5 2 udp 1686052606 1.2.3.4 40002 typ srflx raddr 0.0.0.0 rport 0',
      ])
    );
    expect(c.host).toEqual({ mdns: 1, v4: 0, v6: 1 });
    expect(c.srflx.v4).toEqual(['1.2.3.4:40001']);
    expect(natKind(c)).toBe('cone');
  });

  it('问不同的地址服务给出不同的公网端口 = 对称型（很难打洞）；没拿到公网地址 = 不知道', () => {
    const sym = parseCandidates(
      sdp([
        '3 1 udp 1686052607 1.2.3.4 40001 typ srflx raddr 0.0.0.0 rport 0',
        '6 1 udp 1686052607 1.2.3.4 40917 typ srflx raddr 0.0.0.0 rport 0',
      ])
    );
    expect(natKind(sym)).toBe('symmetric');
    // 两块网卡各问出一个公网端口：不算对称型
    const twoNics = parseCandidates(
      sdp([
        '1 1 udp 2122260223 a.local 50001 typ host',
        '2 1 udp 2122260223 b.local 50002 typ host',
        '3 1 udp 1686052607 1.2.3.4 40001 typ srflx raddr 0.0.0.0 rport 0',
        '6 1 udp 1686052607 1.2.3.4 40917 typ srflx raddr 0.0.0.0 rport 0',
      ])
    );
    expect(natKind(twoNics)).toBe('cone');
    expect(natKind(parseCandidates(sdp(['1 1 udp 1 x.local 1 typ host'])))).toBe('unknown');
  });

  it('直连可以就用直连；直连不通但转发可以就走转发', () => {
    expect(bestPath('good', 'ok')).toEqual({ path: 'direct', v: 'good' });
    expect(bestPath('fail', 'ok')).toEqual({ path: 'relay', v: 'ok' });
    expect(bestPath('fail', 'slow')).toEqual({ path: 'direct', v: 'fail' });
    expect(bestPath(null, null)).toBeNull();
  });
});
