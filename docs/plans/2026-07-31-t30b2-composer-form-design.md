# T-30 批 2 · Composer 形态对齐 Cursor · 施工规格

> 立项来源：第三轮 GUI 点验第 9 条 —— 「（D25 三处）字体没问题，但聊天框（composer）形态与 Cursor 有差异，**过于圆润、AI 化**；参照截图尽量一比一。」
> 长期目标（用户原话）：「我希望能做到 Cursor 那种协调的美感」。
> 与 **D25 分域字体**（`docs/plans/2026-07-30-d25-font-domain-design.md`）**同批**（T-30 批 2），合并施工序见 §8。
> 本规格只定形态（几何 / 结构 / 色阶 / 控件形制），**不碰字体**（字体归 D25）、**不碰 Flexoki 调色板与 token 分档**。

---

## 0. 一句话结论

**「圆润 / AI 化」不来自 Composer 卡本身的圆角，而来自卡内两个 `SelectTrigger` 被渲染成了「带边框 + 阴影 + 内高光的满圆胶囊」，以及聚焦时整条卡框变成品牌橙。**
实测证据：Model/Effort 触发器写的是 `rounded-lg`（16px）挂在 `h-6`（24px）上，CSS 会把半径钳到 `h/2 = 12px` —— 即**渲染为满圆 pill**；同时带 `border-input` + `shadow-xs` + `before:shadow` 内高光。A07 对同一位置的裁定是 `.sel { border-radius: var(--r-sm) /*8px*/; }` **无边框、无阴影** —— 也就是说，这不是一个「要不要改设计」的问题，**是实现从来没有对齐过 A07 自己的裁定**。

同一测量还翻出三条 A07 自身的算术 / 目测错误（§3.3），修掉它们之后，本仓与 Cursor 的几何差在 ±4px 以内。

---

## 1. 测量方法与 DPR 假设

### 1.1 方法

- 工具：Pillow 逐像素扫描（无 numpy）。边界判据 = 行/列扫描的颜色跃变点；圆角半径 = 对左上角「每行最左暗像素」序列做圆弧方程拟合 `x(y) = cx − √(r² − (cy−y)²)`，取残差最小的 r。
- 色值：取笔画/填充区**众数最暗 bin**（抗抗锯齿），再换算 OKLab 的 L 以便与本仓 `oklch()` token 直接比较（换算脚本为标准 OKLab 矩阵，非近似）。
- **实测值与估值分开标注**：表中「实测」列为像素直读；「CSS」列为按 §1.2 的 DPR 折算后的推断值，标 `≈` 者为折算后取整。

### 1.2 DPR 假设（必读，全部数值依赖它）

| 素材 | DPR 判定 | 判据（三条独立互证） |
|---|---|---|
| Cursor 两张参照图<br>`ScreenShot_2026-07-31_085350_619.png`（follow-up 态）<br>`ScreenShot_2026-07-31_085405_250.png`（新建态） | **1.25** | ① 两图的 ⊕ / 麦克风圆钮**都是 30 device px**，说明两图同尺度，可互证；② follow-up 卡外高 52 device，按 `1px 边框 + 8px padding + 24px 内容` 折算得 42 CSS → 42×1.25 = 52.5，渲染 52 ✓；padding 11 device = 1 边框 + 10 = 8 CSS×1.25 ✓；③ 关键反证：action pill 的上下边框各占**两行**（240/241、243/240），而卡边框占**一行** —— 同一份 1px CSS 边框有时 1 行有时 2 行，**只可能出现在分数 DPR**；DPR=1.0 下全部 1px 边框必然恒为 1 行。 |
| 本仓现状图 `ScreenShot_2026-07-31_084744_891.png` | **1.0** | Stop 圆钮实测 28×27 px，与代码 `size-7`（28px）逐像素吻合；背景实测 `rgb(255,253,244)` = `--background` 精确值。 |
| 本仓现状图 `ScreenShot_2026-07-30_234142_290.png` | **≈1.375**（截图被缩放过） | 卡外高 55 device / 40 CSS 契约 = 1.375；圆角 15 device / 12px `rounded-md` = 1.25~1.375；Stop 圆 37 device / 28 = 1.32。三者不完全自洽 ⇒ 判定为**缩放过的截图**，只用于定性对照，**不取其数值**。 |

> 若后续用户能提供 Cursor 的 DPR（或在 100% 缩放下重截），本规格 §2 的 CSS 列应重新折算一次。DPR 若实为 1.0，则 Cursor 的所有尺寸放大 25%（圆钮 30px、卡高 52px、padding 10px），**结论中的「形制」判断全部不变，只有绝对像素变**。

---

## 2. 实测数据表

### 2.1 Cursor follow-up 态（会话中）—— `085350_619.png`

| 元素 | 实测 (device px @1.25) | CSS ≈ | 色值 / L | 备注 |
|---|---|---|---|---|
| 页面底 | — | — | `#F8F8F8` / L 0.9791 | |
| 卡填充 | — | — | `#FCFCFC` / L 0.9911 | **比页面亮 +0.012 L** |
| 卡边框 | 1 | 1 | `#DFDFDF` / L 0.9037 | 卡−框 ΔL = **0.087**（聚焦态） |
| 卡外框 | 955 × 52 | 764 × **42** | — | 42 = 1+8+24+8+1 |
| 卡圆角 | **26**（= h/2） | **21 = pill** | — | 圆弧方程拟合 r=26、圆心 (59,732)，四个采样点残差 ≤1px |
| 卡阴影 | **无** | 无 | — | 卡边框外相邻 8 行恒为 248，零渐变 |
| 内 padding | 11（含 1px 边框） | **8** | — | 上下左右一致 |
| ⊕ 圆钮（最左） | 30 | **24** | 底 `#EAEAEA` / L 0.9370；描线 `#6B6B6B` | 与「卡边框（静息态）」同一灰阶 |
| ⊕ → textarea 间距 | 10~12 | **8** | — | |
| placeholder `Send follow-up` | 字面 cap 13 | — | `#A8A8A8` / L 0.7316 | |
| 模型标签 `Sonnet 5` | ink x 814–874 | — | `#474747` / L 0.3979 | 基名 |
| 档位后缀 `High` | ink x 882–913 | — | `#141414` / L 0.1913 + 视重更粗 | **后缀比基名更深、更重** |
| chevron | ink x 923–931 | — | ≈`#8F8F8F` | 单个 chevron，一体式触发器 |
| 麦克风圆钮（最右） | 30 | **24** | 底 `#141414` / L 0.1913，字形白 | 本仓**不搬**（§10） |
| action pill（卡上方） | 高 35，圆角 13，间距 5 | 高 **28**，圆角 **≈10**，间距 **4** | 边框 `#EAEAEA`，底 `#FCFCFC` | 三枚：`Changes +10279` / `Continue Working` / `Commit & Push ⌄` |
| pill 行 → 卡 | 10 | **8** | — | |
| 卡 → 目标行 | ~17（含行盒） | **8** | 目标行 ink `#6F6F6F` / L 0.5417 | 目标行**无边框、无底色** |

### 2.2 Cursor 新建态（empty state）—— `085405_250.png`

| 元素 | 实测 (device px @1.25) | CSS ≈ | 色值 / L | 备注 |
|---|---|---|---|---|
| 卡外框 | 760 × 125 | 608 × **100** | — | |
| 卡边框 | 1 | 1 | `#EAEAEA` / L 0.9370 | 卡−框 ΔL = **0.054**（静息态） |
| 卡圆角 | **16** | **≈12~13** | — | 圆弧拟合 r=16、圆心 (322,408)，四采样点残差 ≤1px（r=13/r=14 拟合明显更差） |
| 内 padding | 11（含边框） | **8** | — | 四边一致 |
| textarea 区高 | 73 | **≈58** | placeholder `#A8A8A8` | 单行 placeholder 顶到内容顶 |
| 底行（⊕ + 模型） | 30 | **24** | — | |
| 模型基名 `Kimi K3` | — | — | `#505050` / L 0.3979 | |
| 模型后缀 `Max` | — | — | `#717171` / L 0.5486 | 此处后缀更**浅**（无 effort，末词是型号变体） |
| 目标行（在卡**上方**） | ink 底 378 → 卡顶 392 | **8** | ink `#6F6F6F` | `ai-client ⌄  feat/… ⌄  🖥 This PC ⌄` |

> **两态半径不同是实测事实，不是噪声**：follow-up r/h = 26/52 = **0.500**（数学上的 pill），empty r/h = 16/125 = **0.128**。同一份 UI、同一 DPR、同一次截图。Cursor 的规则是「单行条 → 胶囊；多行卡 → 12px 圆角」。

### 2.3 本仓现状（代码直读，非截图推断）

