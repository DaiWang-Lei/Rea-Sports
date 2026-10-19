/**
 * 球拍姿态（世界/仿真坐标）。电脑球员按挥拍时间轴程序化生成：
 * 准备 → 引拍（高度暗示旋转）→ 挥向击球点 → 随挥 → 回到准备。
 */
import { clamp } from '@/core/math';
import { normalize, type Vec3, vec3 } from '@/core/vec3';
import { sideDir, TABLE } from '@/sim/constants';
import { forehandSign, type PlayerSim, type SwingAnim } from '@/sim/players/PlayerSim';

export interface PaddlePose {
  /** 拍面中心 */
  pos: Vec3;
  /** 红色（正手）面的法向 */
  normal: Vec3;
  /** 从拍面中心指向拍柄末端的方向 */
  handle: Vec3;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export function readyPaddle(body: { x: number; y: number }, p: PlayerSim): PaddlePose {
  const f = sideDir(p.side);
  const fh = forehandSign(p);
  return {
    pos: vec3(body.x + fh * 0.28, body.y + f * 0.42, TABLE.height + 0.18),
    normal: normalize(vec3(-fh * 0.3, f, 0.1)),
    handle: normalize(vec3(fh * 0.2, -f * 0.5, -0.8)),
  };
}

/** 电脑球员（以及自动演示时的近端球员）的球拍 */
export function cpuPaddle(
  body: { x: number; y: number },
  p: PlayerSim,
  swing: SwingAnim | null,
  t: number
): PaddlePose {
  const ready = readyPaddle(body, p);
  if (!swing || t < swing.start || t > swing.end + 0.25) return ready;

  const f = sideDir(p.side);
  const fh = forehandSign(p);
  const strokeSign = swing.stroke === 'fh' ? fh : -fh;
  const back = vec3(body.x + strokeSign * 0.55, body.y + f * 0.12, swing.height);
  // 击球点离身体太远时（够不着）就停在手臂能伸到的地方
  const c = swing.contact;
  const reach = Math.hypot(c.x - body.x, c.y - body.y);
  const k = reach > 0.95 ? 0.95 / reach : 1;
  const contact = vec3(
    body.x + (c.x - body.x) * k,
    body.y + (c.y - body.y) * k,
    clamp(c.z, TABLE.height - 0.1, 2.0)
  );
  const follow = vec3(body.x - strokeSign * 0.15, body.y + f * 0.55, TABLE.height + 0.5);

  // 拍面：击球时朝向对方，上旋压拍（稍向下），下旋开拍（稍向上）
  const tilt =
    swing.kind === 'cut'
      ? 0.55
      : swing.kind === 'smash'
        ? -0.15
        : swing.kind === 'popup'
          ? 0.6
          : -0.35;
  const hitNormal = normalize(vec3(-strokeSign * 0.25, f, tilt));
  // 反手用黑面击球：红面法向朝后
  const redNormal =
    swing.stroke === 'fh' ? hitNormal : vec3(-hitNormal.x, -hitNormal.y, -hitNormal.z);
  const handle = normalize(vec3(strokeSign * 0.35, -f * 0.35, -0.7));

  const forwardStart = swing.hit - 0.12;
  let pos: Vec3;
  let normal: Vec3;
  if (t < forwardStart) {
    const u = smooth(clamp((t - swing.start) / Math.max(0.05, forwardStart - swing.start), 0, 1));
    pos = lerpV(ready.pos, back, u);
    normal = normalize(lerpV(ready.normal, redNormal, u));
  } else if (t < swing.hit) {
    const u = clamp((t - forwardStart) / 0.12, 0, 1);
    pos = lerpV(back, contact, u * u);
    normal = redNormal;
  } else if (t < swing.hit + 0.18) {
    const u = smooth(clamp((t - swing.hit) / 0.18, 0, 1));
    pos = lerpV(contact, follow, u);
    normal = redNormal;
  } else {
    const u = smooth(
      clamp((t - swing.hit - 0.18) / Math.max(0.05, swing.end + 0.25 - swing.hit - 0.18), 0, 1)
    );
    pos = lerpV(follow, ready.pos, u);
    normal = normalize(lerpV(redNormal, ready.normal, u));
  }
  return { pos, normal, handle };
}
