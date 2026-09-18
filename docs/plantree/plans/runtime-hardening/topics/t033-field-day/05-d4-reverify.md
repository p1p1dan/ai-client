# T033 分片 05 · 批次 D4 九项在新包上的复验

Role: detail shard。上位：[执行单](../t033-field-day-runbook.md)。来源：[batch-d4-fixes-2026-09-17](../../evidence/batch-d4-fixes-2026-09-17/README.md) 各任务的「留给上机 / 真机复拍」小节。

**为什么要在新包上再验一遍**：批次 D4 的九项（T060～T068）是在 **Linux 开发机 + 假网关 + 未打包**的环境里复验通过的。打包态、Windows、加密盘三个变量都没覆盖。本分片只列**那些在开发机上验不了的格子**，已经在开发机上 ✅ 的部分不重复做。

证据放 `evidence/batch-e-field-<date>/d4/`，命名 `d4-T0NN-<slug>.<ext>`。

---

## T060 · 临时根设置读不到 + 未绑定会话运行中消失（D13 high / D6）

开发机已验：改设置后新建的临时对话落在新根、重启后索引行指向新根、工作区树签名变化后 16 条未绑定会话一条没少。**上机补的是落盘那一步与界面那一步**（照 `fixes/T060.md` 第八节的八格）：

| 格 | 操作 | 期望 |
|---|---|---|
| DEV-2-a | 运行中用 GUI 把「保存位置」改成新根，然后新建一条临时对话并发一句 | scratch 目录落在**新根**的 `unbound-sessions/` 下 |
| DEV-2-b | 改设置后 **5 秒内**（防抖窗口内）立刻新建临时对话 | 同样落在新根（钉的是未落盘排队分支） |
| DEV-2-c | 改设置后重启，查 `session-index.json` 的 unbound 行 | **新建的**指向新根；改设置之前建的仍指旧根（旧行不迁移是预期，不是缺陷） |
| DEV-2-d | 在新根下手工删掉一个临时工作区目录，再打开那条会话 | 自愈生效，目录带 `.git` 被重建；无 `spawn … ENOENT` |
| DEV-6-a | 临时对话跑完一轮后留在侧栏，然后新增/删除临时工作区、增删仓库、切换选中仓库 | 「临时对话」分组里那条**不消失** |
| DEV-6-b | 那条对话正连着 worker（发送中）时做同样动作 | 仍在列表里、仍在 `hostBoundSessionIds` 里、回合不中断 |
| DEV-6-c | 没有任何仓库时新建临时对话并发一句，再添加一个仓库 | **不被收养**进新仓库，仍留在「临时对话」组 |
| DEV-6-d | **已知未修**：把所有仓库都移除让工作区树变空 | 预期仍会清空全部会话（`!preferred` 早退）。**记录现象即可**，供决定是否新开条目 |

证据：`d4-T060-<格号>.txt` / `.png`。

---

## T061 · 预算拒绝后 store 中毒 + 附件名不落盘（D1 / D24 high / D25）

| 点 | 操作 | 期望 |
|---|---|---|
| ① | 连发 4 条「1 张 ≈5 MiB 图 + 1 张 ≈1 MiB 图」把文件顶到 ≈31.9 MiB，第 5 条被拒，**然后清掉附件、打一句纯文本、点发送** | 消息正常出现在时间线、网关计数 +1、会话文件变长几百字节。**静默丢弃判负** |
| ② | 看第 5 条被拒时 composer 上方的红块 | `Error: session exceeds the configured size budget` **仍在**（确认①没有把它顺手抹掉） |
| ③ | 发一条带 `big-5mib.png` / `small-1mib.png` 的消息，**退出应用、重开、点回同一条会话** | 时间线上两个附件片仍显示文件名，不是 `image/png`。**只对修复之后新写入的消息有效**——旧会话文件里 block 上没有 `aiclientName`，回放退回 media type 是预期 |
| ④ | 用一个真 `pi-messages` provider 发一张图 | 网关在**没有**未知键的情况下正常返回（确认出网剥键后仍然正常） |

> 挂图的办法：渲染层没有 `input[type=file]`、⊕ 走原生对话框（CDP 驱动不了）。手点即可；要脚本化就往 textarea 派带 `File` 的 `ClipboardEvent('paste')`（同一条 `ingestFiles` 管线）。

证据：`d4-T061-<点号>.png`、`d4-T061-session-bytes.txt`。

---

