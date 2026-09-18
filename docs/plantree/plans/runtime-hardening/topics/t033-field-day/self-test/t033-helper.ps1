<#
    t033-helper.ps1 - T033 上机日自测辅助函数

    适用：Windows PowerShell 5.1（就是「开始菜单里那个蓝色的 PowerShell」），
          不需要 PowerShell 7。全部函数只读机器状态或往 C:\t033 下写文件。

    怎么用
    ------
    1. 把本文件放到 C:\t033\t033-helper.ps1
    2. 打开 PowerShell（普通权限即可，需要管理员的地方会在自测清单里写明）
    3. 载入（注意开头那个点和空格，这是 PowerShell 的「载入到当前窗口」写法）：

           . C:\t033\t033-helper.ps1

    4. 第一次载入后，先把安装目录填对（默认是 NSIS 的默认安装位置，装的时候
       改过目录就要改这里）：

           $T033App = 'D:\SomeWhere\AiClient'

    5. 之后每次新开 PowerShell 窗口都要重新载入一次，变量不会跨窗口保留。

    函数一览
    --------
    Start-AiClient    带 trace 环境变量启动应用（自测约定：每次启动都必须走它）
    Stop-AiClient     先请应用自己关，等 5 秒，再报告有没有残留进程
    Snap-Baseline     基线快照：进程列表 + 三个目录清单 + 会话索引副本
    Get-Trace         在 runs.jsonl 与轮转文件里找行（自动跳过 runs.rotate.lock）
    Get-Head16        读文件头 16 字节，输出十六进制与 ASCII，并判 TSD 容器头
    Get-AiClientTree  AiClient 及其全部子孙进程，列 Name / PID / PPID / CommandLine
    Save-Evidence     按证据命名规矩把文本写进 C:\t033\evidence\<组>\
    Show-Chain        往上打印某个进程的父进程链（WIN 组用）
    Show-Tree         往下打印某个进程的子孙进程树（WIN 组用）
    Get-BashCandidates  按源码候选顺序列出 worker 会去找的每一个 bash.exe（WIN-16/17 用）

    每个函数都支持 Get-Help，例如： Get-Help Get-Head16 -Full
#>

# ---------------------------------------------------------------------------
# 可改的四个变量（改完不用重新载入，直接生效）
# ---------------------------------------------------------------------------

# 安装目录（目录，不是 exe）。NSIS 默认装在 %LOCALAPPDATA%\Programs\AiClient
$T033App = Join-Path $env:LOCALAPPDATA 'Programs\AiClient'

# 证据根与 trace 目录
$T033Evidence = 'C:\t033\evidence'
$T033TraceDir = 'C:\t033\trace'

# 打包态的两个数据目录（源码：src/main/index.ts:148-153 只在 dev 模式加 -dev 后缀；
# src/main/services/appStatePaths.ts:41-43 的状态根 = ~/.pilab/<userData 目录名>）
$T033UserData  = Join-Path $env:APPDATA 'jyw-ai-client'
$T033StateRoot = Join-Path $env:USERPROFILE '.pilab\jyw-ai-client'

# TSD 容器头与块大小（源码：src/runtime/host/io.ts:29,41-44）
$T033TsdMagic  = '%TSD-Header-###%'
$T033TsdBlock  = 4096

# ---------------------------------------------------------------------------

