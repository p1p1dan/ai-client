# Windows-P4-6 验收记录

> 更新：2026-09-09（校正到 test.11 交付后）· 分支 `feat/runtime-evolution` · 当前 HEAD `a6ebf5fc`（证据提交）；**本文件验收的源码提交为 `b6aa0844`**（test.11，见 `docs/plantree/plans/runtime-evolution/evidence/p4-6/ci-34308304362/README.md:3`）
> 原始证据：`Windows-P4-6-evidence/`（environment.md · tests-results.md · q7-fix-verification.md · linux-side-punch-list.md）
> 权威口径：ARD D8/D11/D13/D14/D16 / 看板 / [P4-6 交接](../../../docs/plantree/plans/runtime-evolution/evidence/p4-6/README.md) / [test.11 交付](../../../docs/plantree/plans/runtime-evolution/evidence/p4-6/ci-34308304362/README.md)
> **本文件为 Windows 侧只读分析，未修改产品/测试源码、package.json、锁文件、CI 工作流；未本地打包；未推 tag/Release/main。**

---

## 0. 结论摘要（截止 test.11）

- **源码分析完成**，**部分源码测试通过**（本机核对）。
- **test.11 / `b6aa0844` 的 CI 已通过并出包**，Windows/Linux 双载体 legacy+native 真实 Read/bash 工具冒烟（`34308304362`）均 **exitCode 0**，native trace 确认 `carrier=bundled-node`、`node_source=bundled`、`node_exec_path=…node-runtime\node.exe`（随包 Node v24.18.0）。
- **关键：我此前独立发现的 B1（native worker 未传 shellPath → bash `shell_unconfigured`）已被远端 `76424efa` 修复**（`nativeWorkerRuntime.ts:136` 增 `shellPath: resolveWorkerShell(...)`，新建 `host/shell.ts`），且修复被 Windows CI 的 native `probe_bash` 冒烟证实（`policy_allow`、工具执行成功）。
- **仍待执行**：Windows 现场验收（真实安装应用 GUI、命令树专项、企业加密专项、主线 GUI A～E 清单）；**macOS 同轮 CI 仍在运行，P4-6 与 P1 整体仍未完成**。

---

## 1. 环境与是否具备企业加密条件（本机实测）

| 项 | 值 | 备注 |
|---|---|---|
| OS | Windows 11 Pro 10.0.26100 (24H2) | AMD64 · Gigabyte Z790 UD |
| RAM | ≈31.8 GiB | 本机资源充足（有别于 AGENTS.md 描述的 Linux 低资源机） |
| 磁盘 | C 空闲≈149G / D 空闲≈1520G / E 空闲≈966G | |
| PowerShell / Git | 5.1.26100.9168 / 2.45.2.windows.1 | |
| Node/npm | v24.18.0 / 11.18.0 | PATH=`C:\nvm4w\nodejs`；pnpm 经 corepack(10.26.2)（实跑 worker 崩溃，改用 npm 安装） |
| **企业加密驱动** | ✅ 已装且运行 | `TsdEncrypt.sys`、`TsdEncryptMF.sys` Running；`Ocular3Path`(TEC OCular) 在 `C:\Windows\SysWOW64`；`TOfficeOperation.exe` 在跑 |
| 其他安全代理 | aTrust / sprotect / HipsTray / DSATray | Sangfor aTrust VNIC Stopped（非文件加密驱动） |
| 已装旧 AiClient | **1.0.0-test.9**（`D:\Program Files\AiClient`，运行中） | CI 34207032908，来自主工作分支；随包 node.exe 在，**无** `resources/git/bin/bash.exe`；**不是 test.11** |
| 参考仓 (pi-app/pix) | ❌ 不可达 | AGENTS.md 指向 Linux `/home/ai/code/*`，未读取，如实记录 |
| Git Bash 实际路径 | `C:\Program Files\Git\bin\bash.exe`（+ `C:\Program Files\Git\usr\bin\bash.exe`） | 系统 Git for Windows；test.11 的 bash 载体来源 |

**企业加密条件：具备**（本机在 TEC OCular/TSD 加密机箱内）。**但加密策略作用于哪些测试目录尚未证实**——现有探针用系统 temp 目录，可能不受策略作用。**不能据此签收加密专项**（见 §5/§6）。

---

## 2. 源码提交 / 测试包版本 / CI run / 实际进程路径

