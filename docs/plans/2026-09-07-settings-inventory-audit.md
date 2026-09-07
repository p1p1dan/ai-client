# 设置清单整理 —— 现状审计（讨论稿）

> 日期：2026-09-07 · 状态：**待讨论拍板**，尚未立项进 plantree。
> 目的：先把「设置页现在到底有多少项、哪些真的还在生效」摊开，再决定精简方案。
> 参考实现：`~/code/pix`（`apps/desktop/src/renderer/components/settings/`）。

## 1. 判定口径

**默认壳 = OpenChamber Workspace Shell。** `useOpenChamberShell` 默认 `true`
（`src/renderer/stores/settings/index.ts:202`），`App.tsx:1434` 按它二选一渲染
`WorkspaceShell` 或旧的标签页壳（`MainContent` + `RepositorySidebar/TreeSidebar`）。
历史结论是「**旧壳是回退不是产品**」（openchamber-chat-refactor T-16 归档台账）。

因此每个设置项有三种判定：

| 记号 | 含义 |
|---|---|
| ✅ 生效 | 默认壳下确实有消费方 |
| ⚠️ 仅旧壳 | 只有关掉 Beta 开关退回旧壳才生效，默认状态下是死开关 |
| ❌ 失效 | 全仓无消费方，或有消费方但无入口，改了什么也不会发生 |

方法：对 `SettingsState` 的 70 个状态字段逐个 grep 消费方，排除设置面板自身与测试，
再沿组件 import 链确认该消费方在默认壳下是否可达。

## 2. 结论摘要

- 设置分类 **10 个**，面板代码 **6634 行**，其中 `GeneralSettings.tsx` 一个文件 **1433 行 / 13 个分段**。
- **❌ 完全失效 5 项**（含 3 项有 UI 的开关）。
- **⚠️ 仅旧壳生效 13 组**（跨 General / Appearance / Keybindings 三个分类）。
- **🔁 同一领域被切成多处 2 处**（终端域切三块、Pi 域切四个分类）。
- 另有 **2 个字段有消费方但没有任何 UI**，只有默认值在生效。

## 3. 清单 A —— ❌ 完全失效（建议直接删）

| # | 设置项 | 位置 | 证据 |
|---|---|---|---|
| A1 | Agent Notifications ▸ 启用通知 | General:1039 | `agentNotificationEnabled` 全仓消费方 = 0，只有 store 与本面板 |
| A2 | Agent Notifications ▸ 空闲时间 | General:1039 | `agentNotificationDelay` 同上 |
| A3 | Agent Notifications ▸ Enter 延迟 | General:1039 | `agentNotificationEnterDelay` 同上 |
| A4 | 文件树自动定位 `fileTreeAutoReveal` | 无 UI | 唯一消费方 `files/FilePanel.tsx`，而 FilePanel 只被旧壳 `MainContent` 引用 —— 无入口 + 仅旧壳，双向死 |
| A5 | 增强输入 `terminalInput.{enhancedInputEnabled,enhancedInputAutoPopup}` | 无 UI | 唯一消费方 `chat/AgentPanel.tsx:1205`，AgentPanel 只被旧壳 `MainContent.tsx:20` 引用 |

补充：`main/ipc/notification.ts` 的系统通知是**存在且在用**的，但它由扩展 UI
（`chat/ExtensionUiSurfaces.tsx:109`）直接触发，完全不读 A1–A3 这三项。
即「通知功能是活的，通知设置是死的」。

**无 UI 但生效的存量键**（不算失效，但需决定要不要补 UI 或改成常量）：

- `fontSize: 14` / `fontFamily: 'Inter'`（应用级字体）—— 被 DiffViewer / EditorArea / SearchPreviewPanel /
  MergeEditor 读取，但设置页里**没有任何入口**（`setFontSize` / `setFontFamily` 零调用）。
- `chatAgentDefaults`（在 Composer 里管理）、`presentationMode`（在 SessionBar 的 GUI｜TUI 切换）——
  刻意不在设置页，正常。

