# Implementation Status — Pi-only Application Convergence

**Current Phase**：Completed core — Phase H / T37 release candidate closed；Phase I / T38 已开立未开工。

**Next Target**：T38 runtime 补字段（`usage.updated` 生产者、`contextWindow` 暴露），由 UI 计划
[D03](../pix-ui-alignment/decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定二开立，
**不重开 T37 发版门禁**。正式发布仍按
[`docs/pi-only-rollout-rollback.md`](../../../pi-only-rollout-rollback.md) 完成内部观察、限量扩大、
macOS 签名/公证与 rollback 记录；产品界面改造在 pix/pi-app UI 对齐计划推进。

**Last Landed**：2026-09-03 T37-d release closure：MIT notices、Pi-only migration guide、curated
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

1. T38-a：Pi worker 从 `turn_end`/`agent_end` 的 `message.usage` 发出 `usage.updated`（事件类型已存在，缺生产者）。
2. T38-b：在 `AgentModelOption` 上保留 `contextWindow`（当前被 `piModelConfig.ts:109` 剥离）。
3. T38-c（可选）：`tool.updated` 转发 partialResult，供活动工具状态行。
4. ~~T38-d service_tier 注入~~：触发条件未成立——Q09 取证证实 Pi SDK 有透传通道，不是 runtime 缺字段问题，
   落地取舍留在 UI 计划 Q12。

## Operational follow-ups（不重开 T37）

1. 正式发布前执行 1–2 天内部观察、限量扩大和 rollback rehearsal。
2. macOS unsigned CI candidate 不得直接分发；先完成 Developer ID signing、notarization 与真实 Mac Gatekeeper 点验。
3. 未 materialize 会话空闲淘汰后的 renderer binding 与 `HTTP_PROXY` 下直接 `pnpm dev` localhost 代理问题，按独立维护切片处理。
4. GitHub Actions 的 Node 20 action-runtime deprecation warning 由后续 action 依赖升级处理；项目 job Node 已为 24。

## Handoff

1. 发布证据以 [T37-d release closure](./evidence/2026-09-03-t37d-release-closure.md) 为入口。
2. 不得恢复 multi-agent picker、CLI detector/installer、Hapi/Happy/Cloudflared、remote Claude plugin、permission posture 或 managed-mode facade。
3. 保护 `src/main/services/legacyImport/`、`src/agent-host/codexHistoryReader.ts`、`codexItemMapper.ts` 与 import fixtures/evidence。
4. 任何扩大范围必须遵循 rollout/rollback runbook；数据损坏、permission bypass、cross-session leakage、double writer 或 startup failure 立即停止发布。
