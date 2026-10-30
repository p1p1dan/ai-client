# PiLab 会话体验与输出展示优化：复核与验收台账

状态：R0 执行中
源码基线：`69f2e45511cd9ed2d5a7b19b2671671fb32bda93`
建立日期：2026-10-29
需求依据：`D:/Projects/duibifenxi/PRD.md`、`analysis/development-plan.md`、`analysis/acceptance-checklist.md`

## 1. 基线与执行约束

- 分支：`main`，跟踪 `origin/main`。
- 初始工作区：仅有未跟踪目录 `release-artifacts/`，保留且不提交。
- 现役执行引擎：`dsh`、`claude-sdk`；`pi` 仅用于可读历史及继续时迁移，不作为第三套现役 UI 路径。
- 首要运行验收平台：Windows。构建脚本提供 macOS、Windows、Linux 目标；实际发布支持矩阵和 IME/DPI 范围待 R0 运行确认。
- 本台账的“源码不通过”表示当前实现已直接违反必需行为；其余条目在自动测试和真实 Electron 证据完成前不标通过。
- UI、展示和动效遵守 `docs/design-system.md` v2；视觉母版为 open-claude-ui，行为冲突时以本 PRD 为准。
- 测试遵循低资源约束：单文件或小批次、`--maxWorkers=1 --no-file-parallelism`，重任务串行，构建分阶段执行。

### 已确认命令

| 用途 | 命令 |
|---|---|
| 开发 | `pnpm dev` |
| 自动测试 | `pnpm test -- <相关文件> --maxWorkers=1 --no-file-parallelism` |
| 类型检查 | `pnpm typecheck` |
| DSH 类型检查 | `pnpm typecheck:dsh-host`（依赖准备后） |
| Claude SDK 类型检查 | `pnpm typecheck:claude-sdk-host` |
| 静态检查 | `pnpm lint` |
| 分阶段宿主构建 | `pnpm build:dsh-host`、`pnpm build:claude-sdk-host`、`pnpm build:plugin-host` |
| 完整生产构建 | 低资源主机不直接运行；拆分验证或留待高资源环境 |

## 2. 状态、任务与证据规则

| 状态 | 使用条件 |
|---|---|
| 通过 | 全部必需条件具有当前 SHA 的源码、自动化和所需真实运行证据 |
| 部分通过 | 部分条件已验证符合，其余未覆盖或未满足；关联整改/验证任务 |
| 不通过 | 已复现或由当前源码直接确认违反必需条件；关联缺陷和复测 |
| 待验证 | 只有入口/静态基础，或缺少必要场景、宿主侧、运行、性能证据 |

| 执行任务 | 内容 |
|---|---|
| #1 | R0 基线与全量台账 |
| #2 | 协议映射、F01～F08 固定回放、真实 UI/性能基线 |
| #10 | S0 前置：既有保存入口的文件基线保护 |
| #11 | S0 前置：消息与传输事件按身份幂等且不丢正文 |
| #3 | R1 核心阅读、状态、滚动与恢复 |
| #4 | R2 输入、模型用量、差异与可访问性 |
| #5 | R3 预览、窗口、会话与多代理协作 |
| #6 | 三套规范内视觉样张，统一后置评审 |
| #7 | 全量回归、性能兼容与证据包 |
| #8 | 用户统一视觉/关键行为评审 |
| #9 | 选定视觉整合、最终回归与交付 |

每次复测需追加：执行人、日期、SHA、平台/IME/DPI/硬件、输入或事件序列、实际结果、自动测试命令与结果、截图/录像/诊断、缺陷及回退结论。截图不能替代权限、执行、计量和文件写入的权威侧证据。

## 3. 已确认缺陷

| 缺陷 | 等级 | 需求 | 当前源码证据 | 用户影响 | 整改 |
|---|---|---|---|---|---|
| DEF-001 | S1 | FR-01；AC-01、03 | `turnProcessFold.ts:140-190` 将运行中的 answer 与非最终 answer 收入 processGroup；`MessageTimeline.tsx:2927-2956` 同组渲染 | 收起过程会隐藏合法正文，多阶段正文不能始终直接阅读 | #3 |
| DEF-002 | S1 | FR-02；AC-02、05 | `toolCard.ts:1531-1566` 每个 thinking entry 建行；`turnProcessFold.ts:248-251` 运行组默认展开 | 长任务中思考行持续累积，主区被过程占满 | #3 |
| DEF-003 | S1 | FR-02；AC-06 | `MessageTimeline.tsx:2924-2926` 以 `${groupKey}:${processSettled}` 保存选择；完成时键改变，默认又变为收起 | 用户正在阅读的详情可能被完成事件收起，运行中的选择不能延续到结束 | #3 |
| DEF-004 | S0 | FR-07、14；AC-39 | `main/ipc/files.ts:580-591` 直接写入；`hooks/useEditor.ts:91-99`、`source-control/DiffViewer.tsx:876-909` 未提交预期基线 | 文件从 A 被外部改成 B 后，基于 A 的保存可静默覆盖 B | #10，先于 R1 |
| DEF-005 | S0 | FR-01、13；AC-01、04、10 | `chatSessions.ts:2056-2083` 对每次 `message.started` 都以空 blocks 覆盖；`chatSessionsCore.test.ts:63-99` 固定该行为 | delta 后重放开始事件会清空已接收正文，破坏传输重放幂等 | #11，先于 R1 |
| DEF-006 | S0 | FR-01、05、13；AC-04、08、10 | `chatSessions.ts:2592-2604` 逐事件消费但没有传输身份去重；`WorkerManager.ts:5178-5185` 在 Main 分配单调 seq | 同一 renderer 传输事件重放会重复追加 delta；去重又必须区分不同 seq 的合法相同增量 | #11，先于 R1 |
| DEF-007 | S1 | FR-07、14；AC-39 | 2026-10-30 Linux 真实窗口：`EditorColumn.handleSave` 为 `saveFile.mutate(path)` 无 onError；关标签自动保存路径未捕获；「保留本地」只隐藏横条不推进基线 | 保存被拒时用户无任何提示、以为已保存；冲突后无法保留自己的版本 | 已修复（§13 补记），用户裁决「保留本地」= 用我的版本覆盖 |
| DEF-008 | S1 | FR-11.1；AC-18 | `messageTimelineScroll.ts` 只按距底 40 px 判断，↑/滚动条小幅上移被拉回 | 键盘与滚动条无法脱离跟随 | 已修复（§14） |
| DEF-009 | S1 | FR-11.3；AC-19 | `overflow-anchor:none` 且无补偿；回合结束收起上方组时阅读位置上跳 144 px | 正在读的内容被移出视野 | 已修复（§14） |
| DEF-010 | S1 | FR-13.6；AC-22 | `splitTurnWorkGroup` 不看异常结束，半截正文标「最终输出」 | 中断内容被呈现为完成结论 | 已修复（§14） |
| DEF-011 | S0 | FR-05.5；AC-12 | 审批卡缺编辑的 old/new/replace_all、通用与 MCP 参数，多行命令被截断 | 用户可能批准未看清的操作 | 已修复（§14） |
| DEF-012 | S2 | FR-05.8；AC-15 | `useRespondPermission` 失败只解锁按钮 | 用户以为已批准/拒绝 | 已修复（§14） |
| DEF-013 | S2 | FR-11.4 | 内部输出框无 `overscroll-contain`；框内上滚停止主跟随 | 滚动串到主时间线 | 已修复（§14） |
| DEF-014 | S3 | FR-02.6 | 箭头动画、提示栏平滑滚动不看 reduced motion | 减少动态效果偏好无效 | 已修复（§14） |
| DEF-015 | S1 | FR-13.6；AC-22 | Claude SDK `readTranscript` 丢弃 `[Request interrupted by user…]`，不设 `stopCause`/未完成 | 重开后被停的回合像正常完成；停在思考中的回合不留任何痕迹；被停的命令显示为失败原句 | 已修复（§15） |
| DEF-016 | S3 | FR-05 | Claude SDK 工具失败结果原样带 `<tool_use_error>` 标签 | 失败行露出给模型看的标签 | 已修复（§15） |
| DEF-017 | S2 | FR-02；AC-22 | Claude SDK 历史不带时间（SDK 读取接口不给 timestamp） | 重开后回合底部没有「完成于 / 用时」 | 已修复（§15） |
| DEF-018 | S2 | FR-03.4；AC-24 | `@` 菜单不认 Tab（焦点离开、菜单不关）；光标移出 `@` 词后菜单不跟随，Home 后回车被吞，左移后选中把词拆成 `@path ry` | 引用写坏或按键无反应 | 已修复（§16） |
| DEF-019 | S2 | FR-03.4、03.5；AC-24 | 带空格的路径插成 `@My Docs/a.md`，标签只认出 `My` | 引擎/模型拿到被截断的路径 | 已修复（§16），按 Claude Code 写成 `@"My Docs/a.md"` |
| DEF-020 | S3 | FR-03.4 | `@src\main`（Windows 反斜杠）搜不到；旧搜索结果可能盖住新结果 | Windows 用户打路径找不到文件 | 已修复（§16） |
| DEF-021 | S1 | FR-03.7；AC-25 | 发送在引擎接收前被拒，「重试」只存在组件状态里，切走对话即丢失 | 用户的消息和附件消失，时间线里也没有 | 已修复（§16） |
| DEF-022 | S1 | FR-03.7；AC-25 | 附件读取中切换对话，读完的附件落进新对话并随它发送；读取计数跨对话共享 | 文件发到错误的对话 | 已修复（§16） |
| DEF-023 | S3 | FR-03.1 | 问题卡「其他」输入框只看 `isComposing` | 少数输入法选词回车可能直接提交 | 已修复（§16） |

