/**
 * 调参面板（?debug=1 时出现）：实时修改手感参数，改动存在本机（见 tuningStore），可以导出 / 导入 JSON。
 * 改动立即生效（onChange 让页面刷新仿真里开局时算好的东西，例如判定窗口、电脑走位限制）。
 */
import GUI from 'lil-gui';
import { CPU_LEVELS } from '@/config/difficulty';
import { tuning } from '@/config/tuning';
import { TOSS } from '@/input/paddle/TossDetector';
import {
  applyOverrides,
  currentOverrides,
  overrideCount,
  resetOverrides,
  saveOverrides,
  type TuningOverrides,
} from '@/app/shared/tuningStore';

/** [键, 名称, 最小, 最大, 步长] */
type Spec = [string, string, number, number, number];

const GROUPS: Array<[string, string, Record<string, number>, Spec[]]> = [
  [
    '时机',
    'timing',
    tuning.timing,
    [
      ['window6Ms', '窗口 H（6 分制，ms）', 40, 200, 1],
      ['window11Ms', '窗口 H（11 分制，ms）', 40, 200, 1],
      ['tauMin', '最早算打中（τ）', -4, -0.5, 0.05],
      ['tauMax', '最晚算打中（τ）', 0.5, 4, 0.05],
      ['aimPerTau', '早晚 → 左右', 0, 1.2, 0.01],
    ],
  ],
  [
    '发球',
    'serve',
    tuning.serve,
    [
      ['buttonTossHeight', '按键抛高（m）', 0.2, 1.4, 0.01],
      ['sweetAboveHand', '理想击球点（手上方 m）', 0, 0.6, 0.01],
      ['windowMs', '窗口（ms）', 50, 300, 1],
      ['powerMs', '强力发球（±ms）', 0, 200, 1],
      ['powerSpeedMul', '强力发球速度倍率', 1, 2, 0.01],
      ['earliestBeforeApex', '最高点前多早算准备动作（s）', 0, 0.5, 0.01],
      ['aimPerTau', '早晚 → 左右', 0, 1, 0.01],
    ],
  ],
  [
    '抖手柄抛球',
    'toss',
    TOSS,
    [
      ['minG', '触发（G）', 1.05, 3, 0.01],
      ['maxOmega', '允许的转动（rad/s）', 1, 20, 0.1],
      ['hMin', '最低抛高（m）', 0.1, 1.2, 0.01],
      ['hMax', '最高抛高（m）', 0.3, 2, 0.01],
      ['hSlope', '每多 1G 多抛（m）', 0, 1, 0.01],
    ],
  ],
  [
    '球速与弧线',
    'shot',
    tuning.shot,
    [
      ['pace6', '节奏（6 分制）', 0.5, 2, 0.01],
      ['pace11', '节奏（11 分制）', 0.5, 2.5, 0.01],
      ['flightTimeFactor', '飞行时间系数', 0.8, 1.6, 0.01],
      ['maxApex', '最高弧线（台面上 m）', 0.3, 1.5, 0.01],
      ['minClearance', '最低过网（m）', 0, 0.15, 0.005],
    ],
  ],
  [
    '击球点',
    'contact',
    tuning.contact,
    [
      ['idealHeight', '理想高度（台面上 m）', 0, 0.6, 0.01],
      ['idealHeightPopup', '高球理想高度（m）', 0.2, 1.2, 0.01],
      ['idealY', '离台端（m）', 1.3, 2.4, 0.01],
      ['minAfterBounce', '弹起后最早（s）', 0, 0.3, 0.005],
    ],
  ],
  [
    '走位',
    'mover',
    tuning.mover,
    [
      ['gain', '跟随', 1, 15, 0.1],
      ['forehandOffset', '正手站位偏移（m）', 0, 0.6, 0.01],
      ['backhandOffset', '反手站位偏移（m）', 0, 0.4, 0.01],
      ['reachNormal', '哎呀阈值（m）', 0.05, 0.6, 0.01],
      ['reachRushed', '够不着阈值（m）', 0.1, 1, 0.01],
      ['readyDepth', '准备位离台（m）', 1.5, 3, 0.01],
    ],
  ],
  [
    '规则节奏',
    'rules',
    tuning.rules,
    [
      ['betweenPoints', '两分之间（s）', 0.5, 5, 0.1],
      ['serveDelay', '电脑发球前停顿（s）', 0.2, 3, 0.05],
      ['tossTimeout', '抛球多久没打重抛（s）', 0.6, 4, 0.05],
    ],
  ],
  [
    '物理',
    'physics',
    tuning.physics,
    [
      ['dragK', '空气阻力', 0, 0.3, 0.005],
      ['magnusK', '马格努斯', 0, 0.6, 0.01],
      ['spinDecay', '旋转衰减', 0, 2, 0.01],
      ['tableE0', '台面弹性', 0.6, 1, 0.005],
      ['tableMu', '台面摩擦', 0, 0.6, 0.01],
    ],
  ],
];

