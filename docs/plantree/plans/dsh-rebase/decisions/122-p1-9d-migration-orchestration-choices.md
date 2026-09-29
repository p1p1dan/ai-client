# 决策 122：P1-9d 旧会话迁移的 Main 编排与索引的实现取舍

日期：2026-09-29。**状态：自主决定，待用户审批。**

依据：
- 已批准的决策：[050](050-migrate-on-first-continue.md)（首次继续时迁移）、[051](051-migrated-row-keeps-logical-id.md)（逻辑 id 归 DSH、旧行改键保留）、[053](053-ignorable-events-in-seeds-only.md)～[056](056-imports-produce-dsh-directly.md)、[076](076-converter-implementation-choices.md)、[080](080-rewind-fork-implementation-choices.md)、[090](090-user-rulings-2026-09-28.md)（默认跟随 DSH）、[092](092-p1-6c-grants-and-setters-choices.md)、[109](109-user-rulings-p1-7-prototype-2026-09-28.md)（P1-11 去掉 pi TUI）、[110](110-user-rulings-2026-09-28-batch2.md)；
- 待审批的前序决策：[121](121-p1-9c-seed-session-choices.md)（宿主的 `seedSession` 与 `seeded`，第 7～17 条，及其「遗留」里交给 P1-9d 的几项）；
- 方案：[P1-9 方案](../topics/p1-9-migration.md) §4.1、§4.4、§6 的 P1-9d 行；[分片 04](../topics/p1-9-migration/04-index-rollback.md) §3～§6；[分片 05](../topics/p1-9-migration/05-tests-and-changes.md) §4；[重划 §4](../topics/p1-4-p1-16-rescope.md) 的 P1-9d 说明（不做 TUI 交接）。

改动留在工作区，由编排者复跑后提交。**第 1、6、7、13、14 条请重点审批。**

## 规则

### 一、宿主通道（`DshHostSupervisor.seedSession`）

1. **超时 120 s**（`DSH_HOST_TIMINGS.seedSessionTimeoutMs`）。
   - 方案没有给数。分片 03 §7 估计 32 MiB 的会话转换要 5～10 s，另加图片；2 核开发机忙时按三倍算；宿主一次只做一个迁移，排在前面的也算在这 120 s 里。与 `gc` 的超时相同。
   - 超时后迟到的 `seeded` 只记一次告警并丢弃。宿主那边的结果是幂等的（决策 121 第 12 条），下一次继续会拿到 `reused`，不会重做一遍。
2. **宿主答什么就交回什么**：`ok:false` 的 `seeded` 也是正常答复，按原样 resolve；只有传输层的失败才 reject，各用一个码：
   - 起不来或送不出去：沿用 `DSH_HOST_UNAVAILABLE` 与启动类的码；
   - 等待中宿主退出（崩溃、挂死、任何重启或停止）：新码 `DSH_HOST_SEED_INTERRUPTED`；
   - 超时：新码 `DSH_HOST_SEED_TIMEOUT`；
   - 答复是 `seeded` 但不合协议：新码 `DSH_HOST_SEED_MALFORMED`，立即失败，不等到超时。
3. **与 `readPage` 同样的生命周期**：没有宿主就按需拉起；迁移进行中不算空闲，挡住空闲停机；只有 `userInitiated` 的迁移能把宿主从 `failed` 拉回来（迁移是用户的「继续」触发的，迁移服务总是带上它）。

### 二、迁移服务（`src/main/services/chat/LegacyMigrationService.ts`）

4. **同一会话互斥，用「合流」而不是「拒绝」**：同一个逻辑 id 的迁移在跑时，第二次继续拿到同一个结果（同一个 Promise）。不同会话互不阻塞，宿主那边本来就串行。
5. **迁移前 Main 先 stat 源文件**，把 size、mtime 作为 `expect` 交给宿主；每次重试都重新 stat。Main 自己 stat 失败时，用宿主 `read` 阶段的码：
   - `ENOENT` / `ENOTDIR` → `read/source_missing`，不可重试，不再问宿主；
   - `EBUSY` / `EAGAIN` → `read/source_busy`，可重试；
   - 其他错误、或者不是普通文件 → `read/source_unreadable`，不可重试。
