# OpenChamber 布局对齐的气泡对话重构 — 架构需求文档（ARD）

> 文档日期：2026-07-23
> 文档状态：ARD，已与用户达成共识，待按 Phase 0 验证后进入实施
> 关系：取代 `docs/plans/2026-07-23-openchamber-ui-chat-refactor-feasibility.md` 中与本文冲突的条款；取代 `PROGRESS.md`「OpenChamber UI/功能对齐」主线中「拷贝 OpenChamber UI+sync/store + 升级 Electron + 放弃 Worktree + 丢掉 Ghostty」的方向
> 术语表：见仓库根 `CONTEXT.md`
> 目标项目：AiClient（`D:\Code\projects\ai-client`）

## 1. 一句话定义

保留 AiClient 现有 Electron 工程内核（Git、文件、终端、远程、Worktree、Settings、打包链），重构 Renderer 产品外壳为**对齐 OpenChamber 的 UI 架构与布局**（四区对话中心工作台）——不要求色调风格严格一致，沿用现有设计系统。以独立白名单 Node 24 进程运行 Cometix + Claude 能力，吐结构化 Runtime Event 驱动自建气泡对话。不拷贝 OpenChamber 源码，不升级 Electron，不放弃 Worktree。

## 2. 与既有方案的差异（为什么不是 PROGRESS.md 路线）

PROGRESS.md 主张「原样拷贝 OpenChamber UI + sync/store + Cometix 打包进 app 跑在升级后的 Electron 自带 node 上 + 放弃 Worktree + 丢掉 Ghostty」。本 ARD 否定该路线，依据：

- **sync/store 硬绑 `@opencode-ai/sdk`，与 Claude 无关**：拷贝后 Renderer 会去连一个 OpenCode HTTP+WS 服务端，而 OpenCode 二进制不在 TSD 白名单（已排除）。要喂饱拷来的 sync，必须自造一个伪 OpenCode 服务端，远大于「写个翻译适配器」。
- **「Electron 自带 node 过 TSD 白名单」未经证明**：`src/main/utils/tsdSafeRead.ts` 只证明系统 `node.exe` 过白名单（它 spawn 的是 PATH 上的 node，非 Electron 自带）。PROGRESS.md 仅以 CC 2.1.112 为先例，不构成证明。
- **放弃 Worktree = 自废招牌**：AiClient 产品内核即「Git Worktree 管理器」。OpenChamber 的 `useSessionGrouping.ts` 本身就把 worktree 作为 SessionGroup 一等公民，保留 Worktree 不偏离 OpenChamber。
- **丢掉 Ghostty 438 主题 = 损失现有用户价值**：且应用壳配色与终端配色是两层，解耦后无需二选一。

## 3. 决策摘要

| # | 决策轴 | 结论 |
|---|---|---|
| D1 | 运行时宿主 | 外部白名单 Node 24 Agent Host（独立进程），不升 Electron；Host↔Main 走 stdio NDJSON；node-pty/@parcel/watcher 留 Electron 主进程 Node 22，免重编 |
| D2 | UI/数据层 | 自建 UI on `@coss/ui`，OpenChamber 仅作视觉参考；Host 吐自己的 Runtime Event→自建 Chat Store；不拷 OpenChamber sync/store |
| D3 | 导航模型 | Project > Workspace > Session；Workspace 类型 = Main/Worktree/Remote/Temp；保留 Worktree，降级为 Workspace 的一种类型；同构 OpenChamber 的 Project > SessionGroup > Session |
| D6 | 视觉 | 对齐 OpenChamber 的是 **UI 架构与布局**，非色调风格严格一致；沿用现有设计系统（`@coss/ui` + OKLCH token + Ghostty 终端主题 + Monaco 跟随 Ghostty）；Flexoki 仅作可选后续主题，非 MVP 硬性目标 |
| D15 | 右栏 | MVP 做**单层**可折叠右栏 `git \| files \| context`（并排挤宽，不替换 Chat 页）；OpenChamber 的内层 ContextPanel 双层结构后置 |
| D8 | Cometix 分发 | 作为 npm 依赖打包进 Agent Host，固定一个验证过的 release，零安装 |
| D9 | Host 驱动 | Phase 0 同时实测 ① Agent SDK（经 Cometix `cli.js`，必要时套 node wrapper）② 直接 `--output-format stream-json`，按可执行性 + resume/abort/permission 支持度选一条，另一条留 fallback |
| D10 | 其他 Agent | 本轮保留终端模式，只有 Claude 进气泡对话 |
| D11 | 历史持久化 | MVP：Host 读 CC 自己的会话 JSONL（`~/.claude/projects/`，加密，Host 在白名单 Node 上可读），resume 时重放成 Runtime Events；本地只存索引；快照兜底后置 |
| D12 | 权限/提问 UI | 对话时间线内卡片（PermissionCard/QuestionCard），不只靠全局弹窗 |
| D14 | MVP 范围 | 见 §9；#1 文件引用进 MVP；#2 Effort/Plan/Build 进 MVP 但条件性（Runtime 不支持则隐藏/禁用）；#3 Diff 专用卡后置 |

