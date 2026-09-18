# T033 自测分片 03 · PKG 组（打包态 / utility 载体，23 项）

Role: detail shard。上位：[自测总纲](00-总纲.md)。顺序与档位来自[执行单](../../t033-field-day-runbook.md)，判据权威是 [checklist-e.md](../../../checklist-e.md)（第 4 节 utility 表 + 第 2 节新增项 + 第 5.1 节判据更正）。编排器版分片：[03-pkg.md](../03-pkg.md)。**判据与本文冲突时以 checklist-e.md 为准。**

**开工前**：[总纲 §4「第 0 步」](00-总纲.md#4-第-0-步开工前必须做完的七件事)七件事必须全部做完，尤其是第 0.6 条（带 trace 变量启动）。

本分片 23 项的档位分布：**【必】12 · 【绿】3 · 【探】6 · 【不做】1**（PKG-03 与 PKG-16 是同一件事，合并成一项做）。

---

## 0. 这份文件怎么用

每一项都长成同一个样子：**准备 → 操作 → 看什么 → 记录**。「看什么」里的判据是从检查单逐字搬过来的（用 5.1 更正后的版本），并写清「通过长什么样」「不通过长什么样」。

标签的意思（来自执行单第 7 节的砍单三刀）：

| 标签 | 含义 | 时间不够时 |
|---|---|---|
| 【必】 | 第一刀。不做就不能签收 | 一项都不能砍 |
| 【绿】 | 第二刀。做完能让某个计划节点从「未验」转绿 | 必做完了再做 |
| 【探】 | 第三刀。纯探索，结论是「有没有」 | 可以整组砍掉 |
| 【不做】 | 已结案或判据环境不具备，一行写明原因，直接记 🚫 | —— |

每项只有三种收尾，**不接受只写「通过」**：

- ✅ 判据全部满足，挂上证据文件；
- ⛔ 判据有任何一条不满足，挂证据 + 写一句「实际看到什么」；
- 🚫 当天没做，写明原因（时间不够 / 条件不具备）。

**证据放 `C:\t033\evidence\pkg\`，文件名 `pkg-<两位编号>-<英文短横线 slug>.<扩展名>`**，例如 `pkg-04-utility-three-features.png`。文件末尾有结果表，做一项填一行。

---

## 1. 开工前的一次性准备

### 1.1 路径与变量

在 PowerShell 窗口里先执行一次（**之后每开一个新窗口都要重执行一遍**）：

```powershell
$app       = "$env:LOCALAPPDATA\Programs\AiClient"
$exe       = "$app\AiClient.exe"
$node      = "$app\resources\node-runtime\node.exe"
$piCli     = "$app\resources\agent-host\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
$userData  = "$env:APPDATA\jyw-ai-client"
$stateRoot = "$env:USERPROFILE\.pilab\jyw-ai-client"
$agentDir  = "$stateRoot\pi-agent"
$logDir    = "$userData\logs"
$idx       = "$userData\session-index.json"
$ev        = 'C:\t033\evidence\pkg'
New-Item -ItemType Directory -Force -Path $ev, 'C:\t033\trace' | Out-Null
. C:\t033\t033-helper.ps1       # Start-AiClient / Stop-AiClient / Get-Trace / Get-AiClientTree / Get-Head16 / Save-Evidence
$T033App = $app                 # 安装目录改过的话这一行必须执行
& $node -v                      # 期望 v24.18.0；报错说明随包 Node 路径不对，先查 $app
```

### 1.2 每次启动应用都这样启动

```powershell
$env:AICLIENT_RUNTIME_TRACE_DIR = 'C:\t033\trace'
& $exe
```

（等价于 `Start-AiClient`。）**不设这个变量 trace 就只留在内存里，`runs.jsonl` 根本不会出现**——凡是判据里写「抓 trace」的项，第一步都是它。收集 trace 证据时用 `runs*` 通配会带出一个 `runs.rotate.lock`，那是锁文件，**要过滤掉**。

### 1.3 日志在哪

| 文件 | 路径 | 里面有什么 |
|---|---|---|
| **按天日志（主日志）** | `$logDir\aiclient-<年-月-日>.log` | 日志开关关闭时 file 档是 `info`，绝大多数日志行在这里 |
| `main.log` | `$logDir\main.log` | electron-log 的默认文件，**不是主日志**；worker 崩溃回放（`console.error`）两个文件里都有 |

```powershell
$today = "$logDir\aiclient-$(Get-Date -Format yyyy-MM-dd).log"
```

### 1.4 一条会影响半个分组的载体事实（先读，别跳过）

**Windows 打包态没有 electron-utility worker。** 源码 `src/main/services/agent-host/PiWorkerProcess.ts:79-92` 写死：`app.isPackaged && process.platform === 'win32'` 时，worker 一律用 `spawn(<安装目录>\resources\node-runtime\node.exe)` 起（载体名 `bundled-node`），只有非 Windows 才走 `utilityProcess.fork(...)`。而且**三个 utility 功能（代码评审 / 分支命名 / 提交信息）走的是同一个 fork 函数**，所以它们在 Windows 上也是 `node.exe` 子进程。

由此产生两个后果，本组多处要用到：

1. 任务管理器里**不会出现** `AiClient Pi Worker N` 这个进程名（那个名字只在 `utilityProcess` 分支才设），Windows 上 worker 表现为 `node.exe`，父进程是 `AiClient.exe`；
2. 判据里写「electron-utility 载体」的项（PKG-02 / PKG-03+16 / PKG-08 / PKG-09 / PKG-10 / PKG-17 / PKG-18 的一半）在这台机器上**没有那个载体可测**。本文每一项都写清了：哪一半能在 Windows 拿到、哪一半只能记 🚫 并注明「留 Linux/macOS 打包产物」。

数 worker 进程用这条（`Get-AiClientTree` 是同一件事的快捷方式）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, ParentProcessId, CommandLine | Format-List
```

### 1.5 开工前存一份本组自己的基线

（总纲 §0.7 的 `Snap-Baseline` 是全天的基线；这一份是本组进出对比用的。）

```powershell
Get-Process | Select-Object Id, ProcessName, Path | Sort-Object ProcessName > "$ev\pkg-00-baseline-processes.txt"
Get-FileHash -Algorithm SHA256 "$app\AiClient.exe" >> "$ev\pkg-00-baseline-processes.txt"
```

> 本组**没有**已结案项（WIN-19 那条已结案的是 WIN 组的）。唯一一条 【不做】是 PKG-19，原因写在它自己那一节。

---

## 轮 P-a · utility 通道三功能与容量（约 45 min）

三项共用同一次应用启动，一起做完再退出。

### PKG-04 utility 在 Electron utility 载体上的端到端 【必】

**准备**

1. 设置 → AI 功能里确认三个功能都开着：提交信息生成、代码评审、分支名生成；
2. 打开一个**有真实改动**的 Git 仓库作为工作区（没有就随便改两个文件，`git add` 与否都行）；
3. 按 1.2 启动应用。

**操作**

1. 在源代码管理面板的提交框里点「生成提交信息」按钮（放大镜/星标那个，悬停提示是「生成提交信息」），等它写完。
2. 在同一面板的改动列表上触发一次「代码评审」，等评审面板出正文。
3. 新建工作树（worktree）对话框里点分支名生成，等它给出分支名。
4. 三次都做完后，数一次进程：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine |
  Out-File "$ev\pkg-04-worker-lifecycle.txt" -Encoding UTF8
```

5. 记下这三次调用各自用的模型。**注意：utility 这条链是关掉 trace 跑的**（源码 `src/runtime/worker/nativeUtility.ts:154` 建 runtime 时写死 `traceDir: null`），所以 `runs.jsonl` 里**不会有**这三次调用——模型名要从界面上抄：设置 → AI 功能里三个功能各自的模型选择框，以及评审面板标题旁显示的那个模型名。抄进 `pkg-04-utility-models.txt`。
6. 三个功能的结果各截一张图，合并存成 `pkg-04-utility-three-features.png`。

**看什么**

判据（检查单 PKG 表第 4 项原文）：「三个功能在打包态各跑一次成功回合；worker 进程在结算后确实退出（无残留）」，取证方式是「任务管理器 / ps 观察 `AiClient Pi Worker N` 的生灭；同时记录 `utility.terminal` 的 `state` 与 `model`」。

- **通过**：三个功能各出一次真实结果（提交信息、评审正文、分支名），并且第 4 步数出来的 `node.exe` 只剩下**会话 worker 该有的那些**——每个打开的聊天一个，没有多出来的、命令行里带 worker 入口的孤儿进程。
- **不通过**：任一功能报错或空结果；或者三次结算之后 `node.exe` 数量比开始时多，多出来的进程命令行指向应用的 worker 入口。
- **两处与判据字面对不上、属预期，不判负**：① Windows 上没有 `AiClient Pi Worker N` 这个进程名（见 1.4），照 `node.exe` 数即可，**在记录里写明你是按进程名 `node.exe` 数的**；② `utility.terminal` 是 worker 发给主进程的内部事件，打包态没有任何界面或日志把它的 `state` 印出来，而且这条链关着 trace（见操作第 5 步）——**能拿到的替代物是界面上的模型名 + 功能成功/失败**，照这个记，并在记录里写一句「`state` 在打包态无可见出口，utility 链 `traceDir: null` 故 trace 里也没有」。

**记录**

`pkg-04-utility-three-features.png`、`pkg-04-worker-lifecycle.txt`、`pkg-04-utility-models.txt`；结果表里填 ✅/⛔/🚫 + 一句现象。

> **顺带把 ENC-1 的三个数测出来（冷启动耗时，那一项归 [01-ENC](01-ENC.md) 分片，记法以它为准）**：本轮三个功能里挑一个（推荐「生成提交信息」，最快），**连点三次、每次之间把应用关掉再开**，用手机秒表或 `Measure-Command` 记「点下去 → 面板出现第一个字」的秒数。原判据是「连续三次冷启动的最大值 < 10s 才算通过」；打包态量不到 `utility.start → ack` 那一段（不打日志、这条链又关着 trace），所以按 checklist 5.1 新增的那条更正记「点击 → 出结果」的**上界**，并注明 10 秒请求超时没有触发（常量见 `PiUtilityService.ts` 的 `DEFAULT_REQUEST_TIMEOUT_MS = 10_000`）。三个数写进 `C:\t033\evidence\enc\enc-01-utility-coldstart.txt`，结果填在 ENC 分片的结果表里，不占 PKG 的行。

---

### PKG-06 并发点击与容量上限 【必】

**准备**：接着 PKG-04 的同一次启动，不要退出应用。

**操作**

1. 先触发一个**慢的**功能：对一个大改动跑「代码评审」（它要跑几十秒，正好占着一个槽）。
2. 评审还在跑的时候，立刻点「生成提交信息」（第二个槽）。
3. 两个都还在跑的时候，点第三个功能（分支名生成）。
4. 第三个的提示一出现就截图，存 `pkg-06-capacity-message.png`；把提示文字**原样抄进** `pkg-06-capacity-message.txt`。

**看什么**

判据（PKG 表第 6 项原文）：「评审 + 提交信息占满 capacity=2 后，第三个功能给出的提示文案是否为界面语言且可操作」。（容量 2 是代码里的默认值：`PiUtilityService.ts` 的 `capacity ?? 2`。）

- **通过**：第三个功能被挡住，并且提示是**中文**（界面语言）、能看出下一步该干什么（例如「等前面两个跑完再试」这种意思）。
- **不通过**：提示是英文原文（源码里这条错误的英文是 `Too many AI utility operations are already running`）、或者只弹一个错误码、或者第三个功能没被挡住直接也跑了起来。**看到英文就是 ⛔，照抄原文即可，这正是这一项要问的事。**

**记录**：`pkg-06-capacity-message.png`、`pkg-06-capacity-message.txt`。

---

### PKG-05 超时的用户可见表现 【必】

**准备**

- 评审超时是 10 分钟（源码 `src/main/services/ai/code-review.ts:105` 的 `timeoutMs: 10 * 60_000`），**打包态改不了这个数**（代码在 asar 里）。所以只有一条路：**拿一个超大 diff 把这 10 分钟跑满**。
- 造大 diff 的办法：在工作区里生成一个几万行的文件并改它，例如

```powershell
1..40000 | ForEach-Object { "line $_ : the quick brown fox jumps over the lazy dog" } |
  Set-Content C:\t033\bigdiff\huge.txt
```

把这个文件放进被评审的仓库、`git add` 之后再全文替换一遍，让 diff 足够大。
- 开始前打开录屏（Win+G 也行）。

**操作**

1. 对这个超大 diff 触发「代码评审」，开始录屏并记下开始时间。
2. 等到超时发生（最多 10 分钟）。超时那一刻起，**依次回答四个问题并说出声录进去**：
   - 面板里已经生成的正文还在不在？
   - 复制按钮还能不能点、点了有没有复制成功？
   - 有没有「重试」入口、点了有没有反应？
   - 跑评审的那个 worker 进程还在不在？（答案来自下一步的进程快照）
3. 超时后立刻数进程：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine |
  Out-File "$ev\pkg-05-processes.txt" -Encoding UTF8
```

**看什么**

判据（PKG 表第 5 项原文）：「10 分钟评审超时后：面板是否还显示已生成正文、复制按钮是否仍可用、能否重试、worker 是否残留」。这是一条**记录型**判据——四问各记一句就算完成，没有「必须是某个答案」。

- **算做完**：四个答案都有明确的一句话，加上进程快照里看得出那个跑评审的 `node.exe` 有没有活着。
- **算没做完（⛔ 或 🚫）**：跑不满 10 分钟（模型先返回了、或者报了别的错），说明没触发超时；这时记 🚫 并写明「未能构造出超时：实际在第 N 秒返回了 X」。

**记录**：`pkg-05-review-timeout.mp4`（录屏）、`pkg-05-processes.txt`、四问的答案写进 `pkg-05-four-answers.txt`。

---

## 轮 P-b · worker stderr 的三条（约 40 min）

这三项原判据都要「一个会往 stderr 打印的假 provider / 子进程」。打包态没法往 worker 里塞代码，**但有一条现成的、只用产品功能的路**：给会话配一个 stdio MCP 服务器，它的 stderr 会被 worker 原样打进自己的 stderr（源码链路：MCP 插件 `onStderr` → `config.log` → `src/agent-host/worker.ts:142` 的 `console.error('[pi-worker', …)`）。这就是本轮三项共用的造法。

### 轮 P-b 的公共准备（做一次，三项共用）

1. **写噪声 MCP 服务器脚本**（纯 Node、零依赖）：

```powershell
New-Item -ItemType Directory -Force -Path C:\t033\mcp | Out-Null
$js = @'
import { createInterface } from 'node:readline';
const mode = process.argv[2] || 'env';
const delayMs = parseInt(process.argv[3] || '0', 10) || 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'noisy-probe', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
  } else if (m.id !== undefined && m.id !== null) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
});
setTimeout(() => {
  if (mode === 'env') {
    process.stderr.write('NOISY_OPENAI_API_KEY=sk-proj-T033FAKEFAKEFAKEFAKEFAKEFAKE1234\r\n');
    process.stderr.write('Authorization: Bearer t033-fake-bearer-token-abcdef123456\r\n');
    process.stderr.write('ANTHROPIC_API_KEY=sk-ant-T033FAKEFAKEFAKE0000\r\n');
    process.stderr.write('cwd=' + process.env.USERPROFILE + '\\t033\\evidence\r\n');
  } else if (mode === 'chunked') {
    const body = 'CHUNKED-LINE|' + 'x'.repeat(60) + '|END';
    process.stderr.write(body.slice(0, 20));
    setTimeout(() => process.stderr.write(body.slice(20, 45)), 200);
    setTimeout(() => process.stderr.write(body.slice(45) + '\r\n'), 400);
  } else if (mode === 'flood') {
    for (let i = 1; i <= 60; i += 1) {
      const tail = i === 7 ? ' LEAK ANTHROPIC_API_KEY=sk-ant-T033FAKEFAKEFAKE0000' : '';
      process.stderr.write('noisy line ' + i + tail + '\r\n');
    }
  }
}, delayMs);
'@
[System.IO.File]::WriteAllText('C:\t033\mcp\noisy-mcp-server.mjs', $js, (New-Object System.Text.UTF8Encoding($false)))
& $node C:\t033\mcp\noisy-mcp-server.mjs env 0   # 冒烟：应当立刻在屏幕上打出四行噪声，然后停住等输入；Ctrl+C 退出
```

2. **把它注册成 MCP 服务器**（user 层，路径 `<agentDir>\mcp.json`）。**必须写成不带 BOM 的 UTF-8**，否则应用的 `JSON.parse` 会直接失败：

```powershell
$mcp = @'
{
  "mcpServers": {
    "noisy": {
      "command": "REPLACE_NODE",
      "args": ["C:\\t033\\mcp\\noisy-mcp-server.mjs", "REPLACE_MODE", "REPLACE_DELAY"],
      "env": {}
    }
  }
}
'@
$mcp = $mcp.Replace('REPLACE_NODE', $node.Replace('\','\\')).Replace('REPLACE_MODE','env').Replace('REPLACE_DELAY','0')
[System.IO.File]::WriteAllText("$agentDir\mcp.json", $mcp, (New-Object System.Text.UTF8Encoding($false)))
Get-Content "$agentDir\mcp.json"
```

换模式时把 `REPLACE_MODE` 换成 `chunked` / `flood`、`REPLACE_DELAY` 换成延迟毫秒数，重写这个文件再重开会话即可。

3. **三项做完后删掉这个文件**（`Remove-Item "$agentDir\mcp.json"`），否则后面每个会话都会起这个噪声服务器。

---

### PKG-01 worker stderr 落进日志的内容是否脱敏 【必】

**准备**：按上面的公共准备，模式用 `env`、延迟 `0`。

**操作**

1. 记下当前日志末尾位置：`(Get-Item $today).Length`（文件不存在就跳过）。
2. 启动应用，开一个会话并发一句话（让 worker 真的起来、MCP 真的连上）。
3. 等 10 秒，然后**强杀这个会话的 worker**，逼出崩溃回放段：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
taskkill /PID <上一步里那个 worker 的 pid> /F
```

4. 抓日志：

```powershell
Select-String -Path $today, "$logDir\main.log" -Pattern 'pi-worker|mcp:noisy|stderr line' |
  Out-File "$ev\pkg-01-mainlog-redaction.txt" -Encoding UTF8
Select-String -Path $today, "$logDir\main.log" -Pattern 'sk-ant|sk-proj|Bearer |_API_KEY=' |
  Out-File "$ev\pkg-01-secret-grep.txt" -Encoding UTF8
```

**看什么**

判据（PKG 表第 1 项原文）：「日志中不出现 `sk-` 开头的 key、`Bearer <token>`、`*_API_KEY=<值>` 原文」。

- **通过**：`pkg-01-mainlog-redaction.txt` 里能看到那几行噪声（证明这条路真的通了），但密钥位置全是 `[redacted]`；`pkg-01-secret-grep.txt` 里**没有任何一行带完整密钥值**（出现 `ANTHROPIC_API_KEY=[redacted]` 这种**只剩名字**的行是对的，那是设计——规则保留名字、销毁值）。
- **不通过**：grep 出来的行里有 `sk-ant-T033FAKE…`、`sk-proj-T033FAKE…` 或 `Bearer t033-fake-…` 的**完整原文**。
- **做不成的情形**：如果 `pkg-01-mainlog-redaction.txt` 一行都没有，说明 MCP 根本没连上（多半是 `mcp.json` 有 BOM 或路径写错），先修好再判，**不要拿「日志里没有密钥」当通过**——那是没触发，不是脱敏成功。

**记录**：`pkg-01-mainlog-redaction.txt`、`pkg-01-secret-grep.txt`。

---

### PKG-02 Electron utility 载体下的 stderr 组装 【必】

**准备**：把 MCP 模式改成 `chunked`、延迟 `3000`，重写 `mcp.json`，重开应用与会话。

**操作**

1. 开一个会话发一句话，等 10 秒让分块的那行打完。
2. 抓日志里的那一行：

```powershell
Select-String -Path $today, "$logDir\main.log" -Pattern 'CHUNKED-LINE' -Context 1,1 |
  Out-File "$ev\pkg-02-stderr-assembly.txt" -Encoding UTF8
```

**看什么**

判据（PKG 表第 2 项原文）：「多块、跨块、CRLF 的 stderr 在 `main.log` 里是完整整行而非半行交织」。

- **通过**：日志里 `CHUNKED-LINE|xxxxx…|END` 是**一整行**出现（含中间那 60 个 x 与结尾 `END`），不是被拆成两三行、也没有和别的日志行穿插在一起。
- **不通过**：这条内容被切成多行，或者一行里混进了别的日志内容。
- **必须在记录里写明的一句**：**这一项的判据点名「Electron utility 载体」，而 Windows 打包态没有这个载体**（见 1.4）。你实际测到的是 `bundled-node` 载体下的同一段组装逻辑。所以本项如实记成 **⛔ 或 ✅ 加一句注**：「按 bundled-node 载体测得 <结果>；electron-utility 载体在 Windows 上不存在，留 Linux/macOS 打包产物复验」。**不要因为载体不同就跳过不做**，行为面这一半仍然有价值。

**记录**：`pkg-02-stderr-assembly.txt`。

---

### PKG-09 utility 载体下 session.stderr 的转发与 50 行上限 【必】

**准备**：MCP 模式改成 `flood`、延迟 `8000`（让 60 行落在「一轮正在跑」的窗口里），重写 `mcp.json`，重开应用。

**操作**

1. 开一个会话，发一句会让模型跑一会儿的消息（例如让它读一个文件再总结）。
2. 发出去之后**立刻**打开右侧 Context（上下文）面板，找到 **Host stderr** 分组。
3. 等 60 行刷完，把面板**滚到底部**截图，存 `pkg-09-stderr-cap-50.png`；面板内容如果能选中复制，就另存一份 `pkg-09-stderr-panel.txt`。

**看什么**

判据（PKG 表第 9 项原文）：「一轮内超过 50 行 stderr 时面板末尾出现「…more stderr this turn is in the worker log only (forwarding capped at 50 lines)」，且前 50 行均已脱敏」。

- **通过**：面板末尾确实出现那句 `…more stderr this turn is in the worker log only (forwarding capped at 50 lines)`；往上翻，第 7 行那条带 `ANTHROPIC_API_KEY=` 的行里值已经是 `[redacted]`。
- **不通过**：面板一直往下刷满 60 行没有那句提示（= 上限没生效）；或者那句提示在，但第 7 行的密钥是原文（= 脱敏漏了）；或者面板里一行 stderr 都没有（先确认 MCP 真的连上了，见 PKG-01 的同一条提醒）。
- **载体注**：同 PKG-02——这里测到的是 bundled-node 载体，判据写的 electron-utility 载体 Windows 上不存在，**在记录里写这一句**。

**记录**：`pkg-09-stderr-cap-50.png`（+ 可选 `pkg-09-stderr-panel.txt`）。

> 本轮做完记得删 `mcp.json`：`Remove-Item "$agentDir\mcp.json"`。

---

## 轮 P-c · 载体差异与退出语义（约 50 min）

### PKG-15 U1 utility 探针走产品路径推导 【必】

**准备（需要源码，做不了就直接看本节末尾的 🚫 写法）**

这一项跑的不是安装好的应用，而是**仓库里的探针 + 仓库里的 Electron 二进制**，用安装目录的随包 `node.exe` 当「产品路径推导」出来的那个 Node。

```powershell
# ① 拉源码到指定提交
git clone https://github.com/p1p1dan/ai-client C:\t033\src
cd C:\t033\src
git checkout 13e6cdb7
# ② runtime 是独立 npm 子包，依赖不随根安装装；缺了会报 Cannot find package 'cordis'
cd C:\t033\src\src\runtime
npm ci
# ③ 根依赖（只为拿到 node_modules\electron\dist\electron.exe 这个二进制）
cd C:\t033\src
corepack pnpm install
Test-Path C:\t033\src\node_modules\electron\dist\electron.exe   # 必须为 True 才能继续
```

**操作**

```powershell
cd C:\t033\src
$bash = 'C:\Program Files\Git\bin\bash.exe'      # 换成你机器上 where bash 的结果
& .\node_modules\electron\dist\electron.exe `
    .\scripts\runtime-smoke\electron-carrier.cjs $node $bash `
    1> "$ev\pkg-15-u1-utility-probe.json" 2> "$ev\pkg-15-stderr.txt"
Get-Content "$ev\pkg-15-u1-utility-probe.json"
git -C C:\t033\src rev-parse HEAD >> "$ev\pkg-15-u1-utility-probe.json"
```

（命令形状与 P1 那轮留档的一致：`electron scripts/runtime-smoke/electron-carrier.cjs <node 路径> <bash 路径>`，最后两个参数会被透传给探针。输出行以 `P1_CARRIER_REPORT ` 开头，后面跟一整个 JSON。）

**看什么**

判据（检查单 PKG 表第 15 项原文）：「`carrier=electron-utility` 且 `node.source==='bundled'`、`node.path !== process.execPath`、`tsdReadFallback==='configured-node'`，六项工具断言全通过，报告里带 Electron 版本与 HEAD 版本戳」。

- **通过**：报告 JSON 里 `passed: true`；`carrier` 是 `electron-utility`；`node.source` 是 `bundled`；`node.path` 指向安装目录的 `resources\node-runtime\node.exe`（和 Electron 自己的 `process.execPath` **不是**同一个）；`tsdReadFallback` 是 `configured-node`；六项工具断言（read / write / edit / bash / glob / grep）全 `true`；报告里能看到 Electron 版本，并且你已经把 `13e6cdb7` 这个提交号附在文件里。
- **不通过**：`passed: false`；或 `node.source` 是 `explicit`（说明探针退回了「手喂一个 Node」那条路，正是这一项要挡的）；或六项里任何一项 `false`。
- **做不了**：机器上没法 clone、或 `pnpm install` 拿不到 Electron 二进制（要下载几百 MB），本项记 🚫，原因写「无法获得 `node_modules\electron\dist\electron.exe`，U1 探针需要一个 Electron 二进制才能起 utilityProcess」。**不要用安装好的 `AiClient.exe` 代跑**——它启动的是 asar 里的应用，不接受脚本参数。

**记录**：`pkg-15-u1-utility-probe.json`、`pkg-15-stderr.txt`。

---

### PKG-17 U3 两载体同一报文形状对比 【必】

**准备**：先读完这一段再决定要不要开工——本项在纯打包态很可能做不成，那样也要把「为什么做不成」记成证据。

判据（PKG 表第 17 项原文）：「同一次 bootstrap + 一次 run 的 worker→Main 消息，在 `utilityProcess` 与 `fork()` 两条通道下逐字段等价（尤其无 `undefined` 键差异）」。

要拿到这份对比需要三样东西：① 一个 `utilityProcess` 载体（Windows 打包态没有，见 1.4）；② 一个 `fork()` 载体（Windows 打包态有）；③ **把 worker→Main 的消息逐条录下来的手段**——打包应用里没有任何开关能导出这些消息。

**操作**

1. 先确认第 ③ 条：在应用里翻一遍设置页与日志，确认没有「导出 worker 消息」之类的入口（有的话按它做，并把做法写进证据）。
2. 用 trace 做一次**降级取证**（能拿到什么就记什么）：按 1.2 启动应用、开一个会话跑一整回合，然后

```powershell
Copy-Item 'C:\t033\trace\runs.jsonl' "$ev\pkg-17-bundled-node-trace.jsonl"
```

3. 在 `pkg-17-note.txt` 里写清三句：本机只有 bundled-node 一个载体；打包态没有 worker→Main 消息的导出出口；因此逐字段 diff 本轮无法产出。

**看什么**

- **通过**：两条通道各录到一份消息序列 JSON，diff 之后逐字段等价，尤其没有「一边有、一边没有」的 `undefined` 键（JSON 序列化会让 `undefined` 键消失，结构化克隆会把它留下——这正是这一项在找的差别）。
- **不通过 / 做不成**：拿不到两份消息序列。这时记 🚫，原因写「Windows 打包态只有 bundled-node 一个载体，且打包应用没有导出 worker→Main 消息的出口；需源码 + 两个平台的打包产物才能做」。trace 那份留作参考，不顶判据。

**记录**：`pkg-17-note.txt`、`pkg-17-bundled-node-trace.jsonl`。

---

### PKG-18 U4 退出码与信号语义在两载体下的差别 【必】

**准备**：按 1.2 启动应用，开一个会话并发一句话，确认 worker 已经起来。

**操作**

1. 找到这个会话的 worker 进程并记下 pid：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, ParentProcessId, CommandLine | Format-List
```

2. 强杀它（Windows 上 `taskkill /F` 就是外部强杀这条路）：

```powershell
taskkill /PID <worker pid> /F
```

3. 抓日志里的退出行：

```powershell
Select-String -Path $today, "$logDir\main.log" -Pattern 'Worker exited' -Context 2,4 |
  Out-File "$ev\pkg-18-exit-codes.txt" -Encoding UTF8
```

4. 回到界面看这个会话现在是什么状态（报错卡？还能不能继续发？），截 `pkg-18-session-after-kill.png`。

**看什么**

判据（PKG 表第 18 项原文）：「外部 SIGKILL / taskkill 掉 worker 后，Main 记录的 `Worker exited (code=? signal=?)` 两个载体各是什么；确认 `isLostDisposeAck`（`WorkerSlot.ts:118-125`，要求 `code===0 && signal===null`）不会把崩溃误判成「dispose ACK 丢了」」。

- **通过**：日志里有一行 `Worker exited (code=… signal=…)`，并且这一行的 `code` **不是 0** 或 `signal` **不是 null**（`taskkill /F` 在 Windows 上通常给出非 0 的 code）。因为「被当成 dispose ACK 丢了」的条件是 `code===0 && signal===null` 两条同时成立，所以只要这一行不同时满足这两条，就说明崩溃不会被误判。界面上应当能看出「这个会话挂了」，而不是安静地当作正常收尾。
- **不通过**：日志里这一行是 `code=0 signal=null`（那就正好落进误判条件，要当场多抓一点：这个会话随后的行为、能不能继续发消息、有没有报错）；或者根本找不到 `Worker exited` 这一行。
- **载体注**：本项要求「两个载体各杀一次」。Windows 上只能拿到 `bundled-node` 那一半，**在记录里写明**：「electron-utility 那一半在 Windows 打包态不存在，留 Linux/macOS 打包产物」。

**记录**：`pkg-18-exit-codes.txt`、`pkg-18-session-after-kill.png`。

---

### PKG-10 Electron utility 载体的现行探针 【探】

**准备**：与 PKG-15 完全相同（同一个探针、同一条命令）。

**操作**：不用再跑一次。PKG-15 跑出来的那份报告已经包含本项要的全部字段。

**看什么**

判据（PKG 表第 10 项原文）：「`carrier=electron-utility` 且 `node_source` 由产品路径推导（不是 explicit），六项工具断言全通过；结果与 HEAD 版本戳绑定」。

- **通过**：PKG-15 通过 ⇒ 本项自动满足（PKG-15 的判据是本项的严格超集，多要求了 `node.path !== process.execPath` 与 `tsdReadFallback`）。在记录里写「同 `pkg-15-u1-utility-probe.json`」即可，**不要复制一份改名冒充两次独立取证**。
- **不通过**：PKG-15 没跑成 ⇒ 本项同样记 🚫，原因同 PKG-15。

**记录**：结果表里引用 `pkg-15-u1-utility-probe.json`。

---

### PKG-19 U5 打包 macOS/Linux 上 bash 工具的 PATH 首位 【不做】

判据本身限定「打包 macOS/Linux」，本次只有一台 Windows 机，**环境不具备**——记 🚫，原因写「判据限定 macOS/Linux 打包产物，本轮无该环境」。

（时间有富余时可以顺手在 Windows 上跑一次真实回合让模型执行 `node -v` 与 `where node`，看 PATH 首位是不是 `resources\node-runtime`——源码 `PiWorkerProcess.ts:84-86` 确实把它插在 PATH 最前面。这只是**参考数据**，存 `pkg-19-windows-path-reference.txt`，不顶判据、结果表里仍记 🚫。）

---

## 轮 P-d · stdout 背压（约 40 min，三家合一只做一次）

### PKG-03 + PKG-16 utilityProcess 载体的 stdout 背压 【必】

**准备**：先读完，这一项在纯打包态很可能做不成。

判据（PKG 表第 3 项 + 第 16 项原文合并）：

- 第 3 项：「worker 在写入期间与之后仍能正常应答 `worker.tree` / `worker.history`（不超时），且 Main 进程 RSS 不随写入量线性增长；若任一条不成立即证实 main-host-04」；
- 第 16 项：「临时探针在 utility worker 里向 stdout 写 4 MiB 后，RPC 仍能应答一次 bootstrap；worker RSS 增长 < 数 MiB」。

取证要求是「在 worker 入口临时注入一个定时 `process.stdout.write` 的插件」——**打包应用的 worker 入口在 asar 里，注入不了**；而且要测的通道是 `utilityProcess`，Windows 打包态没有（见 1.4）。

**操作**

1. 先试一条**不用注入**的近似路：给会话配一个**往 stdout 狂写非协议内容**的 MCP 服务器（沿用轮 P-b 的脚本框架，把 `process.stderr.write` 换成 `process.stdout.write` 写 4 MiB 垃圾）。**注意**：MCP 的 stdout 是协议通道、由客户端读取，写进去的垃圾会被当成解析不了的行丢掉，**它不等于 worker 自己的 stdout**，所以这条路只能证明「MCP 噪声不会打死会话」，证明不了本项判据。跑了就把结论写进 `pkg-03-note.txt`，并注明它不顶判据。
2. 在写入期间与之后，各做一次只读操作当存活探针：切到别的会话再切回来（触发历史读取）、展开一次会话树。记下有没有转圈超时。
3. 采内存：任务管理器 → 详细信息 → 加上「工作集(内存)」列，对 `AiClient.exe`（主进程）与 worker `node.exe` 各截一张写入前 / 写入后的图，存 `pkg-03-rss-before.png` / `pkg-03-rss-after.png`。

**看什么**

- **通过**：需要真正的注入探针 + utilityProcess 载体两个条件都满足，本机不具备。
- **做不成（预期结论）**：记 🚫，原因写「① 打包应用的 worker 入口在 asar 内，无法注入 stdout 探针；② Windows 打包态没有 utilityProcess 载体。本项需源码 dev 态或 Linux/macOS 打包产物」。第 1～3 步拿到的东西作为参考数据一并归档。

**记录**：`pkg-03-note.txt`、`pkg-03-rss-before.png`、`pkg-03-rss-after.png`。

---

## 轮 P-e · 并发、trace 与导入（约 40 min）

### PKG-12 三个会话并发时的真实进程数与内存 【必】

**准备**：这一项**开发机做不了**（2 核 / 3.3 GB 会得出假结论），必须在这台机器上做。先关掉别的大程序，记一次空载内存。

**操作**

1. 按 1.2 启动应用，**同时开三个聊天**（三个不同工作区最好），每个各发一句话跑完一轮。
2. 三轮都跑完、界面空闲下来之后：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='AiClient.exe'" |
  Select-Object ProcessId, ParentProcessId, WorkingSetSize, CommandLine |
  Sort-Object WorkingSetSize -Descending | Format-List |
  Out-File "$ev\pkg-12-rss.txt" -Encoding UTF8
```

3. 任务管理器按内存排序截一张图，存 `pkg-12-three-sessions.png`。
4. 在 `pkg-12-rss.txt` 末尾手写两行：机器总内存、当时的可用内存。

**看什么**

判据（PKG 表第 12 项原文）：「进程数 = 3 个 worker + 每会话 MCP 数；常驻内存是否仍在机器可承受范围」。

- **通过**：`node.exe` 的数量正好等于 **3 个 worker**（如果这轮没配 MCP，就应该正好 3 个；配了 N 个 MCP 服务器就是 3 + 3×N），没有多余的孤儿；三个 worker 加上 `AiClient.exe` 的常驻内存之和没有把机器逼到吃紧（没有明显卡顿、可用内存还剩得下）。
- **不通过**：进程数对不上（多出来的要记下它的命令行）；或者内存明显吃紧（系统开始换页、界面卡住）。**数字本身就是结论**，照实记。

**记录**：`pkg-12-three-sessions.png`、`pkg-12-rss.txt`。

---

### PKG-13 现场取证时 runs.jsonl 的代号完整性 【探】

**准备**：trace 单文件上限 8 MiB、保留 3 代（源码 `src/runtime/trace.ts`），**要看到「至少两次轮转」得写出 16 MiB 以上的 trace**——正常几轮对话远远不够。造量的办法是跑几轮**工具很多、输出很长**的回合（例如让模型反复 grep / read 大文件）。

**操作**

1. 清空 trace 目录：`Remove-Item C:\t033\trace\* -Force`。
2. 按 1.2 启动应用，开 3 个会话，各跑若干轮到 trace 目录里出现 `runs.1.jsonl` 与 `runs.2.jsonl`（`dir C:\t033\trace` 看一眼）。
3. 收集：

```powershell
Get-ChildItem C:\t033\trace\runs*.jsonl | ForEach-Object {
  '{0} {1} lines' -f $_.Name, (Get-Content $_.FullName | Measure-Object -Line).Lines
} | Out-File "$ev\pkg-13-rotation.txt" -Encoding UTF8
```

（`runs.rotate.lock` 是锁文件，上面的 `runs*.jsonl` 通配已经把它排除掉了。）

**看什么**

判据（PKG 表第 13 项原文）：「`runs.1/2/3.jsonl` 是否连续无空洞、行数是否守恒」。

- **通过**：轮转出来的文件编号连续（1、2、3 不跳号），把各文件行数加起来与实际产生的记录数对得上，`run_id` 的并集没有缺口。
- **不通过**：编号跳号、某一代是空文件、或者行数明显少了。
- **做不成**：当天没能把 trace 写到 16 MiB 以上，记 🚫 并写明实际写出了多少字节。

**记录**：`pkg-13-rotation.txt`。

---

### PKG-14 导入时的进程峰值 【探】

**操作**

1. 按 1.2 启动应用，开满 3 个会话（同 PKG-12）。
2. 数一次 worker：`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Measure-Object`。
3. 发起一次旧对话导入（导入面板里挑一条真实的 Claude 或 Codex 会话）。
4. 导入进行中再数一次，导入结束后再数一次，三次数字都写进 `pkg-14-import-peak.txt`。

**看什么**

判据（PKG 表第 14 项原文）：「在容量 3 的机器上开满 3 个会话后发起旧对话导入，是否出现第 4 个 worker 进程」。这是**记录型**判据：出现了就记「出现了，pid 与命令行如下」，没出现就记「没出现」。

**记录**：`pkg-14-import-peak.txt`。

---

### PKG-07 导入产物路径与 pi CLI 互通 【探】

**操作**

1. 起应用导入一条旧会话，记下产物路径（在 `$agentDir\sessions\` 下按工作区编码分目录）：

```powershell
Get-ChildItem "$agentDir\sessions" -Recurse -Filter *.jsonl |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3 FullName, Length, LastWriteTime
```

2. **关掉应用**（避免写锁冲突），用随包 pi CLI 打开那个文件：

```powershell
& $node $piCli --session "<上一步那个 .jsonl 的全路径>"
```

3. 再用会话列表那条路看它在不在列表里（pi 没有非交互式列表参数，只能用交互式选择器）：

```powershell
& $node $piCli --session-dir "<那个 jsonl 所在目录>" --resume
```

4. 两次都截图，存 `pkg-07-pi-opens-import.png`。

**看什么**

判据（PKG 表第 7 项原文）：「`<agentDir>/sessions/<id>.jsonl` 能被 `pi --session` 打开，并出现在 TUI 的会话列表里」。

- **通过**：pi 正常打开这个会话，历史内容看得见；`--resume` 的选择器里能看到这一条。
- **不通过**：pi 报错（把报错原文抄下来）、或打开了但内容是空的、或选择器里没有这一条。

**记录**：`pkg-07-pi-opens-import.png`（+ 报错时另存 `pkg-07-pi-error.txt`）。

---

### PKG-08 utility 载体下的重读 【探】

**准备**：需要一个 MCP 服务器一起验（判据里的「带 MCP」）。用样本包里现成的 `slow-mcp-server.mjs`，`--delay-ms` 设 `20000`，按轮 P-b 公共准备第 2 步的写法注册进 `mcp.json`。

**操作**

1. 起应用，开一个会话，等 MCP 连上（会慢 20 秒，是预期）。
2. 从 GUI 切到内嵌 TUI，在 TUI 里发一句话，再切回 GUI。
3. 切回 GUI 之后立刻发一条消息（这一步会触发 `reloadSessionFromDisk`），用秒表记「点发送 → 消息真的开始跑」的耗时。
4. 抓日志与 trace 里的相关行：

```powershell
Select-String -Path $today -Pattern 'reload|retire|worker_reload' | Out-File "$ev\pkg-08-reload-timing.txt" -Encoding UTF8
```

**看什么**

判据（PKG 表第 8 项原文）：「`worker.reload` 在 Electron utility 载体上同样在 `BOOTSTRAP_REQUEST_TIMEOUT_MS` 内完成（带 MCP 时）」。那个预算是 **60 秒**（源码 `createPiWorkerSlot.ts:57`）。

- **通过**：交回 GUI 后的第一条消息**不失败**，会话没有被 retire，从点发送到开始跑没有超过 60 秒。
- **不通过**：第一条消息失败、日志里出现 `worker_reload` 失败分支、或会话被 retire。
- **载体注**：同 PKG-02——Windows 上测到的是 bundled-node 载体，**在记录里写这一句**。

**记录**：`pkg-08-reload-timing.txt` + 一张失败/成功的界面截图。

---

### PKG-11 P5-2-0 探针跨平台 【探】

**准备**：需要源码与已装好的根依赖（同 PKG-15 的第 ①～③ 步）。

**操作**

```powershell
cd C:\t033\src
corepack pnpm vitest run src/runtime/__tests__/subagentHostProbe.test.ts 2>&1 |
  Tee-Object "$ev\pkg-11-subagent-probe.txt"
```

（文件名对不上时先 `Get-ChildItem -Recurse -Filter subagentHostProbe.test.ts` 找准路径。）

**看什么**

判据（PKG 表第 11 项原文）：「`subagentHostProbe.test.ts` 10 条在 Windows 与 Electron utility 载体上同样全绿」。

- **通过**：Windows 上 10 条全绿。
- **不通过**：任何一条红，把失败输出整段留下。
- **做不了**：没有源码 / 装不上依赖，记 🚫，原因同 PKG-15。**另外注明**：判据里「Electron utility 载体」那一半 Windows 上不存在。

**记录**：`pkg-11-subagent-probe.txt`。

---

## 轮 P-f · 新并入的四项（约 60 min）

### PKG-23 P6-3 第 4 条：打包产物的 GUI 无回归 【必】

**准备**：界面语言设为中文；按 1.2 启动应用；准备一个能让模型用到工具、并且会触发一次写文件审批的任务。

**操作**

1. 在打包态起的应用里走**一整回合**：让模型读一个文件（工具）→ 让它写一个文件（触发审批卡，点允许）→ 让对话长到触发一次上下文压缩（或直接用会话菜单里的压缩入口）。
2. 截三张图：权限卡一张、时间线整体一张、压缩之后的时间线一张，合并存 `pkg-23-full-turn.png`。
3. 打开左侧栏的「能力」面板，截 `pkg-23-capabilities-panel.png`。
4. 打开设置 → Pi 插件页，截 `pkg-23-plugins-notice.png`。

**看什么**

判据（检查单 2.3 节 PKG-23 原文）：「打包态起应用 → 一整回合（含工具、审批、压缩）→ 权限卡与时间线正常 → 侧栏「能力」面板与插件设置页文案正确」。「能力」面板与插件页文案的细判据用 DEV-36 的 5.1 更正版：「侧栏「能力」面板列出 native runtime 自己的 MCP / 技能 / 子代理（「未报告」与「报零」两态可区分）；插件设置页权限归属文案：① 无条件显示「本应用的每个对话，都由它自带的权限系统审批工具调用」；② 装了 pi 权限扩展时另显示「你自己安装的 pi 权限系统只对内嵌终端生效」」。

- **通过**：回合正常走完；权限卡是结构化的中文卡（有风险标签、工具名、路径、允许/拒绝按钮）；时间线条目齐全、顺序正确；「能力」面板把 MCP / 技能 / 子代理分别列出来，而且**「没报告过」和「报告了但是 0 个」看得出区别**；插件页上那句 ① 是中文的「本应用的每个对话，都由它自带的权限系统审批工具调用。」
- **不通过**：权限卡没弹、或弹的是英文的下拉选择框（那是旧引擎的形态）；时间线缺条目或顺序乱；「能力」面板一片空白分不出两态；插件页那句话是英文或根本没有。
- **② 那半句是条件渲染**：只有装了 pi 权限扩展的机器才显示。没装就**只验 ①**，并在记录里写一句「未装 pi 权限扩展，②未验」——**不要因为看不到 ② 就判负**。

**记录**：`pkg-23-full-turn.png`、`pkg-23-capabilities-panel.png`、`pkg-23-plugins-notice.png`。

---

### PKG-20 SA21 两载体打包后的子任务矩阵 【绿】

**准备**：需要真实模型回合（子代理要真的被派出去）。界面语言中文。

**操作**（下面四步在**同一个会话**里连着做）

1. **后台委派**：让模型派一个子代理去做一件要花点时间的事（例如「用子代理把工作区里所有 .md 文件的标题列出来」）。
2. **审批**：让子代理做一件需要审批的事（写文件），在委派面板/时间线上点允许。
3. **写入**：确认文件真的被写出来了（`Test-Path`）。
4. **取消**：再派一个子代理，中途点停止/取消。
5. 四步做完后查残留：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, ParentProcessId, CommandLine |
  Out-File "$ev\pkg-20-bundled-node-subagent-matrix.txt" -Encoding UTF8
```

6. 委派面板截图一张，并到 `pkg-20-bundled-node-subagent-matrix.txt` 里手写四步各自的结果。

**看什么**

判据（检查单 2.1 节 PKG-20 原文）：「electron-utility 与 Windows bundled-node 两种载体各跑一遍「后台委派 + 审批 + 写入 + 取消」，结束后无残留子进程」。

- **通过**：四步都走通（委派出去了、审批卡出现并能批、文件真的写了、取消真的停了），并且跑完之后 `node.exe` 只剩下当前打开的会话该有的那些，没有多出来的子代理进程。
- **不通过**：任一步走不通；或跑完之后有残留进程（把它的命令行记下来）。
- **载体注**：Windows 上只能跑 `bundled-node` 那一遍，**在记录里写明**「electron-utility 那一遍留 Linux/macOS 打包产物」。证据文件名里带上载体名（`pkg-20-bundled-node-…`），免得日后两遍混淆。

**记录**：`pkg-20-bundled-node-subagent-matrix.txt` + 委派面板截图。

---

### PKG-21 MC-c 打包版 native 不再读 models.json 【绿】

**准备**：确认这个文件在：`Test-Path "$agentDir\models.json"`。不在就说明这台机器从来没用过 CLI 那条路，本项记 🚫 并写明。

**操作**

```powershell
Copy-Item "$agentDir\models.json" "$ev\pkg-21-models-json.bak"          # 先备份
Rename-Item "$agentDir\models.json" "models.json.t033-renamed"
```

1. 起应用，在一个 native 会话里**发一条消息**，看能不能正常出话，截 `pkg-21-native-after-rename.png`。
2. 同一台机器上起一次 TUI（会话里点 TUI 开关，或命令行 `& $node $piCli`），看它报什么，截 `pkg-21-tui-error.png`。
3. 做完**立刻改回来**：

```powershell
Rename-Item "$agentDir\models.json.t033-renamed" "models.json"
Get-FileHash -Algorithm SHA256 "$agentDir\models.json", "$ev\pkg-21-models-json.bak"   # 两个哈希必须一致
```

**看什么**

判据（检查单 2.2 节 PKG-21 原文）：「把派生的 `models.json` 改名后，native 会话仍可用；legacy / TUI 侧报错（证明这文件只剩 CLI 在读）」。

- **通过**：改名之后 GUI 里的 native 会话**照样能出话**；而 TUI / CLI 那边**报错**（报错原文抄下来）。两半都成立才算通过。
- **不通过**：GUI 也跟着不能用了（说明 native 仍在读这个文件）；或者 TUI 也若无其事（说明这文件已经没人读，判据的后半句不成立——照实记，这同样是有用的结论）。

**记录**：`pkg-21-native-after-rename.png`、`pkg-21-tui-error.png`、改回后的哈希对比写进 `pkg-21-restore.txt`。

---

### PKG-22 P6-4 回退窗口：旧版产物互读 【绿】

**准备（这一项的纪律最多，先读完再动手）**

- 三个 exe 都在机器上（总纲 §0.2 已经核过一遍哈希），**文件名分不出版本，只有哈希能**：

| 文件 | 是哪一版 | SHA256 前 8 位 |
|---|---|---|
| `C:\t033\pkg\new-13e6cdb7\AiClient Setup 1.0.0-test.13.exe` | 新版 installer，源码 `13e6cdb7`（**已安装的就是它**） | `b0ce16cb` |
| `C:\t033\pkg\new-13e6cdb7\AiClient-1.0.0-test.13-portable.exe` | 新版 portable | `431cb7ed` |
| `C:\t033\pkg\prev-c0ae2a34\AiClient Setup 1.0.0-test.13.exe` | 旧版 installer，源码 `c0ae2a34` | `ee9a1387` |

- **安装版与 portable 共用同一个 userData（`%APPDATA%\jyw-ai-client`），而且有单实例锁，不能同时开两个**。所以本项必须**串行**：新版写 → 关掉 → 旧版开 → 关掉 → 新版再开。
- 两版安装包版本号一样（`1.0.0-test.13`），NSIS 见到同版本号是**就地升级不是并装**，所以旧版要装到明确不同的目录（例如 `C:\AiClient-old-c0ae2a34`），或者干脆用**新版 portable 写、旧版安装态读**这条路（推荐，不用卸载）。

**操作**

1. 先把三个哈希记下来当证据：

```powershell
Get-FileHash -Algorithm SHA256 C:\t033\pkg\*\*.exe |
  Select-Object Hash, Path | Out-File "$ev\pkg-22-hashes.txt" -Encoding UTF8
```

2. **第一步（新版写）**：用**新版**（安装态或 portable，记清是哪个哈希）开一个新会话，发两三条消息（其中一条带工具调用），让会话文件有点内容。关掉应用。记下会话文件路径并存一份副本：

```powershell
$sess = (Get-ChildItem "$agentDir\sessions" -Recurse -Filter *.jsonl | Sort-Object LastWriteTime -Descending)[0].FullName
$sess | Out-File "$ev\pkg-22-session-path.txt" -Encoding UTF8
Copy-Item $sess "$ev\pkg-22-session-before.jsonl"
Get-FileHash -Algorithm SHA256 $sess >> "$ev\pkg-22-hashes.txt"
```

3. **第二步（旧版读）**：确认新版进程全退了（`Get-Process AiClient -ErrorAction SilentlyContinue`），起**旧版**（先 `Get-FileHash` 对一遍是 `ee9a1387` 那个），在侧栏里找到刚才那条会话并打开它，截 `pkg-22-old-opens-new.png`。若它打不开、或弹提示，**把提示原文抄下来**。然后关掉旧版。
4. **第三步（新版回看）**：起新版，打开同一条会话，截 `pkg-22-new-reopen.png`，并比对文件：

```powershell
Copy-Item $sess "$ev\pkg-22-session-after.jsonl"
Get-FileHash -Algorithm SHA256 "$ev\pkg-22-session-before.jsonl", "$ev\pkg-22-session-after.jsonl"
(Get-Content "$ev\pkg-22-session-before.jsonl").Count
(Get-Content "$ev\pkg-22-session-after.jsonl").Count
Compare-Object (Get-Content "$ev\pkg-22-session-before.jsonl") (Get-Content "$ev\pkg-22-session-after.jsonl") |
  Out-File "$ev\pkg-22-file-before-after.diff" -Encoding UTF8
```

**看什么**

判据（检查单 2.3 节 PKG-22 原文）：「用上一个安装包打开本版写出的会话文件：要么正常打开，要么给出可读的说明；不得静默丢条目或写坏文件」。

- **通过**：旧版要么把会话正常打开（历史条目都在），要么给出一句**人能看懂的**说明（例如「这个会话由更新的版本写入」）；随后用新版再打开时，条目数与开头那份**一样或更多**，`Compare-Object` 没有「少了行」的差异。
- **不通过**：旧版静默地少显示了条目却不说明；或者旧版打开之后文件被改坏（新版回看时条目少了、或打不开了）。
- **每张截图都要能对上哈希**：在记录里写明「这一屏是哪个哈希的包开出来的」。
- **做不成**：如果旧包没法运行（例如装不上、或与新版互相顶掉），记 🚫 并写明卡在哪一步——**不要用「本版打开本版」冒充**。

**记录**：`pkg-22-hashes.txt`、`pkg-22-session-path.txt`、`pkg-22-old-opens-new.png`、`pkg-22-new-reopen.png`、`pkg-22-file-before-after.diff`。

---

## 结果表（做一项填一行）

| 编号 | 结果 | 一句现象 | 证据文件 |
|---|---|---|---|
| PKG-01 | | | |
| PKG-02 | | | |
| PKG-03+16 | | | |
| PKG-04 | | | |
| PKG-05 | | | |
| PKG-06 | | | |
| PKG-07 | | | |
| PKG-08 | | | |
| PKG-09 | | | |
| PKG-10 | | | |
| PKG-11 | | | |
| PKG-12 | | | |
| PKG-13 | | | |
| PKG-14 | | | |
| PKG-15 | | | |
| PKG-17 | | | |
| PKG-18 | | | |
| PKG-19 | | | |
| PKG-20 | | | |
| PKG-21 | | | |
| PKG-22 | | | |
| PKG-23 | | | |

档位小计：【必】12 项（PKG-01 / 02 / 03+16 / 04 / 05 / 06 / 09 / 12 / 15 / 17 / 18 / 23）·【绿】3 项（PKG-20 / 21 / 22）·【探】6 项（PKG-07 / 08 / 10 / 11 / 13 / 14）·【不做】1 项（PKG-19）。

**收工前的清理**（做完整组再做一次）：

```powershell
Remove-Item "$agentDir\mcp.json" -ErrorAction SilentlyContinue        # 轮 P-b / P-e 的 MCP 配置
Test-Path "$agentDir\models.json"                                     # PKG-21 必须已经改回来，这里应为 True
Get-Process AiClient, node -ErrorAction SilentlyContinue               # 收工时应当没有残留
```
