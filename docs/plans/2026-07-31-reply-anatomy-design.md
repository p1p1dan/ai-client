# 回复解剖（状态段 / 折叠壳 / 尾部状态条）与置顶用户气泡 · 施工规格

> 立项来源：第四轮 GUI 点验第 **6** 条与第 **7** 条（用户原话见 §0.2）。
> 参照素材：`docs/design/refs/feedback-20260731-round4/`
> · `ScreenShot_2026-07-31_135656_634.png`（回合**默认收起**态：用户气泡 → `Worked for 1m 6s` → 最终答案 → 右下 `3h ago` + fork/copy）
> · `worked for xx s展开后.png`（**展开**态：`Worked for 1m 6s ⌄` → `Thought for 1s >` → 中间正文 → `Explored SKILL.md, 1 search` → 正文 → 聚合行 → …… → 最终答案）
> · `7dd04b57-…png`（暗色工具卡：圆点状态 + `Bash` 标题行 + 描述 + IN/OUT 块 —— **非本仓口径**，见 §10-E）
> 本规格**只定回复区的结构与状态归属**，不碰 Flexoki 调色板、不碰 token 分档、不碰 Markdown 渲染（归 T-29）、不碰 Composer 形态（归 T-30 批2）。

> **as-built 注记（2026-08-03 落地）**：本批（T-31）代码落地日期 2026-08-03。§9 六项可拍板点（δ/ε/ζ/η/θ/ι）**全部按推荐值实装**，其中 **η**（`scroll-state()` 容器查询截断方案）已由探针 `src/agent-host/spikes/scroll-state-probe.js` **实测坐实**（Electron 39 / Chromium 142.0.7444.235 支持，非知识推断）。§4.5「`ran N command(s)` 聚合计数」**撤回未落地**——与 `:1769-1772`「action 恒独立行」的既有裁定冲突，复议需先修订基线，规格文本按有意不对齐处理（A06）。§4.3「恢复历史回合默认收起」经由头槽**四级降级链**（状态段 → `Worked for` → 纯统计行 → 无文字 chevron）达成——原文假设的 latency 数据源（T-06 metadata）在历史回放路径下并不存在，直接判空会使折叠壳无触发器、被迫强制展开，降级链补上了这个缺口。双轨复核（Opus + Codex 独立对抗）+ 修复批合计 **15 项**，明细见主线台账 [`ledger-claude-mainline.md`](ledger-claude-mainline.md) 2026-08-03 T-31 行。

---

## 0. 一句话结论与口径锚点

### 0.1 一句话结论

**用户第 6 条与第 7 条要的不是两个独立特性，而是同一个缺失结构的两个侧面：本仓的时间线里根本没有「回合」这个层级。**
现状是 `sessionMessages.map(message => <MessageBubble/>)`（`MessageTimeline.tsx:209-221`）——一条**扁平消息列表**，user 气泡与 assistant 消息只是两个并列兄弟节点，没有任何东西把「这条提问」和「它的回复」括在一起。
于是：**状态读条**没有回合可挂（只能寄居在 Composer 卡内）、**`Worked for Ns ⌄`** 没有回合体可折叠（只能退化成一行统计）、**置顶气泡**没有回合边界可判定何时释放锚定。
⇒ 本规格的主体是引入一个 `ChatTurn` 分组层。这个分组是**纯函数可推导、node 环境可断言**的（`groupMessagesIntoTurns`），三条需求随之各自落到它的一个槽位上。

### 0.2 用户口径锚点

- **第 6 条**：「waiting for agent host reply 这一类等待读条应该是放在工具栏（显示 agent 回复的地方）。总的来说 agent 回复应该是这样几个部分：状态：Generating/waiting for reply 等等；Thinking；流式输出；工具调用：Bash/Read 等；thinking；工具调用；输出（完毕）；状态条，显示耗时，使用的模型，copy 按钮等。」
- **第 7 条**：「在滚动查看回复时，agent 回复对应的用户输入是以气泡形式固定显示在聊天页上端的。」

---

## 1. 现状实查

### 1.1 状态读条现在渲染在哪（第 6 条的前提事实）

| 环节 | 锚点 | 事实 |
|---|---|---|
| 文案生成 | `chat/attachments.ts:314-347` `composerSendingLine()` | 纯函数，四分支：`Starting Agent Host… · Ns`（handshake）/ `Waiting for Agent Host reply · Ns (up to 45s)` / `Sent {size} · waiting for reply · …`（有附件）/ `Still waiting · Ns — gateway latency varies. Stop to abort.`（≥ `SLOW_WAIT_HINT_SECONDS`=45，`attachments.ts:296-297`） |
| 网络重试 | `attachments.ts:336-338` | `· Network retry {attempt}/{maxRetries}` 作为**后缀**拼进上面同一条字符串；数据源 `activeSession?.retry`（`chatSessions.ts:67-73`），在 `ChatComposer.tsx:1459-1465` 读取 |
| 组装 | `ChatComposer.tsx:1449-1467` | `statusLine` 三选一：sending 走 `composerSendingLine`、否则 `largeHint`、否则 `statusHint` |
| 显隐判据 | `middleColumnLayout.ts:186-197` `shouldShowStatusLine()` | 四条件任一真则显（sending / reading>0 / hasStatusError / hasLargeHint；empty 态现为恒真，T-30 批2 已裁定改判据） |
| 渲染 | `ChatComposer.tsx:1490-1502` `renderStatusLine()` | `<div>{Spinner}<p class="min-w-0 truncate text-xs tabular-nums">{statusLine}</p></div>` |
| 挂载点 | `ChatComposer.tsx:1905`（session）/ `:1918`（empty） | **在 Composer 卡内、与 textarea / 模型选择器 / 圆形动作键同一条 flex 行**（session 态即那条 42px 单行的中段） |
| 与时间线的关系 | `ChatWorkspace.tsx:112-130` | `<section>` 下依次是 `HostStatusBanner` → `MessageTimeline`（:116）→ `PendingQuestionDock`（:123）→ `middleColumnHostClass(mode)` 包裹的 `ChatComposer`（:124-130）。**Composer 是时间线的后继兄弟节点，整体在 `ScrollArea` 之外** |

> **确认第 6 条的诊断成立**：等待读条现在既不在「显示 agent 回复的地方」，也不随回复滚动——它被压在一条 42px 高的输入行里，与模型名、发送键抢同一行的横向空间（`truncate` 一到就被截断）。

TTFT 看门狗（`src/agent-host/ttftWatchdog.ts`）是 **Host 侧**逻辑，渲染层没有专属标识文案；它的效果只通过上面同一条 `retry` / `lastError` 管线露头。`sawNetworkRetry`（`ChatComposer.tsx:819,852-854`）在超时后被写进 `lastError` 诊断串（`:1213-1226`），最终由 `MessageTimeline.tsx:223-252` 的会话级失败块打印。

### 1.2 时间线现状结构（第 6/7 条的共同前提）

```
MessageTimeline.tsx:177  <div class="flex min-h-0 flex-1 flex-col" ref={scrollRootRef}>
              :188        <ScrollArea class="min-h-0 flex-1" scrollFade>       ← 唯一滚动容器
              :191          <div class={TIMELINE_PADDING_CLASS} ref={contentRef}>   ← 'px-6 pt-5 pb-2'（middleColumnLayout.ts:93）
              :193            <ReadingColumn class="space-y-5">                ← mx-auto + 阅读栏宽（ReadingColumn.tsx:18-21），回合间 20px
              :194              [HistoryErrorNotice]
              :209              {sessionMessages.map(m => <MessageBubble key={m.id} …/>)}   ★扁平，无回合分组
              :223              [status==='failed' 会话级失败块]
```

