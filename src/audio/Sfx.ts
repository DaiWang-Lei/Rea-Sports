/**
 * 程序化音效（不用任何素材）：击球「啵」、台面「哒」、网、地面、观众。
 * 乒乓球的声音是一下极短的宽频「咔」（球壳撞击，1–2ms），加上拍子 / 台面几个很快衰减的共振（300–2500Hz，
 * 衰减 5–25ms），没有拖长的音调。按真实录音（维基共享资源公有领域的「Ping pong.ogg」）的频谱和衰减定的参数：
 * 共振峰集中在 300–1500Hz，大多 10–50ms 内衰减 20dB。
 * 浏览器要求用户点击后才能出声：第一次交互时调用 unlock()。
 */
import { clamp } from '@/core/math';

/** 一个共振：频率（Hz）、衰减时间常数（秒）、相对幅度 */
interface Mode {
  f: number;
  tau: number;
  a: number;
}

/** 拍子（木板 + 胶皮）：胶皮吸收高频，「咔」偏软 */
const PADDLE_MODES: Mode[] = [
  { f: 550, tau: 0.014, a: 1 },
  { f: 1150, tau: 0.009, a: 0.6 },
  { f: 2300, tau: 0.005, a: 0.35 },
];
/** 台面（大块木板）：低一点、衰减稍长，「咔」更脆 */
const TABLE_MODES: Mode[] = [
  { f: 380, tau: 0.025, a: 0.7 },
  { f: 900, tau: 0.014, a: 1 },
  { f: 1700, tau: 0.007, a: 0.45 },
];
const NET_MODES: Mode[] = [{ f: 250, tau: 0.02, a: 1 }];
const FLOOR_MODES: Mode[] = [
  { f: 220, tau: 0.03, a: 1 },
  { f: 700, tau: 0.012, a: 0.5 },
];

export class Sfx {
  private ctx: BaseAudioContext | null = null;
  private offline = false;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  enabled = true;

  unlock(): void {
    if (!this.ctx) this.attach(new AudioContext({ latencyHint: 'interactive' }));
    const ctx = this.ctx as AudioContext;
    if (!this.offline && ctx.state === 'suspended') void ctx.resume();
  }

  /** 接到一个音频上下文（游戏里是 AudioContext；也可以是 OfflineAudioContext，用来离线渲染检查音色） */
  attach(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    this.noise = this.makeNoise(1);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(1.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0;
    this.reverb.connect(this.reverbGain).connect(this.master);
  }

  get ready(): boolean {
    return !!this.ctx && this.enabled && (this.offline || this.ctx.state === 'running');
  }

  /** 回声湿声比例（长回合时加回声） */
  setEcho(wet: number): void {
    if (this.reverbGain && this.ctx)
      this.reverbGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.3);
  }

  /** 击球：力度 q ∈ [0,1]；pan ∈ [−1,1] */
  hit(q: number, pan: number, smash = false): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const out = this.panner(pan);
    const k = clamp(q, 0, 1);
    const gain = 0.55 + 0.45 * k;
    // 用力越大「咔」越亮
    this.click(t, 1500, 4500 + 3000 * k, 0.0015, gain * 5, out);
    this.modes(t, PADDLE_MODES, gain * 0.55, out);
    if (smash) this.modes(t, [{ f: 180, tau: 0.03, a: 1 }], 0.6, out);
  }

  table(impact: number, pan: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const out = this.panner(pan);
    const g = clamp(impact / 4, 0.15, 1);
    this.click(t, 2000, 12000, 0.0012, g * 7, out);
    this.modes(t, TABLE_MODES, g * 0.5, out);
  }

  net(impact: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const out = this.panner(0);
    const g = clamp(impact / 5, 0.2, 0.8);
    this.click(t, 200, 900, 0.006, g * 0.6, out);
    this.modes(t, NET_MODES, g * 0.4, out);
  }

  floor(impact: number, pan: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const out = this.panner(pan);
    const g = clamp(impact / 4, 0.05, 0.5);
    this.click(t, 800, 6000, 0.0012, g * 2.5, out);
    this.modes(t, FLOOR_MODES, g * 0.5, out);
  }

  /** 观众：一声欢呼（得分）或跟拍的「嘿」 */
  crowd(kind: 'cheer' | 'chant', amount = 1): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = kind === 'cheer' ? 1.4 : 0.22;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = kind === 'cheer' ? 900 : 450;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    const peak = (kind === 'cheer' ? 0.35 : 0.25) * amount;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (kind === 'cheer' ? 0.15 : 0.03));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** 提示音（菜单、计时） */
  beep(freq = 880, dur = 0.12, gain = 0.3): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const osc = this.ctx!.createOscillator();
    osc.frequency.value = freq;
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // ---------------------------------------------------------------- 内部

  private panner(pan: number): AudioNode {
    const ctx = this.ctx!;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(this.master!);
    p.connect(this.reverb!);
    return p;
  }

  /** 撞击的「咔」：一小段带通噪声，按时间常数 tau 指数衰减 */
  private click(t: number, lo: number, hi: number, tau: number, gain: number, out: AudioNode) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = lo;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = hi;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.setTargetAtTime(0, t, tau);
    src.connect(hp).connect(lp).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + tau * 10 + 0.005);
  }

  /** 共振：每个模态一个正弦，频率随机偏 ±3%（每一下都不完全一样），按各自的时间常数衰减 */
  private modes(t: number, modes: Mode[], gain: number, out: AudioNode): void {
    const ctx = this.ctx!;
    const detune = 1 + (Math.random() - 0.5) * 0.06;
    for (const m of modes) {
      const osc = ctx.createOscillator();
      osc.frequency.value = m.f * detune;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * m.a, t);
      g.gain.setTargetAtTime(0, t, m.tau);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + m.tau * 10 + 0.005);
    }
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private makeImpulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }
}
