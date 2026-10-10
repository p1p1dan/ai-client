# 决策 170：「聊天」侧栏分三区、字号 16 / 15 / 14、对话标题降一级颜色、「正在活动」5 条、仓库按活动排序与全部折叠（GitHub issue #6，第一波）

日期：2026-10-10。**状态：第 1 节为用户裁决（2026-10-10，issue #6 与预览 v1～v4 的答复）；第 2 节起为自主决定，待用户审批。**

来源：GitHub issue #6「侧栏分区固定 + 字号层级 + 最近折叠 + 仓库列表全部折叠」（dssaiy，`1.1.0-dsh.8`，Windows 11）。四条期望：三个板块各自独立分区、互不挤压；字号板块 > 文件夹 > 对话逐级变小、颜色有区分度，并写进设计规范；「最近」上限 5、超过的折叠；「仓库列表」标题栏加「全部折叠」。

**验收基准是原型**：[`evidence/sidebar-regions-2026-10/`](../evidence/sidebar-regions-2026-10/README.md) 的 `prototype.html`（默认视图即 v4 定稿，用户已认可）与同目录 README（v1 的「落地要点」「需要推翻或修订的条款」，v2～v4 的增量）。实现照原型的类名、尺寸、颜色落地，偏差逐条列在第 3 节。设计规范已改写：[`docs/design-system.md`](../../../../design-system.md)「侧栏层级（聊天面板）」整节，以及 Typography、Color System、字距、高度、宽度预算几处。代码提交：`c4d72932`（侧栏）、`d3660290`（设计规范）。

**本决策只管第一波（侧栏）。** 首页（`HomeView`、`ChatWorkspace` 的自动选中、启动种子）、输入框与工作栏、侧栏「＋新建」与文件夹「＋」的新行为（改为回首页并预选仓库）、导轨上的「首页」入口，由第二波另起决策；本波这些都保持 dsh.8 的样子。

修订关系：

- **决策 [167](167-sidebar-hierarchy.md)**（#3 的实现）：
  - 第 1 条（「正在活动」并进「最近」，上段不设上限、下段「48 小时内」7 条）：**推翻**。侧栏顶区只剩「正在活动」，最多 5 条；「48 小时内」段与段落小标签删除（移到首页）。
  - 第 4 条：L1 15px → 16px；「在本板块内吸顶（`bg-background` + 内层 `bg-card/40`）、背景图模式下不吸顶、视口 `scroll-pt-8`」**作废**（标题不在任何滚动区里）；「仓库列表」标题的图标位从两个（筛选 / 添加，D21）变为三个（全部折叠 / 筛选 / 添加）。
  - 第 6 条：`DockTitle` 15px 600 → 16px 600；会话栏标题 15px 400 → 16px 400。
  - 第 7 条：「列表根 `p-2`、板块之间 `mt-2` + 通栏 `border-t`」→ 三区首尾相接，区之间只有通栏 `border-t`，区内容 `px-2 pt-0.5 pb-2`；横坐标一条不变。
  - 第 12 条（「48 小时内」小标签、两段各一个 `role="group"`）：作废。
  - 第 15 条里 `deriveRecentRows` 的 `excludeSessionIds`：随 `deriveRecentRows` 一起删除。
  - 第 19 条里的视口 `scroll-pt-8`（对话行的 `focus-visible:bg-hover` 不变）、第 20 条（吸顶的实现）、第 21 条（列表根 `isolate`）：作废。
  - 第 23 条（临时对话的折叠）不变，它现在是固定在底部的区；第 24 条（`DockTitle` 连带另外四个面板）照旧成立，字号改为 16px。
  - 第 26 节第 2 条（`isolate`、`scroll-pt-8` 的偏差）、第 3 条（两段 `role="group"`）：随之作废。
  - 其余不变：五级、`w-4` 状态槽、分支只在文件夹行显示、三行悬停提示、搜索框、圆角、告警徽标 `lg`、悬停按钮 `size-5 sm:size-5`。
