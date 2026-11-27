/**
 * 连续回击的靶子：倒扣在台面上的彩色纸杯。出现时从台面上弹出来，被球打中时往上飞、翻滚、慢慢淡出。
 * 坐标同 Arena（仿真坐标，Z 向上），挂在 root 下。
 */
import * as THREE from 'three';
import { TABLE } from '@/sim/constants';

export interface CupState {
  id: number;
  x: number;
  y: number;
  knockedAt: number | null;
  spawnedAt: number;
}

/** 纸杯的高（米）：比真纸杯大一点，从玩家的镜头看过去才看得清 */
const HEIGHT = 0.14;
const COLORS = [0xe63946, 0xf4a261, 0x2a9d8f, 0x457b9d, 0xffb703];
/** 出现时弹出来用多久；被打飞后多久淡完（秒） */
const POP = 0.25;
const FLY = 1.2;

export class CupsView {
  private readonly geo = new THREE.CylinderGeometry(0.042, 0.058, HEIGHT, 24);
  private readonly rimGeo = new THREE.TorusGeometry(0.058, 0.005, 6, 24);
  private readonly meshes = new Map<number, THREE.Group>();

  constructor(private readonly root: THREE.Object3D) {}

  update(cups: readonly CupState[], t: number): void {
    const seen = new Set<number>();
    for (const c of cups) {
      seen.add(c.id);
      let g = this.meshes.get(c.id);
      if (!g) {
        g = this.make(c.id);
        this.meshes.set(c.id, g);
        this.root.add(g);
      }
      this.place(g, c, t);
    }
    for (const [id, g] of this.meshes) {
      if (seen.has(id)) continue;
      g.removeFromParent();
      this.meshes.delete(id);
    }
  }

  /** 一个纸杯：杯身（倒扣：杯口朝下）+ 白色杯沿；杯身的竖轴转到仿真的 Z */
  private make(id: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS[id % COLORS.length],
      roughness: 0.6,
      transparent: true,
    });
    const body = new THREE.Mesh(this.geo, mat);
    body.rotation.x = Math.PI / 2;
    body.position.z = HEIGHT / 2;
    body.castShadow = true;
    const rim = new THREE.Mesh(
      this.rimGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, transparent: true })
    );
    rim.position.z = 0.003;
    g.add(body, rim);
    return g;
  }

  private place(g: THREE.Group, c: CupState, t: number): void {
    const base = TABLE.height;
    if (c.knockedAt === null) {
      const u = Math.min(1, Math.max(0, (t - c.spawnedAt) / POP));
      // 弹出来：先冲过一点再落回 1
      const s = u < 1 ? Math.sin(u * Math.PI * 0.75) / Math.sin(Math.PI * 0.75) : 1;
      g.position.set(c.x, c.y, base);
      g.scale.setScalar(Math.max(0.01, s));
      g.rotation.set(0, 0, 0);
      this.fade(g, 1);
      return;
    }
    // 被打飞：往上、往后飞，翻滚，淡出
    const a = t - c.knockedAt;
    const dir = c.id % 2 ? 1 : -1;
    g.position.set(c.x + dir * 0.4 * a, c.y + 0.9 * a, base + Math.max(0, 2.2 * a - 4.9 * a * a));
    g.rotation.set(7 * a, dir * 5 * a, 0);
    g.scale.setScalar(1);
    this.fade(g, Math.max(0, 1 - a / FLY));
  }

  private fade(g: THREE.Group, alpha: number): void {
    g.visible = alpha > 0;
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.MeshStandardMaterial).opacity = alpha;
    });
  }
}
