# T-32 右栏骨架回归 A08 —— 实现规格

> 2026-08-05。任务定义权威 = [执行计划](2026-07-23-openchamber-chat-refactor-execution-plan.md) §3 T-32 行；
> 决策权威 = 总台账 **D27** + open-q **#28**（当日裁定关闭）。本文只定实现拆分与接缝，不改任务口径。
> 视觉基线 = [`a08-final-context-panel-baseline.html`](../design/a08-final-context-panel-baseline.html)（D27 后地位回升）。

## 0. 地基事实（已核实 file:line）

- **F-a** `WorkspaceShell.tsx:116-127`：`contentRowRef` 只量 Main + ContextPanel（**不含 Sidebar / Rail**），是 `availableWidth` 的分母。顶栏 `MainHeader` 现在**在中列内部**（`:118`），贯通要把它提到 contentRow 之上。
- **F-b** `ContextPanel.tsx:151-178`：面板头现为「surface 图标 + 名称 + Maximize2 + ✕」。tab 条要替换的正是这一段；`expanded` 覆盖态（`:120`）**是现有能力、不在 §7 被取代清单内，保留**。
- **F-c** `WorkspaceShell.tsx:129`：`<ContextPanelRail />` 无条件渲染。「仅收起时渲染」= 加可见性门，**不是删组件**。
- **F-d** `EditorSurfaceView.tsx`（487 行）当前一体承载「文件树 + EditorArea + 面板内分栏」。搬家 = 拆两半，不是整体平移。
- **F-e** `shellLayoutModel.ts` 已有 `RAIL_WIDTH=44 / SIDEBAR_*/ CONTEXT_PANEL_MIN=380 / MAX=1400`，**降级梯与 chat/editor 最小宽是新增常量**，不改既有值。
- **F-f** `shellShortcuts.ts:86-88`：`` Ctrl/Cmd+` `` 已是 `open-terminal`（**非 dock 语义**）——#28 ② 裁定的正是现状，**本任务零改动**。
- **F-g** `shellShortcuts.ts:42-46`：`Ctrl/Cmd+1..4` 由 `railSurfaces(DEFAULT_SURFACE_ORDER).slice(0,4)` 派生，**改 registry 顺序会自动改快捷键映射**——须进点验清单。
- **F-h** `shellLayout.ts:92-101` persist `partialize` 八字段、`version: 1`。新增持久字段须同步 `PersistedShellLayout` / `defaultShellLayout` / `sanitizeShellLayoutPersisted` / `partialize` **四处**，否则静默丢失。

## 1. 施工切片（每片三绿后提交，逐门串行）

| 片 | 提交 | 内容 |
|---|---|---|
| S1 | `refactor(shell): 顶栏贯通中右 + Rail 联动收展（T-32）` | §2 |
| S2 | `feat(shell): 右栏 tab 条四项替换面板头（T-32）` | §3 |
| S3 | `feat(editor): editor 回中列，files tab 降为纯文件树（T-32）` | §4（最大片） |
| S4 | `feat(shell): L0/L1/L2 画幅降级梯与手动覆盖（T-32）` | §5，依赖 S3 的 `editorOpen` |
| S5 | `docs: T-32 A08 对照回标 + design-system 同步` | §7 |

## 2. S1 顶栏贯通 + Rail 联动收展

- **结构改造**（`WorkspaceShell.tsx`）：`MainHeader` 由中列内部提到 contentRow **之上**，横跨 chat + editor + panel + rail：
  ```
  <shell>
    <LeftNav/>
    <div flex-col flex-1>
      <MainHeader/>            ← 贯通中右（新位置）
      <div ref={contentRowRef}> ← chat | editor | panel | rail
    </div>
  </shell>
  ```
- **与 T-23 的口径冲突（D27 已预告，此处收口）**：T-23 刚落的「顶栏 h-9 与左右两列顶条三条分隔线齐平」在贯通后**不再成立**——贯通顶栏之下只剩一条内容行。裁定：**保 h-9 高度与 T-23 的全部内容**（标题 15px semibold · 工作区 chip · 阅读栏钮 · 面板钮），只改它横跨的范围。T-23 点验清单 **0-quattuordecies ③ 的「三条顶条齐平」追认项作废**，并入 T-32 点验。
- **Rail 可见性**：`railVisible = !panelVisible`（S4 前 `panelVisible === (activeSurfaceId !== null)`）。展开时右缘无图标，44px 让给内容。
- **测量语义**：`contentRowRef` 现在含 editor 列与 rail。`availableWidth` 的既有消费者（`resolveContextPanelWidth`）语义不变（仍是「panel 能占多宽的上界」），但**分母变大**——`clampContextPanelWidth` 的 `availableWidth` 上限因此更宽松，属预期。
- 断言面：`shellLayoutModel` 加 `deriveRailVisible({ panelVisible })`（纯，一行但要钉死「展开无 Rail」这条 A08 定稿语义，防后续误改）。

## 3. S2 右栏 tab 条

- **替换** `ContextPanel.tsx:151-178` 的面板头为 A08 tab 条：h-9 · **四个文本分段 tab 全宽均分** · 右侧动作区（`Maximize2/Minimize2` + ✕）。
- **tab 项与顺序**（A08 `git | files | context` + terminal 追加）：
  `git` · `editor`（**语义改为 Files = 文件树**）· `context` · `terminal`
- **surfaceRegistry 改动**：
  - `DEFAULT_SURFACE_ORDER` 由 `context, git, editor, terminal` 改为 **`git, editor, context, terminal`**（A08 tab 序）。
  - `editor` descriptor：`labelKey` `Editor` → **`Files`**，`descriptionKey` 改为文件树语义，icon 保持 `file-code`。
  - **id 保留 `editor` 不改名为 `files`**：该 id 已持久化在 `aiclient-shell-layout` 的 `widthBySurface` / `lastSurfaceId` / `railOrder` 里，改名需要 store 迁移（version bump）换取纯粹的命名收益，不划算。**在 registry 就地注释钉死这条理由**，避免后人「顺手改对」。
  - ⚠️ **连带 F-g**：`Ctrl/Cmd+1..4` 映射随之变为 1=git 2=files 3=context 4=terminal，**进点验清单**。
- **git-only dot** 同时出现在 tab 与 Rail 图标上（A08 定稿；`shouldShowActivityDot` 已是唯一真相，两处共用）。
- 断言面：`surfaceRegistry.test.ts` 的 WIRED 白名单与顺序断言随之更新；新增 `panelTabsModel.ts` 纯函数 `derivePanelTabs(railOrder) → {id, labelKey, showDot}[]` 供 tab 条与 Rail 共用，防两处漂移。

## 4. S3 editor 回中列（最大片）

**拆分**（F-d）：

| 新文件 | 承接 | 去处 |
|---|---|---|
| `surfaces/FilesSurfaceView.tsx` | `FileTree` + `useFileTree` + per-Workspace `switchWorktree` | 右栏 `editor`(Files) tab |
| `center/EditorColumn.tsx` | `EditorArea`（含原生 `EditorTabs`）+ `fileOpenIntent` 消费 + `resolveIntentPath` / `fileIntentToCursor` | **中列，与 chat 并排** |

- **`resolveEditorSurfaceLayout` 退役**（面板内 tree/editor 分栏不复存在），`editorSurfaceLayout.ts` 及其测试一并删除；`EDITOR_SPLIT_MIN=704` 常量随之作废。
- **editor head**（A08 `a08:1220-1228`）：文件图标 + 文件名 + 未保存点 + **「隐去 chat」钮**（editor 最大化 = 置 `manualChat=false`）+ **关闭文件钮**。`EditorTabs` 提供的多 tab 条**保留在 head 之下**。
- **一处刻意不照搬 A08（编排者裁定，非用户拍板，已入 D27）**：**editor 保留多 tab**。A08 画的是单文件（`ed-fname` 单名），但隐藏 tab = 隐藏脏文件、用户会丢改动，违 A06 精神；T-12~T-15 规格 §7 当时即按此裁定，本轮沿用。
- **点文件行为**（A08「不再开 panel 内 tab」）：Files tab 点文件 → `requestFileOpen` → 中列 editor 打开。git surface 的文件行仍走 list⇄diff（「git 行→editor」仍登记后置，不在本任务）。
- **比例拖拽**：chat ║ editor 间 `ed-grip`（复用 `ShellResizeHandle`），写入新持久字段 `editorRatio`（clamp 0.25~0.75，默认 0.5）。
- **关文件语义**（A08 状态机）：最后一个 tab 关闭 → `editorOpen=false` → editor 撤列、chat 回、panel 恢复 `panelOpen` 偏好、**手动覆盖清零**。
- 断言面：`centerLayoutModel.ts` 纯函数 `resolveEditorRatio` / `deriveEditorOpen(openTabs)`；`resolveIntentPath` / `fileIntentToCursor` 既有测试**只搬不改**（守住 R4）。

## 5. S4 降级梯与手动覆盖

新纯模块 `centerLayoutModel.ts`：

```ts
export const CHAT_MIN_WIDTH = 400;
export const EDITOR_MIN_WIDTH = 520;
export const LEVEL_L0_MIN = CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH + CONTEXT_PANEL_MIN_WIDTH; // 1300
export const LEVEL_L1_MIN = CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH + RAIL_WIDTH;              //  964
export type ShellLevel = 'L0' | 'L1' | 'L2';
```

- **阈值口径偏离 A08，有据**：A08 写 **1580 / 1244**，是**含 280px 侧栏的整窗阈值**（1580 = 280+400+520+380）。
  本仓侧栏**可拖 280–500 且可收起到 48**，整窗阈值会在侧栏拖宽时误判。
  故改用**不含侧栏的内容行阈值 1300 / 964**（= A08 阈值减去它假设的 280），侧栏为 280 时**与 A08 完全等价**，
  拖宽/收起时行为更正确。**登记为适配性偏离，不是推翻 A08。**
- **降级梯只在 editor 打开时生效**（A08 状态机表的前置条件 `editor open`）：没开文件时 chat 独占中列，不需要 520px 预留，行为与今天一致。
- 合成纯函数：
  ```ts
  resolveShellLevel({ contentWidth, editorOpen }): ShellLevel   // !editorOpen → 恒 'L0'
  derivePanelVisible({ level, editorOpen, panelOpen, manualPanel }): boolean
  deriveChatVisible({ level, editorOpen, manualChat }): boolean
  ```
  规则：`manualPanel`/`manualChat` 为 `boolean | null`（**null = 无覆盖**，比 A08 的 bool 多一态，才能表达「关文件清零」）；有覆盖时覆盖赢，否则 L0 全在 / L1 收 panel / L2 隐 chat。
- **store 新字段**（务必同步 F-h 的四处）：持久 `panelOpen: boolean`、`editorRatio: number`；**会话内不持久** `manualPanel`/`manualChat`（A08 §06-4 定稿：关文件清零）。
- **`activeSurfaceId` 语义收窄**：它今后只表示「panel 可见时显示哪个 tab」，**不再等于「panel 是否可见」**——可见性由 `derivePanelVisible` 合成。所有现读 `activeSurfaceId !== null` 判可见的地方（`WorkspaceShell.tsx:119`、`ContextPanel.tsx:56`、Rail）必须一并改，**漏改即行为分叉**。
- 断言面：三个 derive 函数 × (L0/L1/L2 × editorOpen × 覆盖三态) 全组合；「关文件清零覆盖」单独一例。

## 6. 风险

- **R1 `activeSurfaceId` 语义收窄漏改**（S4）——最可能出错处，见 §5 末。用静态扫描钉死：除 `centerLayoutModel` 外禁止再出现 `activeSurfaceId !== null` 作为可见性判据。
- **R2 keep-alive 契约回归**（S3/S4）——terminal 的 pty 必须活过 tab 切换与降级梯的自动收起。`deriveMountedSurfaceIds` 吃的是 `activeSurfaceId`，而降级梯收起 panel 时 `activeSurfaceId` **不应被清空**（否则 pty 死）；这是 §5 语义收窄的直接收益，但要显式验收（`sleep 30` 场景）。
- **R3 顶栏贯通与 T-23 冲突**（S1）——见 §2，已裁定。
- **R4 意图定位回归**（S3）——`resolveIntentPath` / `fileIntentToCursor` 测试只搬不改。
- **R5 persist 四处漏同步**（S4）——F-h。
- **R6 Ctrl+1..4 映射静默改变**（S2）——F-g，进点验。

## 7. S5 收尾

- A08 对照表回标：[T-12~T-15 规格 §7](2026-08-04-t12-15-surface-spec.md) 的「被取代」十一项逐条改判（回归 / 维持豁免），**原文不改写，追加 T-32 回标段**。
- `docs/design-system.md`「新壳布局档位」同步新常量与降级梯。
- 点验清单落 implementation-status 用户线（**0-quindecies**）。

## 8. 门禁

逐门串行（内存纪律），实现代理不与门禁并行。Linux 三绿口径 = typecheck 干净 / lint 0 错误 / vitest 仅 3 例 Windows-only 失败且总例数只增。
基线 = **119 文件 2182 例 @`9703e32`**。
