/**
 * 带骨骼的卡通人物（Kenney「Animated Characters」，CC0）：AvatarBody 的另一种实现，四套衣服是四张贴图。
 *
 * 模型是标准人形骨骼、T 字绑定姿势：Hips → Spine → Chest → UpperChest → Neck → Head，
 * 左右 Arm → ForeArm → Hand（拇指两节、食指三节），左右 UpLeg → Leg → Foot。按 AvatarPose 摆：
 *  - 骨盆、腰、头：在身体坐标里叠加旋转，腰的旋转平均分给 Spine、Chest、UpperChest 三节；
 *  - 持拍手：横握——手掌朝红面、拍头从食指和拇指之间伸出去，由握拍处倒推手腕；
 *    肩 → 肘 → 手腕用两段反向运动学（肘往 pose.elbowPole 弯），前臂跟着手掌转（手腕不拧麻花）；
 *  - 另一只手：和代码人物一样从肩按 pose.freeHand 算出拳头的位置，再用反向运动学够过去；
 *  - 腿：髋 → 膝 → 脚踝用反向运动学（膝往 pose.kneePoles 弯），脚掌放平；
 *  - 手指弯成拳头。
 * 整体缩放到肩高 1.2 米（和 paddlePose 的肩一样高，手臂才够得到球拍）。
 * 近端的自己半透明（和代码人物一样先写深度、再画最前面一层），持拍的手另画一份不透明的。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Vec3 } from '@/core/vec3';
import { FOREARM, UPPER_ARM } from '../paddlePose';
import { twoBone } from './ik';
import modelUrl from './kenney/character.glb?url';
import cyborgUrl from './kenney/cyborg.png?url';
import skaterBoyUrl from './kenney/skater-boy.png?url';
import skaterGirlUrl from './kenney/skater-girl.png?url';
import suitUrl from './kenney/suit.png?url';
import { createPaddleMesh } from './paddleMesh';
import { type AvatarBody, type AvatarPose, POSE_ANKLE_Z } from './types';

export type KenneySkin = 'skater-boy' | 'skater-girl' | 'suit' | 'cyborg';

const SKIN_URLS: Record<KenneySkin, string> = {
  'skater-boy': skaterBoyUrl,
  'skater-girl': skaterGirlUrl,
  suit: suitUrl,
  cyborg: cyborgUrl,
};

/** 肩（上臂根部）离地多高（米）：和 paddlePose.shoulderOf 一致 */
const SHOULDER_Z = 1.2;
/**
 * 拳头（弧度）：四指（这个手套形的手四指连成一块，骨骼叫 Index）每节往掌心弯多少；
 * 拇指根往掌心收（base）、往四指那边摆（swing），第二节再弯（tip），横着包住弯起来的四指。
 * 以前拇指往手背收，拳头一握拇指竖在外面，像点赞
 */
const FINGER_CURL = 1.25;
const THUMB_CURL = { base: 0.9, swing: 0.9, tip: 1.0 };
/** 握拍处在手掌里的位置：从手腕顺着手指方向、往掌心外各多远（按手掌长的比例） */
const GRIP_ALONG = 0.55;
const GRIP_OUT = 0.3;
/** 半透明的自己：深度（9）→ 半透明的身体（10）→ 不透明的持拍手（11） */
const GHOST_DEPTH_ORDER = 9;
const GHOST_ORDER = 10;
const GRIP_HAND_ORDER = 11;
/** 半透明的自己颜色调淡多少（和代码人物一样：深色头发叠在球台上会成一团暗影） */
const GHOST_LIGHTEN = 0.6;

export interface KenneyAssets {
  scene: THREE.Object3D;
  skins: Partial<Record<KenneySkin, THREE.Texture>>;
}

/** 下载模型和要用的贴图 */
export async function loadKenney(skins: KenneySkin[]): Promise<KenneyAssets> {
  const textures = new THREE.TextureLoader();
  const [gltf, ...maps] = await Promise.all([
    new GLTFLoader().loadAsync(modelUrl),
    ...skins.map((s) => textures.loadAsync(SKIN_URLS[s])),
  ]);
  const out: KenneyAssets = { scene: gltf.scene, skins: {} };
  skins.forEach((s, i) => {
    maps[i].colorSpace = THREE.SRGBColorSpace;
    out.skins[s] = maps[i];
  });
  return out;
}

type LR = 'Left' | 'Right';

interface Rest {
  /** 绑定姿势下在 group 坐标（身体在原点、朝 +y）里的朝向、位置 */
  q: THREE.Quaternion;
  p: THREE.Vector3;
}

