Role: evidence

# P1-9c 开工实验 E1、E2：种子会话的创建、落盘、恢复，以及 ignorable 事件的往返（2026-09-28）

上位：[P1-9 方案](../topics/p1-9-migration.md) 分片 [05 §1](../topics/p1-9-migration/05-tests-and-changes.md)（E1、E2 的定义）；[决策 053](../decisions/053-ignorable-events-in-seeds-only.md)、[054](../decisions/054-seed-session-host-op.md)、[076](../decisions/076-converter-implementation-choices.md)。

**结论：E1 与方案的假设不符，按任务要求停在第 0 步，P1-9c 没有开工。** E2 成立。

**修订（2026-09-29）**：编排者按 §5 裁定（[决策 121](../decisions/121-p1-9c-seed-session-choices.md) 编排者裁定部分）。转换器升到版本 2，自己写压缩事务；回退 id 改为 `_r<n>`。重跑之后 27 份全部通过 E1，E2 也成立，见 §6。§1～§5 保留第一轮的原样。

## 1 结论

1. **E1 不成立：带压缩检查点的种子，写得进去，读不回来。**
   - `agents.create({seed})` 和 `sessions.flush` 都成功，日志已经在盘上。
   - dispose 之后，冷读 `observeSession` 和 `agents.resume` 都失败：`SessionPersistenceCorruptionError <- SessionFormatError: compaction checkpoint has no matching compaction/start`。这个会话从此打不开。
   - 27 份能转换的语料里有 8 份是这样，恰好是含压缩的那 8 份：`legacy-desktop`、`legacy-pi-v1`、`legacy-pi-v3`（各自连同 `.native-v4.jsonl` 副本）、`v4-cli`、`v4-compaction`。
2. **原因在 DSH 的读盘校验。**
   - DSH 读盘时做完整的格式校验（`dsh-session-persistence-jsonl/lib/worker.cjs` 的压缩事务检查，与 `dsh-compaction/lib/invariant.js` 同一规则）。
   - 规则是：每条 `source.kind:'compact-checkpoint'`、带 `replace` 的用户消息，都必须落在一个 `compaction/start` → `compaction/summary` → `compaction/end` 事务里。三者 `compactionId` 相同，归属同一回合，或者都在回合之间（`turn:null`）。summary 要带 `shadowedRange`、`shadowedSeqs`、`shadowedTokenCount`、`provider`、`model`。
   - 种子构造器（`agents.create`）不做这项检查，所以写入时不报错。
3. **与方案的出入。**
   - 分片 03 §5 写的是「实时压缩还会写 `compaction/start`、`compaction/summary`、`compaction/end` 三个括号事件；种子里不写」，这一条不成立。
   - P1-9b 转换器自带的校验器 `checkSeed` 没有这条规则，这 8 份种子在它那里是 0 违例。
   - 分片 05 §1 给 E1 列的两条退路都不对症：
     - 「改用低层持久化入口」：日志读回时照样要过这道校验；
     - 「在种子里补 `request/header`」：与这个问题无关。
4. **修正方向已经验证过（只做了原型，转换器没改）。**
   - E1b 在实验脚本里（`bracketCheckpoints`）把每个检查点包进与 DSH 实时压缩同形的事务，做法照 `dsh-compaction-basic` 的 `compactSurfaceRegion` / `commitCompactionBody`：
     - `compaction/start {compactionId, turn}`；
     - `compaction/summary {compactionId, summary, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model}`；
     - 检查点，`sourceEventSeqs` 为 `[start, summary, …被遮节点]`；
     - `compaction/end {compactionId, turn}`。
   - 包好之后，8 份全部通过 E1 的全部检查（§3）。
   - 这要改 P1-9b 的种子形状、`checkSeed` 和 `fixtures/legacy-pi-dsh/` 的金样本，不在 P1-9c 的范围里，需要编排者决定（§5）。
5. **E1 其余部分成立。** 统计范围是不含压缩的 19 份，加上 E1b 的 8 份：
   - flush 之后日志已经在盘上；冷读结果与种子逐事件相同；种子之后只有构造器补的 `session/end-seed`（data 为 `{}`，没有 `inherited`），没有 setup 事件；
   - dispose 之后，同一宿主马上 `agents.resume` 就成功（2～9 ms），resume 本身不追加任何事件；
   - 首轮：`request/header` 的 reason 是 `initial`。空的系统头被原地替换：`system/message` 带 `surfaceOp:{op:'replace', startSeq:<头>, endSeq:<头>}`，`sourceEventSeqs:[<头>]`。回合以 `completed` 结束；
   - 模型收到的请求：surface 上的文本都到了模型；被压缩遮住的文本、只供展示的行都没有到（假网关 P0-RECALL，逐份核对）；
   - `llm-pi-ai` 的 replay 降级告警是 0 条，适配器没有报错。
