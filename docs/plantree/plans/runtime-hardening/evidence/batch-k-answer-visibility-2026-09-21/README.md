# 批次 K 实施与验收记录

Role: evidence。日期：2026-09-21。基线：`58341983`。
权威任务：[roadmap](../../roadmap.md)；施工合同：[handoff](../../topics/answer-visibility-and-diff-open-handoff.md)。

## 用户确认与执行边界

用户确认 T107～T110，要求每个任务完成后单独提交。过程组默认折叠（替代 `ef26ca5f` 的临时默认展开），正文全部留在组外；单条工具行的主参数保留。T111 只取证、先报告，不修代码。

## TODO（实现与完整验收分开）

- [x] T107：正文全露、独立过程组；实现/定向测试/三套类型检查/提交。
- [ ] T108：聚合行与工作头去参数后缀；实现/验证/提交。
- [ ] T109：审阅默认折叠、真实行号与独立手势；实现/验证/提交。
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
