/**
 * 无头 Chrome 的启动参数。Mac 上用真 GPU（Metal）：画面加了实时阴影和看台观众以后，软件渲染（swiftshader）一帧要几十毫秒，
 * 游戏循环每帧最多追 50ms 的仿真，剩下的直接丢掉，比赛就跑得比实际慢很多，冒烟测试在时限内打不完一局。其它系统仍用软件渲染。
 */
export const CHROME_ARGS = [
  '--ignore-certificate-errors',
  ...(process.platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
];
