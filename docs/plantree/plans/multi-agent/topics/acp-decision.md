# Topic — ACP 接不接：判断依据与证据链

> 结论产生于 2026-08-04 会话，2026-08-05 补落库。事实均已复核（复核标记见各条）。

## ACP 是什么

**一个统一插头**：让「加第 3、第 4、第 5 个 agent」从「每个写一套输出解析」变成「填一行怎么启动它」。
说 ACP 的 agent 输出格式一致，客户端只写一次消费端。

## 成本曲线：省的是解析器，从第 3 个 agent 开始摊平

| 路线 | 第 1、2 个 agent | 第 3 个起 |
|---|---|---|
| 不接 ACP | 每个 agent 写一个驱动读懂自己的输出格式（Claude = SDK 事件流，Codex = 自己的 JSON） | 加一个写一个 |
| 接 ACP | **不省钱**——写第一个解析器的成本 ≈ 写 ACP 客户端的成本 | 加一个 agent ≈ 注册一行命令 |

**所以：只做 Claude + Codex 两个的话，ACP 基本没用。**
它的全部价值押在「以后还要加更多 agent」这个假设上。

软收益（不计入硬账）：codeg 那 12 个 agent 踩过的坑都在 ACP 生态里，跟着走能少踩。

## Claude 线不走 ACP —— 证据链

**codeg 接 Claude 用的 `@agentclientprotocol/claude-agent-acp`，本质就是我们 `src/agent-host` 的第三方版本。**

```
codeg（Rust）  ←--ACP--→  claude-agent-acp（node）  ←--Claude Agent SDK--→  cli.js → Anthropic
我们（Electron）←--自建 NDJSON--→  src/agent-host（node）  ←--同一个 SDK--→  cli.js → Anthropic
```

同一个 SDK：codeg pin 适配器 `0.64.1`（其内用 SDK `0.3.220`），我们 `src/agent-host/package.json:18` 用 `0.3.218`，差两个补丁版本。
唯一区别是对外说 ACP 还是说我们自己的 NDJSON。

**直连红利的实例（同一件事，两条路的代价）**——拿到子 agent 实况：

| | 我们（直连 SDK） | codeg（经 ACP 适配器） |
|---|---|---|
| 做法 | `forwardSubagentText` 翻 `true`（`sdk.d.ts:1619`，✅ 已复核我们装的 0.3.218 就有） | 等适配器把 `_meta.claudeCode.parentToolUseId` 透出来 |
| 前提 | 无 | 适配器 ≥ 0.63.0 + 双方协商一个开关；版本不到就没有 |

同理，网络重试详情我们已经在 store 里（`chatSessions.ts:85` 的 `retry` 字段，✅ 已复核），
走 ACP 反而要靠适配器的私有方法 `_claude/sdkMessage` 才拿得到。

**结论：Claude 这条线往 ACP 上挪是净损失。** 本结论待升格为编号决策。

## ~~唯一待决问题~~ → **2026-08-06 已裁定：不接 ACP，直连 `codex app-server`**

原问题：**接 Codex 的时候，让 ACP 帮我们省掉「解析 Codex 输出」，还是自己直连解析？**
判据只有一个 —— **三个月内打不打算加第 3 个 agent**（打算 → 接 ACP；不打算 → 直连）。

