import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { bakeAvatar } from '@/render/avatar/bake';
import { KenneyBody } from '@/render/avatar/KenneyBody';
import { ProceduralBody } from '@/render/avatar/ProceduralBody';

const box = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!;
};
/** 高于 z 的顶点有多少 */
const above = (g: THREE.BufferGeometry, z: number) => {
  const p = g.getAttribute('position');
  let n = 0;
  for (let i = 0; i < p.count; i++) if (p.getZ(i) > z) n++;
  return n;
};

describe('观众：把人物烘焙成站着 / 举手两个姿势的静态网格', () => {
  it('Q 版人物：合成一块、颜色在顶点里，没有球拍；举手时拳头举过头顶', () => {
    const baked = bakeAvatar(
      new ProceduralBody(
        { shirt: 0x2f80ed, shorts: 0x1f2a3c, skin: 0xf1c9a5, hair: 0x3a2a1f, hairStyle: 'short' },
        false
      )
    );
    expect(baked.idle.getAttribute('color')).toBeDefined();
    expect(box(baked.idle).min.z).toBeGreaterThan(-0.1);
    expect(box(baked.idle).max.z).toBeCloseTo(1.69, 1);
    expect(box(baked.cheer).max.z).toBeGreaterThan(box(baked.idle).max.z + 0.05);
    // 球拍的红面不在里面
    const c = baked.idle.getAttribute('color');
    const red = new THREE.Color(0xd62828);
    for (let i = 0; i < c.count; i++)
      expect(Math.abs(c.getX(i) - red.r) + Math.abs(c.getY(i) - red.g) > 1e-3).toBe(true);
  });

  it('Kenney 人物：按骨骼算好的顶点，举手时肩以上的顶点多了', async () => {
    const buf = readFileSync('src/render/avatar/kenney/character.glb');
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const scene = await new Promise<THREE.Object3D>((res, rej) =>
      new GLTFLoader().parse(ab, '', (g) => res(g.scene), rej)
    );
    const baked = bakeAvatar(new KenneyBody({ scene, skins: {} }, 'suit', false));
    expect(box(baked.idle).max.z).toBeGreaterThan(1.8);
    expect(box(baked.idle).min.z).toBeGreaterThan(-0.05);
    expect(above(baked.cheer, 1.3)).toBeGreaterThan(above(baked.idle, 1.3) * 1.2);
  });
});
