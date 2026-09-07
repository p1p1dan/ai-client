# Implementation Status — 设置清单整理与旧壳删除

> 当前 phase、Next、blocker 与 last verified 的唯一权威。
> 任务 ID 与状态见 [roadmap.md](./roadmap.md)。

## Current phase

**S01–S07 均已实现，本轮相关回归与拆分检查通过；尚未完成完整验收和主分支合入。**
S01–S04 已独立保存为本地提交 `deba6cd7`。用户明确允许继续 S05–S07、按实际情况先提交，
本轮据此调整“补齐线先合入”的执行前置，在同一功能分支继续；不把本地提交记成已合入。

执行清单见 [TODO.md](./TODO.md)，新增实现证据见 [S05–S07](./evidence/s05-s07-implementation.md)。

## Active TODO（最多五项）

1. 审核本轮独立提交及验证证据，保留未验收标记。
2. 处理上轮遗留的四个环境相关失败文件与整套类型检查门禁；本轮不将相关/拆分检查写成全仓三绿。
3. 按 UI 对齐计划累计点验：仓库 → 会话 → 搜索/文件 → Git 分支 → 初始化终端 → 九类设置。
4. 特别验证新建 worktree 的初始化脚本实际执行，以及配置修改后的新值生效。
5. 完整验收后再将任务标为 Done、合入主分支。

## Blocker

上轮完整门禁尚未关闭：permissionPatchScript、permissionPolicyIntegration、SessionManager、
PiTuiPty 四个文件依赖未安装的独立 Agent Host 包或 node-pty 原生模块。
这些文件不属于本轮 renderer 分批回归，不能用本轮结果覆盖掉。

上轮整套 tsc 在 896 MiB 堆上限退出。本轮继续用 896 MiB 堆限制拆分生产代码与修改的测试进行检查。
本机实际约 1.9 GiB RAM，所有重检查串行；不运行整套生产构建。

GUI 与真实 PTY 初始化执行尚未点验。未提交与未合入是不同状态，提交记录不能替代上述验证。

## Last verified

**2026-09-07 · S05–S07 实现及回归：**

- 旧壳不变量、旧 profile 水合/磁盘清理与分类迁移测试通过。
- 真实 React 测试覆盖九类切换、受控分类恢复、权限仓库上下文与 12 项快捷键中的实际录制保存。
- renderer 176 个测试文件分 22 批执行；首轮 3048 项通过、1 项失败。失败是被删除 EnhancedInput 的字体计数，调整为保留组件的计数后原文件 48 项全部通过。
- 新增 worktree 初始化 5 项测试通过；连同状态机、隐藏入口、共享终端回归一批共 118 项通过。
- 生产代码的最终拆分类型检查通过；新增及修改测试的独立类型检查通过，均限制 Node 堆 896 MiB。
- 全仓 Biome 检查 982 个文件通过，0 error；保留既有 warning/info。
- 未运行整套生产构建，未启动 Electron GUI；完整边界与最终检查结果见 [本轮验证记录](./evidence/2026-09-07-s05-s07-validation.md)。

前轮 S01–S04 的分批门禁和待验收项保留在 [前轮验证记录](./evidence/2026-09-07-validation.md)。

## 与其他计划的关系

- [pix/pi-app UI 对齐](../pix-ui-alignment/README.md)：本计划删除旧壳并收敛设置，真实 GUI 继续并入累计点验。
- 普通终端导航继续隐藏；仅为保留下来的仓库初始化能力提供专用打开动作，不恢复通用入口。
- 本轮没有扩展 git stash、sync/publish/PR/revert/reset，也没有修改 Pi runtime/worker 迁移边界。