| 元素 | 现状类名 | 实际渲染 |
|---|---|---|
| 卡（session） | `rounded-md border border-input bg-card focus-within:border-ring flex min-h-10 items-center gap-2 px-2 py-1` | 12px 圆角 / 40px 外高 / 边框 `--input` L 0.8463 / **聚焦变品牌橙 `--ring` C=0.1523** |
| 卡（empty） | `rounded-md border border-input bg-card focus-within:border-ring px-3 py-2.5` | 12px / 高 ≈108px（1+10+56+6+24+10+1） |
| 卡填充 | `bg-card` L 0.9837，中列底 `bg-background` L 0.9931 | **卡比页面暗 −0.0094 L（极性与 Cursor 相反，亮色）**；暗色下 card 0.2197 > bg 0.1981，**极性正确** |
| Model 触发器 | `<SelectTrigger size="sm" className="h-6 min-h-6 sm:min-h-6 w-auto min-w-26 gap-1 px-2 text-xs">` | 基类含 `rounded-lg`(16px) `border border-input` `bg-background` `shadow-xs` `before:shadow-[0_1px_…]` `ring-ring/24`；**16px 半径在 24px 高上被钳到 12 = 满圆 pill**；宽 `min-w-26` = **104px** |
| Effort 触发器 | 同上 | 同上，再 104px |
| 两枚合计 | — | **实测 106 + 8 + 106 = 220px** 的带框胶囊，占 follow-up 条右半 |
| 圆形动作键 | `roundActionButtonClass()` = `size-7 rounded-full …` | **28px**；`send`/`enqueue` = `--primary` 橙实心，`stop` = `--destructive` 红实心，可同时出现两枚 |
| ⊕ 附件钮 | **不存在**（T-28 明示不实现，见 `ledger-claude-mainline.md` 2026-07-29 行「A07 偏离入档 ①」） | 卡最左为空 |
| 目标行触发器 | `inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 …hover:bg-hover` | `rounded-md`(12) 在 `h-6`(24) 上 → hover 底同样钳成**满圆 pill** |
| 目标行整体 | `mt-2 / mb-2 flex h-6 items-center gap-1` | 8px 间距 ✓、无边框 ✓ —— **已对齐** |
| 问答 dock → 卡 | `QUESTION_DOCK_WRAPPER_CLASS = 'shrink-0 px-6 pb-2'` + `middleColumnHostClass('session')` 的 `pt-1.5` | **8 + 6 = 14px**，A07 明写 8px（`:2709` `.qa style="margin-bottom:8px"`） |
| 队列 strip → 卡 | `QueuedMessageStrip` 外层 `mb-1.5` | **6px**，同上应为 8px |
| 静息状态行（empty 态） | `shouldShowStatusLine` 在 empty 恒 true | 常驻一行 `Ready · cwd: /home/dan/…`，Cursor 无对应物 |

---

## 3. 「过于圆润 · AI 化」的量化归因

按贡献从大到小。**前三条合计解释了绝大部分观感差**，且**三条都不需要改任何 token 档位**。

### 3.1 第一位：卡内两枚控件是「带框带阴影的满圆胶囊」（占比最大）

| 量 | 本仓 | Cursor | A07 v3 明文裁定 |
|---|---|---|---|
| 形制 | `SelectTrigger`（输入控件原语） | 纯文字 + chevron | `.sel`：`height:24; padding:0 6px; border-radius:var(--r-sm)/*8px*/; color:var(--foreground); cursor:pointer; .sel:hover{background:var(--hover)}` —— **无 border、无 shadow** |
| 圆角 | `rounded-lg` 16px → **钳到 12 = h/2 = 满圆** | 无（纯文字） | 8px |
| 边框 | `border-input`（本仓最重的中性边） | 无 | 无 |
| 阴影 | `shadow-xs` + `before:shadow-[0_1px_black/4%]` 内高光 | 无 | 无（A07 `:1337`「按钮、卡片一律零阴影」） |
| 宽度 | 104 + 104 = **208px 固定下限** | 一体式 ≈96px | 内容自适应 |
| 数量 | **2 枚 chevron** | 1 枚 | 2 枚 |

> 「满圆 + 柔和阴影 + 内高光 + 固定宽 + 成对出现」正是通用 AI 聊天产品的输入条语汇。**这是 `AI 化` 三个字的物理来源。**
> 注意：这**不是**一次设计改判 —— A07 早就写了 `.sel` 是无框文字 chip，实现选了 `SelectTrigger` 原语，把 `min-h-8/sm:min-h-7`、`rounded-lg`、`shadow-xs`、`border` 一起带了进来（Round-2 已经为其中的 `min-h` 泄漏打过一次补丁，见 `ModelSelect.tsx` 注释）。**改回无框文字 chip = 回到 A07 合规，不需要用户拍板。**

### 3.2 第二位：聚焦时整条卡框变品牌橙

`focus-within:border-ring`，`--ring` = `--primary` = `oklch(0.5665 0.1523 45.02)` = `#BC5215`，**C = 0.1523**。
Cursor 的对应行为：边框由 L 0.9370 → L 0.9037，**ΔL = 0.0333，色度恒为 0**。

本仓有现成的等价梯度：`--border`(L 0.8810) → `--input`(L 0.8463)，**ΔL = 0.0347**。与 Cursor 的 0.0333 几乎逐位重合。

| | 静息 | 聚焦 | 卡−框 ΔL（静息） |
|---|---|---|---|
| Cursor | `#EAEAEA` L 0.9370 | `#DFDFDF` L 0.9037 | 0.054 |
| 本仓现状 | `--input` L 0.8463 | `--ring` L 0.5665 **+ C 0.1523** | **0.137**（Cursor 的 2.5×） |
| 本仓目标 | `--border` L 0.8810 | `--input` L 0.8463 | 0.103（Cursor 的 1.9×，色度 0） |

> A07 `:1336` 为「用 `--input` 做卡边框」写的理由是：「用它替代 **Cursor 靠阴影做出的「浮起」**」。
> **这个前提被实测证伪**：Cursor 的卡**没有任何阴影**（边框外 8 行像素恒为背景值，零渐变），它的「浮起」来自「卡填充比页面亮一档 + 一条极淡发丝边」。既然前提不成立，`--input` 这一档的必要性也随之消失。

### 3.3 第三位：三处 A07 自身的算术 / 目测错误被实现照搬

| # | A07 原文 | 实测事实 | 后果 |
|---|---|---|---|
| E1 | `:1844`「follow-up 单行卡：高 **40px**（内容 24 + 上下 8）」 | 24 + 8 + 8 = 40，**漏算 2px 边框**，真值 42 | T-28 期 Codex 抓到实现渲染 42px，判为 blocker，于是**保留 28px 圆钮、把 padding 挤到 5px** 硬凑 40 —— 修错了方向。正确解是「内容回到 24、padding 回到 8、承认 42」 |
| E2 | `:1329`「Cursor 发送键**目视约 36px**，收档到 28」 | Cursor 圆钮实测 **30 device @1.25 = 24 CSS**（⊕ 与麦克风同尺寸，两图互证） | 「36→28 收档」这条推理的输入值错了 25%；正确值 24 = A07 自己的 `--h-btn`，**不需要 `--h-row` 这一档** |
| E3 | `:1334`「Cursor 的 follow-up 输入近 pill 圆角，**收档到 12**，不引入新圆角档」 | follow-up **就是** pill（r = h/2 = 26 device，圆弧方程四点残差 ≤1px），**不是「近」pill** | 见 §9 待拍板 ② |

> E1+E2 修正后，Composer 内所有控件统一为 **24px = `--h-btn` = `h-6`**（⊕ / 模型 chip / 圆钮 / 目标行按钮全同档），卡高自然落到 42px。这条「一个高度档吃穿整个 Composer」正是 Cursor 那份「协调感」的骨架。

### 3.4 第四位：圆形动作键的饱和度与数量

| | 本仓 | Cursor |
|---|---|---|
| 直径 | 28px | 24px |
| send / enqueue | `--primary` `#BC5215` C=0.1523 实心 | `#141414` C≈0 实心 |
| stop | `--destructive` `#AF3029` C=0.1648 实心 | （运行态未截到，Cursor 通常同为深中性） |
| 同屏最多 | **2 枚**（retry + send / stop + …） | 1 枚 |

现状图 `084744_891.png` 里，右下角是「红圆 + 橙圆」并排 —— 两枚高饱和实心圆 + 两枚满圆胶囊，四件圆形物挤在 220px 内。

### 3.5 第五位：目标行触发器同样是满圆

`TargetFolderSelect` / `TargetBranchSelect` 触发器写 `rounded-md`(12px) 挂 `h-6`(24px) → hover 底钳成满圆。A07 `.tgt-btn` 明写 `border-radius: var(--r-sm)`（8px）。同 §3.1 的成因，同样属**实现未对齐 A07**。

### 3.6 归因结论一句话

> **圆润应该只属于最外层容器一件事，不该同时属于容器和它内部的每一个小控件。**
> Cursor 的做法：外层胶囊（r = h/2）+ 内部全部方正文字（零圆角背景，只在 hover 时给 8px 底）。
> 本仓现状：外层 12px + 内部四件满圆 —— 层级反了，所以「哪儿都圆、哪儿都不锐利」。

---

## 4. 逐元素差异表（现状 → 目标 → 裁定）

裁定列图例：**改** = 本批施工；**不改** = 明示保持；**拍** = 需用户拍板（§9）；**诚实** = 有意不对齐（§10）。

