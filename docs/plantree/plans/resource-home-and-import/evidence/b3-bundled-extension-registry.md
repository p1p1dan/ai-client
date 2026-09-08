# B3 随包扩展清单

2026-09-08，Done。

`bundledPlugins.mjs` 的 opt-in 条目提供 label、cost、defaultEnabled 与兼容旧 key；
Main 与 renderer 共用该清单视图。通用 `piOptInFeatures` 支持部分更新，旧 enablePiSubagents=true 保持启用，
用户的新显式偏好优先。未知 ID 忽略，空清单不下发环境变量，无变化不重启 Worker。
新配置和旧兼容键均作为 Main-owned key 防止 renderer 陈旧快照覆盖。

`optInFeatures.test.ts`、`piWorkerEnv.test.ts`、`piResources.test.ts`、
`settingsMainOwnedKeys.test.ts` 与 UI static 覆盖全部上述判据；
已纳入 [全量分批门禁](./final-batch-gate.json) 并通过。
实现细节与中途修复历史见 [实现检查点](./b1-b3-implementation-checkpoint.md)、[B3 补验](./b3-b4-parser-checkpoint.md)。
GUI 开关点验已按 [完成记录](./completion.md) 交接累计轮次。
