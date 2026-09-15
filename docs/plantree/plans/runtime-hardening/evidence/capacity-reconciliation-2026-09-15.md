# 容量对账：写进会话文件与 trace 的最大字节（2026-09-15）

Role: evidence。任务 [T024](../roadmap.md)，回应审计批评者「长会话容量与性能」缺口（[cross-and-critic.md](../../runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md) 第 79 行）。批评者的原话是：没有任何容量维度的核对，`runs.jsonl` 无轮转与上限，32 MiB 的会话文件预算同时要装子代理转录、bash 输出与 write 审批预览，一个长会话可能在用户毫无察觉时顶满然后打不开。

本文做三件事：把「谁会往会话文件和 trace 里写字节」按来源列清楚，与 32 MiB 预算对账，给出哪一条必须先限额。行号以 `3172cc9c` 为准；标注「本波落地」的条目是 2026-09-15 第七波的未提交改动。

## 术语

- **会话文件**：每个会话一份 `.jsonl` 文件（每行一条 JSON 记录），对话消息、工具调用与结果、压缩摘要都逐行追加进去。重开会话时整份读回来。
- **trace / `runs.jsonl`**：工程规范 §2 要求的运行留痕，每个 run（一次完整的「用户发一句 → 模型答完」）写一行 JSON，记录输入、模型、步骤、用量、输出。用于事后复盘，不参与对话。
- **预算（budget）**：本文一律指字节上限，不是 token 上限。
- **run / 回合**：一次 `handle.run(...)`，内含多轮模型请求与多次工具调用。

## 一、结论摘要

**必须先限额的是 MCP 工具响应**（MCP = Model Context Protocol，第三方工具服务器接进来的协议）。理由不是它现在最大，而是它是唯一一条**体积完全由第三方服务器决定**的落盘来源：

- 用户输入的大小由用户决定，模型输出的大小被模型单次输出 token 上限挡住，工具结果有 50 KiB 闸门。只有 MCP 服务器返回的图片既不受这两者约束，也没有自己的字节上限——改前只限「最多 8 张」，单张多大不管，唯一的天花板是传输层 8 MiB 的单帧上限。
- 算术：改前**一次** MCP 调用最多能往会话文件写约 8 MiB，**四次就顶满 32 MiB**；顶满之后会话文件连打开都会失败（见第二节）。改后一次调用的落盘上限是 50 KiB 文本 + 2 MiB 图片 ≈ 2.05 MiB，需要 16 次才顶满，且每一张被丢掉的图片都会在文本里说明原因。

**第二位是子代理转录**（父会话把每个子代理的消息逐字写进自己的会话文件）。它不是单次最大，但它是唯一一条**正常使用下持续累积**的无上限来源——由 T020 同波落地，常量 `MAX_RECORDED_TEXT_CHARS = 8 000` 字符（`src/runtime/plugins/subagent/records.ts`）。

**可以放的三条**：

1. `write` 工具调用参数里的文件内容（schema 上限 8 MiB）。它进会话文件是事实，但要触发这个上限，模型得在一次回复里吐出 8 MiB 文本（约两百万 token），被 provider 的单次输出上限挡死在 256 KiB 量级。是理论缺口，不是可达缺口。
2. `write` 的审批预览全文（审计 tools-11）。复核确认它**不落盘**：只经 IPC 到审批卡片，进 trace 前截 4000 字符。T011 判的「不做」成立。
3. `labels`（给会话条目起名的 fact 行，无长度上限）：全仓没有生产调用方，只有测试在用。

**`runs.jsonl` 的优先级低于会话文件，但它的内存那一半优先级更高**：全仓没有任何生产代码设置 `AICLIENT_RUNTIME_TRACE_DIR`（唯一命中是 `src/runtime/flags.ts` 自己的定义），所以打包后的应用里 `runs.jsonl` 根本不会被创建，除非开发者手工开启。但 `TracePlugin._runs` 这个内存镜像是**无条件**开的，与 traceDir 无关——它在改前会把进程生命周期内每一条完整 trace（含用户 prompt 全文、系统提示词全文、每次工具调用的参数全文）永久留在内存里，而且生产代码里没有任何读者。两者本波都已封顶。

## 二、会话文件的 32 MiB 预算是怎么执行的

常量 `SESSION_MAX_BYTES = 32 * 1024 * 1024`，`src/runtime/plugins/session/codec.ts:20`（T015 集中，审计 session-12）。

**写入侧是「拒绝」不是「截断」**：每次写之前算「文件已有字节 + 本行字节」，超过预算就抛 `session_size_limit`，这一次写完全不落盘。五处检查：

