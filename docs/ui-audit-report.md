# UI/UX 设计审查与优化方案

> 审查日期: 2026-04-14
> 审查范围: jyw-ai-client 全项目 UI 层
> 状态: 仅分析和方案规划，不涉及代码修改

---

## 一、问题清单

### P0 — 严重影响可用性

#### 1.1 Tab 按钮文字在窄视口下竖排

- **位置**: `src/renderer/components/layout/MainContent.tsx:384-401`
- **现象**: 「文件」「终端」「版本管理」等 tab 按钮的 `<span>` 文字没有 `whitespace-nowrap`，当 header 容器横向空间不足时，中文字符会逐字换行、视觉上变为竖排。
- **根因**: tab 按钮样式 `flex h-8 items-center gap-1.5 rounded-md px-3 text-sm` 未设置 `whitespace-nowrap` 或 `shrink-0`；其父容器 `<div className="flex items-center gap-1 no-drag">` 也没有 `overflow-hidden` 或 `flex-nowrap` 保护。
- **影响范围**: 所有窗口宽度 < ~800px 时可复现，尤其是同时展开侧边栏 + 文件面板时 MainContent 被压缩。

#### 1.2 用户余额 Pill 与标题栏空间比例失调

- **位置**: `src/renderer/components/layout/WindowTitleBar.tsx:93-98, 119-142`
- **现象**: 用户余额 pill（`h-7 rounded-full px-2`）内含 Avatar(`size-6`) + 分隔线 + 费用文字，在 `h-8` 的标题栏中仅剩 `0.5rem` 垂直呼吸空间（上下各 2px）。Pill 总宽度约 100-120px，当标题栏右侧还有 Settings 按钮 + More 菜单 + 窗口控制按钮时，整体显得拥挤。
- **根因**: 标题栏高度 `h-8`(32px) 对于 pill 风格组件来说过于紧凑；pill 内 `gap-2`(8px) 加上 Avatar `size-6`(24px) 几乎撑满垂直空间。

#### 1.3 MainContent 硬编码最小宽度

- **位置**: `src/renderer/components/layout/MainContent.tsx:268`
- **现象**: `min-w-[535px]` 硬编码，当窗口总宽度小于侧边栏宽度 + 535px 时，会出现内容溢出或布局折叠。
- **根因**: 没有针对小窗口的降级方案，min-width 阻止了正常的 flex 收缩。

---

### P1 — 显著影响视觉一致性

#### 1.4 圆角半径 (border-radius) 不统一

**当前使用了至少 7 种圆角值，缺乏明确层级关系:**

| 使用位置 | 圆角值 | Tailwind 类 |
|---------|--------|------------|
| Card、Dialog、Sheet、Frame | 16px | `rounded-2xl` |
| Alert | 12px | `rounded-xl` |
| Button、Menu popup、Input、Select、Popover、Tabs、CodeBlock | 8px | `rounded-lg` |
| Menu items、Combobox items | 4px | `rounded-sm` |
| Badge | ~2px | `rounded-sm` (实际 calc) |
| Checkbox | 4px | `rounded-[4px]` (硬编码) |
| Avatar、Switch、ActivityIndicator、Scrollbar thumb | 9999px | `rounded-full` |
| 标题栏 icon buttons | 4px | `rounded-sm` |

**问题**: 
- Button 用 `rounded-lg`(8px)，但标题栏 icon button 用 `rounded-sm`(4px)，同为按钮但圆角不同。
- Menu popup 用 `rounded-lg`(8px)，但内部 Menu items 用 `rounded-sm`(4px)，层级关系不够清晰。
- Alert 用 `rounded-xl`(12px) 是唯一使用此值的组件，与整体体系脱节。

#### 1.5 阴影 (box-shadow) 层级不一致

| 使用位置 | 阴影等级 |
|---------|---------|
| Button (outline/default)、Badge (outline)、Input、Card | `shadow-xs` |
| Popover、Menu、Dialog、Command、Toast、Sheet | `shadow-lg` |
| Tooltip | `shadow-md` |

**问题**:
- 缺少 `shadow-sm` 级别的使用，从 `xs` 直接跳到 `lg`，视觉层次断裂。
- Button 的 `inset-shadow` 与 Card 的 `before:shadow` 使用了两套不同的阴影模拟机制，增加理解成本。

#### 1.6 过渡动画时长不统一

