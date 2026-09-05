# Evidence — U14 壳层横条重排与双栏收敛

**日期**：2026-09-04
**分支**：`feat/pi-primary-backend`
**切片**：U14（新开，由用户看到实际界面后提出）
**决策**：[D07](../decisions/007-two-column-is-two-columns-and-one-bar-per-column.md)（推翻 D02 决定一 + D05）

## 一、起因与取证

用户原话：顶栏、中右侧的横栏、右侧的小图标栏「十分的不协调，显得软件很臃肿」，
并指原型 `docs/design/a10-pix-ui-alignment-prototype.html` 的形态就是目标。

**「为什么没对齐」的确切答案有三层，前两层是范围问题，第三层是矛盾：**

1. 原型在计划 README 引用表里的登记原文就是「原型画面，**非施工依据**」；
   全份 execution-plan 只有 U09-2 验收①引用过它（管 Composer 底栏顺序）。
2. 壳层结构不在 D01 的样式授权内，也不是 Q11 的尺寸问题——**无人认领**。
3. **原型 CSS `:90` 写 `[data-mode="two"] .right { display: none }`，
   D02 决定一写「右栏仍承载 context」。代码跟了 D02。** 这是双栏至今是三列的原因。

## 二、改前 vs 改后

| | 改前 | 改后 |
|---|---|---|
| 中栏顶部横条 | 3 层 / 104px | **2 层 / 68px** |
| `MainHeader` 按钮数 | 7（宽栏·双栏·\|·git·files·context·run·\|·收面板） | **3**（收面板 · 双栏⇄三栏 · GUI｜TUI） |
| 顶栏元素 | 5（logo·用户胶囊·⚙·⋯·窗口按钮） | **3**（logo · ⋯ · 窗口按钮） |
| 双栏列数 | 3（侧栏 + 聊天 + context/run 面板） | **2**（侧栏 + 聊天） |
| surface 切换器 | `MainHeader` 里 4 个无标签图标 | **右栏自己的文字 tab 条** |
| 三列横条对齐 | 左 2 / 中 3 / 右 3，第 2 层还贯通中右 | **各 1 条 h-9，同一水平线** |

## 三、落点

| 层 | 文件 | 改动 |
|---|---|---|
| shell | `surfaceRegistry.ts` | 新增 `columnModeHasPanel`；`isSurfaceAvailableInColumnMode` 委托给它，双栏一个 surface 都不给 |
| shell | `shellLayoutModel.ts` | `bareOpenTarget` 先问 `columnModeHasPanel` 再问别的（见 §四①）；`reduceColumnModeChange` 改为**关面板**并清 `expanded` |
| shell | `WorkspaceShell.tsx` | `hasPanelColumn` 参与 `panelVisible` / `panelOpen`；双栏**不渲染** `ContextPanel`；`MainHeader` 移入中栏、置于 chat ║ editor 之上 |
| shell | `MainHeader.tsx` | 重写：标题 · Temporary 徽标 · 文件夹 chip（TUI 时换成 handover 说明）· 三个按钮位 |
| shell | `ContextPanel.tsx` | h-9 头改为文字 tab 条（`derivePanelTabs` + `SurfaceTab`），放大按钮留最右 |
| shell | `LeftNav.tsx` | 底栏接住用户胶囊（新 `UserFooterPill`），Settings 收成图标按钮 |
| layout | `WindowTitleBar.tsx` | 只留 logo + 应用名 + ⋯ 菜单 + 窗口按钮；`onOpenSettings` prop 删除 |
| chat | **新增** `usePresentationSwitch.ts` | GUI/TUI handover 抽出（见 §四②） |
| chat | `ChatWorkspace.tsx` | 删掉整条 h-9 头；改为接收 `presentation` prop |
| settings | `AppearanceSettings.tsx` | 新增「阅读栏宽度」一节 + 宽阅读栏开关 |
| shared | `i18n.ts` | 5 个新键 |

## 四、两处不能含糊的地方

**① `firstAlwaysSurfaceId` 的兜底会撒谎。** 它结尾是 `?? 'context'`，为空注册表准备的
安全网。双栏下 `railSurfaces` 返回空数组，照单全收就会让 `activeSurfaceId = 'context'`——
**声称有面板开着，而屏幕上根本没有那一列**。所以 `bareOpenTarget` 先问
`columnModeHasPanel`，答否直接 `null`，`applyOpen` 原样返回 `prev`。
`shellLayoutModel.test.ts` 有两条断言钉死这个顺序。