## T062 · 模型目录两侧口径 + 模型缺失中文覆盖层（D19 / D3）

| 点 | 操作 | 期望 |
|---|---|---|
| ① | 复制一份真实会话，尾部追加一条 `model_change`（`provider: "vllmproxy-old"`, `modelId: "claude-does-not-exist"`），补索引行，**并设好 localStorage 的每会话模型钉子**，在 GUI 里发一句 | 出 H/21 中文覆盖层：「本应用没有这个模型」/「这个会话记录的模型不在本应用的模型目录里…」/ 按钮「去 Pi 设置补上模型」，**不是** `Error: no model "…" in the catalog`。composer 底下的状态条也应是中文 hint |
| ② | 看诊断行 `[pi-models] models.json holds providers no session can use { dropped: … }` | **这条走 `console.info`**，在 `main.log` 里可能看不见；去 `logs/aiclient-<date>.log` 或 dev 标准输出里找。找不到就并进可观测性小修包，**别当成没记** |
| ③ | 让凭据库读不出来（keyring 锁住），看模型选择器 | 两侧都回落读盘、选择器内容与改前一致、无 `dropped` 日志 |

证据：`d4-T062-overlay.png`、`d4-T062-dropped-log.txt`。

---

## T063 · 兼容根子代理定义「编辑后删不掉」（D12）

界面侧一行未改，所以必须走一遍 GUI 才算收口（Windows 上兼容根是 `%USERPROFILE%\.agents\subagents`）：

1. 在兼容根放 `probe-compat.md`（描述写 `ORIGINAL`），确认**主目录没有同名文件**；
2. 设置页子代理列表里该行「在文件夹中显示」应指向**兼容根路径**；
3. 编辑描述为 `EDITED` 保存 → 兼容根文件哈希变化、内容为 `EDITED`，**主目录依然没有该文件**；
4. 点删除 → 该行立即消失、兼容根目录为空、刷新或重启后**不再出现**；
5. 反向：兼容根放定义 A、主目录放不同名的定义 B，删 B 后 A 仍在；
6. 内置：对 `explorer` 点「自定义」→ 保存 → 主目录出现 `explorer.md`；删除后列表回到内置版本；
7. 顺带观察：删除确认框文案仍是单数「This removes the definition file.」；
8. **另需确认**：本次改动让编辑会写入兼容根（跨工具共享目录，pi TUI 等也读），写入后**其它读者仍能解析**。

证据：`d4-T063-<步骤>.png`、`d4-T063-hashes.txt`。

---

## T064 · bootstrap 失败后的用户输入与空壳索引行（D15）

**正反两条不能只做一条**（二审的 note）：

| 臂 | 操作 | 期望 |
|---|---|---|
| 正 | 发送后**全程不碰输入框**，等 bootstrap 失败 | 原文回输入框、附件回来、右下角**没有** ↺、索引行不增 |
| 反 | 等待期间**再打一个字** | 用户的字不被覆盖；↺ 出现且 `aria-label` 带附件计数；点 ↺ 能端到端重发成功（网关落盘的请求体里原文与图都在） |

证据：`d4-T064-<臂>.png`、`d4-T064-index-count.txt`。

---

## T065 · 跨窗口同会话互斥 / 挂起恢复重绘（D18 / D17）

| 点 | 操作 | 期望 |
|---|---|---|
| D18 | File → New Window 开第二个窗口选中同一聊天进 TUI；再走「窗口二进来就是 TUI 模式点 Start Pi TUI」那条路 | 两条路都弹**中文 toast** 且界面不切；进程表里**始终只有一个 pi** |
| D18 反向 | terminal-03 的过度释放：同一 terminalId 上此前已成立、pi 仍在跑的那把认领**不被连带清掉** | 切另一个聊天后原会话的认领仍在 |
| D17 | **Windows / ConPTY 上**反复做「挂起 → 恢复」切换，至少 25 次 | 开发机 Linux 上是 27 次里 26 次整屏重绘、1 次仍空白（约 4%）。**Windows 上要复采这个概率**，并记「一次 resume 三次 resize」的 reflow 观感（会不会看到跳动） |
| 关窗 | 一个主窗 + 一个预览窗时关主窗 | 文案与事实一致（预览窗**不算**「还有别的窗口」） |

证据：`d4-T065-d18-toast.png`、`d4-T065-d17-<n>.txt`（记 N 次里几次空白）、`d4-T065-close-copy.png`。

---

## T066 · 可观测性：按天日志（D4 / D10 / D14）

