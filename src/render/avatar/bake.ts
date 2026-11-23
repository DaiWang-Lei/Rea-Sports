/**
 * 把人物摆成观众的姿势（站着；平时两只拳头在腹前，欢呼时双手举起），烘焙成静态网格，供看台上成批画（实例化）。
 * 代码生成的 Q 版人物由很多块组成，合成一块、颜色写进顶点；带骨骼的模型按骨骼算出每个顶点的位置。不带球拍。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec3 } from '@/core/vec3';
import { GRIP_TO_CENTER } from '../paddlePose';
import { type AvatarBody, type AvatarPose, POSE_ANKLE_Z } from './types';

export interface BakedAvatar {
  /** 平时、欢呼两个姿势（面朝 +y，脚底在原点） */
  idle: THREE.BufferGeometry;
  cheer: THREE.BufferGeometry;
  material: THREE.Material;
}

const unit = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
};

/** 观众的姿势：面朝 +y、右手在 +x。欢呼时两只手举到头两侧、上身后仰、抬头 */
export function spectatorPose(cheer: boolean): AvatarPose {
  // 右手：拳头的位置（右手拿拍的那只手，这里没有球拍，拳头照样在那儿）
  const grip = cheer ? { x: 0.3, y: 0.08, z: 1.75 } : { x: 0.17, y: 0.25, z: 0.95 };
  // 球拍朝向：拍柄朝下、红面朝前（拳头的朝向跟着它）
  const quat = { x: 0, y: 0, z: 0, w: 1 };
  return {
    root: { x: 0, y: 0, z: 0 },
    facing: 1,
    paddleSide: 1,
    pelvis: { drop: 0, shift: 0, pitch: 0, roll: 0, yaw: 0 },
    spine: { pitch: cheer ? -0.12 : 0.05, roll: 0, yaw: 0 },
    head: { yaw: 0, pitch: cheer ? -0.25 : 0 },
    paddle: { pos: { ...grip, z: grip.z + GRIP_TO_CENTER }, quat },
    grip,
    elbowPole: cheer ? unit(0.7, 0.1, -0.3) : unit(0.15, 0.25, -1),
    // 左手（在胸的局部坐标里）：和右手对称
    freeHand: cheer
      ? { upper: unit(-0.35, 0.15, 1), fore: unit(0.05, 0.3, 1), reach: 0.8 }
      : { upper: unit(-0.05, 0.3, -1), fore: unit(0.55, 0.82, 0.17), reach: 0.57 },
    feet: [
      { x: -0.16, y: 0, z: POSE_ANKLE_Z },
      { x: 0.16, y: 0, z: POSE_ANKLE_Z },
    ],
    kneePoles: [unit(-0.25, 1, 0), unit(0.25, 1, 0)],
  };
}

/** 摆好姿势的人物 → 一块静态网格（和材质：带贴图的模型用贴图，代码人物用顶点颜色） */
function bakePose(
  body: AvatarBody,
  pose: AvatarPose
): { geo: THREE.BufferGeometry; map: THREE.Texture | null } {
  body.apply(pose);
  body.group.updateMatrixWorld(true);
  const toGroup = new THREE.Matrix4().copy(body.group.matrixWorld).invert();
  const parts: THREE.BufferGeometry[] = [];
  let map: THREE.Texture | null = null;
  const visit = (o: THREE.Object3D) => {
    if (o.name === 'paddle') return;
    if ((o as THREE.Mesh).isMesh) {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      // 只要看得见颜色的网格（跳过只写深度的副本）
      if (mat.colorWrite !== false) {
        const m = new THREE.Matrix4().multiplyMatrices(toGroup, mesh.matrixWorld);
        const g = (mesh as THREE.SkinnedMesh).isSkinnedMesh
          ? bakeSkinned(mesh as THREE.SkinnedMesh)
          : mesh.geometry.clone();
        g.applyMatrix4(m);
        if (mat.map) {
          map = mat.map;
          parts.push(keep(g, ['position', 'normal', 'uv']));
        } else {
          const n = g.getAttribute('position').count;
          const c = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) c.set([mat.color.r, mat.color.g, mat.color.b], i * 3);
          g.setAttribute('color', new THREE.BufferAttribute(c, 3));
          parts.push(keep(g, ['position', 'normal', 'color']));
        }
      }
    }
    o.children.forEach(visit);
  };
  visit(body.group);
  const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts.map((p) => p.toNonIndexed()));
  if (!geo) throw new Error('观众网格合并失败');
  return { geo, map };
}

/** 蒙皮网格按现在的骨骼算出每个顶点的位置（网格自己的坐标），法线重新算 */
function bakeSkinned(mesh: THREE.SkinnedMesh): THREE.BufferGeometry {
  const g = mesh.geometry.clone();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, v);
    out.set([v.x, v.y, v.z], i * 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.deleteAttribute('skinIndex');
  g.deleteAttribute('skinWeight');
  g.computeVertexNormals();
  return g;
}

/** 只留下这些顶点属性（合并要求每块的属性一样） */
function keep(g: THREE.BufferGeometry, names: string[]): THREE.BufferGeometry {
  for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
  return g;
}

export function bakeAvatar(body: AvatarBody): BakedAvatar {
  const idle = bakePose(body, spectatorPose(false));
  const cheer = bakePose(body, spectatorPose(true));
  const material = idle.map
    ? new THREE.MeshStandardMaterial({ map: idle.map, roughness: 0.8 })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  return { idle: idle.geo, cheer: cheer.geo, material };
}
