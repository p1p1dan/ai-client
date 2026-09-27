Role: detail shard

# P1-5 分片 02 · DSH 侧事实（0.1.7-rc.2 源码）

上位：[P1-5 方案](../p1-5-models-and-credentials.md)。回答调研问题 2。`<包>:行号` 指 `src/dsh-host/node_modules/@deepseek-ai/<包>/lib/index.js`；README 行号指该包的 `README.md`；`pi-ai/…` 指 `src/dsh-host/node_modules/@earendil-works/pi-ai/dist/…`（0.85.1；我方原生 runtime 用的是 0.84.4）。

## 1 `llm-pi-ai` 路由

- **配置面**：`providers` 字典，键是路由名，也就是请求里的 `provider`；值是 profile（`dsh-llm-pi-ai:1013-1046`）。
  - 连接：`apiKeyEnv`、`displayName`、`api`、`baseURL`、`headers`。
  - 模型：`models[{id, name, contextWindow, maxTokens, input, reasoningEfforts, compat}]`、`modelOverrides`、`compat`；缺省值 `defaultContextWindow` 262144、`defaultMaxTokens` 32768、`defaultInput`。
  - 请求：`reasoning`（路由级默认档位）、`thinkingBudgets`、`cacheRetention`（none / short / long）、`transport`、`timeoutMs`、`streamIdleTimeoutMs`（缺省 300 s，必须为正）、三个图片上限、`retryPolicy`。
- **热更新**：`providers` 是 volatile 配置（`:1047`），改动经 `loader/volatile-update` 就地重注册路由，不用重启插件（`:2624-2632`）；每次请求取当时的快照（`:1759`）。
- **协议**：手写路由只支持三种：`openai-completions`、`openai-responses`、`anthropic-messages`（`:798-802`）。
  - 路由键与 pi-ai 内置 provider 同名、并且不写 `api` 时，才复用内置 provider（`:890-893`，说明在 `:761-775`）。我们总会写 `api`，所以不会走到复用。
  - README 的 Dev Note（:235 起）说：google、mistral、pi-messages 只是「还没人要」，加一行就行；Bedrock、Vertex、Azure、Codex 的鉴权形态这套配置表达不了。
- **地址**：一条路由只有一个 `baseURL`、一种协议（README:225）。模型级地址或协议覆盖，要拆成多条路由。
- **compat**：每种协议有一张「offer / withhold」表（`:429-447`）；设了不在 offer 里的键，整条 profile 被拒（`:518-526`）。
  - 快照里 claude 的 `supportsToolReferences` 属于 withhold（`:443`）。
  - pi-ai 的默认值按 provider id 判断，只对 `anthropic` 打开（`pi-ai/api/anthropic-messages.js:133-145`）。我方路由键是 `claude`，丢掉这个键后行为不变。
- **模型字段**：没有 `samplingParams` 和 `tags`（`:997-1007`）。
- **请求头**：
  - profile 的 `headers` 是字面字符串（`:1024`），只校验能不能放进 Fetch（`:1066-1072`）。README 提醒它可能夹带凭据，而且不会被脱敏（README:222）。
  - `user-agent` 是保留字：profile 里的同名头被删掉，统一发 `deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)`（`:1733-1740`；`dsh-llm:877-879`），没有配置口子。
- **校验时机**：初次加载用 deferred 模式，坏的 profile 只留诊断、不挡其他路由（`:1081-1142`、`:2543-2551`）；运行中改配置用 strict 模式（`:2552-2558`）。

## 2 凭据

- **每次请求都解析**：`resolveApiKey` 先问 `ctx.credentials.resolve(apiKeyEnv)`，没有 credentials 服务时才读启动环境快照，取不到就报 `MISSING_CREDENTIAL`（`:2559-2566`）。
  - `streamWithSnapshot` 每次调用都取一次（`:1848`），结果作为 pi-ai 请求选项里的 `apiKey`（`:1670-1682`），不缓存。
- **没配 `apiKeyEnv` 的路由**：交给 pi-ai 自己按环境找凭据；`authContextFrom` 先问 credentials 服务，再读启动环境快照（`:2082-2100`）。
- **服务接口**：credentials 服务是抽象类 `CredentialProvider`（`dsh-credentials:108-157`）。
  - 抽象方法：`resolve / describe / set / unset / readRecord / describeRecord / listRecords / modifyRecord / deleteRecord`（`dsh-credentials/lib/types/index.d.ts:119-191`）。
  - README 说可以换成钥匙串、helper 命令、KMS 之类的提供者（README:189）。
- **dsh-base 的默认提供者**：`credentials` 行挂的是 `dsh-credentials-local`（`dsh-base/cordis.patch.yml:117-118`）。
  - 存储是明文 YAML `$DSH_HOME/.credentials.yaml`，0600（README:44、:115）。
  - 取值顺序：启动环境 > 文件 > 项目 `.env` > `$DSH_HOME/.env`（README:69-80）。
