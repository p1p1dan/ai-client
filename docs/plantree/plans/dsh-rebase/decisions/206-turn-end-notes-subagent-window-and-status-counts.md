# 决策 206：停止或失败的回合保持展开并写明原因；子代理不再重复显示；去掉状态行的 ↑/↓ 计数

日期：2026-10-19（北京时间）。**状态：用户提出的改动，已实现，用户在 dev 应用里验收中。** 分支 `claude/claude-mode-issues-f4bc49`（基于 1.1.1-test.3 的 `claude/sub-agent-delegation-blocking-3a8feb`），本地提交，未推送。

## 1 用户的要求（2026-10-19，Windows，1.1.1-test.3）

1. Claude 模式下，上下文页的 Host stderr 一个会话里刷出几十条一样的 `[claude-sdk-host] start pid=… settingSources=…`，看不出有什么用。
2. 主动停止、意外停止、重试失败放弃之后，页面要停在原来的输出状态，并用气泡写明错误原因和内容，不要默认折叠。
3. 后台任务里已完成的项只能一项项移除。
4. 运行中的状态行 `Thinking 1s · ↑ 158.2k tokens · ↓ 712 tokens` 与 Claude 官方的不一致，也不会跟着变，只留「思考中 N 秒」。慢等待那一行的「↑ N 字符」也去掉。
5. 子代理窗口只显示正在运行的子代理，已完成、失败、被终止的要从列表里清掉。
6. 后台运行的子代理同时出现在后台任务和子代理两个窗口里，是重复的。

## 2 改法

### 2.1 Host stderr（第 1 项）

- 原因：每个 Claude 会话有自己的宿主进程，每起一次打一行启动行。闲置回收、重开、网关变化、崩溃重启都会重起进程；上下文页的 stderr 列表在整个应用运行期间既不清空也不去重。
- Main 侧新增 `isRoutineHostLine`（`hostStderr.ts`），匹配宿主的例行诊断行：启动行、正常退出、send now / withdraw 回执、Git Bash 查找。`WorkerManager.absorbStderr` 照常把这些行写日志、放进崩溃回放缓冲，只是不再转发成 `session.stderr`。警告、失败和 CLI 自己的 `[cli]` 行不受影响。
- 渲染侧 `foldStderrLine`：连续相同的行合并成一行，在**上下文页**显示为 `… (×N)`。日志里仍然每行都记。

### 2.2 停止或失败的回合（第 2 项）

- 原规则（2026-09-24 用户裁决）：结束的回合默认折叠，只有用户主动结束的（Stop、Ctrl+Enter）保持展开。现在扩大到所有**没有正常完成**的回合：主动停止、失败（包括重试放弃）、引擎中断。依然只是默认值，用户点一下照样能折起来（`turnWorkGroupOpen` 的规则不变，传入的是 `endedAbnormally`）。
- `session.failed` 给失败请求打 `stopReason: 'error'` 时，把错误码和原文一起记在消息的新字段 `ChatMessage.failure` 上（只在实时会话里有）。
- 新纯函数 `liveTurnEnd`（`turnEndNoticeModel.ts`）：回合末尾没有历史回放生成的结束说明时，从最后一条助手消息推出「已停止」或「失败 + 原因」。时间线在回合末尾用 `TurnEndNotice` 画成一个气泡；失败的气泡用 `error` 底色。
- 会话失败卡片还在时（最后一个回合、会话状态是 `failed`），同一条失败只由卡片说，不重复画气泡。等下次发送、卡片消失后，气泡留在那个回合上作为记录。
- 补充（dev 应用里实测后发现）：模型还没回复就失败或停止的回合（比如上游一开始就报错，或在重试中点「立即放弃」），本来没有任何助手消息可以记录原因，下次发送后原因就没了。现在记在这个回合的**用户消息**上：失败记 `failure`，停止记 `stopped`。`liveTurnEnd` 在回合里没有助手消息时读这两个字段。
- 「立即放弃」走的是停止。停止时如果会话正在重试，就把最后一次上游错误（如 `HTTP 503: server_error`）写进停止气泡的细节。宿主在停止前会先发一帧不带重试的状态，所以会话上另记 `lastRetryError`：回合进行中一直保留，回合结束才清掉。
- 气泡的显示条件不看「回合已结束」（`processSettled`），只看会话当前有没有回合在跑。没有回复就停止的回合，发送看守可能还挂着，会被误判成仍在进行。

