# Evidence — U15 / U16：VSCode 式壳层重排与上下文页图形化

- **日期**：2026-09-05
- **决策**：[D08](../decisions/008-vscode-dock-shell.md)
- **对齐基准**：[`docs/design/a11-vscode-shell-prototype.html`](../../../../design/a11-vscode-shell-prototype.html)
- **状态**：自动化门禁全绿；**GUI 点验已做**（真实 app + 真实会话数据，见第六节与
  [截图](./2026-09-05-u15-shots/)）

## 一、原型是怎么定下来的（三轮）

用户先提「左侧栏用户在整个使用过程中不会频繁用到」，要求按 VSCode 分工重排。
原型迭代了三轮，两轮被推翻：

| 轮次 | 做法 | 结果 |
|---|---|---|
| 1 | 顶部标签条（图标 + 中文）作为左栏切换器 | 288px 下**放不下 5 个中文 Tab**（「运行」被裁掉），实测截图确认 |
| 2 | 图标轨道 + 图标下挂中文标签（轨道 60px） | 用户判定「不行好丑」，推翻 |
| 3 | **原版 VSCode 图标轨道（44px 纯图标）+ 面板标题行** | **采纳**：「就目前这样，很好。直接按照 html 这个样式开改」 |

第 2 轮还顺带被用户要求去掉面板标题行，看过效果后自己退回——**纯图标轨道离不开那行标题**，
它是唯一说明「当前在哪个区」的地方，同时也是左栏那条横条（D07 决定二的三列齐平继续成立）。

**原型阶段发现并修掉的两个真实排版缺陷**（都是截图之后才看见的，不是推理出来的）：
① 上下文页环形图与图例并排时，flex 把图例名称压到 0 宽——只剩数字，「系统提示」四个字一个不见。
改成竖排（环 → 堆叠条 → 全宽图例）后实测名称有 97px。
② 原型说明条用固定定位，文字换行变高后盖住左栏底部的账号胶囊。改成纵向三段 flex。

## 二、落地范围与关键取舍

### U15-a 左栏导航容器

`LeftDock.tsx` 是 `ContextPanel.tsx` 的继承者，不是新写的：右栏那三样机制
（surface 切换器 / 多挂载保活栈 / 拖拽把手）**跟着 surface 一起搬到左边**。
保活栈的 `visibility: hidden` 规则连注释一起原样带过来——`display:none` 的层测出 0×0，
xterm 的 `FitAddon` 会把它当 `cols: 2` 转给 pty，永久搞坏正在跑的东西的换行。

- **`chat` 复用既有 id**，语义从「分屏聊天（后置）」改为「会话列表」。不新开 id 的理由：
  `railOrder` / `lastSurfaceId` 已经把这个字符串持久化了，新开一个等于既要迁移又要留个死 id。
- **`chat` 是唯一不走 `SURFACE_VIEWS` 的 surface**：其余四个只吃 `{ surfaceId }`，
  而会话列表需要 repositories + 四个 App 侧回调，注册表带不了。dock 直接渲染它，
  并因此要在 placeholder 分支里排除它，否则会被当成「没接线」。
- **`sidebarCollapsed` 字段删除**。轨道常驻之后，「左栏收起了吗」和「哪个 surface 活着」
  是同一件事的两份状态，留着就会互相矛盾（收起了但仍有 surface 是 active）。
  现在收起 = `activeSurfaceId === null`。

### U15-b 右栏收敛

右栏就是 `EditorColumn`，展开覆盖按钮从退役的 `ContextPanel` tab 条搬到它自己的头上。
覆盖层盖的是**中栏那一行**而不是整个壳——dock 必须保持可达，这和原来 `ContextPanel`
覆盖层的边界是同一条。`expanded` 在没有打开文件时由一个 effect 清掉，
否则下次开文件会凭空盖住聊天区。

### U15-c 中栏会话 Tab

**打开态是第三份状态**，与 `sessions`（认识哪些会话）和 `activeSessionId`（正在看哪个）都不同。
依赖是**单向**的：`activeSessionId` 变化时用一个 effect 保证它在 Tab 列表里，反过来不成立。

这个方向不是随手选的：会话至少从四个地方被激活（dock 列表、Tab 条、`createChatSessionOnWorkspace`、fork），
在每个调用点加一句 `openSession()` 的做法，迟早会漏掉一个并产出「有对话没 Tab」。
镜像结果覆盖全部四个，也覆盖以后新增的。

- **关 Tab ≠ 归档/关闭会话**，会话仍在左栏列表里。
- **激活路径合并为 `useActivateSession`**：`LeftNav` 与 `SessionTabs` 共用。
  必要性在于重启后持久化的 Tab 同样没有 timeline，也需要跑一遍 resume 判定。
- 左栏行加三态标记（实心=运行中 / 空心=已启动 / 无=未启动），在一个 6px 槽位里切换，行不会跳。

