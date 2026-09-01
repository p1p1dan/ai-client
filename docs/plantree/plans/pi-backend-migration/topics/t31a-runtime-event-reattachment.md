# T31-a — RuntimeEvent / streaming multi-slot reattachment

Role: implementation inventory
Status: completed as part of T31 closure (2026-09-01)
Phase: C / T31-a
Authority: [roadmap](../roadmap.md)、[D15](../decisions/015-main-owned-worker-manager.md)、[D16](../decisions/016-delete-obsolete-paths-with-replacement.md)、[T28 map](./t28-replacement-map.md)
Read when: 修改 Pi streaming producer、WorkerManager event route、renderer timeline reducer，或判断 legacy event producer 是否可删
Related: [T30 evidence](../evidence/2026-08-31-t30-worker-manager.md)、[timeline reference](./timeline-reference.md)、[reference repositories](./reference-repositories.md)

## Slice boundary

T31-a 只重挂已验收的 text / thinking / tool / generic custom timeline behavior：

```text
Pi AgentSession event
→ PiWorkerSession RuntimeEventDraft
→ PiWorkerRpcServer generation-bound event
→ WorkerSlot current transport
→ WorkerManager authoritative slot/generation/session gate
→ Main chat IPC broadcast
→ Preload narrow bridge
→ renderer RuntimeEvent bus
→ per-session batched reducer
→ MessageTimeline
```

不在本切片实现 T32 history hydration，也不新增 Host、supervisor、process-global session registry 或 singleton compatibility facade。renderer 继续按 logical session bucket 保存后台流；durable `sessionFile` hydration/branch merge 属于 T32。

## File-level inventory

### Producer / worker

| Path | Current role | T31-a action |
|---|---|---|
| `src/agent-host/piWorkerSession.ts` | 一 WorkerSlot 一 Pi AgentSession；投影 text/thinking/tool/terminal | 保留并补齐 cumulative snapshot/delta fallback、generic custom message/entry；producer 仍为 instance-local |
| `src/agent-host/piWorkerRpcServer.ts` | 给 worker event 加 worker-local `seq/timestamp`，封装 generation-bound RPC event | 保留；generation 不下放给 renderer，先由 WorkerSlot/Main 拒绝 stale transport |
| `src/shared/types/runtimeEvents.ts` | Pi SDK 与 Main/renderer 的稳定边界 | 适配 custom timeline event；不加入 worker PID/path 或 legacy runtime discriminant |
| `src/shared/types/workerRpc.ts` | generation-bound transport envelope | 保留；RuntimeEvent payload 不承担 physical worker authority |

### Main / transport

| Path | Current role | T31-a action |
|---|---|---|
| `src/main/services/agent-host/WorkerSlot.ts` | current transport + generation gate、RPC/lifecycle | 保留；focused test 继续证明 stale generation 不进入 Manager |
| `src/main/services/agent-host/WorkerManager.ts` | exact slot/session/generation authority；将各 slot event 重标为 Main-global monotonic sequence | 保留；补 interleaved A/B stream 与 old-generation delta test |
| `src/main/ipc/chat.ts` | WorkerManager event → BrowserWindow；blocking Extension UI 才窄路由 | 保留；普通 timeline stream 仍广播，让每窗口维护自己的 session buckets |
| `src/preload/index.ts` | `chat.onRuntimeEvent` 窄桥 | 保留；不拥有 runtime state |

### Renderer / timeline

| Path | Current role | T31-a action |
|---|---|---|
| `src/renderer/stores/runtimeEventBus.ts` | 一个 preload listener，renderer 内 ref-counted fan-out | 保留；不是 runtime authority |
| `src/renderer/stores/chatSessions.ts` | 16ms batch、按 `sessionId` bucket reduce、retired-session filter | 保留；补 `tool.updated`、generic custom notice、multi-session background accumulation/reattachment tests |
| `src/renderer/components/chat/toolCard.ts` | block-order → text/thinking/tool group | 保留；producer/reducer 必须在 tool/custom boundary 生成独立结构，不能把后续 prose 并回旧 block |
| `src/renderer/components/chat/MessageTimeline.tsx` | user/assistant turn + system/error notice | 保留；generic custom 使用已有 system notice，不新增 modal/TUI renderer |

## Current invariants and observed gaps

