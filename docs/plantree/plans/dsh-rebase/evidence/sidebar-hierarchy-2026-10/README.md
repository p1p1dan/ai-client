# 侧栏层级验收原型（issue #3）：「聊天」面板五级层级、「最近」合并「正在活动」、分支标签取舍

日期：2026-10-09。**状态：用户 2026-10-09 已选定（A 正文色、X 独立板块、C 中栏标题一起调成 15px 400、D worktree 行只显示分支最后一段），已按此实现，见决策 167。原型保留为验收依据。**

依据：

- GitHub issue #3「左侧『聊天』栏层级混乱：板块、文件夹、对话难以区分，需要完整的层级设计」；
- 用户 2026-10-09 裁决（issue #3 与答复，三条，见下文「用户裁决怎么落」）；
- 决策 [137](../../decisions/137-user-ruling-sidebar-active-and-folders.md)（本次部分取代）、[138](../../decisions/138-p1-7e-e1-sidebar-choices.md)、[144](../../decisions/144-p1-7e-e4-choices.md) 第 2～3 条、[123](../../decisions/123-p1-9e-migration-renderer-choices.md) 第 13 条、[145](../../decisions/145-p1-7e-e6-choices.md) 第 13 条、[156](../../decisions/156-pre-merge-ui-fixes-choices.md) 第 7、10 条；
- [`docs/design-system.md`](../../../../../design-system.md)：字号只用 14 / 15 / 18 三档（:410-413）、字重规则（:548-556）、圆角钳制（:288）、段头用 ui 档（:411）与 `+0.04em`（:571）、相对时间配绝对时刻（:606）、树节点 `h-7`（:630）、每层缩进 12px（:641）、行宽预算（:654）、CJK 不小于 14px（:811-812）；
- 先例：[P1-7 原型](../p1-7-prototype-2026-09-28/README.md)（离屏 Electron 截图、`__measure()` 硬判据）、`docs/design/2026-09-20-workstrip-sticky-preview.html`（照抄真实 token）。

现状一侧照抄的是 `LeftNav.tsx` / `LeftDock.tsx` / `ui/input.tsx` 在 `a0320fe2` 的写法（到 `117ac93d` 这几个文件没有变）。数据全部是虚构的：26 个仓库文件夹（1 个空）54 个对话，加 4 个临时对话，共 58 个；没有真实标题、仓库名、用户名或邮箱。

## 本目录文件

| 文件 | 作用 |
|---|---|
| `prototype.html` | 单文件静态原型。色值逐字照抄 `globals.css`（亮 / 暗），图标是仓库自带 lucide-react 内联，字体栈照抄 `--font-sans`。三种视图：现状 / 方案 / 并排对比，外加变体开关；内置 `window.__measure()` |
| `shoot.cjs` | 离屏 Electron 截图 + 硬判据；方案任何一项判据不过就以非零码退出 |
| `gen-icons.mjs` | 把用到的 Lucide 图标写进 `prototype.html`（与 P1-7 原型同一做法） |
| `measurements.json` | 18 张截图的逐项测量：判据、坐标、间距、标题宽度、相邻层级的区分载体 |
| `shots/*.png` | 18 张截图（清单见「实测结果」） |

## 怎么看

**请在 Windows 11 上用浏览器直接打开 `prototype.html`**，这样看到的才是真实字体（Segoe UI Variable + Microsoft YaHei UI）。

开发机是 Linux，没有这两款字体：截图里拉丁字落在 Ubuntu 字体，中文落在 Noto Sans CJK SC。Noto Sans CJK SC 在这台机器上和 YaHei UI 一样只有 Regular / Bold 两档，所以**截图里中文的字重表现与 Windows 一致**（500 显示成 400，600 显示成 Bold）；但字形和字宽不同，截图只用来证明布局、尺寸、对齐和层级关系。

页面顶部的工具条：

| 控件 | 选项 | 说明 |
|---|---|---|
| 视图 | 现状 / 方案 / 并排对比 | 并排时左现状、右方案，不画中栏 |
| 板块标题颜色 | **A 正文色** / B 灰色 | 用户选 A（2026-10-09） |
| 临时对话 | **X 独立板块** / Y 仓库列表内文件夹 | 用户选 X（2026-10-09） |
| 主题 | 浅色 / 深色 | |
| 面板宽度 | 280 / 360 / 500 | 面板宽度，含 1px 右边框；导轨另算 44px |
| 「最近」 | 展开 / 折叠 | 方案里折叠只收起下段 |
| 滚动 | 顶部 / 仓库列表中段 / 底部 | 中段用来看吸顶 |
| 勾选项 | CJK / Win10 字重、全长、对齐参考线、悬停提示示例、多选模式 | 「CJK / Win10 字重」把 500 渲染成 400、600 渲染成 700，让拉丁字也按 Windows 的方式显示 |

地址参数直达：`mode`（current / proposal / compare）`l1`（A / B）`temp`（X / Y）`theme` `w`（280 / 360 / 500）`recent`（expanded / collapsed）`scroll`（top / mid / bottom）`cjk` `tall` `guides` `tip` `select`（=1 打开），例如 `prototype.html?mode=compare&cjk=1`、`prototype.html?scroll=mid`。页面底部会实时显示当前状态的测量结果。

重出截图（开发机 2 核 / 3.3 GB，先 `free -m` 看 available 不低于 1200 MB，不要和测试同时跑）：