## 4. 清单 B —— ⚠️ 仅旧壳生效（默认状态下是死开关）

| # | 设置项 | 位置 | 唯一消费路径 |
|---|---|---|---|
| B1 | 布局模式 Columns / Tree | General:479 | `layoutMode` → `MainContent` / `usePanelResize`（旧壳） |
| B2 | 文件树展示 整合树 / 独立侧栏 | General:513 | `fileTreeDisplayMode` → `App.tsx` 旧壳分支 + `MainContent` |
| B3 | 仓库列表展示 列表 / 标签 | General:547 | `repositoryListDisplayMode` → `SourceControlPanel`；新壳 `GitSurfaceView.tsx:14` 明文写着**禁止**引入 SourceControlPanel |
| B4 | 快速终端 Quick Terminal（含 4 个位置/尺寸键） | General:590 | `QuickTerminalModal` 只挂在 `AgentPanel`（旧壳） |
| B5 | 隐藏分组 Hide Groups | General:662 | 分组面板在 `TreeSidebar` / `RepositorySidebar`（旧壳）；`useGroupSync` 仍跑但无 UI 体现 |
| B6 | 快速打开 Quick Open（应用过滤 + 隐藏列表） | General:670–720 | `OpenInMenu` 只被 `MainContent.tsx:499` 渲染 |
| B7 | Beta ▸ Glow Effect | Appearance:24 | `GlowCard/GlowBorder` 消费方 = `WorktreeCard` / `TreeSidebar` / `WorktreePanel`，全在旧壳 |
| B8 | 快捷键 ▸ 主标签切换（4 个键位） | Keybindings:10 | `mainTabShortcutGate.ts:20` —— 新壳下**整支让位**，新壳自己的 `Ctrl/Cmd+1..5` 是硬编码的 |
| B9 | 快捷键 ▸ 搜索（搜文件 / 搜内容） | Keybindings:16 | `FilePanel` / `CurrentFilePanel`（旧壳）；新壳 `FilesSurfaceView` **没有全局搜索入口** |
| B10 | 快捷键 ▸ 全局 ▸ Running Projects | Keybindings:2 | `<RunningProjectsPopover>` 三个渲染点全在旧壳（MainContent / RepositorySidebar / TreeSidebar） |
| B11 | 快捷键 ▸ 工作区（3 个键位） | Keybindings:5 | 回调是 `setRepositoryCollapsed` / `setWorktreeCollapsed`，即旧壳两个侧栏的收展 |
| B12 | 设置显示方式 标签页 / 浮窗（`settingsDisplayMode` + `settingsModalPosition`） | 无独立 UI | 切换入口只有旧壳 `MainContent.tsx:630`；`DraggableSettingsWindow` 只能切回标签页 |
| B13 | Beta ▸ OpenChamber Workspace Shell 开关本身 | Appearance:26 | 它是 B1–B12 的总闸；留着，B1–B12 就得留着 |

**B9 值得单独注意**：新壳目前没有全局文件/内容搜索入口，`GlobalSearchDialog` 只从旧壳三个文件面板打开。
这不是设置项问题，但删旧壳前必须先补这条链路，否则丢能力。

## 5. 清单 C —— 🔁 生效但被切碎（建议合并）

**C1 终端域被切成三块：**

- General ▸ Terminal：Shell、渲染器、回滚行数、选中即复制
- Appearance ▸ Terminal：配色方案、字体、字号、字重、粗体字重（+ 主题收藏）
- Keybindings ▸ Terminal：7 个键位 + 「Option as Meta」（一个**行为**开关混在键位表里）

**C2 Pi 域被切成四个分类：** `AI`（提交信息/代码评审/分支名三个生成器）、`Pi Models`、
`Permissions`、`Resources`。四者都是 Pi 运行时的配置，却是四个平级左栏条目，
而 `Pi Models` 与 `Permissions` 两个面板还是**硬编码中文**（「Pi 模型管理」「权限策略」），
其余面板一律走 `t()`。

