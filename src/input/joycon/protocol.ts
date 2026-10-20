/**
 * Joy-Con（Switch 一代）蓝牙 HID 协议的纯函数部分。
 * 参考：dekuNukem/Nintendo_Switch_Reverse_Engineering、Linux hid-nintendo.c。
 * 注意：WebHID 收到的 data 不含报告 ID，所以下标比文档里的原始字节下标小 1。
 */
import { BUTTON_NAMES, type Buttons, emptyButtons } from '../types';

export const NINTENDO_VENDOR_ID = 0x057e;
export const JOYCON_L_PRODUCT_ID = 0x2006;
export const JOYCON_R_PRODUCT_ID = 0x2007;

/** 输出报告 */
export const OUT_RUMBLE_AND_SUBCMD = 0x01;
export const OUT_RUMBLE_ONLY = 0x10;
/** 输出报告负载长度（不含报告 ID） */
export const OUTPUT_PAYLOAD_LENGTH = 48;

/** 输入报告 */
export const IN_SUBCMD_REPLY = 0x21;
export const IN_FULL = 0x30;
export const IN_SIMPLE = 0x3f;

export const Subcmd = {
  SetInputMode: 0x03,
  SpiRead: 0x10,
  SetPlayerLights: 0x30,
  EnableImu: 0x40,
  SetImuSensitivity: 0x41,
  EnableVibration: 0x48,
} as const;

/** 子命令 0x41 参数：陀螺 ±2000dps、加速度 ±16G、陀螺 208Hz、加速度抗混叠 100Hz */
export const IMU_SENSITIVITY_ARGS = [0x03, 0x03, 0x01, 0x01] as const;
export const ACCEL_RANGE_G = 16;
export const GYRO_RANGE_DPS = 2000;

/** SPI 地址 */
export const SPI_FACTORY_IMU_CAL = 0x6020; // 0x18 字节
export const SPI_USER_IMU_CAL_MAGIC = 0x8026; // 2 字节魔数 0xB2 0xA1，紧接 0x18 字节数据
export const USER_CAL_MAGIC = [0xb2, 0xa1] as const;

/** 两侧马达都静止的震动数据 */
export const NEUTRAL_RUMBLE: readonly number[] = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40];

/** 构造 0x01 输出报告的负载：[计数器, 震动 8 字节, 子命令, 参数...]，补零到 48 字节 */
export function buildSubcommandPayload(
  counter: number,
  rumble: ArrayLike<number>,
  subcmd: number,
  args: ArrayLike<number>
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(OUTPUT_PAYLOAD_LENGTH);
  out[0] = counter & 0x0f;
  for (let i = 0; i < 8; i++) out[1 + i] = rumble[i] ?? NEUTRAL_RUMBLE[i];
  out[9] = subcmd & 0xff;
  for (let i = 0; i < args.length; i++) out[10 + i] = args[i] & 0xff;
  return out;
}

/** 构造 0x10（仅震动）输出报告的负载 */
export function buildRumblePayload(
  counter: number,
  rumble: ArrayLike<number>
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(OUTPUT_PAYLOAD_LENGTH);
  out[0] = counter & 0x0f;
  for (let i = 0; i < 8; i++) out[1 + i] = rumble[i] ?? NEUTRAL_RUMBLE[i];
  return out;
}

export function spiReadArgs(address: number, size: number): number[] {
  return [
    address & 0xff,
    (address >>> 8) & 0xff,
    (address >>> 16) & 0xff,
    (address >>> 24) & 0xff,
    size,
  ];
}

export interface FullReport {
  timer: number;
  /** 电量 0..8（8=满） */
  battery: number;
  charging: boolean;
  buttonBytes: [number, number, number];
  /** 3 个样本 × (ax, ay, az, gx, gy, gz)，按报告原样排列：第 0 个是最新的 */
  imu: Int16Array;
}

/** 解析 0x30 / 0x21 报告共有的头部 + 0x30 的 IMU 数据 */
export function parseFullReport(data: DataView): FullReport | null {
  if (data.byteLength < 48) return null;
  const imu = new Int16Array(18);
  for (let i = 0; i < 18; i++) imu[i] = data.getInt16(12 + i * 2, true);
  const batt = data.getUint8(1);
  return {
    timer: data.getUint8(0),
    // 高 4 位：电量档位（8/6/4/2/0），其最低位是充电标志
    battery: (batt >> 4) & 0x0e,
    charging: ((batt >> 4) & 0x01) === 1,
    buttonBytes: [data.getUint8(2), data.getUint8(3), data.getUint8(4)],
    imu,
  };
}

export interface SubcmdReply {
  timer: number;
  ack: number;
  subcmd: number;
  buttonBytes: [number, number, number];
  /** 子命令回复数据（原始字节 15 起） */
  payload: Uint8Array;
}

export function parseSubcmdReply(data: DataView): SubcmdReply | null {
  if (data.byteLength < 14) return null;
  const payload = new Uint8Array(data.buffer, data.byteOffset + 14, data.byteLength - 14);
  return {
    timer: data.getUint8(0),
    ack: data.getUint8(12),
    subcmd: data.getUint8(13),
    buttonBytes: [data.getUint8(2), data.getUint8(3), data.getUint8(4)],
    payload: new Uint8Array(payload),
  };
}

export function isAck(reply: SubcmdReply): boolean {
  return (reply.ack & 0x80) !== 0;
}

export interface SpiReadResult {
  address: number;
  size: number;
  bytes: Uint8Array;
}

export function parseSpiRead(payload: Uint8Array): SpiReadResult | null {
  if (payload.length < 5) return null;
  const address = (payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0;
  const size = payload[4];
  if (payload.length < 5 + size) return null;
  return { address, size, bytes: payload.slice(5, 5 + size) };
}

/** 按键位定义：原始字节 3（右）、4（共用）、5（左） */
const BUTTON_BITS: Array<[byteIndex: number, bit: number]> = [
  // 字节 0（右）：Y X B A SR SL R ZR
  [0, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [0, 5],
  [0, 6],
  [0, 7],
  // 字节 1（共用）：− + 右摇杆 左摇杆 HOME 截图
  [1, 0],
  [1, 1],
  [1, 2],
  [1, 3],
  [1, 4],
  [1, 5],
  // 字节 2（左）：↓ ↑ → ← SR SL L ZL
  [2, 0],
  [2, 1],
  [2, 2],
  [2, 3],
  [2, 4],
  [2, 5],
  [2, 6],
  [2, 7],
];

export function parseButtons(bytes: readonly number[], out: Buttons = emptyButtons()): Buttons {
  for (let i = 0; i < BUTTON_NAMES.length; i++) {
    const [byteIndex, bit] = BUTTON_BITS[i];
    out[BUTTON_NAMES[i]] = ((bytes[byteIndex] >> bit) & 1) === 1;
  }
  return out;
}
