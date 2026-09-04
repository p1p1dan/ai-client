# Evidence — U08-2 思考强度补齐 Pi 七档（批次 5）

**日期**：2026-09-03
**分支**：`feat/pi-primary-backend`
**切片**：U08-2（思考档词汇对齐 Pi 的 `ThinkingLevel`）
**执行计划**：[execution-plan §三 批次 5](../topics/execution-plan.md)
**迁移规则**：[evidence-q06](../topics/evidence-q06-migration.md)（解 [Q06](../open-questions.md)）

## 一、做了什么

Pi 的思考档有七个：`off · minimal · low · medium · high · xhigh · max`（Pi SDK 的
`THINKING_LEVEL_OPTIONS`，默认 `medium`）。本仓的界面和几处边界只认其中五个——中间那五个恰好也是
Claude Agent SDK 的 `EffortLevel`，所以这套代码一直在用 Claude 的词汇表跑 Pi。本片把两头补齐。

结果是：用户在思考档菜单里现在能看到并选中「Off」和「Minimal」，选中后这两个值真的会走到 Pi 的
`setThinkingLevel`，而不是在某一层被悄悄丢掉。

## 二、比计划多改了五处（重要）

execution-plan 原文写「真缺口只有两个常量」。复核时那句话是对的——但它只查了**显示层**。
实际动手后发现，同一份五词清单在**边界校验**处还有三份拷贝，另有两处类型缺口：

| # | 位置 | 原状 | 后果 | 计划内？ |
|---|---|---|---|---|
| 1 | `shared/types/agentHost.ts:7` `SESSION_EFFORT_LEVELS` | 五词 | 词汇表源头 | ✅ 计划内 |
| 2 | `renderer/components/chat/efforts.ts:25` `CHAT_EFFORTS` | 五词 | 菜单里看不到两档 | ✅ 计划内 |
| 3 | `shared/types/workerRpc.ts:340` `isWorkerEffort` | 五词**独立拷贝** | **发布级**：bootstrap 载荷带 `off` 会被整条判非法，worker 根本起不来 | ❌ 计划外 |
| 4 | `agent-host/piUtilityRunner.ts:40` `resolveEffort` | 五个 `===` 比较 | Pi 配置里设的 `minimal` 被静默丢成「用模型默认」 | ❌ 计划外 |
| 5 | `agent-host/piAgentSessionBootstrap.ts:71` `PiThinkingLevel` | 缺 `off` | `setThinkingLevel('off')` 是类型错误 | ❌ 计划外 |
| 6 | `main/ipc/git.ts` ×3 | `as 'low'\|...\|'max'` 无校验强转 | AI 功能（提交信息/代码评审/分支名）表达不了新档，且未校验的字符串被直接强转 | ❌ 计划外 |
| 7 | `shared/types/agentCatalog.ts:31` | `SessionEffortLevel \| 'off' \| 'minimal'` | 补齐后成冗余，留着就是下一次漂移的种子 | 清理 |

第 3 项是这次最值得记的一条：**它不是「新档不生效」，而是「带新档的会话起不来」**。
因为守卫返回 false 会让整个 bootstrap 载荷判非法，不是只忽略 effort 字段。
计划里那句「真缺口只有两个常量」如果照着做完就收工，菜单会多出两个选项、点下去会话直接起不来。

这正是 memory 里「pi 词汇表漂移」那条的第二次发作：渲染层按 Claude 词汇查表并**静默失效**。
本次的修法是把词汇表变成单一定义——第 3、4 项现在都调用 `isSessionEffortLevel`，
第 2 项的 `CHAT_EFFORTS` 由 `SESSION_EFFORT_LEVELS` `map` 出来（顺序和成员都不再是第二份手抄）。

## 三、`off` 在两条路径上不对称（取证发现，非选择）

Pi 的依赖树里有**两个**同名 `ThinkingLevel`，成员不同：

| 包 | 定义 | 谁在用 |
|---|---|---|
| `@earendil-works/pi-agent-core` | `off` + 六档 = **七档** | `AgentSession.setThinkingLevel` / `createAgentSessionFromServices({ thinkingLevel })`——即**聊天**路径 |
| `@earendil-works/pi-ai` | 无 `off`，**六档**（`off` 另立为 `ModelThinkingLevel`，用于模型配置而非请求） | `SimpleStreamOptions.reasoning`——即**一次性补全**路径（提交信息 / 代码评审 / 分支名） |

所以 `off` 在聊天里是真档位，在 AI 功能的一次性补全里**根本无法表达**。
这是先由 `pnpm typecheck:agent-host` 报错逼出来的（`Type '"off"' is not assignable to type 'ThinkingLevel'`），
不是我们的取舍。

处理方式：`piUtilityRunner` 的返回类型收窄为 `Exclude<SessionEffortLevel, 'off'>`，
遇到 `off` **省略 `reasoning` 字段**（= 供应商默认），而**不是**替换成 `minimal`。
理由写在代码注释里：替换会把一个用户从没选过的档位放上线；省略至少和本片之前的行为一致，不是回退。

## 四、迁移是超集，不是迁移

evidence-q06 要求「纯 mapper + read 时映射 + 不静默重写」。落到本片，结论比那更简单：

