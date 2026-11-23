/** 双色球拍（红 = 正手面，黑 = 反手面）：局部 Y = 红面法向，局部 −Z = 拍柄方向，原点在拍面中心 */
import * as THREE from 'three';

const BLADE_R = 0.078;

export function createPaddleMesh(): THREE.Group {
  const paddle = new THREE.Group();
  const red = new THREE.Mesh(
    new THREE.CylinderGeometry(BLADE_R, BLADE_R, 0.004, 32),
    new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.5 })
  );
  red.position.y = 0.003;
  const black = new THREE.Mesh(
    new THREE.CylinderGeometry(BLADE_R, BLADE_R, 0.004, 32),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 })
  );
  black.position.y = -0.003;
  const wood = new THREE.Mesh(
    new THREE.CylinderGeometry(BLADE_R + 0.002, BLADE_R + 0.002, 0.003, 32),
    new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.6 })
  );
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.028, 0.022, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.6 })
  );
  handle.position.z = -(BLADE_R + 0.045);
  paddle.add(red, black, wood, handle);
  paddle.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  return paddle;
}