### 2.3 后台任务（第 3 项）

- 后台任务窗口标题栏新增「清除已结束」按钮（`hideJobs`），一次收起所有可移除的行；和逐行「移除」一样，只影响这个窗口。

### 2.4 状态行计数（第 4 项）

- 运行中的那一行（`formatTurnLiveLine`）只显示动词和时间：「✻ 思考中 3 秒」「✻ 回复中 12 秒」。
- 等待行（`composerSendingLine`）和流式回合头（`deriveTurnStatus` 的 `streaming`）也不再带 ↑/↓ 字符数。`promptChars` / `replyChars` 两个参数保留在签名上，但不再使用。
- 用户看到的「tokens」字样，在 test.2 / test.3 的代码里找不到出处（当时的单位已经是「字符」）。这次把所有 ↑/↓ 计数都去掉，问题一并消失。

### 2.5 子代理窗口与后台任务的分工（第 5、6 项，推翻决策 109 第 3 条）

- 决策 109 第 3 条（2026-09-28）：同一个可续跑的子代理同时出现在后台任务窗、子代理窗和时间线泳道三处，「不算重复，三处都保留」。用户这次改为不重复。
- **后台任务窗**只列命令和工作流，不再列子代理（`deriveJobsWindowView` 过滤掉 `kind === 'subagent'` 的行，包括一次性后台子代理的作业和正在运行的可续跑子代理）。
- **子代理窗**只列正在运行的子代理；完成、失败、被打断的离开列表，记录仍保留在时间线和泳道里。标题计数改为「N 运行中」，空状态改为「当前没有运行中的子代理」。没在本窗口见过运行的旧子代理（只在目录里）不再列出。
- 停止能力搬到子代理窗：可续跑的照旧是「打断」；一次性后台子代理新增逐行「停止」，通过它的作业停掉（`deriveStoppableSubagentRows` + `stoppableRowFor`；SDK 引擎里泳道的 `agentId` 就是作业 id）。「全部停止」不变。
- 时间线泳道不受影响。

### 2.6 SDK 对话冷重开后，历史回合只剩「已工作」（用户同日补报）

- 现象：长对话 09:30 输出完，一切正常；10:20 以后再发消息，之前的回合都变成光秃秃的「已工作」，最终输出不见了，「子代理已完成，自动继续」后面各跟一个空回合。
- 触发：SDK 对话的宿主被释放后，下次发送会冷重开，新宿主读 CLI transcript 回放最近 80 条（`session.history`，`initial`）。释放的原因可能是闲置回收、网关或密钥指纹变化（`checkClaudeSdkGateways`，登录凭据刷新也会触发），也可能是崩溃。注意：窗口开着的对话有归属窗口，不会被闲置回收。
- 根因（`historyReplayMerge.ts`）：SDK 的历史行不带 `liveMessageId`，精确折叠一行也对不上，只剩按文本折叠，而它只认纯文本行。于是用户提问和最终输出被折掉了，带工具的步骤行和引擎回合头（没有文本）却留了下来，被追加到历史页**后面**。这些行并进历史页最后一个回合后，最终输出后面又出现工具步骤，`splitTurnWorkGroup` 就认定这个回合没有最终回复，把整个回合折成「已工作」。每个引擎回合头也各自开出一个空回合。
- 第一版改法（6b645ac1，只改渲染端）：
  - 新增按**工具调用 id** 精确折叠：模型给的 `toolu_…` 在实时步骤和 transcript 行上相同。一个步骤的所有调用都落在同一条未被占用的历史行上时，就折到那一行（同样要求已结算，引擎已死时除外）。
  - 新增**引擎回合头**折叠：没有文本的回合头（`origin` 是 subagent / job / scheduled），在它后面那条实时消息已折叠的前提下，折到对应历史行之前、中间没有隔着用户行的同类历史回合头上。
  - 回放没有锚点时（第一次重开，之前没有灌过历史），比所有已折叠行都早、又没对上的实时行，属于比历史页更早的部分，放到历史页**前面**；其余没对上的行照旧放在后面（比如重开后才发的消息）。
