/**
 * 击球、落台的小特效：击球处扩散一个带短线的圆环（扣杀、强力发球是金色、更大），
 * 落台处在台面上闪一圈（帮助看清落点）；人发球时在最佳击球高度显示一个提示圈。
 * 坐标用仿真坐标（Z 向上），挂在 root 下。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { TABLE } from '@/sim/constants';

const HIT_LIFE = 0.3;
const BOUNCE_LIFE = 0.4;
const POOL = 4;

/** 圆环 + 外圈 8 条短线 */
function burstTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#ffffff';
  g.lineCap = 'round';
  g.lineWidth = 7;
  g.beginPath();
  g.arc(64, 64, 38, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 6;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    g.beginPath();
    g.moveTo(64 + Math.cos(a) * 50, 64 + Math.sin(a) * 50);
    g.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const easeOut = (u: number) => 1 - (1 - u) * (1 - u);

/** 发球的最佳击球点提示 */
export interface ServeCue {
  p: Vec3;
  ideal: number;
  window: number;
}

export class Effects {
  private readonly hits: Array<{ sprite: THREE.Sprite; t0: number; strong: boolean }> = [];
  private readonly bounces: Array<{ mesh: THREE.Mesh; t0: number }> = [];
  private nextHit = 0;
  private nextBounce = 0;
  private readonly cue: THREE.Mesh;
  private readonly cueMat: THREE.MeshBasicMaterial;
  private cueSince = NaN;

  constructor(root: THREE.Object3D) {
    const map = burstTexture();
    for (let i = 0; i < POOL; i++) {
      // 始终在最上层：近端自己（半透明）挡在拍子前面时也看得到
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false })
      );
      sprite.renderOrder = 20;
      sprite.visible = false;
      root.add(sprite);
      this.hits.push({ sprite, t0: -Infinity, strong: false });

      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.82, 1, 40),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false })
      );
      mesh.visible = false;
      root.add(mesh);
      this.bounces.push({ mesh, t0: -Infinity });
    }

    // 发球提示圈：水平放在最佳击球高度，球落进圈里时挥拍；始终画在最上层（半透明的自己挡在前面也看得到）
    this.cueMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.cue = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.085, 48), this.cueMat);
    this.cue.renderOrder = 21;
    this.cue.visible = false;
    root.add(this.cue);
  }

  /**
   * 发球提示圈：抛球后淡入；球进入强力发球的时间窗（理想时刻 ±window）时变成金色、稍大；之后很快淡出。
   * cue = null 时不显示
   */
  serveCue(cue: ServeCue | null, t: number): void {
    if (!cue) {
      this.cue.visible = false;
      this.cueSince = NaN;
      return;
    }
    if (Number.isNaN(this.cueSince)) this.cueSince = t;
    const late = t - (cue.ideal + cue.window);
    if (late > 0.25) {
      this.cue.visible = false;
      return;
    }
    this.cue.visible = true;
    this.cue.position.set(cue.p.x, cue.p.y, cue.p.z);
    const inWindow = Math.abs(t - cue.ideal) <= cue.window;
    this.cueMat.color.set(inWindow ? 0xffd166 : 0xffffff);
    const fadeIn = Math.min(1, (t - this.cueSince) / 0.25);
    const fadeOut = late > 0 ? 1 - late / 0.25 : 1;
    this.cueMat.opacity = (inWindow ? 0.95 : 0.45) * fadeIn * fadeOut;
    this.cue.scale.setScalar(inWindow ? 1.15 : 1);
  }

  hit(p: Vec3, strong: boolean, t: number): void {
    const h = this.hits[this.nextHit];
    this.nextHit = (this.nextHit + 1) % POOL;
    h.t0 = t;
    h.strong = strong;
    h.sprite.position.set(p.x, p.y, p.z);
    (h.sprite.material as THREE.SpriteMaterial).color.set(strong ? 0xffd166 : 0xffffff);
  }

  bounce(p: Vec3, t: number): void {
    const b = this.bounces[this.nextBounce];
    this.nextBounce = (this.nextBounce + 1) % POOL;
    b.t0 = t;
    b.mesh.position.set(p.x, p.y, TABLE.height + 0.002);
  }

  update(t: number): void {
    for (const h of this.hits) {
      const u = (t - h.t0) / HIT_LIFE;
      h.sprite.visible = u >= 0 && u < 1;
      if (!h.sprite.visible) continue;
      const size = (h.strong ? 0.16 : 0.1) + (h.strong ? 0.4 : 0.22) * easeOut(u);
      h.sprite.scale.set(size, size, 1);
      (h.sprite.material as THREE.SpriteMaterial).opacity = 1 - u;
    }
    for (const b of this.bounces) {
      const u = (t - b.t0) / BOUNCE_LIFE;
      b.mesh.visible = u >= 0 && u < 1;
      if (!b.mesh.visible) continue;
      b.mesh.scale.setScalar(0.03 + 0.1 * easeOut(u));
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - u);
    }
  }
}
