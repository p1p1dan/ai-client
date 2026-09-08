# Implementation Status — 资源归位与会话导入（B 组）

> **Completed，2026-09-08。** 状态权威：[roadmap](./roadmap.md)。

## Current phase

B1–B4 实现、关键联合取证和自动化门禁完成；根注册表已移入 Archived。
代码与文档位于当前工作区，未提交、未推送。

## Last Landed

- B1：默认技能安装提示、目录入口；Pi 0.84.3 真实 utilityProcess managed/local 与真实 TUI PTY 取证通过。
- B2：个人 Pi AGENTS.md 只读借读；`.agents/subagents` 经取证不采用，保持本轮不改 subagent 生命周期的边界。
- B3：随包扩展表驱动、成本/默认值随清单、旧设置兼容、未知 ID 忽略、空清单不下发、重复保存不重启。
- B4：Codex rollout 扫描、指纹与事务导入、来源 UI、幂等/跨来源/单源降级、真实 Pi writer 联合验证。
- 顺手修复：worktree `.git` 指针文件排除、electron-vite esm-shim 文案陷阱；用户已明确将顺手 bug 纳入本轮。

## Last Verified

- 全仓 303 test files 拆成 38 批，每批最多 8 files、单 Worker：**4532 tests 全部通过**。
- Root 与 Agent Host tsc --noEmit 以 1200 MiB 堆运行通过。
- 全仓 Biome 无 error，现有 27 warnings / 17 infos 保留；git diff --check 通过。
- native 测试使用用户缓存中独立编译的 node-pty；未安装系统包、未覆盖另一 checkout 的共享依赖。
- 详细命令和逐批清单：[completion](./evidence/completion.md) · [batch gate](./evidence/final-batch-gate.json)。

## Next Target / Handoff

GUI 点验已按本计划要求并入 [UI 对齐累计轮次](../pix-ui-alignment/implementation-status.md)：
资源页目录按钮、扩展开关、双来源选择、重复导入与打开继续。实际 GUI 点验仍待该轮次执行。
本机未运行整套生产构建；不将自动化和真实 PTY 取证当作 GUI/跨平台打包结果。
本计划没有剩余实现任务；opencode 仍 Deferred，需求触发再立。

## Blocked By

无。此前 native 缺失和 worktree 搜索门禁失败已处理，完整批次证据已更新；不再需要额外范围确认。
