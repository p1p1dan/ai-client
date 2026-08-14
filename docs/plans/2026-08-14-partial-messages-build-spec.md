# 2026-08-14 流式施工批规格 rev.2（partial messages + #30 文案修）

> 依据：[xvqiu1 triage §4](./2026-08-11-xvqiu1-triage.md) · [spike 报告](./2026-08-11-partial-messages-spike.md) · 拍板 **D32/D33**（总台账）。
> **rev.2（双轨对抗评审后）**：Opus 4 blocker + 8 major + 11 minor / Codex 13 条，互补合取全采纳。rev.1 被推翻的要点：① 渲染端写放大未处理（rev.1 无任何措施→新增 1e Host 合并器，采 spike §5 备选，**不动 D33③ 默认 ON**）；② `message.started` 丢 model（A06 回归→1b 新增 message_start 捕获）；③ OFF 位「逐字节相同」与 token 通道自相矛盾（→token 通道挂 gate）；④ 去重零候选/index 跨消息复用未定义（→closedBlocks + message_start 清空 + 三路匹配，零候选**照发**）；⑤ 雷 B 一刀删导致 tool 孤儿行（→pendingToolStub 内部记账 + 兜底补发）；⑥ 「前缀兜底」仅覆盖尾部截断，中间丢包属 append-only 固有限制（改名 + 书面记录）。评审原文：Opus 见任务输出 / Codex session `019fff95-8685-79a1-9190-5e62b369a716`。

## 分片与施工顺序（评审裁定：0 → 2 → 1 → 3，片间过门禁）

| 片 | 内容 | 档位 | 文件 |
|---|---|---|---|
| 0 | #30 文案修（D32）+ `history_unsupported` 接通 | S | `historyError.ts` + `MessageTimeline.tsx:589` |
| 2 | 诊断事件折叠环（先行——它是 partial 位的取证工具） | S | `ChatComposer.tsx` + 新 `eventRing.ts` |
| 1 | Host：flag + partial + 去重状态机 + 工具记账 + token 通道 + delta 合并器 | M+ | `claudeRuntime.ts` `eventNormalizer.ts` |
| 3 | 实时状态行（D33 形态）渲染端半 | M | `turnStatus.ts` `contextSurfaceModel.ts` `messageMetadata.ts` `sessionRuntimeFacts.ts` `MessageTimeline.tsx` |

## 片 0 —— #30 文案修（D32：只改文案不改行为）

1. `HistoryErrorView`（`historyError.ts:18-33`）加必填 `continuationHint: string`；`CODE_COPY` 每条目补该字段（注意 `HistoryErrorCopy` 是 `Omit<HistoryErrorView,…>` 类型别名而非 interface——字段加在 View 上即自动进 Copy；`parseHistoryError` 的 `...CODE_COPY[code]` 展开已天然透传，无需改）。
2. 新常量 `HISTORY_ERROR_DEAD_SESSION_HINT`：`'该会话已无法继续：历史文件缺失后，继续发送会因「No conversation found」失败；请新建会话继续工作。'`——`jsonl_not_found` 专用。**guidance 同步改**（评审：旧文案「以下只有本次的新消息」暗示可发消息，与新 hint 自相矛盾）：改为 `'恢复该会话时未找到它的历史文件（JSONL），历史消息没有载入。'`；`severity` 由 `warning` 抬 `error`（死会话按错误分级；台账记为 D32 执行细化）。
3. `encrypted_unreadable` 的 hint **不得承诺成功**（两轨合取：「CLI 可 resume 加密历史」是未验证假设，与 #30 同类）：`'会话或仍可继续发送；若发送同样失败，请新建会话。'`。`read_failed` / `history_unsupported` / `unknown` 沿用 `HISTORY_ERROR_NON_FATAL_HINT`（常量保留）。
4. `toCode()`（`:79-82`）**学会 `history_unsupported`**（否则五 code 断言表因折叠 `unknown` 而假绿——`:61-65` 注释自证不可达）。
5. `MessageTimeline.tsx:589` 改渲染 `view.continuationHint`。
6. **不改**：句柄清理 / fork / 按钮 / retryable。

