Role: detail shard

# P1-5 分片 03 · 方案细节：模型计划、路由下发、凭据注入、映射、安全

上位：[P1-5 方案](../p1-5-models-and-credentials.md)。回答调研问题 3、4。事实依据见[分片 01](01-current-state.md)、[分片 02](02-dsh-facts.md)；行号约定同方案页。本分片是设计，没有运行验证；标「推断」的待实现时核实。

## 1 数据流（推荐形态）

```
登录 / 同步 / 用户服务编辑
        │
Main：resolveNativeModelCatalog()  ──(models 半，不含 key)──►  buildDshModelPlan()  ──►  plan{revision, routes, defaultModel, index, refs}
        │                                                                  │
        │                                             ┌────────────────────┼─────────────────────┐
        │                                     菜单按 plan.index 过滤    宿主启动时 configure    Main 记下宿主的 revision
        │                                                                  │                   （变了就 invalidateAll，决策 025）
        │                                                     host.ts：overlays 注入 llm-pi-ai 与 agent-default-model
        │                                                                  │
        │                                         llm-pi-ai 每次请求 → ctx.credentials.resolve(AICLIENT_KEY_*)
        │                                                                  │  （我方只读提供者，宿主不缓存）
        └─── DshCredentialBroker ◄─────── {host:'credential', id, ref, nonce} ◄───────┘
             读 vault / 用户组 / 管理员 key ──► {host:'credential-result', id, value}
```

## 2 模型计划：翻译规则

输入：`resolveNativeModelCatalog()` 的 `models` 文档（`toPiModelsJson` 与 `toPiUserProvider` 已经把继承的地址解析好，`configValidation.ts:354-381`、`PiModelConfigService.ts:788-802`）；每个 provider 有没有 key（只要布尔值，来自 `auth` 半）；三项设置（§5）。输出：纯数据，不含任何 key。实现为 `src/shared/dshModelPlan.ts`，Main 与宿主里的 bridge 共用。

