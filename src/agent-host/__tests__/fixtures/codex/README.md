# Codex 协议报文夹具（从会话 transcript 抢救）

**这些是真实报文，不是构造样本。** 花过真实 API 额度（S1 九回合 + S2-a 四回合），
原始 scratchpad 已随会话蒸发，本目录是唯一留存。**任何时候都不要"补全"或"整理"这些文件** ——
缺的字段就是没抓到，编一条假报文会让切片 3 的回放验收变成自证。

## 来源与抓取信息

| 项 | 值 |
|---|---|
| 抓取日期 | **2026-08-06**（帧内 `emittedAtMs`/`startedAtMs` 换算落在 17:41–17:45 UTC） |
| 抢救日期 | 2026-08-09（本目录建立日） |
| codex-cli | **0.145.0**（`codex app-server` 直连路，非 ACP） |
| 模型 | `gpt-5.6-sol`，经**第三方代理**（→ 见下「受污染字段」） |
| 探针 | `src/agent-host/spikes/s1-codex-direct-probe.ts`、`s2-codex-question-probe.ts` |
| 原始产物 | `S1_OUT_DIR` / `S2_OUT_DIR` 下的 `*.jsonl`，**已随 scratchpad 蒸发，不可再取** |
| 抢救源 | `~/.claude/projects/-home-dan-projects-ai-client/` 下的会话 transcript |

抢救授权：用户于 2026-08-09 会话中逐字授权「把会话 transcript 里的 Codex 报文抽进仓库做夹具」，
范围限定为 **Codex 的 JSON-RPC 协议报文**，不含会话正文、不含用户与助手的对话内容。

## 信封格式

每行一个 JSON 对象，沿用探针原生的线格式：

```
{"dir":"->"|"<-", "tMs":<相对毫秒>|null, "raw":{<JSON-RPC 帧原文>}}
```

- `dir`：`->` = 客户端发往 codex，`<-` = codex 发往客户端。
- `raw`：**逐字保真**。`params` / `result` 体是从 transcript 原样搬运的，未改写、未补字段。
- `tMs`：`null` 表示抓取当时的打印命令没带时间列（不是"耗时为 0"）。
- 少数文件的 `raw` 是由 transcript 里 `<tMs> <dir> <method> <params-json>` 四列**重新组装**成
  `{"method":…,"params":…}` 的 —— 四列本身逐字，只有 JSON 嵌套是重组。逐文件在下表标注。

## 文件清单

| 文件 | 帧数 | 来源（transcript 行号） | 保真度 | 对应验收 |
|---|---|---|---|---|
| `codex-handshake.jsonl` | 3 | `cfb85aab-…2d6e.jsonl:170` | **原生线格式，零重组** | 切片 2 握手 |
| `codex-question-requests.jsonl` | 10 | `…/wf_195c100e-3a9/agent-a1c6eefb2bb0f8a36.jsonl:179`（请求）+ `:182`（回包/resolved） | 请求原生；回包/resolved 重组信封 | **切片 3 提问回放** |
| `codex-question-turn-status.jsonl` | 13 | 同上 `:182` | 重组信封 | 切片 2 status mapper |
| `codex-filechange-approval-turn.jsonl` | 19 | `…/wf_4ded9afa-8df/agent-a6c6ab2ede9fa74f4.jsonl:130` | 重组信封，**19/19 完整** | 切片 2 审批 + 最小完整回合 |
| `codex-command-approval.jsonl` | 18 | 同上 `:104`（审批帧本体）+ `:107`（其余） | 重组信封 | 切片 2 审批 |
| `codex-thread-start-echo.partial.json` | — | 同上 `:104` / `:93` | **PARTIAL** | 切片 2 `thread/start` 形状 |

**非 transcript 来源：自生成契约快照**（上表不适用，它们不是报文）——均由
`codex app-server generate-json-schema --experimental --out <dir>` 生成后节选落库：

| 文件 | 钉住什么 | 对应验收 |
|---|---|---|
| `codex-method-contract.json` | 方法**名**（clientRequest / serverRequest / serverNotification / threadItemTypes） | 切片 2 `codexWireContract.test.ts` |
| `codex-turn-schema.json` | 回合循环的**参数形状** | 切片 2c |
| `codex-question-schema.json` | `request_user_input` 的问题与**应答体**形状 + `serverRequest/resolved` 入参 | 切片 3 |
| `codex-approval-schema.json` | 三套**决策方言**（v2 exec / v2 file_change / legacy ReviewDecision）+ 三类审批请求的参数形状 + `ServerRequest` 全量方法名 | 切片 4 |

