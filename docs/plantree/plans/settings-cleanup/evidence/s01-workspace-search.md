# S01 新壳全局搜索

日期：2026-09-07。实现与相关测试完成，完整门禁和 GUI 验收待完成，尚未合入。

## 实现

- 适配移植本仓 `GlobalSearchDialog`、`useGlobalSearch`、`SearchResultList` 与 `SearchPreviewPanel`。
- `FilesSurfaceView` 增加文件名、内容搜索两个图标入口；复用现有按钮和国际化字符串。
- `WorkspaceShell` 常驻挂载搜索控制器和对话框，入口经 LeftDock 传递；快捷键不依赖 Files surface 是否挂载。
- 快捷键读取现有 `searchKeybindings`，忽略输入法组合、重复键、已处理事件与模态对话框；没有工作区时不触发。
- 搜索根目录采用现有 active session/workspace 链路。工作区切换时关闭搜索，文件读取完成前通过 `stillValid` 再校验根目录，避免打开其他工作区的文件。
- 修复原搜索 hook 的取消失效问题：IPC 无法中断，但旧请求的结果和错误不能再更新当前状态；修改查询时立即取消旧请求，不等待 debounce。

## 验证

- `workspaceSearchShortcuts.test.ts`：3 项，通过，覆盖默认/自定义快捷键、IME 与事件过滤、常驻挂载边界。
- `useWorkspaceSearch.test.ts`：3 项，通过，使用实际 React 生命周期与键盘事件，覆盖无文件面板时唤起、模态抑制、工作区切换与坐标传递。
- `useGlobalSearch.test.ts`：5 项，通过，覆盖乱序回复、debounce 期间修改查询、关闭后迟到回复、文件名切内容搜索、清空查询后切模式不残留加载状态。
- `SearchServiceRipgrep.test.ts`：8 项真实 ripgrep 文件搜索集成测试通过；初次失败因项目二进制未安装，安装后复跑通过。
- 新增开发依赖 happy-dom，仅上述 DOM 测试按文件启用，不改变其他 Vitest 文件的 Node 环境。
- 真实 Electron 中的文件搜索结果、内容搜索结果及 Monaco 定位尚未 GUI 验收。
