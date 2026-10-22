# 界面风格迁移（issue #26）

Role: plan（立项方案，2026-10-21 起草，选择题已全部裁决）。开发分支 `feat/ui-cohesion`（2026-10-22 从 main `8eaacf18` 开出）。**进度看 [任务阶段清单](tasks.md)**，每完成一个大阶段本地提交一次并更新清单。

**接手先读**：[设计规范 v2](../../../design-system.md)（规则本身，2026-10-21 起取代旧规范），再看 [预览](../../../design/2026-10-21-ui-cohesion-preview.html)（浏览器直接打开）。

## 0 来由

- issue #26：参考 open-claude-ui 优化对话界面。
- 用户 2026-10-21：
  - 「优先做 26，现在的外观以及 UI 给人一种割裂感」；
  - 「深入调研和学习 open-claude-ui，重新形成一套我们自己的设计规范，但是风格和设计样式可以直接借鉴或部分使用他的代码」；
  - 「现有的 UI/UE 缺乏特色和美感，缺乏协调和统一，给人一种精装毛坯房的感觉……需要统一的风格迁移甚至重构」。
- 因此本计划**推翻 issue #26 调研里的「不照搬 CDS 主题」**：整套风格（配色、底色层次、边框、阴影、圆角、动效、组件外观）迁到参考的体系上，只在 §4 列出的地方由用户另定。

## 1 割裂感从哪来

2026-10-21 只读盘点 `src/renderer/components/chat/` 的结论：token 层基本守住了（写死的 px 字号、十六进制颜色都是 0 处），乱在**组合层**：同一类东西没有共用外壳，每张卡、每种状态各写各的。

| # | 现象 | 例子 |
|---|---|---|
| 1 | 输入框上方三张交互卡各长各的 | 权限卡中圆角普通边、提问卡大圆角橙边、计划卡中圆角带图标；头部高度 26 / 30 / 30 / 34 / 36 五种 |
| 2 | 红色错误框五种写法 | coss `Alert`、会话失败框、输入框错误、会话树错误、计划卡错误，边框和底色透明度各不相同，会话失败框就紧挨着 `Alert` |
| 3 | 运行状态每处一套 | 工具行无图标整行变红；子代理窗蓝圈绿勾；后台任务只有文字；待办全灰；「运行中」有三种转圈 |
| 4 | 条带与卡片两种底色语言 | 待办 / 排队条灰半透明小圆角 14px，交互卡卡片底中圆角 15px，子窗大圆角带阴影 |
| 5 | 子代理窗里的用户消息另一套画法 | 大圆角灰底无边框，主时间线是中圆角收尖有边框 |
| 6 | 两个引擎同一件事画法不同 | 写待办、查看后台命令的图标不同；「转到后台」只在 SDK 出现 |
| 7 | 输入框里两套菜单 | coss 菜单与手写的斜杠 / @ 弹层；快捷键手写 6 次 |
| 8 | 悬停两种、焦点三种写法 | `bg-hover` 与 `bg-accent/50`；橙 outline、`outline-ring`、`ring-2` |
| 9 | 卡片标题字重、空状态风格不一 | 600 与 500 并存；首页一句话，空对话页 48px 橙图标块 |
| 10 | 几何尺寸来自三个参考 | 先后对齐 pix、OpenChamber、Cursor，每轮只改了一部分 |

更深一层：配色是 Flexoki 编辑器配色，亮色下卡片比画布暗、像凹下去；没有一样东西是「PiLab 才有的」。这是「毛坯房」感的来源，靠收拾解决不了，所以要整体迁移。

## 2 阶段

