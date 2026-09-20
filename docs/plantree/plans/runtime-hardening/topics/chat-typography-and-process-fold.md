# Chat 排版可配置化 + 过程条目聚合折叠 —— 任务执行清单

Role: topic capsule。建立：2026-09-19。来源是用户当日直接提出的三条界面诉求，不走审计 / 点验通道。
任务身份的**权威仍是** [roadmap](../roadmap.md)：本文件不登记状态，只排顺序、定改动点、列测试影响面。两者冲突时以 roadmap 为准。

**本文件是移交施工用的清单，不是已落地记录。** 截至建立日，代码一行未动，roadmap 也尚未登记任务号（建议的 T104～T106 见文末「规划状态同步」）。**2026-09-19 补记**：规划状态同步已完成，任务号已按建议登记为 **T104 / T105 / T106**（[roadmap](roadmap.md) 批次 J），决策结为 [031](decisions/031-tool-calls-aggregate-and-work-group-always-folded.md)（聚合与始终折叠，推翻决策 021 的「运行中自动展开」那一半）与 [032](decisions/032-chat-typography-configurable-two-tiers.md)（两档字号可配置，有据偏离字号表）；`design-system.md` 已补偏离条目，证据目录 [batch-j-chat-typography-2026-09-19](evidence/batch-j-chat-typography-2026-09-19/README.md) 已建（点验图待补）。**线 A（任务 1～4 = T104）已于 2026-09-20 落地 `0bc99095`（未推送）；线 B（任务 5 / 6 = T105 / T106）仍在施工。**
文中所有行号对应建立日当天的 `156b038e`，施工前请重新定位。

> 交付物：给施工方直接照做的清单。已含用户拍板结论、既有红线、逐文件改动点、测试影响面。

## Context（为什么做）

用户提出三条诉求：

1. **聊天区的字体与字号不可设置。** 设置里有终端字体、编辑器字体，唯独聊天区没有。
2. **Agent 正文与过程信息（思考、工具调用）区分不够显著。** 正文要放大并与用户输入一致，过程信息要缩小，两档都能在设置里调。
3. **过程条目太碎。** 两段正文之间穿插「思考 / 读取 / 读取 / 运行 / 编辑 / 思考」。要按 zcode 的做法聚合成少数几条，并且默认折叠、不自动展开。

**一条与用户描述不符的事实（施工方要知道）**：Agent 正文和用户气泡**现在已经是同一个字号**（都是 `text-markdown` 14px）。"区分不显著"的真因在另一头 —— 工具行（`ToolRows.tsx:124`）和思考正文（`ToolRows.tsx:682`）**也是同一个 14px**，三者只靠颜色深浅分层。所以本次的重点是**把过程档降下来**，正文放大是附带的。

预期结果：聊天区读起来是「用户提问 → 少数几条折叠的过程摘要 → Agent 的最终回答」。

---

## 用户已拍板的结论（不要重新讨论）

| # | 结论 |
|---|---|
| D1 | 出厂默认：**正文 16px / 过程 13px** |
| D2 | 回合状态行（「工作中 47 秒 · ↑12.0k tokens」）**保持 14px 不动**，不算进"过程档" |
| D3 | 聚合口径：一个回合内**连续出现**的工具调用**不分类型**（读取/搜索/运行/编辑/写入）合并成一条 |
| D4 | 夹在中间的**思考会打断聚合**，前后各成一条，思考自己单独一行 |
| D5 | 聚合行文案：`N 个工具调用 · 正在运行 npm test`（运行中）/ `N 个工具调用 · 最后编辑 App.tsx`（结束后） |
| D6 | 工作组**始终折叠**，运行中也不自动展开；折叠头运行中显示当前动作，结束后显示步数 |
| D7 | 折叠头**保持英文**（`Working 12s · Reading App.tsx` / `Worked for 47s · 9 steps`），沿用 2026-09-19 已定的决策；组内工具行、思考行仍是中文 |

**一处需要施工方知情的口径统一**：用户在"思考是否打断"那一问看到的预览文案是按类型分组的（「读取 2 个文件」），与 D5 选定的「总步数 + 最后动作」不一致。**以 D5 为准**。聚合段内只有 1 个工具调用时不聚合，回落成现在的单行原样（沿用现有 `deriveToolGroupRows` 的"≥2 才聚合"规则）。

**D6 的作用范围只到工作组这一层**，不要顺手往下改：组内**单条思考行**在流式中默认展开（`toolCard.ts:900`），这是 **T098 今天（2026-09-19）刚按用户反馈 #8 做的**（原诉求是「思考进行中无法折叠」）。工作组既然始终折叠，组内那一层用户平时也看不到，**保持现状不动**。

---

## 施工前必读的红线（违反其一就会翻车）

### R1 · 字号只能用 token，不得写任意值

六档 token 声明在 `src/renderer/styles/globals.css:51-69` 的 `@theme`，规范在 `docs/design-system.md:397-470`：

| Token | 值 | 用途 |
|---|---|---|
| `--text-2xs` | 10px | 仅 `kbd`，**禁止承载中文** |
| `--text-code` | 12px | 行内代码、路径、hash |
| `--text-meta` | 13px | 时间戳、次级说明 |
| `--text-ui` | 14px | 侧栏、按钮、label、tab |
| `--text-markdown` | 14px | 聊天正文、工具行动词、Markdown |
| `--text-title` | 18px | 设置页 L1、对话框标题 |

