# 批次 D 补审：精简索引（无反驳者理由；完整版见 index.md）


## main-host（T029，置信度 high）：Main 侧宿主（WorkerManager 轴）
- 节点 P4-0：complete-with-gaps
- 节点 P4-3：complete-with-gaps
- 节点 P4-4：complete-with-gaps
- [main-host-01] medium correctness confirmed | P4-4 | src/main/services/agent-host/WorkerManager.ts:1148 | 斜杠命令的「随便找个活着的 worker」回退会把另一个仓库的项目级技能与提示词端到端交给用户
- [main-host-02] medium robustness confirmed 静态 | P4-4 | src/main/services/agent-host/WorkerManager.ts:1949 | 关机时导入槽拆除一抛错，整池会话 worker 的优雅拆除和 7 秒兜底强杀被一起跳过
- [main-host-03] medium contract-gap confirmed | P4-3 | src/main/services/agent-host/WorkerManager.ts:2414 | Main 在 slot.dispose() 之前就关掉事件闸，worker 专门为此保留的排空事件全部被丢掉
- [main-host-04] low robustness confirmed 静态 | P4-0 | src/main/services/agent-host/WorkerTransport.ts:96 | 两种载体只有一种排空 stdout：child_process 支路显式 resume() 并写明原因，utilityProcess 支路没有
- [main-host-05] low dead-code confirmed | P4-3 | src/main/services/agent-host/WorkerManager.ts:1881 | 整条 tier 通道自 D14 之后没有生产者，注释却仍把它写成现行的 U12 修复；Main 还不校验 worker 的 applied 回答
- [main-host-06] low dead-code confirmed-partial-waiver | P4-0 | src/main/services/agent-host/index.ts:1 | 目录桶文件零导入者，它是 NodeRuntimeResolver 唯一的引用来源，而后者也没有生产调用方
- [main-host-07] low dead-code confirmed | P4-3 | src/main/services/agent-host/WorkerSlot.ts:240 | replaceCrashedTransport 与整个 replacing 状态机只有测试在用，方法注释却说策略归 WorkerManager
- [main-host-08] low dead-code confirmed | P4-3 | src/main/services/agent-host/WorkerManager.ts:2030 | 五种 WorkerSlotDiagnostic 没有任何生产消费者，协议不匹配与半帧在生产里只剩「RPC 超时」这一个症状

## main-host-aux（T029，置信度 high）：Main 侧宿主辅助模块（Node 解析、临时工作区、stderr、布局）
- 节点 P4-0（Node 解析）：complete-with-gaps
- 节点 F2-a（临时根设置不同步）代码侧：complete-with-gaps
- 节点 F2-b（TEMP 删除后归组/消失）代码侧：complete-with-gaps
- 节点 F2-c（用户目录缺失 workspace_missing）代码侧：complete-with-gaps
- 节点 H/19（统一 agent 目录下发半边）：complete-with-gaps
- [main-aux-01] high security confirmed | F2-b | src/main/services/agent-host/ScratchWorkspaceService.ts:130 | scratch 根的越界守卫用不解析 `..` 的前缀比较，adopt 能创建、release 能递归删除根外任意目录
- [main-aux-02] medium correctness confirmed-partial-waiver | F2-b | src/main/ipc/chat.ts:613 | 归档在 worker 还活着时就 rm -rf 它的 cwd，与退出清理自己写下的顺序约束相反
- [main-aux-03] medium correctness confirmed | F2-a | src/main/services/agent-host/ScratchWorkspaceService.ts:109 | 改临时根设置后旧根下的 scratch 目录永不清理，且恢复时丢掉 unbound 不信任姿态
- [main-aux-04] low dead-code waived | P4-0 | src/main/services/agent-host/NodeRuntimeResolver.ts:50 | Node 24 解析器整模块无生产调用方，渲染层为它写的指引分支同样不可达
- [main-aux-05] low correctness waived | P4-0 | src/main/services/agent-host/NodeRuntimeResolver.ts:162 | 版本管理器分支在 POSIX 上拼出的候选路径缺 bin/ 段，nvm 的现代目录布局也不认
- [main-aux-06] medium security confirmed | main-host-aux | src/main/services/agent-host/WorkerManager.ts:2060 | worker stderr 只有走 IPC 的那一路脱敏，进 main.log 的两路是原文
- [main-aux-07] medium correctness confirmed | F2-c | src/main/services/agent-host/TempWorkspaceService.ts:287 | 临时工作区归属判定用未规范化的 base 做 dirname 全等比较，设置值带尾部分隔符就让自愈静默失效
- [main-aux-08] low robustness confirmed | main-host-aux | src/main/services/agent-host/hostStderr.ts:58 | 无换行的 stderr 流只限制了内存没限制条数，一次巨量输出会把 50 行崩溃回放挤空
- [main-aux-09] medium correctness confirmed | H/19 | src/main/services/agent-host/subagentCatalog.ts:266 | 删除被影子覆盖的兼容根定义只删影子、旧文档随即复活；改名则直接删掉 ~/.agents 下的原文件

