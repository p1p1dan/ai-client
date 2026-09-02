# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase H / T37 Pi-only release gates。

**Next Target**：执行 [T37-a](./roadmap.md#t37--pi-only-release-gates--in-progress) automated matrix，然后进入 resource/longevity、packaged/GUI 与真账号验证。

**Last Landed**：2026-09-02 T35 final absence closure `8aafd450`：删除 legacy permission/runtime/auth/product/dead-test residue，remote helper ABI 收敛为 runtime/server，静态保护 migration-only reader；见 [T35 evidence](./evidence/2026-09-02-t35-absence-audit.md)。

**Last Verified**：2026-09-02 — 两套 typecheck；19 files / 551 focused serial tests；scoped/staged Biome；diff check；production source/dependency absence scan。T36 的 worker-only artifact、Pi CLI `0.84.3` 与 node-pty help smoke继续有效；完整 packaged Electron/GUI smoke未在本低资源主机运行。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 已删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [D18](./decisions/018-t34-claude-import-semantics.md)：Claude-only 首版 import、线性独立 root、display-only unmapped、不可变 snapshot 与批量报告 UI。
- T36 使用同 workspace/config 的 fresh Pi TUI session；GUI/TUI 不同写同一 JSONL。

## Last landed summary

T28–T36 已完成。活动 chat、one-shot、TUI、onboarding、settings、IPC/preload、remote runtime 与打包路径均为 Pi-only。保留的 Claude/Codex 名称仅限 migration/import、legacy credential/profile 单向读取、历史显示 provenance、Pi provider metadata 与 obsolete-payload build denylist。

## Active TODO

1. **T37-a Automated**：按低资源约束分批跑 WorkerManager/slot/history/tree/import/TUI 与 renderer regression，复核两套 typecheck/Biome/diff。
2. **T37-b Resource/longevity**：bounded pool、idle reclaim、reopen、memory、worker/PTY orphan 与长期 suspend/eviction。
3. **T37-c GUI/packaged**：真账号 queue GUI 复点；高资源主机 packaged preview/PDF/Monaco/local-file/TUI smoke。
4. **T37-d Release**：license notices、migration/release notes、rollout/rollback evidence。

## Blocked By / risks

- 当前主机禁止 full Vitest 和整套 production build；必须分批验证，完整 packaged artifact 与真实 GUI 交互需高资源/目标平台环境。
- macOS/Windows/Linux runtime pins 已静态和单元验证，但各平台产物仍需实际解包/启动证明。
- protected legacy import reader/fixture/evidence 不得因名称扫描被机械删除。

## Handoff

1. 先读 [T35 evidence](./evidence/2026-09-02-t35-absence-audit.md)、[T36 evidence](./evidence/2026-09-02-t36-pi-tui.md) 与 [T28 map](./topics/t28-replacement-map.md)。
2. 不得恢复 multi-agent picker、CLI detector/installer、Hapi/Happy/Cloudflared、remote Claude plugin、permission posture 或 managed-mode facade。
3. 保护 `src/main/services/legacyImport/`、`src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts` 与 import fixtures/evidence。
4. 下一批只做 T37 release evidence；若发现 functional regression，按最小切片修复并回写对应 gate evidence。
