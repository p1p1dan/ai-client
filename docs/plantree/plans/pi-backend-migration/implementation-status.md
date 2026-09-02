# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase H / T37 Pi-only release gates。

**Next Target**：T37-a/T37-b 已关闭；下一步 [T37-c](./roadmap.md#t37--pi-only-release-gates--in-progress) packaged/GUI 与真账号矩阵，然后 T37-d release。

**Last Landed**：2026-09-02 T37-b 资源/长稳门禁：新增真 Electron 探针 `scripts/probes/t37b-longevity-probe.ts`，
并修掉 `WorkerSlot` 一处"dispose 应答输给进程退出 → 关闭/淘汰成功却报错"的缺陷，
见 [T37-b evidence](./evidence/2026-09-02-t37b-resource-longevity.md)。前一批为 Q17 落地（D19：TUI 接管 GUI 会话文件）与 Todo 看板整体移除；同批修复了一个既有的 `pnpm build` 阻断故障（electron-vite `esm-shim` 把以 `import` 结尾的字符串误读为 import 语句）。前一批为 T37-a stale test sweep：关闭全部 20 条 pre-existing 失败（溯源为 `c954b3e1`/`8aafd450`/T36 三次收敛留下的陈旧断言，零生产缺陷），见 [T37-a stale test sweep](./evidence/2026-09-02-t37a-stale-test-sweep.md)。前一批为 T37 post-T36 review fixes `ddfbbb4a`：修复阻断打包的 `electron-builder.yml` 重复键、自动执行队列只结算首个任务、登出漏掉 Pi TUI 与 utility worker、挂起终端回放丢失、旧版会话跨升级复活；远程 Agent 终端改为显式失败，见 [T37 review-fix evidence](./evidence/2026-09-02-t37-post-t36-review-fixes.md)。

**Last Verified**：2026-09-02 — 全量 `vitest run` **255 files / 3895 tests 全部通过，0 失败**；`pnpm typecheck` 与 `pnpm typecheck:agent-host` pass；Scoped Biome 与 diff check pass；`node scripts/run-t37b-longevity-probe.mjs` 连续 6 次通过（含一次 20 轮长稳），Electron 退出后 worker/PTY 无孤儿。**`pnpm build` 可完整跑通**；packaged electron-builder 产物与真实 GUI 交互仍需高资源/目标平台环境。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 已删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [D18](./decisions/018-t34-claude-import-semantics.md)：Claude-only 首版 import、线性独立 root、display-only unmapped、不可变 snapshot 与批量报告 UI。
- [D19](./decisions/019-tui-owns-the-gui-session-file.md)：TUI 以 `pi --session <file>` 接管 GUI 同一份 JSONL；单一所有者锁保证不双写；GUI 发送前硬杀 TUI。取代 T36 的 fresh-session 语义。

## Last landed summary

T28–T36 已完成。活动 chat、one-shot、TUI、onboarding、settings、IPC/preload、remote runtime 与打包路径均为 Pi-only。保留的 Claude/Codex 名称仅限 migration/import、legacy credential/profile 单向读取、历史显示 provenance、Pi provider metadata 与 obsolete-payload build denylist。

## Active TODO

1. ~~**T37-a Automated**~~ — **已完成**：全量 254 files / 3884 tests 全绿，typecheck/Biome/diff 复核通过。原 20 条 pre-existing 失败已溯源关闭（[stale test sweep](./evidence/2026-09-02-t37a-stale-test-sweep.md)）。
2. ~~**T37-b Resource/longevity**~~ — **已完成**：bounded pool、idle reclaim、reopen、memory、worker/PTY orphan 与长挂起/淘汰均有真进程实测；顺带修掉 dispose 应答竞态（[T37-b evidence](./evidence/2026-09-02-t37b-resource-longevity.md)）。
3. **T37-c GUI/packaged**：真账号 queue GUI 复点；高资源主机 packaged preview/PDF/Monaco/local-file/TUI smoke。
4. **T37-d Release**：license notices、migration/release notes、rollout/rollback evidence。

## Blocked By / risks

- 完整 packaged artifact 与真实 GUI 交互需高资源/目标平台环境（`pnpm build` 本机可跑，electron-builder 打包未验证）。
- macOS/Windows/Linux runtime pins 已静态和单元验证，但各平台产物仍需实际解包/启动证明。
- protected legacy import reader/fixture/evidence 不得因名称扫描被机械删除。

## Handoff

1. 先读 [T37-b resource/longevity](./evidence/2026-09-02-t37b-resource-longevity.md)、[T37-a stale test sweep](./evidence/2026-09-02-t37a-stale-test-sweep.md)、[T37 review-fix evidence](./evidence/2026-09-02-t37-post-t36-review-fixes.md)、[T35 evidence](./evidence/2026-09-02-t35-absence-audit.md)、[T36 evidence](./evidence/2026-09-02-t36-pi-tui.md) 与 [T28 map](./topics/t28-replacement-map.md)。
2. 不得恢复 multi-agent picker、CLI detector/installer、Hapi/Happy/Cloudflared、remote Claude plugin、permission posture 或 managed-mode facade。
3. 保护 `src/main/services/legacyImport/`、`src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts` 与 import fixtures/evidence。
4. 下一批只做 T37 release evidence；若发现 functional regression，按最小切片修复并回写对应 gate evidence。
