/**
 * 球拍姿态（世界/仿真坐标）。电脑球员按挥拍时间轴程序化生成：
 * 准备 → 引拍（高度暗示旋转）→ 挥向击球点 → 随挥 → 回到准备。
 * 手臂两段（上臂、前臂），肘按两段骨骼的反向运动学求（elbowOf），肘尖朝下、朝外。
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

/** 上臂长度、前臂长度（肘 → 握拍处），米 */
export const UPPER_ARM = 0.29;
export const FOREARM = 0.27;
/** 握拍处 → 拍面中心（沿拍头方向），米 */
export const GRIP_TO_CENTER = 0.138;

/** 持拍手的肩膀：facing = 朝向（近端 +1、远端 −1），out = 持拍手一侧在世界 x 上的方向 */
export function shoulderOf(body: { x: number; y: number }, facing: number, out: number): Vec3 {
  return vec3(body.x + out * 0.19, body.y + facing * 0.04, 1.2);
}

/** 等球时上臂的方向：从肩膀自然垂下，略向前、向外 */
function restUpperArm(facing: number, out: number): Vec3 {
  return normalize(vec3(out * 0.15, facing * 0.25, -1));
}

/** 等球时的肘 */
export function restElbow(body: { x: number; y: number }, facing: number, out: number): Vec3 {
  const s = shoulderOf(body, facing, out);
  const u = restUpperArm(facing, out);
  return vec3(s.x + u.x * UPPER_ARM, s.y + u.y * UPPER_ARM, s.z + u.z * UPPER_ARM);
}

/**
 * 两段手臂的肘（肩 s → 握拍处 g）：已知两段长度求肘的位置。肘尖朝等球时上臂的方向（朝下，略向前、向外）：
 * 等球时手的位置本来就由 restElbow 加前臂算出，这样求出来的肘正好就是 restElbow。
 * 够不着时手臂伸直，两段按比例拉长
 */
export function elbowOf(s: Vec3, g: Vec3, facing: number, out: number): Vec3 {
  const d = vec3(g.x - s.x, g.y - s.y, g.z - s.z);
  const len = Math.hypot(d.x, d.y, d.z);
  const reach = UPPER_ARM + FOREARM;
  if (len < 1e-6) return vec3(s.x, s.y, s.z - UPPER_ARM);
  const dir = vec3(d.x / len, d.y / len, d.z / len);
  if (len >= reach) {
    const k = (UPPER_ARM / reach) * len;
    return vec3(s.x + dir.x * k, s.y + dir.y * k, s.z + dir.z * k);
  }
  const l = Math.max(len, Math.abs(UPPER_ARM - FOREARM) + 1e-3);
  // 肩处夹角（余弦定理）
  const cosA = clamp(
    (UPPER_ARM * UPPER_ARM + l * l - FOREARM * FOREARM) / (2 * UPPER_ARM * l),
    -1,
    1
  );
  const sinA = Math.sqrt(1 - cosA * cosA);
  // 肘尖方向：去掉沿肩 → 手方向的分量
  const pole = restUpperArm(facing, out);
  const pd = pole.x * dir.x + pole.y * dir.y + pole.z * dir.z;
  let p = vec3(pole.x - pd * dir.x, pole.y - pd * dir.y, pole.z - pd * dir.z);
  if (Math.hypot(p.x, p.y, p.z) < 1e-6) p = vec3(out, 0, 0);
  p = normalize(p);
  return vec3(
    s.x + UPPER_ARM * (cosA * dir.x + sinA * p.x),
    s.y + UPPER_ARM * (cosA * dir.y + sinA * p.y),
    s.z + UPPER_ARM * (cosA * dir.z + sinA * p.z)
  );
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
