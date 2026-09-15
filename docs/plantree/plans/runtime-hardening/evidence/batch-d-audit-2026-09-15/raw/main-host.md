# 批次 D 补审原文 — Main 侧宿主（WorkerManager 轴）

- **区域**：main-host（Main 进程侧载体与 RPC 宿主）
- **任务**：T029（批次 D 审计覆盖补全），对应批评者缺口 1（`cross-and-critic.md:64`，GAP [P4-0 / P4-3 / P4-4]）
- **节点判定对象**：P4-0、P4-3、P4-4 的 Main 半边
- **基线**：HEAD `ebc82f16`（批次 A / B / C 与 T036 已全部落地）
- **日期**：2026-09-15
- **方式**：只读。未构建、未跑测试、未起 Electron。

## 总评

这一层比审计当时的印象要结实。审计留下的三条 Main 侧悬案，逐条核对下来两条已经真的修好、一条已经删干净：

- `worker.reload` 的 Main 侧预算已经和 bootstrap 对齐（`WorkerManager.ts:1373` 传 `BOOTSTRAP_REQUEST_TIMEOUT_MS`），`worker.compact` 拿到了 `WORKER_COMPACT_REQUEST_TIMEOUT_MS = 60_000`，并且 worker 自己的 `WORKER_COMPACT_BUDGET_MS = 45_000` 严格小于它——也就是说超时的一定是 worker 自己先放弃，不会再出现「界面报失败、磁盘却压缩成功」的分叉。测试也把这条不等式钉住了（`WorkerManager.test.ts:2058`）。worker-runtime-05 / 06 的 Main 半边判**已修（T016）**。
- `sessionKeysMatch` 在仓内已彻底消失，只剩 `piTuiSession.test.ts:13` 的一行历史注释。cutover-20 判**已修（T025）**。
- 事件出口的 `seq` / `timestamp` 覆写（rpc-projector-15）仍然存在，但 worker 侧已经补上了说明性注释（`piWorkerRpcServer.ts:981-990`），属于 T025 的 partial-waiver 落法，不再单列。
- 事件转发的会话归属闸（rpc-projector-08 关心的那一面）是**结实的**：`WorkerManager.ts:2433` 对任何带 `sessionId` 且与本 entry 不符的事件直接丢弃，worker 无法把事件伪造到别的会话名下；generation 还有 WorkerSlot 与 `isAuthoritative` 两道独立闸。

剩下的问题集中在三类，没有一条是「协议写错了」，全部是**接缝**：

1. **跨会话/跨工作区的读取边界有一处真漏**：斜杠命令的「随便找个活着的 worker」回退，在决策 009 把项目层全部打开之后已经会把另一个仓库的项目级技能与提示词端到端交给用户（main-host-01）。这条的注释本身就写着一个已经不成立的前提。
2. **关机与拆除的顺序有两处没收口**：导入槽拆除失败会把整池会话的优雅拆除一起吞掉，还顺带取消了 7 秒兜底强杀（main-host-02）；以及 Main 在 `slot.dispose()` 之前就关掉了事件闸，把 worker 专门为此保留的排空事件全部丢掉（main-host-03）。后者正好和 worker 侧那段长注释背道而驰。
3. **两种载体没有共享同一套卫生习惯**：child_process 支路显式排空 stdout 并写了原因，utilityProcess 支路没有（main-host-04）。这是 ARD D4 / D11「两种载体同一套协议」在实现层的一处不对称。

另有四条死代码/死接线，都是 P6-5 清扫的同一类尾巴：整条 `tier` 通道、`index.ts` 桶文件连同 `NodeRuntimeResolver`、`WorkerSlot.replaceCrashedTransport` 的整个 `replacing` 状态机、五种 `WorkerSlotDiagnostic` 的零消费者。

## 优点

- **身份与权威的三重闸做得非常扎实**。`isAuthoritative`（`WorkerManager.ts:2711`）同时校验 `acceptEvents`、两张 map 的指向、以及 generation；每一个跨 `await` 的写回（`servePreview`、`ensureIdentityCommitted`、`syncLeafCheckpoint`、fork / rewind / reload 的提交点）都在 await 之后重新取权威，而不是信任闭包里的旧引用。`branchRevision` 还额外挡住了跨分支的历史页与树快照。
- **会话文件「先存在、再公布身份」这条线是全仓最讲究的一处**。`commitIdentityIfMaterialized` / `ensureIdentityCommitted` / `rematerialize` 三段把「pi 只是预留了文件名」这个已知坑（记忆里的 pi-lazy-session-file-write）处理成了可恢复路径，而不是一次性赌注，并且崩溃重启时还会重新 stat 一次防止把真有内容的文件丢掉（`WorkerManager.ts:2540-2542`）。
- **超时预算现在是有分级的、而且有注释解释为什么**：warm 10s、bootstrap / reload 60s、compact 60s（worker 45s）、dispose ACK 3s、exit 确认 3s，且关机总预算 7s 被显式写成「要盖住 3+3 的最坏路径、又要小于外层 8s 强退」（`src/main/ipc/index.ts:101-107`）。这是少见的把三层常量放在一起推理过的写法。
- **stderr 通道是完整闭环**：按行组装（`hostStderr`）→ 脱敏（`stderrRedaction`）→ 每回合限量转发 → worker 死亡时把最近若干行以 `console.error` 补打。启动阶段死掉的 worker 有专门的 `dumpWorkerStderr(entry, 'failed to start')` 兜底（`WorkerManager.ts:2034`），这正是审计里 rpc-projector-17 想要的东西。
- **容量与驱逐的口径分得很清**：`evictForCapacity` 会发 `capacity_reclaimed` 让渲染层解绑，而 15 分钟空闲清扫**故意**不发，注释把「两条不同的线」说清楚了（`WorkerManager.ts:2380-2395`）。`error` 态被明确算作可驱逐，避免了死 entry 永久占坑。
- **载体协议归一做对了一半**：`WorkerTransport` 把 Electron 两种投递形状（直接 payload 与 `{data}` 包装）在一处归一（`WorkerTransport.ts:21-31`），上层生命周期完全不感知载体。

