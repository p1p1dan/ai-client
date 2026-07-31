# D25 分域字体 · 施工规格（T-30 批次 2 · 字体部分）

> 设计者：deep-reasoner · 2026-07-30 · 仓库 HEAD `9a3fd86` · **只设计不改码**
> 上位决策：**D26/D25 已拍板** —— UI 域改比例字体（`--font-sans`），等宽（`--font-mono`）只保留给代码/路径/分支/终端；Flexoki 调色板与卡片形态一字不动。
> 用户目标原话：「我希望能做到 Cursor 那种协调的美感」。
> 输入：`docs/design/polish-audit-20260730.md`（E1~E5 + §b.2 + P-12/15/16/24/27）· `src/renderer/styles/globals.css:42-57` · `docs/design-system.md:325-509` · `docs/design/a07-cursor-composer-alignment.html` · `docs/design/phase0a-openchamber-alignment.html` · `docs/design/refs/feedback-20260730/cursor-参照-协调布局.png`

---

## 0. 参照图实测（本规格全部数值的锚点）

参照图不是"看着像"，是量出来的。标定方法：Windows 11 窗口控制按钮 CSS 规格恒为 46×32px，图中三键中心间距实测 ≈68 图像 px → **DPR = 1.5**（Windows 150% 缩放）。以此换算：

| 实测项 | 图像 px | CSS px | 结论 |
|---|---|---|---|
| 阅读栏内容宽（assistant 段落 x 跨度） | ≈1090 | **≈727** | ≈45rem |
| user 气泡文本宽 | ≈1030 | ≈687 | 同上量级 |
| 正文行内容量（两行独立取样） | — | — | **≈48 CJK 当量/行** |
| 反推正文字号（727 ÷ 52em） | — | **≈14.0px** | Cursor 正文在 **14px** 档 |
| 侧栏总宽 | 383 | ≈255 | 比我们的 280px 还窄 |

两条独立取样（user 气泡首行 52 em、assistant 段落 52 em）互相印证到 14.0/14.3px，可信。

**关键换算**：Cursor = 14px × 48 字/行。我们正文是 15px。**同样 48 字/行在 15px 下 = 720px = 45rem**。
→ 不必把正文缩到 14px；把阅读栏从 48rem 收到 **45rem**，就能拿到与 Cursor 逐字相同的行内节奏，而字号更大更好读。**这是本规格对审计 E5「收窄到 42rem」的修正**（42rem = 44.8 字/行，比参照窄了 3 字）。

**字族分布实测**（逐元素目视）：

| 元素 | Cursor 用 |
|---|---|
| 行内标识符 `WorkspaceShell.tsx` / `RightDock.tsx` / `MainHeader.tsx` / `manual` | **mono** + `--muted` 底 chip，`.tsx` 那组还带链接色 |
| 正文散文里的 `session store / keymap` | 比例（**没进 chip 就不是 mono**） |
| Files Changed 卡里的 `a08-final-context-panel-baseline.html` / `check-final.js` | **比例** |
| 底栏分支 `feat/openchamber-chat-refactor` | **比例** |
| 运行位置 `This PC` | 比例 |
| 模型 `Kimi K3 Max` | 比例 |
| 侧栏会话标题 / 左导航项 / `50m 3h 16h 6d 7d` | 比例 |
| `+10279` / `+139 −148` / `+51` | 比例（着色，非等宽） |
| 工具行摘要 `Finished Static server for final doc verification` | 比例 |
| Composer 占位符 `Send follow-up` | 比例 |

→ **Cursor 的规则是「内容 vs 控件」，不是「是不是标识符」**。同一个字符串 `WorkspaceShell.tsx`，出现在正文里是 mono，出现在文件卡/下拉按钮上是比例。这条是整份规格的骨架，见 §2.0。

---

## 1. 决策一 · 比例字体栈选型

### 1.1 结论

**系统栈。不随包任何 webfont（Latin 与 CJK 都不随包）。亮暗同一串。**

### 1.2 五条理由（按权重）

1. **CJK 是决定性因素，而 CJK 随包在本项目不可行。**
   用户中文重度使用。Noto Sans SC 即使做 woff2 子集化，覆盖常用 3500 字也在 **1.5~3MB**，全量 GB18030 覆盖 8~12MB；而 Latin 侧的 Inter variable 只有 ~250KB。也就是说"随包"要么只随 Latin（CJK 仍回落系统 → 一半一致性），要么吞下 MB 级 CJK 资产。
2. **半随包比全系统更难看，不是更好看。**
   Apple 的 SF Pro↔PingFang SC、Microsoft 的 Segoe UI↔Microsoft YaHei UI 是**厂商成对设计**的：x-height、字重感知、基线、标点位置都对过。把 Inter 塞进去配系统 CJK，等于把两个互不认识的字体强行混排——正是用户抱怨的"不协调"的另一种形态。用户 CJK 重度使用 ⇒ **这条压倒"跨平台一致性"**。
3. **C-15 先例口径：随包资产在本项目是敏感项，且当前处于未决状态。**
   `docs/plantree/plans/openchamber-chat-refactor/open-questions.md:5`：C-15 随包 node.exe 使 portable 120MB→141MB（+21MB）**至今未拍板**，回退方案写的是"随包改可选"。在一条 +21MB 尚未被接受的开放问题之上，再压一份 MB 级字体资产，是把两个未决叠在一起。**T-11 加密机场景**（同文件 :12，TSD 白名单按进程名，实证未做）对分发物形态尤其敏感——多一类资产就多一条需要现场实证的路径。
4. **仓内零字体基建，且现有规范明文禁止"空头支票字体"。**
   实测：全仓 `@font-face` **0 处**、`.woff/.woff2/.ttf/.otf` 资产 **0 个**、`package.json` 字体依赖 **0 个**。`docs/design-system.md:457-460` 已把这条写成红线：「仓内没有 `@font-face`、没有 woff/ttf 资源，所以任何非系统字体（Inter / JetBrains Mono）写进栈里都是空头支票」。随包 = 新建一整套资产/打包/许可证链路，属独立立项，不该塞进 T-30。
5. **参照物本身就是系统栈。** Cursor 基于 VS Code，UI 字体是 `-apple-system` / `Segoe UI` / `system-ui` 系统栈。参照图 Windows 侧的拉丁质感与 Segoe UI 一致。追系统栈就是追参照。

### 1.3 精确 font-family 串（`globals.css` `@theme`，替换现 `:55-57`）

```css
  /*
   * D25 · Split font domains (supersedes D18 clause 3's all-mono stack).
   * UI is proportional; --font-mono is reserved for code / terminal / in-content
   * identifiers (see docs/design-system.md "字体族（分域）").
   *
   * Ordering rules baked into these two stacks:
   *  1. Latin faces first, CJK faces after. Font matching is per-character:
   *     Latin resolves on the first family that has the glyph, CJK falls
   *     through to the first CJK family. Reversing this renders Latin in a
   *     CJK face (the classic "Chinese-locale ugly Latin" bug).
   *  2. Deliberately NO `system-ui`. On Chromium/Windows it resolves through
   *     the *system locale*, so a zh-CN machine renders Latin in a CJK face --
   *     the exact failure rule 1 exists to prevent.
   *  3. Colour-emoji families sit BEFORE the generic terminator. Anything
   *     after `sans-serif` / `monospace` is unreachable.
   *  4. No bundled webfont: this repo has no @font-face and no font assets;
   *     naming a non-system family here is a blank cheque (design-system red
   *     line), and a bundled Latin face paired with a system CJK face reads
   *     worse than the OS's own co-designed pair.
   */
  --font-sans:
    -apple-system, BlinkMacSystemFont,
    "Segoe UI Variable Text", "Segoe UI",
    "Ubuntu", "Cantarell", "Noto Sans", "Liberation Sans", Arial,
    "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei UI", "Microsoft YaHei",
    "Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans SC", "WenQuanYi Micro Hei",
    "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji",
    sans-serif;

  --font-mono:
    ui-monospace, "SF Mono", "SFMono-Regular", "Menlo",
    "Cascadia Mono", "Consolas", "Liberation Mono", "DejaVu Sans Mono",
    "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC",
    "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji",
    monospace;

  --font-heading: var(--font-sans);
```

**逐段依据**

