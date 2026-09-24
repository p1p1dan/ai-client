# T128 修复 GUI 复验（2026-09-24，Linux 开发机）

上一轮点验见上级目录 [`../README.md`](../README.md)。本轮只复验 T128 修掉的 6 项（D1、C3、N1、N2、N5、N6），外加 4 项冒烟回归。

## 被测对象

- 分支 `feat/ctrl-enter-interject`，HEAD `46789042`。
- 工作树里有尚未提交的 T128 修复：`git diff --stat -- src` 共 24 个文件，+1120 / −87，另有若干未跟踪的新文件。
- 被测代码的指纹：`git diff -- src` 加上 `src/` 下未跟踪文件的内容，一起取 sha1，得到 `9b6dd9b6…`。开工时和收尾时各算了一次，两次一致。这说明整轮点验期间 `src/` 没有变过，所有结果对应的是同一份代码。
- 本轮没有改 `src/`，也没有做任何 git 写操作。
- 机器：2 核 / 3.3 GB。同一时间只开一个 Electron，没有跑全量测试。
- 模型：**全程只用本地假网关**（`probe-fake/fake-sonnet` → `http://127.0.0.1:18124`）。真实 provider 的调用次数为零。

## 结论速览

| 结果 | 数量 | 项 |
|---|---|---|
| ✅ | 8 | R1 R2 R3 R4 R5 R6 R7 R8（R8 里的 A2、B1、C1、D3 四项都通过） |
| ❌ | 0 | — |

另有清单外的问题和观察 8 条，见「新发现」。其中与 T128 直接相关的只有 1 条（X1：没执行的「编辑」行点开是空的），其余是旧问题或设计取舍。

---

## 环境（沿用上一轮的隔离配方）

- 隔离 profile：`AICLIENT_PROFILE=ijrc`，Electron 额外加参数 `--password-store=basic`。
  - 状态根是 `~/.pilab/jyw-ai-client-ijrc`，userData 是 `~/.config/jyw-ai-client-ijrc`。收尾时两者都已整体删除。
- vault：手写的明文文件 `credentials/vault.json`。字段是 `enc: none`、`payload: null`，`userProviders` 里只有 `probe-fake` 一条（`anthropic-messages`，模型 `fake-sonnet`，apiKey 是占位串 `fake-key`）。
- dev.env：用 `AICLIENT_DEV_ENV_FILE=/tmp/ij/dev.env.pc` 指向一份副本，内容与上一轮相同，不含任何真实凭据：`ANTHROPIC_BASE_URL=http://127.0.0.1:18124`、`ANTHROPIC_AUTH_TOKEN=fake-pointcheck-token`、`AICLIENT_MANAGED_CREDENTIALS=0`、`PI_CODING_AGENT_DIR=/tmp/ij/agentdir-empty`。
  - D3 用的另一份副本 `dev.env.d3` 在此基础上多一行 `AICLIENT_RUNTIME_LOOP_GUARD=0`。启动后到 `/proc/<pid>/environ` 里核对过：前台进程和 worker 进程都带着这个变量。
- 测试仓库 `/tmp/ij/repo`：按上一轮的配方重建，有三个分支（main、dev、超长名分支）。
- 真实 dev profile 和真实 vault：本轮**完全没有碰**。

### 启动记录

| 次序 | dev.env | 做了什么 |
|---|---|---|
| 1 | `dev.env.pc` | R1、R2、R3、R4；R5、R6 的实时部分；R7；R8 的 A2、B1、C1 |
| 2 | `dev.env.pc`（重启） | R5、R6 重开会话后的部分 |
| 3 | `dev.env.d3`（关闭防护） | R8 的 D3 |

### 工具（都放在 `../tools/`）