| 阶段 | 内容 | 产出 | 状态 |
|---|---|---|---|
| 0 | 规范与预览，用户定 §4 的选择题 | `docs/design-system.md`（v2，旧规范已归档）；预览 | **完成**（2026-10-21，选择题全部已定） |
| 1 | 底座：新 token 层（底色四层、边框、填充、阴影、品牌色、语义色、字号档、动效）替换 Flexoki，旧变量名保留为别名，全应用一次换色；「跟随终端配色」补上侧栏底色；对话字号出厂默认改成 14 / 12，已保存的旧字号一次性重置（用户 2026-10-21 同意） | `globals.css`、`ghosttyTheme.ts`、`chatTypography.ts`、设置迁移、`LeftDock.tsx` 的侧栏底色 | **完成**（2026-10-22）：typecheck 通过，`src/renderer`、`src/shared` 测试 482 个文件全过；本地构建并拉起给用户看。未动：代码编辑器与终端配色（跟终端主题，与应用配色无关）、正文的 `leading-relaxed`（阶段 3 时间线队改成 1.43） |
| 2 | 基础组件：coss 组件外观（Button、Menu、Dialog、Alert、Badge、Kbd、Tooltip、Input、Tabs）按新规范调；新增 `StatusIcon`、`DockCard` | `src/renderer/components/ui/` | **完成**（2026-10-22） |
| 3 | 各区域迁移，四队并行（§3） | 各区域代码 | **完成**（2026-10-22，`ccbe07d1`）：按 open-claude-ui 的规范执行（用户裁决） |
| 4 | issue #26 的功能项：用户消息悬停操作、diff 行号与折叠、草稿重启后保留、强度菜单说明等 | 按 §3 的文件归属分给各队 | **完成**（2026-10-22），等用户与阶段 3 一起验收 |
| 5 | **布局重构**（用户 2026-10-22 加）：外壳从 VS Code 式改成 Claude 桌面版式——去掉图标导轨只留侧栏、居中阅读栏、改动收成卡片、改动 / 文件 / 终端等收进按需打开的右侧工作面板。裁决见 §6 | 外壳、侧栏、中栏、右侧面板 | 未开始 |
| 6 | 收尾：删迁移期的旧变量名别名、加防回退检查、全应用亮暗走查与 Windows 衬线效果、规范按落地结果回写 | `globals.css`、检查脚本、规范 | 未开始 |

顺序：0 → 1 → 2 → 3 与 4 → 5 → 6。各阶段的子任务与状态见 [tasks.md](tasks.md)。阶段 1、2 是一个人做的底座（约 3～5 天），做完之后四队互不等待。阶段 1 做完全应用会先「整体变色」但组件未改，这时可以先出一个测试包看观感，再开阶段 3。

## 3 阶段 3 的分组与文件归属

每队只改自己名下的文件；碰到别队文件里的问题，记到本文 §5，由那一队改。

| 队 | 区域 | 名下文件（`src/renderer/components/` 下） |
|---|---|---|
| A 时间线 | 用户消息、助手正文、思考、工具行、diff 与代码块、回合状态行、时间线里的通知与错误、空对话页 | `chat/MessageTimeline.tsx`、`chat/chatTimelineLayout.ts`、`chat/ToolRows.tsx`、`chat/toolCard.ts`、`chat/DshTimelineRows.tsx`、`chat/ChatCodeBlock.tsx`、`chat/ChatWelcomeCard.tsx`、`chat/HostStatusBanner.tsx`、Markdown 渲染相关 |
| B 输入区 | 输入框、工具栏与标签、斜杠 / @ 菜单、三张停靠卡、待办 / 目标 / 排队条带、草稿 | `chat/ChatComposer.tsx`、`chat/Composer*.tsx`、`chat/RunLocationIndicator.tsx`、`chat/QuestionCard.tsx`、`chat/QuestionPrompt.tsx`、`chat/PlanReviewCard.tsx`、`chat/PendingPermissionDock.tsx`、`chat/QueuedMessageStrip.tsx`、`chat/sessionPanelsLayout.ts`、`chat/TodoCard.tsx`、`chat/composerDrafts.ts`、`chat/efforts.ts`、`chat/models.ts` |
| C 子窗与弹窗 | 子代理窗、子代理对话窗、后台任务窗、会话树、各类对话框 | `chat/SubwindowFrame.tsx`、`chat/SubagentsWindow.tsx`、`chat/SubagentConversationDialog.tsx`、`chat/BackgroundJobsWindow.tsx`、`chat/SessionTreeDialog.tsx`，以及 `chat/` 下其余 `*Dialog.tsx` |
| D 外壳 | 左导轨、侧栏、首页、标题栏、右栏（文件、git、终端标签）、设置页 | `workspace-shell/`、`sessions/`、`layout/`、`settings/`、`files/`、`source-control/`、`git/` |

接缝（只能这样碰）：

- **`ui/` 与 `globals.css` 归阶段 2 的底座**，阶段 3 各队只用不改。确实缺东西时，各队只许在 `ui/` 里**新增**文件，不改已有文件；改已有的记到 §5，统一处理。
- **`chat/middleColumnLayout.ts`** 同时被 A、B 用：只许追加导出，不改已有导出的返回值。
- **子代理对话窗的用户消息**（C）复用 A 的 `userBubbleClass()`：A 先改好样式函数，C 只换调用，不自己写样式。这是 C 对 A 唯一的依赖，C 可以先做别的部分。
- 文案（`shared/i18n.ts`）各队只许追加新键。

## 4 选择题与裁决