### 4.1 卡容器

| 元素 | 现状 | 目标（Cursor 实测 → 本仓 token） | 裁定 |
|---|---|---|---|
| 圆角 · session | `rounded-md` 12px | Cursor = pill（r=h/2） → `rounded-full` | **拍 ②**（推荐采纳；`rounded-full` 不是新圆角档，`.send` 已在用 999px） |
| 圆角 · empty | `rounded-md` 12px | Cursor ≈12~13px → `rounded-md` **不动** | 不改 |
| 边框色 · 静息 | `border-input` L 0.8463 | Cursor L 0.9370（卡−框 ΔL 0.054）→ `border-border` L 0.8810（ΔL 0.103） | **改** |
| 边框色 · 聚焦 | `focus-within:border-ring`（品牌橙 C 0.1523） | Cursor 聚焦 ΔL 0.0333 且零色度 → `focus-within:border-input`（ΔL 0.0347，零色度） | **改** |
| 边框宽 | 1px | 1px | 不改 |
| 阴影 | 无 | 无（Cursor 实测零阴影，A07 `:1337` 同） | 不改 |
| 填充 | `bg-card`（亮色下比页面**暗** 0.0094 L） | Cursor 卡比页面**亮** 0.012 L | **诚实**（§10-C：Flexoki 纸张层级为已验收调色板；暗色下极性本就正确；亮色 ΔL 0.009 低于大面积色块可辨阈；改它要动 `--card`，越界） |
| padding · session | `px-2 py-1`（8/4，实效上下 5px） | 8px 四边 → `p-2` | **改** |
| padding · empty | `px-3 py-2.5`（12/10） | 8px 四边 → `p-2` | **改**（两态共用一个 padding，A07 的 10/12/8 三值不对称属目测残留） |
| 静息高 · session | `min-h-10` = 40px（E1 的错误算术） | 1+8+**24**+8+1 = **42px** | **改** → `min-h-10.5`（42px，落在 0.25rem 间距刻度上，非任意值）；同步改 `middleColumnLayout.test.ts:174` 那条断言 |
| 静息高 · empty | ≈108px | 1+8+56+6+24+8+1 = **104px**（Cursor 100，Δ4） | **改**（padding 连带） |
| 行内 gap · session | `gap-2`(8) | 8 | 不改 |

### 4.2 textarea

| 元素 | 现状 | 目标 | 裁定 |
|---|---|---|---|
| min-h · session | `[&_textarea]:min-h-6` 24 | 24 | 不改 |
| max-h · session | `[&_textarea]:max-h-14` 56 | 56 | 不改 |
| min-h · empty | `min-h-14` / `[&_textarea]:min-h-14` 56 | Cursor ≈58 | 不改 |
| leading | `[&_textarea]:leading-6` | — | 不改（D25 会改字号，行高由 D25 复核） |
| 字号 / 字族 | — | **D25 S7 管辖**（15px sans） | 归 D25 |
| placeholder 色 | `text-muted-foreground` L 0.5111 | Cursor L 0.7316（更浅） | **诚实**（§10-D：本仓 placeholder 承载的是**状态语义**（`Agent Host is running — your message will be queued…`），不是装饰性提示；调浅会削弱可读性。记为已知差） |

### 4.3 模型选择器 / Effort

| 元素 | 现状 | 目标 | 裁定 |
|---|---|---|---|
| 形制 | `SelectTrigger`：`rounded-lg`(→钳满圆) + `border-input` + `bg-background` + `shadow-xs` + `before:shadow` 内高光 + `ring-ring/24` | A07 `.sel`：无框无阴影文字 chip，`h-6 rounded-sm px-1.5`，`hover:bg-hover`，`data-[popup-open]:bg-selection` | **改**（A07 合规修复，无需拍板） |
| 宽度 | `min-w-26` = 104px × 2 | 内容自适应，无 min-width | **改** |
| 数量 | 2 个触发器、2 个 chevron | Cursor = **1 个一体式** `Sonnet 5 High ⌄` | **拍 ①**（推荐合并；代价见 §9） |
| 标签构成 | `Sonnet` / `Default`（两串各自独立） | `{model} {effort}`，effort=Default 时**整段后缀省略** | 随拍板 ① |
| 双色 | 无 | Cursor：基名 L 0.398、effort 后缀 L 0.191 + 视重更粗 | **拍 ①-b**（推荐 1:1 采纳：基名 `text-muted-foreground`，后缀 `text-foreground font-medium`） |
| chevron | Select 自带（`size-4` 双向 ⇕） | 单向 `ChevronDown size-3.5 text-muted-foreground`（与目标行触发器同款） | **改** |
| 位置 · session | 卡内单行，textarea 之后 | Cursor 同 | 不改 |
| 位置 · empty | 卡内底行右侧（与圆钮同组） | Cursor：底行**左**侧（⊕ 之后），圆钮在**右** | **改** |
| 禁用态 | `disabled={disabled \|\| busy \|\| sending}` | — | 不改（行为契约，非形态） |

### 4.4 目标行（文件夹 / 分支 / 运行位置）

| 元素 | 现状 | 目标 | 裁定 |
|---|---|---|---|
| 位置 | empty 在卡上、session 在卡下 | Cursor 同 | 不改 ✓ |
| 边框 / 底色 | 无边框，hover 才有底 | Cursor 同（纯文字 + chevron） | 不改 ✓ |
| hover 底圆角 | `rounded-md` 12px 挂 `h-6` → 钳满圆 | A07 `.tgt-btn` = `--r-sm` 8px → `rounded-sm` | **改** |
| 行高 / gap | `h-6` / `gap-1`(4) / 控件内 `gap-1.5`(6) | A07 `:1613` 24 / 4 / 6 | 不改 ✓ |
| 行 ↔ 卡间距 | `mt-2` / `mb-2` = 8px | Cursor ≈8px | 不改 ✓ |
| 文字色 | folder `text-foreground`；branch/runloc `text-muted-foreground` L 0.5111 | Cursor 全行 L 0.5417 | 不改（差 0.03 L，可忽略） |
| 字号 / 字族 | — | **D25 S9/S10 管辖**（含 §2.3 的分支 mono/sans 待拍板） | 归 D25 |
| session 态槽位 | 只留 branch + runLocation | A07 `:1845` 同、Cursor follow-up 图同 | 不改 ✓ |

### 4.5 圆形动作键（send / stop / retry / enqueue）

| 元素 | 现状 | 目标 | 裁定 |
|---|---|---|---|
| 直径 | `size-7` = 28px | Cursor 实测 24px（E2 修正）= `--h-btn` = `size-6` | **改** |
| 图标 | `size-3.5`(14) | 24px 圆内配 12px → `size-3` | **改** |
| send / enqueue 配色 | `variant="default"` = `--primary` 橙实心 | Cursor `#141414` 深中性 → `bg-foreground text-background` | **拍 ③**（推荐采纳；这是 A07 `:2838` 裁定的翻案，必须用户点头） |
| stop 配色 | `variant="destructive"` 红实心 | — | 不改（红色 Stop 是本仓已建立的安全语义，且同屏最多一枚） |
| retry 配色 | `variant="outline"` | — | 不改（改 `rounded-sm` 边框半径随 `roundActionButtonClass` 统一为圆） |
| 形状 | `rounded-full` + 三件套 squircle 覆写 | 同 | 不改 |
| 位置 | 行末（`margin-left:auto` 语义由 flex 顺序实现） | Cursor 同 | 不改 |
| 同屏可现 2 枚 | `deriveActionButtons` 决定 | Cursor 恒 1 枚 | 不改（`retry + send` 并存是本仓失败可恢复性的一部分，A06 诚实性优先于形态 1:1） |

### 4.6 ⊕ 附件 / 上下文钮

| 元素 | 现状 | 目标 | 裁定 |
|---|---|---|---|
| 存在性 | **不存在**（T-28 明示不实现：「无附件选择能力，落死按钮违 A06」） | A07 `.icon-btn` 有；Cursor 两态都有，恒在**卡最左** | **改 —— 实现，但换成真能力**（见下） |
| 能力绑定 | — | 点击 = 在光标处插入 `@` 并唤起既有文件搜索 popup（`extractMentionQuery` / `fileMention.ts` 全套已存在） | **改** |
| 为什么不做「真附件」 | — | `dialog.openFile` 只返回路径（`preload/index.ts:542`），本仓**没有** renderer 侧「读文件为字节」的 IPC；补一条要动 protocol + main + preload + 限额 + 测试，远超形态批范围 | 记入执行计划的 ideas |
| a11y / 提示 | — | `aria-label="Add file context"`、`title="Add file context (@)"` —— **文案必须说清它加的是引用不是附件**，否则又是一次不诚实 | **改** |
| 形制 | — | A07 `.icon-btn`：`size-6 rounded-sm grid place-items-center text-muted-foreground hover:bg-hover`；图标 `Plus size-3.5` | **改** |
| 禁用条件 | — | 与 textarea 同门（`disabled \|\| !activeSessionId`），**不随 busy 禁用**（T-19 已解禁运行中输入） | **改** |