**C3 General 是杂物抽屉：** 13 段 —— 语言 / 布局 / 文件树 / 仓库列表 / 快速终端 / 临时会话 /
隐藏分组 / 快速打开 / Worktree / Git Clone / 终端 / Agent 通知 / 代理 / 日志 / 更新。
删掉 B1–B6 与 A1–A3 之后，剩下的是：语言、临时会话、Worktree、Git Clone、终端、代理、日志、更新。

## 6. 清单 D —— ✅ 确认生效（保留）

- **General**：语言、临时会话（3 项）、Worktree（3 项）、Git Clone（3 项 + 域名映射表）、
  终端（Shell / 渲染器 / 回滚 / 选中即复制）、代理（4 项）、日志（4 项）、更新（2 项）
- **Appearance**：主题模式（4 档，含 sync-terminal）、阅读栏宽度、背景图（12 项）、终端外观（5 项 + 收藏）
- **Editor**：约 30 项，全部经 `editorSettings` 进 Monaco，新壳 `EditorColumn` 可达
- **Keybindings**：终端（7 键 + Option as Meta）、编辑器（Show Symbols）、版本控制（上/下一处改动）
- **AI**：三个生成器均走 Pi provider（`main/services/ai/providers.ts`），入口分别是
  GitSurfaceView 的 CommitBox、ChangesList 的 CodeReviewModal、Composer 目标栏的 CreateWorktreeDialog
- **Pi Models / Permissions / Resources**：均有对应 IPC（`ipc/piModels.ts` / `piPermissions.ts` / `piResources.ts`）
- **Remote Connection**：`ipc/remote.ts` + `services/remote/*` 齐全，新壳「添加仓库」对话框支持 remote/ssh
- **Web Inspector**：`ipc/webInspector.ts` + `services/webInspector/WebInspectorServer.ts` 齐全，默认关

## 7. 与 pix 的对照

pix 的设置分 **16 段**（`shell-store.ts:88`）：general / appearance / terminal / runtimes /
environment / worktree / behavior / git / usage / notifications / shortcuts / proxy /
models / piSettings / pi / archived。

可借鉴的点：

1. **分类更细、每段更薄**，而不是一个 General 装 13 段。terminal / worktree / git / proxy /
   notifications / shortcuts 都是独立一段。
2. **有我们没有的段**：`usage`（用量）、`archived`（归档会话管理）、`environment`（环境面板各块的显隐）、
   `behavior`（删除前确认这类行为开关）。
3. **统一的段内原语**：`SettingsPrimitives.tsx`（`SettingsPageShell` / `SettingsSectionBlock` / 行组件），
   我们这边每个面板各写各的 `<h3>` + 手搓行布局。
4. pix 的通知设置是**真的接了**（master / onComplete / onError / onHostCrash / onlyWhenUnfocused / sound
   + 测试按钮 + 打开系统设置），可作为 A1–A3 的另一条出路：不删，改成接上。

## 8. 待拍板的问题

- **Q1｜旧壳怎么办？** 三选一：(a) 连旧壳一起删，B1–B13 全清（需先补新壳的全局搜索，见 B9）；
  (b) 保留旧壳但把 B1–B12 从设置页移走（旧壳内部自管），设置页只留总闸；
  (c) 现状不动，只在这些项上标注「仅旧壳」。
- **Q2｜Agent 通知是删还是接？** 删 = 清掉 A1–A3；接 = 按 pix 的通知段重做一个真的能用的通知设置。
- **Q3｜终端域三块合一？** 是否把 General▸Terminal + Appearance▸Terminal + Keybindings▸Terminal
  合成一个独立的 `Terminal` 分类（Option as Meta 归行为，不归键位）。
