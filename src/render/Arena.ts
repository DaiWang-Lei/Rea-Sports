/** 场地：地面、球台（含白线、台腿）、球网、四周挡板、灯光。所有坐标用仿真坐标（Z 向上），挂在 root 下。 */
import * as THREE from 'three';
import { NET, TABLE } from '@/sim/constants';

export const COLORS = {
  floor: 0x2b3440,
  floorLine: 0x3a4655,
  table: 0x1f5fa8,
  tableSide: 0x173f6d,
  line: 0xf4f7fb,
  leg: 0x2a2f36,
  net: 0xf4f7fb,
  barrier: 0x1c2b3f,
  barrierText: 0x2f4a6b,
};

export function buildArena(root: THREE.Object3D): void {
  // 地面
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({ color: COLORS.floor, roughness: 0.95 })
  );
  root.add(floor);
  // 场地标线（给一点空间参照）
  const court = new THREE.Mesh(
    new THREE.RingGeometry(3.9, 3.95, 4, 1),
    new THREE.MeshBasicMaterial({ color: COLORS.floorLine })
  );
  court.rotation.z = Math.PI / 4;
  court.scale.set(1.15, 1.9, 1);
  court.position.z = 0.002;
  root.add(court);

  // 台面
  const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.width, TABLE.length, TABLE.thickness), [
    new THREE.MeshStandardMaterial({ color: COLORS.tableSide, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: COLORS.tableSide, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: COLORS.tableSide, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: COLORS.tableSide, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: COLORS.table, roughness: 0.55 }),
    new THREE.MeshStandardMaterial({ color: COLORS.tableSide, roughness: 0.6 }),
  ]);
  top.position.z = TABLE.height - TABLE.thickness / 2;
  root.add(top);

  // 白线：两条边线、两条端线、中线
  const lineMat = new THREE.MeshBasicMaterial({ color: COLORS.line });
  const z = TABLE.height + 0.0006;
  const addLine = (w: number, l: number, x: number, y: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
    m.position.set(x, y, z);
    root.add(m);
  };
  addLine(0.02, TABLE.length, TABLE.halfWidth - 0.01, 0);
  addLine(0.02, TABLE.length, -TABLE.halfWidth + 0.01, 0);
  addLine(TABLE.width, 0.02, 0, TABLE.halfLength - 0.01);
  addLine(TABLE.width, 0.02, 0, -TABLE.halfLength + 0.01);
  addLine(0.006, TABLE.length, 0, 0);

  // 台腿
  const legMat = new THREE.MeshStandardMaterial({ color: COLORS.leg, roughness: 0.7 });
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, TABLE.height - TABLE.thickness),
        legMat
      );
      leg.position.set(
        sx * (TABLE.halfWidth - 0.12),
        sy * (TABLE.halfLength - 0.25),
        (TABLE.height - TABLE.thickness) / 2
      );
      root.add(leg);
    }
  }

  // 球网：半透明网面 + 白色网带 + 网柱
  const netMat = new THREE.MeshStandardMaterial({
    color: COLORS.net,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  const net = new THREE.Mesh(new THREE.PlaneGeometry(NET.halfSpan * 2, NET.height), netMat);
  net.rotation.x = Math.PI / 2;
  net.position.set(0, 0, TABLE.height + NET.height / 2);
  root.add(net);
  const cord = new THREE.Mesh(
    new THREE.BoxGeometry(NET.halfSpan * 2, 0.008, 0.014),
    new THREE.MeshStandardMaterial({ color: COLORS.net, roughness: 0.5 })
  );
  cord.position.set(0, 0, NET.top - 0.007);
  root.add(cord);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, NET.height + 0.03, 12),
      legMat
    );
    post.rotation.x = Math.PI / 2;
    post.position.set(sx * NET.halfSpan, 0, TABLE.height + (NET.height + 0.03) / 2);
    root.add(post);
  }

  // 四周挡板（提供远近参照）
  const barrierMat = new THREE.MeshStandardMaterial({ color: COLORS.barrier, roughness: 0.8 });
  const addBarrier = (w: number, x: number, y: number, rotZ: number) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, 0.7), barrierMat);
    b.position.set(x, y, 0.35);
    b.rotation.z = rotZ;
    root.add(b);
  };
  addBarrier(8, 0, 6.5, 0);
  addBarrier(11, -4.2, 1.0, Math.PI / 2);
  addBarrier(11, 4.2, 1.0, Math.PI / 2);

  // 灯光
  root.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a2f36, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1.5, -2.5, 6);
  root.add(key);
  const fill = new THREE.DirectionalLight(0x9fc3ff, 0.5);
  fill.position.set(-3, 4, 4);
  root.add(fill);
}
