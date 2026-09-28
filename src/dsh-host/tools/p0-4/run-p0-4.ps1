<#
.SYNOPSIS
    dsh-rebase P0-4 加密机一键检查（Windows PowerShell 5.1 即可，不需要管理员）。

.DESCRIPTION
    1. 找到已安装应用的 resources\node-runtime\node.exe（白名单载体）。
    2. 在 -EncDir（受加密策略的目录）下建一个临时工作目录，用 PowerShell 写标记文件，
       并读文件头看它们是不是 TSD 容器（自动前提）。PowerShell 可能被透明解密，
       看不到 TSD 头不代表没加密；加 -ManualEncryption 时以人工确认为准。
    3. 用 node.exe 跑 host\tools\p0-4-probe.ts：DSH 宿主启动（NARB 缓存三种）、
       read / write / edit / grep / glob、pwsh 工具（沙箱开 / 关）、会话写锁与恢复、
       node-pty、%TEMP% spill、预装插件、Git Bash / PowerShell 直接读写。
       模型回合只打到脚本自己起的本地假网关，不连任何真实模型服务。
    4. PowerShell 逐个读探针列出文件的头 16 字节（PowerShell 的读取视图，可能已被透明解密）。
    5. 删除工作目录和探针在 %TEMP% / %LOCALAPPDATA% 新建的目录，只留报告。
    6. 报告在本目录 report-<时间>\ 下：p0-4-report.json、p0-4-summary.txt、p0-4-probe.log。

.PARAMETER ControlGroup
    对照组：不跑我方宿主，改为临时把官方 DSH Desktop 的模型指向本地假网关（改写
    DSH Desktop 的 DSH_HOME 下的 cordis.patch.yml 与 .env，结束时还原），由用户在
    DSH Desktop 里粘贴同一句 P0-FS 提示，脚本按同样的判据出报告。

.PARAMETER DshDesktopHome
    对照组改写的目录。默认 %APPDATA%\dsh-desktop\harness（DSH Desktop 日志里 DSH_HOME= 那一行）。

.PARAMETER ManualEncryption
    建好标记文件后暂停，等用户用加密客户端把它们加密，并在报告目录的
    manual-encryption-confirmed.txt 里写 CONFIRMED 后再继续。PowerShell 可能被透明解密，
    它读到明文不代表文件没加密，所以前提要靠人工确认。

.EXAMPLE
    Set-ExecutionPolicy -Scope Process Bypass
    & 'C:\p04\aiclient-p0-4-kit\run-p0-4.ps1' -EncDir 'D:\Encrypted'

.EXAMPLE
    & 'C:\p04\aiclient-p0-4-kit\run-p0-4.ps1' -EncDir 'D:\Encrypted' -ControlGroup
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EncDir,
    [string]$AppDir = '',
    [string]$GitBash = '',
    [switch]$KeepWork,
    [switch]$ControlGroup,
    [switch]$ManualEncryption,
    [string]$DshDesktopHome = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$TsdMagic = '%TSD-Header-###%'
$kit = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportDir = Join-Path $kit "report-$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

function Write-Step([string]$Text) { Write-Host "[P0-4] $Text" }

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# PowerShell's read view; encryption software may transparently decrypt it.
function Get-Head([string]$Path, [string]$Role) {
    $result = [ordered]@{ path = $Path; role = $Role; exists = $false; isTsd = $false; bytes = 0; hex = ''; ascii = '' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]$result }
    $result.exists = $true
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $buffer = New-Object byte[] 16
            $count = $stream.Read($buffer, 0, 16)
            $result.bytes = $stream.Length
        } finally { $stream.Dispose() }
        if ($count -gt 0) {
            $used = $buffer[0..($count - 1)]
            $result.hex = ($used | ForEach-Object { $_.ToString('x2') }) -join ' '
            $result.ascii = -join ($used | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } })
            $result.isTsd = ($count -eq 16) -and ([System.Text.Encoding]::ASCII.GetString($buffer, 0, 16) -eq $TsdMagic)
        }
    } catch {
        $result.ascii = "读失败：$($_.Exception.Message)"
    }
    return [pscustomobject]$result
}

