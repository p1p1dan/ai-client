# OpenChamber 气泡对话重构 — 双轨执行计划表

> 文档日期：2026-07-23
> 权威：[`2026-07-23-openchamber-chat-refactor-ard.md`](./2026-07-23-openchamber-chat-refactor-ard.md)（ARD）
> 总台账：[`openchamber-chat-refactor-ledger.md`](./openchamber-chat-refactor-ledger.md)
> 分支：`feat/openchamber-chat-refactor`
> 状态：已与用户对齐执行形态，随做随更

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
| **M4** | Phase 4 完成：Git/Files/Context/Terminal 接线，不必切旧界面 | 👥 为主，🤖 支援 | CP7 |
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
| **C-12** | （Phase 5）旧路径收缩 + 性能压测 | AgentPanel Claude 主路径收缩、`App.tsx`/`MainContent.tsx` 清理（App 只装配）；千 block 会话压测→虚拟化决策；确认 ARD §8 清理项（`ai-chat/` 已不存在，验证 `shared/types/ai-chat.ts` 状态） | 旧界面其他 Agent 入口不回归；压测数据记台账 | M3/M4 后 | 2.5d |

**主线推进顺序**：C-01 → C-02（M1/CP2）→ C-07（解锁 T-02）→ C-06（CP4，解锁 T-03）→ C-03 → C-04 → C-05（CP3）→ C-09 → C-08 → C-10 →（机动 C-11）→ C-12。

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
| **T-05** | Tool Card 增强 + Question 卡 | `MessageTimeline.tsx`：通用 Tool 卡（运行中 spinner/完成折叠/input-output 截断展开）+ 常见工具摘要行（Read/Write/Edit→路径，Bash→命令首行）+ tool_result 按 toolCallId 与 tool_call 关联渲染；Question 卡（选项/自由文本→respondQuestion→单次响应后冻结） | 真实工具调用观感验收；question smoke 场景 UI 走通 | Question 部分依赖 C-04 | 1.5d |
| **T-06** | 消息元数据 + 错误/重试 | assistant 元数据行（模型·耗时·时间，源 `message.completed`/`usage.updated`）；`session.failed` 错误卡保留已产内容 + 重试（重发上条 user 消息）；lastError 提示条归位 | 断网/杀 Host 场景 UI 清晰可恢复 | 无 | 1d |
| **T-07** | Composer @ 文件引用 | @ 触发文件搜索浮层（迁移 `EnhancedInput.tsx` 有价值逻辑）；引用 chip；发送拼 `@path` 纯文本（CC 原生识别）；不做拖拽/图片 | @ 引用真实文件发送，模型能读到内容 | 无 | 1.5d |
| **T-08** | Model 选择器 | Composer/Header 模型下拉（源：settings 配置 + `host.ready.settings.model` 默认）；`session.create payload.model` 已支持；会话级固定 | 切换模型新建会话，元数据显示对应模型 | 无（Effort/Plan 控件等 C-10） | 0.5d |
| **T-09** | 空/错/断状态 + 诊断面板 | Host 未就绪骨架屏；Node 24 未找到引导（`NodeRuntimeResolver` 诊断 + `AICLIENT_NODE24_PATH` 指引）；诊断展示（Node 路径/版本、Cometix 版本、settings 脱敏态——`host.ready` payload 已带）；Host crash 断连提示与恢复 | 改坏 Node 路径场景走通引导；杀 Host 进程有断连提示且可恢复 | 无 | 1d |
| **T-10** | 打包版 GUI 手工点验（M1 后半） | 按 C-02 移交的清单：安装/便携版启动→Beta 壳→ensureHost→PONG 会话→权限卡 roundtrip→Stop→退出后任务管理器无 node.exe 残留 | 清单全勾 + 记录进团队台账 → CP2 | C-02 | 0.5d |
| **T-11** | **M2 加密机验收**（现场） | 按 Claude 提供的 checklist：① 白名单 Node 24 `process.execPath` 记录；② 已知 TSD 加密文件 Host 读出解密内容（非 `%TSD-Header-###%`）；③ 打包版启动 Host 在真实加密工作区跑通对话（读文件工具真实可用）；④ 退出无孤儿；⑤ `~/.claude/projects` JSONL Host 侧可读（C-06 前提） | 全项证据回填 `phase0-report.md` + 总台账；Conditional Go → **正式 Go**（CP5） | T-10 | 1d 现场 |
| **T-12** | Phase 4：右栏 Git 面板 | 现有 sourceControl 视图迁入 `RightDock.tsx` tab；当前 Workspace 联动；changed/staged/diff/commit 最小集 | Git 状态来自真实当前 Workspace | M3 主体后 | 1d |
| **T-13** | Phase 4：右栏 Files 面板 | 现有文件树迁入；打开文件（中央临时切 Monaco 或跳现有编辑区）；与 T-07 @ 引用联动 | Files 可打开编辑；对话引用文件可跳转 | M3 主体后 | 1.5d |
| **T-14** | Phase 4：右栏 Context 面板 | 真实基础字段：Workspace 路径、分支、模型、权限策略、附加文件、运行状态。**只放真实数据**（ARD：不展示假状态） | 字段与实际会话一致 | M3 主体后 | 0.5d |
| **T-15** | Phase 4：Terminal Dock 接真终端 | `BottomDock.tsx` 接现有 xterm/node-pty 体系；按 Workspace 恢复终端；与旧终端区并存策略 | Terminal 可用；切 Workspace 恢复对应终端 | M3 主体后 | 1.5d |
| **T-16** | Phase 4：新旧开关成熟化 | Beta 开关默认策略；旧 AgentPanel 保留其他 Agent 终端入口；新壳缺功能时的回退路径说明 | 用户不必在新旧界面间来回切换核心流程 | T-12~15 | 1d |
| **T-17** | Tool 真实调用 GUI 验收（立即可做） | 开发态壳：让模型真实调用 Write/Bash（如「Create PING.txt with content pong」）；验证时间线完整出现 tool_call→permission 卡→allow→tool_result→文件真实生成。这是对现有 Phase 2 成果的验收，补总台账 Phase 2 检查点 | 操作记录/截图 + 台账检查点行 | 无 | 0.5d |

