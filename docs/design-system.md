# AiClient Design System

> ⚠️ **时效警示（2026-07-28 更新，D18 / D19 连带）**
>
> **已撤销（T-21 已改写并与代码对齐，可直接作为施工依据）**：
> **Color System** / **Border Radius** / **根字号结论** 三节，
> 与 `src/renderer/styles/globals.css` 的 `@theme` + `:root` + `.dark` 逐条对得上。
>
> **已撤销（T-30 批 2 · D25 / D26 已改写并与代码对齐）**：**字体族（分域）** / **CJK 级联规则** /
> **Typography（字号）** / **Font Weight** / **Letter-spacing（字距梯度）** / **数字对齐（tabular-nums）** /
> **Border Radius → 钳制硬规则** / **表单控件 vs 文字 chip** / **Ghost chip 悬停显壳** 九节。
> 其中 **字体族** 一节原先列在上面 T-21 的已撤销清单里，现已随 **D25 撤销 D18③** 整节重写为
> **分域口径（UI 比例 / 代码等宽）**——旧的「三键统一等宽」一律以新节为准。
> ⚠️ `docs/design/a07-cursor-composer-alignment.html` 与 `phase0a-openchamber-alignment.html`
> 两份基线的**原型画面仍是全等宽的**（渲染层刻意冻结，用作验收凭证），**不要拿它们的画面当字体施工依据**；
> 逐条对照见 A07 文末「v4 追记」。
>
> **已撤销（T-22 已写入并与代码对齐）**：**Spacing & Sizing → 新壳布局档位**一节与
> `components/workspace-shell/shellLayoutModel.ts` 的常量逐条对得上。
>
> **仍未撤销**：
>
> - **字号 / 字族的全仓调用点迁移**：token 层已落齐（`@theme` 现有 `--text-2xs` / `--text-code` /
>   `--text-meta` / `--text-ui` / `--text-markdown` / `--text-title` 六个字号 token 与两条字族栈），
>   调用点迁移**已覆盖 `chat/` 与 `workspace-shell/`**（含 D25 的 mono 白名单、tracking 梯度、`tabular-nums`）；
>   **`source-control/` / `files/` / `git/` / `sessions/` 等其余目录的逐屏复核尚未完成**（D25 §5.5 工序 ④）。
>   写新代码按本节；改旧代码不要单纯为了对齐档位而重排布局。
> - **旧模块彩色硬编码**：`source-control/` 整目录、`layout/`、`ui/activity-indicator.tsx` 等 47 个文件
>   共 134 处 `text-red-500` 类硬编码尚未迁移到语义 token。**归 T-25。**
>
> **本文件不生效的场景（未裁定的边界）**：主题选 `sync-terminal` 时，`src/renderer/lib/ghosttyTheme.ts:238-312`
> 会把**全部 25 个旧语义变量**以 hex 覆盖到 `documentElement`，Flexoki 调色板被 100% 顶掉，且**不覆盖**
> T-21 新增的 5 个 token → 该模式下会出现「终端色 + Flexoki 色」混色。见 plantree open-questions #12。
>
> 遇冲突以 [ARD §7](./plans/2026-07-23-openchamber-chat-refactor-ard.md) 与
> [总台账 D18/D19](./plans/openchamber-chat-refactor-ledger.md) 为准。

## Tech Stack

