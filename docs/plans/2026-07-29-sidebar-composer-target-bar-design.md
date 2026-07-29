# 侧栏两层化 + Composer 目标栏三下拉 —— 合并设计方案(2026-07-29)

> 背景:用户 2026-07-29 拍板方向——左侧栏对齐 openchamber(文件夹→对话→subagent,subagent 量力),
> 仓库/git 选择参考 Cursor(输入框上方三下拉:文件夹 / 分支 / 运行位置)。
> 过程:两名独立设计者(deep-reasoner/Opus 与 Codex,互不见对方方案)各自产出后由主线合并;
> 两方案在全部核心裁定上**独立收敛**,分歧仅在四个呈现层问题(见 §7 待拍板)。
> 参考版本:openchamber `a3519141`(双方各自核实)。视觉硬约束:**零新视觉值**
> (基线 `docs/design/phase0a-openchamber-alignment.html` 未覆盖 Composer/下拉形态,见 §7-D)。

## 1. 一句话结论(两方案独立得出同一结构)

**把「运行目标」(哪个仓库/哪个 worktree/在哪跑)从侧栏树层级挪到 Composer 顶部目标栏;
侧栏因此从三层降为两层(文件夹 → 对话),与 openchamber 对齐。**
用户的两个诉求是同一个改动的正反面:openchamber 两层布局之所以在我们这儿变三层,正是因为
`Workspace(worktree)` 被当成了组织层级;Cursor 三下拉的本质就是把这个维度移到 Composer 上。

参考实现双重背书:openchamber 把 worktree**数据层保留、渲染层刻意移除**
(`sidebar/DOCUMENTATION.md:6,13`),并把「去哪跑」放在输入框上方
(`DraftTargetSelectors.tsx:1-8`:*"Where a new session will run"*,项目 + 分支两个选择器)。

## 2. 数据地基(零数据模型改动、零新 IPC)

- `ChatSession` 已自带 `projectId`(`chatSessions.ts:41`)→ 两层树免改模型。
- `Workspace` 的唯一实质作用是 agent 的 cwd(`ChatComposer.tsx:210-211/371`)——它是
  **运行目标属性**,不是组织层级;数据模型不删,只从树里降级。
- 三下拉数据源全部现成:仓库列表 `effectiveRepos`、worktree `worktree.list`(staleTime 30s)、
  已落盘 MRU `session-index.json`(全仓唯一持久化 MRU;内存 `chatSessions` 无 persist,冷启动为空)、
  运行位置 `useRepositoryRuntimeContext`(真实 local/remote)。详细 file:line 见两份原始方案
  (session scratchpad,要点已并入本文各节)。
- 四个坑位(实现前必读):① `git.getBranches` 每次 shell out `gh pr list`(5s 超时),只准在
  「New worktree…」对话框打开时调用,分支下拉一律走 `worktree.list`;② `worktree.list` handler 有
  `clearWorktrees()` 再注册的全局副作用(既存 bug,扇出时 auto-fetch 只剩最后一个仓库,须另行立项);
  ③ 分支名不可规范化(`remotes/` 前缀有特判,原样透传);④ 非 git 目录是一等公民,分支下拉以
  `isGitRepo === true` 为显示前置。

## 3. 侧栏信息架构(→ 新任务 T-26)

- 目标层级:`Recent(跨文件夹) + 文件夹(ChatProject) → 对话(ChatSession)`。
- **关键不变量:Workspace 不再是树层级**——不可选中、不承载展开态、不参与键盘导航、
  不作为新建会话落点;`selectedWorkspaceId` 概念从 LeftNav 移除,选择权唯一移交目标栏。
- worktree 的呈现二选一(待拍板 §7-A):`by-worktree` 吸顶子标题带(openchamber 默认,
  `useSessionDisplayStore.ts:8/53`)或 `flat` + 行内分支 chip(main worktree 不显 chip 防噪音)。
- Recent 段:保留(openchamber 有且 ARD §4 图有),口径照抄参考实现——未归档 + 非子会话 +
  (活跃 或 48h 内),默认 7 条 + Show more,可整段关闭;数据源用 `session-index.json` 的
  `updatedAt`(Codex 方案主张移除该段,列为 §7-C 待拍板,合并稿默认保留)。
- 空文件夹仍显示并给 `+ 新建对话` 行;点击历史会话仍按 `session.workspaceId → workspace.path`
  恢复原执行上下文(该链路现成,`LeftNav.tsx:104-114`)。
- 逻辑下沉纯函数 `sidebarTree.ts`(vitest 只收 `.ts`),核心断言:flat 模式下同 project 跨
  worktree 的会话归并同一文件夹节点;band 结构体不携带可选中/可展开语义;孤儿会话不崩不造文件夹。

## 4. Composer 目标栏三下拉(→ 新任务 T-27)

放在 `ChatComposer.tsx:706` 卡片内顶边(阅读栏内,不越 D19 骨架)。组织原则:
**顶行 = 在哪跑(目标栏),底行 = 怎么跑(现有 Model/Effort)**,同为 per-session、下次
createSession 生效,语义自洽。