- **Q4｜Pi 四类合一？** `AI` / `Pi Models` / `Permissions` / `Resources` 是否收成一个 `Pi` 分类下的四段。
- **Q5｜要不要补 pix 有而我们没有的段？**（usage / archived / behavior）—— 这是加法，不是精简，需要单独判断。
- **Q6｜要不要引入统一的设置原语组件？** 对齐 pix 的 `SettingsPrimitives`，顺带解决两个面板硬编码中文的问题。

## 9. 备注

本文只做现状取证与选项陈列，**不含任何代码改动**。拍板后再按 plantree 规矩立计划、
写 roadmap 与验收，删除项须逐条留证据行（哪个 key、哪个消费方、为什么判死）。

---

# 第二轮：2026-09-07 拍板与追加取证

## 10. 已拍板

1. **Q1 = 连旧壳一起删**：`useOpenChamberShell` 开关、旧标签页壳、B1–B13 全清。
2. **Q2 = Agent 通知先删**（A1–A3 + 三个 store 字段），「按 pix 重做通知」另立任务。
3. **Q4 = 四个新段一起评估后再定**（见 §12）。
4. Q3 分类重排由本文给建议（见 §11）。

## 11. 分类重排建议

**结论：要重排，但重排是删除的副产品，不是独立的大动作。** 删掉 A 与 B 两份清单后，
General 从 13 段掉到 3 段、Keybindings 从 7 组掉到 3 组，现有的 10 分类结构会明显失衡；
与其保留一个空壳 General，不如按领域重切。

建议目标结构 **9 类**（当前 10 类）：

| # | 分类 | 内容 | 来源 |
|---|---|---|---|
| 1 | 通用 | 语言、临时会话（3）、更新（2） | General 瘦身后的残余 |
| 2 | 外观 | 主题模式、阅读栏宽度、背景图（12） | Appearance 去掉 Beta 段 |
| 3 | 终端 | Shell、渲染器、回滚行数、选中即复制、配色、字体、字号、字重、**Option as Meta** | C1 三块合一 |
| 4 | 编辑器 | 现有约 30 项 | 不动 |
| 5 | Git | Worktree（3）、Git Clone（3 + 映射表）、自动刷新、**三个 AI 生成器** | AI 三项的入口全在 Git 面（CommitBox / ChangesList / Composer 目标栏），归 Git 比归「AI」更贴实际 |
| 6 | Pi | 模型、权限、资源 三段 | C2 四类收一类，顺带修硬编码中文 |
| 7 | 快捷键 | 终端（7）、编辑器（1）、版本控制（2） | 保留独立分类（pix 也保留 `shortcuts`），但把 Option as Meta 移去「终端」——它是行为不是键位 |
| 8 | 网络 | 代理（4）、远程连接 | 两者都是连接配置，现在一个埋在 General、一个是顶级分类 |
| 9 | 高级 | 日志（4）、Web Inspector | 两个低频诊断类功能 |

同时建议引入统一的段内原语（对齐 pix 的 `SettingsPrimitives`：`SettingsPageShell` /
`SettingsSectionBlock` / 设置行），现在每个面板各写各的 `<h3>` + 手搓行布局，
硬编码中文也是这么长出来的。

## 12. pix 四个新段的评估结论

| 段 | 我们的现状 | 结论 |
|---|---|---|
| `usage` 用量 | 数据链路已有（`services/usage/UsageService` + `IPC_CHANNELS.USAGE_GET_STATS`），且**已经在三处展示**：`UserFooterPill`、`RunSurfaceView`、`UserProfileCard` | **不做**。设置页再开一段是第四个展示点，制造权威分裂 |
| `archived` 归档会话 | 归档管理已在 `SessionBar` / `LeftNav` 就地提供，批量归档刚随 U28–U31 落地 | **不做**。同上，就地管理优于设置页第二入口 |
| `behavior` 行为开关 | 我们没有对应段；删除动作是否都有确认弹窗未盘点 | **本轮不做，登记为候选**。要做得先盘点现有删除路径 |
| `environment` 环境面板显隐 | 对应物是左栏 dock 的 surface 显隐（`surfaceRegistry.ts` 注册 12 个 id、实际渲染 5 个） | **本轮不做，登记为候选**。它属于 UI 对齐计划的范畴，不属于「清理失效设置」 |

