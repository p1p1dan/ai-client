# Roadmap — Pi-only Application Convergence

> 本文件是任务 ID、状态和实施顺序的唯一权威。D13 的旧 Cycle 3–5 与 singleton-host 排期已被本路线替代；完整旧内容见 [重排前快照](./history/2026-08-31-pre-pi-only-realignment/roadmap.md)。

## 状态摘要

| 阶段 | 状态 | 出口 |
|---|---|---|
| Cycle 1/2 产品能力 | **Done** | 已有 evidence；按 replacement impact 保留或适配 |
| Pi-only replacement baseline | **Done** | T28 文件级 retain/adapt/replace/delete/migration-only map + evidence |
| Worker foundation | **Done** | T29-a/b/c：RPC、bootstrap、send/stream/stop/dispose、worker-only artifact 与 singleton Pi 删除 |
| Bounded WorkerManager | **Done** | T30 identity/remap/capacity/restart/owner + global manager deletion |
| Cycle 1/2 behavior reattachment | **Done** | T31-a/b/c/d + legacy execution deletion；见2026-09-01 evidence |
| Pi-native history/resume | **Done** | T32 exact-file open、branch timeline、pagination、incomplete recovery与race closure |
| Pi-native tree/rewind/fork | **Done** | T33 bounded tree、confirmed rewind、leaf restart与independent fork |
| Legacy import/removal/TUI | **Next** | T34 read-only import，随后T35/T36 |
| Release candidate | Planned | 自动、资源、packaged 与真机矩阵 |

## T00–T27：已落资产与替换影响

这些 ID 保留原完成事实，不重新编号或改回 Pending。

| ID | 已落能力 | 状态 | Replacement impact |
|---|---|---|---|
| T00 | `ACTIVE_BACKEND='pi'` 屏蔽 legacy backend | Done | **Delete after migration**：由 D14 的 Pi-only contracts 取代 |
| T01 | Pi SDK + `piRuntime` 核心事件/session 逻辑 | Done | **Adapt**：拆入 utility worker/Pi AgentSession |
| T02 | `piHost.ts` utilityProcess entry + MessagePort | Done | **Replace**：作为 T29 worker entry 的来源，不保留 singleton entry |
| T03 | `PiHostProcess` Main spawn/router | Done | **Replace**：由 WorkerManager/WorkerSlot 取代 |
| T04 | Pi SDK/Agent Host 打包 | Done | **Replace packaging topology**：worker bundle + Pi CLI/resources |
| T05 | `projectTrusted` 工作区信任 | Done | **Retain/Adapt**：按 slot 启动环境应用 |
| T06/T06-a/T06-b | Pi smoke、RuntimeEvent projection、启动修复 | Done | **Retain behavior / Adapt host** |
| T07 | Extension UI contracts | Done | **Retain/Adapt**：增加 slot/generation ownership |
| T08/T08-a/T08-b/T08-c | portable UI、permission plugin、内联审批、默认策略 | Done | **Retain behavior / Adapt routing and reset** |
| T09/T10/T11 | notify/status/widget、capability layer、bridge | Done | **Retain behavior / Adapt to WorkerSlot** |
| T12/T12-a…e′ | timeline、tool、thinking、streaming、scroll、welcome | Done | **Retain**；不因 backend topology 重写视觉语义 |
| T13 | Rename/Archive 右键切片 | Partial asset | **Retain completed slice**；history/tree/rewind/fork 由 T32/T33 接管 |
| T14 | in-memory queue/pending release | Done with env recheck | **Retain/Adapt**：busy/stop/session retirement 接 slot |
| T15 | workspace preview/safety | Done with packaged recheck | **Retain**；高资源 packaged smoke 留 T37 |
| T16 | 旧 singleton-host GUI↔TUI 方案 | Planned only | **Superseded**：由 T36 pix-based TUI 取代 |
| T17 | TUI-only hint 第一切片 | Done | **Retain/Adapt**；真实动作归 T36 |
| T18 | 展示模式持久化旧方案 | Planned only | **Adapt**：纳入 T36，禁止历史 session 自动 spawn |
| T19–T23 | Pi model/auth/managed agentDir/TUI config | Done | **Retain/Adapt**：环境注入移到 WorkerSlot/TUI launch |
| T24 | pending send/authoritative echo | Done | **Retain/Adapt**：attempt/echo 绑定 slot runtime |
| T25 | model tags/search/group/effort | Done | **Retain** |
| T26 | explicit-send bottom jump | Done | **Retain** |
| T27 | repository retirement/tombstone cleanup | Done | **Retain/Adapt**：同时 dispose/retire slots |

精确历史、测试和截图见 [Cycle 1](./evidence/2026-08-30-cycle1-execution.md)、[Cycle 2](./evidence/2026-08-31-cycle2-execution.md) 与各 T12 evidence。当前自动门禁不等于 WorkerManager 架构已落地。

## Phase A — Pi-only replacement baseline

### T28 — Pi-only architecture and deletion boundary — **Done**

