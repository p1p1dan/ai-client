Role: topic

# P1-12：退役自有 runtime（清点与施工方案）

上位：[roadmap P1-12](../roadmap.md)（退出判据：全量测试通过；打包产物里没有旧 runtime）。依据：决策 [004](../decisions/004-branch-isolated-dsh-only.md)、[010](../decisions/010-p1-1-scope-boundary.md)（改名留到 P1-12）、[030](../decisions/030-read-only-replay-via-host.md)（解码链进 shared、不删）、[041](../decisions/041-permissions-shared-pure-library.md)（A 类权限用例改指纯库）、[087](../decisions/087-subagent-catalog-move-and-fixture-relocation.md)（前置搬迁已完成）、[090](../decisions/090-user-rulings-2026-09-28.md)（`shared/mcp` 与子代理目录规则保留）、[116](../decisions/116-p1-16e-legacy-asset-notice-choices.md)、[124](../decisions/124-p1-9f-imports-produce-dsh-choices.md) 第 19 条、[125](../decisions/125-p1-15-one-shot-completions-choices.md) 第 18 条、[127](../decisions/127-p1-11-remove-pi-tui-choices.md)（这三份都留了「P1-12 删除清单」）、[130](../decisions/130-user-rulings-2026-09-29-batch3.md)（授权删 runtime）。前提：Windows CI（run 36651305647 全部 job 通过）与 P1-7d 点验都已完成。

建立：2026-10-01。状态：方案，没有动代码。基线提交 `553d4760`；动工时以实际 HEAD 为准。清点方法：`rg`（排除 `node_modules`）全仓搜索，并用临时脚本按 import 图计算生产入口（Main、preload、渲染层、DSH 宿主 5 个行）的可达文件集。

## 0 速览

- **删**：约 260 个文件、约 7.6 万行，其中 lockfile 约 4.8k 行。
  - `src/runtime` 全部 172 个文件：产品代码 93 个、2.29 万行；测试与夹具 73 个、2.90 万行；配置 6 个。
  - `src/agent-host` 里 native worker 的部分：30 个文件、约 6k 行（含 3.2k 行 lockfile）。
  - Main：8 个模块与 8 个测试，约 3.8k 行。
  - 渲染层：2 个已卸下的设置页，1 个 native 回放测试与 5 份录制，约 3.2k 行。
  - shared：5 个文件，约 0.8k 行。
  - 脚本与探针：29 个文件，约 9.1k 行。
- **根依赖**：删 `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`。产品代码不 import 它们，但 electron-builder 会把根 `dependencies` 整个打进 app.asar，所以它们是「包里还有旧 runtime」的第二处。
- **不能删**：见 §1.1。主要有：解码链与 v4 语料、只读回放、迁移与导入、bridge 复用的 RPC 服务端与错误类型、stderr 脱敏、随包策略表、Codex 导入映射、模型目录。
- **两处必须先改，否则删包后产品会坏**：
  - `PiRuntimeChecker` 以 `resources/agent-host/worker.js` 判断 runtime 是否就绪，删包后首屏会进 `runtime-unavailable`；
  - 权限设置页的 bundled 层读的是 agent-host 产物里的 `config.json`，删包后这一层会消失。
- **一处必须先迁**：约 115 例 A 类权限用例要改为直接测纯库（决策 041 第 3 条），解码链用例也要搬进 shared。
- **四步**：①产品与安装包断开 native worker；②迁移要保留的用例；③删代码与依赖；④（可选）搬家与改名。每步都能单独验证。

## 1 清点表

「步」一列指 §2 的施工步骤。

### 1.1 不能删的（留）

| 路径 / 符号 | 理由 | P1-12 里的动作 |
|---|---|---|
| `src/shared/legacyPiSession/**`（codec、legacy、timeline、tree、context、convert） | 决策 030 第 4 条：P1-9 转换器与只读回放都靠它；vendored 代码带 MIT 声明 | 不动。`tree.ts` 在 P1-12 后只剩测试引用，仍按 030 保留 |
| `src/shared/__tests__/fixtures/legacy-pi/**`（v4 语料与金样本） | P1-12 之后唯一的 1.0.x 格式样本；生成器随 runtime 删除，删后无法再生成 | 只改 README 里的重生成说明 |
| `src/main/services/chat/SessionReplayReader.ts` | 没迁移的旧会话「只看不迁」走它（决策 030、050）；它只 import shared | 不动；它的测试要改写（§1.11） |
| `LegacyMigrationService`、`SessionIndexService` 的 pi 行处理、`ipc/chat.ts` 按 `PI_AGENT` 分流 | 首次继续时迁移（P1-9d） | 不动 |
| `src/main/services/legacyImport/*`（除 `PiImportProcess.ts`） | CC / Codex 导入直接产出 DSH（P1-9f） | 不动 |
| `src/agent-host/piWorkerRpcServer.ts`、`piWorkerErrors.ts` | bridge 每个通道都复用这套 RPC 服务端（`channelMux`、`dshSessionRuntime`）；bridge 有 8 个文件 import 这两个文件 | 第 3 步删掉只为 native 存在的处理；第 4 步可以搬进 `src/dsh-host/bridge/` |
| `src/agent-host/stderrRedaction.ts` | Main 有 8 个文件引用，宿主的凭据行也引用 | 不动；第 4 步可以搬进 shared |
| `src/agent-host/permissionPolicy.mjs`、`.d.mts` | 随包策略表：DSH 权限行（经 `shared/permissions`）和设置页都要读 | 第 3 步按决策 041 挪进 `src/shared/permissions/` |
| `src/agent-host/codexItemMapper.ts`、`__tests__/fixtures/codex/`、`fixtures/credentialSamples.ts` | `legacyImport/CodexRollout.ts`、Codex 导入测试、真宿主集成测试、脱敏测试在用 | 不动；第 4 步可以随调用方搬家 |
| Main 的 `WorkerSlot`、`WorkerTransport`（只留接口）、`createPiWorkerSlot`、`WorkerManager`（DSH 路径）、`workerSessionKey`、`DshChannelTransport`、`hostStderr` | 聊天通道仍是这套槽位，只是 transport 换成了 DSH 通道 | 只删其中的 native 分支 |
| `src/shared/types/workerRpc.ts`、`runtimeEvents.ts`、`runtimePermission.ts` | Main 与 bridge 之间的协议和事件词表 | 只删 native 专用的符号（§1.6） |
| `shared/types/legacyImport.ts` 的 `ImportedConversation`、`isImportedConversation` | 宿主的 `seedSession` 在用（决策 124） | 留；只删 worker RPC 类型 |
| `src/shared/permissions/**`、`shared/skills/*`（`expand.ts` 除外）、`shared/mcp/**`、`shared/subagentCatalogRoots.ts`、`shared/settingSources.ts` | 权限纯库供 DSH 用；技能和 MCP 配置供旧资产检测用；决策 090 明令保留 `shared/mcp` 与子代理目录规则 | 不动 |
| `piModelConfig` 的 `resolveNativeModelCatalog`、`nativeCatalog.ts`；`promptCacheSettings` 的主会话部分；`providerTimeoutSettings` | DSH 模型计划与凭据代理在用（决策 125 第 18 条「不删」，决策 040） | 只删子代理 TTL 那一部分 |
| 设置键 `PI_ENABLE_SUBAGENTS_SETTING_KEY`、`PI_OPT_IN_FEATURE_SETTINGS_KEY`、`PI_SUBAGENTS_FEATURE_ID` | 旧资产提示的检测在用（决策 116 第 9 条） | 留 |
| `scripts/fetch-node-runtime.mjs`、`node-runtime-pin.mjs`、`resources/node-runtime` | DSH 宿主的载体（决策 012） | 不动 |
| `build-remote-runtime-bundle.mjs` 与 build.yml 的 `build-remote-runtime-linux` | 远程工作区服务端，名字相近，但与自有 runtime 无关 | 不动 |
| shared 各库文件头的 `Moved from src/runtime/...` 出处注记 | 边界静态测试要求它；以后从 main 合并 1.0.x 修复时，靠它找到对应文件 | 留 |