> 这条同时**结清** T-28 入档的 A07 偏离①。粘贴附件（T-18）能力不受影响，两条路并存。

### 4.7 队列 strip / 问答 dock / action pills 区（卡上方带）

| 元素 | 现状 | 目标 | 裁定 |
|---|---|---|---|
| Cursor 的 action pills（`Changes +10279` 等） | 无对应功能 | **不做** | **诚实**（§10-A；A07 全文无此物，`:2843` 裁定④ 已判「空态卡下不放快捷入口」，同精神） |
| 卡上方带的**几何**（本仓用它放 strip / dock） | strip `mb-1.5`(6)、dock `pb-2`(8) + host `pt-1.5`(6) = 14 | Cursor pill 行 → 卡恒 **8px**；A07 `:2709` 问答折叠条 → 卡明写 `margin-bottom:8px` | **改**：`QueuedMessageStrip` 外层 `mb-1.5`→`mb-2`；`middleColumnHostClass('session')` 去掉 `pt-1.5`（改 `pt-0`），让上游三个来源（timeline `pb-2` / dock `pb-2` / strip `mb-2`）各自持有唯一的 8px |
| strip 行形制 | `h-7 rounded-sm border border-border bg-muted/50 px-2` | Cursor pill：`h-7` + 1px 边框 + 卡同色填充 + 圆角 ≈10 | 不改（`rounded-sm` 8px vs 10，差 2px；`bg-muted/50` 比 Cursor 的白填充更收敛，属可接受偏差） |
| strip 行间 gap | `gap-1`(4) | Cursor pill 间距 4 | 不改 ✓ |
| 问答折叠条 → 卡 | 14px（见上） | 8px | **改**（同上，一次改完） |

### 4.8 状态行（statusLine）

| 元素 | 现状 | 目标 | 裁定 |
|---|---|---|---|
| empty 态是否常驻 | `shouldShowStatusLine` 在 `mode==='empty'` **恒 true** → 常驻 `Ready · cwd: /home/dan/…` | Cursor 卡内**无**状态行 | **改**：empty 态改用与 session 态相同的判据（`sending \|\| reading>0 \|\| hasStatusError \|\| hasLargeHint`） |
| 信息不丢的补偿（**硬要求**） | cwd 全路径目前**只**出现在这条 statusLine | 目标行 folder 触发器补 `title={workspace.path}`；`!cwd` / `lastError` 时的红色 banner **不受影响**（它在卡外，`ChatComposer` 返回值第一段） | **改**（A06：删展示前必须先补可达路径） |
| session 态 | 已按需显隐 | 同 | 不改 ✓ |
| 位置 · session | textarea 与模型 chip 之间 | Cursor 无 → 保持现位，`min-w-0 shrink truncate` 保证不挤走模型 chip | 不改 |
| 位置 · empty | 底行左侧 `flex-1` | 改为底行左侧、在 ⊕ 与模型 chip **之后**，`min-w-0 flex-1 truncate` | **改**（底行左段顺序：⊕ → 模型 chip → statusLine，右段：圆钮） |

---

## 5. 两态 DOM / class 装配表

### 5.1 状态判据与切换点（**不变**）

- 判据仍是 `deriveMiddleColumnMode`（`middleColumnLayout.ts`，七规则短路），**本规格不新增、不修改任何一条规则**，其 13 例既有单测作为回归护栏原样保留。
- 切换点仍是 `ChatWorkspace` 一处 `<ChatComposer mode={mode} …/>`，**单一稳定 JSX 槽位、只换 class 不卸载**（T-28 设计期 R4 红线：两态分支若卸载组件会打断在飞的 `runSend` 导致二次发送）。本规格**继承该红线**：§5.2/§5.3 的两棵树必须由**同一个** `<ChatComposer>` 内部的 `mode ===` 三元分支渲染，**不得**拆成两个组件。
- 两态**结构确实分叉**（单行 vs 双行），分叉点与现状一致：`ChatComposer.tsx` 的 `mode === 'session' ? (…) : (…)`。

### 5.2 empty 态（目标行在卡上方）

```
<ReadingColumn>                                   ← 不变
  ├─ [error banner]                               ← 不变（lastError / !cwd）
  ├─ <ComposerTargetBar mode="empty">             ← 不变（位置）
  │    └─ div  targetRowClass('empty')            = "mb-2 flex h-6 items-center gap-1"
  │         ├─ TargetFolderSelect   trigger: targetTriggerClass()          ★改 rounded-sm
  │         ├─ TargetBranchSelect   trigger: targetTriggerClass('muted')   ★改 rounded-sm
  │         └─ RunLocationIndicator "inline-flex h-6 cursor-default items-center gap-1.5 px-1.5 text-muted-foreground"
  └─ div  composerCardClass('empty')
       = "relative rounded-md border border-border bg-card focus-within:border-input p-2"   ★改
       ├─ [mention popup]  mentionPopupPlacementClass('empty') = "top-full mt-1"   ← 不变
       ├─ <Textarea>       composerTextareaClass('empty')                          ← 不变
       ├─ noticeBlock / queueNoticeBlock / attachmentChipsBlock / mentionChipsBlock ← 不变
       └─ div  composerBarClass('empty') = "mt-1.5 flex items-center gap-2"        ★改 gap-1.5→gap-2
            ├─ button      composerAttachButtonClass()                             ★新增
            │              = "grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground
            │                 transition-colors duration-150 hover:bg-hover
            │                 disabled:pointer-events-none disabled:opacity-64"
            │                 └─ <Plus className="size-3.5" />
            ├─ <ComposerModelTrigger>  composerModelTriggerClass()                 ★改（拍板 ①）
            │              = "inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5
            │                 hover:bg-hover data-[popup-open]:bg-selection
            │                 disabled:pointer-events-none disabled:opacity-64"
            │    ├─ span composerModelBaseClass()   = "text-muted-foreground"
            │    ├─ span composerModelSuffixClass() = "text-foreground font-medium"  (effort≠Default 时才渲染)
            │    └─ <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ├─ renderStatusLine("flex min-w-0 flex-1 items-center gap-1.5")         ← 按需显隐（★改判据）
            └─ div "flex shrink-0 items-center gap-1.5"
                 └─ {actionButtons}   roundActionButtonClass() = "size-6 rounded-full …"  ★改 size-7→size-6
```

静息高：`1 + 8 + 56 + 6 + 24 + 8 + 1 = 104px`（Cursor 100，Δ4px 来自 textarea 56 vs 58 与 `mt-1.5`）。

### 5.3 session 态（follow-up，目标行在卡下方）

```
<ReadingColumn>
  ├─ [error banner]                                        ← 不变
  ├─ <QueuedMessageStrip>  外层 "mb-2 flex max-h-24 …"      ★改 mb-1.5→mb-2
  └─ div  composerCardClass('session')
       = "relative rounded-full border border-border bg-card focus-within:border-input
          flex min-h-10.5 items-center gap-2 p-2"                              ★改（rounded 拍板 ②）
       ├─ [mention popup]  mentionPopupPlacementClass('session') = "bottom-full mb-1"   ← 不变
       └─ div "flex min-w-0 flex-1 flex-col"                                   ← 不变（extras 堆叠层）
            ├─ [hasComposerExtras] div "mb-1 flex flex-col gap-1"  {notice…}   ← 不变
            └─ div "flex min-w-0 items-center gap-2"
                 ├─ button   composerAttachButtonClass()                       ★新增（最左）
                 ├─ <Textarea>  composerTextareaClass('session')               ← 不变
                 ├─ renderStatusLine("flex min-w-0 shrink items-center gap-1.5")  ← 不变
                 ├─ <ComposerModelTrigger>  composerModelTriggerClass()        ★改（拍板 ①）
                 └─ {actionButtons}  roundActionButtonClass()                  ★改 size-6
  └─ <ComposerTargetBar mode="session">
       └─ div targetRowClass('session') = "mt-2 flex h-6 items-center gap-1"   ← 不变
            ├─ TargetBranchSelect   ★改 rounded-sm
            └─ RunLocationIndicator ← 不变
```

静息高：`1 + 8 + 24 + 8 + 1 = 42px`（Cursor 实测 42 ✓）。

> **`hasComposerExtras` 与 pill 圆角的相互作用**：附件 chip / notice 出现时卡会长高（≥42px），此时 `rounded-full` 会把上下变成大圆弧，观感失控。
> **约束**：`composerCardClass('session')` 的 pill 只在**静息单行**成立。实现上给卡加 `hasExtras` 入参：
> `composerCardClass('session', { hasExtras: true })` → 用 `rounded-md`（12px）；`false` → `rounded-full`。
> 这是一个**纯函数分支**，可断言（F-A2b），不引入运行时测量。

### 5.4 既有硬契约的兼容确认