```bash
W=<worktree 根目录>
"$W/node_modules/electron/dist/electron" --no-sandbox --disable-gpu \
  "$W/docs/plantree/plans/dsh-rebase/evidence/sidebar-hierarchy-2026-10/shoot.cjs"
# 只重出几张：SHOOT_ONLY=02,08 ...（按文件名前缀；measurements.json 按文件名合并）
```

## 用户裁决怎么落（2026-10-09）

1. **「正在活动」并进「最近」**：只剩一个 L1 板块「最近」，分上下两段。上段叫「正在活动」，口径同决策 137（已在宿主上启动，或正在跑回合；跑回合的在前，其余按最后活动时间；不设上限），「最近」折叠时上段照常显示，折叠只收起下段。下段是 48 小时内有活动的对话，**先去掉上段已有的，再取前 7 条**，「查看更多（N）」的 N 按去重后剩下的算（原型数据：48 小时内 16 条，上段 3 条，下段 13 条，显示 7 条 +「查看更多（6）」）。同一个对话在「最近」里最多出现一次，在所属文件夹里照常出现，两处都保留选中高亮（实测选中的对话高亮 2 处，现状是 3 处）。两个段落小标签用 L4 样式。
2. **分支标签不再逐行显示（取代 D21-A）**：文件夹行在名称后面显示一次主工作区分支（L4 文字；空间不够时分支先让，名称最后截断）；只有在非主工作区（worktree）上的对话才在本行显示它的分支；远程标在文件夹行上。「最近」里的行跨文件夹，只显示标题和时间，悬停提示三行：标题 / 文件夹 · 分支（临时对话写「临时对话」）/ 更新于 日期 时间（例如 `2026-10-07 14:32`）。
3. **临时对话的行不再显示「临时」**：「临时对话」组和 Temp 文件夹里的行都去掉这个标签。

## 五级层级

只用 400 / 600 两档字重，相邻两级至少有两个互相独立的区分载体，500 不作任何一级的载体。理由：Win10 的 Segoe UI 没有 500；中文回退到的 Microsoft YaHei UI 只有 Light / Regular / Bold，所以**中文在 Win10 和 Win11 上 500 都显示成 400，600 显示成 Bold 700**。

| 级 | 内容 | 字号 | 字重 | 颜色 | 高度 | 其他 |
|---|---|---|---|---|---|---|
| L0 面板标题 | 「聊天」 | `text-ui` 15px | 600 | `foreground` | `h-9` 标题栏 + `border-b`，不随列表滚动 | `px-3`，字距 0（原来是 14px + `0.02em`） |
| L1 板块标题 | 「最近」「仓库列表」（变体 X 还有「临时对话」） | `text-ui` 15px | 600 | A：`foreground`；B：`muted-foreground` | `h-8`（32px） | 字距 `+0.04em`；除第一个外上方 `mt-2` + 通栏 1px `border-t`；在本板块内吸顶；保留「仓库列表」右侧的筛选 / 添加图标位 |
| L2 文件夹 | 仓库名 | `text-ui` 15px | 600 | `foreground` | `h-7` | 文件夹图标 `size-4 text-folder`；`rounded-sm`；悬停与键盘焦点同一层底色 |
| L3 对话 | 对话标题 | `text-ui` 15px | 400 | `foreground` | `h-7` | 行首固定留 `w-4` 状态槽（转圈 `size-3`、6px 圆点、后台环、多选框都居中放进去），标题不再随状态左右移；选中 `bg-selection`；`rounded-sm` |
| L4 辅助 | 相对时间、查看更多 / 收起、新建对话、段落小标签、分支文字、改动合计、空状态 | `text-meta` 14px | 400 | `muted-foreground`（改动合计用 `success` / `destructive`） | 独立成行时 `h-6` | 数字 `tabular-nums`；查看更多 / 收起 / 新建对话行首也留 `w-4` 槽，文字与同深度标题对齐；悬停与 `focus-visible` 同一层底色 |

## 相邻层级的区分载体（实测）

`__measure()` 对每一级取一个代表元素（L0「聊天」、L1 第一个板块标题、L2「atlas-web」、L3 文件夹里的普通行「优化首页首屏加载时间」、L4 同一文件夹的「查看更多（2）」），比较八种载体：字号、字重（按 Windows 实际显示折算：500→400、600→700）、颜色、字距、行高、缩进（文字横坐标差 ≥6px）、行首图标、分隔线。

| 两级 | 现状 | 方案 A | 方案 B |
|---|---|---|---|
| L0–L1 | 字号、字重、颜色、字距、行高、分隔线（6）——**但高一级反而更弱**：面板标题 14px，板块标题 15px | 字距、行高（2） | 颜色、字距、行高（3） |
| L1–L2 | 字重、颜色、字距、缩进、图标（5）——**但高一级反而更弱**：板块标题是灰色，500 在 Windows 上等于 400，比文件夹名（600 正文色）弱 | 字距、行高、缩进、图标、分隔线（5） | 再加颜色（6）——**板块标题比文件夹名浅** |
| L2–L3 | 字重、缩进、图标（3） | 字重、缩进、图标（3） | 同 A |
| L3–L4 | 颜色、缩进（2） | 字号、颜色、行高（3） | 同 A |
| L1–L4（板块标题与「查看更多」，issue 原话「几乎一个样子」） | 字距、缩进（2）：同为 15px、同为灰色、500≈400、同为 28px 行高 | 7 | 6 |

