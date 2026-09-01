# Evidence — T31 Cycle 1/2 behavior reattachment closure

**Date**：2026-09-01  
**Role**：evidence  
**Status**：accepted / T31 Done  
**Related**：[roadmap](../roadmap.md#t31--cycle-12-behavior-reattachment--done) · [T31-a inventory](../topics/t31a-runtime-event-reattachment.md) · [T30 evidence](./2026-08-31-t30-worker-manager.md)

## Claim verified

T31 已在 Pi-only WorkerManager topology 上闭环：

```text
Renderer → preload → Electron Main WorkerManager
→ bounded WorkerSlot → one utilityProcess/Pi AgentSession per slot
```

Cycle 1/2 的 streaming、queue/pending/attachments、Extension UI、models/auth/trust/permissions 与 retirement behavior 已重挂到该路径；对应 Claude/Codex live execution producer、runtime branch、picker、legacy permission/question channel、multi-agent catalog和依赖已删除，没有 compatibility facade 或 singleton fallback。

## T31-a — RuntimeEvent / streaming

- Pi partial assistant message采用snapshot-first / delta-fallback；空partial不吞首token，growing snapshot只发suffix，stale snapshot不回退，toolcall delta不进入prose。
- thinking → prose → tool/update/end → custom → prose保持source order；tool/custom boundary后prose开启新assistant message。
- 新增serializable、depth/size-bounded `custom.message` / `custom.entry`；`display:false`不进入timeline，不执行renderer/TUI factory或`toJSON`。
- WorkerManager重新盖Main-global单调sequence；A/B interleaved stream保持session isolation；旧generation late delta丢弃且其他slot连续。
- Renderer按logical session bucket批量reduce；后台session持续累计，switch-back不丢stream；`tool.updated`按exact message/tool call更新。

## T31-b — Queue / pending / attachments / stop / retirement

- renderer为每次发送创建opaque `attemptId`，经Main、WorkerManager、Worker RPC原样进入`PiWorkerSession`。
- authoritative Pi user echo携带exact `attemptId`与attachment metadata；不回传attachment bytes，不再FIFO猜测相同文本属于哪个pending turn。
- user echo使用原始renderer prompt，而不是Pi内部为text attachments扩展后的SDK prompt。
- mixed/attachment-only turn、busy retry、Stop前后admission、pending authoritative replacement继续使用Cycle 1事务语义。
- `WorkerManager.createSession()`对已有ready slot执行reattach handshake，不close/sleep/recreate authoritative slot。
- Archive/Close先tombstone并同步prune queue、pending、turn ownership、Extension UI/display/runtime facts，再等待Main slot close；late event不能复活隐藏bucket。
- queue仍为per-session memory-only FIFO；自动release只驱动active session，后台slot settle不越权发送另一个session的queue。

## T31-c — Extension UI

- 每WorkerSlot保留一个portable bridge；blocking request由logical session + slot object + generation + runtimeId + uiRequestId + owner window精确路由。
- A/B dialog隔离、wrong-window拒绝、owner close dismiss、late response拒绝均有focused tests。
- Stop只cancel blocking request并保留display；crash/restart/config invalidation/eviction/close发cancel + `extensionUi.reset`，新generation不继承status/widget/unsupported。
- display event不进入blocking map；inline approval、session-local FIFO、后台badge、ACK后关闭、失败原位重试、text-only bounded widget保持Cycle 2行为。
- 四种permission选择及“No, provide reason”仍通过真实Extension UI response原字符串回bridge；未恢复`permission.respond`或question bridge。

## T31-d — Models / auth / trust / permissions

- model catalog IPC收敛为`chat:listPiModels`，request/response无agent axis；Main只读managed/local Pi config，不走Claude/Codex gateway/family whitelist/seed。
- renderer使用single Pi catalog cache；Automatic、unverified current selection、first-tag grouping、secondary-tag search、Other models和model-level effort reconciliation保留。
- session model/effort preference收敛为one scalar per session；可只读迁移legacy nested row，下一次写入变为Pi-only scalar。
- Composer删除agent picker和legacy permission tier control；只发送Pi model/effort/attachments。
- startup runtime gate改为`PI_RUNTIME_CHECK` / `PiRuntimeChecker`，只检查bundled worker entry；删除Claude runtime IPC/preload/checker。
- login/logout/credential rejection/model sync仍通过`workerManager.invalidateAll()`；managed/local agentDir和project trust由现有Pi worker env/bootstrap tests验证。
- fail-closed permission plugin、bundled policy resolver与permission activity timeline保持。

## Deleted replacement branches

### Utility worker source/tests

删除live Claude/Codex execution modules，包括：

```text
claudeRuntime / claudeSettings / eventNormalizer / coalescingEmitter
codexRuntime / codexConnection / codexNormalizer / codexWire
codex pending/decision/question/status/settings/config/launcher modules
permissionBridge / questionBridge / sessionRegistry / cometix / pin / ttftWatchdog
```

并删除对应execution tests与obsolete spikes。保留项仅为：

- Pi worker/bootstrap/RPC/Extension UI/permission implementation；
- T34 migration-only `historyReader.ts`、`codexHistoryReader.ts`、`codexItemMapper.ts`及fixtures/tests；
- runtime-neutral redaction/subagent projection。

### Renderer/Main/contracts/dependencies

- 删除Composer agent picker、legacy permission trigger、pending legacy question dock及其tests。
- 删除multi-agent catalog service、family whitelist、Claude/Codex seed table、legacy permission tier/template UI。
- 删除`CHAT_UPDATE_PERMISSION`、`CHAT_RESPOND_PERMISSION`、`CHAT_RESPOND_QUESTION`、`CHAT_LIST_AGENT_MODELS`；保留portable Extension UI和Pi-only catalog channel。
- utility worker manifest移除Anthropic SDK、Cometix和Codex dependencies；root移除`@agentclientprotocol/sdk`。
- build artifact仍只有`worker.js`、`package.json`、`node_modules/`，无legacy package/path。

T32 history/resume、T34 import readers、T36 generic terminal/Pi TUI边界未被机械删除，符合T28 map。

## Reference disposition

### pi-app `c5ad2f4dccb4`（MIT · Copyright 2026 justhil）

- **Direct behavior/scenario**：snapshot/delta normalization、settled terminal boundary、session-targeted queue/stop、multi-slot isolation、exact Extension UI origin。
- **Adapted**：本仓typed RPC、explicit generation、SessionIndex transaction、renderer queue/pending/attachment identity、multi-window owner和retirement tombstone。
- **Rejected**：module-global stream state、global foreground/dialog authority、fixed disposal sleep、SDK fallback、background dialog cancellation策略。

### pix `da01b3e12d2e`（MIT · Copyright 2026 Num Scope）

- **Direct behavior/scenario**：generic custom serializable fallback、`display:false`、stale-runtime response与ordered live stream。
- **Adapted**：stale output转为WorkerSlot exact transport + generation；portable UI bridge保留本仓owner/reset/display约束。
- **Rejected**：HostSupervisor、parked Host/PTY pool、single mounted-session state、GUI/TUI takeover与双写。

本轮按行为和场景独立实现，没有复制substantial upstream source/test block；无需新增distributed notice。

## Verification

所有Vitest均`--maxWorkers=1 --no-file-parallelism`串行执行；未运行full Vitest或整套production build。

```text
Worker / Manager / contract batch
→ 12 files passed; 173 tests passed

Main / auth / config / runtime gate batch
→ 12 files passed; 135 tests passed

Renderer queue / timeline / Extension UI / model batch
→ 35 files passed; 769 tests passed

Migration-reader / permission packaged-source batch
→ 7 files passed; 131 tests passed

Packaging / cleanup batch
→ 4 files passed; 44 tests passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

pnpm exec biome check <72 changed source/test/script files>
→ passed; no diagnostics

git diff --check
→ passed
```

### Worker artifact and real Electron probe

```text
NODE_OPTIONS=--max-old-space-size=1536 pnpm build:agent-host
→ passed; 92.8 MiB / 97,314,301 B
→ roots: node_modules/, package.json, worker.js
→ no Anthropic SDK / Cometix / Codex / ACP package

node scripts/run-t30-worker-manager-probe.mjs out-agent-host/worker.js
→ ok=true
→ two distinct Pi session files
→ streamedSessions=[probe-a, probe-b]
→ utility worker PIDs absent after exit
```

### Dev GUI smoke

```text
AICLIENT_SKIP_AUTH_GATE=1 \
AICLIENT_NODE24_PATH=$PWD/out-node-runtime/node \
node scripts/dev.js --disable-gpu --remote-debugging-port=9222 --open-path=$PWD
```

- Main和Preload development build成功；renderer dev server启动；Electron窗口`did-finish-load`显示；CDP endpoint就绪。
- 运行窗口内未见`TypeError`、`ReferenceError`、missing IPC method或module-load failure。
- timeout teardown后出现当前Linux GPU/zygote shutdown noise；进程census确认无Electron/Vite/esbuild/worker遗留。

## Deferred by roadmap authority

- **T32**：真实`SessionManager.open(sessionFile)` resume/history、missing/corrupt/cross-cwd和hydration races。
- **T34**：把保留的legacy readers移入独立import namespace，完成atomic read-only import/provenance/dedupe。
- **T36**：generic terminal/Node runtime resolver收敛为bundled Pi TUI和single-writer mode switch。
- Cycle 1真账号queue GUI复点与高资源packaged preview/PDF/Monaco smoke仍在T37 release gates关闭，不改变T31自动与dev smoke结论。