- **决策 [137](137-user-ruling-sidebar-active-and-folders.md)**：
  - 第 1 条：「正在活动」回到独立一区（原文就是独立一节），加 5 条上限与「查看更多（N）」。
  - 第 2 条（「最近」首次默认折叠、存储键 `aiclient-sidebar-recent-collapsed`）：**作废**，存储键不迁移。
  - 第 3、4 条不变。
- [决策 138](138-p1-7e-e1-sidebar-choices.md) 第 3 条（「最近」的默认值）：随「最近」作废。
- [决策 145](145-p1-7e-e6-choices.md) 第 13 条（「查看更多（N）」的写法）：沿用到「正在活动」。
- D21（仓库列表标题保留筛选 / 添加两个图标位）：前面加「全部折叠」，共三个。
- `docs/design-system.md`：「Typography」里「`--text-title` 是唯一 >15px 的档」与「不用字号做标题层级」两处，分别改为「新增 16px 档」与「侧栏聊天面板是唯一例外」。

## 1 用户裁决（2026-10-10）

依据：issue #6；预览 v1 看后的五条、v2 看后的三条、v3 看后的一段话、v4 的认可（详见 [README](../evidence/sidebar-regions-2026-10/README.md) 各节）。下面只列第一波（侧栏）用到的结论。

1. **三个独立分区**，从上到下：
   - 「正在活动」：按内容高度，上限为侧栏列表区高度的 33%，超出时区内滚动；
   - 「仓库列表」：占剩余，独立滚动；
   - 「临时对话」：按内容高度，上限 25%，固定在底部，区内滚动。
   - L1 标题在各自滚动区之外，因此撤掉决策 167 的吸顶机制（`sticky`、两层底色、背景图退化、`isolate`、`scroll-pt-8`）。
   - 区的写法用原型验证过的两行 grid：`grid max-h-[33%] min-h-0 shrink-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)]`，`ScrollArea` 放第二行；`grid-cols-1` 不能省；`ScrollArea` 原语不改。
2. **顶区只剩「正在活动」**：L1 标题「正在活动」，最多 5 条 +「查看更多（N）」/「收起」；标题箭头收起 / 展开整个列表，状态只放内存、默认展开；**没有正在活动的对话时整区（连标题）不渲染**。「48 小时内」段与段落小标签删除（移到首页，第二波做）；决策 137 §2 的存储键废弃，不迁移。
3. **字号 16 / 15 / 14**：新字号 token `--text-section`（16px，行高 1.5，工具类 `text-section`）。
   - L0 面板标题 `DockTitle`（五个面板共用，Git / 文件 / 终端 / 运行一起变，已获同意）16px 600；
   - 中栏会话栏标题 16px 400；
   - L1 板块标题 16px 600 正文色、字距 `+0.04em`；
   - L2 文件夹名 15px 600 正文色；
   - L3 对话标题 14px 400 新颜色；
   - L4 辅助 14px 400 `muted-foreground` 不变。
4. **对话标题降一级颜色**：新 token `--foreground-soft`，取值为派生式 `color-mix(in oklab, var(--foreground) 50%, var(--muted-foreground))`（v1 看后选了 base-850 的派生写法），只在 `:root` 声明一次；`@theme` 补 `--color-foreground-soft` 桥接，工具类 `text-foreground-soft`，不许加 `/N`。**选中的对话恢复正文色**（`text-accent-foreground`）。
5. **「正在活动」与「临时对话」区加区底渐隐**（`ScrollArea` 现成的 `scrollFade="bottom"`）。
6. **仓库列表按活动时间排序**：文件夹按其内最近一个对话的最后活动时间降序；没有对话的文件夹排在后面，保持原有相对顺序；「临时工作区」文件夹固定最后。**指针或键盘焦点在仓库列表区内时冻结顺序，离开后再重排。**
7. **「仓库列表」标题栏加「全部折叠」**：Lucide `ChevronsDownUp`，按钮 `size-6`、图标 `size-3.5`，顺序「全部折叠、筛选、添加」；折叠仓库列表里所有文件夹（含「临时工作区」）；遍历全部文件夹，不能清空整张展开状态表；新词条「全部折叠」；只有折叠，没有「全部展开」。
8. `docs/design-system.md` 按新设计改写（README v1 第 5 节的清单）。

