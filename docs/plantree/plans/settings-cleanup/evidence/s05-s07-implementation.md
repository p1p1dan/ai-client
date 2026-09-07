# S05–S07 实现证据

## 授权与提交边界

2026-09-07 用户明确允许改代码、根据实际情况开展，并允许先提交再执行。
先将 S01–S04 保存为 `deba6cd7`，再在 `feat/model-catalog-admin` 分支继续 S05–S07。
本地提交不等于合入主分支；任务保留 In Progress，完整验收待完成。

## S05：旧壳删除

- App 仅渲染 WorkspaceShell，删除旧壳条件分支、切换开关及同步镜像。
- 删除旧壳专属源码 58 个和失去对象的测试 5 个；新增旧壳删除不变量测试。
- 逐项追踪静态 import、动态 import 和 barrel export；终端面板、ShellTerminal、文件树、编辑器、搜索、BranchSwitcher 和 DiffViewer 保留。
- 旧设置浮窗由普通 SettingsDialog 取代，分类内容统一来自 SettingsContent。菜单、dock、`/settings` 复用同一个打开状态；权限面板接收仓库路径。
- 删除旧 Action Panel 的主进程菜单入口及快捷键消费者，添加仓库对话框去掉分组 UI。历史仓库分组数据不做破坏性迁移，新增仓库不再分组。

## 补齐 S02 的初始化消费链路

删除 App 的旧创建回调时发现，新壳 TargetBranchSelect 使用共享 useWorktreeCreate，原来的初始化脚本调度只位于旧回调中。

- 将调度移到 useWorktreeCreate 成功回调：读取该仓库最新保存的配置，只有启用且脚本非空时才排队。
- pendingScript 使用新 worktree 路径；TargetBranchSelect 原有的树刷新与目标切换逻辑保留，TerminalPanel 仅在 cwd 匹配后消费脚本。
- 原终端导航按既有产品决策保持隐藏。新增专用 `openInitializationTerminal` 状态机动作，仅供成功创建后的脚本初始化使用；普通 open/select 与 rail、快捷键策略不变。
- 新增 5 项测试验证最新配置、目标路径、禁用、空脚本、创建失败，以及普通终端导航仍不可打开。真实 PTY 执行和 GUI 仍待点验。

## S06：旧设置清理

删除布局、文件树展示、仓库列表展示、快速终端、分组、外部应用过滤、Glow、主标签快捷键、Running Projects 快捷键、工作区快捷键、设置浮窗方式与位置、旧壳开关。
同步移除类型、默认值、setter、UI 和快速终端会话状态。

`migrateSettings` 与磁盘清理使用同一删除键清单，兼容旧 profile。
测试覆盖删除键不会复活、重复迁移幂等、其他 namespace 与语言/编辑器/代理/AI 配置不丢失。
S01 已接入新壳的文件名与内容搜索快捷键保留，并验证自定义绑定水合后不变。

## S07：分类和设置原语

| 分类 | 内容 |
|---|---|
| 通用 | 语言、临时会话、更新 |
| 外观 | 应用主题、阅读宽度、背景 |
| 终端 | Shell、渲染器、滚动历史、复制、Option as Meta、终端主题与字体 |
| 编辑器 | 原编辑器设置 |
| Git | Worktree、Clone、自动刷新、提交消息/分支名/代码审查生成器 |
| Pi | 模型、权限、资源 |
| 快捷键 | 终端 7、编辑器 1、版本控制 2、搜索 2 |
| 网络 | 代理、远程连接 |
| 高级 | 日志、Web Inspector |

- 新增 SettingsPageShell、SettingsSectionBlock、SettingsRow，基于本仓 Field、Select、Switch 等现有原语；不修改 globals.css。
- 参考 `/home/pi/code/pix/apps/desktop/src/renderer/components/settings/SettingsPrimitives.tsx`，采用“适配移植”：沿用页面/分区/行的组织方式，按本仓 coss/base-ui 和 Tailwind token 实现；不采用 pix 的 shadcn 控件和卡片嵌套外观。
- General 与 Appearance 按实际领域拆开，避免隐藏整段控件但仍挂载无关 effect。迁移前后核对 store 绑定集合，缺少的绑定仅为批准删除项。
- 修复重排中发现的快捷键行遗漏，新增真实 React 录制测试，验证 12 个控件存在且保存搜索绑定时保留另一项。
- 设置分类导航在窄窗口横向滚动，设置行窄窗口改为单列。普通设置对话框统一分类渲染，避免浮窗与对话框维护两份列表。
- 旧分类书签 ai → git，piModels/piPermissions/piResources → pi，remote → network，webInspector → advanced；未知值回退 general。
- Pi 模型管理、权限页及权限来源/验证提示接入国际化；英文模型默认选项和背景填充方式一并补齐翻译。

## 验证边界

详细结果见 [本轮验证记录](./2026-09-07-s05-s07-validation.md)。自动化测试不替代真实 Electron GUI 和 PTY 脚本执行点验，也不代表已合入主分支。
