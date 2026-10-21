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
| 3 | 各区域迁移，四队并行（§3） | 各区域代码 | 未开始 |
| 4 | issue #26 的功能项：用户消息悬停操作、diff 行号与折叠、草稿重启后保留、强度菜单说明等 | 按 §3 的文件归属分给各队 | 未开始 |
| 5 | 收尾：删迁移期的旧变量名别名、加防回退检查、全应用亮暗走查与 Windows 衬线效果、规范按落地结果回写 | `globals.css`、检查脚本、规范 | 未开始 |

顺序：0 → 1 → 2 → 3 与 4 → 5。各阶段的子任务与状态见 [tasks.md](tasks.md)。阶段 1、2 是一个人做的底座（约 3～5 天），做完之后四队互不等待。阶段 1 做完全应用会先「整体变色」但组件未改，这时可以先出一个测试包看观感，再开阶段 3。

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
