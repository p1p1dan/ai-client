# 决策 086：P1-16 前置搬迁（skills、模板、MCP 进 `src/shared`）的实现取舍

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 090](090-user-rulings-2026-09-28.md)）。** 依据：`36df9ac9`；[P1-10 / P1-16 方案](../topics/p1-10-p1-16-extensions.md)的分片 03、04；先例 P1-6a（`16c8ef16`）、P1-9a（`6ce354c5`）。

## 规则

1. **`settingSources` 整份搬进 shared。** 方案没有提到这一项。P1-6a 的先例是只给共享库传算好的布尔值，这里没有照做。
   - 原因：MCP 与 skills 有 6 个公开入口直接接收 `settingSources` 和 `projectTrusted`，`McpServerConfig.scope` 的类型本身就是 `SettingSource`。
   - 改成传布尔值，要给每个入口各包一层，现有调用方和测试也都得改。
2. **MCP 比方案多两个文件：`connect.ts` 和 `errors.ts`。**
   - `connect.ts` 负责连接编排：并行启动、共用计时、握手竞速，以及 3 个超时常量。P1-16b 要求「并行连接，预算与超时同 1.0.x」，用的就是这段逻辑。
   - 子进程由调用方注入的 `McpProcessLauncher` 启动。
   - `errors.ts` 提供可注入的错误工厂，照 P1-6a 的写法；runtime 注入 `RuntimeHostError`，所以错误码不变。
3. **MCP 客户端没有改成吃 Node 双工流**（方案写的是「吃抽象的双工流」）。
   - 沿用 1.0.x 原有的端口 `{write, exited, kill}`，stdout 由起进程的一方调 `receive()` 推进来。
   - 原因：改成 `Duplex` 会改变分帧和背压行为。
   - 接到 DSH `ctx.subprocess` 的适配留给 P1-16b，形状等实验 E5 再定。
4. **skills 比方案多一个 `catalog.ts`**，内容是根目录规则、目录扫描与重扫、正文读取上限。
   - 这些原来都在 runtime 的 `skills/index.ts` 里。P1-16a 的兼容报告、P1-16c 的模板目录都要用 1.0.x 的这套规则，不搬的话，P1-12 删 runtime 时会一起删掉。
5. **测试拆成两半，一半搬、一半留。**
   - 纯逻辑用例搬到 shared：skills 36 例、MCP 19 例，用例体不改。
   - 依赖 runtime 的用例留在原文件：skills 12 例、MCP 22 例。
   - 拆分之前，先用一行未改的旧测试跑了搬迁后的代码，431/431 通过，作为「旧用例原样跑」的证据。
6. **过闸值、参数预览和结果标注也搬进 shared**：`mcpPolicyValue` 取值为 `server:tool`，`mcpArgumentsPreview`、`foldMcpToolResult` 同理。这样 P1-16b 过闸时，产出的值和预览与 1.0.x 的授权记忆完全一致。

## 留给后续

- **子代理目录规则**（`plugins/subagent/catalog.ts`）这次没搬。它属于 P1-16d，但 P1-12 删 runtime 之前必须搬完。
- **真实 stdio 夹具** `runtime/__tests__/fixtures/mcp-echo-server.mjs` 还留在 runtime 里，P1-12 之前要移走。
- shared 客户端仍以 `aiclient-runtime` 自报名字。`workerSlotBudget` 的「每个槽位的份额 × 槽位数」在一个宿主（决策 019）下是否还适用，由 P1-16b 定。