## 弱点

- **跨会话读取的边界不是一条线，而是两套规则**。绝大多数入口走 `requireReadySession` + `assertIdleEntry` + `claimEntry` 三件套，唯独 `getSlashCommands` 三件套全免并额外允许「换一个 worker 回答」。免掉前两件是合理的（菜单要在回合中也能开），但「换一个 worker」这一条依赖的前提在决策 009 之后不成立了。
- **拆除路径上「先关闸后拆」的顺序在两个地方是反的**：`retireEntry` 先把 `acceptEvents` 置 false 再 `await slot.dispose()`；`disposeAll` 把可能抛错的导入槽拆除放在会话池拆除之前且不兜底。两处都不是协议问题，是语句顺序问题。
- **诊断面是断的**。WorkerSlot 精心产出五种 `WorkerSlotDiagnostic`，生产链路一个都不接。协议版本不匹配、半帧、未知响应 id 这三类故障在生产里唯一的表现是「RPC 超时」，没有任何一行日志说明原因。
- **死代码的清扫在这个目录停在了半路**。T025 删掉了 `sessionKeysMatch` 与 `leafCheckpoint` 的 wire 半边，但同目录还剩四条同类尾巴（见 main-host-05～08），其中 `tier` 那条还带着一段把它描述成「现行修复」的注释，会误导下一个接手的人。
- **载体差异只在 child_process 支路被想过**。`stdio: 'pipe'` 在 utilityProcess 上同样会产生一个没人读的 stdout 管道，而那一侧的测试替身（`FakeUtilityProcess`）连 `stdout` 字段都没有，测试永远绿。

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| P4-0（Main 侧进程载体） | complete-with-gaps | spawn 前置检查（cwd 预检、node.exe 存在性）、环境净化（剥 `ELECTRON_RUN_AS_NODE`、注入 generation）、Windows 打包分支都在位且有用例。缺口：两种载体的 stdout 处理不对称（main-host-04）；`index.ts` 桶文件与 `NodeRuntimeResolver` 已无生产消费者（main-host-06）。 |
| P4-3（WorkerTransport / RPC 宿主） | complete-with-gaps | 关联、超时、generation 闸、崩溃结算、dispose 两段式都完整且有用例；worker-runtime-05 的 Main 半边已修（T016），cutover-20 已修（T025），事件归属闸无法被伪造。缺口：dispose 排空事件被 Main 丢弃（main-host-03）；诊断通道无消费者（main-host-08）；`replaceCrashedTransport` 整条替换状态机只有测试在用（main-host-07）；`tier` 整条 RPC 通道无生产者（main-host-05）。 |
| P4-4（会话 RPC 面的 Main 半边） | complete-with-gaps | compact / reload 的预算与 worker 侧不等式已对齐并有用例（worker-runtime-05/06 的 Main 半边已修，T016）；send / stop / rewind / fork / history 的忙闲闸与分支版本闸齐备。缺口：斜杠命令跨工作区回退（main-host-01）；关机时导入槽失败吞掉整池拆除（main-host-02）。 |

## 发现

### [main-host-01] medium correctness | P4-4 | src/main/services/agent-host/WorkerManager.ts:1148 | 斜杠命令的「随便找个活着的 worker」回退会把另一个仓库的项目级技能与提示词端到端交给用户

DESC: `getSlashCommands` 在指名会话没有 ready worker 时，会挑池子里任意一个 ready worker来回答。它的依据写在同一段注释里：「In managed mode the command set does not vary by working directory — project scope is withheld」。这个前提在决策 009 之后不成立了：`NATIVE_PROJECT_TRUSTED` 是写死的 `true`（`src/shared/piModelConfig.ts:67`），worker 把它原样交给图（`src/agent-host/worker.ts:138`），于是技能与提示词的项目级根目录一定会被扫（`src/runtime/plugins/skills/index.ts:224-233` 的 `<cwd>/.pi/skills` 与 `.agents/skills` 上溯链，`:244-245` 的 `<cwd>/.pi/prompts`）。`worker.commands` 返回的每一行还带着 `path`（绝对路径）与 `scope: 'project'`（`src/runtime/worker/nativeWorkerRuntime.ts` 的 `commands()`）。worker 侧的 `assertLogicalSession` 拦不住这件事，因为 Main 传的就是被回退选中的那个 worker 自己的 `logicalSessionId`。注意这不是「顺手写错」：`WorkerManager.test.ts:2160`「falls back to any ready worker when the named session has none」把这个回退钉成了期望行为，所以修的时候要连注释、用例与口径一起改。

