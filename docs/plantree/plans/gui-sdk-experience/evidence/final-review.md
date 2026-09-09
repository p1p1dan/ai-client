# 最终复查（2026-09-09）

- Pi extensionUi pending 来自独立事件，不会自动把 session.status 变成 waiting_question。SessionActivityStatus 现在读取当前会话真实待答队列，显示等待确认；收到答复关闭后恢复工具状态。
- 修改失败并不能证明完全未写入文件；统一标注“失败——仅参数预览，未确认应用”，权限拒绝仍由原有拒绝标签明确表达。
- 未知 messageId/空 delta 不再清真实终止错误；不完整 Edit 参数不生成虚假删除预览；/new 的发送锁只检查当前会话归属；TEMP 全局 New 标题补齐沿用目录的真实路径。
- 真实 MessageTimeline DOM 测试：重试排在长输出后，用户上翻到 scrollTop=200 后追加内容仍为 200。
- 菜单 Electron 测试补强：打开后菜单持有焦点，Esc 焦点回触发器，Portal/Backdrop 均清除；最终运行通过。
- 最后小批：状态/工具 diff DOM 2 文件 6 项；runtime reducer/recovery 3 文件 78 项；diff/action 3 文件 60 项；真实时间线 1 项，均通过。最后根 tsc 与改动文件 Biome 通过。
- 未执行整套生产构建、全量 Vitest、CI 安装包或现场 GUI。各阶段已通过的根/agent-host 类型检查不等于打包验证。

追加 E 的滚动改进与验证见 [独立证据](batch-e-scroll.md)。

[现场最小清单](../现场验收清单.md) 为最终验收入口。实现/自动化已完成，完整 GUI 与 Windows/加密机仍未验收，不标产品任务 Done。
