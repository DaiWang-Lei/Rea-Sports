/**
 * M0 连接验证页：连接 Joy-Con、看实时数据与姿态、跑检查清单、测震动、录制挥拍样本。
 */
import '@/styles/base.css';
import './imuDebug.css';
import { HAPTIC_LABELS, HAPTICS, type HapticEvent } from '@/config/haptics';
import { fromAxisAngle, multiply, type Quat, quat, rotate } from '@/core/quat';
import { length, vec3 } from '@/core/vec3';
import {
  AxisConsistencyCheck,
  FACE_LABELS,
  FACES,
  SixFaceCheck,
  YawDriftCheck,
} from '@/input/diagnostics';
import { MotionState } from '@/input/fusion/MotionState';
import {
  getGrantedJoyCons,
  isWebHidSupported,
  onJoyConConnect,
  onJoyConDisconnect,
  requestJoyCons,
} from '@/input/HidManager';
import { type DriverStatus, JoyConDriver, STATUS_TEXT } from '@/input/joycon/JoyConDriver';
import { ImuRecorder } from '@/input/replay/recording';
import { BUTTON_NAMES, type Buttons, isLogicalDown, type ButtonName } from '@/input/types';
import { OrientationView } from './OrientationView';
import { ScrollChart } from './ScrollChart';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface DeviceCtx {
  driver: JoyConDriver;
  motion: MotionState;
  axis: AxisConsistencyCheck;
  six: SixFaceCheck;
  yaw: YawDriftCheck;
  yawAlign: Quat;
  card: HTMLElement;
  status: DriverStatus;
  last: { reports: number; samples: number; t: number };
  rates: { reportHz: number; sampleHz: number };
}

const devices = new Map<HIDDevice, DeviceCtx>();
let active: DeviceCtx | null = null;

// ---------------------------------------------------------------- 日志
const logLines: string[] = [];
function log(msg: string): void {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logLines.unshift(`${time}  ${msg}`);
  if (logLines.length > 200) logLines.pop();
  $('log').textContent = logLines.join('\n');
}

// ---------------------------------------------------------------- 图表与 3D
const gyroChart = new ScrollChart(
  $<HTMLCanvasElement>('chart-gyro'),
  [
    { label: 'X', color: '#ef5b5b' },
    { label: 'Y', color: '#3ccf91' },
    { label: 'Z', color: '#4aa3ff' },
  ],
  { windowMs: 5000, minRange: 50, unit: '°/s', symmetric: true }
);
const accelChart = new ScrollChart(
  $<HTMLCanvasElement>('chart-accel'),
  [
    { label: 'X', color: '#ef5b5b' },
    { label: 'Y', color: '#3ccf91' },
    { label: 'Z', color: '#4aa3ff' },
  ],
  { windowMs: 5000, minRange: 1.2, unit: 'g', symmetric: true }
);
const omegaChart = new ScrollChart(
  $<HTMLCanvasElement>('chart-omega'),
  [{ label: '|ω|', color: '#f2f2f2' }],
  { windowMs: 5000, minRange: 5, unit: 'rad/s' }
);
let view: OrientationView | null = null;
try {
  view = new OrientationView($<HTMLCanvasElement>('view3d'));
} catch (e) {
  log(`3D 视图初始化失败：${(e as Error).message}`);
}

// ---------------------------------------------------------------- 设备
function batteryText(level: number, charging: boolean): string {
  if (level < 0) return '—';
  const pct = Math.round((level / 8) * 100);
  return `${pct}%${charging ? '（充电中）' : ''}`;
}

