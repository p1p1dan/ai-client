# OpenChamber 高保真 UI 对齐与气泡对话重构完整计划

> 文档日期：2026-07-23
> 文档状态：主路线已确认，待按高保真 UI 与 Runtime 双轨实施
> 参考产品：OpenChamber
> 目标项目：AiClient
> 核心范围：OpenChamber 高保真 UI 对齐、结构化气泡对话
> 运行约束：TEC/OCular/TSD 加密环境；Claude 执行链必须使用可被白名单识别的 Node.js，目标 Cometix 版本需要 Node 24

## 1. 结论

本次重构应定义为：

> **保留 AiClient 现有 Electron、Git、文件、终端、远程连接和 Worktree 产品内核，重构 Renderer 产品外壳，并以 `@anthropic-ai/claude-agent-sdk + @cometix/claude-code` 建立新的结构化 Agent 对话内核。**

它不是 AiClient 全产品重写，也不是把 OpenChamber 源码或 OpenCode 运行时整体搬入 AiClient。

推荐路线是：

1. 在现有 AiClient 基础上重构 UI 外观和布局，不以 OpenChamber 为新代码底座。
2. 将当前 `AgentPanel -> AgentTerminal -> CLI PTY` 的主要 Claude 使用路径替换为结构化气泡对话。
3. 保留独立终端能力，但终端从“Claude 对话载体”降为工作辅助工具，放入底部 Terminal Dock。
4. 由独立的白名单 Node 24 进程运行 Claude Agent SDK 和 Cometix Claude Code，Electron 仅负责生命周期、IPC 和 UI。
5. 第一阶段只要求 Claude 进入结构化气泡模式；其他 Agent 可以暂时继续使用当前终端模式，待后续按需迁移。
6. OpenChamber 是 UI 外观、布局、区域比例、按钮位置、信息层级和关键交互状态的高保真参考真源，但不作为代码底座，不复制其 OpenCode SDK、sync/store、Web/PWA、云同步和完整生态。
7. UI 与 Runtime 双轨推进：UI 使用 Mock Event 先稳定高保真产品壳，Runtime 独立验证 Node 24、Claude Agent SDK 和 Cometix，最终在 Chat Domain Model 汇合。
8. 尚未接通的功能允许禁用、隐藏或明确标注后置；不得为了功能未完成而改变 OpenChamber 的关键布局，也不得把占位状态伪装成真实能力。
9. 不把 OpenCode Node `next` 预览版、Bun 或 OpenCode 原生二进制作为正式运行依赖；旧 Claude 终端模式仅作为开发期回退。

在当前已知范围下：

- Node 24 + TSD 技术原型：约 5～8 人日；
- 高保真 UI Shell 可交互原型：约 10～18 人日；
- 可供内部使用的 UI + 气泡对话 MVP：约 30～50 人日；
- 完整、打磨后的正式版本：约 45～70 人日；
- 单名开发者：约 9～15 周；
- 两名熟悉项目的开发者：约 5～8 周。

上述估算不包含完整复制 OpenChamber 产品生态，也不包含所有现有 Agent 同时迁移为结构化对话。

---

## 2. 用户真实目标

本轮目标只收敛为两项。

### 2.1 UI 外观和布局

将 AiClient 当前以仓库、Worktree 和功能 Tab 为主的产品外壳，调整为与指定版本 OpenChamber 高保真对齐的桌面工作台：

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 标题栏 / 当前项目 / 当前 Workspace / 全局操作                       │
├──────────────────┬────────────────────────────┬──────────────────────┤
│                  │                            │                      │
│ Project          │                            │ Git                  │
│ Workspace        │        Bubble Chat         │ Files                │
│ Session          │                            │ Context              │
│                  │                            │                      │
│ 左侧会话导航     │ 中央主要工作区             │ 右侧辅助工作区       │
├──────────────────┴────────────────────────────┴──────────────────────┤
│ Bottom Terminal Dock：可展开、折叠、调整高度                         │
└──────────────────────────────────────────────────────────────────────┘
```

目标不是复制 OpenChamber 源码，而是把 OpenChamber 的实际界面作为 UI 验收基准。优先对齐：

- 整体窗口结构、标题栏、左中右下区域关系和默认比例；
- Project / Workspace / Session 的层级、行高、缩进、状态和操作位置；
- Chat Header、消息时间线、Composer 的控件层级和按钮顺序；
- Git / Files / Context Tab、工具栏和折叠按钮布局；
- Bottom Terminal Dock 的标题栏、控制按钮、展开和调整高度行为；
- 暖色、中性、低对比但层级明确的 Flexoki 类视觉语言；
- 字体、间距、圆角、边框、Hover、Selected、Focus、Disabled 和运行状态；
- 会话、工具调用、权限请求和运行状态在同一条对话时间线中的表现；
- 窄窗口下仍保持 Chat 主路径可用的必要降级布局。

允许因 Electron、Windows 原生窗口机制、AiClient 现有能力和无障碍要求产生必要差异，但不得仅以“类似风格”替代实际布局、区域比例和按钮位置对齐。

### 2.2 对话形式

将当前 Claude CLI 终端交互改为结构化消息流：

- 用户消息气泡；
- Claude 文本回复；
- Thinking/Reasoning 折叠块；
- Tool Call 卡片；
- Tool Result 卡片；
- Permission 权限确认卡片；
- Question/Choice 交互卡片；
- 运行中、等待权限、完成、失败、中止等状态；
- Stop；
- Resume 历史会话；
- Model、Effort、Plan/Build 等与对话直接相关的控制项；
- Markdown、代码块、Diff、文件引用等富文本内容。

关键技术原则：

> **气泡对话必须消费 Claude Agent SDK 的结构化事件，不能继续从 PTY ANSI 文本反向猜测消息、工具和状态。**

---

## 3. 本轮范围

### 3.1 纳入范围

#### UI 与布局

- 与指定 OpenChamber 版本高保真对齐的视觉、布局、区域比例和按钮位置；
- OpenChamber 参考版本、标准窗口尺寸和关键状态截图基线；
- 新的桌面工作台外壳；
- 左侧 Project / Workspace / Session 导航；
- 中央 Chat 主视图；
- 右侧 Git / Files / Context；
- 底部 Terminal Dock；
- 面板折叠、展开和调整尺寸；
- 空状态、加载状态、错误状态和运行状态；
- 现有 Git、文件、终端和 Worktree 能力重新摆放及接线；
- 基本键盘可达性和焦点管理；
- 窗口窄屏下的最低可用降级布局；
- 未接功能的统一禁用、隐藏和后置标记规范。

#### Claude 对话

- `@anthropic-ai/claude-agent-sdk`；
- `@cometix/claude-code` 的 Node 版本；
- 白名单 Node 24 Agent Host；
- 新建会话；
- 发送消息；
- 流式文本；
- Thinking 展示；
- Tool Call/Result 展示；
- Permission 请求与响应；
- Question 请求与响应；
- Stop；
- Resume；
- 会话状态恢复；
- 基础错误恢复；
- 对话历史持久化或从 Claude 会话恢复；
- 模型、思考强度和工作模式等必要参数。

#### 现有能力复用

- Electron Main/Preload；
- GitService；
- FileService；
- `simple-git`；
- xterm.js；
- node-pty；
- RemoteConnectionManager；
- Worktree 管理；
- Settings；
- Monaco Editor；
- 当前构建、更新和打包链；
- 当前 TSD 安全读取经验和系统 `node.exe` 兜底路径。

### 3.2 不纳入本轮

- 复制 OpenChamber 源码或把 AiClient 变成其分支；
- OpenCode SDK 兼容层；
- 模拟 OpenChamber 的完整 sync/store；
- OpenCode 全局事件协议兼容；
- 完整 GitHub-native 工作流；
- Cloudflare Tunnel；
- 跨设备同步；
- Web/PWA/Mobile；
- 云端 Store；
- Voice；
- Mini Chat；
- 多窗口完整形态；
- Browser/Preview 全套 Runtime；
- 完整 MCP/LSP 管理中心对齐；
- 删除或重写现有 Git、文件、终端、远程和 Worktree 内核；
- 所有现有 Agent 一次性改为结构化对话；
- 对 OpenChamber 功能逐项达到 100% 兼容；
- 依赖 OpenCode Node `next` 预览版、Bun 或 OpenCode 原生二进制作为正式运行时。

### 3.3 可选扩展范围

以下内容可以留在任务池中，但不应成为首个可用版本的前置条件：

- 多 Claude 会话并排；
- 同一 Workspace 多 Agent 并行气泡会话；
- Tool Call 过程中的实时子步骤；
- 复杂 Diff 审批；
- 消息分支和重新生成；
- 消息搜索；
- 会话导出；
- 自定义 Slash Commands 面板；
- MCP 状态管理；
- Hooks 管理 UI；
- 浏览器预览；
- 语音输入；
- 多窗口；
- 其他 Agent 的统一结构化协议。

---

## 4. 为什么选择在 AiClient 上重构

### 4.1 推荐方案

推荐：**保留 AiClient 产品内核，在现有工程上重构 Renderer 外壳和 Claude 对话内核。**

原因：

1. AiClient 已具备成熟的 Git、Worktree、文件、Monaco、终端、远程连接、Settings 和 Electron 打包能力。
2. 当前产品的核心资产不是旧 UI，而是已经接通的本地开发工作流和进程生命周期。
3. OpenChamber UI 深度依赖 OpenCode SDK，不是一个可以独立复制的纯展示层；直接 fork 会把 UI 目标与上游 Runtime、sync/store 和多端产品约束绑定在一起。
4. 如果以 OpenChamber 为底座，需要重新接入或重新确认 AiClient 已有的远程连接、Worktree、Settings、更新、打包和企业 TSD 运行边界，扩大长期维护和上游合并成本。
5. 用户需要高保真 OpenChamber 产品形态，但运行内核明确选择 Claude Agent SDK，而不是 OpenCode 兼容本身。
6. AiClient 当前 `App.tsx`、`MainContent.tsx` 和 `AgentPanel.tsx` 已经较大，新结构必须以独立 Workspace Shell、Chat Domain Model 和 Agent Host 模块落地，不能继续把新逻辑堆入旧组件。

### 4.2 不推荐方案：直接在 OpenChamber 上重构

OpenChamber 的 UI 数据不仅来自事件流，还依赖完整 OpenCode SDK 能力，例如：

- `project.list/current`；
- `session.status/get/messages`；
- `command.list`；
- `mcp.status`；
- `lsp.status`；
- `vcs.get`；
- permission/question API；
- 全局事件流和 reducer。

直接使用其 UI，会迫使项目实现一个“伪 OpenCode Client”，或重写 OpenChamber 大量数据层；即使首期禁用部分能力，也需要长期承担 OpenChamber 上游结构、OpenCode 类型和多端契约的变化。该路线适合短期 Spike，但不作为本方案正式底座。

### 4.3 不采用方案：依赖 OpenCode Node 预览运行时

OpenCode 官方已经出现 `target: node` 的构建入口和 `opencode-node` 预览包，但当前稳定性和企业环境适配不足以作为本重构的正式前提：

- npm 入口仍以平台可执行文件分发，Windows 运行时不等同于直接使用企业白名单 `node.exe`；
- Node Runtime 仍处于高频 `next` 预览迭代，接口、依赖和打包形态可能变化；
- 即使 Node OpenCode 可运行，其 Agent、Tool、Session 和 Permission 语义仍属于 OpenCode，不等同于 Claude Agent SDK/Claude Code；
- TSD 解密、Windows 原生模块、进程树和打包后的白名单识别仍需独立验证；
- 把产品路线绑定到该预览版，会把上游不稳定性引入正式交付。

因此，OpenCode Node 可以保留为未来观察项或独立实验，不进入当前主线、估算和交付门槛。

### 4.4 不推荐方案：把现有终端输出包装成气泡

从 PTY 输出解析 Claude CLI 文本看似改动较小，但存在不可控问题：

- ANSI 控制序列和终端重绘不等于消息协议；
- Tool Call、Tool Result、Thinking、权限请求无法稳定识别；
- CLI 文案和版本变化会破坏解析；
- Stop、Resume 和状态恢复只能依赖脆弱推断；
- 无法形成稳定、可测试的领域模型。

因此，旧终端模式可以作为过渡和故障兜底，但不能作为新气泡对话的数据源。

---

## 5. 目标产品结构

### 5.1 左侧：Project / Workspace / Session

左侧导航承担三个层次：

```text
Project
└── Workspace
    ├── Main Workspace
    │   ├── Session A
    │   └── Session B
    ├── Worktree: feature/login
    │   └── Session C
    └── Temporary Workspace
        └── Session D
