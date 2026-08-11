# 2026-08-11 xvqiu1 真机反馈四问题排查（triage）

> 输入：2026-08-10 加密真机实测（`0.4.0-test.3`，`d759023` + `e529a55`），用户 2026-08-11 反馈四问题，
> 截图批次 `D:\Dan\vmshare\xvqiu1`（VSCode SCM 参照图 / History file not found 报错卡 / 官方 CLI 实时状态行参照图）。
> 方法：四路独立读码取证（问题各一路），编排方对四个承重结论逐一亲验（`includePartialMessages` 全仓零请求 /
> `temporaryWorkspaceEnabled` 新壳零命中 / resume 句柄无条件下发 / `GIT_LOG_PRETTY_FORMAT` 无 `%P`）。
> 用户原话（其余项）："其他的暂时没看到什么问题。"

## §1 左侧 Temp 仍存在 —— 已确认：新壳从未接 `temporaryWorkspaceEnabled`，且新壳独有一条不设防的创建路径

**定性**：确认（非假说）。0810 批 `d759023` 只做了 Temp 行 hover 删除（其提交说明自述范围如此），未动可见性门控。

**根因（两条独立成立）**：

1. **可见性门控缺失**：新壳 Temp 组纯以 `tempItems` 非空渲染（`deriveChatWorkspaceTree.ts:250`），
   `temporaryWorkspaceEnabled`（默认 `false`，`stores/settings/index.ts:181`）在 `workspace-shell/` 与 `src/main` 下**零命中**（已亲验 grep）。
   旧壳两个侧栏都有整段门控（`RepositorySidebar.tsx:638`、`TreeSidebar.tsx:1205`：`{temporaryWorkspaceEnabled && (...)}`）——新壳移植时漏掉的正是这个模式。
   设置页开关存在且工作（`GeneralSettings.tsx:617`），只是对新壳无效。
2. **不设防的创建路径（新壳独有）**：Composer 目标栏下拉的「New Folder / Temporary workspace」页脚按钮无条件渲染
   （`TargetFolderSelect.tsx:205`）→ `useComposerTarget.ts:345 createTempTarget()` → 创建真实目录 + 入 store。
   全链路不读设置开关——默认关着也能从聊天口造出 Temp 项。
   Temp 项持久在 `localStorage['aiclient-temp-workspaces']`（`stores/tempWorkspace.ts:44`），逐项删完前一直在。

**纠偏一处文档误读**：implementation-status 遗留注记「tempItems 非空即显示」括注易读成"零项也渲染"——实测 `deriveChatWorkspaceTree.ts:250` 有 `length > 0` 判定，删光最后一项组会消失。缺陷是"可见性/创建与设置全脱钩"，不是零项隐藏坏了。

**用户现场属哪种**（三种结构上均可能，device log 才能分辨，但修法一并覆盖）：
(a) 修复批之前的存量残留；(b) New Folder 按钮新造的；(c) 只删了部分行、期望整组消失。

**修法（按旧壳强先例直接定，无需拍板）**：
- **S｜开关接线（可见性）**：`temporaryWorkspaceEnabled` 穿到新壳（App → WorkspaceShell → 树推导，或在 `useSyncChatWorkspaceTree` 前过滤 `tempItems`），off 即整组隐藏，数据不删——与旧壳行为逐字对齐。
- **S｜创建入口同门控**：`TargetFolderSelect` 页脚按钮同读该开关（旧壳的创建按钮本就在门控段里，恢复 parity）。
- **（可选，另拍）S｜组头「清空全部」**：复用既有 `openTempDelete` 链路 + 确认框（temp 目录是磁盘真实文件，必须确认）。
- **禁区**：不得复活 `sessionIndexMerge` 自动迁移（0810 双轨评审已否决，见 `d759023` 提交尾段）。

## §2 历史会话没找到 —— 环境因（用户猜测正确）+ 一条连带真缺陷（未经真机取证）

**定性**：报错卡本身是 T-03 设计的显性降级（测试方案第 ⑤ 项要求），机制按设计工作；意外的是索引里的陈旧条目。

**根因链**（全部亲验/agent 验于当前代码）：
- JSONL 查找根在**读取时刻**由环境决定：`historyReader.ts:241`（`claudeConfigDir || CLAUDE_CONFIG_DIR || ~/.claude`），
  `replayHistory` 调用时不传 `claudeConfigDir`（`claudeRuntime.ts:385`）；Host env 只继承不注入该变量（`hostEnv.ts:37`，与 Codex home 由 app 自有形成不对称）。
- 会话索引却存 Electron `userData`（`SessionIndexService.ts:30`，`session-index.json`），跨 config-dir 切换存活；
  条目无 config-dir/根路径字段（`shared/types/sessionIndex.ts`），侧栏行无条件物化（`sessionIndexMerge.ts:149`）、resume 只看句柄存在（`resumeIntent.ts:80`）。
