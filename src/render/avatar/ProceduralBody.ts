/**
 * 代码生成的 Q 版人物（AvatarBody 的一种实现，以后可以换成带骨骼的模型，见 types.ts）：
 * 大头（眼睛、腮红、微笑、头发）、收腰的球衣、短裤、球鞋、两只手臂，双色球拍（红 = 正手面，黑 = 反手面）。
 *
 * 骨架：身体节点（位置、朝向）→ 骨盆（短裤、两个髋关节）→ 腰（上衣、脖子、头、两个肩点）。
 * 手臂、腿是一节节圆柱，每帧按算出来的关节位置摆：持拍手从肩点到 pose.grip、腿从髋到 pose.feet，
 * 中间的肘、膝用两段反向运动学求。
 *
 * 近端的自己画成半透明（WSR / NSSR 的做法），保证随时看得到球：先只写一遍深度，再只把最前面那层表面半透明地画出来，
 * 身体各部分不会互相透出来；球拍始终不透明。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { FOREARM, UPPER_ARM } from '../paddlePose';
import type { AvatarBody, AvatarLook, AvatarPose } from './types';

const BLADE_R = 0.078;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
/** 半透明的自己：先画深度（renderOrder 9），再画颜色（10），排在其它半透明物体（球网、球影）之后 */
const GHOST_DEPTH_ORDER = 9;
const GHOST_ORDER = 10;

/** 骨架尺寸（米）：骨盆高度（站直时）、腰在骨盆上方、髋在骨盆下方、大腿 / 小腿长 */
const PELVIS_Z = 0.62;
const SPINE_UP = 0.06;
const HIP_DOWN = 0.06;
const HIP_OUT = 0.09;
const THIGH = 0.29;
const SHIN = 0.29;
/** 肩点在胸上的位置（相对腰，左右、前后、上下）：和 paddlePose.shoulderOf 站直时一致 */
const SHOULDER = { out: 0.19, fwd: 0.04, up: 1.2 - PELVIS_Z - SPINE_UP };

