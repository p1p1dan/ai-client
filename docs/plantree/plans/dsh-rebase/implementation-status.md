# DSH 二开迁移：进度看板

Role: implementation-status。更新日期：2026-09-26。只放当前阶段、最多五项活动任务、最近落地、阻塞和最近验证；任务身份与状态以 [roadmap](roadmap.md) 为准。

## 工作方式（2026-09-26 用户授权）

- 只在分支 `feat/dsh-p0-probe`（worktree `.claude/worktrees/agent-a84b7bf3214a2affd`）上活动，不动 main 与 v1.0.3；不推送，推送与发版前先确认。
- 按 roadmap 顺序推进 P1。一般问题调研后自行决定，每条决定单独写一份决策文件，标「自主决定，待用户审批」；难以解决的问题停下来与用户商讨。

## Current Phase

P1 分支内 DSH 替换。P1-0 已完成（2026-09-26）。P1-1 引擎直替方案已定（[方案](topics/p1-1-engine-cutover.md)，决策 005～010 待用户审批），进入实现。P1-2 打包方案调研中。

## Next Target

P1-1 实现：Main 直替、身份与索引、bridge 最小补丁、单测与 bridge-smoke 扩展；之后做开发机 GUI 点验（退出判据「新建会话走 DSH」）。

## Last Landed

- 2026-09-26 P1-0：合并提交 `30a0c257`，把 main v1.0.3（`d23d72aa`）同步进本分支，零冲突。证据见 [p1-0-sync-main-2026-09-26.md](evidence/p1-0-sync-main-2026-09-26.md)。

## Active TODO

1. P1-1 实现（opus 代理，按[方案](topics/p1-1-engine-cutover.md)与决策 005～010）。
2. P1-2 打包方案调研（opus 代理，只读），出方案后落决策。
3. 决策 005～010 等用户审批；审批前按决策施工，被驳回的再回改。

## Blocked By

- 无。P1-13 加密机上机要等用户上机；P1-11 内嵌终端去留要用户拍板；P1-14 推送与发版要用户确认。

## Last Verified

- 2026-09-26 P1-0（Linux 开发机，`30a0c257`）：四套 tsc 全部退出 0；`src/main/services/agent-host/` 与 worker RPC 类型相关单测 19 个文件、314 例全过；`bridge-smoke.ts` 6 项判定全部为真。全量 Vitest 与 GUI 未跑。