「高一级不弱于低一级」（字号、Windows 实际字重、对比度都不低于下一级）：现状 L0–L1、L1–L2 两处不满足；**方案 A 全部满足**；方案 B 在 L1–L2 不满足（板块标题灰色，比文件夹名浅）。这是推荐 A 的主要理由。

L0–L1 在 A 里只有字距和行高两个载体，刚好达标。两者之间隔着工具栏和搜索框，L0 在固定的标题栏里，实际不会混淆；若用户觉得不够，B 多一个颜色载体，代价是上面那条「板块标题比文件夹浅」。

## 坐标、间距与宽度预算

横坐标从面板左边框量起（280、360、500 三种宽度实测一致）：

| x | 是什么 |
|---|---|
| 0 | 面板左边框 |
| 8 | 列表内容起点（`p-2`）；工具栏按钮、搜索框左缘 |
| 12 | L0「聊天」文字（`DockTitle` 的 `px-3` 不变） |
| 16 | L1 板块标题文字（吸顶标题 `-mx-2` 通栏 + `px-4`）、段落小标签文字、文件夹图标、不嵌套行的状态槽 |
| 28 | 文件夹内行的状态槽 |
| 38 | 文件夹名、不嵌套行（「最近」、变体 X 的「临时对话」）的标题、不嵌套辅助行文字 |
| 50 | 文件夹内行的标题、文件夹内辅助行文字（每嵌套一层 +12，即 `pl-3`） |
| 右边框 − 16 | 时间盒右缘；板块标题右侧图标按钮右缘 |

现状的对应值：文件夹名 34；文件夹内的标题与辅助行文字有 28 / 40 / 44 / 46 四种横坐标（随状态点、「查看更多」的 `pl-5`、「新建对话」的加号而变）；不嵌套的有 16 / 28 / 34 三种。

纵向（实测）：

| 位置 | 方案 | 现状 |
|---|---|---|
| 板块之间 | 8px（`mt-2`）+ 1px 通栏分隔线 + 32px 标题 | 12px，无分隔线，28px 标题 |
| 文件夹组之间 | 4px（`space-y-1`） | 12px（`space-y-3`），与板块之间一样大 |
| 板块标题 → 第一项、文件夹行 → 第一行 | 2px（`mt-0.5`） | 4px（`mt-1`） |
| 对话行之间 | 2px（`space-y-0.5`） | 2px |
| 「最近」两段之间 | 额外 4px（第二个小标签 `mt-1`） | — |
| 辅助行 / 段落小标签 | 24px（`h-6`） | 查看更多 28px（`h-7`） |

宽度预算（280px 面板，含 1px 右边框）：文件夹内的行 280 − 1 − 16（`p-2`）− 12（`pl-3`）− 16（`px-2`）= 235，减状态槽 16、两个间距 12、时间盒 40，**标题 167px**；不嵌套的行 179px。实测：

| 行 | 280 | 360 | 500 | 现状 280 |
|---|---|---|---|---|
| 文件夹内普通行 | 167 | 247 | 387 | 80～153（每行都带分支 chip） |
| 文件夹内带告警徽标的行 | 119～125 | 199～205 | 339～345 | — |
| 文件夹内 worktree 行（带分支文字） | **80**（落到 `min-w-20` 下限） | 145 | 285 | — |
| 不嵌套的行（「最近」） | 133～179 | 213～259 | 353～399 | 87～155 |

文件夹行：名称 + 分支在 280 时共有 179px（计算值：行内容 247，减图标 22、右侧悬停按钮预留 40 与间距 6）；`umber-report` 的分支 `release/2026.10` 截成「release/2…」，名称完整。

## 「最近」的两段与去重

- 上段「正在活动」：`hostBoundSessionIds` 里的对话，加上任何正在跑回合的对话（starting / running / stopping / waiting_permission / waiting_question）；跑回合的在前，其余按最后活动时间；不设上限；「最近」折叠时照常显示。
- 下段「48 小时内」：跑回合或 48 小时内有活动的对话，**先减去上段，再截 7 条**；「查看更多（N）」的 N 是去重后被藏起来的条数。
- 段落小标签：上段非空就显示「正在活动」；两段都显示时才显示「48 小时内」（上段为空时下段就是普通的「最近」，不需要小标签）。
- 折叠：板块标题右侧的箭头只收起下段，存储键与默认值照决策 137 第 2 条不变（首次使用默认折叠）。原型默认展开，是为了截图能同时看到两段。
- 「最近」里的行只显示标题和时间；状态槽（转圈 / 提示点 / 后台环 / 未读点）和告警徽标照常显示——它们是状态，不是上下文。

## 分支、远程与临时

- 文件夹行：名称后面跟主工作区分支（L4）。分支 `shrink-[1000]`，名称 `min-w-0 truncate`：宽度不够时分支先缩到没有，名称最后才截断。远程仓库在分支后加「· 远程」（远程仓库拿不到分支时只写「远程」）。文件夹行的悬停提示：名称 / 主工作区分支 / 远程仓库。
- 对话行：只有非主工作区（`ChatWorkspace.kind === 'worktree'`）的对话显示该工作区的分支，`max-w-24`，是一行里唯一会让位的元素。「最近」里的行不显示。
- 临时：「临时对话」组和 Temp 文件夹的行不再显示「临时」；远程仓库的行也不再逐行显示「远程」（已标在文件夹行上）。

## 悬停提示

对话行的 `title` 三行（原型里 15 号截图画了一张示意卡）：

```
为结算流程补充端到端测试用例
atlas-web · feature/checkout-e2e-tests
更新于 2026-10-09 14:55
```

