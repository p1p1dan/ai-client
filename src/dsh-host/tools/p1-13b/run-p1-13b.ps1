<#
.SYNOPSIS
    dsh-rebase P1-13b 加密矩阵（Windows PowerShell 5.1 即可）。纯本地文件读写：不起 DSH 宿主、不起网关、不联网、不调用任何模型。

.DESCRIPTION
    要弄清三件事：随包 node.exe 能解密哪些扩展名；node.exe 新建的文件为什么不加密；加密策略是否按进程名匹配。
    1. 在 -EncDir 下建 p113b-<时间>\in\，由 PowerShell 按文件类型各建一份标记文件（51 个）。
    2. 加 -ManualEncryption 时暂停：等用户用加密客户端把整个 in 目录加密，并在确认文件里写 CONFIRMED。
    3. 读者逐个读每个文件的前 64 字节：随包 node.exe、Electron 主程序（ELECTRON_RUN_AS_NODE=1）、
       node.exe 的改名副本（%TEMP%\p113b-<时间>\p113b-raw.exe）、Windows PowerShell 5.1、PowerShell 7、
       certutil -dump、Git Bash（head | od）。
    4. 写者在 out-<写者>\ 下每个类型各写一份：node.exe 的六种写法、Electron、改名副本、Set-Content。
       每个写者写完，立刻让全部读者读一遍；全部写完后，等到离最后一次写入满 -DelaySeconds 秒，再读一遍。
    5. 报告在本目录 report-p113b-<时间>\：matrix.json、summary.txt、probe.log。
    只写 -EncDir\p113b-<时间>\、%TEMP%\p113b-<时间>\ 与本目录下的 report-p113b-<时间>\。
    子进程只按 pid 管理；结束时删掉改名副本。

.PARAMETER EncDir
    受加密策略覆盖的已有目录。
.PARAMETER AppDir
    已安装应用的目录（含 resources\node-runtime\node.exe）。不给就按默认安装位置和卸载注册表找。
.PARAMETER ManualEncryption
    建好输入文件后暂停，等人工加密并确认。正式上机必须加。
.PARAMETER DelaySeconds
    延迟复读距最后一次写入的秒数，默认 60。
.PARAMETER KeepWork
    保留工作目录。默认就保留，便于用加密客户端查看 out-*\ 下的文件；这个开关只为与旧脚本的用法一致。
.PARAMETER RemoveWork
    结束时删除工作目录。
.PARAMETER GitBash
    Git Bash 的 bash.exe。不给就找默认安装位置。

.EXAMPLE
    Set-ExecutionPolicy -Scope Process Bypass
    & 'C:\p113b\aiclient-p1-13b-kit\run-p1-13b.ps1' -EncDir 'D:\Encrypted' -ManualEncryption
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EncDir,
    [string]$AppDir = '',
    [switch]$ManualEncryption,
    [ValidateRange(0, 3600)][int]$DelaySeconds = 60,
    [switch]$KeepWork,
    [switch]$RemoveWork,
    [string]$GitBash = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if ($PSVersionTable.PSVersion.Major -ge 6) {
    Write-Host '[P1-13b] 请用 Windows PowerShell 5.1（powershell.exe）运行：它本身就是读者 R-ps51 和写者 W-ps51。' -ForegroundColor Red
    exit 1
}
if ($KeepWork -and $RemoveWork) {
    Write-Host '[P1-13b] -KeepWork 与 -RemoveWork 只能选一个。' -ForegroundColor Red
    exit 1
}

$TsdMagic = '%TSD-Header-###%'
$kit = $PSScriptRoot
$probe = Join-Path $kit 'matrix-probe.mjs'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$records = New-Object System.Collections.Generic.List[string]

# Everything the finally block and the report touch starts out defined (StrictMode).
$reportDir = $null
$logFile = $null
$nodeExe = $null
$electronExe = $null
$renamedExe = $null
$tempRoot = $null
$work = $null
$inDir = $null
$marker = $null
$plan = $null
$fatal = $null

# ---- helpers ---------------------------------------------------------------------

