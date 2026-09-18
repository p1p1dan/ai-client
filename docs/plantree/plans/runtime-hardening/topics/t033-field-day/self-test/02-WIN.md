# T033 自测分片 02 · WIN 组（Windows 加密测试机，WIN-1 ～ WIN-37）

Role: detail shard（自测版）。上位：[执行单](../../t033-field-day-runbook.md)。判据权威：[checklist-e.md 第 4 节 Windows 表](../../../checklist-e.md) + 第 5.1 节判据更正 + 5.2 节退役项。
编排器版分片在 [01-win.md](../01-win.md)（给「一人给命令、一人执行」的协作模式用）；**这一份是给你一个人从头做到尾的版本**，每一条都写全了操作、判据和记录方式，中途不需要问人。

本机安装的是 **Build #59**（GitHub Actions run `35295618831`，源码 `13e6cdb7`，分支 `feat/runtime-evolution`）。

---

## 0. 开工前先看这一节（10 分钟）

### 0.1 三个档位是什么意思

| 档位 | 含义 | 本分片项数 |
|---|---|---|
| 【必】 | 执行单 §7「第一刀」：不做就不能签收 | 17（含 WIN-37，它在 MODEL 组执行） |
| 【绿】 | 第二刀：做了能让某个验收节点转绿，时间不够可以往后放 | 16 |
| 【探】 | 第三刀：纯探索，全仓零处理零用例，做完至少能回答「有没有」；时间不够整组砍 | 2 |
| 【不做】 | 已结案或已退役，一行写明原因，不展开 | 2 |

**时间不够时的推荐顺序**：先按轮次把所有【必】做完（WIN-2、WIN-36、WIN-26、WIN-27、WIN-35、WIN-28、WIN-23、WIN-24、WIN-6、WIN-10、WIN-12、WIN-13、WIN-32、WIN-16、WIN-17、WIN-30），再回头做【绿】，最后做【探】。

### 0.2 每一项只有三种收尾

- ✅ 通过 —— **必须挂证据文件**，不接受只写「通过」；
- ⛔ 不通过 / 与判据不符 —— 挂证据文件 **+ 一句实际现象**（照抄屏上原文，不要总结成「看着不对」）；
- 🚫 没做 —— 写明为什么（缺前提、机器上没有、时间不够）。

**空白会在下一轮被读成「做过且通过」**，所以结果表每一行都要填。

现场与文档里的静态推断不符时**以现场为准**：当场把实际现象抄下来，不要留到事后回忆。

### 0.3 路径与变量（每开一个新的 PowerShell 窗口都先跑一遍）

```powershell
# 安装目录（你若装到了别处，改这一行即可，后面所有命令都跟着走）
$app   = "$env:LOCALAPPDATA\Programs\AiClient"
$node  = "$app\resources\node-runtime\node.exe"      # 随包 Node，实测 v24.18.0
$ud    = "$env:APPDATA\jyw-ai-client"                # userData：session-index.json、logs 都在这里
$state = "$env:USERPROFILE\.pilab\jyw-ai-client"     # 应用状态根：settings.json、pi-agent、会话 JSONL
$ev    = "C:\t033\evidence\win"                      # 证据目录
New-Item -ItemType Directory -Force -Path $ev, 'C:\t033\trace' | Out-Null
Test-Path $app, $node, $ud, $state
```

最后一行应当四个 `True`。有 `False` 就先把路径对上再往下走——路径错了后面每一项的结论都是假的。

| 东西 | 绝对路径 |
|---|---|
| 主程序 | `$app\AiClient.exe` |
| 随包 Node | `$app\resources\node-runtime\node.exe` |
| 随包 pi CLI | `$app\resources\agent-host\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js` |
| worker 入口 | `$app\resources\agent-host\worker.js` |
| 会话索引 | `$ud\session-index.json` |
| 主日志 | `$ud\logs\main.log`（另有按天日志 `$ud\logs\aiclient-<YYYY-MM-DD>.log`，两者同目录共存） |
| 设置文件 | `$state\settings.json` |
| 会话 JSONL | `$state\pi-agent\sessions\<按工作目录编码的子目录>\<id>.jsonl` |
| 写锁 sidecar | `<会话 jsonl 全路径>.writer.lock` |
| MCP 用户级配置 | `$state\pi-agent\mcp.json` |
| trace | `C:\t033\trace\runs.jsonl`（轮转后还有 `runs.1/2/3.jsonl`） |

### 0.4 起应用 / 关应用的固定动作

**起应用**（本分片里凡写「起应用」都指这一段）：

```powershell
$env:AICLIENT_RUNTIME_TRACE_DIR = 'C:\t033\trace'
& "$app\AiClient.exe"
```

两件事必须记牢：

1. **不设 `AICLIENT_RUNTIME_TRACE_DIR` 就没有 trace 文件**（默认只留在内存里）。凡是判据里写「抓 trace 的某某行」的项，漏了这一步就等于白做；
2. 窗口起来后 PowerShell 一般会回到提示符。**如果没回到提示符，另开一个 PowerShell 窗口做后续命令，不要在这个窗口按 Ctrl+C**——那会连带杀掉应用。

辅助脚本 `C:\t033\t033-helper.ps1` 里的 `Start-AiClient` 做的就是上面两行；`Stop-AiClient` 是正常关闭；`Get-Trace -Pattern '<正则>'` 从 `C:\t033\trace\runs*.jsonl` 里捞行；`Get-AiClientTree` 列 AiClient 进程树；`Get-Head16 -Path <文件>` 取前 16 字节；`Save-Evidence` 存证据文件。本分片的命令一律写成显式写法（`Out-File` / `Set-Content`），用 helper 的同名函数效果一样，挑顺手的用。

**关应用**：点窗口右上角关闭，或 `Stop-AiClient`。**「关应用」一律指正常关闭**；要强杀的地方每一条都会单独写明。

### 0.5 强杀的红线

本分片里所有强杀**只按真实 PID**：

- ✅ 允许：`Stop-Process -Id <真实PID> -Force`、`taskkill /PID <真实PID> /F`
- ⛔ 禁止：`taskkill /IM <名字>`、`Stop-Process -Name <名字>`、任何针对进程组或 `-1` 的操作

理由很具体：这台机器上不止一个 `node.exe`，按名字杀会连带打死无关进程（包括你自己正在跑的取证脚本），而且事后分不清哪个残留是被你杀的、哪个是缺陷留下的。

拿 PID 的标准做法：

```powershell
# AiClient 的全部进程（主进程、渲染进程、worker）
Get-CimInstance Win32_Process -Filter "Name='AiClient.exe' OR Name='node.exe'" |
  Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | Format-List
```

下面三个函数**已经并进 `C:\t033\t033-helper.ps1`**（见 [00-总纲](00-总纲.md)），按 §0.3 载入脚本后直接就能调用，不用再粘贴。它们做的事分别是：往上打印父进程链（`Show-Chain`）、往下打印子孙进程树（`Show-Tree`）、按源码候选顺序列出 worker 会去找的每一个 `bash.exe`（`Get-BashCandidates`，WIN-16 / WIN-17 的「写明覆盖了哪几个候选」直接用它的输出当证据）。

### 0.6 证据命名与基线快照

证据一律放 `C:\t033\evidence\win\`，文件名 **`win-<两位编号>-<短横线英文 slug>.<扩展名>`**，例如 `win-16-bash-image-path.txt`。多份同编号的加后缀区分（`win-35-cmdtree-timeout.txt`）。

**开工第一件事**：存一份基线进程快照，后面所有「有没有残留」的判断都跟它比。

```powershell
Get-Process | Select-Object Id,ProcessName,Path |
  Out-File -Encoding utf8 "$ev\win-00-baseline-processes.txt"
```

### 0.7 模型回合怎么算数

很多项要「发一条消息」「让模型跑一条命令」。用**你自己配好的 provider**，不要把密钥写进任何证据文件。开工前先确认能正常出话（随便发一条「你好」得到回复）；网关不通就先修网关，否则这一批项只能全部记 ⛔。

要模型跑固定命令时，把提示词写死，例如：

> 请用 bash 工具执行 `echo hello`，只执行这一条，不要做别的，也不要解释。

工具行末尾会带一段 `[exit=<退出码>; <termination>]`，`termination` 的取值只有 `exit` / `timeout` / `aborted` / `output-limit` / `disposed` 五种——好几项的判据就看这里，截图时**务必把这一行带上**。

---

## 轮 W-a · 装机后的第一屏（约 20 分钟）

### WIN-2 + WIN-36 随包 Node 运行时缺失时的用户可见文案（一次做完两项）【必】

> **判据（逐字）**：WIN-2 —— 横幅显示 `Pi Node runtime is missing: <路径>`，且不出现任何提及 AICLIENT_NODE24_PATH 的指引。
> WIN-36 —— 期望出现一条可操作的中文提示；当前预期只有 Pi Node runtime is missing 加路径。
> **5.2 节补充（逐字）**：顺带确认 Windows 第 2 项——随包 `node.exe` 缺失时文案是 `Pi Node runtime is missing: <路径>`，且不再提及 `AICLIENT_NODE24_PATH`。

**准备**：这两项是同一个操作，**只做一次，不要跑两遍**。改名前先关应用。

**操作**

1. 关应用，确认没有 AiClient 进程还在：`Get-CimInstance Win32_Process -Filter "Name='AiClient.exe'"` 应当没有输出。
2. 把随包 Node 改名：

```powershell
Rename-Item "$app\resources\node-runtime\node.exe" 'node.exe.bak'
Test-Path "$app\resources\node-runtime\node.exe"     # 应为 False
```

3. 起应用（§0.4），开一个对话，发一条普通消息（例如「你好」）。
4. 截图整屏，**要把横幅/错误块的全文拍全**，存 `win-02-node-missing-banner.png`。
5. 抓日志里的同一条：

```powershell
Select-String -Path "$ud\logs\main.log" -Pattern 'Pi Node runtime is missing|AICLIENT_NODE24_PATH' |
  Out-File -Encoding utf8 "$ev\win-02-main-log-excerpt.txt"
Get-Content "$ev\win-02-main-log-excerpt.txt"
```

6. **恢复**（务必做）：关应用 → 改回名字 → 起应用发一条消息确认恢复正常。

```powershell
Rename-Item "$app\resources\node-runtime\node.exe.bak" 'node.exe'
Test-Path "$app\resources\node-runtime\node.exe"     # 应为 True
```

**看什么**

- **通过的样子**：屏上出现一条含 `Pi Node runtime is missing:` 加那个不存在的路径的提示；全屏、全日志里**一个 `AICLIENT_NODE24_PATH` 字样都没有**（这个变量与它背后的整条解析链已被 T068 删掉）。
- **不通过的样子**：出现 `AICLIENT_NODE24_PATH` 字样（说明旧文案残留）；或者屏上什么都不显示、只是一直转圈 / 静默失败（说明这条错误没有到达界面）。
- WIN-36 另记一句判断：**这条提示对普通用户可操作吗**？（它是英文的、只有一个路径，没有「怎么修」的下一步——如实记录即可，当前预期就是这样。）

**记录**

- `C:\t033\evidence\win\win-02-node-missing-banner.png`
- `C:\t033\evidence\win\win-02-main-log-excerpt.txt`
- 结果表 **WIN-2** 与 **WIN-36** 各填一行（同样的证据文件），WIN-36 的「一句现象」写那条提示是否可操作。

---

### WIN-7 Windows 打包态走的是 node.exe 分支【绿】

> **判据（逐字）**：`app.isPackaged && win32` 时 utility worker 由 node-runtime/node.exe 起，而不是 utilityProcess。

**操作**

1. 起应用，开一个对话，**发一条消息**（worker 是发第一条消息时才起的，光开窗口看不到）。
2. 在另一个 PowerShell 窗口里抓 worker 进程：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*agent-host*worker.js*' } |
  Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine |
  Format-List | Out-File -Encoding utf8 "$ev\win-07-worker-process-image.txt"
Get-Content "$ev\win-07-worker-process-image.txt"
```

