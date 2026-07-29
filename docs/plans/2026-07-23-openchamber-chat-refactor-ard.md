# OpenChamber 布局对齐的气泡对话重构 — 架构需求文档（ARD）

> 文档日期：2026-07-23
> 修订日期：2026-07-28（用户拍板：撤销 D6 / D15，新增 D18 / D19 / D20；§1 / §3 / §4 / §5.1 / §6 / §7 / §8 / §9 / §11 / §12 / §13 / §14 连带改口。历史编号保留可追溯，详见 `docs/plans/openchamber-chat-refactor-ledger.md`）
> 二次修订：2026-07-28 落库后独立审查（事实与范围更正，不动任何决策）——§4 / §7 / §13 的「Rail 圆点」收窄为 **git-only**，§7 的「全仓唯一 Tailwind 原色硬编码」更正为**新壳 chat 链路上的运行态硬编码**（全仓实测 134 处 / 47 文件，旧模块另立 T-25），§7 补 **参考版本冻结**（`openchamber a3519141`）。更正原文见总台账「已拍板决策」表下的补注
> 三次修订：2026-07-28 minor 收口（仍不动任何决策）——① §7 / §3 的色相表述收窄为「**中性与品牌梯度**锁在单一色相、缺**品牌强调色**」，状态三色 `--success` / `--warning` / `--info` 是真彩色只是亮暗同值（`globals.css:80-85` / `:110-115`）；② §4 / §9 / §13 标注「surface 单选」是 **ai-client 的 MVP 简化**，参考实现为 `tabs` + `activeTabId` 的多标签模型；③ §9 MVP 矩阵删掉 Tool 行里重复的「Question 卡」；④ §13 补**全等宽字体**验收（对齐 T-21 验收④）；⑤ 本修订头的改动章节清单补 §12 / §14
> 文档状态：ARD，已与用户达成共识，待按 Phase 0 验证后进入实施
> 关系：取代 `docs/plans/2026-07-23-openchamber-ui-chat-refactor-feasibility.md` 中与本文冲突的条款；取代 `PROGRESS.md`「OpenChamber UI/功能对齐」主线中「拷贝 OpenChamber UI+sync/store + 升级 Electron + 放弃 Worktree + 丢掉 Ghostty」的方向
> 术语表：见仓库根 `CONTEXT.md`
> 实施台账：见 `docs/plans/openchamber-chat-refactor-ledger.md`（每完成关键节点更新）
> 目标项目：AiClient（`D:\Code\projects\ai-client`）

## 1. 一句话定义