这些结论只覆盖已读分支，不推断其他路径已经通过。

## 4. 源码与测试入口索引

| ID | 实现入口 | 已定位测试（存在不等于通过） |
|---|---|---|
| R01 | `chatTurn.ts:100-120,214-225,268-354`；`turnProcessFold.ts:40-251`；`MessageTimeline.tsx:2022-2173,2647-2974` | `chatTurn.test.ts`、`turnProcessFold.test.ts`、`messageTimelineWiring.test.ts`、`turnEndOpenInteraction.test.ts` |
| R02 | `thinkingCard.ts:25-50`；`toolCard.ts:1531-1566`；`ToolRows.tsx:472-493,584-643,1353-1458`；`stores/toolExpansion.ts:52-143` | `thinkingCard.test.ts`、`thinkingStreamRender.test.ts`、`toolExpansion.test.ts`、`timelineDisclosureFollow.test.ts` |
| R03 | `ChatComposer.tsx:714-747,1112-1258,1998-2174,4574-4824`；`imeComposing.ts:1-16`；`slashCommands.ts:92-285`；`fileMention.ts:24-123`；`composerDrafts.ts:140-405` | `imeComposing.test.ts`、`slashCommands.test.ts`、`fileMention.test.ts`、`composerSessionDrafts.test.ts`、`composerDraftsPersist.test.ts` |
| R04 | `ComposerModelTrigger.tsx:263-690`；`models.ts:115-427`；`efforts.ts:180-235`；`ComposerUsageChip.tsx:10-196`；`sessionRuntimeFacts.ts:39-65`；`contextSurfaceModel.ts:467-685` | `models.test.ts`、`efforts.test.ts`、`composerUsageDetails.test.ts`、`contextSurfaceModel.test.ts` |
| R05 | `toolCard.ts:122-503,840-1051`；`chatSessions.ts:2056-2901`；`PendingInteractionSlot.tsx:22-54`；`PendingPermissionDock.tsx:45-100`；`PendingQuestionDock.tsx:28-98`；`QuestionCard.tsx:257-428` | `toolCard.test.ts`、`toolRowOutcome.test.ts`、`chatSessionsCore.test.ts`、`pendingPermissionDock.test.ts`、`pendingQuestionDock.test.ts`、`questionCardInteraction.test.ts` |
| R06 | `toolDiff.ts:108-188`；`toolDiffView.ts:21-96`；`turnChanges.ts:49-90`；`TurnChangeCard.tsx:16-51`；`DiffViewer.tsx:148-227,707-958,1031-1228`；`chatMarkdownPolicy.ts:507-585`；`ChatCodeBlock.tsx:53-105` | `toolDiff.test.ts`、`toolDiffView.test.ts`、`toolDiffInteraction.test.ts`、`turnChanges.test.ts`、`chatMarkdownPolicy.test.ts`、`chatShiki.test.ts` |
| R07 | `messageTimelineScroll.ts:9-182`；`MessageTimeline.tsx:663-865,1194-1224`；`PromptNavRail.tsx:56-130` | `messageTimelineScroll.test.ts`、`messageTimelineWiring.test.ts`、`timelineDisclosureFollow.test.ts` |
| R08 | `ReadingColumn.tsx:18-20`；`shellLayoutModel.ts:42-56`；`middleColumnLayout.ts:105-133`；`chatTimelineLayout.ts:282-286,487-529,664-810` | `shellLayoutModel.test.ts`、`middleColumnLayout.test.ts`、`chatTimelineLayout.test.ts`、`scrollStateCss.test.ts` |
| H01 | `shared/types/runtimeEvents.ts:21-55,1069-1386`；`WorkerManager.ts:3532-3678,3926-3966,4301-4400`；`chatSessions.ts:1433-1894`；`historyReplayMerge.ts:198-659` | `WorkerManager.test.ts`、`chatSessionsHistory.test.ts`、`historyReplayMerge.test.ts`、`dshStreamReplay.test.ts` |
| H02 | DSH `bridge/liveEvents.ts:699-881,1270-1508`；SDK `sdkSessionRuntime.ts:1564-1849,2011-2434`；`shared/permissions/cardEmitter.ts:166-280`；`main/ipc/chat.ts:853-980` | `liveEvents.test.ts`、`sdkSessionRuntime.test.ts`、`approvalQueue.test.ts`、`questions.test.ts` |
| H03 | DSH `subagents.ts:229-521`、`jobs.ts:229-503`；SDK `taskBoard.ts:100-319`；`backgroundTasksModel.ts:1-13` | `jobsAndSubagents.test.ts`、`taskBoard.test.ts`、`runtimeJobs.test.ts` |
| P01 | `PreviewWindowManager.ts:60-207`；`MarkdownPreview.tsx:10-167`；`PdfPreview.tsx:33-198`；`ImagePreview.tsx:30-151` | `PreviewWindowManager.test.ts`、`previewUrl.test.ts`、`previewResourceLimits.test.ts`、`previewRecoveryStatic.test.ts` |
| W01 | `MainWindow.ts:67-283,324-549`；`main/index.ts:802-955`；`WindowTitleBar.tsx:34-59`；`WindowControls.tsx:13-136` | `closeRequestReason.test.ts`、`shellMinimums.test.ts`；DPI 专项未定位 |
| N01 | `sidebarArchive.ts:31-213`；`sidebarTree.ts:433-504,575-764`；`SessionIndexService.ts:248-252` | `sidebarArchive.test.ts`、`sidebarTree.test.ts`、`sidebarGroupingMount.test.ts` |
| F01 | `main/ipc/files.ts:463-650`；`useEditor.ts:73-103`；`EditorArea.tsx:508-586,1164-1189`；`DiffViewer.tsx:876-909`；`stores/editor.ts:244-285` | `previewFileRead.test.ts`、`localFileWriteGuard.test.ts`、`fileWatcherLifecycle.test.ts`；内容基线专项未定位 |
| C01 | `appStatePaths.ts:41-48`；`DshHostProcess.ts:44-175`；`dshHostEnvironment.ts:16-193`；`sdkSessionRuntime.ts:183-192,820-938`；`cliEnvironment.ts:1-235` | `hostProfile.test.ts`、`DshHostProcess.test.ts`、`cliEnvironment.test.ts`、`sdkSessionRuntime.test.ts` |