- **T28-a Runtime inventory**：已盘点 `AgentHostManager`、`AgentHostProcess`、`PiHostProcess`、`src/agent-host`、contracts、IPC、renderer agent semantics、services、credentials、terminal、packaging 和 tests/spikes。
- **T28-b Asset classification**：已建立逐文件 `retain / adapt / replace / delete / migration-only` map，并保护 Cycle 1/2 queue/timeline/Extension UI/model/permission behavior。
- **T28-c Legacy boundary**：已区分 conversation execution、read-only history/import、未实现的 Codex ASR、Pi provider/model metadata、UI wording、tests/evidence 和 one-shot/terminal execution axes。

**验收证据**：[T28 replacement map](./topics/t28-replacement-map.md) · [Phase A evidence](./evidence/2026-08-31-phase-a-t28.md)。Phase A 只修改 plantree 文档，未删除实现代码；每个 legacy area 有替代者、删除条件或保留理由。

## Phase B — Worker foundation

### T29 — Single WorkerSlot vertical slice — **Done**

- **T29-a — Done**：已落 typed Worker RPC、utilityProcess transport、request ID/pending timeout、generation stale filtering、ACK + process-exit-confirmed dispose 与 crash cleanup contract；见 [evidence](./evidence/2026-08-31-t29a-worker-rpc.md)。
- **T29-b — Done**：已落 per-slot utility worker entry、serialized correlated dispatch、exactly-one Pi AgentSession bootstrap、managed/local agentDir/auth/models、project trust、fail-closed permission 与真实 Electron utilityProcess probe；见 [evidence](./evidence/2026-08-31-t29b-worker-bootstrap.md)。
- **T29-c — Done**：`newSession → send → text/thinking/tool/custom stream → stop → dispose` 通过一个 WorkerSlot 完整闭环；send admission 不阻塞 stop，terminal verdict 唯一，app-close PID census 无 orphan；worker artifact 只保留 `worker.js`，singleton `piHost.ts`/`piRuntime.ts`/`PiHostProcess` 与 transition packaging 已删除。见 [evidence](./evidence/2026-08-31-t29c-single-slot-closure.md)。

**验收**：单会话不依赖旧 `PiHostProcess`；RuntimeEvent 与 stop terminal state 正确；worker 退出无 orphan；Agent Host artifact 只保留实际 worker entry，不再构建 singleton Pi fallback。T29 总验收已满足。

### T30 — Main-owned bounded WorkerManager — **Done**

- **T30-a Identity/remap — Done**：unique normalized workspace/create key → normalized session-file key；awaited SessionIndex commit 后才发布 created，collision/index failure remove + dispose。
- **T30-b Capacity/eviction — Done**：resource-aware 2/3/4 default、startup override 1..8、15m idle TTL、foreground/active/blocking/lifecycle protection、safe oldest-idle reclaim 与 retryable capacity error。
- **T30-c Crash/restart — Done**：generation stale filtering、active turn single failure、Extension UI reset、same-session `SessionManager.open`、60s/2 bounded restart、parallel atomic disposal。
- **T30-d Isolation — Done**：per-window foreground、session owner claim/release、exact blocking request origin、wrong-window refusal、window-close dismissal、multi-slot event isolation。
- **T30-e Old manager removal — Done**：consumer 切到 WorkerManager；删除 `AgentHostManager`、`AgentHostProcess`、`PiSingleSlotRuntime`、legacy host env/router/lifecycle IPC/exports/tests/spikes，无 compatibility facade。

**验收证据**：[T30 WorkerManager evidence](./evidence/2026-08-31-t30-worker-manager.md)。多 slot 无跨会话串流；安全达到容量；单 worker crash 不影响其他 slot；Main 无 singleton Agent Host lifecycle authority；真实 Electron 双 active worker app-close 无 orphan。

## Phase C — Reattach completed product behavior

### T31 — Cycle 1/2 behavior reattachment — **Done**

- **T31-a RuntimeEvent/streaming — Done**：snapshot/delta normalization、text/thinking/tool/custom ordering、multi-slot isolation、old-generation filtering与background bucket reattachment。
- **T31-b Queue/pending/attachments — Done**：exact attempt echo、attachment metadata、busy retry、active-only queue release、stop与atomic retirement prune。
- **T31-c Extension UI — Done**：inline approval、display state、exact owner/slot/generation routing、cancel/reset/dispose与background isolation。
- **T31-d Models/auth/permissions — Done**：Pi-only catalog/runtime gate、model/effort scalar preference、managed/local config invalidation、project trust、permission activity与四种Extension UI decision path。
- **Replacement deletion — Done**：Claude/Codex live worker producers/runtimes、agent picker、legacy permission/question channels、multi-agent catalog、SDK/CLI execution dependencies和obsolete tests/spikes已删除；T34 migration readers与T36 terminal infrastructure按T28 map保留。

**验收证据**：[T31 closure evidence](./evidence/2026-09-01-t31-behavior-reattachment.md) · [T31-a inventory](./topics/t31a-runtime-event-reattachment.md)。Cycle 1/2 focused regression、两套typecheck、scoped Biome、worker-only build、真实Electron双slot probe与dev GUI startup smoke通过。

