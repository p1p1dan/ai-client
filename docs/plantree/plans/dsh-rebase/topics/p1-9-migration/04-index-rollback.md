# P1-9 分片 04 · 索引、回装与原文件哈希

Role: detail shard。上位：[P1-9 方案](../p1-9-migration.md)。回答调研问题 4。v1.0.3 的行为用 `git -C <worktree> show d23d72aa:<路径>` 读代码核实，下文写作 `d23d72aa:<路径>:行号`；没有安装或运行 1.0.3。

## 1 v1.0.3 遇到 DSH 数据会怎样

| 场景 | v1.0.3 的行为 | 依据 |
|---|---|---|
| 索引里有 `agent:'dsh'` 的行 | 词表只有 `pi`，`resolveAgentWireName` 返回 null，渲染层直接隐藏这一行 | `d23d72aa:src/shared/types/agentWire.ts:13,36-38`；`d23d72aa:src/renderer/components/chat/sessionIndex/sessionIndexMerge.ts:108-117` |
| 同上，Main 侧 | 新建、登记会话前 `assertPiCompatibleIndexRow` 拒绝非 pi 行 | `d23d72aa:src/main/ipc/chat.ts:124-132,302,419` |
| 加载与回写索引 | 加载时不做归一化，未知字段原样留在内存；每次 flush 整表回写，所以 dsh 行和新增字段都保留 | `d23d72aa:src/shared/types/sessionIndex.ts` 头注释；`d23d72aa:src/main/services/chat/SessionIndexService.ts:106-139` |
| 已有行被重写 | `recordCreated` 按字段重建（会丢未知字段），但只在新建、登记时调用；`commitResumed` 以原行为底展开，不丢字段 | `d23d72aa:…/SessionIndexService.ts:211,294-330`；`d23d72aa:src/main/ipc/chat.ts:314,420` |
| 超过 2000 行 | 先删归档行，再删最久没动的行，dsh 行也可能被删 | `d23d72aa:…/SessionIndexService.ts:752` |
| 启动清扫 | 只读索引行指向的目录（包括 `$DSH_HOME/aiclient-sessions`），只删带 `.staged` 标记且没被任何行认领的文件 | `d23d72aa:src/main/services/agent-host/WorkerManager.ts:628-702` |
| `dsh-home` 目录 | 不读不写 | 1.0.3 没有任何引用 |

结论：

- `dsh` 行在 1.0.x 里被隐藏，并原样保留在盘上。重新升级后照常可用。
- 唯一的交互是启动清扫：它可能删掉「P1-4b 的 fork 在暂存状态下被回装打断」留下的子桩。那本来就是没被接受的 fork，无害；DSH 日志留给 P1-3d 清理。
- 一个 `agent:'pi'`、指向未改动 pi 文件的行，在 1.0.x 里与升级前完全一样：可见、能预览、能续聊。

## 2 索引策略比较（D2）

| | A 逻辑 id 给 DSH，旧行改键保留（推荐） | B DSH 用新逻辑 id，旧行原样 | C 旧行就地改成 dsh |
|---|---|---|---|
| DSH 构建里 | 同一个会话键、同一个侧栏行、同一套偏好；发送流程不用换 id；P1-1 已有「pi 空行就地改绑 DSH」的先例（`chat.ts:540-575`） | 侧栏出现新行、旧行隐藏；渲染层要在一次发送的中途把活动会话换成新 id，同时处理偏好、草稿、运行态 | 同 A |
| 回装 1.0.x | 改键后的 pi 行照常显示、可续聊；偏好在迁移时已复制到新键下 | 旧行与升级前逐字节相同，最干净 | **旧会话从侧栏消失**：行变成 dsh 被隐藏，pi 文件还在但没有行指向它。违反决策 004 第 3 条 |
| 1.0.x 的导入去重 | 导入清单记的是旧逻辑 id，回装后指向 dsh 行，对不上，重新导入同一个 CC 会话会多出一份 | 不受影响 | — |
| 再次升级 | DSH 行照常；若 pi 文件在 1.0.x 里被续聊过，按 §4 显示为分叉 | 同 A | — |
| 改动量 | Main 一个原子事务，渲染层小改 | 渲染层换 id 的改动大、风险高 | 最小，但不可接受 |

