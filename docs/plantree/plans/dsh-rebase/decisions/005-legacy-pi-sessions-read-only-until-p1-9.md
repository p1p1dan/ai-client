# 决策 005：P1-9 之前，旧 pi 会话在分支构建里只读

日期：2026-09-26。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：[P1-1 方案 §5 D1](../topics/p1-1-engine-cutover.md#5-需要拍板的决策点)、[决策 004](004-branch-isolated-dsh-only.md)。

## 规则

1. 从 P1-1 起，到 P1-9（旧会话迁移）落地为止，分支构建里所有带 `runtimeIdentity` 的 `agent: pi` 会话一律只读。这也包括 CC / Codex 导入产生的会话。
2. 预览照常：主进程只读回放（决策 030 的 `SessionReplayReader`）继续显示历史。
3. 恢复和发送由 Main 明确拒绝，错误码 `legacy_session_readonly`；渲染层显示「迁移前只能查看」卡片。
4. 没有 `runtimeIdentity` 的 pi 空行（从未落盘）直接按 DSH 新会话创建。
5. 不留 native 回退路径。

## 取舍

- 不选「旧行继续走 native」：那等于按会话选引擎，违反决策 004。
- 不选「发送时新开 DSH 会话接着聊」：上下文会断，而怎么接是 P1-9 的产品语义，不该在过渡期先定。
- 不选「提前做临时转换」：那就是 P1-9 本身，不应塞进 P1-1。
- 代价：P1-1～P1-9 之间，旧会话在 GUI 里不能续聊。这只影响分支上的自测，因为分支合入 main 之前 P1-9 必须完成（决策 004 第 3 条）。内嵌终端的 pi TUI 在 P1-11 之前仍能续聊旧会话。

## 影响

- P1-1：Main 的恢复守卫、渲染层恢复意图、错误卡与中英文案。
- P1-9：落地后删掉这条只读限制，改为首次打开时复制转换。

## 补记（2026-09-29，P1-9d，决策 122）

Main 这一侧的只读限制已解除（[决策 122](122-p1-9d-migration-orchestration-choices.md) 第 12、14 条）：

- 恢复带真实文件的 `pi` 行时先迁移再恢复（[决策 050](050-migrate-on-first-continue.md)），失败报 `legacy_migration_failed:<阶段>/<码>`；
- 其他需要引擎的操作与对旧行的新建报 `legacy_migration_required`，由渲染层先恢复；
- Main 不再产出 `legacy_session_readonly`。渲染层的只读卡片与相关文案还在，由 P1-9e 改成「无法迁移」卡片后，本决策整体失效。

## 补记（2026-09-29，P1-9e，决策 123）

渲染层这一侧也已解除：只读卡片、只读占位、`isReadOnlyResumeRefusal` 与相关文案都已删去，改为「迁移中」提示与「无法迁移」卡片（[决策 123](123-p1-9e-migration-renderer-choices.md) 第 1～8 条）。**本决策整体失效。**