| 段 | 覆盖平台 | 说明 |
|---|---|---|
| `-apple-system, BlinkMacSystemFont` | macOS | → SF Pro。**真 400/500/600/700**，是本栈字重最健康的一端 |
| `"Segoe UI Variable Text"` | Win11 | 可变字体，wght 轴连续 → **500 是真的**。`Text` 是 12~28px 的光学尺寸档，正对我们 13/14/15 |
| `"Segoe UI"` | Win10 | 静态族（300/350/400/600/700，**无 500**），见 §3.2 字重矩阵 |
| `Ubuntu / Cantarell / Noto Sans / Liberation Sans / Arial` | Linux（开发机） | 与 VS Code Linux 默认同族系 |
| CJK 段 | 全平台 | macOS→PingFang SC；Win→Microsoft YaHei UI；Linux→Noto Sans CJK SC。**`Microsoft YaHei UI` 必须在 `Microsoft YaHei` 之前**（UI 版是为界面调过的 hinting 版） |
| emoji 段 | 全平台 | 放在 `sans-serif` **之前**，否则永不可达 |

**mono 栈的两处修订**（相对现状 `:55-56`）：
- 补 **`Consolas`**：现 globals.css 栈里没有，但 A07 原型 `:41` 与 phase0a `:39` 的 `--mono` 都有。这是**基线与代码的既存漂移**，本次顺手对齐。Win10 无 Cascadia Mono 时 Consolas 是唯一可用项。
- 补 **CJK 段**：代码块/工具输出里出现中文注释或中文路径时，不落到随机字体。

**变更行数：`globals.css` 3 行 token → 约 30 行（含注释）。这是整个 D25 唯一的字族改动点。**

### 1.4 明确不做

- ❌ 不写 `system-ui`（理由见注释 2）。
- ❌ 不写 `Inter`、不写 `JetBrains Mono` 等未随包字体（design-system :457-460 红线）。
  ⚠️ 附带提醒：`src/renderer/stores/settings/index.ts:112` 有历史死字段 `fontFamily: 'Inter'`（有 setter、零消费方，T-21 刻意未接线）。**D25 不接线、不改默认值**；将来若接，必须同步改成本节的比例栈字面量，否则复活 T-21 刚消灭的字体注入 bug。
- ❌ 不设 `-webkit-font-smoothing: antialiased`。它只在 macOS 生效、会让 400 视觉变细，而本项目是 Windows 优先、且审计 §0.2① 已实测三级灰最浅档只有 2.68:1（P-15 修到 3.4:1 仍是勉强）——再抽细笔画会把刚修好的对比度吃回去。
- ✅ 建议设 `font-synthesis-weight: none`（`@layer base` 的 `html`）。作用：任何平台缺档时走 CSS 字重匹配（600 缺 → 升到 700 Bold），而不是渲染合成加粗的毛糙字。对本栈的 sans 侧零代价（600 处处为真），对 mono 侧是保护（mono 族普遍只有 400/700）。

---

## 2. 决策二 · mono 保留域清单（域 → 字体映射表）

### 2.0 判据：**「内容 / 控件」二分法**（copy-target 测试）

> **同一个字符串，出现在内容里用 mono，出现在控件上用 sans。**
> 判据一句话：**用户会不会去逐字符读它、比对它、复制它？**——会 ⇒ mono；只是拿它当一个"名字"点一下 ⇒ sans。

这条与已拍板口径的关系必须说清：

- 用户拍板的 **「等宽只保留给代码/路径/分支/终端」是一条上限（天花板）**，规定了 mono **不得**溢出这四类。
- 本节在天花板之内再收一层，让四类里的**控件形态**（chip / 下拉触发器 / 状态栏）回到 sans——因为参照图逐元素证明 Cursor 就是这么做的（`feat/openchamber-chat-refactor` 在底栏是比例字体）。
- **§2.3 列出三处「口径细化点」，需用户点头**；不点头就按字面口径全 mono，本规格给了对应的降级值。

### 2.1 MONO 白名单（必须显式标）

| # | 域 | 组件 / 位置 | 字号档 | 依据 |
|---|---|---|---|---|
| M1 | 围栏代码块 | 未来 `ChatMarkdown` 的 `pre > code`（审计专题 c 方案一） | `--text-code` 13 | Cursor ✅ |
| M2 | 行内代码 `<code>` | assistant 散文中的 `` `x` `` | 13（≈0.87em） | Cursor ✅ `manual` |
| M3a | **工具行原始输出 `<pre>`** | `ToolRows.tsx:203-210` | 13（已是 `text-code`） | ⚠️ **当前只有 `text-code`、没有 `font-mono`**。D25 后会静默变比例 → CLI 表格/树形/diff 的列对齐全崩。**必补，属 D25 引入的回归** |
| M3b | **工具行结构化输入 `<pre>`**（`normalizeRawOutput(toolInput)` 的 JSON） | `ToolRows.tsx:180-187` | 13 | 同上。JSON 缩进在比例字下不成列 |
| M3c | **Host 历史错误原文 `<pre>`** | `MessageTimeline.tsx:312-314` | 13 | 内含路径/errno，`break-all` 已在 |
| M3d | **原始诊断串**（`rawEvents=[…]` / `hostAfter=<JSON>` / `cwd=…`） | `MessageTimeline.tsx:209` · `ChatComposer.tsx:926-928` | 13 | 机器文本，copy-target |
| M3e | **Host 诊断行**（`Node v… · path: … · pid: N · auth=ok · model=…`） | `HostStatusBanner.tsx:72,77-94`（`:80` 路径 / `:90` model） | 13 | 同上 |
| M4 | 工具行参数 arg —— **仅 `argKind === 'ident'` 时** | `ToolRows.tsx:110` `argClass`（三个渲染分支 `:115` `:135` `:144`） | **13**（现继承 15） | A07 屏⑤ 口径修订 + arg 多态问题，见 §2.4 |
| M4b | 提及/附件 chip 的文件路径 | `ChatComposer.tsx:791-797`(`text-[10px]`) · `:138-140` · `EnhancedInput.tsx:846` | 13 | 用户插入的字面路径 |
| M4c | 搜索命中列表的目录段 | `HitListPopover.tsx:39`(basename) `:41`(dirname) | 13 | 路径 |
| M4d | worktree 路径 endAddon | `TargetBranchSelect.tsx:181-185`（`max-w-32 text-xs`） | 13 | **路径**（≠ 同组件 `:147` 的分支名触发器，那个是控件 → sans，见 §2.3） |
| M4e | cwd 指示器 | `StatusLine.tsx:140` `DirItem` 的 `{shortenPath(cwd)}`（`:281` `:293`） | 13 | 路径。⚠️ 容器 `:363-370` 现为 `text-base`(16px) 野字号，同批迁 |
| M5 | diff / patch 正文、行号 | `source-control/**`、`git/FileChanges.tsx` | 13 | 列对齐刚需 |
| M6 | hash / commit sha / session 短码 | 各处 | 13 | 逐字符比对 |
| M7 | 快捷键 `kbd` | `ChatComposer.tsx:994,1000,1006` · `EnhancedInput.tsx:698,704,710,755,761,767` | `--text-2xs` 10 | **已是 `font-mono`，保持**。纯拉丁，10px 安全 |
| M8 | 补全/提及项标识符 | `EnhancedInput.tsx:739` `<span className="font-mono">{item.label}</span>` | 13 | 已正确，保持 |
| M9 | OTP / 验证码输入 | `OnboardingView.tsx:628`（`tracking-[0.5em] font-mono`） | 现状 | 保持，唯一允许 mono + 正 tracking 的例外 |
| M10 | 内容中的绝对路径 | 错误正文、工具输出、assistant 散文里的路径 | 13 | copy-target |
| M11 | 终端 xterm | `useXterm` JS option | — | **不碰**，见 §5.3 |
| M12 | Monaco 编辑器 | `editorSettings` | — | **不碰**，见 §5.3 |

### 2.2 SANS 域（默认继承，不需要任何类）

