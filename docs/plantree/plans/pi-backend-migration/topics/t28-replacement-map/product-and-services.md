# T28 文件图 — IPC、Services、Renderer 与 Legacy Protection

Role: detail-shard
Status: accepted
Phase: A / T28
Read when: 实施 T31、T34、T35 或 renderer/IPC cleanup
Parent: [T28 replacement map](../t28-replacement-map.md)

## 1. Main IPC 与 Preload

| Path | 分类 | 替代者或保留理由 |
|---|---|---|
| `src/main/ipc/chat.ts` | `adapt` | 保留 Main validation、window owner、SessionIndex 协调；create/open/send/stop/close 改 route WorkerSlot。删除 driver/agent/model-agent guard/legacy permission/Host history fan-out。 |
| `src/main/ipc/agentHost.ts` | `replace` | 用 WorkerManager diagnostics 替代；删除 Node/Cometix/SDK pin 与 singleton start/stop，只暴露 redacted slots/capacity，不暴露 PID。 |
| `src/main/ipc/agentCatalog.ts` | `adapt` | Pi-only catalog；删除 request `agent` axis。 |
| `src/main/ipc/piModels.ts` | `adapt` | sync 后按 config generation 安全 invalidate/restart slots，不 shutdown singleton Host。 |
| `src/main/ipc/piPermissions.ts` | `adapt` | Pi policy IPC 保留；resource path 改 worker packaging。 |
| `src/main/ipc/index.ts` | `adapt` | 注册 WorkerManager/import/TUI；app close dispose all slots/PTY；删除 legacy registrations。 |
| `src/main/ipc/onboarding.ts` | `adapt` | regenerate/logout 后从 singleton shutdown 改 WorkerManager dispose/config-generation；onboarding 只表达 Pi managed/local。 |
| `src/main/ipc/claudeSessions.ts` | `replace` | T34 scan/preview/select/import/report/open；禁止 resume Claude。 |
| `src/main/ipc/claudeProvider.ts` | `delete` | active Claude provider/config execution UI。 |
| `src/main/ipc/claudeRuntime.ts` | `delete` | Claude runtime detection/execution IPC。 |
| `src/main/ipc/claudeCompletions.ts` | `replace` | Pi commands/skills catalog 取代 Claude completions channel。 |
| `src/main/ipc/claudeConfig.ts` | `delete` | `CLAUDE.md` editing 不是 Pi runtime contract；未来若需要 workspace docs editor，另建 runtime-neutral feature。 |
| `src/main/ipc/cli.ts` | `adapt` | Pi-only detection/install/TUI；不依赖 global PATH/npm。 |
| `src/main/ipc/agent.ts` | `adapt` | terminal axis 改 Pi-only。 |
| `src/main/ipc/session.ts` | `adapt` | generic PTY lifecycle 保留；Claude/Codex branches 由 T36 删除。 |
| `src/main/ipc/sessionStorage.ts` | `retain` | generic product session storage，不是 conversation runtime。 |
| `src/main/ipc/hapi.ts` | `retain` | 名称命中 `pi` 但与 Pi runtime 无关，不纳入删除。 |
| `src/preload/index.ts` | `adapt` | context isolation 保留；chat payload Pi-only，删除 driver/agent/legacy permission/Host diagnostics；加入 worker/history/import/TUI。 |
| `src/preload/types.ts` | `retain` | ElectronAPI global declaration 随 preload shape 编译更新。 |

IPC focused tests：

| Tests | 分类 |
|---|---|
| `src/main/ipc/__tests__/chatEffortPayload.test.ts`, `chatSpawnGate.test.ts`, `chatTrust.test.ts` | `adapt` 到 WorkerSlot/managed Pi contracts。 |
| `src/main/ipc/__tests__/chatHostExitBroadcast.test.ts` | `replace` 为 single-slot crash isolation/generation tests。 |
| `src/main/ipc/__tests__/chatModelAgentGuard.test.ts`, `chatPermissionPreferenceGuard.test.ts`, `chatPermissionUpdate.test.ts` | `delete/replace`；删除 agent dialect，保留真正 Pi boundary validation。 |
| `src/main/ipc/__tests__/agentCatalogIpc.test.ts` | `adapt` 为 Pi-only catalog malformed payload tests。 |
| `src/main/ipc/__tests__/claudeProvider.test.ts`, `claudeRuntimeAuthManagedMode.test.ts` | `delete`；必要 managed/local behavior 迁到 Pi tests。 |

