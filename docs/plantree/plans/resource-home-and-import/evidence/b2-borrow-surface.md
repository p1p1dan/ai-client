# B2 借读边界与 subagents 取证

日期：2026-09-08。

个人 Pi `AGENTS.md` 通过既有 borrowFrom 环境参数进入资源选项，不需要第二个环境变量。
使用 agentsFilesOverride 只读文本，保留路径、去重、同目录跳过、缺失丢弃；不转成扩展路径。
纯函数与 bootstrap 测试以及全仓串行测试中的对应批次通过。

## subagents 结论：本轮不借读

PI-Desktop `packages/agent-runtime/src/subagent-definitions.ts:49` 自行定义 `.agents/subagents`，
同仓 `subagent-definitions.test.ts` 明确测试其 userDocuments/builtin 合并。
它不是 Pi SDK 原生共享资源目录。
本仓 `@gotgenes/pi-subagents@21.4.2/src/config/custom-agents.ts:24-25` 只读取
`<agentDir>/agents` 和项目 `.pi/agents`，schema、模型/工具选择和信任语义均不同。
因此不将 PI-Desktop 文档作为普通 skill 或 extension 冒充接入，也不建立软链接或回写用户目录。
这是按 B2 的「决定是否借读」得出的不采用结论，与本计划排除 subagent 生命周期改造一致。
全局 AGENTS.md 借读本身已完成，不依赖该目录。

## 本地参考补齐

pi-app 指定路径不存在，已只读拉取至 `/tmp/aiclient-b-reference-pi-app`，commit
`773260243bac9339dc16c5c54d8d9f7bf62e2f3a`。
阅读 `src/main/worker-manager.ts`、`scripts/tests/session-get-messages-disk-fallback.test.mjs`
以及对应 session handler 检索；采用其 utilityProcess/独立磁盘读取验证思路，
不移植其 WorkerManager/preview runtime，保留本仓 D14/D15 与现有 import transaction。
没有直接复制参考仓代码。
