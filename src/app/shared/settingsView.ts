/**
 * 设置面板（电视界面）：主菜单的「设置」和各个玩法暂停里的「设置」共用。一行一项「◀ 值 ▶」，左右改、立即生效、存在本机：
 * 1P / 2P 的持拍手、击球宽容度、时机提示、观众声、画面延迟补偿（按这块屏幕记）。
 * 从主菜单进来时多一项「手柄和手机」：看连着哪些设备、连新的 Joy-Con、手机二维码。
 * 还有暂停里的「重新校准」（calibrateView）。
 */
import QRCode from 'qrcode';
import type { Sfx } from '@/audio/Sfx';
import { type OverlayView, spinRow, type TvOverlay, tvButton } from '@/ui/tv/TvOverlay';
import type { MotionInput } from '../input/MotionInput';
import {
  CROWD_GAIN,
  CROWD_TEXT,
  CROWD_VOLUMES,
  loadCrowdVolume,
  saveCrowdVolume,
} from './crowdVolume';
import { latencyMs, setLatencyMs } from './latency';
import { LENIENCY_LEVELS, loadPrefs, type Prefs, savePrefs } from './prefs';
import { deviceWords } from './SetupFlow';

export interface SettingsDeps {
  sfx: Sfx;
  input: MotionInput;
  /** 几个人在玩（2 = 多一行 2P 的持拍手） */
  players: number;
  /** 设置改了：玩法里马上用上（持拍手、宽容度、时机提示） */
  onChange?: (p: Prefs) => void;
  /** 「返回」或 B */
  onBack: () => void;
  /** 有「手柄和手机」这一项（主菜单进来时） */
  devices?: boolean;
}

/** 设置面板：画在给定的电视面板上 */
export class SettingsPanel {
  /** 正在看「手柄和手机」 */
  private deviceList = false;

  constructor(
    private readonly deps: SettingsDeps,
    private readonly overlay: TvOverlay
  ) {}

  /** 显示设置（keepFocus = 改了一项后重画，焦点留在原处） */
  show(keepFocus = false): void {
    const redraw = () => this.show(true);
    const view = this.deviceList
      ? devicesView(this.deps, () => {
          this.deviceList = false;
          this.show();
        })
      : settingsView(this.deps, redraw, () => {
          this.deviceList = true;
          this.show();
        });
    this.overlay.show(view, keepFocus);
    drawQr(this.overlay.el, this.deps.input);
  }
}

const hand = (h: 1 | -1) => (h === 1 ? '右手' : '左手');
const cycle = <T>(list: readonly T[], cur: T, d: -1 | 1): T =>
  list[(Math.max(0, list.indexOf(cur)) + d + list.length) % list.length];

function settingsView(
  deps: SettingsDeps,
  redraw: () => void,
  openDevices: () => void
): OverlayView {
  const p = loadPrefs();
  const len = LENIENCY_LEVELS.reduce((a, b) =>
    Math.abs(b.v - p.leniency) < Math.abs(a.v - p.leniency) ? b : a
  );
  const crowd = loadCrowdVolume();
  const rows = [
    spinRow('h0', deps.players > 1 ? '1P 持拍手' : '持拍手', hand(p.handed[0])),
    deps.players > 1 ? spinRow('h1', '2P 持拍手', hand(p.handed[1])) : '',
    spinRow('len', '击球宽容度', len.text),
    spinRow('hint', '时机提示', p.timingHint ? '显示' : '不显示'),
    spinRow('crowd', '观众声', CROWD_TEXT[crowd]),
    spinRow('lat', '画面延迟补偿', `${latencyMs()} ms`),
  ].join('');
  return {
    html: `<h2>设置</h2>${rows}
      <p class="tv-note">画面延迟补偿：击球总显示「晚」就调大，总显示「早」就调小（按这块屏幕记）</p>
      <div class="tv-buttons tv-inline">
        ${deps.devices ? tvButton('devices', '手柄和手机') : ''}
        ${tvButton('back', '返回', true)}
      </div>`,
    hints: [
      ['▲▼', '选择'],
      ['◀▶', '修改'],
      ['B', '返回'],
    ],
    onBack: deps.onBack,
    onAct: (act) => {
      if (act === 'back') deps.onBack();
      else if (act === 'devices') openDevices();
    },
    onSpin: (name, d) => {
      const q = loadPrefs();
      if (name === 'h0') {
        q.handed[0] = q.handed[0] === 1 ? -1 : 1;
        deps.input.setHanded(q.handed[0]);
      } else if (name === 'h1') q.handed[1] = q.handed[1] === 1 ? -1 : 1;
      else if (name === 'len') {
        const i = LENIENCY_LEVELS.indexOf(len);
        q.leniency = LENIENCY_LEVELS[Math.max(0, Math.min(LENIENCY_LEVELS.length - 1, i + d))].v;
      } else if (name === 'hint') q.timingHint = !q.timingHint;
      else if (name === 'crowd') {
        const v = cycle(CROWD_VOLUMES, crowd, d);
        saveCrowdVolume(v);
        deps.sfx.setCrowdLevel(CROWD_GAIN[v]);
      } else if (name === 'lat') setLatencyMs(latencyMs() + 10 * d);
      if (name !== 'h0') savePrefs(q);
      deps.onChange?.(loadPrefs());
      redraw();
    },
  };
}

