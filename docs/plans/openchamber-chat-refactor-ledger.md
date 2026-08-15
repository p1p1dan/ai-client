# OpenChamber 气泡对话重构 — 总台账

> 分支：`feat/openchamber-chat-refactor`  
> 权威：[`2026-07-23-openchamber-chat-refactor-ard.md`](./2026-07-23-openchamber-chat-refactor-ard.md)  
> 执行计划：[`2026-07-23-openchamber-chat-refactor-execution-plan.md`](./2026-07-23-openchamber-chat-refactor-execution-plan.md)（双轨任务表 + 协作规则）  
> 术语：[`../../CONTEXT.md`](../../CONTEXT.md)  
> Phase 0 证据：[`phase0-report.md`](./phase0-report.md)  
> Phase 0A 基线：[`../design/phase0a-openchamber-alignment.html`](../design/phase0a-openchamber-alignment.html)（A01 / A05 / A06 统一产物，2026-07-28 用户已验收）  
> 最后更新：2026-07-29（D21~D24 拍板：侧栏两层化 / Composer 目标栏 / 中列 Cursor 化 / 工具行与问答卡改判 + A07 基线立项）

> ℹ️ **2026-07-24 起规划入口迁移**：当前任务状态 / Active TODO / 未决问题看
> [`docs/plantree/`](../plantree/README.md)（唯一活动状态视图）。本文件保留三样权威内容：
> **Phase 状态总览、已拍板决策（D1~D24）、里程碑检查点（CP-x）**——均 append-only。

**维护规则**：里程碑（M1~M5）/ 确认点（CP-x）/ Phase 级结果回填本文件检查点表；日常状态更新只动 plantree。不要把旧 `PROGRESS.md`（bug 清单 / 已废弃拷贝路线）当本主线台账。

**分账规则（自 2026-07-23 起双轨执行）**：本文件只保留 **Phase 状态总览、拍板决策、里程碑级检查点与确认点（CP-x）结果**。过程明细分两条子台账记录：

| 轨道 | 范围 | 台账 | 维护人 |
|---|---|---|---|
| 🤖 Claude 主线 | 复杂/架构攸关任务（C-xx：打包链、协议、Host、Store 结构、探测类） | [`ledger-claude-mainline.md`](./ledger-claude-mainline.md) | Claude |
| 👥 团队轨道 | 常规实现 / GUI 打磨 / 真机与加密机验收（T-xx） | [`ledger-team-track.md`](./ledger-team-track.md) | 用户 / 同事 |

任务归属、依赖与验收标准以执行计划为准；里程碑（M1 打包链通 / M2 加密机验收 / M3 Chat MVP / M4 接线 / M5 收口）完成时回填本文件检查点。

---

## 状态总览

| Phase | 名称 | 状态 | 说明 |
|---|---|---|---|
| 0 | 技术 Go/No-Go | ✅ 正式 Go（2026-08-15） | 开发机项全部完成；加密机现场 T-11 六项实证通过（CP5，含 ⑥ TSD 白名单口径） |
| 0A | 高保真产品基线（A01~A06） | ✅ 收口（2026-08-15，D43） | A01/A05/A06 补做交付（2026-07-28，产物对齐基线 HTML，拍板 D18/D19/D20）；A02/A03/A04 经 **D43** 裁定「被演进取代」（A02→baseline/module-map；A03→D21/D22 + T-26/T-27；A04 不补作，状态行为由 vitest 3339 例钉住）。取代清单见决策表 D43 行 |
| 1 | UI Shell（Mock） | ✅ 完成 | 四区壳可交互；Beta 开关接入 |
| 2 | Runtime Vertical Slice | ✅ 完成（2026-07-24） | 主路径 + Permission/Question 桥 + Resume 历史 + 附件 + 看门狗 + 打包链（C-01~C-07/C-13~C-15）全量；唯 stream-json fallback 后置为 C-11 机动 |
| 3 | Chat MVP | 🟡 进行中 | **本行只记 Phase 级结论，任务级明细一律以 plantree 为准**（2026-07-28 改口：原逐任务枚举「T-02/03/04/06/07 待 GUI 联调」已过期，双份维护是漂移根因）。当日快照：T-01 / T-08 / T-17 ✅；**T-02 / T-03 / T-07 主体已于 2026-07-26 GUI 复验通过**；其 2026-07-27 增量（T-03 `7a5c2cd` 历史读失败 UI、T-07 `0f886a8` @ 引用补强四项）与 **T-18 / T-20**（`703f981` / `4c3f67e`）同属**已落地待人工点验**，点测清单见 plantree roadmap（2026-07-28 复验轮更正：原句用 07-26 主体复验结论背书 07-27 才产生、尚未点验的增量提交，把两批提交的验收状态混同了）；store 优化 C-08 ✅。未收口：T-04 🔴 卡网关、T-05 ⬜ 未开工（口径 2026-07-28 整体重写）、T-06 ⬜ 未测、T-09 🟡 用户暂跳过验收 |
| 4 | 现有能力重新接线 | ⬜ 未开始 | |
| 5 | 收口与正式版 | ⬜ 未开始 | |
| 6 | 按需增强 | ⬜ 后置 | |

图例：✅ 完成 · 🟡 条件通过 / 进行中 · ⬜ 未开始 · ⏳ 待特定环境 · ❌ 阻塞

---