`src/renderer/components/chat/__tests__/fontDomainScan.test.ts:218` 有静态扫描，在 `chat/` 与 `workspace-shell/` 下**禁用** `text-xs` / `text-base` / `text-[10px]` / `text-[11px]`，且能穿透 `md:` `hover:` `data-[…]:` 变体前缀。**不得**用"按设置切换不同 Tailwind 字号 class"实现可配置。

### R2 · 新增字号 token 必须注册进 tailwind-merge

`src/renderer/lib/utils.ts:22-28`。漏注册的话 `twMerge` 把 `text-xxx` 判成**颜色**类组，`cn('text-muted-foreground', 'text-chat-body')` 会**静默吞掉颜色** —— 不报错、不告警，颜色就是没了。

### R3 · 字体设置绝对不能写 documentElement 的全局 CSS 变量

`docs/design-system.md:733-743` 与 `src/renderer/stores/settings/index.ts:78-86` 双处记载。历史上 `applyTerminalFont()` 把终端字体写进 `--font-family-mono`（污染 41 处 UI 的 `font-mono`）和 `--font-size-base`（**整个界面按 `terminalFontSize/16` 等比缩放**，用户把终端字号 16 调到 24 界面就放大 50%）。该函数已整体删除，**不得回退**。本次的覆盖必须**作用域限定在聊天区根节点**。

### R4 · settings store 里的 `fontFamily` / `fontSize` 是历史死字段，不要复用

`types.ts` 里有声明、有 setter、**零消费方**，T-21 刻意没接线（`docs/design-system.md:739-743`）。默认值还是旧的 `'Inter'` / `14`。**本次新增独立字段，不要往这两个上接** —— 接了会二次引入刚消灭的 14→16 跳变。

### R5 · 新增 `t('…')` 必须同步加中文词条

`src/shared/__tests__/i18nCoverage.test.ts` 扫描 `src/renderer` 下所有 `t('单引号字面量')`，缺词条即红。词条表 `src/shared/i18n.ts`（3185 行），已有 `'Font size': '字号'`（:401）、`'Font family': '字体'`（:1227）可复用。

### R6 · 折叠状态必须保持纯派生，不得引入 useEffect

决策 021 明确要求（`turnProcessFold.ts:200-203`）。这让"StrictMode 下触发两次"和"重渲染把读者展开的组关掉"在结构上不可达。

### R7 · 未应答的授权/提问必须强制展开

`turnWorkGroupAwaitsUser`（`turnProcessFold.ts:162-169`）是红线，D6 的"始终折叠"**不覆盖**它。

---

## 任务清单

### 任务 0 · 先验证一个技术前提（**必须第一个做，结论影响后面全部方案**）

**要验证什么**：Tailwind v4 把 `text-markdown` 这类自定义 token 的 utility 编译成 `font-size: var(--text-markdown)`（保留变量引用），还是编译成 `font-size: 0.875rem`（构建期内联）？

**为什么必须验证**：`globals.css:326-329` 有一条已踩过的坑的注释 —— 「Tailwind v4 的 `--default-font-family` 可能在 build 时内联 theme 值，所以运行时 `var()` 覆盖**不保证生效**」，作者为此把 `html[data-font-domain="mono"]` 写成了直接的 `font-family` 声明而不是覆盖 `--font-sans`。如果字号 token 也被内联，整个"运行时覆盖 CSS 变量"的方案不成立。

**怎么验证**：跑一次渲染层构建（`out/renderer/assets/*.css` 里现存的产物是 9 月 2 日的，早于 token 落地，**不能用**），在产物 CSS 里 grep `.text-markdown{`，看 `font-size` 后面是 `var(…)` 还是字面值。

**两种结论的分支**：
- **保留 `var()`（预期）**：按下面任务 1～3 的方案做。
- **被内联**：改用 `data-chat-scale` 属性驱动 —— 在 `globals.css` 里为每个离散档位写一组 `[data-chat-scale="16"] .text-chat-body { font-size: 16px }` 规则，设置项从连续数字改为离散档位。**这会改变任务 4 的 UI 形态，必须回头找用户确认。**

---

### 任务 1 · 新增两个语义字号 token

**为什么要新增而不是直接覆盖 `--text-markdown`**：工具行和思考正文**现在就是** `text-markdown`。直接覆盖这个 token 会把过程条目一起放大到 16px，与目标正相反。必须先把两类文本分到两个 token 上。

| 改动 | 位置 | 内容 |
|---|---|---|
| 声明 token | `src/renderer/styles/globals.css` `@theme`（现有字号段 `:51-69` 之后） | `--text-chat-body: 16px;`（D1）`--text-chat-process: 13px;`（D1）。**用 px 不用 rem** —— 这两档运行时会被 inline style 用 px 覆盖，默认值也写 px 才不会出现半截 rem 半截 px；`--text-2xs: 10px`（`:51`）已是 px 写法的先例。注释里写清这是仓库里**唯一一对运行时可变**的字号 token，以及覆盖点在哪个节点 |
| 注册 twMerge | `src/renderer/lib/utils.ts:25` 的 `'font-size'` 数组 | 追加 `'text-chat-body'`, `'text-chat-process'`（**R2，漏了就静默吞颜色**） |

### 任务 2 · 把聊天区的字号 class 切到新 token

**先做一次全量 grep，不要只改下面列的**：

```
grep -rn "text-markdown" src/renderer/components/chat/ src/renderer/components/workspace-shell/ \
  --include=*.tsx --include=*.ts | grep -v __tests__
```

