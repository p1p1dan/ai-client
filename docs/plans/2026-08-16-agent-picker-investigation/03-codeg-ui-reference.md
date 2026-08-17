# D48 调查 03 — codeg 三块 UI 参照形态

> 2026-08-16，阶段 3（D48）调查轮第 3 篇。只读调查参照仓 `/home/dan/projects/codeg`（Tauri：Next.js+React 前端 / Rust 后端，12 agent 经 ACP）。
> 用途 = 用户认可形态的事实参照，不是抄袭对象——我们直连（D45）无 ACP config_options 通道，映射时须换轴。

## 1. Agent 选择入口

**组件**：`src/components/chat/agent-selector.tsx`（258 行 `AgentSelector`）。

- 形态 = **横向分段胶囊（segmented pill）+ 滑动指示器**，非下拉/图标网格；未选中项只显图标，选中项图标+label（grid-template-columns 折叠动画）。
- 只渲染 `enabled` 的 agent（未启用完全不渲染，非置灰）。
- **可用性三态**：可用未安装 → 图标右上角**琥珀色圆点**（:199-236）+ tooltip `"${label} · Not installed"`（`en.json:2647`）；完全不可用 → 整体 `opacity-40` 禁点；全部未启用 → 虚线框空态 + "openAgentsSettings" 跳设置按钮（:165-180，`en.json:2643-2647`）。
- Props 区分 `onSelect`（用户点击）与 `onFallback`（默认 agent 失效时组件自动回退），调用方分别处理。

**绑定语义（与 D48 ② 拍板同构）**：`conversation-detail-panel.tsx:298` `selectedAgent = conversationId != null ? agentType : draftAgentType`——**落库即锁定**；AgentSelector `disabled={isConnecting || dbConversationId != null}`（:1706-1739 welcome 模式 / :1802-1845 draft header 模式两处渲染）。

**已锁定会话的 agent 展示**：侧栏卡片 = 纯小图标 0.75rem + 状态点（`sidebar-conversation-card.tsx:298-306`）；会话详情 = 图标+label chip（`session-details-content.tsx:305-313`）;composer 连接状态正文**不显示** agent 图标/label，只进原生 title tooltip（`composer-connection-status.tsx:56,82-88`）。

**未安装 agent 的会话前处理**：草稿态跳过自动连接（`canAutoConnect` :514-523）；持续显示"请安装"提示条（`composerBlockedMessage` :665-674）；切换时 conn 状态显 disconnected/connecting（:635-644）。

## 2. 模型/思考档按 agent 适配

**选择器三套并存按列表长度选用**：`InlineModeSelector`（`mode-selector.tsx`，Radix DropdownMenu RadioGroup，ACP modes 通道）；`InlineSessionConfigSelector`（`session-config-selector.tsx`，短列表）；`ModelOptionPicker/List`（`model-option-picker.tsx`+`model-option-list.tsx`，Popover + virtua 虚拟化 + 搜索，长模型列表；:32-40 注释刻意避开 Radix menu/cmdk 的 WebKit 滚动/点击 bug）。窄 composer 折叠为 Cog/AgentIcon Popover 里的 master-detail 面板（`session-selectors-panel.tsx`；:53-63 注释：Popover 内嵌第二层 Radix dismissable layer 在 WKWebView 静默丢选择）。

**目录来源 = 会话回包，非前端静态表**：ACP `session/new` 回包 `config_options`（`connection.rs:1487-1527` 映射）；换 agent = 新连接 = 新 `session/new` → 列表随回包整体刷新。Codex 目录另有本地 catalog 文件（`bundled-catalog.json`，`{models:[{slug, display_name, default_reasoning_level, supported_reasoning_levels[], ...}]}`），可在 Settings 编辑（`codex-model-list-editor.tsx:149-154/:608-615`）。

**分组**：`model-config-groups.ts` — `isModelConfigOption()`（:16-21，`id==='model' || category==='model'`）；`deriveModelGroups()`（:117+）按 value 首个 "/" 切 provider 分组。

**effort 表达无统一答案，随 agent**：Grok = 独立两字段（合成两个 config option：`model` + `reasoning_effort`，`connection.rs:1625/:1632/:1824-1936`，非标 `_meta["x.ai/sessionConfig"]`）；Codex = `default_reasoning_level` 是 catalog 条目属性（一 slug 绑一默认档），**只在 Settings 配置，非会话内实时切**。

