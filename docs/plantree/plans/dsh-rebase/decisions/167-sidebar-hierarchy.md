# 决策 167：「聊天」侧栏层级重做——五级层级、「最近」合并「正在活动」、分支只在文件夹行显示一次

日期：2026-10-09。**状态：第 1～6 条为用户裁决（2026-10-09，GitHub issue #3 与答复）；第 7 条起为自主决定，待用户审批。**

来源：GitHub issue #3「左侧『聊天』栏层级混乱：板块、文件夹、对话难以区分，需要完整的层级设计」（报告时 58 个未归档对话、26 个目录）。

**验收基准是原型**：[`evidence/sidebar-hierarchy-2026-10/`](../evidence/sidebar-hierarchy-2026-10/README.md)——`prototype.html` 的「方案」视图（变体 A + X）、`measurements.json` 与 `shots/`（02、08、10、12、15、18）。实现照原型的类名与实测不变量落地，偏差逐条列在第 26 节。设计规范已写进 [`docs/design-system.md`](../../../../design-system.md)「侧栏层级（聊天面板）」。代码提交：待编排者提交。

修订关系：

- **取代决策 [137](137-user-ruling-sidebar-active-and-folders.md) 第 1 条**（「正在活动」作为「最近」之上的独立一节）：改为「最近」的上段，见第 1 条。
- **缩小决策 137 第 2 条的作用范围**：「默认折叠」与折叠按钮现在只作用于「最近」的下段，上段折叠时照常显示；存储键与首次默认折叠不变。决策 137 第 3、4 条不变。
- **取代 D21-A**（2026-07-29 用户裁决：每行显示实际分支 chip，main/master 也显示）：见第 2 条。同一宽度冲突更早的记录是 **D26③**（2026-07-30，「侧栏 chip 封顶 112px 放宽」）与观感审计 **P-24**（`docs/design/polish-audit-20260730.md`：「一行两处截断」，标题实得约 112px；该文件已在 `3ce9702e` 清理出本分支，见 git `9a3fd863`）。这次是第三次碰到同一个问题，裁决把分支从行上整体挪走。
- 修订决策 [138](138-p1-7e-e1-sidebar-choices.md) 第 2 条（转圈比点宽 6px、标题随之左右移 6px → 固定 `w-4` 状态槽，不再移位，第 8 条）与第 6 条（「查看更多」按钮 `h-7`、`rounded-sm` → 辅助行 `h-6`、`text-meta`、行首 `w-4` 槽，第 11 条）。
- 修订决策 [144](144-p1-7e-e4-choices.md) 第 2 条（失败与类别徽标用 `lg`、分支 chip 用 `sm` → 类别徽标删除、告警徽标全部 `lg`，第 10 条）与第 3 条（类别徽标「临时」「远程」在显示层翻译 → 徽标删除；显示层翻译的做法沿用到临时工作区的项目名，第 22 条）。
- 修订决策 [123](123-p1-9e-migration-renderer-choices.md) 第 13 条：`1.0.x` 分叉徽标从 `sm` 改 `lg`，仍只写版本号（第 10 条）。
- 决策 [145](145-p1-7e-e6-choices.md) 第 13 条「查看更多（N）」写法不变，「最近」的 N 改为去重后计数。决策 [156](156-pre-merge-ui-fixes-choices.md) 的 E156-7（Esc 取消重命名后焦点回到行）与归档按钮的名字行为不变，只是悬停按钮尺寸改为 20px（第 17 条）。

## 用户裁决（2026-10-09）

### 1. 「正在活动」并进「最近」

- 只剩一个 L1 板块「最近」，分上下两段。
- **上段「正在活动」**：口径同决策 137（已在宿主上启动，即 `hostBoundSessionIds`，或正在跑回合）；跑回合的在前，其余按最后活动时间；不设上限。**「最近」折叠时上段照常显示**，折叠只收起下段。
- **下段**（原型标签「48 小时内」）：跑回合或 48 小时内有活动的对话，**先去掉上段已有的，再取前 7 条**；「查看更多（N）」的 N 按去重后剩下的算。
- 同一个对话在「最近」里最多出现一次；在所属文件夹里照常出现，两处都保留选中高亮。
- 取代决策 137 第 1 条（独立一节）；决策 137 第 2 条的「默认折叠」现在只作用于下段；第 3、4 条不变。