### 1.2 `src/runtime`（第 3 步整目录删除）

| 路径 | 处置 | 理由 | 连带改动 |
|---|---|---|---|
| `src/runtime/**`，172 个文件 | 删 | 生产 import 图里，Main、preload、渲染层、宿主都不可达 runtime；它只经 `agent-host/worker.ts` 打进 worker 产物 | §1.3、§1.8、§1.9、§1.11 |
| 其中的 A 类权限用例：`permissions`、`permissionGrants`、`permissionQueue`、`shellPolicy`，`subagentToolsPermissions` 的 SA10 组，`tools` 里约 12 例，`workerEndToEnd`、`nativeWorkerRuntime` 里的相关用例 | **先迁后删**（第 2 步） | 决策 041 第 3 条 | 见 §2 第 2 步 |
| `sessionCodec.test.ts` | 搬进 `shared/legacyPiSession/__tests__/`，改为 import shared（第 2 步） | 纯解码用例，删了会丢解码链的覆盖 | 无 |
| 封装同一性测试（`legacyPiSessionWrappers`、`skillsMcpSharedWrappers`、`subagentCatalogSharedWrapper`） | 删 | 被测的薄封装随目录删除 | 无 |
| `mcp.test.ts`（真 stdio 端到端）、`skills.test.ts`（接线那一半）、`guiEventContract.test.ts`（native 录制的产出方） | 删 | MCP 已搁置（决策 090）；技能改由 DSH 原生加载（决策 101）；回放金样本已由 `dshStreamReplay` 取代（决策 133） | §1.5 删除对应录制 |
| `src/runtime/node_modules` | 只删软链本身 | worktree 里它是指向主检出的软链 | 风险 R3 |

### 1.3 `src/agent-host`

| 路径 / 符号 | 处置 | 理由 | 连带改动 | 步 |
|---|---|---|---|---|
| `worker.ts` | 删 | native worker 入口 | `nativeProjectTrust`、`workerEntryWiring`、`workerStripOnlyCompat`、`nativeWorkerModuleLoads`、`nativeWorkerDependencyBoundary` 五个测试一起删 | 3 |
| `piSessionTimeline.ts`、`piSessionTree.ts` | 删 | 薄封装；调用方（runtime store、`NativeSessionIndexAdapter`）都要删 | 两个测试改为直接 import shared，搬进 `shared/legacyPiSession/__tests__/`；tree 的错误类型断言改成 `LegacyPiSessionError` | 2 搬测试，3 删文件 |
| `piSessionPreflight.ts` 及测试 | 删 | 只有 `NativeWorkerRuntime` 用 | 无 | 3 |
| `permissionPlugin.ts` 及测试、`userResourcePaths.ts` | 删 | 决策 127 已点名；已经没有引用 | 无 | 3 |
| `codexHistoryReader.ts` 及测试 | 删 | 没有调用方，只剩它自己的测试 | `t31PiOnlyAbsence` 的迁移读取器名单去掉它 | 3 |
| `bundledPlugins.mjs`、`.d.mts` | 删 | `NATIVE_FEATURE_SWITCHES` 在决策 116 的删除清单上；`RETIRED_BUNDLED_PLUGIN_PACKAGES` 只给 agent-host 打包用 | 第 1 步先让 Main 不再引用它（§1.4） | 3 |
| `piWorkerRpcServer.ts` | 改 | 删 `worker.import*`、`utility.*`、`worker.reload` 三组处理；删 `createImportWriter`、`createUtilityRuntime` 选项，以及 `PiImportWriter`、`PiUtilityRuntime(Options)`、`emitUtilityEvent`、`WorkerModelCatalog` 的引用（决策 124、125、127） | 测试删掉对应用例；「opt-in 变量没有读者」那条用例的文件表去掉 `../worker.ts`；bridge 的两个桩（§1.7） | 3 |
| `package.json`、`package-lock.json` | 删 | 两项依赖 `pi-coding-agent`、`pi-permission-system` 只服务 worker 产物和旧扩展的测试 | `scripts/patch-pi-permission-system.mjs`（postinstall）、`permissionPatchScript`、`permissionPolicyIntegration`（C 类）、`piCliIsBundledToolOnly` 一起删；最后这个测试里「app 不 import pi-coding-agent」的断言并入新守卫 | 3 |
| `permissionPolicy.test.ts` | 随 `.mjs` 搬进 `shared/permissions/__tests__/` | B 类，必须保持全绿 | 无 | 3 |
| 夹具 `loadPiCliProbe.mjs`、`moduleLoadHooks.mjs`、`recordModuleLoads.mjs`、`partial-messages/`（3 个）、`t34-subagent-*.jsonl`（2 个） | 删 | 前三个只给要删的测试用，后面几个已经没有任何引用 | 无 | 3 |
| `tsconfig.json` | 留 | 剩余文件仍要类型检查 | 改注释；第 4 步随目录删除 | 3 / 4 |
| `src/agent-host/node_modules` | 只删软链 | 同 R3 | 无 | 3 |

