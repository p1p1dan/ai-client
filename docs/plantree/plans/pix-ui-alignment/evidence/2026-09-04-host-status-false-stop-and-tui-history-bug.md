# Evidence — Host 状态误报「已停止」修复 + TUI↔GUI 历史分叉缺陷记录

**日期**：2026-09-04
**分支**：`feat/pi-primary-backend`
**触发**：用户在 [U12 rev.2](./2026-09-04-u12-rev2-cross-directory-and-terminal-rail.md) 之后的一轮实测
**范围**：第一条**已修**（含测试与变异验证）；第二条**只做记录，未修**，按用户要求

---

## 一、已修：新建会话后误报「Pi session service 已停止」

### 现象

用户报：「启动新建一个会话后提示 pi agent 已停止工作，点击重启重试什么的，但是对话框发消息可以得到回复」。

即横幅说服务停了、还给了 Retry 按钮，而同一个对话框发消息**正常收到回复**。

### 根因

`WorkerManager.updateManagerState()`（`src/main/services/agent-host/WorkerManager.ts`）原本是：

```ts
if (entries.length === 0) this.state = 'stopped';
```

**worker 是懒启动的**——新建会话在第一次发送之前根本没有 entry（U05 起就是这样）。
所以「池子是空的」是一个健康 manager 的**空闲**状态，不是停止状态。
渲染器那侧 `HostStatusBanner` 对 `stopped` 的文案恰恰是「Pi session service 已停止 · 点击 Retry 初始化」，
于是一个完全可用的服务被画成了故障条。会话关闭后池子归零，也会复现同一条横幅。

### 修法

空池**不再改动** state，只有真正停止 manager 的两条路径（`shutdown` / `forceKillAllNow`）
和 `ensureReady` 之前的初始值才是 `stopped`：

```ts
if (entries.some((e) => e.state === 'error' || e.state === 'crashed')) this.state = 'degraded';
else if (entries.length > 0) this.state = 'ready';
else if (this.state === 'degraded') this.state = 'ready'; // 最后一个坏 worker 离开池子
// 空池 + stopped（没启动过）或 ready（空闲）：保持不动
```

「保持不动」而不是「一律 ready」是刻意的：它同时保住了两个方向——从未启动过的 manager 仍报 `stopped`，
已经 shutdown 的 manager 不会因为一次迟到的 dispose 重算而悄悄变回 `ready`。

### 验收

`WorkerManager.test.ts` 新增 `describe('WorkerManager manager-level state')` 3 条：
未 ready 前报 stopped、ready 后空池仍报 ready（会话建了又关也一样）、显式 shutdown 后报 stopped 且不回弹。

**变异验证**：把 `updateManagerState` 改回 `entries.length === 0 → 'stopped'`，
第二条立即失败（`expected 'stopped' to be 'ready'`），另两条仍绿——即这三条里只有一条是真正的回归守卫，其余两条守的是没被改坏的方向。

---

## 二、未修（记录）：TUI 里的对话在切回 GUI 后消失，随后被 GUI 分支覆盖

### 用户复现路径

1. GUI 模式对话若干 → 切到 TUI：**历史正常加载**。
2. 在 TUI 里继续对话。
3. 切回 GUI：**TUI 期间的内容不见了**，只剩切走之前 GUI 的内容。
4. 在 GUI 继续对话：接的是 GUI 里显示的那条，不是 TUI 的最后一条。
5. 再切回 TUI：**TUI 侧也变成 GUI 的版本**——最初那段 TUI 对话彻底不见。

### 代码定位（推断，未跑复现脚本）

两处缺口，合起来正好解释上面五步：

**(a) 切回 GUI 不重载历史。** `ChatWorkspace.tsx` 的 `openGui()` 只做两件事：
dispose TUI 终端、把 `presentationMode` 切回 `gui`。没有任何重新读 JSONL 或请求历史的动作，
所以 GUI 显示的仍是它切走之前留在 store 里的那份 transcript——第 3 步的「消失」是显示层的。

**(b) GUI 的 worker 在 TUI 期间一直活着，并保留着切走前的 leaf。** 打开 TUI 不会关掉这个会话的 worker；
发送路径上的 Q17 处理（`chat.ts` 的 `releaseTuiOwnership` → `piTui.ts` 的 `releaseSessionForHostPrompt`）
只负责**杀掉占用同一个 JSONL 的终端**，让 GUI 拿回写权，并没有让 worker 重新读文件、把 leaf 对齐到 TUI 追加后的文件尾。
于是第 4 步从旧 leaf 续写，在 JSONL 里开出一条**新分支**，TUI 那段被留在旁支上；
第 5 步 TUI 重新打开文件时读到的是新的活动分支，所以「TUI 也同步成 GUI 的了」。

