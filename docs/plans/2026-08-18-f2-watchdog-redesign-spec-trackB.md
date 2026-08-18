# F2 超时看门狗体系重设计施工规格（B 轨盲稿）

- 日期：2026-08-18
- 目标分支：`feat/openchamber-chat-refactor`
- 交付性质：施工规格；本文件只定义后续生产代码与测试代码的改造合同，本次撰写不修改任何生产代码或测试代码。
- 双盲声明：本稿未读取、未搜索、未引用任何文件名含 `trackA` 的文件；本稿只以分诊 F2、当前代码、当前测试和用户锁定约束为依据。
- 快修基线：`a94b9a4`（`fix(chat): D48+T-10 点验快修批——…诊断与文案诚实化`）。

## §0 背景、权威来源与阅读范围

### 0.1 本批目标

- 【实测】当前 Claude 轴存在两只 Host 看门狗：TTFT 默认 `32_000ms`，stall 默认 `195_000ms`；二者最终都通过同一个 `AbortController` 终止回合并由 abort 落点发出 `session.failed`。依据：`src/agent-host/claudeRuntime.ts:95-123,672-705,726-789,982-1001`。
- 【实测】Renderer 目前仍使用纯挂钟发送预算：文本基线 `45_000ms`、按附件扩张、上限 `180_000ms`；现行跨程序注释明确要求 Renderer ceiling 小于 Host stall，TTFT 小于 Renderer baseline。依据：`src/renderer/components/chat/attachmentLimits.ts:165-210`。
- 【实测】Renderer 到期分支不会停止 Host 回合，却会 `unbindHost()`、写 `lastError`、按 admission 证据 finalize，并在已受理时建立 abandon marker；这正是“本地宣告失败而远端继续”的分裂状态。依据：`src/renderer/components/chat/ChatComposer.tsx:1757-1851`。
- 【实测】当前迟到回复清理只清 abandon marker、匹配的 `lastError` 和对象同一性的 `retryable`；它没有撤销已经恢复到输入框的文本或附件。依据：`src/renderer/components/chat/ChatComposer.tsx:1938-1991`。
- 【实测】Codex 轴的 `30 * 60_000ms` 只约束 `turn/start` 请求的 JSON-RPC ack，不是回合生命周期超时；真实终态来自 `turn/completed` notification。依据：`src/agent-host/codexRuntime.ts:371-381`。

### 0.2 已核对输入

- 【实测】已逐条核对 `docs/plans/2026-08-17-d48-t10-inspection-triage.md:38-91` 的三张现状表、六项缺陷、A~H 修法方向与 pin 测试清单。
- 【实测】已核对用户指定的全部生产代码范围：`src/agent-host/claudeRuntime.ts:88-123,668-796,908-1027`、`src/agent-host/ttftWatchdog.ts:1-127`、`src/renderer/components/chat/attachmentLimits.ts:165-210`、`src/renderer/components/chat/ChatComposer.tsx:1376-1842,1911-1982`、`src/renderer/components/chat/assistantProgress.ts:1-313`、`src/renderer/components/chat/queueRelease.ts:1-509`、`src/renderer/components/chat/turnStatus.ts:1-193`、`src/renderer/components/chat/attachments.ts:297-359`、`src/agent-host/codexRuntime.ts:370-388`。
- 【实测】已完整阅读 F2 列出的 pin 测试文件：`attachmentLimits.test.ts:1-263`、`attachments.test.ts:1-514`、`turnStatus.test.ts:1-221`、`claudeRuntimeOptions.test.ts:1-1314`、`ttftWatchdog.test.ts:1-182`、`claudeRuntimePartialStall.test.ts:1-135`、`composerStopStatic.test.ts:1-302`。

### 0.3 分诊纠偏与既定前提

- 【实测】与分诊冲突：分诊 `:44-45` 的值表正确写出 stall=`195s`，但 `claudeRuntime.ts:760` 与 `ttftWatchdog.ts:7` 的历史注释仍写 `120s`；实际可执行常量是 `195_000ms`（`claudeRuntime.ts:95`），本规格一律以实际常量为准，并把过期注释纳入影响面。
- 【实测】与分诊冲突：分诊缺陷 4（红卡无条件指向 Retry）在基线提交 `a94b9a4` 已修复。当前 `MessageTimeline.tsx:534-540` 明确采用 affordance-neutral 注释与“已产内容保留。可从下方输入框重发上条消息。”；本批不得重复设计或回滚这项快修。
- 【实测】基线提交 `a94b9a4` 还已让 `formatRuntimeEvent` 输出 `role`；当前实现见 `ChatComposer.tsx:151-186`。因此用户回声三连在诊断文本中不再伪装成助手进度，本批只维护其不变量，不重做格式化方案。
- 【实测】用户回声 `message.started(role:'user') → message.delta → message.completed` 必须继续全部被助手活性谓词忽略；当前分类器通过只登记 assistant envelope 实现，测试逐帧钉住。依据：`assistantProgress.ts:278-310`、`assistantProgress.test.ts:24-40`。
- 【实测】Renderer 安全天花板按用户锁定为约 `300s` 且不可突破；“超时”本身不得伪装成确定死亡。现行代码恰好违反后半句：纯挂钟到期直接写 `lastError`（`ChatComposer.tsx:1823-1832`），本批的核心是拆开“停止本地等待展示”和“确认回合死亡”。

### 0.4 术语

- 【推测】“首活性（first liveness）”定义为：Host 已观察到能证明链路或回合状态仍在推进的第一条帧；它不等同于“首助手内容”。推测依据：当前 TTFT 仅在 `PRODUCTIVE_EVENT_TYPES` 上满足（`claudeRuntime.ts:790-800,947-955`），而 retry/status/stderr 等控制面事实能证明链路活着，却不证明模型已产出。
- 【推测】“确定死亡（definitive death）”定义为：存在明确终态事件、进程退出、连接关闭或不可恢复协议拒绝，且信号能够关联到当前 Host/session/turn；单纯超过任意时长不属于确定死亡。推测依据：现有 Renderer 已有 session-scoped failed/completed/stopped 谓词（`assistantProgress.ts:143-190`），而纯时间预算只返回布尔超时（`ChatComposer.tsx:1439-1485`）。
- 【推测】“安全天花板”定义为 UI 等待态的硬上限与诊断升级点，不是自动 abort 或失败判决器。推测依据：用户已锁定只有明确死亡才能回显并显示红错；因此 300s 只能改变展示/可操作性，不能创造死亡证据。

## §1 问题①：分工形态与跨程序不变量

### 1.1 裁定

- 【推测】采用“Host 权威终止 + Renderer 权威展示”的分工，不采用“Renderer 权威判死”。Host 双看门狗继续存在：TTFT 负责首活性前的证据门与降级，stall 负责首活性后的滚动静默终止；只有 Host 能持有并触发真实 `AbortController`（当前所有权见 `claudeRuntime.ts:619-623,672-705,729-779`）。Renderer 只消费事实、展示等待时长和 Stop，不从挂钟推导失败。
- 【推测】Renderer 的约 `300_000ms` 硬上限改名为 `RENDERER_WAIT_SAFETY_CEILING_MS`，语义是“停止普通等待轮询、进入 detached-wait 展示并加强诊断探测”，不是 send outcome。它不得调用 `unbindHost()`、不得写 `lastError`、不得恢复草稿、不得结束 turn-head active 状态；只要没有确定死亡信号，界面仍显示该回合在运行并保留 Stop。依据：现行错误动作集中在 `ChatComposer.tsx:1757-1851`，而 Stop 已有独立 generation/terminal 出口（`:1441-1462,1687-1731`）。
- 【推测】Host stall 继续是“政策性强制终止”：连续无合格活性达到 `195_000ms` 时 Host 自己 abort，随后 `session.failed` 成为 Renderer 可依赖的确定终态。依据：当前 stall 到期先设置 `stalled=true` 再 `abort.abort()`（`claudeRuntime.ts:679-700`），abort 落点发 `session.failed` 并把 registry 置 failed（`:983-1001`）。
- 【推测】Host TTFT 不再把“经过 32s”本身当成死亡；它只在命中 §3 的明确证据时 abort，否则发诊断状态并把最终裁决交给滚动 stall。依据：当前 F1 已承认 bare timeout 不是 transport failure 证据（`claudeRuntime.ts:713-725`），但仍把“完全没有 SDK event”当作证据（`:767`），本规格将进一步收紧。

