# 批次 D 补审 · SessionIndexService 与 fork 生命周期

- **区域**：session-index（SessionIndexService、NativeSessionIndexAdapter、fork 的提交 / 丢弃链）
- **任务**：T029（批评者缺口 3，`cross-and-critic.md:66` GAP [P3-5]）
- **节点判定对象**：P3-5
- **基线**：HEAD `ebc82f16`
- **日期**：2026-09-15
- **方式**：只读。未构建、未跑 tsc / vitest、未起 Electron。

---

## 总评

这块的骨架是对的，问题全部落在「谁把事实写下来、写坏了怎么办」这一层。

三件事先说清楚，因为它们是审计当时没有代码证据的那三问：

1. **fork 的提交与丢弃，在生产链路上完全由 Main 的 `WorkerManager.forkSession` 决定**，runtime 侧只是被动执行。「提交」= 往 `session-index.json` 写一行（`createForked`）；「丢弃」= 让 worker `unlink` 那个暂存的 JSONL（`worker.fork.discard`）。失败处理是分段的：索引写失败 → 先请新 worker 删掉自己打开的文件、删不掉再退回源 worker 删、两边都删不掉就抛 `worker_fork_cleanup_failed` 并把错误报给用户。T016 之后的 Main 侧调用方只有一个私有方法 `discardForkFile`，它在 `forkSession` 里出现三次，全部在「索引还没提交成功」的分支里。**runtime 侧那一半状态机只做了一半**：`acceptFork`（把暂存标记清掉）在生产代码里没有任何调用方，所以每一次成功的 fork 都会在源 worker 的两张 staged 表里留下一条永不清除的记录。

2. **`NativeSessionIndexAdapter` 在 `src/` 内仍然零生产引用**（HEAD 复核，只有它自己的测试引用它），它连带把 `shared/types/nativeSession.ts` 整个端口类型和 `store.acceptFork` 变成只有测试才碰的代码。它是 P3-5 验收清单里被点名的那个模块，`src/runtime/README.md:31` 至今还把它写成「P3-5 对接 Main 索引」的实现。批次 B / C 还在维护它（T025 删掉了 `NativeIndexedRunRequest.targetPath`），说明没人意识到它不参与运行。

3. **索引文件的写是原子的，读不是安全的**。写走「写临时文件 + `rename`」，进程内又有一条串行的 mutation 队列，加上 Electron 的单实例锁，所以并发双写在正常产品形态下不会发生。但读失败（文件被截断、内容不是数组、权限错误）与「文件不存在」走的是同一条分支：警告一句、当作空索引、继续。之后任何一次写入都会用这份空集覆盖整个文件。应用没有任何扫描会话目录的恢复入口，`session-index.json` 是「聊天 → JSONL 文件」的唯一映射，所以这一下等于把用户所有历史会话从界面上永久抹掉（文件还在磁盘上，但应用再也找不到它们）。

另外查出一条审计与前三批都没碰过的用户可见缺陷：**fork 一个「未绑定文件夹」的会话（scratch / 临时会话），生成的索引行漏写 `unbound` 标记**。直接后果是 fork 当场在界面上失败（对话框弹出「Fork was created, but its workspace could not be materialized in this window」），而磁盘上的 fork 文件和索引行已经写成功；重启之后这一行会被渲染层当成孤儿丢掉，这个 fork 永远回不来。同一个服务的兄弟入口（导入）就老老实实写了 `unbound`，并且专门留了 U05-c 的注释，所以这是漏写不是取舍。

session-07 的重判见下文「节点判定」：**维持 refuted**（它给的失败场景在当前代码里仍然不可达），但它的事实陈述那一半升格为本报告的 session-index-04。

## 优点

- **索引的每一个写入方法都先校验身份再改**。`commitResumed` 要求行已存在且 `runtimeIdentity` 完全相等（`SessionIndexService.ts:132-139`），`commitPiLeaf` 还要求 `agent === 'pi'`，`removeImported` 要求连 `legacyImport.targetPiSessionId` 都对得上，`clearUnwrittenRuntimeIdentity` 拒绝清掉一个已经换了身份的行。没有任何一个方法会「顺手造一行」或「把行改指到别处」。
- **失败回滚的形态在多数方法上是正确的**：先改内存 → `flush()` → 失败就把旧值塞回去。这比「先写盘再改内存」更适合这里，因为 `flush` 写的是整张表。
- **fork 的清理顺序是想过的**。`nativeWorkerRuntime.discardFork`（`nativeWorkerRuntime.ts:728-750`）把 `unlink` 放在 `dispose()` 之前，并且注释写明了原因（dispose 之后 HostIo 全部 reject，那时再删就永远删不掉），这是 T016 的成果，测试也覆盖到了（`WorkerManager.test.ts:454-479`）。
- **`worker.fork.discard` 有身份证明**。`store.removeFork`（`store.ts:522-545`）不光比对 staged 表里的 id，还要重新打开那个文件、核对 header 的 `id` 与 `parentSessionId`，才肯 `unlink`。这道证明是 session-07 的失败场景走不通的真正原因。
- **文件格式的兼容性有人认真想过**。`sessionIndex.ts:1-9` 把「为什么必须是裸数组」和「一旦换成信封会发生什么」写在类型头上，`agent` / `unbound` 两个字段各自解释了为什么不在加载时归一化（会把一次兼容的读变成不可逆的写迁移）。

## 弱点

- 加载失败与「没有这个文件」共用一条分支，而下一次写会把损坏证据和全部数据一起覆盖掉（session-index-01）。这是本区域唯一的 high。
- fork 只把「未绑定」这件事带进了 worker 的启动参数，没带进索引行（session-index-02）；对应的 `[release-blocker]` 测试只断言了 worker 那一半，所以测试全绿。
- runtime 侧的 fork 状态机只有「丢弃」有生产实现，「提交」那一半（`acceptFork`）没有（session-index-04）；P3-5 点名的适配器则是一整份不参与运行的平行实现（session-index-03）。
- 失败回滚只做了一半：六个写入方法里有三处没有回滚，而 `flush` 写的是整张表，于是一次「报错了的」修改会被后面任何一次不相干的成功写入悄悄落盘（session-index-05）。
- 索引行只增不删（除导入回滚），归档也只是置位；工作区目录消失后，行还在，但渲染层会静默把它当孤儿丢掉，且 `orphaned` 这个返回值在生产里没有任何消费者（session-index-10、session-index-11）。
- 若干「写了但没接上」的小残留：`effort` 传进索引后被丢掉（session-index-06）、重命名只改索引不改会话文档（session-index-07）、fork 是唯一不做 TUI 交接的会话入口（session-index-08）、暂存 fork 文件没有任何回收扫描（session-index-09）。

## 节点判定

### P3-5 — complete-with-gaps

