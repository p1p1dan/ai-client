# S3 切片 3 — Codex 提问桥 施工规格

> **2026-08-10 落库，动工前写；同日经双轨对抗评审后修订（rev.2）。**
> plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。
> 权威链：[S2 设计档](./2026-08-06-s2-codex-integration-design.md) §3「切片 3」+ §1 C8/C9/C10/C15 + §0.5-② ＞ 本档。
>
> **评审编排**：Codex 轨因模型容量满载失败（未取得结论），改派第二个独立 reasoner 换镜头（证据与可验证性）
> 与第一轨（时序与所有权）双盲同题。**两轨独立收敛 4 条**（见 §0.1），单轨独有 15 条全部采纳或登记。
> rev.1 的三处结论被推翻，逐条记在 §0.2 —— **不许把推翻当成"优化"抹掉**。
>
> 标注纪律沿用：`[实测]` = 有原始报文或自生成契约逐字为证；`[契约]` = 生成式 schema 允许但无样本；
> `[读码]` = 源码可证；`[推测]` = 仍是推测，不得升格。

---

## 0.1 两轨独立收敛（可当定论）

| # | 两轨各自独立得出的同一结论 | 落点 |
|---|---|---|
| 1 | **A1/A2 的"4 条报文 / 10 颗问题"不存在**，照它施工只能靠编假报文，而夹具 README 首段明令禁止 | §4 A1/A2 重写 |
| 2 | **零问题兜底会发一条"孤儿" `question.resolved`**（卡从未发出却宣告 resolved），并被 store 无条件用来清提问坞 | §2.4 改为不登记、不发事件 |
| 3 | **A9「桥从不 emit session.status」断的是实现镜像**——桥是纯函数，本就没有 emit 通道，恒真 | §4 A9 挪到 runtime 的 emit 数组上 |
| 4 | **A13 指错文件**：`codex-question-schema.json` 里一个方法名都没有，钉不住 `SERVER_REQUEST_KINDS` | §4 A13 重写 |

另有一条**三方收敛**（编排者 + 两轨都独立命中）：`serverRequest/resolved` 的分支若写在
`onNotification` 的 `if (!turn)` 早退之后，就等于把 §2.1 要修的洞原样修回去。见 §2.1。

## 0.2 rev.1 被推翻的三处（不得静默改写）

| 原文（rev.1） | 推翻理由 | 现行 |
|---|---|---|
| §2.3 三步拆分规则（整串命中→全段命中才拆→否则不拆） | 第 1、2 步对 Codex **恒不可达**（无 multiSelect 位 → `buildRespondPayload` 的 `parts` 恒长度 1，永不合成 `', '`）；第 2 步唯一能命中的输入是**用户在 Other 里手打、恰好整段命中标签**的文本，命中即切碎 —— 即该规则**只可能错误触发** | **不拆**，恒 `[value]`。将来真加多选时连同 `multiSelect` 映射一起加 |
| §2.2-4「结果为空对象且非 cancel → 拒发并回 `invalid_payload`」 | 该防呆在**共享分发层**已经存在且对 Codex 生效（`index.ts:643-651`，在 `rt.respondQuestion` 之前）。桥内重复一遍是两个真相源；且 rev.1 对 C15 的描述与代码事实相反 | 删除桥内判据，C15 的口径在 §1-4 澄清 |
| §4「本片实际不改 `chatSessions.ts`」 | 错。零问题孤儿事件与 drain 事件都会打到 `question.resolved` 的**无条件清空**上（`chatSessions.ts:847`），跨会话抹掉另一张卡的提问坞 | 本片对红线文件**有一处加法**：清空前加匹配守卫。见 §3.3 |

---

## 0.3 新取得的一手证据

用 codex 二进制自生成契约（与切片 2c 的 `codex-method-contract.json` / `codex-turn-schema.json` 同一取法）：

```
codex app-server generate-json-schema --experimental --out <dir>
```

落库为 `src/agent-host/__tests__/fixtures/codex/codex-question-schema.json`（每个块**标注来源生成文件**，
并写明「codex 版本一升级必须重跑本命令」——快照不会自己发现漂移，这一点 rev.1 的注释吹过头了，已改）。