## 5. FR 逐条复核台账

### FR-01 消息排版与正文独立性（R1）

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 01.1 | 用户/助手视觉区分，正文低装饰，工具附件独立 | R01、R08、设计规范 | 待验证 | #2 真实基线；#3/#6 |
| 01.2 | 运行、结束、恢复正文独立于折叠，不只保留末段 | R01 | **部分通过（DEF-001 自动修复；真实 Electron/恢复 UI 待验证）** | #3；AC-01/03/22 |
| 01.3 | 不按关键词、语言、长度、stop_reason 隐藏正文 | R01、H01 | 待验证 | #2 协议核查；#3 |
| 01.4 | 工具前后正文按序保留，更正追加不改写历史 | R01、H01 | **部分通过（DEF-001 自动修复；排序/更正与真实 UI 仍待验证）** | #2/#3；AC-03/04 |
| 01.5 | 长用户消息约 300px 折起，展开和完整复制 | R01、R08 | 待验证 | #3；AC-28 |
| 01.6 | 表格、代码、附件宽度与溢出，不产生整页横滚 | R06、R08 | 待验证 | #3/#4；AC-28/40 |
| 01.7 | 深浅主题、中文、长路径、缩放可读 | R01、R08 | 待验证 | #3/#4/#6；AC-28/40 |

### FR-02 思考折叠与工作状态（R1）

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 02.1 | 思考默认收起，运行中允许展开和收起 | R02 | 待验证（已有默认收起基础） | #2/#3；AC-05 |
| 02.2 | 新 thinking 只更新活动，不逐块新增主区行 | R01、R02 | **部分通过（DEF-002 每个过程组聚合一个入口；真实流式 UI 待验证）** | #3；AC-02/05 |
| 02.3 | 用户选择在工作单元内保持，完成不收起阅读中详情 | R01、R02 | **部分通过（DEF-003 稳定 groupKey 自动修复；真实交互待验证）** | #3；AC-06 |
| 02.4 | 无选择时完成默认收起；历史恢复确定默认 | R01、R02、H01 | 待验证 | #3；AC-06/22 |
| 02.5 | 状态来自真实活动，无可靠信息只显示处理中，不编造百分比 | R01、H01/H02 | 待验证 | #2/#3；AC-05/13/14 |
| 02.6 | 展开稳定、可打断、保锚点、reduced motion，无逐 token 模糊动画 | R01、R07、R08 | 待验证 | #3/#6；AC-19/41 |
| 02.7 | 不新增正文/思考请求，无内容不伪造思考 | R02、H02 | 待验证 | #2/#3；请求计数与 AC-05 |

### FR-03 交互输入与上下文引用（R2）

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 03.1 | IME 三信号协同，选词 Enter 不发送/不执行 | R03 | 待验证 | 真实微软拼音；#4；AC-23 |
| 03.2 | 发送键偏好、Shift+Enter、候选优先 | R03 | 待验证 | #4；AC-23 |
| 03.3 | `/` 触发边界、未知命令、ESC、键盘导航 | R03 | 待验证 | #4；AC-24 |
| 03.4 | `@` 词边界、相对/空格/中文/Windows 路径，邮箱代码不误触 | R03 | 待验证 | #4；AC-24 |
| 03.5 | 引用增强不改变真实发送含义 | R03、H02 | 待验证 | #4；发送载荷对照 |
| 03.6 | 高度自适应、上限内部滚动、按钮可见 | R03、R08 | 待验证 | #4；AC-25/40 |
| 03.7 | 草稿附件切会话/预览/失败重试保留且不串会话 | R03 | 待验证 | #4；AC-25 |
| 03.8 | Token 只标估算或不可用，不冒充精确 | R03、R04 | 待验证 | #4；AC-25 |
| 03.9 | 引用限制有反馈，不静默丢文件 | R03 | 待验证 | #4；AC-24/25 |

### FR-04 模型能力、上下文与用量（R2）

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 04.1 | 模型来自实际目录/供应商能力 | R04、H02 | 待验证 | #4；AC-26 |
| 04.2 | Thinking/effort 按能力，不发无效参数 | R04、H02 | 待验证 | #4；AC-26 |
| 04.3 | 显示思考与配置模型思考分离 | R02、R04 | 待验证 | #3/#4；请求对照 |
| 04.4 | 切换仅影响下一请求，不静默重启当前任务 | R04、H01 | 待验证 | #4；AC-26 |
| 04.5 | 紧凑上下文与详情口径分层 | R04 | 待验证 | #4；AC-27 |
| 04.6 | 文本/无障碍值，80% 提醒，无持续脉冲 | R04 | 待验证 | #4；AC-27/41 |
| 04.7 | 未上报/过期/估算/真实区分，中断未知不显示免费 | R04、H02 | 待验证 | #4；AC-27 |
| 04.8 | 缓存按供应商口径，不重复相加 | R04、H02 | 待验证 | #4；AC-27 |
| 04.9 | 价格币种缓存价格版本化，无价格只 Token，不称显存 | R04、H02 | 待验证 | #4；AC-27 |
| 04.10 | 容量/用量未知显示未知，不套固定值 | R04、H02 | 待验证 | #4；AC-27 |

