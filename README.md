# 体感乒乓（Rea-Sports）

用 Switch 一代 Joy-Con 当球拍、在电视上玩的体感乒乓球，手感对标 Wii Sports Resort 的乒乓球。
净室重做：只复刻玩法机制，不使用任天堂的任何代码、素材、名称或音乐。

## 运行

```bash
pnpm install
pnpm dev          # 打开 http://localhost:5288
```

端口固定为 5288（WebHID 的授权按网址记忆，端口变了要重新授权）。浏览器请用 **桌面版 Chrome**。

| 页面           | 地址                                 | 用途                                     |
| -------------- | ------------------------------------ | ---------------------------------------- |
| 菜单           | http://localhost:5288/               | 入口                                     |
| Joy-Con 调试页 | http://localhost:5288/imu-debug.html | 连接、看数据、检查清单、震动、录挥拍样本 |
| 自动演示       | http://localhost:5288/?mode=autoplay | 电脑对电脑，看物理/规则/AI/画面/声音     |

自动演示的参数：`a`、`b` = 两边电脑等级 1–5，`points` = 6 或 11，`speed` = 速度倍率（如 0.3 慢放），`seed` = 随机种子，`skip` = 开局先快进的秒数。

## 连接 Joy-Con（macOS）

1. 「系统设置 → 蓝牙」；按住 Joy-Con 导轨侧面的小圆形配对键，直到指示灯来回闪烁，在列表里点「连接」。
2. 打开调试页，点「连接 Joy-Con」，在弹窗里选中手柄。以后刷新页面会自动连上。
3. Joy-Con 重新插回 Switch 时会自动和 Switch 配对，再用于电脑时要重新做第 1 步。
4. 建议戴好腕带。

## 接电视

- MacBook 用 HDMI 线接电视（镜像显示，或把电视设为主显示器）。
- 电视切到「游戏模式」，关闭「运动补偿 / MEMC / 动态清晰」等画面增强（会增加延迟）。
- Chrome 全屏：⌃⌘F。

## 开发命令

```bash
pnpm test           # 单元测试（物理、求解器、规则、记分、输入解析、融合、诊断……）
pnpm typecheck      # 类型检查（含「纯逻辑层不得依赖 DOM」的检查）
pnpm lint
pnpm soak --games 200 --a 3 --b 3 --points 6   # 无界面批量对局统计
pnpm bench:solver   # 求解器性能
pnpm build
```

## 目录

```
src/core/      数学（向量、四元数、可复现随机数）
src/config/    手感参数 tuning、电脑难度、震动预设
src/input/     Joy-Con：协议解析、校准、震动编码、时间戳、WebHID 驱动、姿态融合、诊断、录制回放
src/sim/       仿真（纯 TS）：球的物理、击球求解器、裁判与记分、走位、电脑 AI、整局比赛 MatchSim
src/render/    three.js 画面：场地、球与影子、人物与球拍、相机
src/audio/     程序化音效
src/ui/        画面文字层（比分、提示）
src/app/       入口、游戏循环
src/debug/     Joy-Con 调试页
tests/         vitest 测试
scripts/       soak（批量对局）、bench-solver
```

`src/core`、`src/sim`、`src/input` 里的纯逻辑部分不依赖浏览器（由 `tsconfig.sim.json` 和 ESLint 强制），
以后做安卓电视 App 时可以直接复用。

## 进度

- [x] M0 连接验证：Joy-Con 驱动（WebHID）、时间戳、姿态融合、调试页、检查清单、录制器 —— **待实机验证**
- [x] M1 物理 / 规则 / 电脑 AI / 自动演示
- [ ] M2 玩家球拍 1:1 + 挥拍识别 + 击球判定 + 发球机练习
- [ ] M3 完整比赛（发球、菜单、震动、结算）
- [ ] M4 对照 WSR 视频调手感

第三方代码声明见 `NOTICE`。