6. **E2 成立。**
   - ignorable 的 `aiclient/*` 事件（`legacy-provenance`、`legacy-display`、`pi-subagent`、`pi-label`、`pi-entry`）经过 flush 和冷读，类型、`ignorable:true`、载荷都原样保留。
   - 在三个边界 fork：种子末尾、第一回合结束、E1 那一轮之后的日志末尾。子会话冷读时，边界之前的 ignorable 事件逐个相同。
   - bridge 的 `buildDshForkSeed` 在每个边界都与 DSH 自己的 `buildForkSeed` 逐字节相同，包括跨压缩事务的 E1b 会话。
   - 只供展示的行没有进模型请求（E1 的缺席标记，例如 `v4-import-claude` 的两条）。

## 2 做法

- 脚本：
  - `src/dsh-host/tools/seed-experiments.ts`（驱动）；
  - `src/dsh-host/tools/lib/seed-experiment-row.mjs`：只在实验里装的行，仿 P1-4b 的 `rewind-experiments.ts`。驱动把 `tools/probe-bundle` 复制到临时目录，再加上这一行，不进产品包。
- 命令：`out-node-runtime/node src/dsh-host/tools/seed-experiments.ts --out /tmp/p1-9c-exp.json`，约 25 s，退出码 1，因为 E1 有失败项。先后跑了四次，结论一致；最后一次跑在最终版脚本上。
- 环境：
  - 源码态宿主，随包 node v24；
  - 临时 `DSH_HOME` 和工作区放在 `/var/tmp` 下的随机目录，跑完即删；
  - 模型只用本地假网关 `fake-gateway.mjs`（`--plan dsh-p0-2`，模型 `fake-1`，anthropic-messages，没有声明图片输入）；
  - probe hooks 挡掉所有非回环连接。没有访问任何真实网关或私人渠道。
- 数据：只用仓库里的合成语料 `src/shared/__tests__/fixtures/legacy-pi/`（P1-9g，30 份），在驱动进程里用 P1-9b 转换器 `convertPiSessionBytes` 转换。没有读取任何用户目录。
- 每份语料的步骤：
  1. 图片逐张经 `ctx.attachments.admitPromptContent` 入库，用 `bindSeedImages` 绑定，再跑 `checkSeed(…, {images:'bound'})`；
  2. `agents.create({sessionId, meta:{cwd}, seed})`，不带 `isSeeded`，然后 `sessions.flush`；
  3. dispose，冷读，与种子逐事件比较（键排序后的 JSON）；
  4. `agents.resume`，跑一轮 `P0-RECALL`，读这一轮新增的事件和假网关日志；
  5. dispose。

## 3 E1 明细

| 语料 | 种子事件 | 图片 | 冷读 = 种子、resume、首轮检查 | RECALL（在场 / 缺席） |
|---|---|---|---|---|
| damaged-empty / damaged-invalid-utf8 / damaged-seq-gap | — | — | 转换失败：`decode/session_invalid`、`read/source_invalid_utf8`、`decode/session_invalid`，与 1.0.x 读不了这几份时一致 | — |
| damaged-middle-row / damaged-torn-tail / damaged-unfinished-record | 30 / 29 / 32 | 各 1 张，已入库 | 通过 | 2/1、2/0、2/1 通过 |
| v4-basic | 30 | 1 张，已入库；模型不收图片，DSH 换成占位文本 | 通过 | 2/1 通过 |
| v4-branches、v4-branches.fork | 13、13 | — | 通过 | 通过 |
| v4-crash-dangling / -midstream / -recovered | 9 / 6 / 15 | — | 通过 | 通过 |
| v4-import-claude / v4-import-codex | 16 / 10 | — | 通过 | 2/2、2/1 通过（缺席的是展示行里的文本） |
| v4-internal、v4-permissions、v4-stop-interject、v4-subagent | 35、35、21、22 | — | 通过 | 通过 |
| legacy-pi-v2、legacy-pi-v3-drifted（各连同副本） | 13 / 13、18 / 12 | — | 通过 | 通过 |
| **legacy-desktop（连同副本）** | 22 | 1 张，已入库 | **冷读和 resume 失败**：`compaction checkpoint has no matching compaction/start` | — |
| **legacy-pi-v1（连同副本）** | 20 | — | **同上** | — |
| **legacy-pi-v3（连同副本）** | 31 / 37 | — | **同上** | — |
| **v4-cli** | 25 | — | **同上** | — |
| **v4-compaction** | 40 | — | **同上** | — |

- create 耗时 5～23 ms，flush 小于 1 ms。
- **E1b**：上面加粗的 8 份，把每个检查点包进压缩事务之后（事件数 +3 × 检查点数：22→25、20→23、31→34、37→40、25→28、40→49），全部通过：
  - 冷读与种子相同，只补了 `session/end-seed`；
  - 马上可以 resume；首轮 `request/header` 为 `initial`，头被原地替换，回合 `completed`；
  - RECALL 通过：保留尾与检查点之后的文本到达模型，被遮住的文本没有到。
- 其他：
  - **同一源再转一遍**：种子逐字节相同，包括图片引用（附件按内容寻址，同一张图重复入库得到同一个引用）。在另一个 id 下创建出的日志，种子部分逐事件相同，`session/end-seed` 只有 `time` 不同。
  - **同一个 id 再 create**：`SessionAlreadyExistsError`。
  - **cwd 不存在**：create 成功，不会去创建这个目录，之后 resume 也成功。DSH 不要求工作区存在。

