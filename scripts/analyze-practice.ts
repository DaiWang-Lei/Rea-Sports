/**
 * 分析发球机练习录制（暂停菜单「录制这局」导出的 JSON）：
 *  - 每一球：理想击球时刻、每次挥拍的预测接触时刻（早晚多少毫秒）、判定结果、站位误差、最后结果；
 *  - 汇总：时机分布（判定用到的那一下）、各种结果的次数、建议的画面延迟补偿；
 *  - 握法：固定握法，或旧录制里准备姿势时设备怎么拿（各轴在游戏坐标里的朝向）；打球时拍头 / 红面平均朝哪；
 *    电视方向的自动校正（2026-10-23 起）。
 * 用法：pnpm analyze:practice <录制.json> [...]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { conjugate, quat, rotate } from '../src/core/quat';
import { vec3 } from '../src/core/vec3';
import { DEVICE_GRIP } from '../src/input/paddle/PaddleModel';
import {
  isPracticeRecording,
  type PracticeLogEvent,
  type PracticeRecording,
} from '../src/app/practice/PracticeRecorder';

type Ev<K extends PracticeLogEvent['k']> = Extract<PracticeLogEvent, { k: K }>;

const f0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toString() : '—');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const sgnMs = (ms: number) =>
  ms === 0 ? '0' : `${ms < 0 ? '早' : '晚'} ${Math.abs(Math.round(ms))}`;
const median = (v: number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const sd = (v: number[]) => {
  const m = mean(v);
  return v.length ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) : NaN;
};

/** 游戏坐标里的方向 → 文字（x 右、y 朝电视、z 上） */
function dirText(v: { x: number; y: number; z: number }): string {
  const parts: Array<[number, string, string]> = [
    [v.x, '右', '左'],
    [v.y, '朝电视', '朝自己'],
    [v.z, '上', '下'],
  ];
  const main = parts
    .map(([c, pos, neg]) => ({ a: Math.abs(c), t: c >= 0 ? pos : neg }))
    .sort((a, b) => b.a - a.a)
    .filter((p, i) => i === 0 || p.a > 0.35)
    .map((p) => p.t);
  return `${main.join('偏')}（${f2(v.x)}, ${f2(v.y)}, ${f2(v.z)}）`;
}

const AXES = [
  ['+X', vec3(1, 0, 0)],
  ['+Y', vec3(0, 1, 0)],
  ['+Z', vec3(0, 0, 1)],
] as const;