当前共 18 处命中，其中 5 处是注释（`chatMarkdownPolicy.ts:45`/`:705`、`toolCard.ts:1477`、`MessageTimeline.tsx:2428`、`chatTimelineLayout.ts:193`），**真实代码点 13 处**，逐处归档如下。

⚠️ **这个数字要复核一次**：本仓有过 `.ts` 源文件里混进裸 NUL 字节、被 `grep` 当成二进制**静默跳过**的情况。改完之后回头用 `grep -a` 或换 `rg` 再扫一遍，确认没有漏网的 `text-markdown`。

**切到 `text-chat-body`（正文档，16px）—— 11 处**：

| 位置 | 是什么 |
|---|---|
| `chatMarkdownPolicy.ts:695`（`chatMarkdownRootClass()`） | 助手正文 Markdown 根 |
| `chatMarkdownPolicy.ts:715` / `:716` / `:717` | **Markdown 的 h1–h6 标题**。`docs/design-system.md:412` 规定标题**全部**用正文档、靠 weight + letter-spacing + color 分层，**不靠字号**。⚠️ **只改正文根不改这三行的话，标题会比正文小 2px** —— 这是本任务最容易漏的一处 |
| `MessageTimeline.tsx:1134` | 用户气泡段落 |
| `MessageTimeline.tsx:1188` | 另一处正文段落 |
| `MessageTimeline.tsx:2328`（`PlainProse`） | 流式中尚未解析的尾部文本 |
| `chatTimelineLayout.ts:199`（`turnBodyClass()`） | 回合正文容器（见下方警示） |
| `QuestionCard.tsx:307` | 提问卡的**自由文本输入框** —— 用户在这里打字，必须和正文同档 |
| `QuestionCard.tsx:717` | 提问卡里的 `Ident` 预格式化块 |
| `QuestionCard.tsx:740` | 「等待授权」说明文字。这条**可议** —— 它是说明而非正文，归 `text-meta` 也说得通，施工方看一眼实际效果再定 |

⚠️ **`turnBodyClass()` 是个继承源，不是普通样式。** 它的注释（`chatTimelineLayout.ts:193-198`）写得很清楚：这里的 `text-markdown` **不是装饰** —— `QuestionCard` 的 header 行自己不设字号，靠继承读这个值，「把它从这里拿掉会静默改掉一个本模块没有提到名字的组件」。

它同时被正文段和过程段复用（`messageTimelineWiring.test.ts:778/:1157` 钉着 `cn(turnProcessShellClass(), turnBodyClass(), turnProcessToneClass())`，`:781` 钉着 `cn(turnBodyClass(), turnAnswerToneClass())`）。

**建议改法**：直接把它换成 `text-chat-body`，**不要**拆成两个函数。两条理由：

- 过程壳虽然继承到 16px，但 `ToolRows` 的两处（`:124`/`:682`）显式声明 `text-chat-process`，会盖住继承值。
- `QuestionCard` 实测下来多数元素**自己设了**字号（`:265`/`:322`/`:461` 是 `text-ui`，另有多处 `text-meta`），继承只影响少数没标注的元素，影响面比那条注释读起来要小。

**但仍要实际看一眼 16px 下的 `QuestionCard`** 再定。如果不合适再拆函数 —— 拆就要同步改上面三条字面断言。

**切到 `text-chat-process`（过程档，13px）**：

| 位置 | 现状 class |
|---|---|
| `src/renderer/components/chat/ToolRows.tsx:124-126`（工具行 verb+arg） | `group/row flex w-full items-baseline gap-1.5 text-left text-markdown leading-normal` |
| `src/renderer/components/chat/ToolRows.tsx:682`（思考正文 / stats 正文） | `mt-1 flex select-text flex-col gap-1.5 text-markdown leading-[1.55] text-tool-arg` |

**还有一处必须处理：输入框**（用户诉求里「和用户输入的字号一致」的那一半）

输入框**不会自动跟着变**。它的样式函数 `middleColumnLayout.ts:568`（`composerTextareaClass()`）**没有设任何字号**，字号是从 `body` 继承来的 14px（`globals.css:349`）；我们在 `<section>` 上只设 CSS 变量、不设 `font-size`，所以继承链不受影响。

要让它跟随，得显式加上 `text-chat-body`。两个坑：

1. **`<Textarea unstyled>` 的 className 只落在外层 span 上，碰不到真正的 `<textarea>`**（`middleColumnLayout.ts:570-575` 记着这个坑，`resize-none` 曾因此完全失效）。字号虽然可继承、写在外层也能生效，但按仓库既有惯例应写成穿透形式 `[&_textarea]:text-chat-body`，与旁边的 sizing class 保持一致。
2. ⚠️ **session 模式 pin 了 `min-h-6` / `leading-6`**（`middleColumnLayout.ts:578-584`）—— 24px 的静息行高是**卡片高度算术的固定项**，`composerFollowHeightBreakdown` 把它数了两次，有测试钉着。**16px 的字塞进 24px 行高会顶破这套算术。**

**建议做法**：让 `min-h` / `leading` 由正文字号派生，而不是写死 24px。**如果这套算术改不动**（测试红线太密），回退方案是输入框保持 14px 不动，并明确告诉用户这一条没做到 —— 不要默默跳过。

**明确不动的三处**（改了就是回归）：

