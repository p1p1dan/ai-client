# 批次 E 上机检查单（草案）

Role: reference（草案，供 T032 合并，不是最终检查单）。来源：2026-09-15 批次 D 只读补审（T029 / T030 / T031，基线 HEAD `ebc82f16`）。本文把批次 D 产出的三类上机需求集中到一处：批评者点名的 34 条必做、18 个区域各自列的 150 项现场检查项、128 条测试缺口。合并进 [T032](../../roadmap.md) 时应与旧树待现场项一并去重排期。

使用方式：第一节是「不做就不能签收」的硬清单，按目标环境分组；第二节是区域级的全量项，粒度更细、可挑选；第三节是测试缺口，它不属于上机内容，而是各修补任务要一起补的用例清单，写在这里是为了让修补任务和上机日的分工一眼看清。

**先做 dev-box 的那一批**。批评者明确指出：150 项里有 35 项自己标了 dev-box，另有十余项标成 real-model 但用合成 transcript 在开发机就能出图，这些不该占用上机日。

## 一、批评者点名的上机必做（34 条）

原文见 [cross-and-critic.md](cross-and-critic.md)「批次 E 上机必做」。这里按目标环境重排，方括号前缀是原文自带的分组标记。

### Windows（9 条）

1. W1/W2：P1-8 的六项工具探针在当前 HEAD 上重采两遍，bundled-node 载体与 electron-utility 载体各一遍，trace 里的 stamp 必须带新的 runtime_p6_hardening_v1 分代号，用来替换那份落后 150 个提交的 test12-reverify.md。
2. W3（high）：验 windows-01，用 Git Bash 的 /c/Users/<user>/.ssh/id_rsa 盘符写法请求写入，确认不可覆盖的 deny 是否被绕过——这是本轮两条 high 级越权中唯一必须在 Windows 上落地的一条。
3. W4/W5/W15：验 windows-02 与旧树 P1-0/P1-3 的命令树清理，量一条正常 bash 的 taskkill 耗时，再人为让 taskkill 缺失或变慢，看命令能否仍成功回报。
4. W7：验 windows-03，起一个 stdio 型 MCP 服务器（npx / uvx / npm 都是 .cmd 而链路上两次 spawn 都是 shell:false），确认在 Windows 上到底能不能起来。
5. W8/W11/W10：CRLF 工作区下 edit 的精确匹配行为（windows-05）、原生工具 OEM 代码页输出进模型上下文的样子（windows-09）、reg query 输出按 utf8 解码在中文 Windows 上是否损坏含非 ASCII 的 PATH 条目（windows-07）——三条都是字符编码，一次会话里连着做。
6. W12/W13/W14：长路径 MAX_PATH、保留设备名与尾随点、映射网络盘或 junction 工作区下的 glob 与 grep——全仓零处理零用例，这三条是纯探索，做完至少要能回答「有没有」。
7. W16 与随包 Node 缺失路径：删掉 resources/node-runtime/node.exe 起一次，看用户看到什么文案；顺带确认 AICLIENT_NODE24_PATH 是否仍被宣传但实际无效（main-host-aux 指出 NodeRuntimeResolver 整模块零生产调用方，不要在它身上花时间）。
8. Windows 侧终端：默认 shell 返回 pwsh.exe 时 PtyManager 的 spawn 失败回退只有 Unix 分支（terminal-09）、以及 TUI 启动计划同时写 PATH 与 Path 两个键后 ConPTY 取哪个。
9. 强杀与孤儿：主进程退出后 node.exe worker 是否残留、worker 被强杀后它拉起的 MCP 与孙进程是否回收、索引写入被杀软或搜索索引器占用时 rename 覆盖失败的表现。

### 加密文件系统 / TSD（7 条）

1. E1/E5：先确认随包 node.exe 与系统 Git Bash 在当前这台机器、当前驱动版本上仍在白名单内——2026-09-09 那份记录是换机器就作废的前提，后面的 E2/E3/R2/R3 全都建立在它之上，必须第一项做。
2. E2/E3 + R2/R3 合并执行：write 后 read 的明文往返、edit 的读-改-写不破坏加密、GUI bash 工具与随包 node 读同一受策略文件、随包 node 改名副本再读一次。encryption-special.md 自己留的两条未决项与这组是同一件事，不要跑两遍。
3. 写锁在加密目录下的取/读/接管：先看 .writer.lock 在盘上是不是 TSD 容器；若是，一次陈旧接管要读两次锁、最坏 60 秒，正好等于 Main 的 bootstrap 预算——这条决定 concurrency-01/02 的现场严重度。
4. 导入链在加密机上的闭环：Claude 导入走完整条链路，Codex 导入重点看 ~/.codex 是否受策略覆盖（CodexSessionScanner 完全没有 TSD 分支，若受覆盖会读到密文并在 JSON.parse 处失败）。
5. E4/E6：一个 chmod 000 或读不了的文件是否打垮整次 grep（tsd-02）；首 16 字节恰为 TSD 魔数的明文文件在所有载体上都读不出来且无任何出口（tsd-07）——后者在加密机上更容易撞到真实样本。
6. F3 根因拍板与 GUI Git 输出丢失：这是本轮唯一被判 incomplete 的现场节点（field-nodes），也是 P4-6 两个区域判定打架的一半，上机日必须给出一个确定结论。
7. 加密机上的 TUI-1 闸门与 H/20 真机一圈：piTuiSession 的 readSessionHead 走裸 node:fs，不经 TSD 回落，受策略时会失败或读到密文、两种情况都 fail-open 放行。

### Electron utility 载体（5 条）

1. U1：让 p1-utility-worker.ts 探针走产品路径推导而不是 explicit node.source，重跑并把结果与当前 HEAD 的版本戳绑定——这是 09-14 缺口 13 的收口判据，本轮没做。
2. U2 + main-host-04 + tsd-03 三家合一：在真实 Electron utility worker 里让一次回合往 stdout 写 ≥ 1 MiB，看 worker 还能不能应答只读 RPC、Main 的 RSS 是否线性增长——三个区域独立提出同一条，只做一次。
3. U3/U4：两种载体跑同一组报文，比对形状与退出码/信号语义；特别核对「值为 undefined 的键在 JSON 下消失、在结构化克隆下保留」这类差异有没有消费者受影响。
4. utility 通道三个产品功能（代码评审 / 分支命名 / 提交信息）在 utility 载体上端到端各跑一次，量冷启动耗时（utility-01 说它用的是 10 秒热请求预算，而会话路径为同一件事配了 60 秒），并看超时时用户看到什么（utility-06 说已流式显示几分钟的评审正文会被一行错误顶掉）。
5. worker stderr 在 utility 载体下的组装与 50 行上限、以及落进 main.log 的两路是否脱敏（main-aux-06 指出只有走 IPC 那一路脱敏）。

