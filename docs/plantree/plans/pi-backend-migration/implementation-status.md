# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase C / T31 Cycle 1/2 behavior reattachment；T30 Main-owned bounded WorkerManager 已完成。

**Next Target**：[T31](./roadmap.md#t31--cycle-12-behavior-reattachment--next) 将 queue/pending/attachments、Extension UI display/approval、models/auth/permissions 与 retirement behavior 完整重挂到 multi-slot WorkerManager，并同步删除每组被替代的 legacy execution branch。

**Last Landed**：2026-08-31 T30 normalized identity/remap、resource-aware bounded pool、foreground/active/blocking eviction protection、same-session bounded restart、multi-window owner isolation、parallel app-close disposal，以及最终 `AgentHostManager`/`AgentHostProcess`/legacy host env/router/lifecycle IPC 删除；见 [evidence](./evidence/2026-08-31-t30-worker-manager.md)。

**Last Verified**：2026-08-31 — T30 WorkerManager/slot/worker/index/owner/cleanup focused 16 files / 134 tests；auth/onboarding/model/permission regressions 10 files / 108 tests；packaging scripts 3 files / 42 tests；Main + Agent Host typecheck；48 changed source/test/script files scoped Biome；diff check；worker-only build 92.8 MiB；真实 Electron 双 slot stream + app-close PID census。低资源主机串行执行，未运行 full Vitest/full Electron production build。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [T28 map](./topics/t28-replacement-map.md) 继续作为 T31/T34/T35/T36 的文件级删除/保护 authority。

## T30 landed

- **Identity**：temporary key 包含 normalized workspace + logical session + UUID；durable key 使用 normalized sessionFile；WorkerSlot diagnostic key 与 Manager map 一起 remap；SessionIndex atomic flush 后才发布 success。
- **Capacity**：≤4 GiB 默认 2、≤8 GiB 默认 3、其余 4；启动覆盖 1..8；15m idle reclaim；foreground/active/blocking/lifecycle state 不淘汰。
- **Crash**：slot-local terminal failure/Extension UI reset；旧 generation 丢弃；replacement `SessionManager.open(sessionFile)`；60s 内最多 2 次 restart。
- **Owner**：每窗口一个 foreground session；不同窗口独立；blocking response 精确回 originating slot/generation/window；window close dismiss request。
- **Lifecycle/deletion**：pool 并行 dispose、bootstrap 期间也持有 process；sync force-kill；global manager/process/env/router/lifecycle IPC 与 obsolete tests/spikes 删除。

## Active TODO

1. **T31-a**：RuntimeEvent/text/thinking/tool/custom/timeline ordering 在 multi-slot 下重挂并清旧 producer branches。
2. **T31-b**：queue/pending/attachments、stop/retry/retirement 与 slot state 对齐。
3. **T31-c/d**：Extension UI display/reset、models/auth/permissions 与 config invalidation 的完整 product regression。
4. **并行环境欠项**：真账号 queue GUI 复点；高资源主机 packaged preview/PDF/Monaco/local-file smoke（T37 前关闭）。

## Blocked By / risks

- T31 当前无产品决策 blocker；必须保留 Cycle 1/2 已验收行为，不因 transport replacement 重做 UX。
- 当前 3.3 GiB 主机继续小批串行测试，禁止 full build/full Vitest。
- T32 real resume/history 仍需 missing/corrupt/cross-cwd 与 renderer hydration；T30 的 `open(sessionFile)` 仅用于内部 crash replacement identity。
- T35 deletion 仍被 T31–T34 replacement/import 闭环阻塞；T36 必须证明 bundled absolute Pi CLI path 与 GUI/TUI single-writer。

## Handoff

1. 先读 [T30 evidence](./evidence/2026-08-31-t30-worker-manager.md)、[D17](./decisions/017-worker-pool-policy.md)、[T29-c evidence](./evidence/2026-08-31-t29c-single-slot-closure.md) 与 [T28 map](./topics/t28-replacement-map.md)。
2. T31 直接消费 `workerManager`/managed slot metadata；不得恢复 `AgentHostManager`、legacy NDJSON entry 或 singleton lifecycle IPC。
3. stop/status/background RPC 必须 session-targeted，不 fallback 到 foreground；blocking response 必须保留 exact origin。
4. 每重挂一组 Cycle 1/2 behavior，同步删除其旧 Host/agent/backend source、tests、exports 与 scripts，并记录 evidence。