## 2 自主决定（待用户审批）

### 2.1 结构（`LeftNav.tsx`）

1. 列表区是 `flex min-h-0 flex-1 flex-col`，三个区写成模块级常量 `ACTIVE_REGION_CLASS`、`REPOSITORIES_REGION_CLASS`、`TEMPORARY_REGION_CLASS`，类名与原型一致。仓库列表只在「正在活动」存在时加 `border-t`，临时对话的常量自带 `border-t`。
2. 「仓库列表」与「临时对话」仍是右键菜单的触发区：`ContextMenu.Trigger render={<section className={…} />}` 直接渲染成区本身，菜单覆盖标题和区内空白。
3. 没有可用工作区时，「仓库列表」区换成引导卡片的区：`grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)]`（单行，没有标题），卡片放在区内的 `ScrollArea` 里（`p-2`）；「正在活动」与「临时对话」照常。dsh.8 在这种状态下不显示「最近」；现在按原型，有正在活动的对话（这时通常是临时对话）也显示「正在活动」区。
4. 区内滚动内容是两层：`px-2 pt-0.5 pb-2`，里面 `space-y-0.5`（行）或 `space-y-1`（文件夹组），与原型相同。
5. `SidebarSectionHeader` 只剩一层 `flex h-8 items-center px-4`；删除 `sidebarSectionClass`、`SidebarSegmentLabel`。

### 2.2 「正在活动」

1. 新纯函数 `limitActiveRows`（`sidebarTree.ts`）与 `ACTIVE_DEFAULT_LIMIT = 5`，返回形状同 `limitFolderRows`：前 5 条 +「查看更多（N）」；点了之后全部 +「收起」（本次运行内有效，同文件夹）。
2. **搜索时不受 5 条限制**，列出全部命中（同文件夹的规则：命中藏在按钮后面会被读成「没有这个对话」）。原型没有画搜索。
3. **不置顶选中的对话**：超过 5 条时它也可能被收进「查看更多」，它在所属文件夹里照常显示、照常高亮。这是 README v1「待确认」第 6 条的现状，用户没有要求置顶；文件夹的 8 条上限仍置顶（决策 137 §4）。
4. 箭头按钮除 `aria-label` 外也写 `title`（原型的标题按钮都带）；「临时对话」的箭头顺带补上 `title`。

### 2.3 仓库列表的顺序与冻结

1. 三个新纯函数（`sidebarTree.ts`）：
   - `deriveFolderLastActivity`：每个文件夹最近一个对话的 `updatedAt`，分组规则同 `buildSidebarFolders`（按工作区所属项目；临时对话、孤儿对话不属于任何文件夹）。**不看搜索**：打字不会重排。`updatedAt` 就是侧栏的「最后活动」（回合开始与结束、新建、改名、改绑时更新；状态写入不更新，决策 138）。
   - `orderFoldersByActivity`：有对话的按活动降序，没有对话的保持原顺序，`TEMP_PROJECT_ID` 固定最后；排序稳定。
   - `applyHeldFolderOrder`：冻结期间用进入时记下的顺序；冻结期间新出现的文件夹排在已记下的之后（「临时工作区」仍在最后），消失的直接去掉。
2. 冻结的判定（`useRegionHold`）：
   - 指针：区上的 `onPointerEnter` / `onPointerLeave`。React 按自己的组件树算进出，所以从区内的行打开的菜单（portal 到 `body`）也算在区内。
   - **键盘焦点只算 `:focus-visible`**。鼠标点一行会把焦点留在那一行；如果也算，指针离开后列表会一直冻结，直到用户点了别处。拿不到 `:focus-visible` 的环境按「是键盘焦点」处理（多冻结一会儿是安全的一侧）。
   - 获得焦点的元素被删掉时（行的 ✕、空文件夹里的「新建对话」）浏览器不发 blur；每次提交后检查 `document.activeElement` 是否还是记下的元素，不是就解冻。仓库区卸载（最后一个仓库被移除）时两个标志一起清掉。
   - 记下顺序用 React 的「渲染期间调整 state」写法（`useHeldOrder`），冻结的第一帧就用上快照。
