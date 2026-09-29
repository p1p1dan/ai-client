# 决策 124：P1-9f CC / Codex 导入直接产出 DSH 会话的实现取舍

日期：2026-09-29。**状态：自主决定，待用户审批。**

依据：
- 已批准的决策：[056](056-imports-produce-dsh-directly.md)（导入直接产 DSH）、[050](050-migrate-on-first-continue.md)～[055](055-stopped-replies-stay-visible.md)、[076](076-converter-implementation-choices.md) 第 4 条（导入消息 id）、[090](090-user-rulings-2026-09-28.md)（默认跟随 DSH）、[110](110-user-rulings-2026-09-28-batch2.md)；
- 待审批的前序决策：[121](121-p1-9c-seed-session-choices.md)（宿主 `seedSession`，第 7、8、10、12、15、17 条）、[122](122-p1-9d-migration-orchestration-choices.md)（第 1～3、6、9 条与「遗留」里的 P1-9f 一节）、[123](123-p1-9e-migration-renderer-choices.md)（「与 P1-9f 的衔接」）；
- 方案：[P1-9 方案](../topics/p1-9-migration.md) §4.6、§6 的 P1-9f 行；[分片 02](../topics/p1-9-migration/02-mapping.md) §3；[分片 04](../topics/p1-9-migration/04-index-rollback.md) §5；[分片 05](../topics/p1-9-migration/05-tests-and-changes.md) §4 的 P1-9f 行与 §6 的 P1-12 行；[重划](../topics/p1-4-p1-16-rescope.md) §4 的 P1-9f 说明（「保留还是推迟由用户或编排者定」：编排者已派工，按保留做）。

改动留在工作区，由编排者复跑后提交。**第 1、7、8、12、14、17 条请重点审批。**

## 规则

### 一、宿主：`seedSession` 多一种来源

1. **不开新的宿主消息，给 `seedSession` 加 `kind:'imported-conversation'`**（决策 054 第 1 条本来就这样规划）。
   - 请求字段平铺：`{host:'seedSession', id, kind:'imported-conversation', conversation, logicalSessionId, cwd}`，与 `pi-file` 并列（协议类型 `DshSeedPiFileSource | DshSeedImportSource`）。
   - 答复仍是 `seeded`。导入成功时的结果是**带标签**的 `DshSeedImportResult`：`{kind:'imported-conversation', stubFile, dshSessionId, reused, images, report}`。迁移结果的形状不变、不加标签，P1-9c / 9d 已落地的答复逐字不变。
   - 迁移专有的字段（`source`、`converted`、`legacyPermissions`、`grants`）对导入没有意义，所以不共用一个结果类型。
   - Main 按请求的 kind 核对答复：迁移收到导入的结果、或反过来，都按 `DSH_HOST_SEED_MALFORMED` 立即失败，不等超时。
2. **协议守卫只查 `conversation` 是带 `entries` 数组的对象**。
   - 完整校验用 `isImportedConversation`，也就是 1.0.x 的 native worker 收导入请求时用的同一个函数，放在宿主里做；不合格报 `request/seed_conversation_invalid`。
   - 原因：`dshHostProtocol.ts` 被宿主按类型剥离加载，约定不做值导入。
3. **宿主执行 `seedImportedConversation`，与迁移共用从 admit 到 stub 的同一段**。
   - 这一段抽成 `seedAndStub`（图片入库 → 绑定后再校验 → create / flush / dispose → 冷读核对 → sidecar → 最后写桩），迁移的行为不变；
   - 导入的前半段是：校验 → P1-9b 的 `convertImportedConversation`（至少保留一条回复、展示行不进模型上下文，两条 1.0.x 校验都在里面）→ 查桩；
   - `cwd` 取请求里的（Main 解析后的工作区），与决策 121 第 10 条一致。
4. **桩已存在时，只认「同一次导入」**：
   - 同一逻辑 id、`origin` 是导入且转换器版本、`idPrefix`、`contentHash` 都相同、cwd 相同、会话读得回来 → 答 `reused:true`，什么都不写；
   - 其他一律 `stub/seed_stub_conflict`，不做迁移那种「替换没人说过话的」（决策 121 第 12 条）。
   - 理由：导入的逻辑 id 是 Main 每次新铸的 UUID。桩已经在，只可能是同一次导入的重试（宿主做完了但 Main 没收到答复），或者根本不是我们的。
