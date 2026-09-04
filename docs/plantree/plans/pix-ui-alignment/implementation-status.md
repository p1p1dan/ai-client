# Implementation Status — pix/pi-app UI 对齐改造

**Current Phase**：批次 5 / U08-2 **已落地**（思考档补齐 Pi 七档），下一步批次 5.5。

**Next Target**：批次 5.5 —— U13（免绑定会话跨重启可见性，[D04](./decisions/004-unbound-session-index-visibility.md) 已定边界），
随后批次 6（U06-a+U07）/ 批次 7（U04）。逐片范围与验收见 [execution-plan](./topics/execution-plan.md)。

**Last Landed**：2026-09-03 U08-2 —— 思考档词汇从 Claude 五档补齐为 Pi 七档（加 `off` / `minimal`）。
`CHAT_EFFORTS` 改由 `SESSION_EFFORT_LEVELS` 派生；边界上另发现并统一了三份五词独立拷贝，
其中 `workerRpc.ts` 的 `isWorkerEffort` 是发布级（带 `off` 的会话本会起不来）。
证据见 [U08-2 evidence](./evidence/2026-09-03-u08-2-thinking-levels.md)。

**Last Verified**：2026-09-03 —— 全仓 **261 files / 4066 tests pass**；`pnpm typecheck` pass；
`pnpm typecheck:agent-host` pass；biome 11 文件干净；`git diff --check` clean。
变异验证：把 `isWorkerEffort` 改回五词手抄，`workerRpc.test.ts` 立即失败。

## Active TODO

1. **U13** — 索引行 `unbound` 标记 + 侧栏临时分组，边界见 [D04](./decisions/004-unbound-session-index-visibility.md)。
2. **U09 + U12 + U02/U03-a + U05/U03-b + U08-2 GUI 点验** — 合并一次 CDP 出图肉眼确认（非取证型验收，不阻塞）。
3. **U08-2 真账号回合未验** — `off` 走到真实供应商的实际效果未跑；类型链已逐段核实，但不等于每家服务端都认。

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