| 使用位置 | 时长 |
|---------|------|
| Button、Toggle、Label hover | `duration-150` |
| Collapsible、SmoothCollapse、Panel resize | `duration-200` |
| Progress/Meter indicator | `duration-500` |
| AlertDialog | `duration-200 ease-out` |
| Accordion | `duration-150` + custom cubic-bezier |
| Dialog | `duration-150` + custom cubic-bezier |

**问题**: 项目内同时存在 150ms、200ms、500ms 三种基准时长。按钮用 150ms 但面板用 200ms，用户在不同交互中感受到不一致的节奏感。

#### 1.7 Focus ring 不一致

- Button、Badge、Select: `focus-visible:ring-2`
- Combobox、Input: `ring-[3px]`
- 部分自定义按钮（标题栏、侧边栏 header）: 无 focus ring

---

### P2 — 影响排版质量

#### 1.8 字体大小层级体系混乱

**当前项目使用了以下字号:**

| 字号 | 实际大小 | 使用场景 |
|------|---------|---------|
| `text-[9px]` | 9px | Worktree status badge (TreeSidebar:~Line 990) |
| `text-[10px]` | 10px | Activity counts (TreeSidebar:~Line 1000) |
| `text-xs` | 12px | 次要标签、Badge sm、Kbd、辅助文字 |
| `text-sm` | 14px | 主要 UI 文字、按钮、输入框（绝大多数组件） |
| `text-base` | 14px (被 `--font-size-base: 14px` 覆盖) | Button/Label 基准 |
| `text-lg` | 18px | CardTitle、Dialog 标题、Settings 标题 |
| `text-xl` | 20px | AlertDialog 标题 |

**问题**:
- **`text-sm` 与 `text-base` 等效** — 因为 `html { font-size: 14px }`，`text-base`(1rem) = `text-sm`(0.875rem × 16 ≈ 14px)。但实际 `text-sm` = 0.875rem = 12.25px，`text-base` = 1rem = 14px，**二者并不相等，差距约 1.75px**。这导致 Button (`text-base`) 和 Input placeholder (`text-sm`) 字号微妙不同但肉眼难辨，反而造成视觉不齐整。
- **`text-[9px]` 和 `text-[10px]` 是硬编码的任意值**，游离于 Tailwind 字号体系之外，且在高 DPI 屏幕上可能模糊。
- **标题层级扁平**: h1-h6 没有系统使用，Dialog 标题用 `text-xl`(20px)，Settings 标题用 `text-lg font-medium`(18px)，Card 标题用 `text-lg font-semibold`(18px)，差异仅靠字重区分。

#### 1.9 字重 (font-weight) 使用不够一致

| 组件 | 字重 |
|------|------|
| Button | `font-medium` (500) |
| CardTitle | `font-semibold` (600) |
| Badge | `font-medium` (500) |
| Dialog title | 无显式字重 (继承 normal 400) |
| Settings nav label | 无显式字重 |
| Tree node name | `font-medium` (500) |
| Input label | `font-medium` (500) |

**问题**: Dialog 标题没有设置字重，与 CardTitle 的 `font-semibold` 不一致。同为「标题」角色但字重不同。

#### 1.10 行高 (line-height) 混用

- Button: `text-base` 隐含行高 + `leading-8.5`（Input 组件）
- Label: `text-base/4.5`（自定义 line-height ratio）
- 大部分组件: 使用 Tailwind 默认行高

**问题**: 自定义行高值 (`/4.5`, `leading-8.5`) 散落在个别组件中，增加维护复杂度。

---

### P3 — 细节优化

#### 1.11 树节点与 Worktree 项的尺寸不协调

- **位置**: `src/renderer/components/layout/TreeSidebar.tsx`
- 仓库名: `px-2 py-2 rounded-lg`（总高度约 40px+）
- Worktree 项: `px-2 py-1.5 rounded-lg`（总高度约 32px）
- 设计系统规范: 树节点 `h-7`(28px)
- **问题**: 实际实现未遵循 `h-7` 规范，仓库项和 worktree 项高度不一致。

#### 1.12 设置对话框固定高度

- **位置**: `src/renderer/components/settings/SettingsDialog.tsx`
- 内容区: `min-h-[600px] max-h-[600px]`
- **问题**: 在小于 700px 高度的窗口中会溢出。

#### 1.13 文件面板编辑器 Tab 宽度约束

- **位置**: EditorTabs 组件
- Tab: `min-w-[120px] max-w-[180px]`
- **问题**: 当打开多个文件时，120px 最小宽度可能导致 tab 栏横向溢出，而 180px 最大宽度在宽屏上浪费空间。

---

## 二、设计规范建议（Design Token 统一方案）