按这个推断，**TUI 那段内容大概率还在 JSONL 文件里**（在一条被抛弃的分支上），不是物理删除。
这一点没有验证过——要确认得去翻 `$PI_CODING_AGENT_DIR/sessions/` 下对应的 `.jsonl`。

### 为什么这不是小事

两个写者（GUI worker 与 pi CLI）共享同一个会话文件，而交接只做了「杀掉另一个写者」这一半，
没有做「回来的一方重新对齐文件状态」那一半。Q17 的注释已经写明 Pi CLI 没有 flush-and-hand-over 握手，
所以杀进程是唯一保证——但**交接回来时的重新加载**是我们这侧可以做的，目前没有做。

### 补充发现：leaf 该以谁为准，代码里已经定好了

`piAgentSessionBootstrap.ts:298` 恢复 leaf 之前套着一道守卫：

```ts
if (currentTail === checkpoint.fileTailEntryId) {
  // 才把会话拨回 GUI 记的 activeEntryId
}
```

即**只有文件尾没变时才恢复 GUI 记的活动分支；文件被外部写者追加过就不拨，让 pi 用文件自身的最新叶子**。
这正是「文件尾说了算」的语义，已经是既定实现——问题只是它在切 TUI 的场景下**没有机会执行**，
因为 worker 全程没重开过文件。所以「leaf 以谁为准」不需要新决策，重开会话即自动生效。

### 「文件是一棵树」——为什么内容在旁支而不是丢了

pi 的 `.jsonl` 每行一个节点，带 `id` / `parentId`（`piSessionTree.ts:9-22`），只追加不改写。
「当前对话」是从活动叶子（`getLeafId()`）沿 `parentId` 回溯到根的那一条链（`getBranch()`）。

```
… → A → B → C
              ├→ D → E   TUI 在 C 之后写的（活动叶子曾是 E）
              └→ F → G   切回 GUI 后 worker 仍以为在 C，又接了一条
```

`D→E` 和 `F→G` 都在同一个文件里，谁也没被删；差别只是活动叶子指向哪条。

---

## 三、已拍板的修法（2026-09-04，用户确认；本次不施工，留待新对话执行）

**照 pix 的 `leaveTerminalMode()` 来做。** 参考实现在
`/home/ai/code/pix/apps/desktop/src/renderer/main.tsx:2929-3014`：

```
enterTerminalMode()   // GUI → TUI
  store.running 为真 → 直接拒绝，提示「等这一轮结束」(contentMode.waitForTurn)，不 kill 也不等待
  否则直接切；PTY 的复用/park 由主进程负责，不在这里 dispose

leaveTerminalMode()   // TUI → GUI
  switchingSessionRef = true; beginSurfaceTransition()   // 过渡态，按住界面
  await terminal.suspend()                               // 挂起 TUI 保温，不是 kill
  const opened = await session.switch(sessionFile)       // ★ 用该文件重新打开会话
  applySessionOpen(opened)                               // 用重载结果替换历史
  requestContentReveal()                                 // 加载完成才揭开界面
  catch → terminal.dispose()                             // 只有重载失败才杀
```

pix 自己的注释：*"Hold chat until the same session has been reloaded from disk."*
因为它**每次离开终端都强制重载**，所以 pix 根本不会产生分叉——我们缺的就是
`session.switch(sessionFile)` 这一步。

### 与上一版设想的两处修正

1. **不再「进 TUI 前关掉 GUI worker」。** pix 不关，只在回合进行中拒绝切换。切回来必然重载已经足够保证正确性，关 worker 是多余开销。
2. **TUI 那侧 suspend 而不是 dispose。** 现在的 `openGui()` 直接 dispose，改成挂起保温，再切回去更快。失败路径才 dispose。

### 施工清单

| # | 位置 | 改动 |
|---|---|---|
| 1 | `ChatWorkspace.tsx` `openGui()`（约 117-121 行）| 改为：进入过渡态 → `piTui.suspend(terminalId)` → **重新打开会话并替换历史** → 揭开界面；失败才 `piTui.dispose` |
| 2 | `ChatWorkspace.tsx` `openTui()`（约 95-115 行）| 回合进行中直接拒绝并提示，不切模式（对齐 pix 的 `running` 检查）|
| 3 | `chat.ts` `releaseTuiOwnership()`（约 123 行）| **pix 没有这条路径、我们有**：终端模式下直接在 GUI 发消息会杀掉 TUI 然后开跑，同样没有重载 → 一样会分叉。杀完之后必须走同一套重载/leaf 对齐 |
| 4 | UI | 切换过程的加载态，别让人以为卡死 |

