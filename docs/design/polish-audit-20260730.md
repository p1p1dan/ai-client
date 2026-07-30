# 观感打磨审计 · 2026-07-30

> 触发：用户首轮 GUI 点验判定「布局大致可以，细节需要大量打磨——字体、明暗对比、重点突出、条目显示标记、内容气泡、输入框外观、返回内容渲染、焦点跟踪（已修）。说白了不协调，Cursor/openchamber 很协调有美感，我们一团乱麻。」
> 本文件**只审计不改代码**。每一项独立可拍板。
> 审计基准 commit `b2fadb9`（分支 `feat/openchamber-chat-refactor`）。

---

## 0. 审计口径与素材

| 项 | 内容 |
|---|---|
| 目标态 | **亮色 Flexoki**（默认已于 `4019fed` 改亮）。现状截图是暗色，审计时按亮色 token 折算 |
| 对照图 A | `docs/design/refs/feedback-20260730/cursor-参照-协调布局.png`（用户指定的「协调」目标） |
| 对照图 B | `docs/design/refs/feedback-20260730/aiclient-现状-首轮点验.png`（现状） |
| 观感基线 | `docs/design/a07-cursor-composer-alignment.html`（中列唯一基线，v3 用户定稿）· `docs/design/phase0a-openchamber-alignment.html`（A01/A05/A06）· `docs/design-system.md` |
| 取证方式 | 截图**逐像素取色**（非目视）+ 代码 `file:line` + 基线 HTML 行号 + WCAG 对比度实算 |

### 0.1 归属图例

| 标记 | 含义 |
|---|---|
| 🟢 纯打磨 | 现状**偏离**已验收基线，或基线未定义。改它 = 回归/补齐，不需要用户重新拍板视觉决策 |
| 🟠 基线修订 | 现状**符合**已验收基线，但基线本身与 Cursor 目标态冲突。改它 = 修订 A01 或 A07 某条，需用户拍板 |
| 🔵 已在队 | 已有任务认领（T-23 / T-25 等），本轮**只标注不施工** |
| 🟣 决策复议 | 需要用户重新裁定一条已拍板决策（D18） |

量级：**S** ≤ 0.5d · **M** 0.5~1.5d · **L** >1.5d 或需单独立项

### 0.2 三条实测硬数据（后文反复引用）

**① Flexoki 亮色对比度实算**（OKLCH → sRGB → WCAG 相对亮度）

| token | 亮色 hex | vs 背景对比度 | 判定 |
|---|---|---|---|
| `--background` | `#FFFDF4` | — | — |
| `--foreground` | `#100F0F` | **18.78:1** | 正文档 |
| `--muted-foreground` | `#686663` | **5.62:1** | 过 AA |
| `--tool-arg`（= `color-mix(muted-fg 62%, bg)`） | `#9F9C97` | **2.68:1** | ❌ **低于 AA(4.5) 且低于 AA-large(3.0)** |
| `--destructive` | `#AF3029` | **6.29:1** | ⚠️ **比正文档 muted 还高** |
| `--border` | `#DAD8CE` | 1.40:1 | 分隔线，正常 |
| `--input` | `#CECDC3` | 1.57:1 | Composer 强边，正常 |

暗色同算：`--tool-arg` ≈ `#565350` = **2.38:1**，更差。

**② 字号/字重使用面**（`components/chat/**` + `components/workspace-shell/**` 全量统计）

| 字号类 | 出现次数 | 实际 px | 是否在 A07 三档内 |
|---|---|---|---|
| `text-xs` | **37** | 12 | ❌ |
| `text-sm` | **36** | 14 | ✅ `--t-ui` |
| `text-[10px]` | 12 | 10 | ❌（且 `--text-2xs` 已在 `@theme` 却不用） |
| `text-markdown` | 11 | 15 | ✅ `--t-md` |
| `text-code` | 7 | 13 | ✅ `--t-code` |
| `text-[11px]` | 3 | 11 | ❌ |
| `text-base` | 1 | 16 | ❌ |

→ **实际 7 档字号，A07 只定义 3 档（13/14/15）**。

同一统计面下的另外两个维度：

| 维度 | 实测 | 应有 |
|---|---|---|
| 字重 | `font-medium` 12 处 · `font-normal` 1 处 · `semibold`/`bold` **0 处** | — |
| 字距 | `tracking-*` 全域 **仅 1 处**（还正是 P-08 建议删掉的 `USER` 角标上的 `tracking-wide`） | `design-system.md:341-347` 明文：**「OpenChamber 的标题层级不靠字号区分」**，规定 weight + **letter-spacing** + color 三件套；A07 `:1339` 对侧栏段头重申「等宽字体下缩字号既不省宽也会破坏纵向节拍，**层级交给颜色与字距**」 |

**这是「排版层级缺失」最干净的一句根因**：设计系统规定的层级三件套是 **weight × letter-spacing × color**；生产代码里 weight 在等宽栈下部分失效（见 §b.2）、letter-spacing 用了 **1 次**（且即将归零）——**只剩 color 一个维度在扛全部层级**。于是层级只能靠"再灰一点"表达，一路灰到 `--tool-arg` 的 2.68:1。

**③ 颜色使用面**（`components/chat/**`）：`text-muted-foreground` **68** 处 vs `text-foreground` **37** 处 —— 中列多数像素落在 5.62:1 的灰档，这是「明暗对比不足」的量化根因。

---

## 1. 逐项差距清单

**总计 34 条**：🟢 纯打磨 **20** · 🟠 需修订已验收基线 **10** · 🔵 已在队(T-23) **3** · ✅ 现状合规（仅记录防误改）**1**。

10 条基线修订全部落在 **A07**（其中 P-10 同时连带 **A01**），逐条锚点见各行「归属」列。

### A 组 · 错误视觉权重（对应初判 ①）

