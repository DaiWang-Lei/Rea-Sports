import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MotionState } from '@/input/fusion/MotionState';
import { SWING_PROFILES, SwingDetector, type SwingEvent } from '@/input/paddle/SwingDetector';
import { type ImuRecording, recordingSamples } from '@/input/replay/recording';
import { JoyConStream } from '@/input/joycon/stream';

function load(name: string): ImuRecording {
  return JSON.parse(readFileSync(`fixtures/imu/${name}`, 'utf8')) as ImuRecording;
}

function detect(rec: ImuRecording) {
  const samples = recordingSamples(rec);
  const ms = new MotionState();
  const det = new SwingDetector(
    rec.source === 'phone' ? SWING_PROFILES.phone : SWING_PROFILES.joycon
  );
  const ev: SwingEvent[] = [];
  for (const s of samples) ev.push(...det.process(ms.process(s)));
  return { samples, ev };
}

describe('Joy-Con 报告里的样本顺序', () => {
  it('报告里第 0 个样本是最新的，输出按时间先后', () => {
    const bytes = new Uint8Array(48);
    const dv = new DataView(bytes.buffer);
    dv.setUint8(0, 9);
    // 三个样本的 gx 分别为 300（最新）、200、100（最旧）；加速度给个非零值避免被当成全零
    [300, 200, 100].forEach((gx, i) => {
      dv.setInt16(12 + i * 12 + 4, 2048, true);
      dv.setInt16(12 + i * 12 + 6, gx, true);
    });
    const got: number[] = [];
    const st = new JoyConStream('L', { onSamples: (s) => got.push(...s.map((x) => x.gyro.x)) });
    st.handleReport(0x30, dv, 1000);
    expect(got[0]).toBeLessThan(got[1]);
    expect(got[1]).toBeLessThan(got[2]);
  });

  it('实测录制：按现在的顺序信号连续（总变差明显小于把报告内顺序反过来）', () => {
    const rec = load('joycon-R-beep-forehand.json');
    const s = recordingSamples(rec);
    let tv = 0;
    for (let i = 1; i < s.length; i++) tv += Math.abs(s[i].gyro.z - s[i - 1].gyro.z);
    // 把每 3 个反过来
    const r = [];
    for (let i = 0; i + 2 < s.length; i += 3) r.push(s[i + 2], s[i + 1], s[i]);
    let tvRev = 0;
    for (let i = 1; i < r.length; i++) tvRev += Math.abs(r[i].gyro.z - r[i - 1].gyro.z);
    expect(tv).toBeLessThan(tvRev * 0.6);
  });
});

describe('挥拍识别（实测录制）', () => {
  for (const [file, maxErr] of [
    ['joycon-R-beep-forehand.json', 15],
    ['iphone-beep-forehand.json', 25],
  ] as const) {
    it(`${file}：10 次提示音正手全部快速确认为逆时针（正手），接触时刻预测准确`, () => {
      const rec = load(file);
      const { ev } = detect(rec);
      const peaks = new Map(ev.filter((e) => e.type === 'peak').map((e) => [e.id, e]));
      const markers = rec.markers;
      expect(markers.length).toBe(10);
      const errs: number[] = [];
      for (const m of markers) {
        // 提示音后 1.1 秒内最快的那次确认
        const cands = ev.filter(
          (e) => e.type === 'commit' && e.path === 'fast' && e.t > m.t + 100 && e.t < m.t + 1100
        );
        expect(cands.length).toBeGreaterThan(0);
        const best = cands.reduce((a, b) =>
          a.type === 'commit' && b.type === 'commit' && b.wPeak > a.wPeak ? b : a
        );
        if (best.type !== 'commit') throw new Error('unreachable');
        expect(best.dir).toBe(1);
        const pk = peaks.get(best.id);
        expect(pk).toBeDefined();
        errs.push(Math.abs(best.tContact - pk!.t));
      }
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      expect(mean).toBeLessThan(maxErr);
    });
  }

  it('自由挥拍录制能跑完、确认次数合理', () => {
    for (const f of ['joycon-R-free.json', 'iphone-free.json']) {
      const { samples, ev } = detect(load(f));
      const commits = ev.filter((e) => e.type === 'commit');
      const minutes = (samples[samples.length - 1].t - samples[0].t) / 60000;
      expect(commits.length).toBeGreaterThan(10);
      // 每秒不超过 4 次（引拍、收拍也会被确认，由击球判定按来球过滤）
      expect(commits.length / (minutes * 60)).toBeLessThan(4);
    }
  });
});
