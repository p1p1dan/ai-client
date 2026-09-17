# 批次 D 前置条件说明 — terminal-tui / h-nodes 点验

- 仓库：`/home/ai/code/ai-client`，HEAD `b3d751e3`，分支 `feat/runtime-evolution`
- 方式：只读侦察。没有改代码、没有起 Electron、没有跑测试。运行过的唯一命令是 `pi --help`（打印帮助，无副作用，`handbook.md` §6.2 已示范过同一条）。没有打印任何密钥内容。
- 面向：`docs/plantree/plans/runtime-hardening/checklist-e.md` 里 `terminal-tui` 组第 14～17 项、`h-nodes`/`field-nodes` 组第 30～32 项，以及 `agent-host-lib` 组第 17 项（ah-lib-03）。
- 依赖读过的两份材料：`/tmp/t032/handbook.md` 第 6 节（pi CLI 与内嵌 TUI）、`/tmp/t032/sections/investigate-vllmproxy-catalog.md`（结论：worker 目录来自凭据库 vault；`writeUserProviderRuntimeConfig` 会派生写 `models.json`）。

---

## 1. 内嵌 TUI 用哪个 agent 目录、模型怎么选、假网关能不能用

### 1.1 目录：不是 dev.env 的 `PI_CODING_AGENT_DIR`，是应用自己的 `pi-agent`

- `PiTuiPty.ts` 的 `resolvePiCliLaunchPlan()`（`src/main/services/terminal/PiTuiPty.ts:131-196`）组装 pi CLI 的启动环境，顺序是：
  1. `:163-166` 先把 `inheritedEnv`（即 `process.env`，含 dev.env 灌进来的 `PI_CODING_AGENT_DIR=/home/ai/.pilab/t37c-agent`）整份拷进 `env`；
  2. `:168` `const managedEnv = resolveManagedPiPtyEnv();`
  3. `:176` `Object.assign(env, managedEnv);` —— **后写覆盖先写**，`managedEnv` 里的 `PI_CODING_AGENT_DIR` 会把 dev.env 那份原样盖掉。
- `resolveManagedPiPtyEnv()`（`src/main/services/piModelConfig/index.ts:314-316`）直接返回 `{ ...resolveManagedPiWorkerEnv() }`。
- `resolveManagedPiWorkerEnv()`（同文件 `:275-297`）无条件（两种模式都发）写入：
  ```ts
  PI_CODING_AGENT_DIR: getAppPiAgentDir(),   // index.ts:295
  ```
- `getAppPiAgentDir()`（`index.ts:40-42`）= `join(getAppStateRoot(), PI_MANAGED_AGENT_DIR_NAME)`，`PI_MANAGED_AGENT_DIR_NAME = 'pi-agent'`（`src/shared/piModelConfig.ts:3`）。本机即 `/home/ai/.pilab/jyw-ai-client-dev/pi-agent`——**和 GUI 侧原生 worker 读的是同一个目录**（`getActivePiAgentDir()` 在 `index.ts:119-121` 也是 `return getAppPiAgentDir();`）。

**结论：内嵌 TUI 永远读应用自己 profile 下的 `pi-agent/models.json` + `auth.json`，dev.env 的 `PI_CODING_AGENT_DIR` 对它完全不生效（会被覆盖）。** `index.ts:293-295` 的代码注释自己也写明这是 H/19 之后的行为：「both modes run out of this app's directory」。

### 1.2 `writeUserProviderRuntimeConfig`：何时写、写到哪、什么格式

- 定义：`src/main/services/piModelConfig/index.ts:132-143`。做的事只有一步：
  ```ts
  serviceFor(getAppPiAgentDir()).writeUserProviderConfig({
    userProviders: readUserProvidersForRuntime(),   // 读凭据库 vault
    inheritedApiKey, inheritedBaseUrl,               // 托管半边继承的凭据
  });
  ```
- `writeUserProviderConfig`（`PiModelConfigService.ts:532-543`）转调 `writeRuntimeConfig()`（`:584-...`），后者在 `getAppPiAgentDir()` 下 `mkdirSync(...0o700)` 后，把 `managedHalf()`（托管快照/wire 缓存）+ 用户服务一起序列化，**物理写出两个文件**：`models.json` 与 `auth.json`（这正是 `investigate-vllmproxy-catalog.md` §1.2 表格里「worker 侧接收」上游的那一步，只是这里落的是磁盘文件而不是内存）。
- **触发点只有两处**（都在 src 里 grep 到，无遗漏）：
  1. `src/main/services/userProviders/index.ts:92-98` —— 用户在设置页对 AI 服务做任何增删改，`onChange` 回调触发；
  2. `src/main/services/agentMigration/index.ts:56` —— 跑「迁移」且 `request.kinds.includes('providers')`。
- **反过来，直接手改 `vault.json`（不经过设置页保存）不会触发这次写盘**——`investigate-vllmproxy-catalog.md` 里手改 vault 之后，内存目录（`resolveNativeModelCatalog()`，每次 spawn 都重新读 vault）会立刻感知到，但 `models.json`/`auth.json` 这两个物理文件只有走上面两条路径才会被重写。**这一点对内嵌 TUI 是决定性的**：TUI 是独立的 `pi` 子进程，它不认识 vault、不认识 Main 进程内存，只认 `getAppPiAgentDir()` 下这两份物理文件。

