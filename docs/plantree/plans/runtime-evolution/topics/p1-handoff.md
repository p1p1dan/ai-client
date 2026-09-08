# P1 开工交接

日期：2026-09-08 · 基础提交：`8a71c843` · 分支：`feat/runtime-evolution`

## 当前状态

> **2026-09-08 施工中变更 — 权限模型改向（[ARD D14](../../../../plans/2026-09-08-runtime-evolution-ard.md)）**
> 用户拍板废弃 `readonly / pragmatic / handsoff / fullopen` 四档，改为两根轴：
> **模式** `plan` / `agent` 决定工具集（`plan` 不含 Write/Edit，bash 仅用于勘察），
> **档位** `ask` / `accept-edits` / `auto` 决定打扰程度，且 `accept-edits` **连 bash 一起放行**
> （旧 `handsoff` 放行写改却仍逐条问 bash，正是用户判定「鸡肋」的来源）。
> 当前 P1-1 裁剪、P1-5 核心和 P1-6 renderer/传递链已按两轴更新；Bash AST 和全局/可信项目策略导入也已实现，真实项目兼容仍待签收。


P1 正按 D14 继续实现，**代码尚未提交，整体未完成**。[当前 TODO](../TODO.md) 与
[验证记录](../evidence/p1/README.md) 是接续入口。P1-6 两模式/三档 UI、偏好迁移和创建/resume/更新/重启传递已实现，
并有 DOM 交互、IPC/RPC、WorkerManager 生命周期及真实旧权限策略加载测试。下一步是 P1-9 与 P2-8 配对，以及真实项目、Windows 和打包 GUI 验收。
P1-0/P1-3 已补保留进程树根身份的 Node runner，Linux 后代清理测试通过，Windows 尚未运行。
P1-8 尚缺 Windows 随包 Node 与加密机签收。HostIo/Exec 契约和 P0 async 迁移已落地，P2 可接入。
当前本机验证：runtime 类型检查、P1/P0 7 文件 79 项、P0 六项离线冒烟、Node 与真实 Linux
Electron utilityProcess 六项工具探针通过。没有运行远端 CI 或 P4 GUI 全链路。
P2-0 正式基线仍为 95.01%，P1 不重复采集；D12 保持 Pi 0.84.4，patch 差在 P2-6 明列。

## 新对话阅读入口

1. [项目规划入口](../../../README.md) → [任务看板](../README.md) → [ARD](../../../../plans/2026-09-08-runtime-evolution-ard.md)。
2. [`src/runtime/README.md`](../../../../../src/runtime/README.md)、`contracts.ts`、`bootstrap.ts`、
   `plugins/agent-loop/` 及 `__tests__/`，先掌握 P0 已有 service 与生命周期。
3. 按仓库 AGENTS.md 阅读本地参考源码与测试，并注明直接移植/适配移植/不采用；
   PI-Desktop 在 `/home/pi/code/PI-Desktop`，pix 在 `/home/pi/code/pix`，本轮 pi-app 参考
   checkout 在 `/tmp/aiclient-p1-reference-pi-app`，新会话先确认这些路径仍存在。
4. [工程规范](../../../../agent-project-engineering.md)，先定义工具行为和权限矩阵的验收路径。
5. [P1-0 契约草案](p1-0-host-contracts.md)：两个 service 的类型、P0 async 迁移面、验收及待评审项。

## P1 范围

- 文件归属：`src/runtime/plugins/tools/`、`src/runtime/plugins/permissions/`；P1-0 另含 `contracts.ts`。
- 按看板执行 **P1-0 至 P1-9**：先做 P1-0（IO/exec 两个 service 出口），再是注册表、文件工具、bash、搜索、
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
- Q6 已确认 pipe + adapter 挂载点；非 pipe 与加密机验收未完成。
- P1 已导出 `toolSegments()` / `modeSegment()` / `permissionGearSegment()`，供 P2 贡献对应槽位，未改 P2 装配顺序。
- [P2-0 验收](../evidence/p2-0/validation.md)记录了模型参数、原始数据口径与重跑方式。
- Biome 排除了不可变证据目录，防止格式化改变 suite 哈希；原始数据使用专用 verifier 检查。
- 主机资源有限，测试小批串行并用 `--maxWorkers=1 --no-file-parallelism`；不运行整套生产构建。
- 当前系统用 `corepack pnpm` 可调用 pnpm 10.26.2；根依赖若缺失，可按 runtime README
  临时借用相邻主 checkout 的 node_modules。临时链接不要提交。

P1-9 已导出 `newContextTool({ family, request })`：P2 接入时以 `runtimeTools.register(tool, 'read')`
注册，request 只设置待压缩意图，P2 在下一轮边界消费；支持 `fresh_window` / `summary`。
目前默认工具列表不含它，必须与 P2-8 的提醒成对启用。

P1-5 的新依赖 pin：web-tree-sitter 0.26.13 / tree-sitter-bash 0.25.1，只用 WASM；
runtime 安装用 `npm ci --omit=optional --ignore-scripts`，不构建 Bash native binding。
P4 打包须带两个 WASM 资产，读取仍走 HostIo；projectTrusted 默认 false，需 host 明确传入。

完成各切片后同步更新看板、验证证据与后续事项；保持实现、验证、提交及最终集成验收分开。