### 1.2 INVARIANT 处置

- 【推测】废弃现行 `Renderer timeout < Host stall timeout` 不变量，并替换为两个不变量：
  1. `HOST_STALL_TIMEOUT_MS < RENDERER_WAIT_SAFETY_CEILING_MS <= 300_000`；默认值为 `195_000 < 300_000 <= 300_000`。
  2. `HOST_TTFT_TIMEOUT_MS < HOST_STALL_TIMEOUT_MS`；默认值为 `32_000 < 195_000`，但 TTFT 的较短值只表示更早诊断/证据检查，不保证更早失败。
  依据：现行镜像与旧不变量位于 `attachmentLimits.ts:175-203`，pin 断言位于 `attachmentLimits.test.ts:248-261`。
- 【推测】理由：Renderer 比 Host 更早到期会再次制造“Renderer 已失败、Host 仍运行”；反转后，普通静默由 Host 在 195s 内真正 abort 并发终态，Renderer 300s 仅兜住 Host 事件通道异常。若 Host 因 permission/question/open tool 合法 rearm 超过 300s，Renderer 仍不得判死，因为当前 Host 明确把这些状态视为非 stall（`claudeRuntime.ts:688-695,747-753`）。
- 【实测】与分诊一致：分诊方向 F 要求分工反转并重写旧不变量（`inspection-triage.md:80-83`）。本稿只进一步明确“300s 到期也不 finalize”，以满足用户锁定的确定死亡约束。

### 1.3 状态流

- 【推测】状态流固定为：`ordinary-wait` →（Renderer 300s、无终态）`detached-wait`；`ordinary/detached-wait` →（Host `session.failed`/进程退出映射/IPC 断连映射）`failed`；任一等待态 →（用户 Stop）`stopping/stopped`；任一等待态 →（内容/交互/完成）`active/completed`。依据：当前终态谓词是 session-scoped 的 `failed/completed/stopped`（`assistantProgress.ts:143-190`），而 Renderer timeout 目前错误地直接走 failure outcome（`ChatComposer.tsx:1799-1851`）。

## §2 问题②：活性谓词、api_retry 封顶与模块归属

### 2.1 活性分层

- 【推测】不要把所有“收到帧”压成一个布尔值；定义三层：`productive`（真实回合产出）、`interactive`（明确等待用户/本地工具）、`transport`（链路仍有活动但没有产出）。依据：当前单一 `PRODUCTIVE_EVENT_TYPES` 只含 SDK 顶层类型（`claudeRuntime.ts:790-800`），Renderer `classifyAssistantProgress` 又只返回 `assistant|ignore`（`assistantProgress.ts:9,278-310`），两边都不足以表达 retry/stderr/status 活性。
- 【推测】`productive` 帧：assistant message started/delta/completed、thinking started/delta/completed、tool started/updated/completed、`tool_progress`、主回合 `stream_event` 的内容/工具 delta、`usage.updated`、`subagent.activity`、SDK `result`、SDK `user` 中的 tool_result。它们满足 TTFT，并滚动重置 stall。依据：当前 Host 已把 `assistant/user/result/tool_progress/stream_event` 设为 productive（`claudeRuntime.ts:794-800,947-955`）；Renderer 已把 assistant/thinking/tool 识别为助手进度（`assistantProgress.ts:283-308`）。
- 【推测】`interactive` 帧/状态：`permission.requested`、`question.requested`、pending permission、pending question、open local tool。它们满足“回合活着”，暂停 TTFT/stall 的强杀时钟，直到交互解决后重新 arm；不得累计为失败。依据：当前两只 Host 狗都在这些条件下 rearm（`claudeRuntime.ts:688-695,747-753`）。
- 【推测】`transport` 帧：`system/init`、`session.stderr`、`session.status(running)`、Claude `system/api_retry`、Codex JSON-RPC response/server_request/notification。它们证明连接在说话，但不等于助手产出；`system/init` 只关闭“dead spawn”猜测，不满足 productive；stderr 只更新诊断时间，不单独无限延长 stall。依据：Claude 当前刻意排除所有 `system` 事件以检测 retry loop（`claudeRuntime.ts:790-793`），Codex connection 对任意入站 stdout line 调 `touch()`（`codexConnection.ts:357-383`）。
- 【实测】用户回声三连保持排除：只有 `message.started(role:'assistant')` 建立 assistant message id，后续 delta/completed 必须匹配该 id；`role:'user'` 三连均为 `ignore`。依据：`assistantProgress.ts:278-310`、`assistantProgress.test.ts:24-40`。本规格禁止把“任意 message.delta”改成活性。

### 2.2 api_retry 的有限保活

- 【推测】`api_retry` 可重置一个独立的 retry-grace 时钟，但从首个 retry 起累计延长最多 `API_RETRY_LIVENESS_CAP_MS = 90_000`；后续 retry 只能把 deadline 推到 `min(now + retryDelay, firstRetryAt + 90_000)`，不能无限滚动。90s 是 32s TTFT 的约三个观测窗口，且明显小于 195s stall。依据：当前 payload 已提供 `attempt/maxRetries/delayMs/errorStatus/error`（`eventNormalizer.ts:1075-1100`），但当前 Host 只记录 `sawApiRetry=true`，没有累计边界（`claudeRuntime.ts:727-729,947-951`）。
- 【推测】以下任一条件立即结束 retry 保活并进入 TTFT 证据 abort：`attempt >= maxRetries`、同一回合 retry 累计达到 90s、retry 声明不可重试/明确 auth failure。若字段缺失，只使用 90s wall cap，不猜测最大次数。依据：当前分诊要求防无限重试保活（`inspection-triage.md:73-75`）；具体 90s 为本稿设计裁定，现有代码无可实测常量。
- 【推测】与分诊冲突：分诊 B 可被读成 `session.status`/stderr/api_retry 都持续重置通用 stall（`inspection-triage.md:73-75`）；本稿拒绝“任意 transport 帧无限重置”，因为这会让 retry/stderr chatter 永久保活，重演当前排除 `system` 的反例（`claudeRuntime.ts:790-793`）。

### 2.3 文件级归属

- 【推测】新增纯模块 `src/agent-host/turnWatchdogPolicy.ts`，承载共享的 `LivenessClass`、Claude/Codex 轴无关的 deadline/封顶计算和证据枚举；`claudeRuntime.ts`、`codexRuntime.ts` 只做事件适配与 abort/interrupt 执行。依据：当前 `TtftWatchdog` 已因可测性被抽成纯计时器类（`ttftWatchdog.ts:16-18`），但事件分类仍内嵌在 `claudeRuntime.ts:790-800`，无法给 Codex 复用。
- 【推测】Renderer 的 `assistantProgress.ts` 只新增 `liveness` 分类供 UI 更新“最近仍活着”时间，不承载 abort 决策；建议返回 `assistant|liveness|ignore`。依据：该模块当前已经是 Renderer 的纯事件谓词集中点（`assistantProgress.ts:128-190,278-310`），适合消费共享 RuntimeEvent 语义，但不能看到子进程/JSON-RPC 内部信号。

## §3 问题③：TTFT 证据门、R9 与协议纪律

### 3.1 R9 补洞

- 【实测】R9 当前形状是：收到 `system/init` 后 `sawAnySdkEvent=true`，若没有 `api_retry`，32s 到期永远走 `rearm()`；代码自注承认只能等更长 stall（`claudeRuntime.ts:755-771`）。
- 【推测】改为一次性阶段迁移而非无限 rearm：TTFT 到期时若无 abort 证据，发一条非终态 watchdog warning，标记 `ttftDegraded=true`，永久满足/关闭 TTFT 计时器；此后只由统一 rolling stall 观察真实 liveness。这样 `init → 永久静默` 会在 195s stall 被 Host 真 abort，不再每 32s 重入同一空判断。依据：当前 `TtftWatchdog.markProductive()` 可永久关闭 timer（`ttftWatchdog.ts:67-74`），`rearm()` 正是无限循环来源（`:76-97`）。
- 【推测】warning 通过既有 `session.status` 的可选 `watchdog` 字段发送，例如 `{status:'running', watchdog:{phase:'ttft', state:'degraded', elapsedMs}}`；它是诊断/展示信号，不是 `session.failed`。依据：当前 `session.status` 已承载 retry 可选结构并被 Renderer 归并（`ChatComposer.tsx:179-182`、`chatSessions.ts:603-617`），使用可选字段可保持兼容。