3. 顺手把父进程链也追一遍（`$wpid` 换成上一步拿到的 ProcessId）：

```powershell
Show-Chain <worker的ProcessId> | Out-File -Append -Encoding utf8 "$ev\win-07-worker-process-image.txt"
```

**看什么**

- **通过的样子**：`ExecutablePath` 是 `...\AiClient\resources\node-runtime\node.exe`，`CommandLine` 里带 `resources\agent-host\worker.js`，父进程是 `AiClient.exe`。
- **不通过的样子**：查不到这样的 node.exe，而是在任务管理器里看到一个名叫 `AiClient Pi Worker 1` 的进程（那是 Electron 的 utilityProcess 分支，说明 Windows 走错了载体）。

**记录**：`C:\t033\evidence\win\win-07-worker-process-image.txt`；结果表 WIN-7 填 ✅/⛔ + 一句现象（例：「worker 是 resources\node-runtime\node.exe，父进程 AiClient.exe」）。

---

### WIN-19 打包门禁改 native-only 后的三平台绿灯【不做】

已由本次 Build 结案：run `35295618831` 三平台 `Verify packaged Pi worker` 全 success，三份 `worker-smoke-*.json` 已归档（`ok:true`、`failures:[]`、`backend:native`、Windows `carrier:bundled-node`、两条权限审计行）。结果表预填 ✅，**不要在机器上重做**。

### WIN-3 AICLIENT_NODE24_PATH 是否仍被宣传但无效【不做】

已退役：T068（`d2bbbf13`）删掉了 `NodeRuntimeResolver.ts` 与整条 Node 24 解析链，这个环境变量在代码里已经不存在了，没有可验的对象。结果表预填 🚫，一句话写「已由 T068 消解」。

---

## 轮 W-b · P1-8 六项探针重采（约 40 分钟，需要源码）

这一轮要在机器上**拉一份源码**。它和后面轮 W-f（把 Git 改名）冲突——**必须先做完这一轮再去做 W-f**，否则 clone 和探针都跑不了。

### 本轮共同前置：拉源码 + 装 src/runtime 的依赖

```powershell
New-Item -ItemType Directory -Force -Path C:\t033\src | Out-Null
cd C:\t033\src
git clone https://github.com/p1p1dan/ai-client.git
cd C:\t033\src\ai-client
git checkout 13e6cdb7
git log -1 --oneline        # 应当显示 13e6cdb7
cd C:\t033\src\ai-client\src\runtime
npm ci
```

**`src/runtime` 是一个独立的 npm 子包，它的依赖不会随仓库根目录的 pnpm 一起装。** 漏了 `npm ci`，探针会报 `Cannot find package 'cordis'`——看到这句话就是这一步没做。

`npm ci` 要联网。拉不到源码或装不上依赖时，WIN-26 / WIN-27 记 🚫 并写明卡在哪一步（贴报错原文）。

### WIN-26 W1 P1-8 六项探针在当前 HEAD 上重采（bundled-node 载体）【必】

> **判据（逐字）**：passed 为 true 且 assertions 六项全 true；stamp.config_version 为 `runtime_p6_hardening_v1`（旧证据是 `runtime_p3_complete_v1`，据此确认是新采）。

**准备**：Git for Windows 必须还在（探针要一个 bash 路径）。先确认：

```powershell
$bash = 'C:\Program Files\Git\bin\bash.exe'
Test-Path $bash          # False 的话换成你机器上 Git 的实际安装路径
```

**操作**

1. 用**安装目录里的随包 node.exe**跑探针（注意：第一个参数必须是同一个绝对路径，探针会自己校验，不一致会直接报错）：

```powershell
cd C:\t033\src\ai-client
& $node --max-old-space-size=1536 "src\runtime\smoke\p1-bundled-node.ts" $node $bash `
  1> "$ev\win-26-p1-bundled-node.json" 2> "$ev\win-26-stderr.txt"
$LASTEXITCODE
```

2. 读回来核字段：

```powershell
$r = Get-Content "$ev\win-26-p1-bundled-node.json" -Raw | ConvertFrom-Json
$r.passed
$r.assertions
$r.carrier
$r.stamp.config_version
$r.stamp.backend
$r.stamp.node_exec_path
```

**看什么**

- **通过的样子**：`$LASTEXITCODE` 为 0；`passed` 为 `True`；`assertions` 的 read / edit / bash / glob / grep / trace **六项全 True**；`stamp.config_version` 是 `runtime_p6_hardening_v1`；`carrier` 是 `bundled-node`；`node_exec_path` 指向安装目录的随包 node.exe。
- **不通过的样子**：`config_version` 还是 `runtime_p3_complete_v1`（说明你跑的是旧代码，checkout 没生效，这份不算新采）；任一断言为 `False`；或者根本没有 JSON 输出，stderr 里是 `Cannot find package 'cordis'`（依赖没装）。

**记录**：`C:\t033\evidence\win\win-26-p1-bundled-node.json`（**保存完整 JSON，不要只截几行**）、`win-26-stderr.txt`；结果表 WIN-26 填 ✅/⛔/🚫 + 一句现象。

---

### WIN-27 W2 P1-8 六项探针重采（electron-utility 载体）【必】

> **判据（逐字）**：同 W1，且 stamp.carrier 为 `electron-utility`。

**准备（这一项门槛最高，先读完再决定做不做）**：它要用**仓库根目录 node_modules 里的 Electron 二进制**来跑，也就是要在这台机器上装一次根依赖：

```powershell
cd C:\t033\src\ai-client
corepack enable          # 仓库用 pnpm@10.26.2
pnpm install             # 要联网，会下载 Electron 二进制（100 MB 量级）
Test-Path "C:\t033\src\ai-client\node_modules\electron\dist\electron.exe"
```

装不了（不能联网 / 磁盘不够 / pnpm 起不来）就**直接记 🚫**，原因写「机器上没有可用的 Electron 二进制，electron-utility 载体探针无法执行」，不要用别的东西凑数——安装目录里的 `AiClient.exe` 是打包好的应用，它的主进程入口是写死的，跑不了这个脚本。

**操作**

```powershell
cd C:\t033\src\ai-client
$env:AICLIENT_RUNTIME_BACKEND = 'native'
$env:NODE_OPTIONS = '--max-old-space-size=1536'
Start-Process -FilePath "C:\t033\src\ai-client\node_modules\electron\dist\electron.exe" `
  -ArgumentList @('--no-sandbox',
                  '"C:\t033\src\ai-client\scripts\runtime-smoke\electron-carrier.cjs"',
                  "`"$node`"", "`"$bash`"") `
  -WindowStyle Hidden -Wait -PassThru `
  -RedirectStandardOutput "$ev\win-27-p1-electron-utility.json" `
  -RedirectStandardError  "$ev\win-27-stderr.txt"
Get-Content "$ev\win-27-p1-electron-utility.json"
```

输出里那一行以 `P1_CARRIER_REPORT ` 开头，后面跟着 JSON。核字段：

```powershell
$line = (Get-Content "$ev\win-27-p1-electron-utility.json" | Where-Object { $_ -like 'P1_CARRIER_REPORT*' })
$r = ($line -replace '^P1_CARRIER_REPORT ', '') | ConvertFrom-Json
$r.passed; $r.assertions; $r.carrier; $r.stamp.config_version; $r.stamp.carrier
```

跑完把两个临时环境变量清掉（或直接关掉这个 PowerShell 窗口）：

```powershell
Remove-Item Env:\AICLIENT_RUNTIME_BACKEND, Env:\NODE_OPTIONS
```

**看什么**

- **通过的样子**：`passed` 为 `True`、六项断言全 `True`、`stamp.config_version` 是 `runtime_p6_hardening_v1`、`carrier` 与 `stamp.carrier` 都是 `electron-utility`。
- **不通过的样子**：stdout 是空的（**空输出不算通过**，按原记录的教训，这里要用上面的重定向写法才拿得到），或者报错说 `workerHost derived no shipped Node`（说明产品路径推导失败，照抄整段 stack）。

**记录**：`C:\t033\evidence\win\win-27-p1-electron-utility.json`、`win-27-stderr.txt`；结果表 WIN-27 填 ✅/⛔/🚫 + 一句现象。

> 这两份 JSON 就是用来替换那份落后 150 个提交的旧记录的，**完整保存**。

---

## 轮 W-c · 进程树、强杀与孤儿（约 70 分钟）

本轮全程要 trace，起应用前务必设好 `AICLIENT_RUNTIME_TRACE_DIR`（§0.4）。开跑前确认基线快照（§0.6）已经存了。

### WIN-35 W15 命令树清理【必】

> **判据（逐字）**：正常退出、超时、取消、父命令先退出四种形态下，taskkill 之后无残留进程。

**操作**：起应用，开一个会话（工作目录随便挑一个空目录，例如 `C:\t033\ws`），**四种形态各跑一条命令**，每种跑完立刻做一次进程比对。

1. **正常退出**——提示词：

   > 请用 bash 工具执行 `echo hello`，只执行这一条。

2. **超时**——提示词：

   > 请用 bash 工具执行 `sleep 30`，并把 timeoutSeconds 参数设成 5。

3. **取消**——提示词：

   > 请用 bash 工具执行 `sleep 60`。

   命令跑起来后，点界面上的停止按钮把这一轮停掉。

4. **父命令先退出**——提示词：

   > 请用 bash 工具执行 `sleep 45 & echo parent-done`，只执行这一条。

   （`&` 让 sleep 变成后台孙进程，父 shell 立刻退出，考的就是这种孙进程有没有被一起收掉。）

每种形态跑完后立刻：

```powershell
Get-Process | Select-Object Id,ProcessName,Path |
  Out-File -Encoding utf8 "$ev\win-35-cmdtree-normal.txt"     # 另三次改成 timeout / cancel / orphan
# 和基线比对，只看多出来的
Compare-Object (Get-Content "$ev\win-00-baseline-processes.txt") (Get-Content "$ev\win-35-cmdtree-normal.txt") |
  Where-Object SideIndicator -eq '=>'
```

特别要盯的是 `bash.exe` 与 `sleep.exe`：

```powershell
Get-CimInstance Win32_Process -Filter "Name='bash.exe' OR Name='sleep.exe'" |
  Select-Object ProcessId,Name,CommandLine
```

四条跑完后收 trace：

```powershell
Copy-Item C:\t033\trace\runs.jsonl "$ev\win-35-trace.jsonl"
Select-String -Path "$ev\win-35-trace.jsonl" -Pattern 'termination'
```