3. 窗口失焦会让焦点元素收到 blur，键盘冻结随之解除；切回窗口时焦点回来，按那时的顺序重新冻结。README v2「待拍板」第 8 条说的「切换回窗口时也排一次」因此自然成立，没有另写逻辑。
4. **区自己的右键菜单**（只有「添加仓库」一项）在 React 树里不属于这个区：指针移到这个菜单上会解冻，列表可能在菜单下面重排。菜单不依附任何一行，影响很小，没有另做处理。
5. 侧栏「＋新建」的第 3 级兜底（「第一个可用工作区」）仍按仓库添加的先后取，不跟显示顺序走（README v2 建议跟着改）。这个按钮的行为第二波整体改为回首页，本波不动它。

### 2.4 全部折叠

1. `collapseAllFolders` 对 `folders`（全部文件夹，含 `TEMP_PROJECT_ID`）逐个写 `false`，合并进现有的展开状态表；搜索时被隐藏的文件夹也一起折叠。不碰 `UNBOUND_FOLDER_ID`（「临时对话」区的箭头状态）。
2. 新词条：英文键 `Collapse all repositories` → 「全部折叠」。现有的 `Collapse all`（「折叠所有」）、`Collapse all folders`（「折叠所有文件夹」）分别属于变更树与文件树，不复用。按钮的 `aria-label` 与 `title` 都用它。

### 2.5 token 与字号落点

1. `--text-section: 1rem` 与 `--text-section--line-height: 1.5` 写在 `globals.css` 的 `@theme`；`text-section` 注册进 `utils.ts` 的 tailwind-merge `font-size` 组（不注册的话 `cn('text-foreground', 'text-section')` 会吞掉颜色）。
2. `--foreground-soft` 写在 `:root`（与 `--tool-arg` 同一块），`.dark` 不再声明；`@theme` 加 `--color-foreground-soft: var(--foreground-soft)`。它是颜色，不注册进 `font-size` 组。
3. 对话行的重命名编辑框从 `text-ui` 改为 `text-meta`，双击重命名时字不变大（README v1 的建议）。
4. 「聊天」面板里没有改动的：文件夹行（15px 600）、辅助行、工具栏、搜索框、悬停提示、宽度预算（235 / 167 / 179，`p-2` 的说法改为区内 `px-2`）。

### 2.6 删除与改名

- `sidebarTree.ts`：删除 `deriveRecentRows`、`RecentRowsInput`、`RecentRowsResult`、`RECENT_WINDOW_MS`、`RECENT_DEFAULT_LIMIT`、`resolveRecentCollapsed`。首页的「最近对话」规则不同（全部对话、不限 48 小时、按今天 / 昨天 / 更早分组），第二波另写派生。`sidebarTree.test.ts` 加了一条守卫：这几个名字不得回到模块里。
- `App/storage.ts`：删除 `STORAGE_KEYS.SIDEBAR_RECENT_COLLAPSED`，留注释「已退役、不迁移、不要复用这个键」。老安装里这个值还在，无害。
- `i18n.ts`：删除只给「最近」用的 `Expand Recent`、`Collapse Recent`、`Last 48 hours`（全仓再无引用）；`Recent`（「最近」）是通用词，保留。新词条放文末一块，注释 `// Sidebar regions (issue #6)`：`Expand active chats`「展开正在活动」、`Collapse active chats`「收起正在活动」、`Collapse all repositories`「全部折叠」。「正在活动」「查看更多（N）」「收起」「临时对话」沿用现有词条。
- 改动后用 `rg` 扫过旧标识符（`deriveRecentRows`、`RECENT_*`、`resolveRecentCollapsed`、`SIDEBAR_RECENT_COLLAPSED`、`sidebarSectionClass`、`SidebarSegmentLabel`、`Last 48 hours`、`Expand Recent`），`src/` 里只剩这条守卫测试与注释里的历史说明。`stores/chatSessions.ts` 的一处注释仍提到「Recent's order and its 48h window」，那是红线 store，本波不动。