- `chatTimelineLayout.ts:357` 工作组头 `text-ui`（14px）—— **D2**，且 `docs/design-system.md:472-484` 是 T097 今天（2026-09-19）刚按用户反馈从 13px 提上来的。同文档 `:480` 还写着「`turnWorkGroupSummaryClass()` 与 `turnHeadClass()`（`:381`）**必须同时改**，只改一个整个回合看起来像换了字号」—— 本次是两个**都不改**。
- `ToolRows.tsx:521` / `:657` 工具输出 `pre` 的 `font-mono text-code`（12px）—— 代码档不参与正文/过程两分。
- `chatTimelineLayout.ts:482` 回合尾部悬浮操作条 `text-meta` —— `docs/design-system.md:482` 明确它不跟着走。

**行高要一起复核**：正文从 14px 涨到 16px 而 `leading-relaxed`(1.625) 不变，行距会跟着涨到 26px。`docs/design-system.md:419` 记着这个 1.625 是 F5 D1-b 为长文阅读单独定的。**顺带复核阅读栏宽度** `--container-reading: 45rem`（`globals.css:72`）—— 它按「48 个中文字 @15px」算出来的（D25 §3.4），正文变 16px 后一行装不下 48 字，要么接受、要么调宽。这条给用户看到的选项里已经标过风险，施工方需**实测截图**后回报，不要自行改宽。

### 任务 3 · 运行时覆盖（作用域限定）

在**聊天区根节点** `src/renderer/components/chat/ChatWorkspace.tsx:198` 的 `<section>` 上挂 inline style：

```
style={{
  '--text-chat-body': `${chatBodyFontSize}px`,
  '--text-chat-process': `${chatProcessFontSize}px`,
  ...(chatFontFamily ? { fontFamily: chatFontFamily } : {}),
}}
```

三个要点：

1. **只挂在这个 `<section>` 上，绝不碰 `documentElement`**（R3）。这个节点同时罩住时间线和输入框，所以输入框会跟着正文一起变 —— 符合用户"正文要和用户输入一致"的诉求。
2. **字体族用直接的 `fontFamily` 声明，不要覆盖 `--font-sans`**。理由与 `globals.css:326-333` 把 `html[data-font-domain="mono"]` 写成直接声明是同一个（构建期内联风险）。直接声明只影响没有显式 font-family 的后代，聊天区里 `font-mono` 的代码块和工具输出**不受影响**（utility 的 `font-family` 优先级高于继承）—— 这点要写成测试断言。
3. **空值即跟随**：`chatFontFamily` 为空字符串时**不写** `fontFamily` 键，让它继承全局 `--font-sans`。不要塞一个默认字体字面量进去（R4 的教训）。
4. ⚠️ **这个 `<section>` 也罩着 TUI 分支的 `AgentTerminal`**（`ChatWorkspace.tsx:212-235`）。终端字体走的是 xterm 的 JS option、不读 CSS（`docs/design-system.md:730`），理论上不受继承影响，但**必须实测一次**：切到 TUI 模式，改聊天字体，确认终端字体纹丝不动。如果真被影响，就把 style 下移到 `presentationMode !== 'tui'` 的那个 `<>` 分支里包一层 div。

### 任务 4 · 新增设置项

照抄终端字体那条链路（`TerminalAppearanceSettings.tsx:309-353` 的 local/global 双态模式）。**主进程完全不用改** —— 渲染层写 store 即自动经 `settings:write` IPC 落盘。

| 步骤 | 文件 | 内容 |
|---|---|---|
| 1 | `src/renderer/stores/settings/types.ts:182` 后 | 加字段 `chatFontFamily: string` / `chatBodyFontSize: number` / `chatProcessFontSize: number` |
| 2 | `src/renderer/stores/settings/types.ts:308` 后 | 加三个 setter 签名 |
| 3 | `src/renderer/stores/settings/index.ts:141` 后 | 默认值 `''` / `16` / `13`（D1） |
| 4 | `src/renderer/stores/settings/index.ts:267` 后 | 三个纯 `set({…})` setter，**无副作用** |
| 5 | `src/renderer/components/settings/AppearanceSettings.tsx` | 新增一个 `SettingsSectionBlock`（`SettingsPrimitives.tsx:13`），标题「聊天区」。内部三个 `SettingsRow`（`SettingsPrimitives.tsx:33`）：字体、正文字号、过程字号 |
| 6 | `src/shared/i18n.ts` | 补中文词条（R5）。`'Font size'`/`'Font family'` 已存在可复用，新增的如「正文字号」「过程信息字号」要加 |

**UI 细节**：

- 抄 `EditorSettings.tsx:212-232` 的数字步进器（`Input type="number"` + min/max + "px" 后缀 + local/global 双态），与 `TerminalAppearanceSettings.tsx:439-459` 同构。
- 字体族抄 `TerminalAppearanceSettings.tsx:424-438`（Input + `onBlur`/Enter 提交，trim 为空则回退）。
- **clamp 范围**：正文 `12~24`，过程 `12~20`。过程档下限**不得低于 12** —— `docs/design-system.md:757` 的红线是「10px 禁止承载 CJK，任何可能出现中文的位置最小档是 13px」，过程行装的就是中文动词，给到 12 已是边界。
- **强制 过程 ≤ 正文**：两个值互相 clamp，防止用户配出"过程比正文大"的反直觉结果。
- 建议加一个**实时预览**（抄 `TerminalAppearanceSettings.tsx:33-96` 的 `TerminalPreview`），用内联 style 渲染三行假的「正文 / 思考 / 工具行」。
- **不新增设置分组**。加进现有 `appearance` 分组只改一个文件；新增分组要同时改 `constants.ts:13-25` + `SettingsContent.tsx:66-78` + `:110-157` + i18n，还要改 `__tests__/settingsCategories.test.ts:25-36` 的硬编码 11 项断言。