### 2. 分支标签（取代 D21-A）

- 文件夹行在名称后面显示一次**主工作区分支**（L4 文字）；远程仓库标在文件夹行上。
- 只有在**非主工作区（worktree）**上的对话才在本行显示分支，而且**只显示最后一段**（`feature/sidebar-redesign` → `sidebar-redesign`），`max-w-24`，全名放悬停提示。
- 「最近」里的行只显示标题和时间（状态槽与告警徽标保留）。

### 3. 三行悬停提示

所有对话行的 `title` 三行：标题 / 「文件夹 · 分支」（临时对话写「临时对话」）/ 「更新于 日期 时间」。新增 `formatAbsoluteDateTime(ms, locale)`（`src/renderer/lib/relativeTime.ts`），跨天、跨年都写 `YYYY-MM-DD HH:MM`，按界面语言格式化，不读系统区域设置；回合尾部的 `formatAbsoluteTime`（只有 `HH:MM`）不用在这里。读 `title` 的测试改为取第一行。

### 4. 板块标题颜色选变体 A

正文色、600、15px、字距 0.04em、`h-8`；除第一个外上方有分隔线；在本板块内吸顶（`bg-background` + 内层 `bg-card/40`）；背景图模式下不吸顶；滚动视口 `scroll-pt-8`，键盘聚焦的行不被吸顶标题盖住。「仓库列表」标题保留筛选 / 添加两个图标位（D21）。

### 5. 「临时对话」选变体 X

独立的 L1 板块，行直接列在标题下；删掉原来重复的文件夹头写法（原 `LeftNav.tsx` 约 507～520 行）；保留板块右键菜单「新建临时对话」与 8 条上限；行上不再显示「临时」。临时会话（Temp）项目的显示名在显示层翻译（`LeftNav`，同决策 144 第 3 条的 `sidebarRowForDisplay`），不在 `deriveChatWorkspaceTree.ts` 里改。

### 6. 面板标题与会话栏标题

`DockTitle`（`LeftDock.tsx`，五个面板共用）→ `text-ui` 15px 600；`SessionBar.tsx` 中栏标题 → `text-ui` 15px 400（去掉 `font-medium`）。

## 自主决定（待用户审批）

### 布局与间距

7. **坐标与间距照原型实测**：列表根 `p-2`；板块之间 `mt-2` + 通栏 `border-t`；文件夹组之间 `space-y-1`（原来 `space-y-3`，与板块间距一样大）；板块标题 → 第一项、文件夹行 → 第一行 `mt-0.5`；对话行之间 `space-y-0.5`；文件夹内的行包在 `pl-3` 里。文字横坐标（面板左边框起）：L0 12、L1 16、文件夹名与不嵌套行的标题 38、文件夹内行的标题 50，时间盒右缘距右边框 16。原来文件夹内的标题与辅助行有 28 / 40 / 44 / 46 四种横坐标。
8. **每行固定 `w-4` 状态槽**（修订决策 138 第 2 条）：转圈 `size-3`、三种圆点、后台环、多选框都居中放进去，无状态时空着占位。代价：没有任何状态的行标题左侧多空 16px（原型宽度预算已计入，280 时标题仍有 167px）。
9. **圆角统一 `rounded-sm`**：对话行、文件夹行、辅助行、搜索框、重命名编辑框（原来是 `rounded-md` / `rounded-lg`，`h-6` / `h-7` 上违反圆角钳制规则）。搜索框与重命名编辑框同时改写 `before:` 发丝线的圆角，否则内外圆角不一致。
10. **告警徽标统一 `Badge size="lg"`**（桌面 14px）：失败、待审批 N、`1.0.x`。修订决策 144 第 2 条与决策 123 第 13 条（后两者原来是 `sm` 的 10px）；`1.0.x` 仍只写版本号。待审批的盾牌图标随之 `size-3.5`。
11. **辅助行**（查看更多、收起、新建对话）：`h-6`、`text-meta`、行首 `w-4` 槽（新建对话在槽里放 `Plus size-3.5`），文字与同深度标题对齐，悬停与 `focus-visible` 同一层底色（修订决策 138 第 6 条的 `h-7`）。抽成 `SidebarAuxRow`，文件夹、临时对话、「最近」三处共用。
12. **下段小标签文案「48 小时内」**（英文 `Last 48 hours`），放在 x=16（与板块标题文字同一列），不与标题对齐，否则会和可点的「查看更多」长得一样。上段非空才显示「正在活动」；两段都显示时才显示「48 小时内」。两段各是一个以小标签命名的 `role="group"`（`aria-labelledby`），读屏能分清，测试也按它找段落。

