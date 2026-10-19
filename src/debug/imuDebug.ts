/**
 * 连接验证页：连接手机或 Joy-Con、看实时数据与姿态、跑检查清单、测震动、录制挥拍样本。
 * 手机和 Joy-Con 输出同一种 ImuSample，后面的融合与检查完全共用。
 */
import '@/styles/base.css';
import './imuDebug.css';
import QRCode from 'qrcode';
import { HAPTIC_LABELS, HAPTICS, type HapticEvent } from '@/config/haptics';
import { fromAxisAngle, multiply, type Quat, quat, rotate } from '@/core/quat';
import { length, vec3 } from '@/core/vec3';
import {
  AxisConsistencyCheck,
  type Face,
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
import { DEFAULT_CALIBRATION } from '@/input/joycon/calibration';
import { type DriverStatus, JoyConDriver, STATUS_TEXT } from '@/input/joycon/JoyConDriver';
import {
  devLanInfo,
  type PhoneDevice,
  PhoneHub,
  phonePageUrl,
  RelayGameLink,
  RtcGameLink,
} from '@/input/phone/PhoneHub';
import { isValidRoom, randomCode } from '@/net/signal';
import type { PhoneButton } from '@/input/phone/protocol';
import { ImuRecorder } from '@/input/replay/recording';
import {
  type ButtonName,
  BUTTON_NAMES,
  type Buttons,
  type ImuSample,
  isLogicalDown,
} from '@/input/types';
import { OrientationView } from './OrientationView';
import { ScrollChart } from './ScrollChart';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type DeviceKind = 'joycon' | 'phone';

interface DeviceCtx {
  key: string;
  kind: DeviceKind;
  joycon?: JoyConDriver;
  phone?: PhoneDevice;
  motion: MotionState;
  axis: AxisConsistencyCheck;
  six: SixFaceCheck;
  yaw: YawDriftCheck;
  yawAlign: Quat;
  card: HTMLElement;
  joyStatus: DriverStatus;
  last: { samples: number; t: number };
  sampleHz: number;
}

const devices = new Map<string, DeviceCtx>();
const hidKeys = new WeakMap<HIDDevice, string>();
let hidCounter = 0;
let active: DeviceCtx | null = null;

function deviceName(ctx: DeviceCtx): string {
  if (ctx.kind === 'joycon') return ctx.joycon!.name;
  const p = ctx.phone!;
  return `${p.platformText} · ${p.name}`;
}

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

function setActive(ctx: DeviceCtx | null): void {
  active = ctx;
  view?.setModel(ctx?.kind ?? 'joycon');
  for (const c of devices.values()) renderCard(c);
}

// ---------------------------------------------------------------- 设备卡片
function batteryText(level: number, charging: boolean): string {
  if (level < 0) return '—';
  const pct = Math.round((level / 8) * 100);
  return `${pct}%${charging ? '（充电中）' : ''}`;
}

const kv = (label: string, value: string, cls = '') =>
  `<div><span>${label}</span><b class="${cls}">${value}</b></div>`;

function renderCard(ctx: DeviceCtx): void {
  let statusText: string;
  let statusClass: string;
  let rows: string;
  const hzClass = (min: number) => (ctx.sampleHz >= min ? 'ok' : ctx.sampleHz > 0 ? 'warn' : '');
  if (ctx.kind === 'joycon') {
    const d = ctx.joycon!;
    const st = d.stream.stats;
    const clk = d.stream.clock.stats();
    statusText = STATUS_TEXT[ctx.joyStatus];
    statusClass =
      ctx.joyStatus === 'streaming'
        ? 'ok'
        : ctx.joyStatus === 'stalled' || ctx.joyStatus === 'closed'
          ? 'bad'
          : 'warn';
    const calSource = { factory: '出厂', user: '用户', default: '默认（未读到）' }[
      d.stream.calibration.source
    ];
    const lossPct = clk.reports
      ? ((clk.droppedReports / (clk.reports + clk.droppedReports)) * 100).toFixed(2)
      : '0.00';
    rows =
      kv('电量', batteryText(d.stream.battery, d.stream.charging)) +
      kv('IMU 校准', calSource) +
      kv('样本频率', `${ctx.sampleHz.toFixed(0)} /秒`, hzClass(195)) +
      kv('样本间隔', `${clk.sampleIntervalMs.toFixed(2)} ms`) +
      kv('丢包', `${clk.droppedReports}（${lossPct}%）`) +
      kv('蓝牙延迟估计', `${clk.lastLatencyMs.toFixed(1)} ms`) +
      kv('重新初始化', `${d.reinitCount} 次`) +
      kv('数据顶格', `${st.clippedSamples} 个样本`) +
      kv('计时字节步长', String(clk.timerStep ?? '学习中/不可用'));
  } else {
    const p = ctx.phone!;
    const flowing = performance.now() - p.lastSampleAt < 1000;
    statusText = !p.connected ? '已断开' : flowing ? '数据正常' : '已连接，等待在手机上点「开始」';
    statusClass = !p.connected ? 'bad' : flowing ? 'ok' : 'warn';
    const m = p.meta;
    const sign =
      m?.accelSign === 1 ? '标准' : m?.accelSign === -1 ? '已自动修正（反向）' : '判断中';
    rows =
      kv('平台', m ? p.platformText : '—') +
      kv('样本频率', `${ctx.sampleHz.toFixed(0)} /秒`, hzClass(50)) +
      kv('网络往返', Number.isNaN(p.rttMs) ? '—' : `${p.rttMs.toFixed(0)} ms`) +
      kv('本次额外延迟', `${p.jitterMs.toFixed(0)} ms`) +
      kv('丢失样本', String(p.lostSamples)) +
      kv('加速度方向', sign, m?.accelSign ? 'ok' : 'warn') +
      kv('陀螺仪', m ? (m.hasGyro ? '有' : '没有') : '—', m && !m.hasGyro ? 'bad' : '') +
      kv('震动', m ? (m.canVibrate ? '支持' : '不支持（iPhone 浏览器）') : '—');
  }
  ctx.card.innerHTML = `
    <div class="dev-head">
      <strong>${deviceName(ctx)}</strong>
      <span class="${statusClass}">${statusText}</span>
      ${active === ctx ? '<span class="tag">正在查看</span>' : '<button data-act="view">查看这个</button>'}
    </div>
    <div class="kv">${rows}</div>`;
  ctx.card.querySelector('[data-act="view"]')?.addEventListener('click', () => setActive(ctx));
}

function recenter(ctx: DeviceCtx): void {
  const q = ctx.motion.frame.q;
  let v = rotate(q, vec3(1, 0, 0));
  if (Math.hypot(v.x, v.y) < 0.3) v = rotate(q, vec3(0, 0, 1));
  const yaw0 = Math.atan2(v.y, v.x);
  ctx.yawAlign = fromAxisAngle(0, 0, 1, Math.PI / 2 - yaw0);
  log(`${deviceName(ctx)} 已回中`);
}

function newCtx(key: string, kind: DeviceKind): DeviceCtx {
  const ctx: DeviceCtx = {
    key,
    kind,
    motion: new MotionState(),
    axis: new AxisConsistencyCheck(),
    six: new SixFaceCheck(),
    yaw: new YawDriftCheck(),
    yawAlign: quat(),
    card: document.createElement('div'),
    joyStatus: 'idle',
    last: { samples: 0, t: performance.now() },
    sampleHz: 0,
  };
  ctx.card.className = 'device';
  $('devices').appendChild(ctx.card);
  devices.set(key, ctx);
  return ctx;
}

let totalSamples = new Map<string, number>();

function onSamples(ctx: DeviceCtx, samples: ImuSample[]): void {
  totalSamples.set(ctx.key, (totalSamples.get(ctx.key) ?? 0) + samples.length);
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
    if (rec && rec.ctx === ctx && ctx.kind === 'phone') rec.recorder.addSample(s);
  }
}

