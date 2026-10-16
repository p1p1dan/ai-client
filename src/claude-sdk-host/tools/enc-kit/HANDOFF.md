# HANDOFF：路线 B 加密机读写矩阵（给加密测试机上的 AI）

你在一台装了公司 TSD 透明加密的 Windows 机器上，很可能是在 VS Code 的 Claude 插件里。任务是用工具包测出一件事：**路线 B 的 CLI，在不同的「出身」（父进程链）下，能不能读写加密文件、能不能读回自己写的对话记录**。

> 原型阶段的第二个包（Cometix bundle 包，`ccsdk-enc-kit-bundle`）已按 2026-10-16 用户裁决删掉：只用官方 `claude.exe`。

工具包是 `ccsdk-enc-kit-npm`：被测的 CLI 是官方 SDK 自带的 `claude.exe`（Claude Code 2.1.300，Bun 编译的原生程序）。宿主 `.ts` 原样发来；脚手架以 `scaffold\*.txt` 发来，本机还原；SDK 与 `claude.exe` 在本机 `npm ci`，所以本机要有 npm。

你需要做的：
- 按 `README.txt` 准备（先还原脚手架、`npm ci`），再跑；
- 请人配合一轮加密客户端操作（见第 3 节）；
- 读结果，写一份脱敏的结论。

**不要改工具包的代码，也不要用任何绕过加密的手法**（硬链接替换、改扩展名之类）。实在跑不通、必须改时，把改动的 diff 记进结论。

## 1 背景（你需要知道的事实）

- **PiLab** 是我们的 Electron 桌面客户端，这台机器上已经装了 1.1.x。
  - 它自带的 node 在安装目录的 `resources\node-runtime\node.exe`；
  - 主程序是安装目录下的 `PiLabAi.exe`。
- **路线 B**：让 Claude 模型改由官方 Claude Agent SDK 驱动。SDK 本身只是遥控器，真正干活（调模型、读写文件、跑 Bash、写对话记录）的是它拉起的 CLI 子进程。
  - CLI 是 SDK 随包的原生 `claude.exe`，进程链 `PiLabAi.exe → node.exe（宿主）→ claude.exe`。
- **这台机器的加密是全局的**，没有「加密区」和「非加密区」之分。工具包目录、样本、报告都可能被加密。
- **测试方实测（2026-10-15）**：外来压缩包解压出来的文件会被自动加密；本机新建、本机落盘的文件不会。上一版工具包就是这样失败的：随包 node 去 `import` 解压出来的 SDK，`sdk.mjs` 是密文，报 `SyntaxError: Unexpected token '%'`。本工具包的应对：会被 node 加载的东西都在本机落盘（脚手架从 `.txt` 还原，SDK 由 `npm ci` 安装）。第 0 步会实测 node 能不能读。
- **用户已经观察到**：
  - 单独运行的 `claude.exe` 能启动，但读加密文件读到的是 TSD 密文（`%TSD-Header…`）；
  - VS Code 里的 Claude 插件却完全正常。它同样是 `claude.exe` 在读文件，推测 VS Code 在白名单里，它的子进程跟着被放行。
- **所以加密软件很可能按进程树放行。** 你在 VS Code 里启动的进程，都挂在 VS Code 下面，结果会偏乐观，不能代表 PiLab。为此工具包对每项测试都跑三种出身：

  | 出身 | 怎么起 | 代表什么 |
  |---|---|---|
  | `inherit` | 从调用者继承：你在 VS Code 里跑，就挂在 VS Code 下 | 「有白名单祖先」的情况，作对照 |
  | `detached` | 经 WMI 另起（父进程是 `WmiPrvSE.exe`），不挂在 VS Code 下 | 没有任何白名单祖先 |
  | `pilab` | 经 WMI 另起，再由 `PiLabAi.exe`（node 模式）启动 node，node 再启动 CLI | 最接近产品，也能看出 PiLab 自己有没有被放行 |

  每个输出文件的第一行是「出身 …：实际进程链；会话号」，以它为准。
- **已知（P1-13b，同类机器，从普通 PowerShell 跑）**：
  - 随包 node.exe 读 51 类已加密样本：42 类读到明文，9 类读到密文（yml、rb、php、ps1、cmd、sql、scss、docx、pptx）；
  - 这 9 类里，yml、php、ps1、cmd、sql、scss 这 6 类可以用 Windows PowerShell 5.1 读回明文；
  - 当时脚本里的 `Get-FileHash` 不可用，本工具包已经不再依赖它。
- 模型侧**只用本机假网关**（127.0.0.1，按脚本扮演模型）。不联网，不调用真实模型，不需要也不要使用任何 key 或账号。

