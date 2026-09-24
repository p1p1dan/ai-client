# 批次 M 证据：代码审查修复与 v1.0.2 子代理工具死循环（2026-09-24）

Role: evidence。记录 `feat/ctrl-enter-interject` 分支收口时的审查处置、线上事故分析与收口验证。任务见 [roadmap 批次 M](../roadmap.md)（T118～T127），决策见 [041](../decisions/041-interject-does-not-wait-for-background-delegates.md) / [042](../decisions/042-delegation-tool-loop-guard.md) / [043](../decisions/043-thought-folded-and-interrupted-turns-open.md)。开发机 GUI 点验另见 [interject-branch-devbox-2026-09-24](interject-branch-devbox-2026-09-24/)。

## 1. 分支与提交

分支 `feat/ctrl-enter-interject` 从 main `c7a3f89a`（1.0.2）分出。原有 9 个提交（`20f172da` 过程行可看全程、`0a836f27` 插话、`a5d2059d` 底部状态栏、`a86cefa4` 字号上调、`9f6963e2` skipMerged、`e23c6c1a` 目标栏三栏、`d2938de7` 插话补齐、`e1bf87b3` 插话单测、`f267d52f` 交接单）之上，收口新增 6 个提交（均未推送）：

| 提交 | 内容 | 任务 |
|---|---|---|
| `4a964c7d` | fix(chat): Ctrl+Enter 插话不再被后台子代理挡住，发送前检查与 Enter 统一 | T118 |
| `568233a4` | fix(chat): 分支栏切换后即时刷新，补齐锁与显示条件 | T119 |
| `6e85aff2` | fix(chat): 运行中工具行显示计时，过程区只对被打断的回合默认展开 | T120 |
| `645c65a0` | style: 中文注释改为英文（只改注释） | T123 |
| `4be46769` | docs(design): 字号分档表同步到上调一档后的实际值 | T121 |
| `46789042` | fix(runtime): 子代理工具死循环防护 | T122 |

提交拆分方式：死循环修复代理动手前把要改的文件完整备份，前几批修复的中间状态因此能按文件原样暂存，每个提交只含一件事；`bootstrap.ts` 按 hunk 拆分（开关两处归 T122，dispose 先 drain 一处归 T118）。

## 2. 代码审查 15 条的处置

审查对象是上面 9 个原提交（49 个文件）。审查只跑了根目录 `tsc`，收口时补跑 runtime / agent-host 两套，另发现两处**原提交就带着**的测试类型错误（`interject.test.ts` 的启动选项写成了不存在的 `workspace`，导致该组测试里 `read` 工具从未注册；`piWorkerRpcServer.test.ts` 的桩缺 `interject`），已随 `4a964c7d` 修复。

| # | 问题 | 处置 | 提交 |
|---|---|---|---|
| 1 | 运行中工具行的「已耗时 / 上限」在 `deriveToolGroupRows` 被丢掉，界面从不显示 | 传递计时；新增经渲染路径的测试 | `6e85aff2` |
| 2 | 有后台子代理时插话不生效（收集循环不看插话标志） | 插话即交付，子代理跨运行继续，TaskWait 可被打断（决策 041） | `4a964c7d` |
| 3 | 无最终回答的已结束回合过程区被强制展开、收不起来 | 改用回合结束原因；默认展开与强制展开分开（决策 043） | `6e85aff2` |
| 4 | 切分支后标签不刷新、切不回去 | checkout / 新建成功后让 worktree 列表失效 | `568233a4` |
| 5 | 非 git / 临时 / 远程工作区也显示分支列；新建分支静默成功 | 恢复显示条件；主进程在非 git 目录明确报错 | `568233a4` |
| 6 | 空状态分支列不检查同目录其他对话与发送中 | 两条路径共用两层锁；同目录改按规范化路径判定 | `568233a4` |
| 7 | 空状态分支列作用在默认 main 检出而非 `target.workspace` | 改用 `target.workspace` | `568233a4` |
| 8 | Ctrl+Enter 跳过 `handleSend` 的全部前置检查 | 统一走 `handleSend(mode)` | `4a964c7d` |
| 9 | 插话状态在若干 await 之后才建立，刚发出就插话落空 | 在 `run()` 同步段建立 | `4a964c7d` |
| 10 | 长会话每个工具事件 / 每秒 tick 重算全部工具组 | 两张计时表、时钟 context、`ToolGroupItem` memo | `6e85aff2` |
| 11 | `skipMerged` 提前返回跳过「(no commits yet)」与输出丢失报错 | 挪到空列表处理之后 | `568233a4` |
| 12 | 点开思考时被高度动画与滚动跟随器滚走 | 去掉行面板高度动画，工具行也通知跟随器 | `6e85aff2` |
| 13 | 字号上调未同步 design-system.md，老用户设置未迁移 | 同步文档；老用户设置有意不迁移（用户拍板） | `4be46769` |
| 14 | BranchSwitcher 格式错误（lint 会挂），xs 宽度 80px 截断分支名 | 修格式，放宽到 240px 并按规范截断 | `568233a4` |
| 15 | 新增注释夹中文 | 各提交内翻译；纯注释文件单独提交 | 各提交 + `645c65a0` |