`EffortLevel`（旧五档）是 `ThinkingLevel`（新七档）的**真子集**，
所以每一个已存偏好的含义**逐字不变**，没有任何值需要翻译。mapper 退化为恒等，
「迁移」这件事实际不存在——需要守住的只有三条：

1. 存储守卫跟着放宽（`writeSessionEffort` 走 `isEffortSelection`，由 `CHAT_EFFORTS` 派生，自动放宽）。
2. 读取不回写（`readSessionEffort` 是纯读；已加测试断言读完 `localStorage` 逐字节未变）。
3. 未知值仍落 `default` 哨兵而**不是** `off`——两者语义相反，见下节。

## 五、`off` 与 `default` 是相反的指令

菜单里这两行紧挨着、中文读起来都像「少想点」，但在协议上相反：

- **`off`** 是一个档位，会作为 `effort: 'off'` 发上线，把推理钉死为关。
- **`default`** 是「不发这个字段」，让 Pi 用它自己的默认（当前是 `medium`）。

把两者混同的后果是「用户选了不推理，实际跑中等推理」，且界面上看不出来。
`toWireEffort('off') === 'off'`、`toWireEffort('default') === undefined` 各有断言，
另有一条断言走完整的优先级链（会话选择 → agent 模板 → 无），确认两者一路不串。

顺带核实一处：Main 侧到处是 `...(input.effort ? { effort: input.effort } : {})` 的真值展开。
`'off'` 是非空字符串、真值，能安全穿过；这条已写进 `toWireEffort` 的注释，免得日后有人改成空串哨兵。

## 六、验收对照

| execution-plan 验收 | 结果 | 依据 |
|---|---|---|
| ① 七档按 `thinkingLevelMap` 过滤显示 | ✅ | `efforts.test.ts`「surfaces off and minimal when the model declares them」+「reconciles off away when the model does not declare it」。config 层与过滤逻辑本就支持七档，本片只补上目录行 |
| ② 旧偏好 low..max 恒等，无静默重写 | ✅ | `efforts.test.ts`「widening is a superset, not a migration」；`sessionPreferenceStore.test.ts` 断言读取后 `localStorage` 原文未变 |
| ③ 未知值落 `default` | ✅ | 同上；`'ultra' / 'none' / 'OFF' / ''` 四个垃圾值全部落 `EFFORT_DEFAULT_ID`，且 `toWireEffort` 返回 `undefined` |
| ④ `off` 与 `default` 的 wire 行为各有测试且互不混淆 | ✅ | `efforts.test.ts` 的 `off is a level, default is the absence of one` 三条，其中一条按真实发送路径做真值展开而非只测 mapper 返回值 |

计划未列但一并锁定的：RPC 边界接受 `off`/`minimal`（`workerRpc.test.ts`）、
一次性补全路径转发 `minimal` 且对 `off` 省略字段（`piUtilityRunner.test.ts` 五条）。

## 七、变异验证

把 `workerRpc.ts` 的 `isWorkerEffort` 改回五词手抄清单，`workerRpc.test.ts` 立即失败
（1 failed | 9 passed），恢复后全绿。这条验证的是第 3 项那个发布级守卫确实被测试盯住，
而不是「因为改对了所以碰巧过」。

`efforts.test.ts` 的目录断言在改动前也真实失败过（`expected [off, minimal, low, …] to deeply equal [low, …]`），
属于同一类证据。

## 八、门禁

串行执行，未并行、未整套并发：

| 门 | 结果 |
|---|---|
| 全仓 Vitest（`--maxWorkers=1 --no-file-parallelism`） | **261 files / 4066 tests pass** |
| `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck` | pass |
| `pnpm typecheck:agent-host` | pass（本片触及 agent-host，按规范追加） |
| `pnpm exec biome check <11 个改动文件>` | clean |
| `git diff --check` | clean |

对比基线：批次 4 收口时为 261 files / 4049 tests，本片净增 17 条断言、无新增文件。

## 九、一处必须记住的构建约束

`workerRpc.ts` 原本只 `import type` 了 `agentHost`，本片改成**值导入**（要用 `isSessionEffortLevel`），
`workerStripOnlyCompat.test.ts` 立刻报错：Pi worker 在 dev 下以**源码**形式被 Node 的
strip-types 模式加载，ESM 解析器不做扩展名搜索，相对**值**导入必须写全 `.ts`。
该文件里 `./sessionHistory.ts` 早就为同一个原因写了长注释，本次照做并补了说明。
类型导入不受影响（会被擦除），所以这个坑只在「把 type import 改成 value import」时才踩得到。

## 十、欠项

- **GUI 点验未做**：新的 Off / Minimal 两行在真实窗口里的观感与菜单长度未肉眼确认。
  与 U09 / U12 / U02 / U03-a / U05 的待做点验合并一次 CDP 出图。非取证型验收，不阻塞。
- **未验真实回合**：`off` 走到真实 Pi 供应商后的实际效果（是否所有供应商都接受 `off`）未跑真账号验证。
  类型链与 SDK 声明已逐段核实，但这不等于每家供应商的服务端都认。
- **AI 功能的 `off`**：如第三节，一次性补全路径无法表达 `off`，当前落到供应商默认。
  若日后要让它真的关推理，得走 Pi 的模型配置层（`ModelThinkingLevel`），不是这个请求参数。