### 行上的信息

13. **悬停提示用在所有对话行**（裁决只点名了「最近」）：侧栏的相对时间原来没有任何地方给出绝对时刻，违反设计规范的「相对时间配绝对时刻」。第三行**一律带日期**，当天的也写日期：「14:32」跨天浏览有歧义，也省掉「今天」这类词条。第二行：分支取该对话自己所在工作区的分支；远程仓库加「（远程）」；临时会话（Temp）项目里的行写「临时工作区」（临时工作区没有分支）。`formatAbsoluteDateTime` 的格式表按界面语言（`en` / `zh`）各有一项，目前两者都是数字格式；拿不到语言时按英文。
14. **文件夹行**：名称 `min-w-0 truncate`，主工作区分支 `min-w-0 shrink-[1000] truncate`（分支先让，名称最后截断）；远程仓库写「分支 · 远程」，远程仓库拿不到分支时只写「远程」（现在的派生层不给远程仓库分支，所以总是「远程」）。悬停提示：名称 / 主工作区分支：x / 远程仓库。名称单独带 `data-slot="sidebar-folder-name"`，测试按它找文件夹行（按钮的文字里现在还有分支）。键盘焦点落在行内按钮上时整行 `has-focus-visible:bg-hover`（原型只画了悬停，README 的 L2 规格写了「悬停与键盘焦点同一层底色」）。
15. **去掉行上的类别徽标数据**：`SidebarChip` 只剩分支（`variant: 'branch'`）；`chipForWorkspace` 对临时、远程、未绑定工作区返回 `null`；「没有文件夹」这件事改由行上的 `unbound: true` 标记表达（U05-b ③ 的语义不变：没有工作区或落在空路径占位工作区的对话）。`sidebarChipText`、`KIND_CHIP_KEYS` 删除，`sidebarRowForDisplay` 只翻译占位标题。新增纯函数 `folderPrimaryChip`、`chipShownInFolder`、`lastBranchSegment`、`folderBranchLabel`、`folderTooltip`、`sidebarRowPlace`、`sidebarRowTooltip`、`sidebarFolderNameForDisplay`；`deriveRecentRows` 增加 `excludeSessionIds`（在截 7 条之前去掉），`LeftNav` 先算上段再算下段。

### 控件

16. **搜索框改用 coss 的 `InputGroup`**：`InputGroupInput size="sm"` 在前、`InputGroupAddon align="inline-start"` 在后（`order-first` 排到左边，`[data-size=sm]+&` 的内距只在这个顺序下生效），`h-7 rounded-sm`，放 `Search size-4`。原来的绝对定位图标排在 `Input` 前面，被 `Input` 外层 `relative` 且不透明的 `span` 盖住（亮色完全看不见，暗色淡淡透出）。同样的叠放错误一并修了模型菜单（`ComposerModelTrigger.tsx`）与分支切换（`BranchSwitcher.tsx`）的搜索框；后者的占位文字原来是 12px 中文（`text-xs`），现在跟随 `InputGroup` 的 14px，高度统一为 `h-7`。加了静态守卫：渲染层任何 `.tsx` 不得出现「绝对定位图标紧跟 `<Input`」，三个搜索框必须是 `InputGroupInput` 在前。
17. **悬停操作按钮 `size-5 sm:size-5`**（对话行的归档 / 移除 / 删除、文件夹行的「更多」与「+」），图标 `size-3.5`：原来写的 `h-5 w-5` 在桌面端输给 `icon-xs` 变体的 `sm:size-6`，两枚 24px 共 48px，放不进 40px 的时间盒。
18. **工具栏按钮 14px**：「新建」「添加仓库」、多选模式的「归档」「取消」、空状态的「添加仓库」都加 `sm:text-meta`（`Button size="xs"` 桌面端是 12px 的 `sm:text-xs`，违反「中文不小于 14px」）。
19. **键盘焦点样式**：对话行非选中时 `focus-visible:bg-hover`（全局去掉了 outline，原来对话行没有任何焦点样式）；滚动视口 `scroll-pt-8`。`ScrollArea` 是共用原语，不给它加属性，改在根上写 `*:data-[slot=scroll-area-viewport]:scroll-pt-8`。
20. **吸顶的实现**：`SidebarSectionHeader` 外层 `sticky top-0 z-10 -mx-2 bg-background in-[.bg-image-enabled]:static`，内层 `flex h-8 items-center bg-card/40 px-4`。背景图开关是 `useBackgroundImage` 写在 `<body>` 上的 `.bg-image-enabled`，开启时标题退化成不吸顶，避免半透明底让下面的行透出来。带右键菜单的板块用 `ContextMenu.Trigger render={<section …/>}`，吸顶标题的包含块就是板块本身。
21. **列表根加 `isolate`**（原型没有）：真实的 `ScrollArea` 自绘悬浮滚动条，是视口之后的绝对定位兄弟元素、没有 `z-index`，吸顶标题的 `z-10` 会把滚动条顶端盖住；`isolate` 让标题的层叠留在列表内。`isolation` 不影响 `sticky`（红线只禁 `overflow` / `transform` / `filter` / `contain`）。

