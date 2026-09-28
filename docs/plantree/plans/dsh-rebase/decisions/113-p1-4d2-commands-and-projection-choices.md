# 决策 113：P1-4d2 命令与状态的实现取舍：菜单、命令发送、`/compact`、`session.projection` 与能力清单

日期：2026-09-28。**状态：自主决定，待用户审批。** 依据：
- [决策 099](099-p1-4d-scope-dsh-data-only.md) 第 9～12 条、[101](101-instructions-and-skills-dsh-native.md)、[103](103-drop-prompt-templates.md)、[104](104-legacy-asset-notice-and-extension-pages.md) 第 4 条、[047](047-tool-classification-and-plan-mode.md) 第 3 条、[031](031-session-projection-event.md)、[072](072-renderer-data-channels.md)（均已由[决策 090](090-user-rulings-2026-09-28.md) / [110](110-user-rulings-2026-09-28-batch2.md) 批准）；[决策 106](106-p1-4d1-live-mapping-choices.md) 第 1、2、32 条；
- [P1-4 / P1-16 重划](../topics/p1-4-p1-16-rescope.md) 4d-10、4d-11、4d-13、4d-16 与 §5 的 P1-4d2 行；[P1-7 分片 03 §0](../topics/p1-7-renderer/03-panels.md)（渲染层的数据契约）；
- `dsh-commands/lib/index.js`（`parseCommand`、`execute` 先同步写 `command/run`）；`dsh-command-compact/lib/index.js`；`dsh-command-goal/lib/index.js`；`dsh-tool-skill/lib/index.js`（`/name` 手势与查找参数）；`dsh-session-projection/lib/index.js`（`snapshot`、`onChanged` 在投影驱动里同步回调）；`WorkerManager.handleWorkerEvent`（slot 就绪前丢弃事件）。

改动留在工作区，由编排者复跑后提交。下面是 099 没有写死、由本次实现定下的地方。

修订注记（2026-09-28，P1-7a）：第 12 条留给 P1-7 的补水已由 `worker.panels` 落地（渲染层在 `session.resumed` 与首次显示无数据的会话时问一次）；第 4 条说的回合进行中执行命令由 `worker.command` 带外执行；命令的回答在直播里画成轻量行。第 19 条「命令不进历史」仍待拍板，P1-7a 没有做命令投影。见[决策 118](118-p1-7a-goal-todo-round-choices.md) 第 4～7、13、23 条（待审批）。

## 规则

### 一、斜杠菜单（`worker.commands`，099 第 9 条）

1. **命令**：`ctx.commands.list(agent)`，去掉隐藏的 `/plan`、`/permission`、`/feedback`；`/compact` 也不列，因为窗口自己的内置行已经提供它（译好的描述），并走 `worker.compact`（第 8 条）。行的 `source` 是新值 `command`，菜单按原样显示来源（与 `skill`、`builtin` 并列）。DSH 命令的 `input.hint` 不进菜单（行类型里没有这个字段，不为它加）。
2. **技能**：`ctx.skills.list({cwd: 会话目录, scope: agent})`，与 dsh-tool-skill 触发 `/name` 时的查找一致；只列 `invocation.userInvocable` 的，写裸名，`source: 'skill'`，带 `path` 与 DSH 的发现来源（`scope`，如 `user-agents`、`custom`）。
   - 与菜单里某条命令同名的技能不列：行首的 `/name` 跑的是命令，选中它不会触发技能；与 `/compact` 同名的也不列。
   - 与隐藏命令同名的技能照列：`/plan …` 会作为提示词发出（第 4 条），DSH 的 `/name` 手势就会触发这个技能。
3. 读命令或技能失败只丢那一半：技能目录读不出，菜单照样列命令。没有会话、没有服务时答空菜单（与原来一致，不报错）。

### 二、命令发送（`startSend`，099 第 9 条）

4. **什么算命令**：正文按 DSH 自己的语法（`parseCommand`：首字节是 `/`，小写名字，后面是结尾或空白）解析出的名字，是本会话 agent 已知、且不在隐藏集合里的命令，并且这次发送**没有附件**。
   - 其余一律照常作为提示词发出：未知的 `/xxx`、以 `/` 开头的路径、大写的 `/Goal`、句中的 `/goal`、隐藏的 `/plan …`。
   - **带附件的不当命令**，与窗口内置命令的既有规则一致（「`/compact` 加三个文件是一条话，不是命令」）。代价：DSH 的 `/goal <目标>` 可以带附件，我们这里带附件就变成一条提示词。文本附件要交给 DSH 命令得先有它的上传回执，我方没有这条通道。
   - Ctrl+Enter 不走命令：插话把这行字原样交给正在跑的回合。回合进行中执行命令，归 P1-7a 的 `worker.command`（决策 072 第 2 条）。