- `MessageBubble`（:398-484）按 `role` 三分：`assistant` → `AssistantMessage`；`system`/`error` → `NoticeMessage`（:493-508，走 `Alert` 原语）；`user` → 就地 `<article class="flex justify-end">` + 气泡（:427-483）。
- `AssistantMessage`（:529-618）渲染序：`buildWorkedForRow` 产出的单行 `ToolGroup`（**:556**）→ `groupTimeline(message)` 的 items（`text` / `toolGroup` / `permission` / `question`）→ `footerLine`（**:611-615**）。外层 `<article class="flex flex-col gap-2.5">`（:555，P-17 的「段间 10px」单一来源）。
- 滚动跟随：`stickToBottomRef`（:117）+ 滚动监听（:123-135，判据在 `messageTimelineScroll.ts:shouldStickToBottom`）+ `ResizeObserver` 把 `viewport.scrollTop = viewport.scrollHeight`（:155-166）。
- **`MessageTimeline.tsx:178-187` 的 Round-2 V-b 注释明确记载：此视口之上不存在任何 sticky/fixed/absolute 元素**（已审计 MessageTimeline / ChatWorkspace / HostStatusBanner / WindowTitleBar）。这是第 7 条实现的**关键前提**，也是唯一一处需要与历史裁定正面对齐的地方（§7.4）。

### 1.3 已有件盘点（避免重复造）

| 件 | 状态 | 锚点 |
|---|---|---|
| `Worked for Ns` 行 | **已有**。`WORKED_FOR_VERB`（`turnTiming.ts:122`）、`formatWorkedForRow(latencyMs)`（`:134-138`，`latencyMs==null` 返回 `null`，**从不硬造秒数**）、`deriveTurnStats(message)`（`:150-164`）；组装 `buildWorkedForRow`（`MessageTimeline.tsx:634-648`），挂载 `:556` | 语义需改（§4） |
| `Thought for Ns` 折叠行 | **已有**。`formatThoughtRow`（`turnTiming.ts`）+ `thinking` 块经 `groupTimeline` 进 `ToolGroup` | 合规 |
| 工具行（动词 + arg 灰阶单行，无图标无边框无圆点） | **已有并合规**。`ToolRows.tsx:62-99`；失败行 `text-destructive`（:65-67） | 合规 |
| 工具**聚合**行 | **已有**。`AGGREGATE_VERB = {done:'Explored', running:'Exploring'}`（`toolCard.ts:323`），`deriveAggregateRow`（`:456`），聚合判据在 `:392-393` | 词形需小扩（§4.5） |
| 逐行可展开（IN/OUT） | **已有**。`ToolRows.tsx:81-97` 每行独立 `<Collapsible defaultOpen={view.failed}>`；body 三型 `output`/`detail`/`thinking`+`stats`（`:201-240`） | 合规 |
| **回合级折叠壳** | **缺失**。`ToolGroup`（`ToolRows.tsx:39-52`）只是 `<div class="flex flex-col gap-1">`，**没有任何组级折叠** | 需建（§4） |
| 尾部 meta 行 | **已有但不足**。`formatMessageMetadata(metadata,{omitLatency:true})`（`MessageTimeline.tsx:547`）→ `Sonnet · 10:30`，渲染在 `:611-615` | 需改（§4.6） |
| **copy 按钮** | **缺失**。全 chat 目录零 `navigator.clipboard.writeText`；`StatusLine.tsx:157` 的 `Copy Path` 是工作区路径复制，无关 | 需建（P-34） |
| **状态段** | **缺失**（现寄居 Composer，见 §1.1） | 需迁（§3） |
| **回合分组 / 置顶气泡** | **缺失**（扁平列表，见 §1.2） | 需建（§5） |

### 1.4 测试环境约束（决定断言形态）

`vitest.config.ts`：`environment: 'node'`，`include: ['src/**/__tests__/**/*.test.ts', …]` —— **只匹配 `.test.ts`，不匹配 `.test.tsx`**，且无 jsdom。
⇒ **任何需要渲染 / 需要真实 DOM / 需要滚动的行为都无法断言**。本规格的全部断言（§6）必须落在纯函数与类名字符串上；`.tsx` 接线与 CSS sticky 行为只能 inspection-verified + GUI 点验，这一点与 T-19 的既有先例（`runSend` 接线不变量注释入码）一致。

---

## 2. 目标序列 → 现有件的逐段映射

用户第 6 条给的目标序列，逐段落到本仓：

| # | 用户口述段 | 参照图对应 | 现有件 | 判定 |
|---|---|---|---|---|
| ① | **状态**：Generating / waiting for reply | （运行态未截到；Cursor 完成后此位为 `Worked for 1m 6s`） | `composerSendingLine()` 文案**已有**，但渲染在 Composer 卡内 | **已有需迁**（§3） |
| ② | Thinking | `Thought for 1s >` | `thinking` 块 → `formatThoughtRow` → `ToolRow` | **已有并合规** |
| ③ | 流式输出 | 展开图第 1 段正文 | `text` 块 → `<p class="whitespace-pre-wrap">`（`MessageTimeline.tsx:562-568`） | **已有并合规**（Markdown 渲染归 T-29，不在本规格） |
| ④ | 工具调用（Bash / Read 等） | `Explored SKILL.md, 1 search` 灰字聚合行 | `ToolRow` + `deriveAggregateRow` | **已有并合规**；词形小扩见 §4.5 |
| ⑤ | thinking → 工具调用 → …… 交替 | 展开图正文/聚合行交替 4 轮 | `groupTimeline(message)` 按块序原样输出 | **已有并合规** |
| ⑥ | 输出（完毕） | 收起图里恒可见的最终答案 | 同 ③ | **已有**，但需与「过程段」切分（§4.4） |
| ⑦ | **状态条**：耗时 / 模型 / copy | 右下 `3h ago` + fork + copy | `formatMessageMetadata` 给 `模型 · 时刻`；**无 copy**；**无耗时**（耗时按 A07 `:1871` 已搬到回合顶部） | **已有需改**（§4.6） |
| ⑧ | （用户未点名但参照图有）**`Worked for Ns ⌄` 折叠整段过程** | 收起图 vs 展开图的差集 | `Worked for Ns` 行**已有**，但展开的是**统计文本**不是过程段 | **已有需改语义**（§4.2，A07 修订） |
| ⑨ | （第 7 条）**置顶用户气泡** | 收起/展开两图顶部的方框气泡 | 无 | **缺失需建**（§5） |

**结论**：九段里 **四段已有且合规**、**三段已有需改**、**两段需建**。第 6 条读起来像一次大改造，实测下来本仓的**块序与渲染件早就对齐了 Cursor**（T-05 的功劳），真正缺的是**回合这一层容器**和挂在它上面的三个槽位。

---

## 3. 裁定 A · 状态读条的归属

### 3.1 归属规则（本规格的核心判据）

> **描述「在飞的这个回合」的状态，属于回合；描述「手上这份草稿」的状态，属于 Composer。**

按这条规则逐条切分现有 `statusLine` 的四个来源：

| 现有来源 | 内容举例 | 归属 | 依据 |
|---|---|---|---|
| `composerSendingLine()` 的 handshake 分支 | `Starting Agent Host… · 3s` | **回合** | 描述这一轮的建链进度 |
| `composerSendingLine()` 的 awaiting / 附件 / 慢等待分支 | `Waiting for Agent Host reply · 12s (up to 45s)` · `Still waiting · 62s — …` | **回合** | 用户第 6 条点名 |
| `retry` 后缀 | `· Network retry 3/10` | **回合** | 它解释的是这一轮为什么慢 |
| `attachments.reading > 0` | 附件读盘中 | **Composer** | 描述草稿，此时还没有回合 |
| `largeHint` | 大附件提示 | **Composer** | 同上 |
| `statusHint` | 无会话 / 无工作区 / 无 cwd | **Composer** | 描述输入前置条件，与任何回合无关 |
| `hasStatusError` 的错误着色 | 发送失败 | **两处**：Composer 保留可重试提示（`deriveActionButtons` 的 Retry 与之配套），回合头显示该回合的失败态 | A06：失败必须在**用户下一步操作发生的地方**可见 |
| 队列 strip（T-19） | `Queued N — …` | **Composer** | 排队消息尚未成为回合 |

