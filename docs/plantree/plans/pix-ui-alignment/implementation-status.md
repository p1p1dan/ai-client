# Implementation Status — pix/pi-app UI 对齐改造

**Current Phase**：批次 5 / U08-2 **已落地**（思考档补齐 Pi 七档），下一步批次 5.5。

**Next Target**：批次 5.5 —— U13（免绑定会话跨重启可见性，[D04](./decisions/004-unbound-session-index-visibility.md) 已定边界），
随后批次 6（U06-a+U07）/ 批次 7（U04）。逐片范围与验收见 [execution-plan](./topics/execution-plan.md)。

**Last Landed**：2026-09-04 U12 rev.2 —— 用户报「hands-off / full access 都还在弹权限」，
裁决日志证明档位本身没坏：撞的是 `external_directory`（工作区外写入）这道门，
而上游 envelope 把我们链在该面上的 `allow` 一律降级为 `defer`，连 full access 也免不掉。
按拍板**只为 full access** 解除该降级（分发者补丁只豁免 `aiclient-session-tier` 一个名字，deny 规则不受影响），
并把 hands-off / full access 的档位文案改成点明工作区边界。同批下线顶栏终端按钮与 ``Ctrl/Cmd+` ``。
证据见 [U12 rev.2 evidence](./evidence/2026-09-04-u12-rev2-cross-directory-and-terminal-rail.md)。

**Last Verified**：2026-09-04 —— 全仓 **262 files / 4086 tests pass**；`pnpm typecheck` pass；
`pnpm typecheck:agent-host` pass；biome 920 文件干净；`git diff --check` 干净。
真回合验证（`spikes/u12-tier-turn-probe.ts`，真模型，写工作区外文件）：
`fullopen` 0 次对话框且由 `aiclient-session-tier` 裁决，`handsoff` 仍弹 1 次跨目录确认。

## Active TODO

1. **U13** — 索引行 `unbound` 标记 + 侧栏临时分组，边界见 [D04](./decisions/004-unbound-session-index-visibility.md)。
2. **U09 + U12 + U02/U03-a + U05/U03-b + U08-2 GUI 点验** — 合并一次 CDP 出图肉眼确认（非取证型验收，不阻塞）。
3. **U08-2 真账号回合未验** — `off` 走到真实供应商的实际效果未跑；类型链已逐段核实，但不等于每家服务端都认。
4. **`user_configured` 路线下权限档完全失效** — 用户自己的 `~/.pi` 装了同一个权限插件时，
   我们随包 `config.json` 的 `authorizerChain` 整份不参与，四档一律等同「务实」。红线是不写用户的 `~/.pi`，
   修法未拍板（Host 侧自动应答 / 始终注入随包副本 / 明示降级三选一）。
   详见 [U12 rev.2 evidence](./evidence/2026-09-04-u12-rev2-cross-directory-and-terminal-rail.md) 第五节。
5. **发布前需 `pnpm build:agent-host`** — `out-agent-host/` 里的插件副本与 `config.json` 停留在 09-02，
   连 `authorizerChain` 都没有；dev 不受影响，打包必须重建。
6. **TUI↔GUI 历史分叉 —— 已落地，待真机回合验证** — 代码已按 pix `leaveTerminalMode()` 修完
   （新增 `worker.reload` 重载原语 + `chat:reloadSession`；离开终端 suspend → 重载 → 揭开；回合进行中拒绝进 TUI）。
   自动化全绿并做过三条变异验证，但**用户原始复现路径尚未用真实 pi CLI 跑过**——这是唯一剩下的欠项。
   老会话不补救（内容在旁支，用会话树自取）。落地记录与验收路径见
   [该缺陷记录](./evidence/2026-09-04-host-status-false-stop-and-tui-history-bug.md) 第三、四节。

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
