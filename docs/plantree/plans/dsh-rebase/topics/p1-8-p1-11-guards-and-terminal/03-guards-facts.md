Role: detail shard

# P1-8 / P1-11 分片 03 · 防空转与轮数上限：1.0.x 做了什么、DSH 有什么

上位：[P1-8 / P1-11 方案](../p1-8-p1-11-guards-and-terminal.md)。回答调研问题 4。我方行号取 `git show 526ec2e5:<路径>`，省略 `src/`；DSH 路径省略 `src/dsh-host/node_modules/@deepseek-ai/`（已装的 `0.1.7-rc.2`）。只读源码与 README，没有起宿主；标「推断」的没有运行验证。

## 1 1.0.x

### 1.1 主会话 500 轮上限（runtime-hardening [决策 040](../../../runtime-hardening/decisions/040-main-session-turn-ceiling-with-wrap-up.md)）

- 一次用户发送最多 500 个 assistant 轮（`DEFAULT_TURN_CEILING`，`runtime/plugins/agent-loop/index.ts:212-246`）；子代理回报触发的续跑计入同一计数（决策 040 第 1 条）。
- 计数在 pi 的 `shouldStopAfterTurn` 里做，到达上限的那一轮照常跑完（工具已执行、结果已落盘）再停（`:827-861`）。
- 仍在跑的子代理不停止，等它们回报；回报不再各自换一轮，而是暂存，放在收尾指令前面（决策 040 第 3、4 条；`:643-657,1188-1221`）。
- 收尾轮：工具定义保留（历史里有 tool_use 却不声明 tools，Anthropic 会报 400），任何调用由 `beforeToolCall` 以 `block + terminate` 拒绝（`:863-877`）。收尾指令与拒绝原句在 `:248-254,286-305`。
- 结局是完成：`stopCause: 'turn_limit'` 挂在 `session.completed` 上（`:1334-1336`）；界面是中性的 `TurnCeilingNotice` 加「继续」，「继续」发一句「继续」，不重发原提示词（`renderer/components/chat/TurnCeilingNotice.tsx`；决策 040 第 7 条）。
- 它取代了早期的 64 轮上限：那个版本触顶即退出、页面停在工具行、显示成红色失败卡（决策 040 背景；[决策 039](../../../runtime-hardening/decisions/039-remove-main-session-turn-ceiling.md)）。

### 1.2 子代理工具防空转（[决策 042](../../../runtime-hardening/decisions/042-delegation-tool-loop-guard.md) / T122）

- 起因：glm-5.2 的一条 assistant 消息里有 5709 个 toolCall。前 47 个是真实调用，之后逐字重复 `TaskList {}` → `TaskStop {"delegationIds":[]}` → `TaskWait {…}` 约 1887 轮；流了约 19 分钟被用户 Stop；零执行，usage 全记 0（决策 042 背景）。上限按「一次回复」计，对这种形态无效。
- **形态 B（单条回复内）**：`guardReplyRepetition` 包在 `streamFn` 外（`agent-loop/index.ts:766-807`；`agent-loop/delegationLoopGuard.ts:268-310`）。
  - 只判完整的块：后一个块开始、块自己结束或回复结束时才判，避免把截断的参数误判成相同（`delegationLoopGuard.ts:149-198`）。
  - 同一规范化调用第 3 次，或一条回复里工具族调用超过 16 个，就触发（`:50-71`）。控制类调用只看目标 id，`Task` 看 agent、任务、模型（`:113-136`）。
  - 触发后先取消上游请求，再以 `stopReason:'error'` 结束这条回复：pi 不执行其中任何调用，后续请求的上下文里也没有它（`:209-243`）。运行以 `tool_call_repetition` 失败（`:86`），失败卡「模型输出出现重复调用，已中断」（`renderer/components/chat/sessionFailure.ts:124`）。
