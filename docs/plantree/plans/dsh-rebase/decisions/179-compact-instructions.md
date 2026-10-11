# 决策 179：`/compact <说明>` 生效——说明只加在这一次摘要请求的末尾，摘要行显示所用说明；`/compact` 启动阶段发消息也改为排队

日期：2026-10-11。**状态：第 1 节为用户裁决（2026-10-11）；第 2 节起为自主决定，待用户审批。**

代码提交：`a509e5ae`（宿主与投影）、`d022e3f1`（输入框与启动阶段排队）、`fa936117`（录制场景）。

代码：尚未提交（工作树，HEAD `62731214`）。

来源：用户 2026-10-11 拍板「做」（经编排者转达）：`/compact 保留未完成的任务和失败经验` 这类说明要真正影响这一次手动压缩的摘要；同日追加「`/compact` 的『正在启动对话…』阶段按 Enter / Ctrl+Enter 也进现有队列」。

修订关系：

- [决策 099](099-p1-4d-scope-dsh-data-only.md) 第 10 条（`worker.compact` 不带参数、`instructions` 非空就拒绝）与「用户可见变化」里的「`/compact` 不接受附加说明」：**部分推翻**。DSH 的 `/compact` 命令仍然不带参数执行；说明不再被拒，改为加在这一次的摘要请求里（第 3 节）。原拒绝码 `WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED` 保留，只用于 fail-safe（第 4.3 节）。
- [决策 113](113-p1-4d2-commands-and-projection-choices.md) 第 8 条（不发直播事件）：不变。第 9 条：加两种结果（过长 `WORKER_COMPACT_INSTRUCTIONS_TOO_LONG`；成功答复多 `instructionsApplied`）。第 10 条（「/compact 不接受附加说明」的提示）：**推翻**，提示改写为 fail-safe 用语（第 5 节）。第 16 条（`compact` 场景里带说明的调用被拒，`rpc.compact.refused`）：**推翻**，带说明的情形移到新场景 `compact-instructions`（第 6 节）。第 17 条（bridge-smoke 判定「`worker.compact` 拒绝说明」）：改为「接受说明、过长被拒」。
- [决策 176](176-session-commands-start-before-run.md) §5「启动中 · 发消息」一行（不发出、提示「等对话启动后再发送」、文字留在输入框）：**推翻**，改为排队（第 7 节）。§3.2 其余不变。
- [决策 178](178-compaction-progress-and-send-during-compact.md) 第 5 节（压缩阶段排队）：范围扩到启动阶段；「启动阶段维持决策 176」一句与第 11 节对应的待审批项由本决策了结。
- [决策 140](140-p1-7e-e2b-choices.md)（压缩成功即在时间线末尾出摘要行）、决策 144（摘要行标题随界面语言）、[决策 177](177-auto-compaction-policy-per-model.md)（按模型的摘要输出上限）：不变。自动压缩不受影响（第 3.4 节）。

## 1 用户裁决（2026-10-11）

1. 做：`/compact <说明>` 中的说明要额外约束本次手动压缩的摘要。不带说明时行为完全不变；自动压缩不受影响；不改 DSH 内核文件。
2. 编排者转达的推荐方向：bridge 不再拒绝说明，按会话暂存、只对这一次手动压缩有效；在我们自己的宿主行里包装 DSH 压缩服务的 `summarize`，把说明加在 DSH 摘要指令之后、不破坏缓存前缀；包装装不上时 fail-safe（退回「不接受说明」并明确提示），不得静默忽略；说明去首尾空格、限长、纯文本；斜杠菜单说明改为「可附加说明」；摘要行或悬停提示显示本次说明，重开对话也看得到；首页与带附件时的现有拦截（决策 175、176）不变。
3. 追加：`/compact` 的「正在启动对话…」阶段按 Enter / Ctrl+Enter 也进现有队列（与决策 178 压缩阶段一致），输入框清空，启动 + 压缩都结束后自动发出；启动失败或压缩失败也照常发出（启动失败时按发消息的正常路径处理，失败卡照旧）。

