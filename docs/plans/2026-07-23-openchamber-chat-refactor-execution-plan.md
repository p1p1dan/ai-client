# OpenChamber 气泡对话重构 — 双轨执行计划表

> 文档日期：2026-07-23
> 权威：[`2026-07-23-openchamber-chat-refactor-ard.md`](./2026-07-23-openchamber-chat-refactor-ard.md)（ARD）
> 总台账：[`openchamber-chat-refactor-ledger.md`](./openchamber-chat-refactor-ledger.md)
> 分支：`feat/openchamber-chat-refactor`
> 状态：已与用户对齐执行形态，随做随更
> **2026-07-28 更新**：按用户拍板的 **D18**（Flexoki 主题 + 全等宽字体 + 卡片形态一并对齐，撤销 D6）、**D19**（三列 + 44px 导轨 + surface 模型，废弃底部面板，撤销 D15）、**D20**（问答卡保留「就地冻结」，登记为偏离）——整体重写 **T-05**，重定义 **T-12 / T-13 / T-14 / T-15 / T-16**，补登产品设计基线 **A01 / A05 / A06**，新增 **T-21~T-24** 与 **C-17**。设计基线产物：[`docs/design/phase0a-openchamber-alignment.html`](../design/phase0a-openchamber-alignment.html)（用户已验收）。
> **2026-07-28 二次更新（落库后独立审查，只更正事实与范围、不动决策）**：T-21 的原色硬编码清理范围收窄至 `components/chat/**` + `components/workspace-shell/**` 并补入 `HostStatusBanner` / `StatusLine` 两处，旧模块 47 文件另立 **T-25**（后置）；T-15 / T-22 的 Rail 圆点收窄为 **git-only**；**A01 补记冻结参考版本** `openchamber a3519141`（`v1.17.0-6-ga3519141`）；T-21 / T-22 各补一项「同步 `docs/design-system.md`」。
> **2026-07-28 三次更新（minor 修复轮，仍只更正事实与措辞、不动决策）**：① T-05 的「squircle + 全小写」经复核**不属 Question 卡形态**，改记入 **A05 全局按钮原语基线**、落地并入 T-21，Question 卡按钮改按实测的扁平 status 着色描述；② T-23 的 usage 数据源补全路径（`components/layout/`，不在 `workspace-shell/`）并更正语义（是 `todayCostUsd` 成本、无百分比字段，故「改环语义或撤环」二选一）；③ T-16 统一措辞为「两处强制覆盖」并写清 `devFlags.ts:10` 的实际作用；④ **M4 补入 T-23**（对齐 ARD §11 Phase 4）；⑤ 团队轨道估时按表内逐项重算为 13d / 合计 ≈20.5d；⑥ **起步顺序把 T-05 后移到 T-21 / T-22 之后**（与 plantree 收敛），§3 的 `--status-running` 豁免相应限定为「T-05 被提前时才成立」；⑦ T-21 补新增 token 的使用点断言与按钮原语断言；⑧（同日复验补记）**§3 A05 行的色相表述收窄**——原写「语义变量整套锁在色相 285.82 且无强调色」是误述，实测状态三色 `--success` / `--warning` / `--info` 色相 150 / 70 / 260、彩度 0.15–0.21 是真彩色，真问题是**亮暗逐字同值**（`globals.css:80-85` / `:110-115`），锁在 285.82 的是**中性与品牌梯度**、缺的是**品牌强调色**，现已与 ARD §7 / §3 同口径（D18 结论不变）。

## 0. 执行形态（已拍板）

| 决定 | 结论 |
|---|---|
| 分工模型 | **双轨**：🤖 Claude 主线（复杂/高不确定性/架构攸关） + 👥 团队轨道（用户与同事：常规实现 / GUI 打磨 / 真机与加密机验收） |
| 打包链时机 | **立即提前**（Phase 2 收尾第一优先级），不等 Phase 5 |
| Thinking 冲突 | **先探测再定**：spike 实测网关支持度 → 能开则开，不能开则 capability flag + UI 条件隐藏 + 台账记录已知限制 |
| TSD 加密机验收 | **打包链通过后尽快去一次**（M2），清零架构风险；Phase 5 再做完整回归 |
| 负责人 | Claude 是主线负责人；每到「确认点 CP-x」向用户汇报并确认后再推进下一段 |

### Claude 主线内部委派模式

| 委派对象 | 用途 | 实现方式 |
|---|---|---|
| deep-reasoner | 推理/权衡类任务：协议设计评审、打包依赖策略、边界情形分析 | 子代理，model=opus，输出结论供主线采纳 |
| fast-worker | 繁琐机械类任务：批量测试用例、剪枝脚本、spike 批跑、lint 清理 | 子代理，model=haiku/sonnet |
| fresh-fable | 需要新鲜视角的问题：方案盲点审查、协议定稿前的对抗评审 | 独立子代理（fable 模型，不带主线上下文偏见） |

### 台账分账规则（公共说明）

- **总台账** `openchamber-chat-refactor-ledger.md`：Phase 状态总览、已拍板决策、里程碑与确认点结果。双方共同的唯一权威进度视图。
- **Claude 主线台账** [`ledger-claude-mainline.md`](./ledger-claude-mainline.md)：C-xx 任务的过程记录、证据、提交 hash。Claude 维护。
- **团队轨道台账** [`ledger-team-track.md`](./ledger-team-track.md)：T-xx 任务的过程记录。用户/同事维护（格式已建好，照抄模板填行即可）。
- 关键节点完成 → 先记子台账，再把里程碑级结果同步进总台账检查点。

---

## 1. 里程碑与确认点

| 里程碑 | 内容 | 归属 | 确认点 |
|---|---|---|---|
| **M1** | 打包链通：构建产物含 agent-host，打包版可启动 Host 跑通对话、退出无孤儿 | C-01/C-02 构建与自动化验证归 🤖；T-10 GUI 手工点验归 👥 | **CP2**：M1 证据汇报后用户确认 |
| **M2** | 加密机验收一次：白名单 Node 解密读 + 打包版真实加密工作区跑通对话 + JSONL 可读 | 👥 现场执行（🤖 提供 checklist 与自检脚本） | **CP5**：结果回填后 Phase 0 由 Conditional Go 转正式 Go |
| **M3** | Chat MVP 日常可内用：真实数据树 + Session 生命周期 + Resume 历史 + 卡片全套 | 双轨合流 | **CP6** |
| **M4** | Phase 4 完成（2026-07-28 按 D19 改口径；同日审查补入 T-23）：`git / editor / context / terminal` 四种 surface 接线 + 壳结构改造（T-22）+ 主题字体落地（T-21）+ 新壳「添加仓库」通路（T-24）+ **存量违规清理（T-23：死按钮 + 假 usage 环）**，不必切旧界面。口径对齐 ARD §11 Phase 4（该节已明列 T-23），CP7 验收须逐项覆盖 T-23 的三条验收，勿漏 | 👥 为主，🤖 支援 | CP7 |
| **M5** | Phase 5 收口可发布：旧路径收缩、回归、发布回滚方案 | 双轨合流 | CP8 |

**过程确认点**（不绑定里程碑）：

- **CP1**：本执行计划定稿（当前）。
- **CP3**：Question 桥 + Thinking 探测结论（可能影响 MVP 功能矩阵——是否条件性隐藏）。
- **CP4**：`session.history` 协议定稿（团队 T-03 的接口契约，定稿前团队勿动 Resume UI 数据层）。

---

## 2. 🤖 Claude 主线任务表

