/**
 * 人物头像的渲染页（由 scripts/avatar-thumbs.ts 在浏览器里打开）：每个人物摆准备姿势，拍腰以上，透明背景。
 * 结果放在 window.__thumbs（id → PNG 的 data URL）。
 */
import * as THREE from 'three';
import { AvatarMotion } from '@/render/avatar/motion';
import { createAvatarBody, preloadAvatars, ROSTER } from '@/render/avatar/roster';
import { READY_PADDLE } from '@/render/paddlePose';

const SIZE = 256;
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1.5, 3, 2.5);
scene.add(sun);
// 仿真坐标（Z 向上）→ three.js（Y 向上）
const root = new THREE.Group();
root.rotation.x = -Math.PI / 2;
scene.add(root);

const out: Record<string, string> = {};
for (const entry of ROSTER) {
  await preloadAvatars({ near: entry.id, far: entry.id });
  const body = createAvatarBody(entry.id, false);
  root.add(body.group);
  // 近端（朝 +y）的准备姿势：拍子竖在胸前
  const motion = new AvatarMotion();
  const paddle = {
    pos: { x: READY_PADDLE.side, y: READY_PADDLE.fwd, z: READY_PADDLE.z },
    normal: { x: -0.2, y: 1, z: 0.05 },
    handle: { x: -0.25, y: -0.2, z: -1 },
  };
  for (let i = 0; i < 90; i++) body.apply(motion.update({ x: 0, y: 0 }, 1, 1, paddle, 1 / 60));
  root.updateMatrixWorld(true);
  body.group.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.update();
  });

  // 拍腰以上：从正前方略偏右、略高处看
  // 逐顶点算（蒙皮网格按现在的骨骼）
  const top = new THREE.Box3().setFromObject(body.group, true).max.y;
  const bottom = 0.85;
  const mid = (top + bottom) / 2;
  const cam = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
  const dist = (top - bottom) / 2 / Math.tan((12 * Math.PI) / 180) + 0.35;
  cam.position.set(0.35 * dist * 0.3, mid + 0.1, -dist);
  cam.lookAt(0, mid, 0);
  renderer.render(scene, cam);
  out[entry.id] = renderer.domElement.toDataURL('image/png');
  root.remove(body.group);
}
(window as unknown as { __thumbs: Record<string, string> }).__thumbs = out;
