# P4-6 交回 Linux 侧事项清单（test.11 交付后校准）

> 生成：2026-09-09 · 来源：Windows 侧只读分析 + 本机实测（主机带 TsdEncrypt 企业加密驱动）
> **本清单已按远端 `a6ebf5fc`（源码基线 `b6aa0844`，test.11）校准**：原"阻塞/必须"项大多已被远端修复，此处只保留**修复确认**与**仍待现场/决策**的内容，避免把已修复当缺陷提交。
> 配套证据：`environment.md` · `tests-results.md` · `q7-fix-verification.md`

---

## ✅ 已确认被远端修复（无需再改，仅留痕）

### 原 B1（阻塞）· native worker 无 bash 载体 —— **已修复**
- 修复提交：`76424efa fix(runtime): 补齐 native 打包门禁与 shell 接线并升级测试版`
- 证据：`nativeWorkerRuntime.ts:136` 现传 `shellPath: resolveWorkerShell(this.options.host.childEnv)`；新增 `src/runtime/host/shell.ts`（`resolveWorkerShell`）+ `src/runtime/__tests__/workerShell.test.ts`（5 项，含"不选 WSL launcher / 不选 system32-32 / 不选相对路径"）。
- 本机核对：与交接文档 `p4-6/README.md:21`（"新发现并修复 native worker 未传 shellPath"）互相印证。
- **CI 证实**：Windows native 冒烟 `probe_bash` 成功（`policy_allow`，工具执行、结果回传、exit 0）。

### 原 M1（必须）· CI 样本缺 2 个 runtime helper —— **已修复**
- `scripts/__tests__/agent-host-build-lib.test.mjs:64-65` 已生成 `runtime-helpers/exec-runner.mjs` + `tsd-read.mjs`；`246-250` 新增"逐个缺失即失败"用例，未放宽校验器。

### 原 M2（必须）· 打包 job 未装 src/runtime 依赖 —— **已修复**
- `build.yml:224`（windows）/`383`（linux）/`499`（macos）均新增 `npm ci`（working-directory: src/runtime）。

### 原 M3（必须）· 打包冒烟未接 native —— **已修复**
- `verify-packaged-app.mjs` 现对 **legacy/native 双 lane** 串行跑（`203`），`packaged-worker-smoke.cjs` 用本地 SSE 替身驱动真实 read/bash，native 断言 `stamp.backend==='native'`、`carrier==='bundled-node'`、权限审计存在、`workerExecutable` 记录随包 node。
- CI `34308304362` 已产出 Windows/Linux 的 legacy+native 双份冒烟证据（`ci-34308304362/{windows,linux}/worker-smoke-report.json`）。

**另两项新修复（远端本轮）**：native bundle 启动 `Dynamic require of "process"` 补 ESM `createRequire` banner；Node worker 自然退出（`process.exitCode=0` + IPC disconnect，避免 `UV_HANDLE_CLOSING` 强杀）。

---

## 🟠 仍待 Linux 侧**决策/确认**（非缺陷，但影响 Windows 现场签收口径）

### D1. bash 载体 = 系统 Git for Windows，非随包 bash —— 与 D11 白名单动机的张力
- test.11 用 `resolveWorkerShell` 找系统 `C:\Program Files\Git\bin\bash.exe`，**本仓不打包 git/bash**（`electron-builder.yml` 无此资源；`afterPack.mjs` 只放 agent-host + node-runtime；已装旧 test.9 包也确认无 `resources/git/bin/bash.exe`）。
- ARD §8 修复动机是"随包 node.exe 是现场已验证的白名单载体"；现在 bash 改走系统路径，**不在随包白名单内**。若企业加密驱动按进程名/签名放行给 `bash.exe`，则 OK；若不是，native bash 在加密机可能重蹈 GUI 的句柄/密文问题。
- **建议**：Windows 现场验收时**优先测**企业加密策略下的 `bash pwd/ls/echo`；若失败，交回 Linux 侧考虑随包 Git Bash（体积/msys2 依赖代价）或重新评估载体。
- 交接文档 `p4-6/README.md:31` 已声明"不采用 WSL/sh 隐式回落、不引入新依赖"——该决策是否与加密机现实冲突，需现场数据说话。

