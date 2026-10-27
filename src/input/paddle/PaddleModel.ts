/**
 * 球拍模型（纯逻辑）：把设备姿态换成游戏里球拍的朝向，并给击球提供拍面特征。
 *
 * 坐标：融合世界系 W（Z 向上，偏航任意）；游戏系 G（x 右、y 朝电视/对手、z 上）。
 * 设备本身就是球拍，握法固定（见 DEVICE_GRIP）：顶端（Joy-Con 肩键一端 / 手机顶端）是拍头，
 * 正面（Joy-Con 按键面 / 手机屏幕）是红面（正手面）。
 * 电视方向由「拍头指向电视」定（setHeading）：开局校准和打球中回中都是拍头像遥控器一样指着电视按键
 * （Joy-Con 按住 X + ZR，像 Nintendo Switch Sports）→ 得到 W → G 的偏航 A。
 * 之后球拍在 G 里的姿态 R = A · q · grip。球拍局部轴：+Y = 红面法向，+Z = 拍头方向，+X = Y × Z。
 * 打球中偏航会慢慢漂（Joy-Con 握在手里变热后零点会变），等球时由 trackHeading 去掉漂移。
 *
 * 不依赖校准的特征：刷球方向（由设备在世界系的竖直速度判断，速度由去重力加速度带泄漏积分得到）。
 *
 * 拍面俯仰以「你平时击球的角度」为基准（正反手分开，见 neutralPitch）。
 */
import {
  fromAxisAngle,
  multiply,
  normalizeQ,
  type Quat,
  quat,
  rotate,
  rotateInverse,
} from '@/core/quat';
import { clamp, DEG } from '@/core/math';
import { type Vec3, vec3 } from '@/core/vec3';
import { NO_FEATURES, type SwingFeatures } from '@/sim/hit/HitResolver';
import type { Stroke } from '@/sim/players/PlayerSim';
import type { SwingSnapshot } from './SwingDetector';

const G_ACC = 9.81;
/** 速度积分的泄漏时间常数（秒）：抑制重力残差造成的漂移 */
const VEL_LEAK = 0.35;
/** 平时拍面角度：取最近几次击球、至少几次才生效、最多偏多少 */
const NEUTRAL_N = 9;
const NEUTRAL_MIN = 3;
const NEUTRAL_MAX = 60 * DEG;

/**
 * 握法（球拍局部 → 设备局部）：球拍 +Y（红面）= 机体 +Z（按键面 / 屏幕），球拍 +Z（拍头）= 机体 +X（顶端），
 * 球拍 +X = 机体 +Y。即 x → y → z → x 的轮换，绕 (1,1,1) 转 120°。Joy-Con 与手机的机体系约定相同。
 *
 * 以前在「准备姿势」那一刻测整个握法，假定此刻按键面正对电视；可回中定下的电视方向和玩家实际朝向有偏差时，
 * 偏差就被永久记进了握法（2026-10-22 的录制里歪了 32°）。同一份录制里，正手时拍子正是顺着按键面的方向运动
 * （12 次中位只差 3°，反手顺着背面），10-21 的录制也一样，所以「按键面 = 正手面」不必再测。
 */
export const DEVICE_GRIP: Quat = { w: 0.5, x: 0.5, y: 0.5, z: 0.5 };

/**
 * 自动校正电视方向（trackHeading）：只去掉漂移，不改校准定下的方向。
 * 每次校准 / 回中之后，先在等球时手安静、拍面大致竖着的时候，学你平时准备姿势里拍面朝哪
 * （红面朝前、背面朝前分开学，各攒够 1 秒安静时间取中位数）；之后等球时按时间常数 TAU 把偏航拉回这个角度，
 * 同时积分出偏航漂移速度（零点变化造成的），一直补上。
 * 2026-10-23 的版本假定等球时拍面正对电视，跟「拍头指向电视」的校准不是同一个基准，会把校准的方向拉到习惯角度上。
 * 回放录制（第一次送球时回中）：等球姿势的偏航趋势 10-22 从每分钟 38° 降到 4°，10-21 从 23° 降到 10°；
 * 两份录制都只有 85 秒，漂移速度要一分钟左右才估准。
 */