function Find-AppDir {
    if ($AppDir -ne '') { return $AppDir }
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('PiLab Ai', 'jyw-ai-client', 'AiClient')) {
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

# ---- 1. node.exe -------------------------------------------------------------
$app = Find-AppDir
if ($null -eq $app) {
    Write-Host '[P0-4] 没找到已安装的应用（resources\node-runtime\node.exe）。请用 -AppDir 指定安装目录后重跑。' -ForegroundColor Red
    exit 1
}
$node = Join-Path $app 'resources\node-runtime\node.exe'
$nodeVersion = (& $node -v) | Select-Object -First 1
Write-Step "应用目录 $app；node.exe $nodeVersion"
if ($nodeVersion -ne 'v24.18.0') { Write-Host "[P0-4] 注意：期望 v24.18.0，实际 $nodeVersion。继续跑，结论里会带上版本。" -ForegroundColor Yellow }
$dshHome = $null
if ($ControlGroup) {
    # DSH Desktop sets DSH_HOME to %APPDATA%\dsh-desktop\harness for its host
    # (its app log prints DSH_HOME=...), not the CLI default %USERPROFILE%\.dsh.
    $dshHome = Join-Path $env:APPDATA 'dsh-desktop\harness'
    if ($DshDesktopHome -ne '') { $dshHome = $DshDesktopHome }
    if (-not (Test-Path -LiteralPath $dshHome -PathType Container)) {
        Write-Host "[P0-4] 没找到 DSH Desktop 的 DSH_HOME：$dshHome。请先启动一次 DSH Desktop；目录不在这里的话，看它日志里 DSH_HOME= 那一行，用 -DshDesktopHome 指定。" -ForegroundColor Red
        exit 1
    }
    Write-Step "对照组改写的 DSH_HOME：$dshHome"
}
if ($kit.Length -gt 60) { Write-Host "[P0-4] 注意：工具包路径较长（$($kit.Length) 字符），深层依赖可能超过 260 字符。建议放到 C:\p04 这类短路径。" -ForegroundColor Yellow }

# ---- 2. work dir and markers (written by PowerShell) ---------------------------
if (-not (Test-Path -LiteralPath $EncDir -PathType Container)) {
    Write-Host "[P0-4] -EncDir 不存在：$EncDir" -ForegroundColor Red
    exit 1
}
$prefix = 'p0-4'
$workspaces = @('ws-on', 'ws-off')
if ($ControlGroup) { $prefix = 'p0-4-ctrl'; $workspaces = @('ws-ctrl') }
$work = Join-Path (Resolve-Path -LiteralPath $EncDir).Path "$prefix-$stamp"
$marker = 'P04-ENC-MARKER-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
New-Item -ItemType Directory -Force -Path $work | Out-Null
Set-Content -LiteralPath (Join-Path $work 'marker.txt') -Value "$marker plaintext line" -Encoding ASCII
$premiseFiles = New-Object System.Collections.Generic.List[object]
$premiseFiles.Add((Get-Head (Join-Path $work 'marker.txt') 'premise: marker.txt'))
foreach ($ws in $workspaces) {
    $dir = Join-Path $work $ws
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-Content -LiteralPath (Join-Path $dir 'marker.txt') -Value "$marker plaintext line" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $dir 'edit-target.txt') -Value "$marker edit target" -Encoding ASCII
    $premiseFiles.Add((Get-Head (Join-Path $dir 'marker.txt') "premise: $ws\marker.txt"))
    $premiseFiles.Add((Get-Head (Join-Path $dir 'edit-target.txt') "premise: $ws\edit-target.txt"))
}
$manualConfirmedAt = $null
if ($ManualEncryption) {
    $confirmationFile = Join-Path $reportDir 'manual-encryption-confirmed.txt'
    Write-Utf8NoBom (Join-Path $reportDir 'manual-encryption-pending.json') ([ordered]@{
        work = $work
        files = @($premiseFiles | ForEach-Object { $_.path })
        confirmationFile = $confirmationFile
    } | ConvertTo-Json -Depth 3)
    Write-Step "等待人工加密：$work"
    $premiseFiles | ForEach-Object { Write-Host $_.path }
    Write-Step "人工确认上述文件已加密后，在 $confirmationFile 写入 CONFIRMED 继续。"
    while (-not (Test-Path -LiteralPath $confirmationFile)) { Start-Sleep -Seconds 2 }
    if ((Get-Content -LiteralPath $confirmationFile -Raw -Encoding UTF8).Trim() -ne 'CONFIRMED') {
        throw '人工确认文件内容必须为 CONFIRMED；探针尚未启动。'
    }
    $manualConfirmedAt = [DateTime]::UtcNow.ToString('o')
    $premiseFiles = @($premiseFiles | ForEach-Object { Get-Head $_.path $_.role })
}
$allTsd = @($premiseFiles | Where-Object { -not $_.isTsd }).Count -eq 0
$psText = "$(Get-Content -Raw -LiteralPath (Join-Path $work 'marker.txt'))"
$psRead = 'other'
if ($psText.Contains($marker)) { $psRead = 'plaintext' } elseif ($psText.Contains($TsdMagic)) { $psRead = 'ciphertext' }
if ($allTsd) { Write-Step "前提成立：标记文件在盘上是 TSD 容器（$work）" }
elseif ($manualConfirmedAt) { Write-Step '人工已确认输入文件加密；PowerShell 未观察到 TSD 头，自动前提保持未成立。' }
else { Write-Host "[P0-4] 自动前提未成立：$work 下 PowerShell 未观察到 TSD 头。照跑，但加密结论不能签收。" -ForegroundColor Yellow }

