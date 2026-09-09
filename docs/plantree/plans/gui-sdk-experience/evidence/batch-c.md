# C 批权限、问答与 diff（2026-09-09）

## 实现

3. 原权限活动每条 Allowed 独占一行。普通放行不再切断工具组，原始 blocks 和审批结果不变；每轮一处默认折叠的授权详情保留全部已批准记录。待确认、拒绝、gate_error 直接可见，权限检查失败使用明确失败措辞；已配对普通 auto 标签不重复显示。
8. QuestionCard 固定 h-7 + truncate 导致长选项丢内容，Enter 在选项按钮上又会被外层截获直接提交。改为自适应高度、问题/选项说明层次、独立滚动、固定操作区；原生 Enter/Space 操作控件，Ctrl/⌘+Enter 提交，方向键选择，输入法组合中不提交。异步提交锁、失败提示/重试、按 questionId 重置草稿；复用现有 Button/Input。
截图入口为 ExtensionUiDialog：其 h-auto 被 Button 的 sm:h-7 覆盖是长选项挤压的直接原因。加 sm:h-auto、换行、整体限高滚动、Esc 取消与输入法保护；保留原先按会话队列、IPC 成功后关闭语义。
9. 常规设置新增持久化 showToolDiff，默认关闭。开启后沿用工具行展开/折叠记忆，预览、成功、失败分别标注。Edit 优先 SDK details.patch（live + history 投影保留），无 patch 时复用参数 LCS 预览，支持 edits[] 与顶层 oldText/newText。Write 标注仅写入内容、无修改前内容；Bash 不捕获、不伪称全量修改。大参数 LCS 比较有单百万单元预算，超出显示完整替换块。
7 补充复核：deriveFileLink 遗漏 Pi 小写 read，且只认旧 file_path；此批补齐 read/edit/write 及 path 字段，真实行点击写入 Windows 路径/行号 intent。A 的编辑器链路测试不能替代这个生产入口，现已补测。

## 参考取舍

读取 PI-Desktop AskToolCard 和 pix extension-ui-prompt 源码及后者测试，适配按问题草稿、发送失败保留交互、长选项不改原值；不采用 pix 单 pending 覆盖前请求语义，保持本仓按会话 FIFO。不复制样式系统、不新增依赖。
直接运行本机 Pi SDK createEditToolDefinition 在独立临时目录修改 before→after，核对真实文件与返回 details.patch / diff，成功。SDK 原生 patch 优先复用；不另造执行层 diff。

## 验证

- `node scripts/verify-question-layout.mjs`（堆 1200 MiB）：真实 Electron、真实 Tailwind、真实两种卡组件，在 360/800px 下长选项增高/换行、鼠标选择/提交通过。截图 `/tmp/aiclient-question-card.png`，已查看。不是完整安装版点验。
- QuestionCard/ExtensionUiDialog 真实 React：单选、多选、自由输入、方向键、失败后重试、重复提交锁、完成只读；Extension FIFO、IPC 失败与 Esc 取消通过。
- 权限 DOM：3 条待确认/拒绝/失败直接显示，2 条允许在折叠详情；原始数据不变。
- diff DOM：设置关闭/开启、展开/折叠、失败预览、Pi read/edit/write 路径点击通过（4 项）。
- showToolDiff 持久化/重新水合通过；worker 实时 patch 与 history patch 投影通过。
- 相邻小批：toolCard + 两种问答 + diff + permission store 5 文件 106 项通过；模型规则/patch/history 4 文件 130 项通过；worker 23 项通过；设置持久化 1 项通过。其他单批结果不累加伪称全量门禁。
- 根 tsc、独立 agent-host tsc 通过；本轮 Biome 27 文件通过。未运行全量测试或生产构建。

## 未验收与范围

待完整 GUI 与 Windows/加密机：实际授权弹窗、真实插件多问答、长内容/窄窗口/中文输入法、SDK Edit 与 Write 成功/失败/拒绝/重载、设置重启保留、实际 Monaco 打开。完整 Bash diff 方案已在 README，需扩大宿主快照/预算/归因范围，未实施。