- 复审（2026-10-20，用户要求）：第一版只覆盖「第一次重开、页内每条实时行都能对上」。用临时测试复现了四种仍会出错的情况：
  - P1 第二次重开：第一次放到前面的旧回合，被挪到最新回合后面。
  - P2 历史页边界两侧各有一条同样的短消息（如「继续」）：文本折叠把旧的那条折到页内那条上，旧回合的步骤和回答又接到页内最后一个回合后面，最后一个回合的「最终回复」变成旧回答，和原来的症状同类。
  - P3 对话从侧栏打开过（灌过历史），之后的实时行超过一页：锚点被挤出窗口，文本折叠整体关闭，页内的回合全部再显示一遍。
  - P4 页内有一条 transcript 里没有的实时行（比如被重试截断的半截步骤）：被追加到最后，成了最后一个回合的「最终回复」。
- 第二版改法（分支 `claude/review-fix-6b645ac1-168c4d`，基于 6b645ac1）：
  - 宿主给实时消息和历史行都带上 `transcriptId`（`message.started` 与 `HistoryMessage` 的可选字段）：用户消息用发给 CLI 时带的 uuid，助手步骤用 API 消息 id。实测（SDK 0.3.300、本地假网关）：3 条普通发送和 1 条 Ctrl+Enter 插话的 uuid 都原样成为 transcript 行的 uuid。插话在文件里是 `queued_command` 附件，`getSessionMessages` 按它的 `source_uuid` 还原成用户行。8 个步骤的 `message_start` id 和 transcript 一一对应，历史投影本来就按这个 id 把一个步骤的各行合成一行。命令行、引擎回合头、本地命令回复不带这个字段（没核实，或是 CLI 自己生成的）。
  - 渲染端按「角色 + `transcriptId`」精确折叠，和 DSH 的 `liveMessageId` 走同一条路，不依赖锚点和游标。两条实时消息（或两条历史行）共用一个 id 时（网关重复返回同一个消息 id），这个 id 不用。两边都带 id 且不相同的，文本折叠不再把它们配对（P2）。按工具调用 id 和回合头的折叠保留，作为没有可用 id 时的退路。
  - 锚点被挤出窗口（守卫 3a）时不再整个放弃：精确折叠照做，只关掉文本折叠（P3）。
  - 没折掉的行不再一律追加到后面，而是按邻居插回原位。锚点是新历史页里还在的行：已折叠的实时行，或按 id 在新页里找得到的旧历史行。在第一个锚点之前的，放到历史页前面（比读取窗口更早，或在一次压缩之前：压缩后 CLI 的读取只返回压缩之后的链）；夹在两个锚点之间的，放到下一个锚点前面（P4）；在最后一个锚点之后的，以及重开后才发的，照旧放在后面。第二次重开时，旧回合后面紧跟的历史行就是锚点，所以旧回合留在前面（P1）。
  - 宿主消息 id 的格式不变。SDK 录制样本用 `event-record.ts --update` 更新，差异只有新增的 `transcriptId` 行。
  - 向上滚动加载更早一页（`mergeOlderHistoryPage`，从 `chatSessions.ts` 搬进 `historyReplayMerge.ts`）：原来只按行 id 去重，放在前面的旧实时行会和那一页里的同一批历史行各显示一份。现在先按同样的精确身份（`liveMessageId`、`transcriptId`，回合头随后面那一步）把它们折进这一页，没折掉的按邻居留在原位。一条都没对上时，它们比这一页还早（比如在一次压缩之前），留在这一页前面。
- 已知差别：折叠后显示的是历史行，SDK 的历史投影不带时间戳，所以旧回合不再显示「已工作 N 秒 · 完成于」的时长和时刻，最终输出都在。这一点没在这次改动里处理。

