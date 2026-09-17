# 批次 E 开发机项实跑（2026-09-17 起）

Role: evidence。对应 [T032](../../roadmap.md) 要求的「标 dev-box 的项在上机前先做完」。本轮分批做掉检查单第 4 节开发机表的项：第一批（不起 Electron 的 5 项）、第二批（DEV-23 CI 取证 + DEV-33 runtime 半边 + 需起 Electron 的 dev-A1 八项）……七个批次已全部完成（2026-09-17）。

环境：Linux 开发机（2 核 / 3.3 GB），HEAD `94543cf3`，Node v22.23.2，cordis `4.0.0-rc.9`，pi-agent-core / pi-ai `0.84.4`。未起 Electron。第二批起 HEAD `b3d751e3`。

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

## 第一批的验证汇总

- 新增用例 1 条，反向验证 1 组判红后复原
- 定向测试：`pluginGraphIncomplete` 1/1、`trace` 15/15
- 三套 tsc 全绿（根 / runtime / agent-host），新文件 Biome 干净
- 未跑全量（按约定批次收口才跑），未起 Electron

## 六、DEV-23 CI 在日常 push / PR 上不触发测试（实际推送验证）

命令：`gh run list --branch feat/runtime-evolution --limit 30 --json databaseId,event,name,status,conclusion,createdAt,headSha`，存档 [dev-23-gh-run-list.txt](dev-23-gh-run-list.txt)。

结果：`feat/runtime-evolution` 分支上全部 13 次 run 的触发事件（`event`）都是 `workflow_dispatch`，没有一次是 `push` 或 `pull_request`；最后一次在 2026-09-10，`headSha` 为 `c0ae2a34`。此后推到远端的提交（截至本轮 HEAD `b3d751e3`）共 179 个，一次 run 都没有触发。全仓最近 50 次 run 按 `event` 分组，`push` 触发的有 11 次，逐条核对 `headBranch` 全部是 `v0.x.y` 形式的 tag，没有一次是分支推送。

结论：与第一批第五节「日常提交与 PR 确实不跑任何自动化测试」的静态结论（读 `.github/workflows/*.yml` 的 `on:` 得出）互证一致，DEV-23 ✅。

## 七、DEV-33 附件顶满会话文件（runtime 构造用例半边）

### DEV-33 附件顶满会话文件后打不开（runtime 包内构造用例半边）

检查单第 4 节开发机表第 33 行，来源区域 `capacity-leftovers`。这一条允许两种取证方式，本轮做的是「在 runtime 包内写构造用例模拟同等字节量」这半边；GUI 半边未做（不起 Electron）。

#### 现有用例不覆盖，必须新写

T046（`0d273b17`）落的 `src/runtime/__tests__/attachmentBudget.test.ts` 6 条全是 `preparePrompt()` 的纯单元测试：只验入口拒绝，不落盘、不重开，整个文件没碰过 `JsonlSessionStore`。离目标最近的既有用例是 `src/runtime/__tests__/session.test.ts:272`「rejects a file over the read limit and keeps the original bytes」，但它把预算改成 `maxBytes: 1_000` 来触发，既不经附件、也只断言 `rejects.toThrow()` 而不看错误码。**DEV-33 这条路径此前无人覆盖。**

新增 `src/runtime/__tests__/sessionAttachmentFill.test.ts`（2 条用例）。字节全程走产品自己的路：`preparePrompt()` 是真实发送的入口闸（`agent-loop/index.ts:209`），落盘的消息形状取自 pi 的 `prompt(text, images)`（一个 text 块 + 若干 image 块，见 `pi-agent-core/dist/agent.js:257`），写入用 `JsonlSessionStore.appendMessage()`——就是 `agent-loop/index.ts:496` 调的那一个。没有一行手写 JSONL。

每条消息按「产品允许的最大一条」构造：一张 base64 长度 6 990 506（原始 5 242 879 字节，贴着 5 MiB 单件上限）的图 + 一张 base64 长度 1 394 006（原始约 1 MiB）的图，合计 8 384 512 落盘字节，正好在 `ATTACHMENT_TURN_STORED_BYTES`（8 MiB）之下留出 4 KiB 给 JSON 外壳。

#### 实跑结果

`npx vitest run src/runtime/__tests__/sessionAttachmentFill.test.ts --no-file-parallelism`，存档 [vitest-sessionAttachmentFill.txt](dev-33-runtime/vitest-sessionAttachmentFill.txt)。