### FR-05 工具执行与权限交互（R1）

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 05.1 | 按调用 ID 一份状态记录，参数/结果原位更新 | R05、H01/H02 | 待验证（已有配对基础） | #2/#3；AC-07/08/10 |
| 05.2 | 默认用途来自 description/可靠名称，不生成成功结论 | R05 | 待验证 | #3；AC-09 |
| 05.3 | stdout/stderr 持续更新、限高、全量/复制/搜索/导出及截断事实 | R05、H02 | 待验证 | #3；AC-09 |
| 05.4 | 工具/任务/验证成功分开，退出 0 不外推 | R05、H02 | 待验证 | #3；AC-09/13 |
| 05.5 | 批准对象参数完整，失效/未完整不能误批 | R05、H02 | 待验证 | #3；AC-12 |
| 05.6 | 按钮与持续授权范围只按真实能力 | R05、H02 | 待验证 | #3；AC-12 |
| 05.7 | 不新增普遍审批，不绕过策略，自动允许无假 pending | R05、H02 | 待验证 | #3；AC-12 |
| 05.8 | 提交中、失败重试、权威确认和幂等，不重复执行 | R05、H01/H02 | 待验证 | #3；AC-15 |
| 05.9 | 阻塞失败主区可见，恢复错误详情保留并标恢复 | R01、R05 | 待验证 | #3；AC-13 |
| 05.10 | 拒绝/阻止/取消/中断/未知/失败区分，无定时成功 | R05、H02 | 待验证 | #3；AC-13/16 |

### FR-06 工件预览与隔离通信（R3）

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 06.1 | 盘点复用文件预览/独立窗口及格式失败态 | P01 | 待验证 | #2 能力表；#5 |
| 06.2 | 产物名称/类型/来源/版本入口及定位 | R06、P01、H03 | 待验证 | #5；AC-32 |
| 06.3 | Markdown、文本代码、HTML、SVG、Mermaid 真实支持或降级 | P01 | 待验证 | #5；AC-32 |
| 06.4 | HTML/SVG 受限，Markdown/Mermaid 配置受控，日志只文本 | P01、R06 | 待验证 | #5；AC-34 |
| 06.5 | 默认无 Node/preload/IPC/写文件/模型权限 | P01 | 待验证（已定位 sandbox 配置） | #5；宿主记录 AC-34 |
| 06.6 | 只读优先，不默认开放宿主动作桥 | P01 | 待验证 | #5；AC-34 |
| 06.7 | 如有桥，校验 frame/schema/通道/会话/动作 | P01 | 待验证（专用桥未定位） | #5；AC-34 |
| 06.8 | 父窗口历史激活不构成当前授权 | P01、F01 | 待验证 | #5；AC-34 |
| 06.9 | 外链/弹窗/下载/联网沿用现有策略 | P01 | 待验证 | #5；AC-34 |
| 06.10 | 更新不抢焦点，后台预览不打断，重复打开复用 | P01 | 待验证 | #5；AC-33/35 |
| 06.11 | 错误/超时/过大/不支持反馈，关闭释放资源 | P01 | 待验证 | #5；AC-33/35 |

### FR-07 差异查看与流式代码（R2）

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 07.1 | 复用工具差异与 SCM 差异，统一状态和入口 | R06 | 待验证 | #4；AC-29 |
| 07.2 | 待执行预览/工具结果/当前磁盘差异来源可识别 | R06、F01 | 待验证 | #4；AC-29 |
| 07.3 | 统一/分屏、窄容器降级、用户选择、无溢出 | R06、R08 | 待验证 | #4；AC-29/40 |
| 07.4 | 行号/hunk/省略/替换配对/长行定位正确 | R06 | 待验证 | #4；AC-29 |
| 07.5 | 多文件、hunk、CRLF、EOF、重命名、二进制、大文件 | R06 | 待验证 | #4；AC-29 |
| 07.6 | 流式按块更新，不完整 fence/hunk 不误解析/清空 | R06、H01 | 待验证 | #4；AC-30 |
| 07.7 | 合批、高亮不阻塞，无全会话反复解析 | R06 | 待验证 | #4/#7；AC-30 |
| 07.8 | 高亮样式隔离、主题正常 | R06 | 待验证 | #4/#6；AC-31 |
| 07.9 | 复制原文/补丁，无 UI 行号，剪贴板成功后反馈 | R06 | 待验证 | #4；AC-31 |
| 07.10 | 不新增写入；已有写入口校验基线 | F01 | **部分通过（DEF-004 自动回归 + Linux 真实编辑器/Diff 保存复测；多窗口、远程待验证，§13）** | #10；AC-39 |

### FR-08～10 桌面、会话与子任务

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 08.1 | 窗口生命周期/主题/标题栏/缩放/关闭不改后台语义 | W01 | 待验证 | #5；AC-36 |
| 08.2 | Windows 首要，其他平台按支持矩阵 | W01 | 待验证 | #2/#5/#7 |
| 08.3 | 拖动与点击分离，100～200% DPI、最大化恢复 | W01 | 待验证（DPI 专项未定位） | #5；AC-36/40 |
| 08.4 | 首显主题正确，后台预览不抢焦点 | W01、P01 | 待验证 | #5；AC-35/36 |
| 09.1 | 复核分组/置顶/排序/导航，只补缺能力 | N01 | 待验证（置顶未定位） | #2/#5；AC-37 |
| 09.2 | 置顶/重排持久化，删除归档无悬空 | N01 | 待验证 | #5；AC-37 |
| 09.3 | 拖动阈值及键盘/菜单替代 | N01 | 待验证 | #5；AC-37/41 |
| 09.4 | 乐观失败回滚，跨窗口权威状态不反复覆盖 | N01 | 待验证 | #5；AC-37 |
| 10.1 | 主区紧凑状态，完整子代理日志按需打开 | H03、R01 | 待验证 | #3/#5；AC-17/38 |
| 10.2 | 名称/父子/状态/时间/产物来源可查，不平铺思考 | H03 | 待验证 | #5；AC-38 |
| 10.3 | 新发现/更正来自真实正文或结果事件，不 UI 编造 | H01/H03 | 待验证 | #3/#5；AC-17/38 |
| 10.4 | 阶段回复后后台仍显示，旧结果归旧任务 | H01/H03 | 待验证 | #2/#3；AC-17 |
| 10.5 | 不虚构看板阶段，状态来自协议 | H03 | 待验证 | #5；AC-38 |

### FR-11～14 滚动、可访问性、恢复与多窗口

