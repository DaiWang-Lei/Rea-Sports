/**
 * Q 版人物：大头（眼睛、腮红、微笑、头发）、收腰的球衣、短裤、球鞋，两只手臂
 * （持拍手按反向运动学弯肘，另一只手在身前保持准备姿势），移动时腿会迈步。
 * 双色球拍：红 = 正手面，黑 = 反手面。
 * 近端的自己画成半透明（WSR / NSSR 的做法），保证随时看得到球：先只写一遍深度，再只把最前面那层表面半透明地画出来，
 * 身体各部分不会互相透出来；球拍始终不透明。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import {
  elbowOf,
  FOREARM,
  GRIP_TO_CENTER,
  type PaddlePose,
  shoulderOf,
  UPPER_ARM,
} from './paddlePose';

export interface AvatarLook {
  shirt: number;
  shorts: number;
  skin: number;
  hair: number;
  hairStyle: 'short' | 'bun';
}

const BLADE_R = 0.078;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
/** 半透明的自己：先画深度（renderOrder 9），再画颜色（10），排在其它半透明物体（球网、球影）之后 */
const GHOST_DEPTH_ORDER = 9;
const GHOST_ORDER = 10;
/** 迈一步的距离（米） */
const STRIDE = 0.4;

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
const unit = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
};

/** 球衣：回转体，腰细、胸宽、肩部收圆（局部 Z 向上） */
function shirtGeometry(): THREE.BufferGeometry {
  const pts = [
    [0.0, 0.66],
    [0.175, 0.66],
    [0.165, 0.8],
    [0.19, 1.02],
    [0.18, 1.14],
    [0.13, 1.23],
    [0.06, 1.27],
    [0.0, 1.27],
  ].map(([r, z]) => new THREE.Vector2(r, z));
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(Math.PI / 2);
  // 前后扁一点
  g.scale(1, 0.78, 1);
  return g;
}

interface Arm {
  upper: THREE.Mesh;
  sleeve: THREE.Mesh;
  fore: THREE.Mesh;
  hand: THREE.Mesh;
}

export class AvatarView {
  readonly group = new THREE.Group();
  /** 跟着身体位置、朝向走的部分 */
  private readonly bodyGroup = new THREE.Group();
  private readonly hips: THREE.Group[] = [];
  private readonly paddleArm: Arm;
  private readonly freeArm: Arm;
  private readonly paddle = new THREE.Group();
  private readonly bodyMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly baseOpacity: number;
  private last: { x: number; y: number } | null = null;
  private stride = 0;
  private stepAmp = 0;
  private readonly stepAxis = new THREE.Vector3(1, 0, 0);

