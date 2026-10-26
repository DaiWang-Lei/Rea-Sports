/**
 * 练习和比赛共用的小块：玩家的 1:1 球拍、挥拍输入换算、设备状态行。
 */
import { clamp, DEG } from '@/core/math';
import { rotate } from '@/core/quat';
import { normalize, vec3 } from '@/core/vec3';
import type { PaddleModel } from '@/input/paddle/PaddleModel';
import { NO_FEATURES, type SwingInput } from '@/sim/hit/HitResolver';
import { sideDir } from '@/sim/constants';
import { forehandSign, type PlayerSim } from '@/sim/players/PlayerSim';
import {
  cpuPaddle,
  FOREARM,
  GRIP_TO_CENTER,
  type PaddlePose,
  restElbow,
} from '@/render/paddlePose';
import type { MotionInput, SwingEventOut } from '../input/MotionInput';

/** 等球时前臂能转到的范围（相对正前方）：向正手侧 / 反手侧、向上 / 向下；超出的部分算手腕弯 */
const FOREARM_OUT = 80 * DEG;
const FOREARM_IN = 70 * DEG;
const FOREARM_UP = 50 * DEG;
const FOREARM_DOWN = 35 * DEG;

/**
 * 玩家的球拍：已校准时朝向 1:1 跟随设备。等球时前臂顺着拍柄绕肘转（手的位置跟着拍头的指向走，
 * 像真人握拍：拍子和前臂大致是一条线），挥拍时位置跟随挥拍动画（保证碰得到球）。
 * paddle = null（键盘、没有设备）或还没定电视方向时整个按动画走
 */
export function humanPaddle(
  paddle: PaddleModel | null,
  p: PlayerSim,
  body: { x: number; y: number },
  t: number
): PaddlePose {
  const anim = cpuPaddle(body, p, p.swing, t);
  const q = paddle?.paddleQuat();
  if (!q) return anim;
  const n = normalize(rotate(q, vec3(0, 1, 0)));
  const up = normalize(rotate(q, vec3(0, 0, 1)));
  const swinging = p.swing && t >= p.swing.start && t <= p.swing.end + 0.25;
  if (swinging) return { pos: anim.pos, normal: n, handle: vec3(-up.x, -up.y, -up.z) };
  // 前臂方向：拍头在「自己的坐标」里的方位（0 = 正前方，正 = 往正手侧）和仰角，限制在手臂自然能到的范围
  const fh = forehandSign(p);
  const f = sideDir(p.side);
  // 拍头接近竖直时方位没有意义（噪声会让它乱跳）：离竖直不到约 9° 时前臂朝正前方，到 30° 时完全按拍头方位
  const horiz = Math.hypot(up.x, up.y);
  const w = clamp((horiz - 0.15) / 0.35, 0, 1);
  const az = w * clamp(Math.atan2(up.x * fh, up.y * f), -FOREARM_IN, FOREARM_OUT);
  const el = clamp(Math.asin(clamp(up.z, -1, 1)), -FOREARM_DOWN, FOREARM_UP);
  const e = restElbow(body, f, fh);
  const k = FOREARM * Math.cos(el);
  const grip = vec3(
    e.x + fh * Math.sin(az) * k,
    e.y + f * Math.cos(az) * k,
    e.z + FOREARM * Math.sin(el)
  );
  return {
    pos: vec3(
      grip.x + up.x * GRIP_TO_CENTER,
      grip.y + up.y * GRIP_TO_CENTER,
      grip.z + up.z * GRIP_TO_CENTER
    ),
    normal: n,
    handle: vec3(-up.x, -up.y, -up.z),
  };
}

/** 体感设备的一次挥拍 → 仿真里的挥拍输入：时间换算成仿真时间，接触时刻扣掉画面延迟 */
export function deviceSwingInput(
  e: SwingEventOut,
  simAt: (ms: number) => number,
  latencyMs: number
): SwingInput {
  const c = e.commit;
  return {
    id: c.id,
    motion: c.motion,
    path: c.path,
    tDetect: simAt(performance.now()),
    tContact: simAt(c.tContact) - latencyMs / 1000,
    dir: e.dir,
    yawFrac: c.yawFrac,
    wPeak: c.wPeak,
    features: e.features,
  };
}

/** 键盘挥拍：F 正手、J 反手；按住 W 拉上旋、S 搓下旋；Shift 大力。按键时刻 = 击球时刻 */
export function keySwingInput(
  dir: 1 | -1,
  keysDown: ReadonlySet<string>,
  shift: boolean,
  id: number,
  simAt: (ms: number) => number,
  latencyMs: number
): SwingInput {
  const now = performance.now();
  const brush = keysDown.has('w') ? 0.7 : keysDown.has('s') ? -0.7 : 0;
  return {
    id,
    motion: id,
    path: 'key',
    tDetect: simAt(now),
    tContact: simAt(now) - latencyMs / 1000,
    dir,
    yawFrac: 1,
    wPeak: shift ? 22 : 15,
    features: { ...NO_FEATURES, brush },
  };
}

/** 状态行的设备部分：设备名、有没有数据、电视方向、Joy-Con 陀螺仪零点 */
export function deviceLine(
  input: MotionInput,
  keyboard: boolean,
  keyboardText: string,
  now: number
): string {
  const d = input.active;
  if (keyboard) return keyboardText;
  if (!d) return '没有连接体感设备';
  let s = `${d.name}${input.streaming ? '' : '（没有数据）'}`;
  if (!d.paddle.calibrated) s += ' · 还没定电视方向（拍头指向电视按回中）';
  if (d.kind === 'joycon') {
    const at = d.motion.biasLearnedAt;
    const min = Math.floor((now - at) / 60000);
    s += Number.isFinite(at)
      ? ` · 陀螺仪零点 ${min < 1 ? '刚测过' : `${min} 分钟前测过`}`
      : ' · 陀螺仪零点未测（平放 2 秒会自动测）';
  }
  return s;
}
