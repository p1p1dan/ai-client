# 1.0.0-test.11 交付与 Windows 验收入口

2026-09-09 · 源码提交：`b6aa08441eae775f47e8e8829a1e327cbae217e3`。
分支：`feat/runtime-evolution`；[手动 CI 34308304362](https://github.com/p1p1dan/ai-client/actions/runs/34308304362)。

## 已验证与未验收

- 完整门禁：三道 typecheck、Biome、350 文件/4987 项测试、runtime 两条离线冒烟、发布元数据通过。
- Windows job 通过：legacy/native 均真实 Read/bash、结果回传模型、dispose 回执及 exitCode 0；使用 `dist/win-unpacked/resources/node-runtime/node.exe`，native trace 记录 Node 24.18.0、bundled-node、node-runner-pipe-v1。
- Linux job 通过：两后端的真实 utilityProcess 工具/退出验证通过。
- macOS 同轮仍在运行，不能把整次 CI 标成全部完成。
- 当前脚本从仓库 Electron 启动已打包 worker，Windows 使用包内 Node。它证明 worker 产物及 carrier 可运行，不等同于真实安装应用的 Main/preload/renderer 全链路验收。
- Windows GUI、复杂命令树取消/超时/父进程先退出、企业加密驱动和主线 A～E 现场仍未执行。

原始报告：[Windows](windows/worker-smoke-report.json) · [Linux](linux/worker-smoke-report.json)。
产物元数据：[artifacts.json](artifacts.json)。其中 digest 是 **Actions artifact ZIP** 的 SHA-256，不是解压后 exe 的 SHA-256。
bundle 内没有 git 工作目录，所以 trace 的 git_commit 为 unknown；提交身份由 Actions 的 head SHA 与对应产物绑定，不伪造为现场采到的 git 信息。

## 下载

| 用途 | Artifact |
|---|---|
| 正常安装、GUI 验收 | [windows-installer](https://github.com/p1p1dan/ai-client/actions/runs/34308304362/artifacts/10087675018) |
| 固定目录分析 worker/资源与重复运行 | [windows-unpacked](https://github.com/p1p1dan/ai-client/actions/runs/34308304362/artifacts/10087689329) |
| Portable（临时解压路径可能变化） | [windows-portable](https://github.com/p1p1dan/ai-client/actions/runs/34308304362/artifacts/10087677251) |
| Windows 原始冒烟证据 | [worker-smoke-Windows](https://github.com/p1p1dan/ai-client/actions/runs/34308304362/artifacts/10087672844) |

需要有仓库访问权限的 GitHub 登录。安装包/portable 保留 14 天，unpacked 保留 7 天，以 artifact 实际过期时间为准。

已安装 GitHub CLI 的 Windows AI 可执行（`$repo` 为仓库路径，按实际调整）：

```powershell
$repo = "$HOME\code\ai-client-runtime"
Set-Location $repo
git status --short --branch
# 工作区干净且在任务分支时更新；有修改先处理，禁止 reset --hard。
git pull --ff-only origin feat/runtime-evolution
git merge-base --is-ancestor b6aa0844 HEAD

$evidence = Join-Path $repo 'Windows-P4-6-evidence'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
gh run download 34308304362 --repo p1p1dan/ai-client --name windows-installer --dir "$evidence\installer"
gh run download 34308304362 --repo p1p1dan/ai-client --name worker-smoke-Windows --dir "$evidence\ci-worker"
Get-ChildItem "$evidence\installer" -Filter *.exe | Get-FileHash -Algorithm SHA256
```

源码后续可能只有证据文档提交；判断测试代码是否一致时核对 `b6aa0844` 及后续源码差异，不仅比较版本名称。

## 从安装应用开始

先退出旧 AiClient/TUI，再从同一个 PowerShell 会话启动实际安装的 exe：

```powershell
# 替换为实际安装位置；不要盲目采用示例路径。
$appExe = 'C:\实际安装目录\AiClient.exe'
$env:AICLIENT_RUNTIME_BACKEND = 'native'
$env:AICLIENT_RUNTIME_TRACE_DIR = Join-Path $evidence 'native-trace'
New-Item -ItemType Directory -Force -Path $env:AICLIENT_RUNTIME_TRACE_DIR | Out-Null
Start-Process -FilePath $appExe
```

这些环境变量仅设置于当前 PowerShell 及后代，不修改系统环境。用独立测试目录和会话，先证明实际 native 后端与随包 Node 路径，再执行功能验收。trace 会包含测试对话内容，分享前检查并脱敏。

若运行源码 P1 探针，需要此提交的源码和 `src/runtime` 依赖；仅安装产品不需要装 Node/pnpm/Visual Studio。
`p1-bundled-node.ts` 必须由实际包内 node.exe 执行；bash 使用机器上实际安装的 Git for Windows 路径，本仓没有随包 Git/bash。
现有探针的临时目录若不受企业加密策略影响，只能算普通工具探针，不能签收加密专项。

## Windows AI 本轮任务

1. 记录环境、是否加密机、包来源/哈希、实际应用/Node/Git Bash 路径。
2. 完成 [P4-6 项目](../README.md)里的工具、审批、附件、会话、GUI/TUI、进程树与 Main 文件读取检查。
3. 同一包上签收 [GUI A～E 最小现场清单](../../../../gui-sdk-experience/现场验收清单.md)：目录菜单、终端设置、文件打开、/new/TEMP、重试状态、问答、diff、用量入口和输出跟随。
4. 允许类权限记录现在默认折叠在授权详情，展开应完整可查；拒绝/权限错误仍直接显示。
5. 每项留通过/失败/未执行与证据；不会桌面操作的 AI 集中列出需要用户点击的步骤，不用源码分析代替 GUI 实测。

反馈写入 `Windows-P4-6-验收记录.md`。不要自动提交、推送或修改产品源码；问题带最小复现、日志和对应提交交回开发端。