- 第二行：`文件夹 · 分支`（分支取该对话所在工作区的分支）；临时对话写「临时对话」；远程仓库加「（远程）」。
- 第三行一律写日期 + 时间（`YYYY-MM-DD HH:MM`）。当天的也写日期：用户允许当天只写时间，但「14:32」在跨天浏览时有歧义，统一写全更省事，也不用再加「今天」这类词条。需要新的 `formatAbsoluteDateTime`（放 `src/renderer/lib/relativeTime.ts`）；现有的 `formatAbsoluteTime`（`messageMetadata.ts:247`）只有 `HH:MM`，留给回合尾部用。
- 文件夹里的行也用同一份三行提示（裁决只点名了「最近」）：现在侧栏的相对时间没有任何地方给出绝对时刻，违反 design-system :606；用同一个格式化函数最省事。

## 搜索框

**现状的问题**（`LeftNav.tsx:632-640`）：放大镜是 `absolute`，`Input` 的外层 `span` 是 `relative` 且带 `bg-background`（`ui/input.tsx:19`），排在图标后面。两者都是定位元素、`z-index` 都是 `auto`，按文档顺序绘制，于是 `span` 把图标整个盖住。issue 里的推断成立，并且多一个细节：**暗色主题下不完全盖住**——`span` 的暗色底是 `dark:bg-input/32`（半透明），图标会淡淡地透出来（05 号截图）；亮色主题下完全看不见（01 号截图）。另外 `pl-7` 实际加在 `span` 上（`Input` 的 `className` 给的是外层），`rounded-lg`（12px）挂在 `h-7` 上也不符合 :288。

**方案**：`InputGroup`（`h-7 rounded-sm`）里 `InputGroupInput` 在前、`InputGroupAddon`（`align="inline-start"`，靠 `order-first` 排到左边）在后，里面放 `Search size-4`——这是 coss 的约定写法。实测文字起点约 x=36。

同样的叠放错误还有两处（推断，未在真机核实）：`chat/ComposerModelTrigger.tsx:454`（模型菜单的搜索框）和 `source-control/BranchSwitcher.tsx:134`（分支切换的搜索框；后者 `Input` 还带 `text-xs`，占位文字「搜索分支…」是 12px 中文）。

## 现状里顺带发现的问题（issue 没提）

1. **工具栏「新建」「添加仓库」是 12px 中文**：`Button size="xs"` 桌面端是 `sm:text-xs`，违反 CJK 不小于 14px（:811-812）。原型的 `noSmallCjk` 判据在现状一侧报出这两处。方案改成 14px；实现时要写 `sm:text-meta`，只写 `text-meta` 会输给变体里媒体查询中的 `sm:text-xs`。
2. **图标按钮写的 `h-5 w-5` 在桌面端不生效**（推断）：`icon-xs` 变体是 `size-7 sm:size-6`，tailwind-merge 只把 `size-*` 当作会覆盖 `w-*` / `h-*` 的一方，反过来不去重，所以四个类都留着；`sm:size-6` 在媒体查询里排在后面，桌面端赢，按钮实际 24px。后果：对话行悬停时的两枚操作按钮共 48px，放不进 40px 的 `w-10` 盒子。原型现状一侧按 24px 画；方案写 `size-5 sm:size-5`（两枚正好 40px）。
3. 对话行、文件夹行用 `rounded-md`（10px）挂在 `h-7` 上，搜索框 `rounded-lg` 挂在 `h-7` 上，都不符合 :288 第 1 条；方案统一 `rounded-sm`。
4. 侧栏相对时间没有绝对时刻的悬停提示（:606 要求有）。
5. 对话行没有任何键盘焦点样式（全局把 `focus-visible` 的 outline 去掉了）；方案给对话行和辅助行加 `focus-visible:bg-hover`，并给滚动视口 `scroll-padding-top: 32px`，实测（用 `element.focus()` 模拟键盘聚焦）一行被吸顶标题盖住的对话获得焦点时，浏览器会把它滚到标题下方（行顶距视口从 8px 变为 32px）。
6. 面板 280px 含 1px 右边框，:654 写的 236px 实际是 235px。
7. :653 写侧栏折叠态 48px，代码里 `SIDEBAR_COLLAPSED_WIDTH = DOCK_RAIL_WIDTH = 44`。

## 相对派工方案的调整与说明

- **段落小标签放在 x=16**（与板块标题文字同一列），不与标题对齐：对齐到 38 会和可点的「查看更多」长得一样。它和板块标题之间有字号、字重、高度、分隔线四个载体（A 还有颜色）。
- **第二段小标签的文案用「48 小时内」**，是实现方自己取的；可改成「最近 48 小时」等。
- **新建对话行的状态槽里放加号图标**（`Plus size-3.5`），文字仍与标题对齐。
- **板块标题右侧的图标按钮写 `size-6`、图标 `size-3.5`、灰色**：现状写的 `h-5 w-5` / `h-3 w-3` 在桌面端本来就渲染成 24px / 14px，这里只是把实际尺寸写明。
- **工具栏按钮改 14px**（见上「顺带发现」第 1 条）。
- **搜索框用 `rounded-sm`**，不用 `InputGroup` 默认的 `rounded-lg`（:288）。
- **悬停提示用在所有对话行**，第三行一律带日期（理由见「悬停提示」）。
- **「最近」里的行保留状态槽和告警徽标**，只去掉上下文文字。
- **悬停操作按钮 `size-5 sm:size-5`**（见「顺带发现」第 2 条）。文件夹行的悬停按钮照现状保留占位（`opacity-0`），名称不会在悬停时重排。
- **worktree 行在 280 时标题只有 80px**：按派工方案，分支文字 `max-w-24` 且是唯一让位者，标题落到 `min-w-20` 下限，与分支各占一半。这类行很少（只有不在主工作区的对话），但它和「标题优先」有冲突，列为待定项 D。

