# T12 — 时间线外壳 + 输入/输出气泡视觉基线（2026-08-29）

> Phase 3 第一件。授权来自 [D9 rev.2](../decisions/009-timeline-reference-piapp.md)：
> **保留本仓设计语言（颜色/字号/圆角/@coss/ui），但布局、气泡形态、按钮位置均可调整；
> pi-app 是 MIT，能直接取用就取用，不为维持旧布局重复实现。**
> 参照实现：`/home/ai/code/pi-app/src/renderer/src/features/timeline/`。

## 一句话结论

用户提问的气泡改成了 pi-app 的形状（右对齐、80% 上限、右上角切角、**不再截断**），
模型回复**不再套盒子**（原来每段正文一个边框环），钉住提问的 `sticky` 吸顶条整条退役。
四门全绿，亮暗双主题真机截图已出，**等用户看图拍板**。

## 一、改了什么，以及为什么这三件是一条链

这批最重要的一点不是三处视觉改动，而是**它们本来就是同一条因果链上的三环**，
而只有第一环是当初真正想要的：

| 环 | 它当初为什么存在 |
|---|---|
| ① `sticky` 吸顶条（T-31 §5） | 读回复时还能看见自己问了什么 |
| ② 提问文字六行截断（F10） | ①会跟贴底滚动打架 —— 收起→内容变矮→浏览器把 `scrollTop` 夹回去→又展开，逐帧震荡。把截断改成**无条件**才切断了「滚动位置→高度→滚动位置」这条边 |
| ③ 恒显的 `Show more`（FB3） | 把②藏掉的正文还给用户 |

pi-app 的时间线里没有①（提问就是流里的普通一行），于是②失去前提、③失去对象。
**三件一起退役**，代码比改之前少一个 `useState`、少一个按钮、少一条 class 函数参数。

⚠️ **这条链的反向纪律已写进 `chatTimelineLayout.ts` 头注**：将来若因为超长提问要把截断加回来，
**不许连 `sticky` 一起加回来**，否则 F10 的震荡原样复现。断言层面由
`chatTimelineLayout.test.ts` 的 `T12: the turn chrome pins nothing` 兜住 ——
它遍历全部回合级 class 函数，任何一个长出 `sticky`/`fixed`/`z-*` 就红。

## 二、逐项 as-built

### 2.1 提问气泡（`userBubbleClass()` / `userBubbleRowClass()` / `userBubbleTextClass()`）

真机 `getComputedStyle` 实测（非推断）：

| 项 | 旧 | 新 | pi-app 参照 |
|---|---|---|---|
| 圆角 | `16px 16px 4px 16px`（切角在**右下**） | **`12px 4px 12px 12px`**（切角在**右上**） | `10px 2px 10px 10px` |
| 宽度上限 | 85% | **80%** | 80% |
| 内边距 | `10px 16px` | **`8px 14px`** | `0.5rem 0.875rem` = 8/14 |
| 面 | `--accent` | `--accent`（不变） | 无 token 对应 |
| 边 | `--input` | `--input`（**刻意保留，与 pi-app 不同**） | pi-app 无边 |
| 截断 | 无条件六行 + `Show more` | **无** | 无 |
| `title` 全文兜底 | 有 | **无**（没有藏起来的东西，就没有要 tooltip 揭示的东西） | 无 |

圆角取的是 design-system 的档位而不是 pi-app 的裸像素值：`rounded-md`（12px，容器 ≥32px 的档）
\+ `rounded-tr-xs`（4px）。切角**换了角**——原来指右下，现在按 pi-app 指右上，也就是指回消息被打出来的输入框。

**边框为什么不跟 pi-app 一起去掉**：F5 D3-c 当初量过，只有面的时候是
1.161（亮）/ 1.292（暗），边是 1.350 / 1.322。去掉边等于往回走到「这个气泡实际上没被画出来」那个状态，
而那正是 D3-c 这条决策当初要修的问题。

### 2.2 模型回复：`turnAnswerContainerClass()` 退役

原来每个 answer 段套一圈 `rounded-sm border border-border p-3.5`。现在没有了，正文直接落在时间线表面。

**这不是一枚硬币的正反面，理由是 FB4**：FB4 之前这个环是「一个回合一个盒子」；
FB4 让正文「发生在哪就渲染在哪」之后，一个交错回合（说一句 → 跑个工具 → 再说一句）
会长出**一段正文一个环**，于是一次回复里叠三个盒子、中间夹着工具行。
Q14 当时把这条明确记成「要靠出图来定的观感问题」——这批就是那个了结。