| 文件 | 状态 | 说明 |
|---|---|---|
| `ij-lib.mjs` | 修改 | 新增两个环境变量：`IJ_OUT=<子目录>` 让 shots/ 和 data/ 写进该子目录；`IJ_PROFILE=<名字>` 替换隔离 profile 名（默认仍是 `ijpc`）。另外整份文件跑过一次 `biome format`，这部分只改排版 |
| `rc-lib.mjs` | 新增 | 本轮共用的探针：失败卡、输入框红框、侧栏行、「会话分支」按钮、提示条、工具行结局词、回合时钟、store 时间戳；`openFromSidebar` 用真实侧栏行打开会话（同一标题在「最近」和仓库列表里各出现一次，pc-lib 的 `switchTo` 要求恰好匹配一行，匹配到两行就会退回 `selectSession`，而重启后这条路径打开的是空白时间线） |
| `rc01-r1-d1.mjs` | 新增 | R1 |
| `rc02-r2-queue-after-failure.mjs` | 新增 | R2 |
| `rc03-r3-c3.mjs` | 新增 | R3，分 p0～p5 六个阶段；`PHASES=`、`NO_NEW=1` 可以分两次跑 |
| `rc04-r4-compact.mjs` | 新增 | R4 |
| `rc05-r5-durations.mjs` / `rc06-r5-reopen.mjs` | 新增 | R5 重启前 / 重启后（同时覆盖 R8 的 A2、C1） |
| `rc07-r6-outcome.mjs` | 新增 | R6，有三种模式：`MODE=live`、`live-b-open`、`reopen` |
| `rc08-r7-branch-error.mjs` | 新增 | R7 |
| `s01-enter.mjs`、`s02-smoke.mjs`、`s30-b.mjs`（`PARTS=b1`）、`s60-d3.mjs` | 原样复用 | 进入主界面、冒烟、B1、D3 |

运行方式举例：`IJ_PROFILE=ijrc IJ_OUT=recheck-t128 node rc01-r1-d1.mjs`。假网关 `ij-gateway.mjs` 没有改动：压缩上下文时发来的摘要请求不带工具，网关原本就会回 `SUMMARY: …`，所以 R4 不需要给网关补应答。

---

## 逐项结果

时间说明：网关日志里的时间是 UTC；界面上的「完成于」是本机时间（UTC−4）。例如 UTC 17:15 在界面上显示为 13:15。

### R1　D1 失败卡

| 子项 | 做法 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| 掐断后的界面 | 新会话，发 `⟦formB⟧ R1 …` | 出现中文失败卡（标题、原因、「继续」按钮）；输入框上方没有英文红框；status 是 `failed`；侧栏这一行有失败标记；「会话分支」按钮可以点 | 17:00:36.729 在第 47 个 tool_use 块处掐断（流到 11.81 秒，网关记到 `client_abort`），200ms 后 status 变为 `failed`，`failureSettled: true`。<br>**失败卡**：标题「模型输出出现重复调用，已中断」，下面是中文原因「模型在同一条回复里不停重复同一个子 Agent 工具调用……一个都没有执行」，再下面是英文原句（等宽字体，作为细节），最后是「继续」按钮。<br>**输入框上方的红框**：0 个。<br>**4 秒后复读**：status 仍是 `failed`，卡片仍在（上一轮的缺陷是 idle 事件把 failed 覆盖掉）。<br>**侧栏**：这一行有红底 `failed` 徽标和红点。<br>**「会话分支」**：按钮可点（`disabled=false`），点开后弹出会话树（5 个节点），按 Esc 关闭。<br>掐断之后 15 秒内没有新请求；哨兵文件和 touch 文件都不存在 | ✅ |
| 失败后直接发一条普通消息（回归重点） | 发 `⟦echo⟧ R1b …` | 失败卡消失；正常回复；这次请求里不带退化回复 | 17:00:47.158 发出，47.195 网关收到。请求里有 2 条 user 消息（R1 原话和 R1b），`historyToolUseCount=0`、`historyTaskListCount=0`，也就是**不含**那条带 47 个调用的退化回复。首次采样（47.762）时卡片已经消失，status 是 `idle`，输入框上方没有红框。回复 `ECHO: …` 正常 | ✅ |
| 再掐断一次，然后点「继续」 | 发 `⟦formB⟧ R1c …`，掐断后点卡片里的「继续」 | 能重新发出；记下发了什么 | 17:01:04.575 第二次掐断，卡片再次出现（带「继续」）。17:01:06.786 点「继续」，**143ms 后**网关收到请求。<br>**发出的内容**：把最后一条用户消息原样重发，也就是「⟦formB⟧ R1c 再掐断一次，然后点「继续」」。它是作为一条**新的** user 消息发出的，所以这次请求里末尾有两条完全相同的 user 消息，历史中的工具调用数仍为 0。<br>因为重发的仍是 formB 剧本，假模型又退化了一次，17:01:18.740 第三次在第 47 个块处被掐断，卡片再次出现。见观察 X3 | ✅ |

