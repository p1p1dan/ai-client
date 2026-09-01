# T34 — Claude legacy conversation import

Role: topic-capsule
Status: accepted / implemented
Phase: E / T34
Authority: [D14](../decisions/014-pi-only-product-and-conversation-import.md)、[D18](../decisions/018-t34-claude-import-semantics.md)、[roadmap](../roadmap.md)
Read when: 启动或复审 T34 `/goal`，实现 importer contract、transaction、IPC/UI 或 cleanup
Related: [T28 replacement map](./t28-replacement-map.md)、[storage baseline](../../../baseline/storage-and-state.md)、[test gates](../../../baseline/test-and-release-gates.md)、[T33 evidence](../evidence/2026-09-01-t33-tree-rewind-fork.md)

## One-screen summary

T34 当前闭环是 **Claude-only、线性主线、独立 Pi root session、不可变快照导入**：

```text
read-only Claude source adapter
→ versioned ImportedConversation
→ projection + display-only unmapped entries
→ same-directory temporary Pi JSONL
→ bounded preflight + Pi native exact-open/history validation
→ atomic publish + complete SessionIndex row + private manifest
→ report → explicit open → continue in Pi
```

现有 legacy Session Manager 改为批量导入页；默认不勾选，导入完成始终停留报告页。Codex 等取得真实磁盘格式证据后作为独立 adapter 落地，不阻塞当前闭环。

## Scope

### In scope

- source-neutral `ImportedConversation` schema/version/validation 与 Claude adapter；
- Claude scan、preview、项目分组、显式批量选择；
- text/thinking projection；Claude v1 tool/custom均按未证明schema-equivalent处理为脱敏display-only projection；
- private import manifest、dedupe/single-flight、immutable snapshot semantics；
- temporary JSONL、Pi native validation、atomic publish、complete index transaction；
- failure injection、crash reconciliation、source immutability evidence；
- import IPC/preload/renderer report/open；删除旧 Resume Claude authority；
- focused tests、两套 typecheck、scoped Biome、worker-only build与真实 Electron import probe。

### Out of scope

- Codex 本地 importer、旧 ai-client index 作为 transcript source；
- legacy branch tree/sidechain 重建、Pi parent/fork 伪装；
- 原 runtime/model/MCP/plugin/permission/cache/hidden state 恢复；
- 原地更新已经导入的 Pi session；
- unmapped tool/custom 进入后续 LLM context 或重新执行；
- 断电级 durability、全量 Vitest、整套 production build。

## Contract

### ImportedConversation minimum

- `schemaVersion`、`sourceKind`、stable source identity、source session ID；
- trusted workspace/cwd 或明确 unavailable diagnostic；
- source hash/size/mode/mtime、原始时间范围、importer version；
- ordered entries：role/text/thinking/tool/custom/attachment diagnostic；
- original entry/message IDs、timestamps 和 per-entry provenance；
- truncation、redaction、unsupported/corrupt diagnostics；
- deterministic validation limits and ID collision handling。

### Source adapter

- 独立 migration namespace；import graph 禁止 runtime/launcher/connection/RPC。
- source filesystem API 只读；不得 rename/move/delete/write/chmod。
- 导入读取必须完整流式处理或明确失败；不能静默沿用现有 32 MiB tail / 1000-message hydration 限制。
- 读取前后计算/复核 source fingerprint；发生变化时该项失败并报告。
- `ClaudeSessionScanner` 与 `historyReader` 适配迁移；重复的 `sessionLogReader` 合并后删除。

### Projection and context

- 一条 source session 生成一个独立 Pi root session；只投影非-sidechain线性主线。
- 可安全映射的历史成为 Pi-native continuation context。
- Claude v1没有已证明与Pi schema-equivalent的tool；tool input/result经敏感键、token与binary redaction后保留为display-only read-only history，unknown custom/attachment raw payload不保留，不得使用会进入context的`custom_message`作为捷径。
- attachments 只有可安全复制且 contract 明确时才进入目标；否则保留脱敏诊断和 provenance。

### Dedupe and manifest

