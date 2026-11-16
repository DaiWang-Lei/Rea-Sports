/**
 * 渲染器：把仿真状态画出来。仿真坐标（Z 向上）的东西都挂在 root 下，root 统一转到 three.js 坐标（Y 向上）。
 * 相机在近端身后偏上（WSR 的视角），能看到整张球台。晴天户外，太阳投柔和的实时阴影。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { sideDir, type Side, TABLE } from '@/sim/constants';
import { forehandSign, type PlayerSim } from '@/sim/players/PlayerSim';
import { buildArena } from './Arena';
import { type AvatarLook, AvatarView } from './AvatarView';
import { BallMachineView } from './BallMachineView';
import { BallView, type TrailStyle } from './BallView';
import { Effects } from './Effects';
import type { PaddlePose } from './paddlePose';
import { buildScenery, type Scenery, SKY } from './Scenery';

/** 相机：近端身后偏上，俯视整张球台（WSR 视角）。调试面板可改。 */
export const CAMERA = { y: -4.1, z: 2.75, lookY: 0.3, lookZ: -0.05, fov: 40 };

const LOOKS: Record<Side, AvatarLook> = {
  near: { shirt: 0x2f80ed, shorts: 0x1f2a3c, skin: 0xf1c9a5, hair: 0x3a2a1f, hairStyle: 'short' },
  far: { shirt: 0xe2583e, shorts: 0x2b2d38, skin: 0xe0ac7e, hair: 0x2b1d14, hairStyle: 'bun' },
};

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
  /** 远端没有人（发球机练习）时可以不给 far */
  players: { near: RenderPlayer; far?: RenderPlayer };
  /** 发球机出球口位置；给了就画发球机、不画远端人物 */
  machine?: Vec3;
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
  readonly machine: BallMachineView;
  private readonly scenery: Scenery;
  private readonly effects: Effects;
  private camX = 0;
  private lastT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 25, 60);
    this.root.quaternion.copy(SIM_TO_THREE);
    this.scene.add(this.root);
    this.scenery = buildScenery(this.root, this.renderer.capabilities.getMaxAnisotropy());
    buildArena(this.root);
    this.ballView = new BallView(this.root);
    this.avatars = {
      near: new AvatarView(this.root, LOOKS.near, true),
      far: new AvatarView(this.root, LOOKS.far, false),
    };
    this.machine = new BallMachineView(this.root);
    this.effects = new Effects(this.root);
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

  /** 击球特效（p = 击球点；strong = 扣杀 / 强力发球） */
  hitEffect(p: Vec3, strong: boolean): void {
    this.effects.hit(p, strong, this.lastT);
  }

  /** 落台特效 */
  bounceEffect(p: Vec3): void {
    this.effects.bounce(p, this.lastT);
  }

  render(frame: RenderFrame): void {
    const dt = Math.min(0.1, Math.max(0, frame.t - this.lastT));
    this.lastT = frame.t;

    this.ballView.style = frame.trail;
    this.ballView.update(frame.ball, frame.t, frame.ballVisible);

    for (const side of ['near', 'far'] as const) {
      const rp = frame.players[side];
      this.avatars[side].group.visible = !!rp;
      if (rp) this.avatars[side].update(rp.body, sideDir(side), forehandSign(rp.player), rp.paddle);
    }
    this.machine.update(frame.machine ?? null);
    this.scenery.update(frame.t);
    this.effects.update(frame.t);
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