## 4. 目标产品结构

按 OpenChamber **实际可见布局**（桌面端截图）对齐：

```text
┌──────────────┬───────────────────────────────────────────────────────────┐
│ 左栏 Sidebar │ 顶栏（主区上方）                                            │
│ （独立全高） │ 会话标题              │ 用量环 │ [布局][文件夹▾][Local▾]  │
│              │ Project 名(副标)      │        │ [终端][浏览器][右栏开关] │
│ [菜单]       ├───────────────────────┴────────┴───────────────────────────┤
│ [侧栏开关]   │                                                           │
│              │ 中央 Chat                                                  │
│ ───────────  │ ┌ 消息时间线 ──────────────────────────────────────────┐ │
│ 操作行       │ │ User / Assistant / Tool / …                           │ │
│ 搜索/筛选    │ │ 消息元数据：模型 · Agent · 耗时 · 时间                 │ │
│              │ └──────────────────────────────────────────────────────┘ │
│ recent       │ ┌ Composer ────────────────────────────────────────────┐ │
│   └ Session  │ │ @文件 /指令 !shell #snippet                           │ │
│ test1        │ │ [+][…][模型][Agent][🎤][发送]                         │ │
│   └ Session  │ └──────────────────────────────────────────────────────┘ │
│              │                                                           │
│              │ （右栏、底部 Terminal Dock 默认可折叠）                      │
│ ───────────  │                                                           │
│ 设置/帮助/…  │                                                           │
└──────────────┴───────────────────────────────────────────────────────────┘
```

要点：

- **左栏是独立全高 Sidebar**，不与主区顶栏混成一条。
  - **顶部**：`[菜单][侧栏开关]`（窗口/侧栏控制）。
  - **中部**：项目与会话管理——操作行（新建等）、搜索/筛选，以及 `recent` + 按 Project（如 `test1`）挂 Session 的列表。
  - **底部**：设置 / 帮助 / 关于等入口。
- **主区顶栏**在 Sidebar 右侧：会话标题为主标，Project 名作副标叠在下方；旁侧用量环；右侧为布局、文件夹、Host（如 `Local`）、终端、浏览器、右栏开关、OS 窗口控件。
- **中央**：Chat 常驻（消息时间线 + 底部 Composer）；模型/Agent 等控制主要在消息元数据与 Composer 内。
- **右栏 / 底部 Terminal Dock**：可折叠；默认常收起。打开后右栏为辅助区（git/files/context），底栏为 Terminal。

MVP 对齐策略（已定）：以上可见架构与布局对齐；**右栏 MVP = 单层** `git | files | context`（并排挤宽，Chat 常驻不换页）；OpenChamber 内层 ContextPanel 双层、preview/diagram/浏览器等非核心入口后置。

左栏数据层级（映射到 AiClient，对应截图中的 `recent` / `test1` 分组）：

```text
Project（如 test1）
└── Workspace（工作目录，类型：Main | Worktree | Remote | Temp）
    └── Session（绑定该 Workspace 的 Claude 对话，可有多个）
+ 额外分组：recent（按最近活动的跨 Project Session 列表）
```