## 已拍板决策（勿再争论）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 运行时宿主 | 外部白名单 Node 24 Agent Host；不升 Electron |
| D2 | UI/数据层 | 自建 UI on `@coss/ui`；不拷 OpenChamber sync/store |
| D3 | 导航 | Project > Workspace > Session；保留 Worktree |
| D6 | 视觉 | 对齐布局架构，非色调；沿用 OKLCH |
| D8 | Cometix | 打包进 Host；固定 `2.1.212` |
| D9 | Host 驱动 | **默认 `agent-sdk`**；`stream-json` fallback（`DEFAULT_AGENT_HOST_DRIVER`） |
| D10 | 其他 Agent | 暂留终端模式；仅 Claude 进气泡 |
| D11 | 历史 | Host 读 CC JSONL；本地只存索引 |
| D15 | 右栏 | MVP 单层 `git \| files \| context` |
| D16 | vflow | **整体移除**（用户拍板 2026-07-24，不再需要）：Phase A 打包/CI 链 `dbb20be` + Phase B 运行时代码 `eac23f7`，全仓 vflow 引用清零 ✅ |
| D17 | Host Node 来源 | **随包独立 Node（打包态首选）+ 现有五源解析兜底**（用户拍板 2026-07-24）。依据：TSD 白名单**按进程名**——「只要是 node 就是白名单」（用户口径；注意 Electron 内嵌 node 进程名是 electron.exe **不**匹配，ARD 当年否决内嵌路线的理由依然成立）；随包 node.exe 同时解 T-09「用户自装 Node 24」痛点。→ 立项 **C-15**；加密机实证（白名单口径 + 随包 node 读 TSD）归 T-11，开发机不得标注通过 |
| D18 | 视觉（撤销 D6） | **Flexoki 主题 + 全等宽字体 + 卡片形态三者一并对齐**（用户拍板 2026-07-28：「对齐 OpenChamber 的观感，聊天卡片直接照它的做，UI 风格也照做」）。**撤销 D6**（原口径：对齐的是 UI 架构与布局、非色调风格严格一致；沿用现有设计系统 `@coss/ui` + OKLCH token；Flexoki 仅作可选后续主题、非 MVP 硬性目标）。依据（实证）：现有语义变量整套锁在色相 285.82，`--accent` / `--muted` / `--secondary` 三者色值完全相同；`--primary` 是中性反色而非品牌色（亮 `oklch(0.205 0.014 285.82)` 近黑、暗 `oklch(0.985 0 0)` 近白），满屏 `text-primary` 实为「最高对比度正文色」；`success` / `warning` / `info` 在亮暗下同值——**整套配色没有强调色**，沿用它对不出 OpenChamber 观感（`src/renderer/styles/globals.css`）。落地口径：① 主题 = Flexoki Light/Dark（OpenChamber 默认主题）：亮 bg `#fffdf4` / fg `#100F0F` / primary `#BC5215`，暗 bg `#171515` / fg `#CECDC3` / primary `#DA702C`；② 新增 `--accent-primary` / `--selection` / `--hover` / `--status-running`，其中 `--status-running` 替换 `src/renderer/components/chat/MessageTimeline.tsx:419` 的 `bg-amber-500`（全仓唯一的 Tailwind 原色硬编码）；③ 字体 sans / mono / heading 三者统一为 `ui-monospace`（OpenChamber 就是全等宽 UI），**已知代价**：中文回退系统字体、中英混排宽度节奏需实测（→ open-questions #10）；④ 根字号 `src/renderer/styles/globals.css:63,149` 现为 14px，OpenChamber 是浏览器默认 16px，导致全仓 rem 实际值 ×14/16（`--radius: 0.5rem` 真实是 7px 而非 8px），改不改与影响面单列（→ open-questions #11）。**本条未涉及**终端 438 Ghostty 主题与 Monaco 跟随 Ghostty 的去留（D6 撤销的连带边界 → open-questions #12）。产物基线：`docs/design/phase0a-openchamber-alignment.html`（用户已验收）。→ 补登 **A05**；代码落地立项 **T-21** |
| D19 | 布局骨架（撤销 D15） | **三列 + 44px 图标导轨 + surface 模型，废弃底部面板**（用户拍板 2026-07-28）。**撤销 D15**（原口径：MVP 做单层可折叠右栏 `git \| files \| context`，并排挤宽、不替换 Chat 页；OpenChamber 的内层 ContextPanel 双层结构后置）。依据：真实 OpenChamber 不是四区、**没有底部面板**——`packages/ui/src/components/layout/MainLayout.tsx:407-464` 是三列骨架；`ContextPanelRail.tsx:157` 是固定 `w-11`（44px）图标导轨，可拖拽排序、surface 有内容时右上角 6px 圆点；`lib/surfaces/registry.ts` 注册 11 种 surface（editor / git / pr / diff / terminal / plan / notes / context / browser / preview / chat）——**终端在 OpenChamber 里只是其中一种 surface**，也可提升为覆盖 main 的全视图，不是底部 Dock。尺寸基线：Sidebar 默认 280、可拖 280–500；ContextPanel min 380 / max 1400、默认按 surface 类型取可用宽度比例；聊天阅读栏 `width: min(100%, 48rem)` 居中、宽模式 64rem。ai-client 现状：`src/renderer/components/workspace-shell/WorkspaceShell.tsx:31-32` 硬编码 RightDock 320 / BottomDock 220，且两者均不可拖拽。**影响**：ARD §4 目标产品结构图重画（原图含底部终端 Dock），§1/§7/§8/§9/§11/§13 连带改口；**T-15** 从「底部终端 Dock」重定义为「终端 surface」；**T-13** 从「右栏 Files 面板」重定义为「editor surface」并**解冻**（此前因布局未定而冻结）；T-12 / T-14 同步改为 git / context surface。→ 立项 **T-22**（壳结构改造，`BottomDock.tsx` 随之废弃） |
| D20 | 问答归宿 | **问答卡保留「就地冻结」，不照搬 OpenChamber 的「回答后消失」——登记为有据可依的偏离**（用户拍板 2026-07-28）。OpenChamber 侧机制：Question / Permission 卡回答后直接 `return null`（`QuestionCard.tsx:321-323`、`PermissionCard.tsx:121-123`），历史里改由 ToolPart 的 question 分支重新渲染成只读 Q/A（`ToolPart.tsx:1667-1730`）——**「消失」成立的前提是历史里有问答**。ai-client 不具备该前提：`src/shared/types/sessionHistory.ts:11-30` 的 `HistoryBlock` 联合类型只有 `text \| thinking \| tool_call \| tool_result`，没有 question / permission，历史重放必然 `return null`（`src/renderer/stores/chatSessions.ts:236-237`）；照搬「消失」会导致用户的回答**完全无痕**。**解除前置** = 扩 `HistoryBlock` 协议 + 让 Host 把问答写进历史，**本轮不做** → 立项 **C-17**（后置）。**注意**：store 侧冻结逻辑**已经实现**（`src/renderer/stores/chatSessions.ts:595-608` 打 `resolved` / `questionOutcome` / `questionAnswers` / `questionResponse`，含 5 例测试覆盖幂等），T-05 缺的只是 UI 渲染，不要重复实现。本条为**偏离登记**，不推翻任何既有决策（D12「权限/提问 UI 进时间线卡片」继续有效） |
| D12 | 权限/提问 UI | 对话时间线内卡片（PermissionCard / QuestionCard），不只靠全局弹窗。**原载 [ARD](./2026-07-23-openchamber-chat-refactor-ard.md) §3，2026-07-28 补录进本表，非新决策**（补录原因：D20 正文引用了它，而本表此前缺行，顺链查证会落空）；现行状态见 ARD §9 MVP 矩阵「Permission 卡 / Question 卡」行，问答卡形态口径归 **T-05**，就地冻结 vs 回答后消失的偏离登记见 **D20** |
| D14 | MVP 范围 | 见 ARD §9：#1 文件引用进 MVP；#2 Effort / Plan / Build 进 MVP 但**条件性**（Runtime 不支持则隐藏/禁用）；#3 Diff 专用卡后置。**原载 ARD §3，2026-07-28 补录进本表，非新决策**（补录原因：本表标称收录 D1~D20，缺行会让「按编号顺链查」失效）；落地承接 = 文件引用 T-07 ✅ / Effort 选择器 T-20 / Plan 待主线 canUseTool 只读约束 |
| D21 | 侧栏信息架构（用户拍板 2026-07-29） | **侧栏「文件夹 → 对话」两层平铺（flat）**，`Workspace(worktree)` 从树层级降级为会话的**运行目标属性**：非 main worktree 的会话行显示分支 chip、main 不显；候选的 `by-worktree` 吸顶分组带**被用户否掉**（「更喜欢方案二」）。**2026-07-29 补记（用户追加裁定）：main/master worktree 的会话行也显示分支 chip（显实际分支名），推翻本行原「main 不显 chip 防噪音」规则——即所有会话行均带分支 chip，temp/remote 仍显 kind 标签。**会话行右对齐相对时间、「Repositories」段头带筛选/添加图标位——视觉参照用户提供的 Cursor 侧栏截图 [`docs/design/refs/cursor-20260729/侧栏样式.png`](../design/refs/cursor-20260729/侧栏样式.png)。**Recent 段保留**（openchamber 口径：未归档 + 非子会话 +（活跃 或 48h 内），默认 7 条 + Show more，可整段关闭；数据源用已落盘 `session-index.json`），用户保留否决权（「后面不喜欢再删」）。**subagent 层后置**（Host 协议无子会话实体；数据源双路径 open-q #17，建议 Path B 读磁盘 `subagents/**` 先行）。Workspace 选择权唯一移交 Composer 目标栏，`selectedWorkspaceId` 从 LeftNav 移除。依据：双盲设计（deep-reasoner/Opus 与 Codex 独立取证）核心裁定全部收敛 + openchamber 同款取舍（worktree 数据层保留、渲染层移除，`sidebar/DOCUMENTATION.md:6,13`）。设计全文 [`2026-07-29-sidebar-composer-target-bar-design.md`](./2026-07-29-sidebar-composer-target-bar-design.md) → 落地 **T-26** |
| D22 | Composer 目标栏（用户拍板 2026-07-29） | **Composer 目标栏 = 文件夹下拉 + 分支下拉 + 运行位置只读指示器**。分支下拉 = **worktree 选择器 + 新建 worktree 入口，禁止 in-place `git checkout`**（三条理由双方案独立给出：git 禁同分支双 checkout，worktree manager 里换分支天然=换 worktree；in-place checkout 会在可能运行中的 agent cwd 底下换工作树；与产品定位「一分支一 worktree」冲突）；未物化分支点击 → 进 `CreateWorktreeDialog` 预填；`New Worktree` 归分支下拉（openchamber 同款）。**运行位置 = 派生只读指示器**（local → `This PC`、remote → 连接名，数据源 `useRepositoryRuntimeContext`；数据缺失时隐藏、不硬显）——用户拍板「方案一，以后开远程功能再加上（下拉）就行」。文件夹下拉：搜索 + Recents（`session-index.json` 派生）+ Repos 分组 + `Use Existing…`/`Clone…`/`Add Remote…`/`New Folder`（→ 建 Temp 工作区，复用现成 `tempWorkspace` IPC）。**目标改变三档规则**：空且未 host-bound → retarget；有消息或已绑 → fork；运行中 → blocked。关键流程断言：`cwd === 新 workspace.path` 且 checkout IPC 零调用。→ 落地 **T-27** |
| D23 | 中列布局与观感改向 Cursor（用户拍板 2026-07-29；D18 范围内偏离登记） | **中部对话栏（Main 列）整体对齐 Cursor 风格，不再做「底部聊天软件式」常驻布局**（用户原话：「中部对话栏请对齐它。不要做成现在这种底部的聊天软件风格」）。两态：**空态** = Composer 卡片垂直居中、目标栏在卡片上方一行（参照 [`初始未发消息状态.png`](../design/refs/cursor-20260729/初始未发消息状态.png)）；**会话态** = 时间线在上、Composer 沉底为 follow-up 输入、目标行（分支 + 运行位置）移到 Composer 下方（参照 [`发起对话后状态.png`](../design/refs/cursor-20260729/发起对话后状态.png)）；模型/Effort 仍在 Composer 卡片内。**边界**：只改中列骨架与 Composer/目标栏观感；工具行/问答卡形态仍按 T-05（openchamber 口径）不变；D19 三列 + 导轨骨架不变；Cursor 截图中的**会话 Tab 栏是否引入未拍板**（A07 基线出带/不带两版，验收时定）。**前置纪律**：先补观感基线 **A07**（Cursor 截图 × Flexoki token 融合的 HTML 产物，用户验收后 T-27 / T-28 方可施工）——延续 Phase 0A「先基线后施工」教训。→ 立项 **A07**（基线）+ **T-28**（中列状态化布局） |
| D24 | 工具行/问答卡形态改判（用户拍板 2026-07-29，撤销 D23 的「时间线内部不动」边界句） | **工具行与问答卡的形态源从 openchamber 改为 Cursor**——用户在 Cursor 中专门触发两类组件的调用展示并存图（问答演示中明确选择「是，给 MessageTimeline 工具卡/Question 卡做参考」），五张截图入库 [`docs/design/refs/cursor-20260729/`](../design/refs/cursor-20260729/)（工具行-进行中 / 工具行-聚合展开+问答折叠条 / 问答卡-展开选项 / 问答卡-回答后Answers冻结 / 待定-点击历史消息重新编辑）。**工具行口径**：动词开头、无图标、无边框的灰阶单行（`Ran …`/`Grepped … in <repo>`/`Reading <file>`/`Searched files <glob>`），动词深灰、参数浅灰；多次调用**聚合**为 `Explored N files, M searches ▾` 可展开明细；思考块折叠为 `Thought briefly / for Ns ▾` 单行；回合级时长行 `Worked for Ns ▾`。**问答卡口径**：折叠态 = 全宽 `Questions` 横条（多题带 `1 of N` 分页）；展开态 = 带边框卡 + **A/B/C/D 字母行选项** + `Other…` 行；底部 `Skip` + 强调色 `Continue`；**回答后就地冻结为 `Answers` 只读卡——与 D20 一致，D20 不动**；跳过态 `Questions skipped`（逐题标 `Skipped`）；问题挂起时 follow-up 输入框 placeholder 变 `Add more optional details…`。**连带**：D23 正文中「工具行/问答卡形态仍按 T-05（openchamber 口径）不变」一句**作废**（append-only，原文保留以本条为准）；**T-05 需第二次改写口径**（2026-07-28 的 openchamber 形态细节作废，改以 Cursor 截图与 A07 v2 基线为准，开工前完成改写）；A07 基线补工具行/问答卡两屏（v2）。**另**：「点击历史消息重新编辑」截图用户标注**此功能待定**——仅归档不立项。 |
| D25 | D18 字体条款修订：全等宽 → 分域字体（用户拍板 2026-07-30，「我希望能做到 Cursor 那种协调的美感」） | **UI 域改比例字体（`--font-sans`），等宽（`--font-mono`）只保留给代码/路径/分支/终端**；Flexoki 调色板与卡片形态条款一字不动（D18 其余部分继续有效）。依据（观感审计 [`polish-audit-20260730.md`](../design/polish-audit-20260730.md)）：① 等宽回退链多数系统仅 Regular/Bold 两档，`font-medium`(500) 不可靠 → design-system 规定的 weight×letter-spacing×color 层级三件套塌掉一维；② `tracking-*` 全仓生产代码仅 1 处使用；③ 280px 侧栏等宽 14px 仅得 13 字符（比例字体 +23%）；④ 用户判定现状「一团乱麻」而 Cursor（比例字体）「协调有美感」。**连带**：open-questions #10（全等宽中英混排风险）以此结项（风险坐实并升级为方案变更）；`docs/design-system.md` 字体族/Typography 节需按分域改写；A07/phase0a 两基线的字体口径标注修订；落地归 **T-30**。 |
| D26 | A07 四条修订 + Markdown 渲染立项（用户拍板 2026-07-30，观感审计批次 2 前置） | **A07 修订四条**（锚点见审计文档）：① 失败工具行「整行红」→ **分级红**（行头 destructive、参数降档，防连环失败满屏红）；② 失败自动展开 → **加簇规则**（连续失败只自动展开首个）；③ 侧栏 chip 封顶 112px 放宽；④ user 气泡「右对齐 max-w 85%」→ **满宽**（连带 A01 同条）。**Markdown 渲染立项 = T-29**（方案一：复用依赖树内 `react-markdown`+`remark-gfm`+`shiki`，chat 专属组件映射不复用文件预览那套；一期不渲染远程图片、链接仅 http(s) 走 shell.openExternal；流式期纯文本、完成后切渲染——实为补交付，ARD §9 早已将 Markdown 标 ✅）。观感打磨施工归 **T-30**（审计批次 1+2），T-23 交叠三项仍归 T-23。 |
| D27 | 右栏骨架回归 A08（用户拍板 2026-08-05；**部分撤销 D19**） | **右栏骨架回归 [A08 定稿](../design/a08-final-context-panel-baseline.html)**，即撤销 [T-12~T-15 规格](./2026-08-04-t12-15-surface-spec.md) §7「A08 正式化对照表」中「被取代」十一项的**多数**——回归项含：panel 恢复 tab 条 · Rail 恢复「联动收展（仅收起时渲染）」 · 顶栏恢复贯通中右 · 恢复 L0/L1/L2 画幅降级梯（1580 / 1244）与 manualPanel/manualChat · editor 回中列（**范围待确认，见下**）。**三项豁免维持现状（用户逐条点名）**：① **terminal 维持 surface 形态、不回底部 Dock**（原话「D19 做的 terminal 可以保留下来，先不要底部的」）——D19「废弃底部面板」条款**继续有效**，`BottomDock.tsx` 不复活；② **context 内容维持现状三组真实字段**，不加 A08 的 Quick notes / Todo / Plans（用户理由「毕竟没有其他数据源」，与 A06 诚实原则同向）；③ **git 维持当前最小集**（changed/staged/diff/commit），不加 A08 的 branch / pr / sync / stash 全套。**故 D19 只被部分撤销**：其「废弃底部面板」有效，「三列 + 导轨 + surface 模型」中与 A08 冲突的部分（Rail 常驻 · editor 进右栏 · 无 tab 条 · 无降级梯）回归 A08。**A08 原件地位随之回升**：不再是规格 §7 所称的「降为历史证据」，重新成为右栏骨架基线（内容层以豁免三项为准，原件仍不改写）。**两处内部张力（A08 原文明写 editor 与 terminal 均不进 Rail，而豁免①要求 terminal 留右栏）已于同日 2026-08-05 用户裁定关闭（open-q #28）**：**① editor 回中列 = 是**——用户原话喜欢 A08 的 `chat ║ editor` 并排形态、「而不是现在这样文件打开后内嵌在 editor 里」；editor 独占中列 + `ed-grip` 比例拖拽 + editor head（文件名 · 未保存点 · 隐去 chat 钮 · 关闭文件钮），**右栏 files tab 降为纯文件树**，点文件在中列打开；**② terminal 留右栏后**右栏 tab 扩为四项 `git | files | context | terminal`，Rail 同步四图标且**仅 panel 收起时渲染**，`` Ctrl+` `` 改为打开/聚焦 terminal tab（非 dock 语义）。**连带确认**：L0/L1/L2 降级梯（1580 / 1244）是并排形态的**配套而非可选项**。**一处刻意不照搬 A08（编排者裁定，非用户拍板）**：editor 保留多 tab——A08 画单文件，但隐藏 tab = 隐藏脏文件会丢改动。量级定为 **3d**。落地任务 = **T-32**（执行计划 §3 新增）。 |
| D28 | Permission 已决态视觉（用户拍板 2026-08-10；**修订 D20 范围**） | **已决 Permission 从 QA 整卡收敛为工具行单行**（Allowed/Denied + 描述，复用 ToolRow）。依据：用户现场反馈原话「选择后不需要保留，或者跟tool调用一样显示」（shice2 批，截图实证两张已决整卡叠占消息流）。**D20「保留就地冻结」范围收窄为仅 Question 卡**——「答完不消失」语义两者仍共守，变的只是 Permission 的形态。连带（编排者代拍，待追认）：Denied 复用工具行 failed/destructive 色语义（不发明新状态色）；subagent 来源 chip 在已决单行上以文本后缀承载（实际因 store 在 resolved 即删索引，几乎恒空，非回归）。落地 `d759023`，基线 HTML 冲突3已注记修订。 |
| D29 | 工作区归属权威（用户拍板 2026-08-10；关闭 open-q #28） | **A 方案：维持「会话即工作区」**（git 面板/文件树/cwd 继续跟当前激活会话，T-26/T-27「Composer 目标栏唯一改绑入口」不推翻），**补交互**：点侧栏仓库文件夹自动激活该仓 updatedAt 最新会话并**强制展开**（复核 F1：激活同时折叠会让结果全屏不可见，反噬立项目标）；同 project 点击保留折叠语义不切换（不劫持折叠手势）；空文件夹不自动新建（收窄自候选 A 原文「或直接新建」——focus 已指向该文件夹，New 一次点击即建；自动新建代价大且易误触）；Temp 同规则不特判。B 方案（侧栏选中即工作区）弃：推翻既有裁定改动面大，先验证 A 是否满足心智。落地 `e529a55`；三条观察项入 backlog（空仓库文件夹点击仍零可见后果 / 无「上次看的那条」记忆恒取最新 / 面板按 project 粒度跟随，Temp 内多目录与同仓多 worktree 间不跟随）。 |
| D30 | git 面板范围（用户拍板 2026-08-11；裁定 open-q #29 首段，(b)/(c) 排期未拍） | **(a) 平铺提交历史 + ref 徽章先行**：新壳 `GitSurfaceView` 增历史区（Changes/CommitBox 之下），复用既有 GIT_LOG 链路（`%D` refs 数据现成，后端零改动）；此举**自觉推翻 T-12 头注禁令中「禁复用 CommitHistoryList/历史」半条**（D27「git 最小集」豁免部分走回），其余禁令（BranchSwitcher/sync/stash/PR）维持。(b) SVG 泳道 graph（以 expanded 双栏为家）与 (c) remote 进出为后续候选，本次未排期。依据与盘点：[xvqiu1 triage §3](./2026-08-11-xvqiu1-triage.md)。落地 `de06bf5`（同日施工批）。 |
| D31 | buchong1 参考批采纳（用户拍板 2026-08-13；关闭 open-q #32；**修订 D26④ 与 T-30b2 拍板①**） | **四路全部立项**：① **Progress 面板**（右栏当前回合计划/任务区，用户明示喜欢；推翻 T12-15「不做 Plans（无数据源）」裁定——survey 实证 Claude 侧 TodoWrite 的 todos 数组已随 `tool_use.input` 进 renderer 只未消费；**施工前须真会话实测字段完整性（实现方否决权）**；Codex 侧无等价协议按显式降级）；② **S 档六件小批**（代码卡头部行 / 问答卡 header chip / 选项 description 双层 / thinking 内滚动 / diff stat 绿色 / busy spinner——全渲染端零协议改动）；③ **会话右键菜单**首批子集（Rename / Archive 带确认 / Copy session ID / Open in File Manager / Un-archive 入口，连带收口 #6「右键即归档」误触面）；④ **per-session 权限模式选择器**（IPC `createSession` 加字段 + 两侧 Host 解硬编码 + composer 下拉；触 Host 红线按 flag+Happy Path）。**冲突项四裁定（用户逐件确认）**：用户气泡**改回右对齐**（推翻 D26④ 满宽，append-only 以本条为准）；工具行**维持 Cursor 口径**（D24 不动）；模型与思考等级**拆回两个独立下拉**（推翻 T-30b2 拍板①合并控件）；侧栏**维持双区并存 + Recent 封顶折叠**（不改互斥切换，信息架构不动）。排期顺序未拍（建议序：S 档小批含两处回摆先行 → 右键菜单 → Progress 面板 → 权限选择器）。证据与分档全文见 [buchong1 分析档](./2026-08-13-buchong1-zcode-reference.md)。 |
| D32 | 断链会话语义（用户拍板 2026-08-14；关闭 open-q #30 主问；取证见主线台账 2026-08-14 行） | **只改文案不改行为（最小改）**：`jsonl_not_found` 报错卡去掉「会话未中断，可以继续发送消息。」的假承诺，改为言明此会话已不可继续（陈旧 resume 句柄发送必失败：`No conversation found with session ID`，2026-08-14 本地取证 CONFIRMED，错误以 SDK error result 上抛）；不清句柄、不静默 fork、不加按钮。fork/按钮两案弃：用户裁定最小改。连带项（索引 `projectsRoot?` 标记 / 卡内归档入口 / `host.ready.settings` configDir 口径）**未随裁**，留 open-q #30 连带段另拍。 |
| D33 | 流式状态行三小件（用户拍板 2026-08-14；关闭 open-q #31 待定项） | ① token 口径：**仅 ↓ 输出 tokens**（对齐官方 CLI；完整 in/out/ctx% 仍归 StatusLine，不重复）；② 趣味动词：**不要**——状态行只显示计时与 token（`✽ 19m 55s · ↓ 38.5k`），状态行侧绕开产品语言口径之争（multi-agent #11 权限卡混排仍归该问自裁）；③ test.4 流式 flag **默认 ON**（真机真实踩到流式路径，CI 恒保 OFF 位绿，出问题现场关 flag 兜底）。主修复路径（开 partial + 除双雷 + seenEvents 环形）无拍板径直施工，规格抄 [spike 报告](./2026-08-11-partial-messages-spike.md) §3/§4。 |
| D34 | UI 反馈批六裁定（用户拍板 2026-08-14 当场问答；视觉参照 VS Code SCM 面板，参考图入库 `docs/design/refs/vscode-20260814-gitxvqiu/`） | ① 右栏最小宽 **380→250**（`CONTEXT_PANEL_MIN_WIDTH`；默认 380 = A08 拍板不动，拆 `CONTEXT_PANEL_DEFAULT_WIDTH`）；② **rail 四图标迁顶栏折叠钮左侧**（横排 4×32px + git 变更圆点随迁，44px 竖排导轨退役、`RAIL_RESERVE` 归零——**覆盖 round-12「右侧竖置图标当切换标签」裁定**，append-only 以本条为准；Ctrl+1..4 与 railOrder 数据源不动）；③ git 面板 VS Code 化：docked 上下 **50/50 平分**（用户点名比例）+ Changes 工具栏左标题+计数徽章 + review/tree 钮 icon-only（250px 窄宽挤压的解）+ History 行单列 graph 圆点线+右侧作者名 + commit 钮无 staged 弱化 + statusColors 五色迁语义 token（X 紫无 token 留 T-25）；④ **History 提交行点击展开**：内嵌 meta 行+文件清单，点文件看 per-commit diff——后端 `getCommitFiles`/`getCommitDiff`+hooks 全现成（旧壳同款交互先例），零主进程/IPC 改动；⑤ **diff 迁中栏页（Files 同款，VS Code 模式）**：`EditorTab.diffTarget` 复用整套 tab 机制（`git-diff://` 伪路径），工作区与 commit 两路 diff 都开中栏 tab，面板内嵌 DiffViewer 两分支退役（静态钉子），expanded 双栏维持字节不动；⑥ Context status 三行（Auth 类型枚举/App 版本/Gateway 主机）——**不做有据**：full base URL（维持 baseHost 最小投影）、configDir（#30 连带未裁禁区）、setting sources（Host 刻意 `settingSources:[]`）、session kind（CLI 内部不可得）。 |
| D35 | diff 中栏页四调（用户反馈 2026-08-14 当日第二轮，含一次中途澄清） | ① 「Chat column」按钮退役（与「关全部 tab 自动回聊天」语义重叠，用户"折叠按钮太多"——editor 区其余功能钮盘点后全保留）；② diff 页**恒双侧自动换行**（豁免跟随 editor 设置；根因系 Monaco `wordWrapOverride2` 覆盖链一侧未复位，live API 取证钉死）；③ **diff tab 全局单例**（点另一文件原位替换 target/标题，不再多 tab；真实文件 tab 不受影响）；④ **diff 激活时独占中栏**（`diffTabActive` 强制 `chatVisible:false`，宽屏并排改覆盖——用户澄清后由"激活钉子"升格；切回文件 tab / 关闭即恢复，Files tab 并排行为不动）。落地 `4d8f003`。 |
| D36 | Linux 包 Node 运行时（用户拍板 2026-08-15；关闭 test.4 CI backlog「Node 24 resolvable 恒红」产品裁定） | **捆齐，口径与 Windows 一致**：build-linux 打包链补 fetch 随包 runtime（linux-x64，沿用 Windows 链 pin `24.18.0` + SHA256 校验），verify「Node 24 resolvable」转绿恢复门禁效力；代价（打包脚本施工 + Linux 包体积增大）已知悉。否决候选「不捆并降级 verify」与「砍掉 Linux 出包」 |
| D37 | #30 断链连带三件（用户拍板 2026-08-15；关闭 open-q #30 全部余项） | **三件全采纳，转施工票**：① 索引条目加可选 `projectsRoot` 标记 + 侧栏跨目录徽章（断链高发源可辨认）；② 报错卡内「归档这条」入口（复用现成 `setArchived`）；③ `host.ready.settings` 补 `configDir`，与报错卡 Details 口径统一（本机路径非秘密，Context 面板可显示） |
| D38 | 终端主题视觉域（用户拍板 2026-08-15；关闭 open-q #12） | **终端自留、UI 归 Flexoki**：sync-terminal 的 Ghostty 配色只作用于终端 surface，`applyTerminalThemeToApp()`「写 25 个全局变量覆盖 Flexoki」的外溢机制退役；Monaco 与应用 UI 全归 Flexoki（对齐 VS Code「终端可独立配色、UI 跟主题走」先例）。`ghosttyTheme.ts` / `monacoTheme.ts`「原样不动」冻结解除，转施工票 |
| D39 | git 面板 remote 进出（用户拍板 2026-08-15；#29 排期落定，关闭 open-q #29） | **(c) remote 进出先行立项**（ahead/behind 计数 + fetch/push，对齐 VS Code 日常流；当初评估 L）；(b) SVG 泳道 graph **维持后置** backlog，真有痛点再提 |
| D40 | 会话中途 model/effort 下发（用户拍板 2026-08-15；关闭 open-q #19） | **协议可选加法**：`session.send` 补 model/effort 可选字段，Host 透传使下一回合生效——对齐官方 CLI「会话中 /model 切换」心智。转施工票（M，涉协议 + Host，按工程规范 flag + Happy Path 先行） |
| D41 | 发布构建测试门禁（用户拍板 2026-08-15；关闭 open-q #3） | **加 Linux 单平台前置门禁**：build.yml 打包前置 lint + typecheck + vitest 作业（Linux runner），失败阻断出包；Windows 作业不重复跑。转施工票（S） |
| D42 | dev.env 凭证隔离范围（用户拍板 2026-08-15；关闭 open-q #14） | **维持「主路径 + 约定」不下沉 Host**（开发专用逻辑不进产品侧；GUI 启动口径已锁 `node scripts/dev.js`）；连带缺口补票：dev.js parseEnvFile / 剥离 / 拒启逻辑抽纯函数补 vitest 断言（S） |
| D43 | Phase 0A 收口口径（用户拍板 2026-08-15） | **A02/A03/A04 裁定「被演进取代」，Phase 0A 转 ✅**：A02 现状盘点 → baseline/module-map 取代；A03 目标信息架构 → D21/D22 拍板 + T-26/T-27 落地取代；A04 UI 状态矩阵不补作（各状态已实现并由 vitest 3339 例钉行为）。取代清单以本行为凭；A06 的 A02 依赖按此口径视为满足 |
| D44 | 组件测试基建选型（用户拍板 2026-08-15；关闭 open-q #27） | **jsdom + RTL 组件层立项**：vitest 加独立 jsdom project 只收 `.test.tsx`，组件级事故案例（重试双发等）转可执行回归；与现有四门串行跑（本机内存纪律）。转施工票（M） |