function Start-AiClient {
<#
.SYNOPSIS
    带 AICLIENT_RUNTIME_TRACE_DIR 启动 AiClient。

.DESCRIPTION
    不设这个环境变量，runtime 的 trace 只留在内存里、不落盘，凡是判据写「抓 trace
    的某某行」的项都会取不到证。自测约定：每次启动应用都走这个函数。

.PARAMETER App
    安装目录（不是 exe 路径）。默认取 $T033App。

.PARAMETER TraceDir
    trace 落盘目录。默认取 $T033TraceDir。

.PARAMETER ArgumentList
    额外命令行参数，例如 @('--remote-debugging-port=9222')。

.EXAMPLE
    Start-AiClient

.EXAMPLE
    Start-AiClient -App 'D:\AiClient-old-c0ae2a34'
#>
    [CmdletBinding()]
    param(
        [string]$App = $T033App,
        [string]$TraceDir = $T033TraceDir,
        [string[]]$ArgumentList = @()
    )

    $exe = Join-Path $App 'AiClient.exe'
    if (-not (Test-Path -LiteralPath $exe)) {
        throw "找不到 AiClient.exe：$exe（安装目录填对了吗？改 `$T033App）"
    }
    if (-not (Test-Path -LiteralPath $TraceDir)) {
        New-Item -ItemType Directory -Path $TraceDir -Force | Out-Null
    }

    $running = @(Get-Process -Name 'AiClient' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Write-Warning "已经有 $($running.Count) 个 AiClient 进程在跑。安装版与 portable 共用同一份数据且有单实例锁，不能同时开两个——先 Stop-AiClient。"
    }

    $env:AICLIENT_RUNTIME_TRACE_DIR = $TraceDir
    Write-Host "AICLIENT_RUNTIME_TRACE_DIR = $TraceDir" -ForegroundColor Green
    Write-Host "启动：$exe" -ForegroundColor Green

    if ($ArgumentList.Count -gt 0) {
        Start-Process -FilePath $exe -ArgumentList $ArgumentList
    }
    else {
        Start-Process -FilePath $exe
    }

    Start-Sleep -Seconds 3
    $now = @(Get-Process -Name 'AiClient' -ErrorAction SilentlyContinue)
    Write-Host "3 秒后 AiClient 进程数：$($now.Count)"
}

function Stop-AiClient {
<#
.SYNOPSIS
    请应用自己关闭，等 5 秒，再报告残留。

.DESCRIPTION
    先对每个 AiClient 主窗口发关闭请求（等价于点右上角的叉），等 -WaitSeconds 秒，
    然后报告：还剩几个 AiClient 进程、还剩几个从随包 node-runtime 起的 node.exe。
    本函数不强杀。要强杀是另一回事，自测清单里会单独写 taskkill 命令。

.PARAMETER WaitSeconds
    等待秒数，默认 5。

.EXAMPLE
    Stop-AiClient
#>
    [CmdletBinding()]
    param(
        [int]$WaitSeconds = 5,
        [string]$App = $T033App
    )

    $procs = @(Get-Process -Name 'AiClient' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) {
        Write-Host 'AiClient 当前没有在跑。'
    }
    else {
        foreach ($p in $procs) {
            try { [void]$p.CloseMainWindow() } catch { }
        }
        Write-Host "已请求关闭 $($procs.Count) 个 AiClient 进程，等待 $WaitSeconds 秒……"
        Start-Sleep -Seconds $WaitSeconds
    }

    $left = @(Get-Process -Name 'AiClient' -ErrorAction SilentlyContinue)
    $nodeDir = Join-Path $App 'resources\node-runtime'
    $leftNode = @(Get-Process -Name 'node' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($nodeDir, 'OrdinalIgnoreCase') })

    [pscustomobject]@{
        AiClientLeft        = $left.Count
        AiClientPids        = ($left | ForEach-Object { $_.Id }) -join ','
        BundledNodeLeft     = $leftNode.Count
        BundledNodePids     = ($leftNode | ForEach-Object { $_.Id }) -join ','
        BundledNodeRuntime  = $nodeDir
    }
}

