# 未决问题 — Runtime 自主化演进

只放未解决的问题；解决后移入 ARD 决策并从这里删除。

**目前没有未决问题**（2026-09-09）。Q7 是最后一条，已随下表收口。
新问题按 `| 问题 | 当前证据 | 处理节点 |` 三列另起一张表登记。

已收口：

| 原问题 | 去向 |
|---|---|
| Q1 后端开关暴露在哪一层 | [ARD D8](../../../plans/2026-09-08-runtime-evolution-ard.md) — 仅 dev 环境变量 `AICLIENT_RUNTIME_BACKEND` |
| Q2 缓存命中率基线怎么采 | [ARD D9](../../../plans/2026-09-08-runtime-evolution-ard.md) — 沿用现有公式 + 固定脚本会话提前采基线 |
| Q3 subagent 进程内还是独立 WorkerSlot | [ARD D10](../../../plans/2026-09-08-runtime-evolution-ard.md) — 同进程第二个 Agent；2026-09-09 D10/D17 改为现行完整子系统复刻，旧并发/watchdog 边界已替代，见 [P5-2 契约](topics/p5-2-subagent-contracts.md) |
| Q5 Main 侧裸 `readFile` 读 worker 写的文件会得到什么 | [ARD D13](../../../plans/2026-09-08-runtime-evolution-ard.md) — 2026-09-08 现场坐实为**密文**：加密按文件策略生效，Main 及其派生进程读用户文件得到 `%TSD-Header-###%`。Main 侧统一改走 `readFileTsdSafe` |
| Q4 新旧后端对比用哪一版 Pi 协议依赖 | [ARD D12](../../../plans/2026-09-08-runtime-evolution-ard.md) — 用户拍板「版本影响不大，用新的」：新 runtime 保持 0.84.4，不回退对齐，版本差异在 P2-6 记为已知偏差 |
| Q6 P1-0 非 pipe stdio 范围 | 用户确认先交付 pipe + adapter 挂载点；不自动重跑命令，真实载体验收仍在 P1-8/P4-6，见 [契约](topics/p1-0-host-contracts.md) |
| Q7 `GitService` 在加密机上返回空结果 | 2026-09-09 用户拍板由本分支修，已落 `b984b282`。读码定位到的不是 spawn 参数而是三处判据：`getBranches` 拿 `symbolic-ref` 当「空仓库」判据（它在任何签出分支的仓库上都成功，所以造得出 `(no commits yet)`）、porcelain reader 把「0 退出码 + 没有 `# branch.*` 头」当成功、`truncated` 一个变量兼了条目上限与 15s 超时导致超时不 reject。三处都改为明确失败，`createGitEnv` / `withSafeDirectoryEnv` / `toGitPath` 未动——现场证据里 `getBranches` 那条路径上两条 git 命令都成功了，PATH 与 git.exe 不是原因。6 项测试中四项在修复前失败、修复后通过。**P4-5 的前置因此解除**；加密机上是否还有别的表现，按 [D16](../../../plans/2026-09-08-runtime-evolution-ard.md) 随 P4-6 一次上机复测 |
