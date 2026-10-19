/**
 * 可复现的伪随机数（xoshiro128**，splitmix32 播种）。
 * 仿真里禁止用 Math.random：同一种子 + 同一输入必须得到完全相同的比赛。
 */
export interface RngState {
  s: [number, number, number, number];
  spare: number | null;
}

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private spare: number | null = null;

  constructor(seed = 1) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    const sm = splitmix32(seed);
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    this.spare = null;
  }

  /** 32 位无符号整数 */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** [0, 1) */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  /** [a, b) */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.float();
  }

  /** [a, b] 内的整数 */
  int(a: number, b: number): number {
    return a + Math.floor(this.float() * (b - a + 1));
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  /** 正态分布（Box–Muller） */
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return mean + sd * v;
    }
    let u = 0;
    while (u === 0) u = this.float();
    const v = this.float();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return mean + sd * r * Math.cos(2 * Math.PI * v);
  }

  /** 按权重挑选下标 */
  pickWeighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return 0;
    let r = this.float() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  getState(): RngState {
    return { s: [this.s0, this.s1, this.s2, this.s3], spare: this.spare };
  }

  setState(state: RngState): void {
    [this.s0, this.s1, this.s2, this.s3] = state.s;
    this.spare = state.spare;
  }
}