**默认值 = per-agent localStorage 偏好 + 连接时服务端预应用**：`selector-prefs-storage.ts`（key `codeg:selector-prefs`，按 agentType 存 modeId/configValues）；`acp_connect` 时传给后端，后端在初始事件发出**之前**就把偏好 `set_session_mode`/`set_session_config_option` 落到 agent（`connection.rs:4755-4810`）——无「客户端拦事件再覆盖」路径。

## 3. 权限模式管理面（三层 + 单次审批第四概念）

| Agent | 实时 composer 通道 | 中途能改 | Settings 面板控件 | 生效时机 |
|---|---|---|---|---|
| Claude Code | (a) ACP `modes` → `session/set_mode`（default/plan/acceptEdits/bypassPermissions） | **能** | 无结构化面板 | — |
| Codex | (b) config_options "mode" 三档简化（read-only/agent/agent-full-access，`ensure_codex_mode_option` 兜底合成 `connection.rs:1538-1597`） | 能（仅普通 prompt） | approval_policy 四值（含 granular 五键）+ sandbox_mode 三值（`acp-agent-settings.tsx:1650-1685`） | 线程默认，重启/新线程生效 |
| Grok | 无 | 不能 | permission_mode 启动 flag `--permission-mode`（`connection.rs:768-786`，注释明写无 ACP modes 通道） | 重连生效 |
| Cursor | 无 | 不能 | Ask/Run-Everything 二值启动 flag（`en.json:698-703`） | 重连生效 |

- (a)(b) 互斥：`message-input.tsx:968-992` `showModeSelector = hasModes && effectiveModeId && !hasConfigOptions`——有任何 config_options 就藏 mode selector。
- Settings 的 `sandboxGroupHint` 文案明确区分「线程默认值 vs composer 实时 Approval Preset」（`en.json:742-758`）。
- **(d) 单次工具审批**是完全独立概念：`permission-dialog.tsx`（321 行），选项按钮 = `permission.options[]`（reject 判 `kind.startsWith("reject")` :305）；codex ≥1.1.8 / claude ≥0.64.1 时显示 `_meta.permission.changes`（授权变化 + duration/scope 徽章，六 scope :43-50）。

## 4. 布局关系与完整选择流

- 三块实时控件全在 **composer 工具栏**，container query `@[30rem]` 切内联/折叠两形态（`message-input.tsx:3728-3793`；内联项组装 :2919-2959）；权限 Settings 面板物理分离（全局设置表单）；PermissionDialog 在消息流内。
- 完整流：草稿态（无 dbConversationId）→ WelcomeHero + 居中 AgentSelector（可切）→ 未安装则 blocked 提示 + 跳过自动连接 → 模型/mode 选择来自已连接 agent 的 session/new 回包 → 首条消息落库 → AgentSelector disabled，agent 身份降为图标级指示（侧栏图标/详情 chip/折叠 Popover 触发图标/状态 tooltip）→ 用户选择按 agentType 存 localStorage，下次连接预应用。

## 5. 与本仓直连架构的映射注记（事实性差异，非设计）

- codeg 的模型/mode 目录是 **ACP 会话回包驱动**；本仓直连无此通道——Claude 轴是静态 3 短名表（调查 01 §2），Codex 轴 `model/list` 有 per-model `supportedReasoningEfforts` 但本仓从未读取（调查 01 §4）。「目录从会话回包来」这条 codeg 机制在直连下的等价物 = 启动/初始化时主动调 `model/list`（Codex）与静态表（Claude），仍答不出 cch 代理实况（调查 01 §5/§6）。
- codeg Claude 轴「会话中途改权限档」走 ACP `session/set_mode`；本仓等价物 = SDK `Query.setPermissionMode()`（存在但未接入、streaming-input 前提未证，调查 02 §2）。codeg Codex 轴实时三档是 **codeg 自己兜底合成的简化面**，不是 codex 协议原生——本仓等价物候选 = `turn/start` sticky 字段或 `thread/settings/update`（均未实证，调查 02 §3）。
- codeg「零回合可选、落库锁定」与 D48 ② 拍板完全同构，含 fallback 语义（默认 agent 不可用时自动回退 + 区分用户主动选择）。