### 1.3 `probe-fake` 服务能不能被 TUI 用来出话

**能，但有前提，且和「让 GUI 用」不是同一条路。**

- 若走「设置页 → AI 服务 → 新增 `probe-fake`（`anthropic-messages`，`baseUrl: http://127.0.0.1:18080`，勾 `fake-sonnet`）→ 保存」：`onChange` 触发 `writeUserProviderRuntimeConfig()`，物理文件被重写，**下一次**（无需重启应用）打开的 pi TUI 子进程读到的就是含 `probe-fake` 的 `models.json`/`auth.json`。
- 若走「直接手改 `vault.json`」（`investigate-vllmproxy-catalog.md` §3.2 的「路 B」）：**只对 GUI 的原生 worker 生效（内存目录直读 vault），对内嵌 TUI 无效**，因为 TUI 不读 vault，而这条路不触发物理文件重写。想让 TUI 用，要么走设置页保存一次，要么**直接手写 `~/.pilab/jyw-ai-client-dev/pi-agent/models.json` + `auth.json` 这两个物理文件**（跳过 vault 和 Main 进程，pi CLI 自己不关心这两个文件是谁写的）。
- **`checkProviderBaseUrl()`**（`src/shared/userProviders.ts:252-265`，`investigate-vllmproxy-catalog.md` 已确认）不拒绝 `127.0.0.1`，所以设置页那条路能保存成功；但保存前必须 `Fetch models` 成功（`GET {baseUrl}/models`，`UserProviderService.ts:173`），假网关要实现这个端点，否则界面报错阻止保存。手写物理文件这条路没有这个门槛。
- 物理文件写好后，**还差「选中这个模型」一步**——见下一条。

### 1.4 pi CLI 怎么选默认模型；`PiTuiPty` 传了什么

- **`PiTuiPty` 从不传 `--model`**：`buildPiTuiArgs()`（`src/main/services/terminal/piTuiSession.ts:48-51`）只在有 `sessionFile` 时拼 `[cliPath, '--session', file]`，没有就是 `[cliPath]`。`PiTuiPty.ts:283` 的实际 spawn 调用直接用这个函数的返回值，没有任何模型相关参数。`pi --help` 实测（本次重跑确认）里 `--model <pattern>` 存在，但 `PiTuiPty` 代码路径上完全没有用到它。
- pi CLI 自己（`node_modules/@earendil-works/pi-coding-agent/dist/main.js:346-396` `buildSessionOptions`）选模型的顺序：
  1. `parsed.model`（CLI 参数）——本仓从不传，恒为空；
  2. **有既存会话时**（`--session <file>` 打开、且文件里已有消息）：`hasExistingSession=true`，`main.js:376` 的 `if (!options.model && scopedModels.length > 0 && !hasExistingSession)` 分支被跳过——**模型来自会话文件自身记录的最后一次 `model_change`/消息 `provider+model`**，不看 CLI 参数也不看 pi 自己的默认设置（细节见本节 §6 与 `session-manager.js:148-160`）；
  3. **全新会话**（无 `--session`，或 `--session` 指向不存在的文件）：`hasExistingSession=false`，若给了 `--models`/`enabledModels` 才会进入「savedProvider/savedModel 在 scope 内则用它，否则用 scope 第一个」分支（`main.js:377-395`）；本仓没有传 `--models`，所以这条也不会命中；真正兜底在 `dist/core/sdk.js:96-113` 的 `findInitialModel(...)`，读的是 **pi 自己那份 `SettingsManager`**（`settingsManager.getDefaultProvider()`/`getDefaultModel()`）——这是 pi CLI 自己的设置文件（在 `getAppPiAgentDir()` 下，与 ai-client 的 `settings.json`是两个不同的文件，**未在本次侦察中定位其确切文件名，标注未实测**），不是 ai-client 的 `~/.pilab/<profile>/settings.json`。
- **所以：仅仅把 `probe-fake` 写进 `models.json`/`auth.json` 还不够让「新开一个 TUI」自动用它**——除非（a）pi 自己的默认 provider/model 恰好就是 `probe-fake/fake-sonnet`（需要在 TUI 里手动 `/model` 选一次，pi 自己会记住这个默认），或（b）**打开的是一个已有会话**，且该会话最后记录的模型就是 `probe-fake/fake-sonnet`（构造方法见本文件第 6 节）。两条路都要求「先让 pi 认识这个 provider（物理文件已写）」+「再让某次会话/设置指向它」。

---

## 2. 检查单第 14 项 —— TUI 模式下切换会话（`terminal-03`）

**代码结论：T048（`8dd1b65d`）之前是「全应用一个终端 id」，之后是「每个聊天一个终端 id」，旧行为在注释里被明确记录为一个已修的 bug。**

- `usePresentationSwitch.ts` 的 `tuiTerminalIds`（`src/renderer/components/chat/usePresentationSwitch.ts:74`）是 `Record<sessionId, terminalId>`，注释原文（`:41-47`）：
  > 「this used to be one id for the whole app run. Switching chats inside terminal mode then left the previous chat's `pi --session` on screen while every label said otherwise, and everything typed went into the previous chat's JSONL.」
