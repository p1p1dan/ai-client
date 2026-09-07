# Implementation Status — 设置清单整理与旧壳删除

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)；不在此复制第二份任务状态。

## Current phase

**S04 与 S01/S02/S03 已实现，相关回归通过，待完整门禁与合入。** S05/S06/S07 未开始。
执行进度见 [TODO.md](./TODO.md)，任务状态仍以 roadmap 为准。

## Active TODO（最多五项）

1. 确认是否允许安装主机缺少的 make/g++ 等编译工具；已向用户询问，尚未收到答复。
2. 补齐 node-pty 原生模块与独立 Agent Host 依赖，复跑剩余四个环境相关失败文件。
3. 完成待验收项，GUI 点验按原计划并入 UI 对齐累计点验。
4. S04/S01/S02/S03 满足门禁后更新状态并合入，目前未提交。
5. **S05 删旧壳** —— S01/S02/S03 全部合入后才允许开工。

S06 / S07 在 S05 之后，暂不进 Active。

## Blocker

完整测试门禁尚未通过：本机没有 make/g++，node-pty 原生模块无法构建；
`src/agent-host/node_modules` 的独立依赖尚未安装。系统级依赖安装等待用户确认。
整套 `tsc --noEmit` 在 896 MiB 堆上限退出；生产代码和本次新增测试已拆分检查通过，
不能把拆分结果写成整套类型检查通过。

原有 lint 格式问题已做单行等价修正，全仓 lint 已通过。
顺序纪律保持：S01/S02/S03 未全部合入前不得动 S05。

## Last verified

**2026-09-07 · 实现与验证**：

- S04：旧设置删除与旧 profile 兼容测试通过，见 [S04 证据](./evidence/s04-removed-settings.md)。
- S01：搜索控制器、快捷键与异步请求测试通过，真实 ripgrep 八项集成测试通过，见 [S01 证据](./evidence/s01-workspace-search.md)。
- S02：真实 React 表单与 localStorage 保存测试通过，旧会话菜单测试已限定正确范围并通过，见 [S02 证据](./evidence/s02-repository-settings.md)。
- S03：分支操作四项与缓存键三十一项测试通过，见 [S03 证据](./evidence/s03-branch-switching.md)。
- 首轮全仓测试：294 个文件分 25 批、每批最多 12 文件、单 worker；4247 个断言通过，10 个失败，8 个跳过；含模块加载失败在内共 12 个失败文件。
- 补齐 Electron/ripgrep 并修正菜单测试后，已复跑清除其中 8 个失败文件。另补充的搜索空查询测试通过。
- 剩余环境相关失败文件：permissionPatchScript、permissionPolicyIntegration、SessionManager、PiTuiPty。
- 全仓 Biome 检查 1035 个文件通过；原有 warning/info 不作为 error。
- 类型检查拆分为生产代码（排除测试，保持原 Agent Host 排除范围）和本次六个新增测试文件，两部分通过；整套检查仍受堆上限限制。
- 首轮原始 JSON 报告保留在 `/tmp/settings-cleanup-results-BKQVxy/`；详细验证边界见 [验证记录](./evidence/2026-09-07-validation.md)。

未运行整套生产构建或 Agent Host 打包，未启动 `pnpm dev`，未进行真实 Electron GUI 点验。

## 与其他计划的关系

- [pix/pi-app UI 对齐](../pix-ui-alignment/README.md)：那边管新壳的形态，本计划管旧壳的消亡与设置页的收敛。
  本计划的 GUI 点验并入那边的累计点验，不单独开轮次。
- S03 解掉 `GitSurfaceView` 的 Git 动作 ban，是对该计划既有减法决策的**局部松绑**，
  松绑范围仅限分支切换，落地时需在该文件头注释里写清新边界。