6. **错误码的形状**：`legacy_migration_failed:<阶段>/<码>: Session <id> could not be moved to the current chat engine`，可重试时末尾加 ` (retryable)`。
   - 阶段是宿主的九个（决策 121 第 8 条）加上 Main 自己的两个：`host`（`host_unavailable`、`host_exited`、`seed_timeout`、`seed_answer_invalid`）和 `index`（`index_row_changed`、`legacy_key_taken`、`index_commit_failed`）。
   - 按决策 121 第 17 条，交给渲染层的错误只含阶段和码；宿主的 `error.message` 可能含路径，只经 `sanitizeStderrLine` 脱敏后进 Main 日志。码里若出现 `[A-Za-z0-9_]` 以外的字符，一律写成 `unknown`。
   - Electron 只传 `error.message`，所以「可重试」编码在消息里；`@shared/types/legacyMigration` 提供 `formatLegacyMigrationFailure` / `parseLegacyMigrationFailure`，P1-9e 用后者解析，不另写正则。
7. **重试策略**：
   - 宿主标了 `retryable` 的失败（`source_busy`、`seed_sidecar_failed`、`seed_stub_failed`），以及 Main 自己 stat 到的 `source_busy`，自动再试两次，间隔 1 s、3 s，总共最多多等约 4 s；
   - 宿主本身的失败（起不来、中途退出、超时）**不自动重试**，但报成可重试：让宿主崩掉的迁移再跑一次多半还会崩，并且会耗掉重启预算；超时的那个还在宿主里跑。下一次继续由用户触发，宿主的幂等保证它能接上；
   - 索引提交失败也不自动重试，报成可重试：桩已在盘上，下一次继续只需补提交。例外是 `legacy_key_taken`（不可重试）；
   - `seed_answer_invalid` 与 `DSH_HOST_DISPOSED`（应用正在退出）不可重试。

### 三、索引（`SessionIndexService`）

8. **改键后的键名定为 `<逻辑 id>_pi`**（方案里的 `~pi` 只是示意）：
   - 确定性，事务重做会落到同一个键；
   - 字符集：分叉的旧行以后会以这个键为逻辑 id 再迁移，那时它要当 DSH 会话 id（`aiclient-<键>`，决策 121 第 5 条要求 `[A-Za-z0-9_-]`）和临时目录名，`~` 不合格；
   - 与 DSH 会话 id 的 `_r<n>`、`_m<n>` 后缀不冲突（`_pi` 不是字母加数字）；
   - 键已被别的行占用时，事务报 `index/legacy_key_taken`，什么都不写。
9. **`commitMigrated` 一次原子写两行**，只在宿主答 `ok`（桩已写好）之后调用：
   - 前提：原键仍是那条 `pi` 行，并且仍指向迁移的那个文件；否则报 `index/index_row_changed`，什么都不写；同样的提交再做一次，直接返回已提交的行；
   - 改键的行：原行逐字段不变（含 `updatedAt`、`piLeaf`、`legacyImport`、归档），只加 `migratedTo`；
   - 原键的行：`agent: dsh`，`runtimeIdentity` 为桩，`workspacePath` 为迁移时用的 cwd（临时会话换过根目录时是新路径，与桩里的 cwd 一致），去掉 `piLeaf` 与 `migratedTo`，保留标题、模型、`unbound`、归档、`legacyImport`；`migratedFrom` 取 `result.source`（sha256、字节数、mtime），`migratedAt` 取 Main 提交时的时间，`converter` 写 `pi-dsh/<report.converterVersion>`；
   - 写失败时两行都回滚；
   - `recordCreated` 按字段重建行，原来会丢掉未知字段；现在保留 `migratedFrom` / `migratedTo`，免得一次重新登记就把迁移对拆开。
10. **侧栏的隐藏在 Main 做**：新方法 `listForDisplay()` 供 `chat:listSessions` 用，`list()` 不变（GC 的认领集合、暂存 fork 清扫、TUI 仍要看到每一行）。
    - 被某条 `dsh` 行的 `migratedFrom` 引用的 `pi` 行：源文件的 size、mtime 与记录相同就不返回；不同、或者这行已指向别的文件（1.0.x 把旧格式改绑到了 `.native-v4.jsonl` 副本），就返回并带派生标记 `migrationDiverged: true`；
    - stat 失败证明不了分叉，按未分叉处理（隐藏）；
    - 派生标记不落盘。
