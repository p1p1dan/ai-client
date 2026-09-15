# 批次 D 补审发现：low 级（80 条）

Role: evidence（source material，原文保留）；来源：2026-09-15 批次 D 只读补审（T029 / T030 / T031，基线 HEAD `ebc82f16`，65 个代理）。严重级取反驳者裁定（`final_severity`）。本文件只收 `confirmed` 与 `confirmed-partial-waiver`；待定 / 推翻 / 取舍见 [findings-uncertain-refuted-waived.md](findings-uncertain-refuted-waived.md)，接缝与批评者全文见 [cross-and-critic.md](cross-and-critic.md)，总览见 [README.md](README.md)。

统计：区域发现 79 条（main-host-aux 1 · main-host 5 · utility-chain 6 · session-index 8 · import-upstream 6 · terminal-tui 6 · agent-host-lib 3 · chat-tool-vocab 7 · chat-event-vocab 7 · smoke-p0-6 1 · cordis-spike-d1 2 · baseline-comparability 2 · field-nodes 6 · concurrency 6 · windows-static 4 · capacity-leftovers 4 · tsd-utility 5），接缝发现 1 条（d-cross-03）；其中部分取舍 7 条、静态推断 30 条、被去重并入 4 条。

每条发现的格式：`[编号] 严重级 类别 最终状态 | 节点 | 文件:行 | 标题`，随后是审查员描述（DESC）、引用代码（EVIDENCE）、失败场景（SCENARIO）、修法建议（FIX）、反驳者结论（REFUTER）与文档取舍核对（WAIVER）。最终状态：confirmed=反驳者确认且无取舍；confirmed-partial-waiver=确认但文档部分取舍；uncertain=无法构造触发路径也无法排除；refuted=被推翻；waived=文档明确取舍、不计入。

标题行的补充标记：`（审查员原判 x）`=反驳者改过严重级，以标题行开头的严重级为准；`（静态推断）`=结论来自静态阅读、本轮无任何现场执行；`→ 并入 <编号>`=接缝审查员判为同一根因的重复条目，原文保留、修补时跟着 keep 那条走，被并入的条目不计入独立缺陷数。接缝审查员直查的 4 条 `d-cross-*` 没有 REFUTER / WAIVER 段，改写一行 SOURCE。

排列顺序：T029 九区（main-host-aux / main-host / utility-chain / session-index / import-upstream / terminal-tui / agent-host-lib / chat-tool-vocab / chat-event-vocab）→ T030 五区（smoke-p0-6 / cordis-spike-d1 / baseline-comparability / field-nodes / h-nodes）→ T031 四区（concurrency / windows-static / capacity-leftovers / tsd-utility）→ 接缝。区域原文报告在 `raw/<区域>.md`。

### [main-aux-08] LOW robustness confirmed | main-host-aux | src/main/services/agent-host/hostStderr.ts:58 | 无换行的 stderr 流只限制了内存没限制条数，一次巨量输出会把 50 行崩溃回放挤空
DESC: drainStderrLines 对「一直不出现换行」的处理是：tail 超过 2000 字符就截断成一行发出去并把 pending 清零。这挡住了缓冲区无限增长，但同一逻辑行的下一段会作为新行再次触发同样路径。所以一个 1 MB 的无换行 payload 会变成约 500 条 2000 字符的日志行，而 MAX_STDERR_LINE_CHARS 的注释写的是「the tail is noise once the failure is identifiable」——尾巴并没有被丢掉，只是被切成了段。连带后果落在 pushRecentStderr 的 50 行窗口上：这些行会把真正有诊断价值的启动横幅与栈挤出窗口，而 dumpWorkerStderr 的注释恰恰说「boot banner 加一段 SDK 栈完全装得下这 50 行」。
EVIDENCE: if (tail.length > MAX_STDERR_LINE_CHARS) { const trimmed = tail.trim(); if (trimmed) lines.push(clampLine(trimmed)); return { lines, pending: '' }; } // :57-62
测试只覆盖「超过上限就刷掉，所以 pending 不会无限增长」（__tests__/hostStderr.test.ts:53），没有覆盖同一逻辑行被切成 N 段后一共产生多少行。
SCENARIO: worker 或其子进程把一份序列化后的大 payload（例如整个请求体或一段 base64）一次性打到 stderr 且不带换行。日志里出现数百条截断行；worker 随后因别的原因退出时，dumpWorkerStderr 回放的 50 行全是这份 payload 的中段，真正的失败原因已被挤出缓冲区——而这个缓冲区存在的唯一理由就是保住失败原因。
FIX: 给「同一逻辑行」加丢弃计数：截断发出一次后，继续吞掉同一行剩余字节直到遇到换行（可发一条 `…[dropped N bytes of an unterminated line]` 收尾），而不是把剩余内容当作新行。
REFUTER(CONFIRMED,low): 行为描述属实，但数量级依 chunk 大小而定，审查员的「约 500 条」只在小块写入时成立。hostStderr.ts:58-62 原文 `if (tail.length > MAX_STDERR_LINE_CHARS) { const trimmed = tail.trim(); if (trimmed) lines.push(clampLine(trimmed)); return { lines, pending: '' }; }`——超限时把 tail 截到 2000 字符发一行，pending 清零，但同一逻辑行剩余字节不被吞掉，下一块进来重新走 :48 `const combined = pending + chunk`，再次超限就再发一行，确实是「切段」而非「丢尾」，与 :19 注释 'the tail is noise once the failure is identifiable' 不符。下游连带属实：WorkerManager.ts:2056-2058 `const drained = drainStderrLines(entry.stderrPending, chunk); entry.recentStderr = pushRecentStderr(entry.recentStderr, drained.lines);`，pushRecentStderr（:88-96）按 RECENT_STDERR_LIMIT = 50 只留尾部，dumpWorkerStderr（WorkerManager.ts:2108-2109）回放这 50 行，注释 :74-76 说「boot banner 加一段 SDK 栈完全装得下」。测试覆盖也如其所说：__tests__/hostStderr.test.ts 的 'flushes a newline-free tail once it passes the cap so pending cannot grow unbounded' 只断言单次刷出 + pending 为空，没有任何一条覆盖同一逻辑行跨块共产生几行。需要更正的是量：clampLine 只保留每块前 2000 字符，块内其余字节被丢弃，所以行数 ≈「超过 2000 字符的 chunk 个数」，不是 payload/2000。stderr 管道块通常 8~64 KiB，1 MiB 一次性写出约产生 16 行而非 500 行；要挤空 50 行窗口需要 50 次以上的超限块（按 64 KiB 块约 3 MiB，或写入方本来就小块流式输出）。仍属真实的可诊断性退化，无正确性影响，与审查员同判 low。批次 A~C 未碰此文件（git log 最后一次是 da9a5dad，即引入该模块的提交；roadmap 中 core-host-05 归 T013，改的是 exec 的 maxStderrBytes，不是本文件的分行逻辑）。
WAIVER(none): 无 — 全文档检索无命中（对照 core-host-05 排除误判）

### [main-host-04] LOW robustness confirmed | P4-0 | src/main/services/agent-host/WorkerTransport.ts:96 | 两种载体只有一种排空 stdout：child_process 支路显式 resume() 并写明原因，utilityProcess 支路没有（审查员原判 medium）（静态推断） → 并入 tsd-03
DESC: createNodeProcessWorkerTransport 第一件事就是 proc.stdout?.resume()，注释写明理由是「排空普通 stdout，避免工具 / 扩展的日志把管道写满」。createUtilityProcessWorkerTransport 只订阅 stderr，从不碰 stdout。而 forkPiWorkerProcess 给 utilityProcess 传的是 stdio: 'pipe'，按 Electron 的 ForkOptions 文档这会同时把 stdout 与 stderr 做成管道并暴露为 proc.stdout / proc.stderr（electron.d.ts:20661-20670、:15103-15109）。也就是说非打包平台与 macOS / Linux 的产品路径上，worker 的 stdout 是一条创建了但没有读者的管道。这与 ARD D4 / D11「两种载体共用同一套协议处理」不一致——协议层确实共用了（normalizeUtilityMessage 归一两种投递形状），载体卫生只做了一半。本仓生产代码不往 stdout 写（src/runtime、src/agent-host 生产文件里无 console.log / process.stdout.write），风险来自第三方：pi-ai / MCP SDK / cordis / 随包插件，正是 child_process 那条注释担心的写者。
EVIDENCE: // WorkerTransport.ts:96-99
export function createNodeProcessWorkerTransport(proc: ChildProcess): WorkerTransport {
  // RPC uses Node IPC; drain ordinary stdout so tool/extension logs cannot fill its pipe.
  proc.stdout?.resume();

// WorkerTransport.ts:82-84（utility 支路，只有 stderr）
onStderr(listener) {
  return subscribeReadable(proc.stderr, listener);
},

// PiWorkerProcess.ts:221-227
const processHandle = utilityProcess.fork(entryPath, [], {
  cwd: options.cwd,
  execArgv: entryPath.endsWith('.ts') ? ['--experimental-strip-types'] : [],
  env,
  stdio: 'pipe',
  serviceName: `AiClient Pi Worker ${options.generation}`,
});
SCENARIO: 某个随包或用户配置的 MCP 服务器包装脚本、或第三方 SDK 的调试输出，在一次长回合里往 worker 的 stdout 写了几十 KiB 以上。Main 这边没有任何读者，数据要么堆在 Node Readable 的内部缓冲里（主进程内存随会话时长增长），要么在管道满之后让 worker 的写调用阻塞——后者会把 worker 的事件循环卡住，表现为这条会话的所有 RPC 一起超时，而 stderr 与日志里什么线索都没有。静态推断：具体是缓冲增长还是写阻塞取决于 Electron 对 utilityProcess stdout 的实现，本机无法判定，须在批次 E 用真实 Electron utility 载体验证。
FIX: 在 createUtilityProcessWorkerTransport 里对称地加一行排空（(proc.stdout as Readable | null)?.resume()），或把两条支路的 stdout 处理抽成同一个 helper，让载体差异只剩投递形状归一这一处。同时给 WorkerTransport.test.ts 的 FakeUtilityProcess 补 stdout: new PassThrough()——现在这个替身连 stdout 字段都没有（:15-20），任何 stdout 相关回归永远测不出来。
REFUTER(CONFIRMED,low): 不对称属实，但危害上限只能静态推断，故降一级。WorkerTransport.ts:96-98 `export function createNodeProcessWorkerTransport(proc: ChildProcess): WorkerTransport { // RPC uses Node IPC; drain ordinary stdout so tool/extension logs cannot fill its pipe. proc.stdout?.resume();`；:54-90 的 createUtilityProcessWorkerTransport 全篇只有 `onStderr(listener) { return subscribeReadable(proc.stderr, listener); }`（:81-83），从不触碰 proc.stdout。PiWorkerProcess.ts:94-100 确实 `utilityProcess.fork(entryPath, [], { ..., stdio: 'pipe', ... })`（审查员给的 :221-227 行号错，文件只有 105 行，但内容一致）。Electron 类型定义证实两路都成管道：electron.d.ts:20662-20670「Allows configuring the mode for `stdout` and `stderr` of the child process」，:15103-15109「stdout: NodeJS.ReadableStream | null ... If the child was spawned with options.stdio[1] set to anything other than 'pipe', then this will be null」，即 stdout 非 null 且无读者。测试替身缺口属实：__tests__/WorkerTransport.test.ts:15-20 的 FakeUtilityProcess 只有 `stderr = new PassThrough();`，没有 stdout 字段。降级理由：本仓生产代码没有 stdout 写者（src/runtime 下的 console.log 命中只在 spikes/ 与 smoke/ 这两类开发脚本），MCP 服务器是 worker 的孙进程、写自己的管道；真实后果（内存增长还是写阻塞卡住 worker）取决于 Electron 对 utilityProcess stdout 的实现，本机无法判定——这部分是静态推断，须批次 E 上机验。
WAIVER(none): 无取舍 — 核对来源：docs/plans/2026-09-08-runtime-evolution-ard.md；相关原文：「但载体不再固定是 utilityProcess：Windows 安装版使用随包 Node + 原生 IPC，其余平台与开发模式使用 utilityProcess + MessagePort，由 WorkerTransport 适配同一套 RPC 协议。」

### [main-host-05] LOW dead-code confirmed | P4-3 | src/main/services/agent-host/WorkerManager.ts:1881 | 整条 tier 通道自 D14 之后没有生产者，注释却仍把它写成现行的 U12 修复；Main 还不校验 worker 的 applied 回答
DESC: D14 把权限从四档 tier 改成 mode + gear 两轴之后，渲染层只发 permissions、不再发 tier：ChatComposer.tsx:1315-1316 只组装 spawnPermissions，sessionIndex/useResumeSession.ts:39-43 只传 permissions，全仓渲染层对 setPermissionTier 的引用只剩三处注释与测试说明。于是这条链每一环都没有活的生产者：preload/index.ts:1073 暴露的 setPermissionTier、IPC_CHANNELS.CHAT_SET_PERMISSION_TIER、src/main/ipc/chat.ts:562-575 的 handler、chat.ts:190 的 spawnTier()（永远返回 {}）、ManagedSlot.tier、spawnForEntry 的 ...(entry.tier ? { tier } : {})、worker.setPermissionTier RPC 与 PiWorkerRuntime.setPermissionTier。而 ManagedSlot.tier 上那段 U12 注释（WorkerManager.ts:130-142）把它描述成「让 chip 与 runtime 不再漂移」的现行修复——真正做这件事的是 permissions。附带两处实现不一致一并记此：(1) setPermissionTier 完全不看 RPC 返回值，既不 isWorkerSetPermissionTierResult 也不查 applied，而同类的 setPermissions 对同一种回答会抛 worker_permission_not_applied（:1870-1874）；(2) setPermissionTier 在发 RPC 之前就把 entry.tier 与 entry.permissions 写死，setPermissions 是成功之后才写（:1877），后者的语义被 WorkerManager.test.ts:1428 钉住，前者没有对应用例。
EVIDENCE: // WorkerManager.ts:1881-1901
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

// src/main/ipc/chat.ts:190-196（唯一的 tier 生产点，渲染层从不传 payload.tier）
function spawnTier(tier: unknown): { tier?: SessionPermissionTier } {
  if (tier === undefined) return {};
SCENARIO: 两个方向都是维护成本而不是当前故障。(1) 接手的人读 ManagedSlot.tier 上那段 U12 注释，会以为 chip 的持久化走的是 tier，改 chip 行为时改错地方。(2) window.electronAPI.chat.setPermissionTier 仍是暴露给渲染层的可调用面，任何新代码调它，都会在 worker 侧因 assertIdle（nativeWorkerRuntime.ts:803 → :847，回合中抛 WORKER_SESSION_BUSY）而失败，但 Main 已把 entry.tier / entry.permissions 写成新值——此刻 Main 的记录与 worker 的实际授权不一致，且 createSession 热路径正是拿 entry.permissions 与入参比较来决定要不要补推（:674-679），比较相同就不补推，漂移会一直留到这个 worker 被换掉。
FIX: 按「哪些代码因为 legacy / D14 走了而失去消费者」重新画线，整条 tier 通道连同 preload 方法、IPC channel、spawnTier、ManagedSlot.tier、worker.setPermissionTier 与 runtime 侧实现一并退役（与 T025 删 sessionKeysMatch / leafCheckpoint 同类）。若决定保留，至少把两处不一致对齐到 setPermissions 的语义：先 RPC 成功、校验 applied、再写 entry。
REFUTER(CONFIRMED,low): 推不翻，用 grep -a 复核（含二进制源文件）后仍无活的生产者。渲染层：ChatComposer.tsx:1315-1316 只组装 `const spawnPermissions = readSessionPermissions(sessionId) ?? readDefaultPermissions() ?? undefined;`；useResumeSession.ts:38-44 只传 `...(storedPermissions ? { permissions: storedPermissions } : {})`，resumeIntent.ts:118 的 `...(options.tier ? { tier: options.tier } : {})` 因此永远拿不到 tier；全仓非测试文件里 setPermissionTier 的命中只剩 preload/index.ts:1073-1077、shared/types/ipc.ts:370、main/ipc/chat.ts:563-572、WorkerManager.ts:1881、workerRpc.ts:670、piWorkerRpcServer.ts:431/923、nativeWorkerRuntime.ts:796 这一条自上而下无人调用的链。两处不一致原文属实：WorkerManager.ts:1887-1890 `if (entry) { entry.tier = tier; entry.permissions = migratePermissionTier(tier); }` 在 RPC 之前写，且 :1893-1897 的 `await entry.slot.request<...>('worker.setPermissionTier', payload)` 返回值完全不校验，而同类的 setPermissions 在 :1870-1874 有 `if (!isWorkerSetPermissionTierResult(result) || !result.applied) throw new WorkerManagerError('worker_permission_not_applied', ...)`、:1877 才写 entry。ManagedSlot.tier 上的 U12 注释（:131-142「so both paths stop drifting from what the composer chip shows」）确实描述的是现已由 permissions 承担的职责。T016 只修了 worker 侧「不谎报」，没碰 Main 的校验缺口。严重级 low（死代码 + 注释不符 + 测试缺口；漂移场景需要有人重新调用这条无人使用的 API）。
WAIVER(none): 无取舍 — 核对来源：docs/plans/2026-09-08-runtime-evolution-ard.md；相关原文：「D14 · 权限与模式分成两根轴：模式管工具集，档位管打扰程度」

### [main-host-06] LOW dead-code confirmed-partial-waiver | P4-0 | src/main/services/agent-host/index.ts:1 | 目录桶文件零导入者，它是 NodeRuntimeResolver 唯一的引用来源，而后者也没有生产调用方
DESC: src/main/services/agent-host/index.ts 把 14 个符号重新导出，但全仓没有任何文件从这个桶导入——所有消费者都直接 import 具体模块（../services/agent-host/WorkerManager、../agent-host/PiUtilityService 等，共 20 余处）。连带后果是 NodeRuntimeResolver.ts（约 260 行，含 win32 分支、node.exe 拼接、--version 探测与 process.execPath 回读）在生产链路上没有任何调用方：resolveNode24Runtime 只被这个桶重新导出，以及被它自己的测试调用。打包 Windows 的 Node 运行时是在 PiWorkerProcess.ts:209 直接拼 process.resourcesPath/node-runtime/node.exe 解决的，没有走这个解析器。
EVIDENCE: $ grep -rn "agent-host/index\|from '.*services/agent-host'" src/ scripts/   # 无命中
$ grep -rn "resolveNode24Runtime" src/ scripts/
src/main/services/agent-host/index.ts:9
src/main/services/agent-host/__tests__/NodeRuntimeResolver.test.ts:2,10,26,38,59

// PiWorkerProcess.ts:206-210（打包 Windows 的实际做法，不经 NodeRuntimeResolver）
if (app.isPackaged && process.platform === 'win32') {
  const nodePath = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
  if (!existsSync(nodePath)) throw new Error(`Pi Node runtime is missing: ${nodePath}`);
SCENARIO: 排查 Windows 上「找不到 Node 运行时」这类问题的人会先读 NodeRuntimeResolver.ts（名字最像、还有专门的测试），花时间读完一条产品从不执行的解析逻辑；真正决定行为的是 PiWorkerProcess.ts:209 的一行拼接。批次 E 的 Windows 检查单若照着 NodeRuntimeResolver 列项，会验错对象。
FIX: 删掉 index.ts 桶文件；随后按「NodeRuntimeResolver 是否还要」单独决策——不要就连同测试删除；要就把它真正接到 forkPiWorkerProcess 的 win32 分支上，让代码与测试指向同一条路。
REFUTER(CONFIRMED-PARTIAL-WAIVER,low): 推不翻，且我用 grep -a（规避「二进制源文件被跳过」的坑）复核过：对 src/scripts/electron.vite.config.ts 跑 `from '…agent-host'` / `agent-host/index` 正则零命中，桶文件 src/main/services/agent-host/index.ts 的 40 余行 re-export 无人导入。resolveNode24Runtime 的全仓命中只有三处：定义 NodeRuntimeResolver.ts:50、桶文件 index.ts:9-10、以及自己的 __tests__/NodeRuntimeResolver.test.ts（:2/10/26/38/59）；该文件 288 行，含 REQUIRED_NODE_MAJOR=24（:15）与 explicit → AICLIENT_NODE24_PATH → 版本管理器 → PATH 的整套探测（:47-49 注释）。产品路径确实不经它：PiWorkerProcess.ts:78-83 `if (app.isPackaged && process.platform === 'win32') { const nodePath = path.join(process.resourcesPath, 'node-runtime', 'node.exe'); if (!existsSync(nodePath)) throw new Error(...)`（审查员给的 :206-210 行号错，实际在 :78-83，文件共 105 行；内容一致）。roadmap.md:101 的 T031 已把 NodeRuntimeResolver 列进批次 E 检查单，正好印证「照着它列检查项会验错对象」的风险尚未消除。严重级 low（死代码 / 误导，无运行期行为）。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-hardening/roadmap.md 第 101 行（T031）；原文：「T031 | 并发、容量与 Windows 静态面：多会话写锁/runs.jsonl/技能缓存/MCP 进程数；NodeRuntimeResolver、taskkill 路径、路径拼接与 glob 展开、会话文件路径……| 批评者缺口 12/13/14/15/16 | 形成批次 E 的检查单 |」

### [main-host-07] LOW dead-code confirmed | P4-3 | src/main/services/agent-host/WorkerSlot.ts:240 | replaceCrashedTransport 与整个 replacing 状态机只有测试在用，方法注释却说策略归 WorkerManager
DESC: WorkerSlot 为「崩溃后就地换一个传输」保留了一整套机制：replaceCrashedTransport、replaceTransportInternal、replacementPromise 字段、WorkerSlotState 里的 'replacing' 分支，以及 disposeInternal 开头等待 replacementPromise 的那一段。生产链路不用它：WorkerManager.restartEntry 的做法是 await oldSlot.dispose('slot-replace')，然后 entry.generation += 1、entry.slot = null、spawnForEntry 建一个全新的 WorkerSlot（WorkerManager.ts:2543-2560）。全仓 replaceCrashedTransport 的调用方只有 WorkerSlot.test.ts 的五处。方法上的注释「Restart budgeting and policy are owned by WorkerManager (T30)」会让读者以为 WorkerManager 在驱动它。
EVIDENCE: $ grep -rn "replaceCrashedTransport" src/
src/main/services/agent-host/WorkerSlot.ts:240
src/main/services/agent-host/__tests__/WorkerSlot.test.ts:468,484,506,507,528

// WorkerSlot.ts:235-240
/**
 * Attach a replacement process after a crash. Restart budgeting and policy are
 * owned by WorkerManager (T30); this method only advances the generation and
 * makes stale callbacks from the retired process harmless.
 */
replaceCrashedTransport(transport: WorkerTransport): Promise<number> {
SCENARIO: 有人按注释的指引去 WorkerManager 里找「重启预算怎么调用替换」，找不到；或者在改崩溃恢复时以为要同时维护「就地替换」与「重建槽位」两条路径，给一条永远走不到的分支写新逻辑与新用例。同类风险已在 T025 的清扫里出现过一次（sessionKeysMatch / leafCheckpoint）。
FIX: 与 main-host-05 / 06 一起纳入「P6-5 清扫的另一半」：删除 replaceCrashedTransport、replaceTransportInternal、replacementPromise、'replacing' 状态与 disposeInternal 里等待替换的那一段，连同 WorkerSlot.test.ts 的五条用例；类注释同步改成「一个槽位只服务一个传输，替换由 WorkerManager 重建槽位完成」。若要保留，就把注释改成「目前无生产调用方，保留原因是 X」。
REFUTER(CONFIRMED,low): 推翻失败，代码与历史都支持审查员。(1) 调用面：全仓（排除 node_modules/.git）grep `replaceCrashedTransport` 只命中三个文件——`src/main/services/agent-host/WorkerSlot.ts:240` 的定义、`src/main/services/agent-host/__tests__/WorkerSlot.test.ts:468/484/506/507/528` 五处用例，以及批次 D 自己的审查笔记 `raw/main-host.md`。scripts/ 与 docs/ 无其他引用，该方法也没有经 `src/main/services/agent-host/index.ts` 导出给外部（导出的是 WorkerSlotDiagnostic 等类型）。(2) 生产替换走的是另一条路：`WorkerManager.ts:2541-2546` 的 restartEntry 是 `await oldSlot.dispose('slot-replace'); this.ownedSlots.delete(oldSlot);` 然后 `entry.generation += 1; entry.slot = null;` 再 `await this.spawnForEntry(...)`，spawnForEntry 在 `WorkerManager.ts:1996` 调 `this.createSlot(...)`，而 `createPiWorkerSlot.ts:72` 是 `new WorkerSlot({...})`，即整只槽位重建，永远不会把旧槽位推进 'replacing'。(3) 随之只有测试能到达的还有 `WorkerSlot.ts:158` 的 `private replacementPromise`、`:303` 的 `replaceTransportInternal`、`:13-15` WorkerSlotState 的 `'replacing'` 分支及其在 `:312/341/506/578` 的判断，以及 `disposeInternal` 开头 `:351-357` 的 `if (this.replacementPromise) { try { await this.replacementPromise } catch {...} }`。(4) 未被批次 A～C 修掉：`git log -S"replaceCrashedTransport" -- src/main/services/agent-host/` 只有 2026 年更早的 `61159b44`，WorkerSlot.ts 最近一次改动是 `3192d580`（2026-09-02），都早于 T001～T036；T025 死代码清扫（roadmap 第 39 行，提交 `45a7a347`）的清单里列的是 bundledFeaturePlugins / extensionInventory / sessionKeysMatch / leafCheckpoint 等，不含本机制。(5) 注释确实有误导：`WorkerSlot.ts:235-239` 写着 “Restart budgeting and policy are owned by WorkerManager (T30)”，而 WorkerManager 里没有任何调用点。严重级同意 low：只是死代码 + 注释不符，无运行时后果。
WAIVER(none): 无 — docs/plantree/plans/runtime-hardening/roadmap.md

### [main-host-08] LOW dead-code confirmed | P4-3 | src/main/services/agent-host/WorkerManager.ts:2030 | 五种 WorkerSlotDiagnostic 没有任何生产消费者，协议不匹配与半帧在生产里只剩「RPC 超时」这一个症状
DESC: WorkerSlot 产出五类诊断：malformed-message、protocol-mismatch、stale-generation、unknown-response、late-transport-event（WorkerSlot.ts:50-55，产出点在 :502/511/520/524/532/541/547）。createPiWorkerSlot 老老实实把 onDiagnostic 透传下去（createPiWorkerSlot.ts:81），但没有任何生产调用方提供它：WorkerManager.spawnForEntry 只传 onSlotCreated / onEvent / onLifecycle / onStderr（WorkerManager.ts:2014-2030），PiUtilityService.ts:114 与 PiImportProcess.ts:36/64/95 直接 new WorkerSlot(...) 也都不传。唯一的消费者是 WorkerSlot.test.ts（:156/235/256/520）。于是这些故障在生产里既不进日志、也不进 trace、也不发事件。
EVIDENCE: // WorkerManager.ts:2014-2030（spawnForEntry 提供的回调，没有 onDiagnostic）
onSlotCreated: (slot) => { ... },
onEvent: (event) => { ... },
onLifecycle: (event) => { ... },
onStderr: (chunk, generation) => this.absorbStderr(entry, generation, chunk),

// WorkerSlot.ts:523-530
if (record.protocolVersion !== WORKER_RPC_PROTOCOL_VERSION) {
  this.onDiagnostic?.({ type: 'protocol-mismatch', generation, received: record.protocolVersion });
  return;
}
SCENARIO: 应用升级后 WORKER_RPC_PROTOCOL_VERSION 变了，而打包产物里的 agent-host/worker.js 因为某次构建过滤没跟着更新（这类打包过滤陷阱本仓出过一次）。Main 发出的每个请求都收到旧版本的响应，全部在 handleMessage 第一道闸被丢弃；用户看到的是 worker.bootstrap timed out after 60000ms，日志、trace、stderr 里没有一个字提到「协议版本不匹配」。排查者只能靠猜，而这条信息已经被算出来了、就在 received 字段里。
FIX: 在 spawnForEntry 里接上 onDiagnostic，至少 this.log(...)；protocol-mismatch 与连续多次 malformed-message 值得升到 console.error（与 dumpWorkerStderr 同一档，因为出厂配置下文件日志是关的）。PiUtilityService 与 PiImportProcess 三处同理。若认为不值得接，就把 WorkerSlotDiagnostic 整套删掉，别留一个看起来在工作的诊断面。
REFUTER(CONFIRMED,low): 推翻失败。(1) 诊断产出点确实存在且五类齐全：`WorkerSlot.ts:50-55` 定义 malformed-message / protocol-mismatch / stale-generation / unknown-response / late-transport-event，产出在 `:502`、`:511`（isCurrentTransport 的两处 late-transport-event）、`:520`、`:524`（`if (record.protocolVersion !== WORKER_RPC_PROTOCOL_VERSION) { this.onDiagnostic?.({ type: 'protocol-mismatch', generation, received: record.protocolVersion }); return; }`）、`:532`、`:541`、`:547`，全部是「发诊断后直接 return 丢弃这条消息」，没有别的日志或事件出口。(2) 透传链在，但生产端没人接：`createPiWorkerSlot.ts:31` 声明 `onDiagnostic?: WorkerSlotOptions['onDiagnostic']`、`:81` 原样转给 WorkerSlot；`WorkerManager.spawnForEntry`（`WorkerManager.ts:1996-2030`）传的是 onSlotCreated / onEvent / onLifecycle / onStderr 四个回调，没有 onDiagnostic（而 `WorkerManager.ts:351/390` 的 createSlot 类型就是 `typeof createPiWorkerSlot`，说明这是「可传而未传」）；另两处直接 new WorkerSlot 的生产调用同样不传——`PiUtilityService.ts:114-122` 只给 onEvent / onLifecycle，`PiImportProcess.ts:36/64/95` 三处连回调都只有 requestTimeoutMs。(3) 全仓唯一消费者是 `__tests__/WorkerSlot.test.ts:156/235/256/520`，加上批次 D 自己的笔记文件；`src/shared/types/remote.ts` 与 RemoteConnectionManager 里的 Diagnostic 是远程连接的另一套，不相干。(4) 未被批次 A～C 修：`git log -S"onDiagnostic" -- src/main/` 只有 `61159b44` 与 `de57ef00`（远程那套），都早于本轮加固；T016（worker 生命周期，`a9ea7230`）与 T025 的落地记录里也没有接诊断这一项。(5) 后果如审查员所述：协议版本不匹配的响应在 `handleMessage` 第一道闸就被丢，请求只能走到 pendingRequest 超时，日志 / trace / stderr 三处都不会出现 received 到的版本号。严重级我按 low 记：这是可观测性缺口 + 一个「看起来在工作实则无人订阅」的诊断面，不改变功能正确性，也不构成安全或数据问题；只是排查协议不匹配 / 半帧时会白白多花时间。
WAIVER(none): 无 — docs/plantree/plans/runtime-hardening/roadmap.md

### [utility-04] LOW i18n confirmed | P6-2（产品消费者面） | src/renderer/components/source-control/CommitBox.tsx:61 | 三个功能把引擎内部英文错误串直接当提示文案，只有恰好等于 'timeout' 的那一种被翻译（审查员原判 medium）
DESC: 这条链上所有失败都以 PiUtilityServiceError.message 的原文向用户显示。翻译只覆盖一个字面量 'timeout'——它来自 PiUtilityService.ts:363 的三元表达式，是一个没有测试钉住的跨层文案约定。其余全部原样透出：WORKER_MODEL_NOT_FOUND: ...、WORKER_INVALID_PAYLOAD: ...、Worker request utility.start timed out after 10000ms、Worker exited (code=1 signal=null)、Too many AI utility operations are already running。对照物就在同一仓库：chat 面为 WORKER_MODEL_NOT_FOUND 专门做了一张带迁移引导的中文卡（modelMissingError.ts），三个 AI 功能一张也没有。容量类失败尤其难懂：capacity 默认 2 被三个功能共享，界面上没有任何地方说明是谁占着名额。
EVIDENCE: // src/renderer/components/source-control/CommitBox.tsx:59-61
toastManager.add({
  title: t('Failed to generate commit message'),
  description: result.error === 'timeout' ? t('Generation timed out') : result.error,

// src/main/services/agent-host/PiUtilityService.ts:359-365（'timeout' 字面量的唯一产地）
this.settleFailure(record, new PiUtilityServiceError(
  code, record.timedOut ? 'timeout' : terminal.error || `Pi utility ${terminal.state}`));
// :137-141
throw new PiUtilityServiceError('PI_UTILITY_CAPACITY_EXCEEDED',
  'Too many AI utility operations are already running');

// src/renderer/components/chat/modelMissingError.ts:24（chat 面的对照实现）
export const MODEL_MISSING_CODE_TOKEN = 'WORKER_MODEL_NOT_FOUND';
SCENARIO: 中文界面用户在评审跑着（占 1 个名额）的同时生成提交信息（第 2 个），再去新建 worktree 点「生成分支名」。分支名输入框下方红字显示 `Too many AI utility operations are already running`。同一用户若模型被下架，另一次点击得到 `WORKER_MODEL_NOT_FOUND: model is unavailable or has no configured authentication: pilab/x`。两条都不是这个应用的界面语言，也都不含任何可执行的下一步。
FIX: 把 PiUtilityServiceError.code 透到渲染层（现在只有 message 过得去），在渲染层按 code 查词典出中文文案与下一步建议——PI_UTILITY_CAPACITY_EXCEEDED 说「另一个 AI 任务正在运行，稍后再试」，WORKER_MODEL_NOT_FOUND 复用 MODEL_MISSING_ERROR_VIEW 的现成文案。若不改协议形态，至少把 'timeout' 这个字面量约定提成共享常量并补一条用例钉住。
REFUTER(CONFIRMED,low): 文案链属实，但只是显示层缺口、功能本身没错，故我降一级到 low。CommitBox.tsx:59-62 `description: result.error === 'timeout' ? t('Generation timed out') : result.error`，CreateWorktreeDialog.tsx:359-363 同形；i18n 只有 shared/i18n.ts:1311 `'Generation timed out': '生成超时'` 这一条覆盖，其余 error 原样落地。原文串确实是英文且来自引擎内部：PiUtilityService.ts:137-140 `'Too many AI utility operations are already running'`，:359-365 `record.timedOut ? 'timeout' : terminal.error || \`Pi utility ${terminal.state}\``（'timeout' 字面量的唯一产地，跨层约定且无用例钉住），WorkerSlot.ts:431 `Worker request ${pending.method} timed out after ${timeoutMs}ms`，:564 `${message.error.code}: ${message.error.message}` 让 WORKER_MODEL_NOT_FOUND / WORKER_INVALID_PAYLOAD 带着码上浮。code 确实过不来：ipc/git.ts:362 返回类型只有 `{ success, message?, error? }`，commit-message.ts:117 `error: error instanceof Error ? error.message : String(error)`。对照物存在：modelMissingError.ts:24 `export const MODEL_MISSING_CODE_TOKEN = 'WORKER_MODEL_NOT_FOUND';` 是 chat 面专做的中文引导，三个 AI 功能一处都没接。容量场景可构造：PiUtilityService.ts:104 `this.capacity = positiveInteger(options.capacity ?? 2, ...)`，三个功能共用同一个 `piUtilityService` 单例（:394），第三个并发请求必撞 :137。
WAIVER(none): 无 — (未找到)

### [utility-05] LOW correctness confirmed | P6-2（产品消费者面） | src/main/services/ai/branch-name.ts:27 | 分支名不过 stripCodeFence（同目录的提交信息过），围栏答案会原样写进分支名与 worktree 路径（审查员原判 medium）（静态推断）
DESC: providers.ts 里 stripCodeFence 的注释明写「Remove an optional Markdown fence from a Pi one-shot completion」——即这条链的模型输出预期可能带围栏。commit-message.ts:115 用了它，branch-name.ts:27 只做了 .trim()。三个功能里分支名恰恰对格式最敏感：结果直接进输入框，再经 buildWorktreePath 拼成文件系统路径（CreateWorktreeDialog.tsx:271 → shared/defaultPaths.ts:117-136，全程无字符白名单）。多行答案同理，trim() 不会去掉中间的换行。static_inference：围栏发生的频率要一次真实模型回合才能观察，但两个模块处理不对称是代码事实。
EVIDENCE: // src/main/services/ai/branch-name.ts:20-27
const completion = await piUtilityService.complete({ ... });
return { success: true, branchName: completion.text.trim() };

// src/main/services/ai/commit-message.ts:115（同目录对照）
return { success: true, message: stripCodeFence(completion.text) };

// src/main/services/ai/providers.ts:1-2
/** Remove an optional Markdown fence from a Pi one-shot completion. */
export function stripCodeFence(text: string): string {
SCENARIO: 用户在新建 worktree 对话框输入中文描述、点「生成分支名」。模型（尤其 effort 较高、倾向解释的模型）回一段带三反引号的围栏块。分支名输入框被填成带反引号和换行的字符串，用户点「创建」后 git worktree add -b 直接失败，报的是 git 的分支名非法错误，看不出是生成环节的问题。
FIX: branch-name.ts 先过 stripCodeFence，再取第一行非空内容，最后按分支名字符白名单（[a-z0-9._/-]）过滤并压缩连续分隔符——提示词里已写了这套规则，只是没在代码里兜底。补三条纯函数用例（围栏、多行、越界字符）。
REFUTER(CONFIRMED,low): 不对称是代码事实：branch-name.ts:18-27 `const completion = await piUtilityService.complete({...}); return { success: true, branchName: completion.text.trim() };` 只有 trim，整个文件没有 import providers；commit-message.ts:5 `import { stripCodeFence } from './providers';`、:115 `return { success: true, message: stripCodeFence(completion.text) };`。围栏在这条产品链上有历史前科，不是空想：git log 里 29bca3d8 `fix(ai): 剥离 CLI 返回的 commit message 外层的 markdown 代码围栏 (#310)` 就是 stripCodeFence 的由来，providers.ts:1 的注释也写着 'Remove an optional Markdown fence from a Pi one-shot completion'。下游确实无兜底：CreateWorktreeDialog.tsx:356-357 `if (result.success && result.branchName) setNewBranchName(result.branchName.trim());`，handleSubmit（:247-278）只判 `if (!newBranchName)`，随后 `path: getWorktreePath(newBranchName)` → defaultPaths.ts:117-136 buildWorktreePath 全程只做 joinPath，无字符白名单。提示词里那套规则确实只写在 prompt 里（settings/defaults.ts:140-141 '只输出一行分支名，无解释无标点'、'仅允许 a-z0-9-/.'），代码侧零兜底。我把级别压到 low：生成结果落在用户可见可编辑的分支名输入框里，创建前能被看到并改掉，失败形态是 git 报非法分支名而非数据损坏。静态推断部分同审查员所述——围栏出现频率需真实回合才能观察。
WAIVER(none): 无 — (未找到)

### [utility-07] LOW contract-gap confirmed | P6-2（产品消费者面） | src/main/services/agent-host/PiUtilityService.ts:169 | 两端超时共用同一个 timeoutMs、没有先后余量，与 /compact 明确写下的「顺序即契约」相反；worker 侧那份实际上永远轮不到 → 并入 utility-01
DESC: input.timeoutMs 同时充当两个角色：Main 的看门狗（:169-173 的 setTimeout）和 worker 交给 streamSimple 的请求超时（nativeUtility.ts:248）。两个数字完全相同、没有余量。Main 的表在 fork 之前就起跑，worker 的表要等进程起来、RPC 应答、模型调用发出才开始，所以 Main 必然先到——streamSimple 的 timeoutMs 成了一份永远触发不到的配置。T016 为 /compact 处理过同一类问题并把结论写成注释：「the order of the two numbers is the contract」，用 WORKER_COMPACT_BUDGET_MS(45s) < WORKER_COMPACT_REQUEST_TIMEOUT_MS(60s) 两个共享常量表达；utility 路径没有对应表达。附带后果：用户配的 120 秒里，冷启动那几秒是从模型可用时间里扣的。
EVIDENCE: // src/main/services/agent-host/PiUtilityService.ts:168-173（Main 的表，在 slot.request 之前起跑）
const result = new Promise<PiUtilityCompletionResult>((resolve, reject) => {
  const timeout = setTimeout(() => { ... void this.cancelRecord(record, 'timeout'); }, input.timeoutMs);

// src/runtime/worker/nativeUtility.ts:246-248
{ signal: active.controller.signal,
  timeoutMs: active.input.timeoutMs,

// src/shared/types/workerRpc.ts:310-318（对照：compact 把顺序写成契约）
 * the worker aborts its own summary FIRST, and only then does Main stop waiting ...
export const WORKER_COMPACT_BUDGET_MS = 45_000;
export const WORKER_COMPACT_REQUEST_TIMEOUT_MS = 60_000;
SCENARIO: 并非直接的用户故障，而是一条失效的兜底：当 Main → worker 的 utility.cancel 因为 worker 事件循环繁忙而迟到时，本应由 worker 自己的 streamSimple 超时兜底收尾；但因为它的截止时间晚于 Main 的，Main 已经先判超时并拆掉 slot，这份兜底从来没有机会生效。
FIX: 照 compact 的形态给 utility 也定两个数：worker 侧用 timeoutMs、Main 侧用 timeoutMs + 余量（按冷启动量级取 5～10 秒），并把 Main 的表改到 utility.start 应答之后再起跑，使用户配置的时长真正等于模型的可用时长。
REFUTER(CONFIRMED,low): 无法推翻。PiUtilityService.ts:158-183：先 `const slot = this.createSlot({...})`（默认实现里就是 forkPiWorkerProcess，进程在此刻才开始起），紧接着在 Promise 构造里 `const timeout = setTimeout(() => { record.timedOut = true; void this.cancelRecord(record, 'timeout'); }, input.timeoutMs)`，之后才 `await slot.request('utility.start', { ... timeoutMs: input.timeoutMs })`（:189-199）。worker 侧 nativeUtility.ts:239-250 把同一个数字原样交给 `resolved.models.streamSimple(..., { signal, timeoutMs: active.input.timeoutMs, ... })`，而 pi-ai 的语义是 HTTP 请求超时（src/runtime/node_modules/@earendil-works/pi-ai/dist/types.d.ts:88-91 注释 'HTTP request timeout in milliseconds'，:141 说连接后的空闲也按 timeoutMs 计），计时起点必然晚于 Main 的 setTimeout（差一个 fork + RPC 往返 + 模型请求发出的时间），所以 worker 那份到期永远晚于 Main，且 Main 到期后走 cancelRecord→settleFailure→disposeRecordSlot（:383-389）直接把 slot dispose 掉，worker 的兜底确实没有机会生效。对照组的契约确实只写在 compact 上：src/shared/types/workerRpc.ts:305-318 'The order of the two numbers is the contract: the worker aborts its own summary FIRST, and only then does Main stop waiting'，两个常量 WORKER_COMPACT_BUDGET_MS=45_000 < WORKER_COMPACT_REQUEST_TIMEOUT_MS=60_000，并被 WorkerManager.test.ts:2058 钉住；utility 路径没有任何等价表达。批次 A~C 未修：git log 对该文件最近一次是 a9ea7230（T016 '……utility 交付模型目录'），改的是模型目录交付而非超时分层。实际危害小（真实取值：branch-name.ts:25 / commit-message.ts:113 用用户配置秒数，code-review.ts:105 固定 10 分钟，冷启动只吃掉其中几秒），故维持 low。
WAIVER(none): 无 — (未找到)

### [utility-08] LOW test-gap confirmed | P6-2（产品消费者面） | src/main/services/ai/index.ts:1 | 三个功能的产品侧代码零测试：src/main/services/ai/* 与 stores/codeReview.ts 一条用例都没有
DESC: 全仓搜索 stripCodeFence / generateCommitMessage / startCodeReview / generateBranchName 在 *.test.ts(x) 中零命中。这意味着输出解析（stripCodeFence 正则、分支名 trim）、提示词模板的单次替换（commit-message.ts:91-95 那条防注入替换）、评审的 git 前置与「无变更」短路、渲染层评审 store 的 reviewId 过滤与清理函数，全部只有类型检查在保。PiUtilityService.test.ts 的 6 条用例也没覆盖超时分支（record.timedOut）、崩溃分支（handleLifecycle）、forceKillAllNow、重复 operationId，而超时分支正是 utility-04 里那个 'timeout' 文案约定的唯一产地。
EVIDENCE: $ grep -rln "stripCodeFence\|generateCommitMessage\|startCodeReview\|generateBranchName" --include=*.test.ts --include=*.test.tsx src/
（无输出）

// src/main/services/agent-host/__tests__/PiUtilityService.test.ts:113-277
// 6 条：流式+回收 / 取消 / invalidateAll / 交付目录 / 不交付目录 / 容量
SCENARIO: 任何人改动 stripCodeFence 的正则、或把 PiUtilityService.handleTerminal 里 'timeout' 改成别的词，测试全绿，而提交框会静默退回显示英文原串。
FIX: 给 providers.ts 补纯函数用例（无围栏 / 带语言标签的围栏 / 只有开头围栏 / 空串）；给 PiUtilityService 补假时钟的超时用例（断言 code === 'PI_UTILITY_TIMEOUT' 且 message === 'timeout'）与崩溃用例；给 stores/codeReview.ts 补 reviewId 过滤与 stopCodeReview 清理的用例。
REFUTER(CONFIRMED,low): 无法推翻。二进制安全重跑（grep -ral，规避本仓存在含裸 NUL 源文件的问题，已确认 src/main、src/renderer 下确有此类文件如 src/main/index.ts）：`grep -ral 'stripCodeFence|generateCommitMessage|startCodeReview|generateBranchName|stores/codeReview' --include=*.test.ts --include=*.test.tsx src/` 退出码 1、零输出；`src/main/services/ai/__tests__` 目录不存在（该目录下只有 branch-name.ts / code-review.ts / commit-message.ts / index.ts / providers.ts）；src/renderer/stores/__tests__ 的 28 个文件里没有 codeReview 相关用例。PiUtilityService.test.ts 共 278 行、6 条 it（:114 流式+回收、:141 取消、:162 invalidateAll、:203 交付目录、:232 不交付目录、:255 容量），确实没有超时分支（PiUtilityService.ts:168-172 的 setTimeout 与 :353-361 record.timedOut 分支）、崩溃分支（:333-341 handleLifecycle）、forceKillAllNow（:255-267）与重复 operationId（:151-156）的覆盖。审查员点名的 'timeout' 文案产地确认在 :356-364：`record.timedOut ? 'timeout' : terminal.error || ...`，改词无测试会红。属测试缺口，low。
WAIVER(none): 无 — (未找到)

### [utility-09] LOW correctness confirmed | P6-2（产品消费者面） | src/renderer/components/source-control/CodeReviewModal.tsx:305 | 评审弹窗标题把模型设置原样渲染，默认「自动」时显示一对空括号
DESC: 标题里 ({codeReviewSettings.model}) 直接插了设置值。defaultCodeReviewSettings.model 是 ''（对应界面上的「自动」），所以未选模型的默认安装打开评审弹窗，标题是「代码评审 ()」。另外这里读的是设置里的 id 而不是本次实际使用的模型——引擎在终端事件里回了 model（nativeUtility.ts:101、:294），PiUtilityService 也把它带回了 PiUtilityCompletionResult.model（:40-43），但代码评审路径把整个返回值丢弃（code-review.ts:99 的 await 没有接结果），所以「自动」时界面永远无法显示真正用了哪个模型。
EVIDENCE: // src/renderer/components/source-control/CodeReviewModal.tsx:303-306
{t('Code Review')}
<span className="text-muted-foreground font-normal">
  ({codeReviewSettings.model})
</span>

// src/renderer/stores/settings/defaults.ts:145-147
export const defaultCodeReviewSettings: CodeReviewSettings = { enabled: true, model: '', ... };

// src/main/services/ai/code-review.ts:99（返回值被丢弃）
await piUtilityService.complete({ ... });
SCENARIO: 全新安装、没改过 AI 设置的用户打开代码评审弹窗，标题显示「代码评审 ()」。
FIX: model 为空时不渲染这段括号（或显示 t('Automatic')）；更进一步，把 complete() 返回的实际 model 经 onComplete 回传给渲染层，标题显示这次真正用的模型。
REFUTER(CONFIRMED,low): 无法推翻，代码原文一致。CodeReviewModal.tsx:302-306 `{t('Code Review')}<span className="text-muted-foreground font-normal">({codeReviewSettings.model})</span>`，值取自 :139 `useSettingsStore((s) => s.codeReview)`；defaults.ts:143-150 `defaultCodeReviewSettings = { enabled: true, model: '', effort: 'high', ... }`，且设置页 AISettings.tsx:38 的「自动」在 onChange 里写回的就是空串（`onChange(next === AUTOMATIC ? '' : next)`，:52-53），所以默认安装或用户主动选「自动」时标题就是「代码评审 ()」。第二半也成立：code-review.ts:99-110 `await piUtilityService.complete({ ... })` 后直接 `onComplete()`，返回值未接；而 PiUtilityService.ts:39-42 的 PiUtilityCompletionResult 确有 `model?: string`，:344-350 completed 分支也把 terminal.model 带了回来——即引擎知道实际模型、产品侧丢弃。纯展示缺陷，无功能损坏，low。
WAIVER(none): 无 — (未找到)

### [utility-10] LOW robustness confirmed | P6-2（产品消费者面） | src/renderer/components/settings/AISettings.tsx:113 | AI 设置页硬编码宿主状态为 ready 并丢弃目录状态行，目录不可用时模型菜单只剩「自动」且不作任何说明
DESC: usePiModelCatalog 的第一个参数是宿主状态，作用是「宿主没就绪就不要去问目录」（shouldRequestCatalog 的 isHostUsable 短路）。另外两个调用方都传真实状态（RunSurfaceView.tsx:143 传 hostStatus.state、ComposerModelTrigger.tsx:235 传 hostState，后者还有静态用例 piModelWiring.test.ts:46 钉住），只有 AI 设置页传字面量 'ready'。同时这里只解构了 catalog，把 hook 提供的 status（含可重试的说明行）整个丢掉。后果不是缓存中毒（非权威来源每次都会重试，piModelCatalog.ts:119），而是：目录取不到时三项 AI 功能的模型菜单只剩一个「自动」，用户得不到任何「目录暂不可用」的提示——而同一时刻 chat 的模型触发器会把这句话显示出来。
EVIDENCE: // src/renderer/components/settings/AISettings.tsx:113
const { catalog } = usePiModelCatalog('ready');

// src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx:143（对照）
const { catalog } = usePiModelCatalog(hostStatus.state);

// src/renderer/components/chat/piModelCatalog.ts:110
if (!isHostUsable(input.hostState)) return false;
SCENARIO: 宿主尚未就绪（或托管凭据不可读）时打开 设置 → AI 功能，三项功能的模型下拉都只有「自动」一项，页面上没有任何说明；用户以为自己的模型都没了。
FIX: 把真实宿主状态传进去，并渲染 hook 返回的 status.message / 重试按钮，与 chat 的模型触发器保持同一套说明。
REFUTER(CONFIRMED,low): 无法推翻。AISettings.tsx:113 `const { catalog } = usePiModelCatalog('ready');` —— 字面量，且只解构 catalog。对照 RunSurfaceView.tsx:143 `usePiModelCatalog(hostStatus.state)`、ComposerModelTrigger.tsx:235 `usePiModelCatalog(hostState)`，后者被静态用例 piModelWiring.test.ts:46 `expect(compact(trigger)).toContain('usePiModelCatalog(hostState)')` 钉住，而该用例只读 ChatComposer/ComposerModelTrigger/usePiModelCatalog/preload 四个文件，没覆盖 AISettings。后果链成立：usePiModelCatalog.ts:79 `const catalog = cachedCatalog ?? (isHostUsable(hostState) ? null : hostNotReadyCatalog())`，传 'ready' 时无缓存就得到 null → AISettings.tsx:114 `const models = catalog?.models ?? []` → ModelField 只剩 `<SelectItem value={AUTOMATIC}>自动</SelectItem>`（:60-66）；同时 hook 返回的 status（usePiModelCatalog.ts:83 `status: catalogStatusRow({ catalog, loading: inFlight })`，文案定义在 piModelCatalog.ts:149-176 的 unavailable / stale-cache / bundled / empty 各行与 retryable）被整个丢掉，页面上没有任何说明与重试入口。审查员关于「不是缓存中毒」的自我限定也对：piModelCatalog.ts:117-119 非权威来源（非 proxy/managed/local）下次仍会重试。一点修正：目录降级为 bundled 时菜单并非只剩「自动」（还有内置基线），缺的主要是说明行；另外该 IPC（src/main/ipc/agentCatalog.ts:9-12 → readPiModelCatalog）读的是配置/凭据而非 worker 宿主，所以真实触发面更多是「托管凭据不可读」而非「宿主未就绪」。核心缺陷仍成立，low。
WAIVER(none): 无 — (未找到)

### [session-index-03] LOW dead-code confirmed | P3-5 | src/main/services/chat/NativeSessionIndexAdapter.ts:10 | 验收点名的 NativeSessionIndexAdapter 至今零生产引用，它和它的集成测试是一份不参与真实行为的平行实现
DESC: HEAD 复核：该类在 src/ 里的全部引用是它自身定义与它自己的测试。真实链路是 chat.ts → workerManager → RPC → worker，索引提交走 WorkerManager.ts:2795-2799 注入的四个钩子。审计已记过（README.md:105），批次 A/B/C 未处置，故仍是当前事实。连带影响：shared/types/nativeSession.ts 整个文件的唯一 import 方就是它；store.acceptFork / SessionPlugin.acceptFork / contracts.ts:72 的 'acceptFork' 唯一调用点在它的 :225；src/runtime/README.md:31 仍把它写成「P3-5 对接 Main 索引」的实现；P3-5 验收证据 evidence/p3/completion/README.md:20 把「导航失败回滚 / 重命名失败回滚两侧 / 历史分页 / fork 索引失败清理新文件」四项签收挂在它的测试上，其中只有最后一项在生产链路另有真实用例（WorkerManager.test.ts:454-479），另外三项生产代码里根本没有对应实现。批次 B/C 还在维护它（nativeSession.ts:18-23 记录 T025 删了 targetPath），说明清扫死代码时没识别出整个模块都是死的。它的测试还直接在 Main 进程里 createRuntime 并持有 runtime 会话对象（NativeSessionIndexAdapter.test.ts:26-32），与 D4/D11「runtime 只在 worker 载体里跑」相反。
EVIDENCE: src/main/services/chat/NativeSessionIndexAdapter.ts:9-12
/** Main-side adapter; the runtime never imports Electron or owns session-index.json. */
export class NativeSessionIndexAdapter {
  private readonly runtime: NativeSessionIndexClient;
  private readonly index: SessionIndexService;

$ grep -rn "NativeSessionIndexAdapter" src/ | grep -v __tests__  → 仅该文件自身
$ grep -rn "NativeSessionIndexClient|NativeIndexedRunRequest" src/ → 仅 nativeSession.ts 定义处与该适配器
SCENARIO: 下一个接手的人按 src/runtime/README.md:31 与 P3-5 验收清单去改 fork / 重命名 / 历史分页的索引行为，会改到这个适配器上，写完测试全绿、产品行为一点没变。反过来，读 WorkerManager.forkSession 的人会以为索引回滚只有这一处，看不到平行实现里那套更完整的两侧回滚。
FIX: 建议删而非接：(1) 它的 run/rewind/navigate/fork 都建立在「Main 进程直接持有 runtime 会话对象」之上，与 worker 载体架构相反；(2) 它独有的能力（重命名两侧回滚、navigate 失败回滚）应以 RPC 形式补进 WorkerManager；(3) 删除时一并评估退役 src/shared/types/nativeSession.ts，并改掉 src/runtime/README.md:31 与 P3-5 验收清单里被这份测试代签的三项。注意不要同时删掉 store.acceptFork——它需要的是真实调用方（见 session-index-04）。
REFUTER(CONFIRMED,low): 零生产引用属实。`grep -rn "NativeSessionIndexAdapter" src/` 在 src 下只命中三处：定义 src/main/services/chat/NativeSessionIndexAdapter.ts:10 `export class NativeSessionIndexAdapter {`，以及它自己的测试 __tests__/NativeSessionIndexAdapter.test.ts:11/39/64/85/100。类型侧同样只有它一个消费者：`grep -rn "nativeSession'" src/ --include=*.ts` 唯一命中 NativeSessionIndexAdapter.ts:5 `} from '../../../shared/types/nativeSession';`。acceptFork 的唯一生产调用点也在它体内（:225，见 session-index-04）。真实链路确在别处：WorkerManager.ts:2788-2799 的单例注入 `bindRuntimeIdentity / commitResumed / commitPiLeaf / createForked` 四个钩子指向 sessionIndexService。文档误导属实：src/runtime/README.md:31 仍写 `| ../main/services/chat/NativeSessionIndexAdapter.ts | P3-5 · 共享类型端口对接 Main 索引、历史分页与操作回滚 |`；docs/plantree/plans/runtime-evolution/evidence/p3/completion/README.md:20 把『导航失败回滚／重命名失败回滚两侧／历史分页／fork 索引失败清理新文件』签在 NativeSessionIndexAdapter.test.ts 上。测试确实在 Main 目录内直接起 runtime：NativeSessionIndexAdapter.test.ts:5-32 `import { createRuntime … } from '../../../../runtime/index'` 后 `const runtime = await createRuntime({ providers:[faux.provider], env:{}, session:{ file: join(dir,'runtime.jsonl'), cwd: dir, mode } })`。一处引用需更正：审查员写『审计已记过（README.md:105）』，但 docs/plantree/plans/runtime-hardening/README.md 全文只有 53 行且不含该模块名，现有记录只在 evidence/batch-b-2026-09-14.md:60（记的是 T025 删 targetPath 那条死字段）。这处出处错误不影响主结论，故仍判 confirmed，级别 low（死代码 + 文档/验收代签）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md 第105行（P3-5 行）；相关原文：「P3-5 | ✅ | 完成（证据不足） | NativeSessionIndexAdapter 零生产引用」

### [session-index-04] LOW contract-gap confirmed-partial-waiver | P3-5 | src/runtime/worker/nativeWorkerRuntime.ts:698 | fork 状态机只有丢弃有生产实现，提交那一半（acceptFork）无人调用，暂存标记永不清除
DESC: 一次 fork 在两个层级各留一条暂存记录：worker 层 NativeWorkerRuntime.stagedForks（nativeWorkerRuntime.ts:698）与会话 store 层 JsonlSessionStore.stagedForks（store.ts:508）。两处注释都把它说成「未被采纳的产物」，store.removeFork 更拿它当删除许可（store.ts:523-527）。但清除它的 acceptFork（store.ts:546-548、session/index.ts:73-75）在生产链路没有任何调用方——全仓唯一调用点在死模块 NativeSessionIndexAdapter.ts:225。WorkerManager.forkSession 在 createForked 成功后只置自己的 indexCommitted = true（:1580），没有任何 RPC 通知 worker「已采纳」；worker RPC 面上也没有对应方法（contracts.ts:71-72 有 'acceptFork' 这个能力名，piWorkerRpcServer.ts 只暴露 discardFork）。于是每次成功的 fork 都在源会话的两张表里永久留一条「未提交产物」记录。这就是 session-07 描述的事实；它给的失败场景在 HEAD 上仍不可达（discardForkFile 的三个调用点全在同一次 forkSession 内且在提交前或被 !indexCommitted 挡住；文件名每次 randomUUID；removeFork 还核对 header 的 id 与 parentSessionId），故按契约缺口计 low，不按 bug 计。
EVIDENCE: src/runtime/worker/nativeWorkerRuntime.ts:694-698
    const metadata = await session.fork(file, input.entryId);
    // The fork is staged, not adopted: Main decides whether it becomes a session…
    this.stagedForks.set(metadata.file, metadata.id);

src/runtime/plugins/session/store.ts:546-548
  acceptFork(file: string): void {
    this.stagedForks.delete(file);
  }

src/main/services/agent-host/WorkerManager.ts:1569-1580（提交点，无 accept 通知）
          const indexed = await this.createForked({ … });
          indexCommitted = true;
SCENARIO: 不是当场咬人的路径，是留给未来的雷：任何人后续写一个「清理无主 fork 文件」的扫描器，或给 worker.fork.discard 增加第二个 Main 侧调用方（例如「撤销刚才这次 fork」的用户功能），都会读到源 worker 那份仍写着「未提交」的表，并据此删掉一个用户已经在用的会话文件——而 store.removeFork 的 header 校验对这种情况是放行的（父子关系与 id 都对得上）。目前挡住这条路的只是「暂时没有第二个调用方」。
FIX: 补齐提交那一半：在 WorkerManager.ts:1580 置 indexCommitted = true 之后向源 worker 发一个 worker.fork.accept（payload 与 discard 同形），worker 侧 stagedForks.delete(file) 并调 session.acceptFork(file)，失败只记日志。协议里已有 acceptFork 能力名，补的是 RPC 与调用方。若决定不补，就要反过来改掉两处 stagedForks 的注释与 store.removeFork 的错误文案，不要再宣称它证明了「未提交」。
REFUTER(CONFIRMED-PARTIAL-WAIVER,low): 契约缺口成立。两处暂存表原文核到：src/runtime/worker/nativeWorkerRuntime.ts:694-698 `const metadata = await session.fork(file, input.entryId); // The fork is staged, not adopted… this.stagedForks.set(metadata.file, metadata.id);`；src/runtime/plugins/session/store.ts:507-508 同样 `this.stagedForks.set(metadata.file, metadata.id)`，:518-527 的 removeFork 拿它当删除许可：`if (this.stagedForks.get(file) !== id) throw new RuntimeHostError('session_fork_identity_mismatch', 'fork is not an uncommitted artifact of this runtime')`。清除侧 store.ts:546-548 `acceptFork(file: string): void { this.stagedForks.delete(file); }` 与 plugins/session/index.ts:73-75 的转发，生产调用方为零——`grep -rn "acceptFork" src/` 只剩 contracts.ts:72 的能力名、shared/types/nativeSession.ts:44 的类型声明、以及死模块 NativeSessionIndexAdapter.ts:225。RPC 面确无 accept：`grep -rn "fork.discard|discardFork"` 显示 src/agent-host/piWorkerRpcServer.ts:110/413/766 与 shared/types/workerRpc.ts:657 只有 'worker.fork.discard'，没有任何 accept 通道；WorkerManager.ts:1580 提交后只置 `indexCommitted = true;` 不通知 worker。当前不可达也与审查员一致：三个 discardForkFile 调用点（WorkerManager.ts:1488、1605、1608）都在同一次 forkSession 内且被 `if (!indexCommitted)` 挡住。补一条削弱事实（不改结论）：stagedForks 是 NativeWorkerRuntime / JsonlSessionStore 的进程内存表，源 worker 退出即清空，所以残留是 worker 生命期内而非跨重启的持久污染。按契约缺口计 low。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-evolution/topics/p3-completion-contracts.md「落地接口与可靠性边界」第18-19行；原文：「Main adapter 操作覆盖 runtime 修改、索引提交和失败回滚的整个区间；fork 回滚校验创建者身份并重新获得文件锁。两文件操作没有跨文件事务日志，进程在间隙被强杀时可能留下未索引 fork，或磁盘 lane 与旧索引暂时不同；下次 connect 以持锁读取的 JSONL 元数据提交索引。」

### [session-index-06] LOW dead-code confirmed | P3-5 | src/main/ipc/chat.ts:278 | chat:createSession 把 effort 传给 recordCreated，而索引既没有这个字段也不会保存它
DESC: CHAT_CREATE_SESSION 调 recordCreated 时展开了 ...(payload.effort ? { effort: payload.effort } : {})，但 recordCreated 的入参类型没有 effort（SessionIndexService.ts:85-93），方法体是逐字段重建行（注释 :71-84 明确说没点名的键会被丢掉），SessionIndexEntry 也没有 effort 字段。所以这一行写了等于没写。TypeScript 不报错是因为多余属性检查不作用于展开进来的属性——这行能留在一个 tsc 全绿的仓库里本身就是证据。功能上不丢东西：下一行把 effort 正常交给了 workerManager.createSession（chat.ts:286），那才是生效路径。
EVIDENCE: src/main/ipc/chat.ts:274-281
      await sessionIndexService.recordCreated({
        sessionId: payload.sessionId,
        workspacePath: payload.workspacePath,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        agent: PI_AGENT,
        unbound,
      });

src/main/services/chat/SessionIndexService.ts:85-93（入参无 effort）
  async recordCreated(input: { sessionId: string; workspacePath: string; model?: string; agent?: string; unbound?: boolean; }): Promise<void>
SCENARIO: 没有运行期故障，触发的是认知错误：有人要做「重启后恢复上次的推理档位」，看到这行以为已经存了，去查 session-index.json 发现没有，再回头排查是不是写入被覆盖——而真相是这个参数从来没被接收过。
FIX: 二选一不要停在中间态：删掉 chat.ts:278 这一行；或真的把 effort 做成持久事实——给 SessionIndexEntry 加可选字段 effort?: SessionEffortLevel（按该文件头的规则只能是可选 per-entry 字段）、在 recordCreated 的入参与重建体里点名它、并像 agent 一样用 ?? existing?.effort 兜住不知情的调用方。从「档位是每回合可覆盖的」看，我倾向删。
REFUTER(CONFIRMED,low): 属实且只此一处。src/main/ipc/chat.ts:274-281 原文 `await sessionIndexService.recordCreated({ sessionId: payload.sessionId, workspacePath: payload.workspacePath, ...(payload.model ? { model: payload.model } : {}), ...(payload.effort ? { effort: payload.effort } : {}), agent: PI_AGENT, unbound, });`，而 recordCreated 的入参类型 SessionIndexService.ts:85-93 只有 `sessionId / workspacePath / model? / agent? / unbound?`，方法体 :98-112 逐字段重建行（头注释 :71-84 明说未点名的键会被丢掉），`grep -rn effort src/shared/types/sessionIndex.ts src/main/services/chat/SessionIndexService.ts` 零命中，确认 SessionIndexEntry 也没有这个字段。TypeScript 不报错的解释也对：excess property check 不作用于展开进来的属性。功能上确不丢：紧接着 chat.ts:286-289 `workerManager.createSession({ …, ...(payload.effort ? { effort: payload.effort } : {}), … })` 才是生效路径，payload 类型在 :249 声明了 `effort?: SessionEffortLevel`。我另查了同文件的 register/resume 分支（:424、:439），那里的 effort 都是传给 workerManager 的，没有第二处误传给索引。级别 low（死代码/认知陷阱，无运行期故障）。
WAIVER(none): 无 — 全库检索无命中

### [session-index-07] LOW contract-gap confirmed | P3-5 | src/main/ipc/chat.ts:601 | 重命名只改索引行，worker 协议里根本没有 rename，会话文档的 name 永不被 GUI 写入（静态推断）
DESC: CHAT_RENAME_SESSION 直接调 sessionIndexService.rename，只改索引里的 title。worker RPC 面上没有任何 rename 方法（对 piWorkerRpcServer.ts、workerRpc.ts、nativeWorkerRuntime.ts 搜 rename 零命中），WorkerManager 也没有 rename 路径。而 runtime 侧实现了：SessionPlugin.rename → store.rename（session/index.ts:77）会往 JSONL 写一条命名行，生产里唯一调用方是导入（nativeImport.ts:130）。于是不对称：导入进来的会话标题写在文件里，GUI 新建的会话标题只在索引里，GUI 重命名两种会话文件里的名字都不动；连带 fork 也如此（store.ts:503 的 if (this.document.name) await fork.rename(...)）。H/20 把 pi CLI 变成同一个 JSONL 的第一等第二界面，而 pi 的会话管理器有名字概念（session-manager.d.ts:83、:130-131、:226-228 的 appendSessionInfo / getSessionName）。static_inference：这个名字在 pi CLI/TUI 的哪些界面露出需要真开一次 CLI 才能确认，我只能从类型定义确认它是格式里的一等公民。
EVIDENCE: src/main/ipc/chat.ts:598-603
  ipcMain.handle(
    IPC_CHANNELS.CHAT_RENAME_SESSION,
    async (_e, payload: { sessionId: string; title: string }): Promise<boolean> => {
      return sessionIndexService.rename(payload.sessionId, payload.title);
    }
  );

$ grep -rn "rename" src/main/services/agent-host/WorkerManager.ts → 零命中
$ grep -rn "\.rename(" src/runtime/plugins/session/*.ts src/runtime/worker/*.ts
store.ts:503:      if (this.document.name) await fork.rename(this.document.name);
nativeImport.ts:130:  await store.rename(conversation.title);
SCENARIO: 用户在 GUI 里把一个聊天重命名为「支付网关重构」，然后在同一会话上开 pi TUI（H/20 的交接路径）。TUI 侧看到的是一个没有名字的会话；在 CLI 的会话列表里只能靠时间戳认它。而导入进来的会话在两边显示一致——同一个产品里两种会话行为不同。
FIX: 定一个口径并写进 H/20 契约。若「标题是跨界面事实」：补一个 worker.session.rename RPC，CHAT_RENAME_SESSION 先改文件再改索引（或先索引后文件并在文件失败时回滚，NativeSessionIndexAdapter.rename 里有现成的两侧回滚可照抄），注意它是一次 JSONL 写入，得和 send/rewind 一样先走 handOverFromTui。若「标题是 GUI 的本地事实」：把 nativeImport.ts:130 也去掉让两类会话一致，并在契约里写明 pi CLI 侧不显示我们的标题。
REFUTER(CONFIRMED,low): 代码事实成立，但审查员给的用户可见场景被我推翻，剩下的是低价值的内部不一致。

成立的部分：`src/main/ipc/chat.ts:598-603` 的 CHAT_RENAME_SESSION 只有 `return sessionIndexService.rename(payload.sessionId, payload.title);`，不碰会话文件；我按 `grep -rn "rename" src/runtime/worker/*.ts src/runtime/plugins/session/*.ts src/main/services/agent-host/*.ts` 复核，worker RPC 面上确实零 rename 方法，WorkerManager.ts 里唯一带 title 的行是 `src/main/services/agent-host/WorkerManager.ts:1575  title: `${input.sourceTitle || 'Session'} (fork)``（写索引，不写文件）。runtime 侧 `src/runtime/plugins/session/index.ts:76-78 rename(name) { return this.store.rename(name); }` 的生产调用方只有导入 `src/runtime/worker/nativeImport.ts:130  await store.rename(conversation.title);` 与 fork 内传递 `store.ts:503  if (this.document.name) await fork.rename(this.document.name);`。所以「GUI 标题只在索引里、导入标题额外落文件」这个不对称是真的。

被推翻的部分（审查员的 scenario 与 static_inference 结论）：我方写的名字 pi CLI 根本读不到，所以不存在「导入的会话两边一致、GUI 的不一致」。`src/runtime/plugins/session/store.ts:434-437` 走 `this.mutate({ kind: 'fact', fact: 'name', name }, ...)`，而 `store.ts:550-557` 的 mutate 把行序列化成 `JSON.stringify({ ...row, seq, ...cliBookkeeping(...) })`，`src/runtime/plugins/session/codec.ts:121-123  return { type: 'custom', customType: CLI_BOOKKEEPING_TYPE, id, parentId, timestamp }` —— 落到文件里是一条 `type:"custom"` 行。pi CLI 认的是 v3 形状：`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:466  if (entry.type === "session_info")` 与 `:854` 的 getSessionName 同样只扫 `session_info`。因此导入会话在 pi TUI 里也是无名的，两类会话在 CLI 侧表现一致。

残留缺陷（我给 low）：`document.name` 在我方是近乎只写字段——唯一读处是 `store.ts:358  title: this.document.name ?? ''`（metadata），而 Main 侧没有任何地方消费 metadata.title（WorkerManager.ts 里 title 只出现在 1575 那一行），所以这条链既没有 GUI 生产者也没有 GUI 消费者，属于契约口径未定 + 半条死链，不是用户可见错误。批次 A～C 未触及：roadmap.md:99 的 T029 正是本次补审任务，`git log --oneline -- src/main/ipc/chat.ts` 最近三条是 T036/T026/T025，都不涉及 rename。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/README.md「H / 20」行（约第206行）；相关原文：「改名/切分支写的 `fact`/`lane` 行没有 id 与父链，CLI 拿最后一行当对话末端，于是整段对话在 TUI 里是空的（导入的会话必中）」

### [session-index-08] LOW robustness confirmed | P3-5 | src/main/ipc/chat.ts:704 | fork 是唯一不做 TUI 交接的会话变更入口，从 worker 内存文档复制分支，一次 reload 失败之后会复制出缺少终端轮次的分支（静态推断）
DESC: handOverFromTui（chat.ts:125-146）是 GUI 抢回 JSONL 所有权的闸：杀掉终端、拒绝在别人还持有文件时继续、终端写过就重读文件。send(:489)、compact(:650)、rewind(:694) 都调它，fork(:704-719) 不调。fork 不写源文件（store.createFork 只 flush 源、把分支写进新文件），所以不会像 session-01 那样写坏源文件——这点我核过，不按 high 计。但它是从 worker 的内存文档取分支的（createFork 用 this.document.entries + branchEntries），文档有多旧 fork 就少多少内容。正常路径上窗口是关着的：从 TUI 切回 GUI 会 suspend 终端并 reloadSession（usePresentationSwitch.ts:147-175），TUI 退出也无条件 reload（:187-210）。窗口只在 reload 自己失败时打开——那条 catch 会弹「Could not reload this chat」并丢掉终端，但不禁用 Branches 按钮，也不把会话标成内容可能不全。
EVIDENCE: src/main/ipc/chat.ts:704-718（对照 :489 / :650 / :694 都有 await handOverFromTui）
  ipcMain.handle(
    IPC_CHANNELS.CHAT_FORK_SESSION,
    async (e, payload: { sessionId: string; entryId: string }) => {
      const row = await requireIndexedPiSession(payload.sessionId);
      return workerManager.forkSession({ … });
    }
  );

src/runtime/plugins/session/store.ts:465-469
  private async createFork(file: string, entryId: string): Promise<SessionMetadata> {
    await this.flush();
    if (!this.document.entries.some((entry) => entry.id === entryId)) throw …
    const branch = branchEntries(this.document, entryId);
SCENARIO: 用户在 pi TUI 里聊了几轮后切回 GUI；reloadSession 因写锁被别人持有（或 worker 正好在重启）而失败，弹出「Could not reload this chat」。用户没在意，继续点 Branches → Fork 某条早期消息。fork 出来的新会话按 worker 那份进终端之前的文档复制，终端里那几轮永久不在这个分支上，而新会话看起来完全正常（它自己的历史自洽）。
FIX: 让 fork 与其它三条入口一致：在 CHAT_FORK_SESSION 里先 await handOverFromTui(payload.sessionId, ownerWebContentsId)。若不想加这次交接，至少要在 reload 失败后把该会话标脏（禁用 Branches / 在树对话框上给警告），不要让一次已经报错的 reload 静静地把陈旧内容复制成新会话。
REFUTER(CONFIRMED,low): 成立，而且比审查员写的更容易触发。

事实核对：`src/main/ipc/chat.ts:704-718` 的 CHAT_FORK_SESSION 只有 `requireIndexedPiSession` + `claimSessionForSender`，没有 `await handOverFromTui(...)`；对照 send（:489 附近）、compact（`chat.ts:650` 上方注释「session-01 — compaction appends to the JSONL just as a turn does, so it needs the same handover」）、rewind（:694 同理）三处都有。`handOverFromTui` 自己的注释（chat.ts:125 区块结尾）也写着「Every GUI path that appends to the JSONL calls this — send, compact, rewind」，fork 不在名单里。

审查员说「fork 不写源文件」我复核属实：`src/runtime/plugins/session/store.ts:465-469 createFork` 先 `await this.flush()`，而 `store.ts:570-572  flush(): Promise<void> { return this.tail; }` 只是等队列排空、不产生新写入；分支内容写的是新文件（`store.ts:499  await this.io.writeFile(fork.file, ...)`）。所以不会写坏源文件，按 low 合理。

触发路径比审查员给的更宽：进入 TUI 不会停掉 GUI worker——`src/main/ipc/piTui.ts:130-136` 的 PI_TUI_OPEN 只做 `sessionGuard.transferTo(request.sessionFile)` 和 `tuiWrittenSessions.add(...)`，全程不碰 workerManager；而多窗口是支持的（`src/main/index.ts:789-791  const handleNewWindow = () => { openLocalWindow(...) }`，走应用菜单 New Window）。于是窗口 A 开着 TUI 在写同一个 JSONL，窗口 B 打开同一会话（resume 走 warm 路径复用同一个活 worker，见 `WorkerManager.ts:1330-1337` reloadSession 注释里对 resumeSession warm 短路的描述）并点 Fork，就会从陈旧内存文档复制分支，终端那几轮永久缺席。

审查员那条「reload 失败后仍可 fork」的路径只部分成立：reload 在 try 内失败会 `WorkerManager.ts:1421  await this.retireAndDispose(entry, 'slot-dispose')`，worker 被退休，之后 fork 撞 `requireReadySession`（:2281-2289）直接 session_not_found、由重新 spawn 冷读文件自愈；只有 try 之前抛出的分支（`:1352 worker_reload_identity_conflict`、`:1358 this.assertIdleEntry(entry,'reload')`）才会留下活的陈旧 worker。静态推断：未上机复现。
WAIVER(none): 无 — 全库检索无命中

### [session-index-09] LOW robustness confirmed-partial-waiver | P3-5 | src/main/services/agent-host/WorkerManager.ts:1461 | 暂存 fork 文件没有任何回收扫描，fork 窗口里崩溃或删不掉就会在会话目录里留下无主 JSONL（静态推断）
DESC: worker.fork 先在会话目录里造出文件（nativeWorkerRuntime.ts:693 的 join(dirname(sourceSessionFile), `${randomUUID()}.jsonl`)），之后才是 spawn 新 worker 与写索引。这段窗口里文件没有索引行也没有持久登记。两种情况会把它永久留下：Main 在窗口内崩溃/被杀/强退（stagedForks 只在内存里）；清理本身失败（discardForkFile 两次都 false 时抛 worker_fork_cleanup_failed，WorkerManager.ts:1617-1623，错误报给用户但文件留在原地，无重试无登记）。全仓没有任何启动期扫描会话目录的代码，所以这些文件不会被回收。
EVIDENCE: src/runtime/worker/nativeWorkerRuntime.ts:692-694
    const sourceSessionFile = session.file;
    const file = join(dirname(sourceSessionFile), `${randomUUID()}.jsonl`);
    const metadata = await session.fork(file, input.entryId);

src/main/services/agent-host/WorkerManager.ts:1617-1623
          if (!stagedFileDiscarded) {
            throw new WorkerManagerError('worker_fork_cleanup_failed',
              `Fork failed and the staged Pi file could not be confirmed removed: ${sessionFile}`, true);
          }
SCENARIO: 用户点 Fork，新 worker 正在启动时强退应用（或应用崩溃）。磁盘上多出一个 <uuid>.jsonl，它是源会话前半段的完整副本，和正常会话文件躺在同一目录、同样 0o600。GUI 永远看不到它（索引里没有），但 pi CLI 是按目录列会话的——用户在 CLI 里会看到一个来路不明、内容是自己某次对话前半段的会话，且没有任何界面能删掉它。
FIX: 给暂存文件一个可识别形态或一份可重放登记：(1) 用 <uuid>.jsonl.staged 落地，createForked 成功后原子改名成正式名（同时天然解决 session-index-04 的提交语义），启动时把残留的 .staged 一律删掉；或 (2) 把待清理路径写进一个小的 pending 文件，启动时扫一遍并按 header 的 parentSessionId 校验后删除。至少要把 worker_fork_cleanup_failed 的路径记进日志之外的持久位置。
REFUTER(CONFIRMED-PARTIAL-WAIVER,low): 成立。落地事实：`src/runtime/worker/nativeWorkerRuntime.ts:692-694  const sourceSessionFile = session.file; const file = join(dirname(sourceSessionFile), `${randomUUID()}.jsonl`); const metadata = await session.fork(file, input.entryId);` —— 文件先落在会话目录（正式名，无任何可识别后缀），登记只在内存：`nativeWorkerRuntime.ts:698  this.stagedForks.set(metadata.file, metadata.id);` 与 `store.ts:508` 同样是内存 Map。索引行要到 `WorkerManager.ts:1571-1580 this.createForked({...})` 才写，之间隔着 `spawnForEntry`（:1549）整个 worker 启动。

清理失败确实只抛不重试：`WorkerManager.ts:1617-1623  if (!stagedFileDiscarded) { throw new WorkerManagerError('worker_fork_cleanup_failed', `Fork failed and the staged Pi file could not be confirmed removed: ${sessionFile}`, true); }`，没有把路径持久化到任何地方。

回收扫描确实不存在：`grep -rn "readdir" src/main --include=*.ts | grep -v __tests__` 只命中 appStateMigration、NodeRuntimeResolver、subagentCatalog、两个 legacy 扫描器、remote、PtyManager、files、AgentDirMigration，没有一处遍历会话目录；`grep -rn "readdir" src/runtime/worker/*.ts src/runtime/plugins/session/*.ts` 零命中。对照组能说明这是遗漏而非取舍：导入链专门做了暂存目录 + 改名发布 + 中断重对账（`src/runtime/worker/nativeImport.ts:262-264 stagingDir`、`:298  await (await this.io()).rename(stagedSessionFile, finalSessionFile)`、`:249-254` 注释里的 inspectInterrupted，以及 LegacyImportService 的 reconcile/cleanupPending），fork 什么都没有。

严重级我同意 low：泄漏的是磁盘上一份 0o600 的副本，不丢数据、不影响功能，只是无界残留 + 用户无入口删除（其在 pi CLI 会话列表里是否露出是静态推断，未上机）。批次 A～C 未覆盖：T016（roadmap.md:75）只改了 discardFork 在 dispose 前 unlink，没有涉及崩溃窗口的残留回收。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-evolution/topics/p3-completion-contracts.md「落地接口与可靠性边界」第18-19行；原文：「两文件操作没有跨文件事务日志，进程在间隙被强杀时可能留下未索引 fork，或磁盘 lane 与旧索引暂时不同；下次 connect 以持锁读取的 JSONL 元数据提交索引。」

### [session-index-10] LOW dead-code confirmed | P3-5 | src/renderer/components/chat/sessionIndex/useSessionIndex.ts:64 | mergeSessionIndex 的 orphaned 返回值在生产里零消费者，会话因目录消失而从侧栏蒸发时没有任何提示（静态推断）
DESC: mergeSessionIndex 把「索引里有、但本窗口找不到对应工作区」的行收进 orphans，注释写明用意是让调用方决定（丢掉或给警告，sessionIndexMerge.ts:172-173）。生产里唯一调用方 applySessionIndexRefresh 只取 merged.sessions，merged.orphaned 被直接丢弃（useSessionIndex.ts:64-70），于是「丢掉」是默认也是唯一行为且静默。这正好接在 F2-b 的设计结论后面：runtime-evolution/README.md:217 写明重启会把整个 scratch 根连锅端，必然出现「索引行在、workspacePath 指向已不存在目录」，这是 U05-a 的设计；带 unbound 标记的行 sessionIndexMerge.ts:151-168 专门兜住了（这是对的），但没有标记的行——手工删掉的项目文件夹、被 temp:workspace:remove 删掉的临时目录、以及 session-index-02 那种漏写标记的 fork 行——全部静默消失。索引行永远留着（SessionIndexService 只有导入回滚会删行，entries.delete 只出现在 :216 与 :247），转录也留着，只是没有入口。
EVIDENCE: src/renderer/components/chat/sessionIndex/useSessionIndex.ts:64-70
  const merged = mergeSessionIndex(state.sessions, entries, { workspaces: state.workspaces, seedStatus: 'idle' });
  const sessions = dropDismissedSessions(merged.sessions);

src/renderer/components/chat/sessionIndex/sessionIndexMerge.ts:171-185
    if (!workspaceId) {
      // No workspace context to host this session — skip but also stash as
      // orphaned so the caller can decide (e.g. drop, or surface a warning).
      orphans.push({ … });
      continue;
    }
SCENARIO: 用户把一个项目文件夹改名或删掉（或用侧栏删除按钮清掉一个临时工作区目录）。下一次索引刷新，该文件夹下的所有聊天从侧栏消失，没有提示、没有「已失联的会话」分组、也没有重新指定目录的入口。用户的自然结论是「聊天记录丢了」，而索引行和 JSONL 都好端端在磁盘上。
FIX: 让 orphaned 真的有消费者：把它放进 store，在侧栏底部给一个可折叠的「文件夹已失联（N）」分组，点进去能看到标题与 workspacePath，提供「重新绑定到某个文件夹」或「归档」两个动作。若产品上决定就是要静默丢弃，那就把 MergeResult.orphaned 与那段注释一起删掉。
REFUTER(CONFIRMED,low): 死代码判定成立，但用户可见场景要打折。

事实：`src/renderer/components/chat/sessionIndex/sessionIndexMerge.ts:171-184` 的 `if (!workspaceId) { // ... stash as orphaned so the caller can decide (e.g. drop, or surface a warning). orphans.push({...}); continue; }`，`:214  return { sessions: next, orphaned: orphans };`；生产里唯一调用方是 `src/renderer/components/chat/sessionIndex/useSessionIndex.ts:64-70  const merged = mergeSessionIndex(state.sessions, entries, {...}); const sessions = dropDismissedSessions(merged.sessions);` —— `merged.orphaned` 被丢弃。我全仓复核：`grep -rn "orphaned" src --include=*.ts --include=*.tsx` 里唯一读它的是测试 `sessionIndexMerge.test.ts:83-85`。所以「注释承诺让调用方决定，实际只有静默丢弃」属实，`MergeResult.orphaned`（:66-67）在生产是死返回值。

场景要打折的地方：orphan 的判定是「workspacePath 匹配不到任何已注册工作区」（`sessionIndexMerge.ts:85-93` 用 `workspacesByPath` 建表，:119 查表）。用户只是把磁盘目录改名/删掉、但工作区仍在侧栏注册着时，表里仍有这条 path，会话不会 orphan；真正落进 orphan 的是「工作区注册本身没了」——用户主动移除项目、临时工作区被 `TEMP_WORKSPACE_REMOVE`（src/main/ipc/tempWorkspace.ts:178）删掉之类，这类情形下聊天跟着消失更接近用户预期。另外 unbound 行已由 `:151-168` 专门兜住（审查员自己也承认）。所以我保留 low，定性为 dead-code / 契约与实现不符，而不是用户可见的数据消失。批次 A～C 未触及该文件（`git log --oneline -- .../sessionIndexMerge.ts` 最近一条是 dc906192，早于加固批次）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/README.md「F2-b」行；相关原文：「重启会把整个 scratch 根目录连锅端，与用哪个入口无关，因此重启后必然出现「索引行在、`workspacePath` 指向已不存在目录」的状态，这是 U05-a 的设计而非索引损坏」

### [session-index-11] LOW capacity confirmed | P3-5 | src/main/services/chat/SessionIndexService.ts:442 | 索引行只增不删、无上限无修剪，而每一次回合结束都会把整张表重新序列化写盘（静态推断）
DESC: 两件事叠加。其一，能删除索引行的只有 removeImported（导入回滚）与 createIndependent 的失败回滚，entries.delete 全文件只出现这两处（:216、:247）；归档只是把 archived 置 true，CHAT_CLOSE_SESSION 根本不碰索引，所以文件行数等于这台机器上创建过的全部聊天数，单调增长。其二，flush() 把整张表 JSON.stringify(data, null, 2) 后整文件重写，而触发频率不低：handleRuntimeEvent 对 session.created/updated/completed/failed/stopped 都会落一次盘（:337-351、:392-397），即每个回合结束至少一次全量写。单看都不致命，但这是 Main 主线程上的同步序列化加一次全量写且随使用时间线性变差，再叠上 session-index-01（无损坏隔离），值得在容量对账表（T024）里补一行。
EVIDENCE: src/main/services/chat/SessionIndexService.ts:442-447
  private async flush(): Promise<void> {
    const entries = [...this.entries.values()];
    await mkdir(app.getPath('userData'), { recursive: true });
    await this.writeAtomically(path, entries);
  }

:21-25
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tempPath, targetPath);
SCENARIO: 一台长期使用的开发机上积累了几千个聊天（含全部已归档的）。每次回合结束（session.completed）都要把这份几 MB 的缩进 JSON 完整序列化并重写一遍，用户感知到的是发完消息后偶发的主进程卡顿，而没有任何界面告诉他「归档不会让索引变小」。
FIX: 按代价排序三件小事：(1) JSON.stringify 去掉 null, 2 缩进（这个文件不是给人读的，体积能掉三到四成）；(2) 把只改 updatedAt 的三条终态事件写做节流合并；(3) 给「删除会话」一个真正的入口（同时删索引行与 JSONL，或把归档超过 N 天的行迁到 session-index.archive.json），让主索引规模有上界。结论回写进 T024 的容量对账表。
REFUTER(CONFIRMED,low): 两条代码事实都核对无误，定性为容量待办（low），不是现行故障。

只增不删：`grep -n "entries.delete" src/main/services/chat/SessionIndexService.ts` 只有两处——`:216  this.entries.delete(sessionId);`（removeImported，导入回滚）与 `:247  this.entries.delete(input.sessionId);`（createIndependent 写盘失败回滚）。归档只置位：`:325-331 setArchived` 里 `this.entries.set(sessionId, { ...existing, archived, updatedAt: now() }); await this.flush();`。CHAT_CLOSE_SESSION 确实不碰索引：`src/main/ipc/chat.ts:509-515` 只有 `workerManager.releaseSession` + `workerManager.closeSession`。

每回合全量重写：`SessionIndexService.ts:442-447  private async flush() { const entries = [...this.entries.values()]; await mkdir(...); await this.writeAtomically(path, entries); }`，落盘走 `:21-25  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8'); await rename(tempPath, targetPath);`；触发面是 `:337-351 handleRuntimeEvent` 对 session.created/updated/completed/failed/stopped 全部转 applyRuntimeEvent，而 `:392-397` 的三条终态分支各 `await this.flush()`，即每个回合至少一次全量序列化 + 全量写。

措辞上做一处修正：`JSON.stringify` 是主进程上的同步 CPU 开销，`writeFile`/`rename` 是异步的，所以「卡顿」只来自序列化那一段，量级随行数线性增长而非一次性阻塞磁盘 IO。没有上限、没有修剪、没有真正的删除入口属实，归到 T024 容量对账表（roadmap.md:36/85，T024 已于 `8564ba41` 落地但对账表覆盖的是会话文件与 trace，没有 session-index.json 这一行）是恰当的收口方式。静态推断：未做大索引实测。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md（T024 容量对账表）；相关原文：「本文对「写进会话文件与 trace 的最大字节」按来源列清楚……Role: evidence。任务 T024」

### [import-up-04] LOW contract-gap confirmed | P5-4 上游 | src/shared/types/legacyImport.ts:6 | 上游的 64 MiB / 4000 条 / 64 KiB 口径从未与 32 MiB 会话预算对账，越界的后果是走完整条链路后在最后一步失败（审查员原判 medium）（静态推断）
DESC: 导入侧的体积闸门全在上游：源 ≤ 64 MiB、条目 ≤ 4000、单条正文 ≤ 64 KiB、工具输入输出 ≤ 16 KiB。真正写盘那一侧用的是另一个预算 SESSION_MAX_BYTES = 32 MiB（src/runtime/plugins/session/codec.ts:20，T015 集中的常量），执行点在 store.appendEntry 的「已有字节 + 本行字节 > maxBytes 就抛 session_size_limit」（store.ts:288-295）。两组数字之间没有换算关系：源上限正好是会话预算的 2 倍；校验器允许的最坏情况远不止 2 倍——4000 条 user × 64 KiB = 256 MiB，单条 assistant 允许 256 个块（legacyImport.ts:248）× 64 KiB = 16 MiB/条。后果不是写坏文件（store 是拒绝不是截断，NativeLegacyImportWriter.create 的 catch 会 unlink 暂存文件），而是代价与错误形态都不对：要先完整读盘、算两个 sha256、fork 一个 worker、把整份对话经 RPC 送过去、写到一半才失败，错误正文是面向实现的 'session exceeds the configured size budget'。T024 的容量对账表（evidence/capacity-reconciliation-2026-09-15.md）表 A 没有「导入的对话条目」这一行，全表唯一命中 import 的第 43 行是 session/legacy.ts:550-551，那是 pi v3→v4 的格式转换、不是对话导入。静态推断（按常量与执行点推出），未执行验证。
EVIDENCE: src/shared/types/legacyImport.ts:6-10
export const LEGACY_IMPORT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const LEGACY_IMPORT_MAX_ENTRIES = 4_000;
export const LEGACY_IMPORT_MAX_TEXT_CHARS = 64 * 1024;
export const LEGACY_IMPORT_MAX_TOOL_CHARS = 16 * 1024;

src/runtime/plugins/session/codec.ts:20
export const SESSION_MAX_BYTES = 32 * 1024 * 1024;

src/runtime/plugins/session/store.ts:288-295
      const line = `${JSON.stringify({ kind: 'entry', lane: 'main', ...item })}\n`;
      const bytes = Buffer.byteLength(line);
      if (this.bytes + bytes > this.maxBytes)
        throw new RuntimeHostError('session_size_limit', 'session exceeds the configured size budget');

src/shared/types/legacyImport.ts:246-251 —— 校验器允许单条 assistant 带 256 个块
    case 'assistant':
      return (
        Array.isArray(value.blocks) &&
        value.blocks.length <= 256 &&
        value.blocks.every(isImportedAssistantBlock) &&
SCENARIO: 一个在同一仓库里做了几个月的 Claude Code 会话，JSONL 约 40 MiB（低于 64 MiB 源上限），大部分是 assistant 长回复与用户贴的长文本（工具输出会被裁到 16 KiB，正文不会）。用户选中它点导入：上游全部闸门放行 → 完整读盘并算两遍 sha256 → fork 导入 worker → 经 RPC 送整份对话 → 写到第 32 MiB 时 store.appendEntry 抛 session_size_limit → 暂存文件被 unlink、manifest 记一条 failed → 面板显示「失败 1 个」，错误文本是 'session exceeds the configured size budget'。用户既不知道是体积问题也不知道界限在哪，重试必然同样失败。
FIX: 在 ImportedConversation 组装完成后、送进 worker 之前，在 Main 侧加一道预算预检：按 JSON.stringify 估算落盘字节与 SESSION_MAX_BYTES 比较，超出就以面向用户的错误直接拒绝（说明「这条会话约 X MB，超过单会话 32 MB 上限」），不要 fork worker。同时把 LEGACY_IMPORT_MAX_SOURCE_BYTES 与 SESSION_MAX_BYTES 的关系写进常量注释，并把「导入的对话条目」补进 T024 容量对账表表 A。
REFUTER(CONFIRMED,low): 事实部分逐条核实。上游常量 src/shared/types/legacyImport.ts:6-9 为 64 MiB / 4 000 条 / 64 KiB / 16 KiB；落盘预算 src/runtime/plugins/session/codec.ts:20 `export const SESSION_MAX_BYTES = 32 * 1024 * 1024;`，store.ts:117 `const maxBytes = config.maxBytes ?? SESSION_MAX_BYTES;`，而 nativeImport.ts:279-284 的 JsonlSessionStore.open 只传 file/cwd/mode/id，不传 maxBytes，因此导入写的就是 32 MiB 预算；执行点 store.ts:288-295 `if (this.bytes + bytes > this.maxBytes) throw new RuntimeHostError('session_size_limit', 'session exceeds the configured size budget');`。失败代价属实：nativeImport.ts:286-301 是先 appendConversation 写到一半才抛，catch 里 `unlink(stagedSessionFile)`，所以是「做完整条链路后在最后一步失败」，且不损坏数据。Main 侧无预检也属实：grep byteLength / MAX_SOURCE_BYTES 在 src/main/services/legacyImport/ 下只命中源文件体积闸门，没有任何针对落盘字节的估算。文档缺口属实：capacity-reconciliation-2026-09-15.md 全文唯一含 import 的是第 43 行 `| legacy 导入转换后落盘 | session/legacy.ts:550-551 |`，那确是 pi 格式转换（legacy.ts:550 `if (Buffer.byteLength(converted) > (config.maxBytes ?? SESSION_MAX_BYTES))`），不是对话导入。我把严重级从 medium 降到 low：store 是拒绝而非截断，暂存文件被清理、清单记 failed，不丢数据不留半成品；且经上游裁剪后（工具输出统一 ≤16 KiB 落成 display 行）真要凑够 32 MiB 纯正文并不常见，实质问题是错误形态与代价，而非错误结果。属静态推断，未执行验证。
WAIVER(none): 无 — 全文档检索无命中

### [import-up-05] LOW contract-gap confirmed | P5-4 上游 | src/main/services/legacyImport/ClaudeSourceAdapter.ts:502 | display 条目的 title 在生产侧无上限、在 Codex 侧可为空串，而 worker 校验硬卡「非空且 ≤ 256」，越界即整份对话被拒（审查员原判 medium）（静态推断）
DESC: worker 侧的 isWorkerImportConversationPayload 是导入 RPC 的准入校验（src/agent-host/piWorkerRpcServer.ts:450），它对 display 条目的 title 有两条硬要求：非空、长度 ≤ 256（src/shared/types/legacyImport.ts:262-264）。上游两个适配器构造 title 时都没有对应保证：ClaudeSourceAdapter.ts:502 的 `Unsupported Claude entry: ${raw.type}` 里 raw.type 是从 JSONL 直接读出的任意字符串、完全没有截断（上界是单行 2 MiB）；:419 的 `Unsupported Claude assistant block: ${item.type}` 同样未截断；:404/:447 截的是工具名不是标题，前缀 18/20 字符，标题上界 274/276，结构性地超过 256；:487 的 `attachment.name ?? attachment.mediaType` 两者都来自文件且未截断；CodexRollout.ts:151 的 name 取 payload.name.slice(0,256)，长度没问题，但 payload.name 为空串时 typeof==='string' 成立、name 就是 ''，title 变空串，nonEmptyString 不过，且空名会经 calls 表传染给对应的 output 条目。校验不过的后果不是丢一条，而是 isImportedConversation 整体返回 false、worker 回 WORKER_INVALID_PAYLOAD，整份对话导不进来且错误文案指不出是哪一条越界；Main 侧在送出前不做同一套校验，所以问题只在跨进程之后才暴露。静态推断，未执行验证。
EVIDENCE: src/shared/types/legacyImport.ts:260-273 —— 校验侧
    case 'display':
      return (
        ['tool', 'custom', 'diagnostic', 'attachment'].includes(String(value.displayKind)) &&
        nonEmptyString(value.title) &&
        value.title.length <= 256 &&

src/main/services/legacyImport/ClaudeSourceAdapter.ts:496-507 —— 生产侧，raw.type 未截断
    if (raw.type) {
      pushBounded(entries, buildDisplay({
          ...provenance,
          displayKind: 'diagnostic',
          title: `Unsupported Claude entry: ${raw.type}`,
          body: 'Raw legacy entry payload omitted.',
          redacted: true,
      }));
    }

src/main/services/legacyImport/ClaudeSourceAdapter.ts:404 —— 18 + 256 = 274 > 256
              title: `Legacy tool call: ${item.name.slice(0, 256)}`,

src/main/services/legacyImport/CodexRollout.ts:151 —— 空工具名产生空标题
      const name = typeof payload.name === 'string' ? payload.name.slice(0, 256) : 'Codex tool';

src/agent-host/piWorkerRpcServer.ts:449-456 —— 越界的后果是整份拒绝
  private async handleImport(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerImportConversationPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.import requires a valid versioned ImportedConversation',
        retryable: false,
      });
SCENARIO: 两条。(1) 用户的 Claude 会话里有一条 type 取值异常的行（某次崩溃写坏、或未来版本写入的长类型名），raw.type 超过 238 字符 → display 标题超过 256 → worker 拒收整份对话，用户看到「失败 1 个」，错误文本是 'worker.import requires a valid versioned ImportedConversation'，无从判断原因，重试必然同样失败。(2) 一份 Codex rollout 里的 function_call 记了 "name": ""（工具名缺失），该条与其 output 条目标题都成为空串，同样让整份对话被拒。
FIX: 在 buildDisplay 与 Codex 的 display 构造处统一收口标题：写一个 displayTitle(text, fallback)，做 trim → 空则取 fallback → slice(0,256)，让所有 title（Claude 五处、Codex 三处）都经过它。同时在 Main 侧送进 worker 前跑一次 isImportedConversation，不过就以「第 N 条条目不合法」的可读错误在本地失败。补用例：超长 raw.type、空 function_call.name 两种输入都要能正常导入（标题被截断/回落），而不是整份被拒。
REFUTER(CONFIRMED,low): 结构性不一致属实，但触发输入偏罕见，故我把严重级从 medium 降到 low。校验侧：shared/types/legacyImport.ts:260-264 `case 'display': return [...].includes(String(value.displayKind)) && nonEmptyString(value.title) && value.title.length <= 256`。生产侧我逐处核对：ClaudeSourceAdapter.ts:404 `title: \`Legacy tool call: ${item.name.slice(0, 256)}\`` 前缀 18 字符，上界 274；:447 `Legacy tool result: ${toolName.slice(0,256)}` 上界 276；:419 `Unsupported Claude assistant block: ${item.type}` 与 :502 `Unsupported Claude entry: ${raw.type}` 都对未截断的原始 type 做插值；:487 `title: attachment.name ?? attachment.mediaType`，其中 name = path.basename(item.title)（:144-145），若 title 不含 '/' 则 basename 原样返回整串，同样无上界。buildDisplay（:278-281）只是 `{ kind: 'display', ...input }`，不做任何收口。Codex 侧 CodexRollout.ts:151 `const name = typeof payload.name === 'string' ? payload.name.slice(0, 256) : 'Codex tool';` 对空串成立 → :166 `title: name` 为 ''，nonEmptyString 不过；且 :153 calls.set(id, name) 会把空名传给 :174 的 output 条目。「只在跨进程后才暴露」也属实：grep isImportedConversation 全仓只有 legacyImport.ts:317（worker 准入，piWorkerRpcServer.ts:450 handleImport 调用，不过就回 WORKER_INVALID_PAYLOAD 并拒整份）与 CodexSessionScanner.test.ts:40 一处测试断言，Main 送出前不跑同一套校验。降级理由：238+ 字符的工具名 / entry type 属异常输入，日常不发生。属静态推断，未执行验证。
WAIVER(none): 无 — 全文档检索无命中

### [import-up-06] LOW security confirmed | P5-4 上游 | src/main/services/legacyImport/legacyImportSanitization.ts:8 | 脱敏只作用在不进模型上下文的 display 行；进上下文的正文一个字符都不过滤，且正则认不出 JSON 形态的密钥
DESC: 两件事叠在一起，都与「脱敏」这个模块名给人的印象不符。其一，施加的位置与风险的位置错开：boundedSanitizedValue 与 sanitizedToolOutput 在两个适配器里只用在工具输入/输出上（ClaudeSourceAdapter.ts:407、451；CodexRollout.ts:169、181），而这些一律落成 kind:'display' 的 custom 条目——按 nativeImport.ts 的设计这类条目不进模型上下文（assertUsable 专门守这条性质）。反过来，真正会成为模型上下文的 user 正文（ClaudeSourceAdapter.ts:466、CodexRollout.ts:136）与 assistant 的 text/thinking 块（ClaudeSourceAdapter.ts:376-389、CodexRollout.ts:137/146）只过 boundedText 做长度截断，不过任何脱敏。公允地说这不是新增泄漏面（文本本来就在用户自己机器上的 Claude/Codex 日志里，续聊送回模型也正是原产品当时做过的事），所以判 low；但命名与注释会让后来人以为导入内容整体过了一道过滤。其二，SECRET_TEXT 认不出 JSON 形态：赋值分支要求键名后紧跟空白或 :/=，而 JSON 里键名后是引号，所以 "api_key": "…" 完全不匹配。我用等价的纯函数复刻在本机跑过一遍（node -e，未触仓库代码）。
EVIDENCE: src/main/services/legacyImport/legacyImportSanitization.ts:8-23
const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_TEXT =
  /(bearer\s+)[^\s]+|(sk-[A-Za-z0-9_-]{8,})|((?:api[_-]?key|token|password)\s*[:=]\s*)[^\s,;]+/gi;
const BASE64_LIKE = /^[A-Za-z0-9+/=_-]{512,}$/;

node -e 复刻 SECRET_TEXT 的替换结果（2026-09-15 本机执行）：
  "{\"api_key\": \"AKIAIOSFODNN7EXAMPLE\"}"      => 原样，未脱敏
  "{\"token\":\"ghp_0123456789abcdefghij\"}"       => 原样，未脱敏
  "export GITHUB_TOKEN=ghp_0123456789abcdefghij"   => "export GITHUB_TOKEN=[redacted]"  ← 同一个值，等号形态就认
  "Authorization: Bearer abc.def.ghi"              => "Authorization: Bearer [redacted]"
  "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG"    => 原样
  "xoxb-<redacted-example>"              => 原样
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefg"   => 原样（JWT）
  "/home/zhangsan/.ssh/id_rsa"                     => 原样（绝对路径/用户名）
  "zhangsan@example.com"                           => 原样（邮箱）

src/main/services/legacyImport/ClaudeSourceAdapter.ts:376-380 —— 进上下文的正文，只截长度不脱敏
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          ensureAssistant().blocks.push({
            type: 'text',
            ...boundedText(item.text.trim(), LEGACY_IMPORT_MAX_TEXT_CHARS),
          });
SCENARIO: 用户在 Claude Code 里让模型 cat ~/.config/app/credentials.json，工具输出是 {"api_key": "AKIA…"}。导入这条会话：工具输出走 sanitizedToolOutput，但 JSON 形态不被 SECRET_TEXT 命中，明文原样写进会话文件的 display 行（这一行至少不进模型上下文）。同一段密钥若是用户自己在提问里贴出来的（「我的 key 是 AKIA…，为什么报 403」），它落在 user 正文里，既不脱敏、又会在续聊时作为上下文发给模型。绝对路径与邮箱两类同理，任何形态都不被处理。
FIX: 两件事分开做。(1) 明确并写下脱敏口径：若目标是「不把密钥喂回模型」，就把 sanitizeString 也施加到 user/assistant 正文（text 与 thinking 都要）；否则在文档里写明「导入保持原文，脱敏只针对 display 行的第三方载荷」，让命名与实际一致。(2) 补 JSON 形态：把赋值分支扩成 (?:"?(?:api[_-]?key|token|password|secret)"?\s*[:=]\s*"?)，并按需补 ghp_ / github_pat_ / xox[baprs]- / AKIA[0-9A-Z]{16} / JWT 四类常见前缀。用例用上面那张表逐行钉。
REFUTER(CONFIRMED,low): 两点都复核成立，严重级与审查员一致取 low。(1) 施加位置：legacyImportSanitization.ts:42 boundedSanitizedValue 与 :54 sanitizedToolOutput 的全部调用点是 ClaudeSourceAdapter.ts:407（tool_use 的 input）、:451（tool_result 的 output）与 CodexRollout.ts:169、:181，四处产出的都是 kind:'display' 条目；而会进模型上下文的正文只过长度截断：ClaudeSourceAdapter.ts:376-380 text 块、:386-389 thinking 块、:466 `const bounded = boundedText(cleaned, LEGACY_IMPORT_MAX_TEXT_CHARS)` 的 user 正文，CodexRollout.ts:136 user、:137/:146 assistant text 与 thinking，均无 sanitize。display 不进上下文这条性质有代码背书：nativeImport.ts:194-203 assertUsable 专门检查 customType === LEGACY_IMPORT_CUSTOM_TYPE_DISPLAY 是否泄漏进 snapshot.messages，文件头 :22-27 注释亦写明 'must not reach the model as context'。(2) 正则缺口我用等价纯函数离线跑过（/tmp 下 node -e，未 import 仓库代码），结果与审查员列表逐行一致：`{"api_key": "AKIA…"}` 与 `{"token":"ghp_…"}` 原样不脱敏，而同一枚 token 写成 `export GITHUB_TOKEN=ghp_…` 就被替换为 [redacted]；AWS_SECRET_ACCESS_KEY=、xoxb-、JWT、绝对路径、邮箱五类全部原样。根因在 legacyImportSanitization.ts:9-10 的赋值分支 `((?:api[_-]?key|token|password)\s*[:=]\s*)[^\s,;]+` 要求键名后紧跟空白或 :/=，JSON 里键名后是引号，故不匹配；另 SENSITIVE_KEY（:8）只在 :37 对对象键名生效，字符串化后的 JSON 走不到那条路径。保持 low：这些文本本就在用户本机的 Claude/Codex 日志里，导入不新增泄漏面，问题是命名与实际口径不符 + 覆盖面缺口。
WAIVER(none): 无 — 全文档检索无命中

### [import-up-07] LOW test-gap confirmed | P5-4 上游 | src/main/services/legacyImport/__tests__/CodexImportIntegration.test.ts:16 | 退役后没有任何用例把真实转写结果喂给 native 写入器，而写入器自己的固定装置用的是上游从不产出的两种形状
DESC: fe246bd6（第 10 批 P6-5）把 CodexImportIntegration.test.ts 的后半段删掉了：改之前它把 CodexSourceAdapter 的转写结果交给 PiLegacyImportWriter 写成真会话文件、再用 pi 的 SessionManager.open 读回来，断言 fixture_tool 与 encrypted_content 在盘上有、在模型上下文里没有。改之后只剩「转写结果自身长什么样」，写入那一半的注释说交给 src/runtime/__tests__/nativeImport.test.ts。问题是那边的固定装置不是从上游来的：nativeImport.test.ts:51-79 的 entries 里有两种形状上游没有任何生产者——kind:'tool_result'（全仓非测试代码零处产出，唯一命中是类型定义 legacyImport.ts:95 与这个固定装置）与 assistant 的 {type:'tool_call'} 块（legacyImport.ts:76 定义，两个适配器都不产：Claude 把 tool_use 落成 display，Codex 把 function_call 落成 display）。于是接缝两边测的是两套形状，真实导入产生的形状在写入侧只被 conversation() 里那一条 attachment display 覆盖到。批评者缺口 4 点名要确认的那件事目前没有自动化用例守着——我是靠 git show 逐行比对确认一致的，下一次有人改上游或改写入器不会有测试发现漂移。顺带：CodexImportIntegration.test.ts:59 的 expect(spoken).not.toContain('encrypted_content') 断言的是转写结果的 user/assistant 条目里没有该字符串，比原来的「模型上下文里没有」弱一档。
EVIDENCE: src/runtime/__tests__/nativeImport.test.ts:56-70 —— 上游从不产出的两种形状
        blocks: [
          { type: 'thinking', text: '先看事件绑定' },
          { type: 'text', text: '按钮的 onClick 被覆盖了' },
          { type: 'tool_call', toolCallId: 'call-1', name: 'read', input: { path: 'a.ts' } },
        ],
        ...
      {
        kind: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'read',
        output: 'export const a = 1;',

$ grep -rn "kind: 'tool_result'" src/ --include=*.ts
src/runtime/__tests__/nativeImport.test.ts:64:        kind: 'tool_result',
src/shared/types/legacyImport.ts:95:      kind: 'tool_result';

src/main/services/legacyImport/__tests__/CodexImportIntegration.test.ts:16-22 —— 交接说明
 * P6-5 之前这个用例还把转写结果交给 `PiLegacyImportWriter` 写成会话文件再读回来。
 * 那个写入方随旧引擎一起删了，而**写入这一半现在归 runtime 侧**：
 * `src/runtime/__tests__/nativeImport.test.ts` 验的是同一件事…
SCENARIO: 有人以后调整 ClaudeSourceAdapter 的 display 条目字段（例如把 toolName 改名、或让工具调用改走 assistant 的 tool_call 块以便在时间线上配对），Main 侧用例只断言「有 user、有 assistant、包含 fixture_tool」，runtime 侧用例用的是自己手写的固定装置——两边都绿，而真实导入产出的转录在渲染层少了工具行或多了不该进上下文的行，直到有人真的导一条会话才发现。
FIX: 把 CodexImportIntegration.test.ts 的端到端补回来，接到 native 写入器上：真实 fixture → CodexSourceAdapter.read → NativeLegacyImportWriter.create → JsonlSessionStore.open(mode:'resume')，断言三件事——盘上有 fixture_tool、store.snapshot().messages 里没有、两种 customType 齐全。若不愿让 Main 侧测试依赖 runtime 子包，退一步在 runtime 侧新增一条用例，其 ImportedConversation 由 Main 侧适配器的真实输出固化成 JSON fixture。另外把 tool_result / tool_call 两条无生产者的契约分支明确标注为「为将来保留」或直接删掉。
REFUTER(CONFIRMED,low): 复核成立（测试缺口）。1) 退役前确有端到端：git show fe246bd6^:src/main/services/legacyImport/__tests__/CodexImportIntegration.test.ts 第 55-70 行是 `const reopened = real.SessionManager.open(imported.finalSessionFile)` + `expect(JSON.stringify(context.messages)).not.toContain('fixture_tool')` + `expect(disk).toContain('fixture_tool')`；fe246bd6 的 --stat 显示该文件 `62 +-`，现文件（共 62 行）只剩转写结果自检，最强的断言退化为 CodexImportIntegration.test.ts:59 `expect(spoken).not.toContain('encrypted_content')`（spoken 只由 user/assistant 条目拼成，display 行根本不在里面，等于绕开了最容易泄漏的那类条目）。2) 接手方 src/runtime/__tests__/nativeImport.test.ts:52-79 的固定装置确实含两种上游无生产者的形状：`{ type: 'tool_call', toolCallId: 'call-1', ... }`（58 行）与 `kind: 'tool_result'`（64 行）；全仓 grep 显示 legacyImport 侧这两种形状只有类型定义 src/shared/types/legacyImport.ts:76 / :95 与这份固定装置，两个适配器都落成 display（CodexRollout.ts:150-183 的 function_call / function_call_output 一律 `kind:'display', displayKind:'tool'`）。3) 全仓再无第二处把适配器真实输出喂给 NativeLegacyImportWriter：grep 结果里 nativeImport 只被 src/runtime/worker/nativeImport.ts 与 src/runtime/__tests__/nativeImport.test.ts 命中，而后者的输入是手写 conversation()。降一档的理由：审查员设想的漂移方向之一其实有守卫——src/main/services/legacyImport/__tests__/ClaudeSourceAdapter.test.ts:142-147 `expect(result.conversation.entries.some(entry => entry.kind === 'tool_result' || (entry.kind === 'assistant' && entry.blocks.some(b => b.type === 'tool_call')))).toBe(false)` 会在适配器改走 tool_call 时变红；但 display 条目字段改名/写入器 display 分支（nativeImport.ts:91-106 displayData + 128-135 appendEntry）与真实转写之间仍然没有任何联合用例，所以缺口成立，级别 low（测试缺口，无用户可见错误）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/topics/p6-cutover.md:86；相关原文：「Codex 导入集成用例（`CodexImportIntegration.test.ts`）原本「转写 + 用旧写入方落盘 + 用 pi 读回」，现收敛为 Main 侧那一半（转写正确、源文件零改动）；落盘与读回那一半由 `nativeImport.test.ts` 与 `sessionInterop.test.ts` 覆盖。」

### [import-up-08] LOW correctness confirmed | P5-4 上游 | src/main/services/legacyImport/CodexRollout.ts:140 | Codex 的思考块只读 summary 不读 content，与同仓的 codexItemMapper 口径不一致，丢了也不记诊断（静态推断）
DESC: parseCodexRollout 处理 reasoning 条目时只读 payload.summary；同一仓库里读 Codex 的另一处实现 codexItemMapper.extractReasoningText 读的是 summary 和 content 两个数组，并专门写了注释说明为什么两个都要防御性地读。两处对同一种磁盘记录给出不同答案。丢失是静默的：:143 的 if (text) 只有非空才 push，summary 为空而 content 有内容时既不产生 thinking 块、也不写 diagnostics（对比 :149 的加密 reasoning 是记诊断的）。静态推断，未执行验证。
EVIDENCE: src/main/services/legacyImport/CodexRollout.ts:139-149
    } else if (type === 'reasoning') {
      const text = readCodexTextContent(payload.summary, '\n');     // 只读 summary
      if (text.length > LEGACY_IMPORT_MAX_TEXT_CHARS)
        throw new Error('Codex reasoning exceeds import text limit');
      if (text)                                                      // 空则静默跳过
        result.entries.push({ kind: 'assistant', blocks: [{ type: 'thinking', text }], ...provenance });
      if (payload.encrypted_content) diagnose(`Encrypted reasoning omitted at line ${index + 1}`);

src/agent-host/codexItemMapper.ts:281-296 —— 同仓另一处口径
/**
 * Reasoning text: `summary[]` first, then `content[]`.
 * ... `content` was empty in all of them, so it is read the same defensive way
 * rather than assumed to have a shape.
 */
function extractReasoningText(item: Record<string, unknown>): string {
  const chunks: string[] = [];
  const summary = readCodexTextContent(item.summary);
  if (summary) chunks.push(summary);
  const content = readCodexTextContent(item.content);
  if (content) chunks.push(content);
  return chunks.join('\n\n');
}
SCENARIO: 某个版本的 Codex（或某种配置下）把推理正文写在 reasoning.content 而不是 reasoning.summary 里——这正是 codexItemMapper 的注释所防的那种情况。导入这类 rollout 时，思考块全部丢失，转录里只剩消息与工具行，diagnostics 里也没有任何线索说明少了东西。
FIX: 让 CodexRollout 复用 codexItemMapper 已有的 extractReasoningText（它已导出 readCodexTextContent，把 extractReasoningText 一并导出即可），保持一处口径；并在 summary 与 content 都为空但条目存在时写一条 diagnostics。补一条用例：只有 content 的 reasoning 条目要产出 thinking 块。
REFUTER(CONFIRMED,low): 代码事实成立，但触发源未证实，按 low 记（静态推断，未执行）。src/main/services/legacyImport/CodexRollout.ts:139-149：`} else if (type === 'reasoning') { const text = readCodexTextContent(payload.summary, '\n'); ... if (text) result.entries.push({ kind:'assistant', blocks:[{type:'thinking',text}] ...}); if (payload.encrypted_content) diagnose(...) }` —— 只读 summary，text 为空且无 encrypted_content 时既不产块也不写诊断。同仓另一处 src/agent-host/codexItemMapper.ts:289-296 `extractReasoningText` 先读 summary 再读 content 并 join，两者对同一种磁盘记录口径确实不同；且 CodexRollout.ts:9 已经 `import { readCodexTextContent } from '../../../agent-host/codexItemMapper.ts'`，复用成本极低。无法证伪的部分：readCodexTextContent（codexItemMapper.ts:256-279）接受 text / input_text / output_text / summary_text 与裸字符串，所以 content 若有正文确实读得出来，丢失路径在逻辑上闭合。可以弱化的部分：仓库唯一的 reasoning 实证 src/agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl:7 是 `"summary": [], "encrypted_content": "[redacted]"`（走诊断分支），且 codexItemMapper 的注释自称 content 在所有实测帧里都是空的——即「Codex 把正文写进 reasoning.content」这一前提在本仓没有任何样本支撑，属潜在而非已发生的丢失，故维持 low。
WAIVER(none): 无 — 全文档检索无命中

### [import-up-10] LOW docs confirmed | H/21 对话导入代码侧 | docs/plantree/plans/runtime-evolution/evidence/external-agent-migration/README.md:0 | H/21 C1～C6 的现场证据记录的是 pi 时代的落盘路径，与 native 的扁平 sessions 目录不符，未随 P6-5 更新
DESC: H/21 的真机闭环记录（2026-09-11）第 4 条写的是「文件落在统一 sessions 目录 ✅ …/pi-agent/sessions/--home-ai-code-ai-client--/…_import-codex-….jsonl」——按工作区分子目录、文件名带时间戳前缀，这是 pi 写入器的布局。当前 native 写入器写的是 <agentDir>/sessions/<targetPiSessionId>.jsonl（src/runtime/worker/nativeImport.ts:255-265），扁平、无时间戳前缀；这与 native 普通会话的布局一致（src/runtime/worker/nativeWorkerRuntime.ts:902），所以代码本身自洽、不是缺陷。问题在证据：按这份记录去复验「文件落在哪儿」的人会在一个不存在的路径下找文件；同段「与 GUI/TUI 共用目录，验证案例 6」所依据的目录结构也已变化。同页「离线探针」小节还写着「piLegacyImport 有一条专门的上下文泄漏检查」，该模块已在 fe246bd6 删除。属于审计 README 第八节点名的「判定与验证结果未回写」那一类，只是落在 H/21 的证据页。
EVIDENCE: docs/plantree/plans/runtime-evolution/evidence/external-agent-migration/README.md「真机闭环」表第 4 行：
| 4 | 文件落在统一 sessions 目录 | ✅ `…/pi-agent/sessions/--home-ai-code-ai-client--/…_import-codex-….jsonl`（与 GUI/TUI 共用目录，验证案例 6） |

同页「离线探针」小节：
| 工具调用 | 作为只读 `display` 条目保留，不进模型上下文（`piLegacyImport` 有一条专门的上下文泄漏检查） |

src/runtime/worker/nativeImport.ts:255-265 —— 当前布局
  private fileFor(dir: string, targetPiSessionId: string): string {
    return join(dir, `${targetPiSessionId}.jsonl`);
  }
  private get sessionsDir(): string {
    return join(this.agentDir, SESSIONS_DIR);
  }
SCENARIO: 批次 E 上机复验 H/21 时，执行人按这份记录去 …/pi-agent/sessions/--home-ai-code-ai-client--/ 下找导入产物，找不到，于是把一次正常的导入判成失败；或者反过来，看到扁平目录下的 import-codex-….jsonl 与记录不符，误以为出了回归。
FIX: 在该页加一条时点注记（与 T027 对其它证据页的做法一致）：说明 2026-09-11 的路径是 pi 写入器的布局，fe246bd6（P6-5）之后导入产物落在 <agentDir>/sessions/<targetPiSessionId>.jsonl，与 native 普通会话同一布局；同时把「piLegacyImport 有一条专门的上下文泄漏检查」改写为 nativeImport.ts 的 assertUsable。不改结论本身（C1～C6 的验收仍然成立）。
REFUTER(CONFIRMED,low): 证据页过期成立（docs）。docs/plantree/plans/runtime-evolution/evidence/external-agent-migration/README.md:151 原文：`| 4 | 文件落在统一 sessions 目录 | ✅ \`…/pi-agent/sessions/--home-ai-code-ai-client--/…_import-codex-….jsonl\`（与 GUI/TUI 共用目录，验证案例 6） |`——按工作区分子目录 + 时间戳前缀。当前 native 写入器是扁平命名：src/runtime/worker/nativeImport.ts:255-261 `private fileFor(dir: string, targetPiSessionId: string) { return join(dir, \`${targetPiSessionId}.jsonl\`); }` 与 `private get sessionsDir() { return join(this.agentDir, SESSIONS_DIR); }`（SESSIONS_DIR='sessions'，见 :59），与普通 native 会话一致（src/runtime/worker/nativeWorkerRuntime.ts:901-903 `return join(agentDir, 'sessions', \`${this.logicalSessionId}.jsonl\`)`），代码本身自洽。同页 :142 的「（`piLegacyImport` 有一条专门的上下文泄漏检查）」也已失效：`git show fe246bd6 --stat` 含 `src/agent-host/piLegacyImport.ts | 376 -----` 与 `src/agent-host/__tests__/piLegacyImport.test.ts | 143 --`。时间线也对得上：该页最后一次改动是 b7bbbefe（2026-09-11），`git merge-base --is-ancestor b7bbbefe fe246bd6` 成立，退役提交 fe246bd6 是 2026-09-14，此后无人回写，页内 grep 不到任何 P6-5 / native / 时点注记字样。危害限于复验者按错路径找产物，故 low。
WAIVER(none): 无 — 全文档检索无命中

### [terminal-04] LOW robustness confirmed | GUI A/2 代码侧 | src/renderer/hooks/useXterm.ts:981 | 复活用的 open 不带 sessionFile：PTY 已不在时会静默起一个全新的 pi 会话（静态推断）
DESC: 终端重新变为活跃时的那次 piTui.open 只传 terminalId / cwd / cols / rows，没有 sessionFile。活终端存在时走恢复分支没事；但只要那一刻 #live 里已无此 terminalId（pi 快速失败自退、被容量淘汰、被别处 dispose），Main 就进入新建分支，用 buildPiTuiArgs(cliPath, undefined) spawn 一个不带 --session 的全新 pi 会话；同时因为请求里没有 sessionFile，IPC 也不做 TUI-1 检查、不 transferTo、不记 tuiWrittenSessions。static_inference：需起 Electron 才能观察。
EVIDENCE: void window.electronAPI.piTui
  .open({
    terminalId: piTuiTerminalId,
    cwd: cwd || window.electronAPI.env.HOME,
    cols: terminal.cols,
    rows: terminal.rows,
  })
  .catch(() => {});
SCENARIO: pi CLI 起来就失败并退出（例如会话里的模型本机没有、配置错误），退出事件先把 #live 条目删掉；紧接着的那次渲染把 isLoading 翻成 false，本 effect 触发 → Main 看不到活终端 → 新建分支 → 起一个与当前聊天无关的空白 pi 会话。pi 会话文件是懒写的，通常不留垃圾文件，但用户会看到终端「莫名其妙变成新会话」，且这个终端不在任何 guard / 重读记账里。
FIX: 这次复活调用也带上 piTuiSessionFile（与首次 open 同源），让恢复失败时的新建分支仍绑定同一 JSONL 并重走 TUI-1 检查与记账；或给 open 增加一个「只恢复、不新建」的模式供这条路径使用。
REFUTER(CONFIRMED,low): 漏传属实（静态推断），但今天能走到新建分支的路径比审查员描述的窄。src/renderer/hooks/useXterm.ts:973-989 原文：`if(!piTuiTerminalId||isLoading||!ptyIdRef.current) return; ... void window.electronAPI.piTui.open({terminalId:piTuiTerminalId, cwd:cwd||window.electronAPI.env.HOME, cols:terminal.cols, rows:terminal.rows}).catch(()=>{});`，依赖 `[cwd,isActive,isLoading,piTuiTerminalId]`，确无 sessionFile；对照首次 open（757-765）带 `...(piTuiSessionFile?{sessionFile:piTuiSessionFile}:{})`。Main 侧一旦 `#live` 无此 id 就落到 PiTuiPty.ts:203-216 的新建分支 `buildPiTuiArgs(launch.cliPath, request.sessionFile)`（sessionFile 为 undefined → piTuiSession.ts:48-51 返回 `[cliPath]`，无 --session），且 src/main/ipc/piTui.ts:123-138 的 TUI-1 检查 / `transferTo` / `tuiWrittenSessions.add` 全部包在 `if(request.sessionFile)` 里，一起被跳过。我逐条排查了「#live 已空但组件仍挂载」的路径：容量淘汰（PiTuiPty.ts:322-331，上限 2）在一个窗口只有一个 AgentTerminal 的现状下够不到（全仓仅 ChatWorkspace.tsx:214 一处 `<AgentTerminal`）；pi 正常自退会经 useXterm.ts:676-688 的 onExit → handleTuiExit → setTuiTerminalId(null) → 卸载。真正剩下的是审查员写的那条竞态：pi 启动即失败，进程在 open 返回与 `setIsLoading(false)` 触发本 effect 之间退出 → 新建分支起一个无 --session 的空白会话。由于 `#enqueue` 保序，随后的 dispose 通常会把这个游离进程收掉，用户可见后果只是终端「莫名变成新会话」，无文件损坏，故判 low。
WAIVER(none): 无取舍 — 核对来源：raw/terminal-tui.md；相关原文：「复活路径丢 `sessionFile`（terminal-04）」

### [terminal-09] LOW windows confirmed | GUI A/2 代码侧 | src/main/services/terminal/ShellDetector.ts:356 | Windows 默认 shell 返回 pwsh.exe，且 PtyManager 的 spawn 失败回退只有 Unix 分支（静态推断）
DESC: 两处不一致叠加。getDefaultShell() 在 Windows 上无条件返回 'pwsh.exe'，而产品默认设置明确是 PowerShell 5.x（src/renderer/stores/settings/defaults.ts:308，注释写明 PowerShell 7 需单独安装）。同时 PtyManager.create 的 spawn 失败回退只在 !isWindows 分支里，Windows 分支直接 throw error；create 前那次 existsSync(shell) 预检也只在非 Windows 执行。static_inference：Windows 上一次都没跑过。
EVIDENCE: getDefaultShell(): string {
  if (isWindows) {
    // Try pwsh.exe (PowerShell 7) from PATH first
    return 'pwsh.exe';
  }
// PtyManager.ts:396
} catch (error) {
  if (!isWindows) {
    ... // 找一个可用 shell 重试
  } else {
    throw error;
  }
}
SCENARIO: 两条路。其一，任何不带 shell 也不带 shellConfig 的 session.create（渲染层今天总会带上设置里的 shellConfig，所以主要是留给远端/未来调用方的坑）在未装 PowerShell 7 的 Windows 上会尝试 spawn 不存在的 pwsh.exe。其二，用户填了自定义 shell 路径后把那个程序卸载/改名：Unix 上静默回退到可用 shell，Windows 上直接把 node-pty 原生 spawn 错误抛给渲染层，面板显示 `Error invoking remote method 'session:create': ...` 之类原文。
FIX: getDefaultShell() 的 Windows 分支改为先探测 pwsh.exe、不可用退回 powershell.exe（commandExists 已有现成实现），与渲染层默认对齐；PtyManager.create 的回退逻辑给 Windows 也补一条（powershell.exe → cmd.exe），至少保证失败时给出可读说明。
REFUTER(CONFIRMED,low): 两处代码事实都属实，但可达性比描述更弱（静态推断，未在 Windows 跑过）。src/main/services/terminal/ShellDetector.ts:354-358 `getDefaultShell(){ if(isWindows){ // Try pwsh.exe (PowerShell 7) from PATH first\n return 'pwsh.exe'; }` 确为无条件返回，与 src/renderer/stores/settings/defaults.ts:303-309 `shellType: executionPlatform==='win32' ? 'powershell' : 'system'`（注释写明 PowerShell 7 需单独安装）不一致；同文件 108-120 已有现成的 `commandExists`（Windows 走 `where`）却没被用上。src/main/services/terminal/PtyManager.ts:391-416 的 spawn 失败回退确实整段包在 `if(!isWindows)` 里，`else { throw error; }`；352-356 的 `if(!isWindows && shell.includes('/') && !existsSync(shell))` 预检同样只在非 Windows。但第一条今天基本够不到：`detectShell()` 只在 PtyManager.ts:348-350 的 `else` 分支（既无 options.shell 也无 options.shellConfig）被调用，而渲染层唯一入口 useXterm.ts:716-717 `...(command?{shell,args}:{shellConfig})` 的 shellConfig 来自 settings store（src/renderer/stores/settings/index.ts:152 `shellConfig: getDefaultShellConfig()`，zustand persist 与初始 state 合并，不会缺失），远端另有 RemoteServerSource 自己的实现，所以这一半更接近「留给未来/远端调用方的坑」。第二条（Windows 无回退、原生 spawn 错误直传渲染层）是真实的平台不对等，但只影响错误形态与可读性。合并判 low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/README.md（历史决策/待验证表，Windows 相关条目）；roadmap.md 批次 E T032/T033；相关原文：「T033 | 最后一次上机：加密 Windows 一次性全量验收」

### [terminal-05] LOW test-gap confirmed | H/20 Main 半边 | src/main/services/terminal/__tests__/t35FinalAbsence.test.ts:108 | 守卫用例声称「TUI 不带 resume 参数」，而 TUI 现在正是靠 --session 续接会话
DESC: 这条用例叫「uses absolute bundled Pi CLI and packaged Node paths without resume flags」，断言 PiTuiPty.ts 文本里不出现 '--session'。它今天还绿，只是因为 Q17 之后拼参数的代码搬到了 piTuiSession.ts 的 buildPiTuiArgs，而 TUI 的行为恰恰相反：只要聊天有 JSONL，跑的就是 pi --session <file>。一条用名字和断言共同陈述「我们不做 X」的守卫，在我们已经做了 X 之后仍然绿，会把后来的人引向错误结论。
EVIDENCE: it('uses absolute bundled Pi CLI and packaged Node paths without resume flags', () => {
  const service = read('src/main/services/terminal/PiTuiPty.ts');
  ...
  expect(service).not.toContain("'--session'");
  expect(service).not.toContain("'--continue'");
});
// piTuiSession.ts:48
export function buildPiTuiArgs(cliPath: string, sessionFile?: string | null): string[] {
  const file = sessionFile?.trim();
  return file ? [cliPath, '--session', file] : [cliPath];
}
SCENARIO: 任何按这条守卫理解 TUI 行为的人（包括下一轮审计）都会得出「内嵌终端从不接管既有会话文件」的结论，而这正是 H/20 整条互斥设计存在的原因。守卫本身也失去意义：它只能防住「有人在 PiTuiPty.ts 里写 --session 字面量」，防不住任何真实回归。
FIX: 改成陈述实际不变量的两句——--continue / --resume 这类「pi 自选会话」的参数在整个 TUI 路径（PiTuiPty.ts + piTuiSession.ts）都不出现；--session 只能由 buildPiTuiArgs 产出且必须带显式文件参数。用例名同步改掉。
REFUTER(CONFIRMED,low): 复核成立，推翻未果。src/main/services/terminal/__tests__/t35FinalAbsence.test.ts:108-115 原文：it('uses absolute bundled Pi CLI and packaged Node paths without resume flags', ...) 内部 const service = read('src/main/services/terminal/PiTuiPty.ts'); expect(service).not.toContain("'--session'"); expect(service).not.toContain("'--continue'");。而实际拼参数在 src/main/services/terminal/piTuiSession.ts:48-51：export function buildPiTuiArgs(cliPath, sessionFile?) { const file = sessionFile?.trim(); return file ? [cliPath, '--session', file] : [cliPath]; }，由 PiTuiPty.ts:210 的 this.#spawn(launch.nodePath, buildPiTuiArgs(launch.cliPath, request.sessionFile), ...) 调用；PiTuiPty.ts:138-140 自己的注释也写着 “The per-terminal `--session <file>` is appended at spawn”，只是不带引号所以断言仍绿。历史核对：t35FinalAbsence.test.ts 最后两次改动是 8aafd450(T35 退役)与 bc05ddcb(i18n)，而 --session 由 fe246bd6(第 10 批 H/20)引入 piTuiSession.ts，之后 T001~T036 无人回头改这条守卫（git log -- 该测试文件、grep 硬化计划文档均无命中）。真实不变量另有 src/main/services/terminal/__tests__/piTuiSession.test.ts 钉着 buildPiTuiArgs，所以这条只是名字与断言共同陈述了一个反事实、且只能防 PiTuiPty.ts 里的字面量，属 low 级测试/表述缺口，非行为缺陷。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T003 行；raw/terminal-tui.md；相关原文：「一条用名字和断言共同陈述「我们不做 X」的守卫，在我们已经做了 X 之后仍然绿，会把后来的人引向错误结论」

### [terminal-07] LOW docs confirmed | GUI A/2 代码侧 | src/renderer/components/chat/__tests__/tuiHandoverWiring.test.ts:42 | 「suspend 之后另一个写者不再追加」这句话不成立
DESC: openGui 的做法是 piTui.suspend(terminalId) 然后 chat.reloadSession，守卫用例把顺序钉死并解释为「the reload has to read a file the other writer is no longer appending to」。但 suspend 在 Main 侧只做两件事：把 live.suspended 置真、把后续 PTY 输出转存进重放缓冲（PiTuiPty.ts:273-281）。pi CLI 进程完全不受影响，仍在跑、仍在 appendFileSync 写同一个 JSONL。usePresentationSwitch.ts:132-146 的大段注释同样把 suspend 描述成安全边界。
EVIDENCE: suspend(terminalId: string): Promise<void> {
  return this.#enqueue(terminalId, () => {
    const live = this.#live.get(terminalId);
    if (!live) return;
    live.suspended = true;          // 只影响输出转发，不影响进程
// tuiHandoverWiring.test.ts:42
// Order is the correctness point, not a preference: the reload has to read
// a file the other writer is no longer appending to.
SCENARIO: 用户在 TUI 里发起一轮回答，回答仍在流式产出时点 GUI。suspend 立即返回、reload 立即执行，而 pi 随后把这一轮剩下的条目继续写进文件——GUI 时间线缺这一段。只要用户后续在该会话有一次 GUI 写入（send / compact / rewind），tuiWrittenSessions 会触发「杀 + 重读」补回来，所以不是持久错误；但注释把一个顺序偏好说成了正确性保证，谁按它推理下一处改动都会推错。
FIX: 改写这两处注释说清真实语义（suspend 只停转发，真正的写者停止靠 send 路径的 dispose），并在 openGui 的 reload 之后补一句「此刻可能仍落后于文件，下次写入前会再读一次」。若要让离开终端时时间线立即完整，需要的是等这一轮结束或直接 dispose，而不是 suspend。
REFUTER(CONFIRMED,low): 复核成立。src/main/services/terminal/PiTuiPty.ts:273-281 suspend 全文只有：live.suspended = true; live.lastUsed = ++this.#usageSequence; this.#emitState(terminalId,'suspended');——没有任何 kill/wait/flush；对应 pty.onData 回调(PiTuiPty.ts:229-236) 在 active.suspended 时把数据塞进 replayBuffer 并 return，即只停转发，pi CLI 进程与它对 JSONL 的 append 完全不受影响。而 src/renderer/components/chat/__tests__/tuiHandoverWiring.test.ts:41-42 的注释原文 “the reload has to read a file the other writer is no longer appending to”，以及 src/renderer/components/chat/usePresentationSwitch.ts:131-145 把 suspend 说成安全边界，均与之矛盾。触发路径存在：src/renderer/components/workspace-shell/SessionBar.tsx:150-156 的 GUI 按钮 onClick={openGui} 没有任何 busy 判断（只有反方向的 openTui 在 usePresentationSwitch.ts:85-92 用 isSessionBusy 拒绝 mid-turn），openGui(usePresentationSwitch.ts:147-160) 直接 await suspend 后 await chat.reloadSession。补充我自己的核对：src/main/ipc/piTui.ts:135-138 的 tuiWrittenSessions.add 与 releaseSessionForHostPrompt 确实提供了“下次 GUI 写入前再读一次”的兜底，所以只是暂时性落后而非持久数据错误；且即便改成 dispose，未写盘的半轮也追不回来。故按注释/契约表述不实定 low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/topics/gui-tui-session-interop.md；相关原文：「TUI 持有会话时 GUI 发送路径必须先释放。」

### [terminal-06] LOW dead-code confirmed | GUI A/2 代码侧 | src/renderer/stores/worktreeActivity.ts:294 | TUI 活动指示灯拿 terminalId 当会话 id 查表，永远查不到
DESC: initAgentActivityListener 订阅 piTui.onData / onExit，用 event.terminalId 去 useAgentSessionsStore.sessions 里按 s.id 找 cwd。但 TUI 的 terminalId 形如 pi-tui-<uuid>（usePresentationSwitch.ts:96），而 useAgentSessionsStore 的条目来自已退役的 agent PTY 路线——全仓库唯一的 addSession( 调用在 src/renderer/hooks/useTerminal.ts:37，写的是另一个 store（useTerminalStore）。也就是说 useAgentSessionsStore.sessions 没有任何生产写入方，setForSession 里的 if (cwd) 永远为假。
EVIDENCE: export function initAgentActivityListener(): () => void {
  const setForSession = (sessionId: string, state: AgentActivityState) => {
    const cwd = useAgentSessionsStore.getState().sessions.find((s) => s.id === sessionId)?.cwd;
    if (cwd) useWorktreeActivityStore.getState().setActivityState(cwd, state);
  };
  const unsubscribeData = window.electronAPI.piTui.onData((event) => {
    setForSession(event.terminalId, 'running');
  });
SCENARIO: 用户在某个 worktree 里用 TUI 跑一轮，侧栏/worktree 列表的活动指示（绿点）不会亮，也不会在结束后置为 completed。App.tsx:109 每次启动都注册这个监听器，它只是恒定空转。属于 T35 退役后失去消费者的那一层（P6-5 的尾巴）。
FIX: 二选一：要留这个能力，就把 TUI 的 cwd 记在一张以 terminalId 为键的表里（PiTuiOpenRequest 里本来就有 cwd，Main 也在 LiveTerminal.cwd 存着，可随 data/exit 事件带出来）；不留就把 initAgentActivityListener 与 useAgentSessionsStore 里已无写入方的部分一起删掉。
REFUTER(CONFIRMED,low): 复核成立。src/renderer/stores/worktreeActivity.ts:293-301：setForSession 用 useAgentSessionsStore.getState().sessions.find((s) => s.id === sessionId)?.cwd 查 cwd，而传入的是 event.terminalId；TUI 的 id 在 src/renderer/components/chat/usePresentationSwitch.ts:96 生成为 `pi-tui-${crypto.randomUUID()}`。用 git grep（避开 grep 跳过含 NUL 源文件的坑）核对写入方：useAgentSessionsStore 全仓仅 worktreeActivity.ts:3/295、useWebInspector.ts:3/61（只读 getActiveSessionId）、agentSessions.ts 自身；唯一的 addSession( 生产调用在 src/renderer/hooks/useTerminal.ts:37，而该文件第 5 行 import 的是 useTerminalStore（另一张表）。同样地 agentCount 一侧的 incrementAgent/decrementAgent/setAgentCount 全仓也无调用方，只有 terminalCount 由 TerminalPanel.tsx:143 写。因此 if (cwd) 恒假，App.tsx:108-110 每次启动注册的这个监听器恒定空转（唯一残余可能是 localStorage 里旧版持久化的 sessions，其 id 也绝不会是 pi-tui-*）。硬化计划 docs/plantree/plans/runtime-hardening 下除本次审查原始稿外无任何 worktreeActivity 相关记录，T001~T036 未覆盖。属退役后失去写入方的死代码，low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T020 行（子代理数据与展示，Done 段）；相关原文：「T020 子代理数据与展示 — `60b250f3`（2026-09-15）。subagent-data-01～17、subagent-core-06/12/13 全部处理」

### [terminal-10] LOW contract-gap confirmed | H/20 Main 半边 | src/main/ipc/piTui.ts:162 | dispose() 不带 terminalId 会让这个窗口的控制器永久报废
DESC: PI_TUI_DISPOSE 的 handler 在没有 terminalId 时调 controller.disposeAll()，而 disposeAll / disposeAllSync 会把 #disposed 永久置真（PiTuiPty.ts:306-316），此后该实例每次 open 都抛 'Pi TUI controller is disposed'。应用退出与登出走的 disposeAllPiTuiControllers() 之所以没事，是因为它之后 controllers.clear() 了；从 IPC 这条路进来的实例留在 controllers 里，窗口不重开就再也起不来终端。preload 把这个重载暴露成公共 API（src/preload/index.ts:487 的 dispose: (terminalId?: string)）。诚实标注：今天渲染层所有调用都带 id，无现行触发路径，这是契约面的坑而非现行缺陷。
EVIDENCE: ipcMain.handle(IPC_CHANNELS.PI_TUI_DISPOSE, async (event, terminalId?: string) => {
  ...
  if (terminalId) await controller.dispose(terminalId);
  else await controller.disposeAll();      // #disposed 永久置真，实例仍留在 controllers 里
});
SCENARIO: 任何一次 window.electronAPI.piTui.dispose()（漏参、未来新调用方、清理路径复用）都会让当前窗口在本次应用生命周期内彻底失去内嵌终端，界面表现为每次点 TUI 都弹一句英文原文错误。
FIX: IPC 的整窗清理路径改成「disposeAll() 之后把该控制器从 controllers 里摘掉」，与 disposeAllPiTuiControllers 一致；或干脆取消 dispose() 的无参重载，让整窗清理只走 disposePiTuiWindow。
REFUTER(CONFIRMED,low): 复核成立，且审查员已诚实标注无现行触发路径。src/main/ipc/piTui.ts:162-167 原文：ipcMain.handle(IPC_CHANNELS.PI_TUI_DISPOSE, async (event, terminalId?: string) => { const controller = await controllerFor(event.sender); assertOwner(...); if (terminalId) await controller.dispose(terminalId); else await controller.disposeAll(); });。PiTuiPty.ts:306-307 disposeAll 首句 this.#disposed = true;（disposeAllSync:312-313 同）且不可复位；#openExclusive 在 PiTuiPty.ts:184 与 196 两处 if (this.#disposed) throw new Error('Pi TUI controller is disposed')。controllerFor(piTui.ts:86-97) 先查 controllers.get(windowId)，命中即直接返回旧实例，所以从 IPC 走 disposeAll 后该窗口拿到的永远是报废实例；对比 disposeAllPiTuiControllers(piTui.ts:210-220) 与 disposePiTuiWindow(piTui.ts:232-239) 都在之后 controllers.clear()/delete(windowId)，所以退出与登出路径确实无事。preload 侧 src/preload/index.ts:487 dispose: (terminalId?: string) 把可选参数暴露成公共 API。我逐一核对了现行调用方（usePresentationSwitch.ts:161/218/226、useXterm.ts:788），全部在非空判断后传 id，确无现行触发路径，故按契约面隐患定 low。
WAIVER(none): 无取舍 — 核对来源：raw/terminal-tui.md；src/preload/index.ts:487；相关原文：「诚实标注：今天渲染层所有调用都带 id，无现行触发路径，这是契约面的坑而非现行缺陷」

### [ah-lib-04] LOW dead-code confirmed | P6-5 尾巴 | src/agent-host/userResourcePaths.ts:23 | 模块零消费者，它承载的「技能装到哪」指令在 native 提示词里没有替身（静态推断）
DESC: userResourcePaths.ts 只导出 defaultSkillInstallInstructions 一个函数。在 src/ 与 scripts/ 全量检索该符号与文件名：零引用，也没有测试文件。它是 P6-5 退役后失去消费者的一层，T025 扫掉了五个孤儿模块（bundledFeaturePlugins / extensionInventory / commandInventory / sessionTierAuthorizer / permissionActivity），这一个不在清单上。比死代码本身更值得记的是它承载的行为：模块开头写「The one instruction every session appends about where skills get installed」，而 native 的提示词里没有任何一句告诉模型技能该装到哪——skills/prompt.ts 的 skillsSegment 只列已有技能的 name/description/location，prompt/segments.ts 的槽位表也没有对应槽。扫描端却是活的：skills/index.ts:223 仍把 join(home,'.agents','skills') 作为 user 作用域扫描根。也就是说「装到哪会被扫到」这条约定只剩扫描的一半，告知的一半没了。static_inference：零引用与「提示词无安装目录、扫描根仍在」都是静态可证的；「模型会装到扫描不到的地方」是行为推断。
EVIDENCE: src/agent-host/userResourcePaths.ts:1-2, 23-27
/**
 * The one instruction every session appends about where skills get installed.
...
export function defaultSkillInstallInstructions(
  home = process.env.HOME || process.env.USERPROFILE || homedir()
): string {
  return `When asked to install a skill, use ${join(home, '.agents', 'skills')} as the default installation directory, ...`;
}

检索（src + scripts，排除 node_modules）：defaultSkillInstallInstructions / userResourcePaths 的唯一命中是该文件自身，其余全在 docs/ 的历史证据与调研文档。

src/runtime/plugins/skills/index.ts:223（扫描端仍活着）
    roots.push({ path: join(home, '.agents', 'skills'), scope: 'user', rootMarkdown: false });
SCENARIO: 用户对 native 会话说「帮我把这个技能装上」。模型的系统提示词里没有任何安装目录约定，于是按先验猜一个位置（常见的是工作区内、~/.claude/skills、或 ~/.pi/agent/skills）。写进去后 skills/index.ts 的扫描根不覆盖那个目录，技能列表里不出现它，用户看到的是「装完了但用不了」——旧路径上 defaultSkillInstallInstructions 正是为避免这一幕存在的。
FIX: 两件事分开做：(1) 删除 src/agent-host/userResourcePaths.ts（无消费者、无测试，属 T025 同批清扫的漏网）；(2) 决定这句指令要不要在 native 侧复活——若要，作为静态文本并入 skills/prompt.ts 的 skills 槽（目录取 skills/index.ts 已算出的 user 作用域根，不要第二次算 home），并补一条断言「提示词里的安装目录必须等于扫描根之一」，把告知与扫描两半绑住；若不要，在 P6-5 落地记录里写明这是有意放弃的行为。
REFUTER(CONFIRMED,low): 两半都复核过。死代码：`grep -rn 'defaultSkillInstallInstructions|userResourcePaths' src/ scripts/`（排除 node_modules）唯一命中是 src/agent-host/userResourcePaths.ts:23 的定义本身，无测试文件。指令确实无替身：src/runtime/plugins/skills/prompt.ts 的 skillsSegment 只产出 'The following skills provide specialized instructions…' + 每个技能的 name/description/location，通篇没有安装目录；src/runtime/plugins/prompt/segments.ts:88 的槽位表只有 `{ id: 'skills', stability: 'session' }`，无安装目录槽；在 src/runtime 内检索 'installation directory' / 'install a skill' 零命中。扫描端仍活：skills/index.ts:221-223 `if (enabled.user) roots.push({ path: join(home, '.agents', 'skills'), scope: 'user', rootMarkdown: false })`。所以「告知」的一半没了、「扫描」的一半还在，这部分是静态事实；「模型会装到扫描不到的地方」是行为推断（静态推断，未做真实回合取证）。批次 A～C 未覆盖：T025 的孤儿清扫清单里没有这个文件，git log -- src/agent-host/userResourcePaths.ts 无近期改动。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md 第68行 GAP[P3-2/H20]（批评者缺口5）；docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；相关原文：「同目录的 stderrRedaction.ts、piWorkerErrors.ts、userResourcePaths.ts 也未读。…NEXT: 读这四个模块 | roadmap T029行：agent-host 未读的 8 个模块与 13 个测试…批评者缺口 1/2/3/4/5/8/19」

### [ah-lib-05] LOW contract-gap confirmed | 依赖边界 | src/runtime/__tests__/hostBoundary.test.ts:13 | 宿主边界守卫只扫 src/runtime，经 agent-host 模块可绕过；这条边本身无守卫无成文规则
DESC: D11 的硬约束是「runtime 内所有 fs 与子进程调用收敛到两个 service 出口」，守卫就是 hostBoundary.test.ts 的第一条用例。它的扫描根 sources(root) 写死 src/runtime（且跳过 host/smoke/spikes/__tests__），对 src/runtime 之外的文件一律不看。而 src/runtime 现在有四条指向 src/agent-host 的静态 import：plugins/session/store.ts:11-12（piSessionTimeline / piSessionTree）、plugins/permissions/index.ts:4 与 plugins/permissions/policy.ts:3（permissionPolicy.mjs）、worker/nativeWorkerRuntime.ts:3-4（piSessionPreflight / piSessionTimeline）。这四个模块当前都是纯的（逐个确认：piSessionTimeline 只 import shared 类型，piSessionTree 只 import shared 类型与 piWorkerErrors，piSessionPreflight 只 import node:path，permissionPolicy.mjs 无 import），所以今天没有违规；但守卫管不到它们，任何人给其中之一加一行 import fs，D11 守卫仍然全绿。更上一层的问题是这条边根本没有被表述过：ARD 5.1 只写「与现有 src/agent-host/ 共存」，没写依赖方向；nativeWorkerDependencyBoundary.test.ts 管的是反方向（worker 入口不许静态加载 pi 包），piCliIsBundledToolOnly.test.ts 管的是 pi 包，flags.test.ts 管的是一个退役环境变量。NativeWorkerRuntimeError（nativeWorkerRuntime.ts:71-80）逐字重写 PiWorkerSessionError（piWorkerErrors.ts:1-13，字段/签名/默认值全同，只差 name）就是这个真空的直接产物。
EVIDENCE: src/runtime/__tests__/hostBoundary.test.ts:11-27
const root = fileURLToPath(new URL('..', import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'host', 'smoke', 'spikes', '__tests__'].includes(entry.name)) return [];
...
    for (const path of sources(root)) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(
        /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?(?:fs(?:\/promises)?|child_process|node-pty)['"]/
      );

src/runtime/plugins/session/store.ts:11-12
import { projectPiSessionHistory } from '../../../agent-host/piSessionTimeline.ts';
import { buildPiSessionTreeSnapshot } from '../../../agent-host/piSessionTree.ts';
SCENARIO: 有人给会话树加「按标签过滤」，顺手在 piSessionTree.ts 里直接 readFileSync 一个配置文件——它就在 src/agent-host/ 下，那个目录里 worker.ts、piWorkerRpcServer.ts 都在自由用 fs，看起来完全正常。这个函数由 store.ts 在 worker 内调用，于是 runtime 在两个 IO 出口之外开了第三个口子：加密机上它不走 TSD 回落路径，Windows 上它不走统一的路径规范化。pnpm test 全绿，D11 守卫全绿，只有到现场才会炸。
FIX: 两步：(1) 把 hostBoundary.test.ts 的扫描集合从「src/runtime 的全部源码」改成「src/runtime 的全部源码 + runtime 静态 import 到的 src/agent-host 文件」——后者可直接复用 workerStripOnlyCompat.test.ts 已有的图遍历器，从 bootstrap.ts 与 worker/nativeWorkerRuntime.ts 两个根走一遍，过滤出落在 src/agent-host/ 的文件；(2) 加一条正向清单用例，把当前允许跨边的四个模块写成数组并断言 runtime 对 ../agent-host/ 的静态 import 集合恰好等于它，同时在 ARD 或 runtime README 写一句成文规则：runtime 只能从 agent-host 取纯函数与常量，不取任何带 IO 或进程状态的东西。
REFUTER(CONFIRMED,low): 守卫范围与跨边导入都对上了，只在计数上有小出入。src/runtime/__tests__/hostBoundary.test.ts:11 `const root = fileURLToPath(new URL('..', import.meta.url));`，:14 跳过 `['node_modules','host','smoke','spikes','__tests__']`，:21-25 只对 sources(root) 的文件断言不得 import fs / child_process / node-pty——扫描根就是 src/runtime，边界外文件一律不看。跨边静态 import 实际是 5 处而非审查员写的 4 处（漏了 src/runtime/worker/nativeImport.ts:35 `import { paginatePiSessionHistory } from '../../agent-host/piSessionTimeline.ts'`），涉及 4 个模块：piSessionTimeline.ts、piSessionTree.ts、piSessionPreflight.ts、permissionPolicy.mjs。纯度逐个复核：piSessionTimeline.ts 只 import shared/internalMessage、shared/sessionFileChange 与类型；piSessionTree.ts 只 import 类型与 ./piWorkerErrors.ts；piSessionPreflight.ts:27 `import path from 'node:path'`；permissionPolicy.mjs 无 import——今天确无违规，但守卫管不到它们，这一点成立。这个多出来的 import 点只让缺口更大，不影响结论。审查员对成文规则缺失的描述也核对过（反方向有 nativeWorkerDependencyBoundary.test.ts，这一方向无）。属守卫/契约缺口，无当前触发路径，取 low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md 第68行 GAP[P3-2/H20]（批评者缺口5）；docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；相关原文：「另外 runtime 子包反向依赖 src/agent-host 这件事本身也没有任何区域评估过。 | roadmap T029行：Main 侧宿主与渲染层：agent-host 未读的 8 个模块与 13 个测试…｜批评者缺口 1/2/3/4/5/8/19」

### [ah-lib-06] LOW test-gap confirmed | P3-2 | src/agent-host/__tests__/piSessionTimeline.test.ts:9 | 两个被 runtime 直接消费的模块缺关键用例：T005 的重开半边、以及 forkable 的正例
DESC: 两处缺口。其一，piSessionTimeline.ts:265 的 `if (isInternalMessage(message)) continue;` 是 T005（审计 high 级「子代理报告被当成用户消息」）的重开半边——直播时投影器挡住报告，重开会话时靠这一行挡住。piSessionTimeline.test.ts 的 8 条用例里没有任何一条涉及内部消息标记（在该文件内检索 internal 零命中）。这条分支一旦回归，症状就是 T005 修的那个形态：重开会话后对话顶部多出一条用户从没写过的消息，而且是最新的那一条。同一标记在 runtime 侧有用例（subagentSession.test.ts:147、instructionOnDemand.test.ts:247），但那是投影器一侧，不是会话文件重读一侧。其二，piSessionTree.test.ts 的两条断言里 forkable 全是 false（夹具的 message() 写死 role:'user'），forkable 的正例——assistant 消息自身可分叉、其后代继承可分叉——零断言，而它必须与 store.createFork 的 session_fork_unmaterialized 准入规则保持一致；两侧任一改动导致错位，症状是界面给出分叉入口但后端拒绝（或反之）。
EVIDENCE: src/agent-host/piSessionTimeline.ts:258-265
    if (message.role === 'user') {
      // A delegation report the runtime fed back to the model is stored as a
      // user message ... a reopened session has to agree, or the bubble the
      // user never wrote comes back on reload — as the newest thing they
      // appear to have asked for.
      if (isInternalMessage(message)) continue;

src/agent-host/__tests__/piSessionTree.test.ts:4-12（夹具只造 user 消息）
function message(id: string, parentId: string | null, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

同文件 :48 与 :50（两处断言都是 false）
      forkable: false,
    });
    expect(snapshot.nodes.find((node) => node.id === 'c')).toMatchObject({ forkable: false });
SCENARIO: 有人重构 projectPiSessionHistory 的 user 分支（比如把附件处理提前、或把三个 continue 合并），顺手挪掉了 isInternalMessage 那一行。全量测试仍然绿（该分支无用例），T005 的 high 级缺陷在「重开会话」这一半悄悄复活：用户重开会话，时间线顶部出现一条子代理报告正文，冒充成他自己最新发出的消息。
FIX: piSessionTimeline.test.ts 加两条：分别喂带 aiclientInternal:'subagent-report' 与 'project-instructions' 的 user 消息，各自断言不出现在投影里（两个 origin 分别断言——internalMessage.ts:36-43 的注释明确说「只比一个字面量」正是这条链的历史故障模式）。piSessionTree.test.ts 加一条：夹具支持 role，造 user → assistant → user 链，断言 assistant 自身与其后代 forkable:true、assistant 之前的节点 forkable:false，并在断言旁注明这条规则必须与 store.createFork 的准入条件一致。
REFUTER(CONFIRMED,low): 两处缺口都确认，审查员的用例条数略有出入（是 7 个 it( 而非 8，不影响结论）。其一：src/agent-host/piSessionTimeline.ts:258-265 确有 `if (isInternalMessage(message)) continue;` 并带注释 'a reopened session has to agree, or the bubble the user never wrote comes back on reload — as the newest thing they appear to have asked for'；src/agent-host/__tests__/piSessionTimeline.test.ts 检索 internal / aiclientInternal 零命中，7 条用例分别是 active branch 投影、compaction 通知、空 assistant leaf、分页、edit patch、通知翻译两条，都不涉及内部标记。全仓 isInternalMessage 的测试只在 src/runtime/__tests__/subagentSession.test.ts:147-148、instructionOnDemand.test.ts:247-248（投影器一侧）与 src/shared/__tests__/internalMessage.test.ts（纯函数一侧），会话文件重读这一侧确实无人钉。其二：src/agent-host/piSessionTree.ts:200 `const forkable = next.forkable || (entry.type === 'message' && message?.role === 'assistant');`，与 store.ts:469-474 的准入 `if (!branch.some((entry) => entry.type === 'message' && entry.message.role === 'assistant')) throw new RuntimeHostError('session_fork_unmaterialized', …)` 是一对；而 piSessionTree.test.ts:4-12 的夹具写死 `role: 'user'`，:48 与 :50 两处断言都是 `forkable: false`，正例零覆盖。属测试缺口，当前无用户可见故障，取 low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md 第68行 GAP[P3-2/H20]（批评者缺口5）；docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；相关原文：「GAP [P3-2 / H/20（会话树与互通）] .../src/agent-host/piSessionTree.ts 没被任何区域读过，但它被 .../src/runtime/plugins/session/store.ts:12 直接 import…P3-2 判 complete 的第一条理由就是「树/历史复用 piSessionTree」，这条现在没有代码证据。 | roadmap T029行：agent-host 未读的 8 个模块与 13 个测试」

### [chat-tool-03] LOW i18n confirmed | P4-5 / P5-2-6 | src/renderer/components/chat/toolCard.ts:1175 | T020 新写的四段 arg 文案是裸英文，中文界面出现半中半英的工具行（审查员原判 medium）（静态推断）
DESC: ToolRowView.arg 的契约是「离开模块时必须是成品文本」，ToolRows.tsx:138 只对 verb 调 t()，arg 是 {view.arg} 直出。formatToolArgDetail 里只有 inRepo() 用了 t；T020 为 new_context / TaskWait / TaskStop / TaskList 现写的四段文案全是字面量，既没过 t()，zhTranslations 里也没有词条（逐条 grep 确认）。守卫双双失效：toolVocabulary.test.ts 只扫动词表，i18nCoverage.test.ts 只扫字面量 t('…') 调用。同类的 'working directory'（pi ls，回放旧会话时可达）是同一处遗留。静态推断（依据是缺键时 t() 返回原文）。
EVIDENCE: // src/renderer/components/chat/toolCard.ts:1172-1192
    case RUNTIME_TOOL_NAMES.newContext:
      raw = 'a fresh window';
...
    case RUNTIME_TOOL_NAMES.taskWait:
    case RUNTIME_TOOL_NAMES.taskStop: {
      const ids = rec?.delegationIds;
      raw = Array.isArray(ids) && ids.length > 0 ? `${ids.length} delegation(s)` : 'all running';
    }
    case RUNTIME_TOOL_NAMES.taskList:
      raw = 'running subagents';
// src/shared/i18n.ts: 'a fresh window' / 'all running' / 'running subagents' / 'delegation(s)' 零命中；同段 2427-2447 行的动词词条齐全
SCENARIO: 中文界面下模型压缩上下文并等待两个子代理，时间线读作「已开新上下文 a fresh window」「已等待子 Agent 2 delegation(s)」「已列出子 Agent running subagents」——动词中文、宾语英文，且 (s) 这种单复数写法在中文里没有意义。这正是 2026-09-11 现场报告抓过的那一类。
FIX: 四处都走 t()，计数那条按仓库惯例拆单复数两个键（参照 deriveAggregateRow 的 '{{count}} file' / '{{count}} files'），并补 zhTranslations 词条；守卫侧把这些 arg 常量提成导出常量并纳入 toolVocabulary.test.ts 的断言。
REFUTER(CONFIRMED,low): 静态推断，成立。toolCard.ts:1172-1192 四段确为裸字面量：`raw = 'a fresh window'`（:1175）、`raw = Array.isArray(ids) && ids.length > 0 ? `${ids.length} delegation(s)` : 'all running'`（:1188）、`raw = 'running subagents'`（:1192）；函数尾 :1295-1297 `if (raw == null) return undefined; return { text: raw.replace(...), kind };` 不过 t()，同函数内只有 inRepo（:1117-1119）用了 t。渲染面 ToolRows.tsx:137 只对动词调 `{t(view.verb)}`，arg 在 :304/:315/:320 均为 `{view.arg}` 直出。词条确实缺：grep 'a fresh window' / 'all running' / 'running subagents' / 'delegation(s)' 在 src/shared/i18n.ts 零命中。工具名对得上真实注册：subagent/index.ts:81-83 `TaskWait/TaskList/TaskStop`、tools/new-context.ts:6 `new_context`。守卫失效也属实：runtimeToolVocabulary.test.ts:209 反而 `expect(view.arg).toBe('1 delegation(s)')`，把英文钉住了。同类遗留还有 :1198 的 'working directory' 与 :1263 的 'next moves'。定为 low（与审查员的 medium 不同）：纯展示形态问题，不改变任何行为或数据，中文界面下只是半中半英。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；raw/chat-tool-vocab.md [chat-tool-03]；相关原文：「chat 目录词汇表全量比对」

### [chat-tool-04] LOW i18n confirmed | P4-5 | src/runtime/plugins/skills/index.ts:401 | 技能审批卡的正文标签 Skill 没有中文词条（静态推断）
DESC: T023 定的规矩是 runtime 发英文键、渲染层查词典（questionCardModel.ts:776-780 明确把 contentLabel 定义为 catalog key）。skill 门发的 preview.label 是 'Skill'，卡里用 t(view.content.label) 渲染，但 zhTranslations 只有复数的 'Skills': '技能'，没有单数 'Skill'。i18nCoverage.test.ts 扫的是字面量 t('…')，这里是动态键扫不到；toolVocabulary.test.ts 的四组断言也没有 contentLabel 这一组。对照组 Content / Arguments / Command 都有词条。静态推断。
EVIDENCE: // 生产者 src/runtime/plugins/skills/index.ts:394-402
        tool: 'skill',
        ...
        preview: { label: 'Skill', text: skill.name },
// 消费者 src/renderer/components/chat/QuestionCard.tsx:669-671
        {view.content && (
            <p className="pb-1 text-meta text-muted-foreground">{t(view.content.label)}</p>
// grep -n "Skill" src/shared/i18n.ts  ->  574:  Skills: '技能',   （只有这一行）
SCENARIO: 中文界面下模型加载一个需要审批的技能，审批卡正文标签显示英文 Skill，下面是技能名，而同一张卡的标题、按钮、倒计时都是中文。
FIX: src/shared/i18n.ts 加 'Skill': '技能'；并把 contentLabel 的闭集合（Content / Command / Arguments / Skill）加进 toolVocabulary.test.ts 的断言，避免下一个带 preview 的工具重演。
REFUTER(CONFIRMED,low): 静态推断，成立但触发面窄。生产者 src/runtime/plugins/skills/index.ts:401 `preview: { label: 'Skill', text: skill.name }`；permissionPrompt.ts:170-172 把它转成 `contentLabel`；questionCardModel.ts:779 `return { label: readInputField(block.toolInput, 'contentLabel') ?? 'Content', text: content }`；QuestionCard.tsx:671 `{t(view.content.label)}`。词条确实缺：`grep -n "'Skill'|Skills:" src/shared/i18n.ts` 只有 574 行 `Skills: '技能'`，而对照组 i18n.ts:281 `Command: '命令'`、:1471 `Content: '内容'`、:1823 `Arguments: '参数'` 都在；i18n.ts:2772-2782 的 translate 缺键时原样返回 key，故中文界面显示英文 Skill。补充一条审查员没说的：skill 门很难弹出——authorizeSkill 传 `trustedPath: true`（skills/index.ts:399），permissions/index.ts 中 :317 与 :327 两个 ask 分支都被 `!request.trustedPath` 挡掉，:332 的放行名单不含 skill，末行 `return request.trustedPath ? 'allow' : 'ask'` 走 allow；只有 :304 `matches.some(scope => scope.action === 'ask')`（宿主配置了覆盖技能文件路径且 tools 含 'skill' 或 '*' 的 ask scope）才会真弹卡。故成立但可达性依赖配置，low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；raw/chat-tool-vocab.md [chat-tool-04]；相关原文：「chat 目录词汇表全量比对」

### [chat-tool-05] LOW contract-gap confirmed | P5-2-6 | src/renderer/components/chat/subagentActivityModel.ts:794 | 子代理面板表头与 Run 面板直接显示原始工具名（含 mcp__ 前缀）（静态推断）
DESC: 面板子行走 deriveToolRowView 所以词汇是对的，但表头的 arg 有两条分支直接用 wire 名：等待审批时用 lane.pendingPermission.toolName，运行中用 lane.progress.lastToolName（生产者 plugins/subagent/registry.ts:290 原样转发 event.toolName）。右侧 Run 面板是同一毛病：runPanelModel.ts:240 取 block.toolName，RunSurfaceView.tsx:235 原样打印。现有用例用的是 'Bash' / 'Read' 这类 Claude 期名字（subagentActivityModel.test.ts:176/416），看上去正常，掩盖了真实数据是 bash / mcp__github__create_issue。静态推断。
EVIDENCE: // src/renderer/components/chat/subagentActivityModel.ts:793-799
  if (lane.pendingPermission) {
    arg = t('Awaiting permission · {{tool}}', { tool: lane.pendingPermission.toolName });
  } else if (live) {
    arg = lane.progress?.description ?? lane.progress?.lastToolName ?? ...
// src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx:234-236
              <div className="truncate text-meta" title={view.tools.activeTool}>
                {view.tools.activeTool}
              </div>
SCENARIO: 一个子代理正在调用 MCP 工具时，面板表头写「子 Agent mcp__github__create_issue」，它展开后的子行同一时刻写「调用中 github · create_issue」，右侧 Run 面板的工具芯片也写 mcp__github__create_issue——同一个动作在一屏里有两种名字，其中一种是协议标识符。
FIX: 两处都经 mcpToolLabel(name) ?? name 取显示名，动词侧可复用 toolVerb(name,'running')；表头文案 'Awaiting permission · {{tool}}' 的插值同样走这条。用例：把 runtimeToolVocabulary.test.ts 的「同一个词到两个面」扩到表头与 Run 面板模型。
REFUTER(CONFIRMED,low): 静态推断，成立。subagentActivityModel.ts:792-800 确为 `arg = t('Awaiting permission · {{tool}}', { tool: lane.pendingPermission.toolName })` 与 `arg = lane.progress?.description ?? lane.progress?.lastToolName ?? lane.agentType ?? ...`，两处都是 wire 名，没有经 mcpToolLabel（piToolNames.ts:78-83）。生产者一侧 subagent/registry.ts:289 `if (event.toolName) record.lastToolName = event.toolName;` 原样转发。Run 面板同病：runPanelModel.ts:233-234 `activeTool = block.toolName ?? null`，RunSurfaceView.tsx:234-236 `<div className="truncate text-meta" title={view.tools.activeTool}>{view.tools.activeTool}</div>` 直出。现有用例确实只用 Claude 期大写名遮蔽了问题（subagentActivityModel.test.ts:176/180/416 用 'Bash' / 'Read'）。对照之下面板子行走 deriveToolRowView，其 default 分支 toolCard.ts:1285-1289 会用 mcpToolLabel，所以同屏两种叫法的场景成立。low：只是显示名不一致，不影响行为。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；raw/chat-tool-vocab.md [chat-tool-05]；相关原文：「chat 目录词汇表全量比对」

### [chat-tool-06] LOW correctness confirmed | P4-5 | src/runtime/plugins/permissions/activity.ts:50 | 权限活动行对 MCP / skill 把路径当成「被评估的值」，surface 也不是策略词汇（静态推断）
DESC: permissionActivityRow.ts:43-46 声明 surface 是 bash/read/mcp/skill/external_directory 这一类策略面名、value 是被评估的命令或路径。native 生产者两条都不按这个口径发：surface 用 request.tool（MCP 是 mcp__<server>__<tool> 这一长串 wire 名，策略面名 mcp 永不出现，external_directory 也从来不是 tool 因此永不出现）；value 用 command ?? path，而 MCP 调用的 path 是 this.cwd（mcp/index.ts:411），于是行里印的是工作区路径，真正被策略匹配的 github:create_issue 在 policyValue 里没人读。skill 同理：行里是技能文件绝对路径，策略作者写规则用的是技能名。静态推断。
EVIDENCE: // src/runtime/plugins/permissions/activity.ts:50,61
  const detail = request.command ?? request.path;
...
      surface: request.tool,
      ...(detail ? { value: detail } : {}),
// 真正的策略面与值：src/runtime/plugins/mcp/index.ts:414-417
            policySurface: 'mcp',
            policyValue: `${connection.server.name}:${tool.name}`,
SCENARIO: 用户展开一个回合的「审批详情」，MCP 那行读作「Allowed mcp__github__create_issue /home/ai/code/ai-client」——后半截是工作区路径，看起来像是批准了对这个目录的操作，而它只是 MCP 桥传给门的占位路径。被拒时这行会直接出现在时间线上（toolCard.ts:204 只静默 allow 行）。
FIX: value 改成 request.policyValue ?? request.command ?? request.path；surface 若要保留具体工具名，则把策略面另发一个字段供行尾注释使用，并同步更新 permissionActivityRow.ts:43-46 的注释使文档与生产者一致。
REFUTER(CONFIRMED,low): 静态推断，成立。src/runtime/plugins/permissions/activity.ts:50 `const detail = request.command ?? request.path;`，:61-62 `surface: request.tool, ...(detail ? { value: detail } : {})`——既不读 request.policySurface 也不读 request.policyValue（全文 grep 该文件无这两个字段）。而 MCP 桥明确另发了这两项：mcp/index.ts:405-417 `tool: name`（`mcp__<server>__<tool>`）、`path: this.cwd`、`policySurface: 'mcp'`、`policyValue: `${connection.server.name}:${tool.name}``，policy 匹配也确实用后者（permissions/index.ts:267-271 `policyAction(policy, request.policySurface ?? request.tool, [value], ...)`，value 取 `request.policyValue ?? request.path`）。skills/index.ts:396-401 同理：path 是技能文件绝对路径，policyValue 才是技能名。消费者 permissionActivityRow.ts:43-46 的注释写的是「e.g. bash, read, mcp, skill, external_directory」与「The command / path / tool name that was evaluated」，:152-157 直接 `label: t('Allowed {{surface}}', { surface })` + `detail: record.value`，于是 MCP 行读成「Allowed mcp__github__create_issue <cwd>」。可见性也对：toolCard.ts:203-204 `if (isQuietPermissionActivity(block.permissionActivity)) break;`，permissionActivityRow.ts:108-110 只静默 allow，deny 行会进时间线；事件确实会发（agent-loop/index.ts:332 emit permissionActivityEvent）。定为 low（与审查员一致）：审计行信息误导 + 注释与生产者口径不符，无功能或安全后果。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；raw/chat-tool-vocab.md [chat-tool-06]；相关原文：「chat 目录词汇表全量比对」

### [chat-tool-07] LOW dead-code confirmed | P4-5 | src/renderer/components/chat/turnTiming.ts:192 | 回合摘要三函数在生产里无消费者，注释却说它们仍在用；其中的编辑工具表还是只认大写名
DESC: deriveTurnStats / formatWorkedForRow / turnHasThinkingOnlyProcess 在 src/ 里的引用只剩注释和它们自己的测试（全仓 grep 确认）；回合头的统计行在 T12-b 随 meta 行退役，messageTimelineWiring.test.ts:484-491 明说「F1 的降级链与它的 compact deriveTurnStats 参数一起退役了」。但 MessageTimeline.tsx:118-121 的注释写的是这些函数「仍被 per-tool-row 与 subagent 面使用」——这句对 THOUGHT_VERB 成立，对另外三个不成立。副作用是 EDIT_TOOL_NAMES 至今只列大写 Claude 名，看起来像一处「native 的 edit/write 没被算进回合摘要」的漏补。
EVIDENCE: // src/renderer/components/chat/turnTiming.ts:192
const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// src/renderer/components/chat/MessageTimeline.tsx:118-121
// T12-b: `deriveTurnStats` / `formatWorkedForRow` / `THOUGHT_VERB` /
// `turnHasThinkingOnlyProcess` all fed the retired meta row's completed state.
// They stay exported from `turnTiming.ts` because the per-tool-row and subagent
// surfaces still use them; only this file stopped asking.
SCENARIO: 不影响用户。影响的是下一个做词汇补全的人：按「查表点全量比对」的做法会在 EDIT_TOOL_NAMES 里补上 edit/write，于是给一段没有消费者的代码写用例，并在落地记录里记一条并不存在的修复。
FIX: 删掉这三个函数与 turnTiming.test.ts:186-350 的相应测试块；或退一步只改 MessageTimeline.tsx:118-121 的注释，点名「仅 THOUGHT_VERB / formatThoughtRow 仍被 toolCard.ts 与 subagentActivityModel.ts 使用，其余三个已无消费者」。二选一，别两者都不做。
REFUTER(CONFIRMED,low): 复核成立。(1) 无生产消费者：全仓 grep（grep -rna，已带 -a 规避含 NUL 源文件被跳过的坑，排除 node_modules/.git）对 deriveTurnStats / formatWorkedForRow / turnHasThinkingOnlyProcess 只命中 6 个文件——定义处 src/renderer/components/chat/turnTiming.ts、注释 src/renderer/components/chat/chatTurn.ts:104、src/renderer/components/chat/turnStatus.ts:94、src/renderer/components/chat/MessageTimeline.tsx:119-120 与 :1235，以及两个测试 __tests__/turnTiming.test.ts、__tests__/messageTimelineWiring.test.ts，没有任何一处是调用。(2) 注释确实说反：MessageTimeline.tsx:118-121 原文 'T12-b: `deriveTurnStats` / `formatWorkedForRow` / `THOUGHT_VERB` / `turnHasThinkingOnlyProcess` all fed the retired meta row... They stay exported from `turnTiming.ts` because the per-tool-row and subagent surfaces still use them'，但真正还有活消费者的只有 THOUGHT_VERB（subagentActivityModel.ts:768 `children.push(proseRow(..., THOUGHT_VERB, row.text))`）和 formatThoughtRow（toolCard.ts:832 `const { verb, arg, argKind } = formatThoughtRow(...)`），另外三个一处调用都没有。(3) 退役佐证：messageTimelineWiring.test.ts:484-491 原文 'the chain, its compact `deriveTurnStats` argument and the `hasProcess` input went with it'。(4) 大写表属实：turnTiming.ts:192 `const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);`，仅在同文件 :219/:221 的 deriveTurnStats 内被用，因此这条『漏补 native edit/write』是纯陷阱、无用户可见后果。批次 A~C 未触及（HEAD ebc82f16 上代码与注释原样存在）。严重级维持 low：死代码 + 注释不符。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；raw/chat-tool-vocab.md [chat-tool-07]；相关原文：「chat 目录词汇表全量比对」

### [chat-tool-08] LOW test-gap confirmed | P4-5 | src/renderer/components/chat/__tests__/runtimeToolVocabulary.test.ts:55 | 没有一条测试拿 runtime 注册表去对账渲染层的查表点
DESC: 现有守卫是点名式的：列出八个工具名，断言它们有动词、有参数。它回答不了「注册表新增了一个工具，渲染层是不是漏了」，也不覆盖动词/参数以外的四个查表点（命中列表、文件链接、输出高度、审批卡）。chat-tool-01 能从 T-05 活到今天，正是因为没有这类穷尽性断言。RUNTIME_TOOL_NAMES 有 14 个键，用例点名 8 个 + task 一条，read/write/edit/bash/grep 靠与 PI_TOOL_NAMES 同名的巧合命中，没有任何断言说明这一点。
EVIDENCE: // src/renderer/components/chat/__tests__/runtimeToolVocabulary.test.ts:56-64
  it.each([
    [RUNTIME_TOOL_NAMES.glob, 'Searched files', 'Searching files'],
    [RUNTIME_TOOL_NAMES.browserPreview, 'Previewed', 'Previewing'],
    ...
  ])('%s reads as "%s"', (tool, done, running) => { ... })
SCENARIO: 下一个批次给 runtime 加一个工具（比如 web_fetch），注册表、提示词、权限策略都补了，渲染层三张表一个没补——测试全绿，用户看到「Ran https://…」。
FIX: 加一条穷尽用例：遍历 Object.values(RUNTIME_TOOL_NAMES)，断言 toolVerb(name,'done') !== UNKNOWN_TOOL_VERB.done、formatToolArg 对典型参数不落回 default: 的 run.toolName、zhTranslations 有三个动词的词条。注册表这一侧因为 src/runtime 是独立子包不能直接 import，可用 RUNTIME_TOOL_NAMES 当唯一事实来源，另在 runtime 侧加一条反向用例断言注册表名字集合等于该常量的取值集合。
REFUTER(CONFIRMED,low): 复核成立，且我另找的两条『可能已有守卫』都不成立。(1) 现有守卫确为点名式：src/renderer/components/chat/__tests__/runtimeToolVocabulary.test.ts:56-64 是 `it.each([[RUNTIME_TOOL_NAMES.glob, ...], [RUNTIME_TOOL_NAMES.browserPreview, ...], [ask], [skill], [newContext], [taskWait], [taskList], [taskStop]])`，加 :72 的 task 单条，共 9 个名字；RUNTIME_TOOL_NAMES 在 piToolNames.ts:51-66 有 14 个键（read/write/edit/bash/glob/grep/browserPreview/ask/skill/newContext/task/taskWait/taskList/taskStop），read/write/edit/bash/grep 确实只是与 PI_TOOL_NAMES 字面同名而被 toolCard.ts:906-911 的 `[PI_TOOL_NAMES.read]` 等条目顺带命中，全文件没有任何断言说明这一点。(2) 我查了可能替代的守卫：__tests__/toolVocabulary.test.ts:43-50 是 `Object.values(TOOL_VERBS).flatMap(...)` 再查 zhTranslations——它从『渲染层表』一侧穷尽，能抓漏译，抓不到表里根本没有的新工具；runtime 侧 src/runtime/__tests__/promptSegments.test.ts:143 的 `const REGISTERED = ['read','write','edit','bash','glob','grep']` 同样是硬编码常量，不是枚举注册表。全仓 grep RUNTIME_TOOL_NAMES 在 src/runtime 下零命中，即不存在任何『注册表 ↔ 渲染层常量』的反向对账用例。(3) 触发路径真实：toolCard.ts 的 TOOL_VERBS(:906-955)、TOOL_ARG_FIELDS(:596-607)、formatToolArgDetail 的 switch(:1155-1191) 是三张独立的表，新增工具漏补任意一张都不会判红。严重级 low（测试缺口，本身不产生错误行为）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；raw/chat-tool-vocab.md 测试缺口第1条；相关原文：「chat 目录词汇表全量比对」

### [chat-tool-09] LOW correctness confirmed | P4-5 | src/renderer/components/chat/piToolNames.ts:82 | mcp__ 拆分在服务器名含 __ / 结尾为 _ 或全名被截断时给出错误标签
DESC: mcpToolName 先把非 [A-Za-z0-9_-] 替换成 _ 再拼 mcp__<server>__<tool> 并 slice(0, 64)；mcpToolLabel 反过来按第一个 __ 拆并把剩余段用 __ 重新拼回。两者在两种边界上对不齐：服务器名本身以 _ 结尾或含 __ 时分隔符变成三个及以上下划线，多出的下划线被算进工具名；全名超 64 字节时工具名被截断，标签显示半个名字。已用纯字符串运算复算确认（node -e 只做字符串变换，未加载任何模块）。只影响显示，调用本身用同一字符串，不会错调。
EVIDENCE: // src/renderer/components/chat/piToolNames.ts:80-85
export function mcpToolLabel(toolName: string): string | undefined {
  const [server, ...rest] = toolName.slice(MCP_TOOL_PREFIX.length).split('__');
  return rest.length > 0 ? `${server} · ${rest.join('__')}` : server;
}
// src/runtime/plugins/mcp/index.ts:147-150
  return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
// 复算：("a_","b") -> mcp__a___b -> "a · _b"；("atlassian-remote","getConfluencePageDescendantsWithBodyAndLabels") -> mcp__atlassian-remote__getConfluencePageDescendantsWithBodyAndLa -> "atlassian-remote · getConfluencePageDescendantsWithBodyAndLa"
SCENARIO: 用户在 MCP 配置里把服务器命名为 jira_（或任何以下划线结尾的名字），该服务器的每一行都读作「调用中 jira · _createIssue」；工具名很长的服务器（Atlassian / Notion 这类真实存在的长方法名）则显示为被截断的名字。
FIX: mcpToolLabel 只按第一个 __ 分割一次（split(/__(.+)/s) 或 indexOf），并对剩余段做一次 replace(/^_+/,'')；截断这一半更彻底的解法是 mcpToolName 超长时改用「服务器名 + 工具名哈希后缀」而不是裸截，代价是要同步 mcp 插件的注册去重逻辑，可留作记录。
REFUTER(CONFIRMED,low): 复核成立，字符串运算我按代码原文重算过。(1) 生成侧 src/runtime/plugins/mcp/index.ts:147-150 `const safe = (value) => value.replace(/[^A-Za-z0-9_-]/g, '_'); return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);`，且 :391 `const name = mcpToolName(connection.server.name, tool.name)` 就是注册给模型的工具名，渲染层 toolCard.ts:1289 `const mcp = mcpToolLabel(run.toolName)` 读的正是这同一个字符串。(2) 解析侧 piToolNames.ts:80-85 `const [server, ...rest] = toolName.slice(MCP_TOOL_PREFIX.length).split('__'); ... return rest.length > 0 ? `${server} · ${rest.join('__')}` : server;`——split('__') 是全局切分而非只切第一处。复算：server='jira_' → 'mcp__jira___createIssue' → slice 后 'jira___createIssue' → split 得 ['jira','_createIssue'] → 标签 'jira · _createIssue'；server='my__srv' → 'my__srv__x' → ['my','srv','x'] → 'my · srv__x'（服务器名被腰斩、工具名被接上别人的段）。(3) 触发条件确实开放：src/runtime/plugins/mcp/config.ts:106 `return /^[\w.-]{1,48}$/.test(name);`，\w 含下划线，因此以 _ 结尾或含 __ 的服务器名是合法配置，不会被拒。(4) 截断一半属实（'mcp__' + 'atlassian-remote' + '__' = 23 字符，留给工具名 41 字符），但需说明：此处标签显示的就是实际注册名，根因在 mcpToolName 的裸截而非 mcpToolLabel，修法与前一半不同。(5) 现有用例只钉了顺路情形：runtimeToolVocabulary.test.ts:131 `expect(mcpToolLabel('mcp__github__create_issue')).toBe('github · create_issue')`，无任何边界用例；src/runtime/__tests__/mcp.test.ts:135-147 只断言生成侧字符集与长度，不做往返一致性。严重级维持 low：只影响行标签文案，调用与权限匹配都走原字符串，不会错调，且需要不常见的服务器命名才触发。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第99行 T029；raw/chat-tool-vocab.md [chat-tool-09]；相关原文：「chat 目录词汇表全量比对」

### [chat-event-04] LOW dead-code confirmed | P4-5 | src/runtime/plugins/tools/index.ts:139 | tool.updated 在 native 下没有任何生产者，T017 补的 input 与三个渲染消费者一起失效
DESC: pi 的 AgentTool.execute 第四个参数 update 是工具汇报中间进度的唯一入口，pi-agent-core/dist/agent-loop.js:455-463 只在这个回调里发 tool_execution_update。本仓 runtime 的工具包装层把 update 原样透传，但全部具体工具的 execute 都只声明三个参数、从不调用它（read/write/edit/bash/glob/grep、ask、browser_preview、skill、new_context、MCP 桥、四个 Task*；subagent/index.ts:1135 的权限作用域包装也只是再透传一层）。因此 tool_execution_update 永不触发，projector 的 case 'tool_execution_update'（:343-367）永不执行，tool.updated 在 native 后端根本不存在。渲染层三处消费全死：chatSessions 按 input 改写工具行参数（:989-1005）、contextSurfaceModel.foldActiveToolStatus（:456）及其喂的 Run 面板工具进度行（runPanelModel.ts:247-250，activeToolStatus 恒为 null）、TURN_LIVENESS_EVENT_TYPES 里的这一项。
EVIDENCE: src/runtime/plugins/tools/index.ts:125-139  execute: async (id, params, signal, update) => { ... return tool.execute(id, params as Static<T>, signal, update); }  ——这是全仓唯一持有 update 的地方，只透传  ||  grep -rn "execute: async (\|execute: (" src/runtime/plugins src/runtime/worker --include=*.ts | grep -v __tests__ 共 17 处，除 tools/index.ts:125 与 subagent/index.ts:1135 两个透传包装外全部只声明 (id, args, signal) 或更少  ||  五份 golden 录制里 tool.updated 出现 0 次
SCENARIO: 用户让模型跑一条耗时几分钟的 bash（构建、全量测试）。Run 面板的工具行只显示工具名，永远不会出现那条被注释描述为「工具自己报的最新一行」的进度文本；时间线上的参数也不会中途修正。界面不报错，只是这条被文档描述过的能力从来不出现。
FIX: 先决定要不要这条能力。要的话最小落点是 bash：runtimeExec.run 已在收流，按行节流调用 update({content:[{type:'text',text:lastLine}]}) 即可，projector 那半边是现成的。不要的话把 ToolUpdatedEvent 连同三处消费者一并退役（与 T036 退 extensionUi 同一口径），并把 RunToolFacts.activeToolStatus 的注释改成实况。无论选哪条都应在 golden 录制里留一份阳性或阴性对照。
REFUTER(CONFIRMED,low): 推翻失败：native 下确无生产者。update 回调只在 src/runtime/plugins/tools/index.ts:125,139 `execute: async (id, params, signal, update) => { ... return tool.execute(id, params as Static<T>, signal, update); }` 与 src/runtime/plugins/subagent/index.ts:1135-1138 两个包装层被透传；我逐条核了其余 execute 声明——tools/index.ts:297/337/379/443/502/567、ask.ts:123、browserPreview.ts:89、new-context.ts:26、skills/index.ts:296、mcp/index.ts:402、subagent/index.ts:872/1248/1342/1374 全部只声明 (id, args, signal) 或更少，无人调用第四参。pi 侧 agent-loop.js:451-463 也确认 tool_execution_update 只由该回调产生。后端唯一性也核实：`tool.started` 在非测试代码里只有 src/runtime/events/projector.ts:332 一个生产者，说明已无第二后端能补发；tool.updated 同理只有 projector.ts:351 在 case 'tool_execution_update' 里发。渲染端三处消费（chatSessions.ts:989、contextSurfaceModel.ts:434、assistantProgress.ts:311/359）因此恒不触发，runPanelModel.ts:248-250 的 activeToolStatus 恒为 null。属死代码 / 能力缺口，无用户可见错误行为，low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第30、76行（T017 落地记录）；相关原文：「事件投影与 golden 录制...tool.updated 带 input」

### [chat-event-06] LOW dead-code confirmed | P3-4 渲染半边 | src/shared/types/runtimeEvents.ts:974 | permission.activity 有五个字段自旧引擎退役后再无生产者，渲染层为它们保留了三段分支
DESC: PermissionActivityEvent.payload 声明了 toolSurface、origin、matchedPattern、forwarded、requesterAgentName 五个可选字段，来源是 @gotgenes/pi-permission-system 的广播。P6-5 退役旧引擎、决策 012 退役 extensionUi 之后，唯一生产者 permissions/activity.ts 一个都不发。渲染层为其中四个保留了输出分支，toolSurface 连声明都没同步过去；i18n 的 'matched {{pattern}}' / 'from {{origin}}' / 'for a subagent' / 'for subagent {{name}}' 四个中文词条也随之成为死条目。两处模块注释（PermissionActivityRows.tsx:16-20 仍写 Extension UI modal、permissionActivityRow.ts:18-29 仍称这些值是第三方插件广播）在 T036 之后都不再成立。
EVIDENCE: src/shared/types/runtimeEvents.ts:970-978  /** Actual gate surface ... */ surface?: string; /** Prompt display/tool surface when it differs from the actual gate. */ toolSurface?: string;  ||  src/runtime/plugins/permissions/activity.ts:55-69 全仓唯一生产者只发 phase / requestId / surface / value / delegationId / agentName / result / resolution 八个键  ||  src/renderer/components/chat/PermissionActivityRows.tsx:16-20  'the plugin asks its question through the Extension UI modal'
SCENARIO: 不会咬人，是退役清扫的尾巴。代价在阅读：下一个人按注释以为这些字段还有来源，就会继续维护三段永不执行的分支与四个永不命中的词条；origin 尤其容易被误认为「规则来自哪个配置层」已经在画了——实际上自有权限内核知道 scope，只是没往事件上放。
FIX: 二选一并写进 decision。(a) 退役：删五个字段、三段分支与四个词条，同时把两处注释改成实况。(b) 接线：origin 与 matchedPattern 由自有权限内核补发（判定时确实知道命中的 scope 与规则），forwarded/requesterAgentName 与 chat-event-05 合并为一条「委派归属」路径，toolSurface 删除。选 (b) 可顺带解掉 chat-event-05。
REFUTER(CONFIRMED,low): 推翻失败。声明侧 src/shared/types/runtimeEvents.ts:970-1001 确有 surface / toolSurface / origin / matchedPattern / forwarded / requesterAgentName，其中注释 :973 「Prompt display/tool surface when it differs from the actual gate.」；全仓唯一 permission.activity 生产者是 src/runtime/plugins/permissions/activity.ts:56-68（grep 非测试代码只此一处），payload 键集为 phase / requestId / surface / value / delegationId / agentName / result / resolution，五个字段一个不发。渲染层仍保留 permissionActivityRow.ts:115-120 的 forwarded 分支与 :145-148 的 `if (record.matchedPattern) notes.push(t('matched {{pattern}}', ...)); if (record.origin) notes.push(t('from {{origin}}', ...));`，对应中文词条 src/shared/i18n.ts:2525-2526、2531-2532 四条随之永不命中；toolSurface 连 PermissionActivityRecord 里都没声明。注释失真也属实：PermissionActivityRows.tsx:15-17 仍写「the plugin asks its question through the Extension UI modal」，而 extensionUi 整链已在 T036（ce7f3b3a）删除；permissionActivityRow.ts:18-28 仍称这些值是第三方插件广播。不改变任何运行行为，属死字段 / 注释不符，low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/topics/p6-cutover.md；相关原文：「旧引擎退役（P6-5）同日执行，允许名单已清空：应用代码里一处都不再 import 它。」

### [chat-event-07] LOW i18n confirmed | F7a/F7c 代码侧 | src/renderer/components/chat/permissionActivityRow.ts:122 | 审批行的 resolution 与 autoReason 直出原始枚举，最常见的自动放行在中文界面显示为英文
DESC: 三处把机器枚举当文案用。(1) gate_error 分支提前返回、note 直接给 record.resolution 原文，绕过 humanizeResolution，界面上出现带下划线的 gate_error，而字典里专门配的 'gate error': '闸门出错' 因此永不命中。(2) 其余非用户决定的 resolution 走 humanizeResolution（下划线换空格后当词条键），但字典只配了 'policy allow' 与 'gate error'；自有闸门实际会产出的 session_grant、policy_deny、timed_out、cancelled 四种全无中文词条，中文界面直接显示 session grant / policy deny / timed out / cancelled，其中 session_grant 是「本会话内允许」的常规路径，频率很高。(3) 权限卡与工具行尾的 'auto: {{reason}}' 把 autoReason 原样插值，中文界面显示「自动：timed_out」「自动：session_closed」。
EVIDENCE: src/renderer/components/chat/permissionActivityRow.ts:122-129  if (record.resolution?.includes('error')) { return { ..., note: record.resolution }; }  ||  src/runtime/plugins/permissions/activity.ts:27-39 的 RESOLUTION 表实际会产出 policy_allow / session_grant / user_approved / policy_deny / user_denied / timed_out / cancelled / gate_error  ||  grep -n "'session grant'\|'policy deny'\|'timed out'\|'cancelled'" src/shared/i18n.ts 无输出；同文件 2534-2535 只有 'policy allow' 与 'gate error'
SCENARIO: 中文界面用户对某次 bash 选了「本会话内允许」。之后同一会话里每次 bash 都由 session-grant 自动放行，展开「Approval details」看到的是「已允许 bash · session grant」——半中半英。若闸门自身出错则看到「权限检查失败 —— bash · gate_error」。
FIX: 把四个缺失的键补进 zhTranslations（'session grant'、'policy deny'、'timed out'、'cancelled'），并让 gate_error 分支也走 humanizeResolution。autoReason 同理：给四个值（unsupported/session_closed/aborted/timed_out）配一张小映射表再进 t()，与 T023 为权限卡建立的「runtime 发 id、渲染层查词典」先例一致。
REFUTER(CONFIRMED,low): 三处全部复现，且 T023（a28b3f93，只改了权限卡的 PermissionRequestAction 标识链）没碰 resolution 词汇。(1) src/renderer/components/chat/permissionActivityRow.ts:122-129 `if (record.resolution?.includes('error')) { return { ..., note: record.resolution } }` —— 早于 humanizeResolution（:94-96 `t(resolution.replace(/_/g, ' '))`）返回，note 是带下划线的原文；而 src/shared/i18n.ts:2535 `'gate error': '闸门出错'` 只有经 humanize 才可能命中，因此是死词条。(2) src/runtime/plugins/permissions/activity.ts:27-39 的 RESOLUTION 表确实产出 policy_allow / session_grant / user_approved / policy_deny / user_denied / timed_out / cancelled / gate_error；grep src/shared/i18n.ts 只有 2534 'policy allow' 与 2535 'gate error'，'session grant' / 'policy deny' / 'timed out' / 'cancelled' 四键均无，src/shared/i18n.ts:2765-2769 `getTranslation` 未命中即 `?? key` 原样返回，中文界面直出英文。session_grant 可达性已核：src/runtime/plugins/permissions/index.ts:415 `if (action === 'allow') return this.grants.has(grantKey(request)) ? 'session-grant' : 'policy';`，即用户选过「本会话内允许」后的常规路径。t 确实被传入（PermissionActivityRows.tsx:68 `.map((record) => derivePermissionActivityRow(record, t))`），不是未接线路径。(3) src/renderer/components/chat/questionCardModel.ts:463 `t('auto: {{reason}}', { reason: block.permissionAutoReason })`，i18n.ts:2516 模板为 '自动：{{reason}}'，插值来自 src/shared/types/runtimeEvents.ts:380 `PermissionAutoReason = 'unsupported' | 'session_closed' | 'aborted' | 'timed_out'`，无映射表，中文下必出「自动：timed_out」。属纯文案缺口，无功能影响，维持 low。
WAIVER(none): 无 — 全库检索（roadmap.md / decisions/*.md / topics/*.md）

### [chat-event-08] LOW dead-code confirmed | P4-5 | src/renderer/components/chat/hostStatus.ts:140 | host.ready / host.error 全仓零生产者，诊断横幅的 error / starting 两臂与 Node 24 指引不可达（静态推断）
DESC: RuntimeEventType 的头两个成员 host.ready / host.error 在 src/ 下没有任何 dispatch 点（chat.ts:204 与 sendDispatchError.ts:4-8 已为 host.error 记过一笔，host.ready 没人记）。HostStatus.state 的注释说 starting 与 error 只会来自 Runtime Event——既然事件没有生产者，这两个状态就只能来自 primeHostStatus 透传的 Main 快照，而 WorkerManager 的状态机只产出 stopped / ready / degraded。于是 describeHostStatus 的 'error' 与 'starting' 两臂、isNode24ResolutionFailure、横幅上 Retry 按钮的 error 形态全部不可达；useHostStatus.ts:64-65 注释里的「a recovered Host reappears via host.ready」也已不成立。
EVIDENCE: src/main/services/agent-host/WorkerManager.ts:2765-2775  private updateManagerState(): void { ... this.state = 'degraded' / 'ready' }  且 getStatus()（:455-475）与 ensureReady()（:452-454）都不会产出 'error' 或 'starting'  ||  src/renderer/components/chat/hostStatus.ts:92-102  case 'error': return { tone: 'error', title: status.lastFatalError ?? 'Pi session service failed', ... }  ||  grep -rn "'host.ready'" src --include=*.ts --include=*.tsx | grep -v __tests__ 只命中 runtimeEvents.ts:16、:70 与 hostStatus.ts:140（两处声明一处消费者，零生产者）
SCENARIO: Node 24 解析失败时 ensureHost() 的 invoke 直接 reject，useHostStatus 的 .catch(() => undefined) 吞掉它，状态停在 'unknown'，横幅的 default 分支返回 null——用户看不到那句写好的「设置 AICLIENT_NODE24_PATH」指引，只会在发送时吃一个原始错误。注：Main 侧是否另有出口不在本区域范围，未核。
FIX: 判断产品上还要不要一条全局宿主横幅。要的话让 Main 在 ensureHost 失败与 worker 池整体不可用时发 host.error{fatal:true}（或让 getStatus 能返回 error），横幅与 Node 24 指引立刻恢复可达；不要的话把 host.ready/host.error 两个类型与 hostStatus 的两个 case、isNode24ResolutionFailure 一并退役并修正 useHostStatus 的注释。无论哪条，Node 24 失败的用户可见出口都需单独确认。
REFUTER(CONFIRMED,low): 静态推断，但链条完整且比审查员说的更绝对。零生产者已核：grep 'host.ready|host.error' 全 src 只有 src/shared/types/runtimeEvents.ts:16/17/70/109（类型声明）、src/renderer/components/chat/hostStatus.ts:140/174（消费）、若干注释与两个测试，Main 侧无任何 emit；src/main/ipc/chat.ts:204 注释本身写着 'Nothing in Main emits a `host.error` runtime event either'。Main 快照能给的状态只有三种：src/main/services/agent-host/WorkerManager.ts:98 `export type WorkerManagerState = 'stopped' | 'ready' | 'degraded'`，:2766-2775 updateManagerState 只写 degraded / ready，:456-475 getStatus 原样回传。因此 hostStatus.ts:92-102 的 case 'error'、:110-116 的 case 'starting'、:263-268 `isNode24ResolutionFailure`（首行 `if (status.state !== 'error') return false`）三处不可达。审查员的 scenario 有一处读偏需更正：src/main/ipc/chat.ts:233-236 的 ensureHost 现在只是 `await workerManager.ensureReady(); return workerManager.getStatus();`，不做 Node 解析、根本不会 reject，所以 useHostStatus.ts:56 的 `.catch(() => undefined)` 吞的不是 Node24 失败——Node 24 解析失败发生在 NodeRuntimeResolver.ts:123 的 worker 拉起路径。这反而使结论更强：state 永不为 error，Node24 指引在横幅这一路 100% 不可达。仅死代码 + 注释不符（useHostStatus.ts:64-65 'a recovered Host reappears via host.ready' 已不成立），维持 low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/evidence/chinese-ui-residue/hardcoded-chinese.md 第26行；相关原文：「Host 状态条 | hostStatus.ts + HostStatusBanner.tsx | 出错 / 已停止 / 正在启动 与两条 Retry 指引」

### [chat-event-09] LOW dead-code confirmed | P4-5 | src/shared/types/runtimeEvents.ts:154 | session.status.liveness rider 没有生产者，只剩 composer 诊断里的一段格式化分支
DESC: SessionLivenessNote（F2 看门狗的「我看过了，回合还活着」）在 src/ 下没有任何构造点，全仓只有类型声明、SessionStatusEvent.payload.liveness 的字段声明，以及 ChatComposer.tsx:208 在 rawEvents=[...] 诊断串里读它。它属于随 Claude CLI 后端一起退役的那一层；自有 agent-loop 的存活判断走的是渲染层 classifyTurnLiveness + 静默预算。类型上那段很长的 GUARD 注释现在指向一个不存在的生产者。
EVIDENCE: grep -rn "liveness" src/runtime src/main --include=*.ts | grep -v __tests__ | grep -v node_modules 唯一命中是 WorkerManager.ts:2071 的一句注释  ||  src/renderer/components/chat/ChatComposer.tsx:208,216-221  const liveness = payload?.liveness; ... const livenessSuffix = liveness ? `,${liveness.source ?? '?'}-${liveness.degraded ? 'degraded' : (liveness.reason ?? '?')}` : '';
SCENARIO: 没有运行期后果，诊断串里永远不会出现 ,ttft-degraded 这类后缀。代价是读代码的人会以为宿主侧存在一个看门狗在汇报「回合还活着」，从而在排查「回合卡住」时去找一个不存在的信号源。
FIX: 与 chat-event-06 同批处理：删 SessionLivenessNote、payload.liveness 与 composer 的格式化分支；将来自有 agent-loop 若要加看门狗，再按同一形状（session.status 的可选 rider）重建。
REFUTER(CONFIRMED,low): 复现。src/shared/types/runtimeEvents.ts:154-163 定义 `SessionLivenessNote`，:207 `liveness?: SessionLivenessNote` 挂在 SessionStatusEvent.payload。全仓 grep liveness 后，src/runtime 与 src/main 下无任何构造点——src/main/services/agent-host/WorkerManager.ts:2071 唯一命中是一句注释，src/runtime/events/projector.ts 只有 retry(:427-431) 与 recovery(:448-454) 两个 rider 发射器，没有 liveness()。唯一读取方是 src/renderer/components/chat/ChatComposer.tsx:208 `const liveness = payload?.liveness;` 与 :217-220 `const livenessSuffix = liveness ? \`,${liveness.source ?? '?'}-${liveness.degraded ? 'degraded' : (liveness.reason ?? '?')}\` : '';`，恒为空串。渲染层自有的存活判断走 assistantProgress.ts:388 `TURN_LIVENESS_EVENT_TYPES.has(event.type)`，与这个 rider 无关，佐证它是 Claude CLI 后端遗物。补一条退役时要注意的事实：src/shared/types/__tests__/agentWireStatic.test.ts:923 `expect(optionalKeys?.sort()).toEqual(['disconnectReason', 'liveness', 'recovery', 'retry'])` 会钉住这个字段，删字段必须同改该断言。纯死代码 + 注释误导读者，low。
WAIVER(none): 无 — 全库检索（roadmap.md / decisions/*.md / topics/*.md / ARD）

### [chat-event-10] LOW dead-code confirmed | P4-5 | src/renderer/components/chat/subagentActivityModel.ts:369 | subagent.activity 的 kind:'progress' 没有生产者，lane 的 progress 槽永远为空
DESC: SubagentActivityPayload 的八个 kind 里，native 侧只产出 started / text / thinking / tool.started / tool.completed / status / report / capped，唯独 progress（旧引擎 task_progress 心跳）没有任何生产者。渲染层为它保留了完整分支：SubagentLane.progress 字段、SubagentProgress 接口、reducer 的 case 'progress'，以及面板里据此显示的「最近在做什么 / 上一个工具」。
EVIDENCE: grep -n "kind: '" src/runtime/plugins/subagent/records.ts src/runtime/plugins/subagent/index.ts | grep -v __tests__  →  records.ts:439 'thinking' / 448 'text' / 460 'tool.started' / 471 'tool.completed' / 495 'status' / 506 'report'；index.ts:575 'capped' / 1021,1035 'started'（无 'progress'）  ||  src/renderer/components/chat/subagentActivityModel.ts:369-378  case 'progress': { const progress: SubagentProgress = { description: asString(payload.description), lastToolName: asString(payload.lastToolName) }; return withLane(state, { ...lane, progress, usage: mergeUsage(...) }); }
SCENARIO: 一个长时间运行的子代理，面板上只会看到它的工具行逐条出现，不会有「正在做什么」的一句话概述。没有错误显示，只是这一栏恒空。
FIX: 要么由 SubagentRun 每 N 次工具调用或每隔一段时间发一条 progress（它手上有 description 与最后一个工具名），要么把 kind、字段与分支一并退役。倾向前者：子代理面板本来就是为了回答「它在干什么」，而现在只有工具流水。
REFUTER(CONFIRMED,low): 复现。生产侧穷举：grep "kind: '" src/runtime/plugins/subagent/{records,index}.ts（排除测试）得 records.ts:439 'thinking'、:448 'text'、:460 'tool.started'、:471 'tool.completed'、:495 'status'、:506 'report'，index.ts:575 'capped'、:1021/:1035 'started'（另有 :529/:709 'message'、:65/:1159 'settled' 属内部 SubagentRecord，不是 activity payload），无 'progress'。且 subagent.activity 事件只有一个出口：src/runtime/plugins/subagent/index.ts:570 与 :582 `events.emit({ type: 'subagent.activity', sessionId, payload })`，src/agent-host 下无第二个生产者（codexItemMapper.ts:142 明确写 codex 侧不产）。消费侧分支仍在：src/renderer/components/chat/subagentActivityModel.ts:369-378 `case 'progress': { const progress: SubagentProgress = { description: asString(payload.description), lastToolName: asString(payload.lastToolName) }; ... }`，且 src/shared/types/runtimeEvents.ts:906 注释仍称其为 '`task_progress` heartbeat'（旧引擎词汇）。该分支有单测覆盖（__tests__/subagentActivityModel.test.ts:172/176/416/421/460），所以是「测试绿但生产恒不触发」的死槽位。无错误显示，只是面板一栏恒空，low。
WAIVER(none): 无 — 全库检索（topics/p5-2-subagent-*.md / roadmap.md / decisions/005*.md）

### [chat-event-11] LOW contract-gap confirmed | P4-5 | src/shared/types/runtimeEvents.ts:61 | seq 没有任何消费者，且它在 Main 丢弃事件之后才编号，事件丢失在协议上不可检测
DESC: RuntimeEventBase.seq 的注释是「Host 进程内的单调序号（用于乱序处理）」，但渲染层对它零引用，所有顺序保证实际来自 IPC 单通道有序 + initRuntime 队列按到达顺序整批折叠。更要紧的是编号时点：WorkerManager.handleWorkerEvent 在槽位尚未 ready、代次不匹配或 sessionId 不符时直接 return，而 seq 是在这道过滤之后的 dispatch 里才 ++this.eventSequence 戳上去的——被丢掉的事件根本没拿到过号，渲染层收到的 seq 永远连续，丢失不可能被发现。projector 的 recovery() 注释正是为这条丢弃路径改成按 run 重发的。
EVIDENCE: src/main/services/agent-host/WorkerManager.ts:2428-2433  if (!this.isAuthoritative(...)) return; if (entry.state !== 'ready' || message.type !== 'runtime.event') return;  ||  同文件 :2777-2784  private dispatch(event: RuntimeEventDraft): void { const stamped = { ...event, seq: ++this.eventSequence, timestamp: this.now() } as RuntimeEvent;  ||  src/runtime/events/projector.ts:443-447  'A worker emits during bootstrap while Main still has the session in `creating`, and `handleWorkerEvent` drops everything that arrives before the slot is `ready` — so an open-time event would be correct and invisible.'
SCENARIO: worker 在 bootstrap 期发出的任何事件（T034 的会话文件修复提示是已知一例）被静默丢弃，渲染层既收不到事件也看不出少了东西——seq 依旧从 1 连号。将来任何一条「开会话时就该说的话」都会重复踩这个坑，而且照样静默。
FIX: 最小改动是把注释改成实况（seq = Main 的派发序号，不能用于检测丢失），并在 handleWorkerEvent 的每个 return 分支加一条带原因的 debug 日志，让丢弃至少在日志里可见。若确实需要「丢失可检测」，就要在 worker 侧编号、Main 侧透传，并让渲染层在跳号时记一笔——这是更大的改动，需要决策。
REFUTER(CONFIRMED,low): 两半都复现。(a) 零消费者：src/shared/types/runtimeEvents.ts:59-60 `/** Monotonic sequence within the Host process (for out-of-order handling). */ seq: number;`，但 grep '\.seq\b' 排除测试后，src/renderer 下没有任何读取（命中的 store.ts / codec.ts / context/index.ts 里的 seq 是会话文件行号与 checkpoint 序号，与事件无关）；渲染层唯一写 seq 的地方是 src/renderer/lib/mockRuntime.ts:13-16 的假事件构造。(b) 编号在丢弃之后：src/main/services/agent-host/WorkerManager.ts:2428-2433 `if (!this.isAuthoritative(entry, message.generation) || entry.slot !== slot) return; if (entry.state !== 'ready' || message.type !== 'runtime.event') return; ... if (event.sessionId && event.sessionId !== entry.logicalSessionId) return;`，三条 return 全在 :2463 `this.dispatch({ ...event, sessionId: ... })` 之前，而 :2777-2784 `private dispatch(event) { const stamped = { ...event, seq: ++this.eventSequence, timestamp: this.now() } ... }` 用展开后覆盖的方式重新戳号——被丢的事件从未取号，下游 seq 永远连续。丢弃真实存在且有先例记载：src/runtime/events/projector.ts:443-447 的 recovery 注释原文 'A worker emits during bootstrap while Main still has the session in `creating`, and `handleWorkerEvent` drops everything that arrives before the slot is `ready` — so an open-time event would be correct and invisible.'，正是为绕开这条丢弃路径才改成按 run 重发。属注释与实况不符 + 无日志的静默丢弃，当前无已知用户可见后果，low。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第57行（T003）；相关原文：「H/20 交叉写入：解码端不把 CLI 行计入 seq 空间或对陈旧 seq 按位置容忍」

### [smoke-01] LOW test-gap confirmed | P0-6 | docs/plantree/plans/runtime-evolution/evidence/p0/offline-smoke-trace.jsonl:1 | P0-6 存档冒烟证据落后 HEAD 227~228 个提交，横跨一次引擎整体退役（静态推断）
DESC: offline-smoke-trace.jsonl 与 live-smoke.md 采集于 2026-09-08（提交 3ce9702e/8a71c843），trace 里 version_stamp.backend 记的是 "legacy"；现在 flags.ts:43 已把 backend 硬编码为字面量 'native'，config_version 也已从冻结的 runtime_p3_complete_v1 解冻到 runtime_p6_hardening_v1（bootstrap.ts:132，T028）。存档证据描述的运行时形态已不存在，且 P6 退役旧引擎、T028 解冻基线两次大改之后从未重跑存档。另外该 jsonl 是 TracePlugin 写出的原始 runs.jsonl（字段核对 trace.ts:125-135 吻合），不含 AssertionReport 的 outcomes/passed 字段——此前审计声称「6 项离线断言的记录可查」在这份文件里实际查不到任何断言名或通过状态，是静态推断，未经复核确认为真。
EVIDENCE: offline-smoke-trace.jsonl: version_stamp={"config_version":"runtime_p0_v1",...,"backend":"legacy"}；flags.ts:43 backend: 'native';
SCENARIO: 有人把 P0-6「完成」当作现行结论做后续验收决策，但唯一存档证据描述的是已不存在的 legacy 后端；若当前代码在 P6/T028 之后的某处破坏了 offline lane，现有证据（比这些改动更早）无法发现。
FIX: 在开发机重跑 node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline（无需凭据/模型），把新 runs.jsonl 与 --json 报告一并存档并标注提交号；同时明确标注现有记录只是历史存档、不代表现行代码状态。
REFUTER(CONFIRMED,low): 主体成立，但审查员的第三个子论点被推翻，且证据面比他说的宽。(1) 形态不符属实：docs/plantree/plans/runtime-evolution/evidence/p0/offline-smoke-trace.jsonl:1 的版本戳原文为 "version_stamp":{"config_version":"runtime_p0_v1",...,"backend":"legacy",...}；而 src/runtime/flags.ts:43 现在是接口字段 `backend: 'native';`，src/runtime/flags.ts:50-52 的 readRuntimeFlags 直接返回字面量 `backend: 'native'`；src/runtime/bootstrap.ts:132 是 `export const RUNTIME_CONFIG_VERSION = 'runtime_p6_hardening_v1';`（注释第 125-127 行自述 runtime_p3_complete_v1「Stayed frozen through P5-1..P5-5 and P6, which it should not have」，即 T028 解冻）。(2)「P6/T028 之后从未重跑存档」我尽力找了反例但没找到：全仓最晚的一份冒烟存档是 docs/plantree/plans/runtime-evolution/evidence/p3/completion/offline-smoke.txt（git log 显示唯一提交 78298463，2026-09-09），其 version_stamp 仍是 config_version: runtime_p3_complete_v1 / backend: legacy；evidence/p6/ 目录只有四张截图与 p6-native-default-report.json，grep smoke/冒烟/runOnce 零命中；批次 A/B/C 三份证据里唯一含 smoke 的一行是 batch-c-2026-09-15.md:98，讲的是改 approve fixture，不是重跑。(3) 但审查员说「6 项离线断言的记录在这份文件里查不到」只对那份 jsonl 成立，结论不能推广：p1/p0-smoke.txt、p2/offline-smoke.txt、p3/offline-smoke.txt、p3/completion/offline-smoke.txt 四份存档都是 evaluateCase 的输出，前三份是 `PASS must_succeed ... PASS max_latency_ms` 六行加 `RESULT pass`，第四份是完整 JSON 的 AssertionReport（case_id/passed/outcomes 带 name/expected/actual/tag）。所以上一轮审计「6 项离线断言的记录可查」这句话本身不假，只是指错了文件。(4) 无回归防线：全仓 grep evaluateCase/ExpectedAssertions/SmokeCase/AssertionReport 只命中 assertions.ts 自身与 runOnce.ts，没有任何 vitest/node --test 文件引用它们，offline lane 确实没被自动化钉住。静态推断：我未运行 runOnce（只读约束），但静态看 runOnce.ts:88-96 不传 tools，故不触发 bootstrap.ts:223 的「permissions.approve is required whenever tools are enabled」守卫，offline lane 大概率仍能跑——即存档过时属于证据卫生问题，不等于通道已坏。级别维持 low（证据与测试缺口，无用户可见错误行为）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第100行（批次D，T030）；相关原文：「T030 | 未认领节点：P4-6 现场口径、P2-5/P2-6 可比性、H/17、H/19、H/21、F1～F7 复核；P0-6 的 smoke/runOnce 与 assertions；D1 的 cordis spike」

### [spike-01] LOW docs confirmed | P0-2 / D1 | docs/plans/2026-09-08-runtime-evolution-ard.md:58 | D1 承诺的三项 Cordis 能力零落地且无任何落地注记
DESC: D1 把热插拔、Fork/Isolate 服务隔离、响应式属性、动态 scope 列为选型理由的具体承诺。全仓 grep 确认这四项里只有依赖注入/生命周期一项被使用，另外三项零命中；权限变更→工具注册表这个「响应式」例子的实际实现是拉模式（tools/index.ts:78/97 现读 mode）；当前锁定的 cordis@4.0.0-rc.9 甚至没有 accept/reactive 相关 API。decisions/ 与 open-questions.md 全目录检索无第二处提及，不是被显式接受的限制。
EVIDENCE: ARD:58-61 「热插拔在开发调试阶段有价值...；Fork/Isolate 上下文自动执行插件间 service 接口隔离纪律；响应式属性用于 worker 内插件间状态传播（如权限配置变更→工具注册表更新）；动态 scope 为后续场景...保留空间。」grep -rn "\.isolate(\|\.accept(\|reactive(" src/runtime --include="*.ts" 零命中；cordis/lib/index.js 全文 grep accept 零命中，package.json version 4.0.0-rc.9。
SCENARIO: 新插件作者读到 D1 决策文本，以为响应式属性/Fork-Isolate/热插拔已经过选型验证可以直接用，例如想用 ctx.isolate 隔离风险插件，或指望权限策略变化自动推送到工具注册表；结果全仓找不到先例，当前 cordis 版本连对应 API 都没有。下一轮审计只看「已修」标记会继续把这三项当成待兑现技术债而非需要先确认可行性的开放问题。
FIX: 在 decisions/ 下补一条决策，逐项裁决：inject/生命周期/dispose 保留；isolate 是否需要（可引用 contracts.ts:22-27 的 flat service name 取舍收口）；热插拔需要先给接入点或明确推迟；响应式属性记录清楚当前版本无对应 API，决定是等 cordis 稳定版还是从选型理由删除。
REFUTER(CONFIRMED,low): 事实全部复核成立，仅一处措辞需打折。(1) 承诺文本仍在：docs/plans/2026-09-08-runtime-evolution-ard.md:57-61「作为完整框架使用，不预先排除任何能力……热插拔在开发调试阶段有价值（改工具定义不用重启 app）；Fork/Isolate 上下文自动执行插件间 service 接口隔离纪律；响应式属性用于 worker 内插件间状态传播（如权限配置变更→工具注册表更新）」；git log 显示该文件最后一次改动是 fe246bd6（P6 批），批次 A～C 的 T001～T036 未触碰。(2) 代码零落地：grep '\.isolate(|\.accept(|reactive' src/runtime --include=*.ts 零命中；全仓生产路径只有 bootstrap.ts:239 一个 new Context()（另两处在 spikes/p0-cordis-semantics.ts:41 与 worker/nativeImport.ts:229 的独立图）；权限→工具确为拉模式，现读点在 plugins/tools/index.ts:109 `this.ctx.runtimePermissions.mode !== 'plan' || this.access.get(tool.name) !== 'write'` 与 :126/:128（审查员引的 :78/97 是 09-14 审计的旧行号，T012/T035 之后已漂移，事实不变）；无任何 cordis 热插拔接入点（src/runtime 内无 fiber.update / ctx.registry 使用，permissions/index.ts:367 的 notify 是插件自有方法）。(3) 文档零裁决：decisions/001~012、open-questions.md、roadmap.md、README.md 对 isolate/响应式/热插拔/Fork 全部零命中，全仓仅 ARD 这两行提及。(4) 未被前一轮吃掉：core-host-19 虽判 REFUTED，但 findings.json 的反驳正文自己写明「真正剩下的残渣只有两条且都很轻：ctx.isolate 与热插拔确实没用，且没有落地注记说明为何不用」，本条正是该残渣。打折处：「rc.9 甚至没有 accept/reactive 相关 API」过头——ctx.accept 确实零命中，但 node_modules/cordis/lib/index.js:1173 的 ReflectService.notify（按 `name in fiber.inject` 挑依赖方）与 :269-276/:1017-1026 的 internal/update + fiber.update→restart 就是 rc.9 的响应式等价物，准确说法是「无 v3 的 ctx.accept，等价物是服务重挂后重启依赖 fiber」。严重级维持 low（文档与实现不符，无运行期后果）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md:100（T030：未认领节点……D1 的 cordis spike）；raw/cordis-spike-d1.md 第五节 [spike-01]；相关原文：「T030 | 未认领节点：P4-6 现场口径、P2-5/P2-6 可比性、H/17、H/19、H/21、F1～F7 复核；P0-6 的 smoke/runOnce 与 assertions；D1 的 cordis spike」

### [spike-02] LOW test-gap confirmed | P0-2 | src/runtime/bootstrap.ts:519 | plugin_graph_incomplete 失败兜底路径没有任何测试覆盖
DESC: bootstrap.ts 末尾用 ctx.get(name)===undefined 的 filter 做必需服务缺失的最终兜底，其正确性直接依赖 spike Q1 钉住的语义（依赖不满足时 fiber 推迟而非同步抛错）。全仓 __tests__ 目录 grep plugin_graph_incomplete 零命中，此路径自 P0 建立以来从未被任何用例触发过。
EVIDENCE: bootstrap.ts:519-524 `const missing = required.filter((name) => ctx.get(name) === undefined); if (missing.length) throw new RuntimeConfigError('plugin_graph_incomplete', ...)`；grep -rn "plugin_graph_incomplete" src/runtime --include="*.ts" 只有定义处一处，无测试引用。
SCENARIO: cordis 目前锁定 4.0.0-rc.9（README 自称 API 尚不稳定）。若升级版本改变依赖缺失时的推迟/抛错语义，某个 ctx.plugin() 调用会在注册时直接抛出未分类异常，而不是走到 :519 给出清晰错误码和缺失服务名单；因无测试构造过该场景，只能在真实启动失败、翻源码排查后才会被发现，typecheck 和现有 vitest 套件跑绿不会拦下。
FIX: 在 bootstrap.test.ts 补一个用例：让某个必需插件注册失败或缺失（如给 ToolsPlugin 传会在构造期抛错的非法配置），断言最终抛出 code:'plugin_graph_incomplete' 且缺失服务名单正确。
REFUTER(CONFIRMED,low): 测试缺口属实且路径可达。(1) 兜底代码原文 src/runtime/bootstrap.ts:519-524：`const missing = required.filter((name) => ctx.get(name) === undefined); if (missing.length) throw new RuntimeConfigError('plugin_graph_incomplete', `missing services: ${missing.join(', ')}`)`。(2) 覆盖为零：全仓 grep 'plugin_graph_incomplete' 只命中 bootstrap.ts:523 与批次 D 的证据 md，__tests__ 下零引用；src/runtime/__tests__/bootstrap.test.ts 只有 9 条用例（:47 runtime_approval_missing、:76 P0 服务齐全、:93 engine 戳、:110/:121/:150 catalog、:183 dispose retract、:197 dispose 双失败、:240 trace 戳），无缺服务用例。(3) 不是死代码：cordis/lib/index.js:1003-1009 的 `async await(){ while(this.inertia) await this.inertia; if(this._error) throw this._error; return this; }` 表明 inject 未满足的 fiber 停在 PENDING、await 立即返回且不抛，服务因此不上 ctx，正好落到 :519 的 filter；src/runtime/contracts.ts:17-20 也把这套语义写成约定（「A plugin that injects one stays PENDING, which is the honest state」）。(4) 唯一验证过该语义的是一次性探针 src/runtime/spikes/p0-cordis-semantics.ts（文件头自述 throwaway、明确排除在类型检查门禁外，除 evidence/sources.json 的哈希外无人引用），不构成回归防护。(5) 未被批次 A～C 修：该缺口在 09-14 审计 area-assessments.md 的 TEST GAPS 已与 session_cwd_mismatch 并列点名，roadmap Done 段 T001～T036 无一条覆盖，批次 D（T029～T031）本身是只读。严重级 low（纯测试缺口，无当前错误行为）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md:100（T030：……D1 的 cordis spike）；raw/cordis-spike-d1.md 第五节 [spike-02]；相关原文：「T030 | 未认领节点：……D1 的 cordis spike」

### [baseline-01] LOW contract-gap confirmed-partial-waiver | P1-7 | .github/workflows/build.yml:3 | 测试执行只挂在 tag 推送/手动 dispatch 上，日常提交与 PR 完全不触发任何自动化测试（审查员原判 medium）
DESC: build.yml 的 on 块只有 push:tags:v* 与 workflow_dispatch，是仓库唯一跑 pnpm test/typecheck/lint/verify:packaged 的工作流；code-review.yml 与 claude.yml 都只是 LLM 阅读式审查，不执行测试命令；本地只有 pre-commit（仅 lint-staged 格式化），没有 pre-push 钩子。三者叠加导致日常提交/PR/合并 main 都不会自动跑测试，与 docs/agent-project-engineering.md 明文要求的 'before every merge' 主回归节奏直接冲突。
EVIDENCE: build.yml:3-7 `on: push: tags: ['v*'] / workflow_dispatch:`；.husky/pre-commit 全文件内容为 `pnpm exec lint-staged`；package.json:121-125 lint-staged 只跑 biome check；docs/agent-project-engineering.md:102-105 'Main regression: ... before every merge'。
SCENARIO: 开发者在非 main 分支提交一处让既有 vitest 用例变红的改动并直接 push；不会有任何 GitHub 状态检查失败，因为 build.yml 不会被触发，直到数周后有人推 v* 标签才第一次跑测试，此时坏改动可能已叠加数十个提交。
FIX: 给 build.yml 的 gate job（或拆出更轻量的新 job）补 pull_request 触发（至少覆盖 main 分支 PR），让 typecheck/lint/test/smoke 在合并前机械执行；若出于成本考虑暂不全量覆盖，至少在 P1-7 证据里把'仅 tag/手动两种触发方式'写成已知限制。
REFUTER(CONFIRMED-PARTIAL-WAIVER,low): 事实全部核对属实，推翻不掉。.github/workflows/build.yml:3-7 原文 `on:\n  push:\n    tags:\n      - 'v*'\n  workflow_dispatch:`，没有 pull_request / push-branch 触发；`grep -rn "pnpm test" .github/workflows/` 只命中 build.yml:93（Gate 5/7 — test），另两个工作流 code-review.yml:4 `pull_request_target` 与 claude.yml:3-10（issue_comment / pull_request_review 等）都只调 LLM 审读、不跑任何测试命令。本地钩子 .husky/ 下只有 pre-commit，全文件一行 `pnpm exec lint-staged`，package.json:121-125 的 lint-staged 只跑 `biome check --write --no-errors-on-unmatched`，没有 pre-push。docs/agent-project-engineering.md:104 原文 'Main regression: covers main functional paths, daily / before every merge'，确实对不上。`git log -- .github/workflows/build.yml` 最近一次是 76424efa，批次 A～C（T001～T036）没动过触发器，未被修掉。降级到 low 的理由：这属于门禁/测试缺口而非功能错误，且项目有成文的人工补偿纪律——docs/plantree/进度看板.md:62 记录批次收口跑全量 `pnpm test`（409 文件 / 6023 条）并做反向验证，是用户明确要求的做法（开发机 2 核 3.3GB，全量只在批次收口跑一次），所以「坏改动几周无人发现」的场景被大幅削弱；建议仍成立（补 PR 触发，或在 P1-7 证据里把『仅 tag/手动两种触发』写成已知限制）。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-evolution/README.md 第72行（P1-7 行）；原文：「P1-7 | 单测 | ✅ 历史实现门禁；不代表包后新改动测试已执行」

### [baseline-02] LOW test-gap confirmed | P2-5 | vitest.config.ts:13 | 支撑 D9 缓存命中率公式的单测被排除在 vitest / CI 之外（审查员原判 medium）
DESC: vitest.config.ts 的 test.include 只收 src/**/__tests__/**/*.test.ts 与 scripts/__tests__/**/*.test.mjs；scripts/runtime-baseline/metrics.test.mjs（5 条用例，覆盖 usage 统计/去重/缺失 usage/工具边界/edit 数组，用 node --test 写）物理上不在这两个 glob 内，pnpm test 与 CI 的 Gate 5/7 永远不会执行它，只作为手动'验证命令'活在文档里。
EVIDENCE: vitest.config.ts:13 `include: ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs']`；scripts/runtime-baseline/metrics.test.mjs 路径不匹配该 glob；build.yml 的 'Gate 5/7 — test' 步骤只有 `run: pnpm test`，无单独调用该文件的步骤。
SCENARIO: 有人改动 metrics.mjs 的 summarizeUsage/deriveCacheHitRate 逻辑引入回归，pnpm test 与 CI 全绿（该文件根本没跑），这个 bug 会一路带到下一次 P2-5/P2-6 真实网关采集，产出的命中率数字本身就是错的，且没有任何自动化信号提前拦住它。
FIX: 把 metrics.test.mjs 迁移为 vitest 语法并移入 scripts/__tests__/（或扩宽 include glob）；或在 build.yml gate job 里单独加一步 `node --test --test-concurrency=1 scripts/runtime-baseline/metrics.test.mjs`。需与 baseline-01 一并解决，否则加了也不会自动执行。
REFUTER(CONFIRMED,low): 路径不匹配是硬事实。vitest.config.ts:13 原文 `include: ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.mjs']`；被测文件在 scripts/runtime-baseline/metrics.test.mjs（不在 scripts/__tests__/ 下，ls scripts/__tests__/ 里是 agent-host-build-lib / runtime-baseline-archive 等 9 个文件，不含它），因此 `pnpm test`（package.json:35 `vitest run`）与 build.yml:93 的 Gate 5/7 都收不到它。该文件用 node:test 写（metrics.test.mjs:1-2 `import assert from 'node:assert/strict'; import { test } from 'node:test';`），全仓没有任何 npm script 或 CI 步骤调 `node --test` 跑它——`grep -rn "metrics.test"` 只命中三处文档：scripts/runtime-baseline/README.md:57、docs/plantree/plans/runtime-evolution/evidence/p2-0/validation.md:24、以及批次 C 的落地记录。`git log -- scripts/runtime-baseline/metrics.test.mjs` 只有 8a71c843 一次（P0 骨架），批次 A～C 未迁移。降级到 low：属于自动化缺口（rubric 的『测试缺口』档），且并非从未跑过——docs/plantree/plans/runtime-hardening/evidence/batch-c-2026-09-15.md:20 与 roadmap.md:41 都记录 T028 手工 `node --test` 跑了这 5 条并全绿，只是没进机械门禁。修复要与 baseline-01 一起做，否则加了步骤在日常提交上仍不执行。
WAIVER(none): 无 — 全文档检索无命中

### [field-01] LOW docs confirmed | P4-6 | docs/plantree/plans/runtime-evolution/README.md:136 | 看板把现场明确拒签的 R2/R3 写成载体对照结论，并据此宣告放行规则结案（静态推断）
DESC: P4-6 验收表「加密载体对照」一行写「test.12 R2/R3 都读到明文。用户 2026-09-10 确认 Node 与 Git 本身在企业白名单内，放行规则不再作为待查项」。字面上「读到明文」不假，但它来自的现场记录在同一段里三次否定了这个读数的证明力：目标文件的读取结果没有 TSD 容器头，分不清「本来就是明文文件」和「白名单进程透明解密」，现场明写「不签原定 R2/R3」。用户 2026-09-10 的确认覆盖的是「哪两个程序在白名单里」，不是「驱动按进程名、映像路径、签名还是父进程放行」——而后者才是 F3 三个修法选项（A 维持现状 / B 用随包 node 包一层 / C 走 Git Bash）之间唯一的判别器，docs/plans/2026-09-09-gui-defect-decisions.md 已写明「F3 不单独设探针：R2/R3 的结果一到，F3 与 D1 一起拍板」。看板这一行把一个仍然开着的判别器写成了已关闭事项。需加密 Windows 才能真正验证放行规则，故为静态推断。
EVIDENCE: README.md:136 `| 加密载体对照 | test.11 已有真实密文三读取者差分；test.12 R2/R3 都读到明文。用户 2026-09-10 确认 Node 与 Git 本身在企业白名单内，放行规则不再作为待查项 |`

Windows-P4-6-evidence/test12-reverify.md:786 `…作为预检保留，不签原定 R2/R3。`
Windows-P4-6-evidence/test12-reverify.md:806 `限制：目标当前读取结果无 TSD 头，不能区分明文文件与透明解密；R2/R3 不能据此拍板放行按路径/签名/父进程。R3 只改变文件名并保留目录，仍需真实加密容器才能作决策。`
Windows-P4-6-evidence/test12-reverify.md:808 `…D1/F3 仍待真实加密样本与有效无 Bash 探针。`
SCENARIO: 批次 E 是计划里明写的最后一次上机（「全部做完后再去现场实测一次，不再分轮上机」）。上机清单按 P4-6 表逐行排，读到第 136 行判定「加密载体对照」已完、放行规则不必再查，于是不会在受策略目录里准备一份已确认带 %TSD-Header-###% 容器头的样本去重跑 R2/R3。上机结束后 F3 的根因仍然未知，三个修法选项无法收敛，而 F3 的用户可见后果是加密机上 GUI 的 Git 面板分支/状态为空（git:branch:list 报 output was lost），这条缺陷因此被带过整个发布窗口。
FIX: 把第 136 行拆成三段：保留 test.11 的三读取者差分（那次有真实密文样本，结论成立）；把 test.12 的 R2/R3 降级为「预检，未签收」并引用 test12-reverify.md:806 的限制原文；把用户 2026-09-10 的确认限定为「Node 与 Git 在白名单内」，写明它不覆盖放行维度。同时在 T032 新增一行「R2/R3 用真实加密容器重跑」。
REFUTER(CONFIRMED,low): 逐字核对成立，推不翻。看板 docs/plantree/plans/runtime-evolution/README.md:136 原文：`| 加密载体对照 | test.11 已有真实密文三读取者差分；test.12 R2/R3 都读到明文。用户 2026-09-10 确认 Node 与 Git 本身在企业白名单内，放行规则不再作为待查项 |`。而同一趟现场的记录 Windows-P4-6-evidence/test12-reverify.md 三处否定它的证明力：`…作为预检保留，不签原定 R2/R3。`（约 786 行）、`限制：目标当前读取结果无 TSD 头，不能区分明文文件与透明解密；R2/R3 不能据此拍板放行按路径/签名/父进程。R3 只改变文件名并保留目录，仍需真实加密容器才能作决策。`（806 行附近）、`D1/F3 仍待真实加密样本与有效无 Bash 探针。`（808 行附近）。判别器确实还开着：docs/plans/2026-09-09-bash-carrier-decision.md:69/71 的结论映射把「按进程名 / 按路径 / 按签名 / 受父进程影响」分别映射到修法 B 可行与否，而 docs/plans/2026-09-09-gui-defect-decisions.md:43 明写 `因此 F3 不单独设探针：R2/R3 的结果一到，F3 与 D1 一起拍板。`。批次 A～C 未动这一行：git log -S'放行规则不再作为待查项' 只返回引入它的 ff08f264，T027（1b7c55fd）改的是 evidence/p4-6/README.md 的后端开关那句，不是这行。缓解（不影响判定，只影响后果严重度）：roadmap.md:107 的 T032 范围里仍单列了「F3 根因」，同一 README 的 F3 行（README.md:216 附近）也写着「根因与修法仍未拍板」，所以上机清单未必真会漏掉 F3；但第 136 行本身把未签收的读数写成了已关闭结论，属实。静态推断（需加密 Windows 才能验证放行维度）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 批次D T030行、批次E T032行；相关原文：「T030 | 未认领节点：P4-6 现场口径、P2-5/P2-6 可比性、H/17、H/19、H/21、F1～F7 复核…｜T032 | 上机检查单：合并旧树待现场项（…F3 根因）…」

### [field-02] LOW docs confirmed | P4-6 | docs/plans/2026-09-09-bash-carrier-decision.md:3 | D1 决策文档的现场结果栏全空，等于把已被证明无效的 R4 方法原样留给下一次上机（静态推断）
DESC: 这份文档是 D1（bash 载体）与 F3 共用的判据来源，第 6 节用一张表列 R0～R4，每行最后一列叫「现场结果」。2026-09-09/10 的 Windows 现场已经跑过这五条并把结果记进 test12-reverify.md 第 575～808 行：R0 只拿到 shell 自报并经 cygpath 转换的路径、进程映像未取证；R1 写读成功但文件是否处于加密态未证；R2/R3 不签；R4 结果无效——隔离环境下命令仍然执行成功，说明 harness 根本没让 worker 的 shell resolver 进入 shell_unconfigured。但决策文档一个字没回填：状态行仍是「待现场数据拍板」，五个「现场结果」格子全是 ⬜。R4 的有效性最终要在 Windows 上确认，故为静态推断。
EVIDENCE: docs/plans/2026-09-09-bash-carrier-decision.md:3 `> 状态：**待现场数据拍板**（Linux 侧论证完成，判定探针已就绪）`
docs/plans/2026-09-09-bash-carrier-decision.md:65-73 五行的最后一列均为 `⬜`，例如 `| R4（可选，健壮性非决策项） | 临时把 Git 从 PATH 与默认目录移开后调用 bash 工具 | 报 \`shell_unconfigured\` 而非崩溃/挂起 | 确认无 bash 时的失败是干净的 | ⬜ |`

Windows-P4-6-evidence/test12-reverify.md:808 `R4 结果无效：隔离环境下命令仍执行成功，说明 harness 没有真正让 worker 的 shell resolver 进入 shell_unconfigured；不能据此签 R4。`
SCENARIO: 批次 E 的操作员打开这份文档准备上机项，看到五行全空，按表原样执行：R4 依旧用「临时把 Git 从 PATH 与默认目录移开」这一招，而这一招已被证明在隔离 harness 下量不出东西（Git 仍能从默认安装目录被发现）；R0 被当成从没做过而重做，真正缺的那一半（bash 进程的 Windows 映像路径与父进程取证）没人补。唯一一次上机的时间花在重复已知无效的方法上，D1 与 F3 仍然拍不了板。
FIX: 回填五行的「现场结果」，逐行写清取到什么、为什么不作数；把 R4 的操作改成能真正逼出 shell_unconfigured 的做法（在受控环境里覆写 src/runtime/host/shell.ts 会查的全部候选路径并逐个记录排除）；把 R2/R3 的前置条件补成「样本必须先被非白名单进程读出 %TSD-Header-###% 容器头才算受策略」；状态行从「待现场数据拍板」改为「部分回填，R2/R3/R4 待重跑」。
REFUTER(CONFIRMED,low): 成立。docs/plans/2026-09-09-bash-carrier-decision.md:3 仍是 `> 状态：**待现场数据拍板**（Linux 侧论证完成，判定探针已就绪）`；第 6 节表头在 63 行 `| 编号 | 步骤 | 观察 | 结论映射 | 现场结果 |`，R0/R1/R2/R3/R4 分别在 65、66、69、71、73 行，最后一列全是 `⬜`，其中 73 行 R4 的步骤仍写 `临时把 Git 从 PATH 与默认目录移开后调用 bash 工具`。而现场早已跑过并否掉该方法：test12-reverify.md 结论段 `R4 结果无效：隔离环境下命令仍执行成功，说明 harness 没有真正让 worker 的 shell resolver 进入 shell_unconfigured；不能据此签 R4。`，R0 只拿到 shell 自报路径 `C:\Program Files\Git\usr\bin\bash.exe`、无进程映像取证。我在该文件内 grep `回填|test12|2026-09-1` 无任何命中，确认全文没有任何回填节。该文件历史只有一次提交（git log -- 该文件：55b4b893），批次 A～C 从未碰过，所以不存在「已修」。看板侧确有一行部分对冲（README.md:142 `| R4 无 Bash | 可选探针无效（shell 仍被发现）；独立保留…`），但下一次上机的操作文档是这份决策文档，它自己没回填。静态推断（R4 的替代做法有效性要在 Windows 上确认）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T032行；相关原文：「T032 | 上机检查单：合并旧树待现场项（…F3 根因）、T001 后的 PERM-1 探针复跑…」

### [field-03] LOW docs confirmed | F5 / F7 / GUI C/8 | docs/plantree/plans/runtime-evolution/README.md:223 | 现场表 F7a/F7c 行仍写「通用问答卡仍受 F5 限制」，与同表 F5 行自相矛盾
DESC: 现场缺陷表第 223 行 F7a/F7c（权限卡样式/尺寸）的证据列写着「不在 test.13；通用问答卡仍受 F5 限制」。这句话成立的时点是 2026-09-09——当时 question.requested 全仓没有生产者，问答卡弹不出来，样式/尺寸没法验。但同表第 221 行的 F5 已是「🟢 已实现（2026-09-12，4916a633）」，ask 工具与 PendingQuestionDock 在 HEAD 上都在。两行在同一张表上给出互斥结论。
EVIDENCE: README.md:223 `| F7a/F7c 权限卡样式/尺寸 | 🟡 结构化权限链与重画本地真实应用可用；倒计时原未接通，已补 \`baeff487\` 并本地验证；视觉口径仍待定 | 不在 test.13；通用问答卡仍受 F5 限制 |`
README.md:221 `| F5 通用问答缺生产者 | 🟢 已实现（2026-09-12，\`4916a633\`）…**仅自动化测试，未真机点验** |`

src/runtime/plugins/tools/index.ts:274 `    if (this.config.ask) this.register(askTool(this.config.ask), 'read');`
src/renderer/components/chat/ChatWorkspace.tsx:250 `          <PendingQuestionDock sessionId={activeSessionId} />`
SCENARIO: 批次 E 排 F7a/F7c 的上机项时读到「通用问答卡仍受 F5 限制」，判定问答卡这一半没法验，只安排权限卡的样式复核。而 F5 行与 GUI C/8 行（README.md:194）都写着「未真机点验」——问答卡的尺寸、字体、可作答交互因此在唯一一次上机中没有任何人负责，F7c 带着一半未验被签掉。
FIX: 删掉第 223 行的该子句，改为「问答卡已有生产者（F5，4916a633），F7c 的问答卡半边随 GUI C/8 一并在批次 E 点验」。
REFUTER(CONFIRMED,low): 成立，且能给出时点证据。README.md:223 原文 `| F7a/F7c 权限卡样式/尺寸 | 🟡 结构化权限链与重画本地真实应用可用；倒计时原未接通，已补 `baeff487` 并本地验证；视觉口径仍待定 | 不在 test.13；通用问答卡仍受 F5 限制 |`，同表 221 行 `| F5 通用问答缺生产者 | 🟢 已实现（2026-09-12，`4916a633`）…**仅自动化测试，未真机点验** |`。HEAD 上生产者与渲染位都在：src/runtime/plugins/tools/index.ts:274 `if (this.config.ask) this.register(askTool(this.config.ask), 'read');`，src/renderer/components/chat/ChatWorkspace.tsx:250 `<PendingQuestionDock sessionId={activeSessionId} />`。时点也对得上：223 行那句由 5117bbd4（2026-09-10）写入，F5 落地提交 4916a633 是 2026-09-12，之后无人回改（git log -S'通用问答卡仍受 F5 限制' 只有 5117bbd4 一条）。唯一可为它辩护的读法是把「F5 限制」理解成 F5 行现在那句「未真机点验」，但原句写于 F5 尚无生产者时，字面是「弹不出来所以没法验」，作为下一次上机的排单依据会误导。严重级维持 low（文档陈旧，非行为缺陷）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T030行；相关原文：「T030 | 未认领节点：P4-6 现场口径、P2-5/P2-6 可比性、H/17、H/19、H/21、F1～F7 复核…」

### [field-04] LOW docs confirmed | P4-6 | Windows-P4-6-evidence/launch-native.ps1:3 | 已删除的后端开关在现场启动脚本与清单里还剩四处，脚本还会把它回显成一条假确认（静态推断）
DESC: AICLIENT_RUNTIME_BACKEND 随 P6-5（2026-09-13）与旧引擎一起删除，设它不再有任何效果。审计 core-host-16 抓的是这件事的两处半边——evidence/p4-6/README.md 的交接清单（T027 已改写）与 scripts/run-perm1-probe.mjs 的死分支（T028 已删）。但上机日真正要执行的文件没进这条线：两个 PowerShell 启动脚本、GUI A～E 现场清单的启动命令、Linux 侧交回清单的「启动与载体」行，四处都还在设这个变量；两个脚本还紧接着 Write-Host 把自己刚设的值回显出来，读起来像一条「已在 native 上」的确认。需 Windows 现场执行才能观察实际误导效果，故为静态推断。
EVIDENCE: Windows-P4-6-evidence/launch-native.ps1:1-7
`# AiClient test.11 native 启动脚本 —— 确保 AICLIENT_RUNTIME_BACKEND 真正进入 worker`
`$env:AICLIENT_RUNTIME_BACKEND   = 'native'`
`Write-Host "backend=$env:AICLIENT_RUNTIME_BACKEND agent=$env:AICLIENT_RUNTIME_AGENT_DIR trace=$env:AICLIENT_RUNTIME_TRACE_DIR"`

另三处：Windows-P4-6-evidence/launch-gui-a-e.ps1:17 与 :22；Windows-P4-6-evidence/gui-a-e-checklist.md:12；Windows-P4-6-evidence/linux-side-punch-list.md:73。
对照已改写的口径 evidence/p4-6/README.md：`以 worker trace 证据确认实际后端（stamp.backend 现恒为 native——AICLIENT_RUNTIME_BACKEND 已随 P6-5 连同旧引擎一起删除，设置它不再有任何效果），不能只看能否聊天（审计 core-host-16，T027 改写此行）`。全仓 grep 确认 src/ 内已无该变量的生产消费者（仅 src/runtime/flags.ts 保留 AGENT_DIR / TRACE_DIR 两个仍有效的变量）。
SCENARIO: 批次 E 的操作员按现场习惯执行 `. .\Windows-P4-6-evidence\launch-native.ps1` 起应用，屏幕打印 backend=native，据此在记录里写下「已确认 native 后端」。这一行完全由脚本自己的赋值决定，与实际 worker 无关；如果本次载体形态与预期不符（例如 node_source 落到 explicit 而非产品路径推导出的 bundled，test.12 的 electron-utility 那次正是 explicit），这条回显不会暴露任何异常，而现场记录会留下一条看起来已取证的结论。
FIX: 四处一起改：两个 .ps1 删掉 AICLIENT_RUNTIME_BACKEND 赋值与回显，改成启动后从 $env:AICLIENT_RUNTIME_TRACE_DIR\runs.jsonl 读 stamp.backend / carrier / node_exec_path 三个字段并打印；gui-a-e-checklist.md:12 与 linux-side-punch-list.md:73 的启动命令同步删掉该变量，措辞对齐 evidence/p4-6/README.md 已改写的那句。
REFUTER(CONFIRMED,low): 成立，残留比报告说的还多一处。Windows-P4-6-evidence/launch-native.ps1 第 1～7 行仍是 `# …确保 AICLIENT_RUNTIME_BACKEND 真正进入 worker` / `$env:AICLIENT_RUNTIME_BACKEND   = 'native'` / `Write-Host "backend=$env:AICLIENT_RUNTIME_BACKEND agent=… trace=…"`；launch-gui-a-e.ps1:17 赋值、:22 回显同形；gui-a-e-checklist.md:12 启动命令 `$env:AICLIENT_RUNTIME_BACKEND='native'; …`；linux-side-punch-list.md:73 `| 启动与载体 | 退出旧应用；`AICLIENT_RUNTIME_BACKEND=native` 启动；…`。报告漏列的第五处：Windows-P4-6-evidence/launch-resume-repro.ps1:2 与 :6（同样赋值 + 回显）。变量确已无生产消费者：全仓 grep 后 src/ 下唯一命中是注释 src/runtime/flags.ts:7 `P6-5 did exactly that on 2026-09-13: `AICLIENT_RUNTIME_BACKEND` is gone along with the engine it could select, setting it has no effect`，flags.ts 只导出 AGENT_DIR / PI_AGENT_DIR 等仍有效的键。批次 A～C 确实没碰这些文件：git log -- launch-native.ps1 只有 8f4a838f，launch-gui-a-e.ps1 / gui-a-e-checklist.md 只有 b3a8f778，linux-side-punch-list.md 最新是 55b4b893，均早于加固批次；被 T027 改写的是另一份 evidence/p4-6/README.md:49。静态推断（实际误导效果要现场执行才观察得到）。
WAIVER(none): 无 — 无匹配（已检索 ARD、README、topics、evidence README、roadmap Deferred/Done、decisions 001-012、open-questions）

### [field-05] LOW docs confirmed | P4-6 / PERM-1 | docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1/README.md:6 | PERM-1 证据的复现命令已失真，而 T032 要求的复跑会就地覆盖被标为 legacy 的历史证据
DESC: perm1 证据 README 第 6 行给的复现方式是两条命令（默认 legacy、PERM1_NATIVE=1 走 native），第 39 行把产物分成「perm1-report.json（legacy）」与「perm1-native-report.json（native）」。T028 已删掉 PERM1_NATIVE 变体——脚本自己的注释写明 P6-5 退役了另一个引擎和 AICLIENT_RUNTIME_BACKEND，那次改写是自认的空操作，两套文件名描述的是同一次运行。于是脚本现在只有一套输出名：perm1-report.json 与 perm1-{popup,auto-confirm,approval-surface,after-allow}.png，正是 README 标注为 legacy 那一趟的五个文件。而 roadmap T032 明确要求复跑该探针。
EVIDENCE: docs/.../evidence/p4-6/perm1/README.md:6 `\`node scripts/run-perm1-probe.mjs\`（legacy 后端）与 \`PERM1_NATIVE=1 node scripts/run-perm1-probe.mjs\`（native 后端）。`
docs/.../evidence/p4-6/perm1/README.md:39 `原始输出：[perm1-report.json](perm1-report.json)（legacy）、[perm1-native-report.json](perm1-native-report.json)（native）。`

scripts/run-perm1-probe.mjs:43-51 `* T028 deleted the \`PERM1_NATIVE=1\` variant. … The old command line still works, it just files under the one name now.` / `const REPORT_NAME = 'perm1-report.json';` / `const SHOT_PREFIX = 'perm1';`
scripts/run-perm1-probe.mjs:138 `  const file = path.join(outDir, \`${SHOT_PREFIX}-${name}.png\`);`
docs/plantree/plans/runtime-hardening/roadmap.md:107 `…T001 后的 PERM-1 探针复跑（\`scripts/run-perm1-probe.mjs\`，需真实模型回合）…`
SCENARIO: 批次 E 执行 T032 的 PERM-1 复跑，探针把新一次运行的报告与四张截图写进 evidence/p4-6/perm1/，覆盖 perm1-report.json、perm1-popup.png、perm1-auto-confirm.png、perm1-approval-surface.png、perm1-after-allow.png。此后 README 第 39 行的对应关系反了：被标为「legacy」的文件里装的是一次 native 运行，而被标为 native 的 perm1-native-* 反倒是 2026-09-11 的旧记录，两份记录谁新谁旧从文件名上看不出来，只能翻 git 历史。
FIX: 一是在 perm1/README 顶部加时点注记：legacy 后端与扩展 UI 审批弹窗已分别随 P6-5 与 T036 删除，本文第 16 行那张英文弹窗与第 104 行「是否接管它」的未决项都已失去对象，命令只剩一条。二是让探针按运行日期或提交短哈希落名（如 perm1-report-<yyyymmdd>.json），或把 2026-09-11 那两趟先移进 2026-09-11/ 子目录再复跑。
REFUTER(CONFIRMED,low): 成立。docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1/README.md:6 `\`node scripts/run-perm1-probe.mjs\`（legacy 后端）与 \`PERM1_NATIVE=1 node scripts/run-perm1-probe.mjs\`（native 后端）。`，:39 `原始输出：[perm1-report.json](perm1-report.json)（legacy）、[perm1-native-report.json](perm1-native-report.json)（native）。`。探针侧 T028 已把变体删掉并只留一套名字：scripts/run-perm1-probe.mjs:44-49 注释 `T028 deleted the \`PERM1_NATIVE=1\` variant. … the two name sets described one and the same run.`，:50 `const REPORT_NAME = 'perm1-report.json';`、:51 `const SHOT_PREFIX = 'perm1';`。覆盖路径是硬编码的固定目录，不是临时目录：:38 `const outDir = path.join(repoRoot, 'docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1');`，:138 `const file = path.join(outDir, \`${SHOT_PREFIX}-${name}.png\`);`，:314 `fs.writeFileSync(path.join(outDir, REPORT_NAME), …)`。目录里现存 perm1-*.png / perm1-report.json 与 perm1-native-* 两套共 10 个文件，而 roadmap.md:107 的 T032 明确要求 `T001 后的 PERM-1 探针复跑（\`scripts/run-perm1-probe.mjs\`，需真实模型回合）`，复跑即就地覆盖被标为 legacy 的那五个文件。另外 README:101-104 的未决项（legacy 英文弹窗是否接管）在 T036 删掉扩展 UI 后已经没有对象，佐证这份证据 README 的时点注记确实缺失。文件历史 git log -- 该 README 只有 8b75b646，批次 A～C 未回写。严重级 low（证据可追溯性受损，非行为缺陷）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T032行；相关原文：「T032 | 上机检查单：…T001 后的 PERM-1 探针复跑（`scripts/run-perm1-probe.mjs`，需真实模型回合）…」

### [field-06] LOW contract-gap confirmed | P4-6 / F1～F7 | docs/plantree/plans/runtime-hardening/roadmap.md:107 | T032 声称合并旧树待现场项，枚举却漏掉本区域全部十余条
DESC: T032 的范围写的是「合并旧树待现场项（P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因）」。括号里的枚举就是实际执行时会被照抄的清单，而本区域在看板上明写「未真机点验 / 未打包 / 加密机复测」的项，除 F3 根因外一条都不在其中：F4 的 GUI 观感与加密机复测、F5 与 GUI C/8 的问答卡真机、F6 的打包后回归、F7a/c 的视觉口径与倒计时走到底、F2-b 的第三个删除按钮与正常退出清理、GUI A/4 的加密机回归、GUI A/10 的 TEMP /new 矩阵、GUI F/13 的真实 busy 会话数字、GUI F/15 的 F2-a/c 新包复验、TUI-1 的真机点验。计划同时写明「全部做完后再去现场实测一次，不再分轮上机」，所以漏掉即等于不做。
EVIDENCE: docs/plantree/plans/runtime-hardening/roadmap.md:107 `| T032 | 上机检查单：合并旧树待现场项（P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因）、T001 后的 PERM-1 探针复跑…与审计静态推断项… |`

对照：README.md:220（F4 行）`…**没在 GUI 里看一眼用户侧长什么样**…**没在加密 Windows 上复测**。`；README.md:221（F5 行）`…**仅自动化测试，未真机点验**`；README.md:194（GUI C/8 行）`…**未真机点验**，未打包。`
SCENARIO: T032 的产出物是一张逐项带判据的检查单，写单子的人按 roadmap 的括号枚举展开。展开后单子里没有问答卡、没有 F4 的 GUI 观感、没有临时会话的第三个删除按钮。批次 E 按单子执行一遍并逐项取证入 evidence，上机结束、机器交还，而 P4-6 与 GUI 的 A/4、C/8、F/13、F/15 五行仍停在 🟡，没有任何一次现场能再补。
FIX: 把本报告「上机检查单」一节的 23 条并入 T032 的范围列，并把 T032 括号内的短枚举改成「见 raw/ 下各区域报告的检查单」，避免下一次再靠括号当唯一来源。
REFUTER(CONFIRMED,low): 枚举不全属实。docs/plantree/plans/runtime-hardening/roadmap.md:107 原文范围列 `上机检查单：合并旧树待现场项（P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因）、T001 后的 PERM-1 探针复跑…与审计静态推断项（permissions-19、core-host-05/07、tools-10、cutover-03、P1-8 证据重采、P6-4 旧版产物互读）`，括号内确实不含本区域十余条看板上仍标未验的项，逐条我都在看板上核到了原文：README.md:220 F4 行 `GUI 侧观感与加密机复测未做`、:221 F5 行 `**仅自动化测试，未真机点验**`、:194 GUI C/8 行 `**未真机点验**，未打包`、:190 A/4 行 `加密机回归并入最后一次上机`、:189 A/10 行 `原 TEMP /new 矩阵未完整补签`、:198 F/13 行 `**仍缺**：真实 busy 会话下数字出现并刷新的现场记录`、:200 F/15 行 `F2-a/c 后续修复待 test.13 验证`、:233 TUI-1 行 `**未真机点验**`、:215 F2-b 行 `仍未测：临时行第三个「删除」按钮…；正常退出（非 kill）时的退出清理`。上机只有一次也属实：README.md:37 `用户 2026-09-10 决定：全部做完后再去现场实测一次，不再分轮上机`，roadmap.md:9 `E（现场）最后一次上机，合并 A～D 的现场项`。唯一的对冲是流程本身留了口子——roadmap.md:93 的 T031 验收写 `形成批次 E 的检查单`、T029/T030 验收写「发现进本 roadmap」，即批次 D 的报告本来就该并进 T032；但按当前文本，T032 范围列里的括号枚举是写单人唯一的现成清单，不补就会漏。严重级 low（规划文档缺口，可在批次 D 收口时一并补）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 顶部“顺序与依赖”一行、T030行；相关原文：「D（补审）与 A/B 并行，只读不冲突；E（现场）最后一次上机，合并 A～D 的现场项。｜T030 | 未认领节点：P4-6 现场口径、…、F1～F7 复核…」

### [concurrency-03] LOW concurrency confirmed | P3-1 | src/runtime/trace.ts:258 | 多个 worker 共用一个 traceDir 时会双重轮转，提前丢掉一整代 trace 并在代号上留空洞（审查员原判 medium）
DESC: 轮转判据是 stat 盘上的真实大小（这个选择本身对：文件比进程活得久），执行是三次 rename。进程内轮转与追加在同一条 pending 链上，注释也只声称到进程内为止；跨进程完全没有协调，N 个 worker 在文件接近上限时会各自得出「该轮转了」，然后各做一轮完整三次改名，第二轮把第一轮刚上移的代再上移一次：本该再保留一个周期的那一代被直接覆盖，同时 runs.1.jsonl 变空缺（源文件已不在，move 把 ENOENT 当正常跳过）。T024 已把这条明确移交本任务。产品打包态不触发——全仓没有生产代码设 AICLIENT_RUNTIME_TRACE_DIR；受影响的是现场取证：取证脚本先设这个变量再起应用，而 buildPiWorkerEnvironment 把 process.env 整份继承给每个 worker（PiWorkerProcess.ts:53-56）。
EVIDENCE:       // Oldest first, so nothing is overwritten before it has been shifted up.
      // `rename` replaces the destination, which is what retires generation N.
      for (let index = this.fileGenerations; index >= 1; index--) {
        const from = index === 1 ? path : join(dir, `runs.${index - 1}.jsonl`);
        await this.move(from, join(dir, `runs.${index}.jsonl`));
      }

// trace.ts:206-210，串行保证只到进程内：
    const work = this.pending.then(async () => {
      // Rotation runs inside the same serialized chain as the append, so a
      // rename can never land between another run's size check and its write.
SCENARIO: 现场取证按 evidence/p4-6 的脚本设好 AICLIENT_RUNTIME_TRACE_DIR 后起应用，同时开三个会话跑任务。runs.jsonl 涨到 8 MiB 附近，会话 A 与 B 的 worker 在同一秒各自结束一个 run：两边 stat 都得到 8 MiB+，都进轮转。A 做完 runs.2→runs.3、runs.1→runs.2、runs→runs.1；B 紧接着再做一遍，把 A 刚放到 runs.2 的那一代盖掉 runs.3，把满文件移到 runs.2，runs→runs.1 因源文件不存在被跳过。结果 runs.1.jsonl 缺失、原第三代被提前销毁，按代号拼时间线的人得到一段看不出缺口的缺失历史。次生形态：A 的 appendFile 落在 B 的 rename 之后，最新的 run 出现在 runs.1.jsonl 里。
FIX: 让文件名自带进程身份：落盘改为 runs.<pid>.jsonl（或按 sessionId），轮转与上限按每个文件独立算，读者按 glob 收集——既不需要跨进程锁，又保住「一个 run 一行、不丢行」。若必须共享一个文件，则轮转前先拿 createOnly 的 <dir>/runs.rotate.lock（拿不到就跳过本次轮转直接追加），拿到后重新 stat 确认仍超限。
REFUTER(CONFIRMED,low): 代码事实成立，且计划文档已自认未落地。/home/ai/code/ai-client/src/runtime/trace.ts:244-262：rotate 先 `const size = await this.size(path)`（size() 走 `this.io.stat(path)`，读盘真实大小），超限后 `for (let index = this.fileGenerations; index >= 1; index--) { const from = index === 1 ? path : join(dir, 'runs.'+(index-1)+'.jsonl'); await this.move(from, join(dir, 'runs.'+index+'.jsonl')); }`，move() 在 ENOENT 时静默跳过（trace.ts:284-291）。串行只到进程内：trace.ts:205-208 注释明说 `Rotation runs inside the same serialized chain as the append`，this.pending 是实例字段。路径固定 `join(dir, 'runs.jsonl')`（trace.ts:203），dir 来自 bootstrap.ts:399 的 flags.traceDir，flags.ts:33/53 直接读单个环境变量 AICLIENT_RUNTIME_TRACE_DIR，无按会话/进程分路径；worker 继承整份 process.env（PiWorkerProcess.ts:53-56 `for (const [key, value] of Object.entries(input.inheritedEnv ?? process.env))`），所以取证时多 worker 共用同一文件。两进程各跑一轮三次 rename，第二轮把第一轮刚上移的一代再上移覆盖、runs.1 因源已不在被跳过 —— 丢一代 + 代号空洞成立。该条与既有 raw/capacity-leftovers.md:161 的 capacity-05 是同一条，roadmap.md:36 的 T024 收口明写「多 worker 并发轮转归 T031」，即已识别未修。降为 low：全仓无生产代码设置该环境变量（只有 flags.ts 定义与文档），仅影响手工取证时的 trace 历史完整性，不损坏会话数据、不影响用户可见功能。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第36行（Done 段 T024 行）；相关原文：「待落地（禁区文件，记在对账表）：用户附件无体积上限、`tool_execution_start` 把工具参数全文写进 trace、compaction 摘要正文无上限、会话文件缺单行最大字节兜底；多 worker 并发轮转归 T031。」
合并：capacity-05 并入本条（同一根因：src/runtime/trace.ts 的轮转逻辑在多个 worker 进程共享同一个 traceDir 时没有跨进程互斥。concurrency-03 说的是「双重轮转提前丢一代并在代号上留空洞」（trace.ts:258），capacity-05 说的是「runs.jsonl 轮转无跨进程互斥」（trace.ts:81），是同一份非原子的 rename+重建序列的两个观察角度，一次加文件锁（或改为按进程分目录）同时解决。保留 concurrency-03 作主编号，因为它把用户可见后果说全了。）

### [concurrency-04] LOW capacity confirmed | P5-3 | src/runtime/plugins/mcp/config.ts:227 | MCP 服务器数量只有每会话上限，没有全局预算，也没有进入 worker 内存分档的账（审查员原判 medium）（静态推断）
DESC: MAX_SERVERS = 16 是每个会话的上限，而每个会话是独立 worker 进程，各自完整拉起自己那一套服务器。会话容量按内存分档（≤4 GiB 三个、≤8 GiB 六个、其余十个），分档注释把一个 slot 算作「一整个 utilityProcess 加一份模型上下文」，没有把它可能带起来的最多 16 个常驻子进程算进去。相乘就是最多 160 个常驻子进程，每个还各带三条管道；4 GiB 的机器上是 48 个。没有任何一处对「这台机器上一共起了多少 MCP 子进程」有认识，也没有共享池——同一个服务器配置在 N 个会话里就是 N 份进程。
EVIDENCE: // src/runtime/plugins/mcp/config.ts:227
  if (servers.length > MAX_SERVERS) { const dropped = servers.slice(MAX_SERVERS).map(…); }
  return { servers: servers.slice(0, MAX_SERVERS), diagnostics };

// src/main/services/agent-host/WorkerManager.ts:316-325
 * a slot is a whole utilityProcess plus one model context, so on a
 * 4 GiB machine ten of them would not be ten working conversations…
export function resolveDefaultWorkerCapacity(totalMemoryBytes = os.totalmem()): number {
  if (totalMemoryBytes <= 4 * 1024 ** 3) return 3;
SCENARIO: 用户在 ~/.pi/mcp.json 里配了 8 个 MCP 服务器（浏览器、数据库、文件检索各一套是常见组合），在 16 GiB 机器上开到 8 个会话。应用这时持有 8 个 worker + 64 个 MCP 子进程，每个会话启动还要为它们各跑一次 45 秒预算内的握手。用户看到的是「开第五个会话之后整台机器开始卡」，而容量分档告诉它这台机器可以开十个。
FIX: 把预算从「每会话」提到「每应用」：Main 下发 MCP 配置时带全局余额（maxServersTotal），worker 按余额截断并把被截断的写进 diagnostics（复用现有超限文案）；或按会话数动态收缩每会话上限 min(MAX_SERVERS, floor(total/capacity))。同时把「一个 slot ≈ 1 个 utilityProcess + 模型上下文 + 最多 K 个 MCP 子进程」写进 resolveDefaultWorkerCapacity 的分档注释。
REFUTER(CONFIRMED,low): 事实核对无误，但属容量设计缺口而非缺陷行为。/home/ai/code/ai-client/src/runtime/plugins/mcp/config.ts:40 `export const MAX_SERVERS = 16;`，227-235 行 `if (servers.length > MAX_SERVERS) {...} return { servers: servers.slice(0, MAX_SERVERS), diagnostics };` —— 这是在 worker 内对本会话配置做的截断，没有任何跨会话/跨进程的余额概念（grep MAX_SERVERS 只有 config.ts 四处命中）。每个 native worker 都会开 MCP：src/runtime/worker/nativeWorkerRuntime.ts:219 `mcp: { ...(this.options.log ? { log: this.options.log } : {}) }`，且每台服务器都是独立子进程（mcp/index.ts:210 `const child = await exec.spawn({ command: server.command, ... })`）。容量分档注释（WorkerManager.ts:314-320「a slot is a whole utilityProcess plus one model context」）确实只算 worker 与模型上下文，没有把 MCP 子进程计入，resolveDefaultWorkerCapacity（:322-326）返回 3/6/10。所以「16 × 容量」的乘积无人记账成立，属静态推断。降为 low：没有错误行为，是用户自行配置多服务器 + 多会话时的资源压力与注释口径不全，最坏后果是机器变慢，不涉及数据或安全。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第101行（T031 行）；相关原文：「T031 | 并发、容量与 Windows 静态面：多会话写锁/runs.jsonl/技能缓存/MCP 进程数…」

### [concurrency-06] LOW concurrency confirmed | P5-2-1 | src/main/services/agent-host/subagentCatalog.ts:236 | 子代理定义文件是截断式写入，而读者是每个顶层 run 全目录重扫的 N 个 worker，撞上就读到半截文档（审查员原判 medium）
DESC: T020 之后每个顶层 run 开始前都会 subagents.refresh() 重读整个定义目录（agent-loop/index.ts:244），这是「编辑完下一轮就生效」的实现。写的一侧是 Main 设置页的 writeFile(this.pathFor(name), document, 'utf8')——先截断、再写，没有临时文件 + rename。两侧共用一个目录，读者有 N 个（每会话一个 worker 进程），读的时机不受控。读到空文件或半截 frontmatter 时解析器产出诊断、这条定义从目录里消失；refresh() 只有在 reload 抛错时才保留旧列表，返回一份缺人的目录是照单全收的。改名保存还有更长的窗口：先写新文件、再删旧文件，两者之间读到两条同内容不同名的定义。
EVIDENCE: // src/main/services/agent-host/subagentCatalog.ts:235-236
    await mkdir(this.directory(), { recursive: true });
    await writeFile(this.pathFor(name), document, 'utf8');

// src/runtime/plugins/subagent/index.ts:409-419（缺人的目录照单全收）
    try { catalog = await reload(); }
    catch (error) { this.config.log?.('[subagent] catalog reload failed', error); return; }
    this.activeDefinitions = applySubagentActivation(catalog, this.config.disabled ?? []).definitions;
SCENARIO: 用户同时开着三个会话，在设置页编辑子代理「researcher」的描述后点保存。保存的那一刻会话 B 正好开始新一轮：它的 refresh() 扫到 researcher.md 时文件已被截断成 0 字节 → 产出一条诊断 → 这一轮的 Task 工具枚举里没有 researcher。模型若按之前的菜单委派，拿到「unknown subagent」加一串诊断文本；用户看到的是「我刚保存完它就不见了」，下一轮它又回来——一个无法复现的幽灵。
FIX: 定义写盘改成与 SessionIndexService.writeJsonAtomically 同款的「写 <name>.<uuid>.tmp + rename」（同目录 rename 在 POSIX 与 Windows 上都是原子替换），改名保存也用同一手法把「写新 + 删旧」压成两次原子操作。读侧加便宜兜底：applySubagentActivation 之后若新目录比旧目录少了条目且本次扫描带解析类诊断，就保留旧列表并记日志，把「文件正在被写」和「用户真删了一个定义」区分开。
REFUTER(CONFIRMED,low): 两侧代码与时序都核对属实，未被 T020 修。写侧 /home/ai/code/ai-client/src/main/services/agent-host/subagentCatalog.ts:235-236 `await mkdir(this.directory(), { recursive: true }); await writeFile(this.pathFor(name), document, 'utf8');`（导入路径 :385-386 同样），是截断式写，没有 tmp+rename —— 同仓其他地方明明有原子写范式（src/main/services/chat/SessionIndexService.ts:21 writeJsonAtomically）。读侧确实在 worker 进程里直接读同一目录：bootstrap.ts:339-346 `readSubagentCatalog = () => loadSubagentCatalog(skillSource(ctx.runtimeHostIo, SUBAGENT_SCAN_BYTES), { ...(agentDir ? { agentDir } : {}) ... })`，bootstrap.ts:489 把它接成 reloadCatalog；agent-loop/index.ts:244 `await subagents?.refresh();` 在每个顶层 run 开头触发（T020 落的行为），subagent/index.ts:409-419 里 `catch { ...; return; }` 只在抛错时保旧表，解析失败降级成 diagnostics（catalog.ts:154 `diagnostics.push({ code: 'parse_failed', ... })`）后目录少人也照单全收。目录一致：Main 写 `join(agentDir(), 'subagents')`（subagentCatalog.ts:78-80），runtime 按 agentDir 读同一根。改名保存的 `writeFile 新 → rm 旧`（:236 与 :240-242）之间确有「两条同内容定义」窗口。降为 low：窗口是一次小文件 writeFile 的持续时间（亚毫秒级），要恰好与某个 worker 的 refresh 扫描撞上；后果是一轮里少一个 subagent 的幽灵现象，可自愈，不损坏数据。定性为缺口（原子写缺失 + 无测试覆盖）而非可复现的功能错误。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第47行（批次 D 状态行）；raw/concurrency.md 报头；相关原文：「下一步批次 D（审计覆盖补全，只读，T029～T031）待派」

### [concurrency-07] LOW contract-gap confirmed | H/20 | src/main/ipc/piTui.ts:114 | 「TUI 接管会话前不能有正在跑的回合」只由渲染层把关，Main 的 IPC 入口不复核
DESC: 跨进程单写者在 GUI → TUI 这个方向上靠顺序保证，不靠写锁：pi --session 这个 CLI 从不碰 writer.lock，Main 只有进程内的 PiTuiExclusiveGuard，而它的 transferTo 按设计是「永远转移、从不测试后设置」。反方向（GUI 要写时）Main 有硬门：handOverFromTui 先杀终端、再 assertHostPromptAllowed、必要时重读磁盘（ipc/chat.ts:137-145）。正方向（TUI 接管时）PI_TUI_OPEN 只检查「CLI 能不能解析这个文件」，没有问过 WorkerManager 该会话有没有正在跑的回合；唯一拦住它的是渲染层的 isSessionBusy。当前产品里够用（单一入口单一按钮），但它把一条数据完整性的不变式放在了信任边界外侧。
EVIDENCE: // src/main/ipc/piTui.ts:122-136
    if (request.sessionFile) {
      const support = await inspectPiTuiSessionSupport(request.sessionFile);
      if (!support.supported) throw new Error(support.reason);
      const acquired = sessionGuard.transferTo(request.sessionFile);   // 永远成功
      if (!acquired.ok) throw new Error(acquired.reason);
      tuiWrittenSessions.add(normalizeSessionKey(request.sessionFile));
    }

// src/renderer/components/chat/usePresentationSwitch.ts:86（唯一的 busy 门）
    if (isSessionBusy(liveStatus ?? 'idle')) { addToast({ … 'Wait for this turn to finish' }); return; }
SCENARIO: 任何绕开 usePresentationSwitch.openTui 的 PI_TUI_OPEN 调用（第二个窗口、将来加的命令面板项、开发者在 devtools 里直接调 window.electronAPI.piTui.open）在一个回合正在跑时把终端开在同一个会话文件上：worker 还在按内存里的 leaf 追加条目，CLI 从它读到的那一版开始写自己的条目，两条分支交织进同一个 JSONL，而写锁完全看不见这件事（CLI 不取锁）。
FIX: 把这条判断挪到 Main：PI_TUI_OPEN 在 transferTo 之前先问 WorkerManager「这个会话文件现在有没有活跃请求」（entriesByKey + activeRequestId 已经在手边），有就拒绝并返回与渲染层同一条文案的错误码；渲染层那道门保留为体验层，而不是唯一的正确性保证。
REFUTER(CONFIRMED,low): 推不翻，但要把「可触发性」钉死。事实核对：(1) src/main/ipc/piTui.ts:114-136 的 PI_TUI_OPEN 处理器全文只有四道检查——assertAgentSpawnAllowed()、isRemoteVirtualPath 拒绝、`const support = await inspectPiTuiSessionSupport(request.sessionFile); if (!support.supported) throw`、`const acquired = sessionGuard.transferTo(request.sessionFile)`，确实没有任何一处问 WorkerManager「这个会话有没有在跑的回合」。(2) transferTo 在 src/main/services/terminal/piTuiSession.ts:85-89 就是无条件赋值：`const key = normalizeSessionKey(sessionKey); if (!key) return {ok:false...}; this.#ownerKey = key; return {ok:true};`，注释自己写明「Deliberately a transfer, not a test-and-set」，所以它不是门。(3) 反方向确有硬门：src/main/ipc/chat.ts:125-146 的 handOverFromTui 先 releaseSessionForHostPrompt 杀终端、再 assertHostPromptAllowed(sessionFile)、terminalWrote 时 reloadSessionFromDisk。(4) 唯一 busy 门确在渲染层 src/renderer/components/chat/usePresentationSwitch.ts:86 `if (isSessionBusy(liveStatus ?? 'idle')) { addToast(...'Wait for this turn to finish'); return; }`。(5) 会写坏的物理前提也成立：native 会话现在写双格式头，piTuiSession.ts:158-161 只对 `kind==='header' && version===4 && type!=='session'` 的旧头拒绝，其余一律 supported，所以 native 会话真会被 TUI 接管；而 src/runtime/plugins/session/store.ts:129 的 acquireWriterLock 是 worker 侧 open 到 close 全程持有的建议锁，`grep -rl "writer.lock" node_modules/@earendil-works/pi-coding-agent` 零命中，证实 CLI 不取这把锁。(6) 现有测试无覆盖：src/main/ipc/__tests__/piTuiHandover.test.ts 152 行里 grep busy/running/active/WorkerManager 全为空。降级理由（比审查员更保守地确认在 low）：产品内暂无绕过路径——piTui.open 全仓只有 src/preload/index.ts:480 的透传与 src/renderer/hooks/useXterm.ts:758 一处调用，而 useXterm 那个 create effect 的依赖数组（useXterm.ts:825-836）只含 piTuiTerminalId 而不含 piTuiSessionFile，所以「TUI 模式下切到另一个正在跑的会话」不会重新 open；Main 也只造一个主窗口（src/main/windows/MainWindow.ts:175）。因此这是一条确凿的信任边界外置（防御纵深缺口 + 测试缺口），不是当前可复现的数据损坏。
WAIVER(none): 无取舍 — 核对来源：raw/concurrency.md 报头与节点判定对象列表；相关原文：「任务：T031（批评者缺口 15，`cross-and-critic.md:78` GAP [并发多会话]）… 节点判定对象：P3-1、P3-3、P5-1、P5-3、P4-0 的并发面」

### [concurrency-08] LOW dead-code confirmed | P5-1 | src/runtime/plugins/skills/index.ts:363 | SkillsPlugin.refresh() 全仓无生产调用方，多会话的技能快照只能靠各自重启对齐
DESC: 技能目录是 worker 启动时的一次性快照，插件为此提供 refresh()，注释也诚实写明「本插件不会自动调用它，触发端属于谁去做那个动作的人」（index.ts:85-90）。核实：全仓 runtimeSkills 的消费者只有 prompt/index.ts:69 的 segment()，refresh() 除测试外零调用；Main 侧既没有 IPC 也没有 UI 动作。T019 的落地记录写「触发端归 T020 / UI」，而 T020 只落了子代理的按 run 重读。并发面的后果是快照在多会话之间长期分叉：编辑技能之前开的会话与之后开的会话，在整个应用生命周期里向模型宣告不同的技能列表，事后从 trace 的 skills=<n> 版本戳上看是两个不同配置。
EVIDENCE: // src/runtime/plugins/skills/index.ts:363-368
  async refresh(): Promise<void> {
    const source = skillSource(this.ctx.runtimeHostIo, MAX_SCAN_BYTES);
    const [skills, templates] = await Promise.all([
      loadSkills(source, this.catalog.resolvedSkillRoots), …

$ grep -rn 'runtimeSkills' src/ --include=*.ts | grep -v 'plugins/skills' | grep -v __tests__
src/runtime/plugins/prompt/index.ts:69:    const skills = this.ctx.get('runtimeSkills')?.segment();
SCENARIO: 用户装了一个新技能（往 ~/.pi/skills/ 拷一个目录），此时应用里开着三个会话。这三个会话在本次应用生命周期内都看不到它——模型不会提、/skill:name 展开不了；新开的第四个会话则看得到。用户的心智模型是「技能是全局的」，实际得到的是「按会话打开时间分代」。
FIX: 二选一并落到文档：要么接触发端，加一个 worker RPC（worker.skills.refresh）挂在与子代理定义相同的时机（每个顶层 run 之前，或设置页保存技能后由 Main 广播给全部 worker）；要么保留快照语义但说明它，在技能列表处写明「新装的技能在新会话里生效」，并删掉这个没有触发端的 refresh()（连同只为它保留的 resolvedSkillRoots）。
REFUTER(CONFIRMED,low): 逐条复核全部属实。(1) src/runtime/plugins/skills/index.ts:363-376 的 refresh() 实现存在且会整体替换 this.catalog；接口注释 index.ts:83-90 自陈「Nothing in this plugin calls it automatically — the trigger belongs to whoever surfaces that action」。(2) 调用方核查：`grep -rn '\.refresh()' src/runtime --include=*.ts` 只命中 plugins/agent-loop/index.ts:244 `await subagents?.refresh();`（那是子代理，不是技能）、以及两处测试（__tests__/skills.test.ts:917、__tests__/subagentHardening.test.ts:366）；`grep -rn 'runtimeSkills' src/ --include=*.ts` 在 plugins/skills 之外只有 src/runtime/plugins/prompt/index.ts:69 `const skills = this.ctx.get('runtimeSkills')?.segment();`。(3) Main 侧无触发端：`grep -rn 'worker.skills|skills.refresh|refreshSkills' src/` 零命中，没有对应 RPC 也没有 IPC。(4) 快照语义成立：目录只在 loadSkillCatalog（index.ts:258-275）里扫一次，由 SkillsPlugin 构造函数收下（index.ts:281-283），之后只有 refresh() 能换，所以 worker 存活期间技能列表就是它启动那一刻的版本，多个 worker 之间可以长期分叉。(5) 这是项目已知并记录在案的缺口：docs/plantree/plans/runtime-hardening/roadmap.md:27（T019 行）原文写「`refresh()` 已实现但 Main 侧无调用方（触发端归 T020 / UI）」，而 roadmap.md:37 的 T020 落地记录只写了子代理「定义每个顶层 run 经 refresh() 重读」，没接技能。已记录 ≠ 已修，故不判 refuted。严重级维持 low：形态是无触发端的活代码 + 未兑现的契约，用户可见后果（新装技能要新开会话才生效）需要用户手动往技能目录放文件才会遇到。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md 第101行（T031 行）；相关原文：「T031 | 并发、容量与 Windows 静态面：多会话写锁/runs.jsonl/技能缓存/MCP 进程数…」

### [concurrency-09] LOW capacity confirmed | P4-0 | src/main/services/legacyImport/PiImportProcess.ts:34 | 导入 worker 另起一个进程，但不计入 worker 容量
DESC: 容量检查数的是 entriesBySession.size，而导入用的 worker 完全不进这两张表：inspectPiImport / reconcilePiImport / createPiImport 各自直接 forkPiWorkerProcess 并自建 WorkerSlot，只由 importSlotActive 这个布尔保证同时只有一个。进程峰值因此是 capacity + 1；在 ≤4 GiB 分档（容量 3）的机器上是 33% 超额，而分档注释的措辞正是按内存卡出来的。导入 worker 同样继承 process.env，在设了 trace 目录的现场场景里它也是 runs.jsonl 的第 N+1 个写者（见 concurrency-03）。
EVIDENCE: // src/main/services/legacyImport/PiImportProcess.ts:33-38
  const { transport } = forkPiWorkerProcess({ generation, cwd: payload.workspacePath });
  const slot = new WorkerSlot({ slotKey: `import-inspect:${payload.logicalSessionId}`, … });

// src/main/services/agent-host/WorkerManager.ts:707-708（容量只数会话条目）
      if (this.entriesBySession.size >= this.capacity) {
        const victim = this.selectEvictionCandidate();
SCENARIO: 3.3 GiB 的机器（容量 3），用户开满三个会话，其中两个刚跑完长回合、上下文都在内存里；这时他去设置页导入一段旧对话。第四个 worker 进程起来，带着自己一整套插件图与 Node 堆。内存压力下系统开始换页，正在跑的会话变慢或被 OOM killer 挑中——而应用自己认为它一直在容量以内。
FIX: 让导入走同一本账：导入前先 reclaimIdleInternal() 并在 entriesBySession.size >= capacity 时驱逐一个候选，或直接复用一个空闲 slot 跑导入 RPC（导入 RPC 本来就不需要绑定会话的 worker）；至少把导入槽计入 stats() 报的 slots，让「现在有几个 worker 进程」这个数字是真的。
REFUTER(CONFIRMED,low): 账目缺口成立，但审查员对后果的描述有一处夸大，我按缩小后的形态确认。(1) 导入确实另起进程且自建 slot：src/main/services/legacyImport/PiImportProcess.ts:33-40 `const { transport } = forkPiWorkerProcess({ generation, cwd: payload.workspacePath }); const slot = new WorkerSlot({ slotKey: `import-inspect:${payload.logicalSessionId}`, ... })`，reconcilePiImport（:60-67）与 createPiImport（:90-98）三处同构。(2) 它确实不进容量账：容量判断三处（WorkerManager.ts:707、935、1447）一律是 `if (this.entriesBySession.size >= this.capacity)`，而导入 slot 只被记进 this.activeImportSlot / this.activeImport，从不写 entriesBySession 或 entriesByKey；并发保护只有 WorkerManager.ts:517/591/622 的 `if (this.importSlotActive) throw new WorkerManagerError('worker_import_busy', ...)` 这一个布尔。(3) stats()/slots 也看不到它：WorkerManager.ts:465-475 的 entries 取自 `[...this.entriesBySession.values()]`，:501-513 的槽位列表同源，所以「现在有几个 worker 进程」这个数字在导入期间偏小 1。(4) 分档数字属实：resolveDefaultWorkerCapacity（WorkerManager.ts:322-326）`if (totalMemoryBytes <= 4 * 1024 ** 3) return 3;`，注释 :308-321 明说分档是按内存卡的，所以 3+1 = 33% 超额成立。夸大之处：导入 RPC 由 src/agent-host/piWorkerRpcServer.ts:371-380 的 'worker.import' / '.inspect' / '.reconcile' / '.discard' 分支直接处理，不需要 worker.bootstrap 建整套插件图，所以「带着自己一整套插件图与 Node 堆」偏重；真实增量只是一个未 bootstrap 的 fork 进程。综合判 low：缺陷的实质是容量与 stats 的口径不一致（资源账目 / 可观测性），不是可靠的 OOM 触发路径。
WAIVER(none): 无取舍 — 核对来源：raw/concurrency.md 报头与节点判定表；相关原文：「P4-0（同步平台 worker）| complete-with-gaps | 一会话一进程的假设在 Main 与 worker 两侧都有守卫，未发现同一会话被两个 worker 打开的路径；账面出入是导入 worker 不计容量（concurrency-09）…」

### [windows-04] LOW contract-gap confirmed | P4-6 | src/runtime/plugins/tools/index.ts:413 | Windows 上没装 Git for Windows 时 bash 工具照样登记给模型，每次调用返回一句指责宿主的英文错误（审查员原判 medium）（静态推断）
DESC: ToolsPlugin.install 无条件注册 bash（:413），只有在 execute 内部才检查 this.config.shellPath（:449-453），没有配就抛 shell_unconfigured，文案是 host must configure the shell executable。而 shellPath 来自 resolveWorkerShell（nativeWorkerRuntime.ts:197），它在 Windows 上只找 Git for Windows 的 bash.exe（shell.ts:100-119），找不到就返回 undefined。这与同一个文件里 ask 与 browser_preview 的登记规则直接矛盾：那两个工具的注释（:62-66 与 :68-72）写明宿主没有展示面就干脆不注册，理由是一个永远回答没人在听的工具还被登记着、模型会一直调它。bash 是同一种情况却走了相反的做法。后果不只是浪费：bash 是 Windows 上模型最常用的工具，会反复调、反复失败并占满上下文；错误文案是说给宿主开发者听的英文，用户既不知道该装什么也没有入口去装——现场 environment.md:24 明确记录安装包里未发现 resources/git 或 git/bin/bash.exe，即产品不随包带 Git，完全依赖用户机器上已有的 Git for Windows。全仓对 shell_unconfigured 零消费者（grep 只有抛出点本身），没有任何一层把它翻译成用户能照做的话。这正是 test12-reverify.md:585 里编号 R4 的验收项，状态一直是未执行。
EVIDENCE: src/runtime/plugins/tools/index.ts:413（无条件注册）
    this.register({
      name: 'bash',
      label: 'Bash',

同文件 :449-453
        if (!this.config.shellPath)
          throw new RuntimeHostError(
            'shell_unconfigured',
            'host must configure the shell executable'
          );

同文件 :62-66（相反的登记规则，写在注释里）
   * F5 - how the model reaches the user with a question. Absent registers no
   * ask tool at all, which is the honest state for a host with nowhere to
   * show one: a tool that always answers nobody is listening would still be
   * advertised, and the model would keep calling it.

src/runtime/host/shell.ts:96-121
): string | undefined {
  const windows = platform === 'win32';
  ...
  return candidates.find(exists);
}

Windows-P4-6-evidence/environment.md:24
未发现 resources/git/ 或 git/bin/bash.exe
SCENARIO: 一台干净的 Windows 11 装了本产品但没装 Git for Windows。用户开会话说跑一下测试。模型看到工具列表里有 bash，调用后拿到 shell_unconfigured host must configure the shell executable，换个写法再调、同样的错，反复三五次后放弃，告诉用户我无法执行命令。用户拿不到任何请安装 Git for Windows 的提示。
FIX: 按本文件自己的规则办：shellPath 为空时不注册 bash（和 ask 与 browser_preview 一样），让模型能看见自己没有这个能力。同时在 Main 侧做一次启动预检，resolveWorkerShell 返回 undefined 时通过已有的宿主状态横幅给一条可操作的中文提示（未找到 Git for Windows 的 bash.exe，命令执行功能不可用，请安装 Git for Windows 或在设置中指定 bash 路径），并纳入 T023 已扩到 runtime 与 agent-host 的 noHardcodedChinese 守卫范围。上机日按旧树 R4 取证。
REFUTER(CONFIRMED,low): 代码事实成立，但审查员的核心论据之一被推翻，故我下调严重级。成立部分：tools/index.ts:412-415 无条件 `this.register({ name: 'bash', ... })`，:449-453 才 `if (!this.config.shellPath) throw new RuntimeHostError('shell_unconfigured','host must configure the shell executable')`；与同文件 :62-66（ask）、:68-72（browser_preview）写明「没有展示面就不注册」的规则确实相反；shellPath 来自 worker/nativeWorkerRuntime.ts:197 `shellPath: resolveWorkerShell(this.options.host.childEnv)`，host/shell.ts:14-35 在 Windows 只找 Git for Windows 的 bash.exe，找不到返回 undefined（:35 `return candidates.find(exists)`）；全仓 grep `shell_unconfigured` 只有 tools/index.ts:451 抛出点一处，确无翻译层。被推翻部分：「用户既不知道该装什么也没有入口去装」不成立——src/renderer/App.tsx:1012 挂载了 `<GitMissingNotice />`，该组件 GitMissingNotice.tsx:52-62 启动即调 `onboarding.checkPrerequisites()`，:50 `const canInstall = window.electronAPI.env.platform === 'win32'`，:72 `window.electronAPI.onboarding.installGit()`，Main 侧 src/main/ipc/onboarding.ts:235-256 真的会下载并静默安装 Git for Windows（GitInstaller.ts:9 的 GIT_INSTALLER_URL、:229-244），非 Windows 给 git-scm 下载链接（:7）。所以「干净 Windows 未装 Git」这个场景其实有横幅加一键安装。残留真缺口有两处：一是登记不对称导致模型反复调一个必失败的工具并拿到英文宿主向错误；二是 GitInstaller.ts:291-309 的 detectGit 以 `git --version` 成功即判 installed=true，而 resolveWorkerShell 认的是 bash.exe，所以「有 git 无 Git-Bash」时横幅不出、bash 工具照样坏。严重级 low：能力确实不存在，差别只在优雅与否，且已有并行的用户可见补救面。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings.json waivers[node=P1-6, kind=field-only]；docs/plantree/plans/runtime-hardening/decisions/002-remediation-order-and-waiver-rule.md；相关原文：「未打包，未在加密 Windows 上回归；按用户 2026-09-11 的规矩并入最后一次上机 /「待现场验证」「待复验」只豁免缺现场证据，不豁免代码本身的缺陷」

### [windows-05] LOW correctness confirmed | P4-6 | src/runtime/plugins/tools/index.ts:384 | edit 对 CRLF 文件做逐字节精确匹配，失败时的错误不提行尾，模型会退回整文件 write 从而把全文行尾改成 LF（审查员原判 medium）（静态推断）
DESC: edit 用 content.indexOf(edit.oldText) 做精确匹配（:384），全链路没有任何行尾归一。read 保留了回车符（read-lines.ts 按换行符切行、切片含回车），所以严格逐字复制 read 输出的模型能匹配上；但模型普遍会把多行文本归一成纯换行再发回来，一旦归一，跨行的 oldText 在 CRLF 文件上必然匹配不上。失败后模型拿到的是 edit_not_unique，文案是 oldText must match exactly once; file was not changed——这句话把模型推向我引的上下文不唯一，真正原因是行尾，没有任何线索指向 CRLF。模型的标准应对是改用 write 重写整个文件，而 write（:337-359）同样不做行尾处理，直接把模型给的字符串落盘，结果是一次本该三行的改动变成整个文件行尾从 CRLF 变 LF，在 git 里表现为全文件 diff。Git for Windows 默认安装选项就是 core.autocrlf 为 true，所以这在 Windows 工作区是常态而非边角；现场证据也对得上，test12-reverify.md:748 记录探针文件是 57 字节 UTF-8 文本、含 CRLF 和中文。对照：grep 已经为 CRLF 修过（tools-17，index.ts:630 用可选回车的正则切行），edit 与 write 没有跟上。静态推断部分：模型的实际退化行为（尤其退回 write 这一步）需在 Windows CRLF 工作区跑真实模型回合确认；不做行尾归一、错误文案不提行尾这两点是确定的代码事实。
EVIDENCE: src/runtime/plugins/tools/index.ts:380-390
          for (const edit of args.edits) {
            const start = content.indexOf(edit.oldText);
            if (start < 0 || content.indexOf(edit.oldText, start + 1) >= 0)
              throw new RuntimeHostError(
                'edit_not_unique',
                'oldText must match exactly once; file was not changed'
              );
            content =
              content.slice(0, start) + edit.newText + content.slice(start + edit.oldText.length);

同文件 :350（write 原样落盘）
          await io.writeFile(target, Buffer.from(args.content));

对照同文件 :628-630（grep 已处理 CRLF）
          // carries the stray byte (tools-17).
          const lines = Buffer.from(data.bytes).toString('utf8').split(可选回车加换行的正则);

Windows-P4-6-evidence/test12-reverify.md:748
本次 Python、PowerShell 与 Node 读取均得到 57 字节 UTF-8 文本（含 CRLF 和中文）
SCENARIO: Windows 工作区，core.autocrlf 为 true 检出的仓库，src/app.ts 是 CRLF。用户说把这个函数的 timeout 从 30 改成 60。模型 read 到内容（含回车），按习惯归一后发 edit，拿到 edit_not_unique，再试一次仍失败，改用 write 重写整个文件（纯换行）并成功。用户回到 IDE，git diff 显示整个文件每一行都变了。
FIX: 在 edit 里做行尾感知：读到 before 后探测主导行尾，匹配前把 oldText 与 newText 与文件内容放在同一行尾空间里比较，写回时把 newText 折成文件原来的行尾。write 同理，目标文件已存在且原本是 CRLF 时把模型给的纯换行内容折成 CRLF，新建文件保持纯换行。另外把 edit_not_unique 拆成两条错误码：真的多处命中，以及归一后能命中但原文不能，后者的文案直接说该文件使用 CRLF 行尾。测试可以在 Linux 上写：造一个 CRLF fixture，断言纯换行形式的 oldText 能命中且写回后仍是 CRLF。
REFUTER(CONFIRMED,low): 确定的代码事实成立，推断的损害链未能证实也未能排除，综合按 low。成立：tools/index.ts:380-390 `const start = content.indexOf(edit.oldText); if (start < 0 || content.indexOf(edit.oldText, start + 1) >= 0) throw new RuntimeHostError('edit_not_unique','oldText must match exactly once; file was not changed')`，全链路无行尾归一；write 在 :350 `await io.writeFile(target, Buffer.from(args.content))` 原样落盘；对照 :630 `const lines = Buffer.from(data.bytes).toString('utf8').split(/\r?\n/)` 证明 grep 已为 CRLF 修过（tools-17）而 edit/write 未跟上；read 侧 plugins/tools/read-lines.ts 无任何去 \r 处理，回车确实保留。测试缺口也属实：CRLF 相关用例只有 tools.test.ts:599-600（grep）与 skills.test.ts:177/534（frontmatter），edit/write 零覆盖。我尝试的反驳有两点值得记：其一，严格逐字复制 read 输出的模型是能命中的，`edit_not_unique` 在这种情形下是「诚实的失败」而非错判；其二，「模型退回整文件 write 从而把全文行尾改成 LF」这一步是行为推断，本仓无任何真实回合证据，Windows-P4-6-evidence/test12-reverify.md:748 只证明探针文件含 CRLF，没有证明模型真的这么退化。因此我把它降为 low（错误文案不提行尾 + 测试缺口 + 与 grep 的处理不一致），而把数据损坏那一段记为未证实。静态推断。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T012 行；docs/plantree/plans/runtime-hardening/decisions/002-remediation-order-and-waiver-rule.md；相关原文：「工具输出形状：……CRLF 去 `\r`……」

### [windows-06] LOW robustness confirmed-partial-waiver | P4-6 | src/runtime/plugins/session/writerLock.ts:128 | 会话写锁只靠 PID 存活判定陈旧，Windows 的 PID 复用会把一把死锁永久锁死；记了 acquiredAt 却从没人读（审查员原判 medium）（静态推断） → 并入 concurrency-02
DESC: stale 判定一把锁能不能接管，唯一依据是 processAlive(owner.pid)（:128），而 processAlive 就是 process.kill(pid, 0)（:65-73）。这在 Linux 上基本够用，因为 PID 空间大、回绕慢。Windows 不一样：PID 是 4 的倍数、从一个不大的池子里分配、进程退出后立刻可被复用，一台开着浏览器和 IDE 的机器 PID 在几分钟内就可能转一圈。后果是 worker 崩溃或被强杀留下 sidecar 锁，用户重开会话时 owner.pid 已被无关进程占用，processAlive 返回 true，stale 返回 false，抛 session_locked，用户只能手工删 writer.lock 文件或重启机器。模块开场注释说一把只测存在性的锁会永远拒绝这个会话，它用 PID 校验来避免这件事，但在 Windows 上 PID 校验本身就是不可靠的那一环。更直接的证据是这条记录里已经有一个能做年龄兜底的字段但没人读它：WriterLockOwner.acquiredAt（:30）由 acquireWriterLock 写入（:201）、由 parseOwner 解析（:89），全仓再无第二个读取点——这把锁是三天前留下的这个信息采集了、落盘了、解析了，却没参与任何判定。静态推断部分：PID 复用速率与实际撞上的概率要在 Windows 上观察；acquiredAt 无读取方是确定的代码事实。
EVIDENCE: src/runtime/plugins/session/writerLock.ts:124-129
function stale(held: LockFile): boolean {
  const owner = held.owner;
  if (owner === undefined) return true;
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  return !processAlive(owner.pid);
}

同文件 :65-73
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

同文件 :196-203（写入 acquiredAt，:89 解析，此后全仓无读取方）
  const claim = Buffer.from(
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token,
      acquiredAt: Date.now(),
    } satisfies WriterLockOwner)
  );
SCENARIO: Windows 上 AiClient 被任务管理器强杀，或因加密驱动崩溃（现场记录过 pnpm worker 被安全软件搞崩）。会话 A 的 writer.lock 留在盘上，记录 pid 为 15236。用户重开应用点开会话 A，此时 15236 已被浏览器的一个渲染进程占用。processAlive 返回 true，stale 返回 false，抛 session_locked 并显示那个 pid。会话 A 在这台机器上再也打不开，直到那个进程退出，或用户自己找到并删掉一个对他不可见的 sidecar 文件。
FIX: 在 stale 里把 acquiredAt 用起来，作为 PID 判定之外的第二条件：定义一个年龄上限（例如 24 小时），owner.acquiredAt 存在且已超过上限时直接判为陈旧。更严格的做法是把进程启动时间一起记进 sidecar（Windows 上可由 Get-Process 取，或退一步用 process.uptime 换算近似启动时刻），接管前比对 pid 加启动时刻，这样 PID 复用就不再构成误判。另外给 session_locked 的用户可见文案加一个强制接管出口。测试可以在 Linux 上写：伪造一份 acquiredAt 很旧、pid 指向当前进程的锁，断言可接管。
REFUTER(CONFIRMED-PARTIAL-WAIVER,low): 代码事实全部核实，但危害概率无法在此界定，故我给 low（审查员给 medium）。成立：session/writerLock.ts:124-129 `function stale(held) { ... return !processAlive(owner.pid); }` 是唯一的陈旧判据；:65-73 `processAlive` 就是 `process.kill(pid, 0)`，EPERM 记为存活；:190-221 acquireWriterLock 里 :216 `if (!stale(held)) throw locked(file, held.owner)`，无年龄兜底、无强制接管出口。死字段属实：`acquiredAt` 在 :30 声明、:89 解析、:201 写入，全仓 grep 只剩 __tests__/sessionWriterLock.test.ts:122 在造数据时用了一次，生产代码零读取点——这一条是确定的死代码。用户可见面也确实没人翻译：grep `session_locked` 在 src/main 与 src/renderer 零命中，只有 runtime 抛出点与四个测试断言。模块开场注释（:6-16）自陈这把锁存在的理由就是「只测存在性会永远拒绝这个会话」，而在 Windows 上 PID 校验本身是不可靠环节，这层自相矛盾成立。未能证实的部分：Windows PID 复用到底多快撞上、以及 worker 被强杀留下 sidecar 的频率，本仓无任何观测数据，我也无法在 Linux 上构造；且该风险并非 Windows 独有（Linux 同样可能复用，只是概率低）。综合按 low（死字段 + 健壮性缺口 + 无强制接管出口），若上机日能观察到一次误锁应升为 medium。静态推断。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings.json waivers[node=会话写入锁, kind=accepted-limitation]；原文：「不接管的两类：host 与本机不符（网络盘上的会话目录可能属于另一台机器）；锁内容无法读成一条 owner 记录以外的错误（EACCES 等直接抛出）」

### [windows-08] LOW docs confirmed | P1-8 | docs/plantree/plans/runtime-evolution/README.md:73 | P1-8 行仍断言 RUNTIME_CONFIG_VERSION 冻结在 runtime_p3_complete_v1，而 T028 已把它解冻
DESC: 任务树 P1-8 行是 T027 为 core-host-18 补的证据陈旧标注，里面有一句说 RUNTIME_CONFIG_VERSION 仍冻结在 runtime_p3_complete_v1、新旧 stamp 无法据此区分陈旧程度。这句话写的时候是对的，但 T028（a11ccbe0）已经把常量解冻为 runtime_p6_hardening_v1（src/runtime/bootstrap.ts:132）。加固计划的审计 README 第五节 P1-8 行已经同步了这件事，任务树这一行没有，同一份计划体系里两处互相矛盾。后果是实际的：上机日重采 P1-8 证据时，能不能用版本戳区分新旧 stamp 直接决定要不要手工比对提交号，而在只有安装包没有源码的机器上根本核不了提交号。另外这一行还说到本次复核的 HEAD 已隔 150 个提交、其中 21 个动过三处路径，而到 HEAD ebc82f16 我实测是 158 个提交、其中 24 个；这部分是快照性质的陈述不算错误，但重采时应按当前数字重写。
EVIDENCE: docs/plantree/plans/runtime-evolution/README.md:73 原文节选
现场证据已过期未重跑：test12-reverify.md 的 stamp 停在提交 8115ebe1，到本次复核的 HEAD（559c9790）已隔 150 个提交，其中 21 个动过 src/runtime/host、plugins/tools 或 bootstrap.ts；RUNTIME_CONFIG_VERSION 仍冻结在 runtime_p3_complete_v1，新旧 stamp 无法据此区分陈旧程度，六项探针尚未在当前代码上复跑（审计 core-host-18，T027 标注实况）

src/runtime/bootstrap.ts:132（当前实况）
export const RUNTIME_CONFIG_VERSION = 'runtime_p6_hardening_v1';

本机只读实测
git rev-list --count 8115ebe1..HEAD 得 158
git rev-list --count 8115ebe1..HEAD 限定 src/runtime/host 与 src/runtime/plugins/tools 与 src/runtime/bootstrap.ts 得 24
SCENARIO: 批次 E 上机日，执行人按任务树 P1-8 行准备重采计划，读到版本戳无法区分陈旧程度，于是放弃用 stamp.config_version 做新旧判据，改为人工核对 git_commit，多花时间，且在只有安装包没有源码的机器上根本核不了提交号。而实际上新采的 stamp 会带 runtime_p6_hardening_v1，一眼就能和旧的 runtime_p3_complete_v1 分开。
FIX: 把 P1-8 行里 RUNTIME_CONFIG_VERSION 那半句改写为：该常量已由 T028（a11ccbe0）解冻至 runtime_p6_hardening_v1，重采后的 stamp 可据此与旧证据分代。同时把 150 与 21 更新为按当前 HEAD 实测的 158 与 24，或改成不带具体数字的表述（证据钉在 8115ebe1，重采前先跑一次 git rev-list --count 确认差距），免得下次又过期。
REFUTER(CONFIRMED,low): 推翻失败，两处文档确实互相矛盾且陈述已被代码推翻。docs/plantree/plans/runtime-evolution/README.md:73 原文仍是「…到本次复核的 HEAD（`559c9790`）已隔 150 个提交，其中 21 个动过 `src/runtime/host`、`plugins/tools` 或 `bootstrap.ts`；`RUNTIME_CONFIG_VERSION` 仍冻结在 `runtime_p3_complete_v1`，新旧 stamp 无法据此区分陈旧程度…」。代码实况相反：src/runtime/bootstrap.ts:132 `export const RUNTIME_CONFIG_VERSION = 'runtime_p6_hardening_v1';`，且 :125-131 的 JSDoc 明确写了分代规则；`git log -S"runtime_p6_hardening_v1" -- src/runtime/bootstrap.ts` 只有一条 `a11ccbe0`，即 roadmap.md:41 记录的 T028。同一份计划体系的另一处已同步：docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md:93 写「RUNTIME_CONFIG_VERSION 已在 T028（`a11ccbe0`）解冻为 runtime_p6_hardening_v1，新旧证据今后可按版本戳分代」，与 README.md:73 直接冲突，任务树这一行是 T027（1b7c55fd）写下、T028 之后未回写。快照数字我也复算过：`git rev-list --count 8115ebe1..HEAD` = 158，限定三处路径 = 24，与审查员实测一致，文中的 150/21 是按旧 HEAD 559c9790 的快照，属陈旧而非笔误。注意该 README 页位于 runtime-evolution 计划下、不是 runtime-hardening（审查员描述里混称「加固计划的审计 README」，实际该审计 README 归档在 runtime-evolution/evidence 下，只是措辞不准，引文与行号都对）。严重级 low：纯文档不一致，影响的是批次 E 上机重采时的判据选择，不产生运行期错误。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T032 行；相关原文：「T032 | 上机检查单：合并旧树待现场项……与审计静态推断项（permissions-19、core-host-05/07、tools-10、cutover-03、P1-8 证据重采、P6-4 旧版产物互读）」

### [capacity-02] LOW capacity confirmed | P3-1 | src/runtime/plugins/agent-loop/index.ts:468 | trace 把每次工具调用的完整参数原文写入，唯一没有走预览截断模式的落盘点（审查员原判 medium）
DESC: tool_execution_start 触发时把 event.args（工具调用完整参数，write 工具 content 参数 schema 上限 8 MiB）整份塞入 trace.note('tool', {...})。同文件已有 MAX_TRACE_PREVIEW_CHARS=4000 用于审批预览，但工具参数没有复用这个截断。trace.note() 只是把 detail push 进内存 steps 数组，T024 新增的内存/文件上限只在 finish() 序列化整条 trace 时才生效，run 进行中的 steps 累积完全不设防。
EVIDENCE: src/runtime/plugins/agent-loop/index.ts:467-473：if (event.type === 'tool_execution_start') trace.note('tool', { event: event.type, tool_call_id: event.toolCallId, tool: event.toolName, args: event.args });
SCENARIO: 一次 run 中模型连续多次调用 write 工具写较大文件（单次 content 数百 KB 到几 MB），每次都把完整 content 塞入 steps 数组，finish() 之前不受 4 MiB 内存上限约束；finish() 后若单行超过 8 MiB 文件轮转阈值，按既定策略整行写入不截断，与同文件 4000 字符量级的预览截断先例不一致。
FIX: 给 trace.note('tool', ...) 的 args 字段复用已有的 truncatePreview()/MAX_TRACE_PREVIEW_CHARS 截断逻辑。
REFUTER(CONFIRMED,low): 代码事实成立，但「唯一」一词是错的，且默认配置下不落盘，故降到 low。核对：src/runtime/plugins/agent-loop/index.ts:467-473 确为 `if (event.type === 'tool_execution_start') trace.note('tool', { event: event.type, tool_call_id: event.toolCallId, tool: event.toolName, args: event.args });`，无截断；同文件 58 行 `const MAX_TRACE_PREVIEW_CHARS = 4000` 只用在 traceSafeActivity（61-70 行，审批活动的 preview）。trace.note 确实只往内存数组 push：trace.ts:139-146 `note(type, detail) { steps.push({ step: steps.length + 1, type, at: ..., detail }); }`；T024 的两道上限只在 finish 时生效 —— trace.ts:161-163 `const line = Buffer.from(...); sink.remember(trace, line.byteLength); await sink.persist(trace, line);`，remember()（trace.ts:186-203）还明文保证最新一条永不淘汰（`this._runs.length > 1 &&`），所以本 run 的大 args 必然留在内存。轮转也确实不截断：trace.ts:250-252 `// A line larger than the whole budget is still written whole`。反驳到的部分：`args` 不是唯一没走截断的落盘字段 —— index.ts:181 `trace.begin({ ..., input: prepared.text })` 写入用户提示全文（含最大 512 KiB 的文本附件），index.ts:195-197 `trace.note('note', { event: 'run_start', system_prompt: systemPrompt, ... })` 写入系统提示全文；tool_execution_end 的 `result`（index.ts:475-481）另有工具侧 50 KiB 预算兜着。影响面也有限：flags.ts:53 `traceDir: firstNonEmpty(env[RUNTIME_TRACE_DIR_ENV])` + bootstrap.ts:399-400，打包默认不设该变量 → dir 为 null，trace.ts:201 `if (!this.dir) return;` 直接不写盘，只剩内存里几 MB。属纵深防御与口径一致性缺口，无用户可见错误行为。未被修：trace.ts 最近一次改动即 T024 的 8564ba41，对账表第六节把这条明列为待落地。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md 第六节「待落地」表格第二行；docs/plantree/plans/runtime-hardening/roadmap.md T024 行；相关原文：「tool_execution_start 把工具参数全文写进 runs.jsonl | plugins/agent-loop/index.ts:432-437 | 同上。write 的 8 MiB 内容会整份进一行 trace，比 4 000 字符的审批预览大三个数量级；建议沿用 MAX_TRACE_PREVIEW_CHARS 的口径」

### [capacity-03] LOW capacity confirmed | P3-1 | src/runtime/plugins/context/index.ts:317 | 压缩摘要正文没有显式字节上限，唯一约束是模型 hardLimit 间接决定的事后检查（审查员原判 medium）
DESC: compact() 产出的 result.summary 没有任何显式字节/字符上限常量（不同于 tool 结果 50 KiB、diff 64 KiB、MCP 文本 50 KiB 这些有名有姓的常量）。唯一约束是摘要生成之后，把 candidate 估算 token 数与 budget.hardLimit 比较，超过才 giveUp 不落盘；没超过就直接 session.appendCompaction(result)。摘要能有多大完全由 provider 单次输出上限和当前模型上下文窗口间接决定，没有与模型无关的硬字节顶。
EVIDENCE: src/runtime/plugins/context/index.ts:317-345：const summarized = await this.summarize(...); ... if (estimateContextTokens(candidate).tokens + (request.additionalTokens ?? 0) >= budget.hardLimit) return this.giveUp(...); const persisted = session ? await session.appendCompaction(result) : undefined;
SCENARIO: 配置大上下文窗口模型（显著大于常见 128K-200K 档位）时，一次压缩可能产出远大于其它落盘来源量级的摘要正文，作为单条 compaction 记录写入会话文件，消耗远超预期的会话预算份额，且与其它所有落盘来源都有具体字节常量这一既有模式不一致。
FIX: 为 result.summary 补一道与模型无关的独立字节上限（如 MAX_COMPACTION_SUMMARY_BYTES），超限时走既有 giveUp('compaction_over_budget', ...) 分支。
REFUTER(CONFIRMED,low): 「无显式字节常量」属实，但「可能产出远大于其它落盘来源量级的摘要」是夸大，故降到 low。核对 src/runtime/plugins/context/index.ts:320 `const summarized = await this.summarize(bounded.preparation, request);`、331-333 `if (estimateContextTokens(candidate).tokens + (request.additionalTokens ?? 0) >= budget.hardLimit)` → giveUp('compaction_over_budget')、345 `const persisted = session ? await session.appendCompaction(result) : undefined;`——确实没有任何 MAX_*_BYTES 常量，事后 token 检查是唯一闸门，与 MCP 50 KiB、工具 50 KiB 这些有名常量的模式不一致，这点成立。但输出侧并非「只靠 provider 心情」：src/runtime/node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js:388 `const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);` 直接作为 provider 的 maxTokens 下发，而 reserveTokens 又由 budget.ts:124-133 的 `modelOutputBudget = min(model.maxTokens||DEFAULT, floor(contextWindow*0.25))` 收着。即便 1M 窗口模型，摘要也就是几十万 token 量级（数百 KB），要顶满 32 MiB 需要上百次压缩，且每次压缩本身就在回收上下文。属纵深防御缺口，无可构造的用户可见失败。未被修：T024 对账表第六节原文把 `plugins/context/index.ts:347` 列为待落地（context 插件不在 T024 可改范围）。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md 第六节「待落地」表格第三行及正文第64行；docs/plantree/plans/runtime-hardening/roadmap.md T024 行；相关原文：「compaction 摘要正文无上限 | plugins/context/index.ts:347 | context 插件不在本任务可改范围。输入侧已有 summaryInputBudget，输出侧只靠 provider 的 maxTokens」

### [capacity-04] LOW capacity confirmed | P3-1 | src/runtime/plugins/session/store.ts:290 | 会话文件缺少单行最大字节安全网，只有聚合字节检查
DESC: appendEntry() 的写入前检查是 this.bytes + bytes > this.maxBytes，只保证写完不超预算，不限制单次写入本身能有多大。文件字节数较小时（新会话，或 /compact 后体积回落），单独一行理论上可逼近整个 32 MiB 预算。对账表第六节已列为待落地，本次复核确认当前 HEAD 依旧如此，且它是 capacity-01 最坏后果的放大器。
EVIDENCE: src/runtime/plugins/session/store.ts:288-295：const bytes = Buffer.byteLength(line); if (this.bytes + bytes > this.maxBytes) throw new RuntimeHostError('session_size_limit', ...);
SCENARIO: 若补上单行上限，capacity-01 描述的最坏路径会被提前拦在更早一步：用户会在发送时立刻收到「这条消息太大」的拒绝，而不是若干条消息之后才发现整个会话打不开。
FIX: 在 appendEntry 检查里追加独立单行上限（如 SESSION_MAX_ENTRY_BYTES，建议明显小于 32 MiB，如 4~8 MiB），与聚合检查并列执行。
REFUTER(CONFIRMED,low): 代码原文逐字属实，当前 HEAD 依旧只有聚合检查：src/runtime/plugins/session/store.ts:288-295 `const line = ...; const bytes = Buffer.byteLength(line); if (this.bytes + bytes > this.maxBytes) throw new RuntimeHostError('session_size_limit', 'session exceeds the configured size budget');`；另两处写入（store.ts:499 fork 全量、store.ts:561 mutate 行）同样只比聚合值，没有任何单行常量（grep `SESSION_MAX` 在 runtime 下只有 codec.ts:20 的 32 MiB 一个）。这条本身不构成独立故障——它是兜底而非缺陷路径，缺的是「未来某个新来源忘了限额」时的最后一道拦网，对账表第六节自己也写「有了以上各条上限后是冗余防线……建议作为独立小任务评估」。审查员给的 low 与我一致。未被批次 A～C 落地：git log 该文件无相关改动，T024 提交 8564ba41 只动了 trace.ts 与 mcp/index.ts。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md 第六节「待落地」表格第四行及正文第47行；docs/plantree/plans/runtime-hardening/roadmap.md T024 行；相关原文：「会话文件缺「单行最大字节」 | plugins/session/store.ts:288-295 | 有了以上各条上限后是冗余防线；但它是唯一能挡住「未来某个新来源忘了限额」的兜底。建议作为独立小任务评估」

### [capacity-05] LOW concurrency confirmed | P3-1 | src/runtime/trace.ts:81 | 多个 worker 进程共享同一 traceDir 时，runs.jsonl 的轮转没有跨进程互斥（审查员原判 medium）（静态推断） → 并入 concurrency-03
DESC: TracePlugin 的写入串行化（private pending 字段）只在单进程内有效；每个 worker 是独立进程，各有自己的 TracePlugin 实例。traceDir 默认取单一环境变量 AICLIENT_RUNTIME_TRACE_DIR，不按会话/进程分子路径，目标文件名固定 runs.jsonl。该变量被手工设置后（打包默认不设置，仅开发调试场景），同时打开的多个会话窗口对应的多个 worker 进程会全部向同一文件追加/轮转，rotate() 的读盘判断没有跨进程锁。
EVIDENCE: src/runtime/trace.ts:81：private pending: Promise<void> = Promise.resolve()；src/runtime/flags.ts:52-53：traceDir: firstNonEmpty(env[RUNTIME_TRACE_DIR_ENV])；src/runtime/trace.ts:244-249：rotate() 基于 this.size(path) 的磁盘 stat 判断是否需要 rename 链，无跨进程互斥
SCENARIO: 开发者为排查问题设置 AICLIENT_RUNTIME_TRACE_DIR 后同时打开两个会话窗口（两个独立 worker 进程）。两进程的 finish() 前后脚调用 persist()，各自 stat 到相同旧 size 并都判定需要轮转，对同一组文件名各执行一次 rename 链；按代码逻辑推断最坏情况是多轮转一次、丢一代历史（不损坏正在写的文件），但未用两个真实进程构造过这一交织去验证是否还有更细的交织（如 append 恰好落在 rename 窗口内）。
FIX: 给每个 worker 的 traceDir 加进程级子路径（按 sessionId/pid），或给 rotate() 加跨进程文件锁（复用会话 store 已有的写锁机制）；若判定当前优先级不修，至少在 flags.ts/trace.ts 注释里显式记录这条已知限制。
REFUTER(CONFIRMED,low): 静态推断成立，但影响只限调试产物，故从 medium 降到 low。引用核对无误：trace.ts:81 `private pending: Promise<void> = Promise.resolve();`（进程内串行化）；flags.ts:53 `traceDir: firstNonEmpty(env[RUNTIME_TRACE_DIR_ENV])`，bootstrap.ts:399-400 直接用该目录、trace.ts:203 `const path = join(dir, 'runs.jsonl')`，不按会话或 pid 分子路径；rotate()（trace.ts:244-262）`const size = await this.size(path); ... if (size === 0 || size + incoming <= this.maxFileBytes) return undefined; ... for (let index = this.fileGenerations; index >= 1; index--) await this.move(from, join(dir, \`runs.${index}.jsonl\`))`，判断源是磁盘 stat，无任何跨进程锁（会话侧有 writerLock.ts，trace 侧没有对应物）。worker 确为独立进程：PiWorkerProcess.ts:94 `utilityProcess.fork(entryPath, [], {...})`，每进程各有一个 TracePlugin 实例，环境变量随父进程继承。可达性比审查员说的更高一点：本仓自己的取证脚本就会造出这个场景 —— Windows-P4-6-evidence/launch-gui-a-e.ps1:19 `$env:AICLIENT_RUNTIME_TRACE_DIR = $trace` 后跑 A~E 五个 GUI 场景。但后果只到「多轮转一次、丢一代 trace 历史」或「append 落进刚被 rename 的文件」，用户数据与会话文件不受影响（appendFile 按路径打开，写入内容不丢，只是进了 runs.1.jsonl）。未被修：trace.ts 最近改动即 T024（8564ba41），对账表第六节与 roadmap.md:101 把这条明确归给尚未派工的 T031。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/evidence/capacity-reconciliation-2026-09-15.md 第六节「待落地」表格第五行；docs/plantree/plans/runtime-hardening/roadmap.md T024 行、T031 行；相关原文：「多个 worker 同时向同一 traceDir 追加 / 轮转 runs.jsonl | trace.ts | 批评者「并发多会话」缺口，归 T031。本波的轮转用 rename 实现，并发下两个进程可能各自判定要轮转，结果是多轮转一次（丢一代历史），不会损坏正在写的文件」

### [tsd-01] LOW contract-gap confirmed-partial-waiver | P1-0 / P1-8 | src/runtime/host/worker.ts:82 | TSD 回落只在不可能命中的平台上启用，在唯一有密文的平台上按设计关闭，整条链路无出厂触发路径（审查员原判 medium）（静态推断）
DESC: 三段接线合起来决定了回落永远跑不到。(1) PiWorkerProcess.ts:79 —— `app.isPackaged && win32` 时 worker 由 resources/node-runtime/node.exe 直接 spawn 走 Node IPC，于是 agent-host/worker.ts:52 推出的 carrier 是 bundled-node；(2) host/worker.ts:66 —— bundled-node 硬编码 `tsdReadFallback: 'disabled'`；(3) host/worker.ts:82 —— electron-utility 只有在 resources/node-runtime/ 存在时才给 configured-node，而 afterPack.mjs 的 copyNodeRuntime 按 pin 表给 win32/darwin/linux 三平台都装了随包 Node，所以打包 macOS/Linux 会开启回落，未打包开发态（Electron 的 resourcesPath 下没有 node-runtime）则关闭。结论：开启回落的形态里没有加密驱动，`%TSD-Header-###%` 不会出现在文件头；有密文的形态里回落是关的。`RuntimeReadResult.source === 'node-fallback'` 因此在产品里从不产生，tsd-read.mjs 整个文件、io.ts:140-168、以及 T013 给 read-lines.ts:111 加的 node-fallback 分支都只被单元测试执行。bundled-node 不需要回落的推理本身是成立的（同一个二进制再 spawn 一次只会重复同一次失败），问题是：随包 node.exe 一旦不在白名单内（换驱动厂商、改按签名放行、企业改策略），Windows GUI 会以 io_tsd_unavailable 硬失败，而仓里躺着一套从未在现场跑过的回落实现帮不上忙；同时批次 E 上加密机那天没有任何产品操作能触发这条路径去验证它。static_inference：是，判据是三段代码 + 打包脚本的组合，未在 Windows/加密机上执行；2026-09-09 的现场证据（随包 node 在白名单内、读到明文）与该判断一致。
EVIDENCE: src/runtime/host/worker.ts:60-83
  if (input.carrier === 'bundled-node') { ... node: { path: execPath, source: 'bundled' },
      // This carrier exists precisely because the security driver whitelists
      // this binary: ... could only repeat the failure with a worse message.
      tsdReadFallback: 'disabled', }
  const bundled = input.resourcesPath ? bundledNodePath(input.resourcesPath, platform) : undefined;
  const node = bundled && existsSync(bundled) ? { path: bundled, source: 'bundled' as const } : undefined;
  return { ...base, carrier: 'electron-utility', ...(node ? { node } : {}), tsdReadFallback: node ? 'configured-node' : 'disabled' };

src/main/services/agent-host/PiWorkerProcess.ts:79-92
  if (app.isPackaged && process.platform === 'win32') {
    const nodePath = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
    const processHandle = spawn(nodePath, [entryPath], { ... stdio: ['ignore','pipe','pipe','ipc'] });
    return { process: processHandle, transport: createNodeProcessWorkerTransport(processHandle) };
SCENARIO: 加密机（Windows 安装版）上驱动不再放行随包 node.exe（换版本、换厂商、按签名放行、或安装目录变了）。worker 是 bundled-node，io.ts:113 探头命中魔数，io.ts:134 判 `tsdReadFallback !== 'configured-node'` 直接抛 io_tsd_unavailable，模型每次 read 都拿到「TSD read requires configured Node」，edit / grep 一并失败，而能工作的 helper 不会被调用。反过来，在批次 E 的加密机上想验证 helper 契约也没有任何产品操作能让它跑起来——必须临时改配置才能触发，那验的就不是出厂形态。
FIX: 三件分开做：(a) 把「configured-node 目前没有出厂载体」写进 p1-0 契约第 3 节与 P1-8 验收口径，避免后来者以为现场验过；(b) 给 bundled-node 加可诊断而非可回落的路径——命中魔数时的错误里带上 node_exec_path 与 carrier，并在 trace 落一个 tsd_head_hit 计数，现场一眼能分清「白名单失效」与「文件本来就读不了」；(c) 若要让回落在 Windows 上真的可用，只能引入与 worker 不同身份的解密进程（Main 侧 tsdSafeRead.ts 已是这个形态），此时必须连带修 tsd-04，否则回落一开就带着静默污染风险。
REFUTER(CONFIRMED-PARTIAL-WAIVER,low): 三段接线逐字复核成立，未被任何批次修改。src/runtime/host/worker.ts:60-66 的 bundled-node 分支硬写 `tsdReadFallback: 'disabled'`（注释原文：'This carrier exists precisely because the security driver whitelists this binary'）；:78-82 的 electron-utility 分支是 `const node = bundled && existsSync(bundled) ? {...} : undefined;` 与 `tsdReadFallback: node ? 'configured-node' : 'disabled'`。载体推导在 src/agent-host/worker.ts:52 `const carrier = electronPort ? 'electron-utility' : 'bundled-node'`，而 src/main/services/agent-host/PiWorkerProcess.ts:79-92 `if (app.isPackaged && process.platform === 'win32')` 用 `spawn(nodePath, [entryPath], { stdio: ['ignore','pipe','pipe','ipc'] })`，没有 parentPort→bundled-node。打包脚本侧 scripts/node-runtime-pin.mjs 的 NODE_RUNTIME_PINS 含 win32-x64 / darwin-arm64 / darwin-x64 / linux-x64，scripts/afterPack.mjs:78-103 copyNodeRuntime 按 pin 装，故打包 mac/Linux 得 configured-node、未打包开发态（Electron resourcesPath 下无 node-runtime）得 disabled。git log -S 未见任何批次改过这两处（workerCarrier.test.ts:35-70 四条断言正是把当前行为钉死的）。我另找到一条把结论钉得更死的证据：src/runtime/host/tsd-read.mjs 在 `if (first.bytesRead === head.length && head.equals(magic)) throw new Error('configured Node still reads TSD ciphertext')`，而 io.ts:113-134 只在命中魔数时才调 helper——所以在没有解密驱动的机器上 `source: 'node-fallback'` 的成功返回物理上不可能发生，dead-path 判断比审查员写的更强。静态推断（三段代码 + 打包脚本组合，未在 Windows/加密机执行）。严重级我从 medium 下调为 low：按本次评级口径这属于死代码 + 契约/验收口径缺口（docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md:58-59 只写 '配置本身不能证明企业驱动已放行'，没写'当前无出厂载体会给出 configured-node'），当前出厂形态下没有任何用户可见的错误行为，审查员的失败场景依赖'白名单失效'这一尚未发生的环境变化。补充：roadmap.md:107 的 T032 已把 'tools-10、P1-8 证据重采、core-host-05/07 等静态推断项'列为待现场项，这条与之同源但未被具体记下。
WAIVER(partial): 部分取舍，保留计入 — 来源：docs/plans/2026-09-08-runtime-evolution-ard.md D11「执行载体：按进程身份区分，不按实现语言推断」；另见 findings.json waivers[43]（node P1-0，kind field-only，source: docs/plantree/plans/runtime-evolution/evidence/p1/README.md 仍需完成的载体验收 第3条）；原文：「企业加密驱动（TEC OCular Agent）按进程放行明文，打包出的 Electron exe 不在白名单里，因此读到的是密文……所以兼容性是执行载体的属性，不是实现语言的属性。| bundled-node | Windows 安装版 | 随包 node.exe + Node 原生 IPC |（另：waivers[43] 原文「企业加密机验证 Read 明文、Write/Edit 回读、bash stdout 及退出后无残留，本机无法执行」）」

### [tsd-04] LOW correctness confirmed | P1-0 | src/runtime/host/io.ts:148 | helper 的 stdout 是无框字节协议，而子进程环境整份继承：一条 stdout 启动噪声会把文件内容悄悄改写（静态推断）
DESC: T013 把 stderr 预算独立出去，解决了「噪声吃掉输出额度」这半边；另一半没动——helper 的 stdout 里只有明文、没有任何框，io.ts 拿到多少字节就当多少字节的文件内容返回（io.ts:168）。同时子进程环境是整份父进程环境：workerHost 用 Object.entries(env) 全量拷进 childEnv（host/worker.ts:66-69），commandEnvironment（exec.ts:419）只改 PATH，不剔除 NODE_OPTIONS。契约第 4 节自己点名了「NODE_OPTIONS、企业预载脚本」这个威胁模型，但结论只写到「不能把一次成功读取变成失败」，没覆盖「不能把一次读取变成错误的内容」。于是：预载脚本往 stderr 打字已被 4 KiB 独立预算挡住（已修，T013）；往 stdout 打一个字节则要么被当成文件开头的内容返回给模型（静默错误），要么把总量顶过 maxBytes+1 触发 terminate 变成 io_tsd_unreadable（把能读的文件报成读不了）。严重级定 low 的唯一理由是 tsd-01：这条路径当前没有出厂触发形态；一旦按 tsd-01 的 (c) 把回落接到 Windows 上，这条立刻是数据正确性问题，必须同批修。static_inference：是。
EVIDENCE: src/runtime/host/io.ts:140-152
      const output = await this.ctx.runtimeExec.run({
        command: this.config.node.path,
        args: [tsdHelper(), path, String(offset), String(options.maxBytes + 1)],
        cwd: dirname(path),
        timeoutMs: TSD_READ_TIMEOUT_MS,
        maxOutputBytes: options.maxBytes + 1,
        maxStderrBytes: TSD_STDERR_BYTES,
        overflow: 'terminate',
        signal,
      });

src/runtime/host/worker.ts:66-69（childEnv 全量继承，未剔除 NODE_OPTIONS）
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
SCENARIO: 企业机器的系统环境里设了 NODE_OPTIONS=--import /opt/corp/telemetry.mjs，而该脚本初始化时 console.log('[corp] telemetry ready')。helper 继承了这个变量，19 个字节先于明文写进 stdout。io.ts 没有办法区分它和文件内容，模型读到的 config.json 开头多了一行；read 显示的行号、edit 的唯一匹配、readBeforeChange 的 diff 全部基于这份被污染的内容。如果这次 read 恰好满窗口，多出来的字节顶破 maxBytes+1，overflow:'terminate' 生效，一个完全正常的文件被报成 io_tsd_unreadable。
FIX: (a) 给 helper 专用一份最小环境：spawn 时删掉 NODE_OPTIONS、NODE_REPL_EXTERNAL_MODULE、NODE_V8_COVERAGE 并加 --no-warnings（io.ts 调用点用 `env: { NODE_OPTIONS: undefined }` 即可，commandEnvironment 已支持 undefined 删键）。(b) 给 stdout 加一层极薄的框以便自检：helper 先写固定 8 字节魔数 + 4 字节长度，io.ts 校验后剥掉——这与契约「stdout 保持原始字节」不冲突（那句约束的是不要转换载荷），是唯一能把噪声与内容区分开的办法。若不做框，至少做 (a) 并在契约里明写「stdout 上的任何额外输出都会被当成文件内容」。
REFUTER(CONFIRMED,low): 两个前提都成立。(1) 无框协议：src/runtime/host/io.ts:140-150 调 helper 时只给 `args: [tsdHelper(), path, String(offset), String(options.maxBytes + 1)]`，**没有传 env**；:168 `return readResult(Buffer.from(output.stdout), options, 'node-fallback');` 直接把 stdout 全量当文件内容。helper 侧 src/runtime/host/tsd-read.mjs 也只有 `process.stdout.write(data)`，无任何帧头。(2) 环境整份继承：src/runtime/host/worker.ts:38-40 `const childEnv = Object.fromEntries(Object.entries(env).filter(...))`，src/runtime/host/exec.ts:415-436 commandEnvironment 只重写 PATH（`env.PATH = config.node ? [dirname(config.node.path), previous].join(delimiter) : previous`），全仓 `grep -rn NODE_OPTIONS src scripts` 除 host.test.ts:167 的注释外零命中，确实不剔除。契约缺口也属实：p1-0 第 4 节 docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md:204-206 只写到独立 stderr 预算使启动告警『不能把一次成功读取变成失败』，:129 写『业务报错写 stderr，stdout 保持原始字节』，没有一句覆盖『stdout 上的额外输出会被当成文件内容』。静态推断。严重级维持 low，理由比审查员给的更强：如 tsd-01 所述，helper 只有在文件头对它已是明文时才会成功输出，而那要求解密驱动放行——在当前出厂形态里 configured-node 与解密驱动不同时存在，所以污染路径当前不可达，是纯潜伏缺陷；一旦按 tsd-01 的 (c) 把回落接到 Windows，它立刻升为数据正确性问题。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T013 行；docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md 第129行；相关原文：「T013 取舍：……stderr 预算放 exec 而非 HostIo 自收；明文路径保持 32 KiB；helper 顺序读语义未动。真实加密机链路仍未跑。（契约：helper 的路径不得拼进脚本文本或 shell 命令；业务报错写 stderr，stdout 保持原始字节）」

### [tsd-05] LOW perf confirmed | P1-2 | src/runtime/plugins/tools/read-lines.ts:52 | 块大小封顶 2 MiB 之后重读量重新变成二次，注释与落地记录的「约线性」不成立（静态推断）
DESC: read-lines.ts:112 的 `chunkBytes = Math.min(Math.max(chunkBytes * 2, maxBytes), FALLBACK_CHUNK_MAX_BYTES)` 在触到 2 MiB 封顶前是几何增长（这段确实把总重读量压成 O(n)），但封顶之后每一块都要让 helper 从文件头重读一次前缀，重新变成等差和，即 O(n²/(2·cap))。按扫描上限 64 MiB 实算（我用 node 跑了这段循环的算术，不是执行产品代码）：38 次 readFile、约 1121 MiB 的解密重读量，而线性下限是 64 MiB，仍有 17.5 倍放大；每次 readFile 在 pipe 模式下还是两个进程（exec-runner.mjs + helper），即约 76 次进程创建。对照修前（固定 32 KiB）是 2048 次调用、约 64 GiB，所以 T013 确实改善了约 60 倍——但 read-lines.ts:50 的注释「keeps both roughly linear in the bytes actually scanned」与 roadmap T013 行的「总重读量 O(n²)→约线性、进程创建上百次→个位数」，在 4 MiB 以上都不准确（4 MiB：8 次调用、11.7 MiB 重读，此时才接近说法）。现有用例 tools.test.ts:654 用 1 MB 样本、断言 windows.length ≤ 6，正好落在封顶生效之前，这段回归没有守护。严重级 low：tsd-01 决定了这条路径当前在产品里不可达，且即使可达也只是慢，不是错。
EVIDENCE: src/runtime/plugins/tools/read-lines.ts:45-52
/**
 * tools-10 — ... Doubling the window after each fallback chunk keeps both
 * roughly linear in the bytes actually scanned; the cap bounds what a single
 * step may buffer.
 */
const FALLBACK_CHUNK_MAX_BYTES = 2 * 1024 * 1024;

src/runtime/plugins/tools/read-lines.ts:111-112
    if (chunk.source === 'node-fallback')
      chunkBytes = Math.min(Math.max(chunkBytes * 2, maxBytes), FALLBACK_CHUNK_MAX_BYTES);
SCENARIO: 加密机上对一个 40 MiB 的受策略日志执行 read {path:'app.log', offset: 400000}。扫描要走完 40 MiB，封顶后每块 2 MiB，约 25 次 readFile、约 50 个进程、约 500 MiB 的驱动解密读取，每块各自带 30 秒预算——单次 read 从毫秒级变成分钟级，50 次进程创建全落在企业安全软件的监控上。
FIX: 代码不必再改（再放大块大小会顶到内存），但要把话说准：把 read-lines.ts:50 的注释改为「封顶前几何增长、封顶后按 cap 线性分块，总重读量相对线性有 n/(2·cap) 倍放大」，并在 roadmap T013 行补一句实测量级。若确实要修，唯一有效的方向是让 HostIo 暴露「一次回落读取跨多块复用」的接口（例如 helper 一次性输出到临时明文文件再由 worker 顺序读），属于新能力应单立任务。补一条用例：样本放大到 >8 MiB，断言 windows 触顶后恒为 2 MiB 且调用次数落在 ceil(n/2MiB)+6 内。
REFUTER(CONFIRMED,low): 算术可复现，注释与落地记录确有过头之处。src/runtime/plugins/tools/read-lines.ts:45-52 注释原文『Doubling the window after each fallback chunk keeps both roughly linear in the bytes actually scanned; the cap bounds what a single step may buffer.』，紧接 `const FALLBACK_CHUNK_MAX_BYTES = 2 * 1024 * 1024;`；:111-112 `if (chunk.source === 'node-fallback') chunkBytes = Math.min(Math.max(chunkBytes * 2, maxBytes), FALLBACK_CHUNK_MAX_BYTES);`；扫描上限是 :96 `while (position < 64 * 1024 * 1024)`。helper 每次从头解密（tsd-read.mjs 顺序读并 skip offset，无句柄复用），故封顶后每块付 offset+cap，是等差和。我用 node 单跑这段纯算术（不执行产品代码，maxBytes 取 TOOL_OUTPUT_BYTES=50 KiB 量级）得 **38 次 readFile、约 1121 MiB 重读**，与审查员数字逐位一致，相对 64 MiB 线性下限放大 17.5 倍。roadmap.md:33 的 T013 行写『总重读量 O(n²)→约线性、进程创建上百次→个位数』，在封顶生效后不成立。回归确实不守护封顶后的形态：tools.test.ts:634-636 样本是 `LINE_BYTES=200 × LINES=5000` 约 1 MB，:667 断言 `helper.windows.length` ≤ 6、:669 `Math.max(...helper.windows) <= 2*1024*1024`，全落在触顶之前。静态推断。严重级维持 low：注释/记录不符 + 性能，且按 tsd-01 该路径当前在产品里不可达，慢而不错。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-hardening/roadmap.md T013 行；相关原文：「readLines 在 node-fallback 下扫描块几何倍增（首块 32 KiB，下限对齐输出预算，封顶 2 MiB），总重读量 O(n²)→约线性、进程创建上百次→个位数……取舍：块大小几何倍增而非固定放大（固定倍数仍是 O(n²)）」

### [tsd-06] LOW test-gap confirmed-partial-waiver | P1-8 / P4-0 | src/runtime/smoke/p1-utility-worker.ts:10 | utility 载体探针不走产品路径推导，且它的 carrier 断言是同义反复
DESC: 批评者缺口 14 指出的两件事在 HEAD 上一件都没变。(1) 探针自己手写 host 配置：carrier:'electron-utility'、node:{path:nodePath, source:'explicit'}、tsdReadFallback:'disabled'，而产品里这三项是 workerHost({carrier, resourcesPath}) 推导出来的（agent-host/worker.ts:93），推导结果应当是 source:'bundled' 且 tsdReadFallback:'configured-node'。探针跑绿不能证明推导正确。(2) p1-host-tools.ts:49 的 `trace.version_stamp.carrier === host.carrier` 是拿 bootstrap.ts:449 从同一个 host 对象抄进版本戳的值去比这个对象——恒真，即探针跑在错误的载体上也会 passed:true；报告里带了能证伪的原料（execPath、process.versions.electron）却没有一条断言用它们。另外全仓唯一的真实子进程端到端用例 workerEntryWiring.test.ts 用的是 fork()（Node IPC，即 bundled-node 形状），utilityProcess 半边只有 workerCarrier.test.ts 这种纯函数替身。
EVIDENCE: src/runtime/smoke/p1-utility-worker.ts:7-15
  const result = await runHostToolsProbe(
    {
      carrier: 'electron-utility',
      node: { path: nodePath, source: 'explicit' },
      tsdReadFallback: 'disabled',

src/runtime/smoke/p1-host-tools.ts:49
      trace: run.trace.version_stamp.carrier === host.carrier && !run.trace.persistence_error,

src/runtime/bootstrap.ts:449（版本戳的来源就是同一个 host 对象）
        carrier: host.carrier,
SCENARIO: 有人改坏 workerHost 的 electron-utility 分支，workerCarrier.test.ts 会红——这条守住了；但如果改坏的是 agent-host/worker.ts:52 的 carrier 推导或 resourcesPath 的取法（例如打包后 process.resourcesPath 变形、或推导写反），两个探针与全部单测照常绿，因为探针根本不调用这两段。P1-8 的「两载体六项断言通过」因此只覆盖了「在手写配置下工具能跑」，没覆盖「产品会不会给出这份配置」。
FIX: (a) 把 p1-utility-worker.ts 改成 workerHost({ carrier:'electron-utility', resourcesPath: process.resourcesPath })，缺随包 Node 时明确失败而不是退成 explicit；(b) 把 p1-host-tools.ts 的 carrier 断言换成可证伪的：electron-utility 下断言 process.versions.electron 非空且 host.node.source==='bundled'、host.node.path !== process.execPath，bundled-node 下断言 process.versions.electron 为空且 host.node.path === process.execPath；(c) 给 utilityProcess 半边补一条可在有 Electron 的机器上跑的集成用例（沿用 electron-carrier.cjs 形态），至少断言一次 bootstrap 往返与一次 dispose 干净退出。
REFUTER(CONFIRMED-PARTIAL-WAIVER,low): 两件事在 HEAD 上一件都没变。(1) src/runtime/smoke/p1-utility-worker.ts:7-16 原文 `runHostToolsProbe({ carrier: 'electron-utility', node: { path: nodePath, source: 'explicit' }, tsdReadFallback: 'disabled', exec: { mode: 'pipe' }, childEnv: { PATH: ... }, cleanupTimeoutMs: 2000 }, cwd, shellPath)` —— 手写常量，不经 workerHost；产品路径 src/agent-host/worker.ts:93 是 `const host = workerHost({ carrier, ...(resourcesPath ? { resourcesPath } : {}) })`，推导结果应是 `source: 'bundled'` + `configured-node`（contracts.ts:366 的联合类型 `'bundled' | 'explicit' | 'current-process'` 里 explicit 是另一支）。p1-bundled-node.ts:20-31 同样手写。(2) 同义反复属实：src/runtime/smoke/p1-host-tools.ts:49 `trace: run.trace.version_stamp.carrier === host.carrier && !run.trace.persistence_error`，而版本戳的来源就是同一对象——src/runtime/bootstrap.ts:449 `carrier: host.carrier`（同段 :452 `tsd_read_fallback: host.tsdReadFallback`、:454 `node_source: host.node.source` 同理），故该断言恒真；报告里 :55-58 已带 `execPath` / `electron: process.versions.electron ?? null` 却无一条断言用它们。这正撞上契约的明文要求：docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md:302 P1-8 验收原文『真 bundled-node 与真 electron-utility 各跑工具用例……仅修改 carrier 字符串的替身不计通过』。utilityProcess 半边确无真子进程用例（workerCarrier.test.ts 全是纯函数断言；真子进程端到端的 agent-host/__tests__/workerEntryWiring.test.ts:83/131/187 用 fork + `proc.stdout?.resume()`，即 Node IPC 形状）。严重级维持 low（测试缺口）。附注：roadmap.md:107 的 T032 已把『P1-8 证据重采』列入上机检查单，属同源但未落到这两条具体断言上，不构成已修。
WAIVER(partial): 部分取舍，保留计入 — 来源：findings.json waivers[64]（node P1-8，kind 未标注，source: docs/plantree/plans/runtime-evolution/README.md P1-8 行）；原文：「Windows/加密机现场验收攒到 P4-6 一次上机，不分批；签收前一律记为进行中/未验收，Linux 与 CI 的绿色不得代签」

### [tsd-07] LOW correctness confirmed | P1-2 | src/runtime/host/io.ts:115 | 首 16 字节恰为 TSD 魔数的明文文件，在所有载体上都读不出来且没有任何出口
DESC: 回落判定的唯一依据是文件前 16 字节是否等于 `%TSD-Header-###%`（io.ts:113-115），没有第二个判据（没有容器长度校验、没有 stat 形态校验），也没有任何「其实是明文」的逃生出口。一个合法的明文文件只要以这串字符开头就会被判成密文：tsdReadFallback:'disabled' 的载体（Windows 安装版、所有开发态）抛 io_tsd_unavailable；configured-node 的载体（打包 macOS/Linux）把它交给 helper，helper 在 tsd-read.mjs:23-24 再验一次头、看到同一串魔数就抛 'configured Node still reads TSD ciphertext'，回到 io.ts 变成 io_tsd_unreadable。也就是说这类文件在任何出厂形态下都读不了，错误信息还把它说成加密文件。这类文件不是臆造：描述该机制的文档、测试夹具、排查时抓的样本都可能以它开头。叠加 tsd-02，工作区里出现一个这样的文件会让整棵树的 grep 失败。
EVIDENCE: src/runtime/host/io.ts:113-115
        const head = Buffer.alloc(TSD_MAGIC.length);
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        encrypted = bytesRead === head.length && head.equals(TSD_MAGIC);

src/runtime/host/tsd-read.mjs:22-24
    const first = await file.read(head, 0, head.length, null);
    if (first.bytesRead === head.length && head.equals(magic))
      throw new Error('configured Node still reads TSD ciphertext');
SCENARIO: 有人在工作区放一份 tsd-sample.txt，第一行就是 `%TSD-Header-###%`（排查加密问题时抓的样本，或一份以它开头的说明）。模型 read 它 → io_tsd_unavailable: TSD read requires configured Node；edit 它 → 同样；grep 整棵树 → 整次失败（tsd-02）。用户看到的是「这个文件被加密了」，而它就是一份普通文本。
FIX: 魔数命中后加一个廉价的二次判据再决定走回落：例如要求文件大小是容器块大小的整数倍（D13 现场记录的容器是 8192 字节的整数倍，encryption-special.md 记的样本是 20480 / 45056），或要求紧随魔数之后的若干字节符合容器头形态；不满足就按明文继续读。至少要把错误文案改成可自救的说法（「前 16 字节与 TSD 容器头一致；若这是普通文本文件，请确认…」），并把 io_tsd_* 纳入 grep / 技能加载等批量读取的可跳过错误集合（与 tsd-02 同批）。
REFUTER(CONFIRMED,low): 无法推翻。(1) 判定唯一依据属实：src/runtime/host/io.ts:113-115 `const { bytesRead } = await file.read(head, 0, head.length, 0); encrypted = bytesRead === head.length && head.equals(TSD_MAGIC);` 之后没有任何二次判据或明文退路，encrypted 为真即跳过明文分支。(2) 两条出口都堵死：io.ts:134-138 在无回落时抛 `io_tsd_unavailable`（'TSD read requires configured Node'）；有回落时 helper 在 src/runtime/host/tsd-read.mjs:22-24 `if (first.bytesRead === head.length && head.equals(magic)) throw new Error('configured Node still reads TSD ciphertext')`，经 io.ts:158-166 变成 `io_tsd_unreadable`。(3) 所有出厂载体覆盖：src/runtime/host/worker.ts:66 bundled-node 写死 tsdReadFallback:'disabled'，worker.ts:82 electron-utility 仅在随包 node 存在时为 'configured-node'，src/runtime/host/config.ts:14 standalone 为 'disabled'——无一条路径能读出该文件。(4) 现有测试非但没钉住反而自证误判：src/runtime/__tests__/host.test.ts:83-92 的『密文』夹具是 `await writeFile(path, '%TSD-Header-###%secret')` 写出的普通明文，测试却期望 io_tsd_unavailable / io_tsd_unreadable。(5) 非批次 A~C 已修：git log -- src/runtime/host/io.ts src/runtime/host/tsd-read.mjs 最新一次为 T013(19f9e888，块几何倍增与 stderr 独立预算)，此后判定逻辑未改。(6) 不是固有代价：Main 侧同机制 src/main/utils/tsdSafeRead.ts:62-68 魔数命中后走 readViaNodeExe（脚本仅 readFileSync 原样输出），同一输入能正常返回原始字节，说明 runtime helper 的二次魔数硬错误是自加的。保留两点：触发为构造性——我扫过全部 git ls-files，当前无任何文件前 16 字节等于该魔数；且审查员建议的二次判据有事实错误——Windows-P4-6-evidence/encryption-special.md:16,18 记录的容器为 20480 / 45056，均非 8192 的整数倍（是 4096 的倍数）。严重级取 low：影响面仅限以该 16 字节开头的文件，后果为罕见的读取失败与误导性文案，不构成安全绕过或数据损坏。
WAIVER(none): 无取舍 — 核对来源：docs/plantree/plans/runtime-evolution/topics/p1-0-host-contracts.md 第123-129行（TSD 回落判据段落）；相关原文：「TSD 回落。无论 offset 是否为 0，先检查文件起始 %TSD-Header-###%；……helper 读到的文件头仍是 TSD 视为失败，不能返回给模型，也不能继续换别的 Node 重试。」

### [d-cross-03] LOW contract-gap confirmed | P5-3（MCP）/ 渲染层能力面板 | src/runtime/plugins/mcp/config.ts:235 | 超过 16 台的 MCP 服务器在连接之前就被切掉，所以它们不是以「失败」出现在能力面板里，而是根本不出现
DESC: MCP 配置读取在返回前做 servers.slice(0, MAX_SERVERS)，被切掉的名字只进了一条 diagnostics。connectMcpServers 只会为切完之后的那批建立 connections，而 worker 的能力清单是 mcp.connections.map(...) 得来的——所以被切掉的服务器不会以 ok:false + error 的形态出现（那条路径是留给「起了但失败」的），它们在界面上是彻底不存在的。渲染层的 Capabilities 对话框为失败的服务器专门画了红色 Failed 徽标和错误文字，恰恰说明它对「有问题的服务器」是有表达能力的，只是这一类拿不到数据。这条与 d-cross-02 是同一个形态在 MCP 上的复现，但代码位置和修法不同，所以单列。
EVIDENCE: src/runtime/plugins/mcp/config.ts:226-235
  if (servers.length > MAX_SERVERS) {
    const dropped = servers.slice(MAX_SERVERS).map((item) => item.name);
    diagnostics.push({
      code: 'invalid_entry',
      path: '',
      message: `only the first ${MAX_SERVERS} servers declared are started; ${servers.length} were declared, so ${dropped.join(', ')} did not start`,
    });
  }
  return { servers: servers.slice(0, MAX_SERVERS), diagnostics };

src/runtime/plugins/mcp/config.ts:40 —— export const MAX_SERVERS = 16;

src/runtime/worker/nativeWorkerRuntime.ts:327
            mcpServers: mcp.connections.map((connection) => ({

src/renderer/components/workspace-shell/LeftDock.tsx:476-495 —— 逐台渲染，ok 为 false 时画 Badge variant="error" 与 server.error。
SCENARIO: 用户在 <agentDir>/mcp.json 与项目 .pi/mcp.json 里合计声明了 18 台服务器。能力面板列出 16 台、全部绿色。第 17、18 台既没有行也没有错误，用户会以为是自己 JSON 写错了位置，而实际原因是上限。
FIX: 两选一：(a) 把被切掉的服务器也放进 connections 列表，带 ok:false 与一句「超过 N 台上限，未启动」的 error；(b) 沿用 d-cross-01 的诊断通道把这条 invalid_entry 送到面板。(a) 改动更小且复用了现成的失败渲染。无论哪种，message 目前是英文裸串，需要按 d-cross-01 的同一决定处理。
SOURCE: 接缝审查员直接核实代码（跨区域新查，无 REFUTER / WAIVER 段）。关联发现：d-cross-01 / concurrency-04。修补归属：T050。