### 其他

22. **临时会话（Temp）项目名在显示层翻译为「临时工作区」**（英文 `Temporary workspaces`，新词条）：`deriveChatWorkspaceTree.ts` 只把 `TEMP_PROJECT_ID` 导出，项目名仍是标识符 `Temp`；翻译在 `sidebarFolderNameForDisplay`，文件夹行与悬停提示都用它。
23. **临时对话板块的折叠**：标题右侧箭头（`size-6`），沿用原文件夹头的内存状态（`expandedProjects[UNBOUND_FOLDER_ID]`，不持久化）；新词条「收起临时对话」「展开临时对话」。没有仓库时的空状态视图里它同样是 L1 板块，上方有分隔线，与添加仓库的引导分开。
24. **`DockTitle` 改 15px 会连带 Git、文件、终端、运行四个面板的标题**（裁决第 6 条的已知影响，记录在此）。
25. **新词条**（`src/shared/i18n.ts` 末尾一块，注释 `// Sidebar hierarchy (issue #3)`）：`Last 48 hours`、`Updated {{time}}`、`Main branch: {{branch}}`、`Remote repository`、`{{place}} (remote)`、`Expand temporary chats`、`Collapse temporary chats`、`Temporary workspaces`。「正在活动」「查看更多（N）」「收起」「远程」「临时对话」沿用现有词条。

## 26. 与原型的偏差

1. **worktree 行的分支只显示最后一段**（裁决第 2 条）：原型按完整分支名画（`feature/ch…`），实测 280 时标题落到 80px 下限；现在分支文字通常更短，标题更宽。README 待定项 D 由此解决。
2. **列表根 `isolate`**（第 21 条）与 **`scroll-pt-8` 写在 `ScrollArea` 根上**（第 19 条）：原型的视口是普通 `overflow` div，没有自绘滚动条。
3. **「最近」两段各包一层 `role="group"` 的 div**：原型是平铺的「小标签、行、小标签、行」。外层 `space-y-0.5` 加第二个小标签的 `mt-1`，外边距穿过无内距的分组折叠，段间仍是 4px。
4. **文件夹行加 `has-focus-visible:bg-hover`**（第 14 条）；**L1 标题文字加 `min-w-0 truncate`**，窄宽度下不撑破标题行。
5. **临时对话板块的箭头两种状态都有词条**（原型只画了「收起临时对话」）。
6. 原型是静态页，开发机没有 Windows 字体，**本次没有出实机截图**（开发机不跑 Electron GUI）；像素级核对放到下面的现场清单。

## 测试