## 2. Main services

### 2.1 Session / routing / terminal

| Path | 分类 | 目标 |
|---|---|---|
| `src/main/services/chat/SessionIndexService.ts` | `adapt` | 保留 atomic persistence、first-write、rename/archive、runtime updates；durable identity 改 Pi session file，删除 agent/legacy permission snapshot。 |
| `src/main/services/chat/extensionUiRouting.ts` | `adapt` | owner-targeted routing 保留；加入 slot generation 和 crash/evict cleanup。 |
| `src/main/services/LocalSessionManager.ts` | `retain` | local storage/todo state，与 conversation runtime 无关。 |
| `src/main/services/session/SessionManager.ts` | `adapt` | generic PTY/local/remote session 保留；删 Claude/Codex launch/env，保留 managed Pi env，T36 加 single-writer/session generation。 |
| `src/main/services/terminal/PtyManager.ts` | `adapt` | 复用 node-pty/xterm channel；T36 加 Pi session identity、generation/stale output、dispose all。 |
| `src/main/services/terminal/ShellDetector.ts` | `retain` | generic shell discovery。 |
| `src/main/services/agent/AgentRegistry.ts` | `adapt` | terminal agent registry 收敛为 Pi-only；若无多 agent 价值则删除 registry abstraction。 |
| `src/main/services/agentCatalog/AgentCatalogService.ts`, `index.ts` | `adapt` | 保留 fresh/stale/seed/error cache 纪律；删除 Claude/Codex request rules/family filter，Pi SDK/config 成唯一 catalog source。 |
| `src/main/services/piModelConfig/configValidation.ts`, `PiModelConfigService.ts`, `index.ts` | `adapt` | managed/local Pi models/auth/agentDir 核心资产保留；config update 通过 WorkerManager generation 生效。 |
| `src/main/services/piPermissionPolicy/policyStore.ts`, `index.ts` | `adapt` | Pi policy store/service 保留；resource resolver 从 AgentHostManager 解耦。 |
| `src/main/services/onboarding/OnboardingService.ts` | `adapt` | shutdown target 改 WorkerManager；流程与文案收敛 Pi managed/local。 |

### 2.2 Claude service directory

| Path | 分类 | 边界 |
|---|---|---|
| `src/main/services/claude/ClaudeSessionScanner.ts` | `migration-only` | T34 Claude source scanner。 |
| `src/main/services/claude/sessionLogReader.ts` | `migration-only` | 与 scanner 合并期的只读 completion/import source；合并后删除重复实现。 |
| `src/main/services/claude/ClaudeCompletionsManager.ts` | `replace` | Pi command/resource catalog；不保留 Claude execution。 |
| `src/main/services/claude/ClaudeHookManager.ts` | `delete` | Claude hooks execution/config。 |
| `src/main/services/claude/ClaudeIdeBridge.ts` | `delete` | Claude IDE MCP execution bridge。 |
| `src/main/services/claude/ClaudeProviderManager.ts` | `delete` | Claude provider settings writer。 |
| `src/main/services/claude/McpManager.ts` | `delete` | Claude MCP management 删除；Pi packages/extensions UI 使用独立 Pi contracts。 |
| `src/main/services/claude/mcpTools.ts` | `delete` | Claude MCP tool definitions。 |
| `src/main/services/claude/PluginsManager.ts` | `delete` | Claude plugins manager 删除；Pi extensions/packages 另建。 |
| `src/main/services/claude/PromptsManager.ts` | `replace` | 纯文本 prompt 资产进入 Pi resource catalog；Claude manager 删除。 |

对应 tests：

- `src/main/services/claude/__tests__/ClaudeSessionScanner.test.ts`：`migration-only`，迁 T34。
- `src/main/services/claude/__tests__/ClaudeHookManager.test.ts`
- `src/main/services/claude/__tests__/ClaudeProviderManager.test.ts`
- `src/main/services/claude/__tests__/McpManager.test.ts`
- `src/main/services/claude/__tests__/PluginsManager.test.ts`
- `src/main/services/claude/__tests__/PromptsManager.test.ts`

