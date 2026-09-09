# AiClient test.11 native 启动脚本（GUI A~E 验收专用）
# 用法：在 PowerShell 里执行  . .\Windows-P4-6-evidence\launch-gui-a-e.ps1
$ErrorActionPreference = 'Stop'

$app    = 'D:\Program Files\AiClient\AiClient.exe'
$trace  = 'E:\code\GitTmp\ai-client-runtime\Windows-P4-6-evidence\native-trace2'

# 1. 退出已在运行的 AiClient（避免单实例把请求交给旧进程）
$running = Get-Process AiClient -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "检测到 AiClient 已在运行，先退出它 (PID: $($running.Id -join ', '))..."`
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# 2. 设置 native 后端环境
$env:AICLIENT_RUNTIME_BACKEND   = 'native'
$env:AICLIENT_RUNTIME_AGENT_DIR = 'C:\Users\JC\.pilab\jyw-ai-client\pi-agent'
$env:AICLIENT_RUNTIME_TRACE_DIR = $trace
New-Item -ItemType Directory -Force -Path $trace | Out-Null

Write-Host "backend=$env:AICLIENT_RUNTIME_BACKEND agent=$env:AICLIENT_RUNTIME_AGENT_DIR trace=$trace"

# 3. 启动应用
Start-Process -FilePath $app
Write-Host "AiClient 已启动..."

# 4. 等 8 秒，确认进程活着
Start-Sleep -Seconds 8
$p = Get-Process AiClient -ErrorAction SilentlyContinue
if ($p) {
    Write-Host "进程存活  PID=$($p.Id)  路径=$($p.Path)"
} else {
    Write-Host "【警告】未检测到 AiClient 进程，请检查是否被安全软件拦截。"
}

# 5. 提示下一步
Write-Host "`n请在应用里开一个会话并发送任意一条消息（让模型产生一次调用），"
Write-Host "然后回来告诉我，我再确认 native trace 是否生成。"
