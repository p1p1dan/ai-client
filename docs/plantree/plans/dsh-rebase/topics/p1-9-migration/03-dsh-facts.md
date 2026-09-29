# P1-9 分片 03 · DSH 侧事实、写入方式与耗时估算

Role: detail shard。上位：[P1-9 方案](../p1-9-migration.md)。回答调研问题 3，并补充问题 2 的 DSH 一侧。2026-09-27 只读核对 `0.1.7-rc.2` 装好的包，路径省略前缀 `src/dsh-host/node_modules/@deepseek-ai/`。与 [P1-4 分片 02](../p1-4-bridge-parity/02-dsh-facts.md) 重复的事实只列结论。标「推断」「需实测」的没有运行验证；本次没有起宿主。

## 1 种子写入口

- **agent 级入口**：`ctx.agents.create({sessionId, seed, inheritedEventCount?, meta, agentOptions})`（`dsh-agent/lib/types/index.d.ts:48-104`）。
  - `seed` 是「重放或 fork 历史，从 seq 0 连续，无损 JSON」（`:74-80`）。
  - `meta.isSeeded` 才表示 fork 血统；只给重放历史不算继承，`inheritedEventCount` 必须是 0（`dsh-session/lib/types/types.d.ts:101-123`；`dsh-session/lib/index.js:1300-1304`）。
  - `meta` 不收 `createdAt`：「internal-only，a factory caller never sets it」（`dsh-agent/lib/types/index.d.ts:55-71`）。所以迁移出来的 DSH 会话头时间是迁移时刻。
- **落盘**：挂了持久化时，`create` 先 `persistence.create(header)` 取得写锁，再经句柄追加种子；之后 `ctx.sessions.flush(session)` 是官方的持久化屏障（`dsh-agent-loop/README.md:115`；`dsh-session/README.md:72-74`）。这与 P1-4b 的 fork 路径是同一条。
- **构造器校验**（`dsh-session/lib/index.js:1283-1312`、`:1070-1180`）：
  - 信封只允许 `type / seq / time / data / surfaceOp / sourceEventSeqs / ignorable`，`ignorable` 只能是 `true`；
  - seq 必须从 0 连续；
  - 消息事件要有非空 id、正确的 role、非空 `source.kind`；助手的 source 必须是 `model` 且带 provider / model；工具结果的 `source.callId` 必须等于 `toolCallId`；
  - `request/header` 要有 provider / model，原因只能是四种之一；
  - surface 转换逐条校验（`replace` 的区间、`sourceEventSeqs` 覆盖全部被遮节点）；
  - 助手的 `stream` 只检查是数组，不重放。
  - 非 fork 的种子末尾自动补一个不带标记的 `session/end-seed`（`:1311-1312`）。
- **关系不变量**（回合 / 步的包含、工具调用与结果配对）只在挂了 `dsh-invariants` 时检查（`dsh-session/lib/invariant.js:21-105`），产品宿主没挂（推断）。转换器自己带一份同样的检查器，在根 vitest 里跑。
- **低层入口**：`ctx.sessionPersistence.create / open / append` 也能直接写日志，loop 就是这么用的。它绕过 agent 层的构造与插件，公开程度与稳定性未核实，只作备选（D5 C）。

## 2 一个合法种子长什么样

照 loop 的实际写法（`dsh-agent-loop/lib/index.js:936-1025` 的 `turn()`，`:1026-1145` 的 `step()`）：

```
turn/start {turn:1}
  step/start {turn:1, step:1}
    system/message {turn:1, step:1, message:{content:[]}}   ← 只在第一步；空头占住 0 号节点
    user/message {…, source:{kind:'user'}}                  ← 本步输入
    assistant/message {turn:1, step:1, message, usage?, stream:[]}
    tool/call {turn:1, step:1, callId, name, arguments}      ← 每个调用一条
    tool/result {turn:1, step:1, message, error?, meta?}
  step/end {turn:1, step:1}
  step/start {turn:1, step:2} … step/end
turn/end {turn:1, reason}
turn/start {turn:2} …
session/end-seed {}                                         ← 构造器补
```

- **可以不写 `request/header` / `request/context`**：`prepareRequest` 在日志里找不到头时按 AgentOptions 起步，`buildRequest` 第一次记头的原因是 `initial`（`:1148-1215`，判断在 `:1201`）。也不需要 `developer/message`：只有已有基线头时才写工具增减（`:1216-1233`）。
- **系统提示**：`SystemPromptProjection.project` 在没有系统节点时把第一条提示词追加到 surface 末尾；有头节点时，路由不支持 in-history、或开始新系列，就原地替换头节点（`:264-283`；README:121）。
  - 恢复时 `requestSurfaceGeneration` 取挂接时的当前代（`:763,776`），第一步通常不算新系列；决定因素是路由能力。
  - `llm-pi-ai` 不声明 `systemPromptUpdate`（包里没有这个字样），按「不支持 in-history」处理，所以第一步会替换头节点（推断，E1 验证）。
  - 结论：种子要在第一步放一个空头；不放的话，DSH 提示词会出现在整段迁移历史之后。
