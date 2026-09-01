# Runtime Flows

> 以下是 D15 flow。T30 已落地 Main-owned bounded WorkerManager；T31–T36 继续在该 topology 上重挂 behavior/history/import/TUI，不恢复 singleton supervisor。

## Create / send / stream

```text
Composer/store
→ preload IPC
→ Main WorkerManager locate/create WorkerSlot
→ slot RPC over MessagePort
→ utility worker Pi AgentSession create/open/send
→ Pi events projected to RuntimeEvent
→ Main validates slot generation + routes to owner window
→ renderer batches/reduces into session bucket
→ timeline/composer surfaces
```

- create 初期可用 workspace temporary key；Pi session file 建立后原子 remap。
- attachments 通过 contract 传 bytes/metadata，不把任意 host path 当可信 payload。
- terminal state 必须唯一：completed / failed / stopped；流结束缺 terminal event 时由 worker fail closed/projection 补齐，不让 UI 永驻 busy。

## Stop / dispose / crash

```text
stop(session)
→ WorkerManager selects authoritative slot
→ slot abort/stop RPC
→ Pi turn settles
→ pending RPC + Extension UI + active turn cleared
→ terminal RuntimeEvent
```

- crash/dispose 同时清 owner route、blocking request、display reset 和 stale generation。
- bounded restart；反复失败进入可恢复错误，不无限拉起。
- foreground/active turn/pending blocking request 的 slot 不可 idle-evict。

## Extension UI / permission

```text
Pi extension ui.select/confirm/input/editor
→ worker Extension UI bridge
→ blocking request tagged session/runtime/generation/requestId
→ Main owner route
→ session-local inline dock
→ correlated response back to same WorkerSlot
```

`notify/setStatus/setWidget/unsupported` 是 fire-and-forget display event，不进入 blocking map。slot reload/crash/dispose 发 reset/retirement；后台 session 只显示 badge，不用全局 modal。

## Real resume / history

```text
resume(sessionId, runtimeIdentity/sessionFile)
→ WorkerManager locate/create slot
→ Pi SessionManager.open(sessionFile)
→ branch-aware history + incomplete recovery
→ session.resumed
→ session.history(entries preserving Pi entryId)
→ idle
```

missing/corrupt/cross-cwd 必须可诊断；不创建空文件覆盖 source，不用裁剪 renderer 数组伪装 rewind。

## Tree / rewind / fork

- tree 查询带 session key + request generation，迟到响应丢弃。
- rewind idle-only，调用 Pi native navigation；保留后续 branch。
- fork 从 entry 创建独立 Pi session file、application session row 和 WorkerSlot；源 session 不变。
- 操作前后清理 queue/pending/Extension UI/runtime facts，防跨会话继续流。

## Legacy import

```text
read-only Claude/Codex source
→ ImportedConversation
→ validate/project
→ temporary Pi JSONL
→ Pi reader validation
→ atomic publish + dedupe/provenance
→ session index
```

source 不 rename/move/delete/modify；无法映射 tool 只读展示，不重新执行；失败不暴露半成品。

## GUI / TUI mode

- Main/WorkerManager 是 single-writer authority。
- TUI launch 使用随包 Node/Pi CLI absolute path 和正确 agentDir/cwd。
- 未证明 flush/open handoff 前，只承诺同 workspace/config 的新 TUI session。
- GUI 与 TUI 不同时写同一 Pi session file；旧 PTY/worker generation output 必须过滤。