> **先纠正一条初判**：截图逐像素取色证明，**输出体正文并没有变红**——取样 `#807E79` = `--muted-foreground`（暗色），与 A07 `.fx-out`（`:958-965`，`color: var(--muted-foreground)`）**完全一致**。红的是**工具行行头**，取样 `#D14D41` = `--destructive`。所以「满屏红」的成因不是"输出体权重过猛"，而是下面三条**叠加放大**。

| ID | 现象（截图区位） | 根因（`file:line`） | 修法提案 | 归属 | 量级 |
|---|---|---|---|---|---|
| **P-01** | 中列上半 3 条工具行**整行**红：`Explored 2 files` / `Read vflow/package.json` / `Read vflow/README.md`，红字符总量约 130 个 | `ToolRows.tsx:59-63` 失败时 verb 与 arg 双双转 destructive；`ToolRows.tsx:110` arg = `text-destructive/70` | 三级降权：**动词保持 `--destructive`，参数回落 `--tool-arg`，输出体保持 muted**。每条失败行的红字符从 30~48 降到 4~8，三条簇从 ~130 降到 ~18 | 🟠 **A07 修订**（`:2528`「失败行整行转 destructive（动词深、参数浅同样成立）」是明文裁定，动它须用户点头） | S |
| **P-02** | 聚合行 `Explored 2 files` 也是红的，但"2 files"本身不是错误对象 | `toolCard.ts:360` `failed = runEntries.some(...)`——任一子调用失败即传染整个聚合行 | 聚合行**不转红**，只在展开后的子行转红；或聚合文案改 `Explored 2 files — 2 failed`（数字局部红） | 🟠 **A07 修订**（A07 只定义了单条失败行，从未定义聚合行的失败态，属基线空白，但改动会与 `:2528` 的字面口径相抵） | S |
| **P-03** | 3 条失败行**全部默认展开**，把红行头拉成 3 段间隔的红块，视觉上被"分散重复"放大 | `ToolRows.tsx:77` `defaultOpen={view.failed}`；`toolCard.ts:243-252` 失败强制 `body:'output'` | 保留"失败自动展开"（A07 `:2432` 明文裁定），但**同一 ToolGroup 内 ≥3 条失败时只自动展开第一条**，其余留收起态 | 🟠 **A07 修订**（新增"失败簇"规则，A07 mock 里只出现过单条失败） | M |
| **P-04** | 输出体是纯灰文本，没有任何局部高亮；A07 `.fx-out` 定义了 `.ok`/`.bad`/`.num` 三个高亮 span（`:966-968`）却从未落地 | `ToolRows.tsx:199-212` `<pre>` 直出 `view.output` 纯字符串 | 补一层轻量高亮（`✓`/`✗`/数字/`Error:` 前缀），**这才是初判①想要的"muted + 局部高亮"** | 🟢 纯打磨（补齐 A07 已定义未落地部分） | M |
| **P-05** | `text-destructive/70` 与 A07 的 `color-mix(destructive 70%, background)`（`:2448`）**不等价**：Tailwind `/70` 编译成 alpha 0.7 | `ToolRows.tsx:110` | 改 `text-[color-mix(in_oklab,var(--destructive)_70%,var(--background))]` 或新增 `--destructive-arg` token。开启背景图（`--panel-bg-opacity<1`）时 alpha 版会透出底图 | 🟢 纯打磨 | S |
| **P-06** | 会话失败时底部整块红底红字告警框，与上方失败行叠加 | `MessageTimeline.tsx:202-223` `border-destructive/40 bg-destructive/10 text-destructive` | 标题保留 destructive，**正文与提示行回落 muted-foreground**；A07 未定义此形态，属外推 | 🟢 纯打磨（基线空白） | S |
| **P-07** | 「工具权限流中断」这类**非模型过错**的失败，与 `typecheck exit 2` 这类真错误同权重 | 无分级：`toolCard.ts:62` 只有 `toolOk===false` 一档 | 增设"中断/取消"档（灰 + `Interrupted` 文案，不进 destructive）。⚠️ **不能用 `--warning`**：`globals.css:130` 亮色 `--warning` 与 `--primary` 同值（品牌橙），会与发送键撞色 | 🟠 A07 修订（新增状态档） | M |

### B 组 · USER 气泡（对应初判 ②）

> **纠正初判 ②**：`USER` 大写角标在 **A01 和 A07 两份基线里都不存在**——`phase0a:1060-1061` 与 `a07:1721-1722` 的 markup 都是裸气泡 `<div class="fx-user-bubble">正文</div>`，没有任何 role 标签。所以**去掉它是回归基线，不是修订 A01**，无需用户为此拍板视觉决策。

| ID | 现象 | 根因 | 修法提案 | 归属 | 量级 |
|---|---|---|---|---|---|
| **P-08** | 两个 USER 气泡各自顶着 `USER` 大写小字，生硬且占一整行 | `MessageTimeline.tsx:399-401` `<p className="text-[11px] font-medium uppercase tracking-wide">{message.role}</p>` | **直接删**。同时删掉那个 `text-[11px]` 野字号 | 🟢 纯打磨（**回归 A01/A07**） | S |
| **P-09** | 气泡外形四处偏离基线：圆角 16px 均匀 / 内距 12·8 / `bg-accent` / `border-border` | `MessageTimeline.tsx:386-397` `rounded-lg border px-3 py-2 border-border bg-accent` | 按 A07 `:849-855`：`border-radius: 16 16 4 16`、`padding: 10px 16px`、`background: var(--card)`、`border: color-mix(primary 8%, transparent)`。<br>⚠️ `:388-396` 那段注释（"assistant 是 `bg-card/50` 所以 user 只能用 accent"）**前提已失效**——T-05 之后 assistant 已是裸的无底色（`:460`），user 气泡可以放心回到 `--card` | 🟢 纯打磨（回归 A07） | S |
| **P-10** | 两条连续 USER 气泡宽度参差（一宽一窄）右对齐，与左对齐的 assistant 内容构成锯齿；左侧大片留白 | `MessageTimeline.tsx:383-386` `justify-end` + `max-w-[85%]` 内容自适应宽 | Cursor 参照图里 user 块是**满宽卡片**（跨整个阅读栏）。建议改 `w-full`（或 `max-w-none`）+ 去掉 `justify-end` | 🟠 **A01 + A07 双修订**（A01 `:420-421` 与 A07 `:848-849` 都明写 `justify-content: flex-end` + `max-width: 85%`） | M |
| **P-11** | `system` / `error` 角色复用同一气泡、也带大写角标，但走左对齐 + `bg-card/50` → 出现基线里从未有过的第三种形态 | `MessageTimeline.tsx:379-397` 只按 `isUser` 二分 | 通知类改用已有 `Alert` 原语（`HistoryErrorNotice` 同款），不复用气泡 | 🟢 纯打磨（基线空白） | S |