证据：`data/r1-d1.json`，`shots/r1-a-failure-surface.png`，`shots/r1-a-session-tree-dialog.png`，`shots/r1-b-after-plain-send.png`，`shots/r1-c-*.png`，`data/main-log-excerpts.txt`，`data/trace-excerpts.jsonl`

对照上一轮（`../shots/21-d1b-failure-surface.png`）：上一轮没有失败卡，只有输入框上方的英文红框；本轮正好反过来。

### R2　失败后队列放行

| 做法 | 预期 | 实际 | 结论 |
|---|---|---|---|
| 新会话，发 `⟦formB⟧ R2 …`。在它流式输出期间，先按 Enter 排一条「R2-排队」，再按 Ctrl+Enter 插一条「R2-插话」，然后等它被掐断 | 两条都自动发出；失败卡一闪而过属于预期 | 入队后队列条显示：`1 ↳ 插话 …R2-插话` / `2 …R2-排队`（插话排在前面）。<br>17:02:41.911 掐断 → **17:02:42.093 插话发出**（掐断后 182ms）→ **17:02:43.201 排队那条发出**（掐断后 1.29 秒）。两条都正常回复，两次请求里历史中的工具调用数都是 0。<br>会话里用户消息的顺序：formB → 插话 → 排队。<br>连续采样（每轮间隔 120ms，另加读数本身的耗时），一次也没采到失败卡：status 从 `running` 直接变成 `idle`，也就是 `failed` 停留的时间短于一个采样间隔，这符合「一闪而过」 | ✅ |

证据：`data/r2-queue-after-failure.json`，`shots/r2-queued-while-streaming.png`，`shots/r2-end.png`

### R3　C3 点开折叠块后不被滚走

所有阶段都在同一个会话里进行。从 p1 起，时间线内容都已经超出视口（视口高 704px，scrollHeight 从 4808 涨到 23000 以上）。每 150ms 读一次滚动容器的 scrollTop、hidden（= scrollHeight − clientHeight − scrollTop，即底部还藏着多少像素）、被点标题的 `getBoundingClientRect().top`，以及「滚动到底部」按钮是否可见。

