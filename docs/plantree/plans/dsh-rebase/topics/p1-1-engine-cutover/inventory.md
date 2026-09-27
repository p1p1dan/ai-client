# P1-1 引擎直替：盘点明细

Role: detail shard。上位：[P1-1 方案](../p1-1-engine-cutover.md)。2026-09-26 在 `feat/dsh-p0-probe` HEAD `5e1385e7` 上只读核对；DSH 一律以 `src/dsh-host/node_modules/@deepseek-ai/*`（`0.1.7-rc.2`）源码为准。行号都指该提交。标「推断」的是读了代码、没有运行验证的结论。

## 1 四条拉起路径（Main → worker）

### 1.1 汇合点

- 四条路径都走 `WorkerManager.spawnForEntry`（`src/main/services/agent-host/WorkerManager.ts:2535-2606`）：新建 `:1023`、恢复冷路径 `:1280`、fork 目标 `:1861`、崩溃重启 `:3297`。它调 `this.createSlot`（`:2552`，默认 `createPiWorkerSlot`，`:548`）；只有 `entry.sessionFile` 有值且不是 `fresh` 时才带 `sessionFile`（`:2557`）。
- 引擎只在一处分叉：`createPiWorkerSlot.ts:70-75`（注入的 `createTransport` → 开发开关 `isDevDshEngineSelected()` → `forkPiWorkerProcess`）。随后发 `worker.bootstrap`（`:92-138`，冷启动预算 60 s，`:58`）。
- 开关本身：`devDshEngine.ts:51-56`（`AICLIENT_DEV_ENGINE=dsh` 且未打包；读不到 `app` 按打包处理）。
- worker 端：`src/agent-host/piWorkerRpcServer.ts:575-613` 的 `handleBootstrap` 首次建 runtime 并调 `runtime.bootstrap()`。DSH 下 runtime 是 `DshSessionRuntime`（`src/dsh-host/bundle/lib/bridge.js:53`）。
- 不经这里的 native 拉起（不是聊天会话）：`PiUtilityService.ts:113`（提交信息、分支名、代码评审，调用方在 `src/main/services/ai/{commit-message,branch-name,code-review}.ts`）和 `src/main/services/legacyImport/PiImportProcess.ts:93`（CC / Codex 导入）。二者直接调 `forkPiWorkerProcess`。

### 1.2 逐条