5. **选路照发送**：命令发送也先按这次的模型、强度选路，模型不在计划里照样在发出任何东西之前拒绝。理由：命令可能引出模型工作（`/goal` 开目标轮，`/compact` 要做摘要），用的就是当前选择。
6. **不开回合**：命令不占用本 bridge 的回合（`this.turn`），因为 `/goal` 建目标后，DSH 可能在命令结束前后自己开一轮，那一轮必须照常作为 DSH 开的回合处理。直播全部取自 DSH 的日志：
   - `command/run`：这次发送的 `running`，然后把这行字作为用户回显发出，带 `attemptId`（输入框靠它确认发送已被接收）。id 是 `dsh-command-<日志序号>`，正文取日志里的 `/名字` 加参数原文；
   - `command/done`：命令的回答作为通知，`custom.message`，customType 成功是 `dsh:command`、出错是 `dsh:command-error`，id 是 `dsh-command-<日志序号>`；没有文字就不发；
   - `execute` 结束后：`session.completed`（**不用 `session.failed`**：命令出错是它的回答，不是回合失败，不该出现「继续」卡），然后空闲就发 `idle`；这期间 DSH 自己开了一轮（目标轮）就重发一次该轮的 `running`，不让界面以为会话空闲了。
   - 只有 DSH 真的收下这条命令（写了 `command/run`）才会发出事件。查到之后、执行之前命令被卸掉（`execute` 答 `undefined`），这条消息改作提示词发出；收下之前就失败，是这次发送被拒。
   - 处理器抛错或被取消而 `command/done` 没到时，bridge 自己发一条错误通知。
7. **命令进行中**：再发一条是 `WORKER_SESSION_BUSY`；`rewind`、`fork`、`worker.compact`、重试同样拒绝；`busy` 为真。Stop 取消这条命令（DSH 把它结成「已取消」），答 `stopped: true`，发送随后照常结束。
   - **历史不显示命令**：`command/run`、`command/done` 在历史投影里仍然跳过，重开会话后这行字和回答都不在了；暖 resume 时这两行直播在历史里没有对应行，会按决策 106 第 32 条的 L6 被留下并排到最后。DSH 自己的界面会把命令记录显示在对话里（`/compact` 靠 `sourceEventSeq` 并进摘要行），把命令投进历史留给 P1-7a。

### 三、`/compact`（`worker.compact`，099 第 10 条）

8. **执行**：`ctx.commands.execute(agent, '/compact', [], signal)`，与 DSH 自己的命令适配器同一条路，日志照样有 `command/run`、`command/done`。不发任何直播事件（它不是发送；摘要行照旧在历史里出现）。Main 不改。
9. **拒绝与结果的错误码**：
   - `instructions` 去掉空白后非空：`WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED`（新码，定义在 `src/shared/types/workerRpc.ts`），在 bootstrap 和任何执行之前拒绝；只有空白算没带；
   - 有回合或命令在跑：`WORKER_SESSION_BUSY`（与原生运行时相同）；
   - 超过 `WORKER_COMPACT_BUDGET_MS`（45 秒，在 Main 的 60 秒之内）：取消命令，答 `WORKER_COMPACT_TIMEOUT`，可重试；
   - DSH 成功且指明了写下的摘要（`sourceEventSeq`）：`{compacted: true}`；
   - DSH 成功但没有摘要（「No compactable history yet.」）：`WORKER_COMPACT_UNAVAILABLE`，带 DSH 的原句，与原生运行时「没有可压缩的内容」同码；
   - DSH 的错误结果（忙、历史变了、摘要失败、提交失败、保存失败）：`WORKER_COMPACT_FAILED`（新码），带 DSH 的原句；
   - 宿主没有 `/compact` 命令：`WORKER_COMPACT_UNAVAILABLE`。
10. **渲染层带参数的入口**：有。内置的 `/compact <文字>` 会把文字作为 `instructions` 发给 Main。不去掉这个入口，按拒绝码提示：`runCompactCommand` 认出拒绝码，结果为 `instructions-unsupported`，输入框提示「/compact 不接受附加说明」「删掉 /compact 后面的文字，再按一次 Enter。」，文字留在输入框里。
    - 理由：是否接受参数由 worker 说了算，以后 DSH 支持参数时只改 worker。
    - 渲染层自己写出这个码的字符串（它对 `workerRpc` 只做类型导入，与 `SessionTreeDialog` 的做法相同），测试钉住它与 worker 的常量一致。

### 四、`session.projection`（099 第 11 条，决策 031）

11. **事件形状**：RuntimeEvent 新增 `session.projection {key, view}`。key 只有 `todos`、`goal`、`subagentCatalog`（`SESSION_PROJECTION_KEYS`）；view 原样是 DSH 的值：`TodoItem[] | null`、`GoalProjection | null`、`SubagentCatalogEntry[]`，与 P1-7 分片 03 §0 的契约一致，bridge 不做转换。类型在 `runtimeEvents.ts` 里各写一份镜像。
    - 渲染层现在没有消费方（归 P1-7）。核对过：`chatSessions`、`sessionActivity` 的归约对它是空操作，`SessionIndexService` 直接忽略，没有穷举到 `never` 的 switch；它不算回合活性事件。