Session 状态：`idle | starting | running | waiting_permission | waiting_question | stopping | completed | failed | disconnected`。

## 5. 技术架构

### 5.1 进程拓扑

```text
Electron Renderer
  Workspace Shell | Chat UI | Git/Files/Context | Terminal Dock
  Chat Store(自建) | UI State | 现有 Stores
        │ typed Electron IPC
Electron Main
  AgentHostManager | GitService | FileService | PtyManager
  Session Index | Process Lifecycle | Settings
        │ stdio NDJSON
Whitelisted Node 24 Agent Host
  Claude Agent SDK(可选) | Cometix cli.js
  Event Normalizer | Permission/Question Bridge
  Abort/Resume/Session Registry
        │ 显式 CLI runtime
Cometix（@cometix/claude-code，打包进 Host）
  Workspace Files | Claude Config | MCP | Tools
```

### 5.2 进程职责

- **Renderer**：展示结构化消息、接收用户操作、管理 UI 状态、向 Main 发命令、消费 Main 推送的 Runtime Event。不直接启动 Node、不直接访问 Claude SDK、不持凭证。
- **Electron Main**：查找/校验 Node 24、启停监控 Host、生命周期、Renderer 命令↔Host 协议转换、崩溃重启、日志诊断、退出清理子进程、继续提供现有 Git/文件/PTY 服务。
- **Node 24 Agent Host**：载入 Claude Agent SDK（可选）并显式驱动 Cometix `cli.js`、创建/恢复会话、规范化 SDK 消息为 Runtime Event、权限/提问桥接、Abort、异常转稳定错误事件。不含 UI 逻辑，不依赖 Electron API。

### 5.3 Host 协议（stdio NDJSON）

Main→Host 命令：`host.initialize | session.create | session.resume | session.send | session.stop | session.close | permission.respond | question.respond | host.shutdown`

Host→Main 事件：`host.ready | host.error | session.created | session.resumed | session.status | message.started | message.delta | message.completed | thinking.started | thinking.delta | thinking.completed | tool.started | tool.updated | tool.completed | permission.requested | permission.resolved | question.requested | question.resolved | usage.updated | session.completed | session.failed | session.stopped`

协议要求：每命令带 `requestId`；每会话事件带 `sessionId`；Message/Tool/Permission 带稳定 ID；Host 普通日志写 stderr，协议走 stdout；支持协议版本；未识别事件记录不崩 Host；不传不可序列化 SDK 对象。

### 5.4 数据流

```text
Cometix/SDK 原始事件
  -> Host Event Normalizer
  -> 稳定 Runtime Event（NDJSON）
  -> Electron Main 转发
  -> Renderer IPC
  -> Chat Store Reducer（纯函数）
  -> Session/Message/Block 状态
  -> React 组件
```

## 6. 对话领域模型

- **Session**：AiClient session ID + Claude runtime session/resume identity + Project ID + Workspace path + 标题 + 模型 + Effort + Mode + 权限策略 + 状态 + 创建/更新时间 + 最近错误 + 是否归档。
- **Message**：类型 `user | assistant | system | error`，由有序 Block 组成。
- **Block**：`text | thinking | code | tool_call | tool_result | permission_request | question_request | file_reference | diff | usage | notice | error`。
- **增量更新**：Text/Thinking Delta 合并到当前 Block；Tool Update 按 tool call ID 更新；Tool Result 关联对应 Tool Call；Permission/Question 只能响应一次；收到终态冻结该 Block；Stop 保留已产生内容；乱序事件靠稳定 ID + 序号处理；UI 不为每字符全列表重渲染。

## 7. 视觉与布局策略

