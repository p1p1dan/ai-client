# 2026-08-11 `includePartialMessages` 前置 spike（真网关实测）

> 输入：triage `docs/plans/2026-08-11-xvqiu1-triage.md` §4「动工前置 spike」——开着 flag 打一轮真网关，
> 三答案（Cometix CLI 是否履约 partial / 整条是否仍叠发 / tool input 是否真走 `input_json_delta`）定去重设计。
> 探针：`src/agent-host/spikes/partial-messages-probe.ts`（新建，仿 `c16-thinking-shape-probe.ts` 约定）。
> 环境：CCH 测试网关 `https://cch-jyw.pipidan.qzz.io`，模型 `claude-opus-4-8`，cometix `2.1.212` + SDK `0.3.218`，Node 24。
> **本 spike 不改任何生产代码**；结论直接约束后续「开 partial + 除双雷」施工批。

## §0 一句话结论

**五问全部有确定答案，且比 triage 的假设更细**：partial 确实履约；整条 `assistant` 不但仍叠发，而且是**按 content block 逐块叠发、恰好插在该块最后一个 delta 与 `content_block_stop` 之间**（不是回合末尾）——这条时序把去重从「前缀比对赌一把」变成**可断言的不变量**；tool 入参确认走空 `{}` stub + `input_json_delta`（雷 B 坐实）；`message_delta` 带 `usage.output_tokens`，但**每条 API 消息只发一次**（是收尾总数，不是逐 token 的滴答）；`system/thinking_tokens` 两位都发，**思考期与 `thinking_delta` 近 1:1 交替**（本轮 47~58 次/回合，非 c16 记的 8~9——那是短回合的样本）。

## §1 五问裁定

| # | 问题 | 裁定 | 证据 |
|---|------|------|------|
| 1 | 钉版 CLI + SDK 是否履约 `includePartialMessages`（`stream_event` 真到？） | ✅ **履约**。treatment 44/38/37/98/106 条 `stream_event`（五轮），control **恒 0** | §2 摘录 A；`verdict.partialsHonored=true` 五轮一致 |
| 2 | 整条 `assistant` 是否仍叠发？与 `content_block_stop` 的确切交错？ | ✅ **仍发，纯叠加**。且**逐块发**：一条 API 消息拆成 N 个 `assistant` 事件（同 `message.id`，每个只带 1 个 block），每个**紧邻其块的 `content_block_stop` 之前一位**（gap 恒 = 1） | §2 摘录 A（seq 8/33）、摘录 B（seq 112/160）；`wholeEventsAreBlockScoped=true`、`wholeDirectlyBeforeBlockStop=true` |
| 3 | tool_use 入参路径 | ✅ **完全如担心**：`content_block_start` 的 `content_block.input` 是**空对象 `{}`**（另带 `caller:{type:'direct'}`），真入参分 20~22 个 `input_json_delta.partial_json` 片段流完，再由整条消息给出**完整对象**；拼接后的 partial_json 与整条入参**逐字节相等** | §2 摘录 A（seq 10~33）；`toolInputStubbed=true` + `toolInputArrivesAsPartialJson=true` |
| 4 | `message_delta` 是否带累计 `usage.output_tokens` | ✅ **带**，但 **每条 API 消息恰好 1 条 `message_delta`**（`messageDeltaCountPerMessage=[1]`/`[1,1]`），值是该消息的**收尾总数**；回合总数 = 各消息之和（实测 51+30=81 = result 的 81） | §2 摘录 A（seq 35）、摘录 B（seq 162） |
| 5 | `system/thinking_tokens` 是否到、频率 | ✅ **两位都到**（与 partial 无关）。思考期**每个 `thinking_delta` 前一条**，近 1:1；本轮 control 47/58、partial 53/54 条/回合。非思考回合 0~4 条 | §2 摘录 B（seq 5~12）；`thinkingTokensControl/Partial` |

补充事实（超出原五问，但直接影响施工）：