## 待用户选择

| 项 | 选项 | 实现方建议 |
|---|---|---|
| **A / B 板块标题颜色** | A 正文色（11 号以外的截图）；B 灰色（11 号截图） | **A**。A 下高一级在字号、字重、颜色上都不弱于低一级；B 的板块标题比文件夹名浅，又回到 issue 里「板块标题比下面的行还弱」的方向 |
| **X / Y「临时对话」放哪** | X 独立的 L1 板块，行直接列在标题下（12 号截图）；Y 留在「仓库列表」里作为最后一个文件夹（13 号截图） | **X**，但不强烈。X：临时对话本来就不是仓库，放在「仓库列表」下语义不对；行和「最近」一样是平铺的一层，滚到底部时有自己的吸顶标题。Y：少一个板块标题和一条分隔线，与今天的形状一致 |
| **C 会话栏标题**（`SessionBar.tsx:140`） | 现在是 `font-medium text-meta`（14px / 500，中文实际显示 400），和左栏「聊天」在同一条 `h-9` 线上 | 改成 `text-ui` 400（15px）：与「聊天」同字号、用字重区分角色（面板名 600、当前对话名 400），去掉在 Windows 上不生效的 500。原型中栏只示意了这一行 |
| **D worktree 行的分支文字宽度** | 照派工方案 `max-w-24`（280 时标题 80px） | 先照派工方案；若嫌标题太短，可选：只显示分支最后一段（`feature/checkout-e2e-tests` 显示 `checkout-e2e-tests`），或在面板窄于 320px 时只显示分支图标、名称放悬停提示 |

## 实测结果

`shoot.cjs` 一次跑完 18 张（之后为修参考线标签与测量细节重出了 08、12、13、15 四张），**方案的全部硬判据通过**，退出码 0。✓ 通过，✗ 不通过，— 不适用（`titleWidth160` 只在 280px 判，`sticky` 只在滚动过的截图判）。`monotonic`（高一级不弱于低一级）与 `focusClearsStickyHeader`（键盘焦点不被吸顶标题盖住）是参考项，不计入退出码；`carriers`（相邻两级至少两个载体）是实现方加的硬判据。

| 截图 | 视图 | 行内不溢出 | 「最近」不重复 | 字号字重 | 中文≥14px | 同深度对齐 | 标题≥160 | 吸顶 | 载体≥2 | 高不弱于低 | 焦点不被盖 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 01-current-280-light | 现状 | ✓ | ✗ | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | — |
| 02-proposal-280-light | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 03-compare-280-light | 现状 | ✓ | ✗ | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | — |
| 03-compare-280-light | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 04-proposal-280-dark | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 05-current-280-dark | 现状 | ✓ | ✗ | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | — |
| 06-proposal-360-light | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | — |
| 07-proposal-500-light | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | — |
| 08-proposal-280-scrolled-sticky | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 09-current-280-scrolled | 现状 | ✓ | ✗ | ✗ | ✗ | ✗ | — | ✗ | ✓ | ✗ | — |
| 10-proposal-280-recent-collapsed | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 11-proposal-280-variant-B | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✗ | — |
| 12-proposal-280-temp-X-bottom | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 13-proposal-280-temp-Y-bottom | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| 14-compare-280-cjk-win | 现状 | ✓ | ✗ | ✓ | ✗ | ✗ | — | — | ✓ | ✗ | — |
| 14-compare-280-cjk-win | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 15-proposal-280-guides-tooltip | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 16-proposal-280-select-mode | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| 17-current-280-full-length（644×3396） | 现状 | ✓ | ✗ | ✗ | ✗ | ✗ | — | — | ✓ | ✗ | — |
| 18-proposal-280-full-length（644×3132） | 方案 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |

判据口径：

- **行内不溢出**：对话行、文件夹行、板块标题、辅助行的每个子元素都在本行内容盒内，且行的 `scrollWidth` 不超过 `clientWidth`。
- **「最近」不重复**：方案只看「最近」板块；现状把「正在活动」和「最近」合起来看（现状里「拉取远端更新」「梳理权限审批的边界情况」「重构侧栏会话列表的层级与间距」各出现 2 次，算上文件夹 3 次）。同时检查「最近」里的每一行在文件夹里也有，以及「查看更多（N）」的 N 等于去重后的剩余条数。
- **字号字重**：带 `data-level` 的 L0～L4 元素只许 14 / 15px、400 / 600（按钮、徽标原语排除；「CJK / Win10」模拟下改为 400 / 700）。现状不过的是板块标题的 500。14 号截图里现状这一项「通过」，是因为模拟把 500 画成了 400——这正是 Windows 上的样子。
- **中文≥14px**：遍历面板里所有含中文的文字节点和占位文字。现状不过的是工具栏两个按钮（12px）。
- **同深度对齐**：同一深度的标题、文件夹名、辅助行文字横坐标一致（容差 0.5px）。方案：深度 0 共 41 处全在 38，深度 1 共 51 处全在 50。
- **标题≥160**：280px 时，文件夹里既没有上下文文字也没有告警徽标的行，标题宽度不小于 160px（实测 167）；其余行不小于 80px（`min-w-20`，实测最小 80）。派工原话是「没有上下文文字的行」，带告警徽标的行（119～125px）按这个口径单独放宽到 80。
- **吸顶**：滚动后，跨过视口上沿的那个板块，其标题的上沿正好等于视口上沿（08、12、13 实测差 0；现状 09 的「仓库列表」标题在视口上方 1306px 处，看不出当前在哪个板块）。