- 当前行为链路：
  1. `ChatWorkspace.tsx:211-234` 按 `presentationMode==='tui' && effectiveCwd` 决定是否显示终端区；再按 `tuiTerminalId`（当前 `activeSessionId` 对应的那个 id，来自上面的 map）分两种情况：有 id 就渲染 `<AgentTerminal id={tuiTerminalId} sessionFile={activeSession?.runtimeIdentity} isActive ... />`；没有 id 就显示「Start Pi TUI」按钮，**不会自动开**。
  2. `useXterm.ts` 里两处依赖 `piTuiTerminalId`（即 `id` prop）的 effect：
     - `:861-897`「Cleanup on unmount」的依赖数组是 `[piTuiTerminalId]`（`:897`），所以 **`id` 变化本身就会先跑一次清理**：`:872-878` 对旧 id 调用 `window.electronAPI.piTui.suspend(piTuiTerminalId)`（挂起，不是杀掉）、重置 `hasBeenActivatedRef`；
     - 清理完之后「激活」effect（`:838-848`）因 `hasBeenActivatedRef` 被重置而重新触发 `initTerminal()`，走到 `:751-766` 的 `piTuiTerminalId` 分支，用**新** id + 新会话的 `sessionFile` 调 `window.electronAPI.piTui.open(...)`。
  3. Main 侧 `PiTuiPtyController#openExclusive`（`PiTuiPty.ts:246-...`）收到新 open 请求：若这个新 terminalId 在 `#live` 里已存在（此前该聊天开过 TUI、被挂起过），直接 resume 并重放 `replayBuffer`；若不存在，才会真正 spawn 一个新的 `pi --session <新会话文件>` 进程。
- **实际观感**：切到另一个聊天，终端画面会换成那个聊天自己的 PTY（挂起的复用，没开过的显示「Start Pi TUI」按钮，需要用户再点一次）；旧聊天的 PTY 进程**没有被杀**，只是被挂起（parked），继续留在 Main 的 `#live` map 里占用 `DEFAULT_MAX_LIVE_TERMINALS = 2`（`PiTuiPty.ts:21`）个名额之一，超额会被 `#reserveCapacity()`（`:427-441`）按最久未用挑一个挂起的杀掉。**在终端里敲的字必落进当前 `id` 绑定的那个会话 JSONL**，因为 `terminal.onData` 直接用闭包里的 `piTuiTerminalId` 转发（`useXterm.ts:802-806`）。
- T048 还顺带加了 `PI_TUI_SESSION_MISMATCH_REASON`（`PiTuiPty.ts:40-42`）：如果 open 请求的 `terminalId` 命中了一个仍存活、但 `sessionKey` 不同的 PTY，直接拒绝（`:256-262`），防止「同一个 terminalId 被要求服务另一个聊天」这类错配——这是 T048 diff 里新增的防御，配合按聊天分配 id 一起生效。

---

## 3. 检查单第 15 项 —— 终端复活丢 sessionFile（`terminal-04`）

**代码结论：复活（重新 open 同一个 terminalId）分两条路径，只有一条会带 `--session`；「pi 快速失败」会把它推向不带 `--session` 的那条。**

- 「复活」在代码里对应 `useXterm.ts:971-995` 那个 effect（注释自称「Keep inactive embedded Pi terminals parked. Re-opening the same terminalId promotes the existing PTY」），当 `isActive` 从 false 变 true 时调用：
  ```ts
  window.electronAPI.piTui.open({
    terminalId: piTuiTerminalId,
    cwd, cols, rows,
    ...(piTuiSessionFile ? { sessionFile: piTuiSessionFile } : {}),   // :992
  })
  ```
  **`sessionFile` 始终是从 React 的 `piTuiSessionFile` 参数原样带上的**（对应 `activeSession?.runtimeIdentity`，`ChatWorkspace.tsx:220-222`）——这是**渲染层自己记得**要续哪个会话，不依赖 Main 侧的任何状态。
- 到了 Main 侧 `PiTuiPtyController#openExclusive`（`PiTuiPty.ts:246-282`）：
  - **情形 A：`terminalId` 命中的 PTY 还活着**（pi 没有快速退出，只是被挂起）——`current` 非空分支（`:249-269`），走 resume，**这条路 argv 早就定了（进程还在跑），不会重新 spawn，不存在「argv 里有没有 `--session`」的问题**。
  - **情形 B：`terminalId` 对应的 PTY 已经不在 `#live` 里**（这正是「pi 快速失败」的后果：上次 spawn 的 pi 进程读到坏配置后很快退出，`pty.onExit`（`:308-323`）触发，`this.#live.delete(request.terminalId)` 把它从表里摘掉）——`current` 为 `undefined`，代码直接落到 `:271` 往后的「新建」分支：
    ```ts
    const pty = this.#spawn(launch.nodePath, buildPiTuiArgs(launch.cliPath, request.sessionFile), {...});
    ```
    **这里的 `request.sessionFile` 就是渲染层这次 open 调用传来的那个值**——如果渲染层这次的 open 请求（`:992` 那处）**因为某种原因没带上 `sessionFile`**，`buildPiTuiArgs(cliPath, undefined)` 就会返回 `[cliPath]`（`piTuiSession.ts:48-51` 的三元），**argv 里确实没有 `--session`，pi 会开出一个全新的空白会话**——这正是 terminal-04 / 检查单第 15 项要验的现象。
