/**
 * 记分与发球轮换。
 *  - 一局打到 target 分（默认 6，可选 11），领先 2 分获胜；drawAt 分时双方都到即平局（WSR 是 20:20）。
 *  - 先发球方每人连发 2 分后轮换；双方都到 target−1 分（平分）后每分轮换（国际乒联规则；WSR 未确认）。
 */
import { otherSide, type Side } from '../constants';

export interface ScoreConfig {
  target: number;
  drawAt: number | null;
  firstServer: Side;
}

export type GameResult = Side | 'draw' | null;

export class Scoring {
  readonly score: Record<Side, number> = { near: 0, far: 0 };

  constructor(readonly cfg: ScoreConfig) {}

  get pointsPlayed(): number {
    return this.score.near + this.score.far;
  }

  get isDeuce(): boolean {
    const t = this.cfg.target - 1;
    return this.score.near >= t && this.score.far >= t;
  }

  server(): Side {
    const n = this.pointsPlayed;
    let idx: number;
    if (this.isDeuce) {
      const nd = 2 * (this.cfg.target - 1);
      idx = (Math.floor(nd / 2) + (n - nd)) % 2;
    } else {
      idx = Math.floor(n / 2) % 2;
    }
    return idx === 0 ? this.cfg.firstServer : otherSide(this.cfg.firstServer);
  }

  addPoint(winner: Side): void {
    if (this.result) return;
    this.score[winner]++;
  }

  get result(): GameResult {
    const { near, far } = this.score;
    const { target, drawAt } = this.cfg;
    if (drawAt !== null && near >= drawAt && far >= drawAt) return 'draw';
    if (near >= target && near - far >= 2) return 'near';
    if (far >= target && far - near >= 2) return 'far';
    return null;
  }

  /** 哪一方再得 1 分就赢（局点） */
  get gamePointFor(): Side | null {
    for (const s of ['near', 'far'] as const) {
      const me = this.score[s] + 1;
      const op = this.score[otherSide(s)];
      if (me >= this.cfg.target && me - op >= 2) return s;
    }
    return null;
  }
}
