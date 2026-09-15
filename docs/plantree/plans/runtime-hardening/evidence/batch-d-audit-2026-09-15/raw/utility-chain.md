# 批次 D 补审 — utility 通道的产品消费者（代码评审 / 分支名 / 提交信息）

- 区域：utility-chain
- 任务：T029（批评者缺口 2，`cross-and-critic.md:65` 的 `GAP [P6-2 的产品消费者]`）
- 节点判定对象：P6-2 的产品消费者面
- 基线 HEAD：`ebc82f16`
- 日期：2026-09-15
- 方式：只读。未跑构建、tsc、vitest、打包、Electron。

## 总评

P6-2 把一次性补全从旧引擎换到自有 runtime 这件事，**在引擎与传输这一段是干净的**：一次补全走一个独立进程、一个 `WorkerSlot`、一条 `utility.start` / `utility.cancel` / `utility.delta` / `utility.terminal` 的四消息协议，引擎侧不建会话、不写 trace、不注册任何工具、不接权限门。审计当时点名的两条（worker-runtime-02 显式 `effort='off'` 被目录档位覆盖、worker-runtime-09 utility 读派生明文目录）从调用方一侧复核，**后果确已消失**（均为「已修（T016）」，见下文「审计条目复核」）。

问题集中在**这条链的两头**：Main 侧给冷启动配了热请求的时钟，渲染层则几乎没有为这三个功能做任何输入约束、状态回写和错误翻译。换句话说，引擎换得很仔细，按钮那一端基本没人重新看过——`src/main/services/ai/` 四个模块与 `src/renderer/stores/codeReview.ts` 至今零测试，`AISettings.tsx` 的三项设置没有任何取值上界。

本次立 10 条发现：5 条 medium，5 条 low。没有 high——这条链不碰工作区、不碰权限、不写会话文件，最坏后果是「功能报错 / 报错文案难懂 / 已生成的内容看不见了」，够不到安全绕过或数据损坏。

## 优点

1. **爆炸半径被真正收窄了**。`NativeUtilityRuntime` 只调 `createRuntime({ host, traceDir: null, agentDir?, modelCatalog? })`（`src/runtime/worker/nativeUtility.ts:149-159`），没有 `tools` / `session` / `mcp` / `skills` / `subagents` / `permissions`。对照 `src/runtime/bootstrap.ts:134-192` 的选项语义，这意味着：不建会话文件、不落 trace、不注册任何工具、`toolChoice:'none'` 又把模型侧的工具调用也关掉。一次「生成提交信息」在设计上**不可能**碰到工作区，也不可能触发权限卡。
2. **进程隔离与回收是闭合的**。每次 `complete()` 现 fork 一个进程（`PiUtilityService.ts:160-166`），结算后无条件 `slot.dispose()`（`:386-391`）；退出路径三条都接上了——正常关闭 `cleanupWorkerManager` → `disposeAll()`、信号关闭 `cleanupWorkerManagerSync` → `forceKillAllNow()`（`src/main/ipc/workerManager.ts:7`、`:26`）、登出 `invalidateAll()`（`src/main/ipc/onboarding.ts:130-131`）。`invalidateAll` 不置 `disposed`、`disposeAll` 置位，两者的区别有注释写明（`PiUtilityService.ts:227-233`）并有用例钉住。
3. **会话工作器不可能被当成 utility 用，反之亦然**。`piWorkerRpcServer.ts:606-610` 与 `:458-462`、`:546-550` 三处互斥检查，配 `WORKER_UTILITY_SLOT_CONFLICT`。
4. **模型目录的内存交付这一跳是实的**，且「拿不到就回落读盘」写成了显式契约（`PiUtilityService.ts:59-68` 注释 + `:190` 每次现读 + `nativeCatalog.ts:37-81` 的三种 `undefined`），并各有一条用例（`PiUtilityService.test.ts:203`、`:232`）。
5. **`effort='off'` 的语义在四跳里都没被吃掉**：渲染层 `off` 是真值故不会被 `...(effort ? {} : {})` 的展开丢掉（`efforts.ts:118-125` 明确解释过这一点）、IPC `isSessionEffortLevel` 放行、`isWorkerUtilityStartPayload` 放行、引擎 `input.effort === 'off' → undefined` 且**不回落目录档位**（`nativeUtility.ts:109-113`）。

## 弱点

1. **冷启动没有自己的时钟**。会话路径为「冷启动不能用热预算」专门开了 `BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000` 并把踩过的坑写进注释；utility 路径整条冷启动（fork + 模块图加载 + Cordis bootstrap + 读 settings.json）压在 10 秒的热预算里。→ utility-01
2. **用户能配出一个协议层直接判非法的超时值**。设置页的超时输入框无上下界，> 600 秒即被 `isWorkerUtilityStartPayload` 判假。→ utility-02
3. **模型选择显示与实际发送会不一致**。同一个表单里，effort 字段做了「模型不支持就回写默认」的收敛，model 字段没有。→ utility-03
4. **错误文案是引擎内部串直通用户**。只有恰好等于 `'timeout'` 的那一种被翻译；`WORKER_MODEL_NOT_FOUND` 这个 chat 侧专门做过中文引导卡的错误码，在这三个功能里以原始形态出现。→ utility-04
5. **输出解析两处不对称**：提交信息过 `stripCodeFence`，分支名不过。→ utility-05
6. **超时会把已经流式渲染出来的评审正文顶掉**。→ utility-06
7. **两端超时没有余量**，与 `/compact` 明确写下的「先后顺序即契约」相反。→ utility-07
8. **整段产品消费者代码零测试**。→ utility-08

## 审计条目复核（只读核实「后果是否消失」）

