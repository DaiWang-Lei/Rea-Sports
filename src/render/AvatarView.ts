/**
 * 场上的一个人：动作（AvatarMotion，和模型无关）+ 人物模型（AvatarBody）。
 * 现在的模型是代码生成的 Q 版人物（ProceduralBody）；换成带骨骼的模型只需要另写一个 AvatarBody，
 * 在 createBody 里换掉（接法见 avatar/types.ts）。
 */
import type * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { AvatarMotion } from './avatar/motion';
import { ProceduralBody } from './avatar/ProceduralBody';
import type { AvatarBody, AvatarLook } from './avatar/types';
import type { PaddlePose } from './paddlePose';

export type { AvatarLook } from './avatar/types';

/** 换人物模型就换这里 */
function createBody(look: AvatarLook, translucent: boolean): AvatarBody {
  return new ProceduralBody(look, translucent);
}

export class AvatarView {
  private readonly motion = new AvatarMotion();
  private readonly body: AvatarBody;
  private paddlePos: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(root: THREE.Object3D, look: AvatarLook, translucent: boolean) {
    this.body = createBody(look, translucent);
    root.add(this.body.group);
  }

  get group(): THREE.Object3D {
    return this.body.group;
  }

  /** 球靠近时让自己更透明一点 */
  setFade(extra: number): void {
    this.body.setFade(extra);
  }

  update(
    body: { x: number; y: number },
    facing: 1 | -1,
    shoulderSide: number,
    paddle: PaddlePose,
    dt: number
  ): void {
    const pose = this.motion.update(body, facing, shoulderSide, paddle, dt);
    this.body.apply(pose);
    this.paddlePos = pose.paddle.pos;
  }

  get paddlePosition(): Vec3 {
    return { ...this.paddlePos };
  }
}
