# P0-4 加密机上机检查单（DSH 宿主 + 官方 DSH Desktop 对照组）

Role: detail shard。上位：[roadmap P0-4](../roadmap.md)。结论回填 [Q002](../open-questions.md#q002-dsh-沙箱能否作为兜底层叠加)。工具包怎么做出来的、Linux 上预演了什么：[证据](../evidence/p0-4-kit-2026-09-25.md)。

全程约 30 分钟：主检查 5～10 分钟，对照组约 15 分钟。**不需要管理员权限。不连任何真实模型服务**：模型回合全部打到脚本自己起的本地假网关（`127.0.0.1`）。

---

## 0. 准备

| # | 事项 | 怎么做 | 判据 |
|---|---|---|---|
| 0.1 | 应用 | 用已装好的 PiLab Ai（当前 1.0.x 安装包即可，脚本只借用它的 `resources\node-runtime\node.exe`）。PowerShell 里跑 `& "$env:LOCALAPPDATA\Programs\PiLab Ai\resources\node-runtime\node.exe" -v` | 输出 `v24.18.0`。装在别的目录就记下来，后面用 `-AppDir '<安装目录>'` 传 |
| 0.2 | 工具包 | 把 `aiclient-p0-4-kit-win32-x64.zip`（约 40 MB，校验值见同名 `.sha256`）拷到**不受加密策略的短路径**，如 `C:\p04\`，右键「全部解压缩」或 `tar -xf` | 得到 `C:\p04\aiclient-p0-4-kit\run-p0-4.ps1`。路径超过 60 个字符脚本会提醒 |
| 0.3 | 加密目录 | 选一个**受 TEC 策略覆盖**的目录，如 T033 用过的 `D:\Encrypted` | 脚本在里面建 `p0-4-<时间>` 子目录，跑完删掉 |
| 0.4 | 标记文件 | 不用手工造。脚本用 PowerShell 在加密目录写 `P04-ENC-MARKER-xxxxxxxx` 标记文件，再由 PowerShell 读文件头 16 字节 | 摘要第一段写「前提：成立」＝文件在盘上是 `%TSD-Header-###%` 容器 |
| 0.5 | 可选项 | Git Bash（默认找 `C:\Program Files\Git\bin\bash.exe`，别处用 `-GitBash '<bash.exe>'`）；有 PowerShell 7 会一起测；能连 npm 源会测 pnpm 装插件 | 缺哪样，那几项记「跳过」，不算失败 |

**顺序**：先做第 1 节，再装官方 DSH Desktop 做第 2 节。两者共用 `%LOCALAPPDATA%\node-addon-native-custom-loader` 缓存目录，先装对照组会让 B1 变成「沿用已有缓存」。

---

## 1. 主检查：我方 DSH 宿主跑在随包 node.exe 上

开一个**普通** PowerShell 窗口（开始菜单里蓝色的 Windows PowerShell 即可）：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& 'C:\p04\aiclient-p0-4-kit\run-p0-4.ps1' -EncDir 'D:\Encrypted'
```

- 等 5～10 分钟，中途别动加密目录。出错也让它跑完，脚本出错同样会写报告。
- 结束时窗口打印中文摘要，报告在 `C:\p04\aiclient-p0-4-kit\report-<时间>\`。
- 其他参数：`-SkipPnpm`（不测装插件）、`-KeepWork`（保留加密目录里的工作目录，排查用）。

### 每项「通过」长什么样

摘要里每行的格式是 `[通过/失败/跳过/记录/出错] 编号 名称 —— 实际看到的内容`。「明文」是指读回的内容里有标记串，「密文」是指读回的是 `%TSD-Header-###%` 容器。

| 编号 | 查什么 | 通过的样子 |
|---|---|---|
| 前提、N0 | 标记文件确实加密；node.exe 直接读 | 「前提：成立」；N0 读到明文。**前提不成立，后面所有「明文」都不能签收**，照跑并带回 |
| B2 / B3 / B1 | 宿主启动三次：原生缓存关（原地加载）/ 缓存放在加密目录 / 默认缓存（`%LOCALAPPDATA%`） | 三行都「通过」，写明「原地加载」或「从缓存副本加载」。B1、B3 显示「记录：缓存静默回退」不算失败，但要带回 |
| F-on-* | 沙箱开（workspace-write，Windows 上是 ACL 受限令牌）：read、edit、write、grep、glob、pwsh 读 / 写 / 大输出，再用 read 读回 pwsh 写的文件 | read / edit / write 与回读全部明文；grep 搜得到 `edit-target.txt`；glob 列得出文件；`F-on-node-verify` 通过 |
| F-off-* | 沙箱关（danger-full-access）：同上一套 | 同上 |
| F-*-shell-read / P-pty-read / D-* | pwsh 工具、终端里的 PowerShell、node.exe 直接起的 Git Bash / PowerShell 读加密文件 | 明文＝这个子进程在白名单内。**密文不是脚本坏了，而是要带回的结论**：说明这条路径读不到明文。D-bash 与 T033 的 ENC-20 对照 |
| L-lock-held / L-lock-released | 会话写锁（Windows 上是 koffi 调命名信号量） | 第二个宿主打不开被占用的会话（报 `SessionAlreadyOwned`）；第一个关掉后能打开 |
| L-recall / S-log-plaintext | 会话写入后回读 | 恢复后的对话历史里仍有明文标记串；会话日志（`.jsonl.zstd`）由 node.exe 解码后含明文 |
| P-pty-spawn | node-pty / conpty 起终端 | 通过，并列出已加载的 `conpty.node` |
| SP-spill-root | `%TEMP%` 下的 spill 根目录 | 通过（大输出落盘，node.exe 读回明文）或「记录」。失败＝报 unsafe root，或 spill 文件读成密文 |
| G-pnpm-install | pnpm 装社区插件 `dsh-office-tools@1.0.4` | 通过，或离线时「跳过」 |
| 盘上形态 | PowerShell 读每个产物的头 16 字节 | 加密目录里的产物应是「TSD 容器」；`%LOCALAPPDATA%`、`%TEMP%` 下的文件是否加密，取决于策略，照记 |

---

## 2. 对照组：官方 DSH Desktop 0.1.7

目的：同一套工具序列，由官方桌面端来跑。它的宿主是 Electron exe 以 `ELECTRON_RUN_AS_NODE=1` 运行的，调研推断在加密机上会读到密文（ARD D11），但**没有实测过**。

**安装**：从 DeepSeek 官方渠道（官网下载页，安装包来自 `download.deepseek.com`）下载 DeepSeek Harness 桌面版的 **0.1.7 系列** Windows 安装包，装到默认位置。打开「关于 DeepSeek Harness」截图，记下完整版本号。拿不到 0.1.7 就装能拿到的最新版，并注明版本。

**步骤**

1. 启动一次 DSH Desktop，确认能进主界面。要求登录的话，登不登录都行；**不要在里面用真实模型发任何消息**。然后从托盘菜单「退出」。
2. PowerShell 里跑：

   ```powershell
   & 'C:\p04\aiclient-p0-4-kit\run-p0-4.ps1' -EncDir 'D:\Encrypted' -ControlGroup
   ```

   脚本会临时改写 `%USERPROFILE%\.dsh\cordis.patch.yml` 和 `.env`，把 DSH Desktop 的模型指到本地假网关（原文件先备份，结束时还原）。
3. 窗口出现「假网关已在 http://127.0.0.1:18484 就绪」后：
   - 启动 DSH Desktop；
   - 把工作区设为窗口里打印的 `...\ws-ctrl` 目录；
   - 模型选「P0 fake model」，通常已经是默认；
   - 把窗口里那一整行 `P0-FS {...}` 原样粘贴发送。这一行也写在报告目录的 `control-prompt.txt` 里。
4. DSH Desktop 会自己连续调用 12 次工具。脚本窗口显示「12 / 12 步」后会自动收尾。卡住超过 5 分钟就在脚本窗口按回车提前结束。
5. 脚本还原两个文件后，退出并重开 DSH Desktop，让它回到原来的配置。

**对比什么**：报告里 `F-ctrl-*` 与主检查的 `F-on-*` 逐项对照，重点看以下三处：

- `F-ctrl-read`：Electron 宿主读到的是明文还是密文。
- `F-ctrl-grep`：rg.exe 能不能搜到。
- `F-ctrl-shell-*`。

报告的 `powershell.machine.dshProcesses` 记录了当时 DSH Desktop 的进程（exe 路径、命令行），用来确认宿主是哪个 exe。对照组没有「通过 / 失败」之分，只记录它看到的是什么。

**异常**：DSH Desktop 带着这份补丁起不来、弹恢复对话框时，选「Exit」，回脚本窗口按回车。脚本照样会还原文件并写报告。请把弹窗截图带回来。

---

## 3. 发回什么

1. 两个 `report-<时间>\` 目录（主检查一个，对照组一个），整个打包发回。里面有：
   - `p0-4-report.json`
   - `p0-4-summary.txt`
   - `p0-4-probe.log`
   - 对照组另有 `control-prompt.txt`
2. DSH Desktop 的版本号截图，以及过程中的任何弹窗或报错截图。
3. 脚本最后如果提示「报告文件本身被加密了」：走解密外发流程，或者把工具包挪到不受策略的目录再跑一次。

报告里有本机路径和用户目录名，不含任何密钥：脚本不读取密钥，传给宿主的环境变量也滤掉了名字里带 `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL` 的变量。

**脚本不会做的事**：
- 不需要管理员权限。
- 不写注册表。
- 在 `%TEMP%` 和 `%LOCALAPPDATA%` 里只删它自己新建的目录。
- 对照组只动 `.dsh` 下这两个文件，结束就还原。

执行策略被组策略锁死（`Set-ExecutionPolicy` 报错）、或杀毒软件拦截 `rg.exe` / `OpenConsole.exe` / `node.exe` 时，停下来截图反馈，不要自己绕过。