| # | 选择 | 裁决（2026-10-21） |
|---|---|---|
| Q1 | 配色：中性暖灰加陶土色，还是保留 Flexoki | **用参考的**（暖灰加陶土），Flexoki 退役 |
| Q2 | 输入框与用户消息的圆角 | **用参考的**：输入框 20px、用户消息 18px |
| Q3 | 首页标题字体 | **先用衬线**（系统宋体 + Georgia），测试包上再看 |
| Q4 | 参考代码怎么用 | **直接拿来用、可以复制**：仓库公开只为免费 CI，内部开发内部使用，不对外分发。拿来时换成我们的 token、改 Tailwind 4、文件头留来源注释（规范 §8） |
| Q5 | 字号：保持 PiLab 的 17 / 14（界面 15），还是换成参考的密度（14 / 12，界面 13，行高 1.43） | **用参考的**（规范 §3.1） |
| Q6 | 两个引擎的权限档名称不同（裁决 6、14 定的） | 不在本计划里改 |
| Q7 | 旧规范怎么处理 | **归档、重立**：旧文件移到 `docs/archive/design-system-2026-10-21.md`；`docs/design-system.md` 换成 v2，只把仍然有效的实现约束（字体栈、Alpha 纪律、圆角钳制、组件优先、Monaco、布局常量）改写后并进 §10 |

## 5 跨队待办

（各队在这里记别队文件里的问题。）

| 发现队 | 文件 | 问题 | 归属队 | 状态 |
|---|---|---|---|---|

## 6 布局重构（阶段 5）

**参考仓库的本地副本**：`/home/pi/code/open-claude-ui`（用户 2026-10-22 拉取的最新版 `c1f923a`）。它没有「会话侧栏」与「旁问」，这两样以 Claude Code 桌面版官方文档为准（`code.claude.com/docs/en/desktop`：See session details、Ask a side question without derailing the session）。参考里与右侧面板相关的数值：文件面板默认宽 480px、最小 320px（`docs/v2/04` §4.4）。

**来由**：用户验收阶段 3、4 时说「感觉变化不是很明显，我更希望是 UI 的重构布局，对齐 open claude ui」。前四个阶段只换了外观，外壳仍是「44px 图标导轨 + 侧栏面板 + 中间对话 + 右侧一整栏」。预览：[`docs/design/2026-10-22-layout-restructure-preview.html`](../../../design/2026-10-22-layout-restructure-preview.html)。

**视觉目标（用户 2026-10-22 给的截图）**：[Claude Code 桌面版 Windows 截图](../../../design/reference/2026-10-22-claude-code-desktop-windows.png)。用户：「虽然字号字体 UI 改观了很多，但比较起来还是差了一些美观和协调性」。以后与 HTML 预览或参考仓库不一致时，**以这张截图为准**。要点：
- 细边线照常有（截图模糊看不清；用户确认），不用为此删线。
- **用户 2026-10-22 定先改两点**：字更小更安静（对话正文 14→13、卡片标题 15→14、页面标题 20→18，已落 `globals.css`）；输入框改成很薄的一行、随输入增厚，权限与模型挪到框下一行。其余按第 5 阶段改。
- 字小而安静：界面 13px，说明 12px，对话正文约 13～14px；层级主要靠灰度，不靠字号和粗细。
- 标题栏就是窗口顶栏：一行约 36px，左边是对话名加下拉箭头，右边只有图标按钮（会话侧栏开关、终端、改动、浏览器、文件、⋮）和窗口按钮。
- 侧栏：左上角是菜单、侧栏开关、后退、前进；顶上是 New / Artifacts / On-call / Customize / More 一列小入口；对话行只有文字，约 25px 高，状态在行尾用小标记；分组标题小而灰，右边有「+」；分叉的对话缩进并用连接线；每组末尾是「Show more」。
- 对话栏居中约 640px；用户消息是右对齐的浅灰块、小圆角；工具过程收成一行灰字摘要，末尾带「›」。
- **输入框很薄**：单行、细边、圆角约 10px，左边「+」，右边录音键；权限（Auto）和模型（Opus 5.5 High）、上下文环在输入框**下面一行**的纯文字里，不在框里。这与阶段 0 的 Q2（输入框 20px 大圆角、工具栏在框内）不一致，以截图为准。
- 会话侧栏卡片：Environment（本机、项目路径、分支 / Worktree）、Context（百分比加小进度条）、Changes（+N −M、Commit changes）、Servers（预览服务）；卡片标题 12px 加粗、带折叠箭头，内容 12px。