| # | 域 | 组件 / 位置 | 字号档 | 与 Cursor 对照 |
|---|---|---|---|---|
| S1 | assistant 正文 / user 气泡正文 | `MessageTimeline.tsx:466-473` / `:386-397` | 15 | ✅ |
| S2 | **工具行动词 verb** | `ToolRows.tsx:66` `verbClass` | 15 | ✅ `Finished …` 是比例 |
| S3 | 工具行聚合摘要 | `Explored 2 files` | 15 | ✅ |
| S4 | 侧栏会话标题 | `LeftNav.tsx:556` `<span className="min-w-0 flex-1 truncate">` | 14 | ✅ |
| S5 | 侧栏相对时间 | `LeftNav.tsx:571`（现 `text-[11px]` + tabular-nums） | **13** + tabular-nums | ✅ `50m/3h/6d` |
| S6 | 侧栏段头 `Recent` / `Repositories` | `LeftNav.tsx:277,331` | 14 + `+0.04em` | A07 `:1339` 值不变（P-27） |
| S7 | **Composer 输入框 + placeholder** | `ChatComposer.tsx:807-818` `<Textarea>` / `middleColumnLayout.ts:116-121` | 15 | ✅ `Send follow-up` 是比例。用户往这里打的是中文——**mono 输入框在 CJK 下不可接受** |
| S8 | Composer statusLine | `ChatComposer.tsx:745` | **13** + tabular-nums（已有） | — |
| S9 | 目标栏 folder / branch 下拉 | `ComposerTargetBar.tsx:74-98` 的 `TargetFolderSelect` / `TargetBranchSelect` | 14 | ✅ 底栏分支是比例 |
| S10 | 运行位置只读指示器 | `ComposerTargetBar.tsx:99-101` `RunLocationIndicator` | 14 | ✅ `This PC` 是比例 |
| S11 | model / effort 选择器 | `ModelSelect.tsx` / `EffortSelect` | 14 | ✅ `Kimi K3 Max` 是比例 |
| S12 | meta 行 `claude-opus-5 · 37m ago` | `messageMetadata.ts:141,152-157` | 13 + tabular-nums | ✅ `37m ago` 是比例 |
| S13 | 会话 Tab 标签 | `AgentSessionTabs.tsx:84` | 14 | — |
| S14 | 文件变更卡的文件名 | 未来 diff 卡 | 14 | ✅ Cursor 的 `check-final.js` 是**比例** |
| S15 | Badge / chip 文案（分支除外，见 §2.3） | 各处 | 13~14 | ✅ |
| S16 | 对话框/抽屉标题 | `font-heading` 的 7 处 | 18 | token 随栈自动翻转 |
| S17 | 顶栏标题 | `MainHeader.tsx:35` | 15 + **`font-semibold`**（P-19；见 §3.2，`font-medium` 在 Win10 是 no-op） | ✅ 单行标题 |
| S18 | 侧栏项目名 | `LeftNav.tsx:391-393`（现 `font-medium`） | 14 + **600** | 同上 |
| S19 | 工具行 arg 的 **prose 形态** | `Worked for **1s**` · `Explored **2 files**` · Bash `description` | 15 | 见 §2.4 的 `argKind` |
| S20 | StatusLine 的全部数值项 | `StatusLine.tsx:199`(%) `:209`($) `:219`(时长) `:233-234`(+/-行数) `:245`(token) `:255`(cache) `:269`(api时间) `:303`(version) | 13 + **tabular-nums** | ✅ Cursor 的 `+10279` 是比例着色 |
| S21 | StatusLine 模型名 | `StatusLine.tsx:186-189` `displayName` | 13 | ✅ |
| S22 | 问答卡选项/分页/回车符 | `QuestionCard.tsx:101,204-210,348-350,441` · `:103`(`1 of 3`) `:196-202`(选项字母) `:405`(`⏎`) | 15 正文 / 13 meta | 字母 chip 与 `⏎` 现挂 `text-code`，**是 sans 用了 code 档**，迁 `--text-meta` |
| S23 | user / system / error 气泡正文 | `MessageTimeline.tsx:406-412`（现 `text-sm` 14px） | **15**，与 assistant 同档 | 现比 assistant 小一档，属既存不齐 |
| S24 | assistant footer `model · HH:MM` | `MessageTimeline.tsx:516-520`（现 `text-code`） | **`--text-meta`** 13 | 见 §3.1「为什么要两个 13px token」 |
| S25 | 侧栏搜索框 / 重命名输入 | `LeftNav.tsx:242-248` · `:496-512` | 14 | 会输入中文 |
| S26 | 会话 Tab 标题 / 重命名 | `AgentSessionTabs.tsx:94` · `SessionBar.tsx:342,420,331-340,409-418` | 14 | — |

### 2.3 三处「口径细化点」——需用户点头

已拍板口径字面写了「分支 → mono」。参照图里分支是**比例**。三处受影响，各给两个值：

| 点位 | 推荐（A · 对齐 Cursor） | 字面口径（B · 全 mono） | 代价差 |
|---|---|---|---|
| 侧栏分支 chip `LeftNav.tsx:562-566` `<Badge className="max-w-28">` | **sans 13px** | mono 13px | A 比 B 多 ~10% 可见字符。**A 直接缓解 P-24「一行两处截断」** |
| Composer 分支下拉触发器 `TargetBranchSelect` | **sans 14px** | mono 13px | 与 §2.0 判据一致（它是控件） |
| 运行位置指示器 `RunLocationIndicator` | **sans 14px** | mono 13px | `This PC` / `Local` 不是 copy-target |

**推荐 A。** 理由：① 参照图逐像素证明；② §2.0 判据自洽（同一分支名出现在 assistant 正文里仍是 mono）；③ 直接给 P-24 送 ~10% 字符预算。
**若用户坚持 B**：全部走 mono 13px，且必须同时执行 P-24 的 chip 封顶 112→88px，否则截断更糟。

### 2.4 工具行：动词 sans / 参数 mono —— 混排的具体做法

这是**整份规格里对"协调感"贡献最大的一条**（审计 §b.3：Cursor 的层级有相当部分来自"比例正文 + 等宽代码"的质感对比，等宽体系内没有这个维度）。

```
现状（全等宽 15px 同族同号）：   Read  vflow/package.json
D25 后：                        Read  vflow/package.json
                                └sans 15px  └mono 13px
```

**⚠️ 但 arg 槽是多态的——「arg 一律 mono」是错的。** 实测 `toolCard.ts` / `turnTiming.ts`，同一个 `{view.arg}` 槽会装进两类完全不同的东西：

| arg 实际内容 | 来源 | 应有字体 |
|---|---|---|
| `vflow/package.json`、`vflow/package.json L10-40` | `toolCard.ts:584-594`（Read）`:609-615`（Edit/Write） | **mono** |
| 原始 shell 命令 | `toolCard.ts:620` Bash 分支的 `command` 侧 | **mono** |
| URL | `toolCard.ts:606-608`（WebFetch） | **mono** |
| **人写的 Bash `description`** | `toolCard.ts:620` 的 `description ?? command`——**有 description 时是散文** | **sans** |
| **`2 files, 3 searches`** | `toolCard.ts:362-364` 聚合行 | **sans**（数字+散文） |
| **`for 1s` / `briefly`** | `turnTiming.ts:117,119`（Thought）`:134-138`（Worked for） | **sans** |

→ **必须给 `ToolRowView` 加一个 `argKind: 'ident' | 'prose'` 字段**，在 `toolCard.ts` / `turnTiming.ts` 生成侧判定，`ToolRows.tsx:110` 的 `argClass` 按它切字族与字号。
这不是可选优化：不加的话，`Worked for` 行的 `1s`、聚合行的 `2 files`、Bash 的中文 description 会全部变成等宽——**等于把刚清掉的等宽又撒回中列最显眼的三个位置**。加了之后 §6.3 的 A2 断言也才写得准。**这是本轮从代码实测里捞出的最重要的一条修正。**

技术要点四条：

1. **光学配平是硬要求，不是审美偏好。** 同 px 下 mono 的视觉体量比 sans 大约 8~12%（平均 advance 0.6em vs 0.5em，且笔画更方）。行业标准做法是行内 mono 降一档。我们的 15/13 档比 = 0.867，正落在推荐带内。
   → **`--text-markdown`(15) 与 `--text-code`(13) 这对档位，在全等宽时代是无意义的，在 D25 下变成承重结构。** 这是"现有四档语义体系不必推翻"的核心论据。
2. **`ToolRows.tsx:60` 的 `items-baseline` 正好是对的**——混字号混字族必须基线对齐。行高由较大的 15px 行盒决定（`leading-normal` ≈22px），13px mono 行盒 ≈17px，不会顶破，行高零抖动。
3. **`ChevronDown` 的 `size-[13px]`（`:88`）与 code 档同尺寸**，保持不动。
4. **三级灰与 destructive 分级（P-01/P-05）与本条正交**，字族改动不影响颜色裁定。

