# 决策 158：LC-2 受害者间隔硬门槛加显式抖动余量

日期：2026-10-07。**状态：自主决定，待用户审批。**

依据：

- [决策 067](067-contention-regression-gates.md) 第 2 条（硬门槛每次推送都跑，举例 LC-2 的 ELD、RSS 两项，已用户批准）；
- [P1-8 / P1-11 方案分片 05 第 51 行](../topics/p1-8-p1-11-guards-and-terminal/05-regression-tests-changes.md)（LC-2 硬门槛逐条清单，写的是「受害者最大 delta 间隔 ≤ ELD + 150 ms」）；
- [决策 081](081-loop-guard-implementation-choices.md) 第 6 条（受害者场景改用带发送时间戳的 `P8-VICTIM`，扣掉假网关自身停顿，原始间隔同时列出）；
- [决策 154](154-p1-8c-ci-wiring-choices.md) §5「本机实测」与§7 第 1 条（CI 接线阶段已经记录过一次本机临界失败，当时判断「不是本次改动引入的新问题」，留给首次 CI 真跑后回看）；
- 代码：`src/dsh-host/tools/contention-regression.ts`（第 105 行注释原文「the 150 of the gate "gap <= ELD + 150 ms"」）、2026-10-08 CI run `37709934981`（`dsh-bridge-gate`，`ubuntu-latest`）。

## 1 缺陷

`contention-regression.ts` 的 LC-2 硬门槛原写作「受害者最大 delta 间隔 ≤ ELD + 150 ms」。这个 150 不是独立选定的余量，而是受害者场景 `P8-VICTIM` 自身的定速常量 `VICTIM_CHUNK_MS`（第 105～106 行注释已承认两者是同一个数）。也就是说门槛实际是「gap ≤ ELD + 定速」——对一个完美调度、零抖动的宿主，受害者相邻两条 delta 的间隔恰好等于定速周期加上宿主当时的 ELD；门槛对进程调度、IPC 往返等宿主事件循环之外的抖动**没有留任何余量**。这不是「退化」和「噪声」之间留了安全边际的门槛，是一个只要稍微抖一下就会红的门槛。

真正想抓的回归（决策 067、分片 05）是「4 个大会话同时加载时受害者被饿死」，数量级是数百毫秒到秒级（分片 05 §1 的 P0-6 基线：4 个 2000 条会话同时请求时 max 192/200/291 ms 的影响已经计入 ELD，受害者本身的额外延迟在那次基线里还没有单独量过）。几十毫秒的抖动和「饿死」完全不是一个量级，不应该用同一条零余量的门槛去判。

## 2 两次实测数字

| 时间 | 环境 | 受害者最大间隔（已扣网关停顿） | ELD | 门槛（旧：ELD + 150） | 超出 |
|---|---|---|---|---|---|
| 2026-10-07 | 开发机（2 核 / 3.3 GB） | 249.6 ms | 71.4 ms | 221.4 ms | **28.2 ms** |
| 2026-10-08 | CI `dsh-bridge-gate` run `37709934981`（`ubuntu-latest`） | 184.9 ms | 22.3 ms | 172.3 ms | **12.6 ms** |

两次都是当次 job 的唯一失败项；开发机那次单跑 `--only LC-2` 复跑即过（决策 154 §5 也记录过一次同类临界失败，当时的结论是「首次 CI 跑之后要回看」，这正是那次回看）。两次失败没有伴随 RSS、pong 超时、回合未完成等任何其他异常，只有这一项间隔门槛临界超出，与「饿死」应有的数量级（数百 ms 以上，且会伴随其他指标同时恶化）不符，判定为门槛设计缺陷而非真实回归。

## 3 修复

`GATES['LC-2'].hard` 不再用一个独立的 `victimGapOverEldMs: 150` 字面值，改成：

```ts
export const VICTIM_CHUNK_MS = 150; // paces P8-VICTIM's own deltas

hard: {
  eldMs: 1000,
  rssMb: 600,
  victimPacingMs: VICTIM_CHUNK_MS, // pulls the same constant, not a second literal
  victimJitterMs: 100,             // decision 158: explicit margin on top
  pongRttMs: 2000,
},
```

