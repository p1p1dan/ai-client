# PiLab 会话体验优化：协议、身份与固定回放映射

源码基线：`69f2e45511cd9ed2d5a7b19b2671671fb32bda93`
日期：2026-10-29
配套台账：`2026-10-29-pilab-session-experience-review.md`

## 1. 证据层级

| 层级 | 当前材料 | 能证明什么 | 不能替代什么 |
|---|---|---|---|
| 构造夹具 | `src/shared/__tests__/fixtures/pilabExperience.ts` | 确定边界、合法重复、乱序、长链、旧字段和性能输入 | 不能声称真实宿主一定产生该序列 |
| 真实 DSH 录制 | `src/shared/__tests__/fixtures/dsh/stream.*.json`、`rpc.*.json`；`dshStreamReplay.test.ts` | 产品 DSH bridge 的实际输出及 renderer 消费 | 不能替代 Claude SDK、真实窗口和权限侧验证 |
| 纯 reducer/组件测试 | `applyRuntimeEvents`、timeline 和视图模型测试 | 状态归并、排版和交互逻辑 | 不能替代真实 IPC、模型请求计数和 Electron 交互 |
| 宿主/Main 测试 | WorkerManager、DSH/SDK bridge、权限和文件服务测试 | 权威事件、控制、归属和写入行为 | 不能单独证明默认界面可读或滚动正确 |
| 真实 Electron | 隔离 profile 的界面、键盘/IME/DPI/窗口和性能记录 | 用户实际工作流 | 不能用静态截图替代执行、权限和文件基线证据 |

## 2. 引擎与事件信封

| 主题 | 当前协议事实 | 实现证据 | 展示/整改约束 |
|---|---|---|---|
| 现役引擎 | `dsh`、`claude-sdk`；`pi` 只读历史并迁移 | `shared/claudeSdkEngine.ts:11-27`；`shared/types/agentWire.ts:1-60` | 两种现役路径都须回归，不能只改 Claude 专项 |
| Worker 到 Main | 两种 transport 进入同一 WorkerSlot/WorkerManager | `WorkerSlot.ts:127-238`；`WorkerManager.ts:3591-3678` | 优先沿用统一 RuntimeEvent，不另建 UI 专用后端 |
| Main 到 renderer | Main 在 dispatch 时重新分配单调 `seq` 和 `timestamp` | `WorkerManager.ts:5178-5185` | renderer 可用 session + seq 识别同一 Main 传输事件；不能把它当模型全局 eventId |
| 信封字段 | `type`、`seq`、`sessionId?`、`requestId?`、`timestamp` | `runtimeEvents.ts:68-77` | 只有实际字段可用于幂等；时间戳不替代顺序 |
| 序号边界 | seq 来自当前 WorkerManager 进程；应用重启后不是持久序号 | 同上；恢复由 resumed/history 开启新代际 | 不得用永久全局高水位丢弃重启后的新事件；#11 需明确 resumed 边界 |
| 上游重复 | 同一上游事件若再次 dispatch，Main 会重新盖章 | 同上 | seq 不是端到端去重凭据；宿主完整帧/快照仍需按块和调用身份校准 |
| 广播 | 同一事件发给所有非销毁 BrowserWindow | `main/ipc/chat.ts:180-214` | 多窗口共享事件不意味着各自执行；权威控制留 Main/Host |

## 3. 工作单元、正文与历史

