import { describe, expect, it } from 'vitest';
import { lossRate, pathKind, summarizeRtt, verdict } from '@/net/netTest';

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