**② 依赖方向守卫当场判红了第一版做法。** 第一版让 `ChatWorkspace` 渲染 `MainHeader`
（因为 handover 状态在那儿），`composerTargetGuards.test.ts > components/chat never imports
components/workspace-shell` 立刻失败。守卫是对的。改法是把 handover 抽成
`components/chat/usePresentationSwitch.ts`，由 **shell** 持有唯一实例、同时喂给两边——
方向变成 workspace-shell → chat，合法，且 handover 逻辑一个字节没改。

## 五、门禁结果

按 [baseline test-and-release-gates](../../../baseline/test-and-release-gates.md) 串行：

1. **Vitest**（`--maxWorkers=1 --no-file-parallelism`）：全仓 **267 files / 4158 tests pass**。
2. `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck`：pass。
3. `pnpm typecheck:agent-host`：pass（本片未改 agent-host，跑完确认未误伤）。
4. `pnpm exec biome check src/`：干净。
5. `git diff --check`：干净。

### 变异验证（4 条，全部转红）

| 变异 | 结果 |
|---|---|
| 删掉 `bareOpenTarget` 开头的 `columnModeHasPanel` 早退 | `shellLayoutModel.test.ts` **2 条**转红 |
| `columnModeHasPanel` 恒返回 `true` | workspace-shell 目录 **4 文件 / 14 条**转红 |
| `panelVisible` 退回 D02 时期的 `isTui ? false : chrome.panelVisible` | `panelVisibilityStatic.test.ts` **1 条**转红 |
| `reduceColumnModeChange` 保留 `expanded: prev.expanded` | `shellLayoutModel.test.ts` **1 条**转红 |

### 被改写的既有测试（9 文件 24 条）

全部是「记录了旧形态」而非「发现了缺陷」，逐条改到新事实并写明理由：

- `surfaceRegistry` / `panelTabsModel` / `shellLayoutModel` / `shellShortcuts`——双栏从
  `context (+run)` 改为空集；新增 `columnModeHasPanel` 的两条（含与
  `isSurfaceAvailableInColumnMode` 的一致性断言）。
- `panelVisibilityStatic`——switcher 的归属从 `MainHeader` 改回 `ContextPanel`，
  并**反向断言 header 不得留第二份**（两处读 `railOrder` 正是清单漂移的成因）。
- `tuiHandoverWiring` / `unboundChatWiring`——扫描目标跟着代码走到
  `usePresentationSwitch.ts` 与 `MainHeader.tsx`；新增一条「聊天列不得再长出第二条横条」。
- `authGateWiring [AGW-05]`——账号 chip 从 `WindowTitleBar` 挪到 `LeftNav`，
  断言跟着代码走，并加一条「顶栏不得留第二份」。
- `fontDomainScan`——我新写的头像 `text-[10px]` 命中 D25 §6.3 禁用清单，改用 `text-meta`。

## 六、欠项与已知代价

- **GUI 点验未做**：并入既有的一次性累计点验。本片新增五个看点：
  ① 双栏真的只有两列；② 中栏只剩两条横条且三列齐平；③ 顶栏只剩三件；
  ④ 右栏 tab 条是文字不是图标；⑤ 设置里能找到宽阅读栏。
- **U06-a / U07 在双栏下不可达**（D07 决定一的明示代价，用户已确认）。
- **`Ctrl/Cmd+1..4` 与 `Ctrl/Cmd+J` 在双栏下全部无效**——快捷键解析层直接返回
  `null`，不会触发一个没人执行的 action。
- **macOS 的账号胶囊本次才第一次可达**：`WindowTitleBar` 在 macOS 上整个返回 `null`，
  胶囊此前只有 Windows/Linux 用户看得到。移进左栏底部顺带修好了这个平台缺口。
- **顶栏保留了 ⋯ 菜单，与用户所选的「只留应用名 + 窗口按钮」有一处出入**：
  该菜单装的是重载 / 开发者工具 / 退出，都是应用级；而 onboarding 与 welcome 两个壳
  **没有左栏底部**可以承接它。留在顶栏是为了这两个界面不失去入口。