| 契约 | 出处 | 本规格的处置 |
|---|---|---|
| follow-up 静息高 | A07 `:1844`「40px」+ `middleColumnLayout.test.ts:174` | **改为 42px**，附 §3.3-E1 的算术证明与 Cursor 实测；测试同步改，并**升级为算术断言**（见 F-A2） |
| 单一 `<ChatComposer>` 槽位、两态不卸载 | T-28 R4 红线 | **继承，不动** |
| `QueuedMessageStrip` 挂载点（error banner 之后、卡之前、仅 session 态） | `ChatComposer.tsx:1709` | 位置不动，只改 `mb-1.5`→`mb-2` |
| 问答 dock 挂载点（`ScrollArea` 外、timeline 与 composer host 之间） | `ChatWorkspace.tsx:123` + `QUESTION_DOCK_WRAPPER_CLASS` | 位置不动；净空由 14px 收敛到 8px（改 host 的 `pt-1.5`→`pt-0`） |
| 卡上方 8px gap | A07 `:2709` | **本规格首次真正落实**（现状 14px） |
| 运行中 placeholder 文案矩阵 | `composerPlaceholder()` 九分支 | **一字不动** |
| 挂起问题时 placeholder = `Add more optional details…` | A07 屏⑥ E 组 | 不动 |
| 两态同轴 `min(100%,48rem)` | `ReadingColumn` | 不动 |
| `deriveActionButtons` 的四种 kind + Retry/Stop 互斥 | `queueRelease.ts` | 不动（只改尺寸/配色） |

---

## 6. 纯函数层与断言清单（施工批**断言先行**）

### 6.1 新增 / 变更的纯函数（全部落 `.ts`，`.tsx` 零字面量）

| 位置 | 导出 | 说明 |
|---|---|---|
| `middleColumnLayout.ts` | `composerCardClass(mode, opts?: {hasExtras?: boolean})` | 签名扩展（§5.3） |
| `middleColumnLayout.ts` | `composerBarClass(mode)` | empty 态底行类，从 JSX 字面量下沉 |
| `middleColumnLayout.ts` | `composerRowClass()` | session 态单行类，同上 |
| `middleColumnLayout.ts` | `composerAttachButtonClass()` | ⊕ 钮类 |
| `middleColumnLayout.ts` | `composerModelTriggerClass()` / `composerModelBaseClass()` / `composerModelSuffixClass()` | 一体式模型档位触发器三件 |
| `middleColumnLayout.ts` | `targetTriggerClass(tone?: 'default' \| 'muted')` | 目标行触发器类（现散在两个 `.tsx` 里） |
| `middleColumnLayout.ts` | `roundActionButtonClass()` | 24px 改档 |
| `middleColumnLayout.ts` | `composerFollowHeightBreakdown()` | `{border:2, padding:16, content:24, total:42}` —— 把 §3.3-E1 的算术做成可断言对象 |
| `middleColumnLayout.ts` | `COMPOSER_CONTROL_SIZE = 24` | 单一高度源；`composerAttachButtonClass` / `composerModelTriggerClass` / `roundActionButtonClass` / `targetTriggerClass` 全部由它派生类名 |
| **新建** `composerModel.ts` | `composerModelLabelParts({modelLabel, effort}) → {base, suffix\|null}` | 标签拆分规则（Default ⇒ suffix=null） |
| **新建** `composerModel.ts` | `composerModelMenuModel({options, selectedModel, selectedEffort}) → {models[], efforts[]}` | 合并菜单的视图模型 |
| `fileMention.ts` | `insertMentionTrigger(value, caret) → {text, caret}` | ⊕ 钮的文本变换（在光标处插 `@`，必要时补前导空格） |
| `middleColumnLayout.ts` | `shouldShowStatusLine` | empty 分支去掉「恒 true」 |
| `questionCard.ts` | `QUESTION_DOCK_WRAPPER_CLASS` | 保持 `pb-2` 不动（8px 由它持有） |

### 6.2 断言清单（vitest node-env，全部为纯函数 / 字符串 / 静态扫描 —— 本仓 `.tsx` 在 vitest 下零覆盖，不得设计需要渲染的断言）

| # | 断言 | 形式 | 抓什么回归 |
|---|---|---|---|
| **F-A1** | `composerCardClass(m)` 两态均：含 `border-border`、含 `focus-within:border-input`、**不含** `border-input ` 作为静息边、**不含** `focus-within:border-ring` | 字符串 | §3.2 品牌橙聚焦框复辟 |
| **F-A2** | `composerFollowHeightBreakdown().total === 42` **且** `composerCardClass('session')` 里的 `min-h-*` 数值（正则取 `min-h-(\d+(?:\.\d+)?)`×4）**等于** `.total` | 算术 + 字符串**交叉** | T-28 那次「测试只断言 class 存在、没算合成高」的盲区（Codex blocker 原型） |
| **F-A2b** | `composerCardClass('session',{hasExtras:true})` 含 `rounded-md` 且不含 `rounded-full`；`hasExtras:false` 反之 | 字符串 | §5.3 的 pill 失控 |
| **F-A3** | `roundActionButtonClass()` 含 `size-6`、不含 `size-7`；且 `size-*` 数值 ×4 === `COMPOSER_CONTROL_SIZE` | 算术 + 字符串 | E2 回滚 |
| **F-A4** | `composerAttachButtonClass()` / `composerModelTriggerClass()` / `targetTriggerClass()` 的高度类均由 `COMPOSER_CONTROL_SIZE` 派生（同上交叉校验） | 算术 + 字符串 | 「一个高度档吃穿 Composer」被局部改坏 |
| **F-A5** | `composerModelTriggerClass()` **不含** `border`、`shadow`、`min-w-`、`rounded-lg`；**含** `rounded-sm`、`hover:bg-hover` | 字符串 | §3.1 满圆胶囊复辟（最重要一条） |
| **F-A6** | `targetTriggerClass()` 含 `rounded-sm`、不含 `rounded-md` | 字符串 | §3.5 |
| **F-A7** | `composerCardClass(m)` 两态均**不含** `shadow-` | 字符串 | A07 `:1337` 零阴影 |
| **F-A8** | 静态扫描：`src/renderer/components/chat/` 下 `SelectTrigger` 出现次数 === 0 | rg 扫描测试 | 合并后有人把 `Select` 原语再引回来（**仅在拍板 ① 采纳时启用**） |
| **F-A9** | `composerModelLabelParts({modelLabel:'Sonnet', effort:'default'})` → `{base:'Sonnet', suffix:null}`；`effort:'high'` → `{base:'Sonnet', suffix:'High'}`；未知 effort 走 `effortLabel` 兜底不抛 | 纯函数 | 一体式标签规则 |
| **F-A10** | 8px 净空契约：`TIMELINE_PADDING_CLASS` 与 `QUESTION_DOCK_WRAPPER_CLASS` 均含 `pb-2`；`middleColumnHostClass('session')` **不含** `pt-` 且含 `pt-0`；`QueuedMessageStrip` 外层类（下沉为 `queueStripWrapperClass()`）含 `mb-2` | 字符串 | 14px 那类「两处各出一半 padding」复发 |
| **F-A11** | `shouldShowStatusLine({mode:'empty', sending:false, reading:0, hasStatusError:false, hasLargeHint:false})` === `false`；四个条件任一为真则 `true`（两态同表，8 例） | 纯函数 | 常驻 `Ready · cwd:` 复辟 |
| **F-A12** | `insertMentionTrigger('abc', 3)` → `{text:'abc @', caret:5}`；`insertMentionTrigger('abc ', 4)` → `{text:'abc @', caret:5}`（不重复空格）；`insertMentionTrigger('', 0)` → `{text:'@', caret:1}` | 纯函数 | ⊕ 钮变成死按钮 / 插入位置错 |
| **F-A13** | `deriveMiddleColumnMode` 既有 13 例**原样全绿** | 回归护栏 | 两态判据被形态改动误伤 |
| **F-A14** | `roundActionButtonKindClass('send')` 含 `bg-foreground` `text-background`；`('stop')` 走 destructive；两者**不同** | 字符串 | **仅在拍板 ③ 采纳时启用** |

> 断言先行的含义：**上表先落，红着**；再改类；再改组件。F-A2 / F-A3 / F-A4 三条的「算术 × 字符串交叉」是本轮针对 T-28 blocker 的定向补强 —— 光断言 class 存在，接不住算错的高度。

---

## 7. A07 v4 追记草案（形态部分）

### 7.1 前提

- A07（`docs/design/a07-cursor-composer-alignment.html`，共 2963 行）**渲染层冻结**，只许文末追记；版本号 **v3 保持定稿**，新内容进 **v4 追记**。
- D25 §4.2③ 已定义 v4 追记模板的**一~五节**（字体）。本规格**不另开 v5**，而是把形态部分作为**六~十节续写进同一个 v4 追记段**，插入位置：`<footer class="footnote">`（`:2861`）**之前**，作为一个新的 `<section>`。
- 引用体例沿用 A07 的「屏N + 字母组 + sN 锚点」。

### 7.2 逐锚点修订清单（写进追记的第八节）

