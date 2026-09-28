# 决策 099：P1-4d 只把 DSH 自己的数据映射到渲染层现有事件：保留、简化、移出与删除的清单

日期：2026-09-28。**状态：用户 2026-09-28 批准（[决策 110](110-user-rulings-2026-09-28-batch2.md)）。** 依据：
- [决策 090](090-user-rulings-2026-09-28.md) 总原则；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) §4.2；
- [P1-4 方案 §4.4～4.7](../topics/p1-4-bridge-parity.md) 与[分片 04 §4、§5](../topics/p1-4-bridge-parity/04-turn-semantics.md)；
- 决策 [031](031-session-projection-event.md)、[047](047-tool-classification-and-plan-mode.md)、[072](072-renderer-data-channels.md)、[081](081-loop-guard-implementation-choices.md)、[085](085-model-plan-wiring-implementation-choices.md)、[088](088-permission-gate-wiring-choices.md)「留给后续」。

修订注记（2026-09-28，P1-4d2）：第 9～12 条的实现取舍见[决策 113](113-p1-4d2-commands-and-projection-choices.md)（待审批）。其中补充：隐藏的三条命令输入后也不执行，照常作为提示词发出；带附件的命令行当提示词；`/compact` 由窗口的内置行提供，菜单里不再重复列；`session.projection` 的首次快照推迟到 bootstrap 之后的第一个事件之前发。

## 规则

P1-4d 的每一项都按同一个口径定：渲染层没有别的数据源、要显示 DSH 自己的状态的，保留，只做映射；只为与 1.0.x 一致的，删除、简化或移走。提问工具另见[决策 098](098-ask-user-via-official-tool.md)。

**保留（映射 DSH 的数据）**

1. **用量**：
   - 每步 `assistant/message.usage` → 已结算的 `usage.updated`；流里的 `usage` chunk → 进行中；
   - 上下文占用取 `contextPressure`，会话累计取 `tokenUsage` 投影（`dsh-token-meter`）；
   - `costUsd` 不算：DSH 不计价，与 P1-5 的「给 0」一致。Cost 指标只在大于 0 时出现（`RunSurfaceView.tsx:346,392`），所以直接不显示。
2. **思考起止**：`block-start` / `block-end`，blockType 为 `reasoning` → `thinking.started` / `thinking.completed`（`dsh-llm/lib/types/types.d.ts:418-436`）。
3. **重试横幅**：`llm/retry` → `session.status.retry`；`llm/retry-started` → 清掉横幅。
4. **失败**：
   - `session.failed.error` 取 `LlmFailure.message`，不再是 JSON 串（`dshSessionRuntime.ts:1535-1541`，P1-1 点验 D3 的余项）；
   - `aborted{hook:'aiclient-turn-ceiling'}` → `session.completed{stopCause:'turn_limit'}`（决策 081 的交接）。
5. **直播里的工具行标志**：
   - `ABORTED_BEFORE_DISPATCH`、`TOOL_NOT_STARTED` → 未开始；
   - `error.code:'ABORTED'` → 已停止（决策 072：DSH 的 bash 不带 `meta.aborted`）；
   - 我方闸门的拒绝 → 被拒；Stop 收卡后的 cancel → 未开始（决策 088 交接）。
   - 历史投影已经按这些错误码做了（`projection.ts:604-625`）。
6. **会话改动审阅**：写 / 改文件的 `review`，改由 DSH `write` / `edit` 的差异卡元数据 `{operation, diffs:[{path, oldText, newText}]}` 生成补丁（`dsh-tool-fs/lib/index.js:570-577,722`），用 `src/shared/textDiff.ts`。
   - 不再像 1.0.x 那样在宿主里另读改动前的文件（`runtime/plugins/tools/file-change.ts`）；
   - 历史投影用同一条规则；迁移会话沿用 `meta.aiclient.piDetails.review`。
7. **通知**：
   - 非 user 来源、`form:'notice'` 的消息 → `custom.message`，customType 为 `dsh:<来源>`，样式按 P1-7 的来源表；
   - 来源为 `aiclient-loop-guard` 的收尾指令，直播和历史都隐藏（决策 081 交接）。现在投影会把它显示成系统注记（`projection.ts:525-536`）。
8. **自主回合的轮次头**：目标轮、后台任务或子代理完成唤醒的回合，首条消息投成带 `origin` 的轮次头，直播与历史一致（决策 072 第 3 条）。
9. **命令**：
   - `commands()` 取 `ctx.commands.list(agent)`，加上用户可调的技能，名字写 `<name>`（决策 101）；
   - 隐藏 `/plan`、`/permission`（决策 047），也隐藏 `/feedback`：它只写本地日志，没有人读（`dsh-command-feedback/README.md:12`）；
   - `startSend` 里，以 `/` 开头且是已知 DSH 命令的走 `ctx.commands.execute`，不开模型回合；
   - 其余照常作为提示词发出。DSH 自己的界面会拒绝未知命令（`dsh-commands/README.md:50`），我们不拒，免得以 `/` 开头的路径被挡住。这是本决策里唯一一处刻意不跟 DSH 的地方。