**看什么**

- **通过的样子**：每种形态跑完 10 秒后，`bash.exe` / `sleep.exe` 都查不到了，与基线相比没有新增常驻进程；工具行末尾的 `[exit=..; ..]` 与 trace 里的 `termination` 说得出是哪一种（正常=`exit`、超时=`timeout`、取消=`aborted`、父命令先退出=`exit`）。
- **不通过的样子**：`sleep.exe` 在命令结束后还活着（孤儿）；或者 `termination` 四次都一样、分不出形态；或者出现 `cleanupError` 字样（把原文抄下来）。

**记录**：`win-35-cmdtree-normal.txt`、`win-35-cmdtree-timeout.txt`、`win-35-cmdtree-cancel.txt`、`win-35-cmdtree-orphan.txt`、`win-35-trace.jsonl`（都在 `C:\t033\evidence\win\`）；结果表 WIN-35 一行，现象里写清四种形态各自的结果。

---

### WIN-28 W4 taskkill 缺失或变慢时 bash 是否仍能成功回报【必】

> **判据（逐字）**：一条 `echo hello` 必须返回 hello 且退出码 0，不得出现 `exec_cleanup_failed`。

**背景一句话**：Windows 上每条 bash 命令结束时，运行时都会去 `%SystemRoot%\System32\taskkill.exe` 拉一个进程来清理命令树。这一项考的是：这个清理动作失败时，**命令本身的结果还算不算数**。

**准备**：两种造法，选一种，证据里写清用的是哪一种。

- 造法 A（首选，但要管理工具）：用 AppLocker 或 EDR 策略临时拦住 `taskkill.exe`。
- 造法 B（不需要任何管理工具，**没有 AppLocker 就用这个**）：把应用进程的 `SystemRoot` 指到一个不存在 `System32\taskkill.exe` 的目录。

**操作（造法 B）**

1. 关应用。
2. 新开一个 PowerShell 窗口，造一个空目录并改变量，然后**在这个窗口里**起应用：

```powershell
New-Item -ItemType Directory -Force -Path C:\t033\fakeroot | Out-Null
$app = "$env:LOCALAPPDATA\Programs\AiClient"
$env:SystemRoot = 'C:\t033\fakeroot'
$env:AICLIENT_RUNTIME_TRACE_DIR = 'C:\t033\trace'
& "$app\AiClient.exe"
```

3. 开会话，提示词：

   > 请用 bash 工具执行 `echo hello`，只执行这一条。

4. 截时间线上的工具行（要带末尾的 `[exit=0; exit]`），并抓 trace：

```powershell
Select-String -Path C:\t033\trace\runs*.jsonl -Pattern 'tool_execution_end|exec_cleanup_failed|cleanupError' |
  Out-File -Encoding utf8 "$ev\win-28-taskkill-blocked-trace.json"
Get-Content "$ev\win-28-taskkill-blocked-trace.json"
```

5. **恢复**：关应用 → **关掉这个 PowerShell 窗口**（`SystemRoot` 只在这个窗口里被改过，新开的窗口就是原值）→ 新开窗口起应用，跑一条 `echo hello` 确认恢复正常。

**看什么**

- **通过的样子**：工具结果里有 `hello`，行尾是 `[exit=0; exit]`；这一轮**没有因为 `exec_cleanup_failed` 而失败**。
- **允许出现但要照抄的**：结果详情里可能多一个 `cleanupError` 便签（内容形如 `taskkill could not start`）。这是「清理只汇报、不决定」的设计，命令本身仍然成功——把原文抄进证据，不要因此判负。
- **不通过的样子**：工具调用直接以 `exec_cleanup_failed` 结算、屏上报错、没有拿到 `hello`。
- 如果应用在改了 `SystemRoot` 之后**根本起不来**：记 ⛔，把启动报错原文抄下来，并写明造法 B 在本机不可用。

**记录**：`C:\t033\evidence\win\win-28-taskkill-blocked-trace.json` + 工具行截图 `win-28-tool-row.png`；结果表 WIN-28 一行，现象里**写清用的是造法 A 还是 B**。

---

### WIN-23 worker 被强杀后 MCP 子进程是否残留【必】

> **判据（逐字）**：杀掉 worker 进程后，它拉起的 MCP 服务器进程是否在 10 秒内消失。

**准备**：需要一个真实的 stdio MCP 服务器。样本包里就有一个（`slow-mcp-server.mjs`），把握手延时调成 0 即可。

1. 确认样本包已经拷到机器上（`C:\t033\field-samples\slow-mcp-server.mjs`）。
2. 写用户级 MCP 配置 `$state\pi-agent\mcp.json`（**JSON 里的反斜杠要写成 `\\`**）：

```powershell
$nodeJson = $node.Replace('\','\\')          # JSON 里反斜杠要写成 \\
$mcp = @"
{
  "mcpServers": {
    "slow-probe": {
      "command": "$nodeJson",
      "args": ["C:\\t033\\field-samples\\slow-mcp-server.mjs", "--delay-ms", "0"],
      "env": {}
    }
  }
}
"@
Copy-Item "$state\pi-agent\mcp.json" "$ev\win-23-mcp-backup.json" -ErrorAction SilentlyContinue
$mcp | Set-Content -Encoding UTF8 "$state\pi-agent\mcp.json"
Get-Content "$state\pi-agent\mcp.json"
```

（测完 WIN-23 / WIN-24 之后，这份 MCP 配置**留着给 WIN-30 前先删掉或备份还原**：
`if (Test-Path "$ev\win-23-mcp-backup.json") { Copy-Item "$ev\win-23-mcp-backup.json" "$state\pi-agent\mcp.json" -Force } else { Remove-Item "$state\pi-agent\mcp.json" -Force }`）

**操作**

1. 起应用，开一个会话并发一条消息，等侧栏「能力」面板里 `slow-probe` 显示为已连接（有工具数），说明 MCP 起来了。
2. 记下 worker 与 MCP 两个 PID：

```powershell
$w = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -like '*agent-host*worker.js*' }
$wpid = $w.ProcessId
Show-Tree $wpid | Out-File -Encoding utf8 "$ev\win-23-mcp-orphan-check.txt"
Get-Content "$ev\win-23-mcp-orphan-check.txt"
```

   从输出里找到命令行含 `slow-mcp-server.mjs` 的那个 PID，记作 `<mcppid>`。
3. **按 PID 强杀 worker**（只杀这一个）：

```powershell
taskkill /PID $wpid /F
```

4. 等 10 秒，看 MCP 进程还在不在：

```powershell
Start-Sleep -Seconds 10
Get-CimInstance Win32_Process -Filter "ProcessId=<mcppid>" |
  Select-Object ProcessId,Name,CommandLine |
  Out-File -Append -Encoding utf8 "$ev\win-23-mcp-orphan-check.txt"
Get-Content "$ev\win-23-mcp-orphan-check.txt"
```

**看什么**

- **通过的样子**：10 秒后查 `<mcppid>` 没有任何输出（进程已消失）。
- **不通过的样子**：10 秒后那个 node 进程还在，命令行里仍是 `slow-mcp-server.mjs`——这就是 MCP 孤儿。把 `Get-CimInstance` 的输出原样留证。
- 收尾：把这个残留（如果有）按 PID 杀掉，别让它影响后面的项。

**记录**：`C:\t033\evidence\win\win-23-mcp-orphan-check.txt`；结果表 WIN-23 一行。

---

### WIN-24 Windows 上 node 运行器孙进程的回收【必】

> **判据（逐字）**：node.exe（exec 运行器）与它下面的 MCP 进程是否都消失。

**操作**：与 WIN-23 **同一个场景**，可以接着上一项做（若上一项已把 worker 杀了，就重做一遍前两步把会话和 MCP 起回来）。

1. 杀 worker **之前**，先把整棵树存下来：

```powershell
Show-Tree $wpid | Out-File -Encoding utf8 "$ev\win-24-process-tree-before.txt"
Get-Content "$ev\win-24-process-tree-before.txt"
```

   同时让模型跑一条长命令，让 exec 运行器也在树里（提示词：请用 bash 工具执行 `sleep 60`）。
2. 按 PID 杀 worker：`taskkill /PID $wpid /F`
3. 10 秒后逐层再看一遍（用杀之前记下的每一个子孙 PID 逐个查）：

```powershell
Start-Sleep -Seconds 10
'<把 before 里的每个子孙 PID 填进来>' -split ',' | ForEach-Object {
  Get-CimInstance Win32_Process -Filter "ProcessId=$_" | Select-Object ProcessId,Name,CommandLine
} | Out-File -Encoding utf8 "$ev\win-24-process-tree-after.txt"
Get-Content "$ev\win-24-process-tree-after.txt"
```

（`wmic process where ParentProcessId=<worker>` 是检查单里写的老写法，新版 Windows 可能已经没有 wmic，上面的 `Get-CimInstance` 是等价替代。）

**看什么**

- **通过的样子**：after 文件是空的——运行器 node.exe、bash.exe、sleep.exe、MCP 服务器**全部**消失。
- **不通过的样子**：任何一层还活着。把还活着的那一层的 `Name` 与 `CommandLine` 原样记下来（是运行器还是 MCP，是第几层，决定了后续修法）。

**记录**：`C:\t033\evidence\win\win-24-process-tree-before.txt`、`win-24-process-tree-after.txt`；结果表 WIN-24 一行。

---

### WIN-6 打包 Windows 上 node.exe worker 的孤儿风险【必】

> **判据（逐字）**：应用进程退出后 tasklist 里没有以 `resources\node-runtime\node.exe` 启动的残留进程（包括强杀路径被跳过的情形）。

**操作**：两种退出各跑一次。

**第一次 —— 正常退出**

1. 起应用，开两个会话各发一条消息（保证有 worker 在跑）。
2. 正常关闭应用（点关闭 / `Stop-AiClient`）。
3. 等 10 秒后查：

```powershell
Start-Sleep -Seconds 10
tasklist /FI "IMAGENAME eq node.exe" | Out-File -Encoding utf8 "$ev\win-06-tasklist-after-exit-normal.txt"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId,ExecutablePath,CommandLine |
  Out-File -Append -Encoding utf8 "$ev\win-06-tasklist-after-exit-normal.txt"
Get-Content "$ev\win-06-tasklist-after-exit-normal.txt"
```

**第二次 —— 「导入槽拆除失败」形态的退出**（与 WIN-5 是同一个场景，**一次做完两项**）

4. 起应用，开两个会话各发一条消息。
5. 打开导入面板，挑一条**体量最大**的旧对话开始导入。
6. **在导入写盘进行中**（进度条还在动的时候）关闭应用。
7. 等 10 秒后同样查一次，存 `win-06-tasklist-after-exit-import.txt`。

> 机器上没有任何可导入的旧对话时：第二形态记 🚫，原因写「本机没有可导入的 Claude / Codex 会话源」，第一形态照做。

**看什么**

- **通过的样子**：两次查出来的 node.exe 里，**没有一个** `ExecutablePath` 是 `...\AiClient\resources\node-runtime\node.exe`（机器上别的 node.exe，比如你自己装的 Node，不算数——所以要看 `ExecutablePath` 而不是只看名字）。
- **不通过的样子**：有随包 node.exe 残留。把它的 `ProcessId` / `CommandLine` 原样记下来，然后按 PID 杀掉再继续。

**记录**：`C:\t033\evidence\win\win-06-tasklist-after-exit-normal.txt`、`win-06-tasklist-after-exit-import.txt`；结果表 WIN-6 一行，现象里写清两种退出各自的结果。

---

### WIN-5 关机时导入槽拆除失败是否吞掉整池拆除与兜底强杀【绿】

> **判据（逐字）**：退出后没有残留的 worker 进程，且 scratch 临时目录被清空；日志里能看到每个会话槽各有一次 dispose。

**操作**：就是 WIN-6 的第二次退出那个场景，**同一次退出同时取这两项的证据**。退出后：

```powershell
# 1) 残留 worker（与 WIN-6 同一份数据，可复用）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*agent-host*worker.js*' }

