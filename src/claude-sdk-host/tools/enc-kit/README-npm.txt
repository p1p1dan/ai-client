路线 B 加密机读写矩阵上机包：npm 包（ccsdk-enc-kit-npm）

这是什么
  测官方 Claude Agent SDK 自带的 claude.exe 在加密机上，按不同的「出身」（父进程链）启动时，能不能读写加密文件、读回自己的对话记录。
  加密软件可能按进程树放行（VS Code 在白名单里，它的子进程跟着被放行），所以同一套测试跑三种出身：
    inherit   从谁启动就挂在谁下面（在 VS Code 里跑就是 VS Code）；
    detached  经 WMI 另起，不挂在任何白名单程序下面；
    pilab     经 WMI 另起，由 PiLab 自己的主程序启动 node 和 claude.exe，最接近产品。
  只连本机假网关（127.0.0.1，扮演模型），不调用真实模型，不需要任何 key 或账号。

交付方式（按测试方的建议）
  - 被测本体保持真实：宿主源码 app\ 下的 .ts 原样发来；SDK 与 claude.exe 不随包，在本机 npm ci 安装（本地落盘=明文）。
  - 脚手架（上机脚本、探针、假网关、样本清单、小工具）以 scaffold\*.txt 发来，一个脚本一个 .txt，
    开头的注释写明目标文件名、放置目录、依赖的同包文件；本机按下面第 1 步还原成原文件。
  - 不用任何绕过加密的手法。

前提
  - 本机已安装 PiLab 1.1.x（脚本用它随包的 resources\node-runtime\node.exe）。
  - 本机有 npm，并能访问 npm 仓库或内网镜像（只在第 2 步用）。

步骤
  0. 把 ccsdk-enc-kit-npm.zip 解压到任意目录，下文以 C:\ccsdk 为例，工具包目录是 C:\ccsdk\ccsdk-enc-kit-npm。

  1. 还原脚手架：打开 Windows PowerShell，粘贴下面一行回车（把第一个路径换成实际的工具包目录）：

     $k='C:\ccsdk\ccsdk-enc-kit-npm'; Get-ChildItem "$k\scaffold\*.txt" | ForEach-Object { $t=[IO.File]::ReadAllText($_.FullName,[Text.Encoding]::UTF8); if ($t -match 'CCSDK-KIT TARGET: (\S+)') { $p=Join-Path $k $Matches[1]; [void](New-Item -ItemType Directory -Force (Split-Path $p)); [IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($p.EndsWith('.ps1')))); "还原 $p" } }

     会还原 5 个文件：run-ccsdk-enc.ps1、kit-tools.mjs、app\src\dsh-host\tools\fake-gateway.mjs、
     app\src\dsh-host\tools\p1-13b\matrix-probe.mjs、app\src\claude-sdk-host\tools\host-probe.ts。
     也可以自己按每个 .txt 开头的注释手工另存（.ps1 存成 UTF-8 带 BOM，其余 UTF-8 无 BOM）。

  2. 本机安装 SDK 与 claude.exe：

     cd C:\ccsdk\ccsdk-enc-kit-npm\app\src\claude-sdk-host
     npm ci --no-audit --no-fund

     只能用内网镜像时加 --registry <镜像地址>。装好后应有 node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe；
     它的 SHA256 应等于 kit-manifest.json 里的 expectedClaudeExe（脚本会记进摘要）。

  3. 运行：

     powershell -NoProfile -ExecutionPolicy Bypass -File C:\ccsdk\ccsdk-enc-kit-npm\run-ccsdk-enc.ps1 -ManualEncryption

     第 0 步先查：脚手架还原了没有、npm ci 做了没有（没做就停下，退出码 5）；
     再用 PowerShell 与随包 node 各看一遍工具包自己的文件，node 要加载的文件读成密文就停下（退出码 4）。
  4. 先自动跑约 8 分钟（启动检查，三种出身各跑一遍：发消息、停止、重开续聊）。提示「claude.exe 启动失败」就到此结束。
  5. 屏幕出现青色提示「请用加密客户端把这个目录加密」时：
     用加密客户端把提示里的 samples 目录（含 4 个 enc-* 子目录，每个 75 个文件，含 vcxproj 等工程文件与 exe、dll 等二进制）加密，回到窗口输入 CONFIRMED 回车。
  6. 再自动跑约 35 分钟，中途不要关窗口。
  7. 出现绿色的「跑完了」后：
     a. 屏幕上 SUMMARY BEGIN 到 SUMMARY END 之间是摘要；
     b. 用加密客户端看 samples\enc-*\ccsdk-written-* 里的新文件有没有被加密，结果写进报告目录的 notes.txt；
     c. 把摘要和 notes 转给开发者（报告里有本机路径，不要发到公开的地方）。

交给 AI 跑
  把 HANDOFF.md 交给加密机上 VS Code 里的 Claude 插件，它会自己做第 1～7 步，只在加密与检查新文件两处请你配合。

出问题时
  - 提示没找到 PiLab：加 -AppDir "<PiLab 安装目录>"。
  - 提示端口被占用：加 -Port 18990。
  - 想重跑：直接再运行一遍第 3 步，每次都用新的时间戳目录，不会互相覆盖。