四段本轮都不进；`behavior` 与 `environment` 记入 plantree 的 ideas inbox。

## 13. ⚠️ 删旧壳的能力缺口（新发现，需逐条拍板）

用 import 闭包对比「`workspace-shell` 可达」与「旧壳五个入口可达」两个集合
（脚本见本轮 scratchpad，`workspace-shell` 279 文件 / 旧壳 197 文件 / 旧壳独有 78 文件），
排除 `components/ui/` 与设置面板自身后，**下面这些能力只有旧壳有**。删旧壳 = 要么补到新壳，要么明确弃掉：

| # | 能力 | 只在旧壳的证据 | 我的建议 |
|---|---|---|---|
| G1 | **全局搜索（文件名 + 内容）** | `GlobalSearchDialog` / `useGlobalSearch` / `SearchResultList` / `SearchPreviewPanel`，入口只有 `FilePanel` / `CurrentFilePanel` / `FileSidebar`；新壳 `FilesSurfaceView` 无搜索入口 | **必须补**。这是硬能力，丢了就是产品倒退 |
| G2 | **仓库分组管理** | `group/` 五个组件（创建/编辑/选择/移动/emoji）只被旧壳两个侧栏引用；新壳 `LeftNav` 无分组概念 | **需你拍**：补到 LeftNav，还是承认新壳的扁平仓库树就是最终形态（那 `hideGroups` 也一并删） |
| G3 | **仓库管理 / 单仓设置对话框** | `RepositoryManagerDialog` / `RepositorySettingsDialog` 只在 `TreeSidebar` / `RepositorySidebar` 渲染 | **需你拍**。单仓设置若有真实用途，要在新壳给入口 |
| G4 | **Git 动作：分支切换 / sync / publish / stash / PR / 提交右键 revert·reset** | `GitSurfaceView.tsx:15-16` 头注释**明文禁止**引入 `RepositoryList` / `BranchSwitcher` 与 branch/PR/sync/stash 动作；这些只在旧壳 `SourceControlPanel` 一侧 | **需你拍**。这是当初新壳刻意的减法，删旧壳等于把「减法」变成「永久没有」 |
| G5 | 跨仓「运行中项目」弹层 | `<RunningProjectsPopover>` 三个渲染点全在旧壳 | 建议弃（新壳 LeftNav 的会话树已覆盖大部分场景） |
| G6 | 「在外部应用中打开」菜单 | `OpenInMenu` 只被 `MainContent.tsx:499` 渲染 | 建议弃，连带删 B6 的 Quick Open 设置 |
| G7 | 快速终端浮窗 | `QuickTerminalModal` 只挂在 `AgentPanel` | 建议弃（新壳有 terminal surface） |
| G8 | 临时会话右键菜单 | `TempWorkspaceContextMenu` 只在旧壳 | 建议弃或就地补进 LeftNav |
| G9 | 设置浮窗切换入口 | 浮窗组件 `DraggableSettingsWindow` 渲染在 `App.tsx:1983`（共享），但「切成浮窗」的入口只有 `MainContent.tsx:630` | 建议弃：删 `settingsDisplayMode` / `settingsModalPosition` 与浮窗组件 |

另需注意：`BackgroundLayer` 渲染在 `App.tsx:1422`，**在分支之外**，背景图设置不受删旧壳影响。
旧壳分支的实际范围是 `App.tsx:1446-1845`。

## 14. 下一步

G1–G4 拍板后即可立项：本任务实际会拆成两条线 ——
**(1) 删除线**（旧壳 + A/B 两份清单 + 分类重排），
**(2) 补齐线**（G1 必补，G2–G4 视拍板）。补齐线必须先于删除线合入，否则中间态会丢能力。

---

# 第三轮：G2–G9 拍板与 G3/G4 追加取证

## 15. 本轮拍板

