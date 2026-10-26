/**
 * 画面延迟补偿（毫秒）：按屏幕（分辨率 + 像素比）分别记，Mac 自带屏和电视的延迟差很多。练习和比赛共用。
 * 以前记在发球机练习的设置里（rea-practice 的 latencyByScreen，更早是单个 latencyMs），第一次读取时搬过来。
 */
import { tuning } from '@/config/tuning';
import { clamp } from '@/core/math';

const KEY = 'rea-latency';
const OLD_KEY = 'rea-practice';

/** 浏览器窗口所在的屏幕，按分辨率区分（镜像显示时分不出来） */
export function screenKey(): string {
  const r = window.devicePixelRatio || 1;
  return `${screen.width}×${screen.height}${r !== 1 ? ` @${r}x` : ''}`;
}

let byScreen: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (byScreen) return byScreen;
  byScreen = {};
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
      byScreen?: Record<string, number>;
    } | null;
    if (s?.byScreen) {
      byScreen = { ...s.byScreen };
    } else {
      const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? 'null') as {
        latencyByScreen?: Record<string, number>;
        latencyMs?: number;
      } | null;
      byScreen = { ...(old?.latencyByScreen ?? {}) };
      // 更早的版本只记了一个值：算作当前这块屏幕的
      if (typeof old?.latencyMs === 'number' && !(screenKey() in byScreen)) {
        byScreen[screenKey()] = old.latencyMs;
      }
    }
  } catch {
    // 读不到就用默认值
  }
  return byScreen;
}

/** 当前屏幕的画面延迟补偿（毫秒） */
export function latencyMs(): number {
  return load()[screenKey()] ?? tuning.timing.displayLatencyMs;
}

export function setLatencyMs(ms: number): number {
  const by = load();
  const v = clamp(Math.round(ms), 0, 300);
  by[screenKey()] = v;
  try {
    localStorage.setItem(KEY, JSON.stringify({ byScreen: by }));
  } catch {
    // 隐私模式等：不保存
  }
  return v;
}