### C 组 · 排版层级（对应初判 ③）

| ID | 现象 | 根因 | 修法提案 | 归属 | 量级 |
|---|---|---|---|---|---|
| **P-12** | 全屏 7 档字号（10/11/12/13/14/15/16），相邻档只差 1~2px，没有一档读得出"层级"；同时字重完全缺席 | 见 §0.2 ②。`globals.css:42-46` 只桥了 `--text-2xs`/`--text-code`/`--text-markdown`，**14px 的 `--t-ui` 档没进 `@theme`**，于是 UI 文本只能退用 Tailwind 内置 `text-sm`/`text-xs`，而 `text-xs`=12px 根本不在 A07 三档内却成了**用得最多的一档（37 处）** | ① `@theme` 补 `--text-ui: 0.875rem`；② `text-xs`(12) 与 `text-[11px]` 全量迁到 `text-code`(13) 或 `text-2xs`(10)；③ `text-[10px]` 迁 `text-2xs`。**目标：中列 + 侧栏只剩 10/13/14/15 四档** | 🟢 纯打磨（回归 A07 `:455-457`） | M |
| **P-13** | 「Worked for 1s」/答案「2」/「00:42」三行毫无层级——只差灰阶，字号 15/15/13 | `MessageTimeline.tsx:461`(ToolGroup 15px muted) → `:466-473`(正文 15px foreground) → `:516-520`(footer 13px muted) | 层级重建见 **专题 b**。最小改动：正文加 `font-medium`，Worked-for 与 footer 保持 regular；正文与 footer 之间间距从 10px 提到 16px | 🟢 纯打磨 | S |
| **P-14** | **meta 行丢了 model 名**，只剩 `00:42`。A07 `:1776-1782` 口径是 `claude-opus-5 · 07:41` | 根因链已定位：`ModelSelect.tsx:32-48` 初值 = `stored ?? defaultModelId()` 但**只在 `onValueChange` 时才 `setSessionModel`（`:56`）**，默认值从不落盘 → `useMessageMetadata.ts:38` `getSessionModel()` 返回 `null` → `messageMetadata.ts:141` `if (metadata.model)` 跳过 → 只剩时间 | 二选一：① ModelSelect 挂载时把解析出的默认值写回 `setSessionModel`；② `useMessageMetadata.ts:38` 改 `getSessionModel(sessionId) ?? defaultModelId(hostDefault)`。**推荐②**（不产生"用户没选却被写盘"的副作用）。<br>⚠️ 这是**真 bug 不是观感问题**，且属"用假空态伪装"的邻居 | 🟢 纯打磨（bug fix） | S |
| **P-15** | `--tool-arg` 承载文件名、路径、Thought 正文、Worked-for 展开体、chevron，实测 **2.68:1（亮）/ 2.38:1（暗）**，双双低于 AA-large | `globals.css:149` `color-mix(in oklab, var(--muted-foreground) 62%, var(--background))` | 62% → **78%**（实算 ≈3.4:1，仍是三级灰里最浅但进入可读区）。若要达 AA 4.5 需 ≈88%，但那时与 `--muted-foreground` 几乎无差、三级灰塌成两级 | 🟢 纯打磨（token 微调；A07 只规定"三级灰"未规定混合比） | S |
| **P-16** | 中列 68 处 muted vs 37 处 foreground —— 大部分内容是灰的，"重点"无处落脚 | 见 §0.2 ③ | 重新分配：**assistant 正文、user 气泡正文、侧栏会话标题、Composer 输入文本**四处必须是 `--foreground`；其余保持 muted | 🟢 纯打磨 | M |
| **P-17** | 回合节奏不均：`space-y-5`(20px) + ToolGroup 自带 `my-2.5`(10px) 叠加，实际间距在 20/30/22.5 之间跳 | `MessageTimeline.tsx:172` + `ToolRows.tsx:42` + `MessageTimeline.tsx:460` `[&>p+p]:mt-2.5` | 间距收敛到 4 的倍数三档：**块内 4 / 段间 10 / 回合间 20**，消除叠加 | 🟢 纯打磨 | S |
| **P-18** | meta 时间是绝对时刻 `00:42`；Cursor 参照用相对 `37m ago` | `messageMetadata.ts:152-157` `defaultFormatTime` | 改相对时间（侧栏已经在用相对时间，两处口径统一）。A07 `:1776` 写的是绝对 `07:41` | 🟠 A07 修订（小） | S |
| **P-19** | 顶栏标题 `text-sm`(14px) 是全屏视觉最"重"的文字之一，但正文是 15px → **层级倒挂** | `MainHeader.tsx:35` | 标题提到 `text-markdown`(15px) + `font-medium`；或正文体系整体上抬 | 🟢 纯打磨 | S |

### D 组 · 顶栏（对应初判 ④）

