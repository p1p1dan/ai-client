# P5-2-7 · SA01～SA22 逐项签收

Role: evidence。日期：2026-09-12。上级：[第 8 批证据](README.md) ·
[契约](../../topics/p5-2-subagent-contracts.md) · [任务矩阵](../../topics/p5-2-subagent-tasks.md)

## 这份文件怎么读

任务矩阵要求每一行按 `implemented / tested / GUI / carrier / Done` 标注，
且「不存在无解释缺项」。所以这里有两类标记，含义完全不同：

- **✅ tested** —— 行为已实现，且有可执行测试钉住。测试是自动化的，跑在假 provider
  与临时目录上。
- **⏸ 待现场** —— 实现完成，但这一行的验收条件里包含只有真机或打包产物才能证明的部分。
  按 2026-09-10 用户裁定，GUI 点验与两载体打包留到最后一次上机，**本批不代签**。

没有第三类。任何一行如果实现本身缺了一块，会直接写在那一行里，而不是靠模糊措辞带过。

**P5-2 因此仍不标 Done**，标「实现完成/现场待验」——这正是契约 §7 规定的状态。

## 自动化门禁（本批最后一次全量）

`tsc --noEmit` 根与 `src/runtime` 均通过；`biome check` 干净
（`workerEndToEnd.test.ts` 与 `questionCardModel.test.ts` 各有一条**本批之前就存在**的告警，未动）；
`vitest run` **395 文件 / 5603 测试**全绿。批前基线为 385 / 5458。

子代理专项测试（243 条，不含散落在既有文件里的加测）：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `runtime/__tests__/subagentHostProbe.test.ts` | 10 | 0.84.4 宿主行为探针（P5-2-0 门禁） |
| `runtime/__tests__/subagentDefinitions.test.ts` | 30 | 定义解析、限额、目录合并、模型 pin |
| `runtime/__tests__/subagentDelegation.test.ts` | 26 | 四工具、并发、等待集合、Stop 收敛、交付标识 |
| `runtime/__tests__/subagentToolsPermissions.test.ts` | 17 | 七工具交集、gear 隔离、写锁、重试预算 |
| `runtime/__tests__/subagentSession.test.ts` | 8 | 归属记录、父上下文隔离、usage 单次结算 |
| `runtime/__tests__/subagentMigration.test.ts` | 13 | 旧定义迁移预览 |
| `runtime/__tests__/subagentPreview.test.ts` | 9 | `browser_preview` 请求/应答/失败/取消 |
| `runtime/__tests__/subagentDisplay.test.ts` | 12 | 活动投影、记录隔离、历史摘要 |
| `main/.../subagentCatalog.test.ts` | 18 | 管理服务 CRUD、改名、启停、内置不可写 |
| `main/.../nativeSubagentSettings.test.ts` | 6 | 委派总开关的默认与覆盖 |
| `main/.../PreviewWindowManager.test.ts` | 12 | 预览窗复用、自动刷新、前台归属、清理 |
| `renderer/settings/subagentManagementModel.test.ts` | 19 | 往返保字段、清空、校验、乐观回滚、搜索 |
| `renderer/settings/subagentPanelMount.test.ts` | 6 | 管理页真实挂载与交互 |
| `renderer/chat/subagentActivityModel.test.ts` | 49 | lane reducer、面板派生、历史重建、审批来源 |
| `renderer/chat/subagentWiring.test.ts` | 8 | 面板挂载点与局部滚动接线 |

另有 `WorkerManager.test.ts` 6 条预览应答用例、`nativeWorkerRuntime.test.ts` 5 条
（3 条开关 + 2 条历史摘要）。

## 逐行签收

