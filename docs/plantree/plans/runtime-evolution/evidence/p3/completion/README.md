# P3-2 至 P3-5 完成批次

2026-09-09 · `feat/runtime-evolution` · **实现与本机验证完成，代码与证据随本次提交归档**。
[看板](../../../README.md) · [TODO](../../../TODO.md) · [契约](../../../topics/p3-completion-contracts.md) · [早期 P3-1/P2-4 快照](../README.md)

## 验收结论

P3-1/P2-4 的 JSONL、压缩持久化和跨 run/resume 已保留；本批补齐 P3-2 分支导航、P3-3 旧格式迁移、
P3-4 事件翻译与 P3-5 Main 索引适配。P3-6 的本机往返矩阵一并补全。
使用真实文件、真实 native Agent 循环、真实 SessionIndexService 和 fauxProvider；不访问线上模型。
生产 worker RPC、默认后端开关、Windows/打包 GUI/加密机与真实缓存仍由 P4/P2 后续节点验收。

| 节点 | 已验证的实际行为 | 主要实现/测试 |
|---|---|---|
| P3-2 | main lane 导航持久化；完整树/分支历史；用户 rewind 到 parent 并返还 editorText；确认门禁；标签/标题；独立 fork 不动源文件；恢复模型/thinking/D14/checkpoint；运行期间拒绝导航，dispose 等待 fork | session/store.ts、sessionNavigation.test.ts |
| P3-3 | Pi v1/v2/v3 和 PI-Desktop schema 1；四个旧权限值；工具调用/结果关联与 usage；子 agent 私有消息保留但不注入主上下文；checkpoint 物理位置晚于逻辑边界时仍保留后续消息 | session/legacy.ts、sessionLegacy.test.ts |
| P3-3 原始基线 | P2-0 B01–B06 六份原始 JSONL 均导入独立文件、实际 run 成功、dispose 后重开；原文件逐字节不变；覆盖旧 compaction | sessionLegacy.test.ts 的六基线循环 |
| P3-3 失败边界 | 重复 resume 复用既有副本；来源哈希漂移拒绝；cwd 重定位须显式允许；重复/缺失 parent 拒绝；临时文件写失败后目标不出现，源不改且锁清理 | sessionLegacy.test.ts |
| P3-4 | cumulative text/thinking 去重与顺序；工具进度裁到 120 字符；交叠工具结果按 call ID 关联；自定义消息/持久化 custom.entry/压缩可见；唯一 turn_end usage，跨 resume 累计；取消、provider/预算/模型解析失败终态 | events/、runtimeEvents.test.ts |
| P3-5 | 创建/恢复/import/fork 身份与 leaf 持久化；host 全局序号；旧身份迁移及失败回绑；导航失败回滚；索引提交期间拒绝新操作；fork 索引失败清理新文件；历史分页；重命名失败回滚两侧 | NativeSessionIndexAdapter.test.ts + SessionIndexService.test.ts |
| P3-1/P2-4/P3-6 | 官方 Pi v4 双向读写、尾片修复、失败写队列、两种压缩家族/再次摘要、跨 run/实例/独立进程恢复 | session.test.ts、sessionCodec.test.ts、contextCompaction.test.ts、process-resume.txt |

## 回归门禁

全部重任务串行，测试指定 `--maxWorkers=1 --no-file-parallelism`，Node 堆上限 768 MiB；没有执行全量生产构建。

