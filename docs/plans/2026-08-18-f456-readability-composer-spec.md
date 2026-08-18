# F4 + F5 + F6 施工规格 rev.1 —— 阅读性 + Composer 批

> 来源：`docs/plans/2026-08-17-d48-t10-inspection-triage.md` 的 F4 / F5 / F6 三项发现，
> 与该档「拍板记录」第 5 条（2026-08-18 用户对 HTML 对比稿的拍板）。
> 对比稿：`docs/design/2026-08-18-f5-chat-readability-draft.html`。
> 状态：**规格 rev.1，待评审**。本档只写规格，不改任何生产代码。
> 口径：每条裁定标注【实测】（本轮在本机核验，带 `file:line`）或【推测】（未实测的推断，须施工时验证）。
> 与对比稿工程标注冲突处一律显式写「【与对比稿冲突】」并给出实测依据。

| 项 | 值 |
|---|---|
| 日期 | 2026-08-18 |
| 分支 | `feat/openchamber-chat-refactor` |
| 上游批次边界 | F2 超时体系批（`docs/plans/2026-08-18-f2-watchdog-redesign-spec-trackA.md`）—— 见 §0.4 |
| 用户拍板（不可讨论） | D1-b · D2-b · D3-c 与 D3-b **并用** · 无背景图 |
| 触碰的已冻结基线 | phase0a「助手：完全平铺，无容器」· D26 ④ · design-system「已知偏差」表 · F-C4「两档节拍」不变量 |
| 预计切片 | 4 片（token 层 / 散文层 / 时间线角色层 / composer+等待行层） |

---

## 目录

- §0 本批边界、取证核对表与前置事实
- §1 F5-D1-b 排版密度换档（散文层）
- §2 F5-D2-b 次要层 token 提档（全局 token 层）
- §3 F5-D3-c 用户气泡非对称（时间线角色层）
- §4 F5-D3-b 助手中性容器与**解嵌套裁定**
- §5 基线条款正式修订与归档纪律
- §6 F6 Composer 两行布局
- §7 F4 等待行
- §8 静态不变量、测试与变异计划
- §9 切片方案与影响面全清单
- §10 Open questions 与实现方否决权上报路径

---

## §0 本批边界、取证核对表与前置事实

### 0.1 本批做什么

三件互相独立、可并行的改造，共用一次 GUI 点验：

| 代号 | 内容 | 层 |
|---|---|---|
| **F5** | 聊天可读性三维度落地（密度 / 对比 / 角色区分） | globals.css token 层 + chatMarkdownPolicy 散文层 + MessageTimeline 角色层 |
| **F6** | Composer session 模式拆两行 | ChatComposer + middleColumnLayout |
| **F4** | 回合头等待行变富（俏皮动词 + ↑↓ 计数 + slow 色阶降级） | attachments.ts / turnStatus.ts / turnSendStatus.ts |

### 0.2 本批**不**做什么（显式越界声明）

- **超时阈值参数、看门狗行为、`SLOW_WAIT_HINT_SECONDS` 数值** —— 全部归 F2 批。本批**读**这些常量，**不改**其值。
  F2 已裁定 `SLOW_WAIT_HINT_SECONDS` 保持 45（F2 §8.1），预算改由 `SEND_SILENCE_CEILING_MS`（300s 量级）供给。
  本批的等待行文案在 F2 落地前后都必须成立——即**不得把任何阈值数字写死进文案模块**。
- **D1-c（行高 1.75）与 D1+16（正文 16px）** —— 用户拍的是 D1-b，两者均不落地，不新增 `--leading-*`、不动 D25 字号档位表。
- **D2-c 的容器边界可见化**（行内代码 chip 补边框 / 工具输出块补左导轨）—— 用户拍的是 D2-b。
  但 §4 的解嵌套裁定会**间接触及**同一批类串，届时按 §4.5 处理，不擅自把 D2-c 整包带进来。
- **背景图 / 阅读底票** —— 用户明示「无背景图，阅读底票不立」。`useBackgroundImage` 与 `--panel-bg-opacity` 一字不动；
  本批全部对比度数值按 `--panel-bg-opacity = 1` 计算，并在 §2.6 记录这个前提。
- **F1（单波浪线）、F3（Automatic 重钉）、F7（回退/分叉）、F8、F9** —— 各自独立批次。

### 0.3 F2 移交给本批的三件（继承项，必须处置）

F2 规格 §8.3 / §11 明文移交，本批照单全收：

| 移交项 | F2 原文位置 | 本批处置 |
|---|---|---|
| ① 等待行文案改造（俏皮动词、流量数字、`(up to Ns)` 从句去留） | F2 §8.4 / §11 | §7.1 ~ §7.4 |
| ② `slow` 的 `text-warning` 色阶降级 + 第二档阈值 | F2 §8.3 | §7.5 |
| ③ 红卡文案中英混排订正（`MessageTimeline.tsx:540`） | F2 §2 新发现⑤ | §7.6 |

**反向约束（F2 钉给本批的锁）**【实测】：F2 §9 计划在 `turnStatus.test.ts` 新增 `[TS-1]`，断言
`elapsedSeconds >= SLOW_WAIT_HINT_SECONDS && !hasBlocks` 时 `kind === 'slow'` 且文案**含 `Stop to abort.`**，
其声明目的就是「防 F4 误删」。⇒ **§7 的文案重写不得移除 slow 分支的 `Stop to abort.` 尾句**，
俏皮动词只作用于 `awaiting`（< 阈值）分支。两批的落地顺序无论谁先，这条都成立。

### 0.4 施工顺序与 F2 的关系

本批与 F2 **无文件级冲突**，可并行：F2 动 `attachmentLimits.ts` / `claudeRuntime.ts` / `queueRelease.ts` / `assistantProgress.ts`；
本批动 `globals.css` / `chatMarkdownPolicy.ts` / `MessageTimeline.tsx` / `ChatComposer.tsx` / `middleColumnLayout.ts` / `turnSendStatus.ts`。
**唯一共享文件是 `attachments.ts` 与 `turnStatus.ts`**：F2 §8.4 声明对 `attachments.ts:321-359` 的改动为**零**，
只从调用方换 `budgetMs` 入参；本批只改 `composerSendingLine` 的措辞与新增入参。⇒ 冲突面 = 两个函数签名，
施工时以「后落地方 rebase」处理，规格期不做序约束。`turnStatus.test.ts` 两批都加用例（F2 加 `[TS-1]`，本批加 §8 清单），
按 describe 块分区追加，不重编号。

### 0.5 取证核对表 —— 与对比稿 / 分诊档的**八处冲突**

对比稿是设计稿，不是施工图。本轮逐条复核其工程标注，发现八处需要修正或补足。
**这张表是本规格最重要的一节**：不先纠正这八条，施工会按错误前提动工。

| # | 对比稿 / 分诊档的说法 | 实测 | 后果 |
|---|---|---|---|
| **C1** | D3-c「**需撤销 D26 ④**（复议，需重新落决策）」（对比稿 §05 / §03） | 【实测】D26 ④ **早在 2026-08-13 就被 D31 推翻了**：`docs/plans/openchamber-chat-refactor-ledger.md:75` 决策 D31 明文「用户气泡**改回右对齐**（推翻 D26④ 满宽，**append-only 以本条为准**）」，并在 `docs/plantree/plans/openchamber-chat-refactor/implementation-status.md:47` 列为「渲染端小批」待排队项，至今**未施工** | 本批**不是复议，是执行一条已拍板未落地的裁定**。§5 的修订记录写法随之改变：不写「撤销 D26 ④」，写「兑现 D31 冲突项回摆①，D26 ④ 至此在代码侧同步作废」。少一次拍板、少一份决策档 |
| **C2** | D2-b「`--tool-arg` 退役并入 muted-foreground（3.61/3.11 → 7.20/6.70）」；用户拍板原文是「**text-tool-arg 修到过 AA**」 | 【实测】`--tool-arg` 是**派生值**不是独立色：`color-mix(in oklab, var(--muted-foreground) 78%, var(--background))`。本轮按 Oklab 混合 + WCAG 2.x 重算：**保留 78% 派生 + 新 muted-foreground → 亮 `#797874` = 4.34、暗 `#7E7C77` = 4.36**，两个都**仍不过 AA(4.5)** | 「修到过 AA」**不会**随 muted-foreground 提档自动实现。必须对 tool-arg 本身作一次显式裁定（退役 / 抬混合比），见 §2.3。这是本表中唯一会导致「以为改好了其实没过 AA」的坑 |
| **C3** | 任务书转述为「chat **之外** 104 处共享该 token」 | 【实测】104（本轮复核为 106）是**chat 目录内**计数，对比稿脚注原文写明「`src/renderer/components/chat/` 下非测试文件」。全仓真实用量见 §2.4 | 影响面被低估一个数量级。GUI 点验范围必须按 §2.4 的全仓分面重排 |
| **C4** | D3-b「代码块 / 表格自带边框，会出现**嵌套框**」（只给定性，未量化） | 【实测】比嵌套框严重：`CodeInline` 是 `bg-muted`（`ui/ident.tsx:31`），D3-b 容器也是 `bg-muted` → 两者对比度 **1.000（同色，芯片彻底消失）**；代码块 `bg-muted/50`（`chatMarkdownPolicy.ts:509`）合成在 `bg-muted` 底上等于 `bg-muted` 本身 → **1.000**，代码块退化成「只剩一圈边框的空框」；且 `border-border` 对 `muted` 只有 1.308/1.363，比对 `background` 的 1.402/1.441 **更弱** | D3-b 若照对比稿字面实作（`bg-muted + border-border`），会**同时**制造三层框和两处消失。§4 的解嵌套裁定因此不是「优化」，是**必须项** |
| **C5** | 分诊 F6「F4 落地后回合头等待行变富，composer 状态行**或可退役**」 | 【实测】T-31 §3.2 早已把等待文案迁出 composer：`middleColumnLayout.ts:607-619` 明文「`sending` no longer shows this line at all」，`shouldShowStatusLine`（:621-630）只看 `reading > 0 \|\| hasStatusError \|\| hasLargeHint`；session 模式再经 `resolveIdleStatusText`（:524-534）过滤掉全部错误正文 ⇒ 该槽**今天只可能显示两种东西**：附件读盘 spinner、大附件提示 | 该槽与 F4 **信息不同源**（草稿侧附件 I/O vs 回合侧等待），**不能因 F4 变富而退役**。§6.4 改判为「迁位不退役」 |
| **C6** | 对比稿 §05 D3-c 落地点写 `MessageTimeline.tsx:711-722` | 【实测】准确锚点是：D26 ④ 注释 `MessageTimeline.tsx:708-715`、`<article>` `:716`、外层类串 `'space-y-2 rounded-lg border px-4 py-2.5'` `:719`、角色类串 `'rounded-br-xs border-primary/8 bg-card'` `:726` | 施工按 §3.2 的锚点，不按对比稿行号 |
| **C7** | 对比稿 D3-a/D3-c 连带测试写「**若有**类串断言需同步」 | 【实测】**确有且按构造必红**：`__tests__/messageTimelineWiring.test.ts:443-451` 有一条专门的 pin —— `it('D26 ④: the user bubble is full width')`，内容是 `expectUnwired('max-w-[85%]')` + `expectUnwired('justify-end')`。且 `:226-228` 有一条元断言，明文要求字符串字面量 `rounded-br-xs` 必须存活于负向投影里 | §8 把这条 pin 的**退役换新**列为必改项（不是「同步」，是语义反转：从「禁止」改为「必须」） |
| **C8** | F2 §8.3 建议「slow 保持 muted，另设第二档阈值才转 warning」 | 【实测】问题比色阶疲劳更深：`--warning` 与 `--primary` **逐位同色**（`globals.css:176-177` 亮 `oklch(0.5665 0.1523 45.02)` = primary 亮值；`:223-224` 暗 `oklch(0.6576 0.1539 49.3)` = primary 暗值），`design-system.md` 自己就有「不要用 warning 代替 amber——与品牌橙撞」的警告 ⇒ 今天的 slow 态涂的其实是**品牌橙**，与链接色同色 | §7.5 的处置不能只是「延后变黄」，要连「变的是哪个颜色」一起裁 |

**核对通过（无冲突，记录以免复查）**：
① 对比稿列的 F-C4 断言行号 `:590`（`leading-normal` 钉）/ `:635`/`:638`（标题 20/10）/ `:643-656`（块级 mt ∈ {10,20}）—— 逐条实测吻合；
② `BLOCK_GAP = 'mt-2.5 first:mt-0'` / `SECTION_GAP = 'mt-5 first:mt-0'` 在 `chatMarkdownPolicy.ts:399-400`，两档节拍注记在 `:391-398` —— 吻合；
③ D2-b 两个提案色的对比度：本轮独立重算 **亮 `#575653` = 7.20、暗 `#9F9D96` = 6.70** —— 与对比稿逐位一致；
④ `bg-accent` 对 `background` = **1.161（亮）/ 1.292（暗）**、`text-foreground` on `bg-accent` = **16.17 / 8.81**、`border-input` 对 `bg-accent` = 1.350 / 1.322 —— 与对比稿一致，D3-c 的色学前提成立。

### 0.6 计算口径（供复核）

本档全部色值由 `globals.css` 的 OKLCH 字面量按标准矩阵转 sRGB、按 WCAG 2.x 相对亮度求比；
`color-mix(in oklab, X N%, Y)` 按 Oklab 线性插值后转回 sRGB（与 Chromium 实绘一致）。
现值交叉验证：亮 `--muted-foreground` = `#686663` = 5.62、暗 `#807E79` = 4.48、派生 tool-arg 亮 `#878581` = 3.61 / 暗 `#676561` = 3.11
—— 与对比稿 §00-B 与 `design-system.md` 已记录值全部吻合，故计算链可信。

---

## §1 F5-D1-b 排版密度换档（散文层）

### 1.1 目标值（用户已拍板，不再讨论）

正文行高 **1.625**（`leading-relaxed`，Tailwind 内置档，零新增 token）、段距 **14px**、标题上距 **24px**、
列表项距 **6px**、代码块行高 **1.5** / 内距 **12px**、表格单元格 py **6px**。回合骨架（10 / 20px）**不动**。

### 1.2 改动点（全部在 `chatMarkdownPolicy.ts`）