const TRACK_QUIET_W = 1.5; // 安静：角速度低于这个（弧度/秒）
const TRACK_QUIET_S = 0.15; // 并且持续这么久（秒）
const TRACK_FACE_Z = 0.7; // 红面法向竖直分量超过这个（拍子平躺）不校正
const TRACK_LEARN_S = 1; // 每种准备姿势攒够这么久的安静时间（秒）才定下角度
const TRACK_LEARN_MAX = 75 * DEG; // 拍面偏得比这还多的安静姿势不学（多半不是准备姿势）
const TRACK_MAX_ERR = 45 * DEG; // 偏得更多不自动拉（可能是在做别的动作），要玩家按回中
const TRACK_TAU = 3; // 秒
const TRACK_I_ERR = 20 * DEG; // 误差小于这个才积分漂移速度
const TRACK_KI = 0.02; // 1/秒²
const TRACK_MAX_DRIFT = 2 * DEG; // 弧度/秒
/** 回中：拍头离水平超过 60°（几乎竖着）时看不出指向哪 */
const POINT_MIN_H = 0.5;

export type ReadySide = 'front' | 'back';

export interface MotionLike {
  t: number;
  dt: number;
  q: Quat;
  /** 世界系去重力线加速度（g） */
  linAccWorld: Vec3;
}

export class PaddleModel {
  /** W → G 的偏航角（弧度）：A = Rz(yaw) */
  yaw = 0;
  hasHeading = false;
  /** 握法（球拍局部 → 设备局部），默认固定为 DEVICE_GRIP；测试里可以换 */
  grip: Quat = DEVICE_GRIP;
  /** 偏航漂移速度估计（弧度/秒）：每个样本从 yaw 里扣掉 drift·dt。重新测过陀螺仪零点后应清零 */
  drift = 0;
  /**
   * 平时准备姿势里拍面相对电视的角度（弧度，逆时针为正）：红面朝前（front）、背面朝前（back，已折到 ±90°）分开；
   * NaN = 这次校准后还没学到
   */
  readonly ready: Record<ReadySide, number> = { front: NaN, back: NaN };
  private learn: Record<ReadySide, { e: number[]; t: number }> = {
    front: { e: [], t: 0 },
    back: { e: [], t: 0 },
  };
  /** 1 右手，−1 左手 */
  handed: 1 | -1 = 1;
  /** 最新设备姿态（机体 → W） */
  q: Quat = quat();
  /** 设备在 W 里的速度（m/s，泄漏积分） */
  readonly vel: Vec3 = vec3();
  /** 速度历史（与挥拍快照的时间对齐用） */
  private velHist: Array<{ t: number; v: Vec3 }> = [];
  /** 正反手最近几次击球瞬间的拍面俯仰（原始值，弧度） */
  private contactPitch: Record<Stroke, number[]> = { fh: [], bh: [] };

  get calibrated(): boolean {
    return this.hasHeading;
  }

  update(f: MotionLike): void {
    this.q = { w: f.q.w, x: f.q.x, y: f.q.y, z: f.q.z };
    const k = Math.exp(-f.dt / VEL_LEAK);
    const a = f.linAccWorld;
    this.vel.x = this.vel.x * k + a.x * G_ACC * f.dt;
    this.vel.y = this.vel.y * k + a.y * G_ACC * f.dt;
    this.vel.z = this.vel.z * k + a.z * G_ACC * f.dt;
    this.velHist.push({ t: f.t, v: { ...this.vel } });
    while (this.velHist.length > 2 && f.t - this.velHist[0].t > 600) this.velHist.shift();
  }

  /** 某一时刻（最近的样本）的设备速度 */
  velAt(t: number): Vec3 {
    let best = this.velHist[this.velHist.length - 1]?.v ?? this.vel;
    let bestD = Infinity;
    for (const h of this.velHist) {
      const d = Math.abs(h.t - t);
      if (d < bestD) {
        bestD = d;
        best = h.v;
      }
    }
    return best;
  }