- **用到 credentials 服务的包**（在已装的全部包里搜 `ctx.get("credentials")`、`ctx.credentials` 和 inject 声明）：`dsh-llm-pi-ai`、`dsh-authorization`（登录流程存 grant）、`dsh-client-connection`，以及我方已经关掉的 deepseek-account、llm-deepseek-api-key、web-search-deepseek。
- **补丁语义**：`id` 相同时，按字段整体替换（`dsh-app-boot:61-110`，替换在 `:106`）；`name` 不一致的补丁直接跳过（`:100-102`）。所以要换掉 `credentials` 行的实现，只能关掉原行，另插一行提供同名服务。
- **组合顺序**：bundle → profile 层 → `$DSH_HOME/cordis.patch.yml` → `overlays` → 遥测补丁（`dsh-app-boot:1022-1034`）。`overlays` 由启动器在内存里提供（`host.ts:114`），排在用户层之后。
- **不泄露值的地方**：
  - 错误信息只带引用名，不带值（`dsh-llm:1659-1663`、`dsh-llm-pi-ai:2565`）。
  - 会话日志里的请求头只记 provider、model、reasoningEffort、temperature、maxTokens、stop（`dsh-llm:367-371`）。
- **没有短期令牌机制**。我方网关也只在登录时下发长期 key（`OnboardingService.ts:195-196`、`:439-448`）。

## 3 默认模型、每轮切换、effort

- **默认模型**：`agent-default-model` 行必须给 provider 和 model（`dsh-base/cordis.patch.yml:82`；README）。
  - `currentSelection()` 返回 `{provider, model, reasoningEffort?}`。
  - `saveSelection()` 会写 profile 补丁，我们不用。
- **新建 / 恢复**：带 `AgentOptions{provider, model, reasoningEffort?, maxTokens?}`（`dsh-agent` README:43）。
  - 请求头一旦写进日志，之后就以日志为准；插件可以再经 `agent/request` 瀑布改（`dsh-agent-loop:1148-1175`）。
- **每轮切换**：正式接口是 `installModelSelection(agentCtx, selection)`（`dsh-agent:166-209`）。
  - 改了 `selection.current`，下一个 step 就用新的 provider、model、effort。
  - provider 或 model 变了，会在下一次请求前追加一条模型能看到的 user 消息 `[model changed: …]`，`source.kind` 为 `model-selection`，`form` 为 `notice`（`:133-147`）。只改 effort 不加。
  - P1-4 的方案已经按这个接口设计（`p1-4-bridge-parity/04-turn-semantics.md:121`）。
- **子代理**：默认继承父会话最近一次请求的路由（`dsh-subagent:407-445`）。
- **档位词表**与我方相同：`off, minimal, low, medium, high, xhigh, max`（`dsh-llm-pi-ai:297-305`；我方 `agentHost.ts:18-26`）。
- **声明语义不同**（翻译规则的依据）：

  | 写法 | 我方 `thinkingLevelMap`（pi-ai 语义） | DSH `reasoningEfforts`（`:563-586`） |
  |---|---|---|
  | `L: "x"` | 支持，线上发 x | 支持，线上发 x |
  | `L: null` | 不支持 | 只有 `off` 可以这样写，意思是「支持，但什么都不发」；其他档位写 null 直接报错 |
  | 不写 L | low / medium / high 算支持（渲染层也默认提供这三档）；xhigh / max 算不支持 | 一律不支持：没写的档位被钉成 null（`:576-581`） |
  | 整个字段缺省 | 看 `reasoning` | 手写路由等于非推理模型（`:565`） |
  | `false` | — | 非推理模型 |

- **请求时的行为**：
  - 显式档位先对照模型校验，不支持就报 `UNSUPPORTED_REASONING_EFFORT`，回合失败（`:1701-1705`；支持集合见 `:749-758`）。
  - `off` 不发 reasoning 选项（`:1671`）；不指定档位也不发。
  - 不发档位时，pi-ai 的 openai-responses 会按 map 里的 `off` 发 `effort:"none"`，也就是不思考（`pi-ai/api/openai-responses.js:253-268`）。1.0.x 是「没选就发 medium」，两边不一样。

## 4 用量、上下文窗口、重试、直调、代理

- **用量**：每个 step 的 `assistant/message.usage`（`mapUsage`，`dsh-llm-pi-ai:1367-1375`）；`request/context.contextWindow` 取路由里模型的 `contextWindow`（`:1822`）；另有 token-meter 投影。映射归 P1-4。
  - DSH 不算费用；1.0.x 原生也恒为 0，所以不需要定价。
- **重试**：路由级 `retryPolicy`，缺省为 normal、5 次、退避 0.5～10 s，可重试的码有 EMPTY_RESPONSE、RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT（`dsh-llm:247-274`）。pi-ai SDK 自带的重试是关掉的（`dsh-llm-pi-ai:1680`）。
- **直调**：`ctx.llm.stream({provider, model, system?, messages, reasoningEffort?, signal})` 走同一个适配器和同一个凭据接口，不建会话、不落盘，只试一次、不重试（`dsh-llm` README:48-70；`dsh-llm:2367-2373`）。
  - 结束时发 `finish{kind:'error', failure{code}}`，码有 `NO_ADAPTER`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED` 等（`dsh-llm` README:72-76）；`UNKNOWN_MODEL` 见 llm-pi-ai README 的「Failures and recovery」一节。
- **出站代理**：`dsh-http-proxy` 由 `dsh` 启动器安装（`dsh-http-proxy:536` 导出 `installProxyFromEnvironment`）。我方 `host.ts` 和 `dsh-app-boot` 都没有调用它。
- **IPC 句柄**：随包 Node v24.18.0 启动子进程时会执行 `delete process.env.NODE_CHANNEL_FD`（在 `out-node-runtime/node` 二进制里查到这条语句）。所以工具进程拿不到这个环境变量。IPC 句柄本身会不会被工具进程继承，**没有核实**。