function renderCard(ctx: DeviceCtx): void {
  const d = ctx.driver;
  const st = d.stream.stats;
  const clk = d.stream.clock.stats();
  const statusClass =
    ctx.status === 'streaming'
      ? 'ok'
      : ctx.status === 'stalled' || ctx.status === 'closed'
        ? 'bad'
        : 'warn';
  const calSource = { factory: '出厂', user: '用户', default: '默认（未读到）' }[
    d.stream.calibration.source
  ];
  ctx.card.innerHTML = `
    <div class="dev-head">
      <strong>${d.name}</strong>
      <span class="${statusClass}">${STATUS_TEXT[ctx.status]}</span>
      ${active === ctx ? '<span class="tag">正在查看</span>' : '<button data-act="view">查看这只</button>'}
    </div>
    <div class="kv">
      <div><span>电量</span><b>${batteryText(d.stream.battery, d.stream.charging)}</b></div>
      <div><span>IMU 校准</span><b>${calSource}</b></div>
      <div><span>报告频率</span><b>${ctx.rates.reportHz.toFixed(1)} Hz</b></div>
      <div><span>样本频率</span><b class="${ctx.rates.sampleHz >= 195 ? 'ok' : ctx.rates.sampleHz > 0 ? 'warn' : ''}">${ctx.rates.sampleHz.toFixed(0)} /秒</b></div>
      <div><span>样本间隔</span><b>${clk.sampleIntervalMs.toFixed(2)} ms</b></div>
      <div><span>丢包</span><b>${clk.droppedReports}（${clk.reports ? ((clk.droppedReports / (clk.reports + clk.droppedReports)) * 100).toFixed(2) : '0.00'}%）</b></div>
      <div><span>蓝牙延迟估计</span><b>${clk.lastLatencyMs.toFixed(1)} ms</b></div>
      <div><span>重新初始化</span><b>${d.reinitCount} 次</b></div>
      <div><span>数据顶格</span><b>${st.clippedSamples} 个样本</b></div>
      <div><span>计时字节步长</span><b>${clk.timerStep ?? '学习中/不可用'}</b></div>
    </div>`;
  ctx.card.querySelector('[data-act="view"]')?.addEventListener('click', () => {
    active = ctx;
    for (const c of devices.values()) renderCard(c);
  });
}

function recenter(ctx: DeviceCtx): void {
  const q = ctx.motion.frame.q;
  let v = rotate(q, vec3(1, 0, 0));
  if (Math.hypot(v.x, v.y) < 0.3) v = rotate(q, vec3(0, 0, 1));
  const yaw0 = Math.atan2(v.y, v.x);
  ctx.yawAlign = fromAxisAngle(0, 0, 1, Math.PI / 2 - yaw0);
  log(`${ctx.driver.name} 已回中`);
}

async function attach(device: HIDDevice): Promise<void> {
  if (devices.has(device)) return;
  const driver = new JoyConDriver(device);
  const ctx: DeviceCtx = {
    driver,
    motion: new MotionState(),
    axis: new AxisConsistencyCheck(),
    six: new SixFaceCheck(),
    yaw: new YawDriftCheck(),
    yawAlign: quat(),
    card: document.createElement('div'),
    status: 'idle',
    last: { reports: 0, samples: 0, t: performance.now() },
    rates: { reportHz: 0, sampleHz: 0 },
  };
  ctx.card.className = 'device';
  $('devices').appendChild(ctx.card);
  devices.set(device, ctx);
  if (!active || driver.side === 'R') active = ctx;

  driver.events = {
    onSamples: (samples) => {
      for (const s of samples) {
        const f = ctx.motion.process(s);
        ctx.axis.add(s);
        ctx.six.add(s);
        ctx.yaw.add(f.t, f.q, length(f.omegaWorld));
        if (ctx === active) {
          gyroChart.push(s.t, [s.gyro.x, s.gyro.y, s.gyro.z]);
          accelChart.push(s.t, [s.accel.x, s.accel.y, s.accel.z]);
          omegaChart.push(s.t, [length(f.gyro)]);
        }
      }
    },
    onButtons: (b, prev) => {
      if (ctx === active) renderButtons(b, driver.side);
      if (
        isLogicalDown(driver.side, b, 'recenter') &&
        !isLogicalDown(driver.side, prev, 'recenter')
      ) {
        recenter(ctx);
      }
    },
    onStatus: (status) => {
      ctx.status = status;
      renderCard(ctx);
    },
    onRawReport: (id, data, arrival) => {
      if (rec && rec.ctx === ctx) rec.recorder.addReport(id, data, arrival);
    },
    onLog: log,
  };
  renderCard(ctx);
  try {
    await driver.start();
    log(`${driver.name} 初始化完成`);
  } catch (e) {
    log(`${driver.name} 启动失败：${(e as Error).message}`);
  }
}

function detach(device: HIDDevice): void {
  const ctx = devices.get(device);
  if (!ctx) return;
  ctx.driver.markDisconnected();
  renderCard(ctx);
  devices.delete(device);
  setTimeout(() => ctx.card.remove(), 3000);
  if (active === ctx) active = devices.values().next().value ?? null;
}

