# 决策 121：P1-9c 宿主执行 `seedSession` 的实现取舍（含编排者裁定）

日期：2026-09-29。**状态：第 1～5 条是编排者裁定（2026-09-29）；第 6 条起是自主决定，待用户审批。**

依据：
- 决策 [050](050-migrate-on-first-continue.md)～[056](056-imports-produce-dsh-directly.md)（用户已批准，[决策 090](090-user-rulings-2026-09-28.md)）；[043](043-grants-sidecar-next-to-stub.md)、[006](006-session-identity-stub-file.md)、[007](007-flush-dsh-session-before-stub.md)、[027](027-rewind-and-fork-via-seeded-child-sessions.md)、[076](076-converter-implementation-choices.md)、[080](080-rewind-fork-implementation-choices.md)、[112](112-p1-4c2-attachment-choices.md)；
- [P1-9 方案](../topics/p1-9-migration.md) §4.1、§4.3 与分片 03、05；
- 开工实验证据 [p1-9c-seed-experiments-2026-09-28](../evidence/p1-9c-seed-experiments-2026-09-28.md)。

改动留在工作区，由编排者复跑后提交。

## 一、编排者裁定（第 1～5 条）

起因：第一轮实验 E1 发现，含压缩检查点的种子写得进去，DSH 却读不回来。编排者按实验证据 §5 的建议裁定如下。

1. **转换器照 DSH 实时压缩的写法写压缩事务**（`convert/seed.ts`）。
   - 每个替换型检查点前写 `compaction/start {compactionId, turn}` 和 `compaction/summary`，后写 `compaction/end {compactionId, turn}`。
   - `turn` 取检查点所在的回合；检查点在回合之间时为 `null`。
   - 检查点的 `sourceEventSeqs` 以 start、summary 开头，后面才是被遮住的节点。
   - `compactionId` 沿用 pi 条目 id。
   - summary 紧挨在检查点之前（DSH 类型注释说这是约定），其中：
     - `summary`：不带框的摘要正文块；
     - `shadowedRange` 与 `shadowedSeqs`：检查点遮住的那段 surface。
   - 只遮住空区间的检查点（追加型）照旧不包：DSH 的读盘校验只管替换型。
2. **`shadowedTokenCount` 用 DSH 自己的估算器。**
   - `@deepseek-ai/dsh-token-meter` 导出了 `estimate`（`estimateMessage`）。转换器不能加载 DSH 包，所以把这段照搬为 `convert/tokenEstimate.ts`，保留 MIT 声明，并在 `THIRD_PARTY_NOTICES.md` 登记。
   - 公式：每个文本或思考块 `ceil(字符数/4)+4`；工具调用 `ceil(名字/4)+ceil(参数/4)+4`；其他块（图片引用等）按 JSON 长度 `ceil(n/4)+4`，图片要去掉 `offloaded`；每条消息再加 4；系统消息另算。
   - 值是被遮节点的价格之和。
   - `bindSeedImages` 绑定图片之后重算一次。绑定后的引用与待入库的占位价格不同，而 DSH 按实际存下的内容计价。
   - `tokenEstimate.test.ts` 在装了 `src/dsh-host` 时，拿全部语料种子的 238 条消息与 DSH 的 `estimateMessage` 逐条比对，结果全部相同。
3. **`provider` / `model`**：
   - pi 的压缩条目不记这两项：类型定义里没有，30 份语料的压缩条目里也都没有；
   - 所以取活动分支上前一条回复的；
   - 前面没有回复时用 `legacy` / `legacy`。DSH 要求两者是非空字符串，自己没有缺省值；`legacy` 与转换器对「没写 provider 的回复」的兜底一致。
4. **`checkSeed` 加一层 `read/…` 规则**（`convert/invariants.ts`）：
   - 替换型检查点必须落在同一 id、同一归属的事务里；
   - summary 要准确指明当前 surface 上被遮的那一段，并紧挨在检查点之前；
   - 事务里不能跨回合边界，结束时不能还开着。
   - 单测：`seedChecker` 逐条构造违例；`seedCorpus` 核对 8 份含压缩的语料：去掉事务后（即 P1-9b 的写法）只报 `read/compaction`，加上事务后通过。
   - [决策 076](076-converter-implementation-choices.md) 第 1 条加了补记，分片 03 §5 已更正。