EVIDENCE:
```ts
// WorkerManager.ts:1131-1135（注释）
//  - **Any ready worker will do.** In managed mode the command set does not
//    vary by working directory — project scope is withheld, and the agent dir
//    and `~/.agents` are fixed — so the nearest live worker is authoritative
//    for all of them.

// WorkerManager.ts:1144-1156
const named = input.sessionId ? this.entriesBySession.get(input.sessionId) : undefined;
const entry =
  named?.state === 'ready' && named.slot
    ? named
    : [...this.entriesBySession.values()].find(
        (candidate) => candidate.state === 'ready' && candidate.slot
      );
if (!entry?.slot) return { commands: [], truncated: false };
const result = await entry.slot.request<WorkerCommandsResult, WorkerCommandsPayload>(
  'worker.commands',
  { logicalSessionId: entry.logicalSessionId }
);
```
```ts
// src/shared/piModelConfig.ts:67
export const NATIVE_PROJECT_TRUSTED = true;
```
```ts
// src/runtime/plugins/skills/index.ts:224-226
if (config.cwd && enabled.project) {
  roots.push({ path: join(config.cwd, '.pi', 'skills'), scope: 'project', rootMarkdown: true });
```

SCENARIO: 用户在仓库 `/work/alpha` 的会话 A 里已经发过消息（worker ready），随后在仓库 `/work/beta` 新建会话 B、还没发第一条消息（B 没有 worker，走懒启动）。用户在 B 的输入框敲 `/`，菜单弹出的是 `/work/alpha/.pi/prompts` 与 `/work/alpha/.pi/skills` 里的条目，连同 alpha 的绝对路径。用户选一条 alpha 专属命令发给 B，B 的 worker 没有这个模板，命令要么当普通文本发给模型、要么直接失败——而用户刚刚在菜单里看到过它。

FIX: 回退只在「不知道要问谁」时才合理。建议二选一：(a) 指名会话没有 ready worker 时直接返回空列表（与「没有 worker 就返回空」的既有语义一致），把回退限制在 `input.sessionId` 缺省的场景（开始屏）；(b) 保留回退但按 `cwd` 过滤，只接受与目标会话同一 `cwd` 的 worker。同时改掉 `:1131-1135` 那段已经不成立的注释，并把 `WorkerManager.test.ts:2160` 的用例改成新口径。

---

### [main-host-02] medium robustness | P4-4 | src/main/services/agent-host/WorkerManager.ts:1949 | 关机时导入槽拆除一抛错，整池会话 worker 的优雅拆除和 7 秒兜底强杀被一起跳过

DESC: `disposeAll` 把「拆导入槽」放在「拆会话池」之前，且对前者不做任何兜底。导入槽的 `dispose()`（`src/main/services/legacyImport/PiImportProcess.ts:137-141` → `WorkerSlot.dispose`）在 ACK 3 秒或退出确认 3 秒超时时会 reject；`WorkerManager.createLegacyImport` 返回的包装层即使强杀成功也**一定会把原错误再抛出去**（`WorkerManager.ts:556-568` 的 catch 末尾 `throw error`）。于是 `disposeAll` 的 async 体在 `await activeImport.dispose()` 这一行中断：后面的三个 null 归位、`importSlotActive = false`、`disposeEntries(...)`、`this.state = 'stopped'` 全部不执行。更麻烦的是外层：`cleanupWorkerManager` 用 `Promise.all` 立刻 reject，`safeRun` 吞掉并**迅速 resolve**，于是 `Promise.race([allSettled, deadline])` 会在远早于 7 秒时结束，`clearTimeout(deadlineTimer)` 取消掉那个本来会调用 `cleanupWorkerManagerSync()` 的定时器——也就是说兜底强杀这条路也一并没了。同一次失败还顺带跳过了 `scratchWorkspaceService.wipeAll()`（U05-a 的临时目录清理，写在 `Promise.all` 之后）。

EVIDENCE:
```ts
// WorkerManager.ts:1941-1957
disposeAll(reason: 'app-shutdown' | 'slot-dispose' = 'app-shutdown'): Promise<void> {
  return this.serialize(async () => {
    if (reason === 'app-shutdown' && this.idleTimer) { ... }
    const activeImport = this.activeImport;
    const activeImportSlot = this.activeImportSlot;
    if (activeImport) await activeImport.dispose();        // <- 抛出即中断
    else if (activeImportSlot) await activeImportSlot.dispose(reason);
    this.activeImport = null;
    ...
    await this.disposeEntries([...this.entriesBySession.values()], reason);
    this.state = 'stopped';
  });
}
```
```ts
// src/main/ipc/workerManager.ts:6-12
export async function cleanupWorkerManager(): Promise<void> {
  await Promise.all([workerManager.disposeAll('app-shutdown'), piUtilityService.disposeAll()]);
  await scratchWorkspaceService.wipeAll();
}
```
```ts
// src/main/ipc/index.ts:127-153
await Promise.race([ Promise.allSettled([ ... safeRun(() => cleanupWorkerManager(), 'workerManager') ... ]), deadline ]);
if (deadlineTimer) clearTimeout(deadlineTimer);
```