轻微项：`CHAT_INTERJECT` 注释把「事件改路由」写成「归属校验」→ 如实改写（行为与 `CHAT_STOP` 一致，未改）；`useComposerTarget` 废弃值、`BlockTiming`、重复的 `getTool` / `getThinking`、重复的忙碌状态集合、4 个无人使用的词条、未闭合的文档注释、锁定标签的悬停效果 → 均已清理。`a5d2059d` 以 `feat` 前缀提交的底部状态栏已被删除，但提交已推送无法改写，**发版时需手动从 Release Notes 去掉这一行**。

**审查描述不准的两条**（修复代理核实）：第 6、7 条的场景在当前界面上走不到——目标栏出现时一定已有会话（空状态也是一个草稿会话），分支列总走会话路径、本来就带两把锁。仍按建议修了回退路径；真正的漏洞是「同一目录」按工作区 id 判定（同一目录可对应两个 id），已改按路径。

## 3. v1.0.2 子代理工具死循环

用户在 v1.0.2 上用 glm-5.2（长上下文，每次请求输入约 29.5 万～31 万 token）派出过子代理后，看到「列出 / 停止 / 等待子 Agent」三行无限刷新、回合不结束。用户提供了会话文件；下面只记统计与模式，不含会话内容。

**会话文件分析（实测）**：

- 整个会话 414 行，只有 **1 条** assistant 消息出问题：含 **5709 个 toolCall**，约 19 分钟流式后被用户 Stop（`stopReason: aborted`，`errorMessage: Request was aborted`），usage 全部记为 0。
- 前 47 个调用是乱序混杂的真实工作（改文件、跑命令——其中有暂存提交的命令、派出一个代码审查子代理、等待、读文件）；从第 48 个起逐字重复 `TaskList {}` → `TaskStop {"delegationIds":[]}` → `TaskWait {"delegationIds":[],"mode":"any","timeoutSeconds":3}`，约 1887 轮。
- 其后没有任何 toolResult，整个文件也没有 `aiclient.subagent` 条目：**5709 个调用一个都没执行，子代理从未真正启动**。runtime 的工具返回在这次循环里模型一次都没看到——根因是模型在单条回复内的生成退化（形态 B）。
- 中断约 8 分钟后渠道返回 503「exceeded the monthly usage quota」。**推断**这条失控回复消耗了额度（时间吻合，但 usage 为 0，无法实测）。
- 界面上每行开头的「户」字在代码里找不到来源；**推断**是用户从截图识别文字时把工具行的扳手图标认成了字。

**只读调查从代码推出的另一形态（形态 A，未在现场出现）**：子代理都已结束、报告不在模型手里时，TaskList 只列状态，TaskStop 回 `No matching running subagents to stop.`，TaskWait 回 `No subagents are currently running.`；报告只在模型一轮不调工具时由自动续跑送达。工具描述又把「列出 → 停止 → 等待」写成了推荐顺序，没有任何防空转保护，只有 500 轮上限（按回复计数，对形态 B 无效）。另外子代理登记表只在内存里，重开会话后 TaskList 会回答「从没启动过」。插话修复让子代理跨运行存活，使形态 A 更容易出现——这是修复必须放进同一分支的原因。

**修复**：见[决策 042](../decisions/042-delegation-tool-loop-guard.md)。用合成数据复刻现场（47 个混杂调用 + 600 组三件套）：在第 51 个调用处掐断，零执行（哨兵文件不存在），只发 1 次请求，事件顺序 `session.failed(tool_call_repetition)` → idle，再发消息正常且上下文不含退化回复。

## 4. 收口验证（Linux 开发机，最终代码 `46789042`）

- 三套 tsc（根 / `src/runtime` / `src/agent-host`）退出 0。
- Biome：改动涉及的 80 个文件干净。全仓 `pnpm lint` 另有两处格式错误在当时未跟踪的 [batch-i-build-2026-09-20](batch-i-build-2026-09-20/README.md) JSON（本次已格式化），一条警告来自未改动的 `scripts/run-f3-dev-probe.mjs`。
- 全量 Vitest（`--maxWorkers=1`）：**493 文件 / 7461 例，1 例失败**——`updaterChannel.test.ts` 的反例在 electron-updater 6.7.3 下不成立，与本分支无关（main 上即存在），登记 T124 / Q033。
- 偶发失败：加开关之后的第一轮全量报了 2 个失败文件，但日志只保留了末尾 40 行，第二个未能定位；紧接着完整保留输出的一轮只剩 updater 那 1 例；6 个时序敏感的新测试文件（subagentLoopGuard / interject / turnCeiling / timelineToolClock / turnEndOpenInteraction / subagentDelegation）连跑 3 遍，88 例全过。登记 T127。
- 金样本 `src/shared/__tests__/fixtures/nativeGuiSubagentEventStream.json` 按 Task 启动回复的新文案重录（`AICLIENT_UPDATE_FIXTURES=1 … -t "delegation stream"`），只变一句。
- 各修复代理均做过「换回修复前源码 → 新测试失败 → 还原」的反向验证，明细在各代理报告中，未单独归档。

## 5. 留给后续

- T124 / Q033 updater 测试；T125 失控回复用量记 0；T126 会话树隐藏 `aiclient.permissions` / `aiclient.subagent`（疑似「会话分支全是 custom」来源）；T127 偶发失败。
- 开发机 GUI 点验与 Windows `1.0.3-test.1` 实测结果回填到本文件或点验目录。