后五项分类为 `delete`；删除前只有 runtime-neutral parser/atomic safety scenario 可移植。

### 2.3 CLI / terminal executable axis

| Path | 分类 | 目标 |
|---|---|---|
| `src/main/services/cli/AgentInstaller.ts` | `replace` | T36 bundled Pi CLI/resources；删除 global Claude/Codex install fallback。 |
| `src/main/services/cli/CliDetector.ts` | `adapt` | 只探测 Pi/bundled resource；generic detector 可留。 |
| `src/main/services/cli/CliInstaller.ts` | `delete` | Pi TUI 不走 global npm；其他 generic installer 若有产品 owner 应移出 agent namespace。 |
| `src/main/services/cli/ClaudeRuntimeChecker.ts` | `delete` | Claude runtime executable detection。 |
| `src/main/services/cli/ClaudeRuntimeConfig.ts` | `delete` | Claude runtime config。 |
| `src/main/services/cli/ClaudeVersion.ts` | `delete` | Claude version parsing。 |
| `src/main/services/cli/TmuxDetector.ts` | `retain` | generic terminal capability；明确不作为 Pi TUI dependency。 |

### 2.4 Credentials/config

| Path | 分类 | 目标 |
|---|---|---|
| `src/main/services/auth/CredentialVault.ts` | `adapt` | encrypted vault + Pi arm 保留；Claude/Codex fields 先 schema migrate，再移除 active launch consumption。 |
| `src/main/services/auth/adoption.ts` | `migration-only` | 只读 legacy credential adoption；不成为 execution fallback。 |
| `src/main/services/auth/AuthStateService.ts`, `src/main/services/auth/index.ts` | `adapt` | lifecycle target 改 WorkerManager dispose/config generation。 |
| `src/main/services/auth/managedCredentialsStartup.ts` | `adapt` | 保留 env stripping、Pi sync；删除 dev Claude seed/Claude home onboarding writer。 |
| `src/main/services/auth/claudeHome.ts` | `migration-only` | 只读 source/adoption helper 移入 migration namespace；trust/onboarding write path 删除。 |
| `src/main/services/auth/spawnGate.ts` | `adapt` | managed/local auth gate 约束 WorkerSlot 与 Pi TUI。 |
| `src/main/services/auth/credentialMode.ts` | `adapt` | managed/local 语义保留并收敛到 Pi config。 |
| `src/main/services/auth/appEntry.ts`, `AuthProbeScheduler.ts`, `managedFileWriter.ts`, `probeTarget.ts`, `redact.ts` | `adapt` | 通用 auth orchestration/atomic write/redaction 保留；去除 Claude/Codex target branches。 |

### 2.5 One-shot AI provider axis

以下不是 chat binding，但仍执行 Claude/Codex/Cursor/Gemini CLI：

- `src/main/services/ai/providers.ts`
- `src/main/services/ai/code-review.ts`
- `src/main/services/ai/commit-message.ts`
- `src/main/services/ai/branch-name.ts`
- `src/main/services/ai/todo-polish.ts`
- `src/main/services/ai/index.ts`
- `src/shared/types/ai.ts`
- `src/renderer/components/settings/AISettings.tsx`

统一分类：`replace`，由 Pi one-shot execution 取代；不是 `migration-only`，也不能作为第二套可执行 backend 永久保留。

## 3. Renderer multi-runtime semantics

### 3.1 必删/替换的 chat agent axis

