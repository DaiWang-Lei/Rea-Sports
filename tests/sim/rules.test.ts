import { describe, expect, it } from 'vitest';
import { type PointReason, Referee, type RefereeInput } from '@/sim/rally/Referee';
import { Scoring } from '@/sim/rally/Scoring';
import type { Side } from '@/sim/constants';

const N: Side = 'near';
const F: Side = 'far';
const serve = (s: Side): RefereeInput => ({ type: 'serveHit', side: s });
const hit = (s: Side): RefereeInput => ({ type: 'hit', side: s });
const table = (s: Side, edge = false): RefereeInput => ({ type: 'table', side: s, edge });
const cord: RefereeInput = { type: 'net', part: 'cord' };
const body: RefereeInput = { type: 'net', part: 'body' };
const floor: RefereeInput = { type: 'floor' };
const sideHit: RefereeInput = { type: 'side' };
const dead: RefereeInput = { type: 'dead' };

type Expect = { winner: Side; reason: PointReason } | 'let' | 'continue';

/** 发球方 near；按顺序喂事件，返回第一个非 continue 的结果 */
function play(server: Side, inputs: RefereeInput[]): Expect {
  const r = new Referee();
  r.reset(server);
  for (const i of inputs) {
    const out = r.feed(i);
    if (out.type === 'point') return { winner: out.winner, reason: out.reason };
    if (out.type === 'let') return 'let';
  }
  return 'continue';
}

const CASES: Array<[string, Side, RefereeInput[], Expect]> = [
  // ---- 发球
  ['好发球 → 接发球方要击球', N, [serve(N), table(N), table(F)], 'continue'],
  ['发球直接落对方台（没先落本方）', N, [serve(N), table(F)], { winner: F, reason: 'serveFault' }],
  ['发球直接下网', N, [serve(N), body], { winner: F, reason: 'serveFault' }],
  ['发球落地', N, [serve(N), floor], { winner: F, reason: 'serveFault' }],
  ['发球打到台子侧面', N, [serve(N), sideHit], { winner: F, reason: 'serveFault' }],
  ['发球在本方台弹两次', N, [serve(N), table(N), table(N)], { winner: F, reason: 'serveFault' }],
  ['发球落本方台后出界', N, [serve(N), table(N), floor], { winner: F, reason: 'serveFault' }],
  ['发球擦网后落对方台 → 重发', N, [serve(N), table(N), cord, table(F)], 'let'],
  [
    '发球擦网后出界 → 发球失误',
    N,
    [serve(N), table(N), cord, floor],
    { winner: F, reason: 'serveFault' },
  ],
  [
    '发球撞网身后掉回本方台',
    N,
    [serve(N), table(N), body, table(N)],
    { winner: F, reason: 'serveFault' },
  ],
  ['发球擦边球有效', N, [serve(N), table(N, true), table(F, true)], 'continue'],
  ['接发球方截击发球', N, [serve(N), table(N), hit(F)], { winner: N, reason: 'volley' }],
  [
    '接发球没接到（落地）',
    N,
    [serve(N), table(N), table(F), floor],
    { winner: N, reason: 'missed' },
  ],
  [
    '接发球没接到（两跳）',
    N,
    [serve(N), table(N), table(F), table(F)],
    { winner: N, reason: 'doubleBounce' },
  ],
  ['远端发球的镜像情况', F, [serve(F), table(F), table(N), floor], { winner: F, reason: 'missed' }],
  ['远端发球直接下网', F, [serve(F), body], { winner: N, reason: 'serveFault' }],
  ['发球方以外的人击发球被忽略（不是发球方不能发）', N, [serve(F), table(F)], 'continue'],
  // ---- 回合
  [
    '接发球回过去落台 → 等发球方回球',
    N,
    [serve(N), table(N), table(F), hit(F), table(N)],
    'continue',
  ],
  [
    '回球出界（直接落地）',
    N,
    [serve(N), table(N), table(F), hit(F), floor],
    { winner: N, reason: 'out' },
  ],
  [
    '回球下网落本方',
    N,
    [serve(N), table(N), table(F), hit(F), body, table(F)],
    { winner: N, reason: 'net' },
  ],
  [
    '回球下网落地',
    N,
    [serve(N), table(N), table(F), hit(F), body, floor],
    { winner: N, reason: 'net' },
  ],
  [
    '回球擦网落对方台 → 继续',
    N,
    [serve(N), table(N), table(F), hit(F), cord, table(N)],
    'continue',
  ],
  [
    '回球擦网后出界算下网',
    N,
    [serve(N), table(N), table(F), hit(F), cord, floor],
    { winner: N, reason: 'net' },
  ],
  [
    '回球落在自己台上',
    N,
    [serve(N), table(N), table(F), hit(F), table(F)],
    { winner: N, reason: 'ownSide' },
  ],
  [
    '回球打到台子侧面',
    N,
    [serve(N), table(N), table(F), hit(F), sideHit],
    { winner: N, reason: 'out' },
  ],
  [
    '对方截击（未落台击球）',
    N,
    [serve(N), table(N), table(F), hit(F), hit(N)],
    { winner: F, reason: 'volley' },
  ],
  ['擦边球有效并继续', N, [serve(N), table(N), table(F), hit(F), table(N, true)], 'continue'],
  [
    '正常对拉几拍后漏接',
    N,
    [serve(N), table(N), table(F), hit(F), table(N), hit(N), table(F), hit(F), table(N), floor],
    { winner: F, reason: 'missed' },
  ],
  [
    '对拉中两跳',
    N,
    [serve(N), table(N), table(F), hit(F), table(N), hit(N), table(F), table(F)],
    { winner: N, reason: 'doubleBounce' },
  ],
  [
    '对拉中出界',
    N,
    [serve(N), table(N), table(F), hit(F), table(N), hit(N), floor],
    { winner: F, reason: 'out' },
  ],
  [
    '下旋球弹回网这边落对方台（接球方没碰）',
    N,
    [serve(N), table(N), table(F), hit(F), table(N), table(F)],
    { winner: F, reason: 'missed' },
  ],
  [
    '死球（长时间没事件）在等待落台时',
    N,
    [serve(N), table(N), table(F), hit(F), dead],
    { winner: N, reason: 'out' },
  ],
  ['死球在等待接球时', N, [serve(N), table(N), table(F), dead], { winner: N, reason: 'missed' }],
  ['发球后死球', N, [serve(N), dead], { winner: F, reason: 'serveFault' }],
  [
    '已落台后网事件不影响',
    N,
    [serve(N), table(N), table(F), body, floor],
    { winner: N, reason: 'missed' },
  ],
  [
    '同一方连续击球不算（只认对方）',
    N,
    [serve(N), table(N), table(F), hit(F), hit(F), table(N)],
    'continue',
  ],
  [
    '接球后擦网带再落对方台继续，之后对方下网',
    N,
    [serve(N), table(N), table(F), hit(F), cord, table(N), hit(N), body, table(N)],
    { winner: F, reason: 'net' },
  ],
  [
    '擦网标记在下一次击球后清除',
    N,
    [serve(N), table(N), table(F), hit(F), cord, table(N), hit(N), floor],
    { winner: F, reason: 'out' },
  ],
  [
    '远端发、近端回、远端漏',
    F,
    [serve(F), table(F), table(N), hit(N), table(F), floor],
    { winner: N, reason: 'missed' },
  ],
  [
    '远端回球出界',
    F,
    [serve(F), table(F), table(N), hit(N), table(F), hit(F), floor],
    { winner: N, reason: 'out' },
  ],
];