| 条款 | 核查重点 | 入口 | 当前结论 | 后续 |
|---|---|---|---|---|
| 11.1 | 底部跟随，主动回看后不被拉回 | R07 | 待验证 | #3；AC-18 |
| 11.2 | 回到最新恢复跟随，新进展提示有节制 | R07 | 待验证 | #3；AC-18/41 |
| 11.3 | 详情增长/结束/折叠/差异/迟到结果保锚点 | R01、R06、R07 | 待验证 | #3/#4；AC-19 |
| 11.4 | 内部滚动不抢主区，待办卡不强制跳转 | R05、R07、R08 | 待验证 | #3；AC-18/19 |
| 11.5 | 底部空间可配置，不硬复制 35vh | R08 | 待验证 | #3/#6；AC-40 |
| 11.6 | 展开/跟随/内容状态独立 | R01、R02、R07 | 待验证 | #3；AC-20 |
| 12.1 | 按组件宽度适配，320/384/480/768 容器可用 | R08、R06 | 待验证 | #4/#5；AC-40 |
| 12.2 | 焦点/名称/折叠可读，状态不只靠颜色 | R01、R05、R08 | 待验证 | #3/#4；AC-41 |
| 12.3 | Tab 无陷阱，方向键不劫持正文输入 | R03、R05、R06 | 待验证 | #4；AC-41 |
| 12.4 | 弹层焦点返回，日志不抢焦点，虚拟项可定位 | R03、P01、R07 | 待验证 | #4/#5；AC-41 |
| 12.5 | reduced motion、WCAG AA、键盘读屏关键流程 | R08、设计规范 | 待验证 | #4/#6/#7；AC-41 |
| 13.1 | 等待/重试/恢复原位更新，不新增错误气泡 | H01/H02、R01 | 待验证 | #2/#3；AC-14 |
| 13.2 | 渲染层无第二自动重试，只显示真实 retry-after | H02、R01 | 待验证 | #2/#3；AC-14 |
| 13.3 | 唯一重试责任与取消语义，超限按协议 | H01/H02 | 待验证 | #2/#3；AC-14 |
| 13.4 | 断线/切会话不默认取消失败，未知待同步 | H01、R05 | 待验证 | #3；AC-22 |
| 13.5 | 恢复不重复正文/调用/用量/交互，过期不可点击 | H01、R04、R05 | **部分通过（DEF-005/006 自动修复与回归通过）**；真实 Electron 及其余条件待验证 | #11/#3；AC-10/15/16 |
| 13.6 | 中断保留内容，终态与正文分开，不生成完成结论 | H01/H02、R01 | 待验证 | #3；AC-22 |
| 14.1 | 盘点权威状态，优先沿用现有架构 | H01、W01、P01 | 待验证 | #2/#5；AC-42 |
| 14.2 | 镜像/产物窗口不新增请求、执行或用量 | H01、P01 | 待验证 | #5；AC-42 |
| 14.3 | 多窗口交互只处理一次，重复提交权威幂等 | H01/H02 | 待验证 | #3/#5；AC-15/42 |
| 14.4 | 快照后增量、断连恢复、关闭生命周期正确 | H01、W01 | 待验证（桌面补洞 API 未定位） | #5；AC-42 |
| 14.5 | 写入口校验版本/基线，只读窗不新增写接口 | F01 | **部分通过（DEF-004 自动修复 + Linux 真实单窗口复测；真实多窗口待验证，§13）** | #10；AC-39 |

## 6. 沟通、非功能与兼容

| 条款 | 当前结论 | 验证/整改 |
|---|---|---|
| 沟通：用户语言、发现/结果/影响优先，简单问答不套模板 | 待验证 | #4；AC-43 独立实验 |
| 沟通：机械动作由工具行承担，不逐次旁白 | 待验证 | #4；AC-43 |
| 沟通：新发现/方案改变/阻塞/用户操作及时反馈，无虚假 60 秒消息 | 待验证 | #3/#4；真实状态与 AC-43 |
| 沟通：事实/假设/计划及验证环境分开，更正保留旧记录 | 待验证 | #4；AC-43 |
| 沟通：已有授权持续，不无意义重问，部署前完成独立验证 | 待验证 | #4；AC-43 |
| 提示词在 PiLab 自有入口、独立可回滚，不靠正则删正文 | 待验证 | C01；#4；AC-43 |
| 原日志不改写，旧历史无新字段可加载，异常块可降级定位 | 待验证 | H01；#2/#3；AC-44 |
| 阅读/诊断共享归一化状态，切换不重跑、不总结、不改授权 | 待验证 | #3；AC-02/20/44 |
| 状态 p95 ≤150ms、输入 p95 ≤100ms，方法与环境可复现 | 待验证 | #2 基线；#7 F07 |
| 1 万事件/100 工具/1MB 输出可操作定位，无持续 >50ms 热路径长任务 | 待验证 | #7；AC-21 |
| 局部/有界增量，不随单块更新全量解析整会话 | 待验证 | #3/#4/#7 性能录制 |
| 预览/会话切换 20 次无持续 listener/watcher 或无界内存增长 | 待验证 | #5/#7；AC-35 |
| 普通日志/代码/HTML 不执行，富内容沿用安全策略 | 待验证 | #3/#5；AC-28/34 |
| 权限/写判断在权威服务，重试/重放/多窗口不增加实际调用 | 待验证 | #2/#3/#5/#10；宿主证据 |
| 诊断可定位身份/状态/重复事件/滚动/性能，默认不外发全文 | 待验证 | #3/#7；AC-45 |
| 新布局与提示词分别可回退，回退不破坏数据/授权/执行 | 待验证 | #3/#4/#7；AC-44 |

## 7. AC 验收矩阵（初始）

除下列源码已确认不通过项外，所有 AC 均为待验证。全局 SHA 见文首；当前尚未运行本产品测试或 Electron 场景。

