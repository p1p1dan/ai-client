# 决策 032：聊天区两档字号可配置 + 新增两个运行时可变字号 token（有据偏离字号表）

日期：2026-09-19 · 拍板人：用户 · 状态：已决 · 任务：T104（批次 J，已落地）

## 问题

用户 2026-09-19 直接提出两条界面诉求（同日现场反馈里的第 1、2 条）：

1. 「聊天区的字体与字号不可设置。设置里有终端字体、编辑器字体，唯独聊天区没有。」
2. 「Agent 正文与过程信息（思考、工具调用）区分不够显著。正文要放大并与用户输入一致，过程信息要缩小，两档都能在设置里调。」

调查时坐实了一条与用户描述**不符**的事实，它是本决策方案形态的由来：Agent 正文与用户气泡**当时已经是同一个字号**（都是 `text-markdown` 14px）。「区分不显著」的真因在另一头 —— 工具行与思考正文**也是同一个 14px**，三类文本只靠颜色深浅分层。所以本次的重点是**把过程档降下来**，正文放大只是附带的。

## 候选与取舍

- **候选 A（选定）**：新增两个**运行时可变**的语义字号 token（`--text-chat-body` 16px / `--text-chat-process` 13px），由聊天区根节点的 inline CSS 变量覆盖；设置里暴露字体族 + 两档字号三个控件。
- **候选 B**：按设置切换不同的 Tailwind 字号 class（`text-sm` / `text-base` …）。**不可行** —— `chat/__tests__/fontDomainScan.test.ts` 的静态扫描在 `chat/` 与 `workspace-shell/` 下禁用 `text-xs` / `text-base` / `text-[…]`，且能穿透 `md:` `hover:` / `data-[…]:` 变体前缀。这是踩过的坑换来的红线，不为了省事开一个后门。
- **候选 C**：用 CSS 变量覆盖**现有**的 `--text-markdown`。**不可行且方向相反** —— 工具行与思考正文当时**就是** `text-markdown`，覆盖它会把过程条目一起放大到 16px，与诉求 2 的目标正相反。必须先新增 token 把两类文本**分开**，才谈得上分别调。

取舍：选候选 A。它同时满足三条：不违反字号 token 纪律（新增的是 token，不是任意值）、字号可连续调节（不是离散档位）、且「运行时覆盖 CSS 变量到底可不可行」这个技术前提是可验证的。

## 决定

采用**候选 A**。

### D1 · 新增两个 token，写进 `@theme`（这是对「字号只能用固定 token」的一次偏离）

`src/renderer/styles/globals.css` 的 `@theme` 新增：

```
--text-chat-body: 16px;      /* 助手 / 用户正文、Markdown（含 h1–h6）、输入框 */
--text-chat-process: 13px;   /* 工具行、思考正文 */
```

**它们与字号表里那六档的性质不同**，这正是需要记录偏离的地方：六档是**固定档位**（`--text-2xs` / `--text-code` / `--text-meta` / `--text-ui` / `--text-markdown` / `--text-title`，规范在 `docs/design-system.md` 的 Typography 一节），值由设计决定、不随用户设置变化；这一对是**运行时可变**的，是仓库里**唯一一对**这样的字号 token。

**用 px 而非 rem 的理由**：这两档运行时会被 inline style 用 px 覆盖，默认值也写 px 才不会出现「半截 rem 半截 px」的两套单位。`--text-2xs: 10px` 已是 px 写法的先例。

**偏离的理由（为什么这次的例外是合理的）**：

