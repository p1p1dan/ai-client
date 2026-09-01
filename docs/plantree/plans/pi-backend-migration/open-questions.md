# Open Questions — Pi-only Application Convergence

> 只保留会影响未来实现、尚未解决的问题。D1–D15 的当前状态见 [决策索引](./decisions/README.md)；历史已解决问题见 [重排前快照](./history/2026-08-31-pre-pi-only-realignment/open-questions.md)。

## Q7 — 首次运行空模型标识是否仍可复现

早期 “Use my own setup” 首次发送曾出现 `Cannot read properties of undefined (reading 'startsWith')`，后续真机未复现。D8/T19–T25 已建立本地/受管 catalog 和合法 fallback。

**处理**：低优先级观察项。若再次出现，沿 `getAgentDir()`、空 `models.json`、default model 和 WorkerSlot bootstrap 顺序取证；不得用静默任意模型掩盖。

## Q14 — Legacy import 首版 source 范围

候选来源：Claude Code、Codex、旧 ai-client session index。

**当前建议**：先定义统一 `ImportedConversation` 和 adapter protocol；首版逐一落 source adapter，不要求一次实现全部。选择顺序应以本机真实样本、格式稳定性和用户会话价值决定。

## Q15 — 无法映射的 legacy tool/custom entry 如何展示

选择：

1. generic read-only tool/custom history；
2. 退化为 Markdown 文本；
3. 丢弃并只留诊断。

**当前建议**：优先 generic read-only history，保留原 tool name、input/result 和 provenance；绝不重新执行。只有包含敏感或不可序列化 payload 时才降级为诊断。

## Q16 — Imported Pi session 的 provenance 存储位置

需要决定 provenance 是：

- Pi JSONL custom entries；
- 独立 dedupe/import manifest；
- 两者同时使用。

**当前建议**：两者同时使用。JSONL custom entry 便于 session 自描述；manifest 提供跨版本 dedupe、source hash 和失败恢复。必须避免把绝对 source path 无条件暴露到可分享 transcript。

## Q17 — GUI/TUI mode switch 的 session continuity

D15 已禁止 GUI/TUI 同写同一 session。T36 仍需决定首版是：

- park/dispose GUI slot 后由 TUI open 同一 durable session file；还是
- 启动同 workspace/config 的新 TUI session。

D13 原语义选择后者；有 WorkerManager 和真实 open 后，前者可能安全可行，但必须先证明 flush ACK、单写 authority、crash recovery 和 return-to-GUI reopen。未证明前继续采用较弱的新 TUI session 语义。
