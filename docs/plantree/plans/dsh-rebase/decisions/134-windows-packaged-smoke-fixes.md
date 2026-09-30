# 决策 134：Windows 打包冒烟 L1 三项失败的修复与取舍

日期：2026-09-29。**状态：自主决定，待用户审批。**

依据：

- 第一次 Windows 打包构建（build.yml 的 build-windows，run 36602434283，提交 `a8cce6f2`）：`packaged-dsh-host-smoke.mjs --level 1` 的 44 项败 3 项：`l1PilotWriteAskedReadRan`、`l1RipgrepFromArtifact`、`nativesPtyRan`。P1-13c 在真 Windows 桌面机上跑 L1 基线，后两项同样失败。
- [决策 017](017-packaged-smoke-runs-tool-turns.md)：打包冒烟要跑工具回合。
- [决策 090](090-user-rulings-2026-09-28.md)：默认跟随 DSH 的做法；只做 Linux 与 Windows。
- 权限行的相关决策：042、047、048、097、112。

## 结论一览

| 失败项 | 根因 | 性质 | 修法 |
|---|---|---|---|
| `l1PilotWriteAskedReadRan`（Windows 上工作区内的 read / grep / glob 全都弹卡） | 目标路径用原生 realpath（展开 8.3 短名），闸门的 cwd 用 JS 版 `realpathSync`（保留 8.3 短名）。runner 的 `%TEMP%` 是 `C:\Users\RUNNER~1\...`，于是工作区里的文件都被判到工作区外 | **产品缺陷**。用户名超过 8 个字符的真实用户，工作区在 `%TEMP%` 下时同样会遇到 | 各个根目录和目标用同一族解析函数；闸门同时认工作区的两种写法（规则 1～5） |
| `l1RipgrepFromArtifact`（钩子只记到一个 node.exe） | DSH 在 win32 上的普通子进程都经 dsh-subprocess-local 的 Job runner 拉起，而冒烟只会拆 systemd-run 这一层 | **冒烟的观测盲区**。rg 用的是随包的那份 | 冒烟把 DSH 的两种 node runner 也拆开，判据不变（规则 6～8） |
| `nativesPtyRan`（探针 `exitCode -1`、无输出） | 探针以 `--import 钩子 --input-type=module -e` 起 node。node-pty 在 Windows 上靠 worker 线程读 ConPTY 输出，worker 继承了这两个参数后拒绝启动 | **探针自身的问题**。产品没有任何路径会用到宿主里的 node-pty | 探针改为和宿主相同的启动方式（规则 9～12） |

目前 Linux 上的证据：机制都已复现，单测覆盖。Windows 上的实证要等快速工作流跑第一轮（规则 13、14），在「遗留」一节列出要看的输出。

## 落地了什么

- 产品：
  - `src/shared/permissions/workspace.ts`（新）；
  - `src/shared/permissions/gate.ts`（`cwdAliases`）；
  - `src/dsh-host/permissions/permissionHost.ts`（spill 与附件根目录）；
  - `src/dsh-host/bridge/dshSessionRuntime.ts`（`buildGate`，`DshBridgeDeps.realpathSync`）。
- 冒烟：
  - `scripts/packaged-dsh-host-smoke.mjs`（派生目标、natives 探针）；
  - `scripts/dsh-host-smoke-lib.mjs`（新）；
  - `src/dsh-host/tools/lib/probe-hooks.mjs`（只改注释）。
- 工作流与诊断：
  - `.github/workflows/dsh-host-windows-smoke.yml`（新）；
  - `scripts/dsh-host-windows-diag.mjs`（新）。

## 规则

### A. 工作区的规范写法（产品修复）

1. **根目录和目标用同一族解析函数。**
   - 目标：权限行用 `fs/promises` 的 `realpath`，底层是 libuv 的 `uv_fs_realpath`，在 Windows 上会把 8.3 短名展开成长名，并返回磁盘上的大小写。
   - 根目录：一律用它的同步版 `realpathSync.native`（同一个 libuv 调用）。涉及三处：
     - 闸门的 cwd（`DshSessionRuntime.buildGate`）；
     - spill 父目录（`spillRootOf`）；
     - 附件库根目录（`defaultAttachmentRoot`）。
   - 解析失败时退回 `path.resolve` 的结果。
   - 纯库不碰文件系统（决策 041 的边界）。规范化逻辑放在 `src/shared/permissions/workspace.ts`，解析函数由宿主注入（`SyncRealpath`）。
   - 静态测试 `canonicalRootsStatic.test.ts` 禁止在 `src/dsh-host/permissions/`、`src/dsh-host/bridge/` 里直接调用 JS 版 `realpathSync(`。
