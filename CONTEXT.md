# CONTEXT — AiClient OpenChamber 风格重构

> 术语表（glossary）。只定义领域术语，不放实现细节、不放决策。决策见 `docs/adr/`。

## 运行时

- **Agent Host**：独立于 Electron 主进程的外部 Node 24 进程，载入 Claude Agent SDK 并驱动 Cometix CLI。与 Electron Main 之间通过 stdio 上的 NDJSON 交换命令与事件。Renderer 不直接接触它。
- **Cometix**：`@cometix/claude-code`，把官方 Claude Code 从 Bun SEA 二进制提取、打补丁改回 Node.js 运行的版本。等价于"正版 CC，node 可跑"。
- **白名单 Node 24**：TEC/OCular/TSD 加密环境中被放行、能读到解密字节的系统 `node.exe`（v24）。打包后的 Electron 主进程 exe 不在白名单内（见 `src/main/utils/tsdSafeRead.ts`）。
- **Runtime Event**：Agent Host 规范化后吐出的稳定事件形状，喂给 Renderer 的 Chat Store。是 AiClient 自己的协议，**不是** `@opencode-ai/sdk` 的 Event。

## 导航与工作单元

- **Project**：一个仓库或可工作的项目根。左栏顶层。
- **Workspace**：具体工作目录，是 Session 的容器。类型包括 `Main`（主工作树）、`Worktree`（git worktree）、`Remote`（远程目录）、`Temp`（临时目录）。结构上等价于 OpenChamber 的 `SessionGroup`。
- **Worktree**：git worktree。在本重构中保留为 `Workspace` 的一种类型（`Workspace.kind = worktree`），不再作为整个产品的唯一顶层主角。是 AiClient 的招牌能力，不放弃。
- **Session**：绑定在某个 `Workspace` 上的 Claude 对话。一个 Workspace 可有多个 Session。

## 视觉与主题（两层，勿混淆）

- **Ghostty 主题**：AiClient 现有的终端主题源格式（INI 风格，16 ANSI 调色板 + bg/fg/cursor）。`resources/ghostty-themes/` 带 438 个社区主题，`scripts/generate-themes.ts` 解析为 `terminal-themes.json`，驱动 xterm.js 终端 + Monaco 编辑器配色。终端调色板导向。
- **Flexoki**：Steph Ango（kepano）的完整 UI 语义色板（primary/surface/interactive/status/pr/syntax/markdown/chat/tools），暖中性低对比，橙 `#DA702C`/bg `#171515`/border `#343331`/fg `#CECDC3`。OpenChamber 30 套主题对之一，作为默认/旗舰。应用壳语义导向。
- **应用壳语义 token**：`globals.css` 里的 OKLCH CSS 变量（`text-primary`/`bg-accent`/`text-muted-foreground` 等），驱动整个 UI 外壳。与 Ghostty 主题是两层，解耦。
- **对齐 OpenChamber** = 对齐其 **UI 架构与布局**（四区结构、Project/Workspace/Session 导航、对话时间线/卡片/Composer 交互结构），**非色调风格严格一致**。色调沿用 AiClient 现有 OKLCH 设计系统；Flexoki 仅作可选后续主题。

## 数据层（命名对照，避免混淆）

- **sync/store（OpenChamber 的）**：OpenChamber 的传输 + 数据摄取层（68 文件）+ 状态层（`useUIStore` 2137 行）。硬绑定 `@opencode-ai/sdk`，通过 HTTP+WS 连 OpenCode 服务端，与 Claude 无关。**本重构不拷贝**。
- **Chat Store（我们的）**：AiClient 自建的 Zustand store，消费 `Runtime Event`，承载 Session/Message/Block 状态。

## 对话领域对象

- **Message**：一条用户/助手/系统/错误消息，由有序 `Block` 组成。
- **Block**：Message 内的最小单元，候选类型：text / thinking / code / tool_call / tool_result / permission_request / question_request / file_reference / diff / usage / notice / error。
- **Permission Request**：Claude 工具调用前的权限确认。一次请求只能被响应一次。
- **Question Request**：Claude 向用户提出的选项/自由文本问询。一次请求只能被响应一次。