| Path | 分类 | 目标 |
|---|---|---|
| `src/renderer/components/chat/ComposerAgentPicker.tsx` | `delete` | Pi-only chat 无 backend picker。 |
| `src/renderer/components/chat/composerAgentPickerModel.ts` | `delete` | 删除 fallback-to-Claude/capability agents/locked binding。 |
| `src/renderer/components/chat/sessionBinding.ts` | `replace` | agent binding lock 删除；把仍需的 target/worktree materialization guard 迁入 runtime-neutral module。 |
| `src/renderer/components/chat/ChatWorkspace.tsx` | `adapt` | 移除 picker/binding props；保留 subscriptions、queue/pending、Extension UI、retirement，绑定 slot generation。 |
| `src/renderer/components/chat/ChatComposer.tsx` | `adapt` | 保留 send/queue/echo/stop/retry/model/effort/attachments；删 agent snapshot、per-agent prefs、legacy permissions、Host topology。 |
| `src/renderer/stores/chatSessions.ts` | `adapt` | 删除 `ChatSession.agent`/draft agent；Host-bound facts 改 slot/session binding；保留 batching/history/pending/retirement。 |
| `src/renderer/components/chat/sessionIndex/sessionIndexMerge.ts` | `adapt` | 删除 resolve agent、unknown hide、missing→Claude；按 Pi session file/workspace 合并。 |
| `src/renderer/components/chat/sessionIndex/resumeIntent.ts`, `useResumeSession.ts`, `useSessionIndex.ts` | `adapt` | resume 参数无 agent；T32 走 Pi open/history；保留 race/cleanup guards。 |
| `src/renderer/components/chat/sessionIndex/sessionTitle.ts` | `adapt` | `Live Agent Host` 只作旧 title recognizer，不生成新文案。 |
| `src/renderer/components/chat/useHostStatus.ts`, `hostStatus.ts`, `HostStatusBanner.tsx` | `replace` | 改 session/worker readiness，普通 UI 不暴露 topology；保留可复用的 error classification。 |
| `src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts` | `adapt` | 保留 runtime fact/stderr surface；删除 Claude/Codex permission posture，接 Pi policy 与 slot-scoped diagnostics。 |

### 3.2 保留并适配的 model/permission surface

| Path | 分类 | 目标 |
|---|---|---|
| `ComposerModelTrigger.tsx`, `models.ts`, `agentModelCatalog.ts`, `useAgentModelCatalog.ts` | `adapt` | 保留 T25 group/search/tags/reasoning/effort；变 Pi-only catalog，无 agent key。 |
| `useSessionModel.ts`, `useSessionEffort.ts`, `useResolvedSessionModel.ts` | `adapt` | key 为 session/model，不再是 session/agent。 |
| `sessionPreferenceStore.ts` | `adapt` | 只读旧 per-agent localStorage 一次，随后写 Pi-only schema。 |
| `ChatAgentDefaultsSection.tsx`, `chatPermissionDefaults.ts` | `replace` | Pi-only model/effort/policy defaults。 |
| `ComposerPermissionTrigger.tsx`, `composerPermissionModel.ts` | `replace` | Pi permission policy/inline request control 取代；删除 Claude/Codex dialect。 |

### 3.3 Cycle 1/2 保留清单

以下 production files 均为 `adapt`（保留行为并接 WorkerSlot/generation），不得随 Agent Host 删除：

```text
src/renderer/stores/runtimeEventBus.ts
src/renderer/stores/sessionRuntimeFacts.ts
src/renderer/stores/messageQueue.ts
src/renderer/stores/pendingUserMessages.ts
src/renderer/stores/turnSendStatus.ts
src/renderer/stores/extensionUi.ts
src/renderer/stores/extensionUiDisplay.ts
src/renderer/stores/subagentActivity.ts
src/renderer/stores/sessionLifecycle.ts
src/renderer/stores/sessionRetirement.ts
src/renderer/stores/historyReplayMerge.ts        # T32 replace/adapt
src/renderer/components/chat/MessageTimeline.tsx
src/renderer/components/chat/ToolRows.tsx
src/renderer/components/chat/toolCard.ts
src/renderer/components/chat/toolDiff.ts
src/renderer/components/chat/thinkingCard.ts
src/renderer/components/chat/QuestionCard.tsx
src/renderer/components/chat/questionCardModel.ts
src/renderer/components/chat/ExtensionUiDialog.tsx
src/renderer/components/chat/ExtensionUiSurfaces.tsx
src/renderer/components/chat/extensionUiModel.ts
src/renderer/components/chat/extensionUiDisplayModel.ts
src/renderer/components/chat/permissionActivityRow.ts
src/renderer/components/chat/queueRelease.ts
src/renderer/components/chat/queueReleaseTransaction.ts
src/renderer/components/chat/attachments.ts
src/renderer/components/chat/clipboardAttachments.ts
src/renderer/components/chat/messageTimelineScroll.ts
src/renderer/components/chat/turnTiming.ts
src/renderer/components/chat/ChatWelcomeCard.tsx
```

