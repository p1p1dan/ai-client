# 决策 127：P1-11 第一部分（去掉内嵌 pi TUI 与会话栏 GUI / TUI 开关）的实现取舍

日期：2026-09-29。**状态：自主决定，待用户审批。**

依据：
- 用户裁决：[决策 090](090-user-rulings-2026-09-28.md)（Q003：去掉 pi TUI 与开关，原位置加普通终端按钮；默认跟随 DSH）、[109](109-user-rulings-p1-7-prototype-2026-09-28.md)（终端放在右列、与文件编辑器同级）、[126](126-user-rulings-p1-11-terminal-prototype-2026-09-29.md)（终端与编辑器共用右列、未绑定目录置灰、沿用编辑器列宽）；
- 已批准的决策：[001](001-route-b-and-scope.md) 第 5 条、[004](004-branch-isolated-dsh-only.md)、[038](038-no-plaintext-key-scope.md) 第 3 条、[063](063-drop-pi-extensions-with-notice.md)、[104](104-legacy-asset-notice-and-extension-pages.md)；
- 待审批的前序决策：[116](116-p1-16e-legacy-asset-notice-choices.md)、[117](117-p1-10c-plugin-settings-choices.md)、[122](122-p1-9d-migration-orchestration-choices.md) 第 16 条、[125](125-p1-15-one-shot-completions-choices.md)；
- 方案：[P1-8 / P1-11 方案](../topics/p1-8-p1-11-guards-and-terminal.md) §2、§5 的 P1-11a～c 行，分片 [01](../topics/p1-8-p1-11-guards-and-terminal/01-terminal-inventory.md)、[02](../topics/p1-8-p1-11-guards-and-terminal/02-terminal-options.md)。

范围：只做删除（P1-11a Main、P1-11b 渲染层的删除部分、P1-11c 测试与守卫）。右列普通 shell 终端是 P1-11 第二部分，本次不做。改动留在工作区，由编排者复跑后提交。**第 4、8、11 条请重点审批。**

## 规则

### 一、Main：删掉 pi TUI

1. **pi TUI 整套删除**：`src/main/ipc/piTui.ts`、`src/main/services/terminal/PiTuiPty.ts`、`piTuiSession.ts`、`piTuiStrandedSessions.ts`、`src/shared/types/piTui.ts`；IPC 通道 `piTui:*` 共 11 条与 preload 的 `piTui`。三处生命周期里的 TUI 处理一并删除：
   - 登出：`performLogoutSequence` 的 ②b（`disposeAllPiTuiControllers`）；剩下的 PTY 全是 `SessionManager` 里的 shell，② 已经在等它们；
   - 关窗：`MainWindow` 的 `disposePiTuiWindow`；
   - 退出：`ipc/index.ts` 异步清理与同步清理里的两处。
2. **交接与 `reload` 入口删除**：`chat.ts` 的 `handOverFromTui`、`reloadSessionFromDisk` 与 `chat:reloadSession` IPC，preload 的 `chat.reloadSession`，`WorkerManager.reloadSession`。发送、重试、压缩、回退不再先读索引行做交接，直接交给引擎。
   - **worker 协议里的 `worker.reload` 不在本次删**：`workerRpc.ts` 的类型与守卫、`piWorkerRpcServer.ts` 的处理、`dshSessionRuntime.reload()` 的 unsupported 桩、native runtime 的实现，都随 native 在 P1-12 删（方案分片 02 的原定时点）。Main 已没有调用方，`workerRpc.ts` 的注释写明了这一点。这样本次不碰 bridge，金样本不受影响。
3. **`/new` 会话登记删除**：`piTuiStrandedSessions` 的目录快照与扫描、`piTui:sessionsIndexed` 广播、渲染层的 `subscribeToTerminalCreatedSessions`。
   - `SessionIndexService.list()` 不改。它「回答每一行」的行为还服务 GC 的认领集合与暂存 fork 清扫（决策 122 第 10 条），为 TUI 保留的只是其中一个调用方；`createImported` 的注释改掉了对 `piTui.ts` 的引用。
