/**
 * 球拍模型（纯逻辑）：把设备姿态换成游戏里球拍的朝向，并给击球提供拍面特征。
 *
 * 坐标：融合世界系 W（Z 向上，偏航任意）；游戏系 G（x 右、y 朝电视/对手、z 上）。
 * 校准两步，与握法无关：
 *  1. 回中：设备顶端（Joy-Con 肩键一端 / 手机顶端，机体 +X）指向电视 → 得到 W → G 的偏航 A；
 *  2. 准备姿势：像握拍一样、红面（正手面）朝电视、拍头朝上 → 记下「握法」grip（球拍局部 → 设备局部）。
 * 之后球拍在 G 里的姿态 R = A · q · grip。球拍局部轴：+Y = 红面法向，+Z = 拍头方向，+X = Y × Z。
 * 准备姿势下球拍局部轴与 G 重合。
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

export interface PaddleCalibrationData {
  /** 握法：球拍局部 → 设备局部 */
  grip: [number, number, number, number];
}

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
  grip: Quat | null = null;
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
    return this.hasHeading && this.grip !== null;
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

  /** 回中：设备顶端（机体 +X）指向电视。顶端几乎竖直时无法确定方向，返回 false */
  setHeading(q: Quat = this.q): boolean {
    const x = rotate(q, vec3(1, 0, 0));
    const h = Math.hypot(x.x, x.y);
    if (h < 0.35) return false;
    this.yaw = Math.PI / 2 - Math.atan2(x.y, x.x);
    this.hasHeading = true;
    return true;
  }

  /** 准备姿势：记下握法（需要先回中） */
  setReady(q: Quat = this.q): boolean {
    if (!this.hasHeading) return false;
    // grip = q⁻¹ · A⁻¹（准备姿势下球拍局部轴 = G）
    const aInv = fromAxisAngle(0, 0, 1, -this.yaw);
    this.grip = normalizeQ(multiply({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, aInv));
    // 握法变了，之前记的拍面角度不再可比
    this.contactPitch = { fh: [], bh: [] };
    return true;
  }

  loadGrip(data: PaddleCalibrationData | null): void {
    if (!data) return;
    const [w, x, y, z] = data.grip;
    this.grip = normalizeQ(quat(w, x, y, z));
  }

  saveGrip(): PaddleCalibrationData | null {
    const g = this.grip;
    return g ? { grip: [g.w, g.x, g.y, g.z] } : null;
  }

  /** 球拍在 G 里的姿态（未完成校准时返回 null） */
  paddleQuat(q: Quat = this.q): Quat | null {
    if (!this.grip || !this.hasHeading) return null;
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
   * 30 球判了 10 个下旋、0 个上旋（核对过不是融合误差，是手上的真实角度，而且重新校准握法也救不了：一面摆正另一面更歪）。
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