### 1.4 Main

| 路径 / 符号 | 处置 | 理由 | 连带改动 | 步 |
|---|---|---|---|---|
| `services/cli/PiRuntimeChecker.ts` | **改（必须）** | 现在按 `resources/agent-host/worker.js` 是否存在判定就绪（`shared/authGate.ts` 的 `runtime-unavailable` 分支）。改为用 `resolveDshHostLayout` 检查随包 node 和 `dsh-host/host.js`；未打包时检查 `out-node-runtime/node` 和 `src/dsh-host/host.ts`。`workerVersion` 改成 `'dsh-host'` | `PiRuntimeChecker.test`、`ipc/__tests__/piRuntime.test` | 1 |
| `services/piPermissionPolicy/index.ts` 的 `getBundledPluginDir()` | **改（必须）** | bundled 层读 `<agent-host>/node_modules/@gotgenes/pi-permission-system/config.json`，这个文件打包时由构建写入、开发时由 `dev.js` 写入。改为直接用内存里的 `AICLIENT_DEFAULT_PERMISSION_POLICY`，与 `shared/permissions/policy.ts` 同一个来源 | `permissionPolicyService.test`；`dev.js` 删掉 `ensureDevPermissionPolicy` | 1 |
| `agent-host/PiWorkerProcess.ts` 及测试 | 删 | 剩下的调用方是 `PiUtilityService`、`PiImportProcess`（同一步删除）和上面两处（同一步改掉） | `index.ts` 桶文件 | 1 |
| `agent-host/PiUtilityService.ts` 及测试 | 删 | 决策 125 第 18 条 | `oneShotCompletionsStatic` 去掉「等 P1-12」的豁免 | 1 |
| `legacyImport/PiImportProcess.ts` 及测试；`WorkerManager` 的导入部分（决策 124 第 19 条列的选项、字段、三个方法、`disposeAll` 里那一段） | 删 | 决策 124 | `WorkerManager.test` 的导入用例；`legacyImportStatic` 第二个守卫的白名单改为空 | 1 |
| `chat/NativeSessionIndexAdapter.ts` 及测试 | 删 | 只剩它自己的测试 | `shared/types/nativeSession.ts` | 1 |
| `agent-host/nativeSubagentSettings.ts` 及测试 | 删 | 决策 105 | `WorkerManager` 的 `readSubagentSettings` 与 bootstrap 的 `subagents`；`piModelConfig` 的 `nativeFeatureEnabled` | 1 |
| `WorkerManager` 的 bootstrap 字段 `subagentPromptCacheTtl`、`promptCacheTtl`、`providerIdleTimeoutMs` | 停发（建议） | bridge 不读这些字段。后两项经模型计划到达 DSH（决策 040） | 删 `readPromptCacheTtls`、`readProviderTimeout` 选项；类型字段等第 3 步再删 | 1 |
| `agent-host/subagentCatalog.ts` 及测试、`ipc/piSubagents.ts`、8 条 `PI_SUBAGENTS_*`、preload 的 `piSubagents` | 删 | 决策 104 第 5 条、决策 116 | `ipc/index.ts` 去掉注册；`shared/types/subagentManagement.ts` | 1 |
| `ipc/piResources.ts` 的 `updateSettings`、`openPromptTemplates` 及两个常量；`PiResourceSettings` 的 `enableSubagents`、`features`、`paths.userSkills / userPromptTemplates / appPromptTemplates`；`getActivePiPromptTemplatesDir` | 删 | 决策 116 | `piResources.test`；`nativeFeatures.test` 删除 | 1 |
| `piModelConfig/index.ts` 的 `resolveManagedPiWorkerEnv`，以及对 `bundledPlugins.mjs` 的引用 | 删 | 唯一调用方是 `PiWorkerProcess` | `piWorkerEnv.test` 删除；`vaultIntegration.test` 改为断言 DSH 宿主环境（`buildDshHostEnvironment`）不含凭据，保住「凭据不进子进程环境」这条边界 | 1 |
| `agent-host/promptCacheSettings.ts` 的子代理 TTL | 删 | 决策 123 第 14 条 | 测试删掉一半 | 1 |
| `agent-host/WorkerTransport.ts` 的 `createNodeProcessWorkerTransport`、`createUtilityProcessWorkerTransport` | 删，接口留 | 只有 `PiWorkerProcess` 和探针在用 | `WorkerTransport.test` | 1 |
| `agent-host/index.ts`（桶文件） | 删 | 没有任何地方 import 它 | 无 | 1 |
| `createPiWorkerSlot.test.ts` 对 `PiWorkerProcess` 的 mock | 删 | 被 mock 的模块已经删除 | 无 | 1 |
| `WorkerManager` 日志前缀 `[pi-worker:` | 留，第 4 步改名时再改 | 决策 010 | 无 | 4 |
| `PiModelConfigService` 写 `models.json` | 留 | 见 Q3 | 无 | — |

### 1.5 渲染层与 preload

