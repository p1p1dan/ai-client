Role: topic

# P1-9 无痛升级迁移：方案与就绪检查

上位：[roadmap P1-9](../roadmap.md)。

依据：
- 决策：[004](../decisions/004-branch-isolated-dsh-only.md) 第 3、6 条；[005](../decisions/005-legacy-pi-sessions-read-only-until-p1-9.md)；[006](../decisions/006-session-identity-stub-file.md)、[007](../decisions/007-flush-dsh-session-before-stub.md)；[008](../decisions/008-private-dsh-home.md)；[012](../decisions/012-bundled-node-carrier-on-all-platforms.md)；[026](../decisions/026-history-per-message-tree-across-lineage.md)、[027](../decisions/027-rewind-and-fork-via-seeded-child-sessions.md)；[030](../decisions/030-read-only-replay-via-host.md)；[035](../decisions/035-keep-our-model-ids.md)；[043](../decisions/043-grants-sidecar-next-to-stub.md)。
- 方案：[P1-1](p1-1-engine-cutover.md)、[P1-3](p1-3-shared-host.md)、[P1-4](p1-4-bridge-parity.md)、[P1-5](p1-5-models-and-credentials.md)、[P1-6](p1-6-permissions.md)。

明细分片：[01 pi 会话格式与解码链](p1-9-migration/01-pi-format.md) · [02 映射全表与设置](p1-9-migration/02-mapping.md) · [03 DSH 侧事实与写入方式](p1-9-migration/03-dsh-facts.md) · [04 索引、回装与哈希](p1-9-migration/04-index-rollback.md) · [05 测试、夹具与改动清单](p1-9-migration/05-tests-and-changes.md)。