**A07 屏⑤ 的字体口径标注方案**（A07 是等宽底做的基线）：
> A07 屏⑤ 的 `.ct-row` verb 与 `.ct-a` arg 在原型里同族同号，属 **D18③ 全等宽的遗留呈现**，**自 D25 起不再是施工依据**。
> 生产口径：`verb → var(--font-sans) @ --text-markdown(15px)`；`arg → var(--font-mono) @ --text-code(13px)`；`<pre> 输出体 → var(--font-mono) @ 13px`。
> **A07 屏⑤ 的其余裁定（三级灰分配、失败态、展开规则、缩进 depth=0、hover 行为）全部继续有效。**

写法见 §4.2 的追记段落模板。

### 2.5 落法：**sans 默认 + mono 白名单**（正向），不做反向

**结论：正向。** 三条理由：

1. **单点入口天然支持。** `--font-sans` → Tailwind `--default-font-family` → preflight 挂 `<html>`；全仓无任何 `font-family` 声明（design-system `:451-455` 实证）。改 1 个 token = 全 UI 翻转。反向（默认 mono + `font-sans` 白名单）要给几百个点位加类。
2. **失败模式必须选良性的那个。** 漏标一个点位：
   - 正向 → 该处渲染成比例字体。参照图里 Cursor 的文件名/分支名本来就是比例 → **降级后仍在目标态附近**。
   - 反向 → 该处渲染成等宽 → **正是我们要消灭的那个 bug**。
   **选失败模式良性的方向。**
3. **迁移量级差一个数量级**（见 §5）。

**不要裸撒 `font-mono`。** 按 CLAUDE.md「组件优先」，落成两个原语：

```
src/renderer/components/ui/ident.tsx
  <Ident>      = font-mono + text-code + tracking-normal   （路径/hash/分支-in-prose/工具行参数）
  <CodeInline> = <Ident> + bg-muted + px-1 + rounded-xs    （行内 <code>）
  <CodeBlock>  已存在（components/ui/code-block.tsx），补齐 font-mono 口径
```

收益：① 光学补偿逻辑只有一处可调；② 让 §6.3 的静态断言变成一行 rg（`font-mono` 只允许出现在文件白名单内）；③ 符合工程规范第 4 条（确定性断言过程）。

**Feature flag（工程规范第 6 条）**：

```css
/* @layer base -- one attribute, both configurations runnable for A/B */
html[data-font-domain="mono"] { font-family: var(--font-mono); }
```

⚠️ **不要用 `[data-font-domain="mono"] { --font-sans: var(--font-mono) }` 的写法**：Tailwind v4 的 `--default-font-family` 走 `--theme(--font-sans, initial)`，`--theme()` 有可能在构建期内联字面值而非留 `var()` 引用，运行时覆盖 `--font-sans` 未必生效。上面这种**直接给 `html` 声明 `font-family`** 的写法特异性高于 preflight 的 `html {}`，不依赖 Tailwind 内部实现，稳。

---

## 3. 决策三 · 字号 / 字重 / 字距梯度重校

### 3.1 字号：四档语义体系**保留**，做三处调整

维持 `docs/design-system.md:333-338` 的四档语义（code 13 / ui 14 / markdown 15 / settings-title 18）。理由见 §2.4 要点 1——15/13 档比在 D25 下才真正开始工作。

**`@theme` 目标 token 表**（现状只有 `--text-2xs` / `--text-code` / `--text-markdown` 三个，`globals.css:42-46`）：

| token | px | 字族 | 用途 | 状态 |
|---|---|---|---|---|
| `--text-2xs` | 10 | **mono only** | `kbd` 快捷键 chip。**禁止承载 CJK**（中文 10px 不可读） | 已有，加约束 |
| `--text-code` | 13 | **mono** | 行内代码/代码块/工具行参数/路径/hash/diff | 已有 |
| `--text-meta` | 13 | **sans** | 时间戳、statusLine、meta 行、footer、次级说明 | **新增** |
| `--text-ui` | 14 | sans | 侧栏行、按钮、label、段头、tab、下拉触发器 | **新增**（P-12 已点名） |
| `--text-markdown` | 15 | sans | 聊天正文、工具行动词、全部 h1–h6 | 已有 |
| `--text-title` | 18 | sans | 设置页 L1（唯一 >15 的档） | **新增**（收编 `text-lg`） |

**为什么 `--text-meta` 与 `--text-code` 同为 13px 却要两个 token**：两者**变更理由不同**。`--text-code` 的 13 是"对 15px sans 的光学补偿值"，将来若正文档位或 mono 栈变了它必须跟着动；`--text-meta` 的 13 是"次级 UI 文本"，不该被 mono 的光学调参拖着走。同值不同因 ⇒ 两个 token（不这样做，未来一次 mono 调参会静默改掉全部时间戳字号）。

> **代码实证（不是理论洁癖）**：现在已经有四处拿 `text-code` 装**非代码的 sans 文本**——`MessageTimeline.tsx:516-520` 的 `model · HH:MM` footer、`QuestionCard.tsx:103` 的 `1 of 3` 分页、`:196-202` 的选项字母 chip、`:405` 的 `⏎`。全等宽时代这没有代价；D25 之后，"13px" 与 "mono" 在同一个 token 里就是一个歧义源。**拆 token 顺手把这四处归位。**

**三处调整**

| # | 调整 | 影响点 |
|---|---|---|
| ① | `text-xs`(12) **37 处**全量迁 `--text-meta`(13) 或 `--text-ui`(14) | 审计 §0.2② |
| ② | `text-[11px]` 3 处：`LeftNav.tsx:571` → `--text-meta`(13)；`MessageTimeline.tsx:399` 由 P-08 直接删除 | — |
| ③ | `text-[10px]` 12 处：**纯拉丁/数字的**（kbd 等）留 `--text-2xs`；**可能承载 CJK 的**全部升到 `--text-meta`(13) | D25 新增约束 |

> **审计 P-12 的目标"只剩 10/13/14/15 四档"在 D25 下要修正为「10(仅 mono 拉丁) / 13 / 14 / 15 / 18」。** 原因：全等宽时代"缩字号既不省宽"（A07 `:1339`），10px 只是个装饰档；比例字体下 10px 的 CJK 是**真的读不了**，必须给出硬约束而不是档位收敛。

### 3.2 字重：梯度恢复可用，但**只有 400/600 是全平台真档**

审计 E4 的问题（`font-medium` 在等宽回退链上被四舍五入回 Regular）在 D25 下**大部分解除**，但不是全解除。实测矩阵：

| 平台 | 族 | 400 | **500** | **600** | 700 |
|---|---|---|---|---|---|
| macOS 11+ | SF Pro（`-apple-system`） | ✅ Regular | ✅ **Medium** | ✅ Semibold | ✅ Bold |
| **Windows 11** | Segoe UI Variable Text | ✅ | ✅ **可变轴真值** | ✅ | ✅ |
| **Windows 10** | Segoe UI（静态：300/350/400/600/700） | ✅ | ❌ **缺 500** | ✅ Semibold | ✅ Bold |
| Linux | Noto Sans / Ubuntu | ✅ | ⚠️ 视安装的子族 | ⚠️ 缺则升 700 | ✅ |
| （对照）现 mono 栈 | Consolas / Menlo / Cascadia | ✅ | ❌ | ❌ | ✅ |

CSS 字重匹配规则（CSS Fonts 4 §5.2）：目标 500 时先找 500，**找不到就降到 400**（不是升到 600）。→ **Win10 上 `font-medium` 与 `font-normal` 逐像素相同。**
目标 600 时先找 ≥600 升序 → 缺 600 会落到 700 Bold（降级为"更重"，不会消失）。

**分配规则（可执行）**

