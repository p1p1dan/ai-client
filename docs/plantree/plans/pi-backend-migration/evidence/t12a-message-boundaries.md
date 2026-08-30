# T12-a 证据 — 助手消息容器边界（2026-08-29）

拍板依据见 [D12](../decisions/012-timeline-data-model.md)。本档只记「做了什么、怎么验的」。

## 改了什么（`src/agent-host/piRuntime.ts`，一个文件）

| 改动 | 作用 |
|---|---|
| `TurnState.proseClosed` 新字段 | 记「pi 已结束当前容器所属的那条消息」 |
| `closeProseStream()`（`message_end` 调用） | 只关正文流，不动容器 |
| `openProseMessage()`（正文/思考 delta 调用） | 需要时换新容器；工具路径**不**走它 |
| `PiSessionState.assistantSeq` + id 加后缀 | 同毫秒两条消息不再撞 id |
| `message_end` 的 `messageId` 加 `proseClosed` 守卫 | 不对已完成的容器重复发 `message.completed` |

`ensureAssistant()` 本身语义不变——**它现在是「工具路径专用」的那道门**，
正文路径统一改走 `openProseMessage()`。这条分工就是本次设计的全部。

## 新增测试（2 文件 / 9 例）

**`src/agent-host/__tests__/piRuntimeMessageBoundaries.test.ts`（6 例，Host 侧）**
1. 第一条消息结束后会开第二条（不是一条到底）
2. 每段正文有自己的 text 块（不共用 blockId）
3. 工具留在**它前面那段正文**开的容器里
4. 每条助手消息只完成一次
5. **连续工具串仍在一个容器里**（grep→grep→read 三个独立 pi turn）
6. 同毫秒关闭的两条消息 id 仍然互不相同

**`src/renderer/components/chat/__tests__/piTurnItemOrder.test.ts`（3 例，渲染侧）**
回放 Host 现在发出的线形状，经 `groupMessagesIntoTurns` + `flattenTurnItems`：
1. 顺序是 `['text', 'toolGroup', 'text']`——后续正文在工具**之后**
2. 两段正文没被粘成一段
3. 每个 item 带对的 `messageId`

## 变异验证（4 发，全部咬红后复绿）

| # | 变异 | 结果 |
|---|---|---|
| M1 | `closeProseStream` 不再置 `proseClosed` | Host 侧 6 例中 **5 红**（连续工具那例正确存活——该行为不受此变异影响） |
| M2 | 去掉 `message_end` 的重复完成守卫 | **1 红**（4 次 completed vs 期望 1） |
| M3 | `openProseMessage` 永不换容器 | **4 红** |
| M4 | 去掉 id 计数器（退回纯 `Date.now()`） | **5 红** |

⚠️ **M2 第一轮是存活的**——守卫写了但没有任何断言钉它。补了「连续工具串里
`message.completed` 只能有一条」这句之后才咬红。**这是 0820 批 §16「空转臂」同型的
第八发**：代码正确、断言全绿、变异存活，差别只在这次是在提交前用变异自查抓到的。

每轮变异后用 `md5sum` 对账还原（`fb2d8ba1098593be5faa12f8a7eff9db`）。

## 渲染侧夹具变异

把线形状改回「全部共用一个 messageId / blockId」（即修复前的 Host 行为），
渲染侧 3 例**全红**——证明这三条断言钉的是真实的上游契约，不是自证。

## 四门

- typecheck：主仓 0、`src/agent-host` 0
- biome：`src` + `scripts` 1047 文件 **0 error / 0 warning**
- vitest：**271 文件 / 5390 例全绿**（基线 269/5381 → +2 文件 +9 例）

## 未做（如实登记）

- **真机未验**：全部证据来自单测与探针。pi 真实多步工具回合的事件顺序**未在实机上
  抓过**，本批依据的是 SDK 类型声明（`turn_end` 带 `turnIndex`）与 pi-app 的处理方式。
  这是本批最大的一条未验证假设。
- **`turn_start` / `turn_end` 仍未建模**（见 D12「留作后续」）。
- 历史回放路径（`historyReplayMerge`）未针对多消息回合复核。