**两个已确认的非坑**（不用额外处理）：持久化的 `partialize`（`index.ts:530-533`）是**黑名单**，只排掉 `_backgroundRefreshKey`，新增顶层字段**自动落盘**；`merge` 走 `migrateSettings` 做 deep merge，新字段的默认值在升级时会被保留，**不用在 `migration.ts` 里登记**。

**测试要补**：新增 `src/renderer/components/settings/__tests__/chatFontSection.test.ts`，抄 `__tests__/providerIdleTimeoutSection.test.ts:1-60` 的骨架（happy-dom + `createRoot` 渲染单个 section + 断言 `useSettingsStore.getState()`）。覆盖：控件写入 store、clamp 上下界、过程档不得大于正文档。

⚠️ **这个仓库踩过的坑**：zustand 的 persist 在**模块 import 时**就触发 rehydrate，所以挂载测试里 `window.electronAPI.settings` 的桩**必须放在 `vi.hoisted` 里**。放进 `beforeEach` 会挂死 10 秒且**不报任何错**，只看到超时。

### 任务 5 · 过程条目聚合

**聚合分两层做，不要试图在一个地方解决。**

#### 5a · item 层：合并相邻的 toolGroup（跨助手消息）

工具条目现在按**助手消息**切块（`groupTimeline` 是 per-message 的），所以同一串连续工具可能分散在多个 `toolGroup` item 里。先把它们缝起来。

- 新增 `mergeAdjacentToolGroups(items: readonly TurnItem[]): TurnItem[]`，放在 `chatTurn.ts`，挂在 `flattenTurnItems`（`:163`）末尾：`return mergeAdjacentToolGroups(joinResolvedPermissions(items))`。
- **「连续」的判据**：两个 `toolGroup` item 之间**没有任何其它 item**。中间夹了 `text`（助手正文）、`question`、未应答的 `permission`、`permissionActivity`、`notice` 任意一项 → **不合并**。助手消息的边界本身**不算**断点 —— 真正打断的是中间那段正文。
- 合并时保留**第一个** item 的 `messageId` / `blockIndex`，这样 `turnItemKey`（`MessageTimeline.tsx:2260`）在段增长时 key 不变、不会 remount。
- ⚠️ **一个会静默出错的副作用**：`MessageTimeline.tsx:1878` 用 `streamingBlockIdByMessage.get(item.messageId)` 找流式思考的 block id，合并后来自后半段消息的思考会取不到，"正在思考"的实时追加就失效了。解法：给 toolGroup 臂加可选 `messageIds?: readonly string[]`（只有合并产物才带），渲染处改成遍历这个数组取第一个非空。**漏了这步，`thinkingStreamRender` 相关行为会回归，而且不报错。**

#### 5b · row 层：重写切段与聚合行

`deriveToolGroupRows`（`toolCard.ts:775-852`）继续当唯一的行构造器，但切段规则整个换掉：

```
segments = 按分隔符切 entries，分隔符 = thinking 条目 | 带 permission 记录的 run
每个 run-run 连续段：
   长度 >= 2 → deriveAggregateRow(段)
   长度 == 1 → 保持现在的单行 deriveToolRowView
分隔符本身就地单独成一行
```

`deriveAggregateRow`（`:688-754`）也重写，从"按类型计数"改成"步数 + 最后一个动作"：

- 计数用段长（`N 个工具调用`），**不再**按 `file_path`/`path` 去重（那段逻辑连同 `AGGREGATE_VERB` 一起删掉，别留空壳）。
- 运行中：`正在运行 npm test` —— 动词取 `toolVerb(last.toolName, 'running')`，参数取 `formatToolArg(last, { repoName, t })`（`toolCard.ts:1387`，已导出，自带 `shortPath`、Bash 优先取 description、Grep 带 repo 尾巴）。
- 结束后：`最后编辑 App.tsx` —— 动词取 `toolVerb(last.toolName, 'refused')` 槽。**这个槽装的是动词原形**（`Edit`→`编辑`），不要用 `done` 槽（会拼出"最后已编辑"）。建议给它加个语义别名 `toolActionNoun()` 包一层，并在 `ToolVerbs.refused` 注释里补一句"现在有两个消费者"，免得后人以为它只服务拒绝行。
- `ToolRowView` 加一个 `verbText?: string`（已翻译好的前导文字）。`ToolRows.tsx:135` 改成 `{view.verbText ?? t(view.verb)}`。**必须走 `verbText` 而不是 `verb`** —— `verb` 是个不带参数的目录 key，`{{count}}` 的插值在 `t(view.verb)` 那里没有参数可传。

**两条必须保留的例外**：

1. **带 permission 记录的 run 不进聚合**，而是作为**分隔符**单独成行。理由不是洁癖：工作组这次要改成**永远折叠**，授权记录如果再被埋进聚合行的 detail 里，用户就要**点两次**才看得到一次授权。这是对"不分类型聚合"的有意偏离，写进注释。
2. `turnWorkGroupAwaitsUser`（`turnProcessFold.ts:162-169`）**一个字都不要改** —— 工作组永远折叠之后，它是唯一还能自动展开工作组的规则。

#### 5c · 运行中的聚合怎么不抖

现在的逻辑是"遇到 running 就停止聚合"。新文案要求运行中也显示聚合行，所以这个前缀限制要删掉：running 的 run 正常进段、进 detail，聚合行 `running = true`、`expandable` 仍为 true。

