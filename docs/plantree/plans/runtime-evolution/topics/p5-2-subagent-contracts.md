# P5-2：subagent 整体复刻契约

2026-09-09 · Role: contract · Status: 范围已确定，P5-2-0 差异门禁后实施
Authority：[ARD D10 / D17](../../../../plans/2026-09-08-runtime-evolution-ard.md)
Read with：[固定版本调研](p5-2-subagent-research.md) · [任务与验收矩阵](p5-2-subagent-tasks.md)

## 1. 完整基线与优化顺序

完整复刻 PI-Desktop `948ee676bdb7b31d496f6603aa03dd12eb95be35` 的**现行 subagent 工作体**，包含模型侧、宿主侧、管理 UI、运行 UI、持久化与错误路径。
第一阶段产出“整体等价基线”，第二阶段再以该基线评估优化。用户已明确仅组织内部测试、不对外分发；可直接搬用的源码、提示词和测试优先直接复用，执行过程中不新增版权、许可证或来源版本记录，不设置许可证审批或阻塞门禁。不得用“核心已实现，其余后补”关闭 P5-2；任何功能缩减都须明确范围变更。
复刻指可观察能力/生命周期等价，采用本仓 Cordis、Pi 0.84.4、HostIo/Exec、v4 JSONL、RuntimeEvent 和 @coss/ui；不复制 Rust 进程或整个 PI-Desktop 产品。
当前研究完成不等于 P5-2 实现完成。对标版本升级必须重新生成差异矩阵，不能执行途中无记录追随上游 HEAD。

## 2. 定义、模型与完整管理面

- 原生定义位置 `~/.agents/subagents/*.md`，不默认扫描项目定义；全局 user > 同名 builtin；确定顺序、单文档错误诊断、目录限额与模型限额按参考值。
- 完整字段：name、description、tools、prompt body、model/provider pin、thinkingLevel、permission、maxTurns；兼容旧 idle/duration 字段但明确其不再控制寿命。
- 默认四角色和源提示词/工具集/显式 turn cap 按调研原表迁移；本仓工具名称、参数或能力有差异时只能做必要语义适配，并保存原提示词与逐项差异。
- 启停存于应用数据、按当前 profile 隔离，不写 enabled 到 Markdown；文档共享与应用状态隔离沿用本仓 profile 体系。
- 管理端具备全局列表、搜索、创建、编辑、重命名、删除确认、启停、定位文件、模型与 thinking/turn cap 清空；每行 busy，乐观更新失败回滚，已加载列表刷新不闪空，宿主恢复后可刷新。
- UI 可按本仓信息架构放入既有资源/设置入口，但不能删掉编辑器、运行中状态或错误反馈；不为 subagent 重做整套 Settings。
- 保存需往返保留所有可执行语义字段；UI 尚无某字段控件时也必须保留原值，不能重写后悄悄丢 permission/provider。
- Task.model > definition.model > parent model；未固定才继承父模型。显式 model 不可用时工具失败并说明可用选择，不能静默增加成本；密钥仍由既有 resolver 提供，不进 renderer/报告。
- 每个顶层用户 run 重新读取活动定义，运行中的子 Agent 固定其定义/模型/提示词快照；编辑定义不会取消正在运行的任务。
- legacy 第三方插件与 native Task* 互斥。保留旧开关用户选择；无旧设置的新 native 默认使用完整内置目录，显式禁用则无 Task* 及相关提示词。
- 提供旧全局定义的显式迁移预览，显示字段差异/冲突、保留原文件；项目 `.pi/agents` 不自动提升为全局可信定义。批量迁移不能悄悄改变权限。

## 3. 四工具、调度与寿命

| 工具 | 契约 |
|---|---|
| Task | agent、task 必填；description/model 可选；受容量准入，启动立即返回 delegationId；完整 brief 是子任务初始上下文，不隐式复制父聊天 |
| TaskWait | ids 缺省为运行项；all/any/minCompleted；默认 600s、最多 900s；等待超时返回 heartbeat/已完成报告，未完成者继续；按 id 重读已结算报告不会重跑 |
| TaskList | 当前会话任务状态、时长、turns、toolCalls、lastToolName；状态快照替换，不把 heartbeat 每次追加成大量父上下文 |
| TaskStop | 缺省停止运行项；按 id 精确停止；发 abort 后等待任务/工具/记录真实收敛，返回稳定 stopped 状态，不能抢先显示已停止 |