| 档 | Tailwind | 用途 | 硬约束 |
|---|---|---|---|
| 400 | `font-normal` | 正文、描述、占位、工具行输出体、所有 muted 文本 | 默认 |
| 500 | `font-medium` | 按钮、label、导航项、表头、**软强调** | ⚠️ **500 永远不能是某个层级区分的唯一载体**——Win10 上它就是 400。任何"必须在 Win10 上也看得出来"的区分，用 400 vs 600 |
| 600 | `font-semibold` | 卡片/对话框/段落标题、**assistant 正文相对 meta 的强调**（P-13）、顶栏标题（P-19） | 全平台可靠。**这是 D25 交付的新维度** |
| 700 | `font-bold` | 仅 markdown `**粗体**` 内联 | 不用于 UI 层级 |
| — | mono 元素 | **永远 400 或 700，禁用 500/600** | mono 族普遍只有两档，500/600 会触发合成加粗（毛糙）。配合 `font-synthesis-weight: none` |

**净收益量化**：审计 §b.2 结论是"D18 下字重只有 400/700 两档可用，中间档不可靠"，且实测 `semibold`/`bold` **0 处**使用 → 实际可用 **1 档**。D25 后：**400/600 两档全平台可靠 + 500 机会档**。层级三件套（design-system `:341-347` weight × letter-spacing × color）从"塌成 color 一维"恢复到**三维齐全**。

### 3.3 字距（letter-spacing）：接通梯度，但要为 CJK 改造

design-system `:347` 抄的是 OpenChamber 的六级梯度（h1 `-0.025em` … h6 `+0.01em`）。**那套梯度不能原样落到本项目**，两条硬理由：

1. **负 tracking 在 CJK 上会撞字。** 我们的标题、侧栏会话标题、user 气泡都可能全是中文。CJK 字形本就满格排布，负字距直接让笔画相接。
2. **负 tracking 的收益只在大字号出现。** 我们最大的标题也只有 18px；15px 以下的负字距是纯风险无收益。

**D25 字距梯度（四档 + 两条禁令）**

| 档 | 值 | 域 | 依据 |
|---|---|---|---|
| ① 段头 | **`+0.04em`** | `Recent` / `Repositories` 段头（`LeftNav.tsx:277,331`）；A07 `.fx` 内 `:582` / `:1113` 同值 | **A07 `:1339` 明文裁定值，D25 后数值不变**（只改理由句，见 §4.2） |
| ② 微标签 | **`+0.02em`** | ≤11px 的 badge / 角标 / `kbd` 内文 | 小号比例字需要开距 |
| ③ 按钮 | **`+0.01em`** | `ui/button.tsx:21` 已全局带 `tracking-[0.01em]` + `lowercase` | **保持不动**，比例字下这条终于起作用了 |
| ④ 正文/UI | **`0`** | 正文、侧栏行、Composer、工具行、meta | 默认 |
| ⑤ 大标题 | **`-0.01em`** | **仅 ≥18px**：`font-heading` 的 7 处（`ui/dialog.tsx:154` `ui/sheet.tsx:149` `ui/alert-dialog.tsx:119` `ui/empty.tsx:81` `sessions/SessionManagerView.tsx:52,114` `onboarding/OnboardingView.tsx:771`） | 唯一负字距允许档 |

**两条禁令（可静态断言）**
- 🚫 **`font-mono` 元素禁止任何非零 `tracking`**（唯一例外：`OnboardingView.tsx:628` 的 OTP `tracking-[0.5em]`，那是刻意的字符分隔）。等宽 + 字距 = 列对齐失效，工具输出/diff 直接崩。
- 🚫 **任何可能承载 CJK 的元素禁止负 `tracking`**。实操上等价于「<18px 一律非负」。

**接通量级**：全域现 `tracking-*` **7 处**（`button.tsx:21` 全局 1 + onboarding 2 + menu/command 2 + OTP 1 + 即将被 P-08 删掉的 1）。落完梯度约 **6~8 处**（段头 2 + 大标题 7 归一到 `--text-title` 类）。这条是审计 b.1-⑥「最被低估的一条」，S 量级。

### 3.4 阅读栏宽度（与字体强绑定，必须同批改）

审计 E5：「换比例字体会让行更长（≈102 字符），正确组合是『比例字体 **+** 收窄栏宽』，不是简单替换」。

**现状**：`workspace-shell/shellLayoutModel.ts:29-31` `normal → max-w-3xl`(48rem/768px)、`wide → max-w-5xl`(64rem/1024px)。有单测锁死类名（`__tests__/shellLayoutModel.test.ts:304-317`）。

**目标值与推导**

| 方案 | 值 | CJK 字/行(15px) | 拉丁字符/行 | 评价 |
|---|---|---|---|---|
| 现状 | 48rem/768px | 51.2 | ≈102 | 比例下偏宽 |
| 审计 E5 建议 | 42rem/672px（`max-w-2xl`，Tailwind 默认档） | 44.8 | ≈90 | 比参照**窄 3 字** |
| **本规格推荐** | **45rem/720px** | **48.0** | ≈96 | **= Cursor 实测 48 字/行** |

**推荐 45rem**，理由：§0 的实测标定给出 Cursor = 48 CJK 当量/行；用户指名要的就是那个观感；15px × 48 字 = 720px = 45rem，逐字对齐。

**落法**（保持 `shellLayoutModel.ts:29` 注释里"不用任意值"的纪律）：`@theme` 加容器 token，而不是写 `max-w-[45rem]`：

```css
  --container-reading: 45rem;       /* normal: 48 CJK chars @ 15px, = Cursor reference */
  --container-reading-wide: 60rem;  /* wide: same -6.25% scaling as normal */
```
→ `READING_COLUMN_CLASS = { normal: 'max-w-reading', wide: 'max-w-reading-wide' }`，同步改 `__tests__/shellLayoutModel.test.ts:304-317` 四例。

**零 token 的降级方案**：`normal → max-w-2xl`(42rem)、`wide → max-w-4xl`(56rem)，全是 Tailwind 默认档，改动只有两个字符串 + 四条断言。观感代价：比参照窄 3 字/行。

**顺带**：`MessageTimeline.tsx:169` 的注释写死了「48rem/64rem reading width (T-22 spec §2.13)」，同批更新，否则又一处账实不符。

---

## 4. 决策四 · 两基线与 design-system 的修订方式

### 4.1 核心原则：**渲染字节冻结，注记可追加**

A07 v3 与 phase0a 是**用户验收产物**，就地改字体 token 会让"基线 = 验收凭证"失真。但整份文件冻结又会让它变成误导源。分界线：

| 层 | 处置 | 具体范围 |
|---|---|---|
| ❄️ **冻结**：原型渲染层 | **一个字节不动** | A07 的 `.fx*` 作用域 CSS（含 `:473-474` `font-family: var(--mono)`、`:480-481` `.fx code { font-family: inherit }`）与全部 `.fx` demo markup；phase0a 同构部分。**改它 = 毁掉验收凭证** |
| ✏️ **可修订**：文档说明层 | 允许改写 + 追加 | 页面顶栏、说明段、verdict 列表、决策表的「理由」列、偏离表、附录。**这些是评注，不是被验收的视觉** |
| ➕ **仅追加**：追记段 | 文末新增，不动既有编号 | 「A07 v4 追记 · D25 分域字体」 |

> 判据：**改动是否会让重新打开这个页面的人看到与用户当初点头时不同的原型画面？** 会 ⇒ 冻结区；不会 ⇒ 可修订区。

**版本口径**：A07 **v3 保持是定稿版本号**，D25 的内容进 **v4 追记段**，不回改 v3 正文的裁定编号。phase0a 同理。

### 4.2 A07 具体修订清单（逐锚点）

**① 顶部时效标注**（可修订区，仿 `docs/design-system.md:3` 已有的 ⚠️ 时效警示体例）：

> ⚠️ **时效标注（2026-07-30，D25 连带）**
> 本页原型在 **D18③ 全等宽字体**下渲染并经用户验收（v3）。**自 D25 起，字体口径以 D25/本页文末「v4 追记」为准**，原型画面的字族呈现**不再是施工依据**。
> **未受影响、继续有效**：Flexoki 调色板、卡片形态、间距、圆角、三级灰分配、失败态、展开规则、屏①~⑥ 的全部布局裁定。
> 逐条对照见 → 文末「A07 v4 追记 · D25 分域字体」。

**② 逐锚点处置表**（写进 v4 追记段）：

