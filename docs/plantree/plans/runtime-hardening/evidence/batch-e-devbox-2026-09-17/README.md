# 批次 E 开发机项：第一批实跑（2026-09-17）

Role: evidence。对应 [T032](../../roadmap.md) 要求的「标 dev-box 的项在上机前先做完」。本轮做掉的是[检查单草案](../batch-d-audit-2026-09-15/checklist-e.md)第一节「开发机：不该等上机」里**不需要起 Electron** 的那批，以及同节「已可结案」的一条。需要真机界面的项（session-index 五项、main-host-aux 的 POSIX 半边、capacity 的前两项、渲染层词汇表 13 项）不在本轮，留待下一轮。

环境：Linux 开发机（2 核 / 3.3 GB），HEAD `94543cf3`，Node v22.23.2，cordis `4.0.0-rc.9`，pi-agent-core / pi-ai `0.84.4`。未起 Electron。

## 一、offline smoke lane（检查单二节 #19 / #20，来源 smoke-p0-6）

命令：`node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline --json --trace-dir <dir>`

结果：**退出码 0，六项断言全部 pass**。存档 [report.json](smoke-offline/report.json)（含逐条 `outcomes`，不是裸 trace）与 [runs.jsonl](smoke-offline/runs.jsonl)。

| 断言 | 期望 | 实际 |
|---|---|---|
| `must_succeed` | true | success=true, error=null |
| `must_not_call_tools:*` | 无工具调用 | `[]` |
| `turns` | 1 | 1 |
| `min_output_chars` | ≥ 1 | 5 |
| `exact_output` | `ready` | `ready` |
| `max_latency_ms` | ≤ 30000 | 12 |

判据里点名的两个 stamp 字段都对上了：`config_version` = `runtime_p6_hardening_v1`（T028 从 `runtime_p3_complete_v1` 解冻后的分代号），`version_stamp.backend` = `native`。载体是 `standalone-node`，`node_source` = `current-process`——**这一跑不覆盖 bundled-node 与 electron-utility 两种载体**，那两条仍在上机日的 W1/W2。

## 二、cordis 语义探针（检查单二节 #22，来源 cordis-spike-d1）

命令：`node --experimental-strip-types src/runtime/spikes/p0-cordis-semantics.ts`，输出存档 [cordis-spike-output.txt](cordis-spike-output.txt)。

三个问题的答案与 P0 建立时一致：

| 问题 | 期望语义 | 本次输出 |
|---|---|---|
| Q1 依赖未到时是否推迟激活而非抛错 | 推迟 | `after dependant only — shouter present? false`（`fiber state: 0`） |
| Q2 依赖到达后 fiber 是否稳定并提供服务 | 是 | `shouter present? true`，`shout: HELLO RUNTIME` |
| Q3 dispose 依赖是否连带撤销依赖方 | 是 | `greeter present? false`、`shouter present? false` |

**检查单这一条的判据写错了，T032 合并时必须改**。草案写的是「三行 console.log 布尔值……（`shouter present? true` 两次、`dispose 后 shouter present? false`）」，但脚本实际打印五行，且第一行按 Q1 的定义**必须是 false**——若真出现「true 两次」，恰恰说明推迟激活语义被推翻、`bootstrap.ts` 的兜底分支再也轮不到执行。照草案的判据验会得出相反结论。正确判据见上表。

另一处口径：这条的触发条件是「cordis 版本升级时」。本次 cordis 仍是 `4.0.0-rc.9`，**没有升级**，所以本次是基线复采而不是升级后复验；升级那天仍要再跑一次。

## 三、`plugin_graph_incomplete` 补测试（检查单二节 #21，来源 cordis-spike-d1 / spike-02）

新增 `src/runtime/__tests__/pluginGraphIncomplete.test.ts`（1 条用例）。

背景：`bootstrap.ts:525` 在 await 完每个 fiber 之后，按名字逐个确认必需服务真的落在 context 上，因为 Cordis 对 injects 未满足的 fiber 是「settle 而不抛错」。这条兜底此前**从未执行过**——`plugin_graph_incomplete` 这个错误码在整个仓库里只出现在它自己的 `throw` 那一行。

用例怎么制造缺失：全仓十处 `static inject` 全部指向无条件注册的服务，所以没有任何 options 组合能让某个必需服务缺席（这本身是图自洽的证据）。用例改用 `vi.mock` 把 `ToolsPlugin` 换成一个**保留原服务名、但 inject 一个没人注册的服务**的版本——Cordis 语义变化或 inject 写错时，真实回归就是这个形状。断言错误码为 `plugin_graph_incomplete`、消息里点名 `runtimeTools`，且**不**牵连正常注册的 `runtimePermissions`（后半条是防 `required` 将来整批误列）。

反向验证：把 `bootstrap.ts:526` 的 `if (missing.length)` 改成 `if (false && missing.length)` 后用例判红（createRuntime 竟然成功返回了一个带窟窿的 runtime），复原后转绿。

坑记一笔：`vi.mock` 的工厂会被提升到模块 import 之前，所以 `Service` 必须在工厂内部动态 `import('cordis')`，写在文件顶层会撞 `Cannot access '__vi_import_1__' before initialization`。

## 四、多进程并发轮转同一 runs.jsonl（检查单二节 #35，来源 capacity-leftovers）

**这项已经有自动化覆盖，不需要人工复现**：T045（`e5a2d5b9`）给 trace 轮转加跨进程互斥时，连同用例一起落了 `src/runtime/__tests__/trace.test.ts:350`「loses no run when two processes rotate one directory between them」——两个真实 `fork` 出来的子进程共享同一 traceDir、同时冲击轮转阈值，断言三件事：每条 run 都在（没有代际丢失、没有写入交织到 JSON 解析失败）、代际编号连续（没有双重轮转）、目录里不留 `.lock`。

本轮实跑确认：`trace.test.ts` 15 条全绿，含这一条（818 ms）。T032 合并时把 #35 从上机清单划掉，改标「已由 trace.test.ts:350 覆盖」。

## 五、CI 是否在日常 push / PR 上触发测试（检查单一节「已可结案」#1，来源 baseline-01）

复核确认可结案：`.github/workflows/build.yml` 的 `on:` 只有 `push.tags: ['v*']` 与 `workflow_dispatch`；`.github/workflows/` 下另外两个 workflow 是 `claude.yml` 与 `code-review.yml`，都不是测试作业。**日常提交与 PR 确实不跑任何自动化测试**（批次 D 的 P1-7 判 incomplete 就是这一条）。

剩下的不是验证而是决策：要不要给日常提交加测试 job。这条归 T054（它的验收里已经写了「日常提交与 PR 触发测试」），本检查单只需划掉验证项。

## 本轮的验证汇总

- 新增用例 1 条，反向验证 1 组判红后复原
- 定向测试：`pluginGraphIncomplete` 1/1、`trace` 15/15
- 三套 tsc 全绿（根 / runtime / agent-host），新文件 Biome 干净
- 未跑全量（按约定批次收口才跑），未起 Electron