| AC | 阶段 | 初态 | 主任务 |
|---|---|---|---|
| 01 运行正文独立 | R1 | **部分通过（DEF-001 自动回归 + Linux 真实运行/结束/失败渲染通过；滚动、Windows 待验证，§13）** | #3，F01 回放+恢复 |
| 02 一入口与两种视图 | R1 | **部分通过（F02 聚合视图自动验证 + Linux 真实渲染；请求计数待验证，§13）** | #2/#3，F02+请求计数 |
| 03 多段回复与更正 | R1 | **部分通过（DEF-001 自动回归 + Linux 真实多段渲染；更正待验证，§13）** | #3，多阶段回放 |
| 04 身份与合法重复 | R1 | **部分通过（#11 自动回归 + Linux 真实 F04 渲染与真实 DSH 恢复无重复；Claude SDK 真实恢复、Windows 待验证，§13）** | #11/#3，协议适配+ reducer/宿主 |
| 05 思考运行可收起 | R1 | **部分通过（Linux 真实运行中展开/收起、默认收起；请求计数未测，§14）** | #3，流式交互 |
| 06 用户展开偏好 | R1 | **部分通过（DEF-003 自动回归 + Linux 真实运行中展开/收起跨完成保持；完整页面重载、新任务待验证，§13）** | #3，完成/重开/新任务 |
| 07 调用与乱序结果 | R1 | 待验证 | #2/#3，F01 |
| 08 相同命令再次执行 | R1 | 待验证 | #2/#3，F04 |
| 09 大输出与未知成功 | R1 | 待验证 | #3，stdout/stderr/截断/退出码 |
| 10 完整帧重放恢复 | R1 | **部分通过（#11 自动回归 + Linux 真实 DSH 宿主被杀/流式中断/应用重启恢复无丢失无重复；Claude SDK、Windows 待验证，§13）** | #11/#3，真实宿主适配 |
| 11 问题不受折叠影响 | R1 | 待验证 | #3，F03+键盘 |
| 12 真实权限语义 | R1 | **部分通过（参数完整显示 DEF-011 已修，DSH 真实审批卡复测；Claude 实机未测，§14）** | #3，宿主权限记录 |
| 13 执行终态 | R1 | **部分通过（DSH 宿主崩溃时运行中/待批工具「结果未知」真实验证；全终态矩阵未完成，§14）** | #3，全终态矩阵 |
| 14 重试责任倒计时 | R1 | 待验证 | #2/#3，DSH/SDK 分别验证 |
| 15 重复提交/提交失败 | R1 | 待验证 | #3/#5，权威层幂等 |
| 16 过期交互恢复 | R1 | 待验证 | #3，历史与后端同步 |
| 17 后台与人工输入边界 | R1/R3 | 待验证 | #3/#5，F05 |
| 18 底部跟随与回看 | R1 | **部分通过（Linux 真实滚轮/PageUp/↑/滚动条均保持，DEF-008 已修；触摸未测，§14）** | #3，滚轮/触摸/键盘/滚动条 |
| 19 展开完成保锚点 | R1 | **部分通过（Linux 真实增长/点击/回合结束锚点位移 0，DEF-009 已修；迟到结果、加载更早历史未专测，§14）** | #3/#4，迟到结果/差异 |
| 20 滚动与视图隔离 | R1 | **部分通过（不泄漏已验证；切回是否保留位置/展开待用户裁定，§14）** | #3，A/B 会话与模式 |
| 21 长会话性能 | R1/总检 | 待验证（Linux 开发构建 F07 方法基线已建，§13；发布包与目标机未测） | #2/#7，F07 实测 |
| 22 中断历史未知 | R1 | **部分通过（DSH 真实中断无「最终输出」/「完成于」、工具「结果未知」，DEF-010 已修；Claude SDK 重开后的停止/拒绝/立刻发送与现场一致，DEF-015 已修，§15；Windows 待验证）** | #3，F04/F08 |
| 23 真实中文 IME | R2 | **部分通过（Linux 真实 Electron 以 CDP 输入法事件验证：输入框、`/`、`@` 菜单选词回车均不发送不选中；真实微软拼音待 Windows，§16）** | #4，微软拼音及支持平台 |
| 24 指令与文件引用 | R2 | **部分通过（`@` 边界、空格路径、反斜杠、Tab、光标移动已修并真实复测；未知命令、引用失效反馈待用户裁定，§16）** | #4，边界/路径/超限 |
| 25 自适应草稿估算 | R2 | **部分通过（切会话、重启保留文字已真实验证；失败重试、读取中切会话已修并自动验证；重启丢附件无提示待裁定，§16）** | #4，附件/失败/切会话 |
| 26 模型思考能力 | R2 | 待验证 | #4，真实目录与运行中切换 |
| 27 用量口径仪表盘 | R2 | 待验证 | #4，供应商/缓存/未知/80% |
| 28 排版主题文本安全 | R1/R2 | 待验证 | #3/#4/#6，深浅/缩放/HTML 日志 |
| 29 差异正确性来源 | R2 | 待验证 | #4，F06+三类来源 |
| 30 流式代码高亮性能 | R2 | 待验证 | #4/#7，不完整输入+录制 |
| 31 复制样式隔离 | R2 | 待验证 | #4，剪贴板失败/主题 |
| 32 产物来源格式矩阵 | R3 | 待验证 | #5，五类真实样本 |
| 33 加载错误持续更新 | R3 | 待验证 | #5，原子替换/类型变化 |
| 34 预览边界消息桥 | R3 | 待验证 | #5，宿主权限/调用记录 |
| 35 预览资源焦点 | R3 | 待验证 | #5/#7，20 次循环 |
| 36 桌面 DPI | R3 | 待验证 | #5，100/125/150/200% |
| 37 会话排序持久化 | R3 | 待验证 | #5，失败回滚/跨窗口 |
| 38 子代理归属看板 | R3 | 待验证 | #5，同名并发/取消/重试 |
| 39 文件基线冲突 | 前置/R2/R3 | **部分通过（自动验证 + Linux 真实编辑器与 Diff 的 A→B 均不覆盖且有提示，DEF-007 已修；真实多窗口、远程待验证，§13）** | #10，A→B 权威侧验证 |
| 40 容器与缩放 | R2/R3 | 待验证 | #4/#5/#6，320～768px |
| 41 键盘读屏减弱动画 | 全阶段 | 待验证 | #3～#7，无鼠标工作流 |
| 42 多窗口一次执行恢复 | R3 | 待验证 | #5，快照/增量/关闭 |
| 43 沟通规则独立实验 | R2 | 待验证 | #4，固定变量多次采样 |
| 44 多引擎旧历史回退 | 全阶段 | 待验证 | #3/#4/#7，DSH/SDK/F08 |
| 45 发布证据与诊断 | 全阶段 | 待验证 | #7/#9，完整证据包 |

## 8. R0 后续固定产物

1. #2：协议字段/身份/顺序/状态/降级映射，明确没有顶层 `snapshot` 事件，实际恢复为 `session.resumed → session.history → session.status`。
2. #2：F01～F08 脱敏夹具与零模型调用回放，保留合法重复字/行和 Windows 路径边界。
3. #2：当前真实 UI 截图/录像、性能方法、预览/差异/窗口能力表。
4. #10：在任何发布宣称前关闭文件基线 S0；#3 起逐项把本台账的源码缺陷改为复测证据。
5. #7/#9：仅按实际完成范围签核，不以本台账建立或测试文件存在宣称全量 PRD 通过。

## 9. R0 自动回放证据

- 协议、身份、引擎差异与证据边界：`docs/plans/2026-10-29-pilab-session-protocol-map.md`。
- 脱敏构造夹具：`src/shared/__tests__/fixtures/pilabExperience.ts`；真实 DSH 录制继续沿用 `src/shared/__tests__/fixtures/dsh/`，两者不互相冒充。
- 2026-10-30 执行 `pnpm exec vitest run src/shared/__tests__/pilabExperienceFixtures.test.ts src/renderer/stores/__tests__/pilabExperienceReplay.test.ts --maxWorkers=1 --no-file-parallelism`：2 文件、9 测试通过。
- 已验证夹具确定性、F01 每个暂停/恢复边界、F03 待处理退休、F08 双引擎旧历史归并；真实 Host、Electron、权限/文件写入和性能仍未因此关闭。

## 10. Linux #11 自动复测（2026-10-30）