> 记录规则：每任务完成 → `ledger-claude-mainline.md` 加行（证据 + hash）→ 里程碑级结果同步总台账。
> 三绿纪律：每次提交前 `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿。

| ID | 任务 | 内容要点（关键文件） | 验收标准 | 依赖 | 估时 |
|---|---|---|---|---|---|
| **C-01** | agent-host 构建产物与打包配置 | 现状：Host 以 TS 直跑（`--experimental-strip-types`），打包态 `AgentHostManager.resolveHostEntryPath()` 期望 `resources/agent-host/index.js`，但无构建脚本、`electron-builder.yml` 无条目。做法：`scripts/build-agent-host.mjs`（esbuild bundle host 源码，external SDK/Cometix）+ 剪枝拷贝 `src/agent-host/node_modules`（Cometix `cli.js` 必须保持真实文件路径可被 `cometix.ts:resolveCometixCli()` 解析；SDK 含 cli.js/wasm 不可 bundle）+ `extraResources` 增条目 + `dist:prereq` 挂钩。deep-reasoner 评审依赖策略；fast-worker 写剪枝细节 | ① `node <产物>/index.js` stdin 走 initialize→ready（cometixVersion=2.1.212）；② smoke 指向产物跑通 PONG；③ `pnpm build` 后产物齐全 | 无 | 1.5d |
| **C-02** | 打包态自动化验证 | `pnpm build:win`（portable 优先）后断言脚本：`resources/agent-host/` 结构完整、直接对产物内 host 跑 PONG smoke、检查 `NodeRuntimeResolver` 打包态可寻 Node 24。GUI 手工点验清单移交 T-10 | 断言脚本绿；向用户提交 CP2 汇报 | C-01 | 1d |
| **C-03** | Question 桥 spike | 探明 SDK 侧提问形态：canUseTool 是否收到 `AskUserQuestion` 工具调用（记录 tool_name/input schema），或 SDK 专用消息类型。仿 `spikes/phase2-permission-smoke.ts` 写强制触发提问的 spike。若 SDK 无原生支持 → fallback 方案：按 permission 流拦截 AskUserQuestion 工具并 allow-with-updatedInput | spike 脚本 + 形态结论记入主线台账；进 CP3 汇报 | 无 | 0.5d |
| **C-04** | Question 桥实现 | 对齐 `permissionBridge.ts` 模式新建 questionBridge（pending map、单次响应、rejectSession/rejectAll fail-closed）；`question.requested/resolved` 事件 + `question.respond` 命令（替换 `index.ts` 现 stub）；Main/preload `respondQuestion` 透传；reducer 增 question block 处理；unit smoke | question smoke：触发提问→respond→会话继续；abort→拒绝路径通过；`pnpm test` 含新用例 | C-03 | 1.5d |
| **C-05** | Thinking 支持度探测 | spike 实测当前 CCH 网关 thinking 开启是否 400（`claudeRuntime.ts:198` 现禁用）。能开→移除 disable 并验证 `thinking.*` 事件链路 + reducer 补 thinking case（当前 reducer 无 thinking 处理）；不能开→`host.ready.payload.capabilities.thinking=false`，UI 条件隐藏依据 | 结论 + 代码调整 + 主线台账记录；进 CP3 汇报 | 无 | 0.5d |
| **C-06** | Resume 历史重放（协议 + Host + Store） | **关键约束**：加密机上 CC JSONL（`~/.claude/projects/`）是 TSD 加密的，Electron Main 读不到，**必须 Host（白名单 Node）读**（ARD D11 立论）。设计 `session.history` 批量事件（一次 payload 带全部历史 messages[]，勿逐条 delta 重放）+ Host 读 JSONL 解析（cwd munge 规则参照 `src/main/services/claude/ClaudeSessionScanner` 及其测试；宽容解析，未知行跳过不崩）+ `session.listHistory`（按 workspacePath 列历史会话摘要）+ store 灌入。协议先行：`shared/types/runtimeEvents.ts` 变更 → fresh-fable 对抗评审 → **CP4 定稿后再实现** | 对真实历史会话 resume→时间线完整恢复→追问可召回上下文（ORANGE-42 式验法）；损坏行不崩；测试覆盖解析 | 无（产出解锁 T-03） | 2d |
| **C-07** | Session Index（Main 持久化 + IPC） | `SessionIndexService`：`{ sessionId, runtimeIdentity, workspacePath, title, model, updatedAt, archived }`；数据源 = Host `session.created/resumed` 回报 + Renderer 命名操作；存 userData JSON；IPC：`chat:listSessions/renameSession/archiveSession`。**尽早做，解锁 T-02** | 重启应用可列出历史会话（与 T-02 联调）；索引读写单测 | 无 | 1d |
| **C-08** | Chat Store 结构优化 + 事件批处理 | messages 扁平数组 → 按 sessionId 分桶，消除每 delta 全量 map；Runtime Event rAF/微任务窗口合并批量 set；reducer 保持纯函数。**`chatSessions.ts` 由 Claude 单独主导变更**（见协作规则） | C-09 reducer 测试全绿（行为不变）；长流式输出无卡顿 | C-09 先锁行为 | 1d |
| **C-09** | 测试基建 + lint 恢复绿 | ① reducer 测试：delta 追加/未知 messageId/permission 幂等/stop 冻结/乱序容忍；② Host 测试：协议解析错误路径、permissionBridge 单次响应与清理、normalizer 关键映射；③ `pnpm lint:fix` + 手修 `electron.vite.config.ts:42`、`scripts/afterPack.mjs:46`。用例编写委派 fast-worker，用例清单 Claude 定 | `pnpm test` 新增两组测试全绿；`pnpm lint` 恢复绿色 | 无（建议先于 C-08） | 1d |
| **C-10** | Effort/Plan/Build 支持度探测（Phase 0 遗留） | SDK options 逐项实测（effort / permissionMode:plan 等）在 Cometix 2.1.212 + 当前网关下是否生效；`host.ready.capabilities` 扩展；UI 条件渲染依据交 T-08/T-09 | capability 结论记台账 + 字段落地 | 无 | 0.5d |
| **C-11** | （机动）stream-json fallback 适配器 | `ClaudeRuntime` stream-json driver（参照 `spikes/stream-json-spike.ts`）。仅当 SDK 路线出现阻塞时提级，否则排后 | `AICLIENT_AGENT_HOST_DRIVER=stream-json` 下 PONG smoke 通过 | 无 | 1.5d |
| **C-13** | 附件协议探测与桥接（用户反馈 F2） | spike 先行：Agent SDK `query()` prompt 是否支持图像/文件块（形态：base64 / 临时文件路径 / content block）；cli.js 粘贴图像的原生机制；结论定协议——`session.send` payload 扩展 `attachments[]`（Host→SDK 透传）+ Main/preload 链路。协议变更走 CP 纪律 | spike 结论记台账；协议扩展后 Host 侧冒烟：带一张图发送 → 模型能描述图片内容 | 无（UI 归 T-18） | 1d |
| **C-14** | Host 挂起看门狗（C-10 发现，CP3 立项） | SDK 流「不吐事件也不结束」时无超时防护（非法 model 实测挂死 51s+；`finishTurn` 兜底只覆盖「流结束无 result」）。send 循环加无事件超时（默认 120s 无任何流事件 → abort + `session.failed` 带明确错误；`AICLIENT_HOST_STALL_TIMEOUT_MS` 可配）；单测 + 非法 model 场景复现验证 | 非法 model 场景显性 failed 不挂死；正常长响应（thinking 慢轮）不误杀 | 无（排 C-04 后） | 0.5d |
| **C-15** | 随包 Node 运行时（D17，2026-07-24 立项） | dist 打包 pinned Node 24 win-x64 `node.exe` 至 `resources/node-runtime/`（走 afterPack 串行拷贝先例，避 extraResources 竞态坑）；`NodeRuntimeResolver` 增 `bundled` 源，**打包态首选**、五源解析降级为兜底（开发态行为不变）；`verify:packaged` 增断言（node.exe 存在 + 版本 pin + 用它直跑 PONG）；体积评估（node.exe ~80MB，跟 87MB agent-host 同量级，可接受性交用户过目）。**白名单前提（按进程名）是用户口径，加密机实证归 T-11 新增项** | 打包版在无用户 Node 的机器可直接跑通对话；`verify:packaged` 新断言绿 | C-02 先例 | 1d |
| **C-12** | （Phase 5）旧路径收缩 + 性能压测 | AgentPanel Claude 主路径收缩、`App.tsx`/`MainContent.tsx` 清理（App 只装配）；千 block 会话压测→虚拟化决策；确认 ARD §8 清理项（`ai-chat/` 已不存在，验证 `shared/types/ai-chat.ts` 状态） | 旧界面其他 Agent 入口不回归；压测数据记台账 | M3/M4 后 | 2.5d |
| **C-17** | （后置）问答进历史协议（**D20** 偏离的解除前置，2026-07-28 立项） | 扩 `src/shared/types/sessionHistory.ts` 的 `HistoryBlock` 联合类型（现仅 `text \| thinking \| tool_call \| tool_result`，见 `:11-30`）新增 question / permission 分支，并让 Host 把问答与其结果写进历史；store 侧 `historyBlockToBlock`（`stores/chatSessions.ts:236-237` 的 `default: return null`）相应补 case。**做完之后**才可重新评估是否切换到 OpenChamber 的「回答后消失 + 历史只读 Q/A 重渲染」形态。属主线协议变更，走**协议变更纪律**（先落类型与文档、必要时 bump `AGENT_HOST_PROTOCOL_VERSION`、CP 汇报）。**编号跳过 C-16**：该编号已被 `src/agent-host/spikes/c16-thinking-shape-probe.ts` 等文件占用，避歧义 | ① resume 一个含问答的真实会话，时间线上问答块与用户答案完整重现；② 冻结态幂等（重复重放不复活为可答态）；③ 协议往返测试覆盖；④ 三绿 | C-06 ✅（`session.history` 协议）；**本轮不做**（D20 明确后置） | 待估 |

**主线推进顺序**：C-01 → C-02（M1/CP2）→ C-07（解锁 T-02）→ C-06（CP4，解锁 T-03）→ C-03 → C-04 → C-05（CP3）→ C-09 → C-08 → C-10 →（机动 C-11）→ C-12。
> 2026-07-28 补：**C-17 后置**，不进本轮推进序列——D20 已明确「问答卡保留就地冻结、不照搬 OpenChamber 的回答后消失」，C-17 是该偏离的解除前置，待主线排期时再插入 C-12 之前。

---

## 3. 👥 团队轨道任务表（用户 + 同事）

> 记录规则：每任务完成 → `ledger-team-track.md` 加行。
> 与 Claude 主线的接口都已在「依赖」列标出：依赖未就绪时先做无依赖任务。

| ID | 任务 | 内容要点（关键文件） | 验收标准 | 依赖 | 估时 |
|---|---|---|---|---|---|
| **T-01** | 真实 Project/Workspace 数据树 | 删除 `chatSessions.ts` DEMO 常量的消费假设（store 结构变更找 Claude 协调），从现有 stores 派生：Project=当前仓库（`stores/repository.ts`）、Workspace=Main/Worktree（`stores/worktree.ts`）/Temp（`tempWorkspace.ts`）/Remote；`LeftNav.tsx` 渲染真实树 + 折叠 + 状态徽标；新建 Session 用真实 workspacePath | 打开真实仓库→左栏出现仓库与 worktrees→在某 worktree 下发消息，模型 `pwd` 返回该 worktree 路径 | 无（最先开工） | 2d |
| **T-02** | Session 生命周期 UI | 新建/重命名/关闭/归档/recent 分组/排序（运行状态>最近更新）；对接 `chat:listSessions` 等 IPC；重启后恢复列表 | 全链路操作可用；重启恢复 | C-07 | 1.5d |
| **T-03** | Resume UI + 历史时间线 | 历史 Session 点击→`chat:resumeSession`→消费 `session.history` 灌入的历史→时间线渲染→继续追问。数据层由 C-06 就位，团队做交互与视觉 | 对真实历史会话 resume，历史完整显示、可追问 | C-06（CP4 定稿） | 1d |
| **T-04** | Thinking 折叠卡 UI | capability=true 时渲染（默认折叠、运行中轻量指示、完成可展开）；false 时无入口无残留 | 按 C-05 结论对应验收 | C-05 | 0.5d |
| **T-05** | Tool 行 + Question 卡（~~照 OpenChamber 形态~~ **2026-07-29 形态源改判为 Cursor，D24**；2026-07-28 口径整体重写，原口径作废） | **⚠️ 2026-07-29 二次改判（D24）**：本行以下 2026-07-28 写的 openchamber 形态细节（①~⑥工具行结构、QuestionCard 列表/按钮形态、`file:line` 证据）**整体作废**，改以 Cursor 截图（[`refs/cursor-20260729/`](../design/refs/cursor-20260729/) 工具行/问答卡五图）与 **A07 v2 基线**为准——工具行=动词开头无图标灰阶单行+`Explored N files, M searches` 聚合展开+`Thought` 折叠单行+`Worked for Ns` 回合时长；问答卡=折叠 `Questions` 条（多题 `1 of N`）/展开 A-B-C-D 字母行选项+Other/`Skip`+`Continue`/回答后冻结 `Answers` 卡（与 D20 一致）/跳过态 `Questions skipped`/挂起时 composer placeholder 变化。**不变项**：默认折叠、store 侧冻结已实现只补 UI、逻辑下沉纯函数、`toolCallId` 关联、路径可点击。**验收标准（2026-07-29 按 A07 v3 定稿重写，本段为现行权威）**：① 工具行 = 动词开头、无图标、无边框的灰阶单行（动词较深、参数较浅），连续调用聚合为「Explored N files, M searches」可展开明细，思考块折叠为「Thought briefly / for Ns」单行，回合时长「Worked for Ns」行——均与 A07 屏⑤ A~D 组一致；② 输出体默认收起，失败行整行 error 色并自动展示输出体，显式点开可见（E 组）；输出体滚动窗数值沿用旧口径（输入 240px / bash 46vh / 通用 60vh），与 A07 冲突时以 A07 为准；③ 交互（F 组）：Read 行文件名可点击打开文件（editor surface 联动），Grep/Search 行悬浮出命中文件浮层且浮层项可点击；实现代价高时**允许降级**为点击展开明细（须台账登记降级）；④ 问答卡：折叠 `Questions` 条（多题 `1 of N` 分页）→ 展开 A/B/C/D 字母行 + Other → `Skip` + `Continue`（`--primary` 实心）→ 回答后**就地冻结**为 `Answers` 只读卡（复用 store 已有冻结状态，不重复实现）→ 跳过态 `Questions skipped`；问题挂起时 Composer placeholder 变 `Add more optional details…`；刷新/重放不复活为可答态；⑤ Permission 卡沿用问答卡外形（A07 外推：头文案换 Permission、选项换 允许/拒绝）；⑥ UI 逻辑一律下沉纯函数（照 `hostStatus.ts` 范式）并有单测；⑦ 观感零自造值、全部对齐 A07 屏⑤⑥；⑧ 三绿。**✅ 2026-07-30 代码落地 `340a59a`**（四批施工 + Codex 复核 4 blocker+2 major+2 minor 全采纳当场修——running 不入聚合/聚合失败传播/输入体 240px 档补齐/respond 返 Promise 提交失败可重试；空 thinking 块改不可展开裸行=批准变更入档；R-5 挂起禁打字升 open-q #18；+133 例总 966 三绿。**GUI 点验待用户**，清单见主线台账 2026-07-30 T-05 行）——以下为作废的 07-28 口径（append-only 保留）：**撤销**：带边框卡片 + 状态徽章；按行数截断 + 「展开全部」按钮。**保留**：默认折叠；Read/Write/Edit 摘要行显路径；Bash 显命令首行；tool_result 按 `toolCallId` 与 tool_call 关联；路径可点击（F1）；Question 单次响应后冻结。**改为**（证据：openchamber `parts/ToolPart.tsx:2306-2430` 摘要行 / `:2447-2476` 展开体 / `ProgressiveGroup.tsx:566-773` 静态聚合行）：① 工具行 = **无边框、无背景、无状态徽章的单行**，状态靠颜色（出错整行转 error 色）、运行中靠动画（用 D18 的 `--status-running`，同时替换 `MessageTimeline.tsx:419` 的 `bg-amber-500`）；② 摘要行结构 = 14px 图标（hover 或展开时交叉淡出换成 chevron）+ 工具人类名 + 耗时（**仅 bash**）+ 路径/命令（单行 truncate）+ diff 统计 `+N/-M`（edit 类）；③ 展开体**不是卡片**：`ml-2 pl-3` + 左侧一条 1px 竖线做缩进；④ **不做文本截断**，改 max-height 滚动窗——输入 240px / bash 输出 46vh / 通用 60vh，**无「展开全部」按钮**；⑤ 连续多次 read **聚合成一行**并排列出可点击路径（OpenChamber 只有 read 与 skill 走静态不可展开行）；⑥ 交互分工：点**最左侧图标位** = 切换展开，点**行体其余部分** = 打开文件。**Question 卡**照 OpenChamber：单选/多选**列表**（不是按钮组，`QuestionCard.tsx:435`）、Other 自定义答案行（`:509`）、label 含 `(recommended)` 时渲染 recommended 标记（`:475-476`）；提交/取消按钮 = **原生 `button` + 普通 `rounded` + 扁平 status 着色**（`:530-556`：`bg-[rgb(var(--status-success)/0.1)] text-[var(--status-success)]` 与 `bg-[rgb(var(--status-error)/0.1)] text-[var(--status-error)]`，hover 加深到 `/0.2`）；**回答后就地冻结、不消失**（D20 偏离）。**2026-07-28 更正**：原文写的「squircle + 全小写按钮」**不是 Question 卡形态**——实测 `QuestionCard.tsx` 既不 import 共享 `Button`，其按钮上也没有 `corner-shape: squircle` 与 `lowercase`；这两个特征来自**全局按钮原语** `packages/ui/src/components/ui/button.tsx:37`，已移记入 **A05 基线**（见下节），落地归 T-21，本任务不承担。**注意**：store 侧冻结逻辑已实现（`stores/chatSessions.ts:595-608`，含 5 例幂等测试），本任务只补 UI 渲染。UI 逻辑一律下沉纯函数（`toolCard.ts`，照 `hostStatus.ts` 范式，`.tsx` 在 vitest 下零覆盖） | ① 真实工具调用下工具行无边框无徽章、默认折叠，出错整行转 error 色；② 输入/输出超长时出现滚动窗（240px / 46vh / 60vh）且界面上**不存在**「展开全部」按钮；③ 连续 read 聚合为一行且每个路径可点；④ 点图标位只展开、点行体只打开文件，两者互不误触；⑤ Question 卡列表选择 + Other 自定义 + recommended 标记走通，回答后**就地冻结**（不消失），刷新/重放不复活为可答态；⑥ 纯函数层有单测；三绿 | C-04 ✅ · D18（`--status-running`）· **T-21（token 落地，顺序依赖：T-05 排在 T-21/T-22 之后，见下方顺序说明）** | 2d |
| **T-06** | 消息元数据 + 错误/重试 | assistant 元数据行（模型·耗时·时间，源 `message.completed`/`usage.updated`）；`session.failed` 错误卡保留已产内容 + 重试（重发上条 user 消息）；lastError 提示条归位 | 断网/杀 Host 场景 UI 清晰可恢复 | 无 | 1d |
| **T-07** | Composer @ 文件引用 | @ 触发文件搜索浮层（迁移 `EnhancedInput.tsx` 有价值逻辑）；引用 chip；发送拼 `@path` 纯文本（CC 原生识别）；不做拖拽/图片 | @ 引用真实文件发送，模型能读到内容 | 无 | 1.5d |
| **T-08** | Model 选择器 | Composer/Header 模型下拉（源：settings 配置 + `host.ready.settings.model` 默认）；`session.create payload.model` 已支持；会话级固定 | 切换模型新建会话，元数据显示对应模型 | 无（Effort/Plan 控件等 C-10） | 0.5d |
| **T-09** | 空/错/断状态 + 诊断面板 | Host 未就绪骨架屏；Node 24 未找到引导（`NodeRuntimeResolver` 诊断 + `AICLIENT_NODE24_PATH` 指引）；诊断展示（Node 路径/版本、Cometix 版本、settings 脱敏态——`host.ready` payload 已带）；Host crash 断连提示与恢复 | 改坏 Node 路径场景走通引导；杀 Host 进程有断连提示且可恢复 | 无 | 1d |
| **T-10** | 打包版 GUI 手工点验（M1 后半） | 按 C-02 移交的清单：安装/便携版启动→Beta 壳→ensureHost→PONG 会话→权限卡 roundtrip→Stop→退出后任务管理器无 node.exe 残留 | 清单全勾 + 记录进团队台账 → CP2 | C-02 | 0.5d |
| **T-11** | **M2 加密机验收**（现场） | 按 Claude 提供的 checklist：① 白名单 Node 24 `process.execPath` 记录；② 已知 TSD 加密文件 Host 读出解密内容（非 `%TSD-Header-###%`）；③ 打包版启动 Host 在真实加密工作区跑通对话（读文件工具真实可用）；④ 退出无孤儿；⑤ `~/.claude/projects` JSONL Host 侧可读（C-06 前提，密文场景应显性报 `encrypted_unreadable` 非静默空）；⑥ **白名单口径实证**（D17 前提）：白名单是否确按进程名（任意路径 node.exe 均可读 TSD），含随包 node（C-15 产物） | 全项证据回填 `phase0-report.md` + 总台账；Conditional Go → **正式 Go**（CP5） | T-10 | 1d 现场 |
| **T-12** | Phase 4：git surface（原「右栏 Git 面板」，D19 重定义） | 现有 sourceControl 视图迁入 ContextPanel 的 `git` surface（不再是右栏 tab）；当前 Workspace 联动；changed / staged / diff / commit 最小集；Rail 图标 + 有变更时 6px 圆点 | Git 状态来自真实当前 Workspace；从 Rail 可单选进入且与 editor / terminal surface 互斥切换 | T-22 | 1d |
| **T-13** | Phase 4：editor surface（原「右栏 Files 面板」，**D19 重定义；解冻**） | 文件树与文件打开统一落在 ContextPanel 的 `editor` surface（不再是「右栏 Files tab」）；Monaco 在该 surface 内打开；与 T-07 `@` 引用、T-05 工具行路径点击（F1 反馈）联动定位。**此前因布局未定而冻结，D19 定下骨架后解冻**；F5 反馈（边看代码边看分析）由「Main 阅读栏 + ContextPanel 并列」直接满足 | ① 从 Rail 打开 `editor` surface 可浏览并编辑当前 Workspace 文件；② 对话里点工具行路径可跳转到该 surface 并定位到文件；③ 面板宽度可拖（380–1400），与 Chat 阅读栏并存不遮挡 | T-22（壳结构改造） | 1.5d |
| **T-14** | Phase 4：context surface（原「右栏 Context 面板」，D19 重定义） | 真实基础字段进 ContextPanel 的 `context` surface：Workspace 路径、分支、模型、权限策略、附加文件、运行状态。**只放真实数据**（ARD：不展示假状态；参见 T-23 存量违规） | 字段与实际会话一致；无任何硬编码占位值 | T-22 | 0.5d |
| **T-15** | Phase 4：终端 surface（原「Terminal Dock 接真终端」，**D19 重定义**） | 终端从底部 Dock 改为 ContextPanel 的一种 surface（`terminal`），接现有 xterm / node-pty 体系；按 Workspace 恢复终端；支持提升为覆盖 Main 的全视图；Rail 图标（**无圆点**——参考实现只有 `git` surface 亮圆点，terminal surface 根本没有「有内容」的信号源，本轮不自造判据）；与旧终端区并存策略不变。**`BottomDock.tsx` 随 D19 废弃，本任务不得再往底部 Dock 接线**（其纯文案占位 `BottomDock.tsx:21-23` 同属存量违规，见 T-23） | ① 从 Rail 打开 `terminal` surface 可用；② 切 Workspace 恢复对应终端；③ 可提升为覆盖 Main 全视图并可还原；④ 全仓无 `BottomDock` 引用残留 | T-22（壳结构改造） | 1.5d |
| **T-16** | Phase 4：新旧开关成熟化（**前置条件已查明，2026-07-28**） | 恢复开关可逆性要拆掉的是**两处强制覆盖**（对应 ARD §11 Phase 4 的「T-16 的两处硬编码」），**只改其中一处无效**：① `src/renderer/App.tsx:450` 的 `SKIP_ONBOARDING_GATE \|\| useOpenChamberShellSetting` 短路；② `src/renderer/Root.tsx:52-59`（`SkippedOnboardingApp`）在 persist 水合完成后强行 `setUseOpenChamberShell(true)`。改完 Appearance 开关才真正生效、旧壳才可达、A/B 对照才成立。**2026-07-28 措辞更正**：原文写「同时改两处」却枚举了三个位置，易被读成只改一半。第三个位置 `src/shared/devFlags.ts:10` 的 `SKIP_ONBOARDING_GATE = true` 是**上述两处覆盖的共同开关**（`Root.tsx:138` 也是靠它才渲染 `SkippedOnboardingApp`），把它翻成 `false` 确实能一并解除两处覆盖——但**代价是 onboarding 登录闸门一并恢复**，与开发期点验口径（devFlags 注释：仅在专门验证 onboarding 本身或 CP 门禁前才翻 false）冲突。故本任务口径是：**保持 gate 跳过的前提下拆掉那两处覆盖**，`devFlags.ts:10` 维持现值、不作为达成手段。其余不变（旧 AgentPanel 保留其他 Agent 终端入口；新壳缺功能的回退路径说明）。**注意**：在 T-24 补齐新壳「添加仓库」通路之前，切回旧壳是新机器唯一的非 argv 注册手段，故 T-24 优先级高于本任务 | ① Appearance 关掉「OpenChamber Workspace Shell」后重启仍是旧壳（不被水合覆盖），且验证时 `SKIP_ONBOARDING_GATE` **保持 `true`**——不靠翻 devFlags 达成；② 新旧壳可来回切换且各自核心流程可用；③ 开关状态持久化经重启验证 | T-12~T-15 + T-24 | 1d |
| **T-18** | Composer 粘贴图片/文件（用户反馈 F2） | 粘贴/拖入图片与文件 → chip 预览 → 随消息发送（走 C-13 定的 attachments 协议）；文件类可先降级为 @ 路径引用（复用 T-07） | 粘贴截图发送 → 模型能描述图片内容；粘贴文件 → 模型能读到内容 | C-13 | 1d |
| **T-19** | 消息队列（占位，内容待团队轨道落库） | 提案出自团队轨道会话（用户转述 2026-07-24），**尚未落库**——请团队会话把提案内容补进本行与团队台账（推测方向：turn 运行中排队后续消息，CC 原生有 `queue-operation` 机制可依托；以团队定稿为准）。落库前不排期 | 待定 | 待定 | 待定 |
| **T-20** | Effort 选择器（C-10 承接，CP3 新增；原编号 T-19 让位消息队列提案） | Composer/Header effort 控件。**开工前先调研官方文档实际档位**（用户指示 2026-07-24：不止 default/xhigh 两档，以官方文档为准，结合 C-10 实测复核——实测仅 xhigh 有可测差异、SDK 对非法值不校验静默吞）；效果说明文案避免暗示各档皆有实证。协议侧 `session.create/send` 传 effort 需主线扩展（提需求给 Claude）。plan 模式 UI **暂缓**：等主线在 canUseTool 侧做 plan 只读约束后再议 | 选 xhigh 后会话行为差异可观测（usage/路由证据）；控件档位与官方文档一致 | C-10 ✅ + 主线协议扩展 | 0.5d |
| **T-17** | Tool 真实调用 GUI 验收（立即可做） | 开发态壳：让模型真实调用 Write/Bash（如「Create PING.txt with content pong」）；验证时间线完整出现 tool_call→permission 卡→allow→tool_result→文件真实生成。这是对现有 Phase 2 成果的验收，补总台账 Phase 2 检查点 | 操作记录/截图 + 台账检查点行 | 无 | 0.5d |
| **T-21** | Flexoki 主题 + 全等宽字体栈落地（A05 代码化，**D18**，2026-07-28 立项） | `src/renderer/styles/globals.css` 语义 token 整体重写为 Flexoki Light/Dark 并以 OKLCH 表达（亮 bg `#fffdf4` / fg `#100F0F` / primary `#BC5215`；暗 bg `#171515` / fg `#CECDC3` / primary `#DA702C`）；新增 `--accent-primary` / `--selection` / `--hover` / `--status-running`；字体 sans / mono / heading 三者统一 `ui-monospace`；根字号 14→16（`globals.css:63,149`）单独评估后再动，评估结论回填 plantree open-questions #11。**按钮原语基线（2026-07-28 自 T-05 移入，属 A05 代码化）**：`src/renderer/components/ui/button.tsx:10` 的 cva 基类补 `corner-shape: squircle`（带 `supports-[corner-shape:squircle]` 降级）与全小写字形，对齐 openchamber `packages/ui/src/components/ui/button.tsx:37`；**只动全局原语、不逐张卡片改**（chat 侧扁平 status 按钮本就不走该原语，见 T-05）。**原色硬编码清理范围（2026-07-28 复核后收窄）**：本任务只清 `src/renderer/components/chat/**` 与 `components/workspace-shell/**` 两个目录，清单为 ① `chat/MessageTimeline.tsx:419` 的 `bg-amber-500`（Thinking 折叠头运行指示 → `--status-running`）；② `chat/HostStatusBanner.tsx:55` 的 `border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-500`；③ `chat/StatusLine.tsx:233-234` 的 `text-green-500` / `text-red-500`（diff 增删统计）。**它不是「全仓唯一」**——实测 `src/renderer` 下 `bg-amber-500` 5 处、`(bg\|text\|border\|…)-(amber\|red\|green\|blue\|…)-NNN` 共 **134 处 / 47 文件**（`source-control/` 整目录、`layout/`、`ui/activity-indicator.tsx:21`、`ui/glow-card.tsx:123`、`files/fileIcons.tsx` 等旧模块），**旧模块清理另立 T-25，不算本任务范围**。**同步文档**：改写 `docs/design-system.md` 的 Color System / Border Radius / Typography（字号字重）/ 字体族四节至 Flexoki + 全等宽口径，并标注根字号结论——该文件被项目 `CLAUDE.md` 定为 UI 开发强制规范，不改则与 D18 对撞。**边界**：终端 438 Ghostty 主题与 `monacoTheme.ts` 跟随 Ghostty 两项不在本任务内，未裁定前原样不动（open-questions #12） | ① 亮暗两套下 `--accent` / `--muted` / `--secondary` 不再同值，`--primary` 是品牌橙而非中性反色，`success` / `warning` / `info` 亮暗有别；② **`src/renderer/components/chat/**` 与 `components/workspace-shell/**` 两个目录下** `(bg\|text\|border\|ring)-(amber\|red\|green\|blue\|yellow)-\d` 零命中（其余目录归 T-25，本任务不做也不算红）；③ Light/Dark 切换在新壳链路上无硬编码色残留；④ 中英混排在阅读栏、左栏树、工具行三处实测截图入台账（字体风险 open-questions #10）；⑤ `docs/design-system.md` 与 `globals.css` 的 token 名与语义逐条对得上，全文无 `primary = 强调色/品牌色` 这类已被 D18 证伪的表述；⑥ **新增的四个 token 各有真实使用点，无「新增即死」的孤儿 token**（2026-07-28 审查补）——`--status-running` 由验收②带出（`MessageTimeline.tsx:419` 的 `bg-amber-500` 替换点），`--accent-primary` / `--selection` / `--hover` 三者**各至少一处真实使用点并在台账里点名 `file:line`**（预期落点：强调色用于当前 Session/surface 选中态与链接类文本、`--selection` 用于文本选中与树节点选中、`--hover` 用于树节点/工具行/按钮 hover 底色）；对 `globals.css` 中本任务新增的每个变量做一次全仓引用检查，零引用者要么接上使用点、要么不新增；⑦ 按钮原语：全局 `Button` 在 supports 环境下呈 squircle、文案渲染为全小写，且 chat 侧扁平 status 按钮未被殃及；⑧ 三绿 | A05 ✅ | 待估 |
| **T-22** | 壳结构改造：三列 + 44px 导轨 + surface 模型（**D19**，2026-07-28 立项） | `WorkspaceShell.tsx` 由「四区 + 硬编码 RightDock 320 / BottomDock 220（`WorkspaceShell.tsx:31-32`，两者均不可拖拽）」改为三列 + 导轨：Sidebar 默认 280、可拖 280–500；ContextPanel min 380 / max 1400、默认按 surface 类型取可用宽度比例；Rail 固定 44px、图标可拖拽排序（排序可后置）；**圆点只做 `git` surface 的变更文件指示**（参考实现 `ContextPanelRail.tsx:166` 是 `showActivityDot={surface.id === 'git' && changedFilesCount > 0}`，圆点本体 `:82` 为 `h-1.5 w-1.5` + `var(--status-info)`），**其余 surface 参考实现未做内容指示，本轮一律不做**；聊天阅读栏 `min(100%, 48rem)` 居中、宽模式 64rem。建立 surface 注册表（对齐 OpenChamber `lib/surfaces/registry.ts` 的 11 种，本轮先落 `chat / editor / git / terminal / context` 五种，其余留注册位）。**删除 `BottomDock.tsx`**。参考 `MainLayout.tsx:407-464`、`ContextPanelRail.tsx:157/166/82`（冻结版本见 ARD §7）。**同步文档**：`docs/design-system.md` 的「尺寸」段落补一行新壳档位（Rail 44 / Sidebar 280–500 / ContextPanel 380–1400 / 阅读栏 48rem·64rem） | ① 三列均可拖拽且边界值符合上表（280–500 / 380–1400 / Rail 固定 44）；② surface 单选切换、可提升为覆盖 Main 全视图并还原；③ 阅读栏在 48rem / 64rem 两档切换正确；④ Rail 上只有 `git` 图标会在有变更文件时亮 6px 圆点，其余图标无圆点；⑤ 全仓无 `BottomDock` 引用；⑥ 布局尺寸与 surface 选择逻辑下沉为纯函数并有单测（照 `hostStatus.ts` 范式）；⑦ `docs/design-system.md` 尺寸段落已含新壳档位；⑧ 三绿。**✅ 2026-07-29 代码落地 `95a5c04`**（三路并读 → deep-reasoner 规格 → 四批施工断言先行 → Codex 对抗复核采纳 5 项当场修、驳回 4 项有据——blocker 系验收⑤口径判错：docs append-only 历史叙述不在「全仓零引用」口径内；纯函数 +79 例、三绿 lint 631 文件 / vitest 714 例；Rail 拖拽排序与多标签驻留按 MVP 简化后置，`setRailOrder` 已预留。**GUI 点验待用户**：拖拽边界 / 单选切换与再点收起 / 提升还原 / 48·64rem / 脏仓库 git 圆点 / 重启布局记忆。明细见主线台账 2026-07-29 T-22 行） | A01 ✅ · T-21（token 就位更利落，非硬依赖） | 待估 |
| **T-23** | 存量违规清理：死按钮 + 假 usage 环（A06 矩阵产出，2026-07-28 立项） | 逐项接线或按规矩「禁用 + Tooltip 明写状态」：① `MainHeader.tsx:56-72` 五个无 `onClick` 图标按钮（Layout / Folder / Host: Local / Browser / Window）；② `MainHeader.tsx:78-89` 的 `UsageRingPlaceholder` 硬编码「72%」（`:86` 的 `<span>72%</span>`）。**2026-07-28 更正**：原文「真实 usage 数据已在 `WindowTitleBar.tsx:55-60`，接过来」两点都不准——(a) **路径**是 `src/renderer/components/layout/WindowTitleBar.tsx`，**不在 `workspace-shell/`**（本条其余并列项 MainHeader / LeftNav / RightDock / BottomDock 都在 `workspace-shell/`，别按邻近上下文去那里找）；(b) **语义对不上**：那里是 `useUsageStats()` 的 **`todayCostUsd`（今日成本，美元）**，`UsageStatsResult`（`src/shared/types/usage.ts`）只有 `todayCount / todayCostUsd / monthCount / monthCostUsd`，**没有任何百分比/配额字段**，「接过来」填不出那个 72% 的环。故本项**二选一**：**要么改环的语义**（改成与 WindowTitleBar 同源的成本或次数展示，如 `$x.xx`，环形改为数值/胶囊）、**要么撤掉环**；**禁止**保留百分比语义再往里塞成本数字（那是换一种伪装）；③ `LeftNav.tsx:167-170` Workspace 按钮硬编码 `disabled` 且无 handler、`:136-138` Menu、`:279-282` Help；④ `RightDock.tsx:38-52` 三个 tab 全为 `DockPlaceholder`、`BottomDock.tsx:21-23` 纯文案占位（后两项随 T-22 / T-15 一并消化）。依据：可行性文档 §6.2「禁止按钮看起来可用但点击无反馈 / 禁止用硬编码数据伪装真实 Runtime 状态」+ §1.8「不得把占位状态伪装成真实能力」 | ① 新壳内不存在「可点但无反馈」的控件——要么接线，要么 `disabled` + Tooltip 明写状态；② Usage 环要么改成真实数据（语义与显示形式一致：成本就显示成本、不套百分比外壳）、要么撤掉，全仓不存在硬编码百分比占位；③ A06 矩阵逐行标注 `已接入 / 基础接入 / 禁用占位 / 暂不纳入` 且与实现一致（矩阵与代码对得上）；④ 三绿 | A06 ✅ | 待估 |
| **T-24** | 新壳「添加仓库」通路（**阻断级**，close plantree open-questions #9，2026-07-28 立项） | **2026-07-29 账实更正**：本任务实体已随 `b38017b`（名义 T-21 的提交，信息零次提及本任务）落库——LeftNav 展开/折叠/空态三处入口（`LeftNav.tsx:186-195/214-223/239-256`）、拖放 ref 绑新壳（`WorkspaceShell.tsx:22-23/50` + `App.tsx:1511-1512`）、`addRepositoryEntry.ts`/`fileDragDrop.ts` 纯函数 + 测试。**剩余工作 = 全新机器 GUI 实测 + 台账补登（S0，不改代码）**；「文件夹下拉」入口是增强、不并入本任务（拟归 T-27，见 [`2026-07-29-sidebar-composer-target-bar-design.md`](./2026-07-29-sidebar-composer-target-bar-design.md)）。落库未登记本身违反工程规范第 15 条，已记台账。——以下为 2026-07-28 立项时的原始描述（当时属实，现已过期）：新壳目前**完全不可达**添加仓库：`AddRepositoryDialog` 挂在 `src/renderer/App.tsx:1919`，但全部 trigger 都在 legacy 分支；ActionPanel 无该项；拖文件夹到窗口因 ref 只在旧壳绑定而**静默失效**。新机器唯一注册通路是 `--open-path` argv。本任务在新壳补入口（Sidebar 操作行 / ActionPanel）并把窗口拖放 ref 绑到新壳。**优先级高于 T-16**——在本任务落地前，「切回旧壳」是新机器唯一的非 argv 注册手段 | ① 全新机器（无既有仓库）启动新壳，不借 `--open-path` argv 即可添加仓库；② 拖文件夹到窗口在新壳生效（不再静默吞掉）；③ 添加后左栏立即出现该 Project 与其 Workspace；④ 三绿 | 无（阻断级，优先于 T-16） | 待估 |
| **T-26** | 侧栏两层化（**D21**，2026-07-29 立项） | 拆掉 `WorkspaceBranch` 树层级（`LeftNav.tsx:379-447`）；文件夹下**平铺**会话（flat，用户拍板、`by-worktree` 分组带被否），**所有会话行显分支 chip（2026-07-29 用户追加：main/master 也显，显实际分支名；原「main 不显」作废）**，temp/remote 显 kind 标签；会话行右对齐**相对时间**；「Repositories」段头补筛选/添加图标位（添加走既有 `onAddRepository`）——视觉参照 [`docs/design/refs/cursor-20260729/侧栏样式.png`](../design/refs/cursor-20260729/侧栏样式.png)；空文件夹保留并给 `+ 新建对话` 行；移除 `selectedWorkspaceId`（`LeftNav.tsx:86/:117-118/:323`，选择权移交 T-27 目标栏）；**Recent 段保留**并改 openchamber 口径（未归档 + 非子会话 +（活跃 或 48h），默认 7 条 + Show more，可整段关闭；数据源 `session-index.json`）；布局逻辑下沉纯函数 `sidebarTree.ts`（照 `hostStatus.ts` 范式） | ① 侧栏无 workspace 树层级（不可选中/不可展开/不参与键盘导航）；② chip 规则正确（**所有会话行显分支名，含 main/master**；temp/remote 显 kind）；③ 空仓库可见且可新建对话；④ Recent 段口径达标且可关；⑤ 纯函数单测（跨 worktree 会话归并同一文件夹节点 / 孤儿会话不崩不造文件夹 / 搜索只过滤会话标题）；⑥ 侧栏部分零新视觉值；⑦ 三绿。**✅ 2026-07-29 代码落地 `dd23b01`**（纯函数断言先行 14 例；对抗复核 1 blocker——sync 桥签名缺 branch 致冷启动 chip 全灭——已修并有回归测试；「可关」实现为持久化折叠，重开路径保留；ARD §4 数据层级已连带改写；`recentSessionIds` 成死代码记档待清理；**GUI 点验待用户**：chip 实际分支名 / 空文件夹新建 / Recent 折叠重启保持 / 文件夹头悬停 +） | 无（先于 T-22；两者都碰 `LeftNav.tsx`，按 **T-26 → T-22** 串行防冲突） | ≈1d |
| **A07** | 中列 Cursor 观感基线（**D23 前置**，2026-07-29 立项） | 产物 `docs/design/a07-cursor-composer-alignment.html`：**空态**（Composer 卡垂直居中 + 目标栏在上）与**会话态**（时间线 + 底部 follow-up Composer + 目标行在下）两屏，Flexoki token 融合；三下拉/指示器解剖（触发器 / 弹层 / 分区 / 动作项 / 禁用态）；**含带/不带会话 Tab 栏两版**供用户拍板。参照 [`docs/design/refs/cursor-20260729/`](../design/refs/cursor-20260729/) 六张截图 | 用户验收（同 phase0a 流程）；验收后即中列唯一观感基线，T-27 / T-28 不得自行发明视觉值。**✅ 2026-07-29 用户正式定稿（v3，含五条裁定 + 工具行交互口径 + main/master chip）** | 无（可与 T-26/T-22 并行制作） | 0.5~1d |
| **T-27** | Composer 目标栏（**D22**，2026-07-29 立项） | `ComposerTargetBar`：**文件夹下拉**（搜索 + Recents（`session-index.json` 派生，非内存 store）+ Repos 按 kind/分组 + `Use Existing…`/`Clone…`/`Add Remote…` 走共享 `AddRepositoryDialog` + `New Folder` → Temp 工作区（复用 `tempWorkspace` 现成 IPC））；**分支下拉**（= worktree 选择器：`worktree.list` 数据源、`isGitRepo===true` 前置、Main 置顶、`New worktree…` 受控打开既有 `CreateWorktreeDialog` 成功后自动切目标；**禁 in-place checkout**，只借 `BranchSelector` 视觉不借 `onCheckout` 行为；分支显示值一律由 `workspaceId` 派生、不另存字符串真相）；**运行位置只读指示器**（`useRepositoryRuntimeContext`，local→This PC / remote→连接名，缺数据隐藏）；重定向三档规则（retarget/fork/blocked）下沉 `composerTarget.ts`；**删除** `MainHeader.tsx:57` Folder 与 `:58` Host: Local 两个死按钮（能力迁入本任务，T-23 对应子项改「删除 + 复核」）；⚠️ `git.getBranches` 只准在 New worktree 对话框打开时调用（每次 shell out `gh pr list`，5s 超时） | ① 三下拉全真实数据、零硬编码项；② 三档规则正确 + 流程断言 `target.changed → session.created{cwd} → send` 且 `cwd === 新 workspace.path`、分支切换 spy 断言 checkout IPC 零调用；③ 运行中 disabled；④ New worktree 走通并自动切换；⑤ 指示器缺数据时隐藏不硬显；⑥ 纯函数单测；⑦ 观感符合 A07 基线；⑧ 三绿。**✅ 2026-07-29 代码落地 `e8fb36a`**（Codex 对抗复核 5 blocker+3 major **全采纳零驳回**当场修——runtimeIdentity 入 fork 判据 / pending 携源会话 / 发送门统一 cwd / `ChatWorkspace.gitEnabled?` 门控分支下拉（纯可选加法+签名同步）；规格「Remote 回落」句按验收⑤作废；A07 偏离两处入档（勾选左置=组件优先、不显 detached sha）；+70 例总 784 三绿。**GUI 点验待用户**，清单见主线台账 T-27 行） | T-26 + **A07（用户验收后方可施工观感部分）** | ≈1.5d |
| **T-28** | 中列状态化布局（**D23**，2026-07-29 立项） | 中列两态：**空态** Composer 卡垂直居中、目标栏在卡上方一行；**会话态**时间线在上、Composer 沉底为 follow-up、目标行（分支 + 运行位置）移到 Composer 下方；模型/Effort 保持在 Composer 卡内；空态→会话态切换（发出首条消息）无跳变；两态判定与布局参数下沉纯函数；**会话 Tab 栏按 A07 验收时的拍板结果做/不做** | ① 两态布局与 A07 基线一致；② 首条消息发送时平滑过渡到会话态；③ D19 三列 + 导轨骨架与阅读栏档位不回退；④ 纯函数单测；⑤ 三绿。**✅ 2026-07-29 代码落地 `4c1e4d7`**（Codex 复核 1 blocker——follow-up 静息高 42px 非 40px（设计自证漏算边框）——已修为 `min-h-10+py-1` 精确 40；恢复态防闪帧靠 runtimeIdentity 信号 + sendAttempted 粘滞闩；会话 Tab 栏按 A07 裁定不做；「+」附件钮不实现入档（无附件选择能力，死按钮违 A06）；+49 例总 833 三绿。**GUI 点验待用户**，清单见主线台账 T-28 行） | T-22 + **A07（用户验收后方可施工）** | 待估 |
| **T-25** | 旧模块原色硬编码清理（**后置**，2026-07-28 审查后立项） | T-21 只覆盖 `components/chat/**` 与 `components/workspace-shell/**`；**旧模块的原色工具类无主，本行认领**。实测面（2026-07-28，`src/renderer`）：`(bg\|text\|border\|ring\|from\|to\|…)-(amber\|red\|green\|blue\|yellow\|orange\|…)-NNN` 共 **134 处 / 47 文件**，其中 T-21 口径的 `bg-(amber\|red\|green\|blue\|yellow)-\d` 39 处 / 23 文件。重灾区：`source-control/`（`ChangesList.tsx` / `ChangesTree.tsx` / `DiffViewer.tsx` / `CommitHistoryList.tsx` / `SourceControlPanel.tsx` / `BranchSwitcher.tsx` / `DiffReviewModal.tsx`）、`layout/RunningProjectsPopover.tsx`·`WindowControls.tsx`、`git/`、`settings/`、`ui/activity-indicator.tsx:21`、`ui/glow-card.tsx:123`、`todo/TaskCard.tsx:16`、`files/fileIcons.tsx`。做法：按 T-21 落好的 Flexoki 语义 token 逐目录替换，**分批提交**（一目录一提交），不与 surface 改造混在一起 | ① `src/renderer` 全域 `(bg\|text\|border\|ring)-(amber\|red\|green\|blue\|yellow)-\d` 零命中；② Light/Dark 两套下这些模块的语义色（新增/删除/冲突/警告）仍可区分；③ 三绿 | T-21（token 必须先就位） | 待估 |

