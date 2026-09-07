# S02 新壳仓库设置入口

日期：2026-09-07。实现与相关测试完成，完整门禁和 GUI 验收待完成，尚未合入。

## 实现

- LeftNav 仓库行增加操作菜单，提供仓库设置与原有的移除仓库操作；移除仍走已有确认对话框。
- 复用 RepositorySettingsDialog 与 App/storage 的持久化函数，初始化脚本的运行消费方继续读取同一个存储键。
- 对话框删除隐藏仓库项，保留自动初始化和初始化脚本。
- 删除 RepositoryManagerDialog 及 TreeSidebar 中的按钮、状态、挂载和 import。
- 仓库级 `hidden` 的持久化类型尚服务旧壳，随 S05/S06 后续清理；本任务不删除旧壳。

## 验证

- `RepositorySettingsDialog.test.ts`：2 项，通过。
- 使用真实 React、对话框控件及 localStorage，修改脚本并保存；确认所选仓库更新，另一仓库保持原值，隐藏项不再渲染。
- 静态不变量验证新壳接入与旧管理对话框删除。
- 旧 `sessionContextMenuWiring.test.ts` 原先抓取文件中第一个 MenuPopup；新增仓库菜单后，将其限定在会话 ContextMenu Trigger 之后，四项回归通过。
- 真实 Electron 中从仓库行打开对话框、新建 worktree 并执行新脚本，尚未 GUI 验收。
