# 决策 065：防空转做成宿主插件 `aiclient-loop-guard`，在流式阶段掐断退化回复，范围沿用主线决策 042

日期：2026-09-27。**状态：自主决定，待用户审批。** 依据：[P1-8 / P1-11 方案 §4 D4、D5、D6](../topics/p1-8-p1-11-guards-and-terminal.md#4-需要拍板的决策点)、runtime-hardening 决策 042（子代理工具防空转）、[分片 03、04](../topics/p1-8-p1-11-guards-and-terminal/04-guards-design.md)。

## 规则

1. 新宿主插件 `aiclient-loop-guard`，覆盖主会话、子代理、goal 回合与后台唤醒。bundle 多一行，启动期组合审计要求它启用。
2. 挂点：包住 `llm/stream`。检测到单条回复里的退化调用时，停止读取流，上游请求随之取消；再吐一个终结 error。结果是：
   - 这条回复落成 `assistant/attempt`，一个调用都不执行，也不进上下文，与 1.0.x 的行为等价；
   - 另在 `agent/request-error` 上拦下这个错误码，防止网关的重试策略配成 always 时被自动重试。
3. 掐断范围沿用决策 042：只管子代理与 job 工具族。「任何工具单条回复超过 64 个就掐」这类通用总量闸不做。它超出了用户 09-24 拍板的范围，要做需用户点头，已记入想法池。
4. 开关 `AICLIENT_RUNTIME_LOOP_GUARD` 会被宿主环境的剔除规则去掉（`DshHostProcess` 剔 `AICLIENT_*`），要显式转发给宿主。

## 取舍

- 不选「监听 `agent/assistant-stream` 再 `agent.cancel()`」：已流出的正文会进上下文，而且会结束整个回合。
- 不选「只在 pre-execute 拒绝」：整条退化回复的 token 已经付了，`tool/call` 也已落盘。
- DSH 本身没有步数上限（`dsh-agent-loop/README.md:202`）；`repeat-tool-reminder` 只在工具执行之后提醒，而一条回复里的调用会全部执行。
- 代价：依赖 DSH 的 chunk 协议，靠钉版本和回归场景兜住。
- 开工前要做实验（方案 E1～E7），先验证流式掐断和上游取消。
