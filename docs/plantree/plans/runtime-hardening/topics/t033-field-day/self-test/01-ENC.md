# T033 自测分片 01 · ENC 组（加密文件系统 / TSD，24 项）

Role: detail shard。上位：[自测总纲](00-总纲.md)。顺序与档位来自[执行单](../../t033-field-day-runbook.md)，判据权威是 [checklist-e.md](../../../checklist-e.md)（第 4 节加密机表 + 第 5.1 节判据更正）。编排器版分片：[02-enc.md](../02-enc.md)。

**开工前**：[总纲 §4「第 0 步」](00-总纲.md#4-第-0-步开工前必须做完的七件事)七件事必须全部做完，尤其是第 0.6 条（带 trace 变量启动）。

本分片 24 项的档位分布：**【必】15 · 【绿】7 · 【探】1 · 【不做】1**。

---

## 0. 本组通用约定

### 0.1 场地：在受策略目录下建一个工作区

ENC 组每一项都在**受加密策略的目录**里做。先建一个本组专用的工作区，后面所有项都用它：

```powershell
# 下面这一行换成你在第 0.3 步记下来的受策略目录
$enc = 'D:\Encrypted\t033'
New-Item -ItemType Directory -Path $enc -Force | Out-Null
cd $enc
git init            # ENC-12 要用 Git 面板，这里先初始化好
```

**一个关键前提，现在就验**：这个目录必须真的受策略覆盖。用 PowerShell（一个非白名单进程）写一个文件再读它的头：

```powershell
Set-Content -LiteralPath "$enc\premise-check.txt" -Value 'T033-PREMISE-CHECK' -Encoding ASCII
Get-Head16 -Path "$enc\premise-check.txt"
```

- `IsTsdMagic = True` → 目录真的受策略覆盖，可以继续。
- `IsTsdMagic = False`（看到的是明文 `T033-PREMISE-CHECK`）→ **要么这个目录没被策略覆盖，要么 PowerShell 本身也在白名单里**。两种都会让 ENC 组大半项失去意义。把这一屏存成 `C:\t033\evidence\enc\enc-00-premise-check.txt`，在结果表最上面加一行说明，然后继续做——但每一项的结论都要带上这个背景。

> 2026-09-09 那次现场（test.12）栽的就是这里：R1/R2/R3 三条探针都「成功读到明文」，但**没人证明目标文件当时真的是加密态**，于是三条结果全部无法签收。这一步就是补上那一环。

### 0.2 怎么让模型去调某个工具

ENC 组大部分项要靠模型调用工具来触发。开工前先确认能正常出话（随便发一句「你好」，能回话就行）。**网关不通的话 ENC 组做不了，直接整组记 🚫 并写明原因。**

固定提问模板（中文界面）：

| 要触发的工具 | 照抄这句话发给模型 |
|---|---|
| read | `请用 read 工具读取 <绝对路径>，把内容原样贴出来，不要解释、不要加工。` |
| write | `请用 write 工具在 <绝对路径> 创建文件，内容就是这一行：<哨兵串>` |
| edit | `请用 edit 工具把 <绝对路径> 里的 <旧串> 改成 <新串>，只改这一处。` |
| bash | `请用 bash 工具执行这条命令，把输出原样贴出来：<命令>` |
| grep | `请用 grep 工具在当前工作区里搜索 <哨兵串>，把结果原样贴出来。` |

两条注意：

1. **bash 工具走的是 Git Bash**，命令里的路径要用 MSYS 写法：`D:\Encrypted\t033\a.txt` 写成 `/d/Encrypted/t033/a.txt`（盘符小写、冒号去掉、反斜杠改斜杠），路径里有空格就整体加单引号。
2. 工具第一次碰工作区外的路径会**弹权限卡**（中文的结构化审批卡）。点「允许」即可，这不是缺陷。卡片本身是 MODEL 组在验的东西，这里不用记。

### 0.3 哨兵串约定

本组统一用 `T033-ENC-CANARY-A` 和 `T033-ENC-CANARY-B` 这两个串。好处是后面任何一处输出，一眼就能看出是不是我们写进去的那份内容。

---

## 轮 E-0 · 当天的第一项

### ENC-16 E1：随包 node.exe 仍在驱动白名单内 【必】

**准备**

在受策略目录下用 PowerShell 造一个样本，并先记下它在盘上的样子：

```powershell
Set-Content -LiteralPath "$enc\enc16-sample.txt" -Value 'T033-ENC-CANARY-A enc16 sample' -Encoding ASCII
Get-Head16 -Path "$enc\enc16-sample.txt" | Save-Evidence -Group enc -Id 16 -Slug ondisk-header
Get-Head16 -Path "$enc\enc16-sample.txt"
```

**操作**

1. `Stop-AiClient`，然后 `Start-AiClient`（确保这一次启动带着 trace 变量）。
2. 新建一个对话，工作区选 `$enc` 这个目录。
3. 发这句话：`请用 read 工具读取 D:\Encrypted\t033\enc16-sample.txt，把内容原样贴出来，不要解释、不要加工。`（路径换成你自己的）
4. 展开时间线上那一行 read 工具，把工具输出截图。
5. 取这一次 run 的版本戳：

```powershell
$last = Get-Content C:\t033\trace\runs.jsonl -Tail 1 | ConvertFrom-Json
$last.version_stamp | ConvertTo-Json -Depth 5 | Out-File 'C:\t033\evidence\enc\enc-16-version-stamp.json' -Encoding UTF8
$last.version_stamp | Select-Object carrier, tsd_read_fallback, node_exec_path, config_version | Format-List
```

**看什么**

判据（checklist ENC 组第 16 项，逐字）：**「安装版 GUI 里 read 一个受策略文件返回明文；不出现 `io_tsd_unavailable`」**，取证要求「读工具输出截图 + 同一次 run 的 runs.jsonl 版本戳（应为 `carrier=bundled-node`、`tsd_read_fallback=disabled`、`node_exec_path=…\node-runtime\node.exe`）」。

- **通过长这样**：工具输出里能看到完整的 `T033-ENC-CANARY-A enc16 sample`；版本戳三项分别是 `carrier = bundled-node`、`tsd_read_fallback = disabled`、`node_exec_path` 以 `…\resources\node-runtime\node.exe` 结尾。
- **不通过长这样（两种）**：
  - 工具行报错，错误码是 `io_tsd_unavailable`，文案形如 `TSD read requires configured Node (carrier bundled-node, node ..., fallback disabled): <路径> opens with the 16-byte TSD container header and is <N> bytes`；
  - 或者工具输出是一串乱码 / 以 `%TSD-Header-###%` 开头的内容。
- 两种都要把**错误文案原文**抄下来。

**不通过就先停一下**：ENC 组后面所有项的判据都建立在「随包 `node.exe` 仍在白名单内」这个前提上。不通过的话，ENC-7 / ENC-8 的 A/B/C 映射要按「载体不在白名单」那一支重新解释。**不要自己改判，照做下去，但在结果表最上面写一行大字提醒编排器。**

**记录**

- `C:\t033\evidence\enc\enc-16-read-plaintext.png`（工具输出截图）
- `C:\t033\evidence\enc\enc-16-version-stamp.json`
- `C:\t033\evidence\enc\enc-16-ondisk-header.txt`（盘上的头 16 字节）
- 结果表填 ✅/⛔/🚫 + 一句现象

---

## 轮 E-a · 明文往返与载体识别

> **这一轮七项共用同一份样本文件**，不要分七次造样本。先做下面 ENC-17 的「准备」，后面几项都用那个 `tracked.txt`。

### ENC-17 E2：Write → Read 明文往返 【必】

**准备**

无（样本就在这一项里造）。

**操作**

1. 对模型说：`请用 write 工具在 D:\Encrypted\t033\tracked.txt 创建文件，内容就是这一行：T033-ENC-CANARY-A`
2. 等工具行显示写入成功之后，**用 PowerShell（非白名单进程）读它的头 16 字节**：

```powershell
Get-Head16 -Path "$enc\tracked.txt" | Save-Evidence -Group enc -Id 17 -Slug header-bytes
Get-Head16 -Path "$enc\tracked.txt"
```

3. 回到应用，对模型说：`请用 read 工具读取 D:\Encrypted\t033\tracked.txt，把内容原样贴出来，不要解释、不要加工。`
4. 展开 read 工具行截图。

**看什么**

判据（checklist ENC 组第 17 项，逐字）：**「write 写出的文件在盘上是密文容器（非白名单进程看到 `%TSD-Header-###%` 与容器大小），而 GUI read 读回原文」**。

- **通过长这样**：`Get-Head16` 的 `IsTsdMagic = True`（Ascii 那一列显示 `%TSD-Header-###%`，Hex 是 `25 54 53 44 2d 48 65 61 64 65 72 2d 23 23 23 25`），`IsContainerSize = True`；而 GUI 的 read 工具输出是完整的 `T033-ENC-CANARY-A`。
- **不通过长这样（两种，分别记）**：
  - `IsTsdMagic = False`，盘上直接就是明文 → 这个文件没有被加密。先回头看 §0.1 的前提检查结论，把这一条写清楚。
  - GUI read 报 `io_tsd_unavailable` 或读回乱码 → 往返断在读这一侧。

**记录**

- `C:\t033\evidence\enc\enc-17-header-bytes.txt`
- `C:\t033\evidence\enc\enc-17-gui-read.png`
- 结果表一行

### ENC-18 E3：edit 的读-改-写不破坏加密 【必】

**准备**

用 ENC-17 那份 `tracked.txt`。先把 edit 之前的头存一份：

```powershell
'=== before edit ===' | Out-File 'C:\t033\evidence\enc\enc-18-header-before-after.txt' -Encoding UTF8
Get-Head16 -Path "$enc\tracked.txt" | Format-List | Out-File 'C:\t033\evidence\enc\enc-18-header-before-after.txt' -Encoding UTF8 -Append
```

**操作**

1. 对模型说：`请用 edit 工具把 D:\Encrypted\t033\tracked.txt 里的 T033-ENC-CANARY-A 改成 T033-ENC-CANARY-B，只改这一处。`
2. edit 完成后再取一次头，追加到同一个文件：

```powershell
'=== after edit ===' | Out-File 'C:\t033\evidence\enc\enc-18-header-before-after.txt' -Encoding UTF8 -Append
Get-Head16 -Path "$enc\tracked.txt" | Format-List | Out-File 'C:\t033\evidence\enc\enc-18-header-before-after.txt' -Encoding UTF8 -Append
```

3. 对模型说：`请用 read 工具读取 D:\Encrypted\t033\tracked.txt，把内容原样贴出来。` 截图。

**看什么**

判据（checklist ENC 组第 18 项，逐字）：**「对受策略文件 edit 一次后，文件仍是密文容器，GUI 再读内容正确，非白名单进程仍看到密文」**。

- **通过长这样**：edit 前后两次 `Get-Head16` 的 `IsTsdMagic` 都是 `True`；GUI read 读回的是改后的 `T033-ENC-CANARY-B`。
- **不通过长这样**：edit 之后 `IsTsdMagic` 变成 `False`（文件被写成了明文，加密被破坏了，**这是最严重的一种**，一定要连 `Sha256` 和文件大小一起记）；或者 GUI read 读不回来 / 读到的还是 A。

**记录**

- `C:\t033\evidence\enc\enc-18-header-before-after.txt`
- `C:\t033\evidence\enc\enc-18-gui-read-after-edit.png`
- 结果表一行

### ENC-20 E5：bash 叶子进程读到的是明文还是密文 【必】

**准备**

沿用 `tracked.txt`（此时内容应是 `T033-ENC-CANARY-B`）。把 Windows 路径换成 MSYS 写法，例如 `D:\Encrypted\t033\tracked.txt` → `/d/Encrypted/t033/tracked.txt`。

**操作**

1. 对模型说：`请用 bash 工具执行这条命令，把输出原样贴出来：cat '/d/Encrypted/t033/tracked.txt'`
2. 把 bash 工具行的输出**逐字**抄进 `C:\t033\evidence\enc\enc-20-bash-output.txt`（或截图后再抄一份文本，文本便于比对）。
3. 再让模型用 read 工具读同一个文件（如果 ENC-18 刚读过，可以直接用那一次的输出），把输出抄进 `C:\t033\evidence\enc\enc-20-gui-output.txt`。
4. 比对两份：

```powershell
Compare-Object `
  (Get-Content 'C:\t033\evidence\enc\enc-20-bash-output.txt') `
  (Get-Content 'C:\t033\evidence\enc\enc-20-gui-output.txt') |
  Out-File 'C:\t033\evidence\enc\enc-20-bash-vs-gui.diff' -Encoding UTF8
Get-Content 'C:\t033\evidence\enc\enc-20-bash-vs-gui.diff'
```

**看什么**

判据（checklist ENC 组第 20 项，逐字）：**「bash 执行 `type`/`cat` 受策略文件的输出与 GUI read 一致」**，取证是「同一文件两条路径各取一次输出并 diff」。这一项复核的是「Git Bash 在白名单内」这个 2026-09-09 的结论，在**当前这台机器 / 当前驱动版本**上是否仍然成立。

- **通过长这样**：`Compare-Object` 没有输出（两份完全一致），两边都是明文 `T033-ENC-CANARY-B`。
- **不通过长这样（三种，分别记原文）**：
  - bash 输出是 `%TSD-Header-###%` 开头的乱码 → Git Bash 不在白名单；
  - bash 报 `Bad file descriptor` 或输出为空 → 载体级失败（和 GUI 当初同类）；
  - bash 报 `shell_unconfigured` → 这台机器上根本没找到 bash（那是 WIN-17 的事，这里照实记）。

**记录**

- `C:\t033\evidence\enc\enc-20-bash-vs-gui.diff`
- `C:\t033\evidence\enc\enc-20-bash-output.txt`、`enc-20-gui-output.txt`
- 结果表一行

### ENC-7 R2/R3：随包 node 与改名副本各读一次 【必】

这一项是 F3 根因（ENC-8）最关键的两个数据点。**先把「盘上确实是密文」这一环存证**，再做两次读取。

**准备**

1. 存证盘上的容器头与哈希（这是 test.12 缺的那一环）：

```powershell
Get-Head16 -Path "$enc\tracked.txt" | Format-List |
  Out-File 'C:\t033\evidence\enc\enc-07-sha256.txt' -Encoding UTF8
```

2. 造一份**只改文件名、不改目录**的随包 node 副本（这样「文件名」是唯一变化的变量；test.12 那次同时改了目录和名字，结论因此不成立）：

```powershell
Copy-Item -LiteralPath "$app\resources\node-runtime\node.exe" `
          -Destination "$app\resources\node-runtime\bash-probe.exe" -Force
Test-Path "$app\resources\node-runtime\bash-probe.exe"
```

**操作**

1. **R2（随包 node.exe 原名读）**——对模型说（路径换成你自己的 MSYS 写法）：

   `请用 bash 工具执行这条命令，把输出原样贴出来：'/c/Users/<你>/AppData/Local/Programs/AiClient/resources/node-runtime/node.exe' -e "console.log(require('fs').readFileSync('/d/Encrypted/t033/tracked.txt','utf8'))"`

   把输出抄进 `enc-07-r2-bundled-node.txt`。

2. **R3（同目录改名副本读）**——同一条命令，把 `node.exe` 换成 `bash-probe.exe`：

   `请用 bash 工具执行这条命令，把输出原样贴出来：'/c/Users/<你>/AppData/Local/Programs/AiClient/resources/node-runtime/bash-probe.exe' -e "console.log(require('fs').readFileSync('/d/Encrypted/t033/tracked.txt','utf8'))"`

   把输出抄进 `enc-07-r3-renamed-copy.txt`。

3. 两份输出的内容各算一次 SHA256，追加到 `enc-07-sha256.txt`（便于和盘上那份比）。

**看什么**

判据（checklist ENC 组第 7 项，逐字）：**「样本先被非白名单进程读出 `%TSD-Header-###%` 头并存证；两次读取的明文/密文两态可区分，据此唯一映射到『按进程名/路径』或『按签名/目录』或『按父进程』」**。

- **可用的结果长这样**：`enc-07-sha256.txt` 里有盘上的容器头存证（`IsTsdMagic = True`），并且 R2 与 R3 的结果**能区分出明文还是密文**——四种组合都算有效数据：
  - R2 明文 + R3 明文
  - R2 明文 + R3 密文
  - R2 密文 + R3 明文
  - R2 密文 + R3 密文
- **不可用的结果长这样（要记 ⛔）**：盘上那份本来就是明文（没有容器头存证）→ 两次读取都读到明文也说明不了任何事，这正是 test.12 失败的原因。

**记录**

- `C:\t033\evidence\enc\enc-07-r2-bundled-node.txt`
- `C:\t033\evidence\enc\enc-07-r3-renamed-copy.txt`
- `C:\t033\evidence\enc\enc-07-sha256.txt`
- 结果表一行

**恢复（做完立刻做）**

```powershell
Remove-Item -LiteralPath "$app\resources\node-runtime\bash-probe.exe" -Force
Test-Path "$app\resources\node-runtime\bash-probe.exe"     # 期望 False
```

### ENC-21 E6：TSD 魔数误判的现场形态 【必】

**准备**

手写一个**明文**文件，但让它长得像加密容器。两个条件缺一不可（源码 `src/runtime/host/io.ts:41-44, 152-155`）：前 16 字节正好是 `%TSD-Header-###%`，**并且**文件大小 ≥ 4096 且是 4096 的整数倍。只满足第一条不会触发。

```powershell
# 4096 字节：魔数 + 哨兵串 + 空格填满
$buf = New-Object byte[] 4096
for ($i = 0; $i -lt 4096; $i++) { $buf[$i] = 0x20 }
$magic = [Text.Encoding]::ASCII.GetBytes('%TSD-Header-###%')
[Array]::Copy($magic, 0, $buf, 0, $magic.Length)
$mark = [Text.Encoding]::ASCII.GetBytes('T033-ENC21-PLAINTEXT-NOT-A-CONTAINER')
[Array]::Copy($mark, 0, $buf, $magic.Length, $mark.Length)
[IO.File]::WriteAllBytes("$enc\enc21-fake-container.txt", $buf)

# 对照组：同样的开头，但 4000 字节（不是 4096 的整数倍）
[IO.File]::WriteAllBytes("$enc\enc21-control-4000.txt", [byte[]]($buf[0..3999]))

Get-Head16 -Path "$enc\enc21-fake-container.txt"
Get-Head16 -Path "$enc\enc21-control-4000.txt"
```

> 注意：这两个文件写在受策略目录里，驱动可能会把它们**真的加密**，那样 `Get-Head16` 看到的头就不是我们写的那 16 字节了。如果出现这种情况，把这两个文件改到一个**不受策略**的普通目录（例如 `C:\t033\enc21\`）再做——这一项验的是产品自己的魔数判定，不依赖加密。把你实际用的目录写进证据里。

**操作**

1. 对模型说：`请用 read 工具读取 <enc21-fake-container.txt 的绝对路径>，把内容原样贴出来。`
2. **把错误文案一字不改地抄下来**（这是 FIX 之后的对照基准，措辞很重要）。
3. 对模型说：`请用 read 工具读取 <enc21-control-4000.txt 的绝对路径>，把内容原样贴出来。`（对照组）
4. 抓 trace：

```powershell
Get-Trace -Pattern 'io_tsd' -Tail 5 | Save-Evidence -Group enc -Id 21 -Slug trace-rows
```

**看什么**

判据（checklist ENC 组第 21 项，逐字）：**「手写一个以 `%TSD-Header-###%` 开头的明文 txt，read 它；期望当前报 `io_tsd_unavailable`；记录原始文案，作为 FIX 后的对照」**。

- **符合当前预期长这样**：4096 字节那份报 `io_tsd_unavailable`，文案里会带 `opens with the 16-byte TSD container header and is 4096 bytes`；4000 字节的对照组**正常读回明文**。这说明判定同时看了魔数和大小——这正是当前实现。**这是「复现已知形态」，不是发现缺陷，照抄文案即可。**
- **与预期不符长这样**：4096 那份也正常读回了明文（说明判定没命中，先回头确认文件大小真的是 4096），或者报了别的错误码（抄下来）。

**记录**

- `C:\t033\evidence\enc\enc-21-magic-false-positive.txt`（两次 read 的原始文案 + 你用的目录）
- `C:\t033\evidence\enc\enc-21-trace-rows.txt`
- 结果表一行

**恢复**：对照组文件 `enc21-control-4000.txt` 可以删；`enc21-fake-container.txt` **先留着**，下一项 ENC-19 要用。

### ENC-19 E4：单个读不了的文件不打垮 grep 【必】

**准备**

grep 需要「工作区里有一个当前进程读不了的受策略文件」。有两种造法，**优先用第一种**（不需要管理员，结果稳定）：

- **造法 A（推荐）**：直接用上一项的 `enc21-fake-container.txt`。产品读它会得到 `io_tsd_unavailable`，而这个错误码正是 grep 会计进 `skipped` 的那一类（源码 `src/runtime/plugins/tools/index.ts:68-76, 655-663`）。把它拷进 `$enc` 工作区。
- **造法 B（备选）**：用 `icacls` 去掉当前账户对某个文件的读权限。**这会改机器状态，恢复步骤见本项末尾。**

同时放几个能命中的正常文件：

```powershell
Copy-Item "$enc\enc21-fake-container.txt" "$enc\unreadable-sample.txt" -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath "$enc\hit-1.txt" -Value 'T033-ENC-GREP-NEEDLE one'   -Encoding ASCII
Set-Content -LiteralPath "$enc\hit-2.txt" -Value 'T033-ENC-GREP-NEEDLE two'   -Encoding ASCII
Set-Content -LiteralPath "$enc\hit-3.txt" -Value 'T033-ENC-GREP-NEEDLE three' -Encoding ASCII
```

造法 B 的命令（只在 A 不成立时用）：

```powershell
icacls "$enc\unreadable-sample.txt" /deny "$env:USERNAME:(R)"
```

**操作**

1. 对模型说：`请用 grep 工具在当前工作区里搜索 T033-ENC-GREP-NEEDLE，把结果原样贴出来。`
2. 展开 grep 工具行截图（注意看有没有 skipped 的数字）。
3. 抓 trace 里这一次 grep 的结束行：

```powershell
Get-Trace -Pattern 'tool_execution_end' -Tail 3 | Save-Evidence -Group enc -Id 19 -Slug grep-trace
```

**看什么**

判据（checklist ENC 组第 19 项，逐字）：**「工作区里存在当前进程读不了的受策略文件时，grep 仍返回其余命中并报出 skipped 条数」**。

- **通过长这样**：grep 返回了 `hit-1/2/3` 三处命中，并且结果里带 `skipped` 的计数且 ≥ 1（trace 的 `tool_execution_end` 行里能看到 `"skipped":1` 这样的字段）。
- **不通过长这样**：整个 grep 调用失败报错（一个读不了的文件把整次搜索打垮了）；或者命中正常但 `skipped` 是 0 / 根本没有这个字段（读不了的那个文件被静默吞了）。

**记录**

- `C:\t033\evidence\enc\enc-19-grep-with-unreadable.txt`（工具输出原文）
- `C:\t033\evidence\enc\enc-19-grep-trace.txt`
- 结果表一行

**恢复（用了造法 B 才需要）**

```powershell
icacls "$enc\unreadable-sample.txt" /remove:d "$env:USERNAME"
Remove-Item "$enc\unreadable-sample.txt","$enc\enc21-fake-container.txt","$enc\enc21-control-4000.txt" -Force -ErrorAction SilentlyContinue
```

### ENC-8 F3 根因拍板 —— 纯判读，不用操作 【必】

**这一项你不用碰机器，只要把三个已有结果抄进下面这张表。最终结论由编排器拍板，你不需要选。**

**准备**

手边要有三份结果：

| 输入 | 来自哪一项 | 抄什么 |
|---|---|---|
| R0 | **WIN-16**（在 WIN 分片里，bash 进程映像取证） | 实际选中的 `bash.exe` 的**绝对路径**，以及父进程链。注意：要的是从进程表里拿到的**映像路径**，不是 shell 自己 `cygpath` 报出来的路径 |
| R2 / R3 | 本分片 **ENC-7** | 两次读取分别是明文还是密文 |
| E5 | 本分片 **ENC-20** | bash `cat` 的输出与 GUI read 是否一致（明文还是密文） |

**操作**

1. 建一个文件 `C:\t033\evidence\enc\enc-08-f3-inputs.md`，把下面这张表抄进去并填满：

```
| 输入 | 来源项 | 实际结果（照抄，不要总结） |
|---|---|---|
| R0：bash 进程映像绝对路径 | WIN-16 |  |
| R0：父进程链 | WIN-16 |  |
| R2：随包 node.exe 原名读 | ENC-7 | 明文 / 密文 / 报错（写清楚） |
| R3：同目录改名副本读 | ENC-7 | 明文 / 密文 / 报错（写清楚） |
| E5：bash cat 的输出 | ENC-20 | 与 GUI read 一致 / 是密文 / 报错 |
| 盘上容器头存证是否拿到 | ENC-7 | 是 / 否 |
```

2. 对照下面的映射表，在同一个文件里写一行「按映射表看指向 X」。**这只是你的读表结果，不是结论**——真正的拍板、以及三处文档回填，由编排器做。

| 现场结果 | 指向 |
|---|---|
| R1/E5 读到明文，R0 拿到了真实映像路径与父进程链 | **A（维持系统 Git Bash）**，代价 0 |
| bash 读到密文，但随包 node 改名副本（R3）读到明文 | 放行按**签名或目录路径** → **B（随包 Git Bash）可行** |
| R2 明文而 R3 密文 | 放行按**进程名** → **B 不可行**，走缓解或 **C** |
| bash 与随包 node 都读到密文 | **C（Windows 不提供 bash 工具）**，能力大幅退化，作为临时降级 |

**看什么**

判据（checklist ENC 组第 8 项，逐字）：**「由 R0/R2/R3 的结果唯一映射到 A（维持现状）/ B（随包 node 包一层）/ C（走 Git Bash）之一」**。

- **能签长这样**：三份输入齐全（尤其是 **R0 真的拿到了进程映像路径**），并且落在上表某一行里。
- **不能签长这样**：
  - **WIN-16 没拿到进程映像路径** → 这一项直接记 ⛔，原因写「R0 前提缺失」。这是硬条件：决策文件第 8 节点明，版本戳里**没有记 shell 路径**，所以现场没法用 trace 自证「这次 bash 用的是哪一个 bash.exe」，只能靠 WIN-16 手工抓进程。
  - 三份输入里有任何一个是「读到明文但盘上本来就是明文」→ 同样记 ⛔，原因写「目标文件加密态未证实」。

**记录**

- `C:\t033\evidence\enc\enc-08-f3-inputs.md`
- 结果表一行（这里的 ✅/⛔ 表示「输入是否齐全、能不能进入判读」，不是表示选了哪个方案）

---

## 轮 E-b · TSD helper 的性能与噪声

### ENC-15 W5：正常路径下每条 bash 的 taskkill 耗时 【必】

**准备**

打开 Process Monitor（Sysinternals 的 `Procmon.exe`），设一个过滤器：

1. 菜单 `Filter` → `Filter…`
2. 条件选 `Process Name` / `is` / `taskkill.exe` / `Include`，点 Add、OK
3. 确认工具栏上的「Show Process and Thread Activity」（一排图标里的那个）是按下状态
4. 让它一直录着

没有 Process Monitor 就只做 trace 那一半，并在结果表里写明「Procmon 部分未做：机器上没有该工具」。

**操作**

1. 确认应用在跑（`Start-AiClient` 起的）。
2. 对模型说：

   `请用 bash 工具连续执行 20 条命令，每条一次调用，不要合并：echo t033-1 一直到 echo t033-20。每条都把输出贴出来。`

   模型可能一次只跑几条，没关系，接着说「继续」直到凑满 20 条。
3. 跑完后，从 trace 里算每一条工具调用的耗时：

```powershell
$rows = Get-Content C:\t033\trace\runs.jsonl | ForEach-Object { $_ | ConvertFrom-Json }
$out = foreach ($r in $rows) {
  $starts = @{}
  foreach ($s in $r.steps) {
    if ($s.type -ne 'tool') { continue }
    if ($s.detail.event -eq 'tool_execution_start') {
      $starts[[string]$s.detail.tool_call_id] = [datetime]$s.at
    }
    elseif ($s.detail.event -eq 'tool_execution_end') {
      $k = [string]$s.detail.tool_call_id
      if ($starts.ContainsKey($k)) {
        [pscustomobject]@{
          RunId = $r.run_id
          Tool  = $s.detail.tool
          Ms    = [math]::Round((([datetime]$s.at) - $starts[$k]).TotalMilliseconds, 0)
        }
      }
    }
  }
}
$out | Where-Object { $_.Tool -eq 'bash' } | Format-Table -AutoSize
$out | Where-Object { $_.Tool -eq 'bash' } | Measure-Object -Property Ms -Minimum -Maximum -Average
$out | Export-Csv 'C:\t033\evidence\enc\enc-15-tool-durations.csv' -NoTypeInformation -Encoding UTF8
```

4. 在 Procmon 里 `File` → `Save…` → 选 CSV，存成 `C:\t033\evidence\enc\enc-15-taskkill-latency.csv`。

**看什么**

判据（checklist ENC 组第 15 项，逐字）：**「从 runner 发出 IPC exit 到 `runPipe` resolve 的间隔持续超过 1000 毫秒，即说明 2000 毫秒预算不安全」**。

- **没有风险长这样**：20 条 `echo` 的耗时分布集中在几百毫秒以内，Procmon 里每个 `taskkill.exe` 从 Process Start 到 Process Exit 都很短（远小于 1 秒）。
- **有风险长这样**：多数条目的耗时**持续**超过 1000 毫秒（不是偶尔一条），或者 Procmon 里 `taskkill.exe` 的存活时间经常接近/超过 1 秒。

> **一个必须写进证据的诚实说明**：trace 里能拿到的是 `tool_execution_start` → `tool_execution_end` 的整段耗时，它**包含命令本身的执行时间**，不等于判据原文点名的「IPC exit → runPipe resolve」那一小段。打包态没有更细的时间戳。所以这一项要记**两个数**：整段耗时分布（上界）+ Procmon 里 `taskkill.exe` 的进程创建/退出耗时（判据点名的那一段的直接观测）。两个数都记下来，判读交给编排器。

**记录**

- `C:\t033\evidence\enc\enc-15-taskkill-latency.csv`（Procmon 导出）
- `C:\t033\evidence\enc\enc-15-tool-durations.csv`（trace 算出的耗时）
- 结果表一行

### ENC-24 tools-10：加密路径下大文件读的进程数与耗时 【绿】

**准备**

在受策略目录里造一个 ≥ 2 MiB 的文本文件：

```powershell
$line = ('T033-ENC24-' + ('x' * 100))
$sb = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt 20000; $i++) { [void]$sb.AppendLine($line) }
Set-Content -LiteralPath "$enc\enc24-big.txt" -Value $sb.ToString() -Encoding ASCII
(Get-Item "$enc\enc24-big.txt").Length     # 期望 > 2000000
```

Process Monitor 过滤器改成：`Process Name` / `is` / `node.exe` / `Include`，并确保「Show Process and Thread Activity」按下。开始录制。

**操作**

1. 对模型说：`请用 read 工具读取 D:\Encrypted\t033\enc24-big.txt 的全部内容，需要分页就一直读到读完，每次读完告诉我读到第几行。`
2. 读完后停止 Procmon 录制，`File` → `Save…` → CSV，存成 `enc-24-procmon-helper-count.csv`。在 Procmon 里数一下 `Process Start` 事件有几条（那就是 helper 子进程被创建的次数）。
3. 取这一次的耗时：

```powershell
Get-Content C:\t033\trace\runs.jsonl -Tail 1 | ConvertFrom-Json |
  Select-Object run_id, latency_ms |
  ConvertTo-Json | Out-File 'C:\t033\evidence\enc\enc-24-latency.json' -Encoding UTF8
```

**看什么**

判据（checklist ENC-24，逐字）：**「读一个 ≥ 2 MiB 的受策略文件，helper 子进程创建次数应是个位数、总耗时接近线性（改前是 32 KiB 固定分块导致 O(n²) 重读与上百次子进程）」**。

- **通过长这样**：Procmon 里新起的 `node.exe` 进程是个位数（0～9 个），耗时随读的字节数大致线性增长，没有出现读一个文件起几十上百个进程的情况。
- **不通过长这样**：Procmon 里几十上百个 `node.exe` Process Start 事件，或者耗时明显不成比例地长。

> **重要的背景**（写进证据里）：如果 **ENC-16 通过了**（随包 node 直接读到明文），那么 helper 这条路**根本不会被走到**，Procmon 里应该是 **0 个**新 `node.exe`。这时候「个位数」这个判据是被**平凡满足**的——请照实记 0，并写一句「直读路径，未进 helper」。这仍然是有价值的证据：直读路径是 64 KiB 一遍顺序读（源码 `src/runtime/host/io.ts:75, 156-166`），结构上就不可能出现原来那种 O(n²) 重读。

**记录**

- `C:\t033\evidence\enc\enc-24-procmon-helper-count.csv`
- `C:\t033\evidence\enc\enc-24-latency.json`
- 结果表一行（写清楚 helper 进程数到底是几）

### ENC-23 core-host-05：TSD helper 的 stderr 噪声不再挤掉输出预算 【探】

**先读这一段再决定做不做**（这一项在本次打包态很可能跑不起来，原因是结构性的）：

- Windows 打包态的 worker 载体**固定**是随包 `node.exe`（源码 `src/main/services/agent-host/PiWorkerProcess.ts:78-92` 是硬分支，没有开关），这个载体默认 `tsd_read_fallback = disabled`；
- helper（也就是判据里说的 "configured Node"）**只有在 worker 自己读到的是密文时**才会被调起；
- 而 ENC-16 通过恰恰说明 worker 读到的是明文。

也就是说：**ENC-16 通过 ⇒ helper 路径不会被触发 ⇒ 这一项没有可观测对象。** 仍然试一次，把「没触发」这个事实取证下来。

**操作**

1. `Stop-AiClient`
2. 打开 helper 回落开关再启动（这个环境变量的作用见源码 `src/runtime/host/worker.ts:48-52, 92`）：

```powershell
$env:AICLIENT_RUNTIME_TSD_FALLBACK = '1'
Start-AiClient
```

3. 对模型说：`请用 read 工具读取 D:\Encrypted\t033\enc24-big.txt 的前 200 行。`
4. 抓 trace：

```powershell
Get-Trace -Pattern 'io_tsd|tsd-read|exec' -Tail 30 | Save-Evidence -Group enc -Id 23 -Slug stderr-noise-trace
Get-Content C:\t033\trace\runs.jsonl -Tail 1 | ConvertFrom-Json |
  Select-Object -ExpandProperty version_stamp |
  Select-Object carrier, tsd_read_fallback, node_exec_path | Format-List
```

**看什么**

判据（checklist ENC-23，逐字）：**「一个 configured Node 会往 stderr 打噪声的场景下，受策略文件仍被判为可读、返回明文，不出现 `io_tsd_unreadable`」**。

- **有效数据长这样**：版本戳里 `tsd_read_fallback` 变成了 `configured-node`，并且 trace 里真的出现了 helper 的 exec 事件，read 返回明文、没有 `io_tsd_unreadable`。
- **跑不起来长这样（预期就是这个）**：版本戳变成了 `configured-node`，但 trace 里**完全没有 helper 的 exec 事件**——因为 worker 直读就拿到了明文。这时记 🚫，原因写「helper 路径未被触发：worker 直读即得明文（见 ENC-16）」。
- **另一种跑不起来**：环境变量设了但版本戳里 `tsd_read_fallback` 仍是 `disabled` → 说明变量没被 worker 继承，记 ⛔ 并把版本戳贴上。

**记录**

- `C:\t033\evidence\enc\enc-23-stderr-noise-trace.txt`
- `C:\t033\evidence\enc\enc-23-version-stamp.txt`
- 结果表一行

**恢复（做完立刻做，否则后面所有项都带着这个开关）**

```powershell
Stop-AiClient
Remove-Item Env:\AICLIENT_RUNTIME_TSD_FALLBACK -ErrorAction SilentlyContinue
Start-AiClient
Get-Content C:\t033\trace\runs.jsonl -Tail 1 | ConvertFrom-Json |
  Select-Object -ExpandProperty version_stamp | Select-Object tsd_read_fallback
```

最后那条要重新看到 `disabled` 才算恢复干净。

### ENC-22 E7：helper 端到端 【不做】

条件项。检查单原文写明「仅当 tsd-01 按『接通回落』修法推进时才需要跑」，当前没有推进该修法，编排器已裁决本轮不做。**结果表里直接记 🚫，不要花时间。**

---

## 轮 E-c · 写锁与会话恢复

> 这一轮要动会话文件。**动之前一定先 `Stop-AiClient`**，动完再起——应用在跑的时候改会话文件，会同时撞上写锁和 worker 的内存副本，结论就不可信了。
>
> 还有一条容易踩的：**会话文件是「懒写」的**。新建对话时给出的路径只是预留，**要等第一条模型回复落下来，磁盘上才真的出现那个 .jsonl 文件**。所以下面每一项都要先发一条消息、等模型回完，再去找文件。

会话文件在哪：

```powershell
$sessions = Join-Path $env:USERPROFILE '.pilab\jyw-ai-client\pi-agent\sessions'
Get-ChildItem -Path $sessions -Recurse -Filter '*.jsonl' |
  Sort-Object LastWriteTime | Select-Object -Last 5 FullName, Length, LastWriteTime
```

最后一行通常就是你刚才那个会话。

### ENC-14 加密目录下写锁的取 / 读 / 接管 【必】

**准备**

在 `$enc` 工作区开一个新对话，发一条消息，等模型回完（这样文件和锁才真的存在）。然后记下会话文件路径：

```powershell
$jsonl = (Get-ChildItem -Path $sessions -Recurse -Filter '*.jsonl' |
          Sort-Object LastWriteTime | Select-Object -Last 1).FullName
$jsonl
$lock = "$jsonl.writer.lock"
Test-Path $lock      # 会话还开着的话应该是 True
```

**操作**

1. **① 锁是不是 TSD 容器**——会话还开着的时候读锁的前 16 字节：

```powershell
Get-Head16 -Path $lock | Save-Evidence -Group enc -Id 14 -Slug lock-header
Get-Head16 -Path $lock
```

2. **② 正常打开耗时**——在侧栏点另一个会话再点回这个会话，用秒表记「点下去 → 时间线出内容」的秒数，做三次取最大值。

3. **③ 陈旧接管**：

```powershell
Stop-AiClient
Copy-Item -LiteralPath $lock -Destination "$lock.bak" -Force -ErrorAction SilentlyContinue

# 找一个确实不存在的 pid
$deadPid = 65535
Get-Process -Id $deadPid -ErrorAction SilentlyContinue      # 期望没有任何输出

$stale = [ordered]@{
  pid        = $deadPid
  host       = $env:COMPUTERNAME
  token      = [guid]::NewGuid().ToString()
  acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  startedAt  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
$json = ($stale | ConvertTo-Json -Compress)
[IO.File]::WriteAllText($lock, $json, (New-Object Text.UTF8Encoding($false)))
Get-Content -LiteralPath $lock
```

4. `Start-AiClient`，点开这个会话，**用秒表记从点下去到时间线出内容的秒数**。

**看什么**

判据（checklist ENC 组第 14 项，逐字）：**「`.writer.lock` 在盘上是不是 TSD 容器；正常打开会话的耗时；人为留一把 pid 不存在的陈旧锁后接管是否在 60 秒 bootstrap 预算内完成」**。

- **通过长这样**：三个数都拿到了，并且第 ③ 步的接管在 **60 秒以内**完成、会话正常打开。
- **不通过长这样**：接管超过 60 秒；或者会话打不开、报 `session_locked`。
- **看到 `session_locked` 时先别当缺陷**：先确认是不是真有活进程占着（`Get-AiClientTree`、`Get-Process -Id <锁里的 pid>`）。我们手写的锁 pid 是不存在的，所以这里报 `session_locked` 才是真的不通过。
- **额外要记的一句**：如果第 ① 步显示锁**是** TSD 容器（`IsTsdMagic = True`），写进证据——一次陈旧接管要读两次锁，锁是容器就会让接管时间显著变长，这决定了并发相关缺陷的现场严重度。

**记录**

- `C:\t033\evidence\enc\enc-14-lock-header.txt`
- `C:\t033\evidence\enc\enc-14-takeover-timing.txt`（三个数：锁是不是容器 / 正常打开秒数 / 陈旧接管秒数）
- 结果表一行

**恢复**

```powershell
Stop-AiClient
Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
if (Test-Path "$lock.bak") { Remove-Item "$lock.bak" -Force }
Start-AiClient
```

（把手写的锁删掉即可；应用下次打开该会话会自己重新取锁。）

### ENC-5 加密机上的 TUI-1 闸门 【必】

**准备**

要一个「v4 但不是 interop 格式」的会话文件。做法是拿一个**你不在乎的**会话，把它的第一行换成缺少 `"type":"session"` 的头（判定逻辑见源码 `src/main/services/terminal/piTuiSession.ts:296-309`）。

```powershell
Stop-AiClient

# 挑一个会话（建议专门新建一个、发一条消息、就用它）
$victim = (Get-ChildItem -Path $sessions -Recurse -Filter '*.jsonl' |
           Sort-Object LastWriteTime | Select-Object -Last 1).FullName
$victim
Copy-Item -LiteralPath $victim -Destination "$victim.bak" -Force

$lines = [IO.File]::ReadAllLines($victim)
$first = $lines[0] | ConvertFrom-Json
$hdr = [ordered]@{
  kind      = 'header'
  version   = 4
  id        = $first.id
  createdAt = $first.createdAt
  cwd       = $first.cwd
}
$lines[0] = ($hdr | ConvertTo-Json -Compress)
[IO.File]::WriteAllLines($victim, $lines, (New-Object Text.UTF8Encoding($false)))
[IO.File]::ReadAllLines($victim)[0]
```

最后一行打印出来的第一行里**不能**有 `"type":"session"`，有就说明没改成功。

> 用 `[IO.File]::WriteAllLines` 而不是 `Set-Content`：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会在文件开头加 BOM，那会让第一行解析失败，这一项就变成在验别的东西了。

**操作**

1. `Start-AiClient`
2. 在侧栏点开这个会话
3. 点右上角的 **GUI / TUI 分段开关**，切到 TUI
4. 立刻截图，**把屏上出现的文字一字不改地抄下来**

**看什么**

判据（checklist ENC 组第 5 项，逐字）：**「旧 v4 会话在加密机上点 TUI：是被我们的提示拦住，还是直接进终端撞 CLI 原文报错」**——这一项要的是**记录实际形态**，两种形态都算取到证。

- **形态一（被我们拦住）**：出现一条应用自己的提示，英文原文是 `This chat was saved in an older native format. Open it in the app once to upgrade it, then the Pi terminal can open it.`；中文界面下可能是它的译文。把**你实际看到的那一句**抄下来。
- **形态二（没拦住）**：直接进了终端，然后 pi CLI 自己报错。把 pi 报的**原文**抄下来。
- **两种都不是**：例如什么也没发生、开关弹回去、应用卡住——这才是 ⛔，把现象写清楚。

**记录**

- `C:\t033\evidence\enc\enc-05-tui1-gate.png`
- `C:\t033\evidence\enc\enc-05-tui1-text.txt`（屏上文字的逐字抄录）
- 结果表一行

**恢复**

```powershell
Stop-AiClient
Move-Item -LiteralPath "$victim.bak" -Destination $victim -Force
[IO.File]::ReadAllLines($victim)[0]    # 第一行应重新带上 "type":"session"
Start-AiClient
```

### ENC-6 会话文件中段坏行自愈 【绿】

**准备**

```powershell
Stop-AiClient
$target = (Get-ChildItem -Path $sessions -Recurse -Filter '*.jsonl' |
           Sort-Object LastWriteTime | Select-Object -Last 1).FullName
$target
Copy-Item -LiteralPath $target -Destination "$target.bak" -Force

$lines = [IO.File]::ReadAllLines($target)
"改动前行数：$($lines.Count)"
$mid = [int]($lines.Count / 2)
$new = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($i -eq $mid) { [void]$new.Add('{"broken": this is not json') }
  [void]$new.Add($lines[$i])
}
[IO.File]::WriteAllLines($target, [string[]]$new.ToArray(), (New-Object Text.UTF8Encoding($false)))
"改动后行数：$($new.Count)（其中 1 行是坏行，插在第 $mid 行）"
```

把这两行数字记到证据里。

**操作**

1. `Start-AiClient`
2. 点开这个会话
3. **发一条消息**（必须发——自愈记录只在真的跑一个回合时才会进 trace）
4. 数一下时间线上有多少条对话条目
5. 再看文件：

```powershell
$after = [IO.File]::ReadAllLines($target)
"自愈后行数：$($after.Count)"
$after | Select-String -Pattern 'broken' -SimpleMatch    # 期望没有输出
Get-Trace -Pattern 'session_recovered' -Tail 3 | Save-Evidence -Group enc -Id 6 -Slug recovery-trace
```

**看什么**

判据（checklist ENC 组第 6 项，逐字）：**「中段坏行被跳过并原子重写后，会话树节点数 = 文件里存活条目数，历史时间线不缺条目，`session.status` 带 recovery rider」**。

- **通过长这样**：坏行没了（`Select-String 'broken'` 无输出），文件行数回到改动前的数量（再加上你新发的那一轮），时间线上原来的条目一条不少，并且 trace 里有一行 `"event":"session_recovered"`，里面的 `skipped_lines` 指着你插坏行的那个位置。
- **不通过长这样**：时间线缺条目（坏行之后的内容没了）；或者文件里坏行还在；或者 trace 里找不到 `session_recovered`；或者会话直接打不开。
- 「会话树节点数」如果界面上没有树视图，就用**时间线上的条目数**代替，并在证据里写明你数的是时间线。

**记录**

- `C:\t033\evidence\enc\enc-06-midfile-corruption.txt`（三个行数 + 时间线条目数）
- `C:\t033\evidence\enc\enc-06-recovery-trace.txt`
- 结果表一行

**恢复**

```powershell
Stop-AiClient
Move-Item -LiteralPath "$target.bak" -Destination $target -Force
Start-AiClient
```

---

## 轮 E-d · 导入链在加密机上的闭环

### ENC-3 Codex 源在加密机上是否受 TSD 策略覆盖 【必】

**准备**

先看这台机器上有没有 Codex 的会话文件：

```powershell
$codexHome = $env:CODEX_HOME
if (-not $codexHome) { $codexHome = Join-Path $env:USERPROFILE '.codex' }
"CODEX_HOME = $codexHome"
$rollouts = @(Get-ChildItem -Path (Join-Path $codexHome 'sessions') -Recurse -Filter 'rollout-*.jsonl' -ErrorAction SilentlyContinue)
"找到 $($rollouts.Count) 个 rollout"
$rollouts | Select-Object -First 5 FullName, Length, LastWriteTime
```

一个都没有就记 🚫，原因写「这台机器上没有 Codex 会话文件」，并把上面这段输出存成证据。

**操作**

1. **用两个身份各读一次同一个文件的头**（这就是判据里说的 `isFileTsdEncrypted`——它做的事就是比对前 16 字节是不是 `%TSD-Header-###%`，源码 `src/main/utils/tsdSafeRead.ts:13-25`）：

```powershell
$one = $rollouts[0].FullName
'=== PowerShell（非白名单进程）看到的 ==='
Get-Head16 -Path $one

'=== 随包 node.exe（白名单载体）看到的 ==='
& "$app\resources\node-runtime\node.exe" -e "const fs=require('fs');const f=process.argv[1];const b=Buffer.alloc(16);const fd=fs.openSync(f,'r');fs.readSync(fd,b,0,16,0);fs.closeSync(fd);console.log(JSON.stringify(b.toString('latin1')));" "$one"
```

把两段输出都存进 `enc-03-codex-tsd-probe.txt`。

2. 起应用，打开**导入面板**（导入旧对话的入口），看 Codex 那一栏，截图。

**看什么**

判据（checklist ENC 组第 3 项，逐字）：**「`~/.codex/sessions/**/*.jsonl` 的首部是否带 TSD 头；若带，导入面板里 Codex 项目应为空或全部会话被跳过」**。

- **一致长这样（两种，都是 ✅）**：
  - 文件头**不带** TSD 头（明文）+ 导入面板里 Codex 项目正常列出会话；
  - 文件头**带** TSD 头 + 导入面板里 Codex 项目为空或全部会话被跳过。
- **不一致长这样（⛔）**：文件头**带** TSD 头，但导入面板照样列出了会话——那就要看点进去会发生什么（大概率是解析失败），把点进去的表现也截一张。

**记录**

- `C:\t033\evidence\enc\enc-03-codex-tsd-probe.txt`
- `C:\t033\evidence\enc\enc-03-import-panel.png`
- 结果表一行

### ENC-4 Claude 导入在加密机上的完整闭环 【必】

**准备**

看这台机器上有没有 Claude 的会话：

```powershell
$claudeDir = $env:CLAUDE_CONFIG_DIR
if (-not $claudeDir) { $claudeDir = Join-Path $env:USERPROFILE '.claude' }
"CLAUDE_CONFIG_DIR = $claudeDir"
@(Get-ChildItem -Path (Join-Path $claudeDir 'projects') -Recurse -Filter '*.jsonl' -ErrorAction SilentlyContinue) |
  Select-Object -First 5 FullName, Length, LastWriteTime
```

一条都没有就记 🚫 并存下这段输出。**不要用合成文件冒充**——这一项验的就是真实数据。

**操作**

1. 起应用，打开导入面板，找到 Claude 那一栏，截图（要能看到会话被列出来）。
2. 挑一条导入。
3. 导入完成后打开这个会话，**发一条消息续聊**，等模型回完。
4. 找出产物路径与索引行：

```powershell
Get-ChildItem -Path $sessions -Recurse -Filter '*.jsonl' |
  Sort-Object LastWriteTime | Select-Object -Last 3 FullName, Length, LastWriteTime |
  Save-Evidence -Group enc -Id 4 -Slug artifact-path

$index = Join-Path $env:APPDATA 'jyw-ai-client\session-index.json'
(Get-Content $index -Raw) | Out-File 'C:\t033\evidence\enc\enc-04-session-index.json' -Encoding UTF8
```

**看什么**

判据（checklist ENC 组第 4 项，逐字）：**「一条真实 `~/.claude` 会话能被列出、能导入、导入后能打开并续聊」**，取证要求「记录 `sessions/` 下产物路径与会话索引行」。

- **通过长这样**：四步都成——列出来了、导进来了、打得开、续聊模型正常回话；并且 `sessions/` 下能看到新增的 `.jsonl`，`session-index.json` 里有对应的一行。
- **不通过长这样**：列不出来（面板里 Claude 是空的但磁盘上有文件）、导入报错、导入后打开是空白、或续聊时报错。哪一步断了就写哪一步，附上错误原文。

**记录**

- `C:\t033\evidence\enc\enc-04-claude-import.png`
- `C:\t033\evidence\enc\enc-04-artifact-path.txt`
- `C:\t033\evidence\enc\enc-04-session-index.json`
- 结果表一行

---

## 轮 E-e · 加密域下的 GUI 一致性与既有回归

### ENC-9 F4 重试在加密机复测 【必】

**准备**

这一项**不用起应用、不用真实网关**（探针自带一个假网关），但需要**源码**和 Node 24：

1. 仓库拉到 `13e6cdb7`（本次 Build 的源码），假设放在 `C:\t033\src\ai-client`；
2. `src/runtime` 是**独立的 npm 子包**，依赖不随根目录安装，必须单独装（**需要能访问 npm 源；机器不能联网就整项记 🚫**）：

```powershell
cd C:\t033\src\ai-client\src\runtime
npm ci
```

装不上会报 `Cannot find package 'cordis'`，那就是没装成。

**操作**

```powershell
cd C:\t033\src\ai-client
& "$app\resources\node-runtime\node.exe" scripts\run-f4-retry-probe.mjs |
  Tee-Object -FilePath 'C:\t033\evidence\enc\enc-09-f4-retry-report.json'
$LASTEXITCODE
```

探针会把同一份报告也写到仓库里的 `docs/plantree/plans/runtime-evolution/evidence/p4-6/f4-retry/f4-retry-report.json`，两份内容一样，交回哪一份都行。

**看什么**

判据（checklist ENC 组第 9 项，逐字）：**「503×2 后成功、持续 503 四次尝试共 43 秒耗尽、429 听 `Retry-After`、退避中取消立即结束」**，取证要求「trace 的 `provider_retry` 与假网关实到请求数两侧都看」。

- **通过长这样**：报告 JSON 里 `verdict.pass` 是 `true`，四条路各自的断言都成立，退出码是 0。四条路分别是：
  1. 503 两次后成功（trace 里两条 `provider_retry`，等 3 秒、10 秒）
  2. 一直 503 → 预算耗尽失败前确实试满 4 次（总共约 43 秒）
  3. 429 带 `Retry-After` → 按服务端给的秒数等
  4. 退避途中取消 → 立刻结束为 aborted，不把梯子走完
- **不通过长这样**：`verdict.pass` 是 `false`，报告里 `failures` 数组会写明哪一条不成立；把整份 JSON 交回即可，不用自己解读。

**记录**

- `C:\t033\evidence\enc\enc-09-f4-retry-report.json`
- 结果表一行（写明 `verdict.pass` 的值）

### ENC-1 utility 冷启动耗时 【必】

**准备**

「生成提交信息」这个功能要有未提交的改动才有意义。用 `$enc` 那个 git 仓库：

```powershell
cd $enc
Set-Content -LiteralPath "$enc\enc01-change.txt" -Value 'T033-ENC01 change one' -Encoding ASCII
git add -A
git status --short
```

准备一个秒表（手机就行）。

**操作**

以下三遍，每遍都从「应用完全关掉」开始，这样才算**冷启动**：

1. `Stop-AiClient`，确认输出里 `AiClientLeft = 0` 且 `BundledNodeLeft = 0`
2. `Start-AiClient`
3. 打开 `$enc` 工作区，进 Git 面板
4. 点「生成提交信息」，**同时按下秒表**
5. 面板里出现生成结果的那一刻停表，记秒数
6. 回到第 1 步，再来两遍

**看什么**

判据（checklist ENC 组第 1 项，逐字）：**「从 `utility.start` 发出到收到 ack 的耗时；判 10 秒预算是否足够（连续三次冷启动的最大值 < 10s 才算通过）」**。

- **通过长这样**：三次秒表数的**最大值小于 10 秒**，并且三次都没有出现超时/失败提示。
- **不通过长这样**：任意一次超过 10 秒；或者出现超时、失败一类的提示（把文案原文抄下来，可能形如 `PI_UTILITY_TIMEOUT` 或中文的「生成失败」）。

> **一个必须写进证据的诚实说明**：打包态没有把「`utility.start` 发出 → 收到 ack」这一段单独打日志，所以你用秒表量到的是「点击 → 出结果」，它**包含了模型生成的时间**，是判据那一段的**上界**。两件事可以据此判：① 秒表数本身就是上界，上界小于 10 秒则那一段一定小于 10 秒；② 那次请求的超时阈值正好就是 10 秒（源码 `src/main/services/agent-host/WorkerSlot.ts:92`），所以**没有出现超时提示**本身就说明 ack 没超 10 秒。把三个秒表数和「有没有超时提示」都记下来，判读交给编排器。

**记录**

- `C:\t033\evidence\enc\enc-01-utility-coldstart.txt`（三次秒表数 + 有没有超时提示 + 上面那段说明）
- 结果表一行

**恢复**

```powershell
cd $enc
git reset
Remove-Item "$enc\enc01-change.txt" -Force -ErrorAction SilentlyContinue
```

### ENC-11 加密域 GUI 读 / Edit 后一致性 【绿】

**准备**

用 `tracked.txt`（ENC-18 之后内容应是 `T033-ENC-CANARY-B`）。

**操作**

1. **GUI**：对模型说 `请用 read 工具读取 D:\Encrypted\t033\tracked.txt，把内容原样贴出来。`，把输出抄下来。
2. **内嵌终端**：在应用里打开终端标签，执行 `type D:\Encrypted\t033\tracked.txt`，把输出抄下来。
3. **外部编辑器**：用记事本打开同一个文件（`notepad D:\Encrypted\t033\tracked.txt`），把看到的内容抄下来。
4. 再让模型 `edit` 一次（把 `B` 改成 `C`），三处**各重新读一次**，再抄一轮。

**看什么**

判据（checklist ENC 组第 11 项，逐字）：**「受策略目录里 Read 得明文、Edit/Write 后 GUI·TUI·外部编辑器三者内容一致」**。

- **通过长这样**：edit 前三处内容一致，edit 后三处内容也一致（都是改后的值）。
- **不通过长这样**：三处有任意一处不一样——例如记事本看到的是乱码/旧内容，或终端读到的是密文。把不一致的那一处的原文抄下来。

**记录**

- `C:\t033\evidence\enc\enc-11-three-readers.txt`（六段内容：edit 前三处 + edit 后三处）
- 结果表一行

### ENC-12 特定编码与真实二进制样本 【绿】

**准备**

用第 0.4 步生成的样本。把 8 个文件拷进 `$enc` 工作区并提交：

```powershell
Copy-Item 'C:\t033\field-samples\enc12\*' $enc -Force
cd $enc
git add -A
git commit -m "t033 enc12 samples"
```

**操作**

1. 制造改动——三个文本样本各用自己的 `.v2` 覆盖，二进制样本各改一个字节：

```powershell
Copy-Item "$enc\enc12-gbk.v2.txt"           "$enc\enc12-gbk.txt" -Force
Copy-Item "$enc\enc12-utf16le-bom.v2.txt"   "$enc\enc12-utf16le-bom.txt" -Force
Copy-Item "$enc\enc12-utf8-bom.v2.txt"      "$enc\enc12-utf8-bom.txt" -Force
Add-Content -LiteralPath "$enc\enc12-random-1kib.bin" -Value ([byte]0x41) -Encoding Byte
$png = [IO.File]::ReadAllBytes("$enc\enc12-tiny.png"); $png[$png.Length-1] = $png[$png.Length-1] -bxor 1
[IO.File]::WriteAllBytes("$enc\enc12-tiny.png", $png)
git status --short
```

2. 在应用的 **Git 面板**里逐个打开这五个改动过的文件看 diff，各截一张图。
3. 在**编辑器**里逐个打开这五个文件看正文，各截一张图（或五个合成一张也行，能看清就行）。
4. 逐样本填一行结论。

**看什么**

判据（checklist ENC 组第 12 项，逐字）：**「GBK/UTF-16/带 BOM 各一份、真实二进制一份，Main diff 与编码判定逐样本记通过或失败」**。

逐样本的期望与判负形态（来自样本包 README 第 2.3 节）：

| 样本 | diff 期望 | 编码判定期望 | 判负的形态 |
|---|---|---|---|
| `enc12-gbk.txt` | 只显示**第四行**一处改动 | 中文正确显示 | 整文件标为「全改」、中文乱码、或直接当二进制 |
| `enc12-utf16le-bom.txt` | 只显示第四行 | 中文正确显示，CRLF 不被当成改动 | 被当二进制拒绝 diff（**这一条最可能中**，记下原文）、或每个字符之间插空 |
| `enc12-utf8-bom.txt` | 只显示第四行 | 中文正确显示 | 第一行被判为「整行变了」= BOM 没剥 |
| `enc12-tiny.png` | 标为二进制，**不显示逐行 diff**；有图片预览就看能不能渲染 | 不应尝试文本解码 | 显示成乱码文本、或报解析错误 |
| `enc12-random-1kib.bin` | 标为二进制，不显示逐行 diff | 同上 | 同上 |

> **一个先看的岔路**：如果**五份的 diff 全是空的**，先怀疑 F3（GUI 里 Git 输出丢失），而不是编码判定——两者的现场症状长得很像。这种情况下先去看 ENC-8 的结论，并在证据里写明「五份全空，疑似 F3 而非编码」。

**记录**

- `C:\t033\evidence\enc\enc-12-gbk-diff.png`、`enc-12-utf16le-diff.png`、`enc-12-utf8bom-diff.png`、`enc-12-png-diff.png`、`enc-12-bin-diff.png`
- `C:\t033\evidence\enc\enc-12-verdicts.md`（五行，每行：`<文件> | Git 面板 diff <通过/失败/形态> | 编辑器编码判定 <通过/失败/形态>`）
- 结果表一行（写「5 份里 N 份通过」）

**恢复**

```powershell
cd $enc
git checkout -- .
```

### ENC-10 GUI A/4 临时目录三条路在加密机的回归 【绿】

**准备**

先认识两个路径：

```powershell
$scratch = Join-Path $env:USERPROFILE 'JYWAI\temporary\unbound-sessions'
$index   = Join-Path $env:APPDATA 'jyw-ai-client\session-index.json'
$scratch; $index
```

> **一个会吓到人但属正常的行为**：临时工作区的**整个根目录**在应用启动和退出时都会被清空（源码 `src/main/ipc/workerManager.ts:11, 20-22`）。所以「重启后 scratch 目录没了」不是缺陷，是设计。这一项要记的就是这三个时点分别长什么样。

**操作**

三条路各做一遍，每条路都在**三个时点**各取一次快照（这就是「F2-b 三时点法」：不能凭界面上消失就推断文件被删，每个时点都直接读磁盘）。

三条路：

- **① 创建**：新建一个不选文件夹的临时对话，发一条消息（这一下会给它分配 scratch 目录）
- **② 复用**：在这个临时会话里点「新建对话」（`/new`），看新会话是不是**继承同一个** scratch 目录
- **③ 绑定**：把临时会话绑定到一个真实目录（在会话里改工作区）

三个时点：

- **时点 A（操作前）**、**时点 B（操作后、不重启）**、**时点 C（重启应用后）**

每个时点跑这一段（`-Tag` 换成 `a1`/`b1`/`c1`、`a2`/`b2`/`c2`、`a3`/`b3`/`c3`）：

```powershell
Snap-Baseline -Tag a1 -PolicyDir $enc
Get-ChildItem -Path $scratch -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime
```

**看什么**

判据（checklist ENC 组第 10 项，逐字）：**「临时目录复用/创建/绑定三条路在受策略目录下与开发机结果一致」**。

- 「与开发机一致」这句你没法自己判——**开发机那份记录不在你手上**。所以这一项你要做的是：**把三条路 × 三个时点共 9 份快照如实取下来**，让编排器去比。
- **有价值的观察（看到了就单独写一句）**：② 复用那一条，新会话的 scratch 目录**是不是同一个**；③ 绑定之后，原来的 scratch 目录还在不在；重启之后 scratch 根是不是被整根清空了。
- **明显不通过长这样**：临时对话根本建不出来、发消息报 `workspace_missing`、或者 scratch 目录建在了一个完全意外的位置。

**记录**

- `C:\t033\evidence\enc\enc-10-a4-three-paths.txt`（三条路 × 三个时点的观察，一行一条）
- 9 份 `Snap-Baseline` 产物（自动落在 `evidence\baseline\`）
- 结果表一行

### ENC-13 H/17 + H/19 在加密机上的联合回归 【绿】

**准备**

先取一份「动之前」的目录快照，后面要比对增减：

```powershell
Snap-Baseline -Tag h17h19-before -PolicyDir $enc
```

**操作**

四件事，各截一张图：

1. **本地模式首次进入**：设置 → AI 服务（或「模型」）页，切到本地模式，截图第一次进入的界面。
2. **加服务**：添加一个自定义服务（用你自己的 provider，**不要在证据里写密钥**），保存后看模型选择器**能不能拉到模型列表**，截图。
3. **统一目录迁移**：如果应用弹出过目录迁移的提示，走完并截图；**没弹就记「未触发」**，这也是有效记录。
4. **插件安装 / 卸载**：插件设置页里装一个插件、再卸载，各截一张图。

做完再取一份快照并比对：

```powershell
Snap-Baseline -Tag h17h19-after -PolicyDir $enc
```

**看什么**

判据（checklist ENC 组第 13 项，逐字）：**「本地模式首次进入、加服务、统一目录迁移、插件安装卸载，全链路在加密文件系统与 Windows 上各跑一遍」**，判据句是「H/17 + H/19 全链路可用」。

- **通过长这样**：四件事都能走完，没有报错；加完服务能拉到模型列表；装/卸插件之后，状态根目录（`%USERPROFILE%\.pilab\jyw-ai-client\pi-agent`）下的文件确实有对应的增减（对比 before/after 两份快照）。
- **不通过长这样**：任意一步报错、卡住、或者目录没有对应变化（装了插件但目录没变 = 实际上没装成）。哪一步断了写哪一步。

**记录**

- `C:\t033\evidence\enc\enc-13-h17-local-mode.png`、`enc-13-h17-add-service.png`、`enc-13-h19-plugin-install.png`、`enc-13-h19-plugin-remove.png`
- `C:\t033\evidence\enc\enc-13-dir-diff.txt`（before/after 两份快照里 `pi-agent` 目录的差异，人工写几行即可）
- 结果表一行

### ENC-2 加密机上 userData 的位置 【绿】

**准备**

应用保持在跑。

**操作**

```powershell
$ud = Join-Path $env:APPDATA 'jyw-ai-client'
"userData = $ud"
Test-Path $ud
Get-ChildItem $ud | Select-Object Name, Length, LastWriteTime

'=== session-index.json ==='
$idx = Join-Path $ud 'session-index.json'
Test-Path $idx
Get-Head16 -Path $idx

'=== 在 userData 下做一次普通读写 ==='
$probe = Join-Path $ud 't033-rw-probe.txt'
Set-Content -LiteralPath $probe -Value 'T033-USERDATA-RW' -Encoding ASCII
Get-Content -LiteralPath $probe
Get-Head16 -Path $probe
Remove-Item -LiteralPath $probe -Force
```

把整段输出存成 `enc-02-userdata-location.txt`，再**手工加一句**：这个路径**在不在**你第 0.3 步记下的受策略目录范围内。

> 为什么是 `%APPDATA%\jyw-ai-client` 而不是带 `-dev` 的：`-dev` 后缀只在开发模式下加（源码 `src/main/index.ts:148-153`），打包态没有。想确认这个目录真的是应用在用的那个，就看 `session-index.json` 的 `LastWriteTime` 会不会随着你归档/重命名一个会话而变。

**看什么**

判据（checklist ENC 组第 2 项，逐字）：**「`session-index.json` 是否落在受策略目录内；是否受 TSD 读写约束」**。

- **要记的两件事**（这一项主要是取事实，不是通过/不通过）：
  1. `userData` 的绝对路径，以及它**在不在**受策略目录内；
  2. 在这个目录里普通读写正不正常（写进去能不能原样读回来），以及 `session-index.json` 的头 16 字节是不是 TSD 容器（`IsTsdMagic`）。
- **需要记 ⛔ 的情况**：在 `userData` 下写文件失败、或者写进去读回来是乱码——那说明索引文件本身处在受 TSD 约束的路径上，是个真问题。

**记录**

- `C:\t033\evidence\enc\enc-02-userdata-location.txt`
- 结果表一行

---

## 结果表（填完连同证据 zip 一起交回）

| 编号 | 结果 | 一句现象 | 证据文件 |
|---|---|---|---|
| ENC-16 |  |  |  |
| ENC-17 |  |  |  |
| ENC-18 |  |  |  |
| ENC-20 |  |  |  |
| ENC-7 |  |  |  |
| ENC-21 |  |  |  |
| ENC-19 |  |  |  |
| ENC-8 |  |  |  |
| ENC-15 |  |  |  |
| ENC-24 |  |  |  |
| ENC-23 |  |  |  |
| ENC-22 | 🚫 | 条件项：仅当 tsd-01 按「接通回落」修法推进时才跑，当前未推进，编排器已裁决本轮不做 | — |
| ENC-14 |  |  |  |
| ENC-5 |  |  |  |
| ENC-6 |  |  |  |
| ENC-3 |  |  |  |
| ENC-4 |  |  |  |
| ENC-9 |  |  |  |
| ENC-1 |  |  |  |
| ENC-11 |  |  |  |
| ENC-12 |  |  |  |
| ENC-10 |  |  |  |
| ENC-13 |  |  |  |
| ENC-2 |  |  |  |

**另外三句**（做完写在表下面）：

1. 本组做了 __ 项，砍了 __ 项，砍的原因：
2. 有没有哪一项做到一半做不下去（比 ⛔ 更严重，说明清单漏了前提）：
3. 有没有「不对劲但判据没问」的现象：