链路本身是通的，也确实走 `WorkerManager`：`sessionIndexService` 的四个提交钩子在 `WorkerManager.ts:2795-2799` 注入，创建 / 恢复 / leaf / fork 四类提交都在 Main 侧被 `await`，失败会让对应操作失败而不是默默吞掉（`WorkerManager.ts:919`、`:1036`、`:1569`、`:2683`、`:2738`）。D13 那条「Main 侧读写自己的索引 JSON，不受 TSD 约束」仍然成立：`session-index.json` 落在 `app.getPath('userData')`，Main 侧没有 import 任何 runtime / Pi SDK 的值（适配器只 import 类型与 `src/agent-host/piSessionTimeline` 的一个纯函数）。

但四条缺口让它不能判 complete：

- **session-index-01**：索引损坏 = 全量清空，没有隔离也没有备份，而索引是找回历史会话的唯一入口。
- **session-index-02**：fork 未绑定会话这条路当场失败且重启后行丢失，是一整类会话的功能性破损。
- **session-index-03**：验收点名的 `NativeSessionIndexAdapter` 仍零生产引用，P3-5 证据里「导航失败回滚 / 重命名失败回滚两侧 / fork 索引失败清理新文件 / 历史分页」这几项签收，实际只在这份不运行的代码上验过（生产里只有最后一项另有真实用例）。
- **session-index-04**：fork 生命周期在 runtime 侧只实现了「丢弃」，「提交」没有生产调用方。

**session-07 重判**：维持 **refuted**。反驳者当时的结论在 HEAD 上仍然成立——`worker.fork.discard` 在 Main 侧的调用方只有 `discardForkFile`，它只出现在 `forkSession` 的三处，两处在索引提交之前、一处被 `if (!indexCommitted)` 挡住；加上 `store.removeFork` 还要核对文件 header 的父子身份，所以「删掉一个已提交、用户正在用的 fork」这条路走不通。它事实陈述的那一半（`acceptFork` 无人调用、暂存标记永不清）是真的，已单列为 session-index-04，按 low 计。审计 `area-assessments.md:69` 与 `README.md` 第五节里仍把 session-07 当作 P3-5 的「直接后果」陈述，属于批评者点名的那类未回写，建议随本批一并改写。

---

## 发现

### [session-index-01] high robustness | P3-5 | src/main/services/chat/SessionIndexService.ts:420 | 索引文件读坏与「文件不存在」走同一条分支，下一次写入就把全部会话行覆盖成空

DESC: `ensureLoaded` 的 catch 只区分 `ENOENT`（安静）与其它（打一行 warn），两种情况之后都执行 `this.loaded = true` 并让 `this.entries` 保持为空。`JSON.parse` 失败、内容不是数组（`for...of` 抛 TypeError）、`EACCES`、`EIO`，全部落进这里。而 `flush()` 写的是 `[...this.entries.values()]` 整张表，所以加载失败之后的**第一次任何写入**（新建一个会话就够）会把 `session-index.json` 原子地改写成只剩新行。原文件不做备份、不改名、不进入只读模式。

这一下丢掉的不是缓存：`session-index.json` 是「聊天 → JSONL 文件」的唯一映射，全仓没有任何扫描自有会话目录的恢复入口（`src/main/services/agent-host/`、`src/main/services/chat/`、`src/agent-host/` 下的 `readdir` 只出现在 Node 运行时解析与子代理目录里）。JSONL 转录还在磁盘上，但应用再也列不出它们。

`src/shared/types/sessionIndex.ts:4-8` 的类型头已经把这个后果写明白了——"makes an older build throw, start empty, and write `[]` back on its next flush — every session silently gone"——但它是用来论证「格式必须永远是裸数组」的，并没有对「文件被写坏」这一侧做任何防护。现有测试 `SessionIndexService.test.ts:382-389` 把当前行为固化成了期望值：写入 `not json{{` 后只断言 `list()` 解析为 `[]`，完全没有断言那个坏文件是否还在。

EVIDENCE:
```ts
// src/main/services/chat/SessionIndexService.ts:412-425
    this.loadingEntries = (async () => {
      const path = getSessionIndexPath();
      try {
        const content = await readFile(path, 'utf8');
        const parsed = JSON.parse(content) as SessionIndexEntry[];
        for (const entry of parsed) {
          this.entries.set(entry.sessionId, entry);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn('[chat] Failed to read session index, starting empty:', error);
        }
      }
      this.loaded = true;
    })()
```
```ts
// src/main/services/chat/SessionIndexService.ts:442-447
  private async flush(): Promise<void> {
    const path = getSessionIndexPath();
    const entries = [...this.entries.values()];
    await mkdir(app.getPath('userData'), { recursive: true });
    await this.writeAtomically(path, entries);
  }
```

SCENARIO: 用户机器在一次写索引时断电（`writeJsonAtomically` 只有 `writeFile` + `rename`，没有 `fsync`，也没有目录 fsync；ext4 的延迟分配让「rename 已落盘、内容还没落盘」成为一个真实窗口），或者磁盘坏块 / 杀软把这个文件截断。重启后侧栏一条聊天都没有，用户以为要重新开始，随手新建一个会话并发出第一句话 → `CHAT_REGISTER_SESSION` / `CHAT_CREATE_SESSION` 调 `recordCreated` → `flush()` → `session-index.json` 被原子地改写成只有这一行。此前所有会话（含已归档的、含导入进来的）从此不可达，且坏文件被覆盖后连事后取证都做不了。

FIX: 把「读不出来」和「没有这个文件」分开。非 `ENOENT` 的读 / 解析失败时：(1) 把原文件改名成 `session-index.json.corrupt-<ISO 时间戳>` 保留证据；(2) 置一个 `loadFailed` 标志，让本次进程的 `flush()` 要么拒绝写（把错误抛给调用方），要么只在用户明确确认后再接管；(3) 解析后校验 `Array.isArray(parsed)` 与每行 `typeof entry.sessionId === 'string'`，跳过坏行而不是整份放弃——能救回几行是几行。测试相应改成断言坏文件被改名保留、且损坏后的第一次 `recordCreated` 不会让旧行消失。顺带给 `writeJsonAtomically` 加 `fsync`（临时文件 + 目录），把断电窗口收掉。

---

### [session-index-02] medium correctness | P3-5 | src/main/services/agent-host/WorkerManager.ts:1569 | fork 未绑定会话时索引行漏写 `unbound`，fork 当场在界面上失败，重启后这一行被当孤儿丢掉

DESC: `forkSession` 很小心地把源会话的「未绑定」姿态带进了新 worker 的启动参数（`WorkerManager.ts:1510`，`unbound: source.unbound`，还写了长注释说明 fork 不能把 scratch 会话洗白成受信任的），但紧接着交给 `createForked` 的那份索引行里**没有 `unbound` 字段**。同一个服务的另一个独立创建入口（导入）是写的：`LegacyImportService.ts:322-325` 有 `...(unbound ? { unbound: true } : {})` 并挂着 U05-c 的注释。所以这是漏写，不是取舍。