# ---- 3. node-side probe ------------------------------------------------------
$nodeReport = Join-Path $reportDir 'node-report.json'
$probeLog = Join-Path $reportDir 'p0-4-probe.log'
$probeArgs = @((Join-Path $kit 'host\tools\p0-4-probe.ts'), '--work', $work, '--marker', $marker, '--out', $nodeReport, '--log', $probeLog, '--gateway', (Join-Path $kit 'gateway\fake-gateway.mjs'))
$dshProcesses = @()
$probeExit = $null
if (-not $ControlGroup) {
    if ($GitBash -ne '') { $probeArgs += @('--git-bash', $GitBash) }
    Write-Step '开始跑 node.exe 探针（约 3～8 分钟）……'
    $ErrorActionPreference = 'Continue'
    & $node @probeArgs
    $probeExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} else {
    # Control group: official DSH Desktop reads its home-level patch and user
    # .env from its DSH_HOME ($dshHome, resolved above). Point its model at the
    # local fake gateway for this run only; restore both files afterwards.
    # Originals are renamed aside in the same directory rather than copied: a
    # copy written back by PowerShell can come out encrypted where the desktop's
    # own node wrote plaintext, and node was seen reading a PowerShell-written
    # cordis.patch.yml as a TSD container (P1-13 round one).
    $patchFile = Join-Path $dshHome 'cordis.patch.yml'
    $envFile = Join-Path $dshHome '.env'
    $patchBackup = "$patchFile.p0-4-backup-$stamp"
    $envBackup = "$envFile.p0-4-backup-$stamp"
    $hadPatch = Test-Path -LiteralPath $patchFile
    $hadEnv = Test-Path -LiteralPath $envFile
    $patchMoved = $false
    $envMoved = $false
    $wrotePatch = $false
    $wroteEnv = $false
    $controlPatch = @'
# P0-4 control group, written by run-p0-4.ps1 -ControlGroup and restored when it ends.
- id: llm-pi-ai
  config:
    providers:
      aiclient-gateway:
        displayName: P0-4 fake gateway
        api: anthropic-messages
        baseURL: http://127.0.0.1:18484
        apiKeyEnv: AICLIENT_DSH_GATEWAY_KEY
        models:
          - id: fake-1
            name: P0 fake model
            contextWindow: 200000
            maxTokens: 8192
            reasoningEfforts: false
        retryPolicy:
          mode: normal
          maxRetries: 0

- id: agent-default-model
  config:
    provider: aiclient-gateway
    model: fake-1

- id: session-title-llm
  disabled: true
'@
    try {
        if ($hadPatch) { Move-Item -LiteralPath $patchFile -Destination $patchBackup; $patchMoved = $true }
        if ($hadEnv) { Move-Item -LiteralPath $envFile -Destination $envBackup; $envMoved = $true }
        Write-Utf8NoBom $patchFile ($controlPatch -replace "`r`n", "`n")
        $wrotePatch = $true
        Write-Utf8NoBom $envFile "AICLIENT_DSH_GATEWAY_KEY=p0-4-fake-gateway-key`n"
        $wroteEnv = $true
        $backupNote = '原来没有这两个文件，结束时删掉临时文件'
        if ($hadPatch -or $hadEnv) { $backupNote = "原文件改名为 *.p0-4-backup-$stamp 留在同一目录，结束时改回" }
        Write-Step "已临时改写 $patchFile 与 $envFile（$backupNote）。"
        # PowerShell's copy may land encrypted; see whether the bundled node can read it.
        $ErrorActionPreference = 'Continue'
        $nodeView = & $node -e "process.stdout.write(require('fs').readFileSync(process.argv[1]).subarray(0, 16).toString('latin1'))" $patchFile
        $nodeView = "$nodeView"
        $ErrorActionPreference = 'Stop'
        if ($nodeView -eq $TsdMagic) {
            Write-Host "[P0-4] 注意：随包 node.exe 读 $patchFile 看到的是 TSD 容器，DSH Desktop 可能读不到这份临时配置。如果 DSH Desktop 里没有「P0 fake model」，请在它的界面里手动添加提供商（Anthropic 兼容，地址 http://127.0.0.1:18484，模型 fake-1，密钥 p0-4-fake-gateway-key），测完删掉。" -ForegroundColor Yellow
        }
        Write-Step '现在启动 DSH Desktop（如果它开着，先从托盘「退出」再重新打开），然后按下面的提示操作。'
        $probeArgs += @('--control', '--port', '18484')
        $ErrorActionPreference = 'Continue'
        & $node @probeArgs
        $probeExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $dshProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
                "$($_.ExecutablePath)" -like '*DeepSeek*' -or "$($_.ExecutablePath)" -like '*DSH Desktop*' -or "$($_.Name)" -like '*DeepSeek*' -or "$($_.Name)" -like 'dsh*'
            } | ForEach-Object {
                $line = "$($_.CommandLine)"
                [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; exe = "$($_.ExecutablePath)"; commandLine = $line.Substring(0, [Math]::Min(300, $line.Length)) }
            })
    } finally {
        # Remove only what this run wrote, then rename the originals back.
        $restoreFailed = New-Object System.Collections.Generic.List[string]
        foreach ($pair in @(
                @{ file = $patchFile; backup = $patchBackup; wrote = $wrotePatch; moved = $patchMoved },
                @{ file = $envFile; backup = $envBackup; wrote = $wroteEnv; moved = $envMoved })) {
            try {
                if ($pair.wrote -or $pair.moved) { Remove-Item -LiteralPath $pair.file -Force -ErrorAction SilentlyContinue }
                if ($pair.moved) { Move-Item -LiteralPath $pair.backup -Destination $pair.file }
            } catch { $restoreFailed.Add("$($pair.file)：$($_.Exception.Message)") }
        }
        if ($restoreFailed.Count -eq 0) {
            Write-Step "已还原 $dshHome 下的 cordis.patch.yml 与 .env。请退出并重开 DSH Desktop，让它回到原配置。"
        } else {
            Write-Host "[P0-4] 还原失败：$($restoreFailed -join '；')。请退出 DSH Desktop 后，把同目录下的 *.p0-4-backup-$stamp 改回原名。" -ForegroundColor Red
        }
    }
}
Write-Step "探针结束（exit $probeExit）"

