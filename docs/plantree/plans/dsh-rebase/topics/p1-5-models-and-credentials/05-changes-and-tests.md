Role: detail shard

# P1-5 分片 05 · 改动清单、切分、测试与真实网关验证清单

上位：[P1-5 方案](../p1-5-models-and-credentials.md)。回答调研问题 6、7。规模为粗估，格式是「产品代码行数 / 测试行数」。

## 1 改动清单（按子任务）

**P1-5a 模型计划与路由下发**（约 450 / 650）

| 文件 | 改动 |
|---|---|
| `src/shared/dshModelPlan.ts`（新） | `buildDshModelPlan`（[分片 03 §2](03-design.md#2-模型计划翻译规则) 的 R1～R11）、`resolveRoute`、`revision`；静态表：三种协议、各协议 offer 的 compat 键 |
| `src/main/services/piModelConfig/index.ts` | `resolveDshModelPlan()`：取 `resolveNativeModelCatalog()` 的 `models` 半和「有没有 key」，按修订号缓存；`readPiModelCatalog()` 按 `plan.index` 过滤菜单，并填 `unavailable` |
| `src/shared/types/agentCatalog.ts`、`efforts.ts` | 目录追加 `unavailable?: {label, reason}[]`；菜单项追加 `efforts?`；`effortsForModel` 有 `efforts` 时直接用它 |
| `WorkerManager.ts`、`createPiWorkerSlot.ts` | 不再读、也不再下发 `modelCatalog`（`:2555`、`:2579`；`:135`）；宿主修订号比对后排 `invalidateAll` |
| `src/dsh-host/host.ts` | 在组合补丁前等 `configure`；注入两行 overlay；`provide('aiclientModelPlan')`；`ready` 带 `revision` 和路由诊断 |
| `bundle/cordis.patch.yml`、`DshHostProcess.ts` | 删掉假路由 `aiclient-gateway` 和 `DEV_GATEWAY_ENV`；`agent-default-model` 改成占位值 |
| P1-3 的 supervisor、`dshHostProtocol.ts` | 启动后发 `configure`；保存 `nonce` 和 `revision` |

**P1-5b 凭据按请求注入**（约 300 / 500）

| 文件 | 改动 |
|---|---|
| `src/dsh-host/bundle/lib/credentials.js`（新）、`bundle/package.json` | 只读的 `CredentialProvider` 子类；peer 依赖加 `@deepseek-ai/dsh-credentials` |
| `bundle/cordis.patch.yml`、`host.ts` | 关掉 `credentials` 行，插入 `aiclient-credentials`；`REQUIRED_DISABLED` 加上 `credentials` |
| `src/main/services/agent-host/DshCredentialBroker.ts`（新） | 校验、取值、缓存与失效、计数日志（[分片 03 §4](03-design.md#4-凭据按请求注入)） |
| `dshHostProtocol.ts`、supervisor | `credential` / `credential-result` 两条消息 |

**P1-5c 每轮切换、档位与映射**（约 150 / 300）：`resolveRoute` 的档位规则、设置映射（缓存、空闲超时、重试）、`src/shared/dshFailureCodes.ts`。bridge 里接 `installModelSelection` 的那一侧归 P1-4d，P1-5c 只交付函数和它们的测试。

**P1-5d 用户服务协议收口**（约 120 / 150）：
- `ProviderSetupDialog.tsx`：新建服务只能选三种协议；已有的其他协议标「DSH 暂不支持」。
- 模型菜单底部提示 `unavailable` 的个数；`shared/i18n.ts` 补中英文案。
- 取决于 D4。

**P1-5e 遗留明文收口**（约 100 / 150）：
- `PiModelConfigService.ts`：管理员 key 从 `managed-models-source.json` 拆出来，改用 safeStorage 加密保存（复用 vault 的 `VaultCrypto`）。
- `auth.json` 的写入点收到一个开关后面，等 P1-11 定了去留再删。
- 取决于 D6。

**P1-15 一次性补全**（约 200 / 350）：
- `src/dsh-host/bridge/dshUtilityRuntime.ts`（新）；
- `bridge.js`：`inject` 加 `llm`，接上 `createUtilityRuntime`；
- `PiUtilityService.ts` 换 transport；系统提示词常量移到 shared；
- 静态守卫。见[分片 04](04-one-shot-completions.md)。

**验收工具**（约 250 行）：
- `fake-gateway.mjs` 加 `--log-headers`（记 UA、路径、model、key 的 sha256 前 8 位）、最简的 openai-completions / openai-responses 流式文本、`echo-key-error` 方案；
- `key-canary-scan.mjs`（新），扫描范围见 §3 的 IT-06。

**合计**：产品代码约 1.3k 行，测试约 2k 行，工具约 250 行，约 1.5～2 人周。

## 2 顺序与边界

- **顺序**：
  1. P1-5a 的纯函数部分和「停止下发 `modelCatalog`」不依赖 P1-3，可以马上做；
  2. P1-3a / b 落地；
  3. P1-5a 的宿主侧与 P1-5b；
  4. P1-5c，与 P1-4d 同批，由 P1-4d 调用；
  5. P1-15；
  6. P1-5d / e；
  7. 验收：假网关全套，然后在用户授权下跑真实网关清单。
- **P1-3**：宿主控制协议加 `configure`、`credential` / `credential-result`；允许 `utility.start` 建通道；`invalidateAll` 连宿主一起关（决策 025）。宿主环境里不补任何 key，决策 022 里「开发网关 key 显式补回」一条随 `DEV_GATEWAY_ENV` 一起删。代理：宿主要不要调用 `installProxyFromEnvironment`、要不要把产品代理设置（`ProxyConfig.ts` 的 `getProxyEnvVars`）传进宿主，归 P1-3 的环境策略，P1-5 的真实网关验证会用到。
- **P1-4**：P1-4d 调 `resolveRoute`；`message.started.model` 报我方 id；图片模态由计划的 `input` 给出；`costUsd` 给 0（与原生对等，不需要定价）；失败码查 `dshFailureCodes.ts`；`[model changed]` 注记的显示或隐藏由 P1-4 的历史投影决定（`source.kind:'model-selection'`）。
- **P1-9**：模型 id 不变，所以会话、代理模板、AI 功能里存的模型选择都不用迁移。要在设置页注明三项：`subagentPromptCacheTtl` 失效、空闲超时 0 的新含义、不受支持的协议。CC / Codex 导入（`PiImportProcess.ts`）归 P1-9，不在 P1-15 里。
- **P1-10**：白名单插件如果需要自己的凭据，我方提供者目前只读，要另议；插件能否读到网关 key 的限制见[分片 03 §6](03-design.md#6-安全问题-4)。
- **P1-11**：`auth.json` 的去留跟着 TUI 走。
- **P1-12**：删 `WorkerModelCatalog`、`resolveNativeModelCatalog` 在 WorkerManager 和 PiUtilityService 里的用法、`nativeCatalog.test.ts` 钉住的那一行（P1-1 inventory 第 82 行）、原生补全；`auth.json` 与 `models.json` 的写入器等 P1-11 定了再删。
- **P1-13**：没有新增约束；顺手确认 Main 派生的 git 在加密机上读到的是明文（1.0.x 也依赖这一点）。

## 3 测试方案

**单测**（根 vitest，不装 DSH 包就能跑）：

- MP-01：随包快照翻成 4 条路由、10 个模型；地址派生正确（anthropic 用根地址，openai 加 `/v1`）；引用名稳定。做成金样本。
- MP-02：`off:null` 不写；`off:"none"` 保留；china 的模型补上 low / medium；`reasoning:false` 翻成 `false`；只剩 `off` 时按非推理处理。
- MP-03：对快照和构造的样例，逐个模型比对：计划里的 `efforts`，与渲染层 `effortsForModel` 对 `reasoning` 明确的模型给出的集合相同；`reasoning` 缺省的模型以计划为准，不提供档位。
- MP-04：claude 丢掉 `supportsToolReferences`、保留 `forceAdaptiveThinking`；遇到未知键，模型仍然保留。
- MP-05：用户服务的 10 种协议里，7 种进 `dropped`；元数据 `reasoning:true` 翻成三档；没写 `contextWindow` 时用路由缺省值。
- MP-06：模型级的地址或协议覆盖拆成 `~2` 路由，`index` 指向正确的路由。
- MP-07：`$AICLIENT_PI_USER_AGENT` 展开后，User-Agent 被丢掉；带 `authorization` 头的 provider 被丢掉；把计划序列化后扫描 canary，不含任何 key。
- MP-08：输入相同，修订号相同；改一处 `contextWindow`，修订号就变。
- MP-09：设置映射的几个边界：TTL；超时为 0 和缺省；重试策略。
- RR-01～06：`resolveRoute` 的六种情况：缺省模型；未知模型报码；会话缺省档位发 medium；模型不支持 medium 时不带档位；补全的 `off` 和缺省都不带；显式的不支持档位被剔除。
- CP-01～05：凭据提供者：计划外的引用名不发消息；计划内的引用名发消息并返回值；超时返回 undefined；写接口全部拒绝；`describe` 不含值。
- BR-01～05：broker：nonce 不对就拒；引用名不在计划里就拒；登出后回 `unavailable`；`vault.onChange` 之后取到新 key；全程 `console` 输出里没有 key（用 spy 检查）。
- MN-01：菜单只列 `index` 里的模型，顺序不变；`unavailable` 计数正确。
- WM-01：发给 DSH 的 bootstrap 负载里没有 `modelCatalog`，WorkerManager 与 createPiWorkerSlot 两层都要测。
- **静态守卫**：
  - bundle 补丁里 `credentials` 是 disabled，并且有 `aiclient-credentials`；
  - `REQUIRED_DISABLED` 含 `credentials`；
  - 产品代码里不再出现 `AICLIENT_DSH_GATEWAY_`；
  - `PiUtilityService.ts` 不引用 `forkPiWorkerProcess`；
  - 改名后用 `rg` 扫一遍旧标识符，查过期的 `*Static` / `*Wiring` 测试（按记忆里「代理会缩范围并留下过期静态测试」那条）。
- **漂移门禁**（`src/dsh-host` 子包，要装 DSH 包）：
  - 静态协议表 = `supportedProtocols()`；
  - 静态 compat 表：`COMPAT_GATES` 没有导出，没法直接比对。改为用真宿主加载 MP-01 的计划，要求 `ready` 里的路由诊断为空（推断：`listConfigurableProviders` 能反映 deferred 模式下的错误）。

**集成测试**（bridge-smoke / P1-3 的 L1，假网关，开发机上一次只跑它）：

- IT-01：两条路由各配一个不同的假 key，网关日志逐个请求核对：收到的 key 哈希与路由对应。
- IT-02：会话中途让测试替身换一个 key，下一次请求就用新 key，宿主没有重启。
- IT-03：替身回 `unavailable`（模拟登出），回合失败，码为 `CREDENTIALS_UNAVAILABLE`。
- IT-04：会话中途换模型，从 anthropic 路由换到 openai-responses 路由：网关看到两种路径；会话日志里有 `model-selection` 注记。
- IT-05：每个档位都进了请求体；核对各协议的字段（具体字段名以 pi-ai 适配器为准）。
- IT-06 **KEY-CANARY**：用 `sk-canary-<随机>` 跑完全部场景（含 `echo-key-error`），然后扫描：
  - `$DSH_HOME` 全部文件，会话日志先解开 zstd；
  - 宿主 stderr，以及 Main 日志；
  - `/proc/<宿主>/environ` 与 `cmdline`；
  - bash 工具里 `env` 的输出；
  - `$TMPDIR/dsh-*`。

  期望：除网关收到的请求头以外，哪里都没有 canary。
- IT-07：bash 工具执行 `ls -l /proc/self/fd`，确认看不到宿主的 IPC socket。Windows 上的句柄继承在 P1-14 的 CI 里补测。
- IT-08：补全的流式输出，以及中途取消。
- IT-09：网关日志里 UA 的值，与 D5 选定的结果一致。

**假网关验不到的**：
- 真实网关是否接受这个 UA 和这些头、有没有按客户端拦截；
- 真实的模型 id 与各协议的细节（compat 开关、自适应思考、`max` 档位能不能用）；
- 额度与限流的真实语义；公司代理与 TLS；真实延迟。

这些只能靠 §4。

## 4 真实网关验证清单（用户授权后执行）

**前提**：
- 用户明确授权本轮调用真实网关，并确认所用账号和额度。
- 只用公司登录下发的网关；私人渠道（如 maxapi）一律禁用。网关不可用就停下报告，不换渠道，不自行找替代。
- 隔离 HOME，或用户指定的 dev profile；DSH 分支构建；P1-5a / b / c 与 P1-4d 已经落地。
- 请求量预计在 50 次以内，都是小请求：快照有 10 个模型，每个 2 次；3 种协议各做工具回合和档位；补全 6 次；切换 2 次。

**步骤**：

| # | 做什么 | 期望 |
|---|---|---|
| R1 | 登录，等目录同步完成 | 来源是 `remote`；记下模型数和每个 provider 的协议；菜单与计划一致，`unavailable` 为 0 |
| R2 | 每个模型新建一个会话，发「只回复 OK」，档位用 Default | 全部 completed；记下耗时和错误码 |
| R3 | 每种协议挑一个模型，跑一次工具回合（bash `echo ok`） | 工具行完成，回合收尾 |
| R4 | 每种协议挑一个推理模型，菜单里出现的每个档位各跑一轮 | 全部成功；会话日志 `request/header` 里的 `reasoningEffort` 与所选一致 |
| R5 | 同一会话里换一次模型（claude → gpt），再换回来 | 续聊正常；上下文连贯 |
| R6 | 给声明了 image 的模型发一张小图（依赖 P1-4c） | 模型能描述图片内容 |
| R7 | 三种补全各跑一次，Automatic 与指定模型各一次；代码评审中途停一次 | 结果正常；停止生效 |
| R8 | 登出：在飞的回合失败，宿主关停；重新登录后能用。有第二个账号的话再切一次账号 | 与 1.0.x 行为一致 |
| R9 | 请网关管理员查请求日志里的 UA 和客户端识别，看有没有被拦截或归错类 | 按 D5 的结论 |
| R10 | 在 Main 进程里运行 `key-canary-scan`：它自己读出真实 key，只输出「命中 / 未命中」，扫描范围同 IT-06 | 全部未命中 |

**证据**：写到 `evidence/p1-5-real-gateway-<日期>.md`，包括：
- 逐模型的表格：模型 id、协议、R2 结果、错误码、首 token 延迟；
- 档位矩阵；UA 的观察结果；扫描结论。

不写任何 key，不贴原始请求头。
