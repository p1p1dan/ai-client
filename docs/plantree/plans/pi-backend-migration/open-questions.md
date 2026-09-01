# Open Questions — Pi-only Application Convergence

> 只保留会影响未来实现、尚未解决的问题。D1–D18 的当前状态见 [决策索引](./decisions/README.md)；历史已解决问题见 [重排前快照](./history/2026-08-31-pre-pi-only-realignment/open-questions.md)。

## Q7 — 首次运行空模型标识是否仍可复现

早期 “Use my own setup” 首次发送曾出现 `Cannot read properties of undefined (reading 'startsWith')`，后续真机未复现。D8/T19–T25 已建立本地/受管 catalog 和合法 fallback。

**处理**：低优先级观察项。若再次出现，沿 `getAgentDir()`、空 `models.json`、default model 和 WorkerSlot bootstrap 顺序取证；不得用静默任意模型掩盖。

## Q17 — GUI/TUI mode switch 的 session continuity

D15 已禁止 GUI/TUI 同写同一 session。T36 仍需决定首版是：

- park/dispose GUI slot 后由 TUI open 同一 durable session file；还是
- 启动同 workspace/config 的新 TUI session。

D13 原语义选择后者；有 WorkerManager 和真实 open 后，前者可能安全可行，但必须先证明 flush ACK、单写 authority、crash recovery 和 return-to-GUI reopen。未证明前继续采用较弱的新 TUI session 语义。