12. **首次快照的时机**：bootstrap 结束时读一次三个 key，但**不在 bootstrap 时发**，而是在这个运行时此后发出的第一个事件之前发。原因：Main 在 slot 就绪（身份提交完）之前会丢弃 slot 发来的事件（`WorkerManager.handleWorkerEvent` 只转发抽屉期的两种答复），bootstrap 时发出的快照在产品里永远到不了渲染层。实际效果是快照排在第一个回合的 `running` 之前。
    - 回退（rewind）之后立即发子会话的快照（回退只在就绪的 slot 上做），替换掉还没发出的那份；
    - 崩溃重启、恢复会话后，快照同样等第一个事件；渲染层刷新或切会话时的补水是 P1-7 的 `worker.panels`（分片 03 §0）。
13. **变化**：订阅 DSH 的 `onChanged`，只转发本会话（子代理自己的待办不转发）、这三个 key、bootstrap 之后的变化。快照还没发时来了变化，就把新值并进快照一起发。
    - 回调在 DSH 的投影驱动里同步执行，DSH 不兜异常，所以回调自己 `try/catch`；回调里不读快照，免得把驱动还没轮到的投影提前推进。
    - 宿主没有某个投影单元，对应 key 就不出现（能力缺失），不补空值。

### 五、能力清单（099 第 12 条）

14. **只报技能数**：`capabilities: {skills: N}`，N 是这个 agent 目录里的全部技能（模型可调或用户可调都算，查找参数同第 2 条），bootstrap 时读。没有技能服务或读取失败：`{}`，即「未报告」，bootstrap 照常成功。
15. **MCP、模板、子代理不报，也不报 0**：`WorkerCapabilityInventory` 的约定是「缺席 = 没有生产者」「0 = 查过但没有」，DSH 版确实没有这三个生产者；渲染层现有字段对缺席显示「未报告」，报 0 反而会让人以为配置丢了。能力弹窗去掉这三行和 pi 扩展那句，照决策 104 第 4 条归 P1-16e；本次只给 `sessionCapabilityModel.test.ts` 加一例钉住 DSH 的清单形状。

### 六、录制与冒烟

16. **`compact` 场景**改为：两轮之后读菜单（`worker.commands`），带说明的 `worker.compact` 被拒（`rpc.compact.refused`），不带说明的完成（`compacted`，期间通道上没有事件），最后一条 `/goal` 发送（`COMMAND` 回合：回显、用法通知、完成、空闲，不开模型回合）。探针包里的 `compact` 操作已没有调用方，删除。
17. **bridge-smoke 的宿主 H** 多四项判定：菜单列出 `goal` 和裸名技能、不列隐藏与窗口自有的命令；能力清单只有 `skills`；`worker.compact` 拒绝说明；`/goal` 发送不开模型回合。

## 取舍

- 命令发送不占回合，是因为 DSH 的目标轮可能在命令结束前后就开始；占了回合，这一轮会被记在命令的 requestId 名下，结束事件也会错位。
- 快照推迟到第一个事件，而不是改 Main 在就绪后替 worker 发：本任务不动 Main，P1-7 的 `worker.panels` 本来就负责补水。代价是一个会话在第一个事件之前，渲染层不知道它的待办与目标。
- 命令不进历史，是把 099 的范围守在直播上；把 `command/run`、`command/done` 投成历史行要动历史投影和金样本，留给画通知行的 P1-7a。

## 待用户拍板

18. **带附件的 `/goal …` 当提示词**（第 4 条）。备选是把图片按 DSH 的格式交给命令、文本附件拒绝，约 0.5 人日。
19. **命令与回答只在直播里**（第 7 条），重开会话后不在。备选是本次就投进历史，约 1 人日加金样本重录。

## 影响

- **金样本**（由编排者收口时重录）：
  - 全部 25 个场景，`stream` 在第一个回合开头多出三条 `session.projection`（`todos: null`、`goal: null`、`subagentCatalog: []`，带第一个回合的 requestId）；`fork`（第二个通道打开子会话）与 `perm-restart`（新宿主重开）在各自新运行时的第一个回合前再多三条；`perm-subagent` 在建子代理时多一条 `subagentCatalog` 的变化；`rewind` 在回退时发出的子会话快照落在回合之外，不进 `stream`；除此之外逐条相同（2026-09-28 试录到 /tmp 逐场景比对）；
  - 所有 `rpc` 的 `bootstrap.capabilities` 由 `{}` 变为 `{"skills": 0}`（录制沙箱里没有技能）；
  - `compact`：`stream` 多一个 `COMMAND` 回合；`rpc` 多 `commands`，`compact` 改为 `{refused, compacted, eventsAfter}`，`tree.leaf` 的日志尾后移两位；`log` 多 `/goal` 的 `command/run`、`command/done` 两条，其余与原来逐字相同。
- **测试**：新增 `src/dsh-host/bridge/__tests__/commandsAndState.test.ts`；`liveEvents.test.ts` 加命令发送三例；`rewindFork.test.ts` 加回退后的快照一例；`compactCommand.test.ts`、`sessionCapabilityModel.test.ts` 各改一处；真宿主集成测试钉住 Main 确实转发了推迟的快照。