| # | 位置 | 现值 | 新值 | 备注 |
|---|---|---|---|---|
| 1 | `:399` `BLOCK_GAP` | `mt-2.5 first:mt-0`（10px） | `mt-3.5 first:mt-0`（14px） | 3.5 × 4 = 14，整档非任意值 |
| 2 | `:400` `SECTION_GAP` | `mt-5 first:mt-0`（20px） | `mt-6 first:mt-0`（24px） | 6 × 4 = 24 |
| 3 | `:426` 根类 | `leading-normal` | `leading-relaxed` | 1.5 → 1.625 |
| 4 | `:473` 列表 | `space-y-1`（4px） | `space-y-1.5`（6px） | |
| 5 | `:475` 嵌套列表再收紧 | `[&_ul]:mt-1 [&_ol]:mt-1`（4px） | `[&_ul]:mt-1.5 [&_ol]:mt-1.5`（6px） | 见 §1.4 裁定① |
| 6 | `:509` 代码块 | `p-2.5 … leading-snug` | `p-3 … leading-normal` | 1.375 → 1.5、10 → 12px；`text-code` 不动 |
| 7 | `:523/:524` 表格单元格 | `px-2.5 py-1` | `px-2.5 py-1.5` | 横向内距不动（4px 表格里横向已够） |
| 8 | `:391-398` 两档节拍注记 | 「两档 = 回合骨架自有的两档，不发明第三档，这是 F-C4 钉的」 | **整段重写**，见 §1.5 | 不重写它，注释就变成假话 |

**不改**：`:493` 链接（无节拍）、`:528` 引用块 `pl-2.5`（横向导轨偏移，非纵向密度）、`:532` `hr`、
`:560` 脚注（继承 `SECTION_GAP`，自动跟随）、`:573` 图片占位芯片。

### 1.3 三个散文渲染点必须同步换档（本节最容易漏的一条）

【实测】`leading-normal` 在 chat 目录里有 **5 个**语义不同的落点，D1-b 只该动其中 **3 个**：

| 落点 | 是否换 `leading-relaxed` | 理由 |
|---|---|---|
| `chatMarkdownPolicy.ts:426` 散文根 | ✅ **换** | 主目标 |
| `MessageTimeline.tsx:1449` 流式期纯文本兜底 | ✅ **换** | **不换就是缺陷**：F-C3 的流式门在 `message.completed` 时把同一段文本从纯文本切成 markdown，若两侧行高不同，这次切换会**额外多出一次整段重排**——F-C3 注释（`chatMarkdownPolicy.ts:317-325`）声明「一次重排是代价，闪烁不是」，漏改会亲手制造第二次 |
| `MessageTimeline.tsx:765` 用户气泡正文 | ✅ **换** | 用户抱怨的「太密集」不区分谁说的话；且 §3 会给气泡换底色，行高不同会让两侧字块节奏可见地不一致 |
| `chatTimelineLayout.ts:79` `turnBodyClass()` | ❌ **不换** | 它是**回合骨架的继承基线**，`turnBodyClass()` 注释（`:74-78`）明说它承载的是 `QuestionCard` 头行这类**没有自己字号的 UI 元素**；换了会把问答卡、工具组壳一起撑开，超出 D1-b 的授权范围 |
| `ToolRows.tsx:76` 工具行 | ❌ **不换** | 工具行是单行密集列表，不是散文。对比稿 §01 差异表也把工具行排除在密度轴外 |

⇒ **新增静态不变量 [INV-D1-1]**：三个散文点的行高类必须**逐字相同**，
且 `turnBodyClass()` / `ToolRows` 行的行高必须**仍是** `leading-normal`（解耦的正向证据，防「一把梭全改」）。

### 1.4 三条裁定

**① 嵌套列表再收紧档 4px → 6px（与项距同值）**
`chatMarkdownPolicy.ts:451-461` 注释自陈：`first:mt-0` 在特异性上压过 `[&_ul]:mt-1`，所以**首个**子列表实测是 0px，
该 utility 真正承重的场景只有「列表项内先有正文、再挂子列表」。那一档在语义上就是**项与项之间的距离**，
应等于项距而非另立一个值。取 6px 后，散文层的纵向数值集合从 {4,6,10,14,20,24} 收敛为 **{6,14,24}** 三个。

**② 表格横向内距不动**
密度抱怨是纵向的（行高、段距）。表格 `px-2.5` 若同步放大，45rem 阅读栏内的宽表会更早触发横向滚动
（`chatMarkdownTableWrapClass()` 的 `overflow-x-auto`），属**负收益**。对比稿差异表也只列了 py。

**③ 代码块行高走内置档 `leading-normal`（1.5），不写 `leading-[1.5]`**
`design-system.md` 的 Token 分档纪律禁任意值；1.5 是内置档，直接用。
⚠️ 顺带记一条**既存违规**（本批不修，另立票）：`ToolRows.tsx:230/233/262/285/304` 五处写着 `leading-[1.55]` 任意值，
与该纪律冲突，且 `:304` 同时带 `text-tool-arg`（§2 会动这个 token）。本批只在 §2 改颜色类，**不顺手改 leading**，
避免把一个既存违规混进本批的变更面。

### 1.5 `:391-398` 注记重写口径（承重变更，不是文字润色）

现注释的主张是：**散文层的两档 = 回合骨架的两档（10 / 20），一个数都没新发明**。
D1-b 之后这句在字面上就是假的。两种改法：

- **（a）连回合骨架一起换档**（10→14 / 20→24）。**不采纳**：20px 回合节拍是 `readingColumnSpacingClass()` 的 `space-y-2.5`
  加 `turnBubbleBandClass()` 的 `py-2.5` **合成**出来的（`chatTimelineLayout.ts:17-32` 的算术注释），
  而 band 的 `py-2.5` 同时是置顶气泡的**不透明缓冲**——动它要重算 sticky 的遮盖，超出本批范围。
- **（b）显式解耦**（**采纳**）：散文层拥有自己的两档（14 / 24），与回合骨架（10 / 20）**解耦并留痕**。

重写后的注记必须讲清三件事，缺一不可：
1. 散文层现在有**自己**的两档，值是 14 / 24，来源是 D1-b 拍板（写明日期与对比稿路径）；
2. 它**不再**等于回合骨架的 10 / 20，且这是**有意的**——散文是长文阅读场景，回合骨架是界面结构节拍，
   两者的变更理由不同（同 `--text-meta` / `--text-code` 同为 13px 却必须是两个 token 的那条论证）；
3. **F-C4 真正钉的东西没变**：散文层仍然**只有两档**，没有第三档。换的是这两档绑定到谁，不是放弃「只有两档」。

### 1.6 断言重写清单（逐条，含退役换新）

`__tests__/chatMarkdownPolicy.test.ts`：

| 现位置 | 现断言 | 处置 |
|---|---|---|
| `:587-598` | 根类 `toContain('leading-normal')` | **改值** → `toContain('leading-relaxed')`，并**补一条负向** `not.toContain('leading-normal')`（防两个 leading 并存——根类是裸字符串不过 `cn()`，tailwind-merge 不会去重，后写的未必赢） |
| `:633-640` | h1–h3 = 20、h4–h6 = 10 | **改值** → 24 / 14；用例名里的 `(20px)` `(10px)` 一并改 |
| `:643-648`（describe 名 `…reuses the turn layout's two tiers…`） | 每个块级 `mt-*` ∈ {10, 20} | **改值 + 改名** → ∈ {14, 24}；describe 改为「散文层自有两档，且仍只有两档」 |
| `:650-657` `F-C4: the 10px tier is literally the turn body gap` | 断言 `turnBodyClass()` 的 gap = 10 **且** 段落 `mt` = 10（把两者绑死） | **退役换新**（解耦后按构造不成立；按变异纪律不许只改数字，必须换承重行）。换成两条见下 |
| `:781` | 脚注 `marginTopPx` = 20 | **改值** → 24 |

**新增两条（替代 `:650-657`）**：

- `[D1-1] 散文层的两档与回合骨架显式解耦`：断言 ① 段落 `mt` = 14；② `chatMarkdownHeadingClass(1)` 的 `mt` = 24；
  ③ `turnBodyClass()` 的 `gap-*` 解析后**仍是 10**（骨架未被误改）；④ **段落 `mt` ≠ 回合骨架 gap**。
  ④ 是解耦的**正向证据**：没有它，「把散文改回 10」这个变异测不出来。
- `[D1-2] 仍然只有两档，没有第三档`：`new Set(ALL_BLOCK_CLASSES.map(marginTopPx)).size === 2`。
  这条严格强于 `expect([14,24]).toContain(...)`——后者对「所有块都退化成 14」（集合塌成一档）**判绿**，前者判红。

【实测】测试辅助函数 `marginTopPx`（`:502-506`）的正则是 `mt-([0-9]+(?:\.[0-9]+)?)`，**接受小数**，
`mt-3.5` → 14、`mt-6` → 24 均可解析，**辅助函数无需改动**。

`__tests__/messageTimelineWiring.test.ts`：

| 现位置 | 现断言 | 处置 |
|---|---|---|
| `:404-406` | 逐字钉流式兜底类串 `"text-markdown leading-normal text-foreground whitespace-pre-wrap select-text"` | **改值**（`leading-normal` → `leading-relaxed`）。这是 D1-b 在本文件的唯一必红点 |
| `:428-433` | `whitespace-pre-wrap text-markdown` 子串出现 **2** 次 | **不改**：命中的两处是 `:765`（用户气泡）与 `:799`（NoticeMessage 体），子串在 `:765` 换档后仍相邻，计数不变 |

**新增 `[INV-D1-1] 三个散文点行高一致 + 骨架未被带跑`**（放 `messageTimelineWiring.test.ts` 的源文扫描区）：
断言 ① `MessageTimeline.tsx` 里出现 `leading-relaxed` 的次数 = **2**（`:765` 与 `:1449`）；
② `chatMarkdownRootClass()` 含 `leading-relaxed`；
③ `turnBodyClass()` 与 `ToolRows.tsx:76` 的行头类**仍含** `leading-normal`。
③ 是「一把梭全改」的反向闸门——它是本条唯一能抓到过度换档的半边。

**不动**：`MessageTimeline.tsx:799`（NoticeMessage 体）**本就没有任何 `leading-*` 类**，靠继承取值，
本批不给它加，也不改它——它是 `Alert` 体不是散文。

---

## §2 F5-D2-b 次要层 token 提档（全局 token 层）

### 2.1 落点与新值

【实测】两处色值定义 + 一处派生 + 两条 `@theme` 桥接，全在 `src/renderer/styles/globals.css`：

| 位置 | 现值（原文） | 新值 | 实测对比度（对 `--background`） |
|---|---|---|---|
| `:159`（`:root`，亮） | `--muted-foreground: oklch(0.5111 0.0053 78.28);` | `--muted-foreground: oklch(0.4531 0.005 91.5);` ＝ `#575653` | 5.62 → **7.20**（AA → AAA） |
| `:211`（`.dark`，暗） | `--muted-foreground: oklch(0.5933 0.0079 88.68);` | `--muted-foreground: oklch(0.6956 0.0103 93.62);` ＝ `#9F9D96` | 4.48 → **6.70**（险过 → AA+） |
| `:195` `--tool-arg` 派生 | `color-mix(in oklab, var(--muted-foreground) 78%, var(--background))` | 混合比 **78% → 85%**（见 §2.3） | 3.61 / 3.11 → **5.09 / 5.02**（不过 AA → 稳过 AA） |
| `:17` / `:37` `@theme` 桥接 | `--color-muted-foreground` / `--color-tool-arg` | **不动**（两个 token 都已注册，无「死件」风险） | — |

⚠️ **写法纪律**：新值必须写成 **OKLCH 字面量**，与该文件其余 token 同形；
**不得**直接写 `#575653` 十六进制——`globals.css:147-232` 全域是 OKLCH，混写会让「同一色空间内比较/派生」的前提破裂
（`--tool-arg` 的 `color-mix(in oklab, …)` 正依赖此）。上表的 OKLCH 值是由目标 sRGB 反解得到的**等价值**，
本轮已做**双向回代验证**【实测】：`oklch(0.4531 0.005 91.5)` → `#575653`、`oklch(0.6956 0.0103 93.62)` → `#9F9D96`，
两者逐位精确；同一条转换链把**现值** `oklch(0.5111 0.0053 78.28)` / `oklch(0.5933 0.0079 88.68)`
分别还原为 `#686663` / `#807E79`（与 `design-system.md` 记录的现值逐位吻合），故转换链本身可信。

### 2.2 亮暗两主题**各自**的判定（不许用 `dark:` 表达差异）

`design-system.md:115-124` 明令「新代码不得用 `dark:` 表达关键可读性差异」。
本批**零处** `dark:`：两个值分别落在 `:root` 与 `.dark` 的同名变量上，靠语义 token 自身随 `.dark` 换值。

| 层 | 亮：现 → 新 | 暗：现 → 新 |
|---|---|---|
| `--muted-foreground` | `#686663` 5.62 → `#575653` **7.20** | `#807E79` 4.48 → `#9F9D96` **6.70** |
| `--tool-arg`（派生 85%） | `#878581` 3.61 → `#6E6D69` **5.09** | `#676561` 3.11 → `#888680` **5.02** |

两个提案色都是 **Flexoki 官方 base 色阶整档**（亮 = base-700、暗 = base-400），不是自创色，
符合 `design-system.md` 的「硬编码色禁令 / 不私自调色」纪律。

### 2.3 裁定：`--tool-arg` **保留派生，混合比 78% → 85%**（【与对比稿冲突】）

对比稿 D2-b 主张「`--tool-arg` **退役**并入 `muted-foreground`」。本规格**不采纳**，改判为「保留并抬比」。四条理由：

1. **用户拍板的用词是「修到过 AA」，不是「退役」。** 分诊档拍板记录第 5 条原文：
   「`--muted-foreground` 取 Flexoki 官方色阶亮 7.20/暗 6.70，**工具参数色修到过 AA**」。
   「修到」预设这个色**继续存在**；退役是设计员的建议，未被逐字采纳。
2. **【实测】退役会消灭一层真实的信息层级。** `ToolRows.tsx` 今天用两个灰表达两级信息：
   行头动词 = `text-muted-foreground`（`:76-77`），**参数与折叠箭头** = `text-tool-arg`（`:112` 箭头、`:304` 参数块）。
   退役后整条工具行变成单一颜色，「动词 / 参数」不再可分。对比稿把这条算成「净减少一个 token」的**收益**，
   实为**信息设计的净损失**。
3. **【实测】派生公式是自平衡的，扔掉可惜。** 同一个混合比在两套主题下产出几乎相同的对比度：
   p=0.78 → 4.34 / 4.36；p=0.80 → 4.54 / 4.54；**p=0.85 → 5.09 / 5.02**；p=1.00 → 7.20 / 6.70。
   这正是 `globals.css:190-194` 注释所述「声明一次，`.dark` 的覆盖自动被拾取」的设计意图，已被本轮数值验证为有效。
