# Topic — Pi 迁移参考仓库（跨会话必读）

> 本文件是 Pi Backend Migration 的持久参考入口。新会话恢复本计划、评估新切片或复审已落切片时，必须先按任务矩阵打开本地参考实现，不能只读本仓后从零设计。

## 1. 仓库与授权

| 仓库 | 本地路径 | 上游 | 本次记录版本 | License | 主要角色 |
|---|---|---|---|---|---|
| pi-app | `/home/ai/code/pi-app` | <https://github.com/justhil/pi-app.git> | `c5ad2f4dccb4` | MIT，Copyright 2026 justhil | Pi 原生功能语义：历史、resume、session tree、rewind/fork、时间线和交互 |
| pix | `/home/ai/code/pix` | <https://github.com/num-scope/pix.git> | `da01b3e12d2e` | MIT，Copyright 2026 Num Scope | 桌面架构与运行时：utilityProcess、Extension UI、Pi TUI、PTY、打包与多会话隔离 |

版本只用于复核时说明观察基线，不把参考仓固定 pin 成产品依赖。大量复制须保留对应 MIT copyright/license notice。

## 2. 强制工作规则

1. 每个 Pi 迁移切片在设计/编码前，先查本表对应参考仓的实现和测试。
2. 输出必须标明：**直接移植 / 适配移植 / 不采用**，以及不采用的本仓约束。
3. 不复制参考仓的进程架构或私有 SDK 深导入，只复制与本仓边界兼容的算法、状态机、协议语义和测试场景。
4. pi-app 是功能语义优先参考；pix 是隔离、TUI、打包和 Extension UI 优先参考。两者冲突时，以本仓已拍板产品语义和安全边界为准。
5. Cycle 1/2 已落代码也要做一次对照审计：先找参考实现，再判断本仓代码是等价、更强、可简化还是发生漂移；不为“像参考仓”而无收益重写。

## 3. 任务矩阵

| 领域 | 首选参考 | 必看位置 | 用法 |
|---|---|---|---|
| Pi history / resume | pi-app | `packages/shared/session-jsonl-timeline.ts`、`timeline-incomplete.ts`、`src/renderer/src/lib/open-session.ts`、`src/main/session-bind-state.ts` | history timeline、分页、残缺叶恢复可直接移植；open/load 流程适配 Agent Host |
| session tree / rewind / fork | pi-app | `src/main/session-tree-from-file.ts`、`session-leaf-override.ts`、`src/renderer/src/lib/session-fork.ts`、`features/rewind/` | 复用 Pi 原生 tree navigation/fork 语义和 UI 交互；补本仓确认与生命周期清理 |
| 时间线与消息操作条 | pi-app | `features/timeline/`、`message-hover-actions.tsx` | 结构/交互可直接取用，再套 `@coss/ui` 和本仓设计令牌 |
| Extension UI / 能力分层 | pix + pi-app | pix `packages/agent-runtime/EXTENSION_UI.md`、contracts；pi-app extension UI consumers | pix 定能力/隔离；pi-app 定真实消费者行为 |
| Pi TUI / GUI↔TUI | pix | `apps/desktop/src/main/pi-tui-pty.ts`、`pi-tui-session.ts`、`pi-tui-env.ts`、`pi-cli-extract.ts`、`src/renderer/components/PiTuiTerminal.tsx`、`e2e/terminal.spec.ts` | PTY 状态机、互斥、park/promote、CLI 提取、打包和真机矩阵；renderer 继续用本仓 xterm |
| utilityProcess / Host 隔离 | pix | desktop Agent Host、`packages/contracts` | 保留本仓已落四层架构，复核协议与崩溃边界 |
| 模型配置 | pi-app + 本仓 D8 | pi-app model/settings 读取链；本仓 `topics/model-config.md` | 参考本地优先与配置投影；受管同步/凭据边界以本仓决策为准 |
| 权限与审批 | pix + `pi-permission-system` | pix Extension UI；本机插件包；本仓 T08 evidence | 对照 blocking/fire-and-forget、生命周期、窗口路由；插件策略以实测为准 |
| 打包/产物 | pix | `electron-builder.yml`、`asar-unpack.ts`、`pi-cli-extract.ts`、相关 tests | 复用 Node/CLI/native helper 的资源布局和 smoke 思路，适配本仓 afterPack |

## 4. 为什么恢复链路看起来差异很大

差异主要在**外层宿主架构**，不是 Pi 的历史/分支语义：