## 3 与原型的偏差

1. **收起的区不渲染 `ScrollArea`**：「正在活动」「临时对话」收起时只剩标题；原型留着一个空的滚动根。grid 第二行高度都是 0，看起来一样。
2. **搜索**：原型没有画。「正在活动」搜索时不受 5 条限制（§2.2 第 2 条）；仓库顺序不随搜索变化（§2.3 第 1 条）。
3. **冻结**：原型是静态页，只画排序的结果；冻结的判定细节见 §2.3。
4. **类名顺序**：区的类名集合与原型相同，书写顺序按 Tailwind 的分组习惯（如 `grid max-h-[33%] min-h-0 shrink-0 grid-cols-1 …`），引导卡片区用 `p-2` 代替原型的 `px-2 pt-2 pb-2`（等值）。
5. **没有出实机截图，也没有重跑原型的硬判据**：开发机不跑 Electron GUI，v4 定稿时用户也要求预览阶段不跑截图与判据。像素级核对放到第 7 节的现场清单。

## 4 测试

期望值的变化：

- `sidebarHierarchyStatic`（改写，26 项）：
  - L0 / 会话栏 / L1 从 `text-ui` 改为 `text-section`；L3 从 `text-ui` 改为 `text-meta` + `text-foreground-soft`，选中行 `text-accent-foreground`，不得出现 `text-foreground-soft/N`；重命名编辑框 `text-meta`。
  - 「吸顶」整块删除，换成「三个区」一组：三个区的类名常量、区在列表区里的顺序、标题在本区 `ScrollArea` 之前、只有两个区带 `scrollFade="bottom"`、`LeftNav` 里不再有 `sticky` / `bg-image-enabled` / `bg-card/40` / `isolate` / `scroll-pt-8` / `sidebarSectionClass`、区内间距、「正在活动」为空不渲染且不写 `localStorage`、标题栏三个按钮的顺序与尺寸、全部折叠的写法、冻结的接线（`useRegionHold`、`:focus-visible`、提交后的焦点检查）。
  - 字号只允许 14 / 15 / 16 三档；`place={placeOf(row)}` 从 4 处变为 3 处。
- `sidebarRowBudgetStatic`：对话行类名以 `text-ui` 结尾改为 `text-meta`；预算注释的 `p-2` 改为区内 `px-2`（235 / 167 不变）。
- `sidebarSectionMenus`：`sidebarSectionClass(first)` / `(false)` 两处字面量改为 `TEMPORARY_REGION_CLASS` / `REPOSITORIES_REGION_CLASS`。
- `unreadRowMarkerStatic`：列表从 4 个变为 3 个（`unread=` 切分长度 5 → 4，`<SessionRow` 4 → 3）。
- `sidebarTree`（80 项）：删掉 `deriveRecentRows` 5 项与 `resolveRecentCollapsed` 3 项；新增「Recent 的派生已从模块删除」守卫 1 项、`limitActiveRows` 6 项（7 个 → 5 +「2」、展开、搜索、不置顶）、文件夹排序 6 项（原型数据的顺序、worktree 上的对话也算、临时对话与孤儿不算、并列稳定、搜索不改顺序、冻结与冻结期间的增删）；T091 里原来用 `deriveRecentRows` 的 5 处改用 `deriveActiveRows`，决策 145 那条删掉与 `deriveActiveRows` 重复的一处。
- `sidebarActiveAndFolders`（挂载，30 项）：
  - 删除「最近」三组：默认折叠与存储键、两段去重、12 个对话 3 个活动时下段 7 +「查看更多（2）」；E6-40 原来是「最近 7 条 +（3）」，现在 10 个都在活动：「正在活动」5 +「查看更多（5）」，文件夹 8 +「（2）」。
  - 新增「正在活动」一组 7 项：为空时整区不渲染且「仓库列表」没有上边框；排序与转圈 / 等待标记；回收后消失；E6-37；同一对话在本区与文件夹各一次、两处选中；5 +「查看更多（2）」/「收起」；箭头收起整个列表、不写存储、重新挂载后默认展开。
  - 新增「全部折叠」2 项（含「临时工作区」、不影响「临时对话」、可再单独展开、搜索隐藏的文件夹也折叠），文件夹排序 6 项（顺序、指针冻结、键盘冻结、冻结期间空文件夹里新建对话、焦点元素被删除后解冻、区外的指针不冻结）。
  - worktree 分支的那条改为检查「正在活动」里的行不显示分支；「临时对话」区检查 `max-h-[25%]` 且排在「仓库列表」之后。