## 2 工具包里有什么

一键脚本 `run-ccsdk-enc.ps1`（Windows PowerShell 5.1）：预检、三种出身各跑一遍流程测试、生成样本、等人工加密、读写矩阵，最后写摘要并打印到屏幕。它和其余脚手架一样以 `.txt` 发来，要先还原。

`ccsdk-enc-kit-npm` 里有：

| 文件 | 作用 |
|---|---|
| `scaffold\*.txt` | 5 个脚手架的原文：`run-ccsdk-enc.ps1`、`kit-tools.mjs`、假网关 `fake-gateway.mjs`、样本清单 `matrix-probe.mjs`、探针 `host-probe.ts`。每个开头的注释写明目标路径（`CCSDK-KIT TARGET:`）、放置目录、依赖。按 `README.txt` 第 1 步的一行命令还原 |
| `app\` | 原型宿主源码（`.ts` 原样），以及 `app\src\claude-sdk-host\package.json`、`package-lock.json`，供本机 `npm ci` |
| `kit-manifest.json` | 提交号、SDK 版本、开发机上同一份锁文件装出来的 `claude.exe` 的 SHA256（`expectedClaudeExe`，用来对照本机装的）、源码哈希 |
| `README.txt` | 给人看的流程说明，含还原命令与 `npm ci` 命令 |

## 3 要人配合的事

1. 脚本生成样本后，请人**用加密客户端把 `samples` 目录加密**。目录里有 4 个 `enc-*` 子目录，各 75 个文件：P1-13b 的 51 类，加 16 类 VS / MFC 工程文件（`ccsdk-vs.*`）和 8 类二进制 / 归档（`ccsdk-bin.*`：exe、dll、node、zip、asar、pdb、lib、obj；P1-13b 没覆盖过，而工具包自己就是靠这些扩展名活着）。
2. 全部跑完后，请人**用加密客户端检查**每个 `samples\enc-*\ccsdk-written-*` 目录里的新文件有没有被加密。

## 4 步骤

下面以 `C:\ccsdk` 为例，工具包解压成 `C:\ccsdk\ccsdk-enc-kit-npm`，下文记作 `<工具包>`。工作目录默认是 `C:\ccsdk\ccsdk-work`，样本按时间戳分开。

0. **准备**：
   - 先按 `README.txt` 第 1 步，用那一行 PowerShell 命令把 `scaffold\*.txt` 还原成 5 个原文件（也可以你自己读 `.txt` 开头的 `CCSDK-KIT TARGET:` 逐个另存；`.ps1` 存 UTF-8 带 BOM，其余 UTF-8 无 BOM）。再按第 2 步在 `app\src\claude-sdk-host` 里 `npm ci`。不要从压缩包里拷 `node_modules`。
   - **第 0 步自检**：脚本先用 PowerShell 与随包 node 各看一遍工具包自己的文件，**以 node 的视角决定能不能跑**——node 要加载的文件（`.js/.mjs/.cjs/.ts/.json`）有一个读成密文就停下，退出码 4，清单在报告目录的 `kit-encrypted.txt`。没还原或没 `npm ci` 时退出码 5。
   - 第 0 步的两行统计（PowerShell 看到多少密文、node 看到多少密文、按类型）**本身就是要写进结论的现场事实**，即使跑通了也要写。
   - `-SkipKitCheck` 可以硬跑，但多半会在后面莫名失败，只在确实需要取证时用。
1. **位置**：见上。
2. **启动**：整轮约 45 分钟，比一般工具调用的超时长，请**在后台运行**，然后定期看输出：

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File <工具包>\run-ccsdk-enc.ps1 -ManualEncryption -ConfirmFile
   ```

   - 报告目录是 `<工具包>\report-ccsdk-<时间>\`。
   - 进度在屏幕输出与其中的 `run.log` 里。
   - `-ConfirmFile` 让加密那一步改为等确认文件，不在窗口里提问。
3. **CLI 起不来**（`claude.exe --version` 失败）：脚本会退出，退出码 2。把 SHA256 与屏幕上的错误记下，跳到第 7 步。
4. **等人加密**：
   - 报告目录里出现 `WAITING-FOR-ENCRYPTION.txt` 时，里面的 `samples=` 就是要加密的目录。请人用加密客户端加密它。
   - 人确认加完之后，新建报告目录里的 `manual-encryption-confirmed.txt`，第一行写 `CONFIRMED`。脚本两秒内继续。
   - 人放弃就写 `ABORT`。
5. **等跑完**：
   - 4 轮矩阵，每轮约 4 分钟，加 300 秒复查落盘。
   - 结束时屏幕上有 `===== SUMMARY BEGIN =====` 到 `===== SUMMARY END =====` 的完整摘要，以它为准。
   - `detached` 与 `pilab` 两种出身的进程在后台，中途不要杀 `powershell.exe`、`node.exe`、`claude.exe`。
6. **请人检查新文件**：
   - 按第 3 节第 2 条请人检查，结果写进报告目录的 `notes.txt`；
   - 例如：「enc-2 的 ccsdk-written：md、yml 被加密，其余没有」。
7. **写结论**：
   - 写成报告目录里的 `RESULT.md`，格式见第 6 节；
   - **同时把全文贴在你的回复里**，用户会转给开发者。

**读文件**：如果你的 Read 工具读到的是 `%TSD-Header…`，改用随包 node 读：

```
& "<PiLab 安装目录>\resources\node-runtime\node.exe" <工具包>\kit-tools.mjs cat <文件>
```

## 5 怎么读输出

摘要（`summary.txt`，也就是屏幕上 SUMMARY 那一段）按出身分节。完整输出在 `flow-<出身>.txt`、`resume-<出身>.txt`、`enc-<n>-<出身>-<rg>.txt`。

探针每个场景末尾有确定性检查（`[check]` 行），有一条不过就以退出码 1 结束；摘要里的 `PROBE CHECKS` 一行写明过了几条，`[check] FAIL` 各行写明是哪几条没过。退出码 1 而摘要里没有 `PROBE CHECKS` 行，说明探针自己出错了（例如宿主进程中途退出），原因在对应的完整输出文件末尾的 `PROBE FAILED` 一行。

**流程**（`== 流程（出身 …）`）：
- `text` 与 `tools` 应以 `session.completed` 结束，`tools` 会出 `card:`（审批卡）；
- `stop` 应以 `session.stopped` 结束；
- `sleep processes: … after-stop` 应在几秒内降到 0。

**重开续聊**（`== 重开续聊（出身 …）`）：
- 第二个 `=== history` 的条数应比第一个多 3；
- 「最后一次请求」应是 `firstUserIsProbeText: true`，`messages` 是 5 左右；
- 做不到，说明这种出身下 CLI 读不回自己的对话记录。

**矩阵**（`== enc-<n>-<出身>-<rg>`）：
- 第一行是出身与进程链；
- `统计` 一行是各格子取值的计数；
- `落盘` 一行写的是复查时点，以及 transcript（对话记录）两个读者的结果；
- 之后每个样本一行：`文件名 | 各格子 | edited node=… ps51=… | written node=… ps51=…`。

| 格子 | 做了什么 | 取值 |
|---|---|---|
| Read | CLI 读样本 | `plain`（明文）/ `cipher`（TSD 密文）/ `error`（CLI 拒绝）/ `other` |
| Grep | rg 搜标记串。`builtin-rg` 轮用 CLI 自己的 rg（`claude.exe` 内置的），`bundled-rg` 轮用 PiLab 随包的 `rg.exe` | 同上。`other` 一般是 No matches，说明 rg 读到的不是明文 |
| cat / sed | Git Bash 工具链读 | 同上 |
| Edit | 改已加密的样本 | `ok` / `failed` / `cipher` |
| Read2 | 改完再读 | `plain-edited` 表示改动读得回 |
| Write | 在 `ccsdk-written-*` 里新建同名文件 | `ok` / `failed` |
| Read3 | 读新建的文件 | `plain-written` 表示读得回 |

- `.docx`、`.xlsx`、`.pptx` 的 Read 是 `error`，`.pdf` 是 `other`：CLI 按扩展名拒读二进制，与加密无关。
- **落盘**的 `node=` 与 `ps51=` 是探针进程里的 node，以及它起的 PowerShell 5.1 读到的。它们与这一轮同出身：`pilab` 轮里看到的，就是挂在 PiLab 下的 node 能读到什么，也就是现在产品的 DSH 引擎能读到什么。取值有：
  - `TSD`：已加密；
  - `edited`：读到改后的明文；
  - `written`：读到新文件的明文；
  - `marker`：读到原样本；
  - `json`：对话记录是明文 JSON；
  - `other`；
  - `missing`。
- **任一读者看到 `TSD`，就是已加密。** 但读者本身可能因出身被放行而看到明文，所以新文件到底有没有加密，以人工用加密客户端确认的为准。
- 各出身的 `node=` 对比本身也是结论：`pilab` 轮里 node 若能读出那 9 类，说明挂在 PiLab 下的 node 比 P1-13b（从普通 PowerShell 跑）放得更宽。

## 6 结论怎么写（`RESULT.md`，并贴在回复里）

**脱敏**：不写机器名、用户名、域名、完整路径（路径写成 `<安装目录>\…`、`<工作目录>\…`），不贴文件内容。原始输出留在本地，不要上传到任何地方。

按下面的结构写：

1. **环境**：
   - 准备：脚手架还原与 `npm ci` 是否顺利（`npm ci` 的耗时、有没有报错、用没用镜像）；
   - 第 0 步的两行：PowerShell 看到多少个密文、node 看到多少个、按类型；node 要加载的文件有没有读成密文；
   - Windows 版本，是否管理员；
   - PiLab 版本，node 版本，CLI 版本与 SHA256（对照 `kit-manifest.json` 的 `expectedClaudeExe`）；
   - 有没有 Git Bash，随包 rg 找到没有；
   - 你自己所在的进程链，即摘要里「本脚本的出身」。
2. **三种出身的进程链**：每种实际是什么，以及会话号。
3. **按出身对比**（核心）：每种出身一列，回答下面这些问题：
   - 流程、停止是否通过，sleep 是否清零；
   - 重开续聊是否通过；
   - 矩阵的统计：Read / Grep / cat / sed 各有多少 `plain` / `cipher` / `other`，Edit / Write 有多少 `ok`；
   - 在 node 读得出明文的 42 类与读成密文的 9 类上，结果分别怎样。
4. **VS / MFC 工程文件**（`ccsdk-vs.*` 16 类）与**二进制 / 归档**（`ccsdk-bin.*` 8 类）各列一张表，按出身对比。
   - 用户在产品里读 `.vcxproj` 时遇到过 `FS_ENCRYPTED`：node 与 PowerShell 读到的都是密文。
   - 重点看：`pilab` 出身下 CLI 与 node 能不能读出明文。
   - 二进制那张表还要回答：`.exe`、`.dll`、`.node`、`.zip` 会不会被加密。这决定工具包、以及将来随安装包发出去的 `claude.exe` 在这台机器上能不能活下来——也对照第 0 步的结果。
5. **随包 rg 与内置 rg** 有没有差别（`bundled-rg` 那轮与同出身的 `builtin-rg` 那轮比较）。
6. **新建文件**有没有被加密，哪几类。把人工确认（`notes.txt`）合进来。
7. **判定**：按下表选一行，写明理由。

   | 观察到的 | 说明 | 方案 |
   |---|---|---|
   | `pilab` 也是明文 | PiLab 本身已被放行 | 路线 B 在 PiLab 下可直接用 |
   | `inherit`（VS Code 下）明文，`detached` 与 `pilab` 是密文 | 按进程树放行，PiLab 不在白名单里 | 请 IT 像 VS Code 一样放行 `PiLabAi.exe`，加完后用本工具包复测 `pilab`；不能加的话，把 Read / Edit / Write / Grep 经 SDK 的 `toolAliases` 转给宿主（随包 node）执行，复用 PowerShell 回退 |
   | 三种出身都是密文 | 与出身无关 | 同上一行的 `toolAliases` |
   | 某出身下对话记录读不回 | CLI 写的 transcript 被加密 | 用 SDK 的 `sessionStore` 把 transcript 镜像到宿主进程 |

8. **异常与疑点**：任何超时、退出码非 0、`launch-failed`、与预期不符的地方，都如实写。

## 7 出问题时

- **找不到 PiLab**：加 `-AppDir "<安装目录>"`。
- **端口被占用**：加 `-Port 18990`。
- **WMI 起不来**（摘要里出现 `launch-failed`）：
  - `detached` 与 `pilab` 两种出身会缺失，在结论里写明；
  - 再请人从开始菜单打开一个**普通的** Windows PowerShell，手动跑一遍下面的命令。这时 `inherit` 就是「挂在资源管理器下」，可以作为没有 VS Code 祖先的替代。

    ```
    powershell -NoProfile -ExecutionPolicy Bypass -File <工具包>\run-ccsdk-enc.ps1 -ManualEncryption -Contexts inherit
    ```
- **中途失败要重跑**：
  - 直接再跑即可，每次都是新的时间戳目录和新样本；
  - 新样本要重新请人加密；
  - 只想补跑某一种出身，用 `-Contexts detached` 之类；
  - 跳过流程测试用 `-SkipFlow`。
- CLI 的配置与对话记录在 `%USERPROFILE%\.pilab\ccsdk-probe-<时间>\`，不含凭据。结论写完后可以删。
