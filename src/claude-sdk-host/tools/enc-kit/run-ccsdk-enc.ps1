<#
.SYNOPSIS
    路线 B 加密机读写矩阵（Windows PowerShell 5.1 即可）。只连本机假网关，不联网，不调用真实模型，不需要 key。

.DESCRIPTION
    要弄清：路线 B 的 CLI 在加密机上，按不同的「出身」启动时，能不能读写加密文件、读回自己的对话记录。
    工具包是 npm 包：CLI 是官方 SDK 自带的 claude.exe。脚手架以 .txt 发来、本机还原；SDK 与 claude.exe 在本机 npm ci 安装。
    下文的「CLI」指 claude.exe。
    加密软件可能按进程树放行（例如 VS Code 在白名单里，它的子进程跟着被放行），所以同一套测试在三种出身下各跑一遍：
      inherit   从调用者继承：在 VS Code 里跑就挂在 VS Code 下，在开始菜单打开的 PowerShell 里跑就挂在资源管理器下；
      detached  经 WMI 另起，不挂在调用者下面（父进程是 WmiPrvSE），相当于没有任何白名单祖先；
      pilab     经 WMI 另起，再由 PiLab 自己的 exe（node 模式）启动 node 与 CLI，最接近产品（PiLab → node → CLI）。
    每个输出文件第一行记下实际的父进程链与会话号。
    0. 检查工具包自己：PowerShell 与随包 node 各看一遍哪些文件是密文；node 要加载的代码（.js/.mjs/.cjs/.ts/.json）读成密文就停下。
       还要先还原脚手架、npm ci，没做就停下并提示。
    1. 预检：随包 node.exe 版本；CLI 能不能启动；SHA256。
    2. 起本机假网关（127.0.0.1，扮演模型）。
    3. 每种出身：发消息、工具与审批卡、停止（停止后 sleep 进程应清零）；再重开同一会话续聊（读不读得回自己的对话记录）。
    4. 在工作目录 ccsdk-<时间>\samples 下由 PowerShell 建若干份样本（P1-13b 的 51 类，加 16 类 VS / MFC 工程文件），每轮矩阵一份。
    5. 加 -ManualEncryption 时暂停，等你用加密客户端把 samples 目录加密后确认。
    6. 读写矩阵：每种出身一轮（CLI 内置或自带的 rg），产品那一路（pilab，没有就 detached）再加一轮 PiLab 随包 rg.exe。
       每个样本：读、搜索、cat、sed、编辑、再读、新建、读新建的；之后由 node 与 PowerShell 5.1 检查落盘，-RecheckSeconds 秒后再查一次。
    7. 报告在本目录 report-ccsdk-<时间>\：summary.txt（每个样本一行的摘要，跑完也原样打印在屏幕上）、各步完整输出、run.log。
    加密策略是全局的，报告文件也可能被加密；读报告就看屏幕输出，或用随包 node 跑 kit-tools.mjs cat <文件>。

.PARAMETER EncDir
    工作目录（样本与工作区放这里）。不给就用工具包旁边的 ccsdk-work。
.PARAMETER AppDir
    已安装 PiLab 的目录（含 resources\node-runtime\node.exe）。不给就按默认安装位置和卸载注册表找。
.PARAMETER ManualEncryption
    建好样本后暂停，等人工加密并确认。正式上机必须加。
.PARAMETER ConfirmFile
    与 -ManualEncryption 合用，给 AI 驱动时用：不在窗口里问，改为写出 <报告目录>\WAITING-FOR-ENCRYPTION.txt，
    然后等 <报告目录>\manual-encryption-confirmed.txt 出现，第一行 CONFIRMED 继续、ABORT 放弃。
.PARAMETER Contexts
    要跑的出身，逗号分隔，默认 inherit,detached,pilab。没找到 PiLab 主程序时 pilab 自动跳过。
.PARAMETER RecheckSeconds
    落盘复查的延迟秒数，默认 300（P1-13b 实测读者视图约 260 秒后沉淀）。
.PARAMETER SkipFlow
    跳过第 3 步。
.PARAMETER SkipKitCheck
    第 0 步发现 node 要加载的文件是密文时照样往下跑（多半会失败）。
.PARAMETER GitBash
    Git Bash 的 bash.exe。不给就找默认安装位置和 PATH。
.PARAMETER Node
    开发机空跑用：指定 node.exe，代替 PiLab 随包的。
.PARAMETER RgDir
    开发机空跑用：指定放 rg.exe 的目录，代替 PiLab 随包的。
.PARAMETER Electron
    开发机空跑用：指定一个 Electron 程序（node 模式）代替 PiLab 主程序，用来跑出身 pilab 的启动路径。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\ccsdk\ccsdk-enc-kit\run-ccsdk-enc.ps1 -ManualEncryption