| A07 锚点 | 原文要点 | T-30b2 处置 |
|---|---|---|
| `:786-793` `.cmp { border: 1px solid var(--input); border-radius: var(--r-md); padding: 10px 12px 8px; }` | 卡边框用 `--input`、内边距三值 | ❄️ 渲染层冻结不动。**生产口径改**：静息边 `--border`、聚焦边 `--input`、内边距四边 8px。理由：Cursor 实测卡−框 ΔL=0.054，本仓 `--input` 给到 0.137（2.5×） |
| `:793` `.cmp:focus-within { border-color: var(--ring); }` | 聚焦变品牌橙 | ✏️ **生产口径改** `--input`。Cursor 聚焦 ΔL=0.0333 且**零色度**；本仓 `--border→--input` 的 ΔL=0.0347，是逐位对应的中性梯度 |
| `:1336` 表行「Composer 边框 = `--input`」，理由「用它替代 **Cursor 靠阴影做出的「浮起」**」 | 关键取舍 | ✏️ **理由被实测证伪**：Cursor 卡边框外相邻 8 行像素恒为背景值，**零阴影、零渐变**。它的「浮起」= 卡填充比页面亮一档 + 一条 L 0.937 的发丝边。结论随之改（见上两行）；「不用阴影」这半句**继续有效** |
| `:1334` 表行「`--r-md` 12px …… Cursor 的 follow-up 输入**近 pill** 圆角，**收档到 12**，不引入新圆角档」 | 圆角裁定 | ⚠️ **前提修正 + 待拍板**：Cursor follow-up **就是** pill（左上角圆弧对 r=26=h/2、圆心 (59,732) 的方程拟合，四采样点残差 ≤1px），不是「近」。若采纳 1:1，用 `rounded-full`（= `.send` 已在用的 999px），**仍不引入新圆角档**。empty 态实测 r≈16 device ≈ 12~13 CSS，`--r-md` **原判正确、不动** |
| `:1329` 表行「`--h-row` 28px …… **Cursor 发送键目视约 36px**，收档到 28」 | 圆钮尺寸依据 | ✏️ **输入值实测错误**：Cursor ⊕ 与麦克风圆钮**均为 30 device @DPR1.25 = 24 CSS**（两图互证）。正解 = `--h-btn` 24px，`--h-row` 这一档在 Composer 内**不再需要**（仍用于下拉项 / 侧栏会话行） |
| `:1844`「follow-up 单行卡：高 **40px**（内容 24 + 上下 8）」 | 静息高契约 | ✏️ **算术勘误**：24+8+8=40 **漏算 2×1px 边框**，真值 **42px**，与 Cursor 实测 42 一致。T-28 期把实现从 42「修」回 40（保 28px 圆钮、挤 padding 到 5px）属于**修错方向**，本批回到「内容 24 + padding 8 + 边框 2 = 42」 |
| `:810-819` `.sel`（无边框文字 chip，`--r-sm`，`hover:bg-hover`） | Model/Effort 形制 | ✅ **裁定正确、实现从未对齐**。本批把 `SelectTrigger` 换成 A07 原本就写好的无框文字 chip。属**合规修复**，非改判 |
| `:1632`「Cursor 的 `Fable 5 High` 是一个**合并控件**；我们拆回现有的两个 select（ModelSelect + EffortSelect），**零新控件**」 | 明文裁定 | ⚠️ **待拍板 ①**：Cursor 实测确为一体式（单 chevron、基名 L 0.398 + 后缀 L 0.191 双色）。若采纳，新增 1 个 `ComposerModelTrigger`（Base UI `Menu` + 两个 `MenuRadioGroup`），两个 store 与两个纯函数层**零改动** |
| `:802-809` `.icon-btn`（⊕，`--h-btn`，`--r-sm`，`hover:bg-hover`）；A07 全文**未给它任何文字说明** | ⊕ 钮 | ✏️ **本批实现，并首次赋予明确语义**：`Add file context (@)` —— 插入 `@` 并唤起既有文件搜索。T-28 入档的偏离①「不实现⊕（无附件选择能力，死按钮违 A06）」**就此结清**（不是靠放弃，是靠接上真能力） |
| `:1615` + `:2838-2839` 裁定「维持基线现状 —— **28px 圆形 `--primary` 实心**」+ 论据「等宽字体下 `Send` 占位偏宽」 | 用户已裁定 | ⚠️ **待拍板 ③**：D25 已把论据换成「同位同尺寸的 Stop 让状态切换零位移」（该论据在本批**继续成立**，因为改的是直径与填充色，send/stop 仍同位同尺寸）。结论的两个数值均建议改：28→**24**（E2 实测勘误）、`--primary`→**`--foreground`**（Cursor `#141414` 深中性）。**须用户点头** |
| `:736-753` `.tgt-btn { border-radius: var(--r-sm) }` | 目标行触发器 8px | ✅ 裁定正确、实现写成 `rounded-md`(12px) 被钳成满圆。本批改回。**合规修复** |
| `:2709` 问答折叠条 `style="margin-bottom:8px"` 压在 `.cmp.is-follow` 上 | 8px 净空 | ✅ 裁定正确、实现是 `pb-2 + pt-1.5 = 14px`。本批改回 8px，并把「卡上方净空恒 8px」升级为可断言契约（F-A10） |
| `:1612`「卡下无任何常驻元素」（空态） | 空态裁定 | ✅ 不变；本批把 empty 态常驻的 `Ready · cwd:` 状态行也按需显隐，**更贴近这条裁定** |
| `:1294`「刻意不搬的 Cursor 元素：……麦克风/语音按钮」 / `:2789` | 不搬清单 | ✅ **继续有效**（§10-B）。追记补一句：Cursor 参照图里麦克风占据 follow-up 条最右 24px 圆位，本仓该位由圆形发送/停止键占据，**silhouette 一致，语义不同** |
| （新增，A07 无对应物） | `QueuedMessageStrip`（T-19） | ➕ **新增锚点**：A07 全文无「队列」概念。追记登记其挂载点（error banner 之后、卡之前、仅 session 态）与 8px 净空契约，使其成为 A07 之后的既有事实 |

### 7.3 追记段文本草案（续写在 D25 的 v4 追记之后）

```html
<h3>六、T-30 批 2 · Composer 形态对齐（2026-07-31，D26）</h3>
<p>本节与上文一~五节（D25 分域字体）同属 v4 追记，同批施工。v3 的裁定编号一律不回改。</p>
<p><b>触发：</b>第三轮 GUI 点验第 9 条 ——「聊天框形态与 Cursor 有差异，过于圆润、AI 化；参照截图尽量一比一」。
参照素材：<code>docs/design/refs/feedback-20260731-round3/ScreenShot_2026-07-31_085350_619.png</code>（follow-up 态）与
<code>…_085405_250.png</code>（新建态），DPR 判定 1.25（判据见规格 §1.2）。</p>

<h3>七、实测归因：本页三处数值前提被证伪</h3>
<ol>
  <li><b>:1844 的 40px 是算术错误。</b>「内容 24 + 上下 8」= 40 漏算 2×1px 边框；Cursor 实测 42px。
      T-28 期把实现由 42「修」回 40（保 28px 圆钮 + 挤 padding 到 5px）属修错方向。</li>
  <li><b>:1329 的「Cursor 发送键目视约 36px」是目测错误。</b>Cursor 的 ⊕ 与麦克风圆钮均为 30 device px @DPR1.25 = <b>24 CSS px</b>（两张图互证）。
      正确档位是本页自己的 <code>--h-btn</code>(24)，Composer 内不需要 <code>--h-row</code>(28)。</li>
  <li><b>:1336 的「Cursor 靠阴影做出浮起」是事实错误。</b>Cursor 的卡<b>零阴影</b>（边框外相邻 8 行像素恒等于背景值）。
      它的浮起 = 卡填充比页面亮 0.012 L + 一条 L 0.937 的发丝边。据此，用 <code>--input</code> 做静息卡边的必要性消失。</li>
</ol>

<h3>八、逐锚点处置表</h3>
<!-- §7.2 的表 -->

<h3>九、「过于圆润 / AI 化」的物理来源（供后续复盘）</h3>
<p>不是卡的圆角，而是<b>卡内控件</b>：Model/Effort 用了 <code>SelectTrigger</code> 原语，把
<code>rounded-lg</code>(16px，挂在 h-6 上被 CSS 钳到 h/2 = 满圆胶囊)、<code>border-input</code>、
<code>shadow-xs</code>、<code>before:shadow</code> 内高光、<code>min-w-26</code>(104px) 一并带入，两枚并排共 220px；
叠加聚焦时整条卡框转品牌橙（C=0.1523）与两枚 28px 高饱和实心圆钮。
本页 <code>:810-819</code> 的 <code>.sel</code> 从一开始就写的是无框文字 chip —— <b>裁定没错，实现没对齐</b>。</p>
<p><b>可复用的一句判据：</b>圆润只属于最外层容器一件事，不该同时属于容器和它内部的每一个小控件。</p>

<h3>十、新增锚点（A07 无对应物，登记为 A07 之后的既有事实）</h3>
<ul>
  <li><code>QueuedMessageStrip</code>（T-19）：挂载于 error banner 之后、Composer 卡之前，仅会话态；与卡的净空 8px。</li>
  <li>「卡上方净空恒 8px」升级为可断言契约：timeline / 问答 dock / 队列 strip 三个上游各自持有唯一的 8px，Composer 宿主不再叠加 <code>pt-1.5</code>。</li>
  <li>⊕ 钮语义首次明确：<code>Add file context (@)</code>，插入 <code>@</code> 并唤起既有文件搜索；不是附件选择（本仓无 renderer 侧读文件 IPC）。</li>
</ul>
```

