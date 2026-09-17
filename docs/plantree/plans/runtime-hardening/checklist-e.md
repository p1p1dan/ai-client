# 批次 E 上机检查单（正式）

Role: reference。[T032](roadmap.md) 的产出，取代[批次 D 的草案](evidence/batch-d-audit-2026-09-15/checklist-e.md)（草案作为批次 D 的存证保留原样，不再更新）。建立：2026-09-17。

## 0. 这份清单是怎么来的

四个来源合并去重：

| 来源 | 内容 | 处置 |
|---|---|---|
| 批次 D 补审草案 | 批评者点名的 34 条必做 + 18 区域 150 项 | 整体收录，判据与取证原样搬入（下面第三～四节） |
| 旧树 runtime-evolution 的待现场项 | P5-2 六行、P5-4/P5-5 五行、P6-3 第 4/6 条、H/20 I5、F3 根因、P1-x 与 GUI 各行、现场缺陷表 | 逐条对表：已被草案覆盖的记在第五节，未覆盖的补成新项（第二节） |
| 审计静态推断项 | permissions-19、core-host-05/07、tools-10、cutover-03、P1-8 证据重采、P6-4 旧版产物互读 | 同上 |
| T001 之后的 PERM-1 探针复跑 | `scripts/run-perm1-probe.mjs` | 已在草案 real-model 组第 29 项 |

**编号约定**：`DEV-n` 开发机、`WIN-n` Windows、`ENC-n` 加密盘 / TSD、`PKG-n` 打包态 / utility 载体、`MODEL-n` 真实模型回合。草案里的原编号在每项的「来源」列保留，可回溯。

**状态记号**：⬜ 未做 · ✅ 已完成（挂证据）· 🚫 已裁决不做（写明理由）。

## 1. 执行顺序

1. **上机前在开发机做完 DEV 组**（35 项）。批评者的原话是：标 dev-box 的项拖到上机日纯属浪费当天的时间窗。其中 5 项已于 2026-09-17 完成。
2. **上机当天，第一件事做 ENC-16（E1 白名单确认）**。随包 node.exe 与 Git Bash 是否仍在驱动白名单内，是 ENC 组其余项与 F3 根因判定的共同前提——2026-09-09 那份记录换机器即作废。这一项不通过，ENC 组后面的判据全部要重新解释。
3. 然后按 WIN → ENC → PKG → MODEL 的顺序做。WIN 与 ENC 同机，PKG 需要打包产物，MODEL 需要真实凭据与网关。
4. **收尾**：把 P5-2 的 signoff 六行、P6-3 第 4/6 条、F3 根因三处回填，它们是本轮现场的签收出口。

## 2. 从旧树与审计并入的新项（草案未覆盖）

这些项在批次 D 的 150 项里没有对应条目，是这次合并新补的。

### 2.1 子代理真机与打包矩阵（旧树 P5-2 的六行待现场）

来源：[P5-2-7 逐项签收](../runtime-evolution/evidence/p5-2/signoff.md)。六行共用同一前提——一次真机会话 + 两种载体的打包产物。

| # | 项 | 判据 | 取证方式 | 来源 |
|---|---|---|---|---|
| MODEL-39 | SA16 保存 / 恢复 / 切分支的真机对比 | 关掉应用再打开同一会话，委派面板按记录重建，未结算的显示为已取消（不是消失、也不是重新跑）；正常关闭与硬退出（强杀）两种收尾各跑一次，结果一致 | 真实回合派一个子代理，一次正常退出、一次强杀，各重开一次会话截图，并读会话 JSONL 里 Task 条目的终态 | SA16 |
| MODEL-40 | SA17 管理页全链路与重启保留 | 增删改、改名、启停、模型 / 轮次清空、搜索、定位文件、逐行 busy、失败整份回滚、刷新不闪空、permission 未编辑不丢——逐项点一遍；重启应用后开关与改动仍在 | 设置页逐项操作截图，重启后再截一次；同时比对 `<agentDir>/agents` 下的文件 | SA17 |
| MODEL-41 | SA18 运行面板的滚动与跟随手感 | 子代理活动增多时局部滚动跟随正常、不抢主时间线的滚动位置（自动化只到接线级，happy-dom 无布局判定不了） | 真实回合派 2～3 个子代理，录屏 | SA18 |
| MODEL-42 | SA20 BrowserPreview 整链 | 自定义一个带 `BrowserPreview` 的子代理，让它生成并预览工作区 HTML；编辑该文件后预览自动刷新；预览窗 `showInactive` 不抢前台 | 真实回合走完整链，录屏 + 截图 | SA20 |
| PKG-20 | SA21 两载体打包后的子任务矩阵 | electron-utility 与 Windows bundled-node 两种载体各跑一遍「后台委派 + 审批 + 写入 + 取消」，结束后无残留子进程 | 两种打包产物各跑一轮，跑完用 ps / tasklist 查残留 | SA21 |
| MODEL-43 | SA22 完整功能基线验收 | 固定输入 + 固定定义 + 模型替身下，成功 / 失败 / 取消三种收尾各留一份 trace 与截图，性能数据（ack 延迟、fan-out 并行度）记录在案 | 依赖 MODEL-39～42 与 PKG-20 先落；按[基线](../runtime-evolution/topics/p5-2-0-baseline.md)的固定输入跑 | SA22 |

### 2.2 模型目录与导入（旧树 P5-4 / P5-5 的五行待现场）

来源：[P5-4/P5-5 记录](../runtime-evolution/evidence/p5-4-p5-5/README.md)「待现场」。IM-a 已被 MODEL 组第 6 项与 ENC 组第 4 项覆盖，不重复列。

| # | 项 | 判据 | 取证方式 | 来源 |
|---|---|---|---|---|
| MODEL-44 | MC-a 非四种风格的服务真的可用 | 加一个 Mistral 或 Azure 风格的服务后，native 后端的模型选择器里真的出现它的模型，并能出一次话（改前这六种风格被静默丢弃） | 设置页加服务 → 选模型 → 发一条消息，截图 + 抓 `dropped` 字段 | MC-a |
| MODEL-45 | MC-b 托管模式下两系模型各出一次话 | Anthropic 系与 OpenAI 系模型在同一网关上各成功出话一次（D15 的推导规则在真机上的确认） | 托管模式切换两个模型各发一条消息 | MC-b |
| PKG-21 | MC-c 打包版 native 不再读 `models.json` | 把派生的 `models.json` 改名后，native 会话仍可用；legacy / TUI 侧报错（证明这文件只剩 CLI 在读） | 打包产物上改名该文件，native 发一条消息、TUI 起一次，各截一次 | MC-c |
| MODEL-46 | IM-b 中断导入后的 reconcile | 导入进行中强杀进程，重启后重试同一条：`reconcile` 真的清干净，暂存目录无残留、manifest 无 `cleanupPending` 悬挂 | 导入中途强杀 → 重开 → 重试 → 查 `sessions/.aiclient-import-staging/` 与 manifest | IM-b |

### 2.3 会话互通与回退窗口

| # | 项 | 判据 | 取证方式 | 来源 |
|---|---|---|---|---|
| MODEL-47 | H/20 I5：在 TUI 里续聊再回 GUI 的完整一圈 | GUI 跑一回合 → 内嵌 TUI 里继续聊一轮 → 回 GUI，两轮都在时间线上、顺序正确、无重复条目；会话文件头一行仍同时满足 v4 与 v3 | 内嵌终端真开，前后各读一次会话 JSONL 比对条目链，GUI 侧截图 | 旧树 H/20「仍未验」 |
| MODEL-48 | 右上角 GUI / TUI 开关那一下 | 开关切换后，会话所有权正确移交、回来后 GUI 接得上（2026-09-17：CDP 真鼠标序列已能驱动该开关，DEV-30 已用它点过一圈；上机日仍手点一次即可） | 手工点按，前后各查一次 `writer.lock` 与 spawn 窗口内的 pi argv（`ps` 过滤 `--session` 抓不到，pi 会改写进程标题） | 旧树 H/20「探针驱动不了那个控件」（已被 2026-09-17 实测推翻） |
| PKG-22 | P6-4 回退窗口：旧版产物互读 | 用上一个安装包打开本版写出的会话文件：要么正常打开，要么给出可读的说明；不得静默丢条目或写坏文件（回退方案是「装回上一个安装包」，这条是它成立的前提） | 留一份上一版安装包，装在同机另一目录，打开本版的会话文件并截图；之后再用本版打开同一文件确认未被写坏 | 审计 P6-4 |
| PKG-23 | P6-3 第 4 条：打包产物的 GUI 无回归 | 打包态起应用 → 一整回合（含工具、审批、压缩）→ 权限卡与时间线正常 → 侧栏「能力」面板与插件设置页文案正确 | 打包产物上走一遍，截图归档到 P6-3 第 4 条 | 旧树 P6-3 第 4 条 + cutover-03 |

### 2.4 审计静态推断项的现场确认

