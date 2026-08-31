# Topic — pi-app timeline、history 与 branch 参考

> T12 timeline 产品行为已经落地；后续重点是将 pi-app 的 Pi-native history/tree/fork 主体放入 D15 WorkerSlot，而不是继续扩展旧 singleton `piRuntime.resumeSession()`。原完整调查见 [history snapshot](../history/2026-08-31-pre-pi-only-realignment/topics/timeline-reference.md)。

## 已完成且保留

- user bubble / answer no-box、meta row 退役与恒定高度 hover action slot；
- Pi 小写 tool vocabulary、aggregate、edit/write diff；
- thinking completion boundary 与 streaming open-fence Markdown；
- per-session tool expansion memory、bottom anchor/follow behavior；
- no-workspace welcome/Composer gating；
- RuntimeEvent → messages → turn/timeline projection。

这些 UI/interaction 不因 WorkerManager 替换而重写。证据见 T12 系列 evidence。

## T32 可直接移植

来自 `/home/ai/code/pi-app`：

- `packages/shared/session-jsonl-timeline.ts`
  - `buildTimelinePageFromSessionFile`
  - `paginateItems`
  - branch-aware timeline projection
- `packages/shared/timeline-incomplete.ts`
  - incomplete assistant/tool bridge/empty leaf recovery
- session open/list/load tests 与 late hydration/session-switch race scenarios。

适配点：输出本仓 `session.resumed → session.history → idle`，保留 Pi `entryId`，并接 SessionIndexService/runtimeIdentity。

## T33 可直接/适配移植

- iterative session tree + node cap；
- leaf override；
- request sequence + session key 防 stale tree response；
- Pi native navigate/fork tests。

本仓额外要求：

- rewind idle-only 且有明确确认；说明后续 branch 不删除；
- fork 创建新 application session row、session file 和 WorkerSlot；源 session 不变；
- queue/pending/Extension UI/runtime facts/repository retirement 一起处理；
- duplicate click、busy clone、worker crash 和跨 workspace 需要诊断。

## WorkerSlot 恢复链

```text
Renderer resume(sessionId, runtimeIdentity)
→ Main WorkerManager locate/create slot by session file
→ WorkerSlot Pi SessionManager.open(sessionFile)
→ read branch/history and validate cwd/session
→ session.resumed
→ session.history(entries with Pi entryId)
→ idle
```

当前旧 `piRuntime.resumeSession()` 只做 registry resume 并发 resumed/idle，没有 `SessionManager.open()` 或 history；该实现是 T29/T32 的 replacement source，不是需要保持的外层架构。

## Error contract

- missing file：可诊断，不创建同名空 session 覆盖 source。
- corrupt/truncated file：使用 incomplete recovery 能恢复的部分；其余显式失败。
- cross-cwd：展示实际 session workspace 与请求 workspace，不静默重绑。
- stale load/tree response：按 session key + request generation 丢弃。
- worker crash：保留 durable session file，清 transient runtime/display/pending，允许受控 reopen。

## 不采用

- SDK 私有 deep import 无版本保护；
- fixed sleep 代替 flush/dispose ACK；
- confirmation-free double-click rewind；
- 截断 JSONL 或裁剪前端数组伪装“回退”；
- renderer 直接解析并写 Pi session file。