**团队起步顺序建议**（2026-07-28 按 D18 / D19 改写后半段；同日审查再把 T-05 后移）：T-17（半天，先验收现有成果）→ T-01 → T-06/T-07/T-08/T-09（无依赖并行池）→ 等 C-07/C-06 后 T-02/T-03 → T-04 → T-10 → T-11（M2）→ **T-24（阻断级，先通添加仓库）→ T-21（主题字体）→ T-22（壳结构）→ T-05 重做（工具行/问答卡新口径，要用 T-21 落的 token）→ T-12/T-13/T-14/T-15（四种 surface，均依赖 T-22）→ T-23（存量违规清理，与 surface 并行消化）→ T-16（新旧开关，须 T-24 在前）**→ T-25（旧模块原色硬编码清理，后置，须 T-21 在前）。

> **2026-07-29 顺序修订（D21~D23 拍板后，本段为现行权威）**：T-21 已落库 `b38017b`、T-24 代码已随之落库（剩 GUI 实测 + 补登）。开发线现行全序：**T-24 收尾（S0，不改代码）→ T-26（侧栏两层化）→ T-22（壳结构；与 T-26 都碰 LeftNav，串行）→ T-27（Composer 目标栏）→ T-28（中列状态化布局）→ T-05 重做 → T-12/T-13/T-14/T-15 → T-23 → T-16 → T-25**；**A07 基线与 T-26/T-22 并行制作、用户验收后 T-27/T-28 的观感部分方可施工**。T-05 的工具行/问答卡形态仍按 openchamber 口径不变（D23 边界）。

