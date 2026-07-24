# 团队轨道台账（👥 用户 + 同事）

> 归属：OpenChamber 气泡对话重构 — 团队轨道（常规实现 / GUI 打磨 / 真机与加密机验收）
> 任务定义：[`2026-07-23-openchamber-chat-refactor-execution-plan.md`](./2026-07-23-openchamber-chat-refactor-execution-plan.md) §3
> 总台账：[`openchamber-chat-refactor-ledger.md`](./openchamber-chat-refactor-ledger.md)
> 维护人：~~用户 / 同事~~ → **2026-07-24 起移交 Claude 主线**（同事休假，收尾全落地 T-04 `22ef2ff` / T-07 `1ff7fc1`）
>
> ⚠️ **本文件已转为过程档案（append-only）**。T-xx 当前状态与推进计划看
> [`docs/plantree/plans/openchamber-chat-refactor/`](../plantree/plans/openchamber-chat-refactor/README.md)；本表状态列不再逐日维护。

## 任务状态

| ID | 任务 | 状态 | 认领人 | 备注 |
|---|---|---|---|---|
| T-01 | 真实 Project/Workspace 数据树 | ✅ | Cursor | 实现 `a01712a`；GUI pwd 验收通过 `2026-07-24` |
| T-02 | Session 生命周期 UI | 🟡 | Fable | 接 chat:listSessions 持久化 + LeftNav close/archive/rename 已做，待 GUI 联调；C-07 ✅ 已解锁 |
| T-03 | Resume UI + 历史时间线 | 🟡 | Fable | resume 决策 + 自动触发已做，待 GUI 联调；C-06 ✅ 已解锁 |
| T-04 | Thinking 折叠卡 UI | 🟡 | Fable | impl done；capability 闸 + streaming/done 折叠已做，待 GUI 联调；C-05 ✅ 已解锁 |
| T-05 | Tool Card 增强 + Question 卡 | ⬜ | | 全解锁（C-04 ✅ `c9522d2`，消费指引见总台账当日行）；plantree 列为下一个开发任务 |
| T-06 | 消息元数据 + 错误/重试 | 🟡 | Fable | assistant 元数据行 + 失败卡 + 重试已做；待 GUI 复验 |
| T-07 | Composer @ 文件引用 | 🟡 | Fable | impl done；纯函数 + chip + popup 已做，待 GUI 联调；无依赖 |
| T-08 | Model 选择器 | ✅ | Fable | 实现 `298e3e6`；GUI 复验通过（"切模型和正常回复" 2026-07-24） |
| T-09 | 空/错/断状态 + 诊断面板 | 🟡 | Fable | impl done `187c783`；用户暂跳过 GUI 验收（场景 A 顺带验证 banner 显/收机制工作；B 因 resolver 容错 fallback 走真 node，未真触发 Node 缺失） |
| T-10 | 打包版 GUI 手工点验 | ⬜ | | C-02 ✅ 就绪（产物含随包 Node，141MB）；→ CP2 |
| T-11 | **M2 加密机验收（现场）** | ⬜ | | 等 T-10，→ CP5 |
| T-12 | Phase 4：右栏 Git 面板 | ⬜ | | M3 后 |
| T-13 | Phase 4：右栏 Files 面板 | ⬜ | | M3 后 |
| T-14 | Phase 4：右栏 Context 面板 | ⬜ | | M3 后 |
| T-15 | Phase 4：Terminal Dock 接真终端 | ⬜ | | M3 后 |
| T-16 | Phase 4：新旧开关成熟化 | ⬜ | | T-12~15 后 |
| T-17 | Tool 真实调用 GUI 验收 | ✅ | Cursor | Host smoke 通；GUI 闭环 `2026-07-24`：PONG 正常（一条 user + assistant）、Write→Allow→`PING.txt`、卡 Running 已解（主线 `6a633d6` 补 stream-end 终态 + 团队 `b55c859` 修 Composer 进度门/双写） |
| T-18 | Composer 粘贴图片/文件 | ⬜ | | 用户反馈 F2；C-13 ✅ 附件协议就绪（大图需发送中状态） |
| T-19 | 消息队列（占位） | ⬜ | | 提案内容待落库，落库前不排期（执行计划 §3） |
| T-20 | Effort 选择器 | ⬜ | | C-10 ✅；需协议扩展 effort 传递；开工前按官方文档核实档位 |