### 真实模型回合（7 条）

1. PERM-1 探针复跑（T001 之后）——注意 field-nodes 的提醒：探针选择器写死中文正则，T023 之后标签走词典，英文界面或 locale 非 zh 的机器上会匹配不到，跑之前先确认上机机器的语言设置。
2. 权限卡倒计时走到底的超时拒绝：目前只有单测覆盖，是 P1-6 明确留下的唯一现场缺口。
3. F5 / GUI C/8 问答卡真机一圈，含并发问答（chat-event-01 判第二个问答会挤掉第一个并让那一回合永久挂起）——这是 T032 括号枚举漏掉、field-06 点名的那批。
4. smoke 的 --model 在线 lane 跑一次，确认 P0-6 判定依赖的「真实端点关闭风险」结论在当前 HEAD 仍成立，同时存档 report.outcomes 与新的 runs.jsonl。
5. 导入会话的续聊（H/21 C6）、Codex 旧格式裸行导入（H/21 C5）、GUI 重命名后在 pi CLI 侧看到的标题（session-index-07）——三条互通类，一次导入后连着做。
6. ah-lib-01/02 的取证：故意触发一次 provider 错误（错 key 或错 endpoint），看错误正文有没有原样落进会话文件，以及裸密钥形状是否被脱敏漏过。
7. GUI F/13 真实 busy 会话下的目录行变更量数字、F4 重试在加密机的复测——两条都属旧树遗留且证据已过期 89~94 个提交。

### 开发机：不该等上机（4 条）

这四条不需要 Windows、不需要加密盘、不需要打包态，拖到上机日纯属浪费当天的时间窗。

1. 渲染层词汇表那一组（native grep/glob 的命中列表、中文界面的工具行参数文案、技能审批卡 Skill 标签、MCP 行三处名字一致、审批后 Run 面板状态、上下文徽标在委派后是否还在、审批行的中文用词、回放后权限卡与问答卡是否还在）：这 13 项在检查单里被标成 real-model，但按团队既有的 CDP 点验配方，合成 transcript 灌进 store 就能出图，完全不需要真实回合，也不需要 Windows 或加密机。
2. smoke offline lane（node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline）与 cordis spike 复跑、plugin_graph_incomplete 失败路径补测试——三项检查单自己就标了 dev-box，本轮只是因为「不跑任何执行」的规则才没做，批次 E 一开始就该跑掉。
3. session-index 的五项（fork 一个 unbound 会话、之后重启、索引损坏后的第一次写、fork 窗口内强杀的残留文件、临时工作区删除后的会话去向）与 main-host-aux 的 POSIX 半边（归档正在跑回合的临时对话、临时根改设置后的旧根、兼容根子代理定义的删除语义）：都只需要一台能起 Electron 的 Linux 机器。
4. capacity 的三项（附件顶满会话文件后打不开的端到端、Main IPC 层缺失附件校验的直接验证、两个 node 进程并发轮转同一 runs.jsonl）：不需要模型、不需要平台，是纯本地复现。

### 开发机：已可结案与约束提醒（2 条）

1. （已可结案）baseline-01 的「CI 在日常 push/PR 上不触发任何测试 job」不必再验——我读 .github/workflows/build.yml 的 on: 字段已确认只有 push tags 'v*' 与 workflow_dispatch，这项从检查单里划掉即可；剩下的只是决策：要不要给日常提交加测试 job。
2. （约束提醒）concurrency 的「三个会话并发时的真实进程数与内存」被标成 utility 目标环境，实际关键约束是机器规格——开发机 2 核 / 3.3 GB 跑不出有意义的数字，这项要么上机日做，要么换一台内存充裕的机器，不要在开发机上得出假结论。

## 二、18 个区域列出的检查项（150 项）

按 target 分组。150 项两两不重复（本轮核对过，无同名项），所以没有合并，来源区域逐项保留。项数分布：windows 36、real-model 38、dev-box 35、encrypted 22、utility 19。

注意批评者的提醒：标成 real-model 的 38 项里有十余项其实用合成 transcript 在开发机就能出图，不必占用上机日；排期时逐项复核一遍再决定。

### Windows 加密机（上机日）（36 项）

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

### 加密文件系统 / TSD（上机日，与 Windows 同机）（22 项）

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

### Electron utility 载体（打包态，上机日）（19 项）

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

### 真实模型回合（需要真 provider 与真 key）（38 项）

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

### 开发机（上机前就能做完）（35 项）

