# Evidence — T29-b utility worker + one Pi AgentSession bootstrap

**Date**：2026-08-31
**Scope**：per-slot utility worker entry、Main spawn/environment factory、serialized correlated worker dispatch、exactly-one Pi AgentSession bootstrap、managed/local agentDir/auth/models、project trust、fail-closed permission bootstrap、explicit dispose ACK。未包含 send/stream/stop terminal contract、WorkerManager pool/remap 或 app-close census；这些仍属于 T29-c/T30。

## Landed files

- `src/shared/types/workerRpc.ts`
  - `worker.bootstrap` payload/result、generation env、boundary guards。
- `src/agent-host/worker.ts`
  - 新 per-slot Electron utilityProcess entry；一个 `PiWorkerRpcServer`，无 singleton supervisor/session registry。
- `src/agent-host/piWorkerRpcServer.ts`
  - generation/requestId correlated dispatch；mutation serialization；duplicate bootstrap idempotency；different second bootstrap rejection；runtime event envelope；dispose ACK 后退出 hook。
- `src/agent-host/piAgentSessionBootstrap.ts`
  - public Pi SDK `createAgentSessionRuntime → createAgentSessionServices → createAgentSessionFromServices`；service-owned model/auth runtime；explicit project trust；permission plugin load verification + Extension UI bind。
- `src/agent-host/piWorkerSession.ts`
  - utility worker lifetime 内 exactly one Pi AgentSession；managed agentDir/sessionFile/model/effort bootstrap result；idempotent disposal。
- `src/main/services/agent-host/PiWorkerProcess.ts`
  - dev/packaged absolute entry resolution；utilityProcess fork；`ELECTRON_RUN_AS_NODE` sanitation；generation + managed/local Pi env。
- `src/main/services/agent-host/createPiWorkerSlot.ts`
  - 单 slot spawn/bootstrap factory；bootstrap failure 不返回半初始化 slot，并执行 lifecycle cleanup。
- `scripts/build-agent-host.mjs`、`scripts/agent-host-build-lib.mjs`
  - 产物加入 `worker.js`；三个过渡期 entry 串行 esbuild；artifact gate 要求 per-slot worker entry。
- focused tests：
  - `src/agent-host/__tests__/piAgentSessionBootstrap.test.ts`
  - `src/agent-host/__tests__/piWorkerSession.test.ts`
  - `src/agent-host/__tests__/piWorkerRpcServer.test.ts`
  - `src/main/services/agent-host/__tests__/PiWorkerProcess.test.ts`
  - `src/main/services/agent-host/__tests__/createPiWorkerSlot.test.ts`
  - `src/shared/types/__tests__/workerRpc.test.ts`
  - `src/main/services/piModelConfig/__tests__/piHostEnv.test.ts`
  - `scripts/__tests__/agent-host-build-lib.test.mjs`

## Contract evidence

1. 一个 worker generation 只构造一个 runtime/session；相同 duplicate bootstrap 返回同一结果，不同 logical session/cwd/model/effort 被 `WORKER_ALREADY_BOOTSTRAPPED` 拒绝。
2. worker 逐个串行处理 mutating RPC；response/error echo request generation/requestId；runtime event 使用 authoritative generation 和 worker-local monotonic sequence。
3. Main 只在收到 typed bootstrap ACK 后返回 `WorkerSlot`；invalid/error ACK 会先走 `worker.dispose`、kill 和 process-exit confirmation。
4. SDK bootstrap 使用公开 API，不 deep-import `dist/core/*`；`runtime.services.modelRuntime` 是 models/auth 的 canonical owner。
5. managed 模式通过 `PI_CODING_AGENT_DIR` 指向 app-owned `pi-agent`；local 模式保留用户自己的 env/default agentDir。模型选择从该目录的 `models.json` 解析，凭据由同一 service 从 `auth.json` 读取，key 不进入 RPC/result/log。
6. `projectTrusted` 由 Main-owned env 决定：managed=`false`、local=`true`；garbled/absent worker env 在新 entry 中 fail toward untrusted。
7. permission bootstrap fail-closed：plugin missing/load failure/UI bind failure 均拒绝 AgentSession；成功前不返回 bootstrap ACK。dispose 清 Extension UI 并等待 Pi runtime disposal 后才 ACK。
8. worker entry/package path 与旧 `PiHostProcess`/`piHost.ts` 分离；T29-b API 不依赖 `ACTIVE_BACKEND`、`AgentWireName` 或 process-global `SessionRegistry`。

## Reference reuse ledger