| 对象 | 身份和顺序 | 当前语义 | 缺口/验证点 |
|---|---|---|---|
| 人工工作单元 | renderer 以真实 `message.started{role:'user'}` 开 turn；`origin` 标识引擎自开轮次 | `chatTurn.ts:100-120`；`runtimeEvents.ts:310-346` | 工具结果不能当新用户请求；迟到 origin/归属用 F05 验证 |
| Response | live `messageId`；可带 `transcriptId` 对应历史 | `message.started`；`sessionHistory.ts:261-300` | 多个 block 可同 messageId，不得按 response id 丢块 |
| Block | `messageId + blockId`；历史块有稳定派生 id | `message.delta`、`thinking.*`；`chatSessions.ts:2086-2121` | 不同 seq 的相同文本增量必须保留；同 seq 重放不得重复 |
| live delta | `message.delta{text}` 是增量，不是完整快照 | `runtimeEvents.ts:349-357` | 无关键词过滤，不按文本去重 |
| 完整 assistant 帧 | 没有顶层 assistant snapshot RuntimeEvent；SDK 在 Host 内处理完整帧，DSH 耐久消息只补流式缺口 | `sdkSessionRuntime.ts:1737-1849`；`dsh-host/bridge/liveEvents.ts:1270-1292` | AC-10 必须测真实 Host 适配，不能只写 reducer 假想 snapshot |
| 恢复 | `session.resumed(requestId) → session.history(同 requestId) → session.status` | `WorkerManager.ts:3937-3966`；`runtimeEvents.ts:1123-1169` | 没有独立顶层 restore/snapshot 事件；旧历史经稳定 h: id 和 replay merge 衔接 |
| 历史页 | `initial/refresh/older/branch`，older 还校验 offset | `chatSessions.ts:1796-1894` | 重放、分页、刷新、断连补洞分别验证，不混为“再渲染一次” |

已确认 DEF-005：重复 `message.started` 当前会清空 blocks。
已确认 DEF-006：renderer 当前没有按 Main seq 识别同一传输事件，重复 delta 会重复追加。两者由 #11 前置整改。

## 4. 工具、授权、问题与终态

| 主题 | 协议字段/规则 | 证据 | 降级与验收 |
|---|---|---|---|
| 工具身份 | `messageId + toolCallId`；同名同参数不是身份 | `runtimeEvents.ts:390-410,466-481` | F04 两个不同 call id 必须保留两次真实执行 |
| 参数流 | `tool.started/updated.input`；流式时可为 redacted summary，完整参数后替换 | `runtimeEvents.ts:375-409,1181-1222` | 参数未完整不能误批准或伪造 diff |
| 结果 | `tool.completed{ok,output,error}`；结构化 details 可带 refused/notStarted/stopped/outcomeUnknown/backgroundJob | `runtimeEvents.ts:412-481` | 不用关键词推断拒绝/停止；未知不标成功 |
| 实时输出 | `tool.output.tail` 是有界全量尾部快照，`omittedBytes/totalBytes` 表示截断 | `runtimeEvents.ts:483-513` | 每次替换旧 tail，不能当 delta 追加；界面须说明显示边界 |
| 权限 | `permissionId`；decisions、detail、sessionGrantScope、timeoutMs、autoReason 均来自 Host | `runtimeEvents.ts:719-832,1013-1030` | 只展示真实按钮和期限；resolved 才退休；重复提交须权威幂等 |
| 问题 | `questionId`；每题可用稳定 id，答案键 opaque | `runtimeEvents.ts:835-899,1033-1066` | 不按问题文本去重；取消/拒绝/回答分开 |
| 停止 | `session.stopped` 可带 no_active_turn/forced 等原因；工具 details 另有 stopped/notStarted | `runtimeEvents.ts:928-978` | 用户停止、策略拒绝、执行失败和未知不能合并 |

F01 额外固定“结果先于调用”序列，用于 #3 核实暂存/关联；构造夹具本身不声称当前已支持。

## 5. 重试、后台与用量

