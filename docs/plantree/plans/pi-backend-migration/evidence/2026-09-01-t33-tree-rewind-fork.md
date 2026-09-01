# Evidence — T33 Pi-native session tree, rewind and fork

**Date**：2026-09-01  
**Role**：evidence  
**Status**：accepted / T33 Done  
**Related**：[roadmap](../roadmap.md#t33--session-tree-rewind-and-fork--done) · [T33 contract](../topics/t33-tree-rewind-fork.md) · [T32 evidence](./2026-09-01-t32-history-real-resume.md)

## Claim verified

T33已在Pi-only WorkerManager topology内闭环：

```text
Renderer → preload → Electron Main WorkerManager
→ exact WorkerSlot → one utilityProcess/Pi AgentSession
→ bounded tree / native navigateTree / separate-manager fork
```

Main/renderer不解析或写Pi JSONL。tree、rewind与fork均session-targeted并核对logical session、normalized session file、WorkerSlot generation和workspace identity。

硬验收通过：A→B→C，回退到A的assistant entry后发D，B/C与D两臂同时保留且可浏览；从A fork后源/新会话使用不同Pi session file与WorkerSlot并独立继续。

## T33-a — Bounded tree and stale guard

- 新增worker-only `piSessionTree.ts`，从已打开`SessionManager.getEntries()/getBranch()/getLeafId()`迭代建树；orphan/self-parent作为root，保留exact Pi entry id、parent/depth/label/preview/active/leaf。
- worker结果硬上限4000；renderer `sessionTree.ts`展示上限320，并优先保留active leaf窗口与归一化缩进。
- `worker.tree`、Main `getSessionTree`、session-targeted IPC/preload与`SessionTreeDialog`已接通。
- Main在RPC前后核对slot object、generation、branch revision与identity；renderer用monotonic request sequence + canonical session key拒绝迟到成功/错误，close/session switch/refresh/rewind/fork均使旧请求失效。
- history older-page同样捕获branch revision；rewind后的旧页不得污染新active branch。

## T33-b — Confirmed idle-only rewind

- worker与Main都拒绝active turn、Pi streaming或blocking Extension UI；IPC要求`confirmed === true`，renderer只通过`AlertDialog`提交明确确认。
- worker调用公开Pi `AgentSession.navigateTree(targetEntryId, { summarize: false })`；不截断、不重写JSONL，后续descendants继续留在同一append-only tree。
- `PiLeafCheckpoint { activeEntryId, fileTailEntryId }`作为session-index可选字段原子持久化；exact-file bootstrap/restart仅在physical tail仍匹配时重放active leaf。发送D产生新tail后，旧A checkpoint自动失效并由settled leaf同步替换。
- rewind成功发布`session.history(mode:'branch') → idle`，不伪装为resume；renderer branch mode直接替换active timeline，不走T32 same-branch replay merge，B/C不会残留在A/D当前视图。
- renderer targeted reset清queue、pending echo、turn status、runtime facts、Extension UI/display、tool expansion与subagent transient state，不删除session/workspace/index。

## T33-c — Independent fork transaction

- source worker用**单独打开**的`SessionManager`调用`createBranchedSession(entryId)`；不调用会替换live source runtime的same-slot fork/remap。
- 新文件经bounded header preflight与exact reopen复核session id/cwd/path；source manager的session file/session id/leaf/entries保持不变。
- Main先保留source并取得安全capacity，再创建staged file、独立provisional WorkerSlot exact-open、校验initial history/leaf，随后用`SessionIndexService.createForked()`单次atomic flush插入完整row，最后才发布`created → history → idle`。
- index commit前失败会dispose provisional slot并通过source worker显式discard本事务创建的staged file；index成功后即使后续广播失败，也不删除已提交file/row。
- renderer只物化Main返回的indexed Pi row，按normalized workspace path选择并打开新session；不复制source queue/pending/Extension UI/runtime transient state。

## Reference disposition

### pi-app `c5ad2f4dccb4`（MIT · Copyright 2026 justhil）

- **Direct behavior/scenario**：iterative tree、orphan roots、4000/320 bounds、session-key/request-sequence stale guard、leaf override、native navigate/fork tests、A/B/C→rewind→D与source/fork isolation。
- **Adapted**：tree读取进入本仓WorkerSlot；leaf checkpoint进入SessionIndexService/restart；rewind增加Main+worker idle gate和AlertDialog确认；fork创建独立logical row/file/slot并接本仓capacity/owner/store cleanup。
- **Rejected**：Main preview process/JSONL reader、uncapped recursive tree、double-click无确认rewind、JSONL truncate、same-slot fork remap、foreground worker fallback与fixed sleep。

本轮按行为/场景独立实现，没有复制substantial upstream source/test block；无需新增distributed source notice。pi-app MIT归属继续留在reference/evidence ledger，T37统一license audit复核。

### pix `da01b3e12d2e`

T33未移植pix实现。pix的PTY/TUI、single-writer和packaging参考继续留给T36；未引入第二套supervisor或GUI/TUI双写。

## Verification

所有Vitest均使用`--maxWorkers=1 --no-file-parallelism`串行执行；受3.3 GiB主机约束，未运行full Vitest或整套production build。

```text
Shared RPC + agent-host tree/bootstrap/session/branch actions
→ 6 files passed; 37 tests passed

Main WorkerManager/create slot/index/IPC
→ 4 files passed; 64 tests passed

Renderer tree/timeline/history/actions/lifecycle
→ 7 files passed; 134 tests passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck
→ passed

NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck:agent-host
→ passed

pnpm exec biome check <35 changed T33 source/test/probe files>
→ passed; no diagnostics

git diff --check
→ passed

Static boundary scan
→ no added `as any` / `@ts-ignore`
→ no Main/preload/renderer `SessionManager.open` / `createBranchedSession` / `navigateTree`
→ no Main/preload/renderer import of worker-only `piSessionTree`
```

### Worker artifact and real Electron T33 probe

```text
NODE_OPTIONS=--max-old-space-size=1536 pnpm build:agent-host
→ passed; 92.8 MiB / 97,353,810 B worker-only artifact, Pi SDK 0.84.3

node scripts/run-t33-tree-rewind-fork-probe.mjs out-agent-host/worker.js
→ ok=true
→ rewindBranchesPreserved=true
→ rewindSurvivedRestart=true
→ forkSourceUnchanged=true
→ forkIndependentSlot=true
→ independentContinuation=true
→ 3 observed utility worker PIDs absent after disposal/Electron exit
```

Probe真实执行：create source → send/settle A/B/C → tree exact ids → rewind A assistant → dispose/exact-file reopen并重放leaf → send D → 验证B/C与D同branch point且inode不变/size不减 → fork A到新file/new slot/index row → source发E与fork发F并行settle → 两tree/file/session隔离 → dispose all无orphan。

## Independent review closure

三轮只读cross-layer复审先后发现：rewind/fork缺exclusive mutation reservation、history分页可穿过mutation、fork staged-file/slot cleanup失败被吞、首个user-only path无法由Pi物化、cross-window tree branch staleness未闭环。实现随后增加`mutationInFlight`并覆盖send/tree/history/eviction、callback内finally释放；provisional target-owned discard + source fallback + unlink/disposal显式失败；tree `forkable`与worker no-assistant-path诊断；history `branchRevision`广播/store/dialog reload guard。对应focused tests与最终typecheck/build/probe重新通过。

## Deferred by roadmap authority

- **T34**：legacy Claude/Codex read-only import、atomic publish、dedupe/provenance及UI。
- **T35**：Pi-only absence audit；只保护T34 migration readers、Pi behavior、通用基础设施和evidence/license。
- **T36**：Pi TUI/PTY、GUI/TUI single-writer与bundled CLI packaging。
- 真账号queue GUI复点和高资源packaged preview/PDF/Monaco/local-file smoke继续由T37关闭，不改变T33 focused自动化与真实utilityProcess结论。