四者都是**已提交的静态快照，不会自己发现漂移**：codex 版本一升级，
**必须手动重跑上面那条命令重生成**，否则“钉住了”只是钉住了一个过期的世界。

> **⚠️ 本目录现在有两个版本口径，别混用**：上表的 `.jsonl` / `.json` **报文**夹具永远停在
> **0.145.0**（真实抓取，花过额度，不可再取，也绝不重写）；下表四份**契约快照**已随
> 2026-08-26 的升级票重生成到 **0.149.1**。两者不一致是正常的：一个是「当时线上真的长这样」，
> 另一个是「今天的二进制承诺长这样」。**只有契约快照跟版本走。**

### 2026-08-26 契约重生成（0.145.0 → 0.149.1）

升级票的三件套之②。四份快照全部用新 pin 的二进制重跑
`codex app-server generate-json-schema --experimental` 重生成，逐块与 0.145.0 对照，
结论 **纯增量，零删除**：

| 快照 | 结果 |
|---|---|
| `codex-method-contract.json` | clientRequest 126 → **150**（+24）、serverNotification 70 → **75**（+5）；**serverRequest 11 与 threadItemTypes 18 连生成顺序都逐字不变** |
| `codex-question-schema.json` | **唯一被改动形状的一份**：`ToolRequestUserInputParams` 新增 `isBlocking: boolean` 且**进了 `required`**；同版本把 `autoResolutionMs` 标为 `@deprecated`（上游原话「Use `isBlocking` to decide whether the request should block」） |
| `codex-turn-schema.json` | 全部逐字不变（TurnStartParams 20 键 / TurnStatus 四态 / UserInput 七变体） |
| `codex-settings-schema.json` | 全部逐字不变（ThreadSettingsUpdateParams 13 键 / SandboxPolicy 四变体 / AskForApproval） |
| `codex-approval-schema.json` | 三类审批请求参数与两套 v2 决策方言逐字不变；legacy `ReviewDecision` 新增一个字符串变体 `approved_mcp_policy_amendment` |

**未随本次重生成变化的假设**（逐条复核过）：`ThreadStatus` 四态与
「`idle` 臂没有 `activeFlags` 键」（切片 5 §4.5 改判① 的承重前提）**依然成立**。


⚠️ **【已修复，保留作方法论备忘】`codex-method-contract.json` 的 `serverRequest` 一列曾经是错的**（2026-08-10 切片 4 取证发现，同版本重生成对照；2026-08-17 backfill 补齐另两族，2026-08-26 重生成后三族均与二进制一致）：
它把 `openai/form` 当成方法名（那其实是 `McpServerElicitationRequestParams` 里 `mode` 字段的枚举值），
又漏掉两个真实的服务端请求 `applyPatchApproval` / `execCommandApproval`。真值 **11 条**见
`codex-approval-schema.json` 的 `serverRequestMethods`（提取口径：`ServerRequest.json` 顶层 `oneOf` 各变体的
`properties.method.enum[0]`）。同类欠采还波及 `clientRequest`（缺 5 条，含 `initialize`）与
`serverNotification`（缺 5 条，含 `error` / `warning`）—— 切片 4 只修 `serverRequest` 一族，其余登记为遗留。

### 逐文件说明

**`codex-handshake.jsonl`** — `initialize` 请求（我方 `clientInfo` + `capabilities`）、`initialize` 结果
（`userAgent`/`codexHome`/`platformFamily`/`platformOs`）、`remoteControl/status/changed` 通知。
这三条是全语料里**唯一以探针原生 `{dir,tMs,raw}` 线格式留存**的帧，零重组。

**`codex-question-requests.jsonl`** — 交错排列：请求 #1 → 回包 #0 → resolved #0 → 请求 #2 → 回包 #1 → … 。
**只有请求 #1 / #2 是完整报文**（共 5 颗问题）；**请求 #3 / #4 的本体没捞到**（见下「没捞到」）。
4 条回包与 4 条 `serverRequest/resolved` 全部完整。

**`codex-question-turn-status.jsonl`** — 提问回合的 `thread/status/changed` 与 item 生命周期。
抓取当时的打印命令对 item 体做了 `[:900]` 截断，**3 条截断的 item 帧已丢弃**（宁缺毋假），
保留的 13 条全部完整可解析。

**`codex-filechange-approval-turn.jsonl`** — **本目录质量最高的一份**：一个完整回合的 19 帧，
`item/started(userMessage)` → reasoning → agentMessage → `item/started(fileChange，带 diff)` →
`status waitingOnApproval` → `item/fileChange/requestApproval` → `serverRequest/resolved` →
`status []` → `item/completed(status:"declined")` → … → `turn/completed` + `status idle`。
抓取命令的 `[:500]` 上限从未触顶，19/19 全部完整。**这份可直接当最小完整回合的时序基准。**