| A07 锚点 | 原文要点 | D25 处置 |
|---|---|---|
| `:473-474` `.fx { font-family: var(--mono) }`（注释「D18③：sans/mono/heading 三者统一」） | 原型全等宽底 | ❄️ **冻结不动**。追记标注「原型保留等宽以维持验收画面一致；生产走 `--font-sans`」 |
| `:480-481` `.fx code { font-family: inherit }` | 行内 code 与正文同族 | ❄️ 冻结。生产口径：`<code> → var(--font-mono) @ --text-code` |
| `:1209`「字体是 D18 的全等宽栈，尺寸尽量落在 design-system 既有档位上」 | 说明段 | ✏️ 改写为分域口径；「尺寸落既有档位」半句**继续有效** |
| `:1272` verdict-item「颜色/字体：Flexoki + 全等宽，零硬编码」 | 结论条 | ✏️ 拆半：**颜色半句有效**，字体半句改「Flexoki + 分域字体（UI 比例 / 代码等宽）」 |
| `:1294`「刻意不搬的 Cursor 元素：……无衬线字体」 | 明确不搬 | ✏️ **本条反转**——D25 后已搬。标注「D25 撤销本项，白底浅灰面板仍不搬」 |
| `:1339` 段头 **14px + muted + 0.04em**，理由「等宽字体下缩字号既不省宽也会破坏纵向节拍，层级交给颜色与字距」 | 明文数值裁定 | ✅ **数值全部保留**（P-27 照落）。✏️ **只改理由句**：比例字体下缩字号**确实省宽**，所以"不缩字号"改由新理由支撑——「段头与内容同档、层级交给 weight+字距+color 三件套（D25 后三件套全部可用）」 |
| `:1346` chip 封顶 **112px**「关键取舍：标题永远拿大头」 | 明文数值 | ⚠️ **数值前提变了**：比例字体使标题可见字符 13→≈16（+20%），P-24 的"一行两处截断"部分自解。**与 P-24 合并复算**，不在 D25 单独裁 |
| `:1368`「D18③：sans/mono/heading 三者同为 ui-monospace，本页原型内**没有第二种字族**」 | 事实陈述 | ✏️ 作废（对原型仍成立，对生产不成立）。改「本页原型内没有第二种字族；生产自 D25 起有两种，映射见 D25 §2」 |
| `:2782` 偏离表行「系统无衬线字体 / **全等宽 ui-monospace，UI 内无第二字族** / D18③」 | D18③ 偏离登记 | ✏️ **追加一列「D25 修订」**：该偏离项**已撤销**，回到 Cursor 的比例字体 |
| `:2838-2839` 发送键「维持基线现状——28px 圆形 `--primary` 实心」+ 论据「等宽字体下 `Send` 占位偏宽」 | 结论 + 论据 | ✏️ **论据失效**（比例字下 `Send` 不再偏宽），**结论 `:2838` 不受影响**（审计已指出）。追记里注明"结论保留、论据换成'同位同尺寸的 Stop 让状态切换零位移'" |
| 屏⑤ 工具行 verb/arg | 同族同号 | ✏️ 按 §2.4 的标注段落追记 |

**③ v4 追记段模板**（追加在 A07 文末）：

```
## A07 v4 追记 · D25 分域字体（2026-07-30）
v3 是用户定稿版本，本追记不回改 v3 任何裁定编号。
一、口径变更：D18③「sans/mono/heading 三者统一 ui-monospace」撤销 → D25 分域。
二、本页原型的已知字体差异（防止有人拿原型 diff 生产后报 bug）：<表>
三、逐锚点处置：<上表>
四、屏⑤ 工具行字体口径（D25 生产版）：verb=sans@15 / arg=mono@13 / <pre>=mono@13；
    其余裁定（三级灰、失败态、展开、depth=0、hover）全部继续有效。
五、新增视觉凭证：docs/design/a09-font-domain-baseline.html（三测点 mono/split 并排 A/B）。
```

### 4.3 phase0a 具体修订清单

| phase0a 锚点 | 原文 | 处置 |
|---|---|---|
| `:39` `--mono` 原型栈 | 含 `Consolas` | ❄️ 冻结（但**生产 mono 栈按 §1.3 补 Consolas 对齐**） |
| `:884` verdict-item「字体：全等宽 ui-monospace」 | 结论条 | ✏️ 改「分域字体（UI 比例 / 代码等宽）—— D25」 |
| `:1050` demo caption「Flexoki · 阅读栏 768px 居中 · 全等宽字体」 | 演示页眉 | ✏️ 改「Flexoki · 阅读栏 720px 居中 · 分域字体」+ 标注原型画面仍为等宽 |
| `:1388-1390` 对照表行「ui-monospace（全等宽）…**已定为全等宽照做**；需注意中文回退，中英混排的宽度节奏需实测」 | 对照裁定 | ✏️ **实测已做、结论已翻**：追加「2026-07-30 D25：实测证实风险坐实（open-q #10 结项），改分域」 |
| `:1545`「ARD D6 改写为『对齐 OpenChamber 观感：Flexoki 主题 + 全等宽字体 + 卡片形态』」 | D6→D18 沿革 | ✏️ 追加 D25 一行沿革，**不改原句**（它是历史记录） |
| 顶部 | — | ➕ 同 A07 的时效标注 |

### 4.4 `docs/design-system.md` 改写稿要点（**活文档，就地改写**）

| 节 | 现状 | 改写要点 |
|---|---|---|
| 顶部 ⚠️ 时效警示（`:3-18`） | 「字体族」列在"已撤销"里 | 把「**字体族**」从已撤销移回，标注「T-30/D25 重写中 → 以新节为准」 |
| **「字体族（全等宽 UI）」`:436-488`** | 唯一等宽栈 / 三键统一 | **整节改标题为「字体族（分域：UI 比例 / 代码等宽）」**。保留三段仍然成立的论证：① `:451-455`「改 `--font-sans` 就等于改整个 UI」（机制不变，是 D25 的落地基础）；② `:457-460`「必须写字面量栈、不写悬空变量、不写未随包字体」（**D25 的选型理由之一，加强**）；③ `:464-483`「分离契约：UI 字体 ≠ 终端/编辑器字体」（**红线，一字不动**）。删除 `:462`「`font-mono` 与 `font-sans` 现在视觉无差别，这是目标不是 bug」——**该句在 D25 下反转为 bug 判据** |
| 「中英混排风险（未结项）」`:485-488` | 未结项 | **结项**，改写为「CJK 级联规则」小节：级联顺序（Latin 先/CJK 后）、禁用 `system-ui` 的理由、10px 禁 CJK、负 tracking 禁 CJK |
| **Typography `:325-364`** | 四档语义 + 「全等宽里靠字号做层级会撑破 48rem」 | 四档保留；`:351`「在全等宽 UI 里这条尤其重要……」**改写**：比例字体下缩字号确实省宽，但仍不用字号做标题层级（理由换成 §3.1）。表格补 `--text-meta` / `--text-ui` / `--text-title` 三行与「字族」列 |
| **Font Weight `:366-374`** | 400/500/600 三档 | **补一列「平台可靠性」**（§3.2 矩阵），加硬约束「500 不得作为层级区分的唯一载体」「mono 元素只用 400/700」 |
| **新增「Letter-spacing 梯度」小节** | 无（现只散落在 `:347`） | 落 §3.3 的四档 + 两条禁令 |
| **新增「数字对齐（tabular-nums）」小节** | 无 | 落 §5.4 —— D25 引入的新要求 |
| Squircle 节 `:300`「路径类建议同时加 `font-mono`」 | 单点建议 | 升级为指向 §2 域映射表的引用 |
| 根字号结论 `:490-509` | 已结 | 不动 |

---

## 5. 决策五 · 迁移扫描面

### 5.1 现状分布（实测 rg，`src/` 全域）

`font-mono` 共 **45 处 / 24 文件**：

| 目录 | 处数 | 判定 |
|---|---|---|
| `chat/` | **10**（`ChatComposer` 3 + `EnhancedInput` 7） | 全是 `kbd`(9) + 提及标识符(1) → **全部已正确，保持** |
| `workspace-shell/` | **0** | 侧栏整体默认继承 → D25 后自动比例 ✅ |
| `ui/`（`code-block` `mermaid-renderer`） | 2 | 正确 |
| `settings/`（`HapiSettings` 5 · `GeneralSettings` 4 · 两个 dialog 2） | 11 | JSON/配置编辑面，正确 |
| `source-control/` + `git/` | 9 | ⚠️ **重点复核区**，见 §5.2 |
| `files/` + `repository/` + `sessions/` + `onboarding/` + `ErrorBoundary` | 12 | 逐点复核 |
| `globals.css` + `stores/settings/index.ts` | 2 | token 声明 + 注释 |

