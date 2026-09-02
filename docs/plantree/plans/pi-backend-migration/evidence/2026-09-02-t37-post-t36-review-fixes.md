# T37 post-T36 review fixes — 2026-09-02

外部审查报告对 T36 收敛后的工作树提出 7 条问题。本文件记录逐条核实结论与最小切片修复，属于
[T37-a](../roadmap.md#t37--pi-only-release-gates--in-progress) 门禁的 regression 回写，不扩大 T36 范围。

## 核实结论

| # | 报告条目 | 核实结果 | 处理 |
|---|---|---|---|
| 1 | `electron-builder.yml` 重复 `filter` 键 | **属实**。`js-yaml` 实际报 `duplicated mapping key (140:5)`，所有 electron-builder 命令被阻断 | 删除孤立块 |
| 2 | 远程 Agent 终端无条件走 piTui | **症状属实，处方不适用**。T36 起 `SessionManager.create` 对 `kind==='agent'` 直接抛错，远程 Pi 运行时/安装链路已在 T36 删除，无法"路由到远程后端" | 改为显式失败：renderer 不启动 + Main 侧拒绝远程虚拟路径 |
| 3 | 队列任务完成检测未按任务重置 | **属实**。`settled` 是 effect 闭包变量，队列推进不重建 effect，第一项之后全部静默 | 抽出 per-session tracker 并加回归测试 |
| 4 | 登出未销毁 Pi TUI 进程 | **属实**。agent PTY 在 T36 迁出 `SessionManager`，`terminateAllSessions()` 已经够不着 | 登出序列新增 ②b |
| 5 | 登出未失效 Utility Worker | **属实**。`piUtilityService` 仅在 app 退出时销毁 | 新增 `invalidateAll()` 并接入登出 ③ |
| 6 | 挂起会话回放先于 terminal id 绑定 | **属实**。`#openExclusive` 在 IPC promise 之前同步派发 replay | `open` 之前先绑定 `ptyIdRef` |
| 7 | 升级首启仍加载旧版终端会话 | **属实**。`saveToStorage` 故意写空，`loadFromStorage` 却照常读回旧 Claude/Codex/自定义 tab | 加载即清 key |

## 落地改动

- `electron-builder.yml`：删除 `isbinaryfile` 条目上多出的一份 `filter`。
- `AgentTerminal.tsx` / `piTui.ts`：远程虚拟 cwd 下终端保持休眠并给出说明文案；Main 侧 `PI_TUI_OPEN`
  对远程路径抛出可读错误，替代 node-pty 的不透明 spawn 失败。新增两条 zh 文案。
- `autoExecuteMarker.ts` / `useAutoExecuteTask.ts`：新增 `createAutoExecuteCompletionTracker()`，
  按任务 session 维护输出缓冲与 settled 标志；hook 只保留"是否当前任务"的过滤。
- `onboarding.ts`：登出序列插入 ②b `disposeAllPiTuiControllers()`（与 ② 一样不受 flag 影响），
  ③ 追加 `piUtilityService.invalidateAll()`；两者都严格早于 ④ vault clear。
- `PiUtilityService.ts`：新增 `invalidateAll()`，取消在途操作并释放 worker，但**不**置 `disposed`，
  与 `WorkerManager.invalidateAll()` 语义对齐——下次登录后同一进程继续可用。
- `useXterm.ts`：`piTui.open` 之前绑定 `ptyIdRef`；导出的 `write` 对启动竞态改为 warn 而非未捕获 rejection。
- `agentSessions.ts`：`loadFromStorage()` 变为迁移动作——直接删除 `aiclient-agent-sessions` 并返回空。

## 验证

- `pnpm typecheck` — pass。
- 新增/更新测试：`onboardingLogoutSequence.test.ts` 2 条（②b 顺序、③ utility 失效顺序）、
  `PiUtilityService.test.ts` 1 条（invalidateAll 取消在途且服务仍可用）、
  `useAutoExecuteTask.test.ts` 3 条（多任务各自结算、单任务只结算一次、缓冲不跨任务泄漏）。
- 全量 `vitest run` — 254 files / 3884 tests，20 failed。**同样 20 条在 clean tree 上同样失败**
  （`git stash` 复跑确认），与本批改动无关：`sessionIndexMerge`(12)、`sessionRuntimeFacts`(2)、
  `SessionManager`、`extensionUiSurfacesStatic`、`t25ModelPickerStatic`、`sidebarRowRemoval`、
  `chatSessionsSendGuard`、`piModelWiring` 各 1。这批 pre-existing 失败仍待 T37-a 处理。
- Scoped Biome（12 个改动文件）— pass；`git diff --check` — pass。
- `electron-builder.yml` 用 `js-yaml` 复解析 — pass，`extraResources` 11 条，`isbinaryfile` 只剩一份 filter。
- 未做：packaged Electron 构建与 GUI 点验，仍归 T37-c 高资源环境。

## 遗留

- 第 2 条只做到"清楚失败"。若产品确实要远程 Pi 终端，需要新决策：远程主机上的 Pi CLI 供给、
  `SessionManager` agent-kind 禁令的例外口径、以及托管凭据是否允许出本机。
- 队列 hook 的行为回归停在纯函数层：仓库没有 jsdom / testing-library，加 React 渲染依赖超出本次修复范围。