- **空的 `stream` 合法**：读盘时只验数组形状；格式迁移时的全量校验遇到空流直接跳过内容、用量、replayState 的比对（`dsh-session-persistence-jsonl/lib/index.js:1833-1849`，判断在 `:1844`）。代价只在 token 估算：token-meter 用流重组助手输出，空流记 0（`dsh-token-meter/lib/index.js:789-792`）；带 `usage` 时累计用量照常（`dsh-token-meter/lib/types/usage-projection.js:59-66`）。
- **结束原因**：`aborted.reason` 有专门的 `{kind:'legacy'}`，注释写明给「导入时原记录没写原因」用（`dsh-session/lib/types/types.d.ts:158-161`）；`interrupted` 是恢复时补写的持久原因（`:190-198`）。
- **消息 id** 是不透明字符串，不校验格式（`dsh-llm/lib/types/brand.d.ts:13-19`）；fork 时原样复制，跨会话重复是常态（P1-4 分片 02 §2）。

## 3 助手消息的重放与用量

- pi-ai 适配器把 DSH 助手消息还原成 pi-ai 消息：
  - 有 `source.replayState` 时，按块还原 `textSignature`、`thinkingSignature`、`redacted`、`thoughtSignature`，以及 `api`、`responseId`、`providerThinkingLevel`（`dsh-llm-pi-ai/lib/index.js:183-238`）；
  - 没有，或 provider / model / 块数 / 块类型对不上，就降级成「外来历史」，只报诊断不失败（`:240-259`、`:144-181`）。
- `replayState` 的形状由 pi-ai 的 AssistantMessage 直接算出（`toPiReplayState`，`:61-93`，`kind:'pi-ai', version:2`）。1.0.x 存的正是 pi-ai 的 AssistantMessage 原样，所以转换器按同一公式算就能无损。provider 一致的前提由决策 035 保证：路由键就是我方 provider id。
- 用量映射 `mapUsage`：`input→inputTokens`、`output→outputTokens`、`totalTokens` 原样，缓存两项非零才写（`:1367-1375`）。转换器照抄，会话累计用量与 1.0.x 连续。
- 用户消息和工具结果可以带图片；助手消息带图片会被适配器拒绝（`:168`、`:1176-1181`）。

## 4 自定义事件：运行期不行，种子里可以

- `Session.append` 构造事件时只带 `surfaceOp` / `sourceEventSeqs`，设不了 `ignorable`（`dsh-session/lib/index.js:1401-1419`）。这是决策 026 第 5 条的依据，结论不变：bridge 运行期不能追加自定义事件。
- 种子是另一条路：
  - 信封允许 `ignorable:true`（`:1070-1086`）；
  - surface 校验遇到「不认识且 ignorable」的事件直接放行（`surfaceOpOf`，`:295-299`）；
  - 读盘时，不认识但标了 ignorable 的事件放行，只有没标的才拒绝（`dsh-session-persistence/lib/index.js:170-195`）；
  - 事件表的注释明说：下游（仓库外）插件的事件本来就不在表里，持久化的 `ignorable` 标记就是兼容机制（`dsh-session/lib/index.js:66-78`）；
  - DSH 自己的 v3→v4 格式迁移保留这类事件：改名为 `plugin:<原名>`，载荷不动（`dsh-session-format-v3-to-v4/README.md:69,164,187`；`lib/index.js:1297-1305`）。
- 推断：P1-4b 的 `buildForkSeed` 原样复制事件，ignorable 事件会随 fork / 回退带走；各投影单元对不认识的类型直接返回原状态，不受影响。**需实测**（实验 E2）。
- 风险：以后的 DSH 版本若改规则，可能丢弃或改名。钉版本加金样本比对能第一时间发现；投影同时认 `aiclient/<名>` 与 `plugin:aiclient/<名>`。

## 5 压缩与附件