# ---- 4. head checks ------------------------------------------------------------
$inspectFile = Join-Path $reportDir 'node-report.inspect.json'
$inspect = @()
$cleanupList = @()
if (Test-Path -LiteralPath $inspectFile) {
    $side = Get-Content -Raw -Encoding UTF8 -LiteralPath $inspectFile | ConvertFrom-Json
    $inspect = @($side.inspect)
    $cleanupList = @($side.cleanup)
}
$heads = @($inspect | ForEach-Object { Get-Head $_.path $_.role })

# ---- 5. cleanup ------------------------------------------------------------------
$removed = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[object]
$targets = @($cleanupList)
if (-not $KeepWork) { $targets += $work }
foreach ($path in $targets) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { continue }
    # node.exe first: deep trees under dsh-home (e.g. preinstalled plugin node_modules) can exceed MAX_PATH, which
    # Remove-Item in Windows PowerShell 5.1 cannot delete.
    $ErrorActionPreference = 'Continue'
    & $node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 3 })" $path
    $ErrorActionPreference = 'Stop'
    if (Test-Path -LiteralPath $path) {
        try { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop } catch { }
    }
    if (Test-Path -LiteralPath $path) { $failed.Add([pscustomobject]@{ path = $path; error = 'still exists after rmSync and Remove-Item' }) }
    else { $removed.Add($path) }
}

