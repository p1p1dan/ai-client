# P4-6 历史出包与交接证据

当前节点只见[核心任务树](../../README.md#p4)。后续证据：[test.12](ci-34354367890/README.md)、[test.13](ci-34424337205/README.md)、[Windows 加密机实测](../../../../../../Windows-P4-6-evidence/test12-reverify.md)。下文“待验收/仍运行”均为历史时点描述；用户现有 Windows 已确认就是 TEC 加密机。

.11 出包阶段历史快照（2026-09-09；不是当前状态）：`.11` Windows/Linux 构建产物冒烟通过，Windows installer/unpacked 已交付；完整 GUI、命令树专项与企业加密现场待验收。macOS 同次 CI 仍运行。

该版本入口：[CI 34308304362 原始证据、下载与 Windows 操作](ci-34308304362/README.md)。下文保留接棒、失败诊断及修复过程。
权威：[看板](../../README.md) / [ARD D11、D13、D16](../../../../../plans/2026-09-08-runtime-evolution-ard.md)。

## 已核实

- P4-5 提交 `9edab07c718e3ceeb1498d841fa2783322d570cd` 已推送 `feat/runtime-evolution`。
- [手动 Build 34303440949](https://github.com/p1p1dan/ai-client/actions/runs/34303440949) 已失败：三道 typecheck、lint 通过；336 个测试文件中 335 通过、1 失败，4925 项中 4924 通过、1 失败。后续构建/打包及发布任务全部跳过。
- 唯一失败是 `scripts/__tests__/agent-host-build-lib.test.mjs` 的 `accepts a worker-only Pi artifact`：测试样本缺 `runtime-helpers/exec-runner.mjs` 和 `runtime-helpers/tsd-read.mjs`。校验器已要求两文件，实际构建脚本也已有复制逻辑；不能据此认定真实安装包缺文件。
- Claude 交接的本机 4915 项与本次 CI 4925 项统计不同，本轮采用实际 CI 结果，不将旧报告当作最新门禁通过证据。
- 版本基准复核：用户日常主工作分支 `feat/model-catalog-admin` 的远端 `package.json` 已为 `1.0.0-test.9`；此前成功的 [CI 34207032908](https://github.com/p1p1dan/ai-client/actions/runs/34207032908) 来自该分支。当前 runtime 分支仍留 `0.4.0-test.8`，这不是最新测试版。GitHub 字面 `main` 仍为 `0.3.4`。下一次 runtime 测试包按 `1.0.0-test.10` 准备，出包前再查是否已被占用；本轮已将 `package.json` 更新为 `1.0.0-test.10`，尚未生成测试包，不通过合并另一分支来同步版本。

## 出包修复（本轮已实现，等待远端构建验证）

1. 有效产物测试样本补齐两个 helper，并增加逐个缺失即失败的用例；不放宽校验器。
2. 三个平台打包 job 安装 `src/runtime` 独立依赖，保持锁文件和 Pi 版本不变。
3. 打包验证串行运行 legacy/native 两条 lane。本地 HTTP SSE 替身驱动真实 Read/bash，检查结果回传模型、idle、dispose/退出；native 另核 trace 中的后端/载体/Node 路径和权限审计事件。三平台上传 `worker-smoke-*` JSON 证据。
4. 新发现并修复 native worker 未传 `shellPath`：在 host 层按 Git Bash 已知目录/原生 PATH 解析，Unix 优先 `/bin/bash`；Windows 排除 WSL launcher，不改变随包 Node 选择。新增真实 RPC → bash 用例及路径选择测试。
5. 新发现并复现 native bundle 启动即报 `Dynamic require of "process" is not supported`：旧产物启动退出码 1；构建入口补 ESM `createRequire` banner，最小 CommonJS bundle 执行回归通过。未在本机重建应用/worker，实际产物由 CI 验证。
6. 测试版递增到 `1.0.0-test.10`，只推任务分支、手动 CI，不推 tag、不本地打包。

CI 补修：`76424efa` 的 [34305837633](https://github.com/p1p1dan/ai-client/actions/runs/34305837633) 三道类型检查/lint 通过，4933 项通过、1 项失败。`guiEventContract` 的 fauxProvider 默认随机分块，句末标点偶尔单独成为 delta；现固定录制用例 tokenSize，保留原 fixture 和完整事件断言。该次同样未进入打包。

本机源码 Node IPC 冒烟通过：以 `/usr/bin/node` 执行当前 `worker.ts`，HTTP SSE 替身驱动真实 Read/bash，工具结果回传、native trace、权限审计与退出码 0 均确认。`AICLIENT_WORKER_SMOKE_NODE_PATH` 是开发诊断覆盖，此结果不算真实 Windows bundled-node 或打包 GUI 验收。

本机验证：首批 4 文件 54 项通过；补 bundle 回归后第二批 3 文件 50 项通过（含重复测试文件，不累加为独立总数）；runtime typecheck、变更文件 Biome 通过。完整门禁和产物测试待本次 CI。

参考复核：pi-app `/tmp/aiclient-p1-reference-pi-app` 的 WorkerManager 与 session-isolation 测试、pix `/home/pi/code/pix` 的 pi-tui-session 与测试已读，本轮不采用额外 manager/PTY 实现。shell 搜索适配本仓 GitInstaller 和已安装 Pi SDK 的 shell 解析顺序，不引入 pi-coding-agent 新依赖，不采用 WSL/sh 隐式回落。

用户已明确授权代码/工作流修复，与 Windows AI 同步推进。Windows AI 先做环境分析；收到产物后以实际 CI 提交为准。

## 环境分工

| 环境 | 工作 | 验收边界 |
|---|---|---|
| 当前 Linux 开发机 | 定位问题、获授权后改代码、小批测试、维护交接与回收证据 | 无需为此次出包装 Windows/完整打包环境；不本地打包 |
| 远端 CI | 干净安装依赖、完整门禁、各平台打包、真实 worker 的 native 冒烟 | CI Windows 不具备企业加密驱动；不能代签加密场景 |
| 用户 Windows + AI | 下载同一提交的包，固定安装/解压路径，确认 native + 随包 Node，执行工具、审批、会话与进程检查，收集日志 | 运行安装包不要求先装 Node/pnpm/Visual Studio；若运行现有源码探针，需要另准备对应源码与 runtime 依赖 |
| 企业加密 Windows | 同一包/矩阵下核验驱动相关明文读写、Main diff/冲突编码/二进制判定、GUI/TUI 一致性与进程残留 | 普通 Windows 通过不能代签；是否就是用户现有 Windows，待确认 |

## Windows 交接范围（待产物成功后补精确命令）

- 安装包与源码提交一致；记录版本、CI run、实际 exe/node.exe/Git Bash 路径。
- 关闭已有应用后，从设置了 `AICLIENT_RUNTIME_BACKEND=native` 的启动环境打开测试包；以 worker 证据确认实际后端，不能只看能否聊天。
- P1-8 复用六项断言：read、edit、bash、glob、grep、trace；write 是探针前置动作。现有入口为 `src/runtime/smoke/p1-bundled-node.ts`，依赖源码及 runtime 包，不是复制一条命令即可在裸安装包旁运行。
- P1-0/P1-3：正常退出、超时、取消和父命令先退出的命令树清理，核对 runner/taskkill 与残留进程。
- P1-5/P1-6/P4-5：权限两模式/三档及策略重载、审计行、附件、用户气泡去重、会话恢复/压缩、GUI/TUI 交接。
- D13/Q7：普通 Windows 先验证 Git/工作区行为；企业加密环境另核对明文内容与错误可见性。
- 每项记录通过/失败/未执行、输入、预期、实际、日志或截图；两种产品载体分别签收，Windows 上 bash 来自实际 Git for Windows 安装，本仓包配置未包含随包 Git/bash，不能把假定的 resources/git 路径当作事实。Windows bundled-node 不替代 Linux/macOS electron-utility。

## 主线 GUI 接入与 Windows CI 退出修复

按用户补充，已按原序 cherry-pick（保留来源）五个提交，源码无冲突；仅规划入口保留 runtime 权威并注册 GUI 计划：

| 来源 | 当前分支提交 |
|---|---|
| `8f4b72b0` | `d7def5c3` |
| `7f114608` | `16f799b7` |
| `9c4ea0e2` | `0aa27ab0` |
| `20da96e4` | `7dfe4260` |
| `84c16231` | `80294b63` |

- native 录制事件仍保留全部权限记录；允许结果按主线规则收进授权详情。重放断言改为新时间线形状，新增真实录制数据 → DOM 点击展开 → 两条审计记录均可见的检查。
- 当前 native Edit 不返回 SDK patch，GUI 按已实现的多 edits 参数预览显示，不冒充实际 patch；完整 GUI 签收使用 [A～E 现场清单](../../../gui-sdk-experience/现场验收清单.md)。
- 联合小批：权限/问答/diff/TEMP/replay 6 文件 22 项通过；worker 退出与主线 worker/history 3 文件 31 项通过。根 tsc 在本机 1200 MiB 堆上限 OOM（退出 134），已停止并复查资源，无残留；不算通过，交给下一轮 CI。
- [CI 34306438655](https://github.com/p1p1dan/ai-client/actions/runs/34306438655) 对 `2397f1ed` 完整门禁通过，Linux 打包及 legacy/native Read/bash/退出通过。该轮不含五个 GUI 提交。
- Windows 同轮两后端均完成工具检查与 dispose 回执，但进程强制退出触发 `UV_HANDLE_CLOSING`，退出码 `3221226505`。正常 Node worker 改为 `process.exitCode=0` + IPC disconnect 后自然退出，断开监听识别主动 dispose；Electron utilityProcess 保持原退出路径。真实 Node IPC 回执与退出测试、源码 HTTP 工具冒烟通过，Windows 真正修复与否待 CI。
- 对照 [Node 上游同类强制退出问题](https://github.com/nodejs/node/issues/58091)定位，不把上游报告当本仓修复通过证据，也不放宽退出码门禁。
- 因已有 `.10` Linux 产物且新增主线 GUI 代码，本轮最终候选递增到 `1.0.0-test.11`；Windows AI 应等待包含全部提交的 `.11` 安装包。

## 最终本批出包结果

- `c1f22c11` 修正 Node IPC 可选类型，`65eee950` 修正主线带入的单条格式问题；`b6aa0844` 修复无效问答被活动状态层误记为等待确认，以及三个主线旧静态断言。
- 本机补修小批 5 文件 81 项通过；全仓 Biome 1131 文件通过，agent-host 类型检查通过。此前本机根 tsc OOM 已由后续 CI 根 tsc 通过补齐。
- [34308304362](https://github.com/p1p1dan/ai-client/actions/runs/34308304362) 对 `b6aa0844` 完整门禁通过：350 文件 4987 项；Windows/Linux 两后端均 exitCode 0。Windows trace 指向包内 Node 24.18.0，native carrier 为 bundled-node，Linux 为真实 utilityProcess。
- `1.0.0-test.11` Windows 安装包、portable、unpacked 已上传；证据和 Actions ZIP 摘要见 [最终交付目录](ci-34308304362/README.md)。未下载大型安装包到本机、未本地打包、未创建 tag/Release。
- native 录制/replay 已适配授权详情折叠，新增真实记录展开 DOM 用例；审计未删除。主线 GUI 清单全部仍待现场签收。
- macOS 同轮未结束，因此这里只签收已结束 job，不将整次 CI 或 P4-6 标 Done。
