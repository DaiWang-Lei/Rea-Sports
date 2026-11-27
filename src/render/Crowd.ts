/**
 * 看台上的观众：我们自己的人物（见 avatar/roster.crowdKit），随机分到各个位置，站着、面朝球台。
 * 平时轻轻晃；回合越激动举手的人越多（跟观众声一起：第 8 拍起越来越激动，第 20 拍起屏息）；
 * 得分时大部分人举手跳起来。每种人物、每个姿势一组实例化网格，一次画完。
 */
import * as THREE from 'three';
import type { BakedAvatar } from './avatar/bake';

export interface Seat {
  x: number;
  y: number;
  z: number;
}

interface Spectator extends Seat {
  kit: number;
  /** 在这组实例里的序号 */
  slot: number;
  facing: number;
  phase: number;
  rate: number;
  /** 激动到多少（0..1）就举手 */
  eager: number;
  /** 得分欢呼时多大劲就跳起来 */
  fan: number;
  /** 看台只坐满一部分时，排在 fill 以内的才来（0..1） */
  rank: number;
}

/** 观众画小一点（看台远，看不出大小）：站在看台上头才不会被画面顶边切掉 */
const SCALE = 0.72;
/** 得分欢呼多久（秒） */
const CHEER_DUR = 2.6;
/** 不显示的实例（缩成一个点） */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class Crowd {
  private readonly people: Spectator[] = [];
  private readonly meshes: Array<{ idle: THREE.InstancedMesh; cheer: THREE.InstancedMesh }>;
  private excited = 0;
  private fill = 1;
  private hushed = false;
  private cheerT0 = -Infinity;
  private cheerStrength = 0;
  /** 上一声齐喊的时刻：举着手的人跟着一跳 */
  private chantT0 = -Infinity;
  private lastT = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly zAxis = new THREE.Vector3(0, 0, 1);

  constructor(root: THREE.Object3D, seats: Seat[], kit: BakedAvatar[]) {
    const counts = kit.map(() => 0);
    for (const seat of seats) {
      const k = Math.floor(Math.random() * kit.length);
      this.people.push({
        ...seat,
        kit: k,
        slot: counts[k]++,
        // 面朝球台中心
        facing: Math.atan2(-seat.y, -seat.x) - Math.PI / 2 + (Math.random() - 0.5) * 0.3,
        phase: Math.random() * Math.PI * 2,
        rate: 0.6 + Math.random() * 0.8,
        eager: 0.15 + Math.random() * 0.85,
        fan: Math.random(),
        rank: Math.random(),
      });
    }
    this.meshes = kit.map((b, i) => {
      const make = (g: THREE.BufferGeometry) => {
        const mesh = new THREE.InstancedMesh(g, b.material, Math.max(1, counts[i]));
        mesh.count = counts[i];
        mesh.frustumCulled = false;
        root.add(mesh);
        return mesh;
      };
      return { idle: make(b.idle), cheer: make(b.cheer) };
    });
    this.update(0);
  }

  /** 看台坐满多少（0..1）：和电脑对打时熟练度越高观众越多 */
  setFill(fill: number): void {
    this.fill = fill;
  }

  /** 回合里的激动程度（0..1）；hush = 长回合屏息（几乎不动） */
  mood(excited: number, hush = false): void {
    this.excited = excited;
    this.hushed = hush;
  }

  /** 跟着这一拍齐喊：举着手的人一起跳一下 */
  chant(): void {
    this.chantT0 = this.lastT;
  }

  /** 得分欢呼：strength 越大跳起来的人越多 */
  cheer(strength: number): void {
    this.cheerT0 = this.lastT;
    this.cheerStrength = strength;
  }

  update(t: number): void {
    this.lastT = t;
    const ct = t - this.cheerT0;
    const cheering = ct >= 0 && ct < CHEER_DUR;
    for (const s of this.people) {
      const pointCheer = cheering && s.fan < 0.35 + 0.6 * this.cheerStrength;
      const armsUp = pointCheer || s.eager < this.excited;
      const sway = this.hushed ? 0.004 : 0.015;
      let z = s.z + sway * Math.sin(t * s.rate * Math.PI * 2 + s.phase);
      // 欢呼时跳；越到后面跳得越低
      if (pointCheer)
        z += 0.12 * (1 - ct / CHEER_DUR) * Math.abs(Math.sin(ct * Math.PI * 2.2 + s.phase));
      else if (armsUp) {
        // 跟着齐喊一跳（每人起跳早晚差一点），喊声间隙里轻轻晃
        const since = t - this.chantT0 - 0.04 * s.fan;
        z +=
          since >= 0 && since < 0.35
            ? 0.06 * Math.sin((Math.PI * since) / 0.35)
            : 0.02 * Math.abs(Math.sin(t * Math.PI * 2 * 1.4 + s.phase));
      }
      this.q.setFromAxisAngle(this.zAxis, s.facing);
      this.m.compose(this.p.set(s.x, s.y, z), this.q, this.s.setScalar(SCALE));
      const g = this.meshes[s.kit];
      const here = s.rank <= this.fill;
      g.idle.setMatrixAt(s.slot, here && !armsUp ? this.m : HIDDEN);
      g.cheer.setMatrixAt(s.slot, here && armsUp ? this.m : HIDDEN);
    }
    for (const g of this.meshes) {
      g.idle.instanceMatrix.needsUpdate = true;
      g.cheer.instanceMatrix.needsUpdate = true;
    }
  }
}