5. **桩的 `origin` 改成两支**：
   - 迁移那支不变（`migratedAt`、`file`）；
   - 导入那支 = 转换器给的导入 origin（`sourceKind`、`stableSourceIdentity`、`sourceSessionId`、`contentHash`、`importerVersion`、`schemaVersion`、`idPrefix`、转换器版本）加 `importedAt`。没有 `file`：导入没有 Main 指定的会话文件。
   - `isSessionStub` 照旧只查 `origin` 是带 `kind` 的对象。lineage 的原因仍记 `create`。
6. **图片与授权**：导入没有图片（CC / Codex 的附件在 Main 侧就只是 display 诊断行），入库这一步对导入是空转；没有授权，照迁移的规则删掉半途留下的 sidecar，不写新的。

### 二、Main：导入改走宿主

7. **新模块 `src/main/services/legacyImport/DshLegacyImportHost.ts` 实现导入的三个引擎调用**，`LegacyImportService` 默认注入它（第一次用到时才建）：
   - `create` → `DshHostSupervisor.seedImportedConversation`（新方法）：与 `seedSession` 同一条消息、同一个 120 s 超时、同样挡住空闲停机、同样可以把宿主从 `failed` 拉回（导入是用户点的，带 `userInitiated`）；
   - `inspect` / `reconcile`：Main 自己看、删桩，不经宿主（第 13 条）；
   - `LegacyImportService` 的选项名 `createImport` / `inspectImport` / `reconcileImport` 保留，类型换成与引擎无关的 `LegacyImportEngine`；导入结果不再有 `dispose` / `forceKillNow` / `pid`（没有 worker 可释放）。
   - **`WorkerManager` 的 `createLegacyImport` / `inspectLegacyImport` / `reconcileLegacyImport` 不改走宿主，原样留作无调用方的旧代码**，P1-12 删（第 19 条）。方案分片 05 写的是「这三个方法改走宿主」：它们管的是导入 worker 的进程席位、slot 与强杀，宿主不需要这些；改走宿主等于在 `WorkerManager` 里再包一层无状态转发，没有收益。
8. **`legacyImport.targetPiSessionId` 的值定为 `aiclient-<逻辑 id>`**，即桩文件名里的 id。字段名是 ABI，不改。
   - 方案写的是「值改为 DSH 会话 id」。两者只在一种情况下不同：那个 id 下已经有别的日志，宿主顺延到 `_m<n>`（决策 121 第 12 条）。实际的会话 id 记在桩里。
   - 选桩名而不是宿主答复里的会话 id：Main 在问宿主之前就要把它写进导入清单（`reserve`），崩溃后对账要靠它找到桩。
9. **导入清单的文件名校验多认一种：`<target id>.dsh.json`**。原来只认 pi 的 `<id>.jsonl` 与 `_<id>.jsonl`；不加的话，重启后本构建写的导入记录会被当成坏记录丢掉，去重随之失效。
10. **索引行**：`agent: dsh`，`runtimeIdentity` 为桩；不写 `piLeaf`（首次恢复由 DSH 写）；不写 `model`（与 1.0.x 一致）；`unbound`、标题、工作区规则不变。
11. **失败怎么报**：
    - 宿主答失败、或传输失败时，导入条目的 `error` 只写阶段和码：`Import could not be written by the chat engine (<stage>/<code>)`；宿主的 message 可能含路径，只经脱敏进 Main 日志（沿用决策 121 第 17 条）。
    - 传输失败沿用迁移 `host` 阶段的四个码：`host_unavailable`、`host_exited`、`seed_timeout`、`seed_answer_invalid`。
    - 导入不自动重试（1.0.x 也不重试），用户再点一次导入即可；清单记 `failed`，是否「待清理」看清理的结果。