| 事实 | 强度 | 对实现的影响 |
|---|---|---|
| `ToolRequestUserInputQuestion.required = [header, id, question]` —— `id` 必填 | [实测] 逐字 | C8 的「有 id 用 id」对 Codex 侧恒成立 |
| `options` 的 `type` 是 `["array","null"]` | **[契约]，不是 [实测]** | 见下一段 |
| `ToolRequestUserInputQuestion` 无 multiSelect 位 | [实测] 逐字 | 请求侧**无法告知多选**；「Codex 恒单选」是由此推出的**服务端行为推断**，不得升格 |
| 应答体 `{answers: {<qid>: {answers: string[]}}}`，两层 `required` | [实测] 逐字 | 与留存的 4 条 `->` 帧一致 |
| `ServerRequestResolvedNotification.required = [requestId, threadId]` | [实测] 逐字 | §2.1 入参形状 |

**`options` 可为 null 这条要单独说清**：夹具 README 现有一句「schema 里的 nullable 是假的」，
与生成契约冲突。二者其实各说了一半：**schema 声明可为 null（契约）**，而**留存的 5 颗问题 options 全非空（实测）**。
「服务端强校验所以永不为 null」是从 5 个样本得出的推断，不足以据此写出会崩的代码。
→ **实现取容错解（null / 缺席 / 非数组 → `[]`），标注按 [契约] 而不是 [实测]**；
同时把 README 那句改写为不冲突的表述（本片顺手修，属证据卫生）。

---

## 1. 与 S2 的差异登记（四条）

1. **校正（降级版）**：`options` 契约上可为 null，实测未见。实现容错，标注不升格。
2. **新增（S2 全档未覆盖）**：`serverRequest/resolved` 的消费者。见 §2.1。
3. **新增**：`onServerRequest` 的**回合守卫**。S2 假定服务端请求只在回合内到达，没写 Stop 之后的行为。见 §2.4。
4. **口径澄清（不是改动）**：C15「不套用 Claude 的空 payload 拒收防呆」指的是**桥内不再加一遍**；
   分发层 `index.ts:643-651` 那条对所有 agent 生效且保留 —— 渲染端的 Skip 走 `{cancel:true}`，正常通过。

---

## 2. Host 侧

### 2.1 前置修复 P0 —— `serverRequest/resolved` 目前无人消费

**现状** [读码]：`codexNormalizer.ts:79` 把它列为「owned by the pending table」而丢弃；
`codexRuntime.onNotification` 无此分支；`codexPending` 无「服务端已自行了结」入口。**注释里承诺的所有者不存在。**

**证据分级（rev.1 在这里过度自信，已改）**：留存的 4 条 `serverRequest/resolved` **全部出现在我方回帧之后**
[实测] —— 那是无害的空转（`settle()` 先删条目，回声查无此条）。
**服务端自行了结**（`autoResolutionMs` 到期 / 回合被中断 / 请求被撤回）**零样本** [推测]，
README「没捞到 #4」一节明记 `autoResolutionMs` 的客户端义务完全未验证。
→ 立论不靠"它一定会发生"，而靠**代价不对称**：消费者约 15 行；不做则一旦发生就是「卡片永远 pending +
输入框按 `waiting_question` 冻死 + 稍后 drain 对服务端已不再等待的 id 回帧」。

**修法**：`PendingServerRequestTable` 增加**唯一一个不写帧的移除入口**：

```
forget(requestId): PendingServerRequest | undefined
  命中 -> 删除条目 -> onSettled(entry, 'forgotten') -> 返回 entry      // 绝不写帧
  未命中 -> 查最近 settled 环(32 条) -> 命中则 debug 静默；都不命中 -> WARN
```

- `PendingSettleReason = 'answered' | PendingAutoReason | 'forgotten'`，**只在 `codexPending.ts` 内部**，
  不动共享的 `PermissionAutoReason`（协议枚举不为纯 Host 概念加宽）。
- 最近 settled 环是为了让「我方答完的正常回声」「服务端 resolve 了一个我们没登记的 id」「条目被别的路径吃掉」
  在日志里可分 —— 无条件静默会把这三种焊成一种。
- **分支位置是硬要求**：写在 `onNotification` 的 `if (!turn) return`（`codexRuntime.ts:737-747`）**之前**，
  与 `statusChanged` 同级。服务端自行了结高度集中在回合收尾窗口，写在 `ingest` 附近（最自然的位置）
  等于让它永远进不来。A6 有一条 `state.turn === null` 的同场景断言钉住这点。
- `forget` 是**通用**的，切片 4 的审批同吃这条。
- `belongsToThread` 只是卫生检查不是安全边界（`codexRuntime.ts:451-455`：`expected` 未设或 params 无
  `threadId` 时一律 true）；真正的隔离靠「一表一连接」。

### 2.2 新模块 `src/agent-host/codexQuestionBridge.ts`（纯函数，零 IO）

只做两向翻译：不持有状态、不 emit、不写 wire。C15 已裁「不抽公共 settler 基类」，与 `questionBridge.ts` 零共享。

