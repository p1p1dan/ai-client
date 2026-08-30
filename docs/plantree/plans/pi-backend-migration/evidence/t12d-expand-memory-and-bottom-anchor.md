# T12-d — 展开记忆 · 底部锚点（跟随滚动与问卷经评估未做）

日期：2026-08-30 · 分支 `feat/pi-primary-backend`

## 一句话

T12-d 原本写着"直接取用 `toolExpandBySession`、follow-scroll/bottom-anchor、questionnaire-dialog"
四件事。**逐条核过之后只有两件成立**：展开记忆（真缺口，且被 T12-b 变成了新的可达路径）
与底部锚点（真缺口，本仓两个终端早就有、聊天时间线没有）。跟随滚动我们已经有了、
而且比参照实现多论证了一种情况；问卷建立在 pi-app 的 extension-compat 适配器层上，
而那一层是本 plan README 白纸黑字的**非目标**。

## 一、展开记忆（做了）

### 缺陷是什么

工具行的展开状态原本完全活在 `Collapsible` 组件实例里，组件一卸载就没了。
两件事会卸载它：切换会话再切回来；**以及聚合把这一行吞掉**——后者是真正扎人的那个。

探针实测（pi 后端，一个回合里两次连续 `read`）：

```
step 1  (a.ts 完成)      -> [ key "block-a",     "Read a.ts"        ]
step 2a (b.ts 运行中)    -> [ key "block-a",  key "block-b" ]
step 2b (b.ts 完成)      -> [ key "block-a~agg", "Explored 2 files" ]
```

到 2b 这一步，**用户打开的那一行在顶层不存在了**：两次 read 折进一个默认收起的
聚合行，原来那行只作为它 `detail` 里的孩子存在。于是"我打开一个文件的输出正在读，
agent 又读了下一个文件，我在看的东西就没了"。

**这条路是新可达的**：T12-b 之前 `classifyTool` 对 pi 的小写工具名一律返回 unknown，
聚合在这个后端上**从来没触发过**。修好词汇表，也就把这个形状放了出来。

### 只记住那一行是不够的

把 `block-a` 恢复成展开，它会展开在一个**收起的容器里面**——照样看不见。
所以 `resolveToolRowOpen` 有第二条规则：**`detail` 里有被记住为展开的孩子，
这一行也展开**。行自身的显式选择永远压过它，所以用户手动收起聚合之后，
即使孩子还标着展开，聚合也保持收起（否则这一行永远关不上）。

### 为什么是"挂载时取种子"而不是受控

`defaultOpen` 只在挂载时被读一次，而这正是它保住 T-34 的原因：
实时子代理面板的 `defaultOpen: true` 会在通道不再 live 的那一刻消失，
一个绑在同一表达式上的受控 `open` 会**在读者读到一半时把面板拍上**。
取种子的写法顺带让聚合这个场景免费成立——聚合吞行时它本来就是一次**新挂载**，
会拿新的记忆重新求值。

代价写在类型上：`readToolExpandMemory` 是**不订阅**的读。订阅会让每次开合
都重渲染时间线里的每一行工具行，而屏幕上什么都不会因此变化。

### 刻意没取的东西

pi-app 还会**自动展开运行中回合的最后 N 个工具**
（`timeline-tool-expand-policy.ts`）。**没取**——它会反转 2026-08-25 记在
`ToolRows.tsx` 里的用户决定：行只在有东西明确要求时才打开，因为自动打开会让
每一个失败或被拒的调用都在屏幕上摊开一墙输出。这个存储只记选择，从不替用户做选择。

单测里钉的是后果不是散文：`never opens a row on its own accord` 遍历真实派生出来的
每一行，任何一行自己开了就红。

### 真机实测（不是只有断言）

CDP 驱动真实 app，注入合成 transcript 走真渲染路径。

| 图 | 内容 |
|---|---|
| `t12d-screenshots/t12d-A1-collapsed.png` | 一次 read 完成，行收起 |
| `t12d-screenshots/t12d-A2-expanded.png` | 用户点开，面板 **146px**，文件内容在屏 |
| `t12d-screenshots/t12d-A3-absorbed.png` | 第二次 read 落地、聚合触发，**`Explored 2 files` 是打开的**，里面 `Read src/greet.ts` 也是打开的，输出还在 |
| `t12d-screenshots/t12d-A0-control.png` | **对照**：清空记忆后跑同一段序列 —— `Explored 2 files` 收起、面板 0 个（这就是修之前的样子） |
| `t12d-screenshots/t12d-A4-after-session-switch.png` | 切走再切回，两个面板都回来了 |
| `t12d-screenshots/t12d-A5-dark-absorbed.png` | 暗色同形 |

实测数字（`getBoundingClientRect`，不是从类名推断）：