# ---- 6. merge and summary ------------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$manifestFile = Join-Path $kit 'kit-manifest.json'
$kitInfo = $null
if (Test-Path -LiteralPath $manifestFile) {
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestFile | ConvertFrom-Json
    $kitInfo = [ordered]@{ builtAt = $manifest.builtAt; platform = $manifest.platform; source = $manifest.source }
}
$osName = [Environment]::OSVersion.VersionString
if ($os) { $osName = "$($os.Caption) $($os.Version)" }
$psSide = [ordered]@{
    machine = [ordered]@{
        os = $osName
        psVersion = "$($PSVersionTable.PSVersion)"
        administrator = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        appDir = $app
        nodeExe = $node
        nodeVersion = $nodeVersion
        kitDir = $kit
        encDir = $EncDir
        work = $work
        temp = $env:TEMP
        localAppData = $env:LOCALAPPDATA
        probeExit = $probeExit
        mode = $(if ($ControlGroup) { 'control' } else { 'kit' })
        dshProcesses = $dshProcesses
    }
    premise = [ordered]@{ allTsd = $allTsd; psRead = $psRead; marker = $marker; files = $premiseFiles; manualConfirmed = [bool]$manualConfirmedAt; manualConfirmedAt = $manualConfirmedAt }
    heads = $heads
    cleanup = [ordered]@{ kept = [bool]$KeepWork; removed = $removed; failed = $failed }
    kit = $kitInfo
}
$psSideFile = Join-Path $reportDir 'ps-side.json'
Write-Utf8NoBom $psSideFile ($psSide | ConvertTo-Json -Depth 8)

$final = Join-Path $reportDir 'p0-4-report.json'
$summary = Join-Path $reportDir 'p0-4-summary.txt'
$ErrorActionPreference = 'Continue'
& $node (Join-Path $kit 'host\tools\p0-4-report.ts') --node $nodeReport --ps $psSideFile --out $final --summary $summary | Out-Null
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $final) {
    Remove-Item -LiteralPath $nodeReport, $inspectFile, $psSideFile -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if (Test-Path -LiteralPath $summary) { Get-Content -LiteralPath $summary -Encoding UTF8 | ForEach-Object { Write-Host $_ } }
$reportHead = Get-Head $final 'report'
if ($reportHead.isTsd) {
    Write-Host "[P0-4] 注意：报告文件本身被加密了（$final）。请把工具包挪到不受策略的目录重跑，或走解密外发。" -ForegroundColor Yellow
}
Write-Step "报告目录：$reportDir"