### 4.1 下拉一:文件夹
搜索框 + Recents(session-index 派生,前 5)+ Repos(按 `Repository.kind` 分 On This PC / Remote;
有 RepositoryGroup 则按组分段)+ 底部动作:`Use Existing…`(→ 共享 `AddRepositoryDialog` 本地模式)、
`Clone…`、`Add Remote…`、`New Folder`(→ **建 Temp Workspace**,复用 `tempWorkspace.create` +
`main/ipc/tempWorkspace.ts:104-120` 现成 IPC——Codex 方案补上了这条路,解决了「任意位置建目录无 IPC」
的缺口;「永久普通目录」另立产品能力,本轮不做)。

### 4.2 下拉二:分支(= worktree)——本设计最重要的语义裁定
**分支下拉 = worktree 选择器 + 新建 worktree 入口,永不执行 in-place `git checkout`。**
两方案独立给出同一裁定,理由:① git 本身禁止同分支双 checkout,worktree manager 里「换分支」
天然=「换 worktree」;② in-place checkout 会在可能正在运行的 agent 的 cwd 底下换地板;
③ 与产品定位(一分支一 worktree)冲突。
内容:搜索框 + Main 置顶 + Recent(该 project 会话 `updatedAt` 派生)+ 其余 worktree +
`New worktree…`(受控打开既有 `CreateWorktreeDialog`,成功后自动切目标;openchamber 同款,
`DraftTargetSelectors.tsx:156-163`)。未物化分支点击 → 直接进新建 worktree 流程预填分支。
禁止:复用 `BranchSelector` 的 `onCheckout` 行为(只借视觉);同时维护 `selectedBranch` 与
`selectedWorkspaceId` 两个可写真相(分支显示值一律由 workspaceId 派生);detached HEAD 显式标注不猜名。

### 4.3 下拉三:运行位置(待拍板 §7-B,两案分歧点)
- **Opus 案(合并稿推荐)**:降级为**派生只读指示器**——数据源 `useRepositoryRuntimeContext`
  (真实 local/remote),remote 是仓库属性而非独立运行维度;数据缺失时隐藏而非显示 `This PC`。
  旁证:openchamber 压根没有这个下拉。
- **Codex 案(更贴 Cursor 形态)**:保留下拉,`This PC` 打勾,Cloud / Remote Machines 为
  **真 disabled** 项(不可静默点击);Remote Control 卡片不做。
- 共同底线(T-23 戒律):无假选项、无可点无反馈、`New Worktree` 不放这里。

### 4.4 目标改变的重定向规则(防「改了下拉但 agent 还在老目录跑」)
沿 `rebindSessionsToTree` 拒绝重绑 host-bound 会话的既有原则(`useSyncChatWorkspaceTree.ts:109-112`):

| 会话状态 | 动作 |
|---|---|
| 无消息且未 host-bound | `retarget`:就地改 projectId/workspaceId |
| 已有消息或已 host-bound | `fork`:新目标下新建会话并切过去,旧会话不动 |
| starting/running/stopping/waiting_* | `blocked`:目标栏 disabled(照 Model/Effort 先例) |

下沉纯函数 `composerTarget.ts`;**关键流程断言**(规范第 4 条):
`target.changed → session.created{cwd} → session.send` 且 `cwd === 新 workspace.path`;
分支切换场景 spy 断言 `git.checkout` IPC 调用次数为 0。

## 5. subagent 层:后置(两方案独立同判),前置路径已探明

