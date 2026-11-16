/**
 * 球台（台面、白线、台面下的框、两组台腿）和球网（深色网格 + 白色网带 + 网柱）。
 * 所有坐标用仿真坐标（Z 向上），挂在 root 下。场景和灯光见 Scenery。
 */
import * as THREE from 'three';
import { NET, TABLE } from '@/sim/constants';

export const COLORS = {
  table: 0x1d63b8,
  tableEdge: 0x174f93,
  line: 0xf4f7fb,
  frame: 0x2b3138,
  net: 0x1b2a44,
  netBand: 0xf4f7fb,
};

/** 网面：深色网格，格子之间透明 */
function netTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#1b2a44';
  g.lineWidth = 2;
  for (let x = 0; x <= 256; x += 8) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 32);
    g.stroke();
  }
  for (let y = 0; y <= 32; y += 8) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(4, 1);
  return t;
}

function shadowed<T extends THREE.Object3D>(o: T, receive = false): T {
  o.castShadow = true;
  o.receiveShadow = receive;
  return o;
}

export function buildArena(root: THREE.Object3D): void {
  // 台面：顶面蓝色，四周侧边深一点
  const edgeMat = new THREE.MeshStandardMaterial({ color: COLORS.tableEdge, roughness: 0.5 });
  const topMat = new THREE.MeshStandardMaterial({ color: COLORS.table, roughness: 0.45 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.width, TABLE.length, TABLE.thickness), [
    edgeMat,
    edgeMat,
    edgeMat,
    edgeMat,
    topMat,
    edgeMat,
  ]);
  top.position.z = TABLE.height - TABLE.thickness / 2;
  root.add(shadowed(top, true));

  // 白线：两条边线、两条端线、中线（受光照，落在影子里会变暗）
  const lineMat = new THREE.MeshStandardMaterial({ color: COLORS.line, roughness: 0.5 });
  const z = TABLE.height + 0.0006;
  const addLine = (w: number, l: number, x: number, y: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    root.add(m);
  };
  addLine(0.02, TABLE.length, TABLE.halfWidth - 0.01, 0);
  addLine(0.02, TABLE.length, -TABLE.halfWidth + 0.01, 0);
  addLine(TABLE.width, 0.02, 0, TABLE.halfLength - 0.01);
  addLine(TABLE.width, 0.02, 0, -TABLE.halfLength + 0.01);
  addLine(0.006, TABLE.length, 0, 0);

  // 台面下的框（让台子看起来有厚度）
  const frameMat = new THREE.MeshStandardMaterial({
    color: COLORS.frame,
    roughness: 0.5,
    metalness: 0.3,
  });
  const apronH = 0.06;
  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE.width - 0.12, TABLE.length - 0.12, apronH),
    frameMat
  );
  apron.position.z = TABLE.height - TABLE.thickness - apronH / 2;
  root.add(shadowed(apron));

  // 两组台腿（每半张台一组）：两条腿 + 底部横杆，中间一根纵梁
  const legH = TABLE.height - TABLE.thickness - apronH;
  for (const sy of [-1, 1]) {
    const y = sy * (TABLE.halfLength - 0.4);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, legH), frameMat);
      leg.position.set(sx * (TABLE.halfWidth - 0.16), y, legH / 2);
      root.add(shadowed(leg));
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(TABLE.width - 0.32, 0.05, 0.05), frameMat);
    bar.position.set(0, y, 0.12);
    root.add(shadowed(bar));
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.06, TABLE.length - 0.8, 0.06), frameMat);
  beam.position.z = 0.12;
  root.add(shadowed(beam));

  // 球网：深色网格 + 白色网带 + 网柱
  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(NET.halfSpan * 2, NET.height),
    new THREE.MeshStandardMaterial({
      map: netTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      roughness: 0.9,
      depthWrite: false,
    })
  );
  net.rotation.x = Math.PI / 2;
  net.position.set(0, 0, TABLE.height + NET.height / 2);
  root.add(net);
  const band = new THREE.Mesh(
    new THREE.BoxGeometry(NET.halfSpan * 2, 0.008, 0.016),
    new THREE.MeshStandardMaterial({ color: COLORS.netBand, roughness: 0.5 })
  );
  band.position.set(0, 0, NET.top - 0.008);
  root.add(shadowed(band));
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, NET.height + 0.03, 12),
      frameMat
    );
    post.rotation.x = Math.PI / 2;
    post.position.set(sx * NET.halfSpan, 0, TABLE.height + (NET.height + 0.03) / 2);
    root.add(shadowed(post));
    // 网夹：从台边夹到网柱
    const clampW = NET.halfSpan - TABLE.halfWidth + 0.04;
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(clampW, 0.04, 0.045), frameMat);
    clamp.position.set(sx * (NET.halfSpan - clampW / 2 + 0.01), 0, TABLE.height - 0.006);
    root.add(shadowed(clamp));
  }
}
