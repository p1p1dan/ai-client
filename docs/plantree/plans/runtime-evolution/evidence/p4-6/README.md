# P4-6 接棒状态与现场分工

2026-09-09 · 状态：准备中，未出测试包、未完成载体验收。
权威：[看板](../../README.md) / [ARD D11、D13、D16](../../../../../plans/2026-09-08-runtime-evolution-ard.md)。

## 已核实

- P4-5 提交 `9edab07c718e3ceeb1498d841fa2783322d570cd` 已推送 `feat/runtime-evolution`。
- [手动 Build 34303440949](https://github.com/p1p1dan/ai-client/actions/runs/34303440949) 已失败：三道 typecheck、lint 通过；336 个测试文件中 335 通过、1 失败，4925 项中 4924 通过、1 失败。后续构建/打包及发布任务全部跳过。
- 唯一失败是 `scripts/__tests__/agent-host-build-lib.test.mjs` 的 `accepts a worker-only Pi artifact`：测试样本缺 `runtime-helpers/exec-runner.mjs` 和 `runtime-helpers/tsd-read.mjs`。校验器已要求两文件，实际构建脚本也已有复制逻辑；不能据此认定真实安装包缺文件。
- Claude 交接的本机 4915 项与本次 CI 4925 项统计不同，本轮采用实际 CI 结果，不将旧报告当作最新门禁通过证据。
- 版本基准复核：用户日常主工作分支 `feat/model-catalog-admin` 的远端 `package.json` 已为 `1.0.0-test.9`；此前成功的 [CI 34207032908](https://github.com/p1p1dan/ai-client/actions/runs/34207032908) 来自该分支。当前 runtime 分支仍留 `0.4.0-test.8`，这不是最新测试版。GitHub 字面 `main` 仍为 `0.3.4`。下一次 runtime 测试包按 `1.0.0-test.10` 准备，出包前再查是否已被占用；目前仅更新计划，尚未修改 `package.json`，不通过合并另一分支来同步版本。

## 出包前待办

1. 修复有效产物测试样本；保留两个 helper 的强制校验。
2. 各平台 worker 打包 job 安装 `src/runtime` 独立依赖。目前只有 gate 安装，各 job 不共享工作目录；尚未跑到打包阶段，属于静态发现的缺口。
3. 补 native 打包冒烟。现有 `scripts/packaged-worker-smoke.cjs` 默认 legacy，且断言旧扩展加载，不能直接代表 native；使用本地 HTTP SSE 模型替身驱动真实工具，并记录后端、载体、可执行文件和退出结果。
4. 手动 CI 成功后交付 Windows installer / unpacked 及验收说明。包名/版本可递增，只推任务分支、`workflow_dispatch`；禁止本地打包与推 tag。

新增代码/工作流修复尚未授权；本轮仅同步文档。用户已授权任务分支推送与手动 CI，并确认拥有 Windows + AI 环境。

## 环境分工

| 环境 | 工作 | 验收边界 |
|---|---|---|
| 当前 Linux 开发机 | 定位问题、获授权后改代码、小批测试、维护交接与回收证据 | 无需为此次出包装 Windows/完整打包环境；不本地打包 |
| 远端 CI | 干净安装依赖、完整门禁、各平台打包、真实 worker 的 native 冒烟 | CI Windows 不具备企业加密驱动；不能代签加密场景 |
| 用户 Windows + AI | 下载同一提交的包，固定安装/解压路径，确认 native + 随包 Node，执行工具、审批、会话与进程检查，收集日志 | 运行安装包不要求先装 Node/pnpm/Visual Studio；若运行现有源码探针，需要另准备对应源码与 runtime 依赖 |
| 企业加密 Windows | 同一包/矩阵下核验驱动相关明文读写、Main diff/冲突编码/二进制判定、GUI/TUI 一致性与进程残留 | 普通 Windows 通过不能代签；是否就是用户现有 Windows，待确认 |

## Windows 交接范围（待产物成功后补精确命令）

- 安装包与源码提交一致；记录版本、CI run、实际 exe/node.exe/bash.exe 路径。
- 关闭已有应用后，从设置了 `AICLIENT_RUNTIME_BACKEND=native` 的启动环境打开测试包；以 worker 证据确认实际后端，不能只看能否聊天。
- P1-8 复用六项断言：read、edit、bash、glob、grep、trace；write 是探针前置动作。现有入口为 `src/runtime/smoke/p1-bundled-node.ts`，依赖源码及 runtime 包，不是复制一条命令即可在裸安装包旁运行。
- P1-0/P1-3：正常退出、超时、取消和父命令先退出的命令树清理，核对 runner/taskkill 与残留进程。
- P1-5/P1-6/P4-5：权限两模式/三档及策略重载、审计行、附件、用户气泡去重、会话恢复/压缩、GUI/TUI 交接。
- D13/Q7：普通 Windows 先验证 Git/工作区行为；企业加密环境另核对明文内容与错误可见性。
- 每项记录通过/失败/未执行、输入、预期、实际、日志或截图；两种产品载体分别签收，Windows bundled-node 不替代 Linux/macOS electron-utility。