**`codex-command-approval.jsonl`** — `item/commandExecution/requestApproval` 的 **params 本体是完整的**
（来自 `:104` 的 pretty-print 报告 JSON，含 `commandActions` / `proposedExecpolicyAmendment` /
`availableDecisions`）。同回合其余帧来自 `:107`，那次打印带 `[:260]` 截断，
**11 条截断帧已丢弃**（含该 exec item 的 `item/started` / `item/completed` 与 `thread/tokenUsage/updated`）。
`id` 字段：`:104` 的报告 JSON 只存了 `method`+`params`，`id:0` 是从 `:107` 同回合的
`serverRequest/resolved {requestId:0}` 对出来的——**这一个字段是推断，不是原文**。

**`codex-thread-start-echo.partial.json`** — **明确标为 partial**：探针只把 `thread/start` 结果里的
3 个键存进了 report（`approvalPolicy` / `sandbox` / `activePermissionProfile`），
结果体的其余部分没留。**`thread/start` 的请求侧参数没有任何逐字留存。**

## 脱敏清单（写盘前逐条执行）

| 类别 | 处理 | 实际命中 |
|---|---|---|
| `sk-*` / `OPENAI_API_KEY` / `Authorization` / `Bearer` / `Basic` / URL userinfo / `auth.json` | 整值 → `[redacted]` | **0 处命中**（这些帧里本来就没有凭证） |
| 第三方代理 `base_url` 主机名 | → `[redacted-host]` | **0 处命中**（代理配置不出现在协议帧里） |
| 用户目录前缀 `/home/dan` | 折叠为 `~` | **1 处**：`codex-handshake.jsonl` 的 `codexHome: "/home/dan/.codex"` → `"~/.codex"` |
| 机器主机名 `serverName` | → `[redacted-host]` | **1 处**：`remoteControl/status/changed`（原值含用户名） |
| `installationId` | → `[redacted]` | **1 处**：同上 |

**刻意未脱敏**（它们是关联逻辑的验证面，抹掉会毁掉夹具价值）：
`threadId` / `turnId` / `itemId` / `requestId` / JSON-RPC `id` 一律保留原值。
`/tmp/claude-1000/…` 沙箱路径保留原值（是 `cwd` / `path` 协议载荷，且不含凭证）。
`userAgent` 里的 `Ubuntu 26.4.0; x86_64` 保留（非凭证，且是握手形状的一部分）。

## 覆盖到什么

`thread/status/changed` 的 **`activeFlags` 实际只覆盖到 3 种组合 + 1 种意外状态**：

| 组合 | 是否有真实样本 | 出现次数 |
|---|---|---|
| `activeFlags: []` | ✅ | 8 |
| `activeFlags: ["waitingOnUserInput"]` | ✅ | 4 |
| `activeFlags: ["waitingOnApproval"]` | ✅ | 2 |
| **两者并发** | ❌ **没捞到** | 0 |
| `{"type":"idle"}`（**`activeFlags` 键整个缺席**） | ✅ | 3 |

已捞回的方法（去重）：`initialize` · `remoteControl/status/changed` · `thread/status/changed` ·
`item/started` · `item/completed` · `item/tool/requestUserInput` · `item/commandExecution/requestApproval` ·
`item/fileChange/requestApproval` · `serverRequest/resolved` · `turn/completed` ·
`item/reasoning/summaryPartAdded` · `item/reasoning/summaryTextDelta` · `account/rateLimits/updated`。

## 没捞到 —— 要重新花额度才有

按重新抓取的性价比排序：

1. **`item/tool/requestUserInput` 请求 #3 / #4 的本体（5 颗问题）。**
   抓取当时的打印命令写了 `if n>=2: break`，#3/#4 的 `params` 从未进过 transcript。
   仅存的旁证：回包里的问题 id（#3 = `prod_host_exact` / `db_url_exact`；
   #4 = `db_env_syntax` / `telemetry_endpoint` / `other_prod_values`）与被选中的 option label。
   **重抓成本高**：S1 §6.3 记载"诱发实验"成功率仅 25–50%，且必须把
   「散文提问对我无效 + 点名调用 `request_user_input`」写进提示词才触发。
2. **`activeFlags` 两者并发（`waitingOnUserInput` + `waitingOnApproval`）的真实帧。**
   全语料零样本。需要构造"提问未答复时又触发审批"的回合。
   *在拿到真实样本前，切片 2 的 mapper 不应把"并发"当作已验证行为断言。*
