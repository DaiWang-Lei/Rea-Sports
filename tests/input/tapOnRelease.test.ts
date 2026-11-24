import { describe, expect, it } from 'vitest';
import { TapOnRelease } from '@/input/types';

describe('松开才算的键（切换人数的 X）', () => {
  it('按下、松开算一次；按住不算', () => {
    const k = new TapOnRelease();
    expect(k.update(true, false)).toBe(false);
    expect(k.update(true, false)).toBe(false);
    expect(k.update(false, false)).toBe(true);
    expect(k.update(false, false)).toBe(false);
  });

  it('按住期间按过 ZR（校准组合键 X + ZR）不算，ZR 先按住再按 X 也不算', () => {
    const k = new TapOnRelease();
    k.update(true, false);
    k.update(true, true);
    expect(k.update(false, false)).toBe(false);
    k.update(true, true);
    expect(k.update(false, true)).toBe(false);
    // 下一次干净的按一下照常算
    k.update(true, false);
    expect(k.update(false, false)).toBe(true);
  });
});