- **雷 A 不止正文**：`thinking` 同样双份——`thinking_delta` 流式 + 整条 `assistant` 的 thinking block（含 356 字符 `signature`）。normalizer 的 `emitThinkingDelta` 两条路径（`eventNormalizer.ts:876` 整条分支 / `:907` stream 分支）会同时开火。
- **`signature_delta`**：思考块收尾多一个 `delta.type='signature_delta'`（摘录 B seq 111），normalizer 现有分支不认它 → 天然忽略，无需额外处理，但测试要钉死「不当文本发出去」。
- **`thinking_delta` 自带 `estimated_tokens: null`**（字段在，值恒 null）——token 口径只能用 `system/thinking_tokens` 那一路。
- **stub 早到多少**：`content_block_start(tool_use)` → 整条 tool_use 消息实测 **930 ms**（Bash 入参 139 字节 / 20 片段）。这就是「stub 驱动 tool 卡」能买到的全部提前量，且随入参大小线性放大（同速率外推：5 KB 的 Write 入参 ≈ 30 s）。

## §2 决定性事件序列（原始 dump 摘录）

> 原始 JSONL 落在 scratchpad（易失）：`partial-probe/{main,final-tool,final-think,run-tool,run-think}/{A-control,B-partial}.jsonl`
> 及同名 `.timeline.jsonl`（每事件到达毫秒）。以下两段是全部结论的承重证据，已逐字抄入本档。

### 摘录 A — treatment，一条 API 消息内「正文块 + 工具块」（`main/B-partial.jsonl`）

```
 1  system/init
 2  system/status {"status":"requesting"}
 3  stream_event message_start        message.id=msg_011Cdvd42oZfZYZW2Uq84Xk7 usage.input_tokens=2883
 4  stream_event content_block_start  index=0 content_block={"type":"text","text":""}
 5  stream_event content_block_delta  index=0 delta={"type":"text_delta","text":"I'll run"}
 6  stream_event content_block_delta  index=0 delta={"type":"text_delta","text":" the command now"}
 7  stream_event content_block_delta  index=0 delta={"type":"text_delta","text":"."}
 8  assistant                         message.id=msg_011Cdvd42oZfZYZW2Uq84Xk7
                                      content=[{"type":"text","text":"I'll run the command now."}]     <-- 整条①，只含 text 块
 9  stream_event content_block_stop   index=0
10  stream_event content_block_start  index=1 content_block={"type":"tool_use","id":"toolu_01JXWUDQ…",
                                      "name":"Bash","input":{},"caller":{"type":"direct"}}             <-- 空 stub 入参
11  stream_event content_block_delta  index=1 delta={"type":"input_json_delta","partial_json":""}
12  stream_event content_block_delta  index=1 delta={"type":"input_json_delta","partial_json":"{\"co"}
13  stream_event content_block_delta  index=1 delta={"type":"input_json_delta","partial_json":"mmand\":"}
…   （input_json_delta 共 22 片，拼出 139 字节 JSON）
32  stream_event content_block_delta  index=1 delta={"type":"input_json_delta","partial_json":"g\"}"}
33  assistant                         message.id=msg_011Cdvd42oZfZYZW2Uq84Xk7
                                      content=[{"type":"tool_use","id":"toolu_01JXWUDQ…","name":"Bash",
                                      "input":{"command":"echo \"partial-probe …\"",
                                               "description":"Echo a probe string"}}]                  <-- 整条②，真入参
34  stream_event content_block_stop   index=1
35  stream_event message_delta        delta={"stop_reason":"tool_use"}
                                      usage={"input_tokens":2883,…,"output_tokens":61,
                                             "output_tokens_details":{"thinking_tokens":0}}            <-- 唯一一条 message_delta
36  stream_event message_stop
37  user                              [{"tool_use_id":"toolu_01JXWUDQ…","type":"tool_result",…}]
38  system/status {"status":"requesting"}
39  stream_event message_start        message.id=msg_011Cdvd4RfUhsMkYZAm4JUBv                          <-- 第二条 API 消息
…   （content_block_start[0:text] + text_delta ×7）
48  assistant  content=[{"type":"text","text":"It printed: partial-probe …"}]   49 content_block_stop[0]
50  stream_event message_delta usage.output_tokens=30    51 message_stop    52 result/success (output_tokens=91)
```