`unbound` 这个字段的作用，`sessionIndex.ts:37-53` 说得很清楚：未绑定会话的 `workspacePath` 是 scratch 目录，永远不会匹配任何 `ChatWorkspace`，没有这个标记的行会被渲染层当成孤儿丢掉。两个后果都落实到了具体代码：

- **当场**：`SessionTreeDialog.handleFork` 拿到索引行后调 `materializeForkedChatSession`，它按 `pathsEqual(item.path, entry.workspacePath)` 找工作区，找不到又没传 `createWorkspaceIfMissing`，于是 `return false`（`chatSessionActions.ts:156-175`），对话框抛出用户可见的错误行「Fork was created, but its workspace could not be materialized in this window」。此时 fork 的 JSONL 已经写好、索引行已经落盘、新 worker 已经 ready——用户看到的是失败，磁盘上是成功。
- **重启后**：`mergeSessionIndex` 走到 `if (!workspaceId)` 分支，把这一行推进 `orphans` 并 `continue`（`sessionIndexMerge.ts:171-185`），而 `orphaned` 在生产里没有消费者（见 session-index-10），于是这个 fork 从侧栏彻底消失，转录文件与索引行永远留在磁盘上。

fork 入口对未绑定会话是开放的：`MessageTimeline.tsx:614` 的 Branches 按钮只看 `hasDurablePiSession`（有 `runtimeIdentity` 即可），不看是否绑定文件夹。

测试覆盖恰好停在缺口前一格：`WorkerManager.test.ts:1364-1375` 这条 `[release-blocker]` 用例只断言 `createSlot` 第二次调用带 `unbound: true`，没有断言 `createForked` 收到的那行长什么样。

EVIDENCE:
```ts
// src/main/services/agent-host/WorkerManager.ts:1569-1579
          const indexed = await this.createForked({
            sessionId,
            runtimeIdentity: sessionFile,
            piLeaf: created.bootstrap.leaf,
            agent: PI_AGENT,
            workspacePath: source.cwd,
            title: `${input.sourceTitle || 'Session'} (fork)`,
            ...(input.model ? { model: input.model } : {}),
            updatedAt: this.now(),
            archived: false,
          });
```
```ts
// src/main/services/agent-host/WorkerManager.ts:1506-1510（同一个对象上方几行，姿态是带了的）
          cwd: source.cwd,
          // A fork shares its source's directory, so it must share its trust
          // posture too — forking must never launder a scratch session into a
          // trusted one.
          unbound: source.unbound,
```
```ts
// src/renderer/stores/chatSessionActions.ts:156-175
  let workspace = state.workspaces.find((item) => pathsEqual(item.path, entry.workspacePath));
  if (!workspace && options?.createWorkspaceIfMissing) { /* … */ }
  if (!workspace) return false;
```

SCENARIO: 用户新建一个不绑定文件夹的聊天（U05 的未绑定会话，cwd 是 scratch 目录），聊几轮后点 Branches → 在某条消息上 Fork。Main 侧一路成功：worker 造出 fork 的 JSONL、新 worker 起来、索引写入一行（没有 `unbound`）。渲染层拿到这行找不到工作区 → 对话框红字「Fork was created, but its workspace could not be materialized in this window」，fork 打不开。用户重启应用，scratch 根目录按 U05-a 被整体清空，而这一行既没有 `unbound` 也没有匹配的工作区 → 被 `mergeSessionIndex` 静默丢弃，侧栏里再也看不到它。

FIX: 在 `createForked` 的入参里补 `...(source.unbound ? { unbound: true } : {})`，与 `LegacyImportService.ts:322-325` 对齐（`unbound` 是「缺省即未知」的可选字段，绑定会话必须继续不写这个键）。测试上把 `WorkerManager.test.ts:1364` 那条用例扩成两条断言：`createSlot` 带 `unbound: true`，**并且** `createForked` 收到的行带 `unbound: true`。另外建议顺手复核 `SessionTreeDialog.handleFork` 这条错误提示——在 fork 已经落盘的情况下报「未能材料化」而不提供任何补救入口，本身也偏弱。

---

### [session-index-03] low dead-code | P3-5 | src/main/services/chat/NativeSessionIndexAdapter.ts:10 | 验收点名的 `NativeSessionIndexAdapter` 至今零生产引用，它和它的 251 行集成测试是一份不参与真实行为的平行实现

DESC: HEAD 复核：`NativeSessionIndexAdapter` 在 `src/` 里的全部引用是它自己的定义和 `__tests__/NativeSessionIndexAdapter.test.ts`。真实链路是 `chat.ts` → `workerManager` → RPC → worker，索引提交走 `WorkerManager.ts:2795-2799` 注入的四个钩子。这一条在审计里已经记过（`README.md:105`「NativeSessionIndexAdapter 零生产引用」），批次 A / B / C 没有处置，所以它仍是当前代码的事实，本报告重申并补上它的连带影响：

- `src/shared/types/nativeSession.ts` 整个文件（`NativeSessionMetadata` / `NativeIndexedRunRequest` / `NativeSessionIndexClient`）的唯一 import 方就是这个适配器；
- `store.acceptFork` / `SessionPlugin.acceptFork` / `contracts.ts:72` 的 `'acceptFork'` 能力名，唯一的调用点是 `NativeSessionIndexAdapter.ts:225`（见 session-index-04）；
- `src/runtime/README.md:31` 仍把这个文件写成「P3-5 · 共享类型端口对接 Main 索引、历史分页与操作回滚」，即当前文档把不运行的代码说成接线实现；
- P3-5 的验收证据 `evidence/p3/completion/README.md:20` 把「导航失败回滚 / 重命名失败回滚两侧 / 历史分页 / fork 索引失败清理新文件」四项签收挂在 `NativeSessionIndexAdapter.test.ts` 上。其中只有最后一项在生产链路上另有真实用例（`WorkerManager.test.ts:454-479`），另外三项在生产代码里根本没有对应实现（重命名见 session-index-07，navigate 的索引回滚在 `WorkerManager` 里没有对应物）。
- 批次 B / C 还在维护它：`nativeSession.ts:18-23` 记录 T025 删掉了 `NativeIndexedRunRequest.targetPath`，说明清扫死代码时没识别出整个模块都是死的。

它的测试还有一个架构上的反例价值：`NativeSessionIndexAdapter.test.ts:26-32` 直接在 Main 进程里 `createRuntime(...)` 并持有 runtime 会话对象，而产品架构（D4 / D11）要求 runtime 只在 worker 载体里跑。也就是说这份适配器即使接上也不该按现在的形状接。

EVIDENCE:
```ts
// src/main/services/chat/NativeSessionIndexAdapter.ts:9-14
/** Main-side adapter; the runtime never imports Electron or owns session-index.json. */
export class NativeSessionIndexAdapter {
  private readonly runtime: NativeSessionIndexClient;
  private readonly index: SessionIndexService;
```
```
$ grep -rn "NativeSessionIndexAdapter" src/ | grep -v __tests__
src/main/services/chat/NativeSessionIndexAdapter.ts:10:export class NativeSessionIndexAdapter {
（无其它命中；`src/shared/types/nativeSession.ts` 的唯一 import 方也是它）
```

