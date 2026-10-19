/**
 * 程序化音效（不用任何素材）：击球「啵」、台面「哒」、网、地面、观众。
 * 浏览器要求用户点击后才能出声：第一次交互时调用 unlock()。
 */
import { clamp } from '@/core/math';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  enabled = true;

  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      this.noise = this.makeNoise(1);
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = this.makeImpulse(1.6);
      this.reverbGain = this.ctx.createGain();
      this.reverbGain.gain.value = 0;
      this.reverb.connect(this.reverbGain).connect(this.master);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && this.enabled;
  }

  /** 回声湿声比例（长回合时加回声） */
  setEcho(wet: number): void {
    if (this.reverbGain && this.ctx)
      this.reverbGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.3);
  }

  /** 击球：力度 q ∈ [0,1]；pan ∈ [−1,1] */
  hit(q: number, pan: number, smash = false): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this.panner(pan);
    const gain = 0.6 + 0.4 * clamp(q, 0, 1);
    const jitter = 1 + (Math.random() - 0.5) * 0.06;
    this.noiseBurst(t, 1800 * (1 + 0.25 * q) * jitter, 3, 0.015, gain * 0.9, out);
    this.tone(t, 820 * (1 + 0.15 * q) * jitter, 0.035, gain * 0.6, out);
    if (smash) this.tone(t, 180, 0.08, 0.7, out);
  }

  table(impact: number, pan: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const out = this.panner(pan);
    const g = clamp(impact / 4, 0.15, 1);
    this.noiseBurst(t, 3200, 4, 0.01, g * 0.7, out);
    this.tone(t, 1350, 0.02, g * 0.45, out);
  }

  net(impact: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(t, 700, 1.2, 0.05, clamp(impact / 5, 0.2, 0.8), this.panner(0), 'lowpass');
  }

  floor(impact: number, pan: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const g = clamp(impact / 4, 0.05, 0.5);
    this.noiseBurst(t, 1500, 2, 0.02, g, this.panner(pan));
    this.tone(t, 600, 0.03, g * 0.5, this.panner(pan));
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
    this.tone(this.ctx!.currentTime, freq, dur, gain, this.master!);
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

  private noiseBurst(
    t: number,
    freq: number,
    q: number,
    decay: number,
    gain: number,
    out: AudioNode,
    type: BiquadFilterType = 'bandpass'
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay * 5);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay * 5 + 0.02);
  }

  private tone(t: number, freq: number, decay: number, gain: number, out: AudioNode): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay * 5);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + decay * 5 + 0.02);
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
