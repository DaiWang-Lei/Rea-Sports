/**
 * 手机控制器页：读取 devicemotion / deviceorientation，换算成机体系后实时发给电脑；
 * 屏幕上的按钮相当于 Joy-Con 的按键；电脑可以让手机震动（安卓）。
 */
import '@/styles/base.css';
import './phone.css';
import {
  AccelSignDetector,
  type GameToPhoneMessage,
  type PhoneButton,
  type PhoneMessage,
  phoneToBody,
  type Platform,
} from '@/input/phone/protocol';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ua = navigator.userAgent;
const platform: Platform = /iPhone|iPad|iPod/.test(ua)
  ? 'ios'
  : /Android/.test(ua)
    ? 'android'
    : 'other';
const canVibrate = typeof navigator.vibrate === 'function';

function deviceName(): string {
  if (platform === 'ios') return 'iPhone';
  const m = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/);
  return m ? m[1].trim().slice(0, 30) : platform === 'android' ? '安卓手机' : '手机';
}

function phoneId(): string {
  try {
    const saved = localStorage.getItem('rea-phone-id');
    if (saved) return saved;
    const id = Math.random().toString(36).slice(2, 10);
    localStorage.setItem('rea-phone-id', id);
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

const id = phoneId();
const name = deviceName();

// ---------------------------------------------------------------- 连接
let ws: WebSocket | null = null;
let connected = false;

function setStatus(): void {
  const el = $('status');
  if (!connected) {
    el.textContent = '正在连接电脑…';
    el.className = 'status warn';
    return;
  }
  el.textContent = started
    ? `已连接电脑 · ${hz.toFixed(0)} 次/秒${signText()}`
    : '已连接电脑 · 点「开始」';
  el.className = `status ${started && hz > 30 ? 'ok' : 'warn'}`;
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}/motion?role=phone&id=${id}&name=${encodeURIComponent(name)}`
  );
  ws.onopen = () => {
    connected = true;
    setStatus();
    sendMeta();
  };
  ws.onmessage = (e) => {
    let msg: GameToPhoneMessage;
    try {
      msg = JSON.parse(e.data as string);
    } catch {
      return;
    }
    if (msg.type === 'vibrate') {
      if (canVibrate) navigator.vibrate(msg.pattern);
    } else if (msg.type === 'ping') {
      send({ type: 'pong', t: msg.t });
    } else if (msg.type === 'info') {
      $('info').textContent = msg.text;
    }
  };
  ws.onclose = () => {
    connected = false;
    setStatus();
    setTimeout(connect, 1000);
  };
}

function send(msg: PhoneMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendMeta(): void {
  send({
    type: 'meta',
    platform,
    ua: ua.slice(0, 160),
    accelSign: detector.sign,
    hz,
    canVibrate,
    hasGyro,
  });
}

// ---------------------------------------------------------------- 体感
const detector = new AccelSignDetector();
let started = false;
let hasGyro = true;
let beta: number | null = null;
let gamma: number | null = null;
let seq = 0;
let hz = 0;
let count = 0;
let lastHzAt = performance.now();
let startedAt = 0;

function signText(): string {
  if (detector.sign === 1) return ' · 方向校准完成';
  if (detector.sign === -1) return ' · 方向校准完成（已自动修正）';
  return performance.now() - startedAt < 2500 ? ' · 请先屏幕朝上平放' : '';
}

function onOrientation(e: DeviceOrientationEvent): void {
  beta = e.beta;
  gamma = e.gamma;
}

function onMotion(e: DeviceMotionEvent): void {
  const rr = e.rotationRate;
  const a = e.accelerationIncludingGravity;
  if (!rr || rr.alpha === null || rr.beta === null || rr.gamma === null) {
    if (hasGyro) {
      hasGyro = false;
      $('setup-msg').textContent = '这台手机的浏览器没有提供陀螺仪数据，无法当球拍使用。';
      sendMeta();
    }
    return;
  }
  if (!a || a.x === null || a.y === null || a.z === null) return;
  const acc = { x: a.x, y: a.y, z: a.z };
  const rate = { alpha: rr.alpha, beta: rr.beta, gamma: rr.gamma };
  detector.add(acc, beta, gamma, Math.hypot(rate.alpha, rate.beta, rate.gamma));

  // 加速度符号还没判断出来时先不发（最多等 2 秒，之后按标准约定）
  const now = performance.now();
  const sign = detector.sign !== 0 ? detector.sign : now - startedAt > 2000 ? 1 : 0;
  count++;
  if (now - lastHzAt >= 1000) {
    hz = (count * 1000) / (now - lastHzAt);
    count = 0;
    lastHzAt = now;
    setStatus();
    sendMeta();
    updateDebug();
  }
  if (sign === 0) return;
  const body = phoneToBody(rate, acc, sign);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  send({
    type: 'imu',
    seq: seq++,
    t: Math.round(e.timeStamp * 100) / 100,
    g: [r2(body.gyro.x), r2(body.gyro.y), r2(body.gyro.z)],
    a: [r4(body.accel.x), r4(body.accel.y), r4(body.accel.z)],
  });
}

type PermissionFn = () => Promise<'granted' | 'denied'>;

async function start(): Promise<void> {
  const msg = $('setup-msg');
  if (!window.isSecureContext) {
    msg.textContent = '需要用 https:// 开头的地址打开这个页面（扫电脑上的二维码即可）。';
    return;
  }
  try {
    const dme = DeviceMotionEvent as unknown as { requestPermission?: PermissionFn };
    if (typeof dme.requestPermission === 'function') {
      const r = await dme.requestPermission();
      if (r !== 'granted') {
        msg.textContent =
          '没有获得「动作与方向」权限。请关掉这个标签页后重新打开，再点「开始」并选择「允许」。';
        return;
      }
    }
    const doe = DeviceOrientationEvent as unknown as { requestPermission?: PermissionFn };
    if (typeof doe.requestPermission === 'function') await doe.requestPermission();
  } catch (e) {
    msg.textContent = `申请体感权限失败：${(e as Error).message}`;
    return;
  }
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('deviceorientation', onOrientation);
  started = true;
  startedAt = performance.now();
  $('setup').hidden = true;
  $('controls').hidden = false;
  void keepAwake();
  setStatus();
  window.setTimeout(() => {
    if (count === 0 && hz === 0) {
      msg.textContent =
        '没有收到体感数据：请确认浏览器允许了「动作与方向」，或换 Chrome / Safari 试试。';
      $('setup').hidden = false;
    }
  }, 2500);
}

// ---------------------------------------------------------------- 常亮与按钮
let wakeLock: WakeLockSentinel | null = null;

async function keepAwake(): Promise<void> {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // 不支持就算了
  }
}

// 页面切到后台时浏览器会自动释放常亮锁，回来时重新申请
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && started && (!wakeLock || wakeLock.released)) {
    void keepAwake();
  }
});

function bindButton(el: HTMLElement): void {
  const name = el.dataset.btn as PhoneButton;
  const press = (down: boolean) => (e: Event) => {
    e.preventDefault();
    if (el.classList.contains('down') === down) return;
    el.classList.toggle('down', down);
    send({ type: 'btn', name, down });
    if (down && canVibrate) navigator.vibrate(12);
  };
  el.addEventListener('pointerdown', press(true));
  el.addEventListener('pointerup', press(false));
  el.addEventListener('pointercancel', press(false));
  el.addEventListener('pointerleave', press(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function updateDebug(): void {
  $('debug').textContent =
    `${platform} · ${name} · id ${id} · 加速度符号 ${detector.sign || '判断中'} · ` +
    `震动 ${canVibrate ? '支持' : '不支持'}`;
}

$('btn-start').addEventListener('click', () => void start());
for (const el of document.querySelectorAll<HTMLElement>('[data-btn]')) bindButton(el);
updateDebug();
connect();