SCENARIO: 下一个接手的人按 `src/runtime/README.md:31` 和 P3-5 的验收清单去改 fork / 重命名 / 历史分页的索引行为，会改到这个适配器上，写完测试全绿、产品行为一点没变。反过来，读 `WorkerManager.forkSession` 的人会以为「索引回滚只有这一处」，看不到平行实现里那套更完整的两侧回滚。

FIX: 建议**删**，不建议接。理由三条：(1) 它的 `run` / `rewind` / `navigate` / `fork` 都建立在「Main 进程直接持有 runtime 会话对象」之上，与 worker 载体的架构相反；(2) 它独有的能力（重命名两侧回滚、navigate 失败回滚）应当以 RPC 的形式补进 `WorkerManager`，而不是留一份平行实现当参考；(3) 删除时把 `src/shared/types/nativeSession.ts` 一并评估退役，并改掉 `src/runtime/README.md:31` 与 P3-5 验收清单里被这份测试代签的三项。**注意不要同时删掉 `store.acceptFork`**——它需要的是一个真实的调用方（见 session-index-04），不是跟着适配器一起消失。

---

### [session-index-04] low contract-gap | P3-5 | src/runtime/worker/nativeWorkerRuntime.ts:698 | fork 状态机只有「丢弃」有生产实现，「提交」那一半（`acceptFork`）没人调用，暂存标记永不清除

DESC: 一次 fork 会在两个层级各留一条暂存记录：worker 层 `NativeWorkerRuntime.stagedForks`（`nativeWorkerRuntime.ts:698`）和会话 store 层 `JsonlSessionStore.stagedForks`（`store.ts:508`）。两处的注释都把它说成「未被采纳的产物」，`store.removeFork` 更是拿它当删除许可（`store.ts:523-527`：`fork is not an uncommitted artifact of this runtime`）。但清除这条记录的方法 `acceptFork`（`store.ts:546-548`、`session/index.ts:73-75`）在生产链路上**没有任何调用方**——全仓唯一调用点在死模块 `NativeSessionIndexAdapter.ts:225` 里。`WorkerManager.forkSession` 在 `createForked` 成功后只置了自己的 `indexCommitted = true`（`WorkerManager.ts:1580`），没有任何 RPC 通知 worker「这个 fork 已经被采纳了」；worker RPC 协议里也没有对应的方法（`contracts.ts:71-72` 有 `acceptFork` 这个能力名，但 `piWorkerRpcServer.ts` 只暴露了 `discardFork`）。

于是每一次成功的 fork 都会在源会话的两张表里永久留下一条「未提交产物」记录，直到源 worker 退出。这就是 session-07 描述的事实；**它给的失败场景在 HEAD 上仍然不可达**（`worker.fork.discard` 的 Main 侧调用方只有 `discardForkFile`，三个调用点全在同一次 `forkSession` 内、且都在索引提交之前或被 `!indexCommitted` 挡住；文件名是每次新生成的 `randomUUID()`，撞不上旧的暂存项；`store.removeFork` 还要核对 header 的 `id` 与 `parentSessionId`）。所以按契约缺口计 low，不按 bug 计。

EVIDENCE:
```ts
// src/runtime/worker/nativeWorkerRuntime.ts:694-698
    const metadata = await session.fork(file, input.entryId);
    // The fork is staged, not adopted: Main decides whether it becomes a
    // session, and `worker.fork.discard` must be able to prove the file it is
    // asked to delete is one we made rather than an unrelated transcript.
    this.stagedForks.set(metadata.file, metadata.id);
```
```ts
// src/runtime/plugins/session/store.ts:546-548
  acceptFork(file: string): void {
    this.stagedForks.delete(file);
  }
```
```ts
// src/main/services/agent-host/WorkerManager.ts:1569-1580（提交点，没有对应的 accept 通知）
          const indexed = await this.createForked({ /* … */ });
          indexCommitted = true;
```

SCENARIO: 不是一条会当场咬人的路径，是一条留给未来的雷。举例：任何人后续给「清理无主 fork 文件」写一个扫描器，或者给 `worker.fork.discard` 增加一个新的 Main 侧调用方（例如「撤销刚才这次 fork」这样的用户功能），都会读到源 worker 那份仍然写着「未提交」的表，并据此删掉一个用户已经在用的会话文件——而 `store.removeFork` 的 header 校验对这种情况是放行的（父子关系与 id 都对得上）。目前挡住这条路的只是「暂时没有第二个调用方」这一点。

FIX: 把提交那一半补齐。最小改法：在 `WorkerManager.ts:1580` 置 `indexCommitted = true` 之后，向**源** worker 发一个 `worker.fork.accept`（payload 与 discard 同形），worker 侧 `stagedForks.delete(file)` 并调 `session.acceptFork(file)`；失败只记日志不影响 fork 结果（这是清理，不是事务）。协议里已经有 `acceptFork` 的能力名，补的是 RPC 与调用方。若决定不补，就应当反过来把两处 `stagedForks` 的注释和 `store.removeFork` 的错误文案改成「本 runtime 造出来的 fork 文件」，不要再宣称它证明了「未提交」——现在这句话是不成立的。

---

### [session-index-05] medium correctness | P3-5 | src/main/services/chat/SessionIndexService.ts:331 | `setArchived` 等三处写失败不回滚内存，而 `flush` 写整张表，于是一次报错的修改会被后面任何一次无关写入悄悄落盘

DESC: 这个类的写入方法有两种写法。`commitResumed`、`commitPiLeaf`、`removeImported`、`bindRuntimeIdentity`、`clearUnwrittenRuntimeIdentity`、`rename`、`createIndependent` 都是「改内存 → try flush → catch 把旧值塞回去」。但 `setArchived`（`:331`）、`recordCreated`（`:113`）、`applyRuntimeEvent` 的三条分支（`:379`、`:389`、`:396`）只有裸 `await this.flush()`，没有回滚。

关键在于 `flush()` 写的是 `[...this.entries.values()]` **整张表**而不是增量。所以「不回滚」不等于「这次改动没生效」——它等于「这次改动进了内存但没进盘，并且会搭下一次成功的写一起进盘」。调用方那边已经收到了异常，用户那边已经看到了失败提示，然后它在几秒后自己生效了。

`commitResumed` 的文档注释（`:117-121`）把回滚说成是这个类的性质（"rolls back memory if the atomic flush fails"），实现只做到了六分之三。

EVIDENCE:
```ts
// src/main/services/chat/SessionIndexService.ts:325-334
  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    await this.ensureLoaded();
    return this.queueMutation(async () => {
      const existing = this.entries.get(sessionId);
      if (!existing) return false;
      this.entries.set(sessionId, { ...existing, archived, updatedAt: now() });
      await this.flush();
      return true;
    });
  }
```
对照同一文件里的正确形态：
```ts
// src/main/services/chat/SessionIndexService.ts:309-323
  async rename(sessionId: string, title: string): Promise<boolean> {
      this.entries.set(sessionId, { ...existing, title, updatedAt: now() });
      try {
        await this.flush();
      } catch (error) {
        this.entries.set(sessionId, existing);
        throw error;
      }
```