# 2) scratch 目录是否被清空（默认根；你若改过「保存位置」就换成你设的那个）
Get-ChildItem "$env:USERPROFILE\JYWAI\temporary\unbound-sessions" -ErrorAction SilentlyContinue |
  Out-File -Encoding utf8 "$ev\win-05-scratch-after.txt"
Get-Content "$ev\win-05-scratch-after.txt"

# 3) 日志里的拆除记录
Select-String -Path "$ud\logs\main.log" -Pattern 'worker.dispose|Worker exited|\[worker-manager\]|\[scratch\]' |
  Select-Object -Last 80 | Out-File -Encoding utf8 "$ev\win-05-shutdown-dispose.log"
Get-Content "$ev\win-05-shutdown-dispose.log"
```

**看什么**

- **通过的样子**：没有 worker 残留；`unbound-sessions` 下是空的（或目录本身不存在）；日志里**每个会话槽各有一次** dispose 相关记录，而不是只有一条就断掉。
- **不通过的样子**：导入槽拆除失败后日志戛然而止、后面的会话槽一条 dispose 都没有（说明一次失败吞掉了整池拆除）；或 `unbound-sessions` 下还留着 uuid 目录。

**记录**：`C:\t033\evidence\win\win-05-shutdown-dispose.log`、`win-05-scratch-after.txt`；结果表 WIN-5 一行。

---

### WIN-25 会话被强杀后 pid 复用的实际形态【绿】

> **判据（逐字）**：强杀应用后留下的锁，重启应用能否打开该会话。

**操作**

1. 起应用，开一个会话发一条消息（让它真的写过盘、拿到写锁）。
2. 找到这个会话的 JSONL 和它的写锁：

```powershell
Get-ChildItem "$state\pi-agent\sessions" -Recurse -Filter '*.writer.lock' |
  Select-Object FullName,LastWriteTime
```

3. **按 PID 强杀应用主进程**（不要正常关闭，正常关闭会把锁释放掉）：

```powershell
$main = Get-CimInstance Win32_Process -Filter "Name='AiClient.exe'" |
        Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)").Name -ne 'AiClient.exe' } |
        Select-Object -First 1
$main | Select-Object ProcessId,CommandLine
Stop-Process -Id $main.ProcessId -Force
```

4. 读残留锁里的 pid：

```powershell
$lock = (Get-ChildItem "$state\pi-agent\sessions" -Recurse -Filter '*.writer.lock' | Select-Object -First 1).FullName
Get-Content $lock | Out-File -Encoding utf8 "$ev\win-25-pid-reuse.txt"
Get-Content "$ev\win-25-pid-reuse.txt"
Get-CimInstance Win32_Process -Filter "ProcessId=<锁里的pid>"   # 大概率查不到，说明是陈旧锁
```

5. 重启应用，点开那个会话，截图 `win-25-reopen.png`。

**看什么**

判据这一项**要的是「记录实际形态」**，三种结果都可能是对的，照实记：

- 能直接打开（锁被判为陈旧并自动接管）；
- 报「会话被另一个写入者锁定」但给了**强制接管**按钮（也算给了出口）；
- 报错且没有任何出口（这一种是问题，要把整屏抄下来）。

**记录**：`C:\t033\evidence\win\win-25-pid-reuse.txt`、`win-25-reopen.png`；结果表 WIN-25 一行，现象写三种里的哪一种。

---

## 轮 W-d · 会话索引（约 40 分钟）

### WIN-10 Windows 上索引写入的占用失败【必】

> **判据（逐字）**：rename 是否出现 EPERM / EBUSY，以及失败后归档 / 重命名的界面表现与重启后的状态。

**准备**：确认 Windows Defender 的**实时防护是开着的**（设置 → 隐私和安全性 → Windows 安全中心 → 病毒和威胁防护 → 实时保护）。这一项考的就是杀软扫描文件时占用导致重命名失败。

**操作**

1. 起应用，确认侧栏里有 5 个以上会话（不够就多开几个、各发一条消息）。
2. 先存一份索引原样：

```powershell
Copy-Item "$ud\session-index.json" "$ev\win-10-index-before.json"
```

3. 在侧栏**连续**做操作：重命名 3 个会话、归档 3 个会话，中间不要停顿（右键会话 → 重命名 / 归档）。
4. 观察界面：有没有报错弹窗、有没有哪个会话归档后又跳回来。有就截图 `win-10-index-rename-busy.png`。
5. 抓日志：

```powershell
Select-String -Path "$ud\logs\main.log" -Pattern 'EPERM|EBUSY|session-index|rename' |
  Select-Object -Last 60 | Out-File -Encoding utf8 "$ev\win-10-main-log.txt"
Get-Content "$ev\win-10-main-log.txt"
```

6. 关应用 → 重新起应用 → 看侧栏：刚才改的名字还在吗？归档的会话还在归档状态吗？截图 `win-10-after-restart.png`。
7. 核一遍索引文件没坏：

```powershell
(Get-Content "$ud\session-index.json" -Raw | ConvertFrom-Json) -ne $null    # True = JSON 完整
(Get-Item "$ud\session-index.json").Length                                   # 不应为 0
```

**看什么**

- **通过的样子**：界面上每一步都成功，日志里没有 `EPERM` / `EBUSY`，重启后所有改动都还在，索引文件能正常解析。
- **不通过的样子**：日志里出现 `EPERM` 或 `EBUSY`（**照抄整行**）；或者界面显示成功但重启后改动丢了（这种「界面骗人」最要紧，一定要记）；或者索引文件变成 0 字节 / 解析失败。

**记录**：`win-10-index-before.json`、`win-10-index-rename-busy.png`（有报错才有）、`win-10-main-log.txt`、`win-10-after-restart.png`；结果表 WIN-10 一行。

---

### WIN-9 断电 / 强杀后的索引完整性【绿】

> **判据（逐字）**：session-index.json 是否出现零长度或半截内容。

**操作**：重复 5 次，每次都是「一轮对话刚结束的**瞬间**强杀」。

1. 起应用，发一条消息，**在模型答完的那一刻**（回复刚打完、还在几秒内）按 PID 强杀主进程：

```powershell
$main = Get-CimInstance Win32_Process -Filter "Name='AiClient.exe'" |
        Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)").Name -ne 'AiClient.exe' } |
        Select-Object -First 1