SCENARIO: 用户正在做一次体量较大的旧会话导入（导入 worker 忙于写盘），此时退出应用。`worker.dispose` 排在导入写入之后、3 秒 ACK 预算耗尽 → 导入槽被强杀但错误照抛 → `disposeAll` 在第一行就中断 → 池子里所有会话 worker 都没有收到 `worker.dispose`（不走 runtime 的收尾与 MCP 子进程释放），也没有走到 7 秒兜底的 `cleanupWorkerManagerSync()`，因为 `allSettled` 早就 resolve 并清掉了那个定时器；scratch 临时目录也没被擦。静态推断部分：在打包 Windows 上 worker 是 `spawn` 出来的 `node.exe` 子进程（`PiWorkerProcess.ts:213`），Electron 主进程退出不保证收走它们，因此这一路最坏结果是残留的 node.exe 进程与被它占住的会话 JSONL；macOS / Linux 走 utilityProcess，由 Electron 统一回收，只损失优雅收尾。这一条需要在批次 E 上机确认。

FIX: 把导入槽的拆除放进 `try/finally`（或 `.catch(() => undefined)` + 记录日志），保证 `disposeEntries` 与 `state = 'stopped'` 一定执行；关机语义下「有东西没拆干净」应当记录而不是中止。补一条用例：导入槽 dispose reject 时，池内两个会话槽仍各收到一次 `dispose`。顺带考虑让 `cleanupAllResources` 的 deadline 不被「快速失败」提前取消（例如把 `cleanupWorkerManagerSync()` 改成 finally 里的无条件兜底，重复调用本来就是幂等的）。

---

### [main-host-03] medium contract-gap | P4-3 | src/main/services/agent-host/WorkerManager.ts:2414 | Main 在 `slot.dispose()` 之前就关掉了事件闸，worker 专门为此保留的排空事件全部被丢掉

DESC: worker 侧在 T016 专门调整过顺序并写了长注释：`disposed` 标志必须在 runtime 拆除**之后**才置位，因为引擎会在排空已挂起的权限门、问题与预览时发事件——「Setting it first dropped exactly the events those drains exist to deliver, so Main never learned that the dialogs it was showing had been answered for it」（`src/agent-host/piWorkerRpcServer.ts:928-943`）。Main 这一侧把这份努力抵消掉了：`retireAndDispose` 先调 `retireEntry`，后者同步把 `entry.acceptEvents = false`、`entry.state = 'disposing'` 并从两张 map 里摘掉 entry，**然后**才 `await slot.dispose(reason)`。而 `handleWorkerEvent` 的第一道闸是 `isAuthoritative`（要求 `acceptEvents` 为真且两张 map 仍指向本 entry），第二道是 `entry.state !== 'ready'`——两道都必然不过。于是 `permissions.drain('session_closed')` 发出的 `permission.resolved`（`src/runtime/worker/nativeWorkerRuntime.ts:820-822` → `src/runtime/worker/permissionPrompt.ts:233-236` → `:127-134`）在 Main 出口被静默丢弃，`question` / `preview` 的排空同理。

EVIDENCE:
```ts
// WorkerManager.ts:2370-2378
private async retireAndDispose(entry, reason): Promise<void> {
  this.retireEntry(entry);      // acceptEvents = false, state = 'disposing', 摘 map
  const slot = entry.slot;
  await slot?.dispose(reason);  // worker 在这里才排空并发事件
  if (slot) this.ownedSlots.delete(slot);
}

// WorkerManager.ts:2414-2426
private retireEntry(entry: ManagedSlot): void {
  entry.acceptEvents = false;
  entry.state = 'disposing';
  ...
}

// WorkerManager.ts:2429-2430
if (!this.isAuthoritative(entry, message.generation) || entry.slot !== slot) return;
if (entry.state !== 'ready' || message.type !== 'runtime.event') return;
```

SCENARIO: 用户正在一个会话里等待一张权限卡（工具想写文件，卡片在屏上），同时在设置里保存了模型 / 服务商配置。`src/main/ipc/piModels.ts:42` 调 `workerManager.invalidateAll()` → `disposeEntries([...所有 entry], 'slot-replace')`（这条路径**不检查** `activeRequestId`）→ 每个 entry 先被 `retireEntry` 关闸、再拆 worker → worker 排空权限门并发出 `permission.resolved{autoReason:'session_closed'}` → Main 丢弃。渲染层靠 `permission.resolved` 删卡（`src/renderer/stores/chatSessions.ts:1178`），于是卡片留在屏上；用户点它会走 `respondPermission`，那时 entry 已经不在 map 里，得到 `session_not_ready`。`invalidateAll` 本身也不发任何 `session.status`，所以这个会话既没有「已断开」提示、也没有终态事件。（渲染层另有 F2 的静默预算/liveness 分类器，最终可能把回合判成失活，所以「永久卡死」这一步我没有证据，需要上机确认；被 Main 丢事件这一步是确定的。）

FIX: 把关闸推迟到 worker 退出确认之后——`retireAndDispose` 先 `await slot.dispose(reason)` 再 `retireEntry`；或者更小的改法：在 `retireEntry` 里保留一个「排空窗口」标志，让 `handleWorkerEvent` 在 `disposing` 期间仍然放行 `permission.resolved` / `question.resolved` / `preview` 这三类终态事件（它们本来就只是把卡片收掉）。另外给 `invalidateAll` 补一条与 `evictForCapacity` 同形的 `session.status: disconnected`，让渲染层解绑。

---

### [main-host-04] medium robustness | P4-0 | src/main/services/agent-host/WorkerTransport.ts:96 | 两种载体只有一种排空 stdout：child_process 支路显式 `resume()` 并写明原因，utilityProcess 支路没有