12. **撤回一次没提交成功的导入**（宿主写好了桩，但之后源文件变了、索引没提交、或提交后清单写失败）：
    - 删桩和桩旁的 sidecar。只删「文件名是本次 target id、内容 `engine: dsh` 且 `logicalSessionId` 是本次」的桩。
    - **DSH 日志留在盘上**。P1-3d 的回收只删空会话，这份日志有种子内容，不会被回收。方案写的「日志交给 P1-3d」与事实不符，这里更正；这与决策 121「替换未完成的迁移后旧日志留盘」同类，记为遗留。
13. **对账**（启动时一次，导入前再确认一次）：
    - `inspect` 报告「本次 target id 指向的桩」和「清单记的文件」里存在的那些；
    - `reconcile` 只删属于本次导入的桩（判定同第 12 条；清单记的桩若在另一个 `DSH_HOME` 下但文件名相同，也算）；
    - 文件名对得上、内容却指向别的会话的桩：不删，也不算「残留」。否则一份来历不明的文件会让导入永远停在「待清理」。
    - Main 按与启动宿主相同的规则（`resolveDshHome`）算 `DSH_HOME`，这样也能找到「宿主写了桩、Main 还没来得及记进清单」时留下的桩。
14. **1.0.x 留下的导入**：
    - `inspect` 照样报告它的 pi 文件，这样 1.0.x 已完成的导入仍被认成「已完成」；
    - **本构建从不删 pi 文件**：1.0.x 没做完的导入，对账时只删索引行，pi 文件留在原处（没有索引行指向，DSH 构建里看不见），这条记录计为已清理。
    - 理由：DSH 构建不写、不删 1.0.x 的会话文件，回装才安全。代价：这类极少见的孤儿 pi 文件不会被清掉。

### 三、去重认迁移对（分片 04 §5）

15. **判断「已导入」**：索引行的 `legacyImport`（`targetPiSessionId`、`dedupeKey`）与清单记录一致，并且满足以下之一，同时清单记的文件还在：
    - (a) 行的 `runtimeIdentity` 就是清单记的文件（本构建的导入是桩，1.0.x 没迁移的导入是 pi 文件）；
    - (b) 行是 `dsh` 且 `migratedFrom.runtimeIdentity` 是清单记的 pi 文件（1.0.x 的导入已被迁移，决策 051）。

    1.0.x 没迁移的导入因此照样算「已导入」，按决策 056 第 4 条由首次继续时的迁移接上，不重新导入。
16. **对账不拿走迁移过的会话**：
    - 1.0.x 留下的「导入中」记录，若它的行已被迁移成 dsh 行，直接补记完成，不要求 pi 文件还在；
    - 「失败待清理」的记录遇到迁移对，记为失败但不再待清理，行保留；
    - `removeImported` 也拒绝带 `migratedFrom` 的行：迁移提交出来的行是用户续聊过的会话，不是可以撤回的导入。

### 四、索引与静态守卫

17. **索引**：
    - `removeImported` 接受 `dsh` 行，也继续接受 `pi` 行（清理 1.0.x 的残留），其他条件不变；
    - `createImported` 加运行期守卫：带 `legacyImport` 的行必须是 `dsh`，否则拒绝。不带 `legacyImport` 的行照旧：pi TUI 把终端里新建的会话登记进来也用这个入口，P1-11 去掉 TUI 时一起删。
18. **静态守卫**（`legacyImportStatic.test.ts`，两条）：
    - `LegacyImportService.ts` 与 `DshLegacyImportHost.ts` 的代码（去掉注释后）不得出现 `PI_AGENT`、`agent: 'pi'`、`piLeaf`、`PiImportProcess` 与三个 pi 导入函数、`forkPiWorkerProcess`、`PiWorkerProcess`、`WorkerManager` / `workerManager`、`WorkerManager` 的三个导入方法、`worker.import`、`finalSessionFile`；服务里恰好一处 `agent: DSH_AGENT`，行的身份是宿主给的桩，默认引擎是 `DshLegacyImportHost`；`SessionIndexService` 里第 17 条的守卫在。
    - `src/main` 下代码里还叫得出 `PiImportProcess` 或那三个 `WorkerManager` 方法的文件，只能是 `WorkerManager.ts`、`WorkerManager.test.ts`、`PiImportProcess.test.ts`（`PiImportProcess.ts` 的代码不自称）。多出一个调用方就失败。