- 基线：`51fe766a0dfb03a5f52fe0a3aff58c7e0661955a`；整改证据来自该基线上的未提交工作区。重复 `message.started` 现在按 `messageId` 保留 blocks 并合并新增元数据；`applyRuntimeEvents` 按 `sessionId + seq` 高水位忽略同一 Main 传输代际的重放，新 `session.resumed.requestId` 开启新序号代际，不同 seq 的合法相同 delta 不去重。
- `chatSessionsCore + pilabExperienceReplay`：修复前新增期望测试 4 项失败，修复后 91 项通过；`chatSessionsBatch + chatSessionsHistory + historyReplayMerge`：142 项通过；真实 DSH 录制 `dshStreamReplay`：305 项通过；Main `WorkerManager`：200 项通过；Claude SDK `sdkSessionRuntime`：88 项通过、1 项既有跳过。
- DSH 模拟 Main 的信封已从重复 `seq: 0` 修正为实际的单调序号；生产序号规则没有为测试放宽。5 个改动源码/测试文件的 Biome 检查通过。
- `pnpm typecheck` 仍由基线文件 `src/shared/__tests__/fixtures/pilabExperience.ts:25` 的 TS2352 阻塞；该文件不在 #11 改动中，不能把本次结果记为全量类型检查通过。
- 证据边界：#11 自动回归完成，但 AC-04/10 的真实 Electron 复测尚未完成，不能宣称整个 FR-13 或 AC-04/10 全部通过。Linux 隔离 Electron 已构建并启动，renderer CDP 求值持续无响应，真实 UI 基线仍留在 #2。

## 11. Linux #10 文件基线自动复测（2026-10-30）

- 基线同为 `51fe766a0dfb03a5f52fe0a3aff58c7e0661955a` 上的未提交工作区。5 个 `FILE_WRITE` 调用点（普通/自动保存、标签关闭直写、Diff、应用关闭、切换 worktree）均提交读取时 `expectedContent`；缺失基线失败关闭。普通编辑器只有磁盘重载、显式外部 Reload 和成功保存才推进 `baseContent`，成功保存使用实际写入快照，保存期间的新编辑仍保持 dirty。Diff 使用进入编辑时的 `diff.modified` 快照，不受后续轮询影响。
- 本地 Main 在 `file:write` 做路径写入准入、读取当前文本并校验基线，冲突以 `FILE_CONTENT_CONFLICT` 拒绝且不写。远程把基线放进同一个 `fs:write` RPC，由远程 helper 校验后写；低层内部共享状态写入不受影响。`REMOTE_SERVER_VERSION` 升至 `0.4.1` 以部署新 helper。
- 修复前本地 A→B 与第二个 stale writer 测试均失败；修复后 `fileRenameGuard + localFileWriteGuard + remotePorcelainParse + editorWorkspacePreview` 共 34 项通过。`useEditor + closeEditorTabsSequentially + editorTabCloseDecision + toolDiffInteraction` 共 16 项通过。15 个改动源码/测试文件的 Biome 检查通过；全量类型检查仍只有台账 §10 所述基线夹具 TS2352。
- 证据边界：自动验证覆盖本地外部 A→B、两个持有 A 的 writer 顺序写、远程 helper stale baseline、基线推进与并发编辑；真实 BrowserWindow、真实远程连接和 Diff 界面保存尚未复测，AC-39 保持部分通过。比较后写入不是跨外部进程的原子 CAS，本次不宣称消除极窄 OS 级竞态。MergeEditor、Git 操作、Agent 工具和临时二进制写入不属于本次 5 个编辑器文本保存入口。

## 12. Linux R1 第一阶段自动复测（2026-10-30）

- 在同一未提交工作区完成 DEF-001～003：`splitTurnWorkGroup` 只收 `process`，所有 answer 原位独立，finalAnswer 仅保留展示分隔线；`deriveToolGroupRows` 每个过程组聚合成一个思考入口，工具逐调用保持顺序，后续块流式状态与全文保留，只有全部有时长才求和；展开偏好只按稳定 `groupKey`，不再拼接 `processSettled`。
- F01 验证正文 A/B 在运行与结束都不入组、`call-early` 仍按调用 ID 配对；F02 验证 8 段正文、9 个过程组、42 个原始 thinking/67 个原始 run 守恒，聚合成 6 个思考入口和 67 个有序工具行；F05 验证阶段正文独立，迟到 `old-result` 仍在 `task-parent` lane，不进入下一人工 turn。
- 最终核心批次 `toolCard + turnProcessFold + processCompletionInteraction + pilabExperienceReplay` 共 191 项通过；时间线接线、ReviewFindings、turn-end 交互共 82 项通过；思考流式/滚动跟随等共 35 项通过；聚合计时、展开存储与接线守卫批次共 210 项通过。9 个 R1 改动源码/测试文件的 Biome 检查通过；全量类型检查仍只有基线夹具 TS2352。
- 证据边界：DEF-001～003 的纯视图模型和真实 happy-dom 交互自动回归完成，但 Linux 真实 Electron 的 CDP 求值仍无响应，运行/结束/恢复、滚动和视觉验收没有关闭；AC-01/02/03/06 均只记部分通过。R1 其余状态、滚动、权限与性能条目不在本阶段签核范围。

## 13. Linux 真实 Electron 基线（2026-10-30 下午）