| 场景 | 位置 |
|---|---|
| 新建会话写文件头 | `session/store.ts:146-153` |
| 追加任意条目（`appendMessage` / `appendCompaction` 都汇到这里） | `session/store.ts:288-295` |
| 追加 lane / fact 行（改名、打标签） | `session/store.ts:559-563` |
| fork 落盘 | `session/store.ts:499-502` |
| legacy 导入转换后落盘 | `session/legacy.ts:550-551` |

**读取侧超限直接打不开**：`store.open()` 用 `io.readFile(file, { maxBytes, overflow: 'error' })`（`session/store.ts:155`），`overflow: 'error'` 的语义是「文件字节数超过 maxBytes 就抛 `io_limit`，不返回截断内容」（`src/runtime/host/io.ts:259-268`）。所以一旦文件本身超过 32 MiB（比如被 pi CLI 这个外部写者写大），**这个会话就再也打不开了**——这正是批评者担心的那一幕。

**没有「单行最大字节」这道闸**。理论上文件几乎为空时，单独一行可以逼近整个 32 MiB。

## 三、表 A：写进会话文件的来源

「每回合条数」指一次 run 里最多出现几条。「无」表示代码里没有任何上限。

| 来源 | 单条上限（常量 · 文件 · 数值） | 每回合条数 | 最坏累计 | 现状 |
|---|---|---|---|---|
| assistant 消息里的 `toolCall.arguments`（`write` 的文件内容） | `FILE_EDIT_BYTES` · `plugins/tools/index.ts:24` · 8 MiB（同时是 typebox schema 的 `maxLength`，`:334`） | 每次工具调用一条 | 理论 8 MiB × 调用数 | **无专门上限**，但被模型单次输出 token 上限压到 ~256 KiB。可放，见第一节 |
| `toolResult.content`（内建工具 read/write/edit/bash/glob/grep） | `TOOL_OUTPUT_BYTES` · `plugins/tools/index.ts:23` · 50 KiB，施加于 `result()` `:693-706` | 每次工具调用一条 | 50 KiB × 调用数 | 已限（T012 修 tools-06，bash 的 details 只留标量） |
| `toolResult.details.review.patch`（write / edit 的 diff） | `REVIEW_PATCH_BYTES` · `src/shared/sessionFileChange.ts:3` · 64 KiB，执行点 `plugins/tools/file-change.ts:122` | 每次 write / edit 一条 | 64 KiB × 次数 | 已限。超限退化为 `unavailable: 'too-large'`，不写 patch |
| `toolResult.content`（MCP 文本） | `MCP_OUTPUT_BYTES` · `plugins/mcp/index.ts:71` · 50 KiB | 每次 MCP 调用一条 | 改前 CJK 文本实际可达 ~150 KiB | **本波落地**：改前按 `String.length`（UTF-16 单元）计数，一个汉字算 1 却占 3 字节；改为按 `Buffer.byteLength` 计，并在字符边界切断 |
| `toolResult` 里的 MCP 图片（base64 原样落盘） | 改前：只有张数 `MCP_MAX_IMAGES` · `plugins/mcp/index.ts:73` · 8 张，**单张无字节上限** | 每次 MCP 调用一条 | 改前单次 ≈ 8 MiB（受 `MAX_MESSAGE_BYTES` · `plugins/mcp/client.ts:34` · 8 MiB 单帧限制间接约束）→ **4 次顶满会话** | **本波落地**：加 `MCP_IMAGE_BYTES` = 1 MiB/张 与 `MCP_IMAGE_TOTAL_BYTES` = 2 MiB/次 |
| user 消息里的附件图片 | 无 | 每次发送一条 | 无上限 | **待落地**，见第六节（`plugins/agent-loop/attachments.ts:34-40`，本任务禁改） |
| user 消息里的文本附件 | 无 | 同上 | 无上限 | **待落地**，同上（`attachments.ts:42`） |
| 子代理转录 custom 条目（`started.task` / 每条 delegate 消息逐字 / `settled.report`） | 改前无；`MAX_RECORDED_TEXT_CHARS` · `plugins/subagent/records.ts` · 8 000 字符 | 每条 delegate 消息一条 | 与子代理整份转录同量级 | T020 同波落地（未提交），审计 subagent-data-05 |
| `TaskWait` / `TaskStop` 的结果文本（普通 toolResult） | `MAX_TASKWAIT_RESULT_CHARS` · `plugins/subagent/index.ts` · 50 000 字符 | 每次调用一条 | — | 已限 |
| compaction 条目的 `summary`（模型生成的历史摘要） | 无 | 每次压缩一条 | 由 provider 的 `maxTokens` 间接约束 | **待落地**，见第六节（`plugins/context/index.ts:347`，不在本任务可改范围） |
| compaction 的 `retainedTail`（压缩时保留的用户消息） | `COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS` · `plugins/context/budget.ts:65` · 20 000 token（按 `maxChars = token × 4` 执行） | 每次压缩 | — | 已限。`completed_turn` 模式下为空 |
| `labels`（fact 行） | 无 | — | 目前无生产调用方 | 记录，不做 |