保留 AiClient 现有 Electron 工程内核（Git、文件、终端、远程、Worktree、Settings、打包链），重构 Renderer 产品外壳为**对齐 OpenChamber 的三列 + 导轨工作台**（Sidebar / Main-Chat / ContextPanel + 44px surface 导轨，**无底部面板**），并**在观感层一并对齐**——Flexoki 主题 + 全等宽字体 + OpenChamber 的卡片与工具行形态（2026-07-28 用户拍板，见 D18 / D19；原「不要求色调风格严格一致、沿用现有设计系统」口径已作废）。以独立白名单 Node 24 进程运行 Cometix + Claude 能力，吐结构化 Runtime Event 驱动自建气泡对话。不拷贝 OpenChamber 源码，不升级 Electron，不放弃 Worktree。

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
| D6 | 视觉 | ~~对齐 OpenChamber 的是 UI 架构与布局，非色调风格严格一致；沿用现有设计系统；Flexoki 仅作可选后续主题~~ **已被 D18 撤销（2026-07-28）**：对齐 OpenChamber 观感 = **Flexoki 主题 + 全等宽字体 + 卡片形态**三者一并对齐。详见 §7 与总台账 D18 |
| D15 | 右栏 | ~~MVP 做单层可折叠右栏 `git \| files \| context`（并排挤宽，不替换 Chat 页）；内层 ContextPanel 双层结构后置~~ **已被 D19 撤销（2026-07-28）**：改为 **ContextPanel（380–1400，surface 单选，可提升为覆盖 Main 全视图）+ 44px 图标导轨**的 surface 模型，**废弃底部 Dock**。详见 §4 与总台账 D19 |
| D8 | Cometix 分发 | 作为 npm 依赖打包进 Agent Host，固定一个验证过的 release，零安装 |
| D9 | Host 驱动 | Phase 0 同时实测 ① Agent SDK（经 Cometix `cli.js`，必要时套 node wrapper）② 直接 `--output-format stream-json`，按可执行性 + resume/abort/permission 支持度选一条，另一条留 fallback |
| D10 | 其他 Agent | 本轮保留终端模式，只有 Claude 进气泡对话 |
| D11 | 历史持久化 | MVP：Host 读 CC 自己的会话 JSONL（`~/.claude/projects/`，加密，Host 在白名单 Node 上可读），resume 时重放成 Runtime Events；本地只存索引；快照兜底后置 |
| D12 | 权限/提问 UI | 对话时间线内卡片（PermissionCard/QuestionCard），不只靠全局弹窗 |
| D14 | MVP 范围 | 见 §9；#1 文件引用进 MVP；#2 Effort/Plan/Build 进 MVP 但条件性（Runtime 不支持则隐藏/禁用）；#3 Diff 专用卡后置 |
| D18 | 视觉（撤销 D6） | 对齐 OpenChamber 观感 = **Flexoki 主题 + 全等宽字体 + 卡片形态**一并对齐。主题 Flexoki Light/Dark（亮 bg `#fffdf4` / fg `#100F0F` / primary `#BC5215`；暗 bg `#171515` / fg `#CECDC3` / primary `#DA702C`）；新增 `--accent-primary` / `--selection` / `--hover` / `--status-running`；sans/mono/heading 统一 `ui-monospace`。依据：现有语义 token 的中性与品牌梯度锁在色相 285.82、缺品牌强调色（状态三色有彩度但亮暗同值；表述见 §7，2026-07-28 三次修订收窄） |
| D19 | 布局骨架（撤销 D15） | **三列 + 44px 图标导轨，无底部面板**。Sidebar 280（可拖 280–500）/ Main-Chat（阅读栏 `min(100%, 48rem)` 居中）/ ContextPanel（380–1400，surface 单选——**ai-client 的 MVP 简化**，参考实现为多标签模型，见 §4）/ Rail 44。终端 = `terminal` surface，不是底部 Dock。依据：OpenChamber `MainLayout.tsx:407-464`、`ContextPanelRail.tsx:157`、`lib/surfaces/registry.ts`（11 种 surface） |
| D20 | 问答归宿 | 问答卡**保留「就地冻结」**，不照搬 OpenChamber「回答后消失」——**登记为有据可依的偏离**。原因：`HistoryBlock` 无 question/permission（`shared/types/sessionHistory.ts:11-30`），历史重放必 `return null`（`stores/chatSessions.ts:236-237`），照搬会让回答完全无痕。解除前置 = 扩协议 + Host 写历史（C-17，后置） |

## 4. 目标产品结构

按 OpenChamber **实际源码骨架**对齐（2026-07-28 D19 重画；原四区图含底部终端 Dock，已作废）：

```text
┌──────────────┬────────────────────────────────────────────┬────────────────────────┬──────┐
│ Sidebar      │ Main（Chat 常驻）                          │ ContextPanel           │ Rail │
│ 默认 280     │ 顶栏 会话标题 / Project / 用量环 / 窗口    │ min 380 / max 1400     │ 44   │
│ 可拖 280-500 │      Host / 布局 / 右栏开关                │ 默认按 surface 取比例  │ 固定 │
│              │                                            │                        │      │
│ [菜单][折叠] │   ┌ 阅读栏 min(100%,48rem) 居中 ───────┐   │ 当前 surface（单选）   │ ▣    │
│ ──────────   │   │ 消息时间线                         │   │  editor / git / pr     │ ▣•   │
│ 操作行/搜索  │   │ user / assistant                   │   │  diff / terminal       │ ▣    │
│              │   │ tool 行 / thinking                 │   │  plan / notes          │ ▣    │
│ recent       │   │ question / permission              │   │  context / browser     │ ▣    │
│  └ Session   │   └────────────────────────────────────┘   │  preview / chat        │ ▣    │
│ test1        │   ┌ Composer（同栏宽） ────────────────┐   │                        │ ⋮    │
│  └ Session   │   │ @文件 /指令 · 模型 · 发送          │   │ 任一 surface 可提升为  │      │
│              │   └────────────────────────────────────┘   │ 覆盖 Main 的全视图     │      │
│ ──────────   │                                            │                        │      │
│ 设置/帮助    │   宽模式阅读栏 64rem                       │ 收起时本列宽 0         │      │
└──────────────┴────────────────────────────────────────────┴────────────────────────┴──────┘
```

