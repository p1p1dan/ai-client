# Evidence — U06-a Run 面板 + U07 Context 内容增强（批次 6）

**日期**：2026-09-04
**分支**：`feat/pi-primary-backend`
**切片**：U06-a（Run 面板渲染层可拼部分）、U07（Context 面板内容增强）
**执行计划**：[execution-plan §三 批次 6](../topics/execution-plan.md)
**取证前提**：[evidence-q04](../topics/evidence-q04-runtime-fields.md)（占用/usage 需 Pi runtime 补，归 T38）
**新决策**：[D05](../decisions/005-two-column-run-surface.md)（双栏 rail 扩到 Context + Run）

## 一、U06-a — Run 面板

### 新增了什么

一个新的右栏面板 `run`，报告**当前对话正在做什么**：状态、模型、思考档、回合耗时、正在执行的工具。
数据全部来自渲染器已有的来源（会话 store、`useMessageMetadata`、`useSessionEffort`、`turnSendStatus`），
没有新增 IPC，也没有动 runtime——这是本计划的边界。

- `surfaces/runPanelModel.ts`（纯函数，node-env vitest 可跑）：状态映射、工具事实、时钟、模型出处。
- `surfaces/RunSurfaceView.tsx`：只做排版。
- `surfaceRegistry.ts` / `surfaceIcons.ts` / `surfaceViews.tsx`：注册 `run`（图标 `activity`）。

### 三个实现判断

**① 状态映射用 `Record` 而不是 switch。**
`STATUS_PRESENTATION: Record<SessionRuntimeStatus, …>` 是一张全映射表：
将来加第十个运行时状态会**编译失败**，而不是被 `default` 静默画成「空闲」。
这是验收①「覆盖全部 9 个值」能长期成立的形式，比一条枚举测试更硬。

`running` 之上再叠一层 `activity`：有未结束的工具调用 → 「正在执行工具」；
最后一个块是 thinking → 「思考中」；否则「运行中」。原始 `status` 字段照原样保留、不被改写
（与 Context 面板同一条规矩），headline 是**另一个**字段。

**② 跨会话串数据的防线放进纯函数里。**
`turnSendStatus` 是单槽而非按会话分表的 store。视图把整个快照原样传给
`deriveRunPanelView`，由它比对 `sessionId` 后决定丢弃——所以「会不会串」这件事有一条可跑的测试，
而不是散在视图里的一行 `&&`。

**③ 工具计数只算最后一个 assistant 回合。**
面板描述的是「这一回合」，会话级累计计数会一直涨却声称在描述当前回合。
「正在执行」的判定是 `tool_call` 有而对应 `tool_result` 没有——正是 store 折叠
`tool.started` / `tool.completed` 的那对 id。

### 验收对照

| 验收 | 结果 |
|---|---|
| ① 状态机映射覆盖 `SessionRuntimeStatus` 全部 9 个值 | ✅ 全映射 `Record`（漏一个即编译失败）+ `runPanelModel.test.ts` 遍历九值断言 headline/tone |
| ② 无 usage 数据时占用区不渲染空壳 | ✅ 视图**根本没有**占用区；`RunPanelView` 上不存在 `usage`/`contextWindow`/`contextPercent`/`tokensPerSecond` 任何一个字段，测试逐个断言其不存在 |
| ③ 会话切换与 stale 事件下不串数据 | ✅「drops a turn snapshot that belongs to another session」——退回本会话自己的上一回合耗时，`elapsedLive` 为 false、`phase` 为 null |

### 挂载位与双栏可见性

三栏 rail 变成 `git | files | context | run`，`Ctrl/Cmd+4` 由 run 接手——这个数字位是 2026-09-04
终端下线时空出来的，**前三位没有移动**。已有用户的持久化 `railOrder` 里没有 `run`，
`sortSurfaces` 会把它补在末尾，可见位置与新装一致。

双栏下**可见**，理由与后果见 [D05](../decisions/005-two-column-run-surface.md)。

## 二、U07 — Context 面板内容增强

### 范围是本次定的（roadmap 原标「Scope 待细化」）