> 注（2026-07-28，编号完整性）：本表最初只收录了当时正在争论的决策轴，**D4 / D5 / D7 / D13 是历史空号**——全仓 `*.md` 与 git 历史均检索不到这四个编号的任何决策正文（`grep -rn "\bD(4|5|7|13)\b" --include="*.md"` + `git log -S` 均无命中），既非遗漏收录也非被撤销，编号在拍板过程中直接跳过；**不要为它们保留语义，也不要复用这四个号**。D12 / D14 已于同日按上两行补录，**至此本表「D1~D20」名副其实**（现含 D1/D2/D3/D6/D8/D9/D10/D11/D12/D14/D15/D16/D17/D18/D19/D20 共 16 行 + 4 个空号）。

> 注（2026-07-28）：本表 **append-only**，被撤销行的原文一律保留不改——**D6 已被 D18 撤销、D15 已被 D19 撤销**，以 D18 / D19 正文为准；ARD §3 决策摘要表已同步加删除线并标注撤销关系。

> **补注（2026-07-28，独立审查后的事实更正；表内原行 append-only 不改写，以本补注为准）**：
>
> 1. **D18 ② 的「全仓唯一的 Tailwind 原色硬编码」是误述**。实测（`src/renderer`）：`bg-amber-500` 共 **5 处**——`chat/MessageTimeline.tsx:419`、`chat/HostStatusBanner.tsx:55`、`todo/TaskCard.tsx:16`、`ui/activity-indicator.tsx:21`、`ui/glow-card.tsx:123`；`(bg\|text\|border\|ring\|…)-(amber\|red\|green\|blue\|…)-NNN` 形态的原色工具类共 **134 处 / 47 文件**，集中在 `source-control/`、`layout/`、`git/`、`settings/`、`ui/` 等旧模块。正确表述：`MessageTimeline.tsx:419` 是**新壳 chat 链路上的运行态硬编码**，不是全仓唯一。**连带**：T-21 验收②的扫描范围已收窄为 `components/chat/**` + `components/workspace-shell/**`（并把 `chat/HostStatusBanner.tsx:55`、`chat/StatusLine.tsx:233-234` 显式列进清单）；旧模块 47 文件另立 **T-25**（后置，依赖 T-21）。同一误述已在 ARD §7、执行计划 T-21、plantree roadmap / implementation-status、设计基线 HTML 五处改为事实描述。
> 2. **D19 的「surface 有内容时右上角 6px 圆点」把参考实现泛化了**。实测 `ContextPanelRail.tsx:166` 为 `showActivityDot={surface.id === 'git' && changedFilesCount > 0}`——**只有 `git` 一种 surface 会亮点，触发条件是「有变更文件」**；圆点本体在 `:82`（`h-1.5 w-1.5` = 6px ✓，色值 `var(--status-info)`）。**连带**：ARD §4 / §13、执行计划 T-15（终端 surface 无圆点，参考实现无「有内容」信号源）与 T-22（验收④改为 git-only）、设计基线 HTML 图注均已改为 git-only；其余 surface 若要加圆点属 ai-client 自主扩展，须先各自定义判据。
> 3. **A01 的「冻结参考版本」项此前遗漏，现补记**：D18 / D19 / D20 与 T-05 / T-21 / T-22 引用的全部 openchamber `file:line` 证据，一律以 commit **`a3519141635990e3d75d79a7f902f8aa15386060`（`v1.17.0-6-ga3519141`）** 为准，工作树 `/home/dan/projects/openchamber`，取证日期 2026-07-28（取证时无未提交改动）。该仓是活动工作树会继续往前走，**跨版本核对前必须先 `git checkout a3519141`**。Light/Dark 基准 = Flexoki Light / Flexoki Dark；标准窗口尺寸本轮不冻结（裁定只用到与窗口宽度无关的相对尺寸）。
> 4. **`docs/design-system.md` 的同步此前无主，现归口 T-21 / T-22**：该文件被项目 `CLAUDE.md` 定为 UI 开发强制规范，其 Color System（`primary` = 强调色/品牌色）、Border Radius（4/8/12/16px，未计根字号 14px 的 ×14/16）、Typography 与 `JetBrains Mono` 字体族四节均已被 D18 推翻。T-21 增「改写该文件四节 + 标注根字号结论」的内容项与验收项，T-22 增「尺寸段落补新壳档位」。
> 5. **T-24 排序以执行计划为准**：执行计划 §3 起步顺序与 §8 风险 9 明写「T-24 阻断级、先于 T-21/T-22、不排进 Phase 4 尾巴」；plantree roadmap / implementation-status / 根 README 已按此改齐（低权威文件不得覆盖高权威文件）。
> 6. **可行性文档候选任务池的引用行号更正为 `:989-1035`**（原写 `:989-1033`，见下方检查点表 2026-07-28「Phase 0A 基线补做」行）。实测 [`2026-07-23-openchamber-ui-chat-refactor-feasibility.md`](./2026-07-23-openchamber-ui-chat-refactor-feasibility.md)：`#### A01` 在 **989**、`#### A06` 在 **1029**、A06 末行「- 工作量：1～2 人日。」在 **1035**；`1033` 只到 A06 的「- 依赖：A01、A02；」，**把 A06 截断了**。执行计划「产品设计基线补登（A01 / A05 / A06，2026-07-28）」小节里同一处引用写的 `:989-1035` 是对的，本台账原行按 append-only 不改写，**以本条为准**。
> 7. **决策编号完整性**：D12 / D14 已于 2026-07-28 补录进上表（原载 ARD §3，非新决策），D4 / D5 / D7 / D13 判定为历史空号——详见上表表尾「编号完整性」注。**连带**：D20 正文引用的「D12『权限/提问 UI 进时间线卡片』继续有效」自此在本表可查证；plantree 两处「已拍板决策 D1~D20」的指向（[根 README](../plantree/README.md) :25、[计划 README](../plantree/plans/openchamber-chat-refactor/README.md) :23）不再落空，无需改文案。
> 8. **D18 依据里的色相表述是过头表述**（2026-07-28 复验补）：原行写「现有语义变量**整套**锁在色相 285.82 …… `success` / `warning` / `info` 在亮暗下同值——**整套配色没有强调色**」。实测 [`src/renderer/styles/globals.css`](../../src/renderer/styles/globals.css)：`--success oklch(0.527 0.154 150.07)` / `--warning oklch(0.769 0.189 70.08)` / `--info oklch(0.623 0.214 259.81)`（`:80-85` 亮 / `:110-115` 暗），色相 **150 / 70 / 260**、彩度 **0.15–0.21**，**既不在 285.82 色相、也不是无彩色**；`--destructive` 亮暗还各不相同（亮 `oklch(0.577 0.245 27.33)` / 暗 `oklch(0.396 0.141 25.72)`）。正确表述：锁在色相 285.82 的是**中性与品牌梯度**（`--accent` / `--muted` / `--secondary` 三者同值、`--primary` 是中性反色），状态三色是**真彩色但亮暗逐字同值**——**缺的是品牌强调色，不是全部彩色**。**D18 结论不变**（沿用现有 token 对不出 OpenChamber 观感），表述一律以 [ARD](./2026-07-23-openchamber-chat-refactor-ard.md) §7 为准。**连带**：ARD §7 / §3（D18 行）、执行计划 §3 A05 行（三次更新⑧）、[`docs/design-system.md`](../design-system.md) 时效警示块、设计基线 HTML §02（`:1244` 表述更正）已同口径。表内原行按 append-only 不改写。
> 9. **检查点表 2026-07-28「Phase 0A 基线补做 + 用户拍板 D18/D19/D20」行的两处表述已被执行计划更正**（2026-07-28 复验补，原行按 append-only 不改写）：
>    - **T-16 因果**：原行写「恢复开关可逆性必须**同时改两处**（`src/shared/devFlags.ts:10` …… 以及 `App.tsx:450` …… + `Root.tsx:52-59` ……），只改一处无效」——枚举了**三个位置**却称两处，且「只改一处无效」在 `devFlags.ts` 这一处上**为假**。实测 `SKIP_ONBOARDING_GATE = true`（`src/shared/devFlags.ts:10`）是另两处的**共同开关**（`Root.tsx:138` 靠它才渲染 `SkippedOnboardingApp`，强制 `setUseOpenChamberShell(true)` 只存在于该组件内；`App.tsx:450` 是 `SKIP_ONBOARDING_GATE || useOpenChamberShellSetting` 短路），翻 `false` **确实能一并解除两处覆盖**，只是会连带恢复 onboarding 闸门，故**不作为达成手段**（T-16 验证时 `devFlags.ts:10` 保持 `true`）。现行口径 = 执行计划 §3 **T-16** 行。
>    - **T-23 usage 数据源**：原行写「`:78-89` 硬编码「72%」usage 环——真实数据已在 `WindowTitleBar.tsx:55-60`」**两点都不准**：(a) 路径是 `src/renderer/components/layout/WindowTitleBar.tsx`，**不在 `workspace-shell/`**（同句其余并列项都在 `workspace-shell/`，易被顺着上下文找错）；(b) 那里是 `useUsageStats()` 的 **`todayCostUsd`（今日成本，美元）**，`UsageStatsResult`（`src/shared/types/usage.ts:1-8`）只有 `todayCount / todayCostUsd / monthCount / monthCostUsd`，**无任何百分比或配额字段**，「接过来」填不出那个 72% 的环。现行口径 = 执行计划 §3 **T-23** 行（**二选一**：改环语义为成本/次数，或撤掉环；禁止保留百分比外壳再塞成本数字）。
>
> **说明（2026-07-28）**：补注条数随复验轮次持续增长；检查点表历史行里出现的「补注 N 条」计数，指**该轮新增的条目数**，不是补注区累计总数——后续轮次的编号在已有条目之后顺延，读历史检查点行时按此换算，不要拿它跟当前补注区的条目总数直接比对。