Stop-Process -Id $main.ProcessId -Force
```

2. 立刻检查索引文件：

```powershell
$n = 1     # 每一轮改成 1..5
Copy-Item "$ud\session-index.json" "$ev\win-09-index-after-kill-$n.json"
(Get-Item "$ud\session-index.json").Length
try { Get-Content "$ud\session-index.json" -Raw | ConvertFrom-Json | Out-Null; 'JSON OK' }
catch { "JSON BROKEN: $($_.Exception.Message)" }
```

3. 起应用，确认侧栏会话列表正常，再进行下一轮。

**看什么**

- **通过的样子**：5 次里每一次文件长度都 > 0、`JSON OK`、重启后侧栏完整。
- **不通过的样子**：出现 0 字节文件，或 `JSON BROKEN`（半截内容），或重启后侧栏少了会话。哪怕 5 次里只中 1 次，也记 ⛔ 并写明是第几次。

**记录**：`C:\t033\evidence\win\win-09-index-after-kill-1.json` ～ `-5.json`；结果表 WIN-9 一行，现象写「5 次全部完整」或「第 N 次出现 X」。

---

### WIN-31 W9 写锁在 PID 复用下的表现【绿】

> **判据（逐字）**：伪造一份 writer.lock，pid 填一个当前存活的无关进程、host 填本机名，打开该会话：期望能打开或至少给用户接管出口；报 `session_locked` 即复现。

**准备**：**先备份**，测完要删掉伪造的 sidecar。

**操作**

1. 关应用。挑一个会话的 JSONL：

```powershell
$sess = (Get-ChildItem "$state\pi-agent\sessions" -Recurse -Filter '*.jsonl' | Select-Object -First 1).FullName
$sess
$lock = "$sess.writer.lock"
if (Test-Path $lock) { Copy-Item $lock "$ev\win-31-lock-backup.json" }   # 有就先备份
```

2. 找一个**当前存活的无关进程**的 pid（例如记事本），并造锁：

```powershell
$victim = Start-Process notepad -PassThru        # 随便起一个无关进程当「占用者」
$fake = @{
  pid        = $victim.Id
  host       = [System.Net.Dns]::GetHostName()
  token      = [guid]::NewGuid().ToString()
  acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText($lock, $fake)
Get-Content $lock | Out-File -Encoding utf8 "$ev\win-31-forged-lock.txt"
Get-Content "$ev\win-31-forged-lock.txt"
```

   > `acquiredAt` 必须是**现在的时间**。填成开机之前的时间，这把锁会被判成「上次开机留下的陈旧锁」而直接被接管，就测不到想测的东西了。

3. 起应用，点开那个会话，**截整屏** `win-31-forged-lock.png`。
4. **恢复**（必做）：

```powershell
Remove-Item $lock -Force
if (Test-Path "$ev\win-31-lock-backup.json") { Copy-Item "$ev\win-31-lock-backup.json" $lock }
Stop-Process -Id $victim.Id -Force      # 关掉刚才那个记事本
```

**看什么**

- **可接受的样子（判据说的「能打开或至少给接管出口」）**：会话直接打开；或者出现标题「会话被另一个写入者锁定」的卡片，**卡上有「强制接管」按钮**。
- **复现 W9 的样子**：报 `session_locked` 且没有任何接管出口——照抄整屏文案。
- 无论哪种，都把卡片文案原文抄进证据。

**记录**：`C:\t033\evidence\win\win-31-forged-lock.txt`、`win-31-forged-lock.png`；结果表 WIN-31 一行。

---

## 轮 W-e · 终端、TUI 与注册表编码（约 45 分钟）

### WIN-12 Windows 默认 shell 与 spawn 回退【必】

> **判据（逐字）**：无 PowerShell 7 的机器上内嵌终端能正常打开；自定义 shell 路径失效时给出可读错误而非原生 spawn 报错。

**准备**：机器上如果装了 PowerShell 7，要把它临时改名（**需要管理员权限**）。先看有没有：

```powershell
where.exe pwsh
```

**操作**

1. 关应用。
2. 如果上一步查到了 pwsh，**以管理员身份**打开 PowerShell 改名：

```powershell
Rename-Item 'C:\Program Files\PowerShell\7\pwsh.exe' 'pwsh.exe.bak'
where.exe pwsh        # 应当什么都查不到
```

   改不了（没有管理员权限 / 文件被占用）就换一条路：用一个**没装 pwsh 的 Windows 账户**登录来做这一项；两条都做不了就记 🚫 写明原因。
3. 起应用 → 打开内嵌终端（终端面板）→ 截图 `win-12-no-pwsh.png`，并在终端里敲 `$PSVersionTable.PSVersion` 看它落到了哪个 PowerShell。
4. 再测失效的自定义路径：设置页 → 终端 → Shell 选「自定义 / Custom」→ 路径填一个**不存在**的文件，例如 `C:\t033\no-such-shell.exe` → 保存 → 开一个新终端 → 截图 `win-12-bad-custom-shell.png`。
5. 抓日志佐证：

```powershell
Select-String -Path "$ud\logs\main.log" -Pattern '\[pty\]' | Select-Object -Last 20 |
  Out-File -Encoding utf8 "$ev\win-12-pty-log.txt"
Get-Content "$ev\win-12-pty-log.txt"
```

6. **恢复**：设置页把 Shell 改回默认；关应用；管理员 PowerShell 里把 pwsh 改回来：

```powershell
Rename-Item 'C:\Program Files\PowerShell\7\pwsh.exe.bak' 'pwsh.exe'
where.exe pwsh
```

**看什么**

- **通过的样子**：没有 pwsh 时终端照样打开（落到 `powershell.exe`，`$PSVersionTable.PSVersion` 显示 5.x）；自定义路径失效时**也能打开一个可用的终端**，日志里有一条 `[pty] Shell not found: ... Falling back to ...`。
- **不通过的样子**：终端面板空白 / 一直转圈 / 弹出 node-pty 的原生英文 spawn 错误（形如 `spawn C:\t033\no-such-shell.exe ENOENT`）且没有任何终端。
- 另记一句：回退发生时**界面上有没有告诉用户**「你配的 shell 不在，已回退到 X」。当前实现只写日志，如实记录即可。

**记录**：`win-12-no-pwsh.png`、`win-12-bad-custom-shell.png`、`win-12-pty-log.txt`；结果表 WIN-12 一行。

---

### WIN-13 Windows 上的 TUI 启动计划【必】

> **判据（逐字）**：pi 能起来，PATH 含 node-runtime 目录，Path/PATH 双键不造成取值异常。

**操作**

1. 起应用，开一个会话（要发过至少一条消息，会话文件才存在）。
2. 点会话栏右上角的 **TUI** 开关，切到内嵌终端里的 pi。
3. pi 是一个 agent，**直接敲 `node -v` 会被当成提示词**。用这条提示：

   > 请用 bash 工具依次执行 `node -v` 和 `echo $PATH`，把两条的原始输出都贴出来。

   （pi 里若能直接开一个 cmd，也可以按检查单原文跑 `echo %PATH%`；两种写法记哪一种就写哪一种。）
4. 截图 `win-13-tui-path.png`，把两条输出拍全。
5. 另存一份文本：把 pi 输出里的 PATH 整段复制出来存 `win-13-tui-path.txt`。

**看什么**

- **通过的样子**：pi 正常起来（有欢迎界面、能应答）；`node -v` 输出 `v24.18.0`；PATH 的**第一项**是 `...\AiClient\resources\node-runtime`。
- **不通过的样子**：pi 起不来（黑屏 / 报 `Pi CLI artifact is missing` / 报 `Pi Node runtime is missing`）；或者 PATH 里根本没有 node-runtime 目录；或者 `node -v` 报的是机器上另一个 Node 的版本。
- 「Path/PATH 双键」这一条的观察点：Windows 的环境变量名不分大小写，但 Node 里两个键可能同时存在。如果 PATH 里出现了**同一个目录被拼了两遍**、或者 pi 报「找不到 node」而磁盘上明明有，就是这条出问题了，照抄现象。

**记录**：`win-13-tui-path.png`、`win-13-tui-path.txt`；结果表 WIN-13 一行。

---

### WIN-32 W10 注册表 PATH 解码【必】

> **判据（逐字）**：在用户级 PATH 里加一个带中文的目录，起应用后在内嵌终端里打印 PATH，该条目必须与注册表原文逐字节一致。

**操作**

1. 关应用。
2. **先备份**用户级 PATH，再追加一个带中文的目录：

```powershell
$oldPath = [Environment]::GetEnvironmentVariable('Path','User')
$oldPath | Set-Content -Encoding UTF8 "$ev\win-32-user-path-backup.txt"
New-Item -ItemType Directory -Force -Path 'C:\t033\中文路径-测试' | Out-Null
[Environment]::SetEnvironmentVariable('Path', ($oldPath.TrimEnd(';') + ';C:\t033\中文路径-测试'), 'User')
```

3. 取一份「注册表原文」两种读法各一份：

```powershell
# .NET 直接读注册表（字节准确，作为基准）
[Environment]::GetEnvironmentVariable('Path','User') | Out-File -Encoding utf8 "$ev\win-32-reg-dotnet.txt"
# 检查单原文写的 reg query（输出受控制台代码页影响，两份都留）
reg query "HKCU\Environment" /v Path | Out-File -Encoding utf8 "$ev\win-32-reg-query.txt"
Get-Content "$ev\win-32-reg-dotnet.txt"
```

4. 起应用（**必须是改完变量之后新起的**，进程只在启动时读一次环境）→ 打开内嵌终端 → 在终端里打印：

```powershell
$env:Path -split ';' | Where-Object { $_ -like '*中文*' }
```

5. 截图 `win-32-registry-path.png`，把终端输出拍清楚。

6. **恢复**（必做）：

```powershell
[Environment]::SetEnvironmentVariable('Path', $oldPath, 'User')
[Environment]::GetEnvironmentVariable('Path','User')      # 与 win-32-user-path-backup.txt 对一遍
Remove-Item 'C:\t033\中文路径-测试' -Recurse -Force
```

**看什么**

- **通过的样子**：内嵌终端里打出来的是 `C:\t033\中文路径-测试`，**和 `win-32-reg-dotnet.txt` 里的那一段一模一样**。
- **不通过的样子**：终端里显示成 `C:\t033\?????-??` 、`涓枃璺緞` 这类乱码或问号，或者这一项干脆不见了。乱码要**原样截图**（不要手打重抄，手打会把证据抄没）。

**记录**：`win-32-reg-dotnet.txt`、`win-32-reg-query.txt`、`win-32-user-path-backup.txt`、`win-32-registry-path.png`；结果表 WIN-32 一行。

---

## 轮 W-f · bash 载体取证（约 50 分钟，F3 根因的一半）

**这一轮的结果直接决定 ENC-8（F3 根因）怎么拍板**，别跳过。另一半（R2/R3）在 ENC 组。

**顺序要求**：WIN-16 要 Git 在；WIN-17 与 WIN-29 要 Git **不在**。所以先做 WIN-16，再一次性把 Git 改名做掉 WIN-17 + WIN-29，最后改回来。轮 W-b 的源码探针也要 Git，**确认 W-b 已经做完**再动 Git。

### WIN-16 R0 bash 进程映像取证【必】

> **判据（逐字）**：拿到 Windows 映像绝对路径与父进程链，而不是 shell 自报的 MSYS 路径（test.12 只拿到后者）。

**操作**

1. 起应用，开会话，提示词：

   > 请用 bash 工具执行 `sleep 60`，只执行这一条。

   （要一条跑得够久的命令，否则进程一闪就没了、抓不到。）
2. 命令跑起来后，**在另一个 PowerShell 窗口**立刻抓：

```powershell
Get-CimInstance Win32_Process -Filter "Name='bash.exe'" |
  Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine |
  Format-List | Out-File -Encoding utf8 "$ev\win-16-bash-image-path.txt"
Get-Content "$ev\win-16-bash-image-path.txt"
```

3. 用上一步的 ProcessId 追父进程链：

```powershell
Show-Chain <bash的ProcessId> | Out-File -Encoding utf8 "$ev\win-16-parent-chain.txt"
Get-Content "$ev\win-16-parent-chain.txt"
```

4. 把候选顺序也存一份，用来逐条对照（`Get-BashCandidates` 在 §0.5，按 `src/runtime/host/shell.ts` 的候选顺序写的）：

```powershell
'--- bash 候选清单（True = 这个路径上真有 bash.exe）---' |
  Out-File -Append -Encoding utf8 "$ev\win-16-bash-image-path.txt"
Get-BashCandidates | Out-File -Append -Encoding utf8 "$ev\win-16-bash-image-path.txt"
Get-Content "$ev\win-16-bash-image-path.txt"
```

**看什么**

- **通过的样子**：拿到了 `ExecutablePath`（一个真实的 Windows 绝对路径）**和**一条完整的父进程链，链条大致是
  `bash.exe ← node.exe（exec 运行器）← node.exe（worker）← AiClient.exe`。
- **一个必须记清的细节**：`CommandLine` 里 spawn 用的路径与 `ExecutablePath`（实际映像）**可能不是同一个**——Git 的 `bin\bash.exe` 是个转发器，真正跑起来的往往是 `usr\bin\bash.exe`。两个都要记，F3 的白名单映射就靠这个区分。
- **不通过的样子**：`ExecutablePath` 是空的（权限不够，换管理员 PowerShell 再抓一次）；或者只能拿到 shell 自己报的 `/c/Program Files/...` 这种 MSYS 路径——那就是 test.12 那次无效的原因，必须拿到 Windows 原生路径才算数。
- 最后逐条对照第 4 步的候选清单：**实际用的是候选顺序里的第几个**？写进现象里。

**记录**：`C:\t033\evidence\win\win-16-bash-image-path.txt`、`win-16-parent-chain.txt`；结果表 WIN-16 一行。

---

### WIN-17 R4 有效的无 Bash 探针【必】

> **判据（逐字）**：worker 的 shell resolver 真正落到 `shell_unconfigured`，且应用不崩不挂。**现场记录必须写明覆盖了哪几个候选**（test.12 那次因未覆盖默认安装目录而无效）。

**准备**：动手前先关应用。这一项与 WIN-29 是**同一个机器状态**，一次改名两项一起取证。

**操作**

1. 关应用。先把候选清单存下来（这就是「写明覆盖了哪几个候选」的证据）：

```powershell
'=== 改名前 ===' | Out-File -Encoding utf8 "$ev\win-17-r4-covered-candidates.txt"
Get-BashCandidates | Out-File -Append -Encoding utf8 "$ev\win-17-r4-covered-candidates.txt"
Get-Content "$ev\win-17-r4-covered-candidates.txt"
```

   清单里每一行 `True` 的都是**必须覆盖掉的候选**。三类候选是：
   - `%ProgramFiles%\Git\bin\bash.exe` 与 `%ProgramFiles(x86)%\Git\bin\bash.exe`
   - `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
   - PATH 各项下的 `bash.exe`，以及 PATH 里以 `cmd` 结尾的目录的 `..\bin\bash.exe`

   > `C:\Windows\System32\bash.exe`（WSL 启动器）**不用动**——代码明确跳过 system32 / sysnative。

2. 把 Git 安装目录整个改名（改目录名比改 PATH 可靠，一刀覆盖上面大部分候选）：

```powershell
Rename-Item 'C:\Program Files\Git' 'Git.bak'     # 路径按你机器的实际安装位置改
```

3. 重新跑一次候选清单，**确认每一行都是 `False`**：

```powershell
'=== 改名后 ===' | Out-File -Append -Encoding utf8 "$ev\win-17-r4-covered-candidates.txt"
Get-BashCandidates | Out-File -Append -Encoding utf8 "$ev\win-17-r4-covered-candidates.txt"
Get-Content "$ev\win-17-r4-covered-candidates.txt"
```

   还有 `True` 的，把那个路径也临时改名，再跑一次，直到全 `False`。**每改一个都要记在证据里。**
4. 起应用，开会话，提示词：

   > 请用 bash 工具执行 `echo hello`。如果你没有 bash 这个工具，就直接告诉我「没有 bash 工具」，不要换别的方式。

5. 截图 `win-17-shell-unconfigured.png`，并抓 trace：

```powershell
Select-String -Path C:\t033\trace\runs*.jsonl -Pattern 'shell_unconfigured|tool_execution' |
  Out-File -Encoding utf8 "$ev\win-17-shell-unconfigured-trace.json"
Get-Content "$ev\win-17-shell-unconfigured-trace.json"
```

6. **先别急着改回来**——接着做 WIN-29，两项做完再一起恢复。

**看什么**

- **通过的样子**：应用**不崩不挂**，会话照常可用；模型的回答表明它**手里根本没有 bash 这个工具**（当前实现是：找不到 shell 就不注册 bash 工具），或者调用时明确报 `shell_unconfigured`。两种形态都属于「resolver 落到了 shell_unconfigured 这条路」，照实记是哪一种。
- **不通过的样子**：应用崩溃、白屏、卡死；或者模型照样调 bash 并且**成功了**（说明还有一个候选没覆盖到，回第 3 步继续找）。
- 现象里**必须写清覆盖了哪几个候选**，否则这一项和 test.12 那次一样不成立。

**记录**：`C:\t033\evidence\win\win-17-r4-covered-candidates.txt`（改名前后两份清单）、`win-17-shell-unconfigured-trace.json`、`win-17-shell-unconfigured.png`；结果表 WIN-17 一行。

---

### WIN-29 W6 无 Git for Windows 时的表现【绿】

> **判据（逐字）**：期望 bash 工具不出现在工具列表里，且应用给出一条可操作的中文提示。当前实现预期会失败，记录实际文案原文。

**操作**：接着 WIN-17 的状态（Git 已改名）做，**不用再改一次**。

1. 在同一个会话里追问：

   > 你现在有哪些工具可以用？请把工具名列全。

2. 截图 `win-29-no-git-message.png`，把模型列出的工具名拍全。
3. 另外看一眼应用有没有给用户提示（横幅 / 侧栏「能力」面板 / 设置页），有就一起截进去。
4. 抓 trace：

```powershell
Select-String -Path C:\t033\trace\runs*.jsonl -Pattern 'shell_unconfigured|"tool"' |
  Out-File -Encoding utf8 "$ev\win-29-trace.json"
```

5. **恢复**（WIN-17 + WIN-29 一起恢复，必做）：

```powershell
# 关应用后再改回来
Rename-Item 'C:\Program Files\Git.bak' 'Git'
Test-Path 'C:\Program Files\Git\bin\bash.exe'     # 应为 True
# 第 3 步里临时改名的其它候选，也逐个改回来
```

   恢复后起应用跑一条 `echo hello` 确认 bash 工具回来了。

**看什么**

- **第一半句（bash 工具不在列表里）**：现在的代码确实是「没有 shell 就不注册 bash 工具」，所以这半句**有可能通过**——照实记模型列出来的工具里有没有 bash。
- **第二半句（可操作的中文提示）**：检查单写明**当前实现预期会失败**。照抄应用实际给出的文案原文（很可能一条都没有，那就写「应用侧没有任何提示」）。
- 两半句分开记，不要合成一句「通过」或「不通过」。

**记录**：`win-29-no-git-message.png`、`win-29-trace.json`；结果表 WIN-29 一行，现象里分开写两半句。

---

## 轮 W-g · 打包态 GUI 回归（约 60 分钟，本轮全是【绿】）

### WIN-1 归档一个正在跑回合的临时对话【绿】

> **判据（逐字）**：目录删除发生在 worker 退出之后；无残留目录，main.log 里没有 `[scratch] failed to remove`。

**操作**

1. 起应用，新建一个**临时对话**（不选文件夹的那种），发一条会跑很久的消息，例如：

   > 请用 bash 工具执行 `sleep 90`，然后告诉我结果。

2. 先记下这个会话的 scratch 目录：

```powershell
Get-ChildItem "$env:USERPROFILE\JYWAI\temporary\unbound-sessions" | Select-Object Name,FullName
```

3. **回合还在跑的时候**，在侧栏右键这个会话 → 归档。
4. 立刻查目录和进程：

```powershell
Get-ChildItem "$env:USERPROFILE\JYWAI\temporary\unbound-sessions" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bash.exe' OR Name='sleep.exe'" |
  Select-Object ProcessId,Name,CommandLine
```

5. 抓日志：

```powershell
Select-String -Path "$ud\logs\main.log" -Pattern '\[scratch\]|SIGTERM|aborted' |
  Select-Object -Last 40 | Out-File -Encoding utf8 "$ev\win-01-archive-during-run.log"
Get-Content "$ev\win-01-archive-during-run.log"
```

**看什么**

- **通过的样子**：归档后那个 uuid 目录消失；日志里能看到回合被中止（`SIGTERM` / `aborted`）**在前**、`[scratch] Released ...` **在后**；日志里**没有** `[scratch] Failed to remove`（大小写不敏感地找，检查单里写的是小写）。
- **不通过的样子**：出现 `[scratch] Failed to remove`（照抄整行）；或者 uuid 目录还在；或者 `sleep.exe` 在归档后还活着。
- 参考（开发机 Linux 侧已验过的形态）：归档后 11 毫秒 bash 就收到 SIGTERM、回合状态变 aborted、worker 退出之后目录才删。

**记录**：`C:\t033\evidence\win\win-01-archive-during-run.log`；结果表 WIN-1 一行。

---

### WIN-4 手工删除临时工作区后的自愈（保存位置带尾部分隔符）【绿】

> **判据（逐字）**：目录被就地重建且带 .git；不出现 workspace_missing 卡片。

**操作**

1. 起应用 → 设置页 → 常规 → **保存位置**，填一个**带尾部反斜杠**的路径，例如 `C:\t033\tmproot\`（末尾那个 `\` 是这一项的重点）→ 保存。
2. 新建一个临时对话，发一条消息，让它真的分配目录。
3. 找到目录并确认它带 `.git`：

```powershell
Get-ChildItem 'C:\t033\tmproot\unbound-sessions' -Force | Select-Object Name
Get-ChildItem 'C:\t033\tmproot\unbound-sessions\<uuid>' -Force | Select-Object Name   # 应当看到 .git
```

4. **手工把这个 uuid 目录整个删掉**：

```powershell
Remove-Item 'C:\t033\tmproot\unbound-sessions\<uuid>' -Recurse -Force
```

5. 回到应用，重新打开这个对话，再发一条消息。
6. 再查一次目录：

```powershell
Get-ChildItem 'C:\t033\tmproot\unbound-sessions\<uuid>' -Force | Select-Object Name
```

7. 截图 `win-04-selfheal.png`（对话界面 + 目录列表各一张也行）。

**看什么**

- **通过的样子**：目录**在原地被重建**（还是同一个 uuid），里面有 `.git`；界面上照常回复，**没有**出现「工作目录已不存在」（`workspace_missing`）的卡片。
- **不通过的样子**：出现「工作目录已不存在」卡片；或者目录换了一个新的 uuid（不是就地重建）；或者目录重建了但没有 `.git`。
- 另记一句：scratch 目录**实际落在哪个根**。如果你设了 `C:\t033\tmproot\` 却落在了 `%USERPROFILE%\JYWAI\temporary\`，那是「保存位置」设置没被读到，属于回归，要单独记下来。

**记录**：`win-04-selfheal.png`、目录列表输出 `win-04-selfheal.txt`；结果表 WIN-4 一行。

---

### WIN-18 GUI F/15 的 F2-a/c 新包复验【绿】

> **判据（逐字）**：临时根改设置后两处解析一致；用户目录缺失时给 workspace_missing 而非裸 ENOENT。

**操作**

**F2-a（两处解析一致）**——接着 WIN-4 的设置做：

1. 保存位置仍是 `C:\t033\tmproot\`。
2. 新建一个**临时对话**发一条消息 → 记下 scratch 目录路径。
3. 再用应用的**临时工作区**功能建一个临时工作区 → 记下它的目录路径。
4. 两个路径都要在 `C:\t033\tmproot\` 这个根下面（分别在不同的子层）：

```powershell
Get-ChildItem 'C:\t033\tmproot' -Recurse -Depth 2 -Force -Directory |
  Select-Object FullName | Out-File -Encoding utf8 "$ev\win-18-f2a-roots.txt"
Get-Content "$ev\win-18-f2a-roots.txt"
```

**F2-c（用户目录缺失）**：

5. 新建一个**绑定到普通目录**的会话，目录选 `C:\t033\gone`（先建出来），发一条消息。
6. 关应用 → 删掉 `C:\t033\gone` → 起应用 → 打开那个会话 → 发一条消息。
7. 截图 `win-18-f2ac.png`。

**看什么**

- **F2-a 通过的样子**：两个路径都落在你设的那个根下面（`C:\t033\tmproot\...`），没有一个落回默认的 `%USERPROFILE%\JYWAI\temporary`。
- **F2-c 通过的样子**：出现标题「**工作目录已不存在**」的卡片，正文能读懂。
- **不通过的样子**：屏上是一句裸的英文系统错误，例如 `spawn C:\...\node.exe ENOENT` 或 `ENOENT: no such file or directory`——那就是没有被转成可读卡片，照抄原文。

**记录**：`win-18-f2a-roots.txt`、`win-18-f2ac.png`；结果表 WIN-18 一行。

---

### WIN-20 F6 右侧审阅栏打包后回归【绿】

> **判据（逐字）**：安装包里右侧审阅栏能记录 Edit/Write 修改，上限行为与本地一致。

**操作**

1. 建一个工作目录 `C:\t033\ws-review`，里面先放三个文件：

```powershell
New-Item -ItemType Directory -Force -Path C:\t033\ws-review | Out-Null
'hello' | Set-Content C:\t033\ws-review\small.txt
# 一个超过 256 KiB 的大文本文件（用来看上限行为）
('x' * 300000) | Set-Content C:\t033\ws-review\big.txt
[IO.File]::WriteAllBytes('C:\t033\ws-review\blob.bin', (1..1024 | ForEach-Object { [byte]($_ % 256) }))
```

2. 起应用，用这个目录开会话，提示词：

   > 请依次做三件事：把 small.txt 的内容改成 hello-world；在 big.txt 末尾追加一行 tail；给 blob.bin 追加一个字节。每一步都用 Edit 或 Write 工具。

3. 打开右侧审阅栏，截图 `win-20-review-rail.png`，三个文件的条目都要拍到。

**看什么**

- **通过的样子**：三个文件都在审阅栏里出现；`small.txt` 能展开看到逐行 diff；`big.txt` 显示「差异超出预览上限」一类提示（英文原文是 `Diff exceeds the preview limit.`）；`blob.bin` 显示「二进制内容没有文本差异」一类提示（英文原文是 `Binary content has no text diff.`）。
- **不通过的样子**：审阅栏是空的（改动完全没记录）；或者大文件 / 二进制文件被当成文本硬展开成乱码。

**记录**：`C:\t033\evidence\win\win-20-review-rail.png`；结果表 WIN-20 一行。

---

### WIN-21 H/17 本地模式 AI 服务在打包产物里可用【绿】

> **判据（逐字）**：添加自定义服务后模型选择器能拉到模型列表并可对话；safeStorage 不可用时界面如实显示未加密。

**操作**

1. 起应用 → 设置页 → 模型 / AI 服务 → 添加一个自定义服务（用你自己的 provider，填 baseUrl 与 key）。**不要把 key 写进任何证据文件或截图**——截图前把 key 输入框那一块遮住或清空再截。
2. 保存后打开模型选择器，看能不能拉到模型列表。
3. 选一个模型，发一条消息，确认能正常出话。
4. 截图 `win-21-h17-local-mode.png`（服务列表 + 模型选择器 + 一条成功回复）。
5. 看界面上有没有关于「加密存储」的提示文案，一起截进去。

**看什么**

- **通过的样子**：模型列表拉得到、能对话；界面上关于凭据加密的说明与实际一致（Windows 上 safeStorage 一般是可用的，所以应当**不**显示「未加密」）。
- **不通过的样子**：模型列表是空的；或者对话报错；或者界面显示「已加密」而实际没加密（这一条要看 `$state\credentials\vault.json` 里 `enc` 字段是 `safeStorage` 还是 `none`）：

```powershell
(Get-Content "$state\credentials\vault.json" -Raw | ConvertFrom-Json).enc
```

**记录**：`win-21-h17-local-mode.png`、`win-21-vault-enc.txt`（只存 `enc` 字段的值，**不要存整个 vault 文件**）；结果表 WIN-21 一行。

---

### WIN-22 H/19 插件安装在打包产物里的路径解析正确【绿】

> **判据（逐字）**：`currentPiCliLayout()` 在打包布局下解析出的 pi 可执行文件路径存在且可跑；安装/卸载后 settings.json 与 node_modules 增减正确。

**操作**

1. 先确认打包布局下的 pi CLI 文件在：

```powershell
$cli = "$app\resources\agent-host\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
Test-Path $cli
& $node $cli --version     # 用随包 node 直接跑一次，看它有没有反应
```

2. 装插件前先存两份基线：

```powershell
Copy-Item "$state\pi-agent\settings.json" "$ev\win-22-settings-before.json" -ErrorAction SilentlyContinue
Get-ChildItem "$state\pi-agent\node_modules" -Directory -ErrorAction SilentlyContinue |
  Select-Object Name | Out-File -Encoding utf8 "$ev\win-22-modules-before.txt"
```

3. 起应用 → 设置页 → 插件 → 装一个插件（**装一个 pi 权限扩展**，MODEL 组后面要用它）。
4. 装完后再存一份，并做差异：

```powershell
Copy-Item "$state\pi-agent\settings.json" "$ev\win-22-settings-after.json"
Get-ChildItem "$state\pi-agent\node_modules" -Directory |
  Select-Object Name | Out-File -Encoding utf8 "$ev\win-22-modules-after.txt"
Compare-Object (Get-Content "$ev\win-22-modules-before.txt") (Get-Content "$ev\win-22-modules-after.txt") |
  Out-File -Encoding utf8 "$ev\win-22-settings-diff.txt"
Get-Content "$ev\win-22-settings-diff.txt"
```

5. 在插件页点一次「列表 / 刷新」确认它列得出来，截图 `win-22-pi-install.png`。
6. 再装一个**无关紧要的插件**并把它卸载，确认卸载后 node_modules 里对应目录消失、settings.json 里对应条目消失。

> **权限扩展装完就留着不要卸** —— MODEL 组的 DEV-36 第 ② 半句要用它。

**看什么**

- **通过的样子**：`Test-Path $cli` 为 True 且 `--version` 有输出；安装后 `node_modules` 多出对应目录、`settings.json` 多出对应条目；卸载后两边都减回去。
- **不通过的样子**：报 `Pi CLI artifact is missing: <路径>`（路径解析错了，照抄路径）；或者界面说安装成功但磁盘上什么都没多出来。

**记录**：`win-22-pi-install.png`、`win-22-settings-before.json`、`win-22-settings-after.json`、`win-22-settings-diff.txt`、`win-22-modules-before.txt`、`win-22-modules-after.txt`；结果表 WIN-22 一行。

---

### WIN-14 Windows 路径脱敏规则对真实 stderr 行生效【绿】

> **判据（逐字）**：真实 Windows 上 worker stderr 里出现的 `C:\Users\<含空格用户名>\…` 在 Context 面板显示为 `~\…`；WSL / UNC 两族同理。

**准备**：这一项最好在**用户名带空格**的账户上做。当前账户名：

```powershell
$env:USERNAME
```

用户名不带空格时照做，但在现象里写明「本机用户名不含空格，带空格那一支未覆盖」。

**操作**

1. 制造一条含用户目录的 worker stderr。最省事的造法就是复用 WIN-2 的场景：关应用 → 把随包 node.exe 改名 → 起应用发一条消息（错误信息里就会带那个绝对路径）。
2. 打开侧栏的**上下文（Context）面板**，找到 **`Host stderr`** 分组。
3. 截图 `win-14-stderr-redaction.png`，把那几行原样拍下来。
4. **恢复**：关应用 → node.exe 改回名字。

**看什么**

- **通过的样子**：面板里那几行的用户目录部分显示成 `~\...`，看不到你的真实用户名。
- **不通过的样子**：面板里明晃晃写着 `C:\Users\<你的用户名>\...`。
- WSL（`/mnt/c/Users/...`）与 UNC（`\\server\Users\...`）两族当天造不出来就写「未覆盖」，不要凭空判通过。

**记录**：`C:\t033\evidence\win\win-14-stderr-redaction.png`；结果表 WIN-14 一行。

---

### WIN-15 Windows 上的 shell 工具名【绿】

> **判据（逐字）**：Windows 下工具行仍是 bash（不是 powershell），动词表命中「已运行」。

**准备**：界面语言要设成**中文**（设置页 → 外观 / 语言）。

**操作**

1. 起应用，开会话，提示词：

   > 请用 bash 工具执行 `echo hello`，只执行这一条。

2. 截时间线上的那一行工具行 `win-15-tool-row.png`，把工具名、动词和末尾的 `[exit=0; exit]` 都拍进去。

**看什么**

- **通过的样子**：工具行上的名字是 `bash`（不是 `powershell`、不是 `cmd`），动词显示为「**已运行**」。
- **不通过的样子**：工具名显示成 `powershell`；或者动词是英文 `Ran`（说明中文词表没命中）。

**记录**：`C:\t033\evidence\win\win-15-tool-row.png`；结果表 WIN-15 一行。

---

## 轮 W-h · 导入路径与托管模式（约 30 分钟，本轮全是【绿】）

### WIN-11 Windows 下的导入路径拼接与盘符还原【绿】

> **判据（逐字）**：CLAUDE_CONFIG_DIR / CODEX_HOME 取 Windows 路径时扫描与落盘均正常；`decodeProjectDirNameFallback` 在真实项目目录名上给出正确的盘符路径。

**准备**：机器上要有可导入的源。先看有没有：

```powershell
Test-Path "$env:USERPROFILE\.claude\projects"
Test-Path "$env:USERPROFILE\.codex\sessions"
$env:CLAUDE_CONFIG_DIR
$env:CODEX_HOME
```

四个都没有 → 这一项记 🚫，原因写「本机没有 Claude / Codex 导入源」。

**操作**

1. 起应用 → 打开导入面板。
2. 截图 `win-11-import-paths.png`，**把项目路径那一列拍清楚**。
3. 挑一条会话导入，导入完成后找到落盘产物：

```powershell
Get-ChildItem "$state\pi-agent\sessions" -Recurse -Filter '*.jsonl' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3 FullName,LastWriteTime |
  Out-File -Encoding utf8 "$ev\win-11-import-paths.txt"
Get-Content "$ev\win-11-import-paths.txt"
```

**看什么**

- **通过的样子**：导入面板里显示的项目路径是**正常的 Windows 路径**（`C:\Users\...\某项目`），不是 `-C--Users-...` 这种编码后的目录名，也不是丢了盘符的 `\Users\...`；导入产物确实落在 `$state\pi-agent\sessions\` 下。
- **不通过的样子**：项目路径显示成编码串 / 缺盘符 / 盘符变成了目录名（例如 `C\Users\...`），把屏上原文抄下来。

**记录**：`win-11-import-paths.png`、`win-11-import-paths.txt`；结果表 WIN-11 一行。

---

### WIN-8 托管模式 + 钥匙串锁定下的三个功能【绿】

> **判据（逐字）**：`resolveNativeModelCatalog()` 返回 undefined → worker 回落读 agent 目录 → 功能仍可用，或给出可理解的错误。

**先读这一段**：判据里的「钥匙串锁定」在 Linux / macOS 上是真实存在的状态（钥匙环被锁）。**Windows 上没有这个状态**——凭据加密走的是系统 DPAPI，它跟着登录会话走，没有「锁上」这一说。所以这一项在 Windows 上只能用**等价造法**：把凭据保险库弄成读不出来的样子，逼出同一条代码路径（凭据不可读 → 不下发模型目录 → worker 回落读 agent 目录）。造法和结论都要在证据里写清楚。

**操作**

1. 关应用。**备份**保险库：

```powershell
Copy-Item "$state\credentials\vault.json" "$ev\win-08-vault-backup.json"
```

2. 把加密载荷改坏（只动 `payload` 字段，改几个字符即可，让解密失败）：

```powershell
$v = Get-Content "$state\credentials\vault.json" -Raw | ConvertFrom-Json
$v.payload = 'AAAA' + $v.payload
$v | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 "$state\credentials\vault.json"
```

3. 起应用，依次点三个 utility 功能：**代码评审**、**分支命名**、**生成提交信息**（在 Git 面板里）。
4. 每个功能都记：能不能用？报的错误码 / 文案是什么？截图 `win-08-keychain-locked.png`。
5. 抓日志：

```powershell
Select-String -Path "$ud\logs\main.log" -Pattern 'utility|modelCatalog|vault|auth.json' |
  Select-Object -Last 60 | Out-File -Encoding utf8 "$ev\win-08-keychain-locked.txt"
Get-Content "$ev\win-08-keychain-locked.txt"
```

6. **恢复**（必做）：

```powershell
Copy-Item "$ev\win-08-vault-backup.json" "$state\credentials\vault.json" -Force
```

   起应用确认凭据恢复正常（模型还能出话）。

**看什么**

- **通过的样子**：三个功能**要么照常能用**（说明 worker 回落去读了 agent 目录里的 `auth.json`），**要么给出一条能看懂的错误**（说明白是凭据读不出来）。
- **不通过的样子**：功能静默失败（点了没反应、没有任何提示）；或者报一个纯技术错误码、用户看不懂是怎么回事。
- 判据里要求记的三件事逐个记：**错误码**、`utility.start` 载荷里**有没有带 modelCatalog**（看日志）、**worker 有没有读到 auth.json**（看日志）。

**记录**：`win-08-keychain-locked.txt`、`win-08-keychain-locked.png`、`win-08-vault-backup.json`；结果表 WIN-8 一行，现象里**写明用的是「改坏 vault」这个等价造法**，不是真的锁钥匙串。

---

## 轮 W-i · stdio MCP 在 Windows 上（约 25 分钟）

### WIN-30 W7 windows-03：stdio MCP 在 Windows 上能否起来【必】

> **判据（逐字）**：把 command 配成 `npx`、args 配成 `-y` 加一个官方 server 包名，期望服务器连上且工具出现在列表里。
> **取证方式（逐字）**：写进 MCP 配置起会话，看 mcp_status 与侧栏徽标与 worker stderr 日志；再用绝对 `npx.cmd` 路径试一次，记录两次的错误原文。

**背景一句话**：这条链路上两次 spawn 都是 `shell:false`，而 Windows 上 `npx` / `npm` / `uvx` 实际都是 `.cmd` 批处理文件——不经过 shell 就起不来。这一项就是要把这个形态在真机上钉死。

**准备**：机器上要有 Node / npm（`where.exe npx`）。没有就记 🚫。

**操作 —— 第一次（command 写 `npx`）**

1. 关应用，写 MCP 配置：

```powershell
$mcp = @'
{
  "mcpServers": {
    "fs-probe": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\t033\\ws"],
      "env": {}
    }
  }
}
'@
Copy-Item "$state\pi-agent\mcp.json" "$ev\win-30-mcp-backup.json" -ErrorAction SilentlyContinue
$mcp | Set-Content -Encoding UTF8 "$state\pi-agent\mcp.json"
```

2. 起应用，开会话发一条消息（MCP 是随 worker 起的）。
3. 打开侧栏的「**能力**」面板（左侧 Dock 上的积木图标），看 `fs-probe` 这一行的状态。截图 `win-30-sidebar-badge.png`。
4. 抓 worker stderr 与日志里的 MCP 状态：

```powershell
Select-String -Path "$ud\logs\main.log" -Pattern 'mcp|fs-probe|ENOENT|spawn' |
  Select-Object -Last 60 | Out-File -Encoding utf8 "$ev\win-30-mcp-npx.txt"