**用户 2026-08-06 答复「不打算，就 Claude + Codex 两个」**，加上同日 S1 spike 的实测数据，
[open-questions #1](../open-questions.md) 已关闭。完整推导见
[S1 spike 报告](../../../../plans/2026-08-06-s1-acp-codex-spike-report.md)。

### 本 topic 被 S1 实测校正 / 坐实的三处

| 本文原有的说法 | S1 实测 | 判定 |
|---|---|---|
| 「写第一个解析器的成本 ≈ 写 ACP 客户端的成本，所以对第 1、2 个 agent 不省钱」 | 两条路的 JSON-RPC 客户端都是 **~120 行**且形状几乎相同（同为按行分隔 JSON-RPC 2.0 over stdio）；归一化器净新增同为 **300–420 行** | ✅ **坐实** |
| 上表「接 ACP：第 3 个起加一个 agent ≈ 注册一行命令」 | **不成立**。codeg 实证：`binary_cache.rs` 902 行迷你包管理器、`preflight.rs` 766 行 ≥9 类体检、Hermes 锁 Python 3.13、Grok 镜像滞后 + flag 顺序、Cursor symlink 与 Grok 同名 CLI 互相覆盖、全仓 **83 处 workaround 关键词命中** | ⚠️ **摊销模型被削弱**：映射侧每 agent 省 360–520 行，但**安装/preflight 侧的边际成本可能吃掉它** |
| 「ACP 省的是解析器」 | codeg **接了 ACP 仍要写 508 行** `emit_conversation_update`（`connection.rs:8026`）装 13 个分支，其中单一 ToolCall 分支 145 行 / ≥7 处逐 agent 特判 | ❌ **「接 ACP 就不用写解析器」是假命题** |

### S1 新增的、本文原先没有的三条

1. **ACP 对 Codex 没有提供抽象，只提供了一层转发。** 审批的关键数据（reason / command /
   commandActions / proposedExecpolicyAmendment / availableDecisions）在 ACP 里落在
   **无 schema 的 `_meta.codex`**；直连侧同一份数据是**有 JSON Schema、有生成 TS 类型的一等契约**。[实测]
2. **ACP 是有损投影**：codex-acp 用自己的 3 档 `AgentMode` **完全覆盖 `~/.codex` 的 approval/sandbox 配置**，
   丢掉 `applyNetworkPolicyAmendment`、`granular`、`approvalsReviewer`。[实测]
3. **直连的契约漂移可机器检测**：`codex app-server generate-json-schema` / `generate-ts` 产出
   47 schema + 300 v2 类型 + 99 TS 绑定 → 可做 CI 快照 diff。
   原推导里「直连要自己扛契约漂移」这条成本，**实测后降级为可自动化的成本**。[实测]

### 直连红利表的一处扩展

本文原有的「直连红利」表（子 agent 实况 / 网络重试）在 **Codex 侧同样成立**：
直连 `thread/tokenUsage/updated` 给 **total + last 各 6 字段 + modelContextWindow**，
ACP `usage_update` 只给 **`{used, size}`** —— 同一个 `usage.updated` 事件，**填充密度差 6 倍**。[实测]

## 与「三条能力缺失」的关系：无关

2026-08-04 同一轮识别出三条缺失，**全部独立开发，与 ACP 无关**，走 ACP 反而更绕：

| 缺什么 | 数据在哪 | 要做什么 | 走 ACP 会怎样 |
|---|---|---|---|
| 网络重试提示 | 已在 store（`chatSessions.ts:85` `retry`） | 加一个横幅，纯前端 | 更难：靠适配器私有方法 `_claude/sdkMessage` |
| 子 agent 实况 | Claude SDK 消息的 `parent_tool_use_id`，我们没接 | 开 `forwardSubagentText` + 协议加可选字段 + UI 分组 | 更难：私有数据 + 适配器 ≥0.63.0 + 协商开关 |
| 失败诊断（stderr 进 UI） | 已在 Host 日志（`[cli-stderr]`） | 开一条事件推前端 + 脱敏 | 一样，与协议无关 |

三条均已进 [roadmap Next](../roadmap.md)。

### 子 agent 实况的三处不打包票

1. **未实测真实子 agent 消息流** —— 上述形状由 SDK 类型定义与文档注释推出，跑一次才知道对不对。
2. **开关打开后事件量会涨**（子 agent 完整对话都进来）——有 16ms 批处理队列兜着，风险不大但要看一眼。
3. **历史重放会塌** —— resume 读 Claude 的 JSONL，`HistoryBlock` 里没有子 agent 归属这个概念。
   后果：当场看是嵌套的，关掉重开变平铺。与问答卡 D20 是**同一个协议缺口**，要修得扩历史协议（C-17，本就后置）。

> 一处已纠正的口径：现状**不是**「子 agent 文本混进主气泡」，而是**文本根本收不到**
> （`forwardSubagentText` 默认 false）；但子 agent 的 tool_use / tool_result **会**收到，
> 且被当成主 agent 干的——Claude 跑 Task 时，子 agent 的 Read/Grep/Bash 显示成主 agent 的工具行。
