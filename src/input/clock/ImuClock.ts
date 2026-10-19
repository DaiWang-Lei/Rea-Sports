/**
 * 给 IMU 样本打时间戳。
 *
 * Joy-Con 的 0x30 报告大约每 15ms 到一次（有的蓝牙栈是 11ms），每个报告带 3 个样本，最旧的在前。
 * 蓝牙到达时间有抖动，直接用到达时间会让样本间隔忽大忽小，影响积分与挥拍判定。做法：
 *  - 样本序号 n：每个报告 +3；丢包时多加。丢包判断优先用报告里的计时字节（先学出每报告增量 k，
 *    之后丢包数 = round(Δtimer/k) − 1，并持续校验模型）；没有可靠模型时按「到达间隔 > 1.9·T_r」判断；
 *  - 样本周期 T_s：最近 10 秒内「到达时间 ~ 样本序号」的最小二乘斜率（抖动是独立噪声，长基线下斜率很准，
 *    也能跟上手柄与电脑之间的时钟漂移）；数据不够时用平均到达间隔 / 3；
 *  - 时间偏移：最近 1 秒内 (到达时间 − n·T_s) 的最小值（最小值 = 抖动最小的那次），再减 λ。
 * 输出时间与到达时间（event.timeStamp / performance.now()）同一时间基准。
 */

const LEARN_TIMER_SAMPLES = 100;
const HISTORY_MS = 10000;
const HISTORY_MAX = 1200;
const MIN_FIT_SPAN_MS = 1000;
const OFFSET_WINDOW_MS = 1000;
const LAMBDA_MS = 4;
const DEFAULT_REPORT_INTERVAL_MS = 15;
/** 没有可用计时字节模型时，按到达间隔判断丢包的阈值（倍数）；取大一些，避免把抖动当丢包 */
const GAP_DROP_FACTOR = 1.9;
/** 超过这个间隔视为连接中断，重新同步 */
const RESYNC_GAP_MS = 250;
/** 计时字节模型校验：最近若干报告里 Δtimer/k 偏离整数的比例超过阈值就弃用模型 */
const VALIDATE_WINDOW = 200;
const VALIDATE_MAX_BAD_RATIO = 0.1;
/** 学习阶段：至少这么多比例的增量与 k 的整数倍吻合才采用 */
const LEARN_MIN_CONSISTENCY = 0.9;

export interface ReportTiming {
  /** 3 个样本的时间，最旧的在前 */
  times: [number, number, number];
  /** 本报告之前丢失的报告数 */
  dropped: number;
}

export interface ImuClockStats {
  reportIntervalMs: number;
  sampleIntervalMs: number;
  /** 学到的计时字节每报告增量；null 表示尚未学会或模型不成立 */
  timerStep: number | null;
  reports: number;
  droppedReports: number;
  resyncs: number;
  /** 最新报告的到达时间减去推算时间（≥ λ，越大说明这次蓝牙延迟越大） */
  lastLatencyMs: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function offInteger(ratio: number): boolean {
  return Math.round(ratio) < 1 || Math.abs(ratio - Math.round(ratio)) > 0.25;
}

export class ImuClock {
  private sampleMs = DEFAULT_REPORT_INTERVAL_MS / 3;
  private timerDeltas: number[] = [];
  private timerStep: number | null = null;
  private validation: boolean[] = [];

  private lastArrival = NaN;
  private lastTimer = -1;
  /** 最新样本的序号 */
  private n = -1;
  private history: Array<{ arrival: number; n: number }> = [];

  private reports = 0;
  private droppedReports = 0;
  private resyncs = 0;
  private lastLatency = 0;

  reset(): void {
    this.sampleMs = DEFAULT_REPORT_INTERVAL_MS / 3;
    this.timerDeltas = [];
    this.timerStep = null;
    this.validation = [];
    this.lastArrival = NaN;
    this.lastTimer = -1;
    this.n = -1;
    this.history = [];
    this.reports = 0;
    this.droppedReports = 0;
    this.resyncs = 0;
    this.lastLatency = 0;
  }

  get sampleInterval(): number {
    return this.sampleMs;
  }

  get reportInterval(): number {
    return this.sampleMs * 3;
  }

  stats(): ImuClockStats {
    return {
      reportIntervalMs: this.reportInterval,
      sampleIntervalMs: this.sampleMs,
      timerStep: this.timerStep,
      reports: this.reports,
      droppedReports: this.droppedReports,
      resyncs: this.resyncs,
      lastLatencyMs: this.lastLatency,
    };
  }

