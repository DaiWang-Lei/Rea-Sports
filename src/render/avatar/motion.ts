/**
 * 人物的动作（和模型无关）：每帧从身体位置、朝向、球拍姿态、球的位置推出 AvatarPose。
 *
 * WSR 的 Mii 是全身带动挥拍的（2026-11-23 对照实机视频逐帧看）：引拍时上身转过去，击球时转回来、往前压，
 * 大力球整个人往击球方向倒 30–40°；等球时半蹲、两腿分开；横向跑动看得清迈步；够远球侧身探出去、跨大步；
 * 头一直跟着球；每分结束得分的挥拳跳起、失分的低头。这里：
 *  - 扭转：球拍在持拍一侧身后（引拍）上身就转过去，快速往另一侧挥上身就带着转过来；
 *  - 前倾：拍子往前伸得越远越前倾，挥得越快多压一点；侧倾：拍子偏出身体以外、或者挥得快，就往拍子那边倒；
 *  - 下蹲：等球时半蹲，拍子低于腰就屈膝，够远球也蹲下去；
 *  - 步法：脚踩实了就固定在地上，身体走远了（离脚该在的位置超过 9 厘米）后面那只脚才抬起来迈到新位置，
 *    两只脚轮流迈；够远球时那一侧的脚跨出去；
 *  - 头：转向球（左右、上下都有限度），球不在场上时看前方；
 *  - 得失分反应（react）：得分的挥拳、跳两下、抬头，失分的弯腰低头、手垂下来，约 1.6 秒。
 * 电脑和玩家一样：玩家的拍子跟着 Joy-Con，身体也就跟着拍子扭。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { GRIP_TO_CENTER, type PaddlePose, READY_PADDLE } from '../paddlePose';
import { COWER_DROP } from '@/sim/players/PlayerSim';
import { type AvatarPose, POSE_ANKLE_Z } from './types';

/** 动作幅度：上身最多扭转、前倾、侧倾多少（弧度），最多下蹲多少（米） */
const TWIST_MAX = 0.75;
const LEAN_MAX = 0.4;
const ROLL_MAX = 0.55;
const CROUCH_MAX = 0.18;
/** 等球时的准备姿势：半蹲、上身微微前倾 */
const READY_CROUCH = 0.08;
const READY_LEAN = 0.14;
/** 跑动的步伐相位：每走这么远一步（米，只用来算起伏） */
const STRIDE = 0.4;
/** 脚踝高度、两脚间距（米） */
const ANKLE_Z = POSE_ANKLE_Z;
const STANCE = 0.18;
/**
 * 步法：脚离该在的位置多远就迈一步（米；身体基本停住时门槛小一点，最后一步预判多了能收回来）、
 * 抬脚多高、迈一步多久（秒，跑得越快越短）、脚往前预判多久
 */
const STEP_TRIGGER = 0.09;
const SETTLE_TRIGGER = 0.06;
const STEP_LIFT = 0.07;
const STEP_DUR = { slow: 0.24, fast: 0.13 };
const STEP_LEAD = 0.12;
/** 跑动时骨盆最多倾斜多少（弧度，约 10°） */
const RUN_LEAN_MAX = 0.18;
/** 头最多转多少（左右、抬头、低头，弧度） */
const HEAD_YAW_MAX = 1.1;
const HEAD_UP_MAX = 0.55;
const HEAD_DOWN_MAX = 0.6;
/** 头的高度（站直时，米） */
const HEAD_Z = 1.49;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
/** 指数平滑跟随（时间常数 tau 秒） */
const follow = (cur: number, target: number, dt: number, tau: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / tau));
const unit = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
};
const blendDir = (a: Vec3, b: Vec3, r: number): Vec3 =>
  unit(a.x + (b.x - a.x) * r, a.y + (b.y - a.y) * r, a.z + (b.z - a.z) * r);
const smooth = (u: number) => u * u * (3 - 2 * u);

