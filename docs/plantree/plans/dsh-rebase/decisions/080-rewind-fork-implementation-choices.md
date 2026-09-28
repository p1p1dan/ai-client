# 决策 080：P1-4b 回退与 fork 的实现取舍

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：P1-4b 实现（`36d4f84a`）与开工实验、[决策 027](027-rewind-and-fork-via-seeded-child-sessions.md)。

## 规则

1. 桩 v2 的 lineage 是对象数组，当前会话放在最后一项；新建会话也直接写 v2，读 v1 兼容。
2. 回退到用户消息时，边界往前退到持久化收件箱为空的位置，否则子会话会继承 `agent/inbox/spliced` 里排着的那条提示，一开回合就重跑它。任何边界遇到收件箱不空，都往前退。
3. 回退到的助手 step 如果是回合的最后一步，边界取 `turn/end`，保住 Stop、插话这类结束原因。压缩摘要节点的边界延到 `compaction/end` 和 `command/done`。
4. DSH 的 `buildForkSeed` 抄进了 `bridge/forkSeed.ts`，因为 bundle 只允许外部依赖 `dsh-llm`。靠逐边界比对测试防漂移：真宿主 45/45 一致，金样本日志的每个边界也一致。
5. rewind id 撞上已存在的 `.rN` 时，顺延到下一个编号。fork 子会话的 header 带 `parentSession`。
6. 维护期间到达的 followup，按实验 E2 的结论处理：任务末尾对旧 agent 做 `cancel({kind:'disposed'}, {keepInbox:true})`，防止它在旧 agent 上开出回合。这条输入留在旧收件箱里，随旧会话一起退役。

## 行为差异（请留意）

- 被丢弃的 fork、失败回退留下的子会话日志，按[决策 024](024-gc-only-orphan-empty-sessions.md) 只删空会话的规则，加上 parentSession 后代规则，实际上**不会被清理**，会一直占着磁盘。决策 027 原先写的「交给 P1-3 当孤儿清理」不会发生。要清理，得另立规则，比如「被 discard 标记的 fork 可删」。这一条留给用户决定。
- 维护期被挡下的唤醒（例如 goal 续跑）会随旧会话丢掉，交给 P1-7 评估。