// ---------------------------------------------------------------- Joy-Con
async function attachJoyCon(device: HIDDevice): Promise<void> {
  if (hidKeys.has(device) && devices.has(hidKeys.get(device)!)) return;
  const key = `hid-${hidCounter++}`;
  hidKeys.set(device, key);
  const driver = new JoyConDriver(device);
  const ctx = newCtx(key, 'joycon');
  ctx.joycon = driver;
  if (!active || active.kind !== 'joycon' || driver.side === 'R') setActive(ctx);
  driver.events = {
    onSamples: (s) => onSamples(ctx, s),
    onButtons: (b, prev) => {
      if (ctx === active) renderJoyButtons(b, driver.side);
      if (
        isLogicalDown(driver.side, b, 'recenter') &&
        !isLogicalDown(driver.side, prev, 'recenter')
      ) {
        recenter(ctx);
      }
    },
    onStatus: (status) => {
      ctx.joyStatus = status;
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

function detachJoyCon(device: HIDDevice): void {
  const key = hidKeys.get(device);
  const ctx = key ? devices.get(key) : undefined;
  if (!ctx) return;
  ctx.joycon!.markDisconnected();
  removeCtx(ctx);
}

function removeCtx(ctx: DeviceCtx): void {
  renderCard(ctx);
  devices.delete(ctx.key);
  setTimeout(() => ctx.card.remove(), 3000);
  if (active === ctx) setActive(devices.values().next().value ?? null);
}

// ---------------------------------------------------------------- 手机
let hub: PhoneHub | null = null;

/** 房间号记在本机，刷新页面后手机上的网址仍然有效 */
function roomCode(): string {
  const fromUrl = new URLSearchParams(location.search).get('room');
  if (isValidRoom(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem('rea-room');
    if (isValidRoom(saved)) return saved;
    const r = randomCode(8);
    localStorage.setItem('rea-room', r);
    return r;
  } catch {
    return randomCode(8);
  }
}

/**
 * 选择手机连接方式：本地开发服务器（有 /api/lan）默认用中转；线上部署（或 ?link=rtc）用 WebRTC 直连。
 */
async function setupPhones(): Promise<void> {
  const lan = await devLanInfo();
  const useRtc = new URLSearchParams(location.search).get('link') === 'rtc' || !lan;
  const room = useRtc ? roomCode() : null;
  hub = new PhoneHub(useRtc ? new RtcGameLink(room!) : new RelayGameLink());
  hub.onPhoneAdded = attachPhone;
  hub.onPhoneRemoved = detachPhone;
  hub.onStatus = (text, ok) => {
    $('hub-status').innerHTML = `<span class="${ok ? 'ok' : 'warn'}">● ${text}</span>`;
  };
  hub.connect();

  $('link-mode').textContent = useRtc
    ? '连接方式：WebRTC 直连（体感数据在 Wi-Fi 内点对点传输，只有握手经过公共服务器）'
    : '连接方式：本地中转（经这台 Mac 上的开发服务器）';
  $('room-code').textContent = room ? `房间号：${room}` : '';
  // 线上部署是正规证书，也不经过 Mac 的服务器：隐藏证书和防火墙两条提示
  $('li-cert').hidden = !lan;
  $('li-firewall').hidden = !lan || useRtc;

  const url = phonePageUrl(lan, room);
  const a = $<HTMLAnchorElement>('phone-url');
  if (!url) {
    a.textContent = '没找到这台 Mac 的局域网地址（确认已连上 Wi-Fi）';
    return;
  }
  a.textContent = url;
  a.href = url;
  try {
    await QRCode.toCanvas($<HTMLCanvasElement>('qr'), url, { width: 180, margin: 1 });
  } catch (e) {
    log(`二维码生成失败：${(e as Error).message}`);
  }
}

function attachPhone(p: PhoneDevice): void {
  const key = `phone-${p.id}`;
  if (devices.has(key)) return;
  const ctx = newCtx(key, 'phone');
  ctx.phone = p;
  // 先连上的设备默认查看；手机优先于还没出数据的设备
  if (!active) setActive(ctx);
  p.events = {
    onSamples: (s) => onSamples(ctx, s),
    onButton: (name, down) => {
      if (ctx === active) renderPhoneButtons(p.buttons);
      if (name === 'recenter' && down) recenter(ctx);
    },
    onMeta: () => renderCard(ctx),
    onLog: log,
  };
  log(`手机已连接：${deviceName(ctx)}`);
  renderCard(ctx);
}

function detachPhone(p: PhoneDevice): void {
  const ctx = devices.get(`phone-${p.id}`);
  if (!ctx) return;
  log(`手机断开：${deviceName(ctx)}`);
  removeCtx(ctx);
}

// ---------------------------------------------------------------- 按键显示
function chip(on: boolean, text: string): string {
  return `<span class="chip ${on ? 'on' : ''}">${text}</span>`;
}

function renderJoyButtons(b: Buttons, side: 'L' | 'R'): void {
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
    .map((n) => chip(b[n], names[n] ?? n.toUpperCase()))
    .join('');
}

function renderPhoneButtons(b: Record<PhoneButton, boolean>): void {
  $('buttons').innerHTML =
    chip(b.confirm, '确认 / 抛球') + chip(b.recenter, '回中') + chip(b.pause, '暂停');
}

// ---------------------------------------------------------------- 检查清单
const PHONE_FACE_LABELS: Record<Face, string> = {
  '+Z': '屏幕朝上',
  '-Z': '屏幕朝下',
  '+X': '顶端朝上',
  '-X': '顶端朝下',
  '+Y': '左侧朝上',
  '-Y': '右侧朝上',
};

function renderChecks(ctx: DeviceCtx): void {
  const labels = ctx.kind === 'phone' ? PHONE_FACE_LABELS : FACE_LABELS;
  $('six-face').innerHTML = FACES.map((f) => {
    const v = ctx.six.cells[f];
    const cls = v === null ? 'dim' : Math.abs(v - 1) <= 0.02 ? 'ok' : 'bad';
    return `<tr><td>${labels[f]}</td><td class="${cls}">${v === null ? '—' : v.toFixed(3) + ' g'}</td></tr>`;
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
  const target = ctx.kind === 'phone' ? 5 : 2;
  $('yaw-drift').innerHTML =
    drift === null
      ? `<span class="dim">已静止 ${ctx.yaw.stillSeconds.toFixed(0)} 秒（需要 10 秒）</span>`
      : `<span class="${drift < target ? 'ok' : 'bad'}">${drift.toFixed(2)} °/分钟</span> <span class="dim">（静止 ${ctx.yaw.stillSeconds.toFixed(0)} 秒）</span>`;
}

function renderCalibStats(ctx: DeviceCtx): void {
  const b = ctx.motion.gyroBias;
  const f = ctx.motion.frame;
  $('calib-stats').innerHTML =
    kv('陀螺零偏', `${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)} °/s`) +
    kv('自动校准置信度', `${(ctx.motion.calibrationConfidence * 100).toFixed(0)}%`) +
    kv(
      '状态',
      ctx.motion.isLayFlatCalibrating
        ? '<span class="warn">平放校准中…</span>'
        : f.steady
          ? '静止'
          : '运动'
    );
  $('live-stats').innerHTML =
    kv('|a|', `${length(f.accel).toFixed(3)} g`) +
    kv('|ω|', `${length(f.gyro).toFixed(2)} rad/s`) +
    kv(
      '线加速度（世界系）',
      `${f.linAccWorld.x.toFixed(2)}, ${f.linAccWorld.y.toFixed(2)}, ${f.linAccWorld.z.toFixed(2)} g`
    );
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

let rec: {
  ctx: DeviceCtx;
  recorder: ImuRecorder;
  timers: number[];
  mode: 'beep' | 'free';
} | null = null;

function startRecording(mode: 'beep' | 'free'): void {
  if (!active) {
    log('请先连接手机或 Joy-Con');
    return;
  }
  audioCtx ??= new AudioContext();
  const ctx = active;
  const recorder =
    ctx.kind === 'joycon'
      ? new ImuRecorder(
          ctx.joycon!.side,
          ctx.joycon!.stream.calibration,
          'joycon',
          ctx.joycon!.name
        )
      : new ImuRecorder(
          'R',
          DEFAULT_CALIBRATION,
          'phone',
          `${deviceName(ctx)} · ${ctx.phone!.meta?.ua ?? ''}`
        );
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
  const who = data.source === 'phone' ? 'phone' : data.side;
  a.href = URL.createObjectURL(blob);
  a.download = `imu-${who}-${rec.mode}-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  const n = data.source === 'phone' ? (data.samples?.length ?? 0) : data.reports.length;
  $('rec-status').textContent = `已保存 ${n} 条数据、${data.markers.length} 个标记`;
  log(`录制完成：${a.download}`);
  rec = null;
  $<HTMLButtonElement>('btn-rec-stop').disabled = true;
  $<HTMLButtonElement>('btn-rec-beep').disabled = false;
  $<HTMLButtonElement>('btn-rec-free').disabled = false;
}

// ---------------------------------------------------------------- 绑定
function bindUi(): void {
  // 手机
  void setupPhones();

  // Joy-Con
  if (!isWebHidSupported()) {
    $('hid-support').innerHTML =
      '<span class="bad">当前浏览器不支持 WebHID，Joy-Con 请用桌面版 Chrome 或 Edge。</span>';
    $<HTMLButtonElement>('btn-connect').disabled = true;
  } else {
    $('btn-connect').addEventListener('click', async () => {
      try {
        const ds = await requestJoyCons();
        if (ds.length === 0) log('没有选择设备');
        for (const d of ds) void attachJoyCon(d);
      } catch (e) {
        log(`连接失败：${(e as Error).message}`);
      }
    });
    onJoyConConnect((d) => {
      log('检测到 Joy-Con 连接');
      void attachJoyCon(d);
    });
    onJoyConDisconnect((d) => {
      log('Joy-Con 断开');
      detachJoyCon(d);
    });
    void getGrantedJoyCons().then((ds) => ds.forEach((d) => void attachJoyCon(d)));
  }

  $('btn-layflat').addEventListener('click', () => {
    if (!active) return;
    active.motion.beginLayFlat(performance.now());
    log('平放校准：请把设备平放、保持静止 2 秒');
  });
  $('btn-recenter').addEventListener('click', () => active && recenter(active));
  $('btn-axis-reset').addEventListener('click', () => active?.axis.reset());

  const rb = $('rumble-buttons');
  for (const e of Object.keys(HAPTICS) as HapticEvent[]) {
    const b = document.createElement('button');
    b.textContent = HAPTIC_LABELS[e];
    b.addEventListener('click', () => {
      if (!active) return;
      if (active.kind === 'joycon') active.joycon!.rumble(HAPTICS[e]);
      else active.phone!.rumble(HAPTICS[e]);
    });
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
      const total = totalSamples.get(ctx.key) ?? 0;
      const dt = (now - ctx.last.t) / 1000;
      if (dt >= 1) {
        ctx.sampleHz = (total - ctx.last.samples) / dt;
        ctx.last = { samples: total, t: now };
      }
      renderCard(ctx);
    }
    if (active) {
      renderChecks(active);
      renderCalibStats(active);
      if (active.kind === 'phone') renderPhoneButtons(active.phone!.buttons);
    }
  }
  requestAnimationFrame(frame);
}

totalSamples = new Map();
bindUi();
requestAnimationFrame(frame);