/** 手在绑定姿势下的方向（group 坐标）：手指方向、掌心朝向、手掌长 */
interface HandRest {
  finger: THREE.Vector3;
  palm: THREE.Vector3;
  thumb: THREE.Vector3;
  length: number;
}

const v = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
const FORWARD = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();

/** b 去掉沿 a（单位向量）的分量后归一；太短就用 fallback */
function perp(b: THREE.Vector3, a: THREE.Vector3, fallback?: THREE.Vector3): THREE.Vector3 {
  const r = b.clone().addScaledVector(a, -b.dot(a));
  if (r.lengthSq() > 1e-8) return r.normalize();
  if (fallback) return perp(fallback, a);
  return perp(Math.abs(a.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : FORWARD, a);
}

/** 以 a 为第一轴、b（和 a 正交化）为第二轴的正交基对应的旋转 */
function basis(a: THREE.Vector3, b: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  const x = a.clone().normalize();
  const y = perp(b, x);
  const z = new THREE.Vector3().crossVectors(x, y);
  return out.setFromRotationMatrix(_m.makeBasis(x, y, z));
}

/** 骨骼的新朝向：把绑定姿势下的两根参考轴（aRest、bRest）对到现在的（aNow、bNow），骨骼跟着一起转 */
function aligned(
  aRest: THREE.Vector3,
  bRest: THREE.Vector3,
  aNow: THREE.Vector3,
  bNow: THREE.Vector3,
  restQ: THREE.Quaternion
): THREE.Quaternion {
  const qr = basis(aRest, bRest, _q1).invert();
  return basis(aNow, bNow, new THREE.Quaternion()).multiply(qr).multiply(restQ);
}

function euler(pitch: number, roll: number, yaw: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, roll, yaw, 'ZXY'));
}

export class KenneyBody implements AvatarBody {
  readonly group = new THREE.Group();
  /** 身体节点：位置、朝向（AvatarPose 的身体局部坐标） */
  private readonly body = new THREE.Group();
  private readonly mesh: THREE.SkinnedMesh;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly baseOpacity: number;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly rest = new Map<string, Rest>();
  private readonly hands: Record<LR, HandRest>;
  private readonly paddle = createPaddleMesh();
  private readonly translucent: boolean;
  /** 半透明时另画的不透明持拍手（按持拍手是哪只来建） */
  private gripHand: { side: LR; mesh: THREE.SkinnedMesh } | null = null;
  /** 模型脚踝离地多高（米） */
  private readonly ankleZ: number;

