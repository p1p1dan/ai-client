# P1-9 分片 05 · 测试、夹具、离线工具与改动清单

Role: detail shard。上位：[P1-9 方案](../p1-9-migration.md)。回答调研问题 7、8。规模是粗估；「需实测」的实验都要起真宿主，本次没有做。

## 1 开工前的小实验（各一个脚本，先 `free -m`）

| # | 验什么 | 怎么做 | 不成立时 |
|---|---|---|---|
| E1 | 转换出的种子能创建、落盘、释放、马上恢复，并跑通一轮 | 用 B01～B06 与 v4 夹具各转一份：`agents.create({seed})` → `flush` → `dispose` → 同一宿主 `agents.resume` → 假网关跑一轮。检查请求里历史的顺序、空系统头被原地替换、`request/header` 记 `initial`、没有适配器报错 | 回到 D5，改用低层持久化入口，或在种子里补 `request/header` |
| E2 | ignorable 事件的往返 | 种子里放 `aiclient/legacy-display`：落盘 → 冷读 `observeSession` → `buildForkSeed` → 新会话 → 再读 | D4 退到 B（sidecar） |
| E3 | 耗时与内存 | 合成 2000 条消息与 32 MiB 上限两份会话，测转换各阶段耗时、宿主 RSS 峰值、事件循环最大延迟（沿用 P0-6 `measure.ts` 的方法） | 调整方案 §4.3 的串行与分段策略，必要时给大会话单独的进度与上限 |
| E4 | 投影一致 | 同一份夹具：pi 投影（`projectPiSessionHistory`）与迁移后 DSH 投影（P1-4a）逐条比对 role、文本哈希、工具调用 id、附件数、`stopCause`，列出预期差异 | 补投影规则，或调整映射 |

E1 与 P1-4b 开工前的实验（「带 seed 创建、flush、dispose 之后马上 resume」）是同一个问题，合做一次。

## 2 仓库内的回归夹具

| 夹具 | 来源 | 覆盖 |
|---|---|---|
| B01～B06 | 现成：`docs/plantree/plans/runtime-evolution/evidence/p2-0/baseline-20260908/*/sessions/*.jsonl`（6 份 v3，含压缩） | v3 路径、压缩、真实形状的工具回合 |
| v4 语料 | 新建脚本 `scripts/gen-legacy-pi-fixtures.ts`：用 1.0.x 的 `createRuntime` 加 faux provider 生成，提交进 `src/shared/__tests__/fixtures/legacy-pi/`。**要在 P1-12 删 runtime 之前生成并提交** | 思考与签名、图片（小 PNG，带 `aiclientName`）、工具与 `details`、压缩（有锚点 / 无锚点）、重试旁支、回退旁支、`runStop` 两种、崩溃补的结果、子代理记录、授权与档位条目、内部消息三种、CLI 行、标签、会话名 |
| 损坏样本 | 语料脚本在 v4 样本上派生 | 残尾、坏的中间行、跳号、未完成的 `record`、空文件、超过 32 MiB（只测拒绝路径，不入库大文件）、非法 UTF-8 |
| 旧格式小样本 | 手写，照 `sessionLegacy.test.ts` 的写法内联 | v1、v2、PI-Desktop schema 1、带 `.native-v4.jsonl` 副本的 v3、副本之后原件被改 |
| 导入样本 | 现成：`src/agent-host/__tests__/fixtures/codex/codex-rollout-redacted.jsonl`，以及 legacyImport 单测里的 Claude 样本 | display 行、真实工具调用配对、来源说明 |

每份夹具配三类金样本：归一化后的种子事件、DSH 投影结果、迁移报告。沿用「金样本只在收口时重录」的规矩。

## 3 真实数据离线迁移测试（退出判据）

**工具**：`src/dsh-host/tools/migrate-offline.ts`（与 bridge-smoke 等开发工具放在一起；P1-2 施工中正把这些工具从 `src/dsh-host/` 移到 `tools/`，以落地为准）。开发机从检出目录用随包 node 跑（`out-node-runtime/node --expose-internals`）；没有检出目录的 Windows 机器，照 P0-4 的做法打一个上机包（工具 + 随包 node + 宿主依赖）。步骤：

1. `--snapshot <profile 根> <userData 目录> --out <目录>`
   - 把 `~/.pilab/<profile>` 与 `<userData>/session-index.json` 复制到 `<out>/input/`；
   - 生成 sha256 清单，然后把副本设为只读。