> **2026-07-28 顺序更正（T-05）**：原顺序把 T-05 与 T-04 并列在 T-10 之前，早于 T-21 / T-22，与 plantree 的 `T-24 → T-21 → T-22 → T-05 → T-23` 对不上。**本文件为权威**，现按「T-05 排在 T-21 / T-22 之后」统一——理由：T-05 新口径的工具行直接依赖 T-21 的 `--status-running` 等新 token 与 Flexoki 语义色，先做 T-21 可免二次返工；plantree 侧无需改动（本次即向其口径收敛）。
> **连带说明**：M3「卡片全套」含 T-05，故 **M3 / CP6 的达成时点随之落到 T-22 之后**（Phase 4 中段）。M3 其余构件（真实数据树 T-01 / Session 生命周期 T-02 / Resume 历史 T-03 / Thinking 卡 T-04）不受影响，可按原节奏先行完成并单独汇报，CP6 待 T-05 落地后一并确认。依赖关系图（§5）不变——依赖边没变，变的只是排期。

> **T-05 与 T-21 的先后**（2026-07-28 说明，同日审查后收紧豁免条件）：上面的起步顺序已把 T-05 排在 T-21 / T-22 **之后**，因此**常规路径下 T-05 开工时 token 已就位，用不上任何豁免**——直接用 T-21 落好的 `--status-running` 与 Flexoki 语义色即可。
> **豁免仅在一种情形下成立**：T-05 因排期变化被提到 T-21 之前。此时允许先在 `globals.css` 单独落 `--status-running` 这一个变量（顺带清掉 `MessageTimeline.tsx:419` 的 `bg-amber-500`），整套 Flexoki token 仍归 T-21，且该变量的值必须与 T-21 方案一致、不得先凑一个临时色。
> **任何顺序下都不允许**在 T-05 里就地写死颜色值。T-05 依赖列的 T-21 由此从「软依赖」明确为**顺序依赖**（仍非硬阻塞：提前做有且仅有上述一条豁免路径）。