  constructor(assets: KenneyAssets, skin: KenneySkin, translucent: boolean) {
    this.translucent = translucent;
    this.baseOpacity = translucent ? 0.28 : 1;
    const model = cloneSkinned(assets.scene);
    let mesh: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
    });
    if (!mesh) throw new Error('人物模型里没有蒙皮网格');
    this.mesh = mesh;
    for (const b of this.mesh.skeleton.bones) this.bones.set(b.name, b);

    this.bodyMat = new THREE.MeshStandardMaterial({
      map: assets.skins[skin] ?? null,
      roughness: 0.8,
      transparent: translucent,
      opacity: this.baseOpacity,
      depthWrite: !translucent,
    });
    if (translucent) lighten(this.bodyMat);
    this.mesh.material = this.bodyMat;
    this.mesh.castShadow = true;
    // 骨骼动起来以后绑定姿势的包围球不准，不让它被视锥剔掉
    this.mesh.frustumCulled = false;

    // 模型是 Y 向上、面朝 +Z：转成 Z 向上、面朝 +y（右手在 +x）
    const holder = new THREE.Group();
    holder.rotation.set(Math.PI / 2, Math.PI, 0);
    holder.add(model);
    this.body.add(holder);
    this.group.add(this.body, this.paddle);

    // 缩放到肩高 SHOULDER_Z，脚底放到地面
    this.group.updateMatrixWorld(true);
    // 地面 = 绑定姿势下最低的顶点（蒙皮网格的包围盒要等骨骼矩阵算过才对，这里直接用几何体的）
    this.mesh.geometry.computeBoundingBox();
    const ground = this.mesh.geometry.boundingBox!.clone().applyMatrix4(this.mesh.matrixWorld)
      .min.z;
    const shoulder = this.groupPos('RightArm').z;
    const k = SHOULDER_Z / (shoulder - ground);
    holder.scale.setScalar(k);
    holder.position.z = -ground * k;
    this.group.updateMatrixWorld(true);

    for (const [name, b] of this.bones)
      this.rest.set(name, {
        q: this.groupQuat(b),
        p: this.groupPos(name),
      });
    this.ankleZ = this.restP('LeftFoot').z;
    this.hands = { Left: this.handRest('Left'), Right: this.handRest('Right') };
    this.makeFists();

    if (translucent) {
      this.mesh.renderOrder = GHOST_ORDER;
      const depth = this.twin(
        new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true })
      );
      depth.renderOrder = GHOST_DEPTH_ORDER;
    }
  }

  setFade(extra: number): void {
    if (this.translucent) this.bodyMat.opacity = this.baseOpacity * (1 - extra);
  }

  apply(p: AvatarPose): void {
    this.body.position.set(p.root.x, p.root.y, p.root.z);
    this.body.rotation.set(0, 0, p.facing > 0 ? 0 : Math.PI);
    this.body.updateMatrix();
    const bodyQ = this.body.quaternion;

    // 骨盆：下沉、平移、旋转
    const pelvis = euler(p.pelvis.pitch, p.pelvis.roll, p.pelvis.yaw);
    const hipsP = this.restP('Hips')
      .clone()
      .add(new THREE.Vector3(p.pelvis.shift, 0, -p.pelvis.drop))
      .applyMatrix4(this.body.matrix);
    this.place('Hips', hipsP);
    this.orientBody('Hips', bodyQ, pelvis);

    // 腰：旋转平均分给三节；脖子跟着胸，头再叠加看球的转动
    const spine = euler(p.spine.pitch, p.spine.roll, p.spine.yaw);
    const ident = new THREE.Quaternion();
    ['Spine', 'Chest', 'UpperChest'].forEach((name, i) => {
      const part = ident.clone().slerp(spine, (i + 1) / 3);
      this.orientBody(name, bodyQ, pelvis.clone().multiply(part));
    });
    const chest = pelvis.clone().multiply(spine);
    this.orientBody('Neck', bodyQ, chest);
    this.orientBody('Head', bodyQ, chest.clone().multiply(euler(p.head.pitch, 0, p.head.yaw)));

    // 球拍
    const paddleQ = new THREE.Quaternion(
      p.paddle.quat.x,
      p.paddle.quat.y,
      p.paddle.quat.z,
      p.paddle.quat.w
    );
    this.paddle.position.set(p.paddle.pos.x, p.paddle.pos.y, p.paddle.pos.z);
    this.paddle.quaternion.copy(paddleQ);

    const side: LR = p.paddleSide > 0 ? 'Right' : 'Left';
    const other: LR = side === 'Right' ? 'Left' : 'Right';
    this.gripArm(side, p, paddleQ);
    this.freeArm(other, p, bodyQ.clone().multiply(chest));
    this.leg('Left', p.feet[0], p.kneePoles[0], bodyQ);
    this.leg('Right', p.feet[1], p.kneePoles[1], bodyQ);
    if (this.translucent && this.gripHand?.side !== side) this.makeGripHand(side);
  }

  /** 持拍手：手按球拍朝向握住拍柄，手腕由握拍处倒推，肩 → 肘 → 手腕两段反向运动学 */
  private gripArm(side: LR, p: AvatarPose, paddleQ: THREE.Quaternion): void {
    const hand = this.hands[side];
    // 球拍局部：Y = 红面法向，Z = 拍头方向。横握：掌心朝红面，手指和拇指各偏 45°、拍头从两者之间伸出去
    const s = side === 'Right' ? 1 : -1;
    const finger = new THREE.Vector3(s, 0, 1).normalize().applyQuaternion(paddleQ);
    const palm = new THREE.Vector3(0, 1, 0).applyQuaternion(paddleQ);
    const grip = v(p.grip);
    const wrist = grip
      .clone()
      .addScaledVector(finger, -GRIP_ALONG * hand.length)
      .addScaledVector(palm, -GRIP_OUT * hand.length);
    const handQ = aligned(hand.finger, hand.palm, finger, palm, this.rest.get(`${side}Hand`)!.q);
    this.reach(side, wrist, v(p.elbowPole), palm, handQ);
  }

  /** 另一只手：和代码人物一样从肩按 pose.freeHand 算出拳头位置（胸的局部方向、标准臂长），再够过去 */
  private freeArm(side: LR, p: AvatarPose, chestQ: THREE.Quaternion): void {
    const s = this.groupPos(`${side}Arm`);
    const elbow = s
      .clone()
      .addScaledVector(v(p.freeHand.upper).normalize().applyQuaternion(chestQ), UPPER_ARM);
    const fist = elbow
      .clone()
      .addScaledVector(
        v(p.freeHand.fore).normalize().applyQuaternion(chestQ),
        FOREARM * p.freeHand.reach
      );
    this.reach(side, fist, elbow.clone().sub(s), null, null);
  }

  /**
   * 肩 → 肘 → 手腕到 target：肘往 pole 弯。palm、handQ 给了就让前臂跟着手掌转、手按 handQ 摆；
   * 没给（另一只手）就只把前臂摆过去，手保持在前臂上的样子
   */
  private reach(
    side: LR,
    target: THREE.Vector3,
    pole: THREE.Vector3,
    palm: THREE.Vector3 | null,
    handQ: THREE.Quaternion | null
  ): void {
    const arm = `${side}Arm`;
    const fore = `${side}ForeArm`;
    const handName = `${side}Hand`;
    const s = this.groupPos(arm);
    const l1 = this.restP(fore).distanceTo(this.restP(arm));
    const l2 = this.restP(handName).distanceTo(this.restP(fore));
    const e = v(twoBone(s, target, l1, l2, pole));

    // 上臂：绑定姿势（T 字、掌心朝下）弯肘时前臂往前，所以「前」对到现在前臂偏出去的方向
    const u = e.clone().sub(s).normalize();
    const uRest = this.restP(fore).clone().sub(this.restP(arm)).normalize();
    const bend = perp(target.clone().sub(e), u, pole.clone().negate());
    this.orient(arm, aligned(uRest, FORWARD, u, bend, this.rest.get(arm)!.q));

    const f = target.clone().sub(e).normalize();
    const fRest = this.restP(handName).clone().sub(this.restP(fore)).normalize();
    if (palm && handQ) {
      // 前臂绕自己转到掌心朝向，手腕不拧
      const hand = this.hands[side];
      this.orient(fore, aligned(fRest, hand.palm, f, palm, this.rest.get(fore)!.q));
      this.orient(handName, handQ);
    } else {
      const now = this.groupPos(handName).sub(this.groupPos(fore)).normalize();
      const q = new THREE.Quaternion()
        .setFromUnitVectors(now, f)
        .multiply(this.groupQuat(this.bones.get(fore)!));
      this.orient(fore, q);
    }
  }

  /** 腿：髋 → 膝 → 脚踝，膝往 pole 弯，脚掌放平、朝身体前方 */
  private leg(side: LR, foot: Vec3, kneePole: Vec3, bodyQ: THREE.Quaternion): void {
    const up = `${side}UpLeg`;
    const low = `${side}Leg`;
    const ft = `${side}Foot`;
    const h = this.groupPos(up);
    const a = v(foot);
    a.z += this.ankleZ - POSE_ANKLE_Z;
    const lt = this.restP(low).distanceTo(this.restP(up));
    const ls = this.restP(ft).distanceTo(this.restP(low));
    const pole = v(kneePole);
    const k = v(twoBone(h, a, lt, ls, pole));
    const thigh = k.clone().sub(h).normalize();
    const shin = a.clone().sub(k).normalize();
    const thighRest = this.restP(low).clone().sub(this.restP(up)).normalize();
    const shinRest = this.restP(ft).clone().sub(this.restP(low)).normalize();
    this.orient(up, aligned(thighRest, FORWARD, thigh, perp(pole, thigh), this.rest.get(up)!.q));
    this.orient(low, aligned(shinRest, FORWARD, shin, perp(pole, shin), this.rest.get(low)!.q));
    this.orient(ft, bodyQ.clone().multiply(this.rest.get(ft)!.q));
  }

  /** 手在绑定姿势下的方向：手指（手腕 → 食指根）、掌心（由拇指一侧和手指方向定，左右手镜像） */
  private handRest(side: LR): HandRest {
    const wrist = this.restP(`${side}Hand`);
    const finger = this.restP(`${side}HandIndex1`).clone().sub(wrist);
    const length = finger.length();
    finger.normalize();
    const thumb = perp(this.restP(`${side}HandThumb1`).clone().sub(wrist), finger);
    const palm =
      side === 'Right'
        ? new THREE.Vector3().crossVectors(thumb, finger)
        : new THREE.Vector3().crossVectors(finger, thumb);
    return { finger, palm: palm.normalize(), thumb, length };
  }

  /** 手指弯成拳头（只做一次）：四指往掌心弯，拇指收过来横着包住四指 */
  private makeFists(): void {
    for (const side of ['Left', 'Right'] as const) {
      const h = this.hands[side];
      const fingerAxis = new THREE.Vector3().crossVectors(h.finger, h.palm).normalize();
      const thumbAxis = new THREE.Vector3().crossVectors(h.thumb, h.palm).normalize();
      for (const n of ['Index1', 'Index2', 'Index3'])
        this.curl(`${side}Hand${n}`, fingerAxis, FINGER_CURL);
      this.curl(`${side}HandThumb1`, thumbAxis, THUMB_CURL.base);
      this.curl(`${side}HandThumb1`, h.palm, THUMB_CURL.swing);
      this.curl(`${side}HandThumb2`, thumbAxis, THUMB_CURL.tip);
    }
  }

  /** 绕 group 坐标里的轴（绑定姿势下）把骨骼转一个角度 */
  private curl(name: string, axis: THREE.Vector3, angle: number): void {
    const b = this.bones.get(name);
    if (!b) return;
    const own = axis.clone().applyQuaternion(this.rest.get(name)!.q.clone().invert());
    b.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(own.normalize(), angle));
  }

  /** 半透明的自己：持拍手另画一份不透明的（顶点按蒙皮权重算出是不是这只手，不是的丢掉） */
  private makeGripHand(side: LR): void {
    if (this.gripHand) {
      this.gripHand.mesh.removeFromParent();
      this.gripHand.mesh.geometry.dispose();
    }
    const geo = this.mesh.geometry.clone();
    const handBones = new Set(
      ['Hand', 'HandIndex1', 'HandIndex2', 'HandIndex3', 'HandThumb1', 'HandThumb2'].map((n) =>
        this.mesh.skeleton.bones.indexOf(this.bones.get(`${side}${n}`)!)
      )
    );
    const idx = geo.getAttribute('skinIndex');
    const w = geo.getAttribute('skinWeight');
    const color = new Float32Array(idx.count * 4);
    for (let i = 0; i < idx.count; i++) {
      let a = 0;
      for (let j = 0; j < 4; j++)
        if (handBones.has(idx.getComponent(i, j))) a += w.getComponent(i, j);
      color.set([1, 1, 1, a], i * 4);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(color, 4));
    const mat = new THREE.MeshStandardMaterial({
      map: this.bodyMat.map,
      roughness: 0.8,
      vertexColors: true,
      alphaTest: 0.5,
      // 排在半透明的身体之后画，盖住身体那层
      transparent: true,
    });
    const hand = this.twin(mat, geo);
    hand.renderOrder = GRIP_HAND_ORDER;
    this.gripHand = { side, mesh: hand };
  }

  /** 和身体共用骨骼的另一份网格（同一个父节点、同样的变换） */
  private twin(material: THREE.Material, geometry = this.mesh.geometry): THREE.SkinnedMesh {
    const m = new THREE.SkinnedMesh(geometry, material);
    m.position.copy(this.mesh.position);
    m.quaternion.copy(this.mesh.quaternion);
    m.scale.copy(this.mesh.scale);
    m.bind(this.mesh.skeleton, this.mesh.bindMatrix);
    m.frustumCulled = false;
    this.mesh.parent!.add(m);
    return m;
  }

  private restP(name: string): THREE.Vector3 {
    return this.rest.get(name)!.p;
  }

  /** 骨骼现在在 group 坐标里的位置 */
  private groupPos(name: string): THREE.Vector3 {
    return this.group.worldToLocal(this.bones.get(name)!.getWorldPosition(new THREE.Vector3()));
  }

  /** 物体现在在 group 坐标里的朝向 */
  private groupQuat(o: THREE.Object3D): THREE.Quaternion {
    const g = this.group.getWorldQuaternion(new THREE.Quaternion()).invert();
    return g.multiply(o.getWorldQuaternion(_q2));
  }

  /** 骨骼在身体坐标里叠加一个旋转（绑定姿势的朝向之上） */
  private orientBody(name: string, bodyQ: THREE.Quaternion, delta: THREE.Quaternion): void {
    this.orient(name, bodyQ.clone().multiply(delta).multiply(this.rest.get(name)!.q));
  }

  /** 把骨骼转到 group 坐标里的某个朝向 */
  private orient(name: string, q: THREE.Quaternion): void {
    const b = this.bones.get(name)!;
    const parent = this.groupQuat(b.parent!);
    b.quaternion.copy(parent.invert().multiply(q));
    b.updateMatrixWorld(true);
  }

  /** 把骨骼挪到 group 坐标里的某个位置 */
  private place(name: string, p: THREE.Vector3): void {
    const b = this.bones.get(name)!;
    b.parent!.updateWorldMatrix(true, false);
    b.position.copy(b.parent!.worldToLocal(this.group.localToWorld(_v1.copy(p))));
    b.updateMatrixWorld(true);
  }
}

/** 半透明的自己：颜色往白色调淡（贴图乘上去以后再混） */
function lighten(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), ${GHOST_LIGHTEN.toFixed(2)});`
    );
  };
}