- 纯函数 `sidebarTree.test.ts`：`chipForWorkspace` 不再给类别徽标、`unbound` 标记、`folderPrimaryChip` / `chipShownInFolder` / `lastBranchSegment` / `folderBranchLabel` / `folderTooltip` / `sidebarFolderNameForDisplay`、三行提示（`sidebarRowPlace` / `sidebarRowTooltip`）、`deriveRecentRows` 先去重后截断（原型的 16 / 3 / 7 + 6 组数字）、跑回合的对话只在上段。
- `lib/__tests__/relativeTime.test.ts`（新）：`formatAbsoluteDateTime` 补零、跨天、跨年、按界面语言、拿不到语言时回落。
- 挂载测试 `sidebarActiveAndFolders`：上段在「最近」折叠时仍显示、同一对话在「最近」只出现一次且两处选中、「查看更多」按去重后计数、单段时不显示小标签、文件夹行显示主分支且名称有独立 slot、worktree 行在文件夹里显示最后一段而在「最近」里不显示、三行提示、临时对话是独立 L1 板块且行上没有「临时」、标题箭头折叠；`sidebarActiveRowSearch`：已启动的当前对话在搜索不匹配时仍是两行（上段 + 文件夹）；`sidebarContextMenuInteraction`、`sidebarRevealRepositoryFolder` 改按 `data-slot` 找文件夹行，「临时对话」按 L1 标题 `<p>` 找。
- 静态测试：`sidebarRowBudgetStatic` 按新预算重写（235 / 167、`w-4` 槽、worktree 分支文字是唯一让位者、`size-5 sm:size-5`、徽标全部 `lg`）；`sidebarSectionMenus`（板块即右键触发器、不再有 `space-y-3` 包装、临时对话不再有文件夹头）；`unreadRowMarkerStatic`（四个列表、`w-4` 槽）；`e4CatalogKeys`（类别徽标测试改为占位标题与临时工作区名）；新增 `sidebarHierarchyStatic`（只用 400 / 600、L0～L4 的类名、吸顶两层底色与 `LeftDock` 根同为 `bg-card/40`、背景图退化、吸顶到视口之间无 `overflow` 等、`scroll-pt-8`、圆角、焦点样式、三个搜索框的 `InputGroup` 顺序、全渲染层「绝对定位图标紧跟 `<Input`」扫描）。

验证（实现代理，2026-10-09，开发机逐个文件跑）：`sidebarTree` 75、`sidebarRowBudgetStatic` 12、`sidebarSectionMenus` 5、`unreadRowMarkerStatic` 3、`sidebarHierarchyStatic` 20、`relativeTime` 4、`e4CatalogKeys` 16、`sidebarActiveAndFolders` 23、`sidebarActiveRowSearch` 3、`sidebarContextMenuInteraction` 5、`sidebarRevealRepositoryFolder` 4；`vitest run Static Scan Wiring` 77 个文件 792 例；`vitest run src/shared/__tests__` 33 个文件 512 例（含词条覆盖、无硬编码中文）；`chatMarkdownPolicy` 103；根 `pnpm typecheck`；改动文件 `biome check`。没有跑 Electron GUI 与整包构建。

## 现场核对清单（Windows 11 / Windows 10，加密机或测试机）

1. **字体**：Segoe UI Variable + Microsoft YaHei UI 下，「聊天」「最近」「仓库列表」与文件夹名是 Bold，对话标题是 Regular；「聊天」不再比板块标题小；会话栏标题与「聊天」同字号、不加粗。
2. **吸顶**：仓库列表滚到中段，「仓库列表」标题贴住视口上沿、底色不透明、下面的行不穿插（对照 08 号截图）；滚到底部「临时对话」接替吸顶（12 号截图）；**开启背景图后标题不吸顶**，也没有半透明穿透；悬浮滚动条顶端不被标题盖住。
3. **折叠**：首次启动「最近」折叠但「正在活动」仍在（10 号截图）；展开后两段各有小标签，同一对话不重复；「临时对话」箭头收起 / 展开。
4. **悬停提示**：对话行三行（标题 / 文件夹 · 分支 / 更新于 日期 时间），日期时间是本地时间；文件夹行提示（名称 / 主工作区分支 / 远程仓库）；worktree 行的分支文字悬停显示全名。
5. **50 个以上对话**：与 18 号全长截图对照层级、间距与对齐（标题横坐标同深度一致）。
6. **搜索框**：亮色主题下放大镜可见；模型菜单、分支切换的搜索框同样可见，分支切换的占位文字是 14px。
7. **键盘**：Tab 到对话行有底色；被吸顶标题盖住的行获得焦点时滚到标题下方。
8. **悬停按钮**：两枚按钮正好放进时间盒，悬停时行不跳动；临时工作区的行三枚按钮。
9. **宽度**：280 / 360 / 500 三档下无溢出，文件夹行分支先让、名称最后截断。