### 7.4 `docs/design-system.md` 连带（活文档，就地改写）

| 节 | 改写要点 |
|---|---|
| Border Radius「使用建议」 | 补一条硬规则：**`border-radius` 一旦 ≥ 元素高度的一半，CSS 会钳成满圆**。因此 `h-6`(24px) 上写 `rounded-md`(12) / `rounded-lg`(16) 与写 `rounded-full` **渲染完全相同**。小控件（h-6 / h-7）一律 `rounded-xs` / `rounded-sm`；`rounded-md` 及以上只给 ≥32px 高的容器 |
| Shadow（阴影） | 在「需要浮起感时优先 border + bg-card」下补实测脚注：**Cursor 的输入卡零阴影**，其浮起来自「卡填充亮一档 + L≈0.94 的发丝边」，本仓对应组合为 `bg-card` + `border-border` |
| （新增小节）**表单控件 vs 文字 chip** | `SelectTrigger` / `Input` 是**输入控件原语**，自带边框 + 阴影 + 内高光 + `min-w`，只用于表单页；**工具条上的下拉**（模型、分支、目标）应走「文字 + chevron + hover 底」的 ghost chip 形制，参考 `composerModelTriggerClass()` / `targetTriggerClass()` |

---

## 8. 与 D25 的合并施工序 + 量级

### 8.1 文件重叠面

| 文件 | D25 动它 | T-30b2 动它 | 冲突性质 |
|---|---|---|---|
| `middleColumnLayout.ts` | ③ 域映射：`composerTextareaClass` 的字号档（S7） | 卡/行/触发器/圆钮/高度全部类 | **同文件不同函数**，字号 vs 几何属不同 class group，**无语义冲突**，但会有 diff 冲突 → 需定序 |
| `ChatComposer.tsx` | ③：statusLine 字号 + `tabular-nums`（S8） | 两态 DOM 装配、⊕ 钮、模型 chip | 同上 |
| `ModelSelect.tsx` / `EffortSelect.tsx` | ③：`text-xs`→`--text-ui`(14)（S11） | **可能整体删除**（拍板 ① 采纳时） | **真冲突**：D25 若先跑，会给两个即将删除的文件做字号迁移 → 白做 |
| `TargetFolderSelect.tsx` / `TargetBranchSelect.tsx` / `RunLocationIndicator.tsx` | ③：字号 14 sans（S9/S10）+ §2.3 分支 mono/sans 待拍板 | 触发器 `rounded-md`→`rounded-sm`（类下沉到 `middleColumnLayout.ts`） | 同文件不同属性，**可同批**，但类下沉后 D25 的迁移点会移位 → T-30b2 先做更省事 |
| `QueuedMessageStrip.tsx` | ③：`text-xs` 清零（A6） | `mb-1.5`→`mb-2`，外层类下沉 | 可同批 |
| `__tests__/middleColumnLayout.test.ts` | A4 / A6 断言 | F-A1~F-A14 | **同文件**，需在同一批里一次写完 |
| `docs/design/a07-…html` v4 追记 | 一~五节 | 六~十节 | **同一个追记段**，必须**一次成文**（否则会出现两个 v4） |
| `docs/design-system.md` | 字体族五节改写 | Radius/Shadow/新增控件形制小节 | 同文件不同节，一次改完 |
| `globals.css` | ① 字族 + `--text-*` token | **不动** | 无冲突 |

### 8.2 合并施工序（在 D25 原序「① → ⑥断言 → ② → ③ → ④ → ⑤」上插入）

```
S0  断言先行（合批）
    ├─ D25 的 A1~A6
    └─ T-30b2 的 F-A1~F-A14
    → 同一次提交，全部红着。工程规范第 12 条。

S1  D25 ① token 层（globals.css：字族两栈 + --text-meta/-ui/-title + --container-reading*）
    → 与形态零重叠，先落，让后续所有字号迁移有 token 可用。

S2  ★ T-30b2 形态主体（本规格 §4/§5 全部）
    ├─ S2a  middleColumnLayout.ts：COMPOSER_CONTROL_SIZE / 卡类 / 行类 / ⊕ / 模型 chip /
    │        目标触发器 / 圆钮 / composerFollowHeightBreakdown / shouldShowStatusLine
    ├─ S2b  新建 composerModel.ts + ComposerModelTrigger.tsx（拍板 ① 采纳时）；
    │        删 ModelSelect.tsx / EffortSelect.tsx（store 与 models.ts/efforts.ts 纯层零改动）
    ├─ S2c  fileMention.ts:insertMentionTrigger + ChatComposer 两态 DOM 装配 + ⊕ 接线
    ├─ S2d  TargetFolder/Branch/RunLocation/QueuedMessageStrip 改用下沉后的类
    └─ S2e  ChatWorkspace：middleColumnHostClass('session') 去 pt-1.5；folder 触发器补 title={path}
    → F-A1~F-A14 转绿。
    ★ 排在 D25 ③ 之前的唯一理由：S2b 会删掉 D25 ③ 的两个迁移目标文件。
      形态先行 ⇒ D25 ③ 面对的是更少、更干净的节点（两个 SelectTrigger 变一个 ghost chip）。

S3  D25 ② 原语（ui/ident.tsx + code-block）与 ②b argKind
    → 与 Composer 正交（工具行 / 代码块面），可与 S2 并行由不同人做。

S4  D25 ③ 域映射（chat + workspace-shell）
    → 此时 Composer 的 DOM 已是终态，字号迁移一次到位，不会二次返工。

S5  D25 ④ chat 外复核扫描（source-control / git / files / sessions）
    → 不受形态影响。

S6  基线与文档（合批，一次成文）
    ├─ A07 v4 追记：D25 的一~五节 + T-30b2 的六~十节，同一个 <section>
    ├─ A07 顶部时效标注：D25 的字体标注 + 一句「形态口径见 v4 追记六~十节」
    ├─ design-system.md：D25 五节 + T-30b2 三节（§7.4）
    └─ phase0a 同构标注（D25 原有）
    → 不允许拆两次：拆了会出现两个 v4 追记段。

S7  D25 ⑥ 三测点 A/B 截图 + a09 页
    → 形态已定，截图才有意义。a09 顺带承载本批的形态前后对照（Cursor 参照 / 现状 / 改后 三图）。
```

**并行度**：S2 与 S3 可双线（不同文件面）；其余串行。

### 8.3 合并量级估算

| 工序 | 内容 | 量级 |
|---|---|---|
| S0 | D25 六条 + T-30b2 十四条断言（含三条算术×字符串交叉） | **S**（0.25d，其中 T-30b2 占 0.15d） |
| S1 | D25 ①（原估 0.25d） | **S**（0.25d） |
| S2a | 类层重写 + `COMPOSER_CONTROL_SIZE` 单一来源 + 高度算术函数 | **S**（0.25d） |
| S2b | `composerModel.ts` + `ComposerModelTrigger.tsx`（Menu + 2×RadioGroup）+ 删两组件 | **M**（0.75d）／ 拍板 ① 不采纳则降 **S**（0.25d） |
| S2c | `insertMentionTrigger` + 两态 DOM 装配 + ⊕ 接线 + a11y 文案 | **S~M**（0.5d） |
| S2d~e | 目标行 / strip / host padding / folder title 补路径 | **S**（0.25d） |
| S3 | D25 ② + ②b（原估 0.5d） | **S**（0.5d） |
| S4 | D25 ③（原估 1d）—— Composer 面因 S2 已收敛，略降 | **M**（0.9d） |
| S5 | D25 ④（原估 0.5~1d） | **M**（0.5~1d） |
| S6 | A07 v4 追记（合写省一次上下文重建）+ design-system + phase0a | **M**（0.6d，D25 原估 0.5 + 形态 0.25，合写省 0.15） |
| S7 | D25 ⑥（原估 0.5d）+ 形态前后对照三图（同一页，边际成本低） | **S~M**（0.6d） |

| 方案 | 合计 |
|---|---|
| D25 原估（单独） | 3.25 ~ 3.75d |
| T-30b2 形态（单独） | 2.0 ~ 2.5d |
| **合并总量（拍板 ① 采纳合并控件）** | **≈ 5.3 ~ 5.8d（L+）** |
| 合并总量（拍板 ① 不采纳，保两个 ghost chip） | ≈ 4.8 ~ 5.3d |

> 合并相对「各做各的」节省约 **0.4~0.5d**，全部来自三处：断言一次写、A07 追记一次成文、`middleColumnLayout.ts` 与 `ChatComposer.tsx` 只承受一次大 diff。
> **反过来，若拆两批做，除了多花这 0.5d，还会额外产生一次 `ModelSelect/EffortSelect` 的白做迁移。**

---

## 9. 待拍板（三项，各给推荐）

### ① 模型档位是否合并为一体式控件（撤销 A07 `:1632`）