角色区分改由**不对称**承担，而不是两种盒子：

- 用户 → **是个物件**：右对齐、80% 封顶、有色面、一个切角；
- 模型 → **根本不是物件**：占满阅读宽度、无面、无边。

给模型侧「为了一致性」加个面或加个环，会从另一头到达 D3-b 当初反对的那个结果
（「什么都是卡片」）。这条已写成断言 —— `turnBodyClass()` 长出 `bg-*` / `border` / `ring` / `shadow-*` 即红。

### 2.3 节奏算术

带的 `sticky` 条同时也在承担一半的回合间距，退役时必须补回来，
否则 `space-y-2.5` 单独留下会**悄悄把回合间距减半**，而全仓没有第二处会发现：

```
旧： ReadingColumn space-y-2.5 (10) + 吸顶条 py-2.5 (10) = 20px 回合间
新： ReadingColumn space-y-5   (20)                        = 20px 回合间
     ChatTurn      gap-2.5     (10)  ← 原来是吸顶条的下内边距（提问 → 正文）
```

`F-B9` 现在钉的是**绝对值 20**，不是两个活值之间的关系 —— 因为要防的就是「其中一半被单独改掉」。

## 三、四门

| 门 | 结果 |
|---|---|
| typecheck（主仓） | 0 |
| biome `src` + `scripts` | 1045 文件，0 error 0 warning |
| vitest 全量 | **269 文件 / 5395 例全绿**（改动前 269 / 5397，净 −2 见下） |
| chat 子集 | 63 文件 / 1791 例全绿 |

### 变异验证：8 发全部咬红，还原后复绿

改写过的断言必须证明它们**还咬得住**，否则「改写立论」和「悄悄放宽」在报告里看起来一样。
逐发改一处源码、跑三份受影响的 suite（162 例）、改回：

| # | 变异 | 结果 |
|---|---|---|
| M1 | `chatTurnClass()` 去掉 `gap-2.5` | 3 红 |
| M2 | `readingColumnSpacingClass()` 退回 `space-y-2.5`（= 悄悄把回合间距减半那一手） | 2 红 |
| M3 | `userBubbleClass()` 长出 `sticky top-0` | 1 红 |
| M4 | `userBubbleClass()` 去掉 `min-w-0`（只留 `max-w-[80%]`） | 1 红 |
| M5 | `turnBodyClass()` 长出 `border border-border` | 2 红 |
| M6 | 圆角改成裸像素 `rounded-[10px]` | 1 红 |
| M7 | 切角换回右下 `rounded-br-xs` | 1 红 |
| M8 | answer 分支重新套回 `rounded-sm border border-border p-3.5` | 1 红 |
| — | 全部还原 | **162 例全绿** |

净 −2 的来历：`[FB3-2]`（两例）+ `[FB3-3]`（一例）随 `Show more` 退役，
换成 T12 的两例（「气泡子树不读任何几何量」+「`userBubbleTextClass` 调用不带参」）。
**FB3 携带的不变量没有丢，只是换了更强的形式**：原来盯的是「传进去的参数不是几何量」，
现在盯的是「整个 `UserBubble` 子树里没有 `getBoundingClientRect` / `IntersectionObserver` /
`ResizeObserver` / `scrollHeight` / `clientHeight` / `offsetTop` / `useRef`」。

## 四、被改写（而非删除）的既有断言

每一条都是**改写立论**，不是放宽：

