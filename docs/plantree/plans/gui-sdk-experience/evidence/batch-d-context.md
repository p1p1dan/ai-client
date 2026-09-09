# D 追加：原位置丰富上下文详情（2026-09-09）

## 当前代码与参考结论

- 既有 usage-and-catalog 的 A1 缓存命中率与 A2 会话累计已实现，但 A1 可选 ComposerUsageChip tooltip 没做；不是等待插件升级。
- PI-Desktop ChatTranscript 的 ContextUsageInspector 是自带组件，读取模型 usage 并聚合 tool rows；context-usage.ts 工具 token 包含字符数/4 的估算。适配数据层次，不移植其手工定位/全套 UI，不把估算说成 SDK 实测。
- 当前 PiUsagePayload 没有分工具 token、reasoning tokens、可按同一模型请求配对的 responseDuration，因此这些指标明确告知暂无计量。工具摘要使用本轮真实 tool_call 名称与次数。

## 实现

ComposerUsageChip 位置保持不变，外层仍为已用百分比。Tooltip hover 与键盘 focus 显示：剩余 tokens/比例、上下文已用/总窗口、最近一次已结算模型请求的 input/output/cache read/cache write/cache hit/total、本次加载以来会话累计、本轮工具调用。没有数据时保持原先不显示占用率的语义；不显示虚假的 0%。

保留上一轮与累计的区别，明确会话累计仅本次加载以来；详情按 sessionId 重建，切换不会挂着旧会话数据。用现有 Base UI Tooltip 的边界定位与滚动，不把面板挪到输出末尾。

## 验证

- composerUsageDetails 真 React 测试：真实 Tooltip 聚焦、479k/500k 剩余和 4% 已用口径、缓存与累计、切换会话隐藏、当前轮工具计数；2 项通过。
- 现有 startScreenBarStatic 6 项通过，usage 原位置接线保留。
- `node scripts/verify-context-details.mjs`：真实 Electron hover，430px/1000px 窗口下详情处于视口内；可键盘聚焦，截图 `/tmp/aiclient-context-details.png` 已查看。
- 根 tsc、4 个改动文件 Biome 通过；未运行生产构建。

## 未验收

待完整 GUI/Windows 安装版核对真实 provider usage、长工具名称、历史恢复后首次请求、压缩后占用未知。生成速度/推理 token/分工具 token 的新计量契约没有在此 UI 任务内实现。
