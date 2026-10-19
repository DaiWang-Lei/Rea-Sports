/** WebHID 设备管理：请求授权、列出已授权的 Joy-Con、监听插拔。仅浏览器端使用。 */
import { JOYCON_L_PRODUCT_ID, JOYCON_R_PRODUCT_ID, NINTENDO_VENDOR_ID } from './joycon/protocol';

export const JOYCON_FILTERS: HIDDeviceFilter[] = [
  { vendorId: NINTENDO_VENDOR_ID, productId: JOYCON_L_PRODUCT_ID },
  { vendorId: NINTENDO_VENDOR_ID, productId: JOYCON_R_PRODUCT_ID },
];

export function isWebHidSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

export function isJoyCon(d: HIDDevice): boolean {
  return (
    d.vendorId === NINTENDO_VENDOR_ID &&
    (d.productId === JOYCON_L_PRODUCT_ID || d.productId === JOYCON_R_PRODUCT_ID)
  );
}

/** 弹出浏览器的设备选择框（必须在用户点击等手势里调用） */
export async function requestJoyCons(): Promise<HIDDevice[]> {
  const devices = await navigator.hid.requestDevice({ filters: JOYCON_FILTERS });
  return devices.filter(isJoyCon);
}

/** 之前授权过、且当前已连接的 Joy-Con（刷新页面后不用再选一次） */
export async function getGrantedJoyCons(): Promise<HIDDevice[]> {
  const devices = await navigator.hid.getDevices();
  return devices.filter(isJoyCon);
}

export function onJoyConConnect(cb: (d: HIDDevice) => void): () => void {
  const handler = (e: HIDConnectionEvent) => {
    if (isJoyCon(e.device)) cb(e.device);
  };
  navigator.hid.addEventListener('connect', handler);
  return () => navigator.hid.removeEventListener('connect', handler);
}

export function onJoyConDisconnect(cb: (d: HIDDevice) => void): () => void {
  const handler = (e: HIDConnectionEvent) => {
    if (isJoyCon(e.device)) cb(e.device);
  };
  navigator.hid.addEventListener('disconnect', handler);
  return () => navigator.hid.removeEventListener('disconnect', handler);
}