| 路径 / 符号 | 处置 | 理由 | 步 |
|---|---|---|---|
| `settings/PiSubagentsSettings.tsx`、`subagentManagementModel.ts` | 删 | 决策 104、116：页面早已卸下，没有入口 | 1 |
| 设置键 `subagentPromptCacheTtl`（类型、默认值、setter） | 删，并加进迁移的已删键表 | 决策 123 第 14 条 | 1 |
| preload 的 `piSubagents`、`piResources.updateSettings / openPromptTemplates` | 删 | 同 §1.4 | 1 |
| 只被删掉的页面用到的 i18n 词条 | 随页面删（可选） | 决策 116 | 1 |
| `stores/__tests__/nativeStreamReplay.test.ts` 与 `shared/__tests__/fixtures/nativeGui*EventStream.json`（5 份） | 删 | 录制的产出方 `guiEventContract` 随 runtime 删除；DSH 一侧由 `dshStreamReplay`（28 个场景）覆盖 | 3 |
| `modelMissingWiring.test.ts` 读 runtime 源码的两条断言（约 193～200 行） | 删 | DSH 的「模型不可用」走 `MODEL_NOT_CONFIGURED`，由 `sessionFailure.ts` 映射为 `model_missing`，已有覆盖 | 3 |
| `runtimeToolVocabulary.test.ts`「chat-tool-08 对照 runtime 注册表」一节 | 删 | 注册表没有了；逐个工具的词条用例保留，因为迁移来的旧会话里仍有这些工具名 | 3 |
| `stores/__tests__/permissionGate.test.ts`「native runtime 是产出方」用例 | 删；store 与 `runtimeEvents.ts` 的文件头注记改为指向 DSH 权限行 | 产出方已不存在 | 3 |
| `modelMissingError.ts` 里的 native 令牌 | 留 | 旧会话历史里的失败文本可能仍会命中 | — |

### 1.6 shared

| 路径 / 符号 | 处置 | 理由 | 步 |
|---|---|---|---|
| `types/subagentManagement.ts`、`types/nativeSession.ts` | 删 | 调用方在第 1 步删除 | 1 |
| `subagentMigration.ts`、`aiclientKeys.ts` | 删 | 只有 runtime 用，所以要等第 3 步 | 3 |
| `skills/expand.ts` 与 `skills.test` 里的 expand 用例 | 删 | 决策 103 第 3 条：没有别的调用方就删；`templates.ts`、`catalog.ts` 留给旧资产检测 | 3 |
| `types/promptCacheTtl.ts` 的 `SUBAGENT_PROMPT_CACHE_TTL_SETTING_KEY`、`DEFAULT_SUBAGENT_PROMPT_CACHE_TTL` | 删 | runtime 在第 3 步之前仍引用 | 3 |
| `types/workerRpc.ts` | 改 | 删 utility RPC 全组（决策 125 第 18 条的清单）、`WorkerModelCatalog` 与 bootstrap 的 `modelCatalog`、`worker.reload` 的类型与守卫（决策 127）、四个导入结果守卫和方法表里的 `worker.import*`（决策 124）、bootstrap 的 `subagents` 与三个 TTL / 超时字段、`WorkerCapabilityInventory` 的 `mcpServers / promptTemplates / subagents`（决策 116 第 21 条）、`PI_WORKER_GENERATION_ENV`；`workerRpc.test` 删对应用例 | 3 |
| `types/legacyImport.ts` 的 worker RPC 类型 | 删 | 决策 124 第 19 条 | 3 |
| `piModelConfig.ts` 的 `NATIVE_PROJECT_TRUSTED`、`PI_PROJECT_TRUST_ENV` | 删 | 只有 worker 与 `resolveManagedPiWorkerEnv` 用 | 3 |

第 1 步的规则：**不删 `src/runtime`、`src/agent-host` 仍在 import 的 shared 符号**，这样第 1、2 步结束时四套 tsc 都还能通过。

### 1.7 dsh-host（bridge 只收窄，行为不变）

| 路径 / 符号 | 处置 | 步 |
|---|---|---|
| `bridge/channelMux.ts` 里 `createImportWriter`、`createUtilityRuntime` 两个 unsupported 桩 | 删（`PiWorkerRpcServer` 去掉这两个选项） | 3 |
| `bridge/dshSessionRuntime.ts` 的 `reload()` 桩 | 删（决策 127） | 3 |
| `dshSessionRuntime.test.ts`、`permissionBridge.test.ts` 里同名的桩 | 删 | 3 |
| `tools/measure.ts`、`tools/p0-6-probe.ts`（P0 拿 native worker 做对照的驱动） | 留。native 那一侧会报 missing，不影响 tsc 和测试；可以以后清理 | — |
| 注释里的 `src/runtime/...` 出处、`hostStatic.test` 的反向断言 | 留 | — |
| 金样本 `src/shared/__tests__/fixtures/dsh/` | 预期不变。`--check` 若出现差异，要查原因，不重录 | — |

### 1.8 scripts 与探针

| 路径 | 处置 | 步 |
|---|---|---|
| `build-agent-host.mjs`、`agent-host-build-lib.mjs` 及测试、`packaged-worker-smoke.cjs`、`packaged-worker-report.mjs` 及测试 | 删 | 1 |
| `afterPack.mjs` | 改：删 `copyAgentHost`，删 Windows TSD 修复目标里的 `resources/agent-host` | 1 |
| `verify-packaged-app.mjs`、`packaging-budget.mjs` | 改，见 §4 | 1 / 3 |
| `dev.js` | 改：删 `ensureDevPermissionPolicy` 一段 | 1 |
| 探针：`run-t29c / t30 / t33 / t34 / t37b / t37c-gui`、`run-h19-plugin-gui`、`run-h19-project-scope`、`run-p6-native-default`；`probes/t29c、t30、t33、t34、t37b、b1a` | 删。它们依赖 `out-agent-host` 的 worker、pi TUI 或 agent-host 里的 pi SDK；决策 127 已经点名其中几个 | 1 |
| `gen-legacy-pi-fixtures.ts` | 删。语料已在 `6ce354c5` 提交（决策 124 的前置条件已满足）；语料 README 写明「要重新生成，须在 P1-12 之前的提交上运行」 | 3 |
| `run-f4-retry-probe.mjs`、`runtime-smoke/`、`runtime-baseline/run-native.mjs`、`verify-native.mjs` | 删 | 3 |
| `runtime-baseline/` 其余文件（archive、compare、metrics、suite、collect、verify、preflight、README） | 留。这是与后端无关的缓存命中率归档工具，历史证据仍可读取；README 改一句 | 3 |
| `patch-pi-permission-system.mjs`、`permission-policy-probe.mjs`、`.d.mts` | 删 | 3 |
| `verify-release-metadata.mjs` | 改：必需字符串，见 §1.9 | 3 |
| `dsh-host-build-lib.mjs` | 改：permissions 行的 `inputs` 换成新的策略表路径 | 3 |
| `build-dsh-host.mjs`、`assert-build-target.mjs` | 改注释；脏检查的目录表第 4 步再改 | 3 / 4 |

### 1.9 package.json、依赖、tsconfig 与其他配置

