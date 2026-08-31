# Evidence — T29-a Worker RPC + single WorkerSlot lifecycle

**Date**：2026-08-31
**Scope**：Worker RPC envelope/guards、Electron utilityProcess transport、单 WorkerSlot request correlation/timeout/generation/dispose/crash contract。未包含 utility worker entry、Pi AgentSession bootstrap、WorkerManager pool/remap 或 orphan census。

## Landed files

- `src/shared/types/workerRpc.ts`
  - protocol version；request/response/error/event envelopes；generation；dispose ACK；boundary guards。
- `src/main/services/agent-host/WorkerTransport.ts`
  - utilityProcess direct payload / `{ data }` normalization；message/error/exit/stderr unsubscribe；best-effort kill。
- `src/main/services/agent-host/WorkerSlot.ts`
  - per-slot request IDs、pending map、timeout cleanup、remote error/retryability、generation filtering、crash cleanup、ACK + process-exit-confirmed idempotent dispose、exit-confirmed crashed transport replacement primitive。
- `src/shared/types/__tests__/workerRpc.test.ts`
- `src/main/services/agent-host/__tests__/WorkerTransport.test.ts`
- `src/main/services/agent-host/__tests__/WorkerSlot.test.ts`

现有 singleton `AgentHostManager` / `PiHostProcess` 未在本切片切流；T29-b/T29-c 完成前旧路径继续可运行。

## Contract evidence

Focused tests 覆盖：

1. out-of-order RPC correlation 与唯一 request ID；
2. unknown response 不误结算、malformed/protocol/generation message 丢弃；
3. remote error/retryability、timeout、同步 `postMessage` failure；同步 transport send failure 进入 crash contract 并拒绝全部 pending；
4. dispose 先拒绝既有 pending，再等待 `worker.dispose` ACK，kill 后必须观察 process exit 才进入 `disposed`；exit timeout 进入 `dispose-failed`；
5. crash 一次性拒绝全部 pending，并发出 generation-scoped lifecycle event；error/exit 双信号不重复 crash；
6. replacement 先确认旧 process exit，再递增 generation；replacement 与 dispose/第二次 replacement 串行，退休 transport 的 message/exit 与 stale-generation response 不进入新 generation；
7. crash 后 dispose、重复 dispose 与 kill 均幂等；
8. utilityProcess direct / MessageEvent-like transport shape、stderr/error/exit/unsubscribe、kill boolean/throw normalization。

## Reference reuse ledger

审计基线：pi-app `c5ad2f4dccb4`，MIT，Copyright 2026 justhil。

| 分类 | 结论 |
|---|---|
| Direct copy | 无 substantial source/test copy。 |
| Adapted | `worker-transport.ts` 的 direct/`{data}` normalization；`worker-manager-pool.ts` 的 pending registration-before-send、request correlation、timeout、reject-all-on-exit；object identity stale guard 改为显式 generation；worker dispatch 的 correlated error 思路改为 typed envelope。 |
| Rejected / deferred | WSL transport、loose `Record<string, unknown>` RPC、80/200/250/500ms disposal sleeps、pool/remap/eviction/restart policy、AgentSession bootstrap。 |
| License handling | 本切片为独立 typed reimplementation，未复制 substantial portions，因此未新增 distributed third-party notice；来源与版本在本 evidence 和 reference topic 保留。若 T29-b/T30 后续直接复制 substantial code，仍须加入完整 MIT notice。 |

## Verification

资源门禁：每个重任务前后检查 `free -h`、`df -h . /tmp` 和遗留 `vite/vitest/tsc/esbuild/electron-builder/agent-host` 进程；无遗留重进程，测试串行单 worker。

```text
pnpm exec vitest run \
  src/shared/types/__tests__/workerRpc.test.ts \
  src/main/services/agent-host/__tests__/WorkerSlot.test.ts \
  src/main/services/agent-host/__tests__/WorkerTransport.test.ts \
  --maxWorkers=1 --no-file-parallelism
→ 3 files passed；25 tests passed

pnpm exec vitest run \
  src/main/services/agent-host/__tests__/AgentHostManager.test.ts \
  --maxWorkers=1 --no-file-parallelism
→ 1 file passed；36 tests passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

pnpm exec biome check <T29-a changed code/test files>
→ passed
```

最终 `git diff --check` 与 plantree link/path audit 在同一 landing change 完成。

## Remaining T29 gates

- **T29-b**：实现 utility worker entry、correlated worker-side dispatch/ACK、one Pi AgentSession bootstrap 与 managed agentDir/auth/models/project trust/permission。
- **T29-c**：通过真实单 WorkerSlot 完成 `newSession → send → stream → stop → dispose`，验证 terminal state 与 app-close orphan census。
- T29-a 的 `replaceCrashedTransport` 只提供 generation primitive；restart budget/pool policy 仍属于 T30。
