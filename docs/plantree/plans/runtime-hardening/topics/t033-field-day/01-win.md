# T033 分片 01 · WIN 组（Windows 加密机，37 项）

Role: detail shard。上位：[执行单](../t033-field-day-runbook.md)。判据权威：[checklist-e.md 第 4 节 Windows 表](../../checklist-e.md#windows-加密机上机日36-项--新增-win-37见第二节)。

本分片把 37 项按**能合并到同一轮的操作**重排。`必` = 34 条必做之一。证据文件放 `evidence/batch-e-field-<date>/win/`。

---

## 轮 W-a · 装机后的第一屏（约 20 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-19 | 必 | **不用做**：本次 Build 三平台 `Verify packaged Pi worker` 已绿 | `ok:true` / `failures:[]` / `backend=native` / Windows `carrier=bundled-node` / 两条权限审计行 | 已归档 `evidence/batch-e-build-2026-09-18/worker-smoke-*.json` |
| WIN-7 | | 起打包应用发一条消息，看 worker 进程名与可执行路径 | `app.isPackaged && win32` 时 utility worker 由 `node-runtime\node.exe` 起，**不是** utilityProcess；与 `PiWorkerProcess.ts:79-92` 的分支日志对上 | `win-07-worker-process-image.txt` |
| WIN-2 + WIN-36 | 必 | **一次做完两项**：把 `resources\node-runtime\node.exe` 改名 → 起应用发一条消息 → 截横幅 → 改回来 | 横幅是 `Pi Node runtime is missing: <路径>`，**且全文不出现 `AICLIENT_NODE24_PATH`**（T068 已把这句从代码里删掉）。WIN-36 另记「这条提示是否可操作」 | `win-02-node-missing-banner.png`、`win-02-main-log-excerpt.txt` |
| WIN-3 | — | 🚫 **已退役**，不要花时间。T068（`d2bbbf13`）删掉了 `NodeRuntimeResolver.ts` 与整条 Node 24 解析链，该变量在代码里已不存在 | — | 在 README 里写一行「🚫 已由 T068 消解」 |

---

## 轮 W-b · P1-8 六项探针重采（约 40 min，需要源码）

前置：Windows 上拉到 `13e6cdb7`，进 `src/runtime` 跑 `npm ci`（**独立 npm 子包，依赖不随根 pnpm 装**；缺失时报 `Cannot find package 'cordis'`）。

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-26 | 必 | 用**安装目录里的**随包 `node.exe` 跑 `src/runtime/smoke/p1-bundled-node.ts`（原命令见 `test12-reverify.md:541`） | `passed: true`、六项断言全 `true`、`stamp.config_version === 'runtime_p6_hardening_v1'`（旧证据是 `runtime_p3_complete_v1`，据此确认是新采） | `win-26-p1-bundled-node.json` |
| WIN-27 | 必 | 按 `test12-reverify.md:562` 的 `electron-carrier.cjs` 原命令重跑 | 同 WIN-26，另加 `stamp.carrier === 'electron-utility'` | `win-27-p1-electron-utility.json`、`win-27-stderr.txt` |

> 这两份就是用来替换那份落后 150 个提交的 `test12-reverify.md` 的。**保存完整 JSON，不要只截几行。**

---

## 轮 W-c · 进程树、强杀与孤儿（约 70 min）

开跑前先存一份基线进程快照：`Get-Process | Select Id,ProcessName,Path > win-00-baseline-processes.txt`。

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-35 | 必 | 四种形态各跑一条命令：正常退出、超时、取消、父命令先退出 | 每种形态 `taskkill` 之后无残留进程（与基线快照比对）；trace 的 `termination` 字段说得出是哪一种 | `win-35-cmdtree-<形态>.txt` ×4、`win-35-trace.jsonl` |
| WIN-28 | 必 | 拦住 `taskkill.exe` 后跑一条 `echo hello`。**首选** AppLocker / EDR；装不了就把 worker 环境的 `SystemRoot` 指到不存在的目录 | 必须返回 `hello` 且退出码 0，**不得出现 `exec_cleanup_failed`**。证据里写清楚用的是哪种造法 | `win-28-taskkill-blocked-trace.json` |
| WIN-23 | 必 | 配一个真实 stdio MCP 服务器，开会话待其就绪，记下子进程 pid，然后 `taskkill /PID <worker> /F` | 10 秒内 MCP 进程消失 | `win-23-mcp-orphan-check.txt` |
| WIN-24 | 必 | 同一场景，用 `wmic process where ParentProcessId=<worker>` 逐层看进程树 | `node.exe`（exec 运行器）与它下面的 MCP 进程**都**消失 | `win-24-process-tree.txt` |
| WIN-6 | 必 | 正常退出与「导入槽拆除失败」两种退出各跑一次，退出后 `tasklist /FI "IMAGENAME eq node.exe"` | 两次都没有以 `resources\node-runtime\node.exe` 启动的残留进程 | `win-06-tasklist-after-exit-<形态>.txt` ×2 |
| WIN-5 | | 起两个会话 worker + 一次大体量旧会话导入，**在导入写盘中途**退出应用 | 退出后无残留 worker；scratch 临时目录被清空；日志里每个会话槽各有一次 dispose | `win-05-shutdown-dispose.log`、`win-05-scratch-after.txt` |
| WIN-25 | | 强制结束应用进程，记下 `writer.lock` 里的 pid，制造 pid 回绕后重开该会话 | 记录实际形态（能开 / 报 `session_locked` / 给接管出口）。锁路径是 `<会话 jsonl 全路径>.writer.lock` | `win-25-pid-reuse.txt`、`win-25-reopen.png` |

---

## 轮 W-d · 会话索引（约 40 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-9 | | 在一轮对话结束（会触发 flush）的**瞬间**强杀进程，重复若干次后检查文件 | `session-index.json` 不出现零长度或半截内容 | `win-09-index-after-kill-<n>.json` |
| WIN-10 | 必 | 开启实时防护，连续归档 / 重命名若干会话 | 记录 rename 是否出现 `EPERM` / `EBUSY`，失败后界面表现与**重启后的状态** | `win-10-index-rename-busy.png`、`win-10-main-log.txt` |
| WIN-31 | | 伪造一份 `writer.lock`（pid 填一个当前存活的无关进程、host 填本机名），打开该会话；**测完删除 sidecar** | 期望能打开或至少给接管出口；报 `session_locked` 即复现 W9。造之前先备份 | `win-31-forged-lock.png` |

---

## 轮 W-e · 终端、TUI 与注册表编码（约 45 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-12 | 必 | 在**没有 pwsh 7** 的状态下开内嵌终端；再用一个失效的自定义 shell 路径开一次 | 默认设置下终端能正常打开；失效路径给出**可读错误**而非原生 spawn 报错 | `win-12-no-pwsh.png`、`win-12-bad-custom-shell.png` |
| WIN-13 | 必 | 打包版上开 TUI，在 pi 里跑 `node -v` 与 `echo %PATH%` | pi 起得来；PATH 含 `node-runtime` 目录；`Path`/`PATH` 双键不造成取值异常 | `win-13-tui-path.png` |
| WIN-32 | 必 | 在**用户级** PATH 里加一个带中文的目录 → 重启应用 → 终端打印 PATH → 与 `reg query` 原文对比 | 该条目与注册表原文**逐字节一致** | `win-32-registry-path.png`、`win-32-reg-query.txt` |

---

## 轮 W-f · bash 载体取证（约 50 min，F3 根因的一半）

**这一轮的结果直接喂给 ENC-8 的 A/B/C 映射。** 另一半（R2/R3）在 [02-enc](02-enc.md)。

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-16 | 必 | 跑一次 bash 工具的同时 `Get-Process bash \| Select Path`，再查父进程链 | 拿到 **Windows 映像绝对路径 + 父进程链**，不是 shell 自报的 MSYS 路径（test.12 只拿到后者，因此不成立）。与 `src/runtime/host/shell.ts` 的候选顺序逐条对照 | `win-16-bash-image-path.txt`、`win-16-parent-chain.txt` |
| WIN-17 | 必 | **覆写 `resolveWorkerShell` 会查的全部候选路径**后调 bash 工具 | worker 的 shell resolver 真正落到 `shell_unconfigured`，应用不崩不挂。**现场记录必须写明覆盖了哪几个候选**——test.12 那次因未覆盖默认安装目录而无效 | `win-17-r4-covered-candidates.txt`、`win-17-shell-unconfigured-trace.json` |
| WIN-29 | | 把 Git 安装目录改名（或换一台没装 Git 的机器），起会话让模型跑一条命令 | 期望 bash 工具不出现在工具列表里 + 一条可操作的**中文**提示。**当前实现预期会失败**，照抄实际文案原文 | `win-29-no-git-message.png`、`win-29-trace.json` |

> 候选顺序（照 `src/runtime/host/shell.ts`）：`%ProgramFiles%` / `(x86)` / `%LOCALAPPDATA%\Programs` 下的 `Git\bin\bash.exe` → PATH 各项的 `bash.exe`（跳过 system32/sysnative 与相对项）→ PATH 里 `...\cmd` 同级的 `..\bin\bash.exe`。**三类都要覆盖到才算 R4 成立。**

---

## 轮 W-g · 打包态 GUI 回归（约 60 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-1 | | 起应用发一条长回合消息，**回合中点归档** | 目录删除发生在 worker 退出**之后**；无残留目录；main.log 里没有 `[scratch] failed to remove`。POSIX 半边已由 DEV-1 验过（归档 11 ms 后 bash 收 SIGTERM、回合 aborted） | `win-01-archive-during-run.log` |
| WIN-4 | | 设置里把保存位置写成**带尾部分隔符**的形式 → 建临时工作区 → 手工删目录 → 重开对话 | 目录被就地重建且带 `.git`；不出现 `workspace_missing` 卡片 | `win-04-selfheal.png` |
| WIN-18 | | 在新包上按现场清单复验 GUI F/15 的 F2-a/c | 临时根改设置后两处解析一致；用户目录缺失时给 `workspace_missing` 而非裸 ENOENT | `win-18-f2ac.png` |
| WIN-20 | | 新包上开一个会改文件的会话，对照本地结果 | 右侧审阅栏能记录 Edit/Write 修改，上限行为与本地一致 | `win-20-review-rail.png` |
| WIN-21 | | 打包应用里加一个自定义 AI 服务 → 拉模型列表 → 对话一轮 | 模型选择器能拉到列表并可对话；safeStorage 不可用时界面**如实显示未加密** | `win-21-h17-local-mode.png` |
| WIN-22 | | 打包应用里真实调用 `pi install` / `remove` / `list` | `currentPiCliLayout()` 解析出的 pi 可执行文件**存在且可跑**；安装/卸载后 `settings.json` 与 `node_modules` 增减正确 | `win-22-pi-install.txt`、`win-22-settings-diff.txt` |
| WIN-14 | | 故意制造一条含用户目录的 worker stderr（例如指向不存在的随包 node 路径），看 Context 面板的 Host stderr 分组 | `C:\Users\<含空格用户名>\…` 显示为 `~\…`；WSL / UNC 两族同理 | `win-14-stderr-redaction.png` |
| WIN-15 | | Windows 机跑一次命令回合，截时间线 | 工具行仍是 `bash`（不是 powershell），动词表命中「已运行」 | `win-15-tool-row.png` |

> WIN-22 做完顺手把 pi 权限扩展**留着不卸**——[04-model](04-model.md) 的 DEV-36 ② 半句要用它。

---

## 轮 W-h · 导入路径与托管模式（约 30 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-11 | | 在 Windows 上打开导入面板，核对项目路径显示与导入产物路径 | `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 取 Windows 路径时扫描与落盘均正常；`decodeProjectDirNameFallback`（`ClaudeSessionScanner.ts:258-262`）在真实项目目录名上给出正确盘符路径 | `win-11-import-paths.png` |
| WIN-8 | | 锁定钥匙串后点三个 utility 功能（评审 / 分支命名 / 提交信息） | `resolveNativeModelCatalog()` 返回 undefined → worker 回落读 agent 目录 → 功能仍可用，或给出可理解的错误。记录错误码、`utility.start` 载荷里是否带 `modelCatalog`、worker 是否读到 `auth.json` | `win-08-keychain-locked.txt` |

---

## 轮 W-i · stdio MCP 在 Windows 上（约 25 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-30 | 必 | MCP 配置写 `command: npx`、`args: ['-y', <官方 server 包名>]`，起会话；**再用绝对 `npx.cmd` 路径试一次** | 期望服务器连上且工具出现在列表里。两次的错误原文都要记（链路上两次 spawn 都是 `shell:false`，而 npx/uvx/npm 都是 `.cmd`） | `win-30-mcp-npx.txt`、`win-30-mcp-npxcmd.txt`、`win-30-sidebar-badge.png` |

---

## 轮 W-j · 纯探索（约 30 min，**时间不够先砍这一轮**）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| WIN-33 | 必 | 用 PowerShell 逐级 `New-Item` 造一条总长 > 300 字符的路径并放一个 `.ts` 文件，跑 glob 与 read | 期望都成功。全仓零处理零用例，做完至少要能回答「有没有」 | `win-33-long-path.txt` |
| WIN-34 | 必 | 用 `subst` 把工作区映射成新盘符，用新盘符打开工作区跑一次 glob | glob 必须返回非空；与原路径下的结果数比对 | `win-34-subst-glob.txt` |

---

## 移到别的分片的两项

| # | 去哪 | 为什么 |
|---|---|---|
| WIN-37 | [04-model](04-model.md) 的 MODEL-33 同一轮 | permissions-19 验的是同一条规则在 `\`、`/`、MSYS `/c/` 三种拼法下判定是否一致，与 W3 用同一组命令 |
| ENC-15 | [02-enc](02-enc.md) | W5 量的是加密机上每条 bash 的 taskkill 耗时分布，场地在加密盘 |
