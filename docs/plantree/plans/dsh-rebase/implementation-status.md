# DSH 二开迁移：进度看板

Role: implementation-status。更新日期：2026-09-26。只放当前阶段、最多五项活动任务、最近落地、阻塞和最近验证；任务身份与状态以 [roadmap](roadmap.md) 为准。

## 工作方式（2026-09-26 用户授权）

- 只在分支 `feat/dsh-p0-probe`（worktree `.claude/worktrees/agent-a84b7bf3214a2affd`）上活动，不动 main 与 v1.0.3；不推送，推送与发版前先确认。
- 按 roadmap 顺序推进 P1。一般问题调研后自行决定，每条决定单独写一份决策文件，标「自主决定，待用户审批」；难以解决的问题停下来与用户商讨。

## Current Phase

P1 分支内 DSH 替换。P1-0 已完成（2026-09-26）。P1-1 引擎直替已完成（`100ebcf1`，GUI 点验通过，[证据](evidence/p1-1-gui-2026-09-26.md)），决策 005～010 待用户审批。收尾 `e3ce1691` 已修掉点验缺陷 D1 / D2，并停止向宿主下发含明文 key 的 `modelCatalog`。P1-2 打包方案已定（[方案](topics/p1-2-host-packaging.md)，决策 011～018 待用户审批），等 P1-1 落地后施工。P1-3 共享宿主方案已定（[方案](topics/p1-3-shared-host.md)，决策 019～025 待用户审批），P1-3b 可与 P1-2 并行。P1-4 bridge 对等方案已定（[方案](topics/p1-4-bridge-parity.md)，决策 026～032 待用户审批，其中 028 重试请重点审批），排在 P1-3 之后。P1-5 模型目录与凭据方案已定（[方案](topics/p1-5-models-and-credentials.md)，决策 033～040 待用户审批，其中 036、037、038 请重点审批）。P1-6 权限移植方案已定（[方案](topics/p1-6-permissions.md)，决策 041～049 待用户审批，其中 044、045 请重点审批）。

## Next Target

P1-1 实现：Main 直替、身份与索引、bridge 最小补丁、单测与 bridge-smoke 扩展；之后做开发机 GUI 点验（退出判据「新建会话走 DSH」）。

## Last Landed

- 2026-09-27 P1-3a：`1427a870` 共享宿主接线，所有聊天会话共用一个 DSH 宿主。复跑：三套 tsc 通过，单测 55 个文件、754 例通过，真宿主集成测试 4/4，bridge-smoke 27 项、打包冒烟 37 项全过。
- 2026-09-27 P1-6a：`16c8ef16` 权限逻辑抽成 `src/shared/permissions` 纯库，runtime 改为薄封装。复跑：三套 tsc 通过，runtime 与纯库相关 72 个文件、1291 例全过。
- 2026-09-27 P1-3b：`04ba4166` 共享宿主 Main 侧组件（未接线）。复跑：四套 tsc 通过，相关单测 49 个文件、656 例全过。
- 2026-09-27 P1-2：`2788952f` DSH 宿主转正并接入三平台打包（构建产物、干净安装与删除式裁剪、打包冒烟、CI 接入，未推送）。编排器复跑：dsh-host、agent-host 两套 tsc 通过；P1-2 单测 4 个文件、115 例全过；产物 L1 冒烟 31 项全过；bridge-smoke 18 项全为真。
- 2026-09-27 P1-1 收尾：`e3ce1691` 聊天会话不再向 DSH 宿主下发含明文 key 的模型目录；旧会话、附件被拒时草稿退回输入框。复跑：三套 tsc 通过，相关单测 203 个文件、3706 例全过。
- 2026-09-26 P1-1 代码：`100ebcf1` 聊天会话一律走 DSH 宿主，旧 pi 会话迁移前只读，新会话先落盘再写桩。证据见 [p1-1-engine-cutover-2026-09-26.md](evidence/p1-1-engine-cutover-2026-09-26.md)。
- 2026-09-26 P1-0：合并提交 `30a0c257`，把 main v1.0.3（`d23d72aa`）同步进本分支，零冲突。证据见 [p1-0-sync-main-2026-09-26.md](evidence/p1-0-sync-main-2026-09-26.md)。

## Active TODO

1. P1-2 本机部分完成（`2788952f`，[证据](evidence/p1-2-host-packaging-2026-09-27.md)）；三平台 CI 实跑待用户确认推送。
2. P1-3c 施工中（opus 代理）：WorkerManager 宿主级语义，包括批次恢复、两级预算、熔断、Stop 阶梯 B、`engine_restarted`，以及退出与 `invalidateAll` 连带关宿主。
3. P1-9a（解码链进 shared）与 P1-9g 的 v4 语料施工中（opus 代理）。
4. P1-7 渲染层方案调研中。P1-8 / P1-11 方案已定（决策 065～067 待审批）；P1-11 等用户答复 Q003。
5. 决策 005～067 与 Q007（许可）等用户审批。P1-10 / P1-16 方案已定（[方案](topics/p1-10-p1-16-extensions.md)）。

## Blocked By

- P1-2 在 Windows / macOS 上实跑必须推送分支，推送前要用户确认；本机只能验 Linux。
- P1-5 的真实网关验证 R1～R10（含 UA 实测）要用户授权：只用公司登录下发的网关，约 50 次小请求。
- P1-9 的真实数据离线迁移测试要用户指定机器与 profile 副本，由用户本人运行，或授权代理运行且只看报告。
- P1-11 等用户答复 [Q003](open-questions.md) 的两个问题：去不去掉 pi TUI、要不要换成普通终端入口。
- P1-13 加密机上机要等用户上机；P1-11 内嵌终端去留要用户拍板；P1-14 推送与发版要用户确认。

## Last Verified

- 2026-09-27 P1-1 GUI 点验（Linux 开发机，`100ebcf1`，临时 HOME、本地假网关，11 次请求都带假 key）：新建会话走 DSH ✅，恢复与崩溃重启 ✅，旧会话只读 ⚠️（草稿丢失），拒绝路径 ✅ / ⚠️（带图时草稿丢失），`session_locked` 未能取证。
- 2026-09-26 P1-1（Linux 开发机，内容同 `100ebcf1`）：四套 tsc 全部退出 0；相关单测 65 个文件、1043 例，加上渲染层 165 个文件、3201 例，全部通过；bridge-smoke 18 项判定全部为真。全量 Vitest 与 GUI 未跑，GUI 点验进行中。
- 2026-09-26 P1-0（Linux 开发机，`30a0c257`）：四套 tsc 全部退出 0；`src/main/services/agent-host/` 与 worker RPC 类型相关单测 19 个文件、314 例全过；`bridge-smoke.ts` 6 项判定全部为真。全量 Vitest 与 GUI 未跑。