// ---------------------------------------------------------------- 按键显示
function renderButtons(b: Buttons, side: 'L' | 'R'): void {
  const relevant: ButtonName[] =
    side === 'R'
      ? ['a', 'b', 'x', 'y', 'r', 'zr', 'plus', 'home', 'rStick', 'slR', 'srR']
      : ['up', 'down', 'left', 'right', 'l', 'zl', 'minus', 'capture', 'lStick', 'slL', 'srL'];
  const names: Partial<Record<ButtonName, string>> = {
    rStick: '摇杆按下',
    lStick: '摇杆按下',
    slR: 'SL',
    srR: 'SR',
    slL: 'SL',
    srL: 'SR',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    plus: '+',
    minus: '−',
    home: 'HOME',
    capture: '截图',
  };
  $('buttons').innerHTML = relevant
    .filter((n) => BUTTON_NAMES.includes(n))
    .map((n) => `<span class="chip ${b[n] ? 'on' : ''}">${names[n] ?? n.toUpperCase()}</span>`)
    .join('');
}

// ---------------------------------------------------------------- 检查清单
function renderChecks(ctx: DeviceCtx): void {
  $('six-face').innerHTML = FACES.map((f) => {
    const v = ctx.six.cells[f];
    const cls = v === null ? 'dim' : Math.abs(v - 1) <= 0.02 ? 'ok' : 'bad';
    return `<tr><td>${FACE_LABELS[f]}</td><td class="${cls}">${v === null ? '—' : v.toFixed(3) + ' g'}</td></tr>`;
  }).join('');

  const r = ctx.axis.result();
  const pct = Math.round(r.progress * 100);
  let verdict = '<span class="dim">继续慢慢转动…</span>';
  if (r.ready) {
    verdict = r.consistent
      ? '<span class="ok">✓ 一致</span>'
      : `<span class="bad">✗ 不一致：最吻合的陀螺轴符号为 (${r.bestSigns.join(', ')})，请把这个结果告诉我</span>`;
  }
  $('axis-check').innerHTML =
    `<div class="progress"><div style="width:${pct}%"></div></div>${verdict}`;

  const drift = ctx.yaw.driftDegPerMin;
  $('yaw-drift').innerHTML =
    drift === null
      ? `<span class="dim">已静止 ${ctx.yaw.stillSeconds.toFixed(0)} 秒（需要 10 秒）</span>`
      : `<span class="${drift < 2 ? 'ok' : 'bad'}">${drift.toFixed(2)} °/分钟</span> <span class="dim">（静止 ${ctx.yaw.stillSeconds.toFixed(0)} 秒）</span>`;
}

function renderCalibStats(ctx: DeviceCtx): void {
  const b = ctx.motion.gyroBias;
  const f = ctx.motion.frame;
  $('calib-stats').innerHTML = `
    <div><span>陀螺零偏</span><b>${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)} °/s</b></div>
    <div><span>自动校准置信度</span><b>${(ctx.motion.calibrationConfidence * 100).toFixed(0)}%</b></div>
    <div><span>状态</span><b>${ctx.motion.isLayFlatCalibrating ? '<span class="warn">平放校准中…</span>' : f.steady ? '静止' : '运动'}</b></div>`;
  $('live-stats').innerHTML = `
    <div><span>|a|</span><b>${length(f.accel).toFixed(3)} g</b></div>
    <div><span>|ω|</span><b>${length(f.gyro).toFixed(2)} rad/s</b></div>
    <div><span>线加速度（世界系）</span><b>${f.linAccWorld.x.toFixed(2)}, ${f.linAccWorld.y.toFixed(2)}, ${f.linAccWorld.z.toFixed(2)} g</b></div>`;
}

// ---------------------------------------------------------------- 录制
let audioCtx: AudioContext | null = null;
function beep(): void {
  audioCtx ??= new AudioContext();
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.15);
}

let rec: { ctx: DeviceCtx; recorder: ImuRecorder; timers: number[]; mode: 'beep' | 'free' } | null =
  null;