| ID | 现象 | 根因 | 修法提案 | 归属 | 量级 |
|---|---|---|---|---|---|
| **P-20** | 右上「72%」假环 | `MainHeader.tsx:71-82` `UsageRingPlaceholder` 硬编码 `<span>72%</span>` | — | 🔵 **T-23 已在队**（执行计划 `:115` 明列"二选一：改环语义 / 撤环，禁止保留百分比外壳塞成本数字"）。本轮**只标注** | — |
| **P-21** | `Browser`(`:58`) / `Window`(`:65`) 两个图标按钮无 `onClick` | `MainHeader.tsx:58,65` | — | 🔵 **T-23 已在队**（死按钮清单）。注：T-27 已删掉 Folder / Host:Local 两个 | — |
| **P-22** | 顶栏双行 `h-14`，第二行是 `ai-client · Main · /home/dan/projects/ai-client` 完整绝对路径 | `MainHeader.tsx:33` `h-14`；`:38-42` 三段拼接含 `activeWorkspace.path` | T-27 落地后，**分支与运行位置已经在底部 Composer 目标栏常驻**，顶栏第二行是纯重复。建议：删第二行 → 单行 `h-12`；路径只留 `title` 悬浮。Cursor 参照图顶栏就是单行标题 | 🟢 纯打磨（A07 未定义顶栏，属基线空白） | S |
| **P-23** | 顶栏 4 个图标 + 1 个圆环 + 1 条竖分隔线共 6 个元素挤右侧，与左侧双行文字不成配平 | `MainHeader.tsx:45-66` | 待 T-23 消化死按钮后自然减到 2 个；本项**依赖 T-23，不单独施工** | 🔵 随 T-23 | — |

### E 组 · 侧栏（对应初判 ⑤）

| ID | 现象 | 根因 | 修法提案 | 归属 | 量级 |
|---|---|---|---|---|---|
| **P-24** | 会话行标题被砍到 `Session 42…`（约 11 字符），同一行的分支 chip `feat/openchamber…` 也被砍 —— **一行两处截断** | 三段争位：`LeftNav.tsx:556` 标题 `flex-1 min-w-0` + `:562-566` chip `max-w-28`(112px) `shrink-0` + `:571` 时间。280px 侧栏减去 chip 112 + 时间 24 + 内距间距 ≈ 剩 **112px 给标题**；等宽 14px 单字 advance ≈ 8.4px → **13 字符封顶** | A07 `:1346` 把 chip 封顶 112px 称为"关键取舍：标题永远拿大头"——**实测标题并没有拿到大头**。三选一：① chip 封顶收到 88px（`--w-side`×31%）；② chip 仅 hover 显示；③ chip 移到第二行（行高 28→40） | 🟠 **A07 修订**（`:1346` 是明文数值裁定） | S~M |
| **P-25** | 会话默认标题 `Session 420745`，前 8 个字符是零信息量的 `Session `，截断后信息量归零 | 会话标题生成策略（非本目录） | 用首条用户消息前 N 字做标题（Cursor 参照图侧栏全是语义标题：`Session refactor options` / `Right sidebar design review`）。这是**最高性价比的一条**——不改任何视觉值，纯靠内容改善观感 | 🟢 纯打磨（基线空白） | M |
| **P-26** | 侧栏顶部 `+ new` / `add repository` 两个描边按钮 + `Search sessions` 描边输入框堆三行边框 | `LeftNav.tsx:204-256` | Cursor 参照图对应位置是**无边框菜单项列表**（New Agent / Search / Automations / Customize），零边框。建议描边按钮改 ghost、搜索框改无边框只留 `--muted` 底 | 🟢 纯打磨（基线空白） | M |
| **P-27** | 段头 `Recent` / `Repositories` 用 **12px** muted，会话行 14px —— 段头比内容还小，读不出分段 | `LeftNav.tsx:277` 与 `:331` 均为 `text-xs font-medium text-muted-foreground` | **这是对 A07 `:1339` 的明文违反**——A07 给段头的裁定值是 **14px + muted + `letter-spacing: 0.04em`**，并标注为「关键取舍：Recents / Repos / Recent 段头**不缩字号**」。修法即照 A07 落值：`text-sm` + `tracking-[0.04em]` + muted，字号**不动**、层级交给字距 | 🟢 纯打磨（**回归 A07 `:1339`**） | S |

### F 组 · 输入区（对应"输入框外观"）

| ID | 现象 | 根因 | 修法提案 | 归属 | 量级 |
|---|---|---|---|---|---|
| **P-28** | 会话态 Composer 是 12px 圆角矩形；Cursor 参照是**全圆角胶囊** | `middleColumnLayout.ts:105` `rounded-md`（= `--radius-md` 12px），与 A07 `.cmp`（`:786-793` `border-radius: var(--r-md)`，`:444` = 12px）**完全一致** | 若要胶囊：40px 高 → `rounded-full`。**代价**：A07 空态卡是多行大卡（`:96-98` 有 `min-h-14` 文本域），胶囊只适用会话态，两态形状会分家 | 🟠 **A07 修订** | S |
| **P-29** | 40px 单行里挤了：输入区 + 状态行 + `Sonnet ⌄` + `Medium ⌄` + 橙色圆形发送键，右侧 5 个元素 | `middleColumnLayout.ts:105` + `ChatComposer.tsx:1030-1035` | Cursor 参照同位置只有 `Kimi K3 Max ⌄` + 麦克风两个。建议 Effort 选择器收进 model 下拉的二级分组 | 🟠 A07 修订（A07 屏⑥ 定义了三控件并排） | M |
| **P-30** | **全屏唯一饱和色块是发送键**（`--primary` 橙实心 28px 圆）——最强视觉权重给了控件而非内容，这是"重点突出"抱怨的结构性倒挂 | A07 `:823-832` `.send` + `:2838`「维持基线现状——28px 圆形 `--primary` 实心」 | 三选一：① 维持（A07 已裁定）；② 静默态改 ghost/outline，仅在可发送时才实心；③ 把品牌橙让给内容（如 assistant 正文的行内链接/强调），发送键降为中性。**Cursor 参照图里没有任何饱和色按钮** | 🟠 **A07 修订**（`:2838` 明文"维持基线现状"） | S |
| **P-31** | Composer 边框用 `--input`（1.57:1）比 `--border`（1.40:1）重——是中列最强的一条边 | `middleColumnLayout.ts:98,105` `border-input` | **无需改动，已合规**。A07 `:788-790` 注释明写这是刻意的（"Cursor 那张卡浮起的观感来源，我们用边框实现而不是加阴影"）。列出仅为避免后续误改 | ✅ 合规 | — |