## 4 E2 明细

| 会话 | 种子里的 ignorable 事件 | 冷读 | fork 边界（类型都是 `turn/end`） | 子会话冷读 | bridge 与 DSH 的 fork 种子 |
|---|---|---|---|---|---|
| v4-import-claude | provenance ×1、legacy-display ×3 | 全部保留 | 种子末尾、日志末尾（第一回合结束就是种子末尾） | 4/4 相同 | 相同 |
| v4-subagent | pi-subagent ×4 | 全部保留 | 3 个 | 4/4 相同 | 相同 |
| v4-basic | pi-label ×1 | 全部保留 | 3 个 | 1/1 相同 | 相同 |
| v4-cli（E1b） | pi-label、pi-entry | 全部保留 | 3 个 | 2/2、1/1、2/2 相同 | 相同 |
| v4-compaction（E1b） | 无 | — | 3 个，其中两个在压缩事务之后 | 创建和读回都成功 | 相同 |

原始的 v4-cli 读不回来（§1 第 1 条），E2 改用它的 E1b 版本。

## 5 对方案的影响与建议（交编排者决定）

1. **P1-9b 转换器要修订**，建议照 E1b 的原型：
   - 每个检查点前写 `compaction/start` 和 `compaction/summary`，后写 `compaction/end`；
   - 归属：回合内的检查点记为该回合，回合之间的记为 `turn:null`；
   - 检查点的 `sourceEventSeqs` 以 start、summary 开头；
   - `compactionId` 沿用 pi 条目 id。
   - 原型里有三处是凑的，正式实现要定下来：
     - `summary` 取了检查点的全文，DSH 实时写的是不带框的摘要正文；
     - `shadowedTokenCount` 填了 0，`dsh-token-meter` 可能拿它估算上下文压力，建议按字符数估一个值；
     - `provider` / `model` 取的是前一条助手消息的。
   - `checkSeed` 要加上同样的事务规则，这 8 份才会在单测里先挡住。`legacy-pi-dsh` 的种子和投影金样本随之变化，由编排者收口时重录。
   - 另外两处要同步：决策 076 第 1 条加补注，分片 03 §5 的那句更正。
2. **P1-9c 的「核对」必须是 dispose 之后的冷读。**
   - 构造器不校验压缩事务，live snapshot 也不经过读盘校验，只看这两样，会把读不回来的会话写进桩。
   - 冷读就是读盘校验本身，读不回来就判迁移失败，阶段记 verify，不写桩，也不提交。
3. **幂等比较**：「事件数与摘要一致就复用」时，比较已存在日志的种子部分即可。`session/end-seed` 的 `time` 每次不同，要排除在外。
4. **会话 id 里的「.」**：
   - DSH 的 projection cache（`dsh-session-projection-cache`，底层是 `dsh-storage-json`）要求记录键匹配 `/^[a-zA-Z0-9_-]+$/`；
   - id 含「.」的会话写不进缓存，只告警「cache stays stale」，功能不受影响；
   - 现有回退 id `….r<n>` 和方案里的 `….m<n>` 都会触发（第一次运行时用 `….f<n>` 做 fork 子会话时看到了这条告警，之后改成了 `-f<n>`）；
   - 是否把后缀换成不带「.」的，一并请编排者决定。

## 6 修订后重跑（2026-09-29）

- **改动**（决策 121）：
  - 转换器 `SEED_CONVERTER_VERSION` 从 1 升到 2。每个替换型检查点前写 `compaction/start` 和 `compaction/summary`，后写 `compaction/end`：
    - 归属：在回合里的记该回合，在回合之间的记 `turn:null`；
    - `summary` 是不带框的摘要正文块；
    - `shadowedTokenCount` 用 DSH token-meter 的估算器（照搬为 `convert/tokenEstimate.ts`，另有漂移测试）；
    - `provider` / `model` 取前一条回复的，没有就用 `legacy`。
  - `checkSeed` 加了 `read/compaction` 规则。
  - 实验脚本删掉了 E1b 原型，现在直接用转换器的输出。
- **命令**：`out-node-runtime/node src/dsh-host/tools/seed-experiments.ts --out /tmp/p1-9c-exp2.json`，退出码 0。
- **结果**：
  - 能转换的 27 份（其中 8 份含压缩，共 10 个检查点）全部通过 E1 的每一项：
    - 冷读与种子逐事件相同，之后只有 `session/end-seed`；
    - 马上可以 resume；首轮 `request/header` 为 `initial`，头被原地替换，回合 `completed`；
    - RECALL 通过；replay 降级告警 0 条。
  - 同一源两次转换相同、同 id 再建被拒、cwd 不存在也能建，与第一轮相同。
  - E2 的五个会话（v4-import-claude、v4-subagent、v4-basic、v4-cli、v4-compaction）：冷读与 fork 都保留 ignorable 事件；bridge 的 fork 种子与 DSH 的逐字节相同，包括跨压缩事务的边界。