**这偏离了 A07「running 行不给 chevron」的旧规则** —— 该规则今天（T098）刚为思考行退役过一次，按同样方式登记偏离即可。

四道防抖：① key 用 `首个 run 的 blockId + ~agg`，段增长不换 key；② 段只增不减（`groupTimeline` 只追加，后到的 text 只会开新 item，不会回头劈开已有的组），所以 N 单调递增、聚合行不会退回单行；③ 唯一一次结构翻转是段内第 1→2 个 run（单行变聚合行）会 remount 一次，用户的展开态由 `resolveToolRowOpen` 规则 2（`toolExpansion.ts:87`，子行为 true 则父行开）自动承接，不用写新代码；④ 文案只在尾部变化，行首位置不动，视觉上是就地刷新。

### 任务 6 · 工作组始终折叠

**语言已拍板：折叠头保持英文。** `TurnProgressHead` 现在硬绑 `englishTranslate`（`MessageTimeline.tsx:1445` 附近），这是 2026-09-19 的用户决策，由 `messageTimelineWiring.test.ts:615 [HEAD-EN-1]` 与 `turnProgress.test.ts [HEAD-EN-2]` 两条测试焊死。**这两条测试不要动。** 目标文案落成 `Working 12s · Reading App.tsx` / `Worked for 47s · 9 steps` —— 语义完全按 D6，只有语言随既有决策。组内的工具行、思考行仍走 `useI18n()`，是中文，不受影响。

（现状可在 `sharePic/20260919/17fc81d9-….png` 看到：头部 `Working 6m 30s · Thinking 4m 51s` 是英文，同屏的思考折叠头「已思考 耗时 4m 51s」是中文 —— 这个混排是刻意的，不是缺陷。）

#### 6a · 开合判定

`turnWorkGroupOpen`（`turnProcessFold.ts:204-208`）改成：

```ts
export interface TurnWorkGroupOpenInput { forcedOpen: boolean; userOpen: boolean | null }
export function turnWorkGroupOpen(i) {
  if (i.forcedOpen) return true;               // 红线不动：未应答的授权/提问
  if (i.userOpen !== null) return i.userOpen;  // 用户点过的选择仍然永久生效
  return false;                                 // 运行中也折叠 ← 这就是改动
}
```

**`settled` 要从入参里删掉**，不是留着不用 —— 该文件自己的戒律禁止留「无人消费的导出规则」。`TurnProgressHead` 仍然需要 `settled`（spinner、label、当前动作 clause 都用它），只是不再传给 `turnWorkGroupOpen`。

**仍然纯派生、零 `useEffect`**（R6）。

连带要改 `messageTimelineWiring.test.ts:725` 和 `:732` 钉着的字面调用 `turnWorkGroupOpen({ settled, forcedOpen, userOpen })` → `({ forcedOpen, userOpen })`。

#### 6b · 头部要显示「当前在做什么」

现有字段给不出「正在读取 App.tsx」，需要新增一个纯函数，放 `turnProcessFold.ts`（它已 import `chatTurn` 的类型，再 import `toolCard` 的 `toolVerb`/`formatToolArg` 不成环）：

```ts
export interface TurnCurrentAction { verb: string; arg?: string }
export function deriveTurnCurrentAction(
  items: readonly TurnItem[],
  options?: { repoName?: string | null }
): TurnCurrentAction | null;
```

倒序扫 items → 倒序扫 `toolGroup.entries` → 取第一个 `status === 'running'` 的 run。

⚠️ **「没有 running 的 run 时要回落到最后一个已完成的动作」，这条不是锦上添花。** 工作组永远折叠之后，这个头是整个回合**唯一**的进度证据。如果在工具间隙（正在思考、等授权、两次调用之间）返回 `null`，用户看到的就是一个只有秒数在跳的裸头 —— 和卡死没有区别。spinner 也要保留。

头部合成（`MessageTimeline.tsx:1449-1480`）：当前动作 clause 只在 `!settled` 时加；`N steps` clause 只在已结束且 `label.kind === 'worked'` 且步数 > 0 时加；两者都交给现成的 `joinTurnProgressLine` 用 ` · ` 连接，**不要新写分隔逻辑**。

#### 6c · 文案 key

| 用途 | key | zh | 说明 |
|---|---|---|---|
| 聚合行前导 | `{{count}} tool call` / `{{count}} tool calls` | **已存在** `{{count}} 次工具调用`（`i18n.ts:2562-2563`） | 直接复用。若要改成「个」，注意子 agent 面板用的是同一个 key |
| 运行中动作 | 复用 `TOOL_VERBS[x].running` | 已存在（`运行中`/`读取中`） | 非字面量 `t()`，靠 `toolVocabulary.test.ts` 的存在性断言兜底 |
| 结束后动作 | 新增 `Last {{action}}` | 新增 `最后{{action}}` | `action` 取 `refused` 槽的动词原形 |
| 头部步数 | 新增 `{{count}} step` / `{{count}} steps` | 新增 `{{count}} 个步骤` | 与已有的 `{{count}} steps processed`（时长未知时的回落）并存，别混淆 |

**时长格式复用现成的**：决策 021 提到 `formatWorkedForRow` / `deriveTurnStats` 已经在做这件事，不要新写一套。秒数超过 60 的显示形式（截图里是 `6m 30s`）沿用它现有的输出。

⚠️ **A07 红线仍然成立**：时长未知时（例如回放的历史回合没有元数据）回落到步数，**绝不编造秒数**。

---

## 任务 5 / 6 的测试影响面

