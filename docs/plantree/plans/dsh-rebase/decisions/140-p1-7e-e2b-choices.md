# 决策 140：P1-7e 第二组后半（e2b）与两类上游错误的实现取舍

日期：2026-09-30。**状态：自主决定，待用户审批。**

依据：

- [P1-7e 分组](../topics/p1-7e-pointcheck-fixes.md) 的 e2 行（本决策覆盖后半：问题 7、20、21 的前半、10、31），以及决策 139 第 12 条留下的「思考 N 秒」；
- [P1-7d 点验证据](../evidence/p1-7d-gui-2026-09-30.md) 的问题 7（A5）、10（A10、F2）、20、21（D2）、31（G3）；
- 用户在真实网关上遇到的两类错误：公司网关的流闸门（`stream_gate_precommit` / `prebuffer_overflow`），以及模型不接受的请求参数（`… is not supported for this model`）。

## 落地了什么

- `src/shared/dshFailureCodes.ts`：新增 `GATEWAY_STREAM_GATE`、`MODEL_SETTING_UNSUPPORTED` 两个码；`classifyDshFailureText`（按文字认这两类）、`dshFailureErrorCode`（先文字后码）、`isUnretryableDshFailure`（自动重试的否决条件）。
- `src/dsh-host/bridge/retryVeto.ts`（新）：挂在 `agent/request-error` 最前面的监听器；`bridge/plugin.ts` 在收件箱检查之前安装它。
- `src/dsh-host/bridge/liveEvents.ts`：直播的 `session.failed` 改用 `dshFailureErrorCode`。
- `src/shared/dshHistory/projection.ts`、`types.ts`，`src/shared/types/sessionHistory.ts`：失败回合的占位行带上 `failure: { errorCode, error }`；上下文摘要行的判定抽成 `isDshSummaryRow`。
- `src/dsh-host/bridge/dshSessionRuntime.ts`、`src/shared/types/workerRpc.ts`、`src/preload/index.ts`：`worker.compact` 成功时带回这次写下的上下文摘要行（`WorkerCompactResult.summary`，可选字段）。
- 渲染层：
  - 问题 7：`stores/chatSessions.ts`（`turnEnd` 标记）、`components/chat/turnEndNotice.ts`、`TurnEndNotice.tsx`（新）、`MessageTimeline.tsx`、`turnProcessFold.ts`（`endedWithoutReply`）、`turnEndCause.ts`；
  - 问题 20、21：`toolLiveOutputModel.ts`、`stores/toolLiveOutput.ts`（Stop 时留下的尾部）、`toolOutputHead.ts`（新）、`toolCard.ts`、`ToolRows.tsx`、`LiveToolOutput.tsx`、`BackgroundJobsWindow.tsx`；
  - 问题 10：`compactCommand.ts`、`stores/chatSessionActions.ts`（`showCompactionSummary`）、`ChatComposer.tsx`、`MessageTimeline.tsx`；
  - 思考时长：`stores/turnTimingRegistry.ts`（新）、`useTurnTiming.ts`、`ChatWorkspace.tsx`、`stores/sessionLifecycle.ts`；
  - 两类错误的卡：`sessionFailure.ts`、`FailureContinueButton.tsx`、`MessageTimeline.tsx`。
- `src/shared/i18n.ts`：新文案（中英）。
- 验证工具：`src/dsh-host/tools/fake-gateway.mjs` 新增 `P1-GATE`（HTTP 502，响应体是流闸门的拒绝）；`tools/loop-guard-smoke.ts` 的宿主 A 加一项 `e1GateNotRetried`。
- 问题 31 没有改代码，原因见下。

## 规则

### 问题 7：失败回合重开后的收尾

