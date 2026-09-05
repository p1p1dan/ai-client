# D06 — 插件清单由 worker 上报，不在 Main 重实现 pi 的解析

- **日期**：2026-09-04
- **状态**：Active
- **拍板人**：用户（U04 开工前，三条候选中选第一条）

## 背景

U04 要「左栏插件入口，展示已装插件与 MCP 就绪数」。开工前取证发现两件事：

1. **「MCP 就绪」在 pix 里不是 MCP API**。pix 的 `mcpStatusFromExtensionUi` 扫描扩展通过
   `ui.setStatus` 发布的状态文本，正则抠出 `N/M`。本仓有对等物——T09 的 `extensionUiDisplayModel`
   已经在存 `statuses`，所以这半边是纯渲染层。
2. **「已装插件」在本仓没有数据源**。渲染器和 Main 都不知道装了哪些插件；全仓唯一的扩展是随包的权限插件。
   pi 自己用 `SettingsManager` + `PackageManager` 解析插件（settings、npm/git 包定位、enabled 过滤、user/project 作用域）。

## 决定：worker 在 bootstrap 时把「实际加载了什么」一并上报

**采纳**：`bootstrapPiAgentSession` 已经为了校验权限插件而调用
`services.resourceLoader.getExtensions()`——把那份结果投影成 `WorkerExtensionInfo[]`，
随 `WorkerBootstrapResult` 上报，Main 缓存在 `ManagedSlot.bootstrap` 里，渲染器按会话拉取。

**理由**：这是**唯一权威**的答案。pi 拥有插件解析，在 Main 侧重写一份意味着两套实现，
它们迟早不一致——而不一致的表现形式是「界面说装了 3 个，agent 实际只加载了 1 个」。
本仓在 U08-2 上刚栽过同类的坑（五档词汇有四份手抄，其中一份是发布级）。
而且 worker 手里**已经有**这份数据，转发它不需要 pi 补任何字段。

**未采纳**：

- *Main 扫 pi 的配置目录*。不碰 worker，留在本计划的舒适区，但就是上面那份「第二份手抄」。
- *这批只做徽标、清单等以后*。本仓目前没装任何 MCP 扩展，那个入口对绝大多数用户是空的——
  按本计划自己的规矩（无数据不渲染空壳），等于交付一个空壳入口。

## 约束

- **上报字段可选，且不进 `isWorkerBootstrapResult` 的校验**。那个守卫是发布级的：
  它判定整条 bootstrap 载荷是否合法，在里面严格校验插件列表，会把一个畸形的插件数组变成
  「整个会话起不来」（U08-2 的 `isWorkerEffort` 就是这么炸的）。
  改为**生产者侧净化**（`readLoadedExtensionInventory` 逐项防御式读取、丢弃读不出来的条目、封顶 64 条）。
- **`null` 与 `[]` 语义不同**：前者是「这个会话没有活着的 worker，没人报告过」，
  后者是「报告了，一个都没加载」。侧栏对两者说不同的话，任何一方向的猜测都是谎报用户的配置。
- **按会话，不按应用**：pi 的 project 作用域插件是从会话自己的 cwd 解析的，
  一份应用级清单对第二个工作区必然是错的。
- **隐藏的内联扩展不列出**：权限活动观察器与档位裁决器是我们自己注册的 `hidden: true` 工厂，
  它们是用户已经在别处看到的功能（审批弹窗、档位芯片）的实现细节；把它们列成「已装插件」
  会引导用户去找卸载入口。
