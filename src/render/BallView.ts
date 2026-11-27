/**
 * 球、投在台面/地面上的影子（判断远近的关键）、拖尾（高球摇晃 / 扣杀拖影）。
 * 拖尾是一段由粗到细、由浓到淡的管子：每个历史位置一圈顶点，顶点带透明度。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { BALL, TABLE } from '@/sim/constants';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const VISUAL_SCALE = 1.25;
const TRAIL_POINTS = 16;
/** 拖尾每一圈的顶点数 */
const RADIAL = 6;
const TRAIL_STYLE = {
  normal: { keep: 0.1, color: 0xffffff, alpha: 0.45, width: 0.8 },
  streak: { keep: 0.16, color: 0xffd166, alpha: 0.85, width: 1 },
  wobble: { keep: 0.25, color: 0xffffff, alpha: 0.6, width: 0.8 },
} as const;

export type TrailStyle = 'normal' | 'wobble' | 'streak';

/** 球的旋转（弧度/秒）：top = 相对飞行方向的上旋分量（负 = 下旋），side = 侧旋（绕竖直轴） */
export interface BallSpin {
  top: number;
  side: number;
}

/** 从球的速度和角速度算旋转：上旋的转轴是水平的、垂直于飞行方向（ẑ × 飞行方向） */
export function ballSpin(v: Vec3, w: Vec3): BallSpin {
  const d = Math.hypot(v.x, v.y);
  if (d < 1e-6) return { top: 0, side: w.z };
  return { top: (-w.x * v.y + w.y * v.x) / d, side: w.z };
}

/** 普通拖尾按旋转上色：上旋橙红、下旋蓝、侧旋（比上 / 下旋还强时）绿；旋转越强颜色越浓 */
const SPIN_COLOR = { top: 0xff7a3d, back: 0x4da3ff, side: 0x6ee07a };
/** 旋转多强（弧度/秒）开始上色、多强时颜色最浓：普通回球 40–110，拉球 150–260，搓球 −110 ~ −200 */
const SPIN_TINT = { from: 50, full: 200 };

export class BallView {
  readonly ball: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly shadowMat: THREE.MeshBasicMaterial;
  private readonly trail: THREE.Mesh;
  private readonly trailGeo: THREE.BufferGeometry;
  private readonly history: Array<{ p: Vec3; t: number }> = [];
  style: TrailStyle = 'normal';
  spin: BallSpin = { top: 0, side: 0 };

  constructor(root: THREE.Object3D) {
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius * VISUAL_SCALE, 24, 16),
      // 太阳在远端身后，看到的多是球的背光面：自发光调高，保持白亮
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x9a9a9a, roughness: 0.35 })
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
    const verts = TRAIL_POINTS * RADIAL;
    this.trailGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(verts * 3), 3)
    );
    this.trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 4), 4));
    const index: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = i * RADIAL + j;
        const b = i * RADIAL + ((j + 1) % RADIAL);
        index.push(a, a + RADIAL, b, b, a + RADIAL, b + RADIAL);
      }
    }
    this.trailGeo.setIndex(index);
    this.trail = new THREE.Mesh(
      this.trailGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.trail.frustumCulled = false;
    root.add(this.trail);
  }

  /** 清掉拖尾（回放开始、结束时：时间跳了） */
  clearTrail(): void {
    this.history.length = 0;
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
    const st = TRAIL_STYLE[this.style];
    while (this.history.length > 2 && t - this.history[0].t > st.keep) this.history.shift();
    while (this.history.length > TRAIL_POINTS) this.history.shift();
    this.buildTrail(t, st);
  }

  /** 每个历史位置一圈顶点：越旧越细、越淡（最新一圈和球一样粗，藏在球里） */
  private buildTrail(t: number, st: (typeof TRAIL_STYLE)[TrailStyle]): void {
    const pos = this.trailGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.trailGeo.getAttribute('color') as THREE.BufferAttribute;
    const n = this.history.length;
    const c = new THREE.Color(st.color);
    let alpha = st.alpha;
    if (this.style === 'normal') {
      const side = Math.abs(this.spin.side) > Math.abs(this.spin.top);
      const amount = side ? Math.abs(this.spin.side) : Math.abs(this.spin.top);
      const k = Math.min(
        1,
        Math.max(0, (amount - SPIN_TINT.from) / (SPIN_TINT.full - SPIN_TINT.from))
      );
      const tint = side ? SPIN_COLOR.side : this.spin.top > 0 ? SPIN_COLOR.top : SPIN_COLOR.back;
      c.lerp(new THREE.Color(tint), k);
      alpha += 0.35 * k;
    }
    const pts = this.history.map((e) => {
      if (this.style !== 'wobble') return new THREE.Vector3(e.p.x, e.p.y, e.p.z);
      const phase = (t - e.t) * 8 * Math.PI * 2;
      return new THREE.Vector3(
        e.p.x + Math.sin(phase) * 0.02,
        e.p.y,
        e.p.z + Math.cos(phase) * 0.01
      );
    });
    const tan = new THREE.Vector3();
    const u = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      tan.subVectors(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]);
      if (tan.lengthSq() < 1e-10) tan.set(0, 1, 0);
      tan.normalize();
      u.crossVectors(tan, Math.abs(tan.z) < 0.9 ? Z_AXIS : X_AXIS).normalize();
      v.crossVectors(tan, u);
      const f = (i + 1) / n;
      const r = BALL.radius * VISUAL_SCALE * st.width * f;
      for (let j = 0; j < RADIAL; j++) {
        const a = (j / RADIAL) * Math.PI * 2;
        const k = i * RADIAL + j;
        pos.setXYZ(
          k,
          pts[i].x + r * (Math.cos(a) * u.x + Math.sin(a) * v.x),
          pts[i].y + r * (Math.cos(a) * u.y + Math.sin(a) * v.y),
          pts[i].z + r * (Math.cos(a) * u.z + Math.sin(a) * v.z)
        );
        col.setXYZW(k, c.r, c.g, c.b, alpha * f * f);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.trailGeo.setDrawRange(0, Math.max(0, n - 1) * RADIAL * 6);
  }
}
