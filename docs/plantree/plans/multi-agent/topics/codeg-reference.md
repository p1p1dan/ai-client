# Topic — codeg 参照事实

> 参照物：**`/home/dan/projects/codeg`（本机路径，非外部链接）**。
> 用户 2026-08-04 提出「它的 UI、产品功能、设计思路和用户画像与本项目十分接近，且已支持多 agent」。

## 它是什么

Tauri 应用：前端 Next.js + React（`src/`），后端 Rust（`src-tauri/`）。
与我们的 Electron + React + node agent-host 是同一产品形态、不同技术栈。

## agent 接入方式（✅ 已复核 file:line）

- 内置 12 个 agent：`claude_code / codex / open_code / gemini / open_claw / cline / hermes / code_buddy / kimi_code / pi / grok / cursor`
  （`src-tauri/src/models/agent.rs:213` 起的 wire 名表；wire 名持久化进 `conversation.agent_type`，改名即孤立历史行）
- 另有**自定义 agent 注册表**（`custom:<id>` wire 形式，id 同时用作文件系统路径分量，故有严格 slug 校验）
- 全部经 **ACP 适配器**接入，适配器版本 pin 在 `src-tauri/src/acp/registry.rs`：
  - `@agentclientprotocol/claude-agent-acp@0.64.1`
  - `@agentclientprotocol/codex-acp@1.1.9`
- **关键细节**：`codex-acp` **内嵌**自己的 `@openai/codex`（`node_modules/@openai/codex`），
  codeg 启动的是这个嵌套的 codex，**不是 PATH 上的 codex**（PATH 上的往往是版本不同的独立安装）。
  模型目录也从这个嵌套 codex 抓（`codex debug models --bundled`）后落盘缓存
  （`src-tauri/src/acp/codex_catalog_source.rs:1-15`）。
- 适配器不是白拿：registry.rs 里带着一串版本坑注释，例如
  `claude-agent-acp` 0.64.0 的 `injected` 结果不可靠（上游 issue #934）、
  `codex-acp` 从 zed-industries 的 Rust 二进制迁到 npm、1.1.5 收紧了 MCP 配置过滤等。
  **这些坑是「接 ACP」的隐性成本**，与 [acp-decision](./acp-decision.md) 的成本曲线一并看。

## 用户明确认可的形态（2026-08-05 原话拆解）

| 用户认可的点 | 我们的现状 | 差距 |
|---|---|---|
| 左侧文件树：**文件夹 → 会话**，会话上可区分所用 CLI | 两级结构**已具备**（`sidebarTree.ts`，T-26 / D21） | 只缺 **CLI 维度**（会话行 chip 已有机制，同构扩展） |
| 聊天内可切 **claude / codex** | 气泡链 **Claude 专用**（ARD 明写「仅 Claude 进气泡，其他 Agent 暂留终端模式」） | 需会话绑 agent + Composer 切换入口 |
| **模型与思考级别**按 CLI 适配 | `useSessionModel` / `useSessionEffort` 为 Claude 单轨 | 需按 agent 分目录（Codex 模型目录来源见上） |
| **权限模式管理** | T-14 只做了**只读展示**（context surface 的权限策略行） | 需管理面 + 按 agent 的策略语义差异（Claude permissionMode vs Codex sandbox/approval） |
| **右侧 git 功能与展示形式** | git surface 为**最小集**（changed/staged/diff/commit） | 待细化——用户未指明具体喜欢哪几项；A08 曾规划 branch/pr/sync/stash 全套但按最小集纪律砍掉 |

> ⚠️ 最后一行是**未闭合项**：用户表达了偏好但未指明具体点，且 2026-08-05 同轮又裁定
> 「git tab 保留当前最小集」。两者不矛盾（一个是远期偏好，一个是本阶段范围），
> 但要扩 git 能力时必须先取回具体参照点 → [open-questions #4](../open-questions.md)。

## 我们已知比它好的地方

**Claude 线直连 SDK**：拿子 agent 实况我们翻一个布尔值，它要等适配器透字段 + 双方协商开关。
详见 [acp-decision](./acp-decision.md) 的「直连红利」表。
