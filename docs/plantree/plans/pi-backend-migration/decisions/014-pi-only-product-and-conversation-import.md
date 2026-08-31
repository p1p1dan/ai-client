# D14 — Pi-only 产品范围与 legacy 会话导入

**状态**：已拍板（2026-08-31）

**替代**：[D5 — 屏蔽但保留 Claude/Codex runtime](./005-disable-claude-codex.md)

## 决策

ai-client 作为新的 **Pi-only 应用**继续演进。Claude 和 Codex 不再作为可执行的对话 runtime、可选 backend 或回退路径；多 provider、多模型和不同推理后端统一通过 Pi 提供。

产品保留一项独立的 **legacy conversation import service**：只读扫描本机 Claude/Codex 会话，将可表达的历史复制为新的 Pi session，之后由 Pi 继续对话。该能力不是恢复原 Agent runtime。

## 删除边界

目标删除：

- Claude/Codex 对话 runtime 与 SDK/CLI execution dependencies；
- `activeBackend`/多 runtime dispatch；
- Agent picker、runtime binding、Claude/Codex 会话执行入口；
- “可随时切回 Claude/Codex”的设置、文案和回滚承诺。

在删除前，T28 必须按文件和能力盘点。名称相同不等于同一删除边界：Codex ASR、历史 reader、import source adapter、图标或 provider/model 元数据必须独立分类，不能因包含 `codex`/`claude` 字样被机械删除。

## 导入契约

导入链采用：

```text
read-only source adapter
→ ImportedConversation
→ validate/project
→ temporary Pi JSONL
→ atomic publish
→ provenance/dedupe record
```

必须满足：

1. 原始 Claude/Codex 文件永不 rename、move、delete 或 modify。
2. 失败不得暴露半成品 Pi session；临时文件须清理或保持不可发现。
3. 重复导入同一 source/session/version 必须可检测并避免重复。
4. 新 session 保留 source type、原路径或稳定 source identity、原 session ID、时间范围和 importer version。
5. 无法映射的 tool call/result 保持只读历史，不重新执行。
6. 导入结果通过 Pi 原生 session reader 校验后才进入 session index。
7. importer 必须支持 source adapter 独立演进，不能把 Claude/Codex parser 混入 Pi runtime。

## ImportedConversation 中间层

中间层至少表达：

- source 类型与稳定 identity；
- workspace/cwd（如可可信恢复）；
- message role、文本、thinking；
- tool call/result 与原始名称；
- attachments 或不可导入附件诊断；
- timestamps、原 entry/message IDs；
- provenance 和 importer schema version。

该模型用于隔离“读取旧格式”和“写入 Pi JSONL”，不得成为第二套活动会话 runtime。

## 不承诺恢复

导入不承诺恢复：

- 原系统提示词的完整运行语义；
- MCP、extension 或 plugin 动态状态；
- provider cache、compressed context 或隐藏元数据；
- 临时权限、session allow 或正在运行的 tool；
- 原 Claude/Codex 进程、模型状态或 backend identity。

面向用户的准确表述是：

> 导入历史并在 Pi 中继续，而不是恢复原 Claude/Codex Agent。

## 影响

- [D5](./005-disable-claude-codex.md) 被替代。
- 旧 multi-agent 计划降为历史参考。
- WorkerManager、history/resume、import 完成并验证后，legacy execution paths 才进入实际删除阶段。
- 发布回滚仅是应用版本回滚，不再是产品内切换 legacy runtime。