11. **裁剪保护**：被引用的 `pi` 行不单独入选；它引用的 `dsh` 行被裁掉时一起删。因此一次裁剪可能比超出的行数多删一行。

### 四、恢复路径（`src/main/ipc/chat.ts`）

12. **恢复路径去掉只读**：带真实文件的 `pi` 行在恢复时先迁移、再按普通 DSH 行恢复。
    - 顺序改为：认领窗口、准备工作区（临时目录重建或换根）→ 未落盘空行的修复（不变）→ 迁移 → `resumeSession`。迁移要在工作区之后，因为 DSH 会话的 cwd 一旦创建就固定，必须是这次恢复用的那个；
    - 恢复打开的是行自己的身份（迁移后就是桩），不再用渲染层传来的路径；
    - 渲染层还拿着旧的 pi 路径时（在迁移前列出的会话、别的窗口刚迁完），只要这条 `dsh` 行的 `migratedFrom.runtimeIdentity` 等于它，就照常恢复；其他不一致仍报 `pi_session_identity_mismatch`。
13. **旧档位**（决策 121 遗留）：渲染层这次恢复既没给 `permissions` 也没给 `tier` 时，用 `result.legacyPermissions`（等价于 1.0.x 的 `{...文件, ...payload}`）；不是合法档位就丢弃，按默认档位（每次都问）。答复里的 `legacyPermissionsApplied` 说明用没用上，供 P1-9e 同步档位芯片。
14. **其他需要引擎的操作**（压缩、树、回退、fork、后台任务与子代理的控制），以及对旧行的新建与登记：原来报 `legacy_session_readonly`，现在报 `legacy_migration_required`，由渲染层先恢复（恢复即迁移）再重试，照方案 §6 的 P1-9d 行。它们不自动迁移：迁移只由「继续」这一个入口触发，与决策 050 的口径一致。Main 不再产出 `legacy_session_readonly`。
15. **报给渲染层的数据全走已有的 IPC 与事件**，不加新事件、不给 `session.status` 加骑手字段：
    - 迁移中：就是这次 `chat:resumeSession` 调用还没返回；Main 的判断规则是确定的（带真实文件的 `pi` 行），渲染层已有同一条预测（`isLegacyReadOnlySession`）；
    - 成功：`chat:resumeSession` 的答复多一个 `migration` 摘要（改键后的 id、是否复用、转换的是原件还是副本、图片与授权计数、旧档位及是否用上），不含路径；之后照常的 `session.resumed` 带 `agent: dsh` 和桩，把渲染层的会话改绑过来，别的窗口也能收到；
    - 失败：`chat:resumeSession` 以第 6 条的码 reject，行仍是 `pi`，预览照旧；
    - 不用 `session.status` 的原因：`starting` 会让渲染层显示回合进行中（Stop 按钮、等待动画），迁移失败还得再补一个状态；`idle` 加骑手字段会顺带改动侧栏排序与最近会话，这些都是 P1-9e 之前不该有的界面变化。P1-9e 若需要让没发起迁移的窗口也显示「迁移中」，再单独提。
16. **不做 TUI 交接，也不为 pi TUI 做任何特判**（重划 §4；决策 109：P1-11 去掉 pi TUI）。`chat.ts` 里现有的 `handOverFromTui` 不动，迁移不调用它。

### 五、测试

17. 单测：
    - `DshHostSupervisor.test.ts`：发送与匹配 id、失败答复原样交回、宿主退出与重启时的 `DSH_HOST_SEED_INTERRUPTED`、超时与迟到答复、畸形答复立即失败、`failed` 状态下只有用户触发才拉起、空闲停机的挡与放；
    - `LegacyMigrationService.test.ts`（新）：stat → 宿主 → 提交的顺序、`expect` 与 `migratedFrom` 的来源、互斥合流、可重试失败的重试与放弃、不可重试的码、宿主传输失败的映射且不自动重试、索引失败的映射、错误消息不含路径、静态守卫（Main 只 stat 源文件，不 import 会写文件或加锁的入口）；
    - `SessionIndexService.test.ts`：一次写两行、改键行逐字段相同、按 1.0.3 的规则（只认 `pi`）重算可见性、冲突不写、写失败回滚、重新登记不拆对、`listForDisplay` 的隐藏与分叉标记、裁剪保护；
    - `chatPiWorkerRouting.test.ts`：原「旧会话只读」一组改为「首次继续时迁移」一组；
    - `legacyMigration.test.ts`（新）：错误码的格式与解析（含 Electron 的包装）、键名规则。
