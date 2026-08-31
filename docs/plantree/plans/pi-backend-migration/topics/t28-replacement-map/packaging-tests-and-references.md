# T28 文件图 — Packaging、Tests、Spikes 与参考仓复用

Role: detail-shard
Status: accepted
Phase: A / T28
Read when: 实施 T29 tests、T35 dependency cleanup、T36 packaging 或 T37 license/release gates
Parent: [T28 replacement map](../t28-replacement-map.md)

## 1. Manifests、build 与 CI

| Path | 分类 | 目标 |
|---|---|---|
| `package.json` | `adapt` | 删除无 production consumer 的 `@agentclientprotocol/sdk`；Pi SDK ownership 收敛到 worker build；scripts 从 Agent Host/Codex 改 worker/Pi CLI。 |
| `package-lock.json`, `pnpm-lock.yaml` | `replace` | generated lockfiles；dependency cleanup 后由 package manager 重建，不得手改伪造。 |
| `src/agent-host/package.json` | `replace` | 改为 Pi worker package；保留 `@earendil-works/pi-coding-agent`、permission plugin，删除 Anthropic/Cometix/OpenAI conversation dependencies。 |
| `src/agent-host/package-lock.json` | `replace` | generated lockfile；worker package manifest 变更后重建。 |
| `src/agent-host/PINNED.md` | `replace` | 以 Pi/permission worker pin/evidence 替换；legacy Claude/Codex pins 退出 active docs。 |
| `src/agent-host/tsconfig.json` | `adapt` | 单独 worker typecheck gate 保留；描述从 Node Agent Host 改 utility worker。 |
| `electron.vite.config.ts` | `adapt` | 保留 main/preload/renderer build；加入/验证 worker entry bundle，Pi SDK 不直接进入 Main。 |
| `electron-builder.yml` | `adapt` | 删除 Agent Host/Claude/Codex exclusions/comments/copy assumptions；加入 worker bundle、Pi CLI/resources、licenses；保留 native modules。 |
| `scripts/build-agent-host.mjs` | `replace` | `build-worker`：只 bundle per-slot worker 与所需 Pi/permission deps；不并行构建 legacy `index.js`/singleton `piHost.js`。 |
| `scripts/agent-host-build-lib.mjs` | `replace` | 删除 Cometix/Anthropic/Codex preflight/prune/budget；保留可复用的 deterministic copy、artifact assertions、permission policy/license checks。 |
| `scripts/afterPack.mjs` | `adapt` | `resources/agent-host` → worker/CLI/resources；保留 serial copy、TSD/plain-byte、exec-bit/resource checks。 |
| `scripts/verify-packaged-app.mjs` | `replace` | 验证 worker bundle + Pi CLI/resource absolute launch + no orphan；删除 Claude PONG/Codex app-server/version smoke。 |
| `scripts/fetch-node-runtime.mjs`, `scripts/node-runtime-pin.mjs` | `adapt` | T36 bundled Node/Pi CLI；版本与平台不再由 Codex matrix 决定。 |
| `scripts/packaging-budget.mjs` | `replace` | worker + Pi CLI/resources budget；删除 Codex payload floor/baseline。 |
| `scripts/codex-platform.mjs`, `scripts/codex-smoke-lib.mjs`, `scripts/inspect-codex-payload.mjs` | `delete` | Codex execution packaging/smoke。 |
| `scripts/patch-pi-permission-system.mjs` | `adapt` | permission plugin patch 仍属 Pi security；重新验证 upstream/version，并随 worker artifact。 |
| `scripts/permission-policy-probe.mjs`, `scripts/permission-policy-probe.d.mts` | `adapt` | policy probe 保留，路径改 worker/resource。 |
| `scripts/dev.js` | `adapt` | dev lifecycle 启动/清理 worker；删除 legacy Host assumptions；终止后 process census。 |
| `.github/workflows/build.yml` | `adapt` | 串行 main/worker typecheck、scoped tests；build worker + Pi CLI/resources；删除 npm-ci Codex payload/Cometix/Codex smoke；保留资源与 packaged gates。 |
| `scripts/__tests__/agent-host-build-lib.test.mjs` | `replace` | worker artifact copy/preflight/license/policy assertions。 |
| `scripts/__tests__/codex-platform.test.mjs`, `codex-smoke-lib.test.mjs` | `delete` | Codex execution packaging tests。 |
| `scripts/__tests__/node-runtime-pin.test.mjs` | `adapt` | Pi CLI runtime pin/platform matrix。 |
| `scripts/__tests__/packaging-budget.test.mjs`, `packaging-config.test.mjs` | `replace` | worker/Pi CLI resources budget/config。 |
| `src/main/__tests__/electronViteConfig.test.ts` | `adapt` | 断言 worker entry/build externalization 与 Main 不含 Pi SDK。 |