### 3.2 迁移方式（不复制字符串）

- **不新建文案**。回合头的字符串仍由 `attachments.ts:composerSendingLine()` 生成——它已被 `attachments.test.ts:334,411` 逐字断言，复制一份等于把两处字面量放进未来的漂移风险里。
- 新建 `turnStatus.ts`，导出 `deriveTurnStatus(input) → { kind, text } | null`，内部**调用** `composerSendingLine`。`kind` 用于着色与是否转圈：`'handshake' | 'awaiting' | 'streaming' | 'slow' | 'retrying' | 'failed'`。
- `ChatComposer` 侧只删掉 sending 分支对 `renderStatusLine` 的供给（`ChatComposer.tsx:1449-1467` 的三选一降为二选一），`shouldShowStatusLine()`（`middleColumnLayout.ts:186-197`）的 `sending` 条件随之移除。**`shouldShowStatusLine` 的其余三条件与 T-30 批2 对 empty 分支的改判并行不悖**（两批都改这个函数 ⇒ 见 §8.2 的定序理由）。
- 函数名 `composerSendingLine` 迁移后名不副实。**本规格不改名**：改名会同时动 `attachments.ts` / `attachments.test.ts` 的两处字面断言，收益为零。改为在函数头补一行注释说明「其唯一消费者已迁至回合头」。

### 3.3 迁移后 Composer 的信息不丢核对（A06 硬要求）

| 迁走的信息 | 迁后可达路径 | 判定 |
|---|---|---|
| 「正在等待」这一事实 | 圆形动作键切为 **Stop**（`deriveActionButtons`，形态不变）+ 回合头状态段 | ✅ 双通道 |
| 已等待秒数 / 45s 预算 | 回合头状态段（**更醒目**：从 42px 行的中段截断文本，变成阅读栏满宽一行） | ✅ 净增益 |
| `Network retry N/M` | 同上 | ✅ |
| Spinner | 回合头状态段自带（`Spinner size-3.5 text-muted-foreground`，形态照搬 `ChatComposer.tsx:1496`） | ✅ |
| 运行中 placeholder 文案矩阵（`composerPlaceholder()` 九分支） | **一字不动** | ✅ Composer 仍自述「运行中你可以继续输入」（T-19） |

---

## 4. 裁定 B · 回合分段与折叠

### 4.1 回合分组（`groupMessagesIntoTurns`）

```
Turn = {
  id: string;                    // 锚定用；取 user 消息 id，无 user 时取首条消息 id
  user: ChatMessage | null;      // null = 孤儿回合（恢复的历史从 assistant 开头 / 纯通知）
  body: ChatMessage[];           // 该 user 之后、下一个 user 之前的全部消息
}
```

分组规则（纯函数，`chatTurn.ts`）：

| 规则 | 处置 | 理由 |
|---|---|---|
| `role==='user'` | **开一个新 Turn** | 一次提问 = 一个回合 |
| `role==='assistant'` | 并入当前 Turn 的 `body` | |
| `role==='system'` / `'error'` | 并入当前 Turn 的 `body` | 它们是**关于这一轮**的通知（`NoticeMessage`），跟着回合走才不会在折叠/置顶时错位 |
| 首条消息不是 user（恢复历史 / 纯通知开头） | 开一个 `user:null` 的孤儿 Turn | 不得丢消息 |
| 连续两条 user（T-19 队列连发） | **各开一个 Turn**，第二个 `body` 可为空直到回复到达 | 队列语义要求两条提问各自可被锚定 |
| `body` 为空的 Turn | 合法（正在等待首个 assistant 消息） | **状态段正是为这个窗口存在的** |

> 分组是**纯推导**，不引入任何新的 store 字段、不改 `chatSessions.ts`（红线文件零改动）。

### 4.2 `Worked for Ns ⌄` 的语义修订（A07 修订项，须登记）

| | A07 v3 现行裁定 | Cursor round-4 实测（结构） | 本规格 |
|---|---|---|---|
| 位置 | 回合最上方（`:1871`「回合时长搬家」，footer 时长删掉） | 同 | ✅ 沿用 |
| 展开体 | **统计文本**：`3 次工具调用 · 11 次搜索 · 1 次编辑 · 首字延迟 1.2s`（`:2413-2419`，实现 `deriveTurnStats`） | **整个过程段**：Thinking + 工具行 + 中间正文（收起图与展开图的差集即此） | **改判为「过程段」** |
| 最终答案 | （无此概念） | **恒可见**，不随折叠消失 | 采纳 |
| 默认态 | 实现现为不可折叠外的常显 | 收起（`135656` 即默认态） | 有条件收起，见 §4.3 |

**改判理由**：A07 v3 定义展开体为统计，是因为 v2 参照图只截到了收起态，无法看出展开的是什么；round-4 的两张图（同一回合的收起/展开）第一次给出了**差集**，证明它折的是过程。这属于**证据补全后的口径修正**，不是审美改判。
**统计文本不丢**：`deriveTurnStats` 的产物（工具调用数 / 搜索数 / 编辑数）**移入折叠壳的行内 arg**，即 `Worked for 1m 6s · 3 tools, 11 searches ⌄`——收起时反而比现在信息量更大。

### 4.3 折叠默认态裁定表（`defaultTurnProcessOpen`）

| 条件 | 默认态 | 理由 |
|---|---|---|
| 回合**进行中**（`isActiveTurn`） | **展开** | 运行中收起 = 用户看不到进度，与第 6 条「状态；Thinking；流式输出；工具调用……」的诉求正相反 |
| 回合内存在**未解决的 `permission_request` 块** | **展开且不可折叠** | **安全红线**：把授权卡藏进折叠壳，等于回归第二轮点验第 5 条「授权卡不渲染」那个已闭环的故障面。此条**优先级最高，压过其余全部规则** |
| 回合内存在**失败工具调用**（`toolOk===false`） | **展开** | A06 失败可见性；与 D26 ② 的簇规则嵌套关系见 §7.2 |
| 回合是本次挂载期间**实时完成**的 | **保持展开**（不自动收起） | 刚看过的内容在完成瞬间坍缩 = 视觉抖动 + 上下文丢失。**这条不需要额外状态**：`<Collapsible defaultOpen={…}>` 的 `defaultOpen` 只在**挂载时**求值（同 `ToolRows.tsx:81` 的既有用法），回合从 active→complete 不会重挂 ⇒ 保持展开是**自然结果**，不是额外逻辑 |
| 其余（恢复会话 / 页面加载时已完成的历史回合） | **收起** | 参照图默认态；也是长会话的可读性来源 |
| 用户手动切换后 | 尊重用户（非受控 `Collapsible`） | 与 `ToolRows.tsx:81-97` 同机制 |
| `splitTurnBody` 得到的 **answer 段为空**（回合以工具行/权限卡结尾，无最终正文） | **展开** | 否则折叠后整个回合只剩一行 `Worked for Ns`，等于内容凭空消失 |

### 4.4 过程段 / 答案段切分（`splitTurnBody`）

```
answer  = items 尾部连续的 text 项（最后一个非 text 项之后的全部 text）
process = 其余全部（Thinking / 工具组 / 权限卡 / 问答卡 / 中间正文）
```

| 场景 | 切分结果 | 备注 |
|---|---|---|
| `thinking → tools → text → tools → text` | process = 前 4 项，answer = 末 text | 参照图正是此形 |
| `text` 单块（纯闲聊回复） | process = 空，answer = 该 text | process 空 ⇒ **不渲染折叠壳**，只留 `Worked for Ns` 静态行 |
| `tools` 结尾（无最终正文） | process = 全部，answer = 空 | 触发 §4.3 末行，默认展开 |
| 含未解决 `permission` | permission 项**留在 process**，但 §4.3 强制展开且禁用折叠 | 不做「把权限卡提到 answer」的特例——那会打乱块序，与 T-05 D-5「位置不变、按块序」的裁定冲突 |

