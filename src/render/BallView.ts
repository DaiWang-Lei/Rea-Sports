/** 球、投在台面/地面上的影子（判断远近的关键）、拖尾（高球摇晃 / 扣杀拖影） */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { BALL, TABLE } from '@/sim/constants';

const VISUAL_SCALE = 1.25;
const TRAIL_POINTS = 14;

export type TrailStyle = 'normal' | 'wobble' | 'streak';

export class BallView {
  readonly ball: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly trail: THREE.Line;
  private readonly trailGeo: THREE.BufferGeometry;
  private readonly trailMat: THREE.LineBasicMaterial;
  private readonly history: Array<{ p: Vec3; t: number }> = [];
  style: TrailStyle = 'normal';

  constructor(root: THREE.Object3D) {
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius * VISUAL_SCALE, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x444444, roughness: 0.35 })
    );
    root.add(this.ball);

    this.shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 24), this.shadowMat);
    root.add(this.shadow);

    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3)
    );
    this.trailMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
    });
    this.trail = new THREE.Line(this.trailGeo, this.trailMat);
    this.trail.frustumCulled = false;
    root.add(this.trail);
  }

  update(p: Vec3, t: number, visible: boolean): void {
    this.ball.visible = visible;
    this.shadow.visible = visible;
    this.trail.visible = visible;
    if (!visible) {
      this.history.length = 0;
      return;
    }
    this.ball.position.set(p.x, p.y, p.z);

    // 影子：在台面范围内投到台面上，否则投到地面
    const overTable =
      Math.abs(p.x) <= TABLE.halfWidth && Math.abs(p.y) <= TABLE.halfLength && p.z >= TABLE.height;
    const surface = overTable ? TABLE.height : 0;
    const h = Math.max(0, p.z - BALL.radius - surface);
    const r = BALL.radius * VISUAL_SCALE * (1 + 0.6 * h);
    this.shadow.position.set(p.x, p.y, surface + 0.0012);
    this.shadow.scale.setScalar(r);
    this.shadowMat.opacity = 0.55 * (1 - Math.min(h / 1.5, 0.8));

    // 拖尾（球被「瞬移」回发球手里时清空，避免画出一条横穿球场的线）
    const lastP = this.history[this.history.length - 1]?.p;
    if (lastP && Math.hypot(p.x - lastP.x, p.y - lastP.y, p.z - lastP.z) > 0.6)
      this.history.length = 0;
    this.history.push({ p: { ...p }, t });
    const keep = this.style === 'normal' ? 0.06 : this.style === 'streak' ? 0.12 : 0.25;
    while (this.history.length > 2 && t - this.history[0].t > keep) this.history.shift();
    while (this.history.length > TRAIL_POINTS) this.history.shift();
    const arr = this.trailGeo.getAttribute('position') as THREE.BufferAttribute;
    const n = this.history.length;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const e = this.history[Math.min(i, n - 1)];
      let wx = 0;
      let wz = 0;
      if (this.style === 'wobble') {
        const phase = (t - e.t) * 8 * Math.PI * 2;
        wx = Math.sin(phase) * 0.02;
        wz = Math.cos(phase) * 0.01;
      }
      arr.setXYZ(i, e.p.x + wx, e.p.y, e.p.z + wz);
    }
    arr.needsUpdate = true;
    this.trailGeo.setDrawRange(0, n);
    this.trailMat.opacity = this.style === 'normal' ? 0.25 : 0.6;
    this.trailMat.color.set(this.style === 'streak' ? 0xffd166 : 0xffffff);
  }
}