| 路径 | 触发（渲染层 → Main） | 传给 worker 的身份 | worker 装载 | Main 对结果的硬要求 | DSH 下今天的结局 |
|---|---|---|---|---|---|
| 新建 | 首次发送 preamble=`create`（`ChatComposer.tsx:1570`、`:2360` → `:2067`）→ `CHAT_CREATE_SESSION`（`src/main/ipc/chat.ts:282-362`，先 `recordCreated` 写 `agent: PI_AGENT`，`:314-321`）→ `createSession`（`WorkerManager.ts:906-1097`）。另一入口：恢复时发现索引身份从未落盘的「修复」分支（`chat.ts:504-528`，同一逻辑 id 重新 `createSession`） | `logicalSessionId` + `cwd`（+ model / effort / tier / permissions / TTL / modelCatalog），**无** `sessionFile` | `worker.bootstrap`；bridge `agents.create({sessionId: 'aiclient-<logicalId>'})` 后写桩 `$DSH_HOME/aiclient-sessions/<id>.dsh.json`（`dshSessionRuntime.ts:297-315`） | 必须返回 `sessionFile`（`:1027-1032`）；桩存在即提交身份（`:1072`，`commitIdentityIfMaterialized` `:3423-3430`）；`session.created` 带 `agent: PI_AGENT`（`:1079`） | 能走通（P0-3 GUI 验过），但桩先于 DSH 会话落盘（见 4.3） |
| 恢复 | ① 点开会话：先主进程只读预览，失败才恢复（`activateSessionStart.ts:111-133` → `useResumeSession.ts:60`，意图判断 `resumeIntent.ts:58-138`）；② 发送 preamble=`resume`（`ChatComposer.tsx:2384-2448`）；③ direct 发送遇 `session_not_found` 后重开（`:2524-2580`）；④ 历史错误卡的「重试」（`MessageTimeline.tsx:1087`）→ `CHAT_RESUME_SESSION`（`chat.ts:436-543`，校验行 agent 为 pi `:464`、身份与工作区一致 `:469-478`）→ `resumeSession`（`WorkerManager.ts:1099-1368`） | `logicalSessionId` + `cwd` + `sessionFile` = 索引 `runtimeIdentity`（+ 一次性 `forceTakeover`，`:1286-1290`） | 热路径（已有 ready 槽）不拉起，只读 `worker.history`（`:1171-1219`）；冷路径 `worker.bootstrap`，bridge 读桩后 `agents.resume`（`dshSessionRuntime.ts:288-296`） | 重开的必须是同一键，或声明 `sessionSourceFile`（`:1292-1323`）；**必须有 `initialHistory`**（`:1324-1330`，否则 `worker_resume_history_missing`）；`commitResumed`（`:1332-1338`）；`session.resumed` 带 `agent: PI_AGENT`（`:2864`） | **必失败**：bridge 不返回 `initialHistory`（`:316-328`），热路径的 `history()` 是空页（`:400-414`） |
| fork | 会话树「从这里分叉」（`SessionTreeDialog.tsx:128`）→ `CHAT_FORK_SESSION`（`chat.ts:874-889`，`requireIndexedPiSession`）→ `forkSession`（`WorkerManager.ts:1745-1969`） | 源槽先发 `worker.fork {logicalSessionId, entryId}`（`:1774-1777`），得到子会话 `sessionFile`；Main 再铸新逻辑 id `session-fork-<uuid>`（`:1797`），目标槽带子会话 `sessionFile` bootstrap（`:1861`） | 源：`worker.fork`，随后 `worker.fork.accept` / `worker.fork.discard`（`:2738-2773`）；目标：`worker.bootstrap` | 目标必须精确打开同一文件（`:1864-1872`）且有 `initialHistory`（`:1873-1879`）；`createForked` 写行 `agent: PI_AGENT`（`:1883-1900`）；`session.created` 同（`:1915`） | **必失败**：bridge `fork/acceptFork/discardFork` 抛 `WORKER_DSH_UNSUPPORTED`（`dshSessionRuntime.ts:445-453`）；会话树本身也是空的（`:416-430`） |
| 崩溃重启 | 宿主退出 → `WorkerSlot` `crashed` → `handleLifecycle`（`WorkerManager.ts:3169-3216`）；Stop 看门狗 10 s 未收尾 → `forceStop`（`:2205-2213`）。两者都 `restartEntry`（`:3240-3379`） | 同一逻辑 id + `entry.sessionFile`（身份未提交且文件不在时 `fresh`，新建会话，`:3277-3279`），`generation + 1`，沿用上次 bootstrap 的 model / effort（`:3297-3304`） | `worker.bootstrap`，同恢复 | 同键（`:3336-3342`）；**必须有 `initialHistory`**（`:3343-3349`）；`ensureIdentityCommitted` + `commitPiLeaf`（`:3354-3359`，不在 try 里单独兜）；预算 60 s 内 2 次（`:3254-3265`） | **必失败**：缺 `initialHistory`；而且即使补上，`commitPiLeaf` 也会因为行 agent 不是 `pi` 而抛错（见 2.3） |

### 1.3 「会产生新分支」的入口辨析

- v1.0.3 的分支栏是 **git 分支**切换（`src/renderer/components/chat/BranchColumn.tsx:16-37`，`git checkout`），与会话无关，不拉 WorkerSlot。
- 重试上一轮：同一槽上 `worker.send`，`mode: 'retry'`（`WorkerManager.ts:1993-2001` → `startTurn` `:2003-2069`；渲染层 `ChatComposer.tsx:2141-2149`）。pi 在文件内把失败回复留在旁支，不产生新会话。
- 回退（「回到这里」）：同一槽上 `worker.rewind`（`WorkerManager.ts:1551-1635`；`SessionTreeDialog.tsx:107`），也是文件内分支。
- 只有 fork 产生新逻辑会话和新 WorkerSlot。
- DSH 会话日志是线性的，没有 rewind，也没有会话内分支（`dsh-commands`、`dsh-session` 里查不到 rewind）。P1-4 要为「重试」「回退」设计映射，可选做法之一是种子子会话加桩改指向（见方案 D2）。

