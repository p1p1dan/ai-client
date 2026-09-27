# P1-4 分片 05 · 录制门禁与改动清单

Role: detail shard。上位：[P1-4 方案](../p1-4-bridge-parity.md)。回答调研问题 7、8。我方行号指 worktree HEAD `941ab5b1`。规模都是粗估。

## 1 现成的模式可以照搬

native 这边已经有一对「录制 + 回放」测试，DSH 照这个形状做：

- **录制端**：`src/runtime/__tests__/guiEventContract.test.ts:23-40`。起真实的 RPC server、Cordis 图和工具，provider 用 faux，把 RuntimeEvent 流归一化之后写成 `src/shared/__tests__/fixtures/native*EventStream.json`。
  - 归一化规则（`:217-257`）：
    - 去掉 `seq` / `timestamp`；
    - UUID 按首次出现的顺序映射成 `id-N`；
    - epoch 毫秒换成 `<ms>`；
    - 工作区路径换成占位符；
    - `usage.updated`、`subagent.activity` 里的数字清零。
  - 更新方式：`AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run guiEventContract`。
- **回放端**：`src/renderer/stores/__tests__/nativeStreamReplay.test.ts:38-56`。把录下的流灌进真实的 reducer，断言用户最终看到的内容。
- **无界面驱动**：`src/dsh-host/bridge-smoke.ts:68-126` 的 `WorkerClient` 已经会按 WorkerSlot 的方式驱动桥接模式的宿主（Node IPC 加 worker RPC）。假网关是 `fake-gateway.mjs`，已有 `dsh-p0-2` 方案下的 `P0-STREAM` / `P0-TOOL` / `P0-SLOWTOOL` / `P0-APPROVAL` / `P0-CRASH` / `P0-PACED` 等场景。
- **约束**
  - 根 vitest 不能 import DSH 包：DSH 装在 `src/dsh-host/node_modules`，根目录没有。
  - 起宿主要用随包 node，约 180 MB。
  - 所以录制不能放在根 vitest 里，要作为单独的脚本和 CI 步骤。

## 2 门禁设计（P1-4e）

**三类金样本**，都放在 `src/shared/__tests__/fixtures/dsh/`：

1. `stream.<场景>.json`：归一化之后的 RuntimeEvent 流。给渲染层的回放测试用。
2. `log.<场景>.json`：场景结束时这个会话的原始 DSH 事件，用 `sessionQuery.observeSession` 读出，按同一套规则归一化。给纯投影测试当输入。DSH 升级时，这里的 diff 就是事件词表或格式漂移的第一道警报。
3. `rpc.<场景>.json`：`bootstrap`（含 `initialHistory`）、`history`、`tree`、`leaf`，以及 rewind / fork 的返回，归一化之后保存。

**脚本**：`src/dsh-host/bridge-record.ts`，由 `bridge-smoke.ts` 扩展而来，和 smoke 共用 `WorkerClient`。

- `--check`（默认）：录制之后和金样本做 diff，有差异就非零退出，并把差异打印出来。
- `--update` / `AICLIENT_UPDATE_FIXTURES=1`：重写金样本。
- `--only <场景>`：只跑指定场景。

**场景**（每行一个会话，除非另有说明）