#>
[CmdletBinding()]
param(
    [string]$EncDir = '',
    [string]$AppDir = '',
    [switch]$ManualEncryption,
    [switch]$ConfirmFile,
    [string]$Contexts = 'inherit,detached,pilab',
    [ValidateRange(0, 3600)][int]$RecheckSeconds = 300,
    [switch]$SkipFlow,
    [switch]$SkipKitCheck,
    [string]$GitBash = '',
    [string]$Node = '',
    [string]$RgDir = '',
    [string]$Electron = '',
    [int]$Port = 18932,
    # Internal: the detached child mode (the script re-launched through WMI).
    [string]$Internal = '',
    [string]$SpecB64 = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Process chain of this PowerShell, e.g. "powershell.exe <- WmiPrvSE.exe <- svchost.exe", and its session.
function Get-Ancestry {
    $names = New-Object System.Collections.Generic.List[string]
    try {
        $id = $PID
        for ($i = 0; $i -lt 12 -and $id; $i++) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop
            if (-not $process) { break }
            $names.Add("$($process.Name)")
            $id = $process.ParentProcessId
        }
    } catch { $names.Add('(查不到)') }
    $session = '?'
    try { $session = "$((Get-Process -Id $PID).SessionId)" } catch { }
    return "$($names -join ' <- ')；会话 $session"
}

# Append to a file another process may be reading (the parent polls detached output, and
# the encryption agent can hold files briefly): retry on a sharing violation.
function Add-Line([string]$Path, [string]$Text) {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try { [System.IO.File]::AppendAllText($Path, "$Text`r`n", $utf8NoBom); return }
        catch [System.IO.IOException] { Start-Sleep -Milliseconds 50 }
    }
}

# Complete lines of a file another process may be appending to (shared read, retried);
# a trailing partial line is left for the next read. $null when it stays locked.
function Read-SharedLines([string]$Path) {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
            try { $text = (New-Object System.IO.StreamReader($stream, $utf8NoBom)).ReadToEnd() }
            finally { $stream.Dispose() }
            $lines = @($text -split "`r?`n")
            if ($lines.Count -le 1) { return @() }
            return @($lines[0..($lines.Count - 2)])
        } catch [System.IO.IOException] { Start-Sleep -Milliseconds 200 }
    }
    return $null
}

# ---- detached child mode: run one command from a spec, output to a file ----
if ($Internal -eq 'run') {
    $spec = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SpecB64)))
    foreach ($property in $spec.env.PSObject.Properties) {
        [Environment]::SetEnvironmentVariable($property.Name, $property.Value, 'Process')
    }
    Add-Line $spec.out "出身 $($spec.context)：$(Get-Ancestry)"
    Set-Location -LiteralPath $spec.cwd
    $ErrorActionPreference = 'Continue'
    $commandArgs = @($spec.args)
    & $spec.exe @commandArgs 2>&1 | ForEach-Object { Add-Line $spec.out "$_" }
    $code = $LASTEXITCODE
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try { [System.IO.File]::WriteAllText("$($spec.out).exit", "$code", $utf8NoBom); break }
        catch [System.IO.IOException] { Start-Sleep -Milliseconds 50 }
    }
    exit 0
}

$kit = $PSScriptRoot
$app = Join-Path $kit 'app'
# Host .ts as is, scaffolds restored from .txt, SDK + claude.exe from a local npm ci.
$hostDir = Join-Path $app 'src\claude-sdk-host'
$probe = Join-Path $hostDir 'tools\host-probe.ts'
$kitTools = Join-Path $kit 'kit-tools.mjs'
$gateway = Join-Path $app 'src\dsh-host\tools\fake-gateway.mjs'
$planProbe = Join-Path $app 'src\dsh-host\tools\p1-13b\matrix-probe.mjs'
$cliPath = Join-Path $hostDir 'node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
$cliLabel = 'claude.exe'
$psExe = (Get-Process -Id $PID).Path

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = Join-Path $kit "report-ccsdk-$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
$logFile = Join-Path $reportDir 'run.log'
$summaryFile = Join-Path $reportDir 'summary.txt'
$summary = New-Object System.Collections.Generic.List[string]

function Write-Log([string]$Text, [string]$Color = '') {
    if ($Color) { Write-Host "[ccsdk-enc] $Text" -ForegroundColor $Color } else { Write-Host "[ccsdk-enc] $Text" }
    [System.IO.File]::AppendAllText($logFile, "[$((Get-Date).ToString('HH:mm:ss'))] $Text`r`n", $utf8Bom)
}

function Add-Summary([string]$Text) { $summary.Add($Text) }

function Save-Summary {
    [System.IO.File]::WriteAllText($summaryFile, (($summary.ToArray()) -join "`r`n") + "`r`n", $utf8Bom)
}