SCENARIO: 磁盘写满（或 Windows 上索引文件被杀软 / 备份工具短暂占用，`rename` 抛 `EPERM`）。用户点「归档」某个会话 → `setArchived` 改内存 → `flush` 抛错 → IPC 报错，界面提示归档失败，会话仍留在侧栏，用户以为什么都没发生。几分钟后磁盘腾出空间，用户在**另一个**会话里发一句话，回合结束触发 `session.completed` → `applyRuntimeEvent` → `flush()` 把整张表写盘，其中包含那条 `archived: true`。下一次刷新索引（或重启）时，第一个会话从侧栏消失——用户从没成功归档过它，也没收到任何提示。

FIX: 把 `setArchived`、`recordCreated`、`applyRuntimeEvent` 三条分支统一成其余方法的 try/catch 回滚形态；更彻底的做法是把回滚抽成一个私有 helper（`mutateAndFlush(sessionId, next)`），让「改内存 + 落盘 + 失败复原」只有一份实现，避免下一个新增方法又忘。补一条用例：注入一个只在第 N 次失败的 `writeAtomically`，断言失败后 `get()` 读回旧值，并且后续一次成功的无关写入不会把失败的那次带上盘。

---

### [session-index-06] low dead-code | P3-5 | src/main/ipc/chat.ts:278 | `chat:createSession` 把 `effort` 传给 `recordCreated`，而索引既没有这个字段也不会保存它

DESC: `CHAT_CREATE_SESSION` 在调用 `recordCreated` 时展开了 `...(payload.effort ? { effort: payload.effort } : {})`。但 `recordCreated` 的入参类型里没有 `effort`（`SessionIndexService.ts:85-93`），方法体是逐字段重建行（这一点它自己的注释在 `:71-84` 说得很清楚：任何没点名的键都会在下一次调用时被丢掉），`SessionIndexEntry`（`src/shared/types/sessionIndex.ts:12-61`）也没有 `effort`。所以这一行写了等于没写。TypeScript 不报错是因为多余属性检查不作用于展开进来的属性——这行能留在一个 tsc 全绿的仓库里，本身就是证据。

功能上不丢东西：同一个处理函数在下一行把 `effort` 正常交给了 `workerManager.createSession`（`chat.ts:286`），那才是生效的路径。但它会让读代码的人以为「会话的推理档位是持久化的」，实际上重启后档位只能来自渲染层自己的存储。

EVIDENCE:
```ts
// src/main/ipc/chat.ts:274-281
      await sessionIndexService.recordCreated({
        sessionId: payload.sessionId,
        workspacePath: payload.workspacePath,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        agent: PI_AGENT,
        unbound,
      });
```
```ts
// src/main/services/chat/SessionIndexService.ts:85-93（入参里没有 effort）
  async recordCreated(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    agent?: string;
    unbound?: boolean;
  }): Promise<void>
```

SCENARIO: 没有运行期故障。触发的是认知错误：有人要做「重启后恢复上次的推理档位」，看到这行以为已经存了，去查 `session-index.json` 发现没有，再回头排查是不是写入被覆盖了——而真相是这个参数从来没被接收过。

FIX: 二选一，不要停在中间态。要么删掉 `chat.ts:278` 这一行；要么真的把 `effort` 做成持久事实——给 `SessionIndexEntry` 加可选字段 `effort?: SessionEffortLevel`（按该文件头的规则，只能是可选的 per-entry 字段）、在 `recordCreated` 的入参与重建体里点名它、并像 `agent` 一样用 `?? existing?.effort` 兜住不知情的调用方。从「档位是每回合可覆盖的」这一点看，我倾向删。

---

### [session-index-07] low contract-gap | P3-5 | src/main/ipc/chat.ts:601 | 重命名只改索引行，worker 协议里根本没有 rename，会话文档的 name 永远不被 GUI 写入——同一个文件在 GUI 与 pi CLI 两个界面上标题不一致

DESC: `CHAT_RENAME_SESSION` 直接调 `sessionIndexService.rename(...)`，只改 `session-index.json` 里的 `title`。worker RPC 面上没有任何 rename 方法（对 `src/agent-host/piWorkerRpcServer.ts`、`src/shared/types/workerRpc.ts`、`src/runtime/worker/nativeWorkerRuntime.ts` 搜 `rename` 零命中），`WorkerManager` 也没有任何 rename 路径。而 runtime 侧是实现了的：`SessionPlugin.rename` → `store.rename`（`src/runtime/plugins/session/index.ts:77`）会往 JSONL 里写一条命名行。

这条能力在生产里只有一个调用方，还是导入：`src/runtime/worker/nativeImport.ts:130` 的 `await store.rename(conversation.title)`。于是出现一个不对称——**导入进来的会话，标题写在文件里；GUI 新建的会话，标题只在索引里**；GUI 里重命名任何一种会话，文件里的名字都不动。连带效应是 fork：`store.createFork` 有 `if (this.document.name) await fork.rename(this.document.name)`（`store.ts:503`），所以导入会话的 fork 会带上文件级名字，GUI 会话的 fork 不会。

H/20 把 pi CLI 变成了同一个 JSONL 的第一等第二界面，而 pi 的会话管理器是有名字概念的（`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:83`、`:130-131`、`:226-228`：`appendSessionInfo(name)` 与「从最近一条 session_info 取当前会话名」）。**static_inference**：这个名字在 pi CLI / TUI 的哪些界面上露出，需要真的开一次 CLI 才能确认，我只能从类型定义确认它是格式里的一等公民。

EVIDENCE:
```ts
// src/main/ipc/chat.ts:598-603
  ipcMain.handle(
    IPC_CHANNELS.CHAT_RENAME_SESSION,
    async (_e, payload: { sessionId: string; title: string }): Promise<boolean> => {
      return sessionIndexService.rename(payload.sessionId, payload.title);
    }
  );
```
```
$ grep -rn "rename" src/main/services/agent-host/WorkerManager.ts        → 零命中
$ grep -rn "'rename'|worker.rename|renameSession" src/agent-host/piWorkerRpcServer.ts \
      src/runtime/worker/nativeWorkerRuntime.ts src/shared/types/workerRpc.ts → 零命中
$ grep -rn "\.rename(" src/runtime/plugins/session/*.ts src/runtime/worker/*.ts
src/runtime/plugins/session/store.ts:503:      if (this.document.name) await fork.rename(this.document.name);
src/runtime/worker/nativeImport.ts:130:  await store.rename(conversation.title);
```

