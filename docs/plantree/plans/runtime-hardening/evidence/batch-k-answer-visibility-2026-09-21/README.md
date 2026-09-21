# 批次 K 实施与验收记录

Role: evidence。日期：2026-09-21。基线：`58341983`。
权威任务：[roadmap](../../roadmap.md)；施工合同：[handoff](../../topics/answer-visibility-and-diff-open-handoff.md)。

## 用户确认与执行边界

用户确认 T107～T110，要求每个任务完成后单独提交。过程组默认折叠（替代 `ef26ca5f` 的临时默认展开），正文全部留在组外；单条工具行的主参数保留。T111 只取证、先报告，不修代码。

## TODO（实现与完整验收分开）

- [x] T107：正文全露、独立过程组；实现/定向测试/三套类型检查/提交。
- [x] T108：聚合行与工作头去参数后缀；实现/验证/提交。
- [x] T109：审阅默认折叠、真实行号与独立手势；实现/验证/提交。
- [ ] T110：审阅图标打开中列工作区 diff；实现/验证/提交。
- [ ] 现场证据与 T111 取证；未完成项明确保留，不能以单测代替。

## 验证约束

本机不装依赖、不跑全量测试、不做整包构建。Vitest 用 `--maxWorkers=1 --no-file-parallelism`，类型检查串行、Node 堆限制 1536 MiB。全量 Biome / Vitest / 打包本机未跑，CI 是权威；未触发 CI 时不得写成 CI 已通过。

## T107

- 改动：纯分段函数返回有序 sections；正文和 notice 在组外，仅 process 入组；各组按首 item 的稳定身份独立记住展开选择。
- 保留：无正文时 notice 置于过程组后的既有顺序偏差；未应答授权强制展开函数逐字保持；无过程时保留非折叠进度行，避免纯文本等待期间没有进度，绝不创建空折叠组。
- 细化：较早过程组只报告该组步骤数，最后一组承载回合时长/用量，避免重复计量。没有新增时长推算。
- 判据变更：旧测试的“仅最后正文可见”“默认展开”按用户确认改为“所有正文可见”“默认折叠”，不是为通过测试放宽要求。
- 反向验证：新纯函数测试在旧实现下 12 失败 / 19 通过；实现后分段/接线/进度共 114 通过。
- 三套类型检查：根 / runtime / agent-host 均退出 0（`NODE_OPTIONS=--max-old-space-size=1536 ./node_modules/.bin/tsc --noEmit`，后两者分别加 `-p src/runtime/tsconfig.json` / `-p src/agent-host/tsconfig.json`）。首次根检查的两个类型错误已修正并重跑通过。
- 改动文件 Biome 通过；`turnWorkGroupAwaitsUser` 与基线逐字节比对一致。
- 现场：当前源码 dev 启动成功，隔离 profile `batch-k-check` 无历史会话，界面报告 `Managed credentials are unavailable`，无法获得 ≥20 次调用的真实长回合。未以合成数据冒充现场证据。
- 状态：实现与定向验证完成，真实长回合观感待验收。

## T111 取证条件

T107 后已起一次 dev 核对条件。当前 profile 没有真实消息、模型凭据不可用，无法复现中断，也没有可导出的真实 blocks / history 合并记录。本轮不修改 `chatSessions.ts`、`historyReplayMerge.ts` 等取证目标；不能据此声称缺陷已消失。后续需有模型访问与可复现会话后再取证、报告。

## T108

- 提交前基线：T107 `678d79b7`。
- 改动：聚合行只携带调用数、使用渲染处字面量词条；删除聚合行 arg/argKind，避免独立参数槽泄漏；工作头只显示动作词。`deriveTurnCurrentAction` 保留，单条工具行和展开明细参数保留。
- 清理：`verbText`、`aggregateActionText`、`toolActionNoun`、`Last {{action}}` 全部失去生产者/消费者后退役；相应旧注释改写并保留聚合口径与动作间隙裁定。
- 反向验证：中文 DOM 与工作头接线新判据在旧实现下 2 失败 / 66 通过。
- Vitest 小批串行：toolCard 115、chineseChatSurface 10、toolExpansion 15（合计 140）；piToolVocabulary 23、toolVocabulary 9、i18nCoverage 2、fontDomainScan 11（合计 45）；messageTimelineWiring 59 通过。共 244 条。
- DOM 交互：≥100 字符命令在聚合头消失，点击展开后完整命令仍可访问。不是实际模型回合截图。
- 三套 tsc 均退出 0；改动文件 Biome 通过。
- 偏离：无范围扩大；真实模型长命令回合证据受前述凭据条件阻塞，保留待验收。

## T109

- 提交前基线：T108 `3a0c13fa`。
- 改动：审阅条目全部默认折叠；复用 Base UI 原生按钮触发器并补全行 hover/focus 样式；独立纯模块 `sessionReviewPatch.ts` 从 hunk 头逐行派生左右行号。
- 判据：新增行右号、删除行左号、上下文双号；无 hunk 的历史预览留空；超出 hunk 声明长度或损坏头后不沿用旧号；无换行标记不消耗行号。
- 测试：sessionReviewInteraction 1（12 条记录、全部折叠、目标条目独立展开、原生按钮可聚焦、行号）、sessionReviewPatch 4、sessionReview 6、fontDomainScan 11，共 22 条通过。更新后的交互测试在旧实现下失败。
- 三套 tsc 均退出 0；改动文件 Biome 通过。
- 截图：[当前 Electron 中 12 条合成记录全部折叠](t109-fixture-all-collapsed.png)。截图明确标为合成记录，不是用户真实会话。
- 现场限制：键盘 CDP 验证未完成（焦点未触发目标条目展开，用户正在操作测试窗口）；用户报告登录/模型凭据错误后立即关闭测试实例及探针。没有记录键盘现场通过；后续以真实会话补验。
- 偏离：新增小型纯解析模块供真实行号测试，避免在组件内复制解析逻辑。未扩大到 runtime 或工具写入逻辑。
