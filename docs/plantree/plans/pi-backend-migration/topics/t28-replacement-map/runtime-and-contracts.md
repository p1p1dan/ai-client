# T28 文件图 — Runtime、Main Host 与 Contracts

Role: detail-shard
Status: accepted
Phase: A / T28
Read when: 实施 T29/T30 Worker foundation 或 T35 runtime deletion
Parent: [T28 replacement map](../t28-replacement-map.md)

## 1. Electron Main host lifecycle

| Path | 分类 | 替代者或保留理由 |
|---|---|---|
| `src/main/services/agent-host/AgentHostManager.ts` | `replace` | `WorkerManager` + bounded `WorkerSlot`。移植 request correlation、shutdown epoch、diagnostics、synthetic terminal failure；删除 `ACTIVE_BACKEND`、legacy launch、global process/openSessions/ready state。 |
| `src/main/services/agent-host/PiHostProcess.ts` | `replace` | per-slot utility-process transport。保留 filtered env、message/error/exit wiring 和 graceful termination 思路；不得保留 singleton wrapper。 |
| `src/main/services/agent-host/AgentHostProcess.ts` | `delete` | Claude/Codex standalone Node + NDJSON transport；D15 明确不采用。 |
| `src/main/services/agent-host/hostEnv.ts` | `replace` | 删除 Claude/Cometix/Codex env；Pi 部分改由 slot worker env/managed agentDir/project trust 负责。保留显式过滤 inherited credential env 的安全原则。 |
| `src/main/services/agent-host/hostStderr.ts` | `adapt` | runtime-neutral line/ring diagnostics；改为每 slot/generation 隔离。 |
| `src/main/services/agent-host/NodeRuntimeResolver.ts` | `adapt` | 从 conversation Host 解耦；T36 复用于 bundled Node + Pi CLI absolute launch，并重新验证 Node 版本。 |
| `src/main/services/agent-host/index.ts` | `replace` | 导出 WorkerManager/WorkerSlot/transport；仅在 T36 需要时继续导出 Node resolver。 |

### 删除前的 transitive blockers

| Consumer | 当前耦合 | 必须先做 |
|---|---|---|
| `src/main/services/piPermissionPolicy/index.ts` | 从 `AgentHostManager.ts` import `resolveHostEntryPath` | 提取 neutral worker/resource path resolver。 |
| `src/main/services/cli/ClaudeRuntimeChecker.ts` | 使用 `resolveHostEntryPath` 与 `deriveBundledCometixCliPath` | 随 Claude runtime detection 删除；不得借此保留旧 host helper。 |
| `src/main/services/auth/AuthStateService.ts` | duck-type 调 `AgentHostManager.shutdown()` | 改成 WorkerManager dispose/config-generation invalidation。 |
| `src/main/services/auth/index.ts` | 动态 import `AgentHostManager` | 改指 WorkerManager。 |
| `src/main/ipc/piModels.ts` | sync 后 shutdown singleton Host | 改为受控 invalidation/dispose affected slots。 |

## 2. `src/agent-host` production modules

### 2.1 Pi worker source

| Path | 分类 | T29/T31 落点 |
|---|---|---|
| `src/agent-host/piHost.ts` | `replace` | 新 per-slot worker entry；保留 MessagePort 基础，删除 module-global registry/runtime 和多 session command router。 |
| `src/agent-host/piRuntime.ts` | `adapt` | 单 AgentSession worker runtime。保留 bootstrap、event projection、model/effort、attachments、project trust、permission、Extension UI、stop/dispose；删除 `states` 多 session map。 |
| `src/agent-host/piHostCommands.ts` | `adapt` | Worker RPC boundary validation；contract 删除后不再接受 legacy `permissionPreference`。 |
| `src/agent-host/sessionRegistry.ts` | `replace` | WorkerSlot state + one worker/one AgentSession；删除 agent discriminant 和 process-global registry。 |
| `src/agent-host/extensionUiBridge.ts` | `adapt` | 加 logical session + slot key + generation + request owner；crash/restart/evict/remap 清理。 |
| `src/agent-host/permissionPlugin.ts` | `adapt` | fail-closed 行为保留；resource lookup 改为 worker artifact layout。 |
| `src/agent-host/permissionActivity.ts` | `adapt` | Pi permission event projection 保留；由 caller 注入 slot/generation identity。 |
| `src/agent-host/permissionPolicy.mjs` | `retain` | Pi security default，独立于 legacy execution。 |
| `src/agent-host/permissionPolicy.d.mts` | `adapt` | 随 policy module 新路径同步。 |
| `src/agent-host/stderrRedaction.ts` | `adapt` | 保留为 worker/extension/Pi CLI 共用的 secret/path redaction。 |
| `src/agent-host/subagentProjection.ts` | `adapt` | 保留 privacy/size cap；生产者改为 Pi AgentSession event。 |
| `src/agent-host/coalescingEmitter.ts` | `adapt` | 作为 T31 event-pressure helper 候选移入 Pi projection 边界；若新 projection 无消费者，须以 import/load evidence 证明后再由 T35 删除。 |
| `src/agent-host/ttftWatchdog.ts` | `adapt` | generic timer 归入 WorkerSlot diagnostics；重新定义 Pi timeout/terminal semantics，不继承 legacy 常量。 |