`out-agent-host/`、`out-node-runtime/`、`dist/` 是 generated artifacts，不是 T28 source authority；T29/T36 build 验证时重建，Phase A 不修改。

## 2. Main host tests

| Path | 分类 | 迁移目标 |
|---|---|---|
| `src/main/services/agent-host/__tests__/AgentHostManager.test.ts` | `replace` | request correlation、failure diagnostics、terminal failure → WorkerManager/slot tests；删 singleton/history assertions。 |
| `src/main/services/agent-host/__tests__/AgentHostManagerCodexEnv.test.ts` | `delete` | Codex env assertions 删除；先把 shutdown-in-flight/config snapshot race 移植到 Pi config-generation test。 |
| `src/main/services/agent-host/__tests__/hostEnv.test.ts` | `replace` | worker agentDir/auth/models/project-trust env。 |
| `src/main/services/agent-host/__tests__/hostStderr.test.ts` | `adapt` | 保留 line/ring assertions，并增加 multi-slot/generation stderr isolation。 |
| `src/main/services/agent-host/__tests__/NodeRuntimeResolver.test.ts` | `adapt` | T36 bundled Pi CLI Node resolution。 |

## 3. `src/agent-host/__tests__`

### 3.1 Pi/security/product tests — port or retain

| Exact paths | 分类 |
|---|---|
| `extensionUiBridge.test.ts` | `adapt`：slot/generation/reset/owner。 |
| `permissionActivity.test.ts`, `permissionPlugin.test.ts`, `permissionPolicy.test.ts`, `permissionPolicyIntegration.test.ts`, `permissionPatchScript.test.ts` | `adapt`：保留 fail-closed assertions，更新 worker artifact path。 |
| `piHostCommands.test.ts` | `adapt`：Worker RPC validation。 |
| `piRuntimeMessageBoundaries.test.ts`, `piRuntimeModelSelection.test.ts`, `piRuntimeSessions.test.ts` | `adapt`：单 AgentSession WorkerSlot；移除 multi-session registry assumptions。 |
| `stderrRedaction.test.ts`, `subagentProjection.test.ts` | `adapt`：保留 security/privacy assertions，接 Pi worker producer。 |
| `coalescingEmitter.test.ts`, `ttftWatchdog.test.ts` | `adapt`：改为 Pi worker pressure/timeout semantics；若 implementation 无消费者，在当前替代切片立即删除。 |
| `fixtures/piSdkStub.ts` | `adapt` 为 worker SDK fixture。 |

### 3.2 Claude execution tests — delete after behavior port

```text
src/agent-host/__tests__/claudeRuntimeOptions.test.ts
src/agent-host/__tests__/claudeRuntimePartialStall.test.ts
src/agent-host/__tests__/claudeRuntimePermissionPreference.test.ts
src/agent-host/__tests__/claudeRuntimePermission.test.ts
src/agent-host/__tests__/claudeRuntimePermissionUpdate.test.ts
src/agent-host/__tests__/claudeSettings.test.ts
src/agent-host/__tests__/eventNormalizerGolden.test.ts
src/agent-host/__tests__/eventNormalizerPartial.test.ts
src/agent-host/__tests__/eventNormalizerSubagent.test.ts
src/agent-host/__tests__/eventNormalizer.test.ts
src/agent-host/__tests__/permissionBridge.test.ts
src/agent-host/__tests__/questionBridge.test.ts
src/agent-host/__tests__/protocolErrors.test.ts
```

分类：`delete`。删除前只移植 runtime-neutral behavior（terminal state、partial ordering、privacy cap、permission cleanup）到 Pi worker tests；不保留 Claude SDK shapes。

Partial/subagent fixtures：

```text
src/agent-host/__tests__/fixtures/partial-messages/control.golden.json
src/agent-host/__tests__/fixtures/partial-messages/control.sdk.json
src/agent-host/__tests__/fixtures/partial-messages/treatmentFixture.ts
src/agent-host/__tests__/fixtures/t34-subagent-a-default.jsonl
src/agent-host/__tests__/fixtures/t34-subagent-b-forwarded.jsonl
```

