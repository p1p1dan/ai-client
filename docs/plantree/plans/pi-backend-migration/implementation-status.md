# Implementation Status — Pi-only Application Convergence

**Current Phase**：Phase H / T37 Pi-only release gates。

**Next Target**：T37-a/T37-b/T37-c 已关闭；下一步 [T37-d](./roadmap.md#t37--pi-only-release-gates--in-progress) release：
license/migration/release notes，外加 T37-c 报出的会话变砖缺陷、CI packaged 触发与 macOS 产物欠项。

**Last Landed**：2026-09-02 T37-c GUI/真账号点验：新增 CDP 探针 `scripts/run-t37c-gui-probe.mjs`，
在真 cx2/maxapi 账号上跑通 11 步 GUI 门禁并留 20 张截图；修掉三个真缺陷——`pnpm dev` 读已删除的
`RemoteHelperSource.ts` 而完全无法启动、dev 模式 Pi worker 因构造函数参数属性与缺扩展名值导入
在 strip-only 模式下启动即死、`WorkerManager` 生产单例未接 `log` 导致 worker stderr 被整段丢弃；
另修 TUI 顶栏与 D19 不符的文案。报出一个未修缺陷：worker 在会话 JSONL 落盘前崩溃会让该会话永久不可用。
见 [T37-c evidence](./evidence/2026-09-02-t37c-gui-packaged.md)。前一批为 T37-b 资源/长稳门禁：
新增真 Electron 探针 `scripts/probes/t37b-longevity-probe.ts`，
并修掉 `WorkerSlot` 一处"dispose 应答输给进程退出 → 关闭/淘汰成功却报错"的缺陷，
见 [T37-b evidence](./evidence/2026-09-02-t37b-resource-longevity.md)。前一批为 Q17 落地（D19：TUI 接管 GUI 会话文件）与 Todo 看板整体移除；同批修复了一个既有的 `pnpm build` 阻断故障（electron-vite `esm-shim` 把以 `import` 结尾的字符串误读为 import 语句）。前一批为 T37-a stale test sweep：关闭全部 20 条 pre-existing 失败（溯源为 `c954b3e1`/`8aafd450`/T36 三次收敛留下的陈旧断言，零生产缺陷），见 [T37-a stale test sweep](./evidence/2026-09-02-t37a-stale-test-sweep.md)。前一批为 T37 post-T36 review fixes `ddfbbb4a`：修复阻断打包的 `electron-builder.yml` 重复键、自动执行队列只结算首个任务、登出漏掉 Pi TUI 与 utility worker、挂起终端回放丢失、旧版会话跨升级复活；远程 Agent 终端改为显式失败，见 [T37 review-fix evidence](./evidence/2026-09-02-t37-post-t36-review-fixes.md)。

**Last Verified**：2026-09-02 — 全量 `vitest run` **256 files / 3898 tests 全部通过，0 失败**；`pnpm typecheck` 与 `pnpm typecheck:agent-host` pass；Scoped Biome 与 diff check pass；`node scripts/run-t37c-gui-probe.mjs` **11/11 步通过**（真 cx2/maxapi 账号、真模型端点，退出后 `pi`/`electron` 进程数为 0）；`node scripts/run-t37b-longevity-probe.mjs` 连续 6 次通过（含一次 20 轮长稳）。**`pnpm dev` 与 `pnpm build` 均可跑通**（前者本批修复）；packaged electron-builder 产物仍未验证，按决定交 CI。

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
3. ~~**T37-c GUI/真账号**~~ — **已完成**：CDP 探针 11 步全过（多会话、队列/Stop、历史、Claude 导入、
   GUI↔TUI 交接、权限四选项、模型切换、三种崩溃恢复），修掉 dev 启动、dev worker 启动、worker stderr 丢弃
   三个真缺陷（[T37-c evidence](./evidence/2026-09-02-t37c-gui-packaged.md)）。
4. **T37-d Release**：license notices、migration/release notes、rollout/rollback evidence；
   并接手下列 T37-c 遗留项。
5. **T37-c 遗留项**：(a) worker 在会话 JSONL 落盘前崩溃 → 重启两次都报 `WORKER_SESSION_FILE_NOT_FOUND` →
   `entry.state = 'error'` 且无路径可清除，该会话永久不可用；修法牵涉 T30-a 的 identity/index 提交不变量，需独立切片。
   (b) `build.yml` 的 `workflow_dispatch` packaged 门禁尚未触发（需先推分支，等授权）。(c) macOS 无 CI runner。

## Blocked By / risks

- packaged artifact 交 CI；本机不跑 electron-builder（磁盘剩 6.7 GiB，`compression: maximum` 在 2 核上过慢）。
- macOS/Windows/Linux runtime pins 已静态和单元验证，但各平台产物仍需实际解包/启动证明。
- protected legacy import reader/fixture/evidence 不得因名称扫描被机械删除。

## Handoff

1. 先读 [T37-c GUI/真账号](./evidence/2026-09-02-t37c-gui-packaged.md)、[T37-b resource/longevity](./evidence/2026-09-02-t37b-resource-longevity.md)、[T37-a stale test sweep](./evidence/2026-09-02-t37a-stale-test-sweep.md)、[T37 review-fix evidence](./evidence/2026-09-02-t37-post-t36-review-fixes.md)、[T35 evidence](./evidence/2026-09-02-t35-absence-audit.md)、[T36 evidence](./evidence/2026-09-02-t36-pi-tui.md) 与 [T28 map](./topics/t28-replacement-map.md)。
2. 不得恢复 multi-agent picker、CLI detector/installer、Hapi/Happy/Cloudflared、remote Claude plugin、permission posture 或 managed-mode facade。
3. 保护 `src/main/services/legacyImport/`、`src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts` 与 import fixtures/evidence。
4. 下一批只做 T37 release evidence；若发现 functional regression，按最小切片修复并回写对应 gate evidence。
5. 真账号 GUI 点验要先确认 `dev.env` 的 `PI_CODING_AGENT_DIR` 指向仍存在的目录（当前为 `~/.pilab/t37c-agent`）。
   `dev.env` 是 gitignored 的本机文件；指向失效路径时应用会没有任何模型，且不会明确报错。