function startRecording(mode: 'beep' | 'free'): void {
  if (!active) {
    log('请先连接 Joy-Con');
    return;
  }
  audioCtx ??= new AudioContext();
  const ctx = active;
  const recorder = new ImuRecorder(ctx.driver.side, ctx.driver.stream.calibration);
  const timers: number[] = [];
  rec = { ctx, recorder, timers, mode };
  if (mode === 'beep') {
    const BEEPS = 10;
    for (let i = 0; i < BEEPS; i++) {
      timers.push(
        window.setTimeout(
          () => {
            beep();
            const t = performance.now();
            recorder.mark(t, 'swing');
            omegaChart.mark(t);
            $('rec-status').textContent = `第 ${i + 1} / ${BEEPS} 次`;
          },
          2000 + i * 1600
        )
      );
    }
    timers.push(window.setTimeout(() => stopRecording(), 2000 + (BEEPS - 1) * 1600 + 1500));
    $('rec-status').textContent = '2 秒后开始，听到提示音就挥拍…';
  } else {
    $('rec-status').textContent = '录制中…';
  }
  $<HTMLButtonElement>('btn-rec-stop').disabled = false;
  $<HTMLButtonElement>('btn-rec-beep').disabled = true;
  $<HTMLButtonElement>('btn-rec-free').disabled = true;
}

function stopRecording(): void {
  if (!rec) return;
  for (const t of rec.timers) clearTimeout(t);
  const data = rec.recorder.finish(rec.mode === 'beep' ? '跟着提示音正手挥拍 10 次' : '自由录制');
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = `imu-${data.side}-${rec.mode}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $('rec-status').textContent =
    `已保存 ${data.reports.length} 个报告、${data.markers.length} 个标记`;
  log(`录制完成：${a.download}`);
  rec = null;
  $<HTMLButtonElement>('btn-rec-stop').disabled = true;
  $<HTMLButtonElement>('btn-rec-beep').disabled = false;
  $<HTMLButtonElement>('btn-rec-free').disabled = false;
}

// ---------------------------------------------------------------- 绑定
function bindUi(): void {
  if (!isWebHidSupported()) {
    $('hid-support').innerHTML =
      '<span class="bad">当前浏览器不支持 WebHID，请用桌面版 Chrome 或 Edge 打开。</span>';
    $<HTMLButtonElement>('btn-connect').disabled = true;
    return;
  }
  $('btn-connect').addEventListener('click', async () => {
    try {
      const ds = await requestJoyCons();
      if (ds.length === 0) log('没有选择设备');
      for (const d of ds) void attach(d);
    } catch (e) {
      log(`连接失败：${(e as Error).message}`);
    }
  });
  onJoyConConnect((d) => {
    log('检测到 Joy-Con 连接');
    void attach(d);
  });
  onJoyConDisconnect((d) => {
    log('Joy-Con 断开');
    detach(d);
  });
  void getGrantedJoyCons().then((ds) => ds.forEach((d) => void attach(d)));

  $('btn-layflat').addEventListener('click', () => {
    if (!active) return;
    active.motion.beginLayFlat(performance.now());
    log('平放校准：请保持手柄静止 2 秒');
  });
  $('btn-recenter').addEventListener('click', () => active && recenter(active));
  $('btn-axis-reset').addEventListener('click', () => active?.axis.reset());

  const rb = $('rumble-buttons');
  for (const e of Object.keys(HAPTICS) as HapticEvent[]) {
    const b = document.createElement('button');
    b.textContent = HAPTIC_LABELS[e];
    b.addEventListener('click', () => active?.driver.rumble(HAPTICS[e]));
    rb.appendChild(b);
  }

  $('btn-rec-beep').addEventListener('click', () => startRecording('beep'));
  $('btn-rec-free').addEventListener('click', () => startRecording('free'));
  $('btn-rec-stop').addEventListener('click', () => stopRecording());
}

// ---------------------------------------------------------------- 主循环
let lastStats = 0;
function frame(): void {
  const now = performance.now();
  gyroChart.draw();
  accelChart.draw();
  omegaChart.draw();
  if (active && view) {
    view.setOrientation(multiply(active.yawAlign, active.motion.frame.q));
    view.render();
  }
  if (now - lastStats > 250) {
    lastStats = now;
    for (const ctx of devices.values()) {
      const st = ctx.driver.stream.stats;
      const dt = (now - ctx.last.t) / 1000;
      if (dt >= 1) {
        ctx.rates.reportHz = (st.fullReports - ctx.last.reports) / dt;
        ctx.rates.sampleHz = (st.samples - ctx.last.samples) / dt;
        ctx.last = { reports: st.fullReports, samples: st.samples, t: now };
      }
      renderCard(ctx);
    }
    if (active) {
      renderChecks(active);
      renderCalibStats(active);
    }
  }
  requestAnimationFrame(frame);
}

bindUi();
requestAnimationFrame(frame);