图例：✅ 完成 · 🟡 进行中 · ⬜ 未开始 · ❌ 阻塞

> ### 2026-07-24 接手解阻详述（已闭环留档：修复随 `b55c859` 提交，验收见过程记录 T-17+T-01 行；红线需求已由主线 `6a633d6` 承接）
> **Composer 进度门误触发（已修）**：`ChatComposer` 的 `sawAssistantProgress` 原把 `EventNormalizer.beginTurn` 回显的 **USER** `message.delta`/`message.completed`（`eventNormalizer.ts:138-149`）误判为助手进度 → Send 后立刻"成功"收听、不再等助手、且**不吐**红 Error `rawEvents`。修复：抽 `classifyAssistantProgress`（`src/renderer/components/chat/assistantProgress.ts` + `__tests__/assistantProgress.test.ts` 5 单测）——只认 assistant 包络：`message.started` role=`assistant` 入 `Set<messageId>`，后续 `message.delta`/`completed` 校验 messageId 命中该 Set；`tool.*`/`permission.*`/`question.*`/`thinking.*` 直接计为助手回合信号。`ChatComposer.tsx` 改用之，`seenEvents`（rawEvents）仍全量记录。三绿：`pnpm typecheck` 绿、`biome check`（新人/改 3 文件）绿、`vitest` 8 绿（5 新 + 3 旧 workspace-shell）。
>
> **env 通路已验**：`AgentHostProcess.ts:48` spawn `env:{...process.env,...}` ＋ `claudeSettings.ts:29` 读 `process.env.CLAUDE_CONFIG_DIR` → `$env:CLAUDE_CONFIG_DIR=...; pnpm dev` 可把测试网关 token 送达 Host（脚本已生成 `C:\Users\13927\AppData\Local\Temp\aiclient-gui-test-config`）。
>
> **真正卡 Running 无 assistant 的根因落在红线（不改，提需求给主线）**：
> 1. `claudeRuntime.ts:222-226`：SDK 流结束但**无** `result` 事件时，只静默置 `session.status=idle` 于 registry，**不发** `session.status:idle` 事件 → UI 永驻 `running`。
> 2. SDK `query()` 对网关疑似挂起（无 assistant、无 result、无错误 → 若报错 `claudeRuntime.ts:236-249` 会发 `session.failed`，则 UI 是 `failed` 而非 `running`；卡 `running` = 真挂起）。
>
> **本修复的价值**：修后 Composer 不再被 user 回显提前"成功"，会真等满 45s（或等 assistant/tool/permission/failed），抓不到助手才会吐**干净的红 Error `rawEvents=…`**（含 `session.created`/`session.status(running)`/user 回显 + 流结束前任何 chk + `hostAfter=…`），供主线据此判定是网关挂起还是 SDK 报告缺失。
>
> **待办**：① 用户 GUI 点验 `Reply with exactly: PONG`，成功见 assistant 含 PONG；失败贴红 Error 全文。② T-17：`Create PING.txt with content pong` → Permission Allow → 仓库根出现 `PING.txt`。③ T-01：左栏真实仓库/worktree → New → 发 `pwd` 校路径。④ 三项过则勾 ✅ + 把 `SKIP_ONBOARDING_GATE` 翻回 false（另开清理提交）。⑤ 若持续卡 running 无 rawEvents 助手 chk，向主线提需求：在 `claudeRuntime.ts` 流结束补发 `session.status:idle`。

## 过程记录（按时间）

> 模板：`| 日期 | T-xx 节点描述 | 结果 | 验收证据（命令输出/操作记录/截图位置）+ 提交 hash |`