```

产品语义：

- Project 对应一个仓库或可工作的项目根；
- Workspace 是具体工作目录；
- Main Worktree、Git Worktree、远程目录和临时目录都是 Workspace 类型；
- Session 是绑定在 Workspace 上的 Claude 对话；
- Worktree 不删除，只是不再作为整个产品唯一的顶层主角；
- 活跃、等待权限、运行中、失败、已完成等状态应直接反映在 Session 节点上；
- Workspace 可显示分支、变更数量、远程状态等辅助信息；
- 会话排序优先考虑运行状态和最近更新时间。

首个版本建议支持：

- 新建会话；
- 选择会话；
- 会话重命名；
- 会话关闭/归档；
- Resume 历史会话；
- Workspace 折叠；
- Project 折叠；
- 状态徽标；
- 基础搜索或过滤可后置。

### 5.2 中间：Bubble Chat

中央区域是主任务区，包含：

```text
Chat Header
├── 当前 Project / Workspace
├── 会话标题
├── Model
├── Effort
├── Plan / Build
├── Session Status
└── More Actions

Message Timeline
├── User Message
├── Assistant Text
├── Thinking Block
├── Tool Call Card
├── Tool Result Card
├── Permission Card
├── Question Card
├── Error / Notice
└── Running Indicator

