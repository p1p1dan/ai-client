# 团队轨道台账（👥 用户 + 同事）

> 归属：OpenChamber 气泡对话重构 — 团队轨道（常规实现 / GUI 打磨 / 真机与加密机验收）
> 任务定义：[`2026-07-23-openchamber-chat-refactor-execution-plan.md`](./2026-07-23-openchamber-chat-refactor-execution-plan.md) §3
> 总台账：[`openchamber-chat-refactor-ledger.md`](./openchamber-chat-refactor-ledger.md)
> 维护人：用户 / 同事（每完成一个 T-xx 任务加行，附验收证据与提交 hash）

## 任务状态

| ID | 任务 | 状态 | 认领人 | 备注 |
|---|---|---|---|---|
| T-01 | 真实 Project/Workspace 数据树 | ✅ | Cursor | 实现 `a01712a`；GUI pwd 验收通过 `2026-07-24` |
| T-02 | Session 生命周期 UI | ⬜ | | 等 C-07 |
| T-03 | Resume UI + 历史时间线 | ⬜ | | 等 C-06（CP4） |
| T-04 | Thinking 折叠卡 UI | ⬜ | | 等 C-05 |
| T-05 | Tool Card 增强 + Question 卡 | ⬜ | | Question 部分等 C-04 |
| T-06 | 消息元数据 + 错误/重试 | ⬜ | | 无依赖 |
| T-07 | Composer @ 文件引用 | ⬜ | | 无依赖 |
| T-08 | Model 选择器 | 🟡 | Fable | 实现完成待 GUI 复验；源：常量短名列表 + `host.ready.settings.model` 默认；`createSession({model})` 已带（Host 接收）；`useSessionModel` 存 session→model 映射 |
| T-09 | 空/错/断状态 + 诊断面板 | 🟡 | Fable | Agent Host 未就绪/Node 24 缺失/断连 ribbon 已做，待 GUI 复验 |
| T-10 | 打包版 GUI 手工点验 | ⬜ | | 等 C-02，→ CP2 |
| T-11 | **M2 加密机验收（现场）** | ⬜ | | 等 T-10，→ CP5 |
| T-12 | Phase 4：右栏 Git 面板 | ⬜ | | M3 后 |
| T-13 | Phase 4：右栏 Files 面板 | ⬜ | | M3 后 |
| T-14 | Phase 4：右栏 Context 面板 | ⬜ | | M3 后 |
| T-15 | Phase 4：Terminal Dock 接真终端 | ⬜ | | M3 后 |
| T-16 | Phase 4：新旧开关成熟化 | ⬜ | | T-12~15 后 |
| T-17 | Tool 真实调用 GUI 验收 | ✅ | Cursor | Host smoke 通；GUI 闭环 `2026-07-24`：PONG 正常（一条 user + assistant）、Write→Allow→`PING.txt`、卡 Running 已解（主线 `6a633d6` 补 stream-end 终态 + 团队 `b55c859` 修 Composer 进度门/双写） |
| T-18 | Composer 粘贴图片/文件 | ⬜ | | 用户反馈 F2（2026-07-24）；等 C-13 |

图例：✅ 完成 · 🟡 进行中 · ⬜ 未开始 · ❌ 阻塞