## 2 会话索引与 agent

### 2.1 行结构

`<userData>/session-index.json`，裸 JSON 数组（`SessionIndexService.ts:17`、`:95`；形状由 `agentWireStatic.test.ts:968-983` 钉住）。行 = `SessionIndexEntry`（`src/shared/types/sessionIndex.ts:46-95`）：`sessionId`、`runtimeIdentity?`（对 Main 是不透明的恢复句柄，现在是 pi JSONL 或 DSH 桩的路径）、`piLeaf?`、`legacyImport?`、`agent?`（磁盘侧故意是 `string`，未知值原样保留，`:61-70`）、`unbound?`、`workspacePath`、`title`、`model?`、`updatedAt`、`archived`。

### 2.2 agent 写入点

| 位置 | 写什么 | 说明 |
|---|---|---|
| `chat.ts:319`（新建）、`:422`（仅登记） | `PI_AGENT` | 经 `recordCreated`（`SessionIndexService.ts:211-244`，`agent: input.agent ?? existing?.agent`） |
| `WorkerManager.ts:947`、`:1079`、`:1915`（`session.created`），`:2864`（`session.resumed`） | `PI_AGENT` | 事件经 `applyRuntimeEvent` 落行（`SessionIndexService.ts:539-556`），渲染层同时写 `ChatSession.agent`（`chatSessions.ts:1135-1146`） |
| `WorkerManager.ts:1887` | `PI_AGENT` | fork 行，经 `createForked` → `createIndependent`（`SessionIndexService.ts:362-424`） |
| `SessionIndexService.ts:316` | 字面量 `'pi'` | `commitResumed` 每次恢复都把行 agent 改写成 `pi` |
| `LegacyImportService.ts:386`、`piTui.ts:195` | `PI_AGENT` | 导入的会话、TUI 里新建后被收编的会话 |
| `NativeSessionIndexAdapter.ts:91/114/136/220` | 字面量 `'pi'` | 只有测试在用（生产无 import），P1-12 清理 |

### 2.3 agent 读取与守卫点

| 位置 | 规则 |
|---|---|
| `chat.ts:124-132` `assertPiCompatibleIndexRow` | 新建 / 登记：已有行且不是 pi → `pi_session_agent_mismatch` |
| `chat.ts:186-199` `reloadSessionFromDisk` | 非 pi 直接 `false`（TUI 交接用） |
| `chat.ts:257-268` `requireIndexedPiSession` | compact / 会话树 / rewind / fork / 只读预览：无身份 → `pi_session_not_found`；非 pi → `pi_session_agent_mismatch` |
| `chat.ts:464-468` | 恢复：非 pi → `pi_session_agent_mismatch` |
| `SessionIndexService.ts:343` | `commitPiLeaf` 要求 `agent === 'pi'`，否则抛错；`restartEntry` 直接 await（`WorkerManager.ts:3355`），turn 结束的 `syncLeafCheckpoint` 在 leaf 不变时不会调到它（`:3476-3481`） |
| `SessionIndexService.ts:383` | `removeImported` 要求 `pi`（导入专用，P1-1 不动） |
| `sessionIndexMerge.ts:108-116` | `resolveAgentWireName` 为 null 的行在侧栏隐藏（显式 `claude-code` / `codex` 另记 seen） |
| `resumeIntent.ts:105-107` | 渲染层：有 agent 且不是 pi → `unsupported-agent:<x>` |
| `chatSessionActions.ts:169` | fork 行物化：非 pi 拒绝；`:208` 物化时写 `PI_AGENT` |

### 2.4 `AGENT_WIRE_NAMES` 与相关导出

定义在 `src/shared/types/agentWire.ts`：`AGENT_WIRE_NAMES = ['pi']`（`:13`，文件头注明是 ABI，只能追加，`:7-9`）、`AGENT_DISPLAY_NAMES`（`:18-20`）、`PI_AGENT`（`:23`）、`isAgentWireName`（`:25-27`）、`resolveAgentWireName`（`:36-38`，未知与缺失都返回 null）、`sessionAgent`（`:41-43`，缺省 pi；生产代码无调用者，只在注释和测试里出现）。类型 `AgentWireName` 用于 `runtimeEvents.ts:860`（created / resumed payload）、`:913`（history payload）、`chatSessions.ts:138`。生产使用者即 2.2、2.3 两表所列文件。