DESC: `createNodeProcessWorkerTransport` 第一件事就是 `proc.stdout?.resume()`，注释写明理由是「排空普通 stdout，避免工具 / 扩展的日志把管道写满」。`createUtilityProcessWorkerTransport` 只订阅 `stderr`（`onStderr` → `subscribeReadable`），从不碰 `stdout`。而 `forkPiWorkerProcess` 给 utilityProcess 传的是 `stdio: 'pipe'`，按 Electron 的 `ForkOptions` 文档这会同时把 stdout 与 stderr 做成管道并暴露为 `proc.stdout` / `proc.stderr`（`node_modules/electron/electron.d.ts:20661-20670`、`:15103-15109`）。也就是说非打包平台与 macOS / Linux 的产品路径上，worker 的 stdout 是一条**创建了但没有读者**的管道。这与 ARD D4 / D11「两种载体共用同一套协议处理」的口径不一致——协议层确实共用了（`normalizeUtilityMessage` 把两种投递形状归一），但载体卫生只做了一半。本仓自己的代码不往 stdout 写（`src/runtime`、`src/agent-host` 的生产文件里没有 `console.log` / `process.stdout.write`），风险来自第三方：pi-ai / MCP SDK / cordis / 任何随包插件。这恰恰是 child_process 那条注释所担心的那类写者。

EVIDENCE:
```ts
// WorkerTransport.ts:96-99
export function createNodeProcessWorkerTransport(proc: ChildProcess): WorkerTransport {
  // RPC uses Node IPC; drain ordinary stdout so tool/extension logs cannot fill its pipe.
  proc.stdout?.resume();
```
```ts
// WorkerTransport.ts:82-84（utility 支路，只有 stderr）
onStderr(listener) {
  return subscribeReadable(proc.stderr, listener);
},
```
```ts
// PiWorkerProcess.ts:221-227
const processHandle = utilityProcess.fork(entryPath, [], {
  cwd: options.cwd,
  execArgv: entryPath.endsWith('.ts') ? ['--experimental-strip-types'] : [],
  env,
  stdio: 'pipe',
  serviceName: `AiClient Pi Worker ${options.generation}`,
});
```

SCENARIO: 某个随包或用户配置的 MCP 服务器包装脚本、或第三方 SDK 的调试输出，在一次长回合里往 worker 的 stdout 写了几十 KiB 以上。Main 这边没有任何读者，数据要么堆在 Node Readable 的内部缓冲里（主进程内存随会话时长增长），要么在管道满之后让 worker 的写调用阻塞——后者会把 worker 的事件循环卡住，表现为这条会话的所有 RPC 一起超时，而 stderr 与日志里什么线索都没有。**这是静态推断**：具体是「缓冲增长」还是「写阻塞」取决于 Electron 对 utilityProcess stdout 的实现，本机无法判定，必须在批次 E 用真实 Electron utility 载体验证。

FIX: 在 `createUtilityProcessWorkerTransport` 里对称地加一行排空（`(proc.stdout as Readable | null)?.resume()`），或者把两条支路的 stdout 处理抽成同一个 helper，让「载体差异」只剩投递形状归一这一处。同时给 `WorkerTransport.test.ts` 的 `FakeUtilityProcess` 补一个 `stdout: new PassThrough()`——现在这个替身连 stdout 字段都没有，所以任何 stdout 相关回归测试都看不见（`WorkerTransport.test.ts:15-20`）。

---

### [main-host-05] low dead-code | P4-3 | src/main/services/agent-host/WorkerManager.ts:1881 | 整条 `tier` 通道自 D14 之后没有生产者，注释却仍把它写成现行的 U12 修复；Main 还不校验 worker 的 `applied` 回答

DESC: D14 把权限从四档 tier 改成 mode + gear 两轴之后，渲染层只发 `permissions`，不再发 `tier`：`ChatComposer.tsx:1315-1316` 只组装 `spawnPermissions`，`sessionIndex/useResumeSession.ts:39-43` 只传 `permissions`，全仓渲染层对 `setPermissionTier` 的引用只剩三处注释与测试说明（`ChatComposer.tsx:1306`、两个测试头注释）。于是这条链的每一环都没有活的生产者：`preload/index.ts:1073` 暴露的 `setPermissionTier`、`IPC_CHANNELS.CHAT_SET_PERMISSION_TIER`、`src/main/ipc/chat.ts:562-575` 的 handler、`src/main/ipc/chat.ts:190` 的 `spawnTier()`（永远返回 `{}`）、`ManagedSlot.tier`、`spawnForEntry` 的 `...(entry.tier ? { tier } : {})`、`worker.setPermissionTier` RPC 与 `PiWorkerRuntime.setPermissionTier`。而 `ManagedSlot.tier` 上那段 U12 注释（`WorkerManager.ts:130-142`）把它描述成「让 chip 与 runtime 不再漂移」的现行修复——真正在做这件事的是 `permissions`。附带两处实现不一致，一起记在这里：(1) `setPermissionTier` **完全不看** RPC 的返回值，既不 `isWorkerSetPermissionTierResult` 也不查 `applied`，而同一个类里的 `setPermissions` 对同一种回答会抛 `worker_permission_not_applied`（`:1870-1874`）；(2) `setPermissionTier` 在发 RPC **之前**就把 `entry.tier` 与 `entry.permissions` 写死了，而 `setPermissions` 是成功之后才写（`:1877`）——`WorkerManager.test.ts:1428`「does not replace the saved setting when the worker rejects a change」把后者的语义钉住了，前者没有对应用例。