Select-String -Path C:\t033\trace\runs*.jsonl -Pattern 'mcp_servers|mcp_failed|mcp_tools' |
  Out-File -Append -Encoding utf8 "$ev\win-30-mcp-npx.txt"
Get-Content "$ev\win-30-mcp-npx.txt"
```

**操作 —— 第二次（command 写绝对 `npx.cmd` 路径）**

5. 关应用，查到 npx.cmd 的绝对路径并改配置：

```powershell
(Get-Command npx.cmd).Source          # 例如 C:\Program Files\nodejs\npx.cmd
```

   把上面 JSON 里的 `"command": "npx"` 换成这个绝对路径（**反斜杠写成 `\\`**），重跑第 2 ～ 4 步，输出存 `win-30-mcp-npxcmd.txt`。

6. **恢复**：把 MCP 配置还原（或删掉这个 server 条目）：

```powershell
if (Test-Path "$ev\win-30-mcp-backup.json") { Copy-Item "$ev\win-30-mcp-backup.json" "$state\pi-agent\mcp.json" -Force }
else { Remove-Item "$state\pi-agent\mcp.json" -Force }
```

**看什么**

- **通过的样子**：「能力」面板里 `fs-probe` 显示已连接并带一个工具数；trace 的版本戳里 `mcp_servers` ≥ 1 且 `mcp_failed` 为 0。
- **不通过的样子（这是当前的预期形态）**：面板里 `fs-probe` 标红 `Failed` 并带一行错误，日志里是 `spawn npx ENOENT` 一类。**两次的错误原文都要一字不差地抄下来**——第一次（`npx`）与第二次（绝对 `npx.cmd`）的错误可能不一样，差别本身就是结论。

**记录**：`win-30-mcp-npx.txt`、`win-30-mcp-npxcmd.txt`、`win-30-sidebar-badge.png`；结果表 WIN-30 一行，现象里写清两次分别是什么错。

---

## 轮 W-j · 纯探索（约 30 分钟，**时间不够先砍这一整轮**）

### WIN-33 W12 长路径（MAX_PATH）边界【探】

> **判据（逐字）**：工作区里造一条总长超过 300 字符的路径并放一个 ts 文件，跑 glob 与 read 该文件，期望都成功。

**操作**

1. 造深目录（PowerShell 5.1 对超长路径支持有限，用 `\\?\` 前缀绕开）：

```powershell
$base = 'C:\t033\ws-long'
New-Item -ItemType Directory -Force -Path $base | Out-Null
$deep = $base
1..12 | ForEach-Object { $deep = Join-Path $deep ('segment-' + ('a' * 20)) }
New-Item -ItemType Directory -Force -Path "\\?\$deep" | Out-Null
$file = Join-Path $deep 'probe.ts'
[IO.File]::WriteAllText("\\?\$file", "export const LONGPATH_CANARY = 'T033-LONGPATH';`n")
$file.Length            # 应当 > 300
Test-Path "\\?\$file"   # True
```

> PowerShell 5.1 对 `\\?\` 前缀支持不稳，报错就换一条路：先 `subst X: C:\t033\ws-long` 把根路径缩短，再在 `X:\` 下逐级 `New-Item` 造同样深的目录（造完 `subst X: /d` 解除，工作区仍用 `C:\t033\ws-long` 打开）。两条都不行就记 🚫 写明卡在造样本这一步。

2. 起应用，用 `C:\t033\ws-long` 开会话，提示词：

   > 请先用 glob 工具搜 `**/*.ts`，再用 read 工具读出你找到的那个文件的内容。

3. 截图 `win-33-long-path.png`，并把工具结果原文存文本：

```powershell
Select-String -Path C:\t033\trace\runs*.jsonl -Pattern 'LONGPATH_CANARY|glob|read' |
  Out-File -Encoding utf8 "$ev\win-33-long-path.txt"
```

**看什么**

- **通过的样子**：glob 返回了那个文件，read 读回了 `T033-LONGPATH` 这个哨兵串。
- **不通过的样子**：glob 返回空；或 read 报路径过长 / ENOENT。**报错原文照抄**——这一项全仓零处理零用例，做完至少要能回答「有没有问题」。

**记录**：`win-33-long-path.txt`、`win-33-long-path.png`；结果表 WIN-33 一行。

---

### WIN-34 W14 映射网络盘或 junction 工作区的 glob 与 grep【探】

> **判据（逐字）**：在 subst 出来的虚拟盘或映射网络盘上开工作区，glob 必须返回非空。

**操作**

1. 先在真实路径下建一个有几个文件的工作区，并记下基线结果：

```powershell
New-Item -ItemType Directory -Force -Path C:\t033\ws-subst | Out-Null
1..5 | ForEach-Object { "export const N$_ = $_;" | Set-Content "C:\t033\ws-subst\f$_.ts" }
(Get-ChildItem C:\t033\ws-subst -Filter *.ts).Count      # 基线数量：5
Test-Path T:\                                            # 先确认 T: 没被占用，占了就换一个没用过的盘符
subst T: C:\t033\ws-subst
Get-ChildItem T:\ -Filter *.ts | Select-Object Name
```

2. 起应用，**用 `T:\` 这个盘符**打开工作区，开会话，提示词：

   > 请用 glob 工具搜 `**/*.ts`，把找到的文件列全；再用 grep 工具搜 `export const`。

3. 截图 `win-34-subst-glob.png`，并存工具结果原文 `win-34-subst-glob.txt`。
4. **恢复**：

```powershell
subst T: /d
```

**看什么**

- **通过的样子**：glob 在 `T:\` 下返回 5 个文件（和基线数量一致），grep 也有命中。
- **不通过的样子**：glob 返回空、或返回数量与基线对不上、或路径被还原成了 `C:\t033\ws-subst`（说明 subst 盘被解引用了，这本身也是一个要记的事实）。

**记录**：`win-34-subst-glob.txt`、`win-34-subst-glob.png`；结果表 WIN-34 一行。

---

## 移到别的分片的两项

### WIN-37 permissions-19：Windows 分隔符下的权限判定【必】（在 MODEL 组执行）

> **判据（逐字）**：同一条规则在 `\`、`/`、MSYS `/c/` 三种拼法下判定一致（T001 已修静态面，Linux 载体结构上发现不了这条）。

这一项与 **MODEL-33（W3）用同一组命令、同一轮做**，所以放在 MODEL 组分片里执行，**本分片不重复做**。结果表 WIN-37 那一行等 MODEL 组做完后回填。

### ENC-15 W5 正常路径下每条 bash 的 taskkill 耗时

场地在加密盘，归 ENC 组分片，本分片不涉及。

---

## 结果表（做完一项填一行，不要留空）

| 编号 | 结果 | 一句现象 | 证据文件 |
|---|---|---|---|
| WIN-1 | | | |
| WIN-2 | | | |
| WIN-3 | 🚫 | 已退役：T068（`d2bbbf13`）删掉了整条 Node 24 解析链，该变量在代码里已不存在，无可验对象 | — |
| WIN-4 | | | |
| WIN-5 | | | |
| WIN-6 | | | |
| WIN-7 | | | |
| WIN-8 | | | |
| WIN-9 | | | |
| WIN-10 | | | |
| WIN-11 | | | |
| WIN-12 | | | |
| WIN-13 | | | |
| WIN-14 | | | |
| WIN-15 | | | |
| WIN-16 | | | |
| WIN-17 | | | |
| WIN-18 | | | |
| WIN-19 | ✅ | 已由 Build #59（run 35295618831）结案：三平台 success，三份 worker-smoke `ok=true` / `backend=native` / Windows `carrier=bundled-node` | `evidence/batch-e-build-2026-09-18/worker-smoke-*.json` |
| WIN-20 | | | |
| WIN-21 | | | |
| WIN-22 | | | |
| WIN-23 | | | |
| WIN-24 | | | |
| WIN-25 | | | |
| WIN-26 | | | |
| WIN-27 | | | |
| WIN-28 | | | |
| WIN-29 | | | |
| WIN-30 | | | |
| WIN-31 | | | |
| WIN-32 | | | |
| WIN-33 | | | |
| WIN-34 | | | |
| WIN-35 | | | |
| WIN-36 | | | |
| WIN-37 | | （随 MODEL-33 同一轮做，见 MODEL 组分片，做完回填这一行） | |

**收尾**：全部填完后，把 `C:\t033\evidence\win\` 整个目录打包回传，连同这张表一起交给编排器判读。**截图不要一张一张传**，当天结束时一次性打包。

```powershell
Compress-Archive -Path C:\t033\evidence\win\* -DestinationPath C:\t033\evidence\win-evidence.zip -Force
```
