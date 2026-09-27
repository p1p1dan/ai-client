Role: detail shard

# P1-8 / P1-11 分片 04 · 防护插件 `aiclient-loop-guard` 设计

上位：[P1-8 / P1-11 方案](../p1-8-p1-11-guards-and-terminal.md)。回答调研问题 5。事实依据见[分片 03](03-guards-facts.md)，行号约定同该分片。这是方案，不是施工结论；§7 的实验要先做。

## 1 形态与位置

- 新宿主插件行 `aiclient-loop-guard`，代码放 `dsh-host/guards/`，打进产品 bundle。bridge 硬依赖它；启动期组合审计把它列进「必须启用」（扩展[决策 059](../../decisions/059-allowlist-verification-and-audits.md) 第 3 条）。
- 为什么不放 bridge：子代理、goal 回合、job 唤醒开的回合都不经过 bridge 的 RPC；规则 B 要挂在 `llm/stream` 上；共享宿主里一个失控会话会拖累全部会话（[P1-3 方案](../p1-3-shared-host.md)第 152 行）。bridge 只做结果映射（P1-4d）。
- 为什么不并进 `aiclient-permissions`：一个管「这个调用能不能执行」，一个管「这次运行还该不该继续」，生命周期与开关都不同。两者之间只留一个查询接口（§5）。
- 常量搬到 `shared/runGuards.ts`：`DEFAULT_TURN_CEILING`、`tool_call_repetition`、收尾指令与拒绝原句。P1-12 删 runtime 时不会丢，渲染层与 bridge 也从这里取。
- 每个 agent 一份状态（`WeakMap<Agent, GuardState>`），只在内存。宿主重启后清零；那一轮本来就已被中断（P1-3）。

## 2 规则 B：单条回复内的退化（流式掐断）

- **挂点**：`ctx.on('llm/stream', wrap)`。只包 `isAgentLoopRequest(options)` 为真的请求，主会话与子代理都包（E3 验证）；标题、压缩摘要这类单发请求不包。
- **判定**：只在 `block-end` 判 `tool-call` 块，这时参数已完整。阈值照搬 1.0.x：同一规范化调用第 3 次；或工具族调用超过 16 个。
- **工具族**（DSH 名）：`subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`、`job_output`、`job_list`、`job_kill`，加[决策 062](../../decisions/062-custom-subagents-delegate-tool.md) 的委派工具。规范化：控制类只看目标 id，忽略 `wait`、`timeout_ms`；委派类看代理名或 persona、任务文本、模型。字段名施工时按各工具的 schema 定（推断）。
- **触发**：
  1. 停止读取下游的流：dsh-llm 关迭代器，llm-pi-ai 取消上游请求；
  2. 吐 `{type:'finish', reason:{kind:'error', failure:{code:'tool_call_repetition', message}}}`，message 用 1.0.x `describeRepetition` 的原句；此后不再吐任何 chunk；
  3. loop 落 `assistant/attempt`，不执行任何调用，回合以 `turn/end {kind:'error'}` 结束。
- **防重试**：在 `agent/request-error` 上 prepend 一个监听，遇到 `tool_call_repetition` 直接返回、不调 `next()`。这样即使 P1-5 把网关配成 always，这一步也不会重跑。1.0.x 同样「不自动再请求模型」（决策 042 第 2 条）。
- **显示**：bridge 把 `turn/end error{code:'tool_call_repetition'}` 映射成 `session.failed {errorCode:'tool_call_repetition'}`，这是通用失败映射（[P1-4 分片 04](../p1-4-bridge-parity/04-turn-semantics.md) 第 122 行），渲染层沿用 1.0.x 的失败卡。失败后的「继续」走 P1-4 的重试上一轮（决策 028）；重试受理最后一个 `turn/end` 为 error、interrupted 或 aborted 的情况（同一分片第 53 行），这里是 error，正好覆盖。
- **取证**：宿主 stderr 记一行（规则、签名、次数、这条回复里已写出的调用数），经 P1-3 的宿主日志进 main.log；`turn/end.error` 里带同样的信息。不写自定义事件（决策 026 第 5 条、053 第 1 条）。
- **开关**：`AICLIENT_RUNTIME_LOOP_GUARD=0` 只关规则 B，与 1.0.x 一致，上限不受影响。`DshHostProcess` 目前剔除所有 `AICLIENT_*`（`main/services/agent-host/DshHostProcess.ts:72`），要像开发网关变量那样显式转发这一个（写法见 `:86,196-201`），打包态同样转发。
- **可选规则 B2**（方案页决策点 D6）：任何工具，单条回复超过 64 个调用即掐断。理由：DSH 会把一条回复里的调用全部执行；阈值是推断，要看数据。它超出了用户 09-24 给决策 042 定的范围，要用户点头。

