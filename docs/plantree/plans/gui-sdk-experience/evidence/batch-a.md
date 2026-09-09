# A 批实施与验证（2026-09-09）

## 根因与改动

1. LeftNav 菜单打开后 hover/focus 离开，邻接的新建按钮 display:none，触发器横移 28px（真实 Electron 测得 x=320 → 348），松手命中遮罩触发 cancel-open。改为 opacity 隐藏并保留布局占位。
2. 开发 React 复现 Maximum update depth exceeded，栈：react-dom-client.development.js → useLabelableId.js:35 cleanup → setControlId。SettingsRow 误用单控件 Field 承载多个控件，互相注册 controlId。改为纯布局 div；终端控件补可访问名称。
7. Markdown 原先只保留 http(s)，本地文件成为纯文本。增加本地文件解析并写入现有 fileOpenIntent；补 Windows/file URI/行号。原先首次无标签挂载修复已存在，保留。失败提示在隐藏编辑器里不可见，改 toast；intent 序号跨 ack 单调递增；navigateToFile 读实时 tabs，避免订阅 tabs 导致 effect 重入；scratch 目录也可作为编辑根。
10. /new 原来 createUnboundChatSession，现只继承 workspace 或已有 scratch cwd，不复制 runtimeIdentity/消息；运行中明确提示先停止。旧会话不改。共享 scratch 路径在 Main 创建时 adopt，release 检查同路径其他持有者。
4. TEMP 创建采用当前 Date，目录名称不是会话时间；本地无法证明现场机器五月命名目录的实际创建历史。沿用目录入口明确展示路径，新建临时工作区独立命名；文件夹与 createdAt 共用一次时间采样。异步创建前捕获源会话，切换会话后不抢焦点、不误绑新目标。不重命名或删除旧 TEMP 目录。

## 实际验证

- `NODE_OPTIONS=--max-old-space-size=1200 node scripts/verify-repository-menu.mjs`：真实 Electron + Tailwind + LeftNav 源码片段，修复前稳定失败，修复后按下/松开保持、项目动作、Esc/外部关闭通过；触发器不位移。不是完整应用点验。
- `terminalInteraction.test.ts`：真实 React/Base UI 控件进入、Custom Shell、WebGL、主题下拉、离开重进通过；修复前开发栈复现，修复后无循环。
- `editorIntentInteraction.test.ts`：真实 editor hook/store 与 QueryClient，mock Monaco 显示层和文件 IPC，首次挂载、相对/绝对/Windows 路径、已有标签、行号、读取失败通知通过。不是实际 Monaco/Windows 点验。
- 首批 actions/scratch/Markdown 新测试：3 文件 72 项通过。
- 创建时间/Markdown 策略/editor intent/intent store：4 文件 112 项通过。
- 设置真实控件及分类、chatPiWorkerRouting、composerTarget：4 文件 90 项通过；editor 静态旧通知断言更新后 13 项通过。
- 路径归一化与 cursor：2 文件 28 项通过；Markdown 真实渲染 38 项通过。
- `tsc --noEmit`（1200 MiB 堆）通过；本轮文件 Biome 检查通过；不运行整套生产构建。

## 未验收

完整应用菜单/设置、真实 Monaco 挂载与行号、四类 cwd 的 /new 发送、TEMP 创建期间切换、Windows/加密机安装版尚未现场验证。529 恢复红框按新增反馈在 B 批处理。截图保留未跟踪，不进入提交。