4. **pi CLI 插件管理也在本次删，不再等 P1-12**（修订决策 116「留给 P1-12 的无引用清单」与 117 第 72 行的时点）：`src/main/ipc/piPlugins.ts`、`src/main/services/piPlugins/`（含两份测试）、`src/shared/piPlugins.ts`、`src/renderer/components/settings/PiPluginsSettings.tsx`、`piPlugins:*` 4 条通道与 preload 的 `piPlugins`；只剩它们用的 `resolveManagedPiPtyEnv` 与 `services/agent-host/piCliLayout.ts` 一起删。理由：
   - pi 扩展只在 TUI 里加载（决策 063 第 1 条）；TUI 没了，装卸 pi 扩展对产品不再有任何作用；
   - 它的启动计划 `resolvePiCliLaunchPlan` 就在 `PiTuiPty.ts` 里，留着它就得把 pi CLI 启动器搬到别处续命；
   - 方案原意是插件页的 pi CLI 装卸随 P1-10c 下线（分片 02「决策 063」一行）；P1-10c 只卸了页面，留下一条渲染层仍能调用、会联网跑 `pi install` 的 IPC；
   - 删完之后，静态守卫能证明产品里**没有任何地方**再拉起 pi CLI（第 17 条）。
   - `src/agent-host/permissionPlugin.ts` 不动：它在 agent-host 包里，随 P1-12 处理。
5. **`SessionManager.create` 对 `kind: 'agent'` 仍然拒绝**，错误文案改为 `Agent PTYs are not supported`（原文指向已删除的「Pi TUI API」）。`SessionKind` 类型的 `'agent'` 值不改，留给右列终端任务或 P1-12 判断。

### 二、`auth.json`（决策 038 第 3 条）

6. **停写 `auth.json`**：`PiModelConfigService.writeRuntimeConfig` 只写 `models.json`；每个 provider 的 key 只存在于内存里的构建结果（`buildNativeModelCatalog().auth`），DSH 凭据代理照旧按请求从这里取（决策 034）。同步（远端、未过期缓存、过期缓存）、内置快照（A3）、用户自有服务编辑、账户迁移，这几条写路径都不再产生 `auth.json`。
7. **删掉 T082 的「保管箱一变就重写 `auth.json`」**：`managedCredentialsStartup.ts` 的 `wireVaultAuthJsonResync` 及其合并队列、`main/index.ts` 里的接线。它唯一的读者是 TUI（方案分片 02 已写明「`managedCredentialsStartup` 为 TUI 做的重写一并删掉」）。
   - 保管箱的 `onChange` 钩子本身保留：DSH 凭据代理靠它清掉缓存的 key。
   - `models.json` 在保管箱变化后的重写，由原有的四个触发点照旧覆盖（登录、启动同步、账户迁移、自有服务编辑）；菜单本来就从内存目录拼，`models.json` 只在内存目录拼不出时兜底。
8. **用户磁盘上已有的 `auth.json`：默认不删，只停写。**
   - 升级后的启动、同步都不碰它：不改写、不删除（测试「leaves an old auth.json untouched on sync, and only logout removes it」钉住）；
   - 登出时照旧删除本应用 agent 目录里的这一份（`clearCredential`，1.0.x 起就有，不是新增的删除）；
   - 代价：升级后一直不登出的用户，磁盘上会留着一份旧的明文 key（0600），内容停在升级前最后一次写入；回装 1.0.x 时它会被 1.0.x 自己的同步覆盖；
   - 备选：启动时一次性删除旧 `auth.json`（约 10 行加一条测试）。它是本应用自己写的文件，删掉更干净，但会动用户磁盘上的文件，按编排口径先不做；**用户同意的话再加**。
9. `models.json` 照写，本次不停：它不含 key，还是菜单的兜底和「目录更新时间」的来源（`safeMtime(modelsPath)`）。决策 038 第 3 条只要求停写 `auth.json`；`models.json` 去留在 P1-12 收尾时再看。

### 三、渲染层

10. **会话栏的 GUI / TUI 分段按钮、TUI 视图全部删除**：`usePresentationSwitch.ts`、`AgentTerminal.tsx`、`hooks/piTuiOpenError.ts`、`ChatWorkspace` 的 TUI 分支与「Reloading this chat…」遮罩、`WorkspaceShell` 里的 `isTui` 分支（`chatVisible` 与全屏 diff 的隐藏只由 chrome 模型决定）、`App.tsx` 挂载的 `initAgentActivityListener`（它监听的是 `piTui` 的数据与退出事件）。
    - 会话栏不留占位。右列终端按钮在下个任务里放在「后台任务 / 子代理」两个按钮旁（决策 109、126；`SessionBar.tsx` 里已有这句注释）。