### 3.2 可触发 abort 的证据清单

- 【推测】TTFT 只在以下证据下触发 abort/failed：
  1. Claude 子进程或 SDK query 明确退出/抛错且回合仍归当前 send；现有 catch 已直接 emit failure，不需要等 TTFT（`claudeRuntime.ts:1021-1027` 及后续 catch 终态路径）。
  2. spawn/exec/auth 明确失败：ENOENT/EACCES、SDK auth rejection、CLI 明确不可恢复认证错误；这些应走直接失败路径，而不是从“零帧”推断。Codex 的现成先例是 spawn `error` 直接 `handleExit`（`codexConnection.ts:491-502`）。
  3. `api_retry` 达 `maxRetries` 或累计达到 90s cap；当前 retry 字段足够判断 attempt/maxRetries/delay（`eventNormalizer.ts:1075-1100`）。
  4. 连接明确 closed/exit，且仍有 open turn；Codex 当前会 `finishTurn(...,'failed')`（`codexRuntime.ts:2291-2319`）。
- 【推测】以下不构成 TTFT abort 证据：单纯 32s 无内容、只收到 init、只有普通 stderr、Renderer 300s 到期、没有任何 SDK frame。特别是删除当前 `!sawAnySdkEvent` 的“dead spawn/auth”推断，因为无帧也可能是健康的长首响应；现有 F1 注释已承认 bare timeout 不能证明 transport failure（`claudeRuntime.ts:713-725`）。
- 【推测】证据不足时降级为 `running + watchdog.degraded`，继续由 stall 表接管；不得写 `session.failed`、不得 abort、不得向 Renderer 提供可被误读为终态的 error 字段。依据：当前非证据分支只 rearm（`claudeRuntime.ts:767-772`），本稿保留“不判死”意图但把无限 rearm 改成一次性降级。

### 3.3 协议版本

- 【推测】`AGENT_HOST_PROTOCOL_VERSION` 保持 `1`。本批只新增可选 payload 字段/可选 runtime event 语义，旧 Renderer 可忽略新字段，新 Host 仍能处理旧命令；没有删除/重命名必填字段，也没有改变 command framing。依据：版本常量与加法纪律在 `src/shared/types/agentHost.ts:28,171-174`，静态测试钉住版本 1（`agentWireStatic.test.ts:900-904`）。
- 【推测】若实现选择新事件类型 `session.watchdog` 而非 `session.status.watchdog`，版本仍保持 1，但必须先证明旧 Renderer 的 event reducer 对未知事件是 no-op；否则优先使用可选字段，避免把兼容性建立在未验证行为上。缺失证据列入 Open Questions。

## §4 问题④：Renderer 到期动作重构与静态断言

### 4.1 到期分支的新形状

- 【推测】把 `sendAndWait(): Promise<boolean>` 改成返回判别联合：`progress | terminal | cancelled | safety-ceiling`；禁止再用 `false` 同时表示“真的失败”和“只是不再轮询”。依据：当前 `waitUntil(..., timeoutMs)` 只返回布尔值（`ChatComposer.tsx:1439-1485`），下游因此把纯 timeout 直接送入失败构造（`:1757-1851`）。
- 【推测】当结果为 `safety-ceiling` 时，执行顺序固定为：
  1. 记录 `DetachedTurnRecord{sessionId, requestId, enteredAt, assistantCursor, sendOwner}`；
  2. 保留 `hostBoundSessionIds`；
  3. 保留 session 的 running/interaction 状态；
  4. 将 turn-head 切到 detached-wait（仍显示累计时长和 Stop）；
  5. 把本地 `runSend` 生命周期交给 detached tracker；
  6. 不调用 `finalizeOutcome`，不改变 payload recovery。
  依据：现行分支在 `ChatComposer.tsx:1757` 先 unbind、`:1823-1832` 写错、`:1837-1849` arm marker、`:1851` finalize；这些动作应整体退役，而不是逐个打补丁。
- 【推测】`finally` 需以 `detached` 标志区分：仍清 ticker、local listener、`inFlightRef` 和组件 `sending`，但不得 `endTurnSend(sendOwner)`；send status 的所有权已转交 detached tracker，直到终态或新活性接管。依据：当前 finally 无条件结束 turn send snapshot（`ChatComposer.tsx:1863-1870`），会让 300s 后的 turn-head 消失。
- 【推测】`canStartTurn`/队列释放必须把当前 session 的 detached turn 视为 in-flight，避免 Host status flush 延迟或断线时误放第二个 send。依据：当前发送门只看 target/disabled/busy/sending/inFlight（`queueRelease.ts:25-40`），且 `inFlightRef` 在 finally 被清；新增 detached latch 是必要的第五个门。
- 【推测】Renderer 到期不得调用 `getHostStatus()` 来“投票判死”；该快照只能作为诊断显示。现行代码把 probe 结果拼进 `abandonError`（`ChatComposer.tsx:1779-1831`），新设计可保留采样但不能从 `state !== ready` 单点推断当前 turn 已死，除非命中 §6 的显式 disconnect 事件。

### 4.2 lastError、unbind、finalize 的新规则

- 【推测】`unbindHost()` 只允许出现在明确的 session binding 失效：`session_not_found`、Host 进程退出/重启、显式 close/disconnected；普通等待到期不解绑。依据：当前 helper 的唯一效果是移除 binding，强迫下次 resume/create（`ChatComposer.tsx:1322-1326`），而 Stop clean path 已明确证明健康终止不应 unbind（`:1702-1706`）。
- 【推测】`lastError` 只由确定失败信号写入：session-scoped `session.failed`、匹配 request 的 fatal `host.error`、Host crash/disconnect 映射、IPC command rejection；safety ceiling 只写 detached diagnostic state。依据：当前 `chatSessions` 将 `session.failed` 写为 status failed + lastError（`chatSessions.ts:630-636`），这应成为红卡事实入口。
- 【推测】`finalizeOutcome` 只处理“已知本次尝试已经有 outcome”的路径；safety ceiling 没有 outcome，因此不得伪造 `fatalHostError:true` 再调用 `decideRunEntryOutcome`。依据：当前 timeout 正是用伪造 fatal 做分类（`ChatComposer.tsx:1799-1810`）。

### 4.3 composerStopStatic 的目标断言

- 【实测】现有 Stop pin 断言要求 terminal/cancellation 早于 store/error、Stop 分支不 unbind、清 `lastError`、不 arm abandon marker、通过 `decideRunEntryOutcome` 分类；这些合同仍正确。依据：`composerStopStatic.test.ts:115-223,235-300`。
- 【推测】重写用例标题中的“45s abandon”为“detached-wait/safety ceiling”，但保留 Stop 行为断言。新增或替换静态断言伪代码：

```ts
const ceilingBranch = sourceBetween("case 'safety-ceiling':", "case 'terminal':");
expect(ceilingBranch).toContain('transferDetachedTurn({');
expect(ceilingBranch).not.toContain('unbindHost()');
expect(ceilingBranch).not.toContain('lastError');
expect(ceilingBranch).not.toContain('finalizeOutcome(');
expect(ceilingBranch).not.toContain('restoreDraftIfComposerEmpty');
expect(ceilingBranch).not.toContain('setRetryable(');
expect(finallyBody).toContain('if (!detached) endTurnSend(sendOwner)');
```

- 【推测】新增动态纯函数测试优先于继续扩大源码扫描：把 `WaitResult → NextAction` 抽到纯模块，断言 `safety-ceiling` 的 action 精确等于 `{detach:true, unbind:false, writeError:false, finalize:false, restoreDraft:false}`。依据：现有 static suite 自己承认 `.tsx` 闭包无法直接执行（`composerStopStatic.test.ts:1-16`）；纯决策模块可降低字符串耦合。

## §5 问题⑤：restore-draft 收窄与迟到回复清理链

### 5.1 restore-draft 的唯一触发条件

