# Plantree — Project Planning Entry

> 本文件是仓库唯一活动规划入口。2026-08-31 前的长注册表已归档到 [history/2026-08-31-pre-pi-only-registry.md](./history/2026-08-31-pre-pi-only-registry.md)；旧 HTML dashboard 已归档到 [history/dashboard-2026-08-06.html](./history/dashboard-2026-08-06.html)，不再作为活动状态来源。

## Current direction

ai-client 正在收敛为 **Pi-only application**：

```text
Renderer → Preload → Electron Main WorkerManager
→ bounded WorkerSlot pool
→ one utilityProcess + one Pi AgentSession per slot
```

- Claude/Codex 不再作为可执行 conversation runtime。
- 原始 Claude/Codex 会话保持只读，通过原子、可去重的 import service 复制为 Pi session。
- Cycle 1/2 已完成产品行为和 evidence 保留；singleton host 和 multi-runtime transport 进入 adapt/replace/delete 路线。
- pi-app 是 WorkerManager/WorkerSlot/history/tree 主参考；pix 是 Pi TUI/PTY/CLI packaging 主参考。

## Resume reading order

1. 本文件。
2. [Baseline](./baseline/README.md)：module/runtime/storage/risk/gates。
3. [Pi-only realignment map](./indexes/pi-only-realignment-map.md)。
4. [Pi-only plan README](./plans/pi-backend-migration/README.md)。
5. [Decision index](./plans/pi-backend-migration/decisions/README.md) → [D14](./plans/pi-backend-migration/decisions/014-pi-only-product-and-conversation-import.md) → [D15](./plans/pi-backend-migration/decisions/015-main-owned-worker-manager.md)。
6. [Roadmap](./plans/pi-backend-migration/roadmap.md) → [Implementation status](./plans/pi-backend-migration/implementation-status.md)。
7. 只读当前任务直接链接的 topic/evidence/history。

## Authority order

1. 本 root registry：计划生命周期与唯一入口。
2. Pi plan README：当前产品范围和阅读路径。
3. Decision index + Active decisions：稳定方向和边界。
4. Pi roadmap：任务 ID、顺序、依赖和状态的唯一权威。
5. Pi implementation status：当前 phase、Next、blocker、last verified。
6. Active topics、baseline、evidence。
7. Historical/superseded plans、`docs/plans/` legacy sources 和 history snapshots。

旧文档中的 active wording 在被标记为 Historical/Superseded 后不覆盖以上权威。

## Plan registry

| Plan | Lifecycle | Current phase | Last landed | Next target |
|---|---|---|---|---|
| [Pi-only application convergence](./plans/pi-backend-migration/README.md) | **In Progress** | Phase F / T35 Pi-only absence audit | T34 Claude legacy import closure | T35 final absence audit |
| [Entry and environment](./plans/entry-and-environment/README.md) | Maintenance | 主体完成；只剩 Pi-only 可复用错误面/GUI 复验 | two-entry welcome、spawn gate、git notice、settings ownership | 并入 T37 或另立小维护任务 |
| [Unified credentials/app state](./plans/unified-credentials/README.md) | Completed foundation | No active work | `~/.pilab/<profile>`、vault、credential mode、Pi arm | Pi config/import/removal 由 active plan 接管 |
| [OpenChamber product baseline](./plans/openchamber-chat-refactor/README.md) | Completed baseline | No active work | shell/timeline/Composer/files/git/terminal 产品资产 | runtime-neutral assets 由 T31/T36 适配 |
| [Claude + Codex multi-agent](./plans/multi-agent/README.md) | **Superseded / Historical** | No active work | ACP/Codex runtime、protocol、packaging 历史证据 | T28/T34/T35 按需引用，不恢复 execution roadmap |

## Current active task tree

活动任务只看 [Pi roadmap T28–T37](./plans/pi-backend-migration/roadmap.md)：

```text
T28 replacement baseline
→ T29 single WorkerSlot
→ T30 bounded WorkerManager
→ T31 reattach Cycle 1/2 behavior
→ T32 history/resume
→ T33 tree/rewind/fork
├→ T34 legacy import → T35 remove legacy execution
└→ T36 pix-based Pi TUI
→ T37 release candidate
```

当前下一目标是 **T35 Pi-only absence audit**。T34 已完成Claude-only只读导入、原子发布、dedupe/provenance、批量报告与Pi continuation闭环；Codex等待真实本地格式证据，不恢复legacy execution runtime。

## Stable evidence and history

- [Cycle 1 evidence](./plans/pi-backend-migration/evidence/2026-08-30-cycle1-execution.md)
- [Cycle 2 evidence](./plans/pi-backend-migration/evidence/2026-08-31-cycle2-execution.md)
- [Cycle 2 screenshots](./plans/pi-backend-migration/evidence/cycle2-screenshots/)
- [T30 WorkerManager evidence](./plans/pi-backend-migration/evidence/2026-08-31-t30-worker-manager.md)
- [T31-a streaming reattachment evidence](./plans/pi-backend-migration/evidence/2026-08-31-t31a-runtime-event-reattachment.md)
- [T31 behavior reattachment closure](./plans/pi-backend-migration/evidence/2026-09-01-t31-behavior-reattachment.md)
- [T32 history and real resume closure](./plans/pi-backend-migration/evidence/2026-09-01-t32-history-real-resume.md)
- [T33 tree, rewind and fork closure](./plans/pi-backend-migration/evidence/2026-09-01-t33-tree-rewind-fork.md)
- [T34 Claude legacy import closure](./plans/pi-backend-migration/evidence/2026-09-01-t34-legacy-import.md)
- [Pre-Pi-only Pi plan snapshot](./plans/pi-backend-migration/history/2026-08-31-pre-pi-only-realignment/)
- [Pre-Pi-only baseline snapshot](./history/2026-08-31-pre-pi-only-baseline/)
- [Pre-Pi-only root registry](./history/2026-08-31-pre-pi-only-registry.md)

History/evidence 保留事实和推理，但不维护新的 Active TODO。

## Legacy planning roots

`docs/plans/` 保存旧 ARD、执行计划、台账、spike、GUI 清单和 incident records。它们不批量迁移或删除；需要时由当前 plan/evidence 精确链接。旧 OpenChamber/Claude/Codex authority 不能覆盖 Pi-only D14/D15 和当前 roadmap。

## Maintenance rules

- 一个事实只保留一个当前权威；不要在 status/topic/history 复制第二份任务状态。
- `roadmap.md` 拥有活动 task ID/status/order；`implementation-status.md` 最多五项 Active TODO。
- 重大重排先更新 [realignment map](./indexes/pi-only-realignment-map.md)。
- 决策 append-only：被替代时保留原理由并从 [decision index](./plans/pi-backend-migration/decisions/README.md) 指向替代者。
- Evidence 记录实际命令、日期和环境；不能沿抄旧“全绿”数字。
- 旧计划优先降权/归档，不删除推理链；实现代码删除必须经过 T28 map。
- 低承诺想法进入 [ideas/inbox.md](./ideas/inbox.md)，成熟后再 promote。
