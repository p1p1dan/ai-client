# Runtime 测试版迁移说明

本说明对应 `feat/runtime-evolution` 的 `1.0.0-test.10` 测试候选。
当前状态以 [Runtime 看板](plantree/plans/runtime-evolution/README.md)为准；P4-6 尚未完成现场验收。

- 默认仍使用既有 Pi SDK 后端 `legacy`。这里的 legacy 指旧 Pi 集成，不是 Claude/Codex CLI。
- 测试自有 runtime 时，从设置了 `AICLIENT_RUNTIME_BACKEND=native` 的环境启动应用，并以 worker 日志/trace 确认。
- Windows 安装版 worker 使用随包 Node，bash 使用实际安装的 Git for Windows；其他产品路径使用 Electron utilityProcess。
- 模型与凭据沿用当前 profile 的 Pi 配置，native 不要求重新迁移凭据。不要在测试报告中公开凭据内容。
- 测试前退出已有应用，并备份当前 profile 和相关会话；旧会话导入/恢复使用副本，不删除原始记录。
- P5 的 skills、subagent 整体复刻、MCP 与后续适配尚未完成。不能把测试版当成默认切换完成的发布版。

本候选仅通过手动 CI 提供安装产物，不创建 tag 或自动发布。
安装后按 [P4-6 清单](plantree/plans/runtime-evolution/evidence/p4-6/README.md)逐项留证。
需要回退时遵循 [测试版回退说明](pi-only-rollout-rollback.md)。