  onReport(arrival: number, timer: number): ReportTiming {
    this.reports++;
    let dropped = 0;

    if (this.n < 0) {
      this.n = 2;
    } else {
      const gap = arrival - this.lastArrival;
      const dTimer = (timer - this.lastTimer + 256) & 0xff;
      const tr = this.reportInterval;
      const gapDrops = gap > GAP_DROP_FACTOR * tr ? Math.max(0, Math.round(gap / tr) - 1) : 0;

      if (gap > RESYNC_GAP_MS) {
        // 长时间中断：计时字节可能已经绕回，按到达间隔估算丢包，并清空历史
        dropped = Math.max(0, Math.round(gap / tr) - 1);
        this.history = [];
        this.resyncs++;
      } else if (this.timerStep !== null) {
        const ratio = dTimer / this.timerStep;
        this.validate(offInteger(ratio));
        dropped = this.timerStep !== null ? Math.max(0, Math.round(ratio) - 1) : gapDrops;
      } else {
        dropped = gapDrops;
        this.learnTimer(gap, dTimer);
      }

      this.droppedReports += dropped;
      this.n += 3 * (1 + dropped);
    }

    this.lastArrival = arrival;
    this.lastTimer = timer;
    this.history.push({ arrival, n: this.n });
    const cutoff = arrival - HISTORY_MS;
    let old = 0;
    while (old < this.history.length - 1 && this.history[old].arrival < cutoff) old++;
    if (this.history.length - old > HISTORY_MAX) old = this.history.length - HISTORY_MAX;
    if (old > 0) this.history.splice(0, old);

    this.fitSampleInterval();

    const ts = this.sampleMs;
    let minOffset = Infinity;
    const offsetCutoff = arrival - OFFSET_WINDOW_MS;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i];
      if (e.arrival < offsetCutoff) break;
      const c = e.arrival - e.n * ts;
      if (c < minOffset) minOffset = c;
    }
    const t0 = minOffset - LAMBDA_MS;
    const newest = t0 + this.n * ts;
    this.lastLatency = arrival - newest;
    return { times: [newest - 2 * ts, newest - ts, newest], dropped };
  }

  private learnTimer(gap: number, dTimer: number): void {
    if (gap > 1.5 * this.reportInterval || dTimer === 0) return;
    this.timerDeltas.push(dTimer);
    if (this.timerDeltas.length < LEARN_TIMER_SAMPLES) return;
    const k = median(this.timerDeltas);
    const consistent = this.timerDeltas.filter((d) => !offInteger(d / k)).length;
    if (k > 0 && consistent / this.timerDeltas.length >= LEARN_MIN_CONSISTENCY) {
      this.timerStep = k;
      this.validation = [];
      // 学会之前按到达间隔判断的丢包可能有误判，序号不一致的旧点会把斜率拟合带偏：只保留最新一点
      this.history = this.history.slice(-1);
    }
    this.timerDeltas = [];
  }

  /** 记录一次计时字节模型是否「不吻合」；不吻合太多就弃用模型、重新学习 */
  private validate(bad: boolean): void {
    this.validation.push(bad);
    if (this.validation.length > VALIDATE_WINDOW) this.validation.shift();
    if (this.validation.length < 50) return;
    let badCount = 0;
    for (const b of this.validation) if (b) badCount++;
    if (badCount / this.validation.length > VALIDATE_MAX_BAD_RATIO) {
      this.timerStep = null;
      this.validation = [];
      this.history = this.history.slice(-1);
    }
  }

  /** 到达时间对样本序号的最小二乘斜率 = 样本周期 */
  private fitSampleInterval(): void {
    const h = this.history;
    if (h.length < 2) return;
    const span = h[h.length - 1].arrival - h[0].arrival;
    if (span < MIN_FIT_SPAN_MS || h.length < 30) {
      // 数据不够：用平均到达间隔
      const dn = h[h.length - 1].n - h[0].n;
      if (dn > 0 && span > 0 && h.length >= 10) this.sampleMs = span / dn;
      return;
    }
    let mn = 0;
    let ma = 0;
    for (const e of h) {
      mn += e.n;
      ma += e.arrival;
    }
    mn /= h.length;
    ma /= h.length;
    let cov = 0;
    let varN = 0;
    for (const e of h) {
      const dn = e.n - mn;
      cov += dn * (e.arrival - ma);
      varN += dn * dn;
    }
    if (varN <= 0) return;
    const slope = cov / varN;
    if (slope > 1 && slope < 10) this.sampleMs = slope;
  }
}
