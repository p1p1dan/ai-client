# 从 Claude Code / Codex 导入对话

Role: implementation-plan。日期：2026-09-10。依据：用户 2026-09-10 决定「Claude 和 Codex 的历史对话可以直接导入到我们的 app，用户可以看可以继续对话」「主要就是对话历史（可以作为继续聊的上下文），其他的什么工具调用什么的不重要」，并要求参考 PI-Desktop 的做法。父节点：[外部 Agent 迁移](external-agent-migration.md)。

## PI-Desktop 是怎么做的（实读，非推测）

`apps/desktop/electron/main/importers/`，四个导入器（claude / codex / opencode / pi）+ 一个注册表，**总共 1047 行**，其中 claude 199 行、codex 221 行。结构很轻：

- **两段式**：`scan()` 扫出候选摘要（标题、项目路径、模型、时间、条数），`convert()` 才真正解析整个文件。界面先拿摘要列表让用户勾。
- **导入结果不是只读的**。`session.import` 在 Rust 侧把它写成**一条普通的原生会话**：写 transcript 文件 + `INSERT INTO sessions`（`provider_id` / `model_id` 为 NULL、`mode='agent'`）+ 每条记录的索引行。所以「能接着聊」不是额外做的功能，是写成原生格式之后自然就有的。
- **幂等靠两层**：TS 侧确定性 id `import-<source>-<externalId>`，Rust 侧 `session_import_origins` 表对 `(plugin_id, source_id, external_id)` 加唯一约束，重复导入是 no-op。
- **合成消息要滤**。Claude Code 会注入以 `<` 开头的 user 行（caveat、system-reminder、斜杠命令回显），Codex 额外有 `# AGENTS.md` 和 `You are Codex` 开头的。不滤的话导入的对话第一条全是噪音。
- 它**也导入模型配置**（`modelConfigImportScan/Run`），与会话导入是两条独立通道。本轮用户已决定不做配置迁移。

## 本轮决定：转写成 pi 自己的 v4 会话文件

落点 `<appAgentDir>/sessions/<编码后的cwd>/`，就是 pi 自己的会话目录。

这条是整个方案的支点，理由与 PI-Desktop 同构：**写成原生格式之后，「能看」和「能续聊」都不用单独做**。pi 本来就从会话文件恢复上下文；H/19 U3 又把 GUI worker 与内嵌 TUI 统一到同一个 sessions 目录，所以导入的会话在两边都能列出来。反过来，如果另起一套「导入会话」存储，就要再实现一遍列表、打开、恢复上下文，还要回答「它能不能发送」——那正是 PI-Desktop 用一张 `sessions` 表避开的坑。

**不手搓 JSON**：v4 行有 `seq` / `lane` / parent 链，H/20 实测过链接不上时的报错（`entry does not chain to lane`、`non-consecutive seq`）。一律走 `src/runtime/plugins/session/codec.ts` 的编码路径。

## 范围：只要对话文本

用户明确「工具调用什么的不重要」，据此砍掉的东西同时砍掉了最大的风险源——跨厂商的工具调用格式映射。

| 项 | 处理 |
|---|---|
| user / assistant 文本 | **导入**。Claude 取 `content` 里的 text 块；Codex 取 `input_text` / `output_text` / `text` |
| 工具调用与结果 | **丢弃**（Claude 的 `tool_use` / `tool_result`，Codex 的 function call） |
| 附件 | **丢弃**。Claude 的 `attachment` 行在本机样本里占 1120/3338，量很大但对续聊无用 |
| 子代理旁支 | **丢弃**。Claude 的 `isSidechain === true` |
| 合成注入文本 | **丢弃**。user 文本以 `<` 开头；Codex 另加 `# AGENTS.md`、`You are Codex` 开头 |
| 分支（Claude 的 `parentUuid` 树） | **首版不处理**，按文件顺序线性取——与 PI-Desktop 一致。代价见下 |

**分支这条是已知取舍，不是遗漏**：Claude 的消息按 `parentUuid` 构成树，用户编辑重发会产生分叉。按文件顺序线性读，会把被放弃的那条分支也读进来，表现为对话里出现「问了两次类似的问题」。真要正确处理得从最新叶子回溯到根。首版接受这个代价，因为它只影响观感，不影响续聊。

