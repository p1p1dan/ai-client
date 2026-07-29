# CONTEXT — AiClient OpenChamber 风格重构

> 术语表（glossary）。只定义领域术语，不放实现细节、不放决策。决策见 `docs/adr/` 与 ARD。
> 实施进度台账：`docs/plans/openchamber-chat-refactor-ledger.md`（按关键节点更新，勿与术语表混写）。

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

## 工作台布局（2026-07-28 D19 起）

- **surface**：可挂进 `ContextPanel` 的一类工作面（OpenChamber `lib/surfaces/registry.ts` 注册 11 种：`editor / git / pr / diff / terminal / plan / notes / context / browser / preview / chat`）。同一时刻只显示一种，可提升为覆盖 Main 的全视图。**终端是一种 surface，不是底部面板。**
- **ContextPanel**：三列布局中的右列，surface 的容器。宽度 min 380 / max 1400，默认宽度按 surface 类型取可用宽度比例；收起时列宽 0。
- **ContextPanelRail（导轨 / Rail）**：最右侧固定 44px（OpenChamber `w-11`）的图标竖条，用于单选切换 surface；图标可拖拽排序。**参考实现里只有 `git` surface 在有变更文件时于图标右上角亮 6px 圆点**（`var(--status-info)`），其余 surface 未做内容指示。
- **阅读栏**：中列 Chat 的内容宽度约束，消息时间线与 Composer 共用一条：`width: min(100%, 48rem)` 居中，宽模式 64rem。

## 视觉与主题（两层，勿混淆）

- **Ghostty 主题**：AiClient 现有的终端主题源格式（INI 风格，16 ANSI 调色板 + bg/fg/cursor）。`resources/ghostty-themes/` 带 438 个社区主题，`scripts/generate-themes.ts` 解析为 `terminal-themes.json`，驱动 xterm.js 终端 + Monaco 编辑器配色。终端调色板导向。**是否随 D18 一并 Flexoki 化尚未裁定（plantree open-questions #12），裁定前原样不动。**
- **Flexoki**：Steph Ango（kepano）的完整 UI 语义色板（primary/surface/interactive/status/pr/syntax/markdown/chat/tools），暖中性低对比。亮 bg `#fffdf4` / fg `#100F0F` / primary `#BC5215`；暗 bg `#171515` / fg `#CECDC3` / border `#343331` / primary `#DA702C`。OpenChamber 的默认主题；**自 D18 起是 AiClient 应用壳的 MVP 硬性目标，不再是可选后续主题**。应用壳语义导向。
- **应用壳语义 token**：`globals.css` 里的 OKLCH CSS 变量（`text-primary`/`bg-accent`/`text-muted-foreground` 等），驱动整个 UI 外壳。与 Ghostty 主题是两层，解耦；两层的边界（Monaco 是否继续跟随 Ghostty）待 open-questions #12 收口。
- **对齐 OpenChamber** = 对齐其 **UI 架构 + 布局 + 观感**三者（2026-07-28 D18 / D19 口径；原「只对齐架构与布局、非色调风格严格一致、Flexoki 仅作可选后续主题」的 D6 口径已撤销）。具体含：三列 + 44px 图标导轨、**无底部面板**的 surface 模型；Project/Workspace/Session 导航；对话时间线/工具行/问答卡/Composer 交互结构；**以及 Flexoki Light/Dark 主题与全等宽字体**（sans / mono / heading 统一 `ui-monospace`）。

## 数据层（命名对照，避免混淆）

- **sync/store（OpenChamber 的）**：OpenChamber 的传输 + 数据摄取层（68 文件）+ 状态层（`useUIStore` 2137 行）。硬绑定 `@opencode-ai/sdk`，通过 HTTP+WS 连 OpenCode 服务端，与 Claude 无关。**本重构不拷贝**。
- **Chat Store（我们的）**：AiClient 自建的 Zustand store，消费 `Runtime Event`，承载 Session/Message/Block 状态。

## 对话领域对象

- **Message**：一条用户/助手/系统/错误消息，由有序 `Block` 组成。
- **Block**：Message 内的最小单元，候选类型：text / thinking / code / tool_call / tool_result / permission_request / question_request / file_reference / diff / usage / notice / error。
- **Permission Request**：Claude 工具调用前的权限确认。一次请求只能被响应一次。
- **Question Request**：Claude 向用户提出的选项/自由文本问询。一次请求只能被响应一次。
