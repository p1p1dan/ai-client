# S-1 引擎选择、开关与网关来源（设计）

Role: topic（S-1 方案，2026-10-16）。上位：[README](../README.md) §4 S-1、§7.4。用户 2026-10-16 确认：§7.4 的 #1、#4、#18 并入 S-1，errorCode 映射在 S-1 先做，其余按 §7.4 去向。

> **同日变更**：S-1 提交后用户又做了裁决：只看协议选引擎（Anthropic 协议的模型都走 SDK，不再限 Claude 系列），SDK 宿主起不来时退回 DSH，界面统称"Agent SDK 引擎"。见 §5。下文中与之冲突的表述（"Claude 模型""Claude 系列"等），以 §5 为准。

## 0 范围

| 项 | 来源 | 本任务做什么 |
|---|---|---|
| 引擎选择 | S-1 | 新会话按模型选引擎；重开按会话桩固定引擎 |
| 开关 | S-1 | 设置开关，默认开；关掉后 Claude 新会话走 DSH |
| 网关与 key 来源 | #4 | 取自 DSH 同一份模型计划与凭据，不再读 Main 的环境变量 |
| 钉住环境变量 | #1 | 网关地址等写进 SDK 的 flag 层 `settings.env`，仓库改不走 |
| 跨引擎换模型 | #18 | SDK 会话只能换同一条路由上的 Claude 模型；界面与 Main 两头拦 |
| errorCode 映射 | #5 一部分 | SDK 失败映射到渲染层已有的卡；引擎进程退出加一张卡 |
| 跨引擎故障 | #7 两条 | DSH 宿主重启不碰 SDK 会话；有后台任务或 CLI 自起回合的 SDK 会话不被回收 |
| 新接缝单测 | #10 | 选择、网关、拒绝、故障路径都有单测；重写 `chatEngineDshOnly.test.ts` |

不做：#5 其余（重试次数、超时对齐，S-5）；key 进子进程环境（#2，S-2/S-3）；SDK 的失败重试（Continue 在 SDK 会话里仍回 `retry_unavailable`，输入框收回原文，S-5 以后）；打包（S-4）。

## 1 决定

1. **选引擎（新会话）**：三条都满足才走 SDK：
   - 开关开（`claudeSdkEngineEnabled`，缺省为开）；
   - 模型在计划里，路由协议是 `anthropic-messages`（**只看协议**，用户 2026-10-16 裁决，见 §5；初版还要求是 Claude 系列，已去掉）；
   - SDK 宿主可启动（宿主入口文件存在）。S-4 之前打出的安装包里没有宿主，Claude 会话退回 DSH 并记一行日志，不报错。
   - "自动"（不带模型）先按计划默认模型（第一个索引项）解析，再判断；走 SDK 时把解析出的模型显式交给宿主。
   - 计划不可用（未登录、钥匙串锁着）时走 DSH，沿用 DSH 现有的失败路径。