审计基线：pi-app `c5ad2f4dccb4`（MIT，Copyright 2026 justhil）；pix `da01b3e12d2e`（MIT，Copyright 2026 Num Scope）。

| 分类 | 结论 |
|---|---|
| Direct copy | 无 substantial source/test copy。 |
| Adapted | pi-app 的 utility entry/dispatch table、one runtime/session、service-owned ModelRuntime、pending/session isolation 思路；pix 的 lightweight parentPort entry、spawn env sanitation、runtime factory ordering。全部改为本仓 typed Worker RPC、explicit generation、serialized exactly-once bootstrap、managed trust 与 fail-closed permission。 |
| Rejected / deferred | pi-app second init replaces runtime、worker-side unconstrained concurrent handlers、SDK fallback/deep import、fixed disposal sleeps、WSL transport/pool/remap；pix HostSupervisor/parking、TUI takeover/single-writer/CLI extraction。 |
| License handling | 本切片为独立 typed implementation，未复制 substantial portions，因此未新增 distributed pi-app/pix notice；来源、版本和分类保留在本 evidence。后续若 T30/T32/T36 直接复制 substantial code，仍须加入完整 MIT notice。 |

## Verification

资源门禁：所有测试/构建串行；Vitest 强制 one worker；Agent Host build 使用 `NODE_OPTIONS=--max-old-space-size=1536` 且 entry bundle 改为串行；批次前后检查 RAM/Swap、磁盘和遗留进程。

```text
pnpm exec vitest run \
  src/shared/types/__tests__/workerRpc.test.ts \
  src/agent-host/__tests__/piAgentSessionBootstrap.test.ts \
  src/agent-host/__tests__/piWorkerSession.test.ts \
  src/agent-host/__tests__/piWorkerRpcServer.test.ts \
  src/main/services/agent-host/__tests__/PiWorkerProcess.test.ts \
  src/main/services/agent-host/__tests__/createPiWorkerSlot.test.ts \
  src/main/services/piModelConfig/__tests__/piHostEnv.test.ts \
  --maxWorkers=1 --no-file-parallelism
→ 7 files passed；28 tests passed

pnpm exec vitest run scripts/__tests__/agent-host-build-lib.test.mjs \
  --maxWorkers=1 --no-file-parallelism
→ 1 file passed；88 tests passed

pnpm exec vitest run \
  src/agent-host/__tests__/piRuntimeSessions.test.ts \
  src/agent-host/__tests__/piRuntimeModelSelection.test.ts \
  src/agent-host/__tests__/piRuntimeMessageBoundaries.test.ts \
  --maxWorkers=1 --no-file-parallelism
→ legacy transition source 3 files passed；46 tests passed

pnpm exec vitest run \
  src/main/services/agent-host/__tests__/WorkerSlot.test.ts \
  src/main/services/agent-host/__tests__/WorkerTransport.test.ts \
  src/main/services/agent-host/__tests__/AgentHostManager.test.ts \
  src/main/services/piModelConfig/__tests__/PiModelConfigService.test.ts \
  --maxWorkers=1 --no-file-parallelism
→ T29-a/Main/model-config regressions 4 files passed；65 tests passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm build:agent-host
→ passed；out-agent-host/worker.js present；394.3MB / 413,461,842 B

pnpm smoke:permission-plugin
→ RESULT: PERMISSION GATE INTACT
```

### Real Electron utilityProcess probe

用临时 agentDir/workspace 启动真实 Electron `utilityProcess.fork(out-agent-host/worker.js)`：

- 临时 `models.json`：`probe/probe-model`；
- 临时 `auth.json`：dummy provider credential，0600；
- env：`PI_CODING_AGENT_DIR=<temp>/agent`、project trust=`0`、generation=`1`；
- RPC：`worker.bootstrap(model=probe/probe-model, effort=low)` → `worker.dispose`。

结果：

```text
[pi-worker] permission plugin: bundled
BOOTSTRAP bootstrapped=true
  agentDir=<temp>/agent
  sessionFile=<temp>/agent/sessions/<encoded-cwd>/...jsonl
  model=probe/probe-model
  effort=low
  projectTrusted=false
  permissionGate=bundled
DISPOSE_ACK
EXIT 0
```

临时 probe/config 已删除；最终 process census 无 Electron/worker orphan。

## Remaining T29 gate

- **T29-c**：通过真实 `WorkerSlot` 完成 `newSession → send → text/thinking/tool/custom stream → stop → dispose`，验证唯一 terminal state、session-file remap 输入和 app-close orphan census。
- T30 pool capacity/remap/eviction/restart policy 仍未进入本切片。