> 流式期的稳定性：`answer` 是**尾部**判据，流式追加发生在最后一个 text 块内，`splitTurnBody` 的结果在一次流式过程中**不会来回跳**（只会在新工具调用插入时把旧 answer 归入 process 一次）。这一点必须有断言（F-B6）。

### 4.5 工具聚合行的词形小扩

参照图出现三种聚合 arg：`SKILL.md, 1 search` / `2 searches, ran 2 commands` / `README.md, ran 1 command`。
本仓 `AGGREGATE_VERB.done = 'Explored'`（`toolCard.ts:323`）与「N files, M searches」已对齐；缺的是 **`ran N command(s)`** 这一计数项（Bash 类调用）。
裁定：在既有 arg 组装处**追加一个计数类目**，单复数走既有规则。**S 量级、纯函数、可断言**，不改行形态。

### 4.6 尾部状态条（第 6 条的「状态条」）

| 项 | 现状 | 目标 | 裁定 |
|---|---|---|---|
| 模型名 | `formatMessageMetadata` 输出 `Sonnet · 10:30`（P-14 兜底已修） | 保留 | ✅ 不变 |
| 时间 | 绝对 `10:30`（`messageMetadata.ts:152-157` `defaultFormatTime`） | 参照图为相对 `3h ago` | **改为相对**（即 polish-audit **P-18**，🟠 A07 `:1776` 小修订；侧栏已用相对时间，两处口径自此统一） |
| **耗时** | 不在 footer（已按 A07 `:1871` 搬到顶部） | 参照图 footer **也没有耗时**（`3h ago` 而已），耗时在顶部 `Worked for 1m 6s` | **维持 A07 `:1871`，footer 不复现耗时**。用户第 6 条口述的「显示耗时」由**回合顶部**承担 ⇒ §9 可拍板点 δ |
| **copy** | 无 | 复制整回合原文 | **新建**（polish-audit **P-34**）。复制内容 = 该回合 answer 段 + process 段的正文块拼接（不含工具 IN/OUT），`navigator.clipboard.writeText`，复制后按钮切 `Check` 图标 1.5s |
| **fork** | 无对应能力 | 参照图有 | **不做**（§10-A） |
| 👍/👎 | 无对应能力 | Cursor 有（旧版） | **不做**（§10-B） |
| 形制 | `<p class="flex flex-wrap items-center gap-2 text-code text-muted-foreground">`（`:612`） | 右对齐 + 图标按钮 | **改**：`justify-end`；字号交 D25 **S24 = `--text-meta`(13)**；copy 为 `size-6 rounded-sm hover:bg-hover` 的 ghost icon button（与 T-30 批2 的 ghost chip 形制同源）；**默认可见**（不做 hover-only：hover-only 在触摸/键盘下不可达） |

### 4.7 回合头三态（状态段与 `Worked for` 是同一槽位）

关键实测事实：`formatWorkedForRow(metadata?.latencyMs)` 在 `latencyMs == null` 时返回 `null`（`turnTiming.ts:134-138`），而 `latencyMs` 只在 `message.completed` 之后才有（`messageMetadata.ts:14-24`）。
⇒ **运行中回合头本来就是空的**，状态段填的正是这个空位，完成时被 `Worked for Ns ⌄` 接管。**两者是同一槽位的两态，不需要额外的互斥逻辑。**

| 回合态 | 头槽渲染 | 文案来源 |
|---|---|---|
| handshake | `Starting Agent Host… · Ns` + Spinner | `composerSendingLine({phase:'handshake'})` |
| awaiting（尚无任何块） | `Waiting for Agent Host reply · Ns (up to 45s)`（+ `· Network retry N/M`） | `composerSendingLine({phase:'awaiting'})` |
| streaming（已有 ≥1 块） | `Generating · Ns` + Spinner | **唯一新增文案**（§9 可拍板点 ε：是否改为 Cursor 的实时 `Worked for Ns`） |
| slow（≥45s） | `Still waiting · Ns — gateway latency varies. Stop to abort.`（warning 色） | 既有分支 |
| complete | `Worked for Ns · 3 tools, 11 searches ⌄` | `formatWorkedForRow` + `deriveTurnStats` |
| failed | 该回合头显示失败态；会话级失败块（`MessageTimeline.tsx:223-252`）**位置不变** | 见 §9 可拍板点 ζ |

### 4.8 目标 DOM（`ChatTurn`）

```
<ReadingColumn class="space-y-2.5">                      ★改 space-y-5 → space-y-2.5（算术见 §5.4）
  {turns.map(turn =>
    <section key={turn.id} class={chatTurnClass()}>       ★新建：per-turn 容器 = sticky 的 containing block
      {turn.user && (
        <div class={turnBubbleBandClass()}>               ★新建：sticky top-0 z-10 bg-background py-2.5
          <UserBubble message={turn.user}/>               ← 形态沿用 P-09/P-10 已落地口径，不改
        </div>
      )}
      <TurnHead state={deriveTurnStatus(...)} />          ★新建槽位（§3 / §4.7）
      {process.length > 0 && (
        <Collapsible defaultOpen={defaultTurnProcessOpen(...)}>   ★新建：回合级折叠壳
          <CollapsibleTrigger> ← 即 TurnHead 的 complete 态（Worked for … ⌄）
          <CollapsibleContent class="flex flex-col gap-2.5">{process 项}</CollapsibleContent>
        </Collapsible>
      )}
      <div class="flex flex-col gap-2.5">{answer 项}</div> ← 恒可见
      <TurnFooter/>                                       ★改：模型 · 相对时间 · copy（§4.6）
    </section>
  )}
```

- `AssistantMessage` 的 `<article class="flex flex-col gap-2.5">`（:555）**下沉**为 process/answer 两个容器的类，P-17 的「段间 10px 单一来源」不变。
- `MessageBubble` 的 role 三分**保留**，只是被 `ChatTurn` 调用而不再直接 map。
- **`ChatComposer` 的单一 JSX 槽位红线（T-28 R4）不受影响**（本规格不动 Composer 的挂载结构，只删它状态行的一个分支）。

---

## 5. 裁定 C · 置顶用户气泡（第 7 条）

### 5.1 方案选型

| 方案 | 做法 | 判定 |
|---|---|---|
| **A（采纳）· 就地 CSS sticky** | 气泡带 `position: sticky; top: 0`，放在 `<section>`（回合容器）内 | 零 JS、零滚动监听；**锚定切换判据 = DOM 顺序本身**（见 §5.3） |
| B · 视口外浮层 | 在 `ScrollArea` 之上再叠一层浮动气泡，靠滚动位置/IntersectionObserver 决定显示哪一条 | 需要滚动监听 + 一份消息内容的重复渲染；**并且会推翻 Round-2 V-b 的审计结论**（「此视口之上不存在任何 sticky/fixed/absolute 元素」），把「顶部半行被裁」的排查面重新打开 |

### 5.2 sticky 的可行性前提（逐条核对）

| 前提 | 现状 | 判定 |
|---|---|---|
| 存在明确的滚动容器 | `ScrollArea.Viewport`（`ui/scroll-area.tsx:19-29`，`data-slot="scroll-area-viewport"`，`MessageTimeline.tsx:156` 的 `findViewport` 正是靠它取 scrollTop） | ✅ |
| 气泡到滚动容器之间无 `overflow` 截断 | 链路：Viewport → `div.TIMELINE_PADDING_CLASS` → `ReadingColumn`(`mx-auto w-full`) → `<section>` → band。**四层全无 overflow / transform / filter / contain** | ✅ |
| sticky 的 containing block 是回合 `<section>` | 由 §4.8 的结构保证 | ✅ 这正是「回合结束即释放锚定」的机制 |
| 滚动跟随不冲突 | `viewport.scrollTop = viewport.scrollHeight`（`:161`）只写 scrollTop，与 sticky 的绘制无关 | ✅ |
| **`scrollFade` 的 mask 冲突** | `ui/scroll-area.tsx:22-23`：`scrollFade` 在 **Viewport 自身**挂 `mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))]`，`--fade-size:1.5rem`(24px) | ❌ **冲突，必须处理**（§5.5） |