---

## 检查点（按时间）

| 日期 | 节点 | 结果 | 关键提交 |
|---|---|---|---|
| 2026-07-23 | 文档基线：ARD + CONTEXT | ✅ | `ed93202` |
| 2026-07-23 | Phase 0：Node24 Resolver / Host 骨架 / Cometix pin / 双路线 spike | ✅ Conditional | `e36dbbe` |
| 2026-07-23 | Phase 1：四区 Workspace Shell + Mock Runtime | ✅ | `259e863` |
| 2026-07-23 | Phase 0 报告（初版，后有纠正） | ✅ | `335ba02` |
| 2026-07-23 | 多轮对比脚本；纠正「stream-json 更快」误判 | ✅ | `ac8d021` |
| 2026-07-23 | API settings.env 注入后：双路线均可 resume 召回 | ✅ | `fcc8c81` |
| 2026-07-23 | **默认驱动改为 Agent SDK** | ✅ | `7db1424` |
| 2026-07-23 | 本台账落地 | ✅ | `902a9f5` |
| 2026-07-23 | **Phase 2 节点 1：Host settings + Cometix + SDK Adapter + Normalizer** | ✅ | `c0aaf14` |
| 2026-07-23 | **Phase 2 节点 2：Main session API + Chat IPC + Runtime Event 推送** | ✅ | `ea0286b` |
| 2026-07-23 | **Phase 2 节点 3：Chat Store 接真 Runtime + Composer Send/Stop** | ✅ | `76632cf` |
| 2026-07-23 | **Phase 2 节点 4：Permission 桥 happy path** | ✅ | `5cd5163` |
| 2026-07-23 | **CP1：双轨执行计划定稿 + 分账结构落库** | ✅ | 执行计划 + 两条子台账 |
| 2026-07-23 | **C-01：agent-host 构建产物 + electron-builder 打包配置（M1 前半）** | ✅ | `f21fec7` |
| 2026-07-24 | vflow 打包链摘除（D16 Phase A）+ `pnpm test` 首次全绿 111/111 | ✅ | `dbb20be` |
| 2026-07-24 | **Host 行为变化通知**：SDK 流结束无 result 时补发终态事件（有输出→completed+idle；无输出→failed）——修团队定位的「UI 永驻 running」；无新事件类型、无协议 bump | ✅ | `6a633d6` |
| 2026-07-24 | **C-02：打包态自动化验证 PASS（M1 自动化半边齐）** — portable 产物 + `pnpm verify:packaged` 22 项全绿（含打包产物网关 PONG）；GUI 点验移交 T-10 | ✅ | `dbb20be` |
| 2026-07-24 | vflow 运行时代码摘除（D16 Phase B 收口，全仓引用清零） | ✅ | `eac23f7` |
| 2026-07-24 | 用户反馈 F1-F5 映射进计划（§7）；新增 C-13 附件协议 + T-18 Composer 粘贴 | ✅ | 执行计划 §7 |
| 2026-07-24 | **C-07：Session Index（Main 持久化 + 3 条 chat IPC）完成，T-02 解锁** | ✅ | `f6807c9` |
| 2026-07-24 | **CP4：`session.history` 协议定稿（用户确认）** — 协议文档 [`2026-07-24-c06-session-history-protocol-draft.md`](./2026-07-24-c06-session-history-protocol-draft.md) 即 T-03 接口契约。协议纯增量不 bump：新事件 `session.history`/`session.historyListed`/`session.updated` + 新命令 `session.listHistory` + `host.ready.capabilities.history`。**团队注意**：① T-03 数据层随 C-06 实现落地后解锁（本行仅协议定稿）；② running 会话 resume 将被拒（`session_busy`）；③ 历史消息 id 带 `h:` 前缀为契约。fresh-fable 对抗评审 GO-WITH-CHANGES 12 findings 全采纳（明细见主线台账） | ✅ | 协议文档 |
| 2026-07-24 | **CP3：Question/Thinking/Effort-Plan/附件 探测结论 + 用户拍板** — ① Question 卡可做（AskUserQuestion 走 canUseTool 权限流是官方机制，答案经 updatedInput.answers 回传）→ C-04 开工；② **Thinking 开启且默认开**（多轮零 400，disable 防御过时；延迟成本已知悉）→ capabilities.thinking=true，**T-04 解锁**；③ Effort/Plan：仅 xhigh 有实证、plan 非硬只读 → **新开 T-20**（原拟 T-19，让位消息队列提案）（effort 控件，开工前按官方文档调研实际档位，不止 default/xhigh 两档；plan UI 暂缓等主线 canUseTool 只读约束）；④ 附件可行 → C-13 桥接实现排队（解锁 T-18 在即）；⑤ **C-14 立项**（Host 无事件超时看门狗，排 C-04 后）。四 spike `9bda9e5`、结论 `a179955` | ✅ | 见左 |
| 2026-07-24 | **C-04：Question 桥全链完成，T-05 Question 卡解锁** — AskUserQuestion 走 canUseTool 权限流（CP3 拍板的官方机制）。**团队消费指引**：事件 `question.requested`（payload `questions[]`：question/header/options{label,description,preview}/multiSelect）→ UI 卡收集答案 → `chat.respondQuestion({sessionId, questionId, answers? \| response? \| cancel?})` → 事件 `question.resolved`（outcome answered/cancelled/rejected）冻结卡片。store 已备好 `pendingQuestion` + `respondQuestion` action + question block。**三条硬约束**：① answers 的 key 必须是 question 原文逐字（改动即视为未答）；② multiSelect 多选用 `", "`（逗号+空格）拼接；③ answers 与 response 互斥（并存时模型只见 response）。取消用 `cancel:true`（无 denial 记录），不要发空 answers。协议纯重塑不 bump（question stub 从未发射过）。网关 smoke 三场景绿 | ✅ | `c9522d2` |
| 2026-07-24 | **C-14：Host 挂起看门狗完成** — 无模型进展默认 120s → abort + 显性 `session.failed`（`AICLIENT_HOST_STALL_TIMEOUT_MS` 可配，0 禁用）。permission/question 挂起与本地工具执行自动豁免（用户思考不限时）；非法 model 的 api_retry 循环照杀（网关实证 51s 显性 failed）。**团队影响**：卡 running 永驻的场景从此会转为 failed + 明确错误文案，T-06 重试卡自然承接 | ✅ | `f87c1cc` |
| 2026-07-24 | **C-13：附件桥接完成，T-18 解锁** — `session.send` 增 `attachments[]`（`{kind:'image'\|'text', mediaType, data, name?}`，image=base64/text=原文，path 不进协议）。**T-18 消费指引**：store `sendMessage(text, attachments?)` 已就绪（`ChatSendAttachment` 类型自 chatSessions 导出）；attachment-only（text 空）允许；网关实测 8x8 图 24.5s / 文本附件 8s，**大图更慢（spike 152KB→79s），Composer 必须做发送中状态**。网关 smoke 双场景绿（辨色 Red / 召回 kumquat） | ✅ | `d339f70` |
| 2026-07-24 | **C-15：随包 Node 运行时完成（D17 落地，开发机侧全验）** — 打包产物携带 pinned Node `24.18.0`（`resources/node-runtime/node.exe`，官方 SHA256 校验下载）；Resolver 增 `bundled` 源（explicit/env 逃生口之下、机器发现之上，开发态不变）。**`verify:packaged` 25 项 PASS，PONG smoke 显式跑在随包 node 上**——无用户 Node 的机器可跑通对话。CI build-windows 已接 fetch+cache。**体积交用户过目**：portable 120MB→141MB（+21MB）。⏳ 加密机「白名单按进程名 + 随包 node 读 TSD」实证归 **T-11⑥**，开发机不标注通过 | ✅ | `adc3127` |
| 2026-07-24 | **C-06：Resume 历史重放全链实现完成，T-03 解锁** — Host historyReader + runtime 时序/session_busy + Main `chat:listHistory` IPC/preload + store `h:` 前缀灌入；新增 49 单测（全套 181 绿）；网关端到端 smoke `spikes/c06-resume-history-smoke.ts` ok:true（含历史召回码字验法）。**T-03 可开工**：数据流 = 点击历史会话 → `chat:resumeSession` → 事件 `session.resumed → session.history → status idle` 自动灌入 store（消息 id `h:*`）；列表合并数据源 = `chat:listSessions`（C-07 索引）+ `chat:listHistory`（盘上 CLI 会话，含 title）；历史读失败看 store `historyErrors[sessionId]`（非阻断） | ✅ | `db41f63` |
| 2026-07-24 | **C-09：测试基建 + lint 恢复绿** — 全仓 lint 0 诊断（494 CRLF 根因归一 + `.gitattributes` 锁 LF 防回退 + biome 排除构建产物）；+70 单测锁 C-08 行为基线（store reducer / normalizer / permissionBridge / Host 协议错误路径子进程实测）；全套 36 文件 308 例绿。**C-08 解锁** | ✅ | `ce5a577` `1505031` `49a6031` |
| 2026-07-24 | **双轨合一（用户指示）**：团队轨道同事休假，Claude 主线全权接管全部任务；共树并行纪律（pathspec 提交/避让 components）随之松绑。团队在途未提交 T-04 方向改动（hostStatus/MessageTimeline/ChatWorkspace/thinkingCard 共 6 文件）留存工作树，待接手 T-04 时评估续用或重做 | ✅ | 口头指示 |
| 2026-07-24 | **C-08 收口：Store 结构优化 + 批处理全量完成** — a 批处理（16ms 窗口合并、单次 set 整批应用，`138ccb3`）+ b 分桶（messages 按 sessionId 分桶、3 消费方选择器迁移、时间线只订阅本会话桶，`922d689`）；每 delta 成本 O(全部消息)→O(本会话桶)；59 例测试形状适配数量/语义不变，全套 344 绿 | ✅ | `138ccb3` `922d689` |
| 2026-07-24 | **双轨交接完成**：同事收尾全部落地（T-04 `22ef2ff`、T-07 `1ff7fc1`，快照见其交接词/团队台账），主线全权接管 T-xx 池 | ✅ | `22ef2ff` `1ff7fc1` |
| 2026-07-28 | **Phase 0A 基线补做（A01 / A05 / A06 补登）+ 用户拍板 D18 / D19 / D20** — 三项产品设计基线此前**只存在于可行性文档候选任务池**（[`2026-07-23-openchamber-ui-chat-refactor-feasibility.md`](./2026-07-23-openchamber-ui-chat-refactor-feasibility.md) `:989-1033`），**从未进入执行计划或任何台账**；而同文档中 F05 声明依赖 A05+A06、H01 与 H09 声明依赖 A01+A06——**下游任务已施工、前置基线全缺**，这是当前 UI 观感不到位、死按钮泛滥、布局反复卡壳的同一个根因。本次统一产物 [`docs/design/phase0a-openchamber-alignment.html`](../design/phase0a-openchamber-alignment.html)，**用户已验收**，据此拍板三条：**D18**（Flexoki 主题 + 全等宽字体 + 卡片形态一并对齐，撤销 D6）、**D19**（三列 + 44px 导轨 + surface 模型，废弃底部面板，撤销 D15）、**D20**（问答卡保留就地冻结，登记为偏离）。**连带变更**：T-05 口径整体重写（撤销带边框卡片 + 状态徽章 + 「展开全部」，改无边框单行 + `ml-2 pl-3` 竖线展开体 + max-height 滚动窗 240px / 46vh / 60vh + 连续 read 聚合行）；T-13 **解冻**并重定义为 `editor` surface；T-15 重定义为 `terminal` surface；T-12 / T-14 改 `git` / `context` surface；新立 **T-21**（主题字体落地）、**T-22**（壳结构改造 + 删 `BottomDock.tsx`）、**T-23**（存量违规清理：`MainHeader.tsx:56-72` 五个无 `onClick` 图标按钮、`:78-89` 硬编码「72%」usage 环——真实数据已在 `WindowTitleBar.tsx:55-60`、`LeftNav.tsx:167-170/136-138/279-282`、`RightDock.tsx:38-52`）、**T-24**（阻断级）与 **C-17**（后置，问答进历史协议）。**两项查明**：① 新壳「添加仓库」**完全不可达**（`AddRepositoryDialog` 挂在 `App.tsx:1919` 但 trigger 全在 legacy 分支，拖文件夹到窗口因 ref 只绑旧壳而静默失效，新机器唯一通路是 `--open-path` argv）→ T-24 优先级**高于** T-16；② T-16 恢复开关可逆性必须**同时改两处**（`src/shared/devFlags.ts:10` 的 `SKIP_ONBOARDING_GATE = true`，以及 `App.tsx:450` 的 `SKIP_ONBOARDING_GATE \|\| setting` 短路 + `Root.tsx:52-59` 水合后强行 `setUseOpenChamberShell(true)`），只改一处无效。open-questions **关闭 #9**，**新增 #10**（全等宽中英混排风险）、**#11**（根字号 14→16 影响面）、**#12**（终端 Ghostty 主题 / Monaco 跟随是否一并 Flexoki 化，裁定前原样不动） | ✅ | 设计基线 HTML + ARD / 本台账 / plantree 落库 |
| 2026-07-28 | **落库后独立审查 → 七条修正入账**（决策不变，只更正事实与范围；明细见上方「已拍板决策」表下的**补注**五条）：① `bg-amber-500`「全仓唯一」误述更正为「新壳 chat 链路上的运行态硬编码」，实测全仓 134 处 / 47 文件，T-21 验收②范围收窄至 `chat/**` + `workspace-shell/**`，旧模块另立 **T-25**（后置）；② Rail 圆点由「surface 有内容时」更正为 **git-only（有变更文件时）**，T-15 明确终端 surface 无圆点、T-22 验收④改 git-only；③ **A01 补记冻结版本** `openchamber a3519141` = `v1.17.0-6-ga3519141`（取证 2026-07-28），并补回 Light/Dark 基准、说明窗口尺寸本轮不冻结的理由；④ **CONTEXT.md 改写**——ARD 头部指定它为术语权威源，但其第 25 行仍逐字保留被撤销的 D6 口径，现改为 D18/D19 新口径，并新增 `surface` / `ContextPanel` / `ContextPanelRail` / `阅读栏` 四条定义、给 Ghostty/Flexoki/应用壳 token 三条加 open-q #12 指向；⑤ `docs/design-system.md`（`CLAUDE.md` 定的 UI 强制规范）与 D18 对撞且此前无主 → 归口 T-21（四节改写 + 根字号结论）/ T-22（尺寸档位），并在该文件顶部加「部分内容已被 D18/D19 推翻」的时效警示；⑥ plantree 三处 **T-24 排序**改齐执行计划口径（阻断级、先于 T-21/T-22），根 README 的 Next Target 补进 T-24；⑦ 设计基线 HTML 同步①②与冻结版本。**审查者两条误报不改**：ARD:40（D19 行）不含圆点表述；执行计划 T-05 行不含「全仓唯一」表述 | ✅ | 文档修订，无代码变更 |
| 2026-07-28 | **同轮 minor 清理（台账侧四项）** | ① 可行性文档引用行号 `:989-1033` → **`:989-1035`**（1033 把 A06 截断在「依赖：A01、A02」，末行「工作量」在 1035）→ 走**补注 6**；② **决策编号补齐**：D12 / D14 按 append-only 追加进决策表（原载 ARD §3，非新决策，D20 引用 D12 自此可查），D4 / D5 / D7 / D13 判定为**历史空号**（全仓 `*.md` + `git log -S` 零命中）并在表尾注记 → 补注 7；③ **Phase 3 状态行刷新**并改口为「只记 Phase 级结论、任务明细以 plantree 为准」（T-02/T-03/T-07 已 2026-07-26 GUI 复验通过、T-18/T-20 已落地，原「待 GUI 联调」枚举过期）；④ **Phase 0A 行澄清**：维持 🟡（A06 申报依赖 A01+A02，A02 缺位），明写 plantree Done 段的 ✅ 只覆盖 A01/A05/A06 三项补做、口径以本表为准。**团队台账**（[`ledger-team-track.md`](./ledger-team-track.md)）任务表冻结为 2026-07-24 快照，表头加失效对照表（T-05 重写 / T-12~T-15 → surface / T-16 依赖补 T-24 / T-21~T-25 新增）指向执行计划 §3——**不就地改写旧行**（archive 价值 + 避免第四份定义副本） | ✅ | 文档修订，无代码变更 |
| 2026-07-28 | **复验轮 minor 收口（跨文件口径对齐，决策不变）**：① **色相误述第三处**——执行计划 §3 **A05** 行仍写「语义变量整套锁在色相 285.82 且无强调色」，与已收窄的 ARD §7 对撞，现改为同口径并记入文件头「三次更新⑧」；② **`docs/design-system.md` 时效警示块**（`CLAUDE.md` 定的 UI 强制规范，开发者最常读）第三次复制同一误述，现改为「中性与品牌梯度锁 285.82、缺品牌强调色；状态三色有彩度但亮暗同值」，目标口径不变；③ 本表 D18 行同一误述 → **补注 8**（原行 append-only 不改写）；④ 本表检查点 2026-07-28「Phase 0A」行的 **T-16 因果**（枚举三处却称两处、「只改一处无效」在 `devFlags.ts` 上为假）与 **T-23 usage 数据源**（路径在 `components/layout/`、语义是 `todayCostUsd` 成本无百分比字段）→ **补注 9**；⑤ plantree [implementation-status](../plantree/plans/openchamber-chat-refactor/implementation-status.md) Handoff Notes 的「只改 `devFlags.ts` 无效」改为执行计划 §3 T-16 口径。实证：`globals.css:80-85` / `:110-115`、`devFlags.ts:10`、`Root.tsx:138` / `:52-59`、`App.tsx:450`、`WindowTitleBar.tsx:55-60`、`shared/types/usage.ts:1-8` | ✅ | 文档修订，无代码变更 |
| 2026-08-10 | **现场七问题修复批**（shice2 取证 → 六路根因排查 → 五路并行施工 → 四门 2990 例 0 红）+ **用户拍板 D28** + **编排者代拍三条待追认**：①Stop 队列语义「冻结队列，入队即恢复」——现状两套语义打架（空桶自动续发 / 非空永久卡死等 Resume），取「用户再发消息即视为继续」的最小惊讶一致解，send-rejected 保持不清防活锁；②历史附件回放只做 metadata chip、不读本地文件生成位图——不引入新 IO/权限面，真位图另立需求；③窗口首帧背景色按持久化主题动态取值、不写死暗色——测试机实为亮色主题，写死暗色会把「先白后亮」换成「先深后亮」并未变好。三条证据链见[主线台账](./ledger-claude-mainline.md) 2026-08-10 行与 `d759023` 提交正文；排查结论两处被实现方证据推翻（sessionIndexMerge / 附件载体）亦录该行 | ✅ | `d759023` `aa3ab33` `940046c` |
| 2026-08-10 | **用户拍板 D29（#28 A 方案）+ 三条代拍全部追认生效**（上行「待追认」自此闭环：Stop 队列语义「冻结、入队恢复」/ 历史附件 metadata chip / 首帧背景色动态取值）。D29 施工走「施工 + 对抗复核」双段：复核抓 2 major（激活被折叠藏结果 / resume 后写 activeSessionId 竞态——后者系**既有缺陷**，所有会话行点击均可踩，本批以 shouldApplyResumeResult 纯谓词顺带根治）+ 3 minor，全闭环；四门 vitest 3004 例 0 红 | ✅ | `e529a55` |
| 2026-08-11 | **xvqiu1 四问题批：triage + 用户拍板 D30（git (a) 先行）+ 施工四片**（Temp 开关接线 / config dir 迁稳定位 + 启动包装器 / partial spike 五问全答并修正 triage 两处假设 / git 平铺历史 D30-a）。无拍板三件按「可径施工」直落；#30 断链语义留真机取证；#31 流式三小件待拍（spike 已补正 token 口径背景）；全量 vitest 挂死事故根因（settings store import 图新形态）入主线台账 2026-08-11 行 | ✅ | `2ba0bde` `fdcbca0` `dee4921` `de06bf5` |
| 2026-08-14 | **本地点验批 + 拍板批**：xvqiu1 四片本地点验全过（Temp 门控五态 / D30-a 六项 / D29 顺带 / 首帧；CDP 驱动 dev GUI）+ **#30 断链取证 CONFIRMED**（原判「须真机」推翻，本地移出 JSONL 即复现）+ 用户拍板 **D32**（#30 最小改文案）/ **D33**（#31 三小件：仅输出 tokens / 无动词 / test.4 默认 ON）。三条意外发现待另立（`<button>` 嵌套 / React unmount 告警 / `chat:runtimeEvent` 监听器超限）。纯点验与拍板批不触码，四门不适用 | ✅ | —— |
| 2026-08-14 | **流式施工批 + #30 文案修落地**：D32/D33 执行完毕——`jsonl_not_found` 卡不再假承诺（`continuationHint` per-code 化 + `history_unsupported` 接通）；`includePartialMessages` 默认 ON（`AICLIENT_HOST_PARTIAL_MESSAGES=0` 回 OFF = 今日行为，改造前黄金基线仲裁）；状态行 `✽ elapsed · ↓ tokens` CDP 冒烟实测生效。规格 rev.2 = 双轨对抗评审合取（Opus 4 blocker + Codex 13 条）；变异验证 15 对；四门 vitest 3268 例 0 红。过程明细见主线台账 2026-08-14 施工批行 | ✅ | `49aee3f` `4c2440b` `5281ceb` `956f8bb` `31a49c5` |
| 2026-08-14 | **UI 反馈批（D34）八提交落地**：`7566d4c`（min 250 + rail 迁顶栏）/ `9b17dc6`（git 面板观感：平分+标题+行升级+token 切片）/ `6f0659a`（平分静态钉）/ `21ed45d`（提交点击展开）/ `c6a6c80`（diff 迁中栏页，面板内嵌退役）/ `f580129`（Context status 三行，脱敏红线守住）/ `185f5ec`（**Thought 孤箭头修复——T-31 潜伏缺陷**：纯思考回合降级链落 bare 渲染 null，加 thought 档；blame 排除本日批次）/ `0a3bb52`（D25 字体门禁收口）。观感批施工员 API 中断由编排者收尾（250px 窄宽 icon-only 修复 + 静态断言补铸；期间误用 git checkout 抹未提交函数，凭上下文复原并验证）。四门全绿 **vitest 163 文件 3329 例 0 红** | ✅ | `7566d4c`~`0a3bb52` |
| 2026-08-14 | **D35 diff 页四调落地**：`4d8f003`——Chat column 钮退役 / diff 恒双侧换行（Monaco wordWrapOverride2 坑）/ diff tab 单例 / diff 激活独占中栏（宽屏澄清）。变异两轮命中精确；四门全绿 **vitest 3339 例 0 红** | ✅ | `4d8f003` |
| 2026-08-15 | **test.4 CI 出包跑通（出包路径首秀）**：三轮迭代根治 Windows runner cpSync filter 整体失灵（`ae57020` 兜底 + `0d4011c` 自写 walk）；`windows-installers` 345MB / `windows-unpacked` 251MB 产出（run 31861599547）；Linux verify Node 24 断言恒红入 backlog（产品决定）。无 release 无 tag，在线用户零感知 | ✅ | `1a96a55` `ae57020` `0d4011c` |
| 2026-08-15 | **test.4 用户真机初验通过，阶段归档**：NSIS 安装版正常（立即启动、使用无发现问题）；portable 启动 1-2 分钟——解压型包预期行为（每次启动解 ~250MB 到临时目录，杀软实时扫描加剧），**归档为已知限制不作缺陷**，口径与 T-10「优先安装版/unpacked」一致。用户裁定本阶段收口 | ✅ | —— |
| 2026-08-15 | **CP5：加密机现场 T-11 六项全过，Phase 0 转正式 Go** — 用户现场点验六项（含 ⑥ TSD 白名单口径实证：随包 node 按进程名读 TSD 放行）无问题；open-q #7 关闭，加密机相关能力自此可标注通过。**范围注意**：本批仅覆盖 T-11；T-10 深度回归（现场操作单七项 / 全量 25 项 / 流式观感 / D34-D35 逐项 / 包装器）、GUI 点测批（T-03/06/07/18/20）与 T-21 目视仍留用户线未点 | ✅ | —— |
| 2026-08-15 | **拍板批（排期 + D36）**：① 开发线主攻 = multi-agent S3 切片 5「历史」（先收敛在制品，收完 5 → 切片 6 支线收口）；② 三条本地意外发现**立即修一小批**（`<button>` 嵌套违规 / React unmount 告警 / runtimeEvent 监听器超限），先于主线；git 面板外部提交不自动刷新另挂 backlog 票；③ **D36** Linux 包捆随包 node（见决策表） | ✅ | —— |
| 2026-08-15 | **拍板批第二轮（B 类口径）**：**D37**（#30 连带三件全采纳）/ **D38**（终端自留、UI 归 Flexoki）/ **D39**（git (c) remote 进出立项、(b) 泳道后置）；另裁 **#8 空 thinking 块不渲染指示**（对齐官方 CLI 空块无展示口径，网关修复后 T-04 点验若觉缺失再开）。open-q #8/#12/#29/#30 关闭；#31 经核对已被 D33 全定、#6 已随 D31 右键菜单立项连带覆盖，一并出清 | ✅ | —— |
| 2026-08-15 | **拍板批第三轮（C 类基建）**：**D40**（#19 协议加法）/ **D41**（#3 CI Linux 门禁）/ **D42**（#14 维持约定 + 断言小票）；另裁 **#13 dark: 脱钩修复并入意外发现小批**（@custom-variant 一行 + CDP 亮暗逐屏复验）。open-q #3/#13/#14/#19 关闭 | ✅ | —— |
| 2026-08-15 | **拍板批第四轮（收尾）**：**D31 排期落定 = 建议序**（渲染端小批 → 右键菜单 → Progress 面板 → 权限选择器；整批位于 multi-agent 切片 5 之后；open-q #32 关闭，#6 由右键菜单连带承接）；**D43**（Phase 0A 收口）/ **D44**（jsdom+RTL）；multi-agent 权限卡按钮英文/卡体中文**维持混排**（该 plan open-q #11 关闭）；#24 titleSource 维持 backlog、切片 2b 维持后置（既有裁定不变）。**待拍板议程至此全部出清** | ✅ | —— |