18. 真宿主集成测试加一个阶段：把仓库语料 `v4-basic.jsonl` 复制到临时 profile 并设为只读，索引放一条 `pi` 行，经 `LegacyMigrationService.prepareResume`（`chat.ts` 恢复路径的同一个入口）迁移，核对索引对与 `listForDisplay`，再用桩恢复并跑一轮 `P0-RECALL`：迁移前的用户消息和最后一条回复进了模型上下文，标签没有；源文件的哈希、大小、mtime、权限位不变；第二次继续不再迁移。只用本地假网关。

## 取舍

- **合流还是拒绝第二次继续**：拒绝要让渲染层处理一个新的「正在迁移」错误；合流对调用方透明，第二个窗口也能直接拿到结果。
- **隐藏在 Main 还是渲染层做**：方案把隐藏列在 P1-9e；放在 Main，渲染层拿到的列表天然干净，P1-9e 只需处理分叉标记。代价是渲染层看不到被隐藏的行，目前没有需要看到它们的界面。
- **键名 `_pi` 还是 `~pi`**：`~` 做不了 DSH 会话 id，分叉后再迁移会失败。

## 遗留

- **P1-9e（渲染层）**：
  - `historyError.ts` 映射 `legacy_migration_failed`（用 `parseLegacyMigrationFailure`，可重试的给「重试」）与 `legacy_migration_required`（先恢复再重试）；`legacy_session_readonly` 已没有产出方，只读卡片、`isReadOnlyResumeRefusal`、`queueRelease` 的 `refusedByRule` 与相关静态测试（`sendRefusalWiring.test.ts` 等）随之改写；
  - `isLegacyReadOnlySession` 的语义改为「下一次继续会迁移」，据此显示「迁移中」；
  - 恢复答复带 `migration` 时，把四个偏好键复制到 `migration.legacySessionId` 下（只增不删），并在 `legacyPermissionsApplied` 为真时把档位芯片同步到 `legacyPermissions`；
  - `migrationDiverged` 的行显示「1.0.x 里有新内容」；
  - `resumeIntent.ts` 等处描述 Main 只读拒绝的注释改写。
- **P1-9f（导入产 DSH）**：导入去重要认迁移对（行的 `migratedFrom.runtimeIdentity` 等于清单记的文件，分片 04 §5）；`removeImported` 接受 `dsh` 行。在这之前，已迁移的导入会话再导一次会多出一份。
- **决策 121 的遗留仍在**：替换未完成的迁移后，旧 id 的日志留在盘上，GC 不删；实验 E3（大会话的耗时与内存）没做，第 1 条的 120 s 是估算，E3 做完后应复核。
- **回装演练**（方案 §7.4）与真实数据离线测试（§7.3）不在本任务内。

## 补记（2026-09-29，P1-9e）

上面「遗留」里的 P1-9e 一节已由[决策 123](123-p1-9e-migration-renderer-choices.md) 落实（待审批）。第 15 条留下的「让没发起迁移的窗口也显示迁移中」决定不做，仍只走已有的 IPC 与事件（决策 123 第 2 条）。

## 补记（2026-09-29，P1-9f）

「遗留」里的 P1-9f 一节已由[决策 124](124-p1-9f-imports-produce-dsh-choices.md) 落实（待审批）：导入去重认迁移对（第 15 条）；`removeImported` 接受 `dsh` 行，但拒绝带 `migratedFrom` 的行（第 16、17 条）。导入的宿主调用沿用第 1～3 条的超时与生命周期规则，传输失败沿用第 6 条 `host` 阶段的码。

## 补记（2026-09-29，P1-11）

第 16 条「`chat.ts` 里现有的 `handOverFromTui` 不动」已随 pi TUI 删除：`handOverFromTui`、`reloadSessionFromDisk`、`chat:reloadSession` 与 `WorkerManager.reloadSession` 都不在了，迁移与发送都不再有 TUI 交接（[决策 127](127-p1-11-remove-pi-tui-choices.md) 第 2 条，待审批）。`SessionIndexService.list()` 仍回答每一行（第 10 条），服务 GC 与暂存 fork 清扫。