describe('Referee', () => {
  for (const [name, server, inputs, expected] of CASES) {
    it(name, () => {
      expect(play(server, inputs)).toEqual(expected);
    });
  }
});

describe('Scoring', () => {
  it('6 分制：先到 6 且领先 2 分获胜', () => {
    const s = new Scoring({ target: 6, drawAt: 20, firstServer: 'near' });
    for (let i = 0; i < 5; i++) s.addPoint('near');
    for (let i = 0; i < 5; i++) s.addPoint('far');
    expect(s.result).toBeNull();
    expect(s.isDeuce).toBe(true);
    s.addPoint('near');
    expect(s.result).toBeNull();
    expect(s.gamePointFor).toBe('near');
    s.addPoint('near');
    expect(s.result).toBe('near');
  });

  it('6:0 直接获胜', () => {
    const s = new Scoring({ target: 6, drawAt: 20, firstServer: 'near' });
    for (let i = 0; i < 6; i++) s.addPoint('far');
    expect(s.result).toBe('far');
  });

  it('20:20 平局（WSR 规则）', () => {
    const s = new Scoring({ target: 6, drawAt: 20, firstServer: 'near' });
    for (let i = 0; i < 20; i++) {
      s.addPoint('near');
      s.addPoint('far');
    }
    expect(s.result).toBe('draw');
  });

  it('发球轮换：每人 2 分；平分后每分轮换（11 分制）', () => {
    const s = new Scoring({ target: 11, drawAt: null, firstServer: 'near' });
    const servers: Side[] = [];
    // 交替得分直到 12:12
    for (let i = 0; i < 24; i++) {
      servers.push(s.server());
      s.addPoint(i % 2 === 0 ? 'near' : 'far');
    }
    expect(servers.slice(0, 8)).toEqual([
      'near',
      'near',
      'far',
      'far',
      'near',
      'near',
      'far',
      'far',
    ]);
    // 10:10（第 21 分，下标 20）起每分轮换
    expect(servers.slice(18, 24)).toEqual(['far', 'far', 'near', 'far', 'near', 'far']);
  });

  it('发球轮换：6 分制 5:5 后每分轮换', () => {
    const s = new Scoring({ target: 6, drawAt: 20, firstServer: 'near' });
    const servers: Side[] = [];
    for (let i = 0; i < 14; i++) {
      servers.push(s.server());
      s.addPoint(i % 2 === 0 ? 'near' : 'far');
    }
    expect(servers.slice(0, 10)).toEqual([
      'near',
      'near',
      'far',
      'far',
      'near',
      'near',
      'far',
      'far',
      'near',
      'near',
    ]);
    expect(servers.slice(10, 14)).toEqual(['far', 'near', 'far', 'near']);
  });

  it('电脑先发时同样每 2 分轮换', () => {
    const s = new Scoring({ target: 6, drawAt: 20, firstServer: 'far' });
    const servers: Side[] = [];
    for (let i = 0; i < 4; i++) {
      servers.push(s.server());
      s.addPoint('near');
    }
    expect(servers).toEqual(['far', 'far', 'near', 'near']);
  });
});