Composer
├── 多行输入
├── 文件/上下文引用
├── 发送
├── Stop
└── 可选快捷操作
```

核心行为：

- 输入后立即生成用户消息，避免等待运行时确认后才展示；
- 流式文本在同一 Assistant Message 中持续更新；
- Thinking 默认折叠，运行中可显示轻量状态；
- Tool Call 和 Tool Result 组成可关联的一组；
- 权限请求必须出现在对话时间线上，不能只用全局弹窗；
- 等待权限时 Session 进入明确状态；
- Stop 对当前运行生效，不关闭会话；
- Resume 后恢复历史消息和上下文身份；
- 失败时保留已接收内容，并提供可理解的错误和重试入口。

### 5.3 右侧：Git / Files / Context

右侧是可切换的辅助工作区。

#### Git

复用当前 Source Control 能力，至少提供：

- changed files；
- staged/unstaged；
- diff 入口；
- stage/unstage；
- commit；
- refresh；
- 当前分支和变更摘要。

#### Files

复用当前文件树和 Monaco 能力，至少提供：

- 文件树；
- 文件搜索；
- 打开文件；
- 当前打开文件；
- 跳转到对话引用的文件和行；
- 必要时在中央区域临时切换为编辑器，或以现有编辑区呈现。

#### Context

首个版本只做与 Claude 对话直接相关的上下文摘要：

- 当前 Workspace；
- 当前分支；
- 用户已附加文件；
- CLAUDE.md/项目指令是否生效；
- 当前模型、模式和权限策略；
- 当前运行状态；
- 可选的 Token/Cost/Duration 摘要。

不要求在本轮复制 OpenChamber 完整 MCP、LSP、Runtime 和远程服务状态中心。

### 5.4 底部：Terminal Dock

终端仍然是重要能力，但产品定位发生变化：

- 用于 Shell 命令、开发服务器、日志和手工操作；
- 不再承担 Claude 主对话渲染；
- 可展开、折叠和调整高度；
- 保留多终端 Session；
- 保留 xterm.js、node-pty、链接跳转和主题同步；
- 切换 Workspace 时恢复对应终端；
- Agent Host 日志默认不直接混入用户终端，可在诊断入口查看。

---

## 6. 视觉设计方向

### 6.1 视觉关键词

- Flexoki 类暖中性色；
- 低饱和；
- 低噪声；
- 清晰层级；
- 紧凑但不拥挤；
- 少量强调色用于状态和交互；
- 边框弱于内容；
- 面板背景有轻微层次差；
- 信息密度接近桌面 IDE，而不是移动聊天应用。

### 6.2 组件原则

- 优先复用项目现有 `@coss/ui`/UI primitives；
- 不为按钮、弹层、菜单、Tooltip 等重复手写基础组件；
- 使用语义 Token，不在业务组件散落硬编码颜色；
- 延续 Tailwind 4 和 OKLCH 技术路线；
- 不直接粗暴覆盖 `globals.css` 主题；
- 与现有 Ghostty 主题同步机制明确分工：应用壳颜色和终端颜色可关联，但不能互相污染；
- OpenChamber 指定版本是尺寸、密度、区域比例和按钮位置的第一参考；AiClient 现有 36px Tab、28px Tree Row、24px 小按钮只在不破坏目标视觉时复用；
- 所有可截断文本遵循 `min-w-0 + flex-1 + truncate`；
- 图标、文本、徽标和状态点需要稳定对齐；
- 会影响布局的未接功能入口可以保留并禁用，Tooltip 明确说明状态；不会影响布局的深层功能可以暂时隐藏；
- 禁止按钮看起来可用但点击无反馈，也禁止用硬编码数据伪装真实 Runtime 状态；
- UI 对齐验收与功能接入验收分开记录，分别标记 `已接入`、`基础接入`、`禁用占位` 和 `暂不纳入`。

### 6.3 主题策略

建议先提供一个明确的产品壳主题，例如 `Flexoki Light` 和 `Flexoki Dark`，通过现有主题系统或新增语义映射实现。

推荐语义层：

- `surface-base`；
- `surface-panel`；
- `surface-raised`；
- `surface-hover`；
- `border-subtle`；
- `text-primary`；
- `text-secondary`；
- `text-muted`；
- `accent-primary`；
- `status-running`；
- `status-waiting`；
- `status-success`；
- `status-error`。

目标是高保真复刻视觉秩序、区域关系和控件布局，不要求逐个复制 OpenChamber CSS class 或源码实现。

### 6.4 关键页面/状态清单

- 首次进入但没有 Project；
- 已有 Project、没有 Workspace；
- 已有 Workspace、没有 Session；
- 新会话空状态；
- 正常对话；
- 流式生成；
- Thinking；
- Tool 正在运行；
- Tool 成功；
- Tool 失败；
- 等待 Permission；
- 等待 Question；
- 用户 Stop；
- Runtime 断开；
- Resume 中；
- Resume 失败；
- Node 24 不可用；
- Cometix CLI 不可用；
- Workspace 不可访问；
- TSD 加密文件验证失败；
- 窄窗口；
- 左右栏折叠；
- Terminal Dock 展开。

---

## 7. 推荐技术架构

### 7.1 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron Renderer                                           │
│                                                             │
│ Workspace Shell  Chat UI  Git/Files/Context  Terminal Dock  │
│ Chat Store       UI State  Existing Stores                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ typed Electron IPC
┌──────────────────────────▼──────────────────────────────────┐
│ Electron Main                                               │
│                                                             │
│ AgentHostManager  GitService  FileService  PtyManager       │
│ Session Registry  Process Lifecycle  Settings               │
└──────────────────────────┬──────────────────────────────────┘
                           │ NDJSON over stdio
┌──────────────────────────▼──────────────────────────────────┐
│ Whitelisted Node 24 Agent Host                              │
│                                                             │
│ Claude Agent SDK                                            │
│ Claude Event Adapter                                        │
│ Permission/Question Bridge                                  │
│ Abort/Resume/Session Control                                │
└──────────────────────────┬──────────────────────────────────┘
                           │ explicit CLI runtime
┌──────────────────────────▼──────────────────────────────────┐
│ Node 24 + @cometix/claude-code cli.js                       │
│                                                             │
│ Workspace Files / Claude Config / MCP / Tools               │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 进程职责

#### Renderer

只负责：

- 展示结构化消息；
- 接收用户操作；
- 管理 UI 状态；
- 向 Main 发起命令；
- 消费 Main 推送的 Runtime Event；
- 不直接启动 Node；
- 不直接访问 Claude SDK；
- 不持有敏感凭证。

#### Electron Main

负责：

- 查找和校验 Node 24；
- 启动、监控、停止 Agent Host；
- 每个会话或共享 Host 的生命周期管理；
- 将 Renderer 命令转为 Host 协议；
- 将 Host 事件转为 Renderer IPC；
- 崩溃检测和重启策略；
- 日志和诊断；
- 退出时清理子进程；
- 继续提供现有 Git、文件和 PTY 服务。

#### Node 24 Agent Host

负责：

- 载入 `@anthropic-ai/claude-agent-sdk`；
- 显式使用经过验证的 Cometix Claude Code `cli.js`；
- 创建和恢复 Claude 会话；
- 规范化 SDK 消息和事件；
- 权限/问题交互桥接；
- Abort；
- 将异常转换为稳定错误事件；
- 不包含 UI 逻辑；
- 不直接依赖 Electron API。

### 7.3 为什么需要独立 Agent Host

当前实际环境存在 TEC/OCular/TSD 文件加密限制：

- 打包后的 Electron exe 不在白名单时会读到加密字节；
- 系统 `node.exe` 已被实际证明可以获得解密后的内容；
- Bun、OpenCode 原生二进制或其他打包 exe 不满足当前环境要求；
- 目标 Cometix 版本需要 Node 24。

因此：

- Electron 内置 Node 不能等价替代白名单独立 `node.exe`；
- 单纯升级 Electron 不能证明 TSD 问题已解决；
- Agent SDK 自身可运行所需的最低 Node 版本，不等于目标 Cometix 运行时要求；
- Node 24 应作为明确的外部执行边界进行校验和诊断。

### 7.4 Node 24 来源策略

按稳妥程度排序：

#### 方案 A：用户/企业环境提供的系统 Node 24

推荐作为 TSD 环境默认方案。

优点：

- 最有可能处于企业白名单；
- 可直接验证 `process.execPath`；
- 升级和审计路径明确。

缺点：

- 需要安装或由企业分发；
- 版本可能不一致；
- 需要设置页选择和诊断。

#### 方案 B：随 AiClient 分发独立 Node 24

只有在企业白名单验证通过后才可作为默认。

优点：

- 版本可控；
- 用户配置较少；
- 打包体验统一。

缺点：

- 新的 `node.exe` 路径可能不在白名单；
- 增大安装包；
- 需要跟踪 Node 安全更新和许可证材料。

#### 方案 C：依赖 Electron 内置 Node

不作为当前 TSD 环境推荐方案，因为它不是一个独立、可由白名单识别的系统 `node.exe` 路径。

### 7.5 Agent Host 协议

建议使用 stdio 上的 NDJSON，一行一个完整 JSON 消息。

优点：

- 跨平台；
- 无需监听端口；
- 生命周期与父进程绑定清晰；
- 日志和业务事件可分离；
- 便于独立运行和测试；
- 不需要为了本地子进程引入 WebSocket 服务。

Main -> Host 命令候选：

```text
host.initialize
session.create
session.resume
session.send
session.stop
session.close
permission.respond
question.respond
host.shutdown
```

Host -> Main 事件候选：

```text
host.ready
host.error
session.created
session.resumed
session.status
message.started
message.delta
message.completed
thinking.started
thinking.delta
thinking.completed
tool.started
tool.updated
tool.completed
permission.requested
permission.resolved
question.requested
question.resolved
usage.updated
session.completed
session.failed
session.stopped
```

协议要求：

- 每条命令有 `requestId`；
- 每条会话事件有 `sessionId`；
- Message/Tool/Permission 有稳定 ID；
- 明确区分日志和协议 stdout；
- Host 的普通日志写 stderr；
- 支持协议版本；
- 未识别事件可记录，但不能导致整个 Host 崩溃；
- 不在协议中传递不可序列化 SDK 对象。

---

## 8. 对话领域模型

### 8.1 Session

建议每个 Chat Session 至少包含：

- AiClient session ID；
- Claude runtime session ID/resume identity；
- Project ID；
- Workspace path；
- 标题；
- 模型；
- Effort；
- Mode；
- Permission policy；
- 状态；
- 创建时间；
- 最近更新时间；
- 最近错误；
- 是否归档。

状态候选：

```text
idle
starting
running
waiting_permission
waiting_question
stopping
completed
failed
disconnected
```

### 8.2 Message

消息至少分为：

- user；
- assistant；
- system/notice；
- error。

每条消息由顺序化 Block 组成，避免把所有内容压成一段字符串。

### 8.3 Block

Block 候选：

- text；
- thinking；
- code；
- tool_call；
- tool_result；
- permission_request；
- question_request；
- file_reference；
- diff；
- usage；
- notice；
- error。

### 8.4 Runtime Event 与 UI State 分离

SDK 事件不能直接成为 React 组件状态。推荐数据流：

```text
SDK Event
  -> Agent Host Normalizer
  -> Stable Runtime Event
  -> Electron IPC
  -> Chat Store Reducer
  -> Session/Message/Block State
  -> React Components
```

这样可以：

- 屏蔽 SDK/Cometix 版本差异；
- 对 reducer 做独立测试；
- 支持历史恢复；
- 支持未来替换 Runtime；
- 避免组件处理大量增量事件细节。

### 8.5 增量更新原则

- Text Delta 合并到当前 Text Block；
- Thinking Delta 合并到当前 Thinking Block；
- Tool Update 按 tool call ID 更新；
- Tool Result 与对应 Tool Call 关联；
- Permission/Question 只能被响应一次；
- 收到终态后冻结该 Block；
- Stop 后保留已产生内容；
- 乱序事件需要通过稳定 ID 和序号处理；
- UI 不应为每个字符触发全列表重渲染。

---

## 9. Claude 功能矩阵

| 能力 | MVP | 正式版 | 说明 |
|---|:---:|:---:|---|
| 新建 Session | 必须 | 必须 | 绑定当前 Workspace |
| 发送 Prompt | 必须 | 必须 | 多行输入 |
| 流式文本 | 必须 | 必须 | 结构化事件驱动 |
| Markdown | 必须 | 必须 | GFM、代码块 |
| Thinking | 必须 | 必须 | 默认折叠 |
| Tool Call | 必须 | 必须 | 名称、输入、状态 |
| Tool Result | 必须 | 必须 | 摘要、展开详情 |
| Permission | 必须 | 必须 | 允许/拒绝/策略选项按 SDK 能力落地 |
| Question | 建议 | 必须 | 选项或文本回答 |
| Stop | 必须 | 必须 | Abort 当前 Query |
| Resume | 必须 | 必须 | 重启应用后仍可继续 |
| Model | 必须 | 必须 | 只展示可用模型 |
| Effort | 建议 | 必须 | 以 Runtime 实际支持为准 |
| Plan/Build | 建议 | 必须 | 映射到实际权限/模式，不做纯 UI 假状态 |
| 文件引用 | 建议 | 必须 | 与 Files 面板联动 |
| Diff 卡片 | 可选 | 建议 | 可先复用现有 Diff 组件 |
| Usage/Cost | 可选 | 建议 | 以 SDK 可用字段为准 |
| Slash Commands | 可选 | 建议 | 不作为首版前置 |
| MCP 状态 | 可选 | 可选 | 不复制 OpenChamber 完整面板 |
| 多 Agent 统一协议 | 不做 | 可选 | Claude 稳定后再评估 |

---

## 10. 现有模块迁移策略

### 10.1 保留

- `src/main/services/git/`；
- 文件读写、监听和编码处理；
- xterm.js 与 node-pty；
- RemoteConnectionManager；
- Worktree 管理；
- Monaco Editor；
- Settings 基础设施；
- Electron Main/Preload 安全边界；
- 构建、更新和打包；
- Claude IDE Bridge 中仍有价值的 Workspace/IDE 感知能力；
- TSD 加密检测和系统 Node 读取经验。

### 10.2 改造

#### `src/renderer/App.tsx`

当前文件承担大量仓库、Worktree、布局和弹窗调度。目标不是一次性重写全部逻辑，而是逐步抽出：

- Workspace Shell；
- Left Navigation；
- Main Workspace Area；
- Right Dock；
- Bottom Dock；
- 全局 Dialog Host。

最终让 `App.tsx` 更偏路由和顶层装配，不继续堆积所有面板行为。

#### `src/renderer/components/layout/MainContent.tsx`

当前主要通过 Chat/File/Terminal/Source Control Tab 切换功能。目标布局中：

- Chat 常驻中央；
- Git/Files/Context 进入右侧；
- Terminal 进入底部；
- Settings 保持独立入口；
- Todo 是否保留为右侧 Tab 或独立视图由后续产品选择。

#### `src/renderer/components/chat/AgentPanel.tsx`

当前 AgentPanel 本质上仍管理终端 Agent Session、AgentTerminal、分组、输入增强和 StatusLine。迁移后：

- Claude 主路径由新 Chat Workspace 替换；
- AgentTerminal 不再渲染 Claude 主会话；
- EnhancedInput 的有价值能力可迁入新 Composer；
- 旧 AgentPanel 可暂时保留给其他 CLI Agent；
- 待 Claude 路径稳定后，再决定删除、拆分或重命名旧组件。

#### `src/renderer/stores/agentSessions.ts`

不建议直接无限扩展现有终端 Session 数据结构来承载结构化消息。推荐：

- 新建独立 Chat Session/Message Store；
- 旧 Agent Session Store 暂时服务终端 Agent；
- 通过 Workspace ID/Path 建立两者关联；
- 稳定后再评估合并公共元数据。

### 10.3 新增候选模块

以下仅表示推荐边界，实际文件名可在实施任务中调整：

```text
src/main/
├── services/agent-host/
│   ├── AgentHostManager.ts
│   ├── AgentHostProcess.ts
│   ├── NodeRuntimeResolver.ts
│   ├── AgentHostProtocol.ts
│   └── AgentHostDiagnostics.ts
└── ipc/chat.ts