截图清单：01 现状 280 亮；02 方案 280 亮（A + X，「最近」展开）；03 并排 280 亮；04 方案 280 暗；05 现状 280 暗（放大镜淡淡透出）；06 方案 360；07 方案 500；08 方案滚到仓库列表中段（吸顶）；09 现状同一滚动位置；10 方案「最近」折叠（上段仍在）；11 方案变体 B；12 方案变体 X 滚到底；13 方案变体 Y 滚到底；14 并排 + CJK / Win10 字重；15 方案 + 对齐参考线 + 悬停提示示意；16 方案多选模式（标题不移位）；17 现状全长；18 方案全长（58 个对话的验收图）。

## 设计规范草案：「侧栏层级（聊天面板）」

> 用户选定变体后，把下面这一节贴进 `docs/design-system.md`（建议放在「Spacing & Sizing」之后、「字体族」之前），按选定结果删掉另一个变体的说法。

---

### 侧栏层级（聊天面板）（issue #3，2026-10）

适用于左栏「聊天」面板：`LeftDock` 的 `DockTitle` 加 `LeftNav`。其他面板的列表要套用 L2～L4 时单独确认。验收原型与实测见 `plantree/plans/dsh-rebase/evidence/sidebar-hierarchy-2026-10/`。

**五级**。只用 400 / 600 两档字重；相邻两级至少有两个互相独立的区分载体（字号、字重、颜色、字距、行高、缩进、行首图标、分隔线）；500 不作任何一级的载体——Win10 的 Segoe UI 没有 500，中文回退的 Microsoft YaHei UI 只有 Light / Regular / Bold，中文在 Win10 和 Win11 上 500 都显示成 400，600 显示成 Bold。

| 级 | 内容 | 字号 | 字重 | 颜色 | 高度 | 其他 |
|---|---|---|---|---|---|---|
| L0 面板标题 | 「聊天」 | `text-ui` | 600 | `foreground` | `h-9` 标题栏 + `border-b`，不随列表滚动 | `px-3`，字距 0 |
| L1 板块标题 | 「最近」「仓库列表」「临时对话」 | `text-ui` | 600 | `foreground` | `h-8` | 字距 `+0.04em`；非首个板块上方 `mt-2` + 通栏 `border-t`；板块内吸顶 |
| L2 文件夹 | 仓库名 | `text-ui` | 600 | `foreground` | `h-7` | 图标 `size-4 text-folder`；`rounded-sm` |
| L3 对话 | 对话标题 | `text-ui` | 400 | `foreground` | `h-7` | 行首 `w-4` 状态槽永远占位；选中 `bg-selection`；`rounded-sm` |
| L4 辅助 | 相对时间、查看更多 / 收起、新建对话、段落小标签、分支文字、改动合计、空状态 | `text-meta` | 400 | `muted-foreground`（改动合计 `success` / `destructive`） | 独立成行 `h-6` | 数字 `tabular-nums` |

**结构与类名**：

- 滚动视口加 `scroll-pt-8`（键盘焦点不落在吸顶标题下面）；列表根 `p-2`。
- 板块：`<section class="-mx-2 px-2">`，非首个再加 `mt-2 border-t`。标题外层 `sticky top-0 z-10 -mx-2 bg-background`，内层 `flex h-8 items-center px-4 bg-card/40`（两层叠出面板自身的合成底色，吸顶时不透明）；文字 `text-ui font-semibold tracking-[0.04em]`；右侧按钮槽 `ml-auto flex items-center gap-0.5`，按钮 `size-6`、图标 `size-3.5`、`text-muted-foreground`。
  - 背景图开启（`--panel-bg-opacity` < 1）时不吸顶：`bg-background` 变成半透明，吸顶会让下面的行透出来。
  - 吸顶元素到滚动视口之间任何一层都不得有 `overflow` / `transform` / `filter` / `contain`（同「时间线折叠头吸顶」红线 3）。
- 板块标题 → 第一项 `mt-0.5`；文件夹组之间 `space-y-1`；文件夹行 → 第一行 `mt-0.5`；对话行之间 `space-y-0.5`；文件夹内的行包在 `pl-3` 里。
- 文件夹行：`group flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-ui hover:bg-hover`，内部按钮 `flex min-w-0 flex-1 items-center gap-1.5 text-left`：图标 → 名称 `min-w-0 truncate font-semibold` → 主工作区分支 `min-w-0 shrink-[1000] truncate text-meta text-muted-foreground`（分支先让，名称最后截断；远程仓库追加「· 远程」）。右侧改动合计与悬停按钮共用一个 grid 格。
- 对话行：`group flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-sm px-2 text-ui`，选中 `bg-selection text-accent-foreground`，否则 `hover:bg-hover focus-visible:bg-hover`。从左到右：
  1. 状态槽 `flex w-4 shrink-0 items-center justify-center`：转圈 `size-3`；等待、未读、后台三种圆点 `size-1.5`；多选框 `size-3.5`；无状态时空着占位。
  2. 标题 `min-w-20 flex-1 truncate`。
  3. 告警徽标：失败、待审批 N、`1.0.x`，统一 `Badge size="lg"`（桌面 14px），`shrink-0`。
  4. 上下文文字：只给非主工作区（worktree）上的对话，内容是该工作区分支，`min-w-0 max-w-24 shrink truncate text-meta text-muted-foreground`，是本行唯一让位者。「最近」里的行不显示。
  5. 时间 / 操作共用的 `w-10` 定宽盒；操作按钮 `size-5 sm:size-5`（两枚正好 40px；只写 `size-5` 会输给变体的 `sm:size-6`）。
