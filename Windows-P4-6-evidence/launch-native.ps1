# AiClient test.11 native 启动脚本 —— 确保 AICLIENT_RUNTIME_BACKEND 真正进入 worker
# 用法：在 PowerShell 里执行  . .\Windows-P4-6-evidence\launch-native.ps1
$env:AICLIENT_RUNTIME_BACKEND   = 'native'
$env:AICLIENT_RUNTIME_AGENT_DIR = 'C:\Users\JC\.pilab\jyw-ai-client\pi-agent'
$env:AICLIENT_RUNTIME_TRACE_DIR = 'E:\code\GitTmp\ai-client-runtime\Windows-P4-6-evidence\native-trace'
New-Item -ItemType Directory -Force -Path $env:AICLIENT_RUNTIME_TRACE_DIR | Out-Null
Write-Host "backend=$env:AICLIENT_RUNTIME_BACKEND agent=$env:AICLIENT_RUNTIME_AGENT_DIR trace=$env:AICLIENT_RUNTIME_TRACE_DIR"
Start-Process -FilePath 'D:\Program Files\AiClient\AiClient.exe'
Write-Host "AiClient 已启动，请新建会话并发一条消息。"
