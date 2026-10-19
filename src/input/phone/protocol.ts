/**
 * 手机体感控制器：手机页 ↔ 中转服务器 ↔ 游戏页之间的消息格式，以及手机坐标到机体坐标的换算。
 *
 * 手机坐标（W3C，竖屏）：x → 屏幕右，y → 屏幕上方，z → 从屏幕朝外。
 * 换算到与 Joy-Con 一致的机体坐标：+X = 手机顶端（相当于 Joy-Con 肩键一端），+Y = 左，+Z = 屏幕朝外。
 * 这样「顶端指向屏幕回中」「屏幕朝上平放校准」等流程与 Joy-Con 完全一样。
 */
import { DEG } from '@/core/math';
import { type Vec3, vec3 } from '@/core/vec3';

export type PhoneButton = 'confirm' | 'recenter' | 'pause' | 'back';
export type Platform = 'ios' | 'android' | 'other';

export interface PhoneImuMsg {
  type: 'imu';
  seq: number;
  /** 手机端时间戳（毫秒，手机的 performance.now 基准） */
  t: number;
  /** 机体系角速度（度/秒） */
  g: [number, number, number];
  /** 机体系加速度（g） */
  a: [number, number, number];
}

export interface PhoneBtnMsg {
  type: 'btn';
  name: PhoneButton;
  down: boolean;
}

export interface PhoneMetaMsg {
  type: 'meta';
  platform: Platform;
  ua: string;
  /** 加速度符号：1 符合标准、−1 被取反过、0 还没判断出来 */
  accelSign: 1 | -1 | 0;
  /** 手机端测到的采样频率 */
  hz: number;
  canVibrate: boolean;
  /** 有没有陀螺仪 */
  hasGyro: boolean;
}

export interface PhonePongMsg {
  type: 'pong';
  t: number;
}

export type PhoneMessage = PhoneImuMsg | PhoneBtnMsg | PhoneMetaMsg | PhonePongMsg;

/** 游戏 → 手机 */
export type GameToPhoneMessage =
  | { type: 'vibrate'; pattern: number[] }
  | { type: 'ping'; t: number }
  | { type: 'info'; text: string };

/** 服务器 → 游戏 */
export type RelayMessage =
  | { type: 'phones'; list: Array<{ id: string; name: string }> }
  | { type: 'phone-on'; id: string; name: string }
  | { type: 'phone-off'; id: string }
  | (PhoneMessage & { from: string });

export const STANDARD_GRAVITY = 9.80665;

/**
 * W3C devicemotion → 机体系。
 * rotationRate：alpha 绕 z、beta 绕 x、gamma 绕 y（度/秒）；accelerationIncludingGravity：米/秒²。
 */
export function phoneToBody(
  rr: { alpha: number; beta: number; gamma: number },
  acc: { x: number; y: number; z: number },
  accelSign: 1 | -1
): { gyro: Vec3; accel: Vec3 } {
  // 手机系
  const gx = rr.beta;
  const gy = rr.gamma;
  const gz = rr.alpha;
  const k = accelSign / STANDARD_GRAVITY;
  const ax = acc.x * k;
  const ay = acc.y * k;
  const az = acc.z * k;
  // 机体系：X = 手机 y，Y = −手机 x，Z = 手机 z（绕 z 轴转 90°，仍是右手系）
  return { gyro: vec3(gy, -gx, gz), accel: vec3(ay, -ax, az) };
}

/**
 * 判断加速度的符号约定：标准是「屏幕朝上平放时 z = +9.8」，但有的浏览器（历史上的 iOS Safari）是反的。
 * 用 deviceorientation 给出的倾角算出「上」在手机系里的方向，静止时和加速度对比。
 */
export class AccelSignDetector {
  private sum = 0;
  private n = 0;
  sign: 1 | -1 | 0 = 0;

  /** acc：米/秒²（原始）；beta/gamma：度；gyroDps：角速度大小 */
  add(
    acc: { x: number; y: number; z: number },
    beta: number | null,
    gamma: number | null,
    gyroDps: number
  ): void {
    if (beta === null || gamma === null || gyroDps > 15) return;
    const mag = Math.hypot(acc.x, acc.y, acc.z);
    if (mag < 7 || mag > 12.5) return;
    const b = beta * DEG;
    const g = gamma * DEG;
    // 手机系里的「上」：Rᵀ·(0,0,1)，R = Rz(α)·Rx(β)·Ry(γ)
    const up = { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) };
    const d = (acc.x * up.x + acc.y * up.y + acc.z * up.z) / mag;
    this.sum += d;
    this.n++;
    if (this.n > 600) {
      // 只保留最近的影响
      this.sum *= 0.5;
      this.n = 300;
    }
    if (this.n >= 30) {
      const avg = this.sum / this.n;
      if (Math.abs(avg) > 0.5) this.sign = avg > 0 ? 1 : -1;
    }
  }
}

/** 把 RumblePulse 序列换成 navigator.vibrate 的节奏数组（开、关、开…，毫秒；手机马达太短的震动感觉不到，至少 20ms） */
export function vibratePattern(pulses: Array<{ durationMs: number; on: boolean }>): number[] {
  const out: number[] = [];
  let expectOn = true;
  for (const p of pulses) {
    const ms = Math.max(p.on ? 20 : 10, Math.round(p.durationMs));
    if (p.on !== expectOn) out.push(0);
    out.push(ms);
    expectOn = !p.on;
  }
  return out;
}
