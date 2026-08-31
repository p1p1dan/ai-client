# Pi-only Plantree 重排映射

> **状态**：Completed migration index / ongoing authority map
>
> **建立日期**：2026-08-31
>
> **目标**：在不抹除历史证据的前提下，将计划树从“多 runtime + 单例 Pi Host”重排为“Pi-only + Main-owned WorkerManager”。

## 1. 权威顺序

1. [`../README.md`](../README.md) — Plantree 唯一入口与计划生命周期。
2. [`../plans/pi-backend-migration/README.md`](../plans/pi-backend-migration/README.md) — Pi-only convergence 范围与阅读路径。
3. [`../plans/pi-backend-migration/decisions/README.md`](../plans/pi-backend-migration/decisions/README.md) — 当前有效、修订和被替代决策。
4. [`../plans/pi-backend-migration/roadmap.md`](../plans/pi-backend-migration/roadmap.md) — 唯一活动任务身份、顺序和状态权威。
5. [`../plans/pi-backend-migration/implementation-status.md`](../plans/pi-backend-migration/implementation-status.md) — 当前阶段、下一目标和交接。
6. Active topics → evidence → history。

旧文件保留原始事实，但标记为 `Superseded`、`Historical` 或 `Preserved evidence` 后，不再覆盖以上权威。

## 2. 分类定义

| 分类 | 含义 | 默认动作 |
|---|---|---|
| Active authority | 当前方向或状态权威 | 保持精简并从入口可达 |
| Rewrite | 文件角色正确，但当前内容与 Pi-only 方向冲突 | 原路径重写，历史理由另存或保留链接 |
| Revised | 部分结论仍有效 | 保留原文，增加修订边界 |
| Superseded | 被新决策或新计划替代 | 保留历史，顶部指向替代权威 |
| Historical | 不再驱动实施，但有背景价值 | 降权或归档 |
| Preserved evidence | 已落地/已验证事实 | 原样保留并由活动文档链接 |
| Archived copy | 重写前的完整快照 | 移入 `history/`，只读 |

## 3. Root 与 baseline 映射

| Path | 当前问题 | 新分类 | 批次动作 | 新权威/备注 |
|---|---|---|---|---|
| `docs/plantree/README.md` | 混入旧 Codex/multi-agent 活动状态且过长 | Rewrite | 先归档完整快照，再重写为短注册表 | 本文件 + Pi plan README |
| `docs/plantree/dashboard.html` | 将 Codex S-series 作为当前任务 | Historical | 移至 `history/dashboard-2026-08-06.html`，退出活动导航 | 根 README |
| `baseline/README.md` | 未声明 Pi-only/WorkerManager 当前基线 | Rewrite | 更新阅读路径和权威边界 | D14、D15 |
| `baseline/module-map.md` | standalone Node/Claude Host、Claude JSONL 仍被写成当前模块 | Rewrite | 改为 Main WorkerManager/WorkerSlot，并保留 legacy 待删区 | D15、T28 |
| `baseline/runtime-flows.md` | 旧 NDJSON Claude Host 流程仍是当前流程 | Rewrite | 改为 MessagePort WorkerSlot 流程 | D15、T29–T33 |
| `baseline/storage-and-state.md` | Claude credential/JSONL/bundled Node 仍是主要状态 | Rewrite | 改为 Pi JSONL、managed agentDir、pool/slot/import state | D4 rev、D14、D15 |
| `baseline/risk-hotspots.md` | 缺 WorkerSlot、导入和 GUI/TUI 双写风险 | Revised | 增加 Pi-only 风险 | T28–T37 |
| `baseline/test-and-release-gates.md` | 缺 pool/import/CLI 打包门禁 | Revised | 增加对应门禁，保留资源安全约束 | T37 |
| `AGENTS.md` Pi migration reference 段 | 冻结旧 singleton Agent Host 边界 | Revised | 改为 Main WorkerManager → per-slot utilityProcess | D15 |

## 4. Pi migration 主计划映射