| 项 | 值 |
|---|---|
| 源码提交（本次验收目标） | **`b6aa0844`**（test.11） |
| 证据提交（HEAD） | `a6ebf5fc`（docs evidence，含本批分析文档） |
| 版本 | **1.0.0-test.11**（`artifacts.json:4`） |
| CI run | **34308304362**（`artifacts.json:2`） |
| 门禁 | 350 文件 / 4987 项测试、三道 typecheck、Biome、runtime 两条离线冒烟、发布元数据全过 |
| Windows installer digest | `sha256:36dca45b…84f0c`（Actions ZIP，非解压后 exe） |
| Windows portable digest | `sha256:bc98daf4…1f088` |
| Windows unpacked digest | `sha256:ac66c9e3…65dc` |
| Windows CI native trace | `node_exec_path=…dist\win-unpacked\resources\node-runtime\node.exe`（v24.18.0），`carrier=bundled-node`，`node_source=bundled` |
| 本机旧包路径 | `D:\Program Files\AiClient\AiClient.exe`（test.9，非 test.11） |

---

## 3. 当前 TODO（test.11 交付后）

**出包前缺陷已全部闭环**（本机核对 + 交接文档确认）：
1. ✅ CI 样本缺 2 个 runtime helper → 已补并增加逐个缺失即失败用例。
2. ✅ 三个打包 job 未装 src/runtime 依赖 → 已装（`build.yml:224/383/499`）。
3. ✅ 打包冒烟未接 native → `verify-packaged-app.mjs` 对 legacy/native 双 lane 串行跑，本地 SSE 替身驱动真实 read/bash，native 另核 trace 后端/载体/Node 路径与权限审计。
4. ✅ native worker 未传 shellPath → `resolveWorkerShell`（`host/shell.ts`）接线，Windows 关键修复。

**待执行（现场验收，需 test.11 安装包）**：
- Windows 真实安装应用启动、native+随包 Node 确认、六项工具探针（`p1-bundled-node`）。
- 命令树清理验收（正常/超时/取消/父先退/应用退出五态）。
- 打包 GUI：权限 plan/agent + ask/accept-edits/auto、允许/拒绝/取消与审计行、用户气泡去重、附件、停止恢复、会话恢复/压缩、GUI/TUI 切换。
- 企业加密专项：Read 明文、Write/Edit 后 GUI/TUI/编辑器一致、bash `pwd·ls·echo`、Main Git diff/冲突编码/二进制判定、分支/状态异常不空、退出无残留。
- 主线 GUI A～E 现场清单（`docs/plantree/plans/gui-sdk-experience/现场验收清单.md`）。

---

## 4. 重点源码静态分析（头号发现已获远端修复确认）

以下为**本机复核**的事实，分类：A=静态可确认；B=需 Windows 实测；C=需 CI 测试包；D=需企业加密现场。

### 4.1 native worker bash 载体（原"阻塞"B1 —— **已修复**）

| # | 结论 | 位置 | 状态 |
|---|---|---|---|
| 1 | 修复前：`nativeWorkerRuntime.ts` 只传 `tools:{cwd}`，bash 无 `shellPath` 即抛 `shell_unconfigured` | `tools/index.ts:307` | ✅ 已修复 |
| 2 | 修复后：`tools:{ cwd, shellPath: resolveWorkerShell(host.childEnv) }` | `nativeWorkerRuntime.ts:136` | ✅ |
| 3 | `resolveWorkerShell` 在 Windows 探测 `Program Files\Git\bin\bash.exe`、`ProgramFiles(x86)`、`LOCALAPPDATA`、原生 PATH；排除 WSL launcher / system32-32 / 相对路径；Unix 优先 `/bin/bash` | `host/shell.ts:6-36` | ✅ 5 项单测 |
| 4 | **bash 载体 = 系统 Git for Windows**（非随包 bash；本仓不打包 git/bash） | `shell.ts` / `electron-builder.yml` / 已装包 | ⚠️ 需现场确认加密策略影响 |

**注意**：test.11 放弃"随包 bash"，采用系统 Git Bash。这与 ARD §8"随包载体是现场已验证的白名单载体"的动机有张力——但它们的交接文档（`p4-6/README.md:31`）明确"不引入 pi-coding-agent 新依赖、不采用 WSL/sh 隐式回落"，且 Windows CI 的 native bash 冒烟通过。**这是它们的实现决策，我在 Windows 现场验收时按实际行为记录**。