> `mask-image` 不影响 sticky 的**布局**（sticky 只受最近滚动祖先与 containing block 约束），影响的是**绘制**：顶端 24px 会被渐隐——而被钉住的气泡正好占据顶端。这是本规格唯一一处会被静态审阅漏掉、必须 GUI 实测确认的交互点。

### 5.3 多轮会话的锚定切换判据

**判据 = 无判据。** 采用方案 A 后，切换由 CSS 自动完成：
- 回合 N 的气泡在其 `<section>` 内 sticky，`<section>` 的下边界离开视口顶端时气泡**自然被推走**；
- 回合 N+1 的 `<section>` 顶端此时正好抵达视口顶端，其气泡随即接管。
- 两者在过渡帧里表现为「上一条被顶出、下一条推入」，与 Cursor 的观感一致。

⇒ **不需要 scroll 监听、不需要 IntersectionObserver、不需要 activeTurnId 状态**。这是选 A 的最大收益：第 7 条这类「随滚动变化」的需求，最容易被实现成一份影子状态机，而它实际上是一条 CSS 声明。

### 5.4 间距算术（与 P-17 的三档对齐）

现状：`ReadingColumn class="space-y-5"`(20px) 作用在**每条消息**之间 ⇒ user 气泡与它自己的回复之间也是 20px。
目标：user 气泡与它的回复是**同一回合内的段间**（P-17 = 10px），回合与回合之间才是 20px。

| 量 | 值 | 来源 |
|---|---|---|
| `ReadingColumn` 的 `space-y-*` | `space-y-2.5` = **10** | ★改 |
| band 的 `py-*` | `py-2.5` = **10 / 10** | ★新增 |
| ⇒ 上一回合末 → 本回合气泡 | 10 + 10 = **20** | ✅ P-17「回合间 20」 |
| ⇒ 气泡 → 回合头 | **10** | ✅ P-17「段间 10」 |
| 回合内各项 | `gap-2.5` = **10** | ✅ 沿用 `MessageTimeline.tsx:555` |

band 的 `py-2.5` 有双重作用：既提供上述节拍，又在**钉住态**给气泡上下各 10px 的**不透明**缓冲，让下方内容滚入时被干净地遮住。band 必须带 `bg-background`（时间线底色，非 `bg-card`）。

宽度侧无渗漏：band 位于 `ReadingColumn` 内，滚入的内容同样受限于 `ReadingColumn` 宽度，`TIMELINE_PADDING_CLASS` 的 `px-6` 区域内没有任何内容。

`z` 层级：band 取 `z-10`；时间线内现无更高层级的就地定位元素（`HitListPopover` / Menu 走 portal，天然在上）。

### 5.5 与 `scrollFade` 的冲突处置

| 选项 | 做法 | 判定 |
|---|---|---|
| **A（推荐）· 给 `ScrollArea` 加按边 fade** | `scrollFade` 由 `boolean` 扩为 `boolean \| 'bottom' \| 'top'`（默认 `true` = 四边，行为不变），时间线传 `scrollFade="bottom"` | 保住底部软边；顶部由**不透明 band** 接管，本就不再需要渐隐。对 `ui/scroll-area.tsx` 是**向后兼容的可选加法**，combobox/sheet/autocomplete 三个既有调用点零改动。**S 量级** |
| B · 时间线整体去掉 `scrollFade` | 一行删除 | 连带丢掉底部软边（贴底滚动时下沿会硬切）。零风险但有净损失 |
| C · 保留四边 fade | — | ❌ 钉住的气泡会被顶部 24px 渐隐吃掉一半，第 7 条形同虚设 |

**顶部 fade 在钉住态下本就失去意义**：Round-2 V-b 给 fade 的理由是「一个高过视口的回合，其顶部（`Worked for Ns` 行）必然被滚出视口，硬切改软切」。置顶气泡落地后，视口顶端**恒为一条不透明的气泡带**，硬切面消失，fade 无对象可作用。⇒ 选 A 不是覆盖 V-b 的裁定，而是**它的前提被本次改动消解了**。

### 5.6 长文本截断

钉住态下，一条 20 行的提问会占满整个视口。三选一：

| 选项 | 做法 | 判定 |
|---|---|---|
| **A（推荐）· `scroll-state` 容器查询** | band 挂 `container-type: scroll-state`，气泡在 `@container scroll-state(stuck: top)` 下 `line-clamp-3` + 底部渐隐；未钉住时全文 | **纯 CSS，零 JS，零状态**。Electron 39（`package.json:100`）= Chromium 142，`scroll-state()` 自 Chromium 133 起可用，**本仓是单引擎环境无跨浏览器顾虑**。`container-type: scroll-state` **不施加尺寸约束**（不同于 `size`），布局安全。⚠️ 版本支持为**知识推断，非实测**，必须一次 GUI 实测确认，失败则降 B |
| B · 无条件截断 | 气泡恒 `line-clamp-6` + 点击展开 | 零风险；代价是**未钉住态下的长提问也被截**，与 P-10/D26 ④「user 气泡满宽」的可读性初衷相抵 |
| C · sentinel + IntersectionObserver | 1px 哨兵 + hook 派生 `isPinned` | 行为正确但引入一份滚动派生状态；node-only vitest 下不可断言，只能 inspection-verified |

无论哪种，**气泡的 `title` 恒为全文**（读屏与悬停可达），截断档位 **3 行**（钉住态）/ 不截（自由态）。

### 5.7 与「时间线顶部被裁切」历史修复的兼容（Round-2 V-b）

| V-b 的三条结论（`MessageTimeline.tsx:178-187` 注释原文） | 本规格的处置 |
|---|---|
| ①「此视口之上不存在任何 sticky/fixed/absolute 元素（已审计四个组件）」 | ⚠️ **该事实被本规格改变**：新增了一个 `sticky` band。但**性质不同**——它在**视口之内、内容流之中**，不是覆盖在滚动内容之上的浮层，因此 V-b 排除的那类「浮层遮挡」故障面**没有被重新打开**。注释必须同步更新为「视口内存在 per-turn 的 sticky 气泡带，参见本规格 §5」，否则下一次同类排查会被这条过期注释误导 |
| ②「顶部半行被裁 = 贴底滚动的固有行为，不是遮挡 bug」 | ✅ **结论不变**。本规格不修改 `stickToBottom` 的任何逻辑 |
| ③「用 `scrollFade` 把硬切变软边」 | ✅ 手段保留（底部），顶部因前提消解而收回，见 §5.5 |

> 换个角度：用户第 7 条恰恰是对 V-b 那条「回合顶部必然滚出视口」的**产品级回应**——V-b 的结论是「这不是 bug」，用户的诉求是「即便不是 bug，我也要那个锚点留下」。两者不矛盾，是同一现象的两级处置。

---

## 6. 新增纯函数层与断言清单

### 6.1 新增 / 变更的纯函数（全部落 `.ts`，`.tsx` 零字面量）