function Snap-Baseline {
<#
.SYNOPSIS
    基线快照：进程列表、三个目录清单、session-index.json 副本。

.DESCRIPTION
    落在 C:\t033\evidence\baseline\ 下，文件名带时间戳，所以可以在一天里多次调用
    来做「动作前 / 动作后」对比（例如 F2-b 的三时点法）。

.PARAMETER Tag
    文件名里的标记，默认 baseline。例如 -Tag before / -Tag after / -Tag afterrestart。

.PARAMETER PolicyDir
    受加密策略的目录。不传就跳过那一份清单。

.EXAMPLE
    Snap-Baseline -Tag start -PolicyDir 'D:\Encrypted\t033'
#>
    [CmdletBinding()]
    param(
        [string]$Tag = 'baseline',
        [string]$PolicyDir,
        [string]$UserData = $T033UserData,
        [string]$StateRoot = $T033StateRoot,
        [string]$EvidenceRoot = $T033Evidence
    )

    $dir = Join-Path $EvidenceRoot 'baseline'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $written = New-Object System.Collections.ArrayList

    $procFile = Join-Path $dir ("baseline-{0}-{1}-processes.txt" -f $Tag, $stamp)
    Get-Process | Select-Object Id, ProcessName, Path |
        Sort-Object ProcessName, Id |
        Format-Table -AutoSize | Out-String -Width 4096 |
        Out-File -FilePath $procFile -Encoding UTF8
    [void]$written.Add($procFile)

    $treeFile = Join-Path $dir ("baseline-{0}-{1}-aiclient-tree.txt" -f $Tag, $stamp)
    (Get-AiClientTree | Format-Table -AutoSize | Out-String -Width 4096) |
        Out-File -FilePath $treeFile -Encoding UTF8
    [void]$written.Add($treeFile)

    $dirs = @(
        @{ Name = 'userdata';  Path = $UserData },
        @{ Name = 'stateroot'; Path = $StateRoot }
    )
    if ($PolicyDir) { $dirs += @{ Name = 'policydir'; Path = $PolicyDir } }

    foreach ($entry in $dirs) {
        $out = Join-Path $dir ("baseline-{0}-{1}-{2}.txt" -f $Tag, $stamp, $entry.Name)
        if (Test-Path -LiteralPath $entry.Path) {
            "### $($entry.Path)" | Out-File -FilePath $out -Encoding UTF8
            Get-ChildItem -LiteralPath $entry.Path -Recurse -Force -ErrorAction SilentlyContinue |
                Select-Object FullName, Length, LastWriteTime |
                Sort-Object FullName |
                Format-Table -AutoSize | Out-String -Width 4096 |
                Out-File -FilePath $out -Encoding UTF8 -Append
        }
        else {
            "### 目录不存在：$($entry.Path)" | Out-File -FilePath $out -Encoding UTF8
        }
        [void]$written.Add($out)
    }

    $index = Join-Path $UserData 'session-index.json'
    $indexCopy = Join-Path $dir ("baseline-{0}-{1}-session-index.json" -f $Tag, $stamp)
    if (Test-Path -LiteralPath $index) {
        Copy-Item -LiteralPath $index -Destination $indexCopy -Force
        [void]$written.Add($indexCopy)
    }
    else {
        "会话索引不存在：$index" | Out-File -FilePath $indexCopy -Encoding UTF8
        [void]$written.Add($indexCopy)
    }

    Write-Host "快照写了 $($written.Count) 个文件到 $dir" -ForegroundColor Green
    $written
}

function Get-Trace {
<#
.SYNOPSIS
    在 trace 的 runs.jsonl 与轮转文件里找行。

.DESCRIPTION
    trace 目录里除了 runs.jsonl，超过 8 MiB 后还会有 runs.1.jsonl / runs.2.jsonl /
    runs.3.jsonl，另外轮转时会短暂出现 runs.rotate.lock——本函数按修改时间排序读前者、
    永远跳过后者（检查单 §6 的取证规矩点名了这一条）。

.PARAMETER Pattern
    正则表达式。要按纯文本找就加 -Simple。

.PARAMETER Tail
    只保留最后 N 条命中。想看「trace 尾 50 行」用： Get-Trace -Pattern . -Tail 50

.EXAMPLE
    Get-Trace -Pattern 'io_tsd_unavailable'

.EXAMPLE
    Get-Trace -Pattern 'permission_decision' -Tail 5
#>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Pattern,
        [string]$TraceDir = $T033TraceDir,
        [int]$Tail = 0,
        [switch]$Simple
    )

    if (-not (Test-Path -LiteralPath $TraceDir)) {
        Write-Warning "trace 目录不存在：$TraceDir —— 这次启动是不是没走 Start-AiClient？"
        return
    }
    $files = @(Get-ChildItem -LiteralPath $TraceDir -Filter 'runs*' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'runs.rotate.lock' } |
        Sort-Object LastWriteTime)
    if ($files.Count -eq 0) {
        Write-Warning "$TraceDir 下没有 runs* 文件 —— 应用起来之后还没跑过任何回合？"
        return
    }

    $hits = $files | Select-String -Pattern $Pattern -SimpleMatch:$Simple
    if ($Tail -gt 0 -and $hits) { $hits = @($hits | Select-Object -Last $Tail) }
    $hits
}