interface Foot {
  /** 脚踝现在的位置（世界） */
  pos: Vec3;
  /** 正在迈的一步：起点、终点、开始时刻、用时；null = 踩在地上 */
  step: { from: Vec3; to: Vec3; t0: number; dur: number } | null;
}

/** 得分挥拳跳起；失分低头；ouch = 被球打到脸上 / 身上，头往后一仰、手捂脸 */
export type AvatarReaction = 'win' | 'lose' | 'ouch';

export class AvatarMotion {
  private last: { x: number; y: number } | null = null;
  private teleported = true;
  private stride = 0;
  private clock = 0;
  /** 平滑后的移动速度（身体局部坐标） */
  private readonly vel = { x: 0, y: 0 };
  /** 上一帧球拍在身体局部坐标里的位置，平滑后的球拍横向速度 */
  private lastPaddle: { x: number; y: number } | null = null;
  private paddleVx = 0;
  /** 平滑后的上身姿态、头 */
  private readonly s = { twist: 0, lean: READY_LEAN, roll: 0, crouch: READY_CROUCH };
  private readonly look = { yaw: 0, pitch: 0 };
  /** 两只脚：[左, 右]（身体局部） */
  private readonly feet: [Foot, Foot] = [
    { pos: { x: 0, y: 0, z: ANKLE_Z }, step: null },
    { pos: { x: 0, y: 0, z: ANKLE_Z }, step: null },
  ];
  /** 正在做的得失分反应 */
  private reaction: { kind: AvatarReaction; t0: number; dur: number } | null = null;
  /** 缩头弯腰躲扣杀的程度（0..1，平滑） */
  private cower = 0;

  /** 每分结束：得分的挥拳跳起，失分的低头（持续 dur 秒） */
  react(kind: AvatarReaction, dur = 1.6): void {
    this.reaction = { kind, t0: this.clock, dur };
  }

  update(
    body: { x: number; y: number },
    facing: 1 | -1,
    /** 持拍手在世界 x 上的方向（forehandSign） */
    shoulderSide: number,
    paddle: PaddlePose,
    dt: number,
    /** 球的位置（不在场上时 null） */
    ball: Vec3 | null = null,
    /** 接不住扣杀、缩头弯腰躲着 */
    cowering = false
  ): AvatarPose {
    this.clock += dt;
    this.cower = follow(this.cower, cowering ? 1 : 0, dt, cowering ? 0.06 : 0.25);
    const cw = this.cower;
    this.move(body, facing, dt);
    const sd: 1 | -1 = facing * shoulderSide > 0 ? 1 : -1;
    this.posture(body, facing, sd, paddle, dt);

    const st = this.s;
    const runLean = (v: number) => clamp(0.07 * v, -RUN_LEAN_MAX, RUN_LEAN_MAX);
    const amp = this.runAmp();
    const r = this.reactionWeight();
    const kind = this.reaction?.kind;
    const win = kind === 'win' ? r : 0;
    const lose = kind === 'lose' ? r : 0;
    const ouch = kind === 'ouch' ? r : 0;
    // 得分时跳两下
    const tr = this.reaction ? this.clock - this.reaction.t0 : 0;
    const jump = win * 0.12 * Math.max(0, Math.sin(tr * Math.PI * 2 * 2.2));

    // 球拍朝向：局部 Y = 红面法向，局部 −Z = 拍柄方向；握拍处在拍柄上
    const n = new THREE.Vector3(paddle.normal.x, paddle.normal.y, paddle.normal.z).normalize();
    let h = new THREE.Vector3(paddle.handle.x, paddle.handle.y, paddle.handle.z);
    h.sub(n.clone().multiplyScalar(h.dot(n)));
    if (h.lengthSq() < 1e-6) h = new THREE.Vector3(0, 0, -1);
    h.normalize();
    const zAxis = h.clone().negate();
    const xAxis = new THREE.Vector3().crossVectors(n, zAxis).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(xAxis, n, zAxis)
    );

