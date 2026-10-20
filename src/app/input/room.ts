import { isValidRoom, randomCode } from '@/net/signal';

/** 手机直连用的房间号：网址里带了就用网址的，否则记在本机（调试页和游戏页共用，手机上的网址一直有效） */
export function roomCode(): string {
  const fromUrl = new URLSearchParams(location.search).get('room');
  if (isValidRoom(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem('rea-room');
    if (isValidRoom(saved)) return saved;
    const r = randomCode(8);
    localStorage.setItem('rea-room', r);
    return r;
  } catch {
    return randomCode(8);
  }
}