4. **为什么是 85% 而不是刚好过线的 80%。** 80% 落在 **4.54**，距 AA 阈 4.5 只有 0.04 余量——
   上游 Flexoki 任何一次微调都会把它推回不合格；85% 给出约 0.5 的余量，同时仍保留 7.20 vs 5.09 的可辨层级差。

**这条最关键的连带后果**：若按对比稿只改 `muted-foreground`、不动派生比，
【实测】tool-arg 只到 **4.34 / 4.36 —— 仍然不过 AA**，而拍板要求它「过 AA」。
⇒ **「只改两个色值就完事」是错的**，本条必须显式执行。

**候选 B（备案，需评审拍板才启用）**：退役 `--tool-arg`，删 `globals.css:195` 与 `:37` 桥接，
`ToolRows.tsx:112/304` 改 `text-muted-foreground`，得 7.20 / 6.70。
代价即理由 2 所述的层级损失。若评审选 B，§8 的测试清单相应替换。

### 2.4 影响面：这是一次**全局**提档，不是聊天页局部改动

`--muted-foreground` 是全仓语义 token。对比稿脚注里的「104 处」【与任务书转述冲突，见 C3】
是 **`src/renderer/components/chat/` 下非测试文件**的计数，**不是**「chat 之外的 104 处」。
真实影响面见 §2.4-b 分面表。

#### 2.4-a 判定规则：三类用法，只有第一类是纯收益

提档动的是**同一个值**，但这个值在仓里承担三种完全不同的角色，必须分开判：

| 类 | 用法形态 | 提档方向 | 判定 |
|---|---|---|---|
| **①「字」** | `text-muted-foreground`（无 alpha） | 亮变深 / 暗变浅，**远离底色** | ✅ **纯收益**，正是本批目标。全部放行 |
| **②「淡字」** | `text-muted-foreground/NN`（带 alpha，如 `/60` `/50`） | 同向变化，但被 alpha 稀释后**仍可能不过 AA** | ⚠️ **逐处审**：提档后仍不达标的，说明该处本就不该用 alpha 表达层级（`design-system.md` Alpha 纪律），列入另立票，本批不顺手改 |
| **③「面」** | `bg-/border-/fill-/stroke-/ring-muted-foreground`（含 `/NN`） | **这是把前景色当背景/线用**——提档会让这个**面/线变得更抢眼** | ⚠️ **需豁免判断**：方向未必是想要的 |

#### 2.4-b 已识别的第③类用法与豁免裁定

【实测】`src/renderer/styles/globals.css:343` 与 `:347`——**滚动条滑块**：

```css
::-webkit-scrollbar-thumb        { @apply bg-muted-foreground/20 rounded-full; }
::-webkit-scrollbar-thumb:hover  { @apply bg-muted-foreground/40; }
```

本轮实测其对 `--background` 的对比度变化：

| 主题 | 滑块常态 `/20` | 悬停 `/40` |
|---|---|---|
| 亮 | `#DFDDD5` 1.335 → `#DBD9D1` **1.385** | `#C0BEB7` 1.831 → `#B8B6B0` **1.983** |
| 暗 | `#2A2827` 1.234 → `#2F2D2C` **1.321** | `#3E3C3A` 1.648 → `#494644` **1.950** |

**裁定：不豁免，放行。** 两个主题、两个状态全部朝「更可见」移动，与本批「对比太弱」的诉求同向；
幅度也小（常态 +0.05/+0.09），不会把滚动条推成抢眼元素。作为参照，`border-border` 对 `background` 是 1.402/1.441
——提档后的滑块常态（1.385/1.321）仍**低于**全仓分割线的强度，不越位。

#### 2.4-c 全仓扫描结果（本轮实测）

**总量**【实测】：`text-muted-foreground(/N)` 在 `src/` **非测试文件**中出现 **844 处**，分布在 **156 份文件**；
其中 `components/chat/` 占 **106 处**（对比稿写 104，同量级，差异来自取证时点）。
⇒ **chat 只占全仓的 12.6%，另外 87.4% 在聊天页之外**。这是一次全应用改造。

**按目录分面（非测试文件数）**：`chat` 25 · `ui` 24 · `settings` 23 · `source-control` 12 · `files` 11 ·
`layout` 8 · `git` 8 · `workspace-shell` 6 · `worktree` 5 · `group` 5 · `todo` 4 · `terminal` 4 ·
`sessions` 3 · `search` 3 · `repository` 2 · `onboarding` 2 · 其余各 1。

**第②类（带 alpha）36 处**，值域 `/40 /50 /60 /70 /72`。集中在 `source-control`（10）、`layout`（8）、
`todo`（6）、`ui`（4 处 `/72`，为 `input`/`tabs`/`menu`/`command` 的 placeholder 档）。
**裁定：本批不逐处改**——提档后它们全部同向改善，仍不达标的属**既存的 alpha 滥用**
（`design-system.md` Alpha 纪律的问题，不是本批引入的），另立票。

**第③类（非 `text-` 前缀）逐处清单与裁定**：

| 位置 | 用法 | 角色 | 裁定 |
|---|---|---|---|
| `globals.css:343 / :347` | `bg-muted-foreground/20` `/40` | 滚动条滑块 | ✅ 放行（§2.4-b 已量化） |
| `source-control/CodeReviewModal.tsx:125`、`files/MarkdownPreview.tsx:183` | `border-muted-foreground/30` | 引用块左导轨 | ✅ 放行——导轨变明显与本批目标同向 |
| `workspace-shell/surfaces/GitHistoryList.tsx:144` | `bg-muted-foreground` | commit graph 节点圆点 | ✅ 放行 |
| `onboarding/OnboardingView.tsx:864` | `bg-muted-foreground/40` | 分页圆点 | ✅ 放行 |
| `settings/GeneralSettings.tsx:923`、`AgentSettings.tsx:487/592/814`、`HapiSettings.tsx:552` | `border-muted-foreground/30` + `border-t-muted-foreground` | 5 处 spinner 轨 + 头 | ✅ 放行——转圈更可见 |
| `settings/prompts/PromptsSection.tsx:190` | `border-muted-foreground` | 单选圆圈描边 | ✅ 放行 |
| `chat/EnhancedInput.tsx:806` | `group-hover:bg-muted-foreground` | 拖拽把手 hover 态 | ✅ 放行 |
| `placeholder:text-muted-foreground(/N)` 约 15 处 | 输入框占位符 | 实为**字**（类①/②） | ✅ 放行 |

上表的判定口径：**只要该处是把 muted-foreground 当"面"或"线"用，且提档后其对相邻底色的对比度超过
`border-border` 的参照强度（亮 1.402 / 暗 1.441），就必须给出豁免或改用 `--border` 的处置**；未超过则放行。

⇒ **结论：零处需要豁免。** 第③类全部是**装饰性标记**（圆点 / 导轨 / spinner / 把手 / 滑块），
提档在两个主题下都朝「更可见」移动，与本批诉求同向，且幅度都在 `border-border` 参照强度以内。

**无自动化对比度/ token 快照测试**【实测】：`src/**/__tests__` 下不存在扫描 `globals.css` 色值或计算对比度的测试
（命中 `oklch`/`contrast` 关键字的 6 份测试全部是字体域 / markdown / dark-variant 扫描，与色值无关）。
⇒ **D2-b 的值改动没有任何单测会红**——这既是好消息（零测试返工）也是风险（改错了没人拦）。
§8.2 因此新增一条 **token 值静态断言**（`[D2-1]`）补这个洞。

### 2.5 基线修订：`design-system.md`「已知偏差」表

【实测】`design-system.md` 的「已知偏差（Flexoki 原值，刻意不私自调色）」表列了三条不满足 AA 的偏差，
其中一条正是 **`--muted-foreground` 暗色 4.49:1**，且表头明写「**改动需另立决策**」。

⇒ **本批就是那个决策。** 处置：
1. **删除**该表中 `--muted-foreground 暗色 4.49:1` 一行（该偏差已被消灭）；
2. 在该表下方**追加一条修订注记**（不静默删行），格式随 §5 的统一归档纪律：
   > 2026-08-18 · F5 批 D2-b：`--muted-foreground` 亮/暗双档提至 Flexoki base-700 / base-400（7.20 / 6.70），
   > 该行偏差消灭；`--tool-arg` 派生比 78%→85%（5.09 / 5.02）。**已刻意偏离上游 Flexoki 原值**，
   > 理由与实测见 `docs/plans/2026-08-18-f456-readability-composer-spec.md` §2。
3. 表头「刻意不私自调色」的措辞需同步放宽为「默认不私自调色；偏离须逐条留痕」——
   否则表头与新增的注记自相矛盾。
4. **另两条偏差（`--success` 亮 4.42、`--destructive` 暗 4.20）本批不动**，保持原状。

### 2.6 前提：背景图未开（对比稿 §02 的前置排查）

【实测】`globals.css:147/149/151/158` 四个面（`--background` / `--card` / `--popover` / `--muted`）
都乘了 `var(--panel-bg-opacity, 1)`，该系数由 `App/hooks/useBackgroundImage.ts:39` 写在 `documentElement` 上。
**一旦开启背景图，本节全部数值失效**（前景对比度改由壁纸决定）。

用户已拍板「**无背景图，阅读底票不立**」⇒ 本批全部数值按 `--panel-bg-opacity = 1` 计算，
`useBackgroundImage` 与 `--panel-bg-opacity` **一字不动**。
**但须在 §10 记一条 open question**：本仓仍保留背景图功能，开图后 D2-b 的收益会被稀释——
「开图时给聊天时间线一个不透明阅读底」是一张**独立的票**，本批不立、不做、只记录。

---

## §3 F5-D3-c 用户气泡非对称（时间线角色层）

### 3.1 定性：这不是「复议 D26 ④」，是兑现 D31

见 §0.5 C1。`docs/plans/openchamber-chat-refactor-ledger.md:75` 的 **D31**（2026-08-13 用户拍板）
已明文「用户气泡**改回右对齐**（推翻 D26④ 满宽，**append-only 以本条为准**）」，
并在 `implementation-status.md:47` 列为「渲染端小批」待排队项，**至今未施工**。
⇒ 本批**不需要新的拍板**，只需在代码与文档侧把这条已生效的裁定落实并留痕（§5）。

### 3.2 改动点（`MessageTimeline.tsx` `UserBubble`）

| 锚点【实测】 | 现状 | 新值 |
|---|---|---|
| `:708-715` D26 ④ 注释块 | 「满宽；85% 与右对齐都没了，因为满宽后没有 slack 可对齐」 | **整段重写**为 D31 兑现记录，见 §3.5 |
| `:716` `<article>` | 无 className | `<article className="flex justify-end">` |
| `:719` 尺寸/形状类串 | `'space-y-2 rounded-lg border px-4 py-2.5'` | `'max-w-[85%] space-y-2 rounded-lg border px-4 py-2.5'` |
| `:726` 角色类串 | `'rounded-br-xs border-primary/8 bg-card'` | `'rounded-br-xs border-input bg-accent'` |

**`max-w-[85%]` 的任意值不违纪**：`design-system.md` 的禁任意值针对**设计 token 维度**
（颜色 / 圆角 / 阴影 / 字号 / 行高）；百分比宽度是布局比例，不在 token 词表内，Tailwind 也无对应内置档。
且 `max-w-[85%]` 正是被 `messageTimelineWiring.test.ts:445` 逐字点名的字符串，沿用同一拼法可让退役换新一一对应。

### 3.3 色学核对（本轮实测，全部达标）

| 项 | 亮 | 暗 |
|---|---|---|
| `bg-accent` 对 `bg-background`（气泡"面"是否看得见） | **1.161** | **1.292** |
| `border-input` 对 `bg-accent`（气泡"线"） | **1.350** | **1.322** |
| `text-foreground` on `bg-accent`（气泡正文） | **16.17** AAA | **8.81** AAA |
| `text-muted-foreground`(D2-b 新值) on `bg-accent` | **6.20** AAA | **5.19** AA+ | 

对照现状：`bg-card` 对 `background` 只有 1.027 / 1.049（不可辨）、`border-primary/8` 对 `card` 只有 1.111 / 1.102（近不可辨）
——**气泡今天等于没画出来**，这正是「无区分度」的精确解释。

**语义依据**（非自创）：`design-system.md:102` 明写「需要真正拉开的第三级底色时，用 `--accent` / `--selection`（交互层）
或 `--input`（填充层）」；`--input` 的词表定义就是「**填充语义**，兼作**输入框**描边」，
而用户气泡正是**用户输入的回显**——描边取 `--input` 是语义命中而非凑色。
用户气泡自身**没有 hover 态**，不会与 `--accent` 的交互语义打架【实测】`UserBubble` 全函数无 `hover:` 类。

### 3.4 三条连带核对（不做会留坑）

**① 右下角 `rounded-br-xs` 终于指向它被设计的那条边。**
`:720-725` 注释自陈这个 4px 尖角是「sharp bottom-right **"tail" toward the right-aligned edge**」——
它是为右对齐设计的，D26 ④ 把右对齐拿掉后这个尖角就成了没有指向的孤儿。D3-c 落地后语义自洽，**无需改动**。

**② 置顶气泡「85% 会漏缝」的旧论证已被 as-built 推翻**（【实测】重要）。
`docs/plans/2026-07-31-reply-anatomy-design.md:421` 曾主张「满宽正是置顶气泡的前提：85% 右对齐的气泡钉在顶端
会留下一条左侧透明缝，滚入内容会从缝里穿出 ⇒ D26 ④ 必须先落地」。
该论证与**同一份规格自己落地的 band** 冲突：不透明遮盖由 **band** 承担而非气泡——
`chatTimelineLayout.ts:63-65` `turnBubbleBandClass()` 返回 `'sticky top-0 z-10 bg-background py-2.5'`，
其头注（`:57-62`）明写「`bg-background` … plus `py-2.5` **is what makes the pinned state opaque**」，
且 band 是**满宽**的块级元素（`MessageTimeline.tsx:1153`）。
⇒ 85% 气泡左侧露出的是 band 的 `bg-background`，即时间线自身底色，**没有透明缝**。
**但**：本条属「布局缺陷只在截图里显形」的高危族，§8 要求 GUI 点验必须包含**滚动到置顶态的截图**，
不得只凭本推理放行。

