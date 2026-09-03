# Evidence — U09 组件形态对照表

> 2026-09-03，[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定三派 `maxapi/grok-4.6` 子代理取证。
> 读取对象：pix 冻结提交 `da01b3e` 的组件 form vs AiClient `feat/pi-primary-backend`。**只比组件形态，不比 token 名**（D01 禁止照搬 `--bg-composer`/`--user-bubble`/`--hover-fill` 等）。

## 对照表（逐件）

| # | 组件 | AiClient 现状 | pix 形态 | 判定 | 原因 |
|---|---|---|---|---|---|
| 1 | **Composer 卡片** | 边框卡 `rounded-md border-border bg-card p-2`（`middleColumnLayout.ts:157-181`）。空/会话态 74px 双行。目标条是**独立** h-6 行。附件 24px 方 ghost `+`。发送 24px 实心圆 `SendHorizonal`（`ComposerRoundButton.tsx:32-65`）。 | `.composer-card` 12px `--radius-panel` + 细边 `--composer-border`（`styles.css:1369-1380`）。空会话**凸起摘列**与卡片接合（`Composer.tsx:1486-1538`）。附件 32px 圆 `+`；发送 28px `ArrowUp`（`:1623`,`:1751-1766`）。占位「Describe what you want to build…」 | **改造后搬** | 搬「**空会话顶部接合摘列**」（project/local/branch 作为卡片顶盖）。保留我们 token、8px 圆角、24px 控件档、8px 内距。**不**搬 32/28px 键或 `--bg-composer`。可选：`ArrowUp` 图标仍 24px + `bg-foreground`。 |
| 2 | **模型 / 思考档 触发 chip** | ghost chip **无边框**：`h-6 rounded-sm px-2 hover:bg-hover` + chevron（`middleColumnLayout.ts:354-361`）。单一触发：muted 模型 + `font-medium` effort。 | 也是 ghost **无边框**，但 `h-8 rounded-full text-[12px]`，**无 chevron**（`Composer.tsx:1676-1694`）。额外 access-mode pill + context-% chip。 | **不搬** | 24px 方 ghost 已是 Codex/利落形态。跳过 pix 32px pill、橙 access chip、context %。保留合并的 model+effort。 |
| 3 | **助手输出** | 平铺无气泡。`text-markdown` ~15px（`chatMarkdownPolicy.ts:693-695`）。代码块 `rounded-sm border bg-muted/50 p-3 text-code`（`:779-784`）。工具行：**裸 verb+arg，无卡/图标**（`ToolRows.tsx:86-99`）。思考在进程列表。列 `max-w-reading`（45rem）。 | 平铺 14px `.pix-md`（`styles.css:1898-1910`）。工具/思考 = **11px 边框卡**（`:2640-2678`）或 Marker+icon（`TimelineRow.tsx:1296`）。thread 760px。更富的代码（preview/expand）+ 文内图像。 | **不搬** | 裸工具行已是 Codex 简约形态。**不要**引入 pix 卡 chrome、图标、KaTeX webfont、远程图像（我们的安全门）。平铺全宽已匹配。 |
| 4 | **用户气泡** | T12 已实现：80% 上限、`rounded-md rounded-tr-xs border-input bg-accent px-3.5 py-2`（`chatTimelineLayout.ts:114-116`）。无气泡内编辑；悬停回合复制。 | 80% `Bubble` `rounded-xl` secondary（`bubble.tsx:24-75`；`TimelineRow.tsx:680-697`）。常显 time/copy/edit 页脚；内联编辑。填充 `--user-bubble`。 | **不搬** | 锐右上角 + `border-input`/`bg-accent` 是**测过的对比度修复**。跳过 pix 均圆角、secondary 填充、常显页脚、`--user-bubble`。 |
| 5 | **右栏（Context / Run）** | 停靠 `ContextPanel` + rail：Git / Files / Context / Terminal（`surfaceRegistry.ts:71-105`；header `h-9`，`ContextPanel.tsx:210`）。Context = h-7 定义列表（`ContextSurfaceView.tsx:72-79`）。 | **无**停靠 Context/Run rail。`EnvPanel` = git/env 弹出；`SessionParityPanels` = **modal** session tree/info。 | **不搬** | 产品 surface pix 没有。可选后续：把 session-info **字段**并入我们 Context 列表——保留 h-7 行与我们的 token。 |
| 6 | **侧栏** | `h-7` 行、`rounded-md px-2 text-ui`、段帽 `tracking-[0.04em] text-muted`（`LeftNav.tsx:402-509, 781`）。Recent + Repositories。 | `h-8` `.nav-item`/`.sidebar-list-row`（`styles.css:862-890`）。一级导航：新 thread / packages / resources（`AppSidebar.tsx:381-400`）。 | **不搬** | 保留 28px 密度与我们的 IA。**不要**取 pix 32px 行，也**不要**把 packages/resources 当一级导航。 |

## 总体模式

**copy geometry（只当它更安静时）**：空会话顶部接合摘列、平铺助手、80% 用户气泡。**用我们的 token 重打样式**。凡是会重命名 `--border`/`--accent`/`text-ui` 的都是「改造」，不是「照搬」。

**核心结论**：U09 大部分组件**不搬**——我们已有的 Codex 简约形态大多正确。真正值得改造的只有 **#1 Composer 空会话顶部接合摘列**。这正是「利落简约」的落点：不是大改，而是把 Composer 在空会话时长得更像 pix 的「顶部摘列」形态。
