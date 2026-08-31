# Topic — Pi migration 参考仓库（跨会话必读）

> 每个 T28–T37 切片在设计和编码前必须打开对应本地实现，并记录 `direct / adapted / rejected`。本文件替代旧的“不得移植 pi-app WorkerManager”规则；原调查见 [history snapshot](../history/2026-08-31-pre-pi-only-realignment/topics/reference-repositories.md)。

## 仓库与授权

| 仓库 | 本地路径 | 记录版本 | License | 当前主角色 |
|---|---|---|---|---|
| pi-app | `/home/ai/code/pi-app` | `c5ad2f4dccb4` | MIT · Copyright 2026 justhil | WorkerManager/WorkerSlot、history/resume、tree/rewind/fork、timeline |
| pix | `/home/ai/code/pix` | `da01b3e12d2e` | MIT · Copyright 2026 Num Scope | Pi TUI/PTY、single-writer guard、stale output、CLI extraction/packaging |

版本是审计基线，不是产品 dependency pin。substantial copying 必须保留对应 MIT notice。

## 强制规则

1. 每个切片先读参考实现及其 tests，再制定本仓落点。
2. 记录：直接移植、适配移植、不采用，以及原因和 license 处理。
3. pi-app 是 Worker/session lifecycle 与 Pi-native behavior 的首选；pix 是 TUI/PTY/CLI/resources 的首选。
4. 冲突时服从 [D14](../decisions/014-pi-only-product-and-conversation-import.md)、[D15](../decisions/015-main-owned-worker-manager.md)、本仓安全边界和 Cycle 1/2 已验证产品语义。
5. 不为外形相似做无收益重写；只有 `simplifiable` 或 `behavioral drift` 触发 Cycle 1/2 修改。

## 任务矩阵

| 任务 | 首选参考 | 必读位置/能力 | 使用方式 |
|---|---|---|---|
| T29/T30 worker foundation | pi-app | WorkerManager、WorkerSlot、worker entry/transport、pool/remap/eviction、session isolation tests | **可直接移植主体**；换成 ai-client contracts/owners |
| T31 product reattachment | 本仓 evidence + pi-app/pix | RuntimeEvent、queue、Extension UI、models/permissions | 保留本仓 behavior；只替换 transport/lifecycle |
| T32 history/resume | pi-app | `packages/shared/session-jsonl-timeline.ts`、`timeline-incomplete.ts`、open/load tests | timeline/pagination/recovery 可直接移植；在 WorkerSlot 内调用 SessionManager |
| T33 tree/rewind/fork | pi-app | `session-tree-from-file.ts`、leaf override、rewind metadata、fork/worker branch actions | 适配确认、idle gate、slot allocation 和 store cleanup |
| T34 import | 本仓 legacy formats + Pi APIs | legacy readers、Pi JSONL/session validation | source adapter 只读；不要把旧 runtime 带回 |
| T35 removal | 本仓 T28 map | runtime/dependency/UI/contracts | 只按 map 删除；保护 ASR/readers/evidence |
| T36 TUI | pix | `pi-tui-pty.ts`、`pi-tui-session.ts`、`pi-tui-env.ts`、`pi-cli-extract.ts`、terminal tests | 适配本仓 xterm/AgentTerminal、WorkerManager authority |
| T37 packaging/gates | pix + 本仓 scripts | builder/resources/extraction/smoke | 适配 `afterPack.mjs`、packaged verifier 与资源红线 |

## pi-app：允许直接移植

- WorkerManager/WorkerSlot 的 slot state、capacity、idle eviction、foreground、atomic failure cleanup。
- worker RPC/transport 和一 slot 一 utilityProcess 的 lifecycle tests。
- `buildTimelinePageFromSessionFile`、`paginateItems`、incomplete-session recovery。
- iterative session tree、node limits、request sequence/session key stale-response protection。
- Pi-native navigate/fork 的测试场景。

## pi-app：必须适配

- ai-client `RuntimeEvent`、runtimeIdentity、SessionIndexService 和 window owner routing。
- queue/pending/attachments、permission/Extension UI、models/auth/project trust。
- source session/new session row、repository retirement、multi-window lifecycle。
- `@coss/ui`、i18n、rewind confirmation 和“后续分支不删除”语义。

## pi-app：不采用

- SDK `dist/core/*` 私有深导入（除非公开 API 缺失且有版本探测/决策）。
- 固定 80/200/250/500ms sleep 代替 abort/dispose/flush ACK。
- 无确认 double-click rewind。
- 不受控 recursive tree/workers 或与本仓 resource bounds 冲突的默认。

## pix：允许直接参考/移植

- `PiTuiPtyController` open serialization、park/promote、generation/handle stale filtering、dispose all。
- session normalization、`PiTuiExclusiveGuard` 和 session-identified terminal events。
- absolute bundled Node + JS CLI launch、ConPTY/spawn helper、CLI extraction/resources selection。
- terminal lifecycle、packaged CLI 和 stale-output test scenarios。

## pix：不采用

- 全局 npm/PATH 安装 Pi CLI。
- GUI/TUI 同时写同一 JSONL 的 takeover。
- Ghostty 私有 renderer patch。
- 与 D15 WorkerManager 重叠的 HostSupervisor/parking 层。

## Cycle 1/2 审计分类

| 结论 | 动作 |
|---|---|
| Equivalent | 保留，只登记对应参考 |
| ai-client stronger | 保留，写明本仓额外约束 |
| Simplifiable | 建小修任务并证明行为不退化 |
| Behavioral drift | 修复并补 reference-based test/evidence |

已经完成的 reference audit 不得变成“为了像模板而重写”的许可证。
