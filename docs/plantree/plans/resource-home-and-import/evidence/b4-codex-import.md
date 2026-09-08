# B4 Codex 会话导入

2026-09-08，Done。

Main 的 `LegacyImportSources.ts` 提供 source/scan/convert；Pi writer 保持来源无关，
这一落点适配已登记 README。Codex 从磁盘 rollout 扫描到 UI 来源选择、来源转换和现有事务发布链路均接通。
工具保持 display-only，来源指纹在发布前复验；manifest 与索引保留来源，目标 ID 包含来源。

验证覆盖：

- 真实本机 rollout 的明确脱敏夹具（来源、记录选择和脱敏方式见 fixture README），不是伪造的协议响应。
- 同一 Codex 会话第二次导入 already-imported，createImport 只调用一次；签名 manifest 可重新读取 Codex 来源。
- 相同 externalId 分别属于 Claude/Codex 时创建两条不同记录。
- Codex 根不可扫描时 Claude 项目完整返回。
- parser→scanner→adapter→真实 Pi 0.84.3 writer→reopen 联合测试：源字节不变、原生上下文可读、legacy tool 不进 context。
- rollout 复用旧 `codexItemMapper` 的文本提取函数；既有协议 reader/mapper 全部测试通过。

各文件包含在 [303 files / 4532 tests 门禁](./final-batch-gate.json) 中。
逐阶段证据：[解析层](./b3-b4-parser-checkpoint.md)、[来源接入](./b4-source-integration.md)、[联合验证](./integration-and-final-gates.md)。
GUI 按 [完成记录](./completion.md) 交接累计轮次；不恢复 Codex execution runtime。