| Path | 新分类 | 批次动作 |
|---|---|---|
| `README.md` | Active authority / Rewrite | 改为 Pi-only convergence 入口；保留 Cycle 1/2 和证据入口 |
| `roadmap.md` | Active authority / Rewrite | T00–T27 转资产影响表；新增 T28–T37 唯一活动树 |
| `implementation-status.md` | Active current state / Rewrite | 下一目标改为 T28/T29；旧 Cycle 3–5 排期失效 |
| `open-questions.md` | Active unresolved only / Rewrite | 移出已解决项，只保留 pool/import 等真实问题 |
| `decisions/README.md` | Active authority / New | 统一 Active/Revised/Superseded 索引 |
| `decisions/001-*` | Superseded | D15 取代“不移植 WorkerManager”的路线 |
| `decisions/002-*` | Revised | Extension strategy 保留，ownership 改到 WorkerSlot |
| `decisions/003-*` | Revised | utilityProcess/MessagePort 保留，singleton topology 被 D15 取代 |
| `decisions/004-*` | Revised | 对齐已实现的隔离 agentDir/auth/models |
| `decisions/005-*` | Superseded | D14 取代“屏蔽但保留可切回” |
| `decisions/006-*` | Active/Revised | 模式切换目标保留，执行参考改为 pix |
| `decisions/007-*` | Superseded/Revised | 旧 asar/singleton 假设由 worker bundle + CLI resources 替代 |
| `decisions/008-*` | Active | Pi 模型配置继续有效 |
| `decisions/009-*` | Active | pi-app timeline/history 参考继续有效 |
| `decisions/010-*` | Active | TUI managed agentDir 继续有效 |
| `decisions/011-*` | Active | 权限策略继续有效 |
| `decisions/012-*` | Active | timeline 上游事件边界继续有效 |
| `decisions/013-*` | Revised | Cycle 1/2 产品语义保留；旧 Cycle 3–5 排期被 roadmap 替代 |
| `decisions/014-*` | Active / New | Pi-only 产品与只读会话导入 |
| `decisions/015-*` | Active / New | Main-owned bounded WorkerManager |
| `topics/completion-cycles.md` | Historical completion record / Rewrite | Cycle 1/2 保留；旧 Cycle 3–5 标记 superseded |
| `topics/architecture.md` | Active capsule / Rewrite | 只保留边界摘要并链接 D15 |
| `topics/reference-repositories.md` | Active reference policy / Revised | pi-app WorkerManager 可移植；pix 负责 TUI/PTY/CLI |
| `topics/extension-ui.md` | Active behavior capsule / Revised | 保留 Cycle 2 语义，增加 WorkerSlot reset/ownership |
| `topics/timeline-reference.md` | Active behavior capsule / Revised | history/open/getBranch 下沉到 WorkerSlot |
| `topics/model-config.md` | Active | 保留 Pi model/auth 配置事实 |
| `evidence/**` | Preserved evidence | 不移动、不重写截图和验收记录 |

## 5. 其他计划根映射

| Plan root | 新分类 | 动作 | 保留价值 |
|---|---|---|---|
| `plans/multi-agent/` | Superseded / Historical | 保持路径；README/roadmap/questions 降权，不再列活动 Next | ACP、Codex、多 runtime 历史研究 |
| `plans/unified-credentials/` | Completed foundation | 清除旧 handoff；保留 credential 实施事实 | managed login/auth 基础 |
| `plans/entry-and-environment/` | Maintenance | 从 Planning 改为主体完成、环境残项并行 | 入口和环境验收 |
| `plans/openchamber-chat-refactor/` | Completed product baseline | 清除 multi-agent Next；保留 UI/timeline/queue/shell 证据 | Cycle 1/2 可复用前端资产 |

## 6. 实现资产分类规则

旧 T00–T27 不重新编号或改写为未完成。每项只增加 replacement impact：

- **Retain**：纯产品行为、UI、证据或 Pi-only 配置可直接保留。
- **Adapt to WorkerSlot**：RuntimeEvent、Extension UI、queue、model、permission 等行为保留，transport/owner 改到 slot。
- **Replace**：单例 `PiHostProcess`、全局 host routing、旧 packaging topology。
- **Delete after migration**：Claude/Codex 对话 runtime、SDK、multi-runtime dispatch、agent picker/binding。
- **Preserved evidence**：已验证但不再代表最终架构的实现记录。

## 7. 移动与删除规则

本轮获批范围内：

- 不删除任何 Markdown 或 evidence。
- 只移动 `dashboard.html` 到 history。
- 根 README 重写前保留完整 archive copy。
- 其他旧计划保持原路径，通过状态和入口降权，避免批量断链。
- 实现代码删除必须等 T28 文件级边界审计与独立批准/实施任务。

## 8. 2026-08-31 执行结果

- 四批 Plantree realignment 已完成；未删除 Markdown/evidence，也未修改产品实现代码。
- 根 registry 已归档为 [`../history/2026-08-31-pre-pi-only-registry.md`](../history/2026-08-31-pre-pi-only-registry.md)。
- 旧 dashboard 已移动为 [`../history/dashboard-2026-08-06.html`](../history/dashboard-2026-08-06.html)，退出活动导航。
- 旧 baseline 已保存于 [`../history/2026-08-31-pre-pi-only-baseline/`](../history/2026-08-31-pre-pi-only-baseline/)。
- Pi plan 和四个外围 plan 的重排前活动文档均保存在各自 `history/2026-08-31-pre-pi-only-realignment/`。
- 当前实施入口为 T28；本映射继续用于 T28/T35 逐文件 replacement/removal 审计。