**入向** `toQuestionItems(params)`：

| 我方字段 | 取自 | 缺失/异常时 |
|---|---|---|
| `question` | `q.question` | 非空串才收；否则整条问题丢弃并计数 |
| `header` | `q.header` | 非串则省略 |
| `id` | `q.id` | 非空串才写；缺席则省略（**不造 id**，answers 回落原文） |
| `options[]` | `q.options[]` 的 `label` / `description` | null / 缺席 / 非数组 → `[]`；单个 option 无 `label` → 跳过 |
| `isSecret` | `q.isSecret === true` | 否则省略（不写 `false`，与「absent = false」一致） |
| `multiSelect` | —— | **恒不写**（Codex 契约无此位） |
| `autoResolutionMs` | `params.autoResolutionMs` | 只在 number 或 null 时透传；客户端不实现（A11 有显式忽略断言） |
| `isOther` | —— | **恒不读**（渲染端无条件追加 Other 行；A11 有显式忽略断言） |

**出向** `toCodexAnswerBody(items, input)` → `{answers: {<qid>: {answers: string[]}}}`：

1. `cancel === true` → `{answers: {}}`（干净取消，S2-a [实测]）。
2. 否则逐 item：取 `input.answers[item.id ?? item.question]`。
3. **`input.response` 只在 `items.length === 1` 且该 item 没取到 answers 时**折入。
   多问时忽略并 WARN —— 否则一条 `response` 会被**广播给每一个未匹配的 item**，
   模型会收到它没被问过的答案（入口是开的：`index.ts:637-651` 原样透传 `response`）。
4. 仍取不到 → **跳过该 item**（不写空数组）。**两边都是零样本** [推测]：4 条 `->` 帧每条都把请求里的
   全部 id 写全了，所以「整条省略」与「写 `{answers: []}`」哪个被服务端接受都没测过。
   §5 登记降级路径：若服务端对缺 key 报 -32602，改写空数组。
5. 值 → 数组：**恒 `[value]`，不拆**。理由见 §0.2 第一行。

### 2.3 `codexRuntime` 接线（唯一 emit 点）

`onServerRequest` 的 `kind === 'question'` 分支，**三道前置守卫，都在 register 之前**（三者都是
「直接回帧、不登记、不发卡」，与既有的未知方法路径同形；回帧体统一走 `codexPending` 导出的
`defaultReplyFor(kind, reason)`，避免第二处手写 `{answers:{}}`）：

| 守卫 | 条件 | 为什么 |
|---|---|---|
| G1 回合守卫 | `state.turn === null` | Stop 之后 `stop()` **不设 `torndown` 也不删 session**（`codexRuntime.ts:1059-1077`），而 `turn/interrupt` 自陈 best-effort 且效果 [未测] → codex 可能继续发提问 → 弹一张属于已放弃回合的卡，并把会话经 `chatSessions.ts:821` 拽回 `waiting_question` 忙态 |
| G2 空问题守卫 | 归一化后 `items.length === 0` | 发一张零问题的卡等于挂死；而登记后再 settle 会产生**孤儿 `question.resolved`**（0.1-②） |
| G3 —— | （既有）未知方法 | 保持 `replyError` 不变 |

通过守卫后：register → emit
`question.requested{questionId: entry.correlationId, questions, autoResolutionMs?}`。
**不 emit `session.status`**（C10 rule 3；fixture 已证服务端每次答完都发 `activeFlags:[]`）。

`respondQuestion(input)`：

1. 按 `input.questionId` 在 `state.pending.list()` 里**扫 correlationId**（不解析字符串：sessionId 可能含 `:`）。
2. **找不到条目 → 不发 `host.error`**，改为 log + 补发一条
   `question.resolved{questionId, outcome:'rejected'}`（幂等，能清坞）。
   理由：非 fatal 的 `host.error` 在渲染端**就是静默**（`hostStatus.ts:85-92` 直接 `return prev`；
   `chatSessions.ts` 的 `applyRuntimeEvent` 无 `host.error` 分支）。
   而这条路径恰恰是 forget 与用户点 Continue 撞车的窗口 —— 让 UI 一定收敛，比让它静默卡住重要。
3. kind 不符 / sessionId 不符（真正的形状错误）→ `host.error{invalid_payload}`。
4. `toCodexAnswerBody` → `settle(requestId, {reason:'answered', result})`。
5. emit `question.resolved{questionId, outcome: cancel ? 'cancelled' : 'answered', answers?, response?}`。