/** 手柄和手机：连着哪些设备、连新的 Joy-Con（要用鼠标点）、手机二维码 */
function devicesView(deps: SettingsDeps, back: () => void): OverlayView {
  const input = deps.input;
  const list = [...input.devices.values()];
  return {
    className: 'tv-wide',
    html: `<h2>手柄和手机</h2>
      <div class="tv-devices">${
        list.length
          ? list
              .map(
                (d) =>
                  `<div><b>${d.name}</b><span>${performance.now() - d.lastSampleAt < 800 ? '连接正常' : '没有数据'}</span></div>`
              )
              .join('')
          : '<div><span>还没有连接设备</span></div>'
      }</div>
      <div class="tv-qr" style="box-shadow:none;padding:0">
        <canvas width="200" height="200"></canvas>
        <div><b>用手机当球拍</b><br/>手机和电脑连同一个 Wi-Fi，用相机或浏览器扫码<br/>
        <span class="tv-note" style="text-align:left">${input.linkStatus.text}${input.room ? ` · 房间 ${input.room}` : ''}</span></div>
      </div>
      <p class="tv-note">Joy-Con 先在电脑的蓝牙设置里配对，再用鼠标点「连接 Joy-Con」（浏览器规定选设备要点一下），之后会自动连上</p>
      <div class="tv-buttons tv-inline">
        ${input.webHidSupported ? tvButton('joycon', '连接 Joy-Con') : ''}
        ${tvButton('back', '返回', true, true)}
      </div>`,
    hints: [
      ['A', '确定'],
      ['B', '返回'],
    ],
    onBack: back,
    onAct: (act) => {
      if (act === 'back') back();
      else if (act === 'joycon') void input.requestJoyCon().catch(() => {});
    },
  };
}

/** 面板里有二维码时画上 */
function drawQr(root: HTMLElement, input: MotionInput): void {
  const qr = root.querySelector<HTMLCanvasElement>('.tv-qr canvas');
  if (qr && input.phoneUrl) void QRCode.toCanvas(qr, input.phoneUrl, { width: 200, margin: 1 });
}

/** 暂停里「重新校准」：拍头像遥控器一样指向电视按 A（结果走 MotionInput 的 onCalibrate） */
export function calibrateView(input: MotionInput, back: () => void): OverlayView {
  return {
    html: `<h2>重新校准</h2>
      <p class="tv-note">把手柄的${deviceWords(input.active).head}像遥控器一样<b>指向电视</b>，按 A</p>
      <div class="tv-buttons">
        ${tvButton('calib', '指向电视了，校准', true, true)}
        ${tvButton('back', '返回')}
      </div>`,
    hints: [
      ['A', '校准'],
      ['B', '返回'],
    ],
    onBack: back,
    onAct: (act) => {
      if (act === 'calib') input.requestCalibration();
      else back();
    },
  };
}