## 四、表 B：写进 trace 的来源

trace 有两个落点：磁盘上的 `runs.jsonl`（只在设置了 `AICLIENT_RUNTIME_TRACE_DIR` 时存在）和内存里的 `TracePlugin.runs` 数组（无条件存在）。表里「两者」指同一份数据同时进这两处。

| 来源 | 写入目标 | 单条上限 | 现状 |
|---|---|---|---|
| `RunTrace.input`（用户 prompt 全文） | 两者 | 无 | 无上限。记录，不做——它就是这一 run 的输入本身，截了 trace 就不能复现 |
| `RunTrace.final_output`（模型答复全文） | 两者 | 无 | 同上 |
| `run_start` 步骤里的 `system_prompt` 全文 | 两者 | 无（指令层自己有 32 KiB 装载预算，T035） | 每 run 一条 |
| `tool_execution_start` 的 `args` 全文 | 两者 | **无** — `write` 的 8 MiB 文件内容整份进 `runs.jsonl` | **待落地**（`plugins/agent-loop/index.ts:432-437`，本任务禁改） |
| `tool_execution_end` 的 `result` 全文 | 两者 | 间接受工具侧闸门（50 KiB / 64 KiB / MCP 两道） | 已限（间接） |
| `permission_*` 步骤里的审批预览 | 两者 | `MAX_TRACE_PREVIEW_CHARS` · `plugins/agent-loop/index.ts:58` · 4 000 字符 | 已限（T011 修 permissions-12 前半） |
| `session_recovered` 的 `skipped_previews`（坏行预览） | 两者 | 单条预览由 T034 的解码器决定，条数上限 64 | 已限（T034） |
| `delegation_resume` | 两者 | 只记 `report_bytes` 数字，不含正文 | 已限 |
| `llm` 步骤 | 两者 | 只记 `text_bytes` 数字与 usage，不含正文 | 已限 |
| **`runs.jsonl` 文件本身** | 文件 | 改前**无轮转、无上限**，纯追加 | **本波落地**：`TRACE_FILE_MAX_BYTES` = 8 MiB，`TRACE_FILE_GENERATIONS` = 3，磁盘总量封顶 (3+1) × 8 MiB = 32 MiB |
| **`TracePlugin._runs` 内存数组** | 内存 | 改前**无上限**，进程活多久存多久 | **本波落地**：`TRACE_MEMORY_MAX_RUNS` = 100 条，`TRACE_MEMORY_MAX_BYTES` = 4 MiB，淘汰最旧并计数 `evictedRuns` |

子代理不走父 run 的 trace：它自己 `new Agent(...)`（`plugins/subagent/run.ts`），不经过 `AgentLoopPlugin.execute`，所以子代理的工具参数与结果**不会**进 `runs.jsonl`。唯一漏进来的是子代理工具调用的审批记录（已受 4 000 字符截断）。

## 五、四条容易被误当成「落盘」的来源（复核结论）

这四条在审计与任务书里都被提到过，复核后确认它们**不进会话文件**，因此不参与 32 MiB 对账：

1. **`write` 的审批预览全文**（tools-11）：`plugins/tools/index.ts:340-343` 把 `args.content`（最多 8 MiB）原样作为 `preview.text`，但它只是 `authorize()` 请求体上的一个临时字段，交给审批 UI 用。事件投影 `permissionActivityEvent()`（`plugins/permissions/activity.ts:41-71`）只取 `request.command ?? request.path`，不含 preview；权限插件全文没有任何 `session.append*` 调用。进 trace 的那一份已截 4 000 字符。**驻留点在渲染层，且卡片设计就是要显示完整内容**——与 T011 的判断一致。顺带记一条：`edit` 工具根本不构造 preview，审批卡片上没有内容预览。
2. **`custom` 条目的 16 000 字符截断**（`events/projector.ts:299`、`plugins/session/index.ts:39`）：两处都是先把**完整**数据写进会话文件，之后才对「要广播给渲染层的事件」做截断。会话文件里没有这条 16 000 的上限。
3. **`session.stderr` 每回合 50 行**（T017）：常量 `STDERR_FORWARD_MAX_LINES_PER_TURN` 在 `src/agent-host/stderrRedaction.ts:132`，执行点在 Main 进程的 `WorkerManager.forwardStderr`，配套单行上限 `STDERR_LINE_MAX_CHARS = 2000`（同文件 `:123`）。整条链路是 worker → Main → 渲染层的 IPC，不碰会话文件。
4. **权限活动记录**：只发事件，不落盘，也没有条数上限（频率等于工具调用频率）。

## 六、待落地（归其他任务或本任务禁改的文件）