不是「不好实现」,是**无数据源**:Host 协议 25 种事件无子会话实体,`eventNormalizer` 省掉
`parent_tool_use_id`,`historyReader` 按文件名过滤 + 不递归 + `isSidechain` 丢弃。
openchamber 的第三层是**后端送的**(子代理=带 `parentID` 的普通 Session),我们要先造数据。
解冻双路径(→ open-q #17):**Path B 建议先行**——读磁盘 `<session>/subagents/agent-*.jsonl` +
`.meta.json`(`toolUseId` ↔ 已保留的 `ChatBlock.toolCallId` 可直接 join),只动 historyReader;
Path A(SDK `forwardSubagentText` 直播)作为后续增强。⚠️ 派生工具名是 **`Agent`** 不是 `Task`。
真做时优先落**时间线内嵌 transcript**(Agent 工具卡展开),侧栏第三层为次级入口。

## 6. 对现行计划的改动(账实更正 + 新任务)

- **T-24 账实不符(过程缺口,已核实)**:其实体(LeftNav 三处入口、拖放 ref 绑新壳、
  `addRepositoryEntry.ts`/`fileDragDrop.ts` + 测试)已随 `b38017b`(名义 T-21)落库,
  提交信息零次提及 T-24,plantree 四处仍标「阻断级未开工」。**裁定:不重定义 T-24**——
  它按原验收口径已在代码层达成,剩余=全新机器 GUI 实测 + 台账补登(S0,不改代码);
  文件夹下拉是增强,归 T-27。违反工程规范第 15 条,门禁建议:提交信息必须枚举其闭合/推进的任务号。
- **新任务**:**T-26** 侧栏两层化(D21 落地,≈1~1.5d,可先于 T-22;两者都碰 LeftNav,
  按 T-26 → T-22 串行);**T-27** Composer 目标栏(D22 落地,≈1.5d,依赖 T-26;
  顺带删除 `MainHeader.tsx:57/58` Folder / Host: Local 两个死按钮,T-23 对应子项改为「删除+复核」)。
- **拟新决策(待用户拍板后进总台账)**:
  - **D21|侧栏信息架构**:侧栏「文件夹→对话」两层;Workspace 从树层级降为会话的运行目标属性,
    选择权唯一在 Composer 目标栏;subagent 层后置。
  - **D22|Composer 目标栏**:Composer 卡片顶部三下拉;分支下拉只做 worktree 选择与新建、
    **禁止 in-place checkout**;运行位置无假选项(形态按 §7-B 拍板结果)。
- **连带改写**(拍板后执行):ARD §4:88-95 数据层级文字块(两层 + Workspace=运行目标属性;
  不属 D19 条款,非推翻 D19);执行计划 §3 起步顺序改
  `T-24(收尾验收)→ T-26 → T-22 → T-27 → T-05 → T-12~15 → T-23 → T-16 → T-25`;
  T-14 行加「context surface 只读,路径/分支修改入口全仓唯一在目标栏」;T-12/T-13/T-15 行
  加单源 Workspace 同步与不重绑条款(Codex 案 §6.3-6.6 逐行文本可直接取用)。
- **实施切分**:S0 关 T-24(0.5d,不改代码)→ S1 T-26 → S2 T-22 → S3 T-27,每步纯函数断言先行,
  验收场景含:全新用户全流程 `pwd` 正确、多 worktree 会话各自恢复原 cwd、切已有 worktree 零 checkout、
  未物化分支走建 worktree 流程、DEMO seed/坏路径不能创建会话。

## 7. 待用户拍板(按影响排序,均已给建议)

| # | 问题 | 建议 |
|---|---|---|
| **A** | 侧栏 worktree 呈现默认:`by-worktree` 吸顶带(openchamber 默认)还是 `flat`+chip(更简、更贴「文件夹→对话」字面) | **`by-worktree` 默认 + `flat` 作显示开关**(用户要 openchamber 观感);赶工期可先 `flat`,登记为暂时偏离 |
| **B** | 运行位置:只读指示器(Opus,最诚实)还是带 disabled 项的下拉(Codex,更贴 Cursor 三下拉形态) | **只读指示器**;若想要 Cursor 完整形态则取 Codex 案(真 disabled,不可静默点击) |
| **C** | 侧栏 Recent 段:保留(openchamber 有)还是移除(Codex 认为与文件夹下拉 Recents 重复) | **保留**,照参考实现口径(48h/7条/可关) |
| **D** | Composer/下拉**无观感基线**(基线 HTML grep composer/dropdown 零命中):零新视觉值(全复用 ModelSelect 的 `h-6 text-xs` 等现有原语)还是先补一版基线(A07) | **本轮零新视觉值**;想要 Cursor 独立观感再立 A07 |
| E(低风险默认) | 目标栏常驻(Cursor 形态)vs 仅新会话草稿态显示(openchamber 形态,天然回避改绑) | 常驻,安全靠 §4.4 三档规则;实测不适再退草稿态(有参考实现背书) |

## 8. 原始方案存档说明

两份独立方案全文在会话 scratchpad(`design-opus.md` / `design-codex.md`),要点已并入本文;
证据 file:line 若与本仓演进冲突,以工作树实测为准。分歧全部显式列在 §7,未做静默取舍。

---

## 9. 拍板结果(2026-07-29 当日,用户逐条裁定,决策入总台账 D21~D23)

| # | 拍板 | 与 §7 建议的关系 |
|---|---|---|
| A | **`flat` 平铺 + 分支 chip**(方案二),视觉参照 Cursor 侧栏截图(会话行右对齐相对时间、Repositories 段头带筛选/添加图标) | 与建议相反(建议是 by-worktree 默认)——用户偏好平铺,`by-worktree` 不做 |
| B | **只读指示器**(方案一),远程功能上线后再升级为下拉 | 采纳建议 |
| C | **Recent 段保留**(用户保留否决权:「后面不喜欢再删」) | 采纳建议 |
| D | **超出原二选一**:用户要求**中列整体对齐 Cursor 风格**——空态 Composer 垂直居中+目标栏在上,会话态时间线+Composer 沉底+目标行在下,「不要做成现在这种底部的聊天软件风格」 | 演化为:立项 **A07** 观感基线(Cursor 截图 × Flexoki,用户验收后施工)+ **T-28** 中列状态化布局;工具行/问答卡仍按 T-05 openchamber 口径(D23 边界);会话 Tab 栏是否引入 → A07 出带/不带两版验收时定 |

参照截图已入库:`docs/design/refs/cursor-20260729/`(侧栏样式 / 初始未发消息状态 / 发起对话后状态 / 三个下拉展开态)。