- 【实测】当前 `decideFailureAffordance` 对所有 `committed` 返回 `restore-draft`（`queueRelease.ts:248-255`），`finalizeOutcome` 随即在 composer 为空时恢复文本/附件（`ChatComposer.tsx:1038-1083`）。这正是已受理回合迟到后留下复制稿的来源。
- 【推测】新合同：自动 `restore-draft` 只允许 `admission === 'not-admitted' && terminal === 'definitive-rejection' && origin !== 'release'`。可接受证据包括：create/resume/send 的匹配 request 被拒绝、`session_busy` 重试耗尽且从未 sawUserEcho、ensureHost/IPC 在 dispatch 前失败。单纯 timeout/safety ceiling 永远不恢复；已 sawUserEcho 或任一回合进度永远不恢复。
- 【推测】`decideFailureAffordance` 的目标矩阵改为：
  - `committed`（任何 origin）→ `none`；
  - `rejected + direct|retry` → `restore-draft`；
  - `rejected + release` → `none`（队列恢复）；
  - `skipped + direct|retry` → 保留调用方原草稿/原 retry snapshot，不做第二次恢复；
  - `skipped + release` → 由队列持有。
  依据：当前 admission 真值表已证明只有 user echo/assistant progress 能把 fatal 后的尝试判为 committed（`queueRelease.ts:170-187`、`queueRelease.test.ts:543-619`）。
- 【推测】与分诊一致但更严格：分诊 D 说 restore-draft 只给从未受理回合（`inspection-triage.md:78`）；本稿进一步要求“明确拒绝”，排除无证据 timeout。

### 5.2 provenance marker

- 【推测】任何自动恢复都必须同时写 `RestoredDraftMarker{sessionId,requestId,text,draftIds,valueRevision,attachmentRevision}`；没有 marker 的普通用户草稿永远不得被迟到事件清理。依据：当前恢复函数只比较 composer 是否为空，没有 provenance（`ChatComposer.tsx:1049-1058`），而 abandon 清理只凭 marker object identity 清 retryable（`:1938-1952`）。
- 【推测】用户一旦编辑文本、增删附件或发送新消息，marker 失效但内容保留；迟到事件不得用值相等删除用户的新输入。依据：当前代码已有使用对象同一性避免 stale marker 清新 retryable 的先例（`ChatComposer.tsx:1944-1952`）。

### 5.3 迟到回复/终态清理顺序

- 【推测】对当前 session/request 的新助手帧、waiting interaction 或 terminal 到达时，按以下顺序：
  1. 先验证 sessionId；若协议带 requestId 再验证 requestId，禁止跨回合清理；
  2. 读取并冻结当前 detached/abandon/restored marker；
  3. 清 detached-wait 标志并把 turn-head 交回 streaming/terminal 状态；
  4. 仅在 `lastError === marker.error` 时清旧错误；
  5. 仅在 `retryable === marker.snapshot` 时清旧 retryable；
  6. 若 restored marker 仍有效且文本 revision、附件 revision 均未变化，则移除该次自动恢复的文本与附件；
  7. marker 置空；
  8. 最后让 runtime reducer 应用新消息/终态，避免清理后的旧状态覆盖新事实。
  依据：当前 `resolveAbandonProgress` 已用 cursor 防 history replay 误清（`assistantProgress.ts:252-275`），当前 effect 在 new assistant/waiting interaction 或 raw completed 时清 marker（`ChatComposer.tsx:1957-1991`），但没有 draft marker。
- 【推测】用户已编辑时只执行步骤 3~5 与 7，不执行步骤 6；显示一个非阻塞提示“原回合已有迟到回复”属于后续文案批，本规格不定义措辞。

## §6 问题⑥：确定死亡判据清单

### 6.1 可作为确定终态的信号

| 判据 | 可观测信号来源 | Renderer 动作 |
|---|---|---|
| 【实测】当前 session 的 `session.failed` | Claude watchdog/catch/stream synthetic terminal：`claudeRuntime.ts:983-1020`；Renderer session-scoped predicate：`assistantProgress.ts:155-161` | 写 failed/lastError，允许红卡；按 admission 决定是否恢复未受理草稿 |
| 【实测】当前 session 的 `session.stopped` | Claude abort 非 stalled：`claudeRuntime.ts:995-1000`；谓词：`assistantProgress.ts:176-190` | 确定回合已结束，但这是用户/系统停止，不显示失败红卡，不自动恢复已受理 payload |
| 【实测】当前 session 的 `session.completed` | raw terminal predicate：`assistantProgress.ts:164-174`；Codex normalizer：`codexNormalizer.ts:598-640` | 确定回合已结束；零助手块也属于 clean completion，不伪装成失败 |
| 【实测】Codex `error` 且 `willRetry !== true` | `codexNormalizer.ts:644-687` | 立即 `session.failed`；随后重复 `turn/completed` 只关闭回合，不双报 |
| 【实测】Codex app-server 进程退出且 open turn | `codexRuntime.ts:2291-2319` | `finishTurn(...,'failed')`，清 pending，registry disconnected，红卡可显示 |
| 【实测】Claude SDK/query 抛错且仍拥有 turn | `claudeRuntime.ts:1021-1027` 及 catch 的 failed/stopped 分支 | 直接终态；不等待 Renderer ceiling |
| 【实测】匹配本次 request 的 fatal `host.error` 且发生在 admission 前 | 当前 request/session 匹配规则：`assistantProgress.ts:19-87`；Host 拒绝示例：`claudeRuntime.ts:559-597` | 确定“本次尝试未建立回合”；可恢复草稿/队列，但不能把它描述成运行中回合死亡 |
| 【实测】Agent Host 子进程 `error` 或 unexpected `exit` | `AgentHostProcess.ts:67-74`；Manager state 变更：`AgentHostManager.ts:462-495` | 所有该 Host 上 open turns 确定不可继续；需要新增广播映射为 session/host disconnect 事件 |
| 【实测】等待 Main→Host 响应期间 Host 退出 | `AgentHostManager.ts:304-360` 的 `onExit` rejection | 当前 command 确定失败；若已 admission，仍需配合 Host-exit 广播确认 turn 死亡 |
| 【实测】Host 发 fatal `host.error` | `AgentHostManager.ts:414-435` | Host 级 error；对 open turns 需新增 fan-out terminal/disconnect，不能只改 manager state |

### 6.2 Host 崩溃与 IPC 断连的施工要求

- 【实测】当前缺口：AgentHostManager 能观察 process `error/exit` 并把 state 改为 error/stopped（`AgentHostManager.ts:462-495`），但 `broadcastRuntimeEvent` 只转发 Host 自己发出的 runtime event（`src/main/ipc/chat.ts:174-180`）；进程已死时不会再有 Host 自发终态。因此 Renderer 可能只靠轮询看到 Host state 改变，缺少 turn-scoped 死亡事实。
- 【推测】新增 Main 合成事件 `host.disconnected{reason,code,signal,unexpected:true}`，并携带 Manager 当时记录的 open session ids；Renderer 收到后对这些 session 建立确定死亡终态、清 binding、允许红卡。来源必须是 process `error/exit`，不能由 `getHostStatus` timeout 猜测。
- 【推测】IPC 断连路径定义为两类：
  1. Main↔Agent Host NDJSON 子进程管道断开：由 `AgentHostProcess` 的 `error/exit` 明确观测（`AgentHostProcess.ts:67-74`），等价 Host crash；
  2. Codex runtime↔app-server JSON-RPC 连接关闭：connection 先 reject 所有 pending 再调 `onExit`（`codexConnection.ts:414-426`），open turn 由 `codexRuntime.ts:2303-2318` 合成 failed。
  两者都属于确定死亡；Electron Renderer↔Main 的单次 invoke timeout/rejection若没有 process-gone 事件，只能判 command 失败，不能单独判远端 turn 死亡。
- 【推测】`session.status(disconnected)` 只有在明确 close/teardown/exit 时可作为 session 不再运行的事实；当前 Claude/Codex close 都会发 disconnected（`claudeRuntime.ts:1333-1346`、`codexRuntime.ts:2783-2797`），但用户主动 close 不应显示红卡，必须携带 reason/intentional 区分。

### 6.3 明确排除

