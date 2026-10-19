/**
 * 渲染器：把仿真状态画出来。仿真坐标（Z 向上）的东西都挂在 root 下，root 统一转到 three.js 坐标（Y 向上）。
 * 相机在近端身后偏上（WSR 的视角），能看到整张球台。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { sideDir, type Side, TABLE } from '@/sim/constants';
import { forehandSign, type PlayerSim } from '@/sim/players/PlayerSim';
import { buildArena } from './Arena';
import { AvatarView } from './AvatarView';
import { BallView, type TrailStyle } from './BallView';
import type { PaddlePose } from './paddlePose';

/** 相机：近端身后偏上，俯视整张球台（WSR 视角）。调试面板可改。 */
export const CAMERA = { y: -4.1, z: 2.75, lookY: 0.3, lookZ: -0.05, fov: 40 };

export const SIM_TO_THREE = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2
);

/** 仿真坐标 → three.js 坐标 */
function toThree(p: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p.x, p.z, -p.y);
}

export interface RenderPlayer {
  player: PlayerSim;
  /** 插值后的脚下位置 */
  body: { x: number; y: number };
  paddle: PaddlePose;
}

export interface RenderFrame {
  t: number;
  ball: Vec3;
  ballVisible: boolean;
  trail: TrailStyle;
  players: Record<Side, RenderPlayer>;
  /** 震屏：剩余强度（米） */
  shake: number;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.05, 60);
  readonly root = new THREE.Group();
  readonly ballView: BallView;
  readonly avatars: Record<Side, AvatarView>;
  private camX = 0;
  private lastT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene.background = new THREE.Color(0x121821);
    this.scene.fog = new THREE.Fog(0x121821, 9, 22);
    this.root.quaternion.copy(SIM_TO_THREE);
    this.scene.add(this.root);
    buildArena(this.root);
    this.ballView = new BallView(this.root);
    this.avatars = {
      near: new AvatarView(this.root, 0x2f80ed, true),
      far: new AvatarView(this.root, 0xe2583e, false),
    };
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(frame: RenderFrame): void {
    const dt = Math.min(0.1, Math.max(0, frame.t - this.lastT));
    this.lastT = frame.t;

    this.ballView.style = frame.trail;
    this.ballView.update(frame.ball, frame.t, frame.ballVisible);

    for (const side of ['near', 'far'] as const) {
      const rp = frame.players[side];
      this.avatars[side].update(rp.body, sideDir(side), forehandSign(rp.player), rp.paddle);
    }
    // 球靠近自己时，自己再透明一些
    const near = frame.players.near.body;
    const dNear = Math.hypot(frame.ball.x - near.x, frame.ball.y - near.y);
    this.avatars.near.setFade(
      frame.ballVisible ? Math.max(0, Math.min(1, 1 - (dNear - 0.3) / 0.8)) * 0.4 : 0
    );

    // 相机：跟随近端球员的横向位置（平滑）
    const k = 1 - Math.exp(-dt / 0.3);
    this.camX += (0.25 * near.x - this.camX) * k;
    const shakeX = frame.shake > 0 ? (Math.random() - 0.5) * frame.shake : 0;
    const shakeZ = frame.shake > 0 ? (Math.random() - 0.5) * frame.shake : 0;
    const c = CAMERA;
    toThree({ x: this.camX + shakeX, y: c.y, z: c.z + shakeZ }, this.camera.position);
    this.camera.lookAt(toThree({ x: 0.4 * this.camX, y: c.lookY, z: TABLE.height + c.lookZ }));

    this.renderer.render(this.scene, this.camera);
  }
}