| 维度 | ai-client | pi-app | 处理原则 |
|---|---|---|---|
| 产品范围 | Claude/Codex/Pi 共用 RuntimeEvent 协议 | Pi-only | 保留本仓统一协议，不把 renderer 绑到 Pi SDK |
| 会话身份 | 应用 `sessionId` + opaque `runtimeIdentity` + agent binding | session file/worker slot 更接近直接身份 | 在 Agent Host 内把 `runtimeIdentity` 解析为 Pi session file，不废掉应用 sessionId |
| 运行时所有权 | Main → utilityProcess Agent Host → 每会话 Pi handle | Main → WorkerManager → worker slot → AgentSession | 移植底层 `SessionManager.open/getBranch/navigateTree/fork`，不搬 WorkerManager |
| 恢复输出 | renderer 等 `session.resumed → session.history → idle` | worker/load 后以 snapshot/IPC 刷新 | 在 Pi-native读取完成后投影成本仓三事件契约 |
| 持久索引 | `SessionIndexService` 同时保存多 agent 的 opaque identity | 主要从 Pi session files 枚举 | 保留索引作为产品导航；用 Pi list/open 校验并补历史内容 |
| 相邻状态 | queue、pending、Extension UI、runtime facts、多窗口 owner | pi-app 状态结构不同 | rewind/fork 后必须走本仓生命周期清理，不照抄 slot remap |

当前 `src/agent-host/piRuntime.ts::resumeSession()` 只做 registry resume，然后发 `session.resumed` 与 idle；它**既没有发 `session.history`，也没有调用 `SessionManager.open()`**。Cycle 3 的正确方向不是替换整条 ai-client 恢复架构，而是把 pi-app 已验证的 Pi-native reader/open/branch 实现嵌进这个 Host 边界，再保留外层 IPC、索引和 RuntimeEvent 契约。

## 5. Cycle 3 复用清单

### 可直接移植

- `packages/shared/session-jsonl-timeline.ts`：`buildTimelinePageFromSessionFile`、`paginateItems`、branch → timeline。
- `packages/shared/timeline-incomplete.ts`：残缺 assistant、tool bridge 空叶和 rewind target 解析。
- `src/main/session-tree-from-file.ts`：迭代建树与节点上限。
- `src/renderer/src/lib/rewind-metadata.ts`：request sequence + session key 防迟到树响应。

### 适配移植

- list/open/resume：改接 Agent Host `runtimeIdentity` 和本仓三事件恢复协议。
- `navigateSessionToEntry` / `AgentSession.navigateTree`：加 idle gate、确认和 store 清理。
- `runtimeFork(entryId, { position: 'before' })`：创建本仓新 session row/runtimeIdentity，源会话不变。
- `message-hover-actions.tsx`、`features/rewind/`：换成本仓 `@coss/ui`、i18n 和确认语义。

### 不采用

- pi-app WorkerManager/slot 架构。
- SDK `dist/core/*` 私有深导入（除非公开 API 缺失且有版本探测）。
- 固定 80/200/250/500ms sleep 代替 abort/dispose/flush ACK。
- 双击立即 rewind 且无“后续分支不删除”确认。

## 6. Cycle 4 pix 复用清单

### 可直接移植/重点改写

- `PiTuiPtyController`：open 串行化、suspend/resume、跨会话 park/promote、generation/handle 过滤旧输出、disposeSession/disposeAll。
- `normalizeSessionKey()`、`planPiTuiLaunch()`、`PiTuiExclusiveGuard`：路径归一化与 GUI/TUI 写入互斥。
- `resolvePiPtyLaunch()`、`ensureNodePtySpawnHelperExecutable()`、`createNodePtySpawn()`：绝对 Node + JS CLI、ConPTY、spawn-helper 权限。
- `TerminalDataEvent` / `TerminalExitEvent`：输出携带会话身份，防旧 PTY 字节污染新会话。
- `ensureExtractedPiCli()`、`selectPiTuiAsarFiles()`：随包 CLI 和 asar 资源策略。

### 接入本仓而非照搬

- Main 生命周期接入本仓 `SessionManager.createLocal/attach/detach`，metadata 标记 `driver: pi, presentation: tui`。
- 环境变量复用本仓 `resolveManagedPiPtyEnv()`，登录模式才注入 `PI_CODING_AGENT_DIR`。
- Renderer 复用 `useXterm.ts` 与 `AgentTerminal.tsx`，只取 pix 的身份过滤/ready/repaint 协议。
- 不采用 Pix Ghostty 私有 renderer、全局 npm 探测安装或 HostSupervisor parking。

## 7. Cycle 1/2 回顾审计

进入 Cycle 3 主施工前做一次只读/小修优先审计：

1. **Cycle 1**：queue、preview、权限策略/设置面，对照 pi-app queue/session 行为与 pix Host/打包边界。
2. **Cycle 2**：Extension UI bridge/capability/reset/window routing 对照 pix contracts/bridge；模型菜单/effort 对照 pi-app catalog/composer。
3. 每项只记录四种结论：`等价`、`本仓更强`、`可直接简化`、`存在行为漂移`。
4. 只有后两类进入修复；前两类保留并把理由写入 evidence，避免无收益重写。