src/agent-host/
├── index.ts
├── protocol.ts
├── claudeRuntime.ts
├── eventNormalizer.ts
└── sessionRegistry.ts

src/shared/types/
├── chat.ts
├── agentHost.ts
└── runtimeEvents.ts

src/renderer/
├── components/workspace-shell/
├── components/chat/
│   ├── ChatWorkspace.tsx
│   ├── MessageTimeline.tsx
│   ├── ChatComposer.tsx
│   ├── blocks/
│   └── cards/
└── stores/chatSessions.ts
```

---

## 11. 用户路径

### 11.1 首次使用

```text
启动 AiClient
  -> 运行环境检查
  -> 找到并验证 Node 24
  -> 验证 Cometix Claude Code
  -> 选择/添加 Project
  -> 选择 Main Workspace 或 Worktree
  -> 新建 Session
  -> 输入任务
  -> 结构化气泡对话
```

Node 24 或 Cometix 不可用时，应进入可操作的诊断状态，而不是只显示“启动失败”：

- 当前找到的 Node 路径；
- 当前 Node 版本；
- 需要 Node 24；
- 选择 Node 可执行文件；
- 重新检测；
- Cometix CLI 路径；
- 最小自检结果；
- TSD 兼容验证结果。

### 11.2 日常使用

```text
选择 Project
  -> 选择 Workspace/Worktree
  -> 选择已有 Session 或新建 Session
  -> 对话
  -> Claude 调用工具
  -> 用户按需批准权限
  -> 右侧查看 Git/Files/Context
  -> 底部运行终端或查看日志
  -> 返回对话继续任务
```

### 11.3 恢复会话

```text
启动应用
  -> 加载本地 Session 索引
  -> 显示历史 Session
  -> 用户选择 Session
  -> 加载历史消息摘要/记录
  -> 调用 Runtime Resume
  -> 校验 Workspace
  -> 恢复为 idle
  -> 用户继续发送消息
```

### 11.4 权限请求

```text
Claude 请求工具权限
  -> Runtime 发出 permission.requested
  -> Session 状态变为 waiting_permission
  -> 对话中出现 Permission Card
  -> 用户允许或拒绝
  -> Renderer -> Main -> Host
  -> Runtime 继续
  -> Permission Card 固化结果
```

### 11.5 Stop

```text
用户点击 Stop
  -> UI 立即进入 stopping
  -> Main 转发 Abort
  -> Host 中止当前 Query
  -> 保留已经生成的消息和 Tool 状态
  -> Session 回到 idle 或 stopped
  -> 用户可以继续发送下一条消息
```

---

## 12. 完整候选任务池

下面的任务不是固定施工顺序。UI 与 Runtime 应双轨推进：UI 以冻结的 OpenChamber 参考版本和 Mock Event 开发，Runtime 以稳定协议独立推进，二者在 Chat Domain Model 汇合。

### A. 产品与设计基线

#### A01 — OpenChamber 参考界面清单

- 范围：冻结 OpenChamber commit/tag、Light/Dark 基准、标准窗口尺寸，整理左栏、中栏、右栏、底栏、消息类型、按钮顺序和关键状态截图；
- 产物：可追溯参考界面清单、区域尺寸基线、按钮布局清单和允许差异说明；
- 依赖：无；
- 验收：每个拟对齐区域都有指定版本参考，主要按钮的位置、顺序、状态和“对齐 UI/不复制功能”结论明确；
- 工作量：2～3 人日。

#### A02 — AiClient 当前用户路径盘点

- 范围：记录 Project、Worktree、Agent、Files、Git、Terminal 当前入口和状态归属；
- 产物：现状用户路径和模块映射；
- 依赖：无；
- 验收：现有能力均有保留、迁移或废弃判断；
- 工作量：1～2 人日。

#### A03 — 目标信息架构

- 范围：确定 Project / Workspace / Session 层级，以及 Git/Files/Context/Terminal 的归属；
- 产物：信息架构图和导航规则；
- 依赖：A01、A02；
- 验收：Main Worktree、Git Worktree、远程和临时目录都能映射到 Workspace；
- 工作量：1～2 人日。

#### A04 — UI 状态矩阵

- 范围：列出空、加载、运行、权限、失败、断开、恢复等状态；
- 产物：页面/组件状态矩阵；
- 依赖：A03；
- 验收：设计不只覆盖正常对话截图；
- 工作量：1～2 人日。

#### A05 — 视觉 Token 方案

- 范围：基于参考截图和源码整理色板、字体、间距、区域尺寸、圆角、边框、阴影、图标和状态色；
- 产物：设计 Token 映射；
- 依赖：A01；
- 验收：Light/Dark、终端主题边界及 OpenChamber -> AiClient Token 映射明确，业务组件不自行发明视觉值；
- 工作量：2～3 人日。

#### A06 — 功能接入状态矩阵

- 范围：逐个记录 OpenChamber 可见入口在首版中的真实能力状态；
- 产物：`已接入 / 基础接入 / 禁用占位 / 暂不纳入` 矩阵；
- 依赖：A01、A02；
- 验收：所有影响布局的按钮都有明确状态，不存在“看起来可用但实际无行为”的入口；
- 工作量：1～2 人日。

### B. Node 24 与 TSD 技术验证

#### B01 — Node 24 Resolver

- 范围：验证系统 Node、用户指定路径、可选内置 Node 的发现顺序；
- 产物：Node 查找和版本校验原型；
- 依赖：无；
- 验收：能报告实际 `process.execPath` 和 Node 版本，并拒绝非 24 运行时；
- 工作量：1～2 人日。

#### B02 — TSD 文件最小验证

- 范围：使用目标 Node 24 读取已知 TSD 加密文件，并与预期内容/Hash 对比；
- 产物：可重复的 TSD 自检；
- 依赖：B01；
- 验收：在真实工作环境确认读取结果是解密内容，不是 `%TSD-Header-###%` 原始字节；
- 工作量：1～2 人日。

#### B03 — Cometix CLI 启动验证

- 范围：使用目标 Node 24 启动所选 Cometix release 的 `cli.js`；
- 产物：固定版本、路径和启动参数记录；
- 依赖：B01；
- 验收：CLI 在真实环境可启动，并记录 release 版本和 SHA256；
- 工作量：1 人日。

#### B04 — Agent SDK + Cometix 集成验证

- 范围：Agent SDK 显式使用 Cometix CLI，执行一个最小 Query；
- 产物：最小 Host POC；
- 依赖：B03；
- 验收：收到结构化 Assistant/Tool/Result 事件，不依赖 PTY 文本解析；
- 工作量：2～3 人日。

#### B05 — Stop/Resume/Permission 验证

- 范围：验证 Abort、会话 Resume 和权限回调；
- 产物：能力验证记录；
- 依赖：B04；
- 验收：三项能力至少有成功路径和已知限制；
- 工作量：1～2 人日。

#### B06 — 打包环境验证

- 范围：从打包后的 Electron 启动外部 Node 24 Host；
- 产物：打包运行验证报告；
- 依赖：B04；
- 验收：开发模式成功不作为结论，打包应用中也可启动、退出和读取 TSD 文件；
- 工作量：1～2 人日。

### C. Agent Host 与协议

#### C01 — Host 协议定义