## 3 推荐 A 的索引事务 `commitMigrated`

**迁移前**（示意，只列相关字段）：

```
{ sessionId: S, agent: 'pi', runtimeIdentity: P, piLeaf: L, title, workspacePath: W, model, unbound?, archived, updatedAt: T0, legacyImport? }
```

**一次原子写之后**：

```
{ sessionId: S~pi, agent: 'pi', runtimeIdentity: P, piLeaf: L, title, workspacePath: W, model, unbound?, archived, updatedAt: T0, legacyImport?, migratedTo: S }
{ sessionId: S, agent: 'dsh', runtimeIdentity: <桩>, title, workspacePath: W, model, unbound?, archived, updatedAt: now, legacyImport?,
  migratedFrom: { legacySessionId: 'S~pi', runtimeIdentity: P, sourceSha256, sourceBytes, sourceMtimeMs, migratedAt, converter: 'pi-dsh/1' } }
```

- `S~pi` 只是示意，字面量在 P1-9d 定：要是合法的路径片段，因为 scratch 目录按会话 id 建；也要确定性，这样重做事务会得到同一个键。
- 改键的 pi 行除了 `sessionId` 和新增的 `migratedTo` 以外，逐字段相同，`updatedAt` 也不动。
- DSH 行去掉 `piLeaf`，由首次恢复时的 `worker.tree` 重新写入。`legacyImport` 两边都留：DSH 构建的导入去重要认得迁移对（§5）。
- 沿用 `SessionIndexService` 的写法：先改内存、整表原子写，失败回滚内存（`SessionIndexService.ts:700-725`）。
- 渲染层在事务成功后，把 `session-models`、`session-efforts`、`session-permissions`、`session-tiers` 四个 localStorage 键里 `S` 的值复制到 `S~pi` 下（只增不删），回装后偏好还在。

**崩溃窗口**（提交点就是这一次原子写）

| 断在哪 | 盘上状态 | 下次继续时 | 结果 |
|---|---|---|---|
| 宿主写日志之前或之中 | 可能有残缺的 `aiclient-S` 日志 | `SessionAlreadyExistsError` → 核对事件数与摘要，一致就复用，否则用 `aiclient-S.m2` | 重做；残缺日志由 P1-3d 清理 |
| 日志已落盘，桩还没写 | 孤儿日志 | 同上 | 重做 |
| 桩已写，索引还没提交 | 桩没被任何行引用 | 桩里 `origin.sourceSha256` 等于当前源 → 直接复用，跳过转换 | 只补提交 |
| 索引已提交，恢复还没成功 | 行已是 dsh | 按普通 DSH 行恢复 | 完成 |

P1-3d 的清理要注意一点：迁移刚落盘、索引还没提交时，新日志是「未被引用」的。清理必须跳过持锁的会话，以及最近几分钟内创建的会话，否则可能删掉正在迁移的日志（P1-3d 的方案已经「取写锁、删目录」，持锁的会被跳过；最近创建的这一条要补上）。

## 4 隐藏、分叉与再次迁移

- DSH 构建的 `list()` 给每个 pi 行算一个派生标记，不落盘：
  - 被某个 dsh 行的 `migratedFrom.legacySessionId` 引用，且 `stat(P)` 的 size、mtime 与记录相同 → `hiddenByMigration`，侧栏不显示；
  - 被引用但 size 或 mtime 变了 → `migrationDiverged`：显示，并标「这个会话在 1.0.x 里有新内容」。用户再次继续时，按 A 迁成新会话，以这个 pi 行自己的 id 为逻辑 id。
