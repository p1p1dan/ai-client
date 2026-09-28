Role: topic

# P1-13 加密机上机步骤（DSH 宿主 + 官方 DSH Desktop 对照组）

建立：2026-09-27。上位：[roadmap P1-13](../roadmap.md)，合入 main 前的否决关（[决策 002](../decisions/002-defer-encrypted-machine-and-shared-host.md)、[004](../decisions/004-branch-isolated-dsh-only.md)）。

- 本文是上机时照着做的步骤，取代 [P0-4 检查单](p0-4-encrypted-machine-checklist.md)。检查项的含义与判据沿用 P0-4 检查单。
- 结论回填 [Q002](../open-questions.md)，以及[决策 045](../decisions/045-windows-acl-sandbox-default-off.md) 第 3 条。
- 相关证据：
  - 上机包怎么构建、Linux 预演：[P0-4 证据](../evidence/p0-4-kit-2026-09-25.md)；
  - 普通 Windows 实测：[P0-4 CI 证据](../evidence/p0-4-windows-ci-2026-09-26.md)。
- 一份正常跑完的摘要：
  - 普通 Windows：[CI 管理员一轮](../evidence/p0-4-windows-ci-2026-09-26/admin/)；
  - 本次包的 Linux 预演：[linux-dryrun-summary-2026-09-27.txt](p1-13-encrypted-machine-runbook/linux-dryrun-summary-2026-09-27.txt)。Linux 上没有加密，所以这份摘要里写的是「前提：不成立」。

## 这次验证什么

要回答的问题是：我方 DSH 宿主跑在已安装应用的随包 `node.exe`（白名单载体）上时，以下各项拿到的是不是明文。

- 读、写、编辑、grep、glob；
- pwsh 子进程；
- 终端；
- 会话日志。

沙箱开、关各跑一遍。另外让官方 DSH Desktop 跑同一套工具序列，作为对照。

- **引擎**：分支 `feat/dsh-p0-probe` 当前的宿主组合：
  - dsh-base `0.1.7-rc.2`，加产品 bundle `@aiclient/dsh-app`；
  - 共享宿主的 bridge 行常开；
  - 权限插件 `aiclient-permissions` 随包，但默认不启用；
  - 测试时另外叠一层探针 bundle，它自动批准所有审批。
- **载体**：已安装的 PiLab Ai 里的 `resources\node-runtime\node.exe`。
  - 上机包本身不带 node.exe。白名单认的是装好的那一个，从别处拷来的 node 不能代表产品。
- **模型**：脚本自己在 `127.0.0.1` 起一个假网关。不连任何真实模型服务。

全程约 30 分钟：准备 10 分钟，主检查几分钟，对照组约 15 分钟。

## 0. 准备