- 昨天按测试方案 `set CLAUDE_CONFIG_DIR=%TEMP%\aiclient-gui-test-config`（方案 :103）写入的 JSONL，
  今天直启后 Host 落到 `C:\Users\JC\.claude\projects` → 合法地找不到。报错卡 Details 里的根路径即 HOME 回落，坐实当天未设变量。
  `locateSessionFile` 会暴力扫该根下**所有** project 目录（`historyReader.ts:288`）——排除 cwd munging 因素，只有根不同能造出此 miss。
- **测试方案 :234 早已预言此坑**；且测试 config dir 在 `%TEMP%`（`scripts/make-test-claude-config.mjs:26`），Windows 存储感知可能已把昨天的 JSONL 清掉（若已清，任何回扫都救不回）。

**现场自救**：设回 `CLAUDE_CONFIG_DIR=%TEMP%\aiclient-gui-test-config` 再启动即可复见昨天会话（前提是 `%TEMP%` 未被清理）。

**连带真缺陷（⚠️ 源码判读，未经真机取证，确认前不施工——open-q #30）**：
`jsonl_not_found` 后 Host 保留 `session.runtimeIdentity`，下一 send 仍带 `resume:`（`claudeRuntime.ts:752`）；
捆绑 CLI 对未知 resume id 打印 `No conversation found with session ID: …` 后 exit 1，SDK 转抛错 → `session.failed`（`claudeRuntime.ts:865/901`）。
即报错卡「会话未中断，可以继续发送消息」在此场景为**假**，该行永久不可用。**取证法**：真机 Host log 的 `[cli-stderr]` 一看便知。

**修法清单**（详见 open-q #30；分层）：
- **S｜流程修（零 app 代码，本批可做）**：`make-test-claude-config.mjs:26` 的 config dir 移出 `%TEMP%`（如 `%LOCALAPPDATA%`）；测试启动固化成 wrapper 脚本（.cmd）永远带变量，杜绝"直启换目录"整类跨日证据丢失。
- **S｜断链语义修（取证确认后）**：`replayHistory` 见 `jsonl_not_found` 清句柄（下一 send 开新 CLI 会话，Host 既有 `session.updated` 再绑）+ 卡文案改「继续发送会另起一段」；或最小改文案。**fork 静默 vs 显式按钮属产品拍板**。
- **M｜索引条目加 `projectsRoot?` 标记**（`sessionIndex.ts` 自述的合法扩展形态：可选逐条字段）：跨目录条目上徽章 + 卡文案升级「历史在另一配置目录（旧 → 现）」。
- **M｜多根回扫**（当前根 + `~/.claude` + 条目记录根）：须 flag、只读不写、防隔离穿透——`%TEMP%` 已清则无价值，优先级最低。
- **S｜卡内「归档这条」入口**：复用 `setArchived`（不发明删除）；自动清理一律不做（重设变量即可复活的行，删了就是丢数据）。

## §3 git 面板形态 —— 非 bug，是用户点名推翻 D27「git 最小集」豁免；graph 全仓零基础

**现状盘点**：
- 用户看到的新壳 `GitSurfaceView`（`surfaceViews.tsx:47` 唯一挂载）：只有 ChangesList + CommitBox + DiffViewer（`GitSurfaceView.tsx:249`），文件头注释明令禁用 `SourceControlPanel`/`CommitHistoryList`/`BranchSwitcher`/一切 `components/git/` 复用——T-12（D27）刻意为之，基线 mockup（`a08-…baseline.html:1271`）本身也没画历史区。
- 仓里已有但新壳不挂的存货：旧壳 `SourceControlPanel`（①②俱全 + 平铺历史 + ref 徽章 `CommitHistoryList.tsx:270` + ahead/behind `GitSyncButton`）；`views/GitView.tsx` 是**零引用死代码**（顺带清理候选）。
- 后端缺口：`GIT_LOG_PRETTY_FORMAT` 有 `%D`（refs 徽章数据现成）无 `%P`（parents，graph 边数据不存在）；`getLog` 只查 HEAD 不带 `--branches`（`GitService.ts:379`）；`GitLogEntry` 无 `parents` 字段。GIT_LOG IPC 链路整条现成（`ipc/git.ts:146` → `useGitHistory`）。
- 约束：右栏定宽 380px（`a08 …:747`，泳道 graph 需以 expanded 双栏为家）；`package.json` 无任何图形库（VSCode 同款做法是手绘 SVG，不引重依赖）；design-system 迁移明言未覆盖 `source-control/`/`git/`（`design-system.md:26`），动工需补设计过审。

**范围选项**（open-q #29，待拍板）：
- **(a) S｜平铺历史 + ref 徽章**：后端零改动，前端复用/精简 `CommitHistoryList` 进 surface——需自觉推翻 T-12 禁令并记档。
- **(b) M/L｜SVG 泳道 graph**：后端 `%P` + parents 解析 + `--branches --topo-order`（S/M）；前端泳道分配纯函数 + SVG 绘制 + 虚拟化（L，全仓无先例可抄）。
- **(c) L｜加 remote 进出**：(b) 之上叠 remote 分类与进出标识（ahead/behind 计数本身现成）。
- **倾向**：(a) 先行拿到"有历史可看"，(b) 以 expanded 模式为家另批；graph 按工程规范上 flag + 先定 Happy Path。