### 2.1 圆角半径规范

建议统一为 Apple 风格的 4 级圆角体系:

```
--radius-xs:  4px   (0.25rem)  — 内嵌元素: menu-item, badge, kbd, checkbox
--radius-sm:  8px   (0.5rem)   — 交互元素: button, input, select, popover, menu-popup, tab, tooltip
--radius-md:  12px  (0.75rem)  — 容器元素: card, alert, toolbar, code-block, frame-panel
--radius-lg:  16px  (1rem)     — 顶层容器: dialog, sheet, frame, main-card
--radius-full: 9999px          — 仅用于: avatar, switch, indicator dot, pill badge
```

**与当前的映射关系:**
| 当前值 | 建议改为 | 影响组件 |
|--------|---------|---------|
| `rounded-sm`(4px) 标题栏按钮 | `--radius-sm`(8px) | WindowTitleBar icon buttons |
| `rounded-xl`(12px) Alert | `--radius-md`(12px) | Alert (保持) |
| `rounded-2xl`(16px) Card/Dialog | `--radius-lg`(16px) | Card, Dialog, Sheet (保持) |
| `rounded-lg`(8px) Button/Input | `--radius-sm`(8px) | Button, Input, Menu popup (保持) |
| `rounded-[4px]` Checkbox | `--radius-xs`(4px) | Checkbox (统一为 token) |

### 2.2 阴影层级规范

```
--shadow-none:  无阴影               — 内嵌平面元素
--shadow-xs:    0 1px 2px rgba(0,0,0,0.05)  — 按钮、输入框、卡片（紧贴背景）
--shadow-sm:    0 1px 3px rgba(0,0,0,0.1)   — 浮起的工具栏、下拉菜单
--shadow-md:    0 4px 6px rgba(0,0,0,0.1)   — Popover、Tooltip
--shadow-lg:    0 10px 15px rgba(0,0,0,0.1)  — Dialog、Sheet（顶层覆盖）
```

**统一规则**: 容器层级越高，阴影越大。同级元素使用相同阴影。

### 2.3 字号阶梯规范

建议基于 4px 递增的 6 级字号体系（基于 `--font-size-base: 14px`）:

```
--text-2xs:  10px  — 极小标注 (替代 text-[9px], text-[10px])
--text-xs:   12px  — 辅助文字、badge、kbd、timestamp
--text-sm:   14px  — 主要 UI 文字（基准）
--text-md:   16px  — 次要标题、强调文字
--text-lg:   18px  — 组件标题（CardTitle、Section 标题）
--text-xl:   22px  — 页面/对话框标题
```

**关键修改**:
- 消除 `text-sm` / `text-base` 混用 — 统一用 `text-sm`(14px) 作为 body 基准
- `text-[9px]` / `text-[10px]` 统一为 `text-2xs`(10px)
- 标题使用明确的阶梯: `text-lg` → `text-xl`

### 2.4 字重规范

```
--font-normal:    400  — 正文、描述、占位文字
--font-medium:    500  — 按钮、标签、导航项、表头
--font-semibold:  600  — 所有标题（card title, dialog title, section header）
```

**规则**: 所有「标题」角色统一用 `font-semibold`，所有「交互元素文字」用 `font-medium`。

### 2.5 间距阶梯规范

```
--space-0.5:  2px   — 最小间隙（icon 微调）
--space-1:    4px   — 紧凑间距（gap-1, tree node 内部）
--space-1.5:  6px   — 交互元素内部（tab icon-to-text）
--space-2:    8px   — 标准间距（组件间距、padding-x 小）
--space-3:    12px  — 宽松间距（section 间距、padding-x 中）
--space-4:    16px  — 区域间距（card padding、panel padding）
--space-6:    24px  — 大区域分隔
```

### 2.6 过渡动画统一

```
--duration-fast:     100ms  — 色彩变化（hover color, focus ring）
--duration-normal:   150ms  — 交互反馈（按钮按下、tooltip 出现）
--duration-slow:     250ms  — 布局变化（面板展开/折叠、dialog 出入）
--easing-default:    cubic-bezier(0.2, 0, 0, 1)  — Apple 标准缓动
--easing-spring:     cubic-bezier(0.34, 1.56, 0.64, 1)  — 弹性效果（仅 dialog/popup）
```

**当前 150ms 和 200ms 的混用统一为**:
- 色彩类过渡: `--duration-fast`(100ms)
- 变换类过渡: `--duration-normal`(150ms)
- 布局类过渡: `--duration-slow`(250ms)

