# Implementation Status — pix/pi-app UI 对齐改造

**Current Phase**：批次 2.5 / U12 会话权限档 —— **已落地（GUI 点验待做）**。

**Next Target**：批次 3 —— U02+U03-a（双栏/三栏布局 + TUI 收右栏），或可交错的 U08-2。
逐片范围与验收标准见 [execution-plan](./topics/execution-plan.md)。

**Last Landed**：2026-09-03 U12 —— 会话级权限档 chip（只读/务实/放手/完全放开），
全栈 5 处落点：共享类型 → authorizer 扩展 → Worker RPC → Main IPC → 渲染器鬼影芯片。
delegation envelope 确保 `path`/`external_directory` 不可被自动批准。commit `c17c2e9f`。

**Last Verified**：2026-09-03 —— authorizer verdict 12 tests（含 release-blocker
`path`/`external_directory`）、RPC 正反例 2 tests、bar slot 静态扫描 1 test、
permission trigger 样式一致性 1 test 全部通过；typecheck × 2 + biome + `git diff --check` clean。
266 个相关测试全部通过。

## Active TODO

1. **U09 + U12 GUI 点验** — 顶盖接合、底栏顺序、权限 chip 四档切换三处肉眼确认（非取证型验收，不阻塞）。
2. **U08-2** — 思考档补 `off` / `minimal` 两档（无前置，可与批次 3 交错）。

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
