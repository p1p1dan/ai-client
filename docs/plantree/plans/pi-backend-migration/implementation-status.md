# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase F/H / T35 final absence audit → T37 release gates。

**Next Target**：关闭 [T35](./roadmap.md#t35--pi-only-absence-audit--in-progress) 最终 dead-contract/static absence gate；随后进入 T37 automated/resource/packaged/real-account release matrix。

**Last Landed**：2026-09-02 T36 Pi TUI implementation（待本批提交）：Main-owned bounded PTY controller、bundled absolute Pi CLI/Node、fresh-session GUI/TUI exclusivity、presentation mode、T17 action/T18 persistence、legacy multi-CLI product surface deletion；见 [evidence](./evidence/2026-09-02-t36-pi-tui.md)。

**Last Verified**：2026-09-02 — 两套typecheck；focused TUI/runtime-pin/auto-execute/absence/static tests；scoped Biome与diff check；worker-only build 92.9 MiB；bundled Pi CLI `0.84.3` version与真实node-pty help smoke。完整packaged Electron/GUI smoke未在本低资源主机运行。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [D18](./decisions/018-t34-claude-import-semantics.md)：Claude-only首版、线性独立root、display-only unmapped、不可变snapshot与批量报告UI。
- T36采用 pix `da01b3e12d2e` 的 adapted PTY lifecycle，但拒绝第二supervisor、全局CLI安装和GUI/TUI同JSONL双写。

## Last landed summary

T36 已完成：产品终端只启动随包 Pi CLI；TUI使用同workspace/config的新session，不触碰GUI durable session file；window/controller lifecycle、stale output、suspend/replay/capacity、mode persistence、unsupported-method action与task auto-execution均已接通。旧 agent picker/detector/installer/onboarding、Hapi/Happy/Cloudflared和remote Claude plugin产品入口已删除。

## Active TODO

1. **T35 final**：清理或证明剩余 legacy-named dead contracts，重跑完整Pi-only absence scan。
2. **T37-a**：扩展 automated gate，按低资源约束分批运行。
3. **T37-b**：resource/longevity、PTY orphan、reopen与bounded eviction复验。
4. **T37-c**：真账号queue GUI复点；高资源主机packaged preview/PDF/Monaco/local-file/TUI smoke。
5. **T37-d**：license/release notes/rollout evidence。

## Blocked By / risks

- protected legacy import reader/fixture/evidence不可因Claude/Codex命名被机械删除。
- 当前主机禁止full Vitest和整套production build；packaged artifact与真实GUI交互必须在T37高资源/目标平台环境完成。
- macOS/Windows/Linux runtime pins已静态和单元验证，但各平台打包产物仍需T37实际解包/启动证明。

## Handoff

1. 先读 [T36 evidence](./evidence/2026-09-02-t36-pi-tui.md)、[T35 evidence](./evidence/2026-09-02-t35-absence-audit.md) 与 [T28 map](./topics/t28-replacement-map.md)。
2. 不得恢复multi-agent picker、CLI detector/installer、Hapi/Happy/Cloudflared或remote Claude plugin product routes。
3. 保护 `src/main/services/legacyImport/`、`src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts`、import fixtures/evidence。
4. T35 final只处理真实dead contract/transition artifact；T36 product implementation已完成，packaged/GUI环境证据归T37。