- 【推测】以下均不是确定死亡：32s/195s/300s 数字本身、普通 stderr、一次 `api_retry`、`session.status(running)` 长时间不变、`getHostStatus()` 单次失败、Renderer 背景节流、没有新 assistant block。依据：现有代码已记录 store flush 可因背景窗口延迟（`ChatComposer.tsx:1693-1700`），且 F1 注释承认慢首响应可健康（`claudeRuntime.ts:713-725`）。

## §7 问题⑦：Codex 轴看门狗与 30 分钟 ack

### 7.1 裁定

- 【推测】Codex 轴必须补齐 Host 侧 TTFT + rolling stall，不允许完全交给 Renderer 兜底。理由：Codex runtime 能直接观察 JSON-RPC frame、connection closed、process exit，并能调用 `finishTurn(...,'failed'|'stopped')`；Renderer 看不到这些轴内事实。依据：任意 stdout frame 会在 parse 前 `touch()`（`codexConnection.ts:357-383`），进程退出会 reject pending 并回调 runtime（`:414-426`），runtime 有确定的 turn 终止点（`codexRuntime.ts:2291-2373`）。
- 【推测】Codex 与 Claude 共用 `turnWatchdogPolicy.ts` 的 deadline/证据规则，但使用不同 adapter：Claude adapter 消费 SDK event；Codex adapter 消费 connection activity + notification method + error envelope。两轴共享语义，不共享不适用的事件名。
- 【推测】Codex watchdog 默认预算与 Claude 对齐：TTFT `32_000ms`（证据检查/降级），stall `195_000ms`（滚动无活性 abort），Renderer ceiling `300_000ms`。统一值避免同一 UI 在不同 agent 下拥有 40 倍不同哲学；环境变量可沿用通用 Host 名或新增 Codex override，但默认必须相同。

### 7.2 Codex 活性映射

| Codex 信号 | 活性层 | 看门狗动作 |
|---|---|---|
| 【实测】`turn/started` | productive/turn-admitted | 满足 TTFT，重置 stall；方法名见 `codexNormalizer.ts:65-80` |
| 【实测】`item/started`、`item/completed` | productive | 满足 TTFT并重置 stall；当前 normalizer 处理入口 `codexNormalizer.ts:362-390` |
| 【实测】`item/agentMessage/delta` | productive | 满足 TTFT并重置 stall；映射见 `codexNormalizer.ts:71,376-378` |
| 【实测】reasoning summary/text delta | productive | 满足 TTFT并重置 stall；`codexNormalizer.ts:72-74,379-385` |
| 【实测】command/fileChange output delta、MCP progress | productive | 满足 TTFT并重置 stall；`codexNormalizer.ts:75-77,386-390` |
| 【实测】`thread/tokenUsage/updated` | productive-liveness | 重置 stall，但不创建 assistant block；`codexNormalizer.ts:78,391-393` |
| 【实测】`account/rateLimits/updated` | transport | 只证明链路活着，不应无限重置模型 stall；`codexNormalizer.ts:79,394-395` |
| 【实测】`thread/status/changed` active/waiting flags | interactive/transport | running 重置一次 transport clock；waitingOnUserInput/Approval 暂停强杀；唯一 status writer 在 `codexRuntime.ts:1883-1935` |
| 【实测】server request（question/approval） | interactive | 暂停强杀直到 resolved/reply；注册并发 permission/question 见 `codexRuntime.ts:2090-2249` |
| 【实测】任意 JSON-RPC response | transport | 证明 connection alive，只更新 transport time；路由见 `codexConnection.ts:369-383` |
| 【实测】`error{willRetry:true}` | bounded retry | 不终态；进入与 Claude api_retry 相同的 90s retry cap；当前仅 log 并 return（`codexNormalizer.ts:644-672`） |
| 【实测】`error{willRetry:false|absent}` | definitive failure | 立即 `session.failed`，dispose watchdog；`codexNormalizer.ts:673-687` |
| 【实测】`turn/completed` | terminal | dispose watchdog；normalizer 发 completed/failed（`codexNormalizer.ts:598-640`） |
| 【实测】process exit/connection closed | definitive failure | open turn `finishTurn('failed')`；`codexRuntime.ts:2291-2319` |

- 【推测】不是所有 `onActivity` 都能重置 stall：当前 hook统计双向所有 frame（`codexRuntime.ts:1388-1400,1633-1637`），若直接拿 `lastActivityAt` 当 watchdog liveness，Host 自己发送 request/response 或 rate-limit chatter 就能永久保活。watchdog adapter 必须在 connection-level activity与 turn-level productive/interactive 活性之间分层。

### 7.3 与 30 分钟 ack 的关系

- 【实测】`CODEX_TURN_START_TIMEOUT_MS=30min` 等待的是 `turn/start` request response；回合终态来自 notification，send 的 await 也明确不是等待 turn end（`codexRuntime.ts:371-381,2831-2833,2933-2961`）。
- 【推测】30 分钟 ack 机制保留，不与看门狗复用：
  - watchdog 管 turn 生命周期和活性；
  - 30 分钟 timer 管一个 outstanding JSON-RPC promise 的资源释放；
  - watchdog 先判死/Stop/exit 时，connection teardown 会 reject outstanding ack，30 分钟 timer 被清；
  - ack 先 timeout 时，现有 catch 通过 `finishTurn('failed')` 终止回合，watchdog dispose。
  依据：connection timeout 会移除 pending id（`codexConnection.ts:295-311`），Codex send catch 会在仍属当前 turn 时 `finishTurn('failed')`（`codexRuntime.ts:2933-2961`）。
- 【推测】不得把 ack timeout 改成 195s：注释明确 ack 何时返回仍 `[未测]`，可能合法地在 turn end 才回（`codexRuntime.ts:374-379`）；缩短会把健康长回合误判失败。

## §8 问题⑧：SLOW_WAIT_HINT 死路径的处置边界

### 8.1 现状纠偏

- 【实测】与分诊冲突：`SLOW_WAIT_HINT_SECONDS=45` 并非全局不可达。附件 send budget 可为 75s/105s/180s（`attachmentLimits.ts:165-210`），`attachments.test.ts:349-359,427-437` 明确钉住 62s 的 slow 文案；因此“整个 slow 分支是死代码”与当前预算函数和测试不符。
- 【实测】真正近似死的是文本无附件路径：base timeout 恰为 45s，而 slow 分支也在 `elapsed>=45` 切换（`attachments.ts:297,351-358`），同一边界上 `waitUntil` 结束，UI 很难稳定渲染该分支。`turnStatus.test.ts:106-123` 只证明纯函数边界，不证明真实组件可见。

### 8.2 裁定

- 【推测】选择“合并”，不删除整个 slow 机制、不保留一个将被 300s 意外复活的文本占位。具体为：
  - 附件路径继续保留现有 slow 分支和现有字面文案，避免 F2 顺手改变已可达 UI；
  - 文本无附件路径在 F2 中始终走普通 awaiting/streaming 时钟，不因预算抬到 300s 自动启用旧 `Still waiting … gateway latency varies` 分支；
  - `turnStatus` 的 `kind:'slow'` 仅在当前确实选择 slow copy 的条件下返回，不能只比较秒数。
  依据：当前 `deriveTurnStatus` 直接以统一 threshold 判 slow（`turnStatus.ts:115-120`），而 copy function 同样统一判 threshold（`attachments.ts:351-358`），需一起收窄以避免 kind/copy 分裂。
- 【推测】本批不得改写“等待中”具体措辞、语气、标点、Retry 后缀或是否提 gateway；这些属于后续文案批。F2 只决定哪个既有分支可达，并保持 `composerSendingLine` 为文案唯一来源。依据：`turnStatus.ts:3-16` 明确要求委托该函数，`turnStatus.test.ts:37-66,106-139` 钉住委托合同。
- 【推测】pin 测试调整：保留附件 62s 的逐字断言；删除/替换文本路径在 45s 必为 slow 的断言，新增“text-only 299s 仍走 awaiting copy”和“attachment 62s 仍走 slow copy”。具体新文案内容不在本批定义，测试只比较对同一 `composerSendingLine` 的委托。

## §9 问题⑨：零冲突切片、测试门禁、变异与灰度

### 9.1 切片顺序与文件所有权

