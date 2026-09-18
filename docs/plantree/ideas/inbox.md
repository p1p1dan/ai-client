# 想法收件箱

未承诺的想法。提升进看板时在此标注 `→ 已提升`。


- 2026-09-15 · DSH 生态插件复用：用户选 Cordis 的初衷是复用 DSH 现成插件；但 DSH 插件写的是 DSH 自己的服务接缝（`ctx.llm` / `ctx.agentLoop` / Typert / `dsh.client` 界面挂载），同内核不等于可直接用。要复用需先对齐接缝或写适配层；免代码插件扩展（自有插件目录加载 / pi 插件兼容层）一并推后，版本发布后再议（决策 012）。
- 2026-09-18 · **已评估，不采用**：GitHub `duoduoler-ops/Table-skills/project-handoff` 技能。脚本是 Windows 专有（`import msvcrt`），依赖宿主生命周期 hook 与 Codex 专有线程工具，且与本仓已有的 plan-tree 状态载体冲突；用户决定不采用。
- 2026-09-18 · **已评估，不采用**：生命周期 hooks（Claude Code / Codex 那种「配一条命令挂到某个事件上」的能力）。本仓 runtime 目前无此能力；同类形态里 DSH 有代码级事件拦截，pi-desktop 与 pi 本体只有扩展/订阅形态。用户表示只是想了解现状，不立项。