| 项 | 处置 | 步 |
|---|---|---|
| 根 scripts 的 `build:agent-host`；`dist:prereq` 里的 `pnpm build:agent-host` | 删 | 1 |
| 根 scripts 的 `smoke:runtime`、`smoke:runtime-tools`、`typecheck:runtime` | 删 | 3 |
| 根 scripts 的 `typecheck:agent-host` | 留，第 4 步删 | 4 |
| 根 dependencies 的 `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` | 删。产品代码不 import，只有要删的脚本和 runtime 测试在用；但它们会整包进 app.asar（本机 `pi-coding-agent` 连嵌套依赖约 136 MB，打包时 `files` 规则会滤掉 md / ts / map）。`pnpm-lock.yaml` 在同一个提交里更新（R3） | 3 |
| `src/runtime`、`src/agent-host` 的 `package.json` 与 lockfile | 删 | 3 |
| 根 `tsconfig.json` 的 exclude | 去掉 `src/runtime/**`（`src/agent-host/**` 第 4 步再去） | 3 |
| `electron-builder.yml` | 只删一段「worker 产物由 afterPack 拷贝」的注释；`files`、`asarUnpack`、`extraResources` 不变 | 1 |
| `.gitignore` 的 `out-agent-host/`、`biome.json` 的 `!**/out-agent-host` | 删（可选） | 1 |
| `THIRD_PARTY_NOTICES.md` | 改：「Pi coding agent」一节不再写随包带 Pi SDK 与 CLI，只保留 vendored 的 legacyPiSession 代码及其 pi-agent-core 0.84.4 MIT 声明；`pi-ai`、`pi-telemetry` 仍随 DSH 产物分发，这一条留；pi-permission-system 一节的文件路径改为 `src/shared/permissions/`。`verify-release-metadata.mjs` 与 `verify-packaged-app.mjs` 的必需字符串从 `@earendil-works/pi-coding-agent` 换成 `@earendil-works/pi-agent-core`。**这是法律文本，提交前请用户过目** | 3 |
| 本地未入库的 `out-agent-host/`（本机 132 MB） | 第 1 步后可以删 | 1 |

### 1.10 CI 与打包

见 §4。

### 1.11 测试改动（静态、扫描、接线测试及其他）

| 测试 | 现在引用了什么 | 改法 | 步 |
|---|---|---|---|
| `t31PiOnlyAbsence` | 要求 agent-host `package.json` 带两项 pi 依赖；迁移读取器名单里有 `codexHistoryReader` | 改为断言该 `package.json` 不存在、根依赖里没有两项 pi 包；名单去掉 `codexHistoryReader` | 3 |
| `chatEngineDshOnly` | 禁用词表里有 `forkPiWorkerProcess` 等 | 反向断言仍然成立，不改；只改「等 P1-12」的注释 | 1 |
| `oneShotCompletionsStatic`、`legacyImportStatic` | 「等 P1-12 删」的豁免与白名单 | 去掉豁免，白名单改为空 | 1 |
| `createPiWorkerSlot`、`WorkerManager`、`WorkerTransport`、`PiRuntimeChecker`、`ipc/piRuntime`、`permissionPolicyService`、`piResources`、`promptCacheSettings`、`vaultIntegration` | 见 §1.4 | 见 §1.4 | 1 |
| `nativeFeatures`、`piWorkerEnv` | `nativeFeatureRegistry`、`resolveManagedPiWorkerEnv` | 删 | 1 |
| `settings/removedSettings` | 无 | 加上 `subagentPromptCacheTtl` | 1 |
| `scripts/__tests__/packaging-config` | afterPack 调 `copyAgentHost`；worker 依赖边界；gate 列表；agent-host 的 `npm ci`；「Node 24 对齐 agent-host engines」；import `bundledPlugins.mjs` | 第 1 步：afterPack 的正则只匹配 `copyDshHost`；删「worker package dependency boundary」一块和 agent-host `npm ci` 的断言；「extraResources 不含 agent-host」这条反向断言保留。第 3 步：Node 24 改为对齐 dsh-host 的 engines；去掉 `bundledPlugins` 的 import 和 runtime gate 项。第 4 步：gate 列表去掉 `typecheck:agent-host` | 1 / 3 / 4 |
| `packaging-budget` | worker 产物上限 | 删这一块 | 1 |
| `dsh-host-build-lib` | permissions 行 inputs 里的旧策略表路径 | 换新路径 | 3 |
| `noHardcodedChinese` | ROOTS 含 `runtime`；`agent-host` 的下限是 14 | 去掉 `runtime`；`agent-host` 下限降到实际文件数减一（约 3）；第 4 步去掉这个根 | 3 / 4 |
| `defaultPaths` | `POLICY_PATTERN`、`RUNTIME_SUBPACKAGE` | 前者换路径，后者删 | 3 |
| `legacyPiSessionBoundaryStatic`、`skillsLibraryBoundaryStatic`、`mcpLibraryBoundaryStatic`、`subagentCatalogRootsBoundaryStatic` | 「旧位置只是薄封装」一节 | 删这一节；出处注记的正则保留 | 3 |
| `permissionsLibraryBoundaryStatic` | `BUNDLED_POLICY` 路径 | 策略表进库后，改为「库内只有它一个 `.mjs`，且它不 import 任何东西」 | 3 |
| `esmShimStringTrap` | `SCAN_ROOTS` 含 `agent-host` | 第 4 步去掉 | 4 |
| `skills.test`、`workerRpc.test`、`legacyImport.test`、bridge 的三个测试 | 见 §1.6、§1.7 | 删对应用例或桩 | 3 |
| `sessionReplayReader.test` | 用 runtime 的 `JsonlSessionStore` 写文件，再与 `history()` 对拍 | 改为对 legacy-pi 语料及其金样本里的 history 投影对拍 | 2 |
| 渲染层 4 个测试 | 见 §1.5 | 见 §1.5 | 3 |
| **新增** `src/shared/__tests__/runtimeRetiredStatic.test.ts` | 无 | 钉住以下几点：`src/runtime` 与 `agent-host/worker.ts` 不存在；`src`、`scripts` 里没有指向 `runtime/` 的 import；根依赖里没有两项 pi 包；`afterPack` 不拷 agent-host；build.yml 里没有 `src/runtime` 和 `build-agent-host`；Main 里没有 `utilityProcess.fork`；`PiRuntimeChecker` 与权限策略服务不引用 agent-host。最后两条第 1 步先加，其余第 3 步补齐 | 1 / 3 |

