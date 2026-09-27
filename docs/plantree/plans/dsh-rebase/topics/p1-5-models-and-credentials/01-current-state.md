Role: detail shard

# P1-5 分片 01 · 现状全链路（1.0.x 与本分支）

上位：[P1-5 方案](../p1-5-models-and-credentials.md)。回答调研问题 1。行号约定同方案页：`WorkerManager.ts`、`createPiWorkerSlot.ts`、`dshSessionRuntime.ts`、`DshHostProcess.ts` 取 HEAD `66806e8f`（P1-1 已落地）；其余文件在 `7ca1cbc9` 与 `66806e8f` 之间没有变化。

## 1 登录与凭据存储

- **登录**：`OnboardingService.verifyAndRegister`（`OnboardingService.ts:162-272`）向 `<onboarding 服务>/api/onboarding/verify-and-register` 提交验证码。
  - 响应里必须有 `config.claude.authToken` 和 `config.codex.apiKey`（`:195-212`）。
  - `config.pi` 可选，缺省时沿用 codex 的地址与 key（`:439-448`）。
  - 登录即切到托管模式：`setCredentialMode('managed')`（`:228`）。
- **vault**：`saveVaultShadowCopy`（`:288-323`）写入 `{identity, cchBaseUrl, claude, codex, pi, receivedAt}`（`CredentialVault.ts:61-69`）。
  - 位置 `~/.pilab/<profile>/credentials/vault.json`（`auth/index.ts:56-61`、`appStatePaths.ts:88-91`），目录 0700、文件 0600（`CredentialVault.ts:789-806`）。
  - safeStorage 可用时整份 payload 加密（`:644-653`，适配器在 `auth/index.ts:36-42`）；不可用时以 `enc:'none'` 明文写入（`:654-662`），设置页会提示（`:320-329`）。
  - 用户自建服务（H/17）是 vault 里独立的 `userProviders` 组，各自带 key（`:87-114`），登出不清（`:755-767`）。
- **登录之后**：先 `invalidateAll()`（`OnboardingService.ts:268`、`:279-286`），IPC 的 `onSuccess` 再强制同步目录（`ipc/onboarding.ts:208-218`）。
  - 顺序是先失效、后同步。两者之间新起的 worker 拿到的是同步前的目录，同步完也不会再失效一次（推断，1.0.x 同样如此）。
- **Main 自己的环境**：托管模式下，启动时剔除继承来的 `ANTHROPIC_*` 等凭据变量（`managedCredentialsStartup.ts:39-61`，名单在 `scripts/credential-env-keys.mjs:30-46`）。

## 2 网关地址与模型目录

- **端点**：`<onboarding 服务>/api/v1/models-config`（`piModelConfig/index.ts:73-84`、`shared/piModelConfig.ts:135`），可由设置或 `PILAB_MODEL_CONFIG_URL` 覆盖。
- **同步**：`syncManagedPiModels`（`index.ts:237-269`）→ `PiModelConfigService.sync`（`PiModelConfigService.ts:278-413`）。
  - 用登录 key 作 Bearer（`:314`）；10 min 内视为新鲜（`:294-306`）。
  - 失败时依次退到上次缓存、随包快照 `resources/model-catalog/snapshot.json`、unavailable（`:347-412`）。
- **目录格式**（`shared/piModelConfig.ts:137-214`）：
  - provider：`api`（4 种）、`baseUrl`、`credentials{baseUrl, apiKey: managed | onboarding}`、可选的管理员 `apiKey`、`headers`（值只许 `$ENV` 引用，`configValidation.ts:247-257`）、`compat`。
  - 模型：`api` / `baseUrl` 覆盖（ARD D15）、`reasoning`、`thinkingLevelMap`、`input`、`contextWindow`、`maxTokens`、`samplingParams`、`compat`、`tags`。