SCENARIO: 用户在 GUI 里把一个聊天重命名为「支付网关重构」，然后在同一个会话上开 pi TUI（H/20 的交接路径）。TUI 侧看到的是一个没有名字的会话；如果用户在 CLI 的会话列表里找它，只能靠时间戳认。反过来，导入进来的会话在两边显示一致——同一个产品里两种会话行为不同。

FIX: 决定一个口径并写进 H/20 的契约文档。若认定「标题是跨界面事实」：补一个 `worker.session.rename` RPC，`CHAT_RENAME_SESSION` 先改文件再改索引（或先索引后文件并在文件失败时回滚索引，`NativeSessionIndexAdapter.rename` 里已经有一份现成的两侧回滚可以照抄），注意它是一次 JSONL 写入，得和 send / rewind 一样先走 `handOverFromTui`。若认定「标题是 GUI 的本地事实」：把 `nativeImport.ts:130` 那一处也去掉，让两类会话一致，并在契约里写明 pi CLI 侧不显示我们的标题。

---

### [session-index-08] low robustness | P3-5 | src/main/ipc/chat.ts:704 | fork 是唯一不做 TUI 交接的会话变更入口，从 worker 的内存文档复制分支，在一次 reload 失败之后会复制出缺少终端轮次的分支

DESC: `handOverFromTui`（`chat.ts:125-146`）是 GUI 抢回 JSONL 所有权的那道闸：杀掉终端、拒绝在别人还持有文件时继续、终端写过就重读文件。send（`:489`）、compact（`:650`）、rewind（`:694`）都调它，**fork（`:704-719`）不调**。

fork 不写源文件（`store.createFork` 只 `flush()` 源、然后把分支写进新文件），所以它不会像 session-01 那样把源文件写坏——这一点我核过，不必按 high 计。但它是从 worker 的**内存文档**里取分支的（`createFork` 用 `this.document.entries` + `branchEntries`），因此文档有多旧，fork 就少多少内容。

正常路径上这个窗口是关着的：从 TUI 切回 GUI 会 `suspend` 终端并 `reloadSession`（`usePresentationSwitch.ts:147-175`），TUI 退出也会无条件 reload（`:187-210`）。窗口只在 **reload 自己失败** 时打开——那条 catch 会弹一个「Could not reload this chat」的提示并丢掉终端，但不会禁用 Branches 按钮，也不会把会话标成「内容可能不全」。

EVIDENCE:
```ts
// src/main/ipc/chat.ts:704-718（对照 :489 / :650 / :694 都有 await handOverFromTui）
  ipcMain.handle(
    IPC_CHANNELS.CHAT_FORK_SESSION,
    async (e, payload: { sessionId: string; entryId: string }) => {
      const row = await requireIndexedPiSession(payload.sessionId);
      return workerManager.forkSession({ /* … */ });
    }
  );
```
```ts
// src/runtime/plugins/session/store.ts:465-469（分支来自内存文档）
  private async createFork(file: string, entryId: string): Promise<SessionMetadata> {
    await this.flush();
    if (!this.document.entries.some((entry) => entry.id === entryId))
      throw new RuntimeHostError('session_entry_not_found', entryId);
    const branch = branchEntries(this.document, entryId);
```

SCENARIO: 用户在 pi TUI 里聊了几轮，切回 GUI；`reloadSession` 因为写锁被别人持有（或 worker 正好在重启）而失败，界面弹出「Could not reload this chat」。用户没在意，继续在 GUI 里点 Branches → Fork 某条早期消息。fork 出来的新会话按 worker 那份**进终端之前**的文档复制，终端里那几轮永久不在这个分支上，而新会话看起来完全正常（它自己的历史是自洽的）。

FIX: 让 fork 与其它三条入口一致：在 `CHAT_FORK_SESSION` 里先 `await handOverFromTui(payload.sessionId, ownerWebContentsId)`。代价只有一次索引读加一次终端释放；收益是 fork 永远从「文件的当前真相」出发。若不想加这次交接，至少要在 reload 失败后把该会话标成脏（禁用 Branches / 在树对话框上给出警告），不要让一次已经报错的 reload 静静地把陈旧内容复制成一个新会话。

---

### [session-index-09] low robustness | P3-5 | src/main/services/agent-host/WorkerManager.ts:1461 | 暂存 fork 文件没有任何回收扫描，fork 窗口里崩溃或删不掉就会在会话目录里留下无主 JSONL

DESC: `worker.fork` 先在会话目录里造出文件（`nativeWorkerRuntime.ts:693`：`join(dirname(sourceSessionFile), \`${randomUUID()}.jsonl\`)`），之后才是 spawn 新 worker 与写索引。这段窗口里文件没有索引行、没有任何持久登记。两种情况会把它永久留下：

1. Main 在窗口内崩溃 / 被杀 / 用户强退——`stagedForks` 只在内存里，重启后无人知道这个文件是暂存品；
2. 清理本身失败——`discardForkFile` 两次都返回 false 时抛 `worker_fork_cleanup_failed`（`WorkerManager.ts:1617-1623`），错误报给了用户，文件留在原地，没有重试也没有登记待清理。

全仓没有任何启动期扫描会话目录的代码（`src/main/services/agent-host/`、`src/main/services/chat/`、`src/agent-host/` 下的 `readdir` 只出现在 Node 运行时解析与子代理目录里），所以这些文件不会被任何人回收。

EVIDENCE:
```ts
// src/runtime/worker/nativeWorkerRuntime.ts:692-694
    const sourceSessionFile = session.file;
    const file = join(dirname(sourceSessionFile), `${randomUUID()}.jsonl`);
    const metadata = await session.fork(file, input.entryId);
```
```ts
// src/main/services/agent-host/WorkerManager.ts:1617-1623
          if (!stagedFileDiscarded) {
            throw new WorkerManagerError(
              'worker_fork_cleanup_failed',
              `Fork failed and the staged Pi file could not be confirmed removed: ${sessionFile}`,
              true
            );
          }
```

SCENARIO: 用户点 Fork，新 worker 正在启动时用户强退应用（或应用崩溃）。磁盘上多出一个 `<uuid>.jsonl`，它是源会话前半段的完整副本，和正常会话文件躺在同一个目录里、同样是 `0o600`。GUI 永远看不到它（索引里没有），但 pi CLI 是按目录列会话的——用户在 CLI 里会看到一个来路不明、内容是自己某次对话前半段的会话，而且没有任何界面能删掉它。重复几次就是持续的磁盘占用与困惑。

FIX: 给暂存文件一个可识别的形态或一份可重放的登记。两种可选：(1) 在会话目录下用 `<uuid>.jsonl.staged` 这样的后缀落地，`createForked` 成功后再改名成正式名（改名是原子的，同时天然解决了 session-index-04 的「提交」语义），启动时把残留的 `.staged` 一律删掉；(2) 保持文件名不变，但把「待清理路径」写进一个小的 pending 文件，启动时扫一遍并按 header 的 `parentSessionId` 校验后删除。至少也要把 `worker_fork_cleanup_failed` 的那条路径记进日志之外的持久位置，否则用户唯一的补救手段是自己去目录里认文件。