## 2 现状（HEAD `62731214` 上逐条核实）

| 环节 | 位置 | 现状 |
|---|---|---|
| 渲染层 | `slashCommands.ts` `resolveSlashAction`（约 200-214） | `/compact` 后面的文字解析成 `instructions` |
| IPC / preload / Main | `chat.ts` 896、`preload/index.ts` 1142、`WorkerManager.compactSession` 1597 | `instructions` 原样透传 |
| bridge | `dshSessionRuntime.ts` `compact`（约 1609） | 非空就抛 `WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED`；随后 `ctx.commands.execute(agent, '/compact', [], signal)` |
| DSH 命令 | `dsh-command-compact/lib/index.js:49-73` | `rawInput` 非空答 `Usage: /compact (no arguments)`；否则 `ctx.compaction.compactNow(agent, signal, commandId)` |
| DSH 压缩 | `dsh-compaction-basic/lib/index.js` | 见第 4.1 节 |

结论：说明在 bridge 被拒，DSH 的命令本身也不收参数；能插手的只有压缩服务的摘要钩子。

## 3 做法（自主决定）

### 3.1 走向

DSH 的 `/compact` 命令照旧不带参数执行（日志里的 `command/run`、`command/done` 与以前一样）。说明不作为参数，而是在这条命令执行期间「租」给这个会话的摘要请求：

1. bridge `compact()`：`readCompactInstructions` 读说明（第 3.3 节）；过长当场拒绝；没有说明就与以前一字不差。
2. 有说明：`armCompactInstructions(ctx.compaction, <DSH 会话 id>, 说明)` 拿到一个租约（lease），再确认一次空闲，然后执行 DSH 的 `/compact`；无论成功、失败、超时，`finally` 里归还租约。同一会话已有租约在外时答 `WORKER_SESSION_BUSY`（实际到不了：Main 先答 `compact_in_progress`，bridge 的请求链也是串行的）。
3. 包装后的 `summarize`（`bridge/compactInstructions.ts`）：按 `agent.session.id` 找租约；没有租约就原样调用 DSH 的实现（同一个 `this`、同样的参数）；有租约就把 DSH 实现里用到的 `this.ctx.llm` 换成一个只改 `stream` 的视图，DSH 照常组装请求，视图在发出前检查形状（第 4.2 节），把说明接在最后一条消息（DSH 的模板）的文字末尾，再交给真正的 `llm.stream`。
4. 说明在摘要请求里的样子（英文，与 DSH 模板同语言）：

   ```
   <DSH 的 COMPACTION_INSTRUCTION 原文>

   Additional instructions from the user for this checkpoint:
   <user-instructions>
   保留未完成的任务和失败经验
   </user-instructions>
   Follow these instructions while keeping the exact structure above: every section, in order. Put what they ask you to keep or stress into the matching sections (for example Pending Jobs, or Errors and Fixes), or into Critical Context when no section fits.
   ```

   - **不复制 `summarizeWithLlm`**：DSH 的实现（目标模型选择、`maxTokens`、`toolHistory`、`sessionId`、`purpose`、BlockAssembler、失败分类）全部照旧执行，我们只在它要发出的那一刻改最后一条消息的文字。
   - **缓存前缀不变**：前面的系统提示词、工具、被压的那段对话一个字节都不动；说明只出现在 DSH 本来就新加的最后一条消息里。录制场景实测：摘要请求相对上一条 agent 请求是 `verdict=append added=1`（第 6 节）。
   - **追加在同一条消息、同一个文本块末尾**，而不是另起一条用户消息或另起一个文本块：两条连续的用户消息在 Anthropic 线上会被合并、在别的协议上未必；另起文本块在 OpenAI 兼容线上的拼接方式各家不同。接在文字末尾在所有线上都是同一个意思。
   - **放在模板之后**而不是之前：模板说「把上面的对话压成…」，放在前面会被当作对话内容总结掉。

### 3.2 摘要行与回放