- **网关根地址**：继承型 provider 的地址由登录下发的 `pi.baseUrl` 派生，anthropic 用根地址，openai 两种加 `/v1`（`shared/modelBaseUrl.ts` 的 `deriveInheritedBaseUrl`；`configValidation.ts:354-381`）。
- **key 归属**：声明 `apiKey: managed` 的用管理员 key，其余用登录 key（`configValidation.ts:384-391`）；用户服务用自己的 key（`PiModelConfigService.ts:743-750`）。
- **随包快照**（`updatedAt` 2026-09-07，读的是结构，按规则不含 key）：
  - 4 个 provider：claude（anthropic-messages）、gpt（openai-responses）、grok 和 china（openai-completions），共 10 个模型。
  - 全部继承登录的地址与 key，没有模型级地址覆盖。
  - provider 级 compat：claude 有 `forceAdaptiveThinking:true`、`supportsToolReferences:false`；gpt 有 `supportsDeveloperRole`；grok、china 有 `supportsDeveloperRole`、`supportsReasoningEffort`。
  - map 的写法：gpt 用 `off:"none"`；claude、china 用 `off:null`；china 只写了 high、max。

## 3 落盘文件（明文清单）

| 文件（`~/.pilab/<profile>/` 下） | 内容 | 谁读 | 依据 |
|---|---|---|---|
| `pi-agent/models.json` | 目录，pi 格式，不含 key | pi TUI；原生 worker 在 Main 拼不出目录时回退读 | `PiModelConfigService.ts:660-676` |
| `pi-agent/auth.json` | **每个 provider 的明文 key**，0600 | pi TUI（`PiTuiPty.ts:163-179` 经 `PI_CODING_AGENT_DIR` 指向这里，`index.ts:356-397`）；原生 worker 的回退 | `:674-675`、`:736-750` |
| `pi-agent/managed-models-source.json` | 上次拉到的原始目录，**可含管理员 key**，0600 | Main 重写时据此判断 key 来源 | `:127-144`、`:591` |
| `pi-agent/managed-models-state.json` | 同步状态 | Main | `:712-714` |
| `credentials/vault.json` | 登录凭据与用户服务；safeStorage 不可用时是明文 | Main | 见 §1 |

- vault 每次变更都会重写 `auth.json`（T082，`managedCredentialsStartup.ts:106-156`）。
- 登出第⑤步删 `auth.json`（`OnboardingService.ts:406-409` → `PiModelConfigService.ts:574-580`）。但 vault `clear` 的变更通知会触发重写，把用户服务的 key 又写回去（推断，按 `managedCredentialsStartup.ts:106-156` 的流程）。

## 4 目录 → 菜单 → worker

- **内存目录**：`resolveNativeModelCatalog()`（`index.ts:156-164` → `nativeCatalog.ts:52-81`）拼出 `{models, auth}`。托管模式拿不到登录凭据、或者用户组读不出来时返回 undefined，worker 改读磁盘文件。
- **菜单**：`CHAT_LIST_PI_MODELS`（`ipc/agentCatalog.ts:7-13`）→ `readPiModelCatalog()`（`index.ts:288-303`）→ `readCatalog`（`PiModelConfigService.ts:487-542`）。
  - 菜单与 worker 用同一份文档（T062）。
  - 菜单项只带 id、标签、tags、reasoning、thinkingLevelMap、contextWindow、input，不带 key 和地址（`shared/types/agentCatalog.ts:1-51`）。
- **渲染层**：`usePiModelCatalog` 缓存（`usePiModelCatalog.ts:68-122`），同步之后要显式调用 `refreshPiModelCatalog()`（`:51-65`）。
  - 可选的 effort 档位由 `effortsForModel` 算（`efforts.ts:149-176`）：reasoning 为 false 时没有档位；map 里为 null 的去掉；low、medium、high 默认提供；其余档位要 map 声明。
- **下发**：每次 spawn 读一次（`WorkerManager.ts:2555`、`:2579`，注入点 `:3540`），放进 `worker.bootstrap.modelCatalog`（`createPiWorkerSlot.ts:135`；类型见 `workerRpc.ts:195-223`）。
  - **本分支 HEAD 仍把含明文 key 的 `modelCatalog.auth` 发给 DSH 宿主。** bridge 不用它，但 `PiWorkerRpcServer` 会把整份 bootstrap 负载一直留到会话结束（`piWorkerRpcServer.ts:600-609`）。