### 1.12 会过期的文档（只列出，P1-14 回写）

- 项目 `CLAUDE.md` 的「当前任务」：`src/runtime` 待退役、四套 tsc。根 `AGENTS.md` 的 Pi runtime/worker 一行。`README.md`、`README.zh.md` 里的 `pnpm typecheck:agent-host`。
- `docs/plans/2026-09-08-runtime-evolution-ard.md`（ARD）、`docs/architecture.md`、`docs/pi-only-migration.md`、`docs/pi-only-rollout-rollback.md`。
- `dsh-rebase/handoff-2026-09-28.md` §6：验证命令里的四套 tsc，以及「`src/runtime` 各自 `npm ci`」。`dsh-rebase/README.md` 第 19 行。`docs/plantree/README.md`、`进度看板.md` 对 runtime 的描述。
- `scripts/runtime-baseline/README.md`、`src/shared/__tests__/fixtures/legacy-pi/README.md`（重生成说明）。
- 用户的自动记忆里「`src/runtime` 是独立 npm 子包」一条会过期（不在仓库里，由编排者告诉用户）。

## 2 施工顺序

**共同规则**（写进每一步的派工提示词）：
- 只在 `feat/dsh-p0-probe` 上做，worktree 操作用 `git -C`；不推送，推送要先问用户（Q2）；不跑 `pnpm build`，不起 Electron。
- 一次只跑一条测试命令；全量单测只在第 3 步收尾时按目录分批跑一次。
- 不用 `git checkout` 恢复文件；不重录金样本。
- 每步收尾前，用 `rg -a` 对旧标识符做一遍残留扫描（`rg` 默认会跳过含裸 NUL 的源文件），并加跑 `vitest run Static Scan Wiring` 与 `src/shared/__tests__`。
- 每步至少一个独立提交，便于按步 revert。实现取舍记入决策 147（预留，见 §6）。

**通用验证命令**（仓库根目录）：

```bash
pnpm typecheck && pnpm typecheck:agent-host && pnpm typecheck:dsh-host   # 第 3 步之前另加 pnpm typecheck:runtime；第 4 步后只剩根与 dsh-host
pnpm lint
pnpm exec vitest run Static Scan Wiring
pnpm exec vitest run src/shared/__tests__
(cd src/dsh-host && ../../out-node-runtime/node tools/bridge-smoke.ts --out /tmp/bs.json)
out-node-runtime/node src/dsh-host/tools/bridge-record.ts --check
AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts
node scripts/build-dsh-host.mjs && node scripts/packaged-dsh-host-smoke.mjs --host-dir out-dsh-host --node out-node-runtime/node --level 1 --report /tmp/l1.json
```

### 第 1 步：产品与安装包断开 native worker（约 1 个代理会话）

- **范围**：§1.4、§1.5、§1.6 中标「1」的项；§1.8、§1.9 中标「1」的打包链；§4 的第 1 步部分；`runtimeRetiredStatic` 的前两条。
- **不碰**：`src/runtime`、`src/agent-host` 的源码，以及它们仍在 import 的 shared 符号。
- **结束时的状态**：
  - Main 不再有任何路径拉起 native worker；
  - 首屏就绪与权限设置页都改看 DSH 或内存策略表；
  - 安装包不再构建、拷贝 `resources/agent-host`；
  - 四套 tsc 仍然都在，并且都通过。
- **验证**：
  - 通用命令；
  - `pnpm exec vitest run src/main src/preload`；
  - `pnpm exec vitest run src/renderer/components/settings src/renderer/stores`；
  - `pnpm exec vitest run scripts`。
  - 打包只能在 CI 上验证：推送后手动触发 `build.yml`（Q2），确认 Windows、Linux 两个包里都没有 `resources/agent-host`，L1 的 44 项全过。

### 第 2 步：迁移要保留的用例（约 1～2 个代理会话；不删任何东西）

- **A 类权限用例**：以 [P1-6 分片 04](p1-6-permissions/04-regression-baseline.md) §1 的约 115 例为准。
  - 用例主体尽量不改，只把辅助函数（`start / bash / readTool / config` 等，它们现在用 faux provider 跑整轮 runtime）换成直接驱动纯库的写法，参照现成的 `shared/permissions/__tests__/pwshGate.test.ts`：`PermissionGate` + `loadPermissionPolicy` + 分析器。
  - 需要 bash 语法树的用例放进 `src/dsh-host/permissions/__tests__/`，用 `loadBashParser()`，因为 tree-sitter 的 wasm 只在 dsh-host 的依赖里；其余放进 `src/shared/permissions/__tests__/`。
  - 依赖 runtime 机制的用例，或者 DSH 下不存在的情形，判为 N/A 并写明原因。这类情形包括：cordis 图拆除与 drain、worker 的审批句子、D14 提示词槽位、`browser_preview`、MCP、技能的可信路径、委派定义声明的档位。如果已有 `permissionHost.test`（56 例）或 `perm-*` 录制场景覆盖，就写明由谁覆盖。
  - 产出逐条映射表，落 `evidence/p1-12-permission-case-map.md`：原用例 → 新位置 / 已有覆盖 / N/A 及理由。
- **解码链**：`runtime/__tests__/sessionCodec.test.ts`、`agent-host/__tests__/piSessionTimeline.test.ts`、`piSessionTree.test.ts` 搬进 `shared/legacyPiSession/__tests__/`，改为直接 import shared。
- **只读回放**：`sessionReplayReader.test.ts` 改为与语料金样本对拍（§1.11）。
- **结束时的状态**：新用例对纯库全绿；旧用例原地不动、照样全绿，两边同时通过就证明迁移没有改变判定。
- **验证**：
  - `pnpm exec vitest run src/shared/permissions src/dsh-host/permissions src/shared/legacyPiSession src/main/services/chat`；
  - `pnpm exec vitest run src/runtime`（旧用例仍绿）；
  - 四套 tsc。

### 第 3 步：删除 runtime、native worker 与依赖（约 1 个代理会话）