3. **`thread/start` 的请求参数与完整结果体。** 逐字留存为零（只有 3 键的 echo，见上）。
4. **`item/tool/requestUserInput` 的 `isSecret:true` 与 `autoResolutionMs` 非空样本。** 0 样本 ——
   超时自动放行的**客户端义务**（谁计时、超时后服务端会不会自己 resolve）完全未验证。
5. **`item/permissions/requestApproval`（U4）与 MCP elicitation。** 只有 schema，无真实报文；
   S2-a 用零额度 sinkhole 实测：`request_permissions` 在本机 build/模型上**无法注册进工具表**，
   即**无法用真实回合诱发**。
6. `commandExecution` 审批回合里被 `[:260]` 截断的 `item/started` / `item/completed`。

## ⚠ 与施工档记载不符 / 必须写进设计的事实

1. **`idle` 状态没有 `activeFlags` 键。**
   `{"status":{"type":"idle"}}` —— 不是 `activeFlags: []`，是**整个键缺席**。
   status mapper 若写 `status.activeFlags.includes(…)` 会在回合收口时直接抛 TypeError。
   必须按 `type` 先分支，再读 `activeFlags`。
2. **`availableDecisions` 实测只有 3 项，不是施工档记的 6 变体。**
   真实帧里是 `["accept", {"acceptWithExecpolicyAmendment":{…}}, "cancel"]` ——
   **`decline` 根本不在列表里**，可我方回包 `{"decision":"decline"}` 服务端照单全收、
   回合正常继续。即 **`availableDecisions` 不是强校验白名单**，别照它生成 UI 按钮的唯一来源。
3. **`thread/start` 的 `sandbox` 请求侧是字符串、结果侧是对象。**
   探针发的是 `sandbox: 'read-only'`（见 `s1-codex-direct-probe.ts:375-379`，字符串），
   回显展开成 `sandbox: {"type":"readOnly","networkAccess":false}`。
   → **`networkAccess` 只出现在结果侧**，请求侧无处可填；网络是沙箱的独立子维度。
   这条闭合了设计里那处未闭合事实，但注意：**请求侧的字符串形状只有我方探针源码为证，
   没有逐字的 `thread/start` 请求帧留存。**
4. **提问报文自包含，审批报文不自包含。**
   `item/tool/requestUserInput` 的 `itemId`（`call_…` 前缀）在整个回合的
   `item/started` / `item/completed` 里**一次都没出现**过 —— 提问不产生 item，无需关联。
   反过来 `item/fileChange/requestApproval` 极瘦（只有 `threadId/turnId/itemId/startedAtMs/reason/grantRoot`），
   **diff 在同一 `itemId` 的 `item/started` 里先到**（见 `codex-filechange-approval-turn.jsonl` 第 8、10 行，
   `11235ms` 先于 `11236ms`）。客户端必须按 `itemId` 关联才渲染得出补丁。
5. **服务端请求 id 自成空间，从 0 起。** 提问回合是 0,1,2,3；审批回合也从 0 起。
   不要和我方客户端请求的 id 空间混用。
6. **实测常量（样本量已标注，不要当作不变量硬断言）：**
   `isOther` 恒 `true`（10/10）· `isSecret` 恒 `false`（10/10）· `autoResolutionMs` 恒 `null`（4/4）·
   `options` 实测从不为空（但**生成契约里它是 `["array","null"]`** ——
   见 `codex-question-schema.json` 的 `ToolRequestUserInputQuestionOptionsType`，逐字引自生成文件。
   两句各说一半：**契约允许 null，留存样本未见 null**。
   2026-08-10 此处原写“schema 里的 nullable 是假的”，是从 5 颗样本得出的推断，已改写；
   实现一律取容错解（null / 缺席 / 非数组 → `[]`）·
   `params` 恒 5 键、`question` 恒 6 键、`option` 恒 2 键（`description` 必填）。
   注意这里的 10/10 是**跨 4 条报文**统计的，而本目录只留存了其中 2 条 —— 校验时按留存样本算，
   别把 10/10 写成夹具能证明的数字。

## 受污染字段（第三方代理导致，标准 OpenAI 配置下可能不同）

- `account/rateLimits/updated`：`limitName` / `primary` / `secondary` / `credits` / `planType` **实测全为 null**。
  这是第三方代理 + API-key 的结果，**不要据此认为这些字段永远为空**。


## S5 追加捕获（2026-08-15，切片 5 取证，U2-a 判决）

