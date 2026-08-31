# Evidence — T29-c single-slot send/stream/stop/dispose closure

**Date**：2026-08-31
**Role**：evidence
**Status**：accepted
**Related**：[T29 roadmap](../roadmap.md#t29--single-workerslot-vertical-slice--done) · [D15](../decisions/015-main-owned-worker-manager.md) · [D16](../decisions/016-delete-obsolete-paths-with-replacement.md)

## Claim verified

T29 single WorkerSlot vertical slice is closed end to end:

- Main chat create/send/stop/close and Extension UI response route through one `PiSingleSlotRuntime` / `WorkerSlot`, not `PiHostProcess`;
- worker send is admission-style, so a held prompt does not block `worker.stop` on the serialized RPC dispatcher;
- text/thinking/tool/custom events retain product `requestId` and stream as `RuntimeEvent`;
- each admitted turn emits exactly one terminal verdict; user stop emits `session.stopped` followed by idle, never failed + stopped;
- app shutdown has awaited dispose plus synchronous force-kill ownership, and a real Electron active-turn close probe leaves no worker PID;
- worker packaging contains only `worker.js`; singleton `piHost.js`, legacy `index.js`, Claude/Cometix/Codex execution payload and Codex packaging scripts/budgets are absent; legacy execution packages are dev-only for still-isolated source tests and omitted by packaging `npm ci`;
- singleton Pi source/router/process and transition-only tests are deleted without a compatibility facade.

## Landed implementation

### Worker protocol/runtime

- `src/shared/types/workerRpc.ts`
- `src/agent-host/piWorkerSession.ts`
- `src/agent-host/piWorkerRpcServer.ts`
- `src/agent-host/piAgentSessionBootstrap.ts`
- `src/agent-host/worker.ts`

The transport RPC `requestId` remains distinct from the product turn `requestId`. `PiWorkerSession.startSend()` completes admission/setup and starts `prompt()` out of band; `stop()` drains Extension UI, clears queue, aborts helper work, awaits `AgentSession.abort()`, and uses one terminal arbiter.

### Main ownership/routing

- `src/main/services/agent-host/PiSingleSlotRuntime.ts`
- `src/main/services/agent-host/WorkerSlot.ts`
- `src/main/ipc/chat.ts`
- `src/main/ipc/agentHost.ts`
- `src/main/ipc/index.ts`

`CHAT_CREATE_SESSION` records Pi ownership and creates one slot; bootstrap `sessionFile` is immediately emitted as `runtimeIdentity`. `CHAT_STOP` never creates a worker. `WorkerSlot.forceKillNow()` is the signal-path fallback; normal app cleanup starts slot disposal inside the global async deadline. The 7s cleanup budget exceeds WorkerSlot's 3s dispose-ACK + 3s exit-confirmation budget and invokes synchronous worker force-kill before Main's outer 8s force-exit timer.

### Packaging deletion

- worker-only build/verify: `scripts/build-agent-host.mjs`, `scripts/agent-host-build-lib.mjs`, `scripts/afterPack.mjs`, `scripts/verify-packaged-app.mjs`
- worker-only budget: `scripts/packaging-budget.mjs`
- probes: `scripts/packaged-worker-smoke.cjs`, `scripts/run-t29c-worker-probe.mjs`, `scripts/probes/t29c-worker-probe.ts`
- deleted: `scripts/codex-platform.mjs`, `scripts/codex-smoke-lib.mjs`, `scripts/inspect-codex-payload.mjs` and their tests

Rebuilt `out-agent-host/` roots:

```text
node_modules/
package.json
worker.js
```

Measured artifact: `97,308,897 B` logical file bytes (`92.8 MiB`; `du -sh` 125 MiB). Obsolete payload census returned no `@anthropic-ai/claude-agent-sdk`, `@cometix/claude-code`, `@openai/codex`, or `node-pty` path.

### Singleton Pi deletion

Deleted:

- `src/agent-host/piHost.ts`
- `src/agent-host/piHostCommands.ts`
- `src/agent-host/piRuntime.ts`
- `src/main/services/agent-host/PiHostProcess.ts`
- old Pi runtime/host command tests

`AgentHostManager` no longer imports, starts, or resolves the singleton Pi path. `resolveManagedPiHostEnv` is deleted. `SessionRegistry` remains only because the still-isolated Claude/Codex legacy source uses it; no Pi worker import reaches it.

## Reference repository disposition

### pi-app (`c5ad2f4dccb4`)

- **Direct concept**：`WorkerManager.abort(sessionFile)` — stop targets an existing slot and never creates one solely to abort.
- **Adapted**：`worker-handlers-turn.ts` prompt admission ACK before long prompt completion; adapted to typed Worker RPC and AiClient `RuntimeEvent`.
- **Adapted**：`worker-session-events.ts` pending terminal error + `agent_settled`; adapted to exactly one of `session.completed/failed/stopped` plus idle.
- **Rejected**：fixed disposal sleeps, SDK fallback switching, WSL transport, pool/eviction policy in T29-c.

### pix (`da01b3e12d2e`)

- **Direct concept**：live handle/generation identity and `disposeAll()` quit ownership.
- **Adapted**：stale-output/process census scenarios to WorkerSlot generation + utilityProcess PID checks.
- **Rejected**：parked PTY pool, PTY kill as a substitute for worker abort/dispose ACK, GUI/TUI dual writing.

No substantial source block was copied; no additional MIT notice was required for this slice.

## Verification

Low-resource host rules were followed: heavy work ran serially with `NODE_OPTIONS=--max-old-space-size=1536`; Vitest used one worker and no file parallelism; no full production build or full Vitest run was attempted.

```text
pnpm exec vitest run <14 focused worker/main/packaging/cleanup files> \
  --maxWorkers=1 --no-file-parallelism
→ 14 files passed; 110 tests passed

pnpm exec vitest run \
  composerStopStatic.test.ts assistantProgress.test.ts \
  chatSessionsCore.test.ts runtimeEventBus.test.ts chatSessionsRespond.test.ts \
  --maxWorkers=1 --no-file-parallelism
→ 5 files passed; 179 tests passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

pnpm exec biome check <49 changed implementation/test/script files>
→ passed; no fixes required

NODE_OPTIONS=--max-old-space-size=1536 pnpm lint
→ repository-wide scan reached 1,112 files but remains red on the pre-existing
  `docs/plans/2026-08-27-entry-design/logo-concepts-preview.html`
  `noInnerDeclarations` error (plus existing warnings/infos); no T29-c file diagnostic

temporary clean `npm ci --omit=dev --omit=optional --ignore-scripts`
→ 134 production packages / 165 MiB install; no Anthropic Agent SDK, Cometix, or Codex path

NODE_OPTIONS=--max-old-space-size=1536 pnpm build:agent-host
→ passed; worker-only 92.8 MiB / 97,308,897 B

node scripts/run-t29c-worker-probe.mjs out-agent-host/worker.js
→ real Electron + real WorkerSlot + local model endpoint
→ send admitted; message.delta streamed; stop terminal=session.stopped
→ app-close during second active turn; both utility worker PIDs absent after Electron exit

./node_modules/electron/dist/electron --no-sandbox \
  scripts/packaged-worker-smoke.cjs "$PWD/out-agent-host/worker.js"
→ bootstrap/dispose/exit 0; worker PID absent
```

Static absence audit found no active source/script reference to `PiHostProcess`, `resolveManagedPiHostEnv`, singleton Pi imports, or `agent-host/piHost.js|ts`. Cleanup wiring tests proved awaited normal disposal, synchronous force-kill, and the 7s < 8s production deadline relation. Final process census found no probe/worker orphan.

## Deferred by roadmap authority

- T30: bounded pool, workspace-key → normalized session-file remap, capacity/eviction/restart and final global `AgentHostManager` removal.
- T31: reattach the remaining Cycle 1/2 product groups and remove their legacy execution branches.
- T32: real `SessionManager.open(sessionFile)` resume/history. T29-c refuses resume rather than reviving singleton Pi.
