/** 调试页的 3D 姿态视图：一个按 Joy-Con 比例做的方块，跟随融合后的姿态 */
import * as THREE from 'three';
import type { Quat } from '@/core/quat';

/** 仿真/融合坐标（Z 向上）→ three.js 坐标（Y 向上）：绕 X 轴转 −90° */
export const SIM_TO_THREE = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2
);

export class OrientationView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10);
  private readonly pad = new THREE.Group();
  private readonly joycon = new THREE.Group();
  private readonly phone = new THREE.Group();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);

    const root = new THREE.Group();
    root.quaternion.copy(SIM_TO_THREE);
    this.scene.add(root);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.5, 1, 0.8);
    this.scene.add(sun);

    // 世界坐标轴（仿真系）：X 红、Y 绿（指向屏幕）、Z 蓝（向上）
    const axes = new THREE.AxesHelper(0.12);
    axes.position.set(-0.16, 0, -0.08);
    root.add(axes);

    // Joy-Con 机体：X 指向肩键一端，Y 向左，Z 从按键面朝外
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.102, 0.036, 0.028),
      new THREE.MeshStandardMaterial({ color: 0xe0434b, roughness: 0.6 })
    );
    this.joycon.add(body);
    // 按键面上的白色标记（+Z）
    const face = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.024, 0.002),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 })
    );
    face.position.set(0, 0, 0.0145);
    this.joycon.add(face);
    // 摇杆（+Z 面上，靠近肩键）
    const stick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.008, 20),
      new THREE.MeshStandardMaterial({ color: 0x222222 })
    );
    stick.rotation.x = Math.PI / 2;
    stick.position.set(0.02, 0, 0.019);
    this.joycon.add(stick);
    // 肩键一端（+X）深色端盖
    const shoulder = new THREE.Mesh(
      new THREE.BoxGeometry(0.008, 0.038, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x1b1b1b })
    );
    shoulder.position.set(0.055, 0, 0);
    this.joycon.add(shoulder);
    // 手机：X 指向手机顶端，Y 向左，Z 从屏幕朝外
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.072, 0.008),
      new THREE.MeshStandardMaterial({ color: 0x8a96a3, roughness: 0.4, metalness: 0.3 })
    );
    this.phone.add(slab);
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.066, 0.001),
      new THREE.MeshStandardMaterial({ color: 0x1d3b5e, emissive: 0x0c2238, roughness: 0.2 })
    );
    screen.position.z = 0.0045;
    this.phone.add(screen);
    // 顶端的「听筒」标记
    const ear = new THREE.Mesh(
      new THREE.BoxGeometry(0.006, 0.02, 0.002),
      new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    ear.position.set(0.066, 0, 0.0055);
    this.phone.add(ear);
    this.phone.visible = false;

    this.pad.add(this.joycon, this.phone);
    root.add(this.pad);

    // 相机在仿真系 (0, −0.32, 0.12)，即玩家身后、略高处，看向屏幕方向（+Y）
    this.camera.position.set(0, 0.12, 0.32);
    this.camera.lookAt(0, 0, 0);
  }

  setModel(kind: 'joycon' | 'phone'): void {
    this.joycon.visible = kind === 'joycon';
    this.phone.visible = kind === 'phone';
  }

  setOrientation(q: Quat): void {
    this.pad.quaternion.set(q.x, q.y, q.z, q.w);
  }

  render(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  }
}
