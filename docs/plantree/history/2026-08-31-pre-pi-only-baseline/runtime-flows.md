# Runtime Flows

## 发送主链

Composer → `store.sendMessage(text, attachments?)` → IPC `chat:send` → AgentHostManager →
Host stdin（NDJSON `session.send`）→ SDK `query()` 流 → `eventNormalizer` 归一 →
stdout Runtime Event → Main 广播 `CHAT_RUNTIME_EVENT` → renderer **16ms 批处理队列** →
`applyRuntimeEvents` 折叠 → 分桶 reducer → UI（时间线只订阅本会话桶）。

- 附件（C-13）：`attachments[]={kind:'image'|'text', mediaType, data, name?}`，Host 侧包成 SDK 消息流；path 不进协议。
- 流结束无 result：normalizer `finishTurn()` 补终态（有输出→completed，无→failed），杜绝 UI 永驻 running。

## Permission / Question

SDK `canUseTool` → dispatcher：AskUserQuestion → questionBridge，其余 → permissionBridge →
停靠 pending + 发 `permission.requested` / `question.requested` → UI 卡 →
`chat:respondPermission({allow})` / `chat:respondQuestion({answers?|response?|cancel?})` → 单次 settle → 会话续跑。
Question 三条硬约束（answers key 逐字 / multiSelect 用 ", " / answers-response 互斥）见总台账 C-04 行。

## Resume 历史

点击历史会话 → `chat:resumeSession` → Host `historyReader` 读 CC JSONL（uuid 文件名定位、宽容解析、TSD magic → `encrypted_unreadable`）→
事件序 `session.resumed → session.history（消息 id h:* 前缀）→ status idle` → store 桶内幂等替换灌入。
running 会话 resume 被拒（`session_busy`）。列表数据源 = `chat:listSessions`（索引）+ `chat:listHistory`（盘上）。

## 看门狗（C-14）

send 循环 120s 无**生产性事件**（assistant/user/result/tool_progress/stream_event 才算；system 控制面不算）→
abort + 显性 `session.failed`。豁免：permission/question 挂起、本地工具执行中（openTools）。
`AICLIENT_HOST_STALL_TIMEOUT_MS` 可配，0 禁用。
