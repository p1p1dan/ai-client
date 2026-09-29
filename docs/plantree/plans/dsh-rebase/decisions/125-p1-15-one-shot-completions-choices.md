# 决策 125：P1-15 一次性补全换引擎的实现取舍

日期：2026-09-29。**状态：自主决定，待用户审批。**

依据：
- 已批准的决策：[039](039-one-shot-completions-via-host-llm.md)（补全经宿主 `ctx.llm.stream` 直调）、[033](033-model-plan-via-configure-overlay.md)～[035](035-keep-our-model-ids.md)（模型计划、按请求拉 key、保留我方模型 id）、[036](036-filter-unsupported-protocols.md)、[038](038-no-plaintext-key-scope.md)、[040](040-default-effort-and-settings-mapping.md)（补全里 `off` 与没选都不发档位）、[020](020-host-fault-handling-and-budgets.md)、[025](025-host-lifecycle.md)、[090](090-user-rulings-2026-09-28.md)（默认跟随 DSH）、[110](110-user-rulings-2026-09-28-batch2.md)；
- 方案：[P1-5 方案](../topics/p1-5-models-and-credentials.md) §4.5、§5 D7；[分片 04](../topics/p1-5-models-and-credentials/04-one-shot-completions.md)；roadmap P1-15 行。

改动留在工作区，由编排者复跑后提交。**第 1、10、11、13、16 条请重点审批。**

## 规则

### 一、协议：一种新的宿主控制消息

1. **补全走宿主控制消息 `complete`，不走决策 039 写的「通道上的 `utility.*` RPC」**（修订决策 039 第 1、2 条的实现形式，见文末修订注记）。
   - Main → 宿主：`{host:'complete', id, purpose, prompt, model?, effort?, timeoutMs, stream?}`；`{host:'complete-cancel', id}`。
   - 宿主 → Main：`{host:'completion-delta', id, text}`（只在 `stream: true` 时发）；`{host:'completed', id, ok, text?, model?, error?:{code, message, dshCode?}, ms}`，每个请求恰好一条。
   - 理由：通道要为每次补全在宿主里建一个 `PiWorkerRpcServer` 和运行时，还要开放 `utility.start` 建通道（决策 019 规定只有 `worker.bootstrap` 能建）；补全没有会话，用不上这些。控制消息与 `readPage`、`seedSession` 同一个形状，取消、超时、宿主退出的处理都现成。`DSH_CHANNEL_OPENING_METHODS` 因此维持只有 `worker.bootstrap`。
2. **`purpose` 只有三种**：`commit-message`、`branch-name`、`code-review`。它只用于协议校验和诊断，不改变宿主的行为，也不传给 DSH：DSH 的 `GenerateOptions.purpose` 只认 `compaction`、`session-title`，传我们自己的词进去会被当成 DSH 的语义。
3. **协议守卫**：`prompt` 非空；`model`、`effort` 若有须为非空字符串；`timeoutMs` 为正整数且不超过 2147483647（再大 `setTimeout` 会立刻触发，Main 和宿主都会提前放弃）。`effort` 只查形状：档位词表只在宿主的路由里读一次（`resolveRoute` 调 `isSessionEffortLevel`），协议模块不复制这份词表（它按约定不做值导入）。
4. **错误码**：
   - 协议自己的五个：`completion_request_invalid`（字段不对）、`completion_unavailable`（宿主没有 LLM 服务、bridge 正在关）、`completion_cancelled`、`completion_timeout`（宿主那一侧的期限到了）、`completion_failed`（DSH 的失败码表里没有的码、流没有 `finish` 就结束、适配器抛错）；
   - 模型调用失败时，按 `src/shared/dshFailureCodes.ts` 映射成会话用的同一套码（`CREDENTIALS_UNAVAILABLE`、`PROVIDER_UNAUTHORIZED`、`PROVIDER_RATE_LIMITED`、`CONTEXT_TOO_LARGE`、`MODEL_NOT_CONFIGURED`、`TIMEOUT`、`NETWORK_ERROR`、`PROVIDER_ERROR`），DSH 原来的码放在 `dshCode`；
   - 计划里没有这个模型：`MODEL_NOT_CONFIGURED`，在发请求之前就答复。
   - 带可用 id、但字段不对的请求答 `completion_request_invalid`，不丢弃（Main 在等它）；没有可用 id 的只记一条诊断。

### 二、宿主：`ctx.llm.stream` 直调