- **摘要行**：手动压缩的摘要行（第一块仍是 `<行 id>:summary:0`，`isDshSummaryRow` 不变）后面多一块 `<行 id>:compact-instructions:0`，文字是英文键 `Instructions for this summary: {{instructions}}` 的英文渲染，带 `notice: {key, params}`；渲染层现有的 `NoticeMessage` 按界面语言显示「本次压缩的附加说明：…」，说明原样（`{{…}}`、`$&` 都不被解释）。没有说明的摘要行与以前完全一样（已有样本不变）。自动压缩的摘要行即使查得到也不加。
- **为什么不写进 DSH 日志**：DSH 的 `session.append` 不支持给运行中的会话写可忽略（`ignorable`）事件，只有种子能带；写一个 DSH 不认识、又不带 `ignorable` 的事件，DSH 下次读日志会拒绝整个会话（`dsh-session/lib/index.js` 的读路径，约 298 行与 `KNOWN_SESSION_EVENT_TYPES`）。`compaction/summary` 的字段由 DSH 自己挑（`commitCompactionBody`），也带不进去。改检查点正文会让说明进模型上下文，不选。
- **存在会话桩（stub）里**：`$DSH_HOME/aiclient-sessions/<id>.dsh.json` 新增可选字段 `compactInstructions: [{compactionId, instructions, at}]`，按 DSH 的 `compactionId`（检查点 `source.compactionId` 上就有）对应摘要行。选桩而不是另起一个旁车文件：桩的删除、孤儿回收、回退（`...stub` 原样保留）都已有，旁车要在 Main 的 GC、bridge 的孤儿回收、旧版导入三处各补一遍。
  - **上限**：最多 20 条、说明合计 12,000 字符，超出丢最旧的（被丢的那几行重开后不再显示，摘要本身不受影响）。理由：Main 把超过 64 KiB 的桩当成「不是桩」（`dshSessionGc.ts` 的 `MAX_STUB_BYTES`），那会让这个会话的回退血统失去孤儿回收的保护。
  - **读**：`stubCompactInstructions` 只取形状正确的条目，坏的跳过，永远不因为这一字段让对话打不开（`isSessionStub` 不检查它）。
  - **分叉**：子会话的桩带上父桩的全部条目（子会话继承的摘要行 `compactionId` 不变）。
- **直播时的绑定**：bridge 在 `session/event` 里看到本会话、租约已经用上时的 `compaction/summary`（DSH 先写它、再写检查点），记下它的 `compactionId` 与说明；历史缓存随后折叠检查点时就能查到。命令成功后再把这一条写进桩（失败只记日志：摘要已经写成，只是重开时少这一行）。
- **三处投影都传查找函数**：bridge 的历史缓存（`historyCache.ts`）、Main 的预览（`readPage.ts`，从它已经读的桩里取）、分叉答复里的首页。会话分支对话框里退役会话的预览只用摘要行第一块，不受影响。
- **答复**：`WorkerCompactResult` 多一个可选字段 `instructionsApplied`（只在给了说明时出现）：`true` 是摘要请求带上了说明；`false` 见第 4.3 节。

### 3.3 说明的校验（`shared/compactInstructions.ts`，输入框与 bridge 共用）

- 纯文本：`\r\n` / `\r` 统一成 `\n`；除制表符与换行外的控制字符删掉；去首尾空白；不解释任何标记。
- 全是空白等于没有说明（`/compact` 本身）。
- 上限 **2000 个字符**（按 Unicode 码点数，一个汉字、一个表情各算一个）。理由：够写几条具体要求；说明进的是一次未命中缓存的摘要请求，2000 字符最多约千余 token，相对被压的上下文可以忽略；再长就更像是要另写一条消息。
- 超长整条拒绝、不截断：输入框当场提示、什么都不发、文字留在输入框；bridge 对绕过输入框的调用同样拒绝（`WORKER_COMPACT_INSTRUCTIONS_TOO_LONG`，说明「nothing was compacted」）。

### 3.4 不受影响的