- dedupe key：`sourceKind + stableSourceIdentity + sourceSessionId + contentHash + schemaVersion + importerVersion`。
- 相同 key 返回既有成功结果；同 key 并发 single-flight。
- source 增长/hash 变化创建新不可变 Pi snapshot，不修改旧目标。
- JSONL 仅写脱敏 provenance；绝对 path 仅进 Main-owned private manifest。
- manifest 至少表达 importing/complete/failed 或等价 reconciliation 状态、target session/file/index identity 和 failure cleanup 信息。

### Publish transaction

1. reserve dedupe/import operation；
2. worker 内生成同目标目录 staged JSONL；
3. bounded header/path/cwd/session checks；
4. Pi SDK exact-open + history validation；
5. atomic publish target file；
6. 创建完整 SessionIndex row 与 complete manifest；
7. 仅在 durable authorities 完整后向 renderer 报告成功。

每个阶段必须可注入失败。commit 前失败清理 staged/target/provisional worker/index/manifest；commit 后广播失败不得删除已完成导入。启动时 reconciliation 清理不可发现半成品并保留可解释诊断。

## UI contract

- 复用并改造 `SessionManagerView` / `SessionItem`，删除不再需要的 `ProjectGroup`，不另建 runtime picker。
- scan 结果按项目分组，显示 source、标题、时间、preview、状态/诊断和已导入快照。
- checkbox 多选和项目内全选；默认全部未选择；主操作为 `Import selected`。
- 逐项结果：imported、already imported、failed；成功项提供 `Open`。
- 单条和批量完成都停留报告页，不自动导航。
- 文案只表达“导入历史并在 Pi 中继续”。

## Goal execution order

### G1 — Contract and Claude adapter

- 定义/验证 shared schema、provenance、display-only entry；
- 隔离 scanner/reader 并建立 static import ban；
- 覆盖完整、损坏、超限、大文件、sidechain、unmapped、读取中变化和 source immutability tests。

### G2 — Transaction writer

- 建 manifest、dedupe/single-flight、temporary writer、native validation、publish/index transaction；
- 覆盖每阶段 failure injection、并发、应用/worker crash reconciliation 和无 discoverable partial target。

### G3 — IPC, UI and replacement cleanup

- 接 scan/preview/select/import/report/open；
- 删除旧 Resume Claude contract、重复 reader 和被替代的 legacy authority；
- 做 static absence/import ban、focused regression、真实 import→open→continue→dispose probe。

三个阶段属于同一个 Goal，但必须串行完成；任一阶段 contract 或测试未闭环时不得跳到完成声明。

## Verification gates

- source hash/size/mode/mtime 前后不变；读取中变化明确失败；
- 相同 key 不重复，不同 content hash 生成新 snapshot；
- unmapped tool/custom 可见、不执行、不进入 LLM context；
- 每个 failure point 无可发现半成品、无悬空 index/manifest/worker；
- 成功目标经 Pi native reader 打开，历史正确，继续发送形成新 Pi turn；
- UI 默认未选择、批量报告、不自动打开、成功项显式打开；
- adapter import graph 无 Claude/Codex runtime/launcher/connection；
- 小批串行 Vitest（`--maxWorkers=1 --no-file-parallelism`）、两套 typecheck、scoped Biome、`git diff --check`；
- resource check 后仅运行 worker-only build 和真实 Electron focused probe；不运行 full Vitest/整套 production build。

## Reference disposition

### 本仓

- **适配移植**：旧`ClaudeSessionScanner.ts`与`historyReader.ts`的只读扫描/投影invariant迁入`src/main/services/legacyImport/`；复用`piSessionPreflight.ts`、`SessionIndexService.ts`与T33 staged-file rollback/complete-row transaction。旧Claude reader实现与tests已删除。
- **保留纯映射思路但本轮不接 source**：`codexItemMapper.ts`。
- **合并后删除**：与 scanner 重叠的 `sessionLogReader.ts`。

### pi-app `c5ad2f4dccb4`

- **适配参考**：session file metadata、Pi-native exact-open/history validation、worker append/open 和 failure scenarios。
- **不采用**：Main 直接读 JSONL、SDK private deep import、best-effort SQLite index、fixed sleep 代替 flush/dispose ACK。
- substantial copying 时保留 MIT copyright/license notice。

### pix `da01b3e12d2e`

T34 不采用 pix 实现；其 PTY/TUI、single-writer 和 CLI packaging 只属于 T36。