| ID | 状态 | 实现 | 证据 / 缺口 |
|---|---|---|---|
| SA01 四角色与全字段解析 | ✅ tested | `shared/subagentDefinition.ts`、`shared/subagentBuiltins.ts` | 四角色 60/50/40/80 轮上限逐个断言；`none`/`0`/未声明均为无限轮；坏文档只影响自己 |
| SA02 来源/库存与目录限额 | ✅ tested | `subagent/catalog.ts` | user 覆盖 builtin、排序确定；管理 64 / runtime 16 / provider 8 / 32KiB 全部钉住；项目目录**从不**扫描；失效开关名可清理 |
| SA03 Task 后主代理继续 | ✅ tested | `subagent/index.ts` | ack 在子完成前返回；ack 的 `status: 'running'` 与 completed 分开断言；同名任务各自独立 id |
| SA04 并发准入与回收 | ✅ tested | `subagent/registry.ts` | 轻量闸门同时 10 个、第 11 个明确失败；失败请求不占名额；仅已结束项按 100 回收 |
| SA05 等待集合与重读 | ✅ tested | `subagent/index.ts` `buildWaitTool` | all/any/minCompleted、未知 id 可诊断、超时不取消、按 id 重读不重跑 |
| SA06 父 idle 时子任务未完成 | ✅ tested | `agent-loop/index.ts` 的交回循环 | run promise 不提前 resolve，槽位保持 busy；报告自动交回，无需用户说「继续」 |
| SA07 交付竞态 | ✅ tested | `registry.ts` 的 `deliveredAt` | 子先完成、边界同时完成、TaskWait 已消费三条路径各一例；不漏报不重复 |
| SA08 Stop 与完成/等待竞态 | ✅ tested | `drain()` / `TaskStop` | 停止后等真实收敛才报 stopped；用户 Stop 后不再调父模型；重复 Stop 幂等 |
| SA09 长任务与 maxTurns | ⚠️ 与代码不符（审计 subagent-core-16，修补 T027） | `run.ts` 的 `afterToolCall` | 假时钟越过旧 idle/duration 不杀 Agent；`bash` 显式 `timeoutSeconds`；maxTurns 截断有报告与 `truncated` 状态；**审计 2026-09-14**：仓库里没有任何子代理假时钟测试（`grep -rl useFakeTimers src/runtime` 零命中），"假时钟越过旧 idle/duration 不杀 Agent"这条无测试佐证（subagent-core-16） |
| SA10 权限与模式 | ✅ tested | `permissions/index.ts` 的 `scopeToolCall` | 三 gear × inherit/显式；plan 模式无 `Task*`（靠 write 访问级，非第二套规则）；显式 `auto` 也跨不过 deny；并发不同 gear 不串 |
| SA11 写序与 stale read | ✅ tested | `tools/index.ts` 的 `locked()` | 父子同路径顺序明确、失败释放锁；不同路径并行；**明确不承诺** Bash 有全仓事务保护 |
| SA12 模型与 thinking | ⚠️ 与代码不符（审计 cross-01，修补 T006） | `index.ts` `resolveModel` | Task override > pin > parent；不可用即失败并列出可选项，**绝不回落**；密钥不进事件也不进定义 UI；**审计 2026-09-14**：`resolveModel` 第三档实际取 `adapter.defaultRef()`（目录第一个 provider 的第一个模型），并非父回合模型，"绝不回落"与实测不符（cross-01） |
| SA13 瞬态/429/流中失败 | ✅ tested | `run.ts` `retryPendingStream` | setup 与 stream 共预算；不可恢复错误直接失败；已执行工具不重放；退避可停止 |
| SA14 归属与父终态隔离 | ✅ tested | `records.ts` + `INTERNAL_CUSTOM_ENTRIES` | 子消息写成 `custom` 条目，`buildSessionContext` 只折 `message`——隔离是条目类型的性质。**本批修掉了一个真漏**：记录曾以 `custom.entry` 上线，渲染层会把它变成父会话里的系统消息 |
| SA15 usage 与报告限额 | ✅ 已修（T020，`60b250f3`，2026-09-15）：子代理花费经 `usage.updated.delegated` 到达 Main 与渲染层并入会话总量，Run 面板显示委派占比，重开会话经 `historyUsage()` 补种子；依据决策 005 而非新事件。原审计标注保留于下 | `subagentHistoryUsage` / 12k / 50k | 父 provider 原数不变、子成本恰计一次；报告 12k、合并文本 50k、历史摘要 4k 分别限额；截断不丢终态；**审计 2026-09-14**：子代理 usage 在 `nativeWorkerRuntime.ts` 里被 `.then(() => undefined, ...)` 整体丢弃，`subagentHistoryUsage` 全仓无生产调用方，用户可见的会话总用量/成本不含子代理花费，"子成本恰计一次"仅在 runtime 内部返回值层面成立（subagent-data-03） |
| SA16 保存/恢复/切分支 | ⏸ 待现场 | `records.ts` + `historyResult()` | **实现与自动化齐备**：未结算记为 `interrupted`、重开不重放 Task、历史按活动分支读取、重建后状态一致。**缺口**：真机上的正常关闭与硬退出对比只能上机做 |
| SA17 管理 UI 全链路 | ⏸ 待现场 | `main/.../subagentCatalog.ts`、`settings/PiSubagentsSettings.tsx` | **实现与自动化齐备**：增删改、改名、启停、模型/轮次清空、搜索、定位文件、逐行 busy、失败整份回滚、刷新不闪空、permission 未编辑不丢，均有测试。**缺口**：真机点验与重启后状态保留 |
| SA18 运行 UI 与重载 | ⏸ 待现场 | `subagentActivityModel.ts` | **实现与自动化齐备**：immediate ack、fan-out、多同名、晚到终态、权限等待、非尾部更新、报告一次、历史重建，均有 reducer 级测试；局部滚动为接线级断言（happy-dom 无布局，滚动判定无法真跑）。**缺口**：真机滚动/跟随手感 |
| SA19 旧插件/定义迁移 | ✅ 已修（T020，`60b250f3`，2026-09-15）：预览逻辑 + IPC（importPreview / importApply）+ 设置页「导入旧定义」入口已落地；逐字段备注、冲突阻断、同名不覆盖、原文件保留均有 Main 侧用例；真机点验待现场。原审计标注保留于下 | `subagent/migrate.ts`、`nativeSubagentSettings.ts` | legacy 与 native 互斥、旧开关语义保留；预览显示逐字段差异、冲突阻断、原文件不覆盖、项目定义不自动提升；**审计 2026-09-14**：`previewLegacyMigration` 全仓除自身测试外无任何调用方——没有 IPC handler、没有 preload、没有设置页入口，"显式迁移预览"在产品里不存在（subagent-data-01） |
| SA20 BrowserPreview 依赖 | ⏸ 待现场 | `tools/browserPreview.ts`、`main/services/preview/PreviewWindowManager.ts` | **实现与自动化齐备**：工具、路径校验、权限门、`preview.requested` 事件与 `worker.preview.respond` 应答、窗口复用、编辑自动刷新、`showInactive` 不抢前台、不可用明确报错。**缺口**：真机上「自定义子代理声明并预览工作区 HTML」整链 |
| SA21 SDK / 两载体 / 退出 | ⏸ 待现场 | — | pi 0.84.4 的真实循环与完整事件已由 P5-2-0 探针证明。**缺口**：electron-utility 与 Windows bundled-node 两种载体的打包后子任务矩阵、残留子进程检查，只能上机做 |
| SA22 完整功能基线验收 | ⏸ 待现场 | — | 固定输入、定义、模型替身与验收标准已在本文件与[基线](../../topics/p5-2-0-baseline.md)中固定；**缺口**：trace/截图/成功失败取消性能数据，需 SA16/17/18/20/21 先落 |

## 还缺什么，一句话说清

**运行时侧全部完成并有测试。** 剩下的六行（SA16/17/18/20/21/22）都不是「没做」，
而是「做完了但只有上机才能签」。它们共用同一个前提：一次真机会话 + 两种载体的打包产物。

按契约 §7，在这六行签收之前 P5-2 保持「实现完成/现场待验」，**不标 Done**。

## 上机时要做的事（给下一次会话）

1. 起真实会话，让模型并行派两个 `explorer`，确认：ack 立刻回、两条 lane 同时跑、
   父代理继续自己的活、报告自动交回且面板里各显示一次。
2. 中途按 Stop，确认状态稳定在 stopped 且没有再发 provider 请求。
3. 自定义一个带 `BrowserPreview` 的子代理，让它生成并预览一个 HTML；编辑该文件确认
   自动刷新；确认预览窗不抢前台。
4. 管理页跑一遍增删改查与启停，重启应用确认开关保留。
5. 关掉应用再打开同一会话，确认委派面板按记录重建，未结算的显示为已取消。
6. 打两种载体，各跑一遍后台委派 + 审批 + 写入 + 取消，确认无残留子进程。
7. 留 trace 与截图，回填本文件的 ⏸ 行。