| # | 项 | 判据 | 取证方式 | 来源区域 |
|---|---|---|---|---|
| 1 | 归档正在跑回合的临时对话（POSIX 半边） | 回合后续的文件工具不会在已删除目录里静默失败，或至少给出与「目录没了」相关的错误 | 同上，在开发机重放并记录工具失败文案 | `main-host-aux` |
| 2 | 临时根改设置后的旧根 | 旧根下的 unbound-sessions/ 在退出与重启后是否仍在；重开旧对话时侧栏是否仍标为临时会话 | 改设置前后各记一次两个根的目录列表与 session-index.json 的 unbound 位 | `main-host-aux` |
| 3 | 兼容根子代理定义的删除语义 | 在 ~/.agents/subagents 放一份定义并编辑后删除，该行应消失而不是回到旧内容 | 设置页子代理列表操作前后各查看一次两个目录的文件 | `main-host-aux` |
| 4 | 协议版本不匹配的可诊断性 | 故意让打包产物里的 worker.js 与 Main 的 WORKER_RPC_PROTOCOL_VERSION 不一致，检查日志里是否出现任何指向「协议版本」的字样 | 在 dev 环境改一处常量制造不匹配，起会话并收集 Main 的 console 与 electron-log 输出；当前预期是只有 worker.bootstrap timed out，无任何协议线索（main-host-08） | `main-host` |
| 5 | fork 一个未绑定（scratch）会话 | 对话框是否弹出「Fork was created, but its workspace could not be materialized in this window」；此时 session-index.json 里是否已有该 fork 行且不含 unbound | 起 Electron，新建不选文件夹的聊天并发一轮，点 Branches → Fork；随后 cat userData 下的 session-index.json | `session-index` |
| 6 | 上一条之后重启应用 | 该 fork 是否从侧栏彻底消失，而索引行与 JSONL 仍在磁盘上 | 退出应用后重开，比对侧栏与 session-index.json | `session-index` |
| 7 | 索引损坏后的第一次写 | 旧行是否被覆盖丢失；坏文件是否还留在磁盘上 | 退出应用，把 session-index.json 截断成半行 JSON，重开应用（侧栏应为空），新建聊天发一句话，再看文件内容 | `session-index` |
| 8 | fork 窗口内强杀留下的残留文件 | 会话目录里是否多出无主 <uuid>.jsonl，pi CLI 是否把它列成一个会话 | 点 Fork 后在新 worker 起来之前强杀应用，随后 ls 会话目录并开 pi CLI 列会话 | `session-index` |
| 9 | 临时工作区删除后的会话去向 | 用侧栏删除一个临时工作区目录后，其下的聊天是否从侧栏静默消失，而索引行仍在 | 起 Electron 走 temp:workspace:remove 那条链，之后刷新侧栏并比对 session-index.json | `session-index` |
| 10 | 子目录不可读时 Codex 源的表现（import-up-01） | 在 ~/.codex/sessions/<某一天>/ 上置 mode 000 后，导入面板里 Codex 项目仍能列出其它日期的会话 | 改权限 → 打开导入面板截图 → 恢复权限 | `import-upstream` |
| 11 | 超 32 MiB 会话的导入错误形态（import-up-04） | 用户看到的失败文案可理解；失败后 sessions/.aiclient-import-staging/ 下无残留、manifest 无 cleanupPending 记录 | 造一份 35 MiB 左右的 Claude JSONL，走 GUI 导入，记录报错文本并检查暂存目录 | `import-upstream` |
| 12 | Codex 旧格式（裸行）真机导入（H/21 C5 的现场半边） | 真实旧格式 rollout 能被列出并导入成功 | 需要一台还留着旧格式 rollout 的机器，或从 Codex 历史版本导出一份；H/21 当时「本机 10 个 rollout 全是新格式」 | `import-upstream` |
| 13 | 大目录下导入的主进程占用（import-up-03） | 300 份以上 rollout 时，打开导入面板到列表渲染的耗时，以及批量导入 40 条期间界面是否可交互 | 起 Electron，用 CDP 记录面板打开到列表渲染的时间；批量导入期间观察界面响应 | `import-upstream` |
| 14 | TUI 模式下切换会话（terminal-03） | 切到另一个聊天后终端画面是否仍是上一个聊天的 pi 会话；在终端里敲一句话后它落进哪个 JSONL | 同仓库两个聊天，TUI 模式下点侧栏切换，然后 grep 两个会话文件 | `terminal-tui` |
| 15 | 终端复活丢 sessionFile（terminal-04） | 让 pi 快速失败后，终端是否变成一个空白新会话（第二次 spawn 的 argv 里没有 --session） | 临时改坏模型配置起 TUI，看 Main 日志与 ps 里的 --session 参数 | `terminal-tui` |
| 16 | 两个窗口对同一会话开终端 | 是否能出现两个 pi --session <同一文件> 进程 | 开第二个窗口选中同一聊天进 TUI，ps aux 过滤 --session | `terminal-tui` |
| 17 | 会话文件损坏 / 缺失 / 换工作区三种恢复失败的界面文案（ah-lib-03） | 分别看到「Session history is damaged（不可重试）」「History not found（此对话无法继续）」「Session belongs to another workspace」，而不是三次都看到「Failed to read history（可以继续发送）」 | 起 Electron，造三个会话：① 中段插 65 行坏 JSON（超过 MAX_SKIPPED_ROWS 触发拒绝）② 删掉会话文件但保留索引行 ③ 把工作区路径改掉；逐一恢复并截图卡片 | `agent-host-lib` |
| 18 | 宿主诊断横幅 | 人为让 Node 24 解析失败时，用户能否看到可操作的提示 | 清掉 AICLIENT_NODE24_PATH 并让默认 node 不可用后起应用 | `chat-event-vocab` |
| 19 | offline lane 现行可跑：执行 node --experimental-strip-types src/runtime/smoke/runOnce.ts --offline | 退出码 0，六项断言全部 PASS，新 trace 的 version_stamp.backend==='native'、config_version==='runtime_p6_hardening_v1' | 实际执行命令，存档 stdout 与新生成的 runs.jsonl | `smoke-p0-6` |
| 20 | 新证据同时存档 report.outcomes（逐条断言名与 pass/fail）与 runs.jsonl | 新存档文件里能直接读到六项断言各自的通过状态，而不是只有裸 trace | 执行时加 --json，把 stdout 与 trace 一起写入 evidence 目录 | `smoke-p0-6` |
| 21 | 为 plugin_graph_incomplete 失败路径补测试后确认通过 | 新增 vitest 用例断言 code:'plugin_graph_incomplete' 且缺失服务名单正确，不影响既有用例 | 运行 pnpm typecheck:runtime 与对应 vitest 文件 | `cordis-spike-d1` |
| 22 | cordis 版本升级时重跑 p0-cordis-semantics.ts 确认三条语义不变 | 三行 console.log 布尔值（deferred activation / fiber settle / dispose retraction）与升级前一致 | 手动执行 node --experimental-strip-types src/runtime/spikes/p0-cordis-semantics.ts，比对升级前后输出 | `cordis-spike-d1` |
| 23 | CI 在日常 push/PR 上确实不触发任何测试 job | 向非 tag 分支推送一次提交或开一个测试 PR，GitHub Actions 页面除 code-review.yml/claude.yml 外没有任何 workflow run 被创建 | 用有仓库权限的账号实际推送/开 PR 并观察 Actions 列表；或 gh run list --branch <分支> | `baseline-comparability` |
| 24 | F4 的 GUI 观感 | 重试期间时间线出现重试提示；预算耗尽后错误卡文案完整可读且带网关原文 | 起 Electron 加假网关，走真实会话触发并截图 | `field-nodes` |
| 25 | F7a/F7c 视觉口径 | 权限卡与问答卡的尺寸、字号、间距按 docs/design-system.md 的 Token 分档复核并留截图 | 真实回合触发两张卡后逐项比对 | `field-nodes` |
| 26 | F2-b 正常退出时的 scratch 清理 | 从界面正常退出（非 kill）后，本次的 scratch 目录即被删；与 kill 那次的差异有记录 | 三时点各读一次 session-index.json 与目录，沿用 scripts/run-f2b-probe.mjs 的两侧读法 | `field-nodes` |
| 27 | F2-b 临时行第三个「删除」按钮 | temp:workspace:remove 只删临时基目录的直接子目录，删不到 unbound-sessions/ 下的 scratch 目录 | 真机点按，两侧读目录 | `field-nodes` |
| 28 | 临时会话索引 title 为空的复现与定性 | 发完第一句后索引行 title 非空且与侧栏显示一致 | 直接读 session-index.json，不看界面 | `field-nodes` |
| 29 | GUI A/10 TEMP /new 矩阵 | 从普通目录、TEMP 会话、无工作区三种起点各开 /new，cwd 继承结果逐格记录 | 真机点按，逐格记 | `field-nodes` |
| 30 | TUI-1 / H/20 真机一圈 | GUI 跑一回合 → pi --session 打开 → 在 TUI 里续聊 → 回 GUI 接得上；右上角 GUI/TUI 开关那一下也点一次 | 内嵌终端真开，前后各读一次会话文件并比对头一行与条目链 | `field-nodes` |
| 31 | H/19 验证案例 7 | GUI 与内嵌 TUI 都能列出迁移/导入后的历史会话；在 TUI 里续聊一轮再回 GUI，历史接得上 | 真实 Electron + 内嵌 PTY，走完整一圈 | `h-nodes` |
| 32 | H/21 内嵌 TUI 模型缺失覆盖层 | 打开一条模型已被迁移覆盖的旧会话，TUI 侧同样给出可读的「模型缺失」提示而不是裸错误 | 真实 Electron，切到内嵌 TUI 视图 | `h-nodes` |
| 33 | 附件顶满会话文件后打不开的端到端复现 | 连续发送 2~3 条各含多张图片附件的消息后，会话文件字节数是否逼近/超过 32 MiB；重开该会话是否抛 io_limit | 用真实 Electron GUI 走一遍 Composer 发送流程观察结果；或在 runtime 包内写构造用例模拟同等字节量 | `capacity-leftovers` |
| 34 | Main IPC 层缺失附件校验的直接验证 | 绕开 Composer 直接向 CHAT_SEND 传超限 attachments payload，确认 Main 不拒绝、请求原样送达 worker | 起 Electron 应用，在渲染层 devtools 控制台直接调用 window.api 发送接口并传构造好的超限 payload | `capacity-leftovers` |
| 35 | 多进程并发轮转同一 runs.jsonl | 两个独立 worker 进程共享同一 AICLIENT_RUNTIME_TRACE_DIR 并几乎同时 finish() 时，是否出现代际丢失或写入交织/损坏 | 用两个 Node 子进程直接跑 runtime 包 bootstrap（不需要 Electron），共享同一 traceDir | `capacity-leftovers` |

