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
| Legacy import/removal/TUI | **Done** | T34/T35/T36 全部关闭；migration-only reader与Pi TUI边界有静态证据 |
| Release candidate | **In Progress** | T37 自动、资源、packaged 与真机矩阵 |

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
| T17 | TUI-only hint 第一切片 | Done | **Adapted in T36**：unsupported-method notice与workspace action打开统一Pi TUI |
| T18 | 展示模式持久化旧方案 | Done | **Adapted in T36**：持久化`gui | tui`，不自动spawn历史session |
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

### T34 — Read-only legacy import service — **Done**

当前闭环范围和产品语义由 [D18](./decisions/018-t34-claude-import-semantics.md) 与 [T34 contract](./topics/t34-legacy-import.md) 固定：Claude-only、线性独立root、不可变snapshot；Codex等待真实本地格式证据后作为独立adapter实施。

- **T34-a**：source-neutral `ImportedConversation` schema/version、provenance与display-only unmapped entry。
- **T34-b**：隔离Claude read-only source adapter；旧index仅可辅助discovery；static import ban与source immutability。
- **T34-c**：temporary Pi JSONL → Pi native validate → atomic publish；dedupe/single-flight/private manifest与crash reconciliation。
- **T34-d**：scan/preview/checkbox select/import/report/explicit open UI；默认不选，完成后不自动打开。

**验收**：source hash/size/mode/mtime不变；相同snapshot不重复、source增长生成新session；失败无可发现半成品；unmapped tool/custom只读展示且不进LLM context；导入后可由Pi继续。

**验收证据**：[T34 Claude legacy import evidence](./evidence/2026-09-01-t34-legacy-import.md)。focused 18 files / 181 tests、两套typecheck、scoped Biome、worker-only build与真实Electron import→exact-open→continue→dispose probe通过。

## Phase F — Remove legacy execution paths

### T35 — Pi-only absence audit — **Done**

D16 将实际删除前移到 T29–T36 各替代切片；最终审计关闭 dead contracts、legacy permission posture、Claude product/auth facade、remote helper aliases、旧 bootstrap/scripts/tests 与活动产品文案。

- **T35-a — Done**：conversation contracts、backend discriminants、multi-runtime dispatch 与 compatibility alias 已清理。
- **T35-b — Done**：Claude product IPC/preload/service/dependency/transition artifact、one-shot executor、terminal CLI detector/installer/remote helper execution surface 已清理。
- **T35-c — Done**：chat/product runtime picker、one-shot provider UI、AgentTerminal multi-CLI picker与legacy agent settings已清理；产品终端仅启动Pi TUI。
- **T35-d — Done**：保留的 Claude/Codex history asset 仅为隔离 migration reader、fixture/evidence；Codex ASR 仍未以 fixture 冒充产品能力。

**验收证据**：[T35 absence audit](./evidence/2026-09-02-t35-absence-audit.md) · 最终实现 `8aafd450`。

**验收**：活动代码和产物只有 Pi execution；import reader 无执行能力；无 legacy SDK dependency、死菜单、死 contract 或 transition artifact。

## Phase G — pix-based Pi TUI

### T36 — Pi TUI, PTY and CLI packaging — **Done**

- **T36-a — Done**：Pi CLI/production dependencies进入worker Resources；四个平台使用固定版本随包Node与absolute path。
- **T36-b — Done**：Main-owned `PiTuiPtyController`覆盖generation/stale output、resize/input/exit、serialized lifecycle、bounded suspend与LRU eviction。
- **T36-c — Done**：TUI总是创建同workspace/config的新session，不复用GUI JSONL；mode switch、window cleanup、crash/exit回GUI已接通。
- **T36-d — Done**：复用xterm/AgentTerminal，接通T17 action、T18持久化mode与Pi TUI auto-execute completion。

**验收证据**：[T36 evidence](./evidence/2026-09-02-t36-pi-tui.md)。两套typecheck、focused tests、scoped Biome、worker-only build、bundled CLI version与真实node-pty help smoke通过；完整packaged Electron smoke归T37。

## Phase H — Release candidate

### T37 — Pi-only release gates — **In Progress**

- **T37-a Automated — Done**：全量 254 files / 3884 tests 全绿，typecheck、Biome、diff check 通过；
  原 20 条 pre-existing 失败已溯源关闭，见 [stale test sweep](./evidence/2026-09-02-t37a-stale-test-sweep.md)。
- **T37-b Resource/longevity — Done**：真 Electron 探针跑通有界池/保护位、后台空闲回收、淘汰后重开、
  20 轮 churn 内存持平（+2.3 MiB）、worker 与 Pi TUI PTY 零孤儿、长挂起后复用不重开；
  并修掉 dispose 应答输给进程退出导致"关闭成功却报错"的缺陷。见 [T37-b evidence](./evidence/2026-09-02-t37b-resource-longevity.md)。
- **T37-c GUI/真账号点验 — Done**：CDP 探针在真 cx2/maxapi 账号上跑通 multi-session、queue/Stop、
  history、Claude import、GUI↔TUI 交接、权限审批四选项、模型切换与三种崩溃恢复（杀 worker / 杀 TUI PTY /
  强杀 app 重启），11 步全过并留截图。期间修掉三个真缺陷：`pnpm dev` 读已删除文件而完全无法启动、
  dev 模式 worker 因 strip-only 语法与缺扩展名导入启动即死、worker stderr 被丢弃导致崩溃无从诊断。
  packaged 安装包按决定交 CI。见 [T37-c evidence](./evidence/2026-09-02-t37c-gui-packaged.md)。
- **T37-d Release — In Progress**：
  - **会话变砖缺陷 — Done**：根因是 Pi 只在第一条 assistant 消息落地时才写 JSONL，而 Main 把它
    创建时预留的路径当作持久身份写进索引。实际影响面远超原记录：Stop、退出应用、模型报错都会留下永久坏行
    （本机索引 54 行中有 5 行）。改为文件存在才发布身份、文件出现即补发 `session.updated`、
    未 materialize 的会话崩溃后重建、`error` entry 可被清除与淘汰，并就地修复历史坏行。
    12 步 GUI 探针（新增 `crashUnwritten`）在真账号上全过，索引 dangling 行归零。
    见 [T37-d evidence](./evidence/2026-09-02-t37d-session-brick-fix.md)。
  - **剩余**：license notices、migration docs、release notes、内部运行后扩大范围；
    CI packaged 触发与 macOS 产物欠项。

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
