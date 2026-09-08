# B1-b 默认技能目录

2026-09-08，Done。

`PiResourcesSettings` 的 Shared skills 标为 Default，增加打开技能目录按钮；
preload 的窄 IPC 委托 Main 从 `getPiResourceSettings().paths.sharedSkills` 建目录并打开。
bootstrap 追加默认安装路径提示，保留原系统追加提示，用户明确指定其他目录时尊重其选择。

`piWorkerEnv.test.ts` 验证 HOME 覆盖路径；`piResources.test.ts` 验证两种模式下建目录/打开与错误反馈；
UI static 验证 Default 与按钮桥接；bootstrap/resource paths 测试验证提示保留。
上述文件已包含在 [303 文件全量分批门禁](./final-batch-gate.json) 中并通过。

实际共享加载由 [B1-a](./b1a-agents-skills-probe.md) 的真实 utilityProcess 与 TUI PTY 证明。
GUI 按 [完成记录](./completion.md) 交接累计轮次，未将静态断言当作实际 GUI 通过。