| 位置 | 导出 | 说明 |
|---|---|---|
| **新建** `chatTurn.ts` | `groupMessagesIntoTurns(messages) → Turn[]` | §4.1 分组规则 |
| | `splitTurnBody(items) → {process, answer}` | §4.4 |
| | `defaultTurnProcessOpen(input) → boolean` | §4.3 判定表 |
| | `hasUnresolvedPermission(turn) → boolean` | §4.3 安全红线判据 |
| | `turnHasFailure(turn) → boolean` | 与 D26 簇规则共用同一判据（§7.2） |
| **新建** `turnStatus.ts` | `deriveTurnStatus(input) → {kind, text} \| null` | §4.7 六态；内部委托 `composerSendingLine` |
| **新建** `turnCopy.ts` | `buildTurnCopyText(turn) → string` | §4.6 copy 内容组装（正文块拼接，排除工具 IN/OUT） |
| `turnTiming.ts` | `formatWorkedForRow` 扩 arg | 追加 `· N tools, M searches`（§4.2 统计不丢） |
| `toolCard.ts` | 聚合 arg 追加 `ran N command(s)` | §4.5 |
| `messageMetadata.ts` | `defaultFormatTime` → 相对时间 | P-18 |
| **新建** `chatTimelineLayout.ts`（或并入 `middleColumnLayout.ts`） | `chatTurnClass()` / `turnBubbleBandClass()` / `turnHeadClass()` / `turnFooterClass()` / `turnCopyButtonClass()` | §4.8 / §5.4 的类下沉 |
| `middleColumnLayout.ts` | `shouldShowStatusLine` 去 `sending` 条件 | §3.2 |

### 6.2 断言清单（vitest node-env；编号 F-B，与 T-30 批2 的 F-A 并列）

| # | 断言 | 形式 | 抓什么回归 |
|---|---|---|---|
| **F-B1** | `groupMessagesIntoTurns`：`[u,a]`→1 回合；`[u,a,u,a]`→2；`[a,a]`→1 个 `user:null` 孤儿回合；`[u,u,a]`→2 回合且第 1 个 `body` 为空；`[u,a,sys,err,u]`→第 1 回合 body 含 sys+err。**任意输入下 `Σbody.length + Σ(user?1:0) === messages.length`（零丢消息）** | 纯函数 + 不变量 | 分组吞消息（最危险的一类回归） |
| **F-B2** | `splitTurnBody`：`[think,tool,text,tool,text]` → process 4 / answer 1；`[text]` → process 0 / answer 1；`[tool]` → process 1 / answer 0；`[text,text]`（尾部连续）→ process 0 / answer 2 | 纯函数 | §4.4 切分点漂移 |
| **F-B3** | `defaultTurnProcessOpen`：`{isActive:true}`→true；`{hasUnresolvedPermission:true}`→true **且** `{hasUnresolvedPermission:true, isActive:false, hasFailure:false}` 仍为 true（**优先级最高**）；`{hasFailure:true}`→true；`{answerEmpty:true}`→true；全 false→false（**共 6 例真值表**） | 纯函数 | **授权卡被折叠隐藏**（安全红线） |
| **F-B4** | `hasUnresolvedPermission`：块 `type==='permission_request'` 且 `resolved!==true` → true；`resolved:true` → false | 纯函数 | 同上 |
| **F-B5** | `deriveTurnStatus` 六态：handshake / awaiting / streaming / slow(≥45) / retrying / complete(null) 各一例；且 awaiting 分支输出**逐字等于** `composerSendingLine` 同参数的输出（**同源交叉断言**，不比字面量） | 纯函数 + 交叉 | 文案二次实现导致漂移（`attachments.test.ts:334` 的字面断言只锁一处） |
| **F-B6** | 流式稳定性：对 `[think,tool,text]` 的 text 块**追加文本**后再跑 `splitTurnBody`，`process.length` 与 `answer.length` **不变** | 纯函数 + 序列 | 流式期折叠壳内容来回跳 |
| **F-B7** | `buildTurnCopyText`：只含 text 块正文，**不含**工具 `toolInput` / `toolOutput` / thinking 正文；块间以 `\n\n` 连接；空回合返回 `''` | 纯函数 | copy 泄漏工具原始输出（可能含密钥/路径） |
| **F-B8** | `turnBubbleBandClass()` 含 `sticky`、`top-0`、`bg-background`、`py-2.5`、一个 `z-` 类；**不含** `overflow-`、`transform`、`filter` | 字符串 | sticky 被 overflow/transform 静默失效（最隐蔽的一类） |
| **F-B9** | 间距算术交叉：`ReadingColumn` 的 `space-y-*` 数值×4 + `turnBubbleBandClass()` 的 `py-*` 数值×4 === **20**；且 band 的 `py` 数值×4 === 回合内 `gap-2.5` 的 10 | 算术 × 字符串 | §5.4 的两段间距被单边改动、P-17 三档塌陷 |
| **F-B10** | `chatTurnClass()` **不含** `overflow-hidden` / `contain` / `transform`（sticky containing block 完整性） | 字符串 | 同 F-B8 |
| **F-B11** | `shouldShowStatusLine({sending:true, reading:0, hasStatusError:false, hasLargeHint:false})` === **false**（sending 不再点亮 Composer 状态行）；`{reading:1,…}` === true | 纯函数 | 状态读条迁移后 Composer 侧残留、同一信息两处并显 |
| **F-B12** | `formatWorkedForRow(null)` 仍返回 `null`（不硬造秒数，A07 `:2399`）；`formatWorkedForRow(66000)` 的 arg 含 `1m 6s` 形态 | 纯函数 | 回归护栏（既有 `turnTiming.test.ts` 扩写） |
| **F-B13** | `defaultFormatTime` 相对化后：<60s→`just now`、90min→`1h ago`、跨日→`Nd ago`；且**与侧栏既有相对时间格式器同源**（同一函数或同一断言表） | 纯函数 | P-18 落地后两处口径再次分叉 |
| **F-B14** | 聚合 arg：2 次 Bash → 含 `ran 2 commands`；1 次 → `ran 1 command`（单复数） | 纯函数 | §4.5 |
| **F-B15** | `turnFooterClass()` 含 `justify-end`；`turnCopyButtonClass()` 含 `size-6`、`rounded-sm`、`hover:bg-hover`，**不含** `opacity-0` / `group-hover:`（**禁止 hover-only**，触摸与键盘不可达） | 字符串 | copy 被做成只有鼠标能发现 |

**不可断言、只能 inspection-verified + GUI 点验的项**（须注释入码，沿用 T-19 先例）：
① sticky 在 `ScrollArea.Viewport` 内的实际生效；② `mask-image` 与钉住气泡的绘制关系（§5.5）；③ `scroll-state()` 容器查询在 Electron 39 的可用性（§5.6-A）；④ `Collapsible defaultOpen` 的挂载期求值语义（§4.3 第 4 行的「自然结果」论证）。

---

## 7. 与既有裁定的逐条对齐

### 7.1 A07（需登记为 v5 追记；v4 追记已被 D25 + T-30 批2 占用）

| A07 锚点 | 原文 | 本规格处置 |
|---|---|---|
| `:2396-2400` D 组「`Worked for Ns ⌄` 是回合级时长……」+ `:2413-2419` 展开体为统计文本 | 展开 = 统计 | ⚠️ **修订**：展开 = **过程段**（Thinking + 工具行 + 中间正文），统计降为收起行的 arg 后缀。依据：round-4 的收起/展开同回合双图给出差集（v2 素材只有收起态，无法判定） |
| `:1871`「回合时长搬家：footer 里的重复时长删掉」 | 耗时只在顶部 | ✅ **维持**。用户第 6 条口述的「状态条显示耗时」由顶部 `Worked for` 承担（参照图 footer 亦无耗时）⇒ §9-δ |
| `:1776-1782` footer = `claude-opus-5 · 07:41` | 绝对时刻 | ✏️ **改相对**（P-18，已在审计中标为 🟠 A07 小修订） |
| `:2432` 失败行自动展开 | 明文裁定 | ✅ **维持**，并升级为**两级**：回合级过程段遇失败强制展开（§4.3），行级仍按 D26 簇规则（§7.2） |
| `:846` `.tl` 回合间距 20px | 20px | ✅ **维持总量 20**，但**改变构成**（10 space-y + 10 band padding，§5.4）。追记须写明构成变化，否则下次有人看到 `space-y-2.5` 会以为节拍被改小了 |
| `:848-855` user 气泡（右对齐 + `max-w:85%`） | 已被 **D26 ④** 改为满宽 | ✅ 沿用 D26 后的口径；本规格**只加 sticky 与 band，不动气泡自身形态**（P-09 落地的圆角/内距/底色一字不改） |
| `:1294` / `:2789` 刻意不搬清单 | 麦克风等 | ➕ **追加 fork / 👍👎 两项**（§10-A/B） |
| （A07 无对应物） | 回合级折叠壳 / 状态段 / 置顶气泡 / copy | ➕ **新增四个锚点**，登记为 A07 之后的既有事实 |

