# GUI 功能编号与批次定义

Role: requirements-index。沿用旧文件名供链接兼容；本文件只定义功能范围。
实际状态见[核心任务树 / GUI](../runtime-evolution/README.md#gui-任务树)，操作方法见[现场验收清单](现场验收清单.md)。

| 编号 | 批次 | 功能 / 完成时应具备的行为 |
|---|---|---|
| 1 | A | 左栏菜单鼠标、焦点、Esc/外部点击、遮罩释放 |
| 2 | A | 终端设置不循环更新，Shell/Custom/网络页面正常 |
| 7 | A | 文件点击、编辑器挂载、路径与行号解析 |
| 10 | A | /new 保留当前 cwd，运行中拒绝，旧会话不变 |
| 4 | A | 临时目录复用/创建时间、异步绑定隔离 |
| 5 | B | 重试/异常状态真实，恢复后清过期错误，停止后不残留重试 |
| 6 | B | 真实运行状态、计时与摘要，避免重复显示 |
| 3 | C | 自动授权降噪；人工确认、拒绝、失败及详情可查 |
| 8 | C | 问答卡响应式布局、键盘/输入法/失败重试/只读结果 |
| 9 | C / R | 当前对话审阅栏、按操作记录 Edit/Write diff、持久化入口开关与历史恢复；旧历史预览明确，Bash 不冒充已捕获 |
| 11 | D | 原位置上下文用量提示，区分估算/真实字段及轮次/累计 |
| 12 | E | 底部跟随快速输出；用户上翻优先；尺寸变化与卸载清理 |
| 13 | F | 侧栏目录行未提交变更量，沿用现有 diffStats 与轮询策略 |
| 14 | F | 清理旧 GitView、无调用 hook、全局镜像与失效 IPC |
| 15 | F | cwd 缺失说明、消失目录删除与临时目录恢复 |
| 16 | G / U1 | 关闭自动下载仍检查提醒；更新状态可恢复、稍后重开、下载失败重试与平台说明 |

GUI 9 的 2026-09-10 审阅方案与 GUI 16 见[实施范围](../runtime-evolution/topics/session-review-and-updates.md)。

批次 F 与现场缺陷 F1～F7 是两个编号体系。完整 Bash 工作区快照 diff、左右双栏体验等扩展须单独明确范围，不借本清单自动扩大实现。

## 实现证据索引

[A](evidence/batch-a.md) · [B](evidence/batch-b.md) · [C](evidence/batch-c.md) · [D](evidence/batch-d-context.md) · [E](evidence/batch-e-scroll.md) · [最终复查](evidence/final-review.md)。
历史进度快照见[归档](../runtime-evolution/history/2026-09-10-status-before-consolidation.md)。