### 2.5 钉住 `'pi'` / `PI_AGENT` 的测试（按文件，`rg -a` 计数）

`SessionIndexService.test.ts` 18、`agentBindingMerge.test.ts` 12、`chatPiWorkerRouting.test.ts` 10（`:976-985` 对 `codex` 行期待 `pi_session_agent_mismatch`）、`chatSessionActions.test.ts` 5、`historyError.test.ts` 5、`sessionIndexMutations.test.ts` 4、`WorkerManager.test.ts` 4（`:480`、`:664`、`:1301`、`:1570`）、`terminalCreatedSessions.test.ts` 2、`sessionIndexMerge.test.ts` 2、`resumeIntent.test.ts` 2、`chatReadSessionPage.test.ts` 2、`NativeSessionIndexAdapter.test.ts` 2、`agentWireStatic.test.ts` / `nativeStreamReplay.test.ts` / `chatSessionsSendGuard.test.ts` / `sendDispatchError.test.ts` / `LegacyImportService.test.ts` / `piTuiHandover.test.ts` 各 1。其中导入、TUI、回放录制、只读预览这几类在 P1-1 后仍应是 `pi`，不要一刀切替换。

## 3 静态守卫测试与它们钉住的字面量

用 `find` 按名字（`*Static*`、`*Wiring*`、`*Absence*`、`*Guard*`）穷举后，再 `rg -a` 查「读源码文件且涉及 P1-1 要动的文件」的测试。

| 测试 | 钉住的内容 | P1-1 影响 |
|---|---|---|
| `src/shared/types/__tests__/agentWireStatic.test.ts` | `AGENT_WIRE_NAMES` 恰为 `['pi']`、显示名键一致（`:870-879`）；`sessionAgent({})` → `pi`（`:1010-1013`）；`resolveAgentWireName` 拒 `claude-code` / `codex` / `gemini` / `claude`（`:1000-1008`）；全树 AST 扫描禁止对 agent 读值写字面量缺省（`x.agent ?? 'dsh'` 也会被抓，`:627-641`、规则 `:419-448`）；`'claude-code'` 只能出现在 provider 轴；三张表模块互不引用；`session-index.json` 裸数组的 4 段代码原文（`:968-983`） | 改前两项断言；新代码只用常量或 `sessionAgent()`；扫描范围含 `src/dsh-host`（不含其 `node_modules`） |
| `src/main/services/agent-host/__tests__/t31PiOnlyAbsence.test.ts` | Claude / Codex 文件不存在（`:8-34`）；agent-host 依赖含 `@earendil-works/pi-coding-agent`、`@gotgenes/pi-permission-system`（`:43-58`）；IPC 名 `PI_RUNTIME_CHECK`、`CHAT_LIST_PI_MODELS`、`CHAT_RESPOND_PERMISSION`、`CHAT_RESPOND_QUESTION`（`:66-83`）；preload `listPiModels:`；`chat.ts` 不含 `assertModelMatchesAgent`；composer 不含选择器与权限应答（`:93-108`） | 无；P1-12 改 |
| `src/main/services/agent-host/__tests__/retiredSurfaceAbsence.test.ts` | `src`、`scripts` 下所有代码文件（latin1 读，含 `src/dsh-host`）不得出现 `/extension[_-]?ui/i`（`:21-26`、`:54-70`） | 新 bridge 代码避开这个词 |
| `src/main/services/agent-host/__tests__/devDshEngine.test.ts` | 开关门控（`:9-17`）；启动参数 `--expose-internals src/dsh-host/host.ts`、cwd = `<userData>/dsh-home-dev`、环境变量**逐键相等**（`:19-52`）；覆盖项与回退 PATH 上的 `node`（`:54-73`） | 整份改写为新启动器的测试 |
| `src/main/services/terminal/__tests__/t35FinalAbsence.test.ts` | `PiTuiPty.ts` 含 `'pi-coding-agent'`、`'node-runtime'`、`args: [cliPath]`，不含 `--session` / `--continue`（`:108-114`） | 无；P1-11 / P1-12 |
| `src/main/services/piModelConfig/__tests__/nativeCatalog.test.ts` | `WorkerManager.ts` 含 `readModelCatalog: () => resolveNativeModelCatalog()`（`:154-172`） | P1-1 不动这一行；P1-5 改 |
| `src/renderer/components/chat/__tests__/retryLastTurn.test.ts` | 读 `chat.ts` 的 `CHAT_RETRY_LAST_TURN` 处理函数体（`:30`、`:194-196`） | 不动该处理函数即可 |
| `src/main/ipc/__tests__/workerCleanupBudgetStatic.test.ts` | 退出清理预算 > `DEFAULT_DISPOSE_TIMEOUT_MS + DEFAULT_EXIT_TIMEOUT_MS`（3 s + 3 s，`WorkerSlot.ts:93-94`） | 无；P1-3 若改超时要同步 |
| `src/main/services/legacyImport/__tests__/legacyImportStatic.test.ts` | 导入 IPC 名 | 无；P1-9 |
| `src/main/ipc/__tests__/chatPiWorkerRouting.test.ts`（行为测试） | 新建 / 登记写 `pi`；非 pi 行 `pi_session_agent_mismatch` | 按新守卫改写 |

