# PI-Desktop subagent 完整复刻调研

日期：2026-09-09 · Role: research · Status: 源码核对完成，非实现验收
权威：[ARD D10 / D17](../../../../plans/2026-09-08-runtime-evolution-ard.md) · [施工契约](p5-2-subagent-contracts.md) · [任务分解](p5-2-subagent-tasks.md)

## 目标与取证边界

用户本轮明确要求：**subagent 是完整工作体，应整体复刻，在完整基线上再优化**。
因此以 PI-Desktop 当前子系统的行为闭环为迁移单位；不把管理 UI、后台调度、异常/取消或恢复降为可选增强。
实施可以拆批，但 P5-2 只有完整等价矩阵验收后才能完成。旧“先做简版 / 只借鉴 ADR 0062/0119”退出当前依据。

- 本地参考：`/home/pi/code/PI-Desktop`；固定 commit **948ee676bdb7b31d496f6603aa03dd12eb95be35**，研究未读取其未跟踪 RequirementNote.md。
- [不可变源码入口](https://github.com/vastsa/PI-Desktop/tree/948ee676bdb7b31d496f6603aa03dd12eb95be35)。以下路径均相对此版本，不声称在线上游 HEAD 与它相同。
- 参考 runtime 的 Pi core/ai 是 **0.85.0**；本仓 D12 保持 **0.84.4**。已确认本仓有 afterToolCall / shouldStopAfterTurn / toolExecution / executionMode；完整运行兼容仍须 P5-2-0 探针，不能按名称存在代签。
- 参考根 LICENSE / README 声明 **LGPL-3.0**，本仓 package.json 为 MIT。不能套用 pi-app/pix 的 MIT 说明；用户已确认仅组织内部测试、不对外分发，适合的源码/提示词/测试直接复用；本条为既有工程调研事实。后续执行过程中不新增版权、许可证或来源版本记录，不设置许可证审批或阻塞。部门内部实验不列入本计划。本轮不修改项目许可证。
- 本轮只读参考源码/测试，运行无需安装依赖的 3 个 Node 测试文件；没有跑参考仓 Agent Vitest、Rust、GUI、线上模型或整个构建。

## 演进过程：哪些经验已经替代旧方案

| 依据 | 当时解决的问题 | 固定版本的有效口径 |
|---|---|---|
| ADR 0062 | 限界子 Agent、上下文经济、报告与工具隔离 | 同进程第二个 Agent、报告边界和禁止嵌套仍有效；阻塞式 Task、并发 4 已过时 |
| ADR 0063 → 0112 → 0126 | 定义文件无管理界面；后续改版又误删编辑能力、启停闪烁/锁整页 | 全局 `.agents/subagents`，文档与应用启停分离；恢复创建/编辑/删除，逐行 busy、乐观启停、后台刷新保留列表 |
| ADR 0089 | 主模型很少委派，Task 阻塞、没有实施角色 | 四个 Task 工具、主动委派提示词、后台 registry、fixer；同会话并发 10 |
| ADR 0100 | fixer 固定档位导致父 auto 反而弹审批 | 内置默认 inherit，定义可显式指定审批档位，工具能力独立约束 |
| ADR 0091 / 0128 | 子 Agent 比父代理更易被网关中途失败打断，重试预算相乘 | 429 五次重试、其他可恢复故障四次；setup/stream 共预算、可取消，失败请求重试而非重放已完成工具 |
| ADR 0119 / 0129 → 0166 | 静默、长工具和长任务误判；父模型结束导致子任务被取消 | 撤回 idle/duration 杀任务策略；父 loop idle 不等于会话完成；runtime 等待并交回报告，显式 Stop/dispose 才取消 |
| ADR 0138 → 0140 → 0147 → 0165 | 曾探索同辈通信、A2A broker | **已撤回**，当前只有父代理经 Task* 汇总。完整复刻不恢复已删除的 Peer/A2A |
| ADR 0170 | 预览移到随包插件，但旧工具名仍被 Plan/子代理使用 | `BrowserPreview` 仍是可分配宿主门面；插件不可用时明确失败。完整工具声明兼容不能遗漏它 |
| ADR 0153 / 0171 | 崩溃丢输出、会话账单漏子代理成本 | 已结束子行持久化且保留归属；父 message usage 不混子成本；参考不为子代理流式半行做 checkpoint，不承诺重启继续执行 |

旧调研 §3.4 的“本轮不做”是 2026-09-08 的历史范围，已被本轮用户指令替代；旧 D10 的拓扑保留，参数和生命周期由本轮修订替代。

## 源码与测试地图

| 子系统 | 参考源码 | 关键测试/证明 | 本仓落点 |
|---|---|---|---|
| 定义协议与限制 | packages/shared/src/subagent-definition.ts | 同目录 subagent-definition.test.ts：默认工具、解析/合并/去重/上限 | shared 定义类型/解析器，host 读取 |
| 四内置角色与模型绑定 | packages/agent-runtime/src/subagent-definitions.ts | subagent-definitions.test.ts：覆盖 builtin、无项目目录、坏文档诊断、model pin 不回落 | runtime/plugins/subagent + 既有 model-adapter |
| 子 Agent loop | packages/agent-runtime/src/subagent.ts | subagent.test.ts：归属、不转发父终态、报告限额、无报告失败、取消、maxTurns、重试、撤回 watchdog | SubagentRunner |
| Task 生命周期 | packages/agent-runtime/src/runtime.ts:2727–3339 | runtime.test.ts 的 DesktopAgentRuntime subagents 块 | 会话级 registry + 四工具 |
| 自动交回报告 | runtime.ts:3063、5150 附近 | runtime.test.ts：keeps running delegates / feeds finished reports / abort on user or dispose | 父 loop 协调器 + P4 worker 运行终态边界 |
| 权限/模型/写锁 | scopeDelegateTools、subagentProvider、path-lock.ts、provider-retry.ts | runtime.test.ts、path-lock.test.ts、provider-retry tests | 独立权限上下文 + 会话共享规范路径锁 + 共用重试策略 |
| 管理持久化 | crates/host-core/src/user_subagents.rs、agent_capabilities.rs、rpc/mod.rs agents.* | Rust 局部测试；scripts/e2e-subagents.mjs | TS 管理服务 / HostIo / Main IPC |
| 管理 UI | AgentSubagentsPage.tsx、SubagentEditorSheet.tsx、API/preload/i18n | subagent-wiring.test.mjs、能力编辑器测试 | 本仓资源/设置入口，复用 @coss/ui |
| 实时/历史呈现 | subagent-topology.ts、ChatTranscript.tsx、app-store.ts、use-follow-scroll.ts | subagent-topology.test.mjs、subagent-transcript.test.mjs | subagent.activity / reducer / 卡片与历史恢复 |
| 会话/usage | electron/main/index.ts subagentTagged、sessions.rs、runtime.ts settleDelegation | runtime.test.ts usage case、sessions.rs attribution roundtrip | v4 custom 记录 + piTurnRollup，禁止混入父 prompt |

另外按本仓参考约定复核 pi-app 的 worker-manager-pool.ts / incomplete-session-recovery.test.mjs（适配参考退出排空边界），以及 pix 的 session-dir.ts / session.test.ts（不采用整包 SettingsManager 目录回落）。

源码清单与 SHA-256 见 [证据入口](../evidence/p5-subagent/README.md)。这不是只搬 subagent.ts：后台调度在 runtime.ts，管理写入在 Rust，展示与重开又在 Electron/renderer。

## 固定基线的完整能力

### 定义与管理

- 四个内置角色：explorer / code-reviewer / test-runner / fixer；上限分别 60 / 50 / 40 / 80 turns。
- explorer 和 test-runner **含 Bash**，只有 code-reviewer 是纯 Read/Glob/Grep；不能把“没有 Edit/Write”说成执行层绝对只读。
- 默认未声明 tools 为 Read/Glob/Grep；允许 Read/Glob/Grep/BrowserPreview/Bash/Edit/Write。无 Task*、插件工具、Skill 或模式切换工具；不允许子 Agent 再嵌套委派。
- user 全局文档优先于同名 builtin；加载失败只诊断该文档，目录顺序确定，runtime 菜单最多 16、固定 provider 最多 8。
- 管理端创建上限 64，单文档 32 KiB、名称 40 字符、描述 400 字符。**管理库存上限与运行目录上限不是同一个数。**
- 支持 name/description/tools/model/provider/thinkingLevel/permission/maxTurns/body，旧 idle-timeout/max-duration 字段解析但不武装计时器。
- maxTurns 未声明、none 或 0 表示不设总轮上限；正整数上限 80；内置仍有显式上限。
- 管理全局文档，启停放应用数据；每次顶层 prompt 重载活动目录，当前子任务固定启动时快照。
- UI 源码有创建/编辑/删除、搜索、启停、定位文件、清空 model/maxTurns；不按 ADR 0063 最初的“只读列表”复刻。

### 编排与运行

- `Task(agent, task, description?, model?)` 后台启动返回 delegationId；Task.model > 定义 model > 父 model，显式 model 解析失败不能静默换模型。
- `TaskWait(ids?, all|any, minCompleted?, timeoutSeconds?)` 等待结果；默认 600s，上限 900s。超时只结束此次等待，不停止任务；已有结果可以按 id 再读。
- `TaskList` 返回状态及 heartbeat；`TaskStop` 发取消后等待真实结算，再返回稳定状态。
- Task 是唯一允许并行的父工具；只含 Task 的批次可并发，混合工具批次和子 Agent 内部工具顺序执行。
- 会话运行上限 10；超额返回工具错误而非无限队列。已结束 registry 100 条，淘汰最早已结束项，不能淘汰运行项。
- 单报告 12,000 字符，TaskWait 合并文本 50,000 字符。长报告裁剪须明确，TaskList 只给摘要。
- 父 loop 暂时结束时，durable run/Stop 可用性继续；runtime 等子任务完成，交回报告，再驱动父 Agent 整合。源实现按本次抓取的运行任务集合等待全部结束；不是逐 token 推入父上下文。
- 只有用户 Stop、TaskStop、dispose/实际宿主退出取消；不把 Task.execute 的短期 signal 当成子任务 lifetime signal。
- 父模型权限模式与定义工具能力分开；内置 inherit，用户显式审批档位有真实执行含义，审批卡显示委派来源。

### 记录与显示

- 子行携带 parentToolCallId / agentName，生命周期以 delegationId 区分同名实例；子 turn_end/agent_end/error 不可结束父会话。
- 卡片以 registry / TaskWait / TaskList / TaskStop 结果决定实际状态，**不能把 Task 工具立即返回的成功当成子任务完成**。
- 一次 fan-out 的独立任务可见，报告显示一次；子行单层嵌套、局部滚动、跟随最新输出、用户上滚后停止跟随；非时间线尾部也须实时更新。
- 子过程不进父模型上下文，但完整已结束行应能经历史读取；轻量实时投影的截断不能冒充全量历史。
- 子 usage 从结算处独立累计，父 provider usage/上下文占用不被子成本污染；重试、重复读取结果和重开不能重复计费。

## 必要适配与尚不能由源码证明的内容

**适配移植**整个子系统行为，**直接移植候选**为纯解析/格式化/状态归约与测试向量；部署、IO、权限与 UI 需要适配。
以下是完整迁移前置/验收项，不是把功能推迟到优化期的理由：

1. D11：不能复制 Rust host 或新 singleton；定义读取/写入与命令仍经 HostIo/Exec，兼容 Windows bundled-node 与 electron-utility。
2. D14：父 plan 不提供 Task*；agent 中 inherit 映射 gear；accept-edits 在本仓放行工作区 bash，不能搬回上游只自动允许 Write/Edit 的旧口径。
3. 本仓原工具名为小写、Edit 协议/搜索能力与上游不同。公开子代理定义和四角色提示词需经过一处工具适配，内置角色直接依赖的正则检索等功能须补等价适配，不能通过删除提示词缩减能力；行锚 Edit 等参数转换也必须验证调用有效。
4. BrowserPreview 在本仓尚无等价运行工具；列入 P5-2 必须落地的宿主兼容能力，不能解析时悄悄删掉后宣称全量等价。浏览器 CDP/市场等独立产品能力不因这条整体引入。
5. 原有第三方 `@gotgenes/pi-subagents` 的目录是 `<agentDir>/agents`、项目 `.pi/agents`。新管线不能让两套 Task 同时注册；旧全局定义要有显式预览迁移，项目定义不静默变成可信全局定义，原文件保留。
6. P3 appendMessage + buildSessionContext 尚未提供 native 子消息归属通道；实时 200 事件 cap/40 行 ring 不能代替持久化；完整报告、结算及恢复须扩展 P3 投影边界。
7. 参考 runtime 的 registry/promise 在内存，不是重启续跑框架；ADR 0153 明确不 checkpoint 子流式半行。本仓恢复显示事实并标记中断，不自动重放已执行工具，不承诺进程死后继续原 Agent。
8. 源码与测试仍有缺口：heartbeat 的 turns 在子 handleEvent 内计数，但 registry 从不转发的 turn_start 更新，需真实事件链核对；自动交回需覆盖“子任务在父 idle 前已完成”和重复 TaskWait 的交付竞态；现有报告文本限额不等于 details 序列化总量有界。
9. 管理 Rust render_document 未保留 permission 等所有 parser 字段；迁移须补定义编辑往返测试，避免 UI 改名/保存改变审批语义。PathMutex 的全部路径 toLowerCase 也不能直接用于区分大小写的 Linux。
10. 参考源码并未提供模型可中途改写子任务 brief 的能力；不把本轮复制扩大为新通信协议。已有用户信息通过父 run/停止重派处理。

## 已执行验证与结论强度

在参考仓执行：`NODE_OPTIONS=--max-old-space-size=768 node --experimental-strip-types --test --test-concurrency=1 apps/desktop/test/subagent-topology.test.mjs apps/desktop/test/subagent-transcript.test.mjs apps/desktop/test/subagent-wiring.test.mjs`。
结果 **3 文件 32 项通过**：11 项纯 topology 行为，21 项源码接线/展示结构检查；**不等于运行子 Agent、GUI 或 Rust 验收**。
无依赖安装、无生产构建、无网络调用；未运行的 runtime Vitest 样例已逐项列为本仓移植门禁。并行 P4 代码未修改。