- 字号表管的是「哪一处 UI 该用哪一档」，它假设档位集合是有限的、由设计单方面决定。用户诉求恰恰是「这一处让我自己定」——这不是设计判断缺位，而是设计判断已经先把「聊天区正文 / 过程」两个**语义位置**切了出来（这才是本决策真正新增的东西），只是把**取值**开放给读者。
- 切分本身仍然遵守字号表的结构：两档之间仍是**语义**关系（正文档 > 过程档，层级由字号差与颜色共同承担），不是随手取的两个数字。
- 数值边界仍受字号表约束：两档下限都取 **12px**，因为 CJK 规则（`docs/design-system.md` 的「CJK 级联规则」第 3 条）要求「任何可能出现中文的位置，最小档是 `--text-meta`(13px)」——过程行装的就是中文动词（「读取」「编辑」），给到 12 已是**刻意的边界拉伸**，不得再低。

**出厂默认不改变现有观感**：16 / 13 这对默认值下，**不打开设置的用户看到的东西一格没动** —— 输入框的 `min-h` / `leading` 由正文字号派生，16px 默认下表达式恰好等于原来的 24px，`middleColumnLayout.test.ts` 钉的卡片高度算术 (74px) 继续成立。

### D2 · 回合状态行不参与本次改动

`chatTimelineLayout.turnWorkGroupSummaryClass()` 与 `turnHeadClass()` 保持 `text-ui`（14px），**T097 的结论不变**。理由见 `docs/design-system.md` 的「已记录偏离：回合状态行用 `text-ui`（T097，2026-09-19）」条目：meta 档描述的是被动陪衬，而这一行在等待中经常是屏幕上唯一在动的东西。本次两档可配置**只管正文与过程**，不铺到状态行。

### 3. 覆盖点：聊天区根节点，绝不碰 `documentElement`

被覆盖的节点是 `src/renderer/components/chat/ChatWorkspace.tsx` 根部的 `<section>`，作用域限定在该子树。这个节点同时罩住时间线与输入框，所以输入框跟着正文一起变 —— 符合用户「正文要和用户输入一致」的诉求。

**「绝不写 `documentElement`」这条红线仍然成立，且是本决策的硬约束。** 历史上 `applyTerminalFont()` 把终端字体写进 `documentElement` 的 `--font-family-mono`（污染 41 处 UI 的 `font-mono`）与 `--font-size-base`（**整个界面按 `terminalFontSize/16` 等比缩放**，用户把终端字号从 16 调到 24 界面就放大 50%）。该函数已整体删除，**不得回退**。本次覆盖必须**作用域限定**，有静态测试 `chat/__tests__/chatFontOverrideStatic.test.ts` 同时钉住两点：覆盖不落在 `documentElement` 上，以及注入点确实是那个 `<section>`。

**字体族用直接的 `fontFamily` 声明，不覆盖 `--font-sans`**。理由与 `globals.css` 把 `html[data-font-domain="mono"]` 写成直接声明是同一个（构建期内联风险）。直接声明只影响没有显式 font-family 的后代，聊天区里 `font-mono` 的代码块与工具输出**不受影响**（utility 的 `font-family` 优先级高于继承）—— 设置面板实时预览的第三行故意不带内联样式，就是这个断言的现场证据。

**空值即跟随**：字体族为空字符串时**不写** `fontFamily` 键，让它继承全局 `--font-sans`。不塞默认字体字面量进去（`settings` store 里 `fontFamily` / `fontSize` 两个历史死字段的教训）。

### 4. 新增字号 token 必须注册进 `tailwind-merge`

`src/renderer/lib/utils.ts` 的 `extendTailwindMerge` `'font-size'` 组追加 `'text-chat-body'`、`'text-chat-process'`。**不注册就被静默吞掉**：`twMerge` 会把 `text-xxx` 判成**颜色**类组，`cn('text-muted-foreground', 'text-chat-body')` 不报错、不告警，颜色就是没了。这条是字号表已有的工程注记，本次照办。

### 5. 钳制规则：落在 settings store 的 setter 里，不只是控件里

新增 `src/shared/types/chatTypography.ts` 集中范围常量与两个交叉钳制解析器：

| 档 | 范围 | 默认 |
|---|---|---|
| 正文 | 12 ~ 24 | 16 |
| 过程 | 12 ~ 20 | 13 |

