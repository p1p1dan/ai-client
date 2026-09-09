# 环境盘点证据

## 系统
Windows 11 Pro 10.0.26100 (Build 26100), AMD64
Gigabyte Z790 UD, 注册用户 JC
RAM: 34110636032 bytes = 31.77 GiB
磁盘: C: 空闲160433274880 / 总498865270784 | D: 空闲1631816708096 / 总2040091635712 | E: 空闲1037300174848 / 总1960676683776

## 工具链
PowerShell: 5.1.26100.9168
Git: 2.45.2.windows.1
Node: v24.18.0 (PATH=C:\nvm4w\nodejs)
npm: 11.18.0
pnpm: 无全局 PATH, 通过 corepack 10.26.2 (packageManager pin)
corepack: 0.35.0
.nvmrc=22, runtime engines>=24, CI 用 node 24

## 已安装 AiClient
安装路径: D:\Program Files\AiClient
版本(注册表): 1.0.0-test.9, 桌面有 AiClient.lnk
随包 node.exe: D:\Program Files\AiClient\resources\node-runtime\node.exe (92534088 bytes, v24.18.0)
resources 结构: agent-host/ (仅 node_modules+package.json+worker.js), app.asar, app.asar.unpacked,
  elevate.exe, licenses/, model-catalog/, node_modules/, node-runtime/ (node.exe+PIN.json)
未发现 resources/git/ 或 git/bin/bash.exe
当前进程: AiClient.exe (D:\Program Files\AiClient\AiClient.exe) + gpu-process, 运行中
  user-data-dir=C:\Users\JC\AppData\Roaming\jyw-ai-client

## 企业加密驱动
驱动: TsdEncrypt.sys (Running), TsdEncryptMF.sys (Running) -- 路径 C:\Windows\system32\drivers\\
Ocular3Path: C:\Windows\SysWOW64\Ocular3Path (含 DocWaterMark, CameraPack, SCDT, TKS 等)
进程: TOfficeOperation.exe (Ocular3Path\DocWaterMark\*\TOfficeOperation.exe), 多个
其他安全: Sangfor aTrust (aTrustAgent/aTrustTray/aTrustXtunnel, VNIC Stopped), sprotect(Running)
  HipsTray, DSATray, Sangfor EAIO (eaio_agent/eaio_service)

## Git/repo 状态
分支: feat/runtime-evolution (与 origin 同步)
HEAD: f677f705  (前一提交 9edab07c = P4-5 代码)
工作区: 无产品/锁定文件改动 (仅曾暂存 node_modules, 未纳入 git)
未跟踪: _chk_status.txt (空文件, 非本次创建, 未处理)

## 参考仓
AGENTS.md 提到的参考仓位于 Linux 路径 /home/ai/code/pi-app, /home/ai/code/pix
本机为 Windows, 这些路径不可达, 未读取 -- 如实记录

## 依赖安装
根 package.json: 未用 pnpm (worker 报错 exit 1), 改用 npm install --ignore-scripts 成功 (967 pkgs)
  pnpm 失败原因: worker 崩溃无明确报错, 疑与安全软件/加密驱动拦截 pnpm 提取 worker 有关
  后恢复 package-lock.json 为原始状态 (git checkout)
src/runtime: npm ci --omit=optional --ignore-scripts (100 pkgs) 成功
src/agent-host: npm ci --omit=dev --omit=optional --ignore-scripts (230 pkgs) 成功
关键版本: cordis 4.0.0-rc.9, pi-ai 0.84.4, pi-agent-core 0.84.4,
  pi-coding-agent(agent-host) 0.84.3, pi-permission-system 27.0.1
  // 印证 D12: pi 0.84.4 vs 旧基线 0.84.3 patch 差

## 网络代理注意
~/.npmrc 配置 proxy=http://127.0.0.1:7892 (本地代理), 但该代理当前不可达 (curl 000)
npm 直连 registry 正常 (npm ping PONG 660ms)
已用环境变量覆盖代理强制直连进行所有安装, 未修改 ~/.npmrc