## 实测的两边格式（本机，2026-09-10）

**Claude Code** `~/.claude/projects/<编码后的cwd>/<uuid>.jsonl`，样本一条会话 3338 行：

- 类型分布：`attachment` 1120、`assistant` 896、`user` 570、`system` 21，外加每回合一组元数据（`ai-title` / `agent-name` / `mode` / `permission-mode` / `atis-latch` / `last-prompt` 各 118）。
- 消息带 `uuid` / `parentUuid` / `cwd` / `timestamp`；`message.content` 可能是字符串，也可能是块数组。

**Codex** `~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<uuid>.jsonl`，本机 10 个文件，样本 263 行：

- 类型分布：`response_item` 192、`event_msg` 68、`session_meta` 1、`world_state` 1、`turn_context` 1。
- 新格式外层包 `{timestamp, type, payload}`；PI-Desktop 的导入器还兼容一种旧格式（首行是裸 session header、条目是裸行）。

**订正一条此前的判断**：父文档一度写「Codex 的历史有相当部分在 sqlite 里，形状完全不同，按 Claude 的成本估会估错」。**这是错的**——`~/.codex` 下那些 `thread_history_1.sqlite` / `memories_1.sqlite` 是别的状态，对话记录就在 `sessions/` 的 JSONL 里，PI-Desktop 读的正是它。Codex 与 Claude 的成本基本同级。

## 开工第一件事：这套东西大半已经在仓库里了（2026-09-11 实读订正）

**本文原先按「从零做 C1～C6」写，这是错的。** 开工前通读代码发现，T34（`dd74b1ae` / `40538e1e`，2026-09-01 与 09-09）已经落过一整条 Claude + Codex 导入链路，只是**没有任何界面能到达它**：

| 已有 | 位置 |
|---|---|
| 两个读取器 + 两个扫描器 | `src/main/services/legacyImport/`（`ClaudeSessionScanner` / `ClaudeSourceAdapter` / `CodexSessionScanner` / `CodexRollout` / `CodexSourceAdapter`） |
| 写成 pi 原生会话 | `src/agent-host/piLegacyImport.ts`——暂存目录里建会话、校验后 `rename` 原子发布、发布前后各 preflight 一次 |
| 幂等 | `LegacyImportManifest`（内容指纹做 dedupeKey）+ 崩溃后 reconcile |
| IPC / preload / hooks / 一个完整视图 | `ipc/legacyImport.ts`、`hooks/useLegacyImport.ts`、`components/sessions/SessionManagerView.tsx` |

`SessionManagerView` 全仓**没有一处挂载**（只有 `index.ts` 的导出和一个静态扫描测试引用它）。所以 C1／C2／C4 基本是「已有且有测试」，真正缺的是下面标注的四项。

这一条同时是对本文与 [父文档](external-agent-migration.md) 的订正：两处都把 P3/P4 记成「待做」，实际是「做了一大半、没接线」。

## 执行清单