EVIDENCE:
```ts
// WorkerManager.ts:1881-1901
async setPermissionTier(sessionId: string, tier: SessionPermissionTier): Promise<string> {
  const requestId = nextRequestId('permtier');
  const entry = this.entriesBySession.get(sessionId);
  if (entry) {
    entry.tier = tier;
    entry.permissions = migratePermissionTier(tier);   // 发 RPC 之前就写
  }
  if (!entry?.slot || entry.state !== 'ready') return requestId;
  const payload: WorkerSetPermissionTierPayload = { logicalSessionId: sessionId, tier };
  await entry.slot.request<WorkerSetPermissionTierResult, WorkerSetPermissionTierPayload>(
    'worker.setPermissionTier',
    payload
  );                                                    // 返回值从不校验
  entry.lastUsedAt = this.now();
  return requestId;
}
```
```ts
// src/main/ipc/chat.ts:190-196（唯一的 tier 生产点，渲染层从不传 payload.tier）
function spawnTier(tier: unknown): { tier?: SessionPermissionTier } {
  if (tier === undefined) return {};
  ...
}
```

SCENARIO: 两个方向都是维护成本而不是当前故障。(1) 接手的人读 `ManagedSlot.tier` 上那段 U12 注释，会以为 chip 的持久化走的是 tier，改 chip 行为时改错地方；(2) `window.electronAPI.chat.setPermissionTier` 仍然是暴露给渲染层的可调用面，任何一处新代码调它，都会在 worker 侧因为 `assertIdle`（`src/runtime/worker/nativeWorkerRuntime.ts:803` → `:847`，回合中抛 `WORKER_SESSION_BUSY`）而失败，但 Main 已经把 `entry.tier` / `entry.permissions` 写成了新值——这一刻 Main 的记录与 worker 的实际授权不一致，且 `createSession` 的热路径正是拿 `entry.permissions` 与入参比较来决定要不要补推（`:674-679`），比较结果相同就不补推，漂移会一直留到这个 worker 被换掉。

FIX: 按「哪些代码因为 legacy / D14 走了而失去消费者」重新画线，整条 tier 通道连同 preload 方法、IPC channel、`spawnTier`、`ManagedSlot.tier`、`worker.setPermissionTier` 与 runtime 侧实现一并退役（与 T025 删 `sessionKeysMatch` / `leafCheckpoint` 同一类动作）。若决定保留，则至少把两处不一致对齐到 `setPermissions` 的语义：先 RPC 成功、校验 `applied`、再写 entry。

---

### [main-host-06] low dead-code | P4-0 | src/main/services/agent-host/index.ts:1 | 目录桶文件零导入者，它是 `NodeRuntimeResolver` 唯一的引用来源，而后者也没有生产调用方

DESC: `src/main/services/agent-host/index.ts` 把 14 个符号重新导出，但全仓没有任何文件从这个桶导入——所有消费者都直接 import 具体模块（`../services/agent-host/WorkerManager`、`../agent-host/PiUtilityService` 等，共 20 余处）。连带后果是 `NodeRuntimeResolver.ts`（约 260 行，含 win32 分支、`node.exe` 拼接、`--version` 探测与 `process.execPath` 回读）在生产链路上没有任何调用方：`resolveNode24Runtime` 只被这个桶重新导出，以及被它自己的测试调用。打包 Windows 的 Node 运行时是在 `PiWorkerProcess.ts:209` 直接拼 `process.resourcesPath/node-runtime/node.exe` 解决的，没有走这个解析器。

EVIDENCE:
```
$ grep -rn "agent-host/index\|from '.*services/agent-host'" src/ scripts/   # 无命中
$ grep -rn "resolveNode24Runtime" src/ scripts/
src/main/services/agent-host/index.ts:9
src/main/services/agent-host/__tests__/NodeRuntimeResolver.test.ts:2,10,26,38,59
```
```ts
// PiWorkerProcess.ts:206-212（打包 Windows 的实际做法，不经 NodeRuntimeResolver）
if (app.isPackaged && process.platform === 'win32') {
  const nodePath = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
  if (!existsSync(nodePath)) throw new Error(`Pi Node runtime is missing: ${nodePath}`);
```

SCENARIO: 排查 Windows 上「找不到 Node 运行时」这类问题的人，会先读 `NodeRuntimeResolver.ts`（它名字最像、还有专门的测试），花时间读完一条产品从不执行的解析逻辑；真正决定行为的是 `PiWorkerProcess.ts:209` 的一行拼接。批次 E 的 Windows 检查单如果照着 `NodeRuntimeResolver` 列项，会验错对象。

FIX: 删掉 `index.ts` 桶文件；随后按「NodeRuntimeResolver 是否还要」单独决策——若不要，连同测试删除；若要（例如将来给打包 Windows 做运行时校验），就把它真正接到 `forkPiWorkerProcess` 的 win32 分支上，让代码与测试指向同一条路。

---

### [main-host-07] low dead-code | P4-3 | src/main/services/agent-host/WorkerSlot.ts:240 | `replaceCrashedTransport` 与整个 `replacing` 状态机只有测试在用，方法注释却说策略归 WorkerManager