### 修正三：「重新打开会话」没有现成件，必须新造一条重载原语

上一版把 `useResumeSession()` 列为「重新打开会话 + 加载历史」的现成入口。**这是错的**，照它施工第 1 步会变成空操作：

- `WorkerManager.resumeSession()` 有一条热路径（`WorkerManager.ts:762-804`）：会话的 worker 只要还在且 `ready`，
  它**不重开进程、不读磁盘**，只调 `readHistory()` 把历史重播一遍。
- `readHistory` → `worker.history` → `manager.getBranch()`，读的是 worker 内存里的 `SessionManager`。
  pi 的 `SessionManager` 在 open 时把整个文件读进 `fileEntries` 并建索引，之后 `getBranch()` / `getEntries()`
  **永不再访问磁盘**（`session-manager.js` 的 `_setSessionFile` / `_buildIndex`）。
- `piAgentSessionBootstrap.ts:298` 的 leaf 守卫只在 worker **启动**时执行一次。

而修正一（不在进 TUI 前关 worker）保证了切回来时 worker 必然活着 → 必然走热路径 → **TUI 那段依然不会出现**。

同时纠正一处机制描述：把 leaf 对齐到 TUI 分支的**不是** `:298` 那道守卫。守卫只做消极动作
（文件尾变了就别恢复 GUI 记的旧 leaf）；真正把 leaf 拨到 TUI 最后一条的是 pi 的 `_buildIndex()`——
重读文件时直接把 leaf 设为文件最后一个 entry。语义仍是「文件尾说了算」，但机制要说准。

**修法：走 pi 自己的公开 API `AgentSessionRuntime.switchSession(path)`**
（`agent-session-runtime.js:128`）——在**同一个 worker 进程内**重新 `SessionManager.open()`、
拆掉旧 session、重建 runtime。pix 的 `session.switch()` 背后就是它。

不选「渲染层 close + resume」的理由：那条路每次切换都要整进程重启并重跑权限插件 bootstrap，
且**救不了清单第 3 项**——`releaseTuiOwnership` 在发送处理函数内部执行，在那里关掉 worker 就是把这次发送弄坏。
一条重载原语同时服务两条路径。

新增面（均已核实，不是推断）：

| 位置 | 改动 |
|---|---|
| `piWorkerSession.ts` | 新增 `reload`：校验 sessionFile 一致、streaming 中拒绝、`handle.switchSession(file)`、返回新历史与 leaf |
| `piWorkerSession.ts:1178` | `this.sessionManager` 是缓存引用，switch 后会悬空，必须刷新 |
| `piWorkerSession.ts:577` | 事件订阅绑在旧 session 对象上，switch 后失效；用 `handle.setRebindSession()` 重新订阅（该槽位当前为空，无人占用）|
| `piWorkerRpcServer.ts` | `worker.reload` 分支 + 载荷校验 |
| `WorkerManager.ts` | `reloadSession()`：热 entry 走 RPC，刷新 `leafCheckpoint` 并 `commitResumed` 持久化 piLeaf，以 `'refresh'` 模式发历史三连；无 entry 时回落到既有 resume（冷启动本来就读盘）|
| IPC + preload | `chat.reloadSession(sessionId)`。**不走渲染层的 `useResumeSession`**：`shouldResumeSession` 要求 `workspace.path` 非空，免绑定会话在渲染层的 workspace path 是空串，会被判为 `no-workspace-path`；主进程自己查索引行没有这个缺口 |

### 现成件（不用新造）

- `window.electronAPI.piTui.suspend(terminalId)` — 已在 preload 暴露（`preload/index.ts:476`），IPC 通道 `piTui:suspend`。
- 挂起复用是安全的，且原因是可核实的：`PiTuiPty.suspend`（`PiTuiPty.ts:259`）只置 `suspended` 标记、进程存活并把输出攒进回放缓冲；
  挂起中的终端仍留在 `#live` 里，所以 `disposeSession` 依然杀得掉它——「GUI 要写这个文件之前先杀掉别的写者」这条保证不受挂起影响。
  于是「能被复用的挂起 TUI」与「GUI 写过这个文件」互斥，不会出现反向的分叉。
- `assertHostPromptAllowed()` 目前没有任何调用点，挂起态不会把发送拦住。

### 验收

按用户原始复现路径逐步核对：

