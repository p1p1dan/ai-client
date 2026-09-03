# Evidence — U02 双栏/三栏布局模式 + U03-a TUI 收右栏（批次 3）

**日期**：2026-09-03
**分支**：`feat/pi-primary-backend`
**切片**：U02-a（模式字段与持久化）、U02-b（模式开关与双栏收敛）、U03-a（TUI 收右栏）
**执行计划**：[execution-plan §三 批次 3](../topics/execution-plan.md)

## 一、做了什么

三态呈现模型落地：`three-column`（默认，rail 全四项）/ `two-column`（rail 仅 `context`）/ 既有 `tui`（左栏 + 整块终端）。
`presentationMode`（gui/tui）保持在 settings store 不动，避免触碰 D19 的 TUI 单写者交接链路。

### U02-a — 模式字段与持久化

- `PersistedShellLayout` 新增 `shellColumnMode`，默认 `three-column`；`defaultShellLayout`、`sanitizeShellLayoutPersisted`、store `partialize` 同步。
- 旧持久化缺字段、非法值都回落 `three-column`（sanitize 保证）；**不 bump store version**——`merge` 已用 `sanitizeShellLayoutPersisted` 补默认，加字段向后兼容。

### U02-b — 模式开关与双栏收敛

- 收敛判定 `isSurfaceAvailableInColumnMode(id, columnMode)` 下沉到 `surfaceRegistry.ts`（最底层，避免与 `shellLayoutModel` 循环 import）。
- `RailSurfacesOptions` 加 `columnMode`；`isRailSelectableSurface`/`railSurfaces`/`firstAlwaysSurfaceId` 一处过滤即贯穿 **rail 显示**（`derivePanelTabs`）与 **快捷键**（`numberedSurfaceIds`）。
- `reduceShellSurface` 加 `columnMode` 兜底 guard（默认 `three-column`，现有调用不变）：双栏下 `select`/`open` 非 context 一律 no-op，`toggle-panel`/bare open 落到 `context`。这一层保证**任何入口**（rail 点击、快捷键、以及任何走 store 的 `selectSurface`/`openSurface`）都无法打开被排除 surface。本仓无独立命令面板，`ToolRows`/`ChatComposer` 对 `openSurface` 的命中均为历史注释（已核）。
- 切模式收敛纯函数 `reduceColumnModeChange`：切 two-column 时把非 context 的活动面换成 `context`，并把原 surface 记进 `lastSurfaceId`（往返回三栏可恢复）；切 three-column、面板关闭、已是 context 时均 no-op——**从不触碰 `railOrder`**，模式切换不可能损坏它。
- store 新增 `setShellColumnMode`/`toggleShellColumnMode`；`MainHeader` 加一枚 `Columns2` 切换按钮（`aria-pressed` 表状态，与 reading-width/panel 切换同组）。

### U03-a — TUI 收右栏

- `WorkspaceShell` 读 `presentationMode`；`isTui` 时：右栏 `ContextPanel` 不渲染（`panelVisible=false`）、editor 列不占位（含 pending intent 的隐藏列）、chat 列（承载终端）占满 center。
- **未改** `ChatWorkspace` 的 `openTui`/`openGui`/`piTui.dispose` 交接逻辑，D19 单写者行为不变。退出 TUI 回 gui 后，`shellColumnMode` 与 surface 持久值未被 TUI 改写，自动恢复进入前状态。

## 二、命名偏差说明（重要）

execution-plan 原文写字段名 `layoutMode`，值 `'three-column' | 'two-column'`。落地时改用 **`shellColumnMode`**，原因：`settings` store 已有 `layoutMode: LayoutMode`（`'columns' | 'tree'`，最外层仓库/工作树布局），同名不同义会误导。值沿用 execution-plan 的 `'two-column' | 'three-column'`。已在 execution-plan §三 就地标注。

## 三、验收对照

| 切片 | 验收 | 结果 |
|---|---|---|
| U02-a | 新旧两种持久化各一条测试；默认值不改变现有布局 | ✅ `shellLayoutModel.test.ts` 三条（缺字段→three-column、two/three 保留、非法→three-column）+ `defaultShellLayout.shellColumnMode==='three-column'` |
| U02-b ① | 双栏下 rail、快捷键、命令面板均无法打开被排除 surface | ✅ rail（`panelTabsModel.test`）、快捷键（`shellShortcuts.test` Digit2..4→null）、reducer guard（`shellLayoutModel.test`）；无命令面板 |
| U02-b ② | 模式往返一次后 `railOrder` 与 `lastSurfaceId` 无损 | ✅ `reduceColumnModeChange` 从不写 `railOrder`；round-trip 测试断言 `lastSurfaceId` 保留 |
| U02-b ③ | 模式切换有持久化测试 | ✅ 字段经 `partialize` 持久化 + sanitize 往返测试 |
| U03-a ① | TUI 下右栏不渲染 | ✅ `panelVisible = isTui ? false`；静态扫描 `panelVisibilityStatic.test` 更新为新组合 |
| U03-a ② | 退出 TUI 恢复进入前模式与 surface | ✅ TUI 不改写持久 surface/columnMode，回 gui 自动恢复 |
| U03-a ③ | D19 GUI/TUI 单写者守卫不变，既有 TUI 门禁全绿 | ✅ 未改 `ChatWorkspace` 交接逻辑；workspace-shell 全套 363 tests 绿 |

## 四、门禁结果

按 [baseline test-and-release-gates](../../../baseline/test-and-release-gates.md) 串行：

1. **Vitest**（`--maxWorkers=1 --no-file-parallelism`）：`src/renderer/components/workspace-shell/__tests__` **16 files / 363 tests pass**（含 U02-a 加入前的 82→85）。
2. **typecheck**：`NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck` pass（加必填字段 `shellColumnMode` 后全仓无遗漏构造点）。
3. 未触及 agent-host，跳过 `typecheck:agent-host`。
4. **biome**：13 个改动文件 check 干净（`shellLayoutModel.ts` 两处长行经 `--write` 折行）。
5. **`git diff --check`**：clean。

## 五、改动文件

源码：`surfaceRegistry.ts`、`shellLayoutModel.ts`、`stores/shellLayout.ts`、`panelTabsModel.ts`、`shellShortcuts.ts`、`useShellShortcuts.ts`、`MainHeader.tsx`、`WorkspaceShell.tsx`。
测试：`shellLayoutModel.test.ts`、`surfaceRegistry.test.ts`、`panelTabsModel.test.ts`、`shellShortcuts.test.ts`、`panelVisibilityStatic.test.ts`。

## 六、欠项

- **GUI 点验未做**：批次 3 是结构/视觉切片，按 execution-plan §四点验不阻塞后续切片；建议与 U09/U12 的待做点验合并一次 CDP 出图。
- **U03-b（解除 TUI 目录强绑定）不在本片**：属批次 4，依赖 U05 的隔离 cwd。
