# Implementation Status — pix/pi-app UI 对齐改造

**Current Phase**：批次 3 / U02+U03-a —— 双栏/三栏布局模式 + TUI 收右栏 **已落地（GUI 点验待做）**。

**Next Target**：批次 4 —— U05+U03-b（免绑定开聊 + TUI 解除目录强绑定，安全敏感、单独成批），
或可交错的 U08-2（思考档七档）/ U04（左栏插件入口）。逐片范围与验收见 [execution-plan](./topics/execution-plan.md)。

**Last Landed**：2026-09-03 U02+U03-a —— `PersistedShellLayout` 新增 `shellColumnMode`（`three-column`
默认 / `two-column`）；双栏 rail 收敛到 `context`，收敛判定下沉 `surfaceRegistry` 后一处过滤即贯穿
rail 显示 + 快捷键 + reducer guard；`MainHeader` 加模式切换按钮。TUI 在 `WorkspaceShell` 收起右栏与
editor 列、终端独占 center，未动 `ChatWorkspace` 的 D19 单写者交接。
证据见 [U02+U03-a evidence](./evidence/2026-09-03-u02-u03a-column-mode.md)。
（字段名由 execution-plan 原文 `layoutMode` 改为 `shellColumnMode`，避开 settings 既有 `LayoutMode`，见 evidence §二。）

**Last Verified**：2026-09-03 —— workspace-shell `__tests__` **16 files / 363 tests pass**
（新增：reducer 双栏 guard、`reduceColumnModeChange` 往返、`isSurfaceAvailableInColumnMode`、
railSurfaces/derivePanelTabs/numberedSurfaceIds 双栏过滤、sanitize 三档；`panelVisibilityStatic`
按 TUI 新组合更新）；`pnpm typecheck` pass；biome 13 文件干净；`git diff --check` clean。

## Active TODO

1. **U09 + U12 + U02/U03-a GUI 点验** — 顶盖接合、底栏顺序、权限 chip 四档、双栏/三栏切换与 TUI 收栏，合并一次 CDP 出图肉眼确认（非取证型验收，不阻塞）。
2. **U08-2** — 思考档补 `off` / `minimal` 两档（无前置，可与批次 4 交错）。

## Blocked By

- **U06-b** 等 Pi 计划 [T38-a/b](../pi-backend-migration/roadmap.md) 落地。这是当前唯一的外部阻塞。

## Handoff

1. 动手前读 [execution-plan](./topics/execution-plan.md)，它有批次顺序、逐片验收和门禁。
2. 每片按 [baseline gates](../../baseline/test-and-release-gates.md) 串行验证：相关 Vitest（`--maxWorkers=1
   --no-file-parallelism`）→ typecheck → biome → `git diff --check`。不并行、不整套跑。
3. **U01 已确立的两条边界**，后续切片不要推翻：
   - 颜色只能改 OKLCH 的 L 分量，色相与彩度不动（改动前后的对比度必须实测，不能推断）。
   - evidence-u01（数值档）与 evidence-u09（组件形态）冲突时**以 U09 为准**，这是
     [D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定一确立的先例，
     已在侧栏行高与 Composer 内距上各用过一次。
4. 布局尺寸（栏宽类）不在 D01 授权范围内，动之前先过 Q11。