- `/compact` 不带说明：bridge 走原来的路径，摘要钩子虽已包装，但没有租约时原样调用 DSH 实现（同一个 `this`）。录制样本 `compact` 的日志、流与历史逐字不变（第 6 节）。
- 自动压缩（压力、超窗）：只在回合内发生；手动压缩期间 agent 被 `runMaintenance` 占着，不会有回合；租约在命令结束时归还，之后的自动压缩查不到租约。其他会话、子代理的会话 id 不同，查不到。
- 首页的 `/compact`（决策 175）、带附件的 `/compact`（不当命令）、回合进行中拒绝（决策 176）：不变。

## 4 依赖的 DSH 内部点与升级复核

### 4.1 依赖点（DSH 0.1.7-rc.2，`src/dsh-host/node_modules/@deepseek-ai/…`）

| 依赖 | 位置 | 用途 |
|---|---|---|
| 压缩服务名 `compaction`，实例上有 `summarize` | `dsh-compaction/lib/index.js:169-173`；`dsh-compaction-basic/lib/index.js:899-903`（注释写明「Override this sole hook」） | 找到并包装钩子 |
| 事务经实例动态调用 `summarize` | `dsh-compaction-basic/lib/index.js:1013-1016`（`regionDependencies`）、`:587`（`summarizeCompaction`） | 实例上的自有属性覆盖原型方法后能生效 |
| `summarize` 经 `this.ctx` 取模型服务 | `:902`（`summarizeWithLlm(this.ctx, …)`）、`:323`（`ctx.llm.stream(options)`） | 换 `this.ctx.llm` 的视图 |
| 请求形状：`[...input.messages, 模板用户消息]`、`purpose: "compaction"` | `:305-311`、`:320` | 形状检查与追加位置 |
| 模板 `COMPACTION_INSTRUCTION` | `:243-278` | 只在其后追加；不复制、不改 |
| `agent.session.id` 标识会话 | `:319` | 按会话找租约 |
| `compaction/summary` 先于检查点写入，两者带同一 `compactionId` | `:628-661`；检查点来源 `compactCheckpointSource`（`dsh-compaction/lib/index.js:116-122`） | 直播时绑定、回放时对应 |
| 手动压缩保留区为 0 时最后一个节点留下 | `:410-433`（`selectCompactableRange`） | 解释录制里的 `added=1` |
| Cordis 可追踪代理把原对象挂在 `Symbol.for('cordis.original')` | `cordis/lib/index.js:38`、`:127` | 包装装在原对象上（`ctx.get` 拿到的是代理） |
| `ManualCompactionError('summary')` → 命令答「Compaction could not produce a useful summary.」 | `dsh-compaction-basic/lib/index.js:524-528`、`dsh-command-compact/lib/index.js:31-34` | 钩子拒发时压缩失败、什么都没压 |

### 4.2 形状检查（每次真正发出前、以及第一次租约前的试跑都做）

摘要请求必须同时满足：`purpose === "compaction"`；消息数 = 传给钩子的对话条数 + 1；前面每一条与传入的对话逐条相同（同一对象，或深相等）；最后一条是用户消息、内容全是文本块。不满足就不发出。

### 4.3 fail-safe（不静默忽略）

| 情形 | 何时发现 | 结果 |
|---|---|---|
| 没有压缩服务、没有 `summarize` | 第一次带说明的 `/compact`，在执行任何东西之前 | `WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED`（「当前引擎版本的 /compact 不能附加说明」），什么都没压；`/compact` 本身照常 |
| 钩子试跑不符：试跑用一个只记录、随即抛出的假模型服务和假 agent 调一次原实现（什么都不发、不碰真实服务），必须恰好发起一次形状正确的请求；2 秒不答也算不符 | 同上（每个服务实例只试跑一次，结果缓存在实例上） | 同上；钩子不被包装，DSH 行为完全不变 |
| 真实请求形状不符 | 摘要请求发出前 | 不发出；压缩以 DSH 的「could not produce a useful summary」失败，bridge 改答 `WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED`（附原因，「nothing was compacted」）；该实例此后带说明一律在执行前拒绝 |
| 摘要写成了，但租约从未用上（DSH 换了调用路径，钩子不在路上） | 命令成功后 | 答复 `instructionsApplied: false`，输入框在「已压缩」之后再提示「已压缩，但没有用上附加说明」；该实例此后带说明一律拒绝；桩里不记 |