| # | 规则 | 理由 / 依据 |
|---|---|---|
| R1 | 路由键 = 我方 provider id。同一 provider 里有模型声明了不同的 (api, 地址)，按 (api, 地址) 分组：第一组用 provider id，其余依出现顺序用 `<id>~2`、`<id>~3` | pi-ai 模型的 `provider` 与 1.0.x 一样都是我方 id（`binding.ts:78`），pi-ai 里按 provider id 分支的默认值（如 `supportsToolReferences`）行为不变；DSH 一条路由只能有一个地址（README:225） |
| R2 | 只收 `openai-completions` / `openai-responses` / `anthropic-messages`，其余模型记入 `dropped{reason:'unsupported_api'}` | `dsh-llm-pi-ai:798-802`。随包快照的 10 个模型全在这三种里；用户服务可选 10 种（`shared/userProviders.ts:26-37`），见 D4 |
| R3 | `baseURL` 用已解析的地址；空地址记 `no_base_url` | 与原生一致（`catalog.ts:238`） |
| R4 | 需要 key 的 provider 没有 key，记 `no_api_key`；有 key 的路由写 `apiKeyEnv: AICLIENT_KEY_<ID>`（id 大写、非字母数字换 `_`，再加 4 位哈希防撞），`refs[ref] = providerId` | 与原生一致（`catalog.ts:239`）；引用名只由 provider id 决定，跨修订号稳定，旧宿主退出前 Main 仍能应答 |
| R5 | `headers`：`$NAME` 在 Main 展开，取值与原生相同（Main 环境，`catalog.ts:270-291`）；丢掉 `User-Agent`（DSH 保留字，见 D5）；头名像凭据的（`authorization`、`x-api-key` 等）拒收并丢掉整个 provider | DSH 的 headers 是字面值，写进内存 overlay 不落盘，但 README 提醒它不被脱敏（README:222）；快照里没有这类头 |
| R6 | compat：只保留该协议 offer 的键（静态表，与 `dsh-llm-pi-ai:429-447` 做漂移门禁），其余键丢掉、记日志，模型保留 | 快照里只丢 claude 的 `supportsToolReferences:false`；按 R1 路由键 `claude`，pi-ai 默认值同样是 false（`anthropic-messages.js:133-145`），行为不变 |
| R7 | 模型：`id`、`name`、`contextWindow`、`maxTokens`、`input` 照搬；路由级 `defaultContextWindow: 128000`、`defaultMaxTokens: 8192`；`samplingParams` 无处可放，丢掉并记日志 | 对齐原生缺省值（`catalog.ts:164-165`）；DSH 缺省是 262144 / 32768 |
| R8 | 推理：`reasoning !== true` → `reasoningEfforts: false`。否则逐档翻：`L:"x"` → `L:"x"`；`L:null` → **不写**（包括 `off`）；low / medium / high 没写 → 补成同名；其他没写的不写。翻完只剩 `off` 或为空，按非推理处理 | 语义差异见[分片 02 §3](02-dsh-facts.md#3-默认模型每轮切换effort)：我方 `off:null` 是「不支持」，照搬到 DSH 会变成「支持但不发送」；补三档对齐渲染层的默认三档（`efforts.ts:149-176`） |
| R9 | 默认模型 = 计划里第一个可用模型（目录顺序）；没有可用模型时给占位 `aiclient-none/none`，bridge 在发请求前就拒绝（`MODEL_CATALOG_EMPTY`） | 与原生 `defaultRef()` 一致（`model-adapter/index.ts:109-111`）；`agent-default-model` 必须有值 |
| R10 | `index[我方 id] = {route, model, efforts, image}`。`efforts`：推理模型按 DSH `getSupportedThinkingLevels`（`:749-758`）的算法得出；非推理模型为空，因为 DSH 对非推理模型不提供档位（`:1722-1732`）。同一份 `efforts` 也放进菜单项（`AgentModelOption` 追加 `efforts?`），渲染层有它就用它 | 菜单里能选的档位与宿主能接受的档位出自同一处。`reasoning` 字段缺省的模型，1.0.x 的渲染层会给三档，但原生并不生效（`catalog.ts:302`），改为以计划为准 |
| R11 | `revision` = 规范化 JSON（routes、defaultModel、index）的 sha256 | 菜单、宿主、失效判断都认它 |

**`resolveRoute(plan, modelId, effort, mode)`**（bridge 调用；P1-4d 的每轮切换、P1-15 的补全都用它）：

- `modelId` 缺省：会话沿用当前选择，新会话用默认模型；补全直接用默认模型（与原生 Automatic 相同）。
- `modelId` 不在 `index` 里：报 `MODEL_NOT_IN_PLAN`，渲染层据此刷新目录。
- `effort`：
  - 会话模式下缺省 → 模型支持就发 `medium`，不支持就不发（对齐 `agent-loop/index.ts:172-182`）；
  - 补全模式下缺省或为 `off` → 不发（对齐 `nativeUtility.ts:37-50`）；
  - 显式档位不在 `efforts` 里 → 去掉并记日志，不让回合因 `UNSUPPORTED_REASONING_EFFORT` 失败。
- 返回 `{provider: route, model, reasoningEffort?}`。

## 3 路由下发与失效

- **控制消息**（加在 P1-3 的宿主控制协议上）：
  - Main → 宿主，首条消息：`{host:'configure', revision, nonce, routes, defaultModel, index, refs}`。
  - 宿主在 `readProfilePatches` 之前等它（10 s 等不到就发 `fatal` 退出）。
  - 收到后追加两行 overlay：`{id:'llm-pi-ai', config:{providers: routes}}`、`{id:'agent-default-model', config: defaultModel}`，排在用户层之后（`dsh-app-boot:1022-1034`），并且是整体替换（`:106`）。
  - 计划经 `hostCtx.provide('aiclientModelPlan', …)` 交给 bridge 和凭据提供者，做法同 `profileContext`（`host.ts:210`）。
- **ready 回报**：`ready` 带上 `revision` 和路由诊断。诊断来自 `ctx.llm.listConfigurableProviders()` 各条目的 `error`（`dsh-llm:1749-1775`；条目在 `dsh-llm-pi-ai:2509-2525` 生成）。正常应为空；不为空说明翻译规则与 DSH 漂移了，Main 记日志，并在菜单里隐藏出错的路由。
- **删掉开发专用的路由**：bundle 里的 `aiclient-gateway` 路由（`bundle/cordis.patch.yml:66-90`）和 `DEV_GATEWAY_ENV`（`DshHostProcess.ts:68-73`、`:136`）。
  - 开发和点验改为把假网关登记成用户服务（现成的 `register-fake-provider.mjs`，隔离 HOME）；
  - `bridge-smoke` 的测试替身扮演 Main，负责下发 configure 并应答凭据请求。
- **停止下发 key**：`spawnForEntry` 不再读 `modelCatalog`，也不再发给 DSH（`WorkerManager.ts:2555`、`:2579`，`createPiWorkerSlot.ts:135`）。这一步不依赖 P1-3，可以最先做。
- **菜单**：`readPiModelCatalog()` 只列 `plan.index` 里有的模型，保持目录顺序。
  - `AgentModelCatalog` 追加可选字段 `unavailable?: {label, reason}[]`，供菜单底部提示「N 个模型因协议不受支持未列出」。这个字段不带 key 和地址，与 `agentCatalog.ts:1-18` 的约定一致。
- **失效**：
  - 现有的 `invalidateAll` 调用点不变（登录、登出、手动同步、用户服务编辑、迁移、插件），决策 025 已经让它连宿主一起关。
  - 新增一条兜底：Main 每次重建计划都比对正在运行的宿主的 `revision`，不同就排一次 `invalidateAll`；有在飞回合时推迟到空闲。
  - 这条兜底覆盖两个 1.0.x 没有覆盖的窗口：登录后的异步同步（`ipc/onboarding.ts:208-218`），以及启动同步（`index.ts:842`）完成之前宿主已经起来的情况。
- **与 P1-3 的依赖**：configure 和凭据消息都走宿主控制通道，所以 P1-5a / b 的宿主侧排在 P1-3a / b 之后。在这之前，开发机沿用环境变量方式。

## 4 凭据按请求注入

**宿主侧**（`bundle/lib/credentials.js`，名为 `aiclient-credentials`，继承 `CredentialProvider`）：

- bundle 补丁：`- id: credentials` 设 `disabled: true`，另插一行 `aiclient-credentials`；`host.ts` 的 `REQUIRED_DISABLED` 加上 `credentials`（P1-3 的隐私 overlay 会一并重申）。
  - 这样 `$DSH_HOME/.credentials.yaml` 永远不会被创建，也不会被读取。
- `resolve(ref)`：
  - ref 不在 `plan.refs` → 返回 `undefined`，不发消息。
    - pi-ai 按环境自找凭据时，先问这里、再读启动环境快照（`dsh-llm-pi-ai:2082-2100`）；快照里的敏感名已被决策 022 剔除。
    - 我方路由都写了 `apiKeyEnv`，本来也不走这条路。
  - 否则发 `{host:'credential', id, ref, nonce}`，等 `credential-result`（5 s 超时），返回 `{value, source:'aiclient-main'}`；拿不到返回 `undefined`，由 llm-pi-ai 报 `MISSING_CREDENTIAL`。
  - 不缓存。值只存在于这一次请求的 pi-ai 选项里（`dsh-llm-pi-ai:1848`、`:1670-1682`）。
- 其余接口：
  - `describe(ref)` → `{configured: ref ∈ plan.refs, writable: false}`；
  - `set / unset / modifyRecord / deleteRecord` 一律拒绝（只读）；
  - `readRecord` 返回 `undefined`，`listRecords` 返回 `[]`。
  - 后果：pi-ai 的 OAuth 登录流程写不进来，而我们本来就不用它。

**Main 侧**（`DshCredentialBroker`，挂在 P1-3 的 supervisor 上）：

- 应答前逐条校验：消息来自当前宿主的通道；`nonce` 等于本次启动时下发的那个；`ref` 在当前计划里。
- 取值：`resolveNativeModelCatalog()?.auth[providerId].key`，复用现有的 key 归属规则（`configValidation.ts:384-391`、`PiModelConfigService.ts:743-750`）。
  - 用一个内存缓存省掉每次请求的解密；`vault.onChange`（`CredentialVault.ts:359`）或计划重建时清掉。
- 登出、钥匙串锁住、vault 读不出 → 回 `error:'unavailable'`。不再像原生那样退回去读 `auth.json`（原生的回退见 `nativeCatalog.ts:37-50`）。
- 永不记录值。只按分钟计数写调试日志。

**为什么是「按请求拉取」**：roadmap 的原文就是「按请求注入」；登出、换 key 下一次请求就生效，不依赖宿主重启；宿主内存里不常驻 key。代价是每次请求多一次本机 IPC 往返（亚毫秒到数毫秒，相对模型延迟可以忽略，推断）。备选见方案页 D2。

## 5 设置与失败码映射

| 我方 | DSH 路由字段 | 规则 |
|---|---|---|
| `promptCacheTtl`（主会话，缺省 1 h） | `cacheRetention` | 1 h → long，5 min → short（对齐 `agent-loop/index.ts:184-196`） |
| `subagentPromptCacheTtl` | 没有对应字段（子代理继承同一路由） | 在 DSH 下失效，由 P1-9 在设置页注明 |
| `providerIdleTimeoutMs`（T093，缺省 120 s，0 表示关闭） | `streamIdleTimeoutMs`（缺省 300 s，必须为正） | 0 → 计时器上限值；缺省给 120 s；用 `!== undefined` 判断，不能用真值判断 |
| 原生重试：3 次，3 s / 10 s / 30 s | `retryPolicy` | `{mode:'normal', maxRetries:3, backoff:{initialDelayMs:3000, maxDelayMs:30000}}`；退避曲线不完全相同 |
| F08 User-Agent | 保留字，改不了 | 见 D5 |

失败码表放在 `src/shared/dshFailureCodes.ts`，由 P1-4d 接到 `session.failed.errorCode`，与原生分类（`providerErrors.ts:205-263`）对齐：

- `MISSING_CREDENTIAL` → 新码 `CREDENTIALS_UNAVAILABLE`，卡片写「登录已失效或系统钥匙串未解锁」；
- `INVALID_CREDENTIAL` / `AUTH` → `PROVIDER_UNAUTHORIZED`；
- `RATE_LIMIT` / `QUOTA` / `ACCOUNT_QUOTA` → `PROVIDER_RATE_LIMITED`；
- `CONTEXT_WINDOW_EXCEEDED` → `CONTEXT_TOO_LARGE`；
- `UNKNOWN_MODEL` / `NO_ADAPTER` / `MODEL_NOT_IN_PLAN` → `MODEL_NOT_CONFIGURED`；
- `TIMEOUT` → `TIMEOUT`，`TRANSPORT` → `NETWORK_ERROR`，`SERVER` → `PROVIDER_ERROR`。

与 1.0.x 一样，回合内 401 只出错误卡，不触发登录探针（[分片 01 §6](01-current-state.md#6-失效)）。

## 6 安全（问题 4）

| 要求 | 做法与依据 | 剩余风险 |
|---|---|---|
| 不以明文落盘：`DSH_HOME` | 关掉 `credentials` 行，`.credentials.yaml` 不会出现；路由里只有引用名；会话日志的请求头只记路由与档位（`dsh-llm:367-371`） | 服务商的错误文本如果回显 key，会进 `llm/retry`、`turn/end` 的失败信息并落盘。用 KEY-CANARY 场景验证，真出现了再在 bridge 加脱敏钩子（推断，钩子位置待定） |
| 日志、trace | 宿主 stderr 由 Main 统一脱敏（`WorkerManager.ts:2622-2630`，main-aux-06）；DSH 的错误只带引用名（`dsh-llm:1659-1663`）；遥测行已关（`host.ts:44-55`） | Main 自己的日志：broker 不打印值，单测钉住 |
| 崩溃转储 | 没有配置 crashReporter 或 `--report-on-fatalerror`（在 `src`、`scripts` 里搜不到） | 操作系统的 core dump 可能含内存中的 key，与 1.0.x 相同 |
| 不进环境、不进工具环境 | key 从不放进宿主环境（决策 022 会剔除 `*KEY*`，本方案也不补回）；DSH 另外会洗掉工具环境里的 `KEY/PASSWORD/SECRET/TOKEN`（`dsh-subprocess:32,50-56`）；Node 会删掉 `NODE_CHANNEL_FD` | **工具进程会不会继承宿主的 IPC 句柄，没有核实**（[分片 02 §4](02-dsh-facts.md#4-用量上下文窗口重试直调代理)）。拿到句柄就能冒充宿主或读走应答。nonce 只防冒充，所以要在 bridge-smoke 里用 `ls -l /proc/self/fd` 实查（Windows 查句柄继承） |
| 不进模型上下文 | key 只出现在 HTTP 头里；`[model changed]` 注记只含路由名（`dsh-agent:133-147`） | 同上一行的错误回显 |
| 同一宿主里的第三方插件 | 我方提供者只回答计划里的引用名 | 白名单插件（P1-10）同在一个进程，能调 `ctx.credentials.resolve` 拿到网关 key。能否按调用方限制（只允许 llm-pi-ai），要核实 Cordis 能否取到调用方（推断可行） |
| 加密机（ARD D11） | 宿主（随包 node）不读任何凭据文件，key 经 IPC 从 Main 来；Main 读 vault 与 1.0.x 相同；一次性补全的 git 仍由 Main 派生 | 无新增约束；git 在加密机上读到明文还是密文，是 1.0.x 就有的问题，归 P1-13 |
| 遗留明文 | `pi-agent/auth.json`（TUI 在读）、`managed-models-source.json`（可含管理员 key）、safeStorage 不可用时的 vault | 见方案页 D6 |

## 7 被放弃的做法

- **用 `dsh-credentials-local` 存 key**：明文 YAML 落在 `DSH_HOME` 下，并且与 `.env` 分层（README:69-80），直接违反退出判据。
- **环境变量传 key**（现状开发态）：key 在宿主整个生命周期都挂在进程环境里，同一用户可以从 `/proc/<pid>/environ` 读到；决策 022 的敏感名剔除还得专门补回。
- **写进 `$DSH_HOME/profiles/aiclient/cordis.patch.yml`**：路由落盘；plugin-manager 也写这个文件（P0-2）；而且这是用户层，优先级比 overlay 低。
- **运行中热更新路由**（`providers` 是 volatile 的，`dsh-llm-pi-ai:1047`、`:2624-2632`）：技术上可行，可以省掉目录变更时的宿主重启。但决策 025 本来就要在这些时机关宿主，两套机制并存只会多出一种状态。留作以后的优化。
