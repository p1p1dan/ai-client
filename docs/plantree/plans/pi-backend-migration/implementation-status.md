# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase D / T33 session tree, rewind and fork；T32 Pi-native history and real resume已完成。

**Next Target**：[T33](./roadmap.md#t33--session-tree-rewind-and-fork--planned) 基于T32保留的Pi entry id与active branch实现tree iteration、idle-only rewind确认和independent fork。

**Last Landed**：2026-09-01 T32-a/b/c closure：worker-owned active-branch timeline、pagination/incomplete recovery、exact-file preflight/open、transactional resume commit、resumed→history→idle、duplicate/restart/late hydration/switch races与known-file no-create-fallback；见 [evidence](./evidence/2026-09-01-t32-history-real-resume.md)。

**Last Verified**：2026-09-01 — agent-host/shared 6 files / 40 tests；Main Worker/IPC/index 6 / 82；renderer history/resume/composer/liveness 12 / 436；两套typecheck、41-file Biome、diff/boundary scan；92.8 MiB worker-only build；真实Electron create→materialize→dispose→exact-file reopen→history→continue-stream probe，无orphan。未运行full Vitest或整套production build。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [T28 map](./topics/t28-replacement-map.md) 继续作为 T31/T34/T35/T36 的文件级删除/保护 authority。

## T31 closure

- **Behavior**：RuntimeEvent、queue/pending/attachments、Extension UI、models/auth/trust/permissions均消费WorkerManager/WorkerSlot authority。
- **Identity**：pending echo使用exact attemptId；slot/generation/window owner与background session隔离通过focused tests。
- **Deletion**：live Claude/Codex utility worker producer/runtime/dependencies、agent picker、legacy permission/question IPC和multi-agent catalog已删除；无compatibility facade。
- **Protected boundaries**：T32 history hydration已落地；T34 read-only readers、T36 terminal/Pi TUI继续按T28 map保留。

## Active TODO

1. **T33-a**：读取pi-app tree/branch tests，定义iteration/node-limit/request-generation contract。
2. **T33-b**：idle-only rewind + 明确确认；保留后续分支，不截断JSONL。
3. **T33-c**：从entry fork独立session file/index row/WorkerSlot，源会话不变。
4. **并行环境欠项**：真账号queue GUI复点；高资源主机packaged preview/PDF/Monaco/local-file smoke（T37前关闭）。

## Blocked By / risks

- T31 当前无产品决策 blocker；必须保留 Cycle 1/2 已验收行为，不因 transport replacement 重做 UX。
- 当前 3.3 GiB 主机继续小批串行测试，禁止 full build/full Vitest。
- T33必须保持T32 active-branch/entry-id authority；不得由renderer裁剪history或把rewind实现为JSONL截断。
- T35 deletion 仍被 T34 import 闭环阻塞；T36 必须证明 bundled absolute Pi CLI path 与 GUI/TUI single-writer。

## Handoff

1. 先读 [T32 evidence](./evidence/2026-09-01-t32-history-real-resume.md)、[timeline topic](./topics/timeline-reference.md)、[T30 evidence](./evidence/2026-08-31-t30-worker-manager.md) 与 [T28 map](./topics/t28-replacement-map.md)。
2. T33继续只在WorkerSlot内调用Pi SessionManager；Main/renderer不直接读写Pi JSONL。
3. tree/rewind/fork必须session-targeted并保持exact entry/session identity；不得恢复legacy Host/history reader execution route。
4. T34 migration-only readers继续隔离只读；不得把import source当runtime tree/fork。