---

## Phase 0 明细

| 项 | 状态 | 备注 |
|---|---|---|
| Node 24 resolver + 版本校验 | ✅ | nvm `v24.18.0` |
| Cometix pin + SHA256 | ✅ | `2.1.212` / 见 `src/agent-host/PINNED.md` |
| Agent SDK spike（结构化事件） | ✅ | 多轮 resume 通过 |
| stream-json spike | ✅ | fallback 保留 |
| 多轮连续上下文对比 | ✅ | 两边均可召回 `ORANGE-42` |
| Host 启停无孤儿（开发态） | ✅ | |
| Stop 成功路径 | ✅ | Host Abort + UI Stop 已接 |
| Permission 桥接 | ✅ | Phase 2 节点 4；unit smoke 通过 |
| Resume 进 Host 协议（非仅 spike） | 🟡 | `session.resume` + `chat:resumeSession` 已接；历史重放仍 Phase 3 |
| Effort/Plan/Build 探测 | ⏳ | 条件性 UI |
| TSD 解密读 | ⏳ **待加密机** | 开发机不得冒充通过 |
| 打包 Electron 启 Host | 🟡 | C-02 自动化冒烟通过（打包产物 Host 直跑 PONG + Node24 寻径）；GUI 启动点验 → T-10 |

