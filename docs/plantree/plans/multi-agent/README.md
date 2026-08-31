# Historical Plan — Claude + Codex Multi-Agent

> **状态**：Superseded（2026-08-31）
>
> **替代权威**：[Pi-only D14](../pi-backend-migration/decisions/014-pi-only-product-and-conversation-import.md) 与 [WorkerManager D15](../pi-backend-migration/decisions/015-main-owned-worker-manager.md)。

本计划曾负责把 Claude 单 Agent 扩展为 Claude + Codex，评估 ACP，并落地 Codex direct app-server、agent binding、permissions、models、credentials 和 packaging。用户现已决定产品成为 Pi-only：Claude/Codex 不再作为可执行 conversation runtime，多 provider/model 统一通过 Pi；旧会话由只读 import service 保留。

## 历史价值

- ACP vs direct Codex 的实测、协议和 packaging 证据；
- Codex question/permission/history/idle-sweep 与多 session 失败模式；
- multi-runtime discriminant、agent binding 和 UI picker 的删除影响输入；
- Codex ASR 等非 conversation 同名能力的保护提醒；
- legacy source format，可供 T34 import adapter 研究。

这些内容不再提供活动 Next，也不能覆盖 Pi-only roadmap。

## 读取路径

| 文件 | 当前角色 |
|---|---|
| [roadmap.md](./roadmap.md) | 历史里程碑摘要与 Pi-only 影响 |
| [open-questions.md](./open-questions.md) | 无活动问题；遗留项的重新归口 |
| [topics/acp-decision.md](./topics/acp-decision.md) | ACP/Codex 历史决策证据 |
| [topics/reuse-boundary.md](./topics/reuse-boundary.md) | legacy runtime/reuse 边界研究 |
| [topics/codeg-reference.md](./topics/codeg-reference.md) | codeg 历史参照 |
| [重排前快照](./history/2026-08-31-pre-pi-only-realignment/) | 2026-08-31 前完整 active plan 文本 |

## 使用规则

- T28/T35 可引用本计划识别待删 runtime/contract/dependency，但删除清单只由当前 Pi roadmap 产生。
- T34 可引用 legacy protocol/fixtures 构建只读 adapter，不得恢复 execution runtime。
- 任何 substantial code reuse 仍须按原 license 处理。