- `sidebarActiveRowSearch`：没有启动过的对话不再出现在顶区，行数从 2 变为 1；已启动的对话仍是 2 行（「正在活动」+ 文件夹）。
- `sidebarContextMenuInteraction`：未读标记那条把对话设为已启动，仍由两个列表各显示一次。
- `sidebarRevealRepositoryFolder`：去掉存储键的准备代码。
- `sidebarRowRemoval`：第二个派生从「最近」换成「正在活动」；Close 那条先把对话设为已启动，确认两处都有、关闭后两处都没有。
- 新增断言：`utils.test`（`text-section` 不吞颜色、与别的字号去重；`text-foreground-soft` 是颜色，替换颜色、不替换字号）、`tokenValues.test`（`--foreground-soft` 的派生式、只在 `:root` 声明一次、无 alpha、`@theme` 桥接；`--text-section` 的值、行高与唯一声明）。
- 「焦点元素被删除后解冻」这条做过变异验证：把提交后的检查改成永不成立，这一条失败；改回后通过。

## 5 验证（2026-10-10，开发机，一次一个测试进程，每次先看 `free -m`）

- `pnpm typecheck`：通过。
- `biome check`（19 个改动的代码与测试文件）：无问题。
- 相关测试（改动最多的文件）：
  - `sidebarTree`、`sidebarHierarchyStatic`、`sidebarRowBudgetStatic`、`sidebarSectionMenus`、`unreadRowMarkerStatic`、`sidebarRowRemoval`、`lib/utils`、`styles/tokenValues`：8 个文件、150 项；
  - `sidebarActiveAndFolders` + `sidebarHierarchyStatic`（冻结改为 `useRegionHold` 之后重跑）：2 个文件、56 项；
  - `chat/e4CatalogKeys`、`chat/fontDomainScan`、`styles/__tests__`、`lib/__tests__`：11 个文件、73 项。
- `pnpm exec vitest run src/renderer/components/workspace-shell`：62 个文件、877 项。
- `pnpm exec vitest run Static Scan Wiring`：78 个文件、804 项。
- `pnpm exec vitest run src/shared/__tests__`：35 个文件、541 项（含词条覆盖、无硬编码中文）。
- 旧标识符扫描（`rg`，见 §2.6）：`src/` 里只剩守卫测试与 `App/storage.ts` 的退役注释。
- 未做：Electron GUI 点验、整包构建、全量测试（开发机规则）；Windows（见第 7 节）。

## 6 风险