详见 [`phase0-report.md`](./phase0-report.md)。

---

## Phase 1 明细

| 项 | 状态 | 备注 |
|---|---|---|
| 左栏全高（菜单 / 项目会话 / 底设置） | ✅ | |
| 主区顶栏 | ✅ | |
| Chat + Composer（Mock） | ✅ | |
| 单层右栏 git\|files\|context | ✅ | 默认可折叠 |
| 底栏 Terminal Dock 占位 | ✅ | |
| Mock Runtime Event 驱动状态 | ✅ | |
| Beta 开关 | ✅ | Settings → Appearance |
| 接真 Runtime | ✅ | Phase 2 节点 3：Chat Store → `electronAPI.chat` |

验证：`pnpm dev` → Appearance → 打开 **OpenChamber Workspace Shell**。

---

## Phase 2 明细

目标闭环：**新建 Session → 发送 → 流式文本 → 一个 Tool → Stop → idle**（默认 Agent SDK）。

| 项 | 状态 | 备注 |
|---|---|---|
| Host 加载 `~/.claude/settings.json` env | ✅ | `claudeSettings.ts`；`host.ready.settings` 脱敏诊断 |
| Cometix `cli.js` 解析 | ✅ | `cometix.ts`；pin `2.1.212` |
| SDK Runtime Adapter | ✅ | `claudeRuntime.ts`：create / resume / send / stop / close |
| Event Normalizer | ✅ | `eventNormalizer.ts` → 稳定 Runtime Event |
| Session Registry | ✅ | `sessionRegistry.ts` |
| Host 协议命令接线 | ✅ | session.* + `permission.respond`；question 仍 stub |
| Stop（Host 侧） | ✅ | AbortController；smoke `STOP_AFTER_MS` 通过 |
| 协议 smoke | ✅ | `spikes/phase2-sdk-runtime-smoke.ts` → `PONG` |
| Main：命令/事件 + IPC 推送 | ✅ | `AgentHostManager` session API；`ipc/chat.ts`；`CHAT_RUNTIME_EVENT` |
| Preload `electronAPI.chat` | ✅ | create/send/stop/close + `onRuntimeEvent` |
| Chat Store 接真事件 / Composer Stop | ✅ | 替换 Mock；`session-live` 发真 Host；Composer 有 Stop |
| Permission 桥 happy path | ✅ | `permissionBridge.ts` + `canUseTool`；unit smoke 通过 |
| agent-host 打包产物（C-01） | ✅ | `pnpm build:agent-host` → `out-agent-host/`（87MB）；产物 PONG/permission smoke 通过 |
| 打包态整链验证（C-02） | ✅ | afterPack 拷贝产物（extraResources 有 node_modules 排除与 rcedit 竞态两坑，见主线台账）；`pnpm verify:packaged` 22 项全绿；CI 两作业已接 agent-host 构建+断言 |
| Tool 事件进时间线（UI） | 🟡 | Store/UI 已支持；依赖模型实际调工具 |
| stream-json Adapter | ⬜ | fallback，可后置 |
| Resume 历史重放 | ✅ | C-06（Phase 3 项提前收口）：`session.history` 协议 + Host 读 JSONL + store 灌入，`db41f63` |
| Question 桥 | ✅ | C-04：questionBridge + 协议重塑 + store，网关 smoke 三场景绿，`c9522d2` |