尺寸与形态均取自 OpenChamber 源码（冻结版本见 §7「参考版本冻结」）：`packages/ui/src/components/layout/MainLayout.tsx:407-464`（三列骨架）、`ContextPanelRail.tsx:157`（固定 `w-11` = 44px，图标可拖拽排序）、`ContextPanelRail.tsx:166`（**只有 `git` surface 在有变更文件时亮圆点**：`showActivityDot={surface.id === 'git' && changedFilesCount > 0}`）、`ContextPanelRail.tsx:82`（圆点本体 `h-1.5 w-1.5` = 6px，色值 `var(--status-info)`）、`lib/surfaces/registry.ts`（11 种 surface）。

**没有底部面板**：终端是 ContextPanel 的一种 surface（`terminal`），也可提升为覆盖 Main 的全视图，不是 Bottom Dock。

要点：

- **左列 Sidebar**：独立全高，默认 280、可拖 280–500。
  - **顶部**：`[菜单][侧栏折叠]`。
  - **中部**：操作行（新建等）、搜索/筛选，`recent` + 按 Project（如 `test1`）挂 Session 的列表。
  - **底部**：设置 / 帮助 / 关于。
- **中列 Main**：顶栏（会话标题主标 + Project 名副标、用量环、Host、布局、右栏开关、OS 窗口控件）+ Chat 常驻。消息时间线与 Composer 共用一条**阅读栏**：`width: min(100%, 48rem)` 居中，宽模式 64rem。
- **右列 ContextPanel**：min 380 / max 1400，默认宽度按 surface 类型取可用宽度比例；**同一时刻只显示一种 surface**；任一 surface 可提升为覆盖 Main 的全视图。
  - **「surface 单选」是 ai-client 的 MVP 简化，不是 OpenChamber 形态**（2026-07-28 三次修订标注）。参考实现是 **`panelState.tabs` + `activeTabId` 的多标签模型**：多个 surface 可同时驻留为 tab、只有一个 active，Rail 点击 = 「打开或激活该 mode 最近的 tab」（若该 mode 已是 active 则收起整个面板），**不是互斥替换**。证据：`packages/ui/src/components/layout/ContextPanel.tsx:2240-2241`（`tabs` / `activeTab` 派生）、`packages/ui/src/stores/useUIStore.ts:1092-1125`（`openContextSurface` 全文）、`ContextPanelRail.tsx:169`（`onSelect` → `openContextSurface`）。**后续若补齐多标签，属功能扩展，不构成「推翻对齐」**——不要再以「对齐 OpenChamber」为由反复推翻本轮的单选简化。
- **最右 Rail（图标导轨）**：固定 44px（OpenChamber `w-11`），图标可拖拽排序；**`git` surface 在有变更文件时右上角亮 6px 圆点**（`var(--status-info)`），**其余 surface 参考实现未做内容指示**——ai-client 若要给别的 surface 加圆点属自主扩展，须先各自定义「有内容」的判据。
- **surface 注册表**：OpenChamber 注册 11 种——`editor / git / pr / diff / terminal / plan / notes / context / browser / preview / chat`。**终端是其中一种 surface，不是底部 Dock。**
- **没有底部面板**：原 ARD 图中的 Bottom Terminal Dock 随 D19 废弃；`WorkspaceShell.tsx:31-32` 的硬编码 RightDock 320 / BottomDock 220 一并作废。