共同适配要求：event/reducer 除 retired logical session guard 外，必须拒绝 stale slot generation。

## 4. Renderer terminal、legacy import 和 integration UI

| Path/group | 分类 | 目标 |
|---|---|---|
| `AgentTerminal.tsx`, `AgentPanel.tsx`, `AgentSessionTabs.tsx`, `AgentGroup.tsx`, `SessionBar.tsx` | `adapt` | 复用 xterm/session shell；删除 Claude resume/`--ide`/Codex/provider/runtime icons；T36 接 Pi TUI。 |
| `AgentPickerMenu.tsx`, `utils/agentSession.ts`, `components/todo/useEnabledAgents.ts` | `delete` | Pi-only 无 Claude/Codex executable picker；generic enablement 若需要另建 Pi-only module。 |
| `components/workspace-shell/deriveChatWorkspaceTree.ts`, `useSyncChatWorkspaceTree.ts` | `adapt` | 保留 workspace/session tree sync 与 retirement；删除 agent binding，使用 Pi session-file identity。 |
| `stores/agentSessions.ts`, `stores/agentStatus.ts` | `adapt` | 删除 `resumeClaudeSession`/legacy runtime identity；T36 terminal lifecycle。 |
| `hooks/useClaudeSessions.ts`, `components/sessions/ProjectGroup.tsx`, `SessionItem.tsx`, `SessionManagerView.tsx` | `replace` | T34 generic legacy scan/preview/select/import/report/open。 |
| `App/hooks/useClaudeIntegration.ts`, `useClaudeProviderListener.ts`, `lib/claudeProvider.ts` | `delete` | Claude integration/provider execution UI。 |
| `settings/claude-provider/*`, `IntegrationSettings.tsx` | `delete` | active Claude provider/plugin/settings surface。 |
| `SettingsContent.tsx`, `SettingsDialog.tsx`, `AgentSettings.tsx` | `adapt` | 删除 Claude Integration/legacy agent wording；保留 Pi settings。 |
| `Root.tsx`, onboarding `WelcomeView.tsx`, `OnboardingView.tsx`, `OnboardingShell.tsx`, `WelcomeShell.tsx` | `adapt` | startup/auth gate 改 Pi-only；删 bundled Claude/Codex promises；shell/mark 视觉资产保留。 |

## 5. Product wording replacement

| Path | 当前 legacy wording | 目标 |
|---|---|---|
| `middleColumnLayout.ts`, `HostStatusBanner.tsx`, `ChatComposer.tsx` | “Agent Host”, “Message Claude”, “Starting Agent Host” | “Starting session…”, “Sending…”, “Working…”；仅 diagnostics 可写 Pi worker。 |
| `MessageTimeline.tsx` | “stream from Agent Host” | runtime-neutral stream error。 |
| `chatSessions.ts`, `sessionTitle.ts` | “Live Agent Host” | 不再生成；旧 title 只读 migration recognizer。 |
| onboarding/settings/Root integration files | Claude Code/Codex setup/runtime gate | Pi managed/local setup。 |
| legacy session manager UI | resume Claude | “Import history and continue in Pi”。 |

普通 product UI 不显示 WorkerSlot、PID、utilityProcess topology。

## 6. T34/T35 hard boundary

T34 必须先把 `migration-only` files 移入独立 import namespace，并满足：

- source adapter import graph 无 runtime/launcher/connection；
- filesystem API 只读 source；
- temporary target validate 后 atomic publish；
- source hash/mode/mtime 前后不变；
- unmapped tool/custom 只读展示；
- provenance/dedupe manifest。

按 D16，Claude/Codex execution services、IPC、preload methods、renderer picker/settings、SDK/CLI dependencies、dead tests/scripts 在对应 consumer 替代切片中立即删除；T35 只验证其已经不存在。Codex ASR 没有实现，不构成删除例外。