### 节点 1 验收证据

```bash
cd src/agent-host
node --experimental-strip-types spikes/phase2-sdk-runtime-smoke.ts
# ok: true，assistantPreview: "PONG"
```

注意：SDK `options.executable` 须传 **绝对 Node 路径**（`process.execPath`）。

### 节点 2 验收要点

- Renderer：`window.electronAPI.chat.ensureHost()` → `createSession` → `send` → `onRuntimeEvent`
- Main 将 Host stdout Runtime Event 广播至所有窗口（`chat:runtimeEvent`）
- Host 生命周期仍可用 `electronAPI.agentHost.*`

### 节点 3 验收要点

- Settings → Appearance → 打开 OpenChamber Workspace Shell
- 选中 **Live Agent Host**，发送短 prompt（如 `Reply with exactly: PONG`）
- 时间线出现 user + assistant 流式文本；运行中可 **Stop**

### 节点 4 验收要点

```bash
cd src/agent-host
node --experimental-strip-types spikes/phase2-permission-bridge-unit.ts
# ok: true — request→respond allow；abort→deny

node --experimental-strip-types spikes/phase2-permission-smoke.ts
# ok: true — Write 触发 permission.requested → respond(allow) → tool.completed → PERM-OK
```

UI：时间线 Permission 卡 → Allow/Deny → `chat:respondPermission` → Host 继续/拒绝工具。  
Host 选项要点：`tools: claude_code` preset；`settingSources: []`（避免 settings.allow 阴影 canUseTool）；`thinking: disabled`；勿设 bare `allowedTools`。