- **worker-runtime-02（显式 `effort='off'` 被目录档位覆盖）— 已修（T016）**。从调用方一侧逐跳核实：`AISettings.tsx:70-105` 的 `EffortField` 只在模型的 `thinkingLevelMap` 显式声明 `off` 时才提供该项（`efforts.ts:166-176`），选中后存 `feature.effort='off'`；`CommitBox.tsx:52` → `git.ts:371`（`isSessionEffortLevel` 含 `off`）→ `commit-message.ts:112` → `PiUtilityService.ts:197` → `nativeUtility.ts:109-113`。四次展开语法 `...(effort ? {} : {})` 都不会丢掉 `'off'`（非空字符串为真值）。引擎最终既不下发 `reasoning`，也不去读 `settings.json` 的档位。**后果消失，无残留**。
- **worker-runtime-09（utility 读派生 `models.json` / `auth.json`）— 已修（T016）**。`PiUtilityService.ts:394-399` 在单例构造处注入 `resolveNativeModelCatalog`，`:188-200` 每次操作现读并随 `utility.start` 下发；`piWorkerRpcServer.ts:612-619` 把它转成 `PiUtilityRuntimeOptions.modelCatalog`；`worker.ts:114-126` 再转给 `NativeUtilityRuntime`；`nativeUtility.ts:157` 交给 `createRuntime`。**正常路径后果消失**。保留的读盘回落是显式取舍（托管模式凭据不可读 / 用户组读不出 → `nativeCatalog.ts:61`、`:64` 返回 `undefined` → 引擎回落 `agentDir`），T021 的落地记录已写明「locked 场景断言的是回落」，本次不另立发现。需要注意的是：**回落态下 utility 仍会读 `<agentDir>/auth.json`**，「utility 路径不读 models.json」这句只对能组装出目录的情况成立。
- **cutover-14 / cutover-21（P6-2 行 rationale 曾引用的两条）**：README 第五节已标为被推翻，本次不引用。
- **`agentDir` 的另一个消费者仍在**：`nativeUtility.ts:201-231` 的 `configuredEffort` 仍从 `<agentDir>/settings.json` 读 `defaultThinkingLevel` / `modelThinkingLevels`。全仓搜索确认**本应用自身从不写这两个键**（只有 `nativeUtility.ts` 在读），写它的是用户自己跑的 pi CLI / 内嵌 TUI（两者共用 `PI_CODING_AGENT_DIR`）。这不是缺陷——注释把它定位成「用户在 agent 目录钉的偏好」，回落链也正确（请求级 > 每模型 > 全局 > provider 默认）——但它意味着这条回落在纯 GUI 用户身上永远不生效。记入未经执行验证的声明，不立发现。

## 参数三跳取值表（axis a）

