# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase D / T32 Pi-native history and real resume；T31 Cycle 1/2 behavior reattachment已完成。

**Next Target**：[T32](./roadmap.md#t32--history-and-real-resume--planned) 在WorkerSlot内打开exact Pi session file，输出`session.resumed → session.history → idle`，补missing/corrupt/cross-cwd与renderer hydration race。

**Last Landed**：2026-09-01 T31-a/b/c/d closure：streaming、queue/pending/attachments、Extension UI、Pi-only models/runtime gate/auth/trust/permissions完整重挂，并删除Claude/Codex live worker execution、agent picker、legacy permission/question IPC和multi-agent catalog/dependencies；见 [evidence](./evidence/2026-09-01-t31-behavior-reattachment.md)。

**Last Verified**：2026-09-01 — worker/Manager 12 files / 173 tests；Main/auth/config 12 / 135；renderer 35 / 769；migration-reader 7 / 131；packaging 4 / 44；两套typecheck、72 changed files Biome、diff check；worker build 92.8 MiB；真实Electron双slot probe；Main/Preload/renderer dev startup smoke。未运行full Vitest或整套production build。

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
- **Protected boundaries**：T32 history hydration、T34 read-only readers、T36 terminal/Pi TUI按T28 map保留。

## Active TODO

1. **T32-a/b**：Pi branch-aware timeline/incomplete recovery + WorkerSlot exact-file open与resumed/history/idle order。
2. **T32-c**：missing/corrupt/cross-cwd、duplicate click、restart、late hydration与switch race。
3. **T33 preparation**：只读参考tree/rewind/fork tests；不得提前在renderer裁剪history。
4. **并行环境欠项**：真账号queue GUI复点；高资源主机packaged preview/PDF/Monaco/local-file smoke（T37前关闭）。

## Blocked By / risks

- T31 当前无产品决策 blocker；必须保留 Cycle 1/2 已验收行为，不因 transport replacement 重做 UX。
- 当前 3.3 GiB 主机继续小批串行测试，禁止 full build/full Vitest。
- T32 real resume/history 仍需 missing/corrupt/cross-cwd 与 renderer hydration；T30 的 `open(sessionFile)` 仅用于内部 crash replacement identity。
- T35 deletion 仍被 T31–T34 replacement/import 闭环阻塞；T36 必须证明 bundled absolute Pi CLI path 与 GUI/TUI single-writer。

## Handoff

1. 先读 [T31 closure evidence](./evidence/2026-09-01-t31-behavior-reattachment.md)、[timeline topic](./topics/timeline-reference.md)、[T30 evidence](./evidence/2026-08-31-t30-worker-manager.md) 与 [T28 map](./topics/t28-replacement-map.md)。
2. T32只能在WorkerSlot内调用Pi SessionManager；Main/renderer不直接读写Pi JSONL。
3. resume必须session-targeted并保持exact sessionFile；不得恢复legacy Host/history reader execution route。
4. T34 migration-only readers继续隔离只读；T32不得顺手把import source当runtime resume。