```
step 2 用户展开后      panels [146]
step 3 聚合吞掉之后    panels [199, 146]     ← 聚合自己 + 孩子，两层都开着
对照（清空记忆）        panels []             ← 修之前
切走                   panels []             ← 另一个会话不继承
切回                   panels [199, 146]
```

## 二、底部锚点（做了）

### 缺陷是什么

`ShellTerminal` 和 `AgentTerminal` 早就各有一颗"滚到底部"的圆钮
（`useTerminalScrollToBottom.ts`），**聊天时间线一颗都没有**。往上翻去看历史，
回到直播端的唯一办法是手动滚回去。

### 两个阈值，不是一个

- `STICK_TO_BOTTOM_THRESHOLD_PX = 40` 回答"用户还在跟随吗"，必须紧，
  否则一次有意的上滑会被自动滚动一直顶回去。
- `JUMP_TO_BOTTOM_THRESHOLD_PX = 140` 回答"下面藏的内容值不值一颗按钮"。
  用紧的答案去回答这个问题，41px 的滑动就会画出一颗按钮——一个读着读着就闪进闪出的
  控件比没有更糟。140 取自参照实现同一判断的实测值（`TIMELINE_NEAR_BOTTOM_PX`）。

**两者之间是一条真实的死区**：离底 40–140px 时时间线不再跟随、也不提供按钮。
它会自己关上（下面的内容一长距离就过线），这是"不让任一阈值对自己度量的东西撒谎"的代价。
死区写成了断言，防止后人把两个常量"简化"成一个。

### 可见性取几何，不取跟随标志

`nextFollowState` 会在视口就在最底部时报告"没在跟随"（规则 2：高度变化那一帧不携带
意图证据，所以沿用旧值）。把按钮绑在那个标志上，会在用户**正看着底部**时画出
"跳到底部"。所以按钮只看几何。

### 位置在滚动容器外面

绝对定位挂在 `MessageTimeline` 最外层的 wrapper 上，不是滚动视口里。视口内的
绝对定位子元素会跟着内容滚走，而 `sticky` 正是 `chatTimelineLayout.ts` 在 F10 之后
明令禁止的形状。外面这一层既不滚动也不参与时间线布局。

形状取**本仓自己的**（`bottom-3 right-3` · 32px 圆钮 · `bg-primary/80` · `ArrowDown`），
不取 pi-app 的居中药丸：同一个窗口里对"跳回直播端"这一个手势有两套词汇，
是比"跟参照实现不一致"更差的选择。顺带把 `Scroll to bottom` 的中文补进 `i18n.ts`
——两个终端一直在用这个 key，一直没有译文。

### F-B15 不适用

`F-B15` 把"复制按钮不能悬停才出现"这条红线反转过，理由是那些动作在别处也有。
**这个理由不能搬过来**：这颗按钮是回到运行中回合的唯一入口。所以它是一个真的
`<button>`，带 `aria-label`，只要在屏就能被键盘拿到，可见性只由几何决定。
断言里钉了 `group-hover` / `opacity-0` / `invisible` 一个都不许出现。

### 真机实测

| 图 | 内容 |
|---|---|
| `t12d-screenshots/t12d-B1-at-bottom.png` | 停在底部：无按钮 |
| `t12d-screenshots/t12d-B2-button.png` | 滚到顶：按钮在，32×32 圆钮 |
| `t12d-screenshots/t12d-B3-after-click.png` | 点击后回到底部，按钮消失 |
| `t12d-screenshots/t12d-B4-dark-button.png` | 暗色同形 |
| `t12d-screenshots/t12d-B5-growth.png` | 增长路径（见下） |

```
停在底部              distance 0     button false
上滑 100px（死区内）   distance 100   button false     ← 死区在真机上是真的
滚到顶                distance 2511  button true      w32 h32 position absolute opacity 1
点击之后              distance 0     button false
```

**增长路径单独隔离验证过**（这是只有 ResizeObserver 能看见的那一半）：

```
停在底部、短 transcript        button false
上滑 100px（死区内）           button false
内容在静止视口下面长起来       button true   distance 2755   ← 全程没有 scroll 事件
```

用户在直播回合里往上翻看历史时视口根本不动，所以只挂 scroll 监听会漏掉最要紧的那种情况。
变异 M6 删掉这一处 `syncJumpToBottom(viewport)` 会咬红。

## 三、跟随滚动（评估后：不动）

`messageTimelineScroll.ts` 的 `nextFollowState` 已经在做这件事，而且比
pi-app 的 `isTimelineNearBottom` 多回答了一种情况：**内容在视口底部上方缩短时
浏览器会把 `scrollTop` 夹到新的最大值——正好落在底部——并抛出 `scroll` 事件**，
用那一帧去武装跟随器，就等于把视口焊在一个用户没选择跟随的文档底部（F10 的放大器那一半）。
pi-app 的判据只有"离底多远"，表达不了这一帧。