| 主题 | 当前协议 | 引擎差异/限制 | 验收约束 |
|---|---|---|---|
| Provider retry | `session.status.payload.retry`：attempt、maxRetries、delayMs、retryAt、attemptStartedAt、delegationId | DSH `llm/retry`；SDK `api_retry` | 只有 retryAt 等真实时间才倒计时；renderer 不另起循环 |
| 用户重试末轮 | Main `retryLastTurn → startTurn(mode:'retry')` | DSH 支持失败/中断后末轮；SDK 返回 `WORKER_RETRY_UNAVAILABLE` | UI 按能力降级，不硬编码统一重试按钮语义 |
| 子代理 | `subagent.activity` 以 `parentToolCallId` 为主关联，可带 `agentId`；kind 覆盖 started/text/thinking/tool/progress/status/report/resumed | DSH tracker 与 SDK TaskBoard 来源不同；SDK 独立 interruptSubagent 当前不支持 | 旧结果按 parent 归旧任务；同名代理靠 id，不靠名称 |
| 后台命令 | DSH jobs 经 session projection；与子代理不是同一对象 | `dsh-host/bridge/jobs.ts`；`backgroundTasksModel.ts` | end_turn/session.completed 不等于后台结束；跨级 children 缺失须明示 |
| Usage | `usage.updated.payload` 必须经 `buildPiUsagePayload/readPiUsagePayload`；含 turn、session、delegated、context、pending、unreported | `piUsage.ts:45-141`；DSH/SDK 各自结算 | `context.tokens:null` 是未知；pending 不当已结算；delegated 不重复加；须验证独立请求结算幂等 |
| 缓存/成本 | cacheRead/cacheWrite 按供应商口径；reasoning 是 output 子集；cost 可缺/unreported | `piUsage.ts:52-82,254-306` | 不盲目相加，不将未知显示为免费或精确值 |

## 6. 预览、窗口与文件写入边界

- `preview.requested` 由 Main 处理；预览窗 `sandbox:true`、无 preload，后台 `showInactive`，关闭清理 watcher/timer：`PreviewWindowManager.ts:60-207`。
- 独立预览窗直接 `loadFile`，不能据此宣称 Markdown/Mermaid 等已有专用渲染器；编辑器内 Markdown/PDF/Image 预览是另一路径，R3 分别验收。
- 所有 BrowserWindow 收 RuntimeEvent；桌面专用 snapshot/cursor/since API 未定位。插件 SessionLiveJournal 的能力不能直接当桌面窗口已具备。
- `FILE_WRITE` 当前无 expected-content/hash/version；DEF-004 由 #10 前置修复。root containment 不是内容基线。

## 7. 固定 F01～F08 场景

| 数据集 | 构造内容 | 首要用途 |
|---|---|---|
| F01 | thinking、正文 A/B、并行乱序结果、结果先到 | 正文独立、ID 配对、暂停/恢复 |
| F02 | 42 thinking、67 工具、8 个助手正文块，单一人工工作单元 | 默认噪声、单入口、长链回放 |
| F03 | 权限、单选/多选问题、超时/停止解决 | 待处理可达、失效与恢复 |
| F04 | 不同 seq 的“好”“好”、同命令不同 call id、重复 message.started、重复 history snapshot | 合法重复 vs 传输幂等、恢复 |
| F05 | 阶段回复后子代理仍运行，新人工请求后旧代理结果返回 | end_turn 与后台边界、归属 |
| F06 | 未闭合 fence、CRLF diff、无 EOF 换行、HTML/SVG 富文本样本 | 流式代码、差异和预览安全 |
| F07 | 恰好 10,000 事件、100 工具、1,000,000 字节工具输出 | 性能、滚动、定位和输入延迟 |
| F08 | DSH/Claude SDK 旧历史、缺少新字段、incomplete/outcomeUnknown | 多引擎与历史兼容 |

夹具只使用 `C:\work\demo`、`C:\work\legacy` 等脱敏路径，不包含私人原会话内容。F07 由确定性工厂生成，不提交 1MB 静态日志。

## 8. 当前自动验证记录

命令：

```bash
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec vitest run \
  src/shared/__tests__/pilabExperienceFixtures.test.ts \
  src/renderer/stores/__tests__/pilabExperienceReplay.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

结果：2026-10-30，2 个文件、9 个测试全部通过。

覆盖：F01～F08 确定性及 seq；F02 结构；F04 合法重复身份；F07 数量/输出量；F08 双引擎历史；F01 每个暂停/恢复边界；重复从零回放确定性；F03 待处理退休；真实 renderer reducer 的旧历史加载。

未覆盖：真实模型/Host 请求次数、Electron 界面、权限确认丢失、文件写入、性能时延。上述项目仍按台账保持待验证。
