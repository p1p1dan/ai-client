Role: topic

# P1-5 模型目录与凭据（连带 P1-15 一次性补全换引擎）：方案

上位：[roadmap P1-5 / P1-15](../roadmap.md)。

依据：
- 决策：[001](../decisions/001-route-b-and-scope.md)（登录、额度自有功能保留）、[003](../decisions/003-p0-closeout-enter-p1.md)（钉 `0.1.7-rc.2`）、[004](../decisions/004-branch-isolated-dsh-only.md)、[008](../decisions/008-private-dsh-home.md)（私有 `DSH_HOME`）、[022](../decisions/022-host-env-inherits-main.md)（宿主环境继承再剔除）、[025](../decisions/025-host-lifecycle.md)（`invalidateAll` 连宿主一起关）；
- 证据：[P0-2](../evidence/p0-2-goal-and-plugins-2026-09-25.md)（`llm-pi-ai` 纯配置路由到我方网关，官方行已关）；
- 方案：[P1-1 §9](p1-1-engine-cutover.md#9-风险与未覆盖)、[P1-3](p1-3-shared-host.md)、[P1-4](p1-4-bridge-parity.md)（§6 列出了要 P1-5 提供的东西）。

状态：只读调研，方案待拍板（§5）。

明细分片：[01 现状全链路](p1-5-models-and-credentials/01-current-state.md) · [02 DSH 侧事实](p1-5-models-and-credentials/02-dsh-facts.md) · [03 方案细节与安全](p1-5-models-and-credentials/03-design.md) · [04 一次性补全（P1-15）](p1-5-models-and-credentials/04-one-shot-completions.md) · [05 改动、测试与真实网关清单](p1-5-models-and-credentials/05-changes-and-tests.md)。

约定：
- 调研期间 P1-1 已经落地（`100ebcf1`，HEAD `66806e8f`）。`WorkerManager.ts`、`createPiWorkerSlot.ts`、`dshSessionRuntime.ts`、`DshHostProcess.ts` 的行号取 `66806e8f`；其余文件在 `7ca1cbc9` 与 `66806e8f` 之间没有变化。
- DSH 的行号写作 `<包>:行号`，指 `src/dsh-host/node_modules/@deepseek-ai/<包>/lib/index.js`。
- 「推断」表示读码得出、没有运行验证。
- 本次没有调用任何模型或网关，也没有读任何凭据文件的内容。只看了代码，以及随包的目录快照 `resources/model-catalog/snapshot.json`，它按规则不含 key。

## 1 结论先行

1. **能做，改动集中在两处：Main 生成「模型计划」，宿主换掉凭据提供者。**
   - DSH 的 `llm-pi-ai` 与我方原生 runtime 底下是同一个 pi-ai（0.85.1 与 0.84.4），地址派生、协议、档位词表都能一一对上。
2. **推荐形态**（D1～D3）：
   - Main 用一个纯函数，把现有内存目录（`resolveNativeModelCatalog()` 的 `models` 半）翻成模型计划。计划包括：`llm-pi-ai` 路由（不含 key，只有 `apiKeyEnv` 引用名）、默认模型、「我方模型 id → 路由」的索引、修订号。
   - 宿主启动时，经 P1-3 的宿主控制通道收一条 `configure`，以内存 overlay 注入 `llm-pi-ai` 与 `agent-default-model` 两行。不写盘，不进环境。
   - 关掉 dsh-base 的 `credentials` 行。它挂的是 `dsh-credentials-local`，会读写明文 `$DSH_HOME/.credentials.yaml`。换成我方只读的提供者：`llm-pi-ai` 每次请求解析引用名时，这个提供者向 Main 要 key；Main 从 vault 取出来回给它；宿主不缓存。
   - 菜单、会话索引、设置里存的仍是我方的 `provider/modelId`。菜单按计划过滤，与宿主路由出自同一次计算。修订号一变，就按决策 025 走 `invalidateAll`。
3. **现状缺口**，P1-1 之后仍在：
   - Main 还在把含明文 key 的 `modelCatalog.auth` 放进每个 `worker.bootstrap` 发给 DSH 宿主，`PiWorkerRpcServer` 会一直留着它（`WorkerManager.ts:2555,2579`，`createPiWorkerSlot.ts:135`，`piWorkerRpcServer.ts:600`）。第一步就删。
   - bridge 忽略用户选的 model 和 effort，实际一律走 `aiclient-gateway/fake-1`；打包态只会打到 discard 端口（`dshSessionRuntime.ts:450,507,564`，`DshHostProcess.ts:68-73`，`bundle/cordis.patch.yml:66-90`）。
4. **有几处语义差异要显式处理**（分片 03 §2、§5）：
   - 档位声明的写法：我方 map 里 `null` 表示不支持；DSH 里 `off` 写空值表示「支持但不发送」，其他档位没写就算不支持。翻译规则：null 一律不写；low / medium / high 没写的，补成同名。
   - 没选档位时：1.0.x 主会话发 medium，DSH 什么都不发（GPT 类因此不思考）。由 bridge 补上 medium。
   - DSH 手写路由只支持 3 种协议（我方用户服务可选 10 种）；compat 键有白名单；没有 `samplingParams`；一条路由只有一个地址。
   - User-Agent 被 DSH 固定成 `deepseek-harness/…`，F08 的 `claude-cli-pilab/<版本>` 发不出去（D5）。
5. **安全**：
   - DSH 路径上，key 不落盘，不进宿主环境和工具环境，不进模型上下文，也不进会话日志（请求头只记路由和档位）。
   - 遗留的明文在 pi 路径上：`pi-agent/auth.json`（TUI 在读）、`managed-models-source.json`（可能含管理员 key）。怎么收口见 D6。
   - 与加密机约束没有冲突：宿主不读凭据文件；Main 读 vault 与 1.0.x 相同。
6. **P1-15**：推荐 A'「经宿主的 LLM 服务直调」。
   - bridge 的 `createUtilityRuntime` 用 `ctx.llm.stream` 实现现有的 `utility.*` RPC：不开会话，没有工具，不落盘。
   - Main 的 `PiUtilityService` 只换 transport。
   - git diff 仍在 Main 里取，所以各方案对加密机的影响都一样（D7）。
7. **规模**：约 1.5～2 人周（粗估）。产品代码约 1.3k 行，测试约 2k 行，切成 P1-5a～e 和 P1-15（§6）。宿主侧依赖 P1-3a / b；翻译函数和 `resolveRoute` 可以先做。
8. **要用户拍板或授权的**：
   - D4：用户自建服务里有 7 种协议在 DSH 下不可用；
   - D5：User-Agent，需要授权实测网关；
   - D6：退出判据「key 不以明文落盘」怎么解释，`auth.json` 什么时候停写；
   - §7.3 的真实网关验证，要用户授权后才能执行。

## 2 现状（明细见分片 01）

| 环节 | 事实 | 依据 |
|---|---|---|
| 登录 | 登录下发 claude / codex / pi 三组 key 与地址，写进 vault（safeStorage 不可用时明文）；登录即切托管模式 | `OnboardingService.ts:162-272,288-323`；`CredentialVault.ts:61-69,613-667` |
| 目录 | `<onboarding>/api/v1/models-config`，用登录 key 作 Bearer；失败时依次退到缓存、随包快照、unavailable | `piModelConfig/index.ts:73-84,237-269`；`PiModelConfigService.ts:278-413` |
| 地址与 key | 继承型 provider 从登录 `pi.baseUrl` 派生（anthropic 用根地址，openai 加 `/v1`）；key 是管理员的、登录的或用户自己的 | `configValidation.ts:354-391`；`PiModelConfigService.ts:725-752` |
| 落盘 | `pi-agent/auth.json` 是明文 key（给 TUI 用，也是原生的回退）；`managed-models-source.json` 可能含管理员 key；vault 一变就重写 `auth.json` | `PiModelConfigService.ts:591,674-675`；`PiTuiPty.ts:163-179`；`managedCredentialsStartup.ts:106-156` |
| 菜单 | 菜单与 worker 用同一份内存文档（T062）；菜单项不带 key 和地址 | `index.ts:288-303`；`agentCatalog.ts:1-51` |
| 下发 | 每次 spawn 读一次目录放进 bootstrap；原生按请求交出 key，并展开 `$ENV` 头 | `WorkerManager.ts:2555,2579`；`binding.ts:120-162` |
| 每轮切换 | 渲染层按「会话 → 模板 → Automatic」选；`worker.send` 带 model 和 effort；原生没选档位时发 medium，重试 3 次（3 s / 10 s / 30 s） | `models.ts:243-255`；`chat.ts:609-636`；`agent-loop/index.ts:172-182`；`providerRetry.ts:64-74` |
| 失效 | 登录、登出、手动同步、用户服务编辑、插件变更都 `invalidateAll`；登出另外清 vault、删 `auth.json` | `ipc/onboarding.ts:91-188,208-218`；`ipc/piModels.ts:41-51` |
| DSH 现状 | 路由写死成假网关；bridge 忽略 model / effort；补全不支持 | `bundle/cordis.patch.yml:66-90`；`bridge.js:64-66` |

`tier` 是权限档位（`sessionPermissionTier.ts:8`），与模型无关，归 P1-6。

## 3 DSH 侧事实（明细见分片 02）

- **路由配置**：`providers` 字典（`dsh-llm-pi-ai:1013-1047`）。它是 volatile 配置，可以热更新（`:2624-2632`）。
  - 手写路由只支持 `openai-completions`、`openai-responses`、`anthropic-messages` 三种协议（`:798-802`）。
  - 一条路由只有一个 `baseURL`；compat 键按协议有白名单（`:429-447,518-526`）。
- **key 注入点**：每次请求都走 `ctx.credentials.resolve(apiKeyEnv)`；没有 credentials 服务时才读启动环境快照（`:2559-2566,1848`）。
  - credentials 服务是可以替换的抽象类（`dsh-credentials:108-157`，README:189）。
  - dsh-base 默认挂的实现把明文写进 `$DSH_HOME/.credentials.yaml`（`dsh-base/cordis.patch.yml:117-118`；credentials-local README:44）。
- **补丁语义**：同 `id` 的补丁按字段整体替换，`name` 不同就跳过（`dsh-app-boot:61-110`）。`overlays` 排在用户层之后（`:1022-1034`）。
- **默认模型与每轮切换**：
  - `agent-default-model` 必须给 provider 和 model。
  - 每轮切换用 `installModelSelection`（`dsh-agent:166-209`）；换模型时会追加一条模型可见的 `[model changed]` 注记（`:133-147`）。
  - 子代理继承父会话的路由（`dsh-subagent:407-445`）。
- **档位**：词表与我方相同；声明语义不同（`dsh-llm-pi-ai:563-586`）。显式档位不受支持时，回合直接失败（`:1701-1705`）。
- **User-Agent**：是保留字，固定发 `deepseek-harness/…`，profile 改不了（`:1733-1740`；`dsh-llm:877-879`）。
- **用量与上下文窗口**：用量取 `assistant/message.usage`；上下文窗口取路由里模型的 `contextWindow`（`dsh-llm-pi-ai:1367-1375,1822`）。DSH 不算费用，1.0.x 原生也恒为 0。
- **直调**：`ctx.llm.stream` 与会话共用同一个适配器和凭据，不建会话，只试一次、不重试（`dsh-llm` README:48-76）。

## 4 方案（明细见分片 03、04）

**4.1 模型计划。** `src/shared/dshModelPlan.ts` 是一个纯函数，输入 `models` 文档和「每个 provider 有没有 key」，输出：

- `routes`：路由键就是我方 provider id；模型声明了不同地址或协议的，拆出 `<id>~2` 等路由。
- `defaultModel`：目录里第一个可用模型。
- `index`：我方 id → `{route, model, efforts, image}`。
- `refs`：`AICLIENT_KEY_<ID>` → provider id。
- `dropped`，以及 `revision`。

翻译规则共 11 条，见分片 03 §2。要点：
- 路由键不加前缀，与原生 pi-ai 的 `provider` 取值一致；
- 协议、compat、头都按白名单；丢掉的记进 `dropped` 并写日志；
- 档位按上面第 1 节第 4 条的规则翻；
- 缺省值对齐原生：128000 / 8192。

**4.2 路由下发与失效。** 首条控制消息 `configure` 带计划和 `nonce`，宿主据此注入 overlay，`ready` 回报修订号和路由诊断。

- 删掉 bundle 里的假路由和 `DEV_GATEWAY_ENV`；开发与点验改为把假网关登记成用户服务。
- 菜单只列计划里的模型；不受支持的计入 `unavailable`，供菜单底部提示。
- 菜单项带上计划里的 `efforts`，渲染层直接用它，这样菜单能选的档位与宿主能接受的档位就是同一份。
- 现有的 `invalidateAll` 调用点不变。新增一条兜底：修订号与在跑的宿主不一致时，排一次 `invalidateAll`（有在飞回合就等到空闲）。它补上了「登录后异步同步」和「启动同步」这两个 1.0.x 也没覆盖的窗口。

**4.3 凭据按请求注入。**

- 宿主侧 `aiclient-credentials` 是只读提供者：
  - 只认计划里的引用名，计划外的一律返回 undefined。pi-ai 按环境自找凭据时，最后读的是启动环境快照，而决策 022 已经把敏感名剔掉了。
  - 遇到计划内的引用名，发 `{host:'credential', id, ref, nonce}`，5 s 超时。
  - 不缓存；写接口全部拒绝。
- Main 侧 `DshCredentialBroker`：
  - 校验通道、nonce 和引用名；
  - 按现有的归属规则取 key，内存缓存到 vault 下次变更为止；
  - 登出或钥匙串锁住时回 `unavailable`，不再退回读 `auth.json`；
  - 永不记录值。

**4.4 每轮切换与映射。** `resolveRoute(plan, modelId, effort, mode)` 由 bridge 调用（P1-4d、P1-15）。

- 会话里没选档位就发 medium（模型支持时）；补全里 `off` 和没选都不发；不支持的档位剔除，不让回合失败。
- 设置映射：缓存 TTL → `cacheRetention`；空闲超时 → `streamIdleTimeoutMs`（0 映射成上限值）；重试 3 次、3 s～30 s → `retryPolicy`。
- 失败码映射到原生分类，外加一个新码 `CREDENTIALS_UNAVAILABLE`（分片 03 §5）。

**4.5 P1-15。** 采用 A'（分片 04）：

- bridge 加 `DshUtilityRuntime`（`ctx.llm.stream`），`inject` 加 `llm`；
- `PiUtilityService` 换成 DSH 通道，不再下发 `modelCatalog`；
- 容量、超时、取消、登出失效的语义都不变。

## 5 需要拍板的决策点

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| D1 | 路由怎么交给共享宿主 | A 启动时经控制通道 `configure`，以内存 overlay 注入，目录一变就重启宿主；B 运行中热更新 volatile 配置；C 写进 profile 补丁文件；D 用环境变量传 JSON | A | 不落盘，不进工具环境；与决策 025「目录变更关宿主」一致，只有一种状态 | 目录变更要冷启动宿主（约 0.8 s）；B 以后可以作为优化 |
| D2 | key 怎么注入 | A 自有只读提供者，每次请求向 Main 拉取；B 同一个提供者，但由 Main 推送、宿主内存常驻；C 环境变量（现状）；D `.credentials.yaml`（否决，明文）；E Main 本地反代，宿主只拿一次性令牌 | A | 就是 roadmap 说的「按请求注入」；登出、换 key 下一次请求就生效；宿主里不常驻 key | 每次请求多一次本机 IPC；依赖 P1-3 的控制通道。E 能顺带解决 D5，但 Main 要搬运全部流量 |
| D3 | 模型身份 | A 界面和存储仍用我方 `provider/modelId`，宿主内按索引翻译；B 改用 DSH 路由键 | A | P1-9 不用迁移任何模型选择；路由键与原生 `provider` 一致，pi-ai 里按 provider 判断的默认值不变 | 多维护一张索引表 |
| D4 | DSH 不支持的协议与字段（**建议用户拍板**） | A 过滤掉，并在菜单和服务设置里说明；B 给 llm-pi-ai 打本地补丁，把 google / mistral / pi-messages 各加一行；C 自己写一个 LLM 适配插件 | A | 公司目录全在三种协议里（快照 10 / 10）；B 要修改钉死版本的 DSH 包，每次升级都得重做 | 用户自建的 google、mistral、bedrock、vertex、azure、codex、pi-messages 服务在 DSH 分支不可用（有多少人在用，未知） |
| D5 | User-Agent（**建议用户拍板，并授权实测**） | A 接受 DSH 的 UA，另加标识头（如 `X-Pilab-Client`），通知网关管理员；B 在宿主里用 fetch 拦截器，改写发往我方网关的 UA；C 给 llm-pi-ai 打补丁 | 先按 §7.3 的 R9 实测。网关不按 UA 拦截就选 A，否则选 B | A 最省事；B 不改 DSH 包（推断可行，要与 `dsh-http-proxy` 的全局 dispatcher 组合） | A 网关一侧要识别新的头；B 会拦截全局 fetch，DSH 升级时要复核 |
| D6 | 「key 不以明文落盘」的口径（**建议用户拍板**） | A：P1-5 保证 DSH 路径零明文（KEY-CANARY 门禁）、宿主收不到 key、管理员 key 缓存改为加密；`auth.json` 等 P1-11 定了 TUI 去留、P1-15 落地之后再停写，P1-12 收尾。B：P1-5 立刻停写 `auth.json`。C：维持现状，全部延后 | A | 不破坏 P1-11 之前 TUI 对旧会话的续聊（P1-1 D1） | 这期间 `auth.json` 仍是明文 0600，同一用户的进程都读得到（1.0.x 就是这样）；B 会让 TUI 马上失去模型访问 |
| D7 | 一次性补全（P1-15） | A' 宿主 LLM 直调；A 宿主开临时会话；B Main 直调网关；C 保留一个极小的补全载体 | A' | 只有一条模型路径；协议零新增；P1-12 能删干净 | 要依赖宿主（冷启动约 0.8 s，常驻约 180 MB），共享宿主崩溃会连带补全失败 |
| D8 | 没选档位时发什么 | A 会话发 medium（模型支持时）、补全不发；B 一律不发，照 DSH 原样 | A | 与 1.0.x 原生对等；B 会让 GPT 类在 Default 下不思考 | 与 DSH 官方桌面端的行为不同 |
| D9 | 设置映射与重试 | 按分片 03 §5；`subagentPromptCacheTtl` 在 DSH 下失效 | 如左 | DSH 只有路由级设置 | 子代理的缓存 TTL 不能单独设了 |

D1～D3 与 D7～D9 可以按工作方式自主决定，各补一份决策文件（拟 033 起），标「待审批」。D4～D6 请用户拍板。

## 6 改动清单与切分（明细见分片 05）

| 子任务 | 内容 | 主要文件 | 规模（产品 / 测试） | 依赖 |
|---|---|---|---|---|
| P1-5a 计划与路由 | 翻译函数、`resolveRoute`、修订号；菜单过滤；停止下发 `modelCatalog`；`configure` 与 overlay；删假路由和开发网关变量 | `shared/dshModelPlan.ts`（新）、`piModelConfig/index.ts`、`agentCatalog.ts`、`efforts.ts`、`WorkerManager.ts`、`createPiWorkerSlot.ts`、`host.ts`、`cordis.patch.yml`、`DshHostProcess.ts` | 450 / 650 | 纯函数部分无依赖；宿主侧在 P1-3a / b 之后 |
| P1-5b 凭据注入 | 只读提供者、broker、nonce、KEY-CANARY | `bundle/lib/credentials.js`（新）、`DshCredentialBroker.ts`（新）、`dshHostProtocol.ts` | 300 / 500 | P1-3b、a |
| P1-5c 切换与映射 | 档位规则、设置映射、失败码表 | `dshModelPlan.ts`、`shared/dshFailureCodes.ts`（新） | 150 / 300 | a；与 P1-4d 同批 |
| P1-5d 协议收口 | 服务设置只能选三种协议、菜单提示、文案 | `ProviderSetupDialog.tsx`、`i18n.ts` | 120 / 150 | D4 |
| P1-5e 遗留明文 | 管理员 key 缓存加密；`auth.json` 写入加开关 | `PiModelConfigService.ts` | 100 / 150 | D6 |
| P1-15 | `DshUtilityRuntime`；`PiUtilityService` 换 transport；静态守卫 | `bridge/dshUtilityRuntime.ts`（新）、`bridge.js`、`PiUtilityService.ts` | 200 / 350 | a、b；共享通道在 P1-3 之后 |

**与其他任务的边界**：
- **P1-3**：新增控制消息（`configure`、`credential`），允许 `utility.start` 建通道，宿主环境里不补任何 key；宿主要不要安装出站代理（`installProxyFromEnvironment`）要一并决定。
- **P1-4d**：调用 `resolveRoute` 和失败码表；`costUsd` 给 0；图片模态取计划里的 `input`；`[model changed]` 注记显示与否由 P1-4 决定。
- **P1-9**：模型选择不用迁移，只在设置页注明三项语义变化。
- **P1-10**：插件自己的凭据怎么办，以及插件能不能读到网关 key。
- **P1-11**：`auth.json` 的去留。
- **P1-12**：删除原生目录下发和原生补全。

## 7 测试方案（明细见分片 05 §3、§4）

**7.1 单测与静态守卫**（根 vitest，不装 DSH 包）：
- 翻译规则 MP-01～09，以随包快照作金样本；
- `resolveRoute` RR-01～06；提供者 CP、broker BR；菜单过滤；bootstrap 不含 `modelCatalog`；
- 静态守卫：`credentials` 行已关、`aiclient-credentials` 已插入，产品代码里没有 `AICLIENT_DSH_GATEWAY_`，`PiUtilityService` 不引用原生 worker。
- 渲染层 `effortsForModel` 优先用菜单项里的 `efforts`（MP-03）。
- 另加一个漂移门禁：在 dsh-host 子包里用真宿主加载快照计划，要求路由诊断为空。

**7.2 假网关能验到哪**（扩展 `fake-gateway.mjs`：记头、支持 openai 两种协议、`echo-key-error` 方案）：
- 能验：
  - 两条路由各用各的 key；运行中换 key、模拟登出；
  - 跨协议切换模型与注记；各档位进了请求体；
  - KEY-CANARY：`DSH_HOME`（含 zstd）、宿主 stderr、`/proc/<宿主>/environ`、工具环境、临时目录全部扫一遍；
  - 工具进程是否继承了 IPC 句柄；补全的流式输出与取消；实际发出的 UA。
- 验不到：
  - 真实网关是否接受这个 UA 和这些头；
  - 真实模型 id 与各协议的细节（compat、自适应思考、`max` 档位）；
  - 额度与限流；公司代理与 TLS。

**7.3 真实网关验证清单**（要用户授权；只用公司登录下发的网关，禁用私人渠道，网关不通就停下报告）：

| # | 步骤 |
|---|---|
| R1 | 登录后同步，核对菜单与计划一致 |
| R2 | 每个模型发一条「只回复 OK」 |
| R3 | 每种协议跑一次工具回合 |
| R4 | 每种协议挑一个推理模型，逐档跑一遍 |
| R5 | 会话里换模型，再换回来 |
| R6 | 读图 |
| R7 | 三种补全，加一次中途停止 |
| R8 | 登出、重新登录、切换账号 |
| R9 | 请管理员看网关日志里的 UA |
| R10 | 在 Main 里跑 canary 扫描，只输出命中与否 |

预计 50 次以内的小请求。证据写到 `evidence/p1-5-real-gateway-<日期>.md`，不写任何 key。

## 8 风险与未覆盖

- **IPC 句柄继承没有核实**：随包 Node 会删掉 `NODE_CHANNEL_FD` 这个环境变量，但工具进程会不会继承宿主的 IPC 句柄不知道。继承了的话，工具就能冒充宿主要 key，或者读走应答；nonce 只能防冒充。要靠 IT-07 实查，Windows 在 P1-14 的 CI 上补测。
- **服务商错误回显 key**：如果服务商的错误文本里带着 key，DSH 会把它写进 `llm/retry` 或 `turn/end` 并落盘。需要 KEY-CANARY 的 `echo-key-error` 场景验证。
- **同进程插件**：白名单插件能调用 `ctx.credentials.resolve`；能不能按调用方限制，没有核实。
- **UA**：网关有没有按 User-Agent 做准入或统计，没有核实。F08 落地时，「捕获真实出站请求头」这项联调也没有勾选（提交 `69576588` 的 TODO）。要按 R9 实测。
- **漂移**：DSH 升级会带来 compat 白名单与协议表的漂移，靠漂移门禁兜底。`COMPAT_GATES` 没有导出，所以门禁只能用真宿主的诊断来间接验证（推断）。
- **宿主依赖**：补全和聊天都依赖宿主；宿主的重启预算用完后，补全也不可用（决策 020）。
- **钥匙串锁住**：不再退回读 `auth.json`，所以 Linux 上钥匙串锁住时会话无法请求模型。1.0.x 在这种情况下还能用磁盘上的 key。
- **出站代理**：宿主目前不安装出站代理，产品的代理设置也没传进宿主。公司网络下真实网关能不能通，要在 R1 之前由 P1-3 定下。
- **没能确认的事实**：
  - 线上目录里有没有 `apiKey: managed` 的 provider（快照里没有）；
  - DSH 在 openai-responses 与 anthropic 上各档位实际发出的字段；
  - `listConfigurableProviders` 能否反映 deferred 模式下的错误；
  - Main 端每次请求解密 vault 的耗时（已设计缓存，未测）。