```
stdout | ... > stops at session_size_limit just under the budget, and still reopens
[DEV-33] accepted sends=4 file bytes=33539730 (31.99 MiB of 32 MiB), bytes after 3 sends=25154839, refusal=session_size_limit

 ✓ src/runtime/__tests__/sessionAttachmentFill.test.ts (2 tests) 792ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

`pnpm typecheck:runtime` 退出 0（[tsc-runtime.txt](dev-33-runtime/tsc-runtime.txt)，无输出），新文件 Biome 干净（[biome.txt](dev-33-runtime/biome.txt)）。全程未起 Electron，未跑全量。

#### 判据的两处对不上，都按实测写进了断言

| 检查单期望 | 实测 | 用例里的断言 |
|---|---|---|
| 2~3 条消息把文件顶到 ≥ 32 MiB | **3 条只到 25 154 839 字节（23.99 MiB，74.96%）**；顶满要 4 条，且 4 条到 33 539 730 字节（31.99 MiB）就被第 5 条的拒绝挡住 | `accepted > 3` 且「3 条后的字节数 < 32 MiB」 |
| 重开该会话抛 `io_limit` | **不抛，正常打开。** 写入侧 `store.ts:357` 的总预算检查是 `this.bytes + bytes > this.maxBytes` 才拒，所以本 store 写出来的文件永远 ≤ 32 MiB；读取侧 `host/io.ts:336` 是 `bytes.length > maxBytes` 才抛，两者同一个数——自己写的文件必然落在自己的读窗口内 | 重开成功、条目数对得上 |

`io_limit` 不是死代码，但**只有文件从 store 管不着的路径长过 32 MiB 时才够得着**（预算落地前的旧文件、外部编辑器、手工合并）。用例把这种情形也构造了：绕开 store 直接 `appendFile` 把文件推过 32 MiB，再重开，此时确实拿到 `code: 'io_limit'`。

#### 顺带逮到的缺陷：一次超预算拒绝把会话变成永久只读

第 5 条被拒后，文件里还剩 14 702 字节余量，但**同一个 store 实例此后连一条纯文本消息都写不进去**，一样报 `session_size_limit`。原因是总预算检查写在写队列**内部**（`store.ts:357`），而 `enqueue`（`store.ts:378-390`）把 `this.tail` 直接换成那个已 reject 的 promise，后续每次 `this.tail.then(operation)` 都不会执行 operation、只会带着同一个错误 reject。

这与代码自己写的设计意图相反：

- `store.ts:335-338`（capacity-04）特地把单行检查放到队列外，注释原话是「refusing this one write leaves the session writable」「a rejection there is permanent by design」——但**总预算检查没有对应的队列外预检**。
- `agent-loop/attachments.ts:50-52`（capacity-01）说「发送当场被拒……会话本身照常可写」——实测后半句不成立。
- 容量对账表第八节也写着「预算耗尽不再是『若干条消息之后整个会话变只读』，而是发送当场被拒、消息里点名是哪个附件、会话本身照常可写」。**「会话本身照常可写」这一条是错的**。

好消息是这个中毒只跟着 store 实例走：关掉再重开（换 worker / 重开会话）之后，那 14 702 字节余量还在，一条短文本消息能正常写进去。用例把「中毒」和「重开后恢复」两半都断言了。

建议归 T058 一并处理（最小修法是把总预算检查照 capacity-04 的做法加一道队列外预检），或单开一条。

#### 第二条用例：两个 8 MiB 上限量的不是同一个东西

`ATTACHMENT_TURN_STORED_BYTES`（capacity-01）与 `SESSION_MAX_ENTRY_BYTES`（capacity-04）都等于预算的四分之一 = 8 MiB，但前者只称 base64 字符串本身，后者称整行 JSON。于是一条**正好**顶到附件上限的发送会被 `preparePrompt()` 放行、被 `appendMessage()` 以 `session_entry_size_limit` 拒掉——错误信息里不点名是哪个附件，正是 capacity-01 注释说要避免的那种形态。用例把这个接缝钉住了。

#### 反向验证（两组，都是改一行 → 判红 → 复原 → 转绿）

| # | 改的那一行 | 判红形态 | 存档 |
|---|---|---|---|
| A | `src/runtime/plugins/session/store.ts:357` 的 `if (this.bytes + bytes > this.maxBytes)` 改成 `if (false && ...)` | `expected 'undefined' to be 'session_size_limit'`；同时探针行显示 8 条发送把文件写到 **67 079 294 字节（63.97 MiB）**，反证「文件顶不过 32 MiB」完全靠这一行 | [reverse-a-session-budget-off.txt](dev-33-runtime/reverse-a-session-budget-off.txt) |
| B | `src/runtime/host/io.ts:336` 的 `if (truncated && options.overflow === 'error')` 改成 `if (false && ...)` | `expected 'opened' to be 'io_limit'` | [reverse-b-io-limit-off.txt](dev-33-runtime/reverse-b-io-limit-off.txt) |

两行均已复原，`git status` 只剩新增的用例文件（未提交）。

#### 第 5 问的算术：2~3 条消息能否达到 32 MiB —— 不能

常量（只读代码得出，未改）：

| 层 | 常量 | 值 |
|---|---|---|
| 渲染层 `attachmentLimits.ts:41-44` | `maxCount` / `maxImageBytes` / `maxTotalBytes` | 5 个 / 5 MiB 原始 / 10 MiB 原始 |
| runtime `attachments.ts:37,54` | `ATTACHMENT_MAX_BYTES` / `ATTACHMENT_TURN_STORED_BYTES` | 5 MiB 原始 / 8 MiB 落盘 |
| runtime `store.ts:121`、`codec.ts:20` | `SESSION_MAX_ENTRY_BYTES` / `SESSION_MAX_BYTES` | 8 MiB 单行 / 32 MiB 会话 |

base64 膨胀 4/3，所以一张 5 MiB 的照片落盘是 6 990 507 字节（6.67 MiB）。逐条推：

1. **「每条多张接近 5 MiB 的图」做不到。** 8 MiB 落盘上限扣掉一张 5 MiB 照片的 6.67 MiB，只剩 1.33 MiB base64 ≈ 1 MiB 原始。一条消息里最多**一张** 5 MiB 的图。名义 5 张的上限实际被落盘预算压成「1 张 5 MiB + 1 张 1 MiB」或「5 张各 ≤ 1.6 MiB 原始」。
2. **渲染层与 runtime 本身就打架（Q014 的另一半）。** 渲染层放行一条 10 MiB 原始 = 13.33 MiB 落盘，runtime 8 MiB 就拒。用户在 Composer 里能凑出一条界面不拦、发出去必失败的消息。
3. **条数：32 / 8 = 4。** 2 条最多 16 770 026 字节（15.99 MiB，约 50%），3 条 25 154 839 字节（23.99 MiB，74.96%），4 条 33 539 730 字节（31.99 MiB，99.96%）。**「2~3 条」在数学上不可能达到 32 MiB，最少 4 条。**
4. **即便 4 条也永远不「超过」32 MiB。** 拒绝条件是 `>`，所以文件最多停在 33 554 432 字节；而重开的 `io_limit` 也要求 `>`。两个 `>` 一头一尾，**GUI 半边判据里的「超过 32 MiB」与「重开抛 io_limit」经产品路径严格不可达**。

结论：**这一条的 GUI 半边判据不可达，必须改写**。检查单原文写于 T046 之前（那时单条附件无上限，2~3 条确实能打满），T046 之后数字已经变了。建议上机日把 GUI 半边改成：发 4 条「1 张 5 MiB 图 + 1 张 1 MiB 图」的消息，判据为「第 5 条发送被拒并显示会话超预算类错误、文件停在 31.9 MiB 左右、重开正常」，外加本轮新发现的「被拒后同一会话连纯文本也发不出，重开应用后恢复」这条观感项。

检查单第 33 行判据已按此改写并记入 5.1。两条疑似缺陷（超预算拒绝后 store 中毒、两个 8 MiB 口径不一）已进本轮缺陷清单，待点验全部完成后统一总结与排修。

## 八、需起 Electron 的第一组：session-index 五项 + 临时工作区四项（dev-A1）

证据目录 [dev-A1](dev-A1/)。分支 `feat/runtime-evolution`，dev 模式（userData = `~/.config/jyw-ai-client-dev`）。

本批做的是检查单[第四节「开发机」表](../../checklist-e.md)的
第 5 / 28 / 6 / 26 / 7 / 8 / 9 / 27 行，对应 T037（`99db822c`）、T038（`e007bf71`）、
T040（`d4a361b5`）声称已修的 main-aux-01/02/03/07、session-index-01/02/04/05/09/11。

### 本批的三条方法学注记

**一、模型不是任务书指定的那个。** 任务书要求用 `vllmproxy` + `claude-sonnet-5`。这台机器上这条路
今天走不通，两件互相独立的事：网关自己在 502（起应用前 curl 探活四次，两次 `error code: 502`、
两次 60 秒超时），以及 worker 的模型目录里根本没有 vllmproxy——发出去直接报
`no model "vllmproxy/claude-sonnet-5" in the catalog (4 available)`，而同一个窗口的
`chat.listPiModels()` 明明列得出它。细节与取证见 [dev-model-substitution-note.txt](dev-A1/dev-model-substitution-note.txt)，
第二条是**独立于网关的疑似缺陷**，记在本页末尾。本批实际用 `maxapi/grok-4.6`：真 provider、真 key、
真回合，每条会话的索引行里都能查到 `"model": "maxapi/grok-4.6"`。

**二、每一句话都走界面。** 新建临时对话走侧栏「临时对话」分组的右键菜单项「新建临时对话」；
发送一律是 `textarea` 填字 + 点 `[aria-label="发送消息"]`，没有任何一处直接调 `store.sendMessage`；
退出走标题栏的 Close 按钮加应用自己的「确认退出」框。只有读状态用 CDP 直读 store 和直读磁盘文件。

**三、强杀只用真实 pid。** 遍历 `/proc/*/cmdline` 找 electron 二进制且参数里没有 `--type=` 的那个进程，
`kill -9 <pid>`。全程没有用过 `kill -1`、`process.kill(-1)`，也没有用过 `pkill -f`。

---

### 六、DEV-5 fork 一个未绑定（scratch）会话

**判据**：对话框是否弹出「Fork was created, but its workspace could not be materialized in this window」；
此时 session-index.json 里是否已有该 fork 行且不含 unbound。

**做了什么**：侧栏「临时对话」分组右键 →「新建临时对话」建出 `session-1789637446946-abtu2jn`
（`workspaceId` 为空串，确认是未绑定），发一句 `devA1UNB 回一个字：甲`，模型真回了「甲」。
Main 在第一次发送时分配了 scratch 目录 `~/JYWAI/temporary/unbound-sessions/2a8e9b2f-…`。
回合落到 idle 后点时间线右上角的 `Branches`，在会话树里点唯一可点的那个「从这里分叉」。

**看到了什么**（[dev-05-index-after-fork.json](dev-A1/dev-05-index-after-fork.json)、
[dev-05-branches-dialog.png](dev-A1/dev-05-branches-dialog.png)、[dev-05-after-fork.png](dev-A1/dev-05-after-fork.png)）：

- 会话树 5 个节点，5 个「从这里分叉」按钮里只有最后那个 assistant 节点可点，其余四个
  `disabled` 且 title 是「要等助手给出第一条回复后才能分叉」。
- 点完之后**没有任何那句文案**——中英两版都在整页 `innerText` 里搜过，都是 false；
  分支对话框自己关掉了（`SessionTreeDialog.tsx:139` 的成功分支才会 `onOpenChange(false)`），
  侧栏当场多出一行「devA1UNB 回一个字：甲 (fork)」并切成当前会话。
- 索引里新增一行 `session-fork-fba2b0ab-…`：`unbound: true`、`workspacePath` 指向父会话那个
  scratch 目录、`runtimeIdentity` 是新的 `ea74ddc0-….jsonl`、`piLeaf` 与父会话一致。

**结论**：✅ 符合 T040（`d4a361b5`）第一条所写的修复后形态——「fork 不再当场报未能材料化」。
但判据后半句要的是「不含 unbound」，而实测**含** `unbound: true`，这一条见下面的「判据问题」。

### 七、DEV-28 临时会话索引 title 为空的复现与定性

**判据**：发完第一句后索引行 title 非空且与侧栏显示一致。

**做了什么**：与上一项同一轮——点完发送按钮后就开始轮询磁盘上的 `session-index.json`，
同时读 store 里那一行的 `title`，不看界面渲染。

**看到了什么**（[dev-28-index-after-first-message.json](dev-A1/dev-28-index-after-first-message.json)）：
索引行 `title` = `devA1UNB 回一个字：甲`，store 里侧栏那一行的 `title` 逐字相同，`equal: true`。
第二条未绑定会话（`devA1SCRATCH 回一个字：乙`）复现同样结果。

一个时序细节值得写下来：title 不是随索引行一起落盘的。`recordCreated` 写下的 `title` 是空串，
真正的标题由渲染层在这一轮被 Host 受理（`isAdmittedOutcome`）之后经 `chat:renameSession` 补写
（`ChatComposer.tsx:814`→`chatSessionActions.ts:285`）。**所以读得太早会看见空串**——本批第一次读
`devA1SCRATCH` 就读到了 `""`，几秒后再读就有了。原现场报的「title 为空」有可能是同一个时序，
但本轮没有复现出「一直为空」的形态。

**结论**：✅ 判据成立（测到的）。「原现场那次为什么为空」属于推断，本轮没有取到证据。

### 八、DEV-6 上一条之后重启应用

**判据**：该 fork 是否从侧栏彻底消失，而索引行与 JSONL 仍在磁盘上。

**做了什么**：按第九节的方式从界面正常退出，确认 Electron 主进程真的没了，再重新起一次，
从 store 读 fork 那一行，并直接 `fs.existsSync` 两个 JSONL。

**看到了什么**（[dev-06-fork-after-restart.json](dev-A1/dev-06-fork-after-restart.json)、
[dev-06-sidebar-after-restart.png](dev-A1/dev-06-sidebar-after-restart.png)）：

- fork 那一行**没有消失**：store 的 `sessions` 里找得到，标题在渲染后的侧栏文本里也搜得到。
- 索引行在，两个 JSONL（父 `session-1789637446946-abtu2jn.jsonl` 2182 字节、
  fork `ea74ddc0-….jsonl` 2239 字节）都在。

**结论**：✅ 与 T040 所写「重启后不再被当孤儿丢掉」一致，判据问的「彻底消失」没有发生。

**一个没有定论的附带观察**：同一次运行里做完 DEV-9 / DEV-27 之后再读 store，四条 `devA1*` 会话
全都不在 `sessions` 里了（`total` 从 99 掉到 98 只解释得了一条）；而**下一次启动它们又全部回来**
（[dev-08-reclaim-on-next-boot.json](dev-A1/dev-08-reclaim-on-next-boot.json) 的 `sidebarAfterBoot`
列出了全部 4 行）。所以这不是落盘丢失，是运行过程中某一次侧栏刷新把它们摘掉了。没有进一步定位——
不在本项判据内，留作线索。

### 九、DEV-26 F2-b 正常退出时的 scratch 清理

**判据**：从界面正常退出（非 kill）后，本次的 scratch 目录即被删；与 kill 那次的差异有记录。

**做了什么**：沿用 `scripts/run-f2b-probe.mjs` 的两侧读法（索引文件直接读磁盘、目录直接 `readdir`，
不问界面），在三个时点各取一份：T0 应用运行中、T1 正常退出后未重启、T2 重启后。
退出走标题栏 `[aria-label="Close"]` → 应用自弹「确认退出 / 确定要退出应用吗？」→ 点「退出」，
全程没有向任何进程发信号。

**看到了什么**（[dev-26-scratch-timepoints.json](dev-A1/dev-26-scratch-timepoints.json)、
[dev-26-ps-before-normal-exit.txt](dev-A1/dev-26-ps-before-normal-exit.txt) /
[after](dev-A1/dev-26-ps-after-normal-exit.txt)）：

| 时点 | `unbound-sessions/` | 父会话索引行 | fork 索引行 |
|---|---|---|---|
| T0 应用运行中 | `["2a8e9b2f-…"]` | 在 | 在 |
| T1 正常退出后 | **整根 ENOENT** | 在 | 在 |
| T2 重启后 | 仍 ENOENT，temp base 为空 | 在 | 在 |

即正常退出不是删掉本次那一个子目录，而是把 `unbound-sessions/` 整根端掉
（`workerManager.ts:11` 的退出 `wipeAll()`）。退出后 `dev.js` / `electron-vite` / electron / esbuild
全部消失，9333 与 5173 两个端口都释放。

**与 kill 那次的差异**（DEV-8 的那次 `kill -9`）：强杀之后两个 scratch 目录
（`46e6faab-…`、`4e6b46a9-…`）**都还在**，一直留到**下一次正常启动**才被开机清扫
（`sweepScratchWorkspacesOnStartup`）连根抹掉——见
[dev-08-fork-kill.json](dev-A1/dev-08-fork-kill.json) 的 `scratchAfterKill` 与
[dev-08-reclaim-on-next-boot.json](dev-A1/dev-08-reclaim-on-next-boot.json) 的 `afterBoot`。

**结论**：✅ 判据两条都成立。

**过程中踩到的一个真实行为，值得单记**：第一次做这项时，我点完标题栏 Close 之后隔了约 2 分钟
才去点「退出」，结果**窗口没关、应用没退**。原因在 `MainWindow.ts:501`：`close` 事件先
`preventDefault()`，再 `confirmCloseWithReason('quit-app')` 等渲染层回话，而这个等待是有超时的
（同文件 `:489-493` 的注释写的是 30 秒）。超时之后渲染层再回「确认」已经没人接了。
把两下点击压进 1.5 秒内就一次退成功。**这不是缺陷，是给后面做同类项的人的操作提醒**：
Close 与确认必须连着点。

### 十、DEV-7 索引损坏后的第一次写

**判据**：旧行是否被覆盖丢失；坏文件是否还留在磁盘上。

**做了什么**：退出应用 → 把 `session-index.json`（114 行 / 49686 字节）备份两份（一份进证据目录，
一份留作恢复）→ 用 `fs` 把文件截成前 120 字节，正好停在第一个对象的 `"model` 上，
既没有闭合的对象也没有闭合的数组 → 重开应用 → 新建聊天发一句 `devA1CORRUPT 回一个字：戊` → 再读文件。

**看到了什么**（[dev-07-corrupt-index.json](dev-A1/dev-07-corrupt-index.json)、
[dev-07-userdata-ls.txt](dev-A1/dev-07-userdata-ls.txt)、
[dev-07-sidebar-after-corrupt-boot.png](dev-A1/dev-07-sidebar-after-corrupt-boot.png)）：

1. **重开之后、还没写任何东西时**：`session-index.json` 本体是 `ENOENT`——它被 `rename` 走了；
   同目录出现 `session-index.json.corrupt-2026-09-17T09-54-56-756Z`，120 字节，内容就是我截断后的那半行
   （[原件已存档](dev-A1/dev-07-session-index.json.corrupt-2026-09-17T09-54-56-756Z)）。
   侧栏里一条历史会话都没有，只有应用自己新建的一条空聊天。
2. **新建聊天发完一句之后**：索引重建成 1 行，只有这条新会话；
   `.corrupt-…` 文件**仍在磁盘上**，没有被后来的写覆盖或删除。

**结论**：✅ 应用侧的动作与 T038（`e007bf71`）第一条完全一致：坏内容先原样另存为
`session-index.json.corrupt-<时间戳>`，再用**可解析的行**重建——这次可解析行数为 0，所以重建出来是空的。

这里要把话说准，避免读成「应用弄丢了 113 行」：**那 113 行是被我的截断毁掉的**，写进磁盘的只剩
120 字节，应用能保住的也只有这 120 字节。判据问的「旧行是否被覆盖丢失」，落在「活的索引」上答案
是「是」，落在「应用有没有在还能读到旧行的情况下把它们盖掉」上，本轮没有制造出那个条件
（要制造它，得把文件改成「前 N 行合法、末尾坏一行」的形态，那是另一个用例）。

**⚠️ 附带发现（疑似缺陷，只记录）**：`SessionIndexService.ts:631-633` 在修复成功后会
`console.warn('[chat] Session index was damaged (…); the original is kept at … ')`。
这条 warn 在 `logs/main.log`、`logs/aiclient-2026-09-17.log`、以及本次启动的 `dev.log` 里**一条都找不到**
（[dev-mainlog-notes.txt](dev-A1/dev-mainlog-notes.txt)，三处 grep 计数均为 0，而同一秒内 `dev.log` 里
有 4 条 `[error]` 级别的行，说明日志通道本身是活的）。仓库自己的注释给出了解释：
`WorkerManager.ts:2381` 写「console.error, not this.log: electron-log keeps error level even when …」，
`MainWindow.ts:255` 写「console.error, not warn/log: electron-log silences lower levels」。
T038 提交说明里「先把原文件保留为 …corrupt-<时间戳> 再用可解析的行重建**并记 main.log**」的后半句，
按本轮观察没有兑现。**这是观察到的现象加仓库内注释的佐证，没有去读 electron-log 的接线代码验证，
所以归为疑似。**

**备份恢复**：已把 `session-index.json` 从备份逐字节还原（114 行 / 49686 字节，
`JSON.stringify` 比对完全相同）。两点要交代：① `.corrupt-…` 那个 120 字节的文件**留在了 userData 里**，
它是产品自己生成的证据，没有删；② DEV-7 期间新建的那条 `devA1CORRUPT` 聊天不在还原后的索引里，
它的 JSONL 留在会话目录里无人认领。

### 十一、DEV-8 fork 窗口内强杀留下的残留文件

**判据**：会话目录里是否多出无主 `<uuid>.jsonl`，pi CLI 是否把它列成一个会话。

**做了什么**：新建一条未绑定会话 `session-1789638427039-ntyubr1`（`devA1KILL 回一个字：丁`）并跑完一轮真回合，
打开 `Branches`，把「从这里分叉」的点击用 CDP 发出去**但不等回包**，**316 毫秒**后对真实 pid `72067`
执行 `kill -9`（pid 来自 `/proc/*/cmdline` 里 electron 二进制且无 `--type=` 参数的那个进程）。
杀完之后直接 `ls` 会话目录、比对索引，再用 pi CLI 列会话。

**看到了什么**（[dev-08-fork-kill.json](dev-A1/dev-08-fork-kill.json)、
[dev-08-ls-sessions-dir.txt](dev-A1/dev-08-ls-sessions-dir.txt)、
[dev-08-ps-before-kill.txt](dev-A1/dev-08-ps-before-kill.txt) / [after](dev-A1/dev-08-ps-after-kill.txt)）：

- 会话目录多出**两个**文件：`c9d54547-55dd-4b5c-a9f7-1e44458d0e48.jsonl`（2193 字节，
  header 行里 `parentSessionId: 41c21a8c-…`、`cwd` 指向父会话的 scratch 目录）
  和同名的 `.jsonl.staged` sidecar（230 字节，`{"kind":"staged-fork","sessionFile":…,"parentSessionId":…}`）。
  后者正是 T040 第三条新加的暂存标记。
- 索引**一行都没新增** → 这个 `.jsonl` 确实无主。
- **pi CLI 把它列成了一个会话**：`cli.js --session-dir <sessions> --resume`（pi 没有非交互列表 flag，
  `--resume` 的交互选择器是唯一入口），Tab 切到 All、输入 `devA1KILL` 过滤之后，列出的是
  **两条**标题与 cwd 完全相同的「devA1KILL 回一个字：丁」——一条是活会话，另一条就是这个无主转录。
  完整输出见 [dev-08-pi-cli-resume-list.txt](dev-A1/dev-08-pi-cli-resume-list.txt)。
- 强杀之后没有任何残留进程，`ps` 过滤 `dev.js|electron-vite|dist/electron|esbuild` 全空。

**补充观察（超出判据，但决定这堆残留的命运）**：下一次正常启动时，T040 的开机回收扫描把
`.jsonl` 与 `.staged` **两个都删掉了**，同一次启动的 scratch 开机清扫也把强杀留下的两个 scratch 目录
连根抹了（[dev-08-reclaim-on-next-boot.json](dev-A1/dev-08-reclaim-on-next-boot.json)）。
所以残留是**存在的，但只存活到下一次启动为止**。

**结论**：✅ 两条判据都复现了（多出无主 `<uuid>.jsonl`、pi CLI 确实把它列成会话），
而且这正是 T040 设计的中间态——sidecar 标记 + 下次启动回收，本轮把回收那一步也测到了。

### 十二、DEV-9 临时工作区删除后的会话去向

**判据**：用侧栏删除一个临时工作区目录后，其下的聊天是否从侧栏静默消失，而索引行仍在。

**做了什么**：先在设置 store 里打开 `temporaryWorkspaceEnabled`，在已注册仓库上新建一条空聊天
（空态才渲染目标文件夹选择器），点开 composer 的文件夹下拉 → 底部「新建文件夹 / 新建临时工作区」，
建出 `~/JYWAI/temporary/20260917-054356`；再发一句 `devA1TEMPWS 回一个字：丙` 把会话绑上去。
然后**真机点按**侧栏该行的第三个按钮（`aria-label="删除"`）→ 确认框「删除临时会话？/
此操作将删除该临时会话目录及其内容。」→ 点「删除」。这条链就是
`App.tsx:634 handleRemoveTempWorkspace` → `electronAPI.tempWorkspace.remove(path, basePath)` =
`temp:workspace:remove`，没有用 `window.electronAPI` 直打。

**看到了什么**（[dev-09-27-temp-workspace-remove.json](dev-A1/dev-09-27-temp-workspace-remove.json)、
[dev-09-sidebar-before-remove.png](dev-A1/dev-09-sidebar-before-remove.png) /
[after](dev-A1/dev-09-sidebar-after-remove.png)、[dev-27-delete-confirmation.png](dev-A1/dev-27-delete-confirmation.png)）：

- 那一行的三个按钮实测是 `Archive session` / `Close session` / `删除`，与 F2-b 当初记的三入口对得上。
- 删除之后：store 的 `sessions` 从 99 掉到 98，按 id 找那条会话返回 `null`，渲染后的侧栏文本里
  搜不到 `devA1TEMPWS`；界面上没有任何错误提示，只有一条「临时会话已删除」的成功 toast。
- 索引行**原封不动还在**，`workspacePath` 仍然指向那个已经被删掉的目录
  （[dev-09-index-after-remove.json](dev-A1/dev-09-index-after-remove.json) 可逐行核）。

**结论**：✅ 判据描述的两件事都复现了——聊天从侧栏静默消失、索引行仍在。
判据是用问句写的，没说哪种是「对」；这里只报实测形态：用户删的是工作区，但那条聊天连同它的
真实转录（JSONL 仍在会话目录里）一起从界面上消失了，而且没有任何提示说明这件事发生了。

### 十三、DEV-27 F2-b 临时行第三个「删除」按钮

**判据**：`temp:workspace:remove` 只删临时基目录的直接子目录，删不到 `unbound-sessions/` 下的 scratch 目录。

**做了什么**：与 DEV-9 是同一次点击。为了让判据可证伪，点删除之前先另外建了一条未绑定会话
（`devA1SCRATCH 回一个字：乙`）并发过一轮，让 `~/JYWAI/temporary/unbound-sessions/4e6b46a9-…`
在删除发生时真实存在。删除前后两侧各读一次目录。

**看到了什么**（同上 JSON 的 `before` / `after`，以及 [dev-09-27-ls-after-remove.txt](dev-A1/dev-09-27-ls-after-remove.txt)）：

| | 删除前 | 删除后 |
|---|---|---|
| temp base 的直接子目录 | `["20260917-054356", "unbound-sessions"]` | `["unbound-sessions"]` |
| 那个临时工作区目录本身 | 存在 | **不存在** |
| `unbound-sessions/` 下的 scratch 目录 | `["4e6b46a9-…"]` | `["4e6b46a9-…"]`，**仍存在** |

**结论**：✅ 与 T037（`99db822c`）第四条和 `ScratchWorkspaceService.ts:56-64` 注释里写的分层意图一致：
删临时工作区只动 base 的直接子目录，碰不到 scratch。

---

### 判据问题（请改检查单）

**开发机表第 5 行（DEV-5）后半句的判据与代码事实矛盾。**

判据原文是「此时 session-index.json 里是否已有该 fork 行**且不含 unbound**」。这是**修复前**的形态。
T040（`d4a361b5`）提交说明第一条明写：

> fork 未绑定会话时索引行**补写 unbound**（绑定会话不写），渲染层 `materializeIndexedPiChatSession`
> 接受「有 unbound 标记、没有工作区」的行……fork 不再当场报「未能材料化」，重启后不再被当孤儿丢掉

也就是说，「含 `unbound: true`」才是修复后应该看到的，而且它正是让 DEV-6 那条「重启后不消失」
能成立的前提。本轮实测到的就是 `unbound: true`。照现在的判据字面去验，会把**修复成功**判成失败。

建议改成：fork 行存在，且**带 `unbound: true`**（因为源会话是 scratch），`workspacePath` 指向源会话的
scratch 目录；对话框不出现「Fork was created, but its workspace could not be materialized in this window」。

前半句（对话框文案）没有问题，照原样保留即可——它是这项真正的现场判据。

检查单第 5 行已于 2026-09-17 改正并记入 5.1。

### 本批的疑似缺陷清单

| # | 现象 | 判定 | 证据 |
|---|---|---|---|
| A | `vllmproxy/claude-sonnet-5` 在模型选择器里列得出来，发送时 worker 报 `no model … in the catalog (4 available)`；`models.json` 与 `auth.json` 里该 provider 与 key 都齐 | ⚠️ 疑似缺陷，与本批 8 项判据无关，不在本轮范围内，未修 | [dev-model-substitution-note.txt](dev-A1/dev-model-substitution-note.txt) |
| B | 索引修复成功后的 `console.warn('[chat] Session index was damaged …')` 在 main.log / 按天日志 / dev.log 里都找不到；仓库自身注释说 electron-log 会吞掉低于 error 的级别 | ⚠️ 疑似缺陷（观察 + 仓库注释佐证，未读 electron-log 接线代码验证） | [dev-mainlog-notes.txt](dev-A1/dev-mainlog-notes.txt) |
| C | 删掉临时工作区后，其下的聊天从侧栏消失且无任何提示，而索引行与 JSONL 都还在 | 这是 DEV-9 判据本身描述的形态，**按判据算复现成功**；是否算缺陷由检查单的下游决策定 | [dev-09-27-temp-workspace-remove.json](dev-A1/dev-09-27-temp-workspace-remove.json) |
| D | 未绑定会话在同一次运行里从侧栏消失、下次启动又全部回来 | 线索，未定位，不在本批判据内 | [dev-08-reclaim-on-next-boot.json](dev-A1/dev-08-reclaim-on-next-boot.json) |

以上四条已进本轮缺陷清单（对应 D3～D6，见下节「本轮累计汇总」）。

### 本批的环境交代

- 起过 5 次 Electron，每次结束都确认 `dev.js` / `electron-vite` / electron / esbuild 无残留、
  9333 与 5173 端口释放；收工时 `free -m` 的 available 是 1916 MB。
- `session-index.json` 已从 DEV-7 前的备份逐字节还原（114 行 / 49686 字节）。
- 留在机器上的新增物：userData 下一个 120 字节的 `session-index.json.corrupt-2026-09-17T09-54-56-756Z`
  （产品自己生成，作为 DEV-7 的现场证据保留），以及本批几条探针会话的 JSONL。
- **本批改动过的三处应用状态，后面的批次要知道**（都是设置 / 缓存，不是产品代码）：
  ① `~/.pilab/jyw-ai-client-dev/settings.json` 里 `temporaryWorkspaceEnabled` 被打开成 `true`
  （DEV-9 / DEV-27 需要它才有「新建文件夹」入口和临时行的第三个按钮；DEV-29 的 TEMP 矩阵同样需要，
  所以没有关回去）；② 同文件 `chatAgentDefaults` 被设成 `{"model":"maxapi/grok-4.6"}`（原先没有这个键）；
  ③ 渲染层 localStorage 的 `aiclient:chat:session-models` 被整个清掉了一次，所有会话的逐会话模型钉选丢失，
  之后一律回落到上面那个全局默认。
- 未跑任何 vitest、未跑 `pnpm build`、未改任何产品代码。

## 九、需起 Electron 的第二组：import-upstream 四项（dev-C）

证据目录 [dev-C](dev-C/)。分支 `feat/runtime-evolution`，dev 模式（userData = `~/.config/jyw-ai-client-dev`）。

本批做的是检查单[第四节「开发机」表](../../checklist-e.md)的第 10 / 11 / 12 / 13 行，
对应 `import-upstream` 区域的 import-up-01 / 04 / 03 与 H/21 C5 的现场半边。
第 11 行的阈值是 2026-09-17 当天更正过的（见检查单 5.1），本批按更正后的文字做。

### 本批的四条方法学注记

**一、面板里看到的是样本，不是本机真实历史。** 起应用前 `export CLAUDE_CONFIG_DIR=/tmp/t032/samples/claude-home`
与 `CODEX_HOME=/tmp/t032/samples/codex-home`，两个变量都从 Electron 主进程的 `/proc/<pid>/environ` 里
自证进去了（[dev-C-main-env.txt](dev-C/dev-C-main-env.txt)）。面板第一次打开时列出的正是样本的规模——
Claude Code 3 个对话、Codex 320 个对话（[dev-13-01-panel-projects-320.png](dev-C/dev-13-01-panel-projects-320.png)），
与样本目录的实际份数逐一对得上，所以后面每一条读数都确实来自样本。

**二、本批一句模型消息都没发。** 四项都不需要真实回合，`maxapi` / `cx2` 一次都没碰。

**三、耗时分两种口径，别混着读。** 「面板打开到列表渲染」是在页面里用 `performance.now()` 打点的
（点击设置齿轮为 t0，Codex 项目行出现为终点），不含 CDP 往返；只有「导入期间还能不能操作」那组
才拿 CDP 往返当指标，因为那一项问的就是外部能不能及时驱动界面。

**四、三次「冷」读数之间清了渲染层缓存。** 面板的项目列表走 react-query，`staleTime` 60 秒
（`useLegacyImport.ts:16`），不清就会读到缓存而不是真扫描。做法是关掉设置弹窗后 `location.reload()`，
重新进主界面再打开一次。Main 侧本来就没有缓存（`LegacyImportSources.ts:52-53` 每次全量重扫），
所以 Main 那一半天然是冷的。

---

### DEV-10 子目录不可读时 Codex 源的表现（import-up-01）

**判据**：在 `~/.codex/sessions/<某一天>/` 上置 mode 000 后，导入面板里 Codex 项目仍能列出其它日期的会话。

**做了什么**：`chmod 000 /tmp/t032/samples/codex-home/sessions/2026/09/12`（挡住 40 份，其余 5 个日期的
280 份照常可读，[dev-10-chmod-state.txt](dev-C/dev-10-chmod-state.txt)）→ 关掉设置弹窗、重载渲染层清缓存 →
重新打开导入面板 → 截图与读 DOM → `chmod 775` 恢复 → 再重载、再打开一次作对照。

**看到了什么**：

- 面板里**只剩一个项目**：`ai-client / Claude Code / 3 个对话`。**Codex 整条不见了**，不是「少了 09/12 那 40 份」
  （[dev-10-02-panel-with-eacces-scrolled.png](dev-C/dev-10-02-panel-with-eacces-scrolled.png)、
  [dev-10-pane-with-eacces.txt](dev-C/dev-10-pane-with-eacces.txt)）。
- **界面上没有任何提示。** 没有报错条、没有警告、没有「部分目录读不到」之类的字样；面板看起来就像这台机器上
  从来没装过 Codex。
- **日志里也一个字都没有。** `EACCES` 在 `dev-C.log`、`logs/main.log`、`logs/aiclient-2026-09-17.log`
  三处的 grep 计数都是 0（[dev-10-mainlog-grep.txt](dev-C/dev-10-mainlog-grep.txt)）。异常被
  `scanAllLegacySources` 的 `catch {}` 吞掉了，没有留下任何痕迹。
- 权限恢复成 775 之后重开面板，Codex 项目连同 320 个对话原样回来
  （[dev-10-03-panel-after-restore.png](dev-C/dev-10-03-panel-after-restore.png)、
  [dev-10-pane-after-restore.txt](dev-C/dev-10-pane-after-restore.txt)），证明消失确实只由那一个目录的权限引起。

**结论**：⛔ 判据不成立。这正是批次 D 记的 import-up-01（T052 批次 F 待修），样本 README 第 0 节的离线预演
预测的就是这个形态，真机一字不差地复现了。真机比离线多测到一件事：**这次失败对用户和对日志都是完全无声的**，
所以用户既不会知道有会话没被列出，事后也无从查起。

---

### DEV-11 超限会话的导入错误形态（import-up-04）

**判据**：用户看到的失败文案可理解；失败后 `sessions/.aiclient-import-staging/` 下无残留、manifest 无 `cleanupPending` 记录。

**做了什么**：两份 Claude JSONL 各走一次 GUI 导入——勾选行、点「导入所选（1）」、等面板自己出报告，
没有绕开界面直调 IPC。一份是 36,748,026 字节（35.05 MiB）/ 6001 行的会话（撞 4000 条目上限），
一份是 `make-samples.mjs --huge` 生成的 67,197,226 字节（64.08 MiB）会话（撞体积守卫）。
另外把同目录那份 48,485 字节的对照会话也导了一次，用来确认「失败的是守卫，不是这条路本身坏了」。
每次失败后立刻查暂存目录与 manifest。

**看到了什么**：

| 样本 | 界面上的报错原文 | 耗时 | Main 进程 RSS |
|---|---|---|---|
| 35.05 MiB / 6001 行 | `Claude session exceeds the 4000-entry import limit` | 933 ms | 227 MB → 峰值 312 MB → 回落 227 MB |
| 64.08 MiB | `Claude session exceeds the 67108864-byte import limit` | 19 ms | 无明显变化（238 MB 上下） |
| 48 KiB 对照 | 无报错，「新导入 1 个，已存在 0 个，失败 0 个。」 | 约 2 s | 无明显变化 |

界面形态是两段：**出错那一行下面一行红色小字，内容是英文原文**；**面板底部一句中文汇总**
「新导入 0 个，已存在 0 个，失败 1 个。 导入的对话会出现在侧栏，打开就能接着聊。」
截图 [dev-11-01-error-35mib.png](dev-C/dev-11-01-error-35mib.png) /
[dev-11-02-error-64mib.png](dev-C/dev-11-02-error-64mib.png)，DOM 文本
[dev-11-pane-after-35mib.txt](dev-C/dev-11-pane-after-35mib.txt) /
[dev-11-pane-after-64mib.txt](dev-C/dev-11-pane-after-64mib.txt)。

**残留检查（判据后半句）**：

- 两次失败发生时，`.aiclient-import-staging/` **根本不存在**
  （[dev-11-staging-after-35mib.txt](dev-C/dev-11-staging-after-35mib.txt) /
  [after-64mib](dev-C/dev-11-staging-after-64mib.txt) 都是 `No such file or directory`）。
  这与代码对得上：两道守卫都在 Main 的 `importer.convert()` 里（`ClaudeSourceAdapter.ts:186-189`、`:270-274`），
  失败时还没轮到 fork 导入 worker，而暂存目录是 worker 在 `create()` 里才 `mkdir` 的（`nativeImport.ts:274`）。
- manifest 在两次失败前后都是 **11 条记录、全部 `complete`、`cleanupPending` 为 true 的 0 条**，
  而且**这两份样本一条记录都没留下**（[dev-11-manifest-before.json](dev-C/dev-11-manifest-before.json) /
  [after-35mib](dev-C/dev-11-manifest-after-35mib.json) / [after-64mib](dev-C/dev-11-manifest-after-64mib.json)）。
  同样对得上代码：`convert()` 抛错的分支在 `manifest.reserve()` 之前就 return 了。
- 为了让「没有残留」不至于被读成「压根没走到那一步所以看不出问题」，另外确认了暂存目录**确实会被用**：
  DEV-13 的 40 条批量导入期间它被建了出来（06:20:01 起存在，权限 `drwx------`），
  每 2 秒采一次都是空的（写进去的 `<id>.jsonl` 紧接着就 rename 进 `sessions/`，`nativeImport.ts:298`），
  收工时仍是空目录（[dev-13-staging-during-batch.txt](dev-C/dev-13-staging-during-batch.txt)、
  [dev-11-staging-final.txt](dev-C/dev-11-staging-final.txt)）。全部导入做完后 manifest 是 53 条、
  全部 `complete`、`cleanupPending` 为 true 的仍是 0 条（[dev-11-manifest-final.json](dev-C/dev-11-manifest-final.json)）。

**「可理解」的判断依据**（判据要求写清楚）：

1. **语言是混的**：真正说明原因的那句是英文原文，汇总句是中文。中文界面里突然出现一行英文技术文案，
   对不读英文的用户等于没说。
2. **说了原因，没说下一步**：两句都点明了是什么限制（4000 条目 / 67108864 字节），但没有告诉用户接下来能做什么——
   能不能拆分、是不是永远导不进、要不要改设置，一概没有。
3. **数量单位是裸字节**：`67108864-byte` 而不是「64 MiB」，用户要自己换算才知道差多少。
4. 相对地，**定位是准的**：错误就挂在出错的那一行下面，一眼能看出是哪个会话失败了，其余会话不受影响。

**结论**：⚠️ 判据后半句（无残留、无 `cleanupPending`）**完全成立**；前半句「文案可理解」只能算**部分成立**——
文案准确、定位清楚，但中英混排且没有下一步指引。这一条不是新缺陷，是文案质量问题，记在末尾清单里。

---

### DEV-12 Codex 旧格式（裸行）真机导入（H/21 C5 现场半边）

**判据**：真实旧格式 rollout 能被列出并导入成功。

**做了什么**：先在本机核对有没有真实旧格式样本，再用合成样本走一遍 GUI 作为解析层的参考。

**看到了什么（核对部分）**（[dev-12-real-rollout-formats.txt](dev-C/dev-12-real-rollout-formats.txt)）：

- `~/.codex/sessions/` 下 **12 份** rollout，逐份读首行，**12/12 都是新格式**
  （`{"type":"session_meta","payload":{...}}`，`cli_version` 是 `0.148.0` 十一份、`0.149.1` 一份）。
- 仓库里**没有**旧格式夹具文件：`rollout-*.jsonl` 零个；唯一的旧格式样本是写死在
  `src/main/services/legacyImport/__tests__/CodexRollout.test.ts:70`（`reads the legacy bare-row rollout shape`）
  与 `:103` 的对象字面量，是**合成的**。

**看到了什么（合成样本参考运行）**：把 `/tmp/t032/samples/codex-legacy-synthetic/` 那份裸行 rollout 临时拷进
`codex-home/sessions/2026/09/16/`，重载后面板里 Codex 变成 **321 个对话**，那一行以标题
`T032 SYNTHETIC legacy bare-row rollout (not a real Codex artefact)` 列出；勾选导入，
结果「新导入 1 个，已存在 0 个，失败 0 个。」（[dev-12-01-synthetic-imported.png](dev-C/dev-12-01-synthetic-imported.png)）。
落盘的 pi 会话文件 7 行，标题、user 正文、`shell` 工具调用与输出、assistant 正文都映射正确
（[dev-12-imported-session-content.txt](dev-C/dev-12-imported-session-content.txt)），manifest 记录
`status: complete`、`cleanupPending: false`（[dev-12-manifest-record.txt](dev-C/dev-12-manifest-record.txt)）。
**这份文件是合成的，不满足判据里「真实」这个词**，只能说明解析器对裸行形状还工作，不能替代判据。
跑完已把拷贝删掉、目录 `rmdir`，`codex-home` 回到 320 份。

**结论**：⛔ 缺真实样本，判据无法执行。要么找一台还留着旧版 Codex rollout 的机器，要么装一个足够老的
Codex 版本导出一份（本机最老的 `cli_version` 是 `0.148.0`，已经是新格式）。

---

### DEV-13 大目录下导入的主进程占用（import-up-03）

**判据**：300 份以上 rollout 时，打开导入面板到列表渲染的耗时，以及批量导入 40 条期间界面是否可交互。

**做了什么**：Codex 源 320 份（>300，单项目）。先做三次「冷」的面板打开计时（每次之间重载渲染层清缓存），
再另外量一次热缓存的、以及剥掉 React 只看 Main 扫描的耗时；然后勾 40 条走 GUI 导入，
导入期间每 250 ms 用 CDP 求一次往返延迟、同时在页面里跑一个 100 ms 间隔的定时器漂移探针、
并对会话列表做一次真实滚动；导入前后各记一次 Main 进程 RSS。

**看到了什么（打开耗时）**（[dev-13-panel-open-timings.txt](dev-C/dev-13-panel-open-timings.txt)、
[dev-13-timing-summary.txt](dev-C/dev-13-timing-summary.txt)）：

| 轮次 | 点齿轮 → Codex 项目行出现 | 备注 |
|---|---|---|
| 冷 run1 | **780 ms** | 首次打开 |
| 冷 run2 | **682 ms** | 重载渲染层后 |
| 冷 run3 | **960 ms** | 重载渲染层后 |
| 热缓存再开一次 | 413 ms | react-query 命中，不重扫 |

拆开看：这 0.7～1.0 秒里约 0.5～0.7 秒是弹窗自己打开并切到 Pi 分类，真正等扫描 + 渲染只有 30～290 ms。
把 React 剥掉直接连打三次 `legacyImport.listProjects()`：**175 / 169 / 170 ms**，Main 每次都全量重扫 320 份
（[dev-13-ipc-scan-timings.txt](dev-C/dev-13-ipc-scan-timings.txt)）。

**再往下点一层**：点开 Codex 项目到 320 个会话行全部渲染出来另需 **887 ms / 613 ms / 1170 ms**（三次分别测于不同阶段），
对照 Claude 项目（3 行）只要 105 ms。所以「列表渲染」按哪一层算，数字差一个量级——项目列表是亚秒，
320 行的会话列表接近一秒。列表没有虚拟化，320 个 `<label>` 是一次性全渲染的（`ConversationImportSettings.tsx:214-237`）。

**看到了什么（导入 40 条期间）**（[dev-13-batch40-watch.json](dev-C/dev-13-batch40-watch.json)）：

- 总耗时 **60.2 秒**，40 条全部成功：「新导入 40 个，已存在 0 个，失败 0 个。」
  （[dev-13-04-batch40-report.png](dev-C/dev-13-04-batch40-report.png)），侧栏随后能数出 40 行
  `T032 bulk rollout #…`（[dev-13-05-sidebar-after-import.png](dev-C/dev-13-05-sidebar-after-import.png)）。