**③ 气泡内附件芯片的底与线要跟着换。**
【实测】芯片类串在 `:740`：`'… rounded-xs border border-border bg-muted/50 px-1.5 text-meta text-foreground'`。
底色从 `bg-card` 换到 `bg-accent` 后本轮实测：

| 项 | 在 `bg-card` 上（现状） | 在 `bg-accent` 上（D3-c 后） |
|---|---|---|
| 芯片底 `bg-muted/50` 对所在底 | 1.022 / 1.004（不可辨） | 1.041 / **1.115**（略好） |
| 芯片线 `border-border` 对所在底 | ≈1.36 / 1.37 | **1.208 / 1.115（暗色近不可辨）** |

⇒ **裁定**：芯片描边 `border-border` → **`border-input`**（对 accent 1.350 / 1.322），与气泡描边同族同强度。
底 `bg-muted/50` 保持不动（它本就不承担可辨性，芯片靠描边与图标成形）。

### 3.5 `:708-715` 注释重写口径

现注释的主张是「D26 ④：气泡满宽，85% 与右对齐是死重量」。D3-c 之后它是**反向的假话**，必须整段重写，讲清四件事：
1. 现形态的出处是 **D31 冲突项回摆①**（2026-08-13 拍板）+ F5 D3-c（2026-08-18 拍板），写明两个日期；
2. **D26 ④ 至此在代码侧同步作废**，并给出台账锚点（`openchamber-chat-refactor-ledger.md:75`）；
3. 区分度来自**形状不对称**（右对齐 + 85%）而非新容器——这句是与 §4 助手容器的分工声明，缺了它下一个读者会以为两边都在做同一件事；
4. 复述本节的四个实测数（1.161 / 1.350 / 16.17 / 8.81）作为「为什么这次的气泡真的看得见」的证据，
   并点名旧值 1.027 / 1.111 是「为什么上次看不见」。

---

## §4 F5-D3-b 助手中性容器与**解嵌套裁定**

> 用户在设计员明示「三层嵌套框」反对意见后仍拍板 D3-c 与 D3-b **并用**，
> 并要求施工规格给出解嵌套方案、实现方保留否决权上报。本节即该方案。

### 4.1 先把问题量化（对比稿只给了定性）

若按对比稿字面实作（助手散文外层加 `bg-muted + border-border`），本轮实测三个后果：

| 后果 | 实测 | 严重度 |
|---|---|---|
| **行内代码芯片彻底消失** | `CodeInline` 是 `rounded-xs bg-muted px-1 …`（`ui/ident.tsx:31`），容器也是 `bg-muted` ⇒ 对比度 **1.000（同色）** | **致命** |
| **代码块退化成空框** | 代码块底是 `bg-muted/50`（`chatMarkdownPolicy.ts:509`），50% muted 合成在 muted 底上**等于 muted 本身** ⇒ 对容器 **1.000** | **致命** |
| **所有内层边框变弱** | `border-border` 对 `muted` = **1.308 / 1.363**，对 `background` = 1.402 / 1.441 | 中 |
| 容器自身几乎看不见 | `bg-muted` 对 `background` = **1.072 / 1.057**（低于可辨阈） | 高 |

外加一条**词表纪律冲突**：`design-system.md:93-101` 明令「**禁止**用 `bg-secondary` vs `bg-muted` 表达『两层面板』
…… 需要层次时**一律靠 `--border`**」。D3-b 的 `bg-muted` 容器正是「拿 muted 当第二层面」，
实测 1.072/1.057 也确实印证了那条纪律。

⇒ **「三层嵌套框」只是表象；真正的问题是「用一个看不见的面，换掉了两个看得见的面」。**

### 4.2 四个候选与裁定

| 候选 | 形态 | 判定 |
|---|---|---|
| **A · 只用底不用边** | `bg-muted rounded-sm p-3.5`，无 border | ❌ **淘汰**。少一层框线，但 §4.1 的两处 1.000 全数发生，且容器自己也看不见——**既没画出容器，又毁了内层** |
| **B · 只用边不用底** ★ | `rounded-sm border border-border p-3.5`，底保持 `--background` | ✅ **采纳**，理由见 §4.3 |
| **C · 内层首层块级元素边框降级** | 容器 `bg-muted border`，代码块/表格作为容器直接子元素时去边框 | ❌ **淘汰**。① 要给 `chatMarkdownCodeBlockClass()` 之流引入「上下文」参数，破坏 `chatMarkdownPolicy.ts:2-8` 立的模块纪律（无参纯函数、node 环境可真值表化）；② 若改走 CSS `[&>pre]:border-0`，只命中**直接子元素**——列表项内的代码块命中不到，同一份回答里出现两种代码块外观 |
| **D · 容器内距吃掉内层 margin** | 只调间距不调框线 | ⚠️ **部分采纳**：它解决的不是嵌套框（正交问题），但其内距口径并入 B，见 §4.3 |

### 4.3 采纳方案 B 的完整形态

**新增类装配函数**（放 `chatTimelineLayout.ts`，与其余回合级类装配同处，保证 node 环境可断言）：

```
turnAnswerContainerClass() -> 'rounded-sm border border-border p-3.5'
```

**挂载点**【实测】：`MessageTimeline.tsx:1209`
`{answer.length > 0 && <div className={turnBodyClass()}>{answer.map(renderItem)}</div>}`
→ `className={cn(turnBodyClass(), turnAnswerContainerClass())}`。

**为什么挂在 `answer` 段而不是每个 text item**：
【实测】`chatTurn.ts:159-175` `splitTurnBody` 的定义是「`answer` = **尾部连续的 `text` item**，其余归 `process`」，
且 `:29-32` 明文「一条 notice 会终止 answer 尾」。⇒ `answer` 段**按构造只含助手散文**，
永远不含工具组、权限卡、问答卡（那些都在 `process`）——**这正好就是"助手的回答"这个语义单位**，
一个回合最多一个容器，且容器里不可能出现 `.qa` 卡这类自带外壳的东西。
若改为逐 item 包裹，过程段里的中间散文也会各得一个盒子，而过程段本身已经有折叠壳
（`turnProcessShellClass()` + `CollapsibleContent`）——那才是真正的三层。

**`answer === []` 的回合不戴框**（尾部是工具调用或错误通知的回合）：这是有意的。
【实测】`chatTurn.ts:185/203-205` 在 `answerEmpty` 时会强制展开过程段，用户看到的是一个摊开的过程段——
它本来就不是「一个回答」，不给它戴回答的框是诚实的。

**内距取 14px（`p-3.5`）**：与 §1 的 `BLOCK_GAP` 同档，不发明第三个数。
语义：「容器边到首块的距离」与「块与块之间的距离」同档。
`first:mt-0` 已保证首块不再叠加自身上边距（`chatMarkdownPolicy.ts:399-400`），无需额外抵消——这是候选 D 的那一半。

**方案 B 落地后剩余的框层数**：外层容器边框（对底 1.402/1.441）+ 叶子边框（代码块/表格，对底同强度），
两层之间隔着 14px 内距，**不贴边、不同心、不共线**。行内代码芯片与代码块底色**全部保持今天的数值不变**
（芯片 1.072/1.057、代码块 1.035/1.027）——B 的核心价值就是「一个数都不动内层」。

### 4.4 与 D3-c 的分工声明（必须写进注释，否则下个读者会拆错）

- **用户侧**的区分度来自**形状**：右对齐 + 85% + 有色面（`bg-accent`）；
- **助手侧**的区分度来自**边界**：满宽 + 无色面 + 一圈 `--border`；
- 两侧**刻意不同构**。若哪天有人为了「统一」把助手也改成有色面、或把用户也改成满宽描边框，
  就回到了「一切都是卡片、两边反而更像」的失败态——那正是设计员反对 D3-b 的原始理由。
  这句话是本批留给未来的**反向闸门**，必须落在 `turnAnswerContainerClass()` 的头注里。

### 4.5 与 D2-c 的边界

D2-c（行内代码 chip 补 `border-border`、工具输出块补左导轨）**未被拍板，本批不做**。
方案 B 之所以不需要它：B 不动内层任何底色，行内芯片的可辨性问题**保持现状**（本就是既存问题），
不因本批而恶化。若评审希望连芯片一起修，那是**另开 D2-c 的票**，不得夹带进本批的变更面。

### 4.6 实现方否决权与上报路径（用户已明确保留）

**触发条件**（任一成立即触发，不需要全部）：
1. GUI 点验截图显示容器边框与内层叶子框在视觉上仍构成「框中框」的压迫感；
2. 满宽容器把 720px 阅读栏的实际字宽压到读起来更差（14×2 + 2px 边框 = 30px 净损失）；
3. 容器出现/消失的时机（流式期首个 text block 落地那一刻）造成可见跳动。

**上报路径**（三步，不得跳步）：
1. 施工方在**施工分支上**产出对照截图（有容器 / 无容器 × 亮暗 × 含代码块与表格的回合），
   走 `node scripts/dev.js` + CDP 工法，截图入 `docs/design/` 或规格同目录；
2. 在本规格追加 **§4.6-a「实作否决记录」**小节，写明触发条件编号、截图路径、实测数值；
3. 由**用户拍板**是否降级为「只留 D3-c、撤 D3-b」或改走候选 A/C。
   **施工方不得自行撤销 D3-b**——它是用户在知情（设计员已反对）情况下的拍板，
   只有用户能推翻自己的拍板。这条纪律与 D31「append-only 以本条为准」同源。

---

## §5 基线条款正式修订与归档纪律

### 5.1 重要更正：用户气泡的**结构**不需要修订基线，代码是**回归**基线

【实测】两份冻结基线**本来就写着右对齐 + 85%**：

| 基线 | 原文 |
|---|---|
| `docs/design/phase0a-openchamber-alignment.html:419-421` | `/* 用户气泡：右对齐, max-w 85%, 圆角 xl 但右下角收 sm */`<br>`.fx-user { display: flex; justify-content: flex-end; }`<br>`.fx-user-bubble { max-width: 85%; … }` |
| `docs/design/a07-cursor-composer-alignment.html:848-849` | 同上（同一份 CSS 的更早版本） |

⇒ **偏离基线的是 D26 ④（代码），不是 D3-c。** D3-c 落地后，代码**重新与两份基线一致**。
对比稿把 D3-c 标成「触碰基线」【与对比稿冲突】——它触碰的是**决策**（D26 ④），不是**基线文档**的结构条款。
基线文档在结构上**一个字都不用改**，只需改两个色值（见 5.2 第 ④ 条）。

### 5.2 需要正式修订的基线条款（五处，逐条给出处置）

| # | 条款 | 位置 | 触发者 | 处置 |
|---|---|---|---|---|
| ① | 「**助手：完全平铺，无容器**」 | `phase0a:431` 注释 + `:432` `.fx-assistant` | **D3-b** | **正式修订**：注释改为「助手：满宽中性容器（只描边不换底），无色面」；`.fx-assistant` 补 `border` + `border-radius` + `padding`。**必须留修订注记**，见 5.3 |
| ② | 助手正文行高 `1.5` | `phase0a:432`、`a07:858` | **D1-b** | 改 `1.625` |
| ③ | 助手段距（`phase0a:433` = `0.75rem`/12px；`a07:860` = `10px`——两份基线本就不一致【实测】） | 同上 | **D1-b** | 两份统一改 `14px`，并在修订注记里点明「两份基线原本就不一致，本次一并对齐」 |
| ④ | 用户气泡的**底与线**：`background: var(--s-elevated)`（≈`--card`）、`border: … p-base 5%` | `phase0a:424-425`、`a07:852-853` | **D3-c** | 改为 `--accent` 面 + `--input` 线；**结构行（`justify-end` / `max-width:85%`）不动** |
| ⑤ | 「已知偏差」表 `--muted-foreground` 暗色 4.49:1 | `docs/design-system.md`「已知偏差」节 | **D2-b** | 删行 + 追记，详见 §2.5 |

**不修订**：`--muted-foreground` / `--tool-arg` 在 `design-system.md` 语义 token 表里的**语义描述**不变
（还是「次要文字」与「工具行参数」），只有色值变——色值表若已内嵌 hex，需同步（施工时以文件实况为准）。

### 5.3 归档纪律：怎么改，才叫「不静默漂移」

三份文档三种纪律，不可混用：

**（a）设计基线 HTML（`phase0a` / `a07`）—— 就地改 + 修订注记块**
这两份是「观感对齐基线」，plantree 注册表明文「视觉 token、三列骨架、工具行与问答卡形态的**唯一基线**，
业务组件不得自行发明视觉值」。改法：
1. 在被改条款**原位**改值；
2. 在文件**顶部 masthead 区**追加一行修订记录（沿用该文件既有的 `masthead-meta` 形式），格式：
   > **修订 2026-08-18 · F5 批**：助手容器条款（`:431`）· 正文行高 1.5→1.625（`:432`）· 段距→14px（`:433`）·
   > 用户气泡面/线换 accent/input（`:424-425`）。依据 = D49（见台账）+ `docs/plans/2026-08-18-f456-readability-composer-spec.md`。
3. **被改掉的旧值必须在注记里出现**（写「1.5→1.625」而不是只写「1.625」）——
   否则下次有人对着代码复核基线时，无法判断差异是漂移还是裁定。

**（b）决策台账（`docs/plans/openchamber-chat-refactor-ledger.md`）—— append-only，新增 D49 行**
【实测】现有最高决策号是 **D48**，故本批立 **D49**。台账是 append-only，
**不得**回头改 D26 行或 D31 行。D49 行必须写清：
- 本批合并落地 **D1-b + D2-b + D3-c + D3-b**（四项 2026-08-18 用户拍板）；
- **D26 ④ 至此在代码与基线两侧同步作废**，其推翻本身发生在 **D31**（2026-08-13），D49 只是**执行与留痕**；
- 触碰的基线条款清单（= 5.2 的五行）与对应文档锚点；
- 与对比稿的**四处判定分歧**（本规格 §0.5 的 C2/C4/C5+ §2.3 的 tool-arg 裁定），
  写明「以本规格为准」——否则下一个读者会把对比稿当施工图。

**（c）plantree（`docs/plantree/plans/openchamber-chat-refactor/`）—— 只改状态不复制原文**
- `implementation-status.md:47` 的 D31 建议序里，「气泡改回右对齐（推翻 D26④）」一项标记为**已由 F5 批承载**并链到本规格；
- `roadmap.md` 增 F5/F6/F4 三行（或一行合并批次），Done 后回填 hash；
- 注册表行按「不超过一段短叙事」的归档纪律更新，**不复制决策原文，只链接**。

