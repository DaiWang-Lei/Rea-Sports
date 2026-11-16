/**
 * 节奏指标（纯逻辑）：从一串带时刻的事件（视频里手动打的点，或者仿真里的比赛事件）算出
 * 击球间隔、球的飞行时间、抛球滞空等，用来把我们的手感和 WSR / NSSR 的实机视频对比（计划 M4）。
 */
import type { MatchEvent } from '@/sim/MatchSim';

export type RhythmKind = 'hit' | 'serve' | 'smash' | 'bounce' | 'toss' | 'end';

export interface RhythmEvent {
  /** 秒 */
  t: number;
  kind: RhythmKind;
}

export type MetricKey =
  'interval' | 'flight' | 'smashFlight' | 'bounceToHit' | 'tossToServe' | 'serveFlight';

export const METRICS: Array<{ key: MetricKey; name: string }> = [
  { key: 'interval', name: '两次击球的间隔' },
  { key: 'flight', name: '击球 → 落到对方台' },
  { key: 'smashFlight', name: '扣杀 → 落台' },
  { key: 'bounceToHit', name: '落台 → 击球' },
  { key: 'tossToServe', name: '抛球 → 发球击球' },
  { key: 'serveFlight', name: '发球 → 落到对方台' },
];

/** 同一回合里两个事件隔得比这还久就当成新回合（视频里没打「回合结束」时） */
const RALLY_GAP = 3;

const isHit = (k: RhythmKind) => k === 'hit' || k === 'serve' || k === 'smash';

/** 按回合切开：「回合结束」或者间隔太久 */
export function splitRallies(events: RhythmEvent[]): RhythmEvent[][] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const out: RhythmEvent[][] = [];
  let cur: RhythmEvent[] = [];
  for (const e of sorted) {
    const last = cur[cur.length - 1];
    if (e.kind === 'end' || (last && e.t - last.t > RALLY_GAP)) {
      if (cur.length) out.push(cur);
      cur = [];
      if (e.kind === 'end') continue;
    }
    cur.push(e);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 每种指标的所有样本（秒） */
export function rhythmSamples(events: RhythmEvent[]): Record<MetricKey, number[]> {
  const s: Record<MetricKey, number[]> = {
    interval: [],
    flight: [],
    smashFlight: [],
    bounceToHit: [],
    tossToServe: [],
    serveFlight: [],
  };
  for (const r of splitRallies(events)) {
    for (let i = 0; i < r.length; i++) {
      const e = r[i];
      if (isHit(e.kind)) {
        // 下一次击球之前的落台
        const bounces: RhythmEvent[] = [];
        let next: RhythmEvent | null = null;
        for (let j = i + 1; j < r.length; j++) {
          if (isHit(r[j].kind)) {
            next = r[j];
            break;
          }
          if (r[j].kind === 'bounce') bounces.push(r[j]);
        }
        if (next) s.interval.push(next.t - e.t);
        if (e.kind === 'serve') {
          // 发球先落本方台，第二跳在对方台
          if (bounces[1]) s.serveFlight.push(bounces[1].t - e.t);
        } else if (bounces[0]) {
          (e.kind === 'smash' ? s.smashFlight : s.flight).push(bounces[0].t - e.t);
        }
        if (next && bounces.length) s.bounceToHit.push(next.t - bounces[bounces.length - 1].t);
      } else if (e.kind === 'toss') {
        const serve = r.slice(i + 1).find((x) => isHit(x.kind) || x.kind === 'toss');
        if (serve?.kind === 'serve') s.tossToServe.push(serve.t - e.t);
      }
    }
  }
  return s;
}

export interface Summary {
  n: number;
  median: number;
  mean: number;
}

export function summarize(v: number[]): Summary {
  if (!v.length) return { n: 0, median: NaN, mean: NaN };
  const sorted = [...v].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: v.length, median, mean: v.reduce((a, b) => a + b, 0) / v.length };
}

/** 仿真的比赛事件 → 节奏事件（只取对比需要的；擦网重发、中断的那一分也当回合结束） */
export function fromMatchEvents(events: MatchEvent[]): RhythmEvent[] {
  const out: RhythmEvent[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'hit':
        out.push({ t: e.t, kind: e.serve ? 'serve' : e.smash ? 'smash' : 'hit' });
        break;
      case 'bounce':
        out.push({ t: e.t, kind: 'bounce' });
        break;
      case 'toss':
        out.push({ t: e.t, kind: 'toss' });
        break;
      case 'point':
      case 'let':
      case 'replay':
        out.push({ t: e.t, kind: 'end' });
        break;
      default:
        break;
    }
  }
  return out;
}