- **对齐目标 = UI 架构与布局，非色调风格**：本轮对齐 OpenChamber 的是四区结构、左栏 Project/Workspace/Session 导航、中央对话为主任务区、右栏辅助、底部 Dock 的**架构与布局**，以及对话时间线/卡片/Composer 的**交互结构**。色调、字体、边框、阴影等视觉风格**不要求严格一致**。
- **沿用现有设计系统**：继续用 `@coss/ui` + `globals.css` 的 OKLCH 语义 token + 现有尺寸习惯（Tab `h-9`、树节点 `h-7`、小按钮 `h-6`、`min-w-0 flex-1 truncate`）。不为对齐 OpenChamber 而引入其 `cssGenerator.ts` 或重写主题引擎。
- **Monaco 不强制解耦 Ghostty**：`monacoTheme.ts` 维持现有从 Ghostty 终端主题派生的行为，不强制改 Flexoki。若后续做 Flexoki 主题，再单独解耦。
- **终端保留 438 Ghostty 主题**：`resources/ghostty-themes/` + `scripts/generate-themes.ts` + `lib/ghosttyTheme.ts` 原样不动。
- **Flexoki 仅作可选后续**：如未来想要 OpenChamber 观感，可将 Flexoki 调色板表达为 OKLCH token 作为新增主题，非本轮 MVP 硬性目标。

## 8. 现有模块迁移策略

**保留不动**：`src/main/services/git/`、文件读写/监听、xterm.js + node-pty、RemoteConnectionManager、Worktree 管理、Monaco Editor、Settings 基础设施、Electron Main/Preload 安全边界、构建/更新/打包链、`tsdSafeRead.ts` 与系统 Node 读取经验、`ClaudeSessionScanner` 的 `~/.claude/projects/` 扫描能力。

**改造**：
- `src/renderer/App.tsx`：逐步抽出 Workspace Shell / Left Nav / Main Area / Right Dock / Bottom Dock / Dialog Host，最终只做顶层装配。
- `src/renderer/components/layout/MainContent.tsx`：Chat 常驻中央，Git/Files/Context 进右栏，Terminal 进底部，Settings 独立入口。
- `src/renderer/components/chat/AgentPanel.tsx`：Claude 主路径由新 Chat Workspace 替换；AgentTerminal 不再渲染 Claude 主会话；EnhancedInput 有价值能力迁入新 Composer；旧 AgentPanel 暂留其他 CLI Agent。
- `src/renderer/stores/agentSessions.ts`：不扩展承载结构化消息；新建独立 Chat Store；通过 Workspace ID/Path 关联。

**新增（边界，文件名实施时可调）**：
```text
src/main/services/agent-host/   AgentHostManager / Process / NodeRuntimeResolver / Protocol / Diagnostics
src/main/ipc/chat.ts
src/agent-host/                  index / protocol / claudeRuntime / eventNormalizer / sessionRegistry
src/shared/types/                 chat.ts / agentHost.ts / runtimeEvents.ts
src/renderer/components/workspace-shell/  Shell / LeftNav / RightDock / BottomDock
src/renderer/components/chat/     ChatWorkspace / MessageTimeline / ChatComposer / blocks/ / cards/
src/renderer/stores/chatSessions.ts
```

**清理**：回退 `17b8cce` 孤立的 `src/renderer/components/ai-chat/`（17 文件，未接线，假 `setTimeout` 响应）；保留 `src/shared/types/ai-chat.ts` 类型并接入导出。

## 9. MVP 范围与功能矩阵

| 能力 | MVP | 后置 | 说明 |
|---|:---:|:---:|---|
| 四区外壳（OpenChamber 布局） | ✅ | | 架构与布局对齐，非色调 |
| 沿用现有 OKLCH 设计系统 | ✅ | | 不引入 cssGenerator |
| 终端 438 Ghostty 主题 | ✅ | | 原样不动 |
| Project/Workspace/Session 树 | ✅ | | 新建/选择/重命名/关闭/Resume/状态徽标 |
| 新建 Session + 发送 + 流式文本 + Markdown | ✅ | | 结构化事件驱动 |
| Thinking 折叠 | ✅ | | |
| Tool Call/Result 卡 | ✅ | | 通用卡 + 常见工具摘要 |
| Permission 卡 / Question 卡 | ✅ | | 时间线内卡片 |
| Stop / Resume | ✅ | | Resume 走 CC JSONL |
| Model 选择 | ✅ | | 只展示可用模型 |
| Composer 文件/上下文引用 | ✅ | | 与 Files 面板联动 |
| Effort/Plan/Build 控件 | ✅* | | 条件性：Runtime 不支持则隐藏/禁用 |
| 右栏 Git/Files/Context（单层） | ✅ | | 并排挤宽、不换页；Context 只放真实基础字段；双层 ContextPanel 后置 |
| 底部 Terminal Dock | ✅ | | 复用现有终端 |
| Node/Cometix 诊断 + TSD 自检 | ✅ | | |
| 其他 Agent 终端入口 | ✅ | | 保留 |
| Diff 专用 Tool Card | | ✅ | 先复用现有 `DiffViewer` |
| Usage/Cost | | ✅ | |
| Slash Commands | | ✅ | |
| MCP 状态面板 | | ✅ | |
| 多会话并排 / 消息搜索 / 导出 | | ✅ | |
| 其他 Agent 结构化适配器 | | ✅ | Claude 稳定后再评估 |
| 历史快照兜底 | | ✅ | JSONL 格式崩了再做 |