10. **`/compact`**：`worker.compact` 执行 `/compact`，不带参数；`instructions` 非空就拒绝（`dsh-command-compact/README.md:36`）。
11. **`session.projection`**：
    - 事件形状照决策 031，但只转发渲染层会用的 `todos`、`goal`、`subagentCatalog`；
    - `permissions`、`sandboxMode`、`plan` 在我方组合里是常量或已关闭（决策 044、047、088），不转发；
    - bridge 合成的 `goalActivation`、`jobs`（决策 072 第 1 条）归 P1-7b。
12. **能力清单**：只报技能数。MCP 暂不做（决策 090），模板取消（决策 103），自定义子代理不加载（决策 062 / 070 的裁决）。
13. **P1-1 点验遗留**：查清「发送被拒后，同一个活着的 slot 上重复 resume、再发一个空历史页」会不会盖掉已有时间线。D4、D6 已随 P1-4a / 4b 消失，D5 随决策 095 消失。

**简化**

14. **流式工具参数**：只报字节数和行数，用 shared 现成的 `STREAMING_TOOL_ARGS_KEY` 与 `countStreamingLines`（`src/shared/streamingToolArgs.ts:26,43`）。
    - 不移植 1.0.x 从部分 JSON 里提前读出 `path` 等短字段的做法（`src/runtime/events/streamingToolArgs.ts`，依赖 pi 的 `parseStreamingJson`）；
    - 那个文件随 runtime 在 P1-12 删掉，不用搬进 shared。

**移出**

15. **`execStartedAt`**（工具计时不含审批等待，T146）移到 P1-7b：要在 `tools/execute` 上挂钩，与前台 job 对应（P1-7 实验 E1）是同一个挂点。在那之前，工具计时包含等审批的时间。
16. **每轮 model / effort、`message.started.model`、失败码**：已由 P1-5 接线完成（`fcaeb8bc`，决策 085 第 6 条），从 P1-4d 删掉。

**不在 P1-4**

17. **`reload`**：保持不支持。决策 090 去掉 pi TUI 后它没有调用方，P1-11 / P1-12 连 RPC 一起删。
18. **其余**：`preview.requested` 没有对应物，`present` 也不做（决策 073）；权限 setter 与 `permission.activity` 归 P1-6c；`subagent.activity` 归 P1-7b。

## 取舍

- 去掉的都是 1.0.x 的体验细节：
  - 费用；
  - 提前显示路径的参数摘要；
  - `/skill:` 改写（见决策 101）；
  - 转发用不上的投影 key。
- 留下的都是「DSH 自己的状态，渲染层要显示」：用量、思考、重试、失败、工具行、改动审阅、通知、目标与待办、轮次头、命令。
- 用户看得见的不同：
  - 自配了定价的模型，费用一栏不再出现；
  - 写大文件时，路径晚一两秒才显示；
  - P1-7b 之前，工具计时包含审批等待；
  - `/skill:xxx` 不再生效；`/compact` 不接受附加说明；菜单里没有 `/plan`、`/permission`、`/feedback`。
- 工作量约 8 人日，不含决策 098 的提问工具。原方案 P1-4d 约 900 行产品代码加 700 行测试。
  - 删掉、移出的，与后来补登的 072、081、088 交接大致相抵。

## 影响

- **金样本**：
  - 用量（第 1 条）和投影快照（第 11 条）会改动全部 `stream.*.json`，收口时由编排者统一重录；
  - 失败文案改动 `fail`；工具行标志改动 `stop-tool`；
  - `compact` 场景改为经 `worker.compact` 触发（现在走探针操作，`bridge-record.ts:473-476`）；
  - 新增 `think`、`usage`、`job-notice` 场景。
- **测试**：
  - `dshSessionRuntime.test.ts` 按拆出的模块分到几个测试文件；
  - `projection.test.ts` 加上隐藏 loop-guard 收尾指令、差异卡转补丁两组用例；
  - `permissionBridge.test.ts` 加上被拒与收卡后的标志；
  - 渲染层 `sessionCapabilityModel.test.ts` 随决策 104 改。
- **拆分文件后**：要用 `rg -a` 扫 `DshSessionRuntime` 的旧 import 路径，以及 `bridge-smoke` 里的直接引用（P1-4 分片 05 §5）。