MVP 对齐策略（2026-07-28 D19 改写）：三列 + 导轨骨架与上述尺寸为 MVP 硬性；surface 本轮先落 `chat / editor / git / terminal / context` 五种，其余 6 种保留注册位后置；Sidebar 与 ContextPanel 均须可拖拽（现状不可拖是缺陷，见 T-22），Rail 的拖拽排序可后置，但 44px 宽度属 MVP；圆点只做 `git` surface 的变更文件指示（照参考实现），其余 surface 不做。

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
  Workspace Shell | Chat UI | ContextPanel(surfaces) | ContextPanelRail
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

> 2026-07-28（D19 连带）：Renderer 层原「`Git/Files/Context | Terminal Dock`」改为「`ContextPanel(surfaces) | ContextPanelRail`」——Git / editor / context / terminal 全部是 ContextPanel 的 surface，**不再有底部 Dock**。

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

> **历史协议缺口（2026-07-28，D20 登记）**：`src/shared/types/sessionHistory.ts:11-30` 的 `HistoryBlock` 联合类型只有 `text | thinking | tool_call | tool_result`，**没有 question / permission**。因此历史重放时问答块必然 `return null`（`src/renderer/stores/chatSessions.ts:236-237`）。这正是 ai-client **不**照搬 OpenChamber「问答卡回答后消失」（`QuestionCard.tsx:321-323` / `PermissionCard.tsx:121-123` + `ToolPart.tsx:1667-1730` 历史重渲染）而保留「就地冻结」的直接原因。解除前置 = 扩 `HistoryBlock` + Host 把问答写进历史（**C-17**，后置）。在此之前，「Permission/Question 只能响应一次、收到终态冻结该 Block」的既有规则继续有效，且**冻结态必须在时间线上原地保留可见**。

## 7. 视觉与布局策略

> 2026-07-28 用户拍板后整节重写（D18 撤销 D6、D19 撤销 D15）。原「对齐架构与布局不对齐色调 / 沿用现有 OKLCH 语义 token / Flexoki 仅作可选后续」口径**全部作废**。