- **范围**：§1.2、§1.3、§1.6、§1.7 中标「3」的项；§1.8、§1.9、§1.11 中标「3」的项；`permissionPolicy.mjs` 挪进 `src/shared/permissions/`；`THIRD_PARTY_NOTICES`；`runtimeRetiredStatic` 补齐；§4 的第 3 步部分（gate 步骤、asar 反向检查）。
- **根依赖**：手改 `package.json` 后跑 `pnpm install --lockfile-only`，在同一个提交里带上 lockfile（R3）。
- **结束时的状态**：
  - `src/runtime`、`agent-host/worker.ts` 及其依赖都已删除；
  - 剩三套 tsc：根、agent-host（只剩 4 个源文件）、dsh-host；
  - 达到 P1-12 的两条退出判据。
- **验证**：
  - 通用命令（去掉 runtime 那一套 tsc）；
  - 全量单测按目录分批跑一次：`src/renderer`；`src/main src/preload src/shared`；`src/dsh-host src/agent-host scripts`；`src/__tests__`；
  - 推送后手动触发 `build.yml`，确认 verify-packaged-app 的新检查（§4）在 Windows、Linux 上通过，并记录产物大小的变化；
  - `dsh-bridge-gate.yml` 推送后自动运行，它用 `--frozen-lockfile`，正好顺带检查 lockfile 与 `package.json` 是否一致。

### 第 4 步（可选，见 Q1）：搬家与改名（约 0.5～1 个代理会话）

- **搬家**：
  - `piWorkerRpcServer.ts`、`piWorkerErrors.ts` 及测试搬进 `src/dsh-host/bridge/`；它们唯一的使用方就是 bridge，dsh-host 的 tsconfig 已经有 `erasableSyntaxOnly`。
  - `stderrRedaction.ts` 与 `credentialSamples` 搬进 `src/shared/`。
  - `codexItemMapper.ts` 与 codex 夹具搬进 `src/main/services/legacyImport/`。
  - 删掉 `src/agent-host/` 与 `typecheck:agent-host`；同步 gate、`BRIDGE_ENTRIES` 的 inputs、`build-dsh-host` 的脏检查目录表、各扫描测试的根、根 tsconfig 的 exclude、README。
  - 做完后只剩两套 tsc。
- **改名**（决策 010）：只改内部标识符和文件名，例如 `PiWorkerRpcServer`、`PiWorkerSessionError`、`createPiWorkerSlot`、日志前缀 `[pi-worker:`。线上字符串不改，范围见 Q1。
- **验证**：通用命令（两套 tsc）；`pnpm exec vitest run src/dsh-host src/main/services`；`--check` 应当 0 差异。

## 3 风险与回退

| # | 风险 | 应对 |
|---|---|---|
| R1 | **打包后首屏进 `runtime-unavailable`**：只删产物、没改 `PiRuntimeChecker` 时一定发生；而原来唯一起 Electron 的打包冒烟（worker 冒烟）也随之删除，CI 看不出来 | 第 1 步先改判据，加单测和静态守卫；P1-14 的打包版 GUI 点验把「首屏正常进入」列为第一项 |
| R2 | 权限设置页的 bundled 层消失 | 第 1 步改为读内存策略表，测试覆盖 |
| R3 | **共享 node_modules**：worktree 的根 `node_modules` 和两个子包的 `node_modules` 都是指向主检出的软链。`pnpm remove` 或 `pnpm install` 会改动主检出，而 1.0.x 维护还要用 `pi-coding-agent` | 手改 `package.json` 后只跑 `pnpm install --lockfile-only`，审查 lockfile 的 diff；删目录时只 `rm` 软链本身，不带结尾斜杠，不对链接目标 `rm -rf` |
| R4 | 从 main 合并 1.0.x 修复：main 还有 `src/runtime`，合并时会出现 modify/delete 冲突（上一次合并是 `553d4760`，即 1.0.4） | 冲突一律保持删除；若修复落在解码链、权限、技能、MCP、子代理目录规则，按 shared 文件头的出处注记，手工搬进对应的库。冲突本身就是提醒，所以「旧位置是薄封装」守卫可以删 |
| R5 | 覆盖流失：runtime 端到端（faux provider 跑整轮）、vendored 解码与上游 pi-agent-core 的对拍、`shared/mcp` 的真 stdio 端到端、与旧 pi-permission-system 的语义对拍 | 第 2 步迁走主体；剩下的由 v4 语料金样本和 `perm-*` 场景覆盖；`shared/mcp` 的端到端等以后启用 MCP 时再补（决策 147） |
| R6 | 语料无法再生成 | 语料已提交。确需重新生成时，在 P1-12 之前的提交上开临时 worktree 运行 |
| R7 | 遗漏引用、过期的静态测试（代理容易缩小范围） | 派工提示词逐项列出 §1.11；收尾时 `rg -a` 扫旧标识符，并重跑 Static / Scan / Wiring |
| R8 | 主进程打包、vite 拆块变化 | 本机不构建，由第 1、3 步的 CI 验证 |
| R9 | bridge 收窄后，`utility.start`、`worker.reload`、`worker.import*` 从「unsupported」变成「unknown method」 | Main 没有调用方；`--check` 应当 0 差异 |
| R10 | 删掉 `src/agent-host/package.json` 后，bridge 源码 shim 经 strip-types 加载这些文件时，最近的 `package.json` 变成根目录的那个（同样是 `"type": "module"`） | 第 3 步跑 bridge-smoke 与真宿主集成测试来确认 |
| R11 | Windows 覆盖安装后残留旧的 `resources/agent-host` | 推断 NSIS 会先运行旧版卸载程序，旧目录会被清掉；P1-14 在 Windows 实测时确认 |

**回退**：只能靠 git 历史。
- 每步单独提交，可以按步 revert。动工前把基线提交号记进看板。
- revert 第 3 步之后，还要在 `src/runtime`、`src/agent-host` 里各跑一次 `npm ci`，并恢复根 lockfile（注意 R3）。
- 第 1 步的打包链改动可以单独 revert。

## 4 删后 CI 与打包的变化

以 run 36651305647（`a3a25495`）的实测耗时为基准。