- 【推测】采用“先合 seam，后并行 5 片”的施工顺序。第 0 片必须先合入，因为共享类型/政策若与各轴并行修改会冲突；第 1~5 片文件集合互斥，可并行施工。

| 切片 | 责任 | 独占文件 |
|---|---|---|
| 【推测】S0 串行 seam | 新增共同 watchdog policy、RuntimeEvent 可选 watchdog/disconnect 类型、纯状态机测试 | `src/agent-host/turnWatchdogPolicy.ts`（新）、`src/agent-host/__tests__/turnWatchdogPolicy.test.ts`（新）、`src/shared/types/runtimeEvents.ts`、对应 shared type test |
| 【推测】S1 Claude Host | 双狗接入共同 policy、R9 降级、retry cap、注释镜像 | `src/agent-host/claudeRuntime.ts`、`src/agent-host/ttftWatchdog.ts`、`claudeRuntimeOptions.test.ts`、`ttftWatchdog.test.ts`、`claudeRuntimePartialStall.test.ts` |
| 【推测】S2 Codex Host | 新增 Codex 双狗 adapter、connection/turn lifecycle dispose | `src/agent-host/codexRuntime.ts`、必要的 Codex runtime/watchdog 新测试；不改 `codexConnection.ts`，复用现有 callback |
| 【推测】S3 Main disconnect | Host process error/exit 合成 disconnect 并广播 | `src/main/services/agent-host/AgentHostManager.ts`、`src/main/ipc/chat.ts`、各自现有/新增测试 |
| 【推测】S4 Renderer pure | liveness 分类、budget/slow 分支、failure affordance、detached 状态纯决策 | `assistantProgress.ts`、`queueRelease.ts`、`turnStatus.ts`、`attachments.ts`、`attachmentLimits.ts` 及对应测试；`middleColumnLayout.ts:607-611` 只更新镜像注释 |
| 【推测】S5 Composer wiring | detached tracker、到期 transfer、restore provenance、迟到清理 | `ChatComposer.tsx`、`composerStopStatic.test.ts`、新增 `composerWatchdogStatic.test.ts`；不改 S4 文件 |

- 【推测】若 S5 需要新的 store，新增独占文件 `detachedTurn.ts`/`detachedTurn.test.ts`，不要把状态塞进 S4 正在改的 `assistantProgress.ts`；若必须改 `chatSessions.ts`，将其所有权从 S4 明确移给 S5，禁止双片同时触碰。
- 【推测】最终集成片只运行门禁和修正导入/格式，不再做跨片语义改写；发现合同冲突时退回拥有该文件的切片修改。

### 9.2 测试策略总览

- 【推测】先写政策状态机测试，再改 runtime；每个轴使用 fake timers/可注入 clock，不新增 30s/195s/300s 真实等待。现有 `TtftWatchdog` 已提供注入 timer seam（`ttftWatchdog.ts:21-31`），Codex runtime 已提供 `now/startInterval` seam（`codexRuntime.ts:919-930`）。
- 【推测】保留所有 pin 测试的意图，但允许重写过时字面/数值：
  - `attachmentLimits.test.ts:216-262`：45/75/105/180 改为 300 ceiling 合同与 `Host stall < Renderer ceiling`；附件 size 不再改变 hard ceiling，只可改变提示 metadata。
  - `attachments.test.ts:324-472`：保留 handshake、附件 slow、retry suffix；文本 slow 分支改为不可达/合并合同。
  - `turnStatus.test.ts:22-158`：新增 detached kind/active semantics；slow 判定与 copy 同源。
  - `claudeRuntimeOptions.test.ts:567-818`：把“total silence 50ms 直接 TTFT failed”改成 degraded→stall；新增 retry cap、maxRetries、R9 init-silent、Stop race。
  - `ttftWatchdog.test.ts:32-180`：若 timer 退化成 one-shot phase gate，删除 policy `rearm` 合同，保留 arm/satisfy/dispose/reset race。
  - `claudeRuntimePartialStall.test.ts:101-134`：保留 partial productive 与 control-only 不同；新增 api_retry bounded 负控。
  - `composerStopStatic.test.ts:235-300`：保留 clean Stop；替换“45s abandon”措辞并新增 ceiling branch 禁止动作。

### 9.3 必增测试

- 【推测】`assistantProgress.test.ts`：逐项断言 role:user 三连仍 ignore；新增 status/stderr/retry=`liveness`，foreign session ignore，assistant envelope=`assistant`。
- 【推测】`queueRelease.test.ts`：重写 3×3 affordance 矩阵；`committed→none`、`rejected direct/retry→restore-draft`、release 仍由 queue 持有。
- 【推测】Composer/纯状态机：300s 无终态只 detach；不得 unbind/error/finalize/restore；detached 阻止第二 send；late assistant 清 detached；definitive failed 才红卡；Stop 在 299999/300000/300001ms 都保持 clean。
- 【推测】Main disconnect：unexpected exit 广播一次并覆盖 open session；intentional shutdown/close 不显示 failure；process `error` 无后续 exit 时也广播；重复 error+exit 去重。
- 【推测】Codex：turn/start 已发但零 notification→TTFT degraded、stall failed；delta 间隔重置；`willRetry:true` 只保活至 90s；`willRetry:false` 立即 failed；process exit dispose；30min ack timer 与 watchdog 各自先到的双向竞态。

### 9.4 Feature flag 裁定

- 【推测】不使用用户可见 feature flag，也不保留旧/新双轨运行。理由：旧 Renderer timeout 会生成错误事实；只切 Host 或只切 Renderer 都会产生跨进程语义错配，灰度无法保证同一会话两端一致。协议保持 v1、可选字段兼容和原子版本发布已足够降低升级风险。
- 【推测】允许测试/诊断 env 覆盖 timeout 数值，但不得提供“恢复旧 45s 失败分支”的开关。现有 Host 已支持 TTFT/stall env override（`claudeRuntime.ts:97-123`），这些是测试 seam，不是产品灰度。

## §10 影响面清单

### 10.1 生产代码与共享类型

- 【推测】新增 `src/agent-host/turnWatchdogPolicy.ts`：跨轴活性层、TTFT phase、rolling stall、retry cap、deadline 计算的唯一政策模块。拆分依据是当前事件集合内嵌在 `claudeRuntime.ts:790-800`，Codex 无法复用。
- 【推测】修改 `src/agent-host/ttftWatchdog.ts`：从“可无限 policy rearm 的 timer”收窄为一次性 TTFT phase timer；当前 `rearm()` 合同在 `:76-97`。
- 【推测】修改 `src/agent-host/claudeRuntime.ts`：接入共同 policy、修 R9、区分 productive/interactive/transport、实现 retry 90s cap、更新 120s/45s 过期注释。现状核心在 `:88-123,672-800,912-1001`。
- 【推测】修改 `src/agent-host/codexRuntime.ts`：每 turn 建立/销毁 watchdog，按 notification/error/status/exit 更新活性；保留 30min ack。现状 turn routing/exit/ack 在 `:1797-1880,2291-2373,2933-2961`。
- 【推测】不修改 `src/agent-host/codexConnection.ts` 的协议/transport 行为；只复用其现有 `onActivity`、`handleExit` 与 pending rejection（`:220-245,357-426`）。若实现发现缺少 notification method 级 callback 才允许最小扩展，并同步更新本清单。
- 【推测】修改 `src/shared/types/runtimeEvents.ts`：新增可选 watchdog diagnostic 与 Host disconnect 事件/字段；不得删除现有字段。
- 【推测】保持 `src/shared/types/agentHost.ts` 的 protocol version 为 1；通常无需生产修改，只需确认注释仍准确。依据：`:28,171-174`。
- 【推测】修改 `src/main/services/agent-host/AgentHostManager.ts`：跟踪 open sessions、process error/exit 去重、合成 disconnect。现状只改 manager state（`:413-495`）。
- 【推测】修改 `src/main/ipc/chat.ts`：广播 Main 合成的 disconnect；当前 broadcaster 在 `:174-180`。
- 【推测】修改 `src/renderer/components/chat/attachmentLimits.ts`：base/ceiling 改为 300s 量级，重写跨程序镜像与 INVARIANT。现状 `:165-210`。
- 【推测】修改 `src/renderer/components/chat/assistantProgress.ts`：新增 `liveness` 分类，保持 user echo 三连 ignore，扩充 detached/terminal 关联谓词。现状 `:278-310`。
- 【推测】修改 `src/renderer/components/chat/queueRelease.ts`：发送门增加 detached latch，重写 failure affordance；现状 `:25-40,181-255`。
- 【推测】修改 `src/renderer/components/chat/attachments.ts`：只收窄 text-only slow 可达条件，不改既有文案字面；现状 `:297-359`。
- 【推测】修改 `src/renderer/components/chat/turnStatus.ts`：增加 detached 展示语义，slow kind 与真实 copy branch 同源；现状 `:22-120`。
- 【推测】修改 `src/renderer/stores/turnSendStatus.ts`：支持 transfer/detach owner，避免 `runSend.finally` 结束仍活着的 turn-head。当前使用点见 `ChatComposer.tsx:1863-1866,1912-1916`。
- 【推测】新增 `src/renderer/components/chat/detachedTurn.ts` 或等价纯模块：`WaitResult→NextAction`、detached record、restored draft provenance 与清理决策。
- 【推测】修改 `src/renderer/stores/chatSessions.ts`：归并 watchdog diagnostic/host disconnect，按 session 清 pending/status/binding；当前 terminal reducer在 `:603-643`。
- 【推测】修改 `src/renderer/components/chat/ChatComposer.tsx`：结构化 wait result、300s transfer、不 unbind/error/finalize、restore provenance、迟到清理。现状 `:1376-1871,1920-1991`。
- 【推测】修改 `src/renderer/components/chat/MessageTimeline.tsx`：渲染 detached kind/持续 Stop；不得改 `a94b9a4` 已中性化的失败卡文案（`:534-540`）。
- 【推测】修改 `src/renderer/components/chat/middleColumnLayout.ts`：只更新 `:607-611` 的预算/状态注释或 detached 样式 token；不在本批改文案。