5. **bridge 的 `inject` 加 `llm`**（照决策 039），新模块 `src/dsh-host/bridge/completions.ts`（`DshCompletions`）负责补全，多路器（`channelMux.ts`）只转交，不排队：补全不持锁、不写盘，可以与会话并行。
6. **请求的形状**：
   - `provider`、`model`、`reasoningEffort` 来自路由（第 10、11 条）；
   - `system` 是原生补全的系统提示词，逐字照抄（`You are a tool-free completion service. …`），常量放在宿主的 `completions.ts`；
   - `messages` 只有一条用户消息，就是 Main 拼好的提示词（含 git diff），与 1.0.x 相同；
   - 不带 `tools`、`sessionId`、`maxTokens`、`temperature`：输出上限由适配器按模型给默认值，与会话一样。
   - 不开会话、不写会话日志、不起 agent。DSH 的直调只试一次，路由上的重试策略只作用于 agent 回合，所以补全**不重试**，与 1.0.x 原生补全一致（原生补全也不走会话的重试链）。路由上的其他设置（缓存、空闲超时）照样生效，因为它们属于适配器。
   - key 与会话同一条路：`llm-pi-ai` 每次请求经 `aiclient-credentials` 向 Main 拉（决策 034），服务商错误文本里的 key 照样被 `aiclient-credentials` 脱敏。
7. **取消与期限**：
   - 收到 `complete-cancel` 或宿主一侧的期限到了，**先答复、再 abort**：答复不等服务商响应中止信号，之后流里再来的东西一律丢弃。宿主一侧的期限就是请求里的 `timeoutMs`，只在 Main 的取消丢了的时候兜底；
   - DSH 以 `aborted` 结束一个我们没取消的请求时，答 `completion_cancelled`。
8. **其余细节**：
   - `stop`、`max-tokens` 以及 DSH 以后新增的、不带失败的 `finish` 都算成功，文本照交（`max-tokens` 时文本可能被截断，原生补全也是这样）；
   - 只取 `text-delta`，思考内容（`reasoning-delta`）不交给 Main：1.0.x 的补全只收正文；
   - 同一个 id 已在跑时，第二个请求记日志后丢弃，不答复：答复会把正在跑的那个结掉；
   - 宿主不设补全并发上限，Main 的容量 2 就是闸门；
   - bridge 行被释放时，在跑的补全全部中止，各答 `completion_unavailable`。

### 三、模型选择（按 P1-5 的模型计划与原生补全的规则）

9. 设置页三个功能各自存的模型仍是我方的 `provider/modelId`（决策 035），菜单就是按计划过滤过的模型菜单（决策 033、036）。宿主用 `resolveRoute(plan, model, effort, 'completion')` 翻成 DSH 的路由与模型。
10. **模型**：
    - 选了模型：按计划翻译；计划里没有（被删掉、协议不受支持、没有 key）→ `MODEL_NOT_CONFIGURED`，**不退回默认模型**。原生补全这时报 `WORKER_MODEL_NOT_FOUND`，同样失败；
    - 「自动」（不带模型）：计划的默认模型，即计划索引里的第一个模型。原生补全取目录里第一个有 key 的模型；计划本来就丢掉没有 key 的模型（决策 033），两者选到的是同一个。
11. **档位**（决策 040 第 2 条的补全规则）：
    - 选了、且模型支持：照发；
    - `off`、没选（设置页的「自动」存的是 `default`，不在词表里，按没选处理）：都不发；
    - 选了但模型不支持：丢掉不发，记一条日志，不让补全失败。
    - **与 1.0.x 的差别**：1.0.x 原生补全在没选档位时，会退回 `<agentDir>/settings.json` 里的 `modelThinkingLevels` / `defaultThinkingLevel`。DSH 分支不再读这个文件，按决策 040、090 一律不发。原生补全遇到模型不支持的档位会照发、由 pi-ai 截取，这里改为不发。

### 四、Main：新服务 `DshCompletionService`