### 7.2 D26（四条 A07 修订）

| D26 条目 | 冲突性 | 对齐 |
|---|---|---|
| ① 失败工具行「整行红」→ 分级红 | 无冲突 | 本规格不动工具行着色 |
| ② 失败自动展开 → **簇规则**（同一 ToolGroup 内 ≥3 条失败只自动展开第一条） | **需嵌套裁定** | **两级独立、不互相覆盖**：回合级折叠壳按 `turnHasFailure` **强制展开**（保证失败可见），进入过程段后，行级仍按 D26 簇规则决定**哪些行展开输出体**（保证不满屏红）。⇒ 用户看到的是「过程段打开 + 红行头可见 + 只有首条失败展开了 OUT」，两条裁定的意图**同时**达成。**这是本规格唯一一处需要显式说明的嵌套关系，必须写进 A07 v5 追记** |
| ③ 侧栏 chip 封顶放宽 | 无冲突 | 不同面 |
| ④ user 气泡满宽（连带 A01） | **协同** | 满宽正是置顶气泡的前提：85% 右对齐的气泡钉在顶端会留下一条左侧透明缝，滚入内容会从缝里穿出。⇒ **D26 ④ 必须先落地**，否则第 7 条不成立（施工序依赖，§8.2） |

### 7.3 polish-audit（`docs/design/polish-audit-20260730.md`）

| 条目 | 关系 |
|---|---|
| **P-13**（`Worked for` / 正文 / footer 三行无层级） | ✅ **被本规格结构性解决**：三者不再是三条平行的行，而是「回合头 / 答案段 / 尾部条」三个语义层；字号层级仍由 D25 给 |
| **P-17**（回合节奏 4/10/20 三档） | ✅ **强化**：§5.4 把 20 的构成算术化并加断言 F-B9 |
| **P-18**（相对时间） | ✅ **本规格落地**（§4.6） |
| **P-34**（回合末尾操作行，至少 copy） | ✅ **本规格落地**（§4.6），fork/👍👎 按 A06 不做 |
| **P-06**（会话失败块收敛） | ✅ 已在 T-30 批1 落地；本规格**不动**该块位置（§9-ζ 列为可拍板） |
| **P-32/P-33**（Markdown） | 🔗 **归 T-29**。本规格只保证 `answer` / `process` 两个容器的**块序与切分**，正文渲染件在 `MessageTimeline.tsx:562-568` 一处，T-29 替换它时**不受本规格影响**（§8.2 定序） |
| **P-16**（foreground 只给四处，含 assistant 正文） | ✅ 不冲突；答案段仍 `--foreground`，过程段仍 muted |

### 7.4 Round-2 V-b 与第二轮点验裁定

见 §5.7（逐条已对齐）。另：第二轮「授权卡不渲染」的闭环（红线文件批准改动）与 §4.3 的安全红线**同源**——本规格把「授权卡必须可见」从一次故障修复**升级为结构不变量**并加断言（F-B3/F-B4）。

---

## 8. 范围与批次建议

### 8.1 与 T-30 批2 的文件交叠

| 文件 | T-30 批2 动它 | 本规格动它 | 冲突性质 |
|---|---|---|---|
| `MessageTimeline.tsx` | D25 **S23**（气泡正文 14→15）/ **S24**（footer → `--text-meta`）/ P-13 层级 —— **纯字号类迁移** | **结构重排**（引入 ChatTurn、拆 process/answer、改 footer） | **真交叠**。但性质与 T-30 批2 内部的 `ModelSelect` 不同：那是**删文件**（先做字号迁移 = 白做），这里是**搬节点**，字号类跟着节点走 ⇒ 只有 diff 冲突，无白做 |
| `ToolRows.tsx` | D25 **S19**（arg prose 15px）+ ②b `argKind` | 新增回合级折叠壳（新组件，可不改本文件） | 弱交叠 |
| `ChatComposer.tsx` | 两态 DOM 装配 + 模型 chip + ⊕ | 删 statusLine 的 sending 分支（`:1449-1467`） | **真交叠**（同一函数体附近） |
| `middleColumnLayout.ts` | 卡/行/触发器/圆钮全部类 + `shouldShowStatusLine` 的 **empty 分支** | `shouldShowStatusLine` 的 **sending 条件** | **同一函数**，必须定序 |
| `__tests__/middleColumnLayout.test.ts` | F-A1~F-A22 | F-B11 | 同文件 |
| `messageMetadata.ts` | — | P-18 相对时间 | 无冲突 |
| `ui/scroll-area.tsx` | — | 按边 fade（§5.5-A） | 无冲突（共享原语，向后兼容加法） |
| A07 追记 | **v4 追记**（D25 一~五 + 形态六~十 + round4 十一） | **v5 追记** | 分属两个追记段，**不冲突**（前提是 T-30 批2 的 v4 一次成文，其 §8.2-S6 已明示） |

### 8.2 批次裁定：**另立 T-31，排在 T-30 批2 之后、T-29 之前**

**不并批的三条理由**：

1. **量级**。T-30 批2 已是 5.6~6.1d（L+，见形态追补 §9.4）。并入本规格的 ≈3.5d 会做成 ~9d 的单批，违背「每批可独立三绿、可独立点验」的工程规范第 7/12 条。
2. **点验维度不同**。T-30 批2 是「输入区形态是否协调」，本规格是「回复是否读得懂」。合成一批意味着用户一次要判两个正交维度，出问题时无法二分。
3. **依赖方向单向**。本规格依赖 **D26 ④（气泡满宽）**（§7.2）与 **D25 的字号档**（footer/head 都要 `--text-meta`），反向零依赖 ⇒ 天然是后继批。

**为什么不排在 T-30 批2 之前**：`shouldShowStatusLine` 与 `MessageTimeline.tsx` 的字号迁移会被打两遍；且 D26 ④ 未落地时置顶气泡不成立。

**为什么排在 T-29（Markdown）之前**：T-29 要替换的是 `MessageTimeline.tsx:562-568` 那一处 `<p whitespace-pre-wrap>`。本规格会把它搬进 process/answer 两个容器。**先做 T-31，T-29 面对的是一个稳定位置的单点替换；反过来则 T-29 的成果要被搬一次**。

### 8.3 施工序与量级

```
R0  断言先行（F-B1~F-B15）                                    S   0.3d
R1  chatTurn.ts + turnStatus.ts + turnCopy.ts 三个纯层        M   0.75d
    （分组 / 切分 / 默认态真值表 / 状态六态 / copy 组装）
R2  MessageTimeline 结构重排：ChatTurn / TurnHead /           M   1.0d
    回合级 Collapsible / TurnFooter；MessageBubble 保留复用
R3  置顶气泡：band 类 + section containing block +            S~M 0.5d
    scroll-area 按边 fade + scroll-state 截断 + GUI 实测
R4  状态读条迁出 Composer（含 shouldShowStatusLine 改判、      S   0.35d
    Spinner 搬家、A06 信息不丢核对）
R5  copy 按钮 + P-18 相对时间 + 聚合行 ran N commands          S   0.3d
R6  A07 v5 追记（Worked-for 语义修订 / 折叠两级嵌套 /          S   0.4d
    置顶气泡 / 状态归属 / 不搬清单 +2）+ design-system 连带
    + MessageTimeline.tsx:178-187 的 V-b 注释更新
```