## §4 非流式输出 —— 已确认：断链在第一环（SDK 未开 partial），下游全链路本就是增量制

**定性**：确认。`claudeRuntime.ts:710` 的 query options 不含 `includePartialMessages`（全仓唯一出现处是 normalizer 注释自述"没请求"，`eventNormalizer.ts:884`；`claudeRuntime.ts:592` F1 注释同）。
SDK 于是只发整条 `assistant` 消息，normalizer 把整段文本并成**一条** `message.delta`（`eventNormalizer.ts:874`→`:401`）。
下游为流式而建且完好：Host/Main/preload 逐事件直通、渲染 store 16ms 合帧（`chatSessions.ts:936`）、`appendTextBlock` 追加语义、流式块 markdown 后置（`chatMarkdownPolicy.ts:375`）、贴底 ResizeObserver——一帧忠实渲染了那条巨 delta，故"一次性全出"。

**状态行半边**：`Generating · Ns` 存在但被 `hasBlocks` 门在整段落地那一刻（`turnStatus.ts:96`）——长回合全程只见 Waiting。
token 半边：`usage.updated` 只在终局 result 发（`eventNormalizer.ts:1012`）；CLI **今天就在发**的 `system/thinking_tokens`（每回合 8–9 次，`claudeRuntime.ts:170` 探针注记）被 normalizer system 分支静默丢弃（`:822`）。

**答用户问「能否支持」：能，协议与渲染端零改动，缺口集中在 Host 一处 + normalizer 两处埋雷**：
1. **M｜开 partial + 除双雷（核心批）**：`AICLIENT_HOST_PARTIAL_MESSAGES` flag（仿 `resolveSubagentActivityEnabled` :142 逐 send 读）；
   雷 A——partial 与整条 assistant **叠发**，不去重必整段重复渲染（前缀比对，失配宁弃不重，变异验证咬合）；
   雷 B——死分支 `content_block_start` 发 `tool.started` 带空 stub input，`seenTools` 首写为王会永久遮蔽真实入参（`eventNormalizer.ts:892`/`:444`）——tool 卡保持只认整条消息。
   看门狗安全：`stream_event` 已在 `PRODUCTIVE_EVENT_TYPES`（`:671`），开 partial 反而减少长思考误杀。
2. **S｜同批必带**：`ChatComposer.tsx:1021` 的 `seenEvents` 无界数组改环形（每 token 一条字符串攒 19 分钟会爆）；`sessionRuntimeFacts.ts:46` 逐事件 set() 的免合帧成本顺带看一眼。
3. **M｜实时状态行**：`✽ …（19m 55s · ↓ 38.5k tokens）`——elapsed 半边现成（`useSecondsTick`）；token 半边双源：`thinking_tokens`（今天就有，**可先行独立出货**，思考期在走、正文期冻结，需言明）+ partial 开后 `message_delta.usage`（累计 output tokens，正是官方 ↓ 数字）。Host 侧 ~250ms 限流；渲染走 metadata registry 不进红线 store，防打穿 `ChatTurn` memo。计数是估算，不当计费真值展示。
- **动工前置 spike**：仿 `c16-thinking-shape-probe` 开着 flag 打一轮真网关——Cometix CLI 是否履约 partial、整条是否仍叠发、tool input 是否真走 `input_json_delta`，三答案定去重设计。**IPC 每 token 一事件在加密机是否卡顿须真机实测**，卡则上 Host 侧 40–60ms 合并（备选，非默认）。
- **flag 姿态**：两位皆可跑；OFF 位断言 options 无该键（`claudeRuntimeOptions.test.ts:1173` 同款反断言）；Happy Path「3 partial + 1 整条 → 文本恰一份、≥3 delta、tool 入参非空」+ 变异验证。test.4 默认 ON/OFF 待拍（建议 ON，CI 保 OFF 绿）。

## §5 批次建议与拍板汇总

**可径直施工（无拍板）**：§1 开关接线两件（S+S）· §2 流程修（S）· §4 spike + seenEvents 环形（S）。
**取证后施工**：§2 断链语义（先看真机 `[cli-stderr]`）。
**待拍板**：#29 git 范围（倾向 (a) 先行 + (b) expanded 另批）· #30 fork 静默 vs 按钮（连带 projectsRoot 标记/归档入口/config dir 展示脱敏口径）· #31 流式三小件（token 口径 / 趣味动词及语言（与 multi-agent #11 同裁）/ test.4 flag 默认）。
**顺带清理候选**：`views/GitView.tsx` 死代码；`host.ready.settings` 不含 configDir（报错卡 Details 却在漏，脱敏口径不一致，归 #30 连带）。
