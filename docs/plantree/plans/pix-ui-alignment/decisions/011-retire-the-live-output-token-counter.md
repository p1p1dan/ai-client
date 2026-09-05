# D11 — 下线状态行的实时 `↓` 输出 token 计数器

**日期**：2026-09-05
**拍板人**：用户（三选项中选「整条删掉」）
**触发**：T38/U06-b evidence §七 欠项 ②——`turnTokensDisplay` 被认定是死路但当批未删，
用户在下一轮直接问「这个怎么处理」。

## 背景：它原本是什么

D33（2026-08-14，Claude 时代的 `openchamber-chat-refactor` 计划，现已归档在 `history/`）
定下状态行三小件之一：回合进行中显示**实时输出 token 估算**，形如 `✽ 19m 55s · ↓ 38.5k`。
数据来自 Claude host `eventNormalizer.ts` 的 `emitInterimUsage`——一个中途估算通道，
发 `usage.updated` 且带 `interim: true` / `turn_output_tokens_display`。

T35 删除 legacy host 时，这个生产者一并消失。渲染层的整条消费链留了下来。

## 决定

**整条删除**：字段、两个 reducer、选择器、两处 `↓` 渲染（回合状态行与 composer 等待行）、
`formatTokenCount` 格式化函数与全部相关断言。

## 理由：生产者不是「还没做」，是架构上不存在

pi 的事件类型联合体（`@earendil-works/pi-agent-core/dist/types.d.ts:375`）共 11 种，
带 usage 的只有 `turn_end` 与 `agent_end`，**都在回合结束后**。流式过程中的 `message_update`
只带消息快照与 `assistantMessageEvent`，没有任何 token 字段。pi-app 同样只在 `turn_end` 取 usage。

因此「实时」这个语义在 pi 后端下没有数据源。要凑出来只剩字符数除以 4 估算，
而那正是 U06-a / U06-b 一路守住的红线：**不用字符估算冒充 token**
（同一条理由已经否掉了占用环按角色分色，见 T38/U06-b evidence §三）。

保留它的代价是实打实的：一个永远不显示的 UI 分支、一个订阅了却读不到东西的 zustand 选择器、
一组守着 pi 从不发的数据形状的测试。

## 未采纳的两个方案

- **保留字段、改喂 `turn_end` 的真实输出 token**。会把「回合中」的位置填上「回合后」的数字，
  语义错位；且与 Run 面板 usage 行的「输出（上一回合）」是同一个数，重复陈述。
- **维持现状只留注释**。前一批就是这么做的（理由是「删渲染点属于另一个人的活」），
  用户点名要处置，这条不再成立。

## 保留下来的三处

1. `readPiUsagePayload` 里 `interim === true` 的拒绝分支 —— **留**。它守的是
   「估算不得记为账单」这条独立规则，不依赖计数器是否存在。
2. `messageMetadata.ts` 的同名守卫 —— **留**。同上，且那个 registry 的合并是累加式的，
   一旦污染无法自愈。
3. `formatCharCount` 与 `↑ 428 chars` 提示 —— **留**。它是渲染层自己数出来的精确值，
   与估算无关；这也是为什么只有它带单位词。

## 影响

- 回合进行中的状态行现在是 `✽ 19m 55s`（纯计时），等待行是 `… · ↑ 428 chars · 12s`。
- 每回合的 token 与费用仍然有，位置在 Run 面板的 usage 行，标注「上一回合」。
- 上下文占用仍然有，位置是 Run 面板占用环与 Composer 底栏 `NN%` chip。

**关联**：[T38/U06-b evidence](../../pi-backend-migration/evidence/2026-09-05-t38-runtime-usage-fields.md) §七②、
[D11 evidence](../evidence/2026-09-05-retire-live-token-counter.md)。
