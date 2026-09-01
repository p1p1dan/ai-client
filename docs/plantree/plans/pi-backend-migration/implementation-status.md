# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase F / T35 Pi-only absence audit。

**Next Target**：[T35](./roadmap.md#t35--pi-only-absence-audit--planned) 对活动源码、IPC/preload、dependencies、artifacts、tests/fixtures与产品文案做最终Claude/Codex execution absence审计。

**Last Landed**：2026-09-01 T34 Claude-only legacy import closure：source-neutral schema、read-only full-stream adapter、display-only legacy tool/custom、private manifest、immutable snapshot dedupe/single-flight、worker-only Pi v3 staging/native validation/atomic publish、crash reconciliation、batch report/explicit open与旧Resume Claude authority删除；见 [evidence](./evidence/2026-09-01-t34-legacy-import.md)。

**Last Verified**：2026-09-01 — T34 focused 18 files / 181 tests；两套typecheck、33-file scoped Biome、diff/static scans；92.9 MiB worker-only build；真实Electron Claude fixture→import→exact-file open→Pi continue→dispose，source immutable且2个utility worker PID均退出。未运行full Vitest或整套production build。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [D18](./decisions/018-t34-claude-import-semantics.md)：Claude-only首版、线性独立root、display-only unmapped、不可变snapshot与批量报告UI。
- [T28 map](./topics/t28-replacement-map.md) 继续作为 T35/T36 的文件级删除/保护 authority。

## Last landed summary

T34 completed read-only Claude migration without restoring Claude execution. Imported history is copied into validated native Pi v3 sessions; raw source paths remain private, legacy tool/custom payload is display-only and excluded from LLM context, and exact-file continuation is verified.

## Active TODO

1. **T35-a**：扫描并删除残留 Claude/Codex conversation execution imports、backend discriminants、multi-runtime dispatch和compatibility alias。
2. **T35-b**：扫描SDK/CLI dependencies、build entry/artifact、IPC/preload method、dead tests/fixtures/scripts。
3. **T35-c**：扫描agent picker、runtime icon/wording、rollback settings和旧create/send/resume product branches。
4. **T35-d**：证明保留项仅为隔离后的migration readers、Pi-only behavior、通用基础设施、evidence/license。
5. **并行环境欠项**：真账号queue GUI复点；高资源主机packaged preview/PDF/Monaco/local-file smoke（T37前关闭）。

## Blocked By / risks

- T35不得删除未来Codex adapter仍需的静态fixture/mapper，也不得因名称包含Claude/Codex误删runtime-neutral资产。
- 当前3.3 GiB主机继续小批串行测试，禁止full build/full Vitest。
- T36必须证明bundled absolute Pi CLI path与GUI/TUI single-writer；T37关闭真账号与高资源packaged欠项。

## Handoff

1. 先读 [T28 map](./topics/t28-replacement-map.md)、[D16](./decisions/016-delete-obsolete-paths-with-replacement.md) 与 [T34 evidence](./evidence/2026-09-01-t34-legacy-import.md)。
2. T35是absence audit，不是新的大批量replacement bucket；每个发现必须按T28分类。
3. 保护 `src/main/services/legacyImport/`、`src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts`、import fixtures/evidence，但静态证明它们无execution能力。
4. T35完成后与T36共同进入T37 release candidate gates。
