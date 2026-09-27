# P1-4 分片 02 · DSH 源码事实（`0.1.7-rc.2`）

Role: detail shard。上位：[P1-4 方案](../p1-4-bridge-parity.md)。2026-09-26 只读核对。路径都省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`；行号指当前装好的包。凡是标「推断」的，只读了代码或 README，没有跑过。

## 1 会话日志与事件词表

- **只追加的事件日志**
  - `Session.append` 同步通知观察者，不等待 I/O（`dsh-session/lib/types/index.d.ts:210-246`；`dsh-session/lib/index.js:1401-1431`）。
  - 模型历史由 surface 派生：`system/`、`developer/`、`user/`、`assistant/message` 和 `tool/result` 是 surface 事件；压缩用 `{op:'replace', startSeq, endSeq}` 遮住旧节点，原始日志不删（`dsh-session/README.md:40-58`；`types.d.ts:442-462`）。
- **回合结束原因**（`dsh-session/lib/types/types.d.ts:165-208`）
  - 实时会出现的：`completed`、`aborted{reason: user | parent | hook{reason} | disposed}`、`blocked`、`error{LlmFailure}`、`max-tokens`。
  - `interrupted`：只由恢复时追加，或冷读时在内存里补上。
  - `forked`：只出现在 fork 种子里。
- **关键事件**（同文件 `:255-433`）
  - `user/message`（`:287-294`）：人类消息、`inject` 进来的上下文、goal 续跑，都走这一种，靠 `source.kind` 区分。
  - `assistant/message`（`:320-338`）：一个 step 一条，带本 step 的 `usage`。回合在流式中途被取消时，已送达的前缀会以 `interrupted: true` 落盘；没有这条事件的中止回合，说明没有流出任何可见内容。
  - `assistant/attempt`（`:339-348`）：失败、被重试、被取消的尝试，**不进模型历史**。
  - `tool/call`、`tool/result`（`:349-388`）：`tool/result.error {name, code, reason}` 只在 `isError` 时出现；`meta` 是工具私有的展示数据。
  - `session/end-seed`（`:406-432`）：`inherited: true` 标出 fork 的切点。
- **未知事件类型会让会话打不开**
  - `KNOWN_SESSION_EVENT_TYPES` 是本版认识的全部事件类型（`dsh-session/lib/index.js:79-137`）。
  - 读盘校验时，遇到不在其中、又没标 `ignorable: true` 的事件，直接抛 `SessionFormatUnsupportedError`（`dsh-session-persistence/lib/index.js:182-195`）。
  - `Session.append(type, data, …opts)` 只接受 `surfaceOp` / `sourceEventSeqs`，没有 `ignorable` 入口（`dsh-session/lib/index.js:1401-1419`）。
  - 结论：插件不能安全地新增持久事件类型。
- **用户消息的 source 校验很宽**：user 消息只要求 `source.kind` 是非空字符串（`dsh-session/lib/index.js:1162`）；`MessageSourceMap` 可以合并扩展，消费方对不认识的 kind 直接跳过（`dsh-llm/lib/types/message.d.ts:94-122`）。
- **已有的 source kind**：
  - `user`
  - `runtime-context`（每步的运行时上下文快照）
  - `goal`、`tool-goal`
  - `tool-jobs`（后台任务通知，`form:'notice'`）
  - `compact-checkpoint`（压缩后的替换节点）
  - `skill-invocation`、`skill-catalog`
  - `agent-instructions`
  - `subagent-settled`、`agent-message`
  - `plan-mode`、`model-selection`、`tool-registry`、`ptc-mode`
  - `repeat-tool-reminder`
  - `user-approval`
  - 出处：各包 `lib/types/*.d.ts` 里的 `interface MessageSourceMap`。
- **没有会话树**：「No session tree beyond fork」，pi 那种条目树被推迟了（`dsh-session/README.md:190`）。

## 2 分叉（fork）

- **`buildForkSeed(events, boundary)`**（`dsh-session/lib/index.js:884-892`；导出见 `dsh-session/lib/types/index.d.ts:16`）
  - 把 `0..boundary` 的事件复制一份（**事件对象原样保留，MessageId 不变**）；
  - 追加 `session/end-seed {inherited:true}`；
  - 对还开着的 step / turn，补上 `forked` 收尾和缺失的错误工具结果。
- **`SessionStore.fork(source, boundary, childId)`**（`index.d.ts:469`）只对活会话生效，只建 store 里的会话，不建 agent、不开持久化句柄。
- **agent 级分叉**：`ctx.agents.create({sessionId, seed, inheritedEventCount, meta:{cwd, parentSession, isSeeded:true}})`（`dsh-agent/lib/types/index.d.ts:48-104`）。
  - 创建时由 loop 取得持久化句柄，并把种子写进去（`dsh-agent-loop/README.md:115`）；首次追加时落盘（`dsh-session-persistence-jsonl/README.md:76`）。
  - 保险起见，之后再调用 `ctx.sessions.flush(session)`（`index.d.ts:439`）。
- **种子补写的结果文案**：`TOOL_NOT_STARTED` 表示前缀里没有开始记录；`TOOL_OUTCOME_UNKNOWN` 表示有开始、没有结果（`dsh-session/README.md:156`）。
- **子代理上下文继承**另有一套：`dsh-subagent-fork-in-process`，截到最后一个 `turn/end`。

## 3 回合机器（`dsh-agent-loop/lib/index.js`）

- **入口**
  - `followup`：下一回合，唤醒 driver。
  - `steer`：下一步，唤醒 driver。
  - `inject`：下一步，不唤醒 driver。
  - 以上在 `:806-814`。
  - `cancel(cause, {keepInbox})`：不带 `keepInbox` 时会清空收件箱（`:815-821`）。
  - `runMaintenance(task)`：在真正空闲时占住 agent；期间到达的唤醒输入会留在收件箱，等任务结束再处理（`:822-846`；类型见 `dsh-agent/lib/types/runtime-types.d.ts:174`）。
- **`turn()`**（`:935-1025`）
  - 回合开始时，一次性 claim 全部 next-step 输入，外加一条 next-turn 输入。
  - `agent/pre-step` 返回 reject → 回合以 `blocked` 结束（`:958-960`）。
  - 首个 step 的输入为空 → 回合以 `completed` 结束，不开 step（`:963-965`）。
  - step 结束后，如果没有新的 steering，走 `agent/turn-stopping`（`:983-990`）。
  - 捕获到取消 → `aborted{cause}`；其他异常 → `error`（`:993-1009`）。
- **被 reject 的 step 会吞掉已经 claim 的消息**：「claimed message ends here: it is neither discarded nor re-emitted」（`dsh-agent/lib/types/runtime-types.d.ts:267-281`）。
- **请求失败**：`agent/request-error` 的监听者返回 `{kind:'retry'}` 就在同一 step 里重试（`runtime-types.d.ts:348-356`），`dsh-llm-retry` 就是这样做的。失败之后回合就结束了，没有「回合之外重跑」的接口。
- **Stop 时的工具调用**：还没派发的调用，补一对 `tool/call` 和 `tool/result`，错误码 `ABORTED_BEFORE_DISPATCH`（`:660-688`；常量见 `dsh-tools/lib/index.js:2530`）。
  - `tool/call` 是在派发时追加的，早于 `tools/pre-execute` 和审批（`:681-688`）。
  - 真正开始执行的时刻，是 `tools/execute` waterfall（`dsh-tools/lib/types/index.d.ts:58`）。
- **恢复**：`agents.resume` 读全量日志，用 `interruptedTurnClosers` 补上收尾（`:1935`）；P0-6 实测，每次恢复还会追加一个 `session/end-seed`。
- **每轮换模型**：`installModelSelection(agentCtx, ref)`，改 `ref.current` 就会在下一步生效（`dsh-agent/lib/types/model-selection.d.ts:15-49`）。换了 provider 或 model 时，DSH 会追加一条 `model-selection` 来源的提示。

## 4 读取与投影服务

- **`ctx.sessionQuery`**（由 `session-query-sqlite` 行挂载；`openAt: never` 时搜索关闭，精确读取照常可用，`dsh-base/cordis.patch.yml:141-154`）
  - `observeSession(id, {projectionMode})`（`dsh-session-query/lib/types/index.d.ts:47`）：
    - 活会话直接取快照；
    - 冷会话用短期读句柄读全量，在内存里补中断收尾，并按修订号缓存 5 个（`dsh-session-query/README.md:107-111`）；
    - 读取从不改盘；
    - 返回 `{header, inheritedEventCount, events, cursor, projections}`（`lib/types/observation.d.ts`）。
  - `readSession(id)` 会走 `Session.create` 的完整重放校验，大会话较贵（README `:152`）。
- **`ctx.sessionProjections`**：`snapshot(session)` / `onChanged` / `stateOf`（`dsh-session-projection/README.md:47-60`）。已注册的单元：`todos`、`goal`、`plan`、`permissions`、`sandboxMode`、`tokenUsage`、`contextPressure`、`contextBreakdown`、`llmRetry`、`title`、`inbox`、`turnBoundary`、`subagent*`（各包 `SessionProjectionStateMap`）。
- **token-meter**
  - `tokenUsage` = 全日志累计的 uncached input / output / cacheRead / cacheWrite。
  - `contextPressure` = 最新一次 provider 报告的 prompt 大小，加上 `contextWindow`（`dsh-token-meter/lib/types/usage-projection.d.ts`）。
  - `TokenUsage` 各项互不重叠（`dsh-llm/lib/types/types.d.ts:160-178`）。**没有费用字段。**

## 5 持久化格式（`dsh-session-persistence-jsonl`）

- **布局**：`sessions/--<归一化 cwd>--/<转义 id>/session.v4.jsonl.zstd`，外加 `session.lock`（README `:56-72`）。
  - 转义规则：只保留安全字符，其余一律写成 `~XXXX`（`lib/types/format.d.ts:68-79`）。
  - 运行时总是选编号最高的那一代格式。
- **物理编码**（README `:104`）：多个独立的、带校验的 zstd 帧依次拼接，头一帧只含 header 行，之后每批追加一帧。`sourceEventSeqs` 的存储形式会把连续的 seq 压成 `[start,end]`。读取时：
  - 最后一帧残缺，只取其中完整的记录；
  - 中间某个完整帧坏了，按损坏报错。
- **限制**（README `:158-166`）：没有删除 API（「Nothing deletes session files」）；不支持降级；一个会话同时只能有一个写者（POSIX 上是 `flock`，Windows 上是命名信号量）。
- **读打开**：历史代际只在内存里迁移，不发布新文件；只有写打开才会发布迁移后的新文件（README `:82`）。
- **Electron 39.2.7 自带 Node v22.21.1**，二进制里有 `zstdDecompressSync`（本机 `node_modules/electron/dist/electron` 字符串检索）。所以 Main 自己解 zstd 在技术上可行，只是并不推荐（见方案 D5）。

## 6 附件、命令、问答、其余服务

- **图片**（`dsh-attachment/README.md:32`；`dsh-attachment-local/README.md:41-49`、`:86`）
  - 格式：PNG / JPEG / WebP / GIF。
  - 默认上限：单张 20 MiB；每条消息最多 20 张、合计 200 MiB；单张不超过 6400 万像素，每边不超过 8192 像素。
  - 入库时归一化：总像素预算 2048²，目标 4 MiB，去掉元数据。
  - 入口是 `ctx.attachments.admitPromptContent(parts)`（`dsh-attachment/lib/types/index.d.ts:51`），得到 `ImageAttachmentRef {attachmentId, mediaType, bytes, width, height, name?}`，再放进 `{type:'image', attachment}` 块。
  - 生成的引用里会保留显示用的文件名。
- **文件**：`FileBlock` 按原字节保存，模型通过只读路径按需读取，没有格式和大小限制（同 README）。我方文本附件继续并进正文（native 的做法），不用 FileBlock。
- **`read_image`**（`dsh-tool-fs/README.md:40`、`:47`）：有附件存储时才注册；路由对应的模型没声明图片输入时，执行会被拒绝。
- **命令**：`ctx.commands.list(agent)` / `execute(agent, line, attachments, signal)`（`dsh-commands/README.md:62`）。执行只写 `command/run` / `command/done` 两条日志，不开回合。`/compact` 不接受参数（`dsh-command-compact/README.md:36`）。
- **问答**：waterfall `user-questions/request`（`dsh-user-questions/lib/types/types.d.ts:80`）。跳过时的形状是 `{id, selected: []}`（README `:39`）。已知的发起方是 `dsh-plan-mode`。
- **重试记录**：`llm/retry`、`llm/retry-started`（`dsh-llm-retry/lib/types/types.d.ts:5-45`）。
- **后台任务**（`dsh-tool-jobs/README.md:40`）：任务结束时，agent 忙就把通知 inject 进它的下一步，agent 空闲就 followup 开一个新回合。通知是 `tool-jobs` 来源、`form:'notice'` 的 user 消息。
- **goal 续跑**（`dsh-goal-round-driver/README.md:53`、`:57`）：
  - 取消不会自动重开一轮；正在进行的 goal 会在下一个空闲点暂停。
  - resume 或 fork 之后，goal 保持未武装，直到人明确恢复。
- **在 dsh-base 里挂载了**（`dsh-base/cordis.patch.yml`）：`attachment-local`、`session-query-sqlite`、`session-projection`、`token-meter`、`llm-retry`、`user-questions`、`approval`、`commands`、`command-compact`、`plan-mode`、`goal*`、`tool-todo`、`jobs`、`subagent*`、`image-offload`。我方 bundle 只关掉了遥测、官方路由和 web 相关的行（`src/dsh-host/bundle/cordis.patch.yml:11-64`）。

## 7 没能确认的

- 在 `session/event` 回调里同步调用 `agent.cancel`，是否赶得在同一次同步执行中、下一步 claim 之前生效（推断可以：`turn()` 在 `step/end` 之后紧接着同步检查 `signal.throwIfAborted()`，`dsh-agent-loop/lib/index.js:976-982`）。**需实测。**
- 带 seed 的 `agents.create` 加上 flush 之后，dispose 掉，同一宿主里能否马上 `agents.resume`；写句柄的释放时序也未确认。
- 纯文本路由收到图片块时，是换成占位文本还是直接报错（`dsh-llm` 有 text-only substitution 的说法，推断是换成文本）。
- 用户可调用的技能，是不是以命令的形式出现在 `commands.list` 里（推断是；`dsh-skill/README.md:55`）。
- 官方 DSH Web 客户端的重试、回退交互：`dsh-web-app` 没有安装，无法对照。