### 4.2 载体 / host / 进程树 / D13 / D5（与旧结论一致，部分已实测）

| # | 结论 | 位置 | 状态 |
|---|---|---|---|
| 5 | Windows 安装版 worker 走随包 node.exe，缺失即失败不回落 | `PiWorkerProcess.ts:69-82` | A |
| 6 | carrier 判定（parentPort→electron-utility，否则 bundled-node）；bundled 下 node.path=process.execPath | `worker.ts:61` / `host/worker.ts:48-83` | ✅ CI native trace 证实 |
| 7 | Windows 进程树清理 taskkill /PID /T /F（含 runner disconnect 清整树） | `exec.ts:190-212` / `exec-runner.mjs:26-37` | B（单测过，现场待验） |
| 8 | D13：Main 读用户文件走 `readFileTsdSafe`（优先随包 node.exe，`AICLIENT_TSD_NODE_PATH` 覆盖）；Git/Worktree 读走 `readWorkingTreeFile/detectBinaryFile` | `tsdSafeRead.ts` / `encoding.ts` / `GitService.ts` / `WorktreeService.ts:648` | ✅ 静态确认；驱动解密未在受策略目录实测 | 
| 9 | P4-5 四处事件缺口（permission.activity / attemptId / attachments / 内部条目）已修，录制+重放为回归防线 | `guiEventContract.test.ts` | ✅ 本机 5 项过，1 项路径分隔符差异 |

### 4.3 Q7 git 面板空结果修复（`b984b282`）—— **本机实测确认正确**

- 三处判据符合提交说明：`getBranches` 用 `rev-parse --verify HEAD` 区分真 unborn 与列表丢失（`GitService.ts:330-366`）；porcelain reader 拒绝"0 退出码+无 `# branch.*`"（`640-690`）；`truncated/timedOut` 拆分、超时明确失败（`515,649-687`）。
- **本机实测**：`gitStatusFailureModes.test.ts` 6 项全过 + 真实仓库 4 项全过（健康仓库不再误标 `(no commits yet)`、getStatus current=main、getFileChanges 正常报出改动）。详见 `Windows-P4-6-evidence/q7-fix-verification.md`。
- **边界**：Q7 只覆盖"git stdout 拿不到→误报空"；若受 TSD 加密目录仍现空，是 D13/Q5 另一成因，不在 Q7 范围，归 P4-6 现场。

---

## 5. 现场验收状态：通过 / 失败 / 未执行 / 不适用

> 以 `b6aa0844` + test.11 为基线。**现场必需项一律未执行**，不用 CI 冒烟代替；CI 已覆盖的只在"CI 验证"栏注明。

| 项目 | 状态 | 说明 |
|---|---|---|
| 源码分析完成 | ✅ | 两轮静态 + 本机实测 |
| typecheck:runtime / agent-host | ✅ 通过 | exit 0 |
| runtime 离线冒烟 (smoke:runtime) | ✅ 通过 | 6 项断言 |
| standalone 六项探针 (smoke:runtime-tools) | ✅ 通过 | read/edit/bash/glob/grep/trace；**系统 PATH node，非随包 node** |
| runtime 核心测试（host/workerCarrier/hostBoundary/session/events/tools/nativeRuntime/endToEnd/gui/newContext/context/prompt 等） | ✅ 通过 | 平台排除项除外 |
| CI 失败样本复现 | ✅ 已复现 | 确认样本缺 2 helper，非安装包缺陷 |
| **test.11 CI 双载体冒烟（legacy/native Read/bash/退出）** | ✅ CI 通过 | `34308304362`；Windows/Linux 均 exitCode 0 |
| **真实打包应用本身**（Main/preload/renderer 全链路，非从仓库 Electron 启动 worker） | ❌ 未执行 | CI 用仓库 Electron 启动已打包 worker，不等同安装应用 |
| **随包 node 六项探针 (p1-bundled-node)** | ❌ 未执行 | 需 test.11 安装包 + 该系统提交的源码/runtime 依赖 |
| **命令树清理五态** | ❌ 未执行 | 需 test.11 |
| **打包 GUI 点验**（权限/附件/气泡/停止/恢复/切换） | ❌ 未执行 | 需 test.11 |
| **企业加密专项**（明文/一致/bash/Git diff/无残留） | ❌ 未执行 | 需 test.11 + 受策略目录 |
| **主线 GUI A～E 清单** | ❌ 未执行 | 需 test.11 |
| **Windows bundled-node 替代 Linux/macOS electron-utility？** | 否 | D11 按载体矩阵签收 |

