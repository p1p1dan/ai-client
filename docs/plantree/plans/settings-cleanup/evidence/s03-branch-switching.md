# S03 新壳分支切换

日期：2026-09-07。实现与相关逻辑测试完成，完整门禁和 GUI 验收待完成，尚未合入。

## 实现

- 适配移植本仓 source-control/BranchSwitcher，在 GitSurfaceView 的改动/历史区域顶部接入。
- 支持本地/远程分支选择、新建分支与失败提示，工作区改变时重新挂载控制器。
- 文件头的动作禁令只放开分支切换与创建；PR、sync、publish、stash、revert、reset 继续不在范围内。
- 复用 useGitBranches/useGitCheckout/useGitCreateBranch，未引入新 IPC。
- GitService.createBranch 调用 checkoutBranch，本身改变 HEAD。因此创建后不再额外 checkout，而是与切换共用八组 Git 缓存刷新，包含状态、改动、diff、历史及子模块。

## 验证

- `gitBranchMutations.test.ts`：4 项，通过。真实 React Query mutation 验证本地/远程分支参数、创建后完整失效、其他仓库缓存隔离、失败时保留缓存。
- `gitQueryKeys.test.ts`：31 项，通过，确认已有缓存键规范保持兼容。
- 真实 Electron 中的下拉菜单、远程跟踪、新建分支及切换后的改动/历史展示，尚未 GUI 验收。