1. **历史行带上失败原因。** DSH 把失败的那次请求记成 `assistant/attempt`，不进模型历史，所以投影一直只补一个空的占位行。现在占位行带上 `turn/end` 记下的两样东西：我们的码（与直播 `session.failed` 用同一个函数 `dshFailureErrorCode` 算出）和 DSH 的原句（超过 2000 字截断，末尾加「…」）。两样都没有时不带。只有失败回合带；Stop 的占位行没有原因可带。
2. **渲染层把「什么都没保存的回合结尾」当注记，不当回复。** 历史里 `incomplete`、没有任何块的 assistant 行，映射成 system 行并带 `turnEnd`（`failed` / `stopped` / `interrupted`）。时间线用中断注记的样子画它（同一个默认 `Alert` 外壳、同一正文字号），不标红，不在「最终输出」下面，也不进「复制回复」。块里仍留一句英文（`This turn did not finish. No reply was saved.` 等），给只读文字、不读标记的地方用。
3. **措辞**：
   - 失败且认得出原因：「这一轮没有完成：{原因}，没有保存任何回复。」。{原因}就是那张直播失败卡的标题，例如「模型服务返回了错误」「公司网关中断了这次回复」。下面一行照录 DSH 原句（等宽，经 `Ident` 原语）；失败卡本身不印原句的码（`dsh_host_crashed` 等，那句是本应用写的进程诊断）这里也不印。
   - 失败但没有码（旧数据、1.0.x 迁来的会话）或码不认识：「这一轮没有完成，没有保存任何回复。」，有原句仍照录。
   - Stop：「这一轮已停止，没有保存任何回复。」；被截断：「这一轮中断了，没有保存任何回复。」。
   - **前面已经保存过东西时不说「没有保存任何回复」**：DSH 在回合失败时总会补这个占位行，不只是第一次请求就失败的情形。前面有工具调用、思考或文字时，只说「这一轮没有完成：{原因}。」（Stop、中断同理）。原先的英文兜底句在这种情形下也是错的。
4. **没有「完成于」，保留「已工作」**：这一轮没有完成，所以不报完成时间（`deriveTurnWorkZone` 的 `endedWithoutReply`）；「已工作 N 秒」照旧，那是这一轮实际用掉的时间（含 DSH 的自动重试）。
5. 重开后的注记上没有「继续」：失败卡与「继续」只在直播里有，这一点不变。
6. `turnEndCause` 把这种注记当作回合的结尾：Stop 的注记仍算「用户停下的」，与改动前读空 assistant 行的结果相同。

### 问题 20：Stop 之后命令行的展开体

7. **根因**：DSH 对被 Stop 截断的前台命令只记一句 `Error: tool call aborted`（录制 `log.stop-tool` 可见），已经输出的内容不在记录里；行的展开体就把这句英文当成了输出。
8. **改法**：渲染层在收到带 `details.stopped` 的 `tool.completed` 时，把这个调用最后一次直播尾部（`tool.output`）留下来，按「对话 + 调用 id」存，最多 32 个，只在内存里，对话消失时一起清掉。这一行的展开体显示留下的内容；英文那句不再作为正文。行尾仍是 P1-7c（决策 120）的「· 已停止」，不标红。
9. **还原不了的情形照实**：应用重启后、或者 Stop 发生在第一段尾部送到之前，没有可显示的输出，展开体只有说明和命令，不补任何文字。尾部按节流发送，Stop 前最后一小段时间里打印的内容可能不在其中；尾部最多 16 KiB。

### 问题 21 的前半：大输出从一行中间开始

10. 输出的开头被截掉有三个来源：行上的直播尾部、后台任务窗、DSH 自己对长输出的记录（只留 stdout 的尾部，后接 `[output truncated; full output: <路径>]`）。三处都从下一个换行后开始显示，被切掉的半行计入省略量。
11. **提示放在输出最上面一行**，与后台任务窗同一个说法：字节数已知时「已省略前 x KB」（同一个文案键，同样四舍五入到 KB、至少 1 KB）；DSH 的记录不说它丢了多少，就写「已省略前面的输出」，不去读溢出文件的大小（要新开 IPC 读文件，而完整输出的路径 DSH 已经写在末尾）。
12. 只处理 bash / pwsh 的 stdout：截断说明属于 stderr 时、或根本没有 stdout 时原样显示；整段只有一行半截内容时保留这一行，免得什么都不显示。