---

## 6. 本机已执行命令与结果（节选）

| 命令 | 预期 | 实际 | 结果 |
|---|---|---|---|
| `tsc --noEmit -p src/runtime/tsconfig.json` | exit 0 | exit 0 | ✅ |
| `tsc --noEmit -p src/agent-host/tsconfig.json` | exit 0 | exit 0 | ✅ |
| `vitest run scripts/__tests__/agent-host-build-lib.test.mjs` | 20 pass | 19 pass / 1 fail（样本缺 2 helper） | ✅ 复现（修复前基线） |
| `vitest run host/workerCarrier/hostBoundary.test.ts` | pass | 24 pass | ✅ |
| `vitest run session/…/runtimeEvents.test.ts` | pass | 49 pass | ✅ |
| `vitest run tools.test.ts` | 36 pass | 33 pass / 3 fail（`/bin/bash` ENOENT，平台排除） | ⚠️ 平台 |
| `vitest run workerEndToEnd.test.ts` | 11 pass | 11 pass | ✅ P4-4 |
| `vitest run guiEventContract.test.ts` | 6 pass | 5 pass / 1 fail（`\` vs `/`，平台排除） | ⚠️ 平台 |
| `node src/runtime/smoke/runOnce.ts --offline` | pass | PASS（6 项） | ✅ |
| `node src/runtime/smoke/p1-standalone.ts` | pass | PASS（六项全 true，standalone-node） | ✅（系统 node） |
| `vitest run gitStatusFailureModes.test.ts` | 6 pass | 6 pass | ✅ Q7 |
| 真实仓库 Q7 验证（临时文件，已清理） | 4 pass | 4 pass | ✅ Q7 |

**依赖安装说明**：pnpm install 在 worker 处崩溃（原因未定位，疑与安全/加密驱动拦 pnpm 提取 worker），改用 npm install；装完还原 package-lock.json 至原状。未改任何 package.json/锁文件。

---

## 7. 需要用户手工完成的最少步骤（拿到 test.11 安装包后）

> 已在 `ci-34308304362/README.md` 给出 `gh run download` 下载与 `AICLIENT_RUNTIME_BACKEND=native` 启动指引。本机侧建议操作：

1. 退出旧 AiClient（`D:\Program Files\AiClient`，test.9），避免单实例把请求交给旧进程。
2. `gh run download 34308304362 --repo p1p1dan/ai-client --name windows-installer --dir "$env:USERPROFILE\Desktop\aiclient-test11"` 安装或解压 `windows-unpacked`（固定目录，避免 portable 临时路径漂移）。
3. `Get-FileHash` 核对 exe SHA-256 与 `artifacts.json`（**注意 digest 是 Actions ZIP 的，不是解压后 exe**）。
4. 同一 PowerShell 会话：`$env:AICLIENT_RUNTIME_BACKEND='native'` + `$env:AICLIENT_RUNTIME_TRACE_DIR=<独立目录>`，启动安装的 exe；以 native trace（`stamp.backend==='native'`, `carrier==='bundled-node'`, `node_exec_path` 为包内 node.exe）确认后端生效，**不能只看能聊天**。
5. 逐项回填：六项探针、命令树五态、GUI 权限/附件/气泡/停止/恢复/切换、企业加密专项、主线 GUI A～E。
6. 每项留通过/失败/未执行与证据；不会桌面操作的 AI 集中列出需用户点击的步骤，**不用源码分析代替 GUI 实测**。

---

## 8. 注意事项 / 交接边界

- **Windows bundled-node 通过 ≠ Linux/macOS electron-utility 通过**（D11 第 6 条）。
- **完整测试包 CI 冒烟通过 ≠ 真实安装应用通过**（CI 从仓库 Electron 启动 worker，非完整 renderer/main 链路）。
- **普通 Windows 通过 ≠ 企业加密机通过**；且现有探针用系统 temp 目录，若不受加密策略作用，**不能签收加密专项**。
- macOS 同轮 CI 仍在运行，**不能把整次 CI 或 P4-6/P1 整体标 Done**。
- 分享 trace/log 前脱敏 token、API key、认证 header。