function Find-AppDir {
    if ($AppDir -ne '') { return $AppDir }
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('PiLab Ai', 'PiLabAi', 'jyw-ai-client', 'AiClient')) {
        if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\$name")) }
        if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles $name)) }
    }
    foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        Get-ItemProperty -Path $key -ErrorAction SilentlyContinue | ForEach-Object {
            $names = $_.PSObject.Properties.Name
            if (($names -contains 'DisplayName') -and ("$($_.DisplayName)" -like 'PiLab*')) {
                # electron-builder's NSIS entry can leave InstallLocation empty; DisplayIcon
                # ("...\PiLabAi.exe,0") and UninstallString ("...\Uninstall PiLabAi.exe" /allusers) still point at it.
                if ($names -contains 'InstallLocation') { $candidates.Add("$($_.InstallLocation)") }
                foreach ($field in @('DisplayIcon', 'UninstallString')) {
                    if ($names -notcontains $field) { continue }
                    $value = "$($_.$field)"
                    if ($value -match '^\s*"([^"]+)"') { $exePath = $Matches[1] } else { $exePath = ($value -split ',')[0].Trim() }
                    if ($exePath) { $candidates.Add((Split-Path $exePath -Parent)) }
                }
            }
        }
    }
    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path -LiteralPath (Join-Path $dir 'resources\node-runtime\node.exe'))) { return $dir }
    }
    return $null
}

# The app's Electron exe in AppDir's root (electron-builder's executableName, older names,
# else the only non-uninstaller exe next to resources\app.asar).
function Find-ElectronExe([string]$App) {
    if (-not $App) { return $null }
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
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        # <root>\cmd\git.exe, <root>\bin\git.exe, <root>\mingw64\bin\git.exe
        $dir = Split-Path $git.Source -Parent
        $root = Split-Path $dir -Parent
        if ($dir -match '\\(mingw64|usr)\\bin$') { $root = Split-Path $root -Parent }
        $candidates.Add((Join-Path $root 'bin\bash.exe'))
    }
    foreach ($path in $candidates) { if (Test-Path -LiteralPath $path -PathType Leaf) { return $path } }
    return $null
}

function Get-Sha256([string]$Path) {
    # Get-FileHash was missing on the encrypted machine in P1-13b; plain .NET instead.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $stream.Dispose(); $sha.Dispose() }
}

# First bytes of a file as this PowerShell reads them, '' when it cannot be read.
function Get-Head([string]$Path, [int]$Count = 16) {
    try {
        $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $buffer = New-Object byte[] $Count
            $read = $stream.Read($buffer, 0, $Count)
            return [System.Text.Encoding]::GetEncoding(28591).GetString($buffer, 0, $read)
        } finally { $stream.Dispose() }
    } catch { return '' }
}

<#
    The kit's own files are subject to the same global policy: files unpacked from a
    foreign zip get encrypted. This is PowerShell's view, recorded as a fact; whether the
    run can go on is node's view (kit-tools tree), because node is what loads the code
    and P1-13b showed the two readers differ by type (node decrypts .js, not .mjs).
