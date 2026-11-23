import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { KenneyBody } from '@/render/avatar/KenneyBody';
import { AvatarMotion } from '@/render/avatar/motion';
import type { AvatarPose } from '@/render/avatar/types';
import { type PaddlePose, READY_PADDLE } from '@/render/paddlePose';

let scene: THREE.Object3D;

beforeAll(async () => {
  const buf = readFileSync('src/render/avatar/kenney/character.glb');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  scene = await new Promise<THREE.Object3D>((res, rej) =>
    new GLTFLoader().parse(ab, '', (g) => res(g.scene), rej)
  );
});

function bonePos(body: KenneyBody, name: string): THREE.Vector3 {
  let p: THREE.Vector3 | null = null;
  body.group.updateMatrixWorld(true);
  body.group.traverse((o) => {
    if (o.name === name && (o as THREE.Bone).isBone) p = o.getWorldPosition(new THREE.Vector3());
  });
  if (!p) throw new Error(`没有骨骼 ${name}`);
  return p;
}

/** 近端、右手，站在 (x, y)，拍子在准备位置，摆一会儿 */
function readyPose(body: KenneyBody, x = 0, y = -2): AvatarPose {
  const m = new AvatarMotion();
  const paddle: PaddlePose = {
    pos: { x: x + READY_PADDLE.side, y: y + READY_PADDLE.fwd, z: READY_PADDLE.z },
    normal: { x: -0.2, y: 1, z: 0.05 },
    handle: { x: -0.25, y: -0.2, z: -1 },
  };
  let pose = m.update({ x, y }, 1, 1, paddle, 1 / 60);
  for (let i = 0; i < 60; i++) {
    pose = m.update({ x, y }, 1, 1, paddle, 1 / 60);
    body.apply(pose);
  }
  return pose;
}

describe('带骨骼的人物（Kenney）按 AvatarPose 摆', () => {
  it('缩放到肩高 1.2 米，站直时朝 +y、右手在 +x', () => {
    const body = new KenneyBody({ scene, skins: {} }, 'skater-boy', false);
    const r = bonePos(body, 'RightArm');
    const l = bonePos(body, 'LeftArm');
    expect(r.z).toBeCloseTo(1.2, 2);
    expect(r.x).toBeGreaterThan(0.1);
    expect(l.x).toBeLessThan(-0.1);
    // 脚尖朝前
    expect(bonePos(body, 'LeftToes').y).toBeGreaterThan(bonePos(body, 'LeftFoot').y);
  });

  it('准备姿势：持拍手握在拍柄上、两只脚踝到脚该在的位置、头在肩上方', () => {
    const body = new KenneyBody({ scene, skins: {} }, 'skater-boy', false);
    const ankleRest = bonePos(body, 'LeftFoot').z;
    const pose = readyPose(body);
    const hand = bonePos(body, 'RightHand');
    const grip = new THREE.Vector3(pose.grip.x, pose.grip.y, pose.grip.z);
    expect(hand.distanceTo(grip)).toBeLessThan(0.08);
    pose.feet.forEach((f, i) => {
      const a = bonePos(body, i === 0 ? 'LeftFoot' : 'RightFoot');
      expect(Math.hypot(a.x - f.x, a.y - f.y)).toBeLessThan(0.01);
      expect(a.z).toBeCloseTo(ankleRest + f.z - 0.05, 2);
    });
    expect(bonePos(body, 'Head').z).toBeGreaterThan(bonePos(body, 'RightArm').z);
    // 膝盖往前弯
    const knee = bonePos(body, 'LeftLeg');
    const hip = bonePos(body, 'LeftUpLeg');
    const ankle = bonePos(body, 'LeftFoot');
    expect(knee.y).toBeGreaterThan((hip.y + ankle.y) / 2);
  });

  it('远端（朝 −y）也站得住：手握在拍柄上', () => {
    const body = new KenneyBody({ scene, skins: {} }, 'suit', false);
    const m = new AvatarMotion();
    const paddle: PaddlePose = {
      pos: { x: -READY_PADDLE.side, y: 2 - READY_PADDLE.fwd, z: READY_PADDLE.z },
      normal: { x: 0.2, y: -1, z: 0.05 },
      handle: { x: 0.25, y: 0.2, z: -1 },
    };
    let pose = m.update({ x: 0, y: 2 }, -1, -1, paddle, 1 / 60);
    for (let i = 0; i < 60; i++) {
      pose = m.update({ x: 0, y: 2 }, -1, -1, paddle, 1 / 60);
      body.apply(pose);
    }
    const hand = bonePos(body, 'RightHand');
    expect(hand.distanceTo(new THREE.Vector3(pose.grip.x, pose.grip.y, pose.grip.z))).toBeLessThan(
      0.08
    );
    expect(bonePos(body, 'RightArm').x).toBeLessThan(0);
  });

  it('半透明的自己：多一份只写深度的网格，持拍手另有一份不透明的', () => {
    const body = new KenneyBody({ scene, skins: {} }, 'skater-boy', true);
    readyPose(body);
    const meshes: THREE.SkinnedMesh[] = [];
    body.group.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
    });
    expect(meshes.map((m) => m.renderOrder).sort((a, b) => a - b)).toEqual([9, 10, 11]);
    const hand = meshes.find((m) => m.renderOrder === 11)!;
    const alpha = hand.geometry.getAttribute('color');
    let kept = 0;
    for (let i = 0; i < alpha.count; i++) if (alpha.getW(i) > 0.5) kept++;
    // 只留下手（一小部分顶点）
    expect(kept).toBeGreaterThan(20);
    expect(kept).toBeLessThan(alpha.count * 0.15);
  });
});