- **对齐目标 = 架构 + 布局 + 观感**：三列 + 44px 导轨骨架、surface 模型、对话时间线 / 工具行 / 问答卡的交互结构，**以及色调与字体**。
- **主题 = Flexoki Light/Dark**（OpenChamber 的默认主题）：亮 bg `#fffdf4` / fg `#100F0F` / primary `#BC5215`；暗 bg `#171515` / fg `#CECDC3` / primary `#DA702C`。以 OKLCH 语义 token 表达，落进 `src/renderer/styles/globals.css`。
- **现有配色为何不能沿用**（实证；2026-07-28 三次修订收窄表述）：**中性与品牌梯度**整体锁在色相 285.82——`--accent` / `--muted` / `--secondary` 三者色值完全相同（亮 `oklch(0.965 0.003 285.82)`、暗 `oklch(0.269 0.014 285.82)`）；`--primary` 是中性反色而非品牌色（亮 `oklch(0.205 0.014 285.82)` 近黑、暗 `oklch(0.985 0 0)` 近白），因此满屏 `text-primary` 实为「最高对比度正文色」。**状态色不在此列**：`--success` `oklch(0.527 0.154 150.07)` / `--warning` `oklch(0.769 0.189 70.08)` / `--info` `oklch(0.623 0.214 259.81)` 既不在 285.82 色相、彩度也在 0.15–0.21，**是真彩色**；问题在于三者**亮暗逐字同值**（`src/renderer/styles/globals.css:80-85` 亮 / `:110-115` 暗），只能表状态、撑不起品牌调性（`--destructive` 亮暗有别，但同样只是危险色）。**所以缺的是品牌强调色，不是「一点彩色都没有」**——靠现有 token 对不出 OpenChamber 观感。
- **需新增的 token**：`--accent-primary` / `--selection` / `--hover` / `--status-running`。其中 `--status-running` 用于替换**新壳 chat 时间线上的运行态硬编码**——`src/renderer/components/chat/MessageTimeline.tsx:419` 的 `bg-amber-500`（Thinking 折叠头的运行指示点）。**注意范围**（2026-07-28 复核实测）：这不是全仓唯一的原色硬编码。`bg-amber-500` 在 `src/renderer` 共 5 处（另有 `chat/HostStatusBanner.tsx:55`、`todo/TaskCard.tsx:16`、`ui/activity-indicator.tsx:21`、`ui/glow-card.tsx:123`）；`(bg|text|border|…)-(amber|red|green|blue|…)-NNN` 形态的原色工具类在 `src/renderer` 共 **134 处 / 47 文件**，主要集中在 `source-control/`、`layout/`、`ui/`、`settings/` 等旧模块。T-21 只负责 chat / workspace-shell 两个目录，旧模块清理另立 **T-25**。
- **字体 = 全等宽**：sans / mono / heading 三者统一为 `ui-monospace`（OpenChamber 就是全等宽 UI）。**已知代价**：中文会回退系统字体，中英混排的宽度节奏需实测（见 plantree open-questions #10）。
- **根字号差异**：ai-client 现为 `html { font-size: 14px }`（`src/renderer/styles/globals.css:63,149`），OpenChamber 用浏览器默认 16px。后果是全仓 rem 实际值 ×14/16——`--radius: 0.5rem` 真实是 7px 而非 8px。改不改、影响面多大，单列未决（open-questions #11）。
- **本条未裁定的边界**：`monacoTheme.ts` 跟随 Ghostty、`resources/ghostty-themes/` 的 438 终端主题两项，D18 未涉及，去留待单独裁定（open-questions #12）。在裁定前**原样不动**。
- **产物基线**：`docs/design/phase0a-openchamber-alignment.html`（A01 / A05 / A06 的统一产物，2026-07-28 用户已验收）。业务组件不得自行发明视觉值。
- **参考版本冻结（A01 补回，2026-07-28）**：本 ARD 与 D18 / D19 / D20、T-05 / T-21 / T-22 引用的全部 openchamber `file:line` 证据，一律以 **`openchamber` commit `a3519141635990e3d75d79a7f902f8aa15386060`（`git describe` = `v1.17.0-6-ga3519141`，取证日期 2026-07-28，工作树 `/home/dan/projects/openchamber`，取证时无未提交改动）** 为准。该仓是活动工作树、会继续往前走，**跨版本核对前必须先 `git checkout a3519141`**，否则行号必然对不上。Light/Dark 基准 = Flexoki Light / Flexoki Dark（OpenChamber 默认主题对）。**标准窗口尺寸未冻结**：本轮裁定只用到相对尺寸（Sidebar 280–500 / ContextPanel 380–1400 / Rail 44 / 阅读栏 48rem·64rem），全部与窗口宽度无关，故不需要固定窗口尺寸基准；将来若要比对截图级布局，须补测并回填本条。

## 8. 现有模块迁移策略

**保留不动**：`src/main/services/git/`、文件读写/监听、xterm.js + node-pty、RemoteConnectionManager、Worktree 管理、Monaco Editor、Settings 基础设施、Electron Main/Preload 安全边界、构建/更新/打包链、`tsdSafeRead.ts` 与系统 Node 读取经验、`ClaudeSessionScanner` 的 `~/.claude/projects/` 扫描能力。

**改造**：
- `src/renderer/App.tsx`：逐步抽出 Workspace Shell / Sidebar / Main Area / ContextPanel / Rail / Dialog Host，最终只做顶层装配。**注意**（2026-07-28）：`App.tsx:450` 的 `SKIP_ONBOARDING_GATE || useOpenChamberShellSetting` 短路与 `src/renderer/Root.tsx:52-59` 在 persist 水合完成后强行 `setUseOpenChamberShell(true)`，两处共同锁死新壳、使 Appearance 开关形同虚设——恢复可逆性必须同时改（T-16 前置）。
- `src/renderer/components/layout/MainContent.tsx`：Chat 常驻中央；Git / Files(editor) / Context / Terminal **全部改为 ContextPanel 的 surface**（D19），**不再有底部 Dock**；Settings 独立入口。
- `src/renderer/components/chat/AgentPanel.tsx`：Claude 主路径由新 Chat Workspace 替换；AgentTerminal 不再渲染 Claude 主会话；EnhancedInput 有价值能力迁入新 Composer；旧 AgentPanel 暂留其他 CLI Agent。
- `src/renderer/stores/agentSessions.ts`：不扩展承载结构化消息；新建独立 Chat Store；通过 Workspace ID/Path 关联。