### 产品设计基线补登（A01 / A05 / A06，2026-07-28）

> 这三项此前**只存在于可行性文档 §12 候选任务池**（[`2026-07-23-openchamber-ui-chat-refactor-feasibility.md`](./2026-07-23-openchamber-ui-chat-refactor-feasibility.md)`:989-1035`），**从未进入本执行计划或任何台账**；而同文档中 F05 声明依赖 A05+A06、H01 与 H09 声明依赖 A01+A06——**下游任务已施工、前置基线全缺**，这是当前 UI 观感不到位、死按钮泛滥、布局反复卡壳的同一个根因。现补登入账。
> 三者的产物统一为：[`docs/design/phase0a-openchamber-alignment.html`](../design/phase0a-openchamber-alignment.html)（2026-07-28 交付，用户已验收）。

| ID | 任务 | 内容要点 | 验收标准 | 状态 |
|---|---|---|---|---|
| **A01** | OpenChamber 参考界面清单（补登） | 冻结 OpenChamber 参考版本与 Light/Dark 基准，整理三列 + 44px 导轨骨架、11 种 surface 注册表、消息 / 工具行 / 问答卡形态、按钮顺序与关键状态。**冻结版本（2026-07-28 补记）**：commit `a3519141635990e3d75d79a7f902f8aa15386060` = `v1.17.0-6-ga3519141`，工作树 `/home/dan/projects/openchamber`，取证日期 2026-07-28（取证时无未提交改动）。Light/Dark 基准 = Flexoki Light / Flexoki Dark | 每个拟对齐区域有**指定版本**参考——全部 `file:line` 证据（`MainLayout.tsx:407-464` / `ContextPanelRail.tsx:157/166/82` / `lib/surfaces/registry.ts` / `parts/ToolPart.tsx:2306-2430`·`:2447-2476` / `ProgressiveGroup.tsx:566-773` / `QuestionCard.tsx:321-323` / `PermissionCard.tsx:121-123` / `ToolPart.tsx:1667-1730`）均以上述 commit 为准，**跨版本核对前先 `git checkout a3519141`**；Light/Dark 基准已冻结；**标准窗口尺寸本轮不冻结**——裁定只用到与窗口宽度无关的相对尺寸（280–500 / 380–1400 / 44 / 48rem·64rem），将来要做截图级比对再补测回填；「对齐 UI / 不复制功能」结论明确——已由 D18 / D19 / D20 三条裁定收口 | ✅ 已交付（2026-07-28，产物见上，用户已验收；版本冻结项 2026-07-28 审查后补记） |
| **A05** | 视觉 Token 方案（补登） | 基于 OpenChamber 源码与参考界面整理色板、字体、间距、区域尺寸、圆角、边框、阴影、图标与状态色，产出 Flexoki → ai-client OKLCH 语义 token 映射：Flexoki Light/Dark（亮 bg `#fffdf4` / fg `#100F0F` / primary `#BC5215`；暗 bg `#171515` / fg `#CECDC3` / primary `#DA702C`）+ 全等宽字体栈（sans / mono / heading 均 `ui-monospace`）+ 新增 `--accent-primary` / `--selection` / `--hover` / `--status-running`。同时记录两处现状缺陷：① **中性与品牌梯度**锁在色相 285.82（`--accent` / `--muted` / `--secondary` 三者同值，`--primary` 是中性反色），**缺品牌强调色**；状态三色 `--success` `oklch(0.527 0.154 150.07)` / `--warning` `oklch(0.769 0.189 70.08)` / `--info` `oklch(0.623 0.214 259.81)` 是**真彩色**（色相 150 / 70 / 260、彩度 0.15–0.21），问题在于三者**亮暗逐字同值**（`src/renderer/styles/globals.css:80-85` 亮 / `:110-115` 暗；`--destructive` 亮暗有别）——**2026-07-28 三次更新⑧ 收窄，原写「语义变量整套锁在色相 285.82 且无强调色」为误述，口径以 ARD §7 为准**；② 根字号 14px vs 16px。**全局按钮原语基线（2026-07-28 审查补记，自 T-05 移入）**：OpenChamber 的 `corner-shape: squircle` + 全小写字形出自共享按钮原语 `packages/ui/src/components/ui/button.tsx:37` 的 cva 基类（`rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] … lowercase tracking-[0.01em]`，尺寸档另有 `sm/xs/lg` 的 `rounded-[9px]/[7px]/[12px]`），属**全局 Button variants 基线**、不是某张卡片的局部形态——chat 侧多数按钮（如 `QuestionCard.tsx:530-556`）走原生 `button` + 普通 `rounded` + status 扁平着色，根本不用该原语。对齐时按「原语基线」处理，对应我方 `src/renderer/components/ui/button.tsx:10`（现为 `rounded-lg`，无 squircle 无 lowercase） | Light/Dark 映射明确、终端主题边界写清、业务组件不自行发明视觉值（D18 已据此拍板） | ✅ 已交付（**方案层**，2026-07-28，产物同 A01）；**代码落地另立 T-21** |
| **A06** | 功能接入状态矩阵（补登） | 逐个记录新壳可见入口的真实能力状态（`已接入 / 基础接入 / 禁用占位 / 暂不纳入`），并据此产出存量违规清单——可行性文档 §6.2「禁止按钮看起来可用但点击无反馈」「禁止用硬编码数据伪装真实 Runtime 状态」（`:422`）与 §1.8「不得把占位状态伪装成真实能力」（`:27`）的当前违反项 | 所有影响布局的按钮都有明确状态，不存在「看起来可用但实际无行为」的入口。**矩阵已交付并证伪当前实现**——违规清单见 T-23 | ✅ 已交付（**矩阵**，2026-07-28，产物同 A01）；**违规清理另立 T-23** |