DESC: `WorkerSlot` 为「崩溃后就地换一个传输」保留了一整套机制：`replaceCrashedTransport`、`replaceTransportInternal`、`replacementPromise` 字段、`WorkerSlotState` 里的 `'replacing'` 分支，以及 `disposeInternal` 开头等待 `replacementPromise` 的那一段。生产链路不用它：`WorkerManager.restartEntry` 的做法是 `await oldSlot.dispose('slot-replace')`，然后 `entry.generation += 1`、`entry.slot = null`、`spawnForEntry` 建一个**全新的 WorkerSlot**（`WorkerManager.ts:2543-2560`）。全仓 `replaceCrashedTransport` 的调用方只有 `WorkerSlot.test.ts` 的五处。方法上的注释「Restart budgeting and policy are owned by WorkerManager (T30)」会让读者以为 WorkerManager 在驱动它。

EVIDENCE:
```
$ grep -rn "replaceCrashedTransport" src/
src/main/services/agent-host/WorkerSlot.ts:240
src/main/services/agent-host/__tests__/WorkerSlot.test.ts:468,484,506,507,528
```
```ts
// WorkerSlot.ts:235-240
/**
 * Attach a replacement process after a crash. Restart budgeting and policy are
 * owned by WorkerManager (T30); this method only advances the generation and
 * makes stale callbacks from the retired process harmless.
 */
replaceCrashedTransport(transport: WorkerTransport): Promise<number> {
```

SCENARIO: 有人按注释的指引去 WorkerManager 里找「重启预算怎么调用替换」，找不到；或者在改崩溃恢复时以为要同时维护「就地替换」与「重建槽位」两条路径，给一条永远走不到的分支写新逻辑与新用例。同类风险已经在 T025 的清扫里出现过一次（`sessionKeysMatch` / `leafCheckpoint`）。

FIX: 与 main-host-05 / 06 一起纳入「P6-5 清扫的另一半」：删除 `replaceCrashedTransport`、`replaceTransportInternal`、`replacementPromise`、`'replacing'` 状态与 `disposeInternal` 里等待替换的那一段，连同 `WorkerSlot.test.ts` 的五条用例；`WorkerSlot` 的类注释同步改成「一个槽位只服务一个传输，替换由 WorkerManager 重建槽位完成」。若要保留，就把注释改成「目前无生产调用方，保留原因是 X」。

---

### [main-host-08] low dead-code | P4-3 | src/main/services/agent-host/WorkerManager.ts:2030 | 五种 `WorkerSlotDiagnostic` 没有任何生产消费者，协议不匹配与半帧在生产里只剩「RPC 超时」这一个症状

DESC: `WorkerSlot` 产出五类诊断：`malformed-message`、`protocol-mismatch`、`stale-generation`、`unknown-response`、`late-transport-event`（`WorkerSlot.ts:50-55`，产出点在 `:502/511/520/524/532/541/547`）。`createPiWorkerSlot` 老老实实把 `onDiagnostic` 透传下去（`createPiWorkerSlot.ts:81`），但**没有任何生产调用方提供它**：`WorkerManager.spawnForEntry` 只传 `onSlotCreated` / `onEvent` / `onLifecycle` / `onStderr`（`WorkerManager.ts:2014-2030`），`PiUtilityService.ts:114` 与 `PiImportProcess.ts:36/64/95` 直接 `new WorkerSlot(...)` 也都不传。唯一的消费者是 `WorkerSlot.test.ts`（`:156/235/256/520`）。于是这些故障在生产里既不进日志、也不进 trace、也不发事件。

EVIDENCE:
```ts
// WorkerManager.ts:2014-2030（spawnForEntry 提供的回调，没有 onDiagnostic）
onSlotCreated: (slot) => { ... },
onEvent: (event) => { ... },
onLifecycle: (event) => { ... },
onStderr: (chunk, generation) => this.absorbStderr(entry, generation, chunk),
```
```ts
// WorkerSlot.ts:523-530
if (record.protocolVersion !== WORKER_RPC_PROTOCOL_VERSION) {
  this.onDiagnostic?.({ type: 'protocol-mismatch', generation, received: record.protocolVersion });
  return;
}
```

SCENARIO: 应用升级后 `WORKER_RPC_PROTOCOL_VERSION` 变了，而打包产物里的 `agent-host/worker.js` 因为某次构建过滤没跟着更新（这类打包过滤陷阱本仓出过一次）。Main 发出的每个请求都会收到旧版本的响应，全部在 `handleMessage` 第一道闸被丢弃；用户看到的是 `worker.bootstrap timed out after 60000ms`，日志、trace、stderr 里没有一个字提到「协议版本不匹配」。排查者只能靠猜，而这条信息已经被算出来了、就在 `received` 字段里。

FIX: 在 `spawnForEntry` 里接上 `onDiagnostic`，至少 `this.log(...)`；`protocol-mismatch` 与连续多次 `malformed-message` 值得升到 `console.error`（与 `dumpWorkerStderr` 同一档，因为出厂配置下文件日志是关的）。`PiUtilityService` 与 `PiImportProcess` 三处同理。若认为不值得接，就把 `WorkerSlotDiagnostic` 整套删掉，别留一个看起来在工作的诊断面。

## 测试缺口