function analyze(file: string): void {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!isPracticeRecording(rec)) {
    console.log(`${file}：不是发球机练习录制`);
    return;
  }
  const r = rec as PracticeRecording;
  const L = r.practice;
  const ev = L.events;
  const st = L.settings;
  const H = st.windowMs;
  const axisName =
    L.deviceKind === 'phone'
      ? { '+X': '手机顶端', '+Y': '手机左侧', '+Z': '屏幕' }
      : { '+X': '肩键一端', '+Y': '导轨反侧（左）', '+Z': '按键面' };
  console.log(`\n======== ${basename(file)}`);
  console.log(
    `设备：${L.deviceName}（${L.deviceKind}）；难度 ${st.level}，落点 ${st.zone}，宽容度 ${st.leniency}；` +
      `画面延迟补偿 ${st.latencyMs}ms${st.screen ? `（屏幕 ${st.screen}）` : ''}；时机窗口 H = ${H}ms，击中 τ ∈ [${st.tauMin}, ${st.tauMax}]` +
      `（早 ${f0(-st.tauMin * H)}ms ～ 晚 ${f0(st.tauMax * H)}ms），挥早挂起 ${st.holdEarly}s`
  );
  const n = r.source === 'phone' ? (r.samples?.length ?? 0) : r.reports.length;
  const dur = ev.length ? (ev[ev.length - 1].rt - ev[0].rt) / 1000 : 0;
  console.log(`时长 ${dur.toFixed(0)}s，体感数据 ${n} 条，事件 ${ev.length} 个`);

  // ---- 陀螺仪零点
  const biases = ev.filter((e): e is Ev<'gyroBias'> => e.k === 'gyroBias');
  if (biases.length) {
    const fmt = (b: Ev<'gyroBias'>) =>
      `(${b.bias.map((v) => v.toFixed(2)).join(', ')})°/s${b.learnedAt === null ? '（出厂 / 没测过）' : ''}`;
    const updates = biases.filter((b) => b.learnedAt !== null).length;
    console.log(
      `陀螺仪零点（${biases[0].mode}）：开始时 ${fmt(biases[0])}；录制中重新测了 ${Math.max(0, updates - (biases[0].learnedAt === null ? 0 : 1))} 次` +
        (biases.length > 1 ? `，最后 ${fmt(biases[biases.length - 1])}` : '')
    );
  }

  // ---- 握法
  const calib = ev.filter((e): e is Ev<'calib'> => e.k === 'calib').pop();
  if (calib?.grip) {
    const [w, x, y, z] = calib.grip;
    const g = DEVICE_GRIP;
    const fixed = Math.abs(w * g.w + x * g.x + y * g.y + z * g.z) > 0.9999;
    if (fixed) {
      console.log(`握法：固定（${axisName['+X']}是拍头，${axisName['+Z']}是红面 / 正手面）`);
    } else {
      // 2026-10-23 之前：握法在准备姿势那一刻测出
      const gInv = conjugate(quat(w, x, y, z));
      console.log('准备姿势时（按确认那一刻）设备各轴在游戏里的朝向：');
      for (const [k, a] of AXES)
        console.log(`  ${axisName[k]}（${k}）→ ${dirText(rotate(gInv, a))}`);
    }
  } else {
    console.log('没有准备姿势校准（拍面角度不参与判定）');
  }
  // ---- 自动校正电视方向（2026-10-23 起 pose 里带偏航）
  const tracked = ev.filter(
    (e): e is Ev<'pose'> & { yaw: number; drift: number } =>
      e.k === 'pose' && e.yaw !== undefined && e.drift !== undefined
  );
  if (tracked.length > 1) {
    const D = 180 / Math.PI;
    const a = tracked[0];
    const b = tracked[tracked.length - 1];
    let turn = (b.yaw - a.yaw) * D;
    turn = ((turn + 540) % 360) - 180;
    console.log(
      `电视方向：录制中自动校正 / 回中累计转了 ${f0(turn)}°（${f0((b.rt - a.rt) / 1000)} 秒）；` +
        `估计的偏航漂移速度 开始 ${f2(a.drift * D)}°/s，最后 ${f2(b.drift * D)}°/s`
    );
  }
  const poses = ev.filter((e): e is Ev<'pose'> => e.k === 'pose' && !!e.blade && !!e.face);
  if (poses.length) {
    const avg = (pick: (p: Ev<'pose'>) => [number, number, number]) => {
      const s = poses.reduce(
        (acc, p) => {
          const v = pick(p);
          return [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]];
        },
        [0, 0, 0]
      );
      const l = Math.hypot(s[0], s[1], s[2]) || 1;
      return vec3(s[0] / l, s[1] / l, s[2] / l);
    };
    const blade = avg((p) => p.blade!);
    const face = avg((p) => p.face!);
    const tilt = (Math.acos(Math.max(-1, Math.min(1, blade.z))) * 180) / Math.PI;
    console.log(
      `打球时（${poses.length} 个采样）画面里：拍头平均朝 ${dirText(blade)}，离竖直 ${tilt.toFixed(0)}°；` +
        `红面平均朝 ${dirText(face)}`
    );
  }

  // ---- 每一球
  type Ball = {
    feedRt: number;
    plan: Ev<'plan'> | null;
    swings: Ev<'swing'>[];
    sims: Ev<'sim'>[];
    result: Ev<'sim'> | null;
  };
  const balls: Ball[] = [];
  let cur: Ball | null = null;
  for (const e of ev) {
    if (e.k === 'sim' && e.e.type === 'feed') {
      cur = { feedRt: e.rt, plan: null, swings: [], sims: [e], result: null };
      balls.push(cur);
      continue;
    }
    if (!cur) continue;
    if (e.k === 'plan') cur.plan = e;
    else if (e.k === 'swing') cur.swings.push(e);
    else if (e.k === 'sim') {
      cur.sims.push(e);
      if (e.e.type === 'result') {
        cur.result = e;
        cur = null;
      }
    }
  }
  const RESULT_TEXT: Record<string, string> = {
    in: '回进',
    out: '出界',
    net: '下网',
    own: '落在本方',
    missed: '没接到',
    early: '挥早',
    late: '挥晚',
    reach: '够不着',
    volley: '未落台',
  };
  const deciding: number[] = [];
  const counts = new Map<string, number>();
  console.log(`\n逐球（时刻都相对理想击球时刻，毫秒；「预测」= 预测接触时刻，已扣画面延迟补偿）：`);
  balls.forEach((b, i) => {
    const plan = b.plan;
    const rep = b.result?.e.type === 'result' ? b.result.e.report : null;
    const res = rep ? (RESULT_TEXT[rep.result] ?? rep.result) : '（没出结果）';
    counts.set(res, (counts.get(res) ?? 0) + 1);
    const hit = b.sims.find((s) => s.e.type === 'hit')?.e;
    const whiff = b.sims.find((s) => s.e.type === 'whiff')?.e;
    const reach =
      hit?.type === 'hit' ? hit.reach : whiff?.type === 'whiff' ? whiff.reach : undefined;
    const lines = b.swings.map((s) => {
      const rel = plan ? (s.input.tContact - plan.t) * 1000 : NaN;
      const det = plan ? (s.input.tDetect - plan.t) * 1000 : NaN;
      const o = s.outcome;
      const ot =
        o.type === 'hit'
          ? `击中（${o.stroke === 'fh' ? '正手' : '反手'}）`
          : o.type === 'held'
            ? `挂起（${o.miss.type === 'volley' ? '未落台' : '挥早'}，可被取代）`
            : o.type === 'whiff'
              ? o.reason === 'early'
                ? '挥早'
                : '挥晚'
              : o.type === 'volley'
                ? '未落台'
                : '忽略';
      const dir = s.input.dir > 0 ? '逆时针' : s.input.dir < 0 ? '顺时针' : '上下';
      return (
        `    挥拍 #${s.input.id}（${s.input.path}，${dir}，${s.input.wPeak.toFixed(0)} rad/s，` +
        `竖直占比 ${f2(s.input.yawFrac)}）确认 ${sgnMs(det)}，预测 ${sgnMs(rel)} → ${ot}` +
        `；站位 ${s.stance}${s.stanceHint ? `（拍面提示 ${s.stanceHint}）` : ''}`
      );
    });
    console.log(
      `  第 ${i + 1} 球：${res}` +
        (rep && rep.timingMs !== null ? `，卡片时机 ${sgnMs(rep.timingMs)}ms` : '') +
        (reach !== undefined ? `，站位误差 ${f2(reach)}m` : '') +
        (plan ? `；落台 → 理想击球 ${f0((plan.t - plan.bounceT) * 1000)}ms` : '')
    );
    for (const l of lines) console.log(l);
    // 判定用到的那一下：最后一次没被忽略的挥拍（挂起的引拍被前挥取代时取前挥）
    const last = [...b.swings].reverse().find((s) => s.outcome.type !== 'ignore');
    if (last && plan) deciding.push((last.input.tContact - plan.t) * 1000);
  });

  // ---- 汇总
  console.log(
    `\n结果：${[...counts.entries()].map(([k, v]) => `${k} ${v}`).join('，')}（共 ${balls.length} 球）`
  );
  if (deciding.length) {
    const med = median(deciding);
    console.log(
      `判定用到的挥拍 ${deciding.length} 次：预测接触相对理想时刻 中位 ${sgnMs(med)}ms，` +
        `平均 ${sgnMs(mean(deciding))}ms，标准差 ${f0(sd(deciding))}ms`
    );
    if (Math.abs(med) > 25) {
      console.log(
        `  → 整体偏${med > 0 ? '晚' : '早'}：画面延迟补偿可以试 ${f0(st.latencyMs + med)}ms（现在 ${st.latencyMs}ms）`
      );
    }
  }
}

const files = process.argv.slice(2);
if (!files.length) {
  console.log('用法：pnpm analyze:practice <录制.json> [...]');
  process.exit(1);
}
for (const f of files) analyze(f);