- mtime 只作快速判断；真正比较 sha256 在宿主里做（加密机上只有它读得到明文）。
- `trimToCapacity` 不删被 `migratedFrom` 引用的 pi 行；只在 dsh 行本身被删时一起删。否则回装后这些会话会从 1.0.x 消失。
- 被隐藏的 pi 行不能开 TUI；dsh 行本来就拒绝 TUI（P1-1 R6）。

## 5 导入去重与迁移对

- DSH 构建的导入去重（`LegacyImportService.ts:296-313`）判断「已导入」时，除了「行的 `runtimeIdentity` 等于清单记的文件」以外，再认一种情况：行的 `migratedFrom.runtimeIdentity` 等于清单记的文件。否则迁移过的导入会话再导一次会重复。
- `removeImported` 目前要求 `agent === 'pi'`（`SessionIndexService.ts:384-409`），导入改产 DSH 后要接受 `dsh`。

## 6 原文件哈希不变：怎么保证、怎么验证

**保证**（按设计）

1. **只读打开**：转换器只 `open(path, 'r')` 并一次读完，不调任何写、改名、删除、`utimes`。解码链产生的修复文本（`document.repair`）直接丢弃，不写回。
2. **不走会写文件的入口**：`JsonlSessionStore.open`、`prepareSessionConfig`、`acquireWriterLock` 都会在源文件或它旁边写东西（分片 01 §5）。静态守卫（新增 `legacyMigrationStatic.test.ts`）要求迁移模块不 import 它们，也不对源路径调用 fs 的写接口。
3. **读前后比对**：转换前记 size / mtime，读完再 `stat` 一次；变了就放弃（源文件正被写），报 `source_busy`，可重试。转换前先让内嵌 TUI 交出这个文件（`chat.ts:180`）。
4. **来源记录**：桩的 `origin` 和 dsh 行的 `migratedFrom` 记下 sha256、字节数、mtime，供分叉判断和事后核对。

**验证**

- 单测：每个夹具转换前后读源字节比对（`sessionLegacy.test.ts:75`、`:134` 已有同样写法）。
- 离线工具（分片 05 §3）：
  - 对整个 profile 副本做前后两份 sha256 清单，必须完全相同；
  - 副本先设成只读（Linux `chmod -R a-w`，Windows 设只读属性），任何写入都会直接报错。
- 回装演练（§7）：演练结束后，对 pi 文件再做一次哈希比对。

**不在保证范围内的**

- 回装之后，1.0.x 自己打开 pi 文件时会修残尾、升级头（`store.ts:240-270`）。这是 1.0.x 的正常行为，发生在迁移之外。
- 内嵌 pi TUI 续聊会追加内容（P1-11 定去留）。这属于用户的正常写入，会让会话进入 §4 的分叉状态。

## 7 回装演练（合成数据，不需要真实数据）

在开发机上用隔离 HOME 和假网关（P1-1 GUI 点验的配方）：

1. 用 v1.0.3 构建（main 的 `d23d72aa`）新建几个会话：纯文本、工具回合、发图、压缩、重试、回退出的旁支、Stop、插话，外加一次 CC 导入。
2. 退出，记下 profile 的 sha256 清单。
3. 换 DSH 分支构建，打开其中几个继续聊，触发迁移；再新建一个 DSH 会话。
4. 退出，再换回 v1.0.3。核对：
   - 迁移过的会话以改键后的 id 出现，历史完整、能续聊；
   - DSH 会话不出现；
   - 没迁移过的会话不受影响；
   - pi 文件的哈希与第 2 步相同（1.0.3 续聊之前）。
5. 在 1.0.3 里续聊一个迁移过的会话，然后再换回 DSH 构建。核对：它显示为分叉，DSH 那份也还在。

这一步不碰真实数据，可以由代理在开发机上做；GUI 与全量测试不同时跑（开发机内存吃紧）。