`onSettled` 观察者：`entry.kind === 'question'` 且 `reason !== 'answered'` → emit
`question.resolved{questionId: entry.correlationId, outcome:'rejected'}`。
**必须排除 `'answered'`**，否则用户答一次收到两条，第二条把 `answered` 覆盖成 `rejected`（卡片显示「Questions skipped」）。
配合 G1/G2 之后，出口共四条：answered/cancelled（步骤 5）· drain 三路 · forgotten · 步骤 2 的补发，
**每条挂起请求恰好一条 `question.resolved`**。

---

## 3. 渲染端

### 3.1 answers 的 key 换成 id（C8）—— 协议 key 与 React key 必须分开

- `buildRespondPayload`：`answers[item.question]` → `answers[item.id ?? item.question]`（**协议 key**）。
- `deriveFrozenPairs`：查表同上。
- **React key 另走一路**：`item.id ?? String(index)`。
  `item.id ?? item.question` 在 Claude 侧「同一回合两题原文相同」时**不唯一**，而
  `runtimeEvents.ts:376-378` 的类型注释白纸黑字承认这种重复真实存在。本片正在改这两行，不分开就是明知故犯。
  两处落点（`QuestionCard.tsx:345` 的 items map、`FrozenPair`）都由 model 层出，组件不自己拼。
- `FrozenPair` 新增 **必填** `key: string`，落点**三处**（`deriveFrozenPairs` 的正常分支与 skipped 分支、
  `derivePermissionCardView` 的两个字面量）。设为可选会悄悄回落到 `pair.question` = 等于没改。
- **Claude 影响**：行为零变化（`item.id` 恒 undefined → 协议 key 逐字节走原分支）。

### 3.2 `isSecret` 掩码（§0.5-②）—— 只掩自由文本，不掩结构化选项

- Other 输入框：`isSecret` 时 `type="password"` + `autoComplete="off"` + `spellCheck={false}`。
- 冻结态：**仅当答案不等于该 item 任何 `options[].label` 时**才掩码（即答案来自 Other 自由文本）。
  `isSecret` 是**问题级**的位，而答案可能是公开标签（「Use environment variable」）——
  无条件掩码等于把「不可撤销的泄漏」换成「不可回溯的困惑」：用户既没被保护，又永远看不到自己答了什么。
  `block.questionResponse` 回落分支同样走这条判定。
- 掩码值 `SECRET_MASK` **定长**，与真值长度无关（长度本身也是信息）。
- 判定放 model 层（出 `masked: boolean`），组件不自己判。
- 复制通道已核实安全（`turnCopy.ts:34-39` 只取 `text` 块，问答块不进剪贴板）；
  真值仍在内存 store 与发给模型的 wire 上 —— 本项只管**显示**。

### 3.3 红线文件 `chatSessions.ts` 的一处加法

`question.resolved` 的两个 return（`:829` / `:847`）目前**无条件** `pendingQuestion: null`，
不比对 sessionId / questionId。→ 改为**仅当 `state.pendingQuestion?.questionId === questionId`
（且 sessionId 相符）时才清**，否则保持原值。纯加法守卫，Claude 行为不变。

**本片只做这一半**：`pendingQuestion` 是**全局单槽**（`:816-820` 每来一条 `question.requested` 就整体覆盖），
两个会话并发提问必丢一张卡 —— 那是**与 agent 无关的既有缺陷**（两个 Claude 会话同样触发），
要改成 `Record<sessionId, …>` 并连带改 `PendingQuestionDock` 与 `selectPendingQuestionBlock`，
形状变更 + 自己的测试，不属本片预算。**登记见 §5，另立任务。**

---

## 4. 验收（先写死，实现不许改测试去迁就自己）

