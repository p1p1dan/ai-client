Role: detail shard

# P1-8 / P1-11 分片 01 · 内嵌终端现状（1.0.x 与本分支）

上位：[P1-8 / P1-11 方案](../p1-8-p1-11-guards-and-terminal.md)。回答调研问题 1：1.0.x 内嵌终端的全部功能与用户能感知的入口，以及本分支现在的样子。

约定：行号取 worktree HEAD `526ec2e5`（`git show 526ec2e5:<路径>`，与 `59758c2b` 相同；该基线已合入 v1.0.3），路径省略前缀 `src/`。只读代码、测试与文档，没有起 Electron，没有读真实用户目录。

## 1 用户能感知到的入口

| 入口 | 位置与条件 | 行为 | 依据 |
|---|---|---|---|
| GUI / TUI 分段按钮 | 顶部会话栏；会话绑定了目录或是临时会话时才显示 | 点 TUI：整列换成 pi 终端；点 GUI：挂起终端、重读会话再回到时间线 | `renderer/components/workspace-shell/SessionBar.tsx:67-72,191-205`；`renderer/components/chat/usePresentationSwitch.ts:97-209` |
| 「Start Pi TUI」按钮 | TUI 模式下还没有终端时 | 起终端 | `renderer/components/chat/ChatWorkspace.tsx:256-279` |
| TUI 关闭 | 在 pi 里退出，或进程自己退出 | 提示「Pi TUI closed」，回到 GUI 并无条件重读 | `usePresentationSwitch.ts:221-247` |
| 设置「扩展→插件」 | 设置页 | pi 扩展的装、卸、启停；页上注明内置终端用哪套权限扩展 | `renderer/components/settings/PiPluginsSettings.tsx`；`main/services/piPlugins/index.ts:90-141` |
| 通用 shell 面板 | 左栏 `LeftDock` 的 surface（`registeredOnly`，没有导轨入口），keep-alive。2026-09-28 订正：原文写「右侧」，D08（2026-09-05）之后 surface 全在左栏，右列只放文件（`surfaceRegistry.ts:31-36`） | 2026-09-04 按用户要求撤掉顶栏按钮、Ctrl/Cmd+`、rail 数字；只剩「建 worktree 后跑初始化脚本」会打开它 | `renderer/components/workspace-shell/surfaceRegistry.ts:144-161`；`shellLayoutModel.ts:446-447`；`renderer/hooks/useWorktree.ts:170`；提交 `5fbc12b2` |

`presentationMode` 是全局设置，存在设置 store 里（`renderer/stores/settings/index.ts:238,278-280`；`migration.ts:208`）。GUI 与 TUI 互斥，不存在「A 会话开终端、B 会话用 GUI」的状态（`main/services/terminal/piTuiSession.ts:12-16`）。

## 2 pi TUI 逐项

- **载体**：随包的 pi CLI `@earendil-works/pi-coding-agent@0.84.3`，另带 `@gotgenes/pi-permission-system@27.0.1`（`agent-host/package.json:12-15`）。afterPack 把 `out-agent-host` 整目录拷到 `resources/agent-host`（`scripts/afterPack.mjs:41-66`），Linux 上 85 MiB，含 native worker（[P1-2 分片 01](../p1-2-host-packaging/01-packaging-chain.md) 第 11 行）。P6-2 起它只作为「随包的可执行文件」保留，给内嵌终端和插件管理用，这是用户 09-13 选的（`agent-host/__tests__/piCliIsBundledToolOnly.test.ts:1-20`）。
- **拉起**：打包态用随包 node，开发态用 Electron 的 node 模式，缺文件直接报错（`main/services/terminal/PiTuiPty.ts:131-161`）。每个窗口最多 2 个活终端，挂起的按最近使用淘汰（`:23,440-454`）。首条提示词经 bracketed paste 写进 stdin，不进 argv（`:361-363`）。
- **环境**：继承 Main 的全部环境；managed 模式剔除凭据类变量；再加 `PI_CODING_AGENT_DIR=<agentDir>`、UA 与 managed 标记（`PiTuiPty.ts:163-184`；`main/services/piModelConfig/index.ts:356-397`）。
- **模型与凭据**：
  - pi 从 `<agentDir>` 读 `models.json` 与 `auth.json`。后者是每个 provider 的明文 key，权限 0600（`main/services/piModelConfig/PiModelConfigService.ts:674-675`）。
  - TUI 只读磁盘上的文件，所以保管箱一变就专门为它重写 `auth.json`（`main/services/auth/managedCredentialsStartup.ts:92-96,145`，T082）。
  - managed 下只保证「公司渠道可用」，不封用户自己的渠道（runtime-hardening 决策 011）；由起真 pi CLI 的端到端测试守住（`main/services/terminal/__tests__/piTuiManagedChannel.test.ts`）。
- **续聊 GUI 会话**：`pi --session <file> --session-dir <dir>`（`piTuiSession.ts:60-63`）；只有 v4 头的旧 native 文件与 DSH 桩被拒（`:292-337`）。
- **交接**（同一个 JSONL 不能有两个写者）：
  - 进程级互斥 `PiTuiExclusiveGuard`、跨窗口的 `PiTuiWindowSessionGuard`、「TUI 写过、GUI 还没重读」的集合 `tuiWrittenSessions`（`main/ipc/piTui.ts:31-69`；`piTuiSession.ts:72-131,167-268`）。
  - 打开前查 worker 有没有在飞的回合（`piTui.ts:365-377,399-403`）；渲染层在跑回合时也拒绝（`usePresentationSwitch.ts:109-119`）。
  - GUI 的发送、重试、压缩、回退之前都走 `handOverFromTui`：杀掉该会话上的终端并确认退出；终端写过的话，让 worker `reload`（`main/ipc/chat.ts:180-229`，调用点 `:634,658,870,914`；`piTui.ts:538-563`）。
- **`/new` 搁浅会话**：pi 在会话目录里新建的文件，终端退出后扫出来，以 `agent: pi` 行登记进索引；登记不了就发系统通知（`piTui.ts:187-263`；`main/services/terminal/piTuiStrandedSessions.ts:1-49`，T086）。
- **pi 扩展**：聊天从 cutover-02 起不加载，只有 TUI 加载（`main/services/piPlugins/index.ts:111-119`）。插件页的装、卸、列也跑同一个 pi CLI，`install` 会访问 npm 源（`piPlugins/index.ts:19-29`；`PiPluginService.ts:231-265`）。
- **权限**：TUI 不经我方四档与审批卡。`<agentDir>/settings.json` 没声明权限扩展时判为 `none`，按 pi 自己的默认执行；随包的 pi-permission-system 只是策略页的载荷，CLI 不加载它（`shared/piPlugins.ts:36-50`；`piPlugins/index.ts:63-77`）。推断：pi 默认不做逐次审批。
- **生命周期**：登出时先关全部 TUI，再删 `auth.json`（`main/ipc/onboarding.ts:112-113`）；关窗口（`main/windows/MainWindow.ts:539`）；应用退出（`main/ipc/index.ts:143-144,202-203`）。
- **维护成本**：runtime-hardening 里专门修它的有 T003（交叉写入后会话永久打不开）、T048（终端行为面）、T065（两窗口静默分叉、切回白屏）、T066、T067、T082、T086（[roadmap](../../../runtime-hardening/roadmap.md)）。

## 3 本分支（DSH）现状

- P1-1 R6：`.dsh.json` 桩按文件名直接拒绝（`piTuiSession.ts:295-316`；`main/ipc/piTui.ts:392-398`）。GUI 点验见 [p1-1-gui](../../evidence/p1-1-gui-2026-09-26.md) 第 4 项：出中文提示，不起进程，桩文件不变。
- 所以 TUI 只剩两种用途：
  1. 续聊还没迁移的旧 pi 会话。GUI 在 P1-9 之前对它们只读（决策 005），TUI 是唯一能续聊的地方。
  2. 会话还没落盘（没有 `runtimeIdentity`）时点 TUI，会起一个与本会话无关的新 pi 会话：空路径直接放行（`piTuiSession.ts:311-313`）。它不会被登记，因为搁浅扫描只在带会话文件时才做（`piTui.ts:391-432`）。1.0.x 同样如此。
- `reloadSessionFromDisk` 对非 pi 行直接返回（`main/ipc/chat.ts:218-222`）；P1-4 把 `reload` 定为「只服务 pi TUI，保持不支持」（[P1-4 方案](../p1-4-bridge-parity.md)第 171 行）。
- `auth.json`、`models.json` 仍按 1.0.x 写（决策 038 第 3 条）；pi 扩展仍在 TUI 里加载，直到决策 063 落地。

## 4 相关代码与测试的体量（选 A 时的删除范围）

| 类别 | 文件与行数 | 合计 |
|---|---|---|
| Main | `PiTuiPty.ts` 587、`piTuiSession.ts` 350、`piTuiStrandedSessions.ts` 336、`ipc/piTui.ts` 612、`piCliLayout.ts` 24、`shared/types/piTui.ts` 71 | 约 1.98k |
| 渲染层 | `usePresentationSwitch.ts` 279、`AgentTerminal.tsx` 240、`hooks/piTuiOpenError.ts` 34，加 `useXterm.ts` 的 pi 分支与各处调用点 | 约 0.6k |
| pi 插件管理（归 P1-10c） | `PiPluginService.ts` 265、`piPlugins/index.ts` 143、`PiPluginsSettings.tsx` 271 | 约 0.68k |
| 测试 | `PiTuiPty` 559、`piTuiManagedChannel` 423、`piTuiSession` 377、`piTuiStrandedSessions` 230、`t35FinalAbsence` 116、`piTuiHandover` 587、`tuiHandoverWiring` 132、`piTuiSessionBinding` 175、`terminalCreatedSessions` 101 | 约 2.7k |

另有 `scripts/run-t37c-gui-probe.mjs` 等探针脚本引用 TUI，随 P1-12 清理。
