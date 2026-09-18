# T033 上机日执行单

Role: topic capsule。建立：2026-09-17。对应 [roadmap](../roadmap.md) 批次 E 的 T033（加密 Windows 一次性全量验收）。
判据与取证的**权威仍是** [checklist-e.md](../checklist-e.md)：本文件不复制判据，只排顺序、配命令、定证据文件名。两者冲突时以检查单为准。

详细执行分片（逐项一行）在同名目录 [t033-field-day/](t033-field-day/)：
[WIN 组](t033-field-day/01-win.md) · [ENC 组](t033-field-day/02-enc.md) · [PKG 组](t033-field-day/03-pkg.md) · [MODEL 组](t033-field-day/04-model.md) · [批次 D4 复验](t033-field-day/05-d4-reverify.md) · [收尾回填](t033-field-day/06-closeout.md)

---

## 1. 这份文件怎么用

上机日是**一次性**的：Windows 加密机不常驻，当天拿不到的数据要等下一次上机。所以：

- 当天的每一分钟都按下面第 5 节的顺序走，不要临场决定先做哪项。
- 每一项只有三种收尾：✅（挂证据文件）、⛔（挂证据文件 + 一句实际现象）、🚫（写明为什么不做）。**不接受只写「通过」。**
- 现场与静态推断不符时**以现场为准**，当场回写审计证据，不留到事后（检查单 §6 的取证规矩，批次 D 的 P4-6 就是漏了这条才二次冲突）。

---

## 2. 装机

### 2.1 本版包（主角）

