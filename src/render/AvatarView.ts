/**
 * 场上的一个人：动作（AvatarMotion，和模型无关）+ 人物模型（AvatarBody：代码生成的 Q 版人物或带骨骼的模型，
 * 见 avatar/roster.ts；再加一种模型的接法见 avatar/types.ts）。
 */
import type * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { AvatarMotion, type AvatarReaction } from './avatar/motion';
import type { AvatarBody } from './avatar/types';
import type { PaddlePose } from './paddlePose';

export class AvatarView {
  private readonly motion = new AvatarMotion();
  private readonly body: AvatarBody;
  private paddlePos: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(root: THREE.Object3D, body: AvatarBody) {
    this.body = body;
    root.add(this.body.group);
  }

  get group(): THREE.Object3D {
    return this.body.group;
  }

  /** 球靠近时让自己更透明一点 */
  setFade(extra: number): void {
    this.body.setFade(extra);
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
    ball: Vec3 | null = null
  ): void {
    const pose = this.motion.update(body, facing, shoulderSide, paddle, dt, ball);
    this.body.apply(pose);
    this.paddlePos = pose.paddle.pos;
  }

  get paddlePosition(): Vec3 {
    return { ...this.paddlePos };
  }
}