判定改为 `gap <= ELD + victimPacingMs + victimJitterMs`，判定名改成 `` `LC-2 victim gap <= ELD + ${victimPacingMs} ms pacing + ${victimJitterMs} ms jitter` ``（旧名 `` `LC-2 victim gap <= ELD + ${victimGapOverEldMs} ms` ``），把 150 来自定速的关系写成代码里对同一个常量的引用，而不是两个碰巧相等的数。`VICTIM_CHUNK_MS`、`GATES`、`judge()` 一并搬到新文件 `src/dsh-host/tools/lib/contentionGates.ts`（纯函数/常量，无副作用），`contention-regression.ts` 从那里导入；这样 `judge()` 有了一个不会触发真实宿主/网关进程的单测入口（该脚本顶层是 `process.exitCode = await main()`，直接导入脚本本体会把回归真跑一遍）。LC-0、LC-1 的门槛、`--runs`、软门槛均未改动。

## 4 余量取值：100 ms

- 覆盖已观测到的两次超出（28.2 ms、12.6 ms）里较大的一次（开发机 28.2 ms）约 **3.5 倍**（100 / 28.2 ≈ 3.55），给未知的调度/IPC 抖动来源留出远超实测的空间，不是刚好卡着实测值走。
- 100 ms 仍然比「饿死」级别的回归（数百 ms 到秒级，参见 §1、P0-6 基线 4 会话同时请求 max 192～291 ms 只是单次请求拼接的延迟，真正的「受害者被饿死」预期是这个量级反复叠加或更糟）小一个数量级以上，门槛不会因此变得形同虚设：如果受害者间隔真的被挤到几百毫秒以上，这条门槛仍然会红。
- 没有选择把 150 本身调大（例如改成 200）：150 是受害者定速周期，调大它会改变场景本身的语义（受害者变成以更慢的速度定速，不再是「最坏情况下也该多快」的那个假设），而加法余量只影响门槛判定，不影响场景怎么跑。
- 没有选择用相对比例（例如 150 × 1.2）：决策 067 第 3 条软门槛已经用「1.3～1.5 倍」的相对比例，硬门槛沿用分片 05 §4「硬门槛取用户能感知的冻结」的绝对值风格更一致，也更容易用两次实测数字直接核验。

## 5 单测

`src/dsh-host/tools/lib/__tests__/contentionGates.test.ts`（新增，5 例）：

1. `victimPacingMs === VICTIM_CHUNK_MS`（核实「150 来自定速」是代码里的真实引用关系，不是巧合）。
2. 判定名包含 pacing/jitter 两个词面值。
3. `gap = ELD + 150 + 99` 通过。
4. `gap = ELD + 150 + 101` 不通过。
5. 用本决策 §2 的两组真实超标数字（开发机 249.6/71.4、CI 184.9/22.3）回放：按旧门槛（`ELD + 150`）两者都会超标，按新门槛两者都通过——直接证明这次修复解决的是本次缺陷报告的两次真实失败。

## 6 对决策 067 / 分片 05 第 51 行的修订注记

- 决策 067 第 2 条「硬门槛每次推送都跑，例如 LC-2：ELD ≤ 1 s、RSS ≤ 600 MB、没有卡死判定」本身没有写受害者间隔门槛的具体公式，不需要改数字，但该决策末尾已加一行补记指向本决策（见[决策 067](067-contention-regression-gates.md)文末补记）。
- 分片 05 第 51 行「受害者最大 delta 间隔 ≤ ELD + 150 ms」是过时表述，实际行为已改为「≤ ELD + 150 ms 定速 + 100 ms 抖动余量」；分片属于详细方案文档，本决策不改分片原文（分片记录的是立项阶段的构想，决策 154 §4 已有先例：实现阶段对分片的偏离记在决策里而不回改分片），只在此处和决策 067 补记里留下修订指向，供以后读分片 05 的人顺着决策号找到最新口径。

## 7 待用户确认

1. 抖动余量 `victimJitterMs: 100`（§4 的理由）是否认可；如果用户认为应该更保守或更紧，给出想要的数值。
2. `VICTIM_CHUNK_MS`、`GATES`、`judge()` 搬到新文件 `src/dsh-host/tools/lib/contentionGates.ts` 这个「最小改动导出」的做法是否认可（不是修改 `contention-regression.ts` 本体直接 `export`，因为该脚本顶层有真实的进程/网关副作用，不适合被测试文件 import）。
3. 本次只动了 LC-2 的受害者间隔门槛；LC-0、LC-1、`--runs`、软门槛均未碰，是否还需要对其他场景做类似的「门槛是否对非目标抖动留了余量」复查（本次未展开，超出本次缺陷修复范围）。
