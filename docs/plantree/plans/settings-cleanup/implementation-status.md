# Implementation Status — 设置清单整理与旧壳删除

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)；不在此复制第二份任务状态。

## Current phase

**取证与拍板已完成，施工未开始。** 2026-09-07 立项当天完成三轮取证与全部边界拍板，
七个任务全在 Next，无 In Progress。

## Active TODO（最多五项）

1. **S04 删纯死设置** —— 零依赖，先走。删 Agent 通知三项 + `fileTreeAutoReveal` + 增强输入两键。
2. **S01 全局搜索移植** —— 补齐线第一项，S05 的硬前置。
3. **S02 仓库设置入口** —— 补齐线第二项。
4. **S03 分支切换移植** —— 补齐线第三项。
5. **S05 删旧壳** —— 前三项全部合入后才允许开工。

S06 / S07 在 S05 之后，暂不进 Active。

## Blocker

无外部阻塞。唯一的内部纪律是**顺序**：S01/S02/S03 未全部合入前不得动 S05，
否则中间态会真丢能力（全局搜索无替代入口、初始化脚本变成不可配置）。

## Last verified

**2026-09-07 · 取证**（静态分析，未运行项目门禁）：

- 设置项审计：对 `SettingsState` 的 70 个状态字段逐个 grep 消费方，
  沿 import 链确认默认壳下可达性。结论：5 项纯失效、13 组仅旧壳生效。
- 壳可达性闭包对比：脚本 BFS 解析 `@/` 与相对 import，
  `workspace-shell` 可达 279 文件 / 旧壳五入口可达 197 文件 / 旧壳独有 78 文件。
- 关键边界行：`App.tsx:1434` 分支入口、`App.tsx:1446-1845` 旧壳分支范围、
  `App.tsx:1422` BackgroundLayer（**在分支之外**，背景图设置不受影响）、
  `stores/settings/index.ts:202` 开关默认值、`mainTabShortcutGate.ts:20` 主标签快捷键让位、
  `GitSurfaceView.tsx:15-16` Git 动作 ban。

**尚未运行**：`pnpm lint` / `pnpm typecheck` / `pnpm test`。
本轮没有代码改动，三绿留到第一个任务落地时取。

## 与其他计划的关系

- [pix/pi-app UI 对齐](../pix-ui-alignment/README.md)：那边管新壳的形态，本计划管旧壳的消亡与设置页的收敛。
  本计划的 GUI 点验并入那边的累计点验，不单独开轮次。
- S03 解掉 `GitSurfaceView` 的 Git 动作 ban，是对该计划既有减法决策的**局部松绑**，
  松绑范围仅限分支切换，落地时需在该文件头注释里写清新边界。
