/**
 * 渲染器：把仿真状态画出来。仿真坐标（Z 向上）的东西都挂在 root 下，root 统一转到 three.js 坐标（Y 向上）。
 * 相机在近端身后偏上（WSR 的视角），能看到整张球台。晴天户外，太阳投柔和的实时阴影。
 * 双人分屏：左半屏从近端的人身后看，右半屏从远端的人身后看，每人在自己的半屏里是半透明的。
 */
import * as THREE from 'three';
import type { Vec3 } from '@/core/vec3';
import { sideDir, type Side, TABLE } from '@/sim/constants';
import { forehandSign, type PlayerSim } from '@/sim/players/PlayerSim';
import { buildArena } from './Arena';
import { avatarsInUse, createAvatarBody, crowdKit } from './avatar/roster';
import { AvatarView } from './AvatarView';
import { BallMachineView } from './BallMachineView';
import { type BallSpin, BallView, type TrailStyle } from './BallView';
import { Crowd } from './Crowd';
import { Effects, type ServeCue } from './Effects';
import type { PaddlePose } from './paddlePose';
import { buildScenery, SKY } from './Scenery';

/** 相机：近端身后偏上，俯视整张球台（WSR 视角）。调试面板可改。 */
export const CAMERA = { y: -4.1, z: 2.75, lookY: 0.3, lookZ: -0.05, fov: 40 };
/**
 * 分屏时每半屏的相机（远端的镜像过去）：半屏接近方形，左右窄，视野放大、镜头往后往上才放得下整张球台和对面的人；
 * follow = 横向跟着自己走的比例：跑出边线约 0.5 米接球时，球拍离画面边上还有约 5°
 */