### 2.7 Focus Ring 统一

```
所有可交互元素: focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1
```

消除 `ring-[3px]` 的使用，统一为 `ring-2`(2px)。

---

## 三、优化方案（按优先级排列）

### Phase 1 — 功能性修复（P0, 影响可用性）

#### 方案 1.1: 修复 Tab 按钮文字竖排

**涉及文件**: `src/renderer/components/layout/MainContent.tsx`

**修改方式**:
```
1. Tab 按钮 <span> 添加 `whitespace-nowrap`
2. Tab 容器添加 `overflow-hidden`
3. 增加响应式策略:
   - 当容器宽度 < 600px 时: 隐藏 tab 文字，仅显示图标 + tooltip
   - 实现: 用 `useCompactLayout` hook 检测 header 宽度，
     条件渲染 <span> 或使用 `hidden` class
```

**预期效果**: 任何窗口尺寸下 tab 按钮都保持水平可读。

#### 方案 1.2: 优化用户余额 Pill 比例

**涉及文件**: `src/renderer/components/layout/WindowTitleBar.tsx`

**修改方式**:
```
1. Pill: h-7 → h-6 (24px), 减少 Avatar 到 size-5 (20px), 
   分隔线 h-4 → h-3, 使 pill 在 h-8 标题栏中有更多呼吸空间
2. 或者: 标题栏 h-8 → h-9 (36px)，给 pill 更多垂直空间
   (推荐方案 1，因为更紧凑的 pill 更符合 macOS 风格)
3. 费用文字: 确保 `tabular-nums` + `shrink-0`，防止宽度跳动
```

**预期效果**: Pill 与标题栏的垂直留白比例约 4px:24px:4px，视觉上更透气。

#### 方案 1.3: 移除 MainContent 硬编码最小宽度

**涉及文件**: `src/renderer/components/layout/MainContent.tsx`

**修改方式**:
```
1. `min-w-[535px]` → `min-w-0` (允许 flex 自然收缩)
2. 内容区根据 `isCompact` 状态自适应:
   - 紧凑模式: 侧边栏 overlay + 全宽 MainContent
   - 正常模式: 保留面板并排布局
3. 内部组件（Monaco editor 等）添加各自的最小宽度约束
```

**预期效果**: 窗口可以缩小到更小尺寸而不出现溢出。

---

### Phase 2 — 视觉一致性（P1）

#### 方案 2.1: 统一圆角半径

**涉及文件**: 
- `src/renderer/styles/globals.css` — 定义 4 级 radius token
- `src/renderer/components/ui/button.tsx` — 保持 `rounded-lg`
- `src/renderer/components/layout/WindowTitleBar.tsx:88` — `rounded-sm` → `rounded-lg`
- `src/renderer/components/ui/alert.tsx` — `rounded-xl` → `rounded-xl`(保持，归入 md 级)
- `src/renderer/components/ui/checkbox.tsx` — `rounded-[4px]` → `rounded-xs` (定义 token)

**修改方式**:
```css
/* globals.css 新增 */
@theme {
  --radius-xs: 0.25rem;
  --radius-sm: var(--radius);  /* 现有 0.5rem */
  --radius-md: 0.75rem;
  --radius-lg: 1rem;
}
```

**预期效果**: 整个应用的圆角遵循一致的 4 级层次。

#### 方案 2.2: 统一阴影层级

**涉及文件**: 各 UI 组件

**修改方式**: 审查并替换不符合层级规范的阴影值。核心修改:
- Tooltip: `shadow-md` → `shadow-sm`（与 Popover 区分为更轻量级）
- Menu popup: `shadow-lg` 保持（浮动层级）
- Toast: `shadow-lg` 保持

#### 方案 2.3: 统一过渡动画

**涉及文件**: 各 UI 组件

**修改方式**: 
```
1. 在 globals.css 定义 3 级 duration token
2. 逐组件替换:
   - `duration-150` → 保持 (= --duration-normal)
   - `duration-200` → `duration-150` 或 `duration-[250ms]`
   - `duration-500` → `duration-[250ms]` (进度条除外)
3. 统一 easing: 消除零散的 `ease-out`, `ease-in-out`，
   统一用 `ease-out` 或 Apple 标准 cubic-bezier
```

#### 方案 2.4: 统一 Focus Ring

**涉及文件**: `src/renderer/components/ui/combobox.tsx`, `input.tsx`, `number-field.tsx`

**修改方式**: `ring-[3px]` → `ring-2`

---

### Phase 3 — 排版体系（P2）