## 3 验证

- 根 `pnpm typecheck` 通过。
- 更新了按旧行为写的断言：`turnLiveHead`、`turnHandshakeOneLineMount`、`attachments`、`turnStatus`、`messageTimelinePendingStatic`、`turnEndOpenInteraction`（END-OPEN-3：失败的回合现在展开，点一下能折起）、`messageTimelineWiring`、`subwindowsModel`、`sessionSubwindowsMount`。
- 新增：`liveTurnEnd`（turnEndNotice.test.ts）、`isRoutineHostLine`（hostStderr.test.ts）、stderr 连续行合并（contextSurfaceModel.test.ts）、「清除已结束」挂载测试（P7B-MOUNT-CLEAR）。
- `src/renderer` 全部 390 个测试文件里只有 `legacyShellAbsence` 一项失败，它扫描的是这次没改的 `stores/settings/migration.ts`，与本次改动无关。WorkerManager / WorkerManagerClaudeSdk 测试通过。
- 2.2 的补充与 2.6：`historyReplayMerge.test.ts` 新增三条（按调用 id 和回合头折叠、比历史页更早的行放在前面、重开后才发的消息放在后面），`[D1-RESUME-2]` 改为没有 id 时按调用 id 折叠；`chatSessionsCore` 里「停止不改上一回合」那条改为断言新回合的用户消息记上停止。`src/renderer/stores` 与 `components/chat` 共 240 个文件、4516 项通过。
- dev 应用实测（隔离实例 + 本地假网关）：
  - 主动停止：输出保持展开，末尾出现「这一轮已停止。」。
  - 上游 500：先显示失败卡片；再发一条后，那个回合留下红色气泡和原始错误。
  - 503 重试中点「立即放弃」：气泡写「这一轮已停止，没有保存任何回复。」，细节 `HTTP 503: server_error`。
  - 冷重开（改假服务的密钥触发释放）：旧回合的实时行全部折进历史，没有残留，最终输出都在。
- 2.6 第二版：
  - `historyReplayMerge.test.ts` 新增 9 条（按 `transcriptId` 折叠任意步骤、P1～P4、压缩后旧回合留在摘要前面、带 id 的消息仍可按文本折到不带 id 的命令行、重复 id 不用、回合头）。N3、N18、N20 三条只改了顺序断言：没折掉的回显现在留在原位（N3 里紧挨着它自己的历史行），不再追加到最后。
  - `sdkSessionRuntime.test.ts` 新增 4 条（发送和插话的回显带上发给 CLI 的 uuid、步骤带 API 消息 id、历史行带同样的 id）；`chatSessionsHistory.test.ts` 新增两条端到端（三个回合、历史页只有后两个；重开后向上滚动加载更早一页，每条只剩一份）。
  - 加载更早一页：`historyReplayMerge.test.ts` 新增 4 条（前面没有实时行时照旧、按 id 折回并让更早的留在前面、一条都没对上时留在这一页前面、带附件的实时副本代替历史行）；`src/renderer/stores` 与 `components/chat` 共 240 个文件、4531 项通过，根 tsc 通过。
  - `src/renderer/stores`、`src/renderer/components/chat`、`src/claude-sdk-host` 与 `claudeSdkEngine` 共 255 个文件、4750 项通过；根 tsc 与 SDK 宿主 tsc 通过；`event-record.ts --check` 通过（样本已更新）。
  - 真宿主：`host-probe.ts` 的 `reopen` 场景新增检查，重开后的历史要按实时行带的 `transcriptId` 找到上一个回合的每条消息；整次运行的覆盖率只报告不判失败。`probe-suite.ts --only flow` 84 项检查全过：上一个回合 2/2 找到；整次运行只有 3/68，因为 flow 组在重开前跑了 `compact`，压缩之后 `getSessionMessages` 只返回压缩之后的链（`history` 场景只剩 3 行）。压缩前的实时行不在回放里，按上面的规则放在历史页（压缩摘要）前面，新增的测试覆盖了这一点。
- 还没在 dev 应用、打包应用或加密机上验证第二版。