| 场景 | 覆盖 | 假网关 | 子任务 |
|---|---|---|---|
| STREAM / TOOL / APPROVE-ALLOW / APPROVE-DENY | 现有的 P0-3 四项 | 现有 | e 骨架 |
| THINK | `thinking.started/delta/completed` | 新增：带 reasoning 块的流 | d |
| USAGE | 已结算的用量、进行中的用量、上下文占用、会话累计 | 新增：带 usage 帧 | d |
| FAIL-RETRY | 第一次请求返回 500 → `session.failed` → `mode:'retry'` → 完成；另起一次，对已完成的回合做 retry → `WORKER_RETRY_UNAVAILABLE`，而且不发任何事件 | 新增：先失败一次，再成功 | c |
| INTERJECT | 两个工具步，第一个工具执行期间 interject → `completed{interjected}`；空闲时 interject → `turnActive:false` | 复用 `P0-SLOWTOOL` | c |
| STOP | 工具执行中 Stop → `stopped`，工具行 `stopped`；流式中途 Stop → 半截正文落盘，并标 incomplete | 复用 | a / d |
| IMAGE | 带一张 PNG 的发送 → 回显带附件元数据；历史里也有；超限附件被拒 | 新增：回显收到的图片块数 | c |
| QUESTION | `user-questions/request` 出卡、回答、跳过 | 需要先进入 plan 模式，或者用测试插件直接调用 `ctx.userQuestions.ask`（推断，P1-4d 定） | d |
| COMPACT | `/compact` → 摘要行；`instructions` 非空时被拒 | 复用摘要回复 | d |
| JOB-NOTICE | 后台 bash 结束 → 通知 → 唤醒出一个合成回合 | 复用 P0-2 的后台任务场景 | d |
| TODO-GOAL | `todo_write`、`/goal` → `session.projection` 事件 | 复用 P0-2 的 goal 场景 | d |
| CRASH-RESUME | 工具执行期间 SIGKILL 宿主 → 重启 → `bootstrap` 的 `initialHistory` 里有中断注记和 `outcomeUnknown` | 复用 `P0-CRASH` / `P0-SLEEPTOOL` | a |
| REWIND | 回退到第 1 条用户消息和第 2 个助手步；树里出现旧分支；再次回退到旧分支上的节点；桩里有 lineage | 复用 | b |
| FORK | fork → 子桩；目标 slot 恢复；accept；discard 分支里标记和桩都被清掉 | 复用 | b |
| READ-PAGE | 宿主只读分页，冷会话和活会话各一次，都不改盘（前后字节数和锁状态一致） | 复用 | a |

**归一化**（在 native 那套规则之上补充）

- DSH 的 `MessageId`、工具调用 id（假网关给的 `toolu_<uuid>`）、`attachmentId`（sha256）、`retryId` → 按首次出现映射成 `id-N`。
- 本身就确定的保持原样：DSH 会话 id（`aiclient-<逻辑 id>` 或 `.rN`）、直播消息 id（`dsh-…-t<n>-s<m>`）、requestId 和 attemptId（由脚本指定）、回合号和 step 号。
- 路径：`<scratch>`、`<workspace>`、`<dsh-home>`、`<outside>`（smoke 已经在做 `<scratch>`，`bridge-smoke.ts:265`）。
- 时间：事件的 `time`、`retryAt`、`attemptStartedAt`、`execStartedAt`、历史里的 `timestamp` / `settledAt` → `<ms>`；`delayMs` 保留（由脚本控制）。
- 用量数字清零，只保留形状。
- **分块合并**：同一个 (messageId, blockId) 下连续的 `message.delta` / `thinking.delta` 合并成一条（P0-3 实测 20 块只收到 17 条 delta，合并和时序有关）；同一个 toolCallId 下连续的流式 `tool.updated` 只保留最后一条。增量的「条数」另做 smoke 断言，比如 ≥10。
- 如果事件在不同来源之间的交错顺序不稳定（`session/event` 和 `agent/assistant-stream` 之间，以及 `permission.requested` 和 `tool.updated` 之间），就退一步，比较经 reducer 折叠之后的状态。这一点在 P1-4e 做两轮重复录制来判定。

**纯测试**（跑在根 `pnpm test` 里，不需要宿主）

- `src/shared/dshHistory/__tests__/projection.test.ts`：输入 `log.*.json`，输出和 `rpc.*.json` 里的历史、树、leaf 比对。另外有手写的小日志，覆盖每一条规则（分片 03 §1 的表，一行一例）。
- `src/renderer/stores/__tests__/dshStreamReplay.test.ts`：照 `nativeStreamReplay.test.ts` 的结构，逐个场景断言：
  - 流式正文；工具行从运行中到完成；审批卡；思考块；重试横幅；
  - 重试没有回显，但有 running；
  - 插话之后会话变为空闲，排队的消息可以发出；
  - 图片 chip；用量环；
  - 恢复之后的中断注记，以及「结果未知」的工具行；
  - 回退之后，时间线等于新的一页；fork 在侧栏里出现一个新会话。
- `src/dsh-host/bridge/__tests__/*.test.ts`：用假的 `DshBridgeContext`，前提是 P1-1 已经把 `createUserMessage` 改成注入。覆盖：
  - 重试的受理规则，拒绝时不发事件；
  - 插话的标志位，以及 cancel 调用的参数；
  - 附件被拒；
  - 回退和 fork 在每一步注入失败时的结局（分片 03 §4 的表）；
  - 桩 v1 到 v2 的读取，以及原子写；
  - `targetLogicalSessionId` 缺失时拒绝。

**CI**