| # | 选择 | 裁决 |
|---|---|---|
| L1 | 图标导轨 | **去掉**，只留一条可整个收起的侧栏：品牌名与收起按钮、「新对话」、搜索 / 对话 / 仓库 / 技能与插件四个入口、对话列表、底部账户 |
| L2 | 侧栏分组 | **用户可以自己切换**：按仓库 / 按状态（运行中、等你处理、最近完成）/ 按时间，默认按仓库，选择记住 |
| L3 | 中间与右侧 | 中间是居中阅读栏（对话与输入框同宽，约 720px，输入框悬浮在底部）；一轮的改动收成「改了 N 个文件」卡片；**右侧工作面板平时关着、按需打开** |
| L4 | 终端 | **右侧面板的一个标签** |
| L5 | 会话侧栏 | **要**：对话右边一列卡片——环境、改动、待办、运行中、上下文（出处：Claude Code 桌面版 session details panel）。输入框工具栏上的用量芯片与运行位置、输入框上方的待办条、原「上下文」「运行」面板都收进这里。开关在标题栏右边按钮组的**最左侧，用竖线和改动 / 文件 / 终端按钮隔开**；打开右侧工作面板或停靠侧边对话时让位 |
| L6 | 旁问 | **要**：Ctrl+; 或 `/btw` 打开，能读主对话到当前为止的内容，问答不写回主对话、关掉即丢弃。**默认右下角小窗，可以停靠到右侧** |
| L7 | 侧边对话（split view） | **要**：旁问窗口的标题是下拉，可以改为打开一个现有对话；侧栏对话行右键「在侧边打开」。打开现有对话时默认停靠在右侧，两个对话并排、各有输入框，侧边那个可收回小窗或关掉 |
| L8 | 右侧的展示形式（用户 2026-10-22 看过 5a 后改） | **独立的卡片窗**，不是带标签的一整页：改动、文件、终端、浏览器、后台任务等各是一张圆角卡片，各自只有一行标题（图标、上下文标题、自己的操作、放大、关闭），多张时在对话右侧排成网格；去掉 5a 的外层标签条和内容里重复的标题行。参照截图 `/home/pi/Pictures/17926489167536.png` 与后台任务截图 |


**子任务与分工**（先做 5a，做完后 5b～5f 并行）

| # | 内容 | 名下文件 |
|---|---|---|
| 5a 外壳骨架（一人先做） | 去掉导轨，`LeftDock` 只剩侧栏并能整个收起（收起后标题栏左边出现展开按钮）；标题栏只放对话名、仓库、分支，右边是改动 / 文件 / 终端 / 更多按钮，无边线；右侧一整栏换成「右侧工作面板」容器：标签（改动、文件、git、终端、运行、上下文、编辑器），可关、可拖宽；原来导轨上的入口与快捷键改指向面板标签；旧的布局持久化（导轨顺序、各面板宽度）迁移 | `WorkspaceShell.tsx`、`LeftDock.tsx`、`SessionBar.tsx`、`shellLayoutModel.ts`、`surfaceRegistry.ts`、`rightColumnModel.ts`、`centerLayoutModel.ts`、`center/`、`useShellShortcuts.ts`、`shellShortcuts.ts` |
| 5b 侧栏 | 顶部品牌与收起、「新对话」按钮、四个入口；对话行 28px、行尾分支名、运行中呼吸点；分组切换（仓库 / 状态 / 时间，记住选择）；底部账户与设置 | `LeftNav.tsx`、`sidebarTree.ts`、`sidebarNavModel.ts`、`UserFooterPill.tsx`、`deriveChatWorkspaceTree.ts` |
| 5c 中间阅读栏 | 对话与输入框居中同宽；一轮的文件改动聚合成一张卡片，点开在右侧面板「改动」标签定位到对应文件 | `chat/` 下时间线与输入框文件（阶段 3 A、B 的名下文件） |
| 5d 卡片窗（按 L8 重做） | 改动（原审阅面板）、文件、git、终端、运行、上下文各自作为面板标签的内容适配宽度与标题；打开文件时在面板里的编辑器标签打开 | `surfaces/`、`SessionReviewPanel.tsx`、`surfaceViews.tsx`、`terminal/`、`files/`、`source-control/` |
| 5e 会话侧栏（5a 之后） | 五张卡片与开关；把用量芯片、运行位置、待办条、上下文与运行面板的内容迁进卡片；窄窗口时自动隐藏 | 新建 `workspace-shell/sessionRail/`；从 `chat/ComposerUsageChip.tsx`、`chat/RunLocationIndicator.tsx`、`chat/TodoCard.tsx`、`surfaces/ContextSurfaceView.tsx`、`surfaces/RunSurfaceView.tsx` 取内容 |
| 5f 旁问与侧边对话（5a 之后） | 小窗 / 停靠两种形态；旁问：SDK 引擎用 CLI 自带的 `/btw`，DSH 引擎要另开临时会话带上主对话内容（开工时先确认做法）；侧边对话：在侧边容器里再挂一个对话视图（同一宿主本来就支持多会话） | 新建 `workspace-shell/sideChat/`；对话视图复用 `chat/ChatWorkspace` |

搜索入口打开现有的全局搜索；「仓库」入口打开仓库列表与添加仓库；「技能与插件」打开设置里对应的页。暂不做：右侧面板弹出到独立窗口（预览里的按钮），以后再说。