状态：
- 只读调研，基线 worktree HEAD `130af7ba`。调研期间 HEAD 前进到 `c79596ae`，其中 `e3ce1691`（P1-1 收尾）改了渲染层的拒绝与草稿回退、WorkerManager 的目录下发，本文引用到的行号已复核；工作区里 P1-2 施工中的未提交改动（`src/dsh-host` 工具搬家等）不涉及本文引用的会话、索引、导入代码。
- 没有改代码，没有起宿主或 Electron，没有调用模型，没有读开发机上任何真实会话或索引。
- **方案待拍板**（§5）。
- DSH 以 `0.1.7-rc.2` 源码为准，路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`。v1.0.3 的行为用 `git show d23d72aa:<路径>` 核实，写作 `d23d72aa:…`。标「推断」「需实测」的没有运行验证。

## 1 结论先行

1. **能做，而且 DSH 有现成的写入口。**
   - `agents.create` 接受「重放历史」种子：不带 `isSeeded` 就不是 fork。创建时 loop 取得持久化句柄，把种子写进日志（`dsh-agent/lib/types/index.d.ts:48-104`；`dsh-agent-loop/README.md:115`）。
   - 转换就是在宿主里把 pi 活动分支翻成一串合法的 DSH v4 事件，交给 DSH 自己校验和落盘。不自己拼 zstd 帧。
2. **在宿主里转，首次「继续」时同步做**（D1、D5）。
   - 只看不迁：预览照旧由 Main 只读回放 pi 文件。
   - 续聊、fork、回退这类要引擎的操作才触发迁移。
   - 宿主是唯一在加密机上读得到 pi 明文、也唯一会写 DSH 日志的进程（决策 012）。
3. **回装的关键在索引，不在文件。**
   - v1.0.3 只认 `agent: pi`，`dsh` 行一律隐藏（`d23d72aa:…/sessionIndexMerge.ts:108-117`）。所以旧行不能就地改成 `dsh`，否则回装后旧会话从侧栏消失。
   - 推荐（D2）：逻辑 id 留给 DSH 会话，旧 pi 行原样搬到一个新键下保留。DSH 构建里隐藏它；回装 1.0.x 后它照常可见、可续聊。
4. **原文件不动，靠三道保证：**
   - 只读打开，不走 `JsonlSessionStore.open` / `prepareSessionConfig`：它们会加锁、修残尾、升级文件头、写 `.native-v4.jsonl`；
   - 转换前后比对 size、mtime、sha256；
   - 离线工具对整个 profile 副本做前后哈希清单，并把副本设成只读。
5. **映射大部分无损。**
   - 用户、助手、工具调用与结果、思考一一对应。助手消息按 DSH pi-ai 适配器的格式补 `replayState`，思考签名、`responseId` 这些重放细节也保住（`dsh-llm-pi-ai/lib/index.js:61-93`）。
   - 用量、时间戳、Stop 与插话原因（`turn/end`）、压缩（`compact-checkpoint` + `replace`）都有对应物。
   - 有损的：非活动分支（D3）、标签、每轮模型与档位变更记录、失败回复的半截正文、图片按 DSH 规则归一化、DSH 会话头的 `createdAt` 变成迁移时间。全表见分片 02。
6. **DSH 并非完全不能写自定义事件。**
   - 运行期 `Session.append` 确实设不了 `ignorable`（`dsh-session/lib/index.js:1401-1419`），决策 026 第 5 条的结论不变。
   - 但种子里可以带 `ignorable: true` 的未知事件：内存校验和读盘校验都放行；DSH 自己的 v3→v4 格式迁移还把这类事件改名为 `plugin:<名>` 原样保留（`dsh-session/lib/index.js:66-78,295-299`；`dsh-session-persistence/lib/index.js:170-195`；`dsh-session-format-v3-to-v4/README.md:187`）。
   - 推荐（D4）：用它承载只供展示或留档的数据（导入的展示行、委派记录、标签等）。授权记忆照决策 043 放 sidecar。这需要修订决策 026 第 5 条的适用范围。
7. **设置几乎不用迁。**
   - 逻辑 id 不变，模型、effort、档位都还在渲染层 localStorage 里（决策 035；P1-6 已有同样结论）。
   - 要迁的只有会话授权记忆（→ sidecar）。另外把 pi 文件里最后一次的 mode / gear 带回来，只在渲染层没给档位时用，与 1.0.x 的优先级一致。
8. **CC / Codex 导入直接产 DSH**（D8）：Main 侧的扫描和 `ImportedConversation` 不变，只换掉 native 写入器，与迁移共用同一个宿主操作和种子构造。
9. **规模：** 约 3～4 人周（粗估）。
   - 新写产品代码约 3.1k 行，另搬约 1.8k 行；测试约 3.2k 行。切成 P1-9a～h（§6）。
   - 硬依赖：P1-3a（宿主操作）；P1-4a（历史投影，否则迁移后时间线是空的）；P1-6a（授权编解码进 shared）。
10. **要用户拍板或授权的：** D2 索引策略、D4 自定义事件、D6 被 Stop 回复的语义；D1 口径请确认；真实数据离线测试在哪台机器、对哪份数据跑（§7.3）。另有两处 roadmap 缺口（§8）。

## 2 现状（明细见分片 01、04）

- **旧会话在哪、是什么格式。**
  - 索引是 `<userData>/session-index.json`，裸数组；`agent` 在盘上是字符串，读旧行不做归一化（`sessionIndex.ts:1-9,61-70`；`SessionIndexService.ts:95-97`）。
  - 会话文件：自有 runtime 写在 `~/.pilab/<profile>/pi-agent/sessions/<逻辑 id>.jsonl`（`nativeWorkerRuntime.ts:1160`）；TUI 的 `/new` 出来的会话在原文件旁边（`piTuiSession.ts:49-62`）。
  - 格式有五代：pi v1 / v2 / v3、PI-Desktop schema 1、native v4、夹着 CLI 行的 v4、导入产生的 v4。
- **「复制转换、原文件不动」在 1.0.x 已有先例。** 旧格式打开时复制成 `<file>.native-v4.jsonl`，记下源 sha256，索引改绑到副本（`legacy.ts:537-623`；`NativeSessionIndexAdapter.ts:64-83`）。
- **1.0.x 自己打开文件会改它。** `JsonlSessionStore.open` 取写锁，修残尾、删坏的中间行、升级文件头（`store.ts:188-277`）。只读回放是例外，只解码不写（`SessionReplayReader.ts:14-31`）。迁移必须走后一条路。
- **P1-1 之后的状态。**
  - 带身份的 `pi` 行只读：恢复、发送、fork 都报 `legacy_session_readonly`（`chat.ts:135-160,302-307,513-514`），预览照旧。
  - 没有身份的空行直接改绑成 DSH 新会话，这是「同一 id 就地换引擎」的先例（`chat.ts:540-575`）。
- **导入。** Main 扫描 CC / Codex，得到与引擎无关的 `ImportedConversation`；再拉 native worker 写成 v4，索引写 `agent: pi`（`LegacyImportService.ts:316-395`；`nativeImport.ts:110-270`）。工具调用多半是只供展示的 display 行（`ClaudeSourceAdapter.ts:419-440`；`CodexRollout.ts:162-183`）。
- **按会话的设置。**
  - 渲染层 localStorage 按逻辑 id 存模型、effort、档位（`sessionPreferenceStore.ts:12-26,143`），恢复时发给 Main（`useResumeSession.ts:50`）。1.0.x 的优先级是「payload 覆盖文件」（`runtime/bootstrap.ts:371-379`）。
  - 授权记忆只在 pi 文件里：custom 条目 `aiclient.permissionGrants`，v2 编码，活动分支上最后一条为准（`grants.ts:288-363`）。

## 3 DSH 侧事实（明细与出处见分片 03）

- **种子**：从 seq 0 连续；构造器校验信封、消息形状、surface 转换，末尾自动补一个不带标记的 `session/end-seed`（`dsh-session/lib/index.js:1283-1312`）。`meta` 不收 `createdAt`（`dsh-agent/lib/types/index.d.ts:55-71`）。
- **合法结构照 loop 的写法**：`turn/start` → `step/start` → （仅首步）`system/message` → `user/message` → `assistant/message` → `tool/call`… → `tool/result`… → `step/end` → `turn/end`（`dsh-agent-loop/lib/index.js:936-1145`）。
- **可以省略的**：
  - `request/header` / `request/context`：日志里没有时，第一次真实请求记 `initial`（`:1187-1215`）；
  - 助手消息的 `stream` 可以是空数组：读盘只验数组；格式迁移的全量校验遇到空流跳过内容比对（`dsh-session-persistence-jsonl/lib/index.js:1833-1849`）。
- **系统提示**：种子首步放一个空的 `system/message` 占住 0 号节点。我方路由都走 `llm-pi-ai`，它不声明 `in-history`，所以恢复后第一步会把这个空头原地换成 DSH 的提示词（`dsh-agent-loop/lib/index.js:264-283`；E1 验证）。不放的话，提示词会追加在整段历史之后。
- **重放与用量**：
  - 适配器靠 `source.replayState`（`kind:'pi-ai', version:2`）还原签名等字段；对不上就降级为普通历史，不报错（`dsh-llm-pi-ai/lib/index.js:183-259`）。
  - 用量按 `mapUsage` 换算（`:1367-1375`）。
- **压缩**：检查点是 `source.kind:'compact-checkpoint'` 的 user 消息，用 `replace` 遮住从第一个非系统节点起的一段，最近的尾巴原样保留（`dsh-compaction-basic/README.md`；`dsh-compaction/lib/index.js:109-130`）。
- **结束原因**：`aborted` 有专门的 `{kind:'legacy'}`，给「导入时原记录没写原因」用（`dsh-session/lib/types/types.d.ts:158-161`）；`interrupted` 是持久的收尾原因。
- **图片**：必须先经 `ctx.attachments` 入库。入库会归一化（2048² 像素、4 MiB，干净的 PNG / JPEG / WebP 原样通过），永不自动删除（`dsh-attachment-local/README.md:46,55,86`）。

## 4 方案

**4.1 触发与流程**（D1、D5）

1. 渲染层对 pi 行照常发「恢复」。Main 发现是带身份的 pi 行，就走迁移，不再报只读：
   1. 同一会话互斥；先让内嵌 TUI 交出这个文件（沿用 `handOverFromTui`，`chat.ts:180`）；记下源文件的 size、mtime。
   2. 调宿主的新操作 `seedSession {kind:'pi-file', sourceFile, logicalSessionId, cwd, expect}`（P1-3 协议追加）。
   3. 宿主依次：只读读源、算 sha256 → 解码活动分支（旧格式先找 `.native-v4.jsonl` 副本，规则同 1.0.x）→ 构造种子 → 图片入库 → `agents.create({seed})` → `sessions.flush` → 用 `observeSession` 核对事件数 → dispose → 写授权 sidecar → 原子写桩（加 `origin`）→ 回报告。
   4. Main 做一次原子索引事务（§4.4），然后按普通 DSH 行恢复。之后的发送照常。
2. 预览不触发迁移。加密机上 Main 读不到明文，预览会失败并退回恢复，于是在那里「点开即迁移」，结果一样。
3. 失败时：任何一步失败，索引都不动，行仍是 pi，预览照常。渲染层给出「无法迁移」卡片（带错误码），替换现在的只读卡片。

**4.2 转换规则**（全表见分片 02）

- **切分**：只转活动分支（D3 A）。一次运行 = 一个 turn，一条助手消息 = 一个 step。
  - 人类消息和 `subagent-report` 开新回合；`project-instructions`、`turn-ceiling` 进下一步的输入。
  - 工具结果并进它所属的 step。
  - 运行中崩溃留下的悬空调用，补 `TOOL_OUTCOME_UNKNOWN` 结果，回合以 `interrupted` 收尾。
- **`turn/end` 原因**：
  - 正常结束 → `completed`；`length` → `max-tokens`；
  - `aiclient.runStop` 的 `user_stop` → `aborted{user}`；`interjected` → `aborted{hook:'aiclient-interject'}`（与 P1-4 D4 一致）；
  - 没有 runStop 记录的 aborted → `aborted{legacy}`；error → `error`。
- **失败与中断的回复**（D6）：aborted 且有正文 → `assistant/message {interrupted:true}`，去掉没派发的工具调用；error → `assistant/attempt`（空流）。
- **消息 id 复用 pi 条目 id**（D7）：预览时的 `h:<条目 id>` 与迁移后投影出的 `h:<MessageId>` 相同，渲染层合并无缝。合成的消息用「条目 id + 后缀」。
- **模型可见内容与 1.0.x 一致**：
  - `bashExecution`、custom 角色消息、分支摘要按 pi 的 `convertToLlm` 渲染成 user 文本，来源 kind 各自独立，界面照 1.0.x 显示或隐藏；
  - 压缩按锚点定遮盖区间；找不到锚点就只留摘要，与 CLI 的降级一致。
- **非模型内容**：
  - `aiclient.permissionGrants` → sidecar；`aiclient.permissions` → 报告里的 `legacyPermissions`；
  - 导入的展示行与来源说明、委派记录、标签、其他 custom → `ignorable` 事件（D4）；
  - `model_change` 等簿记行丢弃。

**4.3 写入方式与幂等**

- 在宿主里用 DSH API 生成，不自己拼 zstd。五条理由见分片 03 §6：物理编码是 DSH 私有的且会随代际变化；构造器校验；内核写锁；加密机上只有宿主是白名单载体；附件库的 fsync 链。
- 幂等与原子：
  - 种子是（源字节，转换器版本）的纯函数，id 和时间都取自源文件；
  - DSH 会话 id 用决策 006 的 `aiclient-<逻辑 id>`。已存在时（上次迁移半途而废），事件数与摘要一致就复用，否则改用 `….m<n>`；桩丢失时的反查规则要把 `.m*` 算进去；
  - 已有桩且 `origin.sourceSha256` 等于当前源 → 跳过转换，直接复用；
  - 提交点是那一次索引原子写。在它之前崩溃，只会留下孤儿日志或桩，由 P1-3d 清理，下次重做。
- 宿主内一次只做一个迁移，各阶段之间让出事件循环（耗时与内存估算见分片 03 §7）。

**4.4 索引与回装**（D2；明细与崩溃窗口表见分片 04）

- 一次原子写做两件事：
  - 旧 pi 行原样复制到新键（示意为 `<逻辑 id>~pi`），只加一个 `migratedTo`。文件路径、`piLeaf`、标题、归档、`legacyImport`、`updatedAt` 都不变。
  - 原逻辑 id 这一行改绑：`agent: dsh`，`runtimeIdentity` = 桩，去掉 `piLeaf`，加 `migratedFrom {legacySessionId, runtimeIdentity, sourceSha256, sourceBytes, sourceMtimeMs, migratedAt}`。
- DSH 构建：
  - `list()` 时，被 `migratedFrom` 引用、且源文件 size / mtime 没变的 pi 行标成隐藏；
  - 变了（说明回装后在 1.0.x 里续聊过）就显示，并标「1.0.x 里有新内容」；再次继续时迁成一个新会话；
  - `trimToCapacity` 不删被引用的 pi 行。
- 回装 1.0.x：
  - 改键后的 pi 行是 `agent: pi`，照常显示、预览、续聊；
  - `dsh` 行被隐藏，原样留在盘上（1.0.3 加载时不归一化，flush 整表回写）；
  - 迁移时渲染层把四个会话偏好键复制一份到新键下，回装后档位和模型也还在。

**4.5 设置迁移**（全表见分片 02 §4）

- 模型、effort、mode / gear：都不迁移（逻辑 id 不变）。协议被 P1-5 过滤掉的模型由菜单兜底，报告里计数。
- `legacyPermissions`：只在渲染层没发档位时用于首次恢复，与 1.0.x 的 `{...文件, ...payload}` 等价。
- 会话授权记忆：从活动分支读最后一条 `aiclient.permissionGrants`，写成 sidecar（决策 043，v2 编码）。
- 设置页加 P1-5 转交的三条说明：`subagentPromptCacheTtl` 失效、空闲超时 0 的新含义、不受支持的协议。

**4.6 CC / Codex 导入**（D8）

- `LegacyImportService` 注入宿主实现，替换 `createImport` / `inspectImport` / `reconcileImport`（`LegacyImportService.ts:133-138`）。
- 宿主操作用 `seedSession {kind:'imported-conversation', conversation, logicalSessionId, cwd}`；display 行写成 ignorable 事件，界面与 1.0.x 一致，并且不进模型上下文。
- 索引行写 `agent: dsh`，`runtimeIdentity` 为桩。`legacyImport.targetPiSessionId` 是 ABI 字段名，保留不改，值改为 DSH 会话 id。去重要认迁移对（分片 04 §5）。
- 已经导入成 pi 的旧会话走 §4.1 的迁移，不重新导入。

## 5 需要拍板的决策点

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| D1 | 何时迁移（请用户确认口径） | A 首次「继续」时同步迁移，只看不迁；B 首次点开就迁；C 升级后后台批量迁；D A 加设置页的「全部迁移」 | A | 把决策 004 的「首次打开」理解为「首次续聊」；只看的会话不产生副本，回装后最干净；批量迁移会在首次启动时压满共享宿主 | 首次续聊多等约 0.5～2 s（推断）；加密机上等价于 B |
| D2 | **索引与逻辑 id（需用户拍板）** | A 逻辑 id 给 DSH，旧 pi 行改键保留；B DSH 用新逻辑 id，旧行原样不动；C 旧行就地改成 dsh | A | 渲染层不用换 id，发送流程不变；有 P1-1 空行改绑的先例；回装后旧会话照常可见 | pi 行换了键：回装后，1.0.x 对这类导入会话的去重会失效（重导会多一份）；偏好要复制一份。B 回装最干净，但渲染层要在一次发送中途换活动会话；C 回装后旧会话消失，违反决策 004 |
| D3 | pi 会话内的分支 | A 只转活动分支；B 旁支转成退役 DSH 会话，挂进 lineage；C 旁支条目作为 opaque 事件留档 | A 先做；B 列为可选的 P1-9h（P1-4b 之后） | 1.0.x 的历史本来只显示活动分支；B 依赖 P1-4b 的 lineage 与树，旁支多时存储成倍 | A 下树对话框看不到迁移前的旁支（原文件里还在，回装可见） |
| D4 | **自定义事件（需用户拍板，修订决策 026 第 5 条）** | A 只在种子里写 `ignorable:true` 的 `aiclient/*` 事件，运行期仍禁止；B 另写 sidecar；C 丢弃 | A | DSH 为下游插件事件设计的正规机制，读盘、格式迁移都保留；事件天然按位置排序，fork 会一起带走（需实测 E2） | 依赖以后的 DSH 仍保留这类事件，投影要同时认 `plugin:` 前缀；B 要自己处理 fork 与 GC；C 会让导入会话的工具行全部消失 |
| D5 | 在哪转、怎么写 | A 宿主级操作 `seedSession`：create(seed) → flush → 核对 → dispose，之后走标准恢复；B 在目标 slot 的 bootstrap 里迁移并直接接管；C 低层 `sessionPersistence.create/append`；D Main 自己写日志 | A | 与导入、离线工具走同一套代码；与 slot 生命周期解耦；经过 DSH 的完整校验 | 多一次恢复，大会话要多读一遍日志。B 省掉这一次，但迁移会被算进 bootstrap 超时；C 绕过 agent 层的校验与插件；D 否决（格式、锁、加密机） |
| D6 | **被 Stop 的回复（需用户拍板）** | A aborted 有正文 → 带 `interrupted` 的助手消息（模型可见），error → attempt；B 一律 attempt | A | 与 DSH 自己 Stop 时的落盘一致；界面保留被停回复的半截正文 | 迁移后模型会看到 1.0.x 时看不到的半截回复（多一点 token）。B 与 1.0.x 的模型上下文完全一致，但半截正文从界面消失 |
| D7 | 消息 id | A 复用 pi 条目 id；B 新铸 UUID | A | 确定性：幂等、金样本稳定；从预览到恢复 `h:` id 不变 | 同一段历史在两次迁移出的会话里 id 相同（fork 本来就是这样，无害） |
| D8 | 导入路径 | A `ImportedConversation` 直接产 DSH 种子；B 先写 pi 再转 | A | 少一跳；native 写入器要在 P1-12 删掉 | Main 侧扫描器不动，只换写入器 |

D1、D3、D5、D7、D8 可以按工作方式自主决定，每条单独写一份决策文件（编号接续 049），标「待审批」。D2、D4、D6 请用户拍板。真实数据测试的授权见 §7.3。

## 6 子任务切分与改动清单（文件级明细见分片 05 §4）

| 子任务 | 内容 | 约（产品 / 测试） | 依赖 |
|---|---|---|---|
| P1-9a 解码链进 shared | codec、legacy、timeline、tree 搬到 `src/shared/legacyPiSession/`；vendor `buildSessionContext` 的子集（MIT）；去掉 `pi-agent-core` 运行期依赖；`decodeSession` 加「容忍未完成操作」；原位置改成 re-export | 搬约 1.8k，新约 150 / 改 import 约 30 处 | 无，现在就能做；也是 P1-12 的前置 |
| P1-9b 纯转换器 | pi 活动分支 / 导入 → 中间表示 → 种子；replayState、用量、压缩区间、ignorable 事件、授权、报告；自带不变量检查器 | 约 1.1k / 1.3k | a；事件类型与 P1-4a 共用 |
| P1-9c 宿主执行 | `seedSession`：只读读源、哈希、副本解析、图片入库、create / flush / 核对 / dispose、sidecar、桩的 `origin`、幂等；bridge-smoke 场景 | 约 400 / 500 | b；P1-3a；P1-6a；实验 E1、E2 |
| P1-9d Main 编排与索引 | 迁移服务（互斥、TUI 交接、stat、错误码）；`commitMigrated`；list 的隐藏与分叉标记；trim 保护；恢复路径去掉只读 | 约 450 / 550 | c；P1-4a |
| P1-9e 渲染层 | 隐藏已迁移的 pi 行、分叉标记、迁移中状态、失败卡片、偏好复制、设置页三条说明 | 约 130 / 200 | d |
| P1-9f 导入产 DSH | 注入宿主实现；行写 `dsh`；去重认迁移对；静态守卫 | 约 200 / 350 | c |
| P1-9g 离线工具与夹具 | v4 语料生成（必须在 P1-12 之前）；`migrate-offline.ts`；回装演练；证据模板 | 约 600 / 夹具 | 语料现在就能做；工具在 c 之后 |
| P1-9h（可选）旁支转 lineage | D3 B | 约 250 / 300 | P1-4b |

- **顺序**：a 与 g 的语料先行 → b（可与 P1-4a 并行）→ c → d、e、f（并行代理最多 2 个）→ g 的收口 → h 可放到合入之后。d、e 落地即解除决策 005。
- **边界**（全表见分片 05 §6）：
  - P1-3：加 `seedSession` 操作；清理要跳过持锁和刚创建的会话。
  - P1-4：投影加 5 条规则。
  - P1-5：模型 id 不变；R 系列顺带验证历史工具名。
  - P1-6：sidecar 与 `tool` 词表。
  - P1-7：委派记录要不要渲染。
  - P1-11：pi TUI 若保留，只能开没迁移过的行。
  - P1-12：删 runtime 之前 a、g 的语料、f 都要完成。
  - P1-13：加密机上跑一轮离线工具。

## 7 测试方案（明细见分片 05）

**7.1 单测（根 vitest，不装 DSH）**
- 映射规则一条一例；B01～B06 与 v4 语料、损坏样本、导入样本各出三类金样本：种子、投影、报告。
- 自带的不变量检查器跑遍全部种子。
- pi 投影与 DSH 投影逐条比对（E4）；列出预期差异（D3、D6 等）。
- 索引事务：改键行除 `sessionId`、`migratedTo` 外逐字段相同；按 1.0.3 的规则（只认 `pi`）重算可见性，原来可见的会话都还可见。
- 静态守卫：迁移模块不 import 会写文件的入口，不对源路径调用写接口。

**7.2 真宿主（bridge-smoke 风格）**
- 实验 E1～E3，之后固化为场景：迁移 → 恢复 → 假网关跑一轮；重复迁移（幂等）；中途 SIGKILL 后重做；导入 → 恢复；大会话的耗时与 RSS。

**7.3 真实数据离线迁移测试（退出判据，需用户授权）**
1. 用户指定机器与 profile：候选是开发机，以及跑过 1.0.x 的 Windows 办公机；加密机那一轮并入 P1-13。
2. 用户退出应用。
3. 用户本人运行工具（`src/dsh-host/tools/migrate-offline.ts`；开发机从检出目录跑，Windows 机器用 P0-4 那样的上机包），或明确授权某个代理在这台机器上运行、且只看报告：
   - `--snapshot` 复制 profile 与 `session-index.json`，生成哈希清单，把副本设为只读；
   - `--convert` 起私有宿主（不配模型路由、不联网），用产品同一套代码逐会话迁移；
   - `--verify` 重算清单并比对。
4. 报告只有计数、哈希、错误码、耗时、内存，路径与 id 加盐哈希，不含任何正文、标题、文件名。
5. 用户过目报告后，决定哪些进 `evidence/`；副本和工作目录留在本机，由用户删除。

**7.4 回装演练（合成数据，代理可做）**
- 开发机隔离 HOME：v1.0.3 建会话 → DSH 构建迁移 → 换回 v1.0.3 核对可见、可续聊、哈希不变 → 在 1.0.3 续聊后再升级，核对分叉显示（步骤见分片 04 §7）。

**7.5 退出判据对照**
- 「用 1.0.x 的真实数据做离线迁移测试」= 7.3 的报告落证据，失败项全部有结论。
- 「原文件哈希不变」= 7.3 的 `--verify` 与 7.1 的单测。
- 「回装 1.0.x 仍可读旧会话」= 7.4 的演练，加 7.1 的可见性重算。

## 8 风险与未覆盖

- **需实测**：E1（seed 创建 → 释放 → 马上恢复，以及首轮：空系统头被替换、`initial` 头、适配器不报错）；E2（ignorable 事件读盘、冷读、fork 往返）；E3（2000 条与 32 MiB 两档的耗时与内存；估算见分片 03 §7，32 MiB 可能占 200～350 MB）。
- **格式漂移**：DSH 升级可能收紧种子校验或改 ignorable 规则。钉版本加金样本比对是第一道警报。
- **推断未证**：主流 provider 接受「历史里出现当前工具表之外的工具名」。1.0.x 的工具名（`read`、`bash`…）与 DSH 的不同，要在 P1-5 的真实网关 R 系列里顺带验证。
- **行为差异**：
  - D6 下，被 Stop 的半截回复进入模型上下文；
  - 图片可能被重编码；如果最终不随包带 sharp（Q007），非「干净」的图片入库失败，退成文本占位（推断）；
  - DSH 会话头的时间是迁移时刻；
  - 迁移前的旁支在树里看不到（D3 A）。
- **回装的边角**：1.0.x 的导入去重对迁移过的导入会话失效；索引超过 2000 行时，1.0.x 的裁剪可能删掉 dsh 行；1.0.x 的启动清扫会删掉暂存中被打断的 DSH fork 子桩（无害）。
- **并发**：迁移时内嵌 TUI 正在写同一文件，靠交接与读前后 stat 比对兜住；P1-3d 清理与迁移的竞争见分片 04 §3。
- **磁盘**：DSH 日志（zstd）加图片，总占用约为原来的 1.1～1.3 倍（推断）；附件永不自动删除。
- **加密机上的导入**：CC / Codex 源由 Main 读取，在加密机上可能是密文。这是 1.0.x 已有的问题，归 P1-13 核实，P1-9 不改扫描位置。
- **roadmap 缺口（建议补登）**：
  1. pi-agent 目录下的用户资产：全局 `AGENTS.md`、自定义子代理、skills、prompts、`mcp.json`、pi 插件。切到 DSH 后由谁接管、怎么迁，没有条目认领（P1-6 只接了权限策略文件，P1-5 只接了模型与凭据）。建议并入 P1-10，或新开 P1-16。
  2. P1-12 条目里补登：删 runtime 之前要先完成 P1-9a（解码链进 shared）和 P1-9g 的 v4 语料，`PiImportProcess` 要等 P1-9f 之后才能删。