- **Framework**: Electron + React 19 + TypeScript
- **Styling**: Tailwind CSS 4
- **UI Components**: [coss ui](https://coss.com/ui) (基于 Base UI，copy-paste 模式)
- **Icons**: Lucide React
- **Editor**: Monaco Editor (local workers, no CDN)

## 组件使用原则

**优先使用 @coss/ui 组件**，避免手动实现：

1. 新增 UI 需求时，先查看 [coss.com/ui](https://coss.com/ui) 是否有现成组件
2. 使用 CLI 添加组件：`npx shadcn@latest add @coss/<component>`
3. 组件存放于 `src/renderer/components/ui/`
4. 仅在 @coss/ui 无法满足时才手动实现

## Color System

**调色板 = Flexoki**（来源：`openchamber@v1.17.0-6-ga3519141` 的
`packages/ui/src/lib/theme/themes/flexoki-{light,dark}.json`）。
sRGB hex → OKLCH(D65) 转换后写入 `src/renderer/styles/globals.css` 的 `:root` / `.dark`。
**下表 hex 仅为可读性**，权威值以 `globals.css` 的 OKLCH 字面量为准。

### Theme Variables

| 变量 | Light | Dark | 用途 / 约束 |
|------|-------|------|------------|
| `background` | `#fffdf4` | `#171515` | 页面底色（参与 `--panel-bg-opacity`） |
| `foreground` | `#100F0F` | `#CECDC3` | **正文/标题的默认色**（对底 18.78:1 / 11.39:1） |
| `card` / `popover` | `#fbfaf2` | `#1c1a19` | 抬升表面（参与 `--panel-bg-opacity`） |
| `card-foreground` / `popover-foreground` | `#100F0F` | `#CECDC3` | 同 `foreground` |
| `primary` | `#BC5215` | `#DA702C` | **品牌橙**：主操作、激活态、选中指示条、拖放目标、链接、焦点 |
| `primary-foreground` | `#fffdf4` | `#171515` | 品牌橙实底上的文字（4.73:1 / 5.49:1） |
| `secondary` | `#f7f4ec` | `#1e1d1c` | secondary 按钮/徽章底（`surface.subtle`） |
| `secondary-foreground` | `#100F0F` | `#CECDC3` | — |
| `muted` | `#f6f5ee` | `#1C1B1A` | 次要面板底（参与 `--panel-bg-opacity`） |
| `muted-foreground` | `#686663` | `#807e79` | 次要文字（亮 5.62:1；暗 4.49:1，见「已知偏差」） |
| `accent` | `#eeece3` | `#2d2b2b` | **交互覆盖底**（hover / 选中行）。`interactive.hover` 预乘实色 |
| `accent-foreground` | `#100F0F` | `#CECDC3` | — |
| `accent-primary` | `#F9AE77` | `#F9AE77` | 品牌强调（`primary.emphasis`）。**亮色有可读性红线，见下** |
| `selection` | `#e5e3db` | `#323030` | **树节点/列表项选中态底**（不是文本选区） |
| `hover` | `#eeece3` | `#2d2b2b` | hover 底的语义别名，值与 `accent` 逐位相同 |
| `status-running` | `#205EA6` | `#4385BE` | **运行中/活动指示**（`status.info`）。实色，可配 `animate-pulse` |
| `destructive` | `#AF3029` | `#D14D41` | 危险操作 |
| `success` | `#66800B` | `#A0AF54` | 成功 / diff 新增 |
| `warning` | `#BC5215` | `#DA702C` | 警告。**与 `primary` 逐位同色** |
| `info` | `#205EA6` | `#4385BE` | 信息。与 `status-running` 同值 |
| `*-foreground`（destructive/success/warning/info） | `#fffdf4` | `#171515` | 对应实底上的文字 |
| `folder` | `#AD8301` | `#D0A215` | 目录/文件夹语义色（`syntax.base.type`） |
| `border` | `#DAD8CE` | `#343331` | 描边、分割线 |
| `input` | `#CECDC3` | `#403E3C` | **填充语义**：滑块/进度/switch 轨道、`dark:bg-input/32`；兼作输入框描边 |
| `ring` | `#BC5215` | `#DA702C` | 焦点环（`interactive.focus`，**无 alpha**） |
| `editor-current-diff` | `oklch(0 0 0 / .06)` | `oklch(1 0 0 / .08)` | Monaco 当前 diff 行叠加。**刻意不用调色板色**，见下 |

### `secondary` 与 `muted` 近乎同色（Flexoki 固有属性，不要拿它们做层次）

`secondary`（`surface.subtle`）与 `muted`（`surface.muted`）在两套主题下的 ΔE_ok 分别只有
**0.0031**（亮）与 **0.0086**（暗），互相对比度 ≈ **1.005:1**——都远低于 OKLab 可辨阈（≈0.02）。
它们**不同值**（满足「secondary ≠ muted」的验收口径，也避免了上游把两者一并映到 `surface.muted` 的退化），
但**在视觉上读不出差别**。

- **禁止**用 `bg-secondary` vs `bg-muted` 表达「两层面板」——渲染出来就是一整片平面。
- 需要层次时一律靠 `--border`（与 `card` / `background` 近同色的处理方式相同）。
- 需要真正拉开的第三级底色时，用 `--accent` / `--selection`（交互层）或 `--input`（填充层）。

### `*-foreground` 只配实底，不配色调底

`destructive/success/warning/info` 的 `-foreground` 取自 Flexoki `status.*Foreground`，
它们是**实底上的反色**（亮 `#fffdf4` 近白 / 暗 `#171515` 近黑）。

- ✅ `bg-success text-success-foreground`（实底）
- ❌ `bg-success/8 text-success-foreground`（色调底）——亮色 warning 徽章实测 **1.19:1**、
  暗色 success 徽章 **1.39:1**，字直接消失。
- 色调底上的字用**同族实色**：`bg-success/8 text-success dark:bg-success/16`（实测 3.6:1–5.8:1）。
  `components/ui/badge.tsx` 的 `error` / `info` / `success` / `warning` 四个 variant 即按此写法。

### ⚠️ `dark:` 前缀**不跟随** `.dark` 调色板（既存问题，未裁定）

本仓从未声明 `@custom-variant dark`，所以 Tailwind v4 的 `dark:` 仍是
`@media (prefers-color-scheme: dark)`（**系统偏好**），而调色板切换靠 `documentElement` 上的
`.dark` 类（**应用设置**）。用户显式选 Light/Dark 而系统相反时，两者会各走各的。

- **新代码不得用 `dark:` 表达关键可读性差异**（字色、对比度）——用**同族语义 token**，
  它们本身就随 `.dark` 换值。
- `dark:` 只可用于「两边都成立、只是浓淡不同」的微调（如把色调底从 `/8` 抬到 `/16`）。
- 详见 `docs/plantree/plans/openchamber-chat-refactor/open-questions.md` 第 13 条。

### Alpha 纪律（本节最重要的一条）

Tailwind 的 `/N` 修饰符编译成 `color-mix(in oklab, X N%, transparent)`，
**结果 alpha = N × alpha(X)**。所以 `:root` / `.dark` 里的语义变量**一律不带 alpha**：

- Flexoki 原值带 alpha 的（`interactive.hover` / `interactive.selection` / `focusRing`），
  要么取同族无 alpha 值（`--ring` 取 `interactive.focus` 而非 `focusRing`），
  要么按其在对应底色上的视觉等效**预乘成实色**（`--accent` / `--hover` / `--selection`）。
- 透明度**全部**交给 `/N` 修饰符表达。**新增/修改 token 时不得再引入自带 alpha 的值**
  （唯一例外是 `--editor-current-diff`，它本来就是「中性叠加层」语义）。

**逐 token 的 `/N` 许可**：

| token | 可否加 `/N` | 说明 |
|-------|------------|------|
| `accent` | ✅ | `hover:bg-accent/50` 是全仓既定的 hover 强度（145 处），不要改成 `bg-accent` |
| `hover` | ❌ | 它已经是「满强度 hover」；加 `/N` 就退化成 `bg-accent/N`，语义自相冲突 |
| `selection` | ❌ | 预乘实色，直接当选中底用 |
| `status-running` | ✅ | 高饱和状态色，`bg-status-running/10` + `border-status-running/30` 是既定横幅写法 |
| `accent-primary` | ✅ | 但亮色下用法受限，见下 |

### `--accent-primary` 的亮色红线

`#F9AE77` 对亮色底 `#fffdf4` 只有 **1.82:1**、对 `--primary` 实底 2.60:1；暗色下 9.83:1。因此：

- **暗色**：可作链接 / 强调文字。
- **亮色**：**只能**作填充 / 边框 / 下划线 / hover-on-primary，**禁止**作正文或链接色。
- 需要「两套主题都清楚的强调」时用 `--primary`（4.73:1 / 5.49:1）。

### 面板半透明（背景图）

只有 **4 个**面板表面参与半透明：`--background` / `--card` / `--popover` / `--muted`，
写法是 `oklch(L C H / var(--panel-bg-opacity, 1))`。

- 唯一开关 `--panel-bg-opacity` 由 `src/renderer/App/hooks/useBackgroundImage.ts` 写在
  **`documentElement`**（**不能写 `body`**：自定义属性的 `var()` 代换发生在**声明所在元素**的
  computed-value 阶段，而这 4 个变量声明在 `:root` / `.dark`）。
- `--accent` / `--hover` / `--border` / `--input` **刻意不参与**：accent 半透明会让 hover 在背景图上消失；
  亮色下 `card` 与 `background` 的 ΔE_ok 只有 0.0096，面板层次全靠 `border` 撑，淡化 border 等于丢层次。
- **禁止**再在别处重复声明调色板（历史上曾有 `.bg-image-enabled` 与 JS inline 两份副本，已删）。
- **唯一合法的第二处声明**是 `theme = 'sync-terminal'`：`lib/ghosttyTheme.ts` 把这 4 个面板表面以
  inline style 写在**同一个 `documentElement`** 上，特异度上直接压过 `:root`。因此那条路径必须走
  `withPanelBgOpacity()`（`color-mix(in srgb, <色> calc(var(--panel-bg-opacity, 1) * 100%), transparent)`），
  否则一开背景图就整屏不透明、壁纸完全看不见。默认值 1 时该包装是恒等变换，不改变
  sync-terminal 下「谁覆盖谁」的既有边界（仍属 open-questions #12）。

### Monaco 内部的例外

`.current-diff-highlight` / `.current-diff-gutter` 作用在 Monaco 内部，而 **Monaco 底色来自终端主题**
（`EditorArea.tsx` 用 `terminalTheme` 构建 `monacoTheme`），不是 Flexoki。所以：

- 行高亮只能是「黑/白 + alpha」的**宿主无关中性叠加** → `--editor-current-diff`。
- gutter 竖条靠**色相**取胜而非明度 → `var(--accent-primary)`。选它而不是 `--primary` 的理由：
  `--accent-primary` 亮暗同值（`#F9AE77`），且**不在** `ghosttyTheme.ts` 覆盖的 25 个变量里；
  `sync-terminal` 下 `--primary` 会被改写成编辑器正文色，竖条就和正文同色、不再是高亮。

### 使用规范

```tsx
// 正文 / 标题 / 图标可读性 —— 默认用 foreground，不要用 primary
className="text-foreground"
className="text-muted-foreground"          // 次要文字

// 品牌 / 主操作 / 激活 / 选中 / 焦点 / 拖放
className="bg-primary text-primary-foreground"
className="border-primary"                  // 激活卡片 / tab 下划线

// hover 与选中底
className="hover:bg-accent/50"              // 旧代码沿用（既定强度）
className="bg-selection"                    // 树节点/列表项选中（禁止加 /N）

// 状态
className="text-success"                    // diff 新增
className="text-destructive"                // diff 删除 / 危险
className="bg-status-running"               // 运行中指示点（配 animate-pulse）
variant="destructive"
```

### `*-primary` 语义判据（`--primary` 已从中性反色变为品牌橙）

改造前 `text-primary` / `bg-primary` / `border-primary` 渲染成近黑/近白，改造后是橙。逐处判断用下面 4 条：

1. 该处承载的是**正文/标题/图标的可读性** → 改中性 token（`text-foreground` / `text-muted-foreground`）。
2. 该处表达**品牌、主操作、激活态、选中态、焦点、拖放目标、链接** → 保留 `*-primary`。
3. 低透明度底色（`/5`–`/20`）+ 文字是 `text-muted-foreground` → 是「中性提示框」，
   改 `bg-muted` + `border-border`。
4. 低透明度底色 + 文字是 `text-primary` → 是「品牌 pill / 激活 chip」，保留。

**禁止全局正则替换**：`text-primary` 会误伤 `text-primary-foreground`；
`accent-primary` 在 `AppearanceSettings.tsx` 里是 **Tailwind 的 `accent-color` 工具类**（4 处 range 滑块），
与新 token 生成的 `bg-accent-primary` / `text-accent-primary` 只差一个前缀，任何批量正则必须显式排除。

### 硬编码色禁令

组件里**不得**出现 `bg-amber-500` / `text-green-500` / `text-[#dcb67a]` /
`shadow-[0_2px_8px_rgba(0,0,0,0.12)]` 这类字面量。对照表：

| 场景 | ❌ 旧写法 | ✅ 语义 token |
|------|----------|--------------|
| 运行中指示点 | `bg-amber-500` | `bg-status-running` |
| 运行中横幅 | `border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-500` | `border-status-running/30 bg-status-running/10 text-status-running`（**`dark:` 前缀一并删掉**，token 已亮暗自适应） |
| diff 新增 / 删除 | `text-green-500` / `text-red-500` | `text-success` / `text-destructive` |
| 文件夹图标 | `text-[#dcb67a]` | `text-folder` |
| 任意阴影 | `shadow-[0_2px_8px_rgba(0,0,0,0.12)]` | `shadow-md` / `shadow-lg`（见 Shadow 分档） |

**注意：不要用 `warning` 代替 amber** —— Flexoki 的 `status.warning` 与 `primary.base` 逐位同色，
用了会跟品牌橙撞。「运行中」语义一律走 `status-running`。

### 新增 token 的强制动作

新增语义变量必须**同时**在 `globals.css:3-34` 的 `@theme` 补 `--color-*: var(--*)` 桥接，
否则 Tailwind v4 不会生成对应工具类。
（现成反例：`components/ui/sidebar.tsx` 整套 `bg-sidebar-*` 因为从未注册，至今是死件。）

### 已知偏差（Flexoki 原值，刻意不私自调色）

以下三处不满足 WCAG AA（4.5:1）小字要求，属沿用上游取值的**已知偏差**，改动需另立决策：

| 位置 | 对比度 |
|------|--------|
| `--success` 亮色（对 `background`） | 4.42:1 |
| `--destructive` 暗色 | 4.20:1 |
| `--muted-foreground` 暗色 | 4.49:1 |

另有两条**本次改造引入**的退化，记录待后续处理：

- `text-primary` 叠在 `bg-primary/20` 上，亮色仅 **3.61:1**（改造前是「近黑字 + 近黑 20% 底」，对比更高）。
  这套 pill/chip 组合全仓保留 20 处；新写这类 pill 建议文字用 `text-foreground` 或把底降到 `/10`。
- `ring-ring/24`（input / select / textarea / combobox / number-field / input-group 共 6 处）叠底后
  亮色仅 1.39:1。`--ring` 取无 alpha 值已避免归零，但这 6 处建议后续提到 `/40`。

## Design Tokens

设计 Token 统一在 `src/renderer/styles/globals.css` 的 `@theme` 中定义（CSS 变量），组件样式应优先使用这些层级化的 Token，而不是写任意值。

### Border Radius（圆角）

**根字号是 16px**（见下方「根字号结论」），所以下表的 px 就是**真实渲染值**，不再有 ×14/16 的折算。

| Level | Token | 声明值 | 真实值 | 典型场景 |
|------|------|-------|-------|---------|
| xs | `--radius-xs` | `0.25rem` | 4px | checkbox、badge、kbd 等内嵌元素 |
| sm | `--radius-sm`（= `--radius`） | `0.5rem` | **8px** | input、tab、tooltip 等交互元素 |
| md | `--radius-md` | `0.75rem` | 12px | card、alert、toolbar 等容器 |
| lg | `--radius-lg` | `1rem` | 16px | dialog、sheet 等顶层容器 |

**使用建议**：
- 小内嵌元素：优先 `rounded-xs`
- 交互元素：优先 `rounded-sm` / `rounded-md`
- 顶层覆盖层：优先 `rounded-lg` / `rounded-2xl`

**钳制硬规则（T-30 批 2 / D26）**：**`border-radius` 一旦 ≥ 元素高度的一半，CSS 会把它钳成满圆。**
所以在 `h-6`(24px) 上写 `rounded-md`(12) 或 `rounded-lg`(16)，与写 `rounded-full` **渲染完全相同**——
类名读起来是「中等圆角」，屏幕上却是一枚胶囊。据此三条：

1. **小控件（`h-6` / `h-7`）一律 `rounded-xs` / `rounded-sm`。**
2. **`rounded-md` 及以上只给高度 ≥32px 的容器。**
3. 满圆只在**刻意选择**时写 `rounded-full`，不要靠钳制「顺便」得到——
   靠钳制得到的满圆，会在元素高度变化的那天悄悄变回圆角矩形，而类名一个字都没改。

> 实测来历：Composer 的 Model / Effort 触发器写的是 `rounded-lg` 挂在 `h-6` 上，渲染成两枚满圆胶囊，
> 是第三轮点验「过于圆润、AI 化」归因里占比最大的一项。

#### Squircle（按钮原语，A05 基线）

按钮走**超椭圆**而非普通圆角，对齐
`openchamber/packages/ui/src/components/ui/button.tsx`。
`corner-shape: squircle` 下 `border-radius` 的语义从「圆弧半径」变成「超椭圆控制量」，
**需要远大于普通圆角的值**，所以必须写成**三件套**：

```
rounded-[10px]                                   ← 兜底：不支持 corner-shape 时的普通圆角
[corner-shape:squircle]                          ← 无条件下发
supports-[corner-shape:squircle]:rounded-[50px]  ← 支持时半径顶到 50px
```

**两条强制规则**：

1. **每个覆盖圆角的 size 变体都要成对重写这两行**。只写 `rounded-[9px]` 而漏掉 `supports-` 行，
   在支持 squircle 的浏览器上会渲染成几乎直角。
2. **`before:` 伪元素（内描边）必须同步下发**——`corner-shape` **不可继承**，
   漏了会出现「外框超椭圆 + 内描边普通圆角」的双轮廓：
   ```
   before:rounded-[9px] before:[corner-shape:squircle] supports-[corner-shape:squircle]:before:rounded-[49px]
   ```

**边界**：只改 `buttonVariants` 的 cva 类名，**不要换组件实现**——
本仓用 Base UI 的 `useRender` + `render` prop（23 处调用），与 OpenChamber 的 Slot / `asChild` **API 不兼容**。
同时**保留本仓独有**的：每个 size 的 `sm:` 响应式降档（删了桌面端会整体变高）、
`pointer-coarse` 44px 触控靶、10 个 size（含 5 个 icon 变体）、`active:scale-[0.97]`。

**按钮文案强制小写**（基类含 `lowercase`）。中文是 no-op；以下两类**必须加 `normal-case` 豁免**：

1. **中英混排的硬编码文案**，否则「一键安装 CLI」会变成「一键安装 cli」；
2. **按钮里渲染的动态标识符**——文件名、路径、分支名、模型名、hash。
   `lowercase` 是 `text-transform`，会继承到按钮的所有后代，把 `README.md` 显示成 `readme.md`、
   把大小写敏感的远端路径 `/home/Dan/Projects` 显示成 `/home/dan/projects`（**只影响显示，不影响回调取值**，
   所以不会报错，只会误导）。路径类**是否加 `font-mono` 不再是单点建议**——
   按「字体族（分域）」一节的域映射判定：出现在**内容**里的路径走 mono，
   出现在**控件**（按钮 / 下拉触发器 / chip）上的路径走 sans。完整映射见 D25 §2。

现有豁免共 6 处，清单见 `docs/plantree/plans/openchamber-chat-refactor/open-questions.md` 第 10 条补记。

### Shadow（阴影）

> **适用范围**：本表覆盖**覆盖层与容器**（popover / dialog / sheet / toast / 浮起工具栏）。
> **交互控件（按钮）不适用**——参考实现 OpenChamber 的按钮是**完全扁平**的
> （零 shadow 类，只过渡 `background-color,border-color,color,opacity`）；
> 本仓按钮当前保留 `shadow-xs` + `inset-shadow` 作为过渡态，**不得再往按钮上加 `shadow-md` / `shadow-lg`**。
> 需要「浮起感」时优先靠 `border` + `bg-card` 而不是阴影。

阴影遵循 5 级层次，层级越高，阴影越强：

| Level | Tailwind | 典型场景 |
|------|---------|---------|
| none | `shadow-none` | 平面内嵌元素、按钮（目标态） |
| xs | `shadow-xs` | input、card（紧贴背景） |
| sm | `shadow-sm` | 浮起工具栏、轻量下拉菜单 |
| md | `shadow-md` | popover、tooltip、浮动按钮 |
| lg | `shadow-lg` | dialog、sheet、command palette |

**禁止任意值阴影**：`shadow-[0_2px_8px_rgba(0,0,0,0.12)]` 这类写法会把黑色写死、亮暗共用，
一律换成上表分档。

**实测脚注（T-30 批 2）**：上面「需要浮起感时优先靠 `border` + `bg-card`」这条现在有实测背书——
**参照实现 Cursor 的输入卡是零阴影的**：卡边框外相邻 8 行像素恒等于背景值，无阴影、无渐变。
它读起来「浮起」只靠两件事：**卡填充比页面亮约 0.012 L** + **一条 L ≈ 0.94 的发丝边**。
本仓的对应组合就是 `bg-card` + `border-border`，**不需要也不应该补阴影**。

### 表单控件 vs 文字 chip（T-30 批 2 / D26）

**`SelectTrigger` / `Input` 是输入控件原语，不是「可点文字」的通用外壳。** 它们自带
`border` + `shadow-xs` + `before:` 内高光 + `min-w-*`，这套形制是为**表单页**设计的：
在一屏十几个字段的表单里，边框是在告诉用户「这里可以填」。

**工具条上的下拉不是表单字段。** 模型选择、分支选择、目标目录这类控件挂在信息密集的工具条上，
每一枚都带一圈边框加一层阴影时，容器与控件会争夺同一份「圆润 / 浮起」预算，读感立刻变成「控件堆」。

| 场景 | 用什么 | 形制 |
|------|-------|------|
| 表单页字段（设置页、对话框里的输入） | `Input` / `SelectTrigger` 原语 | 有边框、有 `shadow-xs`、有 `min-w` |
| 工具条 / 卡内的下拉（模型、档位、分支、目标目录） | **ghost chip** | 文字 + chevron + hover 底；**无边框、无阴影、无 `min-w`** |

参考实现：`composerModelTriggerClass()` / `targetTriggerClass()`（`chat/middleColumnLayout.ts`）。
两者的**高度类与横内距类必须一致**（可交叉断言）——同一条工具条上只允许存在**一种** ghost chip 形制。

**ghost chip 上的四条硬性禁止**：任何 `border*`；任何 `shadow*`（含 `before:` 内高光）；
任何 `min-w-*`（固定下限制造死空间，是「文字看起来没居中」这类误诊的常见真因——
居中的其实是一个比内容宽几十像素的盒子）；`rounded-md` 及以上（见 Border Radius 的钳制硬规则）。

### Ghost chip 悬停显壳（T-30 批 2 / D26）

ghost chip 静息态**没有任何外框**，「壳」只在交互时浮出。三条规则：

1. **壳用 `hover:bg-hover` 填充实现。**
2. **禁止用 `hover:border` 做壳。** 静息无边框、悬停加 1px 边框，会在悬停瞬间把元素撑高 2px，
   造成整行抖动；填充式壳的盒模型恒定。
3. **`hover:` 与 `focus-visible:` 必须成对给同一层底色。** 只挂 `hover` 的话，键盘用户 Tab 到该控件时
   屏幕上除了一圈 outline 没有任何形状变化，**完全失去控件边界**——
   「默认无框」是设计，「键盘用户看不见控件」是缺陷。outline 与底色两者**叠加**，不互相替代。

弹层打开时保持显壳并加重一档：`data-[popup-open]:bg-selection`。
`--hover` 与 `--selection` 在本仓已是预合成实色，**不要再叠 `/N` alpha**（见 Color System）。

### Typography（字号）

> **档位表已全部落成 `@theme` token（D25）。** 六个字号 token 均在 `globals.css` 的 `@theme` 中，
> 直接写 `text-code` / `text-meta` / `text-ui` / `text-markdown` / `text-title` 即可，不要写任意值。
> 调用点迁移状态见文首时效警示。

**四档语义体系保留**（对齐 OpenChamber `packages/ui/src/styles/design-system.css:21-27` 的桌面基线值），
D25 在其上做两件事：**补齐 token**、**给每一档标明字族**——分域之后「13px」与「mono」不再是同一件事。

| 语义档 | Size | Token | **字族** | 覆盖的用途 |
|-------|------|-------|---------|-----------|
| 2xs | **10px** | `--text-2xs` | **mono only** | `kbd` 快捷键 chip。**禁止承载 CJK**——中文 10px 不可读，见「CJK 级联规则」 |
| code | **13px**（0.8125rem） | `--text-code` | **mono** | 行内代码、代码块、工具行 ident 型参数、路径、hash、diff |
| meta | **13px**（0.8125rem） | `--text-meta` | sans | 时间戳、statusLine、meta 行、footer、次级说明 |
| ui | **14px**（0.875rem） | `--text-ui` | sans | 侧栏行、按钮、label、段头、tab、下拉触发器 |
| markdown | **15px**（0.9375rem） | `--text-markdown` | sans | 聊天正文、工具行动词、Markdown 全部内容、**以及所有标题 h1–h6** |
| title | **18px**（1.125rem） | `--text-title` | sans | 设置页 L1 与对话框 / 抽屉标题（唯一 >15px 的档） |

**为什么 `--text-meta` 与 `--text-code` 同为 13px 却必须是两个 token**：两者**变更理由不同**。
`--text-code` 的 13 是「对 15px sans 正文的**光学补偿值**」——同 px 下 mono 的视觉体量比 sans 大 8~12%
（平均 advance 0.6em vs 0.5em），15/13 的档比 0.867 正落在行业推荐带内；将来正文档位或 mono 栈变了，它必须跟着动。
`--text-meta` 的 13 是「次级 UI 文本」，不该被 mono 的光学调参拖着走。
合成一个 token 的后果很具体：**未来一次 mono 调参会静默改掉全部时间戳字号。**

**关键特征（照抄时最容易漏的一条）**：
**OpenChamber 的标题层级不靠字号区分。** `packages/ui/src/styles/typography.css:143` 的注释即
「Heading typography - all use markdown size, differentiated by weight/color」——
`typography-h1/h2/h3` 与 `typography-markdown-h1..h6` 的 `font-size` **全部**是 `var(--text-markdown)`（15px），
层级差异只来自三样：

1. **font-weight**
2. **letter-spacing**：h1 `-0.025em` → h2 `-0.02em` → h3 `-0.015em` → h4 `-0.01em` → h5 `0` → h6 `+0.01em`
   （`packages/ui/src/lib/theme/cssGenerator.ts:577-582`）
3. **color**：`markdown.heading1` / `heading2` … 各档取不同灰阶（flexoki-dark.json:132-133）

**比例字体下缩字号确实省宽，但仍然不用字号做标题层级。**
本文件旧版这里写的是「在全等宽 UI 里这条尤其重要：等宽字体放大后横向占位增长很快……」——
该理由**随 D25 作废**（比例字体下缩字号是真省宽的）。结论不变，理由换成两条：

1. 本项目最大的标题只有 18px，**字号维度本来就只剩一档余量**；把它花在标题上，正文与标题会挤在 15/18
   之间读不出差别，而 10~12px 的小字在 CJK 下不可读，向下也没有空间。
2. D25 之后 **weight（400/600 全平台可靠）+ letter-spacing 梯度 + color** 三件套**全部可用**，
   层级不再只能靠 color 一维硬撑。用三件套比动字号更稳、也更可回归（字号一动就牵连布局，权重和字距不会）。

**现有 6 级 → 4 档的过渡映射**（迁移归 T-22）：

| 现有 | Tailwind | 归入 | 备注 |
|------|---------|------|------|
| 2xs 10px | `text-2xs` | **保留**（仅 mono 拉丁） | D25 修正原「→ ui 14px」：10px 档在等宽时代只是装饰，比例字体下它是**唯一能装 `kbd` 的档**；但**任何可能承载 CJK 的 10px 一律升到 `--text-meta`(13)** |
| xs 12px | `text-xs` | → meta 13px / ui 14px / code 13px | 路径 / hash 类归 code，时间戳与次级说明归 meta，其余归 ui。**`text-xs` 在 `chat/` 与 `workspace-shell/` 已清零**（`chat/__tests__/fontDomainScan.test.ts` 有静态扫描断言守住） |
| sm 14px | `text-sm` | → ui 14px | 已对齐 |
| md 16px | `text-base` | → markdown 15px | 正文/次级标题 |
| lg 18px | `text-lg` | → settings-title 18px | 仅设置页 L1 保留 |
| xl 22px | `text-xl` | → markdown 15px + weight | **上游无此档**，标题不靠字号 |

`--text-2xs` 继续可用，写法：`text-2xs`（token 已注册，不要再写 `text-[10px]` 或 `text-[var(--text-2xs)]`）。

> **新增字号 token 的强制动作（工程注记，本仓踩过）**：任何新增的自定义字号 token
> **必须同步注册**进 `tailwind-merge` 的 `font-size` 类组（`src/renderer/lib/utils.ts` 的 `extendTailwindMerge`）。
> 不注册的话 `twMerge` 会把 `text-ui` 这种形状判成**颜色**类组，于是
> `cn('text-muted-foreground', 'text-ui')` **静默吞掉颜色**——不报错、不告警，只是颜色没了。
> （`text-2xs` 恰好匹配 tailwind-merge 默认的 t-shirt 尺寸正则，那是**巧合**，不能当先例；
> `text-tool-arg` 是颜色 token 而非字号，**刻意不注册**，它就该落在 `text-color` 组里。）

### Font Weight（字重）

字重是标题层级的**主要**载体（见上），不是可选装饰。但**有几档可用取决于字体栈**——
等宽栈时代实测 `semibold` / `bold` 全仓 **0 处**、`font-medium` 部分失效，实际可用只有 1 档；
D25 换到比例栈之后梯度才真正接通：

| Level | Tailwind | 场景 | **平台可靠性** |
|------|---------|------|--------------|
| normal | `font-normal` | 正文、描述、占位文本、工具行输出体、全部 muted 文本 | ✅ 全平台 |
| medium | `font-medium` | button、label、导航项、表头、**软强调** | ⚠️ macOS ✅（SF Pro Medium）· **Win11 ✅**（Segoe UI Variable，可变轴真值）· **Win10 ❌**（Segoe UI 静态族 300/350/400/600/700，**无 500**）· Linux ⚠️（视安装的子族） |
| semibold | `font-semibold` | 卡片 / 对话框 / 段落标题、正文相对 meta 的强调、顶栏标题 | ✅ 全平台（缺档时升到 700，只会更重，不会消失） |
| bold | `font-bold` | 仅 Markdown `**粗体**` 内联 | ✅ 全平台；**不用于 UI 层级** |

**两条硬约束**：

1. **500 不得作为任何层级区分的唯一载体。** CSS 字重匹配对目标 500 的规则是「先找 500，找不到就**降到 400**」
   （CSS Fonts 4 §5.2，注意**不是**升到 600）——所以 Win10 上 `font-medium` 与 `font-normal` **逐像素相同**。
   任何「必须在 Win10 上也看得出来」的区分，一律用 **400 vs 600**。
2. **`font-mono` 元素只用 400 / 700。** 系统等宽族普遍只有这两档，写 500 / 600 会触发**合成加粗**（笔画毛糙）。
   配套：`@layer base` 已设 `font-synthesis-weight: none`，缺档时走字重匹配而不是合成——
   对 sans 侧零代价（600 处处为真），对 mono 侧是保护。

### Letter-spacing（字距梯度）

上游 OpenChamber 的六级梯度（h1 `-0.025em` … h6 `+0.01em`）**不能原样搬**，两条硬理由：
① **负字距在 CJK 上会撞字**——CJK 字形本就满格排布，而我们的标题、侧栏会话标题、user 气泡都可能全是中文；
② **负字距的收益只在大字号出现**，本项目最大的标题只有 18px，15px 以下的负字距是纯风险无收益。

D25 的四档 + 一个例外：

| 档 | 值 | 域 |
|----|----|----|
| 段头 | `+0.04em` | `Recent` / `Repositories` 之类的分组段头（A07 明文裁定值，D25 后**数值不变**，只换了理由） |
| 微标签 | `+0.02em` | ≤11px 的 badge / 角标 / `kbd` 内文——小号比例字需要开距 |
| 按钮 | `+0.01em` | `ui/button.tsx` 基类已全局带 `tracking-[0.01em]`（比例字体下这条才开始真的起作用） |
| 正文 / UI | `0` | 正文、侧栏行、Composer、工具行、meta —— **默认** |
| 大标题（例外） | `-0.01em` | **仅 ≥18px**：`font-heading` 全仓 7 处，**已全部落地**（dialog / sheet / alert-dialog / empty / SessionManagerView ×2 / OnboardingView） |

**两条禁令（可静态断言）**：

- 🚫 **`font-mono` 元素禁止任何非零 `tracking`。** 等宽 + 字距 = 列对齐失效，工具输出 / diff 直接崩。
  唯一例外是 OTP 输入的 `tracking-[0.5em]`——那是刻意的字符分隔，不是排版微调。
- 🚫 **任何可能承载 CJK 的元素禁止负 `tracking`**，操作规则 = **「<18px 一律非负」**。
  ⚠️ 连带：**给共享基类加负字距时，必须同时清点它全部低于 18px 的覆写点，逐个补 `tracking-normal`**，
  否则负字距会跟着字号一起被带到小字上，漏一个就是一处 CJK 撞字。
  本仓实例：`EmptyTitle` 基类迁到 `text-title` + `-0.01em` 的同批，
  `workspace-shell/` 的 2 个 14px 覆写点（`LeftNav` / `SurfacePlaceholder`）与
  `layout/` 的 8 个 16px 覆写点（`TemporaryWorkspacePanel` · `TreeSidebar` ×2 · `WorktreePanel` ×3 · `RepositorySidebar` ×2）
  **全部带上 `tracking-normal`**。

### 数字对齐（tabular-nums）

**规则：任何会原地变化的数字，或任何需要跨行竖直对齐的数字，必须 `tabular-nums`。**

这条在等宽字体时代不存在——等宽下所有数字天然同宽。D25 换到比例栈之后它变成必答题：
比例字体的数字字形宽度不等（`1` 比 `0` 窄一截），一个每秒刷新的计时器会**逐帧左右跳**。
**这是 D25 引入的回归，不是既存问题**，所以必须与字族改动同批处理。

典型必须加的位置：

- 状态栏 / 状态行的**全部**数值项：百分比、金额、时长、`+N` / `-N` 行数、token 计数、缓存命中、API 耗时、版本号；
- 消息 meta 行的时间戳与耗时（`1.2s` / `HH:MM`）；
- 工具行里 prose 型参数中的数字（`Worked for 3s`、`2 files, 3 searches`）；
- 列表里右对齐的相对时间（`50m` / `3h` / `6d`）。

判据一句话：**它会不会在原地被换成另一个数？会 ⇒ 加。**

**相对时间统一实现（T-31 / P-18）**：分档判断（`now` / `Nm` / `Nh` / `Nd` / `Nw` / `Nmo` / `Ny`）只落一处——`src/renderer/lib/relativeTime.ts`——chat 回合尾部（`messageMetadata.ts` 的 `formatRelativeTimestamp`）与侧栏会话行共用同一份分档表，不得另起一份格式化逻辑，否则两处的「多久算 1h」会各自漂移。相对时间之外恒配 `title` 悬停给绝对时刻（`formatAbsoluteTime`），策略与侧栏一致。

### Motion（动画时长）

过渡动画统一为 3 档（Progress/Meter 指示器除外）：

| Tier | Duration | 场景 |
|------|----------|------|
| Fast | 100ms | 纯颜色变化（hover color、focus ring 出现） |
| Normal | 150ms | 交互反馈（button press、tooltip enter、toggle） |
| Slow | 250ms | 布局变化（面板展开/收起、对话框切换） |

**实现规范**：
- hover / focus：优先 `duration-150`
- 布局变化：使用 `duration-[250ms]`
- `Progress` / `Meter`：允许使用 `duration-500` 表达连续变化

## Spacing & Sizing

### 高度规范

| Component | Height | Tailwind |
|-----------|--------|----------|
| Tab 栏 | 36px | `h-9` |
| 树节点行 | 28px | `h-7` |
| 小按钮 | 24px | `h-6` |
| 输入框 | 36px | `h-9` |

### 间距规范

| Usage | Size | Tailwind |
|-------|------|----------|
| 紧凑间距 | 4px | `gap-1` |
| 标准间距 | 8px | `gap-2` |
| 宽松间距 | 12px | `gap-3` |
| 缩进 | 12px/层级 | `depth * 12 + 8px` |

### 新壳布局档位（D19 / T-22）

新壳 `components/workspace-shell/` 的三列 + 导轨为**硬性档位**，权威常量在
`components/workspace-shell/shellLayoutModel.ts`，改值必须同步本表：

| 区域 | 值 | Tailwind / 常量 |
|------|-----|----------------|
| Rail（图标导轨） | 固定 44px | `RAIL_WIDTH`（inline style，44px） |
| Rail 图标按钮 | 32px（图标 18px） | `size="icon"` · `size-4.5` |
| Rail 变更圆点 | 6px | `h-1.5 w-1.5` + `bg-info`（**仅 `git` surface**） |
| Sidebar（左列） | 默认 280px，可拖 280–500 | `SIDEBAR_DEFAULT_WIDTH` / `SIDEBAR_MIN_WIDTH` / `SIDEBAR_MAX_WIDTH` |
| Sidebar 折叠态 | 48px | `SIDEBAR_COLLAPSED_WIDTH` |
| ContextPanel（右列） | min 380 / max 1400，默认按 surface 取可用宽度比例 | `CONTEXT_PANEL_MIN_WIDTH` / `CONTEXT_PANEL_MAX_WIDTH` |
| ContextPanel 未测量兜底 | 600px | `CONTEXT_PANEL_FALLBACK_WIDTH` |
| ContextPanel 收起 | 宽 0（常驻挂载 + `inert`） | — |
| 阅读栏（中列） | `min(100%, 45rem)` 居中 | `mx-auto w-full max-w-reading`（`--container-reading`） |
| 阅读栏宽模式 | `min(100%, 60rem)` 居中 | `mx-auto w-full max-w-reading-wide`（`--container-reading-wide`） |
| 列宽拖拽把手 | 4px | `w-1` + `cursor-col-resize` |

**两条实现约束**：

1. 列宽变化统一 `duration-[250ms]`（Motion 的 Slow 档），**拖拽期间以 `data-resizing` 关掉过渡**——
   否则每帧过渡与指针位置打架，手感发黏。
2. 提升为全视图时面板宽度用**测量出的 px**、不用 `100%`：px 与百分比之间无法插值，会瞬跳。

> **阅读栏为什么是 45rem（D25 §3.4）**：换比例字体会把行拉长（48rem 下约 102 拉丁字符/行），
> 正确组合是「比例字体 **+** 收窄栏宽」，不是单纯替换字族。参照实现实测为 **48 CJK 当量/行**，
> 15px × 48 字 = 720px = **45rem**，逐字对齐；宽模式按同比例（−6.25%）从 64rem 收到 60rem。
> 两个值落成 `@theme` 的容器 token（`--container-reading{,-wide}`）而不是 `max-w-[45rem]` 任意值。

## 字体族（分域：UI 比例 / 代码等宽）

> **D25（2026-07-30）撤销 D18③。** 旧口径「`sans` / `mono` / `heading` 三键统一为同一条等宽栈」
> **不再有效**。触发是 open-q #10「中英混排风险」实测结项——风险坐实，不是理论洁癖。

### 两条栈

`--font-sans` 是整个 UI 的默认字族；`--font-mono` **只服务白名单域**——代码块、行内 `<code>`、
工具行的 ident 型参数与原始输出、diff、路径、hash、`kbd`、终端、编辑器。

```css
/* src/renderer/styles/globals.css 的 @theme —— 完整串与逐段依据见 D25 §1.3 */
--font-sans:
  -apple-system, BlinkMacSystemFont,           /* macOS → SF Pro，400/500/600/700 全真 */
  "Segoe UI Variable Text", "Segoe UI",        /* Win11 可变轴 / Win10 静态族 */
  "Ubuntu", "Cantarell", "Noto Sans", "Liberation Sans", Arial,
  "PingFang SC", "Hiragino Sans GB",           /* ← CJK 段一律排在 Latin 段之后 */
  "Microsoft YaHei UI", "Microsoft YaHei",     /* UI 版在前：为界面调过 hinting */
  "Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans SC", "WenQuanYi Micro Hei",
  "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji",  /* ← 必须在通用族之前，否则不可达 */
  sans-serif;

--font-mono:
  ui-monospace, "SF Mono", "SFMono-Regular", "Menlo",
  "Cascadia Mono", "Consolas", "Liberation Mono", "DejaVu Sans Mono",
  "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC",
  "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji",
  monospace;

--font-heading: var(--font-sans);
```

**为什么是系统栈、不随包任何 webfont**：决定性因素是 **CJK**。Latin 侧随包一个可变字体只要 ~250KB，
CJK 侧做子集化覆盖常用 3500 字也要 1.5~3MB、全量 8~12MB。而「随包 Latin + 系统 CJK」比全系统栈**更难看**——
`SF Pro ↔ PingFang SC`、`Segoe UI ↔ Microsoft YaHei UI` 是**厂商成对设计**的（x-height、字重感知、基线、标点位置都对过），
塞一个第三方 Latin 进去等于把两个互不认识的字体强行混排，正是「不协调」的另一种形态。
用户 CJK 重度使用 ⇒ 这条压倒「跨平台一致性」。附带：系统栈使本项对产物体积**零增量**。

**为什么改 `--font-sans` 就等于改了整个 UI 的字体**：
Tailwind 的 `theme.css` 把 `--default-font-family` 定义为 `--theme(--font-sans, initial)`，
`preflight.css` 再把它挂到 `<html>`；而本仓的 `body` 只有 `@apply bg-background text-foreground`，
**全仓没有任何 `font-family` 声明**。所以 `--font-sans` 是 UI 字体的**唯一入口**，
不需要额外给 `body` 加 `font-sans`。

**必须写字面量栈，不要写 `var(--font-family-sans, …fallback…)`**：
历史上 `--font-family-sans` 被引用却从未定义过，等于把整个 UI 字体交给一个悬空变量的 fallback，
后来的人去改那个变量会毫无效果。同理仓内**没有** `@font-face`、没有 woff/ttf 资源，
所以任何非系统字体（Inter / JetBrains Mono）写进栈里都是空头支票，实际会落到系统兜底。
**D25 把这条从「写法纪律」升格为「选型理由」**：正因为仓内零字体基建，比例栈才只能是系统栈——
随包字体不是改一行 token，是新建一整套资产 / 打包 / 许可证链路，属独立立项。

### 域怎么划：判据是「内容 vs 控件」，不是「是不是标识符」

同一个字符串 `WorkspaceShell.tsx`，出现在正文里用 mono，出现在下拉按钮 / 文件卡上用 sans。
一句话测法——**用户会不会去逐字符读它、比对它、复制它？**
会 ⇒ mono；只是拿它当一个「名字」点一下 ⇒ sans。
完整域映射表（mono 白名单 12 项 / sans 域 26 项）见 D25 §2：`docs/plans/2026-07-30-d25-font-domain-design.md`。

**落法是「sans 默认 + mono 白名单」（正向），不做反向。** 决定性理由是**失败模式**：
漏标一处，正向落法只会把它渲染成比例字体（参照实现里文件名 / 分支名本来就是比例，降级后仍在目标态附近）；
反向落法会把它渲染成等宽——**正是要消灭的那个 bug**。选失败模式良性的那个方向。

**不要裸撒 `font-mono`。** 走三个原语：`ui/ident.tsx` 的 `<Ident>`（`font-mono` + `text-code` + `tracking-normal`）、
`<CodeInline>`（`<Ident>` + `bg-muted` chip）、以及已有的 `ui/code-block.tsx`。
收益：光学补偿逻辑只有一处可调；`font-mono` 的出现点可以用一行静态扫描断言锁死在白名单文件内。

⚠️ **`font-mono` 与 `font-sans` 视觉无差别，在 D25 之后是 bug 判据，不是目标。**
本文件旧版这里写的是「这是『全等宽 UI』的目标，不是 bug」——该句**随 D18③ 一并作废**。
现在的判据反过来：**若某处 UI 文本渲染成等宽，而它不在 mono 白名单里，那就是一处待修的回归。**

### 分离契约：UI 字体 ≠ 终端/编辑器字体（强制）

这是 T-21 拆掉的一个现存 bug，**不得回退**：

| 消费方 | 字体来源 | 说明 |
|--------|---------|------|
| **UI（全部 React 组件）** | `@theme` 的 `--font-sans` / `--font-mono` / `--font-heading` | 唯一入口，见上 |
| **xterm 终端** | **JS option**（`useXterm` 读 store 的 `terminalFontFamily` / `terminalFontSize`，构造 `new Terminal({ fontFamily, fontSize })`） | **不读任何 CSS 变量** |
| **Monaco 编辑器** | `editorSettings`（`EditorArea` 直接传 option） | **不读任何 CSS 变量** |

**红线**：
- **终端 / 编辑器的字体设置，一律不得写入 `documentElement` 的 CSS 变量。**
  改造前 `stores/settings/index.ts` 的 `applyTerminalFont()` 把终端字体同时写进 `--font-family-mono`
  （污染 41 处 `font-mono` 的 UI）和 `--font-size-base`（**把整个 UI 按 `terminalFontSize/16` 等比缩放**——
  用户把终端字号从 16 调到 24，界面就放大 50%）。该函数已整体删除。
- `globals.css` 的 `.xterm*` 规则只设宽高与 background，**不设 font**，保持现状。
- `settings` store 里的 `fontFamily`（默认 `'Inter'`）与 `fontSize`（默认 `14`）是**历史死字段**，
  声明在 `types.ts`、有 setter、但零消费方。**T-21 刻意不接线。**
  将来若要接：`fontFamily` → 覆盖 `--font-sans`、`fontSize` → 覆盖 `--font-size-base`；
  届时**必须同步把默认值改成上面的比例栈字面量 / 16**（D25 后不再是等宽栈），
  否则会二次引入刚消灭的 14→16 跳变，以及 T-21 刚消灭的字体注入 bug。

### CJK 级联规则（open-q #10 已结项 → D25）

原「中英混排风险（未结项）」记的是：全等宽栈里没有 CJK 字形，中文回退系统字体 → 等宽拉丁 + 非等宽 CJK 混排，
行内节奏 / 基线 / 标点都可能崩。**2026-07-30 实测证实风险坐实，open-q #10 结项，解法就是 D25 的分域。**
分域之后风险不会自动消失——CJK 混排的正确性由下面四条规则承担：

1. **Latin 段在前，CJK 段在后。** 字体匹配是**逐字符**的：拉丁字符落在第一个有该字形的族上，
   CJK 字符一路穿到第一个 CJK 族。顺序反了会让拉丁字母落进 CJK 字面里渲染——
   中文环境「丑拉丁」的经典成因。
2. **禁止写 `system-ui`。** 在 Chromium / Windows 上它按**系统区域**解析，
   zh-CN 机器会直接把 Latin 交给 CJK 字面，正好触发规则 1 要防的那个失败。
   `--font-sans` 里**刻意没有**这一项，不要「顺手补上」。
3. **10px 禁止承载 CJK。** `--text-2xs`(10px) 只给纯拉丁 / 数字（`kbd` 快捷键 chip）。
   中文在 10px 下不可读——这不是审美判断，是识别率问题。任何可能出现中文的位置，最小档是 `--text-meta`(13px)。
4. **负 `tracking` 禁止用于 CJK**，操作规则 = **「<18px 一律非负」**（见「Letter-spacing（字距梯度）」）。

**两条附带纪律**：

- **不设 `-webkit-font-smoothing: antialiased`。** 它只在 macOS 生效、会让 400 视觉变细；
  本项目 Windows 优先，且三级灰最浅档的对比度本就吃紧，抽细笔画会把刚修好的对比度吃回去。
- **`--font-mono` 里也带 CJK 段**，为的是代码块 / 工具输出里出现中文注释或中文路径时不落到随机字体。

**验收测点（三处，沿用 open-q #10 原定）**：① 阅读栏中文段落 + 中英混排；
② 侧栏中文会话标题 + 分支 chip + 相对时间同行 truncate；③ 工具行中文动词 + 拉丁路径同行。
三测点各出「现状 mono / D25 split / 参照实现」三图并排，视觉凭证见 `docs/design/a09-font-domain-baseline.html`。

## 根字号结论（T-21 已结）

**根字号 = 16px，数值不变，改的是治理。**

改造前 `globals.css` 声明 `--font-size-base: 14px`，但 `stores/settings/index.ts` 的 `applyTerminalFont()`
把 `terminalFontSize`（默认 **16**）以 **inline style** 写到 `documentElement` 的 `--font-size-base`，
inline 永远赢 `:root` 声明 → **运行时稳态一直是 16px**。
所以 `--radius: 0.5rem` 真实就是 **8px**，与 OpenChamber（无 `html` font-size 覆盖，依赖浏览器默认 16px）**天然对齐**。

> ⚠️ 本文件旧版警示里「根字号 14px 使全仓 rem ×14/16、`--radius` 真实 7px」的说法**是错的**，
> plantree open-questions #11 的同一前提也已更正。

**落地为三行**：

1. `globals.css` 的 `--font-size-base` 声明改成 `16px`。
2. 删掉 `settings/index.ts` 对 `--font-size-base` 的 inline 注入。
3. 删掉同处对 `--font-family-mono` 的注入（即整个 `applyTerminalFont`）。

`html { font-size: var(--font-size-base) }` **保留不动**——`--font-size-base` 声明在 `:root`（即 html 自身），
代换后恒为 16px，同时给未来接线「UI 字号设置」留一个单点开关。

**收益**：

- **消灭首帧跳变**：`electronStorage.getItem` 是 async，persist rehydrate 之前页面按 `:root` 的 14px 渲染，
  hydrate 后被 inline 16px 顶掉 → 全局 rem 元素跳一次 14.3%。改后无跳变。
- **消灭「调终端字号 = 缩放整个 UI」** 这个现存 bug。

**「视觉零位移」的边界（须进 release note）**：只对 `terminalFontSize` 保持默认 16 的用户成立。
改过终端字号的存量用户，UI 目前被按 `terminalFontSize/16` 缩放，改完会回到 100%——
这是**修 bug 不是回归**，但对他们是可见变化。

## Components

### File Tree Node

```tsx
<div
  className={cn(
    'flex h-7 cursor-pointer select-none items-center gap-1 rounded-sm px-2 text-sm hover:bg-accent/50',
    // 选中态：新代码用 bg-selection（比 hover 重一档，禁止加 /N）
    // 旧代码沿用 bg-accent，迁移归 T-25
    isSelected && 'bg-selection text-accent-foreground'
  )}
  style={{ paddingLeft: `${depth * 12 + 8}px` }}
>
  {/* 目录展开图标 */}
  {node.isDirectory ? (
    <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground', isExpanded && 'rotate-90')} />
  ) : (
    <span className="w-4" />  {/* 占位保持对齐 */}
  )}

  {/* 文件图标 */}
  <Icon className={cn('h-4 w-4 shrink-0', iconColor)} />

  {/* 文件名 - min-w-0 确保 truncate 生效 */}
  <span className="min-w-0 flex-1 truncate">{node.name}</span>
</div>
```

### Editor Tabs

```tsx
<div className="flex h-9 shrink-0 border-b bg-muted/30">
  {tabs.map((tab) => (
    <div
      className={cn(
        'group relative flex h-9 min-w-[120px] max-w-[180px] items-center gap-2 border-r px-3 text-sm',
        isActive
          ? 'bg-background text-foreground'
          : 'bg-muted/50 text-muted-foreground hover:bg-muted'
      )}
    >
      {/* 激活指示器 - 品牌橙，属"激活态"语义，保留 primary */}
      {isActive && <div className="absolute inset-x-0 top-0 h-[2px] bg-primary" />}

      {/* 图标 */}
      <Icon className={cn('h-4 w-4 shrink-0', iconColor)} />

      {/* 标题 */}
      <span className="flex-1 truncate">{tab.title}</span>

      {/* 关闭按钮 - 次要控件，用中性色；用 primary 会让橙色抢走视觉重心 */}
      <button className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  ))}
</div>
```

### Context Menu

```tsx
<Menu open={menuOpen} onOpenChange={setMenuOpen}>
  <MenuPopup style={{ position: 'fixed', left: x, top: y }}>
    <MenuItem onClick={handler}>
      <Icon className="h-4 w-4" />
      Label
    </MenuItem>
    <MenuSeparator />
    <MenuItem variant="destructive" onClick={deleteHandler}>
      <Trash2 className="h-4 w-4" />
      Delete
    </MenuItem>
  </MenuPopup>
</Menu>
```

### Icon Buttons (工具栏图标按钮)

用于工具栏、搜索框等场景的小型图标按钮。

**基础样式（无状态）**：
```tsx
// 普通图标按钮 - 用于关闭、刷新等操作
<button
  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground"
>
  <X className="h-3.5 w-3.5" />
</button>
```

**切换按钮（有选中状态）**：
```tsx
// 切换按钮 - 用于大小写敏感、正则等开关
<button
  className={cn(
    'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground',
    isActive && 'bg-primary/20 text-primary'
  )}
>
  <CaseSensitive className="h-4 w-4" />
</button>
```

**带文字的切换按钮**：
```tsx
// 模式切换 - 用于 Tab 切换等
<button
  className={cn(
    'flex items-center gap-1 rounded px-2 py-1 text-xs',
    isActive
      ? 'bg-primary/20 text-primary'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
  )}
>
  <FileCode className="h-3.5 w-3.5" />
  Content
</button>
```

**规则总结**：
| 状态 | 样式 |
|------|------|
| 默认 | `text-muted-foreground` |
| 悬停 | `hover:bg-accent/50 hover:text-foreground` |
| 选中 | `bg-primary/20 text-primary` |
| 尺寸 | `h-6 w-6`（图标按钮）或 `px-2 py-1`（带文字）|
| 图标 | `h-3.5 w-3.5` 或 `h-4 w-4` |

**注意**：
- 悬停背景使用 `bg-accent/50`（半透明），不要用 `bg-accent`（太强烈）
- 选中状态使用 `bg-primary/20 text-primary`（品牌 chip），不要用 `bg-accent`
- ⚠️ **可访问性**：`text-primary` 叠在 `bg-primary/20` 上亮色仅 **3.61:1**，小字不过 AA。
  文字很小（≤12px）时改用 `text-foreground`，或把底降到 `bg-primary/10`。见 Color System「已知偏差」。
- **列表/树的行选中态**用 `bg-selection`（不加 `/N`），不要用这套 chip 样式

### Dialog

```tsx
<Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
  <DialogPopup>
    <DialogHeader>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description text.</DialogDescription>
    </DialogHeader>
    <DialogPanel>
      {/* Content */}
    </DialogPanel>
    <DialogFooter variant="bare">
      <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
      <Button onClick={onConfirm}>Confirm</Button>
    </DialogFooter>
  </DialogPopup>
</Dialog>
```

### ScrollArea 按边 fade（T-31）

`ui/scroll-area.tsx` 的 `scrollFade` 支持 `boolean | 'top' | 'bottom'`：`true` 是既有的四边渐隐（默认行为不变，三个既有调用点 combobox / sheet / autocomplete 零改动）；`'top'` / `'bottom'` 只在对应一边渲染 mask 渐隐，`--fade-size`（1.5rem）不变。

按边 fade 用于滚动容器某一侧不该再渐隐的场景。例子：聊天时间线顶部原来四边渐隐，是为了把「回合顶部滚出视口」的硬切软化；T-31 给顶部接上 per-turn 的 sticky 用户气泡带之后，视口顶端恒为一条不透明的气泡带，硬切面已经消失，顶部渐隐反而会把钉住的气泡吃掉一截——改传 `scrollFade="bottom"`，只保留底部软边。

### `scroll-state.css` 独立于 Tailwind 管线（T-31）

`src/renderer/styles/scroll-state.css` 承载 `@container scroll-state(stuck: top)` 容器查询（钉住态用户气泡的 3 行截断）。**Tailwind v4 的 lightningcss 管线无法解析这个语法，且静默丢弃这条规则**——不报错、构建照常通过，规则只是从产物 CSS 里消失。该文件因此**不走 `globals.css` 的 Tailwind 管线**，改走 Vite 原生 CSS 管线（postcss + esbuild），并因此**永远不得写入任何 Tailwind 指令**（`@import "tailwindcss"` / `@theme` / `@apply` 等）——写了任何一条都会把它重新路由回 lightningcss，规则再次被吞。新增类似的、依赖前沿 CSS 语法的样式文件时按同一判据处理：先确认 lightningcss 能不能解析，不能就走这条独立文件路线，不要指望构建报错来发现。

## Icons

### 文件图标映射

使用 Lucide icons，根据文件扩展名和目录状态选择：

```tsx
// 目录
FolderOpen  // 展开状态
Folder      // 收起状态

// 常见文件类型
FileCode    // .ts, .tsx, .js, .jsx
FileJson    // .json
FileText    // .md, .txt
FileImage   // .png, .jpg, .svg
Settings    // 配置文件
```

### 图标颜色

| Type | Color | 状态 |
|------|-------|------|
| 目录 / 文件夹 | **`text-folder`** | ✅ 语义 token（T-21） |
| TypeScript | `text-blue-500` | ⏳ 待迁移（T-25） |
| JavaScript | `text-yellow-400` | ⏳ 待迁移（T-25） |
| JSON | `text-yellow-600` | ⏳ 待迁移（T-25） |
| Markdown | `text-gray-400` | ⏳ 待迁移（T-25） |
| 图片 | `text-purple-500` | ⏳ 待迁移（T-25） |
| 默认 | `text-muted-foreground` | ✅ |

**新代码不得再写 `text-yellow-500` 之类的原色**；文件类型色板的整体语义化归 **T-25**
（`files/fileIcons.tsx` 等旧调用点在 T-25 前保持原样）。

## Monaco Editor

### Worker 配置

避免 CSP 问题，使用本地 worker：

```tsx
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// ... 其他 workers

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    // ...
    return new editorWorker();
  },
};
```

### 主题同步

Monaco 主题从终端主题 (Ghostty) 生成：

```tsx
monaco.editor.defineTheme('aiclient-theme', {
  base: isDark ? 'vs-dark' : 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: xtermTheme.brightBlack },
    { token: 'keyword', foreground: xtermTheme.magenta },
    { token: 'string', foreground: xtermTheme.green },
    // ...
  ],
  colors: {
    'editor.background': xtermTheme.background,
    'editor.foreground': xtermTheme.foreground,
    // ...
  },
});
```

### 语言检测

使用 `path` prop 自动检测语言：

```tsx
<Editor
  path={activeTab.path}  // Monaco 根据路径自动检测语言
  value={activeTab.content}
  // ...
/>
```

## Interaction Patterns

### 文件树

- **单击文件**: 在编辑器中打开
- **单击目录**: 展开/收起
- **右键**: 打开上下文菜单

### Tab 栏

- **单击 Tab**: 切换到该文件
- **拖拽 Tab**: 重新排序
- **点击关闭按钮**: 关闭文件
- **Cmd/Ctrl+S**: 保存当前文件

## Flexbox 技巧

### 文本截断对齐

```tsx
// 父容器
className="flex items-center gap-1"

// 固定宽度元素
className="h-4 w-4 shrink-0"

// 可截断文本
className="min-w-0 flex-1 truncate"
```

`min-w-0` 是关键 - 允许 flex 子元素收缩到内容尺寸以下。

## Animation System

本项目使用 **Framer Motion** 作为动画库，配置集中在 `src/renderer/lib/motion.ts`。

### 设计原则

- **时长分档**：过渡动画遵循 100 / 150 / 250ms 三档（见上方 Motion Token），默认使用 `duration-150`
- **Spring 物理**：使用 Spring 弹性动画，带来自然的物理感
- **GPU 加速**：优先使用 `transform`、`opacity` 属性，启用硬件加速

### Spring 配置

| 名称 | 参数 | 适用场景 |
|------|------|----------|
| `springFast` | stiffness: 500, damping: 30 | Dialog、Menu 等弹出层 |
| `springStandard` | stiffness: 400, damping: 30 | 面板伸缩、布局动画 |
| `springGentle` | stiffness: 300, damping: 25 | Tooltip、微交互 |

### 通用 Variants

```tsx
import {
  fadeVariants,
  scaleInVariants,
  slideUpVariants,
  heightVariants,
  springFast
} from '@/lib/motion';

// 弹出层（Dialog、Menu）
<motion.div
  variants={scaleInVariants}
  initial="initial"
  animate="animate"
  exit="exit"
  transition={springFast}
>

// 高度展开（Accordion、列表）
<motion.div
  variants={heightVariants}
  initial="initial"
  animate="animate"
  exit="exit"
  transition={springStandard}
>

// Toast 通知
<motion.div
  variants={slideUpVariants}
  initial="initial"
  animate="animate"
  exit="exit"
>
```

### 微交互

```tsx
import { tapScale, hoverScale } from '@/lib/motion';
import { motion } from 'framer-motion';

// 按钮点击反馈
<motion.button whileTap={tapScale}>
  Click me
</motion.button>

// 悬浮放大
<motion.div whileHover={hoverScale}>
  Hover me
</motion.div>
```

### AnimatePresence 使用

所有条件渲染的动画元素必须用 `AnimatePresence` 包裹：

```tsx
import { AnimatePresence, motion } from 'framer-motion';

<AnimatePresence mode="wait">
  {isOpen && (
    <motion.div
      key="content"
      variants={fadeVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      Content
    </motion.div>
  )}
</AnimatePresence>
```

### Layout 动画

使用 `layout` 属性实现元素位置/尺寸的平滑过渡：

```tsx
// Tab 指示器滑动
<motion.div
  layoutId="tab-indicator"
  className="absolute bottom-0 h-0.5 bg-primary"
/>

// 列表项排序
<motion.div layout>
  {item.name}
</motion.div>
```

### 列表 Stagger 动画

```tsx
import { listContainerVariants, listItemVariants } from '@/lib/motion';

<motion.ul variants={listContainerVariants} initial="initial" animate="animate">
  {items.map((item) => (
    <motion.li key={item.id} variants={listItemVariants}>
      {item.name}
    </motion.li>
  ))}
</motion.ul>
```

### 性能注意事项

1. **避免频繁的 `height: 'auto'`**：对大列表使用虚拟化
2. **使用 `will-change` 谨慎**：仅在必要时添加
3. **避免同时动画多个属性**：优先使用 `transform` 系属性