### 问题 10：`/compact` 的直播提示与耗时归属

13. **直播里的成功提示就是重开时看到的那一行。** `worker.compact` 成功后，bridge 从它的历史缓存里取这次命令新写的上下文摘要行（与之前最后一行摘要比较，不是新的就不带），随答复一起交回；渲染层把这一行按同一个 `h:` id 接在时间线末尾，之后任何一次历史回放都会以同一 id 取代它，不会出现两行。没有新增直播事件，决策 113 第 8 条不变。
14. 取不到这一行时（旧 worker、缓存未就绪、对话已不在），改用一条成功 toast：「对话已压缩 / 摘要会在重新打开这个对话时显示为「Context summary」。」
15. **压缩耗时不算进上一回合**：上下文摘要行（system 行，第一个块的 id 是 `<行 id>:summary:0`，`isDshSummaryRow`）不参与回合用时的计算。摘要行仍画在上一回合的正文末尾（分组不变，与重开时一致）。1.0.x 迁来的分支摘要是同一种行，同样不计。
16. 「Context summary」这个标题本身仍是英文（投影里的常量），属于 e4 文案组。

### 问题 31：重开后「· 已允许」尾注消失

17. **重启后还原不了，本次不改代码。** 查过三处现有数据：
    - DSH 历史：我们的闸门在 `tools/pre-execute` 里弹卡、作答，不经 DSH 的审批服务，所以日志里没有这张卡的任何痕迹。录制 `log.perm-card` 里，被允许的写入只有 `tool/call` 与 `tool/result`；被拒的那次是 `Error: permission denied`，与规则直接拒绝（不弹卡）的文字相同，也分不出是卡拒的。
    - 授权 sidecar（`<stub>.dsh.grants.json`）：只存「本会话允许」的规则（路径、命令前缀、值），没有调用 id，也没有时间，无法说哪一次调用是被哪条规则放行的，更不记单次「允许」。
    - bridge 的历史投影：只读 DSH 日志，同上。DSH 自己的审批（`approval/asked` 带 `callId`、`approval/decided`）只在 DSH 自己发问时才有（例如沙箱升级），不是闸门的卡；现有录制里一次都没有。
    硬凑（例如凡是与某条授权规则匹配的调用都标「已允许」）就是编造，不做。
18. **相关发现（未修，按代码推断，未实测）**：同一次运行里，对话被容量回收后再点开（温恢复），历史回放按 id 取代已结算的直播消息（`historyReplayMerge.ts` 的 `foldExactLiveIds`，已作答的权限块算已结算），权限块随直播消息一起被换掉，「· 已允许」同样会消失。
19. **建议（需用户决定）**：若要重开后仍有尾注，需要在作答时持久记录每次调用的结论（例如 bridge 按会话写一个「调用 id → 允许/拒绝/自动」的 sidecar，或向 DSH 日志追加一条自有事件，再由投影带到工具行）。这是新的持久格式，不在本次范围。

### 「思考 N 秒」在时间线重新挂载后消失

20. 照决策 139 第 10 条的办法：思考与工具调用的时间戳移到 `stores/turnTimingRegistry.ts`，整个运行期保存、按对话分开，一个监听器收所有对话的事件；`ChatWorkspace` 在整个运行期持有（引用计数，单独挂载的时间线也持有一份）。回退时清掉该对话的记录，对话消失时一并清掉。
21. 重启后仍然没有：历史只给消息记日期，不给思考记时长。

### 两类上游错误

22. **在发出方按文字认，渲染层仍只读码。** `sessionFailure.ts` 开头定的规则是「分类是读出来的，不是猜子串」；这两类错误只有文字能分辨（5xx 在 DSH 里是 `SERVER`，400 是 `INVALID_REQUEST`，pi-ai 读不懂的是 `PI_AI_ERROR`），所以由 bridge 这个发出方读 provider 自己的原文，写成码交给渲染层。规则：
    - 流闸门：文字里出现 `stream_gate_precommit` 或 `prebuffer_overflow` 之一（整词，不分大小写）即算，外面包了什么都行；
    - 模型设置不兼容：出现 `is not supported for this model`；
    - 两者都出现时算流闸门；先看文字，认不出再按 DSH 的码映射。直播与历史投影用同一个函数。这两个标记都不是 DSH 自己会写的词。