**新增（边界，文件名实施时可调）**：
```text
src/main/services/agent-host/   AgentHostManager / Process / NodeRuntimeResolver / Protocol / Diagnostics
src/main/ipc/chat.ts
src/agent-host/                  index / protocol / claudeRuntime / eventNormalizer / sessionRegistry
src/shared/types/                 chat.ts / agentHost.ts / runtimeEvents.ts
src/renderer/components/workspace-shell/  Shell / Sidebar / ContextPanel / ContextPanelRail / surfaces/
src/renderer/components/chat/     ChatWorkspace / MessageTimeline / ChatComposer / blocks/ / cards/
src/renderer/stores/chatSessions.ts
```

> 2026-07-28（D19）：`workspace-shell` 一行由原 `Shell / LeftNav / RightDock / BottomDock` 改写为上表；`RightDock / BottomDock` 命名随 D19 作废，`BottomDock.tsx` 直接删除，不保留占位。

**清理**：回退 `17b8cce` 孤立的 `src/renderer/components/ai-chat/`（17 文件，未接线，假 `setTimeout` 响应）；保留 `src/shared/types/ai-chat.ts` 类型并接入导出。

## 9. MVP 范围与功能矩阵

| 能力 | MVP | 后置 | 说明 |
|---|:---:|:---:|---|
| 三列 + 44px 导轨外壳（OpenChamber 布局） | ✅ | | 架构、布局与观感一并对齐（D18 / D19）；原「四区外壳」口径作废 |
| Flexoki 主题 + 全等宽字体（OKLCH 表达） | ✅ | | 替代原「沿用现有 OKLCH 设计系统」；方案见 A05，代码落地见 T-21 |
| 终端 438 Ghostty 主题 | ✅ | | 原样不动；与应用壳主题的边界待单独裁定（open-questions #12） |
| Project/Workspace/Session 树 | ✅ | | 新建/选择/重命名/关闭/Resume/状态徽标 |
| 新建 Session + 发送 + 流式文本 + Markdown | ✅ | | 结构化事件驱动 |
| Thinking 折叠 | ✅ | | |
| Tool 行（无边框单行） | ✅ | | 照 OpenChamber 形态；口径见 T-05（2026-07-28 重写） |
| Permission 卡 / Question 卡 | ✅ | | 时间线内卡片（D12 继续有效）；Question 卡形态口径同归 T-05（2026-07-28 三次修订：本表原在 Tool 行重复列了「Question 卡」，已并入本行，问答卡一律以本行为准） |
| 问答卡「就地冻结」（不照搬 OpenChamber 的消失） | ✅ | | D20 登记偏离；解除前置 = 扩 `HistoryBlock` 协议（C-17，后置） |
| Stop / Resume | ✅ | | Resume 走 CC JSONL |
| Model 选择 | ✅ | | 只展示可用模型 |
| Composer 文件/上下文引用 | ✅ | | 与 `editor` surface 联动（原「Files 面板」，D19 改口） |
| Effort/Plan/Build 控件 | ✅* | | 条件性：Runtime 不支持则隐藏/禁用 |
| ContextPanel + surface 模型 | ✅ | | 本轮落 `chat / editor / git / terminal / context` 五种，单列单选、可提升为覆盖 Main 全视图；其余 6 种留注册位后置。**单选 = ai-client MVP 简化**（参考实现是多标签，见 §4） |
| ~~底部 Terminal Dock~~ | — | — | **随 D19 废弃**；终端改为 `terminal` surface（T-15） |
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
~~四区外壳（沿用现有 OKLCH 设计系统）~~ **三列 + 44px 导轨外壳（Flexoki 主题 + 全等宽字体）** + 折叠 / Resize；ContextPanel 容器 + surface 注册表；主要空 / 运行 / 权限状态 Mock。产出：可交互三列壳。
> 注：Phase 1 已于 2026-07-23 按**旧四区口径**完成（`259e863`），其状态不回退；D18 / D19 后的重做归 **T-21**（主题字体）与 **T-22**（壳结构），按新任务计入 Phase 4。