| 跳 | 文件:行 | model | effort | timeoutMs |
|---|---|---|---|---|
| 渲染层（提交信息） | `src/renderer/components/source-control/CommitBox.tsx:48-54` | `commitMessageGenerator.model`（`''` = 自动） | `commitMessageGenerator.effort` | `commitMessageGenerator.timeout`（**秒**，默认 120，无上界） |
| 渲染层（分支名） | `src/renderer/components/worktree/CreateWorktreeDialog.tsx:350-354` | 同上 | 同上 | 不传 |
| 渲染层（代码评审） | `src/renderer/stores/codeReview.ts:91-97` | `codeReview.model` | `codeReview.effort` | 不传 |
| IPC | `src/main/ipc/git.ts:367-375` / `:398-404` / `:509-515` | `...(options.model ? {} : {})` | `isSessionEffortLevel` 过滤 | 原样透传（仅提交信息有） |
| ai/*.ts | `commit-message.ts:108-114`、`branch-name.ts:20-26`、`code-review.ts:99-107` | 透传 | 透传 | `timeout * 1000`；分支名默认 `120*1000`；评审**硬编码 `10*60_000`** |
| PiUtilityService | `PiUtilityService.ts:192-200` | 透传 | 透传 | `positiveInteger` 只校验正整数；同时作为 Main 侧看门狗（`:169-173`） |
| RPC 载荷守卫 | `src/shared/types/workerRpc.ts:893-907` | 非空串 | `isWorkerEffort` | **1 ≤ x ≤ 600000，越界整条载荷判非法** |
| RPC server | `src/agent-host/piWorkerRpcServer.ts:596-621` | 透传 | 透传 | 透传 |
| worker 入口 | `src/agent-host/worker.ts:114-126` | — | — | — |
| 引擎 | `nativeUtility.ts:93-115`（model）、`:109-113`（effort）、`:239-253`（timeoutMs → `streamSimple`） | `provider/id` 按首个 `/` 切分，不在 `model.list()` 里报 `WORKER_MODEL_NOT_FOUND` | `off → undefined`；缺省 → 目录档位 | 交给 `streamSimple` 的 `timeoutMs`（与 Main 同值） |

## 节点判定

**P6-2（产品消费者面）：complete-with-gaps**

引擎与传输侧的迁移是完成的：一次性补全确实跑在自有 runtime 上，不建会话、不落 trace、不过权限门、不注册工具，进程回收三条路径闭合，审计点名的两条（worker-runtime-02 / -09）在调用方一侧复核后果确已消失。缺口全部在产品消费者一端且都影响用户可见行为：冷启动用热预算（utility-01）、超时设置无上界会撞协议守卫（utility-02）、模型选择显示与发送不一致（utility-03）、引擎错误串直通界面（utility-04）、分支名不做围栏剥离（utility-05）、超时顶掉已渲染正文（utility-06）；外加两端超时无余量（utility-07）与整段零测试（utility-08）。因此不判 complete。

## 发现

### [utility-01] medium robustness | P6-2 | src/main/services/agent-host/PiUtilityService.ts:119 | 一次性补全的冷启动用的是 10 秒「热请求」预算，而会话路径为同一件事专门配了 60 秒

DESC：`utility.start` 这一次 RPC 覆盖的是整段冷启动——`utilityProcess.fork`、开发态 `--experimental-strip-types` 地加载 agent-host + runtime 模块图、`createRuntime` 建 Cordis 图与模型适配器、读一次 `<agentDir>/settings.json`——因为 `handleUtilityStart` 是 `await this.utilityRuntime.start(...)` 之后才应答的。而这个 slot 的请求预算被写死成 `DEFAULT_REQUEST_TIMEOUT_MS = 10_000`（`:79`、`:119`），`:192` 的 `slot.request('utility.start', ...)` 也没传 `timeoutMs` 覆盖。会话路径对**同一类**工作给的是 60 秒，且注释里记了踩过的坑（"on a busy machine `chat:resumeSession` failed with `worker.bootstrap timed out after 10000ms`"），utility 路径没有跟上这条结论。本条的时长部分是静态推断：确切耗时要在真实载体上测，static_inference = true；但两条路径的预算不对称本身是代码事实。

EVIDENCE：
```ts
// src/main/services/agent-host/PiUtilityService.ts:78-79
const CANCEL_ACK_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// :114-122
return new WorkerSlot({
  slotKey: `utility:${input.generation}`,
  ...
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
// :192
const acknowledgement = await slot.request('utility.start', {
```
```ts
// src/main/services/agent-host/createPiWorkerSlot.ts:41-57
 * `WorkerSlot`'s 10s default is sized for requests answered by a process that
 * is already up. `worker.bootstrap` is the opposite: it is the cold start ...
 * Reusing the warm budget here made a slow-but-healthy cold start indis-
 * tinguishable from a wedged worker ...
export const BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000;
```
```ts
// src/agent-host/piWorkerRpcServer.ts:621
this.respondSuccess(request, await this.utilityRuntime.start(request.payload));
```

SCENARIO：加密 Windows 现场（或任何正在跑全量测试的开发机）上点「生成提交信息」。进程 fork + 模块图加载 + Cordis bootstrap 超过 10 秒，Main 在模型还没被调用之前就判 `WORKER_RPC_TIMEOUT`，`complete()` 抛 `PI_UTILITY_TRANSPORT_FAILED`，toast 显示 `Worker request utility.start timed out after 10000ms`。用户配置的 120 秒完全没派上用场，重试还是撞同一堵墙（每次都是全新冷启动，没有暖进程可复用）。

FIX：给 `utility.start` 一个冷启动档预算，复用 `BOOTSTRAP_REQUEST_TIMEOUT_MS` 或在 `PiUtilityService` 里定义同量级常量，在 `:192` 用 `{ timeoutMs: UTILITY_START_TIMEOUT_MS }` 覆盖；`WorkerSlot` 的 `requestTimeoutMs` 保持 10 秒给 `utility.cancel` 这类热请求。补一条用例：start 请求的 `timeoutMs` 与 cancel 请求的不同量级。

### [utility-02] medium contract-gap | P6-2 | src/renderer/components/settings/AISettings.tsx:212 | 超时设置无上界，配到 600 秒以上会被 RPC 载荷守卫整条判非法，报错却说「缺 id / cwd / prompt」

DESC：设置页的超时输入框是裸 `<input type="number">`，没有 `min` / `max`，也没有任何钳制；`Number(v) || 60` 只挡住 0 和非数字。这个值以**秒**存，`commit-message.ts:113` 乘 1000 交给 `PiUtilityService`，Main 侧 `positiveInteger` 只校验「正安全整数」，于是 700 秒（= 700000 ms）一路畅通到 worker，被 `isWorkerUtilityStartPayload` 的 `> 10 * 60_000` 判假。错误信息是一句把四个字段并列的通用文案，指不到「超时值」这个真凶。渲染层、Main、协议三层里只有最里面那层知道 10 分钟这个上界。

EVIDENCE：
```tsx
// src/renderer/components/settings/AISettings.tsx:209-220
{'timeout' in feature && (
  <SettingsRow>
    <span className="text-sm font-medium">{t('Timeout')}</span>
    <Input
      type="number"
      className="w-32"
      value={feature.timeout}
      onChange={(event) => setFeature(key, { timeout: Number(event.target.value) || 60 })}
    />
```
```ts
// src/shared/types/workerRpc.ts:895-904
  if (
    !nonEmptyString(value.operationId) || !nonEmptyString(value.cwd) ||
    !nonEmptyString(value.prompt) || !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 10 * 60_000
  ) { return false; }
```
```ts
// src/agent-host/piWorkerRpcServer.ts:598-601
message: 'utility.start requires an operation id, cwd, prompt, and valid timeout',
```

SCENARIO：用户觉得 120 秒不够（大 diff + 高 effort），在设置里把提交信息超时改成 900。此后每次点「生成提交信息」都立即失败，toast 描述是 `WORKER_INVALID_PAYLOAD: utility.start requires an operation id, cwd, prompt, and valid timeout`。用户没有任何线索指向自己刚改的那个数字，功能从此长期不可用。附带的反向形态：输入 `-5` 不被 `|| 60` 拦下（`-5` 为真值），Main 的 `positiveInteger` 抛裸 `Error`，toast 显示 `Pi utility timeout must be a positive safe integer, received -5000`。

FIX：把 600 秒上界提到共享常量（与 `workerRpc.ts` 的 `10 * 60_000` 同源），在 `AISettings` 的输入框加 `min` / `max` 并在 `onChange` 里钳制；同时在 `PiUtilityService.complete` 里对越界值抛 `PI_UTILITY_FAILED` 并给出指名道姓的文案（"timeout must be between 1s and 600s"），不要让它跑到协议守卫上。补两条用例：越界值在 Main 侧被挡下、钳制后的设置值能通过载荷守卫。

### [utility-03] medium correctness | P6-2 | src/renderer/components/settings/AISettings.tsx:49 | 模型下拉在目录里查不到已存值时显示「自动」，却不回写，请求仍然带着那个旧模型

DESC：`ModelField` 的显示值是「存值在目录里找得到就用存值，否则显示 `__automatic__`」，但它**只读不写**——`feature.model` 里的旧值原封不动留着，下次点生成照样发出去。同一个表单里 `EffortField` 恰恰做了相反的事：`useEffect` 在 `reconciled === 'default'` 时主动 `onChange(undefined)` 把不被支持的档位回写掉（`:82-84`）。于是设置页显示「自动」、请求却带着一个引擎不认识的模型 ref，引擎按 `runtime.model.list()` 查不到就报 `WORKER_MODEL_NOT_FOUND`。注意 `efforts.ts:186-193` 已经写明了「目录没加载完时不能当作证据抹掉用户选择」这个约束，所以修法必须挂在「目录权威」这个条件上，而不是无脑回写。

EVIDENCE：
```tsx
// src/renderer/components/settings/AISettings.tsx:49
const selected = value && models.some((model) => model.id === value) ? value : AUTOMATIC;
```
```tsx
// src/renderer/components/settings/AISettings.tsx:81-84（同一文件里 effort 的对照写法）
useEffect(() => {
  if (value && reconciled === 'default') onChange(undefined);
}, [onChange, reconciled, value]);
```
```ts
// src/runtime/worker/nativeUtility.ts:184-188
if (!runtime.model.list().some((item) => item.provider === ref.provider && item.id === ref.id))
  throw new NativeWorkerRuntimeError(
    'WORKER_MODEL_NOT_FOUND',
    `model is unavailable or has no configured authentication: ${requested}`
  );
```

SCENARIO：用户把提交信息模型钉在 `pilab/some-model`，之后管理员在托管目录里下掉了这个模型（或用户删掉了自己那条服务）。设置页打开显示「自动」，看上去没问题；点「生成提交信息」却每次报 `WORKER_MODEL_NOT_FOUND: model is unavailable or has no configured authentication: pilab/some-model`。用户按界面所见（已经是「自动」）无法理解错误，也没有明显动作能清掉这个存值——除非手动再选一次别的模型。

FIX：给 `ModelField` 加与 `EffortField` 同形的收敛：仅当目录 `authoritative`（`usePiModelCatalog` 已经暴露这个字段）且确认不含该 id 时，回写 `model: ''`；或退一步，在选中项不在目录里时把触发器文案显示成「`<id>`（不可用）」而不是「自动」，让显示与实际发送一致。补一条渲染层用例：存值不在目录里时，触发器文案与随请求发出的 `model` 一致。

### [utility-04] medium i18n | P6-2 | src/renderer/components/source-control/CommitBox.tsx:61 | 三个功能把引擎内部英文错误串直接当提示文案，只有恰好等于 `'timeout'` 的那一种被翻译

DESC：这条链上所有失败都以 `PiUtilityServiceError.message` 的原文向用户显示。翻译只覆盖一个字面量 `'timeout'`——而这个字符串来自 `PiUtilityService.ts:363` 的三元表达式，是一个没有测试钉住的跨层文案约定。其余全部原样透出：`WORKER_MODEL_NOT_FOUND: ...`、`WORKER_INVALID_PAYLOAD: ...`、`Worker request utility.start timed out after 10000ms`、`Worker exited (code=1 signal=null)`、`Too many AI utility operations are already running`。对照物就在同一个仓库里：chat 面为 `WORKER_MODEL_NOT_FOUND` 专门做了一张带迁移引导的中文卡（`src/renderer/components/chat/modelMissingError.ts:24-71`，并在注释里解释了 `WorkerSlot` 把远端失败格式化成 `` `${code}: ${message}` `` 这件事），三个 AI 功能一张也没有。另外容量类失败尤其难懂：`capacity` 默认 2 且被三个功能共享，用户看到的是一句英文「Too many AI utility operations are already running」，界面上没有任何地方说明是谁占着名额。

EVIDENCE：
```tsx
// src/renderer/components/source-control/CommitBox.tsx:59-64
toastManager.add({
  title: t('Failed to generate commit message'),
  description: result.error === 'timeout' ? t('Generation timed out') : result.error,
```
```ts
// src/main/services/agent-host/PiUtilityService.ts:359-365（'timeout' 这个字面量的唯一产地）
this.settleFailure(record, new PiUtilityServiceError(
  code, record.timedOut ? 'timeout' : terminal.error || `Pi utility ${terminal.state}`));
// :137-141
throw new PiUtilityServiceError('PI_UTILITY_CAPACITY_EXCEEDED',
  'Too many AI utility operations are already running');
```
```ts
// src/renderer/components/chat/modelMissingError.ts:24-36（chat 面的对照实现）
export const MODEL_MISSING_CODE_TOKEN = 'WORKER_MODEL_NOT_FOUND';
export function isModelMissingError(text: string | null | undefined): boolean { ... }
```

SCENARIO：中文界面用户在评审跑着（占 1 个名额）的同时生成提交信息（第 2 个），再去新建 worktree 点「生成分支名」。分支名输入框下方红字显示 `Too many AI utility operations are already running`。同一用户若模型被下架，另一次点击得到 `WORKER_MODEL_NOT_FOUND: model is unavailable or has no configured authentication: pilab/x`。两条都不是这个应用的界面语言，也都不含任何可执行的下一步。

FIX：把 `PiUtilityServiceError.code` 透到渲染层（现在只有 message 过得去），在渲染层按 code 查词典出中文文案与下一步建议——`PI_UTILITY_CAPACITY_EXCEEDED` 说「另一个 AI 任务正在运行，稍后再试」，`WORKER_MODEL_NOT_FOUND` 复用 `MODEL_MISSING_ERROR_VIEW` 的现成文案。若不想改协议形态，至少把 `'timeout'` 这个字面量约定提成共享常量并补一条用例钉住，避免下次改动静默打掉唯一一条被翻译的路径。

### [utility-05] medium correctness | P6-2 | src/main/services/ai/branch-name.ts:27 | 分支名不过 `stripCodeFence`（同目录的提交信息过），围栏答案会原样写进分支名与 worktree 路径

DESC：`providers.ts` 里那个 `stripCodeFence` 的注释明写「Remove an optional Markdown fence from a Pi one-shot completion」——即这条链的模型输出**预期可能带围栏**。`commit-message.ts:115` 用了它，`branch-name.ts:27` 只做了 `.trim()`。而三个功能里分支名恰恰是对格式最敏感的一个：结果直接进输入框，再经 `buildWorktreePath` 拼成文件系统路径（`CreateWorktreeDialog.tsx:271` → `src/shared/defaultPaths.ts:117-136`，全程无字符白名单）。多行答案同理：`trim()` 不会去掉中间的换行。本条需要一次真实模型回合才能观察到围栏发生的频率，static_inference = true；但两个模块的处理不对称是代码事实。

EVIDENCE：
```ts
// src/main/services/ai/branch-name.ts:20-27
const completion = await piUtilityService.complete({ ... });
return { success: true, branchName: completion.text.trim() };
```
```ts
// src/main/services/ai/commit-message.ts:115（同目录对照）
return { success: true, message: stripCodeFence(completion.text) };
// src/main/services/ai/providers.ts:1-2
/** Remove an optional Markdown fence from a Pi one-shot completion. */
export function stripCodeFence(text: string): string {
```

SCENARIO：用户在新建 worktree 对话框里输入中文描述、点「生成分支名」。模型（尤其是 effort 较高、倾向于解释的模型）回一段 ```` ```\nfeat-20260915-login-retry\n``` ````。分支名输入框被填成带三个反引号和换行的字符串，用户点「创建」后 `git worktree add -b` 直接失败，报的是 git 的分支名非法错误，看不出是生成环节的问题。

FIX：`branch-name.ts` 先过 `stripCodeFence`，再取第一行非空内容，最后按分支名字符白名单（`[a-z0-9._/-]`）过滤并压缩连续分隔符——提示词里已经写了这套规则，只是没有在代码里兜底。补三条 `stripCodeFence` + 分支名归一化的纯函数用例（围栏、多行、越界字符）。

### [utility-06] medium correctness | P6-2 | src/renderer/components/source-control/CodeReviewModal.tsx:319 | 超时或失败时错误块优先于内容渲染，已经流式显示了几分钟的评审正文被一行错误顶掉

DESC：内容区是 `displayError ? <错误行> : displayContent ? <Markdown> : ...` 的三元链，错误排在最前。代码评审是这条链上唯一会长时间流式输出的功能（硬编码 10 分钟预算，`code-review.ts:105`），一旦在末尾超时或失败，`status` 置 `error`、`error` 置文案，整块已渲染的正文立刻消失。正文其实还在 store 里（`resetReview` 才清空），页脚的复制按钮也还挂着 `displayContent &&` 的条件因此仍然可见——于是出现「屏幕上看不到内容，但复制按钮能把内容复制走」这种自相矛盾的状态。另外 worker 在取消时是把已累计文本一并回传的（`nativeUtility.ts:290-296` 的 `text: active.text`），Main 在 `record.timedOut` 分支里把它丢弃（`PiUtilityService.ts:354-365` 只取 error 不取 text），所以对不流式的两个功能而言，超时等于把「已经生成了一大半」的结果一起扔掉。

EVIDENCE：
```tsx
// src/renderer/components/source-control/CodeReviewModal.tsx:319-325
{displayError ? (
  <div className="flex items-center gap-2 text-destructive">
    <AlertCircle className="h-4 w-4" />
    <span>{displayError}</span>
  </div>
) : displayContent ? (
```
```tsx
// 同文件 :377-381（页脚仍按内容显示复制按钮）
{displayContent && (
  <Button variant="outline" onClick={handleCopy}>
```
```ts
// src/runtime/worker/nativeUtility.ts:290-296（worker 确实把部分文本带了回来）
this.options.emitTerminal({ operationId: ..., state, text: active.text, model: active.model, ... });
```

SCENARIO：大仓库的一次代码评审跑了 9 分 50 秒、正文已经渲染了一大半，10 分钟看门狗触发。面板正文整块被替换成一行 `timeout`，用户以为什么都没生成；点「重新评审」则从零开始，再花十分钟并很可能再次超时。

FIX：错误与内容改为并存——有内容时把错误降级成正文上方或下方的一条横幅（保留「已生成部分」的措辞），只有 `!displayContent` 时才整块显示错误。顺带把 `PiUtilityService.handleTerminal` 在超时/取消分支里带回的 `terminal.text` 透给调用方（例如 `PiUtilityServiceError` 上挂 `partialText`），让提交信息和分支名也能用上半成品。

### [utility-07] low contract-gap | P6-2 | src/main/services/agent-host/PiUtilityService.ts:169 | 两端超时共用同一个 `timeoutMs`、没有先后余量，与 `/compact` 明确写下的「顺序即契约」相反；worker 侧那份实际上永远轮不到

DESC：`input.timeoutMs` 同时充当两个角色：Main 的看门狗（`:169-173` 的 `setTimeout`）和 worker 交给 `streamSimple` 的请求超时（`nativeUtility.ts:248`）。两个数字完全相同，没有任何余量。而 Main 的表在 fork 之前就起跑，worker 的表要等进程起来、RPC 应答、模型调用发出才开始，所以 Main 必然先到——`streamSimple` 的 `timeoutMs` 成了一份永远触发不到的配置。T016 为 `/compact` 处理过同一类问题，并把结论写成了注释：「the order of the two numbers is the contract」，用 `WORKER_COMPACT_BUDGET_MS`(45s) < `WORKER_COMPACT_REQUEST_TIMEOUT_MS`(60s) 两个共享常量表达；utility 路径没有对应的表达。附带后果：用户配的 120 秒里，冷启动那几秒是从模型可用时间里扣的。

EVIDENCE：
```ts
// src/main/services/agent-host/PiUtilityService.ts:168-174（Main 的表，在 slot.request 之前起跑）
const result = new Promise<PiUtilityCompletionResult>((resolve, reject) => {
  const timeout = setTimeout(() => { ... void this.cancelRecord(record, 'timeout'); }, input.timeoutMs);
```
```ts
// src/runtime/worker/nativeUtility.ts:246-249
{ signal: active.controller.signal,
  timeoutMs: active.input.timeoutMs,
```
```ts
// src/shared/types/workerRpc.ts:310-318（对照：compact 把顺序写成契约）
 * the worker aborts its own summary FIRST, and only then does Main stop waiting ...
export const WORKER_COMPACT_BUDGET_MS = 45_000;
export const WORKER_COMPACT_REQUEST_TIMEOUT_MS = 60_000;
```

SCENARIO：并非直接的用户故障，而是一条失效的兜底：当 Main → worker 的 `utility.cancel` 因为 worker 事件循环繁忙而迟到时，本应由 worker 自己的 `streamSimple` 超时兜底收尾；但因为它的截止时间晚于 Main 的，Main 已经先判超时并拆掉 slot，这份兜底从来没有机会生效。

FIX：照 compact 的形态给 utility 也定两个数：worker 侧用 `timeoutMs`，Main 侧用 `timeoutMs + 余量`（余量按冷启动量级取，例如 5～10 秒），并把 Main 的表改到 `utility.start` 应答之后再起跑，使用户配置的时长真正等于模型的可用时长。

### [utility-08] low test-gap | P6-2 | src/main/services/ai/index.ts:1 | 三个功能的产品侧代码零测试：`src/main/services/ai/*` 与 `stores/codeReview.ts` 一条用例都没有

DESC：全仓搜索 `stripCodeFence` / `generateCommitMessage` / `startCodeReview` / `generateBranchName` 在 `*.test.ts(x)` 中零命中。这意味着：输出解析（`stripCodeFence` 的正则、分支名的 `trim`）、提示词模板的单次替换（`commit-message.ts:91-95` 那条防注入的 single-pass 替换）、评审的 git 前置步骤与「无变更」短路、渲染层评审 store 的 reviewId 过滤与清理函数，全部只有类型检查在保。`PiUtilityService.test.ts` 的 6 条用例也没有覆盖超时分支（`record.timedOut`）、崩溃分支（`handleLifecycle`）、`forceKillAllNow`、重复 operationId，而超时分支正是 utility-04 里那个 `'timeout'` 文案约定的唯一产地。

EVIDENCE：
```
$ grep -rln "stripCodeFence\|generateCommitMessage\|startCodeReview\|generateBranchName" --include=*.test.ts --include=*.test.tsx src/
（无输出）
```
```ts
// src/main/services/agent-host/__tests__/PiUtilityService.test.ts:113-277
// 6 条：流式+回收 / 取消 / invalidateAll / 交付目录 / 不交付目录 / 容量
```

SCENARIO：任何人改动 `stripCodeFence` 的正则、或把 `PiUtilityService.handleTerminal` 里 `'timeout'` 改成别的词，测试全绿，而提交框会静默退回显示英文原串。

FIX：给 `providers.ts` 补纯函数用例（无围栏 / 带语言标签的围栏 / 只有开头围栏 / 空串）；给 `PiUtilityService` 补假时钟的超时用例（断言 `code === 'PI_UTILITY_TIMEOUT'` 且 `message === 'timeout'`）与崩溃用例；给 `stores/codeReview.ts` 补 reviewId 过滤与 `stopCodeReview` 清理的用例。

### [utility-09] low correctness | P6-2 | src/renderer/components/source-control/CodeReviewModal.tsx:305 | 评审弹窗标题把模型设置原样渲染，默认「自动」时显示一对空括号

DESC：标题里 `({codeReviewSettings.model})` 直接插了设置值。`defaultCodeReviewSettings.model` 是 `''`（对应界面上的「自动」），所以未选模型的默认安装打开评审弹窗，标题是「代码评审 ()」。另外这里读的是设置里的 id 而不是本次实际使用的模型——引擎在终端事件里回了 `model`（`nativeUtility.ts:101`、`:294`），`PiUtilityService` 也把它带回了 `PiUtilityCompletionResult.model`（`:40-43`），但代码评审路径把整个返回值丢弃（`code-review.ts:99` 的 `await` 没有接结果），所以「自动」时界面永远无法显示真正用了哪个模型。

EVIDENCE：
```tsx
// src/renderer/components/source-control/CodeReviewModal.tsx:303-307
{t('Code Review')}
<span className="text-muted-foreground font-normal">
  ({codeReviewSettings.model})
</span>
```
```ts
// src/renderer/stores/settings/defaults.ts:145-148
export const defaultCodeReviewSettings: CodeReviewSettings = { enabled: true, model: '', ... };
// src/main/services/ai/code-review.ts:99（返回值被丢弃）
await piUtilityService.complete({ ... });
```

SCENARIO：全新安装、没改过 AI 设置的用户打开代码评审弹窗，标题显示「代码评审 ()」。

FIX：`model` 为空时不渲染这段括号（或显示 `t('Automatic')`）；更进一步，把 `complete()` 返回的实际 `model` 经 `onComplete` 回传给渲染层，标题显示这次真正用的模型。

### [utility-10] low robustness | P6-2 | src/renderer/components/settings/AISettings.tsx:113 | AI 设置页硬编码宿主状态为 ready 并丢弃目录状态行，目录不可用时模型菜单只剩「自动」且不作任何说明

DESC：`usePiModelCatalog` 的第一个参数是宿主状态，它的作用是「宿主没就绪就不要去问目录」（同文件注释与 `shouldRequestCatalog` 的 `isHostUsable` 短路）。另外两个调用方都传真实状态（`RunSurfaceView.tsx:143` 传 `hostStatus.state`、`ComposerModelTrigger.tsx:235` 传 `hostState`，后者还有静态用例 `piModelWiring.test.ts:46` 钉住），只有 AI 设置页传字面量 `'ready'`。同时这里只解构了 `catalog`，把 hook 提供的 `status`（含可重试的说明行）整个丢掉。后果不是缓存中毒（非权威来源每次都会重试，`piModelCatalog.ts:119`），而是：目录取不到时三项 AI 功能的模型菜单只剩一个「自动」，用户得不到任何「目录暂不可用」的提示——而同一时刻 chat 的模型触发器会把这句话显示出来。

EVIDENCE：
```tsx
// src/renderer/components/settings/AISettings.tsx:113
const { catalog } = usePiModelCatalog('ready');
```
```tsx
// src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx:143（对照）
const { catalog } = usePiModelCatalog(hostStatus.state);
```
```ts
// src/renderer/components/chat/piModelCatalog.ts:109-110
if (!isHostUsable(input.hostState)) return false;
```

SCENARIO：宿主尚未就绪（或托管凭据不可读）时打开 设置 → AI 功能，三项功能的模型下拉都只有「自动」一项，页面上没有任何说明；用户以为自己的模型都没了。

FIX：把真实宿主状态传进去，并渲染 hook 返回的 `status.message` / 重试按钮，与 chat 的模型触发器保持同一套说明。

## 测试缺口

1. `src/main/services/ai/` 四个模块零测试：`stripCodeFence` 正则、提交信息模板的单次替换防注入、分支名输出处理、评审的 git 前置与「无变更」短路，全部无用例（utility-08）。
2. `src/renderer/stores/codeReview.ts` 零测试：reviewId 过滤、`cleanupFn` 生命周期、`exit` 事件与 `complete` 状态的先后判定都没有用例。
3. `PiUtilityService.test.ts` 缺超时分支（`record.timedOut` → `'timeout'` 文案）、崩溃分支（`handleLifecycle`）、`forceKillAllNow`、重复 `operationId` 四类用例。
4. 没有任何用例断言 `utility.start` 的请求预算与热请求预算不同（utility-01 的回归守卫）。
5. 没有用例覆盖「超时值越界」这条端到端路径（utility-02）。
6. 没有渲染层用例断言「设置页显示的模型 = 随请求发出的模型」（utility-03）。
7. 三个功能都没有一条「真实 worker 进程」级别的集成用例；`workerEndToEnd.test.ts` 显式拒绝提供 utility runtime（`:119-121`），`piWorkerRpcServer.test.ts:378` 用的是替身。这条链从 `piUtilityService.complete` 到 `NativeUtilityRuntime` 之间**没有任何一处被同一个测试同时覆盖**。

## 未经执行验证的声明

1. **冷启动到底要多久**：utility-01 的 10 秒是否真的不够，取决于载体、机器负载和是否开发态类型剥离。本机未跑 Electron，无实测数据。
2. **`streamSimple` 的取消语义**：`nativeUtility.cancel` 在 abort 之后立刻 `finish`，注释解释了「provider 不理会 signal 时 Main 不能被挂住」。真实 provider 在 abort 后是否还会继续消耗配额，只有真机回合能看出来。
3. **stdout 背压**：`createUtilityProcessWorkerTransport`（`WorkerTransport.ts:56-94`）没有像 Node 分支那样 `proc.stdout?.resume()`，而 `utilityProcess.fork` 用的是 `stdio: 'pipe'`。理论上子进程写满 stdout 管道会被阻塞。但我在 `src/runtime` 与 `src/agent-host` 的非测试源码里搜不到任何 `console.log` / `process.stdout.write`，只有 `console.error`（stderr 被 `subscribeReadable` 的 `data` 监听器排空了）。**构造不出触发路径**，故不立发现；若将来引入会写 stdout 的第三方库，这条会立刻变成活的。
4. **`readModelCatalog()` 抛错的形态**：`PiUtilityService.ts:190` 在 try 之外调用，抛错会让已建的 operation 记录与 slot 短暂悬空。但 `resolveNativeModelCatalogWith`（`nativeCatalog.ts:55-80`）整体包在 try/catch 里、只返回 `undefined`，**构造不出触发路径**，故不立发现。
5. **`configuredEffort` 的实际生效面**：本应用自身不写 `<agentDir>/settings.json` 的 `defaultThinkingLevel` / `modelThinkingLevels`（全仓只有 `nativeUtility.ts` 在读），写它的是用户自己的 pi CLI / 内嵌 TUI。因此这条回落在纯 GUI 用户身上是否永远不生效，需要在有 TUI 使用历史的真机上确认。
6. **托管模式 + 钥匙串锁定**时 utility 的取值：按代码应当是 `resolveNativeModelCatalog()` 返回 `undefined` → worker 回落读 `<agentDir>/models.json` + `auth.json`。这条回落路径本次只做了静态阅读，没有在真机的锁定钥匙串上验证过。
7. **usage 计入**：utility 路径不产生本地用量记录（`UsageService` 是向网关拉取的，不是本地账本），故三个功能的花费按「同一把 key 的服务端计量」体现。未在真实账号上核对过服务端是否把这三种请求计入同一配额。

## 上机检查单（批次 E）

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| utility 冷启动耗时 | 从 `utility.start` 发出到收到 ack 的耗时；判 10 秒预算是否足够 | 在 `PiUtilityService.ts:192` 前后打时间戳日志（或用 `--remote-debugging-port` 在 Main 日志里读），点一次「生成提交信息」，记录三次冷启动耗时 | encrypted |
| utility 在 Electron utility 载体上的端到端 | 三个功能在打包态各跑一次成功回合；worker 进程在结算后确实退出（无残留） | 任务管理器 / `ps` 观察 `AiClient Pi Worker N` 的生灭；同时记录 `utility.terminal` 的 `state` 与 `model` | utility |
| Windows 打包态走的是 node.exe 分支 | `app.isPackaged && win32` 时 utility worker 由 `node-runtime/node.exe` 起，而不是 utilityProcess | 观察进程名与 `PiWorkerProcess.ts:79-92` 分支的日志 | windows |
| 托管模式 + 钥匙串锁定下的三个功能 | `resolveNativeModelCatalog()` 返回 undefined → worker 回落读 agent 目录 → 功能仍可用（或给出可理解的错误） | 锁定钥匙串后点三个按钮，记录错误码与是否读到了 `auth.json` | windows |
| 超时的用户可见表现 | 10 分钟评审超时后：面板显示什么、已流式正文是否消失、复制按钮是否仍可用、能否重试、worker 是否残留 | 把评审超时临时调小（或对一个超大 diff 跑满），录屏 + 进程观察 | utility |
| 并发点击与容量 | 评审 + 提交信息占满 capacity=2 后，第三个功能给出的提示文案与可操作性 | 依次触发三个功能，截图提示 | utility |
| 真实模型输出形态 | 分支名是否出现围栏 / 多行 / 解释性文字；提交信息围栏剥离是否正确；空输出时的界面表现 | 用当前默认模型各跑 10 次，记录原始 `text` 与界面最终值 | real-model |
| 模型被下架后的设置页一致性 | 设置页显示「自动」时，请求里实际携带的 `model` 值 | 在 Main 侧打印 `utility.start` 载荷，与设置页显示对照 | real-model |

## 读过的文件

- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、六、七、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（第 55-102 行，含 CRITIC 全部 GAP）
- docs/plantree/plans/runtime-hardening/roadmap.md
- src/main/services/agent-host/PiUtilityService.ts
- src/main/services/agent-host/__tests__/PiUtilityService.test.ts
- src/main/services/agent-host/PiWorkerProcess.ts
- src/main/services/agent-host/WorkerSlot.ts
- src/main/services/agent-host/WorkerTransport.ts
- src/main/services/agent-host/createPiWorkerSlot.ts
- src/main/services/ai/index.ts
- src/main/services/ai/providers.ts
- src/main/services/ai/branch-name.ts
- src/main/services/ai/commit-message.ts
- src/main/services/ai/code-review.ts
- src/main/ipc/git.ts（AI 三个处理器段）
- src/main/ipc/index.ts（清理钩子段）
- src/main/ipc/workerManager.ts
- src/main/services/piModelConfig/index.ts
- src/main/services/piModelConfig/nativeCatalog.ts
- src/main/services/piModelConfig/PiModelConfigService.ts（目录投影段）
- src/main/services/usage/UsageService.ts（数据来源段）
- src/shared/piModelConfig.ts（piModelOption / NATIVE_PROJECT_TRUSTED）
- src/shared/types/workerRpc.ts（utility 协议与守卫、compact 常量）
- src/shared/types/agentHost.ts（SessionEffortLevel）
- src/shared/types/agentCatalog.ts
- src/shared/defaultPaths.ts（buildWorktreePath）
- src/agent-host/worker.ts
- src/agent-host/piWorkerRpcServer.ts（utility 相关段与 dispatch / dispose）
- src/agent-host/__tests__/piWorkerRpcServer.test.ts（utility 用例）
- src/runtime/worker/nativeUtility.ts
- src/runtime/flags.ts
- src/runtime/bootstrap.ts（RuntimeBootstrapOptions 段）
- src/runtime/__tests__/nativeUtility.test.ts（用例清单）
- src/runtime/__tests__/workerEndToEnd.test.ts（utility 段）
- src/renderer/stores/codeReview.ts
- src/renderer/hooks/useCodeReview.ts
- src/renderer/components/source-control/CodeReviewModal.tsx
- src/renderer/components/source-control/CommitBox.tsx
- src/renderer/components/worktree/CreateWorktreeDialog.tsx
- src/renderer/components/settings/AISettings.tsx
- src/renderer/components/chat/efforts.ts
- src/renderer/components/chat/usePiModelCatalog.ts
- src/renderer/components/chat/piModelCatalog.ts（shouldRequestCatalog）
- src/renderer/components/chat/modelMissingError.ts
- src/renderer/stores/settings/defaults.ts
- src/renderer/stores/settings/types.ts（AI 功能段）
- src/renderer/stores/settings/migration.ts（超时钳制核查）