## 三、测试缺口（128 条，按区域）

这不是上机内容，是修补任务的用例清单：每条修补任务落地时，对应区域的这几行应当变成真实用例。放在检查单里是为了让「上机验」和「写用例验」两件事不互相顶替——Linux 与 CI 的绿色不得代签现场，反过来现场跑通也不免掉用例。

### main-host-aux（T029）— 10 条

Main 侧宿主辅助模块（Node 解析、临时工作区、stderr、布局）。

1. NodeRuntimeResolver 的 nvm / fnm / volta 分支（POSIX 与 win32 两种布局）零用例；现有四条里两条是「不成立就 return」的软退（__tests__/NodeRuntimeResolver.test.ts:27-30、:66-72），另一条直接读开发机真实环境（:26），不隔离
2. ScratchWorkspaceService 的 [release-blocker] 越界用例只试了不含 `..` 的样本（:199-211），没有任何路径穿越形态
3. 没有用例覆盖「运行中改临时根设置」：改根后的 isScratchPath、wipeAll 覆盖面、adopt 是否还认得旧路径全无断言
4. 没有用例把 release() 与 worker 生命周期放在一起断言顺序（归档时 worker 仍活着的情形）
5. hostStderr 缺「同一逻辑行被切成 N 段后共产生多少行」与「巨量无换行输出把 50 行窗口挤空」的用例
6. 没有用例断言进 main.log 的 stderr 也被脱敏（现有断言只覆盖 IPC 那一路）
7. TempWorkspaceService 没有独立测试文件；isTempWorkspacePath 的尾部分隔符 / 分隔符方向形态无覆盖
8. subagentCatalog 的兼容根 ~/.agents/subagents 被测试显式指空（:36-38），影子 / 删除 / 跨根改名三种行为零覆盖
9. piCliLayout.ts 无测试（仅在 piTuiHandover.test.ts:43 被整体替身掉），而它是打包态与开发态布局分歧的单点
10. retiredSurfaceAbsence.test.ts 只扫 src 与 scripts 两个根下的代码文件后缀，仓库根目录配置文件与 .json 固定件不在扫描范围

### main-host（T029）— 7 条

Main 侧宿主（WorkerManager 轴）。

1. 关机时导入槽拆除失败：没有用例证明会话池仍会被拆。现有两条导入用例只覆盖「正常关机拆一次」（WorkerManager.test.ts:1849）与「dispose + 强杀都失败时保留所有权」（:1890），main-host-02 直接来自这个缺口。
2. dispose 排空窗口的事件：没有任何用例让替身 worker 在收到 worker.dispose 之后、退出之前发一条 permission.resolved 并断言 Main 是否转发；main-host-03 因此在两侧都测不出来。
3. utilityProcess 的 stdout 在测试替身里根本不存在（WorkerTransport.test.ts:15-20 的 FakeUtilityProcess 只有 stderr），而 child_process 那条用例的假 worker 恰恰写了 stdout（:40）——两种载体的测试覆盖不对称。
4. setPermissionTier 的失败语义无用例：setPermissions 有「worker 拒绝时不改存档」（:1428），tier 侧没有对应的一条；「返回值不校验」也没有被任何断言挡住。
5. getSlashCommands 的跨工作区回退有用例但钉的是当前（有问题的）行为（:2160），没有一条断言「回退来源与目标会话的 cwd 一致」。
6. 并发 RPC 的队列等待无用例：Main 侧每个请求的超时钟从发出即开始，worker 侧是单链串行，「排在慢请求后面的请求把预算耗在排队上」没有被任何测试表达（例如 reload 占链 20 秒时发一条 worker.commands）。
7. 诊断通道只有 WorkerSlot 单测覆盖，没有一条用例断言生产链路会把诊断记下来，所以 main-host-08 这类断线永远是绿的。

### utility-chain（T029）— 7 条

utility 通道的产品消费者（代码评审 / 分支名 / 提交信息）。