5. **会话 id 后缀不再用「.」**：
   - DSH 的 projection cache 要求记录键匹配 `[A-Za-z0-9_-]`；
   - 迁移换 id 用 `_m<n>`，回退改为 `_r<n>`；
   - 读取兼容旧的 `.r<n>`：算下一个编号时两种都算，所以开发机上已有 `.r<n>` 的会话，下一次回退是 `_r<n+1>`。

## 二、自主决定

6. **转换器版本升到 2。** 同一份字节现在会转出不同的种子，按 `SEED_CONVERTER_VERSION` 的约定就该升。
   - 代价：`legacy-pi-dsh` 有 57 份金样本要重录（27 份种子、30 份报告）。其中 41 份只差 `converterVersion`；另外 16 份是 8 个含压缩的文件，种子多了事务事件，报告多了这些事件的计数。30 份投影与 3 份转换失败的种子不变。
   - 好处：版本 1 迁出来、可能读不回来的会话，不会被当成可复用的（见第 12 条）。
7. **协议**（`dshHostProtocol.ts`）：
   - 请求：宿主控制消息 `{host:'seedSession', id, kind:'pi-file', sourceFile, logicalSessionId, cwd, expect?}`。字段照方案 §4.1 平铺。`kind` 现在只收 `pi-file`，`imported-conversation` 归 P1-9f。
   - 答复：`{host:'seeded', id, ok, result | error:{stage, code, message, retryable}, ms}`。
   - 宿主一次只做一个迁移，其余排队；ping 不受影响。
   - 字段不对但 id 可用的请求，答 `seed_request_invalid`，不丢弃，因为 Main 在等答复；连 id 都没有的，只记一次诊断；宿主没有这项服务时，答 `seed_unavailable`。
   - 载荷校验：`isDshHostSeedSessionRequest`、`isDshHostSeeded`。
8. **失败阶段与错误码**：
   - 阶段有九个：`request / read / decode / build / admit / create / verify / sidecar / stub`，前八个之外只多了 `request`，其余照分片 02 §5。
   - `read` 阶段的码：`source_missing`、`source_busy`（可重试）、`source_too_large`、`source_unreadable`、`session_import_source_changed`（沿用 1.0.x 的码）。
   - `request` 阶段：`seed_logical_id_invalid`。
   - `decode`、`build`：用转换器自己的码。
   - `admit`：`seed_admit_failed`。
   - `create`：`seed_create_failed`、`seed_id_exhausted`。
   - `verify`：`seed_readback_failed`、`seed_readback_mismatch`、`seed_invariant_violated`。
   - `sidecar`：`seed_sidecar_failed`（可重试）。
   - `stub`：`seed_stub_conflict`、`seed_stub_failed`（可重试）。
9. **只读读源**：
   - 读之前、读之后各 stat 一次，大小和 mtime 必须一致；读之前先查 32 MiB 上限；只用一次 `open(…, 'r')` 读完。
   - Main 给了 `expect` 时，还要与 Main 的 stat 一致。
   - 源文件从不写、不改名、不加锁。单测和冒烟都把源文件设成 0444，并比对前后的哈希、大小、mtime、权限位。
   - 旧格式文件先找 1.0.x 的副本 `<真实路径>.native-v4.jsonl`。副本头里的 `importedFrom` 等于真实路径、`sourceSha256` 等于原件哈希时，转换副本；对不上就报 `session_import_source_changed`，与 1.0.x 相同。
   - 旧格式在内存里转换时，按位置派生的 id 取自真实路径，与 1.0.x 做副本时一致。
10. **cwd 用请求里的 `cwd`**（索引行的 `workspacePath`），不用 pi 文件头里的。恢复时 bridge 要求桩的 cwd 与 Main 给的工作区相同，否则报 `session_cwd_mismatch`。
11. **核对在 dispose 之后冷读**（`observeSession`）：
    - 读回的事件要与种子逐条相同（键排序后比 JSON），接着是 `session/end-seed`，之后只允许出现 DSH 创建 agent 时写的 setup 事件；
    - 读不回来报 `seed_readback_failed`，读出来不一样报 `seed_readback_mismatch`，两种情况都不写 sidecar 和桩。
    - 理由见实验 E1：构造器放行的东西，读盘时可能被拒。