function Get-Head16 {
<#
.SYNOPSIS
    读文件头 16 字节，给出十六进制、ASCII，并判断是不是 TSD 加密容器。

.DESCRIPTION
    「非白名单进程看到的是什么」这件事，本函数就是那个非白名单进程：PowerShell 自己
    用 [System.IO.File] 直接读盘。以共享读写方式打开，所以正在被应用占用的文件
    （例如 .writer.lock）也能读。

    IsTsdMagic      前 16 字节是否等于 %TSD-Header-###%
    IsContainerSize 文件大小是否 >= 4096 且是 4096 的整数倍
    两者同时为 True 时，产品代码才把这个文件当成加密容器（src/runtime/host/io.ts:152-155）。

.EXAMPLE
    Get-Head16 -Path 'D:\Encrypted\t033\tracked.txt'

.EXAMPLE
    Get-Head16 -Path $lock | Save-Evidence -Group enc -Id 14 -Slug lock-header
#>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$Count = 16
    )

    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    $stream = [System.IO.File]::Open(
        $item.FullName,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite)
    try {
        $buffer = New-Object byte[] $Count
        $read = $stream.Read($buffer, 0, $Count)
    }
    finally {
        $stream.Dispose()
    }

    $hex = ''
    $ascii = ''
    for ($i = 0; $i -lt $read; $i++) {
        $b = $buffer[$i]
        $hex += ('{0:x2} ' -f $b)
        if ($b -ge 32 -and $b -le 126) { $ascii += [char]$b } else { $ascii += '.' }
    }

    [pscustomobject]@{
        Path            = $item.FullName
        Size            = $item.Length
        BytesRead       = $read
        Hex             = $hex.TrimEnd()
        Ascii           = $ascii
        IsTsdMagic      = ($ascii -eq $T033TsdMagic)
        IsContainerSize = (($item.Length -ge $T033TsdBlock) -and (($item.Length % $T033TsdBlock) -eq 0))
        Sha256          = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    }
}

function Get-AiClientTree {
<#
.SYNOPSIS
    列出 AiClient 及其全部子孙进程。

.DESCRIPTION
    用 Get-CimInstance Win32_Process 取全表，再按 ParentProcessId 逐层往下走。
    Name 前面的缩进就是层级。CommandLine 能看出 worker 是用随包 node.exe 起的还是
    utilityProcess 起的。

    一个已知的坑：Windows 会复用已退出进程的 PID，所以极少数情况下会有无关进程因为
    PPID 撞号被挂进树里。看到明显不相干的进程名时，用 Get-Process -Id <PID> 复核。

.EXAMPLE
    Get-AiClientTree | Format-Table -AutoSize

.EXAMPLE
    Get-AiClientTree | Save-Evidence -Group enc -Id 1 -Slug process-tree
#>
    [CmdletBinding()]
    param([string]$NameLike = 'AiClient*')

    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop |
        Select-Object Name, ProcessId, ParentProcessId, CommandLine)

    $byParent = @{}
    foreach ($p in $all) {
        $key = [string]$p.ParentProcessId
        if (-not $byParent.ContainsKey($key)) {
            $byParent[$key] = New-Object System.Collections.ArrayList
        }
        [void]$byParent[$key].Add($p)
    }

    $roots = @($all | Where-Object { $_.Name -like $NameLike })
    if ($roots.Count -eq 0) {
        Write-Host "没有名字匹配 $NameLike 的进程。"
        return
    }
    $rootIds = @($roots | ForEach-Object { $_.ProcessId })
    $tops = @($roots | Where-Object { $rootIds -notcontains $_.ParentProcessId })

    $stack = New-Object System.Collections.Stack
    for ($i = $tops.Count - 1; $i -ge 0; $i--) {
        $stack.Push(@($tops[$i], 0))
    }

    $seen = @{}
    $out = New-Object System.Collections.ArrayList
    while ($stack.Count -gt 0) {
        $node = $stack.Pop()
        $proc = $node[0]
        $depth = [int]$node[1]
        $pidKey = [string]$proc.ProcessId
        if ($seen.ContainsKey($pidKey)) { continue }
        $seen[$pidKey] = $true

        [void]$out.Add([pscustomobject]@{
            Name        = (' ' * ($depth * 2)) + $proc.Name
            PID         = $proc.ProcessId
            PPID        = $proc.ParentProcessId
            CommandLine = $proc.CommandLine
        })

        if ($byParent.ContainsKey($pidKey)) {
            $kids = $byParent[$pidKey]
            for ($i = $kids.Count - 1; $i -ge 0; $i--) {
                $stack.Push(@($kids[$i], $depth + 1))
            }
        }
    }
    $out
}