bridge 日志对应 `[dsh-bridge] /compact instructions refused: <原因>`、`[dsh-bridge] /compact summarized without its instructions`。

### 4.4 升级复核清单（DSH 升级时）

1. 跑 `vitest run src/dsh-host/bridge/__tests__/compactInstructions.test.ts`：`[179-H-09]` 直接对安装的 `dsh-compaction-basic` 原型做试跑与带说明的调用，断言模板仍以「You are now acting as a compaction engine」开头、含 `## Pending Jobs`、`## Critical Context`，带说明的请求 = 原请求 + 末尾说明。失败即说明依赖点变了。
2. 读 `dsh-compaction-basic` 的 `summarize`、`summarizeWithLlm`、`regionDependencies`：是否仍经 `this.summarize` 调钩子、仍经 `this.ctx.llm.stream` 发请求、仍是「对话 + 一条模板用户消息」、`purpose` 是否仍为 `compaction`。
3. 模板若改了小节名：本决策的提示语举例用了 `Pending Jobs`、`Errors and Fixes`、`Critical Context`，要跟着改 `compactInstructionsPrompt`。
4. `compaction/summary` 与检查点的先后、`compactionId` 是否仍在两处都有。
5. `--check` 全量录制，`compact-instructions` 的 `summaryRequest` 应仍为 `verdict=append`、`templateFirst`、`instructionsLast`；`templateEndsWith` 是 DSH 模板的最后一行，DSH 改模板时它会出差异，属预期。
6. bridge-smoke 宿主 H 的 `compactTakesInstructions`：新会话上带说明的 `/compact` 必须走到 DSH 的「没有可压缩的内容」（`WORKER_COMPACT_UNAVAILABLE`），而不是 `UNSUPPORTED`。

## 5 界面（自主决定）

| 位置 | 英文键 | 中文 |
|---|---|---|
| 斜杠菜单 `/compact` | Compact the context of this conversation; instructions may follow | 压缩当前对话的上下文（可在后面附加说明） |
| 摘要行下的一行 | Instructions for this summary: {{instructions}} | 本次压缩的附加说明：{{instructions}} |
| 过长（标题 / 正文） | The instructions after /compact are too long / Keep them to {{max}} characters (now {{length}}). | /compact 后面的说明太长了 / 最多 {{max}} 个字符（现在是 {{length}} 个）。 |
| 过长（bridge 拒绝，不知道长度） | Keep them to {{max}} characters. | 最多 {{max}} 个字符。 |
| fail-safe（标题 / 正文） | This engine version cannot add instructions to /compact / Remove the text after /compact, then press Enter again. | 当前引擎版本的 /compact 不能附加说明 / 删掉 /compact 后面的文字，再按一次 Enter。（正文沿用原词条） |
| 摘要没用上说明 | Compacted without your instructions / This engine version did not pass them to the summary. | 已压缩，但没有用上附加说明 / 当前引擎版本没有把说明交给摘要。 |

- 新词条在 `src/shared/i18n.ts` 文末单独一块（`// Compact instructions`）。删掉不再使用的 `Compact the context of this conversation`、`/compact takes no instructions`，以及第 7 节不再使用的 `Wait for the conversation to start`、`Your message stays in the input box; send it once the conversation runs.`。
- 摘要行的说明直接显示在摘要正文之后（同一张卡、同一段落样式），不放悬停提示：悬停在触屏与键盘下看不到，且回放时它就是这一行的一部分。说明为什么放在摘要之后而不是标题下：摘要行第一块必须是摘要（`isDshSummaryRow` 与会话分支预览都按第一块认），不改已有行结构。