12. **幂等与恢复**：
    - 桩已存在，且 `origin` 与这次的转换相同（转换器版本、所转字节的哈希、Main 指的文件的哈希都一致），cwd 也相同，会话读得回来 → 答 `reused:true`，什么都不写。
    - 桩已存在但对不上时，只有同时满足以下几点才替换：它是一次迁移（`origin.kind` 为 `pi-session`）；lineage 最多一项；之后没人说过话（最后一个 `session/end-seed` 之后没有 `turn/start`），或者会话已经读不回来。替换时换新 id，避开旧桩名下的所有 id。
    - 其他情况一律 `seed_stub_conflict`，什么都不动。
    - 候选 id 下已有日志：内容恰好是这份种子的，直接接着用（上次停在建桩之前）；否则顺延到 `_m<n>`，最多试 20 个。
13. **图片**：
    - 每张图单独调用 `admitUserContent`，与发送走同一个入口（决策 112）。
    - 被拒的图留成转换器的占位文字，并计数。附件服务本身出错，报 `admit` 阶段。
    - 已入库的图片在后面失败时不回滚：附件按内容寻址、永不删除，重试时是同一个对象（与决策 112 第 4 条一致）。
14. **sidecar 先于桩写**：
    - 写失败报 `sidecar` 阶段，可重试，桩不写。
    - 这次没有授权时，删掉上次半途留下的 sidecar。
    - 语料里没有一份在活动分支末尾带非空授权（最后一条都是换 mode 时写的空集），所以单测另造了一份小的 v4 会话来覆盖这条路径。
15. **桩**：
    - lineage 的原因记 `create`，不新增 `migrate`：已有读者都不必改，迁移与否看 `origin`。
    - `origin` 的内容是转换器的 origin，再加 `migratedAt` 和 `file:{path, sha256, bytes, mtimeMs}`（Main 指的那个文件）。
    - `isSessionStub` 对 `origin` 只检查它是带 `kind` 的对象，不查更多，免得新版本写的 origin 让会话打不开。
    - 回退保留 `origin`，fork 不带。
16. **创建时的模型**：用宿主的默认选择（`agentDefaultModel.currentSelection()`）。迁移不跑回合，以后恢复时按渲染层选的模型走。
17. **`error.message` 可能含路径**：它给宿主日志和 Main 用。P1-9d 和离线工具的报告只能记阶段和码。
18. **不加录制场景**：
    - 种子与投影由 `legacy-pi-dsh` 金样本钉住；真宿主路径由 bridge-smoke 的 J 主机覆盖（迁移、预览、恢复、续聊、幂等、拒绝、源文件不变）；
    - `bridge-record.ts` 与 `dshHistoryGolden.test.ts` 没有改动。
19. **`seedCorpus.test.ts` 加了 `AICLIENT_FIXTURES_OUT`**：重录的金样本可以先写到别处审阅，不覆盖仓库里的。
20. **实验脚本留在仓库**，不进产品包：`tools/seed-experiments.ts` 与 `tools/lib/seed-experiment-row.mjs`。

## 取舍

- **替换未完成的迁移，还是一律报冲突**：一律报冲突更简单，但有一种情形会永远卡住：桩写了、索引没提交，之后回装 1.0.x 续聊，再升级回来。只替换「没人说过话的迁移」可以避开，而真正在用的会话一定挡得住。
- **幂等要比两份哈希**：比「所转字节」的哈希，是因为旧格式文件可能在副本里被续聊过；比「Main 指的文件」的哈希，是因为 Main 判断分叉用的就是这个文件。

## 遗留

- **P1-9d**：
  - Main 侧的请求、等待与超时（`DshHostSupervisor` 现在把 `seeded` 当作未知消息丢弃）；
  - 迁移服务：互斥与错误码 `legacy_migration_failed:<阶段>/<码>`，`retryable` 的自动重试；
  - 索引事务：`migratedFrom` 取 `result.source`；首次恢复时，渲染层没发档位就用 `result.legacyPermissions`。
- **替换留下的日志**：替换未完成的迁移后，旧 id 的日志会留下，GC 按「有内容」不删（与决策 080 的丢弃 fork 同类）。
- **开发机上的旧回退会话**：id 仍是 `.r<n>`，projection cache 对它们照旧告警、缓存失效，不影响功能。
- **实验 E3 没做**：决策 054 要求量 2000 条消息和 32 MiB 两档会话的耗时与内存，这次只做了 E1、E2。
- **金样本**：`legacy-pi-dsh` 与 `rewind` 的金样本由编排者重录。
