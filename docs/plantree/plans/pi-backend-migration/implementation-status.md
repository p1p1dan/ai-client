# Implementation Status — Pi-only Application Convergence

**Current Phase**：Completed — Phase H / T37 release candidate closed；Phase I / T38 runtime 补字段已关闭（2026-09-05）。

**Next Target**：无活动 runtime 任务。正式发布仍按
[`docs/pi-only-rollout-rollback.md`](../../../pi-only-rollout-rollback.md) 完成内部观察、限量扩大、
macOS 签名/公证与 rollback 记录；产品界面改造在 pix/pi-app UI 对齐计划推进。

**Last Landed**：2026-09-05 **T38 runtime 补字段**（与 UI 计划 U06-b 同批）：`usage.updated` 生产者挂
`turn_end`（一回合一条、不累加；`agent_end` 刻意不做第二个生产者），目录带出 `contextWindow`，
`tool.updated` 补状态行。开工取证改了做法——pi SDK 的 `getContextUsage()` 直接给
`{ tokens, contextWindow, percent }`，占用由 worker 报而不是渲染层拿 token 除窗口算。
全仓 274 files / 4210 tests 全绿，见 [T38 evidence](./evidence/2026-09-05-t38-runtime-usage-fields.md)。

**上一次 Landed**：2026-09-03 T37-d release closure：MIT notices、Pi-only migration guide、curated
release notes、rollout/rollback runbook 与 packaged legal gate 已落地；清除第二个 release-note owner；新增
native macOS unsigned CI job。CI 实跑发现并修复四类既有门禁问题：legacy HTML Biome error、干净安装下
permission policy 测试误吃本机旧文件、Windows 盘符 ESM import、Linux headless Electron 与 macOS
`afterPack` resources 路径。最终提交 `f2777d7b`。

**Last Verified**：2026-09-03 — manual Build run
[`33714362901`](https://github.com/p1p1dan/ai-client/actions/runs/33714362901) **success**：

- gate：两套 typecheck pass；Biome 960 files；Vitest **256 files / 3911 tests pass**；release metadata pass；
- Windows x64：installer/portable/unpacked 生成，permission gate 与 packaged legal/runtime/worker smoke pass；
- Linux x64：AppImage/deb 生成，permission gate 与 Xvfb packaged smoke pass；
- macOS arm64：unsigned dmg/zip/unpacked 生成，permission gate 与 packaged smoke pass；
- Linux remote runtime x64/arm64 bundles pass；
- manual branch run 未打 tag、未发布 release，`generate-release-notes` 按设计 skipped。

完整 artifact ID、archive SHA-256、失败 run 的问题发现链与命令见
[T37-d release closure evidence](./evidence/2026-09-03-t37d-release-closure.md)。

## Current architecture decision

- [D14](./decisions/014-pi-only-product-and-conversation-import.md)：Claude/Codex execution runtime 已删除；历史只通过只读、原子、可去重 import 保留。
- [D15](./decisions/015-main-owned-worker-manager.md)：Main 持有 bounded WorkerManager；每 WorkerSlot 一个 utilityProcess/Pi AgentSession；无额外 singleton supervisor。
- [D16](./decisions/016-delete-obsolete-paths-with-replacement.md)：替代即删除；不保留 compatibility facade。
- [D17](./decisions/017-worker-pool-policy.md)：identity/remap、2/3/4 capacity、protected eviction、same-session bounded restart policy。
- [D18](./decisions/018-t34-claude-import-semantics.md)：Claude-only 首版 import、线性独立 root、display-only unmapped、不可变 snapshot 与批量报告 UI。
- [D19](./decisions/019-tui-owns-the-gui-session-file.md)：TUI 以 `pi --session <file>` 接管 GUI 同一份 JSONL；单一所有者锁保证不双写；GUI 发送前硬杀 TUI。

## Last landed summary

T28–T37 已完成。活动 chat、one-shot、TUI、onboarding、settings、IPC/preload、remote runtime 与
packaging 均为 Pi-only。保留的 Claude/Codex 名称仅限 migration/import、legacy credential/profile
单向读取、历史 provenance、Pi provider metadata 与 obsolete-payload denylist。Windows/Linux/macOS
原生 CI 已验证 bundled Pi worker、Node runtime、permission policy 和 legal resources。

## Active TODO

无。T38-a/b/c 已全部落地并有 evidence；~~T38-d service_tier 注入~~ 触发条件未成立（Q09 取证证实
Pi SDK 有透传通道，不是 runtime 缺字段问题，落地取舍留在 UI 计划 Q12）。

T38 留下三条**已知欠项**，都写在 evidence §七，都不重开本任务：
① 重开会话在首次回复前没有占用环（pi 只在 `turn_end` 报），退化为只显示上下文窗口一行；
② ~~`turnTokensDisplay` 实时 ↓ 计数器是死路~~ — **已于同日关闭**，用户拍板整条删除，
改动全在渲染层，归 UI 计划
[D11](../pix-ui-alignment/decisions/011-retire-the-live-output-token-counter.md)；
③ GUI 点验并入 UI 计划那一次累计点验。

## Operational follow-ups（不重开 T37）

1. 正式发布前执行 1–2 天内部观察、限量扩大和 rollback rehearsal。
2. macOS unsigned CI candidate 不得直接分发；先完成 Developer ID signing、notarization 与真实 Mac Gatekeeper 点验。
3. ~~未 materialize 会话空闲淘汰后的 renderer binding 与 `HTTP_PROXY` 下直接 `pnpm dev` localhost 代理问题~~
   — **已修**（2026-09-05，用户拍板「顺手修掉」，不单独立项）。根因是 Main 从不发 `host.error` 事件、
   且 `WorkerManagerError.code` 不过 IPC 边界，导致渲染层两条恢复分支（淘汰重建、`session_busy` 重试）
   一直是死代码；dev 侧补小写 `no_proxy` 回环绕过。见
   [维护切片 evidence](./evidence/2026-09-05-maintenance-eviction-recovery-and-proxy.md)。
   **两条都未在真机复现原始现场。**
4. GitHub Actions 的 Node 20 action-runtime deprecation warning 由后续 action 依赖升级处理；项目 job Node 已为 24。

## Handoff

1. 发布证据以 [T37-d release closure](./evidence/2026-09-03-t37d-release-closure.md) 为入口。
2. 不得恢复 multi-agent picker、CLI detector/installer、Hapi/Happy/Cloudflared、remote Claude plugin、permission posture 或 managed-mode facade。
3. 保护 `src/main/services/legacyImport/`、`src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts` 与 import fixtures/evidence。
4. 任何扩大范围必须遵循 rollout/rollback runbook；数据损坏、permission bypass、cross-session leakage、double writer 或 startup failure 立即停止发布。