### G 组 · 返回内容渲染（对应"返回内容渲染"，用户点名）

| ID | 现象 | 根因 | 修法提案 | 归属 | 量级 |
|---|---|---|---|---|---|
| **P-32** | Assistant 正文是**纯文本**：列表、标题、粗体、行内 code、围栏代码块、表格、链接全部退化成裸字符 | `MessageTimeline.tsx:466-473` `<p className="whitespace-pre-wrap">{item.block.text}</p>` | 见 **专题 c** | 🟢 纯打磨（**账实不符**：ARD `:215` 已把「新建 Session + 发送 + 流式文本 + **Markdown**」记为 ✅ 交付） | L |
| **P-33** | 对照 Cursor 参照图：项目符号列表、加粗小标题、`code` 灰底 chip、文件名蓝色等宽链接、`2 Files Changed` diff 卡 —— **全部结构化排版都缺席**。这是"一团乱麻"最直接的贡献者 | 同上 | 同上 | 🟢 随 P-32 | — |
| **P-34** | 回合末尾无操作行；Cursor 有 👍 / 👎 / 分支 / copy 四键悬浮 | 未实现 | 至少补 **copy**（复制整回合 markdown 原文）。基线未定义 | 🟢 纯打磨（基线空白） | M |

---

## 2. 专题 a · 错误视觉权重收敛方案

### a.1 事实校正

初判①认为"输出体正文整块红"。**实测证伪**：

| 取样区域 | 主色 | 对应 token |
|---|---|---|
| `Explored 2 files` 行头 | `#D14D41` | `--destructive`（暗色） |
| `Tool permission request failed…` 输出体 | `#807E79` | `--muted-foreground`（暗色） |
| `File does not exist…` 输出体 | `#807E79` | `--muted-foreground` |

代码侧一致：`ToolRows.tsx:199-212` 的 `<pre>` 挂的是 `text-muted-foreground`，A07 `.fx-out`（`:958-965`）也是 `color: var(--muted-foreground)`。**输出体本来就合规。**

### a.2 真实成因：三重叠加

```
① 单条失败行 = 动词 destructive + 参数 destructive/70   （A07 :2528 明文裁定）
        ×
② 聚合行被任一子调用传染                                  （toolCard.ts:360，A07 未定义）
        ×
③ 每条失败行自动展开，把红行头拉成 3 段分散重复            （ToolRows.tsx:77，A07 :2432 明文裁定）
        ↓
   权限流一断 → 该回合每个工具调用全失败 → 满屏红
```

补一个刺激因素：`--destructive` 亮色 **6.29:1** 比 `--muted-foreground` **5.62:1** **还高**。也就是说在 Flexoki 亮色下，红色文本在感知上比"正常"文本更重——A07 的 mock 里只出现过**一条**失败行（`:2448`），从未压测过失败簇。

### a.3 三级方案（可分别拍板，可叠加）

| 级别 | 方案 | 红字符量变化 | 归属 | 量级 |
|---|---|---|---|---|
| **L1 · 最小** | 只做 **P-04**（输出体补 `.ok/.bad/.num` 局部高亮）+ **P-05**（alpha 修正）。不动 A07 任何裁定 | 不变 | 🟢 | M |
| **L2 · 推荐** | L1 + **P-01**（参数从 `destructive/70` 回落 `--tool-arg`）+ **P-02**（聚合行不转红） | 三行簇 **~130 → ~18** 个红字符（-86%） | 🟠 修订 A07 `:2528` | S |
| **L3 · 彻底** | L2 + **P-03**（失败簇只自动展开首条）+ **P-07**（新增"中断"档，不进 destructive） | 同 L2，但视觉密度进一步降低 | 🟠 修订 A07 `:2432` + 新增状态档 | M |

### a.4 硬约束（施工时勿踩）

- ❌ **不要用 `--warning`**：`globals.css:130` 亮色 `--warning` 与 `--primary` **逐字同值**（都是品牌橙 `#BC5215`）。任何"降级到 warning"的想法都会与发送键撞色。
- ✅ 若要第二档状态色，只能走 `--muted-foreground` + 文案区分（`Interrupted` / `Cancelled`），或新引 token（需 D18 连带评估）。

---

## 3. 专题 b · 排版层级方案（全等宽体系内）

> 前提：D18「全等宽」是用户拍板，本节**先给不动 D18 的方案**；D18 是否复议见 §5。

### b.1 六条杠杆（按性价比排序）