---

## 4. 协作规则

### 文件所有权（避免双轨冲突）

| 区域 | 主导方 | 说明 |
|---|---|---|
| `src/agent-host/**`、`src/main/services/agent-host/**`、`src/main/ipc/chat.ts`、`src/preload`（chat 段） | 🤖 | 团队如需新 IPC，提需求给 Claude |
| `src/shared/types/runtimeEvents.ts`、`agentHost.ts`、`sessionHistory.ts`（2026-07-28 补入，C-17 要改它） | 🤖 | **协议 = 唯一汇合点**，见下 |
| `src/renderer/stores/chatSessions.ts` | 🤖 | 团队通过 store 暴露的 actions/selectors 消费，不直接改结构。**注意**：问答冻结逻辑已在 `:595-608` 实现（含 5 例幂等测试），T-05 只补 UI 渲染、不要重复实现 |
| `src/renderer/components/workspace-shell/**`、`chat/`（卡片/Timeline/Composer）、`src/renderer/styles/globals.css`（2026-07-28 补入，T-21 要改它） | 👥 | Claude 不主动改动，需要时提需求给团队 |
| 现有旧模块（AgentPanel 等） | 👥 日常维护 | Phase 5 收缩由 🤖 主导（C-12） |

### 同树提交纪律（2026-07-24 增，双向对撞事故后）