#>
function Test-KitFiles {
    $files = @(Get-ChildItem -LiteralPath $kit -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notlike (Join-Path $kit 'report-ccsdk-*') })
    $encrypted = New-Object System.Collections.Generic.List[string]
    foreach ($file in $files) {
        if ((Get-Head $file.FullName).StartsWith('%TSD-Header')) {
            $encrypted.Add($file.FullName.Substring($kit.Length).TrimStart('\'))
        }
    }
    return [pscustomobject]@{ total = $files.Count; encrypted = $encrypted }
}

# Run node in this process tree, live output to the window and <report>\<Name>.txt.
# Environment entries are set for the call only; $null removes one.
function Invoke-Inherit([string]$Name, [string[]]$Arguments, [hashtable]$Environment) {
    $out = Join-Path $reportDir "$Name.txt"
    Add-Line $out "出身 inherit：$(Get-Ancestry)"
    $saved = @{}
    foreach ($key in @($Environment.Keys)) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $Environment[$key], 'Process')
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $code = $null
    Push-Location $hostDir
    try {
        & $nodeExe @Arguments 2>&1 | ForEach-Object {
            $line = "$_"
            Write-Host $line
            Add-Line $out $line
        }
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $previous
        foreach ($key in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    }
    return $code
}

# Run node outside this process tree: this script re-launched through WMI (parent WmiPrvSE).
# Context 'pilab' puts the app's Electron exe (node mode) between that and node.
function Invoke-Detached([string]$Name, [string]$Context, [string[]]$Arguments, [hashtable]$Environment) {
    $out = Join-Path $reportDir "$Name.txt"
    $envTable = @{}
    foreach ($key in @('PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS')) {
        $value = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ($null -ne $value) { $envTable[$key] = $value }
    }
    foreach ($key in @($Environment.Keys)) { $envTable[$key] = $Environment[$key] }
    $exe = $nodeExe
    $commandArgs = $Arguments
    if ($Context -eq 'pilab') {
        $exe = $electronExe
        $commandArgs = @($kitTools, 'spawn', $nodeExe) + $Arguments
        $envTable['ELECTRON_RUN_AS_NODE'] = '1'
    }
    $spec = [ordered]@{ context = $Context; exe = $exe; args = $commandArgs; env = $envTable; out = $out; cwd = $hostDir }
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Depth 4 -Compress $spec)))
    $commandLine = "`"$psExe`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Internal run -SpecB64 $b64"
    $childId = $null
    try {
        $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $hostDir }
        if ($result.ReturnValue -eq 0) { $childId = [int]$result.ProcessId }
        else { Write-Log "WMI 启动返回 $($result.ReturnValue)（$Name）" Yellow }
    } catch {
        Write-Log "WMI 启动失败（$Name）：$($_.Exception.Message)" Yellow
    }
    if ($null -eq $childId) { return 'launch-failed' }
    $shown = 0
    $deadline = (Get-Date).AddMinutes(90)
    while ((Get-Process -Id $childId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if (Test-Path -LiteralPath $out) {
            $lines = Read-SharedLines $out
            if ($null -ne $lines) {
                for ($i = $shown; $i -lt $lines.Count; $i++) { Write-Host $lines[$i] }
                $shown = [Math]::Max($shown, $lines.Count)
            }
        }
    }
    if (Get-Process -Id $childId -ErrorAction SilentlyContinue) {
        Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
        return 'timeout'
    }
    if (Test-Path -LiteralPath $out) {
        $lines = Read-SharedLines $out
        if ($null -ne $lines) { for ($i = $shown; $i -lt $lines.Count; $i++) { Write-Host $lines[$i] } }
    }
    $exitFile = "$out.exit"
    for ($attempt = 0; $attempt -lt 10 -and (Test-Path -LiteralPath $exitFile); $attempt++) {
        try { return "$([System.IO.File]::ReadAllText($exitFile))".Trim() }
        catch [System.IO.IOException] { Start-Sleep -Milliseconds 200 }
    }
    return 'no-exit-code'
}

function Invoke-Probe([string]$Name, [string]$Context, [string[]]$Arguments, [hashtable]$Environment) {
    if ($Context -eq 'inherit') { return Invoke-Inherit $Name $Arguments $Environment }
    return Invoke-Detached $Name $Context $Arguments $Environment
}

# Run node and return its last JSON line, parsed (or $null).
function Invoke-NodeJson([string[]]$Arguments, [hashtable]$Environment = @{}) {
    $saved = @{}
    foreach ($key in @($Environment.Keys)) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $Environment[$key], 'Process')
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $nodeExe @Arguments 2>$null)
    } finally {
        $ErrorActionPreference = $previous
        foreach ($key in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
    }
    $json = @($lines | Where-Object { "$_".StartsWith('{') } | Select-Object -Last 1)
    if ($json.Count -eq 0) { return $null }
    try { return ConvertFrom-Json "$($json[0])" } catch { return $null }
}

function Invoke-NodeLines([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return @(& $nodeExe @Arguments 2>&1 | ForEach-Object { "$_" }) }
    finally { $ErrorActionPreference = $previous }
}

# Lines of a report file that match any of the patterns.
function Select-Lines([string]$Name, [string[]]$Patterns) {
    $file = Join-Path $reportDir "$Name.txt"
    if (-not (Test-Path -LiteralPath $file)) { return @('（没有输出）') }
    $lines = Read-SharedLines $file
    if ($null -eq $lines) { return @('（输出文件读不了：被占用）') }
    return @($lines | Where-Object { $line = $_; @($Patterns | Where-Object { $line -match $_ }).Count -gt 0 })
}

$gwProcess = $null
$tempRoot = Join-Path $env:TEMP "ccsdk-$stamp"
try {
    # ---- 0. the kit's own files ----
    Write-Log "工具包 $kit（npm 包）；报告目录 $reportDir"
    Add-Summary "路线 B 加密机读写矩阵  $stamp（npm 包，CLI：$cliLabel）"
    Add-Summary ''
    $appFound = Find-AppDir
    if ($Node -ne '') { $nodeExe = $Node }
    elseif ($appFound) { $nodeExe = Join-Path $appFound 'resources\node-runtime\node.exe' }
    else {
        Write-Log '没找到已安装的 PiLab（resources\node-runtime\node.exe）。请用 -AppDir 指定安装目录后重跑。' Red
        exit 1
    }

    # The scaffolds come as .txt and must be restored on this machine; the SDK and
    # claude.exe come from npm ci here (README.txt 第 1、2 步).
    $missing = @(@($kitTools, $gateway, $planProbe, $probe) | Where-Object { -not (Test-Path -LiteralPath $_) })
    if ($missing.Count -gt 0) {
        Write-Log '脚手架还没还原（scaffold\*.txt → 目标路径），缺：' Red
        foreach ($file in $missing) { Write-Host "    $file" }
        Write-Log '按 README.txt 第 1 步还原后重跑。' Cyan
        Add-Summary '== 没开始跑：脚手架没还原'
        Save-Summary
        exit 5
    }
    $sdkEntry = Join-Path $hostDir 'node_modules\@anthropic-ai\claude-agent-sdk\sdk.mjs'
    if (-not (Test-Path -LiteralPath $sdkEntry) -or -not (Test-Path -LiteralPath $cliPath)) {
        Write-Log "还没在 $hostDir 里 npm ci（缺 SDK 或 claude.exe）。按 README.txt 第 2 步装好后重跑。" Red
        Add-Summary '== 没开始跑：没有 npm ci'
        Save-Summary
        exit 5
    }

    Write-Log '第 0 步：PowerShell 与随包 node 各看一遍工具包自己的文件…'
    $kitCheck = Test-KitFiles
    $nodeView = Invoke-NodeJson @($kitTools, 'tree', $kit, 'report-ccsdk-')
    [System.IO.File]::WriteAllText((Join-Path $reportDir 'kit-encrypted.txt'), "PowerShell 读成密文的文件：`r`n$(($kitCheck.encrypted) -join "`r`n")`r`n`r`nnode 读成密文、且 node 要加载的文件：`r`n$(if ($nodeView) { ($nodeView.loadable) -join "`r`n" } else { '（kit-tools 没跑起来）' })`r`n", $utf8NoBom)
    Add-Summary '== 第 0 步：工具包自己的文件'
    Add-Summary "  PowerShell 看：$($kitCheck.total) 个文件，TSD 密文 $($kitCheck.encrypted.Count) 个"
    if (-not $nodeView) {
        $raw = @(Invoke-NodeLines @($kitTools, 'tree', $kit, 'report-ccsdk-') | Select-Object -First 6)
        Write-Log "随包 node 连 $(Split-Path $kitTools -Leaf) 都加载不了，后面全部跑不起来：" Red
        foreach ($line in $raw) { Write-Host "    $line" }
        Add-Summary "  node 看：加载 $(Split-Path $kitTools -Leaf) 失败（$($raw -join ' / ')）"
        Add-Summary '  这是现场事实：node 读不了解压出来的这个文件。'
        Save-Summary
        if (-not $SkipKitCheck) { exit 4 }
    } else {
        Add-Summary "  node 看：$($nodeView.total) 个文件，TSD 密文 $($nodeView.tsd) 个，按类型 $(ConvertTo-Json -Compress $nodeView.encryptedTypes)"
        Add-Summary "  其中 node 要加载、却读成密文的：$($nodeView.loadableTsd) 个"
        if ($nodeView.loadableTsd -gt 0) {
            Write-Log "node 要加载的文件里有 $($nodeView.loadableTsd) 个读成密文，照这样跑不起来：" Red
            foreach ($name in @($nodeView.loadable | Select-Object -First 15)) { Write-Host "    $name" }
            Write-Log "清单见 $(Join-Path $reportDir 'kit-encrypted.txt')。这本身是现场事实，请写进结论。" Cyan
            Write-Log '需要跳过这一步硬跑（多半会失败），加 -SkipKitCheck。' Cyan
            Save-Summary
            if (-not $SkipKitCheck) { exit 4 }
            Write-Log '已加 -SkipKitCheck，继续。' Yellow
        } else {
            Write-Log "工具包 $($nodeView.total) 个文件：PowerShell 看到密文 $($kitCheck.encrypted.Count) 个，node 看到 $($nodeView.tsd) 个，node 要加载的都是明文。"
        }
    }
    Add-Summary ''

    # ---- 1. locate and preflight ----
    $electronExe = $(if ($Electron -ne '') { $Electron } else { Find-ElectronExe $appFound })
    if ($RgDir -eq '' -and $appFound) {
        $RgDir = Join-Path $appFound 'resources\app.asar.unpacked\node_modules\@vscode\ripgrep\bin'
        if (-not (Test-Path -LiteralPath (Join-Path $RgDir 'rg.exe'))) {
            $found = @(Get-ChildItem -LiteralPath (Join-Path $appFound 'resources') -Recurse -Filter 'rg.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($found.Count -gt 0) { $RgDir = $found[0].DirectoryName }
        }
    }
    $rgExe = Join-Path $RgDir 'rg.exe'
    $bash = Find-GitBash
    if ($EncDir -eq '') { $EncDir = Join-Path (Split-Path $kit -Parent) 'ccsdk-work' }
    New-Item -ItemType Directory -Force -Path $EncDir | Out-Null
    $encFull = (Resolve-Path -LiteralPath $EncDir).Path
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $nodeVersion = "$(& $nodeExe --version)"
    $manifest = $null
    try { $manifest = Get-Content -LiteralPath (Join-Path $kit 'kit-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }

    $wanted = @($Contexts -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $contextList = New-Object System.Collections.Generic.List[string]
    foreach ($context in $wanted) {
        if ($context -notin @('inherit', 'detached', 'pilab')) { Write-Log "不认识的出身 $context，跳过。" Yellow; continue }
        if ($context -eq 'pilab' -and -not $electronExe) { Write-Log '没找到 PiLab 主程序，跳过出身 pilab。' Yellow; continue }
        $contextList.Add($context)
    }

    Add-Summary '== 环境'
    if ($manifest) { Add-Summary "  工具包：$($manifest.kit)，提交 $($manifest.commit)，SDK $($manifest.sdkVersion)，CLI $($manifest.cli)，打包于 $($manifest.builtAt)" }
    Add-Summary "  PiLab：$appFound；主程序 $electronExe"
    Add-Summary "  node：$nodeExe（$nodeVersion）"
    Add-Summary "  Git Bash：$bash"
    Add-Summary "  随包 rg：$rgExe（存在：$(Test-Path -LiteralPath $rgExe)）"
    Add-Summary "  管理员：$isAdmin"
    Add-Summary "  本脚本的出身：$(Get-Ancestry)"
    Add-Summary "  要跑的出身：$($contextList -join ', ')"

    $hash = Get-Sha256 $cliPath
    Add-Summary "  $(Split-Path $cliPath -Leaf) SHA256：$hash"
    $cliVersion = ''
    $cliError = ''
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $cliVersion = "$(& $cliPath --version 2>&1)"
        if ($LASTEXITCODE -ne 0) { $cliError = "退出码 $LASTEXITCODE" }
    } catch {
        $cliError = $_.Exception.Message
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($cliError -ne '') {
        Write-Log "$cliLabel 启动失败：$cliError $cliVersion" Red
        Add-Summary "  $cliLabel 启动：失败（$cliError）$cliVersion"
        Add-Summary ''
        Add-Summary "结论：$cliLabel 在这台机器上起不来（多半是程序白名单，看上面的输出）。后面的步骤没有跑。"
        Save-Summary
        exit 2
    }
    Write-Log "$cliLabel 能启动：$cliVersion"
    Add-Summary "  $cliLabel 启动：成功（$cliVersion）"
    if (-not $bash) { Write-Log '没找到 Git Bash：CLI 会改用 PowerShell 工具，cat / sed 两格会不同。' Yellow }

    # ---- 2. fake gateway ----
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $capDir = Join-Path $tempRoot 'capture'
    $gwOut = Join-Path $reportDir 'gateway.out.txt'
    $gwErr = Join-Path $reportDir 'gateway.err.txt'
    $gwArgs = "`"$gateway`" --port $Port --plan claude-sdk --reset --model-id claude-opus-5-5 --state `"$(Join-Path $tempRoot 'state.json')`" --capture `"$capDir`""
    $gwProcess = Start-Process -FilePath $nodeExe -ArgumentList $gwArgs -RedirectStandardOutput $gwOut -RedirectStandardError $gwErr -NoNewWindow -PassThru
    $listening = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if ((Test-Path -LiteralPath $gwOut) -and ("$(Get-Content -LiteralPath $gwOut -Raw -ErrorAction SilentlyContinue)" -match 'listening')) { $listening = $true; break }
        if ($gwProcess.HasExited) { break }
    }
    if (-not $listening) {
        Write-Log "假网关没起来，看 $gwErr（端口 $Port 被占用时用 -Port 换一个）。" Red
        exit 1
    }
    $gatewayUrl = "http://127.0.0.1:$Port"
    Write-Log "假网关：$gatewayUrl"

    $work = Join-Path $encFull "ccsdk-$stamp"
    $ws = Join-Path $work 'ws'
    New-Item -ItemType Directory -Force -Path $ws | Out-Null
    $configRoot = Join-Path $env:USERPROFILE ".pilab\ccsdk-probe-$stamp"
    # The host finds Git Bash from PATH (a dir holding git.exe or bash.exe), then Program Files.
    $basePath = $env:PATH
    if ($bash) { $basePath = "$(Split-Path $bash -Parent);$env:PATH" }
    $baseEnv = @{ PATH = $basePath; PROBE_VERBOSE = '1' }

    # ---- 3. flow, stop, resume: once per context ----
    if (-not $SkipFlow) {
        foreach ($context in $contextList) {
            Write-Log "第 3 步（出身 $context）：发消息、工具与审批卡、停止（约 2 分钟）。"
            $envFlow = $baseEnv.Clone()
            $envFlow['PROBE_CONFIG_DIR'] = Join-Path $configRoot "flow-$context"
            New-Item -ItemType Directory -Force -Path $envFlow['PROBE_CONFIG_DIR'] | Out-Null
            $code = Invoke-Probe "flow-$context" $context @($probe, $gatewayUrl, $ws, 'text', 'tools', 'stop') $envFlow
            Add-Summary ''
            Add-Summary "== 流程（出身 $context，退出码 $code）"
            foreach ($line in (Select-Lines "flow-$context" @('^出身', '\[host\].*start pid=', '^=== ', 'session\.(completed|stopped|failed)', '^\s+card:', 'stop →', 'sleep processes', '\[check\] FAIL', '^PROBE CHECKS'))) { Add-Summary "  $line" }
            $last = @(Select-Lines "flow-$context" @('^disposed; sessionFile=')) | Select-Object -Last 1
            if ("$last" -match 'sessionFile=(.+); configDir=(.+)$') {
                Write-Log "第 3 步续（出身 $context）：重开同一会话续聊。"
                $envResume = $envFlow.Clone()
                $envResume['PROBE_SESSION_FILE'] = $Matches[1].Trim()
                $code = Invoke-Probe "resume-$context" $context @($probe, $gatewayUrl, $ws, 'history', 'text', 'history') $envResume
                $cap = Invoke-NodeJson @($kitTools, 'capture', $capDir)
                Add-Summary "== 重开续聊（出身 $context，退出码 $code）"
                foreach ($line in (Select-Lines "resume-$context" @('^=== ', 'session\.(completed|stopped|failed)', '\[check\] FAIL', '^PROBE CHECKS'))) { Add-Summary "  $line" }
                Add-Summary "  最后一次请求：$(if ($cap) { ConvertTo-Json -Compress $cap } else { '（读不到抓包）' })"
            } else {
                Add-Summary '  没拿到 sessionFile，跳过重开续聊。'
            }
            Save-Summary
        }
    }

    # ---- 4. samples, written by PowerShell: one copy per matrix round ----
    $rounds = New-Object System.Collections.Generic.List[object]
    foreach ($context in $contextList) { $rounds.Add(@{ context = $context; rg = $null; tag = 'builtin-rg' }) }
    $productContext = $null
    if ($contextList -contains 'pilab') { $productContext = 'pilab' } elseif ($contextList -contains 'detached') { $productContext = 'detached' } elseif ($contextList.Count -gt 0) { $productContext = $contextList[0] }
    if ($productContext) { $rounds.Add(@{ context = $productContext; rg = $RgDir; tag = 'bundled-rg' }) }

    $plan = Invoke-NodeJson @($planProbe, 'plan') @{ P113B_REQUEST = '{}' }
    if (-not $plan -or -not $plan.ok) {
        Write-Log '取样本清单失败。' Red
        exit 1
    }
    $marker = "$($plan.marker)"
    # On top of P1-13b's 51:
    #   VS / MFC project files — users met FS_ENCRYPTED on .vcxproj;
    #   binaries and archives — P1-13b never covered them, and they decide whether the kit's
    #   own claude.exe, .node addons and zip survive being unpacked here.
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($item in @($plan.items)) { $items.Add($item) }
    foreach ($ext in @('vcxproj', 'vcxproj.filters', 'vcxproj.user', 'vcproj', 'sln', 'props', 'targets', 'rc', 'rc2', 'def', 'idl', 'manifest', 'csproj', 'resx', 'dsp', 'dsw')) {
        $items.Add([pscustomobject]@{ key = $ext; name = "ccsdk-vs.$ext"; content = "$marker $ext plaintext line" })
    }
    foreach ($ext in @('exe', 'dll', 'node', 'zip', 'asar', 'pdb', 'lib', 'obj')) {
        $items.Add([pscustomobject]@{ key = $ext; name = "ccsdk-bin.$ext"; content = "$marker $ext plaintext line" })
    }
    $samples = Join-Path $work 'samples'
    for ($r = 0; $r -lt $rounds.Count; $r++) {
        $dir = Join-Path $samples "enc-$($r + 1)"
        $rounds[$r]['dir'] = $dir
        $rounds[$r]['name'] = "enc-$($r + 1)-$($rounds[$r].context)-$($rounds[$r].tag)"
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        foreach ($item in $items) {
            Set-Content -LiteralPath (Join-Path $dir $item.name) -Value $item.content -Encoding ASCII
        }
    }
    Write-Log "已用 PowerShell 建好 $($rounds.Count) 份样本，各 $($items.Count) 个：$samples"

    # ---- 5. manual encryption ----
    Add-Summary ''
    Add-Summary '== 样本'
    Add-Summary "  目录：$samples（$($rounds.Count) 份，每份 $($items.Count) 个）"
    if ($ManualEncryption) {
        Write-Host ''
        Write-Log "请用加密客户端把这个目录加密（含其下 enc-* 子目录里的全部文件）：" Cyan
        Write-Log "    $samples" Cyan
        if ($ConfirmFile) {
            $confirmation = Join-Path $reportDir 'manual-encryption-confirmed.txt'
            $waiting = Join-Path $reportDir 'WAITING-FOR-ENCRYPTION.txt'
            [System.IO.File]::WriteAllText($waiting, "samples=$samples`r`nconfirm=$confirmation`r`n", $utf8NoBom)
            Write-Log "加密完成后，新建 $confirmation，第一行写 CONFIRMED 继续；写 ABORT 放弃。" Cyan
            while ($true) {
                Start-Sleep -Seconds 2
                if (-not (Test-Path -LiteralPath $confirmation)) { continue }
                $first = "$(@(Get-Content -LiteralPath $confirmation -Encoding UTF8 | Where-Object { "$_".Trim() -ne '' } | Select-Object -First 1))".Trim().TrimStart([char]0xFEFF)
                if ($first -ieq 'CONFIRMED') { break }
                if ($first -ieq 'ABORT') { Remove-Item -LiteralPath $waiting -Force; Add-Summary '  人工加密：放弃'; Save-Summary; exit 3 }
            }
            Remove-Item -LiteralPath $waiting -Force -ErrorAction SilentlyContinue
        } else {
            Write-Log '加密完成后回到这个窗口，输入 CONFIRMED 回车继续；输入 ABORT 放弃。' Cyan
            while ($true) {
                $answer = "$(Read-Host '输入 CONFIRMED 或 ABORT')".Trim()
                if ($answer -ieq 'CONFIRMED') { break }
                if ($answer -ieq 'ABORT') { Add-Summary '  人工加密：放弃'; Save-Summary; exit 3 }
            }
        }
        Write-Log '已确认加密，继续。'
        Add-Summary "  人工加密：已确认（$((Get-Date).ToString('HH:mm:ss'))）"
    } else {
        Write-Log '没加 -ManualEncryption：样本是否已加密没有人工确认。' Yellow
        Add-Summary '  人工加密：没做（没加 -ManualEncryption）'
    }
    foreach ($round in $rounds) {
        $view = Invoke-NodeJson @($kitTools, 'heads', $round.dir, $marker)
        if ($view) { Add-Summary "  node 看 $(Split-Path $round.dir -Leaf)：$(ConvertTo-Json -Compress $view.counts)" }
    }
    Save-Summary

    # ---- 6. read / write matrix ----
    foreach ($round in $rounds) {
        if ($round.rg -and -not (Test-Path -LiteralPath $rgExe)) {
            Write-Log "没找到随包 rg.exe（$rgExe），跳过 $($round.name)。" Yellow
            Add-Summary ''
            Add-Summary "== $($round.name)：跳过（没找到 $rgExe）"
            continue
        }
        Write-Log "第 6 步：$($round.name)，约 4 分钟，再等 $RecheckSeconds 秒复查落盘。"
        $envEnc = $baseEnv.Clone()
        $envEnc['PROBE_CONFIG_DIR'] = Join-Path $configRoot $round.name
        $envEnc['PROBE_ENC_DIR'] = $round.dir
        $envEnc['PROBE_ENC_MARKER'] = $marker
        $envEnc['PROBE_ENC_RECHECK_S'] = "$RecheckSeconds"
        $envEnc['AICLIENT_CLAUDE_SDK_RG_DIR'] = $round.rg
        New-Item -ItemType Directory -Force -Path $envEnc['PROBE_CONFIG_DIR'] | Out-Null
        $code = Invoke-Probe $round.name $round.context @($probe, $gatewayUrl, $ws, 'enc') $envEnc
        Add-Summary ''
        Add-Summary "== $($round.name)（退出码 $code）"
        foreach ($line in (Select-Lines $round.name @('^出身', '\[host\].*start pid=', '\[check\] FAIL', '^PROBE CHECKS'))) { Add-Summary "  $line" }
        foreach ($line in (Invoke-NodeLines @($kitTools, 'digest', (Join-Path $reportDir "$($round.name).txt")))) { Add-Summary $line }
        Save-Summary
    }

    Add-Summary ''
    Add-Summary '== 还要人做'
    Add-Summary "  用加密客户端看 $samples 下 enc-*\ccsdk-written-* 里的新文件是否被加密，结果写进 $reportDir\notes.txt。"
    Add-Summary "  CLI 的配置与对话记录留在 $configRoot（不含任何凭据），结论写完后可以删。"
    Save-Summary
    Write-Host ''
    Write-Host '===== SUMMARY BEGIN ====='
    foreach ($line in $summary) { Write-Host $line }
    Write-Host '===== SUMMARY END ====='
    Write-Log "跑完了。报告目录：$reportDir" Green
    Write-Log "新文件还要用加密客户端确认：$samples 下 enc-*\ccsdk-written-* 目录。" Green
} finally {
    if ($gwProcess -and -not $gwProcess.HasExited) { Stop-Process -Id $gwProcess.Id -Force -ErrorAction SilentlyContinue }
    # The capture holds full requests (sample contents included); the summary keeps only counts.
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    Save-Summary
}
