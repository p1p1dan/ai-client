# Roadmap — 设置清单整理与旧壳删除

> 本文件是本计划任务 ID、状态与顺序的唯一权威。
> 逐项证据行（哪个 key、哪个消费方、为什么判死）在
> [审计文档](../../../plans/2026-09-07-settings-inventory-audit.md)，本文件只维护任务身份与状态。

## 状态摘要

| 分组 | 数量 | 说明 |
|---|---|---|
| Done | 0 | — |
| In Progress | 0 | — |
| Next | 7 | S04 → S01 → S02 → S03 → S05 → S06 → S07 |
| Deferred | 0 | — |
| 另立任务 | 3 | Agent 通知按 pix 重做 · git stash 完整链路 · behavior/environment 两个候选段 |

## 执行顺序

```text
S04 删纯死设置（与旧壳无关，随时可走）
→ S01 全局搜索移植   ┐
→ S02 仓库设置入口   ├ 补齐线：三条全部合入后才允许删旧壳
→ S03 分支切换移植   ┘
→ S05 删旧壳
→ S06 删随旧壳失效的 13 组设置
→ S07 分类重排为 9 类 + 统一设置行原语
```

**S04 排最前**的理由：零依赖、零风险、纯删除，先把「改了也不生效」的三个开关从界面上拿掉。

## 通用门禁

每个任务合入前：`pnpm lint` · `pnpm typecheck` · `pnpm test` 三绿。
**删除类任务额外要求一条静态不变量测试**，断言被删的东西没有偷偷长回来
（范式同 `App/__tests__/shellSwitchStatic.test.ts` 与 Pi 计划的 legacy execution absence 测试）。
GUI 点验并入 UI 对齐计划的累计点验，不单独开轮次。

## 任务

### S01 — 全局搜索移植进新壳 · **Next**

`GlobalSearchDialog` / `useGlobalSearch` / `SearchResultList` / `SearchPreviewPanel` 四件现成，
入口却只有旧壳的 `FilePanel` / `CurrentFilePanel` / `FileSidebar`；
新壳 `FilesSurfaceView` **没有任何搜索入口**。

- **做什么**：在 `FilesSurfaceView` 给出搜索入口，并让 `searchKeybindings`（搜文件 / 搜内容）在新壳生效。
- **验收**：新壳下两个快捷键能唤起对话框；文件名与内容两种搜索都能出结果并跳转到编辑器。
- **阻塞**：S05。这是硬能力，丢了就是产品倒退。

### S02 — 仓库设置入口补进新壳 · **Next**

`RepositorySettingsDialog` 三项里，**初始化脚本与 worktree 自动初始化的执行链路在新壳仍然生效**
（`App.tsx:1251` 建 worktree 时读取执行、`TerminalPanel` 也用），只是配置入口在旧壳。
删旧壳而不补入口 = 脚本照跑、用户永远改不了。

- **做什么**：对话框瘦成两项（自动初始化 + 初始化脚本），补进 LeftNav 仓库行菜单；
  删掉「隐藏仓库」项（新壳不消费 `hidden`）与整个 `RepositoryManagerDialog`
  （显示/隐藏仓库不消费、移除仓库与 `WorkspaceShell.onRemoveRepository` 重复）。
- **验收**：新壳里能改某仓的初始化脚本；改完新建 worktree 时脚本按新值执行。
- **阻塞**：S05。

### S03 — 分支切换补进 GitSurfaceView · **Next**

`BranchSwitcher.tsx`（236 行）现成：本地/远程分支列表、搜索、新建分支。
`GitSurfaceView.tsx:15-16` 的头注释目前**明文禁止**引入它。

- **做什么**：解掉该 ban（同时改写头注释说明新边界）、在 Git 面板头部给出分支切换入口。
- **不做**：sync / publish / PR / revert / reset —— 用户 2026-09-07 未列入，按弃处理。
- **验收**：新壳 Git 面板能切换本地与远程分支、能新建分支；切换后改动列表与历史同步刷新。
- **阻塞**：S05。

### S04 — 删纯死设置（A 清单）· **Next**

| 项 | 判死依据 |
|---|---|
| Agent 通知 ▸ 启用通知 / 空闲时间 / Enter 延迟 | `agentNotification*` 全仓零消费方；系统通知由 `chat/ExtensionUiSurfaces.tsx:109` 直接触发，不读这三项 |
| `fileTreeAutoReveal` | 无 UI 入口，唯一消费方 `files/FilePanel.tsx` 只在旧壳 |
| `terminalInput.{enhancedInputEnabled,enhancedInputAutoPopup}` | 无 UI 入口，唯一消费方 `chat/AgentPanel.tsx:1205` 只在旧壳 |