同一提问的 **control**（同轮 `main/A-control.jsonl`，仅 10 事件）：

```
1 system/init   2-5 system/thinking_tokens ×4
6 assistant  id=msg_011Cdvd32dMZQ2EH951XESAL content=[{"type":"thinking","thinking":"Running the command now.","signature":"…"}]
7 assistant  id=msg_011Cdvd32dMZQ2EH951XESAL content=[{"type":"tool_use","id":"toolu_01Qj3wbV…","input":{"command":"echo …"}}]
8 user  [tool_result]     9 assistant content=[{"type":"text","text":"It printed: …"}]     10 result/success
```

→ **逐块拆分是 SDK 既有行为，不是 partial 带来的**（control 也把一条消息拆成两个 `assistant` 事件，同 `message.id`）。partial 只是在每个整条事件之前插进了该块的 delta 流。

### 摘录 B — treatment，思考块 + `thinking_tokens` 交替（`run-think/B-partial.jsonl`，164 事件）

```
  3 stream_event message_start        id=msg_011Cdvdyj8BnskjSbw8iQeEQ
  4 stream_event content_block_start  index=0 content_block={"type":"thinking","thinking":"","signature":""}
  5 system/thinking_tokens            {"estimated_tokens":1,"estimated_tokens_delta":1}
  6 stream_event content_block_delta  index=0 delta={"type":"thinking_delta","thinking":"The","estimated_tokens":null}
  7 system/thinking_tokens            {"estimated_tokens":3,"estimated_tokens_delta":2}
  8 stream_event content_block_delta  index=0 delta={"type":"thinking_delta","thinking":" firs","estimated_tokens":null}
  9 system/thinking_tokens            {"estimated_tokens":5,"estimated_tokens_delta":2}
 10 stream_event content_block_delta  index=0 delta={"type":"thinking_delta","thinking":"t train ",…}
 …  （thinking_tokens / thinking_delta 严格交替，各 53 条）
111 stream_event content_block_delta  index=0 delta={"type":"signature_delta","signature":"…"}  (356 字符)
112 assistant                         content=[{"type":"thinking","thinking":"…512 字符…","signature":"…356 字符…"}]
113 stream_event content_block_stop   index=0
114 stream_event content_block_start  index=1 content_block={"type":"text","text":""}
 …  （text_delta ×46）
160 assistant                         content=[{"type":"text","text":"…558 字符…"}]
161 stream_event content_block_stop   index=1
162 stream_event message_delta        delta={"stop_reason":"end_turn"} usage={…,"output_tokens":479}
163 stream_event message_stop         164 result/success (output_tokens=479)
```

同轮 **control**：62 事件 = `init` + `thinking_tokens ×58` + `assistant{thinking}` + `assistant{text}` + `result`，**零 `stream_event`**。

### 逐字节校验（探针自动判定，非目测）

| 校验 | 结果 |
|------|------|
| 正文：`text_delta` 拼接 == 整条 `assistant` 的 text | ✅ 相等（36 片 / 476 字符；7 片 / 90 字符；…五轮全真） |
| 思考：`thinking_delta` 拼接 == 整条的 `thinking` | ✅ 相等（54 片 / 525 字符） |
| 工具：`partial_json` 拼接 `JSON.parse` == 整条的 `input` | ✅ 深相等（`partialJsonEqualsWholeInput=true`） |
| 每个整条事件与其块 `content_block_stop` 的序号差 | ✅ 恒 = 1（`wholeToNextBlockStopGap` 全 1） |
| 每条 API 消息的 `message_delta` 条数 | 恒 = 1 |

## §3 雷 A（正文/思考去重）设计含义

**现状链**：`eventNormalizer.ts:876`/`:877`（整条 assistant → `emitThinkingDelta`/`emitTextDelta`）与 `:907`（stream `text_delta`/`thinking_delta` → 同两个发射器）都活着。开 partial 后两条路都开火 → **正文与思考各整段重复一次**。

