/**
 * 场上的一个人：动作（AvatarMotion，和模型无关）+ 人物模型（AvatarBody：代码生成的 Q 版人物或带骨骼的模型，
 * 见 avatar/roster.ts；再加一种模型的接法见 avatar/types.ts）。
 * 一个人可以有半透明、不透明两份模型（分屏时自己的镜头里半透明，对方的镜头里不透明），摆同一个姿势；用到时才创建。
 */
import type * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { AvatarMotion, type AvatarReaction } from './avatar/motion';
import type { AvatarBody, AvatarPose } from './avatar/types';
import type { PaddlePose } from './paddlePose';

type Copy = 'ghost' | 'solid';

export class AvatarView {
  private readonly motion = new AvatarMotion();
  private paddlePos: Vec3 = { x: 0, y: 0, z: 0 };
  /** 两份模型和它们在哪一层的镜头里画（null = 不画） */
  private readonly copies: Record<Copy, { body: AvatarBody | null; layer: number | null }> = {
    ghost: { body: null, layer: null },
    solid: { body: null, layer: null },
  };
  /** 场上有没有这个人（发球机练习时远端没有人） */
  private present = true;
  /** 这一帧摆的姿势（回放录这个） */
  private pose: AvatarPose | null = null;

  /** make(true) = 半透明的那份 */
  constructor(
    private readonly root: THREE.Object3D,
    private readonly make: (translucent: boolean) => AvatarBody
  ) {}

  /** 半透明的那份、不透明的那份各在哪一层画（null = 不画） */
  show(ghostLayer: number | null, solidLayer: number | null): void {
    this.place('ghost', ghostLayer);
    this.place('solid', solidLayer);
  }

  private place(kind: Copy, layer: number | null): void {
    const c = this.copies[kind];
    c.layer = layer;
    if (layer !== null && !c.body) {
      c.body = this.make(kind === 'ghost');
      this.root.add(c.body.group);
    }
    if (c.body) {
      if (layer !== null) c.body.group.traverse((o) => o.layers.set(layer));
      c.body.group.visible = this.present && layer !== null;
    }
  }

  private get shown(): AvatarBody[] {
    return Object.values(this.copies)
      .filter((c) => c.layer !== null && c.body)
      .map((c) => c.body!);
  }

  /** 不要这个人了（换人物）：模型从场景里拿掉 */
  remove(): void {
    for (const c of Object.values(this.copies)) c.body?.group.removeFromParent();
  }

  set visible(v: boolean) {
    this.present = v;
    for (const b of this.shown) b.group.visible = v;
  }

  /** 球靠近时让自己更透明一点（只对半透明的那份起作用） */
  setFade(extra: number): void {
    for (const b of this.shown) b.setFade(extra);
  }

  /** 得失分反应：得分的挥拳跳起，失分的低头 */
  react(kind: AvatarReaction, dur?: number): void {
    this.motion.react(kind, dur);
  }

  update(
    body: { x: number; y: number },
    facing: 1 | -1,
    shoulderSide: number,
    paddle: PaddlePose,
    dt: number,
    /** 球的位置（头跟着球转；不在场上时 null） */
    ball: Vec3 | null = null,
    /** 接不住扣杀、缩头弯腰躲着 */
    cowering = false
  ): void {
    const pose = this.motion.update(body, facing, shoulderSide, paddle, dt, ball, cowering);
    for (const b of this.shown) b.apply(pose);
    this.paddlePos = pose.paddle.pos;
    this.pose = pose;
  }

  get lastPose(): AvatarPose | null {
    return this.pose;
  }

  /** 回放：直接摆成录下来的姿势（不经过动作计算，回放完接着正常动） */
  applyPose(pose: AvatarPose): void {
    for (const b of this.shown) b.apply(pose);
  }

  get paddlePosition(): Vec3 {
    return { ...this.paddlePos };
  }
}