- 范围：命令、事件、ID、版本、错误结构；
- 产物：共享 TypeScript 类型和协议说明；
- 依赖：B04；
- 验收：Renderer 不需要认识 SDK 原始对象；
- 工作量：1～2 人日。

#### C02 — Agent Host 入口

- 范围：stdin 读取、stdout NDJSON、stderr 日志、优雅退出；
- 产物：可独立运行的 Host；
- 依赖：C01；
- 验收：协议流无日志污染，非法命令返回结构化错误；
- 工作量：1～2 人日。

#### C03 — Claude Runtime Adapter

- 范围：SDK 初始化、新建 Query、参数映射、Cometix 路径；
- 产物：Claude Runtime 层；
- 依赖：C02；
- 验收：能创建会话并发送消息；
- 工作量：2～4 人日。

#### C04 — Event Normalizer

- 范围：Assistant、Thinking、Tool、Result、Usage、Error 转换；
- 产物：稳定 Runtime Event；
- 依赖：C03；
- 验收：同一事件输入得到确定输出，未知事件有可诊断降级；
- 工作量：2～4 人日。

#### C05 — Permission/Question Bridge

- 范围：请求挂起、响应、拒绝、超时/会话关闭；
- 产物：双向交互桥；
- 依赖：C03、C04；
- 验收：一个请求只能完成一次，关闭会话不会留下悬空 Promise；
- 工作量：2～3 人日。

#### C06 — Abort 与状态机

- 范围：Stop、重复 Stop、运行结束竞态、Host 退出；
- 产物：会话运行状态机；
- 依赖：C03；
- 验收：Stop 不会误杀其他 Session，终态一致；
- 工作量：1～2 人日。

#### C07 — Resume 与 Session Registry

- 范围：Runtime Session ID、Workspace 绑定、恢复校验；
- 产物：Host Session Registry；
- 依赖：C03、C04；
- 验收：应用重启后可恢复一个真实会话；
- 工作量：2～4 人日。

#### C08 — Host 诊断与日志

- 范围：版本、路径、启动参数脱敏、退出码、最近错误；
- 产物：诊断对象和日志文件；
- 依赖：C02；
- 验收：用户报告“Claude 启动不了”时可从诊断信息区分 Node、CLI、SDK、TSD 和 Workspace 问题；
- 工作量：1～2 人日。

### D. Electron Main/Preload 接入

#### D01 — AgentHostManager

- 范围：启动、复用、监控和关闭 Host；
- 产物：Main Process 服务；
- 依赖：C02；
- 验收：应用退出时无遗留 Host，Host 崩溃可被感知；
- 工作量：2～3 人日。

#### D02 — Main 与 Host 请求关联

- 范围：requestId、pending request、超时和错误；
- 产物：协议客户端；
- 依赖：D01、C01；
- 验收：并发命令不会串响应；
- 工作量：1～2 人日。

#### D03 — Chat IPC

- 范围：create/resume/send/stop/permission/question/close；
- 产物：IPC handlers；
- 依赖：D02；
- 验收：IPC 参数和返回值有共享类型，不使用类型逃逸；
- 工作量：2～3 人日。

#### D04 — Runtime Event 推送

- 范围：Host -> Main -> Renderer 事件转发和订阅清理；
- 产物：Preload API 和 Renderer listener；
- 依赖：D01、C04；
- 验收：窗口销毁后无发送异常和残留监听；
- 工作量：1～2 人日。

#### D05 — Node/Cometix 设置与诊断

- 范围：路径选择、版本检测、自检和错误说明；
- 产物：Settings 数据和 IPC；
- 依赖：B01～B04；
- 验收：非开发人员可以从 UI 完成选择和重新检测；
- 工作量：2～4 人日。

#### D06 — 进程清理接入

- 范围：will-quit、SIGINT、SIGTERM、开发脚本清理；
- 产物：统一资源清理；
- 依赖：D01；
- 验收：多次启动/退出无孤儿 Node 进程；
- 工作量：1～2 人日。

### E. Chat Store 与数据恢复

#### E01 — Chat 类型和 Reducer

- 范围：Session、Message、Block、Runtime Event；
- 产物：共享类型和纯 reducer；
- 依赖：C01、C04；
- 验收：Text/Thinking/Tool/Permission/Question/Stop/Failure 都有确定状态变换；
- 工作量：2～3 人日。

#### E02 — Chat Sessions Store

- 范围：Workspace 索引、活动会话、消息更新、状态；
- 产物：Zustand store；
- 依赖：E01；
- 验收：切换 Workspace 不串 Session；
- 工作量：2～3 人日。

#### E03 — 增量事件批处理

- 范围：高频 Delta 合并和渲染节流；
- 产物：事件缓冲策略；
- 依赖：E02；
- 验收：长回复时输入、滚动和侧栏操作保持可用；
- 工作量：1～2 人日。

#### E04 — 本地会话索引

- 范围：保存标题、Workspace、Runtime ID、状态和时间；
- 产物：持久化索引；
- 依赖：E02、C07；
- 验收：应用重启后左侧仍显示可恢复会话；
- 工作量：2～3 人日。

#### E05 — 历史消息恢复

- 范围：从 Claude JSONL/SDK 可用接口恢复消息，或保存规范化快照；
- 产物：历史恢复策略；
- 依赖：E04、B02；
- 验收：TSD 环境可加载历史，不把“仅恢复 Session ID”误显示为完整历史；
- 工作量：2～5 人日。

### F. Workspace Shell

#### F01 — 新 Workspace Shell 骨架

- 范围：按参考基线建立标题栏、左、中、右、下五个结构区域；
- 产物：高保真布局容器；
- 依赖：A01、A03；
- 验收：区域关系、默认比例和主要分隔与参考一致，五区可独立挂载 Mock 内容；
- 工作量：3～5 人日。

#### F02 — 面板尺寸和折叠

- 范围：左右栏宽度、Terminal 高度、折叠和持久化；
- 产物：布局状态；
- 依赖：F01；
- 验收：拖动稳定，最小/最大尺寸合理，重启后可恢复；
- 工作量：2～3 人日。

#### F03 — 标题栏与全局操作

- 范围：按参考按钮顺序实现当前 Project/Workspace、Settings、布局开关和运行状态；
- 产物：新 Header；
- 依赖：A01、F01；
- 验收：信息层级不与 Chat Header 重复，按钮位置、顺序、Hover、Disabled 和 Tooltip 符合基线；
- 工作量：2～3 人日。

#### F04 — 窄窗口降级

- 范围：左右栏互斥抽屉或自动折叠；
- 产物：Compact Layout；
- 依赖：F01、F02；
- 验收：低于约定宽度时中央 Chat 仍可发送消息；
- 工作量：2～3 人日。

#### F05 — Workspace Shell 视觉打磨

- 范围：背景、边框、间距、尺寸、图标、Hover、Selected、Disabled、Focus 和过渡；
- 产物：与指定 OpenChamber 版本高保真对齐的完整壳；
- 依赖：A05、A06、F01～F04；
- 验收：在标准窗口尺寸和 Light/Dark 下逐区域对照通过，主要按钮无需在后续功能接入时重新排版；
- 工作量：5～8 人日。

### G. 左侧 Project / Workspace / Session

#### G01 — 统一 Workspace View Model

- 范围：Main、Worktree、Remote、Temp 映射；
- 产物：Workspace 视图模型；
- 依赖：A03；
- 验收：现有工作目录无能力丢失；
- 工作量：2～3 人日。

#### G02 — Project/Workspace Tree

- 范围：层级、折叠、选择、状态；
- 产物：左侧树；
- 依赖：G01、F01；
- 验收：仓库和 Worktree 切换行为与当前真实数据一致；
- 工作量：3～5 人日。

#### G03 — Session List

- 范围：会话标题、状态、时间、活动标记；
- 产物：Workspace 下的 Session 节点；
- 依赖：E02、G02；
- 验收：running/waiting/failed/idle 清晰可见；
- 工作量：2～4 人日。

#### G04 — Session 操作

- 范围：新建、重命名、关闭、归档、恢复；
- 产物：菜单和交互；
- 依赖：G03、D03；
- 验收：操作失败不会静默丢失会话；
- 工作量：2～3 人日。

#### G05 — 左侧导航键盘和焦点

- 范围：上下移动、展开、选择、菜单焦点；
- 产物：可访问交互；
- 依赖：G02～G04；
- 验收：不使用鼠标可完成会话选择和新建；
- 工作量：1～2 人日。

### H. 中央 Chat UI

#### H01 — Chat Header

- 范围：按参考顺序实现标题、Workspace、Model、Effort、Mode、状态和操作；
- 产物：Header；
- 依赖：A01、A06、E02、F01；
- 验收：布局和按钮顺序与参考一致；Runtime 未支持的选项明确禁用或隐藏，不展示假状态；
- 工作量：2～3 人日。

#### H02 — Message Timeline

- 范围：虚拟/普通列表、自动滚动、用户滚动锁；
- 产物：消息时间线；
- 依赖：E02；
- 验收：新消息到达时不强制打断用户查看旧消息；
- 工作量：2～4 人日。

#### H03 — User/Assistant Text Bubble

- 范围：消息气泡、Markdown、代码块、复制；
- 产物：基础消息组件；
- 依赖：H02；
- 验收：中文、长代码、表格、链接和换行正确；
- 工作量：2～4 人日。

#### H04 — Thinking Block