### D2. macOS job 同轮 CI 仍在运行 —— 不能把整次 CI / P4-6 标 Done
- `ci-34308304362` 的 macOS 未结束；Linux/Windows 已过。**等 macOS 收尾再整体签收**。

---

## 🟡 平台敏感 / 可选（不阻塞，但影响 Windows 现场回归干净度）

### S1. `guiEventContract.test.ts` —— 路径分隔符致 1 项红（非逻辑缺陷）
- 录制 JSON 含 `<workspace>/notes.txt`（Linux 正斜杠），Windows 下 `permission.activity` 的 `value`/`title` 变 `<workspace>\notes.txt`。其余 5 项（P4-5 四处缺口断言）全过。
- 可选修复：录制/断言路径归一化（`projectInstructions.ts:94 normalizeStablePath` 已有先例），或把录制当结构契约而非字节比对。

### S2. `projectInstructions.test.ts` —— POSIX 根路径在 Windows `resolve` 引入盘符
- `ROOT='/work/repo'`（无盘符），`projectInstructions.ts:132-133` `resolve('/work/repo')` 得 `E:\work\repo`，`fakeSource.realpath` 不匹配 → 误判越界 → 9 项失败。**不影响真实文件系统**（真实路径带盘符）。
- 可选修复：测试改用平台无关路径构造。

### S3. 多处测试硬编码 `/bin/bash`（Linux 专属）
- `shellPolicy.test.ts:28`、`tools.test.ts`（3 项）、`nativeWorkerRuntime.test.ts`（极少）报 `spawn /bin/bash ENOENT`。核心逻辑均过。
- 可选修复：用 `process.env.AICLIENT_PROBE_SHELL` 或 win32 分支给真实 shell，便于 Windows 一并回归。

### S4. `nativeWorkerRuntime.test.ts` 1 项路径分隔符差异
- 断言 `file:'/agent/sessions/logical-1.jsonl'`，Windows `join` 出反斜杠。可选修复：断言用 `path.join` 或 normalizeStablePath。

---

## 📋 修复后/出包后的现场验收清单（Windows 侧，test.11 已具备）

| 阶段 | 项 |
|---|---|
| 产物身份 | 记录 test.11 版本、文件、SHA-256、CI run、源码提交 `b6aa0844`；实际 exe/node.exe/Git Bash 路径 |
| 启动与载体 | 退出旧应用；`AICLIENT_RUNTIME_BACKEND=native` 启动；用 native trace（backend/carrier/node_exec_path）确认，不能只看能否聊天 |
| 工具探针 | 复用 `p1-bundled-node.ts`（随包 node.exe 执行，bash 用实际 Git Bash 路径；源码 probe 需要该系统提交的 runtime 依赖） |
| 命令树清理 | 正常/超时/取消/父先退/应用退出五态，核对 runner/taskkill 与进程残留 |
| 打包 GUI | 权限 plan/agent + ask/accept-edits/auto、允许/拒绝/取消与审计行、用户气泡去重、附件、停止恢复、会话恢复/压缩、GUI/TUI 切换 |
| 企业加密专项 | 受策略目录：Read 明文、Write/Edit 后 GUI/TUI/编辑器一致、bash `pwd·ls·echo` 正确、Main Git diff/冲突编码/二进制判定、分支/状态异常不空、退出无残留 |
| 主线 GUI | A～E 现场清单（`docs/plantree/plans/gui-sdk-experience/现场验收清单.md`） |

---

## 附：修复验证链路（本机实测）

- 修复前基线复现：`agent-host-build-lib.test.mjs` 唯一失败（样本缺 2 helper）→ **印证交接判断"非安装包缺陷"**。
- 本机验证：typecheck(runtime/agent-host) 通过、runtime 离线冒烟 + standalone 六项探针通过、host/workerCarrier/hostBoundary 24 项、session/events 49 项、workerEndToEnd 11 项、guiEventContract 5 项、context/prompt 等通过；Q7 `gitStatusFailureModes` 6 项 + 真实仓库 4 项通过。
- 平台排除（非缺陷）：`/bin/bash` ENOENT、`resolve` 引入盘符、`<workspace>\` 分隔符。
- Windows CI（test.11）确认 native/legacy 双载体 Read/bash/exit 0。