| 断言 | 旧立论 | 新立论 |
|---|---|---|
| `F-C4`（markdown 根不许 overflow） | 会关掉吸顶条的 sticky | 宽表格/代码块**在叶子上**横向滚动，祖先一旦 clip 就是静默吞掉右半边 |
| `F-B10`（回合 section 不许 overflow） | 同上 | 同上 |
| `F-B10`（section 不带 gap） | 那 10px 归吸顶条的下内边距 | **反转**：section 现在**必须**带 gap-2.5，因为它是唯一同时跨提问与正文的元素 |
| `F-B8`（吸顶条形态 + sticky 禁令） | — | 整块退役，换成 `T12: the turn chrome pins nothing`（全部回合级 class 函数不得长出 sticky/fixed/z-*） |
| `[D3-1]` | 读 JSX 里的两个字面量 | 读**挂载了哪两个 class 函数**；class 内容改由 `chatTimelineLayout.test.ts` 按返回值断言 —— 比原形式强，`cn()` 参数换序不再假红 |
| `[D3-8]` | 保护六行截断的行预算不被附件 chip 吃掉 | 截断没了，但**分离仍然承重**：`userBubbleTextClass()` 带 `select-text`，把附件条折进去会让「拖选提问」把文件名一起选中，像是用户自己打的 |
| `[FB4-7]` | 容器只挂在 answer 分支 | **反转成禁令**：`renderSegment` 整个函数体里不许出现 `border-border` / `rounded-sm` / `bg-muted` / `bg-card` / `shadow-` |
| AST 投影自检的字面量探针 | `rounded-br-xs` | `bg-muted/50`（前者随 T12 移出了 `.tsx`） |

## 五、GUI 实测（真机 CDP，`node scripts/dev.js --remote-debugging-port=9222`）

亮暗双主题各两张，截图在 [`t12-screenshots/`](./t12-screenshots/)：

| 图 | 内容 |
|---|---|
| [light-turn-top.png](./t12-screenshots/light-turn-top.png) | 亮色 · 提问气泡 + 裸正文 + 代码块 |
| [light-tools-mid.png](./t12-screenshots/light-tools-mid.png) | 亮色 · 工具行内联在回复流里 + 列表 + meta 行 |
| [dark-turn-top.png](./t12-screenshots/dark-turn-top.png) | 暗色 · 同上 |
| [dark-tools-mid.png](./t12-screenshots/dark-tools-mid.png) | 暗色 · 同上 |

**取数方式，如实说明**：时间线内容是**注入的合成 transcript**，不是一次真实模型回合 ——
通过 Vite dev server 动态 `import('/stores/chatSessions.ts')` 后
`store.setState({messages})` 塞入。渲染路径是真的（`groupMessagesIntoTurns` →
`ChatTurn` → 真组件真 CSS），但**「流式时长什么样」这一半没有被这批截图覆盖**。

实测确认（`getComputedStyle`，非从 class 名推断）：

- 亮色气泡 `border-radius: 12px 4px 12px 12px` · `background oklch(0.9422 0.0122 96.43)`（= `--accent`）· `border oklch(0.8463 …)`（= `--input`）· `padding 8px 14px`；
- 暗色同一元素 `background oklch(0.2912 0.0029 17.32)` · `border oklch(0.3651 0.0044 67.69)`，圆角一致；
- 主题切换后 `documentElement.className` 在 `''` ↔ `'dark'` 之间正确翻转，**收工已复位为 light**。

---

# T12-b — 删掉 meta 行，换成悬停操作条（2026-08-29，同日追加）

> 用户看图后拍板两条：① 整体效果满意；② **meta 行跟随 pi-app 删掉**；
> 复制按钮的放置方式给了三选一，用户选 **「完全照抄 pi-app」——即 hover-only，`F-B15` 红线退役**。

## B-一、pi-app 到底是全丢还是重新安置（逐项核过源码，非推测）

| meta 行上的东西 | pi-app 的处置 |
|---|---|
| 复制按钮 | **保留**，挪进悬停才出现的小工具条，与 `fork` / `rewind` 并排（`message-hover-actions.tsx`） |
| 时间戳 | **保留**，同一条工具条最右边，只显示 `HH:MM` |
| 思考时长 | **保留**，换到思考块自己身上写成 `Thought for Xs`（本仓已有） |
| 回合总时长 + 工具数 | **真的不显示**。实证：`timeline-turn-timing.ts` 里 `deriveTurnTimingsFromItems` / `formatTurnDuration` 都还在，但**全仓零调用方** —— 删 footer 之后留下的死代码 |
| 模型名 | 不在时间线里，挪到输入框右下角常驻（`composer-model-strip`），回答的是「这个会话用哪个模型」而不是「这段是谁答的」 |

取舍逻辑：**「关于这条消息你能做什么」留下（悬停才露），「关于这次运行的统计」丢掉。**

## B-二、本仓落地

- **删**：`turnMetaRowClass()` · `TurnMetaTail` · `TurnHeadContent` · `WorkedForContent` ·
  `deriveTurnHeadModel` / `TurnHeadModel` / `TurnHeadInput` · `formatMessageMetadata` ·
  `useMinuteTick` + `footerNowMs` 全链。