| 文件 | 内容 |
|---|---|
| `codex-s5-history-turn.jsonl` | 一个真实回合的全部帧（userMessage / reasoning / commandExecution / agentMessage 四种 item 的 `item/started`/`item/completed`），探针 `spikes/s5-u2a-history-probe.ts`，花费 U9 拍板预算内的 1 个真实回合 |
| `codex-s5-thread-resume.jsonl` | **新进程**里 `thread/resume` + `thread/read` 的全部帧（重启后恢复的真实回包，仓内此前零留存） |
| `codex-s5-u2a-report.json` | 探针结构化报告（liveIds vs 重投影 ids 的比对结论） |

**U2-a 判决（2026-08-15 实测，codex-cli 0.145.0）**：
1. **实时 item id ≠ 重投影 item id**——实时是异构体系（userMessage=uuid / reasoning=`rs_…` / exec=`exec-…` / agentMessage=`msg_…`），`thread/resume` 重投影后是**位置序 `item-N`**。`h:codex:<threadId>:<itemId>` 的 id 若取重投影 id，与实时消息**永不可按 id 对齐**；去重须按内容/身份。
2. **重投影丢 item**：实时 4 个 item，重投影只回 userMessage + agentMessage 两个——**reasoning 与 commandExecution 不进重投影**（`itemsView:"full"` 仍如此）。
3. `thread/read` 只回 thread 元数据**不带 turns**；`thread/items/list` 报错；**读历史唯一可用方法 = `thread/resume`**（结果的 `turns[].items[]`）。
4. **resume 重新从 config.toml 派生权限**：原 thread 以 `never/read-only` 起，重启 resume 回包却是 `on-request/dangerFullAccess`（探针跑在真实 `~/.codex` 下）——产品 resume 路径必须重申权限策略。

抓取环境：真实 `~/.codex`（探针口径，产品用隔离 CODEX_HOME）；模型 `gpt-5.6-sol` 经第三方代理。
内容全为探针自拟的琐碎指令（`echo u2a-probe` / `DONE`），无用户对话内容。


## 升级门禁（G9b，2026-08-15 立）

固定夹具永不自己变红（false-green）：codex-cli 版本升级时**必须**——

1. 重跑 `spikes/s5-u2a-history-probe.ts`（花 1 真实回合）重新捕获 `thread/resume` 回包；
2. 比较回包 `turns[].items[]` 的 **item type 集合**与本目录 `codex-s5-thread-resume.jsonl` 的差异——出现新类型（尤其 reasoning / commandExecution 若恢复进重投影）即触发 reader 富化评审（切片 5 L1 哨兵）；
3. 重跑 `codex app-server generate-json-schema` 更新契约快照（既有 L7 纪律）；
4. 顺带核对 `historyMode` / `itemsView` 语义有无启用（L2 观察项）。

G8b 免额度姿态校验可随时重跑：`spikes/s5-g8b-posture-probe.ts`（注意零回合 thread 无 rollout 的前置，见该文件头）。


## E4 缺凭据夹具（D47 S4a，2026-08-15 从 spike 文档提取，非会话 transcript 抢救）

| 文件 | 内容 | 权威原文 |
|---|---|---|
| `e4-missing-envkey.jsonl` | `AICLIENT_CODEX_API_KEY` 未设置组的完整 14 帧（`initialize`→`thread/start`→`turn/start`→异步通知序列，终于 `turn/completed`，`turn.status:"failed"`） | `docs/plans/2026-08-15-d47-s0-spikes/e4-appserver-missing-envkey.md` 「逐帧 fixture —— missing 组」 |
| `e4-present-envkey.jsonl` | 对照组差异尾段 2 帧（`turn/started` + 延迟 `error` 通知，`willRetry:true`，网络层重试中，本窗口内无 `turn/completed`） | 同上「逐帧 fixture —— present 组对照」 |

**逐字来源**：两文件的每一行都是从上表 E4 spike 文档的「逐帧 fixture」代码块**逐字**转录成本目录既有的
`{"dir":…,"tMs":…,"raw":{…}}` 信封格式（该文档本身记录的是一次真实 `codex app-server` 进程的 NDJSON
JSON-RPC 会话，非构造样本 —— 见文档头「只做实验，未改动 `src/` 下任何产品代码」）。`<CODEX_HOME>` /
`<workdir>` 两处占位符沿用原文档，未替换为具体路径（原文档本就是脱敏占位，不是本次转录引入的）。

**用途**：`codexNormalizer.ts`「三臂必测」——missing 组验证 `error` 通知与 `turn/completed.turn.error`
双 carrier 携带同一 `Missing environment variable: `AICLIENT_CODEX_API_KEY`.` 错误时只产出一次
`session.failed`（exactly-once）；present 组验证 `willRetry:true` 的网络重试臂绝不被误判为终态。
