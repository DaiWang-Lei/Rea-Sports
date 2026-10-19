/** 简单的滚动曲线图（canvas 2D），用于调试页实时显示 IMU 数据 */

export interface SeriesDef {
  label: string;
  color: string;
}

export class ScrollChart {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly times: number[] = [];
  private readonly values: number[][];
  private markers: number[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly series: SeriesDef[],
    private readonly opts: { windowMs: number; minRange: number; unit: string; symmetric?: boolean }
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.values = series.map(() => []);
  }

  push(t: number, vals: number[]): void {
    this.times.push(t);
    for (let i = 0; i < this.series.length; i++) this.values[i].push(vals[i]);
    const cutoff = t - this.opts.windowMs;
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < cutoff) drop++;
    if (drop > 0) {
      this.times.splice(0, drop);
      for (const v of this.values) v.splice(0, drop);
    }
    this.markers = this.markers.filter((m) => m >= cutoff);
  }

  mark(t: number): void {
    this.markers.push(t);
  }

  draw(): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(canvas);
    const grid = style.getPropertyValue('--chart-grid').trim() || '#444';
    const text = style.getPropertyValue('--chart-text').trim() || '#aaa';
    const markColor = style.getPropertyValue('--chart-mark').trim() || '#f5a524';

    if (this.times.length < 2) return;
    const tEnd = this.times[this.times.length - 1];
    const tStart = tEnd - this.opts.windowMs;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.values)
      for (const x of v) {
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    if (this.opts.symmetric) {
      const m = Math.max(Math.abs(lo), Math.abs(hi), this.opts.minRange);
      lo = -m;
      hi = m;
    } else {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, this.opts.minRange);
    }
    const pad = 4;
    const x = (t: number) => ((t - tStart) / this.opts.windowMs) * w;
    const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad);

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(0));
    ctx.lineTo(w, y(0));
    ctx.stroke();

    ctx.strokeStyle = markColor;
    for (const m of this.markers) {
      ctx.beginPath();
      ctx.moveTo(x(m), 0);
      ctx.lineTo(x(m), h);
      ctx.stroke();
    }

    for (let s = 0; s < this.series.length; s++) {
      ctx.strokeStyle = this.series[s].color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const v = this.values[s];
      for (let i = 0; i < v.length; i++) {
        const px = x(this.times[i]);
        const py = y(v[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    ctx.fillStyle = text;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${hi.toFixed(hi >= 10 ? 0 : 2)} ${this.opts.unit}`, 4, 14);
    ctx.fillText(`${lo.toFixed(Math.abs(lo) >= 10 ? 0 : 2)}`, 4, h - 6);
    let lx = w - 8;
    for (let s = this.series.length - 1; s >= 0; s--) {
      const label = this.series[s].label;
      const tw = ctx.measureText(label).width;
      lx -= tw;
      ctx.fillStyle = this.series[s].color;
      ctx.fillText(label, lx, 14);
      lx -= 12;
    }
  }
}