function Get-IsoNow { [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") }

function Write-Log([string]$Text, [string]$Color = '') {
    if ($Color) { Write-Host "[P1-13b] $Text" -ForegroundColor $Color } else { Write-Host "[P1-13b] $Text" }
    if ($logFile) { [System.IO.File]::AppendAllText($logFile, "[$(Get-IsoNow)] $Text`r`n", $utf8Bom) }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Add-Record($Object) {
    $records.Add((ConvertTo-Json -InputObject $Object -Compress -Depth 10))
}

# Property of a ConvertFrom-Json object, or $null when absent (StrictMode-safe).
function Get-Prop($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

# Windows command-line quoting (the rules CommandLineToArgvW and the MSVC runtime use).
function ConvertTo-CommandLine([string[]]$Items) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Items) {
        if ($item.Length -gt 0 -and $item -notmatch '[\s"]') { $parts.Add($item); continue }
        $builder = New-Object System.Text.StringBuilder
        [void]$builder.Append('"')
        $slashes = 0
        foreach ($ch in $item.ToCharArray()) {
            if ($ch -eq [char]'\') { $slashes++; continue }
            if ($ch -eq [char]'"') {
                [void]$builder.Append('\' * (2 * $slashes + 1))
                [void]$builder.Append('"')
                $slashes = 0
                continue
            }
            if ($slashes -gt 0) { [void]$builder.Append('\' * $slashes); $slashes = 0 }
            [void]$builder.Append($ch)
        }
        if ($slashes -gt 0) { [void]$builder.Append('\' * (2 * $slashes)) }
        [void]$builder.Append('"')
        $parts.Add($builder.ToString())
    }
    return ($parts -join ' ')
}

# Kill one child by its exact pid (and its own descendants: Git Bash's launcher
# spawns the real bash). Never by name.
function Stop-ChildTree($Process) {
    $ErrorActionPreference = 'Continue'
    try { & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F 2>&1 | Out-Null } catch { }
    try { if (-not $Process.HasExited) { $Process.Kill() } } catch { }
}

# Start one child with redirected pipes; wait at most TimeoutSec, then kill that pid.
function Invoke-Child {
    param(
        [string]$Exe,
        [string[]]$Arguments = @(),
        [hashtable]$Environment = @{},
        [string]$StdIn = '',
        [int]$TimeoutSec = 120
    )
    $result = [pscustomobject]@{
        exe = $Exe; started = $false; pid = $null; exitCode = $null; timedOut = $false
        stdout = ''; stderr = ''; error = $null; ms = 0
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = ConvertTo-CommandLine $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $utf8NoBom
    $psi.StandardErrorEncoding = $utf8NoBom
    $psi.WorkingDirectory = $kit
    # .NET 4.6+ Environment keeps the variable-name case (bash is case-sensitive).
    $envTable = $null
    if ($psi.PSObject.Properties['Environment']) { $envTable = $psi.Environment } else { $envTable = $psi.EnvironmentVariables }
    foreach ($key in @($Environment.Keys)) {
        if ($null -eq $Environment[$key]) {
            if ($envTable.ContainsKey($key)) { [void]$envTable.Remove($key) }
        } else {
            $envTable[$key] = [string]$Environment[$key]
        }
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try { [void]$process.Start() } catch { $result.error = $_.Exception.Message; return $result }
    $result.started = $true
    $result.pid = $process.Id
    try {
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        try {
            if ($StdIn -ne '') {
                $bytes = $utf8NoBom.GetBytes($StdIn)
                $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
                $process.StandardInput.BaseStream.Flush()
            }
            $process.StandardInput.Close()
        } catch { $result.error = "stdin: $($_.Exception.Message)" }
        if (-not $process.WaitForExit($TimeoutSec * 1000)) {
            $result.timedOut = $true
            Stop-ChildTree $process
        }
        [void]$process.WaitForExit(10000)
        if ($outTask.Wait(10000)) { $result.stdout = $outTask.Result }
        if ($errTask.Wait(10000)) { $result.stderr = $errTask.Result }
        if ($process.HasExited) { $result.exitCode = $process.ExitCode }
    } finally {
        $watch.Stop()
        $result.ms = $watch.ElapsedMilliseconds
        $process.Dispose()
    }
    return $result
}

# Run matrix-probe.mjs under a node-like exe; the request travels in P113B_REQUEST.
function Invoke-Probe {
    param([string]$Exe, [hashtable]$Request, [switch]$AsElectron, [int]$TimeoutSec = 180)
    $envMap = @{
        P113B_REQUEST = (ConvertTo-Json -InputObject $Request -Compress -Depth 8)
        NODE_OPTIONS = $null
        ELECTRON_RUN_AS_NODE = $null
    }
    if ($AsElectron) { $envMap['ELECTRON_RUN_AS_NODE'] = '1' }
    $run = Invoke-Child -Exe $Exe -Arguments @($probe, [string]$Request['cmd']) -Environment $envMap -TimeoutSec $TimeoutSec
    $replyText = $null
    foreach ($line in @($run.stdout -split "`r?`n")) { if ($line.StartsWith('{')) { $replyText = $line } }
    $reply = $null
    if ($replyText) { try { $reply = ConvertFrom-Json $replyText } catch { } }
    $run | Add-Member -NotePropertyName replyText -NotePropertyValue $replyText
    $run | Add-Member -NotePropertyName reply -NotePropertyValue $reply
    return $run
}

function Get-RunFailure($Run) {
    $text = "exit $($Run.exitCode)"
    if ($Run.timedOut) { $text = 'timeout' }
    if ($Run.error) { $text = "$text; $($Run.error)" }
    $stderr = "$($Run.stderr)".Trim()
    if ($stderr) { $text = "$text; stderr: $($stderr.Substring(0, [Math]::Min(300, $stderr.Length)))" }
    return $text
}

function ConvertTo-Hex([byte[]]$Bytes, [int]$Count) {
    if ($Count -le 0) { return '' }
    return ([System.BitConverter]::ToString($Bytes, 0, $Count)).Replace('-', '').ToLowerInvariant()
}

# Console progress only; the report classifies every result again from the raw bytes.
function Get-ResultClass($Result) {
    if (Get-Prop $Result 'error') { return 'error' }
    if (-not (Get-Prop $Result 'exists')) { return 'missing' }
    $hex = Get-Prop $Result 'hex'
    if ($null -eq $hex) { return 'unparsed' }
    $bytes = New-Object byte[] ([int][Math]::Floor($hex.Length / 2))
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
    $text = $latin1.GetString($bytes)
    if ($text.Contains($TsdMagic)) { return 'ciphertext' }
    if ($text.Contains($marker)) { return 'plaintext' }
    return 'other'
}

$ClassNames = @{ plaintext = '明文'; ciphertext = 'TSD 头'; other = '其他'; missing = '不存在'; error = '出错'; unparsed = '待报告解析' }

function Format-Counts([string[]]$Classes) {
    $groups = @($Classes | Group-Object | Sort-Object Name)
    if ($groups.Count -eq 0) { return '无结果' }
    return (@($groups | ForEach-Object {
                $name = $_.Name
                if ($ClassNames.ContainsKey($name)) { $name = $ClassNames[$name] }
                "$name $($_.Count)"
            }) -join '，')
}

function New-ReadRecord([string]$Reader, [string]$Phase, [string]$Target, [string]$At, [object[]]$Results, $Process) {
    return [ordered]@{
        type = 'read'; reader = $Reader; phase = $Phase; target = $Target
        at = $At; finishedAt = (Get-IsoNow); process = $Process; results = @($Results)
    }
}

# ---- discovery -------------------------------------------------------------------

function Find-AppDir {
    if ($AppDir -ne '') { return $AppDir }
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('PiLab Ai', 'PiLabAi', 'jyw-ai-client', 'AiClient')) {
        $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\$name"))
        $candidates.Add((Join-Path $env:ProgramFiles $name))
    }
    foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        Get-ItemProperty -Path $key -ErrorAction SilentlyContinue | ForEach-Object {
            $names = $_.PSObject.Properties.Name
            if (($names -contains 'DisplayName') -and ($names -contains 'InstallLocation') -and ("$($_.DisplayName)" -like 'PiLab*')) {
                $candidates.Add("$($_.InstallLocation)")
            }
        }
    }
    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'resources\node-runtime\node.exe'))) { return $dir }
    }
    return $null
}

# The app's Electron exe in AppDir's root: electron-builder's executableName
# (PiLabAi.exe), older names, else the only non-uninstaller exe next to app.asar.
function Find-ElectronExe([string]$App) {
    foreach ($name in @('PiLabAi.exe', 'PiLab Ai.exe', 'jyw-ai-client.exe', 'AiClient.exe')) {
        $path = Join-Path $App $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $App 'resources\app.asar'))) { return $null }
    $exes = @(Get-ChildItem -LiteralPath $App -Filter '*.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike 'Uninstall*' -and $_.Name -notlike 'elevate*' })
    if ($exes.Count -eq 1) { return $exes[0].FullName }
    return $null
}

function Find-GitBash {
    if ($GitBash -ne '') {
        if (Test-Path -LiteralPath $GitBash -PathType Leaf) { return $GitBash }
        return $null
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Git\bin\bash.exe')) }
    if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe')) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')) }
    foreach ($path in $candidates) { if (Test-Path -LiteralPath $path -PathType Leaf) { return $path } }
    return $null
}

function Find-Pwsh7 {
    if ($env:ProgramFiles) {
        $path = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    $command = Get-Command 'pwsh.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Path }
    return $null
}

function Get-FileVersion([string]$Path) {
    try {
        $info = (Get-Item -LiteralPath $Path).VersionInfo
        if ($info.ProductVersion) { return "$($info.ProductVersion)".Trim() }
        return "$($info.FileVersion)".Trim()
    } catch { return $null }
}

# ---- readers ---------------------------------------------------------------------

function Read-WithProbe($Reader, [string]$Phase, [string]$Target, [object[]]$Items) {
    $at = Get-IsoNow
    $request = @{
        cmd = 'read'; reader = $Reader.id; phase = $Phase; target = $Target; marker = $marker
        items = @($Items | ForEach-Object { [ordered]@{ key = $_.key; path = $_.path } })
    }
    $run = Invoke-Probe -Exe $Reader.exe -Request $request -AsElectron:($Reader.id -eq 'R-electron')
    if ((Get-Prop $run.reply 'type') -eq 'read') {
        $records.Add($run.replyText)
        $counts = Get-Prop $run.reply 'counts'
        $classes = @()
        if ($counts) { foreach ($p in $counts.PSObject.Properties) { $classes += @($p.Name) * [int]$p.Value } }
        return $classes
    }
    $failure = Get-RunFailure $run
    $results = @($Items | ForEach-Object { [pscustomobject]@{ key = $_.key; path = $_.path; exists = $null; size = $null; hex = $null; error = "probe failed: $failure" } })
    Add-Record (New-ReadRecord $Reader.id $Phase $Target $at $results @{ pid = $run.pid; execPath = $Reader.exe })
    return @($results | ForEach-Object { 'error' })
}

function Read-Ps51($Reader, [string]$Phase, [string]$Target, [object[]]$Items) {
    $at = Get-IsoNow
    $results = foreach ($item in $Items) {
        $r = [pscustomobject]@{ key = $item.key; path = $item.path; exists = $false; size = $null; hex = $null; error = $null }
        if (Test-Path -LiteralPath $item.path -PathType Leaf) {
            $r.exists = $true
            try {
                $bytes = [System.IO.File]::ReadAllBytes($item.path)
                $r.size = $bytes.Length
                $r.hex = ConvertTo-Hex $bytes ([Math]::Min(64, $bytes.Length))
            } catch { $r.error = $_.Exception.Message }
        }
        $r
    }
    $results = @($results)
    Add-Record (New-ReadRecord $Reader.id $Phase $Target $at $results @{ pid = $PID; execPath = $Reader.exe; psVersion = "$($PSVersionTable.PSVersion)" })
    return @($results | ForEach-Object { Get-ResultClass $_ })
}

$Pwsh7Script = @'
$ErrorActionPreference = 'Stop'
$i = 0
foreach ($p in ($env:P113B_LIST -split "`n")) {
    $r = [ordered]@{ i = $i; exists = $false; size = $null; hex = $null; error = $null }
    try {
        if ([System.IO.File]::Exists($p)) {
            $r.exists = $true
            $bytes = [System.IO.File]::ReadAllBytes($p)
            $r.size = $bytes.Length
            $n = [Math]::Min(64, $bytes.Length)
            $r.hex = ''
            if ($n -gt 0) { $r.hex = ([System.BitConverter]::ToString($bytes, 0, $n)).Replace('-', '').ToLowerInvariant() }
        }
    } catch { $r.error = $_.Exception.Message }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $r -Compress -EscapeHandling EscapeNonAscii))
    $i++
}
'@
$Pwsh7Encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Pwsh7Script))

