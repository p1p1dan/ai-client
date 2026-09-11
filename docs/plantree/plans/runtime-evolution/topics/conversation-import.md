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

## 执行清单

- [ ] C1：两个读取器（Claude / Codex），产出统一的中间形状 `{ 会话摘要, 消息[] }`。纯函数，输入是文件内容，可用真实样本做用例。
- [ ] C2：扫描与候选列表。异步，不阻塞界面——单文件 3338 行、可能有几十个文件。
- [ ] C3：转写成 pi v4 会话文件，走 `codec.ts`，落到本应用 agent 目录的 sessions 下。工作区按 `cwd` 匹配已注册仓库，匹配不到落为未绑定（临时对话）。
- [ ] C4：幂等。确定性 id `import-<source>-<externalId>`，已导入的跳过并在结果里如实报「跳过 N 条」。
- [ ] C5：界面。设置页迁移段落新增「从 Claude Code / Codex 导入」：扫描 → 列表（标题 / 项目 / 时间 / 条数）→ 勾选 → 导入 → 结果汇总。复用 H/19 的两段式与冲突呈现。
- [ ] C6：验证（含用真实样本跑一遍闭环）。

## 验证案例

1. 有 Claude 历史的机器上能扫出会话，标题取第一条**真实**用户消息（不是 `<local-command-caveat>` 那种）。
2. 导入后出现在侧栏，打开能看到历史文本；合成注入、附件、工具调用都不出现。
3. **在导入的会话里发一条消息能正常回复**——这是「可续聊」的唯一硬验收。
4. 重复导入同一条不产生第二份，结果汇总如实报跳过。
5. 没有 `~/.claude` / `~/.codex` 的机器上，该段落不出现或明确显示「没有可导入的会话」。
6. 内嵌 TUI 也能列出导入的会话（H/19 U3 已统一目录，这条是顺带验证目录统一没被破坏）。
7. Codex 的两种格式（新的 `session_meta`/`response_item` 包装、旧的裸行）都能读。

## 风险

- **v4 链式写入**。seq / lane / parent 接不上时的报错在 H/20 实测过（[记录](../evidence/gui-tui-session-interop/README.md)）。必须走 `codec.ts`，且要有一条「导入后立刻用真实读取器读回来」的用例。
- **大文件**。3338 行只是一条会话；扫描全量要异步并给进度，否则界面会卡。
- **`cwd` 匹配不到仓库**。Claude 的会话可能来自用户还没在本应用注册的目录。落为未绑定是安全解，但要在列表里如实显示「未匹配到仓库」，不要静默。
- **模型归属**。导入的会话不带 provider / model（PI-Desktop 也置 NULL），首次发送用当前默认模型。要确认这不会撞上 H/19 点验查出的 `Pi model not found`。

## 范围外

不做配置迁移（用户 2026-09-10 决定）。不做工具调用与附件的还原。不做分支还原。不做反向导出。不做 opencode（PI-Desktop 有，本轮没需求）。