| # | 项 | 判据 | 取证方式 | 来源 |
|---|---|---|---|---|
| WIN-37 | permissions-19：Windows 分隔符下的权限判定 | 同一条规则在 `\`、`/`、MSYS `/c/` 三种拼法下判定一致（T001 已修静态面，Linux 载体结构上发现不了这条） | 与 MODEL 组第 33 项（W3）同一轮做：三种拼法各跑一次，比对 trace 的权限审计行 | permissions-19 |
| ENC-23 | core-host-05：TSD helper 的 stderr 噪声不再挤掉输出预算 | 一个 configured Node 会往 stderr 打噪声的场景下，受策略文件仍被判为可读、返回明文，不出现 `io_tsd_unreadable`（T013 `19f9e888` 已给 stderr 独立 4 KiB 预算） | 加密机上读一个大受策略文件，抓 trace 的 exec 事件看 stderr 字节数与结果 | core-host-05 |
| ENC-24 | tools-10：加密路径下大文件读的进程数与耗时 | 读一个 ≥ 2 MiB 的受策略文件，helper 子进程创建次数应是个位数、总耗时接近线性（改前是 32 KiB 固定分块导致 O(n²) 重读与上百次子进程） | 加密机上用 Process Monitor 数 helper 进程创建次数，同时记 trace 的 latency | tools-10 |
| DEV-36 | cutover-03：native 下「能力」面板与插件页文案（判据 2026-09-17 拆成两行，见 5.1） | 侧栏「能力」面板列出 native runtime 自己的 MCP / 技能 / 子代理（「未报告」与「报零」两态可区分）；插件设置页权限归属文案：① 无条件显示「本应用的每个对话，都由它自带的权限系统审批工具调用」；② 装了 pi 权限扩展时另显示「你自己安装的 pi 权限系统只对内嵌终端生效」 | 起 Electron 截两处图（T026 `2cfed556` 已改实现，这里验的是用户看到的样子）；②要先 `pi install` 一个权限扩展再看，开发机 2026-09-17 未装、只验到 ① | cutover-03 |

### 2.5 旧树里未被覆盖的其余现场项

| # | 项 | 判据 | 取证方式 | 来源 |
|---|---|---|---|---|
| MODEL-49 | P1-5 真实自定义策略与复杂 shell | 用户自写的策略文件、含管道 / 重定向 / here-string 的复杂命令、以及策略热重载三种组合下，判定与档位表一致 | 准备一份自定义策略，跑三类命令各一次，抓权限审计行 | 旧树 P1-5 |
| MODEL-50 | GUI A/2 完整 Shell / Custom 组合 | 终端设置里默认 shell、自定义 shell 路径、自定义参数三种组合逐项可用（核心现场只验过一条） | 逐格切换并开一次终端，截图 | 旧树 GUI A/2 |
| DEV-37 | GUI A/7 多样路径下的文件点击与编辑器 | 含空格、中文、超长、软链四类路径的文件点击后编辑器正确打开并定位 | 造四类路径各一个文件，逐个点击截图 | 旧树 GUI A/7「多样路径 2c 缺样本」 |

## 3. 上机前在开发机做完（DEV 组）

### 3.1 已完成（2026-09-17）

证据：[batch-e-devbox-2026-09-17](evidence/batch-e-devbox-2026-09-17/README.md)。

| # | 项 | 结果 |
|---|---|---|
| DEV-19 | offline smoke lane | ✅ 退出码 0、六项断言全 pass、`config_version=runtime_p6_hardening_v1`、`backend=native`；report.json 与 runs.jsonl 已归档 |
| DEV-20 | 同时存档 `report.outcomes` 与 runs.jsonl | ✅ 已按 `--json` 存逐条断言 |
| DEV-21 | `plugin_graph_incomplete` 失败路径补测试 | ✅ 新增 `pluginGraphIncomplete.test.ts` 1 条，反向验证 1 组判红后复原 |
| DEV-22 | cordis 语义探针复跑 | ✅ 三条语义与 P0 结论一致；**草案判据有误已改写**（见第五节）；cordis 仍是 `4.0.0-rc.9`，本次属基线复采而非升级后复验 |
| DEV-35 | 多进程并发轮转同一 runs.jsonl | 🚫 不需人工执行：已由 `trace.test.ts:350` 两进程真实竞速用例覆盖（T045 落），本轮实跑 15/15 绿 |
| —— | baseline-01 CI 不触发测试 | 🚫 已结案：`build.yml` 的 `on:` 只有 `push.tags:['v*']` 与 `workflow_dispatch`，另两个 workflow 是 claude / code-review，都不是测试作业。剩下的是「要不要加」的决策，归 T054 |

### 3.2 待做

草案 dev-box 表里除上述之外的项全部保留，判据与取证见第四节的 DEV 组表格。按是否需要起 Electron 分两批：

- **不需要 Electron**：DEV-23（CI 实际推送验证，可与上面的静态结论互证）、DEV-33 的「runtime 包内构造用例」半边、DEV-35（已裁决）
- **需要起 Electron**：其余全部（session-index 五项、main-host-aux 的 POSIX 半边、capacity 两项、field-nodes 六项、h-nodes 两项、import-upstream 四项、terminal-tui 三项、agent-host-lib 一项、chat-event-vocab 一项）。开发机 2 核 / 3.3 GB，起 Electron 时不要同时跑全量测试。
- **本次新增**：DEV-36（能力面板与插件页文案）、DEV-37（多样路径文件点击）

## 4. 各环境分组（判据与取证）

以下四张表逐字来自[批次 D 草案](evidence/batch-d-audit-2026-09-15/checklist-e.md)第二节，未作改写（个别条目的修正单列在第五节）。新并入的项见第二节，不重复列。

### Windows 加密机（上机日）（36 项 + 新增 WIN-37，见第二节）

| # | 项 | 判据 | 取证方式 | 来源区域 |
|---|---|---|---|---|
| 1 | 归档一个正在跑回合的临时对话 | 目录删除发生在 worker 退出之后；无残留目录，main.log 里没有 `[scratch] failed to remove` | 起应用、发一条长回合消息、回合中点归档；随后看 main.log 与临时根下是否有残留目录 | `main-host-aux` |
| 2 | 随包 Node 运行时缺失时的用户可见文案 | 横幅显示 `Pi Node runtime is missing: <路径>`，且不出现任何提及 AICLIENT_NODE24_PATH 的指引 | 打包后把 resources/node-runtime/node.exe 改名，起应用发一条消息，截图横幅 | `main-host-aux` |
| 3 | AICLIENT_NODE24_PATH 是否仍被宣传但无效 | 设置该环境变量后启动，worker 用的仍是随包 / Electron 的 node | 打包态启动前设该变量，查看 worker 进程的可执行路径 | `main-host-aux` |
| 4 | 手工删除临时工作区后的自愈（保存位置带尾部分隔符） | 目录被就地重建且带 .git；不出现 workspace_missing 卡片 | 设置里把保存位置写成带尾部分隔符的形式 → 建临时工作区 → 手工删目录 → 重开对话 | `main-host-aux` |
| 5 | 关机时导入槽拆除失败是否吞掉整池拆除与兜底强杀 | 退出后没有残留的 worker 进程，且 scratch 临时目录被清空；日志里能看到每个会话槽各有一次 dispose | 起两个会话 worker + 一次大体量旧会话导入，在导入写盘中途退出应用；退出后用 ps / tasklist 查 worker 进程，检查 scratch 目录 | `main-host` |
| 6 | 打包 Windows 上 node.exe worker 的孤儿风险 | 应用进程退出后 tasklist 里没有以 resources\node-runtime\node.exe 启动的残留进程（包括强杀路径被跳过的情形） | 打包 Windows 机，正常退出与「导入槽拆除失败」两种退出各跑一次，退出后 tasklist /FI "IMAGENAME eq node.exe" | `main-host` |
| 7 | Windows 打包态走的是 node.exe 分支 | app.isPackaged && win32 时 utility worker 由 node-runtime/node.exe 起，而不是 utilityProcess | 观察进程名并与 PiWorkerProcess.ts:79-92 的分支日志对照 | `utility-chain` |
| 8 | 托管模式 + 钥匙串锁定下的三个功能 | resolveNativeModelCatalog() 返回 undefined → worker 回落读 agent 目录 → 功能仍可用，或给出可理解的错误 | 锁定钥匙串后点三个按钮，记录错误码、utility.start 载荷里是否带 modelCatalog、worker 是否读到了 auth.json | `utility-chain` |
| 9 | 断电 / 强杀后的索引完整性 | session-index.json 是否出现零长度或半截内容 | 在一轮对话结束（会触发 flush）的瞬间强杀进程，重复若干次后检查文件 | `session-index` |
| 10 | Windows 上索引写入的占用失败 | rename 是否出现 EPERM / EBUSY，以及失败后归档 / 重命名的界面表现与重启后的状态 | Windows 打包版上开启实时防护，连续归档 / 重命名若干会话并观察错误与重启后的状态 | `session-index` |
| 11 | Windows 下的导入路径拼接与盘符还原 | CLAUDE_CONFIG_DIR / CODEX_HOME 取 Windows 路径时扫描与落盘均正常；decodeProjectDirNameFallback（ClaudeSessionScanner.ts:258-262）在真实项目目录名上给出正确的盘符路径 | 在 Windows 上打开导入面板，核对项目路径显示与导入产物路径 | `import-upstream` |
| 12 | Windows 默认 shell 与 spawn 回退 | 无 PowerShell 7 的机器上内嵌终端能正常打开；自定义 shell 路径失效时给出可读错误而非原生 spawn 报错 | 不装 pwsh，分别用默认设置与失效的自定义路径开终端截图 | `terminal-tui` |
| 13 | Windows 上的 TUI 启动计划 | pi 能起来，PATH 含 node-runtime 目录，Path/PATH 双键不造成取值异常 | 打包版 Windows 上开 TUI，在 pi 里执行 node -v 与 echo %PATH% | `terminal-tui` |
| 14 | Windows 路径脱敏规则对真实 stderr 行生效 | 真实 Windows 上 worker stderr 里出现的 C:\Users\<含空格用户名>\… 在 Context 面板显示为 ~\…；WSL / UNC 两族同理 | Windows 上故意制造一条含用户目录的 stderr（例如指向不存在的随包 node 路径），看 Context 面板的 Host stderr 分组 | `agent-host-lib` |
| 15 | Windows 上的 shell 工具名 | Windows 下工具行仍是 bash（不是 powershell），动词表命中「已运行」 | Windows 机跑一次命令回合，截时间线 | `chat-tool-vocab` |
| 16 | R0 bash 进程映像取证 | 拿到 Windows 映像绝对路径与父进程链，而不是 shell 自报的 MSYS 路径（test.12 只拿到后者） | Get-Process bash \| Select Path 加父进程查询，与 src/runtime/host/shell.ts 的候选顺序逐条对照 | `field-nodes` |
| 17 | R4 有效的无 Bash 探针 | worker 的 shell resolver 真正落到 shell_unconfigured，且应用不崩不挂 | 覆写 resolveWorkerShell 会查的全部候选路径后调 bash 工具；现场记录必须写明覆盖了哪几个候选（test.12 那次因未覆盖默认安装目录而无效） | `field-nodes` |
| 18 | GUI F/15 的 F2-a/c 新包复验 | 临时根改设置后两处解析一致；用户目录缺失时给 workspace_missing 而非裸 ENOENT | 在新包上按现场清单复验 | `field-nodes` |
| 19 | 打包门禁改 native-only 后的三平台绿灯 | 三平台 Verify packaged Pi worker 步骤成功，stamp.backend=native、carrier=bundled-node、权限审计行存在 | 推一次构建并收三份 worker-smoke-*.json（现有 test.13 绿灯停在 c0ae2a34，距 HEAD 144 个提交，门禁已被 T009/T028 改过两次） | `field-nodes` |
| 20 | F6 右侧审阅栏打包后回归 | 安装包里右侧审阅栏能记录 Edit/Write 修改，上限行为与本地一致 | 新包上开一个会改文件的会话并对照本地结果 | `field-nodes` |
| 21 | H/17 本地模式 AI 服务在打包产物里可用 | 添加自定义服务后模型选择器能拉到模型列表并可对话；safeStorage 不可用时界面如实显示未加密 | 打包应用 + CDP/手工点验 | `h-nodes` |
| 22 | H/19 插件安装在打包产物里的路径解析正确 | currentPiCliLayout() 在打包布局下解析出的 pi 可执行文件路径存在且可跑；安装/卸载后 settings.json 与 node_modules 增减正确 | 打包应用真实调用 pi install/remove/list | `h-nodes` |
| 23 | worker 被强杀后 MCP 子进程是否残留 | 杀掉 worker 进程后，它拉起的 MCP 服务器进程是否在 10 秒内消失 | 配一个真实 stdio MCP 服务器，开会话待其就绪，记下子进程 pid，然后 taskkill /PID <worker> /F（Windows）或 kill -9（Linux），10 秒后查 pid | `concurrency` |
| 24 | Windows 上 node 运行器孙进程的回收 | node.exe（exec 运行器）与它下面的 MCP 进程是否都消失 | 同上场景，用 wmic process where ParentProcessId=<worker> 逐层看进程树 | `concurrency` |
| 25 | 会话被强杀后 pid 复用的实际形态 | 强杀应用后留下的锁，重启应用能否打开该会话 | 现场机器上强制结束应用进程，记下锁里的 pid，等待或制造 pid 回绕后重开该会话 | `concurrency` |
| 26 | W1 P1-8 六项探针在当前 HEAD 上重采（bundled-node 载体） | passed 为 true 且 assertions 六项全 true；stamp.config_version 为 runtime_p6_hardening_v1（旧证据是 runtime_p3_complete_v1，据此确认是新采） | Windows 上拉到当前 HEAD，src/runtime 跑 npm ci，按 test12-reverify.md:541 的原命令用安装目录随包 node.exe 执行 src/runtime/smoke/p1-bundled-node.ts，保存完整 JSON | `windows-static` |
| 27 | W2 P1-8 六项探针重采（electron-utility 载体） | 同 W1，且 stamp.carrier 为 electron-utility | 按 test12-reverify.md:562 的 electron-carrier.cjs 原命令重跑，保存 stdout 与 stderr | `windows-static` |
| 28 | W4 windows-02：taskkill 缺失或变慢时 bash 是否仍能成功回报 | 一条 echo hello 必须返回 hello 且退出码 0，不得出现 exec_cleanup_failed | 两种造法任选：用 AppLocker 或 EDR 策略临时拦 taskkill.exe；或在 worker 环境里把 SystemRoot 指到不存在的目录后起会话。跑一条 bash，抓 trace 里的 tool_execution 事件与错误码 | `windows-static` |
| 29 | W6 windows-04：无 Git for Windows 时的表现（旧树 R4，一直未执行） | 期望 bash 工具不出现在工具列表里，且应用给出一条可操作的中文提示。当前实现预期会失败，记录实际文案原文 | 临时把 Git 安装目录改名，或在一台没装 Git 的 Windows 上装包；起会话让模型执行一条命令，截图并抓 trace | `windows-static` |
| 30 | W7 windows-03：stdio MCP 在 Windows 上能否起来 | 把 command 配成 npx、args 配成 -y 加一个官方 server 包名，期望服务器连上且工具出现在列表里 | 写进 MCP 配置起会话，看 mcp_status 与侧栏徽标与 worker stderr 日志；再用绝对 npx.cmd 路径试一次，记录两次的错误原文 | `windows-static` |
| 31 | W9 windows-06：写锁在 PID 复用下的表现 | 伪造一份 writer.lock，pid 填一个当前存活的无关进程、host 填本机名，打开该会话：期望能打开或至少给用户接管出口；报 session_locked 即复现 | 在会话目录里造 sidecar（先备份），点开会话截图；测完删除 sidecar | `windows-static` |
| 32 | W10 windows-07：注册表 PATH 解码 | 在用户级 PATH 里加一个带中文的目录，起应用后在内嵌终端里打印 PATH，该条目必须与注册表原文逐字节一致 | 改用户环境变量、重启应用、终端打印 PATH，与 reg query 的原文对比截图 | `windows-static` |
| 33 | W12 长路径（MAX_PATH）边界 | 工作区里造一条总长超过 300 字符的路径并放一个 ts 文件，跑 glob 与 read 该文件，期望都成功 | 用 PowerShell 逐级 New-Item 造深目录，然后跑模型回合或探针 | `windows-static` |
| 34 | W14 映射网络盘或 junction 工作区的 glob 与 grep | 在 subst 出来的虚拟盘或映射网络盘上开工作区，glob 必须返回非空 | 用 subst 把工作区映射成一个新盘符，用新盘符打开工作区跑一次 glob，比对原路径下的结果数 | `windows-static` |
| 35 | W15 命令树清理（旧树 P1-0 与 P1-3 仍待现场） | 正常退出、超时、取消、父命令先退出四种形态下，taskkill 之后无残留进程 | 每种形态跑一条命令，之后用 Get-Process 比对基线快照；同时看 trace 的 termination 字段 | `windows-static` |
| 36 | W16 随包 node.exe 缺失时的用户可见文案 | 期望出现一条可操作的中文提示；当前预期只有 Pi Node runtime is missing 加路径 | 打包态把 resources 下 node-runtime 里的 node.exe 改名，起应用发一条消息，截图横幅（与 main-host-aux 区域的同名检查项合并执行，不要跑两遍） | `windows-static` |

### 加密文件系统 / TSD（上机日，与 Windows 同机）（22 项 + 新增 ENC-23/24，见第二节）

| # | 项 | 判据 | 取证方式 | 来源区域 |
|---|---|---|---|---|
| 1 | utility 冷启动耗时 | 从 utility.start 发出到收到 ack 的耗时；判 10 秒预算是否足够（连续三次冷启动的最大值 < 10s 才算通过） | 在 PiUtilityService.ts:192 前后打时间戳日志（或用 --remote-debugging-port 在 Main 日志里读），点一次「生成提交信息」，记录三次冷启动耗时 | `utility-chain` |
| 2 | 加密机上 userData 的位置 | session-index.json 是否落在受策略目录内；是否受 TSD 读写约束 | 加密机上打印 app.getPath('userData') 并对该路径做一次普通读写 | `session-index` |
| 3 | Codex 源在加密机上是否受 TSD 策略覆盖（CodexSessionScanner 没有 TSD 分支） | ~/.codex/sessions/**/*.jsonl 的首部是否带 TSD 头；若带，导入面板里 Codex 项目应为空或全部会话被跳过 | 在加密机上对任一 rollout 跑 isFileTsdEncrypted（用现成工具函数写一个只读小脚本），再打开导入面板看 Codex 项目是否为空 | `import-upstream` |
| 4 | Claude 导入在加密机上的完整闭环 | 一条真实 ~/.claude 会话能被列出、能导入、导入后能打开并续聊 | 走 GUI 完整导入一条，记录 sessions/ 下产物路径与会话索引行 | `import-upstream` |
| 5 | 加密机上的 TUI-1 闸门 | 旧 v4 会话在加密机上点 TUI：是被我们的提示拦住，还是直接进终端撞 CLI 原文报错 | 造一个 v4 非 interop 头的会话文件放进受保护目录，点 TUI 截图 | `terminal-tui` |
| 6 | 加密机上会话文件中段坏行自愈（T034）后树与历史是否一致 | 中段坏行被跳过并原子重写后，会话树节点数 = 文件里存活条目数，历史时间线不缺条目，session.status 带 recovery rider | 加密机上对一个真实会话文件中段插一行坏 JSON，重开会话并对比树节点与文件行数 | `agent-host-lib` |
| 7 | R2/R3 用真实加密容器重跑（GUI bash 工具 → 随包 node 读同一受策略文件；随包 node 改名副本再读一次） | 样本先被非白名单进程读出 %TSD-Header-###% 头并存证；两次读取的明文/密文两态可区分，据此唯一映射到「按进程名/路径」或「按签名/目录」或「按父进程」 | 在受策略目录准备样本，先用非白名单进程读出容器头留档，再走 GUI bash 工具的真实链路，两次结果连同 SHA256 一并记录 | `field-nodes` |
| 8 | F3 根因拍板 | 由 R0/R2/R3 的结果唯一映射到 A（维持现状）/ B（随包 node 包一层）/ C（走 Git Bash）之一 | 结果回填 docs/plans/2026-09-09-bash-carrier-decision.md 第 6 节表并写结论，同步改写 README 的 F3 行与 P4-6 表第 136 行 | `field-nodes` |
| 9 | F4 重试在加密机复测 | 503×2 后成功、持续 503 四次尝试共 43 秒耗尽、429 听 Retry-After、退避中取消立即结束 | 复跑 scripts/run-f4-retry-probe.mjs（需 Node 24），trace 的 provider_retry 与假网关实到请求数两侧都看 | `field-nodes` |
| 10 | GUI A/4 加密机回归 | 临时目录复用/创建/绑定三条路在受策略目录下与开发机结果一致 | 按 F2-b 的三时点法在加密目录重跑 | `field-nodes` |
| 11 | 加密域 GUI 读 / Edit 后一致性 | 受策略目录里 Read 得明文、Edit/Write 后 GUI·TUI·外部编辑器三者内容一致 | 在加密域目录做一次完整读写，三处各读一次 | `field-nodes` |
| 12 | 特定编码与真实二进制样本（P4-6 表第 137 行的精确缺口） | GBK/UTF-16/带 BOM 各一份、真实二进制一份，Main diff 与编码判定逐样本记通过或失败 | 准备四份样本后逐个在 Git 面板与编辑器打开 | `field-nodes` |
| 13 | H/17 + H/19 打包与加密机联合回归 | 本地模式首次进入、加服务、统一目录迁移、插件安装卸载，全链路在加密文件系统与 Windows 上各跑一遍 | 现场实测（并入最后一次上机） | `h-nodes` |
| 14 | 加密目录下写锁的取 / 读 / 接管是否可用，代价多少 | .writer.lock 在盘上是不是 TSD 容器；正常打开会话的耗时；人为留一把 pid 不存在的陈旧锁后接管是否在 60 秒 bootstrap 预算内完成 | 在受策略目录下开一个会话，读锁文件前 16 字节看是否为 %TSD-Header-###%；再手写一把陈旧锁，重开会话并计时 | `concurrency` |
| 15 | W5 windows-02：正常路径下每条 bash 的 taskkill 耗时 | 从 runner 发出 IPC exit 到 runPipe resolve 的间隔持续超过 1000 毫秒，即说明 2000 毫秒预算不安全 | 加密机上连跑 20 条短命令，从 trace 时间戳取 tool_execution_start 到 tool_execution_end 的差值分布；同时用 Process Monitor 看 taskkill.exe 的创建耗时 | `windows-static` |
| 16 | E1 随包 node.exe 仍在驱动白名单内 | 安装版 GUI 里 read 一个受策略文件返回明文；不出现 io_tsd_unavailable | 读工具输出截图 + 同一次 run 的 runs.jsonl 版本戳（应为 carrier=bundled-node、tsd_read_fallback=disabled、node_exec_path=…\node-runtime\node.exe） | `tsd-utility` |
| 17 | E2 Write→Read 明文往返（p1-0 契约 §3「写后密文风险」点名由 P1-8/P4-6 验证；与 encryption-special.md 的未决项合并执行） | write 写出的文件在盘上是密文容器（非白名单进程看到 %TSD-Header-###% 与容器大小），而 GUI read 读回原文 | 在加密域目录用工具写 tracked.txt，再用 PowerShell 原生 [IO.File] 读头 16 字节，再用 GUI 读回 | `tsd-utility` |
| 18 | E3 edit 的读-改-写不破坏加密 | 对受策略文件 edit 一次后，文件仍是密文容器，GUI 再读内容正确，非白名单进程仍看到密文 | 同 E2 的取头方式，edit 前后各取一次 | `tsd-utility` |
| 19 | E4 单个读不了的文件不打垮 grep（tsd-02 的现场判据） | 工作区里存在当前进程读不了的受策略文件时，grep 仍返回其余命中并报出 skipped 条数 | 构造一个驱动拒绝的文件（或 icacls 去掉读权限），跑一次 grep，保存工具输出 | `tsd-utility` |
| 20 | E5 bash 叶子进程读到的是明文还是密文（D11 未决项 F3；复核 2026-09-09「Git Bash 在白名单内」在当前机器/驱动版本是否仍成立） | bash 执行 type/cat 受策略文件的输出与 GUI read 一致 | 同一文件两条路径各取一次输出并 diff | `tsd-utility` |
| 21 | E6 TSD 魔数误判的现场形态（tsd-07） | 手写一个以 %TSD-Header-###% 开头的明文 txt，read 它 | 期望当前报 io_tsd_unavailable；记录原始文案，作为 FIX 后的对照 | `tsd-utility` |
| 22 | E7 仅当 tsd-01 按「接通回落」修法推进时才需要跑：helper 端到端 | 一次 read 起两个进程（exec-runner + helper）、30 秒内返回明文；连续分页读的进程数与耗时记录在案 | 临时构建打开 configured-node，用 Process Monitor 记进程创建次数与耗时 | `tsd-utility` |

### Electron utility 载体（打包态，上机日）（19 项 + 新增 PKG-20～23，见第二节）

| # | 项 | 判据 | 取证方式 | 来源区域 |
|---|---|---|---|---|
| 1 | worker stderr 落进 main.log 的内容是否脱敏 | 日志中不出现 sk- 开头的 key、`Bearer <token>`、`*_API_KEY=<值>` 原文 | 用会在 stderr 打印环境的假 provider 触发 worker 启动失败，检查 main.log 的崩溃回放段 | `main-host-aux` |
| 2 | Electron utility 载体下的 stderr 组装 | 多块、跨块、CRLF 的 stderr 在 main.log 里是完整整行而非半行交织 | 让 worker 分块打印一段长 stderr，检查日志行形态 | `main-host-aux` |
| 3 | utilityProcess 载体的 stdout 背压：用真实 Electron utility worker，让一个插件或 MCP 包装脚本在一次回合内往 stdout 写 ≥ 1 MiB | worker 在写入期间与之后仍能正常应答 worker.tree / worker.history（不超时），且 Main 进程 RSS 不随写入量线性增长；若任一条不成立即证实 main-host-04 | 起打包或 dev 的 Electron，在 worker 入口临时注入一个定时 process.stdout.write 的插件；用 CDP 或 app.getAppMetrics 采 Main 的 RSS，同时用一条只读 RPC 做存活探针 | `main-host` |
| 4 | utility 在 Electron utility 载体上的端到端 | 三个功能在打包态各跑一次成功回合；worker 进程在结算后确实退出（无残留） | 任务管理器 / ps 观察 `AiClient Pi Worker N` 的生灭；同时记录 utility.terminal 的 state 与 model | `utility-chain` |
| 5 | 超时的用户可见表现（utility-06 的现场判据） | 10 分钟评审超时后：面板是否还显示已生成正文、复制按钮是否仍可用、能否重试、worker 是否残留 | 把评审超时临时调小（或对一个超大 diff 跑满），录屏 + 进程观察 | `utility-chain` |
| 6 | 并发点击与容量上限 | 评审 + 提交信息占满 capacity=2 后，第三个功能给出的提示文案是否为界面语言且可操作 | 依次触发三个功能，截图提示文案 | `utility-chain` |
| 7 | 导入产物路径与 pi CLI 互通（import-up-10） | <agentDir>/sessions/<id>.jsonl 能被 pi --session 打开，并出现在 TUI 的会话列表里 | 起 Electron 导一条，再用随包 CLI 打开同一文件 | `import-upstream` |
| 8 | utility 载体下的重读 | worker.reload 在 Electron utility 载体上同样在 BOOTSTRAP_REQUEST_TIMEOUT_MS 内完成（带 MCP 时） | TUI 交接后观察 reload 耗时与是否超时退槽 | `terminal-tui` |
| 9 | utility 载体下 session.stderr 的转发与 50 行上限 | 一轮内超过 50 行 stderr 时面板末尾出现「…more stderr this turn is in the worker log only (forwarding capped at 50 lines)」，且前 50 行均已脱敏 | 以 Electron utility 载体起 worker，让子进程刷 60 行 stderr（含一条带假密钥的行） | `agent-host-lib` |
| 10 | Electron utility 载体的现行探针 | carrier=electron-utility 且 node_source 由产品路径推导（不是 explicit），六项工具断言全通过 | 沿用 src/runtime/smoke/p1-utility-worker.ts，host 配置改走产品路径推导，结果与 HEAD 版本戳绑定 | `field-nodes` |
| 11 | P5-2-0 探针跨平台 | subagentHostProbe.test.ts 10 条在 Windows 与 Electron utility 载体上同样全绿 | 随批次 E 常规测试套件跑一次，无需专门驱动 | `h-nodes` |
| 12 | 三个会话并发时的真实进程数与内存 | 进程数 = 3 个 worker + 每会话 MCP 数；常驻内存是否仍在机器可承受范围 | 起 Electron 开三个会话各跑一轮，ps -o pid,rss,comm --ppid / 任务管理器截图 | `concurrency` |
| 13 | 现场取证时 runs.jsonl 的代号完整性 | 设 AICLIENT_RUNTIME_TRACE_DIR 后开 3 个会话跑到至少两次轮转，runs.1/2/3.jsonl 是否连续无空洞、行数是否守恒 | 按 evidence/p4-6 的脚本设变量起应用，跑完后 wc -l runs*.jsonl 并比对 run_id 并集 | `concurrency` |
| 14 | 导入时的进程峰值 | 在容量 3 的机器上开满 3 个会话后发起旧对话导入，是否出现第 4 个 worker 进程 | 起 Electron，导入前后各数一次 worker 进程 | `concurrency` |
| 15 | U1 utility 探针走产品路径推导（批评者缺口 14 的收口判据） | carrier=electron-utility 且 node.source==='bundled'、node.path !== process.execPath、tsdReadFallback==='configured-node'，六项工具断言全通过，报告里带 Electron 版本与 HEAD 版本戳 | 改造后的 src/runtime/smoke/p1-utility-worker.ts 经 scripts/runtime-smoke/electron-carrier.cjs 运行，输出与提交号一起归档 | `tsd-utility` |
| 16 | U2 utility worker 的 stdout 压力（tsd-03 判据） | 临时探针在 utility worker 里向 stdout 写 4 MiB 后，RPC 仍能应答一次 bootstrap；worker RSS 增长 < 数 MiB | 起 Electron，观察探针应答与 worker 进程 RSS；修复后重跑对照 | `tsd-utility` |
| 17 | U3 两载体同一报文形状对比 | 同一次 bootstrap + 一次 run 的 worker→Main 消息，在 utilityProcess 与 fork() 两条通道下逐字段等价（尤其无 undefined 键差异） | 两条通道各录一份消息序列 JSON，跑一次 diff，差异逐条解释 | `tsd-utility` |
| 18 | U4 退出码与信号语义在两载体下的差别 | 外部 SIGKILL / taskkill 掉 worker 后，Main 记录的 `Worker exited (code=? signal=?)` 两个载体各是什么；确认 isLostDisposeAck（WorkerSlot.ts:118-125，要求 code===0 && signal===null）不会把崩溃误判成「dispose ACK 丢了」 | 两个载体各杀一次，抓 main.log 对应行 | `tsd-utility` |
| 19 | U5 打包 macOS/Linux 上 bash 工具的 PATH 首位是随包 Node | bash 里 node -v 与 which node 指向 resources/node-runtime；确认这是否是想要的行为（契约第 4 节写了规则但没写非 Windows 上的意图） | 打包产物里跑两条 bash 命令截输出，结论回写契约或 ARD | `tsd-utility` |

### 真实模型回合（需要真 provider 与真 key）（38 项 + 新增 MODEL-39～50，见第二节）

| # | 项 | 判据 | 取证方式 | 来源区域 |
|---|---|---|---|---|
| 1 | dispose 排空事件是否到达界面：invalidateAll 打断一张挂起的权限卡 | 保存模型设置之后，屏上的权限卡被收掉、回合有明确终态；若卡片留在屏上且点击报 session_not_ready，即证实 main-host-03 的下游后果 | 真实模型回合，触发一次需要审批的写文件工具，卡片出现时在设置页保存任一模型/服务商改动（走 piModels.ts:42 的 invalidateAll），观察卡片与回合状态 | `main-host` |
| 2 | reload 的 60 秒预算在真实 MCP 握手下端到端成立 | 配一台握手耗时 15～30 秒的 stdio MCP 服务器，从 pi TUI 交还 GUI 后的第一条消息不再失败、会话不被 retire | 配置一个故意慢启动的 stdio MCP server，走「GUI 开 TUI 编辑 → 回 GUI 发消息」触发 reloadSessionFromDisk，看是否走到 worker_reload 失败分支 | `main-host` |
| 3 | 真实模型输出形态（utility-05 的判据） | 分支名是否出现围栏 / 多行 / 解释性文字；提交信息围栏剥离是否正确；空输出时界面表现 | 用当前默认模型各跑 10 次，记录原始 text 与界面最终值 | `utility-chain` |
| 4 | 模型被下架后的设置页一致性（utility-03 的判据） | 设置页显示「自动」时，请求里实际携带的 model 值是否为空 | 在 Main 侧打印 utility.start 载荷，与设置页显示对照 | `utility-chain` |
| 5 | GUI 重命名后在 pi CLI 侧的标题 | pi CLI 的会话列表 / 标题栏显示的是 GUI 里改过的名字，还是空 | GUI 里重命名一个会话，用 pi CLI 打开同一个 JSONL | `session-index` |
| 6 | 导入会话的续聊（H/21 C6 真机复验） | 导入的历史真的进了模型上下文，模型据此作答而不是泛泛回应 | 真实模型回合一次，问「上面这段对话在讨论什么问题」 | `import-upstream` |
| 7 | kill 之后 CLI 是否真的退出 | GUI 发送触发 releaseSessionForHostPrompt 后，原 pi 进程 pid 在重读完成前已不存在，且重读点之后 JSONL 没有新增 CLI 追加的行 | 开 TUI 记下 pid，GUI 发一条消息，ps -p <pid> 连续采样；同时 tail -f 会话 JSONL 比对 | `terminal-tui` |
| 8 | TUI 流式回合中途切 GUI | 时间线缺失的条目在下一次 GUI 发送后被补齐，且文件仍可打开 | 在 TUI 里发一个长回答，输出中途点 GUI 截图时间线；再发一条消息后对比 JSONL 行数 | `terminal-tui` |
| 9 | provider 错误正文是否落进会话文件（ah-lib-01） | 一轮真实 401/400 之后，会话 JSONL 中该 assistant 条目的 errorMessage 字段存在且未脱敏，而同一轮 runs.jsonl 的 llm 便签已脱敏——两者不一致即证实 | 用真实 provider（或一个会回显 Authorization 头的本地网关）跑一轮失败回合，grep 会话 jsonl 的 errorMessage 并与 runs.jsonl 对比 | `agent-host-lib` |
| 10 | 裸密钥形状是否被 redactSensitiveErrorText 漏过（ah-lib-02） | 让网关返回 `Incorrect API key provided: sk-proj-<40 位>`，runs.jsonl 里该串原样保留即证实 | 与上一项同一轮，另做一条断言 | `agent-host-lib` |
| 11 | native grep / glob 行的命中列表 | 修复 chat-tool-01 后，悬停搜索行出现命中列表，点击命中能打开对应文件并跳到行号 | 起 Electron，真实回合跑一次 grep 与 glob，悬停截图 + 点击后编辑器定位截图 | `chat-tool-vocab` |
| 12 | 工作区外 read 的审批卡 | 卡上出现被读取文件的完整路径，而不只是「read — 读取文件内容」 | 真实回合让模型读一个工作区外文件，截审批卡 | `chat-tool-vocab` |
| 13 | 中文界面的工具行参数文案 | new_context / TaskWait / TaskList 三种行全中文，无 a fresh window / delegation(s) / running subagents | 语言切中文，跑一次含上下文压缩与子代理等待的回合，截时间线 | `chat-tool-vocab` |
| 14 | 技能审批卡的正文标签 | 中文界面下标签为「技能」而非 Skill | 中文界面触发一次需审批的技能加载，截卡 | `chat-tool-vocab` |
| 15 | MCP 行的三处名字一致 | 时间线、子代理面板表头、Run 面板芯片都显示 server · tool，没有 mcp__ wire 名 | 接一个真实 MCP 服务器跑一次调用，一屏内同时截三处 | `chat-tool-vocab` |
| 16 | 导入会话与 native 会话并列 | 同一窗口里导入的 Claude 会话与 native 会话的搜索行表现一致（都有/都没有命中列表） | 导入一个真实 Claude 会话，与一个 native 会话并排截图 | `chat-tool-vocab` |
| 17 | 审批后 Run 面板状态 | 点「允许」之后，Run 面板标题从「等待审批」变为「运行中 / 正在运行工具」，attention 色消失 | 起应用跑一次触发 write 审批的对话，批准后截 Run 面板 | `chat-event-vocab` |
| 18 | 上下文徽标在委派后仍在 | 一次用到 Task 的对话，正常结束与中途 Stop 两种收尾下，输入框上方的百分比徽标都不消失 | 同一会话各跑一次分别截图；对照 devtools 里最后一条 usage.updated 的键集是否含 context | `chat-event-vocab` |
| 19 | 并发问答 | 会话 A 的 ask 未答时在会话 B 触发 ask，切回 A 仍有可作答卡片，且 A 的回合能自己结束 | 两个会话各发一条会触发 ask 的指令并切换观察；必要时用 devtools 直接读 store 的 pendingQuestion | `chat-event-vocab` |
| 20 | 子代理审批行归属 | 委派一个会撞 deny 的子代理后，时间线审批行上能读出是哪个子代理 | 起应用跑一次委派，截时间线审批行 | `chat-event-vocab` |
| 21 | 中文界面审批行用词 | 中文语言设置下，「本会话内允许」之后的自动放行行不出现英文 session grant | 切中文，先批一次「本会话内允许」，再触发同类工具，展开「审批详情」截图 | `chat-event-vocab` |
| 22 | 工具进度行 | 跑一条 >60s 的 bash，Run 面板是否出现工具自报的进度行（按当前代码应当永不出现，用于确认 chat-event-04） | 起应用跑 sleep 90 && echo done，观察 Run 面板 | `chat-event-vocab` |
| 23 | 回放差异 | 一个批过审批、答过问答的会话关掉再打开后，审批行与问答卡是否还在 | 跑完一轮后重启应用打开同一会话，前后截图对比 | `chat-event-vocab` |
| 24 | live lane 现行可跑，确认 P0-6 判定依赖的 R1（真实端点关闭风险）结论在当前 HEAD 仍成立 | 至少一个真实供应商的 --model provider/id 调用返回 must_succeed=true 且不超过 max_latency_ms | 用登录后的 ~/.pilab/pi-agent/ 目录跑 --model，比对新旧 trace 的 version_stamp 差异 | `smoke-p0-6` |
| 25 | run-native.mjs --case 部分重跑 + collect.mjs 收尾这条恢复路径端到端可用且标题正确 | 真实网关下故意只跑 1-2 个 --case，其余用别的目录跑完，collect.mjs 收尾产出的 summary.json/report.md 字段正确、标题反映真实 backend | 需要 P20_BASELINE_API_KEY 与可用网关，实跑一次并人工核对产物 | `baseline-comparability` |
| 26 | archive.mjs 的分代拒绝逻辑在两次真实 native 采集（跨一次 RUNTIME_CONFIG_VERSION 升级）之间确实产出不可比而非误判为可比 | 升级 RUNTIME_CONFIG_VERSION 前后各真实采集一次，compare.mjs --baseline <升级前> --native <升级后> 必须在 failures 里报 behaviour generation differs | 需要两次真实网关采集，跨一次代码升级 | `baseline-comparability` |
| 27 | F5 / GUI C/8 问答卡真机一圈 | 模型调 ask → 输入框上方出现可作答卡 → 选项与 Skip 各走一次 → 模型收到对应文本（skip 走「自行选默认并说明」那条） | 真实模型回合，CDP 读回整张卡并截图 | `field-nodes` |
| 28 | 权限卡倒计时走到底 | 不响应满 119 秒后自动拒绝，卡片状态变为已拒绝，工具调用按拒绝结算 | 真实回合触发审批卡后不响应，等满倒计时并记录事件流 | `field-nodes` |
| 29 | PERM-1 探针复跑（T001 之后） | 七条判据全通过；权限卡文案经词典而非硬编码；触发器选择器能命中当前 aria-label | node scripts/run-perm1-probe.mjs；复跑前先按 field-05 处理产物命名，避免覆盖 2026-09-11 的记录 | `field-nodes` |
| 30 | GUI F/13 真实 busy 会话下的数字 | busy 会话所在目录行出现 +N -M 并随改动刷新；非 busy 目录不轮询 | 起一个会真的改文件的会话，观察侧栏并抓 IPC 调用次数 | `field-nodes` |
| 31 | H/21 Codex 旧格式导入 | 用一份真实的旧格式 Codex rollout（裸 header、裸行）跑导入，标题/正文/幂等三项与新格式一致 | 需要一份真实旧格式样本文件（当前开发机没有） | `h-nodes` |
| 32 | 回合进行中切 TUI 的实际行为 | 点终端按钮是否只弹「等这一轮结束」提示，且 writer.lock 与会话文件均未被第二个进程触碰 | 起 Electron 发一条长回合，回合中点 TUI 切换；随后 ls -la 会话目录看有无新写者痕迹 | `concurrency` |
| 33 | W3 windows-01：MSYS 盘符记法是否绕过 ~/.ssh/* 的 deny | 三种拼法在同一档位下的判定必须一致：波浪号写法、原生盘符反斜杠写法、MSYS 的 /c/ 写法。若第三种被放行（auto 档无卡片，或其他档降级成普通 ask 卡）即为复现 | 建一个内容是哨兵串的假 id_ed25519；auto 档下依次让模型跑三条命令，记录是否弹卡、是否返回文件内容；同时看 trace 的权限审计行 | `windows-static` |
| 34 | W8 windows-05：CRLF 工作区的 edit 行为 | 对一个 CRLF 文件做一次三行内的 edit，期望成功且文件行尾仍是 CRLF。失败形态要记录两件事：错误码原文、模型是否退回整文件 write | 用 core.autocrlf 为 true 克隆一个小仓，确认文件是 CRLF，让模型改一处；改完跑 git diff --stat 看是不是全文件 | `windows-static` |
| 35 | W11 windows-09：原生工具的 OEM 代码页输出 | 工作区里建一个中文名目录，让模型用 bash 跑 cmd 的 dir，工具结果里的中文必须可读 | 真实模型回合，抓工具结果原文与 trace | `windows-static` |
| 36 | W13 保留文件名与尾随点 | 让模型 write 到工作区下的 nul 与一个以点结尾的文件名：期望要么明确报错，要么真的落盘且随后 read 能读回；不得出现报告写入成功但文件不存在 | 真实模型回合，写完立刻用 PowerShell Test-Path 核对 | `windows-static` |
| 37 | 压缩摘要真实体积上限 | 大上下文窗口真实模型触发 /compact 后，summary 实际字节数是否需要独立硬顶 | 真实模型回合 + 读会话文件里 compaction 条目字节数 | `capacity-leftovers` |
| 38 | MCP 图片字节假设（T024 遗留未验证项，本区域一并确认仍未验证） | 1 MiB/张、2 MiB/次的假设是否贴合真实 MCP 截图服务器的输出分布 | 接入真实 MCP 截图/图片服务器观察实际返回图片字节分布 | `capacity-leftovers` |

### 开发机（上机前就能做完）（35 项 + 新增 DEV-36/37，见第二节）

本表第 19 / 20 / 21 / 22 项已于 2026-09-17 完成、第 35 项已裁决为不需人工执行，当前状态以 [3.1 节](#31-已完成2026-09-17)为准。

| # | 项 | 判据 | 取证方式 | 来源区域 |
|---|---|---|---|---|
| 1 | 归档正在跑回合的临时对话（POSIX 半边；判据 2026-09-17 改写，见 5.1） | 归档时正在跑的回合被中止（工具进程收到 SIGTERM、回合记为 aborted），worker 退出之后 scratch 目录才被删；不出现任何「在已删除目录里写入 / 读取」的工具调用，main.log 无 `[scratch] failed to remove` | 同上，在开发机重放：假网关给一个长 bash 再接 write / read，sleep 期间归档，记录回合终态、网关收到的后续请求数、目录残留 | `main-host-aux` |
| 2 | 临时根改设置后的旧根 | 旧根下的 unbound-sessions/ 在退出与重启后是否仍在；重开旧对话时侧栏是否仍标为临时会话；**改设置后新建的临时对话其 scratch 目录落在新根**（2026-09-17 补，见 5.1） | 改设置前后各记一次两个根的目录列表与 session-index.json 的 unbound 位；改设置后新建一个临时对话并记它的 scratch 目录路径 | `main-host-aux` |
| 3 | 兼容根子代理定义的删除语义 | 在 ~/.agents/subagents 放一份定义并编辑后删除，该行应消失而不是回到旧内容。**当前预期 ✗**（2026-09-17 实测：编辑只写主目录影子、删除只删影子，兼容根原件浮回；缺陷 D12），修复后按本判据复验 → **已修（T063），2026-09-17 真机复验 ✅**（编辑原地改兼容根、主目录始终无同名文件、删一次即消失且重启不回来） | 设置页子代理列表操作前后各查看一次两个目录的文件 | `main-host-aux` |
| 4 | 协议版本不匹配的可诊断性 | 故意让打包产物里的 worker.js 与 Main 的 WORKER_RPC_PROTOCOL_VERSION 不一致，检查日志里是否出现任何指向「协议版本」的字样 | 在 dev 环境改一处常量制造不匹配，起会话并收集 Main 的 console 与 electron-log 输出；当前预期是只有 worker.bootstrap timed out，无任何协议线索（main-host-08） | `main-host` |
| 5 | fork 一个未绑定（scratch）会话（后半句判据 2026-09-17 更正，见 5.1） | 对话框不出现「Fork was created, but its workspace could not be materialized in this window」；此时 session-index.json 里已有该 fork 行，且**带** `unbound: true`、`workspacePath` 指向源会话的 scratch 目录 | 起 Electron，新建不选文件夹的聊天并发一轮，点 Branches → Fork；随后 cat userData 下的 session-index.json | `session-index` |
| 6 | 上一条之后重启应用 | 该 fork 是否从侧栏彻底消失，而索引行与 JSONL 仍在磁盘上 | 退出应用后重开，比对侧栏与 session-index.json | `session-index` |
| 7 | 索引损坏后的第一次写 | 旧行是否被覆盖丢失；坏文件是否还留在磁盘上 | 退出应用，把 session-index.json 截断成半行 JSON，重开应用（侧栏应为空），新建聊天发一句话，再看文件内容 | `session-index` |
| 8 | fork 窗口内强杀留下的残留文件 | 会话目录里是否多出无主 <uuid>.jsonl，pi CLI 是否把它列成一个会话 | 点 Fork 后在新 worker 起来之前强杀应用，随后 ls 会话目录并开 pi CLI 列会话 | `session-index` |
| 9 | 临时工作区删除后的会话去向 | 用侧栏删除一个临时工作区目录后，其下的聊天是否从侧栏静默消失，而索引行仍在 | 起 Electron 走 temp:workspace:remove 那条链，之后刷新侧栏并比对 session-index.json | `session-index` |
| 10 | 子目录不可读时 Codex 源的表现（import-up-01） | 在 ~/.codex/sessions/<某一天>/ 上置 mode 000 后，导入面板里 Codex 项目仍能列出其它日期的会话。**当前预期 ✗**（2026-09-17 实测整个 Codex 源静默消失，即 import-up-01，归 T052），修复后按本判据复验 | 改权限 → 打开导入面板截图 → 恢复权限 | `import-upstream` |
| 11 | 超限会话的导入错误形态（import-up-04；阈值 2026-09-17 更正，见 5.1） | 用户看到的失败文案可理解；失败后 sessions/.aiclient-import-staging/ 下无残留、manifest 无 cleanupPending 记录 | 造两份 Claude JSONL 走 GUI 导入：一份 35 MiB / 6000 行（撞 4000 条目上限）、一份 > 64 MiB（撞体积守卫），各记录报错文本并检查暂存目录 | `import-upstream` |
| 12 | Codex 旧格式（裸行）真机导入（H/21 C5 的现场半边） | 真实旧格式 rollout 能被列出并导入成功 | 需要一台还留着旧格式 rollout 的机器，或从 Codex 历史版本导出一份；H/21 当时「本机 10 个 rollout 全是新格式」 | `import-upstream` |
| 13 | 大目录下导入的主进程占用（import-up-03） | 300 份以上 rollout 时，打开导入面板到列表渲染的耗时，以及批量导入 40 条期间界面是否可交互 | 起 Electron，用 CDP 记录面板打开到列表渲染的时间；批量导入期间观察界面响应 | `import-upstream` |
| 14 | TUI 模式下切换会话（terminal-03） | 切到另一个聊天后终端画面是否仍是上一个聊天的 pi 会话；在终端里敲一句话后它落进哪个 JSONL | 同仓库两个聊天，TUI 模式下点侧栏切换，然后 grep 两个会话文件 | `terminal-tui` |
| 15 | 终端复活丢 sessionFile（terminal-04；取证 2026-09-17 更正，见 5.1） | 让 pi 快速失败后，终端是否变成一个空白新会话（pi 自己退出后经 `handleTuiExit` 复活的那次 spawn，argv 里没有 --session） | 把 `--session` 指向的 JSONL 首行改坏起 TUI（改坏模型配置 pi 只报错不退出），在 spawn 后的启动窗口内抓 `/proc/<pid>/cmdline`（pi 随后会改写进程标题，只剩 `pi`），两次 spawn 各抓一次 | `terminal-tui` |
| 16 | 两个窗口对同一会话开终端 | 是否能出现两个 pi --session <同一文件> 进程。**当前预期 ✗**（2026-09-17 实测两进程并存、零提示、会话树静默分叉；缺陷 D18），修复后按本判据复验 → **已修（T065），2026-09-17 真机复验 ✅**（第二个窗口两条路都弹中文 toast 且界面不切，`/proc` 里始终只有一个 pi） | File → New Window 开第二个窗口选中同一聊天进 TUI，在 spawn 启动窗口内抓 argv（`ps aux` 过滤 `--session` 抓不到，pi 会改写进程标题），前后读 writer.lock 与两条 JSONL 的条目链 | `terminal-tui` |
| 17 | 会话文件损坏 / 缺失 / 换工作区三种恢复失败的界面文案（ah-lib-03） | 分别看到「Session history is damaged（不可重试）」「History not found（此对话无法继续）」「Session belongs to another workspace」（中文界面对应「会话历史已损坏」「未找到历史」「该会话属于另一个工作区」），而不是三次都看到「Failed to read history（可以继续发送）」 | 起 Electron，造三个会话：① 中段插 65 行坏 JSON（超过 MAX_SKIPPED_ROWS 触发拒绝）② 删掉会话文件但保留索引行——**索引行必须带 `piLeaf`**，否则走 `isUnwrittenPiSession` 的修复分支原地重建空会话、一张卡都不出（2026-09-17 踩坑，见 5.1）③ 把工作区路径改掉；逐一恢复并截图卡片 | `agent-host-lib` |
| 18 | 宿主诊断横幅 | 人为让 Node 24 解析失败时，用户能否看到可操作的提示。**当前不可执行**（2026-09-17，见 5.2：Node 24 解析已无生产调用方）；宿主 `state=error` 时横幅是否出现、文案是否可操作已由第 4 项（bootstrap 超时）顺带观察 | 清掉 AICLIENT_NODE24_PATH 并让默认 node 不可用后起应用 | `chat-event-vocab` |
| 19 | offline lane 现行可跑：执行 node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline | 退出码 0，六项断言全部 PASS，新 trace 的 version_stamp.backend==='native'、config_version==='runtime_p6_hardening_v1' | 实际执行命令，存档 stdout 与新生成的 runs.jsonl | `smoke-p0-6` |
| 20 | 新证据同时存档 report.outcomes（逐条断言名与 pass/fail）与 runs.jsonl | 新存档文件里能直接读到六项断言各自的通过状态，而不是只有裸 trace | 执行时加 --json，把 stdout 与 trace 一起写入 evidence 目录 | `smoke-p0-6` |
| 21 | 为 plugin_graph_incomplete 失败路径补测试后确认通过 | 新增 vitest 用例断言 code:'plugin_graph_incomplete' 且缺失服务名单正确，不影响既有用例 | 运行 pnpm typecheck:runtime 与对应 vitest 文件 | `cordis-spike-d1` |
| 22 | cordis 版本升级时重跑 p0-cordis-semantics.ts 确认三条语义不变 | 三行 console.log 布尔值（deferred activation / fiber settle / dispose retraction）与升级前一致 | 手动执行 node --experimental-strip-types src/runtime/spikes/p0-cordis-semantics.ts，比对升级前后输出 | `cordis-spike-d1` |
| 23 | CI 在日常 push/PR 上确实不触发任何测试 job | 向非 tag 分支推送一次提交或开一个测试 PR，GitHub Actions 页面除 code-review.yml/claude.yml 外没有任何 workflow run 被创建 | 用有仓库权限的账号实际推送/开 PR 并观察 Actions 列表；或 gh run list --branch <分支> | `baseline-comparability` |
| 24 | F4 的 GUI 观感 | 重试期间时间线出现重试提示；预算耗尽后错误文案完整可读且带网关原文（2026-09-17 注：实物是时间线里一个 mono 红色错误块，不是带标题 / 下一步 / 重试按钮的卡片；两条判据成立，「要不要升级成卡」是产品决策，见 5.1） | 起 Electron 加假网关（`--plan retry-503` 与 `retry-503-forever`），走真实会话触发并截图 | `field-nodes` |
| 25 | F7a/F7c 视觉口径 | 权限卡与问答卡的圆角 / 阴影 / 字号 / **字重** / 间距 / 动画按 docs/design-system.md 的 Token 分档复核并留截图（字重一维 2026-09-17 补，见 5.1；Linux 上看不出偏差，须在 Win10 复拍） | 真实回合触发两张卡后用 getComputedStyle 逐项比对 | `field-nodes` |
| 26 | F2-b 正常退出时的 scratch 清理 | 从界面正常退出（非 kill）后，本次的 scratch 目录即被删；与 kill 那次的差异有记录 | 三时点各读一次 session-index.json 与目录，沿用 scripts/run-f2b-probe.mjs 的两侧读法 | `field-nodes` |
| 27 | F2-b 临时行第三个「删除」按钮 | temp:workspace:remove 只删临时基目录的直接子目录，删不到 unbound-sessions/ 下的 scratch 目录 | 真机点按，两侧读目录 | `field-nodes` |
| 28 | 临时会话索引 title 为空的复现与定性 | 发完第一句后索引行 title 非空且与侧栏显示一致 | 直接读 session-index.json，不看界面 | `field-nodes` |
| 29 | GUI A/10 TEMP /new 矩阵 | 从普通目录、TEMP 会话（已发过消息，scratch 已分配）、TEMP 会话（从未发送，scratch 未分配）三种起点各开 /new，cwd 继承结果逐格记录（起点命名 2026-09-17 更正，见 5.1） | 真机点按，逐格记 | `field-nodes` |
| 30 | TUI-1 / H/20 真机一圈 | GUI 跑一回合 → pi --session 打开 → 在 TUI 里续聊 → 回 GUI 接得上；右上角 GUI/TUI 开关那一下也点一次 | 内嵌终端真开，前后各读一次会话文件并比对头一行与条目链 | `field-nodes` |
| 31 | H/19 验证案例 7 | GUI 与内嵌 TUI 都能列出迁移/导入后的历史会话；在 TUI 里续聊一轮再回 GUI，历史接得上 | 真实 Electron + 内嵌 PTY，走完整一圈 | `h-nodes` |
| 32 | H/21 内嵌 TUI 模型缺失覆盖层（判据 2026-09-17 补全，见 5.1） | 打开一条模型已被迁移覆盖的旧会话：GUI 侧出 H/21 的中文「本应用没有这个模型」覆盖层；TUI 侧同样给出可读的「模型缺失」提示而不是裸错误。**GUI 侧当前预期 ✗**（缺陷 D19：`isModelMissingError` 认的两个信号在会话路径上已无生产抛出点）→ **已修（T062），2026-09-17 真机复验 ✅**（composer 上方出中文覆盖层卡，四段全中文、按钮跳「设置 · Pi」；复现该场景还需 localStorage 的每会话模型钉子） | 真实 Electron，GUI 侧截覆盖层，再切到内嵌 TUI 视图截 pi 的提示原文 | `h-nodes` |
| 33 | 附件顶满会话文件后的端到端表现（判据 2026-09-17 改写，见 5.1） | 连续发送 4 条「1 张 ≈5 MiB 图 + 1 张 ≈1 MiB 图」的消息后，会话文件停在 32 MiB 以内（≈31.9 MiB）；第 5 条发送被拒，界面给出会话超预算类错误；重开该会话正常打开（不抛 io_limit）；**被拒后同一会话继续发纯文本，要么成功、要么给出可见错误，静默丢弃判负**（当前预期 ✗，缺陷 D24 → **已修（T061），2026-09-17 真机复验 ✅**：被拒后纯文本发送成功、网关计数 +1、会话文件 +926 B，被拒那次的红块仍在）；重开应用后恢复 | 用真实 Electron GUI 走 Composer：渲染层没有 `input[type=file]`、⊕ 走原生对话框（CDP 驱动不了），要往 textarea 派带 `File` 的 `ClipboardEvent('paste')`（同一条 `ingestFiles` 管线）挂图；runtime 包内构造用例半边已由 `sessionAttachmentFill.test.ts` 覆盖 | `capacity-leftovers` |
| 34 | Main IPC 层缺失附件校验的直接验证 | 绕开 Composer 直接向 CHAT_SEND 传超限 attachments payload，确认 Main 不拒绝、请求原样送达 worker | 起 Electron 应用，在渲染层 devtools 控制台直接调用 window.api 发送接口并传构造好的超限 payload | `capacity-leftovers` |
| 35 | 多进程并发轮转同一 runs.jsonl | 两个独立 worker 进程共享同一 AICLIENT_RUNTIME_TRACE_DIR 并几乎同时 finish() 时，是否出现代际丢失或写入交织/损坏 | 用两个 Node 子进程直接跑 runtime 包 bootstrap（不需要 Electron），共享同一 traceDir | `capacity-leftovers` |


## 5. 合并时的裁决记录

### 5.1 判据修正

| 项 | 草案原判据 | 改为 | 理由 |
|---|---|---|---|
| DEV-22 cordis 语义探针 | 「三行 console.log 布尔值……（`shouter present? true` 两次、`dispose 后 shouter present? false`）」 | 脚本实际打印五行：① `after dependant only — shouter present? false`（Q1 推迟激活）② `after dependency arrives — shouter present? true` 且 `shout: HELLO RUNTIME`（Q2）③ dispose 后 greeter / shouter 均 `false`（Q3） | 原判据把第一行写反了。按 Q1 的定义，依赖未到时**必须**是 false；真出现「true 两次」恰恰说明推迟激活语义被推翻、`bootstrap.ts` 的兜底分支再也轮不到执行。照原判据验会得出相反结论。2026-09-17 实跑核对 |
| DEV-33 附件顶满会话文件 | 「连续发送 2~3 条各含多张图片附件的消息后，会话文件字节数是否逼近/超过 32 MiB；重开该会话是否抛 io_limit」 | 「4 条『1 张 ≈5 MiB + 1 张 ≈1 MiB』后文件停在 32 MiB 内、第 5 条被拒、重开正常」 | 原判据写于 T046 之前。T046 后单条落盘上限 8 MiB，一条里放不下多张 5 MiB 图（base64 后 6.67 MiB），32 / 8 = 4 条才顶满，2~3 条最多 23.99 MiB；写入侧 `store.ts:357` 与读取侧 `io.ts:336` 同用严格 `>` 比 32 MiB，本 store 写出的文件永远 ≤ 32 MiB，重开的 `io_limit` 经产品路径不可达（只有外部把文件推过 32 MiB 才够得着）。2026-09-17 构造用例实测：4 条 31.99 MiB、第 5 条 `session_size_limit`、重开成功；两组反向验证判红后复原 |
| DEV-11 超限会话导入 | 「超 32 MiB 会话的导入错误形态……造一份 35 MiB 左右的 Claude JSONL」 | 阈值改为「35 MiB / 6000 行撞 4000 条目上限 + > 64 MiB 撞体积守卫」两份 | 普通文件的体积守卫是 `LEGACY_IMPORT_MAX_SOURCE_BYTES` = 64 MiB（`src/shared/types/legacyImport.ts:6`），32 MiB 是 `TSD_BUFFERED_READ_LIMIT`（`tsdSafeRead.ts:86`）只管 TSD 加密文件的有界读；35 MiB 在 Linux 上触发的是 `LEGACY_IMPORT_MAX_ENTRIES` = 4000（`ClaudeSourceAdapter.ts:270`），照原判据会把「条目上限」的报错误记成「体积上限」。2026-09-17 样本准备时离线实跑核对 |
| DEV-5 fork 未绑定会话 | 「session-index.json 里是否已有该 fork 行且**不含** unbound」 | 「已有该 fork 行且**带** `unbound: true`，`workspacePath` 指向源会话 scratch 目录」 | 原判据是修复前形态。T040 `d4a361b5` 提交说明第一条：fork 未绑定会话时索引行补写 unbound，渲染层接受「有 unbound、没有工作区」的行，重启后不再被当孤儿丢掉——「带 unbound」正是 DEV-6「重启后不消失」成立的前提。照原判据字面验会把修复成功判成失败。2026-09-17 真机实测到 `unbound: true` |
| DEV-13 大目录导入耗时 | 「打开导入面板到列表渲染的耗时」未定义「列表」 | 明确为两个数：① 面板打开 → Codex **项目行**出现；② 展开项目 → 320 行**会话列表**渲染完成（两者差一个量级，2026-09-17 实测分别约 0.7～1.0 s 与再加 0.6～1.2 s） | 判据原文歧义，两种读法结论不同；本次两个都记 |
| DEV-1 归档跑中回合 | 「回合后续的文件工具不会在已删除目录里静默失败，或至少给出与『目录没了』相关的错误」 | 「归档时回合被中止（SIGTERM、aborted），worker 退出后才删 scratch 目录，不出现任何在已删目录里的工具调用」 | 原判据是修复前形态（工具真的跑了、真的失败了）。T037 `99db822c` 之后整个回合在归档那一刻被中止，后续工具不会被调起，「与目录没了相关的错误」永远不会出现，照第二分句字面验会读成不通过。2026-09-17 实测：归档 11 ms 后 bash 收 SIGTERM、回合 aborted、worker 退出后目录才删、网关未再收到后续请求 |
| DEV-2 临时根改设置 | 只问「旧根还在不在」「侧栏还标不标 temporary」 | 补一格「改设置后新建临时对话，记 scratch 目录落在哪个根」 | 原两问都能通过，却漏掉真正的雷：Main 侧 `readSettings()` 读的是 settings.json 顶层、用户设置在 `aiclient-settings.state` 里，「保存位置」恒读不到，scratch 根永远回落默认目录（缺陷 D13）。补这一格才逼得出来 |
| DEV-15 终端复活 | 取证「临时改坏模型配置起 TUI，看 ps 里的 --session」 | 「把 `--session` 指向的 JSONL 首行改坏；spawn 启动窗口内抓 /proc cmdline」，并写明验的是 `handleTuiExit` 那条复活路径 | 改坏模型配置 pi 只印一条错误继续活着，达不到「快速失败」；pi 起来后改写进程标题，`ps` 里只剩 `pi`，过滤 `--session` 永远为空（DEV-16、MODEL-48 同）。2026-09-17 实测两次 spawn argv 都带 `--session`（T048 复活绑定成立）。方法与基线见 dev-D-method-note-proc-title.txt |
| DEV-32 模型缺失覆盖层 | 判据只写「TUI 侧同样给出可读提示」 | 补成「GUI 侧出 H/21 中文覆盖层」+「TUI 侧出 pi 可读提示」两句 | 取证方式里有「GUI 侧截覆盖层」而判据句里没有，照判据字面读是 ✅、照取证读是 ⛔；2026-09-17 实测 GUI 侧覆盖层已触发不到（D19），这种回归会从判据缝里漏过去 |
| DEV-17 恢复失败文案 | 取证「删掉会话文件但保留索引行」 | 补「索引行必须带 `piLeaf`」 | 不带 `piLeaf` 的索引行会被 `isUnwrittenPiSession` 判成「从未写过的会话」走修复分支，原地重建空会话、不出任何卡，验不到 `jsonl_not_found`。2026-09-17 实测三张卡各出各的中文文案 |
| DEV-24 F4 观感 | 「错误卡」 | 「错误文案」并注明实物形态 | 预算耗尽后屏上没有 `role="alert"` 的卡片，只有 `font-mono text-code` 红色错误块（无标题 / 下一步 / 重试按钮）；判据两条（完整可读、含网关原文）实测成立。要不要像 DEV-17 那样升级成有引导的卡是产品决策，列入缺陷总结待定 |
| DEV-25 视觉口径 | 「尺寸、字号、间距」 | 补「字重」成六维 | 2026-09-17 实测圆角 / 阴影 / 字号 / 间距 / 动画全部在档，唯一系统性偏差在字重（标题 `font-medium` 500，Win10 常见字体无 500 档会回落 400，缺陷 D23）；原三维判据正好漏掉它，且 Linux 上看不出 |
| DEV-29 TEMP /new | 「TEMP 会话」与「无工作区」并列为两种起点 | 「TEMP 会话（已发过消息）」与「TEMP 会话（从未发送）」 | `temporaryWorkspaceEnabled=true` 时「不选文件夹的聊天」就是一条 unbound 会话，发第一句才分配 scratch 目录；两格差别是 `inheritedPath` 有无值，不存在第三种会话类型。2026-09-17 实测：普通目录继承同工作区；已分配 scratch 的 TEMP 会话 /new 继承**同一个** scratch 目录（两条会话共用）；未分配的无可继承、首发时新分配 |
| DEV-36 插件页文案 | 一句合写「本应用自带权限系统审批每个对话，你装的 pi 权限扩展只影响内嵌终端」 | 拆成「① 无条件句」+「② 装了 pi 权限扩展时才显示的句」，取证加前置步骤 | 后半句是 `PiPluginsSettings.tsx:253-268` 的条件渲染（`permissionSystemOwner` 为 `user_configured` / `unknown` 才出），没装扩展的机器只看得到前半句；照原判据会误判成「后半句丢了」。2026-09-17 开发机只验到 ① |
| DEV-33 附件 GUI 半边 | 「被拒后能否继续发纯文本」挂在「另记」 | 升格为判据分句，静默丢弃判负；取证方式改为 paste 事件挂图 | 2026-09-17 实测被拒后纯文本被静默丢弃、重开应用即恢复（D24，本轮最疼的一条），挂在「另记」里下一个人可能只记一句「不能」就过去；`input[type=file]` + `DOM.setFileInputFiles` 在本仓不可执行（无文件 input，原生对话框 + `file:readAttachment` 一次性授权闸） |

### 5.2 不需要人工执行的项

| 项 | 裁决 | 依据 |
|---|---|---|
| DEV-35 多进程并发轮转同一 runs.jsonl | 🚫 已有自动化覆盖 | `src/runtime/__tests__/trace.test.ts:350` 用两个真实 `fork` 子进程共享同一 traceDir 冲击轮转阈值，断言无代际丢失、无写入交织、代际连续、不留 `.lock`（T045 `e5a2d5b9` 落）。2026-09-17 实跑 15/15 绿 |
| baseline-01 CI 是否在日常 push / PR 上触发测试 | 🚫 已结案 | `.github/workflows/build.yml` 的 `on:` 只有 `push.tags:['v*']` 与 `workflow_dispatch`；另两个 workflow（claude / code-review）不是测试作业。结论即「不触发」，这正是批次 D 判 P1-7 incomplete 的依据。要不要加测试 job 是决策，归 T054 |
| concurrency「三个会话并发时的真实进程数与内存」（PKG 组第 12 项） | ⚠️ 不在开发机做 | 开发机 2 核 / 3.3 GB 跑不出有意义的数字，会得出假结论。上机日做，或换一台内存充裕的机器 |
| DEV-18 宿主诊断横幅（Node 24 解析失败） | ⛔ 当前不可执行 | `AICLIENT_NODE24_PATH` 唯一的读者 `resolveNode24Runtime` 没有生产调用方，横幅分支 `isNode24ResolutionFailure` 只被单测引用、`describeHostStatus` 不调它；2026-09-17 去掉该变量起应用，宿主仍 ready、回合照跑、横幅零张。属死代码 + 文档漂移（缺陷 D16），先决定删代码还是接回来，再定这一行去留。宿主 `state=error` 的横幅表现已由 DEV-4 顺带记录。**2026-09-17 结论：T068 已删除该死代码（解析器、横幅分支、三个类型、`dev.env` 与四处注释），本行退役**，上机日不再尝试构造「Node 24 解析失败」；改为顺带确认 Windows 第 2 项——随包 `node.exe` 缺失时文案是 `Pi Node runtime is missing: <路径>`，且不再提及 `AICLIENT_NODE24_PATH` |

### 5.3 旧树待现场项的覆盖对照

T032 要求并入旧树待现场项。逐条对表的结果如下——**已覆盖的不重复列项**，未覆盖的已补在第二节。

| 旧树项 | 处置 |
|---|---|
| P5-2 SA16 / SA17 / SA18 / SA20 / SA21 / SA22 | 新增 MODEL-39～43、PKG-20 |
| P5-4/P5-5 MC-a / MC-b / MC-c / IM-b | 新增 MODEL-44～46、PKG-21 |
| P5-4/P5-5 IM-a（真机导入并续聊） | 已覆盖：MODEL 组第 6 项（导入会话续聊）+ ENC 组第 4 项（Claude 导入闭环） |
| P6-3 第 4 条（打包产物 GUI 回归） | 新增 PKG-23 |
| P6-3 第 6 条（加密机验收） | 已覆盖：整个 ENC 组即是 |
| P6-4 回退窗口（旧版产物互读） | 新增 PKG-22 |
| H/20 I5（TUI 续聊回 GUI、GUI/TUI 开关） | 新增 MODEL-47 / MODEL-48 |
| F3 根因拍板 | 已覆盖：ENC 组第 8 项（由 R0/R2/R3 结果唯一映射到 A / B / C） |
| P4-6 的 R0 / R2 / R3 / R4（从未执行） | 已覆盖：R0 = WIN 组第 16 项、R2+R3 = ENC 组第 7 项、R4 = WIN 组第 17 项。**上机日必须给出结论**，这四行是 P4-6 由 incomplete 转签的前提 |
| P1-2 特殊 Main 样本（编码 / 二进制） | 已覆盖：ENC 组第 12 项 |
| P1-5 自定义策略 / 复杂 shell / 策略重载 | 新增 MODEL-49 |
| P1-6 倒计时走到底的超时拒绝 | 已覆盖：MODEL 组第 28 项 |
| P1-8 六项探针重采（两载体） | 已覆盖：WIN 组第 26/27 项、PKG 组第 10/15 项 |
| GUI A/2 完整 Shell / Custom 组合 | 新增 MODEL-50 |
| GUI A/4 加密机回归 | 已覆盖：ENC 组第 10 项 |
| GUI A/7 多样路径 2c | 新增 DEV-37 |
| GUI A/10 TEMP /new 矩阵 | 已覆盖：DEV 组第 29 项 |
| GUI B/5 重试加密机复测 | 已覆盖：ENC 组第 9 项 |
| GUI C/8 问答卡真机（= 现场缺陷 F5） | 已覆盖：MODEL 组第 27 项 |
| GUI F/13 真实 busy 会话数字 | 已覆盖：MODEL 组第 30 项 |
| GUI F/15 F2-a/c 新包复验 | 已覆盖：WIN 组第 18 项 |
| H/17 打包 + 加密机联合回归 | 已覆盖：ENC 组第 13 项、WIN 组第 21 项 |
| H/19 验证案例 7 | 已覆盖：DEV 组第 31 项 |
| H/21 Codex 旧格式导入 | 已覆盖：MODEL 组第 31 项（需要一份真实旧格式样本，当前开发机没有） |
| 现场缺陷 F7a / F7c 视觉口径 | 已覆盖：DEV 组第 25 项 |
| 现场缺陷 TUI-1（未真机点验） | 已覆盖：ENC 组第 5 项 |
| 会话写入锁现场回归 | 已覆盖：ENC 组第 14 项、WIN 组第 31 项 |
| PERM-1 探针复跑（T001 之后） | 已覆盖：MODEL 组第 29 项 |
| 审计 permissions-19 | 新增 WIN-37（与 W3 同轮做） |
| 审计 core-host-05 | 新增 ENC-23 |
| 审计 core-host-07（Windows killTree 重入与失败可见） | 已覆盖：WIN 组第 28 / 35 项 |
| 审计 tools-10 | 新增 ENC-24 |
| 审计 cutover-03 | 新增 DEV-36 |

## 6. 签收口径

**最小签收集**：草案第一节的 34 条（批评者点名）是「不做就不能签收」的底线，它们分散在上面四张表里，来源列可回溯。其余 150 项与新增 20 项按环境分组，时间不够时按这个优先级砍：34 条必做 > 让某个节点能转绿的项 > 纯探索项（如 WIN 组的长路径、保留设备名、junction）。

**回填出口**（现场做完当天就写，不要留到事后）：

| 出口 | 谁来回填 |
|---|---|
| [P5-2-7 逐项签收](../runtime-evolution/evidence/p5-2/signoff.md)的六行 ⏸ | MODEL-39～43、PKG-20 |
| [P6-3 六项成功标准](../runtime-evolution/evidence/p6/README.md#p6-3-六项成功标准)第 4 / 6 条 | PKG-23、ENC 组整体 |
| [P4-6 表](../runtime-evolution/README.md#p4-集成--现场已执行剩具体缺陷与复验)与 R0/R2/R3/R4 四行 | WIN-16/17、ENC-7 |
| F3 根因：`docs/plans/2026-09-09-bash-carrier-decision.md` 第 6 节表 + README 的 F3 行 | ENC-8 |
| [P5-4/P5-5 待现场](../runtime-evolution/evidence/p5-4-p5-5/README.md)五行 | MODEL-44～46、PKG-21 |
| 本计划的 [roadmap](roadmap.md) T033 行与[进度看板](../../进度看板.md) | 全部做完后一次性 |

**取证规矩**（沿用批次 D 与旧树现场的既有要求）：

- 每项留下可复核的东西：截图、trace 片段、命令输出、或进程列表——不接受只写「通过」。
- 探针类产物按 field-05 的命名规则存，不要覆盖 2026-09-11 那批旧记录。
- 设了 `AICLIENT_RUNTIME_TRACE_DIR` 后 trace 目录会短暂出现 `runs.rotate.lock`，按 `runs*` 通配收集证据的脚本要过滤掉它（T045 的取证提醒）。
- 静态推断项在现场若与推断不符，**以现场为准**并当场回写审计证据，不要留到事后（批次 D 的 P4-6 就是因为没这条规矩才二次冲突）。

## 7. 测试缺口（128 条）不在本清单

草案第三节的 128 条测试缺口属于各修补任务要一起补的用例，不是上机内容，留在[草案原文](evidence/batch-d-audit-2026-09-15/checklist-e.md#三测试缺口128-条按区域)里按区域查。批次 F 的 T049～T054 各自的验收已经收编了对应区域的那部分。