- [x] C1：两个读取器。**已有**；本轮补了两件事：Codex 的**旧格式**（首行裸 header、条目是裸行，`CodexRollout.ts`）此前直接解析失败被当成坏文件跳过；合成注入的判据对齐 PI-Desktop（`<` / `# AGENTS.md` / `You are Codex` 开头）。
- [x] C2：扫描与候选列表。**已有**，两段式（`scan` 只读摘要、`convert` 才解析全文），IPC 异步不阻塞界面。
- [x] C3：转写成 pi 原生会话文件。**已有**（走 pi SDK 的 SessionManager 而非手搓 JSON，落在本应用 agent 目录的 `sessions/<编码 cwd>/`）；本轮补上**工作区匹配与未绑定回退**，见下。
- [x] C4：幂等。**已有**（内容指纹 dedupeKey + manifest + 索引行交叉校验）；本轮真机验证重复导入报「已存在 1 个」。
- [x] C5：界面。**本轮新做** `ConversationImportSettings.tsx`（`2715b9a6`），挂在设置 · Pi 的迁移段落之后。
- [x] C6：验证。离线探针跑真实样本 + 真机闭环，结果见[点验记录](../evidence/external-agent-migration/README.md#c1c6-对话导入2026-09-11)。

### C3 补的那一块：匹配不到仓库就落为临时对话

原文这一句（「工作区按 cwd 匹配已注册仓库，匹配不到落为未绑定」）此前没有实现，而它**不是可选的**：`sessionIndexMerge.ts` 把 workspacePath 匹配不到任何已注册工作区、又没有 `unbound` 标记的行当作孤儿**直接丢弃**——会话导入成功、磁盘上有文件、侧栏里一行都看不到。

做法：

- 谁来判断「已注册」：只有渲染层有工作区列表，所以由它在请求里带一个 `workspaceMatched` 布尔值。
- 谁来决定落点：主进程。匹配不上（或目录已不在磁盘上）就用 `ScratchWorkspaceService` 分配一个隔离目录，并把会话转写到那里。
- 谁来写 `unbound`：仍然只有主进程，且判据仍是 `isScratchPath`——U05-c 的规矩没被绕开，渲染层给的是线索不是结论。
- 用户看到什么：项目行上一个「未匹配到仓库」徽标，进去后一行「这个目录不在本应用的项目列表里，所以这些对话会作为临时对话导入」，**都在按下导入之前**。

### C1 顺带修的一条：标题不能是 `/clear`

离线探针跑本机真实历史时，最近几条 Claude 会话的标题全是 `/clear`——斜杠命令回显本身是一条 user 消息，而它排在第一条。验证案例 1 要求标题取第一条**真实**用户消息，所以 `ClaudeSourceAdapter` 改成：命令回显仍留在正文里（它是历史的一部分），但只有真实用户文本才能当标题；整场都是命令时退回命令名，再退回通用兜底。

## 验证案例

结论逐条见[点验记录](../evidence/external-agent-migration/README.md#c1c6-对话导入2026-09-11)；这里只留判据。

1. ✅ 有 Claude 历史的机器上能扫出会话，标题取第一条**真实**用户消息（不是 `<local-command-caveat>` 那种）。
2. ✅ 导入后出现在侧栏，打开能看到历史文本；合成注入不出现，工具调用只作为只读条目出现、不进模型上下文。
3. ✅ **在导入的会话里发一条消息能正常回复**——「可续聊」的唯一硬验收，已闭环。绑定仓库的那条与未绑定的临时对话各发一条，`claude-sonnet-5` 都给出了**基于导入历史**的回答（未绑定那条准确复述了原对话在解决什么问题）。此前一次失败是用户本人的 maxapi 账户余额用尽，属预期。
4. ✅ 重复导入同一条不产生第二份，结果汇总如实报跳过。
5. ✅ 没有 `~/.claude` / `~/.codex` 的机器上明确显示「没有可导入的会话」（测试覆盖；本机两份都在，无法真机复现空机器）。
6. ✅ 内嵌 TUI 也能列出导入的会话——导入文件就落在 `<appAgentDir>/sessions/<编码 cwd>/`，与 GUI 同一个目录（磁盘核对）。
7. 🟡 Codex 的两种格式都能读。新格式真机验证；**旧格式只有构造用例**——本机 10 个 rollout 全是新格式，没有旧格式样本可跑。

## 风险

- **v4 链式写入**。seq / lane / parent 接不上时的报错在 H/20 实测过（[记录](../evidence/gui-tui-session-interop/README.md)）。必须走 `codec.ts`，且要有一条「导入后立刻用真实读取器读回来」的用例。
- **大文件**。3338 行只是一条会话；扫描全量要异步并给进度，否则界面会卡。
- **`cwd` 匹配不到仓库**。Claude 的会话可能来自用户还没在本应用注册的目录。落为未绑定是安全解，但要在列表里如实显示「未匹配到仓库」，不要静默。
- **模型归属**。导入的会话不带 provider / model（PI-Desktop 也置 NULL），首次发送用当前默认模型。要确认这不会撞上 H/19 点验查出的 `Pi model not found`。

## 范围外

不做配置迁移（用户 2026-09-10 决定）。不做工具调用与附件的还原。不做分支还原。不做反向导出。不做 opencode（PI-Desktop 有，本轮没需求）。
