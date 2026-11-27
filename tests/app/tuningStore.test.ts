import { afterEach, describe, expect, it } from 'vitest';
import { CPU_LEVELS } from '@/config/difficulty';
import { defaultTuning, tuning } from '@/config/tuning';
import { TOSS } from '@/input/paddle/TossDetector';
import {
  applyOverrides,
  currentOverrides,
  overrideCount,
  type TuningOverrides,
} from '@/app/shared/tuningStore';

afterEach(() => applyOverrides({}));

describe('手感参数的本地覆盖', () => {
  it('没改过：没有覆盖', () => {
    expect(currentOverrides()).toEqual({});
    expect(overrideCount()).toBe(0);
  });

  it('只记和默认值不同的部分，套用回去得到同样的参数', () => {
    tuning.serve.buttonTossHeight = 1.05;
    tuning.timing.tauMin = -2.5;
    CPU_LEVELS[0].vMax = 3.5;
    TOSS.minG = 1.6;
    const o = currentOverrides();
    expect(o).toEqual({
      tuning: { serve: { buttonTossHeight: 1.05 }, timing: { tauMin: -2.5 } },
      cpu: { '1': { vMax: 3.5 } },
      toss: { minG: 1.6 },
    });
    expect(overrideCount(o)).toBe(4);
    const saved = JSON.parse(JSON.stringify(o)) as TuningOverrides;
    applyOverrides({});
    expect(tuning.serve.buttonTossHeight).toBe(defaultTuning().serve.buttonTossHeight);
    applyOverrides(saved);
    expect(tuning.serve.buttonTossHeight).toBe(1.05);
    expect(CPU_LEVELS[0].vMax).toBe(3.5);
    expect(TOSS.minG).toBe(1.6);
  });

  it('套用前先恢复默认：上一次的改动不会残留', () => {
    applyOverrides({ tuning: { serve: { powerMs: 100 } } });
    applyOverrides({ tuning: { timing: { aimPerTau: 0.5 } } });
    expect(tuning.serve.powerMs).toBe(defaultTuning().serve.powerMs);
    expect(tuning.timing.aimPerTau).toBe(0.5);
  });

  it('导入的文件里不认识的键、非数值、坏的等级都忽略', () => {
    applyOverrides({
      tuning: { serve: { nope: 1, powerMs: Number.NaN }, unknownGroup: { a: 1 } },
      cpu: { '9': { vMax: 9 }, '2': { name: 3 } as never },
      toss: { hMax: 1.7 },
    } as TuningOverrides);
    expect(overrideCount()).toBe(1);
    expect(TOSS.hMax).toBe(1.7);
    expect(CPU_LEVELS[1].name).toBe('初级');
  });
});