11. **`presentationMode` 设置整个删除，老值在读入时丢弃**（不是保留字段再归一化成 `gui`）：
    - 删掉设置字段、`setPresentationMode`、`presentationModeMirror.ts`；
    - `presentationMode` 加进 `REMOVED_SETTING_KEYS`：`migrateSettings` 读入时丢弃（`'tui'`、`'gui'`、任何值都一样），`cleanupLegacyFields` 顺带从磁盘上的设置文件里删掉；
    - localStorage 里的镜像键 `aiclient-presentation-mode` 在设置 rehydrate 时移除（`clearLegacyPresentationModeMirror`，读不到 localStorage 时静默跳过）；
    - 理由：只剩一种视图，留一个恒为 `gui` 的字段是死状态；右列终端是「右列显示编辑器还是终端」（决策 126 第 1 条），语义与旧的全局 `presentationMode` 不同，不复用它；
    - 回装 1.0.x：设置里没有这个键，1.0.x 按默认值从 GUI 开始。
12. **登录 / 登出确认框的损失计数去掉 `agentTerminals`**：它按 `useTerminalWriteStore.writers` 数内嵌 TUI，现在只数 shell 终端。`terminalWrite` store 本身保留（编辑器、差异视图的「发到终端」在用，右列终端可以接上）；测试钉住「登记的 writer 不再单独算一个终端」，免得右列终端以后重复计数。
13. **文案**：删 29 条只被删除代码使用的中文翻译：TUI 提示 3 条、拒绝原因 5 条、`/new` 通知 2 条、「显示方式」、`Open TUI`、`Loading Pi...`、`Pi terminal disconnected`、远程仓库不可用 2 条、pi 插件页整页文案 13 条。早在本任务之前就无人引用的 Claude 时代插件市场文案（`Browse Plugins` 等）不在范围内，没动。

### 四、留给右列终端复用的清单

14. **保留（通用终端）**：
    - Main：`services/terminal/PtyManager.ts`、`ShellDetector.ts`、`services/session/SessionManager.ts`、`ipc/session.ts`（`session:*`）、`utils/shell.ts`；
    - preload：`session.*`；
    - 渲染层：`hooks/useXterm.ts`（去掉 pi 分支后只走 `session:*`）、`components/terminal/`（`ShellTerminal`、`TerminalPanel`、`TerminalGroup`、`TerminalSearchBar`、`ResizeHandle`、`terminalSurfaceModel`）、`useTerminalScrollToBottom`、`useFileDrop`、`stores/terminal`、`stores/terminalWrite`、`stores/initScript`、`stores/worktreeActivity`（`setActivityState` 现在无人调用，留给右列终端的活动指示）；
    - 主题与字体：`lib/ghosttyTheme`、设置里的 `terminal*` 各项、`TerminalSettings` 页；终端字体只走 xterm 的 JS 选项、不受聊天字体覆盖影响（`chatFontOverrideStatic` 的 R3 仍钉着）。
15. **删掉的是 pi 专用部分**：`useXterm` 的 `piTuiTerminalId` / `piTuiSessionFile` 分支、挂起与唤醒、D17 的重绘确认、TUI 拒绝提示；`AgentTerminal` 整个组件（它的认证失败、模型缺失浮层都是给 pi CLI 启动失败用的）。
16. **worktree 初始化脚本本来就不依赖 TUI，本次不改**：建 worktree 后 `useWorktreeCreate` 调 `useInitScriptStore.setPendingScript` 与 `useShellLayoutStore.openInitializationTerminal()`，由左栏的通用 shell surface（`TerminalPanel`，`registeredOnly`）接住并执行。右列终端落地后要不要改到右列里跑，是下个任务的挂点：`openInitializationTerminal` 与 `pendingScript` 的消费方。

### 五、测试与守卫