**团队起步顺序建议**：T-17（半天，先验收现有成果）→ T-01 → T-06/T-07/T-08/T-09（无依赖并行池）→ 等 C-07/C-06 后 T-02/T-03 → T-04/T-05 → T-10 → T-11（M2）→ Phase 4（T-12~16）。

---

## 4. 协作规则

### 文件所有权（避免双轨冲突）

| 区域 | 主导方 | 说明 |
|---|---|---|
| `src/agent-host/**`、`src/main/services/agent-host/**`、`src/main/ipc/chat.ts`、`src/preload`（chat 段） | 🤖 | 团队如需新 IPC，提需求给 Claude |
| `src/shared/types/runtimeEvents.ts`、`agentHost.ts` | 🤖 | **协议 = 唯一汇合点**，见下 |
| `src/renderer/stores/chatSessions.ts` | 🤖 | 团队通过 store 暴露的 actions/selectors 消费，不直接改结构 |
| `src/renderer/components/workspace-shell/**`、`chat/`（卡片/Timeline/Composer） | 👥 | Claude 不主动改动，需要时提需求给团队 |
| 现有旧模块（AgentPanel 等） | 👥 日常维护 | Phase 5 收缩由 🤖 主导（C-12） |

### 协议变更纪律

1. 变更 `shared/types/runtimeEvents.ts` / `agentHost.ts` 必须由 Claude 主线发起，先落类型与文档，再动实现；
2. 破坏性变更 bump `AGENT_HOST_PROTOCOL_VERSION`；
3. 变更后在总台账记一行并通知对方；CP4（`session.history`）定稿前团队不要动 Resume 数据层。

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
🤖 C-06 (CP4) ────→ 👥 T-03 ─┼→ M3 (CP6) → Phase 4 (T-12..16, M4) → Phase 5 (C-12+回归, M5)
🤖 C-05 (CP3) ────→ 👥 T-04 ─┤
🤖 C-03 → C-04 ───→ 👥 T-05 ─┘
🤖 C-09 → C-08（store 结构，先锁行为再改结构）
👥 T-01 / T-06..T-09 / T-17：无依赖，随时可做
```

## 6. 工作量汇总（估）

| 轨道 | 近期（Phase 2 收尾 + Phase 3） | Phase 4 | Phase 5 | 合计 |
|---|---|---|---|---|
| 🤖 Claude 主线 | C-01~C-10 ≈ 10.5d | 支援 | C-12 ≈ 2.5d（+机动 C-11 1.5d） | ≈ 13~14.5d |
| 👥 团队轨道 | T-01~T-11、T-17 ≈ 11.5d | T-12~16 ≈ 5.5d | 回归分摊 ≈ 2d | ≈ 19d |

双轨并行、含联调与波动，预计 **4~5 周**到 M5（与可行性报告双人 5~8 周口径一致，因 Phase 0/1/2 已完成大半而缩短）。

## 7. 执行层风险提示

1. **C-01 打包是最大不确定性**：SDK/Cometix 嵌套依赖形态（cli.js 路径解析、wasm、win32-x64 原生包）。超期时优先保「整树拷贝跑通」，瘦身后置。
2. **C-06 JSONL 格式漂移**：格式属 CC 内部实现；pin 2.1.212 缓解；解析必须宽容（未知行跳过），崩溃兜底 = ARD 后置项「历史快照」。
3. **T-01 触碰现有 stores**：只读派生、不改写现有 store 行为，避免影响旧界面。
4. **Question 形态若 SDK 无原生支持**：fallback = 按 permission 流拦截 AskUserQuestion 工具（C-03 已列）。
5. **联调错峰**：C-06/C-07 延期时团队先消化无依赖池（T-06~T-09），不空转。