2. `--convert --out <目录>`
   - 起一个私有宿主：产品 bundle，`DSH_HOME=<out>/work/dsh-home`，不配置任何模型路由，不联网；
   - 逐行读副本里的索引，把 `runtimeIdentity` 从原 profile 根改写到副本根。指向 profile 之外的文件不处理，报告里计为 `outside-profile`；
   - 工作区目录不复制，`meta.cwd` 用原路径。`agents.create` 是否要求目录存在未核实，不存在的计为 `cwd-missing`；
   - `pi-agent/sessions/` 下没被索引引用的 `.jsonl` 只计数，不迁移（1.0.x 里本来也看不到）；
   - 对每个 pi 行，调用与产品完全相同的 `seedSession` 代码；
   - 校验：`observeSession` 读回的事件数；E4 的投影比对；
   - 另外算一份迁移后的索引（写到 `<out>/work/`，不碰副本），按 1.0.3 的可见性规则核对：原来能看到的每一个 pi 行，都能在某个键下找到，并且除 `sessionId`、`migratedTo` 外逐字段相同。
3. `--verify --out <目录>`：重算副本的 sha256 清单，与第 1 步比对。
4. 输出 `report.json` 与 `report.md`：
   - 内容只有分片 02 §5 的计数、哈希、错误码、耗时、峰值内存；
   - 路径和会话 id 用每次运行随机盐的哈希表示，盐不写进报告；
   - 不含正文、标题、文件名、工作区名；
   - 任何源文件哈希变了，或出现白名单以外的失败，退出码非零。

**授权步骤**（真实数据只由用户决定）

| 步 | 做什么 | 谁 |
|---|---|---|
| 1 | 指定机器与 profile：候选是开发机（`~/.pilab/<profile>` 与 `~/.config/<productName>/session-index.json`），以及跑过 1.0.x 的 Windows 办公机；加密机的那一轮并入 P1-13 | 用户 |
| 2 | 退出应用 | 用户 |
| 3 | 运行 `--snapshot`、`--convert`、`--verify` | 用户本人；或用户明确授权某个代理在这台机器上跑，且只许看报告 |
| 4 | 过目报告，决定哪些进 `evidence/p1-9-offline-<日期>.md` | 用户 |
| 5 | 删除 `<out>/input` 与 `<out>/work`，或留作 GUI 抽查 | 用户 |

- 代理在任何一步都不读副本或 `work/` 里的内容，不截取正文截图。GUI 抽查要看迁移后的历史，由用户自己做。
- 加密机上：副本要用随包 node（白名单载体）来复制和读取，Explorer 复制出来的可能是密文（推断），归 P1-13 的检查单。

## 4 子任务与改动清单

| 子任务 | 文件 | 改动 | 约（产品 / 测试） |
|---|---|---|---|
| **P1-9a** 解码链进 shared | `src/shared/legacyPiSession/{codec,legacy,timeline,tree,context}.ts`（新）；`runtime/plugins/session/{codec,legacy}.ts`、`agent-host/piSessionTimeline.ts`、`piSessionTree.ts` 改成 re-export；`SessionReplayReader.ts` 改 import | 搬代码；`context.ts` vendor `buildSessionContext` 的压缩 / 分支摘要子集（MIT，保留声明）；类型改成本地结构类型，去掉对 `pi-agent-core` 的运行期依赖；错误类换成 shared 的；`decodeSession` 加 `tolerateUnfinished`；`convertLegacySession` 可注入 id 生成器 | 搬 ≈1.8k，新 ≈150 / 现有用例改 import ≈30 处 |
| **P1-9b** 纯转换器 | `src/shared/dshMigration/{ir,fromPiSession,fromImport,seed,replayState,surface,report,invariants}.ts`（新） | 分片 02 的全部规则；`surface.ts` 在内存里模拟 surface，算 `replace` 区间；`invariants.ts` 复刻 `dsh-session/lib/invariant.js` 的回合 / 步 / 配对检查；DSH 事件类型与 P1-4a 的 `dshHistory/types.ts` 共用 | ≈1.1k / ≈1.3k |
| **P1-9c** 宿主执行 | `src/dsh-host/bridge/seedSession.ts`（新）；`dshSessionRuntime.ts`（桩加 `origin`，`agents.create` 类型加 `seed`，桩丢失反查认 `.m*`）；`bundle/lib/shared-bridge.js` 与 `src/shared/types/dshHostProtocol.ts`（`seedSession` 操作）；`tools/bridge-smoke.ts` 加场景 | 只读读源、sha256、副本解析、图片入库、create / flush / 核对 / dispose、sidecar（调 P1-6c 的 grantStore 或 shared 编解码）、原子写桩、幂等与 `.m<n>` | ≈400 / ≈500 |
| **P1-9d** Main 编排与索引 | `src/main/services/chat/LegacyMigrationService.ts`（新）；`SessionIndexService.ts`（`commitMigrated`、trim 保护、`removeImported` 收 dsh）；`shared/types/sessionIndex.ts`（`migratedFrom`、`migratedTo`）；`src/main/ipc/chat.ts`；`WorkerManager.ts` | 同会话互斥、TUI 交接、stat、调宿主、错误码 `legacy_migration_failed:<阶段>/<码>`；恢复路径把 pi 行改成「先迁移再恢复」；fork、回退、压缩等 `requireLiveSession` 路径对 pi 行返回可重试码，由渲染层先恢复；list 的派生隐藏 / 分叉标记 | ≈450 / ≈550 |
| **P1-9e** 渲染层 | `sessionIndexMerge.ts`、`resumeIntent.ts`、`useResumeSession.ts`、`historyError.ts`、`MessageTimeline.tsx`（卡片图标）、`sessionPreferenceStore.ts`、中英文案 | 隐藏迁移过的 pi 行、分叉标记与「再次迁移」、迁移中状态、失败卡片替换只读卡片（`e3ce1691` 的「被拒时草稿退回输入框」对迁移失败同样适用）、偏好复制到改键后的 id | ≈130 / ≈200 |
| **P1-9f** 导入产 DSH | `LegacyImportService.ts`、`WorkerManager.ts`（`createLegacyImport` / `inspectLegacyImport` / `reconcileLegacyImport` 改走宿主）、`legacyImportStatic.test.ts` 等静态守卫 | 行写 `dsh`，`runtimeIdentity` 为桩；`legacyImport.targetPiSessionId` 字段名是 ABI、保留，值改为 DSH 会话 id；去重认迁移对；对账删桩，日志交给 P1-3d | ≈200 / ≈350 |
| **P1-9g** 离线工具与夹具 | `scripts/gen-legacy-pi-fixtures.ts`（新）、`src/shared/__tests__/fixtures/legacy-pi/`（新）、`src/dsh-host/tools/migrate-offline.ts`（新）、Windows 上机包脚本、证据模板 | §2、§3 | ≈600 / 夹具 |
| **P1-9h**（可选）旁支转 lineage | `shared/dshMigration/branches.ts`（新）、`seedSession.ts` | 每条旁支一个退役会话，挂进桩 v2 的 lineage，上限 N；共享前缀靠复用的消息 id 在树里自然合并 | ≈250 / ≈300 |

