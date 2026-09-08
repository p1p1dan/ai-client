# Implementation Status — 资源归位与会话导入（B 组）

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)。

## Current phase

**Not Started。** 计划于 2026-09-08 立项，来源是
[PI-Desktop 调研档](../../../plans/2026-09-08-pi-desktop-study.md) 的处置汇总。
四项均未动工，没有任何代码改动，没有 evidence 文件。

## Active TODO（最多五项）

1. **B1-a 前置取证**（最先做）：证实 pi 是否原生加载 `~/.agents/skills`。
   设置页那句「三处始终加载」目前无据，取证结论无论正反都要写进 evidence。
2. B3 随包扩展表驱动：与 B1 零文件重叠，可同时开工。
3. B4 Codex 导入：同样可并行；先确认 `__tests__/fixtures/codex/` 的夹具够不够做幂等臂。
4. B1-b 落点（取证通过后）：模型可达的安装路径 + 设置页文案与「打开技能目录」按钮。
5. B2 借读面对齐（B1-a 之后，结论决定要不要借 `~/.agents/subagents`）。

## Blocker

无外部阻塞。四项都不依赖未部署的服务，不依赖 A 组。

**两个内部前提**：

- B2 依赖 B1-a 的取证结论。
- 与 A 组的三处接缝见 [README](./README.md#与-a-组的文件边界并行前提)；
  尤其 `src/shared/piModelConfig.ts` 两组都要改，**双方都只追加不重排**。

## Last verified

尚无。首条 evidence 应记录：实际执行的命令、日期、环境，以及**未跑到的门禁**
（本机不跑整套生产构建、不启动 Electron GUI 时，逐条列出未验证项，不写成全绿）。

B1-a 的取证 evidence 还要额外记：pi 版本（当前 `pi-coding-agent` 0.84.3）、
探针脚本路径、托管/本地/TUI 三种模式各自的结论。
