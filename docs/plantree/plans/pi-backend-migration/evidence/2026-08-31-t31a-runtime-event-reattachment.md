# Evidence — T31-a RuntimeEvent / streaming multi-slot reattachment first slice

**Date**：2026-08-31  
**Role**：evidence  
**Status**：accepted first slice；cleanup closed by [T31 closure evidence](./2026-09-01-t31-behavior-reattachment.md)  
**Related**：[T31 roadmap](../roadmap.md#t31--cycle-12-behavior-reattachment--in-progress) · [inventory](../topics/t31a-runtime-event-reattachment.md) · [T30 evidence](./2026-08-31-t30-worker-manager.md)

## Claim verified

T31-a 的 producer → WorkerManager → renderer timeline first slice 已在 Pi-only pool topology 上落地，没有恢复任何 legacy Host/singleton path：

- `PiWorkerSession` 对 Pi partial assistant message采用 cumulative snapshot first、protocol delta fallback；空 partial不再吞首 token，growing snapshot只发 suffix，stale snapshot不回退，`toolcall_delta` 不会作为 prose；
- 修复了首个 delta 建立 assistant message时 `ensureAssistant()` 清空已累计 snapshot、导致后续 cumulative snapshot重复追加的缺陷；
- tool start明确关闭前一 prose stream，tool/custom boundary后到达的 prose新建 assistant message，保持 thinking → prose → tool → custom → prose source order；
- Pi custom message与 custom session entry通过新的 `custom.message` / `custom.entry` RuntimeEvent投影为 serializable system notice；`display:false` 不进入 timeline，函数/symbol不跨进程执行或序列化；
- renderer开始消费已有 `tool.updated` contract，按 exact `messageId + toolCallId` 更新 tool call且不重排 block；
- renderer batched reducer继续按 logical `sessionId` 保存全部 session bucket；A/B interleaved stream在后台持续累计，切回 A时A的完整stream仍在，B的 thinking/tool/custom/prose顺序不受影响；
- WorkerManager focused test证明来自两个 slot的 interleaved stream保持 session隔离并由Main重新盖全局单调 sequence；A旧 generation的late delta被丢弃，B当前 generation继续转发；
- Main chat IPC、preload和runtime event bus沿用T30单一authority链；未新增 `AgentHostManager`、`PiHostProcess`、legacy NDJSON entry、HostSupervisor或compatibility facade。

## Landed implementation

### Contracts / producer

- `src/shared/types/runtimeEvents.ts`
  - 新增 `CustomMessageEvent`、`CustomEntryEvent`。
- `src/agent-host/piWorkerSession.ts`
  - snapshot/delta normalization与monotonic merge；
  - tool/custom structural boundary；
  - generic custom serializable fallback；
  - first-delta snapshot reset修复。

### Main / renderer

- `src/main/services/agent-host/__tests__/WorkerManager.test.ts`
  - interleaved multi-slot order/isolation；
  - old generation late delta rejection + other-slot continuity。
- `src/renderer/stores/chatSessions.ts`
  - `tool.updated` exact reducer；
  - custom event → ordered system notice。
- `src/renderer/stores/__tests__/chatSessionsBatch.test.ts`
  - A/B background accumulation、switch-back reattachment与thinking/tool/custom/prose结构。

### Inventory / deletion ledger

- `docs/plantree/plans/pi-backend-migration/topics/t31a-runtime-event-reattachment.md`
  - producer → WorkerManager → IPC/preload → renderer/timeline文件图；
  - pi-app/pix direct/adapted/rejected分类；
  - legacy producer删除边界与focused matrix。

## Reference repository disposition

### pi-app `c5ad2f4dccb4`（MIT · Copyright 2026 justhil）

- **Direct behavior port**：partial snapshot first / delta fallback、growing snapshot suffix、stale snapshot no-shrink。
- **Adapted**：`worker-session-events.ts` ordering场景落入本仓instance-local `PiWorkerSession`、typed RuntimeEvent和T30 WorkerManager authority。
- **Rejected**：module-level stream globals、whole Session Shell cache、global foreground/mainWindow owner、fixed sleep。

### pix `da01b3e12d2e`（MIT · Copyright 2026 Num Scope）

- **Direct behavior port**：generic custom message/entry的`display:false`和serializable fallback原则。
- **Adapted**：thinking → assistant → tool → custom/assistant ordering、stale-output场景转为WorkerSlot generation + exact transport test。
- **Rejected**：HostSupervisor、parked Host/PTY pool、runtime parking table和GUI/TUI takeover。

实现与测试围绕本仓contract独立编写，没有复制 substantial upstream source/test block，因此本切片未新增distributed third-party notice。

## Verification

低资源主机门禁：Vitest one worker/no file parallelism；两个typecheck串行、Node heap 1536 MiB；未运行full Vitest、full production build或packaged GUI smoke。

```text
pnpm exec vitest run \
  src/agent-host/__tests__/piWorkerSession.test.ts \
  src/agent-host/__tests__/piWorkerRpcServer.test.ts \
  src/main/services/agent-host/__tests__/WorkerManager.test.ts \
  src/main/services/agent-host/__tests__/WorkerSlot.test.ts \
  src/main/ipc/__tests__/chatPiWorkerRouting.test.ts \
  src/renderer/stores/__tests__/chatSessionsBatch.test.ts \
  src/renderer/stores/__tests__/chatSessionsCore.test.ts \
  src/renderer/stores/__tests__/runtimeEventBus.test.ts \
  src/renderer/components/chat/__tests__/chatTurn.test.ts \
  --maxWorkers=1 --no-file-parallelism
→ 9 files passed; 163 tests passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

pnpm exec biome check <6 changed source/test files>
→ passed; no diagnostics

git diff --check
→ passed
```

批次前后资源检查：约3.3 GiB RAM主机，available约1.8 GiB，根分区约7.1 GiB available；无遗留vite/vitest/tsc/esbuild/builder/agent-host进程。

## Closure note

2026-09-01 T31 closure已完成T31-b/c/d，并删除`eventNormalizer.ts`、`codexNormalizer.ts`及其live runtime/tests/dependencies；本文件继续作为first-slice evidence，最终结论与最新验证数字以 [T31 closure evidence](./2026-09-01-t31-behavior-reattachment.md) 为准。