结论：没有可迁移的东西。本批只在它旁边加了 `shouldShowJumpToBottom`，一个字没改。

## 四、问卷（评估后：不做，理由与 T12-b 切片 2 同源）

pi-app 的问卷链路是
`questionnaire-tool-decorator.ts` → `resolveV2ByPluginName`（`extension-compat/adapter-loader.js`）
→ `adapter.interact.schema === 'questions'`。也就是说它挂在**逐扩展适配器层**上，
而本 plan README 的非目标第 2 条写的就是"不做 pi-app 的 34 个逐扩展适配器"。
这与 T12-b 切片 2 把范围从三层砍到两层是同一条依据。

另一半事实：`piRuntime.ts` **从不发 `question` 事件**（全文件 0 次命中），
所以本仓那套 `QuestionCard.tsx` / `questionCardModel.ts` 在 pi 上是够不着的
——它是 Claude 的 AskUserQuestion 路径。pi 真正的提问通路是 Extension UI
（`ui.select` / `ui.input`），也就是 T08 已经做完的四种原语。

结论：roadmap 原文"问卷共用已完成的 T08 原语"是对的，而它同时意味着**这件事已经不欠了**。

## 四点五、悬停操作条改为预留高度（2026-08-30 用户反馈后的决定反转）

用户实机反馈：**鼠标移到某条回复上、复制按钮出现时，下面的内容被推着上下跳**。

### 这是 T12-b 明确选过的那一半，现在被推翻

T12-b 当时选的是 `grid-rows-[0fr] → [1fr]`（pi-app 的 animate-height-to-auto），
并在注释里写明理由：折叠态必须是**真正的零高度**而不是 `opacity-0`，否则每个回合底下
常驻一条 24px 的空白，等于把删掉 meta 行省下的竖向预算又花回去。

那条理由本身没错，它只是在替用户权衡一个用户不接受的代价。用户看到实机之后的判断是：
**在光标下面长出一行、把下面的字全部顶下去，比 24px 的永久空白更难受**。

### 改法

- `turnActionsSlotClass()`：去掉 grid 与高度动画，只留 `opacity-0 → group-hover/turn:opacity-100`
  加 `transition-opacity`。
- `turnActionsInnerClass()`：**必须**带确定高度 `h-6`（24px，与复制按钮的 `size-6` 同档），
  并去掉 `min-h-0` / `overflow-hidden` —— 那两个只为 `0fr` 轨道服务。

这是把 T12-b 的钉子**整条反转**：那条断言原本禁止这一行出现任何高度类
（因为固定高度的 grid item 压不扁，会让"折叠态"实测 28px）。两个版本各自对自己的机制都成立，
所以断言改写的是立论而不是放宽，旧版失效的原因写在注释里保留。

**没有加 `pointer-events-none`**。它看着像 `opacity-0` 的天然搭档，实际是空转：
指针要落到透明条上，必须先进入这个回合，而进入回合正是让它显形的条件 ——
"透明且可点"这个状态到不了。

### 真机对照实测

同一台机器、同一份合成 transcript，CDP 量 `getBoundingClientRect`：

```
新机制（预留高度）
  idle      turnTops [-199, 5, 209, 413]   条高 [24,24,24,24]  opacity [0,0,1,0]
  hovering  turnTops [-199, 5, 209, 413]   条高 [24,24,24,24]
  离开      turnTops [-199, 5, 209, 413]   条高 [24,24,24,24]  opacity [0,0,0,0]
                     ↑ 三次读数一模一样 = 悬停零位移

旧机制（把 grid 装回去做对照）
  折叠态    条高 [0,0,0,0]
  展开态    条高 [24,24,24,24]   grid-template-rows: 24px
                     ↑ 每次悬停把下面的内容推低 24px，就是用户报的现象
```

展开态那一组是**强制**成 revealed 状态量的（把 `group-hover/turn:` 变体去掉），
不依赖 CDP 能不能触发真 `:hover` —— 实测过程中 `Input.dispatchMouseEvent` 对 CSS `:hover`
的结算有一拍延迟，靠它做对照会读到误导性的数字。

图：`t12d-screenshots/t12d-C1-hover-reserved.png`（悬停中的回合复制按钮可见，
其余回合位置未动）。

变异 5 发全咬红：把高度动画装回来 · 去掉预留高度 · 预留高度与按钮档位脱钩（`h-6`→`h-7`）·
`transition-opacity` 改 `transition-all`（会重新动画高度）· 把挤压残留留在 inner 上。