测试（`__tests__/historyError.test.ts` 扩展）：五 code 断言 `view.code === 入参 code` **且** hint 逐字匹配（不许只断四个非 jsonl code 共享同一串）；**变异 ③**：`jsonl_not_found` hint 换回 `NON_FATAL_HINT` → 红；`toCode('history_unsupported')` 折回 `unknown` → 红。

## 片 2 —— 诊断事件折叠环（rev.2 推翻 rev.1 的扁平尾环）

评审否决扁平尾环：`ChatComposer.tsx:1213` 的消费者（create-timeout 诊断）要的是**最早**事件；partial 位 300 格尾环里只剩 `message.delta` ×300，证据全毁。

改法：新纯模块 `src/renderer/components/chat/eventRing.ts`——**折叠环**：
- `push(s)`：与环尾**同字符串**的连续项折叠为计数（快照渲染 `type ×N`）；高频类型白名单（`message.delta` / `thinking.delta` / `usage.updated`）**恒折叠**（首条 + 计数）。
- 头窗保留：前 50 条（折叠后计）永不逐出；其后尾环 cap 250（折叠后计），逐出计入 `dropped()`。
- `snapshot(): string[]`、`dropped(): number`；join 时 `dropped() > 0` 前缀 `…(N earlier events dropped)`。
- ChatComposer `:1021/:1107/:1213/:1692` 三处接线。

测试：新 `eventRing.test.ts`——折叠正确性（`a,a,a,b` → `['a ×3','b']`）、头窗存活（推 10k 条后前 50 仍在）、dropped 诚实计数；变异：头窗保留删除 → 「create-timeout 场景首事件仍在快照」断言红。
**顺带核对项改钉 store 壳**（评审 #6：reducer 返回原引用挡不住 zustand 逐事件通知）：`sessionRuntimeFacts.ts:48-50` 改 `set((state) => { const next = reduce(...); return next === state.factsBySession ? state : { factsBySession: next }; })`——**返回 `state` 本身**才跳过通知；测试钉「无关事件零通知」（subscribe 计数）。

## 片 1 —— Host 核心（rev.2 状态机）

### 1a. flag + options（不变）

`resolveHostPartialMessagesEnabled()`：env `AICLIENT_HOST_PARTIAL_MESSAGES`，默认 ON（D33③；仅 `'0'` off），逐字仿 `:142-146`；options 加 `...(enabled ? { includePartialMessages: true } : {})`。normalizer 不接 flag（事实判据见 1b）。

### 1b. 去重状态机（rev.2）

`NormalizerState` 新增：
- `partialContentSeen: boolean` —— **置位条件收窄**（评审：`message_start` 这类非正文 stream_event 会提前开闸）：仅在主代理 `content_block_start(text|thinking)` 或对应 delta 建立累积器时置 true。置位代码必须位于 `:889` parent 丢弃 **之后**（测试钉序）。
- `openBlocks: Map<number, { type: 'text'|'thinking'; acc: string }>`、`closedBlocks: 同型数组`（stop 后移入，供「整条在 stop 后到达」的降级匹配）。
- `pendingToolStubs: Map<string, { name: string; inputJsonAcc: string }>`（见 1c）。

事件流转（`stream_event` 分支）：
- **`message_start`**（新增处理，三职并一）：① `state.assistantModel ??= ev.message?.model`（**评审 blocker：不捕则 ON 位 `message.started` 永失 model，A06 回归**——此行须早于任何 `ensureAssistant`）；② 清空 `openBlocks`/`closedBlocks`（**index 每条 API 消息从 0 重启**，不清则跨消息污染）；③ 不置 gate。`msg.event` 内联类型扩 `message?: { model?: string }`。
- `content_block_start(text|thinking)`：建累积器 + 置 `partialContentSeen` + 现有 `ensureAssistant` 保持。
- `content_block_delta(text_delta|thinking_delta)`：`acc +=` 后照常发射（`:908-916` 不动）。`signature_delta`/`input_json_delta` 不发射（测试断言打在 **delta 类型分派**上：这两类不得进入 text/thinking 发射器，防未来 SDK 附带 `text` 字段从 `:913` 漏出）。
- `content_block_stop`：累积器移入 `closedBlocks`（不丢弃）。