- **过程不得大于正文**是**渲染不变量**，不是一个偏好。所以钳制落在 **settings store 的 setter** 里（`resolveChatBodyWrite` / `resolveChatProcessWrite`），而不只是设置控件里 —— 绕过控件直接写 store 的调用方（持久化恢复、未来任何入口）不能产出「过程信息比答案还大」的屏幕。
- **非有限值回落默认值而非下限**：清空数字输入框得到 `NaN`，此时应恢复出厂字号，而不是把该档摔到 12px。

### 6. 设置项形态

新增 `src/renderer/components/settings/ChatTypographySettings.tsx`，**挂进现有 `AppearanceSettings`，不新增设置分组**（新增分组要同时改 `constants.ts` + `SettingsContent.tsx` 两处 + i18n，还要改 `settingsCategories.test.ts` 的硬编码项数断言）。含三行实时预览：正文行 / 过程行 / 一行 `font-mono text-code` 的代码样例。

## 理由

- 用户是提出诉求的人，且给出的对照形态很具体（正文放大、过程缩小、两档可调）。诉求 2 不是审美偏好，是**可读性问题**：三类文本同字号时只能靠颜色分层，过程信息与答案抢注意力。
- 候选 B / C 各自撞在一条既有红线上，说明方案不是「顺手做的」而是当前唯一可行的形状；把这一点写下来，是为了让后人不要以为当初没考虑那两个更省事的做法。
- 出厂默认保持现有观感（16 / 13 下算式恰好等于原来的 24px 行高），意味着这个特性**对不看设置的用户零风险** —— 这是本次能接受偏离字号表的底气。

## 后果与备注

- **老用户升级后聊天区正文会从 14px 跳到 16px、过程信息降到 13px**，这是**预期变更**，可在「设置 → 外观 → 聊天区」调回。已写进 `docs/release-notes/unreleased.md` 的候选说明。
- **`--text-markdown` 与 `--text-ui` 未动**：本次是切分与新增，不是改档。字号表里那六档的语义不变。
- **Markdown 标题与正文同档**：h1–h6 一并切到 `text-chat-body`。字号表规定标题**全部**用正文档、靠 weight + letter-spacing + color 分层、不靠字号；只改正文根不改标题的话，标题会比自己的段落**小 2px**。
- **阅读栏宽度是一次已知的取舍**：`--container-reading: 45rem` 是按「48 个中文字 @15px」算出来的（D25 §3.4），正文变 16px 后一行装不下 48 字。本次**不改宽度**，实际能装多少字要 GUI 实测后回报（见证据目录的待办）。
- **卡片高度 74px 降级为 floor**：输入卡片原有的 `min-h-18.5`(74px) 在正文字号 >16px 时自然变高（24px 档 → 106px），16px 以下不塌。这是**显式接受的取舍**，理由写在代码注释里：16px 的字塞进 24px 行高只有 1.5 倍行距，到 24px 档时字形会溢出算术仍称之为 24px 的盒子。
- 字体族设置对 TUI 分支的 `AgentTerminal` 是否产生影响需实测一次（终端字体走 xterm 的 JS option、不读 CSS，理论上不受继承影响），列在证据目录待办。

## 相关

- 施工清单：[topics/chat-typography-and-process-fold.md](../topics/chat-typography-and-process-fold.md) 任务 1～4
- 落地任务：[roadmap.md](../roadmap.md) 批次 J T104（提交 `0bc99095`）
- 同批决策：[决策 031](031-tool-calls-aggregate-and-work-group-always-folded.md)（过程条目聚合与工作组始终折叠，含对[决策 021](021-turn-work-group-restores-elapsed-and-fold.md) 的推翻）
- 证据：[evidence/batch-j-chat-typography-2026-09-19](../evidence/batch-j-chat-typography-2026-09-19/README.md)
- 被偏离的规范：`docs/design-system.md` Typography 一节（本次同时在其中补了「已记录偏离」条目）
