# 现场问题：取证与能力边界

Role: investigation-and-contract。状态只见[核心任务树](../README.md#现场缺陷与修复)。
来源：[test.12 现场](../../../../../Windows-P4-6-evidence/test12-reverify.md)。

## F2-b 取证

删除前、不重启的删除后、重启后三个时点，分别记录 session-index.json 的 sessionId/workspacePath/runtimeIdentity、临时目录是否存在及列表归组。
明确操作入口是对话行、Close/归档，还是会删除目录的临时工作区入口。
索引行仍在但不可见，定位渲染/归组；索引行或目录消失，定位删除范围。不能凭 UI 消失推断文件被物理删除。
test.12 当前临时会话恢复、Close/归档隔离和重启保留通过，不等于旧 TEMP 删除异常的根因已解决。

## F7e 上下文快照

两个后端均在轮次结束产生 usage.updated，resume 本身不产生该事件，因此重启后未发消息前暂无详情是既有行为。
可选增强：按恢复消息估算并发布快照；必须晚于 renderer 会话激活，且估算不能冒充 provider 实测。
该增强不是本轮既有功能修复的验收前置。

## TUI-1 能力边界

2026-09-10 用户选择方案 C：native v4 会话不进入旧 Pi TUI，入口给出明确说明。
pi-agent-core 的 v4 JSONL 与 pi-coding-agent CLI/TUI 的 session 格式不同。仅添加 type:session 头会留下旧格式追加条目破坏 v4 reader 的风险；单向导出副本也不能保证双向一致。
此前已核对升级 CLI 不能直接解决格式边界，详细过程见[整理前快照](../history/2026-09-10-status-before-consolidation.md)。

入口拒绝的验收：识别 v4、明确说明、在获取会话所有权之前拒绝；未知/读失败不误判其他会话。
这不满足 ARD 原成功标准 6 中 native GUI/TUI 一致性条款；范围冲突见[未决问题](../open-questions.md)，不得将能力保护当作互通完成。