- 范围：运行中、折叠、完成状态；
- 产物：Thinking 组件；
- 依赖：E01、H02；
- 验收：高频增量不造成明显抖动；
- 工作量：1～2 人日。

#### H05 — Tool Card

- 范围：工具名、参数摘要、运行状态、结果和错误；
- 产物：通用 Tool Card；
- 依赖：E01、H02；
- 验收：Tool Call 和 Result 正确关联；
- 工作量：3～5 人日。

#### H06 — 常见工具专用摘要

- 范围：Read/Edit/Write/Bash/Search 等可读摘要；
- 产物：Tool Presenter 映射；
- 依赖：H05；
- 验收：未知工具仍可用通用卡片展示；
- 工作量：2～4 人日。

#### H07 — Permission Card

- 范围：权限说明、允许、拒绝、可用策略；
- 产物：可交互卡片；
- 依赖：C05、D03、E01；
- 验收：重复点击不重复提交，响应后卡片固化；
- 工作量：2～3 人日。

#### H08 — Question Card

- 范围：选项、自由文本、提交和取消；
- 产物：可交互问题卡片；
- 依赖：C05、D03、E01；
- 验收：回答与正确请求 ID 关联；
- 工作量：2～3 人日。

#### H09 — Chat Composer

- 范围：按参考按钮顺序实现多行输入、发送、附件/模式入口、输入历史和基础快捷键；
- 产物：Composer；
- 依赖：A01、A06、D03、E02；
- 验收：按钮位置和状态与参考一致，中文输入法、粘贴长文本、Enter/Shift+Enter 行为正确；
- 工作量：3～5 人日。

#### H10 — Stop 与运行状态

- 范围：发送/停止按钮切换、Stopping、防重复；
- 产物：运行控制；
- 依赖：C06、D03、E01；
- 验收：Stop 后保留内容，可继续下一轮；
- 工作量：1～2 人日。

#### H11 — 文件/上下文引用

- 范围：从 Files 面板或 Composer 附加文件；
- 产物：引用 Chip 和参数映射；
- 依赖：H09、I02；
- 验收：引用路径相对当前 Workspace，切换 Workspace 时不会误带旧引用；
- 工作量：2～4 人日。

#### H12 — Chat 空、错、断开和恢复状态

- 范围：无会话、启动失败、Host 断开、Resume 失败；
- 产物：状态页和恢复操作；
- 依赖：D05、E02；
- 验收：错误信息可操作，不只显示堆栈；
- 工作量：2～3 人日。

### I. 右侧面板接线

#### I01 — Right Sidebar Tabs

- 范围：Git/Files/Context Tab 和折叠；
- 产物：右侧容器；
- 依赖：F01；
- 验收：切换 Tab 不丢当前文件或 Git 状态；
- 工作量：1～2 人日。

#### I02 — Files 面板迁移

- 范围：复用 FilePanel/文件树/编辑入口；
- 产物：右侧 Files；
- 依赖：I01；
- 验收：文件树、打开文件和 Workspace 切换正常；
- 工作量：2～4 人日。

#### I03 — Git 面板迁移

- 范围：复用 SourceControlPanel 和 Git 状态；
- 产物：右侧 Git；
- 依赖：I01；
- 验收：stage、unstage、diff、commit 仍对当前 Workspace 生效；
- 工作量：2～4 人日。

#### I04 — Context 面板 MVP

- 范围：Workspace、分支、附加文件、模型、模式、运行状态；
- 产物：右侧 Context；
- 依赖：I01、E02；
- 验收：数据来自真实 Store/Runtime，不展示占位假状态；
- 工作量：2～3 人日。

#### I05 — Chat 与文件/Git 联动

- 范围：点击文件引用、Tool 文件路径、Diff 入口；
- 产物：跨面板导航；
- 依赖：H05、I02、I03；
- 验收：路径、行号和当前 Workspace 正确；
- 工作量：2～4 人日。

### J. Bottom Terminal Dock

#### J01 — Terminal Dock 容器

- 范围：展开、折叠、调整高度；
- 产物：Bottom Dock；
- 依赖：F01、F02；
- 验收：不遮挡 Composer，切换面板不销毁终端；
- 工作量：2～3 人日。

#### J02 — 现有 TerminalPanel 接入

- 范围：复用现有终端 Session；
- 产物：可用 Terminal Dock；
- 依赖：J01；
- 验收：创建、切换、关闭、输入、Resize 正常；
- 工作量：2～3 人日。

#### J03 — Workspace 终端恢复

- 范围：切换 Workspace 时终端归属和状态恢复；
- 产物：Workspace 绑定；
- 依赖：J02、G01；
- 验收：终端不会跨 Workspace 串 cwd；
- 工作量：1～2 人日。

#### J04 — Agent Host 诊断入口

- 范围：查看 Host 日志和环境诊断；
- 产物：诊断抽屉或专用 Terminal/Log View；
- 依赖：C08、J01；
- 验收：业务协议日志不与 Shell 输入混合；
- 工作量：1～2 人日。

### K. 迁移与兼容

#### K01 — Claude 新旧模式开关

- 范围：开发期 Feature Flag 或设置项；
- 产物：可回退路径；
- 依赖：D03、H09；
- 验收：同一安装包可在新 Chat 和旧终端 Claude 之间切换；
- 工作量：1～2 人日。

#### K02 — 其他 Agent 保持终端模式

- 范围：Codex/Gemini/自定义 CLI 的入口重新安置；
- 产物：兼容入口；
- 依赖：F01、J02；
- 验收：Claude 重构不导致其他 Agent 不可用；
- 工作量：2～3 人日。

#### K03 — 旧会话迁移策略

- 范围：ClaudeSessionScanner 历史会话与新 Session 索引映射；
- 产物：迁移/只读恢复方案；
- 依赖：E04、E05；
- 验收：旧会话不会被静默删除，无法 Resume 时明确标记；
- 工作量：2～4 人日。

#### K04 — 旧 AgentPanel 收缩

- 范围：拆分 Claude 专属逻辑、保留 CLI Agent 通用部分；
- 产物：边界清晰的旧模式组件；
- 依赖：K01、K02；
- 验收：不在新旧组件间复制同一套终端生命周期；
- 工作量：2～4 人日。

#### K05 — App/MainContent 结构清理

- 范围：新壳稳定后移除旧 Tab 布局分支和无用状态；
- 产物：简化顶层装配；
- 依赖：F～J 主路径完成；
- 验收：无死分支、无不可达旧 UI，现有行为有替代入口；
- 工作量：3～5 人日。

### L. 质量、性能和发布

#### L01 — Runtime 协议测试

- 范围：命令关联、事件规范化、非法消息、Host 退出；
- 产物：Vitest；
- 依赖：C01～C08；
- 验收：核心协议和 reducer 有稳定测试；
- 工作量：2～4 人日。

#### L02 — Chat Reducer 测试

- 范围：Text/Thinking/Tool/Permission/Stop/Resume/Failure；
- 产物：事件序列测试；
- 依赖：E01；
- 验收：关键状态转换不依赖 React 测试；
- 工作量：2～3 人日。

#### L03 — 长会话性能验证

- 范围：大量消息、长代码块、高频 Delta；
- 产物：性能记录和优化；
- 依赖：H02～H06、E03；
- 验收：约定规模下滚动、输入和增量更新无明显卡顿；
- 工作量：2～4 人日。

#### L04 — 真实 TSD 环境回归

- 范围：启动、读文件、工具执行、历史恢复、退出；
- 产物：真实环境验收记录；
- 依赖：B、C、D、E 主路径；
- 验收：不能以非 TSD 开发机结果替代；
- 工作量：2～3 人日。

#### L05 — Windows 打包回归

- 范围：安装、升级、Node/CLI 路径、子进程清理；
- 产物：Windows 安装包验证；
- 依赖：B06、D06；
- 验收：打包版通过，不残留进程；
- 工作量：2～3 人日。

#### L06 — Typecheck/Lint/Build

- 范围：项目质量门禁；
- 产物：检查记录；
- 依赖：每个实施批次；
- 验收：`pnpm typecheck`、`pnpm lint`、`pnpm build` 按任务范围通过；
- 工作量：持续执行。

#### L07 — 可用性验收

- 范围：真实用户完成新建、对话、授权、看 Diff、开终端、Resume；
- 产物：问题清单；
- 依赖：MVP 完成；
- 验收：主路径不需要回到旧终端 Claude；
- 工作量：2～3 人日。

#### L08 — 发布和回滚方案

- 范围：Feature Flag、配置迁移、日志、回滚；
- 产物：发布清单；
- 依赖：K01、L04、L05；
- 验收：新 Runtime 失败时有明确回退方案，不损坏历史 Session；
- 工作量：1～2 人日。

### M. 可选增强任务

#### M01 — Diff 专用 Tool Card

- 工作量：2～4 人日。

#### M02 — Slash Command 菜单

- 工作量：2～4 人日。

#### M03 — 消息搜索

- 工作量：2～3 人日。

#### M04 — 会话导出

- 工作量：1～2 人日。

#### M05 — 多会话并排

- 工作量：4～8 人日。

#### M06 — MCP 状态面板

- 工作量：3～6 人日。

#### M07 — 其他 Agent 结构化 Adapter

- 工作量：每个 Agent 约 5～12 人日，取决于是否有稳定结构化 SDK/协议。

---

## 13. 建议实施阶段