| # | 事项 | 怎么做 | 判据 |
|---|---|---|---|
| 0.1 | 机器 | 受 TEC 加密策略管控的 Windows 10 / 11 x64；系统自带的 Windows PowerShell 5.1 即可 | — |
| 0.2 | 应用 | 已装 PiLab Ai 1.0.1～1.0.3 中任一版本，这几版随包的 node 都是 v24.18.0。PowerShell 里跑 `& "$env:LOCALAPPDATA\Programs\PiLab Ai\resources\node-runtime\node.exe" -v` | 输出 `v24.18.0`。装在别处的话，记下安装目录，后面加参数 `-AppDir '<安装目录>'` |
| 0.3 | 账户 | 用平时办公的账户，开**普通** PowerShell 窗口，不要右键「以管理员身份运行」。全程不需要管理员权限 | 管理员提权窗口会掩盖沙箱的目录权限问题（P0-4 CI 中已见） |
| 0.4 | 拷包 | 把交付目录里的 `aiclient-p0-4-kit-win32-x64.zip`（约 41 MB）和 `SHA256SUMS` 拷到**不受加密策略的短路径**，如 `C:\p04\`。校验：`Get-FileHash C:\p04\aiclient-p0-4-kit-win32-x64.zip -Algorithm SHA256` | 与 `SHA256SUMS` 里 zip 那一行一致（不分大小写）。不一致多半是拷贝途中或落盘时被加密了，换目录或换拷贝方式 |
| 0.5 | 解压 | `tar -xf C:\p04\aiclient-p0-4-kit-win32-x64.zip -C C:\p04`（Windows 10 1803 及以上自带 tar）。也可以右键「全部解压缩」，但别让它多套一层目录 | 得到 `C:\p04\aiclient-p0-4-kit\run-p0-4.ps1`，约 1.1 万个文件、130 MB。工具包路径超过 60 个字符时脚本会提醒 |
| 0.6 | 确认工具包目录没被加密 | `Get-Content C:\p04\aiclient-p0-4-kit\kit-manifest.json -TotalCount 2` | 能看到 `{` 和 `"kit": "dsh-rebase P0-4 encrypted-machine kit",`。如果看到 `%TSD-Header-###%` 或乱码，说明这个目录受策略：换一个目录重新解压。不换的话，报告也会被加密，脚本读不了自己的中间文件 |
| 0.7 | 加密目录 | 选一个**受策略覆盖**的已有目录，如以前用过的 `D:\Encrypted`，作为 `-EncDir` 传入 | 见下方说明 |
| 0.8 | 可选项 | 见下方说明 | 缺哪样，对应几项记「跳过」，不算失败 |

**0.7 说明**：

- 不用手工准备测试文件。脚本会在这个目录里新建 `p0-4-<时间>` 子目录，用 PowerShell 写标记文件，跑完把整个子目录删掉。
- 目录里原有的文件，脚本不读也不改。
- 判据：摘要第一段写「前提：成立」，表示标记文件在盘上确实是 `%TSD-Header-###%` 容器。

**0.8 说明**：

- Git Bash：默认找 `C:\Program Files\Git\bin\bash.exe`，装在别处用 `-GitBash '<bash.exe>'` 指定。
- PowerShell 7：装了就一起测。
- pnpm 装插件：能访问 npm 官方源就测，访问不了自动跳过。公司不允许访问外网时，加 `-SkipPnpm`。

**顺序**：先做第 1 节主检查，再装官方 DSH Desktop 做第 2 节对照组。两者共用 `%LOCALAPPDATA%\node-addon-native-custom-loader` 缓存目录。先装对照组，B1 就会变成「沿用已有缓存」。

## 1. 主检查：我方 DSH 宿主跑在随包 node.exe 上

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& 'C:\p04\aiclient-p0-4-kit\run-p0-4.ps1' -EncDir 'D:\Encrypted'
```

- **沙箱开、关在一次运行里各跑一遍，不用分两次跑。**
  - `ws-on` 子目录：沙箱开（workspace-write，Windows 上是 ACL 受限令牌）；
  - `ws-off` 子目录：沙箱关（danger-full-access）。
- **耗时**：普通 Windows 上探针本身二十几秒，加密机上会慢一些，一般几分钟。
- 中途别动加密目录。出错也让它跑完，脚本出错时同样会写报告。
- 结束时窗口打印中文摘要。报告在 `C:\p04\aiclient-p0-4-kit\report-<时间>\`。
- **参数**：
  - `-EncDir`：必填；
  - `-AppDir`：应用装在非默认位置时用；
  - `-GitBash`、`-SkipPnpm`：见 0.8；
  - `-KeepWork`：保留加密目录里的工作目录。只在我们要求排查时用。
- 遇到以下情况，停下来截图发回，不要自己绕过：
  - 执行策略被组策略锁死，`Set-ExecutionPolicy` 报错；
  - 杀毒软件拦截 `node.exe`、`rg.exe` 或 `OpenConsole.exe`。

### 每项「通过」长什么样

摘要每行的格式是 `[通过/失败/跳过/记录/出错] 编号 名称 —— 实际看到的内容`。

- 「明文」：读回的内容里有标记串 `P04-ENC-MARKER-…`。
- 「密文」：读回的是 `%TSD-Header-###%` 容器。

| 编号 | 查什么 | 通过的样子 |
|---|---|---|
| 前提、N0 | 标记文件确实被加密；node.exe 直接读 | 「前提：成立」；N0 读到明文。**前提不成立时，后面所有「明文」都不能签收**，照跑并发回 |
| B2 / B3 / B1 | 宿主启动三次：原生缓存关（原地加载）、缓存放在加密目录、默认缓存（`%LOCALAPPDATA%`） | 三行都「通过」，写明原地加载或从缓存副本加载。B1、B3 显示「记录」并写着「缓存未生效，静默回退」时不算失败 |
| F-on-* | 沙箱开：read、edit、write、grep、glob；pwsh 读、写、大输出；read 回读 pwsh 写的文件；node.exe 回读全部产物 | 全部明文；grep 搜得到 `edit-target.txt`；glob 列得出文件 |
| F-on-acl | 沙箱开时工作区上的 ACL 授权 | 有 `S-1-4-…` 能力 SID ACE，有完整性标签 |
| F-off-* | 沙箱关：同一套工具序列 | 同 F-on-*。F-off-permission、F-off-acl 只记录 |
| L-lock-held / L-lock-released | 会话写锁（koffi 命名信号量） | 会话被占用时，第二个宿主打不开（报 `SessionAlreadyOwned`）；第一个关掉后能打开 |
| L-recall / S-log-plaintext | 会话写入后恢复；日志落盘 | 恢复后的历史里仍有明文标记；会话日志 `.jsonl.zstd` 由 node.exe 解码后含明文 |
| P-pty-spawn / P-pty-read | node-pty / conpty 起终端，终端里的 PowerShell 读加密文件 | 通过，已加载 `conpty.node`；读到明文 |
| SP-spill-root | `%TEMP%` 下的 spill 目录 | 通过：大输出落盘，node.exe 读回明文 |
| G-pnpm-install | pnpm 装插件 `dsh-office-tools@1.0.4` | 通过；连不上源时「跳过」 |
| D-bash / D-powershell / D-pwsh7 | node.exe 直接起 Git Bash、Windows PowerShell、PowerShell 7，读写加密文件 | 明文，说明这类子进程拿得到明文 |
| K-natives | 宿主实际加载的原生模块 | 只记录 |
| 盘上形态 | PowerShell 读每个产物的头 16 字节 | 加密目录里的产物应是「TSD 容器」。`%LOCALAPPDATA%`、`%TEMP%` 下的文件是否加密取决于策略，照记 |

**出现「失败」时先别处理，照原样发回。** 有两种失败要分开看：

1. **读到「密文」**：这正是这一关要找的结论，说明这条路径拿不到明文，不是脚本坏了。
2. **F-on-shell-* 报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`，同时 F-on-acl 没有 ACE**：
   - 原因：DSH 的 ACL 沙箱要求工作区根目录有 WRITE_OWNER 权限。`-EncDir` 只给了「修改」权限时就会这样。
   - 这一点 P0-4 CI 已经定位，与加密无关。产品在 Windows 上默认不开这个沙箱，见决策 045。
   - 补跑：如果策略也覆盖你用户目录下的某个文件夹（如 `C:\Users\<你>\Documents\…`），用它作 `-EncDir` 再跑一次主检查，补一份沙箱开的结论。没有这样的目录就不用补。

## 2. 对照组：官方 DSH Desktop

- **目的**：让官方桌面端跑同一套工具序列。
  - 它的宿主是 Electron exe 以 `ELECTRON_RUN_AS_NODE=1` 运行。调研推断它在加密机上会读到密文（ARD D11），但没实测过。
  - 对照组没有「通过 / 失败」之分，只记录它看到了什么。
- **版本与安装**：
  - 从 DeepSeek 官方渠道（官网下载页）下载 DeepSeek Harness 桌面版的 Windows 安装包，装到默认位置。
  - 优先装 **0.1.7 系列**，因为我方引擎钉的是 `0.1.7-rc.2`。拿不到就装能拿到的最新版。
  - 打开「关于」截图，记下完整版本号。

**步骤**

1. 启动一次 DSH Desktop，确认能进主界面。
   - 要求登录的话，登不登录都行。
   - **不要在里面用真实模型发任何消息。**
   - 然后从托盘菜单「退出」。
2. PowerShell 里跑：

   ```powershell
   & 'C:\p04\aiclient-p0-4-kit\run-p0-4.ps1' -EncDir 'D:\Encrypted' -ControlGroup
   ```

   脚本会临时改写 `%USERPROFILE%\.dsh\cordis.patch.yml` 和 `.env`，把 DSH Desktop 的模型指向本地假网关。原文件先备份，结束时还原。
3. 窗口出现「假网关已在 http://127.0.0.1:18484 就绪」后：
   - 启动 DSH Desktop；
   - 把工作区设为窗口里打印的 `...\ws-ctrl` 目录；
   - 模型选「P0 fake model」，通常已经是默认；
   - 把窗口里那一整行 `P0-FS {...}` 原样粘贴发送。这一行也写在报告目录的 `control-prompt.txt` 里。
4. DSH Desktop 会自己连续调用 12 次工具。
   - 脚本窗口显示「12 / 12 步」后自动收尾。
   - 卡住超过 5 分钟，就在脚本窗口按回车提前结束。
5. 脚本还原两个文件后，退出并重开 DSH Desktop，让它回到原来的配置。

**看什么**：把 `F-ctrl-*` 与主检查的 `F-on-*` 逐项对照，重点是以下三项：

- `F-ctrl-read`：Electron 宿主读到的是明文还是密文；
- `F-ctrl-grep`：rg.exe 能不能搜到；
- `F-ctrl-shell-*`。

报告里的 `powershell.machine.dshProcesses` 记着当时 DSH Desktop 的进程（exe 路径、命令行）。

**异常**：DSH Desktop 带着这份补丁起不来、弹出恢复对话框时：

- 选「Exit」，回到脚本窗口按回车。脚本照样会还原文件并写报告。
- 把弹窗截图带回来。

## 3. 发回什么

1. `C:\p04\aiclient-p0-4-kit\` 下的每个 `report-<时间>\` 目录，整个目录打包发回。
   - 主检查至少一个，对照组一个；补跑过就再多一个。
   - 每个目录里有：
     - `p0-4-report.json`：完整结果；
     - `p0-4-summary.txt`：中文摘要；
     - `p0-4-probe.log`：过程日志；
     - 对照组另有 `control-prompt.txt`。
2. DSH Desktop 版本号截图，以及过程中出现的任何弹窗或报错截图。
3. 可选：`whoami /groups | findstr /i "S-1-16- S-1-5-32-544"` 的输出。这条命令只显示完整性级别，以及是否在管理员组，用来解读 F-on-acl。

**不要发回加密文件的内容。**

- 报告里只有这几样：脚本自己写的随机标记串、本机路径、用户目录名、各测试文件的头 16 字节。
- 报告里没有你的业务文件：脚本只读写它在 `-EncDir` 下新建的子目录。
- 报告里没有密钥：脚本不读取密钥。传给宿主的环境变量也滤掉了名字里带 `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL` 的变量。
- 不要另外附上加密目录里的文件或截图。

**发回前先用记事本打开 `p0-4-summary.txt` 看一眼。**

- 能正常看到中文，就是明文，可以直接发。
- 如果脚本最后提示「报告文件本身被加密了」，或者记事本里是乱码，说明工具包目录受策略。按 0.6 换目录重跑，或走解密外发流程。

**脚本不会做的事**

- 不需要管理员权限。
- 不写注册表。
- 在 `%TEMP%`、`%LOCALAPPDATA%` 里只删它自己新建的目录。
- 对照组只动 `.dsh` 下那两个文件，结束就还原。
- 除了 pnpm 那一项会访问 npm 官方源，不联网。

## 4. 已知限制

- **只验证引擎载体。** 跑的是宿主加探针，不是安装包，也没有界面。以下都不在这一轮：
  - GUI 里的读写；
  - Main 进程侧的读，如编辑器预览、git diff（ARD D13）；
  - 安装目录 `resources\dsh-host` 里的原生件；
  - NSIS 写出的文件。

  分支还没出安装包。这些留到 P1-14 出测试版后，在加密机上再过一遍。
- **不调用真实模型。** 模型回合全部由本地假网关按脚本驱动，工具参数是固定的。模型行为、网络代理、凭据链都不在范围内。
- **roadmap P1-13 后来补登的几项没覆盖。** 以下各项等对应功能落地后，另做一次上机：
  - MCP 服务器与插件子进程读写明文：P1-16b 还没做；
  - P1-9 离线迁移工具在加密机上跑一轮；
  - Main 读取 CC / Codex 导入源。
- **权限插件**：`aiclient-permissions` 随包，但默认不启用，与当前分支一致。审批由探针自动放行，这一轮不测审批界面。
- **bash**：DSH 在 Windows 上只有 `pwsh` 工具，没有 `bash` 工具。bash 只由 D-bash 覆盖，即 node.exe 直接起 Git Bash。
- **白名单机制未知**：加密驱动按进程名、路径、签名还是父进程放行，仍未确认（ARD D11）。所以载体必须是装好的应用里的那个 `node.exe`，不要换成从别处拷来的 node。
- **G-pnpm-install 只作参考。** [决策 058](../decisions/058-plugins-preinstalled-no-pnpm.md)（待审批）打算去掉 pnpm。
- **包的来历**：
  - 上机包沿用 P0-4 的名字，从 `feat/dsh-p0-probe` 的 `b83743fe` 构建；之后分支上的改动不在包里。
  - 构建记录见交付目录（开发机 `/var/tmp/aiclient-p1-13-kit/`）的 `BUILD-INFO.txt`。