- 辅助行（查看更多、收起、新建对话）：`flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-meta text-muted-foreground hover:bg-hover focus-visible:bg-hover`，行首同样留 `w-4` 槽（新建对话在槽里放 `Plus size-3.5`），文字与同深度的标题对齐。
- 段落小标签（「最近」的「正在活动」「48 小时内」）：`flex h-6 items-center px-2 text-meta text-muted-foreground`，第二个加 `mt-1`。

**横向坐标**（面板左边框起，任何宽度都一样）：L0 文字 12；L1 文字、段落小标签、文件夹图标、不嵌套行的状态槽 16；文件夹名、不嵌套行的标题与辅助行文字 38；文件夹内行的状态槽 28、标题与辅助行文字 50；时间盒右缘距右边框 16。

**宽度预算**（280px 面板，含 1px 右边框）：文件夹内的行内容宽 235px，减状态槽、两个间距和时间盒后，**标题 167px**；不嵌套的行 179px。带告警徽标的行约 120px；带上下文文字的行在 280 时标题落到 80px 下限。

**「最近」**：

- 上段「正在活动」：已在宿主上启动或正在跑回合；跑回合的在前，其余按最后活动时间；不设上限；「最近」折叠时照常显示。
- 下段「48 小时内」：跑回合或 48 小时内有活动，先减去上段，再取前 7 条；「查看更多（N）」的 N 是去重后剩下的条数。
- 同一个对话在「最近」里最多出现一次；所属文件夹里照常出现，两处都保留选中高亮。
- 上段非空时显示小标签「正在活动」；两段都显示时才显示「48 小时内」。

**分支与标签**：文件夹行显示一次主工作区分支；对话行只在非主工作区时显示分支；远程标在文件夹行；临时对话的行不显示「临时」，远程仓库的行不显示「远程」。

**悬停提示**：对话行 `title` 三行——标题 / 「文件夹 · 分支」（临时对话写「临时对话」，远程加「（远程）」）/ 「更新于 YYYY-MM-DD HH:MM」（`formatAbsoluteDateTime`，`lib/relativeTime.ts`）。

**搜索框**：`InputGroup`（`h-7 rounded-sm`）里 `InputGroupInput` 在前、`InputGroupAddon align="inline-start"` 在后（`order-first` 把它排到左边），放 `Search size-4`。**禁止「绝对定位的图标 + 后面跟一个 `Input`」**：`Input` 外层是 `relative` 且有底色，按文档顺序画在图标上面，亮色主题下图标完全看不见。

**红线（可静态断言）**：

1. 侧栏 L0～L4 只出现 `text-meta` / `text-ui` 与 `font-normal` / `font-semibold`，不出现 `font-medium`（按钮、徽标原语自带的除外）。
2. 侧栏任何可能出现中文的文字不小于 14px；`Button size="xs"` 的文案必须写 `sm:text-meta`（变体桌面端是 12px 的 `sm:text-xs`）。
3. `h-7` / `h-6` 的行与输入框只用 `rounded-sm` / `rounded-xs`。
4. 对话行的 `w-4` 状态槽永远渲染。

---

## design-system.md 需要更正的现有条目

| 位置 | 现在的写法 | 要改成 |
|---|---|---|
| :548（Font Weight 表 medium 行）与 :554-556（硬约束 1） | 只写了 Win10 的 Segoe UI 没有 500 | 补一句 CJK：中文回退到 Microsoft YaHei UI（只有 Light / Regular / Bold），**中文在 Win10 和 Win11 上 500 都显示成 400、600 显示成 Bold 700**；Win11 那一格的 ✅ 只对拉丁字成立 |
| :571（字距表「段头」行） | 「`Recent` / `Repositories` 之类的分组段头」 | 数值不变；补「侧栏 L1 板块标题，600、`h-8`，见『侧栏层级』」 |
| :606（相对时间） | 「相对时间之外恒配 `title` 悬停给绝对时刻（`formatAbsoluteTime`），策略与侧栏一致」 | 侧栏实际没有绝对时刻；`formatAbsoluteTime` 只有 `HH:MM`。改成：回合尾部用 `formatAbsoluteTime`（`HH:MM`），侧栏用新增的 `formatAbsoluteDateTime`（`YYYY-MM-DD HH:MM`，带日期，因为侧栏的行跨天） |
| :627-632（高度规范表） | Tab 栏 / 树节点 / 小按钮 / 输入框 | 加一行「侧栏板块标题 32px `h-8`」；树节点行注明「侧栏文件夹、对话行」；注明侧栏辅助行用 24px `h-6` |
| :641（缩进） | 「12px/层级，`depth * 12 + 8px`」 | 补：侧栏用「行首 `w-4` 槽 + 每层 `pl-3`」的写法，标题落在 38 / 50，见「侧栏层级」 |
| :653（Sidebar 折叠态） | 48px | 44px（`SIDEBAR_COLLAPSED_WIDTH = DOCK_RAIL_WIDTH`，顺带更正） |
| :654（会话行宽度预算） | 「236px（280 − 16 − 12 − 16）；让位顺序分支 chip → 相对时间 → 永不动标题」「agent chip `shrink-0`」「分支 chip `min-w-0 max-w-24 shrink`」 | agent chip 早已删除（`sidebarRowBudgetStatic` 也断言了不渲染）。改成：面板含 1px 右边框，文件夹内行内容宽 235px、标题 167px；上下文文字（只给 worktree 行）`min-w-0 max-w-24 shrink` 是唯一让位者；时间 / 操作 `w-10` 定宽盒 |
| :822（CJK 验收测点②） | 「侧栏中文会话标题 + agent chip + 分支 chip + 相对时间同行 truncate（四件套）」 | 「侧栏中文会话标题 +（worktree 行的）分支文字 + 相对时间同行 truncate」 |