任务可以自由选择，但推荐采用 UI 与 Runtime 双轨推进。UI 轨不等待完整 Runtime，通过冻结参考版本和 Mock Event 先稳定高保真产品壳；Runtime 轨不依赖新 UI，先证明真实 Node 24 + TSD + Claude Agent SDK 链路。两条轨道在 Chat Domain Model 和 Runtime Event 协议汇合。

### Phase 0A — 高保真产品基线

建议任务：A01～A06。

目标：把“对齐 OpenChamber”从主观描述转成可验收合同。

必须产出：

- 固定的 OpenChamber commit/tag；
- Light/Dark 基准和标准窗口尺寸；
- 标题栏、左栏、Chat Header、Composer、右栏和 Terminal Dock 截图；
- 区域尺寸、按钮顺序和关键状态清单；
- 允许差异说明；
- `已接入 / 基础接入 / 禁用占位 / 暂不纳入` 功能矩阵。

### Phase 0B — Runtime 技术 Go/No-Go

建议任务：B01～B06。

目标：证明真实 TSD 环境中的完整链路可行。

必须拿到的证据：

- 白名单 Node 24 的真实路径；
- 目标 Cometix release 版本和 SHA256；
- Agent SDK 能通过该 CLI 执行；
- 结构化 Text/Tool 事件；
- Stop；
- Resume 的可行性或明确限制；
- Permission 外置的可行性；
- 打包后的 Electron 可启动 Host；
- Host 和 CLI 可以读写目标加密工作区。

Phase 0B 未通过前，不进入正式 Runtime 发布，但不阻塞 Phase 1 的 Mock UI 开发。

### Phase 1 — 高保真 UI Shell

建议任务：F01～F05、G02、G03 的 Mock 形态、H01～H10 的视觉状态、I01、J01。

目标：使用 Mock Event 完成可交互的 OpenChamber 高保真产品壳。

产物：

- 标题栏及左/中/右/下布局；
- OpenChamber 对齐的区域比例、色彩、间距、图标和按钮布局；
- Project / Workspace / Session Mock 导航；
- Chat Header、Message Timeline 和 Composer；
- Text、Thinking、Tool、Permission、Question 的主要视觉状态；
- Git、Files、Context、Terminal 的稳定接入位置；
- 折叠、Resize、窄窗口和 Light/Dark；
- 未接功能的统一 Disabled/Hidden/Tooltip 表现。

### Phase 2 — Runtime Vertical Slice 与 UI 汇合

建议任务：C01～C06、D01～D04、E01～E03、H02、H03、H05、H09、H10。

目标：用真实 Runtime Event 替换最小 Mock 链路，打通一个真实闭环。

```text
新建 Session
  -> 发送消息
  -> 流式文本
  -> 一个 Tool Call/Result
  -> Stop
  -> 回到 idle
```

### Phase 3 — Chat MVP

建议任务：C07、C08、D05、D06、E04、E05、G01～G04、H01～H10、H12。

目标：达到日常可内部使用。

必须包含：

- Session 导航；
- Text；
- Thinking；
- Tool；
- Permission；
- Question；
- Stop；
- Resume；
- Node/Cometix 诊断；
- 应用重启后的会话恢复。

### Phase 4 — 现有能力重新接线

建议任务：I02～I05、J02～J04、H11、K01～K03。

目标：用户不需要在新旧主界面间反复切换。

### Phase 5 — 收口与正式版

建议任务：K04、K05、L01～L08。

目标：清理过渡结构、验证真实环境、发布可回滚。

### Phase 6 — 按需增强

建议任务：M01～M07。

目标：根据真实使用反馈选择，不预先扩大主线。

---

## 14. 工作量估算

### 14.1 按能力块

| 能力块 | 估算 |
|---|---:|
| OpenChamber 参考基线与高保真 UI Shell | 10～18 人日 |
| Node 24 Agent Host 技术验证 | 5～8 人日 |
| 结构化 Agent Runtime/IPC | 8～14 人日 |
| 气泡 Chat MVP | 10～18 人日 |
| Git/File/Terminal 面板接线 | 6～12 人日 |
| 迁移、测试、打包与清理 | 6～10 人日 |

各能力块存在并行、复用和范围重叠，不能简单把每一列最大值机械相加。

综合估算：

- 纯技术原型：5～8 人日；
- 高保真 UI Shell 可交互原型：10～18 人日；
- 内部可用 MVP：30～50 人日；
- 完整正式版：45～70 人日；
- 风险全部兑现时应额外保留约 15%～20% 缓冲。

### 14.2 影响估算的主要变量

会显著增加工程量：

- 随安装包分发 Node 24 且需要处理企业白名单；
- Cometix CLI 与 Agent SDK 存在未覆盖兼容差异；
- 要求所有现有 Agent 同时改为气泡对话；
- 要求完整迁移所有历史会话消息；
- 参考版本不冻结，导致开发过程中持续追随 OpenChamber 上游变化；
- 要求超出标准窗口和关键状态基线的全尺寸逐像素一致；
- 要求 Web/PWA/跨设备；
- 要求复杂 Diff 审批和 Tool 专用 UI；
- 要求多窗口和多会话并排；
- 在 Shell 未稳定前同时大改 App、Store 和 Runtime。

会降低工程量：

- 首版只支持 Claude；
- 使用系统白名单 Node 24；
- 保留其他 Agent 的旧终端入口；
- 首版 Context 只做真实基础字段；
- 使用 Mock Runtime 并行开发 UI；
- 先冻结参考版本、标准窗口尺寸和按钮布局验收清单；
- 历史消息首版允许“索引 + 按需加载”；
- 优先复用现有 Git、File、Terminal 组件。

---

## 15. 风险与控制措施

### 15.1 Node 24 不等于通过 TSD 白名单

风险：版本正确，但具体 `node.exe` 路径未被白名单识别。

控制：

- 记录真实 `process.execPath`；
- 使用已知加密文件做自检；
- 分别验证开发和打包环境；
- 不以 `node --version` 成功替代文件解密验证。

### 15.2 Agent SDK 与 Cometix CLI 兼容性

风险：SDK 默认假设官方 Claude Code 路径或协议，Cometix release 存在差异。

控制：

- Phase 0B 固定版本验证；
- 记录 release、SDK 版本和 SHA256；
- 在 Host 内做适配，不让 Renderer 感知差异；
- 升级前跑协议回归样例。

### 15.3 权限交互死锁

风险：UI 被关闭、Session 被 Stop 或 Host 退出时，权限回调仍在等待。

控制：

- 每个请求有 ID 和终态；
- Session 关闭时统一拒绝悬空请求；
- Stop、Host exit 和 Renderer dispose 都有清理路径；
- reducer 和 Host 分别测试。

### 15.4 长消息性能

风险：高频 Delta、Markdown、Thinking 和 Tool 更新导致 React 重渲染卡顿。

控制：

- Runtime Event 批处理；
- Block 级更新；
- 稳定 key；
- Markdown 完成前采用轻量增量策略；
- 长列表达到阈值后再引入虚拟化，不预先过度复杂化。

### 15.5 App.tsx 和 AgentPanel 继续膨胀

风险：把新布局和 Chat 逻辑继续塞进现有超大组件，后续难维护。

控制：

- 新增清晰模块边界；
- App 只装配；
- Runtime Event reducer 保持纯逻辑；
- UI Block 分组件；
- 不在首个任务中顺带重写所有旧模块。

### 15.6 新旧会话概念冲突

风险：终端 Agent Session、Claude Runtime Session 和 UI Chat Session ID 混用。

控制：

- 三种身份明确命名；
- 共享类型中禁止模糊 `id` 跨层传递；
- 建立显式映射；
- Resume 只使用 Runtime Session Identity。

### 15.7 UI 看起来像 OpenChamber，但行为不一致

风险：只调整颜色和四区结构，却保留旧按钮位置、信息层级和用户路径；或者为了视觉完整展示尚未接通的假能力。

控制：

- 冻结 OpenChamber 参考版本、标准窗口尺寸和逐区域截图；
- UI 对齐按截图、区域尺寸、按钮顺序和交互状态验收；功能接入按真实用户任务验收，两套结果分别记录；
- 权限、Tool、Stop、Resume 必须进入消息时间线；
- Git/Files/Terminal 必须与当前 Workspace 真实联动；
- 尚未接通但影响布局的按钮使用 Disabled + Tooltip，深层非关键入口可以隐藏；
- 不展示尚未接通的假状态，也不允许可点击但无反馈的空操作。

### 15.8 参考产品和预览 Runtime 漂移

风险：开发期间持续追随 OpenChamber 最新 UI，或把 OpenCode Node `next` 预览版重新引入主线，造成范围和运行时反复变化。

控制：

- UI 参考固定到明确 commit/tag，升级参考版本必须作为独立决策；
- OpenCode Node 仅作为观察项或独立实验，不进入当前依赖、任务前置条件和发布路径；
- 正式 Runtime 只依赖固定版本的 Node 24、Claude Agent SDK 和 Cometix；
- 新的上游捷径只有在真实 TSD、Windows 打包和协议回归通过后，才能重新评估。

---

## 16. Go/No-Go 标准

### 16.1 Go

满足以下条件，可以进入正式实现：

- 已确认一个可用的白名单 Node 24 路径；
- 真实 TSD 文件读取成功；
- Agent SDK 可驱动目标 Cometix CLI；
- 能获得结构化 Text 和 Tool 事件；
- Stop 可用；
- Resume 可用或已有明确可接受的限制；
- Permission 可桥接到外部 UI；
- 打包后的 Electron 可以启动和清理 Host；
- 不需要依赖 Bun 或 OpenCode 原生二进制。

