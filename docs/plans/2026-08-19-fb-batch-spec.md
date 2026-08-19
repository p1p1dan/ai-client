# 0820 使用反馈批（FB 批）施工规格 rev.1

> 上游分诊：`docs/plans/2026-08-19-usage-feedback-0820-triage.md`（FB1~FB11 全表 + §2 改判清单 + §4 D53 三项拍板）。
> 本档只写规格，**不改任何生产代码**。
> 口径：每条裁定标注【实测】（本轮在本机 HEAD 上核验，带 `file:line`）或【推测】（未实测的推断，须施工时验证）。
> 与分诊档 / 既有规格冲突处一律显式写「【与分诊冲突】」或「【与 X 规格冲突】」并给出实测依据。

| 项 | 值 |
|---|---|
| 日期 | 2026-08-19 |
| **锚点基线 HEAD** | **`99dfd78`**（`docs(plans): D53 落账——0820 反馈批三项拍板收口`）—— 本档全部 `file:line` 在此 commit 实读重取 |
| 上游批次边界 | **F456 批（D50）四片已 as-built 合入**（`b1b8f6c` / `1c5a797` / `1516623` / `19a65f7`），其产物 `turnAnswerContainerClass()` · `VERBS` · `↑↓` 双计数 · `stalled` 档 · `line-clamp-6` 全部**已在代码里**，本批在其之上施工 |
| 用户拍板（不可讨论） | **D53 ①②③**（`openchamber-chat-refactor-ledger.md:97`）+ 用户 2026-08-19 反馈原文即拍板的六项 |
| 决策号 | **不新立**。本批全部范围已由 **D53** 覆盖；施工中若产生新裁定，复取台账最大号后另立（当前最大 = D53） |
| 施工范围 | **八件**：FB1 · FB2 · FB3 · FB4 · FB6 · FB7 · FB8 · FB9 |
| 预计切片 | **5 片**，依赖序见 §11 |
| 取证存档 | `docs/plans/2026-08-19-fb4-fb6-structure-spec.md`（FB4/FB6 取证摘要，子代理产出，**未注册进 plantree**，去留待定 —— 见 §12 Q11） |

---

## 结论先行

本批八件里，**只有两件是真正的新能力**（FB9 LaTeX、FB2 代码块 copy），其余六件全部是**已落地设计的形态改判或缺陷修复**。这决定了本批的风险结构：

1. **最大的技术不确定性在 FB1**，而它已被一条判据消解 —— 「**只在空行边界切分**」。CommonMark 的全部行内语法（未闭合行内 code、半截链接/图片、setext underline、GFM 表格分隔行）**都不能跨越空行**，因此这一条口径一次性消解了所有半截语法反例，无需逐类规则。剩余的跨空行块级容器只有围栏与 `$$`，用一个行扫描器的栈状态即可。
2. **最大的工程量在 FB7，但它的核心难点是假的。** 分诊档 §1 FB7 写「合并需 permissionId↔toolCallId join，无纯模块做过」，D53 ② 写「需打通 permissionId↔toolCallId 关联」—— 【实测】**Claude 路径上二者本就是同一个字符串**，且这个相等已经引发过一次 P0 事故并被回归测试钉住。真正需要「打通」的只有 Codex 路径。⇒ L 档的核心不确定性消掉大半，剩下的是渲染形态与安全回落。
3. **最大的隐藏风险在 FB9，且不在渲染层。** 两个地雷都在渲染代码之外：`electron-builder.yml:64` 已有一行 `"!node_modules/katex/**"`（mermaid 迁 CDN 时的遗留裁剪），不删则打包版公式**静默失效**；`globals.css:81-84` 的「无 bundled webfont」红线与 KaTeX 自带 woff2 字体正面冲突。
4. **最脆弱的一件是 FB6，因为它没有安全网。**【实测】「head 是回合首子元素」这条事实**没有任何测试钉住** —— `ChatTurn` 是 `memo(function ChatTurn…)`，而 `messageTimelineWiring.test.ts` 的定位器只认 `ts.FunctionDeclaration`，其 JSX 子树从未进入任何 AST 断言。⇒ FB6 是**零回归网改造**，必须先补钉子再动结构。

### 本规格内已决、不再复议

| # | 裁定 | 落点 |
|---|---|---|
| ① | FB1 走「**空行边界切分 + 高水位单调**」，不做通用 markdown 增量解析器 | §1.2 / §1.3 |
| ② | FB1 的渲染必须**分段**（`segments.map(<ChatMarkdown/>)`），不是把整个 `closedPrefix` 喂给一个 `<ChatMarkdown>` | §1.4 |
| ③ | FB4 的 `splitTurnBody` **整体退役改名**，不保留旧名 alias | §4.2 |
| ④ | FB7 的关联键 = **`block.permissionId` ↔ tool_call `block.id`**，不发明启发式配对 | §6.2 |
| ⑤ | FB2 的 copy 按钮**不做 hover-only**（既有红线 F-B15） | §2.3 |
| ⑥ | 工具 IN/OUT 块不加 copy —— 【实测】**渲染路径层面天然成立**，不需要显式分叉逻辑 | §2.2 |

---

## 红线（本批一字不动）

| # | 红线 | 逐字锚点 | 为什么它在本批有被误伤的风险 |
|---|---|---|---|
| **R1** | **D33 Composer 内状态行** | `middleColumnLayout.ts:555` `resolveIdleStatusText` · `:654` `shouldShowStatusLine` · `:537` `sessionStatusLineWrapperClass`，三者调用点各**只有一个**且全在 `ChatComposer.tsx`（`:2313` / `:2329` / `:2853`） | FB6 要移动「状态行」，名字撞车。【实测】回合行驱动链三模块（`turnStatus.ts` / `turnHead.ts` / `chatTimelineLayout.ts`）**全仓 rg 均不 import `middleColumnLayout.ts`**；`attachments.ts:406-407` 头注逐字「the sole consumer is now the TURN HEAD (turnStatus.ts), not the composer」⇒ 两条行**信息不同源、代码不相交** |
| **R2** | **`turnCopy.ts` 安全边界** | `turnCopy.ts:3-17` 头注：`Tool toolInput/toolOutput and thinking bodies are excluded — a raw tool output can carry absolute paths, environment values or secret fragments` | FB2 加 copy，D53 ① 已明文「工具 IN/OUT 块不加，安全边界不动」 |
| **R3** | **memo 恒等三支柱** | `MessageTimeline.tsx:946-952` 头注：`It only holds because stabilizeTurns keeps this turn's identity … the ticking props reach the last turn only … both lookup callbacks are useCallback-stable`；`:173-182` + `STATIC_NOW_MS = 0` | FB1 每 token 重切分、FB4/FB6 改 `ChatTurn` 子树 —— 两者都可能顺手加 prop 或引入定时器 |
| **R4** | **`keepMounted` 折叠不变量** | `MessageTimeline.tsx:1276-1284` 头注：`keepMounted is the whole of §10-C's "expanded tool rows survive a collapse"` + Tailwind preflight 的 `[hidden] display:none !important` | FB4 重构折叠壳时最容易丢 |
| **R5** | **`chatSessions.ts` 是红线 store** | `messageTimelineWiring.test.ts:589` 逐字 `chatSessions.ts is a red line` | FB1 的高水位状态、FB7 的关联结果都可能被误放进 store |
| **R6** | **三轴隔离：不碰终端轴** | D48 ③（`ledger.md:92`）「不改旧终端轴 `AgentPickerMenu`/`SessionBar`」 | 本批全部改动在聊天轴；`StatusLine.tsx`（374 行，唯一消费者 `AgentPanel.tsx`）**与本批两条状态行都不同树**，不得顺手统一 |
| **R7** | **D24 工具行口径** | `ledger.md:68`：`工具行口径：动词开头、无图标、无边框的灰阶单行`；`ledger.md:75` D31 复核「工具行**维持 Cursor 口径**（D24 不动）」 | FB7 合并后要在工具行里加授权信息，**徽记必须是灰阶纯文本**，做成图标/彩色 chip/带背景标签即回滚 D24 |

---

## §0 边界、前置事实与锚点总表

### 0.1 本批做什么

| 代号 | 内容 | 性质 | 档 |
|---|---|---|---|
| FB1 | 渐进 markdown 渲染（闭合块实时切、未闭合尾部纯文本） | **D26/T-29 改判** | M |
| FB2 | 正文 markdown 代码块加 copy | 新能力（D53 ①） | S |
| FB3 | 用户气泡点击展开/收起 | 已登记欠账兑现 | S/M |
| FB4 | 所有 text 段恒在折叠组外 | **T-31 §4.2/§4.4 改判** | M |
| FB6 | 状态行移至回合底部 | **T-31 §4.7 改判** | M |
| FB7 | `Ran X` + `Allowed Bash — X` 双行合并 | 设计盲区修复（D53 ②） | L |
| FB8 | `Thought for 1702s` 裸秒换算 | 缺陷 | S |
| FB9 | LaTeX `$$…$$` 渲染 | 新能力（D53 ③） | M + 安全评审 |

### 0.2 本批**不**做什么（显式越界声明）

- **FB5 / FB10 / FB11** —— FB5 是答复项（数据不丢，分诊档已答）、FB10 是用户机指引（`~/.bashrc` 编码损坏，本仓不改码）、FB11 在 FB1 落地后**真机重评**。三者本批零代码改动。
- **合批窗口常量调参** ——【实测】`COALESCE_WINDOW_MS = 45`（`agent-host/coalescingEmitter.ts:29`）与 `RUNTIME_EVENT_FLUSH_MS = 16`（`stores/chatSessions.ts:975`）本批**只读不改**。分诊档 FB11 说「如仍块状，两个常量可调」—— 那是 FB1 落地后**重评**时的另一张票。
- **全局 UI 语言口径** —— F456 §10.1 Q3 至今待拍板。【实测】本批又发现一处中文用户可见文案：`questionCardModel.ts:399` `` `codex 还提供了 ${count} 个本版本未支持的选项，未显示` ``。本批**不擅改语言**，只守内部一致性（新增文案与所在行其余部分同语言）。
- **`ToolRows.tsx:230/233/262/285/304` 五处 `leading-[1.55]` 任意值** —— F456 §10.3 ③ 已另立票的既存违规。FB7 会改这个文件，**不得顺手改 leading**。
- **用户气泡 clamp 档位（六行）本身** —— FB3 只加展开开关，不改 `line-clamp-6` 的档位。

### 0.3 前置事实：F456 已落地物清单（本批的地基）

【实测 HEAD `99dfd78`】以下是 F456 四片留下、本批必须在其上施工的东西：

| 落地物 | 位置 | 对本批的意义 |
|---|---|---|
| `turnAnswerContainerClass()` = `'rounded-sm border border-border p-3.5'` | `chatTimelineLayout.ts:212-214` | FB4 交错后「每段各挂一个容器」的对象 |
| 头注「Mounted on the `answer` segment only … **at most one box per turn**」 | `chatTimelineLayout.ts:206-210` | **FB4 落地后成假话**，必须同批改写 |
| `line-clamp-6` 无条件 clamp | `chatTimelineLayout.ts:87-89` `userBubbleTextClass()` | FB3 的改造对象 |
| 头注已订正「a user-owned expand toggle is a follow-up ticket, **NOT part of the F456 batch**」 | `chatTimelineLayout.ts:68-86` | **FB3 就是那张后续票**，头注无需再改 |
| `VERBS`（12 词冻结表）· `VERB_ROTATION_SECONDS = 6` · `↑ {chars} chars` 拼装 | `attachments.ts:349-362` / `:376` / `:490` | FB6 **只挪位置，这些一字不改** |
| `stalled` 档 + `turnStatusToneClass` | `turnStatus.ts:37-49` / `chatTimelineLayout.ts:254-258` | 同上 |
| `leading-relaxed` 三处散文点 + 计数断言 | `messageTimelineWiring.test.ts:922-934` `countIn(CHAT_CODE,'leading-relaxed') === 3` | **FB1 的条件必红点**（见 §1.6） |

### 0.4 锚点总表（高漂移文件用「符号名 + 行号 + 关键原文」三元锚）

**纪律**：`MessageTimeline.tsx`（1748 行）· `toolCard.ts`（828 行）· `questionCardModel.ts`（754 行）三份为高漂移，行号只是索引，**关键原文才是判据**；施工时行号对不上，以符号名 + 原文重新定位，**不得按行号盲改**。施工前跑 `git log --oneline -1` 确认仍是 `99dfd78`，已前移则逐条复取。

#### 0.4-a `MessageTimeline.tsx`

| 符号 / 位置 | 行号 | 关键原文（判据） | 用于 |
|---|---|---|---|
| `STATIC_NOW_MS` + 第二时钟纪律 | `:173-182` | `Only the last turn can read the second clock … made React.memo useless.` | R3 / §1.5 |
| `PendingTurnHead` 挂载点 | `:526-528` | 在 `turns.map(…)` 之后、session 失败块之前 | §5.4 |
| `UserBubble` 函数 | `:737-848` | `<article className="flex justify-end">` | §3 |
| 气泡 `title` 全文出口 | `:797` | `title={fullText \|\| undefined}` | §3.3 |
| clamp 容器挂点 | `:835` | `<div className={userBubbleTextClass()}>` | §3.2 |
| `ChatTurn` memo 头注 | `:946-952` | `It only holds because stabilizeTurns keeps this turn's identity` | R3 |
| `const ChatTurn = memo(function ChatTurn` | `:954` | —— | §5.6（AST 定位器不认它） |
| `splitTurnBody` 唯一生产调用点 | `:979` | `const { process, answer } = useMemo(() => splitTurnBody(items), [items]);` | §4.2 |
| 折叠 state 惰性初始化 | `:1156-1163` | `answerEmpty: answer.length === 0`（`:1161`） | §4.4 |
| 强制展开合取 | `:1169` | `const processShellOpen = permissionLock \|\| processOpen;` | §4.4 |
| 「head IS the trigger」头注 | `:1183-1188` | `The head IS the trigger (§4.8)` | §5.3 |
| 可折叠判定 | `:1189` | `const collapsible = process.length > 0;` | §4.2 / §9.1 |
| `ChatTurn` JSX 骨架 | `:1234-1320` | `<section className={chatTurnClass()}>` … `<TurnFooter …/>`（`:1317`） | §4 / §5 |
| head 槽（折叠分支） | `:1265-1266` | `<CollapsibleTrigger className={cn(turnHeadClass(), 'w-full disabled:cursor-default')}>` | §5.2 |
| `keepMounted` 头注 | `:1276-1284` | `keepMounted is the whole of §10-C's "expanded tool rows survive a collapse"` | R4 |
| process 面板 | `:1287` | `className={cn(turnProcessPanelClass(), turnBodyClass())}` | §4.5 |
| answer 容器挂点 | `:1308-1309` | `{answer.length > 0 && (<div className={cn(turnBodyClass(), turnAnswerContainerClass())}>` | §4.5 |
| `TurnFooter` | `:1317` | `<TurnFooter metadata={metadata} copyText={turnActive ? '' : copyText} nowMs={footerNowMs} />` | §5.2（底部已有一条 meta 行） |
| `PendingTurnHead` 定义 | `:1355-1390` | `promptChars: sendStatus.promptChars`（`:1372`，**必填无兜底**） | §5.4 |
| `TurnHeadContent` | `:1435-1465` | 四分支 | §5.2 |
| 流式期纯文本兜底 `<p>` | `:1557-1564` | `if (shouldRenderMarkdown({ blockId: item.block.id, streamingBlockId }))` | §1 |
| footer 存在条件 | `:1683` | `if (!line && copyText.length === 0) return null;` | §5.2 |
| `TurnCopyButton` | `:1704-1739` | `navigator.clipboard.writeText` · `setTimeout(1500)` · `Check`/`Copy` 图标 | §2.3 |

#### 0.4-b 低漂移纯模块