### 5.4 一条容易漏的：代码里的基线引用注释也要跟着改

【实测】代码注释里逐字引用基线行号的地方至少三处，改了基线不改它们就是新的漂移源：
- `MessageTimeline.tsx:691-693`「A07 `:849-855` — 16/16/4/16 corners, `--card` fill, primary-8% border … 是 P-09 落地的逐字节形态」→ `--card`/primary-8% 两处失效；
- `MessageTimeline.tsx:720-725` 同上（`T-30 P-09: A07 .fx-user-bubble (:849-855)`），其中「assistant 需要 bg-accent 来对抗 bg-card/50 的旧注」在 D3-c 后语义反转（**accent 现在归用户气泡**），必须重写；
- `chatMarkdownPolicy.ts:394-397`「`5` = 20px 是 A07 `:846` 的回合节拍」——§1.5 已要求重写。

---

## §6 F6 Composer 两行布局

### 6.1 现状与根因

【实测】`ChatComposer.tsx:2622-2630`，session 模式一行装七件：

```
<div className={composerBarClass('session')}>   // 'flex min-w-0 items-start gap-2'
  {attachButton} {textareaEl} {renderStatusLine(sessionStatusLineWrapperClass())}
  {agentPicker} {modelEffortControls} {permissionControl} {actionButtons}
</div>
```

根因不是「控件多」，而是**同一行里有两个弹性文本竞争者**（textarea 与状态行），
为此仓里长出了一整套补丁：`composerTextareaClass('session')` 的 `min-w-32 flex-[2]`
（`middleColumnLayout.ts:435-464`，三段共 30 行注释）、`sessionStatusLineWrapperClass()` 的
`flex-1 shrink basis-0 max-w-48 h-6`（`:467-508`，四段共 42 行注释）、以及父行的 `items-start`（`:205-221`）。
**拆两行之后这套补丁的前提全部消失**——这是本批最大的一笔复杂度净减。

### 6.2 目标形态

```
卡片
├─ [条件] extras 堆栈：notice · queueNotice · attachmentChips · mentionChips · 状态行(§6.4)
├─ 行 1：textarea 独占全宽
└─ 行 2：attach · agent · model · permission ····· actions(ms-auto 尾靠)
```

### 6.3 `middleColumnLayout.ts` 类装配拆分（保持可测）

| 函数 | 现状 | 新形态 |
|---|---|---|
| `composerBarClass(mode)` | `empty`→`mt-1.5 flex items-center gap-2`；`session`→`flex min-w-0 items-start gap-2` | **`session` 分支改为控件行**：`flex min-w-0 items-center gap-2`。`empty` 分支**一字不动** |
| **新增** `composerRowsClass()` | — | `flex min-w-0 flex-col gap-2`（两行之间 8px，与行内 gap 同档，不发明新数） |
| `composerTextareaClass('session')` | `min-w-32 flex-[2] p-0 [&_textarea]:…` | `w-full p-0 [&_textarea]:…`（**撤 `min-w-32` 与 `flex-[2]`**；pierce-through 的四条 `[&_textarea]:` 一字不动） |
| `sessionStatusLineWrapperClass()` | `flex h-6 min-w-0 flex-1 shrink basis-0 max-w-48 items-center gap-1.5` | `flex min-w-0 items-center gap-1.5`（**撤 `flex-1 shrink basis-0 max-w-48 h-6` 五个补丁类**，见 §6.4） |
| `composerActionGroupClass()` | 仅 empty 模式用 | **两模式共用**：session 行 2 的尾靠也走它（`ms-auto flex shrink-0 items-center gap-1.5`） |

**行 2 可以回到 `items-center`**：`:205-221` 的 round-5 裁定之所以选 `items-start`，
是因为「textarea 是这一行里唯一高度不被钉死的孩子」。行 2 已经没有 textarea，
五个孩子全是 24px 精确盒 ⇒ `items-center` 与 `items-start` 对它们等价，取 `items-center` 更贴合语义。
**并连带撤掉** `sessionStatusLineWrapperClass()` 的 `h-6`（它存在的唯一理由就是补偿父行的 `items-start`，`:496-504`）。

### 6.4 `renderStatusLine` 槽位裁定：**迁位，不退役**（【与分诊冲突】）

分诊 F6 写「F4 落地后回合头等待行变富，composer 状态行**或可退役**；规格期定」。**本规格判定：不能退役。**

【实测】依据链：
1. `middleColumnLayout.ts:607-619`（T-31 §3.2 / F-B11）明文「`sending` **no longer shows this line at all**」——
   等待文案早在 T-31 就迁到回合头了，且 `sending` 字段刻意保留为**可选且被忽略**，专供 F-B11 断言「传了也没用」；
2. `shouldShowStatusLine`（`:621-630`）的返回条件只剩 `reading > 0 || hasStatusError || hasLargeHint`；
3. session 模式再经 `resolveIdleStatusText`（`:524-534`）过滤：`hasStatusError` 时只取 `largeHint`，
   **完整错误正文由卡片上方的红色横幅独占**（`ChatComposer.tsx:2494-2498`）。

⇒ 该槽在 session 模式**今天只可能显示两种东西**：**附件读盘 spinner** 与 **大附件提示**。
两者都是**草稿侧的附件 I/O 事实**，与 F4 的**回合侧等待事实**信息不同源、时机不重叠
（读盘发生在 send 之前）。**F4 再富也覆盖不了它**，退役即信息丢失。

**裁定：迁入卡片顶部的 extras 堆栈**（`ChatComposer.tsx:2606-2613` 那个 `mb-1 flex flex-col gap-1`），
与 `notice` / `queueNotice` / `attachmentChips` / `mentionChips` 并列。三条理由：
1. **同族**：这四件全是草稿侧的附件/队列事实，状态行是第五件，语义归位；
2. **零争宽**：行 2 从此没有任何弹性文本竞争者，F6 的核心诉求才算真正达成；
3. **补丁网络整体退役**：`basis-0` / `max-w-48` / `flex-[2]` / `min-w-32` / `items-start` / `h-6`
   这一整套（`middleColumnLayout.ts` 里 ~72 行注释所解释的 defect-B 与 F5b 两轮修复）**同时失去存在理由**。

**连带裁定**：extras 堆栈的渲染条件从 `hasComposerExtras` 扩为 `hasComposerExtras || statusRowVisible`。
`empty` 模式**不受影响**（它的状态行仍在底部控制条内，见 §6.5）。

### 6.5 empty 模式：确认复用不回归 T-30b2

【实测】empty 模式（`ChatComposer.tsx:2632-2655`）**本来就是两行**：textarea 在上，
`composerBarClass('empty')` 的底部条在下（`attach → agent → model → permission → status → actions`）。
本批对 empty 的改动**必须为零**：
- `composerBarClass('empty')` 分支不动（`mt-1.5 flex items-center gap-2`）；
- `composerTextareaClass('empty')` 不动；
- empty 的状态行**留在底部条内**（它在那一行里是唯一的弹性文本，`flex min-w-0 flex-1 items-center gap-1.5`，
  与 `composerActionGroupClass()` 的 `ms-auto` 配合正常，`:230-243` 注释已解释）——**不跟着 session 迁进 extras**；
- `composerCardClass('empty')` 不动（`rounded-md … p-2`）；
- T-30b2 §5.2 的「⊕ → agent → model → status → actions」阅读序注释（`:2639-2646`）**逐字保留**。

⇒ **两模式的状态行落点从此不同**（session 在 extras、empty 在底部条）。
这不是不一致，是两种卡片形态的必然：empty 卡是居中的大卡、底部条有富余宽度；
session 卡是贴底的窄卡、行 2 塞了五个控件。**必须在 `sessionStatusLineWrapperClass()` 头注里写明这条分工**，
否则下一个读者会「统一」掉它。

### 6.6 五个 leaf 控件的弹层定位逐个排查（分诊要求的施工前过一遍）

结论先行：**零个弹层依赖兄弟相对定位**，五个控件全部安全；但排查中发现**两处真实风险**（③ 与 ⑤）。

| # | 控件 | 弹层机制【实测】 | 迁到行 2 的影响 |
|---|---|---|---|
| ① | `ComposerAttachMenu` | Base UI `Positioner`，`align="start"` + `side={composerPopupSide(mode)}`（`ComposerAttachMenu.tsx:66-68`），锚点是**自身 trigger** | ✅ 无影响。session 恒 `side='top'`（`middleColumnLayout.ts:651-653`），行 2 位置更低，向上开更宽裕 |
| ② | `ComposerModelTrigger` | 同上（`:313-315`） | ✅ 无影响 |
| ③ | `ComposerAgentPicker` | **无弹层**——是内联分段单选（`role="radiogroup"` + 三个 `role="radio"` 按钮，`ComposerAgentPicker.tsx:207-257`） | ⚠️ **有风险，见下** |
| ④ | `ComposerPermissionTrigger` | Base UI `Positioner`（`:310-312`） | ✅ 无影响 |
| ⑤ | `ComposerRoundButton`（actions） | 无弹层，纯按钮 | ✅ 无影响 |
| — | `@` 提及弹层（不在五件内，但同卡） | 绝对定位 `absolute left-2 w-72` + `mentionPopupPlacementClass(mode)`＝`bottom-full mb-1`（`ChatComposer.tsx:2526-2530`），锚点是**卡片**（`composerCardClass` 带 `relative`） | ✅ 语义不变（仍在整张卡上方开），但卡片变高后弹层的**绝对位置随之上移** —— 属预期，需 GUI 截图确认不越出滚动区 |

**③ 的两处真实风险**【实测】：
1. **`shrink-0` 与 `truncate` 自相矛盾**：外层是 `<span className="flex min-w-0 shrink-0 items-center gap-1">`（`:224`），
   内层空态提示是 `<span className="min-w-0 truncate text-meta text-muted-foreground">`（`:260-262`）。
   父级 `shrink-0` 意味着这个 span 永不收缩 ⇒ 子级的 `truncate` **永远不会触发**。
   今天被 textarea 的 `flex-[2]` 吸走了压力所以没暴露；行 2 五件并排后，
   `emptyStateNotice` + `Retry Host` 按钮会**把行 2 顶宽**，把 actions 挤出可视区。
2. **`emptyStateNotice` 是不定长文本**，是行 2 唯一的弹性文本源。

**裁定**：把 `ComposerAgentPicker` 的外层 `shrink-0` 改为 `min-w-0 shrink`（让 truncate 真的可用），
并在行 2 的 DOM 序上把它放在 attach 之后、model 之前（与分诊给的顺序一致）。
**若评审认为空态提示不该抢行 2 的宽**，备选方案是把 `emptyStateNotice` + `Retry Host` 一并迁入 extras 堆栈
（与 §6.4 同一去处），行 2 只留三段单选芯片。**本规格取前者**（改 `shrink`），理由：空态是 Host 不可用的罕见态，
此时 actions 本就不可用，被挤压的代价可接受；迁入 extras 会让「Host 挂了」这条提示离控件太远。

### 6.7 必然连带：42px 静息高度契约与 pill 圆角**双双失效**（分诊未点名的一项）

这是本节最容易被漏、且**会让一整组断言按构造必红**的连锁反应。

【实测】`composerCardClass('session')` 今天返回
`relative rounded-[21px] border border-border bg-card focus-within:border-input flex min-h-10.5 items-center gap-2 p-2`，
其中：
- `min-h-10.5` = **42px**，由 `composerFollowHeightBreakdown()`（`:185-195`）作为**算术**给出：
  border 2 + padding 16 + content 24 = 42，并有断言交叉核对类串与算术（`middleColumnLayout.test.ts:243-289`）；
- `rounded-[21px]` = **42 / 2**，注释（`:166-172`）明说「21 === `composerFollowHeightBreakdown().total / 2`，
  在 42px 静息高度下与 pill 像素等同」，且有断言核对 `21 × 2 === 静息高度`（`:290-307`）。

两行形态下静息高度变为：**border 2 + padding 16 + 行1 24 + 行间 gap 8 + 行2 24 = 74px**。
于是：
- `min-h-10.5` 与 `composerFollowHeightBreakdown()` **必须重算**（新增 `rows` / `rowGap` 两个字段，
  保持「算术可断言」而非「类串里有某个字符串」的既有工法）；
- `rounded-[21px]` **必须退役**：`:138-145` 自己写明 33–37px 的弧是 §5.3 点名的「runaway」形状，
  而 74/2 = **37px** 正好落在那个区间。⇒ session 卡改 **`rounded-md`**（12px），与 empty 卡一致。

**连带简化**：`composerCardClass(mode, opts?: { hasExtras?: boolean })` 的 `opts` 参数**唯一用途**就是切 radius
（`:173` `const radius = opts?.hasExtras ? 'rounded-md' : 'rounded-[21px]'`）。
radius 恒为 `rounded-md` 后，**`opts` 参数整个退役**，调用点 `ChatComposer.tsx:2524` 随之简化。
`hasComposerExtras` 变量本身仍需保留（它还要决定 extras 堆栈渲不渲染，§6.4）。

**另一处连带**：卡片类串里的 `items-center` 应改为**去掉**（默认 `stretch`）——
两行形态下卡内唯一在流子元素是一整列（`ChatComposer.tsx:2605` 的 `flex min-w-0 flex-1 flex-col`），
纵向居中它没有意义，且 extras 出现时会产生歧义对齐。

⚠️ 这一组变更会让 `middleColumnLayout.test.ts` 的 **F-A2 / F-A2b / F-A21 三组共约 5 条断言按构造必红**，
处置见 §8.3——其中 F-A21 两条必须**退役换新**而不是改数字（它们钉的是「pill 的推导链」，这条链本身不再成立）。

---

## §7 F4 等待行

### 7.1 文案形态总表（六个分支，只有一个换词）

| 分支 | 判据 | 新文案 | 相对现状 |
|---|---|---|---|
| `handshake` | `phase === 'handshake'` | `Starting Agent Host… · {N}s` | **逐字不动** |
| `awaiting` 常态 | `< SLOW`，无附件 | `{Verb}… · ↑ {chars} chars{ · ↓ {tok}} · {N}s` | **换词 + 加计数 + 撤 `(up to Ns)`** |
| `awaiting` 带附件 | `< SLOW`，有附件 | `{Verb}… · ↑ {chars} chars{ · ↓ {tok}} · Sent {size} · {N}s` | 同上 |
| `retrying` | 任一 awaiting 分支 + `retry` | 上述 + ` · Retry {a}/{m}` | 后缀位置不动 |
| `slow` | `>= SLOW_WAIT_HINT_SECONDS` | `Still waiting · {N}s{retry} — gateway latency varies. Stop to abort.` | **逐字不动**（F2 §8.2 已逐句审读通过） |
| `streaming` | `hasBlocks` | `✽ {clock} · ↓ {tok}` | **不动**（D33 形态，`✽` 由 `.tsx` 加） |