export const SPLIT_CAMERA = { y: -4.4, z: 3.0, lookY: 0.2, lookZ: -0.1, fov: 55, follow: 0.7 };
/** 分屏时只在一边半屏里画的东西所在的层 */
const VIEW_LAYER: Record<Side, number> = { near: 1, far: 2 };

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
  /** 球的旋转（拖尾按它上色） */
  spin: BallSpin;
  /** 远端没有人（发球机练习）时可以不给 far */
  players: { near: RenderPlayer; far?: RenderPlayer };
  /** 发球机出球口位置；给了就画发球机、不画远端人物 */
  machine?: Vec3;
  /** 多球训练时回出去、还在飞的球 */
  extraBalls?: Vec3[];
  /** 人发球时的最佳击球点提示：圈的位置、理想击球时刻、强力发球的半窗口（秒） */
  serveCue?: ServeCue | null;
  /** 扣杀时镜头的一下顿挫：这一帧镜头整体挪开多少（米，仿真坐标）；没有就不动 */
  kick?: Vec3;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** 每个人身后的镜头；不分屏时只用近端的 */
  readonly cameras: Record<Side, THREE.PerspectiveCamera> = {
    near: new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.05, 60),
    far: new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.05, 60),
  };
  /** 双人分屏（左近端、右远端），见 setSplit */
  private split = false;
  readonly root = new THREE.Group();
  readonly ballView: BallView;
  /** 多余的球（多球训练），按需创建 */
  private readonly extraBallViews: BallView[] = [];
  readonly avatars: Record<Side, AvatarView>;
  readonly machine: BallMachineView;
  /** 看台上的观众 */
  readonly crowd: Crowd;
  private readonly effects: Effects;
  private readonly camX: Record<Side, number> = { near: 0, far: 0 };
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
    const scenery = buildScenery(this.root, this.renderer.capabilities.getMaxAnisotropy());
    this.crowd = new Crowd(this.root, scenery.seats, crowdKit());
    buildArena(this.root);
    this.ballView = new BallView(this.root);
    const who = avatarsInUse();
    this.avatars = {
      near: new AvatarView(this.root, (t) => createAvatarBody(who.near, t)),
      far: new AvatarView(this.root, (t) => createAvatarBody(who.far, t)),
    };
    for (const side of SIDES) this.cameras[side].layers.enable(VIEW_LAYER[side]);
    this.machine = new BallMachineView(this.root);
    this.effects = new Effects(this.root);
    this.setSplit(false);
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * 分屏（双人）或单屏，随时可以切换。单屏：近端的自己半透明（随时看得到球），远端不透明；
   * 分屏：每人两份模型，自己的镜头里半透明，对方的镜头里不透明
   */
  setSplit(split: boolean): void {
    this.split = split;
    if (split) {
      this.avatars.near.show(VIEW_LAYER.near, VIEW_LAYER.far);
      this.avatars.far.show(VIEW_LAYER.far, VIEW_LAYER.near);
    } else {
      this.avatars.near.show(0, null);
      this.avatars.far.show(null, 0);
    }
    this.resize();
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    for (const c of Object.values(this.cameras)) {
      c.aspect = this.split ? w / 2 / h : w / h;
      c.fov = this.split ? SPLIT_CAMERA.fov : CAMERA.fov;
      c.updateProjectionMatrix();
    }
  }

  /** 击球特效（p = 击球点；strong = 扣杀 / 强力发球） */
  hitEffect(p: Vec3, strong: boolean): void {
    this.effects.hit(p, strong, this.lastT);
  }

  /**
   * 每分结束：得分的一方挥拳跳起，失分的一方低头（赢下整局时庆祝得久一点）；
   * hit = 失分的一方是被球打到了脸上 / 身上：头往后一仰、手捂脸
   */
  pointReaction(winner: Side, gameOver = false, hit = false): void {
    this.avatars[winner].react('win', gameOver ? 3 : 1.6);
    this.avatars[otherSide(winner)].react(hit ? 'ouch' : 'lose', gameOver ? 3 : 1.6);
  }

  /** 落台特效 */
  bounceEffect(p: Vec3): void {
    this.effects.bounce(p, this.lastT);
  }

  render(frame: RenderFrame): void {
    const dt = Math.min(0.1, Math.max(0, frame.t - this.lastT));
    this.lastT = frame.t;

    this.ballView.style = frame.trail;
    this.ballView.spin = frame.spin;
    this.ballView.update(frame.ball, frame.t, frame.ballVisible);

    for (const side of SIDES) {
      const rp = frame.players[side];
      this.avatars[side].visible = !!rp;
      if (rp)
        this.avatars[side].update(
          rp.body,
          sideDir(side),
          forehandSign(rp.player),
          rp.paddle,
          dt,
          frame.ballVisible ? frame.ball : null,
          rp.player.cowering
        );
    }
    this.machine.update(frame.machine ?? null);
    const extras = frame.extraBalls ?? [];
    while (this.extraBallViews.length < extras.length)
      this.extraBallViews.push(new BallView(this.root));
    this.extraBallViews.forEach((v, i) =>
      v.update(extras[i] ?? frame.ball, frame.t, i < extras.length)
    );
    this.crowd.update(frame.t);
    this.effects.update(frame.t);
    this.effects.serveCue(frame.serveCue ?? null, frame.t);
    // 球靠近自己时，自己再透明一些
    for (const side of this.split ? SIDES : (['near'] as const)) {
      const me = frame.players[side]?.body;
      if (!me) continue;
      const d = Math.hypot(frame.ball.x - me.x, frame.ball.y - me.y);
      this.avatars[side].setFade(
        frame.ballVisible ? Math.max(0, Math.min(1, 1 - (d - 0.3) / 0.8)) * 0.4 : 0
      );
    }

    const k = 1 - Math.exp(-dt / 0.3);
    const kick = frame.kick ?? NO_KICK;
    if (!this.split) {
      this.aim('near', frame.players.near.body.x, CAMERA, 0.25, k, kick);
      this.renderer.render(this.scene, this.cameras.near);
      return;
    }
    // 分屏：左半屏近端、右半屏远端，各画一遍（影子也各算一遍：两边看到的自己不是同一份模型）
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setScissorTest(true);
    for (const side of SIDES) {
      const x = side === 'near' ? 0 : w / 2;
      this.renderer.setViewport(x, 0, w / 2, h);
      this.renderer.setScissor(x, 0, w / 2, h);
      const me = frame.players[side]?.body.x ?? 0;
      this.aim(side, me, SPLIT_CAMERA, SPLIT_CAMERA.follow, k, kick);
      this.renderer.render(this.scene, this.cameras[side]);
    }
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
  }

  /** 这一边的镜头：在这个人身后，横向跟着他走（平滑）；kick = 扣杀顿挫，镜头和看的点一起挪（平移，不转） */
  private aim(
    side: Side,
    meX: number,
    c: typeof CAMERA,
    follow: number,
    k: number,
    kick: Vec3
  ): void {
    const f = sideDir(side);
    this.camX[side] += (follow * meX - this.camX[side]) * k;
    const cx = this.camX[side];
    const cam = this.cameras[side];
    toThree({ x: cx + kick.x, y: f * c.y + kick.y, z: c.z + kick.z }, cam.position);
    cam.lookAt(
      toThree({ x: 0.4 * cx + kick.x, y: f * c.lookY + kick.y, z: TABLE.height + c.lookZ + kick.z })
    );
  }
}

const NO_KICK: Vec3 = { x: 0, y: 0, z: 0 };

const SIDES = ['near', 'far'] as const;

const otherSide = (s: Side): Side => (s === 'near' ? 'far' : 'near');