    const feet = this.stepFeet(body, facing, sd, jump);
    const kneePoles = [-1, 1].map((sx) => unit(facing * sx * 0.25, facing, 0)) as [Vec3, Vec3];
    const crouch = st.crouch + 0.05 * lose + COWER_DROP * cw;
    this.lookAt(body, facing, crouch, ball, dt);

    // 另一只手（在胸的局部坐标里）：平时握拳放在腹前（上臂垂在身侧略向前、前臂往前往里收）；得分举拳，失分垂下
    const out = -sd;
    let upper = unit(out * 0.05, 0.3, -1);
    let fore = unit(-out * 0.55, 0.82, 0.17);
    let reach = 0.57;
    if (win > 0) {
      upper = blendDir(upper, unit(out * 0.35, 0.15, 1), win);
      fore = blendDir(fore, unit(-out * 0.05, 0.3, 1), win);
      reach += (0.8 - reach) * win;
    } else if (lose > 0) {
      upper = blendDir(upper, unit(out * 0.1, 0.05, -1), lose);
      fore = blendDir(fore, unit(out * 0.05, 0.15, -1), lose);
      reach += (0.95 - reach) * lose;
    }
    // 缩头躲球：手挡在脸前；被打中：手捂脸
    const guard = Math.max(cw, ouch);
    if (guard > 0) {
      upper = blendDir(upper, unit(out * 0.05, 0.8, 0.3), guard);
      fore = blendDir(fore, unit(-out * 0.8, 0.2, 0.6), guard);
      reach += (0.55 - reach) * guard;
    }
    // 被打中：头往后一仰、晃两下
    const wobble = ouch * 0.15 * Math.sin(tr * Math.PI * 2 * 3);