合计：新写产品代码约 3.1k 行（不含 h），另搬约 1.8k 行；测试约 3.2k 行。约 3～4 人周（粗估）。

## 5 顺序

1. 现在就能做：P1-9a（也是 P1-12 的前置）；P1-9g 里的 v4 语料生成（必须赶在 P1-12 之前）。
2. P1-9b：a 之后，可与 P1-4a 并行；投影规则由 P1-4a 按分片 02 实现，或由 b 补进 `src/shared/dshHistory/`。
3. P1-9c：要 P1-3a 的宿主操作通道、P1-6a 的 shared 授权编解码，以及 E1、E2 的结论。
4. P1-9d / e：c 之后；并且 P1-4a 已落地（否则迁移后时间线是空的）。落地即解除决策 005。
5. P1-9f：c 之后，与 d / e 并行，并行代理最多 2 个。
6. 收口：离线工具先跑合成数据和回装演练，再按 §3 在用户授权下跑真实数据；全量测试只跑一次。
7. P1-9h：P1-4b 之后，可放到合入 main 之后。

## 6 与其他任务的边界

| 任务 | 边界 |
|---|---|
| P1-3 | 宿主控制协议加 `seedSession`（与 `readPage`、`configure` 同类）；P1-3d 清理：跳过持锁和最近创建的会话，迁移失败留下的孤儿日志和桩由它清；迁移在宿主内串行 |
| P1-4 | 投影新增 5 条规则：`aiclient-pi-branch-summary` 显示为摘要；`aiclient/legacy-display`、`aiclient/legacy-provenance` 照 1.0.x 渲染；`tool/result.meta.aiclient.piDetails` 恢复工具行标志；`aborted{legacy}` 不设 `stopCause`；同时认 `plugin:` 前缀。桩 v2 读取时，`origin.kind:'pi-migration'` 的 lineage 首项原因记 `migrate` |
| P1-5 | 模型 id 不变；被过滤协议的模型由菜单兜底；设置页三条说明由 P1-9e 落文案；真实网关 R 系列可以顺带验证「历史里出现当前工具表之外的工具名，provider 是否接受」 |
| P1-6 | sidecar 路径与编码（决策 043）；授权 `tool` 词表；`legacyPermissions` 的播种优先级 |
| P1-7 | 迁移来的委派记录（`aiclient/pi-subagent`）要不要渲染成委派面板 |
| P1-11 | 内嵌 pi TUI 如果保留，只能开没迁移过的 pi 行；它的续聊会让已迁移的会话进入分叉状态 |
| P1-12 | 删 runtime 前：a 已把解码链搬走；v4 语料已提交；`PiImportProcess` 与 `nativeImport.ts` 在 f 之后才能删 |
| P1-13 | 加密机上跑一轮离线工具（只读、白名单载体），核对 Main 预览失败时会退到「迁移后恢复」 |
| 决策 005 | P1-9d / e 落地时解除；只读卡片改成「无法迁移」卡片，预览照旧 |
| 决策 026 第 5 条 | D4 选 A 时，需要补一条决策：运行期仍禁止自定义事件，种子里允许 `ignorable` 的 `aiclient/*` 事件 |
