# AiClient test.11 native 启动脚本
# AICLIENT_RUNTIME_BACKEND 已随 P6-5 连同旧引擎一起删除，设置它不再有任何效果；
# 后端恒为 native，需要核验时读 trace 里的 version_stamp.backend / carrier / node_exec_path，
# 不能只看这个脚本自己回显的环境变量。
# 用法：在 PowerShell 里执行  . .\Windows-P4-6-evidence\launch-native.ps1
$env:AICLIENT_RUNTIME_AGENT_DIR = 'C:\Users\JC\.pilab\jyw-ai-client\pi-agent'
$env:AICLIENT_RUNTIME_TRACE_DIR = 'E:\code\GitTmp\ai-client-runtime\Windows-P4-6-evidence\native-trace'
New-Item -ItemType Directory -Force -Path $env:AICLIENT_RUNTIME_TRACE_DIR | Out-Null
Write-Host "agent=$env:AICLIENT_RUNTIME_AGENT_DIR trace=$env:AICLIENT_RUNTIME_TRACE_DIR"
Start-Process -FilePath 'D:\Program Files\AiClient\AiClient.exe'
Write-Host "AiClient 已启动，请新建会话并发一条消息。之后查看 $env:AICLIENT_RUNTIME_TRACE_DIR\runs.jsonl 的 version_stamp.backend/carrier/node_exec_path 确认实际后端与载体。"