分类：`migration-only/evidence`，可用于 importer 或 behavior provenance；不得继续驱动 Claude runtime。

### 3.3 Codex execution tests — delete

```text
src/agent-host/__tests__/agentSupport.test.ts
src/agent-host/__tests__/codexConfigError.test.ts
src/agent-host/__tests__/codexConfigOverrides.test.ts
src/agent-host/__tests__/codexConnection.test.ts
src/agent-host/__tests__/codexDecisions.test.ts
src/agent-host/__tests__/codexNodeEntry.test.ts
src/agent-host/__tests__/codexNormalizer.test.ts
src/agent-host/__tests__/codexPending.test.ts
src/agent-host/__tests__/codexQuestionBridge.test.ts
src/agent-host/__tests__/codexRuntime.test.ts
src/agent-host/__tests__/codexSettingsUpdate.test.ts
src/agent-host/__tests__/codexStatus.test.ts
src/agent-host/__tests__/codexWatchdog.test.ts
src/agent-host/__tests__/codexWireContract.test.ts
src/agent-host/__tests__/codexWire.test.ts
```

分类：`delete` at T35。approval/question/settings/status invariants 只有在 Pi product contract 仍需要时移植；不保留 app-server/RPC/CLI execution。

Codex execution fixtures：

```text
src/agent-host/__tests__/fixtures/codex/codex-approval-schema.json
src/agent-host/__tests__/fixtures/codex/codex-command-approval.jsonl
src/agent-host/__tests__/fixtures/codex/codex-filechange-approval-turn.jsonl
src/agent-host/__tests__/fixtures/codex/codex-handshake.jsonl
src/agent-host/__tests__/fixtures/codex/codex-method-contract.json
src/agent-host/__tests__/fixtures/codex/codex-question-requests.jsonl
src/agent-host/__tests__/fixtures/codex/codex-question-schema.json
src/agent-host/__tests__/fixtures/codex/codex-question-turn-status.jsonl
src/agent-host/__tests__/fixtures/codex/codex-settings-schema.json
src/agent-host/__tests__/fixtures/codex/codex-thread-start-echo.partial.json
src/agent-host/__tests__/fixtures/codex/codex-turn-schema.json
src/agent-host/__tests__/fixtures/codex/e4-missing-envkey.jsonl
src/agent-host/__tests__/fixtures/codex/e4-present-envkey.jsonl
```

分类：`delete`；需要的原始调查可由 git history/docs evidence 检索。`codex-method-contract.json` 只证明 realtime method names，不证明 ASR implementation。

### 3.4 Legacy history tests/fixtures — migration-only

```text
src/agent-host/__tests__/historyReader.test.ts
src/agent-host/__tests__/codexHistoryReader.test.ts
src/agent-host/__tests__/codexItemMapper.test.ts
src/agent-host/__tests__/fixtures/codex/codex-s5-history-turn.jsonl
src/agent-host/__tests__/fixtures/codex/codex-s5-thread-resume.jsonl
src/agent-host/__tests__/fixtures/codex/codex-s5-u2a-report.json
src/agent-host/__tests__/fixtures/codex/README.md
```

分类：`migration-only`；迁入 T34 adapters，增加 source immutability/dedupe/atomic publish/unmapped tool tests。

## 4. Spikes/probes

### 4.1 保留/适配为 Pi worker 或 security smoke

| Path | 分类 |
|---|---|
| `src/agent-host/spikes/t08a-permission-plugin-smoke.ts` | `adapt` 为 worker artifact permission smoke。 |
| `src/agent-host/spikes/t34-subagent-shape-probe.ts` | `migration-only`，保留为 source/evidence。 |
| `src/agent-host/spikes/s5-u2a-history-probe.ts` | `migration-only`，保留为 source/evidence。 |

### 4.2 Legacy Claude/Codex execution probes

以下全部分类为 `delete`，不参与 production build/typecheck；需要的调查结论由现有 docs/git history 保留：

