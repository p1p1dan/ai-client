# Maintenance Plan — Application Entry and Environment

> **状态**：Maintenance；主体完成（2026-08-28）。重排前完整说明见 [history snapshot](./history/2026-08-31-pre-pi-only-realignment/)。

## 已完成

- 两按钮启动首屏；每次启动显示 managed/local 入口；
- credential mode 与本次 app-entry mode 一致，spawn gate 以本次入口优先；
- 旧系统 Claude CLI 探测退出启动门禁；
- git 保留为真实 worktree 依赖，缺失时应用内非阻断提示；Windows 可安装，其他平台给下载入口；
- Main-owned `credentialMode`/onboarding keys 不再被 renderer settings snapshot 覆盖；
- PILAB welcome 文案/logo 改版的产品结果保留。

## 当前剩余

- managed/login 路线的 credential rejection 错误分类与长重试体验（低优先级，需在 Pi-only 下重新判断是否仍适用）；
- welcome/login 页和 git-missing notice 的 GUI/packaged 复验；
- branding 全局统一不属于本维护计划。

## Pi-only 影响

- Claude/Codex 本机配置探测、模型菜单和 spawn 失败票不再作为新产品能力继续建设。
- managed/local 产品入口继续有价值，但目标是选择 Pi managed agentDir 或用户自己的 Pi setup。
- 与 legacy runtime 绑定的 open items 只作为 T28/T35 删除输入；不能驱动新的 Claude/Codex 修复。

活动主线：[Pi-only roadmap](../pi-backend-migration/roadmap.md)。
