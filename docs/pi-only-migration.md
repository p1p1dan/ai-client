# Runtime 测试版迁移说明

本说明对应 `feat/runtime-evolution` 的 `1.0.0-test.11` 测试候选。
当前状态以 [Runtime 看板](plantree/plans/runtime-evolution/README.md)为准；P4-6 尚未完成现场验收。

- **自 2026-09-13 起只有一个后端：自有 runtime。**当天 P6-1 把默认切过去，随后 P6-5 退役了旧 Pi 集成层，`AICLIENT_RUNTIME_BACKEND` 连同它一起删除——设这个变量不再有任何效果。
- 需要回到旧实现时只能装回上一个安装包，见[回退说明](pi-only-rollout-rollback.md)。
- **内嵌 Pi 终端与插件管理照常**：它们用的是随包的 `pi` 可执行文件，不属于被退役的那层代码。
- Windows 安装版 worker 使用随包 Node，bash 使用实际安装的 Git for Windows；其他产品路径使用 Electron utilityProcess。
- 模型与凭据沿用当前 profile 的 Pi 配置，native 不要求重新迁移凭据。不要在测试报告中公开凭据内容。
- 测试前退出已有应用，并备份当前 profile 和相关会话；旧会话导入/恢复使用副本，不删除原始记录。
- P5 的 skills、提示词模板、subagent 整体复刻、MCP 与导入适配已于 2026-09-12 全部落地；仍未完成的是**加密 Windows 的现场验收**（ARD 成功标准第 6 条），所以这仍然是测试候选，不是发布版。

本候选仅通过手动 CI 提供安装产物，不创建 tag 或自动发布。
安装后按 [P4-6 清单](plantree/plans/runtime-evolution/evidence/p4-6/README.md)逐项留证。
需要回退时遵循 [测试版回退说明](pi-only-rollout-rollback.md)。
