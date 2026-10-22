/**
 * Joy-Con 陀螺仪零点：平放在桌上不动 2 秒就重新学一次（练习开始前的「平放」步骤，以及之后任何时候放下）。
 *
 * 为什么不用 GamepadMotion 自带的静止校准：它只看读数的起伏（极差），不看大小——缓慢匀速的转动也会被当成零点；
 * 置信度满了以后又只认「和历史上最安静的时候一样静」的窗口。2026-10-21 的录制里，现场带着一个错的零点（约 0.8°/s），
 * 画面上的拍子每分钟转偏约 50°，之后的停顿（手里、腿上）都不够静，一直没纠正过来；同一份数据用出厂零点算则是稳的。
 *
 * 这里的条件：按键面朝上或朝下平放（重力在机体 ±Z 的 15° 以内）、读数稳定，先稳 0.25 秒，再累计 2 秒取平均。
 * 平放在桌上的 Joy-Con 不会转，所以平均值就是零点；放在桌上不动期间每 2 秒刷新一次。
 */
import { DEG } from '@/core/math';
import { type Vec3, vec3 } from '@/core/vec3';
import type { ImuSample } from '../types';

export interface FlatStillStatus {
  /** idle：没平放或在动；settling：刚放稳，稍等再开始；collecting：正在累计 */
  phase: 'idle' | 'settling' | 'collecting';
  /** 本次累计的进度 0..1 */
  progress: number;
}

/** 稳定判断看最近这么长的读数（毫秒） */
const GATE_MS = 250;
/** 稳定判断：窗口内各轴陀螺极差（°/s）、加速度极差（g） */
const GYRO_RANGE = 3;
const ACCEL_RANGE = 0.03;
/** 平放：重力方向离机体 ±Z 不超过 15° */
const FLAT_COS = Math.cos(15 * DEG);
const SETTLE_MS = 250;
export const FLAT_COLLECT_MS = 2000;
/** 累计结束时的检查：各轴标准差（°/s）不超过这个、各轴平均值不超过这个（再大就不是零点，是在转） */
const GYRO_SD_MAX = 1;
const BIAS_MAX = 3;

export class FlatStillCalibrator {
  status: FlatStillStatus = { phase: 'idle', progress: 0 };
  /** 最近一次学到零点时的样本时间（毫秒） */
  learnedAt = -Infinity;
  private win: ImuSample[] = [];
  private since = 0;
  private n = 0;
  private sum = vec3();
  private sq = vec3();

  /** 喂一个样本；完成一次 2 秒累计时返回新的零点（°/s），否则返回 null */
  add(s: ImuSample): Vec3 | null {
    this.win.push(s);
    while (this.win.length > 2 && s.t - this.win[0].t > GATE_MS) this.win.shift();
    if (!this.stable()) {
      this.status = { phase: 'idle', progress: 0 };
      return null;
    }
    const st = this.status;
    if (st.phase === 'idle') {
      this.status = { phase: 'settling', progress: 0 };
      this.since = s.t;
      return null;
    }
    if (st.phase === 'settling') {
      if (s.t - this.since < SETTLE_MS) return null;
      this.startCollecting(s.t);
    }
    const g = s.gyro;
    this.n++;
    this.sum = vec3(this.sum.x + g.x, this.sum.y + g.y, this.sum.z + g.z);
    this.sq = vec3(this.sq.x + g.x * g.x, this.sq.y + g.y * g.y, this.sq.z + g.z * g.z);
    const elapsed = s.t - this.since;
    this.status.progress = Math.min(1, elapsed / FLAT_COLLECT_MS);
    if (elapsed < FLAT_COLLECT_MS) return null;

    const m = vec3(this.sum.x / this.n, this.sum.y / this.n, this.sum.z / this.n);
    const sd = (q: number, mean: number) => Math.sqrt(Math.max(0, q / this.n - mean * mean));
    const ok =
      sd(this.sq.x, m.x) <= GYRO_SD_MAX &&
      sd(this.sq.y, m.y) <= GYRO_SD_MAX &&
      sd(this.sq.z, m.z) <= GYRO_SD_MAX &&
      Math.abs(m.x) <= BIAS_MAX &&
      Math.abs(m.y) <= BIAS_MAX &&
      Math.abs(m.z) <= BIAS_MAX;
    // 不管成不成，都从头再累计一轮（一直放着就每 2 秒刷新）
    this.startCollecting(s.t);
    if (!ok) return null;
    this.learnedAt = s.t;
    return m;
  }

  private startCollecting(t: number): void {
    this.status = { phase: 'collecting', progress: 0 };
    this.since = t;
    this.n = 0;
    this.sum = vec3();
    this.sq = vec3();
  }

  private stable(): boolean {
    const w = this.win;
    if (w.length < 10 || w[w.length - 1].t - w[0].t < GATE_MS * 0.8) return false;
    const last = w[w.length - 1].accel;
    const amag = Math.hypot(last.x, last.y, last.z);
    if (amag < 0.9 || amag > 1.1 || Math.abs(last.z) / amag < FLAT_COS) return false;
    // 各轴极差（不建对象：每秒要算 200 次）
    const r = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    const q = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (const s of w) {
      const g = [s.gyro.x, s.gyro.y, s.gyro.z];
      const a = [s.accel.x, s.accel.y, s.accel.z];
      for (let k = 0; k < 3; k++) {
        r[2 * k] = Math.min(r[2 * k], g[k]);
        r[2 * k + 1] = Math.max(r[2 * k + 1], g[k]);
        q[2 * k] = Math.min(q[2 * k], a[k]);
        q[2 * k + 1] = Math.max(q[2 * k + 1], a[k]);
      }
    }
    for (let k = 0; k < 3; k++) {
      if (r[2 * k + 1] - r[2 * k] > GYRO_RANGE) return false;
      if (q[2 * k + 1] - q[2 * k] > ACCEL_RANGE) return false;
    }
    return true;
  }
}