| # | 杠杆 | 具体值 | 覆盖 ID | 量级 |
|---|---|---|---|---|
| **1** | **字号收敛到四档** | `@theme` 补 `--text-ui: 0.875rem`(14)；全量迁移后只保留 **10 / 13 / 14 / 15**（`text-2xs` / `text-code` / `text-ui` / `text-markdown`）。禁用 `text-xs`(12) `text-[10px]` `text-[11px]` `text-base` | P-12 P-27 | M |
| **2** | **灰阶重标定** | 三级灰目标对比度 **18.78 / 5.62 / 3.4**：只改 `globals.css:149` 的 62% → **78%** | P-15 | S |
| **3** | **重新分配 foreground** | 四处强制 `--foreground`：assistant 正文 · user 气泡正文 · 侧栏会话标题 · Composer 输入文本。其余全部 muted | P-16 | M |
| **4** | **间距三档** | 块内 **4** / 段间 **10** / 回合间 **20**（全部 4 的倍数）；消除 `my-2.5` 与 `space-y-5` 的叠加 | P-17 | S |
| **5** | **收窄阅读栏** | 等宽 15px 在 768px 下 = **85 字符/行**，超出 45~75 舒适区上限。建议正文栏 `min(100%, 42rem)`(672px ≈ 74 字符)，或正文降到 14px（= 85→91，反向，不可取） | 新增 | S |
| **6** | **启用 letter-spacing**（**最被低估的一条**） | 全域现只用了 1 次。按 `design-system.md:347` 的既有梯度落地：段头 `+0.04em`（A07 `:1339` 已给死值）、回合小标题 `+0.01em`、正文 `0`、大标题 `-0.015em`。**等宽字体下字距是少数仍然有效的层级手段**——它不受字重回退链影响，也不改变纵向节拍 | P-27 + 新增 | S |

### b.2 字重这条路在 D18 下**部分失效**（重要）

`globals.css:55-57` 的字体栈是 `ui-monospace, SFMono-Regular, Menlo, Cascadia Mono, Segoe UI Mono, monospace`。这条回退链上的多数系统等宽字体**只提供 Regular 与 Bold 两档**，没有 Medium(500) / Semibold(600)。也就是说：

- `font-medium`(500) 在多数平台会被**四舍五入回 Regular**（无视觉变化）或**合成加粗**（渲染毛糙）。
- 于是 §0.2 ② 统计到的"12 处 `font-medium`"里，相当一部分**根本没起作用**——这解释了为什么现状看起来"字重完全缺席"。
- 结论：**在 D18 下，字重只有 400/700 两档可用**，中间档不可靠。

于是设计系统规定的层级三件套（`design-system.md:341-347` weight × letter-spacing × color）在 D18 下**塌成两件**：letter-spacing + color。而 letter-spacing 恰恰是全域用了 **1 次**的那一维（§0.2）。**"一团乱麻"= 用一个维度扛三个维度的活。**

可用维度重排后：字号(4档) × **字距(4档)** × 灰阶(3档) × 间距(3档)，字重仅在 400/700 两端使用。

这也是 §5 D18 复议的核心论据之一（E4）。

### b.3 不动 D18 能达到的上限

做完 b.1 六条，可以拿到**整齐**（节奏一致、对比度达标、层级可辨）。但拿不到 Cursor 参照图那种**协调**——因为 Cursor 的层级有相当一部分来自"比例字体正文 + 等宽代码"的**质感对比**，等宽体系内没有这个维度。这个上限需要向用户明说。

---

## 4. 专题 c · Markdown 渲染立项建议

### c.1 关键事实：这不是选型题，是复用题

| 事实 | 证据 |
|---|---|
| `react-markdown@^10.1.0` / `remark-gfm@^4` / `remark-breaks@^4` / `rehype-raw@^7` / `shiki@^3.20` **已在 `dependencies`** | `package.json:76-81` |
| 仓内已有**两处**成熟用法 | `files/MarkdownPreview.tsx:208-217`（`remarkGfm + remarkBreaks + components` 映射 + `CodeBlock` + `MermaidRenderer`）；`source-control/CodeReviewModal.tsx:371-376` |
| `rehype-raw` 在 `src/renderer` 下**零引用** | 全目录 grep 无命中 |
| 需求是**已承诺未交付**，非新增 | ARD `:215`「新建 Session + 发送 + 流式文本 + **Markdown**」标 ✅；执行计划 `:248` F3 反馈「回复没条理、看着懵」的指定解法就是「气泡化 + **markdown 渲染** + 卡片折叠」 |

→ **应立为"补交付"任务，不是新功能**。

### c.2 两案

#### 方案一（推荐）· 复用 react-markdown，chat 独立 components 映射

新建 `components/chat/ChatMarkdown.tsx`：

- `remarkPlugins={[remarkGfm, remarkBreaks]}`，**不引 rehype-raw**。
- **自建** components 映射，**不复用** `MarkdownPreview` 的映射——那套带 `toLocalFileBaseUrl` / 相对路径图片解析，是给本地文件预览设计的，对 LLM 输出等于把攻击面直接接上。
- 映射到既有 Flexoki token：`code` → `--muted` 底 + `--text-code`；`pre` → 复用 tool-row 的左竖线形态（`ToolRows.tsx:202` `border-l border-border pl-3.5`），视觉与工具输出体同源；`a` → `--primary` + hover 下划线（与 `ToolRows.tsx:119` 的静默链接同款）。

**安全清单（Electron renderer，`contextIsolation: true` / `nodeIntegration: false`，`MainWindow.ts:151-154`）**

| 面 | 处置 |
|---|---|
| 原始 HTML | react-markdown v10 默认转义。**不加 rehype-raw**，并在 lint 层加禁止导入规则 |
| 链接 | 只放行 `http`/`https`；走 `shell.openExternal`，禁止 `file:`/`javascript:`/自定义 scheme 在渲染进程内跳转 |
| 图片 | **一期直接不渲染远程图片**（`img` 映射成文件名占位）。理由：模型输出的 `![](https://attacker/x.png)` 会变成外部信标，泄漏"用户何时读到这条消息" |
| 表格/HTML 实体 | remark-gfm 处理，无额外面 |

**流式策略**（这是本案真正的难点，不是渲染本身）

react-markdown 每次 delta 全量重解析 AST。建议：**流式期纯文本，落定后渲染**——

- 最后一个 text block 且 `isActiveTurn` 为真时，走现有 `<p whitespace-pre-wrap>` 路径；
- `message.completed` 后切 `<ChatMarkdown>`；
- 其余（历史块 / 非末块）直接 markdown。