| 批次 | 结果 | 日志 |
|---|---|---|
| session / codec / compaction | 3 文件 42 项 | [session-tests.txt](session-tests.txt) |
| navigation / legacy / events | 3 文件 24 项 | [navigation-legacy-events.txt](navigation-legacy-events.txt) |
| loop / bootstrap / contracts / host / IO boundary | 5 文件 30 项 | [runtime-host-tests.txt](runtime-host-tests.txt) |
| prompt / instructions / catalog | 4 文件 49 项 | [prompt-catalog-tests.txt](prompt-catalog-tests.txt) |
| tools / shell / context / prefix | 5 文件 97 项 | [tools-context-tests.txt](tools-context-tests.txt) |
| **runtime 合计** | **20 文件 242 项通过** | 计数不重复累计复跑 |
| Main adapter + 既有索引 | **2 文件 34 项通过** | [main-index-tests.txt](main-index-tests.txt) |
| runtime 类型检查 | 通过，独立 runtime tsconfig | [checks.json](checks.json) |
| Main 调用面类型检查 | 通过，根 tsconfig 下定向 include adapter/shared port | [checks.json](checks.json) |
| 本批 TypeScript Biome / diff-check | 通过 | [checks.json](checks.json) |
| Node strip-types 离线冒烟 | 6 项断言通过 | [offline-smoke.txt](offline-smoke.txt) |
| 两个独立 Node 进程 | 创建 6 条 → 恢复续写 8 条；checkpoint/title 恢复成功 | [日志](process-resume.txt) / [可复跑脚本](process-resume.mjs) |

代码与测试 SHA-256 见 [sources.json](sources.json)。日志中的 corrupt-index warning 来自旧索引测试主动写入坏 JSON 的预期场景。

## 关键取舍与修复依据

- **适配移植** Pi 官方 v4 codec/context 的 wire 和 parent/lane 不变量，自有 HostIo 是生产 IO 出口；官方 reader/writer 只用于互通测试。
- **复用本仓** piSessionTree/piSessionTimeline、piUsage/piTurnRollup 和既有 RuntimeEvent DTO；Main adapter 不把 Pi SDK 引入 Main。
- **适配移植** PI-Desktop sessions.rs 的 canonical tool_call 块与 transcripts.rs 的 checkpoint 读写语义；工具调用位于工具行，需要在 assistant 补 carrier，保留原始 legacyRecord。
- **适配参考** pi-app incomplete-session-recovery 源码/测试；**不采用** pix 的整包 SDK SettingsManager 自动目录推断，file/cwd 由 host 显式传入。
- 迁移改为目标持锁 + 临时文件 rename 发布，避免写失败产生可见半文件；source realpath/hash 校验保证重复 resume 不重建丢失 native 新消息。
- fork 索引失败时只清理本实例尚未接受的 fork，且先重新取得锁并验证 ID/parentSessionId；另一个 writer 正在使用时拒绝删除。
- Main 操作的串行区间覆盖 runtime 修改、索引写入与失败回滚；成功终态等待索引提交。
- 本轮故障检查发现既有 SessionIndexService.rename 在 flush 失败后保留了新内存标题，后续 mutation 会持久化错误标题；补修为与 commitPiLeaf 一致的失败回滚，并通过真实 writer 故障注入验证。
- 开发中失败夹具：一次未提供 faux provider 导致 agent_dir_unset；模型状态夹具的 faux 默认模型覆盖了此前 model_change。按 SDK 的实际恢复优先级修正 fixture 后，用实际 run.trace.model 验证目标模型。最终门禁均通过。

## 已知限制与下一步

- **代码与证据已归档**；并行 P4-0/D13 工作以看板既有提交为准，本批保留其状态。
- 官方 Pi writer 不使用伴随锁，迁移/互通要求来源会话停止写入；强杀的遗留锁不自动抢占。
- HostIo 无 fsync，不承诺断电级 durability。JSONL 与 Main 索引没有跨文件事务日志；强杀可能留下未索引 fork 或暂时不同的 leaf，下次 resume 以 JSONL 重建并提交索引。
- Pi v4 未完成 SDK operation 明确拒绝自动接管；不会重放可能已执行的工具。
- 已从 catalog 删除的历史模型回落默认，显式 run.model 优先；不能运行当前未配置模型。
- 本地分片类型检查不等于全仓 typecheck；没有运行 CI、Windows/加密机、GUI 或生产打包。
- 下一步按 P4-1 → P4-2 → P4-3 接 Cordis worker bootstrap、legacy/native 开关和两种 carrier 的 RPC；P4-4 至 P4-6 联调与现场门禁后，执行 P2-5/P2-6 同套会话对比。真实 cacheRead/(input+cacheRead) 门槛仍为 95.01%，不能用 faux 结果代签。
