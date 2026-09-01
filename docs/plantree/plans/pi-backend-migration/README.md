# Plan — Pi-only Application Convergence

> **状态**：In Progress
>
> **分支**：`feat/pi-primary-backend`
>
> **当前阶段**：Phase E / T34 read-only legacy conversation import。

## 目标

将 ai-client 收敛为 Pi-only 桌面应用：

```text
Renderer → Preload → Electron Main WorkerManager
→ bounded WorkerSlot pool
→ one utilityProcess + one Pi AgentSession per slot
```

Pi 统一承载多 provider、多模型和不同推理后端。Claude/Codex 不再作为可执行对话 runtime；原始会话通过只读、原子、可去重的导入服务复制为新的 Pi session 后继续。

## 已拍板边界

- 产品范围以 [D14](./decisions/014-pi-only-product-and-conversation-import.md) 为准。
- 进程与 ownership 以 [D15](./decisions/015-main-owned-worker-manager.md) 为准。
- legacy 保留时机以 [D16](./decisions/016-delete-obsolete-paths-with-replacement.md) 为准：替代即删除，Git 负责回退，不维护运行时兼容路径。
- Main 持有 WorkerManager；Pi SDK 不直接运行在 Main。
- 每个 WorkerSlot 对应独立 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- Cycle 1/2 已完成行为和证据保留；singleton transport/owner 部分适配或替换，不把真实完成记录改回 Pending。
- legacy source 永不修改；import 不承诺恢复原 runtime 隐藏状态。
- GUI/TUI 不同时写同一个 Pi session file。

## 非目标

- 不为“以后也许回退”保留 legacy runtime、entry、artifact、dependency 或 product switch；需要恢复时使用 Git。
- 不按名称机械删除 migration-only reader、Pi security/product behavior 或 runtime-neutral infrastructure。
- 不重写 React/@coss/ui 设计系统。
- 不复制 pi-app 的私有 SDK deep import、固定 disposal sleep 或无确认 rewind。
- 不复制 pix 的全局 CLI 安装、Ghostty 私有 patch、同 JSONL 双写或第二套 supervisor。

## 参考仓库

| 项目 | 本地路径 / 版本 | 当前角色 |
|---|---|---|
| [pi-app](https://github.com/justhil/pi-app) | `/home/ai/code/pi-app` · `c5ad2f4dccb4` | WorkerManager/WorkerSlot、history/resume、tree/rewind/fork、timeline 与竞态测试 |
| [pix](https://github.com/num-scope/pix) | `/home/ai/code/pix` · `da01b3e12d2e` | Pi TUI/PTY、GUI/TUI exclusivity、stale output、CLI extraction 与 packaging |

两者均为 MIT。substantial copying 必须保留相应 copyright/license notice。每个实现切片须按 [参考仓库规则](./topics/reference-repositories.md) 标记 `direct / adapted / rejected`。

## 当前受影响边界

| 边界 | 方向 |
|---|---|
| `src/main/services/agent-host/` | singleton `PiHostProcess`/多 runtime manager → Main-owned WorkerManager |
| `src/agent-host/` | utility worker entry + Pi AgentSession；删除 Claude/Codex execution runtime |
| `src/shared/types/` | 稳定 RuntimeEvent/RPC contracts；去除 legacy runtime discriminants |
| `src/preload/` | 保持受控 Electron IPC bridge |
| `src/renderer/` | 保留 Cycle 1/2 产品行为，去除 agent/runtime picker 语义 |
| session/index/import services | Pi session file 为 durable identity；新增 legacy read-only import |
| terminal/packaging | 复用本仓 xterm/AgentTerminal，参考 pix 打包 Pi CLI/resources |

## 已完成资产

- **Cycle 1（2026-08-30）**：queue、preview、permission policy/settings 与 lifecycle 收口；见 [执行证据](./evidence/2026-08-30-cycle1-execution.md)。
- **Cycle 2（2026-08-31）**：内联审批、Extension UI capability/display/reset、TUI-only hint、模型分组/搜索和模型级 effort；见 [执行证据](./evidence/2026-08-31-cycle2-execution.md)。
- T12 timeline、工具词汇/diff、thinking/streaming Markdown、expand memory、bottom anchor 和 welcome flow 的证据继续有效。
- 这些行为将在 T31 重新挂到 WorkerSlot，不因 transport 替换而重做产品设计。

## 阅读路径与权威

1. [Plantree root](../../README.md)
2. [Pi-only 重排映射](../../indexes/pi-only-realignment-map.md)
3. [决策索引](./decisions/README.md) → [D14](./decisions/014-pi-only-product-and-conversation-import.md) → [D15](./decisions/015-main-owned-worker-manager.md) → [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)
4. [Roadmap](./roadmap.md) — 唯一活动任务状态/顺序权威
5. [Implementation status](./implementation-status.md) — 当前交接
6. [Architecture capsule](./topics/architecture.md) 与 [reference repositories](./topics/reference-repositories.md)
7. 与当前任务相关的 behavior topic/evidence

## 文件角色

| 文件 | 角色 |
|---|---|
| [roadmap.md](./roadmap.md) | T00–T27 资产影响 + T28–T37 活动任务树 |
| [implementation-status.md](./implementation-status.md) | 当前 phase、Next、blocker、last verified |
| [open-questions.md](./open-questions.md) | 仅保留未解决问题 |
| [decisions/README.md](./decisions/README.md) | Active/Revised/Superseded 决策权威 |
| [topics/architecture.md](./topics/architecture.md) | WorkerManager 边界摘要 |
| [topics/t28-replacement-map.md](./topics/t28-replacement-map.md) | Phase A 文件级 retain/adapt/replace/delete/migration-only authority |
| [topics/reference-repositories.md](./topics/reference-repositories.md) | pi-app/pix 强制复用规则 |
| [topics/extension-ui.md](./topics/extension-ui.md) | Cycle 2 行为契约与 WorkerSlot 适配要求 |
| [topics/timeline-reference.md](./topics/timeline-reference.md) | timeline/history/tree 参考与适配边界 |
| [topics/t33-tree-rewind-fork.md](./topics/t33-tree-rewind-fork.md) | T33 tree/rewind/fork实施契约、参考分类与验证矩阵 |
| [topics/t31a-runtime-event-reattachment.md](./topics/t31a-runtime-event-reattachment.md) | T31-a producer→WorkerManager→renderer文件图、参考分类、focused matrix与legacy cleanup ledger |
| [topics/completion-cycles.md](./topics/completion-cycles.md) | Cycle 1/2 完成历史；旧 Cycle 3–5 已被替代 |
| [history/2026-08-31-pre-pi-only-realignment/](./history/2026-08-31-pre-pi-only-realignment/) | Pi-only 重排前完整计划快照 |

## 当前出口

T28–T33 均已完成；T33 closure 见 [evidence](./evidence/2026-09-01-t33-tree-rewind-fork.md)。当前下一目标为 T34 read-only legacy conversation import；T35/T36 继续服从 T28 保护边界，不恢复旧 host。