- **CDP 往返延迟**：221 次采样，中位 **5 ms**、p95 **15 ms**、最大 **1329 ms**。超过 100 ms 的只有四次，
  位置很说明问题：t=1.2 s（1155 ms，刚点下导入、320 行整表切成 disabled）、t=4.6 s（623 ms）、
  t=58.6 s（414 ms）与 t=60.2 s（1329 ms，报告渲染、整表再刷一次）。**中间那 50 多秒几乎没有波动。**
- **渲染进程主线程卡顿**：100 ms 间隔探针的最大漂移 **1563 ms**（563 个采样），与上面两处整表重渲染对得上。
- **真实交互**：每一次采样都对会话列表做了一次滚动，**221/221 次滚动位置都真的变了**，说明界面全程在响应。
- 导入按钮全程显示「正在导入…」且 disabled——这是产品自己的 busy 设计（`ConversationImportSettings.tsx:173`），
  不是卡死。
- **Main 进程 RSS**：导入前 **237.4 MB** → 期间峰值 **246.6 MB** → 导入后 **244.1 MB**
  （[dev-13-rss-before-batch.txt](dev-C/dev-13-rss-before-batch.txt) / [after](dev-C/dev-13-rss-after-batch.txt)、
  [dev-13-main-rss-during-batch.txt](dev-C/dev-13-main-rss-during-batch.txt)）。Main 基本不涨，
  因为每条导入是 fork 一个独立 worker 进程做的（`PiImportProcess.ts:93`，`MAX_IMPORT_WORKERS = 1` 串行），
  60 秒里 40 次 fork/退出——这也解释了 1.5 秒/条的单条成本。整机 available 在导入前后都在 1.2 GB 左右，没有压到内存墙。

**一个顺带的读数**：35 MiB 那份 Claude 会话的解析是在 **Main 里**做的（守卫在 `ClaudeSourceAdapter`），
Main 的 RSS 当场从 227 MB 冲到 **312 MB** 再回落。也就是说，导入的**扫描与转换在 Main，落盘在 worker**，
大文件的内存峰值算在 Main 头上。

**结论**：✅ 判据要的两组数都测到了。打开面板到列表渲染 0.68～0.96 秒（320 份 Codex，三次冷读数）；
批量导入 40 条期间界面可交互——中位往返 5 ms、滚动 221/221 成功，只在起手与收尾各有一次 1.2～1.6 秒的整表重渲染停顿。
判据是记录式的、没给阈值，所以这里只报读数与口径，不下「达标/不达标」的判断。

---

### 判据问题（请改检查单）

**一、第 10 行（DEV-10）写的是修复后的期望，而修复还没落地。** 判据「Codex 项目仍能列出其它日期的会话」
描述的是 import-up-01 修好之后的样子；这条缺陷当前挂在 T052（批次 F 待修），所以今天照字面验只能得到 ⛔。
建议在该行补一句现状注记：「当前预期为 ✗（整源消失且无提示无日志），T052 落地后按本判据复验」，
免得后来的人把已知缺陷当成自己操作失误或环境问题。

**二、第 13 行（DEV-13）没有定义「列表渲染」指哪一层。** 项目列表（2 行）与会话列表（320 行）差一个量级：
前者 0.68～0.96 秒，后者还要再加 0.6～1.2 秒。本批两层都量了并分别记录，但检查单应该点名要哪一个，
否则两个人做同一项会给出差一倍的数字。另外这一行是记录式判据、没有阈值，建议明确写「只记录不判定」，
或者给一个上机日要对比的基线值。

**三、第 12 行（DEV-12）在本机不可执行，建议改口径。** 「真实旧格式 rollout」这台机器上拿不到
（12/12 新格式，仓库也没有夹具）。要么把这一行明确挪到上机日/换机器执行，要么拆成两条：
解析层回归用合成样本（今天已跑通，可当回归基线），真实样本缺口单列成一条待办。

DEV-13 的「列表渲染」歧义已于 2026-09-17 在检查单 5.1 明确为两个数；DEV-10 / DEV-12 的判据未改（分别是 T052 待修的修复后形态、本机无真实样本）。

---

### 本批的疑似缺陷清单

| # | 现象 | 判定 | 证据 |
|---|---|---|---|
| E | Codex 会话目录下任一日期子目录不可读时，**整个 Codex 源从导入面板消失**，而不是跳过那一天 | ⛔ 确认复现（已知 import-up-01，T052 批次 F 待修） | [dev-10-02-panel-with-eacces-scrolled.png](dev-C/dev-10-02-panel-with-eacces-scrolled.png)、[dev-10-pane-with-eacces.txt](dev-C/dev-10-pane-with-eacces.txt) |
| F | 上述失败**对用户和对日志都完全无声**：界面无任何提示，`EACCES` 在 dev.log / main.log / 按天日志三处计数均为 0 | ⚠️ 疑似缺陷（可观测性），与 E 同源但修 E 时容易漏掉 | [dev-10-mainlog-grep.txt](dev-C/dev-10-mainlog-grep.txt) |
| G | 导入失败文案中英混排：原因句是英文原文（`Claude session exceeds the 4000-entry import limit`），汇总句是中文；且不给下一步、字节数用裸 `67108864-byte` | ⚠️ 文案质量问题，不影响功能 | [dev-11-pane-after-35mib.txt](dev-C/dev-11-pane-after-35mib.txt)、[dev-11-pane-after-64mib.txt](dev-C/dev-11-pane-after-64mib.txt) |
| H | **整条导入链路没有任何日志**：42 次成功导入 + 2 次守卫失败，三处日志里连一行 `legacy-import` 都没有 | ⚠️ 疑似缺陷（可观测性），出问题时无从查起 | [dev-11-13-mainlog-grep.txt](dev-C/dev-11-13-mainlog-grep.txt) |
| I | 会话列表不做虚拟化，320 行一次性全渲染；导入起手与收尾各有一次 1.2～1.6 秒的整表重渲染停顿 | ⚠️ 轻微，320 份量级尚可接受，份数再上一个量级需复核 | [dev-13-batch40-watch.json](dev-C/dev-13-batch40-watch.json)、[dev-13-timing-summary.txt](dev-C/dev-13-timing-summary.txt) |

---

### 本批的环境交代

- **起过 1 次 Electron**（`node scripts/dev.js --remote-debugging-port=9333`，带两个样本环境变量），
  收工时 `kill` 了 dev.js 的真实 pid（75515），没有用过 `kill -1` / `pkill -f`。退出后
  `dev.js` / `electron-vite` / electron / esbuild 全部消失、9333 与 5173 端口释放、
  `free -m` 的 available 从运行时的 1210 MB 回到 **1866 MB**
  （[dev-C-ps-before-exit.txt](dev-C/dev-C-ps-before-exit.txt) / [after](dev-C/dev-C-ps-after-exit.txt)）。
- **`chmod` 已还原**：`codex-home/sessions/2026/09/12` 回到 `drwxrwxr-x`（775），与其余日期目录一致，40 份文件可读
  （[dev-C-cleanup.txt](dev-C/dev-C-cleanup.txt)）。
- **`--huge` 造的 64.08 MiB 样本已删**（tmpfs 占内存）；合成旧格式样本拷进 `codex-home` 的那份也已删、
  目录已 `rmdir`，`codex-home` 回到 320 份，合成样本仍留在 `codex-legacy-synthetic/` 原处。
- **留在机器上的新增物**：42 条导入会话（40 条 Codex bulk + 1 条合成旧格式 + 1 条 Claude 对照），
  `legacy-import-manifest.json` 从 11 条记录涨到 53 条，userData 的会话目录下多了一个产品自己建的空目录
  `.aiclient-import-staging/`。这些都是导入动作的正常产物，没有清理。
- **没有动上一批留下的应用状态**：`settings.json` 的 `temporaryWorkspaceEnabled` / `chatAgentDefaults` 原样未碰。
- 未发任何模型消息（`maxapi` / `cx2` 一次都没用），未跑 vitest，未跑 `pnpm build`，未改任何产品代码。

## 十、需起 Electron 的第三组：main-host-aux 三项 + 协议版本 + 宿主横幅（dev-B）

证据目录 [dev-B](dev-B/)。分支 `feat/runtime-evolution`，dev 模式（userData = `~/.config/jyw-ai-client-dev`）。

本批做的是检查单[第四节「开发机」表](../../checklist-e.md)的第 1 / 2 / 3 / 4 / 18 行，
对应 `main-host-aux` 的 01/02/03 现场半边、`main-host` 的 main-host-08，以及 `chat-event-vocab` 的宿主横幅一项。

### 本批的五条方法学注记

**一、一句真模型都没发，全部走本地假网关。** `maxapi` / `cx2` / `vllmproxy` 一次都没碰。做法是把
`/home/ai/.pilab/jyw-ai-client-dev/credentials/vault.json` 临时换成明文，塞一个自定义 AI 服务
`Fake Gateway`（`baseUrl=http://127.0.0.1:18080`、`api=anthropic-messages`、模型 `fake-sonnet`），
再把设置里的全局默认模型改成 `fake-gateway/fake-sonnet`。假网关是 `/tmp/t032/fake-gateway.mjs`（点验用脚本，未进仓库），按请求序号发确定性回包（`archive-probe` 计划：
bash sleep → write → read → bash pwd → 收尾文本）。两处改动收工时都还原了，逐条见末尾环境交代。

**二、哪些是我亲测的，哪些是我从证据回推的，逐节写明。** DEV-3、DEV-2 与 DEV-1 的第一轮对照回合由
**前一位代理**实跑（他被误停在 DEV-1 第二轮中途）；我从 `dev-B/` 里的 `*-t?-*.txt` 目录快照、
`session-index.json` 摘录与截图重建记录，节内标注「**回推**」。DEV-1 的第二轮观察、DEV-4、DEV-18
是**我亲测**，节内标注「**亲测**」。回推的部分我没有改写任何数字，只补了「这意味着什么」。

**三、每一句话都走界面。** 发送一律 `textarea` 填字 + 点 `[aria-label="发送消息"]`；权限卡按要求点
「直接允许」；归档走侧栏右键菜单 +「归档会话」确认框。只有读状态用 CDP 直读 store、直读磁盘文件与
`/proc/<pid>/environ`。

**四、强杀只用真实 pid。** 停应用一律 `kill <dev.js 的真实 pid>`（它自己遍历进程树逐个 SIGTERM→SIGKILL）；
查残留遍历 `/proc/*/cmdline` 精确匹配。全程没有用过 `kill -1`、`process.kill(-1)`，也没有用过 `pkill -f`。
**有一个坑记一笔**：用 `/proc` 扫残留时，如果匹配串里含 `fake-gateway.mjs` 或 `Pi Worker` 这类字面量，
会匹配到执行这条扫描命令的 bash 自己，读成「有残留」。判残留要把自己的 shell 排掉。

**五、DEV-4 在 dev 模式下不需要任何构建。** 检查单写的是「改打包产物里的 worker.js」，但
`PiWorkerProcess.ts:30-34` 表明 dev 模式的 worker 入口是 `<appPath>/src/agent-host/worker.ts`（源码，
`--experimental-strip-types` 现读），`out-agent-host/worker.js` 根本不参与。而 Main 是 electron-vite 在
dev 启动时打进 `out/main/index.js` 的。**所以「只改一侧」= 应用先起好，再改源码常量**——实测
electron-vite dev 不会因为改 `src/` 下的文件重建 main 或重启 Electron（改完等 25 秒，`out/main/index.js`
的 mtime 未变、Electron pid 未变）。这条省掉了 `pnpm build:agent-host`（本机内存跑不动整包构建）。

---

### DEV-3 兼容根子代理定义的删除语义（main-host-aux）——**回推**

判据：「在 `~/.agents/subagents` 放一份定义并编辑后删除，该行应消失而不是回到旧内容」。

四个时点的目录快照在 [dev-03-t0-dirs.txt](dev-B/dev-03-t0-dirs.txt) ～
[dev-03-t4-after-restart.txt](dev-B/dev-03-t4-after-restart.txt)，界面在 6 张 `dev-03-*.png` 里。

| 时点 | 兼容根 `~/.agents/subagents` | 主目录 `<agentDir>/subagents` | 设置页那一行 |
|---|---|---|---|
| t0 起应用前 | `probe-compat.md` 210 B，描述 = ORIGINAL，md5 `8e9781…` | **空** | —— |
| t1 在设置页编辑描述并保存 | **原文件一字未动**（md5 仍是 `8e9781…`） | 新出现 `probe-compat.md` 207 B，描述 = EDITED | 显示 EDITED |
| t2 点一次删除 | **仍在**，仍是 ORIGINAL | 被删空 | **回到 ORIGINAL**（[dev-03-05-list-after-delete.png](dev-B/dev-03-05-list-after-delete.png)） |
| t3 对同一行再点一次删除 | 被删空 | 空 | 该行终于消失 |
| t4 复原兼容根文件并重启 | 复原（md5 与 t0 一致） | 空 | 该行回来，描述 = ORIGINAL |

**结论：判据不成立（⛔）。** 「编辑后删除」的第一次删除之后，那一行**正是回到了旧内容**，而不是消失。

成因看代码是清楚的：编辑走的是 `subagentCatalog.ts:236/386` 的写路径，它无条件 `mkdir` 主目录再写
`<agentDir>/subagents/<name>.md`（`:408`），也就是**把兼容根的定义复制一份到主目录再改**，兼容根原件不动；
而删除只删得到主目录那一份。合并规则是「主目录 > 兼容根 > 内置，同名先到者赢」（`catalog.ts:78-89`、
`subagentDefinition.ts:566-586`），影子没了，兼容根那份就重新浮上来。

对用户的观感就是：**改了一个子代理，删掉它，它带着改之前的样子回来了；要删两次才真的删掉。**
中间没有任何提示告诉用户「你编的是一份副本」「这一行还有一个更底下的来源」。

### DEV-2 临时根改设置后的旧根（main-host-aux）——**回推**

判据两问：① 旧根下的 `unbound-sessions/` 在退出与重启后是否仍在；② 重开旧对话时侧栏是否仍标为临时会话。
取证要求「改设置前后各记一次两个根的目录列表与 `session-index.json` 的 unbound 位」。

五个时点的快照在 [dev-02-t0-before.txt](dev-B/dev-02-t0-before.txt) ～
[dev-02-t4-after-restart.txt](dev-B/dev-02-t4-after-restart.txt)，7 张 `dev-02-*.png` 是界面。

| 时点 | 保存位置设置 | 旧根 `~/JYWAI/temporary` | 新根 `~/JYWAI/temporary-dev2-new` | 索引 |
|---|---|---|---|---|
| t0 起应用前 | `""` | `unbound-sessions/` **不存在** | 不存在 | 156 行 / 12 条 unbound |
| t0b 上一轮被 SIGTERM 杀掉之后 | `""` | `unbound-sessions/ec331867…` **还在** | —— | —— |
| t1 应用运行、旧根下跑完一回合 | `""` | `unbound-sessions/f6ab0bf8…` | 不存在 | 158 行 / 14 条 |
| t2 走界面正常退出（Close → 确认退出 → 退出） | `""` | **只剩 `temporary` 本身，`unbound-sessions/` 整根被清** | —— | 158 行 / 14 条，f6ab0bf8 那行仍在磁盘上、仍带 `unbound:true`、`workspacePath` 指向已被删的目录 |
| t3 应用运行、**用 GUI 把保存位置改成新根** | `"/home/ai/JYWAI/temporary-dev2-new"`（写在 `aiclient-settings.state` 里） | 三个 scratch 目录，**其中 e51a06d5 是改设置之后才新建的对话** | 目录被建出来了，但**空的** | —— |
| t4 带新设置重启 | 同上 | 又被清成只剩 `temporary` | 空 | 160 行 / 16 条，三条 DEV-2 会话的 `workspacePath` **全部仍指向旧根** |

**① 旧根的 `unbound-sessions/` 退出后不在了，重启后也不在。** 正常退出会整根擦除
（`ipc/workerManager.ts:11` 的 `wipeAll()`），换根之后旧根照样被擦（T037 `99db822c` 第三条的
「scratch 服务记住本次运行从设置解析出的每个根」确实生效）。**只有被 SIGTERM 强杀的那一次留了残留**
（t0b），下次启动的 `sweepScratchWorkspacesOnStartup` 负责收尾——这条差异按取证要求记在这里。

**② 重开旧对话，侧栏仍标为临时会话。** t4 重启后侧栏「临时对话」分组里三条 DEV-2 会话全带 `temporary` 徽标
（[dev-02-07-sidebar-after-restart.png](dev-B/dev-02-07-sidebar-after-restart.png)、
[dev-02-05-old-chat-reopened.png](dev-B/dev-02-05-old-chat-reopened.png)），索引行也仍带 `unbound:true`。
**这是对的**：目录已经没了，但「不可信任、不当成真实项目」这个姿态必须留住（T037 原话是「会话保持 unbound 不信任姿态」）。

**③ 顺手撞出来的一件事：GUI 改的「保存位置」，Main 根本读不到。**
t3 的快照记了一句关键观察——改设置之后新建的对话（e51a06d5），scratch 目录**还是落在旧根**。
我把这条追到了代码：

- `ScratchWorkspaceService.ts:83` 与 `TempWorkspaceService.ts:36` 都是 `readSettings()?.defaultTemporaryPath`；
- `readSettings()`（`main/ipc/settings.ts:82-87`）返回的是 `settings.json` 的**顶层对象**（或渲染层排队中的同形状对象）；
- 而这台机器上 `settings.json` 的顶层只有两个键：`credentialMode` 和 `aiclient-settings`，
  用户设置全在 `aiclient-settings.state` 这一层里面（`defaultTemporaryPath` 就在里面）。