  /**
   * 定电视方向（开局校准、打球中回中）：拍头（Joy-Con 肩键一端 / 手机顶端）指向电视。
   * 只用拍头的水平方向：像遥控器一样斜着指、平放在桌上指着都行，拍面朝哪不影响；
   * 拍头几乎朝上或朝下（离水平超过 60°）时看不出指向，返回 false。
   * 之后重新学平时准备姿势的角度（见 trackHeading）；漂移速度 drift 保留（它来自零点，与回中无关）。
   */
  setHeading(q: Quat = this.q): boolean {
    const head = rotate(q, rotate(this.grip, vec3(0, 0, 1)));
    if (Math.hypot(head.x, head.y) < POINT_MIN_H) return false;
    this.yaw = Math.PI / 2 - Math.atan2(head.y, head.x);
    this.hasHeading = true;
    this.ready.front = NaN;
    this.ready.back = NaN;
    this.learn = { front: { e: [], t: 0 }, back: { e: [], t: 0 } };
    return true;
  }

  private quietFor = 0;

  /**
   * 每个样本调用一次。先按漂移速度修正偏航；correct 为真（练习 / 比赛进行中、当前设备）时，
   * 如果手安静（|gyro| 低于阈值一段时间）、拍面大致竖着：校准后还没学到平时的准备姿势就先学，
   * 学到了就在偏离不到 45° 时把偏航拉回那个角度，并更新漂移速度。gyro：去零偏角速度（机体系，弧度/秒）；dt：秒。
   */
  trackHeading(gyro: Vec3, dt: number, correct: boolean): void {
    if (!this.hasHeading || !(dt > 0)) return;
    this.yaw -= this.drift * dt;
    const w = Math.hypot(gyro.x, gyro.y, gyro.z);
    this.quietFor = w < TRACK_QUIET_W ? this.quietFor + dt : 0;
    if (!correct || this.quietFor < TRACK_QUIET_S) return;
    const r = this.paddleQuat();
    if (!r) return;
    const n = rotate(r, vec3(0, 1, 0));
    if (Math.abs(n.z) > TRACK_FACE_Z) return;
    // 红面水平朝向相对 +y 的转角（逆时针为正）；背面朝电视的姿势折到 ±90° 以内，单独学
    let e = Math.atan2(n.y, n.x) - Math.PI / 2;
    e = Math.atan2(Math.sin(e), Math.cos(e));
    const side: ReadySide = Math.abs(e) <= Math.PI / 2 ? 'front' : 'back';
    if (side === 'back') e += e > 0 ? -Math.PI : Math.PI;
    const ref = this.ready[side];
    if (Number.isNaN(ref)) {
      // 刚校准完，漂移还小：先学平时的准备姿势，不校正
      if (Math.abs(e) > TRACK_LEARN_MAX) return;
      const l = this.learn[side];
      l.e.push(e);
      l.t += dt;
      if (l.t >= TRACK_LEARN_S) {
        const sorted = [...l.e].sort((a, b) => a - b);
        this.ready[side] = sorted[sorted.length >> 1];
        l.e = [];
      }
      return;
    }
    const err = Math.atan2(Math.sin(e - ref), Math.cos(e - ref));
    if (Math.abs(err) > TRACK_MAX_ERR) return;
    this.yaw -= err * Math.min(1, dt / TRACK_TAU);
    if (Math.abs(err) < TRACK_I_ERR) {
      this.drift = clamp(this.drift + TRACK_KI * err * dt, -TRACK_MAX_DRIFT, TRACK_MAX_DRIFT);
    }
  }

  /** 球拍在 G 里的姿态（还没回中时返回 null） */
  paddleQuat(q: Quat = this.q): Quat | null {
    if (!this.hasHeading) return null;
    const a = fromAxisAngle(0, 0, 1, this.yaw);
    return normalizeQ(multiply(multiply(a, q), this.grip));
  }

  /** W 里的向量换到 G（只差一个偏航） */
  toGame(v: Vec3): Vec3 {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
  }