整条 `assistant` 分支（`partialContentSeen === true` 时）：`extractTextParts`/`extractThinkingParts` 的拼接结果与候选对账，**匹配顺序**：同型开放块 → 同型未配对 `closedBlocks` → **零候选 → 照常发射 + log**（评审：跨消息网关中途停止履约时，静默丢弃 = 丢最终答案，比重复严重）。对账三态：
- `acc === 整条` → 丢弃（常态）；
- `整条.startsWith(acc)` → 只发缺失后缀——**定名「尾部截断兜底」**：它只覆盖尾部丢失；**中间 delta 丢失**（acc=`abcghi` vs 整条 `abcdefghi`）落入失配 → 弃整条 + log，已发残文无法回滚——**append-only 协议固有限制，书面接受**（评审 Codex #1），log 行含 acc 长度/整条长度供真机诊断；
- 同型开放块 ≥2（协议上不可达）→ **log + 照发**（当不变量违规告警，不做静默丢弃路径）。
`partialContentSeen === false`（OFF 位 / 网关不履约 / 只发过 message_start）→ 现行路径逐字不动。

### 1c. 工具记账（rev.2：抑制渲染但不丢信息）

- `content_block_start(tool_use)`：**不发** `tool.started`（雷 B），改写入 `pendingToolStubs`（id→name，`inputJsonAcc: ''`）。
- `input_json_delta`：追加进对应 stub 的 `inputJsonAcc`（按当前开放 tool 块 index 关联）。
- 整条 assistant 的 tool_use：照常 `emitToolStarted`（真入参；`seenTools` 去重天然防双发）+ 清 stub。
- **孤儿兜底**（评审 Codex #5：整条缺失时 `tool.completed` 无 started 配对）：`user` 分支处理 `tool_result` 时，若 `toolCallId` 不在 `seenTools` 且在 `pendingToolStubs` → 先用 stub 补发 `tool.started`（name 取 stub，input 取 `JSON.parse(inputJsonAcc)`，parse 失败用 `{}`）再走 completed。
- 看门狗依赖显性化：stub 期 `hasOpenTools()` 为假，无害**完全依赖** `'stream_event' ∈ PRODUCTIVE_EVENT_TYPES`（`claudeRuntime.ts:671-677`）——**变异测试**：从集合移除 `'stream_event'` → partial fixture 触发看门狗断言转红。

### 1d. token 通道（rev.2：挂 gate + 单调 + 哨兵）

状态：`turnOutputTokensSettled`、`turnThinkingEstimate`、`turnTokensDisplayMax`（单调峰值）、`lastInterimUsageEmitMs: number | null`（**null 哨兵：首条无条件发**——评审：0 初值遇 mock 时钟 0/10/20 假绿成零发射）。

- `system/thinking_tokens` 分支：**仅当 `partialContentSeen`**（评审 blocker：不挂 gate 则 OFF 位零回归断言被 control 位今天就有的 thinking_tokens 证伪）：`turnThinkingEstimate += msg.estimated_tokens_delta ?? 0`。`msg` 内联类型扩 `estimated_tokens_delta?: number`。
- `stream_event message_delta`：`turnOutputTokensSettled += ev.usage?.output_tokens ?? 0`；`turnThinkingEstimate = 0`；**恒发**（不限流）。类型扩 `usage?: { output_tokens?: number }`。
- `content_block_stop(thinking)`：强制发一次 interim（**尾发**——思考→正文转换点不丢最后的滴答）。
- 发射：`display = Math.max(turnTokensDisplayMax, settled + estimate)`（**单调不倒退**——评审：子 agent thinking_tokens 无 parent 标记会混入 estimate，主流 message_delta 清零时数字回退）；更新峰值后发
  `{ type: 'usage.updated', sessionId: this.sessionId, requestId, payload: { interim: true, turn_output_tokens_display: display } }`（**sessionId/requestId 必带**——评审：缺 sessionId 时 `reduceSessionRuntimeFacts` 直接丢弃）。
