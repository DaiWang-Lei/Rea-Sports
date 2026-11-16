/**
 * 手感参数的本地覆盖：调参面板改过的值（全局 tuning、电脑各级参数、抖手柄抛球的阈值）只记和默认值不同的部分，
 * 存在本机；每个页面启动时先套用，所以练习、对打、自动演示和视频打点页都用同一套参数。
 * 导出 / 导入的 JSON 也是这个格式，可以发给开发者，或者在别的电脑上导入。
 */
import { CPU_LEVELS, type CpuLevel } from '@/config/difficulty';
import { defaultTuning, tuning } from '@/config/tuning';
import { TOSS } from '@/input/paddle/TossDetector';

const KEY = 'rea-tuning';

type Group = Record<string, number>;
type Groups = Record<string, Group>;

export interface TuningOverrides {
  /** tuning 的分组 → 键 → 值 */
  tuning?: Record<string, Group>;
  /** 电脑等级（1..5）→ 键 → 值 */
  cpu?: Record<string, Partial<Record<keyof CpuLevel, number>>>;
  /** 抖手柄抛球 */
  toss?: Group;
}

const DEFAULT_CPU: CpuLevel[] = CPU_LEVELS.map((l) => ({ ...l }));
const DEFAULT_TOSS: Group = { ...TOSS };

function diff(cur: Group, def: Group): Group | null {
  const out: Group = {};
  for (const [k, v] of Object.entries(cur)) {
    if (typeof v === 'number' && v !== def[k]) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** 和默认值不同的部分 */
export function currentOverrides(): TuningOverrides {
  const out: TuningOverrides = {};
  const def = defaultTuning() as unknown as Groups;
  const cur = tuning as unknown as Groups;
  for (const g of Object.keys(def)) {
    const d = diff(cur[g], def[g]);
    if (d) (out.tuning ??= {})[g] = d;
  }
  CPU_LEVELS.forEach((lv, i) => {
    const d = diff(lv as unknown as Group, DEFAULT_CPU[i] as unknown as Group);
    if (d) (out.cpu ??= {})[String(i + 1)] = d;
  });
  const t = diff(TOSS as unknown as Group, DEFAULT_TOSS);
  if (t) out.toss = t;
  return out;
}

/** 改过几项 */
export function overrideCount(o: TuningOverrides = currentOverrides()): number {
  let n = 0;
  for (const g of Object.values(o.tuning ?? {})) n += Object.keys(g).length;
  for (const g of Object.values(o.cpu ?? {})) n += Object.keys(g).length;
  return n + Object.keys(o.toss ?? {}).length;
}

/** 只认识的键、有限的数才套用（导入的文件可能是旧版本或手改过的） */
function assign(target: Group, src: Group | undefined): void {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    if (k in target && typeof target[k] === 'number' && Number.isFinite(v)) target[k] = v;
  }
}

/** 先恢复默认，再套用覆盖 */
export function applyOverrides(o: TuningOverrides): void {
  const def = defaultTuning() as unknown as Groups;
  const cur = tuning as unknown as Groups;
  for (const g of Object.keys(def)) Object.assign(cur[g], def[g]);
  CPU_LEVELS.forEach((lv, i) => Object.assign(lv, DEFAULT_CPU[i]));
  Object.assign(TOSS, DEFAULT_TOSS);
  for (const [g, vals] of Object.entries(o.tuning ?? {})) if (cur[g]) assign(cur[g], vals);
  for (const [lv, vals] of Object.entries(o.cpu ?? {})) {
    const target = CPU_LEVELS[Number(lv) - 1];
    if (target) assign(target as unknown as Group, vals as Group);
  }
  assign(TOSS as unknown as Group, o.toss);
}

export function saveOverrides(): void {
  try {
    const o = currentOverrides();
    if (overrideCount(o)) localStorage.setItem(KEY, JSON.stringify(o));
    else localStorage.removeItem(KEY);
  } catch {
    // 隐私模式等：不保存
  }
}

/** 页面启动时调用：套用本机存的覆盖 */
export function loadOverrides(): void {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? 'null') as TuningOverrides | null;
    if (o) applyOverrides(o);
  } catch {
    // 读不到就用默认值
  }
}

export function resetOverrides(): void {
  applyOverrides({});
  saveOverrides();
}