实测把去重从「前缀比对赌一把」升级成**有不变量可依的确定算法**：

1. **块级累积器 + 同型开放块比对**（推荐）：normalizer 为「当前未 `content_block_stop` 的块」维护累积字符串；整条 `assistant` 到达时（它必然在该块 stop 之前、且只带 1 个 block）取同类型的开放块累积器比对：
   - 相等 → **整条丢弃**（实测五轮恒相等，这是常态路径）；
   - 整条以累积器为前缀 → 只发缺失后缀（partial 丢包的兜底，仍不重复）；
   - 都不匹配 → **宁弃不重**（丢整条，日志一行）。
2. **不要用「回合末尾才发整条」这条假设**做设计——实测整条**逐块、贴着 stop 之前**到，任何「等 message_stop 再对账」的写法都会把顺序搞反。
3. `message.id` 在两侧都在（`message_start.message.id` == `assistant.message.id`），可作二级校验键，但**不必须**：块级累积器已足够，且不依赖 stream 事件是否被网关截断。
4. **flag OFF 位零回归**：control 侧 `stream_event` 恒 0，整条路径逐字不动——去重逻辑必须只在「本回合见过 `stream_event`」时才启用（不要用 flag 值判断，用**事实**判断：网关不履约时自动退回整条模式）。
5. Happy Path 断言（可机器判定，供施工批直接钉）：一个含工具的回合，下游 `message.delta` 文本拼接 **恰等于**最终整条文本（一份）、`message.delta` 条数 ≥ text_delta 片数（≥3）、`thinking.delta` 拼接恰等于整条 thinking。变异验证：把「相等即丢弃」翻成「相等也发」，断言必须转红。

## §4 雷 B（tool.started 空 stub 遮蔽）设计含义

**坐实**：`content_block_start` 的 tool_use 块 `input` 是 `{}`；`eventNormalizer.ts:892` 那条今天的死分支一旦活过来，会先发一条 `input:{}` 的 `tool.started`，`seenTools` 首写为王（`:444` `if (this.state.seenTools.has(tool.id)) return;`）**永久遮蔽 930 ms 后到达的真入参**，tool 卡将长期显示空参数。

- **最小修（推荐，零协议改动）**：stream 分支**不发** `tool.started`（tool 卡只认整条消息），代价 = 卡片晚 **930 ms**（本轮实测；随入参字节线性放大，Write 级大入参可达数十秒）。`openTools` 的登记同步延后，对 stall 看门狗无害（`stream_event` 已在 `PRODUCTIVE_EVENT_TYPES`，回合期间根本不会静默）。
- **若要「工具卡秒出」**（另批，需协议+渲染端配套，不建议塞进本批）：stub 先发 + 整条到达时补发同 `toolCallId` 的 `tool.started` 覆盖 `input`。**渲染端现在做不到**：`chatSessions.ts:664` 的 `tool.started` 分支是**无条件 append**（`blocks: [...existing.blocks, {...}]`），补发会长出**第二张重复卡**而不是更新。即 `seenTools` 的首写为王眼下是唯一挡住重复卡的东西，naive 放开必炸。
- 变异验证配对：把「stream 分支不发 tool.started」翻回「发」，断言「`tool.started` 恰 1 条且 `input.command` 非空」必须转红。

## §5 IPC 量级与状态行 token 口径

### 五轮实测（同网关/同模型，2026-08-11）

| 轮次 | 场景 | 事件数 | 其中 `stream_event` | output_tokens | 事件/1k output tok | 峰值 事件/s | `thinking_tokens` |
|------|------|--------|--------------------|---------------|--------------------|------------|------------------|
| tool-1 `main` | control | 10 | 0 | 88 | 114 | — | 4 |
| tool-1 `main` | partial | 52 | 44 | 91 | 571 | — | 0 |
| tool-2 `final-tool` | control | 5 | 0 | 81 | 62 | — | 0 |
| tool-2 `final-tool` | partial | 45 | 38 | 81 | 556 | — | 0 |
| tool-3 `run-tool` | control | 6 | 0 | 91 | 66 | 3 | 0 |
| tool-3 `run-tool` | partial | 44 | 37 | 81 | 543 | **26** | 0 |
| think-1 `final-think` | control | 52 | 0 | 448 | 116 | — | 47 |
| think-1 `final-think` | partial | 159 | 98 | 457 | 348 | — | 54 |
| think-2 `run-think` | control | 62 | 0 | 448 | 138 | 33 | 58 |
| think-2 `run-think` | partial | 164 | 106 | 479 | 342 | **54** | 53 |

