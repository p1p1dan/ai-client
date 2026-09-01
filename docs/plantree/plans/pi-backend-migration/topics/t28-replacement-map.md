# T28 — Pi-only 文件级替换与删除边界

Role: topic-capsule
Status: accepted Phase A baseline
Phase: A / T28
Authority: [D14](../decisions/014-pi-only-product-and-conversation-import.md)、[D15](../decisions/015-main-owned-worker-manager.md)、[D16](../decisions/016-delete-obsolete-paths-with-replacement.md)、[roadmap](../roadmap.md)
Read when: 实施 T31、T34、T35、T36，或判断含 Claude/Codex/Agent Host 名称的文件能否删除
Related: [reference repositories](./reference-repositories.md)、[Phase A evidence](../evidence/2026-08-31-phase-a-t28.md)

## 结论

Phase A/T28 已完成文件级 inventory；T29/T30 已按本映射落地 single WorkerSlot → bounded WorkerManager，并删除 singleton/global Agent Host transition boundary。当前实现已进入目标 pool topology：

```text
Renderer → Preload → Electron Main WorkerManager
→ bounded WorkerSlot pool
→ one utilityProcess + one Pi AgentSession per slot
```

T28 本身未删除或修改产品实现代码；T29/T30 的实际 landing 与删除证据见 [T29-c evidence](../evidence/2026-08-31-t29c-single-slot-closure.md) 与 [T30 evidence](../evidence/2026-08-31-t30-worker-manager.md)。后续仍只能按本映射的依赖顺序实施，不能按 `claude`、`codex`、`agent-host` 文件名机械删除。

## 分类词汇

| 分类 | 含义 | 后续动作 |
|---|---|---|
| `retain` | 责任与 Pi-only 目标一致 | 保留；只做必要命名/ownership 补强 |
| `adapt` | 行为或实现有价值，但 transport、identity、owner 或 contract 要变 | 在 T29–T36 对应切片适配 |
| `replace` | 当前 topology/入口/contract 不能留在目标架构 | 替代者在当前切片闭环后立即删除旧文件/consumer/artifact，不等待 T35 |
| `delete` | 无目标 runtime、迁移或产品角色 | 确认无保留 invariant 后尽早删除；T35 只做 absence audit |
| `migration-only` | 仅允许只读 legacy scan/parse/adoption/evidence | T34 隔离；禁止 import execution runtime |

`adapt/delete split` 表示同一文件混合了两种职责；实施前必须先拆文件，不能整文件保留或整文件删除。

## 不变量

1. `AgentHostManager`、`PiHostProcess`、`piHost.ts` 的 singleton/global router 被 **WorkerManager + WorkerSlot + per-slot worker entry** 替代；不新增第二层 supervisor。
2. `piRuntime.ts` 的 Pi AgentSession bootstrap、事件投影、model/effort、attachments、permission 和 Extension UI 行为适配进入单 slot；不保留进程内多 session registry。
3. Claude/Codex conversation SDK、CLI app-server、bridge、agent picker、runtime discriminant 最终删除。
4. Claude/Codex source reader 只进入 T34 read-only adapters；source 永不修改，adapter 不得 import execution modules。
5. Codex ASR 在当前 checkout **没有生产实现**。唯一 realtime method 名称来自测试 fixture，不足以保留 `@openai/codex` execution dependency。
6. Pi model/provider metadata、managed/local credential mode、permission policy、Cycle 1/2 queue/timeline/Extension UI 行为保留并适配。
7. GUI/TUI、one-shot AI、Claude integration 和 packaging 是独立 legacy execution 轴，不能因不在 Composer picker 中就漏出 Pi-only cleanup。
8. 每个 execution 删除批次都必须有静态 import 检查；T34 migration readers 还必须有专门 import ban，证明其不依赖 Claude/Codex runtime/launcher/connection。
9. Git history 是 legacy 恢复路径；活动源码树不保留 runtime fallback、compatibility alias 或 transition artifact。

## 详细文件图

- [Runtime、Main host 与 contracts](./t28-replacement-map/runtime-and-contracts.md)
- [IPC、services、renderer 与 legacy protection](./t28-replacement-map/product-and-services.md)
- [Packaging、tests、spikes 与参考仓复用](./t28-replacement-map/packaging-tests-and-references.md)

以上三个 detail shard 合起来是 T28 的文件级 authority；本 capsule 只维护边界和实施顺序。

## Legacy protection ledger

| 资产 | 分类 | 保护理由 / 替代条件 |
|---|---|---|
| Claude/Codex conversation runtime | `delete` | 按 consumer/行为替代切片分批立即删除；不再集中等待 T35 |
| `historyReader.ts`、`codexHistoryReader.ts`、`codexItemMapper.ts` | `migration-only` | T34 source adapter 候选；只读、无 spawn/RPC |
| `ClaudeSessionScanner.ts` | `migration-only` | Claude scan/preview/dedupe/TSD-safe reader 候选 |
| Codex ASR | not found | 不以 method fixture 推断 feature；若未来存在须另建 owner/IPC/tests |
| Pi provider/model metadata | `adapt` | `piModelConfig`、Pi seed/catalog、model tags/reasoning/effort 保留并接 WorkerSlot |
| Codex/Claude model whitelist/seed | `delete` | 活动 catalog 只走 Pi provider/model metadata |
| Cycle 1/2 product behavior | `adapt` | queue/pending/timeline/Extension UI/permission/model picker 保留并接新 transport |
| Existing tests/evidence | split | Pi/product tests port；legacy execution tests 删除；history fixtures 迁入 importer；docs evidence 保留 |
| Node runtime resolver | `adapt` | conversation Host 不再需要；T36 bundled Pi CLI 仍可能需要 absolute Node |
| Permission plugin/policy/licenses | `adapt` | security gate 与 MIT notices 保留并改到 worker artifact，不可随 legacy Host 删除 |

## Replacement order

```text
T29 worker RPC + single WorkerSlot
  → deleted PiHostProcess/piHost singleton boundaries/artifacts
T30 pool/remap/generation/owner
  → deleted AgentHostManager/global Host lifecycle
T31 Cycle 1/2 behavior reattachment
  → delete each replaced old receive/send/agent/backend branch in the same slice
T32/T33 Pi history/tree
  → delete replaced Host history/resume contracts as they land
T34 isolate read-only adapters
  → delete remaining Claude/Codex execution and protect only migration-only sources
T35 static absence audit, not a deferred deletion bucket
T36 replace terminal/Node/CLI packaging with pix-based Pi TUI
```

## T29 entry contract fixed by Phase A

T29 first slice must provide one slot with:

- request ID correlation and bounded timeout;
- one utilityProcess and one Pi AgentSession;
- `newSession → send → stream → stop → dispose`;
- normalized session-file identity after create;
- generation-aware event filtering and terminal state;
- no `ACTIVE_BACKEND`, no `AgentWireName`, no singleton session registry;
- no fixed sleep as the primary flush/dispose contract;
- no orphan worker after stop/app close.

Pool capacity/identity policy 已由 [D17](../decisions/017-worker-pool-policy.md) 与 T30 evidence 收口。