- **useXterm.ts 里专门写了这条陷阱的注释**（`:987-992`）：
  > 「terminal-04: the same session the first open named. Without it, an open that misses the parked PTY (pi failed on startup, capacity evicted it, something else disposed it) falls into Main's "new terminal" branch and starts a blank pi bound to no chat」
  也就是说，**代码本身已经把 `sessionFile` 一直带着（防御已经在），只要 `activeSession?.runtimeIdentity` 在触发复活的那一刻确实有值**，argv 就应该带 `--session`；点验要验的是「这个值会不会在某些时序下丢」（比如会话还没绑定过 runtime，`runtimeIdentity` 本来就是 `undefined`，见 `ChatWorkspace.tsx:217-222` 的注释「Absent until the first send has bound a runtime」——这种情况下「没有 `--session`」是设计内行为，不是缺陷）。
- **怎样让 pi 快速失败**（供点验用，读代码得出，未实测）：
  - 把 `~/.pilab/jyw-ai-client-dev/pi-agent/models.json` 改成非法 JSON，或者把它唯一 provider 的 `baseUrl`/`api` 改成 pi CLI 解析不了的形状——pi 自己的 `ModelRuntime.create({ authPath, modelsPath })`（`sdk.js:72`）在启动阶段读这两个文件，格式错误大概率在 pi 自己的启动流程里同步抛出，TUI 进程会在 PTY 刚建立、几乎没有输出的情况下退出。
  - 或者更贴近「让 --model 指向不存在的 provider」的字面意思：由于 `PiTuiPty` 从不传 `--model`（第 1.4 节已确认），这条思路本身在本仓不成立——真正可控的「快速失败」旋钮是改坏 `models.json`/`auth.json` 本身，而不是命令行参数。
  - Main 日志与 `ps` 的验证方法与检查单一致：`ps aux | grep -- '--session'` 数 argv 里带 `--session` 的 `pi` 进程数量和路径；Main 侧 `console.warn` 在 `PiTuiPty.ts` 里没有专门给「快速退出」打点，主要靠 `pty.onExit` 触发的 `PI_TUI_EXIT` IPC（渲染层 `handleTuiExit`，`usePresentationSwitch.ts:215-241`）间接观察——这条路径会强制切回 GUI 并 `reloadSession`，与「复活」是两个不同分支，点验时注意区分「进程退出（exit 事件）」和「复活（重新 open 同一个 terminalId）」不是同一次触发。

---

## 4. 检查单第 16 项 —— 两个窗口对同一会话开终端

### 4.1 第二个窗口怎么开

- 菜单 `File → New Window`（`Cmd/Ctrl+N`），定义在 `src/main/services/MenuBuilder.ts:56-60`，`click: () => options.onNewWindow?.()`。
- `onNewWindow` 绑定到 `handleNewWindow`（`src/main/index.ts:789-791`）：
  ```ts
  const handleNewWindow = () => { openLocalWindow({ isDark: getInitialWindowIsDark() }); };
  ```
  即再开一个 `BrowserWindow`。两个窗口的会话列表、`session-index.json` 都来自同一个 Main 进程/同一份磁盘状态，所以第二个窗口的侧栏能看到和第一个窗口一样的聊天列表，可以选中同一个聊天。

### 4.2 `PiTuiExclusiveGuard` 的互斥键，以及为什么它挡不住两个窗口

- `sessionGuard`（`PiTuiExclusiveGuard` 实例）是 **`piTui.ts` 模块级单例**（`src/main/ipc/piTui.ts:23`），**进程全局，不分窗口**；它的键是**归一化后的会话文件路径**（`normalizeSessionKey()`，`piTuiSession.ts:32-38`，处理大小写、末尾斜杠、macOS `/private` 前缀）。
- 但 `PiTuiPtyController`（真正持有 PTY 进程的对象）是 **按 `windowId` 分开的**：`const controllers = new Map<number, PiTuiPtyController>();`（`piTui.ts:43`），`controllerFor()`（`:86-107`）按 `BrowserWindow.fromWebContents(sender).id` 取或建。**两个窗口 = 两个独立的 controller 实例，各自的 `#live` map 互不知晓对方。**
- `PI_TUI_OPEN` handler（`piTui.ts:145-176`）对同一 `sessionFile` 的第二次请求做的事：
  1. `inspectPiTuiSessionSupport` 格式检查（通过）；
  2. `hasRunningTurn` 检查是否有 worker 正在写这个文件（若没有正在跑的 GUI 回合，通过）；
  3. `sessionGuard.transferTo(request.sessionFile)`（`:168`）——**这是「转移」不是「测试并占用」**，注释原文（`piTuiSession.ts:79-85`）明确说「Always transfer, never test-and-set」「switching sessions must always be able to take ownership; the writer conflict is prevented by disposing the previous terminal, not by refusing the new one」——**但这句注释里说的「disposing the previous terminal」在跨窗口场景下根本没有发生**：`transferTo` 只是把 `#ownerKey` 从「已经是这个 key」改成「还是这个 key」（值不变），**它不会去调用另一个窗口那个 controller 的 `disposeSession()`**；真正会调用 `disposeSession` 的只有 `releaseSessionForHostPrompt()`（`piTui.ts:240-263`），而这个函数只在 **GUI 发送消息前的 `handOverFromTui`**（`chat.ts:125-146`）里被调用，PI_TUI_OPEN 这条路径完全不碰它。
  4. 于是直接 `return controller.open(request);`（`:175`，`controller` 是第二个窗口自己的、全新的 `PiTuiPtyController`），走到 `#openExclusive`，因为这个 controller 的 `#live` 里没有这个新 `terminalId`（第二个窗口的渲染层会自己生成一个新的 `pi-tui-${crypto.randomUUID()}`，`usePresentationSwitch.ts:120-124`），**直接落入「新建」分支，spawn 出第二个 `pi --session <同一文件>` 进程。**