| 文件 | 行号 | 关键原文 | 用于 |
|---|---|---|---|
| `chatMarkdownPolicy.ts` | `:22-40` | 模块五条安全规则（**真正的安全规则在此，不在 `ChatMarkdown.tsx`**） | §8.2 |
| 同上 | `:320-324` | `a fence is not a fence until its closing ``` arrives … One reflow at the end is the price; a strobing one is not.` | §1.1 |
| 同上 | `:326-328` | `export function shouldRenderMarkdown({ blockId, streamingBlockId })` … `return blockId !== streamingBlockId;` | §1.4 |
| 同上 | `:352-361` | `the gate was not monotonic … two extra full reflows` | §1.3（单调性是既有纪律） |
| 同上 | `:412` | `BLOCK_GAP = 'mt-3.5 first:mt-0'` | §1.4（分段间距陷阱） |
| 同上 | `:524-526` | `chatMarkdownCodeBlockClass()` = `${BLOCK_GAP} overflow-x-auto rounded-sm border border-border bg-muted/50 p-3 text-code leading-normal` | §2.2 |
| 同上 | `:717-751` | `CHAT_MARKDOWN_POLICY = { remarkPlugins: [...] as const, rehypePlugins: [] as const }` | §8.3 |
| `chatTurn.ts` | `:29-35` | `A notice therefore terminates the answer tail (§4.4's rule is literal…)` | §4.2（本批推翻） |
| 同上 | `:128-132` | `TurnItem` / `TurnItemKind` | §4.2 / §6.5 |
| 同上 | `:158-166` | `answer is the trailing run of text items` + F-B6 流式稳定性 | §4.2 |
| 同上 | `:168-176` | `while (start > 0 && items[start - 1].kind === 'text') { start -= 1; }` | §4.2 |
| 同上 | `:203-206` | `if (input.hasUnresolvedPermission) return true;`（**必须保持首返回**） | §4.4 / R7 |
| `chatTimelineLayout.ts` | `:6-15` | `the pinned bubble band and its containing block must never acquire overflow-*, transform, filter or contain` | §5.5 |
| 同上 | `:17-32` | 间距算术头注（`turn body gap-2.5 = 10 head / process / answer / footer`） | §5.5（顺序描述本批倒置） |
| 同上 | `:87-89` | `return 'select-text space-y-2 line-clamp-6';` | §3 |
| 同上 | `:156-158` | `turnHeadClass()` = `flex min-w-0 items-center gap-1.5 text-meta tabular-nums text-muted-foreground` | §5.2 |
| 同上 | `:161-163` | `turnFooterClass()` = `flex flex-wrap items-center justify-end gap-2 …` | §5.2 |
| 同上 | `:165-172` | `Copy button: 24px ghost icon button… **Always visible — no opacity-0 / group-hover: pair (F-B15)**` | §2.3 **红线** |
| 同上 | `:206-214` | `Mounted on the answer segment only … at most one box per turn` + `'rounded-sm border border-border p-3.5'` | §4.5 |
| `toolCard.ts` | `:114-119` | `TimelineItem = text \| question \| permission \| toolGroup` | §4.2 / §6.5 |
| 同上 | `:155-181` | `case 'permission_request': flush(); items.push({ kind: 'permission', block, blockIndex });` | §6.5（**flush 打断工具组**） |
| `questionCardModel.ts` | `:312-316` | `PERMISSION_ALLOWED = 'Allowed'` / `_SESSION = 'Allowed for session'` / `_DENIED = 'Denied'` / `_STOPPED = 'Denied, turn stopped'` | §6.4 |
| 同上 | `:403-407` | `derivePermissionVerb(block)`：`decision` 优先，回落 `block.allowed` | §6.4 |
| 同上 | `:409-412` | `auto: <reason>` when the Host answered on the user's behalf | §6.4 |
| `turnTiming.ts` | `:110-130` | `` arg: `for ${Math.round(input.durationMs / 1000)}s` ``（`:127`） | §7 |
| 同上 | `:142-148` | `formatWorkedForDuration`（有分钟档，**无小时档**） | §7 |
| `ToolRows.tsx` | `:76-79` | `'group/row flex w-full items-baseline gap-1.5 text-left text-markdown leading-normal'` + `view.failed ? 'text-destructive' : 'text-muted-foreground'` | §6.4（Denied 的天然载体） |
| `ChatCodeBlock.tsx` | `:32-39` | `export const ChatCodeBlock = memo(function ChatCodeBlock({ code, language })` | §2.2 |
| 同上 | `:57-59` | `<pre className={chatMarkdownCodeBlockClass()}><code>` —— **`<pre>` 无 `relative`** | §2.2 |
| `ChatMarkdown.tsx` | `:85-91` | `REMARK_PLUGINS = [[remarkGfm, …], remarkBreaks]` · `const REHYPE_PLUGINS: [] = [];` | §8 |
| 同上 | `:303-312` | `code: ({…}) => { if (isFencedCodeBlock(…)) return <ChatCodeBlock …/> }` | §2.2 |
| 同上 | `:320-328` | `ChatMarkdown` memo 头注：`text is the only prop, so the comparison is exact.` | §1.4 |
| `permissionBridge.ts` | `:38-42` | `function nextPermissionId(toolUseId?: string) { if (toolUseId && toolUseId.length > 0) return toolUseId; … return \`perm-${Date.now()}-${permSeq}\`; }` | §6.2 **本批最重要的一条取证** |
| `codexRuntime.ts` | `:2505-2507` | `return \`codex:${sessionId}:${idKey(requestId)}\`;` | §6.2（Codex 路径异构） |
| `stores/chatSessions.ts` | `:786-788` | `id: event.payload.permissionId,` / `type: 'permission_request',` / `permissionId: event.payload.permissionId,` | §6.2 |
| `electron-builder.yml` | `:64` | `- "!node_modules/katex/**"` | §8.5 **地雷** |
| `styles/globals.css` | `:81-84` | `No bundled webfont: this repo has no @font-face and no font assets; naming a non-system family here is a blank cheque (design-system red line)` | §8.4 **红线冲突** |

---

## §1 FB1 · 渐进 markdown 渲染（D26/T-29 改判）

### 1.1 D26 到底防的是什么（改判的前提）

【实测】`chatMarkdownPolicy.ts:320-324` 逐字：

> `a fence is not a fence until its closing ``` arrives … One reflow at the end is the price; a strobing one is not.`

⇒ **D26 的理由只有一条：围栏未闭合导致的反复翻转（strobe）。它从未主张「完成前不许有 markdown」。**

第二条既有纪律更关键 —— `chatMarkdownPolicy.ts:352-361`（`deriveStreamingBlockIds` 头注）逐字：

> `the gate was not monotonic … an authorization round-trip flipped blocks to Markdown mid-stream and back again — two extra full reflows`

⇒ **单调性不是本批发明的要求，是已被两个真实缺陷验证过的既有纪律。** 新方案继承它是硬要求，不是加分项。

**改判表述**（写进注释与台账，避免下次读档误以为 D26 被全盘推翻）：
> D26 的**目标**（已读内容不得反复翻转）**保留**；它的**手段**（用时间轴「完成前/后」做判据）升级为**位置轴**（已封存前缀 / 未闭合尾部）。

### 1.2 裁定 ①：切分算法 —— 只在空行边界切

**新增纯函数**（落 `chatMarkdownPolicy.ts`，与既有门函数同处，保证 node 环境可真值表化，且**留在已被 F-C5 源码扫描覆盖的文件内**）：

```
splitClosedPrefix(text) -> { segments: string[]; openTail: string }
```

**三条规则，其余一律归 `openTail`**：

| # | 规则 | 内容 |
|---|---|---|
| **R-1** | **切点必须是空行边界** | `closedPrefix` 只能结束于一个空行之后，且必须落在行边界上 |
| **R-2** | **不在开放围栏内** | 行扫描维护围栏栈：` ``` ` / `~~~` 开栏记录**字符与长度 N**（缩进 ≤3 空格；≥4 空格是缩进代码块不是围栏），闭栏需**同字符、长度 ≥N、无 info string**。`$$`（FB9）按第三种围栏**同构**处理。未闭合 ⇒ 从开栏行起全部归 `openTail` |
| **R-3** | **前瞻一行** | 切点后的下一个非空行若是 `列表标记` / `>` / `4 空格缩进` / `\|`，该切点作废，继续向后找 |

**为什么「只在空行切」能一次性消解全部反例**（这是本条最重要的论证）：

【实测 CommonMark 语义】**所有行内语法都不能跨越空行** —— 未闭合的行内 code、`*强调*`、`[链接`、`![图片`、setext underline（`===`/`---` 必须紧贴段落，中间无空行）、GFM 表格的分隔行（表格内不含空行）。⇒ 用户指令里点名要逐类给判据的「未闭合的行内 code / 半截链接 / 半张表 / setext」**全部被 R-1 一条覆盖**，无需为它们各写一条规则。R-2 只处理**跨空行的块级容器**（围栏、数学块），R-3 只处理「空行后仍可能是同一块的延续」（loose list、缩进代码块、脚注定义续行、blockquote 续接）。

**逐类结论表**（用户指令要求逐类给出，此处给的是**该类为何不需要独立规则**）：

| 语法类 | 判据归属 | 结论 |
|---|---|---|
| 围栏代码块（``` / ~~~，含 info string、不同围栏长度、缩进围栏） | **R-2** | 唯一需要栈状态的一类；缩进 ≥4 空格不算围栏 |
| 未闭合行内 code `` ` `` | R-1 覆盖 | 不能跨空行 ⇒ 恒与其段落同在 `openTail` 或同被封存 |
| 列表（有序/无序/任务） | R-1 + R-3 | **最后一项不单独判闭合**；整个列表要么其后有空行且下一行非延续（整体闭合），要么整体在 `openTail` |
| GFM 表格 | R-1 覆盖 | 表头 + 无分隔行 = 段落；两者间无空行 ⇒ **半张表恒在 `openTail`** |
| `$$…$$` 数学块 | **R-2**（第三种围栏） | 与 FB9 联动；FB9 未落地前**无生产者**，见 §13 |
| 标题 / 引用块 / thematic break | R-1 + R-3 | 引用块续接由 R-3 挡住 |
| 半截链接 `[a](htt` / 图片 `![a](` | R-1 覆盖 | 不能跨空行 |

**保守优先的具体口径**：**任何一条规则无法判定时，一律归 `openTail`。** 代价是「无空行的紧凑长回答」永远无切点 ⇒ `segments = []`，退化为**今天的纯文本行为**。这是**安全降级，不是缺陷** —— 它恰好等于 D26 现状。

**已知偏差（接受，须写进注释）**：`closedPrefix` 里的 `[a]` 引用了定义在 `openTail` 的 `[a]: url` ⇒ 先渲染为字面文本，定义到达后才变链接。这是**行内元素级**的一次变化，不改块结构，且 chat 场景里引用式链接罕见。

### 1.3 裁定 ②：前缀单调性（防频闪核心）

**形式化**：流式文本构成只追加的前缀链 `t₁ ⊑ t₂ ⊑ …`。要求：

- **(i)** `P(tₖ) ⊑ P(tₖ₊₁)` —— 已封存前缀只增不减；
- **(ii)** `render(P(tₖ))` 是 `render(P(tₖ₊₁))` 的 **DOM 前缀** —— 已渲染节点不被重新解释。

**纯 `splitClosedPrefix` 不保证 (i)。** 会被后续字符推翻的语法：setext underline（段落→标题）、表格分隔行（段落→表格）、列表 tight→loose 转换（`<li>text</li>` → `<li><p>text</p></li>`，**真实重排**）、缩进代码块延续、脚注/链接定义、围栏与 `$$` 开栏。

**关键论证（决定了本条可行）**：

- **R-2 类（围栏状态）不可能被追加推翻** —— 行扫描是确定的左→右过程，前缀内的围栏状态**只由前缀自身决定**，追加无法把过去的行变成开栏。
- **只有 R-3（前瞻）会被推翻**，其后果是「一个 list/blockquote 被拆成两个同类块 + tight/loose 差异」，属**局部 DOM 差异，不是错误渲染**。

**强制手段裁定：高水位（hwm）+ 完成时全量重渲染。**

1. 维护 `hwm = 已发布 closedPrefix 长度的最大值`；每次发布 `max(hwm, splitClosedPrefix(t).length)`。
   ⚠️ **「全量重算取 max」必须有跨渲染的记忆** —— 单纯每次重算取当次值**不够**，因为函数自身会返回更短值。
2. hwm 冻结的代价（某个块被永久拆成两个同类块）在 `message.completed` 时由**现有整块 markdown 路径**一次性修正 —— 那正是 D26 已经接受并支付过的「最后一次重排」。
3. **禁止**用 hwm 之外的手段（例如「渲染过就不再重算」）：那会让围栏闭合后的**正确合并**也一起丢失。

### 1.4 裁定 ③：触发粒度、成本上界与**分段渲染**

**扫描成本可忽略 ⇒ 全量重扫（无状态纯函数）。**

【实测】节拍：`COALESCE_WINDOW_MS = 45`（`coalescingEmitter.ts:29`）串 `RUNTIME_EVENT_FLUSH_MS = 16`（`chatSessions.ts:975`）⇒ 切分触发频率上界 **≈ 22 次/秒**。
⚠️【推测】以下生成时长为**假设，非实测**：5KB/20s ≈ 440 次 flush、累计约 1.1MB 字符行扫描 ⇒ 全程 <10ms；100KB/400s ≈ 8800 次、累计约 440MB ⇒ 累计秒级，但**单次最坏 100KB ≈ 亚毫秒~1ms**，远低于一帧。⇒ 增量扫描器状态（跨 flush 保存围栏栈）的复杂度**不值这点收益**。

**真正的 O(n²) 不在扫描，在 remark/rehype 重解析。**【实测】`ChatMarkdown.tsx:320-328` 头注逐字：`every completed paragraph in the in-flight turn would re-run the full remark/rehype pipeline once a second … text is the only prop, so the comparison is exact.` ⇒ 若把整个 `closedPrefix` 喂给一个 `<ChatMarkdown>`，它每增长一次就整段重解析 + 全量 DOM diff。

⇒ **裁定：切分全量重扫；渲染必须分段。**

```
segments.map((s, i) => <ChatMarkdown key={i} text={s} />)
```

已有段的字符串**恒等** ⇒ `ChatMarkdown` 的 memo 全部命中 ⇒ 总解析成本回到 **O(n)**。这也是 §1.2 让 `splitClosedPrefix` 返回 `segments: string[]` 而非单个 `closedPrefix` 字符串的原因。

⚠️ **施工陷阱（必须处理，否则观感回归）**：每段是**独立的 markdown 根**，`BLOCK_GAP` 的 `first:mt-0`（`chatMarkdownPolicy.ts:412` `'mt-3.5 first:mt-0'`）会让**段间距塌成 0px**。须在段容器上补间距，且**不得新造第三档**（F-C4「恰好两档」断言盯着这里，见 §1.6）。处置见 §12 Q1（本规格建议：段容器用 `space-y-3.5`，与 `BLOCK_GAP` 同档同值，不是新档）。

⚠️【推测】`<ChatMarkdown>` 每段解析耗时（毫秒级/10KB）是**估计，无实测**，而分段决策建立在它之上 ⇒ **施工前须以一条真实 100KB 回答跑一次微基准**，否则 §1.4 的结论是信念而非证据（见 §13 ③）。

### 1.5 裁定 ④：memo 相容性（R3 的兑现）

**结论：纯函数 + `useMemo(…, [text])` 落在 `TurnItemView` 的 `text` 分支内；hwm 用 `useRef`；一律不进 store、不新增 `ChatTurn` prop。**

| # | 论证 | 依据 |
|---|---|---|
| 1 | **不进 store** | `messageTimelineWiring.test.ts:589` 逐字 `chatSessions.ts is a red line`（R5，既有红线直接继承） |
| 2 | **不新增 prop** | 切分只消费 `item.block.text` 与已有的 `streamingBlockId` ⇒ `ChatTurnProps` 不变 ⇒ `ChatTurn` memo 比较面不变 ⇒ `MessageTimeline.tsx:946-952` 的三根支柱（`stabilizeTurns` 身份 / 时钟只到最后回合 / `useCallback` 稳定）全部不动 |
| 3 | **`STATIC_NOW_MS` 纪律** | 切分结果**只依赖 `text`**，不依赖 `nowMs` 或任何时钟。**明令禁止**用 `setInterval` / 节流定时器驱动重切 —— 那等于重造 `:173-182` 记录的「每秒改一个 prop、让 `React.memo` 失效」缺陷。重切**只由新 token 到达（`text` 变化）驱动** |
| 4 | **hwm 落点** | `TurnItemView` 未被 memo，但组件实例由 `turnItemKey(item)` 决定；key 不变则 `useRef` 跨渲染存活 —— ⚠️ **该 key 稳定性须施工时实测确认**，不成立则须上提到 `ChatTurn` 的 `Map<blockId, number>`（见 §12 Q2） |
| 5 | **影响面收敛** | 切分只在有 `streamingBlockId` 的块发生，即**只在在飞回合**；在飞回合本就每 token 重渲染，其余回合的 memo 完全不受影响 |

### 1.6 测试合同变更

| file:line | 用例名 / 断言 | 处置 |
|---|---|---|
| `chatMarkdownPolicy.test.ts:325` | `F-C3: the block still streaming stays plain text` | **退役换新** —— 断言仍会绿（流式块确实不走**整块** markdown），但用例名与承重命题已过期，须改判为「流式块走**切分渲染器**」 |
| `chatMarkdownPolicy.test.ts:482` | `derivation and gate compose to the behaviour the ARD ruling states` | **退役换新** —— 断的是 ARD 旧口径（流式 = 纯文本），整体改判 |
| `chatMarkdownPolicy.test.ts:329/333/337/344` | completed / idle / restored / IDENTITY 判定 | **不受影响**（非流式块 → 整块 markdown，行为不变） |
| `chatMarkdownPolicy.test.ts:376~474` | `deriveStreamingBlockIds` 真值表 7 组 | **不受影响** —— 「哪个块在流」仍需要且语义不变 |
| `messageTimelineWiring.test.ts:587-603` | `T-29: the text branch is gated by shouldRenderMarkdown and renders ChatMarkdown` | **必红（三处）**：`expectCalled('shouldRenderMarkdown({ blockId: item.block.id, streamingBlockId })')` 调用形状、`<ChatMarkdown` 出现次数 `.toBe(1)`、纯文本 `<p>` 的精确类串。⚠️ 注释里的 `chatSessions.ts is a red line`（`:589`）是**必须继承的约束**，不得随用例一起删 |
| `messageTimelineWiring.test.ts:922-934` | `countIn(CHAT_CODE, 'leading-relaxed') === 3` | **条件必红**：尾部纯文本若**复用同一处 `<p>`** 则绿；新增第二个 `leading-relaxed` 出现处即红 |
| `chatMarkdownPolicy.test.ts:649/686/692` | 两档间距 / 恰好两档 / `first:mt-0` | **风险红** —— 分段容器补间距时若新造档位即红（见 §1.4 陷阱、§12 Q1） |
| `chatMarkdownRender.test.ts` F-C6 全组 | GFM / 链接 / 脚注 / 安全五条 / 间距快照 | **不受影响** —— 直接对固定文本渲染 `ChatMarkdown`，不经过门 |
| `chatMarkdownPolicy.test.ts:1113-1312` | F-C5 源码扫描（禁用构造） | **不受影响，前提是新函数写进 `chatMarkdownPolicy.ts`**。⚠️ 新建文件会**脱离扫描面**（不红，但留覆盖缺口）—— 这是 §1.2 要求落在该文件内的第二个理由 |

---

## §2 FB2 · 正文代码块 copy（D53 ①）

### 2.1 范围（D53 ① 已澄清，不再复议）

【实测 `ledger.md:97`】D53 ① 逐字：「加 copy 的是**正文 markdown 代码块**（模型输出给用户去终端执行的指令，如 git push）；工具调用 IN/OUT 块**维持防外泄安全边界不动**（`turnCopy.ts:6-10` 不改判）」。

### 2.2 裁定：工具 IN/OUT 不加 copy —— **渲染路径层面天然成立**

这是本件最重要的一条实测，它把一条「需要小心维护的红线」降级为「结构上不可能违反的事实」：

| 证据 | 内容 |
|---|---|
| `ChatMarkdown.tsx:303-312` | `ChatCodeBlock` 的**唯一调用点**：markdown 正文中被 `isFencedCodeBlock` 判定为围栏代码块的节点 |
| `ToolRows.tsx:226-238` / `:250-270` / `:272-292` | 工具 IN/OUT 是**三处手写字面量** `<pre className="m-0 select-text overflow-auto whitespace-pre-wrap …">`，**不共用 `ChatCodeBlock`** |
| `rg 'ChatCodeBlock\|chatMarkdownPolicy' ToolRows.tsx toolCard.ts` | **零命中** —— 两套渲染路径在 import 层面零交集 |
| `messageTimelineWiring.test.ts:617-622` | 注释交叉印证：`tool IN/OUT is a mono transcript`，明文列为不经 markdown 路径 |

⇒ **「工具块不加 copy」不需要任何显式分叉逻辑**：改 `ChatCodeBlock` 根本到不了工具块。
⚠️ **但这条便利有个反向义务**：`[FB2-3]` 断言（§9.1）必须钉住「`ChatCodeBlock` 的调用点仍然只有 markdown 一处」，否则哪天有人让 `ToolRows` 复用 `ChatCodeBlock`，这条天然红线就会**静默失效**。

**另一条边界澄清**：`turnCopy.ts:3-17` 的排除规则（R2）是**「整轮复制」层级**的安全边界，FB2 是**「单代码块复制」**，复制对象是 `ChatCodeBlock` 的 `code` prop 本身，**不经过 `buildTurnCopyText` 的任何逻辑** ⇒ 两者是不同语义层，FB2 既不改判它、也不受它约束。

### 2.3 裁定：**不做 hover-only**（【与分诊措辞冲突】）

分诊档 FB2 写「正文代码块加**悬浮** copy」。【实测】本仓有一条明文相反的红线：

> `chatTimelineLayout.ts:165-172`：`Copy button: 24px ghost icon button… **Always visible — no `opacity-0` / `group-hover:` pair (F-B15)**`

理由（该头注自陈）：**只有鼠标才能发现的控件，触屏和键盘都够不到**。且它有测试钉住：`chatTimelineLayout.test.ts:239-243`。

⇒ **裁定：FB2 的按钮采用「常驻可见」的 ghost icon 形态，与 `TurnCopyButton` 同族。** 「悬浮」在分诊档里是**位置描述**（浮在代码块右上角），不是**显隐机制**；本规格按位置义施工，不引入 `opacity-0` / `group-hover:`。
若评审坚持要弱化视觉存在感，**唯一允许的做法**是降低常态不透明度到仍可辨的档位并配 `focus-visible` 增强，**不得**做成 `opacity-0`（见 §12 Q3）。

### 2.4 形态与复用范式

**复用 `TurnCopyButton` 的 clipboard 范式**【实测 `MessageTimeline.tsx:1704-1739`】，逐条对齐：

| 维度 | `TurnCopyButton` 现状 | FB2 沿用 |
|---|---|---|
| API | `navigator.clipboard.writeText(text)`，**无 `execCommand` fallback**，失败静默 return | ✅ 逐条沿用（不为 FB2 新造 fallback —— 那会让两个按钮的失败行为不一致） |
| 反馈 | `useState(copied)` + `setTimeout(1500)` 翻回 | ✅ |
| 图标 | `lucide-react` 的 `Check` / `Copy` | ✅ |
| 类串 | `turnCopyButtonClass()` = `'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-hover'` | ✅ **复用同一个类装配函数**，不新写类串 |
| a11y | `aria-label={label}` + `title={label}`，label ∈ {`Copied`, `Copy reply`} | ✅ 形态同构，文案改为 `Copy code` / `Copied` |

**定位**：【实测】`ChatCodeBlock.tsx:57` 的 `<pre>` **没有 `relative`**，`chatMarkdownCodeBlockClass()`（`chatMarkdownPolicy.ts:524-526`）返回串里也没有。⇒ 需要定位上下文。两条路：

- **（a，本规格取此）** 在 `ChatCodeBlock` 内**包一层 `relative` wrapper**，`<pre>` 保持原样。优点：`chatMarkdownCodeBlockClass()` 一字不动 ⇒ 该函数的既有断言（`chatMarkdownPolicy.test.ts:579` `overflow-x-auto`、`:702-703` 字号）全部不受影响。
- **（b）** 给 `chatMarkdownCodeBlockClass()` 加 `relative`。⚠️ 该函数是**纯类装配**且被多条断言盯着，改它会把一次组件改动扩散到策略层。**不采纳。**

⚠️ **`overflow-x-auto` 与绝对定位按钮的交互**【推测】：`<pre>` 自身是滚动容器，按钮若放在 `<pre>` 内部会**跟着横向滚动跑掉**；放在 wrapper 上（`<pre>` 之外）才能钉在右上角。这是取（a）的第二个理由，但**须 GUI 点验确认**（长行代码块横向滚动时按钮是否稳定，见 §10 G-3）。

---

## §3 FB3 · 用户气泡展开开关

### 3.1 定性：这是兑现一张已登记的欠账票

【实测】`chatTimelineLayout.ts:68-86` 的头注**已经订正过**，逐字：

> `a user-owned expand toggle is a follow-up ticket, NOT part of the F456 batch — that batch's four decisions (2026-08-18) do not include it, and this note used to claim otherwise.`

而分诊档 `2026-08-19-usage-feedback-0820-triage.md:14` 正是把 FB3 登记为**那张后续票**。
⇒ 本件**不需要新拍板，也不需要再改那句头注**（F456 已代改）。

⚠️ **文档口径滞后一处（不影响施工，记录以免误导）**：`docs/plans/2026-08-17-d48-t10-inspection-triage.md:211` 仍写着「展开控件归 F456 批」（旧口径未回填）。代码头注 + F456 规格 + 0820 分诊三处均已订正 ⇒ **以后三者为准**。

### 3.2 现状与改动点

| 锚点【实测】 | 现状 |
|---|---|
| `chatTimelineLayout.ts:87-89` | `userBubbleTextClass()` 返回 `'select-text space-y-2 line-clamp-6'` —— **无条件**六行 clamp |
| `MessageTimeline.tsx:835` | `<div className={userBubbleTextClass()}>` —— clamp 容器**只包正文 `<p>`** |
| `MessageTimeline.tsx:804-830` | 附件芯片区，与 clamp 容器是**兄弟**（同为外层 box 的直接子元素）⇒ **附件不吃六行预算** |
| `MessageTimeline.tsx:797` | `title={fullText \|\| undefined}` —— 全文出口 |
| `UserBubble` 全函数（`:737-848`） | **无任何 `onClick` / `onMouseEnter` / `onKeyDown`** —— 零交互 |

**改动形态**：`userBubbleTextClass()` 从无参纯函数改为**接受展开态的纯函数**：

```
userBubbleTextClass(expanded: boolean) -> string
   expanded ? 'select-text space-y-2' : 'select-text space-y-2 line-clamp-6'
```

展开态由 `UserBubble` 内的 `useState(false)` 持有（**不进 store**，R5 同源纪律：这是纯视图态，与折叠壳的 `processOpen` 同族）。

### 3.3 裁定：与 F10 振荡回路**不打架**的证明

这是本件唯一的技术风险，必须逐条证明而非声称。

【实测】F10 修的是一条 **`scroll-position → layout-height → scroll-position` 振荡回路**（`chatTimelineLayout.ts:68-86` 头注 + `docs/plans/2026-08-17-d48-t10-inspection-triage.md:206-216` 的 RCA）：旧实现是「**置顶时才 clamp**」，即 clamp 与否**取决于滚动位置**；而 clamp 与否又改变气泡高度、进而改变滚动位置 ⇒ 成环。F10 的修法是把它换成**无条件 clamp**，**斩断「滚动位置」这条入边**。

⇒ **FB3 不重新引入那条入边**：

| 判据 | FB3 | 旧 F10 前实现 |
|---|---|---|
| clamp 与否取决于什么 | **用户点击**（离散、外生事件） | **滚动位置**（连续、被高度反过来影响） |
| 是否成环 | ❌ 否 —— 高度变化不会反过来改变用户的点击 | ✅ 是 |

**形式化不变量（写进头注并断言）**：`userBubbleTextClass` 的入参**只能是用户意图态**，**永远不得**接受任何从滚动位置 / 元素几何 / `IntersectionObserver` 派生的值。这条比「FB3 现在是安全的」更强 —— 它挡住的是**下一个人**把 `isPinned` 接回来。

⚠️ **一个真实的次生效应（须点验，非振荡）**：展开一条长提问会**增加时间线总高度**。若此时用户处于贴底跟随态（`stickToBottomRef`），高度增长会触发一次滚动跟随。这**不是环**（一次性、由点击驱动、不会自激），但观感上是「点一下，页面跳了一下」。⇒ 列入 §10 G-5。

### 3.4 `title` 全文 fallback 的去留裁定

**裁定：保留，不动。** 三条理由：

1. **可达性不是可替代的**：`title` 服务读屏与悬停，展开开关服务鼠标/触摸点击 —— 两者受众不同，不是同一功能的两种实现。
2. T-31 §5.6 末句逐字要求「**气泡的 `title` 恒为全文**（读屏与悬停可达）」—— 该要求的前提（截断存在）在 FB3 后依然成立（默认态仍是六行 clamp）。
3. ⚠️【实测】`title={fullText}` **未被任何测试直接钉住**，是既有测试盲区。⇒ 本批**顺手补一条**（`[FB3-3]`，§9.1），把「保留」变成有网的保留。

**展开态下 `title` 是否该消失**：**不消失**。理由：`title` 与 clamp 无耦合，让它随展开态变化只会增加一个无收益的状态分支。

---

## §4 FB4 · 正文移出折叠组（T-31 §4.2/§4.4 改判）

### 4.1 被推翻的是什么

【实测 `chatTurn.ts:168-176`】现行 `splitTurnBody`：

```ts
let start = items.length;
while (start > 0 && items[start - 1].kind === 'text') { start -= 1; }
return { process: items.slice(0, start), answer: items.slice(start) };
```

即 T-31 §4.4 的「`answer` = **尾部连续的 text 项**」。连带一条 `chatTurn.ts:29-35` 头注自陈的规则：

> `A notice therefore terminates the answer tail (§4.4's rule is literal…)`

⇒ 一个以 error notice 结尾的回合 `answer === []`，**整个 body 连同全部中间正文一起折进 process**。用户 FB4 反馈的「正文被收进 Worked for 组、只有最后一小块在气泡里」正是这两条规则的合成结果。

**本批推翻**：所有 text 段**恒在折叠组外**，保持交错顺序。

### 4.2 裁定：`splitTurnBody` 整体退役，换「极大同类连续段」切分

**新形状**（落 `chatTurn.ts`，替换 `splitTurnBody`）：

```ts
/** 单一真源：一个 item 落在折叠组外还是组内。白名单——只列恒可见的 kind。 */
export type TurnSegmentKind = 'answer' | 'notice' | 'process';

export function turnItemPlacement(kind: TurnItemKind): TurnSegmentKind {
  if (kind === 'text') return 'answer';
  if (kind === 'notice') return 'notice';
  return 'process';           // toolGroup / permission / question / 未来任何新 kind
}

export interface TurnSegment<T> { kind: TurnSegmentKind; items: T[] }

/** 保序、run-length；相邻同类合并，交错天然成立。 */
export function segmentTurnBody<T extends { kind: TurnItemKind }>(
  items: readonly T[]
): TurnSegment<T>[];
```

**三条选型理由**：

1. **为什么是段列表，不是「扁平 item + `collapsible: boolean`」**：后者把「哪些相邻项共享一个折叠壳 / 一个容器」的**分组逻辑推回 `.tsx`**，而【实测 `vitest.config.ts:12` `environment: 'node'`】`.tsx` 的 JSX 结构在本仓**不可断言**。段列表让分组留在纯模块里，可真值表化。
2. **为什么不保留 `{process, answer}` 二分再加交错**：这两个字段名承载「一个 process、一个 answer」的语义，交错后必然出现多个 ⇒ **同名空壳**（§13 ①）。
3. **为什么保序而非重排**：`chatTurn.ts:29-35` 同一段头注记录了被拒绝的替代方案 —— 让 notice 对尾扫描透明会**破坏 T-05 D-5「block order, position unchanged」**。run-length 分段正是为了保序，该禁令对新谓词**仍然有效**。

**消费者影响面（穷尽）**【实测】：

| 位置 | 现状 | 改法 |
|---|---|---|
| `MessageTimeline.tsx:979` | `const { process, answer } = useMemo(() => splitTurnBody(items), [items])` | `const segments = useMemo(() => segmentTurnBody(items), [items])` |
| `:1141` | `hasProcess: process.length > 0` | `segments.some((s) => s.kind === 'process')` |
| `:1161` | `answerEmpty: answer.length === 0` | **改名重定义**，见 §4.4 |
| `:1189` | `const collapsible = process.length > 0;` | 同 `hasProcess`，且**两处必须仍由同一表达式派生**（`turnHead.ts:341-345` 的不变量依赖它） |
| `:1289` / `:1299` | `{process.map(renderItem)}` | 段内 map |
| `:1308-1312` | `{answer.length > 0 && …}` | 段列表渲染，见 §4.5 |
| `turnCopy.ts` | 走 `flattenTurnItems`，**从不消费 `splitTurnBody`** | ✅ **零改动**（R2 边界不受本件影响） |
| `chatTurn.ts:29-35` 头注 | notice 终止尾规则 | **必须改写** —— 新模型下 notice 不再吞掉它前面的正文 |

**顺带修掉的既有缺陷**：现状「以 error notice 结尾 ⇒ `answer === []` ⇒ 全部折进 process」在新模型下消失，正文各段独立、不再被尾部 notice 连坐。

### 4.3 裁定：`turnItemPlacement` 必须是**白名单**（与 FB7 的接口锁）

FB7 会改动 `TimelineItem` 的 kind 构成（§6.5）。两件的接口约定，**三条写进 `chatTurn.ts` 头注并配测试**：

1. **白名单，不得写成黑名单** —— `turnItemPlacement` 只枚举「恒可见」的 kind（今天是 `text`、`notice`），其余一律 `process`。这样 FB7 删掉 `permission`、或新增合并后的 kind，谓词**无需改动即仍然成立**。
2. **新 kind 的默认归属是 `process`（可折叠）** —— 这是**安全的默认**：折进去的内容有 `hasUnresolvedPermission`（`chatTurn.ts:214-216`）+ `defaultTurnProcessOpen` 首返回（`:204`）双重强制展开兜底；反之若默认恒可见，FB7 合并后的工具行会全部跑出折叠组，**直接抵消 FB7 的减行目的**。
3. **配一条对 `TurnItemKind` 联合穷尽的归属测试**（`satisfies Record<TurnItemKind, TurnSegmentKind>` 或逐成员断言），使 FB7 增删 kind 时**必红**。这是 FB4 与 FB7 之间**唯一的接口锁**。当前 5 个成员【实测 `toolCard.ts:114-119` + `chatTurn.ts:128`】：`text` / `question` / `permission` / `toolGroup` / `notice`。

### 4.4 裁定：空 process 时折叠头**仍渲染**，降级为非触发器

**裁定：渲染，但降级为「无 chevron 的纯统计行」。**

| # | 理由 | 依据 |
|---|---|---|
| 1 | **形态已经存在，不是新增** | `MessageTimeline.tsx:1292-1298` 的非折叠分支正是这个形态（`<div className={turnHeadClass()}><TurnHeadContent/></div>`），只是今天出现在顶部 |
| 2 | **不渲染会造成信息损失** | `deriveTurnHeadModel`（`turnHead.ts:346-352`）在无 process 时仍返回 `status` / `workedFor` / `stats`，只有全空才返回 `null` ⇒ 「一个纯 text 回合看不到 `Worked for 12s`」与 FB6 用户原话（「worked for/↑↓ 流量应在输出最下方动态显示」）**正相反** |
| 3 | **FB6 移底后语义更顺** | 底部行的第一职责是**回合小结**（时长 + 计数 + 流量），折叠只是它在有 process 时**兼任**的第二职责。空 process 时第二职责消失、第一职责保留 |

**连带：`answerEmpty` 必须改名重定义。** 【实测】它今天的含义是「折叠后只剩一行光杆」（`chatTurn.ts:192` 的 §4.3 末行规则）。新模型下只要有任一 text 段就非空 ⇒ 该输入**几乎恒 false**，成为**恒假死开关**（同名空壳）。

```
collapsedLeavesNothing = segments.every((s) => s.kind === 'process')
```

⚠️ 不改名的代价是具体的：`chatTurn.test.ts:254` 那条断言会变成**一条永远测不到真实路径的绿灯**。

**`defaultTurnProcessOpen` 的首返回不动**：`chatTurn.ts:203-206` 的 `if (input.hasUnresolvedPermission) return true;` 是安全红线（`:190-196` 头注：`burying an authorization card inside a collapsed shell re-opens round-2 point-check #5`），**必须保持首位**。

### 4.5 裁定：answer 容器在交错形态下 —— 每段各挂一个

【实测】`turnAnswerContainerClass()` = `'rounded-sm border border-border p-3.5'`（`chatTimelineLayout.ts:212-214`），挂载点 `MessageTimeline.tsx:1308-1309`。

**裁定 C1（主推）：每个 `answer` 段各挂一个容器（per-run）。**

| 维度 | 判定 |
|---|---|
| 语义 | 容器表达「这一段是模型给你的答复正文」，交错时每段都是 |
| 合并成一个框可行吗 | ❌ **DOM 上不可能** —— 会打乱 T-05 D-5 的块序禁令 |
| **框中框风险** | **低**：容器只包 `text` 段，`TurnItemView` 的 `'text'` 分支产出 `ChatMarkdown` 或一个 `<p>`，**二者都无边框**；`p-3.5` = 14px **正是** `chatMarkdownPolicy.ts:412` 的 `BLOCK_GAP`（`mt-3.5`）⇒「容器边到首块」= 「块到块」，不会双重内缩 |
| 真正的框中框来源 | **`notice`** —— `NoticeMessage` 自带 Alert 边框 ⇒ §4.2 把 notice 单列为**第三种段**，恒可见但**不进容器** |
| 真实风险 | **碎片化观感** —— 一个回合出现 3~5 个小边框盒堆叠。**代码判不了，必须 GUI 点验**（§10 G-6） |

**备选 C3**（仅在点验判定 C1 碎片化不可接受时启用）：仅当整个回合**只有一个 answer 段**时挂容器，多段时全部裸奔。代价是同一种内容在不同回合有两种外观。

**连带必改**：
- `chatTimelineLayout.ts:206-210` 头注的「**at most one box per turn**」在 C1 下成假话，**同批改写**；
- `messageTimelineWiring.test.ts:717-725` `[D3-7]` 的 `countIn(…, 'turnAnswerContainerClass()') === 1` 语义要从「源码里出现一次」改成「只挂在 answer 段上」的结构断言；
- F456 变异臂 **M-15**（「容器挂到 `process.map` 一侧」→ `[D3-7]`，`f456 spec:1743`）随原设计失效，**必须重定义**（§9.2 M-12）。

### 4.6 折叠壳的实现约束（**取证发现的硬约束**）

交错后 process 段有**多个**，而【实测 Base UI 实现】`Collapsible.Root` 只维护**一个** panelId：

> `node_modules/@base-ui/react/collapsible/root/useCollapsibleRoot.js:46-47`：`const [panelIdState, setPanelIdState] = React.useState(); const panelId = panelIdState ?? defaultPanelId;`
> Panel 渲染 `id: panelId`（`CollapsiblePanel.js:89`）；Trigger 取 `'aria-controls': open ? panelId : undefined`（`CollapsibleTrigger.js:51`）

⇒ **单 Root 挂多个 Panel 会产出重复 DOM id，且 trigger 的 `aria-controls` 只能指向其一。** 三条出路：

| # | 方案 | 判定 |
|---|---|---|
| **E1（主推）** | 每个 process 段一个**受控** `Collapsible`（`open={processShellOpen}`，共享 `ChatTurn` 的同一个 `useState`）；底部状态行做成普通 `<button aria-expanded aria-controls="id1 id2 …">`，各 Panel 显式传 `id` | ✅ **保留 `keepMounted` + `turnProcessPanelClass()` 的全部既有资产**（R4 不破，`chatTimelineLayout.ts:106-133` 那整篇动画路径论证不作废），测试 `messageTimelineWiring.test.ts:472-477` / `:575-577` 继续绿 |
| E2 | 不用 Base UI，process 段直接 `<div hidden={!open}>` | ⚠️ 结构最简、aria 最可控，但 `turnProcessPanelClass()` 与 `chatTimelineLayout.test.ts:94-161`（含与 `COLLAPSIBLE_PANEL_BASE_CLASS` 的真实 `cn()` 合并断言）**整批退役**。⚠️ 若走此路，**禁止**给自建 panel 加 `overflow-hidden`（`chatTimelineLayout.ts:6-15` 禁令，会破坏 band 的 containing block） |
| E3 | 每段各自成 Root + 各自 trigger | = §5.3 的 G2，触发器行数 = 段数，与 FB7 减行目的相悖 |

**本规格取 E1。** 理由：它是唯一**不作废任何既有资产**的方案，而 R4（`keepMounted`）是本批红线。

---

## §5 FB6 · 状态行移至回合底部（T-31 §4.7 改判）

### 5.1 被推翻的是什么，以及**没被推翻**的是什么

【实测】T-31 §4.7 的原始论证是「状态段与 `Worked for` 是**同一槽位的两态**」，理由是 `formatWorkedForRow(latencyMs)` 在 `latencyMs == null` 时返回 `null`（`turnTiming.ts:164-172`），而 `latencyMs` 只在 `message.completed` 后才有 ⇒ 运行中回合头本来就是空的。

**本批推翻的只有「槽位在顶部」这一点。**「同一槽位两态」**不推翻** —— status → workedFor 的切换仍在同一个 DOM 槽内发生，只是那个槽换了位置。

⇒ **这是本件最省事的部分**：`deriveTurnHeadModel` / `deriveTurnStatus` / `formatWorkedForRow` / `VERBS` / `↑↓` 计数 **一行都不用改**。F456 ④ 的全部产物按用户要求「全保留只挪位置」，**字面兑现**。

⚠️ 必须写进台账与注释，避免下次读档误判：**T-31 §4.7 的「同一槽位两态」仍然成立，本批改的是槽位坐标，不是槽位数量。**

### 5.2 裁定：DOM 形态与「跟随内容尾部」的实现

**head 仍在 `turnBodyClass()` 这一层（`MessageTimeline.tsx:1250`），只是从首位移到 `TurnFooter` 之前的末位**，与各内容段是**兄弟**：

```
<div className={turnBodyClass()}>
  {retryBanner}
  {segments.map(...)}            ← answer 容器 / notice / process 面板，交错（§4）
  {head && <底部状态行 />}         ← ★ 新位置
  <TurnFooter />
</div>
```

**「流式中跟随内容尾部」= 自然文档流末尾即可，不需要任何额外机制。**【实测】head 成为最后一个流内元素后，内容增长自然把它下推；`MessageTimeline.tsx:413-427` 的 `ResizeObserver` + `stickToBottomRef` 已经在跟随内容高度。

**「完成后停驻底部」**：见 §5.1 —— 槽位不动，两态在同一槽内切换。

**一条承重不变量（必须写进头注并断言）**：**底部行必须保持单行。**
【实测】`turnHeadClass()` 的 `min-w-0`（`chatTimelineLayout.ts:157`）+ `TurnStatusContent` 的 `<span className={cn('min-w-0 truncate', …)}>`（`MessageTimeline.tsx:1484`）今天已保证这点。若未来去掉 `truncate` 让它换行，则**每秒变化的文本会改变元素高度** → 与 stick-to-bottom follower 形成高度反馈。
⚠️ **诚实定性**：这**当前不构成振荡**（F10 的环是 `scroll → height → scroll`，此处高度变化不依赖滚动位置），但去掉 `truncate` 会把它推到危险边缘 ⇒ 断言守的是**职责边界**，不是「现在有 bug」。

### 5.3 裁定：折叠触发器的新位置（**形态建议 + 点验确认项**）

| 候选 | 形态 | 优点 | 代价 |
|---|---|---|---|
| **G1（主推）** | 触发器 = **底部状态行本身**（chevron 在行尾），所有 process 段受它统一控制 | 全回合只有 **1 个**触发器，行数最省（与 FB7 减行同向）；`MessageTimeline.tsx:1183-1188` 的「head IS the trigger」既有语义**延续** | 触发器与 `TurnFooter` 相邻，误触概率上升；**展开方向朝上**，chevron 旋转语义（`:1268-1274` `processShellOpen && 'rotate-180'`）需重判 |
| G2 | 每个 process 段各带一个小触发器行（如 `Thought · 3 tools ⌄`），底部状态行只读不可点 | 折叠粒度更细；一 Root 一 Trigger 一 Panel，Base UI 用法零改动 | **触发器行数 = process 段数，铺屏反增，与 FB7 目标相悖**；每段 trigger 文案需新造（`Worked for` 是回合级的） |

**本规格取 G1**（与 §4.6 的 E1 配套：多个受控 Panel + 一个 `aria-controls` 列出多 id 的按钮）。

⚠️ **以下四项必须由 GUI 点验确认，不得凭代码断定**（截图判据见 §10）：

1. **chevron 朝向** —— 触发器在内容**下方**时，「折叠态该朝上还是朝下」**没有客观正解**，需对齐用户截图预期。判据：折叠/展开两态各截一图，箭头是否指向「内容会出现的方向」。
2. **底部三行拥挤度** —— `[最后一段正文] → [状态行] → [footer]` 三条连续堆叠。⚠️【实测】`MessageTimeline.tsx:1683` `if (!line && copyText.length === 0) return null;`，而 `formatMessageMetadata`（`messageMetadata.ts:176-191`）在**只有 `model`** 时也返回非空 ⇒ **流式期 footer 可能已经渲染**。这是「谁在最底下」的关键事实，也是 §12 Q4 的由来。
3. **G1 的误触** —— 状态行整行可点 + 紧邻 24px copy 按钮。
4. **多容器碎片化**（§4.5 C1 连带）。

### 5.4 裁定：`PendingTurnHead` 的去向 —— 保留、不改名、不合并

| # | 理由 | 依据【实测】 |
|---|---|---|
| 1 | **它服务的窗口里根本没有回合可挂** | `deriveSendStatusBinding`（`turnHead.ts:211-223`）返回 `'pending'` 的三种情形（无回合 / handshake / 无 live 证据）；头注 `:183-185` 逐字 `pending renders it as a standalone head below the last turn`。移底后它的视觉位置（时间线最底）与回合底部状态行**恰好对齐**，形态比今天更一致 |
| 2 | **改名是纯损** | `messageTimelinePendingStatic.test.ts:144` 用 `source.indexOf('function PendingTurnHead(')` 做静态取证，改名必红且零收益 |
| 3 | **`promptChars` 第二消费者不动** | `MessageTimeline.tsx:1372` `promptChars: sendStatus.promptChars`（**必填、无 `?? 0` 兜底** —— 与回合内 `:1087` 的差异是刻意的） |

⚠️ **FB6 引入的一个新形态问题（须点验）**：`pendingSendStatus` 非空时 `attachedSendStatus` 为 null（`:345-346`），但最后一个回合仍可能因 `pendingActive`（`:1023`）而 `turnActive === true` ⇒ 该回合底部渲染一条状态行，**紧接着下面又是 `PendingTurnHead` 的状态行**。
**今天这两条一个在旧回合顶部、一个在时间线底部，隔着整个回合；移底后它们变成相邻两行**，可能被读作重复。⇒ §12 Q5。

### 5.5 sticky band 与间距算术：逐条核对（结论：**数字全不用改**）

| 算术项 | 需重算？ | 依据 |
|---|---|---|
| `space-y-2.5` + band `py-2.5` = 20px 回合间距 | ❌ 否 | 两者都在回合**外层/顶部**，与回合内子元素顺序无关；`chatTimelineLayout.test.ts:78-84` 断言不变 |
| band 底 padding 10px | ❌ 数字否 | 由 band 自己的 `py-2.5` 提供，与首元素是谁无关。⚠️ **但头注 `:22-23` 的 `bottom: the 10px "section gap" to the head` 里的 "head" 将不再正确** |
| `turnBodyClass` `gap-2.5` = 回合内 10px 节拍 | ❌ 否 | 子元素**数量不变、顺序变**，flex gap 与顺序无关；`chatTimelineLayout.test.ts:86-91` 不变 |
| `chatTurnClass()` 无 gap | ❌ 否 | 与顺序无关，F-B10 断言（`:67-70`）不变 |
| sticky 生效条件（无 `overflow-*`/`transform`/`contain`） | ❌ 否 | 移位不引入新属性。⚠️ 若走 §4.6 E2 自建 panel，**禁止**给它加 `overflow-hidden` |
| band 遮盖不透明性 | ❌ 否 | `bg-background` + `py-2.5` 与被遮盖内容是谁无关 |

**必须同批改写的失真头注（三处）** —— 不改就是新的漂移源：

1. `chatTimelineLayout.ts:20-24` 的 `turn body gap-2.5 = 10 head / process / answer / footer (P-17)` —— **顺序描述倒了**；
2. `chatTimelineLayout.ts:206-210` 的 `Mounted on the answer segment only … at most one box per turn`（§4.5 连带）；
3. `MessageTimeline.tsx:936-944` 的 `Renders, in order: the sticky user-bubble band (§5), the head slot (§4.7 …), the collapsible process segment, the always-visible answer segment (§4.4), and the trailing status bar (§4.6)` —— **整段顺序作废**。

⚠️ **一个视觉变化须点验**：band 正下方的第一个元素从「矮的 `text-meta` 头行」变成「带边框的 answer 容器 / process 面板」，10px 间隔下是否显拥挤（§10 G-7）。

### 5.6 ⚠️ FB6 是**零回归网改造** —— 必须先补钉子

这是本件最重要的一条风险声明。【实测，两条独立证据】：

1. **「head 是回合首子元素」当前无任何测试钉住。** `vitest.config.ts:12` `environment: 'node'`，无 jsdom；`messageTimelineWiring.test.ts` 的 `topLevelFunction()` 只能定位 `ts.FunctionDeclaration`，而 `ChatTurn` 是 `const ChatTurn = memo(function ChatTurn(…))`（`MessageTimeline.tsx:954`）⇒ **其 JSX 子树从未进入任何 AST 断言**；全文件 `indexOf` / 顺序比较断言零命中。
2. **F456 的全部 33 发变异里，没有任何一发钉「head 在首 vs 尾」。**

⇒ **今天把 head 从顶部挪到底部，全量 vitest 会全绿。** 这正是「布局缺陷只在截图里显形」那一族风险的教科书形态。

**处置（强制，不得省）**：**先补 AST 顺序断言，再动结构**。
【实测】工法是现成的：`messageTimelineWiring.test.ts:233-302` 已有 `isJsxNode` / `tagNameOf` / `jsxChildrenOf`（`:245`）/ `classNameExpressionOf`（`:365`），且 `[D3-9]` 一带（`:701-712`）**已经在用 `children[0]` / `children[1]` 做位置断言**（只是目标是 `UserBubble`）。
⇒ 只需让定位器**支持 `memo(function …)` 形态**，即可对 `ChatTurn` 写同族断言。这笔工法扩建**计入片③ 工作量**，不得当成「顺手加一条断言」。

---

## §6 FB7 · `Ran X` + `Allowed Bash — X` 双行合并（D53 ②，L 档）

### 6.1 结论先行：**核心难点是假的**

分诊档 `:18` 写「合并需 permissionId↔toolCallId join，**无纯模块做过**」；D53 ②（`ledger.md:97`）写「**需打通** permissionId↔toolCallId 关联」。

【实测】**Claude 路径上二者本就是同一个字符串**，且这个相等已经引发过一次 P0 事故并被回归测试钉住。⇒ **L 档的核心不确定性消掉大半**；真正需要「打通」的只有 Codex 路径。

⚠️ **这条对账建议回写台账**（§12 Q10）—— 它也解释了分诊档那句「无纯模块做过」为何成立：**因为不需要模糊配对模块，只需要一次 join + 回落。**

### 6.2 裁定 A：关联键 = `block.permissionId` ↔ tool_call `block.id`（**协议层已有，零改动**）

**逐跳传递链（每跳实读）**：

| 跳 | 位置 | 关键原文 | 结论 |
|---|---|---|---|
| ① Host 生成 | `agent-host/permissionBridge.ts:38-42` | `function nextPermissionId(toolUseId?: string) { if (toolUseId && toolUseId.length > 0) return toolUseId; permSeq += 1; return \`perm-${Date.now()}-${permSeq}\`; }` | **有 `toolUseId` 就逐字返回它**；否则合成 |
| ② SDK 入参 | `permissionBridge.ts:96` | `toolUseId: options.toolUseID` | SDK 的 `toolUseID` 即 tool_call 的 id |
| ③ 事件载荷 | `permissionBridge.ts:120/129/175` | `toolUseID: permissionId` | 往返同一值 |
| ④ Store 落块 | `stores/chatSessions.ts:786-788` | `id: event.payload.permissionId,` / `type: 'permission_request',` / `permissionId: event.payload.permissionId,` | **block 上有独立的 `permissionId` 字段**（不只是 `id`），比用 `block.id` 更干净 |
| ⑤ 回归钉（**生产者存在的实证**） | `stores/__tests__/chatSessionsCore.test.ts` Round-2 P0 注释 | `the Host uses the SDK toolUseID AS the permissionId, which is the SAME id \`tool.started\` already used for that turn's tool_call block` | 用例名 `appends a permission_request block even when a tool_call block already shares its id` —— 因二者同 id，去重守卫曾把 permission_request 块**静默吞掉**（fix `4019fed`） |

⇒ **关联键天然存在，Claude 路径零协议改动。** 这条不是「类型上有字段」的推断，⑤ 是**运行时真有值**的实证（一个真实事故 + 一条回归测试）。

**Codex 路径是异构的**【实测】：

> `codexRuntime.ts:2505-2507`：`private correlationIdFor(sessionId: string, requestId: JsonRpcId): string { return \`codex:${sessionId}:${idKey(requestId)}\`; }`
> `:2433` `const permissionId = this.correlationIdFor(sessionId, req.id);`

`req.id` 是 **JSON-RPC 请求 id**，与 tool item id **无关** ⇒ **Codex 路径的 permission 配不上任何 tool_call**。

**裁定（分路）**：

| 路径 | 关联键 | 处置 |
|---|---|---|
| **Claude** | `permissionBlock.permissionId === toolCallBlock.id` | ✅ 直接 join，**本片做** |
| **Claude 但 SDK 未给 `toolUseID`** | 合成 `perm-{Date.now()}-{seq}` ⇒ **必然配不上** | ⇒ **安全回落**（§6.3）。⚠️ 注意这让回落**成为有据的必经路径**，不是防御性冗余 |
| **Codex** | 无可用键（`itemId` 未透传，取证指出 3 处需改） | ⇒ 本片**回落独立行**；透传是否本片做 = §12 Q6 |

### 6.3 裁定 B：安全回落 —— **配不上时不得丢失授权记录**（硬红线）

**算法**（纯函数，落 `toolCard.ts`，与 `buildTimelineItems` 同处以保持 node 可断言）：

```
对每个 permission_request block P：
  找同一 message 内 id === P.permissionId 的 tool_call block T
  ├─ 命中 → P 的决议信息并入 T 所在的 run 行（不产出独立 item）
  └─ 未命中 → 原样产出独立的 { kind: 'permission' } item（＝今天的行为）
```

**三条安全边界（缺一不可）**：

1. **回落是默认分支，不是异常分支** —— 未命中时走的是**今天已在生产的那条路径**，不是新写的降级路径。⇒ 回落路径的正确性由**既有测试**继续保障。
2. **绝不允许「配不上就丢弃」** —— 授权记录是安全审计面（`defaultTurnProcessOpen` 首返回、`hasUnresolvedPermission` 都建立在它可见之上）。⇒ `[FB7-4]` 断言（§9.1）必须钉住：**任意输入下，输出里 permission 信息的条数 = 输入 permission block 的条数**（合并进 run 的算一条）。这是本件**最重要的一条断言**。
3. **冲突处理** —— 同一 message 内 id 唯一（store 以 id 作块身份），故「同一回合内两次相同命令」**各有各的 toolCallId**，不构成歧义。⚠️ 若真出现重复 id，取**第一个未被认领的** T，且**不得**让一个 T 认领两个 P（`[FB7-5]`）。

### 6.4 裁定 C：Denied 形态与决议文案

【实测 `questionCardModel.ts:312-316`】四种决议动词（**已在生产，不新造**）：

| 常量 | 值 |
|---|---|
| `PERMISSION_ALLOWED` | `'Allowed'` |
| `PERMISSION_ALLOWED_SESSION` | `'Allowed for session'` |
| `PERMISSION_DENIED` | `'Denied'` |
| `PERMISSION_DENIED_STOPPED` | `'Denied, turn stopped'` |

生成函数 `derivePermissionVerb(block)`（`:403-407`）：`decision` 优先，回落 `block.allowed` 布尔。
另有 `auto: <reason>`（`:409-412`）标注 Host 代答 —— 头注逐字说明其存在理由：`a drained approval was drawn as a plain "Denied", indistinguishable from a real refusal`。⇒ **合并后必须保留 auto 标注**，否则重新制造那个已被修掉的歧义（`[FB7-6]`）。

**Denied 的视觉载体**【实测 `ToolRows.tsx:76-79`】工具行已有 failed 分支：

```
'group/row flex w-full items-baseline gap-1.5 text-left text-markdown leading-normal',
view.failed ? 'text-destructive' : 'text-muted-foreground'
```

⇒ Denied 复用 `text-destructive` **有天然载体**，这正是 D28 连带项所指。

⚠️ **但该连带项的效力状态必须如实标注**【实测 `ledger.md:72`】D28 连带逐字：

> 连带（**编排者代拍，待追认**）：Denied 复用工具行 failed/destructive 色语义（不发明新状态色）；subagent 来源 chip 在已决单行上以文本后缀承载

⇒ **Denied 的色彩语义至今未经用户追认。** 本批合并会重新暴露这个视觉决策，**正是顺路补追认的时机** ⇒ §12 Q7。**不得默认它已生效。**

**被拒的工具调用还有没有 `Ran X` 行**：⚠️【推测，须实测】按 SDK 语义，被 deny 的工具**不会执行**，故大概率**没有** `tool.started` ⇒ 没有 tool_call block ⇒ **配不上 ⇒ 走回落，独立行**。若属实，则「Denied 的合并形态」在 Claude 路径上**几乎不出现**，合并主要作用于 Allowed。⚠️ **这是唯一能推翻 §6.5 布局设计的未知量**，必须在真机上实测一次（§10 G-9），**不得凭推断施工**。

### 6.5 裁定 D+E：D28「决议单行」语义的保留 + 合并行信息形态

**先看结构障碍**【实测 `toolCard.ts:155-181`】：

```ts
case 'permission_request':
  flush();                                              // ← 打断当前工具组
  items.push({ kind: 'permission', block, blockIndex });
```

⇒ permission item **今天会 flush（打断）工具组**，这正是「两行」的结构成因。合并 = 让它**不再 flush**，而是把决议信息**并入对应 run**。

**D28「决议单行」语义的等价保留**：D28 的意图是「一次授权往返最终收敛成**一行**已决记录，不留下问答壳」。合并后该语义**不但保留还被加强** —— 从「独立的一行已决记录」变成「**工具行自身携带决议**」，行数从 2 降到 1，而「一次往返 = 一行」的不变量不变。

**合并行的信息形态（受 D24 硬约束）**：

⚠️ **R7 是本件最容易违反的红线**【实测 `ledger.md:68` D24 + `:75` D31 复核】：工具行口径 = **动词开头、无图标、无边框的灰阶单行**。
⇒ **授权徽记必须是灰阶纯文本**，**不得**做成图标、彩色 chip 或带背景的标签 —— 那会直接回滚 D24。

**三级灰体系**（既有）：`--foreground`（hover 时的动词）＞ `--muted-foreground`（动词档）＞ `--tool-arg`（参数档）。徽记应落在**动词档或参数档**，⚠️ **具体档位由 GUI 点验定**（§10 G-8），本规格不凭空指定。

**截断纪律**：合并后一行要承载「动词 + 参数 + 决议」，宽度压力上升。参照 `design-system.md` 的既有让位范式（sidebar 会话行：`标题 min-w-20 flex-1` 下限 · 闭集标签 `shrink-0` 不截断 · 唯一让位者 `min-w-0 max-w-24 shrink`）：

- **决议徽记是闭集**（四个已知值）⇒ `shrink-0`，**不截断**；
- **参数是唯一让位者** ⇒ 保持既有 `min-w-0` + 截断；
- 动词 `shrink-0`（`ToolRows.tsx:79` 已是）。

⚠️ 这条布局裁定**必须 GUI 点验**（长命令 + 长参数 + 决议徽记三者并存时的实际让位行为，§10 G-8）。

### 6.6 影响面与测试合同

**改动文件**：`toolCard.ts`（join + 不再 flush）· `ToolRows.tsx`（行内渲染徽记）· `questionCardModel.ts`（可能需导出 `derivePermissionVerb` 给 toolCard，⚠️ 注意**不要制造循环依赖** —— 施工时复核两模块的 import 方向）· `chatTurn.ts`（kind 构成变化的连带，见 §4.3）。

| file:line | 用例名 / 断言 | 处置 |
|---|---|---|
| **`toolCard.test.ts:166-174`** | **`it('lets a permission block break the tool group')`** + `:173` `expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'permission'])` | **必红 + 退役换新** —— 这是本件的**核心承重断言**，其命题（permission 打断工具组）被本批直接推翻 |
| `toolCard.test.ts:138-149` | `lets a text block break the tool group` | **不受影响**（text 仍打断） |
| `toolCard.test.ts:160-165` | `lets a question block break the tool group` | **不受影响**（question 仍打断） |
| `toolCard.test.ts:150-159` | `does not let a thinking block break the tool group` | **不受影响** |
| `chatTurn.test.ts:187-191` | `an unresolved permission stays in the process segment (block order, not promoted)` | **退役换新** —— 语义（不提升、保序）**必须保留**，形状随 §4.2 改 |
| `chatSessionsCore.test.ts`（Round-2 P0 组） | `appends a permission_request block even when a tool_call block already shares its id` | **不受影响，且必须保留** —— 它是 §6.2 关联键成立的**唯一实证**，退役即失去地基 |
| `questionCardModel.test.ts` 决议动词组 | 四常量 + `derivePermissionVerb` | **不受影响**（本批不改文案） |

### 6.7 切片规模评估

**本片独列，不与任何件合并**。理由：它是唯一同时触及**协议理解 + 纯模型层 + 组件层 + 台账追认**四个面的件，且它的产物（`TurnItemKind` 构成）是 FB4 的输入（§4.3 接口锁）。
⚠️ **若 §6.4 的 deny 实测推翻了「Denied 几乎不出现在合并形态」的推断**，本片需追加一轮形态设计 ⇒ **实测必须排在施工前**，不是施工后（§10 G-9 的时序要求）。

---

## §7 FB8 · `Thought for 1702s` 裸秒换算

### 7.1 缺陷与修法

【实测 `turnTiming.ts:110-130`】`formatThoughtRow` 末行（`:127`）：

```ts
return { verb: THOUGHT_VERB, arg: `for ${Math.round(input.durationMs / 1000)}s`, argKind: 'prose' };
```

兄弟函数 `formatWorkedForDuration`（`:142-148`）**已有分钟换算**：

```ts
const seconds = Math.max(1, Math.round(latencyMs / 1000));
if (seconds < 60) return `${seconds}s`;
const minutes = Math.floor(seconds / 60);
const rest = seconds % 60;
return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
```

1702000ms 代入 `formatThoughtRow` ⇒ `"for 1702s"`，与用户报告**逐字吻合**。

**裁定：`formatThoughtRow` 复用 `formatWorkedForDuration`**，不复制换算逻辑：

```
arg: `for ${formatWorkedForDuration(input.durationMs)}`
```

⇒ 两个时长展示口径**从此同源**，「分钟怎么写」这件事全仓只有一处定义。这比「照抄一份分钟换算」强：它把未来的漂移变成不可能。

### 7.2 小时档的裁定

⚠️【实测】`formatWorkedForDuration` **同样没有小时档** ⇒ 3600s 会显示 `60m`、7200s 显示 `120m`。

**裁定：本批不加小时档。** 三条理由：

1. **用户报告的是 1702s = `28m 22s`**，分钟档已完全解决该现象；
2. 加小时档会**同时改变 `Worked for` 的既有显示**（该函数是共享的），属于超出反馈范围的形态改动；
3. 没有证据表明存在 >1h 的思考时长（`1702s` 是目前已知最长样本）—— **不发明无据需求**。

⇒ 记入 §12 Q8（另立票，非本批）。

### 7.3 测试合同

【实测 `turnTiming.test.ts`】现状确认「只钉了 12s 档」**属实**：

| file:line | 内容 | 处置 |
|---|---|---|
| `:79-85` | `shows "for Ns" at/above the threshold`，输入 `12_000`，断言 `arg: 'for 12s'` | **不受影响**（12s < 60，新旧同值）—— 这是**好消息**：改动不破既有断言 |
| `:124-127` / `:142-144` | `formatWorkedForRow` 侧测 `66_000`（跨 60s）与 `120_000`（整分钟） | **不受影响** |
| —— | **无任何 ≥60s 的 `formatThoughtRow` 用例** | **新增分钟级测试臂**（§9.1 `[FB8-1]`） |

---

## §8 FB9 · LaTeX 渲染（D53 ③，含安全评审）

### 8.1 现状

| 锚点【实测】 | 内容 |
|---|---|
| `ChatMarkdown.tsx:85-88` | `const REMARK_PLUGINS = [[remarkGfm, { singleTilde: false }], remarkBreaks];` |
| `ChatMarkdown.tsx:91` | `const REHYPE_PLUGINS: [] = [];` —— **显式空数组 + 字面空元组类型**，塞插件是**类型层面**的破坏，不是简单加一项 |
| `chatMarkdownPolicy.ts:717-751` | `CHAT_MARKDOWN_POLICY = { remarkPlugins: ['remark-gfm','remark-breaks'] as const, rehypePlugins: [] as const, … }` —— 手写「政策卡片」，需同步改 |
| `package.json` + lockfile | `remark-math` / `rehype-katex` / `katex` **零命中** ⇒ 三包从零引入 |
| 现有版本 | `react-markdown ^10.1.0` · `rehype-raw ^7.0.0` · `remark-breaks ^4.0.0` · `remark-gfm ^4.0.1` |

⚠️ **纠正一处用户指令里的位置引用**：安全规则的**真正出处是 `chatMarkdownPolicy.ts:22-40`（五条）**，不是 `ChatMarkdown.tsx:40-48`（后者标题是「The three things this file must never grow」，是**另一份内容有重叠但不同的文本**）。本节按**五条**逐条过。

### 8.2 安全评审：逐条过 `chatMarkdownPolicy.ts:22-40` 五规则

| # | 规则 | rehype-katex 的影响 | 判定 |
|---|---|---|---|
| ① | **无 `rehype-raw`** | `rehype-katex` 不引入 `rehype-raw`，也不启用 `allowDangerousHtml` | ✅ **不触碰** |
| ② | **链接仅 `http(s)`** | KaTeX 输出**不含链接**（`\href` 需显式开启 `trust` 选项，**默认 false**） | ✅ 不触碰，**但必须显式不传 `trust`**（`[FB9-3]`） |
| ③ | **图片一律 inert 不发请求** | KaTeX 输出**不含 `<img>`** | ✅ 不触碰 |
| ④ | **全路径无 `dangerouslySetInnerHTML`** | ⚠️ **这是唯一需要论证的一条**。`rehype-katex` 产出的是 **hast 节点树**（交给 react-markdown 正常渲染成 React 元素），**不是** HTML 字符串注入 ⇒ 不经 `dangerouslySetInnerHTML`。⚠️【推测，须施工时验证】须确认所用版本未走 `raw` 节点路径 | ⚠️ **须实证**（`[FB9-4]` 源码扫描继续覆盖） |
| ⑤ | **裸 HTML 转义而非丢弃** | KaTeX 的输入是 `$$…$$` 内的 TeX 源，`rehype-katex` 对**解析失败**的公式默认渲染错误信息（`throwOnError: false`），不回吐原始 HTML | ✅ 不触碰 |

**XSS 面结论**：KaTeX 的已知 XSS 面集中在 `trust` 选项（允许 `\href` / `\url` / `\includegraphics`）与 `macros` 注入。⇒ **裁定：`rehype-katex` 只传 `{ throwOnError: false, strict: 'ignore' }`，显式不传 `trust`、不传 `macros`。** 并配一条源码扫描断言钉死「配置对象里不出现 `trust`」（`[FB9-3]`）。

**KaTeX 输出的 DOM 形状**：`<span class="katex">` 内含 `.katex-mathml`（MathML，供读屏）+ `.katex-html`（视觉层，大量 `<span>`）。⚠️ 这与本仓的 `CHAT_MARKDOWN_COMPONENTS` 映射表（`ChatMarkdown.tsx:140-318`，10 组）**无交集**（它不映射 `span`），故不会被既有组件映射截获。

### 8.3 必红测试清单（FB9 的攻坚面）

| file:line | 断言 | 处置 |
|---|---|---|
| `chatMarkdownPolicy.test.ts:1088` | `expect(CHAT_MARKDOWN_POLICY.rehypePlugins).toEqual([]);` | **必红 · 退役换新**（承重命题「rehype 位为空」被本批推翻，须换成「rehype 位**只含** rehype-katex」的白名单锁） |
| `chatMarkdownPolicy.test.ts:1094` | `expect([...CHAT_MARKDOWN_POLICY.remarkPlugins]).toEqual(['remark-gfm', 'remark-breaks']);` | **必红 · 改值**（加 `'remark-math'`） |
| `chatMarkdownPolicy.test.ts:1146` | `expect(markdown).toContain('const REHYPE_PLUGINS: [] = [];');` | **必红 · 退役换新** —— 它钉的是**源文字面量**，类型从 `[]` 变了就必红 |
| `chatMarkdownRender.test.ts:447-448` | `expect(wiring.rehypePlugins).toEqual([]); expect(wiring.remarkPlugins).toHaveLength(2);` | **必红 · 改值** |
| `chatMarkdownPolicy.test.ts:1173-1179` | `FORBIDDEN_ON_PATH` 扫描，**硬编码 5 文件白名单**（`ChatMarkdown.tsx` / `ChatCodeBlock.tsx` / `chatMarkdownPolicy.ts` / `chatShiki.ts` / `ui/ident.tsx`） | ⚠️ **新增数学渲染文件不会被自动纳入** ⇒ 若 FB9 新建文件，**必须同步扩白名单**，否则留下一个不被扫描的洞（**不红，但是覆盖缺口** —— 这类「静默失去覆盖」比必红更危险） |
| `chatMarkdownRender.test.ts:189-235` | F-C6 五条安全规则**渲染级**回归 | **不受影响，且必须全绿** —— 这是 §8.2 评审结论的运行时验证 |

### 8.4 ⚠️ 地雷一：字体红线正面冲突

【实测 `globals.css:81-84`】逐字：

> `No bundled webfont: this repo has no @font-face and no font assets; naming a non-system family here is a blank cheque (design-system red line), and a bundled Latin face paired with a system CJK face reads worse than the OS's own co-designed pair.`

而 **KaTeX 的标准 HTML 输出依赖它自带的 `@font-face` + `.woff2` 字体**。

**本轮补充取证（子代理未覆盖，本人实读）**：
- `fontDomain.test.ts` 只扫 `globals.css` 的 `--font-sans` / `--font-mono` token；
- `fontDomainScan.test.ts` 只扫 `font-mono` 类白名单与 `tracking-*`；
- **两者都不扫 `@font-face`**；
- 既有唯一第三方 CSS（`useXterm.ts:14` 的 `@xterm/xterm/css/xterm.css`）**零 `@font-face`**。

⇒ **该红线至今零例外，且没有自动化守卫。** KaTeX 若走 HTML 输出就是**第一例外**。

**裁定（两条路，本规格给优先序）**：

| # | 路 | 判定 |
|---|---|---|
| **（a，优先）** | `rehype-katex` 传 **`output: 'mathml'`**，走 Chromium 原生 MathML 渲染 ⇒ **不需要 KaTeX 字体，CSS 需求也大幅缩减** | ⚠️【推测，须实测】Electron 39 = Chromium 142，MathML Core 自 Chromium 109 起可用。**本仓是单引擎环境，无跨浏览器顾虑**（同 T-31 §5.6 用 Chromium 版本推断 `scroll-state()` 的先例，那里也要求「必须一次 GUI 实测确认」）⇒ **同一纪律：必须 GUI 实测**（§10 G-10）。风险：MathML 的排版质量弱于 KaTeX HTML 输出 |
| （b，退路） | 走 HTML 输出 + 打包 KaTeX 字体 | ⇒ **知情违反红线**，必须按 F456 §7.5 ③ 的**三处留痕**范式处置：① 台账「知情偏离」栏；② `globals.css:81-84` 头注就地补例外说明；③ §12 开放问题供评审复核。**不得只在规格里说一句就算完** |

### 8.5 ⚠️ 地雷二：打包链会静默吞掉 katex

【实测 `electron-builder.yml:56-73`】mermaid 段（注释 `Mermaid and its heavy dependencies (~60MB total) - loaded from CDN at runtime`）内含：

```yaml
- "!node_modules/katex/**"
```

katex 当年是 **mermaid 的依赖**被一并裁掉；`node_modules/katex` 与 `node_modules/mermaid` **当前均不存在**，`mermaid` 也不在 `package.json`。

⇒ **FB9 引入 katex 后若不删这一行，打包版公式渲染会静默失效**（dev 正常、安装包异常，是最难排查的一类）。

**裁定：本片必须删除 `electron-builder.yml:64` 那一行**，并在同处补一行注释说明「katex 现为 FB9 的直接依赖，不再随 mermaid 裁剪」。
⚠️ 这也意味着 **FB9 的验收不能只在 dev 态做** —— 必须有一次**打包产物**的公式渲染确认（§10 G-11）。这是本批唯一需要出包验证的件。

### 8.6 裁定：行内 `$…$` **不启用**

`remark-math` 默认同时处理块级 `$$…$$` 与行内 `$…$`。

**裁定：只启用块级，行内关闭**（配置项名随所用版本，施工时对照文档确认 —— 不发明选项名）。

**四条理由**：

1. **用户反馈的是 `$$…$$`**（分诊档 FB9 逐字：「LaTeX `$$…$$` 原样输出」）—— 行内是范围外的推测需求；
2. **误伤面真实且高频**：聊天里 `$` 的非数学用法极常见 —— shell 变量（`$PATH`、`$HOME`）、价格（`$5`、`$10`）、正则、模板串。而本仓的核心场景**正是 shell 命令**（FB2 的 D53 ① 澄清就是「输出给用户去终端执行的指令」）⇒ **误伤概率显著高于一般聊天应用**；
3. **单个 `$` 无法靠转义纪律解决** —— 模型输出不受我们控制，不能要求它转义；
4. **可回退性**：块级先落地、行内另立票，是**单向安全**的顺序（先严后宽）；反之若先放开再收紧，用户会经历一次「本来能渲染的公式突然不渲染」。

⇒ 行内 `$…$` 记入 §12 Q9（另立票，需真实语料统计误伤率后再定）。

---

## §9 断言与变异计划

### 9.0 总原则

**（a）先补网，再动结构。** 本批有两件**零回归网**改造：FB6（§5.6，「head 在首」无任何断言）与 FB2/FB3 的部分形态。纪律：**这两件的新断言必须先于生产改动落地并跑绿**（对着旧代码写、跑绿，再改代码看它红）—— 否则无法区分「断言写对了」与「断言恰好也绿」。

**（b）退役换新 > 改数字。** 承重命题本身不再成立的（`answer` = 尾部连续 text、permission 打断工具组、rehype 位为空、流式期纯文本），一律**退役并写新的承重行**；只有命题成立、取值变了的（12s → 分钟档）才改数字。

**（c）每条断言必须能指出「它抓的是哪个具体退化」**，抓不出退化的不写。

### 9.1 新增断言清单

| 编号 | 落点 | 断言 | 抓什么 |
|---|---|---|---|
| `[FB1-1]` | `chatMarkdownPolicy.test.ts` | `splitClosedPrefix` 真值表：① 未闭合围栏 ⇒ 从开栏行起全在 `openTail`；② 闭合围栏后跟空行 ⇒ 成段；③ 半张表（表头无分隔行）⇒ 全在 `openTail`；④ 无空行长文本 ⇒ `segments === []`（退化为纯文本） | 切分口径被放宽成「见到换行就切」 |
| `[FB1-2]` | 同上 | **单调性**：构造一条追加会使切点失效的输入（loose list 转换 / 缩进代码块延续 / 脚注定义续行），断言**已发布前缀不回退**（hwm 生效） | §1.3 的核心正确性；**没有这条，`splitClosedPrefix` 就是空壳**（§13 ①） |
| `[FB1-3]` | 同上 | **纯函数性**：`A → B → A` 交错调用，第三次结果逐字等于第一次；模块无导出的可变状态 | 引入缓存 / 定时器 / 全局态 |
| `[FB1-4]` | `messageTimelineWiring.test.ts` | 源文扫描：`TurnItemView` 的 text 分支内**不出现** `setInterval` / `setTimeout` / `Date.now` / `nowMs` | R3 的 `STATIC_NOW_MS` 纪律被绕过 |
| `[FB2-1]` | `chatTimelineLayout.test.ts` | FB2 按钮复用 `turnCopyButtonClass()`，且该串**仍不含** `opacity-0` / `group-hover:` | F-B15 红线（§2.3） |
| `[FB2-2]` | `chatMarkdownPolicy.test.ts` | `chatMarkdownCodeBlockClass()` 返回串**逐字未变**（`relative` 加在 wrapper 不在它身上） | §2.4（b）路被误走 |
| `[FB2-3]` | `messageTimelineWiring.test.ts` 或 `composerFormStatic` 同族源文扫描 | **`ChatCodeBlock` 的调用点仍只有 markdown 一处**；`ToolRows.tsx` 不 import 它 | §2.2 的「天然红线」**静默失效** |
| `[FB3-1]` | `chatTimelineLayout.test.ts` | `userBubbleTextClass(false)` 含 `line-clamp-6`；`userBubbleTextClass(true)` **不含**任何 `line-clamp-` | 展开态没真的解除 clamp |
| `[FB3-2]` | 同上（源文/类型层） | `userBubbleTextClass` 的入参**只能来自用户意图态** —— 断言 `UserBubble` 函数体内该调用的实参标识符**不出现** `pinned` / `stuck` / `scroll` / `intersect` 词根 | §3.3 的形式化不变量：**挡住下一个人把 `isPinned` 接回来**（F10 振荡回路复活） |
| `[FB3-3]` | `messageTimelineWiring.test.ts` | 气泡 `title={fullText \|\| undefined}` **仍在** | §3.4：把既有测试盲区补上 |
| `[FB4-1]` | `chatTurn.test.ts` | `turnItemPlacement` 对 `TurnItemKind` **联合穷尽**（`satisfies Record<TurnItemKind, TurnSegmentKind>` 或逐成员），当前 5 成员 | **FB4↔FB7 唯一接口锁**（§4.3 ③）：FB7 增删 kind 时必红 |
| `[FB4-2]` | 同上 | `segmentTurnBody` 保序 + run-length：`[text, tool, text, tool, text]` ⇒ 5 段且 kind 序列为 `answer/process/answer/process/answer` | 谓词退化回二分 |
| `[FB4-3]` | 同上 | **交错不合并**：`[text, text, tool]` ⇒ 2 段（两个 text 合成**一段**），验证「极大同类连续段」 | 每 item 一段（碎片化）或全合并（丢序） |
| `[FB4-4]` | 同上 | **尾部 notice 不再连坐**：`[text, tool, text, notice]` ⇒ 前面的 text 段仍是 `answer`，notice 单独成段 | §4.1 被推翻的旧规则复活 |
| `[FB4-5]` | 同上 | `collapsedLeavesNothing` 语义：全 process ⇒ true；含任一 text ⇒ false | §4.4 的恒假死开关 |
| `[FB4-6]` | `chatTurn.test.ts` | `defaultTurnProcessOpen` 的 `hasUnresolvedPermission` **仍是首返回** | 安全红线被重排 |
| **`[FB6-1]`** | `messageTimelineWiring.test.ts`（**须先扩定位器支持 `memo(function …)`**） | **`ChatTurn` 的 direct-child 顺序**：band → 内容段 → **head** → `TurnFooter`，head 的 index **大于**所有内容段 | **§5.6 的零回归网** —— 这是本批最重要的新钉子 |
| `[FB6-2]` | 同上 | 底部行**仍带 `truncate`**（单行不变量，§5.2） | 去 `truncate` ⇒ 高度反馈风险 |
| `[FB6-3]` | `messageTimelinePendingStatic.test.ts` | `PendingTurnHead` **函数名未变** + `promptChars: sendStatus.promptChars` 仍是**必填无兜底** | §5.4 ②③ |
| **`[FB7-1]`** | `toolCard.test.ts` | **Claude 路径 join**：permission block 的 `permissionId` 命中同 message 的 tool_call `block.id` ⇒ **不产出独立 permission item**，决议并入该 run | 合并没生效 |
| **`[FB7-2]`** | 同上 | **回落**：`permissionId` 无命中（合成 id / Codex 形态 `codex:…`）⇒ **原样产出独立 permission item** | 回落路径缺失 ⇒ 授权记录丢失 |
| **`[FB7-3]`** | 同上 | permission **不再 flush 工具组**：`[tool, permission(命中), tool]` ⇒ **1 个 toolGroup**（今天是 2 个） | §6.5 的结构成因未消除 |
| **`[FB7-4]`** | 同上 | **守恒律（本件最重要）**：任意输入下，输出中 permission 信息条数（合并进 run 的算一条）**恒等于**输入 permission block 条数 | §6.3 硬红线：**配不上就丢弃** |
| `[FB7-5]` | 同上 | 一个 tool_call **不得认领两个** permission | §6.3 ③ 冲突处理 |
| `[FB7-6]` | 同上 / `questionCardModel.test.ts` | 合并行**保留 `auto: <reason>` 标注** | 重新制造「drained approval 与真实拒绝无法区分」的已修缺陷 |
| `[FB7-7]` | `ToolRows` 类装配侧 | 徽记类串**不含** `bg-` / `border` / 图标组件名（D24 灰阶纯文本约束） | **R7 回滚 D24** |
| `[FB8-1]` | `turnTiming.test.ts` | **分钟级臂**：`formatThoughtRow({durationMs: 1_702_000})` ⇒ `arg` 含 `28m 22s`；且 `66_000` ⇒ `1m 6s`、`120_000` ⇒ `2m` | 裸秒复活 |
| `[FB8-2]` | 同上 | **同源**：`formatThoughtRow` 的时长片段**逐字等于** `formatWorkedForDuration(同输入)` | §7.1 的「全仓一处定义」被复制回两份 |
| `[FB9-1]` | `chatMarkdownPolicy.test.ts` | rehype 位**白名单**：只含 `rehype-katex`（不是「非空」） | 顺手再塞一个插件 |
| `[FB9-2]` | 同上 | remark 位含 `remark-math`，且**块级选项开、行内选项关**（§8.6） | 行内 `$…$` 被顺手打开 |
| `[FB9-3]` | 源文扫描 | `rehype-katex` 的配置对象里**不出现** `trust`、不出现 `macros` | §8.2 的 XSS 面 |
| `[FB9-4]` | 沿用 F-C5 扫描 | 数学渲染涉及的文件**在 `FORBIDDEN_ON_PATH` 白名单内** | §8.3 的**覆盖缺口**（不红但失去扫描） |
| `[FB9-5]` | 新增（构建配置侧） | `electron-builder.yml` **不含** `!node_modules/katex` | §8.5 地雷 —— 打包版静默失效 |

### 9.2 变异清单（**零跳过纪律**：全部实跑，先跑变异确认红、再回退确认绿）

| # | 变异 | 应红的断言（发射半边） |
|---|---|---|
| M-01 | `splitClosedPrefix` 去掉 hwm，每次取当次值 | `[FB1-2]` —— **本批最重要的一发**，它守住 §1.3 整个单调性论证 |
| M-02 | 切点判据从「空行」放宽为「换行」 | `[FB1-1]①③` |
| M-03 | 围栏闭合判定忽略长度（`>=N` 改 `===N`） | `[FB1-1]①` |
| M-04 | 把整个 `closedPrefix` 喂给单个 `<ChatMarkdown>`（不分段） | ⚠️ **静态断言抓不到** —— 这一发的发射半边是 §10 G-2 的**性能点验**，必须在点验里显形（诚实记账：这是本批唯一没有静态守卫的设计裁定） |
| M-05 | 用 `setInterval` 驱动重切 | `[FB1-3]` + `[FB1-4]` |
| M-06 | FB2 按钮改 `opacity-0 group-hover:opacity-100` | `[FB2-1]` |
| M-07 | 给 `chatMarkdownCodeBlockClass()` 加 `relative` | `[FB2-2]` |
| M-08 | 让 `ToolRows` 复用 `ChatCodeBlock` | `[FB2-3]` —— 抓「天然红线静默失效」 |
| M-09 | `userBubbleTextClass(true)` 仍返回 `line-clamp-6` | `[FB3-1]` |
| M-10 | 把 `isPinned` 接回 `userBubbleTextClass` 入参 | `[FB3-2]` —— 抓 F10 振荡回路复活 |
| M-11 | `turnItemPlacement` 写成黑名单（`kind !== 'toolGroup'` ⇒ answer） | `[FB4-1]` + `[FB4-2]` |
| M-12 | answer 容器挂到 process 段一侧 | `[FB4-2]` + `[FB6-1]` —— ⚠️ **F456 的 M-15 由本发接替**（原 M-15 映射的 `[D3-7]` 唯一计数已随 §4.5 失效） |
| M-13 | 尾部 notice 重新吞掉前面的 text 段 | `[FB4-4]` |
| M-14 | `collapsedLeavesNothing` 退回 `answer.length === 0` | `[FB4-5]` |
| M-15 | `hasUnresolvedPermission` 从首返回挪到末尾 | `[FB4-6]` |
| M-16 | head 留在首位（**只改断言不改结构**的反向验证） | `[FB6-1]` —— 这一发验的是**新钉子真的钉住了位置**；⚠️ 跑法：先补断言、对旧代码跑，**必须红** |
| M-17 | 底部行去掉 `truncate` | `[FB6-2]` |
| M-18 | `PendingTurnHead` 改名 / `promptChars` 加 `?? 0` | `[FB6-3]` |
| M-19 | permission join 命中后**既并入 run 又保留独立 item** | `[FB7-4]`（守恒律，条数 = 2 ≠ 1） |
| M-20 | 无命中时**丢弃** permission item | `[FB7-4]` —— **本件最重要的一发**（安全审计面丢失） |
| M-21 | permission 仍 flush 工具组 | `[FB7-3]` |
| M-22 | 一个 tool_call 认领两个 permission | `[FB7-5]` |
| M-23 | 徽记做成 `bg-destructive/10` 彩色 chip | `[FB7-7]` —— 抓 R7 回滚 D24 |
| M-24 | `formatThoughtRow` 复制一份分钟换算（不复用） | `[FB8-2]` |
| M-25 | `formatThoughtRow` 退回裸秒 | `[FB8-1]` |
| M-26 | rehype 位塞入第二个插件 | `[FB9-1]` |
| M-27 | 打开行内 `$…$` | `[FB9-2]` |
| M-28 | `rehype-katex` 传 `trust: true` | `[FB9-3]` |
| M-29 | 恢复 `electron-builder.yml` 的 katex 排除行 | `[FB9-5]` |

**零跳过**：29 发全部实跑，不得以「显然会红」跳过。任一发存活 ⇒ 对应断言是空壳，**必须换承重行**而不是加一条同义断言。
⚠️ **M-04 的诚实记账**：它是本批唯一**静态不可捕获**的变异，其发射半边在 GUI/性能点验里（§10 G-2）。规格显式记录这一点，避免它被当成「漏了一发」。

### 9.3 变异分配（按片）

① = M-24、M-25、M-01~M-03、M-05 · ② = M-19~M-23 · ③ = M-11~M-18、M-12 · ④ = M-04、M-26~M-29 · ⑤ = M-06~M-10

---

## §10 GUI 点验清单

走 `node scripts/dev.js` + CDP（9222）工法。**每项亮暗双主题各一张**，分辨率沿用 F456 G 系列口径。
⚠️ 记忆纪律：CDP 驱动时注意选择器坑、`pkill` 自杀坑、`localStorage` 改布局需 reload 且首帧可能白帧。

| # | 场景 | 验什么（静态断言表达不了的部分） | 关联 |
|---|---|---|---|
| **G-1** | 流式输出一条含围栏代码块 + 列表 + 表格的长回答，**全程录制** | FB1 的核心观感：闭合块是否**实时**成型；未闭合尾部是否为纯文本；**有无任何已渲染内容回退成纯文本**（单调性的视觉验证） | §1.2 / §1.3 |
| **G-2** | 同上，但用一条 **≥50KB** 的回答 + DevTools Performance | **M-04 的发射半边**：分段渲染是否真的让每帧解析成本恒定；对比「不分段」实现的帧率。⚠️ 同时兑现 §1.4 要求的**微基准实测**（单段解析耗时） | §1.4 / §9.2 M-04 |
| **G-3** | 一个**超长单行**代码块（触发横向滚动）+ copy 按钮 | 按钮是否钉在右上角**不随横向滚动跑掉**（§2.4 的（a）路依据）；点击后 `Check` 反馈 | §2.4 |
| **G-4** | 六行以上的长用户提问，点击展开 / 收起 | FB3 交互可用性；展开态是否真的显示全文；`title` 悬停仍可达 | §3 |
| **G-5** | 贴底跟随态下展开一条长提问 | §3.3 的**次生效应**：高度增长触发的一次滚动跟随，观感上是否可接受（**不是振荡，是一次性跳动**） | §3.3 |
| **G-6** | 一个**多次交错**的回合（正文 → 工具 → 正文 → 工具 → 正文） | **FB4-C1 的碎片化风险**：3~5 个小边框盒堆叠是否可接受。若不可接受 ⇒ 启用备选 C3 | §4.5 |
| **G-7** | 置顶气泡态 + 其下第一个元素是带边框的 answer 容器 | §5.5 的视觉变化：10px 间隔下是否显拥挤；band 遮盖是否仍完整（**无透明缝**） | §5.5 |
| **G-8** | 长命令 + 长参数 + 决议徽记三者并存的工具行 | **FB7 的让位行为**：徽记 `shrink-0` 不截断、参数让位是否正确；**徽记的灰阶档位**（动词档 vs 参数档）当场定 | §6.5 |
| **G-9** | ⚠️ **拒绝一次授权请求**（deny 实测） | **§6.4 的未知量**：被拒的工具**是否还有 `Ran X` 行**。这是**唯一能推翻 §6.5 布局设计的实测**，⚠️ **必须排在 FB7 施工之前** | §6.4 / §6.7 |
| **G-10** | 一条含 `$$…$$` 的回答（MathML 输出路径） | §8.4（a）路的实证：Chromium 142 的 MathML 渲染质量是否可接受；**不可接受则转（b）路并启动红线偏离留痕** | §8.4 |
| **G-11** | ⚠️ **打包产物**（非 dev 态）里的公式渲染 | §8.5 地雷的终验：`electron-builder.yml` 改动后 katex 是否真的进包。**本批唯一需要出包验证的项** | §8.5 |
| **G-12** | 折叠 / 展开两态各一张（chevron 朝向） | §5.3 的四项确认之一：箭头是否指向「内容会出现的方向」 | §5.3 |
| **G-13** | 底部三行堆叠（流式中 + 完成后各一张） | §5.3 ②：`[正文] → [状态行] → [footer]` 是否需要合并（**Q4 的判据**） | §5.3 / §12 Q4 |
| **G-14** | 握手窗口（`PendingTurnHead` 与最后回合底部状态行相邻） | §5.4 的新形态问题：两条状态行相邻是否被读作重复（**Q5 的判据**） | §5.4 |
| **G-15** | 一个含 ≥2 个 process 段的回合，点一次折叠 | §4.6 E1 的**生产者缺席**检验：**全部段是否一起收起**（漏接 `open` 只会部分响应） | §4.6 / §13 ② |
| **G-16** | 键盘 Tab 到底部状态行并回车 | G1 触发器的键盘可达性 + `aria-expanded` / `aria-controls` 生效（node 测试测不到） | §5.3 / §13 ② |

---

## §11 切片方案

### 11.1 混面分析（先说清哪里不能并行）

【实测】`MessageTimeline.tsx`（1748 行）被**四件**同时触及，且是**三处不同区**：

| 件 | 区 | 锚点 |
|---|---|---|
| FB3 | `UserBubble` | `:737-848` |
| FB4 + FB6 | `ChatTurn` 骨架 | `:954` / `:979` / `:1141-1189` / `:1234-1320` |
| FB1 | `TurnItemView` 的 text 分支 | `:1557-1564` |

`chatTimelineLayout.ts` 被三件触及：FB3（`userBubbleTextClass`）· FB4/FB6（头注 + 可能的新类装配）· FB2（复用 `turnCopyButtonClass`，只读）。
`chatMarkdownPolicy.ts` 被两件触及：FB1（新增 `splitClosedPrefix`）· FB9（policy 卡片）。

⇒ **不存在「每件各切一片」的零冲突方案**。按**文件簇 + 依赖序**切五片。

### 11.2 五切片（依赖序：`① ∥ ⑤ → ② → ③ → ④`）

| 片 | 内容 | 独占文件 | 依赖 / 并行 |
|---|---|---|---|
| **① 纯模型层** | **FB8**（`formatThoughtRow` 复用分钟换算）+ **FB1-a**（`splitClosedPrefix` 纯函数 + hwm 语义，**只落纯模块与测试，不接线**） | `turnTiming.ts` · `chatMarkdownPolicy.ts`（新增函数区）· `turnTiming.test.ts` · `chatMarkdownPolicy.test.ts`（新增组） | **与全部片并行**；零 UI、零组件依赖 |
| **② FB7**（最重，单列） | 双行合并：join + 回落 + 徽记 | `toolCard.ts` · `ToolRows.tsx` · `questionCardModel.ts`（可能）· `toolCard.test.ts` | ⚠️ **G-9 deny 实测必须先于本片施工**；本片产出的 `TurnItemKind` 构成是 ③ 的输入 |
| **③ FB4 + FB6**（结构层） | 谓词改写 + head 移底 + 折叠壳重构 | `chatTurn.ts` · `MessageTimeline.tsx`（`ChatTurn` 区）· `chatTimelineLayout.ts` · `chatTurn.test.ts` · `messageTimelineWiring.test.ts`（**含 AST 定位器扩建**） | **依赖 ②** 的 kind 定案（§4.3 接口锁）。⚠️ **必须先补 `[FB6-1]` 钉子再动结构**（§5.6） |
| **④ FB1-b + FB9**（markdown 渲染层） | 分段渲染接线 + LaTeX + 打包链 | `ChatMarkdown.tsx` · `chatMarkdownPolicy.ts`（policy 卡片区）· `MessageTimeline.tsx`（`TurnItemView` 区）· `package.json` · `electron-builder.yml` · `chatMarkdownRender.test.ts` | **依赖 ①**（消费 `splitClosedPrefix`）；与 ③ **同文件不同区** ⇒ **谁后合谁 rebase** |
| **⑤ FB2 + FB3**（叶子交互层） | 代码块 copy + 气泡展开 | `ChatCodeBlock.tsx` · `MessageTimeline.tsx`（`UserBubble` 区）· `chatTimelineLayout.ts`（`userBubbleTextClass`） | 与 ① 并行；与 ③ 同两份文件不同区 ⇒ **谁后合谁 rebase** |

```
① ∥ ⑤ ──┐
         ├─→ ② ──→ ③ ──→ ④（rebase 到 ③ 之上）
G-9 实测 ─┘
```

**三条切片理由**：

1. **为什么 FB1 拆成 a / b 两片**：纯函数（含单调性证明与全部真值表）是本批**技术风险最高**的东西，让它先独立落地、独立跑绿、独立跑变异（M-01~M-03、M-05），**不与任何 UI 改动混在一次评审里**。接线（b）到 ④ 再做，此时它已是一个被证明过的黑盒。
2. **为什么 FB4 与 FB6 必须同片**：两者都改 `ChatTurn` 的**同一段 JSX 骨架**（`:1234-1320`），且 FB6 的 head 新位置**依赖** FB4 的段列表形态（head 要排在「所有内容段之后」，而「内容段」是 FB4 定义的）。拆开会让第二个人在一份刚被改过的 AST 投影上重新对账。
3. **为什么 FB7 排在 FB4 之前**：FB7 改 `TimelineItem` 的 kind 构成，FB4 的穷尽性测试 `[FB4-1]` 钉的就是这个构成。先 ② 后 ③ 可让该测试**一次写对**；反序则要写两遍。

### 11.3 每片收口条件（三件套，缺一不算收口）

| 收口项 | 要求 |
|---|---|
| **scoped vitest** | 本片独占文件对应的测试**全绿**；⚠️ **服务器内存有限，逐门串行跑，不得链式合跑**（曾 OOM `exit 137`）。⚠️ 测试只 import 纯模块，避免 node 环境 import 挂死 |
| **变异臂** | 按 §9.3 分配跑完本片那一段，**零跳过零存活**；先跑变异确认红、再回退确认绿，全 md5 对账还原 |
| **GUI 点验项** | 按下表逐项出图（亮暗双主题） |

| 片 | scoped vitest | 变异 | GUI 点验项 |
|---|---|---|---|
| ① | `turnTiming.test.ts` · `chatMarkdownPolicy.test.ts` | M-01~M-03、M-05、M-24、M-25 | —— （纯模型层，无 UI） |
| ② | `toolCard.test.ts` · `questionCardModel.test.ts` | M-19~M-23 | **G-9（前置）** · G-8 |
| ③ | `chatTurn.test.ts` · `messageTimelineWiring.test.ts` · `chatTimelineLayout.test.ts` · `messageTimelinePendingStatic.test.ts` | M-11~M-18 | G-6 · G-7 · G-12 · G-13 · G-14 · G-15 · G-16 |
| ④ | `chatMarkdownRender.test.ts` · `chatMarkdownPolicy.test.ts` | M-04（点验半边）· M-26~M-29 | G-1 · G-2 · **G-10** · **G-11（出包）** |
| ⑤ | `chatTimelineLayout.test.ts` · `messageTimelineWiring.test.ts` | M-06~M-10 | G-3 · G-4 · G-5 |

**全批收口**：五片合并后再跑一次全量 vitest（基线：F456 as-built 记录为 **239 文件 / 4724 例**，本批应只增不减）；四门逐门串行绿；FB11 真机重评（分诊档 §1 FB11：FB1 修后重评，如仍块状再议两个合批常量）。

### 11.4 影响面全清单

**生产代码（12 份）**：`turnTiming.ts`(①) · `chatMarkdownPolicy.ts`(①④) · `toolCard.ts`(②) · `ToolRows.tsx`(②) · `questionCardModel.ts`(②) · `chatTurn.ts`(③) · `MessageTimeline.tsx`(③④⑤) · `chatTimelineLayout.ts`(③⑤) · `ChatMarkdown.tsx`(④) · `ChatCodeBlock.tsx`(⑤) · `package.json`(④) · `electron-builder.yml`(④)

**测试（10 份）**：`turnTiming.test.ts` · `chatMarkdownPolicy.test.ts` · `chatMarkdownRender.test.ts` · `toolCard.test.ts` · `questionCardModel.test.ts` · `chatTurn.test.ts` · `messageTimelineWiring.test.ts` · `chatTimelineLayout.test.ts` · `messageTimelinePendingStatic.test.ts` · `chatSessionsCore.test.ts`（**只读不改** —— §6.2 ⑤ 的地基，必须保持绿）

**文档（4~5 份，归唯一集成者，单片施工者不得顺手改）**：本规格（as-built 回填）· `docs/plans/openchamber-chat-refactor-ledger.md`（D53 行补 as-built + §12 Q7/Q10 的追认与对账）· `docs/plantree/plans/openchamber-chat-refactor/{implementation-status,roadmap}.md` · 视 §8.4 结果可能追加 `globals.css` 头注例外说明

⚠️ **规划文档改动纪律**：`docs/plans` 与 `docs/plantree` 的表格行含全角标点，**跳过 Edit 工具，直接用 python 做字节级替换**（本仓已在此处栽过三次）。

---

## §12 开放问题（单列）

### 12.1 需**用户拍板**才能定形的（**六条**）

| # | 问题 | 本规格的建议 | 为什么必须问 |
|---|---|---|---|
| **Q4** | **底部状态行与 `TurnFooter` 是否合并成一行**（左：`Worked for 1m 6s · 3 tools`，右：`3h ago` + copy） | **建议合并** | 不合并则回合底部有**两条 meta 行**（且【实测 `:1683` + `messageMetadata.ts:186`】流式期 footer 可能已渲染）；合并会动到 T-31 §4.6 已验收的 footer 形态 ⇒ 判据见 G-13 |
| **Q5** | `PendingTurnHead` 与最后回合底部状态行**相邻重复**时的取舍 | 先点验，若确认重复则给 `pendingActive` 加互斥 | 移底后两条状态行从「隔着整个回合」变成「相邻两行」（§5.4）⇒ 判据见 G-14 |
| **Q6** | **Codex 路径的 `itemId` 透传是否本片做**（取证指出 3 处需改） | **不本片做** —— 本片先让 Claude 路径合并、Codex 走安全回落 | 透传要动 `codexRuntime.ts` 与协议帧，是另一个风险面；但不做则 Codex 用户看不到 FB7 的收益 |
| **Q7** | **Denied 色彩语义的追认** —— D28 连带项【实测 `ledger.md:72`】标注为「**编排者代拍，待追认**」 | 借本批合并**顺路追认**（复用 `text-destructive`，不发明新状态色） | 本批合并会重新暴露这个视觉决策，是补追认的最佳时机；**不得默认它已生效** |
| **Q3** | FB2 按钮的视觉存在感 —— 常驻可见（本规格裁定）是否够克制 | 常驻，但可降低常态不透明度到仍可辨档位 + `focus-visible` 增强 | 分诊档措辞是「悬浮」，而 F-B15 红线禁 hover-only（§2.3）—— 两者的调和需要用户对「克制程度」表态 |
| **Q1** | FB1 分段容器的**段间距实现** | 段容器用 `space-y-3.5`（与 `BLOCK_GAP` **同档同值**，不是新档） | 分段后 `first:mt-0` 使段间距塌成 0px；补间距时若被判为「新造第三档」会撞 F-C4「恰好两档」断言（`chatMarkdownPolicy.test.ts:649/686/692`） |

### 12.2 需**评审确认**的（技术判断，不必惊动用户；**五条**）

| # | 问题 | 本规格的判断 |
|---|---|---|
| Q2 | FB1 的 hwm 落点：`TurnItemView` 的 `useRef` 依赖 `turnItemKey` 稳定 | **须施工时实测**；不成立则上提到 `ChatTurn` 的 `Map<blockId, number>`（§1.5 ④） |
| Q8 | 时长的**小时档**（`formatWorkedForDuration` 同样没有） | **本批不加**（§7.2 三条理由），另立票 |
| Q9 | 行内 `$…$` 是否启用 | **不启用**（§8.6 四条理由）；需真实语料统计误伤率后再定 |
| Q12 | §4.6 的折叠实现取 **E1**（多受控 Collapsible + 单按钮多 `aria-controls`）而非 E2（自建 `hidden`） | **取 E1** —— 唯一不作废既有资产（R4 `keepMounted` + `turnProcessPanelClass()` 整篇论证）的方案 |
| Q13 | §5.3 的折叠触发器取 **G1**（回合级单触发器）而非 G2（段级多触发器） | **取 G1** —— G2 触发器行数 = 段数，铺屏反增，与 FB7 减行目的**正相反** |

### 12.3 文档与台账类（**两条**）

| # | 问题 | 建议 |
|---|---|---|
| **Q10** | **D53 ② 的措辞与实况对账** —— 台账写「需打通 permissionId↔toolCallId 关联」、分诊写「无纯模块做过」，而【实测】Claude 路径二者本就是同一字符串（§6.2） | **回写台账**：把「待解难题」订正为「Claude 路径天然成立（附 `permissionBridge.ts:38-42` + P0 回归钉），待打通的只有 Codex 路径」。它把 L 档的核心不确定性消掉大半，值得留痕 |
| **Q11** | 取证存档 `docs/plans/2026-08-19-fb4-fb6-structure-spec.md`（58 行，子代理产出，**未跟踪、未注册进 plantree**）的去留 | 其内容已被本规格 §4/§5 完全吸收 ⇒ **建议删除**以免 `docs/plans` 增殖与权威链混乱；**但本规格起草者未擅自删除**，去留请用户定 |

### 12.4 明确**另立票**、本批不做（**五条**）

1. **合批窗口常量调参**（`COALESCE_WINDOW_MS=45` / `RUNTIME_EVENT_FLUSH_MS=16`）—— FB1 落地后按 FB11 重评结果再定。
2. **行内 `$…$`**（Q9）。
3. **时长小时档**（Q8）。
4. **全局 UI 语言口径** —— F456 §10.1 Q3 遗留；本批新发现一处中文文案 `questionCardModel.ts:399`。
5. **`ToolRows.tsx` 五处 `leading-[1.55]` 任意值** —— F456 §10.3 ③ 既存违规；FB7 会改该文件但**不得顺手改**。

---

## §13 空壳风险自查（三类）

### ① 同名空壳（名字还在、语义已变，旧测试可能仍绿）

| 风险点 | 处置 |
|---|---|
| `splitTurnBody` 若保留名字改语义 | **整体改名 `segmentTurnBody`**，旧名**不得保留为 alias**（§4.2） |
| `answerEmpty`（`chatTurn.ts:186` / `MessageTimeline.tsx:1161`）新模型下几乎恒 false | **改名 `collapsedLeavesNothing` 并重定义**；不改则 `chatTurn.test.ts:254` 变成**一条永远测不到真实路径的绿灯**（§4.4） |
| `splitClosedPrefix` 只实现 R-2（围栏）而缺 R-3（前瞻）与 hwm | 函数名承诺的「结构闭合」即为空壳 ⇒ **验收锚点**：必须存在 loose-list 转换、缩进代码块延续、脚注定义续行三类反例的红→绿测试，以及 `[FB1-2]` 的 hwm 测试 |
| `processOpen` / `collapsible` 变量名承袭「process 段」概念 | 语义扩为「所有可折叠项」时一并改名（连带 `messageTimelineWiring.test.ts:481-484` 换钉） |
| `turnAnswerContainerClass` 头注 `at most one box per turn`（`chatTimelineLayout.ts:209`） | **与代码同批改** —— 典型的「头注比代码活得久」的假事实 |
| `chatTimelineLayout.ts:22-23` `the 10px "section gap" to the head` | 同批改（§5.5） |
| `MessageTimeline.tsx:936-944` `Renders, in order: …` | 同批改，**整段顺序作废**（§5.5） |
| `chatTurn.ts:29-35` notice 终止尾头注 | 同批改（§4.2） |
| T-31 §4.7「同一槽位两态」 | ⚠️ **不作废，只换槽位** —— 必须在台账写明，避免下次读档误以为该条被整体推翻（§5.1） |
| `chatMarkdownPolicy.test.ts:325` 用例名 `stays plain text` | **退役换新** —— 断言会继续绿，但承重命题已过期（§1.6） |

### ② 生产者缺席（结构造出来了但没人产出 / 没人消费）

| 风险点 | 检验方式（**必须是运行时实证，不是看类型**） |
|---|---|
| **`$$` 数学块分支在 FB9 落地前无生产者** | 【实测】仓内无 `remark-math`。⇒ §1.2 的 R-2 里 `$$` 一支**在片① 时确实无生产者**。处置：注释与文档必须写「**为 FB9 预留，效果 = 更保守**」，**不得**声称「数学块已支持」；其测试只能是白盒扫描 |
| `TurnSegment.kind === 'notice'` 若渲染层没写分支 ⇒ 系统/错误消息**静默消失** | `[FB4-1]` 穷尽性测试 + 一条「notice 段渲染 `NoticeMessage`」的 wiring 断言 |
| §4.6 E1 下多个受控 `Collapsible` 若有任一漏接 `open` ⇒ 点触发器只有**部分段**响应 | ⚠️ **node 测试测不到** ⇒ **G-15 强制点验**（含 ≥2 个 process 段的回合，点一次折叠，截图确认全部收起） |
| 底部行做成普通 `<button>` 后漏 `aria-expanded` / `aria-controls` | wiring 层断言属性存在 + **G-16 键盘可达点验** |
| `hasProcess` 与 `collapsible` 若各自独立算 ⇒ `turnHead.ts:341-345` 的「hasProcess 蕴含非空 head」不变量断裂，Collapsible 子树会在 metadata 到达时**重新挂载**（F2 已修过一次的缺陷） | 两处**必须由同一表达式派生**，并保留 `messageTimelineWiring.test.ts:426-432` 的等价钉 |
| **FB7 关联键的生产者** | ✅ **已实证**：不是「类型上有 `permissionId` 字段」，而是 `permissionBridge.ts:38-42` 的赋值 + `chatSessions.ts:786-788` 的落块 + `chatSessionsCore.test.ts` 的 P0 回归钉（一个**真实事故**证明它运行时有值）。这是本批唯一一条**已闭环**的生产者验证 |
| FB2 的 copy 按钮在**工具块**上的缺席 | ✅ **结构上不可能出现** —— `ChatCodeBlock` 到不了工具块（§2.2）；但 `[FB2-3]` 必须钉住这条路径不被打通 |

### ③ 硬编码信念（散落在测试 / 头注 / 本规格里的未证事实）

| 信念 | 现居何处 | 本批状态 |
|---|---|---|
| 「`answer` = 尾部连续 text 段」 | `chatTurn.ts:158-166` / `:206` · `chatTimelineLayout.ts:206` · `MessageTimeline.tsx:1302-1307` · `chatTurn.test.ts:181-185` **用例名** · `2026-07-31-reply-anatomy-design.md:362/379` | **本批推翻**，六处逐一改 |
| 「notice 终止 answer 尾」 | `chatTurn.ts:29-35` · `chatTurn.test.ts:193-197` | **本批推翻** |
| 「answer 容器至多一个」 | `chatTimelineLayout.ts:209` · `messageTimelineWiring.test.ts:724` `countIn(…) === 1` · F456 变异臂 **M-15** | C1 下推翻（C3 下保留） |
| **「head 是回合第一个子元素」** | **仅存在于头注与人的记忆 —— 无任何测试钉住** | **本批推翻，且必须新补钉子** `[FB6-1]`（§5.6） |
| 「head IS the trigger」 | `MessageTimeline.tsx:1183-1188` | G1 下**保留**（换位置） |
| 「一个 `Collapsible.Root` 一个 Panel」 | 无人写下，但 Base UI 实现如此（`useCollapsibleRoot.js:46-47` 单 panelId） | ✅ 本次取证**坐实**，是 §4.6 选型的硬约束 |
| 「vitest 能覆盖回合结构」 | `vitest.config.ts:12 environment: 'node'` **明确否定** | 已有记录，本批**不得依赖它** |
| ⚠️ **「flush 频率 ≈ 22 次/秒」** | 本规格 §1.4 | **从实读常量 45/16 推算**（常量是实测，推算是算术）；但**生成时长 20s/400s 是假设** |
| ⚠️ **「单段 markdown 解析耗时毫秒级/10KB」** | 本规格 §1.4 | **估计，无实测** —— 而**分段决策建立在它之上** ⇒ **施工前须以真实 100KB 回答实测一次**（G-2），否则 §1.4 的结论是信念而非证据 |
| ⚠️ **「被 deny 的工具没有 `Ran X` 行」** | 本规格 §6.4 | **推测，未实测** —— 且它是**唯一能推翻 §6.5 布局设计**的未知量 ⇒ **G-9 必须排在 FB7 施工之前** |
| ⚠️ **「Chromium 142 的 MathML 可用且质量可接受」** | 本规格 §8.4（a） | **知识推断，非实测**（同 T-31 §5.6 用 Chromium 版本推断 `scroll-state()` 的先例）⇒ **G-10 实测确认，失败转（b）路** |
| ⚠️ **「`rehype-katex` 不走 raw 节点路径」** | 本规格 §8.2 ④ | **推测** ⇒ 施工时验证，F-C5 源码扫描继续覆盖 |

---

## 附：本规格与既有档案的关系

- **上游**：`docs/plans/2026-08-19-usage-feedback-0820-triage.md`（FB1~FB11 分诊 + §2 改判清单 + §4 D53 三项拍板）。
- **被改判的既有裁定**（三条，本规格逐条给出「目标保留 / 手段升级」的表述，见 §1.1 / §4.1 / §5.1）：
  **D26 / T-29**（流式期纯文本）· **T-31 §4.2/§4.4**（answer = 尾部连续 text）· **T-31 §4.7**（head 在顶部）。
  ⚠️ T-31 §4.7 的「**同一槽位两态**」**未被推翻**，只换槽位坐标。
- **地基批次**：`docs/plans/2026-08-18-f456-readability-composer-spec.md`（**D50，四片已 as-built**）—— 其 §11 as-built 实录列出的产物是本批的施工地基（§0.3），其 §8.4 变异臂 **M-15** 被本批 §9.2 M-12 接替。
- **取证存档**：`docs/plans/2026-08-19-fb4-fb6-structure-spec.md`（FB4/FB6，**未注册**，去留见 §12 Q11）。
- **权威顺序**（plantree 注册表所定）：ARD ＞ 执行计划 ＞ 总台账（决策）＞ plantree（状态）。
  本规格属**批次施工规格**，其内裁定在与分诊档冲突时以本规格为准，在与总台账决策冲突时以总台账为准。
  ⚠️ 本规格已逐条核对，**与总台账无一处冲突**；但发现**一处措辞需订正**（D53 ② 的「需打通关联」，见 §12 Q10）。
- **下游**：本批落地后须回填 D53 行的 as-built、plantree 两份状态文件、本规格的 as-built 实录；
  FB11 真机重评结论另行记录。

## 拍板收口（2026-08-19，D55）

需拍板六条去向：Q4 = **底部状态行与 TurnFooter 合并成一行**（用户拍板）；Q7 = **Denied 警示色追认**（用户拍板，D28 代拍项转正）；Q1 = 段间距同档同值（采纳建议）；Q3 = copy 按钮常显低对比、禁 hover-only（采纳建议）；Q5 = PendingTurnHead 相邻观感转 GUI 点验项；Q6 = itemId 本片不做、走安全回落（采纳建议）。Q10 = D53 ② 措辞勘误已入台账 D55 ④；Q11 = 子档已删。**本规格转双轨双盲评审。**