- Task* 只在 agent 模式且目录可用时注册；父 plan 模式不委派，包括“只读子代理”也不作为首版例外。没有 goal 模式扩展。
- 同批 Task 可并行，混合工具批次和子 Agent 工具调用顺序执行；禁止嵌套 Task*。
- 每会话并发 **10**，满额明确工具错误，不隐式排长队；基线阶段不预先改成 4。开发机测试用 fake Agent/闸门验证 10，不在低资源机器同时启动十个真实编译/构建。
- 任一真实宿主容量不足按资源边界明确拒绝启动，不伪报已接单；多会话资源预算的测量与进一步调参在完整基线后优化，不能改写对标值而不记录差异。
- 父 loop idle 且仍有子任务时保持**同一逻辑 run 活跃**：不发 completed/idle、不释放活跃槽、不接受交叠 run、不触发 idle 回收；用户 Stop 一直可用。
- runtime 等任务结算并将报告作为内部上下文交回父 Agent，继续原目标。内部报告无用户气泡，不能取代“最新真实用户任务”，不能被压缩误认成用户新需求。
- 保持参考的等待集合语义；加入稳定交付标识，覆盖任务在父 idle 前已完成、TaskWait 已读、再一次自动继续等路径，防止漏报/重复整合；不要把 wait-all 优化成新调度算法塞入基线。
- 用户 Stop、TaskStop、dispose/宿主失败取消；父暂时结束不取消；Task.execute 的局部 signal 不拥有后台任务。用户 Stop 与完成同时发生时取消优先阻止再次调用父模型。
- 不启用 idle/duration 杀子任务；显式 maxTurns 仍生效，缺省/none/0 可无限轮。命令/provider 各自的超时仍有效，不能把“Agent 不超时”解释为取消底层 IO 保护。
- 子任务失败只结算其结果，父仍可整合/补救；未产生非空报告不能算成功。生命周期状态至少保留 running/completed/failed/aborted/stopped/truncated 和旧 timed_out 的恢复含义。
- registry 保留最多 100 条已结束项，绝不淘汰运行项；报告 12k、单次合并文本 50k。UI/details/持久化分开限额，不能仅截 text 却把完整大对象塞入 IPC。

## 4. 权限、工具与宿主适配

- 同一 worker 内第二个 Agent，独立模型上下文和权限调用上下文，**共享**会话 IO/Exec、审批出口、规范路径写序与持久化所有者；无额外 WorkerSlot/额外 supervisor。
- 工具能力来自定义与可用工具交集；公开七工具 Read/Glob/Grep/BrowserPreview/Bash/Edit/Write 兼容到本仓注册表；内置角色直接依赖的正则检索等能力必须补齐等价适配，不能仅删提示词掩盖功能缺口；禁止插件/Skill/模式工具/嵌套 Task。
- inherit 跟随父有效 gear；显式 permission 为该定义的审批 gear，不能扩展工具白名单、越过 deny 或把父 plan 改成 agent。内置不强制 accept-edits/auto。
- D14 优先：accept-edits 的工作区 bash 放行保持本仓语义；来源 permission 与旧 tier 分别迁移，不能混为同一个开关。
- 不通过全局 PermissionsPlugin.configure 临时切 gear 执行子工具；按 delegationId/toolCallId 隔离执行上下文，审批卡标注子代理来源，取消/拒绝不会串任务，缓存授权按既有 epoch 复核。
- 同一路径的父/子 Write/Edit 共用一把锁；realpath/平台路径规则沿用本仓，不复制 Linux 上全转小写；锁只保证写入顺序，不保证 stale read/整仓事务，保留 Edit 冲突检查。
- Bash 不能由 PathMutex 假装获得文件级完整隔离；指令里要求子任务清楚边界，执行仍受 D14/Exec。`test-runner`/explorer 含 Bash，不作强只读承诺。
- BrowserPreview 门面纳入本批必要宿主能力：工作区 HTML 预览、编辑后自动刷新、前台归属、不可用明确错误；不额外引入完整插件平台/CDP。若未接通，它所在矩阵行必须保持未验收。
- 参考 Bash 默认 60s、上限 6h，本仓默认 120s、上限 10min；P5-2-0 记录差异，P5-2-3 补齐长任务所需的显式超时适配（复刻接口以秒表达，内部转毫秒），不改现有无参数父 bash 默认、不允许自动重跑命令。长任务用假时钟验证，现场小样本验取消。
- provider 重试复用 P4 的 D9 前缀/重试基础：429 预算 5、其他可恢复预算 4，setup/stream 共预算，尊重 Retry-After、可停止、复用消息身份；不得把失败恢复写成重启整个 Agent 或重复执行工具。