## 4 DSH 侧事实（`0.1.7-rc.2`）

### 4.1 新建、恢复、分叉的 API

- `ctx.agents.create(options)`：`sessionId` 由调用方提供（`dsh-agent/lib/types/index.d.ts:48-100`）；`meta` 可带 `cwd`、`parentSession`、`isSeeded`（`:66-67`）；`seed` 是从 seq 0 起连续的事件，`inheritedEventCount` 是继承前缀长度（`:73`、`:80`）。实现 `dsh-agent-loop/lib/index.js:1836-1857`：`ctx.sessions.prepare(id, …)` → `createStoredSession`（`:1804-1814`）→ 发布时 `appendUnstoredSuffix`（`:1824-1829`）。
- 不给 id 时 store 铸 `session-<n>`，是进程内计数器（`dsh-session/lib/index.js:1640-1645`），不能当持久身份；同 id 已在内存里抛错（`:1646`）。
- `ctx.agents.resume({resumeSessionId, agentOptions})`（`dsh-agent/lib/types/index.d.ts:109-`）：`persistence.open(id, 'write')`（`dsh-agent-loop/lib/index.js:1929`）→ 读全量 → `interruptedTurnClosers` 补收尾 → 重放为种子（`:1912-1960`）。P0-6 实测每次恢复还会追加一个 `session/end-seed`。
- 分叉：`buildForkSeed(events, boundary)`（`dsh-session/lib/index.js:884`）复制到含边界 seq 为止的前缀，并为未收尾的 step / turn 补 `forked` 原因的收尾；`SessionStore.fork(source, boundary, childId)`（`:1847-1858`）只建 store 里的会话（不建 agent、不开持久化句柄）。agent 级分叉 = `agents.create({seed, inheritedEventCount, meta: {cwd, parentSession, isSeeded: true}})`。**支持从任意事件 seq 分叉**；消息 → seq 的映射需要 P1-4 的投影。子代理的上下文继承另有 `dsh-subagent-fork-in-process`（截到最后一个 `turn/end`）。
- 没有 rewind，也没有会话内分支。

### 4.2 存储布局（`$DSH_HOME` 下）

- 会话日志：`sessions/--<归一化 cwd>--/<转义后的 id>/session.v4.jsonl.zstd` + `session.lock`（`dsh-base/cordis.patch.yml:130-133` 的 `root: dshHomePath('sessions')`；`dsh-session-persistence-jsonl/README.md:54-72`；[P0-1 证据](../../evidence/p0-1-host-probe-2026-09-25.md) 第 205 行）。当前格式版本 4（`dsh-session/lib/index.js:56`）；运行时总是选最高代际，**不支持降级**（README `:72`、`:160`）。
- KV 存储（投影缓存等）：`storages/`（base patch `:165-171`）；全文检索默认内存、不开（`:149-153`）。
- profile：`profiles/aiclient/{package.json, cordis.patch.yml, cordis.yml, pnpm-workspace.yaml, node_modules}`（`dsh-app-boot/lib/index.js:466-487`；宿主每次启动都 `initProfile` 并重写 `cordis.yml`，`host.ts:92-101`）。
- 用户层：`cordis.patch.yml`（会叠加到任何 profile，`dsh-app-boot/lib/index.js:1022-1031`）、`.env`（`:3432-3440`）、`.credentials.yaml`（base patch `:105-110` 的注释）、`.anonymous-user-id`（遥测用，行已关）。
- 我方：`aiclient-sessions/<dshId>.dsh.json` 桩（`dshSessionRuntime.ts:138-144`、`:304-314`）。
- 没有删除会话的 API（README `:163`）。

