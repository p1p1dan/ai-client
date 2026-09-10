# H/18 左侧 Chat 栏对齐 —— 验证记录

日期：2026-09-10。范围：[实施计划](../../topics/sidebar-pi-desktop-alignment.md) 执行清单 S1～S5。基线提交 `a57b9403`。

## S1 分区级右键菜单

两个分区各挂一个 `ContextMenu.Root`：

- 临时会话分区（`renderUnboundSection`）→「新建临时对话」，调 `createUnboundChatSession()`。
- 项目分区（「Repositories」标题行 + 下面所有仓库分组）→「添加仓库」，调 `onAddRepository`。

**嵌套靠的是 Base UI 自己的行为，不是我们加的拦截**。`ContextMenuTrigger` 的 `handleContextMenu` 第一件事就是 `stopEvent(event)`（`preventDefault` + `stopPropagation`，见 `node_modules/@base-ui/react/esm/floating-ui-react/utils/event.js`），所以内层 trigger 一定压过外层。会话行本来就是一个 trigger，因此「在行上右键弹行菜单、在空白处右键弹分区菜单」不需要写任何一行协调代码——这一条已由渲染测试实测确认，不是推断。

项目分区的 trigger 包住多个兄弟节点，会吃掉父容器的 `space-y-3`，所以 trigger 自己补了一份，否则标题行与仓库分组会挤在一起。

## S2 项目行右键菜单

仓库分组的标题行改成 context menu 的 trigger，菜单项与原来那个「更多」按钮**同一份定义**（`repoMenuItems`），不是抄一份：两份会在任何一边加动作的当天分叉，而「两个入口给同一组动作」正是本条的验收标准。原按钮保留——只有右键的话没人找得到。

**没有仓库的分组不包 trigger**。合成的 Temp 分组背后没有 `Repository`，包了就等于给它一个空菜单的 trigger，而 trigger 会吞掉右键事件，那一行就再也够不到项目分区的菜单了。落地时写成 `repoMenuItems ? (包起来) : (裸 header)`。

这一条差点写错：渲染测试第一次跑就红了，报「在仓库标题行上右键弹出的是『添加仓库』」——原因是测试夹具给的 `repo.id` 和 store 里的 project id 不一致，`projectIdForRepo` 匹配不上，于是走进了「没有仓库」的分支。夹具的问题，不是实现的问题，但它证明了这条分支真的会发生，也证明了这个测试能看见它。

## S3 未读完成/失败徽标

新增 store 字段 `unreadSessionIds`（`chatSessions.ts`），不是 `ChatSession` 上的字段——「我看没看过」是读者的属性，不是会话的属性。

- **只有自己结束的回合算**：`session.completed` / `session.failed` 记，`session.stopped` 不记（用户自己按的停止，他已经知道结果了）。
- **当前正在看的会话不记**，所以没有第二条「到达即已读」的路径要和它保持一致。
- **打开即已读**：清除点在 `selectSession` 里，不在侧栏里——中间标签栏、仓库标题行激活等入口都会经过它。
- **数组身份稳定**：没有变化时返回原数组。`session.completed` 每个回合都触发，返回新数组会让整个侧栏为一个没变的事实重渲染。
- **会话消失时剪枝**：`applySessionIndexRefresh` 过滤掉已经没有行的 id，否则关闭/归档过的会话会永远留着一个再也点不掉的标记。

界面上，未读复用会话行**已有的那个 6px 标记槽**，不新开一个：行宽本来就紧张（标题有 `min-w-20` 下限），多一个点就会挤标题。三态按紧急度排序 `busy → unread → started`，而且这个顺序恰好让共享槽位不丢信息——跑着的会话不可能同时握着一个未读结果（结果就是跑完），而未读的会话必然处于 started 状态，显示圆环反而是两者中没用的那半。完成用 `bg-success`、失败用 `bg-destructive`。这一个标记**不是** `aria-hidden`（旁边两个运行状态点是），因为它是这条信息的唯一载体。

## S4 收起按钮移入 rail

从面板标题行 `DockTitle` 移到常驻图标列，动作从 `closeSurface` 改为 `toggleContextPanel`。

**这是一处计划外的语义调整，在此登记**：计划只说「移入 rail」。但 rail 比面板活得久，一个只能关不能开的按钮在面板已收起时就是死的——而那正是 rail 单独在屏幕上的时候。改成 toggle 之后它与 Ctrl+B 走的是同一个 store action（`useShellShortcuts` 的 `toggle-dock`），两者不会漂移成不同含义。图标随状态在 `PanelLeftClose` / `PanelLeftOpen` 之间切，标签随之在「收起侧栏」/「展开侧栏」之间切。

Escape 关闭面板那条路径没有动。

## S5 验证

**自动化**：全量 **368 文件 / 5201 测试通过**，根目录、`src/agent-host`、`src/runtime` 三套 tsc 通过，Biome 全 `src/` 通过（余下 2 条警告在未改动文件里）。

新增用例：

- `sidebarContextMenuInteraction.test.ts` 4 项，**真实渲染 LeftNav 并派发真实 `contextmenu` 事件**（happy-dom）。这是本轮唯一能回答「右键到底弹出了哪个菜单」的测试，静态扫源码只能证明菜单被声明了。覆盖：行菜单压过分区菜单、仓库标题行给仓库菜单、临时分区给「新建临时对话」、项目分区给「添加仓库」且点击真的回调；以及未读标记在 Recent 与仓库分组**两处**同时出现、点开会话后两处同时消失。
- `unreadSessionMarkers.test.ts` 9 项，纯 store：完成/失败/停止三种事件的分别处理、当前会话不记、去重、数组身份、以及刷新时的剪枝与身份保持。
- `sidebarSectionMenus.test.ts` / `unreadRowMarkerStatic.test.ts` / `railCollapseStatic.test.ts` 静态钉住结构与 S4（rail 上的按钮、标题行不再有重复的那个）。

改写的用例：`sessionContextMenuWiring.test.ts`。它原来按「文件里第一个 context menu trigger」定位会话行，而 S1/S2 在会话行之前又加了两个 trigger，于是它开始断言错的元素。改成先切到 `SessionRow` 再断言，并加了一条反向断言防止这层切分将来变得无意义。

## 未验证

- **未在真实应用里点验**。本机尝试过：`pnpm dev --remote-debugging-port=9222` 能起来、DevTools 端口在 listen、TCP 能连上，但 HTTP `/json` 与 browser WebSocket 都不回包（curl 与 node ws 各试一次，均超时）。本环境的 CDP 通道不通，因此没有截图和真实点击记录。渲染测试覆盖到了菜单开合与徽标出现/消失，但覆盖不到真实窗口下的定位、层级与视觉。
- 未打包，未做安装版/加密 Windows 回归。
- 验证案例 4（两个工作目录会话同时运行、状态互不影响）本轮未测——它验证的是既有能力（计划里已确认「本就支持」），本轮没有改动那条路径。
- 键盘可达性（验证案例 2 的后半）只在代码层保证：会话行有 `tabIndex={0}`，菜单是 Base UI 的，Esc 关闭在渲染测试里用过一次；没有做完整的 Tab 序列走查。