  constructor(root: THREE.Object3D, look: AvatarLook, translucent: boolean) {
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

    // ---- 腿、鞋（每条腿挂在髋关节上，迈步时绕髋转）
    for (const sx of [-1, 1]) {
      const hip = at(new THREE.Group(), sx * 0.09, 0, 0.56);
      const leg = mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.5, 12), look.skin);
      leg.rotation.x = Math.PI / 2;
      leg.position.z = -0.26;
      const shoe = mesh(new THREE.SphereGeometry(1, 16, 10), 0xffffff, 0.5);
      shoe.scale.set(0.07, 0.12, 0.055);
      shoe.position.set(0, 0.03, -0.5);
      const stripe = mesh(new THREE.SphereGeometry(1, 12, 8), look.shirt, 0.5);
      stripe.scale.set(0.072, 0.09, 0.03);
      stripe.position.set(0, 0.02, -0.5);
      hip.add(leg, shoe, stripe);
      this.hips.push(hip);
      this.bodyGroup.add(hip);
    }

    // ---- 短裤、球衣、脖子
    this.bodyGroup.add(
      at(
        mesh(new THREE.CylinderGeometry(0.175, 0.19, 0.24, 20).rotateX(Math.PI / 2), look.shorts),
        0,
        0,
        0.58
      ),
      mesh(shirtGeometry(), look.shirt),
      at(
        mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 12).rotateX(Math.PI / 2), look.skin),
        0,
        0,
        1.3
      )
    );

    // ---- 头（局部 +y = 脸朝向）
    const head = at(new THREE.Group(), 0, 0, 1.49);
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
    this.bodyGroup.add(head);
    this.group.add(this.bodyGroup);

    // ---- 两只手臂（世界坐标，每帧按肩、肘、手摆）
    const arm = (): Arm => {
      const upper = mesh(new THREE.CylinderGeometry(0.045, 0.04, 1, 12), look.skin);
      const sleeve = mesh(new THREE.CylinderGeometry(0.068, 0.06, 1, 14), look.shirt);
      const fore = mesh(new THREE.CylinderGeometry(0.04, 0.036, 1, 12), look.skin);
      const hand = mesh(new THREE.SphereGeometry(0.048, 14, 10), look.skin);
      this.group.add(upper, sleeve, fore, hand);
      return { upper, sleeve, fore, hand };
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
    root.add(this.group);
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

  /** 球靠近时让自己更透明一点 */
  setFade(extra: number): void {
    if (this.baseOpacity >= 1) return;
    for (const m of this.bodyMaterials) m.opacity = this.baseOpacity * (1 - extra);
  }

  update(
    body: { x: number; y: number },
    facing: 1 | -1,
    shoulderSide: number,
    paddle: PaddlePose
  ): void {
    this.bodyGroup.position.set(body.x, body.y, 0);
    this.bodyGroup.rotation.z = facing > 0 ? 0 : Math.PI;
    this.walk(body, facing);

    // 球拍
    const n = new THREE.Vector3(paddle.normal.x, paddle.normal.y, paddle.normal.z).normalize();
    let h = new THREE.Vector3(paddle.handle.x, paddle.handle.y, paddle.handle.z);
    h.sub(n.clone().multiplyScalar(h.dot(n))); // 拍柄方向与法向正交
    if (h.lengthSq() < 1e-6) h = new THREE.Vector3(0, 0, -1);
    h.normalize();
    const zAxis = h.clone().negate();
    const xAxis = new THREE.Vector3().crossVectors(n, zAxis).normalize();
    const m = new THREE.Matrix4().makeBasis(xAxis, n, zAxis);
    this.paddle.quaternion.setFromRotationMatrix(m);
    this.paddle.position.set(paddle.pos.x, paddle.pos.y, paddle.pos.z);

    // 持拍手：肩 → 肘 → 握拍处（拍柄末端往拍面方向一点）
    const s = shoulderOf(body, facing, shoulderSide);
    const g = {
      x: paddle.pos.x + h.x * GRIP_TO_CENTER,
      y: paddle.pos.y + h.y * GRIP_TO_CENTER,
      z: paddle.pos.z + h.z * GRIP_TO_CENTER,
    };
    this.pose(this.paddleArm, s, elbowOf(s, g, facing, shoulderSide), g);

    // 另一只手：上臂垂在身侧略向前，前臂朝前抬到腰前（准备姿势）
    const s2 = shoulderOf(body, facing, -shoulderSide);
    const e2 = add(s2, unit(-shoulderSide * 0.2, facing * 0.25, -1), UPPER_ARM);
    const g2 = add(e2, unit(shoulderSide * 0.35, facing * 0.9, 0.25), FOREARM * 0.85);
    this.pose(this.freeArm, s2, e2, g2);
  }

  private pose(a: Arm, s: Vec3, e: Vec3, g: Vec3): void {
    segment(a.upper, s, e);
    // 袖子盖住上臂靠肩的一截
    segment(a.sleeve, s, add(s, unit(e.x - s.x, e.y - s.y, e.z - s.z), 0.12));
    segment(a.fore, e, g);
    a.hand.position.set(g.x, g.y, g.z);
  }

  /** 按走过的距离迈步：两腿绕髋交替摆（转轴垂直于移动方向），身体随步子轻轻起伏 */
  private walk(body: { x: number; y: number }, facing: 1 | -1): void {
    const last = this.last;
    this.last = { x: body.x, y: body.y };
    if (!last) return;
    const dx = body.x - last.x;
    const dy = body.y - last.y;
    const d = Math.hypot(dx, dy);
    // 瞬移（换发球、新的一分）不算走路
    if (d > 0.3) return;
    this.stride += (d / STRIDE) * Math.PI;
    // 每帧挪 1.5cm 以上（约 0.9 m/s）算全速
    this.stepAmp += (Math.min(1, d / 0.015) - this.stepAmp) * 0.15;
    if (d > 1e-4) {
      // 换到身体局部坐标（远端身体转了 180°）
      const lx = facing > 0 ? dx : -dx;
      const ly = facing > 0 ? dy : -dy;
      this.stepAxis.set(-ly / d, lx / d, 0);
    }
    this.hips.forEach((hip, i) => {
      const a = this.stepAmp * 0.45 * Math.sin(this.stride + i * Math.PI);
      hip.quaternion.setFromAxisAngle(this.stepAxis, a);
    });
    this.bodyGroup.position.z = this.stepAmp * 0.025 * Math.abs(Math.sin(this.stride));
  }

  get paddlePosition(): Vec3 {
    return { x: this.paddle.position.x, y: this.paddle.position.y, z: this.paddle.position.z };
  }
}