**合计 ≈ 3.6d（L−）**。并行度：R1 与 R3 可双线（纯层 vs 类层）；其余串行。

### 8.4 vitest node-only 环境下的可断言点清单（交接用）

**可断言（15 条）**：F-B1~F-B15，见 §6.2。覆盖面 = 分组不变量 / 切分 / 折叠默认态真值表（含安全红线）/ 状态文案同源 / 流式稳定性 / copy 内容边界 / 五组类名字符串 / 一组间距算术交叉。
**不可断言（4 条）**：sticky 生效、mask 与钉住气泡的绘制、`scroll-state()` 引擎支持、`defaultOpen` 挂载期求值 —— 全部注释入码 + 列入 GUI 点验清单。

---

## 9. 可拍板点（六项，均已给推荐值，不阻塞开工）

| # | 点位 | 推荐 | 备选 | 说明 |
|---|---|---|---|---|
| **δ** | 尾部状态条**是否显示耗时** | **不显示**（耗时只在回合顶部 `Worked for Ns`） | 显示，则同一数字两处并存 | 用户第 6 条字面说了「状态条显示耗时」，但**参照图 `135656` 的尾部只有 `3h ago`**，耗时在顶部。推荐按 A07 `:1871` 与参照图走；**这是本规格唯一一处字面口径与参照图不一致的地方，请用户裁** |
| **ε** | streaming 态回合头文案 | `Generating · Ns`（唯一新增文案） | 改为 Cursor 的实时 `Worked for Ns`（省一条新文案，但要接一路计时 tick） | 观感差异小，成本差 ≈0.1d |
| **ζ** | 会话级失败块（`MessageTimeline.tsx:223-252`）是否移入失败回合内 | **不移**（保持会话级、位置不变） | 移入，则失败与它的回合贴在一起，但会话级错误（非回合内）无处可去 | 移动会触及 T-30 批1 已落地的 P-06 |
| **η** | 置顶气泡的截断方案 | **A · `scroll-state()` 容器查询**（纯 CSS） | B 无条件 `line-clamp-6` / C IntersectionObserver | A 需一次 GUI 实测确认引擎支持（§5.6） |
| **θ** | `scrollFade` 处置 | **A · 给 `ScrollArea` 加按边 fade**（`scrollFade="bottom"`） | B 时间线整体去 fade | A 动共享原语但向后兼容；B 零风险有净损失 |
| **ι** | 尾部 **fork 图标** | **不做**（A06） | 做 | 详见 §10-A。本仓的 `fork`（`composerTarget.ts:16,51,102`）语义是「把会话**换靶到另一个工作区**」，与 Cursor 那枚「从此处**分叉对话**」是两回事；借它的图标去表示一个不存在的能力，是一次伪装 |

---

## 10. 有意不对齐项（诚实性清单，A06）

| # | Cursor / 参照图有 | 本仓处置 | 理由 |
|---|---|---|---|
| **A** | 尾部 fork（分支）图标 | **不做** | 无「从某条回复分叉出新会话」的能力。仓内同名的 `fork`（`composerTarget.ts`）是换靶语义，不是对话分叉。摆上去 = 死按钮，与 T-28 当年拒绝 ⊕ 的同一条判据 |
| **B** | 👍 / 👎 反馈键（Cursor 旧版，见 P-34 描述） | **不做** | 无反馈回传通道 |
| **C** | Cursor 完全不展示工具输出（五张参照图零次） | **不对齐**（保留可展开 IN/OUT） | A07 `:2440` §08-⑤ 已裁定：排障价值高于 1:1。**本规格进一步保护它**——回合级折叠壳收起时行级 IN/OUT 状态不丢，展开后仍在 |
| **D** | 参照图 footer 的 `3h ago` 用**绝对时间悬停**（未截到） | 本仓 `title` 给绝对时刻 | 相对时间省宽但丢精度，`title` 补回，与侧栏同策 |
| **E** | `7dd04b57` 暗色图的工具卡形态：**圆点状态**（绿/红/灰）+ `Bash` 加粗标题行 + 独立描述 + 带框 IN/OUT 块 | **不搬** | 这是 **openchamber 口径**（本仓 v1 形态），**D24 已明文整块作废**（A07 `:1867`「图标、竖线、diff 统计全部取消」），T-05 落地为「动词开头、无图标无边框无圆点的灰阶单行」。该图只作现状对照，**不是本轮目标**。若误当目标施工，等于回滚 D24 |
| **F** | 参照图底部 `Create Branch & Commit ⌄` 等操作 pill | **不做** | 同 T-30 批2 §10-A（无对应能力） |

---

## 附录 · 风险与回归面

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| **授权卡被折叠壳藏起** | 回合含未解决 `permission_request` 且过程段收起 | §4.3 最高优先级规则 + F-B3/F-B4 断言 + 「含未解决权限时禁用折叠触发器」 |
| 分组吞消息 | `system`/`error`/连续 user/孤儿开头四类边界 | F-B1 的 `Σ === messages.length` 不变量（对任意输入成立，非样例断言） |
| sticky 静默失效 | 未来有人给 `ChatTurn` 或 band 加 `overflow-hidden` / `transform`（如做圆角裁剪或动画） | F-B8 / F-B10 字符串断言把禁止项写死 |
| 顶部 fade 吃掉钉住气泡 | `scrollFade` 保持四边 | §5.5 选 A；GUI 点验必查项 |
| `scroll-state()` 不可用 | 引擎版本推断有误 | 降级选项 B（无条件 `line-clamp-6`），成本 ≈0，**开工前一次 GUI 实测即可定** |
| 回合间距被读成「变紧了」 | `space-y-5` → `space-y-2.5` 单看像减半 | F-B9 算术断言 + A07 v5 追记写明「总量仍 20，构成由单段改为 10+10」 |
| copy 泄漏工具输出 | `buildTurnCopyText` 把 `toolOutput` 拼进去 | F-B7；工具输出可能含路径/密钥片段 |
| 状态信息两处并显 | Composer 与回合头都显示等待 | F-B11 |
| 流式期折叠壳内容跳动 | `splitTurnBody` 在追加文本时结果变化 | F-B6 序列断言 |
| 与 T-30 批2 的 `middleColumnLayout.ts` diff 冲突 | 两批同改 `shouldShowStatusLine` | §8.2 定序：T-30 批2 先落，本批基于其结果改 |

---

## As-built 修正（2026-08-18，F10）

§5.6-A 的钉住态截断（`scroll-state(stuck: top)` → 3 行 clamp）在真机点验中被证实**结构性振荡**：截断抽高度 → 浏览器钳 `scrollTop` 回 sticky 阈值下 → 解钉展开 → 贴底跟随器推回，逐帧循环（触发窗口宽度 = 截断抽走的 Δ 高度，长提问 + 短回复必中）。§9-η 预授权的回退 **§5.6-B（无条件 clamp）已启用**：`userBubbleTextClass()` = `line-clamp-6`，`scroll-state.css` 删除；伴修两件——时间线视口 `overflow-anchor: none`、跟随器改 `nextFollowState` 步进函数（高度变化帧不武装）。§5.3「零滚动监听、零状态」的判断本身仍成立，且正因为无状态无迟滞，钉住态截断才不可修。`scroll-state-probe.js` 的结论（「query 可解析」）不构成「该属性可安全使用」的证据——探针只问了解析性没问反馈环。红线固化：`chat/__tests__/scrollStateCss.test.ts`。根因全文见 [D48/T-10 点验分诊](./2026-08-17-d48-t10-inspection-triage.md) F10 与主线台账 2026-08-18 行。