  /** 红面（正手面）法向，G；左手玩家按镜像后的「自己坐标系」返回 */
  faceNormal(q: Quat = this.q): Vec3 | null {
    const r = this.paddleQuat(q);
    if (!r) return null;
    const n = rotate(r, vec3(0, 1, 0));
    if (this.handed < 0) n.x = -n.x;
    return n;
  }

  /** 拍头方向（拍柄 → 拍头），G */
  bladeUp(q: Quat = this.q): Vec3 | null {
    const r = this.paddleQuat(q);
    if (!r) return null;
    return rotate(r, vec3(0, 0, 1));
  }

  /** 由拍面朝向推测站位：红面朝前 → 正手，黑面朝前 → 反手；不确定时返回 null */
  stanceHint(): Stroke | null {
    const n = this.faceNormal();
    if (!n) return null;
    if (n.y > 0.35) return 'fh';
    if (n.y < -0.35) return 'bh';
    return null;
  }

  /** 击球面俯仰（弧度）：正 = 朝上（后仰） */
  facePitch(q: Quat, stroke: Stroke): number {
    const n = this.faceNormal(q);
    if (!n) return NaN;
    const z = stroke === 'fh' ? n.z : -n.z;
    return Math.asin(Math.max(-1, Math.min(1, z)));
  }

  /**
   * 你平时击球的拍面俯仰（弧度）：最近 9 次的中位数，正反手分开；不到 3 次时为 0。
   * 拍面特征以它为基准：习惯的角度算「平」，比平时更压 / 更仰才算加旋。
   * 否则习惯拍面后仰的人永远打不出上旋——2026-10-21 的录制里正手击球时拍面平均后仰约 41°，
   * 30 球判了 10 个下旋、0 个上旋；按固定握法（按键面 = 正手面）重算 10-22 的录制，正手击球时按键面仍平均后仰约 30°。
   */
  neutralPitch(stroke: Stroke): number {
    const h = this.contactPitch[stroke];
    if (h.length < NEUTRAL_MIN) return 0;
    const sorted = [...h].sort((a, b) => a - b);
    return clamp(sorted[sorted.length >> 1], -NEUTRAL_MAX, NEUTRAL_MAX);
  }

  /** 记一次击球（挥拍峰值）时的拍面俯仰（facePitch 的原始值） */
  recordContact(stroke: Stroke, pitch: number): void {
    if (!Number.isFinite(pitch)) return;
    const h = this.contactPitch[stroke];
    h.push(pitch);
    if (h.length > NEUTRAL_N) h.shift();
  }

  /**
   * 挥拍特征。onset = 确认时的快照，peak = 峰值快照（没有时用 onset）。
   * facePitch 是相对你平时角度的偏差（见 neutralPitch）。
   */
  features(onset: SwingSnapshot, peak: SwingSnapshot | null, stroke: Stroke): SwingFeatures {
    const at = peak ?? onset;
    const v = this.velAt(at.t);
    const vh = Math.hypot(v.x, v.y);
    const brush = vh + Math.abs(v.z) > 0.3 ? Math.atan2(v.z, Math.max(vh, 0.3)) : 0;
    if (!this.calibrated) return { ...NO_FEATURES, brush };
    const neutral = this.neutralPitch(stroke);
    const p1 = this.facePitch(at.q, stroke) - neutral;
    const p0 = this.facePitch(onset.q, stroke) - neutral;
    // 绕前进方向（G 的 +y）的转动 → 侧旋；左手镜像
    const wG = this.toGame(at.omegaWorld);
    const roll = wG.y * this.handed;
    return { facePitch: p1, pitchChange: peak ? p1 - p0 : 0, brush, roll };
  }

  /** 设备机体系里的某个方向在 W 里（调试用） */
  deviceAxisWorld(axis: Vec3, q: Quat = this.q): Vec3 {
    return rotate(q, axis);
  }

  /** W 里的方向换到设备机体系（调试用） */
  worldToDevice(v: Vec3, q: Quat = this.q): Vec3 {
    return rotateInverse(q, v);
  }
}