**build.yml 的 gate**（现在 8 道，用时 5 分 52 秒，超时 20 分钟）：
- 第 1 步：不动，因为 runtime 和 agent-host 的代码还在。
- 第 3 步：
  - 删「Install agent-host dependencies」（6 秒）、「Install runtime dependencies」（4 秒）、「Gate 3/8 typecheck:runtime」（8 秒）、「Gate 7/8 runtime smoke」与「Runtime tools smoke」（各 1 秒）；gate 编号改为 x/6。第 4 步后改为 x/5。
  - 「Gate 6/8 test」（160 秒）少掉 runtime 的 70 个测试文件。
  - 预计 gate 降到 5 分钟左右，按 `ceil(3N/10)*10` 的规则仍是 20 分钟，**超时不改**，只更新注释。

**打包 job**（windows 11 分 05 秒，超时 30；linux 5 分 09 秒，超时 20；macos 33 分 40 秒，超时 35，只能手动触发，决策 090 不做 macOS）：
- 第 1 步删三步：「Install agent-host dependencies」（4～20 秒）、「Install native runtime dependencies」（3～5 秒）、「Build Pi worker artifact」（2～4 秒）。
- 「Verify packaged Pi worker」改名为「Verify packaged app」。它现在用时 70～78 秒，其中包括起 Electron 的 worker 冒烟。
- electron-builder 少压缩约 85 MiB 的 agent-host 产物（决策 014 的估算；本机旧产物 132 MB）；第 3 步后 app.asar 还会少掉根依赖里的 pi 包。实际减了多少，以 CI 的产物大小为准，记进证据。
- 超时先不改，等第一次全绿后再按规则重算。macOS 现在离上限只差约 1.3 分钟，这次会宽松一些。

**verify-packaged-app 的检查项**：
- 删（第 1 步）：agent-host 产物的结构检查（`verifyArtifact`）、`agent-host/worker.js` 的 TSD 头检查、worker 产物 256 MiB 的上限、Electron 起 worker 的 bootstrap / dispose 冒烟（`runWorkerSmoke`、`--skip-smoke`、`packaged-worker-report`）。
- 留：法律声明（第 3 步换必需字符串）、`app.asar` 是否存在、Windows 可执行文件名、DSH 产物的结构 / 预算 / TSD 头、随包 node 版本、DSH L1 冒烟（44 项）。
- 新增（第 1 步）：`resources/agent-host` 不存在。
- 新增（第 3 步）：
  - app.asar 的 `node_modules` 里没有 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@gotgenes/pi-permission-system`、无作用域的 `cordis`。DSH 用的是 `@deepseek-ai/cordis`，在 `resources/dsh-host` 里，不受影响。
  - `out/main/index.js` 里没有 runtime 的标记字符串，比如 `NativeWorkerRuntime`。
  - 读取 asar 目录时建议自己解析 asar 头（8 字节 pickle 加一段 JSON），不依赖只是间接安装的 `@electron/asar`。
- 报告文件 `dist/worker-smoke-report.json` 和 artifact 名 `worker-smoke-*` 里只剩 DSH 的内容，改不改名都可以；改的话 `packaging-config` 测试要同步。

**其余配置**：
- afterPack 删 `copyAgentHost`，删 TSD 修复目标里的 `resources/agent-host`；
- `dist:prereq` 去掉 `build:agent-host`；
- `electron-builder.yml` 只删注释；
- `dsh-bridge-gate.yml` 不用改，但要求 lockfile 与 `package.json` 一致；
- 另外三个 Windows 工作流不涉及。

## 5 需要用户拍板的问题

- **Q1 第 4 步（搬家与决策 010 的改名）现在做吗？改到哪一层？**
  - 建议在 P1-12 内做：删掉 `src/agent-host`，只剩两套 tsc。
  - 改名只改内部标识符和文件名。
  - 不改线上字符串，因为它们是跨版本、会持久化、或者面向用户的约定：`pi_session_*` 错误码（渲染层按它映射，旧日志和失败注记里也有）、`AICLIENT_PI_WORKER_CAPACITY`（用户设置的环境变量）、IPC 名 `pi:runtime:check`、各设置键、会话索引里的 `agent: 'pi'`（回装 1.0.x 时要能认）。
  - 也可以把第 4 步整体推到合入之后再做。
- **Q2 推送与 CI**：打包只能在 CI 上验证。第 1 步、第 3 步之后各需要推送 `feat/dsh-p0-probe` 并手动触发一次 `build.yml`，是否同意？
- **Q3 `models.json` 还写不写**（决策 127 第 9 条说「P1-12 收尾时再看」）：
  - 它现在仍是菜单的兜底，也是「目录更新时间」的来源；里面的 `$AICLIENT_PI_USER_AGENT` 头引用在 worker 删掉后已经没有读者。
  - 建议 P1-12 不动，需要的话另开小任务。
- **另请过目**：`THIRD_PARTY_NOTICES.md` 的改写（§1.9），这是法律文本。

## 6 自主决定（实现时写进决策 147，待审批）

1. `PiRuntimeChecker` 的判据改为 DSH 布局（随包 node + `host.js`），`workerVersion` 改为 `'dsh-host'`。
2. 设置页的 bundled 层改读内存策略表；`permissionPolicy.mjs` 按决策 041 挪进 `src/shared/permissions/`。
3. A 类用例按 §2 第 2 步迁移；判为 N/A 的逐条列进证据里的映射表。
4. native 回放录制 `nativeStreamReplay` 和 5 份录制删除，不留作冻结金样本。
5. `shared/mcp` 的真 stdio 端到端用例不迁，代码保留（决策 090）。
6. `runtime-baseline` 只删 native 的两个脚本；`codexHistoryReader` 和没有引用的夹具顺带删除。
7. bootstrap 停发 `promptCacheTtl`、`providerIdleTimeoutMs`（bridge 不读）。
8. 删根依赖的两项 pi 包；verify-packaged-app 加 asar 反向检查。
9. `measure.ts`、`p0-6-probe.ts` 保留。

**不在 P1-12 范围**（以后可选的清理）：
- `custom.entry` 事件类型与渲染层的对应分支（只有 runtime 产出）；
- `WorkerManager` 接受 pre-v4 副本（`sessionSourceFile`）的分支（bridge 不返回这个字段，查实后可删）；
- 只被 runtime 用到的 i18n 词条；
- `AgentDirMigrationService`（从 `~/.pi/agent` 复制）在 DSH 下还有没有意义；
- `models.json`（Q3）；
- `PiRuntimeStatus`、`pi:runtime:check` 等命名。