- **量级**：partial 位 **340~570 事件/1k output tokens**（工具轮偏高：工具入参 JSON 也计 output token 且片段更碎）。
  按用户现场那条「19 分 55 秒 / ↓38.5k tokens」外推：**约 1.3 万~2.2 万事件/回合**。
- **速率**：平均 3.5~8.6 事件/s，**峰值 26~54 事件/s**（1 秒滑窗）。对照：control 位今天峰值已到 **33 事件/s**（`thinking_tokens` 串），即加密机现在就在扛同量级的 IPC——partial 把峰值抬约 1.6 倍，**不是 triage 担心的「每 token 一事件」**（网关侧 SSE 已合并：文本片平均 **13.2 字符**、思考片 **9.7 字符**）。
  ⚠️ 口径提醒：该合并发生在 CCH 网关（`server: openresty`）侧，**换直连或换网关可能变碎**，Host 侧 40~60 ms 合并作为备选方案不要删。
- **`ChatComposer.tsx:1021` 的 `seenEvents` 无界数组**（`:1107` 逐事件 push，`:1213`/`:1692` join 成诊断串）：按上面 1.3~2.2 万条/回合、每条几十字节算，单回合就是**兆字节级字符串拼接**——triage 判的「同批必带环形缓冲」被实测数量级坐实。

### 状态行 `↓ N tokens` 的真实数据源（修正 triage §4 的一处假设）

triage 写「partial 开后 `message_delta.usage`（累计 output tokens，正是官方 ↓ 数字）」——**实测每条 API 消息只有一条 `message_delta`，且在该消息收尾时才发**。故：

- `message_delta.usage.output_tokens` 只能给出**每条消息一次的阶跃**（工具轮 = 每个工具往返跳一次），**不是逐 token 滴答**；且它是**每消息重新计数**，回合累计需 Host 侧自行累加（实测 51+30 = result 81，可验）。
- **思考期**的实时滴答只有 `system/thinking_tokens`（`estimated_tokens` 累计 / `estimated_tokens_delta` 增量），**两位都在发、今天就能独立出货**（与 partial 无关）——与 triage 的判断一致。
- **正文期**若要一个在动的数字，只能 Host 侧按 `text_delta` 字节估算（属估算，须与计费值区分展示），或接受「按消息阶跃」。这条要进 open-q #31 的 token 口径拍板。

## §6 网关事故记录（务必留档，避免下次误判为探针 bug）

2026-08-11 07:56~08:01 UTC 期间，**同一网关对所有 CLI 请求返回定值应答**：正文恒为
`"Hello! How can I help you today?"`、`usage.input_tokens=10`、`cache_*=0`、`is_error=false`，
**与发什么 prompt 无关**（换过两种 prompt 复现）。交叉验证排除探针问题：

- 既有的 `c16-thinking-shape-probe.ts` 原样跑，五个场景**全部**返回同一句 → 环境因，非本次新代码；
- `curl` 直打 `/v1/messages`（同 token）**正常**（`input_tokens=45`，答案正确）；
- 用仓里现成的 `spikes/capture-proxy.mjs` 抓包：CLI 送出的请求**完全正常**（30 个 tool、system、真 prompt、`thinking:{type:'adaptive',display:'summarized'}`、`?beta=true`），且**经代理转发同一请求即得到正确应答**；
- 约 10 分钟后直连自愈，之后五轮全部正常（本档所有数据取自自愈后）。