## 3 规则 C：500 轮上限

- **计什么**：DSH 的 step，也就是一次模型请求加它的工具批，等于 1.0.x 的一个 assistant 轮。只算真正进入的步（`pre-step` 返回 `enter` 且消息非空）；llm-retry 在同一步里的重试不另算。
- **按谁计**：每个 agent 一个计数器。子代理也用 500 兜底；自定义定义里的 `maxTurns` 归 P1-16d（[决策 062](../../decisions/062-custom-subagents-delegate-tool.md) 第 2 条），可以复用这个计数器。
- **计数纪元**：在 `agent/inbox/claimed` 里看到下面三种消息，就开新纪元（计数清零、解除暂停）：
  - 来源为 `user`（发送、插话）；
  - 我方的重试续跑（[决策 028](../../decisions/028-retry-via-hidden-continuation-prompt.md)；1.0.x 的重试本来就是一次新运行）；
  - goal 回合（`{kind:'goal'}`）：每个 goal 回合各计 500，goal 自己另有 256 轮上限。
  - job 完成通知、子代理消息、我方的收尾指令都不开新纪元。这对应 1.0.x「子代理回报触发的续跑计入同一计数」（决策 040 第 1 条），也堵住 jobs 的无限唤醒链。
- **触顶**：第 500 步正常跑完（工具已执行、结果已落盘）。loop 要开第 501 步时，`agent/pre-step` 返回 `enter`，消息为「本步 claim 到的消息 + 收尾指令」：
  - 收尾指令用 1.0.x 原文（`runtime/plugins/agent-loop/index.ts:286-305`），用 `createUserMessage` 生成，来源 `{kind:'aiclient-loop-guard', form:'turn-ceiling'}`；
  - 保留原决定里的 `startsRequestSeries`；
  - 历史投影把它当内部消息隐藏，规则与决策 028 的续跑提示相同（[P1-4 分片 03](../p1-4-bridge-parity/03-history-tree-rewind.md) 第 38 行）。
- **收尾步**：工具定义不撤，理由与 1.0.x 相同。任何调用在 `tools/pre-execute` 里 `deny`，理由用 1.0.x 原句（`agent-loop/index.ts:248-254`）；这一拒绝排在审批之前，不出卡（§5）。
- **收尾**：收尾步的 `step/end` 上同步调用 `cancel({kind:'hook', reason:'aiclient-turn-ceiling'}, {keepInbox:true})`，回合落 `aborted{hook}`，收件箱保留。这与 P1-4 推荐的插话收尾是同一机制（[P1-4 方案](../p1-4-bridge-parity.md)第 33 行）。不用 `pre-step` reject：它会丢掉 claim 的消息，`blocked` 的含义也含糊。
- **显示**：bridge 把 `aborted{hook,'aiclient-turn-ceiling'}` 映射成 `session.completed {stopCause:'turn_limit'}`；历史投影认这个原因，或认本回合里收尾指令的来源；渲染层沿用 `TurnCeilingNotice` 与「继续」（决策 040 第 7 条）。
- **暂停期**：触顶之后、下一个新纪元之前，由 job 通知等非用户消息开的新回合，第一步直接按收尾步处理（附指令、拒工具、`step/end` 收尾）。
  - 额外请求数不超过触顶时仍在跑的后台任务数，因为收尾步里起不了新任务（推断，E6 验证）。
  - 与 1.0.x 的差别：1.0.x 等子代理全部回报后合成一次收尾；这里是每个通知各一次无工具回复。列入行为差异。