1. **`DockTitle` 16px 连带 Git、文件、终端、运行四个面板的标题**（裁决第 3 条的已知影响）。
2. **小窗口的仓库列表变矮**：1280×720（或 1920×1080 开 150% 缩放）时列表区 534px，「正在活动」到 33% 上限（176px）且「临时对话」到 25%（133px）时，仓库列表只剩约 224px（约 6 行）。没有正在活动的对话时整区不出现，空间还给仓库列表。
3. **L3 与 L4 同为 14px**：同一行里标题与时间、分支文字只靠颜色区分（亮色 ΔE 0.14，暗色 0.08）。Windows 上要看够不够分开。
4. **三个视口各有自己的滚动位置**：搜索时三区都会缩，仓库列表从当前滚动位置开始显示命中项。以前是一起滚的，行为上是新东西。
5. **冻结**：
   - 键盘焦点的判断依赖 Chromium 的 `:focus-visible` 启发式（键盘移入、文字输入框算；鼠标点击不算），Windows 与 Linux 同一套 Chromium；
   - 指针停在仓库列表上时，别处的对话结束也不会重排，直到指针离开——这是裁决本身的效果；
   - 区自己的右键菜单打开时会解冻（§2.3 第 4 条）。
6. **背景图模式**：标题不再吸顶，背景图下的「退化」随之消失；区之间只有分隔线，标题行没有自己的底色，与原型一致。
7. **派生色在 `sync-terminal` 主题下**跟着终端的 `--foreground` / `--muted-foreground` 走；终端配色极端时（两者很接近）对话标题与灰字的差别也会变小。

## 7 Windows 现场清单（测试包 `1.1.0-dsh.9` 起）

1. **字体与字号**（Segoe UI Variable + Microsoft YaHei UI）：「聊天」与「正在活动」「仓库列表」「临时对话」16px Bold；文件夹名 15px Bold；对话标题 14px Regular，颜色比文件夹名浅一级、比时间深一级；选中的对话是正文色；会话栏标题 16px 不加粗；Git / 文件 / 终端 / 运行的面板标题也是 16px。
2. **分区**：仓库多、展开多时滚动仓库列表，「正在活动」「临时对话」原地不动；1280×720 或 150% 缩放下两区到上限后区内可滚，区底有渐隐；1440×900、7 个正在活动时 5 行 +「查看更多（2）」不用滚。
3. **「正在活动」**：刚启动时整区不出现；发出一条消息后出现；超过 5 个时显示「查看更多（N）」/「收起」；箭头收起后只剩标题，重启后默认展开。
4. **仓库顺序**：在排在下面的仓库里发一条消息，指针离开侧栏列表后该仓库移到最上面；指针停在列表上时顺序不动；用 Tab 把焦点移进列表时同样不动，焦点离开后重排；没有对话的仓库在有对话的后面；「临时工作区」总在最后。
5. **全部折叠**：所有文件夹（含「临时工作区」）合上，「临时对话」区不受影响；之后单个文件夹还能展开。
6. **颜色**：亮色、暗色、同步终端三种主题下，对话标题都在文件夹名与时间之间、清楚可读。
7. **背景图开启**：三个区的标题行没有底色，区内滚动时没有内容穿插到标题后面（标题不在滚动区里）。
8. **键盘**：Tab 依次经过三个区的滚动视口（溢出时），焦点环可见；在行上按 Enter 打开对话。
9. **宽度**：280 / 360 / 500 三档下没有溢出；280 宽时文件夹内的对话标题能放 11 个汉字，不嵌套的 12 个。

## 8 用户审批

- [x] 第 1 节（用户 2026-10-10 已裁决）
- [ ] 2.1 结构：区写成常量；没有仓库时引导卡片占「仓库列表」的位置，有正在活动的对话时仍显示「正在活动」
- [ ] 2.2 「正在活动」：搜索时不受 5 条限制；不置顶选中的对话；箭头带 `title`
- [ ] 2.3 排序与冻结：活动时间不看搜索；键盘焦点只算 `:focus-visible`；焦点元素被删除时解冻；区自己的右键菜单打开时会解冻；「＋新建」的兜底本波不跟显示顺序走
- [ ] 2.4 全部折叠：搜索隐藏的文件夹也折叠；词条键 `Collapse all repositories`
- [ ] 2.5 token 落点；重命名编辑框改 14px
- [ ] 2.6 删除 `deriveRecentRows` 等派生与三个只给「最近」用的词条，存储键留「不要复用」注释
- [ ] 第 3 节与原型的偏差
- [ ] 第 7 节 Windows 现场清单