---

## 下一步

**➡️ 当前任务状态、Active TODO、阻塞与未决问题一律看 [`docs/plantree/plans/openchamber-chat-refactor/`](../plantree/plans/openchamber-chat-refactor/implementation-status.md)**（2026-07-24 起唯一活动状态视图；本节不再逐日维护）。

快照（2026-07-24 规整时点）：主线 C-xx 全 ✅（剩机动 C-11 / Phase 5 C-12）；双轨已合一；下一个开发任务 T-05；等用户的三件事 = GUI 联调五项（T-02/03/04/06/07）、T-10 点验（→CP2）、C-15 体积拍板。测试凭证约定见执行计划 §4。过程明细记两条子台账（档案）；里程碑达成回填本文件检查点。

---

## 环境与约束备忘

- 开发机：正常环境，无 TSD；可做 Node / Cometix / SDK / Host / 布局壳  
- 加密机：TSD 解密、白名单读文件验收  
- 不要按旧 PROGRESS「拷 OpenChamber UI + 升 Electron + 弃 Worktree」路线做  

---

## 关键路径速查

```text
docs/plans/2026-07-23-openchamber-chat-refactor-ard.md   # 权威
docs/plans/2026-07-23-openchamber-chat-refactor-execution-plan.md  # 双轨执行计划
docs/plans/phase0-report.md                              # Phase 0 证据
docs/plans/openchamber-chat-refactor-ledger.md           # 本总台账
docs/plans/ledger-claude-mainline.md                     # 🤖 Claude 主线台账
docs/plans/ledger-team-track.md                          # 👥 团队轨道台账
docs/design/phase0a-openchamber-alignment.html           # Phase 0A 视觉/布局基线（A01/A05/A06）
CONTEXT.md                                               # 术语
src/agent-host/                                          # Node 24 Host
  permissionBridge.ts / claudeRuntime.ts / eventNormalizer.ts
src/main/services/agent-host/AgentHostManager.ts         # Main 侧命令 API
src/main/ipc/chat.ts                                     # Chat IPC + 事件广播
src/preload/index.ts                                     # electronAPI.chat
src/renderer/components/workspace-shell/                 # 四区壳
src/renderer/stores/chatSessions.ts                      # Chat Store（真 Runtime）
```

> 注（2026-07-28，D19）：上表 `workspace-shell/` 标注的「四区壳」是 2026-07-23 落地时的形态；目标形态已改为**三列 + 44px 导轨 + surface 模型（无底部面板）**，改造归 **T-22**，届时删除 `BottomDock.tsx`。