- **原生 worker 怎么构造请求**：
  1. `parsePiCatalog`（`runtime/plugins/model-adapter/catalog.ts:184-260`）丢掉缺地址、缺 key 的行；
  2. 每个 provider 建一个 pi-ai registry，key 由 `resolve()` 按请求交出，`$ENV` 头在这一步展开（`binding.ts:120-162`、`catalog.ts:270-291`）；
  3. `resolve(ref)`（`model-adapter/index.ts:113-133`）。pi-ai 模型的 `provider` 字段就是我方 provider id（`binding.ts:78`）。

## 5 每轮切换与 effort

- **渲染层的选择链**：会话自己的选择 → 代理模板 → Automatic（`models.ts:243-255`）。选 Automatic 时不发 model（`:190-195`）；effort 选 Default 时不发这个字段（`efforts.ts:64`、`:124-126`）。
- **IPC**：`CHAT_SEND`（`chat.ts:609-636`）把 `model`、`effort` 原样交给 `worker.send`（`workerRpc.ts:433-450`）；新建和恢复时放进 bootstrap（`chat.ts:357-367`、`:561-584`）。
- **原生语义**：
  - 没选 effort 时，主会话按 medium 发（`agent-loop/index.ts:172-182`）；
  - 主会话缓存 1 h，子代理 5 min（`:184-196`）；
  - provider 重试 3 次，间隔 3 s、10 s、30 s（`providerRetry.ts:64-74`）；
  - `costUsd` 恒为 0，因为价格表全写 0（`binding.ts:39-49`）。
- **一次性补全的 effort**：`off` 和不选都不发（`nativeUtility.ts:37-50`、`:110`）。
- `tier` 是权限档位（`sessionPermissionTier.ts:8`），与模型无关，归 P1-6。

## 6 失效

| 触发 | 动作 | 依据 |
|---|---|---|
| 登录 | 写 vault → `invalidateAll` → 强制同步 | `OnboardingService.ts:245-269`、`ipc/onboarding.ts:208-218` |
| 登出 | 关 spawn 闸 → 关终端与 TUI → `invalidateAll` 加 `piUtilityService.invalidateAll` → 清 vault → 删 `auth.json` | `ipc/onboarding.ts:91-188` |
| 手动同步、重试 | 同步成功才 `invalidateAll` | `ipc/piModels.ts:41-51` |
| 用户服务编辑、从 pi 迁移服务 | 重写 `models.json` / `auth.json`，然后 `invalidateAll` | `userProviders/index.ts:96-110`、`agentMigration/index.ts:50-57` |
| 探针确认凭据被拒 | `invalidateAll` | `auth/index.ts:68-71` |
| 插件、资源设置变更 | `invalidateAll` | `piPlugins/index.ts:123-139`、`ipc/piResources.ts:109` |

- `invalidateAll` 本身做两件事：配置代数加一，逐个 dispose（`WorkerManager.ts:2468-2474`）。决策 025 要求它连宿主一起关。
- 回合内收到 401 不会触发登录探针，只出错误卡（探针只由状态变化和 UsageService 触发，`ipc/auth.ts:51`、`UsageService.ts:140`）。

## 7 本分支的 DSH 现状（P1-1 之后）

- **路由写死在 bundle 里**：唯一路由 `aiclient-gateway`（anthropic-messages，`baseURL` 取 `AICLIENT_DSH_GATEWAY_URL`，缺省 `127.0.0.1:9`，`apiKeyEnv: AICLIENT_DSH_GATEWAY_KEY`，模型 `fake-1`），外加 `agent-default-model`（`bundle/cordis.patch.yml:66-90`）。
- 两个网关变量只在未打包时透传（`DshHostProcess.ts:68-73`、`:136`），打包态必然打到 discard 端口。
- **bridge**：新建和恢复都用 `agentDefaultModel.currentSelection()`（`dshSessionRuntime.ts:450`、`:507`、`:564`），忽略 Main 给的 model 和 effort，只把 model 原样回显（`:480`）；send 也不看 model 和 effort（`:582-615`）。所以界面显示的是用户选的模型，实际走的是 `aiclient-gateway/fake-1`。
- **一次性补全**：bridge 的 `createUtilityRuntime` 直接抛 `WORKER_DSH_UNSUPPORTED`（`bundle/lib/bridge.js:64-66`）；Main 的 `PiUtilityService` 仍然 fork 原生 worker（`PiUtilityService.ts:110-123`）。