- **做什么**：删 UI、store 字段、setter 与迁移里的对应处理；`migration.ts` 需保证老 profile 带着这些键也能正常水合。
- **验收**：静态不变量测试断言三个 `agentNotification*` 键与 `terminalInput` 在 `SettingsState` 中不存在；
  老 profile 载入不报错、不丢其他设置。
- **依赖**：无。

### S05 — 删旧壳 · **Next**

- **做什么**：删 `App.tsx:1446-1845` 的旧壳分支与 `useOpenChamberShell` 开关（及
  `shellPreferenceMirror` 与 `shellSwitchStatic` / `shellPreferenceMirror` 两个只为开关存在的测试），
  删旧壳独有且已判弃的组件：`layout/MainContent` · `TreeSidebar` · `RepositorySidebar` ·
  `WorktreePanel` · `ActionPanel` · `RunningProjectsPopover` · `app/OpenInMenu`（+`useAppDetector`） ·
  `chat/AgentPanel` · `AgentGroup` · `AgentSessionTabs` · `EnhancedInput(Container)` · `QuickTerminalModal` ·
  `group/` 五件 · `files/FilePanel` · `CurrentFilePanel` · `FileSidebar` ·
  `source-control/SourceControlPanel` 及其旧壳专属子件 · `temp-workspace/TempWorkspaceContextMenu` ·
  `repository/RepositoryManagerDialog` · `settings/DraggableSettingsWindow`。
- **前置**：S01 / S02 / S03 **全部合入**。
- **验收**：静态不变量测试断言 `useOpenChamberShell` 与 `MainContent` 不再存在；
  三绿；新壳全流程（选仓库 → 会话 → 文件 → git → 终端 → 设置）可用。
- **风险**：闭包对比给出的旧壳独有文件是 78 个（含 `components/ui/`），**逐个确认再删**，
  不按目录整删；任何一个被新壳间接引用的都要留下。

### S06 — 删随旧壳失效的 13 组设置（B 清单）· **Next**

布局模式 · 文件树展示 · 仓库列表展示 · 快速终端（含 4 个位置/尺寸键）· 隐藏分组 ·
快速打开（应用过滤 + 隐藏列表）· Glow Effect · 主标签快捷键（4）· 搜索快捷键（2，
**若 S01 已让它在新壳生效则保留**）· Running Projects 快捷键 · 工作区快捷键（3）·
设置显示方式（`settingsDisplayMode` + `settingsModalPosition`）· OpenChamber Beta 开关本身。

- **注意**：搜索快捷键是唯一可能「保下来」的一组，取决于 S01 的落地形态。
- **依赖**：S05。
- **验收**：静态不变量断言这批键不在 `SettingsState`；`migration.ts` 对老 profile 容错。

### S07 — 分类重排为 9 类 + 统一设置行原语 · **Next**

目标结构（审计文档 §11）：通用 · 外观 · **终端**（三块合一，Option as Meta 从键位表移入）·
编辑器 · **Git**（Worktree / Clone / 自动刷新 + 三个 AI 生成器）· **Pi**（模型 / 权限 / 资源三段合一）·
快捷键（终端 7 + 编辑器 1 + 版本控制 2）· **网络**（代理 + 远程连接）· **高级**（日志 + Web Inspector）。

- **连带**：引入统一的 `SettingsPageShell` / `SettingsSectionBlock` / 设置行原语（对齐 pix 的
  `SettingsPrimitives.tsx`），顺带修掉 `PiModelManagementSettings` 与 `PermissionPolicySettings`
  的硬编码中文——它们正是「每个面板各写各的」长出来的。
- **依赖**：S04 + S06（删干净了才知道每类还剩什么）。
- **验收**：`settingsCategories.test.ts` 随新分类更新并通过；每个面板的字符串全部走 `t()`。

## 另立任务（不属本计划）

| 任务 | 为什么不在本轮 |
|---|---|
| Agent 通知按 pix 重做（6 开关 + 测试按钮 + 打开系统设置） | 本轮是减法；重做是加法，用户拍板「先删，之后另立」 |
| git stash 完整链路 | 后端 stash 只服务 merge 内部流程、`preload` 零暴露、前端无可复用 UI——新建链路而非移植 |
| `behavior` / `environment` 两个候选段 | pix 有而我们没有，属加法；记入 [ideas inbox](../../ideas/inbox.md) |
