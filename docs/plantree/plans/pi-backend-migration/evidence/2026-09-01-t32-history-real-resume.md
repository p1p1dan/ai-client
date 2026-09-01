# Evidence — T32 Pi-native history and real resume

**Date**：2026-09-01  
**Role**：evidence  
**Status**：accepted / T32 Done  
**Related**：[roadmap](../roadmap.md#t32--history-and-real-resume--done) · [timeline reference](../topics/timeline-reference.md) · [T30 evidence](./2026-08-31-t30-worker-manager.md)

## Claim verified

T32 已在 Pi-only topology 内闭环真实会话恢复：

```text
Renderer → preload → Electron Main WorkerManager
→ exact WorkerSlot → one utilityProcess
→ SessionManager.open(exact sessionFile) → active Pi branch
```

Main/renderer 不读写 Pi JSONL；exact session file 的预检、SDK open、active-branch timeline 与分页均在所属 utility worker 内完成。SessionIndex 的 awaited resume commit 成功后，Main 使用同一个 requestId 同步发布 `session.resumed → session.history → session.status(idle)`。

## T32-a — Branch-aware timeline and pagination

- 新增 worker-only `piSessionTimeline.ts`，只消费已打开 `SessionManager.getBranch()`；不在Main/renderer解析JSONL。
- timeline保留exact Pi `entryId`，renderer id稳定为`h:<entryId>`；user/assistant/system、text/thinking、tool call/result、image metadata、compaction/branch summary与visible custom entry均有投影。
- tool result按call id关联，缺失id时只在当前分支向后找未结算call；output有明确上限。
- initial page从active leaf向前取最近80条；`offset/limit/totalCount/hasMore`经typed Worker RPC传递，renderer“Load earlier messages”按页prepend并按stable id去重。
- 真正空assistant leaf标记`incomplete/stopReason`并显示interrupted占位；含tool call的空assistant bridge不误报中断。

## T32-b — Exact-file resume transaction

- worker在`SessionManager.open()`前bounded-read首个session header：missing、empty/foreign/corrupt、cross-cwd分别结构化失败；不存在的目标不会被SDK静默创建或覆盖。
- open不传cwd override；preflight/open前后核对dev/inode并再次核对SDK打开的sessionFile/cwd/sessionId，避免path replacement或override掩盖header漂移。
- bootstrap acknowledgement在exact-file resume时必须携带initial history page；WorkerManager核对logical session、normalized session-file key与workspace identity。
- `SessionIndexService.commitResumed()`只接受已存在且identity完全一致的row，atomic flush失败回滚内存；event listener不再把`session.resumed`当作第二条fire-and-forget持久化路径。
- commit成功后才发布`resumed → history → idle`；失败时partial slot被dispose且不发布任何成功事件。
- `history` capability已开启；空数组`chat:listHistory`被删除，新增session-targeted `chat:loadHistoryPage`。

## T32-c — Races, restart and diagnostics

- 同一logical session、同一exact file/cwd/model/effort的并发resume共享一个flight与requestId；不同target在flight期间拒绝，重复请求的最新window owner成为blocking UI authority。
- ready exact slot上的重复resume不spawn，只从slot重新读取fresh active branch并再次完成commit/event triplet。
- crash replacement等待旧worker确认退出，使用同一sessionFile reopen；新generation验证history后发布`resumed → history(refresh) → idle`，旧generation event继续丢弃。
- renderer用resume request snapshot拒绝整个stale initial/refresh history event；它不能覆盖新hydration的messages、identity或error。session bucket与post-await active-session guard继续隔离switch race。
- older page按session串行读取，dispatch前后核对authoritative slot/generation；renderer以projected page coverage推进offset，out-of-order/duplicate page整事件拒绝，不依赖merge后`h:*`数量。
- sidebar/manual resume和Composer lazy resume都把missing/corrupt/cross-cwd编码为session-local history error；explicit resume与stale direct-binding recovery均先reopen known exact file，失败/超时不fallback create，因此pending prompt不会进入无关新session。
- Main在spawn前同时核对SessionIndex agent/sessionFile/workspace；legacy Claude/Codex row仍可供T34 migration读取，但renderer和Main均拒绝把其opaque identity送入Pi live resume。

## Replacement deletion / protected boundaries

- 删除空实现`CHAT_LIST_HISTORY`及preload `listHistory`，并删除replaced `session.listHistory` command / `session.historyListed` runtime contract；resume payload不再携带agent axis。
- 保留T34 migration-only `historyReader.ts`、`codexHistoryReader.ts`等source adapters；它们没有接入T32 runtime resume。
- T33 tree/rewind/fork未提前实现；T32保留entry ids、active branch与incomplete metadata作为后续基础。
- 未恢复singleton Host、legacy execution runtime、Main JSONL reader或renderer disk access。

## Reference disposition

### pi-app `c5ad2f4dccb4`（MIT · Copyright 2026 justhil）

- **Direct behavior/scenario**：`getBranch()` active-path projection、leaf-side backward pagination、empty assistant leaf recovery、tool bridge不误报、exact-file reopen与stale hydration/race scenarios。
- **Adapted**：本仓stable `HistoryMessage` DTO、typed Worker RPC、Main WorkerManager identity authority、transactional SessionIndex commit、multi-window/session bucket与existing replay watermark。
- **Rejected**：Main/renderer JSONL reader、SDK deep import、generated history counters作为identity、preview-path leaf mutation、额外supervisor或fixed disposal sleep。

本轮按行为/场景独立实现，没有复制substantial upstream source/test block；无需新增distributed notice。

### pix `da01b3e12d2e`（MIT · Copyright 2026 Num Scope）

T32未移植pix实现。pix的PTY/TUI、single-writer和packaging参考继续留给T36；未把TUI file reader或第二套supervisor引入history runtime。

## Verification

所有Vitest均以`--maxWorkers=1 --no-file-parallelism`串行执行；受3.3 GiB主机约束，未运行full Vitest或整套production build。

```text
Agent-host timeline/preflight/bootstrap/session/RPC + shared RPC guards
→ 6 files passed; 40 tests passed

Main WorkerSlot/transport/process/manager/IPC/index
→ 6 files passed; 82 tests passed

Renderer resume/index/history/replay/timeline/composer/queue/liveness
→ 12 files passed; 436 tests passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

pnpm exec biome check <41 changed T32 source/test/probe files>
→ passed; no diagnostics

git diff --check
→ passed

Static boundary scan
→ no `as any` / `@ts-ignore` additions
→ no Main/renderer/preload import of piSessionTimeline/piSessionPreflight
→ no Main/renderer/preload `SessionManager.open`
```

### Worker artifact and real Electron exact-resume probe

```text
NODE_OPTIONS=--max-old-space-size=1536 pnpm build:agent-host
→ passed; 92.8 MiB / 97,333,528 B worker-only artifact, Pi SDK 0.84.3

node scripts/run-t30-worker-manager-probe.mjs out-agent-host/worker.js
→ ok=true
→ create probe-a/probe-b; materialize probe-a JSONL
→ dispose probe-a worker; reopen exact same sessionFile in replacement utilityProcess
→ resumeEventOrder=[session.resumed, session.history, session.status]
→ both sessions stream independently after resume
→ 3 observed utility worker PIDs absent after Electron exit
```

## Independent review closure

只读cross-file review最初发现四个blocker：known direct-binding仍可create fallback、older page缺slot authority guard、pagination错误使用merge后`h:*`数量、Main未核对indexed workspace；另发现duplicate owner与preflight/open path-swap风险。以上均在本切片修复并新增focused tests。第二轮只读复审检查对应diff与tests后报告 **no blocker-level issues found**。

## Deferred by roadmap authority

- **T33**：session tree、branch navigation、rewind/fork确认和node limits。
- **T34**：legacy read-only import、atomic publish、dedupe/provenance及UI。
- **T36**：Pi TUI/PTY、GUI/TUI single-writer与bundled CLI packaging。
- 真账号GUI复点和高资源packaged smoke仍由T37 release gates关闭，不改变T32 focused自动化与真实utilityProcess exact-resume结论。