23. **流闸门的卡**：标题「公司网关中断了这次回复」，原因「公司网关在模型开始回答之前中断了这次回复。」，提示「重试同一请求通常还会失败。请换一个模型或调低思考档位，并把错误详情转给网关管理员。」，下面照录原始错误文本。仍给按钮，但按钮写「仍然继续」，提示句与按钮同时显示（其他可继续的卡只显示按钮）。「详情」不写「下面的」：卡上原文在提示之前。
24. **模型设置不兼容的卡**：标题「模型设置与该模型不兼容」，原因「模型服务拒绝了本应用随请求发送的一项设置：这个模型不支持它。」，提示「请在模型设置里检查这个模型的思考相关配置，改好后再发一次消息。」，照录原文；动作是 `configure`，**不给「继续」**：设置不改，重发只会同样失败（与密钥、上下文过长两张卡一致）。
25. **不自动重试**：DSH 的重试策略只按类别（`retryableCodes`）判断，`always` 模式甚至不看类别，都没有按文字的开关。bridge 行在 `agent/request-error` 上前置一个监听器：这两类失败直接定为终止，不交给后面的 `llm-retry`；其余失败原样往后传（循环守卫、图片外移、`llm-retry` 照旧）。它在收件箱检查之前安装，管住宿主里的每一个 agent，子 agent 也在内。
26. **真宿主验证**：`tools/loop-guard-smoke.ts` 宿主 A（网关路由为 `always` 模式、200 ms 退避）里，`P1-GATE`（HTTP 502，DSH 记为 `SERVER`）网关只收到 1 次请求、0 次 `llm/retry`、`turn/end` 为 error；同一宿主里的 `P1-FAIL`（HTTP 500）照常被重试 3 次。
27. **边界**：网关若只回一个不含这两个标记的 5xx（例如只有「502 Bad Gateway」），仍按普通服务端错误处理，会被自动重试，卡片是「模型服务返回了错误」。

## 测试

- 新增文件：`bridge/__tests__/retryVeto.test.ts`（4）、`chat/__tests__/turnEndNotice.test.ts`（8）、`turnEndReplayMount.test.ts`（挂载，3）、`toolOutputHead.test.ts`（7）、`toolOutputHeadRows.test.ts`（含挂载，7）、`failureCardProviderText.test.ts`（挂载，2）、`timelineThoughtRemount.test.ts`（挂载，2）、`stores/__tests__/turnTimingRegistry.test.ts`（6）。
- 追加：`dshFailureCodes.test.ts` 5 条、`liveEvents.test.ts` 1 条、`projection.test.ts` 2 条、`sessionFailure.test.ts` 3 条、`chatSessionsHistory.test.ts` 1 条、`commandsAndState.test.ts` 1 条、`compactCommand.test.ts` 3 条、`chatSessionActions.test.ts` 2 条、`toolLiveOutputModel.test.ts` 3 条、`turnEndCause.test.ts` 1 条、`turnProcessFold.test.ts` 1 条。
- 改写：`chatSessionsHistory.test.ts` 里「空 assistant 行回放成英文兜底句」一条，改为回放成带 `turnEnd` 的注记。
- 真宿主：`loop-guard-smoke.ts` 宿主 A 新增 `e1GateNotRetried`。

## 金样本

需要编排者重录两份（`bridge-record --check` 的两处差异，都是本决策的预期结果）：

- `rpc.fail.json`：`history.page.messages[1]` 多出 `failure`（`PROVIDER_ERROR` 与 500 原文）。`dshHistoryGolden.test.ts` 的「the fail recording」在重录前会失败。
- `rpc.compact.json`：`compact.compacted.result` 多出 `summary`（这次压缩写下的上下文摘要行）。

## 用户审批

待审批。