### 4.3 落盘与锁

- 懒落盘：`create(header)` 不写盘，首次 `append` 才写 header 与第一批（README `:76`）。新建会话没有种子，发布时通常没有可追加的内容（`appendUnstoredSuffix`）——所以首个回合开始前 DSH 会话很可能不在盘上（推断；P0-6 被杀时已落盘的事件都是回合内的）。
- 显式固化：`ctx.sessions.flush(session)`（`dsh-session/lib/types/index.d.ts:427-439`，唯一正式入口）→ 持久化层的 `session/flush` 监听（`dsh-session-persistence-jsonl/lib/index.js:413-419`）→ `handle.flush()`，未落盘时只写 header 并取锁（`:124-137`）。
- `create` 时若该 id 已有日志或正在创建，直接抛 `SessionAlreadyExistsError`（`:2438`）。
- 写锁：POSIX 是 `session.lock` 上的 `flock`，Windows 是命名信号量；进程死锁即释放，活着但卡住的持有者会一直挡住（README `:164`）。没有「强制接管」。

### 4.4 错误类（`dsh-session-persistence/lib/index.js`）

`SessionPersistenceNotFoundError`（`:24`；`open` 找不到时抛，jsonl `:2490`、`:2602`）、`SessionAlreadyOwnedError`（`:44`；锁冲突，jsonl `:314`、`:678`、`:693`、`:711`）、`SessionAlreadyExistsError`（jsonl `:300`、`:2438`）。靠 `name` 区分，没有 `code` 字段。

### 4.5 工作目录

会话 header 的 `cwd` 创建时写入、不可变；bash / pwsh / 文件搜索工具（`dsh-tool-bash/lib/index.js:294` 等）、沙箱 `workspaceRoot`（`dsh-sandbox-policy/lib/index.js:145`，`process.cwd()` 只是回退值）、系统提示词的 `cwd` 变量（`dsh-agent-loop/lib/index.js:1551`）都读它。恢复时 Main 传进来的 `cwd` 对 DSH 不起作用。

### 4.6 `DshSessionRuntime` 的 RPC 实现状态（`src/dsh-host/bridge/dshSessionRuntime.ts`）

| 方法 | 状态 |
|---|---|
| `bootstrap` | 新建：`agents.create` + 写桩（`:297-315`）；恢复：读桩 + `agents.resume`（`:288-296`）。不返回 `initialHistory`，`leaf` 恒为空（`:146`、`:316-328`），`capabilities: {}` |
| `startSend` | 只取 `text`（`:353-356`）；**忽略** `mode: 'retry'`（会把空文本当新消息发出）、`attachments`（图片被静默丢掉）、每轮 `model` / `effort` |
| `stop` | `agent.cancel({kind: 'user'})`，由 `turn/end aborted` 收尾（`:368-373`） |
| `respondPermission` | 已接（`:379-384`），只有允许 / 拒绝 |
| `interject` | 恒 `false`（`:375-377`）；`respondQuestion` / `respondPreview` 恒 `false`（`:386-392`） |
| `setPermissions` / `setPermissionGear` / `setPermissionTier` | 空操作（`:394-396`） |
| `history` / `tree` | 合法但为空（`:400-430`）；`commands` 空列表（`:432-434`） |
| `compact` / `rewind` / `reload` / `fork` / `discardFork` / `acceptFork` | 抛 `WORKER_DSH_UNSUPPORTED`（`:436-453`） |
| 导入、一次性补全 | 服务端工厂直接抛错（`bridge.js:54-59`） |

## 5 改动点明细（按文件）

