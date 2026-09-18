# T033 分片 03 · PKG 组（打包态 / utility 载体，23 项）

Role: detail shard。上位：[执行单](../t033-field-day-runbook.md)。判据权威：[checklist-e.md 第 4 节 utility 表](../../checklist-e.md#electron-utility-载体打包态上机日19-项--新增-pkg-2023见第二节)。

**注意载体差异**：Windows 打包态的会话 worker 走 **bundled-node**（随包 `node.exe`），Linux / macOS 走 **electron-utility**。本组里标「utility 载体」的项在 Windows 上要么用 utility 通道的三个产品功能（评审 / 分支命名 / 提交信息，它们在 Windows 上也走 utility），要么明确记为「本项在 Windows 上不可复现，留 Linux/macOS 打包产物」。证据放 `evidence/batch-e-field-<date>/pkg/`。

---

## 轮 P-a · utility 通道三功能与容量（约 45 min）

**四项一轮做完**，共用同一次应用启动。

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| PKG-4 | 必 | 打包态各跑一次代码评审 / 分支命名 / 提交信息 | 三个功能各一次成功回合；worker 进程在结算后**确实退出**（无残留）。任务管理器观察 `AiClient Pi Worker N` 的生灭，同时记 `utility.terminal` 的 `state` 与 `model` | `pkg-04-utility-three-features.png`、`pkg-04-worker-lifecycle.txt` |
| PKG-6 | 必 | 依次触发三个功能占满 `capacity=2`，看第三个的提示 | 提示文案是**界面语言**且**可操作** | `pkg-06-capacity-message.png` |
| PKG-5 | 必 | 把评审超时临时调小（或对一个超大 diff 跑满 10 分钟），**录屏** | 超时后：面板是否还显示已生成正文、复制按钮是否仍可用、能否重试、worker 是否残留——四问各记一句 | `pkg-05-review-timeout.mp4`、`pkg-05-processes.txt` |
| ENC-1 | 必 | 冷启动耗时三次（在 [02-enc](02-enc.md) 里，与本轮同一次启动做掉） | 三次最大值 < 10 s | `enc-01-utility-coldstart.txt` |

---

## 轮 P-b · worker stderr 的三条（约 35 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| PKG-1 | 必 | 用一个**会在 stderr 打印环境**的假 provider 触发 worker 启动失败，检查 `main.log` 的崩溃回放段 | 日志里**不出现** `sk-` 开头的 key、`Bearer <token>`、`*_API_KEY=<值>` 原文 | `pkg-01-mainlog-redaction.txt` |
| PKG-2 | 必 | 让 worker **分块**打印一段长 stderr（含 CRLF） | `main.log` 里是**完整整行**，不是半行交织 | `pkg-02-stderr-assembly.txt` |
| PKG-9 | 必 | 让子进程在一轮内刷 **60 行** stderr（其中一条带假密钥） | 面板末尾出现 `…more stderr this turn is in the worker log only (forwarding capped at 50 lines)`，且**前 50 行均已脱敏** | `pkg-09-stderr-cap-50.png` |

> 主日志的位置：要看的是 `logs/aiclient-<date>.log`，**`main.log` 不是主日志**（T066 澄清）。日志开关关闭时 file 档是 `info`、console 是 `warn`。

---

## 轮 P-c · 载体差异与退出语义（约 50 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| PKG-15 | 必 | 改造后的 `src/runtime/smoke/p1-utility-worker.ts` 经 `scripts/runtime-smoke/electron-carrier.cjs` 运行（走**产品路径推导**，不是 explicit） | `carrier==='electron-utility'` 且 `node.source==='bundled'`、`node.path !== process.execPath`、`tsdReadFallback==='configured-node'`，六项工具断言全通过，报告带 Electron 版本与 HEAD 版本戳 | `pkg-15-u1-utility-probe.json` |
| PKG-10 | | 沿用 `p1-utility-worker.ts`，host 配置改走产品路径推导 | `carrier=electron-utility` 且 `node_source` 由产品路径推导（不是 explicit），六项断言全通过；结果与 HEAD 版本戳绑定 | `pkg-10-utility-probe.json` |
| PKG-17 | 必 | 同一次 bootstrap + 一次 run 的 worker→Main 消息，在 `utilityProcess` 与 `fork()` 两条通道下各录一份 JSON，跑 diff | 逐字段等价，**尤其没有 `undefined` 键差异**（JSON 下消失、结构化克隆下保留）。差异逐条解释 | `pkg-17-utility.json`、`pkg-17-fork.json`、`pkg-17.diff` |
| PKG-18 | 必 | 两个载体各用外部 SIGKILL / `taskkill` 杀一次 worker，抓 `main.log` 对应行 | 记录两个载体各自的 `Worker exited (code=? signal=?)`；确认 `isLostDisposeAck`（`WorkerSlot.ts:118-125`，要求 `code===0 && signal===null`）**不会把崩溃误判成「dispose ACK 丢了」** | `pkg-18-exit-codes.txt` |
| PKG-19 | | 打包产物里跑两条 bash：`node -v` 与 `which node` | 确认 PATH 首位是否是随包 Node（`resources/node-runtime`），以及这**是不是想要的行为**（契约第 4 节写了规则但没写非 Windows 上的意图）。结论回写契约或 ARD | `pkg-19-bash-path.txt` |

---

## 轮 P-d · stdout 背压（约 40 min，三家合一只做一次）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| PKG-3 + PKG-16 | 必 | **一次做完**：在真实 Electron utility worker 里注入一个定时 `process.stdout.write` 的探针，一次回合内写 ≥ 1 MiB（U2 口径是 4 MiB），期间用一条只读 RPC 做存活探针，用 CDP 或 `app.getAppMetrics` 采 Main 的 RSS | worker 在写入期间与之后仍能正常应答 `worker.tree` / `worker.history`（不超时）；Main 进程 RSS **不随写入量线性增长**；worker RSS 增长 < 数 MiB。任一条不成立即证实 main-host-04 / tsd-03 | `pkg-03-stdout-pressure.json`、`pkg-03-rss-timeline.csv` |

> 这一项是 `main-host-04`、`tsd-03`、`U2` 三个区域独立提出的同一件事，**只做一次**，结果同时回填三处。

---

## 轮 P-e · 并发、trace 与导入（约 40 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| PKG-12 | 必 | 开三个会话各跑一轮，看进程数与常驻内存 | 进程数 = 3 个 worker + 每会话 MCP 数；常驻内存在机器可承受范围。**这一项开发机做不了**（2 核 / 3.3 GB 会得出假结论），必须在加密机或一台内存充裕的机器上做 | `pkg-12-three-sessions.png`、`pkg-12-rss.txt` |
| PKG-13 | | 设 `AICLIENT_RUNTIME_TRACE_DIR` 后开 3 个会话跑到**至少两次轮转**，跑完 `wc -l runs*.jsonl` 并比对 `run_id` 并集 | `runs.1/2/3.jsonl` 连续无空洞、行数守恒。**收集时要过滤掉 `runs.rotate.lock`** | `pkg-13-rotation.txt` |
| PKG-14 | | 起 Electron 开满 3 个会话后发起旧对话导入，导入前后各数一次 worker 进程 | 记录是否出现第 4 个 worker 进程 | `pkg-14-import-peak.txt` |
| PKG-7 | | 起 Electron 导一条会话，再用随包 CLI 打开同一文件 | `<agentDir>/sessions/<id>.jsonl` 能被 `pi --session` 打开，并出现在 TUI 的会话列表里（列会话用 `--session-dir <dir> --resume`，pi 没有非交互式列表 flag） | `pkg-07-pi-opens-import.png` |
| PKG-8 | | TUI 交接后观察 `worker.reload` 耗时（**带 MCP**） | 在 `BOOTSTRAP_REQUEST_TIMEOUT_MS` 内完成，不超时退槽 | `pkg-08-reload-timing.txt` |
| PKG-11 | | 随批次 E 常规测试套跑一次 `subagentHostProbe.test.ts` | 10 条在 Windows 与 Electron utility 载体上同样全绿。**无需专门驱动** | `pkg-11-subagent-probe.txt` |

---

## 轮 P-f · 新并入的四项（约 60 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| PKG-23 | | 打包态起应用 → 走**一整回合**（含工具、审批、压缩）→ 看权限卡与时间线 → 看侧栏「能力」面板与插件设置页文案 | 无回归；「能力」面板列出 native runtime 自己的 MCP / 技能 / 子代理（「未报告」与「报零」两态可区分）；插件页文案两句见 [05-d4-reverify](05-d4-reverify.md) 的 DEV-36 行 | `pkg-23-full-turn.png`、`pkg-23-capabilities-panel.png` |
| PKG-20 | | electron-utility 与 Windows bundled-node 两种载体**各跑一遍**「后台委派 + 审批 + 写入 + 取消」，跑完查残留 | 两载体都无残留子进程（`ps` / `tasklist`） | `pkg-20-<载体>-subagent-matrix.txt` ×2 |
| PKG-21 | | 把派生的 `models.json` **改名**后，native 发一条消息；再起一次 TUI | native 会话**仍可用**；legacy / TUI 侧报错（证明这文件只剩 CLI 在读） | `pkg-21-native-after-rename.png`、`pkg-21-tui-error.png` |
| PKG-22 | | **按 [执行单 §2.2](../t033-field-day-runbook.md#pkg-22-的执行方式必须改两版包装不成两份) 改过的方式做**：新版 portable 写出会话文件 → 旧版 installer 安装态打开同一文件 → 再用本版打开一次 | 要么正常打开，要么给出**可读的说明**；**不得静默丢条目或写坏文件**。回过来用本版打开确认文件未被写坏 | `pkg-22-old-opens-new.png`、`pkg-22-hashes.txt`、`pkg-22-file-before-after.diff` |

> PKG-22 的两个 exe 文件名完全相同（`AiClient Setup 1.0.0-test.13.exe`），**每次动包前先 `Get-FileHash` 对一遍**：新版 installer `b0ce16cb…`、新版 portable `431cb7ed…`、旧版 installer `ee9a1387…`。