## 10. Phase 0 — Go/No-Go 标准

### 10.1 必须拿到的证据

- 白名单 Node 24 真实 `process.execPath` + 版本；
- 用该 Node 24 真实读取已知 TSD 加密文件，确认是解密内容（非 `%TSD-Header-###%` 原始字节）；
- Cometix 固定 release + 文件来源 + SHA256 记录；
- **Agent SDK 路线实测**：`@anthropic-ai/claude-agent-sdk` 经 Cometix `cli.js`（必要时套 node wrapper）能执行最小 Query，拿到结构化 Assistant/Tool 事件；
- **stream-json 路线实测**：直接 spawn `node cometix-cli.js --output-format stream-json` 能拿到结构化 JSONL 事件；
- Stop / Resume / Permission 三项在所选路线有成功路径与已知限制；
- 打包后的 Electron 可启动外部 Node Host、可读 TSD 文件、退出无孤儿进程；
- Effort/Plan/Build 是否被 Runtime 支持（决定控件可见性）。

### 10.2 Go

上述全部成立，且选定一条 Host 驱动路线（Agent SDK 或 stream-json）。

### 10.3 Conditional Go（可继续，缩小 MVP）

- Resume 暂只能恢复会话身份、历史需单独读取；
- Question 类型在目标版本不完整；
- Effort/Plan/Build 部分模型不支持（控件隐藏）；
- Agent SDK 路线不通，退到 stream-json（或反之）。

### 10.4 No-Go

- 无任何可被白名单识别的 Node 24；
- Agent SDK 与 stream-json 两条路线均拿不到结构化事件（只剩 PTY 文本）；
- 打包应用无法启动白名单 Node；
- 权限回调无法外置，必须回到 CLI 终端交互。

Phase 0 未通过前，不启动 Phase 2 及以后的 Runtime 接线；Phase 1（UI Shell 原型，Mock 数据）可与 Phase 0 并行。

## 11. 实施阶段

### Phase 0 — 技术 Go/No-Go
Node 24 Resolver / TSD 最小验证 / Cometix 启动验证 / Agent SDK 路线 spike / stream-json 路线 spike / Stop·Resume·Permission 验证 / 打包环境验证 / Effort·Plan·Build 支持度探测。产出：路线选型报告 + Go/No-Go。

### Phase 1 — UI Shell 原型（Mock 数据，可与 Phase 0 并行）
四区外壳（OpenChamber 布局，沿用现有 OKLCH 设计系统）+ 折叠/Resize；右栏容器 + 底部 Dock 容器；主要空/运行/权限状态 Mock。产出：可交互四区壳。

### Phase 2 — Runtime Vertical Slice
Host 协议定义 + 入口 + Runtime Adapter + Event Normalizer + Permission/Question Bridge + Abort 状态机；AgentHostManager + IPC + 事件推送；Chat 类型/Reducer + Sessions Store + 增量批处理；MessageTimeline + Text Bubble + Composer + Stop。闭环：新建→发送→流式→一个 Tool→Stop→idle。