### 五、留给 P1-12 删除的清单

19. P1-9f 之后，下面这些已没有产品调用方，按 roadmap P1-12 的安排**留着不删**，删 runtime 时一起删：
    - `src/main/services/legacyImport/PiImportProcess.ts` 及 `__tests__/PiImportProcess.test.ts`；
    - `src/main/services/agent-host/WorkerManager.ts`：对 `PiImportProcess` 的导入；选项 `createImport` / `inspectImport` / `reconcileImport`；字段 `importSlotActive`、`activeImport`、`activeImportSlot`；方法 `createLegacyImport`、`inspectLegacyImport`、`reconcileLegacyImport`；`disposeAll` 里释放导入 slot 的那一段。`WorkerManager.test.ts` 里对应的用例一起删；
    - `src/shared/types/legacyImport.ts` 的 worker RPC 类型：`WorkerImportConversationPayload`、`WorkerImportConversationResult`、`WorkerInspectImportedSession*`、`WorkerReconcileImportedSession*`、`WorkerDiscardImportedSession*`、`isWorkerImportConversationPayload`（`ImportedConversation` 与 `isImportedConversation` 保留，宿主要用）；`src/shared/types/workerRpc.ts` 的 `isWorkerImportResult`、`isWorkerInspectImportedSessionResult`、`isWorkerReconcileImportedSessionResult`、`isWorkerDiscardImportedSessionResult`，以及两处的相应测试；
    - native worker 一侧：`src/runtime/worker/nativeImport.ts` 与 `src/runtime/__tests__/nativeImport.test.ts`；`src/agent-host/piWorkerRpcServer.ts`、`src/agent-host/worker.ts` 里的 `worker.import*` 处理；`src/agent-host/__tests__/workerEntryWiring.test.ts` 的导入用例；`scripts/probes/t34-legacy-import-probe.ts`；
    - 删之前：`scripts/gen-legacy-pi-fixtures.ts` 也用 `nativeImport` 生成 v4 语料（P1-9g），要先确认语料已经提交、不再重生成；
    - 删完后，本决策第 18 条第二个守卫的白名单改为空。

### 六、测试

20. 单测：
    - `DshLegacyImportHost.test.ts`（新）：请求带对 cwd 与 `userInitiated`、撤回删桩与 sidecar、target id 不对不问宿主、宿主失败只报阶段与码（消息不含路径）、四种传输失败的映射、桩名不对时拒绝并撤回、inspect 找桩也报 1.0.x 的 pi 文件、reconcile 不删 pi 文件与别人的桩、自己的桩删不掉算残留；
    - `LegacyImportService.test.ts`：夹具换成真的 `DshLegacyImportHost` 加一个照 bridge 写桩的假宿主；新增「提交 dsh 行」「宿主拒绝」「索引失败后撤回并能重导」；新增一组 1.0.x 导入：没迁移的与迁移过的都不重导、「导入中」的迁移对补记完成（pi 文件没了也一样）、「失败待清理」的迁移对保留、1.0.x 没做完的导入只删行不删文件、宿主写了桩而清单没记时对账删桩；原来的 worker 释放失败用例删掉（没有 worker 了）；
    - `SessionIndexService.test.ts`：`createImported` 拒绝 pi 导入行、不带导入记录的行照旧、`removeImported` 收 dsh 行且只收那一行、仍收 1.0.x 的 pi 导入行、拒绝迁移提交出来的行；
    - `DshHostSupervisor.test.ts`：导入按自己的 kind 发、结果原样交回、kind 对不上立即失败（两个方向）、宿主拒绝原样交回；
    - `dshHostProtocol.test.ts`、`channelMux.test.ts`、`seedSession.test.ts`（宿主）：请求与答复守卫、导入经同一个多路器转交、宿主对导入的种子与桩、同一次导入复用、冲突、三种拒绝、`seedSession` 按 kind 分派。