### U15-d 删列数开关

`shellColumnMode` 及 `columnModeHasPanel` / `isSurfaceAvailableInColumnMode` /
`reduceColumnModeChange` 整组删除；`reduceShellSurface` 的 `columnMode` 参数一并去掉。
store 版本 v2 → v3。

**迁移不是只丢字段**：`sortSurfaces` 优先尊重持久化顺序、只把缺的补在后面，
所以 v2 档案会把 `chat` 排到**最后一个**。v3 迁移丢掉旧 `railOrder`，
并把 dock 强制打开在 `chat` 上——v2 用户的左栏一直就是会话列表，
让他们升级后看到一条空轨道会被读成数据丢失。

### U16 上下文页

**没有做「63% / 128k」那个环。** 原型画了，但这个数在本仓不存在：
模型目录剥掉了 `contextWindow`，Pi 的 worker 不发 `usage.updated`——这正是 Pi 计划 T38 要解锁的（U06-b）。
把字符数除以四印成 token，会让一个我们没测过的数看起来像运行时报的。

**做的是**：按角色构成的环形图（`pathLength=100`，所以弧长就是图例里那几个百分比，
两边不会因为四舍五入对不上）+ 同一组份额的堆叠条 + 图例。中心是总字符数。
T38 落地后这张图换个分母就是真的占用图。

「对话构成」**默认折叠 + 展开后限制条数**（前 20 条 + 「显示更多」），两条都做。
只折叠挡的是第一眼，300 轮的会话展开一次照样渲染 300 行、每行还要量自己的 block。
两个状态都随会话切换重置——一个 400 条的会话继承上一个的「显示全部」正是要防的那种炸法。

## 三、快捷键变更

| 键 | 改前 | 改后 |
|---|---|---|
| `Ctrl/Cmd+B` | 收起/展开左栏 | **收起/展开 dock 面板**（VSCode 同键） |
| `Ctrl/Cmd+J` | 开关右侧上下文面板 | **解绑**——它指向的列已经不存在，留着就是死键 |
| `Ctrl/Cmd+1..4` | git / files / context / run | **`Ctrl/Cmd+1..5`**：chat / git / files / context / run |

`Ctrl/Cmd+J` 原本是唯一一个「输入框获焦时仍然生效」的例外，这条豁免随它一起删除。

## 四、门禁

全部串行跑（`--maxWorkers=1 --no-file-parallelism`，按 baseline gates 的要求）：

- `npx vitest run` → **267 files / 4134 tests pass**
- `npx tsc --noEmit` → pass
- `npx biome check src/` → clean（9 个文件由 `--write` 格式化）
- `git diff --check` → clean

## 五、被改写的测试与理由

删掉两个文件（`MainHeader.tsx` / `ContextPanel.tsx`）会连带打断 9 个测试文件。改写理由逐条：

| 文件 | 改动 | 理由 |
|---|---|---|
| `surfaceRegistry.test.ts` | 删 `columnModeHasPanel` / `isSurfaceAvailableInColumnMode` 两组；`chat` 从「content-driven 隐藏」改为「永远可选」 | 被测函数不存在了；`chat` 语义改变 |
| `shellLayoutModel.test.ts` | 整个 two-column guard 段 + `reduceColumnModeChange` 段换成「注册表 guard」段 | 同上。bare-open 落点从 `git` 改为 `chat` |
| `panelTabsModel.test.ts` | 顺序断言加 `chat` 打头 | dock 顺序 |
| `shellShortcuts.test.ts` | `Ctrl+J` 改为「不再绑定」；digit 1..4 → 1..5 | 见第三节 |
| `centerLayoutModel.test.ts` | `SIDEBAR_COLLAPSED_RESERVE` 48 → 44 | 收起的 dock 就是它的轨道，48 会留 4px 无人绘制的空隙 |
| `contextPanelMountStatic.test.ts` | 扫描目标 `ContextPanel.tsx` → `LeftDock.tsx` | 保活栈搬家，机制与危害一字未改 |
| `panelVisibilityStatic.test.ts` | 大改；新增「列数模式不留残留」扫描 | 见下 |
| `deadControlsStatic.test.ts` | MainHeader 段 → SessionTabs 段；LeftNav 激活断言改为「一条都不许直接调 selectSession」 | 保留的是诚实性断言，丢掉的是描述已删 chrome 的断言 |
| `pluginEntryStatic.test.ts` | 扫描目标 LeftNav → LeftDock | 插件入口搬到轨道底部 |
| `sidebarRowBudgetStatic.test.ts` | 断言改为 `SIDEBAR_DEFAULT_WIDTH - DOCK_RAIL_WIDTH === 280` | 见下 |
| `unboundChatWiring.test.ts` | HEADER 目标 → SessionTabs；Temporary 标记断言改到 tab 上 | 标记搬到 Tab 上，多开时才看得出哪个是临时会话 |
| `authGateWiring.test.ts` | 目标 → `UserFooterPill.tsx` | 账号胶囊独立成文件，才能跨 surface 切换常驻 |