> ### 2026-07-24 接手解阻详述（未提交，待 GUI 闭环）
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
| 2026-07-23 | T-17 认领 + Host 侧预检 | 🟡 GUI 待点验 | Cursor 认领。约定：**测试走网关** `ANTHROPIC_BASE_URL=https://cch-jyw.pipidan.qzz.io`（token 不入库，临时 `CLAUDE_CONFIG_DIR`）。Node 24 下 `phase2-permission-smoke.ts` → ok:true（Write→permission→allow→tool.completed→PERM-OK；`baseHost: cch-jyw.pipidan.qzz.io`）。GUI 仍读 `~/.claude/settings.json`，点验前需把网关 env 写入该文件（或提需求给主线支持 Host 侧 CLAUDE_CONFIG_DIR 注入）。 |
| 2026-07-23 | T-01 真实 Project/Workspace 数据树（实现） | 🟡 待 GUI 验收 | Cursor 认领。不改 `chatSessions.ts`：`deriveChatWorkspaceTree` + `useSyncChatWorkspaceTree` 外部 setState 灌真实 repos/worktrees/temp；LeftNav 多 Project 折叠 + New Session 绑 workspace；App 传入 repositories。单测 3 绿；`pnpm typecheck` + biome(workspace-shell/App) 绿。验收：Beta 壳左栏见真实仓库/worktree → 选 worktree → New → 发 `pwd`。 |
| 2026-07-24 | 解阻启动门 + Settings + Send 诊断（交接） | 🟡 未闭环 | 提交 `a01712a`。开发捷径：`src/shared/devFlags.ts` 的 `SKIP_ONBOARDING_GATE=true`（**上线前必须改回 false**）。OpenChamber 壳强制开启；Settings 在壳下走 modal（修 OOB 死循环）。Composer：close→等 `session.created`→send；Running 不算成功；展示 `host.error` code/message；废弃固定 `session-live` id。现象：Send 可达 Running，但常无 `message.*`/assistant；用户本机勿改 `~/.claude/settings.json`，可用 `node scripts/make-test-claude-config.mjs` + `CLAUDE_CONFIG_DIR` 走网关。下一步：Stop→再发 PONG；若仍无回复贴 `rawEvents`；完成 T-17 Write→Allow→`PING.txt` 与 T-01 pwd 验收后勾台账。 |
| 2026-07-24 | 接手解阻：Composer 进度门误触发 + user 消息双写 | ✅ 已闭环 | 提交 `b55c859`。根因详述见下文「接手解阻详述」。三绿：typecheck 绿、biome（改 3 文件）绿、vitest 103 绿（+5 新）。 |
| 2026-07-24 | T-17 + T-01 GUI 验收 | ✅ 通过 | 凭证 `CLAUDE_CONFIG_DIR=C:\Users\13927\AppData\Local\Temp\aiclient-gui-test-config`（`pnpm prepare:test-config` 等价）。① PONG：一条 user + assistant `PONG`，无重复、无永驻 Running（主线 `6a633d6` 补 stream-end 终态 + 团队 `b55c859` 修 Composer 进度门/双写共同生效）。② Write→Allow→`PING.txt` 落盘。③ T-01 pwd：左栏选真实 worktree→New→发 `pwd`，assistant 返回地址正确。同提交翻转 `SKIP_ONBOARDING_GATE` 回 false（清理提交）。 |
| 2026-07-24 | T-08 Model 选择器（实现） | 🟡 待 GUI 复验 | Fable 认领。Composer 加 `<ModelSelect>`（@coss/ui Select h-6 小尺寸）：源 `models.ts` 常量短名列表（sonnet/haiku/opus）+ `host.ready.settings.model` 默认（不在列表则前置）；`useSessionModel`（localStorage `aiclient:chat:session-models`，守卫 JSON.parse）存 `sessionId→modelId` 映射；`ChatComposer.handleSend` 读 `getSessionModel` 传 `createSession({sessionId, workspacePath, model})`（Host `claudeRuntime.ts:187` 已接收 payload.model）。§12 验证先行：`models.test.ts` 6 单测覆盖兜底/首选/前置未知默认；typecheck 绿、biome（改 5 文件）绿、vitest 117 绿（+6）。GUI 复验：选 Opus→send→Host 用 Opus 跑（看 `host.ready`/stream 日志或回包模型）。 |
| 2026-07-24 | T-09 诊断面板（实现） | 🟡 待 GUI 复验 | Fable 认领。`hostStatus.ts` 纯 reducer：`reduceHostStatus` 折 `host.ready`→吸收 nodeVersion/nodeExecPath/cometix/settings 脱敏态；fatal `host.error`→state=error+lastFatalError；非 fatal 忽略（不遮蔽就绪态）。`isNode24ResolutionFailure` 匹配 resolver 错误文案（`/node 24|AICLIENT_NODE24_PATH/i`）。`useHostStatus`：mount 调 `getHostStatus()` 求初值 + 订阅 `onRuntimeEvent` 折叠 + 10s 轮询（主进程清 pid 探 Host 进程死亡）。`HostStatusBanner`：state≠ready 才显示（destructive for error、amber for stopped/starting），Node 24 缺失给「设 `AICLIENT_NODE24_PATH`」指引 + Retry（`ensureHost`）；诊断 inline 行（auth/baseUrl/baseHost/model/pid）。集成 `ChatWorkspace` 时间线之上。§12 验证先行：`hostStatus.test.ts` 7 单测（ready 吸收 / shuttingDown→stopped / fatal→error / 非 fatal 忽略 / Node 失败文案匹配 / 无关事件忽略）。三绿：typecheck、biome（改 5 文件）、vitest 124 绿（+7 无回归）。GUI 复验：① 改坏 `AICLIENT_NODE24_PATH` → 启动后见红 banner+指引→Retry 拉起；② 杀 Host 进程 → amber「已停止」→ Retry 恢复；③ ready 后 banner 自动收回。 |

## 给同事的快速上手

1. 必读顺序：ARD（§4 目标结构、§9 MVP 矩阵）→ 执行计划 §3（自己的任务）→ 总台账（当前状态）→ `CONTEXT.md`（术语）。
2. 开发验证：`pnpm dev` → Settings → Appearance → 打开 **OpenChamber Workspace Shell**（Beta 开关）→ 选 **Live Agent Host** 会话发 `Reply with exactly: PONG`。
3. **测试凭证**：Host smoke 走执行计划 §4「测试凭证统一约定」（`spikes/testCredentials.ts`）。GUI 点验：优先 `node scripts/make-test-claude-config.mjs` 生成临时配置，用 `CLAUDE_CONFIG_DIR=…` 启动，**不要改用户本机 `~/.claude/settings.json`**（用户明确要求）。
4. **当前阻塞**：GUI Send 后 session 常停在 **Running** 且无 assistant。已修 Composer 进度门（见上文"2026-07-24 接手解阻详述"）——修后会真等满 45s，抓不到助手才吐**干净的红 Error `rawEvents=…`**。先 Stop→再发 `Reply with exactly: PONG`→若失败把红色 Error 全文（含 `rawEvents`/`hostAfter`）贴回。env 通路已验：`$env:CLAUDE_CONFIG_DIR='C:\Users\13927\AppData\Local\Temp\aiclient-gui-test-config'; pnpm dev`。卡 `running`（非 `failed`）多属 Host/SDK 对网关挂起（红线，提需求）。
5. **临时开关**：`SKIP_ONBOARDING_GATE` 跳过 onboarding/登录门；交接验证完务必改回 `false`。
6. 提交前三绿：`pnpm typecheck` / `pnpm lint` / `pnpm test`；提交规范见 `CLAUDE.md`（Conventional Commits，中文描述）。
7. 不要改的区域：`src/agent-host/**`、`src/main/services/agent-host/**`、`src/main/ipc/chat.ts`、`src/shared/types/runtimeEvents.ts`、`src/renderer/stores/chatSessions.ts`（属 Claude 主线，需要改提需求）。
8. UI 遵循 `docs/design-system.md`（@coss/ui 优先、OKLCH 语义 token、尺寸/间距规范）。