21. 真宿主：
    - 集成测试新增一个阶段：把仓库的 Codex rollout 夹具和一份按单测形状写的 Claude Code 记录放进临时目录（不读真实的 `~/.claude`、`~/.codex`），用产品的 `LegacyImportService` + `DshLegacyImportHost`（生产的 `DSH_HOME` 规则）导入。两条都成了 dsh 行、桩在盘上、再导一次都是「已导入」；恢复 Claude 那条后，下一轮 `P0-RECALL` 看得到提示和回复、看不到只供展示的工具行；源文件哈希不变。只用本地假网关。
    - bridge-smoke 的 J 主机加一项 `importedConversationSeeded`：导入 → 预览的消息 id 与转换器投影一致 → 恢复 → 召回 → 同一导入再做一次答 `reused`。

## 取舍

- **扩 `seedSession` 还是另开 `seedImport` 消息**：另开要在协议、多路器、supervisor 各加一套对称的收发与超时；扩 kind 只多一个分支，排队、超时、崩溃处理都现成。代价是答复要靠标签区分两种结果（第 1 条）。
- **Main 看、删桩，还是让宿主来**：看和删只是几个文件操作，Main 已有先例（启动时清扫暂存的 fork 桩）；交给宿主要为对账再加两种宿主操作，而对账发生在启动时，宿主多半还没起。
- **撤回时要不要连日志一起删**：DSH 没有删除接口，自己删目录要复刻 P1-3d 那套「持锁、确认、再删」；导入失败本来就少，先留盘，和决策 121 的同类遗留一起看增长。
- **1.0.x 的孤儿 pi 文件要不要删**：删掉更干净，但 DSH 构建就有了删 1.0.x 会话文件的代码路径，与「原文件不动、回装安全」相悖；它们在 DSH 构建里本来就看不见。

## 影响

- **用户看得见的不同**：导入完成的会话就是普通的 DSH 会话，打开、续聊都不再经过迁移（不会出现「正在迁移」）；1.0.x 时导入过的会话再导一次，显示「已导入」，不会多出一份，迁移过的也一样。
- **回装 1.0.x**：
  - 本构建导入的会话是 `dsh` 行，1.0.x 里看不到（与其他 DSH 会话一样）；
  - 1.0.x 读导入清单时会丢掉本构建写的记录（它的文件名校验不认 `.dsh.json`），回装后再导会在 1.0.x 里多一份 pi 会话；1.0.x 一旦写回清单，这些记录就没了，再升级回来时它们的去重也随之失效，同一来源再导会多一份 DSH 会话；
  - 1.0.x 自己导入过、在本构建迁移过的会话，1.0.x 里照常可见（决策 051），它的去重因行已改键而失效，这一点决策 051 已记为代价。
- **设置页与渲染层不改**：导入报告、失败文案、导入后刷新侧栏都照旧；决策 123 说的「导入后物化出的行是 `dsh`」成立，预测与卡片不需要改。

## 遗留

- **失败导入留下的 DSH 日志**（第 12 条）不会被回收，与决策 121 的同类遗留一起观察。
- **加密机上的导入源**：CC / Codex 源仍由 Main 读取，加密机上可能读到密文。这是 1.0.x 就有的问题，归 P1-13（方案 §8），本任务不改扫描位置。
- **大会话导入的耗时**：导入上限是 4000 条、每条文本 64 KB，仍按迁移的 120 s 超时；实验 E3（决策 122 遗留）做完后一起复核。
- **P1-12**：按第 19 条删除；删 `WorkerManager` 那几处时，第 18 条第二个守卫的白名单要同步改。

## 用户裁决（2026-09-29）

- **去重原则：「不怕重复，就怕漏」。** 回装 1.0.x 再升级回来后同一来源再导多出一份，可以接受。拿不准是不是导过时，宁可再导一份，也不能把没导过的会话判成「已导入」而跳过。现有去重逻辑要按这条复核：任何判「已导入」的分支，都必须能证明索引里确有这份会话。
- **加密机上的导入源**：保持「归 P1-13」。下一轮上机包在读取矩阵里补 `.jsonl` / `.json` 样本，确认 Main 能否读到 Claude Code / Codex 会话文件的明文。