function Read-Pwsh7($Reader, [string]$Phase, [string]$Target, [object[]]$Items) {
    $at = Get-IsoNow
    $list = (@($Items | ForEach-Object { $_.path }) -join "`n")
    $run = Invoke-Child -Exe $Reader.exe -Arguments @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $Pwsh7Encoded) -Environment @{ P113B_LIST = $list } -TimeoutSec 180
    $byIndex = @{}
    foreach ($line in @($run.stdout -split "`r?`n")) {
        if (-not $line.StartsWith('{')) { continue }
        try { $row = ConvertFrom-Json $line; $byIndex[[int](Get-Prop $row 'i')] = $row } catch { }
    }
    $failure = Get-RunFailure $run
    $results = @()
    for ($index = 0; $index -lt $Items.Count; $index++) {
        $item = $Items[$index]
        $row = $byIndex[$index]
        if ($null -eq $row) {
            $results += [pscustomobject]@{ key = $item.key; path = $item.path; exists = $null; size = $null; hex = $null; error = "no output from pwsh7: $failure" }
        } else {
            $results += [pscustomobject]@{ key = $item.key; path = $item.path; exists = [bool](Get-Prop $row 'exists'); size = (Get-Prop $row 'size'); hex = (Get-Prop $row 'hex'); error = (Get-Prop $row 'error') }
        }
    }
    Add-Record (New-ReadRecord $Reader.id $Phase $Target $at $results @{ pid = $run.pid; execPath = $Reader.exe; exitCode = $run.exitCode })
    return @($results | ForEach-Object { Get-ResultClass $_ })
}

