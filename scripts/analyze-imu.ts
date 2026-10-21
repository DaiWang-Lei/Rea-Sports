/**
 * 分析一段 IMU 录制：采样率、间隔、丢包、蓝牙延迟抖动、静止时的加速度、数据顶格、轴向一致性、
 * 以及每一次挥拍（峰值角速度、世界系绕竖直轴的转向 → 正/反手、和提示音的时间差）。
 * 用法：pnpm analyze:imu fixtures/imu/xxx.json [更多文件…]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DEG } from '../src/core/math';
import { rotate } from '../src/core/quat';
import { length, vec3 } from '../src/core/vec3';
import { AxisConsistencyCheck } from '../src/input/diagnostics';
import { MotionState } from '../src/input/fusion/MotionState';
import {
  fromHex,
  type ImuRecording,
  isImuRecording,
  recordingSamples,
} from '../src/input/replay/recording';
import { JoyConStream } from '../src/input/joycon/stream';
import type { ImuSample } from '../src/input/types';

const pct = (values: number[], q: number) => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');

interface ReportInfo {
  arrival: number;
  timer: number;
  newest: number;
  raw: Uint8Array;
}

function loadSamples(rec: ImuRecording): {
  samples: ImuSample[];
  reports: ReportInfo[];
  extra: string[];
} {
  const extra: string[] = [];
  if (rec.source === 'phone' || (rec.samples && rec.samples.length)) {
    // 走统一的回放：旧版手机录制的角速度轴在这里改正
    if (rec.gyroAxes !== 'xyz') extra.push('旧版手机录制：角速度轴已按 x/y/z 约定改正');
    return { samples: recordingSamples(rec), reports: [], extra };
  }
  const samples: ImuSample[] = [];
  const reports: ReportInfo[] = [];
  let current: ReportInfo | null = null;
  const stream = new JoyConStream(rec.side, {
    onSamples: (s) => {
      samples.push(...s);
      if (current) current.newest = s[2].t;
    },
  });
  stream.setCalibration(rec.calibration);
  let subcmdReplies = 0;
  const subcmdAt: number[] = [];
  for (const [id, arrival, hex] of rec.reports) {
    const bytes = fromHex(hex);
    if (id === 0x30) {
      current = { arrival, timer: bytes[0], newest: NaN, raw: bytes };
      reports.push(current);
    } else {
      current = null;
      subcmdReplies++;
      subcmdAt.push(arrival);
    }
    stream.handleReport(id, new DataView(bytes.buffer), arrival);
  }
  const clk = stream.clock.stats();
  extra.push(
    `0x30 报告 ${reports.length} 个，0x21（子命令回复）${subcmdReplies} 个` +
      (subcmdAt.length > 1
        ? `，间隔约 ${f1(
            pct(
              subcmdAt.slice(1).map((t, i) => t - subcmdAt[i]),
              0.5
            )
          )}ms`
        : '')
  );
  extra.push(
    `时钟：报告间隔 ${f2(clk.reportIntervalMs)}ms，样本间隔 ${f2(clk.sampleIntervalMs)}ms，` +
      `计时字节步长 ${clk.timerStep ?? '未学会'}，判定丢包 ${clk.droppedReports}，重新同步 ${clk.resyncs}`
  );
  // 计时字节增量分布，以及「增量 ≠ 3 时，报告里的 3 个样本和上一个报告是否重叠」
  const steps = new Map<number, number>();
  let dupChecked = 0;
  let dupConfirmed = 0;
  for (let i = 1; i < reports.length; i++) {
    const d = (reports[i].timer - reports[i - 1].timer + 256) & 0xff;
    steps.set(d, (steps.get(d) ?? 0) + 1);
    if (d >= 1 && d <= 2) {
      // 若只新增 d 个样本，那么本报告最旧的 (3-d) 个样本应等于上一个报告最新的 (3-d) 个样本
      const overlap = 3 - d;
      let same = true;
      for (let k = 0; k < overlap; k++) {
        const a = reports[i].raw.subarray(12 + k * 12, 24 + k * 12);
        const b = reports[i - 1].raw.subarray(
          12 + (3 - overlap + k) * 12,
          24 + (3 - overlap + k) * 12
        );
        for (let j = 0; j < 12; j++) if (a[j] !== b[j]) same = false;
      }
      dupChecked++;
      if (same) dupConfirmed++;
    }
  }
  extra.push(
    `计时字节增量分布：${[...steps.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => `${k}→${v}次`)
      .join('，')}；增量为 1–2 的报告里样本与上一报告重叠的：${dupConfirmed}/${dupChecked}`
  );
  const lat = reports.filter((r) => Number.isFinite(r.newest)).map((r) => r.arrival - r.newest);
  extra.push(
    `蓝牙到达延迟（相对推算时间）：中位 ${f1(pct(lat, 0.5))}ms，P90 ${f1(pct(lat, 0.9))}ms，` +
      `P99 ${f1(pct(lat, 0.99))}ms，最大 ${f1(pct(lat, 1))}ms；>40ms 的报告占 ${f1((lat.filter((v) => v > 40).length / lat.length) * 100)}%`
  );
  const gaps = reports.slice(1).map((r, i) => r.arrival - reports[i].arrival);
  extra.push(
    `报告到达间隔：中位 ${f1(pct(gaps, 0.5))}ms，P99 ${f1(pct(gaps, 0.99))}ms，最大 ${f1(pct(gaps, 1))}ms`
  );
  return { samples, reports, extra };
}

interface Swing {
  start: number;
  peakT: number;
  end: number;
  peak: number;
  yawSign: number;
  yawOnset: number;
  bodyAxis: string;
  accPeak: number;
  clipped: number;
}

function analyze(file: string): void {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!isImuRecording(rec)) {
    console.log(`${file}: 不是录制文件`);
    return;
  }
  const { samples, extra } = loadSamples(rec);
  console.log(`\n======== ${basename(file)}（${rec.device ?? rec.side}，${rec.note ?? ''}）`);
  if (rec.source !== 'phone') {
    const c = rec.calibration;
    console.log(
      `校准来源 ${c.source}；加速度原点 ${c.accelOrigin.join(',')}；陀螺零点 ${c.gyroOffset.join(',')}；陀螺系数 ${c.gyroCoeff.join(',')}`
    );
  }
  for (const line of extra) console.log(line);
  if (samples.length < 10) return;

  const dur = (samples[samples.length - 1].t - samples[0].t) / 1000;
  const dts = samples.slice(1).map((s, i) => s.t - samples[i].t);
  console.log(
    `样本 ${samples.length} 个，时长 ${f1(dur)}s，平均 ${f1(samples.length / dur)} 次/秒；` +
      `样本间隔 中位 ${f2(pct(dts, 0.5))}ms，P1 ${f2(pct(dts, 0.01))}，P99 ${f2(pct(dts, 0.99))}，最大 ${f2(pct(dts, 1))}ms`
  );
  const clippedGyro = samples.filter((s) =>
    [s.gyro.x, s.gyro.y, s.gyro.z].some((v) => Math.abs(v) >= 1990)
  ).length;
  const clippedAcc = samples.filter((s) =>
    [s.accel.x, s.accel.y, s.accel.z].some((v) => Math.abs(v) >= 15.8)
  ).length;
  const maxGyro = Math.max(...samples.map((s) => length(s.gyro)));
  const maxAcc = Math.max(...samples.map((s) => length(s.accel)));
  console.log(
    `最大角速度 ${f1(maxGyro)}°/s（${f1(maxGyro * DEG)} rad/s），最大加速度 ${f2(maxAcc)}g；顶格样本：陀螺 ${clippedGyro}，加速度 ${clippedAcc}`
  );

  // 轴向一致性
  const axis = new AxisConsistencyCheck();
  for (const s of samples) axis.add(s);
  const ar = axis.result();
  console.log(
    `轴向一致性（两次停稳之间 ${ar.intervals} 次）：` +
      (ar.verdict === 'consistent'
        ? `✓ 一致，推算误差 ${f1(ar.errIdentity)}°`
        : ar.verdict === 'inconsistent'
          ? `✗ 不一致，陀螺轴更像 ${ar.best}（误差 ${f1(ar.errBest)}°，原样 ${f1(ar.errIdentity)}°）`
          : ar.verdict === 'unclear'
            ? `看不出（原样误差 ${f1(ar.errIdentity)}°，最吻合 ${ar.best} ${f1(ar.errBest)}°）`
            : `数据不够（进度 ${Math.round(ar.progress * 100)}%）`)
  );

  // 融合 + 静止段
  const ms = new MotionState();
  const frames = samples.map((s) => {
    const f = ms.process(s);
    return {
      t: f.t,
      w: length(f.gyro),
      wz: f.omegaWorld.z,
      gyro: { ...f.gyro },
      accel: { ...f.accel },
      up: rotate({ w: f.q.w, x: -f.q.x, y: -f.q.y, z: -f.q.z }, vec3(0, 0, 1)),
      clipped: f.clipped,
    };
  });
  // 静止段：|ω| < 0.15 rad/s 连续 ≥ 300ms
  const rests: Array<{ t0: number; t1: number; a: number; up: string }> = [];
  let i0 = -1;
  for (let i = 0; i <= frames.length; i++) {
    const still = i < frames.length && frames[i].w < 0.15;
    if (still && i0 < 0) i0 = i;
    if (!still && i0 >= 0) {
      if (frames[i - 1].t - frames[i0].t >= 300) {
        const seg = samples.slice(i0, i);
        const m = seg.reduce(
          (acc, s) => ({ x: acc.x + s.accel.x, y: acc.y + s.accel.y, z: acc.z + s.accel.z }),
          { x: 0, y: 0, z: 0 }
        );
        const n = seg.length;
        const a = vec3(m.x / n, m.y / n, m.z / n);
        rests.push({
          t0: frames[i0].t,
          t1: frames[i - 1].t,
          a: length(a),
          up: `(${f2(a.x / length(a))}, ${f2(a.y / length(a))}, ${f2(a.z / length(a))})`,
        });
      }
      i0 = -1;
    }
  }
  if (rests.length) {
    console.log(
      `静止段 ${rests.length} 个：|a| = ${rests.map((r) => r.a.toFixed(3)).join(' / ')} g；` +
        `「上」在机体系里的方向：${rests.map((r) => r.up).join(' ')}`
    );
  } else {
    console.log('没有找到 ≥300ms 的静止段');
  }

  // 挥拍：|ω| ≥ 4 rad/s 开始，|ω| < 2.5 持续 3 个样本或超过 450ms 结束
  const swings: Swing[] = [];
  let k = 0;
  while (k < frames.length) {
    if (frames[k].w < 4) {
      k++;
      continue;
    }
    const s0 = k;
    let peak = 0;
    let peakIdx = k;
    let below = 0;
    let accPeak = 0;
    let clipped = 0;
    while (k < frames.length) {
      const fr = frames[k];
      if (fr.w > peak) {
        peak = fr.w;
        peakIdx = k;
      }
      accPeak = Math.max(accPeak, length(fr.accel));
      if (fr.clipped) clipped++;
      below = fr.w < 2.5 ? below + 1 : 0;
      if (below >= 3 || fr.t - frames[s0].t > 450) break;
      k++;
    }
    // 起点之前往回找：|ω| 刚超过 2 rad/s 的地方作为真正的起动
    let on = s0;
    while (on > 0 && frames[on - 1].w > 2) on--;
    // 起动后 40ms 内世界系 ω_z 的均值（rad/s）
    const onsetFrames = frames.filter((f) => f.t >= frames[on].t && f.t <= frames[on].t + 40);
    const yawOnset = onsetFrames.reduce((a, f) => a + f.wz, 0) / Math.max(1, onsetFrames.length);
    // 起动到峰值之间 ω_z 的积分方向
    let yawInt = 0;
    for (let j = on + 1; j <= peakIdx; j++)
      yawInt += frames[j].wz * ((frames[j].t - frames[j - 1].t) / 1000);
    const g = frames[peakIdx].gyro;
    const ax = [
      ['X', Math.abs(g.x)],
      ['Y', Math.abs(g.y)],
      ['Z', Math.abs(g.z)],
    ].sort((a, b) => (b[1] as number) - (a[1] as number))[0][0] as string;
    swings.push({
      start: frames[on].t,
      peakT: frames[peakIdx].t,
      end: frames[Math.min(k, frames.length - 1)].t,
      peak,
      yawSign: Math.sign(yawInt),
      yawOnset,
      bodyAxis: ax,
      accPeak,
      clipped,
    });
    k++;
  }
  const t0 = samples[0].t;
  console.log(`挥拍（|ω|≥4 rad/s）共 ${swings.length} 次：`);
  const markers = rec.markers ?? [];
  for (const sw of swings) {
    const mk = markers.length
      ? markers.reduce((best, m) =>
          Math.abs(m.t - sw.start) < Math.abs(best.t - sw.start) ? m : best
        )
      : null;
    console.log(
      `  ${f2((sw.start - t0) / 1000)}s  峰值 ${f1(sw.peak)} rad/s @+${Math.round(sw.peakT - sw.start)}ms，` +
        `时长 ${Math.round(sw.end - sw.start)}ms，起动 40ms 内 ω_z ${f1(sw.yawOnset)}，` +
        `到峰值的偏航 ${sw.yawSign > 0 ? '逆时针（正手）' : '顺时针（反手）'}，主轴 机体${sw.bodyAxis}，` +
        `峰值加速度 ${f1(sw.accPeak)}g${sw.clipped ? `，顶格 ${sw.clipped}` : ''}` +
        (mk ? `；距提示音 ${Math.round(sw.start - mk.t)}ms` : '')
    );
  }
  if (markers.length) {
    const hit = markers.filter((m) =>
      swings.some((s) => s.start > m.t - 300 && s.start < m.t + 1200)
    );
    console.log(`提示音 ${markers.length} 次，其中 ${hit.length} 次后面 1.2s 内检测到挥拍`);
  }
}

const files = process.argv.slice(2);
if (!files.length) {
  console.log('用法：pnpm analyze:imu <录制文件.json> [...]');
  process.exit(1);
}
for (const f of files) analyze(f);
