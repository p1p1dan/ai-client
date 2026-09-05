# D05 — 双栏模式的 rail 从「只有 Context」扩到「Context + Run」

- **日期**：2026-09-04
- **状态**：Superseded（见下方 D07 通知）
- **来源**：[execution-plan §三 批次 6](../topics/execution-plan.md) 里 U06-a 的「双栏下是否可见——**建议可见**……实施时确认」
- **关系**：细化 [D02](./002-layout-cwd-and-evidence-scope.md) 决定一，不推翻它

> **状态：Superseded by [D07](./007-two-column-is-two-columns-and-one-bar-per-column.md)（2026-09-04）**。
> 本决定把双栏的 rail 从「只有 Context」扩到「Context + Run」。D07 取消了双栏的右列本身，
> 所以这两个 surface 一并退出双栏——它们在三栏下完全不变。
> 本决定的推理（Run 描述的是对话而非工作树，与 Context 同侧）仍然成立，只是失去了适用场景。

## 背景

D02 决定一定义双栏模式为「只做 AI 对话与 AI 开发」，rail 收敛到 `context` 一件，
Files / Git / Terminal 刻意不提供。当时 `context` 是唯一一个描述**对话本身**而不是工作树的面板，
所以「只保留 context」和「只保留描述对话的面板」是同一句话。

U06-a 新增 `run` 面板后，这两句话第一次分开了。

## 决定：双栏 rail = `context` + `run`

**采纳**：`isSurfaceAvailableInColumnMode` 在 `two-column` 下放行 `context` 与 `run` 两件。

**理由**：D02 划的那条线是「对话 vs 开发工具」，不是「一件 vs 多件」。
Run 面板报告的是当前回合的运行状态（状态机、模型、思考档、耗时、工具），
它属于「AI 对话」这一侧；把它藏起来会让双栏模式看不见自己正在跑什么，
而这正是双栏模式最需要的信息。被排除的集合**一件没变**：Files / Git / Terminal / editor 仍然不提供。

**未采纳**：*双栏下隐藏 Run*。会造成一个只在三栏可见的运行状态面板——
用户切到双栏是为了专心对话，恰恰是最需要看运行态的时候。

## 后果

- 双栏下的 `Ctrl/Cmd+1` 仍是 context，`Ctrl/Cmd+2` 变成 run（原先 2..4 都不绑定）。
- 三栏下 rail 变成四件 `git | files | context | run`，`Ctrl/Cmd+4` 由 run 接手——
  这个数字位是 2026-09-04 终端下线时空出来的，前三位没有移动。
- `reduceColumnModeChange` 切到双栏时把非可用面换成 `context` 的逻辑不受影响：
  它读的就是这个判定函数，run 现在自然地留在原位而不被换走。
