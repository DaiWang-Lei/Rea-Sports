/**
 * 把另一台设备（手机）的时间戳换算到本机时间：
 * 偏移 = 最近一段时间内 (本机到达时间 − 远端时间戳) 的最小值（网络抖动最小的那次），再减 λ。
 * 远端时间戳之间的间隔保持不变，所以样本间隔不受 Wi-Fi 抖动影响。
 */
export class OffsetClock {
  private window: Array<{ arrival: number; remote: number }> = [];
  private offset = NaN;

  constructor(
    private readonly windowMs = 2000,
    private readonly lambdaMs = 2
  ) {}

  reset(): void {
    this.window = [];
    this.offset = NaN;
  }

  /** 记录一次到达并返回远端时间对应的本机时间 */
  map(remote: number, arrival: number): number {
    this.window.push({ arrival, remote });
    const cutoff = arrival - this.windowMs;
    let drop = 0;
    while (drop < this.window.length - 1 && this.window[drop].arrival < cutoff) drop++;
    if (drop > 0) this.window.splice(0, drop);
    let min = Infinity;
    for (const e of this.window) min = Math.min(min, e.arrival - e.remote);
    this.offset = min;
    return remote + min - this.lambdaMs;
  }

  /** 当前这一次到达比「最快那次」慢了多少（毫秒），用来显示网络抖动 */
  latency(remote: number, arrival: number): number {
    return Number.isNaN(this.offset) ? 0 : arrival - remote - this.offset;
  }
}