17. **新守卫 `src/shared/__tests__/piTuiRemovedStatic.test.ts`**（产品代码去掉注释后扫描 `src/main`、`src/preload`、`src/renderer`、`src/shared`）：
    - 删掉的文件确实不在；
    - 没有 `piTui` / `PI_TUI_` / `chat:reloadSession` / `handOverFromTui` / `piPlugins:` 等通道与入口；
    - 没有任何地方解析或拉起 pi CLI（`'pi-coding-agent'`、`resolvePiCliLaunchPlan`、`'--session'`），`node-pty` 只在 shell 与远程助手的 4 个文件里；
    - 会话栏没有 GUI / TUI 开关，`presentationMode` 只作为待丢弃的键出现在 `migration.ts`；
    - `PiModelConfigService` 不再写 `auth.json`，登出仍会删旧文件，`wireVaultAuthJsonResync` 不存在；
    - 通用终端栈（第 14 条）还在，`useXterm` 走 `session:*`，初始化脚本仍打开 shell 终端。
18. **单测**：`presentationModeRemoved.test.ts`（新：`'tui'`、`'gui'`、其他值都被丢弃，store 没有字段与 setter，镜像键被移除、localStorage 抛错或不存在时不报错，rehydrate 时清理）；`removedSettings.test.ts` 加 `presentationMode`；`PiModelConfigService.test.ts` 的 key 断言全部改为「没有 `auth.json`、key 在内存构建里」，新增「旧文件同步时不动、登出才删」；`managedCredentialsStartup.test.ts` 的 T082 三例换成「第 ③ 阶段只写 `models.json`、没有任何文件含 KEY-CANARY」与「不再导出 resync」。
19. **删除的测试**：`piTuiHandover`、`PiTuiPty`、`piTuiManagedChannel`（起真 pi CLI 的端到端）、`piTuiSession`、`piTuiStrandedSessions`、`tuiHandoverWiring`、`piTuiSessionBinding`、`terminalCreatedSessions`、`PiPluginService`、`terminalPermissionSystem`；`WorkerManager.test.ts` 的 reload 四例；`chatPiWorkerRouting.test.ts` 的交接相关 9 个用例（换成「没有 reload 通道、写路径直达引擎」4 例）。
20. **改写的静态 / 挂载测试**（穷举 `piTui|presentationMode|\btui\b` 后逐个处理）：`t35FinalAbsence`、`piCliIsBundledToolOnly`（第三例反过来：Main 里没有 pi CLI 启动器）、`onboardingLogoutSequence`、`chatReadSessionPage`、`piWorkerEnv`、`SessionManager`、`ScratchWorkspaceService`、`unboundChatWiring`、`modelMissingWiring`、`chatFontOverrideStatic`、`retryLastTurn`、`authGateWiring`、`singleSessionViewStatic`、`sessionBranchesEntry`、`panelVisibilityStatic`、`deadControlsStatic`、`signInLossModel`、`signInConfirmFlow`、`scratchWorkspace`；`tuiEditorAndRailAlignStatic.test.ts` 改名为 `editorAllocationAndRailAlignStatic.test.ts`，只留编辑器列与导轨对齐两组断言。

## 取舍

- **pi 插件管理现在删还是等 P1-12（第 4 条）**：等 P1-12 能少改约 1.1k 行，但得把 pi CLI 启动器从 `PiTuiPty.ts` 搬出来续命，守卫也只能写成「除了一个没有入口的插件 IPC 之外不拉起 pi CLI」，而那条 IPC 仍能被渲染层调用、联网跑 `pi install`（会执行 npm 包的安装脚本）。现在删对用户没有可见变化（页面在 P1-10c 已卸下）。
- **`worker.reload` 协议现在删还是等 P1-12（第 2 条）**：现在删要同时改 agent-host 服务端、dsh-host 的 bridge 桩和 native runtime，而这三处都在 P1-12 的删除范围里；Main 的入口删掉就够保证没人再调。
- **`presentationMode` 删字段还是归一化（第 11 条）**：保留字段并读成 `gui` 改动更小，但留下一个没有读者的全局状态，下个任务很容易被误用来表示「右列显示终端」。
- **旧 `auth.json` 删还是不删（第 8 条）**：见第 8 条的代价与备选。

## 影响