- **G2 = 弃掉分组**：删 `group/` 五个组件、`hideGroups` 设置与分组存储链路，承认新壳的扁平仓库树是最终形态。
- **G5–G9 = 全弃**：跨仓运行中项目弹层、在外部应用中打开菜单、快速终端浮窗、临时会话右键菜单、设置浮窗切换，
  连同对应设置（Quick Open 过滤、`quickTerminal`、`settingsDisplayMode` / `settingsModalPosition`）一并删除。
- **G4 = 需要补齐但优先级不高**，用户点名要保住：改动、提交、历史、分支切换、stash。
- **G3 = 先查清对话框内容再定**（结论见 §16）。

## 16. G3 追加取证：两个仓库对话框里到底有什么

**`RepositorySettingsDialog`（139 行）三项：**

| 项 | 新壳是否消费 | 判断 |
|---|---|---|
| 隐藏仓库 `hidden` | ❌ 只有 `RepositoryManagerDialog` 自己读 | 弃 |
| worktree 自动初始化 | ✅ **功能在新壳仍然生效** | 保 |
| 初始化脚本 `initScript` | ✅ `App.tsx:1251` 建 worktree 时读取执行、`TerminalPanel` 也用（新壳 terminal surface 可达） | 保 |

**关键结论**：初始化脚本这条链路**在新壳里照常运行，只是没有配置入口**——
删掉旧壳等于「脚本会跑，但用户永远改不了它」。这是本轮最不能漏的一条。

**`RepositoryManagerDialog`（200 行）两项：** 显示/隐藏仓库（新壳不消费，弃）、
移除仓库（新壳 `WorkspaceShell` 已有 `onRemoveRepository`，重复）。→ **整体弃**。

**建议**：只把 `RepositorySettingsDialog` 精简成两项（自动初始化 + 初始化脚本）后补进新壳
LeftNav 的仓库行菜单；`RepositoryManagerDialog` 删除。

## 17. G4 追加取证与我的意见

| 能力 | 现状 | 我的意见 |
|---|---|---|
| 改动 / 提交 / 历史 | ✅ 新壳 `GitSurfaceView` 已有（`ChangesList` / `CommitBox` / `GitHistoryList`） | 无缺口 |
| **分支切换** | `BranchSwitcher.tsx`（236 行）现成：本地/远程分支列表、搜索、新建分支 | **建议补**。成本只是解掉 `GitSurfaceView` 的 ban + 在面板头部给位置，是纯移植 |
| **stash** | 后端 `WorktreeService` 有 49 处 stash，但**只服务于 merge worktree 内部流程**；`preload` 零暴露、前端无任何 stash UI（`MergeWorktreeDialog` 那 8 处是 merge 流程内部用） | **建议另立任务**。这不是从旧壳移植，是后端 IPC + 前端 UI 从零新建一条链路，塞进本轮会把删除线拖长 |
| sync / publish / PR / revert / reset | 只在旧壳 | 按用户未列入处理 = 弃 |

## 18. 任务最终形态（待确认后立项）

**补齐线（必须先于删除线合入）**

1. P1 全局搜索移植进新壳 `FilesSurfaceView`（G1，硬能力）
2. P2 仓库设置对话框精简后补入口（G3，保住初始化脚本的可配置性）
3. P3 分支切换补进 `GitSurfaceView`（G4 移植部分）

**删除线**

4. D1 删 A 清单：Agent 通知三项 + `fileTreeAutoReveal` + 增强输入两键
5. D2 删旧壳：`App.tsx:1446-1845` 分支、`useOpenChamberShell` 开关、旧壳独有 78 文件中确认弃掉的部分（G2、G5–G9）
6. D3 删 B 清单 13 组随旧壳失去意义的设置
7. D4 分类重排为 §11 的 9 类 + 统一设置行原语

**另立任务（不进本轮）**

- Agent 通知按 pix 重做（Q2）
- git stash 完整链路（G4）
- `behavior` / `environment` 两个候选段（§12）
