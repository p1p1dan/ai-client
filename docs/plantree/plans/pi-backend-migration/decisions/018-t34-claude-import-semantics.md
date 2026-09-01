# D18 — T34 Claude 导入范围与产品语义

**状态**：已拍板（2026-09-01）

**补充**：[D14 — Pi-only 产品范围与 legacy 会话导入](./014-pi-only-product-and-conversation-import.md)、[D16 — 替代即删除](./016-delete-obsolete-paths-with-replacement.md)

**相关**：[T34 implementation contract](../topics/t34-legacy-import.md)、[roadmap](../roadmap.md#t34--read-only-legacy-import-service--done)

## 背景

T34 已明确采用只读 source adapter → `ImportedConversation` → temporary Pi JSONL → native validation → atomic publish → provenance/dedupe 的总链路，但首版来源、legacy branch 投影、无法映射的 tool/custom、重复导入和批量 UI 行为仍会改变 schema、writer 与验收边界。

Codex 当前只有历史结果 mapper，没有经过真实本地 rollout 路径、格式和样本验证的磁盘发现/读取闭环。旧 ai-client session index 可以辅助发现和展示，但不能替代 transcript source。

## 决策

### 1. T34 当前闭环范围

- T34 当前实现和验收以 **Claude Code 本地会话**为唯一 transcript source。
- Codex source adapter 延后到取得真实本地 rollout 路径、格式和样本后实施；不得用旧 runtime RPC fixture 伪装成本地 importer 证据。
- 旧 ai-client session index 只允许作为可选 discovery/metadata 辅助，不作为 transcript authority。
- 统一 `ImportedConversation` 与 adapter protocol 必须保持 source-neutral，使后续 Codex adapter 无需改写 Pi writer transaction。

### 2. 历史结构与 continuation

- 一条 Claude legacy session 导入为一个**独立 Pi root session**。
- 首版只投影非-sidechain线性主时间线；不重建 legacy branch tree，不设置 `parentSession`，不伪装为 Pi fork。
- 可安全映射的 user/assistant text、thinking 和受支持历史进入 Pi 原生 session history，使用户能够在导入 leaf 后由 Pi 继续。
- 导入不恢复原 runtime、模型、MCP、plugin、权限、缓存、隐藏状态或进行中的 tool。

### 3. 无法映射的 tool/custom

- 保留原 tool/custom 名称、输入、结果、时间和 provenance，作为 **display-only read-only history**。
- display-only entry 不进入后续 LLM context，不可触发执行、审批或 Extension UI。
- 含敏感、损坏、超限或不可序列化 payload 时降级为脱敏诊断，不把原始 payload 强行转成 Markdown。
- 若 Pi 原生 entry 无法同时满足“可展示且不进上下文”，应扩展本仓 history projection；不得退而使用会进入 context 的 `custom_message`。

### 4. Provenance、dedupe 与源文件增长

- provenance 同时存在于脱敏的 Pi JSONL self-description 和私有 import manifest。
- 绝对 source path 仅进入私有 manifest；可分享 transcript 只保留 source kind、稳定 identity/hash、原 session ID、时间范围和 importer/schema version 等脱敏信息。
- dedupe identity 至少包含：`sourceKind + stableSourceIdentity + sourceSessionId + contentHash + schemaVersion + importerVersion`。
- 相同 identity/hash/version 重复请求返回已有导入结果，不创建重复 session。
- 源文件后续增长导致 content hash 变化时，视为**新不可变快照并创建新 Pi session**；不原地追加或重写旧导入结果。

### 5. UI 行为

- 改造现有 legacy Session Manager 为 `scan → preview → select → import → report → open` 导入页。
- 支持项目内 checkbox 批量选择和全选，但默认不勾选，避免意外批量导入。
- 无论单条或批量导入，完成后都停留在报告页，不自动打开会话；每个成功结果提供明确的“打开”操作。
- 用户文案统一为“导入历史并在 Pi 中继续”，不得出现 Resume Claude、恢复 Claude Agent 或保留原 runtime 的承诺。

### 6. 事务与 durability 口径

- source 文件永不 rename、move、delete 或 modify；读取前后验证 hash、size、mode、mtime，期间变化则该项失败。
- temporary target 经过 bounded preflight、Pi SDK exact-open/history validation 后才能原子 publish，并在完整 SessionIndex row 与 manifest 成功后变为可发现。
- 同一 dedupe identity 必须 single-flight；并发请求不能发布重复 target。
- 保证应用/utilityProcess 崩溃后的启动 reconciliation 和不可发现半成品清理；首版不声明断电级 durable transaction。

## 后果

- T34 可以作为一个 `/goal` 执行，但 Goal 内必须按 contract/adapter、transaction、IPC/UI/cleanup 三个串行阶段推进并逐阶段验证。
- Codex 不再阻塞当前 T34 Claude 闭环，但继续作为独立后续 source adapter；T35 必须保护仍有迁移价值且已静态隔离的 Codex reader/mapper，不能恢复 execution runtime。
- `open-questions.md` 中原 Q14–Q16 已由本决策解决并移除。