1. src/main/services/ai/ 四个模块零测试：stripCodeFence 正则、提交信息模板的单次替换防注入、分支名输出处理、评审的 git 前置与「无变更」短路，全部无用例
2. src/renderer/stores/codeReview.ts 零测试：reviewId 过滤、cleanupFn 生命周期、exit 事件与 complete 状态的先后判定都没有用例
3. PiUtilityService.test.ts 缺四类用例：超时分支（record.timedOut → 'timeout' 文案）、崩溃分支（handleLifecycle）、forceKillAllNow、重复 operationId
4. 没有任何用例断言 utility.start 的请求预算与热请求预算不同（utility-01 的回归守卫）
5. 没有用例覆盖「超时值越界」这条端到端路径（utility-02）：Main 放行、worker 载荷守卫判假
6. 没有渲染层用例断言「设置页显示的模型 = 随请求发出的模型」（utility-03）
7. 从 piUtilityService.complete 到 NativeUtilityRuntime 之间没有任何一处被同一个测试同时覆盖：workerEndToEnd.test.ts:119-121 显式拒绝提供 utility runtime，piWorkerRpcServer.test.ts:378 用的是替身

### session-index（T029）— 7 条

SessionIndexService 与 fork 生命周期。

1. SessionIndexService.test.ts:382-389 的损坏用例只断言 list() 返回 []，不断言坏文件是否被保留，把 session-index-01 的破坏性行为固化成了期望值；缺一条「损坏后第一次 recordCreated 不得让旧行消失」的用例
2. 没有任何用例覆盖 flush 失败后不回滚的三个方法（setArchived / recordCreated / applyRuntimeEvent）；现有回滚用例（:59 binding 回滚）只覆盖了写法正确的那一半
3. WorkerManager.test.ts:1364 的 [release-blocker] fork 用例只断言 createSlot 收到 unbound: true，没有断言 createForked 收到的索引行——session-index-02 正是从这个缝里漏过去的
4. 没有任何用例覆盖「fork 一个 unbound 会话后渲染层能否打开它」，materializeIndexedPiChatSession 返回 false 的分支在 fork 场景下无测试
5. NativeSessionIndexAdapter.test.ts 的 7 个用例（含真实 runtime 与真实索引）全部作用在零生产引用的模块上，是纯假覆盖；P3-5 验收清单里有三项签收只依赖它
6. worker.fork.discard 在 Main 崩溃后的残留清理没有任何用例（实现本身也不存在）
7. mergeSessionIndex 的 orphaned 分支没有任何用例断言调用方该怎么处理它

### import-upstream（T029）— 10 条

会话导入的上游六模块。

1. 没有「真实转写结果 → native 写入器 → 读回来」的端到端用例（import-up-07）；这正是批评者缺口 4 点名要确认的那件事，目前只有人工 git show 比对，没有自动化守护
2. CodexSessionScanner 的目录级容错无用例：现有 CodexSessionScanner.test.ts:90 只覆盖「根目录缺失 → 空」与「根目录其它错误 → 传播」，没有「子目录 EACCES」这一档；inspectedFiles > 10_000 这条上限一条用例都没有
3. isSyntheticCodexUserText 没有反向用例：只证明了合成注入被丢，没有「以 < 开头的真实用户消息必须保留」这一条
4. 上游产出与 isImportedConversation 之间没有契约用例：没有任何测试把适配器的输出直接喂给 isWorkerImportConversationPayload，所以 import-up-05 那类越界不会被现有测试捕获
5. 32 MiB 会话预算在导入路径上没有用例：既没有「超预算导入被干净拒绝」的用例，也没有「预算内最大导入能成功」的边界用例
6. 脱敏只有一条「工具输入走了脱敏」的用例（CodexRollout.test.ts:52），没有按密钥形态逐条钉的表格式用例；也没有任何用例断言 user / assistant 正文是否脱敏，即当前行为未被固定，改哪边都不会有测试反对
7. Codex reasoning 的 content 分支无用例（import-up-08）
8. Claude 的 summary 行处理无用例（import-up-09）：被丢弃这件事既没有被断言也没有被记录
9. 非 UTF-8 / 跨块切断的多字节字符无用例：CodexSessionScanner 用整份 buffer 一次 toString('utf8')，ClaudeSourceAdapter 的非加密路径按块 toString('utf8') 拼接（ClaudeSourceAdapter.ts:245），加密路径又是整份一次性解码——三条路行为不同，没有任何一条有用例
10. ClaudeSessionScanner.readTailLines 的分块解码同样按块 toString('utf-8')（:384），无用例

### terminal-tui（T029）— 7 条

终端 / TUI 侧（H/20 互通的另一半）。

1. PiTuiPty.test.ts 的 FakePty.kill() 永远成功且不触发 exit 监听，所以「kill 抛错」「kill 之后进程仍活」「dispose 路径不会触发 onExit」三件事一条用例都没有——terminal-01 正踩在这个盲区上
2. handOverFromTui 的索引读失败分支（terminal-02）无用例：piTuiHandover.test.ts 与 chatPiWorkerRouting.test.ts 都以 sessionIndexService.get 成功为前提
3. 没有任何用例覆盖「TUI 模式下切换活跃会话」或「同一会话开两个终端」；PiTuiPty.test.ts:191 只验证 disposeSession 精确命中，没有验证同一 JSONL 不该有两个终端
4. useXterm 的复活 open（terminal-04）无用例；渲染层这块只有 tuiHandoverWiring.test.ts 的源码文本扫描，扫不到依赖数组与参数缺失
5. ShellDetector.test.ts 只有两条用例且全是 Windows PowerShell 回退；inferExecArgs、自定义 shell、Unix 分支、resolveShellForCommand 一条没有
6. PtyManager 没有任何单元测试文件：spawn 失败回退、destroyAndWait 超时、destroyByWorkdir 的路径归一化都无回归保护
7. 没有 Windows 形态的 resolvePiCliLaunchPlan 用例覆盖 PATH / Path 双键合并与 node.exe 拼接（PiTuiPty.ts:126-136）

### agent-host-lib（T029）— 7 条

src/agent-host 未读模块与 runtime → agent-host 依赖方向。

