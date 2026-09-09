# P1 开工交接

日期：2026-09-08 · 基础提交：`8a71c843` · 分支：`feat/runtime-evolution`

## 当前状态

> **2026-09-08 施工中变更 — 权限模型改向（[ARD D14](../../../../plans/2026-09-08-runtime-evolution-ard.md)）**
> 用户拍板废弃 `readonly / pragmatic / handsoff / fullopen` 四档，改为两根轴：
> **模式** `plan` / `agent` 决定工具集（`plan` 不含 Write/Edit，bash 仅用于勘察），
> **档位** `ask` / `accept-edits` / `auto` 决定打扰程度，且 `accept-edits` **连 bash 一起放行**
> （旧 `handsoff` 放行写改却仍逐条问 bash，正是用户判定「鸡肋」的来源）。
> 当前 P1-1 裁剪、P1-5 核心和 P1-6 renderer/传递链已按两轴更新；Bash AST 和全局/可信项目策略导入也已实现，真实项目兼容仍待签收。


P1 D14 实现已提交 `27ff2020`，主动压缩配对已提交 `2ae6f209`，整体验收未完成。
本批审查补修与 P2-1/P2-2 接线已实现并随本次提交归档（2026-09-09）；后续 P3-1 至 P3-5/P2-4 已实现并通过本机往返矩阵，代码与证据随本次提交归档，见 [P3 完成证据](../evidence/p3/completion/README.md)；下一代码目标为 P4-1/P4-2/P4-3。
[当前 TODO](../TODO.md) 与 [P2 验证记录](../evidence/p2/README.md) 是接续入口：
P2 历史批次为 15 文件 195 项；最新 P3 批次为 runtime 20 文件 242 项 + Main 2 文件 34 项、类型分片与离线冒烟通过。
历史 D14 UI/IPC/旧 worker、Linux 载体证据保留在 [P1 记录](../evidence/p1/README.md)，本批不代签它们。
Windows 随包 Node、进程树、加密机、P4 GUI 和真实项目策略签收仍待现场。
P2-4 持久化与 P3-3 旧格式迁移已接通；P2-5/P2-6 在 P3/P4 后实测，旧基线仍为 95.01%，Pi 版本差按 D12 记录。

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
- P1 已导出 `toolSegments()` / `modeSegment()` / `permissionGearSegment()`，现已由 runtimePrompt 消费，固定槽位顺序不变。
- [P2-0 验收](../evidence/p2-0/validation.md)记录了模型参数、原始数据口径与重跑方式。
- Biome 排除了不可变证据目录，防止格式化改变 suite 哈希；原始数据使用专用 verifier 检查。
- 主机资源有限，测试小批串行并用 `--maxWorkers=1 --no-file-parallelism`；不运行整套生产构建。
- 当前系统用 `corepack pnpm` 可调用 pnpm 10.26.2；根依赖若缺失，可按 runtime README
  临时借用相邻主 checkout 的 node_modules。临时链接不要提交。

P1-9 的 new_context 已与 P2-8 成对默认注册；request 只设置意图，后续轮次边界消费。
预算提醒使用内部 custom 消息，在 provider 转换时才映射为 user，避免压缩时误保留提醒。
首轮预算检查在发送前执行；无可压缩历史时超大输入明确失败，保留 trace，不静默截断。
P2-1 默认自动装配；显式 systemPrompt 是固定探针覆盖入口。P2-2 的 borrowed 全局文件由 host
经 `prompt.globals` 明确传入，目标文件用 `run.targetPath` 指定；P4 需传递既有资源解析结果。

P1-5 的新依赖 pin：web-tree-sitter 0.26.13 / tree-sitter-bash 0.25.1，只用 WASM；
runtime 安装用 `npm ci --omit=optional --ignore-scripts`，不构建 Bash native binding。
P4 打包须带两个 WASM 资产，读取仍走 HostIo；projectTrusted 默认 false，需 host 明确传入。

完成各切片后同步更新看板、验证证据与后续事项；保持实现、验证、提交及最终集成验收分开。