---

### [session-index-10] low dead-code | P3-5 | src/renderer/components/chat/sessionIndex/useSessionIndex.ts:64 | `mergeSessionIndex` 的 `orphaned` 返回值在生产里零消费者，会话因为目录消失而从侧栏蒸发时没有任何提示

DESC: `mergeSessionIndex` 把「索引里有、但本窗口找不到对应工作区」的行单独收进 `orphans`，注释写明用意是「让调用方决定——丢掉，或者给个警告」（`sessionIndexMerge.ts:172-173`）。生产里唯一的调用方 `applySessionIndexRefresh` 只取 `merged.sessions`，`merged.orphaned` 被直接丢弃（`useSessionIndex.ts:64-70`）。于是「丢掉」是默认也是唯一行为，而且是静默的。

这正好接在 F2-b 的设计结论后面。旧树 `runtime-evolution/README.md:217` 写明：重启会把整个 scratch 根连锅端，因此必然出现「索引行在、`workspacePath` 指向已不存在目录」的状态，「这是 U05-a 的设计而非索引损坏」。对带 `unbound` 标记的行，`sessionIndexMerge.ts:151-168` 确实专门兜住了（这是对的）。但没有标记的行——用户手工删掉的项目文件夹、被 `temp:workspace:remove` 删掉的临时目录、以及 session-index-02 里那种漏写标记的 fork 行——全部走 `orphans` 分支静默消失。索引里那一行永远留着（`SessionIndexService` 只有导入回滚会删行），转录也留着，只是用户再也看不到入口。

EVIDENCE:
```ts
// src/renderer/components/chat/sessionIndex/useSessionIndex.ts:64-70
  const merged = mergeSessionIndex(state.sessions, entries, {
    workspaces: state.workspaces,
    seedStatus: 'idle',
  });
  const sessions = dropDismissedSessions(merged.sessions);
```
```ts
// src/renderer/components/chat/sessionIndex/sessionIndexMerge.ts:171-185
    if (!workspaceId) {
      // No workspace context to host this session — skip but also stash as
      // orphaned so the caller can decide (e.g. drop, or surface a warning).
      orphans.push({ /* … */ });
      continue;
    }
```

SCENARIO: 用户把一个项目文件夹改名或删掉（或用侧栏的删除按钮清掉一个临时工作区目录）。下一次索引刷新，这个文件夹下的所有聊天从侧栏消失，没有提示、没有「已失联的会话」分组、也没有「重新指定目录」的入口。用户的自然结论是「聊天记录丢了」，而实际上索引行和 JSONL 都好端端在磁盘上。

FIX: 让 `orphaned` 真的有消费者。最小可行：把它放进 store，在侧栏底部给一个可折叠的「文件夹已失联（N）」分组，点进去能看到标题与 `workspacePath`，提供「重新绑定到某个文件夹」或「归档」两个动作。若产品上决定就是要静默丢弃，那就把 `MergeResult.orphaned` 与那段注释一起删掉，别留一个说着「让调用方决定」却没人决定的返回值。

---

### [session-index-11] low capacity | P3-5 | src/main/services/chat/SessionIndexService.ts:442 | 索引行只增不删、无上限无修剪，而每一次回合结束都会把整张表重新序列化写盘

DESC: 两件事叠在一起。其一，能删除索引行的方法只有 `removeImported`（导入回滚）和 `createIndependent` 自己的失败回滚，`entries.delete` 在整个文件里只出现这两处（`:216`、`:247`）；归档只是把 `archived` 置 true，关闭会话（`CHAT_CLOSE_SESSION`）根本不碰索引。所以 `session-index.json` 的行数等于「这台机器上创建过的全部聊天数」，单调增长。其二，`flush()` 把整张表 `JSON.stringify(data, null, 2)` 后整文件重写，而它的触发频率不低：`handleRuntimeEvent` 对 `session.created / updated / completed / failed / stopped` 都会落一次盘（`:337-351`、`:392-397`），也就是每个回合结束至少写一次全量。

单看都不致命（几千行的缩进 JSON 是 MB 级），但这是 Main 进程主线程上的同步序列化 + 一次全量写，且随使用时间线性变差；再叠上 session-index-01（这个文件没有任何损坏隔离），「一个越写越大、越写越频繁、写坏就全丢」的组合值得在容量对账表（T024）里补一行。

EVIDENCE:
```ts
// src/main/services/chat/SessionIndexService.ts:442-447
  private async flush(): Promise<void> {
    const path = getSessionIndexPath();
    const entries = [...this.entries.values()];
    await mkdir(app.getPath('userData'), { recursive: true });
    await this.writeAtomically(path, entries);
  }
```
```ts
// src/main/services/chat/SessionIndexService.ts:21-29
async function writeJsonAtomically(targetPath: string, data: unknown): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tempPath, targetPath);
```

SCENARIO: 一台长期使用的开发机上积累了几千个聊天（含全部已归档的）。每一次回合结束（`session.completed`）都要把这份几 MB 的缩进 JSON 完整序列化并重写一遍。用户感知到的是发完消息后偶发的主进程卡顿，而没有任何界面告诉他「归档不会让索引变小」。

FIX: 三件小事，按代价排序：(1) `JSON.stringify` 去掉 `null, 2` 缩进（这个文件不是给人读的，体积能掉三到四成）；(2) 把终态事件（`completed` / `failed` / `stopped`）那三条只改 `updatedAt` 的写做节流合并，避免一个回合内多次全量写；(3) 给「删除会话」一个真正的入口（同时删索引行与 JSONL，或至少把归档超过 N 天的行迁到一个 `session-index.archive.json`），让主索引的规模有上界。把结论回写进 T024 的容量对账表。

---

## 测试缺口

- `SessionIndexService.test.ts:382-389` 的损坏用例只断言 `list()` 返回 `[]`，没有断言坏文件是否被保留，等于把 session-index-01 的破坏性行为固化成期望值。缺一条「损坏后第一次 `recordCreated` 不得让旧行消失」的用例。
- 没有任何用例覆盖「`flush` 失败后不回滚的三个方法」（`setArchived` / `recordCreated` / `applyRuntimeEvent`）；现有的回滚用例（`:59` 的 binding 回滚）只覆盖了写法正确的那一半（session-index-05）。
- `WorkerManager.test.ts:1364` 的 `[release-blocker]` fork 用例只断言 `createSlot` 收到 `unbound: true`，没有断言 `createForked` 收到的索引行——session-index-02 正是从这个缝里漏过去的。
- 没有任何用例覆盖「fork 一个 unbound 会话后渲染层能否打开它」，`materializeIndexedPiChatSession` 返回 false 的那条分支在 fork 场景下无测试。
- `NativeSessionIndexAdapter.test.ts`（7 个用例，含真实 runtime 与真实索引）全部作用在零生产引用的模块上，是纯粹的假覆盖；P3-5 验收清单里有三项签收只依赖它。
- 没有任何用例覆盖 `worker.fork.discard` 在 Main 崩溃后的残留清理（本来也没有实现，session-index-09）。
- `mergeSessionIndex` 的 `orphaned` 分支没有任何用例断言调用方该怎么处理它（因为调用方什么都没做，session-index-10）。