两个 Agent 会话共用一个工作树时，「`git add` → `git commit`」两步间存在竞态窗口（今日双向各中一次：对方暂存的文件被扫进己方提交）。**双方一律改用 pathspec 提交**：`git commit -m "..." -- <明确文件列表>`——无视暂存区内容，只提交列出的文件，竞态在机制上不可能发生。禁止裸 `git commit`/`git commit -a`。

### 协议变更纪律

1. 变更 `shared/types/runtimeEvents.ts` / `agentHost.ts` / `sessionHistory.ts` 必须由 Claude 主线发起，先落类型与文档，再动实现；
2. 破坏性变更 bump `AGENT_HOST_PROTOCOL_VERSION`；
3. 变更后在总台账记一行并通知对方；CP4（`session.history`）定稿前团队不要动 Resume 数据层。

> **2026-07-28 补（D20 连带）**：`sessionHistory.ts` 的 `HistoryBlock`（`:11-30`）目前只有 `text | thinking | tool_call | tool_result`，**没有 question / permission**，因此历史重放时问答块必然 `return null`（`stores/chatSessions.ts:236-237`）。这是 ai-client 保留「就地冻结」而不照搬 OpenChamber「回答后消失」的直接原因（D20 登记为有据可依的偏离）。扩该联合类型归 **C-17**，属主线协议变更、走本节纪律；在 C-17 落地前，T-05 **不得**把问答卡做成回答后消失。
>
> **测试凭证约定（下一节）本次未受影响**：T-21 / T-22 / T-23 / T-24 / T-25 均为 Renderer 侧改造，不新增网关调用；T-21 的中英混排实测、T-24 的全新机器验证走 GUI 手工点验路径，凭证仍按下一节统一约定。

### 测试凭证统一约定（用户拍板 2026-07-23）

**所有测试（smoke / spike / 打包验证 / GUI 点验）一律不得直接使用本机默认 Claude 登录环境**，统一走共享测试网关：

```json
"ANTHROPIC_AUTH_TOKEN": "sk-4b0688c61944931297f2aee4ecfa0022",
"ANTHROPIC_BASE_URL": "https://cch-jyw.pipidan.qzz.io"
```

| 场景 | 用法 |
|---|---|
| Host 侧脚本（`src/agent-host/spikes/*-smoke.ts`） | 已内置：`spikes/testCredentials.ts` 自动生成临时 `CLAUDE_CONFIG_DIR`（网关凭证 + onboarding 种子），零配置直接跑 |
| 换网关 / 换 token | 环境变量 `AICLIENT_TEST_AUTH_TOKEN` / `AICLIENT_TEST_BASE_URL` 覆盖默认值 |
| **备用网关**（用户提供 2026-07-24，PONG 实测通过；临时 key，用户拍板落文档） | `AICLIENT_TEST_AUTH_TOKEN=sk-BRw0enymSWB11aR0MrszvxjfTr34ED3jbqGVQdGFRZ0bVBjE` + `AICLIENT_TEST_BASE_URL=https://api.vllmproxy.com`；延迟/波动与主网关同级（双端点同时刻齐挂实测过——波动是环境性的），主网关不可用时切换 |
| 排查对照需要本机登录 | `AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1`（仅限排查；**验收证据必须走网关**） |
| GUI 手工点验（开发态 / 打包态） | 当前 GUI 读 `~/.claude/settings.json`：点验前将上述两项写入其 `env` 段；「Host 侧 CLAUDE_CONFIG_DIR 注入」已列主线候选需求（见团队台账 T-17 行） |

> 注：团队台账 T-17 行曾按「token 不入库」执行；2026-07-23 用户拍板改为**统一落文档以本节为准**。如需收紧为脱敏引用，由用户决定后统一调整。

### 完成定义（DoD，双轨通用）

- 代码 + 验收证据（命令输出或操作记录）+ 对应子台账加行（附提交 hash）；
- `pnpm typecheck` / `pnpm lint` / `pnpm test` 三绿；
- 提交遵循 Conventional Commits（中文描述，见 CLAUDE.md）；
- 加密机相关项**永远不得**在开发机标注通过（Phase 0 报告纪律延续）。

---

## 5. 依赖关系图

