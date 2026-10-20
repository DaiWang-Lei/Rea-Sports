/** 发球机：放在远端台尾的箱子 + 斜向上的出球管，出球口对准 machine 位置 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';

export class BallMachineView {
  readonly group = new THREE.Group();
  private readonly mouth = new THREE.Group();

  constructor(root: THREE.Object3D) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.3, 0.42),
      new THREE.MeshStandardMaterial({ color: 0xf5a524, roughness: 0.5 })
    );
    body.position.set(0, 0.06, -0.3);
    const hopper = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.11, 0.18, 20, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.4, side: THREE.DoubleSide })
    );
    hopper.rotation.x = Math.PI / 2;
    hopper.position.set(0, 0.08, -0.02);
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 0.22, 16),
      new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6 })
    );
    // 出球管从箱子前方斜向下指向近端
    tube.rotation.x = Math.PI / 2 - 0.35;
    tube.position.set(0, -0.05, -0.1);
    this.mouth.add(tube);
    const stand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 1.0, 10),
      new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.7 })
    );
    stand.rotation.x = Math.PI / 2;
    stand.position.set(0, 0.05, -0.85);
    this.group.add(body, hopper, this.mouth, stand);
    this.group.visible = false;
    root.add(this.group);
  }

  /** p：出球口位置（仿真坐标） */
  update(p: Vec3 | null): void {
    this.group.visible = !!p;
    if (!p) return;
    this.group.position.set(p.x, p.y, p.z);
    // 箱子朝向近端（−y）
    this.group.rotation.z = Math.PI;
  }
}