1. `PiWorkerSession` 已保证 thinking → prose → tool → prose-after-tool 的 source order，并以 turn token 拒绝 late event。
2. WorkerSlot + WorkerManager 已拒绝旧 generation、错误 slot 和错误 logical session；不同 slot 可同时 active。
3. renderer 已天然保存所有 session bucket，切换 session 不会停止后台 reduce；当前缺少专门的 multi-slot reattachment regression。
4. 当前 assistant partial snapshot 路径在 `message.content=[]` 时会遮住 `text_delta/thinking_delta` fallback；需采用 snapshot-first、delta-fallback 规则。
5. `tool.updated` 已在 contract/producer 存在，但 renderer reducer尚未消费。
6. generic Pi custom message/entry 尚未进入 RuntimeEvent/timeline；T29-c evidence 的“custom”声明需要由本切片补齐并重新验证。
7. RuntimeEvent `seq` 当前由 worker 和 Manager 各自盖章；renderer只看到 Manager-global单调序列。T31-a 不依赖跨重启 seq dedupe，stale physical output 在 Main 前被 generation gate 丢弃。

## Reference disposition

### pi-app `c5ad2f4dccb4`

- **Direct behavior port**：`packages/shared/pi-message-update.ts` 的 partial snapshot first / delta fallback；`packages/shared/stream-merge.ts` 的 growing snapshot suffix 与 stale snapshot no-shrink。
- **Adapted port**：`src/worker/worker-session-events.ts` 的 text/thinking/tool ordering与 `agent_settled` terminal boundary，落入本仓 instance-local `PiWorkerSession` 和 RuntimeEvent vocabulary。
- **Adapted tests**：`worker-session-events.test.ts` repeated delta、growing snapshot、tool boundary；`worker-manager-session-isolation.test.ts` multi-slot isolation场景。
- **Not adopted**：module-level stream globals、pi-app renderer Session Shell/cache whole architecture、任何 global foreground/mainWindow owner。

### pix `da01b3e12d2e`

- **Direct behavior port**：`packages/agent-runtime/src/generic-renderers.ts` 的 `display:false`、serializable generic custom fallback原则；实现按本仓 contract独立改写。
- **Adapted tests**：`live-stream.test.ts` 的 thinking → assistant → tool → assistant ordering和 session-isolated background stream场景。
- **Not adopted**：`HostSupervisor`、parked Host/PTY pool、runtime parking table、GUI/TUI takeover。pix stale-output lesson已经由 WorkerSlot generation + exact transport identity实现。

本切片按行为和测试场景独立实现，不复制 substantial upstream source/test block；若后续近乎逐字复制，需补对应 MIT notice（pi-app Copyright 2026 justhil；pix Copyright 2026 Num Scope）。

## Legacy producer boundary

以下仍在 checkout，但不是活动 Pi producer：

| Path | Classification | Deletion boundary |
|---|---|---|
| `src/agent-host/eventNormalizer.ts` + `coalescingEmitter.ts` | legacy Claude live producer | 与 `claudeRuntime.ts` 混有 T31-b/c/d 行为；不得接回 WorkerManager。各 behavior replacement 闭环后删除，最迟 T31 完成时整体退出 |
| `src/agent-host/codexNormalizer.ts` | legacy Codex live producer | 同上；不得作为 custom/tool fallback |
| `src/agent-host/claudeRuntime.ts` / `codexRuntime.ts` 及 execution transport | legacy execution | D14/D16 delete；T34 只保护独立 read-only readers，不保护 live normalizer/runtime |
| 对应 legacy golden/runtime tests | legacy execution tests | replacement-focused tests落地后随 source删除；history/import fixtures另按 T34保护 |

T31 closure已删除上述live producer/runtime、execution tests/spikes和worker dependencies；没有作为fallback保留。T34仅保留隔离的read-only history readers/item mapper，T36继续保护generic terminal infrastructure。完整landing与验证见 [T31 closure evidence](../evidence/2026-09-01-t31-behavior-reattachment.md)。

## Focused verification matrix

| Layer | Focused test |
|---|---|
| Producer | partial assistant message为空时 fallback delta不丢；growing snapshot只发 suffix；stale snapshot不回退；toolcall delta不进 prose |
| Producer | thinking → prose → tool update/end → generic custom → prose ordering；`display:false` custom不显示 |
| WorkerManager | A/B interleaved stream保持 session隔离和 Main-global order；A old generation late delta被丢弃，B不受影响 |
| Renderer | A/B batch各自写入 bucket；切到 B 再回 A仍见 A完整后台 stream；tool update改 exact `toolCallId`；custom成为有序 system notice |
| IPC | 普通 timeline event广播到窗口并交 SessionIndex；不经过 legacy Host lifecycle IPC |

## Exit criteria

- text/thinking/tool/custom producer focused tests通过；
- multi-slot Manager isolation + stale-generation tests通过；
- renderer per-session background accumulation/reattachment + timeline ordering tests通过；
- Main + Agent Host typecheck、scoped Biome、diff check通过；
- evidence记录实际命令与测试数；
- 无 `AgentHostManager`、`PiHostProcess`、legacy NDJSON entry或第二 supervisor恢复。
