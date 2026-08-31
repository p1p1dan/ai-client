# Implementation Status — Pi-only Application Convergence

**Current Phase**：Plan realignment complete enough to enter T28; WorkerManager implementation has not started.

**Next Target**：[T28](./roadmap.md#t28--pi-only-architecture-and-deletion-boundary--next) file-level replacement/deletion map, then T29 single WorkerSlot vertical slice.

**Last Landed**：2026-08-31 Cycle 2 product surfaces and gates; see [Cycle 2 evidence](./evidence/2026-08-31-cycle2-execution.md).

**Last Verified**：2026-08-31 — main and Agent Host typecheck 0; Biome `src` + `scripts` 1094 files clean; integrated Cycle 2 16 files / 260 tests, plus 28 and 16 focused reruns; `git diff --check` clean; Electron/CDP inline approval, badges, status/widget/TUI-only notice and grouped model menu smoke passed.

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：应用成为 Pi-only；Claude/Codex execution runtime 最终删除，历史通过只读 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Electron Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- 现有 `PiHostProcess`/`AgentHostManager` 和 multi-runtime code 仍在实现中，属于 T28/T29 的替换来源，不是目标边界。
- D13 的旧 Cycle 3 history-first、Cycle 4 TUI、Cycle 5 RC 排期已失效；当前顺序以 [roadmap](./roadmap.md) T28–T37 为准。

## Preserved completed behavior

- Cycle 1：queue/pending、preview safety、permission policy/settings、repository/session retirement。
- Cycle 2：session-local inline approval、Extension UI capability/display/reset、owner-targeted fire-and-forget、TUI-only hint、grouped searchable model picker 和 model-level effort。
- T12 timeline/tool/thinking/streaming/scroll/welcome 及 T24/T26/T27 产品行为保持。
- 上述行为将在 T31 重新挂到 WorkerSlot；不因 transport/topology 替换而重做产品设计或抹除 evidence。

## Active TODO

1. **T28-a**：盘点 singleton host、多 runtime、renderer agent semantics 与 packaging 文件边界。
2. **T28-b**：将实现文件分类为 retain/adapt/replace/delete/migration-only。
3. **T28-c**：单独保护 Codex ASR、legacy readers、evidence 和 provider/model metadata。
4. **T29 plan-ready check**：对照 pi-app WorkerManager/WorkerSlot，确定单 slot RPC、worker entry、stop/dispose 验收。
5. **并行环境欠项**：真账号 queue GUI 复点；高资源主机 packaged preview/PDF/Monaco/local-file smoke。

## Blocked By / risks

- 当前无产品决策阻塞 T28/T29。
- 当前 3.3 GiB 主机不得运行完整 production build 或并行重任务；单文件/小批测试与分阶段构建继续遵守根 `AGENTS.md`。
- Worker pool 默认容量仍待 Q12 收口，但不阻塞单 WorkerSlot。
- T35 删除不得早于 T34 保存必要 source adapters；import 原文件必须保持只读。
- T36 必须证明 GUI/TUI 单写 authority 和 packaged Pi CLI 路径，不能复制同 JSONL takeover。

## Handoff

1. 读 [decision index](./decisions/README.md)、[D14](./decisions/014-pi-only-product-and-conversation-import.md)、[D15](./decisions/015-main-owned-worker-manager.md) 和 [reference repositories](./topics/reference-repositories.md)。
2. 直接检查 `/home/ai/code/pi-app` 的 WorkerManager/WorkerSlot/worker tests；记录 direct/adapted/rejected。
3. T28 只产出文件级 implementation map，不删除代码。
4. T29 先完成一个 slot 的 `newSession → send → stream → stop → dispose`，再扩 pool/history。
5. Cycle 1/2 evidence 和重排前长交接保存在 [history snapshot](./history/2026-08-31-pre-pi-only-realignment/)。
