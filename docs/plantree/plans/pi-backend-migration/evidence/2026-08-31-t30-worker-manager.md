# Evidence — T30 Main-owned bounded WorkerManager

**Date**：2026-08-31  
**Role**：evidence  
**Status**：accepted  
**Related**：[T30 roadmap](../roadmap.md#t30--main-owned-bounded-workermanager--done) · [D15](../decisions/015-main-owned-worker-manager.md) · [D16](../decisions/016-delete-obsolete-paths-with-replacement.md)

## Claim verified

T30 bounded WorkerManager 已按 D15/D16 闭环：

- Electron Main 只有一个 `WorkerManager` pool authority；每个 managed entry 对应一个独立 `WorkerSlot`/utilityProcess/Pi AgentSession；
- 新会话以 normalized workspace + logical session + opaque create token 保留唯一 temporary key，bootstrap 后原子 remap 到 normalized `sessionFile` key；`SessionIndexService.bindRuntimeIdentity()` 成功前不发布 `session.created`；持久化失败会移除并 dispose partial slot；
- pool 有界：普通主机默认 4，中等内存 3，≤4 GiB 主机 2；启动时可用 `AICLIENT_PI_WORKER_CAPACITY=1..8` 覆盖；idle TTL 默认 15 分钟；foreground、active turn、pending blocking Extension UI、creating/restarting/disposing slot 不可淘汰；无安全 victim 时返回 retryable `worker_capacity_reached`；
- crash 只影响当前 slot：active turn 只收到一组 disconnected + failed，blocking/display UI 被 cancelled/reset，其他 slot 保持运行；replacement generation 使用 `SessionManager.open(sessionFile)` 重开同一 durable Pi session，旧 generation 回调被 slot object + generation 双重过滤；每 60 秒最多 2 次 restart，耗尽后进入 recoverable error；
- owner routing 以 logical session + `webContents.id` 隔离；每个窗口至多一个 foreground session，不同窗口可各自 foreground；blocking response 只回 originating slot/generation/window；窗口关闭会向该 slot 发送 dismiss response 并清 request route，不终止其他窗口/slot；
- app close 对 pool 并行 `Promise.allSettled` dispose，保留 7 秒全局 deadline 和同步 `forceKillAllNow()`；真实 Electron 双 slot active-turn quit 后两个 utilityProcess PID 均不存在；
- Main consumer 已切到 WorkerManager config invalidation/disposal；`AgentHostManager`、`AgentHostProcess`、`PiSingleSlotRuntime`、`hostEnv.ts`、legacy `src/agent-host/index.ts` NDJSON router、lifecycle IPC/preload API、旧 manager/router tests 与 host-entry probes 已删除；没有 compatibility facade。

## Landed implementation

### Pool / identity / lifecycle

- `src/main/services/agent-host/WorkerManager.ts`
- `src/main/services/agent-host/workerSessionKey.ts`
- `src/main/services/agent-host/WorkerSlot.ts`
- `src/main/services/agent-host/createPiWorkerSlot.ts`
- `src/main/services/agent-host/PiWorkerProcess.ts`
- `src/main/services/chat/SessionIndexService.ts`

`WorkerManager` 用 serialized lifecycle chain 保护 reserve/remap/evict/restart/invalidate/dispose map mutation；send admission/stop 仍是 session-targeted，不把长 prompt 放进 lifecycle chain。`createPiWorkerSlot.onSlotCreated` 在 bootstrap await 前把物理进程交给 Manager；每个 physical slot 保留在 `ownedSlots`，直到 process-exit-confirmed disposal 或成功 force kill，failed disposal/kill 不丢 ownership。

### Same-session restart

- `src/shared/types/workerRpc.ts`
- `src/agent-host/piAgentSessionBootstrap.ts`
- `src/agent-host/piWorkerSession.ts`

`WorkerBootstrapPayload.sessionFile` 只用于 replacement generation 的 identity-preserving reopen。它调用公开 `SessionManager.open(sessionFile, undefined, cwd)`，但不提前实现 T32 history hydration/resume product flow；T32 仍负责 renderer-visible `session.resumed → session.history → idle`、missing/corrupt/cross-cwd diagnostics 与 real user resume。

### IPC / owner / config lifecycle

- `src/main/ipc/chat.ts`
- `src/main/ipc/workerManager.ts`
- `src/main/ipc/index.ts`
- `src/main/ipc/piModels.ts`
- `src/main/ipc/onboarding.ts`
- `src/main/services/auth/AuthStateService.ts`
- `src/main/services/auth/index.ts`
- `src/main/services/onboarding/OnboardingService.ts`
- `src/main/services/piPermissionPolicy/index.ts`

Model sync、login/logout、credential rejection 均经过 `workerManager.invalidateAll()` 的同一 lifecycle barrier；Pi permission bundled resource 改从 neutral `resolveCurrentPiWorkerEntryPath()` 派生，不再借旧 Host entry helper 保活。

### Deleted authority

Deleted production boundaries:

```text
src/main/services/agent-host/AgentHostManager.ts
src/main/services/agent-host/AgentHostProcess.ts
src/main/services/agent-host/PiSingleSlotRuntime.ts
src/main/services/agent-host/hostEnv.ts
src/main/ipc/agentHost.ts
src/agent-host/index.ts
```

同时删除对应 manager/env/single-slot/protocol tests 与直接执行 legacy Host entry 的 obsolete spikes；`src/agent-host/package.json` 不再暴露已删除 host lifecycle/smoke scripts。Worker artifact root 仍只有 `worker.js`、`package.json`、`node_modules/`。

## Q12 / Q13 closure

### Q12 — capacity

- 默认容量不是 wire protocol 常量；由 Main startup policy 决定。
- `totalmem <= 4 GiB → 2`，`<= 8 GiB → 3`，其余 `4`。
- 启动时环境覆盖仅接受 `1..8`；非法值 fail fast。
- 默认 idle TTL 为 15 分钟；capacity pressure 和 TTL 都使用同一个 protected predicate。
- 当前容量没有运行时热改；需要产品设置时另立任务。诊断 snapshot 只暴露 capacity/slot/activity/error counts，不暴露 worker PID/path。

### Q13 — identity/remap

- temporary key = normalized workspace identity + logical session ID + UUID create token；同 workspace concurrent creates 不冲突。
- POSIX 保留大小写；Windows drive/UNC 使用 win32 normalization + case-insensitive identity；workspace/session namespace 分离。
- remap 顺序：reserve temporary authority → bootstrap → validate normalized durable collision → `WorkerSlot.remapSlotKey()` + one map swap → awaited SessionIndex atomic flush → publish `session.created`。
- durable collision 不偷取现有 authority；new partial slot dispose。index commit/remap failure同样 remove + dispose，不留下双 key 或 false success。
- WSL transport 不在当前产品 requirement；未引入 pi-app WSL stdio path。

## Reference repository disposition

### pi-app (`c5ad2f4dccb4`, MIT, Copyright 2026 justhil)

- **Direct concepts/test scenarios**：temporary/durable key namespace、reserve-before-spawn、identity-guarded map delete、oldest safe idle victim、capacity error、session-targeted stop、remap collision、multi-slot isolation、exact Extension UI origin。
- **Adapted implementation**：本仓保留更强的 typed Worker RPC、explicit generation、process-exit-confirmed disposal、sync force kill；pool entry 增加 logical session/window owner/blocking request/config generation/restart budget；remap 加 awaited SessionIndex transaction；crash replacement 用 same-session open。
- **Rejected**：fixed disposal sleeps、inactive 即可淘汰、global foreground/mainWindow/dialog map、WSL stdio、SDK fallback、disabled/unbounded restart、same-cwd durable-slot stealing。

### pix (`da01b3e12d2e`, MIT, Copyright 2026 Num Scope)

- **Adapted concepts**：serialized lifecycle mutation、identity + generation stale filtering、明确 writer/owner transfer、dispose-all process census。
- **Rejected**：HostSupervisor/第二 supervisor、parked PTY pool、over-cap busy policy、GUI/TUI 同 JSONL takeover、PTY kill 替代 worker dispose ACK。

本切片为独立 typed implementation 与场景级适配，没有复制 substantial upstream source/test block，因此未新增 distributed third-party notice。T36 若直接移植 pix substantial code，仍须加入完整 MIT notice。

## Verification

资源门禁：所有 Vitest 使用 one worker/no file parallelism；typecheck/build/probe 串行；Agent Host build 使用 1536 MiB Node heap；未运行 full Vitest 或整套 Electron production build。

```text
pnpm exec vitest run <16 WorkerManager/slot/worker/index/owner/cleanup/legacy-wall files> \
  --maxWorkers=1 --no-file-parallelism
→ 16 files passed; 134 tests passed

pnpm exec vitest run <10 auth/onboarding/model/permission regression files> \
  --maxWorkers=1 --no-file-parallelism
→ 10 files passed; 108 tests passed

pnpm exec vitest run \
  scripts/__tests__/agent-host-build-lib.test.mjs \
  scripts/__tests__/packaging-budget.test.mjs \
  scripts/__tests__/packaging-config.test.mjs \
  --maxWorkers=1 --no-file-parallelism
→ 3 files passed; 42 tests passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

pnpm exec biome check <48 changed source/test/script files>
→ passed; no diagnostics

git diff --check
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm build:agent-host
→ passed; worker-only 92.8 MiB / 97,309,184 B
→ roots: node_modules/, package.json, worker.js

node scripts/run-t30-worker-manager-probe.mjs out-agent-host/worker.js
→ real Electron + real WorkerManager + 2 utility workers + local model endpoint
→ two same-workspace sessions received distinct Pi JSONL identities
→ both active turns streamed under their own logical session
→ app quit disposed both workers; PIDs 12279 and 12319 absent after Electron exit
```

Static absence audit over active `src/`, `scripts/` and `package.json` found no `AgentHostManager`、`AgentHostProcess`、`PiSingleSlotRuntime`、`resolveHostEntryPath`、legacy Agent Host lifecycle IPC channel or `src/agent-host/index.ts` reference. Final process census found no T30 probe/worker/vitest/tsc/esbuild orphan.

## Deferred by roadmap authority

- T31: reattach remaining Cycle 1/2 queue/pending/attachments/Extension UI/model/permission behavior groups to the pool and delete each replaced legacy execution branch.
- T32: renderer-visible Pi real resume/history and robust missing/corrupt/cross-cwd recovery; T30 only opens the exact durable file for an internal replacement generation.
- T35: final Pi-only wording/dependency/import-reader absence audit; T30 removed the global lifecycle authority and executable NDJSON router, not every migration source or historical DTO.
- T37: high-resource packaged GUI matrix and longevity/RAM observation remain release gates.
