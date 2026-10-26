/**
 * 简化的人物：胶囊身体 + 球形头 + 两条腿 + 持拍手臂（上臂、前臂两段，肘按反向运动学弯曲）
 * + 双色球拍（红 = 正手面，黑 = 反手面）。
 * 近端的自己画成半透明（WSR 的做法），保证随时看得到球；球拍始终不透明。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { elbowOf, GRIP_TO_CENTER, type PaddlePose, shoulderOf } from './paddlePose';

const BLADE_R = 0.078;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

/** 把沿 Y 轴、长 1 的圆柱摆到 a → b */
function segment(m: THREE.Mesh, a: Vec3, b: Vec3): void {
  tmp.set(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = Math.max(0.02, tmp.length());
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  m.scale.set(1, len, 1);
  m.quaternion.setFromUnitVectors(Y_AXIS, tmp.normalize());
}

export class AvatarView {
  readonly group = new THREE.Group();
  private readonly bodyGroup = new THREE.Group();
  private readonly upperArm: THREE.Mesh;
  private readonly forearm: THREE.Mesh;
  private readonly elbow: THREE.Mesh;
  private readonly hand: THREE.Mesh;
  private readonly paddle = new THREE.Group();
  private readonly bodyMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly baseOpacity: number;

  constructor(root: THREE.Object3D, color: number, translucent: boolean) {
    this.baseOpacity = translucent ? 0.3 : 1;
    const mat = (c: number) => {
      const m = new THREE.MeshStandardMaterial({
        color: c,
        roughness: 0.7,
        transparent: translucent,
        opacity: this.baseOpacity,
        depthWrite: !translucent,
      });
      this.bodyMaterials.push(m);
      return m;
    };
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.36, 6, 16), mat(color));
    torso.rotation.x = Math.PI / 2;
    torso.position.z = 0.98;
    this.bodyGroup.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 16), mat(0xf1c9a5));
    head.position.z = 1.42;
    this.bodyGroup.add(head);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.55, 4, 10), mat(0x2d3748));
      leg.rotation.x = Math.PI / 2;
      leg.position.set(sx * 0.09, 0, 0.36);
      this.bodyGroup.add(leg);
    }
    this.group.add(this.bodyGroup);

    const skin = mat(0xf1c9a5);
    this.upperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.035, 1, 10), skin);
    this.forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.028, 1, 10), skin);
    this.elbow = new THREE.Mesh(new THREE.SphereGeometry(0.037, 12, 10), skin);
    this.hand = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 10), skin);
    this.group.add(this.upperArm, this.forearm, this.elbow, this.hand);

    // 球拍：局部 Y = 红面法向，局部 −Z = 拍柄方向
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

    root.add(this.group);
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

    // 手臂：肩 → 肘 → 握拍处（拍柄末端往拍面方向一点）
    const s = shoulderOf(body, facing, shoulderSide);
    const g = {
      x: paddle.pos.x + h.x * GRIP_TO_CENTER,
      y: paddle.pos.y + h.y * GRIP_TO_CENTER,
      z: paddle.pos.z + h.z * GRIP_TO_CENTER,
    };
    const e = elbowOf(s, g, facing, shoulderSide);
    segment(this.upperArm, s, e);
    segment(this.forearm, e, g);
    this.elbow.position.set(e.x, e.y, e.z);
    this.hand.position.set(g.x, g.y, g.z);
  }

  get paddlePosition(): Vec3 {
    return { x: this.paddle.position.x, y: this.paddle.position.y, z: this.paddle.position.z };
  }
}
