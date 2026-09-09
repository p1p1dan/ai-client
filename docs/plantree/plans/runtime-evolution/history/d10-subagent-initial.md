# D10 subagent 初始决策快照（已由 2026-09-09 修订替代）

Role: history · Status: superseded bounds · 原日期：2026-09-08
保留同进程、不占 WorkerSlot 的拓扑；并发 4、watchdog 终止和旧权限继承措辞已退出当前口径。
现行权威：[ARD D10/D17](../../../../plans/2026-09-08-runtime-evolution-ard.md) · [修订调研](../topics/p5-2-subagent-research.md)
以下是修订前原文，不是当前施工契约。

### D10 · Subagent 拓扑：同进程内的第二个 Agent，不占 WorkerSlot

**决策**：subagent 在同一 worker 进程内跑第二个 `Agent`（Cordis fork/isolate 上下文做 service 隔离），
不为每个 subagent 分配 WorkerSlot。

依据：
1. PI-Desktop ADR 0062 已稳定运行验证此拓扑——「A `SubagentRun` is a second pi `Agent` in the
   same sidecar process」，并把「A separate process per delegate」明确列为 **Rejected**：
   真隔离的收益抵不上重复一份 host 连接、provider 设置和事件管道的代价。
2. 我方额外理由：WorkerSlot 是被内存分档硬限的稀缺资源（≤4GiB 机器只有 3 个槽，
   `WorkerManager.ts:250-268`），超限直接 `worker_capacity_reached` 而不是排队。
   subagent 占槽会挤掉真实用户会话。
3. subagent 负载是 IO-bound（模型流式 + 文件读 + shell），事件循环不是瓶颈；
   真正 CPU 密集的 shell 本来就已 fork 出去。

**照搬 ADR 0062 / 0119 的边界**（这些数字是他们跑出来的，不重新拍）：

| 项 | 口径 |
|---|---|
| 并发上限 | 4，信号量控制（`MAX_SUBAGENT_CONCURRENCY`） |
| 报告上限 | 12k 字符（`MAX_SUBAGENT_REPORT_CHARS`），超出截断 |
| 工具白名单 | 默认 `Read/Glob/Grep`；可声明 `Bash/Edit/Write`；禁止 plugin/skill/mode 工具与嵌套 Task |
| 权限继承 | 不继承父会话写权限，写能力只来自定义自身声明 |
| 并行写序 | 按规范化路径的 PathMutex 串行化写操作，不同路径互不等待 |
| 上下文隔离 | 子行带 `parentToolCallId` + `agentName`，持久化但**重建模型上下文时跳过** |
| 超时 | 事件驱动的 idle + 总时长看门狗，产出 `timed_out` 结果（ADR 0119） |
| 终止 | 子代理终止收敛为 Task 工具结果，不触达主进程的 turn 处理 |
| 定义来源 | `~/.agents/subagents/<name>.md`，上限 16 条，坏文档降级为启动诊断 |

**不照搬的一条**：ADR 0062 花了篇幅把渲染层「每会话一个 pending permission」改成队列——
我们 `src/renderer/stores/chatSessions.ts:250` 的 `pendingPermissions` 本来就是数组且带去重，
这块渲染层不用动。

**留后路**：执行入口抽成 `SubagentRunner` service（`run(def, prompt, signal): AsyncIterable<Event>`），
进程内实现是默认 provider；将来真出现 CPU 密集场景，换一个实现即可，调用方不动。
