/**
 * 人物的动作（和模型无关）：每帧从身体位置、朝向、球拍姿态推出 AvatarPose。
 *
 * WSR 的 Mii 是全身带动挥拍的（2026-11-23 对照实机视频逐帧看）：引拍时上身转过去，击球时转回来、往前压，
 * 大力球整个人往击球方向倒 30–40°；等球时半蹲；够远球侧身探出去。这里都从球拍推：
 *  - 扭转：球拍在持拍一侧身后（引拍）上身就转过去，快速往另一侧挥上身就带着转过来；
 *  - 前倾：拍子往前伸得越远越前倾，挥得越快多压一点；侧倾：拍子偏出身体 0.55 米以外就往那边倒；
 *  - 下蹲：等球时微蹲，拍子低于腰就屈膝，够远球也蹲下去；
 *  - 跑动：骨盆往移动方向倾斜，每一步小跳，脚沿移动方向交替迈；够远球时那一侧的脚跨出去。
 * 电脑和玩家一样：玩家的拍子跟着 Joy-Con，身体也就跟着拍子扭。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { GRIP_TO_CENTER, type PaddlePose } from '../paddlePose';
import type { AvatarPose } from './types';

/** 动作幅度：上身最多扭转、前倾、侧倾多少（弧度），最多下蹲多少（米） */
const TWIST_MAX = 0.75;
const LEAN_MAX = 0.4;
const ROLL_MAX = 0.55;
const CROUCH_MAX = 0.16;
/** 等球时的准备姿势：微蹲、上身微微前倾 */
const READY_CROUCH = 0.05;
const READY_LEAN = 0.12;
/** 准备位置：球拍在持拍一侧身体外 0.28 米（readyPaddle）时上身不转 */
const READY_SIDE = 0.28;
/** 迈一步的距离（米）；脚踝高度、两脚间距（米） */
const STRIDE = 0.4;
const ANKLE_Z = 0.05;
const STANCE = 0.15;
/** 跑动时骨盆最多倾斜多少（弧度，约 10°） */
const RUN_LEAN_MAX = 0.18;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
/** 指数平滑跟随（时间常数 tau 秒） */
const follow = (cur: number, target: number, dt: number, tau: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / tau));
const unit = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
};

export class AvatarMotion {
  private last: { x: number; y: number } | null = null;
  private stride = 0;
  private clock = 0;
  /** 平滑后的移动速度、移动方向（身体局部坐标） */
  private readonly vel = { x: 0, y: 0 };
  private readonly moveDir = { x: 1, y: 0 };
  /** 上一帧球拍在身体局部坐标里的位置，平滑后的球拍横向速度 */
  private lastPaddle: { x: number; y: number } | null = null;
  private paddleVx = 0;
  /** 平滑后的上身姿态 */
  private readonly s = { twist: 0, lean: READY_LEAN, roll: 0, crouch: READY_CROUCH };

  update(
    body: { x: number; y: number },
    facing: 1 | -1,
    /** 持拍手在世界 x 上的方向（forehandSign） */
    shoulderSide: number,
    paddle: PaddlePose,
    dt: number
  ): AvatarPose {
    this.clock += dt;
    this.move(body, facing, dt);
    const sd: 1 | -1 = facing * shoulderSide > 0 ? 1 : -1;
    this.posture(body, facing, sd, paddle, dt);

    const st = this.s;
    const runLean = (v: number) => clamp(0.07 * v, -RUN_LEAN_MAX, RUN_LEAN_MAX);
    const amp = this.runAmp();

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

    // 脚：两脚分开，跑动时沿移动方向交替迈、抬脚；够远球时那一侧的脚跨出去
    const toWorld = (x: number, y: number, z: number): Vec3 => ({
      x: body.x + facing * x,
      y: body.y + facing * y,
      z,
    });
    const reachStep = 0.25 * (st.roll / ROLL_MAX);
    const feet = [-1, 1].map((sx, i) => {
      const swing = 0.16 * amp * Math.sin(this.stride + i * Math.PI);
      const lift = 0.07 * amp * Math.max(0, Math.cos(this.stride + i * Math.PI));
      const stepOut = sx * reachStep > 0 ? reachStep : 0;
      return toWorld(
        sx * STANCE + this.moveDir.x * swing + stepOut,
        this.moveDir.y * swing,
        ANKLE_Z + lift
      );
    }) as [Vec3, Vec3];
    const kneePoles = [-1, 1].map((sx) => unit(facing * sx * 0.25, facing, 0)) as [Vec3, Vec3];

    // 另一只手（在胸的局部坐标里）：上臂垂在身侧略向前，前臂朝前抬到腰前
    const out = -sd;
    return {
      root: { x: body.x, y: body.y, z: 0 },
      facing,
      paddleSide: sd,
      pelvis: {
        drop: st.crouch - this.bob(amp),
        shift: 0.1 * st.roll,
        pitch: runLean(this.vel.y),
        roll: runLean(this.vel.x),
        yaw: 0.4 * st.twist,
      },
      spine: { pitch: st.lean, roll: st.roll, yaw: 0.6 * st.twist },
      head: { yaw: 0, pitch: 0 },
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
      freeHand: {
        upper: unit(out * 0.2, 0.25, -1),
        fore: unit(-out * 0.35, 0.9, 0.25),
        reach: 0.85,
      },
      feet,
      kneePoles,
    };
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

    // 扭转：持拍一侧为正方向的横向位置 + 挥动方向的提前量
    const u = clamp((lx * sd - READY_SIDE) / 0.45 + 0.06 * this.paddleVx * sd, -1, 1);
    const twist = -sd * TWIST_MAX * u;
    // 前倾：拍子往前伸得越远越前倾；快速挥动时多压一点
    const reachFwd = clamp((ly - 0.4) / 0.4, -0.5, 1);
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
    const hop = 0.04 * amp * Math.abs(Math.sin(this.stride));
    const idle = 0.012 * (1 - amp) * (0.5 + 0.5 * Math.sin(this.clock * Math.PI * 2 * 1.6));
    return hop + idle;
  }

  /** 跑动：按走过的距离推进步伐相位，记下移动方向和平滑后的速度（身体局部坐标） */
  private move(body: { x: number; y: number }, facing: 1 | -1, dt: number): void {
    const last = this.last;
    this.last = { x: body.x, y: body.y };
    let vx = 0;
    let vy = 0;
    if (last && dt > 0) {
      const dx = body.x - last.x;
      const dy = body.y - last.y;
      const d = Math.hypot(dx, dy);
      // 瞬移（换发球、新的一分）不算跑动
      if (d < 0.3) {
        this.stride += (d / STRIDE) * Math.PI;
        vx = (facing * dx) / dt;
        vy = (facing * dy) / dt;
        if (d > 1e-4) {
          this.moveDir.x = (facing * dx) / d;
          this.moveDir.y = (facing * dy) / d;
        }
      }
    }
    const k = 1 - Math.exp(-dt / 0.12);
    this.vel.x += (vx - this.vel.x) * k;
    this.vel.y += (vy - this.vel.y) * k;
  }
}