## 6 录制场景与假网关（自主决定）

- 假网关（`fake-gateway.mjs`，`dsh-p0-2`）：摘要请求的最后一条消息带 `<user-instructions>…</user-instructions>` 时，答复在通常的摘要后多一节 `## Critical Context`，引用这段说明；其余请求不变。
- 录制器（`bridge-record.ts`）：新场景 **`compact-instructions`**（独占一个宿主和一个工作区 `<workspace>/compact-instructions`，排在最后；只有录它时网关才开 `--capture`）：两轮 → 2001 字的说明被拒（`TOO_LONG`，执行前）→ 带说明（含首尾空白与 `\r\n`）的 `worker.compact` → 从网关抓下的请求里取摘要请求与它之前的 agent 请求，用宿主自己的前缀规则（`requestPrefix.ts`）比较，不是「工具、系统提示词相同且消息为追加、模板在前、说明在末尾」就让录制失败 → 关掉通道，从桩重开同一会话，`history` / `tree` 取重开后的。`rpc` 里记 `compact.{tooLong, compacted, eventsAfter}`、桩里的 `compactInstructions`、`summaryRequest`（判定、模板最后一行、追加的整段文字）。
- 实测（`rpc.compact-instructions.json`）：`summaryRequest.verdict = "verdict=append added=1"`（整份请求，含配置），`sameTools`、`sameSystem` 为真，`templateFirst`、`instructionsLast` 为真；摘要正文带网关引用的说明；答复与重开后的历史里摘要行都有说明那一块；`eventsAfter = 0`。
- `compact` 场景去掉了带说明的那次调用（它不再被拒），其余不变。**已有样本的差异**：`rpc.compact.json` 少 `compact.refused` 一项；本次没有重录，留给收口时重录。
- `dshHistoryGolden.test.ts` 的场景清单加 `compact-instructions`，投影时从 `rpc.compactInstructions` 取查找函数（与 bridge 同源）；`dshStreamReplay.test.ts` 加该场景的断言并列入「重开与直播不同」（摘要行随 `/compact` 的答复而来，不在流里，与 `compact` 同因）。

## 7 `/compact` 启动阶段发消息改为排队（用户 2026-10-11 追加；修订决策 176 §5、决策 178 第 5 节）

- `ChatComposer.tsx` `handleSend`：「本窗口的 `/compact` 在途」从「只有压缩阶段」改为「启动或压缩阶段」（`selectCompactPhase(...) !== undefined`），两段都按忙处理：Enter / 发送按钮把消息放进现有队列（队列条显示、可删、可「立即发送」），输入框清空，不再弹「等对话启动后再发送」；Ctrl+Enter 不调插话，同样排队。原来启动阶段的提示分支删除。
- 队列释放不用改：`useQueueRelease` 的 `isInFlight` 自决策 178 起就是 `compactPhase !== undefined`，启动与压缩两段都按住；`/compact` 结束（压缩成功、失败、启动失败、对话被结束）阶段清除，队列照常释放、自动发出。
- 启动失败：`/compact` 的提示与失败卡照旧（决策 176）；排队的消息随后经正常发送路径发出——它自己会再试着启动对话，起不来就按发消息的既有规则出失败卡。
- `/compact` 的命令文字本身照旧：成功才清掉，其余结果留在输入框（决策 176）；排队的消息已归队列所有，不受影响。

## 8 验证（2026-10-11，开发机，一次一个测试进程，每次先看 `free -m`）

### 8.1 新增与改写的测试

