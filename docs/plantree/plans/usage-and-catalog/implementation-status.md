# Implementation Status — 用量可见性与目录韧性（A 组）

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)。

## Current phase

**Not Started。** 计划于 2026-09-08 立项，来源是
[PI-Desktop 调研档](../../../plans/2026-09-08-pi-desktop-study.md) 的处置汇总。
三项均未动工，没有任何代码改动，没有 evidence 文件。

## Active TODO（最多五项）

1. A1 缓存命中率：`deriveCacheHitRate` + 四条纯函数臂 + Run 面板一行。
2. A3 模型目录随包快照：可与 A1 同时开工，零文件重叠。
3. A2 前置取证：确认 pi 的 `turn_end` 事件**是否携带子代理用量增量**。
   结论决定 A2 的口径第 4 条怎么写，不要照抄 PI-Desktop 的形状。
4. A2 会话内轮级汇总（A1 合入后开始）。
5. A3 的发布流程接入点选定（`dist:prereq` 还是独立的 tag 前置），写进 evidence。

## Blocker

无。三项都不依赖外部接口，不依赖 B 组，不依赖未部署的服务。

**唯一的协调项**：A1 必须先于 A2 合入（同改 `src/shared/piUsage.ts`）。
与 B 组的三处接缝见 [README](./README.md#与-b-组的文件边界并行前提)。

## Last verified

尚无。首条 evidence 应记录：实际命令、日期、通过的文件数与用例数，以及**未跑到的门禁**
（本机不跑整套生产构建，也未启动 Electron GUI —— 按仓库规范如实记，不写成全绿）。
