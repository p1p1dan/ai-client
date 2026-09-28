Role: topic

# P1-4c / 4d / 4e 与 P1-16 剩余部分：按「跟随 DSH」重划范围

上位：[roadmap P1-4、P1-16](../roadmap.md)。依据：[决策 090](../decisions/090-user-rulings-2026-09-28.md) 的总原则（用户原话「不用考虑一致性，按 DSH 特性来就行」）；原方案 [P1-4 bridge 对等](p1-4-bridge-parity.md)（§6 子任务定义，分片 01～05）、[P1-10 / P1-16 扩展与用户资产](p1-10-p1-16-extensions.md)（分片 01～04）；决策 [026](../decisions/026-history-per-message-tree-across-lineage.md)～[032](../decisions/032-interrupted-turn-system-note.md)、[060](../decisions/060-first-allowlist-pilot-office-tools.md)～[064](../decisions/064-accepted-behavior-differences-extensions.md)、[072](../decisions/072-renderer-data-channels.md)、[081](../decisions/081-loop-guard-implementation-choices.md)、[086](../decisions/086-shared-skills-mcp-move-choices.md)～[088](../decisions/088-permission-gate-wiring-choices.md)。

状态：
- 只读调研，基线 worktree HEAD `44d66019`（`src/dsh-host/bridge/dshSessionRuntime.ts` 最后一次改动是 `262a240c`）。
- 没有改代码，没有起宿主或 Electron，没有跑测试，没有联网，没有调用模型。
- 决策草稿 [093](../decisions/093-interject-via-dsh-steer.md)～[105](../decisions/105-drop-delegation-switch.md)，状态都是「自主决定，待用户审批」；其中 093、097、102、103 标了「需用户拍板」。
- 本文不改 roadmap、看板、README 与已有决策，由编排者同步。