| 项 | 位置 | 为什么现在不做 |
|---|---|---|
| 用户附件（图片与文本）无任何体积上限 | `plugins/agent-loop/attachments.ts:34-42` | T024 禁改 agent-loop。体积由用户选文件决定，比 MCP 可控，但同样绕过所有闸门直接落盘 |
| `tool_execution_start` 把工具参数全文写进 `runs.jsonl` | `plugins/agent-loop/index.ts:432-437` | 同上。`write` 的 8 MiB 内容会整份进一行 trace，比 4 000 字符的审批预览大三个数量级；建议沿用 `MAX_TRACE_PREVIEW_CHARS` 的口径 |
| compaction 摘要正文无上限 | `plugins/context/index.ts:347` | context 插件不在本任务可改范围。输入侧已有 `summaryInputBudget`，输出侧只靠 provider 的 `maxTokens` |
| 子代理转录逐条 verbatim | `plugins/subagent/records.ts` | T020 同波落地，已见 `MAX_RECORDED_TEXT_CHARS = 8 000` |
| 会话文件缺「单行最大字节」 | `plugins/session/store.ts:288-295` | 有了以上各条上限后是冗余防线；但它是唯一能挡住「未来某个新来源忘了限额」的兜底。建议作为独立小任务评估 |
| 多个 worker 同时向同一 `traceDir` 追加 / 轮转 `runs.jsonl` | `trace.ts` | 批评者「并发多会话」缺口，归 T031。本波的轮转用 `rename` 实现，并发下两个进程可能各自判定要轮转，结果是多轮转一次（丢一代历史），不会损坏正在写的文件 |

## 七、本波落地的四处限额

| 改动 | 位置 | 数值 |
|---|---|---|
| `runs.jsonl` 按字节轮转 | `src/runtime/trace.ts` `rotate()` | `TRACE_FILE_MAX_BYTES` 8 MiB × `TRACE_FILE_GENERATIONS` 3 代，磁盘总量 32 MiB |
| `TracePlugin._runs` 内存封顶 | `src/runtime/trace.ts` `remember()` | `TRACE_MEMORY_MAX_RUNS` 100 条 / `TRACE_MEMORY_MAX_BYTES` 4 MiB，淘汰最旧，`evictedRuns` 计数 |
| MCP 图片字节上限 | `src/runtime/plugins/mcp/index.ts` `contentOf()` | `MCP_IMAGE_BYTES` 1 MiB/张、`MCP_IMAGE_TOTAL_BYTES` 2 MiB/次 |
| MCP 文本预算改按字节计 | 同上 | `MCP_OUTPUT_BYTES` 50 KiB，口径从 UTF-16 单元改为字节 |

轮转策略为什么选「重命名 + 保留三代」而不是别的：会话文件与 trace 都是只追加的 JSONL，「删掉最旧的几行」意味着每个 run 都要把整个文件读出来重写一遍；「就地截断」会把一行切成两半，剩下的部分再也解析不出来。重命名是一次廉价操作，最近的历史完整留在 `runs.1.jsonl` 里，读者只需要知道「编号越大越旧」。文件大小是每次从磁盘 `stat` 出来的而不是在进程里累计的——文件比进程活得久，新起的 worker 如果在内存里从零开始计，就会以为昨天那个 8 MiB 的文件是空的。

两处与审计建议字面不同：

1. **单条超过上限的 trace 照样整行写入**，不切分也不丢弃。一条被切成两半的 trace 比一个暂时超标的文件更糟（它谁也解析不了），下一个 run 会把它轮转走。
2. **轮转失败不阻止写入**。轮转是清扫工作，失败了 trace 仍然必须落盘；但失败会经既有的 `flush()` 通道以 `trace_rotate_failed` 上报，不静默——否则一个不可写的目录会让文件无声地一直长。

## 八、未能验证的部分

- **MCP 图片的真实分布**：1 MiB/张、2 MiB/次 是按「base64 后 1 MiB ≈ 768 KiB PNG，够一张截图」推的，没有真实 MCP 截图服务器的样本。若现场发现常见服务器的截图稳定超过 1 MiB，这两个数要一起调。
- **32 MiB 顶满后的实际观感**未做端到端验证：本文对「写被拒 / 文件打不开」的结论来自代码路径（`session_size_limit` 与 `io_limit` 两处抛点），没有真造一个 32 MiB 会话跑一遍。
- **`write` 的 8 MiB 上限被模型输出 token 挡住**这一判断是推理，不是实测：没有实测某个 provider 在单次回复里最多能吐多少字节的工具参数。若某个 provider 允许超长输出，这条要从「可放」升级。
- **并发轮转**没有用例：两个 worker 同时轮转同一个 `runs.jsonl` 的交织没有构造，结论「最坏多丢一代历史」是读代码得出的。归 T031。