这两个任务会让**一批现有断言从绿变红，而且是预期的**。施工方必须能分清"我改红的"和"我改坏的"，所以下面逐条列出。

### 预期转红，必须改（改法即验收标准）

| 文件:行 | 断言 | 改成什么 |
|---|---|---|
| `toolCard.test.ts:272` | `keeps Edited + Ran as two separate rows` | 现在应聚合成 1 行 —— 这条正好翻过来当跨类型聚合的正面用例 |
| `toolCard.test.ts:281` | thinking 夹在中间不打断聚合 | thinking 现在**打断**，改成 3 行；再补一条 read,read,think,grep,grep → 聚合 + 思考 + 聚合 |
| `toolCard.test.ts:293` | `keeps a still-running call out of the aggregate` | 现在 1 行聚合、`running === true` |
| `toolCard.test.ts:307` | 聚合已完成前缀 + 追加运行中调用 | 现在 1 行、N=3、arg 指向那个运行中的调用 |
| `toolCard.test.ts:253` | `verb === 'Explored'` | 改断 `verbText` |
| `toolCard.test.ts:423` | 流式思考被折进聚合 detail 后重新打时间戳 | 结构上不可达，**删除** |
| `toolCard.test.ts:455` | `'Explored 3 files, 11 searches'` 字面量 | 重写为 `14 tool calls · Last Grep …` |
| `toolCard.test.ts:470/479/487/495` | files/searches 分段与 `file_path` 去重四条 | 随规则一起**删除** |
| `toolCard.test.ts:513` | 任一 run 在跑就用 running 动词 | 重写为「arg 指向那个运行中的调用」 |
| `turnProcessFold.test.ts:276` | `[WG-OPEN-1]` 运行中展开 | **反转**为「运行中也折叠」 |
| `turnProcessFold.test.ts:281/294` | `[WG-OPEN-2]` / `[WG-OPEN-4]` | 随签名去掉 `settled` |
| `messageTimelineWiring.test.ts:725/:732` | `turnWorkGroupOpen({ settled, forcedOpen, userOpen })` 字面量 | 去掉 `settled` |
| `chineseChatSurface.test.ts:60` | Bash + Grep + Edit 三行 | 三者现在聚合；拆成逐行渲染断言 + 新增中文聚合行断言 |
| `piToolVocabulary.test.ts:99` | `deriveAggregateRow(entries).arg === '1 file'` | 改为新 arg 形状 |
| `toolVocabulary.test.ts:59` | `AGGREGATE_VERB` 入参 | 随常量删除（连 import 一起） |

### 必须新增

- `toolCard.test.ts`：跨类型连续聚合；**带 permission 的 run 作分隔符且独立成行**（这条是 FB7 授权可见性的回归防线）；单条回落不聚合；聚合 key 在段增长时不变；failed 状态传播；detail 仍是扁平结构。
- `chatTurn.test.ts`：新建 `mergeAdjacentToolGroups` 的 describe —— 跨消息相邻合并；text / question / 未应答 permission / notice 夹在中间**不**合并；`Σ entries` 守恒且 `countProcessSteps` 总数不变；`messageIds` 被记录；函数幂等。
- `turnProcessFold.test.ts`：`deriveTurnCurrentAction` 取最后一个 running run；取最后一个 group；**无 running 时回落到最后完成的动作**；空 items → null。
- `messageTimelineWiring.test.ts`：头部确实调了 `deriveTurnCurrentAction` 且只在 `!settled` 时；新 clause 是 `joinTurnProgressLine` 的第一个 clause。
- `src/shared/i18n.ts` 加三个新词条，`i18nCoverage.test.ts` 会自动把关。

### 必须保持绿（这就是反向验证的对象）

`toolRowArg.test.ts`、`thinkingStreamRender.test.ts`（流式思考仍单独成行、仍默认展开、跨 live→settled 的展开记忆不丢）、`chatTurn.test.ts` 的 FB4 / FB7 组、`turnProcessFold.test.ts` 的 `WG-1..9` / `WG-REAL-*` / `WG-RED-*`（**这组红线一条都不能动**）。

### 三例必做的人工点验

① 只有 1 个工具调用的回合，外观和现在完全一样；② 出现未应答授权时工作组**自动强制展开**；③ 恢复一个历史回合，折叠且头部显示 `Worked for Xs · N steps`。

---

## 最容易翻车的四点

1. **授权被双层折叠。** 「不分类型聚合」若字面执行到带 permission 的 run 上，叠加「工作组永远折叠」，用户要**点两次**才能看到一次授权记录。permission-run 必须留作分隔符，`turnWorkGroupAwaitsUser` 一个字不能改。
2. **运行中「看起来卡死」。** 工作组默认折叠后整个回合可能只剩一行头。`deriveTurnCurrentAction` 在工具间隙返回 null 就会露出一个只有秒数在跳的裸头。回落规则必须做。
3. **跨消息合并丢掉流式思考。** `streamingBlockIdByMessage.get(item.messageId)` 合并后只覆盖首条消息，`messageIds` 那步漏了就静默失效，测试不一定抓得到。
4. **Markdown 标题漏改。** 任务 2 里 h1–h6 走的也是 `text-markdown`，只改正文根会让标题比正文小 2px。

---

## 施工顺序与并行度

**任务 0 阻塞全部**，先做。之后分两条线：

- **线 A（排版）**：任务 1 → 2 → 3 → 4
- **线 B（聚合与折叠）**：任务 5 → 6