| 文件 | 改什么 | 规模 | 边界 |
|---|---|---|---|
| `src/main/services/agent-host/devDshEngine.ts` → `DshHostProcess.ts` | 去掉门控；`resolveDshHostLayout`（未打包：`out-node-runtime/node` + `src/dsh-host/host.ts`；打包：`resources/node-runtime/node(.exe)` + `resources/dsh-host/host.js`，产物由 P1-2 交付），缺失抛 `DSH_HOST_MISSING`，删「回退 PATH 上的 node」；`resolveDshHome`（`~/.pilab/<profile>/dsh-home`，0700）；覆盖项与网关变量仅未打包生效；`forkDshHost({generation, cwd})` 先查会话 cwd（`WORKER_WORKSPACE_MISSING`） | ~150 行（重写 120 行） | 布局、环境、home 三块 P1-3 复用；每槽一进程的 `forkDshHost` 由 P1-3 换掉 |
| `createPiWorkerSlot.ts` | 默认 transport 固定 `forkDshHost`；删开关 import | ~10 | 与 P1-3 冲突面最小 |
| `src/shared/types/agentWire.ts` | 追加 `'dsh'`、`DSH_AGENT`、显示名；`sessionAgent` 缺省改 DSH；`PI_AGENT` 注释改为「旧会话，只读至 P1-9」 | ~12 | ABI 只追加 |
| `WorkerManager.ts` | 5 处 `agent: PI_AGENT` → `DSH_AGENT`；`commitResumed` 传 agent | ~12 | 状态机、预算、看门狗都不动（P1-3） |
| `SessionIndexService.ts` | `commitResumed` 写传入的 agent（不再写死 `'pi'`）；`commitPiLeaf` 接受 `dsh`；`removeImported` 不动 | ~20 | 保持裸数组 4 段原文 |
| `src/main/ipc/chat.ts` | `requireIndexedPiSession` → 活会话守卫（`dsh`）；新建 / 登记写 `dsh`，允许「无身份的 pi 空行」直接转 DSH；恢复遇有身份的 pi 行抛 `legacy_session_readonly`（D1）；只读预览：pi 行照旧回放，dsh 行直接 `session_replay_unavailable`；`reloadSessionFromDisk` 保持仅 pi | ~50 | 不动 `CHAT_RETRY_LAST_TURN` 函数体 |
| `src/main/services/terminal/piTuiSession.ts`、`src/main/ipc/piTui.ts` | `.dsh.json` 身份一律「不支持」（新 reason），`PI_TUI_OPEN` 同样拒绝 | ~15 | TUI 去留是 P1-11 |
| 渲染层 `resumeIntent.ts`、`chatSessionActions.ts`、`historyError.ts` + 中英文案 | 接受 `dsh`；pi 行 `legacy-readonly` 不发恢复；新错误码映射（`legacy_session_readonly`、`dsh_session_missing` → 找不到文件卡） | ~40 | 不改 `chatSessions.ts` 红线文件 |
| `src/dsh-host/bridge/dshSessionRuntime.ts` | 新建：create → `ctx.sessions.flush` → 原子写桩；恢复：校验桩与 cwd、错误映射、返回空页 `initialHistory`；`mode: 'retry'` 抛 `WORKER_RETRY_UNAVAILABLE`、带附件抛 `WORKER_DSH_UNSUPPORTED`；`createUserMessage` 改为构造参数注入，便于根 vitest 在没装 DSH 包时测 | ~100 | P1-4 只替换 `history()` / `tree()` 的实现与两个安全桩 |
| `src/dsh-host/bundle/lib/bridge.js` | `inject` 加 `sessions`；传入 `createUserMessage` | ~5 | — |
| `src/dsh-host/bridge-smoke.ts` | 加三个场景：新建后磁盘上已有会话目录；换一个宿主用桩恢复并跑一轮；SIGKILL 后重启恢复 | ~100 | 录制门禁是 P1-4 |

合计：产品代码约 400～500 行（含 smoke 扩展），测试约 600～800 行，约 1 人周（粗估）。

## 6 单测用例清单