12. **新建 `src/main/services/agent-host/DshCompletionService.ts`，而不是只给 `PiUtilityService` 换 transport**（修订决策 039 第 2 条的「只换 transport」）。
    - 理由：`PiUtilityService` 的骨架是「每次操作一个 `WorkerSlot`、`utility.start` / `utility.cancel` RPC 加 3 s 回执」，没有一处能留给宿主控制消息用；硬塞进去等于重写整个类，还会让它继续引用 `forkPiWorkerProcess`、`resolveNativeModelCatalog`，静态守卫就证明不了「不再拉 native worker」。
    - 保留的契约：容量 2，第三个立即拒绝；期限由 Main 的计时器决定；按 operationId 取消（代码评审的「停止」）；登出 `invalidateAll` 取消在飞的全部、服务仍可用；退出 `disposeAll` / `forceKillAllNow`。
    - 改变的一处：取消与超时**立即**结掉调用，不再等 worker 最多 3 s 的回执。原来等回执是为了之后能释放 worker 进程；宿主是共享的，没有可释放的，宿主那一侧的答复到了也只会被丢弃。
    - 错误码改名为 `COMPLETION_CAPACITY_EXCEEDED`、`COMPLETION_CANCELLED`、`COMPLETION_FAILED`、`COMPLETION_TIMEOUT`、`COMPLETION_UNAVAILABLE`（引擎起不来、宿主退出、应用正在退出）。三个入口只用错误的 `message`，没有地方比较旧码。
13. **`DshHostSupervisor.startCompletion`**：
    - 没有宿主时按需拉起，**`failed` 状态下也拉**（按 `userInitiated`）：补全是用户点按钮触发的，与新建、恢复会话同级；
    - 在飞的补全（含等宿主启动的那段）挡住空闲停机，`status().completions` 报数量；
    - 不设自己的超时，期限归调用方；宿主退出时在飞的补全以 `DSH_HOST_COMPLETION_INTERRUPTED` 失败；答复不合协议时以 `DSH_HOST_COMPLETION_MALFORMED` 立即失败；取消后以 `DSH_HOST_COMPLETION_CANCELLED` 结掉，已发出去的才向宿主发 `complete-cancel`。
14. **计划或插件变了要重启宿主时，等补全做完**：`WorkerManager.hasWorkInFlight` 把 `status().completions > 0` 算作「有活在做」。代码评审可以跑 10 分钟，重启会把它切断。登出不受影响：登出直接 `workerManager.invalidateAll()`，宿主照样关，在飞的补全随之失败。
15. **三个入口**（`commit-message.ts`、`branch-name.ts`、`code-review.ts`）：
    - 提示词、git 读取（仍由 Main 派生 git，决策 039 第 3 条）、代码块围栏的剥离、分支名 120 s 与评审 10 min 的期限都不变；
    - 请求不再带 `cwd`：宿主不读任何文件，提示词就是模型看到的全部；
    - 各带一个可选的 `service` 参数，默认是应用的单例。只有测试传它：集成测试要把三个入口接到自己的 supervisor 上。
16. **错误怎么显示**（界面不改）：
    - 超时（Main 的期限或宿主的 `completion_timeout`）→ 消息就是 `timeout`，提交框和分支名对话框本来就把它显示成「生成超时」；
    - 取消 → `cancelled`（代码评审点了停止，面板已经收起，看不到）；
    - 其他失败 → `<码>: <宿主给的句子>`，比如 `CREDENTIALS_UNAVAILABLE: …`、`MODEL_NOT_CONFIGURED: Model … is not available (MODEL_NOT_IN_PLAN)`；
    - 引擎起不来或中途退出 → supervisor 的 `DSH_HOST_*: …`。
    - 1.0.x 这里显示的是服务商或 worker 的原文，也不翻译。把码翻成本地化的说明留作遗留。
    - 服务商那一侧的空闲超时（DSH 的 `TIMEOUT`）照失败处理，显示 `TIMEOUT: …`，不算「生成超时」：只有整次补全的期限才是。
17. **登出与退出**：`onboarding.ts` 的登出第 ③ 步改为 `dshCompletionService.invalidateAll()`；`ipc/workerManager.ts` 的退出清理改为 `dshCompletionService.disposeAll()` / `forceKillAllNow()`。至此 Main 的产品代码里没有任何地方引用 `PiUtilityService`。

### 五、留给 P1-12 删除的清单