- **加**：`turnActionsSlotClass()`（`grid-rows-[0fr] → [1fr]`，pi-app 的 animate-to-auto）+
  `turnActionsInnerClass()`（`overflow-hidden min-h-0`）+ `chatTurnClass()` 上的
  `group/turn` 命名悬停域。条上是复制按钮与 `formatAbsoluteTime(completedAt)` 的 `HH:MM`。
- **保**：**进行中的状态行**（`Awaiting first token 8s` / `Stalled` / `Failed` / retry）。
  它跟 meta 行只是**碰巧共用一个槽**，不是同一件东西 —— F2 的「秒表丢了」缺陷就是这行在
  还在跑的时候消失。现在 `ChatTurn` 直接渲染 `TurnStatusContent`，与 `PendingTurnHead`
  写法完全一致，**跑完就什么都不显示**。

`F1` 的退役理由说清楚：它那条 `status → workedFor → stats → thought → bare` 降级链，
四个降级档回答的都是同一个问题——「没量到时长的已完成回合该说点什么」。
现在的答案是「什么都不说」，问题本身消失了，所以链跟着退役，只留最上面那一档。

## B-三、红线反转（`F-B15`）

原规则：复制按钮**永远不能**悬停才出现，因为只有鼠标能发现的控件**键盘和触屏够不到**。
用户在被告知代价后选择照抄 pi-app，所以这条**明确反转、不是悄悄放宽**，代价记在
`turnActionsSlotClass()` 的头注里：**键盘用户和触屏用户从时间线上拿不到复制**。

保留下来的那半条写成了断言：**遮蔽只能在容器上，绝不能在按钮自己身上**。
按钮若也带 `opacity-0`，就变成「两件事都得同意才点得动」——那是经典的「看得见但点不动」。

## B-四、GUI 实测抓到一个断言抓不到的真缺陷

**症状**：折叠态的操作条**不是 0 高，是 28px**（`grid-template-rows` 实测解析为 `28px`）。
也就是说它「收起来」了但**照样占着位置**，正好把删掉 meta 行省下的竖向预算又花回去 ——
这个改动会从「实际瘦身」退化成「纯装饰」。

**根因**：`h-7` 是从 pi-app 的 `.message-actions-slot-inner` 原样抄来的。
但 grid item 一旦有**确定高度**就压不扁：`0fr` 轨道隐含的 `minmax(auto, 0fr)` 里那个 `auto`
会取这个高度。浏览器里实测：去掉固定高度后 `grid-template-rows` 立刻变 `0px`。

**为什么断言全绿**：`grid-rows-[0fr]`、`overflow-hidden`、`min-h-0` 三个类**一个不缺**，
每一条单看都正是规格要求的。失效发生在 `grid-rows-[0fr]` 与**另一个兄弟类**的相互作用上，
不在任何单个类里。⇒ 这是 0820 批 §16「空转臂」同型的第七发。

**修法 + 新钉子**：行高改由内容（24px 复制按钮）决定；新增断言
`T12-b: the squashable row carries no fixed height (measured, not inferred)` ——
禁止这一行出现任何高度类，并交叉钉住按钮的 `size-6` 是承重的而非装饰。
把 `h-7` 加回去实测**立刻咬红**。

## B-五、验证

| 门 | 结果 |
|---|---|
| typecheck | 0 |
| biome `src`+`scripts` | 1045 文件，0/0 |
| vitest 全量 | **269 文件 / 5381 例全绿** |
| 变异 | **8/8 咬红零存活**（M9~M16），还原后 61 例复绿 |

变异臂：M9 内层行重新长出固定高度（= 真实缺陷）· M10 折叠改成纯 `opacity` ·
M11 悬停域改成匿名 `group` · M12 按钮自己也带 hover 遮蔽 · M13 去掉 `motion-reduce` ·
M14 流式中不再扣留复制 · M15 删掉进行中状态行 · M16 操作条挪到正文上方。

**真机 CDP 实测**（不是从类名推断）：

- 折叠态两条 strip 均 `height: 0` · `grid-template-rows: 0px` · `opacity: 0`；
- 用 `Input.dispatchMouseEvent` 真悬停第二个回合后：**只有第二条**打开
  （`24px` / `opacity: 1`），第一条纹丝不动 ⇒ **`group/turn` 的按回合作用域成立**；