- `src/shared/__tests__/compactInstructions.test.ts`（新）：`[179-IN-01]`～`[179-IN-04]`（空、纯文本规整、2000 / 2001 字与表情计数、摘要行英文渲染与中文词条、`$&` 与 `{{…}}` 原样）。
- `src/dsh-host/bridge/__tests__/compactInstructions.test.ts`（新）：`[179-H-01]`～`[179-H-08]`（无租约原样、有租约只改末尾且前缀为同一对象、两会话并发各用各的、同会话第二个租约 busy、四种装不上的情形不包装且不发任何请求、真实请求形状不符时不发出并标记、`markUnused`、Cordis 代理下装在原对象上、形状检查各分支）；`[179-H-09]` 用安装的 DSH `BasicCompactionEngine` 原型做升级检查；`[179-STUB-1]`、`[179-STUB-2]`（桩的上限与坏条目）。
- `commandsAndState.test.ts`：删 `[D2-COMPACT-INSTRUCTIONS]`；新 `[179-B-01]`～`[179-B-07]`（租约生效 + 摘要行带说明 + 写桩、之后不带说明恢复原样；DSH 拒绝与超时后租约都已归还；过长与没有压缩服务在执行前拒绝、空白等于没有；真实请求不符答 `UNSUPPORTED` 且不发出、此后执行前拒绝；没用上答 `instructionsApplied: false`；同会话并发第二个 busy；从桩重开历史带说明、坏条目跳过）。
- `projection.test.ts`：`[179-PROJ-1]`、`[179-PROJ-2]`；`readPage.test.ts`：`[179-PREVIEW]`（预览与缓存同页）。
- `dshHistoryGolden.test.ts`、`dshStreamReplay.test.ts`：见第 6 节；`compact` 场景改为不读 `refused`（新旧样本都通过）。
- 渲染层 `compactCommand.test.ts`：`[CC-08]` 改写为 fail-safe；新 `[CC-179-01]`～`[CC-179-04]`；`[CC-05]` 的 `return true` 计数 2 → 3（过长）；`[CC-07]` 词条表去掉旧词。`compactStartMount.test.ts`：删 `[176-C-03]`；新 `[179-C-01]`～`[179-C-03]`（启动阶段 Enter / Ctrl+Enter 排队、启动失败后队列仍在、失败卡照旧）与 `[179-C-04]`～`[179-C-06]`（说明透传、过长不发、没用上的提示）。`compactQueueRelease.test.ts`：`[179-Q-01]`（启动失败结束 `/compact` 后排队的消息发出）。

- 变异检查：把输入框的「`/compact` 在途」判定临时改回只认压缩阶段，`[179-C-01]`～`[179-C-03]` 失败；去掉 bridge 在 `compaction/summary` 上的绑定，`[179-B-01]` 失败。两处改回后 sha256 与改前一致。

### 8.2 门禁

- `pnpm typecheck`、`pnpm typecheck:dsh-host`：通过。
- `biome check`：本决策改动与新增的 28 个代码 / 样本文件无问题。
- `vitest run src/dsh-host`：52 个文件通过、3 个跳过（真宿主集成与 win32），1071 项。
- `vitest run scripts`：13 个文件、230 项。
- `vitest run src/renderer/components/chat`：167 个文件、3331 项。
- `vitest run Static Scan Wiring`：79 个文件、822 项。
- `vitest run src/shared/__tests__ src/shared/dshHistory`：44 个文件、849 项（含词条覆盖与金样本对拍）。
- `vitest run src/renderer/stores src/main/services/agent-host src/main/ipc`：97 个文件通过、1 个跳过，1732 项。
- `bridge-smoke.ts`：exit 0，70 项判定全部为真，含新的 `compactTakesInstructions`（真 DSH 上试跑通过、过长被拒）。
- `bridge-record.ts`：`--update --only compact-instructions` 录新场景；随后全量 `--check` 只有一处差异——`rpc.compact.json` 的 `$.compact.refused` 不再存在（第 6 节，预期，未重录）。新场景在全量顺序下 0 差异（第一次全量发现工具轮列出的目录受前面场景影响，改为独占工作区后重录、再全量通过）。
- 没有起 Electron、没有整包构建；模型请求只走本地假网关。

## 9 风险