2. **重开**：按会话桩后缀 `.ccsdk.json` 固定为 SDK，与开关无关。宿主启动用的模型依次取：本次请求带的模型（SDK 可服务时）→ 会话桩记录的模型 → 计划里第一个 SDK 可服务的模型；都没有就报 `claude_sdk_credentials_unavailable`。
3. **网关与 key**：Main 用"上一次已构建的计划"查路由（`claudeSdkRouteFor`），不调 `resolveDshModelPlan()`（它会广播、可能触发 DSH 重启）；还没有计划时才构建一次。key 用 `DshCredentialBroker` 的同一份内存目录按 providerId 取。仍经启动环境变量交给宿主进程（只在内存里，不落盘），宿主读出后删掉自己的副本。删除 `AICLIENT_CLAUDE_SDK_ENGINE`、`AICLIENT_CLAUDE_SDK_BASE_URL`、`AICLIENT_CLAUDE_SDK_API_KEY` 三个 Main 侧环境变量入口。
4. **换 key**：每次计划构建（`onDshModelPlanBuilt`）时，Main 比对每个 SDK 会话启动时的网关指纹（路由、baseURL、key 的哈希）。变了且会话空闲，就回收它（`released`）；下次发送走现有的 `session_not_found` 恢复路径重开，拿到新 key。忙的下次再比。
5. **同路由**：SDK 会话启动后绑定一条路由（`entry.sdkRoute`）。中途换模型只允许同一路由上的 Claude 模型：渲染层的模型列表只列 `sdkRoute` 相同的项；Main 的 `startTurn` 对其他模型抛 `model_engine_mismatch`，渲染层把原文还给输入框并说明原因。DSH 会话不限制（与现在相同）。
6. **钉住环境变量**：宿主把 `ANTHROPIC_BASE_URL`、`DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、找到时的 `CLAUDE_CODE_GIT_BASH_PATH` 写进 `settings.env`（flag 层，高于项目设置）。**key 不进 `settings`**：SDK 会把它序列化到 CLI 命令行。代理、TLS、`ANTHROPIC_AUTH_TOKEN` 等其余变量能否钉、怎么钉，由宿主线实测后定，结论写进 §4。
7. **errorCode**：宿主用一个纯函数把 SDK 的失败映射到渲染层已有的码：

   | SDK 信号 | 码 |
   |---|---|
   | 先过 `classifyDshFailureText`（公司网关的流门禁、无上游、模型设置） | 原样 |
   | `authentication_failed` 等鉴权类、HTTP 401/403 | `PROVIDER_UNAUTHORIZED` |
   | `rate_limit`、`billing_error`、HTTP 429 | `PROVIDER_RATE_LIMITED` |
   | `model_not_found`、HTTP 404 | `MODEL_NOT_CONFIGURED`（渲染层别名为 `model_missing`） |
   | `terminal_reason: prompt_too_long`、HTTP 413 | `CONTEXT_TOO_LARGE` |
   | 首字节或空闲超时、HTTP 408/504 | `TIMEOUT` |
   | 无 HTTP 响应的连接错误 | `NETWORK_ERROR` |
   | `overloaded`、`server_error`、其他 4xx/5xx | `PROVIDER_ERROR` |
   | CLI 在回合中途退出；Main 看到宿主进程崩溃 | `claude_engine_exited`（新卡） |
   | 其余 | 不带码（`unknown`） |

   失败卡的说明文字不再原样用 CLI 的提示（如 "Fix external API key"），换成 `上游请求失败（HTTP 401）` 一类中性句；CLI 原文进宿主日志。任何发给界面的文字都不出现 "Claude Code"（§2 第 4 条）。
8. **跨引擎故障**：`closeBusyChannelsBeforeRestart` 跳过 SDK 会话；强制接管重开一个 SDK 会话不重启 DSH 宿主；`isSafeToEvict` 对 SDK 会话还要求 `workerTurn` 为空、`backgroundTasks` 为 0。宿主按 SDK 的 `background_tasks_changed`（没有就按 `task_started`/`task_notification` 计数）在 `session.status` 上报 `backgroundTasks`。
9. **渲染层知道引擎**：Main 在 `session.created`/`session.resumed` 的 payload 里带 `engine: 'claude-sdk'` 与 `engineRoute`；渲染层存到 `ChatSession` 上。不按 `runtimeIdentity` 的形状猜（那是不透明字段）。
10. **开关的位置与文案**：模型页，放在其他模型请求设置旁边。标题"Claude 模型引擎"，开关"Claude 模型使用官方 Agent SDK"，说明"开启后，新建的 Claude 对话由官方 Claude Agent SDK 驱动；关闭则与其他模型一样由内置引擎驱动。只影响新对话，已有对话保持创建时的引擎。"不出现 "Claude Code"。

## 2 契约（已在本任务开头提交）

- `src/shared/claudeSdkEngine.ts`：`ChatEngine`、`CLAUDE_SDK_STUB_SUFFIX`、开关键 `CLAUDE_SDK_ENGINE_SETTING_KEY` / `DEFAULT_CLAUDE_SDK_ENGINE_ENABLED` / `resolveClaudeSdkEngineEnabled`、`isClaudeFamilyModelId`、`claudeSdkRouteFor(plan, ref)`、`effectiveModelRef(plan, ref)`、码 `MODEL_ENGINE_MISMATCH`（`model_engine_mismatch`）与 `CLAUDE_ENGINE_EXITED`（`claude_engine_exited`）。
- `SessionCreatedEvent.payload`：`engine?: 'claude-sdk'`、`engineRoute?: string`。
- `SessionStatusEvent.payload`：`backgroundTasks?: number`。
- `AgentModelOption`：`sdkRoute?: string`（Main 在 `applyDshPlanToCatalog` 里按 `claudeSdkRouteFor` 填）。
- Main 的 `WorkerManagerError` 新码：`model_engine_mismatch`（发送时）、`claude_sdk_credentials_unavailable`（建会话或重开时拿不到路由或 key）、`claude_sdk_host_unavailable`（宿主起不来）。经 `chat.ts` 的 `withWorkerErrorCode` 以 `<code>: <message>` 到达渲染层，建会话的 IPC 也要走这条。
- 会话桩：宿主在桩里记 `model`（我们的 `provider/modelId`，建会话时写，换模型成功后更新）；Main 重开时读它。
- 宿主启动环境变量名不变（`AICLIENT_CLAUDE_SDK_BASE_URL`、`AICLIENT_CLAUDE_SDK_API_KEY` 等），只是值改由 Main 从计划与凭据取。

## 3 验证（先定断言，再改代码）

**单测**：
- 共享：`claudeSdkRouteFor`（anthropic + claude 得路由；anthropic + glm、openai + claude 命名、不在计划、refs 缺失都得 null）、`effectiveModelRef`、`resolveClaudeSdkEngineEnabled`。
- Main：选引擎（开关关→dsh；宿主不可用→dsh；anthropic 上的 claude→sdk；"自动"跟随默认模型）；网关解析（缺 key→`claude_sdk_credentials_unavailable`）；`WorkerManager` 的 SDK 路径（建会话走注入的选择器，`session.created` 带 engine 与 route；换到别的路由的模型在 `worker.send` 之前被拒；DSH 宿主重启不给忙的 SDK 会话发 dispose；有 `workerTurn` 或 `backgroundTasks` 的 SDK 会话不被回收；SDK 宿主崩溃带 `claude_engine_exited`；网关指纹变了的空闲 SDK 会话被回收）；`chatEngineDshOnly.test.ts` 按两引擎重写。
- 宿主：失败映射表；`settings.env` 的内容（且不含 key）；会话桩记录模型。
- 渲染层：开关区块渲染与切换；菜单打 `sdkRoute`；SDK 会话的模型列表过滤；`model_engine_mismatch` 的拒绝处理；新卡与新错误码都有中文（`i18nCoverage`、`sessionFailure` 测试）。

**探针**（`host-probe.ts` 对假网关，全部断言化）：
- `errors`：假网关的 `CC-ERR` 标记按状态码回错（带 `x-should-retry: false`），断言 401/429/404/500 各自的 `errorCode`，且失败文字不含 "Claude Code"。
- `repoenv`：工作区 `.claude/settings.json` 把 `ANTHROPIC_BASE_URL` 指向一个死端口，回合照常完成（请求仍到配置的网关）。
- `agent`：子代理运行时 `backgroundTasks > 0`，完成后回到 0。
- 原有 10 个场景、续聊、矩阵空跑照旧全过。

**GUI 点验**（`gui-probe.mjs`，隔离 profile，两个假网关：一个 anthropic-messages 服务带 Claude 模型，一个 openai-completions 服务带 GLM 模型）：
1. 设置页模型页有开关，默认开；
2. Claude 模型开新会话→走 SDK（网关日志 UA 为 `claude-cli/…`），GLM 开新会话→走 DSH（UA 为 `claude-cli-pilab/…`）；
3. 关掉开关，Claude 再开新会话→走 DSH；
4. SDK 会话的模型列表只有同一路由上的 Claude 模型；
5. 重启应用，两种会话都能重开续聊，且仍在原引擎上。

## 4 实现分工与记录

三条线并行，各自只改自己的文件，契约以 §2 为准：

| 线 | 文件 | 内容 |
|---|---|---|
| 宿主 | `src/claude-sdk-host/**`、`fake-gateway.mjs` 的 claude-sdk 段 | 决定 6、7、8 的宿主半边；会话桩记模型；探针 `errors`、`repoenv` 与 `backgroundTasks` 断言 |
| Main | `src/main/**`、`src/shared/dshModelPlan/menu.ts` | 决定 1～5、8、9 的 Main 半边；开关读取；单测；重写 `chatEngineDshOnly` |
| 渲染层 | `src/renderer/**`、`src/shared/i18n.ts` | 开关区块；`ChatSession.engine`；模型列表过滤；拒绝处理；新卡；建会话与重开的错误文案 |

### 4.1 钉住环境变量：逐项实测（宿主线，2026-10-16）

做法：工作区放 `.claude/settings.json` 写入 `env`，对假网关逐项比较"不钉"与"钉"两种情况（另设 `CLAUDE_CODE_MAX_RETRIES=0`，让失败立即可见）。SDK 会把 `settings` 以 `--settings "{…}"` 的形式写进 `claude.exe` 的命令行，所以钉住的值不能含任何凭据。

| 变量 | 仓库能做什么（实测） | 钉成 |
|---|---|---|
| `ANTHROPIC_BASE_URL` | 改走请求，连同 key | 配置的网关 |
| `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`（大小写两种） | 任一指向死端口，发往 `http://127.0.0.1` 网关的请求也会走代理（CLI 不豁免本机；`HTTPS_PROXY` 对 http 网关也生效） | 宿主继承到的值，没有就 `''`（`''` 等于未设）；URL 带用户名密码的不钉，只记变量名 |
| `NO_PROXY`（大小写两种） | 仓库改掉后，网关请求被迫走代理 | 宿主继承到的值或 `''` |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `'0'` 关掉证书校验（自签名 HTTPS 前置实测） | `'1'` |
| `NODE_EXTRA_CA_CERTS` | 加入仓库自带的信任根 | 宿主继承到的值，没有就 `''`：私有 CA 的网关照样能用（S-1 审查实测：钉成 `''` 时这类网关必然失败，而 DSH 能用），仓库也换不掉信任根。它与 `NODE_USE_SYSTEM_CA` 一起进了 Main 与宿主共用的继承名单 `CLAUDE_SDK_INHERITED_ENV` |
| `ANTHROPIC_AUTH_TOKEN` | 额外带上 `Authorization: Bearer` | `''` |
| `ANTHROPIC_CUSTOM_HEADERS` | 额外带上仓库指定的请求头 | `''` |
| `CLAUDE_CODE_USE_BEDROCK`、`_VERTEX`、`_FOUNDRY`、`_ANTHROPIC_AWS`、`_MANTLE`、`_ANTHROPIC_GOOGLE_CLOUD` | 配合各自的地址与跳过鉴权变量，把对话发到仓库指定的端点（网关收到 0 个请求） | `'0'` |
| `CLAUDE_CODE_USE_GATEWAY` | 实测只多带一个 bearer 头 | `'0'`（保险） |
| `DISABLE_AUTOUPDATER`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、找到时的 `CLAUDE_CODE_GIT_BASH_PATH` | 假网关上观察不到，只有单测 | `'1'`、`'1'`、宿主找到的路径 |
| `CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_API_BASE_URL`、`ANTHROPIC_UNIX_SOCKET`、OTEL 一组 | 从项目设置改不动（实测） | 不钉 |
| `ANTHROPIC_API_KEY` | 仓库可以换成自己的 key（请求仍发往我们的网关） | **钉不了**：钉就要把 key 写进命令行。并入 §7.4 #2，S-2/S-3 一起定 |

`applyFlagSettings` 只经一个包装函数调用，类型与运行时都拒绝 `env`，避免浅合并把钉住的整组换掉。

### 4.2 各线偏离本稿之处

- **Main**：
  - 宿主可用还要求 `src/claude-sdk-host/node_modules` 里有 SDK 包；没 `npm ci` 的检出退回 DSH。
  - SDK 会话发送时带着当前模型，即使计划暂时不可用也放行。
  - SDK 会话崩溃后重启时重新解析启动参数并重新取 key；重开时索引记录实际启动的模型。
  - **DSH 宿主因计划或插件变化重启时，只释放 DSH 会话**（原型里会连带释放 SDK 会话）；`hasWorkInFlight` 不再计 SDK 的回合。登录、登出、改服务等全量重置仍释放全部会话。
  - 换 key 时打开着的 SDK 会话也会释放（渲染层对 `released` 的处理与全量重置相同，下次发送自动重开）。
- **宿主**：
  - 失败文字为"`Upstream request failed (HTTP n)`"，网关自己给了说明时接在后面（脱敏、去掉含 Claude Code 的句子、截 300 字）。
  - SDK 抛出的"进程退出"也映射为 `claude_engine_exited`（真实 CLI 被杀时就是这条路）。
  - 每条 `session.status` 都带当前的 `backgroundTasks`。
  - 会话桩的 `model` 还在 CLI 初始化、发现重开用了别的模型时更新。
  - 换模型改为 `setModel` 成功后才记新模型（顺带修了 §7.4 #19 的一半）。
  - 假网关的 CC 标记改取消息里最后一个：CLI 会把失败的提问与下一条合并重发。另加 `CC-ENV` 标记，供 `repoenv` 场景检查。
- **渲染层**：
  - 新增历史卡 `credentials_unavailable`。
  - 宿主起不来时，状态行用 Claude 引擎专用的一句，不沿用 DSH 共享引擎的文案。
  - 被拒的 Continue 用提示条说明原因，失败卡保留。
  - 开关区块按集成时的 GUI 点验改为与相邻开关一致的两栏行布局（行标签"使用 Agent SDK"，开关的无障碍名称为整句）。

### 4.3 验证结果（2026-10-16，含审查后的修复）

- tsc 三套通过；biome 通过。
- 单测：SDK 宿主 61 个；Main 的 `WorkerManagerClaudeSdk.test.ts` 23 个、`claudeSdkEngine.test.ts` 20 个；共享契约 8 个；渲染层新增挂载测试覆盖开关、模型列表、被拒的发送与 Continue、建会话失败。审查后修的 6 处，每处都补了测试，并确认去掉修复时测试会失败（README §8.1）。
- 全量 vitest：失败文件与 S-0 记录的本机环境基线逐个相同，稳定文件的失败条数也相同；git 类超时每次不同。无新增。
- 探针（假网关）：流程 34 条连跑两遍、`errors` 27 条（含"网关点名 Claude Code 并回显 key"的回合与宿主 stderr 断言）、`repoenv` 4 条、矩阵空跑 8 条、续聊 9 → 12，全部通过。
- GUI 点验（隔离 profile，一个假网关同时扮演 Anthropic 服务与 openai-completions 服务）：§3 的 5 项全部通过；开关区块改为两栏行布局后另截图确认。截图只留在本机临时目录。

## 5 S-1 补充（2026-10-16 用户裁决）

S-1 提交后，用户对三处做了裁决（README §1 裁决 9～11）：

1. **只看协议选引擎**：去掉“Claude 系列”这一条，Anthropic 协议的模型都走 SDK 引擎。端点接不住 Agent SDK 请求而导致首轮失败，属于模型配置问题，不由引擎兜底，回合里的失败照常报错（README §5 已知限制）。
2. **只在宿主起不来时退回 DSH**：
   - 可用性检查加上 CLI 二进制：设了 `AICLIENT_CLAUDE_SDK_CLI` 时查它，否则查 SDK 的平台包（Linux 也认 musl 版）。缺了就在选引擎时直接走 DSH，不必等到第一轮才报“引擎退出”。
   - 新会话的 SDK 启动以 `claude_sdk_host_unavailable` 失败时，`createSession` 清掉失败的槽位（没退出的就强杀），把会话改成 DSH，换一个新的 generation，用原来的模型和 effort 再启动一次。
   - 宿主在 bootstrap 应答之前就退出时，这次失败归建会话（或重开）那一步处理：`handleLifecycle` 不再给尚未建好的会话发 `disconnected`、也不排自己的重启，退回 DSH 的会话不会带着崩溃状态。
   - 拿不到 key（`claude_sdk_credentials_unavailable`）**不退回**：DSH 用同一份凭据，一样会失败；而且会话会从此固定在 DSH，用户重新登录后也回不去。这种情况照旧在建会话时给出友好提示。
   - 重开一个已有的 SDK 会话时宿主起不来，**不退回**：它的历史在 CLI 的会话记录里，换不了引擎，照旧出“引擎没能启动”的卡。
3. **换模型**：维持“同一路由内可换”。跨路由或跨协议的换模型，以后用“把前文打包进新对话”的方式做（README §8.2 #29）。
4. **请求按 SDK 官方的来**：不转发路由请求头，User-Agent 用 CLI 自己的（README §8.2 #26）。

文案随之改为按协议的说法：设置区块标题“Agent SDK 引擎”，开关“Anthropic 协议的模型使用官方 Agent SDK”；界面上原来的“Claude 引擎”统一改为“Agent SDK 引擎”（引擎也会服务非 Claude 模型）。内部码（`claude_engine_exited` 等）不变。

补充同样做了审查（引擎选择与退回、文案与文档两个维度，各配对抗式复核）。上面第 2 条里宿主在 bootstrap 应答前退出的处理是审查查出来的，补了按真实事件顺序的测试，并确认去掉修复时测试会失败；凭据提示、README 的旧说法与错位的注释也随之改正。留到以后的记入 README §8.2：#8（spawn 之前的启动错误没映射）、#13（非 Claude 模型也被告知是 Claude Code）、#24（重开会话可能跨路由）、#30（SDK 会话的 `MODEL_SETTING_UNSUPPORTED` 专门提示）、#31（CLI 路径由 Main 统一决定）。

验证见本次提交说明；用户另提议给模型加“测试模型”按钮来记录 Agent SDK 兼容性（README §8.2 #30，待定）。