const CPU_SPECS: Spec[] = [
  ['reaction', '反应（s）', 0, 0.6, 0.01],
  ['vMax', '最高跑速（m/s）', 1, 5, 0.05],
  ['aMax', '加速度（m/s²）', 3, 25, 0.5],
  ['predSigma', '判断落点误差（m）', 0, 0.4, 0.01],
  ['timingMu', '时机偏（ms，负 = 早）', -80, 40, 1],
  ['timingSigma', '时机误差（ms）', 0, 80, 1],
  ['speedMin', '球速倍率下限', 0.4, 1.5, 0.01],
  ['speedMax', '球速倍率上限', 0.5, 2, 0.01],
  ['aimMargin', '离边线余量（m）', 0, 0.5, 0.01],
  ['landingSigma', '落点散布（m）', 0, 0.3, 0.005],
  ['clearanceSigma', '过网误差（m）', 0, 0.08, 0.001],
  ['composure', '抗压（越大越少哎呀）', 0, 1.5, 0.01],
  ['spinUse', '用旋转概率', 0, 1, 0.01],
  ['curveUse', '用侧旋概率', 0, 1, 0.01],
  ['smashP', '扣杀概率', 0, 1, 0.01],
  ['smashReturnP', '接住扣杀概率', 0, 1, 0.01],
];

function download(data: unknown, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  );
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function createTuningPanel(onChange: () => void): GUI {
  const gui = new GUI({ title: '手感参数' });
  gui.domElement.style.zIndex = '50';
  const changed = () => {
    saveOverrides();
    onChange();
    gui.title(`手感参数${overrideCount() ? `（改了 ${overrideCount()} 项）` : ''}`);
  };
  for (const [title, , obj, specs] of GROUPS) {
    const f = gui.addFolder(title);
    for (const [k, name, min, max, step] of specs) {
      f.add(obj, k, min, max, step).name(name).onChange(changed);
    }
    if (title !== '时机' && title !== '发球') f.close();
  }
  const cpu = gui.addFolder('电脑');
  cpu.close();
  CPU_LEVELS.forEach((lv) => {
    const f = cpu.addFolder(lv.name);
    f.close();
    for (const [k, name, min, max, step] of CPU_SPECS) {
      f.add(lv as unknown as Record<string, number>, k, min, max, step)
        .name(name)
        .onChange(changed);
    }
  });

  const refresh = () => {
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    changed();
  };
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    void f.text().then((txt) => {
      try {
        applyOverrides(JSON.parse(txt) as TuningOverrides);
        refresh();
      } catch {
        alert('读不了这个文件：不是导出的手感参数 JSON');
      }
      fileInput.value = '';
    });
  });
  const actions = {
    export: () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      download(currentOverrides(), `tuning-${stamp}.json`);
    },
    import: () => fileInput.click(),
    reset: () => {
      if (!confirm('把所有手感参数恢复成默认值？')) return;
      resetOverrides();
      refresh();
    },
  };
  gui.add(actions, 'export').name('导出改动（JSON）');
  gui.add(actions, 'import').name('导入 JSON');
  gui.add(actions, 'reset').name('全部恢复默认');
  changed();
  return gui;
}