function Read-Certutil($Reader, [string]$Phase, [string]$Target, [object[]]$Items) {
    $at = Get-IsoNow
    $results = foreach ($item in $Items) {
        $r = [pscustomobject]@{ key = $item.key; path = $item.path; exists = $false; certutilDump = $null; exitCode = $null; error = $null }
        if (Test-Path -LiteralPath $item.path -PathType Leaf) {
            $r.exists = $true
            $run = Invoke-Child -Exe $Reader.exe -Arguments @('-dump', $item.path) -TimeoutSec 30
            $r.exitCode = $run.exitCode
            if (-not $run.started -or $run.timedOut) {
                $r.error = Get-RunFailure $run
            } else {
                $text = "$($run.stdout)"
                $r.certutilDump = $text.Substring(0, [Math]::Min(1200, $text.Length))
            }
        }
        $r
    }
    $results = @($results)
    Add-Record (New-ReadRecord $Reader.id $Phase $Target $at $results @{ execPath = $Reader.exe })
    return @($results | ForEach-Object {
            if ($_.error) { 'error' } elseif (-not $_.exists) { 'missing' } else { 'unparsed' }
        })
}

# LF only: bash reads this script from stdin.
$BashScript = @'
set -o pipefail
i=0
printf '%s\n' "$P113B_LIST" | while IFS= read -r p; do
  if [ -f "$p" ]; then
    if h=$(head -c 64 -- "$p" | od -An -v -tx1 | tr -d ' \n'); then
      printf '%s\tOK\t%s\n' "$i" "$h"
    else
      printf '%s\tERR\t\n' "$i"
    fi
  else
    printf '%s\tMISSING\t\n' "$i"
  fi
  i=$((i+1))
done
'@
$BashScript = $BashScript -replace "`r`n", "`n"