```text
🤖 C-01 → C-02 ──→ 👥 T-10 ──→ 👥 T-11 (M2, CP5)
🤖 C-07 ──────────→ 👥 T-02 ─┐
🤖 C-06 (CP4) ────→ 👥 T-03 ─┼→ M3 (CP6) → Phase 4 → Phase 5 (C-12+回归, M5)
🤖 C-05 (CP3) ────→ 👥 T-04 ─┤
🤖 C-03 → C-04 ───→ 👥 T-05 ─┘
🤖 C-09 → C-08（store 结构，先锁行为再改结构）
👥 T-01 / T-06..T-09 / T-17：无依赖，随时可做

Phase 4（2026-07-28 按 D18/D19 重画）：
📐 A01 / A05 / A06 ✅（设计基线，2026-07-28 补登交付）
   ├─ A05 ──→ 👥 T-21（Flexoki 主题 + 全等宽字体）─┐
   ├─ A01 ──→ 👥 T-22（三列 + 44px 导轨 + surface）─┼→ 👥 T-12 / T-13 / T-14 / T-15（git/editor/context/terminal surface）
   └─ A06 ──→ 👥 T-23（存量违规清理：死按钮 + 假 usage 环）
👥 T-21 ──→ 👥 T-25（旧模块原色硬编码清理，47 文件，后置）
👥 T-21 ──→ 👥 T-05 重做（顺序依赖，非硬前置；2026-07-28 起排在 T-22 之后，M3/CP6 随之后移）
👥 T-24（新壳添加仓库，阻断级，无依赖）──→ 👥 T-16（新旧开关可逆性）←── T-12..T-15
🤖 C-17（问答进历史协议）：后置，D20 明确本轮不做；做完才可重评「回答后消失」形态
```

> 关键读法：**T-22 是 T-12~T-15 的硬前置**（四者都改叫 surface，没有壳结构就无处安放）；**T-24 优先于 T-16**（T-24 落地前，切回旧壳是新机器唯一的非 argv 注册手段）；T-21 与 T-22 可并行（一个改 token、一个改骨架），但 T-21 先行能让 T-22 少返工；**T-05 重做排在 T-21 / T-22 之后**（2026-07-28 顺序更正，见 §3 起步顺序），故 M3「卡片全套」的达成时点落在 Phase 4 中段，M3 其余构件不受影响。

## 6. 工作量汇总（估）

| 轨道 | 近期（Phase 2 收尾 + Phase 3） | Phase 4 | Phase 5 | 合计 |
|---|---|---|---|---|
| 🤖 Claude 主线 | C-01~C-10 ≈ 10.5d | 支援 | C-12 ≈ 2.5d（+机动 C-11 1.5d） | ≈ 13~14.5d |
| 👥 团队轨道 | T-01~T-11、T-17 ≈ **13d**（2026-07-28 重算） | T-12~16 ≈ 5.5d **+ T-21~T-24 待估** | 回归分摊 ≈ 2d **+ T-25 待估** | ≈ **20.5d** **+ T-21~T-25** |

双轨并行、含联调与波动，预计 **4~5 周**到 M5（与可行性报告双人 5~8 周口径一致，因 Phase 0/1/2 已完成大半而缩短）。

> **2026-07-28 修订说明**：D18 / D19 新增的 T-21（主题字体）、T-22（壳结构）、T-23（存量违规清理）、T-24（添加仓库通路）、审查后补立的 T-25（旧模块原色清理，47 文件）与后置的 C-17 **尚未估时**，故上表 Phase 4 与合计列均未包含它们，「4~5 周到 M5」的口径**在这五项估时回填前不成立**。估时回填后同步更新本节与总台账。
>
> **2026-07-28 二次修订（团队轨道估时重算）**：近期列原写「≈11.5d」，与团队任务表内逐项估时对不上。逐项相加（T-01 2 + T-02 1.5 + T-03 1 + T-04 0.5 + T-05 2 + T-06 1 + T-07 1.5 + T-08 0.5 + T-09 1 + T-10 0.5 + T-11 1 现场 + T-17 0.5）= **13d**，合计列随之 13 + 5.5 + 2 = **≈20.5d**。差额 1.5d 的来源：T-05 由 1.5d 上调为 2d（口径整体重写）那 0.5d **此前只写在说明里、没落进汇总表**，另有 1d 是原口径本身的加总误差。表与说明现已改到一致。
>
> **另注（同日审查发现，未改数）**：主线行「C-01~C-10 ≈ 10.5d」按字面口径正确，但 2026-07-24 之后新增的 **C-13（1d）/ C-14（0.5d）/ C-15（1d）共 2.5d 不在任何一列内**，主线合计「≈13~14.5d」因此偏小。是否并入由主线负责人在下次估时回填时一并处理，本轮不擅改主线数字。
>
> **另注二（2026-07-28 复验轮，未改数，与上条对称）**：团队轨道「近期」列口径写「T-01~T-11、T-17 ≈ 13d」，但已落地的 **T-18（1d）/ T-20（0.5d）共 1.5d** 既不在这个任务区间内，也未单独并进 Phase 4/5 两列，团队合计「≈20.5d」因此同样偏小。是否并入由团队轨道负责人在下次估时回填时一并处理，本轮不擅改数字。

## 7. 用户反馈 → 任务映射（2026-07-24 收集，对比 VS Code 使用体验）

| # | 反馈 | 映射 | 动作 |
|---|---|---|---|
| F1 | 看不到分析了哪些文件，不能点击跳到代码关键位置 | **T-05**（工具行已含 Read/Edit→路径摘要行）+ **T-13**（`editor` surface） | T-05 验收增强：工具行中的文件路径**可点击**，跳转 `editor` surface 并定位；T-13 联动。**2026-07-28 补**：T-05 新口径把交互拆成「点最左侧图标位 = 切换展开、点行体其余部分 = 打开文件」，两者互不误触 |
| F2 | 对话框不能粘贴图像和文件 | 原 T-07 明确不做图片，按反馈提级 | 新增 **C-13**（附件协议 spike + 桥接）→ **T-18**（Composer 粘贴 UI） |
| F3 | 回复没条理、看着懵；是否要换模型 | 气泡化 + markdown 渲染 + 卡片折叠（Phase 1-3 主体）直接回应；**T-08** 模型选择器让用户可自行换模型 | 无新任务；新壳内测后拿同样问题复评一次，仍懵再议 system prompt/模型默认值 |
| F4 | 对话框像命令行，不能在任意位置加字/修改 | 旧 AgentPanel 是终端；新壳 Composer 是真实文本域 | 已由重构解决（Phase 1 完成项），T-10/内测确认 |
| F5 | 对话框和代码框不能并排，无法边看代码边看分析 | ~~四区壳~~ **三列壳**（D19）本身即并排布局；**T-13** `editor` surface + Monaco | 已在计划内；此反馈作为 T-13 优先级依据（Phase 4 内优先做）。**2026-07-28 补**：D19 后由「Main 阅读栏（`min(100%, 48rem)`）+ ContextPanel（380–1400）并列」直接满足；T-13 此前因布局未定而冻结，现随 D19 解冻 |

> 结论：5 条反馈中 3 条（F3/F4/F5）验证了本次重构方向，1 条（F1）是既有任务的验收增强，1 条（F2）新增 C-13/T-18。

## 8. 执行层风险提示

1. **C-01 打包是最大不确定性**：SDK/Cometix 嵌套依赖形态（cli.js 路径解析、wasm、win32-x64 原生包）。超期时优先保「整树拷贝跑通」，瘦身后置。
2. **C-06 JSONL 格式漂移**：格式属 CC 内部实现；pin 2.1.212 缓解；解析必须宽容（未知行跳过），崩溃兜底 = ARD 后置项「历史快照」。
3. **T-01 触碰现有 stores**：只读派生、不改写现有 store 行为，避免影响旧界面。
4. **Question 形态若 SDK 无原生支持**：fallback = 按 permission 流拦截 AskUserQuestion 工具（C-03 已列）。
5. **联调错峰**：C-06/C-07 延期时团队先消化无依赖池（T-06~T-09），不空转。
6. **（2026-07-28，D18）全等宽字体的中英混排是 T-21 最大不确定性**：sans / mono / heading 三者统一 `ui-monospace` 后中文会回退系统字体，等宽拉丁字形与非等宽 CJK 混排可能崩行内节奏与标点对齐。必须在阅读栏正文、左栏 Session 树、工具行摘要三处实测截图后再定；崩得不能看的回退方案 = 保留全等宽给 UI chrome、正文 CJK 走系统 sans（plantree open-questions #10）。
7. **（2026-07-28，D18）根字号 14→16 影响面未评估**：现为 `globals.css:63,149` 的 14px，全仓 rem 实际值 ×14/16（`--radius: 0.5rem` 真实是 7px）。改成 16px 才能对上 OpenChamber 的 48rem / 64rem 阅读栏与 44px 导轨基线，但会**同时冲击旧壳与全部现有页面**，且 `h-9` / `h-7` / `h-6` 这类 Tailwind 固定档位不随 rem 缩放、比例会变。**T-21 开工前先出评估结论**，别边改边试（open-questions #11）。
8. **（2026-07-28，D19）T-22 是 Phase 4 的单点瓶颈**：T-12~T-15 四项全部依赖它，T-22 延期即四项齐停。超期时优先保「三列骨架 + surface 单选切换」跑通，Rail 图标拖拽排序、surface 提升为全视图可后置。
9. **（2026-07-28）T-24 是阻断级缺口，不排进 Phase 4 尾巴**：新壳「添加仓库」当前完全不可达，新机器唯一注册通路是 `--open-path` argv。它同时是 T-16 恢复开关可逆性的前提（可逆性一旦恢复而添加仓库仍不可达，用户会被卡在空壳里）。
10. **（2026-07-28，D18/D6 撤销边界）终端与 Monaco 主题去留未裁定**：`resources/ghostty-themes/`、`scripts/generate-themes.ts`、`lib/ghosttyTheme.ts`、`monacoTheme.ts` 在裁定前**原样不动**（T-21 已明写为边界外）。风险是应用壳 Flexoki 与终端/编辑器 Ghostty 派生两套配色并存的观感割裂——可接受与否待 open-questions #12 收口。