这与 ARD `:298`「Markdown 完成前轻量增量」的既有口径一致，且避免了"半个围栏代码块被解析成一坨"的抖动。

**量级：L（≈2d）** — 组件 + 映射 + 流式切换纯函数 + 断言（哪些节点渲染成什么 / 危险 scheme 被拦 / 流式期不进 markdown 路径）。

#### 方案二（更轻）· 最小子集自绘

只支持：围栏代码块、行内 code、无序/有序列表、粗体、链接。纯函数解析 → React 元素，**零新增运行时依赖、零 XSS 面**（不产 HTML 只产元素）。

**量级：M（≈1d）**。
**风险**：表格 / 嵌套列表 / 引用 / 标题不支持；需求一定会追加，届时整套重写、测试资产不可迁移。

### c.3 建议

**直接走方案一。** 理由：依赖已在树内，边际成本集中在 components 映射与流式策略两块——而这两块**方案二一样要做**，且方案二的解析器最终必被丢弃。方案二只在"必须本周内出效果"时才值得。

---

## 5. D18 复议项（全等宽字体）

> 结论先行：**建议复议，且建议只改"字体"一条，Flexoki 颜色与卡片形态不动。**

### 5.1 D18 原文与其立论结构

ARD `:41`：

> **D18 | 视觉（撤销 D6）| 对齐 OpenChamber 观感 = Flexoki 主题 + 全等宽字体 + 卡片形态一并对齐。**主题 Flexoki Light/Dark（…）；新增 `--accent-primary` / `--selection` / `--hover` / `--status-running`；**sans/mono/heading 统一 `ui-monospace`**。依据：现有语义 token 的中性与品牌梯度锁在色相 285.82、缺品牌强调色（…）

**关键观察**：D18 的**依据段落全部是颜色论证**（色相 285.82 / 缺品牌强调色 / 状态三色亮暗同值）。字体条款是「照抄 OpenChamber `flexoki-*.json` 的 `config.fonts`（上游 sans/mono/heading 逐字节相同）」的**连带结果**，在 ARD 里**没有任何独立论证**。`globals.css:48-54` 的注释也是这么写的。

→ 拆出字体一条**不动摇 D18 的论证基础**。

### 5.2 五条证据

| # | 证据 | 出处 |
|---|---|---|
| **E1** | 用户指定的目标态（Cursor 参照图）正文是**比例字体**；等宽只用于内联 code 与文件名链接（图中 `manual` / `WorkspaceShell.tsx` 是等宽，`Finished Static server for final doc verification` 与整个侧栏是比例）。**目标态与 D18 字体条款直接冲突** | `cursor-参照-协调布局.png` |
| **E2** | 风险**早已注册且至今未结**：open-q **#10「全等宽字体的中英混排风险」**（2026-07-28 立，D18 连带）——等宽拉丁 + 系统回退的非等宽 CJK 混排，行内宽度节奏 / 基线 / 标点对齐都可能崩。同条还记录了 `lowercase` 与中英混排叠加需 6 处 `normal-case` 豁免 | `docs/plantree/plans/openchamber-chat-refactor/open-questions.md:13-24` |
| **E3** | **侧栏可读字符数量化损失**：280px 侧栏，chip 封顶 112px + 时间 24px + 内距间距后，标题实得 ≈112px。等宽 14px 单字 advance ≈ 8.4px → **13 字符**；比例字体小写平均 advance ≈ 7px → **16 字符（+23%）**。截图里 `Session 420745` 被砍成 `Session 42…` 即此 | 见 P-24 |
| **E4** | **字重层级在 D18 下部分失效**：`ui-monospace` 回退链上多数系统等宽只有 Regular/Bold 两档，`font-medium`(500) 不可靠（见 §b.2）。这直接掐掉"用字重拉层级"这条最标准的排版手段——而用户抱怨的正是"重点不突出" | `globals.css:55-57` |
| **E5** | **行长超舒适区**：等宽 15px 在 48rem(768px) 阅读栏 = **85 字符/行**，超出 45~75 上限。⚠️ 换比例字体会让行**更长**（≈102 字符），所以正确组合是「比例字体 **+** 收窄栏宽」，不是简单替换——这点必须写进复议提案，否则换完更糟 | 实算 |

### 5.3 三种口径供用户裁

| 口径 | 内容 | 连带修订 | 量级 | 能达到的观感上限 |
|---|---|---|---|---|
| **① 维持 D18** | 全等宽不动。只做专题 b 的五条杠杆 | 无 | M | **整齐**，但拿不到 Cursor 的"协调"。E2 的中英混排风险继续挂账 |
| **② 分域字体（推荐）** | `--font-sans` 改比例（`system-ui, "Segoe UI", …` 或引 Inter）；`--font-mono` 保持等宽，专供：围栏/行内代码、文件路径、分支名、时间戳、tool 行参数、hash。**Flexoki 颜色与卡片形态一字不动** | A01 / A07 / `design-system.md` **三处基线连带修订**，具体锚点：A01 `:884`「字体：全等宽 ui-monospace」与 `:1050` 演示页眉、A07 `:1209` `:1272` `:2782`（`:2782` 把它记为 D18③ 的偏离项）、A07 `:1339`（段头字距值可留）、A07 `:2839`（发送键"等宽下 Send 占位偏宽"的论据会失效，但结论 `:2838` 不受影响）；代码侧约 30~50 处补 `font-mono`；同时按 E5 收窄阅读栏到 42rem | **L** | 与 Cursor 参照同构。这正是 Cursor 的做法，也是 A07 内部已经在用 `.mono` class 标注代码类文本的做法 |
| **③ 仅 CJK 例外** | 保持拉丁等宽，给 CJK 指定比例中文字体（结掉 open-q #10 的最小解） | `globals.css` 字体栈 + open-q #10 结项 | S | 解决混排崩，但不解决 E3/E4/E5。**中西文风格分裂的观感风险反而可能更高** |