2. **闸门同时认工作区的两种写法。**
   - `PermissionConfig` 新增 `cwdAliases`：`cwd` 用规范写法，会话打开时的写法（经符号链接的，或 8.3 短名）作为别名。路径落在任何一个下面都算在工作区内。
   - 影响三处判断：工作区边界的 ask、`external_directory` 规则、shell 授权不出工作区的检查。
   - 为什么需要别名：DSH 按会话头里原样的 cwd 解析相对路径，模型看到的也是这个写法。shell 的每个操作数都会以「写的样子」和「规范路径」两种写法交给闸门。只认规范写法的话，accept-edits 下工作区里的 pwsh / bash 也会弹卡。
   - 安全性：每个操作数的规范写法都会被判断，规范路径不会穿过别名里的符号链接或短名。所以从工作区内的链接指向外面的操作数仍然会问（测试 `[8dot3-escape]`、`[perm-ws-symlink]` 的最后一段）。
   - 策略规则只按规范的 `cwd` 做相对匹配，不变。
3. **不改的部分。**
   - Main 下发的 cwd 和 DSH 会话头里的 cwd 仍保持原样。理由：跟随 DSH；存根和会话身份都按原写法比较。
   - 审批卡上的 `workspace` 字段，以及「本会话允许」那一行的相对路径显示，仍用原写法的 cwd。结果是在 8.3 或符号链接的工作区里，卡片会显示规范的绝对路径。只影响显示，列为遗留。