约定：DSH 路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`，版本 `0.1.7-rc.2`，以已装源码为准；我方行号取 HEAD `44d66019`。标「推断」「需实测」的没有运行验证。

## 1 结论先行

1. **判定口径**（§2）：先问 DSH 有没有自带做法，有就用；没有，再问是不是「旧会话和设置能迁移、已装用户能正常升级」所必需，或是不是把 DSH 自己的状态显示给用户所必需；两者都不是、只为与 1.0.x 一致的，删除或推迟到合入之后。
2. **P1-4c（v1.0.3 语义）**：
   - Ctrl+Enter 插话改用 DSH 的 `steer`：消息在下一个步边界并入当前回合，回合不结束，目标也不暂停。这取代决策 029、071，**需用户拍板**（决策 093）。
   - Stop 改用 DSH 停止按钮的语义，保留收件箱（决策 094）。
   - 失败后「继续」**保留**决策 028 的隐藏续跑提示：DSH 只有回合内的自动重试，没有手动重跑，去掉会退回 T135 之前的问题（决策 095）。
   - 发图与读图直接用 DSH 的附件服务和 `read_image`（决策 096）。
   - 文本附件改为 DSH 的文件块，由模型按需读取，**需用户拍板**（决策 097）。
3. **P1-4d（其余事件）**：只把 DSH 自己的数据映射到渲染层现有的事件上（决策 099）。
   - 提问卡改用 DSH 官方的 `dsh-tool-ask-user`，bridge 只做应答方（决策 098）；这个包不在钉住的树里，装包要联网。
   - `execStartedAt` 移到 P1-7b；每轮 model / effort 已由 P1-5 做完；流式工具参数只报大小；费用不算；`/skill:` 改写不做。
4. **P1-4e（录制门禁）**：保留并进 CI，场景随 4c / 4d 重划（决策 100）。
5. **P1-16**：只剩下「让 DSH 原生行读到原来的位置」和「告诉用户哪些东西不再生效」。
   - 全局指令与技能改由 DSH 原生行读取：`dshHome` 指向 `<agentDir>`，技能目录加上 `<agentDir>/skills`；技能调用改用 DSH 的 `/<name>`；不做兼容报告界面（决策 101）。
   - 不再读 `~/.claude/CLAUDE.md` 这类用户层指令（决策 102，**需用户拍板**）。
   - 提示词模板不再支持，P1-16c 取消（决策 103，**需用户拍板**）。
   - 一处「旧资产一次性提示」取代 P1-16d 与原方案里分散的各页说明，「扩展」设置页随之收窄（决策 104）；委派总开关作废（决策 105）。
6. **工作量**（§6）：
   - P1-4 剩余部分重划后没有变小，约 21 人日，约 4 人周；原方案对剩余部分的估算约 2～3.5 人周。
     - 删掉和移出的，与 steer 的渲染层改动、提问工具装包、072 / 081 / 088 后来交接进来的映射大致相抵；
     - 本文按项估算，也偏保守。
   - P1-16 剩余从约 1.2～1.5 人周降到约 0.9 人周；加上此前已取消的 MCP、自定义子代理，P1-16 从原估 3～4 人周降到约 1 人周。

## 2 判定口径

| 步骤 | 问题 | 结论 |
|---|---|---|
| ① | DSH 有没有自带做法（已装包里能找到源码）？ | 有：**改用 DSH 做法**。我方只写映射，不移植 1.0.x 的实现 |
| ② | 没有的话，是不是「旧会话和设置能迁移」「已装用户能正常升级」所必需？ | 是：**保留**，取最小实现 |
| ③ | 是不是把 DSH 自己的状态显示给用户所必需（渲染层没有别的数据源）？ | 是：**保留**，只做映射 |
| ④ | 以上都不是，只为与 1.0.x 一致 | **删除**；有用户价值但不急的，**推迟到合入之后** |

例外只有一条：成本很小、而且不做就会退回已修过的问题的，保留并在决策里写明理由（决策 095）。

## 3 本次新核对的 DSH 事实

原方案分片已有的事实不再重复，这里只列本次重划用到的新事实。

- **给忙碌 agent 送消息**：
  - `followup` 进下一回合，`steer` 进下一步，`inject` 进下一步但不唤醒（`dsh-agent/README.md:47`；`dsh-agent-loop/lib/index.js:800-814`）。
  - 步结束后，收件箱的 next-step 里还有消息，回合就继续开下一步（`dsh-agent-loop/lib/index.js:983-990`）；回合结束时收件箱还有待处理的内容，driver 会接着开下一回合（`:1020`）。所以 steer 不会丢。
  - DSH 自己就是这样给忙碌的父 agent 送子代理完成通知的：空闲用 queue、忙碌用 steer（`dsh-subagent/lib/index.js:1264`）；`/plan <消息>` 也用 steer（`dsh-plan-mode/README.md:89`）。
  - 目标：人的 steer 不会触发目标收尾，「loop keeps concurrent human steering available」（`dsh-tool-goal/README.md:57`）。而 cancel 会让目标停下：取消的是目标轮，目标在下一个空闲点暂停；取消的回合与目标无关，也会解除续跑（`dsh-goal-round-driver/README.md:53`）。
- **停止按钮**：
  - DSH 客户端的停止按钮是 `cancel({kind:'user'}, {keepInbox:true})`（`dsh-agent/README.md:110`）；DSH 自己的用户打断也这样写（`dsh-subagent/lib/index.js:855`；`dsh-goal-round-driver/lib/index.js:234`）。
  - 不带 `keepInbox` 的 cancel 会清空收件箱（`dsh-agent/README.md:178`）；收件箱为空时清空不落事件（`dsh-agent-loop/lib/index.js:188`）。
  - Stop 之后不会自己再开回合，保留下来的输入等下一次唤醒时被取走（`dsh-agent-loop/lib/index.js:854-858,887-899`）。
- **失败重试**：`dsh-llm-retry` 在同一回合内自动重跑失败的一步。默认 normal 模式，对 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 重试 5 次，退避 0.5～10 s；对模型不可见（`dsh-llm-retry/README.md:50,58`）。重试用尽后回合以 `error` 结束，DSH 没有「回合之外手动重跑」的接口。
- **附件**：
  - 图片：`ctx.attachments.admitPromptContent` 校验、归一化、入库（`dsh-attachment/lib/types/index.d.ts:51`）。单张 20 MiB；每条消息最多 20 张、合计 200 MiB；归一化到总像素 2048²、长边 8192、目标 4 MiB（`dsh-attachment-local/README.md:41,86`）。
  - 其他文件（包括文本）：`saveFile` 按原字节存，不限类型和大小（`dsh-attachment/lib/types/index.d.ts:97`）。模型只收到一行句柄，写着文件名、字节数、摘要前缀和只读路径，需要时自己用文件工具读（`dsh-attachment/README.md:40,106`）。
  - 句柄路径由 `fs.processPathFromHostPath` 给出（`dsh-llm/lib/index.js:2268-2277`）；文件落在 `<DSH_HOME>/attachments/v1/files/…`，是只读硬链接（`dsh-attachment-local/README.md:90`）。
  - 附件永不自动删除（`dsh-attachment/README.md:12`）。
- **读图**：`read` 只读 UTF-8，遇到图片会提示改用 `read_image`；模型没声明图片输入时，`read_image` 拒绝（`dsh-tool-fs/README.md:224`）。
- **提问工具**：
  - 官方有 `@deepseek-ai/dsh-tool-ask-user`，工具名 `ask_user_question`（`dsh-user-questions/README.md:50,55`）；dsh-base 的 plan-mode 提示词也引用它（`dsh-base/cordis.patch.yml:331`）。
  - **这个包不在钉住的树里**：`src/dsh-host/node_modules` 与锁文件都没有。
  - 只有根 agent 能问，子代理问会得到错误（`dsh-user-questions/README.md:33,41`）。
- **命令**：
  - 我方组合里注册的命令有 `goal`、`compact`、`plan`、`feedback`（`dsh-command-goal/lib/index.js:175-177`；`dsh-command-compact/lib/index.js:93-95`；`dsh-plan-mode/lib/index.js:181-183`；`dsh-command-feedback/lib/index.js:165-167`）。`permission` 那一行已关（决策 047、088）。
  - `/feedback` 只写本地日志（`dsh-command-feedback/README.md:12`）。
  - DSH 的交互适配器会拒绝未知命令，不当作提示词（`dsh-commands/README.md:50`）。
- **写文件的差异卡**：`write` / `edit` 的结果带 `presentationMeta`，内容是 `{operation, diffs:[{path, oldText, newText}]}`（`dsh-tool-fs/lib/index.js:570-577,722`）。
- **技能**：用户消息里任何位置出现 `/name`，只要它是用户可调的技能，就注入技能正文（`dsh-tool-skill/README.md:12,54`）；根目录与优先级见 `dsh-skill-filesystem/README.md:44-56`。
- **指令**：`agent-instructions` 的 `dshHome` 只决定用户全局 `AGENTS.md` 在哪（`dsh-agent-instructions/README.md:66`；`lib/index.js:141`）。

## 4 逐项表

每一行的细节与取舍见所引的决策。「工作量」按一人做、含单测估算，1 人周 = 5 人日。「金样本」指 `src/shared/__tests__/fixtures/dsh/` 下 `stream` / `log` / `rpc` 三类，现有 9 个场景：stream、tool、fail、stop-stream、stop-tool、compact、crash-resume、rewind、fork。

### 4.1 P1-4c v1.0.3 语义

| 编号 | 这一项是什么 | 1.0.x 怎么做 | DSH 自带做法（位置） | 建议 | 理由 | 工作量 | 迁移 / 升级影响 | 受影响的测试与金样本 |
|---|---|---|---|---|---|---|---|---|
| 4c-1 | Ctrl+Enter 插话：回合进行中补一句 | 渲染层把消息放进队首，发 `worker.interject`；worker 在当前一轮（一次模型调用加它的工具）结束后收尾，发 `session.completed{stopCause:'interjected'}`，队首消息作为新回合发出；`turnActive` 回报有没有回合（`workerRpc.ts:608-625`；决策 029；runtime-hardening 决策 041、046） | 有：`agent.steer()` 把消息放进 next-step，下一个步边界并入当前回合（`dsh-agent-loop/lib/index.js:809-811,990`）；DSH 给忙碌 agent 送消息就用它（§3） | **改用 DSH 做法**（[决策 093](../decisions/093-interject-via-dsh-steer.md)，**需用户拍板**） | 步边界 `cancel(hook)` 是为对齐 1.0.3 自研的组合用法，DSH 没有「停在下一个边界」的原语（`dsh-agent/README.md:178`），还会让目标暂停（决策 071）；steer 是 DSH 的原生语义 | 约 3.5 人日：bridge 约 120 行、Main 与协议约 40 行、渲染层约 200 行、测试约 400 行。保留 029 约 1.5 人日 | 迁移会话里 1.0.x 的插话照旧显示「已插话」：转换器写 `aborted{hook:'aiclient-interject'}`（`legacyPiSession/convert/seed.ts:296-300`），投影规则保留（`dshHistory/projection.ts:236-241`）。升级无影响 | bridge `dshSessionRuntime.test.ts`；`workerRpc.test.ts`；`WorkerManager.test.ts`；渲染层 `messageQueue.test.ts`、`queueRelease.test.ts`、`composerStopStatic.test.ts`。新增 `steer` 金样本，已有 9 个不变 |
| 4c-2 | Stop 时，收件箱里还没被取走的输入（插话、后台任务通知） | 1.0.x 没有收件箱，插话留在渲染层队列里；现在 bridge 的 Stop 是 `cancel({kind:'user'})`，会清空 DSH 收件箱（`dshSessionRuntime.ts:823-828`） | 有：停止按钮是 `cancel({kind:'user'},{keepInbox:true})`（§3） | **改用 DSH 做法**（[决策 094](../decisions/094-stop-keeps-inbox.md)） | 清空会悄悄丢掉用户的插话和后台任务的完成通知 | 约 0.25 人日 | 收件箱是持久的（`agent/inbox/spliced`），重开会话后仍在。升级无影响 | `dshSessionRuntime.test.ts` 的 stop 断言。`stop-stream`、`stop-tool` 金样本预计不变（空收件箱不落事件），收口时用 `--check` 确认 |
| 4c-3 | 失败后「继续」：重试上一轮 | `mode:'retry'`：从失败前的上下文重跑，不追加 user 消息，保留已完成的工具轮；没有可重跑的回合时抛 `WORKER_RETRY_UNAVAILABLE`（runtime-hardening 决策 045、T135） | 部分：`dsh-llm-retry` 只在回合内自动重试临时错误；回合以 `error` 结束之后没有手动重跑的接口（§3）。失败尝试记为 `assistant/attempt`，不进上下文 | **保留**，沿用决策 028（[决策 095](../decisions/095-retry-keeps-hidden-continuation.md)） | DSH 没有这一项的做法；去掉会退回 T135 之前「把原提示再发一遍」的问题（`retryLastTurn.ts` 文件头）；投影已经会隐藏 `aiclient-retry`（`projection.ts:469-472`） | 约 1 人日 | 无 | `dshSessionRuntime.test.ts` 的「refuses a retry」改为受理规则用例。新增 `fail-retry` 金样本（假网关先失败一次）。渲染层不改 |
| 4c-4 | 发图与回显附件 | 渲染层与 Main 限单个 5 MiB（`src/shared/types/attachmentIo.ts:36`）；native 把原图作为内容块发给模型，另有每轮字节预算（`runtime/plugins/agent-loop/attachments.ts:38-55`）。P1-1 起 DSH 会话带附件一律拒绝（决策 010） | 有：`admitPromptContent` 校验、归一化、入库，消息里放 image 块（§3） | **改用 DSH 做法**（[决策 096](../decisions/096-images-via-dsh-attachments.md)） | 原方案本来就走 DSH。重划只去掉「bridge 再查一次 5 MiB」这层 1.0.x 的防绕过：渲染层和 Main 已经把关，DSH 自己也有上限 | 约 1.5 人日 | P1-9c 迁移旧会话里的图片，走同一个入库入口。附件永不自动删除 | `dshSessionRuntime.test.ts` 的「refuses attachments」改写；`sendRefusalWiring.test.ts` 的 D2 用例改拒绝码与注释。新增 `image` 金样本，假网关要回显收到的图片块数 |
| 4c-5 | 读图：模型读工作区里的图片 | `read` 工具的图片分支（`7fe97881`） | 有：单独的 `read_image`（§3）；需要模型声明图片输入，P1-5 计划已带 `input`（`src/shared/dshModelPlan/build.ts:355`） | **改用 DSH 做法**（决策 096） | 不必移植 | 0；工具行文案归 P1-7c | 无 | P1-7c 的工具行测试 |
| 4c-6 | 文本附件 | 渲染层读成文本，native 以 `--- name ---` 并进正文（`runtime/plugins/agent-loop/attachments.ts:85-138`） | 有：非图片文件按原字节存成文件块，模型只收到一行句柄，需要时用文件工具读（§3） | **改用 DSH 做法**（[决策 097](../decisions/097-text-attachments-as-dsh-file-blocks.md)，**需用户拍板**） | 并进正文的话，DSH 日志里 user 消息的正文就是整个文件，历史重读时气泡会显示文件内容，要另加投影规则拆开；大文件会塞满上下文。文件块是 DSH 原生形态，历史已能投影成附件 chip（`projection.ts:148-153`） | 约 1.5 人日，含 P1-6 的可信路径规则和一个实验 | 迁移会话里 1.0.x 并进正文的文本不变 | `permissionHost.test.ts`（可信路径）；`dshSessionRuntime.test.ts`。新增 `file-attach` 金样本 |

### 4.2 P1-4d 其余事件

总的取舍见[决策 099](../decisions/099-p1-4d-scope-dsh-data-only.md)。这一组大多是「DSH 的数据 → 渲染层现有事件」的映射，渲染层没有别的数据源，按口径 ③ 保留。

| 编号 | 这一项是什么 | 1.0.x 怎么做 | DSH 自带做法（位置） | 建议 | 理由 | 工作量 | 迁移 / 升级影响 | 受影响的测试与金样本 |
|---|---|---|---|---|---|---|---|---|
| 4d-1 | 用量：已结算、进行中、上下文占用环、会话累计 | pi 的 turn_end 用量与模型表计价（`shared/piUsage.ts`） | 有：每步 `assistant/message.usage`、流里的 `usage` chunk、`dsh-token-meter` 的 `tokenUsage` 与 `contextPressure` 投影（P1-4 分片 04 §4） | **保留**，数据全取 DSH；`costUsd` 不算（决策 099 第 1 条） | DSH 不计价；Cost 指标只在大于 0 时出现（`RunSurfaceView.tsx:346,392`），不算就不显示 | 约 1 人日 | 累计取 `tokenUsage` 投影，迁移会话的种子也计入 | 全部 `stream.*.json` 会多出 `usage.updated`（数字已归一化成 0）。新增 `usage` 场景 |
| 4d-2 | 思考块的起止 | 首个思考增量、转正文时关闭 | 有：`block-start` / `block-end`，blockType 为 `reasoning`（`dsh-llm/lib/types/types.d.ts:418-436`） | **保留**（决策 099 第 2 条） | 渲染层靠它折叠思考 | 约 0.25 人日 | 无 | 新增 `think` 场景，假网关要带 reasoning 块 |
| 4d-3 | 流式工具参数摘要（T101） | 从部分 JSON 里提前读出 `path` 等短字段，其余只报大小（`runtime/events/streamingToolArgs.ts`，依赖 pi 的 `parseStreamingJson`） | 有 `tool-call-delta.argumentsDelta`，没有部分 JSON 解析 | **简化**：只报字节数和行数，用 shared 现成的 `countStreamingLines`（`src/shared/streamingToolArgs.ts:43`；决策 099 第 14 条） | 提前显示路径只是体验细节；移植要另带部分 JSON 解析器 | 约 0.5 人日 | 无 | `tool`、`stop-tool`、`crash-resume` 等含工具的 `stream` 金样本 |
| 4d-4 | `execStartedAt`：工具计时不含审批等待（T146） | runtime 在真正执行时打点 | 有：`tools/execute` waterfall（`dsh-tools/lib/types/index.d.ts:58`） | **移到 P1-7b**（决策 099 第 15 条） | 与前台 job 对应用同一个挂点（P1-7 实验 E1），一起做 | 0（计入 P1-7b） | 无 | 在那之前，工具计时包含审批等待 |
| 4d-5 | 直播里的工具行标志：未开始、已停止、被拒 | runtime 的 `details`（`notStarted` / `stopped` / `refused`） | 有：`tool/result.error.code`（`ABORTED_BEFORE_DISPATCH`、`TOOL_NOT_STARTED`、`ABORTED`）与我方闸门的拒绝 | **保留**（决策 099 第 5 条） | 历史投影已按错误码做（`projection.ts:604-625`），直播跟上即可；包含决策 072 的「bash 被取消看 `ABORTED`」和 088 的「Stop 收卡后显示未开始」 | 约 0.75 人日 | 无 | `stop-tool` 金样本；`permissionBridge.test.ts` |
| 4d-6 | 会话改动审阅：写 / 改文件的 `review` | 宿主先读改动前的文件，再用 `shared/textDiff.ts` 生成补丁（`runtime/plugins/tools/file-change.ts`） | 有：`write` / `edit` 的差异卡元数据（§3） | **改用 DSH 数据**：由 `diffs` 生成补丁，不再另读文件（决策 099 第 6 条） | 渲染层的改动审阅只有这个数据源；DSH 已经算过差异 | 约 0.75 人日 | 迁移会话沿用 `meta.aiclient.piDetails.review`（`projection.ts:606-608`） | 新增或改写一个写文件场景 |
| 4d-7 | 重试横幅 | pi 的重试事件 → `session.status.retry` | 有：`llm/retry`、`llm/retry-started` | **保留**（决策 099 第 3 条） | DSH 自动重试时用户要看得到 | 约 0.5 人日 | 无 | `usage` 或 `fail-retry` 场景顺带覆盖 |
| 4d-8 | 失败的文案与结束原因 | `session.failed{error, errorCode}` | `turn/end.reason.error`（`LlmFailure`） | **保留**（决策 099 第 4 条）。错误码已由 085 接上；剩下两件：`error` 改成 `LlmFailure.message`（P1-1 点验 D3 的余项）；`aborted{hook:'aiclient-turn-ceiling'}` 映射成 `session.completed{stopCause:'turn_limit'}`（081 交接） | 现在失败卡直接显示 JSON 串（`dshSessionRuntime.ts:1535-1541`）；500 步收尾现在被报成「已停止」 | 约 0.25 人日 | 无 | `fail` 金样本；`loop-guard-smoke` |
| 4d-9 | 问答卡 | 自研的 `ask` 工具（`runtime/plugins/tools/ask.ts`） | 有：官方 `dsh-tool-ask-user` + `user-questions/request` 应答方（§3），但包不在钉住的树里 | **改用 DSH 做法**（[决策 098](../decisions/098-ask-user-via-official-tool.md)）：装官方包，bridge 只做应答方 | 不自研工具；问答卡沿用 | 约 1.5 人日，另需一次联网装包 | 迁移会话里 1.0.x 的 `ask` 行照常显示 | 新增 `question` 场景；`permissionsClassification` 测试加一行 |
| 4d-10 | 斜杠命令列表与执行 | 模板、`skill:<name>`、窗口内置命令（`nativeWorkerRuntime.ts:694-718`） | 有：`ctx.commands.list/execute`；用户可调技能用 `/<name>` | **改用 DSH 做法**（决策 099 第 9 条）：列出 DSH 命令，再加上用户可调技能（写作 `<name>`）；隐藏 `/plan`、`/permission`（决策 047）和 `/feedback`；已知命令走 `execute`，不开模型回合；未知的 `/xxx` 照常当提示词发出 | 模板取消（决策 103）；`/skill:` 改写不做（决策 101）；未知命令不拒，免得以 `/` 开头的路径被挡住 | 约 0.75 人日 | 无 | `rpc` 金样本如记录命令列表会变；bridge 单测 |
| 4d-11 | `/compact` | 带可选 `instructions` 的压缩 | 有：`/compact`，不接受参数（`dsh-command-compact/README.md:36`） | **改用 DSH 做法**（决策 099 第 10 条）：`worker.compact` 执行 `/compact`；`instructions` 非空就拒绝 | 不自研带参数的压缩 | 约 0.5 人日 | 无 | `compact` 场景改为经 `worker.compact` 触发（现在走探针操作，`bridge-record.ts:473-476`） |
| 4d-12 | 通知：后台任务结束、目标收尾等 | pi 扩展的 custom 消息 | 有：非 user 来源、`form:'notice'` 的 user 消息 | **保留**（决策 099 第 7 条）：发 `custom.message`，样式按 P1-7 的来源表；来源为 `aiclient-loop-guard` 的收尾指令，直播和历史都隐藏 | 这是 081 的交接；现在投影会把它显示成系统注记（`projection.ts:525-536`） | 约 0.5 人日 | 无 | 新增 `job-notice` 场景；`projection.test.ts` 加一例 |
| 4d-13 | 目标、待办等状态：`session.projection` | 无 | 有：`ctx.sessionProjections` | **保留**（决策 099 第 11 条），但只转发渲染层会用到的 `todos`、`goal`、`subagentCatalog`；bridge 合成的 `goalActivation`、`jobs` 归 P1-7b | `permissions`、`sandboxMode`、`plan` 在我方组合里不是常量就是关着的（决策 044、047、088） | 约 0.5 人日 | 无 | 每个场景的 `stream` 金样本都会多一个 bootstrap 后的快照 |
| 4d-14 | 自主回合的轮次头（`origin`） | 无（1.0.x 没有目标轮） | 目标轮、后台任务或子代理完成唤醒的回合，首条消息是非 user 来源 | **保留**（决策 099 第 8 条；决策 072 第 3 条） | 渲染层按 user 消息切回合，没有轮次头就会并进上一回合 | 约 0.75 人日 | 无 | `job-notice` 场景；P1-7 的 todo-goal 场景 |
| 4d-15 | 每轮 model / effort；`message.started.model`；失败码 | native 每轮解析 | `installModelSelection` | **已完成**，从 P1-4d 删掉（决策 099 第 16 条；`fcaeb8bc`，决策 085 第 6 条） | — | 0 | — | — |
| 4d-16 | 能力清单 `capabilities` | MCP 服务器、技能数、模板数、子代理数（`LeftDock.tsx:491-540`） | 技能目录（`ctx.skills`） | **简化**：只报技能数（决策 099 第 12 条） | MCP 暂不做（决策 090），模板取消（决策 103），自定义子代理不加载（决策 062 / 070 的裁决） | 约 0.25 人日 | 无 | `sessionCapabilityModel.test.ts`（与决策 104 一起改） |
| 4d-17 | P1-1 点验遗留 | — | — | **保留**（决策 099 第 13 条）：查清「发送被拒后，同一个活着的 slot 上重复 resume、发空历史页」会不会盖掉已有时间线（`evidence/p1-1-gui-2026-09-26.md` 其他观察） | D4、D6 已随 P1-4a / 4b 消失；D5 随决策 095 消失 | 约 0.5 人日 | 无 | 视查的结果而定 |
| 4d-18 | `reload`、`preview.requested`、权限 setter、`permission.activity`、`subagent.activity` | — | — | **不在 P1-4**（决策 099 第 17、18 条）：`reload` 在 pi TUI 去掉后没有调用方，P1-11 / P1-12 连 RPC 一起删；`present` 不做（决策 073）；权限归 P1-6c；子代理活动归 P1-7b | — | 0 | — | — |

### 4.3 P1-4e 录制门禁

总的取舍见[决策 100](../decisions/100-p1-4e-gate-kept-scenarios-follow-rescope.md)。

| 编号 | 这一项是什么 | 1.0.x 怎么做 | DSH 自带做法 | 建议 | 理由 | 工作量 | 迁移 / 升级影响 | 受影响的测试与金样本 |
|---|---|---|---|---|---|---|---|---|
| 4e-1 | 录制场景 | native 的 `guiEventContract` 录制（`src/runtime/__tests__/guiEventContract.test.ts`） | 无（DSH 自己的测试不覆盖我方 bridge 的映射） | **保留**（决策 100 第 1、2 条），场景随重划：已有 9 个；新增 steer（决策 093 不通过时改为 interject）、fail-retry、image、file-attach、think、usage、job-notice、question（决策 098 落地后）；todo-goal、子代理等界面场景归 P1-7 | DSH 还是 developer preview，钉版本升级时，金样本的 diff 是发现事件词表变化的第一道警报 | 约 1.5 人日，含假网关新方案 | 迁移场景归 P1-9 | 新增约 8 组金样本；已有 `stream` 金样本在收口时全部重录一次（4d-1、4d-13 会改动全部） |
| 4e-2 | 渲染层回放测试 | `nativeStreamReplay.test.ts` 把录下的流灌进真实 reducer | — | **保留**（决策 100 第 3 条）：新建 `src/renderer/stores/__tests__/dshStreamReplay.test.ts` | 断言用户最终看到的内容，防止「事件发了但界面没画」 | 约 1.5 人日 | 无 | 新增 |
| 4e-3 | 投影金样本测试 | — | — | **已有**（`src/shared/dshHistory/__tests__/dshHistoryGolden.test.ts`），新场景自动覆盖（决策 100 第 4 条） | — | 0 | 无 | — |
| 4e-4 | CI 接入 | 原生金样本随全量 vitest 跑 | — | **保留**（决策 100 第 5 条）：`build.yml` 的 gate 加 `src/dsh-host` 的 `npm ci`、取随包 node、`bridge-record.ts --check`；另建分支触发的 `dsh-bridge-gate.yml` | 退出判据要求进 CI | 约 0.5 人日；推送前要用户确认 | 无 | — |
| 4e-5 | GUI 点验清单 | — | — | **更新**（决策 100 第 6 条）：重开会话见历史、崩溃重启见中断注记、回退、fork、失败后「继续」、Ctrl+Enter（steer）、发图、文本附件、用量环、`/compact`、提问卡（如果 098 落地） | 跟着 4c / 4d 的新行为走 | 0.5 人日，放在 P1-14 的点验里 | 无 | 证据落 `evidence/` |

### 4.4 P1-16 剩余部分

P1-16b（MCP）与 P1-16d（自定义子代理）已由决策 090 取消，不列；只列 090 要求的「迁移时提示」。

| 编号 | 这一项是什么 | 1.0.x 怎么做 | DSH 自带做法（位置） | 建议 | 理由 | 工作量 | 迁移 / 升级影响 | 受影响的测试与金样本 |
|---|---|---|---|---|---|---|---|---|
| 16-1 | 把 `<agentDir>` 下发给宿主 | worker 自己知道 `agentDir` | 无 | **保留**，与 P1-6c 的 `AICLIENT_PERMISSION_AGENT_DIR` 合成一处下发（决策 101 第 1 条） | 下面两行 overlay 都要它；路径只能有一个来源（P1-10 / P1-16 方案 §4.1） | 计入 16-2 | 无 | `hostStatic.test.ts` |
| 16-2 | 托管全局指令 `<agentDir>/AGENTS.md` | 作为 managed 全局文件进系统提示词（`runtime/bootstrap.ts:485-499`） | 有：`agent-instructions` 读 `<dshHome>/AGENTS.md`，以 user 消息注入 | **改用 DSH 做法**：overlay 把 `dshHome` 指向 `<agentDir>`（[决策 101](../decisions/101-instructions-and-skills-dsh-native.md)） | 一行配置就让用户写过的全局指令继续生效，属于「设置能迁移」；原地对接已由决策 057 批准 | 约 0.5 人日 | 文件不动，回装 1.0.x 照常生效 | bridge-smoke 新增 INS-1 |
| 16-3 | 用户层指令：`~/.pilab/AGENTS.md` → `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md`，取第一个 | worker 读，作为 user 层（`runtime/plugins/prompt/projectInstructions.ts:95-117`） | 无：DSH 的用户全局只有一个文件（`dsh-agent-instructions/lib/index.js:141`） | **删除**，不写原计划的 `aiclient-instructions` 插件；在旧资产提示里说明（[决策 102](../decisions/102-drop-user-layer-instruction-files.md)，**需用户拍板**） | 为与 1.0.x 一致的自研（约 120 行加测试） | 0（省下约 2 人日） | 文件不动 | 无 |
| 16-4 | 项目指令链 | 各级目录取第一个存在的指令文件，一直往上到家目录之下，共用 32 KiB | 有：以 `.git` 为根，`AGENTS.md`、`CLAUDE.md` 都读，64 KiB | **用 DSH 原生**，不做工作（决策 101 第 5 条；取舍已由决策 064 定，不另起决策） | 差异已由决策 064 第 1 条接受 | 0 | 无 | 无 |
| 16-5 | 技能目录 `<agentDir>/skills` | runtime 自己的加载器扫四类根（`runtime/plugins/skills/index.ts:203-237`） | 有：`skill-filesystem` 的 `customSkillDirs`，rank 300；`~/.agents/skills`、项目 `.dsh/skills` 与 `.agents/skills` 本来就是默认根 | **改用 DSH 做法**（决策 101） | 一行配置 | 约 0.5 人日 | 文件不动 | bridge-smoke 新增 SKL-1 |
| 16-6 | 技能兼容报告：设置页「检查兼容性」、`capabilities.skillIssues` | 无（这是原方案为迁移新加的） | 无；DSH 遇到不合规的技能只记警告 | **删除**，DSH 不加载的技能由旧资产提示一次性列出（决策 101、104） | 一次性名单足够让用户自己改；常驻报告页是额外界面 | 0（省下约 1.5 人日） | 无 | 无 |
| 16-7 | 技能调用写法 `/skill:<name>` | 行首 `/skill:<name> 参数` 展开（`runtime/plugins/skills/expand.ts:83-88`） | 有：消息任何位置的 `/<name>`（§3） | **改用 DSH 做法**：不做改写，斜杠菜单按 `<name>` 列出（决策 101） | 改写是纯兼容层 | 0（计入 4d-10） | 无 | 无 |
| 16-8 | 提示词模板 `<agentDir>/prompts`、`.pi/prompts` | 行首 `/name 参数` 整条替换成模板正文，支持 `$1`、`$@`（`runtime/plugins/skills/expand.ts:22-65`） | 无：DSH 没有模板；最接近的是用户可调技能 | **删除**，P1-16c 取消，在旧资产提示里建议改写成技能（[决策 103](../decisions/103-drop-prompt-templates.md)，**需用户拍板**） | 纯为与 1.0.x 一致的自研 | 0（省下约 2.5 人日） | 文件不动，回装 1.0.x 照常可用 | 无；`src/shared/skills/{templates,expand}.ts` 留作检测用 |
| 16-9 | 旧资产一次性提示（决策 090 要求：检测到自定义子代理定义时告诉用户） | 无 | 无 | **保留**，扩成一处提示，覆盖自定义子代理、模板、用户层指令、`mcp.json`、DSH 不加载的技能、关过的委派总开关（[决策 104](../decisions/104-legacy-asset-notice-and-extension-pages.md)） | 090 的硬要求；一处提示取代原方案分散在四个界面的说明 | 约 2 人日 | 只读、不改用户文件；看过后记一个设置键 | 新 Main 模块单测、渲染层挂载测试 |
| 16-10 | 委派总开关与停用名单 | 共享设置里的总开关与按定义的停用名单（`nativeSubagentSettings.ts:37-58`） | 无：dsh-base 始终挂载子代理工具（`dsh-base/cordis.patch.yml:348-387`） | **删除**，只在旧资产提示里说明（[决策 105](../decisions/105-drop-delegation-switch.md)） | 开关所在的「子代理」页要删；DSH 没有这个开关 | 0 | 设置键不删，回装 1.0.x 照旧 | 无 |
| 16-11 | 「扩展」设置页与能力弹窗 | 插件页、资源页、子代理管理页；能力弹窗列 MCP、技能、模板、子代理、pi 扩展说明（`LeftDock.tsx:438-540`） | — | **收窄**（决策 104）：删「子代理」页；「资源」页只留技能目录；能力弹窗只留技能数；「插件」页归 P1-10c，pi 扩展部分整块删除（决策 090） | 不收窄，界面会让用户编辑一些已经不生效的东西 | 约 1 人日（插件页不算） | 无 | `subagentPanelMount.test.ts`、`subagentManagementModel.test.ts`、`piResourcesSettingsStatic.test.ts`、`capabilityEntryStatic.test.ts`、`sessionCapabilityModel.test.ts`、`SettingsContent.test.ts`；`piPluginsPermissionNoticeStatic.test.ts` 随 P1-10c |
| 16-12 | MCP 的 `env` 提示、pi 扩展只读列表、子代理页「`permission` 按继承」说明 | — | — | **删除**（决策 104 第 3 条） | 对应的功能已取消（决策 090） | 0 | 无 | 无 |

## 5 用户看得见的行为变化

与 1.0.3 相比，按本文建议做完以后，用户会看到下面这些不同。标「需拍板」的在决策里请用户亲自确认。

| 变化 | 1.0.3 | DSH 版 | 用户会看到的不同 | 决策 |
|---|---|---|---|---|
| **Ctrl+Enter 插话** | 当前一轮（一次模型调用加它的工具）照常跑完，然后这一回合结束，标「已插话」；插入的消息在队首，作为新的一回合发出，出现一个新的用户气泡和新的回合；进行中的目标会暂停（决策 071） | 消息马上送进引擎，在下一个步边界并入**当前**回合；回合不结束，没有「已插话」；目标不暂停 | ① 按下后消息不再排在队列条里等回合结束，而是直接成为对话里的一条用户消息，模型从下一步起一边继续一边照顾这句话；② 模型原本打算做的事不会被「掐断」，它可能先把手上这一步做完再回应；③ 跑目标时补一句话，目标照常续跑，不用再点「继续」；④ 同一回合里会看到「助手 → 我的插话 → 助手」交替，时间线按用户消息分组；⑤ 迁移来的旧会话里，1.0.x 当时的插话仍显示「已插话」 | [093](../decisions/093-interject-via-dsh-steer.md)，**需拍板** |
| Stop 之后没送达的内容 | 插话留在渲染层队列里；Stop 不冻结队列，会话一空闲就自动发出，开一个新回合（`messageQueue.ts:136-143`） | 还没被引擎取走的插话和后台任务通知留在引擎收件箱里，不会自动开新回合，随下一回合一起交给模型 | Stop 后，之前补的那句话不会丢，但也不会马上自动发出，要等下一次发送时模型才一起看到；界面上这类消息标为「待送达」。用 Enter 排队的普通消息仍在 Stop 后自动发出，并把待送达的插话一起带上 | [094](../decisions/094-stop-keeps-inbox.md) |
| 失败后「继续」 | 从失败前的上下文重跑，不回显、不重复发原提示 | 同左；实现上模型多看到一条用户看不到的续跑提示（决策 028，用户已批准） | 基本无感。临时错误（限流、超时、服务端错误）由引擎自动重试，重试横幅照常显示 | [095](../decisions/095-retry-keeps-hidden-continuation.md) |
| 发图 | 原图发给模型；单张 5 MiB | 引擎先校验并归一化：去 EXIF 与元数据，总像素压到 2048² 以内，目标 4 MiB；单张 5 MiB 的上限不变 | 模型拿到的是缩小后的图，特别大的截图细节可能变少；图片格式或像素不合规时，发送被拒、草稿退回，提示里带引擎给的原因 | [096](../decisions/096-images-via-dsh-attachments.md) |
| 读图 | 模型用 `read` 读图片文件 | 模型改用 `read_image`；`read` 只读文本 | 时间线里读图片那一行是单独的工具行（文案归 P1-7c）；当前模型不支持图片时，读图会被拒并说明原因 | 096 |
| **文本附件** | 文件内容直接并进这条消息，模型一次看到全文 | 文件存进引擎的附件库，模型只看到一行「附件：名字、大小、路径」，需要时自己去读 | ① 模型通常会先调一次「读取」再作答，时间线里多一行读取（读附件不出审批卡）；② 大文件不再一次塞满上下文；③ 模型偶尔可能不读就作答；④ 气泡里只显示你写的正文，附件显示为 chip | [097](../decisions/097-text-attachments-as-dsh-file-blocks.md)，**需拍板** |
| 提问卡 | 模型调 `ask`，出问答卡 | 模型调官方的 `ask_user_question`，出同一张问答卡 | 基本无感；工具行名字不同。如果官方包在合入前装不上，这段时间模型改用普通文字提问，不出卡 | [098](../decisions/098-ask-user-via-official-tool.md) |
| 斜杠命令 | 菜单里有模板、`skill:<名字>`、窗口内置命令 | 菜单里是引擎命令（`/compact`、`/goal`）、技能（`/<名字>`）和窗口内置命令；不列 `/plan`、`/permission`、`/feedback` | `/skill:xxx` 不再生效，改写 `/xxx`，而且写在消息任何位置都会触发技能；`/compact` 不再接受附加说明 | [099](../decisions/099-p1-4d-scope-dsh-data-only.md)、[101](../decisions/101-instructions-and-skills-dsh-native.md) |
| 用量与费用 | 用量环、会话累计、有定价时显示费用 | 用量环、会话累计照常；费用不算 | 原来能看到费用的（自配了定价的模型），费用一栏不再出现 | 099 |
| 流式工具参数 | 写大文件时，行上很快就显示文件路径 | 参数没传完之前只显示「已写 N 行」这类大小 | 写文件的行上，路径晚一两秒才出现 | 099 |
| 工具计时 | 计时从真正执行开始 | P1-7b 落地之前，计时从发起调用开始，包含等审批的时间 | 等审批时计时也在走 | 099 |
| 全局指令与技能 | `<agentDir>/AGENTS.md`、`<agentDir>/skills` 生效 | 同左，由引擎原生读取；技能按引擎规则（小写短横线名、一层目录、必须有 `name`） | 不合规的技能不加载（决策 064 已接受），升级后的一次性提示里会列出 | 101 |
| **用户层指令文件** | `~/.pilab/AGENTS.md`、`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md` 里第一个存在的会生效 | 不再读 | 在 Claude Code、Codex 里写过全局规则、并靠本应用顺带读到的用户，这些规则不再生效，需要自己搬进 `<agentDir>/AGENTS.md`；提示里会指出 | [102](../decisions/102-drop-user-layer-instruction-files.md)，**需拍板** |
| **提示词模板** | 行首 `/名字 参数` 展开成模板正文 | 不再支持 | `/review 123` 这类命令不再展开，菜单里也没有；提示里会建议改写成技能，改写后用 `/review` 触发，参数不再按位置替换，而是由模型读正文理解 | [103](../decisions/103-drop-prompt-templates.md)，**需拍板** |
| 自定义子代理 | 可写、可管理、可委派 | 不加载，只用引擎自带的子代理（决策 090 已裁决） | 「扩展→子代理」页不见了；升级后提示列出不再加载的定义 | [104](../decisions/104-legacy-asset-notice-and-extension-pages.md) |
| 委派总开关 | 设置里能关掉委派 | 没有这个开关，引擎的子代理始终可用 | 关过委派的用户会看到模型开始使用子代理；提示里会说明 | [105](../decisions/105-drop-delegation-switch.md) |
| 能力弹窗与「扩展」页 | 弹窗列 MCP 服务器、技能、模板、子代理和 pi 扩展说明 | 只列技能数；「资源」页只留技能目录 | 界面变简单 | 104 |

## 6 重划结果

### 6.1 子任务清单

| 子任务 | 内容 | 决策 | 约（人日） | 依赖 |
|---|---|---|---|---|
| **P1-4c1 回合语义** | Stop 保留收件箱；失败后「继续」受理与续跑；Ctrl+Enter 改 steer（协议、Main、渲染层 composer 与队列、回显、待送达标记）；替换 P1-1 的重试安全桩；录制 `steer`、`fail-retry` | 093、094、095 | 5（093 不通过时约 3） | P1-6c 落地；093 拍板；开工前一个小实验（见 §8） |
| **P1-4c2 附件** | 图片走 `admitPromptContent`；文本附件存成文件块；admit 失败的拒绝码；回显附件元数据；P1-6 的附件库可信路径；替换 P1-1 的附件安全桩；录制 `image`、`file-attach` | 096、097 | 3 | c1（共用 `startSend`）；097 拍板 |
| **P1-4d1 直播映射** | 用量；思考起止；流式参数只报大小；直播工具行标志；改动审阅取 DSH 差异卡；重试横幅；失败文案与 `turn_limit`；通知与隐藏 loop-guard 收尾指令；自主回合轮次头；查清重复 resume；录制 `think`、`usage`、`job-notice` | 099 | 6 | c1 |
| **P1-4d2 命令与状态** | `commands()`（DSH 命令加技能，隐藏三条）；已知命令走 `execute`；`worker.compact`；`session.projection`（三个 key）；能力清单只报技能数 | 099、101 | 2 | d1 |
| **P1-4d3 提问** | 装官方 `dsh-tool-ask-user`（白名单 `official` 类、锁文件、分类表加 `internal`）；bridge 应答方；录制 `question` | 098 | 2，另加一次联网装包 | d2；联网授权（CI 或经用户同意）。装不上就推迟到合入之后 |
| **P1-4e 门禁收口** | 场景补齐后由编排者统一重录；渲染层回放测试；`build.yml` 与 `dsh-bridge-gate.yml`；更新 GUI 点验清单 | 100 | 3.5 | c、d 各自的场景；推送前用户确认 |
| **P1-16a 指令与技能（缩）** | `<agentDir>` 下发，与 P1-6c 合成一处；`agent-instructions`、`skill-filesystem` 两行 overlay；INS-1、SKL-1 | 101 | 1.5 | P1-6c 的路径下发；技能出现在命令列表里要等 d2 |
| **P1-16e 旧资产提示与扩展页**（新编号，取代 16c、16d） | Main 检测模块；一次性提示与「扩展」页里的常驻入口；删「子代理」页；「资源」页只留技能；能力弹窗只留技能数 | 102～105 | 3 | 102、103、105 的裁决；与 P1-10c（插件页）同一泳道串行 |

- **合计**：
  - P1-4 剩余约 21 人日，约 4 人周（093 不通过时约 19 人日）；
  - P1-16 剩余约 4.5 人日，约 0.9 人周。
- **取消**：P1-16b（MCP）、P1-16c（模板）、P1-16d（自定义子代理）；原计划的 `aiclient-instructions` 插件与技能兼容报告页。
- **移出**：`execStartedAt`、`goalActivation`、`jobs` 移到 P1-7b；每轮 model / effort 已由 P1-5 完成。

### 6.2 顺序

泳道 ① 只能串行，因为都要改 bridge：

1. P1-6c（在做）→ P1-6b 收尾；
2. P1-4c1 → P1-4c2 → P1-4d1 → P1-4d2；
3. P1-16a：overlay 那一半可以紧跟 P1-6c，命令列表那一半跟在 d2 之后；
4. P1-4d3：等联网授权，不挡其他项；
5. P1-4e：全部场景到齐后收口，全量测试只跑一次，金样本由编排者统一重录。

可以与泳道 ① 并行的：P1-16e（Main 与渲染层设置页，泳道 ⑥，与 P1-10c 串行）。

注意 P1-4c1 如果按 093 做，要改 `ChatComposer.tsx` 与消息队列。这与泳道 ⑤ 的 P1-7 会碰同一批文件，所以 P1-4c1 的渲染层部分要排在 P1-7a 开工之前，或者两边约定文件范围。现在 P1-7 还在做原型页，冲突不大。

### 6.3 退出判据（建议细化，由编排者改 roadmap）

- **P1-4**：录制门禁进 CI；按 4e-5 的清单在开发机做 GUI 点验。
- **P1-16**：
  - 全局指令与技能经 INS-1、SKL-1 验证；
  - 旧资产提示经 GUI 点验：能列出子代理定义、模板、用户层指令、`mcp.json`、不合规技能；
  - 「扩展」页不再出现已取消的功能。

## 7 其他任务的观察（只列观察，不起草决策）

**P1-5c～e**
- **P1-5c**：大部分已做，包括 `resolveRoute`、失败码表、每轮 model / effort（`fcaeb8bc`，决策 085）。剩下的是设置映射。按总原则可以再看两处为与 1.0.x 一致而定的规则：
  - 决策 040 第 2 条：没选档位时补发 medium。DSH 的做法是不发，代价是 GPT 类模型默认不思考。
  - 决策 040 第 3 条：把 1.0.x 的「重试 3 次、3～30 s」映射到 `retryPolicy`。DSH 默认是 5 次、0.5～10 s。
  - 这两处都需要用户点头才能改。
- **P1-5d**：协议收口，本来就是跟随 DSH（决策 036），不变。
- **P1-5e**：
  - Q003 已裁决去掉 pi TUI，所以「`auth.json` 的写入加开关」可以简化成：P1-11 落地后直接停写，不要开关。
  - 管理员 key 缓存加密与一致性无关，是安全项，保留。
- **子代理缓存 TTL**：`subagentPromptCacheTtl` 在 DSH 下失效（决策 040 第 4 条）。按 DSH 的做法可以直接从设置页拿掉，不必加说明。

**P1-7**
- 如果决策 093 通过：
  - 决策 071（插话暂停目标）与 P1-7 方案的 U5 失效，目标条不再需要「因插话暂停」这个状态；
  - 排队条里「插话」那一类条目的语义变了。
- 自定义子代理已取消（决策 062 / 070 的裁决），P1-7b 的泳道只对 DSH 的 `subagent`、`subagent_fork`，U4 不再需要。
- 决策 068 已改成「后台与子代理用浮动子窗口」。DSH 自己的形态是按子会话浏览；如果浮动窗口直接按 `subagentCatalog` 投影列子会话，P1-7b 里「按父工具调用 id 配对泳道」的规则（D6、实验 E2）有可能大幅收窄。这要在新原型里一起看。
- `execStartedAt`、`goalActivation`、`jobs` 从 P1-4d 移过来，与前台 job 对应共用 `tools/execute` 挂点（实验 E1）。
- 运行中命令的实时输出（D5）用的是 DSH 的 job 输出环，符合原则；工作量紧的话，可以推迟到合入之后。
- `present` 交付卡、DSH 的 plan 模式与计划审阅都是 DSH 的做法，P1 不做（决策 073、047）。合入后如果要继续向 DSH 看齐，这是下一批候选。
- 工具行词表要加 `ask_user_question`（决策 098）和 `read_image`。

**P1-9c～f**
- **P1-9c～e**：迁移旧会话是硬要求，范围不变。
  - P1-9c 的图片入库与 P1-4c2 共用同一个入口，先做 c2 可以省一次。
  - 插话若改 steer，转换器仍要写 `aborted{hook:'aiclient-interject'}`，投影规则保留。
- **P1-9d**：「TUI 交接」是为 pi TUI 与迁移并存设计的。P1-11 按 roadmap 排在 P1-9d 之前去掉 pi TUI，这部分就可以删掉。
- **P1-9e**：原计划在设置页加三条说明（子代理缓存 TTL、空闲超时 0、不支持的协议），可以并进决策 104 的一次性提示，或者随着对应设置一起拿掉。
- **P1-9f**：CC / Codex 导入改产 DSH，是 1.0.x 的应用功能，不属于「旧会话能迁移」。
  - 可以保留（约 200 / 350 行），也可以推迟到合入之后。
  - 推迟的话，P1-12 删 `PiImportProcess` 之前，要先在 DSH 构建里把导入入口藏起来。
  - 这需要用户或编排者定。
- **P1-9h**（旁支转 lineage）本来就是可选项，建议明确推迟到合入之后。

**P1-15**
- 一次性补全（提交信息、分支名、代码评审）是应用功能，不是引擎对等。P1-12 删 runtime 之前必须有替代，所以保留。
- 已经选了 DSH 原生接口 `ctx.llm.stream`（决策 039），不受影响。
- 注意：`ctx.llm.stream` 是单次尝试，`dsh-llm-retry` 只管 agent 回合（`dsh-llm-retry/README.md:12,132`）。补全失败时不要自研重试，失败就让用户再点一次。

**其他**
- **P1-6**：本文给 P1-6 带来两处小改动，都放在泳道 ① 顺手做：
  - 附件库 `<DSH_HOME>/attachments/v1/` 的读取算作可信路径（决策 097）；
  - 分类表加 `ask_user_question: 'internal'`（决策 098）。
- **P1-6 的 plan 模式**：我方 plan 档与 DSH 的 plan 模式并存（决策 047）。按总原则，合入后可以考虑直接用 DSH 的 plan 模式。
- **P1-10c**：pi 扩展只读列表按决策 090 整块删除，插件页变简单。`dsh-tool-ask-user` 会是白名单里第一个 `official` 类条目，走 P1-10a 的构建期审计，需要联网装包（实验 E2 的同类问题）。
- **P1-11**：去掉 pi TUI 后，`worker.reload`、`usePresentationSwitch` 成为死代码，P1-12 一起删。
- **P1-12** 要多删：
  - `piSubagents:*` IPC、Main 的 `subagentCatalog.ts`、`PiSubagentsSettings.tsx`；
  - 模板相关界面；
  - `runtime/events/streamingToolArgs.ts`：按 4d-3 简化后不用搬家，随 runtime 删。
  - `src/shared/mcp` 按决策 090 保留。
- **P1-13**：文本附件与图片的副本落在 `DSH_HOME` 下，属于新建文件，不加密。用户已接受「不加密是好事」（决策 090），检查单可以注明。

## 8 风险、实验与拿不准的点

**开工前的小实验**（每个一个脚本，先 `free -m`）：
1. **steer**，P1-4c1 用，决策 093：
   - 在工具等审批时、在最后一步刚结束时各 steer 一次，确认消息都在下一个步边界被取走，回合继续；
   - 在 `agent/turn-stopping` 的 await 期间 steer，确认不会丢；
   - Stop（keepInbox）之后再 followup，确认待送达的插话随新回合一起被取走。
2. **文件块**，P1-4c2 用，决策 097：沙箱关闭（决策 044）时，句柄里的路径能被 `read` 读到，过闸时判为可信路径，不出卡。
3. **官方包**，P1-4d3 用，决策 098：`npm install --package-lock-only` 能否解析出 `dsh-tool-ask-user@0.1.7-rc.2` 的 peer，与 P1-10 的 E2 同类。要联网。

**拿不准、需要编排者判断的**：
1. **决策 093 是否值得做**：
   - steer 比保留 029 多约 2 人日，而且要改渲染层的 composer 与队列，与 P1-7 碰文件；
   - 好处是 DSH 原生语义，目标不暂停；
   - 用户不同意的话退回 029，P1-4c1 约 3 人日，另需原计划的「同步 cancel」实验。
2. **决策 094**：Stop 后没送达的插话不会自动发出，要等下一次发送时才随新回合一起送给模型。
   - 这与 1.0.3 不同：1.0.3 的队列在 Stop 后空闲时会自动发出（`messageQueue.ts:136-143`）；
   - 也有人可能更希望「Stop 就是全部作废」；
   - 我按 DSH 停止按钮的语义定了。它与决策 093 连在一起，如果编排者觉得这属于用户看得见的较大变化，可以与 093 一起提请用户拍板。
3. **决策 095 是总原则下的例外**：我判断不必拍板，因为保留意味着用户无感。但它确实是「为与 1.0.x 一致而保留的自研」，编排者可以决定是否提请用户确认。
4. **决策 098 要联网装包**：
   - 交接文档没把「联网装 npm 包」列进必须先问用户的事，但 P1-10 方案把 E2 写成「要联网，在 CI 上或经授权做」；
   - 请编排者定由谁、在哪台机器装；
   - 装不上的话，合入时问答卡暂时缺席。
5. **决策 102 的影响面**：没读真实用户目录，不知道有多少用户靠 `~/.claude/CLAUDE.md` 给本应用传规则，所以列为需拍板。
6. **决策 105 与「设置能迁移」的口径**：我把「DSH 版里已经不存在的功能」对应的设置，按「给出提示」处理，不迁移。这个口径最好与 102、103 一起请用户确认。
7. **未知的 `/xxx`**：DSH 自己的界面会拒绝未知命令，我们按 1.0.x 的做法照常当提示词发出，这是本文唯一一处刻意不跟 DSH 的地方。理由是以 `/` 开头的路径很常见。如果编排者觉得应当完全跟 DSH，就改成拒绝，但会挡住 `/usr/…` 这类开头的消息。
8. **工作量**：P1-4 剩余没有因为原则明显变小。主要节省在 P1-16，此前取消的 MCP 与自定义子代理约 2.5 人周，本文再省约 0.5 人周。roadmap 的总估要不要据此重估，由编排者定。
9. **编号**：本文占用 093～105，共 13 份。092 按预留留给 P1-6c。如果另一个代理也往后占号，请编排者统一调整。
