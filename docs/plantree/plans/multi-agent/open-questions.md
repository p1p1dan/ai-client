# Open Questions — 多 Agent 接入

> 只放未决问题。已定的进 [topics/](./topics/)，已排的进 [roadmap](./roadmap.md)。

## #1 接 ACP 还是直连 Codex —— 本 plan 的唯一根问题

**状态**：待 spike 数据 + 用户判断
**判据**：三个月内打不打算加**第 3 个 agent**（Gemini / Cursor / OpenCode / …）

- 打算加 → 接 ACP，第一次多花的成本从第 3 个开始摊回来
- 不打算 → 不接，直连 Codex 更省事

**为什么只剩这一个判据**：ACP 省的是「解析器」，而写第一个解析器的成本 ≈ 写 ACP 客户端的成本，
所以对第 1、2 个 agent 不省钱。完整推导见 [topics/acp-decision.md](./topics/acp-decision.md)。

**隐性成本别漏算**：codeg 的 `registry.rs` 里带着一串适配器版本坑注释
（`claude-agent-acp` 0.64.0 `injected` 不可靠 / `codex-acp` 从 Rust 二进制迁 npm / 1.1.5 收紧 MCP 过滤）——
接 ACP = 把这些上游版本风险一并接进来。

→ 由 [roadmap S1 spike](./roadmap.md) 供数据。

## #2 Codex 侧提问是什么形状

**状态**：未实测
codeg 为它写了 `classify_elicitation` 分类器，说明形态不止一种（提问式 / 审批式 / 链接式）。
这直接决定「薄适配」到底多薄——我们上层问答卡已 agent 无关（[reuse-boundary](./topics/reuse-boundary.md)），
但如果 Codex 的提问形状与 `question.requested` 差得远，薄适配就不薄了。

→ 属 S1 spike 第 3 项产出。

## #3 会话 ↔ agent 绑定的持久化口径

**状态**：待设计
`chatSessions.ts` 是**红线 store**，加字段走加法纪律。要定的：

- 字段落在 session 还是 workspace 层？（codeg 落在 conversation 行的 `agent_type`）
- 已有会话（无该字段）怎么迁移——默认回落 Claude 还是显式「未知」？
- wire 名一旦持久化就不能改（codeg 有专门的回归测试钉死 12 个 wire 名），我们的命名要一次定对
- resume 时 `HistoryBlock` 无 agent 归属概念（与 C-17 同一缺口）——跨 agent 的历史怎么读

## #4 扩 git 能力要对齐 codeg 的哪几项

**状态**：缺参照点
用户 2026-08-05 说「codeg 右侧的 git 功能以及展示形式我都很喜欢」，但未指明具体点；
**同轮又裁定本阶段 git 维持当前最小集**。两者不矛盾（远期偏好 vs 本阶段范围），
但要动 git 能力前必须先取回具体参照点（截图或点名），否则只能猜。

参照面提示：A08 曾规划 branch / pr / sync / stash 全套，按最小集纪律砍掉——
用户喜欢的可能正是这批。

## #5 Codex 的模型目录与权限语义如何统一表达

**状态**：待 spike
Codex 有自己的模型集与 sandbox / approval 策略，与 Claude 的模型选择 + `permissionMode` 不同构。
UI 上是做成「按 agent 切换整套选择器」还是「统一抽象 + 各自枚举」，要看两边枚举差多远。

→ 属 S1 spike 第 4、5 项产出。
