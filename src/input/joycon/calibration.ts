/**
 * IMU 出厂/用户校准数据解析与原始值换算。
 * 公式（dekuNukem imu_sensor_notes；与 Linux hid-nintendo 等价）：
 *   陀螺 dps = (raw − offset) × 936 / (coeff − offset)          （±2000dps）
 *   加速度 g = raw × (量程G / 2) / (coeff − origin)              （±8G 时为 4/(…)，±16G 时为 8/(…)）
 * 加速度不减 origin，这是协议文档的约定。
 */
import { type ImuSample, type JoyConSide } from '../types';
import { ACCEL_RANGE_G, USER_CAL_MAGIC } from './protocol';

type Triple = [number, number, number];

export interface ImuCalibration {
  accelOrigin: Triple;
  accelCoeff: Triple;
  gyroOffset: Triple;
  gyroCoeff: Triple;
  source: 'factory' | 'user' | 'default';
}

export const DEFAULT_CALIBRATION: ImuCalibration = {
  accelOrigin: [0, 0, 0],
  accelCoeff: [16384, 16384, 16384],
  gyroOffset: [0, 0, 0],
  gyroCoeff: [13371, 13371, 13371],
  source: 'default',
};

function readI16(bytes: Uint8Array, offset: number): number {
  const v = bytes[offset] | (bytes[offset + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function readTriple(bytes: Uint8Array, offset: number): Triple {
  return [readI16(bytes, offset), readI16(bytes, offset + 2), readI16(bytes, offset + 4)];
}

/** 24 字节校准块：加速度原点、加速度系数、陀螺零点、陀螺系数，各 3 × int16 小端 */
export function parseCalibrationBlock(
  bytes: Uint8Array,
  source: 'factory' | 'user'
): ImuCalibration | null {
  if (bytes.length < 24) return null;
  const cal: ImuCalibration = {
    accelOrigin: readTriple(bytes, 0),
    accelCoeff: readTriple(bytes, 6),
    gyroOffset: readTriple(bytes, 12),
    gyroCoeff: readTriple(bytes, 18),
    source,
  };
  return isPlausible(cal) ? cal : null;
}

/** 用户校准区域：前 2 字节为魔数 B2 A1，之后 24 字节数据 */
export function parseUserCalibration(bytes: Uint8Array): ImuCalibration | null {
  if (bytes.length < 26) return null;
  if (bytes[0] !== USER_CAL_MAGIC[0] || bytes[1] !== USER_CAL_MAGIC[1]) return null;
  return parseCalibrationBlock(bytes.subarray(2), 'user');
}

/** 未写入的闪存是 0xFF；数值明显离谱时退回默认值 */
function isPlausible(cal: ImuCalibration): boolean {
  for (let i = 0; i < 3; i++) {
    const a = cal.accelCoeff[i] - cal.accelOrigin[i];
    const g = cal.gyroCoeff[i] - cal.gyroOffset[i];
    if (a < 8000 || a > 30000) return false;
    if (g < 6000 || g > 26000) return false;
    if (Math.abs(cal.gyroOffset[i]) > 2000) return false;
  }
  return true;
}

export interface ImuScale {
  accelPerLsb: Triple;
  gyroPerLsb: Triple;
  gyroOffset: Triple;
}

export function computeScale(cal: ImuCalibration, accelRangeG = ACCEL_RANGE_G): ImuScale {
  const accelPerLsb: Triple = [0, 0, 0];
  const gyroPerLsb: Triple = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    accelPerLsb[i] = accelRangeG / 2 / (cal.accelCoeff[i] - cal.accelOrigin[i]);
    gyroPerLsb[i] = 936 / (cal.gyroCoeff[i] - cal.gyroOffset[i]);
  }
  return { accelPerLsb, gyroPerLsb, gyroOffset: [...cal.gyroOffset] };
}

/** 判定「顶格」的阈值：陀螺 1990dps，加速度 15.8G */
const GYRO_CLIP_DPS = 1990;
const ACCEL_CLIP_G = 15.8;

/**
 * 把一个原始样本（imu 数组里第 index 个，6 个 int16）换算成物理量，
 * 并统一坐标轴：右手柄 Y、Z 取反（Linux hid-nintendo 的约定）。
 */
export function convertSample(
  imu: Int16Array,
  index: number,
  scale: ImuScale,
  side: JoyConSide,
  t: number,
  out?: ImuSample
): ImuSample {
  const o = index * 6;
  const sgnYZ = side === 'R' ? -1 : 1;
  const ax = imu[o] * scale.accelPerLsb[0];
  const ay = imu[o + 1] * scale.accelPerLsb[1] * sgnYZ;
  const az = imu[o + 2] * scale.accelPerLsb[2] * sgnYZ;
  const gx = (imu[o + 3] - scale.gyroOffset[0]) * scale.gyroPerLsb[0];
  const gy = (imu[o + 4] - scale.gyroOffset[1]) * scale.gyroPerLsb[1] * sgnYZ;
  const gz = (imu[o + 5] - scale.gyroOffset[2]) * scale.gyroPerLsb[2] * sgnYZ;
  const clipped =
    Math.abs(gx) >= GYRO_CLIP_DPS ||
    Math.abs(gy) >= GYRO_CLIP_DPS ||
    Math.abs(gz) >= GYRO_CLIP_DPS ||
    Math.abs(ax) >= ACCEL_CLIP_G ||
    Math.abs(ay) >= ACCEL_CLIP_G ||
    Math.abs(az) >= ACCEL_CLIP_G;
  if (!out) {
    return { t, gyro: { x: gx, y: gy, z: gz }, accel: { x: ax, y: ay, z: az }, clipped };
  }
  out.t = t;
  out.gyro.x = gx;
  out.gyro.y = gy;
  out.gyro.z = gz;
  out.accel.x = ax;
  out.accel.y = ay;
  out.accel.z = az;
  out.clipped = clipped;
  return out;
}

/** 一个报告里 3 个样本是否全为 0（IMU 没开起来的典型表现） */
export function isImuAllZero(imu: Int16Array): boolean {
  for (let i = 0; i < imu.length; i++) if (imu[i] !== 0) return false;
  return true;
}