| # | 断言 | 形式 |
|---|---|---|
| A1 | **2 条**真实入向 `item/tool/requestUserInput`（id 0/1，共 **5 颗**问题）回放，逐字段比对 `question.requested` | 夹具驱动 |
| A2 | 上述 2 条的应答体 **deep-equal** 夹具 `raw.result`（不是整个 JSON-RPC 信封，也不是逐字节——key 顺序是实现细节）。id 2/3 只有回包无请求体，**降级为弱钉子**：只钉 key 集合与 label 字符串，标 `[旁证]` | 夹具驱动 |
| A3 | `cancel:true` → `{answers:{}}`；且整个 emit 数组里 `question.resolved` **恰好 1 条**（「一条都没发」不算通过） | 单元 |
| A4 | `options` null / 缺席 / 非数组 → `[]`，问题仍发卡 | 单元 |
| A5 | **任何**答案值都不拆分（含含 `, ` 的自由文本、含 `, ` 的标签、整段命中标签的文本） | 表驱动 |
| A6 | `serverRequest/resolved` 到达未答条目 → 表 size 减 1、**零 reply 帧**、一条 `question.resolved{rejected}`；**并在 `state.turn === null` 时同样成立** | 单元 |
| A7 | 我方答完后到达的回声 → 零副作用、零额外事件、日志走 debug 而非 WARN | 单元 |
| A8 | 拆两条：**(a)** stop / close / dispose 三路 —— 每条挂起请求都收到过 reply 帧；**(b)** exit 路 —— 表清空 + 每条一条 `question.resolved`，**明确不要求写帧**（`codexConnection.ts:208` 对已关闭连接的写入是 drop，断言写帧只能靠 mock 断绿） | 单元 |
| A9 | **挂在 `codexRuntime` 提问回放的 emit 数组上**（不是挂在纯函数桥上）：整条提问路径产出的事件类型白名单内无 `session.status` | 结构性 |
| A10 | `isSecret:true` → 输入框 `type="password"`；**两个不同长度**的自由文本答案产出**逐字节相同**的掩码，且结果不含明文任一非空子串；**反向**：`isSecret:true` 但选了结构化选项 → 显示明文标签 | 组件/model |
| A11 | `isOther` / `autoResolutionMs` 的显式忽略断言（标 `[构造]`：README 明记两者零样本） | 单元 |
| A12 | Claude 侧**行为**不变：`deriveFrozenPairs` 的 3 条既有 `toEqual` 仅因新增 `key` 字段扩写（改 3 行），**并新增一条**「`item.id` 缺席 → 答案仍按原文取到、`key` 与 question 等值」的钉子。〔rev.1 的「一行未改」承诺不成立，已按最小代价改写〕 | 既有 + 新增 |
| A13 | **双向**、且两边都从**被测代码**取值：桥实际读取的字段集 ⊆ 夹具 `propertyNames`，且夹具 `required` 的每个字段在桥里都有对应分支。（方法名的钉子在 `codex-method-contract.json` + `codexWireContract.test.ts`，与本快照无关） | 契约 |
| A14 | G1 / G2 各一条：**不发卡 + 立即回 `{answers:{}}` + 不登记 + 不产生任何 `question.resolved`**；并断言「另有一张 pending 卡时，兜底不得清它」 | 单元 |
| A15 | §3.3 守卫：`question.resolved` 携带**不匹配**的 questionId 时，`pendingQuestion` 保持原值 | 单元 |

**门禁**：lint / typecheck / typecheck:agent-host / vitest **逐门串行**（本机内存有限，链式合跑曾 OOM）。

---

## 5. 本片不做 / 已登记的遗留

**本片不做**：审批投影（切片 4）· 历史（切片 5）· flag on/off 双跑门禁（切片 6）·
`autoResolutionMs` 的客户端定时（S2 §2 #14 已裁）· 切片 2c 的三条遗留。

**本轮评审新登记的缺陷（不混进「已完成」）**：

| # | 缺陷 | 归属 |
|---|---|---|
| L1 | `pendingQuestion` 全局单槽：两会话并发提问必丢一张卡，被顶掉的那条因 `waiting_question` 恒忙而**永久不能发消息也答不了** | **与 agent 无关的既有缺陷**，另立任务（主线） |
| L2 | 渲染端 `question.requested` reducer 自己写 `waiting_question`（`chatSessions.ts:821`），与 Host 的 status mapper 构成**第二个等待态来源** | 既有，agent 无关；本片以 G1 削弱其触发面，根治另议 |
| L3 | `buildRespondPayload` 把答案折进 `Record`，Claude 侧**两道原文相同的问题会丢掉一条答案** | 既有；C8 只解决了 Codex 侧，不要误以为已关闭 |
| L4 | `autoResolutionMs` 真触发时时间线撒谎：`forgotten` → `outcome:'rejected'` → 卡显示「Questions skipped」，而模型其实拿到了自动答案继续跑 | 本片已知缺陷（协议 `outcome` 三值不够用） |
| L5 | `register()` 返回 false（服务端复用 id，属协议违规）的请求**永远没有 JSON-RPC 应答** → 回合可能永久 `waitingOnUserInput`。回帧又会产生「对第一条请求的双重回帧」 | 维持现状 + WARN 日志，两难已记录 |
| L6 | `toCodexAnswerBody` 对未答 item「整条省略」是零样本推测；若服务端报 -32602，改写 `{answers: []}` | 降级路径已备 |
| L7 | schema 快照不会自己发现漂移：**codex 版本一升级必须重跑 `generate-json-schema`** | 已写进夹具 README 与快照注释 |