function Read-Bash($Reader, [string]$Phase, [string]$Target, [object[]]$Items) {
    $at = Get-IsoNow
    $list = (@($Items | ForEach-Object { $_.path.Replace('\', '/') }) -join "`n")
    $run = Invoke-Child -Exe $Reader.exe -Arguments @('-s') -Environment @{ P113B_LIST = $list } -StdIn $BashScript -TimeoutSec 180
    $byIndex = @{}
    foreach ($line in @($run.stdout -split "`n")) {
        $m = [regex]::Match($line.TrimEnd("`r"), '^(\d+)\t(OK|MISSING|ERR)\t([0-9a-fA-F]*)$')
        if ($m.Success) { $byIndex[[int]$m.Groups[1].Value] = $m }
    }
    $failure = Get-RunFailure $run
    $results = @()
    for ($index = 0; $index -lt $Items.Count; $index++) {
        $item = $Items[$index]
        $m = $byIndex[$index]
        $r = [pscustomobject]@{ key = $item.key; path = $item.path; exists = $null; size = $null; hex = $null; error = $null }
        if ($null -eq $m) { $r.error = "no output from bash: $failure" }
        elseif ($m.Groups[2].Value -eq 'MISSING') { $r.exists = $false }
        elseif ($m.Groups[2].Value -eq 'ERR') { $r.exists = $true; $r.error = "head failed: $failure" }
        else { $r.exists = $true; $r.hex = $m.Groups[3].Value.ToLowerInvariant() }
        $results += $r
    }
    Add-Record (New-ReadRecord $Reader.id $Phase $Target $at $results @{ pid = $run.pid; execPath = $Reader.exe; exitCode = $run.exitCode })
    return @($results | ForEach-Object { Get-ResultClass $_ })
}

function Invoke-ReadPass([string]$Phase, [string]$Target, [object[]]$Items) {
    foreach ($reader in $readerOrder) {
        if (-not $reader.available) { continue }
        switch ($reader.id) {
            'R-ps51' { $classes = Read-Ps51 $reader $Phase $Target $Items }
            'R-pwsh7' { $classes = Read-Pwsh7 $reader $Phase $Target $Items }
            'R-certutil' { $classes = Read-Certutil $reader $Phase $Target $Items }
            'R-bash' { $classes = Read-Bash $reader $Phase $Target $Items }
            default { $classes = Read-WithProbe $reader $Phase $Target $Items }
        }
        Write-Log "  $Phase $Target $($reader.id)：$(Format-Counts @($classes))"
    }
}

# ---- writers ---------------------------------------------------------------------

function Write-Ps51([string]$WriterId, [string]$OutDir) {
    $startedAt = Get-IsoNow
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $results = foreach ($item in $inputItems) {
        $path = Join-Path $OutDir $item.name
        $r = [ordered]@{ key = $item.key; path = $path; ok = $false; error = $null; detail = $null; at = $null }
        try {
            Set-Content -LiteralPath $path -Value "$marker $($item.key) written by $WriterId" -Encoding ASCII
            $r.ok = $true
        } catch { $r.error = $_.Exception.Message }
        $r.at = Get-IsoNow
        [pscustomobject]$r
    }
    $results = @($results)
    Add-Record ([ordered]@{
            type = 'write'; writer = $WriterId; mode = 'set-content'; outDir = $OutDir
            startedAt = $startedAt; finishedAt = (Get-IsoNow); process = @{ pid = $PID; execPath = $psExe }; results = $results
        })
    return $results
}

function Invoke-Writer($Writer, $State) {
    $outDir = Join-Path $work "out-$($Writer.id)"
    if ($Writer.runner -eq 'ps51') {
        $results = @(Write-Ps51 $Writer.id $outDir)
    } else {
        $startedAt = Get-IsoNow
        $request = @{
            cmd = 'write'; writer = $Writer.id; mode = $Writer.mode; outDir = $outDir; marker = $marker
            items = @($inputItems | ForEach-Object { [ordered]@{ key = $_.key; name = $_.name; source = $_.path } })
        }
        $run = Invoke-Probe -Exe $State.exe -Request $request -AsElectron:($Writer.runner -eq 'electron')
        if ((Get-Prop $run.reply 'type') -eq 'write') {
            $records.Add($run.replyText)
            $results = @(Get-Prop $run.reply 'results')
        } else {
            $failure = Get-RunFailure $run
            $results = @($inputItems | ForEach-Object {
                    [pscustomobject]@{ key = $_.key; path = (Join-Path $outDir $_.name); ok = $false; error = "probe failed: $failure"; detail = $null; at = (Get-IsoNow) }
                })
            Add-Record ([ordered]@{
                    type = 'write'; writer = $Writer.id; mode = $Writer.mode; outDir = $outDir
                    startedAt = $startedAt; finishedAt = (Get-IsoNow); process = @{ pid = $run.pid; execPath = $State.exe }; results = $results
                })
        }
    }
    $failed = @($results | Where-Object { -not (Get-Prop $_ 'ok') }).Count
    Write-Log "$($Writer.id)：写入 $($results.Count - $failed) 个，失败 $failed 个 → $outDir"
    return [pscustomobject]@{
        id = $Writer.id
        items = @($inputItems | ForEach-Object { [pscustomobject]@{ key = $_.key; path = (Join-Path $outDir $_.name) } })
    }
}

# ---- 0. checks before anything is written ------------------------------------------

if (-not (Test-Path -LiteralPath $EncDir -PathType Container)) {
    Write-Host "[P1-13b] -EncDir 不存在：$EncDir" -ForegroundColor Red
    exit 1
}
$encFull = (Resolve-Path -LiteralPath $EncDir).Path.TrimEnd('\')
$kitFull = (Resolve-Path -LiteralPath $kit).Path.TrimEnd('\')
if ($kitFull -ieq $encFull -or $kitFull.StartsWith("$encFull\", [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "[P1-13b] 工具包目录在 -EncDir 里面（$kitFull）。请把工具包放到不受加密策略的目录（如 C:\p113b）。" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) {
    Write-Host "[P1-13b] 工具包不完整，缺 $probe" -ForegroundColor Red
    exit 1
}
$app = Find-AppDir
if ($null -eq $app) {
    Write-Host '[P1-13b] 没找到已安装的应用（resources\node-runtime\node.exe）。请用 -AppDir 指定安装目录后重跑。' -ForegroundColor Red
    exit 1
}
$nodeExe = Join-Path $app 'resources\node-runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    Write-Host "[P1-13b] $nodeExe 不存在。" -ForegroundColor Red
    exit 1
}

$reportDir = Join-Path $kit "report-p113b-$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$logFile = Join-Path $reportDir 'probe.log'
$psExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
Write-Log "工具包 $kit；报告目录 $reportDir"

$nodePing = Invoke-Probe -Exe $nodeExe -Request @{ cmd = 'ping' } -TimeoutSec 60
if (-not (Get-Prop $nodePing.reply 'ok')) {
    Write-Log "随包 node.exe 跑不起 matrix-probe.mjs：$(Get-RunFailure $nodePing)" Red
    Write-Log '常见原因：工具包目录受加密策略（node 读到的是密文脚本），或安全软件拦截。请换一个不受策略的目录重新解压。' Red
    exit 1
}
$nodeVersion = Get-Prop (Get-Prop $nodePing.reply 'process') 'node'
Write-Log "随包 node.exe：$nodeExe（$nodeVersion）"
$planRun = Invoke-Probe -Exe $nodeExe -Request @{ cmd = 'plan' } -TimeoutSec 60
$plan = $planRun.reply
if (-not (Get-Prop $plan 'ok')) {
    Write-Log "取文件清单失败：$(Get-RunFailure $planRun)" Red
    exit 1
}
$marker = $plan.marker
$records.Add($planRun.replyText)

# ---- 1..6 ---------------------------------------------------------------------------

try {
    # ---- 1. readers and writers available on this machine ----
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $enableLua = $null
    try { $enableLua = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -ErrorAction Stop).EnableLUA } catch { }
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $osName = [Environment]::OSVersion.VersionString
    if ($os) { $osName = "$($os.Caption) $($os.Version)" }

    $readerState = @{}
    foreach ($def in @($plan.readers)) {
        $readerState[$def.id] = [pscustomobject]@{ id = $def.id; available = $false; exe = $null; version = $null; skipReason = '未检测' }
    }
    $readerState['R-node'].available = $true
    $readerState['R-node'].exe = $nodeExe
    $readerState['R-node'].version = $nodeVersion

    # Electron main exe with ELECTRON_RUN_AS_NODE=1. If the exe ignored the
    # variable it would start the GUI: the ping then times out and that pid is killed.
    $electronVersion = $null
    $electronNode = $null
    $electronSkip = $null
    $electronExe = Find-ElectronExe $app
    if ($null -eq $electronExe) {
        $electronSkip = "AppDir 根目录没找到 Electron 主程序（$app）"
    } else {
        $electronPing = Invoke-Probe -Exe $electronExe -Request @{ cmd = 'ping' } -AsElectron -TimeoutSec 30
        $electronProcess = Get-Prop $electronPing.reply 'process'
        $electronVersion = Get-Prop $electronProcess 'electron'
        $electronNode = Get-Prop $electronProcess 'node'
        if (-not (Get-Prop $electronPing.reply 'ok')) {
            $electronSkip = "以 ELECTRON_RUN_AS_NODE=1 跑不起脚本：$(Get-RunFailure $electronPing)"
        } elseif (-not $electronVersion) {
            $electronSkip = "$electronExe 不是 Electron（process.versions.electron 为空）"
        }
    }
    if ($electronSkip) {
        $readerState['R-electron'].skipReason = $electronSkip
        Write-Log "Electron 主程序：跳过（$electronSkip）" Yellow
    } else {
        $readerState['R-electron'].available = $true
        $readerState['R-electron'].exe = $electronExe
        $readerState['R-electron'].version = "electron $electronVersion / node $electronNode"
        Write-Log "Electron 主程序：$electronExe（Electron $electronVersion，Node $electronNode）"
    }
    $appVersion = $null
    if ($electronExe) { $appVersion = Get-FileVersion $electronExe }

    # Renamed copy of node.exe: does the policy follow the process name?
    $renamedSkip = $null
    $renamedSameHash = $null
    $tempRoot = Join-Path $env:TEMP "p113b-$stamp"
    try {
        New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
        $renamedExe = Join-Path $tempRoot 'p113b-raw.exe'
        Copy-Item -LiteralPath $nodeExe -Destination $renamedExe
        $renamedSameHash = ((Get-FileHash -LiteralPath $renamedExe -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash)
        $renamedPing = Invoke-Probe -Exe $renamedExe -Request @{ cmd = 'ping' } -TimeoutSec 60
        if (-not (Get-Prop $renamedPing.reply 'ok')) { $renamedSkip = "改名副本跑不起脚本：$(Get-RunFailure $renamedPing)" }
    } catch { $renamedSkip = "复制改名副本失败：$($_.Exception.Message)" }
    if ($renamedSkip) {
        $readerState['R-renamed'].skipReason = $renamedSkip
        Write-Log "改名副本：跳过（$renamedSkip）" Yellow
    } else {
        $readerState['R-renamed'].available = $true
        $readerState['R-renamed'].exe = $renamedExe
        $readerState['R-renamed'].version = $nodeVersion
        Write-Log "改名副本：$renamedExe（sha256 与 node.exe 相同：$renamedSameHash）"
    }

    $readerState['R-ps51'].available = $true
    $readerState['R-ps51'].exe = $psExe
    $readerState['R-ps51'].version = "$($PSVersionTable.PSVersion)"

    $pwsh7 = Find-Pwsh7
    if ($pwsh7) {
        $readerState['R-pwsh7'].available = $true
        $readerState['R-pwsh7'].exe = $pwsh7
        $readerState['R-pwsh7'].version = Get-FileVersion $pwsh7
    } else { $readerState['R-pwsh7'].skipReason = '没装 PowerShell 7' }

    $certutil = Join-Path $env:SystemRoot 'System32\certutil.exe'
    if (Test-Path -LiteralPath $certutil -PathType Leaf) {
        $readerState['R-certutil'].available = $true
        $readerState['R-certutil'].exe = $certutil
    } else { $readerState['R-certutil'].skipReason = "没有 $certutil" }

    $bash = Find-GitBash
    if ($bash) {
        $readerState['R-bash'].available = $true
        $readerState['R-bash'].exe = $bash
        $readerState['R-bash'].version = Get-FileVersion $bash
    } else { $readerState['R-bash'].skipReason = '没找到 Git Bash（可用 -GitBash 指定 bash.exe）' }

    $readerOrder = @($plan.readers | ForEach-Object { $readerState[$_.id] })
    foreach ($reader in $readerOrder) {
        Add-Record ([ordered]@{ type = 'reader'; id = $reader.id; available = $reader.available; exe = $reader.exe; version = $reader.version; skipReason = $(if ($reader.available) { $null } else { $reader.skipReason }) })
        if ($reader.available) { Write-Log "读者 $($reader.id)：$($reader.exe)" }
    }

    $runnerState = @{ node = $readerState['R-node']; electron = $readerState['R-electron']; renamed = $readerState['R-renamed'] }
    foreach ($writer in @($plan.writers)) {
        $available = $true
        $skipReason = $null
        if ($writer.runner -ne 'ps51' -and -not $runnerState[$writer.runner].available) {
            $available = $false
            $skipReason = $runnerState[$writer.runner].skipReason
        }
        Add-Record ([ordered]@{ type = 'writer'; id = $writer.id; available = $available; skipReason = $skipReason })
    }

    $kitInfo = $null
    $manifestFile = Join-Path $kit 'kit-manifest.json'
    if (Test-Path -LiteralPath $manifestFile) {
        try { $kitInfo = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestFile | ConvertFrom-Json } catch { }
    }
    $work = Join-Path $encFull "p113b-$stamp"
    Add-Record ([ordered]@{
            type = 'meta'; mode = 'field'; stamp = $stamp; startedAt = (Get-IsoNow)
            os = $osName; psVersion = "$($PSVersionTable.PSVersion)"; psExe = $psExe
            isAdmin = $isAdmin; enableLua = $enableLua
            appDir = $app; appVersion = $appVersion; nodeExe = $nodeExe; nodeVersion = $nodeVersion
            electronExe = $(if ($electronSkip) { $null } else { $electronExe }); electronVersion = $electronVersion
            electronNode = $electronNode; electronSkip = $electronSkip
            renamedExe = $(if ($renamedSkip) { $null } else { $renamedExe }); renamedSkip = $renamedSkip; renamedSameHash = $renamedSameHash
            encDir = $encFull; work = $work; kitDir = $kitFull; temp = $tempRoot; delaySeconds = $DelaySeconds; marker = $marker
            kit = $kitInfo
        })
    Write-Log "机器：$osName；管理员：$isAdmin；EnableLUA=$enableLua；应用版本 $appVersion"

    # ---- 2. inputs, written by PowerShell ----
    $inDir = Join-Path $work 'in'
    New-Item -ItemType Directory -Force -Path $inDir | Out-Null
    $inputItems = @(foreach ($item in @($plan.items)) {
            $path = Join-Path $inDir $item.name
            Set-Content -LiteralPath $path -Value $item.content -Encoding ASCII
            [pscustomobject]@{ key = $item.key; name = $item.name; path = $path }
        })
    Write-Log "已用 PowerShell 建好 $($inputItems.Count) 个输入：$inDir"

    # ---- 3. manual encryption ----
    $manual = [ordered]@{ type = 'manual'; requested = [bool]$ManualEncryption; confirmed = $false; confirmedAt = $null; note = $null; confirmationFile = $null }
    if ($ManualEncryption) {
        $confirmationFile = Join-Path $reportDir 'manual-encryption-confirmed.txt'
        $manual.confirmationFile = $confirmationFile
        Write-Utf8NoBom (Join-Path $reportDir 'manual-encryption-pending.json') (ConvertTo-Json -Depth 4 -InputObject ([ordered]@{
                    work = $work; inDir = $inDir; files = @($inputItems | ForEach-Object { $_.path }); confirmationFile = $confirmationFile
                }))
        Write-Log "等待人工加密。请用加密客户端把整个目录加密：$inDir" Cyan
        Get-ChildItem -LiteralPath $inDir -Force | ForEach-Object { Write-Host "    $($_.Name)" }
        Write-Log "加密完成后，新建 $confirmationFile，第一行写 CONFIRMED 继续（第二行起可写备注，如客户端提示哪些类型没加密）；第一行写 ABORT 放弃本轮。" Cyan
        $lastSeen = $null
        while ($true) {
            if (Test-Path -LiteralPath $confirmationFile) {
                $raw = "$(Get-Content -LiteralPath $confirmationFile -Raw -Encoding UTF8)"
                $lines = @($raw -split "`r?`n" | ForEach-Object { $_.Trim().TrimStart([char]0xFEFF) } | Where-Object { $_ -ne '' })
                $first = ''
                if ($lines.Count -gt 0) { $first = $lines[0] }
                if ($first -ieq 'CONFIRMED') {
                    $manual.confirmed = $true
                    $manual.confirmedAt = Get-IsoNow
                    if ($lines.Count -gt 1) { $manual.note = ($lines[1..($lines.Count - 1)] -join ' / ') }
                    Write-Log "人工已确认加密（$($manual.confirmedAt)）。"
                    break
                }
                if ($first -ieq 'ABORT') {
                    Add-Record $manual
                    throw 'P113B-ABORT'
                }
                if ($raw -ne $lastSeen) {
                    Write-Log '确认文件的第一行不是 CONFIRMED 或 ABORT，继续等待。' Yellow
                    $lastSeen = $raw
                }
            }
            Start-Sleep -Seconds 2
        }
    } else {
        Write-Log '没加 -ManualEncryption：输入是否已加密没有人工证据，报告里不会有「有效观察者」。' Yellow
    }
    Add-Record $manual

    # ---- 4. input pass ----
    Write-Log '读输入……'
    Invoke-ReadPass 'input' 'in' $inputItems

    # ---- 5. writers, each followed by an immediate pass ----
    $writerRuns = New-Object System.Collections.Generic.List[object]
    $lastWriteAt = $null
    foreach ($writer in @($plan.writers)) {
        if ($writer.runner -ne 'ps51' -and -not $runnerState[$writer.runner].available) {
            Write-Log "$($writer.id)：跳过（$($runnerState[$writer.runner].skipReason)）" Yellow
            continue
        }
        $writerRun = Invoke-Writer $writer $runnerState[$writer.runner]
        $writerRuns.Add($writerRun)
        $lastWriteAt = [DateTime]::UtcNow
        Invoke-ReadPass 'immediate' $writer.id $writerRun.items
    }

    # ---- 6. delayed pass, at least DelaySeconds after the last write ----
    if ($lastWriteAt) {
        while ($true) {
            $remaining = $DelaySeconds - ([DateTime]::UtcNow - $lastWriteAt).TotalSeconds
            if ($remaining -le 0) { break }
            Write-Log "延迟复读还要等 $([int][Math]::Ceiling($remaining)) 秒……"
            Start-Sleep -Milliseconds ([int]([Math]::Min(15, $remaining) * 1000))
        }
        foreach ($run in $writerRuns) { Invoke-ReadPass 'delayed' $run.id $run.items }
    }
} catch {
    $fatal = $_
    if ("$($_.Exception.Message)" -eq 'P113B-ABORT') {
        Write-Log '用户在确认文件里写了 ABORT，本轮放弃。' Yellow
        Add-Record ([ordered]@{ type = 'note'; level = 'abort'; text = '用户在人工加密确认时放弃了本轮。' })
    } else {
        Write-Log "出错：$($_.Exception.Message)（$($_.InvocationInfo.PositionMessage)）" Red
        Add-Record ([ordered]@{ type = 'note'; level = 'fatal'; text = "脚本出错：$($_.Exception.Message)" })
    }
} finally {
    # Remove the renamed copy and this run's %TEMP% directory; keep the work dir unless asked.
    $cleanup = [ordered]@{ type = 'cleanup'; renamedExe = '未创建'; tempRoot = '未创建'; work = '未创建' }
    if ($renamedExe) {
        for ($attempt = 0; $attempt -lt 5 -and (Test-Path -LiteralPath $renamedExe); $attempt++) {
            try { Remove-Item -LiteralPath $renamedExe -Force -ErrorAction Stop } catch { Start-Sleep -Seconds 1 }
        }
        if (Test-Path -LiteralPath $renamedExe) { $cleanup.renamedExe = "没删掉：$renamedExe" } else { $cleanup.renamedExe = '已删除' }
    }
    if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
        try { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction Stop } catch { }
        if (Test-Path -LiteralPath $tempRoot) { $cleanup.tempRoot = "没删掉：$tempRoot" } else { $cleanup.tempRoot = '已删除' }
    } elseif ($tempRoot) { $cleanup.tempRoot = '已删除' }
    if ($work -and (Test-Path -LiteralPath $work)) {
        if ($RemoveWork) {
            try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction Stop } catch { }
            if (Test-Path -LiteralPath $work) { $cleanup.work = "没删掉：$work" } else { $cleanup.work = '已删除（-RemoveWork）' }
        } else { $cleanup.work = "已保留：$work" }
    }
    Add-Record $cleanup
    Add-Record ([ordered]@{ type = 'meta'; finishedAt = (Get-IsoNow) })
    Write-Log "清理：改名副本 $($cleanup.renamedExe)；临时目录 $($cleanup.tempRoot)；工作目录 $($cleanup.work)"
}

# ---- 7. report ------------------------------------------------------------------------
$summary = Join-Path $reportDir 'summary.txt'
$reportRun = Invoke-Child -Exe $nodeExe -Arguments @($probe, 'report', '--out-dir', $reportDir) -Environment @{ NODE_OPTIONS = $null; ELECTRON_RUN_AS_NODE = $null } -StdIn ((($records.ToArray()) -join "`n") + "`n") -TimeoutSec 300
if (-not (Test-Path -LiteralPath $summary)) {
    $rawFile = Join-Path $reportDir 'raw-records.jsonl'
    Write-Utf8NoBom $rawFile ((($records.ToArray()) -join "`n") + "`n")
    Write-Log "生成报告失败：$(Get-RunFailure $reportRun)。原始记录已存到 $rawFile。" Red
} else {
    Write-Host ''
    Get-Content -LiteralPath $summary -Encoding UTF8 | Select-Object -First 80 | ForEach-Object { Write-Host $_ }
    Write-Host '……（完整内容见 summary.txt）'
    $head = New-Object byte[] 16
    $stream = [System.IO.File]::OpenRead($summary)
    try { $count = $stream.Read($head, 0, 16) } finally { $stream.Dispose() }
    if ($count -eq 16 -and $latin1.GetString($head) -eq $TsdMagic) {
        Write-Log "注意：PowerShell 看到 summary.txt 是 TSD 容器（$summary）。工具包目录受加密策略，请换目录重跑或走解密外发。" Yellow
    }
}
Write-Log "报告目录：$reportDir —— 请把整个目录发回。"
if ($fatal) { exit 1 }