| 阶段 | 做法 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| p0 正常跟随（回归） | `⟦think⟧` 流式输出时不做任何操作，每 300ms 采样一次，共 40 次 | 一直贴底 | 内容溢出以后，scrollTop 随正文增长（0 → 625），40 次采样的 hidden 全部为 0 | ✅ |
| p1 思考块 | 停在底部，第二段正文流式输出 2.5 秒后，点开视野内的「思考 片刻」 | 标题留在原位，正文在下方继续长；隐藏内容超过约 140px 后出现回底按钮；点回底按钮后恢复跟随 | 点击前 scrollTop=4104，标题 top=542。点击后 6 秒内共 40 次采样：**scrollTop 始终是 4104，标题 top 始终是 542**，hidden 从 438 涨到 1018。第一次采样按钮就已经出现：展开的面板本身就把 438px 推到了视口下面，超过了 140px 的门槛。点「滚动到底部」之后 3 秒内，hidden 始终为 0，恢复跟随 | ✅ |
| p2 工具行 | 同一时刻点开「终端 echo think-tool」行 | 同上；用滚轮回到底部也能恢复跟随 | scrollTop 始终是 8467，标题 top 始终是 517（30 次采样，4.5 秒）。hidden 在第 1 个采样是 146，这时按钮还没显示；第 2 个采样（约 150ms 后）按钮出现。之后 hidden 一路涨到 533，页面不动。用真实滚轮事件滚 3 下到底，之后 3 秒 hidden 都在 0～28，恢复跟随 | ✅ |
| p3 已结束回合的过程区头部 | 先跑一个 `⟦toolend⟧` 回合（结束后过程区默认折叠，头部显示「已工作 1 秒」），再发 `⟦think⟧`。流式输出时点开上一个回合的这个头部 | 同上 | 头部 top 始终是 397，scrollTop 始终是 12839（40 次采样，6 秒）。hidden 依次为 83 → 111 → 138 时**不显示**按钮，到 166 时才显示，与 140px 门槛一致。点回底按钮后恢复跟随 | ✅ |
| p4 在底部收起一个块（回归） | 点开工具行（跟随暂停）→ 点回底按钮（跟随恢复）→ 这时该行仍在视野里（点击时 top≈205），再点它收起 | 收起之后不会停止跟随 | 收起之后 5 秒内共 20 次采样，hidden 全部是 0 或 28（28 是一行新正文刚到、下一帧还没追上的瞬间），scrollTop 持续增长 | ✅ |
| p5 发送新消息后跟随（回归） | 用滚轮往上滚 960px（这时 hidden=960，按钮可见，跟随已停），然后发一条新的 `⟦think⟧` | 发送后回到底部并继续跟随 | 发送后第一次采样 hidden 就是 0，之后 9 秒的 30 次采样 hidden 全部为 0 | ✅ |

**与上一轮 `../data/17-c3-thought.json` 对比**：上一轮点开思考块时，标题 top=542、scrollTop=8467；约 160ms 后 scrollTop 跳到 8933（+466，正好是面板高度），标题被带到 76，约 470ms 后移出视野。工具行则是 scrollTop 立刻 +173，标题从 516 跳到 343。本轮三种折叠块都是 scrollTop 不动、标题不动。

证据：`data/r3-c3-p0-p1.json`，`data/r3-c3-p2-p3-p4-p5.json`，`shots/r3-*.png`（重点看 `r3-p1-thought-after-6s.png`：展开后的思考标题在原位，右下角出现回底按钮）

### R4　运行中执行 /compact

| 子项 | 做法 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| Enter | `⟦long⟧` 跑到 `sleep 20` 时，输入 `/compact`，按 Enter | 中文提示「等这一轮结束后再压缩上下文」之类；输入框保留 `/compact ` | 第 1 下 Enter 被斜杠弹窗吃掉，只把输入补全成 `/compact `（旧行为，见 X5）。第 2 下 Enter 后 154ms 弹出提示条：标题「等这一轮结束后再压缩上下文」，说明「/compact 还留在输入框里，这一轮结束后再按一次 Enter 即可。」。输入框保留 `/compact `，没有进入队列 | ✅ |
| Ctrl+Enter | 同一回合里按 Ctrl+Enter | 同上 | 按一下就弹出同样的提示条（一次成功，因为输入已经是 `/compact `）。输入框保留，没有进入队列 | ✅ |
| 没有发给模型 | 查网关 | 运行中不会把 `/compact` 当文字发给模型 | 运行期间网关只收到 long 剧本的两步请求，`slashCompactInUserText` 都是 false。主进程日志里 `cannot compact` 出现 **0 次**：运行中的请求在渲染层就被拦下，没有再去问主进程 | ✅ |
| 回合结束后真的压缩 | `LONG-DONE` 之后，输入框里仍是 `/compact `，按一次 Enter | 真的执行压缩 | 17:12:01.071 按下 Enter，3ms 后网关收到摘要请求：不带工具，system 开头是「You are a context summarization assistant…」，消息里是序列化后的对话。网关回 `SUMMARY: 这是假网关给的摘要。`。会话文件新增一条 `type: compaction` 条目（`tokensBefore: 70`，摘要就是上面那句）。输入框被清空。R4 一共跑了两遍，两遍都压缩成功 | ✅ |