#### 方案 3.1: 消除 text-sm / text-base 混淆

**涉及文件**: `src/renderer/components/ui/button.tsx`, `label.tsx`, `group.tsx` 等使用 `text-base` 的组件

**修改方式**:
```
1. 方案 A（推荐）: 将所有 UI 文字统一为 `text-sm`(14px),
   仅在需要更大字号时用 `text-base`(16px)
   - Button: `text-base sm:text-sm` → `text-sm`
   - Label: `text-base/4.5 sm:text-sm/4` → `text-sm`
   
2. 方案 B: 调整 --font-size-base 为 16px，让 text-base 回归标准，
   但这会影响全局字号，风险较大
```

#### 方案 3.2: 消除硬编码任意字号

**涉及文件**: `src/renderer/components/layout/TreeSidebar.tsx`

**修改方式**:
```
text-[9px]  → text-[10px] (统一为 10px)
text-[10px] → 保持 (最终统一到 text-2xs token)

后续在 @theme 中定义:
--text-2xs: 0.625rem; (10px)
```

#### 方案 3.3: 统一标题字重

**涉及文件**: `dialog.tsx`, `alert-dialog.tsx`, `sheet.tsx`

**修改方式**: 所有标题角色添加 `font-semibold`

---

### Phase 4 — 响应式策略增强（P1-P2）

#### 方案 4.1: Tab 栏自适应策略

**涉及文件**: `src/renderer/components/layout/MainContent.tsx`

**策略**:
```
宽度阈值        行为
≥ 800px         图标 + 文字标签
600-800px       仅图标 + Tooltip
< 600px         不应到达（compact mode 已激活）
```

**实现**: 
```tsx
// MainContent.tsx header 区域
const showTabLabels = headerWidth >= 800;

<tab.icon className="relative z-10 h-4 w-4" />
{showTabLabels && <span className="relative z-10">{tab.label}</span>}
```

#### 方案 4.2: 设置对话框高度自适应

**涉及文件**: `src/renderer/components/settings/SettingsDialog.tsx`

**修改方式**:
```
min-h-[600px] max-h-[600px]
→ 
min-h-[400px] max-h-[min(600px,80vh)]
```

#### 方案 4.3: 面板尺寸约束优化

**涉及文件**: `src/renderer/App/constants.ts`, `src/renderer/App.tsx`

**修改方式**:
```
当前固定约束:
- Repo sidebar: 200-400px (default 240px) — 合理
- Worktree panel: 200-400px (default 280px) — 合理  
- File sidebar: 180-500px (default 256px) — max 偏大

建议:
- File sidebar: 180-400px (default 240px)
- 增加: 当窗口 < 1200px 时 default 降为 200px
```

---

## 四、实施路线图

```
Phase 1 (P0 功能修复)     — 预计改动 3 个文件，约 20 行代码
  ├── 1.1 Tab 文字防竖排
  ├── 1.2 Pill 比例调整
  └── 1.3 移除硬编码 min-width

Phase 2 (P1 视觉统一)     — 预计改动 ~15 个文件
  ├── 2.1 圆角 token 定义 + 替换
  ├── 2.2 阴影层级规范化
  ├── 2.3 动画时长统一
  └── 2.4 Focus ring 统一

Phase 3 (P2 排版体系)     — 预计改动 ~10 个文件
  ├── 3.1 text-sm/text-base 统一
  ├── 3.2 消除硬编码字号
  └── 3.3 标题字重统一

Phase 4 (响应式增强)       — 预计改动 ~5 个文件
  ├── 4.1 Tab 栏自适应
  ├── 4.2 Settings 高度自适应
  └── 4.3 面板约束优化
```

**建议执行顺序**: Phase 1 → Phase 2 → Phase 3 → Phase 4

Phase 1 可独立发 PR，不影响其他功能开发。Phase 2-4 建议在当前功能开发完成后集中处理，因涉及多文件变更。

---

## 五、风险评估

| 风险项 | 等级 | 说明 |
|--------|------|------|
| Phase 1 影响范围小 | 低 | 仅添加防御性样式，不改变布局逻辑 |
| Phase 2 圆角统一可能影响截图对比测试 | 中 | 建议变更后做全面视觉回归 |
| Phase 3 text-base→text-sm 可能造成微妙字号变化 | 中 | 需逐组件验证，特别是 Button 和 Label |
| Phase 4 响应式改动需在多种窗口尺寸下测试 | 中 | 建议设定标准测试尺寸: 800×600, 1024×768, 1440×900, 1920×1080 |