### 2.2 Claude conversation execution

| Path | 分类 | 理由 |
|---|---|---|
| `src/agent-host/index.ts` | `replace` | multi-runtime NDJSON entry；T29 worker entry 取代后删除旧 entry。 |
| `src/agent-host/claudeRuntime.ts` | `delete` | Claude Agent SDK execution。 |
| `src/agent-host/claudeSettings.ts` | `delete` | Claude execution bootstrap/settings。 |
| `src/agent-host/cometix.ts` | `delete` | Claude Code executable resolution。 |
| `src/agent-host/pin.ts` | `delete` | Claude SDK/Cometix execution pins。 |
| `src/agent-host/eventNormalizer.ts` | `delete` | Claude SDK parser；删除前把仍有效 product invariant 移到 Pi projection tests。 |
| `src/agent-host/permissionBridge.ts` | `delete` | Claude `canUseTool` bridge；Pi 使用 permission plugin/Extension UI。 |
| `src/agent-host/questionBridge.ts` | `delete` | Claude question execution bridge；Pi 使用 Extension UI。 |

### 2.3 Codex conversation execution

| Path | 分类 | 理由 |
|---|---|---|
| `src/agent-host/agentSupport.ts` | `delete` | multi-agent availability/credential/entry support。 |
| `src/agent-host/codexRuntime.ts` | `delete` | Codex app-server conversation runtime。 |
| `src/agent-host/codexConnection.ts` | `delete` | subprocess JSON-RPC transport。 |
| `src/agent-host/codexWire.ts` | `delete` | execution framing；先保留 importer 所需静态 fixtures，adapter 禁止 speak RPC。 |
| `src/agent-host/codexNodeEntry.ts` | `delete` | Codex CLI locator/launcher。 |
| `src/agent-host/codexConfigOverrides.ts` | `delete` | execution provider/config overrides。 |
| `src/agent-host/codexConfigError.ts` | `delete` | execution config diagnostics。 |
| `src/agent-host/codexNormalizer.ts` | `delete` | live app-server event normalization。 |
| `src/agent-host/codexPending.ts` | `delete` | live server request map。 |
| `src/agent-host/codexDecisions.ts` | `delete` | live Codex approval mapping。 |
| `src/agent-host/codexQuestionBridge.ts` | `delete` | live question response bridge。 |
| `src/agent-host/codexSettingsUpdate.ts` | `delete` | live thread settings update。 |
| `src/agent-host/codexStatus.ts` | `delete` | live thread status mapping。 |

### 2.4 Read-only migration assets

| Path | 分类 | T34 边界 |
|---|---|---|
| `src/agent-host/historyReader.ts` | `migration-only` | Claude JSONL reader/limits；移入 Claude source adapter，禁止 runtime import。 |
| `src/agent-host/codexHistoryReader.ts` | `migration-only` | Codex history parser/projection；移入 Codex source adapter。 |
| `src/agent-host/codexItemMapper.ts` | `migration-only` | Codex rollout item → text/thinking/tool history；不得 execute tool。 |
| `src/main/services/claude/ClaudeSessionScanner.ts` | `migration-only` | source discovery、dedupe、title/preview、TSD-safe read；T34 首选 scanner。 |
| `src/main/services/claude/sessionLogReader.ts` | `migration-only` | 与 scanner 重叠；仅允许在 T34 合并期作为只读 source，合并完成后可删除重复实现。 |
| `src/shared/types/claudeSession.ts` | `migration-only` | 改为 source adapter/provenance DTO；不得表示 resumable Claude runtime。 |

T34 adapter 必须有 static import ban，至少禁止：

```text
claudeRuntime.ts
cometix.ts
codexRuntime.ts
codexConnection.ts
codexNodeEntry.ts
```

## 3. Codex ASR audit

当前 checkout 未发现 production ASR service、IPC、preload API、renderer microphone/transcript reducer 或 ASR package owner。唯一命中是：

- `src/agent-host/__tests__/fixtures/codex/codex-method-contract.json`

该 fixture 列出 `thread/realtime/appendAudio`、`appendSpeech`、`transcript/delta`、`transcript/done`、`listVoices`，但 production source 无调用。因此：