- **用户看得见的不同**：
  - 会话栏右侧的「GUI / TUI」两个按钮不见了；以前停在 TUI 模式的用户，升级后直接看到对话界面；
  - 在内置终端里用 pi 助手、pi 扩展的用户失去它们（决策 064 第 7 条已列）；旧 pi 会话在 GUI 里继续，首次继续时迁移（决策 050）；
  - 右列终端要等 P1-11 第二部分，这之间会话栏没有终端入口；建 worktree 后的初始化脚本照旧在左栏的 shell 终端里跑。
- **key**：DSH 路径与本地磁盘上都不再有新写入的明文 key；升级前留下的那份见第 8 条。
- **加密机**：不变。
- **没有改**：宿主、bridge、`worker.reload` 协议、`src/runtime`、`src/agent-host` 的产品代码、`package.json` 与锁文件（`@earendil-works/pi-coding-agent` 仍在 `src/agent-host/package.json`，由 P1-12 随 `resources/agent-host` 整体去掉）、`implementation-status.md`、`roadmap.md`。

## 遗留

- **右列终端（P1-11 第二部分）要接的点**：
  - 会话栏按钮：放在 `SessionBar.tsx` 的 `BackgroundWorkButtons` 旁；会话未绑定目录（`activeWorkspace?.path` 为空、含临时会话）时置灰（决策 126 第 2 条）；
  - 右列互斥：`WorkspaceShell.tsx` 的 `editorOpen` / `reviewOpen` 与 `editorAllocated`，共享 `--shell-editor-w`（决策 126 第 1、3 条）；
  - 终端本体：`ShellTerminal` + `useXterm`（`session:*`），cwd 取会话目录；
  - 初始化脚本：决定是否改由右列终端消费 `pendingScript`；
  - 登录确认框的终端计数：右列终端若进 `useTerminalStore.sessions`，会自动算进 `shellTerminals`；
  - `SessionKind` 的 `'agent'` 值与 `SessionManager` 的拒绝分支，届时可一并清理。
- **P1-12 要删的**：`worker.reload` 协议（第 2 条列出的四处）；`src/agent-host/permissionPlugin.ts` 与 `userResourcePaths.ts`（后者已无引用，提示词里还写着「Pi TUI sessions」）；`PiWorkerProcess.ts` 里 D20 的历史注释；探针脚本 `scripts/run-t37c-gui-probe.mjs`、`scripts/run-h19-plugin-gui-probe.mjs`、`scripts/run-p6-native-default-probe.mjs`、`scripts/probes/t37b-longevity-probe.ts` 仍引用 `piTui` / `piPlugins`，只是手动探针，不在测试里。
- **没有做 GUI 点验**（本机不启动 Electron）：会话栏没有开关、老设置落在 GUI，由静态守卫与单测覆盖；外观需要编排者或用户点验。
- **发版说明**：接在决策 064 的行为差异清单后面补一条「内嵌 pi 终端移除」。

## 对既有决策的修订注记

- [决策 038](038-no-plaintext-key-scope.md) 第 3 条：P1-11 已停写 `auth.json`；已有文件不主动删，登出照旧删（本决策第 6～8 条）。
- [决策 116](116-p1-16e-legacy-asset-notice-choices.md)「留给 P1-12 的无引用清单」、[决策 117](117-p1-10c-plugin-settings-choices.md) 第 72 行：`piPlugins:*` 4 条、`services/piPlugins/`、`src/shared/piPlugins.ts`、`PiPluginsSettings.tsx` 及其翻译提前在 P1-11 删除（本决策第 4、13 条）。
- [决策 122](122-p1-9d-migration-orchestration-choices.md) 第 16 条：`handOverFromTui` 已删除（本决策第 2 条）。
- [决策 063](063-drop-pi-extensions-with-notice.md) 第 1 条：产品里不再有任何地方拉起 pi CLI；pi CLI 产物本身仍随 P1-12 去掉。

## 用户裁决（2026-09-29）

- **第 4 条（pi 插件管理提前删除）**：同意。
- **第 8 条（旧 `auth.json` 启动时不删，只停写；登出照旧删）**：同意，维持默认。
- 第 11 条用户询问了含义，编排者已说明只涉及 `presentationMode` 一个设置，其他显示设置不受影响；待用户确认。