也就是说 `readSettings()?.defaultTemporaryPath` **恒为 `undefined`**，`settingsTemporaryPath()` 恒返回 `''`，
scratch 根与临时工作区基目录**永远回落到默认的 `~/JYWAI/temporary`**。`ScratchWorkspaceService.ts:78-82`
那段注释（F2-a：「让两个读者立刻看到用户刚改的 base path」）描述的行为在当前的设置文件形状下拿不到。
界面侧不受影响是因为渲染层自己从 zustand store 读得到真值，并把 `basePath` 显式传进
`tempWorkspace.create/remove` —— 所以用户会看到「临时工作区去了新目录、临时对话还在老目录」。

这件事不在 DEV-2 的判据里，但它正好是判据②「重开旧对话」背后的同一个设置项，记成疑似缺陷（见末尾 D13）。

### DEV-1 归档正在跑回合的临时对话（POSIX 半边，main-host-aux-02）——**对照回合回推 + 第二轮亲测**

判据：「回合后续的文件工具不会在已删除目录里静默失败，或至少给出与『目录没了』相关的错误」。

**第一轮（对照，不归档）——回推。** 同一条临时对话里跑完整条 `archive-probe` 链：
`bash sleep 45` → `write archive-probe.txt` → `read` → `bash pwd && ls -la` → 收尾文本，
五步全部 `toolOk: true`，`pwd` 打印出来的就是 scratch 目录本身，文件真的写进去了
（[dev-01-control-turn-not-archived.json](dev-B/dev-01-control-turn-not-archived.json)）。
**这一轮的意义是证明这条链在不归档时会一路走到文件工具**，否则「归档后文件工具没失败」可能只是因为它压根没跑到。

**第二轮（回合中途归档）——亲测。** 假网关换成 `--sleep 150`，让第一个工具是一条要跑 150 秒的
`bash sleep 150 && echo slept`；回合跑起来之后从侧栏归档这条对话（确认框
[dev-01-01-archive-confirm.png](dev-B/dev-01-01-archive-confirm.png)：「归档会话 / 归档「…」？它会从侧栏移除。」）。
逐条读数在 [dev-01-run2-observations.txt](dev-B/dev-01-run2-observations.txt)，原始条目在
[dev-01-run2-jsonl-seq14-17.jsonl](dev-B/dev-01-run2-jsonl-seq14-17.jsonl)。

时间线（时间戳全部取自会话 JSONL 与 `session-index.json` 自身，UTC）：

| 时刻 | 事件 |
|---|---|
| 11:19:09.022 | 用户消息进入会话 |
| 11:19:09.134 | 模型回 `toolCall bash: sleep 150 && echo slept` |
| 11:20:05.696 | `session-index.json` 该行 `archived=true` |
| 11:20:05.707 | `toolResult`：`(no output) [exit=null; aborted]`，`signal=SIGTERM`、`termination=aborted` |
| 11:20:05.709 | 助手条目 `stopReason=error`，`errorMessage="This operation was aborted"` |

归档到 bash 子进程收到 SIGTERM 只差 **11 毫秒**。假网关此后**再没收到过任何一次请求**
（计数器停在 `{"count":1}`，计划里的 write / read / pwd / 收尾文本四次请求一次都没发生）。
scratch 目录 `unbound-sessions/6583166b-…` 已被删掉（父目录 mtime 正是 07:20），
而对照回合里 `bash pwd` 还列得到它。

**结论：判据成立（✅）。** 而且成立的方式比判据设想的更干净——**不是「后续文件工具在已删除目录里失败」，
是压根没有后续文件工具**：归档先把 worker 停掉（连带把正在跑的 bash 子进程 SIGTERM 掉、把整个回合标成
aborted），worker 确认退出之后才去删它的 cwd。这正是 T037（`99db822c`）第二条写的
「归档先 await workerManager.closeSession 确认 worker 退出再 release 它的 cwd」，
代码在 `src/main/ipc/chat.ts:660-675`，那段注释还把旧缺陷的形状写在里面
（「A turn still running then wrote into a directory that no longer existed (POSIX)」）。

**两条附带观察：**

1. **全过程零日志。** 归档、worker 退出、scratch 目录删除三步，在 `main.log`、按天日志
   `aiclient-2026-09-17.log`、`dev.js` 的标准输出三处一行都没写（三个文件的 mtime 都停在归档前的 07:17）。
   读码对得上：`ScratchWorkspaceService.ts:244` 的 `[scratch] failed to remove` 只在**删除失败**时打，
   成功路径本来就不记；`WorkerSlot.ts:478` 的 `Worker exited` 只用于 crash 分支组装错误消息，
   正常 `closeSession` 不走那里。**「删对了」和「没删」在日志上长得一模一样**，这条链出问题时无从查起。
2. **用户看不到这个中止。** 会话被归档后就从侧栏消失了，`This operation was aborted` 只留在 JSONL 里，
   而且是英文原文。归档确认框的文案也只说「它会从侧栏移除」，没提「正在跑的回合会被中止」。

### DEV-4 协议版本不匹配的可诊断性（main-host-08）——**亲测**

判据：「故意让打包产物里的 worker.js 与 Main 的 `WORKER_RPC_PROTOCOL_VERSION` 不一致，检查日志里是否出现
任何指向『协议版本』的字样；当前预期是只有 `worker.bootstrap timed out`，无任何协议线索」。

做法与逐条读数在 [dev-04-protocol-mismatch.txt](dev-B/dev-04-protocol-mismatch.txt)，界面在
[dev-04-01-bootstrap-timeout.png](dev-B/dev-04-01-bootstrap-timeout.png)。要点：

- **只改一侧怎么做到**：见方法学注记第五条。应用起好之后把 `src/shared/types/workerRpc.ts:50` 的 `1` 改成 `2`，
  此后新 fork 的 worker 现读源码拿到 2，Main 用的是启动时打好的产物、仍是 1。
  两侧都核对过：`grep -ao 'const WORKER_RPC_PROTOCOL_VERSION[^;]*;' out/main/index.js` → `= 1;`，源码 → `= 2`。
- **界面**：新建对话发一条消息，先是「正在发送… / 正在启动 Agent Host… · 55s」这样带秒数的等待态，
  **等满 63 秒**（bootstrap 预算 60 秒，`createPiWorkerSlot.ts:57`）后变成一张红色错误卡，逐字是：

  > `Error: Error invoking remote method 'chat:createSession': WorkerSlotError: Worker request worker.bootstrap timed out after 60000ms`

- **日志**：`main.log` 新增 0 字节；按天日志与 `dev.js` 标准输出各新增一条同样内容的 `[error]` 行加三行
  Node 内部调用栈。三处 grep `protocol|mismatch|bootstrap` 的**全部命中就是这一条**，
  「protocol」「版本」「mismatch」一个字都没有。

**结论：判据的预期逐字复现（✅ = 确认缺口存在）。** 为什么是这样，`handbook` 第 10 节已经讲清：
Main 对版本不符的入站消息是**静默丢弃**（`WorkerSlot.ts:517-529`），worker 回的
`WORKER_PROTOCOL_MISMATCH`（`piWorkerRpcServer.ts:336-348`）作为 RPC 响应发回去，对不上任何 pending 请求，
也不进 stderr，于是两侧都不说话，最后只剩一个超时。

**两条附带观察：**

1. **用户那条消息被吞了。** 失败后会话区回到「No messages yet. Send a prompt to stream from the Agent Host.」，
   输入框也是空的——用户打的字既没留在输入框也没进时间线，只能重打一遍。
2. **失败留了一行空壳索引。** `session-index.json` 多出 `session-1789644851492-gidi2oz`，`title=""`，
   `workspacePath=/home/ai/code/ai-client`（索引行数 161 → 162）。`chat:createSession` 明明失败了，
   索引行却留着，重启后它以「Session idi2oz」的名字出现在侧栏里。

### DEV-18 宿主诊断横幅（chat-event-vocab）——**亲测**

判据：「人为让 Node 24 解析失败时，用户能否看到可操作的提示」。取证：「清掉 `AICLIENT_NODE24_PATH`
并让默认 node 不可用后起应用」。逐条读数在 [dev-18-node24-banner.txt](dev-B/dev-18-node24-banner.txt)。

**先把环境钉死**：本机 `node -v` = v22.23.2，`which -a node` 全部指向同一个 v22 软链，
`~/.nvm/versions/node/` 下只有 v22.23.2，fnm / volta 目录不存在。全机唯一一份 Node 24 是
`out-node-runtime/node`（v24.18.0），**不在 PATH 上**，只靠 `dev.env` 的 `AICLIENT_NODE24_PATH` 指过去。
所以把这一行删掉，`NodeRuntimeResolver` 的四条候选（explicit / env / 版本管理器 / PATH）一条都拿不到 24，
不需要再额外动 PATH。

**做法**：`dev.env` 去掉那一行存成 `/tmp/t032/dev.env.no-node24`（24 行 → 23 行），
`AICLIENT_DEV_ENV_FILE` 指过去起应用。自证：Electron 主进程 `/proc/388798/environ` 里
`grep -c '^AICLIENT_NODE24_PATH=' = 0`，PATH 上只有 v22 的两个目录。

**观察到的是**：

- `chat.getHostStatus()` 返回 `{"state":"ready", …}`，**宿主自称就绪**；
- 页面上 `[role="status"]` 只有状态栏的「本机」一个，**一张诊断横幅都没有**；
- 新建对话发一条消息，假网关四次请求全部正常应答，结构化中文权限卡照弹（按要求点「直接允许」，共两次），
  最终显示「已处理 3 个步骤 / archive probe finished」——**没有 Node 24 也照常跑完整回合**
  （[dev-18-01-turn-without-node24.png](dev-B/dev-18-01-turn-without-node24.png)、
  [dev-18-02-turn-finished.png](dev-B/dev-18-02-turn-finished.png)）；
- 日志里 `node 24` / `NODE24` / `No Node` / `runtime found` 命中数全部为 0。

**结论：这个失败在当前代码里造不出来，判据无法执行。** 读码确认是两层都断了：

1. **没有任何生产代码调用 `resolveNode24Runtime`。** `grep -ran` 的命中只有定义本身、
   `agent-host/index.ts` 的 re-export、以及它自己的单测。`NodeRuntimeResolver.ts:123` 那句
   `No Node 24 runtime found. Set AICLIENT_NODE24_PATH or install Node 24.` 在产品运行时永远不会被生成。
   这本身是合理的：P6 之后 worker 跑在 Electron 自己的 utilityProcess 里（`PiWorkerProcess.ts:94`），
   不需要外部 Node 24。
2. **就算这条错误真冒出来，渲染层也不会把它变成「可操作的提示」。**
   `hostStatus.ts:264` 的 `isNode24ResolutionFailure` 同样只被自己的单测引用；真正决定横幅长什么样的
   `describeHostStatus`（`hostStatus.ts:92-122`）压根没调它，`state=error` 时只给
   「`lastFatalError` 原文 + Press Retry to reinitialise the Pi session service + Retry 按钮」。
   而 `HostStatusBanner.tsx:8-12` 的文档注释仍写着自己「覆盖 Node 24 missing actionable guidance
   （`AICLIENT_NODE24_PATH`）」。

---

### 判据问题（请改检查单）

**一、第 18 行（DEV-18）的前提已经不成立，照字面执行只会得到「什么都没发生」。**
判据假设「人为让 Node 24 解析失败」是可造的，但产品里没有任何地方解析 Node 24（见上节）。
建议改成两句：① 现状注记——「`AICLIENT_NODE24_PATH` 与 Node 24 解析在 P6 之后已无生产调用方，
本项当前不可执行」；② 把这一行的验证目标改成仍然活着的那部分——「宿主进入 `state=error`
（例如 bootstrap 超时）时横幅是否出现、文案是否可操作」，否则这一行会一直挂着一个永远验不出来的场景。

**二、第 1 行（DEV-1）的判据措辞与修复后的实际形态对不上，建议补一句。**
判据写的是「回合**后续的文件工具**不会在已删除目录里静默失败，或至少给出与『目录没了』相关的错误」——
这是修复前的形状（工具真的跑了、真的失败了）。T037 之后的实际形态是**整个回合在归档那一刻被中止**
（bash 子进程 SIGTERM、`stopReason=error / This operation was aborted`），后续工具根本不会被调起，
所以「与目录没了相关的错误」永远不会出现，照字面对第二个分句去验会读成「没给出相关错误 → 不通过」。
建议改成：「归档时正在跑的回合被中止（工具进程收到 SIGTERM、回合记为 aborted），worker 退出之后
scratch 目录才被删；不出现任何『在已删除目录里写入 / 读取』的工具调用」。

**三、第 2 行（DEV-2）只问了两件小事，真正的雷不在判据里。**
判据问的「旧根还在不在」「侧栏还标不标 temporary」两条都通过了，但这一行的动作（用 GUI 改保存位置）
顺手暴露的是「**Main 读不到这个设置**」（D13）。建议在这一行的取证里加一格：
「改设置后**新建**一个临时对话，记它的 scratch 目录落在哪个根」——一格就能把 D13 逼出来，
而现在的取证只记「两个根的目录列表」，正好会漏掉。

**四、第 3 行（DEV-3）的判据是对的，结论是 ✗，建议补现状注记。**
「该行应消失而不是回到旧内容」——实测第一次删除之后它就是回到了旧内容，要删两次。
建议照 DEV-10 的办法在该行补一句「当前预期为 ✗（编辑写主目录影子、删除只删影子），修复后按本判据复验」，
免得后来的人把已知缺陷当成自己操作失误。

---

### 本批的疑似缺陷清单

| # | 现象 | 判定 | 证据 |
|---|---|---|---|
| J | 兼容根（`~/.agents/subagents`）里的子代理定义，在设置页编辑后再删除，**第一次删除只删掉主目录里的影子副本，那一行带着编辑前的旧内容回来**，要删第二次才真的消失；全程无任何提示说明「你编的是副本」 | ⛔ 确认复现，**DEV-3 判据直接判负** | [dev-03-t1~t3](dev-B/dev-03-t2-after-delete.txt)、[dev-03-05-list-after-delete.png](dev-B/dev-03-05-list-after-delete.png) |
| K | 设置里的「保存位置」（`defaultTemporaryPath`）**Main 侧恒读不到**：`readSettings()` 返回 `settings.json` 顶层（只有 `credentialMode` / `aiclient-settings` 两个键），而该键在 `aiclient-settings.state` 里。`ScratchWorkspaceService.ts:83` 与 `TempWorkspaceService.ts:36` 都这么读，于是 scratch 根永远回落 `~/JYWAI/temporary`；渲染层自己读 store 拿得到真值并显式传 `basePath`，结果是「临时工作区去了新目录、临时对话还在老目录」 | ⚠️ 疑似缺陷（前任实测现象 + 我读码定因，未写用例复核） | [dev-02-t3-after-gui-change.txt](dev-B/dev-02-t3-after-gui-change.txt)、[dev-02-t4-after-restart.txt](dev-B/dev-02-t4-after-restart.txt) |
| L | 归档正在跑回合的临时对话时，**归档 / worker 退出 / scratch 目录删除三步全过程零日志**（三处日志文件 mtime 都停在归档之前）。成功路径本就不记：`[scratch] failed to remove` 只在失败时打，`Worker exited` 只用于 crash 分支 | ⚠️ 疑似缺陷（可观测性）：「删对了」与「没删」在日志上无法区分 | [dev-01-run2-observations.txt](dev-B/dev-01-run2-observations.txt) |
| M | worker bootstrap 失败（本轮由协议版本不匹配制造，超时 60 s）之后：① 用户刚发的那条消息**被吞**，输入框与时间线都没有，只能重打；② `session-index.json` 留下一行 `title=""` 的空壳会话，重启后以「Session xxxxxx」出现在侧栏 | ⚠️ 疑似缺陷（两条都与 DEV-4 判据无关，是顺手撞到的） | [dev-04-protocol-mismatch.txt](dev-B/dev-04-protocol-mismatch.txt)、[dev-04-01-bootstrap-timeout.png](dev-B/dev-04-01-bootstrap-timeout.png) |
| N | `AICLIENT_NODE24_PATH` 已是没人读的环境变量（唯一读它的 `resolveNode24Runtime` 没有生产调用方），Node 24 横幅分支（`isNode24ResolutionFailure`）同样只被单测引用；但 `dev.env` 里还留着这一行并配着一段解释注释，`HostStatusBanner.tsx:8-12` 的文档注释也还在承诺这个分支 | ⚠️ 死代码 + 文档漂移，不影响功能，但会让后来的人按注释去验一个不存在的场景 | [dev-18-node24-banner.txt](dev-B/dev-18-node24-banner.txt) |

---

### 本批的环境交代

- **起过 Electron 的次数**：前一位代理 6 次（`/tmp/t032/dev-B1.log` ～ `dev-B6.log`），我 1 次
  （`/tmp/t032/dev-B7.log`，带 `AICLIENT_DEV_ENV_FILE` 指向去掉 Node24 的 dev.env 副本）。
  收工时按真实 pid `kill 388751`（dev.js），遍历 `/proc/*/cmdline` 复扫：
  `dev.js` / `electron-vite` / electron / esbuild / 假网关**全部消失**，9333 / 5173 / 18080 三个端口全部释放，
  `free -m` 的 available 从运行时的 1312 MB 回到 **1906 MB**。全程未用 `kill -1` / `pkill -f`。
- **凭据库已还原并核对**：`node /tmp/t032/register-fake-provider.mjs --restore <备份>` 执行完毕，
  `vault.json` 从明文的 469 B 回到加密原件的 **1042 B**（与备份同字节），字段回到
  `version:2 / enc:"none" / userProvidersEnc:"safeStorage"`、`userProviders` 是加密字符串。
  备份文件 `vault.json.bak-2026-09-17T10-41-30-495Z` 我**没有删**（内容与现文件一致），留在
  `~/.pilab/jyw-ai-client-dev/credentials/` 下，后面的批次看到别当成异常。
- **设置已还原**：`chatAgentDefaults` 键**已删除**（本批把它改成过 `{"model":"fake-gateway/fake-sonnet"}`，
  A1 批次把它设成过 `{"model":"maxapi/grok-4.6"}`，**再往前这个键本来就不存在**，所以删掉是回到原状）；
  「保存位置」`defaultTemporaryPath` 已是 `""`，与 [dev-02-t0-before.txt](dev-B/dev-02-t0-before.txt) 一致；
  A1 打开的 `temporaryWorkspaceEnabled: true` **按 A1 的交代保留不动**。
  改动前的整份设置备份在 `/tmp/t032/settings.json.bak-before-B-cleanup`。
- **产品代码零改动**：DEV-4 临时把 `src/shared/types/workerRpc.ts:50` 从 `1` 改成 `2`，已按备份还原，
  sha256 前后一致（`ea9ebf9e785ead694ab52786ecf245bc8d3261cfcb807a4847fa8765c203e964`）。
  收工时 `git status --short` 与接手时逐行一致（两份文档 M + 六项未跟踪，其中 `dev-B/` 是本批证据），
  `git diff --stat` 只有 `checklist-e.md` 与 `README.md` 两份文档。
  **未跑 `pnpm build`、未跑 `pnpm build:agent-host`、未跑任何 vitest。**
- **临时物已清**：`/tmp/t032/dev.env.no-node24` 已删；DEV-18 批准写出的
  `/home/ai/code/ai-client/archive-probe.txt`（21 B）已删；DEV-2 造的新根
  `/home/ai/JYWAI/temporary-dev2-new` 已不存在（被产品自己的整根清理带走）；旧根
  `/home/ai/JYWAI/temporary/` 已空。子代理两个目录（`~/.agents/subagents` 与
  `<agentDir>/pi-agent/subagents`）**均已不存在**，与 handbook 第 9.1 节记录的原始状态一致。
- **留在机器上的新增物**：本批几条探针会话的 JSONL 与对应索引行（含 DEV-1 那条已归档的
  `session-1789643542628-wgulnuk`、DEV-4 失败留下的空壳行 `session-1789644851492-gidi2oz`、
  DEV-18 那条 `devB DEV-18 node24 banner probe`）。这些是点验动作的正常产物，没有清理——
  其中空壳行本身就是 D-M 那条缺陷的现场证据。

## 十一、需起 Electron 的第四组：terminal-tui 三项 + h-nodes 两项 + TUI-1/H/20 一圈（dev-D）

证据目录 [dev-D](dev-D/)。分支 `feat/runtime-evolution`，dev 模式（userData = `~/.config/jyw-ai-client-dev`）。

本批做的是检查单[第四节「开发机」表](../../checklist-e.md)的第 14 / 15 / 16 / 30 / 31 / 32 行，
对应 `terminal-tui` 的 terminal-03 / terminal-04 / 双窗口一项、`field-nodes` 的 TUI-1（H/20 真机一圈）、
`h-nodes` 的 H/19 验证案例 7 与 H/21 内嵌 TUI 模型缺失覆盖层。

**六项全部我亲测**，没有任何一项是从别人的证据回推的。

---

### 本批的六条方法学注记

**一、一句真模型都没发，两道保险。** `maxapi` / `cx2` / `vllmproxy` 一次都没碰。

- 第一道：GUI 侧把凭据库 `vault.json` 临时换成明文，塞一个自定义 AI 服务，
  TUI 侧把物理的 `pi-agent/models.json` + `auth.json` **整份换成只有 `probe-fake` 一个 provider**
  （不是「加入」而是「只留它」——加入的话 pi 的兜底还可能挑到别家）。两侧都指向本地假网关
  `http://127.0.0.1:18080`（`/tmp/t032/fake-gateway.mjs --plan text`，点验用脚本，未进仓库）。
- 第二道：第二、三次起应用时用 `AICLIENT_DEV_ENV_FILE` 指向一份 dev.env 副本，**把
  `ANTHROPIC_BASE_URL` 改成假网关地址**，其余键一字未动（键集合 diff 为空）。
  这道保险不是多余的：见下面第三条。

**二、wire id 不是 vault 里的 `id`，是显示名的 slug。** 任务书给的 wire id 是 `probe-fake/fake-sonnet`，
但 `register-fake-provider.mjs` 写进 vault 的是 `id: "probe-fake", name: "Fake Gateway"`，
而 `userProviderId()`（`PiModelConfigService.ts:697-706`）**取的是 `name` 做 slug**，于是 worker 侧
拿到的目录里只有 `fake-gateway/fake-sonnet`，第一次发送直接报
`no model "probe-fake/fake-sonnet" in the catalog (1 available)`。把 vault 里的 `name` 改成
`probe-fake` 之后两侧才对齐。**后面的批次要接着用假网关的话，记这一条。**