```text
src/agent-host/spikes/agent-sdk-spike.ts
src/agent-host/spikes/c03-question-probe.ts
src/agent-host/spikes/c04-question-bridge-unit.ts
src/agent-host/spikes/c04-question-smoke.ts
src/agent-host/spikes/c05-thinking-probe.ts
src/agent-host/spikes/c06-resume-history-smoke.ts
src/agent-host/spikes/c10-options-probe.ts
src/agent-host/spikes/c13-attachment-probe.ts
src/agent-host/spikes/c13-attachment-smoke.ts
src/agent-host/spikes/c14-invalid-model-smoke.ts
src/agent-host/spikes/c14-watchdog-unit.ts
src/agent-host/spikes/c16-thinking-host-smoke.ts
src/agent-host/spikes/c16-thinking-shape-probe.ts
src/agent-host/spikes/cache-affinity-probe.mjs
src/agent-host/spikes/capture-proxy.mjs
src/agent-host/spikes/compare-routes-multiturn.ts
src/agent-host/spikes/generate-partial-golden.ts
src/agent-host/spikes/host-lifecycle-spike.ts
src/agent-host/spikes/partial-messages-probe.ts
src/agent-host/spikes/phase2-permission-bridge-unit.ts
src/agent-host/spikes/phase2-permission-smoke.ts
src/agent-host/spikes/phase2-sdk-runtime-smoke.ts
src/agent-host/spikes/phase2-stream-end-unit.ts
src/agent-host/spikes/s1-acp-codex-probe.ts
src/agent-host/spikes/s1-codex-direct-probe.ts
src/agent-host/spikes/s1-target-contract-probe.ts
src/agent-host/spikes/s2-codex-question-probe.ts
src/agent-host/spikes/scroll-state-probe.js
src/agent-host/spikes/stream-json-spike.ts
src/agent-host/spikes/testCredentials.ts
```

其中 `s1-acp-codex-probe.ts` 是 root `@agentclientprotocol/sdk` 的唯一代码引用；它不能证明 production dependency 仍需要。

## 5. Main/shared/renderer test families

### 5.1 Port to WorkerSlot/Pi-only

| Family | Exact examples | 分类 |
|---|---|---|
| Session index/routing | `SessionIndexService.test.ts`, `extensionUiRouting.test.ts`, renderer `sessionIndex/*`, `sessionLifecycle.test.ts`, `sessionRetirement.test.ts`, `sessionRuntimeFacts.test.ts` | `adapt`：session file/generation/owner。 |
| Queue/pending/send | `messageQueue.test.ts`, `pendingUserMessages.test.ts`, `queueRelease*.test.ts`, `turnSendStatus`/send guard tests | `adapt`：保留行为，接 slot identity。 |
| Timeline/tool/thinking | `chatTimelineLayout.test.ts`, `messageTimeline*.test.ts`, `tool*.test.ts`, `thinkingCard.test.ts`, `pi*` tests | `adapt`：保留产品 assertions，接 worker events。 |
| Extension UI/permission | renderer `extensionUi*.test.ts`, `permissionActivityRow.test.ts`, settings/policy tests | `adapt`：slot generation/reset。 |
| Model/effort | `agentCatalogIpc.test.ts`, `agentCatalogService.test.ts`, renderer `agentModelCatalog.test.ts`, `models.test.ts`, `efforts.test.ts`, `t25ModelPickerStatic.test.ts` | `adapt`：Pi-only catalog，无 agent axis。 |
| Terminal/session | `SessionManager.test.ts`, `SessionManagerSpawnGate.test.ts`, `SessionManagerTrust.test.ts`, `AgentInstaller.test.ts`, terminal surface tests | `adapt` 到 Pi TUI/single-writer。 |
| Auth/config | vault/credential mode/spawn gate/piModel/piPermission tests | `adapt`；保留 Pi assertions，legacy adoption tests 变 migration-only。 |

### 5.2 Delete/replace legacy semantics tests

```text
src/shared/types/__tests__/agentWireStatic.test.ts
src/shared/types/__tests__/sessionPermissionPreference.test.ts
src/shared/__tests__/chatAgentDefaults.test.ts
src/main/ipc/__tests__/chatModelAgentGuard.test.ts
src/main/ipc/__tests__/chatPermissionPreferenceGuard.test.ts
src/main/ipc/__tests__/chatPermissionUpdate.test.ts
src/main/ipc/__tests__/claudeProvider.test.ts
src/main/ipc/__tests__/claudeRuntimeAuthManagedMode.test.ts
src/main/services/chat/__tests__/sessionPermissionSnapshot.test.ts
src/main/services/session/__tests__/SessionManagerCodexEnv.test.ts
src/main/services/cli/__tests__/ClaudeRuntimeChecker.test.ts
src/main/services/cli/__tests__/ClaudeRuntimeConfig.test.ts
src/renderer/components/chat/__tests__/composerAgentPickerModel.test.ts
src/renderer/components/chat/__tests__/composerAgentPickerWiring.test.ts
src/renderer/components/chat/__tests__/composerPermissionLiveWiring.test.ts
src/renderer/components/chat/__tests__/composerPermissionModel.test.ts
src/renderer/components/chat/__tests__/composerPermissionWiring.test.ts
src/renderer/components/chat/__tests__/sessionBinding.test.ts
src/renderer/components/chat/sessionIndex/__tests__/agentBindingMerge.test.ts
src/renderer/stores/__tests__/chatSessionsDraftAgent.test.ts
src/renderer/components/settings/__tests__/chatPermissionDefaults.test.ts
```