/** 把沿 Y 轴、长 1 的圆柱摆到 a → b */
function segment(m: THREE.Object3D, a: Vec3, b: Vec3): void {
  tmp.set(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = Math.max(0.02, tmp.length());
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  m.scale.set(1, len, 1);
  m.quaternion.setFromUnitVectors(Y_AXIS, tmp.normalize());
}

const add = (a: Vec3, d: Vec3, k: number): Vec3 => ({
  x: a.x + d.x * k,
  y: a.y + d.y * k,
  z: a.z + d.z * k,
});
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/**
 * 两段骨骼（a → 关节 → c，长 l1、l2）的关节位置，关节往 pole 方向弯。
 * 够不着时两段按比例拉长（手、脚仍然到目标位置，不会和球拍 / 地面脱开）
 */
function twoBone(a: Vec3, c: Vec3, l1: number, l2: number, pole: Vec3): Vec3 {
  const d = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-6) return add(a, pole, l1);
  const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
  if (len >= l1 + l2) return add(a, dir, (l1 / (l1 + l2)) * len);
  const l = Math.max(len, Math.abs(l1 - l2) + 1e-3);
  const cosA = clamp((l1 * l1 + l * l - l2 * l2) / (2 * l1 * l), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pd = pole.x * dir.x + pole.y * dir.y + pole.z * dir.z;
  let p = { x: pole.x - pd * dir.x, y: pole.y - pd * dir.y, z: pole.z - pd * dir.z };
  const pl = Math.hypot(p.x, p.y, p.z);
  p = pl < 1e-6 ? { x: 0, y: 0, z: 1 } : { x: p.x / pl, y: p.y / pl, z: p.z / pl };
  return {
    x: a.x + l1 * (cosA * dir.x + sinA * p.x),
    y: a.y + l1 * (cosA * dir.y + sinA * p.y),
    z: a.z + l1 * (cosA * dir.z + sinA * p.z),
  };
}

/** 球衣：回转体，腰细、胸宽、肩部收圆（局部 Z 向上，原点在腰） */
function shirtGeometry(): THREE.BufferGeometry {
  const base = PELVIS_Z + SPINE_UP;
  const pts = [
    [0.0, 0.66],
    [0.175, 0.66],
    [0.165, 0.8],
    [0.19, 1.02],
    [0.18, 1.14],
    [0.13, 1.23],
    [0.06, 1.27],
    [0.0, 1.27],
  ].map(([r, z]) => new THREE.Vector2(r, z - base));
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(Math.PI / 2);
  // 前后扁一点
  g.scale(1, 0.78, 1);
  return g;
}

interface Limb {
  upper: THREE.Mesh;
  sleeve: THREE.Mesh | null;
  lower: THREE.Mesh;
  end: THREE.Object3D;
}

export class ProceduralBody implements AvatarBody {
  readonly group = new THREE.Group();
  private readonly bodyGroup = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly shoulders = { r: new THREE.Object3D(), l: new THREE.Object3D() };
  private readonly hipJoints: THREE.Object3D[] = [];
  private readonly legs: Limb[] = [];
  private readonly paddleArm: Limb;
  private readonly freeArm: Limb;
  private readonly paddle = new THREE.Group();
  private readonly bodyMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly baseOpacity: number;

  constructor(look: AvatarLook, translucent: boolean) {
    this.baseOpacity = translucent ? 0.28 : 1;
    const mats = new Map<string, THREE.MeshStandardMaterial>();
    const white = new THREE.Color(0xffffff);
    const mat = (c: number, roughness = 0.7) => {
      const key = `${c}/${roughness}`;
      let m = mats.get(key);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          // 半透明的自己调淡：深色头发、皮肤叠在球台上会成一团暗影
          color: translucent ? new THREE.Color(c).lerp(white, 0.6) : c,
          roughness,
          transparent: translucent,
          opacity: this.baseOpacity,
          depthWrite: !translucent,
        });
        mats.set(key, m);
        this.bodyMaterials.push(m);
      }
      return m;
    };
    const mesh = (g: THREE.BufferGeometry, c: number, roughness?: number) =>
      new THREE.Mesh(g, mat(c, roughness));
    const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T => {
      o.position.set(x, y, z);
      return o;
    };

    // ---- 骨盆：短裤、两个髋关节
    this.pelvis.rotation.order = 'ZXY';
    this.pelvis.add(
      at(
        mesh(new THREE.CylinderGeometry(0.175, 0.19, 0.24, 20).rotateX(Math.PI / 2), look.shorts),
        0,
        0,
        -0.04
      )
    );
    for (const sx of [-1, 1]) {
      const hip = at(new THREE.Object3D(), sx * HIP_OUT, 0, -HIP_DOWN);
      this.pelvis.add(hip);
      this.hipJoints.push(hip);
    }

    // ---- 腰以上：上衣、脖子、头、两个肩点
    this.spine.position.z = SPINE_UP;
    this.spine.rotation.order = 'ZXY';
    this.spine.add(
      mesh(shirtGeometry(), look.shirt),
      at(
        mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 12).rotateX(Math.PI / 2), look.skin),
        0,
        0,
        1.3 - PELVIS_Z - SPINE_UP
      )
    );
    this.shoulders.r.position.set(SHOULDER.out, SHOULDER.fwd, SHOULDER.up);
    this.shoulders.l.position.set(-SHOULDER.out, SHOULDER.fwd, SHOULDER.up);
    this.spine.add(this.shoulders.r, this.shoulders.l);

    // 头（局部 +y = 脸朝向）
    const head = at(this.head, 0, 0, 1.49 - PELVIS_Z - SPINE_UP);
    head.rotation.order = 'ZXY';
    const skull = mesh(new THREE.SphereGeometry(0.2, 28, 20), look.skin, 0.6);
    skull.scale.set(1, 0.95, 0.93);
    head.add(skull);
    for (const sx of [-1, 1]) {
      head.add(
        at(mesh(new THREE.SphereGeometry(0.04, 12, 8), look.skin, 0.6), sx * 0.19, 0, -0.01)
      );
      const eye = at(
        mesh(new THREE.SphereGeometry(0.028, 14, 10), 0x1d1d24, 0.3),
        sx * 0.07,
        0.175,
        0
      );
      eye.scale.set(1, 0.5, 1.4);
      head.add(eye);
      head.add(
        at(
          mesh(new THREE.SphereGeometry(0.009, 8, 6), 0xffffff, 0.2),
          sx * 0.07 + 0.008,
          0.19,
          0.014
        )
      );
      const cheek = at(
        mesh(new THREE.SphereGeometry(0.03, 12, 8), 0xff9aa8, 0.8),
        sx * 0.12,
        0.15,
        -0.05
      );
      cheek.scale.set(1, 0.4, 0.7);
      head.add(cheek);
    }
    const smile = mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 14, Math.PI), 0x8a3b3b, 0.6);
    smile.rotation.set(Math.PI / 2, 0, Math.PI);
    smile.position.set(0, 0.182, -0.07);
    head.add(smile);
    // 头发：盖住头顶和后脑，前面留出额头；往后倾，后脑盖得更低
    const hair = mesh(
      new THREE.SphereGeometry(0.212, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
      look.hair,
      0.8
    );
    hair.rotation.x = Math.PI / 2 + 0.45;
    hair.scale.set(1, 0.95, 0.95);
    head.add(hair);
    if (look.hairStyle === 'bun')
      head.add(at(mesh(new THREE.SphereGeometry(0.08, 16, 12), look.hair, 0.8), 0, -0.12, 0.17));
    this.spine.add(head);

    this.pelvis.add(this.spine);
    this.bodyGroup.add(this.pelvis);
    this.group.add(this.bodyGroup);

    // ---- 腿（世界坐标，每帧按髋、膝、脚踝摆）：大腿、小腿、鞋（鞋上一道球衣颜色的条纹）
    for (let i = 0; i < 2; i++) {
      const shoe = new THREE.Group();
      const sole = mesh(new THREE.SphereGeometry(1, 16, 10), 0xffffff, 0.5);
      sole.scale.set(0.07, 0.12, 0.055);
      sole.position.set(0, 0.03, -0.02);
      const stripe = mesh(new THREE.SphereGeometry(1, 12, 8), look.shirt, 0.5);
      stripe.scale.set(0.072, 0.09, 0.03);
      stripe.position.set(0, 0.02, -0.02);
      shoe.add(sole, stripe);
      const leg: Limb = {
        upper: mesh(new THREE.CylinderGeometry(0.06, 0.052, 1, 12), look.skin),
        sleeve: null,
        lower: mesh(new THREE.CylinderGeometry(0.052, 0.045, 1, 12), look.skin),
        end: shoe,
      };
      this.group.add(leg.upper, leg.lower, shoe);
      this.legs.push(leg);
    }

    // ---- 两只手臂（世界坐标，每帧按肩、肘、手摆）
    const arm = (): Limb => {
      const a: Limb = {
        upper: mesh(new THREE.CylinderGeometry(0.045, 0.04, 1, 12), look.skin),
        sleeve: mesh(new THREE.CylinderGeometry(0.068, 0.06, 1, 14), look.shirt),
        lower: mesh(new THREE.CylinderGeometry(0.04, 0.036, 1, 12), look.skin),
        end: mesh(new THREE.SphereGeometry(0.048, 14, 10), look.skin),
      };
      this.group.add(a.upper, a.sleeve!, a.lower, a.end);
      return a;
    };
    this.paddleArm = arm();
    this.freeArm = arm();

    // ---- 球拍：局部 Y = 红面法向，局部 −Z = 拍柄方向
    const red = new THREE.Mesh(
      new THREE.CylinderGeometry(BLADE_R, BLADE_R, 0.004, 32),
      new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.5 })
    );
    red.position.y = 0.003;
    const black = new THREE.Mesh(
      new THREE.CylinderGeometry(BLADE_R, BLADE_R, 0.004, 32),
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 })
    );
    black.position.y = -0.003;
    const wood = new THREE.Mesh(
      new THREE.CylinderGeometry(BLADE_R + 0.002, BLADE_R + 0.002, 0.003, 32),
      new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.6 })
    );
    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.028, 0.022, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.6 })
    );
    handle.position.z = -(BLADE_R + 0.045);
    this.paddle.add(red, black, wood, handle);
    this.group.add(this.paddle);

    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    if (translucent) this.addGhostDepth();
  }

  /** 半透明的身体：每块再挂一份只写深度的副本，先画 */
  private addGhostDepth(): void {
    const depthOnly = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      transparent: true,
    });
    const parts: THREE.Mesh[] = [];
    this.group.traverse((o) => {
      if (
        o instanceof THREE.Mesh &&
        this.bodyMaterials.includes(o.material as THREE.MeshStandardMaterial)
      )
        parts.push(o);
    });
    for (const m of parts) {
      m.renderOrder = GHOST_ORDER;
      const d = new THREE.Mesh(m.geometry, depthOnly);
      d.renderOrder = GHOST_DEPTH_ORDER;
      m.add(d);
    }
  }

  setFade(extra: number): void {
    if (this.baseOpacity >= 1) return;
    for (const m of this.bodyMaterials) m.opacity = this.baseOpacity * (1 - extra);
  }

  apply(p: AvatarPose): void {
    // 身体、骨盆、腰、头（绕 x 转 = −前倾）
    this.bodyGroup.position.set(p.root.x, p.root.y, p.root.z);
    this.bodyGroup.rotation.set(0, 0, p.facing > 0 ? 0 : Math.PI);
    this.pelvis.position.set(p.pelvis.shift, 0, PELVIS_Z - p.pelvis.drop);
    this.pelvis.rotation.set(-p.pelvis.pitch, p.pelvis.roll, p.pelvis.yaw);
    this.spine.rotation.set(-p.spine.pitch, p.spine.roll, p.spine.yaw);
    this.head.rotation.set(-p.head.pitch, 0, p.head.yaw);
    this.group.updateMatrixWorld(true);

    // 球拍
    this.paddle.position.set(p.paddle.pos.x, p.paddle.pos.y, p.paddle.pos.z);
    this.paddle.quaternion.set(p.paddle.quat.x, p.paddle.quat.y, p.paddle.quat.z, p.paddle.quat.w);

    // 持拍手：胸上的肩点 → 肘 → 握拍处
    const side = p.paddleSide > 0 ? 'r' : 'l';
    const s = this.inGroup(this.shoulders[side]);
    this.place(this.paddleArm, s, twoBone(s, p.grip, UPPER_ARM, FOREARM, p.elbowPole), p.grip);

    // 另一只手：方向在胸的局部坐标里
    const s2 = this.inGroup(this.shoulders[side === 'r' ? 'l' : 'r']);
    const e2 = add(s2, this.chestDir(p.freeHand.upper), UPPER_ARM);
    const g2 = add(e2, this.chestDir(p.freeHand.fore), FOREARM * p.freeHand.reach);
    this.place(this.freeArm, s2, e2, g2);

    // 腿：髋 → 膝 → 脚踝
    this.legs.forEach((leg, i) => {
      const hip = this.inGroup(this.hipJoints[i]);
      const ankle = p.feet[i];
      const knee = twoBone(hip, ankle, THIGH, SHIN, p.kneePoles[i]);
      segment(leg.upper, hip, knee);
      segment(leg.lower, knee, ankle);
      leg.end.position.set(ankle.x, ankle.y, ankle.z);
      leg.end.rotation.set(0, 0, p.facing > 0 ? 0 : Math.PI);
    });
  }

  /** 骨架上某个点在 group 坐标（= 仿真世界坐标）里的位置 */
  private inGroup(o: THREE.Object3D): Vec3 {
    const w = o.getWorldPosition(new THREE.Vector3());
    const v = this.group.worldToLocal(w);
    return { x: v.x, y: v.y, z: v.z };
  }

  /** 胸的局部坐标里的方向 → group 坐标里的方向（单位向量） */
  private chestDir(d: Vec3): Vec3 {
    const q = this.spine.getWorldQuaternion(new THREE.Quaternion());
    const gq = this.group.getWorldQuaternion(new THREE.Quaternion()).invert();
    const v = new THREE.Vector3(d.x, d.y, d.z).normalize().applyQuaternion(q).applyQuaternion(gq);
    return { x: v.x, y: v.y, z: v.z };
  }

  private place(a: Limb, s: Vec3, e: Vec3, g: Vec3): void {
    segment(a.upper, s, e);
    // 袖子盖住上臂靠肩的一截
    if (a.sleeve) {
      const d = Math.hypot(e.x - s.x, e.y - s.y, e.z - s.z) || 1;
      segment(
        a.sleeve,
        s,
        add(s, { x: (e.x - s.x) / d, y: (e.y - s.y) / d, z: (e.z - s.z) / d }, 0.12)
      );
    }
    segment(a.lower, e, g);
    a.end.position.set(g.x, g.y, g.z);
  }
}