## 5. 会话、事件、UI 与计费

- runtime/session 是唯一 JSONL writer；子消息/工具过程与 delegation 启动/结算存为有归属的自定义记录，保留完整可用数据；父 main 消息链只接收四工具正常结果与内部报告。
- 记录包含 sessionId、runId、delegationId、parentToolCallId、agentName、status、timing、model、usage 和报告/错误；不能用同名 agentName 作唯一键。
- 子 Agent 不能直接调用父 RuntimeEventProjector.finish；分流在入口，子 turn/agent 终态不触发父完成，结束时写成功再发布子结算。
- 优先复用 RuntimeEvent 的 subagent.activity/既有权限来源。原四值 status、轻量 report 容量不足的字段做向后兼容扩展；保留具体 stopped/truncated 原因，不用“failed”吞掉区分。Main/renderer/历史消费者在同批更新。
- UI 等价：Task 启动即返回仍显示子任务 running；fan-out 拓扑、同名独立实例、时长、工具/思考/文本、报告一次、错误/截断/停止、权限等待、局部滚动/跟随、离开尾部仍更新；历史读取和重载后重建相同状态。
- 现有 200 事件/40 行 ring 可作实时摘要预算，**不允许阻断终态、usage 或完整报告**；完整过程/报告用分页/按需历史补齐，不能以“我们已有 subagent 面板”跳过行为对齐。
- 子 usage 单独结算一次；父 message.usage 是 provider 原始值，父上下文占用不含子上下文；会话/轮级总成本含子调用。重复终态、TaskWait 重读、UI 刷新和 resume 不重记成本。
- 重启恢复已落盘状态、报告和归属；未结算记录显示 interrupted/aborted，不继续原子进程/工具，不把成功 Task ack 重放成新的委派。
- 本批不承诺崩溃恢复到子 Agent 中途或保存每个流式 token；这是参考没有的能力，不作为“完整复刻”的假承诺。
- 导航/fork/rewind/会话切换必须遵守活跃逻辑 run 边界；正常关闭先取消并排空记录再释放 writer；硬退出保留可识别的未结算事实。

## 6. 与 Claude 的 P4 施工衔接

P4 继续按原批次实现，本轮不修改其代码；**P4-1/2/3 不以实现 Task* 或提前创建空 SubagentRunner 为完成条件**。
P5 执行者需在 P4 合入点复核以下接缝，具体改动归 P5-2：

1. runtime.run Promise 表示整个逻辑任务完成，内部父 Agent 暂时 idle 不能成为 worker completed；Stop 可在等待子任务时经非阻塞 RPC 到达。
2. WorkerManager 生命周期以外层 run/slot busy 为准；报告自动继续不创建第二次用户 run，不跨槽重用旧 runId。
3. dispose/失联/Stop 可取消所有派生执行，等待 IO/exec 回收；会话 writer 与 Main 索引只在最终收敛后完成。
4. 事件需保留 session/run/委派归属和宿主全局 seq；流量裁剪与终态/持久化分离；权限请求支持来源和同时待批。
5. 声明目录/model 热更新在顶层 run 边界做，不为更新一条定义无条件 invalidate 正在运行的 worker。

P4 先前 GUI/Windows 验收只覆盖当时功能；P5-2 新增 Task* 后必须补两种 carrier 的子任务矩阵，不能沿用 P4 绿灯代签新增能力。

## 7. 完整验收与后续优化

以 [任务矩阵](p5-2-subagent-tasks.md) 每一行“上游行为→适配实现→测试证据”全绿签收；BrowserPreview、定义 UI、长任务、取消、旧插件迁移不得空缺。
UI/载体尚未签收时标“实现完成/现场待验”，P5-2 不标 Done。首轮无联网 faux/本地 SSE 桩，不新增真实成本承诺。
只有完整基线签收之后，才能另案讨论资源自适应并发、报告压缩/缓存优化、调度公平性等；每项需保留基线对比与回退，不恢复已撤回的 A2A/Peer。