证据：`data/r4-compact.json`，`shots/r4-enter-toast.png`，`shots/r4-ctrl-enter-toast.png`，`shots/r4-after-turn-box-kept.png`，`shots/r4-after-compact.png`

### R5　插话回合重开后的时长

做法：三个新会话，各跑一个 `⟦long⟧` 回合。插话回合特意在墙钟第 43 秒发出，让 bash 结束落在**下一分钟**。这样即使「完成于」只精确到分钟，也能分辨它取的是 bash 结束的时间，还是写下那一步调用的时间。重启应用后，从真实侧栏行重新打开这三个会话。

| 回合 | 重启前 | 重启后 | 关键时间戳 | 结论 |
|---|---|---|---|---|
| 插话（R8 A2 同源） | 已工作 20 秒 · 完成于 13:15 | **已工作 20 秒 · 完成于 13:15**（上一轮重开后是「1 秒」） | 那一步 assistant 消息的 `timestamp` 是 17:14:44.576，按它算会显示 **13:14**；`settledAt` 是 17:15:04.609，按它算是 13:15。标记文件（bash 结束时写出）的 mtime 是 17:15:04.605，只差 4ms。界面显示 13:15，说明取的是 bash 结束的时间 | ✅ |
| Stop | 已工作 4 秒 · 完成于 13:15 | 已工作 4 秒 · 完成于 13:15 | 一致 | ✅ |
| 正常 | 已工作 20 秒 · 完成于 13:15 | 已工作 20 秒 · 完成于 13:15 | 一致 | ✅ |

证据：`data/r5-before-restart.json`，`data/r5-after-restart.json`，`shots/r5-*-live.png`，`shots/r5-*-after-restart.png`

### R6　被拦截的调用显示为「已拒绝 / 未执行」

| 子项 | 做法 | 预期 | 实际 | 结论 |
|---|---|---|---|---|
| formA 实时 | 新会话，发 `⟦formA⟧ R6-A …`，结束后展开过程区 | 被拒的调用显示「· 已拒绝」，灰色 | 7 行里有 5 行显示「· 已拒绝」：停止子 Agent ×2、等待子 Agent ×2、列出子 Agent ×1。第一次 TaskList 拿到了真实答复，显示为「已列出子 Agent」，没有结局词。5 行的颜色与普通行相同（灰色，`oklab(0.658 …)`），0 行红色。展开一行被拒的调用，看到的是英文的拒绝原因「Refused: TaskStop has nothing left to act on…」（设计如此：被拒的调用保留原因正文）。会话文件里这 5 条结果都带 `details.refused: true` | ✅ |
| formB 实时 | 新会话，发 `⟦formB⟧ R6-B …`，掐断后展开 | 几十行都显示「· 未执行」，灰色；展开后是调用参数，不是英文句子 | 47 行**全部**是「· 未执行」：读取 13、搜索文件 12、搜索内容 7、运行 7、编辑 1、列出子 Agent 3、停止子 Agent 2、等待子 Agent 2。颜色都是灰色，0 行红色，0 个转圈。展开「搜索内容 needle-2」看到 `{"pattern": "needle-2", "path": "."}`；展开「运行 echo mixed-3」看到 `{"command": "echo mixed-3"}`。都没有出现「The run ended before this call started」。例外是「编辑 loopguard-sentinel.txt」：它能点开，但点开是空的（见 X1） | ✅（附 X1） |
| 重启重开 | 重启后，从侧栏重新打开这两个会话 | 显示与实时一致 | formA：5 行「· 已拒绝」，分布、颜色、展开内容都与实时一致。formB：47 行「· 未执行」，分布、颜色、展开内容都与实时一致，「编辑」行同样是空的 | ✅ |
| 退化回复写进会话文件了吗 | 读 formB 会话的 jsonl | 核对 | **写进去了**：有一条 assistant 消息，`stopReason: "error"`，带 47 个 toolCall 块和一段文字「我来检查一下子代理的状态。」；后面**没有**任何 toolResult 条目；再后面是一条 `aiclient.loopGuard`（`identical_call`，`TaskList {}`，出现 3 次，其中子代理调用 7 个，共 47 个调用）。重开后看到的 47 行「未执行」，是历史投影给这些没有结果的调用补上去的。R1b 的请求里不带这条回复，说明它在发给模型之前被过滤掉了 | 取证 |

