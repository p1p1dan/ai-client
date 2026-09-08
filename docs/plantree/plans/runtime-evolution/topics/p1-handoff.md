# P1 开工交接

日期：2026-09-08 · 基础提交：`8a71c843` · 分支：`feat/runtime-evolution`

## 当前状态

P0 骨架与 P2-0 基线已实现、验证并提交。P1 尚未开始，从 P1-1 工具注册表进入。
P2-0 的正式基线为 95.01%，六场景原始数据已归档；P1 不需要重复采集。
本机提交前复验：runtime 类型检查、P0 30 项测试、离线冒烟、采集 5 项单测与基线复核通过。
这是本机验证记录；没有把尚未运行的远端 CI 或 P4 GUI 验收记为通过。

## 新对话阅读入口

1. [项目规划入口](../../../README.md) → [任务看板](../README.md) → [ARD](../../../../plans/2026-09-08-runtime-evolution-ard.md)。
2. [`src/runtime/README.md`](../../../../../src/runtime/README.md)、`contracts.ts`、`bootstrap.ts`、
   `plugins/agent-loop/` 及 `__tests__/`，先掌握 P0 已有 service 与生命周期。
3. 按仓库 AGENTS.md 阅读本地参考源码与测试，并注明直接移植/适配移植/不采用；
   PI-Desktop 在 `/home/pi/code/PI-Desktop`，pix 在 `/home/pi/code/pix`，本轮 pi-app 参考
   checkout 在 `/tmp/aiclient-b-reference-pi-app`，新会话先确认这些路径仍存在。
4. [工程规范](../../../../agent-project-engineering.md)，先定义工具行为和权限矩阵的验收路径。

## P1 范围

- 文件归属：`src/runtime/plugins/tools/`、`src/runtime/plugins/permissions/`；P1-0 另含 `contracts.ts`。
- 按看板执行 **P1-0 至 P1-8**：先做 P1-0（IO/exec 两个 service 出口），再是注册表、文件工具、bash、搜索、
  权限内核、审批桥接、单测与载体兼容矩阵。
- **P1-0 先于一切**（2026-09-08 现场修订，[ARD D11](../../../../plans/2026-09-08-runtime-evolution-ard.md)）：
  加密机上兼容性按进程载体算，不按语言算——同一安装包里 Electron 载体的 Read 拿到密文、bash 报
  `Bad file descriptor`，而随包 node.exe 载体的 TUI 正常（[问题分析报告](../../../../../Windows加密环境GUI异常分析.md)）。
  所以工具不得直接 `node:fs` / `child_process`，一律走 `runtimeHostIo` 与 `runtimeExec`；
  否则后面要在每个工具里各补一遍兼容。
- 复用 `pi-agent-core` 的工具定义；对接 P0 的 service 契约和 bootstrap。
- 审批复用现有 Extension UI bridge/inline dock，不另建 renderer 审批流程。
- P0 的 `singleTurn` 是显式能力开关，P1 加入工具循环时同步核对其语义及既有测试。
- P2/P3 可以并行；需要改动共同契约时先明确边界，保留其他执行者的工作。

## 已知交接事项

- Q4 已收口为 [ARD D12](../../../../plans/2026-09-08-runtime-evolution-ard.md)：Pi 两包保持 0.84.4，
  不回退到基线用的 0.84.3，patch 差在 P2-6 记为已知偏差。P1 不受影响。
- [P2-0 验收](../evidence/p2-0/validation.md)记录了模型参数、原始数据口径与重跑方式。
- Biome 排除了不可变证据目录，防止格式化改变 suite 哈希；原始数据使用专用 verifier 检查。
- 主机资源有限，测试小批串行并用 `--maxWorkers=1 --no-file-parallelism`；不运行整套生产构建。
- 当前系统用 `corepack pnpm` 可调用 pnpm 10.26.2；根依赖若缺失，可按 runtime README
  临时借用相邻主 checkout 的 node_modules。临时链接不要提交。

完成各切片后同步更新看板、验证证据与后续事项；保持实现、验证、提交及最终集成验收分开。