Build [35295618831](https://github.com/p1p1dan/ai-client/actions/runs/35295618831)，源码 `13e6cdb7`（= 本文写作时的 HEAD），分支 `feat/runtime-evolution`，2026-09-18 完成，七个 job 全 success。产物清单存档在 [evidence/batch-e-build-2026-09-18/](../evidence/batch-e-build-2026-09-18/README.md)。

| 产物 | 大小 | artifact id | 过期时间 | 用途 |
|---|---|---|---|---|
| `windows-installer` | 188 MB | `10527808622` | 2026-10-02 | **主装机包**（WIN / ENC / PKG / MODEL 全部用它） |
| `windows-portable` | 188 MB | `10527663704` | 2026-10-02 | 备用；PKG-22 若不愿装两遍可用它做「另一份产物」 |
| `windows-unpacked` | 274 MB | `10527547633` | **2026-09-25** | 需要直接改 `resources/` 里的文件时更方便（WIN-2/36 改名 node.exe） |

> 三种产物的保留期**不一样**（安装包与 portable 到 2026-10-02，unpacked 只到 2026-09-25）；[本次 Build 的证据 README](../evidence/batch-e-build-2026-09-18/README.md) 里写的「到期 2026-09-25」取的是最早的那一个。

`windows-installer` 与 `windows-portable` **已于 2026-09-17 下载留档**在开发机 `/home/ai/t033-artifacts/new-13e6cdb7/`（哈希见 §2.2），直接拷到机器上即可。还需要 `windows-unpacked` 时才用 `gh`（**2026-09-25 过期**）：

```powershell
gh run download 35295618831 -n windows-unpacked -D C:\t033\pkg-new-unpacked
```

### 2.2 上一版包（PKG-22 回退窗口专用）—— 有硬期限

PKG-22 要「用上一个安装包打开本版写出的会话文件」。上一版是 test.13 CI [34424337205](https://github.com/p1p1dan/ai-client/actions/runs/34424337205)（源码 `c0ae2a34`）。

**两版包 2026-09-17 都已下载留档在开发机 `/home/ai/t033-artifacts/`**，上机日直接拷过去即可，不必再连 GitHub：

| 文件 | 来自 | SHA256（前 8 位） |
|---|---|---|
| `new-13e6cdb7/AiClient Setup 1.0.0-test.13.exe` | run 35295618831 installer | `b0ce16cb…` |
| `new-13e6cdb7/AiClient-1.0.0-test.13-portable.exe` | run 35295618831 portable | `431cb7ed…` |
| `prev-c0ae2a34/AiClient Setup 1.0.0-test.13.exe` | run 34424337205 installer | `ee9a1387…` |

全文见 `/home/ai/t033-artifacts/SHA256SUMS.txt`。GitHub 侧的原始产物 2026-09-24 就会过期（`windows-unpacked` 已过期），所以**本地这份留档是唯一可靠来源**。

### PKG-22 的执行方式必须改——两版包装不成两份

用户已拍板**不升版本号**：新旧两版的 `package.json` 都是 `1.0.0-test.13`，于是安装包**文件名一模一样**（`AiClient Setup 1.0.0-test.13.exe`）、应用内版本号也一样，**只有 SHA256 不同**。NSIS 见到同版本号会**就地升级**而不是并装，所以检查单原文写的「同机另一目录装上一版」大概率做不到。改成下面两条路之一：

- **路 ① 推荐（不用卸载）**：用**新版 portable**（免安装、跑在独立目录）写出会话文件，再用**旧版 installer 的安装态**打开同一个文件比对。两个运行态互不干扰。
- **路 ②**：先装旧版、验完、**卸载**，再装新版。耗时长且中途出错就得重来。

**现场纪律**：

1. 每次动包之前先 `Get-FileHash -Algorithm SHA256 <exe>`，与上表对上再继续——文件名分不出版本，哈希能；
2. 证据里**记哈希**，写清楚「这一屏是哪个哈希的包开出来的」；
3. 装到明确不同的目录（例如 `C:\AiClient-old-c0ae2a34`），并在截图前确认自己开的是哪个目录下的 exe。

**旧包若连本地留档都丢了**（按优先级）：

1. 现场机器上若还留着 test.11 / test.12 的旧安装目录（P4-6 现场记录提到过 test.9 的安装目录），直接用它，并在证据里写清楚用的是哪一版——PKG-22 验的是「回退窗口成立」，不强求一定是紧邻的上一版。
2. 用 `workflow_dispatch` 对 `c0ae2a34` 重跑一次 Build。**不能用 tag**：仓库里根本没有 `test.13` 这类 tag（`git tag -l` 只有 `v0.2.x` 与 `v0.3.4`），而 `build.yml` 的 `on:` 只有 `push.tags:['v*']` 与 `workflow_dispatch`。
3. 两条都不行就把 PKG-22 记 🚫，并在 roadmap 写明「P6-4 回退窗口仍无现场证据」——不要用「本版打开本版」冒充。

### 2.3 已经不用在上机日做的一项

**WIN-19（打包门禁改 native-only 后的三平台绿灯）本次 Build 已经满足，可以在上机前就标 ✅。**
三份 `worker-smoke-*.json` 已归档在 [evidence/batch-e-build-2026-09-18/](../evidence/batch-e-build-2026-09-18/README.md)：三平台 `ok: true`、`failures: []`、`backend: native`；Windows 的 `carrier` 是 `bundled-node` 且 `node_exec_path` 指向 `resources\node-runtime\node.exe`（Node v24.18.0），Linux / macOS 是 `electron-utility`；每份都有两条权限审计行（`probe_read` / `probe_bash`，`resolution: policy_allow`）。

---

## 3. 上机前自检清单

**在上机的前一天逐项打勾**，缺一项就会在当天卡住一整组。

| # | 机器上要有什么 | 怎么确认 | 缺了会卡住 |
|---|---|---|---|
| P1 | 真实 provider 凭据 + 网关**探活通过** | 起应用前先 `curl` 一发 `POST <baseUrl>/v1/messages`，看到非 503 才算活。整片 503 `No available accounts` 是上游账号池空了，**不要往本地配置上查** | 整个 MODEL 组 |
| P2 | 用哪个 provider 事先定死 | 开发机口径是 `vllmproxy` + `claude-sonnet-5`；**禁用 `cx2` / `maxapi`**（用户私人账户且已无余额，症状是回合跑起来后 `403 Insufficient account balance`）。加密机上若网关可用就用真 provider，不可用才退回 [假网关](../evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs)（手册 §5.3） | MODEL 组会在半路变成「不知道是我方的错还是账号的错」 |
| P3 | **界面语言设为中文** | 设置页确认 | PERM-1 探针（MODEL-29）的触发器选择器写死中文正则；另有 5 项判据本身就是「中文文案」 |
| P4 | Git for Windows 已装，且**知道怎么临时移走它** | `where bash` + 记下安装目录；准备好改名方案（改目录名比改 PATH 可靠） | WIN-16（R0）、WIN-17（R4）、WIN-29（W6）——后两项要的正是「Git 不在」的状态 |
| P5 | Process Monitor（Sysinternals） | 能启动并能按进程名过滤 | ENC-24（数 helper 子进程创建次数）、ENC-15（量 taskkill.exe 创建耗时） |
| P6 | 一台**没有 pwsh 7** 的状态 | `where pwsh`；有的话准备把 `C:\Program Files\PowerShell\7\pwsh.exe` 改名（需要管理员），或换一个没装的账户跑 | WIN-12（默认 shell 与 spawn 回退） |
| P7 | 能临时拦住 `taskkill.exe` | 首选 AppLocker 或 EDR 策略；**装不了就用替代法**：在 worker 的环境里把 `SystemRoot` 指到一个不存在的目录后起会话（检查单 WIN-28 自己给的第二种造法，不需要任何管理工具） | WIN-28（W4） |
| P8 | 随包 Node 路径已知 | `<安装目录>\resources\node-runtime\node.exe`，本次 Build 实测 `v24.18.0` | WIN-2/36、WIN-26、ENC-16、ENC-7 |
| P9 | **`src/runtime` 的依赖已装**（若要跑源码探针） | 在 Windows 上拉到 `13e6cdb7`，进 `src/runtime` 跑 `npm ci`。**它是独立 npm 子包，依赖不随根 pnpm 装**；缺失时报 `Cannot find package 'cordis'` | WIN-26（W1）、WIN-27（W2）、PKG-15（U1）——这三项都要源码 |
| P10 | 受加密策略的目录 + 一个**非白名单进程** | 前者是 ENC 组全部项的场地；后者用来读容器头（期望看到 `%TSD-Header-###%`），PowerShell 原生 `[IO.File]::ReadAllBytes` 即可 | ENC 组全部 |
| P11 | 一份**真实旧格式 Codex rollout** | 见 [field-samples/README.md](../evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md) 第 4 节的查找路径 | MODEL-31（H/21 C5）。找不到就记 ⛔ 并写明找过哪些路径，**不要拿合成样本冒充** |
| P12 | 录屏工具 | 任意；Win+G 也行 | MODEL-41（滚动跟随手感）、MODEL-42（BrowserPreview 整链）、PKG-5（超时时正文是否被顶掉） |
| P13 | 磁盘空间 ≥ 1.5 GB，且**三个 exe 已拷到机器上** | 从开发机 `/home/ai/t033-artifacts/` 整目录拷（含 `SHA256SUMS.txt`）；拷完在 Windows 侧 `Get-FileHash` 对一遍 | 装机本身、PKG-22 |
| P14 | `gh` CLI 已登录且有本仓权限 | `gh auth status` | 只在还要 `windows-unpacked` 时用（2026-09-25 过期）；WIN-19 若要复查也用它 |
| P15 | [样本包](../evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md)已拷到机器上 | 目录整个拷过去，在机器上跑一次 `node make-field-samples.mjs` | ENC-12（编码与二进制）、MODEL-49（自定义策略）、MODEL 组第 2 项（慢启动 MCP） |

---

## 4. 上机前还能在开发机做掉的 13 项

批评者的 34 条必做里有一条是「渲染层词汇表那一组」——**MODEL-11 ～ MODEL-23 这 13 项**。它们被编号在 MODEL 表里，但按团队既有的 CDP 点验配方，**合成 transcript 灌进 store 就能出图**，不需要真实回合、不需要 Windows、不需要加密机。T032 的开发机组 37 项没有覆盖它们（那 37 项是 DEV 表），所以它们**至今仍是未做**。

**建议**：上机日之前另开一次开发机点验把这 13 项做掉，省出上机日约 2 小时。做不掉就留在 [MODEL 分片](t033-field-day/04-model.md)里按原顺序执行。

---

## 5. 执行顺序（检查单 §1 的落地版）

| 阶段 | 内容 | 项数 | 预估 | 分片 |
|---|---|---|---|---|
| 0 | 装机 + 自检 + 基线快照（进程列表、`session-index.json`、受策略目录清单） | — | 0.5 h | 本文 §2 / §3 |
| 1 | **ENC-16 单独先做**（E1 白名单确认） | 1 | 0.3 h | [02-enc](t033-field-day/02-enc.md) |
| 2 | WIN 组 37 项 | 37 | 5 h | [01-win](t033-field-day/01-win.md) |
| 3 | ENC 组 24 项（ENC-16 已做） | 23 | 4 h | [02-enc](t033-field-day/02-enc.md) |
| 4 | PKG 组 23 项 | 23 | 3.5 h | [03-pkg](t033-field-day/03-pkg.md) |
| 5 | MODEL 组 50 项 | 50 | 6 h | [04-model](t033-field-day/04-model.md) |
| 6 | 批次 D4 九项在新包上的复验 | 9 组 | 1.5 h | [05-d4-reverify](t033-field-day/05-d4-reverify.md) |
| 7 | 收尾回填（P5-2 六行、P6-3 第 4/6 条、F3 根因三处、P4-6 四行、P5-4/P5-5 五行） | — | 1 h | [06-closeout](t033-field-day/06-closeout.md) |

合计约 **21.8 小时**，也就是**一天做不完**。这是本执行单最重要的一句话：**必须按第 7 节砍单**。

**为什么 ENC-16 必须第一个做**：随包 `node.exe` 与 Git Bash 是否仍在驱动白名单内，是 ENC 组其余项与 F3 根因判定的**共同前提**。2026-09-09 那份记录换机器即作废。这一项不通过，ENC 组后面的判据全部要重新解释——先做它，才知道后面的数据该怎么读。

---

## 6. 34 条必做的编号映射

草案 §1 的 34 条是「不做就不能签收」的底线。它们分散在四张表里，对应关系如下（同一条必做可能落在多个编号上）。

| 必做 | 原文一句 | 新编号 | 分片 |
|---|---|---|---|
| W-1 | P1-8 六项探针两载体重采 | WIN-26、WIN-27 | 01 |
| W-2 | windows-01 MSYS 盘符绕过 deny（**唯一必须在 Windows 落地的 high**） | MODEL-33 + WIN-37（同一轮） | 04 |
| W-3 | windows-02 与 P1-0/P1-3 命令树清理 | WIN-28、WIN-35、ENC-15 | 01 / 02 |
| W-4 | windows-03 stdio MCP 能不能起来 | WIN-30 | 01 |
| W-5 | 三条字符编码（CRLF edit / OEM 代码页 / 注册表 PATH） | MODEL-34、MODEL-35、WIN-32 | 01 / 04 |
| W-6 | 长路径 / 保留设备名 / 映射盘（纯探索） | WIN-33、MODEL-36、WIN-34 | 01 / 04 |
| W-7 | 随包 Node 缺失时用户看到什么 | WIN-36 + WIN-2（合并做一次）；WIN-3 已退役 | 01 |
| W-8 | Windows 侧终端：pwsh 回退 + PATH/Path 双键 | WIN-12、WIN-13 | 01 |
| W-9 | 强杀与孤儿：worker 残留 / MCP 孙进程 / 索引 rename 占用 | WIN-6、WIN-23、WIN-24、WIN-10 | 01 |
| E-1 | **E1/E5 白名单先确认**（当天第一项） | ENC-16、ENC-20 | 02 |
| E-2 | E2/E3 + R2/R3 合并执行 | ENC-17、ENC-18、ENC-7 | 02 |
| E-3 | 写锁在加密目录下的取 / 读 / 接管 | ENC-14 | 02 |
| E-4 | 导入链在加密机上的闭环 | ENC-4、ENC-3 | 02 |
| E-5 | E4/E6：坏文件打不打垮 grep、TSD 魔数误判 | ENC-19、ENC-21 | 02 |
| E-6 | **F3 根因拍板**（本轮唯一 incomplete 的现场节点） | ENC-8 | 02 |
| E-7 | 加密机上的 TUI-1 闸门与 H/20 一圈 | ENC-5、MODEL-47 | 02 / 04 |
| U-1 | U1 探针走产品路径推导 | PKG-15 | 03 |
| U-2 | U2 + main-host-04 + tsd-03 三家合一（只做一次） | PKG-16、PKG-3 | 03 |
| U-3 | U3/U4 两载体报文形状与退出码语义 | PKG-17、PKG-18 | 03 |
| U-4 | utility 三个功能端到端 + 冷启动耗时 + 超时表现 | PKG-4、PKG-5、PKG-6、ENC-1 | 02 / 03 |
| U-5 | worker stderr 组装 / 50 行上限 / 两路脱敏 | PKG-1、PKG-2、PKG-9 | 03 |
| M-1 | PERM-1 探针复跑（T001 之后） | MODEL-29 | 04 |
| M-2 | 权限卡倒计时走到底 | MODEL-28 | 04 |
| M-3 | 问答卡真机一圈 + 并发问答 | MODEL-27、MODEL-19 | 04 |
| M-4 | smoke 的 `--model` 在线 lane | MODEL-24 | 04 |
| M-5 | 导入续聊 / Codex 旧格式 / 重命名后 pi 侧标题 | MODEL-6、MODEL-31、MODEL-5 | 04 |
| M-6 | ah-lib-01/02 provider 错误正文与裸密钥 | MODEL-9、MODEL-10（同一轮） | 04 |
| M-7 | busy 会话数字 + F4 重试加密机复测 | MODEL-30、ENC-9 | 02 / 04 |
| D-1 | 渲染层词汇表 13 项 | MODEL-11 ～ MODEL-23 | 04（见 §4，**建议上机前做掉**） |
| D-2 | offline smoke / cordis / plugin_graph 补测试 | ✅ T032 已做完 | — |
| D-3 | session-index 五项 + main-host-aux POSIX 半边 | ✅ T032 已做完 | — |
| D-4 | capacity 三项 | ✅ T032 已做完 | — |
| D-5 | baseline-01 CI 不触发测试 | 🚫 已结案（`build.yml` 的 `on:` 只有 tag 与手动） | — |
| D-6 | 三会话并发的进程数与内存（开发机规格不够） | PKG-12 | 03 |

---

## 7. 时间预估与砍单顺序

检查单 §6 给的优先级是：**34 条必做 > 让某个节点能转绿的项 > 纯探索项**。落成可执行的三刀：

**第一刀（保签收）——只做这些，约 9 小时**

- 上面第 6 节表里全部「必做」行对应的编号；
- 加上让节点转绿必须的四项：ENC-8（F3 根因，本轮唯一 incomplete）、WIN-16 + WIN-17（P4-6 的 R0/R4，P4-6 由 incomplete 转签的前提）、PKG-23（P6-3 第 4 条）。

**第二刀（让节点转绿）——再约 6 小时**

- P5-2 六行：MODEL-39 ～ MODEL-43 + PKG-20；
- P5-4/P5-5 五行：MODEL-44 ～ MODEL-46 + PKG-21；
- P6-4 回退窗口：PKG-22；
- 批次 D4 九项复验（分片 05）。

**第三刀（纯探索，时间不够就整组砍）**

- WIN-33（长路径 MAX_PATH）、WIN-34（映射网络盘 / junction）、MODEL-36（保留文件名与尾随点）——检查单 §6 点名的三条纯探索项，全仓零处理零用例，做完至少要能回答「有没有」；
- MODEL-37（压缩摘要体积上限）、MODEL-38（MCP 图片字节假设）；
- MODEL-50（Shell / Custom 三种组合）、DEV-36 的 ② 半句（要先 `pi install` 一个权限扩展）。

**砍单纪律**：砍掉的项在证据 README 里逐条写成一行「🚫 <编号> 当天未做，原因：时间」。不要留空白——空白在下一轮会被读成「做过且通过」。

---

## 8. 远程协作方式

上机当天**另开一个新对话**（本对话的上下文不带过去，执行单本身就是交接物）。分工：

| 角色 | 做什么 |
|---|---|
| 现场（Windows 加密机前的人） | 按编排器给的命令执行，把**原始输出整段贴回**，截图按命名规则存本地 |
| 编排器（开发机侧的对话） | 按分片逐项给命令 → 收现场输出 → 判读 → 写证据文件与 README |

**现场贴回的规矩**：

1. 每次贴回都以编号开头（`WIN-28:` 然后换行贴输出），否则编排器对不上号；
2. **贴原文，不要总结**。「看着是对的」这句话在证据里不成立；
3. 截图先存本地按第 9 节命名，当天结束时整个目录打包回传，不要一张一张传；
4. 出现与判据不符的现象时**当场多问一句**「要不要再抓点什么」，因为机器当天之后就没了。

**新对话的开场白建议**（直接复制）：

> 接手 T033 上机日。执行单在 `docs/plantree/plans/runtime-hardening/topics/t033-field-day-runbook.md`，判据权威是同目录上一层的 `checklist-e.md`。我在 Windows 加密机前，你按执行单分片逐项给命令，我贴回原始输出，你判读并写证据到 `evidence/batch-e-field-<今天日期>/`。现在从 §2 装机开始。

---

## 9. 证据目录与命名

证据目录：`docs/plantree/plans/runtime-hardening/evidence/batch-e-field-<date>/`（`<date>` 用上机当天的日期，例如 `batch-e-field-2026-09-20`）。

```
evidence/batch-e-field-<date>/
├── README.md          # 逐项结论表（编号 / ✅⛔🚫 / 一句现象 / 证据文件名）
├── win/               # win-NN-*.png|txt|json
├── enc/               # enc-NN-*
├── pkg/               # pkg-NN-*
├── model/             # model-NN-*
├── d4/                # d4-T0NN-*
└── closeout/          # 回填出口的前后 diff
```

命名沿用开发机组的 `dev-XX-*` 风格：**`<组>-<两位编号>-<短横线英文 slug>.<扩展名>`**。例：`win-16-bash-image-path.txt`、`enc-07-r2r3-sha256.txt`、`pkg-22-old-pkg-opens-new-session.png`、`model-49-policy-audit-rows.txt`、`d4-T062-model-missing-overlay.png`。

三条既有的取证规矩照旧：

- 探针类产物按 field-05 的命名规则存，**不要覆盖 2026-09-11 那批旧记录**（MODEL-29 复跑前先确认）；
- 设了 `AICLIENT_RUNTIME_TRACE_DIR` 后 trace 目录会短暂出现 `runs.rotate.lock`，按 `runs*` 通配收集证据的脚本**要过滤掉它**；
- 每项都要留可复核的东西：截图、trace 片段、命令输出、或进程列表。

---

## 10. 相关文件

- 判据权威：[checklist-e.md](../checklist-e.md)
- 本次 Build 产物与三份 worker-smoke：[evidence/batch-e-build-2026-09-18/](../evidence/batch-e-build-2026-09-18/README.md)
- 环境手册（假网关、pi CLI、CDP 配方、落盘位置）：[tools/handbook.md](../evidence/batch-e-devbox-2026-09-17/tools/handbook.md)
- 上机日样本与生成脚本：[tools/field-samples/](../evidence/batch-e-devbox-2026-09-17/tools/field-samples/README.md)
- 批次 D4 九项修补：[evidence/batch-d4-fixes-2026-09-17/](../evidence/batch-d4-fixes-2026-09-17/README.md)
- F3 根因 A/B/C 映射：[bash-carrier-decision.md](../../../../plans/2026-09-09-bash-carrier-decision.md)
- P4-6 既有方法与失败教训：[runtime-evolution/evidence/p4-6/](../../runtime-evolution/evidence/p4-6/README.md)