1. GUI 对话若干 → 切 TUI，历史正常加载；
2. TUI 里继续对话 → 切回 GUI，**TUI 那段必须在**；
3. GUI 继续对话，**接在 TUI 的最后一条之后**（不是 GUI 的旧位置）；
4. 再切回 TUI，内容连续，没有任何一段消失；
5. 补一条 pix 有的用例：回合进行中点切换，**应被拒绝并提示**，而不是切过去。

### 明确不做

- **已分叉的老会话不做自动补救。** 内容都在文件里（见上面的树图），两条分支都是真实对话，
  谁接谁只能由人判断；用现有会话树（`getSessionTree` / `rewindSession`）可以切过去看。
  本次修复保证的是**不再产生新的分叉**。
- 可选后续（不进第一版）：打开会话时若发现存在比当前分支更新的旁支，在会话树上标记并给一个「切过去」的入口。

**尚未开任务编号。**

---

## 四、落地记录（2026-09-04）

按第三节施工，四项全部落地。核心是新增一条**会话重载原语**，两条会分叉的路径共用它。

### 改了什么

| 层 | 文件 | 改动 |
|---|---|---|
| 类型 | `shared/types/workerRpc.ts` | `WorkerReloadPayload` / `WorkerReloadResult` + 两个守卫 |
| Worker | `piWorkerSession.ts` `reload()` | 校验文件归属 → 取消未决审批 → 断开上一回合的事件订阅 → `handle.switchSession(自己的文件)` → 刷新缓存的 manager → 回传新历史与 leaf |
| Worker | `piAgentSessionBootstrap.ts` | `PiRuntimeHandle` 补 `switchSession` / `setRebindSession`；**注册 rebind 回调重新 `bindExtensions`** |
| RPC | `piWorkerRpcServer.ts` | `worker.reload` 分支与载荷校验 |
| Main | `WorkerManager.reloadSession()` | 热 entry 走 RPC；`branchRevision + 1`；持久化新 leaf；以 `'branch'` 模式发历史；**失败即退休该 worker** |
| Main | `chat.ts` | 新 IPC `chat:reloadSession`（自己查索引取文件）；发送路径在**确实杀掉了终端时**才重载 |
| Main | `piTui.ts` | `releaseSessionForHostPrompt` 改为返回「是否真的杀掉了终端」 |
| 渲染 | `ChatWorkspace.tsx` | `openGui`：suspend → 重载 → 揭开；失败才 dispose。`openTui`：回合进行中拒绝。加载态遮罩 |

### 三处实现细节，理由记下来免得被"简化"掉

1. **rebind 必须注册。** `switchSession` 会换掉 session 对象，审批 UI 还绑在旧的上——不重新 `bindExtensions`，之后每一次权限请求都会石沉大海。pi 自己的 RPC 模式就是用这个槽位做的（`modes/rpc/rpc-mode.js:225`）。
2. **重载失败要退休 worker。** `switchSession` 先拆旧 session 再建新的，中途失败就留下一个没有可用 session 的 worker。留着它等于把下一次发送交给一个坏运行时。
3. **历史用 `'branch'` 而不是 `'refresh'`。** `'refresh'` 走的是 resume 的合并路径（还依赖 resume 快照记账）；重载的语义是"磁盘说了算"，整段替换更贴切也更简单。

### 验证

全仓 **262 files / 4086 tests pass**；`pnpm typecheck`、`pnpm typecheck:agent-host` pass；biome 920 文件干净；`git diff --check` 干净。

新增用例 14 条（worker 4 / WorkerManager 4 / chat IPC 3 / 渲染层接线 5 中的合计，另加 2 条守卫断言）。

**变异验证**（每条都确认能杀掉对应用例）：

| 变异 | 结果 |
|---|---|
| 删掉 `setRebindSession` 注册 | 「重新绑定审批 UI」用例失败 |
| `reload` 不调 `switchSession`（直接返回旧 manager 的历史） | 「拿到 TUI 追加的内容」+「失败可重试」两条失败 |
| 历史模式由 `'branch'` 改回 `'refresh'` | reload 与 rewind 各失败一条 |

测试替身也跟着改准了：`piSdkStub` 的 `SessionManager.open` 现在**在 open 时对分支做快照**（照真实实现「读一次、之后不再看磁盘」），`createAgentSessionRuntime` 返回真正会替换 session 的运行时。在此之前 stub 的 `getBranch` 直读活数组，"陈旧读"这个前提根本演不出来——旧 stub 下写什么用例都是绿的。

### 没做 / 待验

- **真机回合未跑。** 上面全是自动化验证；用户原始复现路径（GUI 对话 → 切 TUI 续聊 → 切回 GUI）需要真实 pi CLI 走一遍才算收口。
- 已分叉的老会话仍不自动补救，与第三节一致。