**三、内嵌 TUI 会继承应用的 `ANTHROPIC_*`，并能落到应用自己目录里没有的 provider 上。**
打开一条模型缺失的会话时，pi 印的是
`Warning: Could not restore model legacy-import/gpt-5-codex. Using anthropic/claude-opus-4-8`——
`anthropic/claude-opus-4-8` **不在** `models.json` 里，它来自 `PiTuiPty.resolvePiCliLaunchPlan()`
整份拷进去的 `process.env`（`/proc/<pid>/environ` 实测有 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`）。
凭据剥除分支要 `AICLIENT_PI_TRUST_PROJECT_CONFIG === '0'` 才跑，本机是 `1`，没剥。
**发现这件事之后我才加的第二道保险**，并且在 TUI 里先 `/model probe-fake/fake-sonnet` 切回来再打字。

**四、右上角 GUI/TUI 分段开关，真鼠标序列能点动 —— handbook 2.6 那条要改。**
handbook 写「`.click()` 和 `Input.dispatchMouseEvent` 都试过，`aria-pressed` 始终停在 GUI」。
本批**每一次**切换都是先 `getBoundingClientRect()` 取中心点，再发
`mouseMoved → mousePressed → mouseReleased` 三连，`aria-pressed` 每次都翻转，pi 进程随即起来。
本批一共真点了 11 次（含两个窗口），没有一次退回打 IPC。分组的 `aria-label` 是中文 `显示方式`
（不是 handbook 写的 `Presentation mode`），按英文找会找不到。
在终端里敲字也是真键盘：`Input.insertText` + Enter 键事件打进 `.xterm-helper-textarea`。

**五、`ps aux | grep -- --session` 在这台机器上是个空口径。** pi v0.84.4 把进程标题改写成裸
`pi`，就地覆盖了内核 argv 区，`/proc/<pid>/cmdline` 只剩 `"pi" + NUL 填充`。改用两个口径：
argv 区**字节数**（246 B = 带 `--session`，148 B = 不带，两个数都实测到了），以及
启动 ~300 ms 窗口内用 Node 紧循环抓**逐字 argv**（bash 轮询太慢，第一次尝试 0 命中）。
完整说明与命令在 [dev-D-method-note-proc-title.txt](dev-D/dev-D-method-note-proc-title.txt)。
**检查单第 15 / 16 项的「取证方式」列要按这条改写。**

**六、强杀只用真实 pi**d**。** 停应用一律 `kill <dev.js 的真实 pid>`（从 `ps -eo pid,args` 里精确取，
不是 `$!`——`setsid nohup … &` 给的 `$!` 是已退出的外层 shell，本批第一次收尾就踩了）。
查残留遍历 `/proc/*/cmdline` 精确匹配，判定条件是「argv[0] 恰为 `pi` 且 exe 落在本仓 electron」，
自己的 bash 不可能命中。全程没有用过 `kill -1`、`process.kill(-1)`，也没有用过 `pkill -f`。
起过 3 次 Electron，每次起之前都 `free -m`（available 1857 / 1985 / 2008 MB）。

---

### 一、第 30 项 TUI-1 / H/20 真机一圈（field-nodes）——**亲测 ✅**

**判据**：GUI 跑一回合 → `pi --session` 打开 → 在 TUI 里续聊 → 回 GUI 接得上；
右上角 GUI/TUI 开关那一下也点一次。前后各读一次会话文件并比对头一行与条目链。

**做了什么**：在 ai-client 仓库新建聊天 `session-1789647368097-07petop`，
GUI 发第一句（`textarea` 填字 + 点 `[aria-label="发送消息"]`）→ **真鼠标点 TUI 按钮** →
在内嵌终端里**真键盘**敲第二句 → **真鼠标点 GUI 按钮** → GUI 再发第三句。

**看到了什么**：

| 时点 | 会话文件 | 头一行 | 条目链 |
|---|---|---|---|
| GUI 一回合后 | 1773 B / 6 行 | `{"kind":"header","version":4,…,"type":"session","timestamp":"…"}` | 4 user ← 3；5 assistant(`probe-fake/fake-sonnet`) ← 4 |
| TUI 续聊后 | 2556 B / 8 行 | **未变**（同一行，字节一致） | 6 user ← **5**；7 assistant ← 6 |
| 回 GUI 再发一轮 | 3455 B / 10 行 | 未变 | 8 user ← **7**；9 assistant ← 8 |

- 头一行同时带 `kind:"header",version:4` 和 `type:"session"`，就是 H/20 的双格式互操作头
  （`codec.ts:95-101` 的 `interopHeader`），**pi 与本仓 worker 轮流往同一份文件追加，谁都没有重写它**。
- 条目链**严格单链、无分叉、无重复**：TUI 那两条（6/7，`kind` 字段缺省，是 pi 自己写的 v3 形状）
  接在 GUI 最后一条 assistant 之后；GUI 第三轮又接在 TUI 最后一条之后。
  快照三份 + 链路三份都在证据目录（`dev-30-sessionA-*`）。
- 回 GUI 后时间线六条消息顺序正确（[dev-30-03-back-in-gui.png](dev-D/dev-30-03-back-in-gui.png)），
  `messages` 里 TUI 那两条以 `h:` 前缀（历史）出现，新一轮以 `user-send-…` 出现，没有重复。
- 内嵌 TUI 里状态栏显示 `(probe-fake) fake-sonnet`，说明它是从会话文件自己读出的模型，
  不是 CLI 参数（`PiTuiPty` 从不传 `--model`，实测 argv 只有 4 个元素）。

**`reloadSessionFromDisk` 耗时**：**日志里拿不到**。main.log、按天日志、dev.js 标准输出
三处在整个往返期间 `reload|tui|handover` 一行都没有（偏移前后对比，见
[dev-30-reload-timing.txt](dev-D/dev-30-reload-timing.txt)）。改在渲染层直接给
`chat.reloadSession` 计时，连测三次 **24 / 22 / 25 ms**，预算是 60 000 ms（`createPiWorkerSlot.ts:57`），
用掉 0.04%。真点 GUI 按钮那一下到 composer 重新出现是 **1.33 s**（含 suspend + reload + 切面）。

**结论 ✅**：判据全部成立。附带两条要记：判据里「耗时从 main.log / dev.log 拿」的口径不成立（见「判据问题」一）。

---

### 二、第 14 项 TUI 模式下切换会话 / terminal-03（terminal-tui）——**亲测 ✅（附一条新缺陷）**

**判据**：切到另一个聊天后终端画面是否仍是上一个聊天的 pi 会话；在终端里敲一句话后它落进哪个 JSONL。
对照 T048 `8dd1b65d`「会话级 terminal id」的意图。

**做了什么**：同仓库两个聊天——A = `session-1789647368097-07petop`（上一节那条，已有 3 轮），
B = `session-1789647839178-q40z4vd`（新建并跑了一轮）。在 B 上进 TUI，然后**真鼠标点侧栏**切到 A，
在终端里敲一句带指纹的话，再 grep 两个会话文件。

**看到了什么**：

- 切到 A 之后，终端画面换成了 **A 自己的 pi 会话**（屏幕上是 A 的三轮对话，
  [dev-14-screen-after-switch-to-chatA.txt](dev-D/dev-14-screen-after-switch-to-chatA.txt)），
  不是 B 的。`piTui.status()` 返回两个 terminalId，`/proc` 里两个 pi 进程并存，
  argv 字节数都是 246（各带自己的 `--session`）。
- 敲的那句 `devD14 这句话敲在切到聊天A之后`：**A 的文件从 10 行 3455 B 涨到 12 行 4256 B 并命中 1 次；
  B 的文件 6 行 1762 B 一个字节都没动、grep 0 次。**
- 两个终端的上下文计数也对得上（A 侧 `↑48 ↓36`，B 侧 `↑12 ↓9`），不是同一个 PTY 换了标签。

**结论 ✅**：T048 的「一个聊天一个 terminal id」在真机上成立，旧 bug（画面留在上一个聊天、
打的字落进上一个聊天的 JSONL）没有复现。

**但是切回去的画面是空白的 —— 新缺陷 D17。** 从 A 再切回 B（或反过来），终端区变成**全黑、35 行全空**，
而 PTY 还活着：`piTui.status()` 仍列着它、`/proc` 里进程在、我敲的 `hello` 通过
`piTui.onData` 收到了 143 字节回显（确实是 B 的终端 id）。
用 `piTui.resize(id, 70, 20)` 逼 pi 重绘一次，整屏立刻回来
（[dev-14-03-chatB-after-forced-repaint.png](dev-D/dev-14-03-chatB-after-forced-repaint.png)）。
成因在 `PiTuiPty.ts:307-308`：`replayBuffer` 只累积**挂起期间**产生的输出，而挂起的 pi 空闲不产出，
于是 resume 时 `replayBuffer` 是空的、`:265-268` 什么都不发；渲染层这边 `id` 变化让 xterm
整个重建（`useXterm.ts:861-897` 的清理 + 重新 `initTerminal`），新实例回滚缓冲区是空的。
**两头都对，接缝上没人负责重绘。** A→B 与 B→A 两个方向各复现一次。

---

### 三、第 15 项 终端复活丢 sessionFile / terminal-04（terminal-tui）——**亲测 ✅（判据不成立＝防御有效）**

**判据**：让 pi 快速失败后，终端是否变成一个空白新会话（第二次 spawn 的 argv 里没有 `--session`）。

**先说一件检查单没料到的事：按检查单写的「临时改坏模型配置」，pi 不会快速失败。**
把 `models.json` 写成非法 JSON 后起 TUI，pi **照常起来并一直活着**，只是在正文区印一条可读的错：

```
Error: models.json error: Failed to parse models.json: Unexpected token 'B', ..."be-fake": BROKEN_ON_"... is not valid JSON
File: /home/ai/.pilab/jyw-ai-client-dev/pi-agent/models.json
```

（[dev-15-01-no-session-chat.png](dev-D/dev-15-01-no-session-chat.png)）。它接着用环境变量里的
`ANTHROPIC_*` 兜到 `claude-opus-4-8` 上继续待命。所以这条路根本到不了「复活」分支。
（顺带：这一次的对话是刚新建、`runtimeIdentity` 还是空的，抓到的 argv **确实没有 `--session`**，
argvBytes=148 —— 这是「设计内的无会话形态」，也给了字节数口径的实测基线，
见 [dev-15-argv-control-no-runtimeidentity.txt](dev-D/dev-15-argv-control-no-runtimeidentity.txt)。）

**换成真的能让 pi 秒退的旋钮**：把 `--session` 指向的 JSONL 首行写坏。离线试出来的：
`Error: Session file is not a valid pi session: <path>`，退出码 1，毫秒级。
这条路比改模型配置更贴 terminal-04 的题意——失败正是**因为那个 `--session` 参数**。
`piTui.sessionSupport()` 对这份文件返回 `{"supported":true}`（`piTuiSession.ts:159-171` 的
「解析失败一律放行」），所以它真的会被交给 pi。

**做了什么**：在这样一条会话上点 TUI（spawn #1）→ pi 秒退、应用自动切回 GUI →
再点一次 TUI（spawn #2）。两次都用 Node 紧循环抓逐字 argv。

**看到了什么**（[dev-15-argv-both-spawns.txt](dev-D/dev-15-argv-both-spawns.txt)）：

```
### pid=450137  argvBytes=245   argv[2]=--session  argv[3]=…/session-devd32-missing-model.jsonl
### pid=450283  argvBytes=245   argv[2]=--session  argv[3]=…/session-devd32-missing-model.jsonl
```

- **第二次 spawn 的 argv 里有 `--session`，而且是同一份文件。** 不是空白新会话。
- 会话目录里**没有**多出任何新 `.jsonl`（`find -newermt` 只列出那一份被我改坏的）。
- `PI_TUI_EXIT` 事件带 `{exitCode:1, signal:0, sessionFile:"…"}`，渲染层弹
  `Pi TUI closed / Returned to the GUI session.` 并强制切回 GUI，`aria-pressed` 回到 GUI。
- PTY 状态事件是 `live → dead`，两次相隔 373 ms。

**结论 ✅（判据描述的坏形态不复现）**：`useXterm.ts:987-992` 那条防御（复活时始终把
`activeSession.runtimeIdentity` 带上）在真机上有效。唯一会出现「没有 `--session`」的情形是
`runtimeIdentity` 本来就没有（新对话还没发过第一句），那是设计内行为，本节第一段已经实测记录。

**顺带撞到两件事**：① 整条 pi TUI 生命周期（spawn / 退出 / 退出码）在 main.log、按天日志、
dev.js 输出三处**一行日志都没有**——与 D4/D8/D10/D14 同族；
② 那张截图上同时出现了中文的「会话历史已损坏」卡片**和**一条裸英文错误条
（`Error: Error invoking remote method 'chat:resumeSession': WorkerSlotError: session_invalid: …`），
两个面都在说同一件事，英文那条没人翻译；`Pi TUI closed` 这条 toast 也是英文
（`usePresentationSwitch.ts:220-224` 写死的英文串，没走 i18n）。

---

### 四、第 16 项 两个窗口对同一会话开终端（terminal-tui）——**亲测 ⛔（能出现，且会静默分叉）**

**判据**：是否能出现两个 `pi --session <同一文件>` 进程。

**第二个窗口怎么开的（要记一笔）**：`文件 → 新建窗口` 是 Electron 应用菜单项，
`CommandOrControl+N`。CDP 注入的键盘事件**打不到**它——菜单加速键在 Linux 上由原生窗口消费，
不经过渲染层；本机又没有 xdotool / wmctrl / python-xlib。
最后走的是**主进程 node inspector**（`node scripts/dev.js … --inspect=9444`），
在主进程里取出真实的应用菜单并调用那一项自己的 click handler：

```js
Menu.getApplicationMenu().items.find(i => i.label === '文件')
  .submenu.items.find(i => i.label === '新建窗口').click();
```

**这是产品自己的 `handleNewWindow` 代码路径**（`MenuBuilder.ts:56-60` → `index.ts:789-791`），
只是触发方式从鼠标换成了程序调用。`BrowserWindow.getAllWindows()` 从 1 变 2，CDP 也多了一个 page target。

**做了什么**：两个窗口都选中同一个聊天 `session-1789647368097-07petop`，各自真点 TUI；
两次 spawn 都用紧循环抓了逐字 argv；然后在两个终端里各敲一句带指纹的话。

**看到了什么**：

- **两个 `pi --session <同一文件>` 进程并存**，逐字 argv 两份都在证据里
  （[dev-16-argv-window1.txt](dev-D/dev-16-argv-window1.txt) /
  [dev-16-argv-window2.txt](dev-D/dev-16-argv-window2.txt)），
  `argv[3]` 两份完全一致：`…/sessions/session-1789647368097-07petop.jsonl`。
- **界面上没有任何提示、没有拒绝、没有降级**。`sessionGuard.transferTo()` 走的是「总是转移」，
  而 `PiTuiPtyController` 是按 `windowId` 分的（`piTui.ts:43`），两个窗口互相看不见对方的 `#live`。
- **`writer.lock` 帮不上忙**：整个过程锁一直在，holder 是 GUI worker（`pid 408197`，utility 进程，
  确认存活），内容见 [dev-16-writer-lock-during.json](dev-D/dev-16-writer-lock-during.json)。
  两个 pi 谁都没去碰它——`piTui.ts:121` 的注释「the pi CLI never takes the worker's writer lock」
  在这里就是字面意思。
- **后果是会话树被静默分叉**（[dev-16-shared-session-chain.txt](dev-D/dev-16-shared-session-chain.txt)）：

  ```
  11 assistant 7c1df411 ← a108c76c
  12 user      55d609c5 ← 7c1df411      ← 窗口二敲的
  13 assistant cedbfa7a ← 55d609c5
  14 user      9e6b67ce ← 7c1df411      ← 窗口一敲的，父节点同上
  15 assistant 9e037faf ← 9e6b67ce
  ```

  两个 pi 各自在 open 时读了一次文件、各自把自己那轮挂在**同一个叶子**上，于是一份 JSONL 里
  出现两条并行分支。文件只有这一份（`grep -rl` 全目录只命中它），两句话都在里面。

**结论 ⛔**：判据问的「是否能出现」——**能**，这就是当前行为。前置说明第 4 节从代码读出的预期
在真机上完全兑现，而且拿到了代码读不出来的那一半：**分叉的具体形态**（同一 parentId 两个子节点）
与**全程零提示**。记为缺陷 D18。

**顺带**：第二个窗口点关闭时弹的是「确认退出 / 确定要退出应用吗？」
（[dev-16-03-second-window-close-prompts-quit.png](dev-D/dev-16-03-second-window-close-prompts-quit.png)），
关一个窗口问的却是退不退整个应用。不在本批六项判据内，只记一笔。

---

### 五、第 31 项 H/19 验证案例 7（h-nodes）——**亲测 ✅**

**判据**：GUI 与内嵌 TUI 都能列出迁移/导入后的历史会话；在 TUI 里续聊一轮再回 GUI，历史接得上。

**做了什么**：从批次 C 留下的 42 条导入会话里挑
`T032 bulk rollout #014 2026-09-10 topic=theme`
（索引行 `session-import-codex-efb78fb7-…`，文件
`import-codex-fe0da04f-5267-4e74-acab-4cbd62250e01.jsonl`）。
GUI 打开看历史 → 进 TUI → 续聊一轮 → 回 GUI 看历史。

**看到了什么**：

| 环节 | 结果 |
|---|---|
| GUI 列出 / 打开 | ✅ 侧栏按 title 可辨，时间线 6 条消息，正文与 padding 都在（[dev-31-01](dev-D/dev-31-01-imported-session-in-gui.png)） |
| `piTui.sessionSupport()` | `{"supported":true}` —— 导入文件的头一行已带 `type:"session"`，守卫放行 |
| 内嵌 TUI 打开 | ✅ pi 把导入的历史整段渲染出来（[dev-31-02](dev-D/dev-31-02-imported-in-tui.png)） |
| pi CLI **列出** | ✅ `pi --session-dir <应用会话目录> --resume` 列出 66 条，导入会话在列（[dev-31-pi-resume-listing.txt](dev-D/dev-31-pi-resume-listing.txt)）。这一步是独立跑 CLI 做的，内嵌 TUI 本身不走 `--resume` |
| TUI 续聊一轮 | ✅ 文件 8 行 4799 B → 13 行 6023 B |
| 回 GUI | ✅ 时间线 8 条，TUI 那一轮接在导入历史后面（[dev-31-04](dev-D/dev-31-04-back-in-gui-history-continues.png)） |

条目链前后对比（`dev-31-imported-chain-*.txt`）：TUI 追加的
`8 thinking_level_change → 9 model_change → 10 thinking_level_change → 11 user → 12 assistant`
一条不落地挂在原来的最后一条 assistant（`c2466d53`）之后，单链无分叉。

**一个必须记下的前提**：导入会话里助手消息记的是 `legacy-import/gpt-5-codex`，这个 provider
本应用目录里没有。pi 打开时印
`Warning: Could not restore model legacy-import/gpt-5-codex. Using anthropic/claude-opus-4-8`
并自动顶上一个模型。我**没有**就这么续聊（那会打真网关），先在 TUI 里 `/model probe-fake/fake-sonnet`
切到假网关，屏幕上出现 `Model: fake-sonnet`、状态栏变 `(probe-fake) fake-sonnet` 之后才敲字。
这件事本身是第 32 项的现象，见下一节。

**结论 ✅**：判据三句话（GUI 能列、TUI 能列/开、续聊后回 GUI 接得上）全部成立。

---

### 六、第 32 项 H/21 内嵌 TUI 模型缺失覆盖层（h-nodes）——**亲测：TUI 侧 ✅，GUI 侧 ⛔**

**判据**：打开一条模型已被迁移覆盖的旧会话，**TUI 侧同样**给出可读的「模型缺失」提示而不是裸错误。
取证方式要求 GUI 侧截覆盖层文案、TUI 侧截 pi 的提示原文。

**做了什么**：按前置说明第 6.3 条造会话——复制一份真实会话，在末尾追加一条
`model_change`（`provider: "vllmproxy-old"`, `modelId: "claude-does-not-exist"`，
`parentId` 指向当时的最后一条），落进 `sessions/` 并补一行索引。头一行不动，守卫照常放行。

**TUI 侧（判据正面）✅**：

```
Warning: Could not restore model vllmproxy-old/claude-does-not-exist. Using
anthropic/claude-opus-4-8
```

一条完整的黄色警告，换行正确、没有被截断或吞掉
（[dev-32-04-tui-model-missing.png](dev-D/dev-32-04-tui-model-missing.png)、
[dev-32-tui-screen-model-missing.txt](dev-D/dev-32-tui-screen-model-missing.txt)）。
**这是 pi 自带的英文提示，本仓没有做二次包装**，与前置说明第 6.2 节的读码结论一致。
同一条提示在第 31 项的导入会话上也出现过一次，两次形态一致。

**GUI 侧（对照面）⛔ —— 这才是本项真正的发现。**
同一条会话在 GUI 里发一句，看到的是一条**裸英文错误条**：

```
Error: no model "vllmproxy-old/claude-does-not-exist" in the catalog (1 available)
```

（[dev-32-03-gui-send-model-missing.png](dev-D/dev-32-03-gui-send-model-missing.png)）
H/21 P0 那套中文覆盖层（`本应用没有这个模型` / `这个会话记录的模型不在本应用的模型目录里…` /
`去 Pi 设置补上模型`）**一个字都没出现**。查了原因：

- `isModelMissingError()`（`modelMissingError.ts:34-37`）只认两个信号：
  `WORKER_MODEL_NOT_FOUND` 这个码，或子串 `Pi model not found`。
- 全仓 `grep -a`：`WORKER_MODEL_NOT_FOUND` **只在 `src/runtime/worker/nativeUtility.ts:167,186`**
  抛出，那是**工具/目录查询**那条 utility 路径；`Pi model not found` 这个字符串在 `src/` 里
  **已经没有任何生产抛出点**，只剩注释、这个匹配常量本身和单测。
- 而会话真正跑起来时报错的是
  `src/runtime/plugins/model-adapter/index.ts:77`
  的 `no model "<provider>/<id>" in the catalog (<n> available)` —— 两个信号都不带。

**所以 H/21 的中文覆盖层在当前会话路径上是够不着的死分支。** 记为缺陷 D19。
（这与批次 A1 的 D3 同源但不是同一件事：D3 说的是「选择器和 worker 读的目录不是同一份」，
D19 说的是「模型缺失时该显示的那张中文卡片，匹配条件已经和运行时实际抛的错对不上了」。）

**另外两条只在 GUI 侧出现的可读线索**：composer 的模型芯片显示
`vllmproxy-old/claude-does-not-exist · unverified`；把会话文件首行改坏时（第 15 项那次）
中文的「会话历史已损坏」卡片是正常出的。也就是说 `historyError.ts` 那套还活着，
只有 `modelMissingError.ts` 这套断了。

**结论**：判据那句「TUI 侧同样给出可读的模型缺失提示而不是裸错误」**成立 ✅**；
但取证方式要求的「GUI 侧截覆盖层文案」**截不到**——GUI 侧现在给的恰恰是裸错误 ⛔。
本项整体判 ⚠️：正面判据过，对照面塌了。

---

### 判据问题

**一、第 30 项「记录 `reloadSessionFromDisk` 耗时（main.log / dev.log）」拿不到数。**
三处日志在整个 GUI↔TUI 往返期间零行。建议把取证方式改成「在渲染层给
`window.electronAPI.chat.reloadSession` 计时」，并把「补一行 reload 日志」并进 D4/D8/D10/D14
那个可观测性小修包。本批实测值 22～25 ms / 预算 60 s。

**二、第 15 项「临时改坏模型配置起 TUI」达不到判据要的「pi 快速失败」。**
实测 pi 只印一条可读错误并继续活着。建议把取证方式改成「把 `--session` 指向的 JSONL 首行改坏」——
那是实测可秒退、且失败原因正好落在 `--session` 上的旋钮。同时判据里的「第二次 spawn」
要写清楚是**哪条**复活路径：pi 自己退出走的是 `handleTuiExit`（丢 id、切回 GUI、再进是新 id），
与 `useXterm.ts:971-995` 那条「挂起的 PTY 被驱逐后重开」不是同一条，本批验的是前者。

**三、第 15 / 16 项的「`ps aux` 过滤 `--session`」是空口径。** pi 改写进程标题后
`/proc/<pid>/cmdline` 只剩 `pi`。建议改成「argv 区字节数 + 启动窗口内抓 argv」，
方法与实测基线见 [dev-D-method-note-proc-title.txt](dev-D/dev-D-method-note-proc-title.txt)。

**四、第 32 项只写了「TUI 侧同样给出可读提示」，没写 GUI 侧要对照到什么。**
取证方式里有「GUI 侧截覆盖层文案」，但判据句里没有它，照判据字面读这项是 ✅、照取证方式读是 ⛔。
建议把判据补成两句：「GUI 侧出 H/21 中文覆盖层」+「TUI 侧出 pi 自带的可读提示」，
否则 D19 这种「中文卡片死掉了」的回归会从判据缝里漏过去。

**五、handbook 2.6「右上角 GUI/TUI 开关 CDP 驱动不了」要改。**
真鼠标序列（`getBoundingClientRect` 取中心 + `mouseMoved/mousePressed/mouseReleased`）本批 11 次
全部成功。原来失败很可能是按英文 `Presentation mode` 找分组（实际 `aria-label` 是中文 `显示方式`）
或没先滚动到视口。`MODEL-48` 那条「必须用户手点」的注记可以放宽为「真鼠标序列即可」。

---

### 疑似缺陷清单（已追加到 /tmp/t032/defects.md，编号接 D16）

| 本页编号 | defects.md | 来源项 | 一句话 |
|---|---|---|---|
| A | **D17** | 第 14 项 | TUI 模式下切回一个曾被挂起的聊天，终端整屏空白；PTY 活着、键盘也通，只是没人让 pi 重绘（`replayBuffer` 只存挂起期间的输出，而空闲的 pi 不产出）。`piTui.resize` 逼一次重绘即恢复 |
| B | **D18** | 第 16 项 | 两个窗口能同时对同一份会话 JSONL 开 `pi --session`，无提示无拦截；两个 pi 各挂在同一个叶子上，把会话树静默分叉成两支。`writer.lock` 由 GUI worker 持有，对 pi 不设防 |
| C | **D19** | 第 32 项 | H/21 的「本应用没有这个模型」中文覆盖层已经触发不到：`isModelMissingError()` 认 `WORKER_MODEL_NOT_FOUND` / `Pi model not found`，而会话路径实际抛的是 `no model "…" in the catalog (N available)`；后者两个信号都不带 |

另记三条更轻的（未单独编号，随上面几条一起处理即可）：
① pi TUI 的 spawn / 退出 / 退出码三处日志全无（D4/D8/D10/D14 同族）；
② `Pi TUI closed / Returned to the GUI session.` 与会话损坏那条错误条是英文，中文界面里没走 i18n；
③ 关第二个窗口弹的是「确认退出整个应用」。

---

### 本批的环境交代（逐条还原证据）

- **起过 3 次 Electron**，每次起前 `free -m`（available 1857 / 1985 / 2008 MB，存档
  `dev-D-free-before-launch{1,2,3}.txt`）。每次收尾 `kill <dev.js 真实 pid>` 后遍历
  `/proc/*/cmdline` 复扫：`dev.js` / `electron-vite` / electron / esbuild / pi 全部消失，
  9333 / 5173 / 9444 / 18080 四个端口全部释放。收工时 available **1986 MB**。
  **未跑 vitest、未跑 `pnpm build`、未跑 `pnpm build:agent-host`。**
- **产品代码零改动。** 收工 `git status --short` 与接手时逐行一致，只多出
  `evidence/batch-e-devbox-2026-09-17/dev-D/`（本批证据）一个未跟踪目录。
- **`pi-agent` 三份物理文件已按备份逐字节还原**，sha256 三条全部与改动前一致：
  `models.json` `35257b8d…`、`auth.json` `8d106c13…`、pi 自己的 `settings.json` `30d4e841…`。
  （本批把 `models.json`/`auth.json` 换成过「只有 `probe-fake`」的版本，第 15 项还把
  `models.json` 写成过非法 JSON。）
- **凭据库已还原并核对**：`register-fake-provider.mjs --restore
  vault.json.bak-2026-09-17T12-09-47-036Z` 执行完毕，`vault.json` 从明文的 469 B 回到加密原件的
  **1042 B**，字段回到 `version:2 / enc:"none" / userProvidersEnc:"safeStorage"`、
  `userProviders` 是加密字符串。备份文件**没有删**，留在
  `~/.pilab/jyw-ai-client-dev/credentials/`（现在那儿有两份 1042 B 的 `.bak-`，
  一份是批次 B 留的，一份是本批留的，内容都与现文件一致，后面的批次别当异常）。
- **应用设置已还原**：`chatAgentDefaults` **键已删除**（本批把它设成过
  `{"model":"probe-fake/fake-sonnet"}`，批次 B 收尾时它已经是不存在的状态，所以删掉是回到原状）；
  `presentationMode` 回到 `gui`（本批中途它被持久化成过 `tui`，第三次起应用时应用就是直接开在
  TUI 模式的）。与批次 B 收尾备份逐键对比：**键集合完全一致**，值只有
  `branchNameGenerator` / `codeReview` / `commitMessageGenerator` 三项各多了一个空的
  `"model": ""` —— 那是设置 store 自己的字段补齐，不是我写的。
- **渲染层 localStorage**：`aiclient:chat:session-models` 本批写过一条
  （给第 32 项那条探针会话钉 `vllmproxy-old/claude-does-not-exist`），**已删除**，
  整个键因为空了而被移除（接手前它就是空的 `{}`，A1 批次清过一次）。
- **dev.env 原件一字未动**（sha256 `3efcf677…`，mtime 仍是 9-11）。本批用的是副本
  `/tmp/t032/dev.env.devD-safe`（只改 `ANTHROPIC_BASE_URL` 一行指向假网关，键集合 diff 为空），
  经 `AICLIENT_DEV_ENV_FILE` 生效，**副本已删除**。
- **第 32 项造的探针会话已清干净**：`sessions/session-devd32-missing-model.jsonl`（及其
  `.writer.lock`）已删除，`session-index.json` 里那一行也已摘掉（167 → 166 行）。
  改坏之前的原样存档在 [dev-15-target-session-before-corruption.jsonl](dev-D/dev-15-target-session-before-corruption.jsonl)。
- **临时物已清**：`/tmp/t032/d-pre/`（离线试 pi 行为用的临时 agentDir 与探针会话）已删除；
  假网关进程已按真实 pid 杀掉，18080 已释放。
- **留在机器上的新增物**（点验动作的正常产物，没有清理）：
  ① 本批三条探针会话的 JSONL 与索引行——`session-1789647368097-07petop`（devD30，含
  TUI 追加与第 16 项两个窗口写出的那两支分叉，**这份文件本身就是 D18 的现场证据**）、
  `session-1789647839178-q40z4vd`（devD14 聊天 B）、以及三次启动各自自动新建的空会话；
  ② **批次 C 的导入会话 `import-codex-fe0da04f-…` 被第 31 项续聊了一轮**（8 行 → 13 行），
  这是判据要求的动作，不是污染，但后面的批次若要复用这条样本要知道它已经不是导入原样了。

## 十二、需起 Electron 的第五组：恢复失败文案 + F4 观感 + 卡片视觉口径 + TEMP /new 矩阵（dev-E1）

证据目录 [dev-E1](dev-E1/)。分支 `feat/runtime-evolution`，dev 模式（userData = `~/.config/jyw-ai-client-dev`）。

本批做的是检查单[第四节「开发机」表](../../checklist-e.md)的第 17 / 24 / 25 / 29 行，
对应 `agent-host-lib` 的 ah-lib-03，以及 `field-nodes` 的 F4 GUI 观感、F7a/F7c 视觉口径、
GUI A/10 TEMP `/new` 矩阵。

**四项全部亲测**，没有任何一项是从别人的证据回推的。

---

### 本批的五条方法学注记

**一、一句真模型都没发。** `maxapi` / `cx2` / `vllmproxy` 一次都没碰。全程只用本地假网关
`/tmp/t032/fake-gateway.mjs`（监听 `127.0.0.1:18080`），经凭据库里的自定义服务 `probe-fake`
接进 GUI，`settings.json` 的 `chatAgentDefaults.model` 临时设成 `probe-fake/fake-sonnet`。
两次起应用都走仓库原件 `dev.env`（没有用副本），因为本批不需要改 `ANTHROPIC_BASE_URL`——
所有回合都由 `chatAgentDefaults` 指到 `probe-fake`，网关日志逐条可核（[dev-24-gui-observations.txt](dev-E1/dev-24-gui-observations.txt) 末尾）。

**二、`register-fake-provider.mjs` 的 wire id 问题已就地修掉。** 批次 D 的方法学注记第二条记了
「脚本写进 vault 的是 `name: "Fake Gateway"`，而 `userProviderId()` 取 `name` 做 slug，于是 worker
侧只有 `fake-gateway/fake-sonnet`」。本批把脚本第 118 行改成 `name: id`（脚本在 `/tmp`，不是仓库），
并留了注释说明理由；改完 `--id probe-fake` 写出来的服务名就是 `probe-fake`，
`chatAgentDefaults.model = probe-fake/fake-sonnet` 一次对上，不再需要事后手改 vault。
原件备份在 `/tmp/t032/register-fake-provider.mjs.orig-before-E1`。

**三、假网关新增了一个 `ask-question` plan（第 25 项需要）。** 先 grep 出问答工具的真名与 input 形状
（`src/runtime/plugins/tools/ask.ts:118` 工具名 `ask`，`ASK_PARAMETERS` 要求
`{questions:[{question, header?, options:[{label, description?}]}]}`，每题 2～4 个选项），
照着写进 plan，`curl` 自测确认 SSE 帧里的 `input_json_delta` 拼回来是合法 JSON，再接进 GUI。
原件备份在 `/tmp/t032/fake-gateway.mjs.orig-before-E1`。

**四、`/new` 要按两次回车，第一次是补全不是提交。** composer 里打 `/new` 会弹斜杠菜单，
第一下 Enter 被菜单吃掉、把输入补成 `"/new "`（带尾空格），第二下才真的执行。
更早一次我用 `keyDown + char + keyUp` 三连，`char` 事件直接往 textarea 里插了个换行
（值变成 `"/new \n"`），命令没跑。**驱动斜杠命令只发 `keyDown`/`keyUp`，不要发 `char`，而且要发两次。**

**五、强杀只用真实 pid。** 停应用一律从 `ps -eo pid,args` 里精确取 `node scripts/dev.js …` 的真实 pid
再 `kill`；查残留遍历 `/proc/*/cmdline`。全程没有用过 `kill -1`、`process.kill(-1)`，也没有用过 `pkill -f`。
起过 2 次 Electron，每次起之前都 `free -m`（available 1952 / 1960 MB）。

---

### 一、第 17 项 三种恢复失败的界面文案 / ah-lib-03（agent-host-lib）——**亲测 ✅**

**判据**：分别看到「Session history is damaged（不可重试）」「History not found（此对话无法继续）」
「Session belongs to another workspace」，而不是三次都看到「Failed to read history（可以继续发送）」。

**做了什么**：从一条真实会话 `sessions/session-1789647839178-q40z4vd.jsonl`（6 行）克隆出三份夹具，
各加一条 `session-index.json` 索引行（`workspacePath` 都指 `/home/ai/code/ai-client`，所以三条都出现在
ai-client 仓库分组下）：

- ① `session-e117a-corrupt.jsonl`：在**中段**（第 4 条与第一条 user 消息之间）插 65 行非 JSON，
  比 `MAX_SKIPPED_ROWS = 64`（`codec.ts:50`）多一行，正好踩中 `codec.ts:451` 的拒绝；
- ② `session-e117b-missing`：索引行留着、JSONL 删掉；
- ③ `session-e117c-cwd.jsonl`：把头一行的 `cwd` 改成 `/home/ai/code/test`，
  踩 `store.ts:217-220` 的 `header.cwd !== realpath(config.cwd)`。

三条都是**真鼠标点侧栏那一行**打开的（`getBoundingClientRect` 取中心 + `mouseMoved/mousePressed/mouseReleased`）。

**看到了什么**（完整逐字文案与错误串在 [dev-17-three-resume-failures.txt](dev-E1/dev-17-three-resume-failures.txt)）：

| 情形 | store 里的码 | 卡片标题 | 续行提示 | 按钮 |
|---|---|---|---|---|
| ① 65 行坏 JSON | `session_file_corrupt: … session_invalid: more than 64 unparseable rows, first at line 5` | **会话历史已损坏** | 请保留原文件用于恢复；新建会话后再继续工作。 | 只有「详情」，**没有重试** |
| ② 文件缺失 | `jsonl_not_found: … ENOENT … realpath '…/session-e117b-missing.jsonl'` | **未找到历史** | 该会话已无法继续：历史记录缺失后，继续发送会失败；请新建会话继续工作。 | 只有「详情」 |
| ③ 工作区不符 | `session_cwd_mismatch: … resume cwd differs from the session workspace` | **该会话属于另一个工作区** | 请从该会话原本的工作区打开，或新建会话继续。 | 只有「详情」 |

三条英文键逐条对上（`historyError.ts:187-305` 的 `CODE_COPY` + `i18n.ts` 的 2720 / 2668 / 2719 行），
**没有一条落到兜底的「读取历史失败」**（那条是 `retryable: true` 且提示「会话未中断，可以继续发送消息。」）。
截图 [dev-17-01](dev-E1/dev-17-01-corrupt-card.png) / [dev-17-02](dev-E1/dev-17-02-missing-card.png) /
[dev-17-03](dev-E1/dev-17-03-cwd-mismatch-card.png)。

**顺手撞到的一条（不是缺陷，是夹具怎么造的关键）**：②的第一版索引行**没有 `piLeaf`**，
点开后**一张错误卡都不出**，时间线显示「No messages yet.」、worker 正常起来了。
原因在 `src/main/ipc/chat.ts:449` 的 `isUnwrittenPiSession(row)`（定义在 `:67-74`）：
`runtimeIdentity` 有、`piLeaf` 没有、文件 `stat` 不到 ⇒ 判定成「pi 从来没写过的幽灵身份」，
走「修复而非恢复」分支，清掉 `runtimeIdentity` 后 `createSession`；而 worker 给新会话起的文件名是
`<agentDir>/sessions/<logicalSessionId>.jsonl`（`nativeWorkerRuntime.ts:994-996`），**正好又落回同一个路径**。
实测磁盘上多出一份 188 字节、uuid 全新（`83ca5185-…`）的空头文件。这是设计内行为
（注释写得很清楚），但它意味着**验 `jsonl_not_found` 的夹具必须带 `piLeaf`**，否则验的是另一条分支。
第二次起应用时补上 `piLeaf` 才拿到上表②那一行。

**另一条观察**：①的卡片说「新建会话后再继续工作」，但 composer **并没有被禁用**——
往输入框里打字之后 `[aria-label="发送消息"]` 就可点。卡片不可重试与输入框仍可发送是两回事，
判据只问文案，这里只作记录。

**结论 ✅**：判据三条全部成立，ah-lib-03 那三个曾经「写了但从未触发」的死分支现在都真的能触发、
且各自出各自的文案。

---

### 二、第 24 项 F4 的 GUI 观感（field-nodes）——**亲测 ✅**

**判据**：重试期间时间线出现重试提示；预算耗尽后错误卡文案完整可读且带网关原文。

**做了什么**：`AICLIENT_RUNTIME_TRACE_DIR=/tmp/t032/trace-e1` 随 `dev.js` 一起 export（trace 默认不落盘），
然后两轮：网关 `--plan retry-503`（两次 503 后成功）跑一回合，每秒截一次图 + 抓一次时间线文本，共 20 拍；
网关 `--plan retry-503-forever`（每次都 503，message 里带 `FAKE_GATEWAY_OVERLOADED_MARKER`）跑一回合，
每 2 秒一拍，共 27 拍，直到预算耗尽。

**看到了什么**（逐拍文本在 [dev-24-retry-log.json](dev-E1/dev-24-retry-log.json) 与
[dev-24-forever-log.json](dev-E1/dev-24-forever-log.json)，综述在 [dev-24-gui-observations.txt](dev-E1/dev-24-gui-observations.txt)）：

- **重试提示确实在时间线里**，是一行带转圈图标的横幅（`MessageTimeline.tsx:1710` 的 `<RetryBanner>`）：
  `Upstream error 503 — retrying 1/3, the turn is still running` + 一个 `Details` 折叠；
  composer 那边**另有一条中文倒计时**「正在重试 · 1/3 · 3 秒后重试 · 0s」。两条同时在屏上。
- **节奏与代码常量对齐**：3 s → 10 s → 30 s，四次尝试共 43 s
  （`providerRetry.ts:52` 的 `PROVIDER_RETRY_DELAYS_MS` 与 `:62` 的 `MAX_RETRIES = 3`）。
  网关请求日志四条的时间差是 +3.0 / +10.0 / +30.0 秒，第五次请求没有发生。
- **第一轮第 15.3 秒**横幅消失、助手回复 `fake gateway ok` 正常渲染，回合完成。
- **第二轮第 46 秒**横幅消失，屏上留下：
  `Error: 503 {"type":"error","error":{"type":"overloaded_error","message":"FAKE_GATEWAY_OVERLOADED_MARKER fake overloaded #4"}}`
  —— **网关原文一字不差，marker 在**。可读性是量出来的不是看出来的：这个块是
  `max-h-28 overflow-auto … font-mono text-code whitespace-pre-wrap break-all`，
  实测 `scrollHeight 47 == clientHeight 47`、`scrollWidth 718 == clientWidth 718`，**没有截断、不需要滚动**。
- **trace 里有、日志里没有**：`runs.jsonl` 两轮共 5 条 `provider_retry`
  （`{"event":"provider_retry","code":"PROVIDER_ERROR","attempt":n,"delay_ms":…,"providerStatus":503}`），
  而 `main.log` / 按天日志 / `dev.js` 标准输出三处 `grep -icE 'provider_retry|overloaded'` 全是 **0**。

**结论 ✅**：判据两条都成立。附两条要记：横幅文案是英文硬编码（缺陷 D21）；
预算耗尽后用户拿到的只有一个裸 mono 块，没有标题 / 下一步 / 重试按钮（见「判据问题」二）。

---

### 三、第 25 项 F7a/F7c 视觉口径（field-nodes）——**亲测 ✅（几何在档，字重不在档）**

**判据**：权限卡与问答卡的尺寸、字号、间距按 `docs/design-system.md` 的 Token 分档复核并留截图。

**做了什么**：先读完 `design-system.md` 的六张分档表（圆角 / Squircle / 阴影 / 字号 / 字重 / 字距 / 间距 / 动画）。
权限卡用 `--plan write-approval` 触发（模型调 `write` 工具写 `probe-write.txt`），**先量再作答**；
问答卡用本批新增的 `--plan ask-question` 触发（模型调 `ask` 工具，一题三选项各带描述）。
两张卡各用 CDP 遍历卡片根节点下的全部后代，逐个取 `getComputedStyle` 的 23 个属性
（字号 / 字重 / 行高 / 字距 / 字族 / 四向 padding / gap / 圆角 / 阴影 / 边框 / 高度 / 颜色 / 过渡时长）。
原始 dump：[权限卡](dev-E1/dev-25-permission-card-computed.json)（21 个节点）、
[问答卡](dev-E1/dev-25-question-card-computed.json)（113 个节点）。逐项对表在
[dev-25-token-audit.md](dev-E1/dev-25-token-audit.md)。

**看到了什么（摘要）**：

- **在档的**：两张卡的容器都是 `rounded-md` = **10px** + 1px 边框 + **零阴影**（正合 §Shadow
  「需要浮起感时靠 `border` + `bg-card`，不要补阴影」）；圆角全场只出现 4 / 6 / 10 / 50 四个值，
  其中 50px 是 §Squircle 写明的超椭圆基线，6px 只用在 `h-6`(24px) 的小控件上——正是钳制硬规则第 1 条要的；
  字号只有 12（路径、错误块，`--text-code` + `font-mono`）/ 13（`--text-meta`）/ 14（`--text-ui`）三档，
  没有任意值；间距主干是 4 / 8 / 12；过渡一律 **150ms**；倒计时带 `tabular-nums`；
  两处 `font-mono` 都显式写了 `tracking-normal`（§Letter-spacing 的 mono 禁令）。
- **不在档的（唯一一维系统性偏差：字重）**：两张卡的标题层级**全部**靠 `font-medium`(500)——
  权限卡的段头「权限」与卡标题「write — 写入工作区文件」是 14px/500，
  问答卡的 `Questions` 段头、问题正文、选项标题同样 14px/500，选项**描述**还从按钮基类继承了 13px/**500**。
  分档表把「卡片 / 对话框 / 段落标题」判给 `font-semibold`(600)、把「描述 / 占位文本」判给 `font-normal`(400)，
  并写了硬约束「500 不得作为任何层级区分的唯一载体」，理由就是 Win10 的 Segoe UI 静态族没有 500。→ 缺陷 D23。
- **轻微不在档**：两处 10px——权限卡内容块的 `p-2.5`、问答卡选项行的 `gap-2.5`，不在 4 / 8 / 12 档上。
- **文案**：问答卡整片英文（`Questions` / `Other…` / `Skip` / `Continue` / `Ctrl + Enter`），
  紧挨着的权限卡每一句都过了 `t()`。→ 缺陷 D20。顺带发现 `QuestionItem.header` 声明了却全链路无人渲染 → 缺陷 D22。

截图：[权限卡](dev-E1/dev-25-01-permission-card.png)、[问答卡](dev-E1/dev-25-03-question-card.png)、
[问答卡作答后](dev-E1/dev-25-04-question-answered.png)。

**回合怎么收的**：问答卡点了选项 B 再点 `Continue`，网关收到 `[tool_result:… 先量问答卡]` 并回 `turn finished`，
回合正常结束。权限卡那一张量的时间超过了它自己的 120 秒预算，被**自动拒绝**收尾
（网关收到 `[tool_result:nobody answered the permission request in time]`），
所以 `probe-write.txt` 从未被写出来——仓库里没有这个文件，`git status` 也证实了。

**结论 ✅**：判据「按 Token 分档复核并留截图」完成。几何 / 字号 / 间距 / 动画 / 阴影全部在档，
偏差集中在字重一维（D23）与问答卡的 i18n（D20）。

---

### 四、第 29 项 GUI A/10 TEMP `/new` 矩阵（field-nodes）——**亲测 ✅**

**判据**：从普通目录、TEMP 会话、无工作区三种起点各开 `/new`，cwd 继承结果逐格记录。

**做了什么**：先 grep 出实现——`/new` 是**本窗口自己的动作**，不发给模型
（`slashCommands.ts:47-51` 的 `BUILTIN_SLASH_COMMANDS`），`ChatComposer.tsx:846` 调
`createChatSessionInCurrentDirectory()`（`stores/chatSessionActions.ts:70-93`），
cwd 继承逻辑就这十来行：当前会话的 `workspaceId` 还在 `workspaces` 里 ⇒ 在同一工作区建；
否则建一条 unbound 会话，并把 `current.unbound?.workspacePath ?? scratchWorkspaceStore.pathFor(current.id)`
抄给新会话。

三种起点都真机造：① 用 `node scripts/dev.js --open-path=/tmp/t032/ws-normal` 注册一个临时目录当仓库，
点它的「新建对话」；② 侧栏「临时对话」分组**右键 →「新建临时对话」**，先发一句让 scratch 目录分配下来；
③ 同样右键新建一条临时对话，但**不发消息**（这一步就是「无工作区」：`workspaceId` 空、`unbound` 未写、scratch 未分配）。
每格都在 composer 里打 `/new` + 两次回车，然后读 store（`chatSessions` + `scratchWorkspace`）与
`session-index.json` 两侧。

**看到了什么**（结构化结果在 [dev-29-new-matrix.json](dev-E1/dev-29-new-matrix.json)）：

| 起点 | 起点的 cwd | `/new` 后新会话 | 继承结果 |
|---|---|---|---|
| ① 绑定普通目录（`/tmp/t032/ws-normal`） | `workspaceId = ws:main:/tmp/t032/ws-normal` | 同一个 `workspaceId`，索引行 `workspacePath = /tmp/t032/ws-normal` | **继承同一工作区** |
| ② TEMP 会话（scratch 已分配） | `unbound-sessions/46766010-…` | `unbound.workspacePath = unbound-sessions/46766010-…`（**同一个目录**），索引行也是这个路径且 `unbound: true` | **继承同一个 scratch 目录，两条会话共用一个目录**（磁盘上确认只有这一个目录） |
| ③ 无工作区（从未发过消息） | 无 workspace、无 scratch | `workspaceId` 空、`unbound` 未写、scratch 仍为 null；首次发送后自己分配了一个**新**目录 `unbound-sessions/79f89e05-…` | **没有可继承的 cwd**，新分配 |

三格都与代码读出的预期一致：①走 `createChatSessionOnWorkspace`，②走 `inheritedPath` 的第二个分支
（`scratchWorkspaceStore.pathFor`，因为 TEMP 起点的 `session.unbound` 在 store 里是 `null`，
真正记着路径的是 scratch store 与索引行），③两个来源都空所以不写 `unbound.workspacePath`。

**结论 ✅**：三格逐格记录完成。②那格值得单独标一句：`/new` 之后是**两条聊天共用一个 scratch 目录**，
不是各开各的；这在「删除某条临时会话的目录」这类操作上会牵连到另一条（与 DEV-27 / T037 那条线相关，本批不展开）。

---

### 判据问题

**一、第 17 项的取证方式要补一句「索引行必须带 `piLeaf`」。** 现在写的是「删掉会话文件但保留索引行」，
按字面做出来的夹具会掉进 `isUnwrittenPiSession` 的「修复」分支，一张错误卡都不出、
还会在原路径上重建一个空会话文件——验不到 `jsonl_not_found`。见本页第一节末尾。

**二、第 24 项「错误卡」这个词与实物不符。** 预算耗尽后屏上没有 `role="alert"` 的卡片，
只有一个 `font-mono text-code` 的红色错误块，没有标题、没有下一步、没有重试按钮
（对照第 17 项那三张有标题有引导的卡）。判据要的「完整可读 + 带网关原文」两条都成立，
但如果本意是「像第 17 项那样的一张卡」，那现状是不满足的。建议把判据写清楚要的是哪一种，
或者单独立一条「重试预算耗尽应给标题与下一步」。

**三、第 25 项「尺寸、字号、间距」漏了字重。** 本批唯一一维系统性偏差恰好落在字重上（D23），
而且它在 Linux 上完全看不出来、只有到 Windows 才会显形。建议把这一项的判据补成
「圆角 / 阴影 / 字号 / **字重** / 间距 / 动画」六维，并注明字重那一维要在 Win10 上复拍。

**四、第 29 项的「无工作区」与「TEMP 会话」在当前实现里是同一条会话的两个阶段。**
`temporaryWorkspaceEnabled=true` 时，「不选文件夹的聊天」就是一条 unbound 会话，
发第一句之后它才拿到 scratch 目录、才在侧栏落进「临时对话」分组。所以这两格的差别不是「两种会话」，
而是「`inheritedPath` 有没有值」。建议把这两格的描述改成「TEMP 会话（已发过消息，scratch 已分配）」与
「TEMP 会话（从未发送，scratch 未分配）」，否则下一个人会去找一个并不存在的第三种会话类型。

---

### 疑似缺陷清单（已追加到 /tmp/t032/defects.md，编号接 D19）

| 本页编号 | defects.md | 来源项 | 一句话 |
|---|---|---|---|
| A | **D20** | 第 25 项 | 问答卡整张卡的固定文案没走 i18n（`Questions` / `Other…` / `Skip` / `Continue` / `Ctrl + Enter` 全是裸常量），而同一文件里的权限卡变体每一句都过了 `t()`；中文界面里两张卡并排，一张全中文一张全英文 |
| B | **D21** | 第 24 项 | 时间线重试横幅的标题与 `Details` 是英文模板字符串（`retryBanner.ts:107-108`、`MessageTimeline.tsx:1838`），而正下方 composer 的同一件事是中文「正在重试 · 1/3 · 3 秒后重试」 |
| C | **D22** | 第 25 项 | `QuestionItem.header` 声明了但全链路无人渲染：runtime 的 ask 工具照收照传，渲染层两个文件 grep `.header` 零命中；实测发了 `header:"点验顺序"`，卡上找不到这四个字 |
| D | **D23** | 第 25 项 | 两张卡的标题层级全部靠 `font-medium`(500)，选项描述还继承了 500；分档表把卡片 / 段落标题判给 `font-semibold`、把描述判给 `font-normal`，硬约束写明「500 不得作为层级区分的唯一载体」，因为 Win10 上 500 会降到 400 —— 下一站正好是 Windows 机 |

另记两条更轻的（未单独编号）：
① `provider_retry` 在 `main.log` / 按天日志 / `dev.js` 标准输出三处 grep 计数均为 0，
重试只在需要手动 export `AICLIENT_RUNTIME_TRACE_DIR` 的 trace 里可见，与 D4/D8/D10/D14 同族；
② 重试预算耗尽后用户看到的只有一个裸 mono 错误块（见「判据问题」二）。

---

### 本批的环境交代（逐条还原证据）

- **起过 2 次 Electron**，每次起前 `free -m`（available **1952 / 1960 MB**，存档
  `/tmp/t032/e1-free-before-launch{1,2}.txt`）。两次都用真实 pid `kill <dev.js pid>` 收尾，
  之后遍历 `/proc/*/cmdline` 复扫：`dev.js` / `electron-vite` / electron / esbuild / 假网关全部消失，
  9333 / 5173 / 18080 三个端口全部释放。收工时 available **2001 MB**。
  **未跑 vitest、未跑 `pnpm build`、未跑 `pnpm build:agent-host`。**
- **产品代码零改动。** 收工 `git status --short` 与接手时逐行一致，只多出
  `evidence/batch-e-devbox-2026-09-17/dev-E1/`（本批证据）一个未跟踪目录。
- **凭据库已还原并核对**：`register-fake-provider.mjs --restore
  vault.json.bak-2026-09-17T13-21-35-816Z` 执行完毕。`vault.json` 从明文的 467 B 回到加密原件的
  **1042 B**，sha256 **`7200ffebd23157d96d2b2d835d10cdf2090bfa19da3fd4508e0f72ae091565f8`**
  与动手前逐字节一致，字段回到 `version:2 / enc:"none" / userProvidersEnc:"safeStorage"`、
  `userProviders` 是加密字符串。备份文件没有删，留在 `~/.pilab/jyw-ai-client-dev/credentials/`
  （现在那儿有三份 1042 B 的 `.bak-`：批次 B、批次 D、本批各一份，内容都与现文件一致，后面的批次别当异常）。
- **应用设置已还原**：`chatAgentDefaults` **键已删除**（本批把它设成过 `{"model":"probe-fake/fake-sonnet"}`，
  接手时它是不存在的状态，所以删掉是回到原状）。与接手前备份 `/tmp/t032/e1-settings.json.bak-before`
  逐键对比：**顶层键集合完全一致**；三处嵌套差异是应用自己写的——
  `branchNameGenerator` / `codeReview` / `commitMessageGenerator` 这一轮各**少**了一个空的 `"model": ""`
  （批次 D 收尾时记的是各**多**一个，方向相反），是设置 store 自己的字段补齐/收敛，不是我写的。
  `presentationMode` 全程是 `gui`，`temporaryWorkspaceEnabled` 全程是 `true`（A1 打开的，按 A1 的交代保留不动）。
- **`pi-agent` 的三份物理文件一个字节都没动**（本批全程走 vault 这条路，没有走 TUI）：
  `models.json` sha256 `35257b8d…`、`auth.json` `8d106c13…`，mtime 都还是 9-11，与批次 D 收尾时记的两条哈希一致。
- **dev.env 原件一字未动**（sha256 `3efcf677…`，mtime 仍是 9-11）。本批**没有**用 dev.env 副本，
  也没有设 `AICLIENT_DEV_ENV_FILE`；唯一额外的环境变量是 `AICLIENT_RUNTIME_TRACE_DIR=/tmp/t032/trace-e1`。
- **造的坏会话与索引行已清干净**：三条夹具（`session-e117a-corrupt` / `session-e117b-missing` /
  `session-e117c-cwd`）与第 29 项的五条探针会话（起点 1 / 新会话 1 / 起点 2 / 新会话 2 / 新会话 3）
  的 JSONL、`.writer.lock` 与索引行全部删除。与接手前的索引备份 `/tmp/t032/e1-session-index.json.bak-before`
  对比：**没有任何一行被删**，只**新增 4 行**——
  `E1-24 重试观感探针` / `E1-24 预算耗尽探针` / `E1-25 权限卡视觉口径` / `E1-25 问答卡视觉口径`，
  这四条是第 24 / 25 项的现场记录（会话文件里就是那两轮 503 与那两张卡的真实回合），**刻意留着当证据**。
  索引 166 行 → 170 行。
- **临时目录已清**：`--open-path` 注册的 `/tmp/t032/ws-normal` 仓库**走界面右键「移除仓库」→ 确认**摘掉了，
  store 里的 `projects` / `workspaces` 已回到只剩 `ai-client` 一条；随后 `/tmp/t032/ws-normal` 与
  `/tmp/t032/ws-other` 两个目录本身也删了。第 29 项分配出来的两个 scratch 目录
  （`~/JYWAI/temporary/unbound-sessions/46766010-…` 与 `79f89e05-…`）手工删除，
  `unbound-sessions/` 现在是空目录。
  （注记：这两个目录在 `kill <dev.js pid>` 之后**仍然在**——SIGTERM 不是「从界面正常退出」，
  `wipeAll()` 没跑到。这不是缺陷，正常退出的清理归第 26 项验；记在这里是免得下一个人把它当异常。）
- **`probe-write.txt` 从未落地**：权限卡是被自动拒绝收尾的，工具没执行，仓库里没有这个文件。
- **改过的两个 `/tmp` 脚本**（都不在仓库里）：`register-fake-provider.mjs`（`name: id`，方法学注记二）与
  `fake-gateway.mjs`（新增 `ask-question` plan，方法学注记三），各留了 `.orig-before-E1` 原件备份。
  新建的驱动脚本 `/tmp/t032/e1-drive.mjs`、测量脚本 `/tmp/t032/e1-measure.js` 供后续批次复用。
- **留在机器上的新增物**（点验动作的正常产物）：上面说的 4 条 E1-24 / E1-25 会话及其 JSONL；
  trace 文件 `/tmp/t032/trace-e1/runs.jsonl`（已复制一份进证据目录 `dev-E1-trace-runs.jsonl`，
  已核对不含任何密钥形状的字符串）。

## 十三、需起 Electron 的第六组：附件 GUI 半边 + Main IPC 附件校验 + 能力面板文案 + 多样路径文件点击（dev-E2）

证据目录 [dev-E2](dev-E2/)。分支 `feat/runtime-evolution`，dev 模式（userData = `~/.config/jyw-ai-client-dev`）。

本批做的是检查单[第四节「开发机」表](../../checklist-e.md)的第 33 / 34 行，
外加[第 2.4 节](../../checklist-e.md#24-审计静态推断项的现场确认)的 DEV-36（cutover-03）与
[第 2.5 节](../../checklist-e.md#25-旧树里未被覆盖的其余现场项)的 DEV-37（旧树 GUI A/7）。

**四项全部亲测**，没有任何一项是从别人的证据回推的。

---

### 本批的五条方法学注记

**一、一句真模型都没发。** `maxapi` / `cx2` / `vllmproxy` 一次都没碰。全程只用本地假网关
`/tmp/t032/fake-gateway.mjs --port 18080 --plan text`，经凭据库里的自定义服务 `probe-fake`
接进 GUI，`settings.json` 的 `aiclient-settings.state.chatAgentDefaults` 临时设成
`{"model":"probe-fake/fake-sonnet"}`。两次起应用都走仓库原件 `dev.env`（没有用副本）。
网关请求计数逐条对得上：4 条附件消息 = 4 次，第 5 条被拒 = 计数不动，
DEV-34 的 A 案被拒 = 计数不动、B 案通过 = 计数 +1。

**二、Composer 的附件入口点不进去，只能走 paste。** 任务书里写的
「找到 `input[type=file]`，用 `DOM.setFileInputFiles` 挂图」在本仓**做不到**：
渲染层全文没有 `input[type=file]`，⊕ 菜单的「Attach files」调的是
`window.electronAPI.dialog.openFiles()`（`ChatComposer.tsx:1091`）——一个 CDP 驱动不了的
**原生系统对话框**；而绕过它直接调 `file:readAttachment` 会被
`PickedAttachmentAccess` 的一次性授权挡掉（返回 `not-allowed`，`main/ipc/files.ts:21,533`）。
所以改走 Composer 的**另一个真入口**：往 textarea 派一个带真 `File` 对象的
`ClipboardEvent('paste')`，落在 `useComposerAttachments.handlePaste` → `planPaste` →
`ingestFiles` 上——**和 ⊕ 挑文件后走的是同一条 `ingestFiles` 管线、同一套预算**，
差别只在字节从哪来。图片字节用 1 MiB 一段的 base64 分块注进页面，
再在页面里用 `crypto.subtle.digest` 算 SHA-256 与 Node 侧逐字节比对（两张都一致）。

**三、两张图的尺寸是算出来的，不是估的。** 按 `sessionAttachmentFill.test.ts` 顶部那套算术：
5,242,000 B → base64 6,989,336 字符，1,040,000 B → 1,386,668，合计 **8,376,004**，
落在 `ATTACHMENT_TURN_STORED_BYTES` = 8,388,608 之内（余 12,604 B）；
落盘后单行 8,376,397 B，落在 `SESSION_MAX_ENTRY_BYTES` = 8,388,608 之内（余 12,211 B）；
四行合计 33,505,589 B，加上头行与四条回复（846 + 2,505 B）正好 33,508,940 B，
落在 `SESSION_MAX_BYTES` = 33,554,432 之内（余 45,492 B）。
PNG 用 `zlib.deflateSync(raw, {level:0})` 存储块生成（1024×5112 与 512×2025 灰度，
都远小于 `MAX_IMAGE_EDGE_PX` = 8000），最后几个字节用一个 `tEXt` 块补到**精确**目标大小，
CRC 全部校验通过、`file(1)` 认得。生成器 `/tmp/t032/e2-make-png.mjs`，
尺寸账 `dev-33-assets-sizes.json`。

**四、日志要等应用退出再看，当场 grep 会得出相反结论。** 第 5 条被拒当场、两次纯文本被吞当场、
DEV-34 两条 payload 发完当场，三处日志 grep 计数**全 0**；直到 `kill <dev.js pid>` 之后，
Main 的 `crashed: Worker exited (code=15 …); last N stderr line(s):` 才把 worker 的 stderr
回放出来，那几条 `session_size_limit` / `attachment_size_limit` 这时候才出现在按天日志里
（`main.log` 始终 0 行）。我第一版结论写的是「三处全 0」，是收尾复查才发现要订正。
**下一个人别在事发当时 grep 完就下结论。**

**五、强杀只用真实 pid。** 停应用一律从 `ps -eo pid,args` 里精确取 `node scripts/dev.js …`
的真实 pid 再 `kill`；停网关同理。查残留遍历 `/proc/*/cmdline`。全程没有用过 `kill -1`、
`process.kill(-1)`，也没有用过 `pkill -f`。起过 2 次 Electron，每次起之前都 `free -m`
（available 1715 / 1868 MB）；第 33 项开始灌附件之前又量了一次（**1233 MB**，高于任务书要求的 900 MB）。

---

### 一、第 33 项 附件顶满会话文件后的端到端表现（capacity-leftovers）——**亲测 ✅**

**判据**（2026-09-17 改写版）：连续发送 4 条「1 张 ≈5 MiB 图 + 1 张 ≈1 MiB 图」的消息后，
会话文件停在 32 MiB 以内（≈31.9 MiB）；第 5 条发送被拒，界面给出会话超预算类错误；
重开该会话正常打开（不抛 `io_limit`）。另记两态：被拒后同一会话能否继续发纯文本；重开应用后能否恢复。

**做了什么**：在 ai-client 仓库下新建一条会话 `session-1789655267185-g85qdok`，
每一条消息都用上面注记二的办法挂两张图（composer 上真的出现
`big-5mib.png 5.0 MB` / `small-1mib.png 1015.6 KB` 两个附件片），
填一句中文再点 `[aria-label="发送消息"]`，每条发完读一次会话 JSONL 的字节数。

**观察到什么**（完整表见 [dev-33-bytes-table.md](dev-E2/dev-33-bytes-table.md)）：

| 发送 | 结果 | 会话文件字节 | MiB |
|---|---|---|---|
| 1 | 成功 | 8,377,869 | 7.989 |
| 2 | 成功 | 16,754,892 | 15.978 |
| 3 | 成功 | 25,131,915 | 23.968 |
| 4 | 成功 | **33,508,940** | **31.957** |
| 5 | **被拒** | 33,508,940（未变） | 31.957 |

- **四条之后 31.957 MiB，判据说的「≈31.9 MiB」逐字命中**，离 32 MiB 还差 45,492 B。
  每条附件消息的实际增量恒为 8,377,023 B。
- **第 5 条被拒**，界面上是 composer 上方一个红色 mono 块，原文
  `Error: session exceeds the configured size budget`
  （`mb-2 max-h-28 … font-mono text-code text-destructive`，`ChatComposer.tsx:3066`）。
  假网关计数停在 4，模型侧从未被调用；附件片留在 composer 里没被吃掉。
  **「会话超预算类错误」成立**，但它是一个裸英文 mono 块，不是带标题/下一步的卡片
  ——和第 24 项 E1 记的那个块是同一个规格（见「判据问题」二）。
- **重开该会话正常 ✅**：退出应用、重新起、点侧栏那条会话，`historyErrors` 为空、
  没有 `io_limit`、4 轮历史全部回来、worker 正常绑上。
  这与 `sessionAttachmentFill.test.ts` 的结论一致：本 store 写出的文件永远 ≤ 32 MiB，
  `io_limit` 经产品路径够不着。
- **两态另记**：
  - **被拒后同一会话不能继续发纯文本，而且是完全静默的** ⛔。清掉附件、打一句纯文本、
    点发送，输入框被清空（说明 `runSend` 真的跑了），但时间线不出现消息、不出现错误、
    网关收不到请求、文件不长一个字节；连试 3 次全一样。**这是新缺陷 D24。**
  - **退出重开后恢复 ✅**：同一条会话发纯文本立刻成功，网关计数 +1，文件 +933 B。

**结论 ✅**：四条判据分句（≤32 MiB / 第 5 条被拒 / 有超预算错误 / 重开不抛 io_limit）
全部成立。两个另记项里，「重开后恢复」成立，「被拒后能否继续发纯文本」是**不能，且无声**。

---

### 二、第 34 项 Main IPC 层缺失附件校验的直接验证（capacity-leftovers）——**亲测 ✅**

**判据**：绕开 Composer 直接向 `CHAT_SEND` 传超限 attachments payload，
确认 Main 不拒绝、请求原样送达 worker。

**做了什么**：新建一条会话，先用一条普通消息把 worker 绑上，
再在渲染层直接调 `window.electronAPI.chat.send(payload)` 两次
（payload 形状见手册 4.2 / `main/ipc/chat.ts:507-521`）。完整记录见
[dev-34-summary.md](dev-E2/dev-34-summary.md)。

**观察到什么**：

| 案 | payload | Main | worker |
|---|---|---|---|
| A 单图超字节 | 1 张，base64 9,786,712 字符（7,340,034 原始字节，是 5 MiB 上限的 1.4 倍） | **不拒绝**，70 ms 返回 `{"requestId":"send-1789656669843-5"}`，未抛错 | 拒：`attachment "huge-7mib.png" is 7340034 bytes; the limit is 5242880 bytes per attachment`，code `attachment_size_limit`（`attachments.ts:103-108`） |
| B 六张图超条数 | 6 张，每张 200,000 原始字节（`maxCount` = 5） | **不拒绝**，18 ms 返回 requestId | **接受**。会话 JSONL 第 6 行写进 `text + image×6`，假网关计数 +1，时间线显示六个附件片 |

**judge：Main 原样放行。** 两种 payload 都没有任何长度 / 字节 / 条数检查，与
`attachments.ts:22-36` 注释里那句 "the IPC hop carries `attachments` through preload,
the chat handler and the worker bridge without a single byte check" 逐字相符。
顺带把一件事看清楚了：**字节这一维 runtime 兜住了，条数这一维两侧都没人兜**
——「一条消息最多 5 个附件」只活在渲染层的 `admitAttachment` 里。
实际风险被每条 8 MiB 的落盘上限压住，所以我没给它单独编号，只记在缺陷表的附注里。

**结论 ✅**：判据要的「确认这个缺口存在」成立，两种形态各留了 Main 返回值、
worker 终态、store 快照、时间线原文与截图。

---

### 三、DEV-36 cutover-03：native 下「能力」面板与插件页文案（审计静态推断项）——**亲测 ⚠️**

**判据**：侧栏「能力」面板列出 native runtime 自己的 MCP / 技能 / 子代理
（「未报告」与「报零」两态可区分）；插件设置页的权限归属文案是
「本应用自带权限系统审批每个对话，你装的 pi 权限扩展只影响内嵌终端」。

**做了什么**：同一条会话在两个时点各开一次侧栏「能力」（rail `[aria-label="能力"]`），
再开设置 → Pi 翻到插件分区，DOM 原文与判据逐字比对。详见
[dev-36-summary.md](dev-E2/dev-36-summary.md)。

**观察到什么**：

- **能力面板两态可区分 ✅**。会话未启动时整张面板只有一句
  「发送一条消息启动这个对话后，才能看到它启用了什么。」，一行数字都没有；
  跑过一回合后列出「MCP 服务 = 暂无 MCP 服务器 / 技能 = 6 / 提示词模板 = 0 / 子智能体 = 4」，
  底下补一句「你安装的 pi 扩展只会被内嵌终端加载。」。
  列的确实是 native runtime 自己报的东西，不是 pi 扩展列表——cutover-03 要的就是这条。
  （用词注记：判据写「未报告」，实现里 `t('Not reported')` 的译文是「**未上报**」，
  `i18n.ts:2361`；本机四行都有 producer，这一档没被触发到。）
- **插件页文案只出现了判据的前半句** ⚠️。实物是一个 info 色卡：
  「本应用的每个对话，都由它自带的权限系统审批工具调用。」——无条件显示。
  判据后半句对应的那句「你自己安装的 pi 权限系统只对内嵌终端生效，管不到本应用里的对话。」
  **在本机不显示**，因为它只在 `owner === 'user_configured' | 'unknown'` 时才渲染
  （`PiPluginsSettings.tsx:255`），而本机「暂无已安装插件」。
  同一页顶上的分区说明「装在你账户下的扩展。只有内嵌的 Pi 终端会加载它们，
  本应用里的对话不会。」已经无条件把这层意思讲了一遍。

**结论 ⚠️**：能力面板那半句完全成立；插件页那半句**在没装 pi 权限扩展的机器上验不到**，
这是实现的条件分支、不是缺陷，但判据照字面读会判负。见「判据问题」一。

---

### 四、DEV-37 GUI A/7 多样路径下的文件点击与编辑器（旧树未覆盖项）——**亲测 ✅**

**判据**：含空格、中文、超长、软链四类路径的文件点击后编辑器正确打开并定位。

**做了什么**：造工作区 `/tmp/t032/ws-paths`（`git init` 过），四个文件内容各不相同、
第一行各带一个可辨识标记；用 `node scripts/dev.js … --open-path=/tmp/t032/ws-paths`
注册仓库（store 里确认 `projects` 多出 `local:/tmp/t032/ws-paths`），
在该仓库下新建会话让工作区生效，点「文件」rail，用**真鼠标事件**逐个点开。
完整记录见 [dev-37-summary.md](dev-E2/dev-37-summary.md)。

**观察到什么**：四类全部正确打开，四个标签页并存时标签栏逐字是
`["a b.ts","文件.ts","deep.ts","link.ts"]`，空格、中文、软链名都没被转义或截断。

| 类别 | 路径 | 内容第一行 | 面包屑 |
|---|---|---|---|
| 含空格 | `dir with space/a b.ts` | `export const SPACE_MARKER = "DEV37-A-space-in-both-names";` | `dir with space / a b.ts` |
| 中文 | `中文目录/文件.ts` | `export const CJK_MARKER = "DEV37-B-中文目录与中文文件名";` | `中文目录 / 文件.ts` |
| 超长 | 八级目录，目录部分 322 字符、全路径 330 字符 | `export const DEEP_MARKER = "DEV37-C-very-long-path";` | 八级逐级列全 + `deep.ts` |
| 软链 | `link.ts -> real/target.ts` | `export const LINK_TARGET_MARKER = "DEV37-D-symlink-target";` | `link.ts`（链接自身，不是解析后的路径） |

四次点击期间按天日志无新增行，`ENOENT|EACCES|failed to read` 计数为 0。

两点实现细节，都不是缺陷，记下来免得下一个人当异常：
① 标签页不是 `role="tab"`，是 `div[role="button"].h-9`，按 `[role="tab"]` 找会一个都找不到、
误判成「没有标签栏」（我第一版就踩了这个，写进 summary 后才订正）；
② 单子目录链会被折叠成一行（VSCode 同款），八级目录在树里是一行，点一次就展开到底。

**结论 ✅**：四类路径全部通过，判据成立。

---

### 判据问题

**一、DEV-36 的后半句在没装 pi 权限扩展的机器上验不到，判据要注明前置条件。**
「你装的 pi 权限扩展只影响内嵌终端」这句对应的实现（`PiPluginsSettings.tsx:253-268`）
是条件渲染的，只在 `permissionSystemOwner` 为 `user_configured` 或 `unknown` 时出现。
本机「暂无已安装插件」，所以只能看到无条件的前半句。建议把判据改成两行：
「① 无条件显示：本应用的每个对话，都由它自带的权限系统审批工具调用。
② 装了 pi 权限扩展时另显示：你自己安装的 pi 权限系统只对内嵌终端生效……」，
并在取证方式里加一步「先 `pi install` 一个权限扩展再看」，否则下一个人会以为这句丢了。

**二、第 33 项的「界面给出会话超预算类错误」与第 24 项是同一个待决问题。**
实物是 composer 上方一个裸英文 mono 红块（`Error: session exceeds the configured size budget`），
没有标题、没有下一步、没有重试按钮，和第 17 项那三张有标题有引导的历史错误卡不是一个规格。
E1 在第 24 项已经提过同一件事。建议把「运行时错误该不该升级成卡片 + 该不该过 i18n」
单独立成一条，别让它在两三个判据里各漏一次。

**三、第 33 项的取证方式写的 `input[type=file]` + `DOM.setFileInputFiles` 在本仓不可执行。**
渲染层没有文件 input，⊕ 走的是原生对话框，`file:readAttachment` 有一次性授权闸。
建议把取证方式改成「往 textarea 派带 `File` 的 `ClipboardEvent('paste')`（Composer 的另一个
真入口，同一条 `ingestFiles` 管线）」，并注明「原生对话框这条 CDP 驱动不了」。

**四、第 33 项漏了一格：「被拒之后这条会话还能不能用」应当明确写成判据，不是「另记」。**
本批测出来的最疼的一条正是这一格（D24：静默死会话），而它现在挂在「另记两态」里，
下一个人完全可能只记一句「不能」就过去。建议升格成判据分句：
「被拒后同一会话继续发纯文本，**要么成功、要么给出可见错误**；静默丢弃判负。」

---

### 疑似缺陷清单（已追加到 /tmp/t032/defects.md，编号接 D23）

| 本页编号 | defects.md | 来源项 | 一句话 |
|---|---|---|---|
| A | **D24** | 第 33 项 | 撞上 `session_size_limit` 之后这条对话在本次运行里变成**静默死会话**：纯文本点发送，输入框清空但时间线什么都不出、网关无请求、文件不长；worker 侧其实每次都真抛了 `session_size_limit`，只是渲染层第一次之后再也不显示；退出重开即恢复。是 D1 在真机 GUI 上的样子，且比 D1 记的多一层「连错误都不给」 |
| B | **D25** | 第 33 项 | 附件**文件名在会话重开后丢失**：发送时是 `big-5mib.png` / `small-1mib.png`，重开后同一位置变成 `image/png` / `image/png`。会话 JSONL 的 image block 只有 `{type,data,mimeType}`，`MessageAttachmentMeta.name` 只活在实时事件里、从不落盘 |
| C | **D26** | 第 33 / 34 项 | Composer 的附件文案整片没走 i18n：`attachmentLimits.ts` 六句用户可见的话全是裸英文模板（本批实拍到 `Attachments total 6.0 MB — sending may take longer.`）；worker 侧拒绝也是英文原文直出（`Error: session exceeds the configured size budget`、`Error: attachment "huge-7mib.png" is 7340034 bytes; …`）。与 D20 / D21 同族同包 |

另记三条更轻的（未单独编号）：
① **拒绝发生时三处日志当场 grep 计数全 0**，`main.log` 更是全程 0 行；那几条
`session_size_limit` / `attachment_size_limit` 只在**杀掉应用**时由 Main 的
`crashed: Worker exited … last N stderr line(s)` 把 worker 的 stderr 回放出来，
还会被 N 截断（第 1 次运行 4 次失败只留下 3 次）。与 D4/D8/D10/D14 同族。
② **移除一个文件面板正开着的仓库时**，`file:list` 把原工作区的绝对路径当相对路径拼到
ai-client 仓库根上（`scandir '/home/ai/code/ai-client//tmp/t032/ws-paths'`，注意双斜杠），
逐级三条 ENOENT；界面无可见症状。发生在本批收尾动作里，不属于四项判据。
③ **「一条消息最多 5 个附件」只有渲染层有**，Main 与 runtime 两侧都没有，
绕开 Composer 发 6 张图会一路通到模型并写进会话文件；实际风险被每条 8 MiB 的落盘上限兜住。

---

### 本批的环境交代（逐条还原证据）

- **起过 2 次 Electron**，每次起前 `free -m`（available **1715 / 1868 MB**，存档
  `/tmp/t032/e2-free-before-launch{1,2}.txt`）；第 33 项灌附件前再量一次
  **1233 MB**（`/tmp/t032/e2-free-before-attachments.txt`），高于任务书要求的 900 MB。
  两次都用真实 pid `kill <dev.js pid>` 收尾，之后遍历 `ps -eo pid,args` 复扫：
  `dev.js` / `electron-vite` / electron / esbuild 全部消失，9333 / 5173 两个端口释放；
  假网关按真实 pid 单杀，18080 释放。收工时 available **1923 MB**。
  **未跑 vitest、未跑 `pnpm build`、未跑 `pnpm build:agent-host`。**
- **产品代码零改动。** 收工 `git status --short` 与接手时逐行一致，只多出
  `evidence/batch-e-devbox-2026-09-17/dev-E2/`（本批证据）一个未跟踪目录。
- **凭据库已还原并核对**：`register-fake-provider.mjs --restore
  vault.json.bak-2026-09-17T14-23-59-443Z` 执行完毕。`vault.json` 从明文的 467 B 回到
  加密原件的 **1042 B**，sha256
  **`7200ffebd23157d96d2b2d835d10cdf2090bfa19da3fd4508e0f72ae091565f8`** 与动手前逐字节一致，
  字段回到 `version:2 / enc:"none" / userProvidersEnc:"safeStorage"`、`userProviders` 是加密字符串。
  备份文件没删，留在 `~/.pilab/jyw-ai-client-dev/credentials/`（现在那儿有四份 1042 B 的
  `.bak-`：批次 B、D、E1、本批各一份，内容都与现文件一致，后面的批次别当异常）。
- **应用设置已还原**：`aiclient-settings.state.chatAgentDefaults` **键已删除**
  （本批把它设成过 `{"model":"probe-fake/fake-sonnet"}`，接手时它是不存在的状态）。
  与接手前备份 `/tmp/t032/e2-settings.json.bak-before` 逐键比对：
  **顶层键集合一致、state 键集合一致、逐键取值差异为空集**（这一轮没有出现 E1/D 记的那种
  `branchNameGenerator` / `codeReview` / `commitMessageGenerator` 空 `"model": ""` 漂移）。
  `presentationMode` 全程 `gui`，`temporaryWorkspaceEnabled` 全程 `true`，
  `defaultTemporaryPath` 全程 `""`。唯一差别是文件缩进（我用 `indent=2` 写回），内容一字不差。
- **`pi-agent` 的三份物理文件一个字节都没动**：`models.json` sha256 `35257b8d…`、
  `auth.json` `8d106c13…`，与批次 D / E1 收尾记的两条哈希一致。
  **dev.env 原件一字未动**（sha256 `3efcf677…`）。本批**没有**用 dev.env 副本、
  没有设 `AICLIENT_DEV_ENV_FILE`，也**没有**设 `AICLIENT_RUNTIME_TRACE_DIR`（本批不需要 trace）。
  前后指纹对照存档 `dev-E2-restore-fingerprints.txt`（四条哈希 `diff` 结果为空）。
- **造的会话与索引行已清干净**：三条探针会话
  （`session-1789655267185-g85qdok` 32 MiB 附件会话 / `session-1789656608127-jy9zhgb` DEV-34 /
  `session-1789656836732-r13kuj3` ws-paths 下那条从未发送的会话）的 JSONL、`.writer.lock`
  与索引行全部删除。与接手前的索引备份 `/tmp/t032/e2-session-index.json.bak-before` 对比：
  **没有任何一行被删、也没有任何一行被留下**，170 行 → 172 行 → 清理后 170 行，
  且逐条内容 `==` 判定与备份完全相同。
  删除前把两条会话的**逐行结构**（行号 / kind / role / content block 类型 / 字节数）
  留档成 `dev-33-34-session-rows.md`，**附件 base64 本体没有进证据目录**。
- **临时工作区已清**：`/tmp/t032/ws-paths` 仓库**走界面「仓库操作 → 移除仓库 → 移除」**摘掉了
  （store 里 `projects` / `workspaces` 回到只剩 ai-client 一条），随后目录本身也 `rm -rf` 了。
  `~/JYWAI/temporary/unbound-sessions/` 收工时是空的。
- **两张探针 PNG** 留在 `/tmp/t032/e2-assets/`（5,242,000 B / 1,040,000 B），
  **没有**复制进证据目录（合计 6 MB 且没有信息量），只把尺寸账
  `dev-33-assets-sizes.json` 归档了，里面有两张图的 sha256，需要复现时用
  `/tmp/t032/e2-make-png.mjs` 一条命令重建、哈希可核。
- **改过的 `/tmp` 脚本**：本批**没有**改 `fake-gateway.mjs` 与 `register-fake-provider.mjs`
  （E1 已经把 wire id 与 `ask-question` plan 补好了，直接用）。新建的
  `/tmp/t032/e2-drive.mjs`（在 E1 驱动上加了 `loadimg` / `paste` / `key` 三个命令）、
  `/tmp/t032/e2-make-png.mjs` 与十来个小探针 JS 供后续批次复用，都不在仓库里。
- **留在机器上的新增物**：无。本批没有产生需要保留的会话、trace 或临时文件。

## 全部完成后的汇总（2026-09-17）

**开发机组 37 项（35 + DEV-36/37）已全部处置完毕。** 结论以各节原文为准（一～十三节逐节核对，不凭印象），按结论归类如下：

- **✅ 通过（28 项）**：DEV-1、DEV-2、DEV-4、DEV-5、DEV-6、DEV-7、DEV-8、DEV-9、DEV-13、DEV-14、DEV-15、DEV-17、DEV-19、DEV-20、DEV-21、DEV-22、DEV-23、DEV-24、DEV-25、DEV-26、DEV-27、DEV-28、DEV-29、DEV-30、DEV-31、DEV-33、DEV-34、DEV-37。
- **⚠️ 部分成立（3 项）**：DEV-11（残留判据成立，文案可理解只算部分成立）、DEV-32（TUI 侧可读提示成立，GUI 侧中文覆盖层触发不到）、DEV-36（能力面板判据成立，插件页判据只验到无条件的前半句）。
- **⛔ 判负 / 复现已知缺陷（3 项）**：DEV-3（兼容根子代理定义删除语义判负）、DEV-10（Codex 子目录不可读时整源静默消失，复现 import-up-01）、DEV-16（两个窗口可同时对同一会话开 `pi --session`，会话树被静默分叉）。
- **⛔ 不可执行（2 项）**：DEV-12（本机无真实旧格式 Codex 样本）、DEV-18（`AICLIENT_NODE24_PATH` 已无生产调用方，属死代码）。
- **🚫 裁决不需人工（2 项）**：DEV-35（已由 `trace.test.ts:350` 的双进程真实竞速用例覆盖）、baseline-01（CI 不在日常 push/PR 上触发测试，已由 workflow 文件静态核实结案）。

**判据修正与裁决共 19 条**（`checklist-e.md` 5.1 判据修正 15 条 + 5.2 不需人工执行裁决 4 条，均为 2026-09-17 新增）：

- 5.1 判据修正：DEV-22（cordis 语义探针判据顺序订正）、DEV-33（附件顶满会话文件判据改写为「4 条顶满 + 第 5 条被拒」）、DEV-11（超限导入阈值改为 4000 条目上限 + 64 MiB 体积上限两档）、DEV-5（fork 未绑定会话判据由「不含 unbound」改为「带 unbound」）、DEV-13（列表渲染判据拆成项目列表 / 会话列表两个数）、DEV-1（归档跑中回合判据改为「回合被中止」形态）、DEV-2（补一格「改设置后新建会话记 scratch 落点」）、DEV-15（终端复活取证方式改为改坏 `--session` 指向的文件）、DEV-32（补全「GUI 侧覆盖层」+「TUI 侧提示」两句判据）、DEV-17（取证方式补「索引行须带 `piLeaf`」）、DEV-24（用词由「错误卡」改为「错误文案」）、DEV-25（视觉口径补「字重」维度）、DEV-29（TEMP 起点命名更正为「已发消息 / 未发消息」两态）、DEV-36（插件页文案拆成无条件句 + 有条件句两行）、DEV-33（附件 GUI 半边：「被拒后能否继续发纯文本」由另记升格为判据分句）。
- 5.2 不需人工执行裁决：DEV-35（🚫 已有自动化覆盖）、baseline-01（🚫 已结案）、concurrency 并发进程数与内存（PKG 组第 12 项，⚠️ 不在开发机做）、DEV-18（⛔ 当前不可执行）。

**疑似缺陷 D1～D26**（完整内容见 `/tmp/t032/defects.md`；本节只写本轮新增的 D24～D26，其余各条见对应批次正文）：

- D24：撞上 `session_size_limit` 拒绝之后，这条会话在本次运行里变成静默死会话——纯文本点发送后输入框清空但时间线不出任何内容、网关收不到请求、文件不长一个字节；worker 侧其实每次都真的抛了 `session_size_limit`，只是渲染层第一次之后不再显示；退出重开即恢复。是 D1 在真机 GUI 上的样子，且多一层「连错误都不给用户看」。
- D25：附件文件名在会话重开后丢失——发送时时间线上是 `big-5mib.png` / `small-1mib.png`，重开同一会话后同样位置变成裸媒体类型 `image/png` / `image/png`；成因是落盘的 image block 只有 `{type,data,mimeType}` 三个键，文件名只活在实时 runtime 事件里、从不落盘。
- D26：Composer 的附件文案整片没走 i18n——`attachmentLimits.ts` 里六句用户可见提示全是裸英文模板，worker 侧的附件超限与会话超预算拒绝也直接抛英文原文；与 D20 / D21 同族同包。

**各批「不单独编号的轻项」合并**：批次 D（dev-D）——pi TUI 的 spawn / 退出 / 退出码三处日志全无（与 D4/D8/D10/D14 同族）；`Pi TUI closed` 与会话损坏错误条是英文，未走 i18n；关闭第二个窗口弹的是「确认退出整个应用」而不是关闭单个窗口。批次 E1（dev-E1）——`provider_retry` 在三处日志里 grep 计数均为 0，仅在手动开启的 trace 文件里可见；重试预算耗尽后用户只看到一个裸 mono 错误块，没有标题、没有下一步、没有重试按钮。批次 E2（dev-E2）——拒绝发生时三处日志当场 grep 全 0，只有杀掉应用后才能从 Main 的 `crashed: Worker exited … last N stderr line(s)` 回放里看到，而且会被行数截断；移除一个文件面板正开着的仓库时 `file:list` 把原工作区的绝对路径当相对路径拼接、产生双斜杠 ENOENT，界面无可见症状；「一条消息最多 5 个附件」这条上限只有渲染层有，Main 与 runtime 两侧都不兜底。

**方法与环境**：

- Electron 累计起过 **20 次**（第一批 0 次 · 第二批 dev-A1 5 次 · 第三批 dev-C 1 次 · 第四批 dev-B 7 次（前任代理 6 次 + 本人 1 次）· 第五批 dev-D 3 次 · 第六批 dev-E1 2 次 · 第七批 dev-E2 2 次），各节「环境交代」逐条留有 `free -m` 前后读数与进程 / 端口复扫结果。
- 模型全程用本地假网关，**唯一例外是第二批 dev-A1**：网关 502 且 worker 侧模型目录里没有 `vllmproxy`，改用真实 provider `maxapi/grok-4.6`（如实记录，未替换成假网关）。
- 每批收尾都逐项核对并还原：凭据库 `vault.json`、`pi-agent` 的 `models.json`/`auth.json`、应用 `settings.json`、探针会话与索引行，均留有改动前后的哈希或逐键 diff。
- 全程**未改动产品代码**：批次内出现的临时改动（如 DEV-4 的协议版本号、两组反向验证）均已复原，并附 sha256 或 `git status --short` 核对。
- 唯一新增的仓库文件是测试用例 `src/runtime/__tests__/sessionAttachmentFill.test.ts`（DEV-33 runtime 半边覆盖）。

- 收口全量 Vitest（Linux 开发机，`pnpm test -- --no-file-parallelism`，Electron 已全部退出后跑）：**413 文件 / 6271 条全部通过，退出码 0，237.55 s**，存档 [closeout-vitest-full.txt](closeout-vitest-full.txt)。对比 T059 收口 411 / 6268（当时 2 failed 是开机时长相关），本次 +2 文件：`pluginGraphIncomplete.test.ts`（已提交 `dff51c0d`）与 `sessionAttachmentFill.test.ts`（本轮新增，未提交）。
- 工具归档：[tools/](tools/)（环境手册 handbook.md、假网关 fake-gateway.mjs、凭据库注册 register-fake-provider.mjs、cdp-eval.mjs、批次 D 前置 batch-d-prereqs.md、导入样本生成 samples/）；缺陷清单快照 [defects-ledger.md](defects-ledger.md)（D1～D26，排修归属见 roadmap 批次 D4，逐条处置见该文件末尾的处置表）。
- 后续：本轮产出的 D1～D26 已由**批次 D4 九项修补（T060～T068）**处置完毕并经两轮真机复验（2026-09-17，未提交），落地记录、三组一审、两份二审、两轮复验读数与截图见[批次 D4 证据](../batch-d4-fixes-2026-09-17/README.md)。
