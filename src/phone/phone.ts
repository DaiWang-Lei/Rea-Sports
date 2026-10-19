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
import { isValidRoom } from '@/net/signal';
import { type LinkState, type PhoneSideLink, RelayPhoneLink, RtcPhoneLink } from './links';

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
// 网址里带房间号 → WebRTC 直连（线上部署）；否则在本地开发服务器上用 WebSocket 中转
let link: PhoneSideLink | null = null;
let linkState: LinkState = 'connecting';
let linkDetail = '正在连接电脑…';

function setStatus(): void {
  const el = $('status');
  if (linkState !== 'connected') {
    el.textContent = linkDetail;
    el.className = `status ${linkState === 'disconnected' ? 'bad' : 'warn'}`;
    return;
  }
  el.textContent = started
    ? `${linkDetail} · ${hz.toFixed(0)} 次/秒${signText()}`
    : `${linkDetail} · 点「开始」`;
  el.className = `status ${started && hz > 30 ? 'ok' : 'warn'}`;
}

function onGameMessage(msg: GameToPhoneMessage): void {
  if (msg.type === 'vibrate') {
    if (canVibrate) navigator.vibrate(msg.pattern);
  } else if (msg.type === 'ping') {
    send({ type: 'pong', t: msg.t });
  } else if (msg.type === 'info') {
    $('info').textContent = msg.text;
  }
}

function startLink(l: PhoneSideLink): void {
  link = l;
  l.start({
    onMessage: onGameMessage,
    onState: (state, detail) => {
      linkState = state;
      linkDetail = detail;
      setStatus();
      if (state === 'connected') sendMeta();
    },
  });
}

/** 本地开发服务器才有 /api/lan */
async function isDevServer(): Promise<boolean> {
  if (!import.meta.env.DEV) return false;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/lan`);
    return res.ok && (res.headers.get('content-type') ?? '').includes('json');
  } catch {
    return false;
  }
}

async function connect(): Promise<void> {
  const room = new URLSearchParams(location.search).get('room')?.toLowerCase() ?? null;
  if (isValidRoom(room)) {
    $('room-line').textContent = `房间号 ${room}`;
    startLink(new RtcPhoneLink(room, id, name));
  } else if (await isDevServer()) {
    startLink(new RelayPhoneLink(id, name));
  } else {
    // 线上打开但没带房间号：让用户输入电脑屏幕上显示的房间号
    $('room-form').hidden = false;
    linkState = 'disconnected';
    linkDetail = '请输入电脑上显示的房间号';
    setStatus();
  }
}

function send(msg: PhoneMessage): void {
  link?.send(msg);
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
/** 有没有陀螺仪：开始前未知（按有算）；开始后收到有效数据就算有，2.5 秒内一直没有才判定为没有 */
let hasGyro = true;
let rawEvents = 0;
let validSamples = 0;
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
  rawEvents++;
  const rr = e.rotationRate;
  const a = e.accelerationIncludingGravity;
  // 有的浏览器在没有传感器或刚开始监听时会发一次全空的事件：跳过，不据此下结论
  if (!rr || rr.alpha === null || rr.beta === null || rr.gamma === null) return;
  if (!a || a.x === null || a.y === null || a.z === null) return;
  validSamples++;
  if (!hasGyro) {
    hasGyro = true;
    $('setup-msg').textContent = '';
  }
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
    if (validSamples > 0) return;
    if (rawEvents > 0) {
      hasGyro = false;
      sendMeta();
      msg.textContent =
        '这台手机的浏览器没有提供陀螺仪数据，无法当球拍使用。可以换 Chrome / Safari 试试。';
    } else {
      msg.textContent =
        '没有收到体感数据：请确认浏览器允许了「动作与方向」，或换 Chrome / Safari 试试。';
    }
    $('setup').hidden = false;
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
$('room-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = ($<HTMLInputElement>('room-input').value || '').trim().toLowerCase();
  if (isValidRoom(v)) location.search = `?room=${v}`;
});
for (const el of document.querySelectorAll<HTMLElement>('[data-btn]')) bindButton(el);
updateDebug();
void connect();