### Phase 2 — Runtime Vertical Slice
Host 协议定义 + 入口 + Runtime Adapter + Event Normalizer + Permission/Question Bridge + Abort 状态机；AgentHostManager + IPC + 事件推送；Chat 类型/Reducer + Sessions Store + 增量批处理；MessageTimeline + Text Bubble + Composer + Stop。闭环：新建→发送→流式→一个 Tool→Stop→idle。

### Phase 3 — Chat MVP
Resume + Session Registry + 诊断；Node/Cometix 设置 + 进程清理；会话索引 + 历史恢复（走 CC JSONL）；Workspace View Model + Tree + Session List + 操作；Header + Thinking + Tool Card + 工具摘要 + Permission/Question Card + 文件引用 + 空错断状态。产出：日常可内部使用。

### Phase 4 — 现有能力重新接线
Git / editor / Context / Terminal 四种 surface 迁入 ContextPanel + Chat 联动；Workspace 终端恢复 + Host 诊断入口；新旧模式开关**可逆性**修复（T-16 的两处硬编码）+ 其他 Agent 终端模式 + 旧会话迁移；新壳「添加仓库」通路补齐（T-24，阻断级）；存量违规清理（T-23）。产出：用户不必在新旧界面切换。

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
- **UI 像不像 OpenChamber 但行为是旧产品**：按完整用户任务验收不按截图；权限/Tool/Stop/Resume 必须进消息时间线；git / editor / terminal 三种 surface 与当前 Workspace 真实联动；不展示未接通的假状态。2026-07-28 A06 矩阵已证伪当前实现（死按钮 + 硬编码 usage 环），清理归 **T-23**。

## 13. MVP 验收标准

- 左列显示 Project / Workspace / Session（默认 280、可拖 280–500）；中列 Chat 常驻，消息时间线与 Composer 共用阅读栏 `min(100%, 48rem)` 居中（宽模式 64rem）；右列 ContextPanel（380–1400，surface 单选——**MVP 简化，参考实现为多标签，见 §4**——可提升为覆盖 Main 全视图）；最右 44px 导轨（图标 + `git` surface 有变更文件时 6px 圆点）；**无底部面板**。切换 Workspace 后三列数据归属一致；Flexoki Light / Dark 层级清楚且 `--primary` 为品牌橙而非中性反色、`--accent` / `--muted` / `--secondary` 不再同值；布局**与观感**均与 OpenChamber 对齐（D18 / D19，不再是「不要求色调一致」）。
- **全等宽字体**（D18 三支柱之三，2026-07-28 三次修订补入）：新壳内 sans / mono / heading 三者的**计算样式实际解析到 `ui-monospace`**（按变量名改完还须在 DevTools computed style 复核，不能只看 CSS 变量定义）；中英混排在**阅读栏、左栏树、工具行**三处无明显节奏崩坏（行高跳动、基线错位、截断异常）。与执行计划 **T-21 验收④** 同一口径，实测截图入台账；中文回退系统字体的已知代价见 open-questions #10。
- 能在当前 Workspace 新建 Claude Session；发送用户消息；流式显示 Assistant Text；显示 Thinking；显示 Tool Call/Result；在气泡中处理 Permission；能 Stop；能 Resume；应用重启后能找到历史 Session；运行错误不清空已产生消息；不依赖 PTY 输出解析生成气泡。
- 使用 Node 24；UI 可见实际 Node 路径与版本；真实加密工作区文件工具可用；打包应用通过验证；退出无孤儿 Host/CLI 进程。
- Git 状态来自真实当前 Workspace（`git` surface）；文件可打开编辑（`editor` surface）；终端可用（`terminal` surface）；Worktree 创建/选择/使用不因新 UI 丢失；其他 Agent 至少保留可用旧入口。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` 通过；Runtime Protocol 与 Chat Reducer 有测试；真实 TSD 环境回归通过；Windows 打包版回归通过。

## 14. 术语

领域术语定义见仓库根 `CONTEXT.md`（运行时 / 导航与工作单元 / **工作台布局**：surface·ContextPanel·ContextPanelRail·阅读栏 / 视觉与主题 / 数据层 / 对话领域对象）。本 ARD 不在正文重复定义，仅引用。`CONTEXT.md` 已于 2026-07-28 同步 D18 / D19 口径（原 D6 口径已删除）。