- `DshHostProcess.test.ts`（替换 `devDshEngine.test.ts`）：未打包 / 打包 × posix / win32 的布局；缺 node 或入口 → `DSH_HOST_MISSING`；环境白名单逐键（不含 `ANTHROPIC_*`、`OPENAI_*`）；`DSH_HOME` 缺省在应用状态根下；打包态忽略 `AICLIENT_DSH_*` 覆盖；工作区不存在 → `WORKER_WORKSPACE_MISSING`；与 `AICLIENT_DEV_ENGINE` 取值无关。
- `createPiWorkerSlot.test.ts` 新增：`vi.mock('../DshHostProcess')`、`vi.mock('../PiWorkerProcess')`（调用即失败），不注入 `createTransport` 时只调 `forkDshHost`；`app.isPackaged` 真假两种都一样。
- `WorkerManager.test.ts` 新 describe「P1-1 四条路径走 DSH」，复用现成 harness（`createSlot` 桩记录 options，`records[i].crash()`，`events`，`commitResumed` / `commitPiLeaf` / `createForked` 桩）：
  - 新建：`createSlot` 无 `sessionFile`；`session.created.payload.agent === 'dsh'`；`bindRuntimeIdentity` 收到桩路径。
  - 恢复：`createSlot.sessionFile` = 桩；`session.resumed` 带 `dsh`；`commitResumed` 收到 `agent: 'dsh'`。
  - fork：源 `worker.fork` 返回子桩；目标 `createSlot.sessionFile` = 子桩；`createForked` 行 `agent: 'dsh'`；`session.created` 带 `dsh`。
  - 崩溃重启：`crash()` 后第二次 `createSlot` 带同一桩、`generation: 2`；`commitPiLeaf` 被调用且不抛；`session.resumed` 为 refresh。Stop 看门狗强制重启（仿 `[T144-wm-04]`，`:3207`）同样走 `createSlot`。
  - 现有 `:480`、`:664`、`:1301`、`:1570` 的 `agent: 'pi'` 断言改为 `dsh`。
- 新静态守卫 `chatEngineDshOnly.test.ts`：`createPiWorkerSlot.ts` 不含 `forkPiWorkerProcess`、`AICLIENT_DEV_ENGINE`、`isPackaged`；`WorkerManager.ts` 恰有 4 处 `spawnForEntry(` 调用、不含 `PI_AGENT`；`src` 下不再出现 `devDshEngine`。
- `SessionIndexService.test.ts`：`commitResumed` 写 `dsh` 且不改写既有 `pi` 行；`commitPiLeaf` 接受 `dsh`。
- `chatPiWorkerRouting.test.ts`：新建 / 登记写 `dsh`；dsh 行可恢复；带身份的 pi 行恢复 → `legacy_session_readonly`；无身份 pi 行可新建；只读预览对 pi 行照旧、对 dsh 行回 `session_replay_unavailable`。
- `agentWireStatic.test.ts`：`['pi', 'dsh']`；`sessionAgent({})` → `dsh`。`resumeIntent.test.ts`、`sessionIndexMerge.test.ts`：dsh 行可见可恢复，pi 行只读。`piTuiSession.test.ts`：`.dsh.json` 不支持。
- `src/dsh-host/bridge/__tests__/dshSessionRuntime.test.ts`（新，假 `DshBridgeContext`）：新建时先 flush 再写桩、桩字段完整、原子写；恢复时 `agents.resume` 收到桩里的 id、结果带合法 `initialHistory`（`sessionFile` / `workspacePath` 与请求一致）；NotFound / Owned / cwd 不一致各自的错误码；`mode: 'retry'`、带附件被拒；`fork()` 仍是 `WORKER_DSH_UNSUPPORTED`。能否不装 `src/dsh-host` 依赖就在根 vitest 跑，取决于 `createUserMessage` 注入是否到位（推断）。

## 7 改名、删除后要 `rg -a` 扫的旧标识符

`devDshEngine`、`isDevDshEngineSelected`、`buildDevDshHostLaunch`、`forkDevDshHost`、`DEV_ENGINE_ENV`、`AICLIENT_DEV_ENGINE`、`dsh-home-dev`；以及 `PI_AGENT` 在 `chat.ts`、`WorkerManager.ts`、`chatSessionActions.ts`、`resumeIntent.ts` 里的残留，`pi_session_agent_mismatch` 在测试里的期待。证据文档（P0-3、P1-0）里出现的旧名是历史记录，不改。
