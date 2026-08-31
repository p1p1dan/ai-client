# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase B / T30 Main-owned bounded WorkerManager；T29 single WorkerSlot vertical slice 已完成。

**Next Target**：[T30](./roadmap.md#t30--main-owned-bounded-workermanager--next) workspace temporary key → normalized session-file remap、capacity/eviction、crash/restart、owner isolation，并删除最终 `AgentHostManager`/`AgentHostProcess` global compatibility authority。

**Last Landed**：2026-08-31 T29-c `newSession → send → text/thinking/tool/custom stream → stop → dispose` 单 slot 闭环、唯一 terminal arbiter、Main chat cutover、app-close orphan census、worker-only artifact，以及 singleton Pi source/router/process 删除；见 [evidence](./evidence/2026-08-31-t29c-single-slot-closure.md)。

**Last Verified**：2026-08-31 — T29-c worker/Main/packaging/cleanup focused 14 files / 110 tests；renderer stop/progress/store regressions 5 files / 179 tests；Main + Agent Host typecheck；scoped Biome；worker-only Agent Host build 92.8 MiB；真实 Electron send/stream/stop/dispose + active app-close PID census；packaged worker bootstrap/dispose/exit smoke。低资源主机串行执行，未运行 full Vitest/full Electron production build。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：开发阶段替代即删除；不为过渡兼容保留旧 source/entry/artifact/dependency/alias，Git 是回退机制。
- [T28 map](./topics/t28-replacement-map.md) 是 T30/T34/T35/T36 的文件级删除/保护 authority；按文件名机械删除被禁止。

## T29 landed

- **T29-a**：typed Worker RPC、request correlation/timeout、generation stale filtering、ACK + process-exit-confirmed disposal。
- **T29-b**：per-slot utility worker、serialized dispatch、exactly-one AgentSession、managed/local agentDir/auth/models、project trust 与 fail-closed permission bootstrap。
- **T29-c**：send admission 不阻塞 stop；text/thinking/tool/custom RuntimeEvent；唯一 completed/failed/stopped verdict；Main single-slot routing；normal dispose + sync force kill；真实 app-close 无 orphan。
- Packaging 只构建/验证 `worker.js`；旧 `index.js`、`piHost.js`、Claude/Cometix/Codex payload/scripts/budgets 已退出 artifact。
- 已删除 `piHost.ts`、`piHostCommands.ts`、`piRuntime.ts`、`PiHostProcess.ts` 与旧 Pi tests；`AgentHostManager` 无 singleton Pi branch。

## Active TODO

1. **T30-a**：workspace temporary key → normalized bootstrap `sessionFile` key 原子 remap；明确 duplicate create/session switch authority。
2. **T30-b/c**：bounded capacity、idle eviction、active/pending protection、generation-aware crash/restart budget。
3. **T30-d/e**：multi-window/session isolation 与 app lifecycle；consumer 切完即删除 `AgentHostManager`/`AgentHostProcess`/legacy host env/router/exports。
4. **并行环境欠项**：真账号 queue GUI 复点；高资源主机 packaged preview/PDF/Monaco/local-file smoke（T37 前关闭）。

## Blocked By / risks

- T30 无产品决策 blocker；Q12 pool 默认容量须在 T30 ready-check 内关闭。
- 当前 3.3 GiB 主机继续按根 `AGENTS.md` 小批串行测试，禁止 full build/full Vitest。
- T35 deletion 仍被 T34 read-only adapter isolation 和 T30–T33 replacement 闭环阻塞。
- T36 必须证明 bundled absolute Pi CLI path 与 GUI/TUI single-writer。

## Handoff

1. 先读 [T29-c evidence](./evidence/2026-08-31-t29c-single-slot-closure.md)、[T29-b evidence](./evidence/2026-08-31-t29b-worker-bootstrap.md)、[T29-a evidence](./evidence/2026-08-31-t29a-worker-rpc.md) 与 [D15](./decisions/015-main-owned-worker-manager.md)。
2. T30 直接提升 `PiSingleSlotRuntime`/`createPiWorkerSlot` 为 bounded WorkerManager；保持 send admission、turn terminal arbiter、generation filtering 与 app-close cleanup，不恢复 singleton facade。
3. `bootstrap.sessionFile` 已是 durable identity 输入；T30 负责原子 remap 和 owner/pool policy，T32 才实现 `SessionManager.open(sessionFile)` resume/history。
4. stop 不创建 worker；dispose 不用固定 sleep；signal path 必须保持同步 force kill。每个替代切片继续同步做 import/export/artifact/dependency 删除。