分类：`replace`。用 Pi session/model/policy tests 取代，保留有价值的 boundary/race 场景，不保留 Claude/Codex discriminants。

## 6. Reference repository reuse ledger

审计版本：

- pi-app `c5ad2f4dccb4`，MIT, Copyright 2026 justhil。
- pix `da01b3e12d2e`，MIT, Copyright 2026 Num Scope。

### 6.1 pi-app — T29/T30

已打开 source/tests：

```text
src/main/worker-manager.ts
src/main/worker-manager-pool.ts
src/main/worker-manager-types.ts
src/main/worker-manager-new-session.ts
src/main/worker-transport.ts
src/worker/index.ts
src/worker/worker-runtime.ts
src/worker/worker-transport.ts
src/worker/worker-port-handlers.ts
src/worker/worker-port-types.ts
packages/shared/worker-message.ts
src/main/__tests__/worker-manager-pool.test.ts
src/main/__tests__/worker-manager-session-isolation.test.ts
src/main/__tests__/worker-manager-extension-ui.test.ts
```

| 使用方式 | 内容 |
|---|---|
| `direct candidate` | WorkerSlot state skeleton；request ID/pending timeout；utilityProcess transport；temporary workspace key；new-session remap；session-targeted abort/RPC；pool/session isolation test scenarios。 |
| `adapt` | ai-client RuntimeEvent、SessionIndex/runtimeIdentity、window owner、queue/pending/attachments、permission/Extension UI、model/auth/project trust、repository retirement。 |
| `reject` | WSL stdio transport（除非本仓另有明确 requirement）；SDK fallback/global SDK selection；fixed 80/200/250/500ms sleeps；foreground-global dialog map；unbounded/recursive behavior；auto-restart wording与 D15 restart budget 不一致部分。 |

T29 substantial copying 时必须在 copied source 或第三方 notice 中保留 pi-app MIT notice。

### 6.2 pix — T36

已打开 source/tests：

```text
apps/desktop/src/main/pi-tui-session.ts
apps/desktop/src/main/pi-tui-session.test.ts
apps/desktop/src/main/pi-tui-pty.ts
apps/desktop/src/main/pi-tui-pty.test.ts
apps/desktop/src/main/pi-tui-env.ts
apps/desktop/src/main/pi-cli-extract.ts
apps/desktop/src/main/pi-cli-extract.test.ts
apps/desktop/scripts/after-pack.mjs
```

| 使用方式 | 内容 |
|---|---|
| `direct candidate` | session normalization；exclusive guard；generation/handle stale output；serialized open；absolute Node+CLI launch；CLI extraction stamp/version tests。 |
| `adapt` | 本仓 xterm/AgentTerminal、managed agentDir、WorkerManager single-writer、platform Resources/TSD/build scripts。 |
| `reject` | GUI/TUI 同 JSONL takeover；与 WorkerManager 重叠的 parking/supervisor；全局 npm/PATH；Ghostty private patch；默认保留四个 parked PTY（须按本仓 resource budget重新决定）。 |

T36 substantial copying 时必须保留 pix MIT notice。

## 7. T29 minimum tests derived from Phase A

第一纵切至少新增/移植：

1. RPC correlation、timeout、unknown response、dispose rejection。
2. worker init error/exit/crash；旧 generation message/exit 丢弃。
3. `newSession → send → text/thinking/tool/custom stream → terminal state`。
4. stop 只发给 authoritative slot，且只出现一个 stopped/cancelled terminal state。
5. dispose 清 pending RPC、Extension UI、display/reset、active turn、owner route。
6. session file create 后 atomic remap；冲突失败不留下双 authority。
7. app close 后 worker process census 无 orphan。
8. managed/local agentDir、model/auth、project trust、permission plugin fail-closed。

这些 tests 通过前，不能把 T29 标 Done，也不能开始 T35 deletion。