⚠️ **未改的一条**：键盘 Tab 到复制按钮时它仍然不显形（`focus-within` 没加）。
这是 F-B15 反转留下的**既有**代价，不是本次引入的；现在位置已经预留好，加上去是零布局成本的，
但用户这次只要求"放鼠标时显示出来就行"，所以没有擅自扩大范围。

## 五、测试与变异

净增 **33 例**（5461 → 5494，含悬停条反转批把一条断言拆成两条）：`stores/__tests__/toolExpansion.test.ts` 新文件 15 例 ·
`messageTimelineScroll.test.ts` 6 例阈值 · `messageTimelineWiring.test.ts` 10 例接线
（底部锚点 6 + `sessionId` 逐跳 4，后者是 `it.each` 三跳 + 一条 `ToolGroup` 调用点）·
`subagentWiring.test.ts` 1 例新增 + 1 例**改写既有断言**（`defaultOpen` 的表达式换了位置，
规则没换，所以是改写立论而不是放宽）。

**接线扫描是必需的**，理由与 T12-e 同型：真值表可以全绿而规则从未在真实时间线上生效，
因为喂给它的行是手写的。所以 `toolExpansion.test.ts` 最后一段直接驱动
`deriveToolGroupRows`（真派生 + pi 的小写工具名）再过 resolver。

变异 **15 发，14 发首轮咬红，1 发存活后补断言**：

| # | 变异 | 结果 |
|---|---|---|
| M1 | 删掉 detail 继承规则 | 红 |
| M2 | `=== true` 改成"非 undefined" | 红 |
| M3 | 行自身的 `false` 不再压过孩子 | 红 |
| M4 | `>` 改 `>=` | 红 |
| M5 | 140 改成 40（两个阈值合一） | 红 |
| M6 | 删掉 ResizeObserver 里的同步 | 红 |
| M7 | 删掉 `ChatTurn` 那一跳 | **首轮存活** → 见下 |
| M8 | 删掉 `TurnItemView` 那一跳 | 红 |
| M9 | 删掉 `ToolGroupItem` 那一跳 | 红 |
| M10 | 删掉 `ToolGroup` 那一跳 | 红 |
| M11 | 退回不认记忆的 `defaultOpen` | 红 |
| M12 | 删掉 `onOpenChange` 的写回 | 红 |
| M13 | 把 `lastScrollHeightRef` 写在 `scrollTop` 之后 | 红 |
| M14 | 给按钮加 `opacity-0 group-hover:` | 红 |
| M15 | `absolute` 改 `sticky` | 红 |

⚠️ **M7 首轮存活，原因值得记**：断言写的是"文件里 `sessionId={sessionId}` 至少出现 4 次"。
删掉 `ChatTurn` 那一跳之后**还剩 4 个**——`HistoryErrorNotice` 自己也带一个——
于是计数照样满足，而链条第一环已经断了。改成**逐跳断言**（在执行这一跳的那个元素内部查）
之后 M7~M10 全红。这是"计数式断言"的经典失效形状。

## 六、四门

| 门 | 结果 |
|---|---|
| typecheck（主仓） | 0 |
| biome（`src` + `scripts`） | 1058 文件 · 0 error / 0 warning |
| vitest | **277 文件 / 5494 例** 全绿（T12-c 后基线 276 / 5461） |
| 变异 | 主批 15 发（14 首轮红 + 1 补断言后红）+ 悬停条反转批 5 发全红 |

## 七、⚠️ 未做 / 未验

- **没跑真实 pi 回合**：截图用的是注入的合成 transcript（走真渲染路径，
  但事件总线没参与）。与 T12-a/b/c 同一条未验假设。
- **没测超长 transcript 下的按钮抖动**：ResizeObserver 每帧调 `syncJumpToBottom`，
  只有布尔翻转时才 setState，但没有压测过。
- **记忆不落盘**，也不清理：应用一关就没了；已删会话的条目留在内存里
  （一个布尔值，清理需要一个删会话钩子，这个 store 不该拥有它）。
- **`toolExpandBySession` 的键是行 key（block id）**，不是 `toolCallId`。
  聚合行的 key 是 `${firstBlockId}~agg`，跟着首个孩子走：如果首个孩子换了，
  聚合的记忆会跟着丢。真实回合里 entries 是追加的，首个不会变，但没有断言钉住这一点。
- **CDP 配方踩到一个新坑**（记进配方）：`await import('/@fs/<绝对路径>')` 会拿到
  **另一份模块实例**，改它对界面毫无影响且不报错——第一轮就是这样白跑的。
  正确的说明符是 Vite 渲染进程根下的 `/stores/chatSessions.ts`，且必须带
  `/* @vite-ignore */`。另外 `Runtime.evaluate` + `awaitPromise` 对
  `(async () => {...})()` 这种写法会报 `Promise was collected`，改成
  "发射后不管 + 另一次 evaluate 读结果"就稳。