- **交叉验证：pi CLI 自己的 `SessionManager` 没有文件锁**——扫过 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` 全文件，`proper-lockfile` 只用在 `auth-storage.js` / `settings-manager.js` / `trust-manager.js`，唯独 session 文件本身没有加锁逻辑；而本仓自己的 `writer.lock` sidecar 机制（`src/runtime/plugins/session/writerLock.ts`）明确「the pi CLI never takes the worker's writer lock」（`piTui.ts:121` 注释原文）。

**结论（代码可验证，非猜测）：预期第二个窗口选中同一个聊天点 TUI，会真的 spawn 出第二个 `pi --session <同一文件>` 进程，与第一个窗口的进程并存，两者都能各自往同一份 JSONL 追加内容——`ps aux | grep -- '--session'` 应该能同时看到两条指向同一文件的记录。这是当前代码路径下的真实行为，不是需要「猜」的未知项；检查单第 16 项的点验是去实测确认这个从代码读出的预期，以及是否有游戏内提示/报错（目前代码里没有找到任何针对「另一个窗口已经开着同一份会话」的显式拦截或提示）。**

---

## 5. 检查单第 30 / 31 项 —— TUI-1/H-20 真机一圈、H-19 验证案例 7

### 5.1 会话文件头一行的 v3/v4 interop 由谁定义

- 守卫函数：`inspectPiTuiSessionSupport()`（`src/main/services/terminal/piTuiSession.ts:146-173`）。规则（`:159-171`）：
  1. 读文件前 8192 字节，取第一行，`JSON.parse`；
  2. **只有一种情况判定「不支持」**：`record.kind === 'header' && record.version === 4 && record.type !== 'session'`——即「这是一个纯 v4 头、且没有 `type:'session'` 字段」；
  3. 任何解析失败、空文件、非纯 v4 头，一律判定 `supported: true`（宁可放行，不可错误地拦截，注释 `:138-141` 说明这是故意的「宁可让它在 pi 里试」的方向）。
- **为什么现在的会话大多能过**：本仓的会话写入端 `interopHeader()`（`src/runtime/plugins/session/codec.ts:95-101`）在每个新建的 v4 头上**额外**塞了 `type: 'session'` 和 `timestamp`（ISO 字符串）：
  ```ts
  export function interopHeader(header) {
    return { ...header, type: 'session', timestamp: new Date(header.createdAt).toISOString() };
  }
  ```
  写入点：`src/runtime/plugins/session/store.ts:189-196`（`create` 模式）。这样一个头同时满足「本仓自己认的 `kind:'header',version:4`」和「pi 自己的 `SessionManager` 要求的第一行必须是 `{"type":"session",...}`」——这正是 H/20 做的事（`piTuiSession.ts:131` 注释：「Since H/20 the native runtime writes a header carrying BOTH formats」）。
  **只有 H/20 之前写的、且从未被本应用重新打开过一次的旧会话**，才会缺 `type:'session'` 字段，从而被 `inspectPiTuiSessionSupport` 拒绝（提示文案 `PI_TUI_NATIVE_SESSION_REASON`，`piTuiSession.ts:143-144`：「This chat was saved in an older native format. Open it in the app once to upgrade it, then the Pi terminal can open it.」）。
- 调用点：渲染层 `usePresentationSwitch.ts:133-144`（点 TUI 按钮时，`window.electronAPI.piTui.sessionSupport(runtimeIdentity)`）；Main 侧 `PI_TUI_OPEN` handler 里也会**再查一次**（`piTui.ts:154-160`，双重把关，防止绕过按钮直接调 IPC）。

### 5.2 `reloadSessionFromDisk` 的入口与 60 秒预算

- 定义：`src/main/ipc/chat.ts:159-172`。作用是把 TUI 追加过的内容重新灌回 GUI 正在跑的那个 worker 的内存状态（同文件注释 `:148-157`：「pi's SessionManager caches the file at open, so the worker would otherwise keep the pre-handover leaf」）。
- **两个调用入口**：
  1. `handOverFromTui()`（`:125-146`，第 145 行 `if (terminalWrote) await reloadSessionFromDisk(...)`）——GUI 侧发消息/压缩/rewind 前的收权流程会经过这里；
  2. **回到 GUI 视图这个动作本身**：`usePresentationSwitch.ts` 的 `openGui`（`:175-203`，`:184` 直接 `await window.electronAPI.chat.reloadSession({ sessionId })`）和 `handleTuiExit`（`:215-241`，`:226-227` 同样调用 `chat.reloadSession`）——**这是检查单第 30/31 项「回 GUI」那一步真正打的入口**，`chat.reloadSession` 的 preload/IPC 最终落到 `WorkerManager.reloadSession()`。
- **60 秒预算**：`WorkerManager.reloadSession()`（`src/main/services/agent-host/WorkerManager.ts:1553-1641`）对 `worker.reload` 请求显式传：
  ```ts
  { timeoutMs: BOOTSTRAP_REQUEST_TIMEOUT_MS }   // :1584
  ```
  `BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000`，定义在 `src/main/services/agent-host/createPiWorkerSlot.ts:57`。代码注释（`WorkerManager.ts:1579-1583`）解释原因：「Reload rebuilds the whole plugin graph, MCP handshakes included — the same work `worker.bootstrap` does, and it gets the same budget. On the warm 10s default a user with one stdio MCP server could lose a healthy session to the handover.」——即 reload 和冷启动共用同一条 60 秒预算，而不是走更短的「热路径」超时。

---

## 6. 检查单第 32 项 —— H/21 内嵌 TUI 模型缺失覆盖层

### 6.1 「模型已被迁移覆盖」的会话长什么样

- **会话里模型是怎么记的**：本仓的 v4 编解码器接受一种条目类型 `model_change`，校验规则在 `src/runtime/plugins/session/codec.ts:211-213`：
  ```ts
  case 'model_change':
    if (typeof value.provider !== 'string' || typeof value.modelId !== 'string')
      invalid('invalid model change');
  ```
  即条目形状是 `{ type: 'model_change', provider: string, modelId: string, ... }`。这个形状和 pi CLI 自己的 `SessionManager`（`dist/core/session-manager.js:148-160`）读取「当前模型」的逻辑**完全对齐**：
  ```js
  else if (entry.type === "model_change") { model = { provider: entry.provider, modelId: entry.modelId }; }
  else if (/* assistant message */) { model = { provider: entry.message.provider, modelId: entry.message.model }; }
  ```
  即 pi CLI 沿着当前分支往回找，**最后一条 `model_change` 条目或者最后一条助手消息里的 `provider`/`model` 字段**，就是它认定的「这个会话的模型」。
- **「模型缺失」的判定时机不是打开会话时立刻查表，而是真正尝试解析/使用模型时才发现查不到**：
  - **原生 worker（GUI）侧**：`src/runtime/worker/nativeUtility.ts:167` / `:186` 抛 `PiWorkerSessionError('WORKER_MODEL_NOT_FOUND', 'Pi model not found: <ref>')`，被渲染层 `modelMissingError.ts` 的 `isModelMissingError()`（`:34-37`，匹配 `WORKER_MODEL_NOT_FOUND` 或子串 `Pi model not found`）识别。
  - **pi CLI（TUI）侧**：`dist/core/sdk.js:85-113`（`createAgentSession` 的模型解析段）：
    ```js
    if (!model && hasExistingSession && existingSession.model) {
      const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
      if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) model = restoredModel;
      if (!model) modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
    }
    if (!model) {
      const result = await findInitialModel({ ...settingsManager 默认值... });
      model = result.model;
      if (!model) modelFallbackMessage = formatNoModelsAvailableMessage();      // "No models available. ..."
      else if (modelFallbackMessage) modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
    }
    ```
    即：会话记录的 provider/model 在当前 `models.json`/`auth.json` 里找不到（或找到了但没配凭据）时，**pi 自己**先记一句「Could not restore model X/Y」，再尝试用设置里的默认模型/目录里第一个可用模型顶上；如果目录整个是空的，才落到 `formatNoModelsAvailableMessage()`（`dist/core/auth-guidance.js:11-13`：`` `No models available. ${getProviderLoginHelp()}` ``）。这个 `modelFallbackMessage` 经 `AgentSessionRuntime`（`dist/core/agent-session-runtime.js:41-62,118`）一路传到 `main.js:681,756`，**由 pi 自己的交互模式渲染成一条启动提示**——这是 pi-coding-agent 自带的行为，**不是本仓写的代码**，本仓也没有对它做二次包装或翻译。

  **所谓「H/21 内嵌 TUI 侧也给出可读提示」，指的就是这套 pi 自带的 fallback 机制天然存在**（只要目录里还有别的模型可顶替，或者哪怕目录全空也会给出 `formatNoModelsAvailableMessage()` 这句英文提示，而不是裸的堆栈错误）；本仓真正加代码的是 **GUI 侧**（`modelMissingError.ts`，下一小节）。

### 6.2 GUI 侧与 TUI 侧提示位置与文案

**GUI 侧（本仓自己的中文视图，H/21 P0 新增）：**

- 定义：`src/renderer/components/chat/modelMissingError.ts:39-72`（`ModelMissingErrorView`，字段全部是字典 key）。
- 渲染点两处：
  - 历史恢复失败通知：`MessageTimeline.tsx:742-761`；
  - 会话失败卡（发送失败）：`MessageTimeline.tsx:1171-1243`，以及 `ChatComposer.tsx:772-773`。
- 实际中文文案（`src/shared/i18n.ts`）：
  - 标题 `'Model is not available here'` → **`本应用没有这个模型`**（`i18n.ts:2682`）；
  - 正文 `'This chat is pinned to a model this app does not have...'` → **`这个会话记录的模型不在本应用的模型目录里，所以没能把它启动起来。本应用用自己的 agent 目录，你原先在自己的 Pi 目录里配好的 AI 服务不会自动带过来。`**（`i18n.ts:2770-2771`）；
  - 提示 `'Migrate or add the AI service under Settings · Pi...'` → **`到「设置 · Pi」把 AI 服务迁移或补上，这个会话就能继续；也可以在输入框上方改用一个本应用已有的模型。`**（`i18n.ts:2679-2680`）；
  - 按钮 `'Add the model in Pi settings'` → **`去 Pi 设置补上模型`**（`i18n.ts:2637`）。
- 判定依据（`modelMissingError.ts:15-20`）：两个抛出点，一个带 `WORKER_MODEL_NOT_FOUND` 码（`nativeUtility.ts:167,186`），一个是普通 `Error` 被压平成 `WORKER_REQUEST_FAILED`（只能靠消息子串 `Pi model not found` 识别）。

**TUI 侧：** 没有本仓自己的翻译层，就是上面 6.1 提到的 pi 自带英文提示（`Could not restore model X/Y. Using A/B` 或 `No models available. ...`），随 `pi --session <file>` 打开时打印在终端里。**checklist 第 32 项要验的正是「这条 pi 自带提示在内嵌 TUI 的 xterm 视图里能不能正常显示、不被截断/吞掉」**，而不是本仓要另外写一层中文翻译——目前代码库里没有找到任何针对 TUI 内 `modelFallbackMessage` 的二次包装。

### 6.3 最省事的造假会话文件方法

**可以，从现有会话复制改 model 字段是最直接的路径**，两种改法：

1. **改最后一条助手消息**：找会话 JSONL 里最后一条 `role:"assistant"` 的行，把它的 `message.provider` / `message.model`（对应 `session-manager.js:157` 读的字段）改成一个目录里不存在的组合，例如 `"provider":"vllmproxy-old","model":"claude-does-not-exist"`。
2. **追加一条 `model_change` 行**（更贴近「模型曾被切换过」的真实历史）：在文件末尾加一行
   ```json
   {"type":"model_change","id":"<新uuid>","parentId":"<当前最后一条条目的 id>","timestamp":<ms>,"provider":"vllmproxy-old","modelId":"claude-does-not-exist"}
   ```
   `parentId` 必须指向当前分支最后一个条目的 `id`（否则 `codec.ts` 的链校验会拒绝整份文件）。
3. 两种改法都不动头一行（`kind:'header',type:'session'` 那行），所以 5.1 节的 v4/v3 interop 守卫仍然放行，**内嵌 TUI 能正常打开这个文件本身，只是打开后会命中 6.1 节的「restore 失败」分支**。
4. **本机可以直接拿一个真实会话来改**：`handbook.md` §3.4 记录的 `sessions/` 目录（`/home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions/--home-ai-code-ai-client--/`）下的任意一份 `.jsonl` 都可以复制一份再改，不需要凭空手写整份历史。

---

## 7. 检查单第 17 项（`ah-lib-03`）—— 三种恢复失败的错误码与文案

### 7.1 常量

- `MAX_SKIPPED_ROWS = 64`，定义在 `src/runtime/plugins/session/codec.ts:50`，使用点 `:451`：中段一行 JSON 解析失败会被丢弃重写（`decision 006`），但**一旦累计丢弃行数达到 64**，第 65 个坏行触发拒绝：
  ```ts
  if (skipped.length >= MAX_SKIPPED_ROWS)
    invalid(`more than ${MAX_SKIPPED_ROWS} unparseable rows, first at line ${skipped[0].line}`);
  ```
  `invalid()`（`codec.ts:125-127`）抛 `RuntimeHostError('session_invalid', message)`。**检查单描述的「中段插 65 行坏 JSON」正好比 64 多 1 行，精确踩中这个边界。**

### 7.2 三种情形 → 错误码 → 文案键 → 实际中文文案

三种情形到「历史读取错误码」的映射表在 `src/renderer/components/chat/historyError.ts:47-66`（`RESUME_ERROR_CODES`），最终展示文案表在同文件 `:187-305`（`CODE_COPY`）：

| 情形 | 底层触发 | `RESUME_ERROR_CODES` 命中 | `HistoryErrorCode` | 标题（英文 key → 中文） | `retryable` | `continuationHint`（中文） |
|---|---|---|---|---|---|---|
| ① 中段插 65 行坏 JSON，超过 `MAX_SKIPPED_ROWS` | `codec.ts:451-454` 抛 `session_invalid` | `session_invalid: 'session_file_corrupt'`（`historyError.ts:52`） | `session_file_corrupt` | `'Session history is damaged'` → **`会话历史已损坏`**（`i18n.ts:2720`） | `false` | `'Keep the original file for recovery; start a new chat to carry on.'` → **`请保留原文件用于恢复；新建会话后再继续工作。`**（`i18n.ts:2674-2675`） |
| ② 删掉会话文件、保留索引行 | `JsonlSessionStore.open` 的 `realpath`/读文件抛 Node 原生 `ENOENT` | `ENOENT: 'jsonl_not_found'`（`historyError.ts:60`） | `jsonl_not_found` | `'History not found'` → **`未找到历史`**（`i18n.ts:2668`） | `false` | `HISTORY_ERROR_DEAD_SESSION_HINT` = `'This chat cannot continue...'` → **`该会话已无法继续：历史记录缺失后，继续发送会失败；请新建会话继续工作。`**（`i18n.ts:2768-2769`） |
| ③ 把工作区路径改掉 | `store.ts:217-220`：`document.header.cwd !== realpath(config.cwd)` 时抛 `session_cwd_mismatch` | `session_cwd_mismatch: 'session_cwd_mismatch'`（`historyError.ts:51`，两侧同名是巧合，注释 `:48-50` 特意提醒） | `session_cwd_mismatch` | `'Session belongs to another workspace'` → **`该会话属于另一个工作区`**（`i18n.ts:2719`） | `false` | `'Open it from the workspace it belongs to, or start a new chat.'` → **`请从该会话原本的工作区打开，或新建会话继续。`**（`i18n.ts:2688-2689`） |
| （对照）旧的兜底，三次都会看到的错误文案 | 任何未识别错误落到 `read_failed`/`unknown` | — | `read_failed` | `'Failed to read history'` → **`读取历史失败`**（`i18n.ts:2655`） | `true` | `HISTORY_ERROR_NON_FATAL_HINT` = `'The chat is not interrupted...'` → **`会话未中断，可以继续发送消息。`**（`i18n.ts:2745`） |

- 编码/解码函数：`encodePiResumeError()`（`historyError.ts:90-103`，把 `{code, message}` 拼成 `"${code}: ${message}"` 存进 store 的 `historyErrors[sessionId]`）与 `parseHistoryError()`（`:385-403`，渲染层从这个字符串还原回 `HistoryErrorView`）。
- ah-lib-03 这条改造的动机就在 `historyError.ts:32-42` 的注释里写明：三个 `WORKER_SESSION_*` 字符串曾经因为「runtime 接管了会话打开」而失去了生产者，全部落到 `read_failed` 兜底上，`session_file_corrupt`/`session_cwd_mismatch` 曾经是「写了但从未触发」的死分支——这次点验就是要确认它们现在真的能触发、且触发的是各自专属的文案而不是兜底文案。

---

## 附：本次引用的关键文件与行号一览

- `src/main/services/terminal/PiTuiPty.ts`：`resolvePiCliLaunchPlan` `131-196`；`#openExclusive` `246-336`；`PI_TUI_SESSION_MISMATCH_REASON` `40-42`；`DEFAULT_MAX_LIVE_TERMINALS` `21`
- `src/main/services/terminal/piTuiSession.ts`：`buildPiTuiArgs` `48-51`；`PiTuiExclusiveGuard` `60-119`；`inspectPiTuiSessionSupport` `146-173`；`PI_TUI_NATIVE_SESSION_REASON` `143-144`
- `src/main/ipc/piTui.ts`：`sessionGuard`/`controllers` 单例声明 `23,41,43`；`hasRunningTurn` `137-155`（含 concurrency-07 doc `121`）；`PI_TUI_OPEN` handler `145-176`；`releaseSessionForHostPrompt` `240-263`
- `src/main/ipc/chat.ts`：`handOverFromTui` `125-146`；`reloadSessionFromDisk` `159-172`
- `src/main/services/agent-host/WorkerManager.ts`：`reloadSession` `1553-1641`
- `src/main/services/agent-host/createPiWorkerSlot.ts`：`BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000` `57`
- `src/main/services/piModelConfig/index.ts`：`getAppPiAgentDir` `40-42`；`getActivePiAgentDir` `119-121`；`writeUserProviderRuntimeConfig` `132-143`；`resolveManagedPiPtyEnv` `314-316`；`resolveManagedPiWorkerEnv` `275-297`
- `src/main/services/piModelConfig/PiModelConfigService.ts`：`writeUserProviderConfig` `532-543`
- `src/main/services/userProviders/index.ts`：`onChange` 触发点 `92-98`
- `src/main/services/agentMigration/index.ts`：迁移触发点 `56`
- `src/main/services/MenuBuilder.ts`：`New Window` 菜单 `56-60`
- `src/main/index.ts`：`handleNewWindow` `789-791`
- `src/renderer/components/chat/usePresentationSwitch.ts`：`tuiTerminalIds` `74`；`openTui` `95-158`；`openGui` `175-203`；`handleTuiExit` `215-241`
- `src/renderer/hooks/useXterm.ts`：主初始化与 `piTuiTerminalId` 分支 `751-766`；卸载清理（挂起旧终端）`861-897`；复活 effect `971-995`
- `src/renderer/components/chat/ChatWorkspace.tsx`：TUI 渲染分支 `211-234`
- `src/renderer/components/chat/modelMissingError.ts`：全文件（GUI 侧模型缺失视图）
- `src/runtime/plugins/session/codec.ts`：`MAX_SKIPPED_ROWS = 64` `50`；坏行判定 `450-454`；`invalid()` `125-127`；`interopHeader` `95-101`；`model_change` 校验 `211-213`
- `src/runtime/plugins/session/store.ts`：`create` 模式写头 `188-208`；`session_cwd_mismatch` 判定 `217-220`
- `src/renderer/components/chat/historyError.ts`：`RESUME_ERROR_CODES` `47-66`；`CODE_COPY` `187-305`
- `src/shared/i18n.ts`：各中文文案行号见正文表格
- pi-coding-agent 包（`node_modules/@earendil-works/pi-coding-agent/dist/`）：`main.js` `buildSessionOptions 346-426`、模型/会话装配 `560-756`；`core/sdk.js` 模型 fallback `66-114`；`core/session-manager.js` 模型读取 `148-160`；`core/auth-guidance.js` `formatNoModelsAvailableMessage 11-13`
