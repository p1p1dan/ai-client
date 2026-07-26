# Plantree — 规划树入口（本仓唯一规划入口）

> 建立：2026-07-24（双轨合一后规整）。规划工作流遵循 plan-tree 规范：
> **当前活动状态**只看本树；历史证据与已拍板决策看台账档案（链接见下）。

## 阅读顺序（resume 时）

1. 本文件（注册表）
2. [`baseline/`](./baseline/README.md)（项目全局事实：模块图 / 运行时流 / 存储 / 门禁 / 风险）
3. 目标计划的 `README.md` → `implementation-status.md` → `roadmap.md`
4. 需要时再进 `open-questions.md` 与台账档案

## 活动计划注册表

| Plan | Status | Current Phase | Last Landed | Next Target |
|---|---|---|---|---|
| [openchamber-chat-refactor](./plans/openchamber-chat-refactor/README.md) | In Progress | Phase 3 Chat MVP 收口 | T-07 补强四项 `0f886a8` + #8 thinking 形态修正 `bfd4f6b`（2026-07-27，41 文件 391 例三绿） | T-04 + T-07 GUI 验收（等用户统一点测）；并行 T-05 |

## 遗留规划根（保留原位，不迁移不删除）

| 位置 | 角色 | 说明 |
|---|---|---|
| `docs/plans/2026-07-23-openchamber-chat-refactor-ard.md` | **架构权威** | 目标结构、决策立论；改架构先改它 |
| `docs/plans/2026-07-23-openchamber-chat-refactor-execution-plan.md` | 任务定义 | C-xx/T-xx 验收标准、协作规则、**测试凭证约定（§4）** |
| `docs/plans/openchamber-chat-refactor-ledger.md` | 决策 + 里程碑档案 | 已拍板决策 D1~D17、检查点（CP-x）、Phase 总览；append-only |
| `docs/plans/ledger-claude-mainline.md` | 过程记录档案 | C-xx 逐任务证据与提交 hash；append-only |
| `docs/plans/ledger-team-track.md` | 过程记录档案 | T-xx 逐任务证据；2026-07-24 起轨道移交主线 |
| `docs/plans/`（其余 2025/2026 早期文档） | 历史计划 | ai-sdk-migration / quick-terminal / status-line 等，与本计划无关 |

**权威顺序**：ARD ＞ 执行计划（任务定义）＞ 总台账（决策/检查点）＞ 本树（当前状态）。
冲突时依此序裁定；状态类信息以本树为准，本树不复制决策原文只链接。

## 惯例

- 完成一个任务：先记台账档案（证据 + hash），再刷新 plan 的 `implementation-status.md` / `roadmap.md`。
- 里程碑（M1~M5）/ 确认点（CP-x）结果仍回填总台账检查点表。
- 低承诺想法进 [`ideas/inbox.md`](./ideas/inbox.md)，成熟后 promote 到 roadmap / open-questions。