UI Shell 的 Mock 开发不以全部 Go 条件为前置；以上条件是进入真实 Runtime 主路径和正式发布的门槛。

### 16.2 Conditional Go

以下情况可继续，但需要缩小 MVP：

- Resume 暂时只能恢复会话身份，历史消息需要单独读取；
- Question 类型在目标版本中不完整；
- Usage/Cost 字段不稳定；
- Effort 或 Plan/Build 只能支持部分模型；
- 内置 Node 不可用，但系统 Node 24 可用。

### 16.3 No-Go 或需要重新选型

- 真实环境没有任何可被白名单识别的 Node 24；
- 企业政策不允许安装或选择外部 Node；
- Agent SDK 无法使用目标 Cometix CLI，且无法在 Host 适配；
- 打包应用无法启动白名单 Node；
- SDK 只能提供等同 PTY 文本的非结构化输出；
- 权限回调无法外置，导致必须回到 CLI 终端交互。

---

## 17. MVP 验收标准

### 17.1 UI 与布局

- 已固定并记录 OpenChamber 参考 commit/tag、标准窗口尺寸和 Light/Dark 基线；
- 左侧显示 Project / Workspace / Session；
- 中央为 Chat；
- 右侧至少有 Git / Files / Context；
- 底部 Terminal 可展开；
- 左右栏和 Terminal 可调整尺寸；
- 切换 Workspace 后四个区域的数据归属一致；
- Light/Dark 下层级清楚；
- 标题栏、区域比例、侧栏层级、Chat Header、Composer、右侧 Tab 和 Terminal Dock 与参考基线高保真对齐；
- 主要按钮的位置、顺序、Hover、Selected、Disabled、Focus 和运行状态与参考一致；
- 每个可见功能入口均有 `已接入 / 基础接入 / 禁用占位 / 暂不纳入` 状态记录；
- 未接功能不会伪装为真实状态，也不存在点击无反馈的空操作。

### 17.2 对话

- 能在当前 Workspace 新建 Claude Session；
- 能发送用户消息；
- 能流式显示 Assistant Text；
- 能显示 Thinking；
- 能显示 Tool Call/Result；
- 能在气泡中处理 Permission；
- 能 Stop；
- 能 Resume；
- 应用重启后能找到历史 Session；
- 运行错误不会清空已产生消息；
- 不依赖 PTY 输出解析生成气泡。

### 17.3 Node/TSD

- 使用 Node 24；
- UI 可看到实际 Node 路径和版本；
- 真实加密工作区中的文件工具可用；
- 打包应用通过验证；
- 应用退出后无孤儿 Host/CLI 进程。

### 17.4 现有能力

- Git 状态仍来自真实当前 Workspace；
- Files 仍可打开和编辑文件；
- Terminal 仍可正常使用；
- Worktree 创建、选择和使用不因新 UI 丢失；
- 其他 Agent 至少保留可用的旧入口，除非另有迁移任务明确替代。

### 17.5 质量门禁

- 关键 Runtime Protocol 和 Chat Reducer 有测试；
- `pnpm typecheck` 通过；
- `pnpm lint` 通过；
- `pnpm build` 通过；
- 真实 TSD 环境回归通过；
- Windows 打包版回归通过。

---

## 18. 正式版完成标准

正式版在 MVP 基础上还应满足：

- UI 不再依赖旧 Chat/File/Terminal/Git 顶部 Tab 作为主导航；
- Claude 默认进入气泡 Chat；
- 新旧模式切换和回滚策略完成；
- 旧 Claude 终端主路径可按决定移除或隐藏；
- Session 恢复稳定；
- Permission/Question 无悬空状态；
- 长会话性能可接受；
- 错误诊断可以定位 Node、Cometix、SDK、TSD、Workspace 和 Session 问题；
- 不存在明显不可达旧分支和重复生命周期逻辑；
- 用户可以在一个工作台内完成“对话 -> 看文件 -> 看 Diff -> 开终端 -> 回到对话”的完整路径。

---

## 19. 推荐默认决策

如果后续没有额外产品决策，建议采用以下默认值：

1. **工程底座**：继续使用 AiClient；
2. **UI 目标**：以固定版本 OpenChamber 为高保真参考真源，对齐外观、区域比例、信息层级和按钮布局，不复制其源码；
3. **首个结构化 Agent**：Claude；
4. **其他 Agent**：暂时保留终端模式；
5. **Node 来源**：优先企业/系统白名单 Node 24；
6. **Cometix**：固定一个验证通过的 release，不自动追最新版；
7. **Host 通信**：stdio + NDJSON；
8. **Chat 状态**：新建独立 Store，不强塞入旧终端 Session Store；
9. **Worktree**：保留，降级为 Workspace 类型；
10. **Terminal**：保留，移动到底部 Dock；
11. **Git/Files**：复用现有能力，移动到右侧；
12. **Context**：首版只展示真实基础上下文；
13. **历史**：先保证 Session 可发现和 Resume，再逐步提升历史消息完整度；
14. **发布**：开发期保留新旧 Claude 模式开关；
15. **UI 开发**：通过 Mock Event 与 Runtime 并行推进，不等待完整 Host；
16. **未接功能**：影响布局的入口保留并禁用，深层非关键入口可隐藏，禁止假状态和空操作；
17. **OpenCode Node**：`next` 预览版仅作为观察项，不作为当前正式 Runtime 依赖；
18. **验收**：UI 高保真对齐按参考截图、尺寸和状态验收；功能按真实用户路径和真实 TSD 环境验收。

---

## 20. 证据与参考位置

### AiClient

- `docs/architecture.md`：现有 Electron、Renderer、Git、File、Terminal、Worktree 和 Agent 架构；
- `docs/design-system.md`：UI 组件、Tailwind 4、OKLCH 和设计约束；
- `src/renderer/App.tsx`：当前仓库、Worktree、顶层布局和页面调度；
- `src/renderer/components/layout/MainContent.tsx`：当前 Chat/File/Terminal/Source Control Tab 调度；
- `src/renderer/components/chat/AgentPanel.tsx`：当前 AgentTerminal、终端 Session、分组、输入和 StatusLine；
- `src/main/services/claude/ClaudeSessionScanner.ts`：TSD JSONL 检测和系统 Node 读取路径；
- `src/main/utils/tsdSafeRead.ts`：打包 Electron 无法解密、系统 `node.exe` 可读取的现有处理；
- `src/main/services/claude/ClaudeIdeBridge.ts`：当前 Claude IDE Bridge；
- `src/main/services/git/`：现有 Git 能力；
- `src/renderer/components/files/`：现有文件树和编辑器能力；
- `src/renderer/components/terminal/`：现有终端能力。

### OpenChamber

- `packages/ui/src/components/layout/MainLayout.tsx`：左侧 SessionSidebar、中央区域、ContextPanel、BottomTerminalDock 和右侧栏；
- `packages/ui/src/components/layout/RightSidebarTabs.tsx`：右侧项目上下文和 Tab；
- `packages/ui/src/components/session/sidebar/hooks/useSessionGrouping.ts`：Project Root、Worktree 和 Session 分组；
- `packages/ui/src/sync/bootstrap.ts`：OpenCode SDK 的 project/session/mcp/lsp/vcs/question/permission 依赖；
- `packages/ui/src/sync/event-reducer.ts`：session、permission、question 等全局事件处理；
- 以上依赖说明 OpenChamber UI 不是可脱离 OpenCode 数据层直接复用的纯 UI 包。

### OpenCode Node 预览路线

- 官方 `dev` 分支已存在 `target: node` 构建入口和 Node Server 导出；
- npm `opencode-node` 当前仍以 `next` 预览版本和平台可执行文件分发；
- Windows 平台入口不等同于直接使用企业白名单系统 `node.exe`；
- 本路线可能在未来降低集成成本，但当前不稳定性、TSD 白名单和 Agent 语义差异使其不适合作为正式交付前提。

### Cometix Claude Code

- Releases：<https://github.com/CometixSpace/claude-code/releases>
- 实施时必须记录实际采用的 release、文件来源和 SHA256；
- 不在本方案中写死“永远使用最新版”，因为 Node 要求和 SDK 兼容性可能随 release 变化。

---

## 21. 最终边界

本方案要实现的是：

> **让 AiClient 在外观、布局、区域比例、信息层级和按钮位置上与固定版本 OpenChamber 高保真对齐，成为以对话为中心的桌面 Agent 工作台；同时继续使用 AiClient 已有的本地开发能力，并满足企业 TSD 环境必须通过 Node 24 执行 Claude 的约束。**

本方案不要求：

> 把 AiClient 变成 OpenChamber 的分支，不要求兼容 OpenCode SDK，也不要求一次性接通 OpenChamber 的所有功能。功能可以分阶段交付，但不能以功能未接入为由改变已冻结的关键布局和按钮位置。

后续选择任务时，产品基线 A01～A06 与技术门槛 B01～B06 并行启动；最优先的产品闭环是：

```text
Workspace
  -> Session
  -> Bubble Chat
  -> Tool/Permission
  -> Git/Files
  -> Terminal
  -> Resume
```

只要该闭环在真实 Node 24 + TSD 环境中成立，就达成了本次重构的核心目标。