function Save-Evidence {
<#
.SYNOPSIS
    按证据命名规矩把文本写进 C:\t033\evidence\<组>\。

.DESCRIPTION
    文件名规则：<组>-<两位编号>-<英文 slug>.<扩展名>，例如 enc-16-version-stamp.json。
    编号会自动补成两位（16 -> 16，7 -> 07）。目录不存在会自动建。

.PARAMETER Content
    要写的内容。可以直接传字符串，也可以用管道喂对象（会按 PowerShell 的表格形式落盘）。

.EXAMPLE
    Get-Head16 -Path $file | Save-Evidence -Group enc -Id 17 -Slug header-bytes

.EXAMPLE
    Save-Evidence -Group enc -Id 8 -Slug f3-inputs -Content "R0=... R2=... R3=..." 
#>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Group,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Slug,
        [Parameter(ValueFromPipeline = $true)]$Content,
        [string]$Extension = 'txt',
        [string]$EvidenceRoot = $T033Evidence
    )

    begin {
        $buffer = New-Object System.Collections.ArrayList
    }
    process {
        if ($null -ne $Content) { [void]$buffer.Add($Content) }
    }
    end {
        $groupText = $Group.ToLower()
        $n = 0
        if ([int]::TryParse($Id, [ref]$n)) { $idText = '{0:d2}' -f $n } else { $idText = $Id }

        $dir = Join-Path $EvidenceRoot $groupText
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $name = '{0}-{1}-{2}.{3}' -f $groupText, $idText, $Slug, $Extension
        $file = Join-Path $dir $name

        $text = $buffer | Format-List | Out-String -Width 4096
        if ($buffer.Count -eq 1 -and $buffer[0] -is [string]) { $text = [string]$buffer[0] }
        $text | Out-File -FilePath $file -Encoding UTF8

        Write-Host "已写：$file" -ForegroundColor Green
        $file
    }
}

Write-Host '' 
Write-Host 't033-helper.ps1 已载入。' -ForegroundColor Cyan
Write-Host ("  安装目录 `$T033App = {0}" -f $T033App)
Write-Host ("  证据根   `$T033Evidence = {0}" -f $T033Evidence)
Write-Host ("  trace    `$T033TraceDir = {0}" -f $T033TraceDir)
Write-Host '  函数：Start-AiClient / Stop-AiClient / Snap-Baseline / Get-Trace / Get-Head16 / Get-AiClientTree / Save-Evidence'

# ---------------------------------------------------------------------------
# WIN 组专用（原 02-WIN.md §0.5，已并入本脚本，载入后即可直接调用）
# ---------------------------------------------------------------------------

function Show-Chain($id) {          # 往上打印父进程链
  while ($id) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if (-not $p) { break }
    '{0}  {1}  {2}' -f $p.ProcessId, $p.Name, $p.ExecutablePath
    $id = $p.ParentProcessId
  }
}
function Show-Tree($id, $depth = 0) {   # 往下打印子孙进程树
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if (-not $p) { return }
  '{0}{1}  {2}  {3}' -f (' ' * ($depth * 2)), $p.ProcessId, $p.Name, $p.CommandLine
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" | ForEach-Object { Show-Tree $_.ProcessId ($depth + 1) }
}
# WIN-16 / WIN-17 用：按 src/runtime/host/shell.ts 的候选顺序列出 worker 会去找的每一个 bash.exe
function Get-BashCandidates {
  $cands = @()
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root) { $cands += (Join-Path $root 'Git\bin\bash.exe') }
  }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe') }
  foreach ($e in ($env:Path -split ';')) {
    if (-not $e) { continue }
    if (-not [System.IO.Path]::IsPathRooted($e)) { continue }
    if ($e -match '[\\/](system32|sysnative)[\\/]?$') { continue }   # 代码明确跳过这两类
    $cands += (Join-Path $e 'bash.exe')
    if ((Split-Path $e -Leaf).ToLower() -eq 'cmd') { $cands += (Join-Path $e '..\bin\bash.exe') }
  }
  $cands | ForEach-Object { '{0}  {1}' -f (Test-Path $_), $_ }
}
