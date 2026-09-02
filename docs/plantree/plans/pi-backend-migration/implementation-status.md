# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase F/G / T35 final CLI absence + T36 pix-based Pi TUI。

**Next Target**：[T36](./roadmap.md#t36--pi-tui-pty-and-cli-packaging--planned) 替换 AgentTerminal/CLI picker/detector/installer/remote helper 中的多CLI执行面，落 bundled absolute Pi CLI path、PTY lifecycle 与GUI/TUI single-writer；完成后回收T35最终absence gate。

**Last Landed**：2026-09-02 T35 active runtime/one-shot cleanup：删除Claude provider/config/completion/IDE MCP产品集成；one-shot commit/branch/review/todo迁到sessionless Pi utility worker；见 [evidence](./evidence/2026-09-02-t35-absence-audit.md)。

**Last Verified**：2026-09-02 — 两套typecheck；focused 61 tests + protected/import static 10 tests；scoped Biome、diff/static scans。未重复worker-only build，未运行full Vitest或整套production build。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [D18](./decisions/018-t34-claude-import-semantics.md)：Claude-only首版、线性独立root、display-only unmapped、不可变snapshot与批量报告UI。
- [T28 map](./topics/t28-replacement-map.md) 继续作为 T35/T36 的文件级删除/保护 authority。

## Last landed summary

T35 已完成 conversation/runtime contract、Claude product integration 与 one-shot executor 清理。one-shot 现在由 sessionless Pi utility worker 执行，不写 session/index。最终CLI absence仍被 T36 的 AgentTerminal/CLI packaging 替代所阻塞，因此T35保持In Progress而非虚假Done。

## Active TODO

1. **T36-a**：确认 Pi CLI production dependency/resource layout 与 packaged absolute executable path。
2. **T36-b**：按 pix 适配 PTY controller、generation/stale output、resize/input/exit。
3. **T36-c**：落 GUI/TUI single-writer、切换、crash/return-to-GUI reopen。
4. **T35 final**：T36替换后删除旧CLI picker/detector/installer/remote helper多runtime surface并重跑absence gate。
5. **T37环境欠项**：真账号queue GUI复点；高资源主机packaged preview/PDF/Monaco/local-file smoke。

## Blocked By / risks

- T35不得删除未来Codex adapter仍需的静态fixture/mapper，也不得因名称包含Claude/Codex误删runtime-neutral资产。
- 当前3.3 GiB主机继续小批串行测试，禁止full build/full Vitest。
- T36必须证明bundled absolute Pi CLI path与GUI/TUI single-writer；T37关闭真账号与高资源packaged欠项。

## Handoff

1. 先读 [T35 evidence](./evidence/2026-09-02-t35-absence-audit.md)、[T28 map](./topics/t28-replacement-map.md)、[D16](./decisions/016-delete-obsolete-paths-with-replacement.md) 与 pix reference rules。
2. T35已经证明active chat和one-shot为Pi-only；不要回退Claude/Codex product IPC或executor。
3. 保护 `src/main/services/legacyImport/`、`src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts`、import fixtures/evidence。
4. T36替换 terminal/CLI surface 后立即回跑T35 final absence，再进入T37。