1. **DSH 升级**：钩子形状一变，带说明的 `/compact` 会被拒（多数在执行前，少数在发出前），用户看到「当前引擎版本的 /compact 不能附加说明」；`/compact` 本身照常。`[179-H-09]` 在升级时先失败。
2. **说明与模板的规则冲突**：例如「用中文写」与模板的「Write concise English engineering prose」。提示语只要求保持结构，没有写「用户说明优先」，由模型权衡；本地只有假网关，真实模型的遵从程度没有测（不访问真实模型服务）。
3. **说明只在桩里**：DSH 自己的客户端（TUI）打开同一会话看不到这一行；桩丢失或被旧版本覆盖时，只少这一行。
4. **少一行的边界**：桩写失败（Windows 上文件被占用时 rename 可能失败）、回退与压缩的桩写交错、压缩恰在超时边界提交、超出 20 条 / 12,000 字符——摘要都在，只是重开后不显示说明。
5. **每个宿主进程第一次带说明的 `/compact` 多一次试跑**：纯内存、毫秒级，不发请求。
6. **启动阶段排队**：启动失败时排队的消息会走正常发送路径再试着启动一次，可能再出一次失败卡（与直接发消息时相同）。

## 10 Windows 现场清单（下一个测试包起）

1. 有几轮内容的对话里输入 `/compact 保留未完成的任务和失败经验` 回车：状态行「正在压缩上下文…」，完成后时间线末尾的「上下文摘要」行下面多一行「本次压缩的附加说明：保留未完成的任务和失败经验」；摘要内容里能看出照做（例如「Pending Jobs」「Errors and Fixes」写得更具体）。
2. 关掉应用再打开这个对话：摘要行下的说明仍在。
3. 只输 `/compact`：没有那一行，行为与以前一样。
4. 说明里有换行（Shift+Enter）、中英混排、表情：原样显示。
5. 粘贴超过 2000 字的说明：提示「/compact 后面的说明太长了 / 最多 2000 个字符（现在是 N 个）」，什么都没发生，文字留在输入框。
6. 斜杠菜单 `/compact` 的说明是「压缩当前对话的上下文（可在后面附加说明）」。
7. 首页输入 `/compact xxx`：照旧提示需要先打开对话；带附件的 `/compact xxx`：照旧当普通消息。
8. 从说明那条摘要之后的某条消息分叉：新对话里那一行也在；回退到摘要之后某处：那一行仍在。
9. 自动压缩（长对话）：照决策 178 显示，摘要行下没有说明行。
10. **启动阶段排队**：重启应用后打开老对话，输入 `/compact`，在「正在启动对话…」时写一句话回车：消息进入排队条、输入框清空、不再弹「等对话启动后再发送」；压缩结束后这条消息自动发出。Ctrl+Enter 同样。
11. **启动失败**：用工作区不一致等会让启动失败的情形重复第 10 条：`/compact` 的失败提示与失败卡照旧，排队的消息随后照常发出（再次失败时出发消息的失败卡）。
12. 宿主日志里没有 `[dsh-bridge] /compact instructions refused` 与 `[dsh-bridge] /compact instructions not kept beside the stub`。
13. 中文界面下所有新句子完整不截断；暗色主题下说明行可读。

## 11 用户审批

- [x] 第 1 节（用户 2026-10-11 的裁决与追加）
- [ ] 3.1 说明作为租约加在这一次摘要请求末尾（同一消息、同一文本块）、不复制 DSH 实现、提示语原文
- [ ] 3.2 摘要行下加一行显示说明；说明存在会话桩里（20 条 / 12,000 字符上限）而不是 DSH 日志或旁车文件；分叉带上
- [ ] 3.3 纯文本规整与 2000 字符上限、超长整条拒绝
- [ ] 第 4 节 fail-safe 四种情形与升级复核清单
- [ ] 第 5 节文案；不用悬停提示
- [ ] 第 6 节新录制场景、假网关脚本、`compact` 场景去掉带说明的调用（`rpc.compact.json` 待重录）
- [ ] 第 7 节启动阶段发消息改为排队（修订决策 176 §5、178 第 5 节）
- [ ] 第 9 节风险的接受程度
- [ ] 第 10 节 Windows 现场清单
