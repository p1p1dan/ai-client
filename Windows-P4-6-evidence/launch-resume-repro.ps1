# AiClient test.11 native 复现启动 (resume 错误定位用) —— trace 写入 resume-repro-trace
# AICLIENT_RUNTIME_BACKEND 已随 P6-5 删除，设置它不再有任何效果；后端恒为 native。
$env:AICLIENT_RUNTIME_AGENT_DIR = 'C:\Users\JC\.pilab\jyw-ai-client\pi-agent'
$env:AICLIENT_RUNTIME_TRACE_DIR = 'E:\code\GitTmp\ai-client-runtime\Windows-P4-6-evidence\resume-repro-trace'
New-Item -ItemType Directory -Force -Path $env:AICLIENT_RUNTIME_TRACE_DIR | Out-Null
Write-Host "trace=$env:AICLIENT_RUNTIME_TRACE_DIR"
Start-Process -FilePath 'D:\Program Files\AiClient\AiClient.exe'
Write-Host "AiClient 已启动，请点开之前报错的 bmo-m1 worktree 历史会话。"