## 未经执行验证的声明

- **断电 / 崩溃是否真能产出被截断的 `session-index.json`**：`writeJsonAtomically` 没有 `fsync`，ext4 的延迟分配理论上留下窗口（ext4 的 `auto_da_alloc` 会缓解「rename 覆盖既有文件」这一情形，但不是保证）。我没有也不可能在本机复现。session-index-01 的其它触发方式（文件被第三方截断、内容不是数组、`EACCES`）是纯代码判定，成立与否不依赖这一条。
- **pi CLI / TUI 到底在哪些界面显示会话名**：只从 `session-manager.d.ts` 的类型确认名字是格式里的一等公民（`appendSessionInfo` / `getSessionName`），没有开过 CLI 看实际露出位置。session-index-07 的严重级按 low 保守给。
- **Windows 上索引写入因占用而失败的概率**：`rename` 覆盖既有文件在 Windows 上受杀软 / 搜索索引器占用影响（`EPERM` / `EBUSY`）是平台常识，我没有在 Windows 上验证过本仓这条路径。这条只作为 session-index-05 的触发场景之一提及，不单独立发现。
- **fork 一个 unbound 会话的完整界面表现**：session-index-02 的两个后果（`materializeForkedChatSession` 返回 false、重启后被 `orphans` 丢弃）都是从代码判定的，判定链完整（按钮可见性 → IPC → 索引行 → merge 分支），但我没有起 Electron 实跑。已列入上机检查单。
- **`session-index.json` 所在的 `userData` 在加密机上是否落在受策略路径**：D13 断言索引读写不受 TSD 约束，我只确认了代码用 `app.getPath('userData')` 且没有走 TSD 读写封装，没有加密机上的路径事实。
- **多实例并发写**：`src/main/index.ts:269` 有 `app.requestSingleInstanceLock()`，因此正常产品形态下只有一个写者；开发构建与打包构建是否共用同一个 `userData` 目录我没有核实，若共用则两份进程内表会互相覆盖。

## 上机检查单

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| fork 一个未绑定（scratch）会话 | 对话框是否弹出「Fork was created, but its workspace could not be materialized in this window」；此时 `session-index.json` 里是否已有该 fork 行且不含 `unbound` | 起 Electron，新建不选文件夹的聊天并发一轮，点 Branches → Fork；随后 `cat` userData 下的 `session-index.json` | electron / real-model |
| 上一条之后重启 | 该 fork 是否从侧栏彻底消失，而索引行与 JSONL 仍在磁盘上 | 退出应用后重开，比对侧栏与 `session-index.json` | electron |
| 索引损坏后的第一次写 | 旧行是否被覆盖丢失；坏文件是否还留在磁盘上 | 退出应用，把 `session-index.json` 截断成半行 JSON，重开应用（侧栏应为空），新建一个聊天发一句话，再看文件内容 | electron |
| 断电 / 强杀后的索引完整性 | `session-index.json` 是否出现零长度或半截内容 | 在一轮对话结束（会触发 flush）的瞬间强杀进程，重复若干次后检查文件 | electron / windows |
| Windows 上索引写入的占用失败 | `rename` 是否出现 `EPERM` / `EBUSY`，以及失败后归档 / 重命名的界面表现 | Windows 打包版上开启实时防护，连续归档 / 重命名若干会话并观察错误与重启后的状态 | windows |
| GUI 重命名后在 pi CLI 侧的标题 | pi CLI 的会话列表 / 标题栏显示的是 GUI 里改过的名字，还是空 | GUI 里重命名一个会话，用 pi CLI 打开同一个 JSONL | real-model |
| fork 窗口内强杀留下的残留文件 | 会话目录里是否多出无主 `<uuid>.jsonl`，pi CLI 是否把它列成一个会话 | 点 Fork 后在新 worker 起来之前强杀应用，随后 `ls` 会话目录并开 pi CLI 列会话 | electron |
| 加密机上 `userData` 的位置 | `session-index.json` 是否落在受策略目录内；是否受 TSD 读写约束 | 加密机上打印 `app.getPath('userData')` 并对该路径做一次普通读写 | encrypted |
| 临时工作区删除后的会话去向 | 用侧栏删除一个临时工作区目录后，其下的聊天是否从侧栏静默消失，而索引行仍在 | 起 Electron 走 `temp:workspace:remove` 那条链，之后刷新侧栏并比对 `session-index.json` | electron |

## 读过的文件

- src/main/services/chat/SessionIndexService.ts
- src/main/services/chat/NativeSessionIndexAdapter.ts
- src/main/services/chat/__tests__/SessionIndexService.test.ts
- src/main/services/chat/__tests__/NativeSessionIndexAdapter.test.ts（头部与用例清单）
- src/main/services/agent-host/WorkerManager.ts（fork / resume / 索引提交 / dispatch 段）
- src/main/services/agent-host/__tests__/WorkerManager.test.ts（fork 与 unbound 相关用例）
- src/main/ipc/chat.ts
- src/main/ipc/tempWorkspace.ts（remove 处理段）
- src/main/services/legacyImport/LegacyImportService.ts（索引写入段）
- src/shared/types/sessionIndex.ts
- src/shared/types/nativeSession.ts
- src/shared/types/runtimeEvents.ts（session.* 事件段）
- src/runtime/worker/nativeWorkerRuntime.ts（fork / discardFork 段）
- src/runtime/plugins/session/store.ts（fork / discardFork / acceptFork / mutate 段）
- src/runtime/plugins/session/index.ts
- src/runtime/plugins/subagent/run.ts（子代理有无自有会话）
- src/renderer/components/chat/SessionTreeDialog.tsx
- src/renderer/components/chat/forkDraftCarry.ts
- src/renderer/components/chat/sessionIndex/sessionIndexMerge.ts
- src/renderer/components/chat/sessionIndex/useSessionIndex.ts
- src/renderer/components/chat/usePresentationSwitch.ts（TUI 交接段）
- src/renderer/components/chat/MessageTimeline.tsx（Branches 按钮段）
- src/renderer/stores/chatSessionActions.ts
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二 / 五 / 八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（缺口 3 及 CRITIC 段）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/area-assessments.md（session 区域与 P3-5）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/findings-uncertain-refuted.md（session-07）
- docs/plantree/plans/runtime-hardening/roadmap.md（Done 段与 T016 / T029）
- docs/plantree/plans/runtime-evolution/README.md（F2-b 行）
- docs/plantree/plans/runtime-evolution/evidence/p3/completion/README.md（P3-5 验收行）
- docs/plantree/plans/runtime-hardening/evidence/batch-d-raw/main-host.md、main-host-aux.md（避免与同批代理重叠）
- node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts（会话名字段）