pi-app 的 context 面板读的是**会话文件的 context 条目**（system prompt、压缩摘要、每条工具结果），
背后是它自己的 `context.preview` IPC。本仓没有这条通道，加一条就等于改 runtime——超出本计划边界。

所以本切片的数据源是**这个窗口已经加载的消息**，并且措辞上处处说明这一点：
分组标题是「对话构成（已加载）」，摘要行是「本窗口 N 条消息 · M 字符」。
它是对**已加载记录**的诚实描述，不是对模型上下文窗口的读数——被压缩掉的回合、
本窗口没收到的 system prompt，都不在里面。

### 做了

- **分角色构成**：user / assistant / system / error 各自的字符数与占比，按体积排序。
  这是时间线**看不到**的信息（时间线只按时间顺序展示内容）。
- **逐段展开**：每条消息一行（角色 · 工具数 · 首行预览 · 体积），点开看正文，
  正文上限 2000 字符、被截断时明说。展开状态按 messageId 存，切会话时清空。

### 没做，以及为什么

- **token 估算**：execution-plan 已写明「估算部分随 U06-b 一起解锁」。
  `字符数 / 4` 这种估算印成 `~1.2k tok` 会看起来像运行时报的数，而它不是。
  面板显示**字符**，等 T38 的真实 usage 落地再谈 token。
- **手动刷新按钮**：pi-app 需要它是因为它的 preview 是一次性快照拉取。
  本仓这份数据来自实时 store，随消息自己变——放一个刷新按钮是装饰，
  与「不放空壳」的既有规矩相悖。等真有 session-file 预览 IPC 时再谈。

### 性能

字符统计带一层 `WeakMap<ChatBlock, number>` 缓存。store 在流式增量时会重建消息的 `blocks` 数组，
但**复用**没动过的块对象，所以一个带兆级工具输出的回合只量一次，而不是每个 token 量一次。
无法序列化的工具载荷（循环引用）计为 0 而不是抛错——未知的体积不猜。

## 三、门禁结果

按 [baseline test-and-release-gates](../../../baseline/test-and-release-gates.md) 串行：

1. **Vitest**（`--maxWorkers=1 --no-file-parallelism`）：全仓 **264 files / 4130 tests pass**。
2. `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck`：pass。
3. `pnpm typecheck:agent-host`：pass。
4. `pnpm exec biome check`：改动文件干净（1 处 `useExhaustiveDependencies` 用 biome-ignore 明示——
   `activeSessionId` 是重置**触发器**，不是函数体读取的值）。
5. `git diff --check`：干净。

### 变异验证

| 变异 | 结果 |
|---|---|
| `deriveRunPanelView` 去掉 `turnSend.sessionId === sessionId` 比对 | 「drops a turn snapshot that belongs to another session」转红 |
| `measureBlock` 去掉 `toolInput` 计量 | 「sizes each message from every block it carries」转红 |

### 顺带更新的既有断言（4 个文件、13 条）

`run` 上 rail 改变了三处被测死的事实，都按新事实更新并写明理由：

- `surfaceRegistry.test.ts`：注册数 11 → 12（openchamber 没有 `run`，本仓的注册表不是它的冻结副本）；
  rail 集合加 `run`；两栏集合 `['context']` → `['context','run']`。
- `shellShortcuts.test.ts`：`Digit4` 从「不绑定」变成 run；两栏下 `Digit2` 绑到 run。
- `panelTabsModel.test.ts`：tab 顺序与两栏收敛集合同步。
- `surfaceRegistry.test.ts` 的 `WIRED` 列表加 `run`——该列表与 `pendingTask` 是 IFF 关系，
  漏改任一边都会失败，这正是它存在的目的。

## 四、欠项

- **GUI 点验未做**：Run 面板与 Context 新分区都还没在真窗口里看过，与既有的待做点验合并一次 CDP 出图。
- **U06-b 仍挂起**：占用 donut、usage 行、tok/s 等 Pi 计划 T38 的 `usage.updated` 生产者与
  `contextWindow` 暴露落地。本次刻意不留占位。
- **U07 的「真上下文」版本**：需要 `context.preview` 对应物（Main/worker 侧新 IPC），不在本计划边界内。