1. **关机时导入槽拆除失败** 没有用例证明会话池仍会被拆（现有两条导入用例只覆盖「正常关机拆一次」与「dispose + 强杀都失败时保留所有权」，见 `WorkerManager.test.ts:1849/1890`）。main-host-02 直接来自这个缺口。
2. **dispose 排空窗口的事件** 没有任何用例：没有一条测试让替身 worker 在收到 `worker.dispose` 之后、退出之前发一条 `permission.resolved`，并断言 Main 是否转发。main-host-03 因此在两侧都测不出来。
3. **utilityProcess 的 stdout** 在测试替身里根本不存在（`WorkerTransport.test.ts:15-20` 的 `FakeUtilityProcess` 只有 `stderr`），而 child_process 那条用例的假 worker 恰恰写了 stdout（`:40`）。两种载体的测试覆盖不对称。
4. **`setPermissionTier` 的失败语义** 无用例：`setPermissions` 有「worker 拒绝时不改存档」这条（`:1428`），tier 侧没有对应的一条；返回值不校验这件事也没有被任何断言挡住。
5. **`getSlashCommands` 的跨工作区回退** 有用例但钉的是当前（有问题的）行为（`:2160`），没有一条断言「回退来源与目标会话的 `cwd` 一致」。
6. **并发 RPC 的队列等待** 无用例：Main 侧每个请求的超时钟从发出即开始，worker 侧是单链串行，因此「排在慢请求后面的请求把预算耗在排队上」这类场景没有被任何测试表达（例如 reload 占链 20 秒时发一条 `worker.commands`）。
7. **诊断通道**只有 WorkerSlot 单测覆盖，没有一条用例断言「生产链路会把诊断记下来」——所以 main-host-08 这类断线永远是绿的。

## 未经执行验证的声明

- utilityProcess 的 stdout 在无读者时究竟是「内存堆积」还是「写阻塞把 worker 卡死」，取决于 Electron 的实现，本机无法判定（main-host-04）。
- 打包 Windows 上 `spawn` 出的 `node.exe` worker 在主进程退出后是否残留，只有上机能确认（main-host-02 的最坏后果一半）。
- main-host-03 的下游「权限卡永久留在屏上」这一步没有证据：渲染层有 F2 的静默预算与 liveness 分类器，可能最终把回合判成失活并清理界面。确定的只有「Main 丢掉了 worker 排空时发的事件」。
- `closeSession` 打断活跃回合时 worker 只有 3 秒 ACK 预算来 abort 并等 `turn.done`（`WorkerSlot.ts:93` 与 `nativeWorkerRuntime.ts:824-828`），超时即强杀。会不会因此丢掉会话文件的最后一次落盘，取决于 session store 的写入时机，没有构造出触发路径，不立发现。
- `forceKillAllNow` 里 `slot.forceKillNow()` 返回 false 的槽位会留在 `ownedSlots` 且不再重试；这条在 Linux/macOS 的 utilityProcess 下是否可达、在 Windows 下是否会留孤儿，同样只能上机判。
- worker 被强杀后，它自己拉起的 stdio MCP 服务器子进程是否会随之退出（多数 MCP server 在 stdin 关闭后自退），没有实测样本。

## 上机检查单

见结构化返回的 `checklist_items`，共 6 项，目标环境分别是 `windows`（2）、`utility`（2）、`real-model`（1）、`encrypted`（0）、`dev-box`（1）。

## 读过的文件

- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-medium.md（worker-runtime-02/05/06 段）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-low.md（rpc-projector-08/15、cutover-20 段）
- docs/plantree/plans/runtime-hardening/roadmap.md
- src/main/services/agent-host/WorkerManager.ts
- src/main/services/agent-host/WorkerSlot.ts
- src/main/services/agent-host/WorkerTransport.ts
- src/main/services/agent-host/PiWorkerProcess.ts
- src/main/services/agent-host/createPiWorkerSlot.ts
- src/main/services/agent-host/index.ts
- src/main/services/agent-host/workerSessionKey.ts
- src/main/services/agent-host/piCliLayout.ts
- src/main/services/agent-host/__tests__/WorkerManager.test.ts
- src/main/services/agent-host/__tests__/WorkerSlot.test.ts
- src/main/services/agent-host/__tests__/WorkerTransport.test.ts
- src/main/services/agent-host/__tests__/PiWorkerProcess.test.ts
- src/main/services/agent-host/__tests__/createPiWorkerSlot.test.ts
- src/main/services/legacyImport/PiImportProcess.ts
- src/main/services/agent-host/PiUtilityService.ts（仅槽位创建段）
- src/main/ipc/index.ts（cleanup 段）
- src/main/ipc/workerManager.ts
- src/main/ipc/chat.ts（spawn / 权限 / 斜杠命令 / reload 段）
- src/preload/index.ts（chat API 段）
- src/agent-host/piWorkerRpcServer.ts
- src/agent-host/worker.ts（projectTrusted 段）
- src/runtime/worker/nativeWorkerRuntime.ts（bootstrap / compact / commands / setPermissions / dispose 段）
- src/runtime/worker/permissionPrompt.ts
- src/runtime/plugins/skills/index.ts（roots 段）
- src/shared/piModelConfig.ts（NATIVE_PROJECT_TRUSTED 段）
- src/shared/types/workerRpc.ts（超时常量段）
- src/renderer/components/chat/ChatComposer.tsx（spawnPermissions 段）
- src/renderer/components/chat/sessionIndex/resumeIntent.ts
- src/renderer/components/chat/sessionIndex/useResumeSession.ts
- src/renderer/components/chat/__tests__/permissionTierWiring.test.ts
- node_modules/electron/electron.d.ts（UtilityProcess / ForkOptions 段）