4. **只改 DSH 宿主。** 1.0.x 的 runtime（`src/runtime`）不动：它的会话头 cwd 本来就是 `io.realpath` 的结果，而且 P1-12 会删掉它。
5. **大小写。** `containsPath` 用的是 `node:path` 的 `relative`，在 win32 上本来就不区分大小写，不另外处理。`windowsPaths.ts` 的写法归一在这里用不上：原生 realpath 返回的是普通盘符路径，不带 `\\?\`。

**行为变化**（均比原来更少问）：

- ask 档：在 8.3 或符号链接的工作区里，read / grep / glob 不再弹卡，与普通工作区一致。
- accept-edits 档：按打开时写法写操作数的 shell 命令不再弹卡。
- spill 文件和附件的读取在 8.3 的 `%TEMP%` 下也按受信处理。
- 原来在工作区外会问的，现在仍然会问。

**订正编排者的初步诊断**：

- Linux 上闸门的 cwd 本来就解析了符号链接（JS 版 `realpathSync` 在 Linux 上会跟链接）。所以符号链接工作区里的 read / grep / glob 在 Linux 上不会弹卡。
- Linux 上真正的同类缺陷在 shell：按链接写法写的操作数，在 accept-edits 下会弹卡。`[perm-ws-symlink]` 在旧代码上正是在 pwsh 那一步失败，已验证。

### B. 冒烟看得见 Windows 上的 rg

6. **根因（读代码证实）。**
   - dsh-subprocess-local 的 `launchWindowsJob` 对每个普通子进程都执行 `spawn(process.execPath, [<dsh-subprocess-local/lib/runner.js>, '--', ...argv], { windowsHide: true })`。
   - runner 用 Win32 API（koffi）在 kill-on-close 的 Job 里挂起创建目标进程，放进 Job 后再恢复运行。
   - 沙箱下的调用会再套一层 dsh-sandbox-windows-acl 的 runner：`<node> <acl runner.js> --workspace … -- <argv>`。
   - 所以宿主的 `child_process` 钩子只看得到随包的 node.exe。
   - rg 的 argv[0] 是 `@vscode/ripgrep` 在产物里解析出来的 `rgPath`（`node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe`，产物清单里有）。
7. **修法。**
   - `scripts/dsh-host-smoke-lib.mjs` 的 `spawnTarget` 拆三种启动器：systemd-run、Job runner、ACL runner，嵌套最多拆 4 层。
   - 判据不变：至少有一次 rg，而且全部在宿主目录内。
   - 证据强度与 Linux 相同，都是「交给启动器的 argv」。
   - 报告新增 `hooks.spawnTargets`。
8. **没选的方案。**
   - 把钩子传给 runner：runner 的环境会去掉 `NODE_*`，而且目标是用 CreateProcess 起的，不经过 `child_process`，钩子什么也看不到。
   - 在宿主里读取 `rgPath`：要在产品包里加探针行，违背决策 015。

### C. node-pty 探针

9. **根因。**
   - 探针原来的启动方式是 `node --import <钩子> --input-type=module -e <脚本>`。
   - node-pty 在 Windows 上用 worker 线程读 ConPTY 输出（`windowsConoutConnection`），worker 默认继承父进程的 execArgv。
   - 同时继承了 `--import` 和 `--input-type` 的 worker 会报「--input-type can only be used with string input via --eval, --print, or STDIN」并以 1 退出。
   - node-pty 随后走 `_failPtyConnection`，报 `exitCode -1`，没有任何输出。
   - 已在 Linux 上用 node 24.18.0 和 22 复现：两个参数同时存在时 worker 就会失败，只有其中一个则没事（测试 `[worker-exec-argv]`）。
   - node-pty 在 Windows 上的这一段是推断，待工作流的诊断输出 node-pty 自己给的原因来确认。
   - 与 conpty 是否需要控制台、`useConptyDll` 无关（诊断里有对照组）。
10. **产品路径不受影响。**
    - 宿主里调用 node-pty 的只有 dsh-subprocess-local 的 `spawnTerminal`，而宿主里没有任何包调用它：DSH 自己的包、我们的几行、dsh-office-tools 都没有。bash / pwsh / grep 都走普通子进程。
    - 退一步说，宿主由 Main 以 `node --expose-internals host.js` 启动，没有 `--input-type`，即使将来用到也不会遇到这个问题。
    - P1-11 右列终端用的是 Electron 主进程自己的 node-pty，主进程没有 `--input-type`，同样不受这个根因影响。
11. **修法。**
    - 探针改为 CommonJS `-e`，带 `--expose-internals` 和钩子，也就是宿主的 execArgv。
    - node-pty 的参数照 `spawnTerminal` 设：`name` / `TERM` 为 `xterm-256color`，默认 ConPTY，不用 `useConptyDll`。
    - 启动失败时记录 node-pty 给出的原因。
    - 判据不变：输出里有 `pty-ok`，且 `exitCode 0`。
12. **没选的方案。**
    - `useConptyDll: true`：产品不用它，改了就是在测另一条路径。
    - 用文件入口：探针文件会落在宿主目录外，触发模块审计。

### 快速工作流与诊断

13. **`.github/workflows/dsh-host-windows-smoke.yml`（新）。**
    - 触发：推送到 `ci/dsh-host-windows-smoke`，或手动触发。权限 `contents: read`，镜像 `windows-2022`。
    - 步骤：
      - 根依赖只装不跑脚本：`pnpm install --ignore-scripts`，因为 build-dsh-host 只要 esbuild；
      - `build-dsh-host.mjs`；
      - 取随包 node；
      - L1 冒烟：scratch 放在 `%TEMP%` 下，runner 上是 8.3 路径，与 build-windows 相同；加 `--keep`，保留钩子日志；
      - 诊断：`if: always()`、`continue-on-error: true`；
      - 上传：`if: always()`。
    - 不打 Electron 包。
14. **`scripts/dsh-host-windows-diag.mjs`（新）。** 输出只含 runner 的路径，不打印环境变量全集，也不含凭据。三段：
    - `paths`：`%TEMP%`、家目录，以及 `%TEMP%` 下一个长名目录和它的 8.3 写法。用随包 node 分别跑三种 realpath，并判断规范目标在哪种根目录下「在工作区内」。
    - `spawns`：从冒烟钩子日志还原 DSH 的派生链；列出产物里解析出的 `rgPath`、Job runner 和 ACL runner 的路径。
    - `pty`：九种组合各跑一次 node-pty，记录退出码、输出和 node-pty 给出的原因。组合为：旧探针形态、旧形态加 `useConptyDll`、不带钩子的 `--input-type`、新探针形态、文件入口带或不带钩子、文件入口加 `useConptyDll`、稍长寿命的 powershell、`windowsHide: false`。

## 测试

- `src/shared/permissions/__tests__/workspaceSpellings.test.ts`（新，7 例）：
  - 用注入的解析函数在 POSIX 写法上模拟 8.3：`RUNNER~1` 展开为 `runneradmin`；
  - 覆盖 read（修复前后对照）、accept-edits 下的 pwsh、链接逃逸、会话授权、`external_directory`；
  - 以及 `workspaceSpellings` / `canonicalSpelling` 解析失败时的退回。
- `src/dsh-host/bridge/__tests__/permissionBridge.test.ts`（+2 例），经真实 `PermissionHost` 和 `DshSessionRuntime`：
  - `[perm-ws-symlink]`：Linux 上真的符号链接工作区，win32 上跳过；
  - `[perm-ws-8dot3]`：真实目录名 `RUNNER~1`，注入的解析函数把它展开。
  - 两例都在旧代码上验证过会失败：前者败在 pwsh 那一步，后者败在 read。
- `src/dsh-host/permissions/__tests__/permissionHost.test.ts`（+4 例）：
  - spill 根和附件库在 8.3 下的规范化；
  - 默认解析与 `fs/promises` 的结果一致；
  - `[win32-8dot3]`：只在 win32 且 `%TEMP%` 含 `~N` 时跑。
- `src/dsh-host/permissions/__tests__/canonicalRootsStatic.test.ts`（新，3 例）：禁止直接调用 JS 版 `realpathSync`，并钉住接线。
- `scripts/__tests__/dsh-host-windows-smoke.test.mjs`（新，11 例）：
  - `spawnTarget`：Job runner、ACL 嵌套、systemd-run、同步派生；
  - 探针不带 `--input-type`；
  - worker 继承参数的机制；
  - 工作流的结构。

## 遗留

- **Windows 实证**：请编排者推送到 `ci/dsh-host-windows-smoke` 跑一轮，要看：
  - 冒烟 44 项全过；
  - `diag.paths` 里 JS 版根目录的 `targetInside` 为 false，原生版为 true；
  - `diag.spawns` 里 rg 经 Job runner、`rgPath` 在 out-dsh-host 下；
  - `diag.pty` 旧形态的 reason 是「Conout worker exited before connecting (code 1)」，新形态为 `pty-ok`。
- 审批卡在 8.3 或符号链接工作区里显示规范的绝对路径（规则 3），要不要改，待定。
- build.yml 的 build-windows 用的是同一个冒烟脚本，改动合入后自然生效，本项没有动它。