### 5.4 建议的登记方式

**不要新立一条 D25**。建议作为 **open-q #10 的结项 + 范围升级** 落库：#10 原本只问"要不要给 CJK 开例外"，本审计把它升级为"全等宽这条本身是否该拆"。这样台账链路干净，D18 只需追加一条"字体条款的修订记录"，颜色与卡片形态条款保持已验收状态。

---

## 6. 建议批次

> 前提：用户全采纳。批次按「量级 × 是否需要基线修订」切。

### 批次 1 · 快赢（S 为主，**零基线修订**，≈1d）

无需用户再拍板任何视觉决策，全部是回归基线或补 bug。

| ID | 项 |
|---|---|
| P-08 | 删 `USER` 大写角标（回归 A01/A07） |
| P-09 | user 气泡外形回归 A07（16/16/4/16 圆角 + 10·16 内距 + `--card` + primary-8% 边） |
| P-14 | 修 meta 行丢 model 名（真 bug） |
| P-15 | `--tool-arg` 62% → 78%（对比度 2.68 → 3.4） |
| P-05 | `destructive/70` alpha → `color-mix` |
| P-17 | 间距收敛 4/10/20 |
| P-19 | 顶栏标题字号倒挂 |
| P-22 | 顶栏改单行，删重复的绝对路径行 |
| P-11 | system/error 改用 `Alert` 原语 |
| P-06 | 会话失败框正文回落 muted |
| P-27 | 侧栏段头回归 A07 `:1339`（14px + `tracking-[0.04em]`，**不缩字号**） |
| b.1-⑥ | 顺手把 letter-spacing 梯度接上（段头 `+0.04em` / 回合小标题 `+0.01em`），全域从 1 处提到 ~6 处 |

**做完的可见效果**：气泡干净、meta 行完整、路径可读、顶栏不吵、分段读得出来。红仍在（P-01/02/03 属批次 2）。

### 批次 2 · 结构性打磨（M，需 **4 条必选基线修订 + 3 条可选**，≈3d）

需要用户逐条拍板 🟠 项后开工。

| 分组 | ID | 需要的基线修订 |
|---|---|---|
| 错误权重（专题 a L2/L3） | P-01 P-02 P-03 P-07 | A07 `:2528` 失败行整行红 → 分级；A07 `:2432` 失败自动展开 → 加簇规则 |
| 排版层级（专题 b） | P-12 P-13 P-16 + b.1 六条杠杆余下部分 | 无（回归 A07 三档 + `design-system.md:341-347` 既有梯度） |
| 输出体高亮 | P-04 | 无（补齐 A07 `:966-968`） |
| 侧栏 | P-24 P-25 | A07 `:1346` chip 封顶 112px → 88px 或 hover 显（P-26 无需修订；P-27 已提到批次 1） |
| user 气泡满宽 | P-10 | A01 `:420-421` + A07 `:848-849` 右对齐 85% → 满宽 |
| 输入区（可选） | P-28 P-29 P-30 | A07 `:786-793` 圆角 / 屏⑥ 三控件 / `:2838` 发送键 |

**做完的可见效果**：红收敛 86%、层级立起来、侧栏标题可读、气泡不再锯齿。

### 批次 3 · 立项级（L，≈2~4d，需单独立任务号）

| 项 | 内容 | 前置 |
|---|---|---|
| **T-新① Markdown 渲染** | 专题 c 方案一 | 无（依赖已在树内）。**这是"返回内容渲染"抱怨的唯一实质解法** |
| **T-新② 会话标题语义化** | P-25，首条消息摘要做标题 | 无 |
| **T-新③ 回合操作行** | P-34，至少 copy | 建议并入 T-新① |
| **D18 复议落地** | §5 口径②：字体分域 + 阅读栏收窄 | **用户先裁 D18**；裁定后 A01/A07/design-system.md 三处连带修订 |

### 并轨说明

- **P-20 / P-21 / P-23 归 T-23**（假 usage 环 + 死按钮），本轮三批**都不碰**，避免与 T-23 抢文件。
- 批次 2 与 T-23 都改 `MainHeader.tsx` → 建议 **批次 1 的 P-22 先落**，T-23 后做，或反之串行，勿并行。
- **D18 复议应在批次 2 开工前裁定**：若裁定改字体，专题 b 的字号档位与阅读栏宽度取值会跟着变，先做会返工。

---

## 附录 · 本审计推翻/修正的三条编排者初判

| 初判 | 审计结论 |
|---|---|
| ① 「错误输出**正文**整块红，输出体正文应 muted+局部高亮」 | **半错**。逐像素取色证明输出体正文本就是 `--muted-foreground`（`#807E79`），与 A07 `.fx-out` 一致。真正的成因是**行头红 × 聚合传染 × 自动展开**三重叠加（P-01/02/03）。初判想要的"局部高亮"确实缺（P-04），但那是 A07 已定义未落地，不是"权重过猛" |
| ② 「USER 气泡带大写标签…改它要列为『A01 修订项』」 | **错**。`phase0a:1060-1061` 与 `a07:1721-1722` 的 markup **都没有 role 标签**。删它是**回归基线**（🟢 纯打磨），不需要用户为此拍板。真正需要 A01 修订的是"右对齐 85% → 满宽"（P-10） |
| ③ 「meta 行疑丢 model 名——查 `formatMessageMetadata` `omitLatency` 后的实际输出」 | **对，且已定位到根因链**。不是 `omitLatency` 的锅（它只砍 latency 段）。是 `ModelSelect.tsx:56` 只在 `onValueChange` 时落盘，默认值从不写 → `useMessageMetadata.ts:38` 拿到 `null` → `messageMetadata.ts:141` 跳过 model 段（P-14） |
