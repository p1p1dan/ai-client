# P3 会话、事件与索引验证入口

**当前证据：[P3 完成批次](completion/README.md)**，覆盖 P3-2/P3-3/P3-4/P3-5，并重跑 P3-1/P2-4 回归。
下文及同目录旧日志、sources.json 是早期 P3-1/P2-4 检查点快照，保留历史；其“尚未完成”描述不作为当前状态。

---

# 历史检查点：P3-1 / P2-4 本机实现与验证

2026-09-09 · runtime 基础提交 `fb7cb10b` · **本批未提交**。
[看板](../../README.md) · [TODO](../../TODO.md) · [存储与兼容契约](../../topics/p3-1-session-contracts.md)

## 结论

自有 plugin-session 已实现 Pi 0.84.4 的 v4 JSONL 存储；P2-4 压缩记录已接入持久化，
并通过两种压缩家族、跨 run、正常关闭后 resume、独立进程重新打开和再次摘要的验证。
**不代表 P3 整体完成**：Pi v3 / PI-Desktop schema 1 导入、D14 历史迁移、完整 branch/fork/rewind、
RuntimeEvent 翻译和 SessionIndexService 接线仍未完成。

## 行为与接口

```ts
const runtime = await createRuntime({
  // providers 或 agentDir、host 等沿用既有配置
  tools: { cwd: '/workspace/repo' },
  session: {
    file: '/sessions/example.jsonl',
    cwd: '/workspace/repo',
    mode: 'create', // 后续新实例使用 resume
  },
});
await runtime.run({ prompt: '开始任务' });
await runtime.run({ prompt: '继续上一轮' });
await runtime.dispose();
```

- session 配置可选；不配置时仍是独立 run 的离线 lane。Session 和工具 cwd 必须一致。
- `runtimeSession` 为 Cordis service，提供 file/snapshot/appendMessage/appendCompaction/flush；
  存储通过 HostIo，默认单文件上限 32 MiB，可由 maxBytes 显式调整，超限明确失败。
- `message_end` 的监听器由 Pi Agent 等待；先完成写入再推进工具/下一轮。compaction Entry 写入成功后
  才切换模型上下文。原始消息、工具调用和结果始终保留在日志中。
- 新 run 恢复 main parent 链，从最新 compactionSummary + retainedTail + 后续消息组装上下文。
  恢复 checkpoint 身份，第二次摘要通过 `<previous-summary>` 更新此前摘要；不把摘要重复当作普通消息摘要。
- 历史太长时，在拼接新用户任务前压缩已完成历史；新输入自身过大仍明确拒绝，不静默截断。
- 未完成工具调用补入“执行效果未知，先检查环境”的失败结果，不自动重放命令。
- 同一 runtime 拒绝重叠 run；伴随 `.writer.lock` 通过 createOnly 阻止合作 writer 同时打开。
  写入失败后队列保持失败，关闭并重新打开前不再追加。正常 dispose 等待写入并释放锁。
- 仅恢复未换行的非法 JSON 尾片（包括半个 UTF-8 字符）；完整损坏行、seq 缺口、重复 id、
  缺失 parent/lane 明确拒绝。合法末行缺换行会先补分隔符。修复在持锁后通过临时文件 rename 发布。

## 验证

四批按顺序执行，统一 `NODE_OPTIONS=--max-old-space-size=768` 和
`--maxWorkers=1 --no-file-parallelism`；批次间检查资源，日志按各文件最后一次结果归档。

| 检查 | 结果 | 证据 |
|---|---|---|
| session / codec / compaction | 3 文件 42 项通过 | [session-tests.txt](session-tests.txt) |
| loop / bootstrap / contracts / host / IO 边界 | 5 文件 31 项通过 | [runtime-host-tests.txt](runtime-host-tests.txt) |
| prompt / 指令链 / catalog | 4 文件 49 项通过 | [prompt-catalog-tests.txt](prompt-catalog-tests.txt) |
| tools / shell policy / budget / new_context / prefix | 5 文件 97 项通过 | [tools-context-tests.txt](tools-context-tests.txt) |
| runtime 合计 | **17 文件 219 项通过** | 新增 session 17 项 + codec 8 项；已实现 session 后移除 1 项 deferred 参数化断言 |
| runtime tsc | 通过 | `node node_modules/typescript/bin/tsc -p src/runtime/tsconfig.json --noEmit`，exit 0，堆 768 MiB |
| 修改 TypeScript 文件 Biome | 通过 | 13 文件检查，无残留问题 |
| P0 离线冒烟 | 6 项断言通过 | [offline-smoke.txt](offline-smoke.txt) |
| 独立 Node 进程恢复 | 两个不同 PID，第一进程写入 checkpoint 后退出，第二进程恢复并续写，5→7 条记录 | [process-resume.txt](process-resume.txt) |
| Pi 官方格式互通 | 本实现产物由 JsonlSessionRepo 打开；官方 writer 的消息和 checkpoint 被 native 恢复并续写 | session.test.ts 内双向用例 |

源文件与测试哈希见 [sources.json](sources.json)。开发期间其他执行者提交了 P4-0/D13 的独立工作，
本批仅修改 runtime/session 及对应计划文档；其提交状态和现场门禁以看板独立条目为准。

## 参考复用与验证中发现的问题

- **适配移植** Pi v4 codec/state/storage 的格式与 seq/parent/lane 不变量；不使用 SDK storage 接管生产 IO。
  官方 SDK 只在互通测试中读写真实临时文件。
- **适配移植** PI-Desktop `transcripts.rs` 的完整 transcript 与独立 compaction record 语义，
  以及 `session-context.ts`/测试的最新 checkpoint 投影和失败 assistant 过滤。
- **适配参考** pi-app incomplete-session-recovery 测试的 graceful shutdown 与中断状态边界。
- **不采用** pix session-dir 的整包 SDK SettingsManager 自动目录回落；本批由 host 明确传入 file/cwd。
- 官方 writer 首次测试拒绝 fauxAssistantMessage 中显式 undefined 字段（`Durable payload contains undefined`）；
  测试改用经过 JSON 规范化的消息。自有存储也在写成功后用实际 JSON 表示更新内存，确保重开前后数据一致。

## 尚未覆盖的边界

- **旧格式**：Pi v3、PI-Desktop schema 1 不是 v4；明确返回 session_format_unsupported，原文件不改写。
  它们的兼容导入和旧权限值迁移归 P3-3，不能用本批 v4 测试代签成功标准 5。
- **SDK 未完成 operation**：显式拒绝自动续跑，等待后续 recovery；不会把挂起操作悄悄视作已完成。
- **锁恢复**：正常关闭释放锁；进程被强杀留下的锁不自动抢占，需要确认旧 writer 已退出后处理。
  官方 Pi writer 不遵循本实现的伴随锁，因此互通不等于可同时编辑同一个文件。
- **持久性**：HostIo 没有 fsync 契约；已验证进程正常退出/重新打开，未承诺断电级持久性。
- 本批未运行 Windows/加密机/打包 GUI、远端 CI 或线上模型。真实缓存指标仍归 P2-5/P2-6，旧基线 95.01% 不变。

下一步：P3-2 完整分支导航、P3-3 旧会话导入，再推进 P3-4/P3-5 事件和索引适配。
