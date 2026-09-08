# Evidence — 资源归位与会话导入（B 组）

> Completed，2026-09-08。最终状态以 [完成记录](./completion.md) 为准；早期检查点保留当时失败与推理，不覆盖最终结论。

## 最终证据

| 内容 | 文件 |
|---|---|
| 完成验收映射、命令、GUI 交接与验证限度 | [completion.md](./completion.md) |
| 303 files / 4532 tests，38 批精确清单和通过结果 | [final-batch-gate.json](./final-batch-gate.json) |
| B1-a 真实 utilityProcess 与 TUI PTY | [b1a-agents-skills-probe.md](./b1a-agents-skills-probe.md) |
| B1-b 默认技能安装位、目录 IPC 和提示 | [b1b-default-skill-home.md](./b1b-default-skill-home.md) |
| B2 全局指令只读借读、subagents 不采用结论 | [b2-borrow-surface.md](./b2-borrow-surface.md) |
| B3 清单、成本、默认值与旧设置兼容 | [b3-bundled-extension-registry.md](./b3-bundled-extension-registry.md) |
| B4 Codex 原生导入、幂等与联合验证 | [b4-codex-import.md](./b4-codex-import.md) |

## 历史检查点

- [B1–B3 实现检查点](./b1-b3-implementation-checkpoint.md)
- [B3 补验与 B4 解析层](./b3-b4-parser-checkpoint.md)
- [B4 来源接入](./b4-source-integration.md)
- [联合验证与中途门禁失败](./integration-and-final-gates.md)
- [无管理员权限恢复 native 门禁](./native-gate-recovery.md)
- [已应用的 worktree .git 排除补丁](./proposed-worktree-git-exclusion.patch)

GUI 按计划合并到 UI 对齐累计轮次，尚未实际执行；本机没有整套生产构建或跨平台打包结果。

## 分支落地

[B 组合入 feat 开发分支及目标目录验证](./feat-merge-validation.md)。