**为什么俏皮动词只进 `awaiting` 一个分支**：
- `handshake` 分支的语义是「还没传输」，换成拟人动词会重新引入 `:299-306` 注释专门防的那条谎
  （「Sent 152 KB」在握手期就是假话，同理「Pondering」在没连上时也是）；
- `slow` 分支的文案已被 F2 §8.2 逐句审读并裁定「逐字保留」，且 F2 计划用 `[TS-1]` 钉住它含 `Stop to abort.`
  （声明目的就是**防 F4 误删**）——本规格照办；
- `streaming` 分支已经有真事实（时钟 + token 数），不需要装饰。

### 7.2 裁定：`(up to Ns)` 从句**退役**（F2 §8.4 移交本批判断）

F2 把预算源换成 `SEND_SILENCE_CEILING_MS`（300s 量级），于是文案会从 `(up to 45s)` 变成 `(up to 300s)`。
**本规格判定：整个从句退役，不显示任何预算数字。** 三条理由：
1. **语义已经变了**：F2 之后这个数字不再是「回复预算」，而是「静默上限，**到期也不杀回合**」（F2 §4.4）。
   英文 `up to N` 读作「最多等这么久就会有结果」——正是 F2 明确不再承诺的事。
2. **与既有纪律冲突**：`attachments.ts:309-312` 明写「Deliberately **never predicts a finish time**：
   实测延迟与负载无关且跨日波动约 8 倍，假数字比没有更糟」。`(up to 300s)` 就是一个软性的完成时间预测。
3. **信息未丢失**：「还要等多久」由 45s 的分支转档（措辞切到 `Still waiting`）与常驻的 Stop 按钮承载，
   两者都是**可执行**的信息，比一个不再兑现的数字有用。

⇒ `composerSendingLine` 的 `budgetMs` 入参**退化为未使用**。**不删该参数**：保留并标注为「接受但忽略」，
沿用 `shouldShowStatusLine` 对 `sending` 的同款处理（`middleColumnLayout.ts:615-619`：
「删掉它，这条断言所守的回归就变得不可表达」）——留着才能断言「传了预算也不会出现在文案里」。

### 7.3 俏皮动词词表与轮换规则

**词表（12 个，全英文，与周边 UI 一致）**：

```
Pondering · Percolating · Ruminating · Noodling · Mulling · Simmering
Marinating · Cogitating · Deliberating · Brewing · Puzzling · Contemplating
```

**选词纪律（四条，评审按此逐词核）**：
1. **不得声称对端在做什么具体的事**（禁 `Reading your files` / `Searching` 之类——那是工具行的职责，
   而且在 `awaiting` 分支按定义还没有任何 block 到达，说什么都是猜）；
2. **不得暗示进度或剩余时间**（禁 `Almost there` / `Nearly done`）；
3. **不得带负面或指责语气**（禁 `Still nothing…`）；
4. 全部是**不及物、进行时**的中性动词——它们描述的是「有事情在发生」这个可验证的事实
   （请求确已在途：`sawUserEcho` 与 F2 的活性帧都能证明），不是对端的心理活动。

**轮换规则（纯函数，零随机、零状态）**：

```
VERB_ROTATION_SECONDS = 6
index = Math.floor(max(0, floor(elapsedSeconds)) / VERB_ROTATION_SECONDS) % VERBS.length
```

- **纯 `elapsedSeconds` 的函数** ⇒ `composerSendingLine` 保持纯函数，同参同出，可逐秒真值表化；
  **禁止** `Math.random()` / `Date.now()`（§8 有源文扫描断言）。
- **6 秒一换**：够读完，又不至于让一次等待里只见一个词。
- **不重复不变量**：该分支的生命周期是 `[0, SLOW_WAIT_HINT_SECONDS)` = `[0, 45)`，
  最多出现 `ceil(45 / 6) = 8` 个词 < 12 ⇒ **一次等待里动词永不重复**。
  这条要写成**跨模块断言** `Math.ceil(SLOW_WAIT_HINT_SECONDS / VERB_ROTATION_SECONDS) <= VERBS.length`
  ——如果 F2 之后有人上调阈值，这条会**立刻变红**，把「动词开始重复」这个静默退化变成显式失败。

### 7.4 ↑ 与 ↓ 两个计数的接线

**↓ 输出 token（接入 `awaiting`）**：数据已经在渲染端。
【实测】链路：Host `usage.updated{interim}` → `contextSurfaceModel.ts:808-825` `foldInterimTokensDisplay`
→ `turnTokensDisplay` → `MessageTimeline.tsx:245-247` 的窄选择器 → `ChatTurn` 的 `outputTokensDisplay` prop
→ `deriveTurnStatus`（`:995`）。今天 `turnStatus.ts:102-113` **只在 `hasBlocks` 的 streaming 分支消费它**。
改法：把 `outputTokensDisplay` 透传进 `composerSendingLine`，由后者在 awaiting 分支追加 ` · ↓ {tok}`。
**清理时机不用改**：`clearTurnTokensDisplay`（`contextSurfaceModel.ts:843-860`）已在 `session.status(idle/failed)`
与 `message.completed` 两处清零，awaiting 分支自动跟随。

**↑ 发送字符数（新字段，纯渲染端）**：
- `stores/turnSendStatus.ts` 的 `TurnSendStatus` 接口加 `promptChars: number`；
- 写入点 `ChatComposer.tsx:1117-1127` 的 `beginTurnSend({...})`，取值 **`[...committed.text].length`**
  （**码点**而非 `.length` 的 UTF-16 码元：CJK 在 BMP 内两者相同，但 emoji 会被 `.length` 数成 2，
  给用户看的计数不该有这种偏差。与 `CHAT_HIGHLIGHT_MAX_CHARS` 刻意用码元的理由**相反**且不矛盾——
  那里量的是分词器成本，这里量的是「我打了多少字」）；
- 取值必须来自 **`committed`**（提交点快照）而非实时 `value`——与同处 `attachmentCount`/`attachmentBytes`
  取 `drafts` 而非实时状态的理由逐字相同（`:1091-1096` 注释）；
- 读出点：`MessageTimeline.tsx:986-1013` 的 `deriveTurnStatus({...})` 加 `promptChars: sendStatus?.promptChars ?? 0`。
  **`?? 0` 且 0 时不显示 ↑**——「会话已在运行但本窗口没有快照」的既有降级路径（`:983-985` 注释）不能因此多出一个假的 `↑ 0`。

**单位词的不对称是有意的**：`↑ 428 chars` 带单位、`↓ 1.8k` 不带。
理由：`turnStatus.ts:144-151` 明令 ↓ 是 Host 从流式增量估出来的**估算峰值**，
「只能作为粗略的进行中指示，**绝不可呈现为权威 token 数**」——给它补一个 `tokens` 单位词会**抬高它的权威观感**，与该纪律相悖；
↑ 是渲染端自己数出来的精确值，标单位零风险，且正好把两个箭头区分开。**这句话必须写进注释**。

**格式化函数下沉（防循环依赖）**：
`formatTokenCount` 今天在 `turnStatus.ts:152-155`，而 `turnStatus.ts:1` 已经 `import … from './attachments'`。
让 `attachments.ts` 反向 import 它就是**循环依赖**。
⇒ 新建 `src/renderer/components/chat/countFormat.ts`，放 `formatTokenCount` 与新的 `formatCharCount`；
`attachments.ts` 与 `turnStatus.ts` 各自从它 import；`turnStatus.ts` **保留 re-export**
（`export { formatTokenCount } from './countFormat';`）以免动既有 import 与 `turnStatus.test.ts:6` 的引用。
`formatCharCount` 与 `formatTokenCount` 同形（`<1000` 原样，`>=1000` 取 `x.xk`），共用同一实现。

### 7.5 `slow` 色阶处置（F2 移交②）——两个问题，不是一个

【实测】`MessageTimeline.tsx:1372-1377`：

```
function turnStatusToneClass(kind) {
  if (kind === 'slow') return 'text-warning';
  if (kind === 'failed') return 'text-destructive';
  return false;   // 其余走 turnHeadClass() 自带的 text-muted-foreground
}
```

F2 §8.3 指出的问题是**告警疲劳**：预算抬到 300s 后，「首 token 慢于 45s」会成为长 prompt / 长 thinking 的**常态**，
一个持续数分钟的警告色等于没有警告。本轮补出**第二个、更根本的问题**（【与 F2 建议的差异】，见 §0.5 C8）：

> `--warning` 与 `--primary` **逐位同色**【实测】：亮 `globals.css:176` `oklch(0.5665 0.1523 45.02)` = `--primary` 亮值；
> 暗 `:223` `oklch(0.6576 0.1539 49.3)` = `--primary` 暗值。`design-system.md` 自己就写着
> 「**不要用 `warning` 代替 amber**——Flexoki 的 `status.warning` 与 `primary.base` 逐位同色，用了会跟品牌橙撞」。
> ⇒ 今天的 slow 态涂的其实是**品牌橙**。

**裁定（三条）**：
1. **`slow`（>= 45s）降级为 muted**：`turnStatusToneClass('slow')` 返回 `false`，走 `turnHeadClass()` 自带的
   `text-muted-foreground`。D2-b 提档后它是 7.20 / 6.70，**读得清清楚楚，不需要靠颜色喊**——
   这正是 F5 与 F4 合批的红利：可读性上去了，就不必再用颜色补偿。
2. **新增第二档 `stalled`**：阈值 `STALLED_HINT_SECONDS = 180`，`TurnStatusKind` 加 `'stalled'` 成员，
   **文案与 `slow` 完全相同**（只换语气载体，不换措辞）——这样 F2 §8.2 审读通过的那句原样留用，零文案风险。
3. **`stalled` 的色**：仍取 `text-warning`。承认它 ≡ 品牌橙，并在注释里写明**为什么此处可接受**：
   回合头内没有任何链接（`text-primary` 的唯一常规用途），且这是整条时间线上唯一需要抢眼的时刻。
   **不为它新增 token**——新增语义色要走 `@theme` 双写（`design-system.md` 的「新增 token 的强制动作」），
   本批不值得为一个色阶开这个口子。

**阈值常量归属**：`STALLED_HINT_SECONDS` 定义在 `attachments.ts`，与 `SLOW_WAIT_HINT_SECONDS`（`:297`）**同处**。
它**不是超时阈值**（不触发任何 abort / unbind / 状态变更），只是**展示阈值**，故不越 §0.2 的 F2 边界。
配一条本地不变量：`SLOW_WAIT_HINT_SECONDS < STALLED_HINT_SECONDS`。

⚠️ **跨批次冲突，必须协调（本规格发现）**：F2 §9 计划新增的 `[TS-1]` 断言原文是
「`elapsedSeconds >= SLOW_WAIT_HINT_SECONDS && !hasBlocks` 时 `kind === 'slow'`」。
本批引入 `stalled` 后，**该断言在 elapsed >= 180 时按构造为假**。
处置：**F4 落地时把 `[TS-1]` 修订为分段式**——
`SLOW <= elapsed < STALLED → 'slow'`、`elapsed >= STALLED → 'stalled'`，
并把它真正承重的那半（**两种 kind 的文案都必须含 `Stop to abort.`**）**扩到两个分支**，
一个字都不能少。谁后落地谁执行这次修订；**先落地方不得因为「测试会红」而放弃 `stalled` 或放弃 `[TS-1]`**。

### 7.6 红卡中英混排（F2 移交③）——**降级为待拍板，本批不擅改**

【实测】F2 §2 新发现⑤ 引的位置有行漂移，实际中文串在 `MessageTimeline.tsx:556-558`：
`已产内容保留。可从下方输入框重发上条消息。`

但本轮发现这**不是一处孤立的错字**：`authRequiredError.ts:57-60` 的 `AUTH_REQUIRED_ERROR_VIEW`
（`title: '需要重新登录'` / `message: '登录状态已失效，请重新登录后再试。'` / `actionLabel: '重新登录'`）
是 **D47 S5 §3 有意引入的中文用户可见文案**，`MessageTimeline.tsx:521-526` 的注释明确说明了这个设计意图。

⇒ 本仓**同时**存在「控件/状态文案全英文」与「错误说明有意中文」两套口径，而**全局 UI 语言口径从未被裁定**。
**裁定：本批不擅自改语言。** 处置：
1. 记入 §10 open questions，作为需要用户拍板的一条（全英 / 全中 / 英控件 + 中错误说明）；
2. 本批**只守内部一致性**：§7.3 的动词表用英文（与它所在的那条状态行其余部分一致），**不新增任何中文文案**；
3. F2 移交③ 状态改为「**已定性、待全局语言口径拍板后统一执行**」，不在本批闭环。

### 7.7 `attachments.test.ts` 逐字文案断言重写清单

【实测】`__tests__/attachments.test.ts:324-464` 的 `describe('composerSendingLine (T-18 B2)')` 共 **11 条**，
按新形态逐条处置：

| 行 | 用例 | 处置 |
|---|---|---|
| `:325-334` | text-only：`'Waiting for Agent Host reply · 12s (up to 45s)'` | **退役换新** → 断言形态而非整句：含 `↑`、含 `· 12s`、**不含** `up to`、且首词 ∈ `VERBS` |
| `:336-346` | 带附件：`'Sent 152.0 KB · waiting for reply · 31s (up to 75s)'` | **退役换新** → 含 `Sent 152.0 KB`、含 `↑`、不含 `up to` |
| `:348-358` | slow：`'Still waiting · 62s — gateway latency varies. Stop to abort.'` | **逐字保留，一字不改**（F2 审读结论 + `[TS-1]` 的承重半边） |
| `:360-368` | 「永不说 Uploading」 | **保留**，并**扩为对全词表的属性断言**：12 个动词逐个跑一遍，无一含 `upload` |
| `:370-383` | 握手不谎称已送达 | **保留**（`'Starting Agent Host… · 3s'` 逐字不动） |
| `:385-395` | 握手过阈值仍是握手措辞 | **保留** |
| `:397-410` | retry 后缀不吞基础文案 | **改值**（基础文案换词），断言重点改为「retry 后缀存在 **且** 首词仍是动词」 |
| `:412-423` | 带附件行也追加 retry | **改值**，同上 |
| `:425-435` | 过阈值仍追加 retry | **逐字保留** |
| `:437-457` | 无 retry 时无后缀，且两种写法等价 | **保留**（与措辞无关的纯结构断言） |
| `:459-464+` | 握手期不显示 retry | **保留** |