结论：属网关侧瞬态降级（`x-served-by: ai.pilab.qzz.io, cch-jyw.pipidan.qzz.io` 双跳），
**与 open-q #5「默认模型 thinking 确定性 400」不是同一现象**（这次是 200 + 定值应答）。
应对手册：smoke 出现「答非所问 + `input_tokens` 个位数」时，先跑 capture-proxy 分层，再判是否 app 侧问题。

另记：think 轮两位都出现过 `system/api_retry`（control 1 次、partial 2 次），回合仍成功——`api_retry` 属常态噪声，不可当失败信号。

## §7 探针用法与残留未测项

**探针**：`src/agent-host/spikes/partial-messages-probe.ts`

```bash
# 从 src/agent-host 下跑（Node 24 类型剥离，与 c16/t34 同约定）
node --experimental-strip-types spikes/partial-messages-probe.ts

# 可选
AICLIENT_PARTIAL_SCENARIOS=A,B         # A=control（不带该 option）/ B=treatment
AICLIENT_PARTIAL_PROMPT='…'            # 换提问（默认：一次 Bash 工具调用 + 一句短答）
AICLIENT_PARTIAL_MODEL=claude-opus-4-8 # 默认；失败自动重试 AICLIENT_PARTIAL_FALLBACK_MODEL
AICLIENT_PARTIAL_DUMP_DIR=<dir>        # 原始 JSONL + timeline 落盘
```

输出：`verdict`（八项机器可判）+ `volume`（事件量/峰值速率）+ 每场景 `messages`（逐消息的整条侧 × partial 侧对账）。
`process.exitCode` 只在「两位都拿到可用答案」时为 0；裁定项本身是发现，不做门禁。

**残留未测（施工前按需补，或按防御性写法处理）**：

1. **子 agent 的 partial**：本轮未触发委派。`parent_tool_use_id` 非空的 `stream_event` 在开 partial 后是否出现未知；normalizer 现有写法（`:889` `if (parentToolCallId) break;`）已把这类事件整体丢弃，**结构上安全**，但 T-34 的「子 agent 无字符流」结论在 partial 位不再自动成立，别把它当前提。
2. **超长回合**（>10 分钟 / >10k output tokens）的事件量与峰值只有外推，没实测；加密机卡顿仍须真机点验（triage 原判保留）。
3. **网关差异**：13.2 字符/片 的合并粒度是 CCH 网关的行为，用户自带 base URL 时可能更碎；Host 侧合并（40~60 ms）作为备选保留。
4. **1 秒滑窗峰值**统计的是 SDK→Host 的事件，未含 Host→Main→渲染的两跳序列化成本。

## §8 验证姿态（本 spike 自身）

- **未新增 vitest 用例**：本批零生产代码改动，交付物是一次性探针 + 本档结论；`spikes/` 同时在
  root `tsconfig.json`（排除 `src/agent-host/**`）与 `src/agent-host/tsconfig.json`（`exclude: ["node_modules","spikes"]`）
  之外，故不进两个 typecheck 门禁。已单独跑过：`biome check src/agent-host/spikes/partial-messages-probe.ts` 干净、
  单文件 `tsc --noEmit --strict` 干净、五轮真网关跑通（`process.exitCode=0`）。
- **裁定项不是恒真**（咬合力反例，三组）：
  ① 网关降级窗口那轮 `toolInputStubbed=false` / `thinkingTokens*=0`（模型压根没调工具、没思考）；
  ② think 轮 `toolInputStubbed=false`（无工具块）；
  ③ 首版分析器把「每个整条事件」当「一条消息」配对时，`toolInputArrivesAsPartialJson` 报 **false**——
  正是这条 false 把分析器缺陷抓出来：整条事件是**逐块**的，带 text 块的那条事件里根本没有 tool_use，
  真入参必须**跨事件全局按 tool id 查**。修正后同一数据翻 true。
- **施工批必带的两对变异验证**（写规格时直接抄）：
  ① 去重：把「累积器相等即丢弃整条」翻成「相等也发」→「正文恰一份」断言必须转红；
  ② 工具卡：把「stream 分支不发 `tool.started`」翻回「发」→「`tool.started` 恰 1 条且入参非空」断言必须转红。