- 限流 250ms（thinking_tokens 路）；`message_delta` 阶跃与 thinking 尾发不限流。
- `result` 分支 `:1012-1019` 逐字不动（终值路径）。**正文期数字按消息阶跃（冻结），书面接受**——spike §5：正文期无逐 token 滴答源；字节估算路径留另批。

### 1e. Host 侧 delta 合并器（rev.2 新增——评审 blocker #1 的规格内解法，D33③ 默认 ON 得以维持）

问题：partial 位 1.3~2.2 万事件/回合 × 渲染端红线 store O(n²) 文本拼接 × 逐事件 IPC（`src/main/ipc/chat.ts:20` 结构化克隆）——spike §7.4 自认两跳成本未测。spike §5 明令「Host 侧 40~60ms 合并作为备选不要删」——本批落地为**常开组件**（仅 partial 路径）：

- 位置：`EventNormalizer` 的 emit 出口包装（`CoalescingEmitter`，独立纯类可测）。
- 规则：**仅当 `partialContentSeen`** 启用；`message.delta`/`thinking.delta` 同 `blockId` 连续事件在 **45ms 窗**内文本拼接为一条；**任何异类事件到达 → 先 flush 缓冲再放行**（严格保序）；窗到期（`setTimeout` 保底）flush；`result`/`session.failed`/turn 结束强制 flushAll。
- OFF/control 路径直通零改动（gate=false 时旁路，黄金零回归不受影响）。
- 预算断言：合并后 partial fixture 的下游事件数 ≤ 原始 `stream_event` 数的 1/3（数量级门禁，防合并器被静默旁路）。
- 测试用 vitest fake timers；保序断言：`delta → tool.started → delta` 序列合并后相对顺序不变。

### 片 1 测试矩阵（rev.2 = rev.1 + 两轨负控全量）

1. flag 三态（OFF 反断言 `not.toHaveProperty('includePartialMessages')`，`:1163` 先例）。
2. Happy Path（摘录 A 复刻）：文本恰一份 / delta ≥3 / `tool.started` 恰 1 条真入参 / `message.started.payload.model` **非空**（评审 blocker #2 的钉子）。
3. thinking 对照（摘录 B）：恰一份；`signature_delta`/`input_json_delta` 不进发射器（按 delta 类型断言）。
4. 尾部截断兜底：恰发后缀一条；**中间丢失负控**：acc 失配 → 整条被弃 + log 被调（不发）。
5. 跨消息：两条 API 消息（摘录 A 全序列）→ 第二条正文完整；**stop 缺失 + 下一消息 index 复用** → 第二条不被截断；**整条在 stop 后到** → closedBlocks 匹配仍去重；**零候选（message_start 后直接整条）** → 照发。
6. gate 收窄：仅 `message_start`+整条 → 走整条路径（不吞）；parent-set stream_event 不置 gate（钉 `:889` 先序）。
7. 工具：stub 不发 / 整条发真入参 / **孤儿兜底**（无整条 + tool_result → 补发 started（input 来自拼接 partial_json）→ completed 配对）/ PRODUCTIVE_EVENT_TYPES 变异（去 `'stream_event'` → 看门狗断言红）。
8. token：首发无条件（null 哨兵）/ 10ms×3 → 恰 1 **且** 300ms×3 → 恰 3（双向）/ message_delta 恒发 / thinking 尾发 / **单调**（子 agent 混入 + message_delta 清零 fixture → 显示值永不下降）/ `51+30=81` 两消息累加 / interim 带 sessionId / result 终值**完整 payload + 事件顺序**逐字断言（`thinking.completed → message.completed → usage.updated → session.completed → session.status`）。
9. 合并器：窗内合并 / 异类 flush 保序 / 事件数预算 / control 旁路。
10. **OFF 位黄金零回归**（评审两轨合取的仪式）：黄金 JSON 由**父提交（改造前）代码**对同一 fixture 生成并入库（`vi.setSystemTime` 冻结时钟消除 `Date.now()` 型 id 漂移）；测试对完整事件数组深相等；配变异（任一 emit 字段改动 → 红）。**黄金文件必须在动生产代码之前的独立提交里落库**。
11. 变异对全量：相等即丢弃翻转 / stub 恢复 / 尾部兜底翻「发整条」 / message_start 清空删除 / 零候选翻「丢弃」 / interim 卫删除 / PRODUCTIVE 去 stream_event / 合并器旁路 → 各自指定断言转红，施工提交附实验记录。

