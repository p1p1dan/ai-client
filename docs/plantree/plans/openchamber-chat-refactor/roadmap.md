# Historical Roadmap — OpenChamber Chat Refactor

> **状态**：Completed / preserved baseline。详细 C-xx/T-xx/GUI 批次见 [history](./history/) 和 [重排前快照](./history/2026-08-31-pre-pi-only-realignment/roadmap.md)。

## Completed capability groups

| Group | 结果 | Pi-only classification |
|---|---|---|
| Workspace Shell | 三列 + rail、surface model、responsive layout | **Retain** |
| Timeline/Composer | bubbles、tool/thinking/Markdown、attachments、scroll/action UX | **Retain** |
| Session UI | sidebar rows、rename/archive、session buckets/index UI | **Retain/Adapt** to Pi session identity |
| Queue/pending/retry/stop | user intent、busy lifecycle、visible failure | **Retain/Adapt** to WorkerSlot |
| Files/editor/preview/git | worktree/product surfaces and safety | **Retain** |
| Terminal | node-pty/xterm/AgentTerminal | **Retain/Adapt** for T36 Pi TUI |
| Claude/Codex runtime bridges | permission/question/history/event normalizers | **Replace/Delete** under T28/T35; migration readers may be preserved |
| Packaging/test lessons | Node/runtime/resources/GUI/CI failure evidence | **Adapt** for T36/T37 |

## Residual handling

- GUI/packaged checks that remain meaningful are merged into Pi T37 instead of staying as this plan's active Next.
- Gateway-specific Claude thinking/cache/retry issues are historical and do not block Pi-only implementation.
- Runtime-neutral product ideas require a new plan or explicit promotion; they are not silently active because they appear in an old backlog.
- Detailed visual baselines and accepted screenshots remain evidence; do not delete or redesign without a new decision.

## Current next

None in this plan. Use [Pi roadmap T28–T37](../pi-backend-migration/roadmap.md).