- **压缩**（`dsh-compaction-basic/README.md`「What happens when condensation runs」与「Automatic triggers」）：
  - 最旧的一段平衡区间被一条摘要消息替换，最近的尾巴原样保留；区间总是从第一个非 `system/message` 的节点开始。
  - 检查点是 user 消息，`source` 为 `{kind:'compact-checkpoint', compactionId}`（`dsh-compaction/lib/index.js:109-130`），正文用 `<compacted-summary>` 标签框住（`dsh-compaction-basic/lib/index.js:234-235`）。
  - 实时压缩还会写 `compaction/start`、`compaction/summary`、`compaction/end` 三个括号事件。~~种子里不写：没有未闭合的 start 就不存在「压缩锁」（README「The region transaction」）。~~
  - **更正（2026-09-29，P1-9c 实验 E1）：种子里必须写。**
    - DSH 读盘时的格式校验（`dsh-session-persistence-jsonl` 的 worker，与 `dsh-compaction/lib/invariant.js` 同一规则）要求：每个替换型检查点都落在同一 `compactionId`、同一归属的事务里；summary 要紧挨在检查点之前，并且说清它遮住的 surface 区间。
    - 种子构造器不查这一条。不写的话，会话写得进去，读不回来。
    - 转换器从版本 2 起照写（[决策 121](../../decisions/121-p1-9c-seed-session-choices.md)，证据 [p1-9c-seed-experiments-2026-09-28](../../evidence/p1-9c-seed-experiments-2026-09-28.md)）。
- **附件**（`dsh-attachment-local/README.md:12,39-48,55,86,136`）：
  - 入口 `ctx.attachments.saveImages` / `admitPromptContent`（`dsh-attachment/lib/types/index.d.ts:43-51`）；
  - 单张上限 20 MiB、6400 万像素、每边 8192；归一化到 2048² 像素、4 MiB；干净的单帧 8 位 sRGB PNG / JPEG / WebP 在限内时原样通过；
  - 按内容哈希去重，永不自动删除；
  - 归一化依赖 sharp（许可问题见 Q007）。若最终不随包带 sharp，非「干净」的图片入库会失败（推断），转换器退回文本占位。

## 6 为什么在宿主里用 DSH API 写，不自己拼 zstd

1. **格式是 DSH 私有的，而且会变。** 物理编码是多个带校验的独立 zstd 帧，头一帧只含 header，`sourceEventSeqs` 会把连续 seq 压成区间（P1-4 分片 02 §5）。运行时总取最高代际，读打开只在内存里迁移，写打开才发布新代（`dsh-session-persistence-jsonl/README.md:82`）。自己拼等于复刻一个会漂移的私有编码器。
2. **校验。** 走 `agents.create`，种子在落盘前就经过构造器和 surface 校验（§1）。手写的文件要等用户第一次打开才暴露问题，那时已经没有原始上下文可以重做。
3. **写锁。** DSH 每个会话只能有一个写者，用内核锁（POSIX `flock`、Windows 命名信号量）。外部写者绕过它，可能与共享宿主里正在跑的会话冲突。
4. **加密机。** 只有随包 node 上的宿主是白名单载体（决策 012）。pi 原文件只有它能读到明文；DSH 日志与附件也必须由它写，之后它才能读回。Main（Electron）不在白名单里。
5. **附件库。** 图片要进内容寻址的附件库，写入有完整的 fsync 链与原子硬链接发布（`dsh-attachment-local/README.md`「Design decisions」）。自己写很容易写出「引用在、对象没落盘」的日志。

## 7 耗时与内存估算（推断，实验 E3 实测）

依据：P0-6 实测，2000 条消息的活会话历史约占 +46 MB RSS；4 个 2000 条的长会话同时拼请求，事件循环卡 0.2～0.3 s。

| 规模 | 源文件 | 转换 CPU | 其中同步阻塞宿主事件循环 | 临时内存 |
|---|---|---|---|---|
| 200 条消息 | ≈0.2～0.5 MB | ≈50～150 ms | ≈20～50 ms | ≈5～10 MB |
| 2000 条消息 | ≈2～6 MB | ≈0.5～1.5 s，另加一次恢复 0.3～0.8 s | 构造器单次同步校验 ≈0.1～0.4 s | ≈20～60 MB |
| 32 MiB 上限 | 32 MiB | ≈5～10 s | ≈1～2 s | ≈200～350 MB |

- 构成：pi 解码（JSON 解析 + 建条目）、构造种子、构造器的深拷贝与冻结、zstd 编码与 fsync、之后标准恢复再读一遍。
- 图片：每张走一次 sharp 归一化，约 50～300 ms；并发上限 2（`imageCompressionConcurrency`）。
- 缓解：
  - 宿主内一次只做一个迁移，各阶段之间让出事件循环；
  - 超过 8 MiB 的源给「正在迁移」进度提示；
  - 开发机 3.3 GB，实验时单独跑，先 `free -m`。
- 磁盘：DSH 日志经 zstd，约为 JSONL 的 1/5～1/10（推断）；图片按哈希只存一份。pi 原文件不删，所以总占用约是原来的 1.1～1.3 倍。