18. P1-15 之后，下面这些没有产品调用方，按 roadmap P1-12 的安排**留着不删**，删 runtime 时一起删：
    - `src/main/services/agent-host/PiUtilityService.ts` 及 `__tests__/PiUtilityService.test.ts`（测试仍然跑、仍然通过）；
    - `src/shared/types/workerRpc.ts` 的补全 RPC：`WorkerUtilityStartPayload`、`WorkerUtilityStartResult`、`WorkerUtilityCancelPayload`、`WorkerUtilityCancelResult`、`WorkerUtilityDeltaPayload`、`WorkerUtilityTerminalPayload`、四个 `WorkerUtility*Request/Event` 类型、`isWorkerUtility*` 八个守卫、方法表里的 `utility.start` / `utility.cancel`，以及只被它们用的 `WorkerModelCatalog`（`piWorkerRpcServer.ts` 也引用它，一起删），相应的测试；
    - `src/agent-host/piWorkerRpcServer.ts` 的 `utility.start` / `utility.cancel` 处理、`createUtilityRuntime` 选项、`PiUtilityRuntime(Options)` 类型、`emitUtilityEvent`；`src/agent-host/worker.ts` 的 `createUtilityRuntime`；
    - `src/dsh-host/bridge/channelMux.ts` 里 `createUtilityRuntime: () => throw unsupported('One-shot completion')` 这个桩（`PiWorkerRpcServer` 去掉这个选项时一起去掉），以及 `dshSessionRuntime.test.ts`、`permissionBridge.test.ts` 里同名的桩；
    - `src/runtime/worker/nativeUtility.ts` 与 `src/runtime/__tests__/nativeUtility.test.ts`；`src/agent-host/__tests__/nativeWorkerModuleLoads.test.ts` 的 `utility.start` 用例、`workerEntryWiring.test.ts` 的补全用例、`piWorkerRpcServer.test.ts` 的补全用例；
    - `forkPiWorkerProcess`（`PiWorkerProcess.ts`）的最后一个调用方随之消失（另一个 `PiImportProcess.ts` 已由决策 124 第 19 条列入）；`resolveCurrentPiWorkerEntryPath` 仍被权限策略与运行时检查使用，另行判断；
    - 删完后，`oneShotCompletionsStatic.test.ts` 里「除 `PiUtilityService.ts` 自身外无人引用」的豁免随文件一起去掉。
    - **不删**：`resolveNativeModelCatalog`（凭据代理 `readAuth` 与模型菜单还在用）、`WorkerSlot`（会话通道在用）。

### 六、测试

19. 单测与静态守卫：
    - `dshHostProtocol.test.ts`：四种新消息的守卫、三种 `purpose`、`timeoutMs` 上限、补全不建通道；
    - `completions.test.ts`（宿主，新）：请求的形状（系统提示词、只一条用户消息、没有工具与会话）、按计划路由（选了的档位照发，`off`、没选、词表外、模型不支持都不发）、计划外的模型、没有 LLM 服务、失败码映射与 `dshCode`、流抛错或没有 `finish`、取消立即答复并中止且丢弃后续、宿主一侧的期限、重复 id、释放；
    - `channelMux.test.ts`：转交、没有补全时与启动抛错时的答复、字段不对的请求有 id 就答、`utility.start` 仍建不了通道；
    - `hostStatic.test.ts`：bridge 注入 `llm` 并把补全交给多路器；`completions.ts` 不出现 `agents.create`、会话、工具、写文件、`utility.*`；
    - `DshHostSupervisor.test.ts`：按需拉起、请求字段、有监听才要增量、增量按 id 转交、取消的两种时机、宿主退出、答复不合协议、启动失败、从 `failed` 拉起、挡住空闲停机；
    - `DshCompletionService.test.ts`（新）：容量、期限（并通知宿主、晚到的答复被忽略）、按 id 取消、登出、退出、错误消息的格式、期限的上限；
    - `WorkerManager.test.ts`（WM-plan-04）：计划变了而宿主上有补全在飞时，等补全做完再重启；
    - 三个入口：`commit-message.test.ts`、`code-review.test.ts`（新）与 `branch-name.test.ts`（改）：请求字段与用途、提示词不变、围栏剥离、超时显示为 `timeout`、失败原样交给界面、评审的增量与停止；
    - `oneShotCompletionsStatic.test.ts`（新）：三个入口经 `DshCompletionService`、不出现 `PiUtilityService`；`src/main` 的产品代码除它自己外无人引用 `PiUtilityService`；服务不起进程、不带目录与 key；登出与退出走新服务；supervisor 的补全是控制消息、不开通道；
    - 旧的静态测试穷举过：`chatEngineDshOnly.test.ts` 与 `nativeCatalog.test.ts`（T062-D3）原来钉的是 `PiUtilityService` 读目录，改为钉新服务不带目录、凭据代理读同一个目录。