- 亮暗双主题各一张，见 `t12-screenshots/light-strip-hover.png` ·
  `dark-strip-hover.png` · `light-strip-collapsed.png`。

⚠️ **`HH:MM` 那一半没在屏幕上看到**：合成 transcript 不经过 runtime event bus，
`MessageMetadata` registry 拿不到 `completedAt`，所以实测出来的条上只有复制按钮。
时钟那半只有代码路径断言（`formatAbsoluteTime(metadata.completedAt)` 在调用位）+
`formatAbsoluteTime` 自己的既有单测，**真机没验**。

## 六、未做 / 待办

1. ~~用户拍板~~ ✅ **已拍板（2026-08-29）**：整体效果满意；meta 行**跟随 pi-app 删掉**；
   复制按钮**完全照抄 pi-app**（hover-only，`F-B15` 退役）。见上文 T12-b。
2. **流式态未截图** —— 合成 transcript 是静态的。「正文一边流一边长」「工具行 live 态」
   「进行中的状态行长什么样」都要等真实回合，跟 T08-b 的真机 E2E 一起做更划算。
3. **悬停条的 `HH:MM` 未在屏幕上看到** —— 见 B-五 末尾。补法：真实回合跑一轮即可。
4. **T12-a~d 未开工** —— 数据建模、工具行人话摘要 + diff 徽记、思考链与流式文本、
   展开记忆与跟随滚动，都还在 Deferred。
5. **`fork` / `rewind` 未做** —— pi-app 的悬停条上还有这两个按钮（从这一条分叉新会话 /
   回退到这一条）。本仓没有对应能力，属 T13「会话管理」范围，本批不发明。
6. **未走双轨双盲评审** —— 与 T08-c 同口径（用户定的优先级是功能优先）。

## 七、改动文件

| 文件 | 变化 |
|---|---|
| `src/renderer/components/chat/chatTimelineLayout.ts` | 退役 `turnBubbleBandClass()` / `turnAnswerContainerClass()`；`userBubbleTextClass()` 去参数去截断；新增 `userBubbleRowClass()` / `userBubbleClass()`；`readingColumnSpacingClass()` 2.5→5；`chatTurnClass()` 补 `gap-2.5` |
| `src/renderer/components/chat/MessageTimeline.tsx` | `UserBubble` 去 `useState`/去 `Show more`/去 `title`，改挂三个 class 函数；`ChatTurn` 的吸顶条 wrapper 删除；answer 分支去容器；两处长注释按新事实重写 |
| `src/renderer/components/chat/__tests__/chatTimelineLayout.test.ts` | F-B8 块退役换 `T12: the turn chrome pins nothing`；F-B9 改绝对值；F-B10 gap 断言反转；clamp 块改写；答案容器块改写成禁令 |
| `src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts` | §5 / `[D3-1]` / `[D3-8]` / `[FB4-7]` / FB3 块逐条改写；`turnBodyNode()` 容忍无 className 的兄弟节点；删 `nodeClassNameArgs`（唯一调用方是旧 `[D3-1]`） |
| `src/renderer/components/chat/__tests__/chatMarkdownPolicy.test.ts` | `F-C4` 立论从 sticky 改为 clip |

T12-b 追加：

| 文件 | 变化 |
|---|---|
| `chatTimelineLayout.ts` | 退役 `turnMetaRowClass()`；新增 `turnActionsSlotClass()` / `turnActionsInnerClass()`；`chatTurnClass()` 加 `group/turn`；`turnCopyButtonClass()` 头注反转 `F-B15` |
| `MessageTimeline.tsx` | 删 `TurnHeadContent` / `WorkedForContent` / `TurnMetaTail` / `useMinuteTick` / `footerNowMs`；`ChatTurn` 改渲染「进行中状态行 + 悬停操作条」 |
| `turnHead.ts` | 退役 `TurnHeadModel` / `TurnHeadInput` / `deriveTurnHeadModel` |
| `messageMetadata.ts` | 退役 `formatMessageMetadata`（`formatRelativeTimestamp` / `defaultFormatTime` 保留，侧栏仍在用） |
| 四份测试 | `chatTimelineLayout` / `messageTimelineWiring` / `turnHead` / `messageMetadata` 逐条改写立论；新增「不许有固定高度」的实测型钉子 |