1. piSessionTimeline：isInternalMessage 跳过（T005 重开半边）零用例；attachmentMetadata（图片附件元数据）零用例；boundedText 的 4000/2000 双档截断无断言——重开会话会把长工具输出截到 4000 字符、与直播不一致，这条取舍也没有文档
2. piSessionTree：forkable:true 零用例；非 message 条目类型（compaction / model_change / thinking_level_change / session_info / label）的 preview 分支零用例；type='custom'（含遗留导入溯源条目）在树里既无 preview 也无用例
3. piSessionTree 的环/孤儿兜底（piSessionTree.ts:203-215）零覆盖——piSessionTree.test.ts:21 的 orphan 夹具走的是「parentId 指向不存在的 id → 进 roots」的正常分支，不是兜底分支
4. 脱敏：没有任何一条用例断言「会话文件里不含凭据」。stderrRedaction.test.ts 覆盖很密但只覆盖它自己；providerErrors 一侧只有 providerRetry.test.ts 的分类用例，没有脱敏断言
5. 依赖边界：没有任何用例断言 src/runtime 对 src/agent-host 的 import 集合；hostBoundary.test.ts 的 D11 守卫扫不到这四个跨边模块
6. userResourcePaths.ts 无测试文件（它也确实不该有——应当删除）
7. historyError 的码表用例（historyError.test.ts:237-249）全部用 WORKER_SESSION_* 旧词汇构造输入，等于把已经漂移的映射钉死了；没有一条用 native 实际抛的码（session_invalid / session_cwd_mismatch / ENOENT）

### chat-tool-vocab（T029）— 6 条

渲染层工具词汇表全量比对。

1. 没有「注册表 × 查表点」的穷尽性用例（chat-tool-08）；runtimeToolVocabulary.test.ts 是点名式的，新增工具漏补不会变红
2. 命中列表在 native 词汇上零覆盖：toolCard.test.ts:631 只断言大写 Grep/Glob 的 hitSource
3. 审批卡没有「只带路径的门」的用例；questionCardModel.test.ts 覆盖的是 exec / file_change 两种有 detail 的形态
4. arg 文案与 contentLabel 不在任何 i18n 守卫的扫描范围里：toolVocabulary.test.ts 只查动词表，i18nCoverage.test.ts 只查字面量 t('…')
5. 子代理面板与 Run 面板的表头用例用的是 Claude 期名字（subagentActivityModel.test.ts:176/416 的 'Bash' / 'Read'），与生产者真实发出的小写名 / mcp__ 名不一致，掩盖了 chat-tool-05
6. 没有用例覆盖「导入的 Claude 会话与 native 会话在同一窗口里工具行表现一致」——这是 chat-tool-01 这类「主路径弱于旧路径」缺陷的唯一自然捕捉点

### chat-event-vocab（T029）— 8 条

渲染层事件词汇表与状态机全量比对。

1. golden 录制缺六类事件：tool.updated、session.failed、session.stopped、session.stderr、custom.message / custom.entry、preview.requested 在五份录制里一次都没出现；而 P4-5 的「GUI 无回归」签收正是建立在这套录制上，缺席的这几类恰好包含两类终态与唯一的诊断流
2. 没有一条用例断言审批 / 问答结算后的会话状态：全仓对 waiting_permission / waiting_question 的断言都只覆盖「进入」，没有覆盖「离开」，chat-event-02 因此一直绿着
3. 没有并发问答用例：chatSessionsQuestion.test.ts 只测单问单答，第二条 question.requested 覆盖第一条这件事没有任何反向断言
4. 没有断言 usage.updated 的 context 在委派折算后仍存在：nativeGuiSubagentEventStream.json 里已经录到一条无 context 的 payload，但回放测试只看 lane 重建，不看上下文占用
5. permission.activity 的 delegationId / agentName 没有渲染层用例（自然如此——没人渲染它），permissionActivityRow.test.ts 只覆盖 forwarded 这条无生产者的分支
6. 回放与实时的 block 类型差异没有对照用例：现有 nativeStreamReplay.test.ts 只跑实时流，缺「同一段会话先实时、再从 history 重建、比较两次 block 集合」这一形态
7. T034 的 recovery rider 没有任何界面侧断言（落地记录已声明无 UI 组件，此处仅记账）
8. eventRing 的 HIGH_FREQUENCY_PREFIXES 硬编码三个事件类型名，与实际事件词汇没有一致性用例；formatRuntimeEvent 改格式或新增高频类型时折叠会静默失效

### smoke-p0-6（T030）— 2 条

P0-6 冒烟通道（runOnce / assertions / cases）。

1. evaluateCase 的六个断言分支（must_succeed / must_call_tools / must_not_call_tools 含 '*' 特例 / turns / min_output_chars / exact_output / max_latency_ms）没有 vitest/node --test 级别的单元测试覆盖边界情况（例如恰好调用一次工具时 must_not_call_tools:["*"] 是否正确判失败、exact_output 前导空白的 trim 行为），目前只靠人读源码确认正确性。
2. p1-host-tools.ts 的手写断言表没有失败路径用例（例如让 bash 返回非零退出码时断言是否正确判 false），只有脚本手动跑一次的隐式覆盖。

### cordis-spike-d1（T030）— 2 条

D1 Cordis 选型 spike 与 core-host-19。

1. plugin_graph_incomplete 失败兜底路径无测试覆盖（见 spike-02）
2. spike 本身不接入 CI（tsconfig 排除、无 npm script），cordis 版本升级不会自动触发重跑，它验证的三条语义目前完全靠人工记忆维护

### baseline-comparability（T030）— 4 条

可比性与单测门禁（P2-0 / P2-5 / P2-6 / P1-7）。

1. scripts/runtime-baseline/preflight.mjs 无离线形态，run-native.mjs --dry-run 不覆盖它；批次 C 已记录为接受不做，本轮复核现状未变。
2. scripts/runtime-baseline/collect.mjs 的主路径（多次 --case 部分重跑后挑选首次完整成功记录并汇总）从未在真实网关下端到端跑通过一次，baseline-04 是这个盲区里能靠静态阅读定位的一个具体后果。
3. scripts/__tests__/runtime-baseline-archive.test.mjs 硬编码 evidence/p2-5 下两份真实归档路径作为测试夹具，证据目录搬家会致该用例变红；批次 C 已记录，本轮确认现状未变。
4. metrics.test.mjs 不在 pnpm test 范围内（见 baseline-02），D9 公式目前没有任何自动化回归覆盖。

### field-nodes（T030）— 6 条

现场口径复核（P4-6 与 F1～F7）。