## 下一步实现的影响面

**代码**：

- `workspace-shell/LeftNav.tsx`：「正在活动」并进「最近」两段；板块结构与吸顶；文件夹行加分支；对话行加 `w-4` 状态槽、去掉逐行 chip、加上下文文字与三行提示；辅助行改 `h-6`；搜索框改 `InputGroup`；工具栏按钮 `sm:text-meta`；悬停按钮 `size-5 sm:size-5`；`rounded-md` → `rounded-sm`；变体 X 时「临时对话」改成 L1 板块。
- `workspace-shell/sidebarTree.ts`：新增一个同时产出两段的派生函数（上段口径同 `deriveActiveRows`；下段在截 7 条之前去重，返回去重后的隐藏条数），替换 `deriveActiveRows` / `deriveRecentRows` 的组合；`SidebarFolder` 加主工作区分支与是否远程；`SidebarSessionRow.chip` 改成只在非主工作区时带分支（`chipForWorkspace`、`sidebarChipText`、`KIND_CHIP_KEYS`、`sidebarRowForDisplay` 里的 kind chip 随之删或改）。
- `workspace-shell/LeftDock.tsx`：`DockTitle` 改 `text-ui`、去掉 `tracking-[0.02em]`。**`DockTitle` 是所有面板共用的**，Git、文件等面板的标题会一起变成 15px。
- `workspace-shell/SessionBar.tsx:140`：看待定项 C。
- `chat/ComposerModelTrigger.tsx:454`、`source-control/BranchSwitcher.tsx:134`：同样的搜索图标叠放问题；BranchSwitcher 还有 12px 中文占位。
- `src/renderer/lib/relativeTime.ts`：新增 `formatAbsoluteDateTime`。
- `src/shared/i18n.ts`：新词条——第二段小标签（如 `Last 48 hours` →「48 小时内」）、提示第三行（如 `Updated {{time}}` →「更新于 {{time}}」）、文件夹行提示（如 `Main branch: {{branch}}`）；变体 X 还要「收起 / 展开临时对话」。「正在活动」「查看更多（N）」「收起」「远程」「临时对话」沿用现有词条。

**会失效、要改写的测试**（钉了现在的字面量或结构）：

- `sidebarRowBudgetStatic.test.ts`：分支 chip 的 `min-w-0 max-w-24 shrink`、`{row.chip.label}` 内层 span、`w-10` 共用表达式出现 2 次、1.0.x 徽标写法。
- `sidebarSectionMenus.test.ts:53`：`<ContextMenuPrimitive.Trigger className="space-y-3">`。
- `unreadRowMarkerStatic.test.ts`：`unread=` 出现 5 处（列表数会变）、状态点的分支顺序写法（状态槽包一层后要跟着改）。
- `sidebarActiveAndFolders.test.ts:140`：`folderHeader` 按按钮 `textContent === 名称` 找，分支文字进了按钮就找不到；`sectionTitled('Active now')` 按 `<p>` 找，「正在活动」改成段落小标签后不是 `<p>`。
- `sidebarContextMenuInteraction.test.ts:161`、`:207`：按 `className.includes('group flex h-7')` 加 `textContent === 'alpha'` 找文件夹行；按 `<span>` 找「Temporary chats」（变体 X 下变成 L1 的 `<p>`）。
- `sidebarRevealRepositoryFolder.test.ts:129`：同样按 `group flex h-7` + 名称文字找文件夹行。
- `sidebarActiveRowSearch.test.ts`：按标题数侧栏里出现几行（「最近」和文件夹都列），去重后数字会变。
- `sidebarTree.test.ts`：`deriveActiveRows`、`deriveRecentRows`、`chipForWorkspace` 的期望值。
- 另按惯例加跑 `vitest run Static Scan Wiring` 与 `src/shared/__tests__`（如 `fontDomainScan`、`e6CopyAndPrimitivesStatic`）。

**决策记录**：落地时新开一份决策（编号顺延），写明：取代决策 137 第 1 条「独立的『正在活动』一节」（改为「最近」的上段）；取代 D21-A「每行显示分支」；修订决策 144 第 2～3 条（行上不再有「临时」「远程」类别徽标，远程挪到文件夹行）；修订决策 123 第 13 条（`1.0.x` 徽标从 `sm` 改 `lg`，仍只写版本号）；决策 145 第 13 条「查看更多（N）」写法不变，N 改为去重后计数；决策 156 第 7 条（Esc 后焦点回到行）、第 10 条（归档按钮的名字）行为不变，只是按钮尺寸改为 20px。另把本页的设计规范草案贴进 `docs/design-system.md` 并更正上表各条。