**新增 6 条**（详见 §8.4 的编号清单）：动词轮换的确定性、不重复不变量、`↑`/`↓` 的出现与省略条件、
`budgetMs` 被忽略、无随机源。

---

## §8 静态不变量、测试与变异计划

### 8.1 总原则

**（a）「布局缺陷只在截图里显形」的教训要在本批兑现。**
本批有三处纯视觉改动（气泡对齐 / 助手容器 / composer 两行），单测看不见渲染结果。
应对不是「多截图」，而是把**能静态表达的结构承诺全部静态断言掉**，
让截图只用于验证**静态断言表达不了的那部分**（真实换行、真实遮盖、真实弹层位置）。
每条新增断言都必须能指出「它抓的是哪个具体退化」，抓不出退化的断言不写。

**（b）退役换新 > 改数字。** 凡是断言的**承重命题本身**不再成立的（F-C4 两档绑定、pill 推导链、D26 ④ 满宽），
一律退役并写新的承重行；只有命题成立、只是取值变了的（20→24、`leading-normal`→`leading-relaxed`）才改数字。
按变异纪律，改数字的断言在变异验证里咬合力不变，退役换新的必须重新验证咬合。

**（c）本批共触及 7 份测试文件**：`chatMarkdownPolicy.test.ts` · `messageTimelineWiring.test.ts` ·
`chatTimelineLayout.test.ts` · `middleColumnLayout.test.ts` · `composerFormStatic.test.ts` ·
`attachments.test.ts` · `turnStatus.test.ts`。

### 8.2 F5 层：测试合同变更

**D1-b（散文层）** —— 详表见 §1.6。摘要：`chatMarkdownPolicy.test.ts` 改值 4 组、退役换新 1 组（`:650-657`）、
新增 2 条（`[D1-1]` 解耦正向证据 / `[D1-2]` 仍只有两档）；`messageTimelineWiring.test.ts` 改值 1 条（`:404-406`）、
新增 1 条（`[INV-D1-1]` 三散文点一致 + 骨架未被带跑）。

**D2-b（token 层）** —— 【实测】**现有测试零红**（§2.4-c：仓里没有任何色值/对比度扫描测试）。
⇒ 必须**新增**一条，否则这次改动完全无网：

- `[D2-1] globals.css 的四个次要层数值锁`（建议落 `src/renderer/styles/__tests__/tokenValues.test.ts`，新建）：
  读 `globals.css` 源文，正则取 `:root` 与 `.dark` 的 `--muted-foreground` 字面量、以及 `--tool-arg` 的
  `color-mix(in oklab, var(--muted-foreground) N%, var(--background))` 中的 `N`，断言：
  ① 两个 OKLCH 值逐字等于本规格 §2.1 表中的目标值；② `N === 85`；
  ③ `--tool-arg` 的定义**仍然是对 `--muted-foreground` 的派生**（正则里必须出现 `var(--muted-foreground)`）——
  这条抓的是「有人把 tool-arg 改成独立字面量，从此两个色不再联动」的静默漂移；
  ④ `.dark` 里**没有**第二条 `--tool-arg` 声明（`globals.css:190-194` 的「声明一次」设计意图）。
  **不在测试里做 sRGB/WCAG 计算**：那会把一份色彩科学实现搬进测试并需要自证，性价比不对；
  数值论证留在本规格 §2，测试只锁「文件里写的确实是被论证过的那个值」。

**D3-c（用户气泡）** —— `messageTimelineWiring.test.ts`：

| 处置 | 内容 |
|---|---|
| **退役换新** `:443-451` `it('D26 ④: the user bubble is full width')` | 语义反转：从 `expectUnwired('max-w-[85%]')` + `expectUnwired('justify-end')` 改为 `[D3-1] 用户气泡右对齐收窄`：`expectCalled('flex justify-end')`、`expectCalled('max-w-[85%]')`、`expectCalled('rounded-br-xs border-input bg-accent')`，并**保留原有的** `expectCalled('turnFooterClass()')`（它证明 footer 的右对齐是另一个元素，没被这次改动吞掉） |
| **不改** `:226-228` 元断言 | 它要求字符串字面量 `rounded-br-xs` 存活于负向投影——该串本批仍在，元断言继续成立 |
| **新增** `[D3-2] 气泡不再坐在 card 上` | `expectUnwired('bg-card')`（在 `UserBubble` 范围内）——抓「改了对齐忘了改底色」 |
| **新增** `[D3-3] 附件芯片描边跟随` | `expectCalled('border border-input bg-muted/50')`（§3.4 ③ 的裁定） |

**D3-b（助手容器）** —— `chatTimelineLayout.test.ts` 新增一组：

- `[D3-4] turnAnswerContainerClass 只描边不换底`：断言返回串**含** `border border-border`、
  **不含** `bg-`（任何底色类）。这条是 §4 整个解嵌套裁定的**唯一静态守卫**——
  它把「哪天有人顺手补个 `bg-muted` 让容器'看得见一点'」直接变成红。
- `[D3-5] 容器内距与散文段距同档`：`p-3.5` 解析出的 14 === `marginTopPx(chatMarkdownParagraphClass())`。
  跨模块相等，抓「只改了一边」。
- `[D3-6] 容器不上 sticky 禁忌属性`：沿用 `chatTimelineLayout.test.ts` 既有的 F-B8/F-B10 工法，
  断言容器串不含 `overflow-`/`transform`/`filter`/`contain`——**这条不是形式主义**：
  容器是新加在 sticky 链上的祖先元素，任何一个都会静默关掉置顶气泡。
- `messageTimelineWiring.test.ts` 新增 `[D3-7] 容器挂在 answer 段而非逐 item`：
  `expectCalled('cn(turnBodyClass(), turnAnswerContainerClass())')` **且**
  该标识符在文件里只出现一次（防被复制到 `process.map` 那一侧）。

### 8.3 F6 层：测试合同变更（`middleColumnLayout.test.ts`）

| 现位置 | 处置 |
|---|---|
| `:243-289` F-A2 静息高度（42px，类串 × 算术交叉核对） | **改值 + 扩形**：74px，`composerFollowHeightBreakdown()` 增 `rows`/`rowGap` 字段，交叉核对保持不变（这条的**承重命题「高度是算出来的不是抄的」仍成立**，故改值不退役） |
| `:290-307` F-A21 两条（pill 半高圆角 · `21 × 2 === 静息高度`） | **退役换新**：pill 推导链不再成立（§6.7）。换为 `[F6-1] session 卡与 empty 卡同用 rounded-md`，并断言类串**不含** `rounded-[`（任意值圆角彻底离场） |
| `:308-331` F-A2b（extras 时降到 `rounded-md`）+「从不用 rounded-lg」 | **退役换新**：`opts.hasExtras` 参数退役后该分支消失。「从不用 `rounded-lg`」一条**保留** |
| `:332-368` `composerBarClass`/`composerActionGroupClass` 组 | `empty` 三条**不动**；`:340-361` session 两条（8px gap 无上偏移 · `items-start` 顶边对齐）**改值**为 `items-center`，并把 round-5 的理由注释改写为「行 2 已无 textarea」 |
| `:369-438` `composerTextareaClass` 组 | `empty` 四条不动；`:416-421`（128px 宽度地板）与 `:432-438`（`flex-[2]` 主导权重）**双双退役**——两者都是单行争宽的补丁。换为 `[F6-2] session textarea 独占整行`：含 `w-full`、**不含** `flex-`、**不含** `min-w-` |
| `:439-486` `sessionStatusLineWrapperClass` 组 5 条（`basis-0` · `shrink`+`min-w-0` · 非零 grow · `max-w-48` · `h-6`） | **整组退役**（§6.4：该槽迁出争宽行）。换为 `[F6-3] 状态槽是整行槽`：含 `min-w-0`、**不含** `flex-1`/`basis-`/`max-w-`/`h-6` |
| `:487-527` `resolveIdleStatusText` 组 6 条 | **全部保留**——该函数的选词逻辑与位置无关，本批不动它 |

**新增结构断言**（放 `composerFormStatic.test.ts`，沿用其源文扫描工法）：

- `[F6-4] session 分支确实是两行`：扫 `ChatComposer.tsx` 源文，断言 session 分支里
  `composerRowsClass()` 出现且 `composerBarClass('session')` 的兄弟里**不含** `textareaEl`
  ——抓「加了外层 flex-col 但七件套还在同一个内层 div」这种半吊子落地；
- `[F6-5] 行 2 的尾靠是 ms-auto 组`：断言 session 行 2 使用 `composerActionGroupClass()`
  （今天只有 empty 用它）；
- `[F6-6] empty 分支零改动`：把 empty 分支的整段 JSX（attach → agent → model → permission → status → actions 的顺序）
  作为**顺序断言**钉住——这是 T-30b2 §5.2 阅读序不回归的唯一静态守卫。

### 8.4 F4 层：新增断言与**变异编号清单**

**新增 8 条断言**（`attachments.test.ts` 承 F4-1~F4-5、F4-8；`turnStatus.test.ts` 承 F4-6；
`composerFormStatic.test.ts` 承 F4-7）：

| 编号 | 断言 | 抓什么 |
|---|---|---|
| `[F4-1]` | 动词是 `elapsedSeconds` 的**确定性**函数：同参两次调用逐字相等；`0..44` 逐秒枚举得到的动词序列是固定序列 | 随机化 / 引入状态 |
| `[F4-2]` | **一次等待内不重复**：`ceil(SLOW_WAIT_HINT_SECONDS / VERB_ROTATION_SECONDS) <= VERBS.length`，且 `0..SLOW-1` 枚举出的动词集合大小恰为 `ceil(SLOW/ROTATION)` | 周期调小 / 词表删短 / F2 上调阈值 |
| `[F4-3]` | `↑`/`↓` 的出现与省略：`promptChars === 0` 时无 `↑`；`outputTokens == null` 时无 `↓`；两者都给时都出现且 `↑` 在 `↓` 前 | 计数漏接、顺序漂移、`↑ 0` 假值 |
| `[F4-4]` | `budgetMs` 被忽略：仅 `budgetMs` 不同的两次调用输出**逐字相等**，且输出不含 `up to` | `(up to Ns)` 复活 |
| `[F4-5]` | 无随机源：源文扫描 `attachments.ts` 不含 `Math.random` / `Date.now` | 纯函数性被破坏 |
| `[F4-6]` | 分档 + 色阶：`deriveTurnStatus` 在 `45..179` 给 `'slow'`、`>=180` 给 `'stalled'`，**两者文案都含 `Stop to abort.`**；`turnStatusToneClass('slow')` 为 falsy、`('stalled')` 为 `'text-warning'` | `stalled` 没接线 / slow 色阶没降 / F2 的 `[TS-1]` 承重半边被弄丢 |
| `[F4-7]` | `promptChars` 取提交点快照：`ChatComposer.tsx` 源文含 `[...committed.text].length`，且 `beginTurnSend(` 的实参里出现 `promptChars` | 取了实时 `value`（会数成用户下一条正在打的字） |
| `[F4-8]` | 词表纪律：12 个动词全部匹配 `/^[A-Z][a-z]+$/`；无一含 `upload`/`almost`/`nearly`/`still`（§7.3 四条选词纪律的可断言部分） | 有人往词表塞了带承诺或带指责的词 |

**变异编号清单（28 发，逐发标注发射半边）**

| # | 变异 | 应红的断言（发射半边） |
|---|---|---|
| M-01 | `BLOCK_GAP` 退回 `mt-2.5` | `[D1-1]①` —— **注意 `[D1-2]` 不会红**（集合仍是两档），这就是为什么 `[D1-1]` 必须存在 |
| M-02 | `SECTION_GAP` 退回 `mt-5` | `[D1-1]②` |
| M-03 | 根类退回 `leading-normal` | `chatMarkdownPolicy.test.ts:590`（改值后） |
| M-04 | 只改根类，漏改 `MessageTimeline.tsx:1449` | `[INV-D1-1]①`（计数 2） |
| M-05 | 顺手把 `turnBodyClass()` 也换成 `leading-relaxed` | `[INV-D1-1]③` |
| M-06 | `--muted-foreground` 亮值退回旧值 | `[D2-1]①` |
| M-07 | `--tool-arg` 混合比 85 → 78 | `[D2-1]②` |
| M-08 | `--tool-arg` 改成独立字面量（断开派生） | `[D2-1]③` |
| M-09 | `.dark` 里补第二条 `--tool-arg` | `[D2-1]④` |
| M-10 | 用户气泡只加 `max-w-[85%]`，漏 `justify-end` | `[D3-1]` |
| M-11 | 用户气泡保留 `bg-card` | `[D3-2]` |
| M-12 | 助手容器补 `bg-muted`（"让它看得见一点"） | `[D3-4]` —— 本批**最重要的一发**，它守住 §4 的整个解嵌套裁定 |
| M-13 | 容器内距改 `p-3` | `[D3-5]` |
| M-14 | 容器加 `overflow-hidden` | `[D3-6]` —— 真实缺陷：会静默关掉置顶气泡 |
| M-15 | 容器挂到 `process.map` 一侧 | `[D3-7]`（唯一出现次数） |
| M-16 | session 卡 radius 退回 `rounded-[21px]` | `[F6-1]` |
| M-17 | textarea 保留 `flex-[2]` | `[F6-2]` |
| M-18 | 状态槽保留 `max-w-48` | `[F6-3]` |
| M-19 | 行 2 漏 `ms-auto` 尾靠 | `[F6-5]` |
| M-20 | empty 分支控件顺序被"顺手统一" | `[F6-6]` |
| M-21 | 轮换周期 6 → 3 | `[F4-2]`（`ceil(45/3)=15 > 12`） |
| M-22 | 词表删到 6 个 | `[F4-2]`（`ceil(45/6)=8 > 6`） |
| M-23 | 改用 `Math.random()` 选词 | `[F4-5]` + `[F4-1]` |
| M-24 | `(up to Ns)` 复活 | `[F4-4]` |
| M-25 | slow 分支也换成俏皮动词 | `attachments.test.ts:348-358`（逐字保留的那条） |
| M-26 | `stalled` 没接线，`slow` 仍上 `text-warning` | `[F4-6]` |
| M-27 | `promptChars` 取实时 `value` | `[F4-7]` |
| M-28 | `↓` 只接 streaming，漏接 awaiting | `[F4-3]` |