证据：`data/r6-outcome-live.json`，`data/r6-outcome-live-b-open.json`（第一次实时读取时误点了一个不能展开的「读取」行，这是修正后重读的结果），`data/r6-outcome-reopen.json`，`shots/r6-*.png`

### R7　切换分支失败的报错

| 做法 | 预期 | 实际 | 结论 |
|---|---|---|---|
| 在 main 上把 `shared.txt` 改成未提交状态，从输入框目标栏的分支列选 dev；然后用真实鼠标悬停在报错上 | 红字显示「切换分支失败: error: Your local changes…」；悬停能看到完整的多行原文 | 红字行内显示「切换分支失败: error: Your local changes to th…」，已经没有 `Error invoking remote method` 这段前缀。报错最宽 320px（`max-width: 320px`），全文宽 1259px，所以被截断。悬停提示是完整的 4 行 git 原文（`white-space: pre-wrap`，第二行带缩进 `\tshared.txt`）。HEAD 仍在 main；工作区文件已还原 | ✅ |

证据：`data/r7-branch-error.json`，`shots/r7-branch-error-chip.png`，`shots/r7-branch-error-tooltip.png`

### R8　冒烟回归

| 项 | 做法 | 实际 | 结论 |
|---|---|---|---|
| A2 基础插话 | R5 的插话回合：`sleep 20` 跑到第 4 秒时按 Ctrl+Enter | 17:14:48.996 按下 Ctrl+Enter。17:15:04.605 标记文件写出，说明 bash 完整跑满了 20 秒。**17:15:04.795 插话请求到达**（bash 结束后 190ms）。没有第 3 步请求；trace 里有 `turn_stopped_by_interjection`；那一步 assistant 消息的 `stopCause=interjected` | ✅ |
| B1 切换分支 | `s30-b.mjs PARTS=b1` | 列表里有 dev、超长名分支、main 三项。main→dev：HEAD 在 156ms 内切过去，按钮在 **551ms** 显示 `dev`；dev→main 用了 479ms | ✅ |
| C1 运行中计时 | R5 正常回合，每 500ms 读一次 `sleep 20` 这一行，共 36 次 | 「运行中 sleep 20; … · Ns / 1m 30s」：N 从 1s 单调走到 18s，每秒加 1，上限始终是 `1m 30s` | ✅ |
| D3 关闭防护 | 用 `dev.env.d3` 重启，跑 `s60-d3.mjs`（`⟦formBshort⟧`，46 个调用） | 46 个块全部流完（`response_complete`，11.79 秒），46 个工具结果全部执行，0 个被拒。哨兵文件和 touch 文件被真实创建（开关关闭时这是预期结果，已删除）。会话文件里 0 条 `aiclient.loopGuard`；没有错误；最终回复 `FORMBSHORT-DONE` | ✅ |

证据：`data/r5-before-restart.json`（`cases.ij`、`cases.norm.c1Samples`），`data/30-b-b1.json`，`shots/30-b1-*.png`，`shots/r8-c1-running-clock.png`，`data/60-d3.json`，`shots/60-d3-*.png`

---

## 新发现（清单之外）