- **goal**：hook 取消会让 goal 在下一个空闲点暂停（`dsh-goal-round-driver/README.md:53`）。界面上是「goal 已暂停」加上限提示条，用户说「继续」即可。
- **配置**：产品值 500 写在 bundle 行的配置里；测试用小值；开发态可用 `AICLIENT_DSH_TURN_CEILING` 覆盖，只在未打包时读，与 `AICLIENT_DSH_HOME` 同样处理（`DshHostProcess.ts:131-137`）。

## 4 为什么不移植形态 A

- 1.0.x 的形态 A 是「报告只能靠自动续跑送达，模型不停调工具就永远送不到」造成的互等（决策 042 背景）。
- DSH 的完成通知是推送：忙碌的 agent 在下一步注入，空闲的直接唤醒；`job_output` 在任务结束后第一次读时带回结果（`dsh-tool-jobs/README.md:32,40`）。互等的根因不在（推断）。
- 剩下的「对已结束任务反复轮询」，有 `repeat-tool-reminder` 在第 3 / 5 / 8 次提醒，规则 C 在 500 步兜底。现场若真出现，再把「连续 N 条回复全是空转调用」补成规则 A（方案页决策点 D9）。

## 5 与 P1-6 `tools/pre-execute` 的关系

- **分工**：P1-6 的闸门判断「这一个调用能不能执行」，发生在整条回复流完之后。到那时 token 已经付了，`tool/call` 已经落盘、工具行已经出现（[P1-6 分片 02](../p1-6-permissions/02-dsh-facts.md) 第 53 行）。所以退化回复只能在流阶段掐（规则 B），pre-execute 做不到。
- **顺序**：规则 C 的收尾拒绝必须先于审批，否则收尾步里的调用会先弹卡。
  - 推荐：P1-6b 的宿主插件 `aiclient-permissions` 在 pre-execute 里调 `gate.authorize()`（纯库 `shared/permissions/gate.ts:646`，P1-6a 已落地）之前，先问守卫服务（例如 `loopGuard.refusalFor(exec)`），有拒绝理由就直接 `deny`。纯库不用改，也不依赖监听者的注册顺序。
  - 备选：守卫自己 prepend 一个 pre-execute 监听，并用静态测试钉住 bundle 行的顺序。prepend 的先后取决于插件加载顺序（推断），比较脆。
- **子代理与 PTC 子调用**是否经过全局 pre-execute，是 P1-6 已列的开工实验（[P1-6 方案](../p1-6-permissions.md)第 205 行），本题复用其结论。

## 6 边界

- P1-4c：`step/end` 上的 hook 取消机制；P1-4d：两个映射（`tool_call_repetition` 失败卡、`turn_limit` 完成注记）与收尾指令的隐藏。
- P1-5：网关的 `retryPolicy`、流空闲超时。
- P1-6b：`authorize()` 之前的守卫查询。
- P1-7：没有新界面；jobs 面板会显示触顶后仍在跑的后台任务。
- P1-16d：子代理定义里的 `maxTurns`。
- P1-3：宿主日志的去向；pong 观测（分片 05）。

## 7 开工前实验（每个一个脚本；开跑前 `free -m`，一次只起一个宿主）

| # | 验证什么 | 通过标准 |
|---|---|---|
| E1 | 包装层吐终结 error | 落 `assistant/attempt`；没有 `tool/call`；`turn/end error{tool_call_repetition}`；normal 与 always 两种重试模式下都不重试 |
| E2 | 上游真的被取消 | 假网关在第 3 个重复调用写出后不久看到连接断开，之后不再写 |
| E3 | 子代理也被覆盖 | 子代理的请求经过同一个 `llm/stream` 与 `agent/pre-step`，`isAgentLoopRequest` 为真 |
| E4 | `step/end` 同步取消 | 回合落 `aborted{hook,'aiclient-turn-ceiling'}`，收件箱保留（与 P1-4c 的实验合做） |
| E5 | 收尾拒绝先于审批 | 默认档下，收尾步里的 bash 调用没有 `permission.requested`（与 P1-6b 合做） |
| E6 | 暂停期 | 触顶时有 2 个后台任务，之后恰好多 2 次无工具回复；`pre-step` 替换消息后，claim 到的通知仍在历史里 |
| E7 | 合成长会话 | `seedSession` 或 `agents.create({seed})` 生成 4 个 2000 条会话的耗时与内存，供分片 05 的 LC-2 用 |
