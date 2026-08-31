# Topic — Cycle 1/2 完成记录与旧排期归档

> **状态**：Historical completion record。Cycle 1/2 已完成；本文原 Cycle 3–5 的 singleton-host 排期已由 [D14](../decisions/014-pi-only-product-and-conversation-import.md)、[D15](../decisions/015-main-owned-worker-manager.md) 和 [T28–T37 roadmap](../roadmap.md) 替代。重排前全文见 [history snapshot](../history/2026-08-31-pre-pi-only-realignment/topics/completion-cycles.md)。

## Cycle 1 — Done（2026-08-30）

| 节点 | 完成事实 | Replacement impact |
|---|---|---|
| T08-c/Q10 | bundled permission scope、fail-closed、`.pilab` ask、activity surface 与真实 resolver/产物 smoke | permission behavior 保留；bootstrap/routing 适配 WorkerSlot |
| T14 | FIFO、交换、拒绝恢复、release transaction、lifecycle prune | queue 语义保留；busy/stop/retirement 绑定 slot |
| T15 | local-file realpath/bounds、Markdown policy、image/PDF budgets、worker localize、tab/dirty close | 独立保留；packaged smoke 归 T37 |

证据：[2026-08-30 Cycle 1](../evidence/2026-08-30-cycle1-execution.md)。真账号 queue GUI 复点与高资源 packaged preview smoke 是并行环境欠项，不改写自动完成事实。

## Cycle 2 — Done（2026-08-31）

| 节点 | 完成事实 | Replacement impact |
|---|---|---|
| T08-b | window modal 退役；session-local inline dock、后台徽标、FIFO/ACK/retry/cleanup | UI/store 语义保留；request owner 改到 WorkerSlot |
| T10 | capability table、独立 display store、`extensionUi.reset`、blocking-only request routing | contract 保留；runtime/generation 按 slot 重接 |
| T09 | focus toast、OS warning/error、status chips、plain-text widgets、resource bounds | 直接保留 renderer behavior |
| T17 slice 1 | unsupported 按 session/runtime/method 聚合的非阻断 TUI hint | 保留；真实 action 归 T36 |
| T25 | tags/search/group、reasoning/thinkingLevelMap、model-scoped effort fallback | 直接保留；catalog/bootstrap 适配 slot |

证据：[2026-08-31 Cycle 2](../evidence/2026-08-31-cycle2-execution.md) 与 [screenshots](../evidence/cycle2-screenshots/)。

## 已被替代的旧 Cycle 3–5

| 旧周期 | 原计划 | 替代原因 | 新位置 |
|---|---|---|---|
| Cycle 3 | 直接在 singleton `piRuntime` 上做 history/resume/tree/fork | 目标 topology 已改为 WorkerManager；真实 resume 必须属于 WorkerSlot/Pi AgentSession | T28–T33 |
| Cycle 4 | 在旧 host 外接 pix TUI | 必须先建立 single-write authority、worker lifecycle 与 packaged CLI resources | T36 |
| Cycle 5 | 旧架构 RC | release gate 必须覆盖 pool、import、legacy removal 和 WorkerSlot crash/isolation | T37 |

## 继续有效的产品边界

- 权限审批按 session 内联，后台只显示所属会话徽标，不恢复全局 modal。
- model 首标签唯一归组，其余标签只参与搜索；effort 从模型 metadata 派生。
- queue 首版继续是内存态，除非后续另有决策。
- rewind 不通过截断 Pi JSONL 或裁剪前端数组伪造；后续分支必须保留。
- 历史会话不得因默认展示偏好自动 spawn TUI。

活动任务、依赖和验收只读 [roadmap](../roadmap.md)，不要在本文件继续追加新周期。
