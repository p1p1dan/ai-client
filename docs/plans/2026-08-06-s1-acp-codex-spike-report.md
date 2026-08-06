# S1 Spike 报告 —— ACP + Codex 可行性（定稿）

> **2026-08-06 落库。** plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。
> 四路并发探针（P1 ACP 通道实测 / P2 直连 Codex 实测 / P3 我方靶子协议测绘 / P4 codeg 参照取证）的合成，
> 经编排者逐条回验后定稿（复核记录见 §7，含 **5 处引用错误的更正**）。
> 每条结论标 **[实测] / [读码] / [推测]**；探针没跑通的一律不补成推测事实，全部沉到 §5「未闭合项」。
>
> **出口达成**：本报告 + 用户 2026-08-06 的判据答复共同结清 [open-q #1](../plantree/plans/multi-agent/open-questions.md)
> → **路线裁定：不接 ACP，直连 Codex（`codex app-server`）**。裁定推导见 §4，落库口径见 §8。
>
> **额度**：全程 9 个真实回合（P1 四个 / P2 五个），P3/P4 零回合。所有写操作在 sandbox 目录，本机文件系统零写入。

---

## 0. 一句话与最强单条证据

**直连 Codex 与接 ACP 拿到的是同一个二进制、同一批报文；ACP 只是把直连的 payload 原样塞进 `_meta.codex` 再转发一次，并在此过程中丢掉一部分权限表达力。** [实测]

交叉印证（P1 与 P2 互不知情、独立跑）：

| 面 | P1（ACP 侧抓到） | P2（直连侧抓到） | 判定 |
|---|---|---|---|
| 底层二进制 | codex-acp 默认起**内嵌** `@openai/codex` **0.145.0** | 本机 PATH `codex` **0.145.0** | 同版同物 [实测] |
| 进程链 | `codex-acp(node) → node .../codex.js app-server → vendor musl codex app-server` (ps -ef --forest pid 12396→12403→12410) | 我们直接 spawn 的就是 `codex app-server` | **ACP = 在直连之上多套两层进程** [实测] |
| 审批 payload 字段 | `_meta.codex.params` = threadId/turnId/itemId/startedAtMs/environmentId/reason/command/commandActions/proposedExecpolicyAmendment/availableDecisions | `item/commandExecution/requestApproval` 的 **params 本体** = 同一批字段 | **同一份数据，ACP 把它降级为无 schema 的 `_meta` 透传** [实测] |
| execpolicy 修正 | option `accept_execpolicy_amendment` 带 argv_prefix 规则 | `{acceptWithExecpolicyAmendment:{execpolicy_amendment:["/bin/bash","-lc","echo hi > probe_a.txt"]}}` | 同一机制 [实测] |

推论（P1 自述已明写）：**要做出 codeg 那种审批 UI，`_meta` 是必读的，ACP 标准字段不够。** [实测]
即 ACP 在审批这条最贵的路上**没有提供抽象**，只提供了一层转发 —— 而直连侧同一份数据是有 JSON Schema、有生成 TS 类型的一等契约（`schema/CommandExecutionRequestApprovalResponse.json` 等）。[实测]

---

## 1. 五项数据结论（对应 roadmap S1 五条）

### 1.1 通道可用性

**实测到了什么**

- **ACP 路当场跑通** [实测]：`@agentclientprotocol/codex-acp@1.1.9` 8.5s / 19 个包装完；手写 **~120 行**裸 JSON-RPC 客户端即可 `initialize → session/new → session/prompt` 全回合；**无需 `authenticate`**（凭据取自 `~/.codex/auth.json`）。冷启动到 initialize 响应 **178–188ms**，`session/new` **88–90ms**，最小回合（"只回复 PONG"）端到端 **4585ms**，`stopReason=end_turn`。
- **装机体积 362M** [实测]：`@openai` 目录 347M，其中 `vendor/x86_64-unknown-linux-musl/bin/codex` 单文件 **310,730,800 字节**，`codex-code-mode-host` 46MB。即 **341M 是一个本机 PATH 上已经存在的同版二进制的副本**。
- **Node 版本要求**：codex-acp 的 `package.json` **无 `engines` 字段**；内嵌 `@openai/codex` 声明 `node>=16`。bin 入口 `dist/index.js`，ESM + shebang，单文件 1,131,951 字节。[实测]
- **直连路同样跑通且入口更多** [实测]：codex 0.145.0 有三个可编程入口 —— `codex exec`（单向 JSONL，**结构上没有回传通道 → 接不住审批/提问**）、`codex app-server`（标 `[experimental]`，双向 JSON-RPC over stdio，**唯一能接住审批/提问的**）、`codex mcp-server`（只暴露 2 个工具 `codex` / `codex-reply`，是"把 Codex 当工具"而非当宿主）。app-server 另有 `daemon` / `proxy` 子命令与 `--listen unix://|ws://` 远程模式。
- **直连最小回合 4615ms**（PONG，11 类通知）；`codex exec --json` 最小回合 8379ms 但全程只有 4 个事件、0 个 delta、0 个 reasoning。[实测]
- **两条路的帧格式几乎一样** [实测]：都是按行分隔的 JSON-RPC 2.0 over stdio（不是 LSP Content-Length）。直连的服务端响应帧**省略 `jsonrpc` 字段**（这是唯一需要额外容错的差异）。→ **"写客户端"这一项两条路成本相等，约 120 行。**
- **配置/第三方代理兼容性两条路都零问题** [实测]：ACP 路 stderr 全空、零 warning；`session/new` 正确回读 `currentModelId="gpt-5.6-sol[medium]"`。直连路 initialize 回 `{userAgent, codexHome, platformFamily:"unix", platformOs:"linux"}`。

**没测到的是什么**

- codex-acp **1.1.10 未装未验**（1.1.9 一次装通，按任务约定不再试）。[未测]
- ACP 的 `fs/read_text_file` / `fs/write_text_file` / `terminal/*` 四类反向请求**一次都没触发**（探针已 advertise fs 能力）。P1 推断"codex 走自己进程内 exec，ACP 的 fs/terminal 反向通道在 codex 场景基本用不上"—— **这是 0 样本推断，未证实**。[推测·标记为未闭合]
- 直连的 `--listen unix://|ws://` 远程模式、`daemon`/`proxy` 子命令未实跑。[未测]
- Windows / macOS 未测（本轮全部 Linux，`platformFamily:"unix"`）。[未测]

---

### 1.2 输出形状（→ RuntimeEvent 的映射难度）

**我方靶子的硬标尺（P3 实测）**

- `RuntimeEventType` **27 型，全部在 Host 侧有发射点，没有可以"白拿"的空坑位** —— 第二个 agent 每一型要么填、要么显式降级。[实测]
- 共享协议类型里 **Claude 语义泄漏命中 54 处**，最密的是 agentID 家族(7) / runtimeIdentity(7) / cometix(6) / effort(5) / jsonl-history(5)。[实测]
- `eventNormalizer.ts` **1203 行**（初稿写 1204；编排者以 `wc -l` + `awk END{NR}` 双验为 **1203**，文件末尾有换行符，不是计数口径差异——故四桶 307+392+385+120=1204 中**有一桶多算 1 行**，具体哪桶未再追。code 925）**四桶实测**：agnostic **307**（code 257）/ claude-shape **392**（code 315）/ subagent-t34 **385**（code 300）/ infra **120**（code 53）。[实测]
- 由此推导第二个归一化器：**可原样复用 ≈307 行**（发射器 + 回合终结）、**必须重写 ≈240–330 行**、**可直接不做 ≈385 行**（T-34 子代理，置 `capabilities.subagentActivity=false` 即诚实降级）→ **净新增 300–420 行**。[推测，由实测行数推导]
- `usage.updated` 是唯一结构完全开放的事件（`Record<string, unknown>` 原样透传，下游只浅合并存 raw）→ **第二个 agent 零成本填充**。[读码]

**ACP 侧要映射什么（P1 实测）**

- 实际出现 **7 种 `session/update` 变体**：`agent_message_chunk`(37) / `session_info_update`(17) / `usage_update`(9) / `agent_thought_chunk`(6) / `available_commands_update`(5) / `tool_call`(2) / `tool_call_update`(2)。schema 声明 **13 种**，未出现的 6 种见 §5。[实测]
- 形状细节：`agent_message_chunk` 逐 token 且带 `_meta.codex.phase="commentary"`；`tool_call` 首帧即 `status=in_progress` 并带 `content[{type:"terminal",terminalId}]` + `rawInput{command,cwd}`；`tool_call_update` 带 `rawOutput{formatted_output,exit_code}`；`session_info_update` 用来推标题。[实测]
- **两个必踩的坑** [实测]：① agent→client 请求用**自己的 id 空间且从 id 0 开始**，客户端 pending 表若与自己发出的 id 混用会串；② 即便 `clientCapabilities.terminal=false`，agent **仍**在 `tool_call.content` 里给 `{type:"terminal",terminalId}`，客户端必须容忍查不了的引用。

**直连侧要映射什么（P2 实测）**

- 契约面：**126 个客户端方法 / 70 个服务端通知 / 11 个服务端→客户端回调请求**。但**必接子集远小于此** —— PONG 回合只用到 11 类通知，审批回合再加 reasoning / commandExecution / fileChange / `serverRequest/resolved` / `thread/status/changed` 等，**编排者从 5 份原始 jsonl 重新统计：全程出现 23 个不同 method，其中客户端→服务端 7 个（initialize / initialized / thread/start / turn/start / model/list / permissionProfile/list / collaborationMode/list），服务端→客户端 16 个**——即**必接面 = 16 类**，不是契约总面 70。[实测·经编排者复核统计]
- **【最重要的成本发现】协议契约可由 codex 二进制自生成，直连不需要逆向报文** [实测]：
  `codex app-server generate-json-schema --experimental --out DIR` → **47 个顶层 schema + v2/ 下 300 个类型文件**；`generate-ts --out DIR` → **99 个 ts-rs 生成的 .ts 绑定**（可直接 import）。
  → 直连的"写解析器"退化为"import 生成类型 + 写 switch"，且**契约漂移可做成 CI 快照 diff**。
- 能力矩阵全部为真（从自生成契约逐项判定）：流式增量文本 / reasoning（`summaryTextDelta` + `summaryPartAdded`，**已在真实回合亲眼见到**，delta 形如 `**Planning shell execution and patch application**`）/ 工具调用与结果 / `commandExecution/outputDelta` / 3 类 v2 审批 + 2 类 legacy 审批 / 提问 / MCP elicitation / token 用量 / resume / fork / compact / interrupt / steer / model/list / plan / diff。[实测]
- **token 用量对照（对 `usage.updated` 直接相关）** [实测]：
  - 直连 `thread/tokenUsage/updated` 给 **total + last 两份 × 6 字段**（totalTokens/inputTokens/cachedInputTokens/cacheWriteInputTokens/outputTokens/reasoningOutputTokens）+ `modelContextWindow`。
  - ACP `usage_update` 只给 **`{used, size}`**（上下文占用，不是费用）。
  → **`usage.updated` "零成本填充"的判断在直连下成立且内容丰富，在 ACP 下成立但内容贫（2 字段 vs 13 字段）。**

**codeg 的实证：接了 ACP 之后仍要写多少映射（P4）**

- ACP 事件→UI 模型的映射函数 `connection.rs:8026 emit_conversation_update`（初稿写 8024，编排者 grep 复核为 **8026**），到 8534，**约 508 行，match SessionUpdate 13 个分支**（12 变体 + other 兜底）。[实测]
  > 注：`event_stream.rs` 前 560 行全是 `json_value_size` / `content_block_size` 之类的体积估算函数，**不是映射代码本身**——不能当映射体量标尺。[实测]
- 单一 `ToolCall` 分支就有 **约 145 行（8098–8244）**，塞满逐 agent 特判，注释逐条标来源：codex `subAgentActivity` 伪装 tool_call 需过滤 / Grok 重复 `ask_user_question` 去重 / CodeBuddy deferred MCP 结果二次解包 / **codex-acp 裸 Diff 合成规范 edit input（#304）** / Grok use_tool 信封剥离 / Cursor 无身份 MCP 完成时嗅探 / CodeBuddy 子代理开关窗口追踪 —— **≥7 处，其中 codex 专属 3 处**。[读码]
- **结论：ACP 的"13 个分支"与我方"13 种 sessionUpdate"一一对应，而 codeg 用 510 行才装下它。** "接 ACP 就不用写解析器"是假命题。[实测]

**没测到的是什么**

- ACP 侧 6 种 `sessionUpdate` 零样本（见 §5）；直连侧 70 个通知里只观察到约 15–20 类，其余仅契约。[未测]
- P3 是**纯静态测绘**，没跑任何真实回合 → 事件在真实流量中的**出现频次与时序**未实测。四桶归类是"判断"不是"测量"（行数与区间边界有 anchor 校验）。[标记]

---

### 1.3 提问形状（→ open-q #2）

**实测到了什么**

- **直连侧有一等公民契约** [读码，schema 全文]：`item/tool/requestUserInput`（标 **EXPERIMENTAL**）。
  `params = {threadId, turnId, itemId, questions[], autoResolutionMs?}`，
  每个 `question = {id, header, question, options?:[{label,description}], isOther=false, isSecret=false}`；
  响应 `= {answers: { [questionId]: {answers: string[]} }}` —— **一次多问、每问多答**。
- **与我方 `question.requested` 的差距（P3 实测我方形状）**：`QuestionItem` / `QuestionOption` 在 `runtimeEvents.ts:254-282`；**`question.respond` 的 answers 以问题原文逐字为 key**（`:299-312`）。
  → **差异只有一处：key 用问题原文 vs 用 question id。** 其余（多问、多答、options 带 label+description）**结构同构**。
  → **薄适配确实薄**，主要工作是一张 questionId↔问题原文的映射表 + `isSecret` / `isOther` 两个我方没有的位。[推测，由两侧实测形状比对得出]
- **ACP 侧反而更厚**（P4 实证）：codeg 的 `classify_elicitation`（`question.rs:834` 起主体，`899` 起 `approval_from_form`（初稿写 890，编排者 grep 复核为 **899**））必须把 codex 的 **form elicitation** 先分两大类 —— **Approval**（MCP tool-call 审批走 persist 三态 once/session/always + Decline，或无可渲染字段的纯确认走 Accept/Decline）与 **Questions**（按 `ElicitationFieldKind` 定型为 Text/MultiSelect/Boolean/Number/Integer，`oneOf`/`enum` 转选项，`__other`/`_meta` 标记的自由文本伴随字段被跳过，`question.rs:669-680`）。[实测]
  → **ACP 把 codex 的类型化提问压成通用表单，客户端必须再解一次型；直连拿到的就是类型化的原件。**
- codeg 还要收敛**三条不同 wire 语义**的裁决请求（原生 `session/request_permission`、codex `elicitation/create` 的 Approval 分支、Grok 自定义 `_x.ai/exit_plan_mode`）到应用层同一张权限卡（`connection.rs:4515-4576` + `4325-4513`，其中 Approval 分支 `4362-4411` **人工合成 tool_call JSON**），Grok plan-approval 还得走独立三态卡（`plan_approval.rs`，reply 字段是 `outcome` 不是 `decision`，42-43 行记录曾猜错过一次）。[实测]

**没测到的是什么 —— 这是本轮最大的单点缺口**

- **两条路都没有在真实回合中诱发出一次提问。** 直连的 `item/tool/requestUserInput` 只有契约无样本；ACP 侧 `elicitation/*` 一次都没触发（SDK methods 导出里有，探针未命中）。
- → **open-q #2「Codex 侧提问是什么形状」仍未闭合。**「薄适配到底多薄」目前是**由 schema 比对推出的判断，不是实测**。[标记]

---

### 1.4 模型目录

**实测到了什么 —— 三套目录、三个数字、口径互不相同** [实测]

| 来源 | 条数 | 字段风格 | 内容 |
|---|---|---|---|
| `codex debug models` | **8** slugs | snake_case | gpt-5.6-sol / -terra / -luna / gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.2 / codex-auto-review；每条带 display_name / description / default_reasoning_level / **supported_reasoning_levels(low,medium,high,xhigh,max,ultra 六档)** / service_tiers / **完整 base_instructions**（文件 296,131 字节） |
| app-server `model/list` | **5** | camelCase + `nextCursor` 游标 | 滤掉 gpt-5.4 / gpt-5.4-mini / codex-auto-review；`{id, model, displayName, description, hidden, supportedReasoningEfforts, defaultReasoningEffort, inputModalities, supportsPersonality, serviceTiers, isDefault}` |
| ACP `session/new` 回包 | **25** 档位 | `模型[effort]` 合成单 id | `currentModelId="gpt-5.6-sol[medium]"`；25 ≈ 5 模型 × 5 档 |

- **两处目录都是本地静态内置表，不向第三方代理 `base_url` 查询** [实测]（两条命令瞬时返回、无网络查询痕迹）。
- **预期偏差没有发生** [实测]：`gpt-5.6-sol` 就在内置目录**第 1 条**（priority=1, supported_in_api=true），不是"不在目录里"。
- **ACP 侧模式/模型切换 UI 是协议自带的** [实测]：`session/new` 直接回 `modes` + `configOptions`（mode / collaboration_mode / model），`configOptions[1]` 为 `collaboration_mode(default/plan)`。
- **但 codeg 即使在 ACP 上仍自建了目录抓取** [实测]：`codex_catalog_source.rs` 198 行，用 node `require.resolve` 从 acp_dir 解析**内嵌** `@openai/codex`（不是 PATH 上的），缓存 `codeg_home_dir()/cache/codex/bundled-catalog.json` **TTL 24h**，三级回落 live→磁盘 cache→`include_str!` 编译进二进制的 bundled snapshot。
  → **ACP 的 `session/new` 那 25 条不够撑目录 UI，否则 codeg 不会写这 198 行 + 三级回落。**
- 相关目录接口（直连）[实测]：`permissionProfile/list` → `[:read-only, :workspace, :danger-full-access]`（allowed 全 true）；`collaborationMode/list` → `[{Plan, mode:"plan", reasoning_effort:"medium"}, {Default, mode:"default"}]`；`codex features list` 另列 40+ 特性开关及 stage。

**没测到的是什么**

- **两条路都答不出第三方代理真实支持哪些模型** —— 目录是本地静态表。这是**直连与 ACP 共同要自建的一块**，不构成路线差异。[实测，P2 自述]
- 未验证 8 / 5 / 25 三个数字之间的确切生成关系（25=5×5 是算术吻合，未从代码证实）。[推测·未闭合]

---

### 1.5 权限语义

**Codex 侧的真实维度（直连，P2 实测）——四维正交，不是一个枚举**

1. **`approval_policy`**：字符串三值 `untrusted | on-request | never`，**外加对象型 `granular`**：`{granular:{mcp_elicitations, rules, sandbox_approval, request_permissions=false, skill_approval=false}}`。
   语义（官方 help 原文）：untrusted = 只有"可信"命令(ls/cat/sed)免批、其余升级给用户**且禁止提权**；on-request = 模型自己决定何时问；never = 从不问，执行失败直接回给模型。
2. **`sandbox_mode`**：`read-only | workspace-write | danger-full-access`；`thread/start` 回显展开成结构体 `{type:"readOnly", networkAccess:false}` —— **网络是沙箱的独立子维度**。
3. **`permissions` 命名档**：`:read-only` / `:workspace` / `:danger-full-access`，schema 明确 **"Cannot be combined with `sandbox`"**。
4. **`approvalsReviewer`**：`user | auto_review | guardian_subagent(legacy)` —— 决定审批请求**路由给谁**；`auto_review` 用子 agent 自动裁决。

**审批的两套方言必须都写** [实测]

- v2 CommandExecution：`accept | acceptForSession | {acceptWithExecpolicyAmendment} | {applyNetworkPolicyAmendment} | decline | cancel`（decline = 拒绝但回合继续，cancel = 拒绝并立即中断）。
- v2 FileChange：`accept | acceptForSession | decline | cancel`。
- v2 Permissions：响应完全不同 —— `{permissions: GrantedPermissionProfile, scope: PermissionGrantScope(默认 "turn"), strictAutoReview?}`。
- legacy `execCommandApproval` / `applyPatchApproval`：`ReviewDecision = "approved" | {approved_execpolicy_amendment} | "approved_for_session" | {network_policy_amendment} | {denied:{rejection}} | "timed_out" | "abort"`。
- **`availableDecisions` 是渲染提示而非强校验** [实测]：探针回了不在列表里的 `decline`，服务端照单全收、无 error 帧、回合正常继续。

**ACP 侧是一个有损投影** [实测]

- codex-acp **用自己的 `AgentMode` 三档完全覆盖 `~/.codex` 的 approval/sandbox 配置**：`read-only`(on-request + readOnly) / `agent`(默认，on-request + workspaceWrite, networkAccess:false) / `agent-full-access`(never + dangerFullAccess)。
  证据：`~/.codex/config.toml` 写的是 `sandbox_mode="danger-full-access"`，而 `session/new` 回 `currentModeId="agent"` —— 两者不一致即证明被覆盖。
- 杠杆只有 `INITIAL_AGENT_MODE` 环境变量 或 `session/set_config_option`，**没有命令行参数**。codex-acp 全部旋钮只有 5 个 env：`CODEX_PATH` / `CODEX_CONFIG`(JSON) / `MODEL_PROVIDER` / `DEFAULT_AUTH_REQUEST` / `INITIAL_AGENT_MODE`。[读码]
- **精确的有损点**：ACP 的 exec 审批给 **4 个 option**（allow_once / allow_always / accept_execpolicy_amendment / reject_once，各带 `_meta.codex.decision` = accept / acceptForSession / acceptWithExecpolicyAmendment / decline），对照直连的 **6 变体** —— **丢了 `applyNetworkPolicyAmendment`**（cancel 由独立的 `outcome:{outcome:"cancelled"}` 表达）。[实测，P1×P2 比对]
- ACP 回复形状：`{outcome:{outcome:"selected", optionId}}` 或 `{outcome:{outcome:"cancelled"}}`。[实测]

**审批的 UI 状态信号是现成的（直连）** [实测]

- 请求前发 `thread/status/changed {status:{type:"active", activeFlags:["waitingOnApproval"]}}` → 客户端答复后发 `serverRequest/resolved {threadId, requestId}` → `activeFlags` 清空 → `item/completed` 把该 item 的 status 改成 `"declined"`。全链路 3 帧，时序在 `phase4b` 里连续（11235ms → 11236ms → 11237ms）。

**一条必须写进设计的状态机成本** [实测]

- **补丁审批的 diff 不在审批请求里**：`item/fileChange/requestApproval` 很"瘦"，只有 `{threadId, turnId, itemId, startedAtMs, reason:null, grantRoot:null}`；**diff 在同一 `itemId` 的 `item/started` 里先到**（`{type:"fileChange", changes:[{path, kind:{type:"add"}, diff:"hi\n"}], status:"inProgress"}`）。**客户端必须按 itemId 关联才能渲染补丁。**
- ACP 侧同类坑（P4 实证）：codex Plan-mode 审查门的 tool_call **从未被正式 announce 过**，codeg 必须在 `request_permission` 到达时**手动 seed 一张卡**（status:pending, kind:switch_mode），否则后续 status-only 的 `tool_call_update` 无处合并（`connection.rs:4526-4554`，`registry.rs:419-427` 记 codex-acp 1.1.8 #351）。

**我方现状（P3 实测）**

- `permissionMode` 目前**只读展示**（T-14 接入，只进 context surface）；取值是 Claude 口径 `acceptEdits / dontAsk / bypassPermissions`（`runtimeEvents.ts:325-327`，属 54 处泄漏之一）。
- Host 命令面 10 条，`permission.respond` 已在其中；协议演进惯例是"只加可选字段、不升版本"，`AGENT_HOST_PROTOCOL_VERSION` 至今为 1，不匹配直接回 `protocol_mismatch` → **加 agent 维度可沿用同一惯例，不必升版**。[读码]

**没测到的是什么**

- `item/permissions/requestApproval`（第三类 v2 审批）**未诱发**，只有契约。[未测]
- `approvalsReviewer=auto_review` 的实际行为未测。[未测]
- `granular` 对象型 approval_policy 未实跑。[未测]
- ACP 的 `session/set_config_option` 切模式未实跑（`current_mode_update` / `config_option_update` 两种 sessionUpdate 因此零样本）。[未测]
- **诱发审批踩过 3 次空**（见 §5），说明"审批是否触发"受 codex 侧 config 语义影响，**接入方无法只靠协议控制** —— 这条对两条路同等成立。[实测]

---

## 2. 两条路成本对照表

> 口径声明：**行数为硬数据**（来自 P3 实测的 `eventNormalizer.ts` 四桶 + P4 实测的 codeg 文件体量）；**工时为推测**，换算假设为「本仓节奏 ≈ 150–250 行/人日（含测试与门禁）」—— 这个换算率是我引入的假设，非实测，请按需替换。
> **两路共有、不构成差异的下游改造**（store 加 agent 字段 / 索引迁移 / UI 切换器，落点 4 处见 §3 第 2 行）**≈ 1.5–3 人日**，先从对照里剔除。

| 维度 | 接 ACP | 直连 Codex | 差值方向 |
|---|---|---|---|
| **JSON-RPC 客户端** | **~120 行**（P1 实测手写；帧缓冲 + id 表 + 反向请求分发）[实测] | **~120 行**（同为按行分隔 JSON-RPC 2.0；唯一额外容错 = 响应帧省略 `jsonrpc` 字段）[实测] | **持平（0 行）** |
| **归一化器净新增** | **300–420 行**（P3 标尺：复用 307 / 重写 240–330 / 弃 385）[推测·由实测行数推导]；要装的分支面 = **13 种 sessionUpdate**，与 codeg `emit_conversation_update` 的 13 分支一一对应（codeg 用 **510 行**装下）[实测] | **300–420 行**（同一标尺）；必接面 = **实测出现的 16 类服务端→客户端消息**（契约总面 70，不必全接；编排者复核统计）[实测] | **持平（0 行）**，但直连有 **99 个生成 TS 绑定 + 47 schema + 300 v2 类型**可 import，"逆向报文"成本 = **0**；ACP 侧审批关键字段落在**无 schema 的 `_meta.codex`** [实测] |
| **工具行/内容块适配** | 额外要处理：`tool_call` 首帧即 in_progress、`content[{type:terminal}]` 即便 `terminal:false` 也照给、**codex-acp 裸 Diff 需合成规范 edit input**（codeg #304，`connection.rs` ToolCall 分支 **145 行 / ≥7 处逐 agent 特判，codex 专属 3 处**）[实测] | `item/commandExecution` 与 `item/fileChange` 是**独立 item type**，不必从 tool_call 逆推；但 **fileChange 的 diff 与审批分帧、必须按 itemId 关联**（新增状态机）[实测] | **直连略省，约 -30~-80 行** [推测] |
| **提问适配厚度** | codeg 需 `classify_elicitation` 把 form elicitation 分 Approval/Questions 两大类 + 5 种 `ElicitationFieldKind` + `__other`/`_meta` 跳过规则（`question.rs:669-680 / 746-749 / 834 起 / 899 起`，**≈ 115–280 行**）[实测] | 契约直给 `{questions[]:{id,header,question,options?,isOther,isSecret}}` / `{answers:{qid:{answers[]}}}`，与我方 `QuestionItem` **结构同构**；差异只有 answers key（问题原文 vs id）+ `isSecret`/`isOther` 两个位 → **≈ 40–80 行** [推测·由 schema 与我方形状比对] | **直连省 ≈ 75–200 行**；**但两路都未实测到真实提问，此行是全表可信度最低的一行** |
| **权限适配厚度** | 4 option → 我方 permission 卡；**丢 `applyNetworkPolicyAmendment`**；`_meta.codex` 必读；plan 门要手动 seed 卡（codeg `connection.rs:4325-4576` ≈ **250 行** 撑三条 wire 语义）[实测] | **两套方言都要写**：v2 三类（CommandExecution 6 变体 / FileChange 4 变体 / Permissions 形状完全不同）+ legacy 2 类（ReviewDecision 7 变体）→ **≈ 120–220 行**，但**全部有生成类型** [实测] | **大致持平（±50 行）**，但**表达力直连完胜**：4 维正交 vs 3 档固定 |
| **首次接入合计（行）** | **≈ 670–1090 行** | **≈ 540–740 行** | **直连少 ≈ 130–350 行** |
| **首次接入合计（工时）** | **≈ 3.0–7.0 人日** [推测] | **≈ 2.5–5.0 人日** [推测] | **直连少 ≈ 0.5–2.0 人日**；**该差值小于两路共有的下游改造 1.5–3 人日** |
| **运行时依赖与体积** | `node_modules` **362M**，其中 `@openai` **347M**、单文件 codex **310,730,800 字节** + `codex-code-mode-host` 46MB；**内嵌 codex 0.145.0 与 PATH 上完全同版 → 341M 是纯副本**；装机 8.5s / 19 包；无 `engines` 字段（内嵌包要 node>=16）[实测] | **0 新增依赖**（用 PATH 上已有的 codex 0.145.0）；生成的 schema/ts 产物只在开发期用 [实测] | **直连省 362M + 一层 node 进程 + 一级进程链**（ACP 是 3 级进程：codex-acp(node) → codex.js(node) → musl codex）[实测] |
| **上游版本风险** | 全仓 `acp/*.rs` **workaround/regression/silently/breaks 关键词命中 83 处**；`registry.rs` 逐 agent pin 版本 + 长注释。codex 专属已知坑：**1.1.5 扩大 MCP config 过滤 → 必须强制 `DISABLE_MCP_CONFIG_FILTERING`**；**1.1.6 加了 `_session/steering` 但 1.1.9 仍不支持 promptRequired opt-in → codeg 全线走 MCP pull 而非原生 push**；1.1.8 #351 plan 卡；#304 裸 Diff [实测] | app-server 明确标 `[experimental]`；v1/v2 双协议（v1 只剩 2 文件，v2 有 300）+ legacy/v2 双审批方言并存；`capabilities.experimentalApi` 决定可见方法与字段。**但 `generate-json-schema` 让"跟版本"可自动化 —— 可做成 CI 契约快照 diff** [实测/读码] | **风险性质不同**：ACP = 第三方适配器的语义漂移（不可自动检测，靠读 changelog + pin）；直连 = 上游二进制的契约漂移（**可机器检测**）。**直连的风险更小且可测量** |
| **第 3 个 agent 的边际成本** | **不是"注册一行命令"**。codeg 实证：registry 条目 + 逐 agent 版本 pin + 特判。已知单点：Hermes 被迫锁 Python 3.13（pywinpty 无 3.14 wheel + PyO3 ceiling）；Grok 需 `--registry=https://registry.npmjs.org --include=optional`（npmmirror 滞后到 0.1.4）且根级 flag 必须放在 `agent stdio` 子命令**之前**；Cursor 故意不跑官方安装脚本（会 symlink `~/.local/bin/agent` 与 Grok 同名 CLI 互相覆盖）。**映射侧边际 ≈ 20–60 行特判**；**安装侧边际 = 0（npm 分发）到 900 行级（独立二进制，codeg 为此写了 `binary_cache.rs` 902 行迷你包管理器，含 rename-aside + TRASH_COUNTER 防 Windows 时钟精度碰撞）** [实测] | **每个新 agent = 一套新驱动 ≈ 420–540 行**（120 客户端 + 300–420 归一化器），**且前提是该 agent 有可编程的双向通道** —— 反例就在手边：`codex exec` 结构上没有回传通道，`codex mcp-server` 只暴露 2 个工具 [实测] | **ACP 每 agent 省 ≈ 360–520 行**（映射侧），**但安装/preflight 侧可能倒贴** |
| **子进程管理（隐性）** | codeg 5 个纯子进程管理模块合计 **5106 行**：`preflight.rs` 766（≥9 类环境体检）/ `binary_cache.rs` 902 / `idle_sweep.rs` 98（180s 空闲 + 60s 扫描，防子进程与句柄泄漏）/ `stderr_tail.rs` 1013（ACP wire 在 EndTurn+空输出时不带任何错误信息，唯一线索是 stderr；曾因调高日志级别产出 **217GB** 日志文件）/ `background_watch.rs` 2327（**ACP wire 对 cron/loop 自主轮次完全不产生事件**，claude-agent-acp #270，只能尾随 JSONL transcript + prompt 指纹账本）[实测] | 同类需求我们**已有**（`src/agent-host` 就是自己的子进程宿主；stderr 进 UI 已由 T-35 落地） | **两路都要，但 ACP 多一层进程要管**；`background_watch` 那 2327 行是**协议表达力缺口**而非实现疏漏，属 ACP 特有 |

**表外三条不可摊销的项**（不随 agent 数量变化，选了就一直付）：

1. **权限表达力有损**：ACP 3 档 AgentMode 覆盖 `~/.codex`，丢 `applyNetworkPolicyAmendment`、丢 granular、丢 approvalsReviewer 路由。[实测]
2. **341M 重复二进制** + 3 级进程链。[实测]
3. **审批关键数据无 schema**：`_meta.codex` 是私有透传，上游改字段无法被类型系统或 CI 捕获。[实测]

---

## 3. 校正 reuse-boundary 初判表

> 目标文件：`docs/plantree/plans/multi-agent/topics/reuse-boundary.md` §「其余各层的初判（待 spike 校正）」六行表。

| # | 层 | 初判 | **实测后判定** | 依据 |
|---|---|---|---|---|
| 1 | 侧栏「文件夹 → 会话」两级结构 | 已具备，缺的只是 CLI 维度 | **未校正 —— 四路探针均未覆盖 `sidebarTree.ts`，维持初判但不得标记为"已验证"** | P1–P4 无一条触及 sidebar/chip 渲染。**唯一新增依据**：P3 实测 agent 归属字段有明确落点（见下行），chip 数据源可得 [实测] |
| 2 | 会话 ↔ agent 绑定 | 缺，需红线 store 加字段 + 持久化口径 | **确认，且落点从 1 处放大到 4 处；另发现无迁移机制** | P3 实测：① `ChatSession` 无任何 agent 字段（`chatSessions.ts:70-86`，加在 `retry?` 之后为同构可选加法）；② `createSession` 只传 `{sessionId, workspacePath}`（`:912-932`，连 model 都不传，model 走 send 的 per-turn override）；③ `SessionIndexEntry` / `session-index.json` 是**裸数组，无 `schemaVersion`、无字段校验、无 migration**，`ensureLoaded` 仅 `JSON.parse` + 灌 Map、失败即 warn 空表启动（`SessionIndexService.ts:172-188`）→ **"undefined 视作 claude"必须在读侧显式实现**；④ 索引只对 6 个 Host 事件写回，`session.created` payload 今天只有 `runtimeIdentity + permissionMode`（`runtimeEvents.ts:330-334`）→ agent 归属要回流得扩 payload。协议惯例支持不升版（`AGENT_HOST_PROTOCOL_VERSION=1` + 三处明写的加法惯例）[实测/读码] |
| 3 | 模型 / 推理档 | 单轨，现为 Claude 口径 | **校正：不是"单轨→多轨"，是"三套粒度不同的目录 + 一个两条路都不解决的空洞"** | 实测三套目录：`codex debug models` **8 条**（含 **6 档 reasoning：low/medium/high/xhigh/max/ultra**）/ `model/list` **5 条**（camelCase + 游标）/ ACP `session/new` **25 档位**（`模型[effort]` 合成单 id，如 `gpt-5.6-sol[medium]`）。我方 `SessionEffortLevel`（`agentHost.ts:48`）是 Claude 口径 → **档位不同构**。**ACP 把 model+effort 合成一个 id，直连是两个独立字段** → 「统一抽象 + 各自枚举」在直连下更自然。**预期偏差未发生**：`gpt-5.6-sol` 就在内置目录第 1 条。**新增空洞**：两条路的目录都是**本地静态内置表，不查第三方代理** → 代理真实支持什么，两条路都答不出，是必须自建的一块。**codeg 即使在 ACP 上仍写了 198 行抓取 + 24h 缓存 + 三级回落** → 目录不是白拿的 [实测] |
| 4 | 权限模式 | 只读展示，无管理面 | **校正：现状描述成立，但优先级从"以后再说"升级为"接 Codex 当天必须定投影口径"** | Codex 侧是 **4 维正交**（approval_policy 3值 + granular 对象 / sandbox 3值 + networkAccess 子维 / permissions 命名档 3 个且与 sandbox 互斥 / approvalsReviewer 3 值），**不是一个枚举能装下**。ACP 把它压成 **3 档 AgentMode 且完全覆盖 `~/.codex`**（`config.toml` 写 danger-full-access 而 `session/new` 回 `agent` 即证）→ **接 ACP = 接受一个有损投影，丢 `applyNetworkPolicyAmendment` / granular / approvalsReviewer**。我方 `permissionMode` 取值 `acceptEdits/dontAsk/bypassPermissions` 是 Claude 语义泄漏（54 处之一）[实测] |
| 5 | 工具行渲染 | 大概率通用 | **部分推翻：协议层通用成立，渲染层不通用；且"补映射非重写"的落点在 renderer 不在协议** | P3 实测协议层 `tool.started.name` 是自由 string ✅；但 `src/renderer/components/chat/toolCard.ts`（**初稿误写为 `src/renderer/src/lib/toolCard.ts`，编排者复核更正**）按 Claude 内置工具名**硬编码**：`:551-553` TOOL_VERBS 表、`:653-654` case Read/NotebookRead、`:682-685` Edit/MultiEdit/Write/NotebookEdit、`:691-693` Bash/BashOutput/KillShell、`:704-705` TodoWrite/ExitPlanMode、`:588` `DELEGATION_TOOL_NAMES={'Task','Agent'}`（**同一常量在 `src/agent-host/subagentProjection.ts:91` 另有一份副本**——编排者复核新增发现，加第二个 agent 时两处都要动）、`:774` `BASH_TOOL_NAMES`。P4 实证 codeg 单一 ToolCall 分支 **145 行 / ≥7 处逐 agent 特判（codex 专属 3 处）**。**新增两条形状成本**：① 直连的 fileChange **diff 与审批分帧，必须按 itemId 关联**；② ACP 的 tool_call 即便 `terminal:false` 也带 `{type:"terminal",terminalId}`，客户端必须容忍查不了的引用 [实测/读码] |
| 6 | 历史重放 | 有协议缺口 | **确认并大幅加重：不是"有缺口"，是"跨 agent 必塌"，且塌法有三个独立机制** | P3 读码给出三机制：① 历史来源被 `runtimeIdentity` **单键绑死**且其物理含义是 **Claude JSONL basename**（`sessionHistory.ts:62`，读取器 `historyReader.ts:239-241` 直指 `~/.claude/projects`），Codex 会话只能落 `jsonl_not_found` —— **错误码枚举里没有"本 agent 无历史"这一档**（`:46`）；② `HistoryMessage.id` 的 `h:` 前缀是 **replay 合并的替换语义键**（`:33/36`），换 id 体系会误合或全量重复（合并入口 `chatSessions.ts:437-454`）；③ 协议里**没有任何位置能表达"这条历史消息属于哪个 agent"**，两段历史会铺成同一条时间线。**另有既有缺口**：`HistoryBlock` 只有 4 型 vs 实时 `ChatBlockType` 6 型 → **resume 后授权卡与问答卡永久消失**（`mapHistoryBlock` 对两类无 case）。**两条路都有 resume 契约但都未实跑**（直连 `thread/resume`；ACP `loadSession:true` + `sessionCapabilities{resume,list,close,delete,additionalDirectories}`）→ 历史是本轮**最大的共同空洞** [读码/实测] |

**表外新增两行（初判表里没有、spike 发现应补进去的）**：

| 层 | 判定 | 依据 |
|---|---|---|
| `usage.updated` | **零成本填充，但两条路填充密度差 6 倍** | 结构完全开放（`Record<string, unknown>` 原样透传，下游只浅合并存 raw）。直连 `thread/tokenUsage/updated` 可填 **total+last × 6 字段 + modelContextWindow**；ACP `usage_update` 只有 **`{used, size}`** [实测] |
| `subagent.activity`（T-34） | **诚实降级，省 385 行** | P3 实测该桶 385 行（code 300），置 `capabilities.subagentActivity=false` 即可不做。**注意 ACP 侧 codex 会把 subAgentActivity 伪装成 tool_call 发过来，codeg 必须过滤**（`connection.rs` ToolCall 分支）→ ACP 路这条不是"不做"而是"要写过滤" [实测] |

---

## 4. open-q #1 的判据是否变化

**原判据**：三个月内加不加第 3 个 agent。加 → 接 ACP；不加 → 直连。
**用户 2026-08-06 已答复**：「不打算，就 Claude + Codex 两个。」→ 指向直连。
**复核条款（唯一能推翻它的情形）**：spike 若测出两条路首次成本差距**远大于**原假设的「≈相等」——**例如直连要写的归一化器远超 ACP 客户端 + 映射层的总和**——则判据失效，须重新裁定。

### 检验结果：复核条款**未触发**；判据**维持**

**（a）首次成本差距的方向与幅度**

- 原假设「≈相等」**大体成立，且实测的方向与复核条款设想的相反**：直连 **540–740 行 / 2.5–5.0 人日**，ACP **670–1090 行 / 3.0–7.0 人日**，**直连比 ACP 少 130–350 行 / 0.5–2.0 人日**。[推测·由实测行数换算]
- 复核条款要求的推翻情形是「**直连远超 ACP**」。实测是「**ACP 略超直连**」。→ **条款字面未触发，判据不失效。**
- 关键的成本对称性有实测支撑：**两条路的 JSON-RPC 客户端都是 ~120 行且形状几乎相同**（同为按行分隔 JSON-RPC 2.0 over stdio），**归一化器净新增同为 300–420 行**（同一个 P3 标尺、同一批 27 个 RuntimeEvent 靶子）。→ acp-decision.md 里那句「写第一个解析器的成本 ≈ 写 ACP 客户端的成本」**被实测坐实**。

**（b）判据的一个隐含前提被实测证伪 —— 这是对 #1 结构的实质更新**

- open-q #1 原文写：「万一直连路被实测证明**不可行**（例如 Codex 没有可编程的审批回调通道），ACP 是唯一退路。」
- **实测：这个退路条件不成立。** `codex app-server` 有 **11 个服务端→客户端回调请求**，其中**命令审批与补丁审批两类已在真实回合中实际捕获**（`item/commandExecution/requestApproval` / `item/fileChange/requestApproval`），提问、MCP elicitation、宿主执行动态工具均有契约。[实测]
- → **ACP 的"保险"价值归零。** #1 从「一个可行性未定的二选一」变成「一个纯成本的二选一」。

**（c）判据的经济学在实测后如何变化**

- 摊销点大致不变：ACP 每多一个 agent 在**映射侧**省 ≈ 360–520 行；首次多付 ≈ 130–350 行 → **算术上第 3 个 agent 仍是摊平点**。
- **但摊销模型本身被实测削弱了两处**：
  1. **ACP 的边际成本不是"注册一行命令"**。codeg 实证：`binary_cache.rs` 902 行迷你包管理器（非 npm 分发的 OpenCode/Cursor/Hermes）、`preflight.rs` 766 行 ≥9 类体检、Hermes 锁 Python 3.13、Grok 镜像滞后 + flag 顺序、Cursor symlink 与 Grok 同名 CLI 互相覆盖、全仓 **83 处 workaround 关键词命中**。→ **安装/preflight 侧的边际成本可能吃掉映射侧省下的量**，取决于新 agent 是否走 npm 分发。
  2. **表外三项不可摊销**（选了就一直付，与 agent 数量无关）：权限表达力有损（丢 `applyNetworkPolicyAmendment` / granular / approvalsReviewer）· 341M 重复二进制 + 3 级进程链 · 审批关键数据落在无 schema 的 `_meta.codex`（上游改字段无法被类型系统或 CI 捕获）。
- **反向地，直连侧新增了一项原判据没算到的收益**：`generate-json-schema` / `generate-ts` 让契约**可自动化跟版本**（47 schema + 300 v2 类型 + 99 TS 绑定，可做 CI 快照 diff）。原推导里「直连要自己扛契约漂移」这条成本，**被实测降级为可机器检测的成本**。[实测]

**（d）两种选择各自的后果（不替用户决定）**

- **选直连**：首次少 0.5–2.0 人日、省 362M、拿到 4 维权限矩阵与全部 6 变体审批决策、契约漂移可 CI 检测；代价是接受 `[experimental]` 标记、要同时写 v1/v2 + legacy/v2 双方言、若将来真加第 3 个 agent，每个 ≈ 420–540 行且**该 agent 必须自带可编程双向通道**（反例已在手边：`codex exec` 没有回传通道）。
- **选 ACP**：首次多 0.5–2.0 人日 + 362M + 有损权限投影 + 上游 pin 风险（83 处坑注释是可见的前车之鉴）；换来的是第 3 个 agent 起**映射侧**每个省 360–520 行、以及 codeg 12 个 agent 踩过的坑在同一生态里（软收益）。
- **一条中间事实**：路线差值（0.5–2.0 人日）**小于两路共有的下游改造**（store 加字段 / 索引迁移 / UI 切换器 ≈ 1.5–3 人日）。→ 无论选哪条，**大头都不在路线选择上**。

---

## 5. 未闭合项清单

| # | 未闭合项 | 为什么没测到 | 补测代价 |
|---|---|---|---|
| U1 | **Codex 提问的真实报文（两条路都没有）** —— open-q #2 的核心 | 直连 `item/tool/requestUserInput` 标 EXPERIMENTAL，本轮 5 个真实回合未命中；ACP 侧 `elicitation/*` 一次未触发 | 需设计一个**必然触发提问**的回合（可能要特定工具或 `collaboration_mode`）。单回合 ≈ **4.6–11.6s + ~20k input tokens**（实测 PONG total 20411，缓存命中后 input ~19968）。估 **2–4 回合**，两条路各一组 → **4–8 回合** |
| U2 | **resume / 历史重放（两条路都没跑）** | 本轮控额度未跑 | 直连 `thread/resume`、ACP `loadSession` + `session/list`。需先建一个有内容的会话再重放 → **≥4 回合**（两路各建 1 + 重放 1） |
| U3 | **ACP 侧 6 种 sessionUpdate 零样本**：`user_message_chunk` / `plan` / `plan_update` / `plan_removed` / `current_mode_update` / `config_option_update` | plan 类需切 `collaboration_mode=plan` 或 `clientCapabilities.plan`；后两类需调 `session/set_mode` / `session/set_config_option`。为控成本未再开回合 | `current_mode_update` / `config_option_update` **可能零回合**（只发控制请求）；plan 类需 **1–2 回合** |
| U4 | **直连 `item/permissions/requestApproval` 未诱发**（第三类 v2 审批，响应形状与另两类完全不同） | 触发条件未知 | 需摸索触发条件，估 **2–3 回合**（本轮诱发审批已白跑 3 次，此类摸索成本偏高） |
| U5 | **直连 `turn/interrupt` / `turn/steer` / `thread/compact/start` / `thread/fork` 未实跑** | 仅契约存在 | interrupt/steer 需长回合才好验证，估 **2–3 回合** |
| U6 | **ACP `fs/read_text_file` / `fs/write_text_file` / `terminal/*` 四类反向请求零样本** | 探针已 advertise fs 能力仍未触发；P1 推断 codex 走进程内 exec 所以用不上 —— **0 样本推断，未证实** | 需构造让 agent 走 ACP fs 通道的场景（可能根本不存在）→ 代价不可估，**建议直接标为"codex 场景下不可用（未证实）"** |
| U7 | **`codex mcp-server` 的审批/进度回传形态未实测**（只做了 `tools/list`） | 超出本轮范围 | **1–2 回合**；但该入口已判定为"把 Codex 当工具而非宿主"，优先级低 |
| U8 | **`codex exec` 在 `approval_policy=on-request` 下的行为未实测** | 本轮只跑了默认 | **1 回合**；但 exec 结构上无回传通道，结论大概率不变 |
| U9 | **`approvalsReviewer=auto_review` / `granular` 对象型 approval_policy 未实跑** | 本轮只用了三值字符串 | **2 回合**；`auto_review` 会额外消耗一个子 agent 的额度 |
| U10 | **codex-acp 1.1.10 未装未验** | 1.1.9 一次装通，按任务约定不再试 | 装机 ≈ 8.5s + 又一份 362M；**仅在决定走 ACP 时才需要** |
| U11 | **P3 是纯静态测绘** —— 27 个事件在真实流量中的**频次与时序**未实测；四桶归类是判断非测量；「300–420 行」是推导区间 | 任务目标是靶子契约，不需消耗额度 | 零额度：跑一次现有 Claude 真实回合抓 RuntimeEvent 计数即可（**0 付费回合**，用已有会话） |
| U12 | **codeg `custom_registry.rs`(1355 行) / `opencode_plugins.rs`(696 行) 未读** | 超出 P4 六项必须产出范围，明确标记为待补非编造 | 纯静态阅读，**0 额度**，估 0.5–1 人时 |
| U13 | **Windows / macOS 未测** —— 沙箱实现不同，审批触发条件可能不同 | 本轮全 Linux（`platformFamily:"unix"`） | 需另一台机器；ACP 路额外风险点已知（codeg `binary_cache.rs` 的 TRASH_COUNTER 就是防 Windows 时钟精度并发碰撞） |
| U14 | **`gpt-5.6-sol` 在 `wire_api=responses` 之外的 wire 下是否同样产出 reasoning 事件（`summaryTextDelta` / `summaryPartAdded`）未验** | 本机只有一种配置 | 需另一套 auth，见 §6 |

**本轮额度消耗记账**：P1 用了 **4 个真实回合**（A PONG 4.6s / B ls 11.6s / C 三次尝试 11.5s+ ×3），P2 用了 **5 个真实回合**，P3/P4 **0 回合**。P1 全程在 sandbox 作 cwd，`ls -la sandbox` → total 0，**未对本机文件系统产生任何写入**。

---

## 6. 风险与坑：本机配置对结论的污染

**本机特殊配置**：`~/.codex/config.toml` = 第三方代理 `base_url` + `wire_api=responses` + 模型 `gpt-5.6-sol[medium]`；auth 走 `~/.codex/auth.json` 的 `OPENAI_API_KEY`（**非官方 ChatGPT 登录**）；`sandbox_mode="danger-full-access"`；带 `developer_instructions`（禁止未经明示许可改代码/文件）；配了 `fastctx` MCP。

### 6.1 **不受污染**的结论（本地二进制事实，与 auth / 代理无关）

- 帧格式、方法名全集（126 客户端方法 / 70 通知 / 11 回调）、`generate-json-schema` / `generate-ts` 可用性与产物数量（47 / 300 / 99）。[实测]
- ACP 的 13 种 sessionUpdate schema、5 个 env 旋钮、AgentMode 三档覆盖 `~/.codex`、bin 入口与无 `engines` 字段。[实测]
- **装机体积 362M / 341M 单文件 / 3 级进程链**、内嵌 codex 与 PATH 同版 0.145.0。[实测]
- 权限四维枚举、审批两套方言的变体清单、`availableDecisions` 非强校验、fileChange diff 与审批分帧、`waitingOnApproval → serverRequest/resolved → declined` 三帧时序。[实测]
- 冷启动 187ms / `session/new` 88–90ms（**不含模型往返**）。[实测]
- P3 的全部我方侧行数与落点（纯本仓静态）。[实测]
- P4 的全部 codeg 取证（纯静态读码）。[实测]

### 6.2 **受污染**的结论（标准 OpenAI 配置下可能不同）

| # | 结论 | 污染方式 | 标准配置下可能怎样 |
|---|---|---|---|
| C1 | **`account/rateLimits/updated` 字段全 null**（limitName/primary/secondary/credits/planType 全空） | 第三方代理 + API-key auth | **可能反转**：官方 ChatGPT 登录下大概率有真值 → "产品要显示用量条"这条在当前 auth 下无解，换 auth 后可能可解。P2 自述 [实测·已标记] |
| C2 | **回合延迟 4585ms(ACP PONG) / 4615ms(直连 PONG) / 8379ms(exec) / 11.6s(ls) / 11.5s×3** | 全含第三方代理 RTT | **不可外推**。两条路的**相对**延迟（ACP 4585 vs 直连 4615，差 30ms）仍可信 —— 同代理同模型，说明 **ACP 那层包装本身几乎不加延迟** |
| C3 | **`cachedInputTokens` 行为**（首轮 0、次轮 19968 / 39936 / 59904） | 依赖代理是否实现 prompt caching | 标准 OpenAI 下缓存策略不同，数值不可外推；**"字段会上报"这一点可信** |
| C4 | **模型目录内容（8 / 5 / 25 条）** | **反向污染** —— 目录是**本地静态内置表，不查代理**，所以内容本身没被污染，但它列的是 OpenAI 的模型，**代理支不支持这些完全未知** | **标准 OpenAI 配置下这块自建成本会消失**（目录即真相）；当前配置下"目录与实际可用模型的一致性"是**假的**，必须自建校验 |
| C5 | **`developer_instructions` 导致模型口头答应却零 tool_call**（P1 三次白跑：run2 「我将严格只运行这条命令，然后停止。」/ run3 英文同类 / run4 隔离 CODEX_HOME + 强措辞才触发） | 本机 config 特有 | **机制在标准配置下依然成立**（P1 已把它提炼为一条真结论：**ACP 层的审批行为受 codex 侧 config 语义影响，接入方无法只靠协议控制**），只是不会那么容易撞上。**这条结论保留** |
| C6 | **reasoning 事件已亲眼见到**（`summaryPartAdded` / `summaryTextDelta`，内容如 `**Planning shell execution and patch application**`） | 在 `wire_api=responses` + gpt-5.6-sol 下观察到 | **其他 wire / 模型下是否同样产出未验** → 已列 U14 |
| C7 | **`fastctx` MCP 已配置但 `session/new` 未被拖慢**（88–90ms） | 单一 MCP 样本 | P1 自述这是**推断**（"MCP 是懒连的或没在 session/new 阶段阻塞"）；MCP 更多时启动耗时结论可能变 |
| C8 | **沙箱逃逸 → 审批触发的条件**（read-only 下 `ls -a` / `id -un` 直接放行，只有写文件才升级） | Linux 沙箱实现 | Windows / macOS 沙箱实现不同 → 已列 U13 |
| C9 | **`untrusted` 下抓不到补丁审批**（stderr 原文：`approval policy is UnlessTrusted; reject command — you cannot ask for escalated permissions`） | 与配置无关，是 codex 策略语义 | **不受污染**，但值得记为一条"诱发实验设计规则" |

### 6.3 探针自身的方法学坑（影响可复现性，不影响结论）

- P2 首版脚本用 TS 参数属性 → `node --experimental-strip-types` 报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，已改显式字段赋值。[实测]
- P2 的 biome `noAssignInExpressions`（`while ((idx = buf.indexOf('\n')) >= 0)`）已改 `for(;;) + break`；现 biome check 与 `tsc --noEmit` 对该文件 0 错。[实测]
- P2 的 `report.json` 每次运行覆盖上一次；分文件补丁是在付费 phase 3/4/5 之后加的 → **那几轮的分文件缺失**，结论已从原始 jsonl 重新汇总进 `consolidated-live-summary.json`，**原始报文一条不少**。[实测]
- P3 首次运行探针时 `tee | head -120` 触发 SIGPIPE 把日志截断到 195 行（[4][5] 节缺失），误以为探针崩了；去掉 `head` 重跑 exit=0、158 行完整。[实测]
- P1 诱发审批**第 4 次才成功**；P2 诱发审批**第 1 次白跑一轮额度**（用了只读命令）。→ **"诱发实验"的额度损耗率约 50–75%，补测 U1/U4 时应按此计入。**

---

## 附：证据文件索引

**P1 ACP**：`/home/dan/projects/ai-client/src/agent-host/spikes/s1-acp-codex-probe.ts` ·
scratchpad `s1-acp/` 下 `traffic.jsonl` / `probe-out.json` / `probe-C-out.json` / `probe-C2-out.json` / `probe-C3-out.json` / `handshake.mjs` / `handshake-out.json` / `codex-home/config.toml` / `node_modules/@agentclientprotocol/sdk/schema/schema.json`

**P2 直连**：`/home/dan/projects/ai-client/src/agent-host/spikes/s1-codex-direct-probe.ts` ·
scratchpad `s1-direct/` 下 `report.json` / `report-phases-12.json` / `consolidated-live-summary.json` / `phase3-turn.jsonl` / `phase4-commandApproval-untrusted-CAPTURED.jsonl` / `phase4a-approval-untrusted.jsonl` / `phase4b-approval-onrequest.jsonl` / `phase5-exec.jsonl` / `phase2-catalog.jsonl` / `mcp-tools.jsonl` / `debug-models.json` / `schema/`(47+300) / `ts/`(99)

**P3 靶子**：`/home/dan/projects/ai-client/src/agent-host/spikes/s1-target-contract-probe.ts` ·
scratchpad `s1-ourside-notes.md` / `s1-target-contract-probe.out` / `s1-target-contract-probe.json.out`

**P4 codeg**：scratchpad `s1-codeg-notes.md`

> scratchpad 根 = `/tmp/claude-1000/-home-dan-projects-ai-client/cfb85aab-ccf6-449b-b420-22ad961c2d6e/scratchpad/`
> **⚠ scratchpad 易失** —— 本报告若要保留，须落 `docs/plans/` 或 `docs/plantree/`。

---

## 7. 编排者复核记录（2026-08-06）

四路探针的结论**未直接采信**，编排者对「决定路线走向」的条目逐条回验。方法：直接查原始产物
（`traffic*.jsonl` / `phase*.jsonl` / 装好的 `node_modules` / 本仓与 codeg 源码），不看探针自述。

### 7.1 回验通过（原样成立）

| 项 | 复核方式 | 结果 |
|---|---|---|
| ACP 装机 **362M**、`@openai` **347M** | `du -sh` 实跑 | ✅ 一致 |
| 单文件 codex **310,730,800 字节** + `codex-code-mode-host` **46,139,288** | `find -size +40M -printf` | ✅ 一致 |
| 内嵌 codex 版本 **0.145.0** = PATH 上同版 | 读两处 `package.json` / `codex --version` | ✅ 一致（**"341M 是纯副本"成立**） |
| `codex-acp@1.1.9`，bin=`dist/index.js`，**无 `engines` 字段** | 读 package.json | ✅ 一致 |
| 直连自生成契约 **47 schema / 300 v2 类型 / 99 TS 绑定** | 三处 `ls \| wc -l` | ✅ 47 / 300 / 99 精确一致 |
| ACP 实测出现 **7 种** sessionUpdate | 自写 parser 重扫全部 `traffic*.jsonl` | ✅ 7 种，种类完全一致（计数因合并了 4 份日志而更高：agent_message_chunk 57 / session_info_update 28 / usage_update 15 / agent_thought_chunk 12 / available_commands_update 8 / tool_call 3 / tool_call_update 3） |
| ACP 审批 **4 个 option** + 各带 `_meta.codex.decision` | 直接打印 `traffic-C3.jsonl` 中的 `session/request_permission` 原帧 | ✅ 一致：allow_once(accept) / allow_always(acceptForSession) / accept_execpolicy_amendment(acceptWithExecpolicyAmendment，带 `argv_prefix` 规则) / reject_once |
| **§0 头号结论：ACP 只是把直连 payload 塞进 `_meta.codex` 转发** | 把 ACP `_meta.codex.params` 与直连 `item/commandExecution/requestApproval` 的 params **逐字段并列** | ✅ **坐实**。直连原帧字段 = `{threadId, turnId, itemId, startedAtMs, environmentId, command, cwd, commandActions, proposedExecpolicyAmendment, ...}`，与 ACP `_meta.codex.params` 同批同名 |
| **补丁审批的 diff 不在审批请求里** | 打印 `phase4b` 的 `item/fileChange/requestApproval` 原帧 | ✅ 坐实：`{threadId, turnId, itemId, startedAtMs, reason:null, grantRoot:null}` —— **确实没有 diff**，必须按 itemId 关联 |
| codeg `classify_elicitation` 存在 | grep | ✅ `question.rs:834`（另有 **11 个单测**钉死各分类分支，`:1380-1702`——这是"形态不止一种"的额外实证） |
| `toolCard.ts` 硬编码 Claude 工具名 | 逐行 `sed` 核对 | ✅ 行号全中（653/682/691/704/774/588），**唯路径写错**（见 7.2） |

### 7.2 回验不通过 —— 已在正文就地更正的 5 处

| # | 初稿写的 | 实际 | 性质 |
|---|---|---|---|
| E1 | `src/renderer/src/lib/toolCard.ts` | **`src/renderer/components/chat/toolCard.ts`** | **路径整段错**（行号却是对的）——按初稿路径 grep 会零命中 |
| E2 | `eventNormalizer.ts` **1204** 行 | **1203** 行（`wc -l` 与 `awk END{NR}` 双验，文件末尾有换行符） | 四桶求和 =1204，**有一桶多算 1 行** |
| E3 | codeg `connection.rs:8024` | **`:8026`** | 偏 2 行 |
| E4 | `approval_from_form` 在 `question.rs:890` | **`:899`** | 偏 9 行 |
| E5 | 直连必接面「约 15–20 类」 | **23 个不同 method，其中服务端→客户端 16 个** | 区间估 → 精确值 |

> E1 是唯一会**误导后续施工**的错误（照抄路径会找不到文件），其余四处为引用漂移。
> 五处都不改变任何路线结论。

### 7.3 复核中新发现的一条（初稿没有）

**`DELEGATION_TOOL_NAMES = {'Task','Agent'}` 在两处各有一份副本**：
`src/renderer/components/chat/toolCard.ts:588` 与 `src/agent-host/subagentProjection.ts:91`。
→ 接第二个 agent 时，委派工具名的识别要改**两处**；Codex 的委派/子任务工具名与 Claude 不同，
这是 §3 第 5 行「工具行渲染」成本里初稿漏掉的一个落点。[实测]

### 7.4 门禁（三门，逐门串行）

| 门 | 结果 |
|---|---|
| `pnpm lint`（biome，788 文件） | ✅ **0 error**（29 warning + 3 info 为既有，全在 `docs/design/*.html` 基线原件里）。新增 3 个 spike 文件初始有 **4 个 error**，已修：3 处格式化 + 1 处 `noAssignInExpressions`（`while ((nl = buf.indexOf('\n')) >= 0)` → `for(;;) + break`，与 P2 在自己文件里踩的是同一个坑） |
| `pnpm typecheck`（tsc --noEmit） | ✅ **exit 0** |
| `pnpm test`（vitest） | ⚠️ **130 文件 2426 例，3 例失败** —— 见下 |

**测试的 3 例失败与本 spike 无关，且是既有失败**：
`ShellDetector`（powershell7 缺失回落，2 例）+ `CliDetector`（cmd fallback 探测 claude，1 例），
全是 Windows 路径探测在 Linux 上的失败。**已用 `git stash -u` 退到干净 HEAD 复验：同样 3 例失败**
（`Test Files 2 failed / Tests 3 failed`）→ **本轮改动零回归**。

> ⚠️ **但这与主线台账的记录对不上**：HEAD `8c93bca` 的归档口径写「四门 130 文件 2399 例」（三绿）。
> 实测 HEAD 是 **2426 例、3 例红**。二者必有一处失真——或是当时的绿是在别的环境/配置下取的，
> 或是此后有漂移未被记录。**已作为独立问题提出，不在本 spike 范围内处置。**

---

## 8. S1 出口与落库口径

### 8.1 五项数据的达成度

| # | roadmap S1 要求 | 达成 | 缺口 |
|---|---|---|---|
| 1 | 通道可用性 | ✅ **两条路都实测跑通最小回合** | Windows/macOS 未测（U13）；1.1.10 未验（U10） |
| 2 | 输出形状 + **两条路都要估** | ✅ 两条路都给了行数区间，且有 codeg 510 行实证做锚 | 真实流量频次/时序未测（U11，零额度可补） |
| 3 | 提问形状（校正 reuse-boundary 初判表） | ⚠️ **契约拿到、真实报文没拿到** | **U1 = 本轮最大缺口**，open-q #2 **未闭合** |
| 4 | 模型目录 | ✅ 三套目录、三个数字全部拿到 | 代理真实支持哪些模型两条路都答不出（非路线差异） |
| 5 | 权限语义 | ✅ Codex 四维正交 + 两套审批方言全枚举，ACP 有损点精确到字段 | 第三类 v2 审批未诱发（U4） |

**判定：S1 的出口条件（用数据代替辩论、结 #1）已达成**；#2 未闭合但**不阻塞路线裁定**——
提问形状影响的是适配层厚度（40–80 行 vs 115–280 行），两条路都要付，不改变谁更省。

### 8.2 路线裁定（本报告 + 用户判据答复的合取）

> **不接 ACP，直连 `codex app-server`。**

三条支撑，缺一条都不足以定：

1. **判据侧**（用户 2026-08-06）：不打算加第 3 个 agent → 按 acp-decision 的成本曲线，ACP 的全部价值不成立。
2. **成本侧**（本轮实测）：直连 **540–740 行 / 2.5–5.0 人日**，ACP **670–1090 行 / 3.0–7.0 人日** ——
   直连**不但没更贵，还更便宜** 130–350 行。原假设「≈相等」的复核条款（「直连远超 ACP 则判据失效」）**未触发**。
3. **可行性侧**（本轮实测，**推翻了 open-q #1 的一个隐含前提**）：#1 原文把 ACP 当作「直连不可行时的唯一退路」。
   实测 `codex app-server` 的 11 个服务端→客户端回调中，**命令审批与补丁审批两类已在真实回合中捕获到原始报文**
   → **退路条件不成立，ACP 的"保险"价值归零**。#1 由此从「可行性未定的二选一」降为「纯成本的二选一」。

**同时记入的三条不可摊销代价**（选 ACP 就一直付，与 agent 数量无关，故不进摊销模型）：
权限表达力有损（丢 `applyNetworkPolicyAmendment` / granular / approvalsReviewer 路由）·
341M 重复二进制 + 3 级进程链 · 审批关键数据落在**无 schema 的 `_meta.codex`**（上游改字段类型系统与 CI 都抓不到）。

**反向记入直连的一条原判据没算到的收益**：`codex app-server generate-json-schema` / `generate-ts`
让契约漂移**可机器检测**（47 schema + 300 v2 类型 + 99 TS 绑定，可做 CI 快照 diff）。
原推导里「直连要自己扛契约漂移」这条成本，实测后降级为**可自动化的成本**。

### 8.3 裁定的已知代价（写下来，将来别说没提醒）

- `codex app-server` 明确标 `[experimental]`；v1/v2 双协议并存（v1 只剩 2 文件，v2 有 300），
  legacy/v2 双审批方言都要写；`capabilities.experimentalApi` 决定可见方法与字段。
- 将来若真要加第 3 个 agent：每个 ≈ **420–540 行**新驱动，**且该 agent 必须自带可编程的双向通道**。
  反例已在手边——`codex exec` 结构上没有回传通道（接不住审批），`codex mcp-server` 只暴露 2 个工具。
  这条是本裁定最实在的风险，触发条件明确（用户改主意要加第 3 个 agent），届时按此重估即可。

### 8.4 下一步（S2 提案，待用户排期）

裁定既已落定，S1 收口；下一件事是**直连接入的设计**，而不是继续 spike。建议顺序：

1. **补 U1**（真实提问报文，4–8 回合）——它是 open-q #2 的唯一出口，且直接决定问答适配层厚度。
   **可与设计并行**，不必阻塞。
2. **定会话 ↔ agent 绑定口径**（open-q #3）——落点已由 P3 测准到 4 处（见 §3 第 2 行），
   其中**最硬的一条是 `session-index.json` 是裸数组、无 `schemaVersion`、无迁移**
   → 「`undefined` 视作 claude」必须在**读侧**显式实现。
3. **定权限投影口径**（Codex 四维 → 我方 `permissionMode`）——P3 已确认协议惯例支持
   「只加可选字段、不升 `AGENT_HOST_PROTOCOL_VERSION`」。
4. **历史跨 agent 的最小可接受降级**——这是全表**最大的共同空洞**（§3 第 6 行三机制），
   两条路都没跑过 resume（U2）。短期结论大概率是「Codex 会话不支持 resume 历史」，但要显式降级不是崩。