20. 真宿主与假网关：
    - 假网关加四个标记：`P1-COMPLETE-COMMIT`（带围栏的提交信息）、`P1-COMPLETE-BRANCH`（带 `text` 围栏的分支名）、`P1-COMPLETE-REVIEW`（6 段、间隔 100 ms 的评审）、`P1-COMPLETE-SLOW`（60 段、间隔 250 ms，用来取消和超时）；每行日志多记一个 `completionSystem`：请求带没带补全的系统提示词；
    - 集成测试新增一个阶段（自己的 supervisor、临时 git 仓库）：经三个真入口各生成一次，确认三次请求都带补全的系统提示词、不带工具、不带档位、按请求拉 key，没有写任何会话，除了宿主和 git 没有起任何进程；评审中途停止 2 s 内结束、之后不再有增量；提交信息超时显示 `timeout`，宿主照常答下一个；计划外的模型和登出状态分别报 `MODEL_NOT_CONFIGURED`、`CREDENTIALS_UNAVAILABLE`，都没有请求到达网关；
    - bridge-smoke 的 A 主机加四项：评审分段到达且拼起来等于答复、提交信息不分段、取消立即答复（实测 0.4 ms）、不合协议的请求被拒、没有写会话。

## 取舍

- **控制消息还是通道 RPC**：通道能原样复用 `PiWorkerRpcServer` 的 `utility.*` 处理，但每次补全要在宿主里建一套服务端和运行时，还要改「只有 bootstrap 建通道」的规则；而那套处理的一半（回执、worker 生命周期）在共享宿主上没有意义。控制消息多写了四个消息类型，换来宿主里一个无状态的小模块。
- **新服务还是改旧服务**：改旧服务能少一个文件，但 P1-12 之前它会同时含两套 transport，静态守卫也无从下手；新服务让「三个入口不再引用 `PiUtilityService`」可以机械地证明。
- **没选档位时要不要继续读 `<agentDir>/settings.json`**：读了就与 1.0.x 一致，但 DSH 分支别处都不再读这个文件，而且决策 040、090 已定「补全不发、跟随 DSH」。
- **补全要不要挡住计划变更的重启**：不挡的话，登录后的目录同步可能在评审中途把宿主重启掉；挡的代价是重启最多推迟到评审结束（最长 10 分钟），这期间新开的会话仍用旧计划。

## 影响

- **用户看得见的不同**：
  - 第一次生成时如果没有会话开着，要先拉起宿主（开发机上三次补全连同拉起宿主，两次实测分别约 1.5 s、5.2 s）；
  - 设置页选了档位、但模型不支持时，不再报错也不发（原来由 pi-ai 截取）；没选档位时不再沿用 TUI 设置里的思考档位；
  - 错误提示的写法变了：`CREDENTIALS_UNAVAILABLE: …` 这类「码 + 英文句子」，超时仍是「生成超时」。
- **加密机**：不变。git 仍由 Main 派生，宿主不读文件（决策 039 第 3 条）。
- **key**：补全不再把含 key 的目录交给任何进程；决策 038 第 3 条「`auth.json` 等 P1-15 落地后再停写」的这个前提已经满足，只剩 P1-11（见决策 038 的补记）。

## 遗留

- **错误提示的本地化**：界面对补全的错误只认 `timeout`，其余显示英文原文。要翻成与会话失败卡片一致的说明，得在渲染层按码查表（可复用 `sessionFailure.ts` 的文案），留给 P1-7 的收尾或单独的小任务。
- **真实网关**：方案 §7.3 的 R7（三种补全、中途停止）仍要用户授权后做。
- **补全不进 pong**：宿主的 `pong` 只报通道忙不忙，不报在飞的补全；Main 这边由 `status().completions` 自己计数，够用。
- **提示词的大小**：代码评审的 diff 不设上限，经 IPC 整段发给宿主，与 1.0.x 发给 worker 相同。

## 对既有决策的修订注记

- [决策 039](039-one-shot-completions-via-host-llm.md)：第 1 条「用 `ctx.llm.stream` 实现现有的 `utility.*` RPC」改为宿主控制消息 `complete`（本决策第 1 条）；第 2 条「`PiUtilityService` 只换 transport」改为新服务 `DshCompletionService`，`PiUtilityService` 留到 P1-12 删（第 12、18 条）。「不开会话、没有工具、不落盘」「`inject` 加 `llm`」「git diff 仍由 Main 取」不变。
- [决策 038](038-no-plaintext-key-scope.md) 第 3 条：P1-15 已落地，`auth.json` 停写只等 P1-11。