**这两条线不能并行。** 它们在三个文件上重叠：`MessageTimeline.tsx`、`ToolRows.tsx`、`src/shared/i18n.ts`。其中 `MessageTimeline.tsx` 有 2607 行且无法单测（只靠 `messageTimelineWiring.test.ts` 做源码 AST 扫描锁字面量），两边同时改必然互相踩。

**建议先 A 后 B**：线 A 改动局部、肉眼可验、风险低，先落地能马上让用户看到区分度的改善；线 B 动的是聚合算法和折叠判定，需要合成 transcript 才能验。

如果要分两次提交，注意 `MessageTimeline.tsx` 会跨两个提交 —— 按 hunk 拆暂存，提交前先 `git diff --cached` 核对，别把另一条线的半成品带进去。

---

## 验证方式

### 静态与单测（每个任务做完就跑，只跑相关文件）

```
npx tsc --noEmit
npx vitest run src/renderer/components/chat/__tests__/
npx vitest run src/renderer/components/settings/__tests__/
npx vitest run src/renderer/stores/settings/__tests__/ src/renderer/stores/__tests__/toolExpansion.test.ts
npx vitest run src/shared/__tests__/i18nCoverage.test.ts
```

**全量测试只在整批收口时跑一次**，不要每个子任务都跑 —— 开发机是 2 核 / 3.3GB，全量测试和 Electron 点验**不能同时进行**。

### 反向验证（这个仓库的规范要求，不是可选项）

本仓每个任务都做这件事并把次数记进 roadmap（如 T012「13 次反向验证」、T018「19 次」）。做法：把改动整文件撤回（`git stash` 单文件），对旧源码跑新用例，确认新用例红、旧用例绿，再恢复。**不要用 `git checkout`** —— 并行施工时会把别人的改动一起冲掉。工程规范全文见 `docs/agent-project-engineering.md`，动工前要完整读一遍（项目 CLAUDE.md 的硬性要求）。

### GUI 点验（必须做，这三条诉求都是观感问题，静态测试证明不了）

仓库里有现成的 CDP 点验工具，归档在 `docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/`。要点：

- `dev.js` 支持透传 `--remote-debugging-port`。
- 渲染层 store 可以从 Vite dev server 直接 `import`，**可以合成 transcript**，不需要真的跑一个模型回合就能出图 —— 本次正好用它造一段「读取 / 读取 / 思考 / 运行 / 编辑 / 思考」的序列来验聚合。
- 进主界面用 `ENTER_MAIN_SURFACE`。
- 判「回合结束」用「先 busy 再连续三次 idle」，不要只看一次。

**必拍的四张图**：① 正文 16px 与过程 13px 的对比；② 聚合前后的过程行数对比（同一段 transcript）；③ 运行中的折叠头（`Working 12s · Reading App.tsx`）；④ 设置面板里调字号后聊天区实时变化。

**阅读栏宽度**要单独量一次：正文 16px 下一行实际能装多少个中文字，和 `--container-reading: 45rem` 按 15px 设计时的 48 字目标差多少（见任务 2）。**量完回报，不要自行改宽度。**

⚠️ **如果有多人/多代理并行改渲染层，GUI 点验会看到假的「点了没反应」** —— 热更新会把半成品的改动混进界面。点验期间确保没有别人在改 `src/renderer/`。

---

## 规划状态同步（CLAUDE.md 的 plan-tree 规范要求）

这三条诉求**不是纯代码改动**，其中两条推翻了已拍板的决策，按规范必须同步规划状态，否则下一个接手的人会按旧决策把它改回去。

| 动作 | 位置 | 内容 |
|---|---|---|
| 新建决策 | `docs/plantree/plans/runtime-hardening/decisions/031-*.md` | 记录 D3～D6：推翻决策 021 的「运行中自动展开」那一半（021 本身是 2026-09-18 同一个用户拍的，**要写明推翻理由是用户当下诉求**，并保留 021 的另一半：结束后折叠、头部报时长、纯派生无 effect、未应答授权强制展开） |
| 新建决策 | `decisions/032-*.md`（或并入 031） | 记录 D1/D2：聊天区两档字号可配置 + 新增两个运行时可变的字号 token，这是对 `design-system.md`「字号只能用固定 token」的一次**有据偏离**；同时记录 D2 —— 回合状态行**不参与**，T097 的 14px 结论不变 |
| 登记任务 | `docs/plantree/plans/runtime-hardening/roadmap.md` | 现有最后一个任务号是 **T103**，本次从 **T104** 起。建议拆三个：T104 字号 token 与设置项、T105 过程条目聚合、T106 工作组始终折叠 |
| 更新规范 | `docs/design-system.md` | 在 Typography 一节补「聊天区两档可配置字号」条目，写清它为什么是例外、覆盖点在哪个节点、以及**绝不写 documentElement** 这条红线仍然成立 |
| 更新看板 | `docs/plantree/进度看板.md` | 活动任务加上 T104～T106 |
| 证据归档 | `evidence/batch-j-chat-typography-2026-09-19/`（目录名按实际批次定） | 放 GUI 点验四张图 + 阅读栏字数实测 + 反向验证记录 |

**提交信息**按仓库的 Conventional Commits 规范，描述用中文，例如 `feat(chat): 聊天区字体与两档字号可在设置中调整`、`feat(chat): 连续工具调用聚合成一条并默认折叠`。

**Release Notes 要提一句**：老用户升级后聊天区正文会从 14px 跳到 16px、过程信息降到 13px，是预期变更，可在「设置 → 外观 → 聊天区」调回。候选说明放 `docs/release-notes/unreleased.md`。