### Phase 3 — Chat MVP
Resume + Session Registry + 诊断；Node/Cometix 设置 + 进程清理；会话索引 + 历史恢复（走 CC JSONL）；Workspace View Model + Tree + Session List + 操作；Header + Thinking + Tool Card + 工具摘要 + Permission/Question Card + 文件引用 + 空错断状态。产出：日常可内部使用。

### Phase 4 — 现有能力重新接线
Files/Git/Context 面板迁移 + Chat 联动；Terminal Dock 接入 + Workspace 终端恢复 + Host 诊断入口；新旧模式开关 + 其他 Agent 终端模式 + 旧会话迁移。产出：用户不必在新旧界面切换。

### Phase 5 — 收口与正式版
旧 AgentPanel 收缩 + App/MainContent 清理；Runtime 协议测试 + Chat Reducer 测试 + 长会话性能 + 真实 TSD 回归 + Windows 打包回归 + 可用性验收 + 发布回滚方案。产出：可发布。

### Phase 6 — 按需增强（后置项）
Diff 专用 Tool Card / Usage·Cost / Slash Commands / MCP 状态面板 / 多会话并排 / 消息搜索·导出 / 其他 Agent 结构化适配器 / 历史快照兜底。

## 12. 风险与控制

- **Node 24 ≠ 通过 TSD 白名单**：记录真实 `process.execPath`；用已知加密文件自检；分别验证开发与打包环境；不以 `node --version` 成功替代解密验证。Phase 0 必过。
- **Agent SDK 与 Cometix 兼容**：Phase 0 两条路线都测；记录 release/SDK 版本/SHA256；适配在 Host 内，Renderer 不感知；升级前跑协议回归。executable-path 问题用 node wrapper 解决，不通则退 stream-json。
- **权限交互死锁**：每请求带 ID 与终态；Session 关闭统一拒绝悬空请求；Stop/Host exit/Renderer dispose 都有清理路径；reducer 与 Host 分别测试。
- **长消息性能**：Runtime Event 批处理；Block 级更新；稳定 key；Markdown 完成前轻量增量；长列表达阈值再虚拟化。
- **App.tsx / AgentPanel 继续膨胀**：新模块清晰边界；App 只装配；Runtime Event reducer 保持纯逻辑；UI Block 分组件；不在首任务顺带重写旧模块。
- **新旧会话 ID 混用**：AiClient session ID / Claude runtime identity / UI chat session ID 三者显式命名；共享类型禁止模糊 `id` 跨层传递；Resume 只用 runtime identity。
- **UI 像不像 OpenChamber 但行为是旧产品**：按完整用户任务验收不按截图；权限/Tool/Stop/Resume 必须进消息时间线；Git/Files/Terminal 与当前 Workspace 真实联动；不展示未接通的假状态。

## 13. MVP 验收标准

- 左侧显示 Project/Workspace/Session，中央 Chat，右侧 Git/Files/Context，底部 Terminal 可展开；左右栏与 Terminal 可调尺寸；切换 Workspace 后四区数据归属一致；Light/Dark 层级清楚；布局与 OpenChamber 架构对齐（不要求色调一致）。
- 能在当前 Workspace 新建 Claude Session；发送用户消息；流式显示 Assistant Text；显示 Thinking；显示 Tool Call/Result；在气泡中处理 Permission；能 Stop；能 Resume；应用重启后能找到历史 Session；运行错误不清空已产生消息；不依赖 PTY 输出解析生成气泡。
- 使用 Node 24；UI 可见实际 Node 路径与版本；真实加密工作区文件工具可用；打包应用通过验证；退出无孤儿 Host/CLI 进程。
- Git 状态来自真实当前 Workspace；Files 可打开编辑；Terminal 可用；Worktree 创建/选择/使用不因新 UI 丢失；其他 Agent 至少保留可用旧入口。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` 通过；Runtime Protocol 与 Chat Reducer 有测试；真实 TSD 环境回归通过；Windows 打包版回归通过。

## 14. 术语

领域术语定义见仓库根 `CONTEXT.md`（运行时 / 导航与工作单元 / 数据层 / 视觉与主题 / 对话领域对象）。本 ARD 不在正文重复定义，仅引用。

