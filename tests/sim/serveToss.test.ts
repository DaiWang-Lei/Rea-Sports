import { describe, expect, it } from 'vitest';
import { defaultTuning } from '@/config/tuning';
import { TOSS } from '@/input/paddle/TossDetector';
import { ballState } from '@/sim/ball/physics';
import { planToss, tossSpeed } from '@/sim/players/serveToss';
import { vec3 } from '@/core/vec3';

/** 从手上（台面以上 18cm）抛 height 米：到最高点、到理想击球点各要多久，最高点离手多高 */
const toss = (height: number) => {
  const tune = defaultTuning();
  const hand = vec3(0.3, -1.6, 0.76 + 0.18);
  const plan = planToss(ballState(hand, vec3(0, 0, tossSpeed(height, tune))), 0, tune);
  return { apex: plan.apex, ideal: plan.ideal, top: plan.at.p.z };
};

describe('发球抛球（像 WSR 那样放慢）', () => {
  it('按键抛球约 1.2 秒到理想击球点，最高点在手上方 1 米左右', () => {
    const t = toss(defaultTuning().serve.buttonTossHeight);
    expect(t.ideal).toBeGreaterThan(1.12);
    expect(t.ideal).toBeLessThan(1.28);
    expect(t.apex).toBeGreaterThan(0.5);
  });

  it('电脑抛球 1.15–1.3 秒；用力抖手柄最多约 1.35 秒', () => {
    const sv = defaultTuning().serve;
    expect(toss(sv.cpuTossMin).ideal).toBeGreaterThan(1.1);
    expect(toss(sv.cpuTossMax).ideal).toBeLessThan(1.32);
    expect(toss(TOSS.hMax).ideal).toBeLessThan(1.42);
  });
});