**零跳过纪律**：28 发全部实跑，不得以"显然会红"跳过。
按既有工法，**先跑变异确认红、再回退确认绿**；任一发出现存活，说明对应断言是空壳，必须换承重行而不是加一条同义断言。

### 8.5 GUI 点验清单（静态断言表达不了的那一半）

走 `node scripts/dev.js` + CDP 工法。**每项都要亮暗双主题截图**：

| # | 场景 | 验什么（静态断言看不见的部分） |
|---|---|---|
| G-1 | 一屏三个以上回合，含代码块 + 表格 + 列表 | D1-b 的真实呼吸感；D3-b 容器与内层叶子框的**视觉压迫感**（§4.6 否决权触发条件①） |
| G-2 | **滚动到置顶气泡态** | §3.4 ② 的核心：85% 气泡左侧露出的是否确为 band 的 `bg-background`，**有无透明缝** |
| G-3 | 超长单行用户提问（触发三行 clamp） | 85% 宽下 clamp 的触发时机与省略号表现 |
| G-4 | 带附件的用户消息 | §3.4 ③ 芯片在 `bg-accent` 上的可辨性 |
| G-5 | Composer 两行 · 静息态 | 74px 高度是否与设计一致；`rounded-md` 观感；行 2 五控件不拥挤 |
| G-6 | Composer 两行 · 五个弹层逐个打开 | §6.6 的排查结论证实（尤其 `@` 提及弹层是否越出滚动区） |
| G-7 | Composer · Host 空态（agent picker 显示 `emptyStateNotice` + Retry Host） | §6.6 ③ 的挤压风险 |
| G-8 | Composer · 读盘中 + 大附件提示 | §6.4 状态行迁入 extras 后的观感与卡片高度跳变 |
| G-9 | 等待行 0→45→180→300s 全程 | 动词轮换观感、`↑`/`↓` 计数、`slow`→`stalled` 的色阶转换时机 |
| G-10 | **聊天页之外**：设置页 / 侧栏 / source-control / todo 看板 / onboarding | §2.4-c 的 87.4% ——D2-b 是全应用改造，不能只验聊天页 |

### 8.6 跨批次待补断言（依赖 F2 落地）

| 项 | 内容 | 谁执行 |
|---|---|---|
| ① | `[TS-1]` 修订为分段式（`slow` / `stalled`），承重半边扩到两个分支 | **后落地的一方**（§7.5 已写协调口径） |
| ② | 链式不变量 `SLOW_WAIT_HINT_SECONDS < STALLED_HINT_SECONDS < SEND_SILENCE_CEILING_MS / 1000` | F2 落地后补；本批先只断言前半 |
| ③ | `composerSendingLine` 的 `budgetMs` 在 F2 换源后仍被忽略（`[F4-4]` 的跨批次复验） | 后落地方跑一次 |

---

## §9 切片方案与影响面全清单

### 9.1 混面分析（先说清哪里不能并行）

分诊问的是「token 层 / 时间线层 / composer 层可否并行零混面」。**逐层查完的答案是「不完全能」**：

- 【实测】`MessageTimeline.tsx` 被**三件事**同时触及：D1-b 的两处行高（`:765` / `:1449`）、
  D3-c/D3-b 的气泡与容器（`:708-740` / `:1209`）、F4 的等待行接线（`:986-1013` / `:1372-1377`）;
- 【实测】`messageTimelineWiring.test.ts` 同理被 D1-b 与 D3-c 同时触及；
- 【实测】`ChatComposer.tsx` 被 F6（`:2524` / `:2604-2656`）与 F4（`:1117-1127`）同时触及。

⇒ 「按 D1/D2/D3/F6/F4 五件事各切一片」会制造三处文件级冲突。**按文件簇重切为四片**才真正零混面。

### 9.2 四切片（依赖序：`① ∥ (② ∥ ③) → ④`）

| 片 | 内容 | 独占文件 | 与谁并行 |
|---|---|---|---|
| **① token 层** | D2-b（`--muted-foreground` 双档 + `--tool-arg` 混合比） | `styles/globals.css` · `docs/design-system.md` · **新建** `styles/__tests__/tokenValues.test.ts` | **与全部片并行**，零文件重叠、零现存测试依赖 |
| **② 时间线层** | D1-b + D3-c + D3-b | `chatMarkdownPolicy.ts` · `chatTimelineLayout.ts` · `MessageTimeline.tsx` · `chatMarkdownPolicy.test.ts` · `chatTimelineLayout.test.ts` · `messageTimelineWiring.test.ts` · 两份基线 HTML | 与 ① ③ 并行 |
| **③ composer 层** | F6 两行布局 | `ChatComposer.tsx` · `middleColumnLayout.ts` · `middleColumnLayout.test.ts` · `composerFormStatic.test.ts` | 与 ① ② 并行 |
| **④ 等待行** | F4 | `attachments.ts` · `turnStatus.ts` · `stores/turnSendStatus.ts` · **新建** `countFormat.ts` · `attachments.test.ts` · `turnStatus.test.ts` ＋ **轻触** `MessageTimeline.tsx`(2 处) 与 `ChatComposer.tsx`(1 处) | **排最后**——它是唯一同时轻触 ② 与 ③ 文件的片 |

**为什么 D1-b 与 D3 必须同片（不拆）**：两者都改 `MessageTimeline.tsx` 与 `messageTimelineWiring.test.ts`，
且 D3-b 的容器挂点（`:1209` 的 `answer` 段）与 D1-b 的散文类串是同一段渲染逻辑的两面——
拆开会让第二个人在一份刚被改过的 AST 投影断言上重新对账，成本高于合并。

**为什么 ① 值得单独一片**：它是**唯一一个影响面越出聊天页**的改动（§2.4-c：87.4% 在 chat 之外），
它的验收标准（G-10 全应用点验）与其余三片完全不同；单独成片才能单独回滚。

### 9.3 影响面全清单

**生产代码（12 份）**

| 文件 | 改动 | 片 |
|---|---|---|
| `src/renderer/styles/globals.css` | `:159` / `:211` 色值 · `:195` 混合比 | ① |
| `src/renderer/components/chat/chatMarkdownPolicy.ts` | `:391-400` 注记 + 两常量 · `:426` 行高 · `:473/:475` 列表 · `:509` 代码块 · `:523-524` 表格 | ② |
| `src/renderer/components/chat/chatTimelineLayout.ts` | **新增** `turnAnswerContainerClass()` | ② |
| `src/renderer/components/chat/MessageTimeline.tsx` | `:708-726` 气泡 · `:740` 芯片描边 · `:765` / `:1449` 行高 · `:1209` 容器挂载 · `:986-1013` promptChars 读出 · `:1372-1377` 色阶分档 | ② + ④ |
| `src/renderer/components/chat/ChatComposer.tsx` | `:2524` 卡片参数 · `:2604-2656` 两行结构 + 状态行迁位 · `:1117-1127` promptChars 写入 | ③ + ④ |
| `src/renderer/components/chat/middleColumnLayout.ts` | `composerCardClass`（radius/opts/items）· `composerFollowHeightBreakdown` · `composerBarClass('session')` · **新增** `composerRowsClass` · `composerTextareaClass('session')` · `sessionStatusLineWrapperClass` | ③ |
| `src/renderer/components/chat/ComposerAgentPicker.tsx` | `:224` `shrink-0` → `min-w-0 shrink` | ③ |
| `src/renderer/components/chat/attachments.ts` | `composerSendingLine` 重写 · **新增** `VERBS` / `VERB_ROTATION_SECONDS` / `STALLED_HINT_SECONDS` | ④ |
| `src/renderer/components/chat/turnStatus.ts` | `TurnStatusKind` 加 `'stalled'` · `TurnStatusInput` 加 `promptChars` · `formatTokenCount` 下沉 + re-export | ④ |
| `src/renderer/components/chat/countFormat.ts` | **新建** | ④ |
| `src/renderer/stores/turnSendStatus.ts` | `TurnSendStatus` 加 `promptChars` | ④ |
| `src/renderer/components/chat/ToolRows.tsx` | **零改动**（`text-tool-arg` 保留，见 §2.3；`leading-[1.55]` 既存违规不在本批） | — |

**测试（8 份，1 份新建）**：`chatMarkdownPolicy.test.ts` · `chatTimelineLayout.test.ts` ·
`messageTimelineWiring.test.ts` · `middleColumnLayout.test.ts` · `composerFormStatic.test.ts` ·
`attachments.test.ts` · `turnStatus.test.ts` · **新建** `styles/__tests__/tokenValues.test.ts`。

**文档（6 份）**：`docs/design-system.md`（§2.5）· `docs/design/phase0a-openchamber-alignment.html`（§5.2 ①②③④）·
`docs/design/a07-cursor-composer-alignment.html`（§5.2 ②③④）· `docs/plans/openchamber-chat-refactor-ledger.md`（新增 **D49** 行）·
`docs/plantree/plans/openchamber-chat-refactor/{implementation-status,roadmap}.md` · 本规格（as-built 回填）。

⚠️ **规划文档改动纪律**：`docs/plans` 与 `docs/plantree` 的表格行含全角标点，
**跳过 Edit 工具，直接用 python 做字节级替换**（本仓已在此处栽过三次）。

### 9.4 门禁

服务器内存有限，**逐门串行跑**，不得链式合跑（曾 OOM `exit 137`）。
每片独立跑一次全量 vitest；四片合并后再跑一次；GUI 点验（§8.5 十项）在四片全落之后一次性做。
变异验证按片跑自己那一段（① = M-06~M-09；② = M-01~M-05、M-10~M-15；③ = M-16~M-20；④ = M-21~M-28）。

---

## §10 Open questions 与实现方否决权上报路径

### 10.1 需要**用户拍板**才能施工的（三条，建议评审时当场问）

| # | 问题 | 本规格的建议答案 | 为什么必须问 |
|---|---|---|---|
| **Q1** | `--tool-arg` 走**抬比到 85%**（保留三级灰阶）还是走对比稿的**退役并入 muted-foreground**？ | **抬比**（§2.3 四条理由） | 这是与对比稿的**正面分歧**，且两者视觉结果明显不同（工具行是一色还是两色）；只改色值不动派生比则**过不了 AA**，无论如何都必须选一个 |
| **Q2** | 等待行的 `(up to Ns)` 从句**退役**，还是保留并显示 F2 的新预算（300s）？ | **退役**（§7.2 三条理由） | 它改写 4 条逐字文案 pin；且 F2 明确把这个判断移交本批 |
| **Q3** | 全局 UI 语言口径：全英 / 全中 / 英控件 + 中错误说明？ | **不建议**（无技术最优解，纯产品口径） | §7.6：仓里同时存在 D47 有意引入的中文错误文案与全英文控件文案，口径从未裁定；F2 移交③ 卡在这里 |

### 10.2 需要**评审确认**的（四条，技术判断，不必惊动用户）

| # | 问题 | 本规格的判断 |
|---|---|---|
| Q4 | Composer 静息高度 42px → **74px**（§6.7），时间线可视区少 32px——可接受吗？ | 可接受：两行是用户明确要的形态，32px 是它的必然代价；且 empty 模式本就更高 |
| Q5 | session 与 empty 的状态行落点从此不同（extras vs 底部条，§6.5）——算不算不一致？ | 不算：两种卡形态不同，且已在 `sessionStatusLineWrapperClass()` 头注写明分工 |
| Q6 | `STALLED_HINT_SECONDS = 180` 这个数值（§7.5） | F2 §8.3 的建议值，本规格照用；无实测依据，属可调参数 |
| Q7 | `composerCardClass` 的 `opts` 参数退役（§6.7）——施工前须 grep 确认无第二个消费者 | 【本轮实测】仅 `ChatComposer.tsx:2524` 一个调用点，退役安全；施工时复验 |

### 10.3 明确**另立票**、本批不做（五条）

1. **背景图开启时的聊天阅读底**（§2.6）：开图后 D2-b 的收益被壁纸稀释，正解是给时间线一个不透明底，属独立设计决策。
2. **`text-muted-foreground/NN` 的 36 处 alpha 滥用**（§2.4-c）：提档后仍有不达标的，属 Alpha 纪律的既存问题。
3. **`ToolRows.tsx:230/233/262/285/304` 五处 `leading-[1.55]` 任意值**（§1.4 ③）：与 Token 分档纪律冲突的既存违规。
4. **D2-c 容器边界可见化**（行内代码 chip 补边框 / 工具输出块补左导轨，§4.5）：未拍板。
5. **F1 / F3 / F7 / F8 / F9**：分诊档已各自分批。

### 10.4 实现方否决权上报路径（用户已明确保留，见 §4.6）

**唯一适用对象是 D3-b（助手中性容器）**——它是用户在设计员明示反对后仍作出的拍板。

- **触发条件**：§4.6 的三条（视觉压迫感 / 阅读宽度净损 / 出现消失跳动），任一成立即触发；
- **上报动作**：施工分支产出对照截图 → 在本规格追加 §4.6-a「实作否决记录」→ **由用户拍板降级方案**；
- **禁止动作**：施工方**不得自行撤销 D3-b**，也不得"折中"成 `bg-muted` 版（那是 §4.2 已淘汰的候选 A，
  且会触发 M-12 变异所守的 `[D3-4]` 断言）。

**其余四项（D1-b / D2-b / D3-c / F6）不适用否决权**：它们要么是纯数值换档、要么是执行既有裁定（D31），
争议已在本规格内用实测消解；如有异议应在**评审阶段**提出，不留到施工期。

---

## 附：本规格与既有档案的关系

- **上游**：`docs/plans/2026-08-17-d48-t10-inspection-triage.md`（F4/F5/F6 三节 + 拍板记录第 5 条）；
  `docs/design/2026-08-18-f5-chat-readability-draft.html`（对比稿，**设计稿而非施工图**，八处需修正见 §0.5）。
- **平行**：`docs/plans/2026-08-18-f2-watchdog-redesign-spec-trackA.md`（边界见 §0.2~§0.4，协调项见 §7.5 / §8.6）。
- **下游**：本批落地后须回填 **D49** 决策行、两份基线 HTML 的修订注记、`design-system.md`「已知偏差」表、
  plantree 三处状态（§5.3）。
- **权威顺序**（plantree 注册表所定）：ARD ＞ 执行计划 ＞ 总台账（决策）＞ plantree（状态）。
  本规格属**批次施工规格**，其内的裁定在与对比稿冲突时以本规格为准，在与总台账决策冲突时以总台账为准
  ——本规格已逐条核对，**无一处与总台账冲突**（D31 是支持而非冲突，见 §3.1）。