**结论：chat/workspace-shell 两个主战场几乎不需要"删 mono"，D25 的工作量是「加 mono」+「复核加漏」，不是大规模改写。**

两条附带实测：
- `chat/` + `workspace-shell/` 全域 `tracking-*` **只有 1 处**（`MessageTimeline.tsx:399`，且正是 P-08 要删的）→ **P-08 落地后中列字距归零**，§3.3 的梯度是从零起建，不存在与存量冲突。
- 两目录内**零** `--font-sans` / `--font-mono` / `--font-heading` 直接引用；唯一读 `font-family` 的是 `SessionBar.tsx:572-573`（拖拽影像，自动跟随）。→ **翻栈没有隐藏的旁路消费者。**

### 5.2 需**显式补 mono** 的点位（会被 D25 静默改坏的）

按风险排序：

> 全域实证结论（子代理逐文件扫描）：**`chat/` + `workspace-shell/` 里除 9 处 `kbd` 与 1 处 slash-command 标签外，没有任何元素主动选择过 mono——A~I 九类内容今天之所以是等宽，纯粹因为 `--font-sans` 本身是等宽。** 所以 D25 翻栈的那一刻，下表全部点位会**静默变比例**。

| 风险 | 点位（`file:line`） | 症状 |
|---|---|---|
| 🔴 **高** | `chat/ToolRows.tsx:203-210` `<pre>` 工具输出 —— 只有 `text-code`，无 `font-mono` | CLI 输出的表格/树形/对齐/ASCII 图**全崩**。`whitespace-pre-wrap` 只保空格、不保列宽 |
| 🔴 **高** | `chat/ToolRows.tsx:180-187` `<pre>` 结构化输入 JSON | 缩进不成列 |
| 🔴 **高** | `source-control/**` + `git/FileChanges.tsx` 的 **diff 正文与行号**（现共 9 处 mono，覆盖是否完整需逐屏复核） | diff 列错位 |
| 🟠 中 | `chat/MessageTimeline.tsx:312-314` `<pre>` Host 历史错误原文 | 路径/errno 可读性 |
| 🟠 中 | `chat/MessageTimeline.tsx:209` + `chat/ChatComposer.tsx:926-928` 原始诊断串 | 同上 |
| 🟠 中 | `chat/HostStatusBanner.tsx:77-94` 诊断行（`:80` 路径 / `:90` model） | 同上 |
| 🟠 中 | `chat/StatusLine.tsx:140,281,293` cwd 路径；容器 `:363-370` 还是 `text-base`(16px) 野字号 | 路径 + 字号双问题 |
| 🟠 中 | `chat/HitListPopover.tsx:39,41`、`chat/ChatComposer.tsx:791-797,138-140`、`chat/EnhancedInput.tsx:846`、`chat/TargetBranchSelect.tsx:181-185` 的路径/文件名 | 逐字符比对 |
| 🟠 中 | `chat/ToolRows.tsx:110` `argClass`（工具行参数，**需先加 `argKind`**，见 §2.4） | 属主动改造，非回归 |
| 🟠 中 | 任何渲染 hash / sha / session 短码的点位 | 逐字符比对困难 |
| 🟡 低 | `files/MarkdownPreview.tsx`（已有 1 处 mono，需确认 `pre`/`code` 双覆盖） | 预览代码块 |
| ℹ️ 记录 | `chat/SessionBar.tsx:572-573` 把 `computedStyle.fontFamily` 拷到拖拽影像的 inline `cssText` —— **全仓唯一直接读写 `font-family` 的地方** | 自动跟随翻栈，**无需改动**，仅登记以防误判 |

### 5.3 边界：**不碰**（口径 #12 之外）

| 面 | 状态 | 证据 |
|---|---|---|
| `lib/ghosttyTheme.ts` | **零 `font` 引用**（实测 rg 无命中）。`applyTerminalThemeToApp()` 只写 25 个**颜色** token | D25 与 open-q #12 **完全正交**——#12 是配色边界，字体不在其中，**无需等 #12 裁定** |
| `files/monacoTheme.ts` / Monaco `editorSettings` | 字体走 JS option | design-system `:464-483` 分离契约红线 |
| xterm `useXterm` | `new Terminal({ fontFamily, fontSize })` 读 store | 同上 |
| `resources/ghostty-themes/` / `scripts/generate-themes.ts` | 配色 | #12 边界外 |

> 一句话可写进台账：**D25 只动 `@theme` 的三个字族 token 与 React 层的类名，不触碰任何终端/编辑器字体通路，因此与 open-q #12 不构成依赖。**

### 5.4 D25 会**引入**的三类隐性回归（必须同批处理）

1. **数字抖动（无人会预测到的一条）。**
   等宽下所有数字天然等宽；换比例后**原地刷新的数字会左右跳**。现全仓 `tabular-nums` 只有 10 处（`ui/meter` `ui/progress` `ui/sidebar` `ui/number-field` `ChatComposer:141,745,1014` `QuestionCard:103` `ProjectGroup:45,49`）。
   **必补清单（实测点位）**：
   - `StatusLine.tsx` 整条 —— `:199` `{percent}%`、`:209` `$0.0123`、`:219` `1m30s`、`:233-234` `+N` / `-N`、`:245` `1.2K/3.4K`、`:255` cache、`:269` `4s/9s`、`:303` version。**8 项全是原地刷新，全部无 `tabular-nums`，这是抖动重灾区。**
   - `messageMetadata.ts:143,152-157` → 渲染点 `MessageTimeline.tsx:517`（`1.2s` / `HH:MM`）与 `:414`。
   - `turnTiming.ts:119,134-138` `for {N}s` / `Worked for` → `ToolRows.tsx:67,144`。
   - `toolCard.ts:362-364` 聚合行 `N files, N searches`。
   - `MainHeader.tsx:74-80` usage 环 `72%`（若 T-23 未先撤掉）。
   - `LeftNav.tsx:312` `Show more ({n})`。
   - 已有 ✅ 无需补：`ChatComposer.tsx:141,745,1014`、`QuestionCard.tsx:103`、`LeftNav.tsx:571`、`ui/{meter,progress,sidebar,number-field}`。
   → design-system 加「数字对齐」小节，规则：**任何会原地变化的数字，或任何需要跨行竖直对齐的数字，必须 `tabular-nums`。**
2. **宽度预算全线松动。** 比例字比等宽窄 ~15~20%：所有按等宽字符数调过的 `max-w-*` / 固定 px 会留空档，截断点位移。受影响的**已知**点：`LeftNav.tsx:562` chip `max-w-28`（P-24 复算）、`AgentSessionTabs.tsx:84` `min-w-[120px] max-w-[180px]`、`EnhancedInput.tsx:839` `max-w-[160px]`。
   ✅ **好消息**：`ch` 单位全仓 **0 处**（实测），没有单位语义漂移。
3. **`lowercase` 与 `normal-case` 六处豁免不受影响**（open-q #10 补记 ①~⑥）——`text-transform` 与字族正交，但 **GUI 首测仍需目视这六处**（原 #10 验收要求）。

### 5.5 量级估算

| 工序 | 内容 | 量级 |
|---|---|---|
| ① token 层 | `globals.css` 字族 3 行 → 分域两栈；`@theme` 加 `--text-meta` / `--text-ui` / `--text-title` / `--container-reading{,-wide}`；`font-synthesis-weight`；feature flag 1 行 | **S**（0.25d） |
| ② 原语 | `ui/ident.tsx`（`<Ident>` / `<CodeInline>`）+ `code-block.tsx` 口径对齐 | **S**（0.25d） |
| ②b | **`ToolRowView.argKind` 多态字段**（`toolCard.ts` + `turnTiming.ts` 生成侧判定 + `ToolRows.tsx:110` 消费）+ 单测 | **S**（0.25d） |
| ③ chat + workspace-shell 域映射 | §2 表落地：mono 白名单 ~14 处、`StatusLine.tsx` 整条（含 `text-base` 野字号）、字号迁移 ~40 处（`text-xs` 37 + `text-[10/11px]` 15）、tracking 6~8 处、**tabular-nums ~14 处**、阅读栏 token + 4 条单测 | **M**（1d） |
| ④ chat 外复核扫描 | `source-control/` `git/` `files/` `sessions/` 的 diff/路径/hash 面逐屏复核补 mono | **M**（0.5~1d） |
| ⑤ 基线与文档 | A07 v4 追记 + 顶部标注、phase0a 同构、design-system 五节改写、新建 a09 A/B 页 | **M**（0.5d） |
| ⑥ 断言与截图 | §6 的 6 条静态/DOM 断言 + 三测点 A/B 截图 | **S~M**（0.5d） |