| 编号 | 级别 | 描述 | 证据 |
|---|---|---|---|
| X1 | 低（与 N5 相关） | **没执行的「编辑」行能点开，但点开是空的。** 这一行（`write /tmp/loopguard-sentinel.txt`）因为带着改动内容，被判定为「可展开」；但时间线里的 `ToolGroup` 是 `showDiff={false}`（改动对比只在右侧审阅栏里看），而改动对比又顶替了参数正文，结果面板里什么都没有。N5 代码注释里说的「没执行的调用显示它本来要改什么」（`Modification preview`），在时间线上看不到。实时和重开后都是这样 | `shots/r6-b-live-row-open-3.png`，`data/r6-outcome-reopen.json` 的 `b.reopen.open3.panel = ""`；代码位置：`MessageTimeline.tsx` 约 2978 行、`toolCard.ts` 的 `expandable` / `input: diff ? undefined : inputBody` |
| X2 | 低（旧问题） | **被掐断的回合，实时显示「已工作 1 秒」，重开后显示「已工作 12 秒」。** 实际流式输出了约 11.8 秒，所以重开后的 12 秒才是对的。上一轮的截图 `../shots/21-d1b-failure-surface.png` 里也是「1 秒」，不是 T128 引入的 | `shots/r6-b-live-rows.png` 与 `shots/r6-b-reopen-rows.png`，`shots/r1-a-failure-surface.png` |
| X3 | 观察 | **「继续」会把上一条提示词作为一条新的 user 消息再发一次。** 失败的原提示词仍留在历史里，所以模型会连续收到两条一模一样的 user 消息。代码注释写明这是有意为之（重发提示词）。在本轮的确定性假模型上，这意味着「继续」会原样复现同一次失败（第三次仍在第 47 个块处被掐断）；换成真模型，就等于重试一次 | `data/r1-d1.json` 的 `c.continueRequest.digest` |
| X4 | 观察（旧） | **侧栏的失败徽标是英文字面量 `failed`**，界面其余部分都是中文（`LeftNav.tsx` 写死的字符串） | `shots/r1-a-failure-surface.png` |
| X5 | 观察（旧，N1 的另一半） | **完整输入 `/compact` 后，第一下 Enter 或 Ctrl+Enter 会被斜杠弹窗吃掉**，只把输入补全成 `/compact `，第二下才执行。T128 修的是「被拒后没有任何提示」，这一半没有改 | `data/r4-compact.json` 的 `enter.presses[0]` |
| X6 | 观察 | **压缩成功后界面没有任何反馈**：没有提示条，时间线里也没有标记，只是输入框被清空。会话文件里确实多了 `compaction` 条目 | `shots/r4-after-compact.png` |
| X7 | 观察 | **失败状态不跨重启，也不跨下一次发送。** 被掐断的会话重启后重开，没有失败卡、没有「失败」字样，侧栏也没有徽标，只剩 47 行「未执行」。在线时，发出下一条消息之后，被掐断的那个回合也不再标「失败」 | `shots/r6-b-reopen-rows.png`，`shots/r1-b-after-plain-send.png` |
| X8 | 仅 trace | **点 Stop 之后，trace 里记了一次 `provider_retry`**（`PROVIDER_ERROR`，`delay_ms: 3000`）：bash 被中止后，下一次请求一开始就失败了，被算成了服务方错误并安排重试。但网关没有收到任何重试请求，界面上也没看到影响 | `data/trace-excerpts.jsonl`（run `send-1790270115267-29`） |

## 环境还原

- 进程：Electron（dev.js 进程树）按记录的 pid 停止；假网关（pid 115928）核对过 cmdline 后按 pid 停止。复查 `/proc`，已没有相关进程；9222、5173、18124 三个端口都没有在监听。全程没有用 `pkill -f`。
- 隔离 profile：`~/.pilab/jyw-ai-client-ijrc` 和 `~/.config/jyw-ai-client-ijrc` 已整体删除。
- 临时文件：`/tmp/ij`（测试仓库、两份 dev.env 副本、请求体、trace、标记文件）已删除；三次启动各留下一个 `/tmp/scoped_dir*`，按时间（12:56、13:22、13:25）认定是本轮的，共 3 个，已删除；D3 创建的两个哨兵文件已删除。R1、R2、R6 的哨兵文件从未被创建。`/tmp` 下另有 `loopguard-new*`、`loopguard-orig`、`loopguard-tools-block.ts`，时间是 06:24～06:40，不是本轮创建的，没有动。
- 真实 dev profile 和真实 vault：本轮没有碰过。
- 仓库：没改 `src/`，没做任何 git 写操作。本轮新增或修改的文件只有本目录，以及 `../tools/` 下上表列出的那些脚本。本目录下的 JSON 和新脚本都跑过 `pnpm biome check --write`，结果为 0 错误。