| 日期 | 节点 | 结果 | 证据 / 提交 |
|---|---|---|---|
| 2026-07-24 | **双轨合一**：本轨道维护人休假，全部 T-xx 任务移交 Claude 主线全权接管（用户指示）。在途未提交改动（T-04 方向：hostStatus/MessageTimeline/ChatWorkspace + thinkingCard 新文件）留存工作树待主线接手评估 | ⚠️ 移交 | 口头指示 |
| 2026-07-23 | T-17 认领 + Host 侧预检 | 🟡 GUI 待点验 | Cursor 认领。约定：**测试走网关** `ANTHROPIC_BASE_URL=https://cch-jyw.pipidan.qzz.io`（token 不入库，临时 `CLAUDE_CONFIG_DIR`）。Node 24 下 `phase2-permission-smoke.ts` → ok:true（Write→permission→allow→tool.completed→PERM-OK；`baseHost: cch-jyw.pipidan.qzz.io`）。GUI 仍读 `~/.claude/settings.json`，点验前需把网关 env 写入该文件（或提需求给主线支持 Host 侧 CLAUDE_CONFIG_DIR 注入）。 |
| 2026-07-23 | T-01 真实 Project/Workspace 数据树（实现） | 🟡 待 GUI 验收 | Cursor 认领。不改 `chatSessions.ts`：`deriveChatWorkspaceTree` + `useSyncChatWorkspaceTree` 外部 setState 灌真实 repos/worktrees/temp；LeftNav 多 Project 折叠 + New Session 绑 workspace；App 传入 repositories。单测 3 绿；`pnpm typecheck` + biome(workspace-shell/App) 绿。验收：Beta 壳左栏见真实仓库/worktree → 选 worktree → New → 发 `pwd`。 |
| 2026-07-24 | 解阻启动门 + Settings + Send 诊断（交接） | 🟡 未闭环 | 提交 `a01712a`。开发捷径：`src/shared/devFlags.ts` 的 `SKIP_ONBOARDING_GATE=true`（**开发期默认跳过，仅在专门验证登录/onboarding 功能时手动改 false**；见 `71e7b84`）。OpenChamber 壳强制开启；Settings 在壳下走 modal（修 OOB 死循环）。Composer：close→等 `session.created`→send；Running 不算成功；展示 `host.error` code/message；废弃固定 `session-live` id。现象：Send 可达 Running，但常无 `message.*`/assistant；用户本机勿改 `~/.claude/settings.json`，可用 `node scripts/make-test-claude-config.mjs` + `CLAUDE_CONFIG_DIR` 走网关。下一步：Stop→再发 PONG；若仍无回复贴 `rawEvents`；完成 T-17 Write→Allow→`PING.txt` 与 T-01 pwd 验收后勾台账。 |
| 2026-07-24 | 接手解阻：Composer 进度门误触发 + user 消息双写 | ✅ 已闭环 | 提交 `b55c859`。根因详述见下文「接手解阻详述」。三绿：typecheck 绿、biome（改 3 文件）绿、vitest 103 绿（+5 新）。 |
| 2026-07-24 | T-17 + T-01 GUI 验收 | ✅ 通过 | 凭证 `CLAUDE_CONFIG_DIR=C:\Users\13927\AppData\Local\Temp\aiclient-gui-test-config`（`pnpm prepare:test-config` 等价）。① PONG：一条 user + assistant `PONG`，无重复、无永驻 Running（主线 `6a633d6` 补 stream-end 终态 + 团队 `b55c859` 修 Composer 进度门/双写共同生效）。② Write→Allow→`PING.txt` 落盘。③ T-01 pwd：左栏选真实 worktree→New→发 `pwd`，assistant 返回地址正确。同提交翻转 `SKIP_ONBOARDING_GATE` 回 false（清理提交）。 |
| 2026-07-24 | T-08 Model 选择器（实现） | 🟡 待 GUI 复验 | Fable 认领。Composer 加 `<ModelSelect>`（@coss/ui Select h-6 小尺寸）：源 `models.ts` 常量短名列表（sonnet/haiku/opus）+ `host.ready.settings.model` 默认（不在列表则前置）；`useSessionModel`（localStorage `aiclient:chat:session-models`，守卫 JSON.parse）存 `sessionId→modelId` 映射；`ChatComposer.handleSend` 读 `getSessionModel` 传 `createSession({sessionId, workspacePath, model})`（Host `claudeRuntime.ts:187` 已接收 payload.model）。§12 验证先行：`models.test.ts` 6 单测覆盖兜底/首选/前置未知默认；typecheck 绿、biome（改 5 文件）绿、vitest 117 绿（+6）。GUI 复验：选 Opus→send→Host 用 Opus 跑（看 `host.ready`/stream 日志或回包模型）。 |
| 2026-07-24 | T-09 诊断面板（实现） | 🟡 待 GUI 复验 | Fable 认领。`hostStatus.ts` 纯 reducer：`reduceHostStatus` 折 `host.ready`→吸收 nodeVersion/nodeExecPath/cometix/settings 脱敏态；fatal `host.error`→state=error+lastFatalError；非 fatal 忽略（不遮蔽就绪态）。`isNode24ResolutionFailure` 匹配 resolver 错误文案（`/node 24|AICLIENT_NODE24_PATH/i`）。`useHostStatus`：mount 调 `getHostStatus()` 求初值 + 订阅 `onRuntimeEvent` 折叠 + 10s 轮询（主进程清 pid 探 Host 进程死亡）。`HostStatusBanner`：state≠ready 才显示（destructive for error、amber for stopped/starting），Node 24 缺失给「设 `AICLIENT_NODE24_PATH`」指引 + Retry（`ensureHost`）；诊断 inline 行（auth/baseUrl/baseHost/model/pid）。集成 `ChatWorkspace` 时间线之上。§12 验证先行：`hostStatus.test.ts` 7 单测（ready 吸收 / shuttingDown→stopped / fatal→error / 非 fatal 忽略 / Node 失败文案匹配 / 无关事件忽略）。三绿：typecheck、biome（改 5 文件）、vitest 124 绿（+7 无回归）。GUI 复验：① 改坏 `AICLIENT_NODE24_PATH` → 启动后见红 banner+指引→Retry 拉起；② 杀 Host 进程 → amber「已停止」→ Retry 恢复；③ ready 后 banner 自动收回。 |
| 2026-07-24 | T-06 消息元数据 + 错误/重试（实现） | 🟡 待 GUI 复验 | Fable 认领。红线 `chatSessions.ts` 不动：`messageMetadata.ts` 团队侧边注册表（`messageId→{startedAt/completedAt/latencyMs/model/usage}` + `sessionId→last assistant messageId` 索引）；reducer 折 `message.started`(assistant 盖 sessionModel 戳)、`message.completed`(算 latencyMs/timestamp)、`usage.updated`(归因最后一 assistant)；`formatMessageMetadata` 渲 "Sonnet · 1.2s · 10:30" 省缺字段。`useMessageMetadata(sessionId)` 单订阅 + session 模型从 `useSessionModel`。`MessageTimeline.MessageBubble` assistant 末尾加 metadata 行；`session.status==='failed'` 加错误卡 + 提示「点 Retry 重发」（保留已产内容自然由 store 不动）。`ChatComposer` 重构 `handleSend→runSend(trimmed)`，加 `lastUserPrompt`/`canRetry`/`handleRetry`，工具栏 status=failed 时显 Retry 按钮（用上条 user text 重发，不进 textarea）。§12 验证先行：`messageMetadata.test.ts` 8 单测覆盖 started stamp/忽略 user/latencyMs/usage 归因/无前置 assistant 忽略/无关事件/format 行省缺；三绿：typecheck、biome（改 5 文件）、vitest 132 绿（+8 无回归）。GUI 复验：① Send 一条 → assistant 出 "Sonnet · x.xs · 10:30" 行；② 断网/坏 token 触发 failed → 时间线见错误卡 + 输入框出 Retry；③ Retry → 重发上条。 |
| 2026-07-24 | T-08 GUI 复验 | ✅ 通过 | 用户 GUI：选 Opus→send→Host 用 Opus 跑正常回复。"切模型和正常回复"确认 |
| 2026-07-24 | T-06 fix 池：sending 期 Stop + 流异常也显 Retry + retry 重影 | 🟡 已实现待重验 | 提交 `0f3a8da`（canStop=busy||sending + retryablePrompt 取代仅 status=failed 判定）、`4a4f8db`（Stop 红色 destructive）、`2597c76`（runSend 开头清旧 retryablePrompt + 成功分支也清，解 late assistant 气泡导致的 ghost Retry）。三绿。待用户复验：① sending 期 Stop 红色可见；② 禁 key → ~30s 红字 + Retry 显 → 恢复 key → Retry 应正常 send 而不重影。 |
| 2026-07-24 | T-09 诊断面板（用户暂跳过验收） | 🟡 待补 | 用户场景 A 顺带验证 banner 显/收机制工作；B 因 NodeRuntimeResolver 容错 fallback，`$env:AICLIENT_NODE24_PATH='C:\bad\node.exe'` 坏路径仍能找真 node → 实际未触发 Node 缺失路径。需真正触发：找所有候选都失败的办法暂缺，待日后探（或主线加显式 mock-resolver 容器）。 |
| 2026-07-24 | T-02 会话生命周期 UI（实现） | 🟡 待 GUI 联调 | Fable 认领（C-07 ✅ `f6807c9` 解锁）。红线 `chatSessions.ts` 不动：`chat/sessionIndex/sessionIndexMerge.ts` 纯函数 `mergeSessionIndex`（按 sessionId 去重、UI 现场 status/runtimeIdentity 不被持久覆盖、title 由持久层权威、archived 让 live 也消失、未知 workspacePath 的归入 orphaned 而非盲目 seed）+ `recentSessionIdsFromIndex`；`__tests__/sessionIndexMerge.test.ts` 8 单测覆盖保留现场态/title 覆盖/runtimeIdentity fallback/archived 滤且并 live 镜像/seed status/orphaned/保留 fresh-new/recent 排序。`chat/sessionIndex/useSessionIndex.ts` hook：mount 调 `chat.listSessions` 灌入 store（外部 setState 桥）；`useSessionIndexMutations({rename,archive,close})` 调 IPC 后自动 refresh。`workspace-shell/LeftNav.tsx` 整合：SessionTreeItem 加 hover X 关闭 + 双击 rename + Archive icon + 右键 archive；WorkspaceBranch 接 onCloseSession/onRenameSession/onArchiveSession props 透传。三绿：typecheck、biome（改 4 文件）、vitest 192 绿（+8）。GUI 待联调：① 重启应用左栏见持久化会话（recent 按 updatedAt desc）；② 双击改名 → 持久；③ 右键 archive → 列表滤；④ 关闭 X → closeSession + refresh。 |
| 2026-07-24 | T-03 Resume UI + 历史时间线（实现） | 🟡 待 GUI 联调 | Fable 认领（C-06 ✅ `db41f63` 解锁）。红线 `chatSessions.ts` 已 C-06 内置 `session.history` 事件处理（h: 前缀幂等替换灌入时间线 + runtime 不动 + per-session historyErrors），T-03 团队侧只补"用户动作入口 + 决策"。`chat/sessionIndex/resumeIntent.ts` 纯函数 `shouldResumeSession`（runtimeIdentity 缺则不 resume、busy 默认拒、persisted runtimeIdentity 兜底）+ `resumeDisplayTitle`（firstMessage truncate 60）；`__tests__/resumeIntent.test.ts` 11 单测覆盖无 session/workspace/runtimeIdentity/persisted fallback/idle+model/skipBusy 各状态/manual override/显式 title 占位词跳过/firstMessage 截断与不截断。`useResumeSession` hook 调 `chat.resumeSession({sessionId, runtimeIdentity, workspacePath, model})`，成功后切 activeSessionId。`LeftNav` 加 `handleSelectSession` 包装：select 时若存在 runtimeIdentity 且 timeline 还无消息（!hasTimeline）则自动 resume 重放历史。三绿：typecheck、biome（改 4 文件）、vitest 203 绿（+11 无回归）。GUI 待联调：选一条历史 SessionId → timeline 出现 h: 前缀历史消息（user+assistant），后续 send 不丢历史。 |
| 2026-07-24 | T-04 Thinking 折叠卡 UI（实现） | 🟡 待 GUI 联调 | Fable 认领（C-05 ✅ `8449e88` 解锁：`capabilities.thinking=true`、thinking 块入 store、`thinking.started/delta` 已处理）。红线 `chatSessions.ts` 不动；团队侧只补"渲染 + 能力闸 + 在途/完成态切分"。`chat/thinkingCard.ts` 纯函数 `deriveThinkingCard`（thinking 为 message 最后一块 且 turn 活跃 → `streaming`，否则 `done`；非 thinking 块 / 越界 → null）+ `isTurnActive`（running/starting 为活，其他为回合结束）+ `isThinkingCapable`（`capabilities?.thinking !== false`，覆盖 undefined/缺失/true 均视为可渲染——C-05 default on 口径）。`__tests__/thinkingCard.test.ts` 21 单测覆盖非 thinking 块/越界/最后块+活跃/最后块+空闲/后续块抵达/文本累积/空前缀兜底 + `isTurnActive` 9 状态 + `isThinkingCapable` 4 能力状态。`MessageTimeline.tsx` `BlockRenderer` 加 `case 'thinking'`：thinkingEnabled=false 直接 return null（不渲染、不留入口、无残留）；true 时走 `Collapsible` 折叠卡——streaming 显示 amber 脉冲点 + "Thinking" 标签 + 末尾 80 字预览；done 用 `ChevronRight` 旋转 + "Thought process" 标题，单击展开正文（`whitespace-pre-wrap` pre）。`ChatWorkspace.tsx` 接线：`useHostStatus` 输出 `hostStatus.capabilities` → `isThinkingCapable` → `thinkingEnabled` prop 传 `MessageTimeline`。`hostStatus.ts` 扩展：`HostStatus` 增 `capabilities?: {thinking?: boolean}`；`reduceHostStatus` 在 `host.ready` 里吸收 `capabilities.thinking`（布尔守卫，非布尔时保留 undefined 语义——default on）；`useHostStatus` 无改动（reducer 透传）。`hostStatus.test.ts` +4 测试覆盖 true/false/undefined/未持 flag 四种能力态。三绿：typecheck、biome（改 6 文件全绿，biome --write 修了行内换行）、vitest 238 绿（+35 含 21 thinkingCard + 4 hostStatus + 既有全保留）。GUI 待联调：capability=true 时发 prompt → 回合中见 amber 脉冲点 + "Thinking" 折叠；回合后脉冲消失、可单击展开看 thinking 正文；老 Host 无 capabilities 也按 default on 渲染（与 C-05 一致）。若后续 Host 显式 capabilities.thinking=false，入口应完全消失（机制：BlockRenderer `if (!thinkingEnabled) return null`）。 |
| 2026-07-24 | T-07 Composer @ 文件引用（实现） | 🟡 待 GUI 联调 | Fable 认领（无依赖）。任务说明明确"不做拖拽/图片/IPC 附件协议"——CC 原生识别 `@path` 纯文本，团队侧只补"@ 触发 + 文件搜索 popup + chip 预览 + 纯文本拼接"。`chat/fileMention.ts` 纯函数：`extractMentionQuery`（回溯找未被空白/换行/行首前导的 `@`，取其后到 cursor 的 query——mid-token `a@foo` 不算开 mention）；`replaceMention`（找最近的合法 `@`，把 `@<query>` 替换为 `@<relativePath>`，cursor 后已为空白/换行时不重复补尾随空格，文末或后续是普通字符则补一个空格断词——避免双空格但不黏字）；`parseMentionChips`（按一致规则扫整段文本，给 chip row 预览用）。`__tests__/fileMention.test.ts` 28 单测：extractMentionQuery 10（含 mid-token / 跨换行 / 段落首 / 文末）+ replaceMention 10（含双空格避免 / 文末补空格 / 裸 @ 替换 / mid-token 不算开 token / 绝对路径归一）+ parseMentionChips 8（含 @首/多 chip/换行分隔/嵌入中点/token 空）。`ChatComposer.tsx` 接线：`textareaRef` + `composingRef`（IME 合成期跳过 mention 检测，与 EnhancedInput 同套路）；`handleContentChange` 延迟到 React 提交后再读 `selectionStart`；`useEffect` 150ms 防抖调 `window.electronAPI.search.files({rootPath: cwd, query, maxResults: 10})`，cwd 缺失或 mention 关闭时清空结果；`insertMention` 用 `replaceMention` 改写 textarea 文本 + 把光标移到新位置；键盘导航 popup 开时拦截 ArrowUp/Down/Enter/Esc（Enter 替换为插入选中项，不再触发 Send）；popup UI（绝对定位 bottom-full，与 EnhancedInput 视觉一致：fileName 主标 + dirPart 次标 + ↑↓/Enter/Esc 提示行）；chip row：textarea 下方按 mentionChips 渲染 `border-primary/30 bg-primary/10` 圆角 chip，提示用户已引用哪些路径。三绿：typecheck 干净、biome（改 3 文件全绿，biome --write 修了行内换行）、vitest 344 绿（+28 + 既有全保留，无回归）。GUI 待联调：在 Composer 输入 `@read` → 150ms 后见 popup 列出 cwd 下文件名含 read 的项 → ↑↓ 选 / Enter 插入；textarea 下方见 chip；纯文本含 `@docs/readme.md ` 发送后 CC 应能读到该文件内容。 |

