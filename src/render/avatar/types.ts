/**
 * 人物分两层：动作（AvatarMotion，和模型无关）每帧算出一个 AvatarPose，模型（AvatarBody）按自己的骨骼去摆。
 * 换人物模型只需要换模型这一层，动作不用动。
 *
 * 接一个带骨骼的模型（例如 Sketchfab 上下载的 glb）时，写一个实现 AvatarBody 的类：
 *  - 用 three 的 GLTFLoader 载入，按骨骼名找到：髋（hips）、腰 / 胸（spine、chest）、头（head）、
 *    左右上臂 / 前臂 / 手（upperArm、lowerArm、hand）、左右大腿 / 小腿 / 脚（upperLeg、lowerLeg、foot）；
 *  - apply(pose)：模型的根节点放到 pose.root、按 pose.facing 转身；髋骨按 pose.pelvis 下沉、旋转；
 *    腰、胸两根骨分摊 pose.spine 的旋转；头骨按 pose.head 转；
 *  - 手臂、腿：用模型自己的骨长做两段反向运动学——持拍手到 pose.grip（肘往 pose.elbowPole 弯），
 *    另一只手按 pose.freeHand，两只脚踝到 pose.feet（膝往 pose.kneePoles 弯）；再把骨骼转到对准算出来的关节位置；
 *  - 球拍不属于人物：pose.paddle 给出拍子的位置和朝向，模型层画拍子（或者挂到手骨上）。
 * 模型的比例和现在的不一样也没关系：骨盆、腰的转动是角度，手和脚给的是要到的位置，各自按自己的骨长去够。
 * 版权：只用 CC0 / CC BY（在 NOTICE 里署名）的原创模型，不用同人作品。
 */
import type { Vec3 } from '@/core/vec3';

export interface AvatarLook {
  shirt: number;
  shorts: number;
  skin: number;
  hair: number;
  hairStyle: 'short' | 'bun';
}

/** 一帧的动作。位置都是仿真世界坐标（Z 向上），角度都是弧度、在身体局部（x 右、y 朝前、z 上） */
export interface AvatarPose {
  /** 脚下位置 */
  root: Vec3;
  /** 朝向：+1 朝 +y（近端），−1 朝 −y（远端） */
  facing: 1 | -1;
  /** 持拍手在身体局部的哪一侧：+1 右手、−1 左手 */
  paddleSide: 1 | -1;
  /** 骨盆：比站直时低多少（米，屈膝、起伏）、往身体局部 x 挪多少（米，重心移动）、旋转 */
  pelvis: { drop: number; shift: number; pitch: number; roll: number; yaw: number };
  /** 腰以上相对骨盆的旋转：前倾（pitch，正 = 往前）、侧倾（roll，正 = 往右）、扭转（yaw，正 = 往左转） */
  spine: { pitch: number; roll: number; yaw: number };
  /** 头相对胸的转动（看球、得失分时抬头 / 低头）：yaw 正 = 往左转，pitch 正 = 低头 */
  head: { yaw: number; pitch: number };
  /** 球拍：拍面中心、朝向（四元数，局部 Y = 红面法向，局部 −Z = 拍柄方向） */
  paddle: { pos: Vec3; quat: { x: number; y: number; z: number; w: number } };
  /** 持拍手要握到的位置（拍柄上） */
  grip: Vec3;
  /** 持拍手的肘往哪个方向弯（世界方向） */
  elbowPole: Vec3;
  /**
   * 另一只手：在胸的局部坐标里，上臂方向、前臂方向（单位向量），以及前臂伸出去的比例（0..1）。
   * 用方向而不是位置，换了臂长不同的模型也一样
   */
  freeHand: { upper: Vec3; fore: Vec3; reach: number };
  /** 两只脚踝要到的位置：[左, 右]（身体局部的左右） */
  feet: [Vec3, Vec3];
  /** 两个膝盖往哪个方向弯（世界方向）：[左, 右] */
  kneePoles: [Vec3, Vec3];
}

/** 人物模型：按 AvatarPose 摆好自己 */
export interface AvatarBody {
  readonly group: import('three').Object3D;
  apply(pose: AvatarPose): void;
  /** 半透明的自己：球靠近时更透明一点（0..1，不透明的模型忽略） */
  setFade(extra: number): void;
}