## 片 3 —— 实时状态行（rev.2）

### 3a. turnStatus 纯函数

- `TurnStatusInput` 加 `outputTokensDisplay?: number | null`；streaming 分支：`formatElapsedClock(elapsed)` + 有值时 ` · ↓ ${formatTokenCount(n)}`；`TURN_STREAMING_VERB` 删除。**`✽` 字形不进纯模块**（评审：`turnStatus.ts:13-16` 自述文案/装饰分层）——由 `.tsx` 层（TurnStatusContent，`MessageTimeline.tsx:1269`）为 `kind === 'streaming'` 加前缀。
- `formatElapsedClock`（`42s` / `19m 55s`）与 `formatTokenCount`（`850` / `38.5k`）：JSDoc 写明 streaming 分支时钟格式独立于 `composerSendingLine` 的豁免理由（D33 拍板形态）+ 估算值不作计费展示。

### 3b. 数据链（评审 #5/#9 rev）

- `contextSurfaceModel.ts` reducer：`usage.updated && payload.interim === true` → 写 `turnTokensDisplay`；`session.status(idle|failed)` **与 `message.completed`** 清 null；会话条目沿用既有 `STDERR_SESSIONS_MAX` 同款上限治理（`:396-404` 先例）。
- `messageMetadata.ts:139` 卫（**必需**）：`payload.interim` → `return prev`；测试两步：interim → result 后 `usage` 深等于 result payload 且**不含** `interim`/`turn_output_tokens_display` 键（评审：合并语义使污染键永存且当前无渲染点可暴露）。
- **订阅位置：`MessageTimeline` 父组件顶部**（`:180` 区），窄 selector 取当前 session 的 primitive；`ChatTurnProps` 扩 `outputTokensDisplay`；传值 **`isLastTurn ? value : null`**（逐字仿 `nowMs`/`retry` 先例 `:431/:454`——评审两轨同判：塞进 memo 的 ChatTurn 内订阅 = 每 250ms 打穿全部历史轮）。
- 接线静态测试：token 连续变化时仅最后一轮 prop 变化；idle 与 failed 两条清零路径分别覆盖；变异：清零删除 → 红。

## 施工纪律（rev.2 追加机械门禁）

- **vitest node import 红线机械化**（评审两轨同判「口头纪律防不住」）：片 0 随批新增静态测试（如 `__tests__/pureModuleImports.test.ts`）：读 `turnStatus.ts` / `historyError.ts` / `eventRing.ts` / `contextSurfaceModel.ts` 源码，命中 `from 'react'` / `from '@/stores` / `settings` import → 失败。
- 四门逐门串行（OOM 纪律）；片间过门禁再进下片。
- 提交拆分：黄金文件提交（改造前）→ 片 0 → 片 2 → 片 1 → 片 3，各附变异实验记录。
- 回滚保险：`AICLIENT_HOST_PARTIAL_MESSAGES=0` + 黄金零回归 = 今日行为。

## 验收汇总

ON 位（摘录 A+B fixture）：文本/思考恰一份、`tool.started` 恰 1 条真入参且 model 非空、interim token 单调滴答（≤4/s + 阶跃 + 尾发）、下游事件数 ≤ 原始 1/3；网关退化矩阵（中途停履约 / 只发 message_start / stop 缺失 / 整条后到）零静默丢正文；OFF 位与父提交黄金深相等；`jsonl_not_found` 卡不再承诺可继续，`history_unsupported` 可达自身文案。