- `build.yml` 的 gate 目前只在推 `v*` tag 或手动触发时运行（`.github/workflows/build.yml:3-7`）。在它的 Gate 5 之后加三步：
  1. `npm ci`（工作目录 `src/dsh-host`）；
  2. `node scripts/fetch-node-runtime.mjs`，取随包 node；这个脚本打包时已经在用（`build.yml:253`），P1-2 会把布局定下来；
  3. `out-node-runtime/node src/dsh-host/bridge-record.ts --check`，全部场景约 2～3 分钟（推断），`timeout-minutes` 相应调高。
- 另外新建 `dsh-bridge-gate.yml`：推送到本分支或手动触发时，只跑上面这组加上 `pnpm test` 的相关文件。**推送分支之前需要用户确认。**
- 开发机上跑录制前，先 `free -m` 确认可用内存大于 800 MB；一次只起一个宿主；不要和全量测试、Electron 同时跑。
- **重录规则**
  - 只在 P1-4 收口和升级 DSH 时重录，并且要人读 diff；一个字段消失，就意味着 GUI 不再收到它。
  - 并行代理不要各自重录，按「金样本重录只在收口做」的惯例，由收口的人用 `--only` 逐个场景重录。

## 3 GUI 点验（退出判据的后一半）

- 沿用 P0-3 的配方：隔离的 HOME、假网关、CDP 驱动（`evidence/p0-3-gui-2026-09-25/tools/p0-3-gui.mjs`）。
- 场景（每个截图，落到 `evidence/`）：
  1. 重开一个有历史的会话；
  2. 宿主被杀之后自动恢复，看到中断注记；
  3. 在树对话框里回退、再回到旧分支；
  4. fork；
  5. 失败之后点「继续」；
  6. Ctrl+Enter 插话；
  7. 发图；
  8. 用量环；
  9. `/compact`；
  10. 侧栏只读预览，不起 slot，日志不变。

## 4 改动清单（按子任务、按文件）

**P1-4a 历史投影与只读回放**（约 900 行产品代码 / 800 行测试；依赖 P1-1，`readPage` 依赖 P1-3）

| 文件 | 改什么 | 约 |
|---|---|---|
| `src/shared/dshHistory/types.ts`（新） | 最小的 DSH 事件、消息类型，不 import DSH 包 | 90 |
| `src/shared/dshHistory/projection.ts`（新） | 分片 03 §1 的全部规则；通用分页（从 `piSessionTimeline.ts:522-551` 移过来，原处保留 re-export） | 380 |
| `src/shared/dshHistory/tree.ts`（新） | 单会话链、leaf；跨 lineage 合并留给 b | 120 |
| `src/dsh-host/bridge/historyCache.ts`（新） | 先订阅再 `observeSession`、增量折叠、分页、leaf | 140 |
| `src/dsh-host/bridge/dshSessionRuntime.ts` | `bootstrap` 返回 `initialHistory` 和 leaf；实现 `history()` / `tree()`；监听的注册移到 agent 级 ctx | 60 |
| `src/dsh-host/bundle/lib/bridge.js` 或 P1-3 之后的 `bridge/plugin.ts` | `inject` 加上 `sessionQuery`、`sessionProjections`；宿主操作 `readPage` | 60 |
| `src/main/ipc/chat.ts`、P1-3 的 supervisor | DSH 行的只读预览改走宿主 `readPage` | 60 |
| `src/shared/types/sessionHistory.ts`、`runtimeEvents.ts` | 给 tool_result 和 `ToolOutcomeDetails` 加 `outcomeUnknown`（历史这边先用上） | 10 |
| 渲染层 `chatSessions.ts`（映射）和工具行 | 透传 `outcomeUnknown`；加文案 | 30 |

**P1-4b 回退、fork 与树**（约 650 / 550；依赖 a）

