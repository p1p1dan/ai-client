# T033 分片 02 · ENC 组（加密文件系统 / TSD，24 项）

Role: detail shard。上位：[执行单](../t033-field-day-runbook.md)。判据权威：[checklist-e.md 第 4 节加密机表](../../checklist-e.md#加密文件系统--tsd上机日与-windows-同机22-项--新增-enc-2324见第二节)。

与 WIN 组**同机**。证据放 `evidence/batch-e-field-<date>/enc/`。

---

## 轮 E-0 · 当天的第一项（约 20 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| ENC-16 | 必 | 安装版 GUI 里 `read` 一个**受策略目录下的**文件 | 返回明文、**不出现 `io_tsd_unavailable`**；同一次 run 的 `runs.jsonl` 版本戳是 `carrier=bundled-node`、`tsd_read_fallback=disabled`、`node_exec_path=…\node-runtime\node.exe` | `enc-16-read-plaintext.png`、`enc-16-version-stamp.json` |

> **不通过就停下来先想**：ENC 组后面所有项的判据都建立在「随包 node.exe 仍在白名单内」这个前提上。2026-09-09 那份记录换机器即作废。不通过的话，ENC-7 / ENC-8 的 A/B/C 映射要按「载体不在白名单」这一支重新解释，且要当场通知编排器改判读口径。

---

## 轮 E-a · 明文往返与载体识别（约 60 min，F3 根因的另一半）

**这一轮用同一份样本文件做完六项**，不要分六次造样本。样本准备：在受策略目录下用 GUI 的 `write` 工具写 `tracked.txt`，内容里放一个哨兵串。

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| ENC-17 | 必 | 用工具写 `tracked.txt` → 用 PowerShell 原生 `[IO.File]::ReadAllBytes` 读**头 16 字节** → 再用 GUI `read` 读回 | 盘上是密文容器（非白名单进程看到 `%TSD-Header-###%` 与容器大小），GUI read 读回原文 | `enc-17-header-bytes.txt`、`enc-17-gui-read.png` |
| ENC-18 | 必 | 对同一文件 `edit` 一次，edit 前后各取一次头 16 字节 | 仍是密文容器；GUI 再读内容正确；非白名单进程仍看到密文 | `enc-18-header-before-after.txt` |
| ENC-20 | 必 | 用 bash 工具跑 `type`（或 `cat`）读同一文件 | 输出与 GUI read **一致**（两条路径各取一次输出并 diff）。这一项复核「Git Bash 在白名单内」在**当前机器 / 当前驱动版本**上是否仍成立 | `enc-20-bash-vs-gui.diff` |
| ENC-7 | 必 | **R2**：在 bash 工具里调随包 node 读同一文件；**R3**：把随包 `node.exe` 复制改名成 `bash-probe.exe` 后再读一次 | 先用非白名单进程读出 `%TSD-Header-###%` 头**存证**（这是 test.12 缺的那一环）；两次读取的明文/密文两态必须可区分，连同 SHA256 一并记录 | `enc-07-r2-bundled-node.txt`、`enc-07-r3-renamed-copy.txt`、`enc-07-sha256.txt` |
| ENC-21 | | 手写一个**以 `%TSD-Header-###%` 开头的明文 txt**，`read` 它 | 期望当前报 `io_tsd_unavailable`；照抄原始文案作为 FIX 后的对照 | `enc-21-magic-false-positive.txt` |
| ENC-19 | 必 | 工作区里放一个当前进程读不了的受策略文件（或 `icacls` 去掉读权限），跑一次 `grep` | grep 仍返回其余命中并**报出 skipped 条数** | `enc-19-grep-with-unreadable.txt` |

### ENC-8 —— F3 根因拍板（必，约 15 min，纯判读不用操作）

把 [WIN-16](01-win.md#轮-w-f--bash-载体取证约-50-minf3-根因的一半)（R0）与上面 ENC-7（R2/R3）、ENC-20（E5）的结果填进 [bash-carrier-decision.md](../../../../../plans/2026-09-09-bash-carrier-decision.md) 第 6 节表，按该文件第 5 节的映射拍板：

| 现场结果 | 结论 |
|---|---|
| R1/E5 读到明文，R0 拿到了真实映像路径与父进程链 | **A（维持系统 Git Bash）**，代价 0，写入 ARD §8 |
| bash 读到密文，但随包 node 改名副本（R3）读到明文 | 放行按**签名或目录路径** → **B（随包 Git Bash）可行**（数十 MB + 一整条打包链 + msys2 依赖） |
| R2 明文而 R3 密文 | 放行按**进程名** → **B 不可行**，走缓解或 **C** |
| bash 与随包 node 都读到密文 | **C（Windows 不提供 bash 工具）**，能力大幅退化，作为临时降级 |

**三处回填**（当天就写，见 [06-closeout](06-closeout.md)）：决策文件第 6 节表 + 结论段、旧树 README 的 F3 行、P4-6 表第 136 行。

> 注意该文件第 8 节的缺口：`version_stamp` **没有记 shell 路径**，所以现场无法用 trace 自证「这次 bash 用的是哪一个 bash.exe」，只能靠 WIN-16 手工抓进程。**WIN-16 拿不到进程映像，ENC-8 就不能签。**

---

## 轮 E-b · TSD helper 的两条性能与噪声项（约 45 min，需要 Process Monitor）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| ENC-24 | | 读一个 **≥ 2 MiB** 的受策略文件，用 Process Monitor 数 helper 进程创建次数，同时记 trace 的 latency | helper 子进程创建次数应是**个位数**、总耗时接近线性（改前是 32 KiB 固定分块导致 O(n²) 重读与上百次子进程） | `enc-24-procmon-helper-count.csv`、`enc-24-latency.json` |
| ENC-23 | | 造一个「configured Node 往 stderr 打噪声」的场景，再读受策略文件 | 仍被判为可读、返回明文，**不出现 `io_tsd_unreadable`**（T013 `19f9e888` 给了 stderr 独立 4 KiB 预算）。抓 trace 的 exec 事件看 stderr 字节数与结果 | `enc-23-stderr-noise-trace.json` |
| ENC-22 | — | **条件项**：仅当 tsd-01 按「接通回落」修法推进时才跑。当前未推进 → 记 🚫 | 一次 read 起两个进程（exec-runner + helper）、30 秒内返回明文 | — |
| ENC-15 | 必 | 加密机上**连跑 20 条短命令**，从 trace 取 `tool_execution_start` → `tool_execution_end` 的差值分布；同时用 Process Monitor 看 `taskkill.exe` 的创建耗时 | 间隔**持续超过 1000 ms** 即说明 2000 ms 预算不安全 | `enc-15-taskkill-latency.csv` |

---

## 轮 E-c · 写锁与会话恢复（约 40 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| ENC-14 | 必 | 在受策略目录开一个会话 → 读 `<会话 jsonl>.writer.lock` 的**前 16 字节** → 手写一把 pid 不存在的陈旧锁 → 重开会话并**计时** | ① 锁是不是 TSD 容器（看有没有 `%TSD-Header-###%`）；② 正常打开耗时；③ 陈旧接管是否在 **60 秒** bootstrap 预算内完成。若锁是容器，一次陈旧接管要读两次锁、最坏 60 秒，正好等于 Main 的预算——这决定 concurrency-01/02 的现场严重度 | `enc-14-lock-header.txt`、`enc-14-takeover-timing.txt` |
| ENC-6 | | 对一个真实会话文件**中段插一行坏 JSON**，重开会话，比对树节点数与文件行数 | 坏行被跳过并原子重写后：会话树节点数 = 文件里存活条目数、历史时间线不缺条目、`session.status` 带 recovery rider | `enc-06-midfile-corruption.txt` |
| ENC-5 | 必 | 造一个 **v4 非 interop 头**的会话文件放进受保护目录，点 TUI | 记录实际形态：是被我们的提示拦住，还是直接进终端撞 CLI 原文报错 | `enc-05-tui1-gate.png` |

> 会话文件路径公式：`<会话 jsonl 全路径>.writer.lock`，sidecar，与 jsonl 同目录。内容是 `{pid, host, token, acquiredAt, startedAt}`。看到 `session_locked` 时**先查有没有活进程真占着**，别当成新缺陷。

---

## 轮 E-d · 导入链在加密机上的闭环（约 45 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| ENC-3 | 必 | 用现成工具函数写一个只读小脚本，对任一 `~/.codex/sessions/**/*.jsonl` 跑 `isFileTsdEncrypted`；再打开导入面板看 Codex 项目 | 若 rollout 首部带 TSD 头，导入面板里 **Codex 项目应为空或全部会话被跳过**（`CodexSessionScanner` 完全没有 TSD 分支，受覆盖时会读到密文并在 `JSON.parse` 处失败） | `enc-03-codex-tsd-probe.txt`、`enc-03-import-panel.png` |
| ENC-4 | 必 | 走 GUI 完整导入一条真实 `~/.claude` 会话，然后打开并续聊 | 能被列出、能导入、导入后能打开并续聊。记录 `sessions/` 下产物路径与会话索引行 | `enc-04-claude-import.png`、`enc-04-artifact-path.txt` |

---

## 轮 E-e · 加密域下的 GUI 一致性与既有回归（约 50 min）

| # | 必 | 一句操作 | 判据 | 证据文件 |
|---|---|---|---|---|
| ENC-11 | | 在加密域目录做一次完整读写，GUI / TUI / 外部编辑器**三处各读一次** | Read 得明文；Edit/Write 后三者内容一致 | `enc-11-three-readers.txt` |
| ENC-12 | | 逐个在 Git 面板与编辑器打开四份样本（GBK / UTF-16 LE+BOM / UTF-8+BOM / 真实二进制），见 [field-samples](../../evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md) 第 2 节 | **逐样本**记 Main diff 与编码判定的通过或失败。这是 P4-6 表第 137 行点名的精确缺口 | `enc-12-<样本名>-diff.png` ×4、`enc-12-verdicts.md` |
| ENC-10 | | 按 F2-b 的三时点法，在加密目录重跑临时目录的复用 / 创建 / 绑定三条路 | 三条路与开发机结果一致 | `enc-10-a4-three-paths.json` |
| ENC-9 | 必 | 复跑 `scripts/run-f4-retry-probe.mjs`（需 Node 24） | 503×2 后成功、持续 503 四次尝试共 **43 秒**耗尽、429 听 `Retry-After`、退避中取消**立即**结束。trace 的 `provider_retry` 与假网关**实到请求数**两侧都要看 | `enc-09-f4-retry-report.json` |
| ENC-13 | | 本地模式首次进入、加服务、统一目录迁移、插件安装卸载，整链在加密盘上跑一遍 | H/17 + H/19 全链路可用（与 WIN-21 / WIN-22 是同一组功能在不同场地，**两处都要做**） | `enc-13-h17-h19.png` |
| ENC-1 | 必 | 点三次「生成提交信息」冷启动，记 `utility.start` 发出 → 收到 ack 的耗时 | **连续三次冷启动的最大值 < 10 s** 才算通过（10 秒预算是否够）。可在 `PiUtilityService.ts:192` 前后打时间戳，或用 `--remote-debugging-port` 在 Main 日志里读 | `enc-01-utility-coldstart.txt` |
| ENC-2 | | 打印 `app.getPath('userData')` 并对该路径做一次普通读写 | `session-index.json` 是否落在受策略目录内；是否受 TSD 读写约束 | `enc-02-userdata-location.txt` |
