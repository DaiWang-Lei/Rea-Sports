/** 在录制文件上跑挥拍识别，逐条列出确认的挥拍和预测误差。用法：pnpm eval:swing fixtures/imu/xxx.json [...] */
import { readFileSync } from 'node:fs';
import { MotionState } from '../src/input/fusion/MotionState';
import { SWING_PROFILES, SwingDetector, type SwingEvent } from '../src/input/paddle/SwingDetector';
import { type ImuRecording, recordingSamples } from '../src/input/replay/recording';

for (const file of process.argv.slice(2)) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as ImuRecording;
  const samples = recordingSamples(rec);
  const ms = new MotionState();
  const det = new SwingDetector(
    rec.source === 'phone' ? SWING_PROFILES.phone : SWING_PROFILES.joycon
  );
  const ev: SwingEvent[] = [];
  for (const s of samples) {
    const f = ms.process(s);
    ev.push(...det.process(f));
  }
  const t0 = samples[0].t;
  console.log(`\n== ${file}`);
  const peaks = new Map(ev.filter((e) => e.type === 'peak').map((e) => [e.id, e]));
  const errs: number[] = [];
  const estErr: number[] = [];
  for (const e of ev) {
    if (e.type !== 'commit') continue;
    const pk = peaks.get(e.id);
    const mk = (rec.markers ?? []).filter((m) => m.t < e.t).pop();
    if (pk && e.path === 'fast') {
      errs.push(e.tContact - pk.t);
      estErr.push(e.wPeak / pk.w);
    }
    console.log(
      `  ${((e.t - t0) / 1000).toFixed(2)}s 动作${e.motion} #${e.id} ${e.path} ${e.dir > 0 ? '逆时针(正手)' : '顺时针(反手)'} w=${e.w.toFixed(1)} 估计峰 ${e.wPeak.toFixed(1)} 实际峰 ${pk ? pk.w.toFixed(1) : '—'} 预测接触−实际峰 ${pk ? Math.round(e.tContact - pk.t) : '—'}ms 偏航占比 ${e.yawFrac.toFixed(2)}` +
        (mk ? `（提示音后 ${Math.round(e.t - mk.t)}ms）` : '')
    );
  }
  if (errs.length) {
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / errs.length);
    const em = estErr.reduce((a, b) => a + b, 0) / estErr.length;
    const esd = Math.sqrt(estErr.reduce((a, b) => a + (b - em) ** 2, 0) / estErr.length);
    console.log(
      `  快速确认：预测接触误差 平均 ${mean.toFixed(0)}ms 标准差 ${sd.toFixed(0)}ms；峰值估计/实际 平均 ${em.toFixed(2)} 标准差 ${esd.toFixed(2)}`
    );
  }
  if (rec.markers?.length) {
    let ok = 0;
    for (const m of rec.markers) {
      const first = ev.find((e) => e.type === 'commit' && e.t > m.t + 100 && e.t < m.t + 1100);
      if (first && first.type === 'commit' && first.dir > 0) ok++;
    }
    console.log(`  提示音后第一次确认是正手：${ok}/${rec.markers.length}`);
  }
}
