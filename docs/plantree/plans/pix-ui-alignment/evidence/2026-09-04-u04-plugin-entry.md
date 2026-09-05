# Evidence — U04 左栏插件入口（批次 7）

**日期**：2026-09-04
**分支**：`feat/pi-primary-backend`
**切片**：U04（单切片）
**执行计划**：[execution-plan §三 批次 7](../topics/execution-plan.md)
**边界**：[Q03](../open-questions.md) 拍板只做插件、不做资源；[D06](../decisions/006-plugin-inventory-source.md) 定死清单来源

## 一、开工前取证改变了这一片的形状

原验收①写「入口展示已装插件与 MCP 就绪数」。取证发现这两个数**来源完全不同**，
而且其中一个在本仓根本不存在：

- **MCP 就绪数不是 MCP API**。pix 的 `mcpStatusFromExtensionUi`
  （`apps/desktop/src/renderer/lib/extension-ui-state.ts:251`）扫描扩展自己通过 `ui.setStatus`
  发布的状态文本，用 `/(\d+)\s*\/\s*(\d+)/` 抠出比值。本仓 T09 的
  `extensionUiDisplayModel` 已经在存这份 `statuses`，所以这半边是纯渲染层。
- **已装插件清单本仓没有**。渲染器与 Main 都不知道装了什么；全仓唯一的扩展是随包权限插件。

因此开工前把数据源问题交给用户拍板，结论落为 [D06](../decisions/006-plugin-inventory-source.md)：
**worker 上报实际加载的扩展**，不在 Main 重实现 pi 的解析（那会变成第二份手抄，
表现形式是「界面说 3 个、agent 实际加载 1 个」）。

## 二、落点

| 层 | 文件 | 改动 |
|---|---|---|
| agent-host | **新增** `extensionInventory.ts` | 把 pi 的 `getExtensions()` 结果投影成 `WorkerExtensionInfo[]`：逐项防御式读取、隐藏内联扩展、失败项带错误、封顶 64 条 |
| agent-host | `piAgentSessionBootstrap.ts` | `PiLoadedExtensions` 补 `hidden` / `sourceInfo` 两个 `unknown` 字段；在**每次**建 runtime 时抓取清单（`switchSession` 会换 cwd，project 作用域插件跟着变）；随结果返回 |
| agent-host | `piWorkerSession.ts` | 空数组时省略字段，让「没报告」和「报告了空」保持可分 |
| shared | `types/workerRpc.ts` | `WorkerExtensionInfo` + `WorkerBootstrapResult.extensions?` |
| shared | `types/ipc.ts` | `chat:listSessionExtensions` |
| main | `WorkerManager.ts` | `getSessionExtensions()` 读缓存的 bootstrap；无 slot 返回 `null` |
| main | `ipc/chat.ts` | 只读处理器，不起 worker、不排队 |
| preload | `index.ts` | 透传 |
| renderer | **新增** `pluginInventoryModel.ts` | MCP 比值解析 + 清单排序 + 徽标取舍 |
| renderer | **新增** `useSessionExtensions.ts` | 按会话拉取，`session.created` 时重取 |
| renderer | `LeftNav.tsx` | 底栏「插件」入口 + 徽标 + 对话框 |

## 三、三个不能含糊的语义

**① `null` ≠ `[]`。** 前者是「这个会话没有活着的 worker，没人报告过」，
后者是「报告了，一个都没加载」。侧栏对两者说不同的话（「发送一条消息启动这个对话后才能看到」
vs「这个对话没有加载任何插件」），任何一方向的猜测都是谎报用户的配置。

**② 没数据就没徽标。** 插件图标旁边一个 `0` 读起来是「你的插件全挂了」，
而不是「还没人报告」。徽标只在有 MCP 比值或有插件数时出现。

**③ 上报字段不进发布级守卫。** `isWorkerBootstrapResult` 判定整条 bootstrap 载荷是否合法；
在里面严格校验插件列表，会把一个畸形数组变成「整个会话起不来」——U08-2 的 `isWorkerEffort`
就是这么炸的。改为生产者侧净化，守卫完全不看这个字段，理由写在字段的注释里。

## 四、验收对照

| 验收 | 结果 |
|---|---|
| ① 入口展示已装插件与 MCP 就绪数 | ✅ 插件清单来自 worker 实际加载的列表（`extensionInventory.test.ts` 8 条）；MCP 就绪数从扩展自己的状态行解析（`pluginInventoryModel.test.ts` 9 条）。**如实说明**：本仓目前不随包任何 MCP 扩展，所以这个徽标只有在用户自己装了会发布 MCP 状态的扩展时才出现——这正是「无数据不渲染空壳」的规矩 |
| ② 未新增「资源」入口 | ✅ `pluginEntryStatic.test.ts`「adds no Resources entry」断言源码里既无 `t('Resources')` 也无 `nav-resources` |
| ③ 侧栏 IA 保持本仓形态 | ✅ 入口是底栏 Settings 旁边的一枚 chrome 按钮 + 对话框，不是 pix 那种一级导航（[evidence-u09](../topics/evidence-u09-component-forms.md) #6 判定不搬）。静态测试断言它在 Settings 之后的同一段 JSX 里 |

## 五、门禁结果

按 [baseline test-and-release-gates](../../../baseline/test-and-release-gates.md) 串行：

1. **Vitest**（`--maxWorkers=1 --no-file-parallelism`）：全仓 **267 files / 4155 tests pass**。
2. `NODE_OPTIONS=--max-old-space-size=1536 pnpm typecheck`：pass。
3. `pnpm typecheck:agent-host`：pass（本批改了 `piAgentSessionBootstrap.ts` / `piWorkerSession.ts` / 新增 `extensionInventory.ts`）。
4. `pnpm exec biome check src/*`：干净（1 处 `useExhaustiveDependencies` 用 biome-ignore 明示——
   `revision` 是重取**触发器**，不是函数体读取的值）。
5. `git diff --check`：干净。

### 变异验证

| 变异 | 结果 |
|---|---|
| `readLoadedExtensionInventory` 去掉 `hidden === true` 跳过 | 「hides our own inline internals」转红 |
| `derivePluginInventory` 的徽标改成恒为 `String(plugins.length)` | 2 条转红（「distinguishes nobody reported」「MCP readiness win」） |
| `getSessionExtensions` 的 `return null` 改成 `return []` | 第一次跑**全绿**——暴露了 WorkerManager 层没有覆盖，补了 2 条测试后该变异转红 |

第三条值得单独记：变异验证在这里不是走过场，它抓到了一个真实的覆盖缺口——
`null` / `[]` 的区分当时只有 IPC 层的 mock 在测，而 mock 恰恰是把这条语义假设掉的地方。

## 六、欠项

- **GUI 点验未做**：与既有的累计点验合并一次 CDP 出图（U09 / U12 / U02 / U03-a / U05 / U08-2 /
  U13 临时分组 / U06-a Run 面板 / U07 对话构成 / 本片插件入口）。
- **MCP 徽标未在真实 MCP 扩展上验过**：解析逻辑与 pix 同源（同一套状态文本约定），
  但本仓没有可用来跑通的 MCP 扩展，所以只有单测覆盖，没有真机样本。
- **插件只可见、不可管**：没有启用/禁用/更新/移除。pix 的插件页有这些，
  它们要走 pi 的 `PackageManager`（安装、持久化到 settings），属于另一个量级的工作，不在本片范围。