| 选项 | 形态 | 代价 | 风险 |
|---|---|---|---|
| **A（推荐）** 一体式 `Sonnet High ⌄` | Cursor 1:1：单触发器、单 chevron、基名 muted + 后缀 foreground/medium；effort=Default 时后缀整段消失 | 新增 `ComposerModelTrigger.tsx`（Base UI `Menu` + `MenuGroupLabel`×2 + `MenuRadioGroup`×2 + `MenuSeparator`，原语全部现成）+ `composerModel.ts` 纯层；删 `ModelSelect.tsx`/`EffortSelect.tsx`；`useSessionModel`/`useSessionEffort`/`models.ts`/`efforts.ts` **零改动**；**+0.5d** | 撤销 A07 明文裁定「零新控件」；Effort 藏进模型菜单第二段，发现性略降（缓解：`MenuGroupLabel` 写 `Reasoning effort`，且当前值直接显示在触发器上，比现状更可见） |
| B 保两个独立 ghost chip | `Sonnet ⌄` `Default ⌄`（两个 chevron），但都改成无框文字 chip | +0.25d，零新控件，A07 `:1632` 不动 | 与 Cursor 差一个 chevron 与一处双色；条宽仍比 Cursor 多 ≈40px |

> 两个选项**都**能解掉 §3.1（满圆胶囊）—— 这是「AI 化」的主因。A/B 之差只在最后一段 1:1。

### ② follow-up 卡是否改为 pill（`rounded-full`）

**这是本规格里唯一一处「实测结论与用户口头诊断相反」的地方，必须由用户裁。**

| | 圆角 | 依据 |
|---|---|---|
| Cursor follow-up 实测 | **pill**（r = h/2 = 26 device；圆弧方程 `x(y)=59−√(26²−(732−y)²)` 在 y=707/712/722/726 四点残差 ≤1px） | 参照图逐像素 |
| A07 v3 裁定 | 12px（`:1334`「Cursor 近 pill，收档到 12」） | 已验收 |
| 用户第三轮原话 | 「过于圆润」 | — |

| 选项 | 说明 |
|---|---|
| **A（推荐）** 改 pill | 「尽量一比一」是本条点验的明确指令；`rounded-full` 不是新圆角档（`.send` 已用 999px）；且**只有在同时执行 §3.1/§3.4（卡内控件去满圆、圆钮去饱和）后**，外层胶囊才会读成「Cursor 那种锐利的搜索条」而不是「更圆的 AI 框」。单独改 pill 而不改内部 = 观感更糟 |
| B 维持 12px | 尊重用户「过于圆润」的字面诊断与 A07 v3 裁定；仍能拿到 §3.1~§3.5 的绝大部分收益 |

> **给用户的一句话判据**：请看 `085350_619.png` 的输入条 —— 它的左右两端是**半圆**。若您要的就是这个，选 A；若您觉得那两个半圆正是「圆润」的来源，选 B。**其余 12 项改动与本条无关，两选皆可施工。**

### ③ 圆形动作键：直径 28→24、send 配色 `--primary`→`--foreground`（撤销 A07 `:2838`）

| | 现状 | Cursor 实测 |
|---|---|---|
| 直径 | 28px | **24px**（A07 的「目视 36px」是错误输入，见 §3.3-E2） |
| send 填充 | `--primary` `#BC5215`（C=0.1523） | `#141414`（C≈0） |

| 选项 | 说明 |
|---|---|
| **A（推荐）** 两项都改 | 直径改动属**实测勘误**（不是口味）；配色改动是「AI 化」四大来源的最后一条。改后 send=近黑、stop=红，同屏最多一枚高饱和 |
| B 只改直径，保橙 | 保住品牌色在中列的唯一落点；但橙圆 + 红圆并排的情形仍在 |
| C 都不改 | 完全维持 A07 `:2838`；则 §5.3 的 42px 卡高需改回「28px 内容 + 7px padding」= 44px 或维持 40px 挤压态 |

---

## 10. 有意不对齐项（诚实性清单，A06）

| # | Cursor 有 | 本仓处置 | 理由 |
|---|---|---|---|
| **A** | 卡上方 action pills（`Changes +10279` / `Continue Working` / `Commit & Push ⌄`） | **不做**，但**沿用其几何节拍**（h-7、间距 4px、距卡 8px）给已有的 `QueuedMessageStrip` / 问答折叠条 | 三枚 pill 各自绑定 Cursor 的真实能力（diff 汇总 / 续跑 / 提交推送），本仓当前无对应能力；摆空壳 = A06 违规。A07 `:2843` 裁定④「空态卡下不放快捷入口」同精神 |
| **B** | 麦克风圆钮（follow-up 条最右 24px） | **不搬** | 本仓无语音能力。A07 `:1294` / `:1633` / `:1864` / `:2789` 四处明文，本批**继续有效**。补记：该 24px 圆位在本仓由发送/停止键占据，**silhouette 一致、语义不同**，不是空缺 |
| **C** | 卡填充比页面**亮** 0.012 L | **不对齐**（本仓亮色下卡比页面暗 0.0094 L） | 改它要动 `--card` / `--background`，越过「Flexoki 调色板不动」的边界；ΔL 0.009 在大面积平色上低于可辨阈；**暗色模式下本仓极性本就与 Cursor 一致**（card 0.2197 > bg 0.1981） |
| **D** | placeholder L 0.7316（很浅） | **不对齐**，维持 `text-muted-foreground` L 0.5111 | 本仓 placeholder 承载**状态语义**（`Agent Host is running — your message will be queued…` / `Creating session with Agent Host…` / `Queued N — type another follow-up…`），不是装饰提示。调浅 = 削弱可读性换观感 |
| **E** | `Connect Your Repos` 黑色 CTA（空态卡下） | **不搬** | A07 `:1633` 已裁，本仓 `add repository` 在左栏 |
| **F** | 同屏恒 1 枚圆钮 | **不对齐**（本仓 `retry + send` 可并存） | `deriveActionButtons` 的 Retry 是失败可恢复性的一部分（T-19），删它换 1:1 = 用能力换观感 |
| **G** | 一体式模型标签的**极性**（Cursor follow-up：基名浅、effort 后缀深且更粗；Cursor empty：基名深、型号后缀浅） | 采纳 follow-up 的极性（基名 muted / effort foreground+medium），**不复制 empty 的相反极性** | 两图极性相反的原因是 empty 图的 `Max` 是**型号变体词**而非 effort。本仓的后缀恒为 effort，故统一走 follow-up 极性。实测色值已记入 §2.1/§2.2 备查 |

---

## 附录 A · 风险与回归面

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| pill 卡在 `hasComposerExtras` 时变形 | 附件 chip / notice / 队列拒绝提示出现，卡长高 | §5.3 的 `hasExtras` 纯函数分支 + F-A2b |
| 24px 圆钮点击靶变小 | 桌面端 | 与目标行控件 / 模型 chip 同为 24px（本仓既有档），`Button` 的 `pointer-coarse:` 44px 触控靶规则不受影响 |
| 删 `ModelSelect`/`EffortSelect` 影响 `models.test.ts` / `sessionEffortStore.test.ts` / `efforts.test.ts` | 拍板 ① 采纳 | 三个测试测的是**纯层**（`models.ts` / `sessionEffortStore.ts` / `efforts.ts`），不 import 组件 —— 零影响。已核 |
| `middleColumnHostClass('session')` 去 `pt-1.5` 后，无 timeline / 无 dock / 无 strip 的极端态卡贴顶 | 理论上不存在（session 态必有 timeline，`TIMELINE_PADDING_CLASS` 自带 `pb-2`） | F-A10 断言三个上游各自持有 8px；若将来新增第四个上游，断言会提醒它也要带 `pb-2` |
| 去掉 empty 态常驻 statusLine 后丢失 cwd 全路径 | 用户想确认「打到哪个目录」 | **硬要求**：folder 触发器补 `title={workspace.path}`；`!cwd` / `lastError` 的红色 banner 不受影响（在卡外，仍会打印完整 `statusHint`） |
| ⊕ 钮被误解为「附件上传」 | 文案不清 | `title="Add file context (@)"` + `aria-label="Add file context"`；粘贴附件（T-18）路径不变，两条并存 |
| D25 的 A6 断言（`chat/` 下 `text-xs` 清零）与本批新写的类相撞 | S2 写了新的 `text-xs` | S2 的所有新类**不写任何字号类**，字号统一留给 S4（D25 ③）。这是 S2 早于 S4 的第二个理由 |
| A07 出现两个 v4 追记段 | S6 被拆成两次提交 | S6 明示「一次成文，不允许拆」 |

## 附录 B · 一句话摘要

> Cursor 那份「协调感」= **一个高度档（24px）吃穿整条 Composer + 只有最外层容器有圆角 + 边框是发丝级中性灰 + 全条只有一件高饱和物**。
> 本仓现状 = 三个高度档（24/28/40）+ 四件满圆物 + 2.5 倍重的边框 + 聚焦时整框转品牌橙 + 同屏两件高饱和物。
> 十三处改动里，**八处是回到 A07 自己早就写好的裁定**，三处是修 A07 的算术/目测错误，只有三处需要用户拍板。
