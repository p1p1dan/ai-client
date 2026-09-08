# Evidence — A2 会话内轮级用量汇总

**日期**：2026-09-08 · **分支**：`feat/model-catalog-admin` · **环境**：Linux 6.12.94，本机小服务器（资源受限）。

## 前置取证：pi 的 `turn_end` 是否携带子代理用量增量？

**结论：`message.usage` 里没有；但存在另一条明确的通道 `toolResults[].usage`，
且 SDK 明说它不在主账里，因此它天然就是增量。**

取证来源是**本机 `node_modules` 里实际安装的 SDK 声明**，不是 PI-Desktop 的形状：

1. `@earendil-works/pi-agent-core/dist/types.d.ts`（`AgentEvent` 联合）：

   ```ts
   { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
   ```

   **只有这三个字段**，没有任何子代理用量增量字段。

2. `message.usage` 是**父代理自己那次 provider 调用**的账。子代理跑在随包 opt-in 扩展
   `@gotgenes/pi-subagents` 自己的 agent loop 里，它的 token 不会出现在父代理的 assistant message 上。

3. `@earendil-works/pi-ai/dist/types.d.ts` 的 `ToolResultMessage`：

   ```ts
   /** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
   usage?: Usage;
   ```

   `AgentToolResult` / `AfterToolCallResult` 上有同一字段和同一句注释。
   **「not part of main LLM context accounting」是决定性的**：它保证这笔钱没有被算进父代理的数字，
   所以在汇总里加一次是正确的，而加进任何单条消息都是错的。

4. 我们自己的 `src/agent-host/subagentProjection.ts` 白名单投影**完全不含**任何 usage/cost 字段
   （已 grep 确认），所以子代理花费也不会从那条路走过来。

**对 roadmap 口径 4 的落实**：按增量并入汇总，**不并入任何单条消息**，
并且用**独立计数器** `toolResults` 与 `turns` 分开记，这样界面能说出「多少是委派出去花的」。

> 附带说明：`@gotgenes/pi-subagents` 本身**未安装在本机**（`src/agent-host/node_modules` 不存在，
> 本机资源受限没有装 agent-host 依赖树）。上面第 3 条是 pi SDK 的**协议层**取证——
> 无论哪个扩展实现子代理，它要把花费报出来只有这一个字段。
> **未取证项**：`@gotgenes/pi-subagents` 是否**实际填写**了这个字段。若它不填，
> 汇总里的 `toolResults` 恒为 0，其余数字仍然正确——降级方向是安全的。

## 落地

| 文件 | 改动 |
|---|---|
| `src/shared/piTurnRollup.ts` | 新建：`initTurnRollup` / `applyTurnUsage` / `viewTurnRollup` / `readSessionUsage` |
| `src/shared/piUsage.ts` | `PiUsagePayload` 新增可选 `session`；`buildPiUsagePayload` 第三参；`readPiUsagePayload` 回读 |
| `src/agent-host/piWorkerSession.ts` | 新增 `turnRollup` 字段；`turn_end` 臂折叠 turn usage 与 `toolResults[].usage` |
| `src/renderer/components/workspace-shell/surfaces/runPanelModel.ts` | 视图模型新增 `sessionUsage` |
| `src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx` | 新增「本会话累计」分组 |
| `src/shared/i18n.ts` | 六条中文标签 |

**符号命名**：roadmap 写的是 `init()` / `apply(state, usage)` / `view(state)`。
实际导出为 `initTurnRollup` / `applyTurnUsage` / `viewTurnRollup`——同一组函数，
只是在 `@shared/piTurnRollup` 这种被跨模块导入的位置，裸 `init`/`apply`/`view` 在调用点读不出含义。

## 三条口径的落实

1. **单条消息的 usage 永不被改写。** 汇总是 payload 上的**兄弟字段** `session`，
   顶层字段仍是 provider 报的原值。臂：`never writes back into the usage it was handed`
   （逐字段 `toBe` 比较前后）＋ worker 层 `payload.output` 仍是 480 而 `session.output` 是 5480。