- fixture 分类为 `migration-only/evidence`；
- `@openai/codex` 不得因该 fixture 被保留；
- 若未来要交付 ASR，必须另立 owner、IPC、privacy、packaging 和 tests，不属于现存 conversation runtime 的保护项。

## 4. Shared contracts and model metadata

| Path | 分类 | 目标变化 |
|---|---|---|
| `src/shared/types/agentHost.ts` | `replace` | Worker RPC contract 取代 Host command union；迁移 attachment/effort，删除 driver/agent/legacy permission/question/history/pin，增加 slot/sessionFile/generation/request ownership。 |
| `src/shared/types/agentWire.ts` | `replace` | 删除 executable chat union、display names、missing→Claude default；import provenance 另建 `LegacyConversationSource`。 |
| `src/shared/types/runtimeEvents.ts` | `adapt` | 保留 timeline/thinking/tool/usage/retry/Extension UI/permission/subagent；删除 legacy agent capability/permission dialect/driver diagnostics；加 generation ownership。 |
| `src/shared/types/sessionHistory.ts` | `adapt` | T32 改 Pi branch-aware timeline；legacy digest shape 下沉 T34 intermediate adapter。 |
| `src/shared/types/sessionIndex.ts` | `adapt` | durable Pi `sessionFile` 成为 runtime identity；删除 agent/legacy permission snapshot；import provenance 独立。 |
| `src/shared/types/agentCatalog.ts` | `adapt` | 保留 tags/reasoning/thinkingLevelMap/source/stale；变成 Pi-only catalog，无 agent request axis。 |
| `src/shared/models/seedCatalog.ts` | `adapt` | 保留 `PI_SEED_MODELS`；删除 Claude/Codex seeds/branching。 |
| `src/shared/models/familyWhitelist.ts` | `delete` | Claude/Codex active catalog filter；Pi catalog 不走此 whitelist。 |
| `src/shared/models/chatAgentDefaults.ts` | `replace` | Pi-only model/effort/permission defaults，无 `lastAgent`/`byAgent`。 |
| `src/shared/models/permissionTiers.ts` | `adapt` | 只保留真实 Pi policy UI vocabulary。 |
| `src/shared/piModelConfig.ts` | `adapt` | 保留 Pi provider/model/agentDir/auth metadata，并改由 WorkerSlot bootstrap 消费。 |
| `src/shared/piPermissionPolicy.ts` | `retain` | Pi-only policy contract。 |
| `src/shared/types/ai.ts` | `replace` | Pi one-shot contract 取代 legacy provider axis；不是 import reader。 |
| `src/shared/types/cli.ts` | `adapt` | generic terminal types 保留；Claude/Codex launch option 由 T36 替换。 |
| `src/shared/types/claude.ts` | `adapt` | 先拆分：execution/settings/provider members 删除，source DTO 移入 importer。 |
| `src/shared/types/claudeRuntime.ts` | `delete` | Claude runtime detection/status。 |
| `src/shared/types/agent.ts` | `adapt` | generic terminal/session notification 保留；Claude/Codex executable agent members 删除。 |
| `src/shared/types/session.ts` | `adapt` | generic PTY/session contract 保留；legacy agent launch branches 删除。 |
| `src/shared/agentHost/cometixPin.ts` | `delete` | Claude execution pin。 |
| `src/shared/agentHost/nodeRuntimePin.ts` | `adapt` | 若 T36 继续 bundled Node，改名并归 packaging/terminal ownership。 |
| `src/shared/types/ipc.ts` | `adapt` | 保留稳定窄 bridge；删除 singleton Host/Claude channels，加入 worker/history/import/TUI。 |
| `src/shared/types/index.ts` | `adapt` | 清 deleted exports，导出 worker/import contracts。 |
| `src/shared/credentialMode.ts` | `adapt` | managed/local 语义保留并收敛到 managed Pi agentDir 与 user Pi setup。 |

## 5. T29 direct source boundary

从当前仓直接适配：

- `PiHostProcess.ts` 的 utilityProcess/env/error/exit wiring；
- `piHost.ts` 的 parentPort receive/send；
- `piRuntime.ts` 的 Pi bootstrap、RuntimeEvent projection、model/effort、attachments、permission、Extension UI、stop/dispose；
- `piHostCommands.ts` 的 payload validation；
- `hostStderr.ts` 与 `stderrRedaction.ts` 的 diagnostics safety。

不得直接保留：

- `AgentHostManager` global process/router/openSessions；
- `SessionRegistry` multi-session map；
- `ACTIVE_BACKEND`/`AgentWireName`；
- standalone Node/NDJSON；
- Claude/Codex runtime/launcher/connection；
- fixed sleep 作为唯一 flush/dispose contract。
