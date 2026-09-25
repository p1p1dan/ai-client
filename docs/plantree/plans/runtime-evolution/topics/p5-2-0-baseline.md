# P5-2-0 · 基线冻结与适配勘察

Role: implementation-plan / gate。日期：2026-09-12。对应[执行顺序](../README.md#执行顺序)第 8 批的第一个子节点。
上位文档：[契约](p5-2-subagent-contracts.md) · [任务与 SA01～22](p5-2-subagent-tasks.md) · [调研](p5-2-subagent-research.md) · [ARD D10/D17](../../../plans/2026-09-08-runtime-evolution-ard.md)

本文件是 P5-2-1～7 动工前必须通过的门禁。它回答两个问题：

1. 参考实现依赖的宿主行为，在我们钉住的 pi 0.84.4 上**实测**是否成立；
2. 从参考搬到本仓时，哪些地方**必须**改、改成什么、为什么。

---

## 1. 冻结的对标基线

| 项 | 冻结值 | 说明 |
|---|---|---|
| 参考仓 | `/home/ai/code/PI-Desktop`，commit `948ee676bdb7b31d496f6603aa03dd12eb95be35` | 本机存在该 commit 对象；工作树 HEAD 是别的分支，读取一律走 `git show 948ee676:<path>` |
| 参考 pi 版本 | core/ai **0.85.0** | 仅作对照，不引入 |
| 本仓 pi 版本 | core/ai **0.84.4**（`src/runtime/package.json`） | **本批不升级**，D12 维持不变，见下方第 4 节 |
| 探针文件 | `src/runtime/__tests__/subagentHostProbe.test.ts` | 10 条，进常规测试套，随 `pnpm test` 跑 |
| 探针执行配置 | `NODE_OPTIONS=--max-old-space-size=1024 npx vitest run src/runtime/__tests__/subagentHostProbe.test.ts --no-file-parallelism --maxWorkers=1` | 开发机 2 核 / 3.3GB，串行且限堆是硬要求 |
| 探针输入 | 全部用 `fauxProvider` 脚本化响应，无网络、无真实模型、无真实子进程 | 固定输入 = 脚本里的 `fauxAssistantMessage` / `fauxToolCall` 序列 |

参考侧被完整读过的源码：`packages/shared/src/subagent-definition.ts`（501 行）、
`packages/agent-runtime/src/subagent-definitions.ts`（432 行）、
`packages/agent-runtime/src/subagent.ts`（684 行）、
`packages/agent-runtime/src/runtime.ts` 的 220–350 / 2390–2470 / 2055–2090 / 2605–3330 / 5360–5500 区段。

> **读参考 runtime.ts 必须加 `grep -a`。** 该文件含裸 NUL 字节，普通 `grep` 会把它当二进制静默跳过、
> 返回空结果。第一次查 `subagent` 时就踩到了，**零命中不等于没有**。

---

## 2. 宿主能力探针：0.84.4 实测结果

10 条全部通过。结论按参考实现依赖的四组行为分列。

### 2.1 同进程两个 Agent 互不串（子代理的立身之本）

| 探针 | 实测 |
|---|---|
| 两个 `Agent` 各自 `subscribe`，子跑完一整轮 | 父订阅者收到**零**个事件；父的 `state.messages` 里没有子的任何文本 |

参考把子代理做成同进程第二个 `Agent`，前提是子的 `agent_end` 不会流到父的订阅者——否则每个子任务跑完都会结束父回合。0.84.4 满足。

### 2.2 子事件序列完整

一次「工具调用 → 报告」的子运行，实测事件齐全：
`turn_start` ×2、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_end`、`agent_end`。

`turn_start` 出现两次（两次 provider 请求各一次），这条是 heartbeat 里 `turns` 计数的来源。
调研 §「必要适配」第 8 条怀疑过「registry 从不转发 turn_start」，现已确认事件本身存在，
计数问题在参考自己的转发链上，不是 pi 缺事件。

### 2.3 `afterToolCall` 的两个能力

| 行为 | 实测 |
|---|---|
| 返回 `{ isError: true }` | 该 tool result 在 transcript 里被标成 `isError: true` |
| 返回 `{ terminate: true }` | 循环在本批之后停止，第二次 provider 请求**没有发出**（callCount=1，脚本里还剩 1 条未用） |
| 一批两个调用、只有一个返回 `terminate` | **不停**，第二次请求照发（callCount=2） |

第三条是 0.84.4 类型注释里写明的合并语义：「Early termination only happens when
**every** finalized tool result in the batch sets this to true」。这直接决定了
子代理 `maxTurns` 的实现方式——**上限必须逐个调用求值**，不能只在批次层面判一次，
否则两调用批次里的上限根本不会生效。参考的 `afterToolCall` 正是逐调用返回，本仓照此实现。

### 2.4 批次并行规则（`Task` 能并行、别的不能，靠的就是它）

0.84.4 的 `agent-loop.js:287` 判据与参考依赖的一致：

```js
const hasSequentialToolCall = toolCalls.some(tc => tools.find(t => t.name === tc.name)?.executionMode === "sequential");
if (config.toolExecution === "sequential" || hasSequentialToolCall) { /* 串行 */ }
```

| 探针 | 实测 |
|---|---|
| 两个工具都 `executionMode: 'parallel'` | 两次执行时间窗**重叠** |
| 一个 parallel + 一个 sequential | **不重叠**（整批串行） |
| Agent 构造时 `toolExecution: 'sequential'`，工具仍标 parallel | **不重叠**（Agent 级设置压过工具级） |

三条合起来意味着：把 `Task` 标 `parallel`、其余全标 `sequential`，就得到参考的
「只有全 Task 的批次才扇出」；子 Agent 构造时给 `toolExecution: 'sequential'`，
子代理内部工具必然逐个跑。两条都成立，无需改 pi。

### 2.5 取消与重试

| 探针 | 实测 |
|---|---|
| 工具执行中 `agent.abort()` | 工具的 `signal` **确实收到 abort** |
| 同上，之后 | **循环没有当场结束**：pi 记下 tool result，又发了一次 provider 请求，该请求回来时 `stopReason: "aborted"`，然后才 `agent_end` |
| 工具在 abort 时抛异常 vs 正常返回 | **行为完全一样**（都是 callCount=2、stopReason 序列 `['toolUse','aborted']`） |
| `state.messages` 弹掉失败的 assistant 消息后 `continue()` | 成功续跑，用户消息仍只有一条（是「重问」不是「重新 prompt」） |

**第二条是本次探针唯一的意外，也是最该记下的一条。** 原本按参考语义假设 abort 当场收敛，
实测不是：**取消一个子代理会多花一次 provider 请求**。两个直接后果：

- `TaskStop` 必须像参考那样 `await record.completion`（即等 `run()` 返回、等过 `waitForIdle()`）
  才能报「已停止」。当场报停止会撒谎——那次多出来的请求还在飞。契约 §3 的
  「发 abort 后等待任务/工具/记录真实收敛」有了实测依据，不再只是措辞。
- 成本核算里，被停掉的子任务**不是零成本**。SA15 的「子成本恰计一次」要把这次 aborted 请求算进去。

第四条给重试路径背书：参考 `retryPendingProviderFailure()` 靠「弹掉失败消息 + `continue()`」
实现「重试请求而不重放已执行工具」，0.84.4 支持。

---

## 3. 适配差异矩阵：从参考搬到本仓必须改的地方

按契约 §4「每个矩阵项须有行为要求、适配说明和测试证据」的口径，先把**行为要求**和**适配说明**定下来，
测试证据由对应子批次补。

### 3.1 P4 接缝（契约 §6 要求 P5 执行者复核的五条）

读的是 `src/runtime/worker/nativeWorkerRuntime.ts` 与 `src/runtime/plugins/agent-loop/index.ts` 的当前实现。

| 接缝 | 本仓现状 | P5-2 必须改成 |
|---|---|---|
| 逻辑 run 边界 | `startSend` 只**受理**回合并立刻返回；`handle.run()` 在带外跑，`.finally()` 里清 `this.turn`。**`run()` 的 promise 就是逻辑回合边界** | `AgentLoopPlugin.execute()` 现在 `await agent.waitForIdle()` 后就收尾。必须在这里插入「还有子任务在跑就继续等」，`run()` 的 promise 直到子任务结算并交回报告后才 resolve（契约 §6.1） |
| completed / idle 事件 | `projected.finish(result)` 发 `session.status: idle` | 父 Agent 暂时 idle 但仍有子任务时**不能**发。分流点在同一处 |
| 交叠 run | `startSend` 见 `this.turn` 已存在就抛 `WORKER_SESSION_BUSY` | **已满足**契约的「不接受交叠 run」，无需改动。槽位 busy 也随 `this.turn` 自然保持 |
| 用户 Stop | `stop()` abort `turn.controller`，该 controller 的 signal 就是 `run()` 收到的 `request.signal`；**不 await**，靠回合自己的终态事件报告完成 | 子任务要挂在**这个 run 级 signal** 上（用户 Stop 取消全部子任务），但**不能**挂在 `Task.execute` 的每次调用 signal 上——那个 signal 在 Task 立即返回后就没意义了。`stop()` 不 await 的设计正好与「TaskStop 要 await 真实收敛」相反，两条要分别实现，不能共用一个路径 |
| 审批出口 | `stop()` 里 `approval.bridge.cancelAll('aborted')` | 子代理的审批卡也走同一个 bridge；取消时要能按 delegationId 区分，不能把另一个会话的卡一起取消 |
| 定义热更新 | 无 | 每个顶层 run 开始时重读活动定义；运行中的子 Agent 固定启动时快照 |

### 3.2 工具名与能力

| 参考公开的七工具 | 本仓对应 | 差异与处置 |
|---|---|---|
| `Read` | `read` | 大小写差异，需一处映射层 |
| `Glob` | `glob` | 同上 |
| `Grep` | `grep` | **能力缺口**：本仓 `grep` 是**纯字面子串匹配**（`plugins/tools/index.ts` 里 `lines[line].includes(needle)`），无正则；参数是 `include` / `caseInsensitive` / `limit`，没有参考提示词里用到的 `outputMode` / `headLimit`。`explorer` 内置角色的提示词明写「Prefer Grep for text/**regex** patterns」。契约 §4 禁止「删提示词掩盖功能缺口」，所以 **P5-2-3 必须补正则检索**，不是可选项 |
| `BrowserPreview` | **无** | 本仓完全没有等价工具。契约 §4 点名它是本批必须落地的宿主能力（工作区 HTML 预览、编辑后自动刷新、前台归属、不可用时明确报错）。**P5-2-3 落地；未接通前 SA20 那行必须保持未验收，不能代签** |
| `Bash` | `bash` | 见下方超时差异 |
| `Edit` | `edit` | 名字外还有协议差异（行锚参数），需验证转换后调用真的有效 |
| `Write` | `write` | 大小写差异 |

本仓另有 `skill`、`ask`、MCP 工具、`new_context`——按契约 §4 一律**不进**子代理可分配集合。

### 3.3 Bash 超时

| | 参考 | 本仓 |
|---|---|---|
| 默认 | 60s | **120s**（`tools/index.ts:354`，`args.timeoutMs ?? 120_000`） |
| 上限 | 6h（21600s） | **10min**（`timeoutMs` 的 `maximum: 600_000`） |

契约 §4 的处置：**本批不改父 bash 的无参数默认值**（保持 120s），但 `test-runner` / `fixer`
这类跑构建的角色需要长任务能力，P5-2-3 补**显式超时**适配——复刻接口以秒表达、内部转毫秒，
并把上限提到参考量级。长任务用假时钟验证，取消路径用现场小样本验。不允许自动重跑命令。

### 3.4 定义文件目录（与契约字面值的一处**有意偏离**）

契约 §2 写的是 `~/.agents/subagents/*.md`。**本仓不照抄这个路径。**

理由是 H/19「统一 agent 目录」（用户 2026-09-10 方向变更，`4284c893` 已落地）：
两种模式一律用本应用自己的 agent 目录。第 7 批的 P5-1 已按这条把技能放在
`<agentDir>/skills`、模板放在 `<agentDir>/prompts`（`plugins/skills/index.ts:145-165`）。
子代理定义照同一规则落在 **`<agentDir>/subagents/`**。

`~/.agents/subagents` 仍作为**兼容读取**来源（P5-1 的技能就是这么处理的：
`<agentDir>/skills` 与 `~/.agents/skills` 都读）。项目目录一律不自动提升为可信全局定义，这条与契约一致。

> 这是范围内的必要适配，不是缩减：目录换了，可观察能力不变。记在这里以免后续被当成漏做。

### 3.5 旧插件互斥

| | 旧 `@gotgenes/pi-subagents`（legacy 后端随包） | 新 native |
|---|---|---|
| 工具名 | `subagent`、`get_subagent_result`、`steer_subagent` | `Task`、`TaskWait`、`TaskList`、`TaskStop` |
| 定义目录 | `<agentDir>/agents`（全局）、`<cwd>/.pi/agents`（项目） | `<agentDir>/subagents` |

工具名**不重叠**，所以不会因重名崩溃——但这恰恰是风险：两套委派系统可以同时注册，
模型会看到两份能力。契约 §2 要求互斥，P5-2-5 要实现开关，并给旧全局定义做显式迁移预览（保留原文件）。

旧插件还有本仓没有、也**不复刻**的东西：`steer_subagent`（中途改写子任务）、前台/后台两种运行模式、
`ask-parent-tool`（子问父）。调研 §「必要适配」第 10 条已定性：参考实现没有中途改写能力，
本轮不把复刻扩大成新通信协议。

### 3.6 审批面差异（现场已知事实，影响 SA10 的取证方式）

native 后端的权限审批是本仓自己的结构化中文权限卡；legacy 后端是 pi 插件自己的英文 `ui.select` 弹窗。
两者**不是同一张卡**。SA10「审批来源正确」取证时只认一种会读成「没弹审批」，验收脚本要分后端写。

### 3.7 子代理提示词里的会话事实（`subagentGuidance`）

参考的五块引导里有两块本仓当时没有对应，按「缺席而不伪造」处理，记为差异而非缺口：

- **Shell 方言**：参考靠 `commandShell` 记录方言，本仓 exec 出口没有这个事实可陈述。
  ✅ **已解决（2026-09-25）**：新增 `environment` 提示词段（`plugins/prompt/environment.ts`），
  由 bootstrap 一次性给出工作目录、平台、bash 实际使用的 shell 与日期，主循环与子代理共用；
  子代理只有声明了 `bash` 才带 shell 部分。
- **Scratch 目录**：本仓没有会话级 scratch 根，写 `$PI_SCRATCH_DIR` 等于让子代理写进一个没人设置的变量。仍保持缺席。

---

## 4. D12 不升级的记录

契约与任务表都要求「不得未经决策升级 D12」。本批**维持 pi 0.84.4**，理由：

- 参考依赖的四组宿主行为（同进程双 Agent 隔离、`afterToolCall` 的 isError/terminate、
  批次并行判据、abort 与 `continue()`）在 0.84.4 上**已实测全部成立**，没有一条需要 0.85.0 才有的能力；
- 升级会同时动到 P2-5/P2-6 刚测完的缓存命中率基线（99.97%）与 P4 的载体矩阵，代价远大于收益；
- 若后续某个子批次遇到 0.84.4 确实缺的能力，按契约走决策记录，不在执行途中静默跟随上游 HEAD。

---

## 5. 门禁结论

P5-2-0 **通过**。可以开工 P5-2-1。

带着往下走的三条硬约束：

1. `maxTurns` 必须逐个工具调用求值（2.3 第三条）。
2. `TaskStop` 必须等真实收敛，且被停的子任务要计入成本（2.5 第二条）。
3. BrowserPreview 与 grep 正则是 P5-2-3 的**必交项**，不是优化项（3.2）。