**合计 ≈ 3.25~3.75d（L）。** 其中 ①②②b③ 是主干（1.75d），④ 是不可省的复核尾巴，⑤⑥ 是工程规范要求的凭证。

**建议施工序**：① → ⑥的断言先落（"先定验证再改代码"，工程规范第 12 条）→ ② → ③ → ④ → ⑤。

---

## 6. 决策六 · 验收口径

### 6.1 三测点（沿用 open-q #10 原定，不新增）

| # | 测点 | 与参照图的对照点 |
|---|---|---|
| ① | **Chat 阅读栏正文**：45rem 下的中文段落 + 中英混排 | Cursor 图 user 气泡 + assistant 段落（CJK 与拉丁同行的基线、标点、行内节奏） |
| ② | **左栏 Session 树**：中文标题 + 分支 chip + 相对时间同行 truncate | Cursor 图侧栏 `Session refactor options 50m` / `OpenChamber chat refactor … 6d` |
| ③ | **工具行摘要**：中文工具人类名 + 拉丁路径同行 | Cursor 图 `Finished Static server for final doc verification`（比例）+ 行内 `WorkspaceShell.tsx`（mono chip） |

每个测点出 **三张图**：现状(mono) / D25(split) / Cursor 参照，同尺寸并排 → 落进新建的 `docs/design/a09-font-domain-baseline.html`（这份页面同时充当 A07 冻结后缺失的新视觉凭证 + 工程规范第 10 条要求的对比报告）。

### 6.2 量化指标（可判定通过/不通过）

| 指标 | 现状 | 目标 | 测法 |
|---|---|---|---|
| **侧栏标题可见字符数** | **13**（等宽 14px，advance 8.4px，实得 ≈112px） | **≥16**（比例 advance ≈7.0px，+20%） | 固定标题串 `Session refactor options`，量到截断位 |
| **阅读栏 CJK 字/行** | 51.2 @48rem | **48 ± 2**（= Cursor 实测） | 中文段落取样计数 |
| **字重可辨** | semibold/bold **0 处**，medium 12 处**部分失效** | 400 与 600 并置，200% 放大目视可辨；**Win10 必测**（确认落到 Segoe UI Semibold 而非合成） | 同屏并置截图 |
| **数字不抖** | 未测 | 计时器跑 10s，逐帧 x 位置位移 = 0 | 录屏抽帧 |
| **mono/sans 光学配平** | N/A | 行内 13px mono 的视觉高度 ≤ 15px sans 正文 | 并置截图 |
| **CJK/Latin 基线** | 未测（open-q #10 的原始风险） | 同行 CJK 与拉丁基线重合 | 截图画辅助线 |
| **字号档位数** | **7 档**（10/11/12/13/14/15/16） | **≤5 档**（10 仅 mono 拉丁 /13/14/15/18） | rg 统计 |
| **tracking 使用点** | 7 处（其中 1 处即将删） | 6~8 处且**全部落在 §3.3 四档内** | rg 统计 |

### 6.3 确定性断言（工程规范第 4 条：先断言过程，再谈观感）

观感任务同样要可回归。六条可自动化：

| # | 断言 | 形式 |
|---|---|---|
| A1 | `font-mono` 在 `src/renderer` 的出现点 ⊆ 文件白名单（`ui/ident.tsx` `ui/code-block.tsx` `ui/mermaid-renderer.tsx` + 显式豁免清单） | rg 静态扫描测试 |
| A2 | ToolRow 渲染后：`argKind==='ident'` 的 arg 含 `font-mono`；`argKind==='prose'` 的 arg（`Worked for 1s` / `Explored 2 files` / Bash description）**不含**；verb **永不含** | DOM 测试（给 verb/arg 加 `data-slot`，2 行可测性改动）。**至少各覆盖一例三分支** |
| A3 | `globals.css` 的 `--font-sans` **首项 ≠ `ui-monospace`**，`--font-mono` **首项 = `ui-monospace`**（防回退） | 文本断言 |
| A4 | `readingColumnClass('normal') === 'max-w-reading'`（`shellLayoutModel.test.ts:304-317` 四例更新） | 现有单测改值 |
| A5 | 无元素同时具备 `font-mono` 与非零 `tracking-*`（OTP 一处白名单） | rg 静态扫描 |
| A6 | 禁用类名清零：`text-xs` / `text-base` / `text-[10px]` / `text-[11px]` 在 `chat/` + `workspace-shell/` 出现 **0 次** | rg 静态扫描 |

**Feature flag 对拍（工程规范第 6 条）**：`html[data-font-domain="mono"|"split"]` 两态各跑一遍三测点截图，产出对比报告。flag 默认 `split`，保留一个版本周期后删除。

### 6.4 通过门槛

- 三测点 **全部**出 A/B/参照三图并入 `a09` 页；
- 量化指标表 **8 项全绿**（Win10 与 macOS/Linux 至少各一台；Win10 是字重矩阵的最弱环，必测）；
- A1~A6 **六条断言进 CI 的 main 层回归**；
- open-q #10 的 `lowercase` 六处豁免同批目视复核（原 #10 验收要求，不因结项而免测）。

---

## 附录 A · 与已有条目的连带关系

| 条目 | 关系 |
|---|---|
| **P-12**（字号收敛四档） | 目标从「10/13/14/15」修正为「10(仅 mono 拉丁)/13/14/15/18」，见 §3.1 |
| **P-13**（三行无层级） | D25 后正文可用 `font-semibold`(600) 而非失效的 `font-medium`(500)，见 §3.2 |
| **P-19**（顶栏标题倒挂） | 同上，600 可靠后这条更好解 |
| **P-24**（侧栏一行两处截断） | 比例字体 +20% 字符，**部分自解**；A07 `:1346` 的 112px 前提要复算 |
| **P-27**（段头回归 A07 `:1339`） | **数值不变**，只改理由句，见 §4.2 |
| **P-15 / P-05**（三级灰、destructive alpha） | 与字体正交，不受影响。⚠️ 但 §1.4 拒绝 `-webkit-font-smoothing` 正是为了保住 P-15 修出来的对比度 |
| **P-30**（发送键） | A07 `:2839` 的「等宽下 Send 偏宽」论据失效，`:2838` 结论不受影响 |
| **专题 c / Markdown 渲染（T-新①）** | M1/M2（代码块/行内 code）的字体口径由本规格提供；两任务顺序无强依赖，但 ChatMarkdown 落地时必须用 §2.5 的 `<CodeInline>` 原语 |
| **open-q #10** | 已于 2026-07-30 结项并升级为 D25；本规格是其落地解 |
| **open-q #12**（ghostty/Monaco） | **正交，无依赖**（§5.3 实证：`ghosttyTheme.ts` 零 font 引用） |
| **open-q #1 / C-15**（产物体积） | §1.2 理由 3 引用其为"随包资产敏感"先例；本规格选系统栈 ⇒ **D25 对产物体积零增量** |

## 附录 B · 一句话摘要

> 把 `globals.css` 的三行字族 token 换成「系统比例栈 + 系统等宽栈（Latin 先 / CJK 后、禁 `system-ui`、零随包）」，UI 默认走比例、mono 收进一张按**「内容 vs 控件」**判据划定的白名单（代码块 / 行内 code / 工具行输出与 **ident 型**参数 / diff / 路径 / hash / kbd / 终端 / 编辑器）；同批给 `ToolRowView` 加 `argKind` 解决 arg 槽多态、把阅读栏从 48rem 收到 45rem（= Cursor 实测的 48 CJK 字/行）、把字重梯度从"1 档可用"恢复到"400+600 全平台可靠"、把 letter-spacing 从"全域 1 处"接成四档梯度并加两条 CJK 禁令、给 ~14 处会跳变的数字补 `tabular-nums`；A07/phase0a **冻结原型渲染层、只加顶部时效标注与 v4 追记段**，design-system 五节就地改写；总量 ≈3.5d，其中真正的主干 1.75d，其余是复核尾巴与验收凭证。

