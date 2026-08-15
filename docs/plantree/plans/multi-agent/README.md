# Plan — 多 Agent 接入（Claude + Codex，ACP 判定）

> 2026-08-05 立项。触发：用户 2026-08-04 会话提出 codeg 参照与 ACP 路线，2026-08-05 拍板
> 「先把 acp+codex 做了，确定可行性后并入主线」。
> **本 plan 的结论主体产生于 2026-08-04 会话（transcript `a5273935-…`），当时未落库**——
> 全库 grep「ACP」零命中即为证据。本次补落，`topics/` 三篇即那次讨论的定论与证据链。

## Scope

把气泡对话链从 **Claude 单 agent** 扩到**多 agent**，本阶段范围 = **Claude + Codex 两个**；
并判定 **ACP（Agent Client Protocol）**是否作为统一接入层。

**In scope**：会话与 agent 绑定（侧栏可区分）· Composer 内切 agent · 模型与推理档按 agent 适配 ·
权限模式管理 · Codex 接入通道选型（ACP 适配器 vs 直连）。

**Out of scope（本阶段）**：多 agent **协同**工作（用户 2026-08-04 明示「先放一放」）；
Claude 线改走 ACP（已否，证据链见 [topics/acp-decision.md](./topics/acp-decision.md)）。

## 排期（用户 2026-08-06 解冻，覆盖 2026-08-05 的后置裁定）

**本 plan 已解冻，进入执行。** 用户 2026-08-06 原话「multi-agent 支线解冻 开干」。

裁定沿革（三次，后者覆盖前者）：

| 日期 | 裁定 | 状态 |
|---|---|---|
| 2026-08-05 | 与主线并行，新线先跑 ACP+Codex spike | 被同日改判覆盖 |
| 2026-08-05（同日修订） | **后置**——先把主线 Claude 客户端做到大致完成，再考虑 codex 支线 | **已于 2026-08-06 解除** |
| **2026-08-06** | **解冻开干**，从 [roadmap S1](./roadmap.md) 接续 | **现行** |

**解冻前提已满足**：后置裁定挂的条件是「主线大致收口」——主线开发线五任务
（T-32 / T-16 / T-33 / T-35 / T-34）已于 2026-08-06 第十二轮点验全部转 Done，开发线收口。

## 与主线的关系

主线 [openchamber-chat-refactor](../openchamber-chat-refactor/README.md) 是壳与观感重构，开发线已收口
（残留为真机类点验债 [T-10 清单](../../../plans/t10-packaged-gui-checklist.md) 与 T-04 网关阻塞等并行项）。
本 plan **自 2026-08-06 起与主线残留项并行推进**，不再互为前置。

两者的接缝在三处，动工前须回主线核对，不得单方面改：
`stores/chatSessions.ts`（红线）· `src/agent-host` 协议 · Composer 目标栏与侧栏会话行。

## 文件地图与阅读路径

| 文件 | 角色 |
|---|---|
| [roadmap.md](./roadmap.md) | **先读**：Done / In Progress / Next / Deferred |
| [open-questions.md](./open-questions.md) | 未决问题（含 ACP 接不接的唯一判据） |
| [topics/acp-decision.md](./topics/acp-decision.md) | ACP 是什么、值不值、Claude 线为何不走——判断依据与证据链 |
| [topics/reuse-boundary.md](./topics/reuse-boundary.md) | 现有代码的 **agent 无关面 vs Claude 专属面**（决定 Codex 接入成本） |
| [topics/codeg-reference.md](./topics/codeg-reference.md) | codeg 参照事实与用户明确认可的形态 |

## 权威链（冲突时依此序）

1. [ARD](../../../plans/2026-07-23-openchamber-chat-refactor-ard.md) — 架构权威（多 agent 若改架构，先改它）
2. 本 plan 的 `topics/` 与 `decisions/`（尚未建，首个决策落地时建）
3. [roadmap.md](./roadmap.md) — 当前状态

**已编号决策**：**D45**（不接 ACP，直连 `codex app-server`）与 **D46**（Claude 线不走 ACP），2026-08-15 升格入[总台账](../../../plans/openchamber-chat-refactor-ledger.md)决策表；证据链仍在 [topics/acp-decision.md](./topics/acp-decision.md)。

## 维护惯例

沿用主线：任务落地 → 台账加行（证据 + hash）→ 刷新本 plan 的 roadmap。
本 plan 的过程记录暂并入[主线台账](../../../plans/ledger-claude-mainline.md)，独立成册需等首个 M 级里程碑。