**保持日志开关默认关闭**，然后在 `logs/aiclient-<date>.log` 里 grep：

| 点 | 造法 | 期望 |
|---|---|---|
| ① | 跑一次索引修复 / 一次导入（含一条失败）/ 一次归档 | 索引修复 1 条 warn；导入起止 2 条 info + 失败 1 条 warn；归档 3 条 info |
| ② | 造 503 重试 | **在重试发生的当下**看到 `provider_retry` warn 行，不是只在 trace 里 |
| ③ | 造一次 `session_size_limit` | 应用**仍在运行时**就能 grep 到 `turn failed: session_size_limit: …`（带码），不再依赖杀进程后的 stderr 回放 |
| ④ | 跑一天正常使用后看日志体积 | `[local-image]` 那两行已降 `debug`，不应把文件撑到轮转 |
| ⑤ | 脱敏回归 | 整段日志 grep `sk-ant` / `SECRET` / `plaintext` = 0；scratch 删除失败行**一条 warn、一个参数**、路径全折成 `~` |

证据：`d4-T066-daily-log-excerpt.txt`、`d4-T066-grep-secrets.txt`。

---

## T067 · i18n 补漏包（D9 / D20 / D21 / D26）

**中文界面**下逐张复拍：

| 点 | 拍什么 | 期望 |
|---|---|---|
| DEV-11 | 导入 > 4000 条 / > 64 MiB 的 Claude 会话的失败行 | 整行中文，含「64 MiB」而非 `67108864`，含「请改导入较小的对话，或先拆分后再导入」 |
| DEV-24 | 503 重试横幅 | 「上游返回错误 503 · 正在重试 1/3 · 本回合仍在进行」，展开钮是「详情」，与下方 composer 同语言 |
| DEV-25 | 问答卡 | 标题「提问」、末行「其他…」、按钮「跳过」「继续」；答完 / 跳过后冻结卡是「回答」「已跳过提问」「已跳过」 |
| DEV-33 | 贴 6 张图 / 贴 7 MiB 图 / 贴空文件 / 贴 `.bmp` | 四句拒绝全中文；折叠多条时外壳是「已跳过 N 个附件：」 |
| DEV-33 遗留 | 贴总量 > 2 MiB 的附件看 composer 状态行 | 开发机已补上接线（`ChatComposer.tsx:2623` 传 `t`），**全仓没有任何测试能覆盖这一行**，只能靠这次真机复拍 |

> 已知未动的一条账：`formatAttachmentSize` 仍输出 `MB/KB`（二进制除数、十进制单位），不在 D26 范围内，看到不必记成新缺陷。

证据：`d4-T067-<点号>.png`。

---

## T068 · 字重 / header chip / 死代码（D23 / D22 / D16）

| 点 | 操作 | 期望 |
|---|---|---|
| **DEV-25 字重（必做，只有 Win10 能判）** | 用同一份计划的 `write-approval` 与 `ask-question` 各出一张卡，CDP 取 `getComputedStyle` 的 `fontWeight` | 两张卡的**段头与标题 = 600**、正文与选项描述 = 400、选项按钮 = 500（**在 Win10 上会落到 400，这是允许的**，因为按钮不承载层级）。与开发机的 `dev-25-permission-card-computed.json` / `dev-25-question-card-computed.json` **同口径对拍**，并存一张对照截图 |
| DEV-25 header chip | 让 ask 调用带 `header:"点验顺序"` | 卡上出现该 chip，位置在问题正文**正上方**，字号 13px |
| DEV-18 | 🚫 **已退役**，不要构造「Node 24 解析失败」 | 改为顺带确认 [WIN-2](01-win.md)：改名 `resources\node-runtime\node.exe` 后横幅是 `Pi Node runtime is missing: <路径>`，**且全文不提 `AICLIENT_NODE24_PATH`** |

证据：`d4-T068-fontweight.json`、`d4-T068-cards.png`、`d4-T068-header-chip.png`。

---

## 三条环境事实（两轮复验都记过，上机同样适用）

1. **vault 里的自定义 AI 服务不带图片能力声明** —— 用它验附件出网永远看不到 image block；
2. **只改会话文件的 model 不足以制造「模型缺失」** —— 还要 `localStorage` 的每会话模型钉子；
3. **dev.js 收到 SIGTERM 的退出路径不跑 scratch 的 `wipeAll`** —— 用 SIGTERM 结束应用时别把「scratch 没清」当缺陷。