## utility-chain（T029，置信度 medium）：utility 通道的产品消费者（代码评审 / 分支名 / 提交信息）
- 节点 P6-2（一次性补全换引擎）的产品消费者面：complete-with-gaps
- [utility-01] medium robustness confirmed 静态 | P6-2（产品消费者面） | src/main/services/agent-host/PiUtilityService.ts:119 | 一次性补全的冷启动用的是 10 秒「热请求」预算，而会话路径为同一件事专门配了 60 秒
- [utility-02] medium contract-gap confirmed | P6-2（产品消费者面） | src/renderer/components/settings/AISettings.tsx:212 | 超时设置无上界，配到 600 秒以上会被 RPC 载荷守卫整条判非法，报错却说「缺 id / cwd / prompt」
- [utility-03] medium correctness confirmed | P6-2（产品消费者面） | src/renderer/components/settings/AISettings.tsx:49 | 模型下拉在目录里查不到已存值时显示「自动」，却不回写，请求仍然带着那个旧模型
- [utility-04] low i18n confirmed | P6-2（产品消费者面） | src/renderer/components/source-control/CommitBox.tsx:61 | 三个功能把引擎内部英文错误串直接当提示文案，只有恰好等于 'timeout' 的那一种被翻译
- [utility-05] low correctness confirmed 静态 | P6-2（产品消费者面） | src/main/services/ai/branch-name.ts:27 | 分支名不过 stripCodeFence（同目录的提交信息过），围栏答案会原样写进分支名与 worktree 路径
- [utility-06] medium correctness confirmed | P6-2（产品消费者面） | src/renderer/components/source-control/CodeReviewModal.tsx:319 | 超时或失败时错误块优先于内容渲染，已经流式显示了几分钟的评审正文被一行错误顶掉
- [utility-07] low contract-gap confirmed | P6-2（产品消费者面） | src/main/services/agent-host/PiUtilityService.ts:169 | 两端超时共用同一个 timeoutMs、没有先后余量，与 /compact 明确写下的「顺序即契约」相反；worker 侧那份实际上永远轮不到
- [utility-08] low test-gap confirmed | P6-2（产品消费者面） | src/main/services/ai/index.ts:1 | 三个功能的产品侧代码零测试：src/main/services/ai/* 与 stores/codeReview.ts 一条用例都没有
- [utility-09] low correctness confirmed | P6-2（产品消费者面） | src/renderer/components/source-control/CodeReviewModal.tsx:305 | 评审弹窗标题把模型设置原样渲染，默认「自动」时显示一对空括号
- [utility-10] low robustness confirmed | P6-2（产品消费者面） | src/renderer/components/settings/AISettings.tsx:113 | AI 设置页硬编码宿主状态为 ready 并丢弃目录状态行，目录不可用时模型菜单只剩「自动」且不作任何说明

## session-index（T029，置信度 high）：SessionIndexService 与 fork 生命周期
- 节点 P3-5：complete-with-gaps
- [session-index-01] high robustness confirmed 静态 | P3-5 | src/main/services/chat/SessionIndexService.ts:420 | 索引文件读坏与「文件不存在」走同一条分支，下一次写入就把全部会话行覆盖成空
- [session-index-02] medium correctness confirmed 静态 | P3-5 | src/main/services/agent-host/WorkerManager.ts:1569 | fork 未绑定会话时索引行漏写 unbound，fork 当场在界面上失败，重启后这一行被当孤儿丢掉
- [session-index-05] medium correctness confirmed | P3-5 | src/main/services/chat/SessionIndexService.ts:331 | setArchived 等三处写失败不回滚内存，而 flush 写整张表，报错过的修改会被后面任何一次无关写入悄悄落盘
- [session-index-03] low dead-code confirmed | P3-5 | src/main/services/chat/NativeSessionIndexAdapter.ts:10 | 验收点名的 NativeSessionIndexAdapter 至今零生产引用，它和它的集成测试是一份不参与真实行为的平行实现
- [session-index-04] low contract-gap confirmed-partial-waiver | P3-5 | src/runtime/worker/nativeWorkerRuntime.ts:698 | fork 状态机只有丢弃有生产实现，提交那一半（acceptFork）无人调用，暂存标记永不清除
- [session-index-06] low dead-code confirmed | P3-5 | src/main/ipc/chat.ts:278 | chat:createSession 把 effort 传给 recordCreated，而索引既没有这个字段也不会保存它
- [session-index-07] low contract-gap confirmed 静态 | P3-5 | src/main/ipc/chat.ts:601 | 重命名只改索引行，worker 协议里根本没有 rename，会话文档的 name 永不被 GUI 写入
- [session-index-08] low robustness confirmed 静态 | P3-5 | src/main/ipc/chat.ts:704 | fork 是唯一不做 TUI 交接的会话变更入口，从 worker 内存文档复制分支，一次 reload 失败之后会复制出缺少终端轮次的分支
- [session-index-09] low robustness confirmed-partial-waiver 静态 | P3-5 | src/main/services/agent-host/WorkerManager.ts:1461 | 暂存 fork 文件没有任何回收扫描，fork 窗口里崩溃或删不掉就会在会话目录里留下无主 JSONL
- [session-index-10] low dead-code confirmed 静态 | P3-5 | src/renderer/components/chat/sessionIndex/useSessionIndex.ts:64 | mergeSessionIndex 的 orphaned 返回值在生产里零消费者，会话因目录消失而从侧栏蒸发时没有任何提示
- [session-index-11] low capacity confirmed 静态 | P3-5 | src/main/services/chat/SessionIndexService.ts:442 | 索引行只增不删、无上限无修剪，而每一次回合结束都会把整张表重新序列化写盘

## import-upstream（T029，置信度 medium）：会话导入的上游六模块
- 节点 P5-4 上游（导入内容正确性：脱敏 / 工具输出裁剪 / Codex rollout 转换 / 扫描器容错）：complete-with-gaps
- 节点 H/21 对话导入代码侧（C1～C6）：complete-with-gaps
- [import-up-01] medium robustness confirmed-partial-waiver 静态 | P5-4 上游 | src/main/services/legacyImport/CodexSessionScanner.ts:89 | 一个读不动的子目录（或超过 1 万个文件）会让整份 Codex 历史从导入列表里静默消失
- [import-up-02] medium correctness confirmed-partial-waiver 静态 | P5-4 上游 / H/21 C2·C4 | src/main/services/legacyImport/CodexRollout.ts:35 | 以「<」开头的真实用户消息被当成合成注入整条丢弃，整段会话可能因此从导入列表里消失
- [import-up-03] medium perf confirmed 静态 | P5-4 上游 | src/main/services/legacyImport/CodexSessionScanner.ts:132 | 导入一条 Codex 会话要把整个 ~/.codex/sessions 重扫重解析一遍，批量导入 N 条就是 N 遍
- [import-up-04] low contract-gap confirmed 静态 | P5-4 上游 | src/shared/types/legacyImport.ts:6 | 上游的 64 MiB / 4000 条 / 64 KiB 口径从未与 32 MiB 会话预算对账，越界的后果是走完整条链路后在最后一步失败
- [import-up-05] low contract-gap confirmed 静态 | P5-4 上游 | src/main/services/legacyImport/ClaudeSourceAdapter.ts:502 | display 条目的 title 在生产侧无上限、在 Codex 侧可为空串，而 worker 校验硬卡「非空且 ≤ 256」，越界即整份对话被拒
- [import-up-06] low security confirmed | P5-4 上游 | src/main/services/legacyImport/legacyImportSanitization.ts:8 | 脱敏只作用在不进模型上下文的 display 行；进上下文的正文一个字符都不过滤，且正则认不出 JSON 形态的密钥
- [import-up-07] low test-gap confirmed | P5-4 上游 | src/main/services/legacyImport/__tests__/CodexImportIntegration.test.ts:16 | 退役后没有任何用例把真实转写结果喂给 native 写入器，而写入器自己的固定装置用的是上游从不产出的两种形状
- [import-up-08] low correctness confirmed 静态 | P5-4 上游 | src/main/services/legacyImport/CodexRollout.ts:140 | Codex 的思考块只读 summary 不读 content，与同仓的 codexItemMapper 口径不一致，丢了也不记诊断
- [import-up-09] low correctness refuted 静态 | H/21 对话导入代码侧 | src/main/services/legacyImport/ClaudeSourceAdapter.ts:83 | Claude 的 summary（压缩 / 续接锚点）行被当控制行静默丢弃，导入的续接会话丢掉「之前发生了什么」
- [import-up-10] low docs confirmed | H/21 对话导入代码侧 | docs/plantree/plans/runtime-evolution/evidence/external-agent-migration/README.md:0 | H/21 C1～C6 的现场证据记录的是 pi 时代的落盘路径，与 native 的扁平 sessions 目录不符，未随 P6-5 更新

## terminal-tui（T029，置信度 medium）：终端 / TUI 侧（H/20 互通的另一半）
- 节点 H/20 Main 半边：complete-with-gaps
- 节点 TUI-1：complete
- 节点 GUI A/2 代码侧：complete-with-gaps
- [terminal-01] medium robustness confirmed 静态 | H/20 Main 半边 | src/main/services/terminal/PiTuiPty.ts:333 | kill 发出即当成功：不等进程退出、不校验、失败被吞
- [terminal-02] low correctness uncertain | H/20 Main 半边 | src/main/ipc/chat.ts:134 | 会话索引读失败时，释放与闸门被一起跳过，GUI 直接开写
- [terminal-03] medium correctness confirmed 静态 | GUI A/2 代码侧 | src/renderer/components/chat/usePresentationSwitch.ts:96 | 终端 id 是应用级的：TUI 模式下切换会话，终端仍绑在上一个会话的 JSONL 上
- [terminal-08] medium correctness confirmed | GUI A/2 代码侧 | src/main/services/terminal/ShellDetector.ts:327 | 自定义 shell 推参用子串匹配，/bin/sh 被判成 PowerShell
- [terminal-04] low robustness confirmed 静态 | GUI A/2 代码侧 | src/renderer/hooks/useXterm.ts:981 | 复活用的 open 不带 sessionFile：PTY 已不在时会静默起一个全新的 pi 会话
- [terminal-09] low windows confirmed 静态 | GUI A/2 代码侧 | src/main/services/terminal/ShellDetector.ts:356 | Windows 默认 shell 返回 pwsh.exe，且 PtyManager 的 spawn 失败回退只有 Unix 分支
- [terminal-05] low test-gap confirmed | H/20 Main 半边 | src/main/services/terminal/__tests__/t35FinalAbsence.test.ts:108 | 守卫用例声称「TUI 不带 resume 参数」，而 TUI 现在正是靠 --session 续接会话
- [terminal-07] low docs confirmed | GUI A/2 代码侧 | src/renderer/components/chat/__tests__/tuiHandoverWiring.test.ts:42 | 「suspend 之后另一个写者不再追加」这句话不成立
- [terminal-06] low dead-code confirmed | GUI A/2 代码侧 | src/renderer/stores/worktreeActivity.ts:294 | TUI 活动指示灯拿 terminalId 当会话 id 查表，永远查不到
- [terminal-10] low contract-gap confirmed | H/20 Main 半边 | src/main/ipc/piTui.ts:162 | dispose() 不带 terminalId 会让这个窗口的控制器永久报废

## agent-host-lib（T029，置信度 high）：src/agent-host 未读模块与 runtime → agent-host 依赖方向
- 节点 P3-2：complete-with-gaps
- 节点 P6-5 尾巴：complete-with-gaps
- 节点 依赖边界：complete-with-gaps
- [ah-lib-01] medium security confirmed 静态 | 依赖边界 | src/runtime/plugins/agent-loop/index.ts:463 | 会话文件落盘的 provider 错误正文两套脱敏都没走
- [ah-lib-02] medium security confirmed 静态 | 依赖边界 | src/runtime/plugins/agent-loop/providerErrors.ts:39 | T011 新写的脱敏规则比仓库既有那份弱，认不出裸密钥形状
- [ah-lib-03] medium correctness confirmed | P6-5 尾巴 | src/renderer/components/chat/historyError.ts:27 | 恢复失败的分类表仍查 pi 时代的 WORKER_SESSION_* 词汇，native 的错误码一条都不认
- [ah-lib-04] low dead-code confirmed 静态 | P6-5 尾巴 | src/agent-host/userResourcePaths.ts:23 | 模块零消费者，它承载的「技能装到哪」指令在 native 提示词里没有替身
- [ah-lib-05] low contract-gap confirmed | 依赖边界 | src/runtime/__tests__/hostBoundary.test.ts:13 | 宿主边界守卫只扫 src/runtime，经 agent-host 模块可绕过；这条边本身无守卫无成文规则
- [ah-lib-06] low test-gap confirmed | P3-2 | src/agent-host/__tests__/piSessionTimeline.test.ts:9 | 两个被 runtime 直接消费的模块缺关键用例：T005 的重开半边、以及 forkable 的正例

## chat-tool-vocab（T029，置信度 medium）：渲染层工具词汇表全量比对
- 节点 P4-5：complete-with-gaps
- 节点 P6-3 第 4 条：complete-with-gaps
- 节点 P5-2-6：complete-with-gaps
- [chat-tool-01] medium correctness confirmed 静态 | P4-5 / P6-3 第 4 条 | src/renderer/components/chat/toolCard.ts:628 | 命中列表只认大写 Grep / Glob，native 的每一次搜索都没有命中列表
- [chat-tool-02] medium contract-gap confirmed-partial-waiver 静态 | P4-5 | src/renderer/components/chat/questionCardModel.ts:771 | 只带路径的审批卡（read / glob / grep / browser_preview）从不显示被批准的那个路径
- [chat-tool-03] low i18n confirmed 静态 | P4-5 / P5-2-6 | src/renderer/components/chat/toolCard.ts:1175 | T020 新写的四段 arg 文案是裸英文，中文界面出现半中半英的工具行
- [chat-tool-04] low i18n confirmed 静态 | P4-5 | src/runtime/plugins/skills/index.ts:401 | 技能审批卡的正文标签 Skill 没有中文词条
- [chat-tool-05] low contract-gap confirmed 静态 | P5-2-6 | src/renderer/components/chat/subagentActivityModel.ts:794 | 子代理面板表头与 Run 面板直接显示原始工具名（含 mcp__ 前缀）
- [chat-tool-06] low correctness confirmed 静态 | P4-5 | src/runtime/plugins/permissions/activity.ts:50 | 权限活动行对 MCP / skill 把路径当成「被评估的值」，surface 也不是策略词汇
- [chat-tool-07] low dead-code confirmed | P4-5 | src/renderer/components/chat/turnTiming.ts:192 | 回合摘要三函数在生产里无消费者，注释却说它们仍在用；其中的编辑工具表还是只认大写名
- [chat-tool-08] low test-gap confirmed | P4-5 | src/renderer/components/chat/__tests__/runtimeToolVocabulary.test.ts:55 | 没有一条测试拿 runtime 注册表去对账渲染层的查表点
- [chat-tool-09] low correctness confirmed | P4-5 | src/renderer/components/chat/piToolNames.ts:82 | mcp__ 拆分在服务器名含 __ / 结尾为 _ 或全名被截断时给出错误标签

## chat-event-vocab（T029，置信度 medium）：渲染层事件词汇表与状态机全量比对
- 节点 P4-5：complete-with-gaps
- 节点 P3-4 渲染半边：complete-with-gaps
- 节点 F5：complete-with-gaps
- 节点 F7a/F7c 代码侧：complete-with-gaps
- [chat-event-01] medium correctness confirmed 静态 | F5 | src/renderer/stores/chatSessions.ts:1266 | 问答卡只有一个全局槽位，第二个问答挤掉第一个并让那一回合永久挂起
- [chat-event-02] medium correctness confirmed 静态 | P3-4 渲染半边 | src/renderer/stores/chatSessions.ts:1174 | waiting_permission / waiting_question 没有回程，Run 面板从用户点「允许」起一直显示「等待审批」
- [chat-event-03] medium correctness confirmed-partial-waiver 静态 | P4-5 | src/runtime/events/projector.ts:520 | 子代理花费那条 usage.updated 不带 context，渲染层整体替换后上下文占用徽标消失
- [chat-event-04] low dead-code confirmed | P4-5 | src/runtime/plugins/tools/index.ts:139 | tool.updated 在 native 下没有任何生产者，T017 补的 input 与三个渲染消费者一起失效
- [chat-event-05] low contract-gap waived | P3-4 渲染半边 | src/renderer/components/chat/permissionActivityRow.ts:141 | 子代理审批行的归属只发不画：能画它的分支读的是两个没有生产者的字段
- [chat-event-06] low dead-code confirmed | P3-4 渲染半边 | src/shared/types/runtimeEvents.ts:974 | permission.activity 有五个字段自旧引擎退役后再无生产者，渲染层为它们保留了三段分支
- [chat-event-07] low i18n confirmed | F7a/F7c 代码侧 | src/renderer/components/chat/permissionActivityRow.ts:122 | 审批行的 resolution 与 autoReason 直出原始枚举，最常见的自动放行在中文界面显示为英文
- [chat-event-08] low dead-code confirmed 静态 | P4-5 | src/renderer/components/chat/hostStatus.ts:140 | host.ready / host.error 全仓零生产者，诊断横幅的 error / starting 两臂与 Node 24 指引不可达
- [chat-event-09] low dead-code confirmed | P4-5 | src/shared/types/runtimeEvents.ts:154 | session.status.liveness rider 没有生产者，只剩 composer 诊断里的一段格式化分支
- [chat-event-10] low dead-code confirmed | P4-5 | src/renderer/components/chat/subagentActivityModel.ts:369 | subagent.activity 的 kind:'progress' 没有生产者，lane 的 progress 槽永远为空
- [chat-event-11] low contract-gap confirmed | P4-5 | src/shared/types/runtimeEvents.ts:61 | seq 没有任何消费者，且它在 Main 丢弃事件之后才编号，事件丢失在协议上不可检测
- [chat-event-12] medium correctness confirmed | P3-4 渲染半边 | src/renderer/stores/chatSessions.ts:524 | 回放只还原四类 block，重开会话后权限卡行、审批审计行与已答问答卡全部消失

## smoke-p0-6（T030，置信度 high）：P0-6 冒烟通道（runOnce / assertions / cases）
- 节点 P0-6：complete-with-gaps
- [smoke-01] low test-gap confirmed 静态 | P0-6 | docs/plantree/plans/runtime-evolution/evidence/p0/offline-smoke-trace.jsonl:1 | P0-6 存档冒烟证据落后 HEAD 227~228 个提交，横跨一次引擎整体退役
- [smoke-02] low docs refuted | P0-6 | src/runtime/smoke/assertions.ts:10 | 注释承诺「P1..P3 可复用」断言层，但 P1 探针实际未复用

## cordis-spike-d1（T030，置信度 high）：D1 Cordis 选型 spike 与 core-host-19
- 节点 P0-2：complete-with-gaps
- 节点 D1：complete-with-gaps
- [spike-01] low docs confirmed | P0-2 / D1 | docs/plans/2026-09-08-runtime-evolution-ard.md:58 | D1 承诺的三项 Cordis 能力零落地且无任何落地注记
- [spike-02] low test-gap confirmed | P0-2 | src/runtime/bootstrap.ts:519 | plugin_graph_incomplete 失败兜底路径没有任何测试覆盖

## field-nodes（T030，置信度 high）：现场口径复核（P4-6 与 F1～F7）
- 节点 P4-6：complete-with-gaps
- 节点 F1 网络面板：complete
- 节点 F2 临时会话恢复（含 F2-a/b/c）：complete-with-gaps
- 节点 F3 GUI Git 输出丢失：incomplete
- 节点 F4 重试：complete-with-gaps
- 节点 F5 通用问答：complete-with-gaps
- 节点 F6 对话修改审阅：complete-with-gaps
- 节点 F7（a/b/c/d/e/f）：complete-with-gaps
- 节点 GUI A/4 临时目录复用/创建/绑定：complete-with-gaps
- 节点 GUI A/10 /new 继承 cwd：complete-with-gaps
- 节点 GUI B/5 重试与异常恢复：complete-with-gaps
- 节点 GUI C/8 问答卡交互：complete-with-gaps
- 节点 GUI F/13 目录行变更量：complete-with-gaps
- 节点 GUI F/15 cwd 缺失与临时目录恢复：complete-with-gaps
- [field-01] low docs confirmed 静态 | P4-6 | docs/plantree/plans/runtime-evolution/README.md:136 | 看板把现场明确拒签的 R2/R3 写成载体对照结论，并据此宣告放行规则结案
- [field-02] low docs confirmed 静态 | P4-6 | docs/plans/2026-09-09-bash-carrier-decision.md:3 | D1 决策文档的现场结果栏全空，等于把已被证明无效的 R4 方法原样留给下一次上机
- [field-03] low docs confirmed | F5 / F7 / GUI C/8 | docs/plantree/plans/runtime-evolution/README.md:223 | 现场表 F7a/F7c 行仍写「通用问答卡仍受 F5 限制」，与同表 F5 行自相矛盾
- [field-04] low docs confirmed 静态 | P4-6 | Windows-P4-6-evidence/launch-native.ps1:3 | 已删除的后端开关在现场启动脚本与清单里还剩四处，脚本还会把它回显成一条假确认
- [field-05] low docs confirmed | P4-6 / PERM-1 | docs/plantree/plans/runtime-evolution/evidence/p4-6/perm1/README.md:6 | PERM-1 证据的复现命令已失真，而 T032 要求的复跑会就地覆盖被标为 legacy 的历史证据
- [field-06] low contract-gap confirmed | P4-6 / F1～F7 | docs/plantree/plans/runtime-hardening/roadmap.md:107 | T032 声称合并旧树待现场项，枚举却漏掉本区域全部十余条

## baseline-comparability（T030，置信度 high）：可比性与单测门禁（P2-0 / P2-5 / P2-6 / P1-7）
- 节点 P2-0：complete
- 节点 P2-5：complete-with-gaps
- 节点 P2-6：complete-with-gaps
- 节点 P1-7：incomplete
- [baseline-01] low contract-gap confirmed-partial-waiver | P1-7 | .github/workflows/build.yml:3 | 测试执行只挂在 tag 推送/手动 dispatch 上，日常提交与 PR 完全不触发任何自动化测试
- [baseline-02] low test-gap confirmed | P2-5 | vitest.config.ts:13 | 支撑 D9 缓存命中率公式的单测被排除在 vitest / CI 之外
- [baseline-04] low correctness waived | P2-6 | scripts/runtime-baseline/collect.mjs:143 | 收集脚本产出的报告标题硬编码为旧后端，不看归档的实际 backend 字段
- [baseline-03] low docs waived | P2-5 | docs/plantree/plans/runtime-evolution/evidence/p2-5/README.md:121 | 「复现」小节的命令引用了已删除的采集器 run.mjs

## h-nodes（T030，置信度 medium）：H/17、H/19、H/21 与 P5-2-0
- 节点 H/17：complete-with-gaps
- 节点 H/19：complete-with-gaps
- 节点 H/21：complete-with-gaps
- 节点 P5-2-0：complete

## concurrency（T031，置信度 medium）：并发多会话静态面
- 节点 P3-1：complete-with-gaps
- 节点 P3-3：complete
- 节点 P5-1：complete-with-gaps
- 节点 P5-3：complete-with-gaps
- 节点 P4-0：complete-with-gaps
- [concurrency-01] medium concurrency confirmed | P3-1 | src/runtime/plugins/session/writerLock.ts:173 | 抢占陈旧锁时锁名短暂空缺，第三个申领者可在此窗口建锁，造成同一会话两个写者
- [concurrency-02] medium robustness confirmed 静态 | P3-1 | src/runtime/plugins/session/writerLock.ts:128 | pid 被复用后陈旧锁永远判不成陈旧，会话永久打不开且界面无补救入口
- [concurrency-03] low concurrency confirmed | P3-1 | src/runtime/trace.ts:258 | 多个 worker 共用一个 traceDir 时会双重轮转，提前丢掉一整代 trace 并在代号上留空洞
- [concurrency-04] low capacity confirmed 静态 | P5-3 | src/runtime/plugins/mcp/config.ts:227 | MCP 服务器数量只有每会话上限，没有全局预算，也没有进入 worker 内存分档的账
- [concurrency-05] medium robustness confirmed 静态 | P5-3 | src/runtime/host/exec.ts:171 | worker 被强杀时 MCP 子进程不随之退出，回收只能指望服务器自己认 stdin EOF
- [concurrency-06] low concurrency confirmed | P5-2-1 | src/main/services/agent-host/subagentCatalog.ts:236 | 子代理定义文件是截断式写入，而读者是每个顶层 run 全目录重扫的 N 个 worker，撞上就读到半截文档
- [concurrency-07] low contract-gap confirmed | H/20 | src/main/ipc/piTui.ts:114 | 「TUI 接管会话前不能有正在跑的回合」只由渲染层把关，Main 的 IPC 入口不复核
- [concurrency-08] low dead-code confirmed | P5-1 | src/runtime/plugins/skills/index.ts:363 | SkillsPlugin.refresh() 全仓无生产调用方，多会话的技能快照只能靠各自重启对齐
- [concurrency-09] low capacity confirmed | P4-0 | src/main/services/legacyImport/PiImportProcess.ts:34 | 导入 worker 另起一个进程，但不计入 worker 容量

## windows-static（T031，置信度 medium）：Windows 静态面与上机检查单
- 节点 P1-8：complete-with-gaps
- 节点 P4-0：complete-with-gaps
- 节点 P4-6：incomplete
- [windows-01] high security confirmed 静态 | P4-6 | src/runtime/plugins/permissions/index.ts:490 | Git Bash 的 /c/... 盘符写法绕过 ~/.ssh/* 与 ~/.aws/credentials 的不可覆盖 deny
- [windows-02] medium robustness confirmed 静态 | P4-0 | src/runtime/host/exec.ts:518 | Windows 上一条已跑完的命令能否成功回报，取决于一个外部 taskkill 进程是否在 2 秒内退出
- [windows-03] medium windows confirmed 静态 | P4-0 | src/runtime/plugins/mcp/index.ts:211 | stdio 型 MCP 服务器在 Windows 上起不来：npx 与 uvx 与 npm 都是 .cmd，而链路上两次 spawn 都是 shell false
- [windows-04] low contract-gap confirmed 静态 | P4-6 | src/runtime/plugins/tools/index.ts:413 | Windows 上没装 Git for Windows 时 bash 工具照样登记给模型，每次调用返回一句指责宿主的英文错误
- [windows-05] low correctness confirmed 静态 | P4-6 | src/runtime/plugins/tools/index.ts:384 | edit 对 CRLF 文件做逐字节精确匹配，失败时的错误不提行尾，模型会退回整文件 write 从而把全文行尾改成 LF
- [windows-06] low robustness confirmed-partial-waiver 静态 | P4-6 | src/runtime/plugins/session/writerLock.ts:128 | 会话写锁只靠 PID 存活判定陈旧，Windows 的 PID 复用会把一把死锁永久锁死；记了 acquiredAt 却从没人读
- [windows-07] medium windows confirmed 静态 | P4-6 | src/main/services/terminal/PtyManager.ts:126 | 用 utf8 编码读 reg query 的输出，中文 Windows 上会把含非 ASCII 的 PATH 条目解码坏
- [windows-09] medium i18n confirmed 静态 | P4-6 | src/runtime/plugins/tools/index.ts:474 | bash 工具把子进程输出一律按 UTF-8 解码，Windows 原生工具的 OEM 代码页输出会变成一串替换字符进模型上下文
- [windows-08] low docs confirmed | P1-8 | docs/plantree/plans/runtime-evolution/README.md:73 | P1-8 行仍断言 RUNTIME_CONFIG_VERSION 冻结在 runtime_p3_complete_v1，而 T028 已把它解冻

## tsd-utility（T031，置信度 medium）：加密文件系统（TSD）回落与 Electron utility 载体
- 节点 P1-0：complete-with-gaps
- 节点 P1-2：complete-with-gaps
- 节点 P1-8：complete-with-gaps
- 节点 P4-0：complete-with-gaps
- [tsd-01] low contract-gap confirmed-partial-waiver 静态 | P1-0 / P1-8 | src/runtime/host/worker.ts:82 | TSD 回落只在不可能命中的平台上启用，在唯一有密文的平台上按设计关闭，整条链路无出厂触发路径
- [tsd-02] medium robustness confirmed | P1-4（经 P1-2 的读出口触发） | src/runtime/plugins/tools/index.ts:612 | grep 的逐文件 readFile 没有容错，一个读不了的文件让整次搜索失败
- [tsd-03] medium robustness confirmed 静态 | P4-0 | src/main/services/agent-host/WorkerTransport.ts:56 | utility 载体的 worker stdout 从不排空，node 载体排空——D11 第 5 条只落实了一半
- [tsd-04] low correctness confirmed 静态 | P1-0 | src/runtime/host/io.ts:148 | helper 的 stdout 是无框字节协议，而子进程环境整份继承：一条 stdout 启动噪声会把文件内容悄悄改写
- [tsd-05] low perf confirmed 静态 | P1-2 | src/runtime/plugins/tools/read-lines.ts:52 | 块大小封顶 2 MiB 之后重读量重新变成二次，注释与落地记录的「约线性」不成立
- [tsd-06] low test-gap confirmed-partial-waiver | P1-8 / P4-0 | src/runtime/smoke/p1-utility-worker.ts:10 | utility 载体探针不走产品路径推导，且它的 carrier 断言是同义反复
- [tsd-07] low correctness confirmed | P1-2 | src/runtime/host/io.ts:115 | 首 16 字节恰为 TSD 魔数的明文文件，在所有载体上都读不出来且没有任何出口

## capacity-leftovers（T031，置信度 medium）：容量对账的余项
- 节点 P3-1（容量面，T031 范围内）：complete-with-gaps
- [capacity-01] medium capacity confirmed | P3-1 | src/runtime/plugins/agent-loop/attachments.ts:34 | 用户附件无任何服务端体积上限，正常使用即可在个位数消息内顶满 32 MiB 会话预算
- [capacity-02] low capacity confirmed | P3-1 | src/runtime/plugins/agent-loop/index.ts:468 | trace 把每次工具调用的完整参数原文写入，唯一没有走预览截断模式的落盘点
- [capacity-03] low capacity confirmed | P3-1 | src/runtime/plugins/context/index.ts:317 | 压缩摘要正文没有显式字节上限，唯一约束是模型 hardLimit 间接决定的事后检查
- [capacity-04] low capacity confirmed | P3-1 | src/runtime/plugins/session/store.ts:290 | 会话文件缺少单行最大字节安全网，只有聚合字节检查
- [capacity-05] low concurrency confirmed 静态 | P3-1 | src/runtime/trace.ts:81 | 多个 worker 进程共享同一 traceDir 时，runs.jsonl 的轮转没有跨进程互斥
