# 决策 081：P1-8 防空转插件的实现取舍

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：P1-8 实现（`72330d1b`）与实验 E1～E7、[决策 065](065-loop-guard-host-plugin.md)、[066](066-step-limit-500-per-agent.md)。

## 规则

1. 开关 `AICLIENT_RUNTIME_LOOP_GUARD` 关闭时，流式掐断与 500 步上限**都**不生效。方案分片 04 原来只写了关掉掐断。
2. 触顶拒绝排在权限审批之前：靠 prepend、`inject: ['tools']` 和 bundle 行的顺序实现，实验 E5 已实测。更稳的做法是 P1-6 第二部分在 `authorize()` 之前调 `ctx.aiclientLoopGuard.refusalFor(exec)`，届时补上。
3. 步数在 `step/start` 事件上计；新纪元在 `pre-step` 按消息来源判断（用户、`aiclient-retry`、goal）。收尾指令的来源写成 `{kind:'aiclient-loop-guard', form:'notice'}`，历史投影里隐藏。
4. 常量放在 `src/dsh-host/loopGuard/constants.ts`，不引任何包，bridge 与渲染层可以直接用。
5. 没做开发态覆盖变量；测试和开发时，用 `$DSH_HOME/cordis.patch.yml` 覆盖 `stepCeiling`。
6. 争用回归的受害者延迟，改用带发送时间戳的场景 `P8-VICTIM` 计算，扣掉假网关自身的停顿；原始间隔同时列出。

## 交给 P1-4d

bridge 要把 `aborted{hook,'aiclient-turn-ceiling'}` 映射成 `session.completed{stopCause:'turn_limit'}`，把 `turn/end` 的 `error.code` 透传成 `errorCode`，并在历史里隐藏来源为 `aiclient-loop-guard` 的消息。目前冒烟里的 `turn_limit` 只在 DSH 事件这一层验证过。