| 文件 | 改什么 | 约 |
|---|---|---|
| `src/dsh-host/bridge/stub.ts`（新，从 P1-1 的桩读写里抽出来） | 桩 v2、lineage、原子写、读 v1 桩 | 80 |
| `src/dsh-host/bridge/lineage.ts`（新） | 边界计算；回退的 7 步；fork 的 6 步；`.staged` 标记 | 280 |
| `src/shared/dshHistory/tree.ts` | 跨 lineage 合并；冷读缓存的接口 | 100 |
| `src/dsh-host/bridge/dshSessionRuntime.ts` | `rewind` / `fork` / `acceptFork` / `discardFork`；指针切换之后，监听和缓存的 bootstrap 结果都要切到新 id | 80 |
| `src/shared/types/workerRpc.ts` | `WorkerForkPayload.targetLogicalSessionId` 和校验 | 15 |
| `src/main/services/agent-host/WorkerManager.ts` | fork 的铸 id 挪到 RPC 之前，并随请求下发 | 15 |
| `src/renderer/components/chat/SessionTreeDialog.tsx`、i18n | 回退说明文案改成与引擎无关的说法 | 10 |
| P1-3 的清理接口 | 引用集合按 lineage 展开（分片 03 §6），在 P1-3 那边实现 | （P1-3） |

**P1-4c v1.0.3 语义**（约 350 / 450；依赖 a；D3 需要先拍板）

| 文件 | 改什么 | 约 |
|---|---|---|
| `src/dsh-host/bridge/dshSessionRuntime.ts` | `interject` 与 `turnActive`；在 `step/end` 上 cancel(hook)；`turn/end` 映射 `interjected`；重试的受理与续跑；替换掉 P1-1 的两个安全桩 | 170 |
| `src/dsh-host/bridge/attachments.ts`（新） | 文本附件并进正文；图片走 admit；错误映射；回显元数据 | 120 |
| `src/dsh-host/bridge/sources.ts`（新） | 声明 `aiclient-retry` 这个 source kind（类型合并加常量） | 20 |
| `src/shared/dshHistory/projection.ts` | 隐藏续跑提示和错误占位的规则；`stopCause` 映射 | 40 |

**P1-4d 其余事件**（约 900 / 700；依赖 a；费用、路由、失败分类依赖 P1-5）

| 文件 | 改什么 | 约 |
|---|---|---|
| `src/dsh-host/bridge/*.ts`（把 `dshSessionRuntime.ts` 拆成 stream / tools / usage / questions / commands / projections 几个模块） | 分片 04 §4、§5 的全部项 | 700 |
| `src/shared/streamingToolArgs*` | 摘要的生成端从 `runtime/events/streamingToolArgs.ts` 移过来，runtime 那边改成 re-export | 40 |
| `src/shared/types/runtimeEvents.ts` | 新增 `SessionProjectionEvent`（D7）；更新 `RuntimeEventDraft` | 40 |
| 渲染层 reducer | 暂时忽略 `session.projection`，消费归 P1-7；如果 D7 选 B，这里不用改 | 10 |
| i18n | 通知、命令结果、「结果未知」的中英文案 | 20 |

**P1-4e 录制门禁**（约 700 行，另有金样本；骨架和 a 同批，各子任务各自补场景，CI 接入在收口）

| 文件 | 改什么 | 约 |
|---|---|---|
| `src/dsh-host/bridge-record.ts`（新） | 场景、归一化、check / update | 420 |
| `docs/…/tools/fake-gateway.mjs` | 新增 THINK / USAGE / FAIL-RETRY / IMAGE 等回复 | 150 |
| `src/renderer/stores/__tests__/dshStreamReplay.test.ts`（新） | 渲染层回放 | 250 |
| `src/shared/dshHistory/__tests__/*.test.ts`（新） | 投影金样本和单条规则 | 300 |
| `.github/workflows/build.yml`、`dsh-bridge-gate.yml`（新） | CI 步骤 | 50 |

**合计**：产品代码约 3000～3500 行，测试约 2500～3000 行，4～6 人周（粗估）。并行时，按「同时跑测试的代理 ≤ 2」的规矩，b 和 c 可以同时做，d 放在其后，或者与 b 并行、和 c 错开。

## 5 改名、删除之后要 `rg -a` 扫的旧标识符

- `dshSessionRuntime.ts` 拆分之后：扫 `DshSessionRuntime` 的旧 import 路径，以及 `bridge-smoke` 里的直接引用。
- 摘要生成端搬家之后：扫 `runtime/events/streamingToolArgs` 的 import。
- 分页函数搬家之后：扫 `paginatePiSessionHistory` 的调用方（`SessionReplayReader.ts:50-52`、`piSessionTimeline.ts`、native runtime）。
- 静态守卫：`retiredSurfaceAbsence.test.ts` 禁止出现 `/extension[_-]?ui/i`，新 bridge 代码要避开这个词；`agentWireStatic` 的 AST 扫描覆盖 `src/dsh-host`，禁止对 agent 字段写字面量缺省（P1-1 inventory §3）。