- **形态 A（跨回复空转）**：没有在跑、也没有待交付报告时，第一次空调用给完整说明，之后直接拒绝；连续 2 条回复全是空调用，就复用收尾机制结束，不报 `turn_limit`（`delegationLoopGuard.ts:73-83`；`agent-loop/index.ts:836-856`）。根因是报告只在模型不调工具时才由自动续跑送达，模型与 runtime 互相等（决策 042 背景）。
- 范围只限子代理工具族，不做通用循环检测（决策 042 第 1 条；决策 039 第 4 条曾以「误报风险」拒绝通用检测）。
- 取证：每次拦截写一条 `aiclient.loopGuard` 条目（`agent-loop/index.ts:1412`）。
- 紧急开关：`AICLIENT_RUNTIME_LOOP_GUARD=0`（只有精确等于 `0` 才关），只关 B、A 的拦截与取证；上限、报告投递、`TaskStop` 的有界等待不受影响（`runtime/flags.ts:66-82,113-115`；`agent-loop/index.ts:228-242`）。
- 已知限制：被掐断回复实际消耗的 token 仍记 0（T125）。
- 测试：`runtime/__tests__/subagentLoopGuard.test.ts`、`turnCeiling.test.ts`，P1-8 可以照搬规则部分。

### 1.3 其他

- 子代理 `maxTurns`：内置角色 60 / 50 / 40 / 80，上限 80，触顶报 `truncated`（决策 040 第 9 条）。
- provider 空闲超时与重试（runtime-hardening 决策 029）属于 P1-5 的路由配置，不在本题。

## 2 DSH 0.1.7-rc.2

| 能力 | 事实 | 依据 |
|---|---|---|
| 回合 / 步数预算 | 没有。原文：「工具调用或 steer 会让当前回合继续；要限制失控回合，得从已有的生命周期扩展点（如 `agent/turn-stopping`）取消」 | `dsh-agent-loop/README.md:202` |
| 单条回复里的调用 | 回复结束后全部执行，只有并发上限（默认 10） | `dsh-agent-loop/lib/index.js:1137-1140`；`README.md:48` |
| 重复调用 | `repeat-tool-reminder`：同工具同参数连续第 3 / 5 / 8 次时在结果后追加提醒；只提醒不拦截；挂在 `tools/post-execute`，被拒的调用也计；新的用户消息清零；只在内存；第 8 次以后不再出声 | `dsh-repeat-tool-reminder/README.md:12,49,74-87,169-174`；`dsh-base/cordis.patch.yml:454-458` |
| goal | 每个 goal 默认最多 256 轮，到顶记 `round-limit` 阻塞 | `dsh-goal/README.md:12,41-46`；`dsh-goal-round-driver/README.md:53` |
| 子代理 | 只有深度上限 `maxDepth`（默认 1），没有步数上限；自定义定义里的 `maxTurns` 不生效 | `dsh-tool-subagent/README.md` 配置表；决策 064 第 6 条 |
| jobs 唤醒 | 后台任务结束时，空闲的属主被 `followup` 唤醒、开新回合；默认无上限，可设 `maxConsecutiveWakes`，用户消息恢复额度 | `dsh-tool-jobs/README.md:40-42`；`lib/index.js:272-286`；base 行没设（`dsh-base/cordis.patch.yml:274-275`） |
| ralph | 工具级的 `maxRounds` | `dsh-tool-ralph/README.md:12,32` |
| 流空闲超时 | llm-pi-ai 默认 300 s，属于 P1-5 的路由配置 | `dsh-llm-pi-ai/lib/index.js:1091` |

### 2.1 流式阶段能不能中断

