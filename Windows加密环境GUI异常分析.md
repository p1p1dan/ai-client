# Windows 加密环境下 GUI 工具异常：简要分析

日期：2026-09-08。原异常版本：Windows installer，提交 `a2073fae`，CI run `34200881263`。修复验证版本：提交 `45d43db8`，CI run `34207032908`。

## 结论

**GUI 与 TUI 的实际进程载体不同，是本次必须修正的兼容性边界。**
同一安装包、同一机器、同一仓库：用户确认 GUI Read 返回异常内容，bash 报 `Bad file descriptor`，TUI 正常；右侧编辑器也正常。
这不是“使用 TypeScript/Node API 就一定兼容加密环境”的充分条件。

**现场更新（2026-09-08）**：用户安装本次随包 Node 修复包后确认“确实 GUI 也可以读取到内容了”。GUI 读取恢复已获得现场证据；bash、Write/Edit 与退出清理尚未收到现场确认。

## 已确认事实

| 路径 | 实际执行方式 | 证据 |
|---|---|---|
| 原异常版 GUI Pi worker | `utilityProcess.fork`，运行在 Electron 的进程载体中；Pi Read 默认直接调用 `fs/promises.readFile` | 原版本 `PiWorkerProcess.ts`；Pi SDK `core/tools/read.js` |
| 修复版 GUI Pi worker | 随包 `node.exe` 启动完整 worker，包含 Read/Write/Edit 等工具 | 提交 `45d43db8`；用户安装新包后确认 GUI 可读取内容 |
| TUI | 使用安装包 `resources/node-runtime/node.exe` 启动 Pi CLI，终端使用 PTY | `PiTuiPty.ts`；用户现场确认可用 |
| 编辑器 | 识别 `%TSD-Header-###%` 后，调用系统 `node` 读取明文 | `previewFileRead.ts` → `tsdSafeRead.ts` |
| GUI bash | Pi SDK 使用 `child_process.spawn`，stdout/stderr 为管道 | SDK `core/tools/bash.js`；现场错误含 `pwd/ls/echo: write error` |
| CI 覆盖缺口 | 旧检查验证 worker bootstrap/dispose/exit，以及安装包本身没有 TSD 头；未运行会话内 Read/bash，也没有企业加密驱动 | `verify-packaged-app.mjs`、`packaged-worker-smoke.cjs` |

`Allowed … from bundled` 只表示应用权限插件放行，不能证明操作系统/加密驱动允许该进程读取明文或使用输出句柄。

## 根因判断与证据边界

- **读取异常：切换为随包 Node 已在现场恢复读取，支持进程执行环境导致兼容差异的判断。** 原 GUI Read 没有编辑器的兼容路径；TUI 与修复后的 GUI 通过独立 node.exe 正常。异常字节是否包含 TSD 头，以及驱动按进程名、路径、签名还是父进程规则放行，仍未直接取证；读取恢复不等于已经证明具体驱动机制。
- **bash：已确认是命令输出句柄失败，不能归为 Markdown 编码错误。** 无需读文件的 `pwd/echo` 也失败。GUI 与 TUI 除进程身份外还有 pipe/PTY 差异；具体是 Electron、Git Bash/MSYS2 还是企业驱动的组合效应，尚未有现场 A/B 证据定案。[上游也有同类报错记录](https://github.com/anthropics/claude-code/issues/26486)，它不是本机根因的证明。
- 两种错误可能共享 GUI 执行环境这个触发条件，**目前不能声称已经证明它们是同一个底层缺陷**。

## 已接受的修复边界

用户明确接受：[D20](docs/plantree/plans/pi-backend-migration/decisions/020-windows-bundled-node-worker.md)。

1. Windows **安装版** GUI worker 使用与 TUI 相同的随包 node.exe；不自动回落到已知异常的 Electron worker。
2. 保持 Main → bounded WorkerManager/WorkerSlot → 一进程一 AgentSession；保留 generation、权限、会话隔离与现有 RPC。通信使用 Node 原生 IPC，不引入 NDJSON 或额外 supervisor。
3. 同步处理父进程断开、worker 退出和普通 stdout 排空。开发模式及其他平台继续原执行路径。
4. 既有打包检查改走真实平台后端，并通过本地模型替身驱动真实 Read/bash 工具，不调用线上模型。

## 对后续演进的影响

- 自有 runtime/Cordis 方案可以继续，**执行器必须区分独立 Node 与 Electron 内嵌 Node**。Windows 加密兼容应成为平台执行后端的约束，而不是临时塞进单个 Read 工具。
- 文件读取、编辑、写入、技能/提示词加载、子进程和会话文件都受执行身份影响。只补 Read 无法覆盖这些路径。
- 之前“Rust 不可行、Node 不受影响”的结论过宽：现有事实证明的是特定二进制/启动方式在特定机器上的差异，不能仅按实现语言判断。
- 普通 GitHub runner 的通过不能替代企业加密机验收。今后升级 Electron、随包 Node、Pi SDK 或调整进程拓扑，都应复看同文件的 GUI/TUI/编辑器结果。

## 验证状态

- [x] 用户确认同包 GUI 失败、TUI 与编辑器正常；源代码路径差异已核实。
- [x] 用户接受 Windows 安装版改用随包 Node。
- [x] 代码与本地验证完成：主进程改动文件类型检查、worker 类型检查、6 个相关测试文件通过；真实构建 worker 的 Node IPC 与 Electron 两条路径均完成 Read/bash、bootstrap/dispose/exit；Node 父 IPC 断开后真实 worker 退出码为 0。
- [x] 新 Windows 安装包的普通 CI 工具验证通过：提交 `45d43db8`，CI [34207032908](https://github.com/p1p1dan/ai-client/actions/runs/34207032908) 全部成功；Windows 包内 Node IPC 的真实 Read/bash、bootstrap/dispose/exit 通过。质量门禁为两套类型检查、Biome、307 个测试文件 / 4600 个测试及 release metadata。
- [x] 加密机 GUI 读取：用户安装本次修复包后确认 GUI 可以读取内容（2026-09-08）。
- [ ] 加密机 bash：`pwd/ls/echo` 正常。
- [ ] 加密机 Edit/Write：写入后编辑器与 TUI 内容一致。
- [ ] 加密机退出清理：关闭程序无残留 worker。

GUI 读取项已通过现场验收；T39 其余工具与退出清理项继续待验收，不据此扩大为全部工具已通过。

本地环境为 Linux，无企业加密驱动。验证只构建 Agent Host 单阶段，不在低资源主机执行整套生产构建。

新包下载：[windows-installer](https://github.com/p1p1dan/ai-client/actions/runs/34207032908/artifacts/10048590787)，安装程序 `AiClient Setup 1.0.0-test.9.exe`。版本号与上一包相同，请按本次 CI 编号区分。只生成 Windows installer；Linux/macOS/remote Linux 打包任务均跳过。
归档包 SHA-256：`bfbf3c54efe443937b22fa249e5e755a641f53c8acb71af929792d94a6dacfb4`（GitHub artifact zip，不是内部 exe）。
