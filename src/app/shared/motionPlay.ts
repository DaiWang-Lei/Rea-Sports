/**
 * 练习和比赛共用的小块：玩家的 1:1 球拍、挥拍输入换算、设备状态行。
 */
import { clamp, DEG } from '@/core/math';
import { rotate } from '@/core/quat';
import { normalize, type Vec3, vec3 } from '@/core/vec3';
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
 * paddle = null（键盘、没有设备）或还没定电视方向时整个按动画走。
 * 两种位置之间的切换是突变的，画面上要用 HumanPaddle 过渡
 */
export function humanPaddle(
  paddle: PaddleModel | null,
  p: PlayerSim,
  body: { x: number; y: number },
  t: number
): PaddlePose {
  return paddleParts(paddle, p, body, t).pose;
}

/** 挥拍开始时用这么久（秒，且不晚于击球那一刻）从手上的位置过渡到挥拍动作；挥完用这么久滑回手柄的位置 */
const BLEND_IN = 0.05;
const BLEND_OUT = 0.25;

/**
 * 画面上玩家的球拍：同 humanPaddle，但在「跟手柄」和「挥拍动画」两种位置之间平滑过渡。
 * 挥拍是识别出来时（离击球约 70ms）才开始算的，那一刻动画已经在往前挥，直接切换球拍会瞬移三四十厘米。
 * 只过渡位置：拍面朝向一直跟手柄，本来就连续。每个画面上的人一个
 */
export class HumanPaddle {
  private swinging = false;
  /** 切换那一刻画面上的位置，和过渡的起止时刻 */
  private from: Vec3 | null = null;
  private t0 = 0;
  private t1 = 0;
  private last: Vec3 | null = null;
  private lastT = -Infinity;

  pose(
    paddle: PaddleModel | null,
    p: PlayerSim,
    body: { x: number; y: number },
    t: number
  ): PaddlePose {
    // 新开一局（时间往回走）：从头来
    if (t < this.lastT) {
      this.from = this.last = null;
      this.swinging = false;
    }
    this.lastT = t;
    const { pose, swinging } = paddleParts(paddle, p, body, t);
    if (swinging !== this.swinging) {
      this.swinging = swinging;
      this.from = this.last;
      this.t0 = t;
      this.t1 = t + (swinging ? clamp((p.swing?.hit ?? t) - t, 0.02, BLEND_IN) : BLEND_OUT);
    }
    let pos = pose.pos;
    if (this.from) {
      const u = (t - this.t0) / (this.t1 - this.t0);
      if (u >= 1) this.from = null;
      else {
        const w = clamp(u, 0, 1);
        const s = w * w * (3 - 2 * w);
        const a = this.from;
        pos = vec3(a.x + (pos.x - a.x) * s, a.y + (pos.y - a.y) * s, a.z + (pos.z - a.z) * s);
      }
    }
    this.last = pos;
    return { ...pose, pos };
  }
}

function paddleParts(
  paddle: PaddleModel | null,
  p: PlayerSim,
  body: { x: number; y: number },
  t: number
): { pose: PaddlePose; swinging: boolean } {
  const anim = cpuPaddle(body, p, p.swing, t);
  const swinging = !!p.swing && t >= p.swing.start && t <= p.swing.end + 0.25;
  const q = paddle?.paddleQuat();
  if (!q) return { pose: anim, swinging };
  // 设备的朝向以电视方向为 +y；远端的人面朝 −y，转半圈到场上的坐标
  const f = sideDir(p.side);
  const toCourt = (v: Vec3) => normalize(vec3(f * v.x, f * v.y, v.z));
  const n = toCourt(rotate(q, vec3(0, 1, 0)));
  const up = toCourt(rotate(q, vec3(0, 0, 1)));
  if (swinging)
    return { pose: { pos: anim.pos, normal: n, handle: vec3(-up.x, -up.y, -up.z) }, swinging };
  // 前臂方向：拍头在「自己的坐标」里的方位（0 = 正前方，正 = 往正手侧）和仰角，限制在手臂自然能到的范围
  const fh = forehandSign(p);
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
    pose: {
      pos: vec3(
        grip.x + up.x * GRIP_TO_CENTER,
        grip.y + up.y * GRIP_TO_CENTER,
        grip.z + up.z * GRIP_TO_CENTER
      ),
      normal: n,
      handle: vec3(-up.x, -up.y, -up.z),
    },
    swinging,
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