1. 正常退出（而非 kill）时的 scratch 退出清理没有端到端覆盖：ScratchWorkspaceService.test.ts 直接调 wipeAll()，agentHostCleanup.test.ts 只验 cleanupWorkerManager 内部顺序（先 dispose worker 再 wipe），「用户从界面正常退出 → before-quit → cleanupWorkerManager → 目录真的没了」这条链既无用例也无现场记录——F2-b 那一轮用 pkill 停应用，只能证明被杀掉时清理不跑。
2. 临时会话索引 title 为空这条现场观察既无用例也无任务：SessionIndexService.ts:108 建行时默认 ''，自动标题走渲染层 applyAutoSessionTitle → chat:renameSession 这条独立路径，没有任何测试断言「临时会话发完第一句后索引行有标题」。
3. 权限卡倒计时走到底自动拒绝只有单测：perm1 记录自陈「本轮在倒计时走完前就点了允许」，真实回合里 119 秒到点的那条路没有现场证据。
4. F4 的真实 HTTP 四条路没有进 CI：providerRetry.test.ts 钉的是分类与阶梯，真实 HTTP 那趟是一次性探针 scripts/run-f4-retry-probe.mjs，其后 plugins/agent-loop/ 改过 11 次，没有任何自动化回归会发现探针结论失效。
5. GUI F/13「真实 busy 会话下数字出现并刷新」无覆盖：轮询条件由 folderDiffStats.test.ts 覆盖，但从 busy 会话到侧栏出现 +N -M 的那一段只在开发机手工驱动过一次，且当时工作区只有未跟踪文件，量到的是正确的 null。
6. F3 的加密机行为没有任何可在普通机器上跑的替身：GitService 的「输出丢失」兜底有 Q7 用例，但「Main 派生 git 拿到空 stdout」这一形态没有被 mock 成用例，导致这条路只能靠上机。

### h-nodes（T030）— 4 条

H/17、H/19、H/21 与 P5-2-0。

1. H/21：Codex 旧格式（裸 header、裸行）导入只有构造用例，本机没有真实旧格式样本跑过（external-agent-migration/README.md 自陈）
2. H/19：验证案例 7（GUI 与 TUI 都能列出迁移/导入后的历史对话）无自动化用例，也未在 H/20 完整闭环后真机点验
3. H/17、H/19：均无打包产物、Windows、加密文件系统上的自动化或真机用例（pnpm verify:packaged 之外）
4. H/21：内嵌 TUI 的模型缺失覆盖层（modelMissingError.ts 第四个界面）没有点验记录，只验证过 GUI 三个出口

### concurrency（T031）— 11 条

并发多会话静态面。

1. sessionWriterLock.test.ts —「抢占的放回窗口里不允许第三方建锁」：用已有 afterFirstRead 同款钩子，在 clearStale 的 rename 成功之后、writeFile 放回之前注入第三个 acquireWriterLock；断言三次调用中至多一次 fulfilled、盘上锁文件 token 等于唯一 fulfilled 的那个、目录无 .stale 残留（当前会有两个 fulfilled）
2. sessionWriterLock.test.ts —「输掉抢占的一方不得删除赢家的锁文件」：断言 clearStale 放回撞 EEXIST 之后，赢家的锁文件仍存在且内容与赢家 token 一致
3. sessionWriterLock.test.ts —「pid 被复用的陈旧锁仍可接管」：写一把 owner 为 process.pid（活着但不是我们的 worker）且 acquiredAt 为 48 小时前的锁，断言 acquireWriterLock 成功接管而非永久 session_locked（先于 concurrency-02 的修法落地会红）
4. sessionWriterLock.test.ts —「释放时发现锁已易主要能被观测到」：断言 releaseWriterLock 返回 false 的那一次，JsonlSessionStore.close() 之后 writeFailure（或新增的观测出口）非空
5. trace.test.ts —「两个 TracePlugin 实例共用一个目录轮转时不丢代」：同一 dir 建两个实例（maxFileBytes 调到几百字节），交错 finish() 触发轮转，断言 runs.1/2/3.jsonl 在存在的代号上连续无空洞，且三代文件里的 run_id 集合包含所有应保留的 run
6. trace.test.ts —「轮转期间另一实例的追加不丢行」：两个实例交错写 N 行，断言 runs*.jsonl 全部文件里 run_id 并集大小为 N（若采纳 per-pid 文件方案则改为断言两个文件各自守恒）
7. subagentCatalog.test.ts（Main）—「保存定义时并发读只会看到旧文档或新文档」：保存过程中并发跑一次目录扫描 + 解析，断言结果要么旧定义要么新定义，不会是「该定义缺席」
8. subagentDefinitions.test.ts —「重载读到缺人的目录时保留旧列表」：让 reloadCatalog 返回一份少了一个定义且带解析类诊断的目录，断言 definitions 不变且记了日志
9. WorkerManager.test.ts —「导入槽计入容量」：容量设为 1，已有一个就绪会话时发起 inspectLegacyImport，断言要么先驱逐要么拒绝，同一时刻不存在两个 fork 出来的进程（当前会有两个）
10. chatPiWorkerRouting / piTui 的 Main 侧用例 —「回合进行中 Main 拒绝 TUI 接管」：构造 activeRequestId 非空的会话，直接调 PI_TUI_OPEN 处理函数，断言抛错且 sessionGuard 未易主（当前会成功接管）
11. mcp.test.ts / exec 层 —「载体被强杀时 detached 子进程不受保护」：用一个忽略 stdin EOF 的替身服务器脚本，断言 detached 下父进程退出后替身仍存活，把 concurrency-05 的前提用替身固化，真机形态留批次 E

### windows-static（T031）— 8 条

Windows 静态面与上机检查单。

1. runPipe 的 Windows killTree（exec.ts:516-552）零用例：createTreeKiller 有 5 条注入式用例（host.test.ts:752-810），但 bash 工具实际走的是 runPipe 里的内联副本，它硬编码 process.platform 且无 spawn 注入点，无法在 Linux 上覆盖；Windows 上只有 taskkill 的 close 才能 resolve 这条关键性质没有任何断言守着
2. 没有一条 Windows 路径形态的端到端用例：shellPolicy.test.ts:459-476 用纯函数钉住了分隔符折叠（T001，做法正确），但只覆盖分隔符；MSYS 盘符记法（windows-01）、UNC 路径、盘符根、8.3 短名、保留文件名一律没有
3. pathPolicy 全仓零直接用例（在 src/runtime/__tests__ 下 grep 无命中）：它是唯一执行 deny 规则的函数，内部还有一个平台分支，却只被间接覆盖
4. edit 与 write 没有 CRLF 用例：tools.test.ts:599 只为 grep 加了一条（tools-17）
5. MCP 没有 Windows 可执行形态用例：.cmd 启动器、裸名字加 PATHEXT、带空格的路径一条都没有；mcp-echo-server.mjs fixture 走的是绝对 node 路径
6. writerLock 没有 acquiredAt 相关用例，因为没有读取方可测，这本身就是 windows-06 的症状
7. getWindowsRegistryPath 零用例（PtyManager 的 __tests__ 里没有对应 describe），编码与正则解析两部分都没有
8. 长路径（超过 260 字符）、保留设备名（nul/con/COM1）、尾随点与空格的文件名：零处理、零用例

