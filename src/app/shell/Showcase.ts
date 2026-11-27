/**
 * 菜单的背景：球场里两边各站一个人（1P、2P 选的人物；只有一个人时对面是默认的人物），摆着准备姿势等球，
 * 镜头慢慢绕着球场转。用渲染器的回放通道画（两个人都是不透明的那份，镜头随便摆）。
 */
import { createTuning } from '@/config/tuning';
import type { Vec3 } from '@/core/vec3';
import { sideDir, TABLE } from '@/sim/constants';
import { createPlayer, forehandSign, type PlayerSim, readyPosition } from '@/sim/players/PlayerSim';
import { AvatarMotion } from '@/render/avatar/motion';
import type { AvatarPose } from '@/render/avatar/types';
import { cpuPaddle } from '@/render/paddlePose';
import type { Renderer } from '@/render/Renderer';

/** 镜头绕球场转一圈多少秒、离球场中心多远、多高 */
const ORBIT = { period: 90, radius: 5.6, z: 2.4 };

export class Showcase {
  private t = 0;
  private active = false;
  private readonly players: Record<'near' | 'far', PlayerSim>;
  private readonly motion = { near: new AvatarMotion(), far: new AvatarMotion() };

  constructor(private readonly renderer: Renderer) {
    const tune = createTuning();
    const limits = { vMax: 3, aMax: 12, gain: 6, yFactor: 0.6 };
    this.players = {
      near: createPlayer('near', 1, true, limits, tune),
      far: createPlayer('far', 1, true, limits, tune),
    };
    for (const side of ['near', 'far'] as const) {
      const r = readyPosition(side, 0, tune);
      this.players[side].mover.teleport(r.x, r.y);
    }
  }

  /** 开始当背景（进菜单）：两个人都画不透明的 */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.renderer.beginReplay(this.frame(0));
  }

  /** 不当背景了（进比赛）：画面还给比赛 */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.renderer.endReplay();
  }

  render(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const a = (this.t / ORBIT.period) * Math.PI * 2;
    const view: { pos: Vec3; look: Vec3 } = {
      pos: { x: ORBIT.radius * Math.sin(a), y: -ORBIT.radius * Math.cos(a), z: ORBIT.z },
      look: { x: 0, y: 0, z: TABLE.height },
    };
    this.renderer.renderReplay(this.frame(dt), dt, view);
  }

  private frame(dt: number) {
    const poses: Partial<Record<'near' | 'far', AvatarPose>> = {};
    for (const side of ['near', 'far'] as const) {
      const p = this.players[side];
      const body = { x: p.mover.x, y: p.mover.y };
      const paddle = cpuPaddle(body, p, null, this.t);
      poses[side] = this.motion[side].update(
        body,
        sideDir(side),
        forehandSign(p),
        paddle,
        dt,
        null
      );
    }
    return {
      t: this.t,
      ball: { x: 0, y: 0, z: -1 },
      ballVisible: false,
      trail: 'normal' as const,
      spin: { top: 0, side: 0 },
      poses,
    };
  }
}