## Phase D — Pi-native session lifecycle

### T32 — History and real resume — **Done**

- **T32-a — Done**：worker-owned `SessionManager.getBranch()` active-path投影、stable Pi entry id、backward pagination、tool result association、compaction/custom notice与incomplete leaf recovery。
- **T32-b — Done**：bounded header preflight后`SessionManager.open(exact sessionFile)`；SDK identity复核、awaited SessionIndex resume transaction，然后同requestId发布`session.resumed → session.history → idle`。
- **T32-c — Done**：missing/corrupt/cross-cwd fail-closed、duplicate flight coalescing、same-file restart hydration、whole-event stale guard、session switch isolation、older-page idempotence与known-file no-create-fallback。

**验收证据**：[T32 history/real resume evidence](./evidence/2026-09-01-t32-history-real-resume.md)。Main/renderer不读Pi JSONL；legacy row不重新进入live execution；真实Electron utilityProcess完成create→materialize→dispose→exact-file reopen→history→继续stream且无orphan。

### T33 — Session tree, rewind and fork — **Done**

- **T33-a — Done**：worker-only iterative tree、4000 backend/320 UI node limit、session-key/request-sequence/generation/branch-revision stale guard。
- **T33-b — Done**：Main+worker idle gate、明确确认、Pi native `navigateTree`、append-only branch preservation、durable leaf checkpoint/restart与branch-replace history。
- **T33-c — Done**：separate-manager native fork、新Pi file、atomic complete index row、independent WorkerSlot与commit前rollback cleanup；源会话不变。

**验收证据**：[T33 tree/rewind/fork evidence](./evidence/2026-09-01-t33-tree-rewind-fork.md)。真实Electron utilityProcess完成A→B→C→rewind A→D两臂浏览、restart leaf、A fork、源/新会话并行独立继续且无orphan。

## Phase E — Legacy conversation migration

### T34 — Read-only Claude/Codex import service — **Planned**

- **T34-a**：`ImportedConversation` 中间模型与 schema version。
- **T34-b**：Claude/Codex read-only source adapters；可选旧 ai-client index adapter。
- **T34-c**：temporary Pi JSONL → validate → atomic publish；dedupe/provenance manifest。
- **T34-d**：scan/preview/select/import/report/open UI。

**验收**：source hash 不变；重复导入不重复；失败无半成品；无法映射 tool 只读展示；导入后可由 Pi 继续。

## Phase F — Remove legacy execution paths

### T35 — Pi-only absence audit — **Planned**

D16 将实际删除前移到 T29–T34 各替代切片；T35 不再承担一次性大批量 cleanup。

- **T35-a**：静态扫描残留 Claude/Codex conversation execution imports、backend discriminants、multi-runtime dispatch 和 compatibility alias。
- **T35-b**：扫描残留 SDK/CLI dependencies、build entry、artifact、IPC/preload method、dead tests/fixtures/scripts。
- **T35-c**：扫描 agent picker、runtime icon/wording、rollback settings 和旧 create/send/resume product branches。
- **T35-d**：证明保留项仅为隔离后的 migration readers、Pi-only behavior、通用基础设施、evidence/license；Codex ASR 不以 fixture 伪装成产品实现。

**验收**：活动代码和产物只有 Pi execution；import reader 无执行能力；无 legacy SDK dependency、死菜单、死 contract 或 transition artifact。

## Phase G — pix-based Pi TUI

### T36 — Pi TUI, PTY and CLI packaging — **Planned**

- **T36-a**：Pi CLI/production dependencies 放入 Resources，可由随包运行时解析。
- **T36-b**：参考 pix `PiTuiPtyController`、session identity、generation/stale output、resize/input/exit。
- **T36-c**：GUI/TUI 单写 authority、mode switch、crash/return-to-GUI reopen。
- **T36-d**：复用本仓 xterm/AgentTerminal；接 T17 action 与 T18 默认模式。

**验收**：不依赖系统 PATH；GUI/TUI 不双写；打包态启动、退出、崩溃和旧输出过滤通过。

## Phase H — Release candidate

### T37 — Pi-only release gates — **Planned**

- **T37-a Automated**：WorkerManager/slot/history/tree/import/TUI tests、两套 typecheck、Biome、diff check。
- **T37-b Resource/longevity**：bounded pool、idle reclaim、reopen、memory、orphan process/PTY。
- **T37-c GUI/packaged smoke**：multi-session、permissions、queue、history、import、TUI、crash recovery。
- **T37-d Release**：license notices、migration docs、release notes、内部运行后扩大范围。

## Dependencies

```text
T28 → T29 → T30 → T31 → T32 → T33
                    ├────→ T34 → T35
                    └────→ T36
T33 + T35 + T36 → T37
```

- T34 source-reader inventory 可在 T32/T33 期间研究，但 atomic writer 应复用已验证的 Pi history/session contract。
- T35 只能在 T34 保留必要 source adapters 后执行。
- Cycle 1 的真账号 queue GUI 复点与高资源 packaged preview smoke 作为并行环境欠项，不阻塞 T28/T29，但必须在 T37 关闭。
