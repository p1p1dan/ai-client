# 决策 066：500 轮上限按每个 agent 的 step 计，触顶时收尾一步再停

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：[P1-8 / P1-11 方案 §4 D7、D8、D9](../topics/p1-8-p1-11-guards-and-terminal.md#4-需要拍板的决策点)、runtime-hardening 决策 040。

## 规则

1. 计数：按 DSH 的 step、按 agent 计。用户消息、重试续跑、goal 回合开新纪元，计数从头开始；job 唤醒不清零，这样唤醒链绕不过上限。
2. 触顶时：
   - 在 `pre-step` 换入 1.0.x 原文的收尾指令；
   - 在 `pre-execute` 拒绝工具，这一步排在 P1-6 的 `gate.authorize()` 之前；
   - 收尾那一步的 `step/end` 用 hook 取消，映射成 `session.completed {stopCause:'turn_limit'}`。与 P1-4 插话（决策 029）用同一机制，收件箱不丢。
3. 1.0.x 的「形态 A」（`job_*` / `list_agents` 的空转）不移植：推断根因在 DSH 下不存在，而且有提醒与规则 C 兜底。现场若再出现，再补。

## 取舍

- 不选「按 DSH turn 计」：唤醒链可以绕过上限。
- 不选「按会话生命周期计」：长会话迟早撞顶。
- 不选「`pre-step` reject」：会丢掉已取出的消息，`blocked` 的含义也含糊。
- 不选「直接取消、不收尾」：会回到旧 64 轮上限时「页面停在工具行」的问题。
- 代价：触顶后，每个 job 通知都会多出一次无工具的回复。