2. **两个数字分别标注。** Run 面板是**两个独立的 `border-t` 分组**，
   下面一组每个标签都带 `(session)` / 「本会话累计」。**没有任何一处叫「Total」**。
   臂：`keeps the session total separate from the last turn`。
3. **只做加法。** `costUsd` 是 pi 每轮算好的值求和，没有任何单价换算。

## 五条判据的对应用例（`src/shared/__tests__/piTurnRollup.test.ts`）

| roadmap 判据 | 用例 |
|---|---|
| 多轮相加得到正确总数 | `adds turn after turn into one total` |
| `apply` 不改变状态时返回同一引用（`Object.is`） | `returns the SAME state when an event changes nothing`（用 `toBe`） |
| 缺字段的 usage 不污染累加 | `lets a partial usage contribute what it has and nothing else` |
| 会话切换后归零；同一 worker 复用不串号 | `starts from zero for a new session and cannot inherit another one` |
| 汇总永不写回单条消息 | `never writes back into the usage it was handed` |

「不改变状态返回同一引用」覆盖四种情形：`usage` 为 null、为 undefined、**属于别的会话**、
以及每一列都为零。第三种是真正的安全条件——一旦并入就再也减不回来了。

**结构上的额外保障**：`PiWorkerSession.logicalSessionId` 是 `readonly`，一个实例对应一个逻辑会话；
`reload()` 走 `switchSession` 时还有 `WORKER_RELOAD_IDENTITY_MISMATCH` 挡着换文件。
即便如此，`sessionId` 仍然放进了 rollup 状态里而不是只当参数——
「不变量成立是因为调用方恰好这么写的」正是最容易失效的那种论断。

## 未做（按计划）

- **不落盘。** A2 第一版只在内存与事件流中存在，`turnRollup` 随 worker session 生命周期存亡。
  持久账本是 roadmap 里 Deferred 的 A2-b。
- 跨会话历史与热力图看板不在范围（README「明确不做」）。

## 门禁执行记录

| 门禁 | 命令 | 结果 |
|---|---|---|
| lint | `node_modules/.bin/biome check <24 个改动/新增文件>` | **通过**，`Checked 24 files. No fixes applied.` |
| typecheck | `NODE_OPTIONS=--max-old-space-size=1200 node_modules/.bin/tsc --noEmit` | **通过**，无输出 |
| typecheck (agent-host) | `node_modules/.bin/tsc --noEmit -p src/agent-host/tsconfig.json` | **通过**，无输出 |
| test | `node_modules/.bin/vitest run src/shared/__tests__/ src/agent-host/__tests__/piWorkerSession.test.ts src/renderer/components/workspace-shell/__tests__/ src/renderer/components/chat/__tests__/piModelCatalog.test.ts src/main/services/piModelConfig/__tests__/ scripts/__tests__/ --maxWorkers=1 --no-file-parallelism` | **通过**，55 files / 801 tests，12.46s |

该批次同时覆盖 A1 与 A3，是三项合并后的回归批。

## 未跑到的门禁（如实记录）

- **未跑整套 `pnpm test`**。只跑了上述六个目录/文件的批次。本机资源受限，按 roadmap 小批次约定；
  整套回归以 CI 为准。
- **未跑 `pnpm lint`（全仓）**，只对改动文件跑了 `biome check`。
- **未跑任何生产构建**。
- **未启动 Electron GUI**。`RunSurfaceView.tsx` 的「本会话累计」分组没有渲染层自动化覆盖。
  待点验项：Run 面板出现两个分组、上面标「上一回合」下面标「本会话累计」；
  多轮对话后累计数字递增而「上一回合」只反映最后一轮；有工具委派时回合数显示 `n + m 次委派`。
  按 roadmap 并入 [UI 对齐计划](../../pix-ui-alignment/README.md) 的累计点验。
- **未用真实 pi runtime 跑过一轮真实对话**。worker 层的臂用的是 `createPiSdkStub`，
  投喂的是按 SDK 声明构造的 `turn_end` 事件。**真实 provider 的 `toolResults[].usage` 是否真的被
  子代理扩展填写，未经实测**（见上面「未取证项」）。
