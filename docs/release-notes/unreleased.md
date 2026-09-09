# AiClient 1.0.0-test.10 — Runtime 内部测试候选

本候选通过手动 CI 生成，尚未完成 Windows/企业加密机现场验收，不代表正式发布。

- 自有 native runtime 已接入既有 worker RPC，默认仍使用 legacy Pi 后端。
- 修复权限审计事件缺失、用户消息气泡重复、附件丢失及内部权限记录出现在时间线的问题。
- 补齐 native bash 的 shell 配置、构建后 CommonJS 依赖加载，以及各平台 CI 的 runtime 依赖安装。
- 打包验证覆盖 legacy/native 的真实 Read/bash、工具结果回传模型、权限审计和 worker 退出，使用本地模型替身。

Windows 进程树清理、企业加密环境明文读写和真实 GUI 交互仍需按 [P4-6 清单](../plantree/plans/runtime-evolution/evidence/p4-6/README.md)验收。
skills、subagent 整体复刻与 MCP 等 P5 能力仍待后续实现。

安装与后端选择见 [迁移说明](../pi-only-migration.md)，退回既有后端或上一测试包见 [回退说明](../pi-only-rollout-rollback.md)。