## 给同事的快速上手（历史背景留档；双轨已合一，现行阅读路径见 plantree）

1. 必读顺序：ARD（§4 目标结构、§9 MVP 矩阵）→ 执行计划 §3（自己的任务）→ **plantree 当前状态** → `CONTEXT.md`（术语）。
2. 开发验证：`pnpm dev` → Settings → Appearance → 打开 **OpenChamber Workspace Shell**（Beta 开关）→ 选 **Live Agent Host** 会话发 `Reply with exactly: PONG`。
3. **测试凭证**：Host smoke 走执行计划 §4「测试凭证统一约定」（`spikes/testCredentials.ts`）。GUI 点验：优先 `node scripts/make-test-claude-config.mjs` 生成临时配置，用 `CLAUDE_CONFIG_DIR=…` 启动，**不要改用户本机 `~/.claude/settings.json`**（用户明确要求）。
4. ~~当前阻塞：GUI 卡 Running~~ **已解**（主线 `6a633d6` stream-end 终态 + 团队 `b55c859` 进度门修复 + 主线 C-14 看门狗 `f87c1cc` 三层兜底；T-17 GUI 闭环为证）。联调环境：`$env:CLAUDE_CONFIG_DIR='C:\Users\13927\AppData\Local\Temp\aiclient-gui-test-config'; pnpm dev`。
5. **临时开关**：`SKIP_ONBOARDING_GATE` 开发期默认 `true` 跳过 onboarding/登录门；仅在专门验证登录/onboarding 功能时手动翻 `false`，CP 上线门验前也保持真实口径（见 `71e7b84`）。
6. 提交前三绿：`pnpm typecheck` / `pnpm lint` / `pnpm test`；提交规范见 `CLAUDE.md`（Conventional Commits，中文描述）。
7. ~~不要改的区域（红线）~~ **双轨合一后失效**——全仓单线维护；协议变更纪律（`shared/types` 先类型后实现、破坏性 bump 版本）仍然有效，见执行计划 §4。
8. UI 遵循 `docs/design-system.md`（@coss/ui 优先、OKLCH 语义 token、尺寸/间距规范）。