**两处不是「改测试迁就代码」，而是代码里的真实决定**：

① **栏宽常量改口径**。`SIDEBAR_*` 现在量的是**整个 dock（轨道 + 面板）**，
因为那才是 allocator 分配、拖拽把手提交的东西。三个值都写成「旧的面板值 + 轨道」
（`280 + DOCK_RAIL_WIDTH` 等），所以面板默认仍是 280，
`sidebarRowBudgetStatic` 那份 236px 的行内预算继续描述现实。
写成派生式而不是直接写 324/544，是因为一旦轨道宽度变了，
会**静默**失效的正是那份行预算。

② **新增一条「列数模式不留残留」扫描**：全目录扫 `shellColumnMode` /
`columnModeHasPanel` / `two-column` 三个词，命中即红。删一个模式最容易留下的
不是编译错误，而是某条分支还在按已不存在的布局判断。

## 六、GUI 点验（已做）与欠项

### 已验证（真实 app、真实会话数据，截图存 [`2026-09-05-u15-shots/`](./2026-09-05-u15-shots/)）

先踩了一次坑：直接 `npm run dev -- --remote-debugging-port=9222` 起得来、DevTools 端口在监听，
但 `/json/list` 永不回包、窗口不出现，日志停在 `Shared state paths`。
**原因不是这次改动**——本机 `HTTP_PROXY=http://127.0.0.1:7890` 会让 Chromium 把渲染进程
加载 `localhost:5173` 也走代理，然后整个应用挂死；大写 `NO_PROXY` 无效，
**Chromium 只认小写 `no_proxy`**（`scripts/run-t37c-gui-probe.mjs` 的 `startDevApp` 里已有这条注释）。
补上 `no_proxy=localhost,127.0.0.1,::1` 后一次就起来了。

| 看点 | 实测 |
|---|---|
| ① 轨道五个图标能切换且选中态可辨 | `nav[aria-label="主导航"]` 宽 **44px**，七个按钮 `聊天/Git/文件/上下文/运行/插件/设置`，`aria-pressed` 只有一个为 true，点击后正确迁移 |
| ② 面板标题行说明当前区 | 切换后标题依次读到 `聊天 → Git → 文件 → 上下文 → 运行` |
| ③ 点左栏会话在中栏新开 Tab、可多开、可关 | 连点两行后 `[role="tablist"][aria-label="已打开的会话"]` 有 **3 个 tab**，只有一个 `aria-selected="true"` |
| ④ 关 Tab 后会话仍在左栏列表里 | 三个已启动会话的行都带 `title="已在标签页中打开"` 的空心标记，其余行没有 |
| ⑤ 顶部再无双栏/三栏与「上下文面板」按钮 | 中栏横条只剩 tabs + `+` + `GUI｜TUI` |
| ⑥ 打开文件才出现右栏，展开能盖住中栏 | 未开文件时壳层只有两个子列（324 + 1078）；开文件后中栏内部分成 558 ║ 520；点展开后编辑器盖住整行、dock 仍在 |
| U16 构成图 | 环形 `aria-label="构成"`、中心 `155 字符`、图例 `助手 128 82% / 用户 27 17%` + 堆叠条；「逐条消息」`aria-expanded="false"`（默认折叠），点开列出 2 条 |

**顺带证伪了一个我自己的误判**：探针第一次点「文件」图标后左栏塌了，我一度当成 bug。
实际是**点击已激活的图标 = 收起面板**（`applySelect` 的 toggle-off 分支，VSCode 同款行为），
探针在上一步已经把「文件」设为激活了。重新点开即恢复，见截图 03。

### 欠项

1. **未验证的交互**：拖拽 dock 宽度、`Ctrl/Cmd+B` 收起、`Ctrl/Cmd+1..5` 切换三项只有单测，
   没在真机敲过键。
2. **fullscreen diff 会一并藏掉会话 Tab 条与 GUI/TUI 开关。** 这是把 Tab 条放进聊天列
   （每栏一条横条，D07 决定二）换来的代价：`diffTabActive` 时 `chatVisible` 为假，
   整列连同它的横条一起收起。**不是不可恢复**——diff 就在右栏，它自己的关闭按钮
   一按就全回来了，属于聚焦模式而非死路。若用户认为不可接受，
   备选是把 Tab 条提到 chat ║ editor 之上，代价是重新变成「顶栏贯通中右」（D07 刚拆掉的形态）。
3. **多会话并发未在真机验证**。同时启动多个会话、每个都跑真回合的资源表现没测过；
   Tab 只是打开态，worker 的并发上限仍由 `WorkerManager` 的 bounded pool 决定，本批次没碰。
4. **`SEGMENT_PAGE_SIZE = 20` 是拍的，不是量的。** 没有针对超长会话做过渲染耗时测量。
