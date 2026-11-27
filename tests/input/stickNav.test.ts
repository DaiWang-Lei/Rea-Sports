import { describe, expect, it } from 'vitest';
import { parseStickCalibration, StickNav } from '@/input/joycon/stickNav';

describe('摇杆 → 菜单方向', () => {
  const settle = (n: StickNav, cx = 2050, cy = 2040) => {
    for (let i = 0; i < 10; i++) expect(n.update(cx, cy)).toBeUndefined();
  };

  it('先用最初的读数定中心；推过一半算按下，回到三成以内才算松开', () => {
    const n = new StickNav();
    settle(n);
    expect(n.update(2050 + 500, 2040)).toBeUndefined(); // 推了 0.38：还不算
    expect(n.update(2050 + 800, 2040)).toBe('right');
    expect(n.update(2050 + 500, 2040)).toBeUndefined(); // 中间区域：还按着
    expect(n.update(2050 + 300, 2040)).toBeNull(); // 回到 0.23：松开
    expect(n.update(2050, 2040 - 900)).toBe('down');
    expect(n.update(2050, 2040 + 900)).toBe('up');
  });

  it('推的方向转到另一个轴：换成新方向', () => {
    const n = new StickNav();
    settle(n);
    expect(n.update(2050, 2040 + 900)).toBe('up');
    expect(n.update(2050 - 1100, 2040 + 300)).toBe('left');
  });
});

/** 6 个 12 位数打包成 SPI 里的 9 字节 */
const pack = (v: number[]): Uint8Array => {
  const b = new Uint8Array(9);
  for (let i = 0; i < 3; i++) {
    const [a, c] = [v[2 * i], v[2 * i + 1]];
    b[3 * i] = a & 0xff;
    b[3 * i + 1] = ((a >> 8) & 0x0f) | ((c & 0x0f) << 4);
    b[3 * i + 2] = c >> 4;
  }
  return b;
};

describe('摇杆校准（SPI）', () => {
  it('左摇杆：往上、中心、往下；右摇杆：中心、往下、往上', () => {
    const l = parseStickCalibration(pack([1500, 1400, 2010, 1980, 1450, 1350]), 'L');
    expect(l).toEqual({ above: [1500, 1400], center: [2010, 1980], below: [1450, 1350] });
    const r = parseStickCalibration(pack([2100, 1900, 1300, 1250, 1600, 1550]), 'R');
    expect(r).toEqual({ center: [2100, 1900], below: [1300, 1250], above: [1600, 1550] });
  });

  it('用户校准要有魔数；闪存没写过（0xFF）算没有', () => {
    const body = pack([1500, 1400, 2010, 1980, 1450, 1350]);
    const user = new Uint8Array([0xb2, 0xa1, ...body]);
    expect(parseStickCalibration(user, 'L', true)?.center).toEqual([2010, 1980]);
    expect(parseStickCalibration(new Uint8Array([0xff, 0xff, ...body]), 'L', true)).toBeNull();
    expect(parseStickCalibration(new Uint8Array(9).fill(0xff), 'L')).toBeNull();
  });

  it('有校准就不用最初的读数定中心，两边按各自的行程算', () => {
    const n = new StickNav();
    n.calibrate({ center: [1800, 2200], above: [1000, 1400], below: [1600, 1200] });
    expect(n.update(1800 + 450, 2200)).toBeUndefined(); // 0.45：还不算
    expect(n.update(1800 + 600, 2200)).toBe('right'); // 0.6
    expect(n.update(1800, 2200)).toBeNull();
    expect(n.update(1800 - 700, 2200)).toBeUndefined(); // 往左只有 0.44
    expect(n.update(1800 - 900, 2200)).toBe('left');
  });
});