### capacity-leftovers（T031）— 5 条

容量对账的余项。

1. 没有测试把附件体积链路从 IPC 层串到 session 落盘层验证；attachmentLimits.test.ts 只测纯函数 admitAttachment
2. preparePrompt() 本身没有任何尺寸相关测试
3. trace.test.ts 没有验证运行中 steps 数组累积超大 args 后的内存/序列化行为，也没有验证多 TracePlugin 实例并发写同一文件的交织结果
4. context 压缩流程没有 summary 超大触发 compaction_over_budget 的直接构造用例
5. session/store.ts 没有文件几乎为空、单条写入本身逼近 maxBytes 的直接构造用例

### tsd-utility（T031）— 17 条

加密文件系统（TSD）回落与 Electron utility 载体。

**T047 的替身用例清单**：批次 D 是只读批次，「TSD helper 契约用替身固化」这件事没有在本轮落代码，下面 17 条整体转为 T047 的验收项，逐条保留、不得压缩。

1. 【TSD helper 替身用例清单 · 可在普通开发机上跑，不需要加密机或 Electron】以下 T01～T14 除 T09 外都建在 host.test.ts 已有的 host-adapter 替身模式上（host.test.ts:102 与 :148 是现成样板），T09 建在 tools.test.ts 的 countingIo 上。已覆盖、不必重复的有：无回落时抛 io_tsd_unavailable、真 helper 直跑 offset/limit 与含空格/$ 的路径、adapter 恰好被调用一次且 argv 形状正确、stderr 刷 8 KiB 不影响满窗 stdout、helper 非零退出 → io_tsd_unreadable。
2. T01 `helper timeout is an unreadable file, not a partial read` — 替身返回 termination:'timeout'、exitCode:null、stdout 带半截明文 — 断言：抛 io_tsd_unreadable、错误 message 含 timeout、不返回任何字节给调用方。
3. T02 `a short helper read is a complete file, not a failure` — 替身 exit 0、stdout 只有 maxBytes/2 字节 — 断言：正常返回、truncated===false、source==='node-fallback'、字节与替身写入完全一致。
4. T03 `stdout noise ahead of the plaintext must not become file content` — 替身 exit 0、stdout = '[corp] ready\n' + 明文 — 断言：修 tsd-04 前这条应判红（当前会把噪声当内容），作为回归锚点；修后期望抛带 code 的错误或剥离框外字节。
5. T04 `stdout past the window is never a complete file` — 替身 exit 0、stdout 写 maxBytes+2 字节触发 terminate — 断言：抛 io_tsd_unreadable，不得把前 maxBytes 字节当成功读取返回。
6. T05 `binary plaintext survives the fallback unchanged` — 替身 exit 0、stdout 含 NUL 与非 UTF-8 字节 — 断言：HostIo 原样返回字节不解码；随后 read 工具对同样字节报 io_not_utf8（两段分开断言）。
7. T06 `abort during the helper run reports io_aborted` — 替身在 run 中等待，用例在途中 abort 外部 signal — 断言：抛 io_aborted 而非 io_tsd_unreadable，且 adapter 收到的 request.signal 与调用方传入的是同一次中止。
8. T07 `offset past EOF returns empty bytes on the fallback path too` — 替身 exit 0、stdout 零字节 — 断言：bytes.length===0、truncated===false，与明文路径（host.test.ts:72 已有同形断言）一致，守住契约「偏移超过 EOF 返回空字节且不截断」。
9. T08 `the helper does not inherit NODE_OPTIONS` — 替身只记录 request.env — 断言：request.env.NODE_OPTIONS === undefined（修 tsd-04 后应绿，修前判红）。
10. T09 `fallback windows stay capped past 2 MiB` — countingIo('node-fallback')、样本 >8 MiB — 断言：windows 触顶后恒为 2 MiB、调用次数 ≤ ceil(n/2MiB)+6、与 'direct' 同参结果逐字段相等（补上 tools.test.ts:654 因样本只有 1 MB 而没覆盖的封顶区间）。
11. T10 `a plaintext file that starts with the magic is skipped by grep, not fatal` — 真实临时文件内容 = 魔数 + 文本，grep 跑整个临时目录 — 断言：grep 正常返回其他文件的命中、skipped 计数 +1（修 tsd-02 后应绿）；同目录的 read 抛带可自救文案的错误。
12. T11 `an unreadable file does not fail the whole grep` — 真实临时文件 chmod 000（POSIX 下用 it.skipIf(process.platform==='win32')）— 断言：其余命中照常返回、不抛（tsd-02 的主回归锚点）。
13. T12 `without maxStderrBytes the budget is still shared` — 替身透传给真 exec：stdout 写 N 字节、stderr 写 M 字节、不给 maxStderrBytes — 断言：stdout.length + stderr.length <= maxOutputBytes，守住契约第 4 节的旧语义，防止 T013 的新语义被误扩大。
14. T13 `stderr overflow alone never sets truncated` — stdout 只写半窗、stderr 写 TSD_STDERR_BYTES*2 — 断言：truncated===false、termination==='exit'、stderrBytes 等于真实写入总量、stderr.length===TSD_STDERR_BYTES。现有 host.test.ts:148 那条因为 stdout 满窗，truncated 恒真，这一面从未被断言过。
15. T14 `real helper: limit=1 / offset past EOF / non-UTF-8 bytes` — 直跑 tsd-read.mjs（沿用 host.test.ts:94 的形态）— 断言：limit=1 只吐 1 字节；offset 超过文件长度吐 0 字节且 exit 0；非 UTF-8 字节原样透传（证明 helper 不做文本处理）。
16. 【非 helper 替身的两条】WorkerTransport 两个工厂各一条「stdout 处于 flowing 模式」断言（readable.readableFlowing===true），是 tsd-03 的回归锚点。
17. 【非 helper 替身的两条】utilityProcess 半边缺任何真实进程用例：workerEntryWiring.test.ts 只覆盖 fork()（Node IPC / bundled-node 形状），utility 载体的 bootstrap 往返与 dispose 退出无自动化覆盖（tsd-06）。