- 执行：Claude（Linux 接续会话）；Debian 13 / X11、2 核 / 5.8 GiB、DPR 1；`51fe766a` 上的未提交工作区；Vite 开发构建；隔离 HOME `/tmp/pilab-r0`、本地假网关，无真实模型。完整证据：`docs/plans/evidence/2026-10-30-pilab-r0-real-ui/README.md`（`shots/` 34 张、`results/` 测量 JSON、`tools/` 驱动与批处理）。
- §10、§12 中「renderer CDP 求值持续无响应」的根因已查明：renderer 一直可求值；实际是未打包引擎布局缺 `out-node-runtime` 与 `src/dsh-host/node_modules`、首页本机入口已隐藏、`enter` 盲等。已按 README §1 处理，未改产品代码。
- 状态基线：F01～F05 与失败场景经真实 store（`applyRuntimeEvents`）注入，浅色/深色/720 窄宽截图与 DOM 测量。运行与结束正文均在过程组外可见；F02 结束 9 组收起；F03 权限卡停靠；F04 合法重复不叠加、同命令两次调用不合并；F05 迟到旧结果不进新回合；无横向溢出。
- #11：真实 DSH 宿主空闲时被杀、恢复后续聊、应用优雅重启后从侧栏打开、重启后续聊，转录指纹逐步保持且前缀不变；流式第 15 段时被杀，部分正文完整保留，两代 history 重放无重复。
- #10：真实 Monaco 输入 + Ctrl+S 与 Diff 编辑模式下，外部 A→B 后保存均被 `FILE_CONTENT_CONFLICT` 拒绝、磁盘保持 B、编辑内容保留。Diff 有错误提示；普通编辑器无提示，且文件树未挂载时收不到外部改动。是否属于 AC-39 待按原始 PRD 定性。
- R1：DEF-003 在真实渲染中运行中展开/收起都跨完成保持。
- F07 方法：一次折叠 1 万事件 22 ms；每批 256 时单批 p95 1.7 ms、max 13.1 ms；React 提交长任务 100～134 ms（含切换会话挂载，未分离）。开发构建，只作方法基线，AC-21 仍为待验证。
- 预览/差异/窗口能力矩阵见 README §8；其中无全局导航拦截、预览窗无打开窗口处理、主窗口 `sandbox:false`、Mermaid SVG 未净化、合并编辑器保存不校验基线均已抽查源码确认，作为观察项，未列为缺陷。
- 证据边界：没有真实多窗口（第二窗口只能由原生菜单快捷键打开，CDP 按键不触发）、没有真实远程、没有 Claude SDK 引擎真实恢复、没有 Windows/IME/DPI 与发布包。上表相关 AC 仍为「部分通过」或「待验证」。
- 补记（2026-10-30 晚）DEF-007：用户裁定「保存被拒无提示」属于 AC-39。修复：新增 `src/renderer/lib/fileSaveFailure.ts`，Ctrl+S/自动保存、关标签提示、关标签自动保存、切换 worktree、关闭应用、Diff 六处保存失败都给出可读说明（冲突不再显示错误码）；编辑器入口在冲突时读取磁盘内容并弹出「文件已被外部修改」横条，同一冲突在横条显示期间不重复弹提示；关标签自动保存失败时保留标签。用户裁决「保留本地」= 以用户版本覆盖刚看到的外部内容：基线推进到该外部内容，之后若磁盘再变仍会拦截（取代 handoff §10.3 第 6 条中「只有重载/外部 Reload/成功保存推进基线」的说法）。文件监听收不到改动时，至少在保存那一刻会出横条。自动：`fileSaveFailure` 11 项 + `editorWorkspacePreview` 6 项；相关编辑器/工作区/Main 写入套件 13+8 文件 134 项通过；i18n 覆盖通过；全量 typecheck 仍只有基线 TS2352。真实 Electron：A→B 后保存出现提示与横条，「保留本地」后再保存写入用户版本。

## 14. Linux R1 其余条目（2026-10-30 晚）

- 执行：Claude；同 §13 环境（真实 Electron 开发构建、隔离 HOME、假网关）。三路只读源码审计后抽查并真实复现，修复 DEF-008～014，详见 `docs/plans/evidence/2026-10-30-pilab-r0-real-ui/README.md` §10 与 handoff §10.11。
- 真实证据：`results/scroll-follow.json`、`scroll-small.json`、`scroll-anchor.json`、`scroll-isolate.json`；`shots/r1-interrupted-no-final-label.png`、`r1-permission-edit-arguments.png`、`r1-crash-*.png`、`r1-ac05-thinking-expanded-running.png`、`r1-scroll-*.png`。
- 自动：chat 组件测试 197 文件全部通过（5 批串行）；DSH 权限/桥接 163 项；SDK 90 项（1 跳过）；bridge-smoke 72 项判定为真；三套 typecheck 仅余基线 TS2352。
- 审计确认但未改、待用户裁定：11.6 切回保留、02.5「思考中」用词、05.2 DSH bash 标签、05.3 输出工具、05.9/13.4 崩溃显示与「已恢复」、13.2 `session_busy` 自动重发、01.5 折叠阈值。
- 证据边界：Claude SDK 实机（含重开丢失中断标记）、触摸、IME/DPI、Windows 未覆盖；所有相关 AC 仍为「部分通过」。

## 15. Linux Claude 引擎中断历史（2026-10-30 晚）

- 执行：Claude；同 §13 环境，另装 `src/claude-sdk-host` 依赖，假网关 `claude-sdk` 剧本，新会话走 Agent SDK 引擎。详见证据 README §11、handoff §10.15。
- 修复 DEF-015～017：中断标记 → 回合「已停止」，被切断的命令「已停止」，没有回复时「这一轮已停止，没有保存任何回复」；本应用拒绝 →「已拒绝」；「立刻发送」不标停止；历史带时间；去掉 `<tool_use_error>` 标签。
- 自动：SDK 宿主 14 文件 215 项通过（1 跳过），新增 `[PILAB-R1-CC-STOP]` 7 项；`typecheck:claude-sdk-host` 通过。
- 真实：同一会话 11 轮，重启应用后重开与现场一致；步骤式显示（读取合并、修改合并、结果行）在 Claude 引擎上核对通过。
- 已知差异：审批卡待答时停止，重开显示「已停止」而非「已拒绝 · 自动：已中止 · 未执行」（CLI 记录无法区分）。
- 证据边界：Claude 引擎真实断线恢复、Windows 未覆盖；AC-04/10/22 仍为「部分通过」。

## 16. Linux R2 输入框（2026-10-30 晚）

- 执行：Claude；同 §13 环境。两路只读源码审计（03.1～03.4、03.5～03.9）后在真实 Electron 里复现，工具 `tools/composer-r2.mjs`（CDP `Input.imeSetComposition` / `insertText` / `dispatchKeyEvent`，页面收到的是 Chromium 自己产生的 isComposing / 229 / composition 事件）。
- 已验证无问题：输入框与两个菜单里输入法选词回车不发送、不选中（`results/r2-ime.json`）；草稿切换对话不丢不串，重启应用后文字仍在；邮箱 `a@entry` 不触发菜单；输入框高度 8 行封顶、按钮不被挤出（源码）；输入框不显示 token 估算（03.8 无可误标之处）；附件超限都有提示（03.9 附件部分）。
- 修复 DEF-018～023（见 §3）；真实复测 `results/r2-mention-after.json`。
- 自动：`fileMention`（34 项，新增 `[PILAB-R2-MENTION]`）、`retrySwitchDraftMount`（新增，修复前失败）、`attachmentOwnerSwitch`（新增）；输入框相关 81 文件 1501 项通过；`pnpm typecheck` 仅基线 TS2352。
- 用户裁定（2026-10-30）：发送键偏好不做；`@` 前紧挨中文不触发保持现状；菜单无障碍角色暂不做；未知命令先提示再「仍然发送」、找不到的引用标出来、拖放文件当附件、重启丢附件/截断草稿给简短提示——四项做，预览 `docs/design/2026-10-30-composer-r2-preview.html`。
- 裁定前的事实记录：没有「Enter / Ctrl+Enter 发送」偏好设置；未知 `/命令` 原样发给模型、无提示；`请看@文件`（`@` 前紧挨中文）不触发菜单（Claude Code 同样只认行首或空白后）；`@` 指向不存在的文件、文件夹或二进制文件没有提示；把文件拖到输入框被静默忽略；重启后附件丢失、超过 10 万字的草稿被截断，都无提示；两个菜单没有 listbox/option 无障碍角色。
- 证据边界：真实微软拼音、Windows 路径、发送失败重试的真实界面复现未做；AC-23/24/25 仍为「部分通过」。