### 10.2 测试文件

- 【推测】新增 `src/agent-host/__tests__/turnWatchdogPolicy.test.ts`。
- 【推测】修改 `src/agent-host/__tests__/ttftWatchdog.test.ts`、`claudeRuntimeOptions.test.ts`、`claudeRuntimePartialStall.test.ts`。
- 【推测】新增或修改 Codex runtime watchdog 测试；优先放在现有 `src/agent-host/__tests__/codexRuntime*.test.ts` 的最窄相关文件，避免巨型综合套件。
- 【推测】修改/新增 `src/main/services/agent-host/__tests__/AgentHostManager*.test.ts` 与 `src/main/ipc/__tests__/chat*.test.ts`，覆盖 exit 广播。
- 【推测】修改 `attachmentLimits.test.ts`、`attachments.test.ts`、`turnStatus.test.ts`、`assistantProgress.test.ts`、`queueRelease.test.ts`、`composerStopStatic.test.ts`、`turnSendStatus.test.ts`、`chatSessionsCore.test.ts`（或最窄 reducer 测试）。
- 【推测】新增 `composerWatchdogStatic.test.ts` 与 `detachedTurn.test.ts`，把能抽纯的行为从源码字符串扫描中移出。

## §11 测试合同变更清单

### 11.1 Host 共用政策与 Claude

- 【推测】`turnWatchdogPolicy.test.ts` 新增：
  - `productive` 首帧满足 TTFT并滚动 stall；
  - `interactive` 暂停强杀，resolve 后重新 arm；
  - transport-only 不等于 productive；
  - api_retry 从首帧起最多 90s；
  - `attempt===maxRetries` 立即证据失败；
  - no-evidence TTFT 只 degraded、不 abort；
  - degraded 后 init-silent 最终由 stall abort。
- 【推测】`ttftWatchdog.test.ts`：保留 disabled/idempotent/mark/dispose/Stop race；删除“onTimeout 内 rearm 后第二次 fire”的政策断言（当前 `:125-151`），替换为“phase 只结算一次，政策层决定 degraded/failed”。
- 【推测】`claudeRuntimeOptions.test.ts`：
  - 修改 `:578-602`：零帧 50ms 不立即 TTFT failed；先出现 degraded，之后短 stall 才 failed，error 文案判为 stall 或 evidence-specific；
  - 保留 `:604-663` 健康慢首帧不失败；
  - 修改 `:665-717` 为 retry 未到 cap 不失败、到 cap/maxRetries 才 TTFT evidence failed；
  - 保留 `:719-781` permission parked；
  - 保留 `:783-817` Stop 不被 relabel；
  - 新增 `init→silent` R9 回归：TTFT只降级、stall必失败；
  - 新增 stderr chatter 不能无限保活。
- 【推测】`claudeRuntimePartialStall.test.ts`：保留 stream_event 长串不 stall、system 控制串会 stall（当前 `:114-133`）；新增 api_retry 串只能活到 cap，避免把任意 system 重新纳入 productive。

### 11.2 Codex 与 Main 断连

- 【推测】Codex runtime tests：
  - `turn/started`/delta/usage 更新 liveness；
  - rateLimits/普通 response 不能无限重置 stall；
  - waitingOnUserInput/Approval 暂停；
  - willRetry true 受 90s cap；false 立即 failed；
  - process exit open turn exactly one failed；
  - Stop/close dispose timer且不晚发 failed；
  - 30min ack timeout 与 195s watchdog 任一先到都只有一个 terminal。
- 【推测】AgentHostManager tests：process `error` 无 exit、unexpected exit、fatal host.error 各自只广播一次 disconnect；code0/SIGTERM intentional shutdown 不发失败；open session ids 快照准确。
- 【推测】Main chat IPC tests：合成 disconnect 会送达所有未销毁窗口；窗口在 guard 后销毁时 catch 不影响其它窗口。现有 broadcaster 已有 destroyed guard（`chat.ts:174-180`）。

### 11.3 Renderer pin 与新增合同

- 【推测】`attachmentLimits.test.ts:216-262`：
  - T-01 改为 text-only `300_000`；
  - T-02~T-05 不再断言 75/105/180 timeout（若保留 size metadata，改测 metadata 单调而 hard ceiling 恒 300s）；
  - T-06 改断言 `HOST_STALL_TIMEOUT_MS < RENDERER_WAIT_SAFETY_CEILING_MS <= 300_000`；
  - a4 改断言 TTFT < stall，不再承诺 TTFT 一定先失败。
- 【推测】`attachments.test.ts:324-472`：保留 handshake 与 attachment slow 逐字断言；文本 45s slow 用例改为 text-only 299s 仍委托 ordinary awaiting；Retry suffix 顺序不变。
- 【推测】`turnStatus.test.ts:22-158`：新增 detached active 状态；`failed` 仍最高优先级；streaming 仍压过 slow；slow 只在 copy 实际选 slow 时成立；普通 text waiting 不因 45s 自动切 slow。
- 【推测】`assistantProgress.test.ts:24-117`：保留 user 三连 ignore 与 out-of-order delta ignore；新增 session.status/session.stderr/api_retry 为 liveness；foreign session 不得更新当前 send；terminal predicates 不放宽。
- 【推测】`queueRelease.test.ts:543-692`：重写 affordance 3×3 硬编码矩阵，禁止用被测函数互相证明；新增 detached latch 对 send/queue release 都返回 hold。
- 【推测】`composerStopStatic.test.ts:235-300`：保留 Stop 分支顺序、无 unbind、清 error、无 marker、无 store read；把“45s abandon”名称改成 safety ceiling，并确保 Stop 分支早于 ceiling transfer。
- 【推测】`composerWatchdogStatic.test.ts` 新增：ceiling branch 含 transfer，且不含 `unbindHost/lastError/finalizeOutcome/restoreDraft/setRetryable`；finally 对 detached owner 不 `endTurnSend`。
- 【推测】`detachedTurn.test.ts` 新增：300s只 detach；late progress 清 detached；definitive failed 才 failure；restored draft 仅在 marker revision 未变时清；用户编辑后绝不清。
- 【推测】`chatSessionsCore.test.ts`/最窄 reducer test：host disconnect 只失败 open turns、清 binding/pending；intentional close 只 disconnected；旧 Host 无 watchdog 字段仍正常。

