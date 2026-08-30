# D12 — 时间线数据建模：不移植 pi-app 的 display-items，改修上游的消息容器边界

> 拍板时间：2026-08-29（T12-a 施工前评估）。
> 用户指令原文：「pi-agent 原本就是专为 pi 设计，可能比我们现有的更好，不要为了低成本而复用，我们要考虑可持续性和稳定性，不能图一时之利」。
> 本档的结论**不是**「复用更便宜所以复用」，而是评估后发现 T12-a 原本设想要解决的问题不在这一层。

## 一句话结论

**不移植 `timeline-display-items` / `timeline-turn-groups`。** 真正的缺陷在更上游：
`piRuntime.ts` 把一整轮 pi 运行塞进**一个**助手消息、**一个**正文块，于是模型说的
第二段话被粘到第一段后面、并且渲染在它其实晚于的工具行**前面**。修这一处之后，
我们既有的三层模型（`chatTurn` → `groupTimeline` → `segmentTurnBody`）输出的顺序
就是对的。

## 评估依据（逐条可复现，不是印象）

### ① pi 的一轮运行里有很多条助手消息，我们当成了一条

pi SDK 的 `turn_end` 事件带 `turnIndex`（`dist/core/extensions/types.d.ts:570-575`），
即**一次 `agent_start` 里包着很多个 pi turn**。一个会用工具的回答在 pi 那里长这样：

```
turn1: message_start → 正文① → message_end(stopReason=toolUse)
       tool_execution_start → tool_execution_end
turn2: message_start → 正文② → message_end(stopReason=stop)
```

而我们的 `piRuntime` 只在 `agent_start` 时重置 turn 状态（`state.turn = newTurnState()`），
`message_end` 只清空快照、**不换消息容器也不换块 id**。于是正文①和正文②拿到同一个
`blockId`，渲染端 `appendTextBlock` 按 id 找到已存在的块就地追加。

### ② 实测证据（施工前跑的探针，非推理）

把 piRuntime 会发出的事件序列喂进 `applyRuntimeEvent`，得到的块数组是：

```
[
  { type: "text",      text: "Let me read the file.The file says X." },
  { type: "tool_call", tool: "Read" },
  { type: "tool_result" }
]
```

两段话被**无分隔符粘在一起**，而且整块排在工具行**前面**——可实际顺序是
「先说要读文件 → 读 → 再说文件里写了什么」。这就是「回答读起来不对劲」的机制。

⚠️ **下游全程无辜**：`groupTimeline` 本来就按块顺序遍历、遇正文就 flush 工具组，
`segmentTurnBody` 是保序的 run-length 切分。T-05 D-5 的「块顺序即渲染顺序」约束一直
成立——**只是从来没人把正确的顺序交给它**。

### ③ pi-app 的模型并不比我们更"忠于 pi"

移植的前提是「它的模型更贴 pi 的语义」。逐文件读下来这条不成立：

- pi-app 的 `TimelineItem` 把一条 pi 消息的**所有 text 块 join 成一个字符串**，
  thinking 块**另外 join 成一个字段**（`packages/shared/worker-message.ts:51-70`）。
  也就是说**消息内部**的正文/思考交错顺序，pi-app 同样丢掉，而且它注释里写明这是
  「对齐 pi-tui 的 AssistantMessageComponent」——**pi 自己的 TUI 也这么做**。
- 它的「工具聚簇 → 遇正文封口成一行摘要」（`timeline-display-items.ts` 的
  `findAgentClusterEnd` / `isActivitySegmentSealed`）与我们 `groupTimeline` 的
  「攒工具组，遇正文 flush」**是同一个想法**，只是它在 item 粒度、我们在 block 粒度。

⇒ 两边**在同一处丢同样的东西**，差异只在「一轮里的多条消息」这一层——而那一层是
我们上游的 bug，不是模型的能力差。

### ④ 移植还会丢掉我们已有、pi-app 没有的东西

pi-app 的 display-items 里没有 `permission_request` / `permission_activity` /
`question` 这三类 item，也没有 FB7 的 `joinResolvedPermissions`（按 id 把已决议的
授权折进它授权的那一行）。pi-app 本身没有权限系统——那正是我们要额外装
`@gotgenes/pi-permission-system` 的原因。整套移植等于把这些再焊回去一遍。

另外它的封口式工具摘要是一个**产品行为**，而 T12 的形态用户 2026-08-29 刚看图确认过。
换渲染形态属于另一次产品拍板，不该夹带在数据建模切片里。

## 拍板

1. **保留** `chatTurn.ts` 三层模型与 `groupTimeline`，不引入 pi-app 的 display-items。
2. **修上游**：`piRuntime` 在 `message_end` 关闭**正文流**（不是关闭整个容器），
   下一段正文/思考开新容器，工具继续挂在已开的容器上。
3. **不移植 ≠ 不学**：pi-app 那套「一条 item 就是一件事」的扁平结构在**结构上**
   更难写出本次这种 bug（没有"容器"可供共享）。这个优点用**断言**补上：
   `piRuntimeMessageBoundaries.test.ts` + `piTurnItemOrder.test.ts` 两头各钉一半。

## 为什么是「关正文流」而不是「关整个容器」

第一版实现直接在 `message_end` 把 `assistantMessageId` 置空。它修好了正文顺序，
但**当场制造了另一个回归**：连续工具串（grep → grep → read，每个都是独立 pi turn）
会被切成一条消息一个工具，而 `groupTimeline` 按消息内的块聚簇 ⇒ **五步搜索渲染成
五张独立工具卡**。

两个诉求方向相反，所以只关一半：

| | 正文/思考 | 工具 |
|---|---|---|
| `message_end` 之后 | 换新容器（`openProseMessage`） | 继续用已开容器（`ensureAssistant`） |

结果 `正文① → t1 → t2 → 正文②` 落成 `[正文①, t1, t2]` + `[正文②]`：顺序对，
工具组不碎。两条都有定向断言。

## 连带修掉的两处

- **同毫秒 id 碰撞**：`asst-${sessionId}-${Date.now()}` 在「一段正文刚结束、下一段
  紧接着开始」时**必然**撞同一毫秒，两条消息共用 id 就又合并回一条。已加会话级
  单调计数器。⚠️ 实测发现这不是理论风险：去掉计数器后，**用真实时钟**跑两步回合的
  测试就有 4/6 变红。
- **重复 completed**：工具-only 的 pi turn 也会发 `message_end`，会对一个早已完成的
  容器再发一次 `message.completed`，给没变过的消息盖一个新的 `completedAt`。已按
  `proseClosed` 拦掉。

## 留作后续（未做）

- **`turn_start` / `turn_end` 完全没建模**：pi 明确告诉我们 turn 边界在哪（还带
  `turnIndex`），我们却在靠 `message_end` 推断。pi-app 两个都处理。接上之后边界判断
  可以从推断变成读取，属结构性改善，另立票。
- 本批**没有真机验证**：证据全部来自单元测试与探针。需要一次真实的多步工具回合
  确认 pi 的实际事件顺序与 SDK 类型描述一致。
