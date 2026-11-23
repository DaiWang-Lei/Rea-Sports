/**
 * 球台以外的场景：晴天户外的草地球场、环形步道、围挡、看台和观众、阳光（带阴影）。
 * 坐标同 Arena（仿真坐标，Z 向上），挂在 root 下。
 * 镜头往下俯视，画面顶边的视线约 32 米外就落到地面，所以看不到天空：画面顶部露出的是围挡和前两排观众。
 */
import * as THREE from 'three';
import type { Seat } from './Crowd';

export const SKY = 0xbfe3ff;

/** 围挡半径（米）：远端球员身后约 3.5 米 */
const WALL_R = 6;
const WALL_H = 0.85;
/**
 * 看台各排：内外半径、高度。观众站着，台阶不高：画面顶边在远端看台处只露得出离地 1.6～1.8 米以下的东西，
 * 台阶高了后排的头就被切掉
 */
const TIERS = [
  { rIn: 7.0, rOut: 7.8, h: 0.1 },
  { rIn: 7.8, rOut: 8.6, h: 0.25 },
  { rIn: 8.6, rOut: 9.4, h: 0.4 },
];
/** 看台覆盖的角度（从 +x 逆时针）：远端一侧加上左右两边 */
const STAND_A0 = (-25 * Math.PI) / 180;
const STAND_A1 = (205 * Math.PI) / 180;

export interface Scenery {
  /** 看台上观众站的位置 */
  seats: Seat[];
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 草地：一深一浅两条割草条纹，加细碎的草纹 */
function grassTexture(anisotropy: number): THREE.Texture {
  const t = canvasTexture(256, 256, (g) => {
    g.fillStyle = '#72c04c';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#63b042';
    g.fillRect(0, 128, 256, 128);
    for (let i = 0; i < 5000; i++) {
      const l = Math.random() < 0.5;
      g.fillStyle = l ? 'rgba(170, 220, 120, 0.25)' : 'rgba(40, 90, 30, 0.2)';
      g.fillRect(Math.random() * 256, Math.random() * 256, 1, 2);
    }
  });
  t.anisotropy = anisotropy;
  return t;
}

/** 围挡上的广告板：蓝底白字，一块一个名字 */
function bannerTexture(): THREE.Texture {
  return canvasTexture(512, 64, (g) => {
    g.fillStyle = '#1f6fd1';
    g.fillRect(0, 0, 512, 64);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 512, 5);
    g.fillRect(0, 59, 512, 5);
    g.fillRect(0, 5, 3, 54);
    g.font = 'bold 36px -apple-system, "PingFang SC", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('REA SPORTS', 256, 33);
  });
}

/** 环形扇区，往上挤出 h（看台一排） */
function ringSector(rIn: number, rOut: number, a0: number, a1: number, h: number) {
  const s = new THREE.Shape();
  s.moveTo(rOut * Math.cos(a0), rOut * Math.sin(a0));
  s.absarc(0, 0, rOut, a0, a1, false);
  s.lineTo(rIn * Math.cos(a1), rIn * Math.sin(a1));
  s.absarc(0, 0, rIn, a1, a0, true);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 64 });
}

export function buildScenery(root: THREE.Object3D, anisotropy: number): Scenery {
  // 草地
  const grass = grassTexture(anisotropy);
  // 条纹每条约 1.6 米宽（贴图一个周期 = 一深一浅）
  grass.repeat.set(100 / 3.2, 100 / 3.2);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(50, 96),
    new THREE.MeshStandardMaterial({ map: grass, roughness: 1 })
  );
  ground.receiveShadow = true;
  root.add(ground);

  // 环形步道（围挡内侧）
  const path = new THREE.Mesh(
    new THREE.RingGeometry(WALL_R - 0.7, WALL_R, 128),
    new THREE.MeshStandardMaterial({ color: 0xe8cfa2, roughness: 0.95 })
  );
  path.position.z = 0.004;
  path.receiveShadow = true;
  root.add(path);
  const edge = new THREE.Mesh(
    new THREE.RingGeometry(WALL_R - 0.76, WALL_R - 0.7, 128),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 })
  );
  edge.position.z = 0.005;
  root.add(edge);

  // 围挡：内侧是自发光的广告板（太阳在远端身后，围挡内侧背光）；从里面看，贴图左右镜像回来
  const banner = bannerTexture();
  banner.repeat.set(-16, 1);
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(WALL_R, WALL_R, WALL_H, 128, 1, true),
    new THREE.MeshStandardMaterial({
      map: banner,
      emissiveMap: banner,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      side: THREE.BackSide,
      roughness: 0.7,
    })
  );
  wall.rotation.x = Math.PI / 2;
  wall.position.z = WALL_H / 2;
  root.add(wall);
  const cap = new THREE.Mesh(
    new THREE.RingGeometry(WALL_R, WALL_R + 0.18, 128),
    new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.8 })
  );
  cap.position.z = WALL_H;
  root.add(cap);

  // 看台
  const tierMats = [0xe9e4da, 0xd8d1c4].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })
  );
  TIERS.forEach((tr, i) => {
    root.add(
      new THREE.Mesh(ringSector(tr.rIn, tr.rOut, STAND_A0, STAND_A1, tr.h), tierMats[i % 2])
    );
  });
  const last = TIERS[TIERS.length - 1];
  root.add(
    new THREE.Mesh(
      ringSector(last.rOut, last.rOut + 0.25, STAND_A0, STAND_A1, last.h + 1.4),
      tierMats[1]
    )
  );

  // 观众的位置：每排靠前站一排，约 0.6 米一个，三成多空位（人物见 Crowd）
  const seats: Seat[] = [];
  for (const tr of TIERS) {
    const r = tr.rIn + 0.3;
    const step = 0.6 / r;
    for (let a = STAND_A0 + step / 2; a < STAND_A1; a += step) {
      if (Math.random() < 0.35) continue;
      const jitter = (Math.random() - 0.5) * 0.15;
      seats.push({ x: (r + jitter) * Math.cos(a), y: (r + jitter) * Math.sin(a), z: tr.h });
    }
  }

  // 光：天光（地面反射草绿）+ 左后方的太阳（影子落向画面右下）+ 镜头方向的补光（不投影，
  // 照亮背光的远端人物的脸和看台）
  root.add(new THREE.HemisphereLight(0xd6ecff, 0x6f9a4a, 1.1));
  const fill = new THREE.DirectionalLight(0xfff6e8, 0.9);
  fill.position.set(1, -6, 4);
  root.add(fill);
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
  sun.position.set(-4, 6, 9);
  sun.target.position.set(0, 0, 0.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -6;
  sc.right = 6;
  sc.top = 6;
  sc.bottom = -6;
  sc.near = 1;
  sc.far = 30;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  root.add(sun, sun.target);

  return { seats };
}
