/**
 * 音效：真实录音（Freesound 上的 CC0 素材，来源见 NOTICE），切成单下撞击后随机挑着放。
 * 以前是程序合成的，听着像电子音，合成怎么调都不像，所以换成录音。
 *  - 击球、落台、落地：每种几下不同的录音（拼在一个 WAV 里，每格 SLOT 秒，撞击在每格开头 1ms 处，不会比画面晚），
 *    随机挑一下（不连着重复同一下），音高随机偏 ±3%，力度控制音量；
 *  - 球网：落台的录音放慢、滤掉高频，闷一点；
 *  - 观众：得分欢呼、长回合得分的大欢呼、回合打长了的一声「哦——」。
 * 浏览器要求用户点击后才能出声：第一次交互时调用 unlock()。素材在创建时就开始下载，解锁后解码。
 */
import { clamp } from '@/core/math';
import cheerBigUrl from './samples/cheer-big.mp3?url';
import cheerUrl from './samples/cheer.mp3?url';
import floorUrl from './samples/floor.wav?url';
import oohUrl from './samples/ooh.mp3?url';
import paddleUrl from './samples/paddle.wav?url';
import tableUrl from './samples/table.wav?url';

/** 撞击素材每格的长度（秒） */
const SLOT = 0.1;

const FILES = {
  paddle: paddleUrl,
  table: tableUrl,
  floor: floorUrl,
  cheer: cheerUrl,
  cheerBig: cheerBigUrl,
  ooh: oohUrl,
};
type SampleName = keyof typeof FILES;

/** 撞击素材里有几下 */
const SLOTS: Partial<Record<SampleName, number>> = { paddle: 6, table: 6, floor: 3 };

/** 原始文件只下载一次（多个页面实例共用），每个音频上下文各自解码 */
let raw: Promise<Partial<Record<SampleName, ArrayBuffer>>> | null = null;
function fetchSamples(): Promise<Partial<Record<SampleName, ArrayBuffer>>> {
  raw ??= Promise.all(
    (Object.entries(FILES) as Array<[SampleName, string]>).map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        return [name, res.ok ? await res.arrayBuffer() : null] as const;
      } catch {
        return [name, null] as const;
      }
    })
  ).then((list) => Object.fromEntries(list.filter(([, b]) => b)));
  return raw;
}

export class Sfx {
  private ctx: BaseAudioContext | null = null;
  private offline = false;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private buffers: Partial<Record<SampleName, AudioBuffer>> = {};
  private decoding: Promise<void> = Promise.resolve();
  private readonly lastSlot: Partial<Record<SampleName, number>> = {};
  enabled = true;

  constructor() {
    if (typeof fetch !== 'undefined') void fetchSamples();
  }

  unlock(): void {
    if (!this.ctx) this.attach(new AudioContext({ latencyHint: 'interactive' }));
    const ctx = this.ctx as AudioContext;
    if (!this.offline && ctx.state === 'suspended') void ctx.resume();
  }

  /** 接到一个音频上下文（游戏里是 AudioContext；也可以是 OfflineAudioContext，用来离线渲染检查） */
  attach(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.master = ctx.createGain();
    this.master.gain.value = 1.4;
    this.master.connect(ctx.destination);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(1.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.decoding = this.decode(ctx);
  }

  /** 素材解码完（离线渲染时先等它） */
  loaded(): Promise<void> {
    return this.decoding;
  }

  get ready(): boolean {
    return !!this.ctx && this.enabled && (this.offline || this.ctx.state === 'running');
  }

  /** 回声湿声比例（长回合时加回声） */
  setEcho(wet: number): void {
    if (this.reverbGain && this.ctx)
      this.reverbGain.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.3);
  }

  /** 击球：力度 q ∈ [0,1]；pan ∈ [−1,1]；扣杀 / 强力发球更响、音调稍低更「实」 */
  hit(q: number, pan: number, smash = false): void {
    if (!this.ready) return;
    const gain = smash ? 1 : 0.35 + 0.6 * clamp(q, 0, 1);
    this.play('paddle', gain, smash ? 0.94 : 1, this.panner(pan));
  }

  table(impact: number, pan: number): void {
    if (!this.ready) return;
    this.play('table', 0.85 * clamp(impact / 4, 0.15, 1), 1, this.panner(pan));
  }

  net(impact: number): void {
    if (!this.ready) return;
    const lp = this.ctx!.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.connect(this.panner(0));
    this.play('table', 0.7 * clamp(impact / 5, 0.2, 0.8), 0.6, lp);
  }

  floor(impact: number, pan: number): void {
    if (!this.ready) return;
    this.play('floor', 0.7 * clamp(impact / 4, 0.1, 1), 1, this.panner(pan));
  }

  /** 观众：得分欢呼（amount ≥ 1 是长回合 / 赢下比赛的大欢呼），或回合打长了的一声「哦——」 */
  crowd(kind: 'cheer' | 'ooh', amount = 1): void {
    if (!this.ready) return;
    if (kind === 'ooh') this.play('ooh', 0.4, 1, this.master!);
    else if (amount >= 1) this.play('cheerBig', 0.45, 1, this.master!);
    else this.play('cheer', 0.4 * amount + 0.1, 1, this.master!);
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

  private async decode(ctx: BaseAudioContext): Promise<void> {
    const files = await fetchSamples();
    await Promise.all(
      (Object.entries(files) as Array<[SampleName, ArrayBuffer]>).map(async ([name, data]) => {
        try {
          // decodeAudioData 会把传进去的 ArrayBuffer 用掉，给它一份拷贝
          this.buffers[name] = await ctx.decodeAudioData(data.slice(0));
        } catch {
          // 解不开就不出这种声音
        }
      })
    );
  }

  /** 放一段素材；撞击类随机挑一格（不连着重复同一格），音高随机偏 ±3% */
  private play(name: SampleName, gain: number, rate: number, out: AudioNode): void {
    const buf = this.buffers[name];
    if (!buf) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    const slots = SLOTS[name];
    const t = ctx.currentTime;
    if (slots) {
      src.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 0.06);
      let i = Math.floor(Math.random() * slots);
      if (slots > 1 && i === this.lastSlot[name]) i = (i + 1) % slots;
      this.lastSlot[name] = i;
      src.start(t, i * SLOT, SLOT);
    } else {
      src.playbackRate.value = rate;
      src.start(t);
    }
  }

  private panner(pan: number): AudioNode {
    const ctx = this.ctx!;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(this.master!);
    p.connect(this.reverb!);
    return p;
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