- **`llm/stream` waterfall**：`ctx.on('llm/stream', (options, next) => …)` 能包住整条 chunk 流（`dsh-llm/lib/index.js:2365-2372`；`README.md:108`）；现成的例子是 checkpoint 策略（`dsh-session-checkpoint-policy/lib/index.js:60-65`）。loop 发的请求被 `markAgentLoopRequest` 标记，可以用 `isAgentLoopRequest` 与标题生成、压缩摘要这类单发请求区分开（`dsh-llm/lib/index.js:377-388`；`dsh-agent-loop/lib/index.js:1254`）。
- **chunk 协议**：`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`、`usage`、`finish`；`block-end` 带组装好的块，`tool-call` 块有 `name` 与原始 JSON 字符串 `arguments`（`dsh-llm/lib/types/types.d.ts:85-92,409-447`）。所以能像 1.0.x 一样「块完整时再判」。
- **停止读取 = 取消上游**：包装层不再读取时，dsh-llm 关掉适配器的迭代器（`dsh-llm/lib/index.js:2349-2354`），llm-pi-ai 随即 `consumer.abort()` 取消上游请求（`dsh-llm-pi-ai/lib/index.js:1849-1850,1897-1911`）。
- **吐终结 error 的后果**：loop 落 `assistant/attempt`（不进模型上下文）→ `agent/request-error` waterfall → 没有监听者要求重试就抛 `LlmError` → `turn/end {kind:'error', error:{code,…}}`；这条回复里的工具调用一个都不执行（`dsh-agent-loop/lib/index.js:1101-1120`）。与 1.0.x 的 `stopReason:'error'` 等价。
- **重试**：llm-retry 的 normal 模式只重试 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`，always 模式什么失败都重试（`dsh-llm-retry/README.md:47`）。我方网关现在是 normal、`maxRetries: 0`（`dsh-host/bundle/cordis.patch.yml:85-87`），终值由 P1-5 定。
- **对照 `agent.cancel()`**：已流出的 text / reasoning 作为 `assistant/message {interrupted:true}` 进上下文，工具调用被丢弃（`dsh-agent-loop/lib/index.js:1066-1090`；`dsh-llm/lib/index.js:1081-1094`）。它结束整个回合，默认还清空收件箱，没有「只停这一步」的取消（`dsh-agent/README.md:178`）。所以不适合用来掐退化回复。

### 2.2 回合与步的钩子

- **`agent/pre-step`**（waterfall）：每步之前调用，可 `reject`，或把进入本步的消息整批替换；替换时 `startsRequestSeries` 要原样保留（`dsh-agent/README.md:67,85`；`dsh-agent-loop/lib/index.js:902-925`）。收件箱在调用它之前已经 claim，reject 会让这批消息丢失、回合记 `blocked`（`:103-111,954-961`；[P1-4 分片 04](../p1-4-bridge-parity/04-turn-semantics.md) 第 32 行）。
- **`agent/turn-stopping`**（serial）：回合将要自然结束时调用，可以 steer 让它继续（`dsh-agent/README.md:67`；`dsh-agent-loop/lib/index.js:983-989`）。
- **`tools/pre-execute`**：只有 allow / deny / cancel / ask（`dsh-tools/lib/types/index.d.ts:445-460`）；`concludesTurn` 只能挂在成功结果上，拒绝结果不能结束回合（`:413-432`）；`tool/call` 事件在它之前已经落盘（[P1-6 分片 02](../p1-6-permissions/02-dsh-facts.md) 第 53 行）。
- **消息来源**：我方 bridge 的发送用 `{kind:'user'}`（`dsh-host/bridge/dshSessionRuntime.ts:604-615`）；job 完成通知是 `{kind:'tool-jobs', form:'notice'}`（`dsh-tool-jobs/lib/index.js:272-281`）；goal 回合是 `{kind:'goal', round}`（`dsh-goal-round-driver/lib/index.js:134-143`）；来源的 kind 可以是任意非空字符串（[P1-4 方案](../p1-4-bridge-parity.md)第 12 行）。
- **子代理与后台工具**：base 里有 `subagent`（continuable）、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`（`dsh-base/cordis.patch.yml:363-387`）；后台结果经 `job_output`、`job_list`、`job_kill` 取（`dsh-tool-jobs/README.md:32`）。

## 3 差距

- **轮数上限**：DSH 没有，要补。
- **单条回复退化**：DSH 只有执行之后的提醒，而且整条回复都会被执行，要在流阶段补。
- **跨回复空转**：1.0.x 的根因在 DSH 里不存在。DSH 的完成通知对忙碌的 agent 在下一步注入、对空闲的 agent 直接唤醒，`job_output` 在任务结束后第一次读时带回结果（`dsh-tool-jobs/README.md:32,40`）。剩下的「反复轮询」有提醒兜着，推断不必移植。
- **唤醒链**：jobs 的唤醒默认无上限。按 DSH 的回合计数会被它绕过，要按「上一条用户消息以来」计。
- **紧急开关**：宿主环境剔除所有 `AICLIENT_*`（`main/services/agent-host/DshHostProcess.ts:72`），1.0.x 的开关到不了宿主，要显式转发。