## §12 变异测试计划

### 12.1 Host 政策变异

- 【推测】变异 M1：把 `role:'user'` 的 message delta 计为 assistant/productive。预期 `assistantProgress.test.ts` 的用户三连断言立即红；这是不可放宽的最高优先级负控。依据：现有锁在 `assistantProgress.test.ts:24-40`。
- 【推测】变异 M2：把所有 Claude `system` 事件加入 productive。预期 `claudeRuntimePartialStall.test.ts` 的 system-only 流不再 failed，测试必须红。依据：当前 matched-pair 在 `:85-133`。
- 【推测】变异 M3：删除 api_retry 的 90s `min(capDeadline, candidateDeadline)`，允许每帧续命。预期 policy 的“持续 retry 超过 cap 必 failed”红。
- 【推测】变异 M4：将 `attempt >= maxRetries` 改成 `attempt > maxRetries`。预期边界用例在恰好 maxRetries 时红。
- 【推测】变异 M5：恢复 `!sawAnySdkEvent` 即 TTFT abort。预期“零帧只 degraded、由 stall 最终终止”用例红。
- 【推测】变异 M6：R9 degraded 后继续 `rearm()` TTFT 而不交给 stall。预期 init-silent 用例观察不到规定的 stall terminal 或出现重复 warning，测试红。
- 【推测】变异 M7：permission/question/open tool 不再暂停。预期 parked interaction 在短 timer 下被误杀，用例红；当前基线测试在 `claudeRuntimeOptions.test.ts:719-781`。
- 【推测】变异 M8：Stop 后 timer 仍可设置 stalled。预期 Stop race 出现 `session.failed`，现有 `:783-817` 必红。

### 12.2 Codex 变异

- 【推测】变异 M9：直接用 connection `lastActivityAt` 重置 turn stall。向连接持续写 outbound ping、无 inbound productive；预期仍应 stall，若不 stall 测试红。
- 【推测】变异 M10：`error{willRetry:true}` 立即 terminal。预期 retrying-not-terminal 用例红；当前代码约束见 `codexNormalizer.ts:648-672`。
- 【推测】变异 M11：`willRetry:true` 永久续命。预期 90s cap 用例红。
- 【推测】变异 M12：process exit 先 emit session.failed、再 finishTurn 导致双报。预期 exactly-one terminal 计数红；当前正确顺序见 `codexRuntime.ts:2297-2319`。
- 【推测】变异 M13：watchdog 复用/缩短 30min ack timer。模拟 ack 在长 turn 后返回但期间有 productive notification；预期回合不因 ack 早超时失败。

### 12.3 Renderer 变异

- 【推测】变异 M14：safety ceiling 分支重新加入 `unbindHost()`。静态断言与下一 send 不应 resume 的集成用例红。
- 【推测】变异 M15：safety ceiling 写 `lastError`。状态机精确 action 断言红，且红卡仅在 definitive failed 的 reducer 用例红。
- 【推测】变异 M16：safety ceiling 调 `finalizeOutcome`。纯决策断言 `finalize:false` 与 restore/retry absence 红。
- 【推测】变异 M17：detached transfer 后 finally 无条件 `endTurnSend`。turnSendStatus owner transfer 测试红，turn-head 不得在 300s 消失。
- 【推测】变异 M18：detached latch 不参与 `canStartTurn`。queueRelease/send gate 测试会错误允许第二 send，必须红。
- 【推测】变异 M19：`committed→restore-draft` 恢复旧矩阵。queueRelease 3×3 硬编码矩阵红。
- 【推测】变异 M20：迟到清理按文本相等删除草稿，不看 revision/provenance。用户在恢复稿后编辑同前缀/同值的用例必须红。
- 【推测】变异 M21：late reply 只清 marker、不清匹配 restored draft。detachedTurn 清理链最终状态断言红。
- 【推测】变异 M22：host disconnect 对所有 session（含 idle/intentional close）写 failed。reducer 的 open-turn filter 与 intentional-close 负控红。
- 【推测】变异 M23：把 text-only 45s/300s 重新切进旧 slow copy。attachments/turnStatus 的 text-only ordinary waiting 断言红，同时 attachment slow 正控仍绿。

### 12.4 执行门禁

- 【推测】每片至少运行其最窄 Vitest 套件；合并门禁运行：`pnpm typecheck`、`pnpm lint`、全部 renderer chat tests、全部 agent-host watchdog/Claude/Codex tests、Main AgentHostManager/chat IPC tests。
- 【推测】禁止以“更新快照/改字面使其通过”处理变异红灯；每个 mutant 必须由独立期望咬住，不得拿生产函数输出当自己的 oracle。现有 queue tests 已记录 tautology 反例（`queueRelease.test.ts:717-749`）。
- 【推测】时间测试使用 fake clock 或 20~100ms env override，不等待真实 300s；真实 timer 只保留一个最小 smoke，避免 CI 负载下的墙钟竞态。现有 TTFT suite 已用 message discriminator 避免 wall-clock race（`claudeRuntimeOptions.test.ts:595-601,712-716`）。

## §13 Open Questions

### 13.1 仍缺证据、但不阻塞本规格的事项

- 【推测】OQ1：TTFT degraded 的 wire shape 最终采用 `session.status.payload.watchdog` 还是新 `session.watchdog`？本稿推荐可选字段，因为尚未亲自验证所有旧 Renderer reducer 对未知 event type 的行为。需要补充证据：旧版本 Renderer 与新 Host 的兼容 fixture/replay。
- 【推测】OQ2：`API_RETRY_LIVENESS_CAP_MS=90_000` 是设计裁定，不是当前代码/遥测事实。需要补充证据：真实 Claude/Codex retry duration 分布；若 P99 明显高于 90s，应调整 cap，但仍必须小于 stall 且不可无限。
- 【推测】OQ3：Claude SDK 当前是否能直接提供子进程 exit/spawn/auth 的结构化信号，而不只通过 query throw/stderr？现有 `claudeRuntime.ts` 可见的是 query stream、stderr callback 和 catch（`:829-886,1021-1027`）；需要 SDK/CLI fixture 才能决定证据 adapter 的最精确字段。
- 【实测】OQ4：Codex `turn/start` ack 在真实版本中究竟于 turn start 还是 turn end 返回仍 `[未测]`，源码自己如此标注（`codexRuntime.ts:371-379`）。因此本批不得改变 30min ack 语义；后续可用 wire probe 单独关闭该问题。
- 【推测】OQ5：AgentHostManager 当前没有显式 open-turn registry；S3 可从 runtime events 跟踪 `message.started(role:user)`/terminal，也可由 command lifecycle 跟踪。需在施工时选择单一来源，并用 crash-mid-turn fixture证明不漏、不误报 idle session。依据：Manager 目前只转发 event 并维护 Host state（`AgentHostManager.ts:413-495`）。
- 【推测】OQ6：detached turn 应落在独立 Zustand store 还是扩展 `turnSendStatus`？本稿要求的是所有权转移与 session-scoped latch，不锁死容器；需以最小文件冲突和 MessageTimeline selector 稳定性决定。当前 turn status 消费点在 `MessageTimeline.tsx:287-323,1003-1008`。
- 【推测】OQ7：300s 后“等待中”提示的具体中文/英文措辞、是否展示“still running”、颜色和图标属于另一个批次；F2 只保证不显示确定失败、不自动回显、不删除 Stop。依据：用户明确锁定本规格不越界改写文案内容。
- 【推测】OQ8：文本无附件 slow branch 本稿选择不激活；附件 slow branch保留。若后续文案批决定统一两者，应同时修改 `attachments.ts`、`turnStatus.ts` 与两套逐字/委托测试，不能只改一个表面。

### 13.2 双盲纪律自我报告

- 【实测】未读取、未搜索、未打开、未引用任何文件名含 `trackA` 的文件；没有触发双盲纪律警报。
- 【实测】探子任务均被明确要求禁止接触 `trackA`，所有返回也报告未触碰；本稿的最终裁定均由主线程对分诊、代码与测试的亲自阅读核对后写入。
- 【实测】未修改任何 `src/` 生产代码、测试代码或其它文档；本次唯一写入目标是 `docs/plans/2026-08-18-f2-watchdog-redesign-spec-trackB.md`。