    return {
      root: { x: body.x, y: body.y, z: 0 },
      facing,
      paddleSide: sd,
      pelvis: {
        drop: crouch - this.bob(amp) - jump,
        shift: 0.1 * st.roll,
        pitch: runLean(this.vel.y),
        roll: runLean(this.vel.x),
        yaw: 0.4 * st.twist,
      },
      spine: {
        pitch: st.lean - 0.25 * win + 0.35 * lose + 0.5 * cw - 0.3 * ouch,
        roll: st.roll + wobble,
        yaw: 0.6 * st.twist * (1 - cw),
      },
      head: {
        yaw: this.look.yaw * (1 - r) * (1 - cw),
        pitch:
          this.look.pitch * (1 - r) * (1 - cw) - 0.3 * win + 0.5 * lose + 0.45 * cw - 0.6 * ouch,
      },
      paddle: {
        pos: { ...paddle.pos },
        quat: { x: q.x, y: q.y, z: q.z, w: q.w },
      },
      grip: {
        x: paddle.pos.x + h.x * GRIP_TO_CENTER,
        y: paddle.pos.y + h.y * GRIP_TO_CENTER,
        z: paddle.pos.z + h.z * GRIP_TO_CENTER,
      },
      // 和 paddlePose.elbowOf 一样：肘尖朝下、略向前、向外
      elbowPole: unit(facing * sd * 0.15, facing * 0.25, -1),
      freeHand: { upper, fore, reach },
      feet,
      kneePoles,
    };
  }

  /** 得失分反应的权重（0..1）：0.15 秒淡入，最后 0.35 秒淡出 */
  private reactionWeight(): number {
    const re = this.reaction;
    if (!re) return 0;
    const t = this.clock - re.t0;
    if (t >= re.dur) {
      this.reaction = null;
      return 0;
    }
    return smooth(clamp(t / 0.15, 0, 1)) * smooth(clamp((re.dur - t) / 0.35, 0, 1));
  }

  /**
   * 步法：每只脚踩实了就固定在地上；离该在的位置（两脚分开站，往移动方向预判 STEP_LEAD 秒；够远球那一侧跨出去）
   * 超过 STEP_TRIGGER 就迈一步，迈到身体到时候的位置。两只脚轮流迈（离得特别远、超过 0.5 米时不等，快速侧滑步会短暂腾空）。瞬移时脚直接放到位
   */
  private stepFeet(
    body: { x: number; y: number },
    facing: 1 | -1,
    sd: 1 | -1,
    jump: number
  ): [Vec3, Vec3] {
    const speed = Math.hypot(this.vel.x, this.vel.y);
    // 身体速度（世界）：身体局部转回世界只差朝向
    const vw = { x: facing * this.vel.x, y: facing * this.vel.y };
    const reachStep = 0.28 * (this.s.roll / ROLL_MAX);
    const rest = (i: number, lead: number): Vec3 => {
      const sx = i === 0 ? -1 : 1;
      const stepOut = sx * reachStep > 0 ? reachStep : 0;
      // 准备姿势：持拍一侧的脚略靠后（侧身）
      const back = sx === sd ? -0.05 : 0.03;
      return {
        x: body.x + facing * (sx * STANCE + stepOut) + vw.x * lead,
        y: body.y + facing * back + vw.y * lead,
        z: ANKLE_Z,
      };
    };
    if (this.teleported) {
      this.feet.forEach((f, i) => {
        f.pos = rest(i, 0);
        f.step = null;
      });
      this.teleported = false;
    }
    const dur = clamp(STEP_DUR.slow - 0.09 * speed, STEP_DUR.fast, STEP_DUR.slow);
    // 身体基本停住时不往前预判（平滑后的速度要过一会儿才归零，按它预判会多迈出去），门槛也小一点
    const moving = speed >= 0.15;
    const lead = moving ? STEP_LEAD : 0;
    const trigger = moving ? STEP_TRIGGER : SETTLE_TRIGGER;
    // 离目标最远的、踩在地上的那只脚先迈；另一只脚正在迈时，除非离得特别远就等它落地
    const order = [0, 1].sort(
      (a, b) => dist2(this.feet[b].pos, rest(b, lead)) - dist2(this.feet[a].pos, rest(a, lead))
    );
    for (const i of order) {
      const f = this.feet[i];
      const other = this.feet[1 - i];
      if (f.step) continue;
      const d = Math.sqrt(dist2(f.pos, rest(i, lead)));
      if (d > trigger && (!other.step || d > 0.5)) {
        f.step = { from: { ...f.pos }, to: rest(i, moving ? lead + dur : 0), t0: this.clock, dur };
      }
    }
    for (const f of this.feet) {
      const s = f.step;
      if (!s) continue;
      const u = clamp((this.clock - s.t0) / s.dur, 0, 1);
      const k = smooth(u);
      f.pos = {
        x: s.from.x + (s.to.x - s.from.x) * k,
        y: s.from.y + (s.to.y - s.from.y) * k,
        z: ANKLE_Z + STEP_LIFT * Math.sin(Math.PI * u),
      };
      if (u >= 1) f.step = null;
    }
    return this.feet.map((f) => ({ ...f.pos, z: f.pos.z + jump })) as [Vec3, Vec3];
  }

  /** 头：转向球（相对胸，已扣掉上身的扭转），平滑跟随；球不在场上时看前方 */
  private lookAt(
    body: { x: number; y: number },
    facing: 1 | -1,
    crouch: number,
    ball: Vec3 | null,
    dt: number
  ): void {
    let yaw = 0;
    let pitch = 0;
    if (ball) {
      const dx = facing * (ball.x - body.x);
      const dy = facing * (ball.y - body.y);
      const dz = ball.z - (HEAD_Z - crouch);
      yaw = clamp(Math.atan2(-dx, dy) - this.s.twist, -HEAD_YAW_MAX, HEAD_YAW_MAX);
      pitch = clamp(-Math.atan2(dz, Math.hypot(dx, dy)), -HEAD_UP_MAX, HEAD_DOWN_MAX);
    }
    this.look.yaw = follow(this.look.yaw, yaw, dt, 0.07);
    this.look.pitch = follow(this.look.pitch, pitch, dt, 0.07);
  }

  /** 上身姿态：从球拍在身体局部坐标里的位置和横向速度推出扭转、前倾、侧倾、下蹲，平滑跟随 */
  private posture(
    body: { x: number; y: number },
    facing: 1 | -1,
    sd: 1 | -1,
    paddle: PaddlePose,
    dt: number
  ): void {
    const lx = facing * (paddle.pos.x - body.x);
    const ly = facing * (paddle.pos.y - body.y);
    const lp = this.lastPaddle;
    this.lastPaddle = { x: lx, y: ly };
    const vx = lp && dt > 0 ? (lx - lp.x) / dt : 0;
    this.paddleVx = follow(this.paddleVx, clamp(vx, -12, 12), dt, 0.04);

    // 扭转：持拍一侧为正方向的横向位置（拍子在准备位置时不转）+ 挥动方向的提前量
    const u = clamp((lx * sd - READY_PADDLE.side) / 0.45 + 0.06 * this.paddleVx * sd, -1, 1);
    const twist = -sd * TWIST_MAX * u;
    // 前倾：拍子比准备位置往前伸得越远越前倾；快速挥动时多压一点
    const reachFwd = clamp((ly - READY_PADDLE.fwd) / 0.4, -0.5, 1);
    const swingSpeed = Math.min(1, Math.abs(this.paddleVx) / 6);
    const lean = READY_LEAN + 0.2 * reachFwd + 0.12 * swingSpeed;
    // 侧倾：拍子偏出身体 0.55 米以外就往那边倒（够远球）；挥得快时也往拍子那一侧压过去（Wii 的 Mii 击球时整个人倒向那边）
    const reachRoll = ROLL_MAX * clamp((Math.abs(lx) - 0.55) / 0.45, 0, 1);
    const roll = Math.sign(lx) * Math.min(ROLL_MAX, reachRoll + 0.3 * swingSpeed);
    // 下蹲：拍子低于腰（约 1 米）就屈膝；够远球时也蹲下去
    const crouch =
      READY_CROUCH +
      (CROUCH_MAX - READY_CROUCH) *
        clamp(Math.max((1.0 - paddle.pos.z) / 0.35, Math.abs(roll) / ROLL_MAX), 0, 1);

    const st = this.s;
    st.twist = follow(st.twist, twist, dt, 0.05);
    st.lean = follow(st.lean, clamp(lean, -0.1, LEAN_MAX), dt, 0.06);
    st.roll = follow(st.roll, roll, dt, 0.08);
    st.crouch = follow(st.crouch, crouch, dt, 0.08);
  }

  /** 跑动的幅度（0..1，约 1.2 m/s 算全速） */
  private runAmp(): number {
    return Math.min(1, Math.hypot(this.vel.x, this.vel.y) / 1.2);
  }

  /** 等球时脚下轻轻颠，跑动时每一步一个小跳（骨盆往上的量） */
  private bob(amp: number): number {
    const hop = 0.03 * amp * Math.abs(Math.sin(this.stride));
    const idle = 0.012 * (1 - amp) * (0.5 + 0.5 * Math.sin(this.clock * Math.PI * 2 * 1.6));
    return hop + idle;
  }

  /** 跑动：按走过的距离推进步伐相位，记下平滑后的速度（身体局部坐标）；一帧挪太远算瞬移 */
  private move(body: { x: number; y: number }, facing: 1 | -1, dt: number): void {
    const last = this.last;
    this.last = { x: body.x, y: body.y };
    let vx = 0;
    let vy = 0;
    if (!last) {
      this.teleported = true;
    } else if (dt > 0) {
      const dx = body.x - last.x;
      const dy = body.y - last.y;
      const d = Math.hypot(dx, dy);
      // 瞬移（换发球、新的一分）不算跑动，脚直接放到位
      if (d >= 0.3) {
        this.teleported = true;
      } else {
        this.stride += (d / STRIDE) * Math.PI;
        vx = (facing * dx) / dt;
        vy = (facing * dy) / dt;
      }
    }
    const k = 1 - Math.exp(-dt / 0.12);
    this.vel.x += (vx - this.vel.x) * k;
    this.vel.y += (vy - this.vel.y) * k;
  }
}

function dist2(a: Vec3, b: Vec3): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
