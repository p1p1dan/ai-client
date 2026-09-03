# Open Questions — pix/pi-app UI 对齐改造

> 只放**未解决的问题**，不放任务。解决后移出本文件，把结论写进 decisions 或对应 topic。
> **当前没有未解决的问题。** Q01–Q12 全部关闭，结论各自指向 decisions 或 topics/evidence。
> 新问题请追加在本行下方，并在 [roadmap](./roadmap.md) 的相关任务上标注关联。

## Q11 — 三个布局尺寸要不要跟 pix 走？ — **已关闭：本轮一律不动**

**拍板**（用户 2026-09-03）：侧栏宽 280、右面板宽 380、阅读栏 45rem **全部维持现值**，本轮不跟 pix 走。

**后果**：U01-c 确认为「零改动」并已收尾；`docs/design-system.md` 里阅读栏那条失效标注保留原样
（值不变，但 48 → 约 51.4 CJK 当量的事实必须留着，否则将来没人知道原推导已经不成立）。
若日后要重开，下方原始分析仍然有效。

---

<details>
<summary>原始分析（保留备查）</summary>

U01-c 施工时发现：evidence-u01 列出的三个「可搬」尺寸**都不是样式 token，而是布局尺寸**，
落在 [D01](./decisions/001-style-depth-and-sequencing.md) 决定一授权的「字号 / 行高 / 间距 / 圆角 / 灰阶」**之外**。
evidence-u01 自己也给右面板那条标了「布局，非样式 token」。因此本轮**一个都没改**，等拍板。

| 尺寸 | 现值 | pix | 改动含义 |
|---|---|---|---|
| 侧栏默认宽 | 280 (`shellLayoutModel.ts:24`) | 272 | 差 8px，几乎不可感知；但 `SIDEBAR_MIN_WIDTH` 也是 280，要一起动 |
| 右面板默认宽 | 380 (`shellLayoutModel.ts:35`) | 480 | **差 100px，很显眼**。380 是 A08 的值、D34 复核时特意保留 |
| 阅读栏宽 | 45rem/720px | 760px | 正文降到 14px 后，720px 从 48 CJK 当量/行变成约 51.4，原推导已失效 |

阅读栏有三种自洽的选法：守住「48 字/行」的可读性规则 → 42rem；守住当前观感 → 45rem 不动；
对齐 pix 的 thread-max → 47.5rem。**建议维持 45rem**（既不缩窄也不大改，且 51 字/行仍在舒适区），
侧栏 280→272 可做可不做，右面板 380→480 建议单独确认——它会明显改变默认的三栏比例。

</details>

**关联**：roadmap U01-c。

## Q12 — U08-3 请求优先级走哪条路径，还是不做？ — **已关闭：不做**

**拍板**（用户 2026-09-03）：**不做**。U08-3 从 roadmap 移入 Dropped，不再是待办。

这正是 [D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定三预置的那条分支
（「按用户判断放弃；**不做空壳实现**」）的执行结果，因此不另开决策记录。

**放弃的理由**（三条，任一单独成立）：

1. **代价不成比例**。路径 A 要为一个次要控件新造一层本地配置覆盖机制（模型清单来自远端服务，
   本仓改不了内容）；路径 B 要押注 Pi 一个未写进文档的行为，且每条消息切档都会在会话历史里
   记一笔「模型切换」。
2. **通道挂错层**。取证证实透传能力属于「模型静态默认值」，不是「每次请求可切」——想做成控件
   必须自己补那一层，这层不是小工程。
3. **适用面窄**。`service_tier` 只有 OpenAI 系服务商认；走其它供应商时该控件不产生任何实际效果。

**若日后重开**：优先选路径 A（建立在有文档的 `samplingParams` 契约上，代价是配置层工作量而非运行时风险），
链路细节见 [evidence-q09](./topics/evidence-q09-service-tier.md)。

---

<details>
<summary>原始选项分析（保留备查）</summary>

[Q09 取证](./topics/evidence-q09-service-tier.md)已回：**通道存在，但挂在「模型静态默认值」层，不是「每次请求」层**，
两条落地路径各有代价：

| 路径 | 做法 | 代价 |
|---|---|---|
| **A 模型变体** | 同一底层模型配三份定义，各带一个 `service_tier` | 模型清单来自远端服务，本仓改不了内容；要落地得新增一层本地覆盖机制 |
| **B 发送前改 Model 对象** | 每次发送浅拷贝 Model 合并 `samplingParams` 再 `setModel` | 依赖 Pi 未公开的实现细节，升级可能静默失效；会话历史会堆满「模型切换」记录 |
| **C 不做** | U08-3 从 roadmap 移出 | 请求优先级这个能力就没有 |

**建议**：**选 C，本轮不做**。理由是这个控件的价值（延迟/成本档位）撑不起两条路径各自的代价——
A 要为一个次要控件新建一层配置覆盖机制，B 要押注一个没有文档保证的行为，还会污染会话历史。
D03 决定三本来就写明「不做空壳实现」，而这两条都算不上干净的实现。

**若要做，建议选 A**：它至少建立在有文档的 `samplingParams` 契约上，代价是配置层的工作量，不是运行时风险。

</details>

**关联**：roadmap U08-3。

## 已关闭

> 以下为陆续关闭的问题，保留结论与证据链接。

## Q09 — Pi runtime 有没有 service_tier 的注入点？ — **已关闭**

**结论**：**有通道，但挂错了层**。`Model.samplingParams` → `buildBaseOptions()` → `Object.assign` 进请求体
→ OpenAI SDK 不做字段过滤直接 POST，链路逐段核实；`service_tier` 在该版 SDK 里确是请求参数而非仅响应字段。
但这条通道属于「每个模型的静态默认值」（存在 `models.json`），**不是「每次请求可切」**；本仓能触达 Pi 的
三个公开 API 选项类型里都没有任何透传字段。`compat` 是行为开关的严格联合类型，不是透传袋。

**证据**：[evidence-q09](./topics/evidence-q09-service-tier.md)。

**派生**：落地路径的取舍转为上方 **Q12**。

## Q08 — 侧栏行高是 28px 还是 32px？ — **已关闭**

**拍板**（[D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定一）：保留 **28px**。两份取证冲突时以 U09 的逐件形态判定为准，因为 D01 只授权样式 token 层，组件密度归组件形态那一层。U01-c 不含侧栏行高改动。

**关联**：roadmap U01-c、U09。

## Q10 — U06-b / U08-3 需要的 Pi runtime 改动，要不要在 Pi 计划下开新 task？ — **已关闭**

**拍板**（[D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md) 决定二）：在 Pi-only 计划下新开 **T38**，承载 `usage.updated` 生产者、`contextWindow` 暴露与可选的 `tool.updated` 输出转发。理由是这批字段属既有契约补全而非新方向。Pi 计划生命周期转为 `Completed core / T38 active`。

**关联**：roadmap U06-b、U08-3；Pi 计划 T38。

## Q01 — 不绑定工作目录的会话，cwd 落在哪？信任门怎么处理？ — **已关闭**

**拍板**（[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定二）：cwd 落在**隔离临时目录**，默认**不信任**、逐次请求授权、写路径默认拒绝。

**关联**：roadmap U05。

## Q02 — 模型菜单的二级分组，实际分的是供应商吗？ — **已关闭**

**拍板**（2026-09-03 用户）：**保留管理站主页分组标签，不改分组键**。`model.tags[0]` 本就是管理站配的主分组标签（任意有序字符串），不是供应商字段；用户确认这个行为符合预期。U08-1 从「需改分组键」**改为「不改，保留现行为」**。

**证据**：[topics/evidence-q02-q03.md](./topics/evidence-q02-q03.md) §Q02（此处仅记录分组键语义；最终拍板是保留，而非改为 provider 派生）。

**关联**：roadmap U08-1。

## Q03 — pix 的「资源（Resources）」在本仓对应什么实体？ — **已关闭（修正）**

**结论（2026-09-03 用户实测修正确认）**：pix 左栏顶部是 **新建会话 / 插件 / 资源**。「插件」页是**包管理**（本地已装插件，可禁用/更新/移除 + 发现页）；「资源」页是**文件清单**（index.js / extension.js / agent.md 等）。两者是同一批 extension 的两个视角，资源页目前看不出用途。

**拍板**：左栏只加「插件」，**资源入口本轮不要**。

**证据**：[topics/evidence-q02-q03.md](./topics/evidence-q02-q03.md) §Q03（pix 侧 kind 枚举 extension/skill/prompt/theme/context/system），叠加用户实测：**实际可见内容只有 extension**。

**对 U04 的影响**：只做插件入口，资源不做；**不要**把「资源」映射到 Files/editor surface。

**关联**：roadmap U04。

## Q04 — Pi runtime 报不报 Run 面板需要的运行态字段？ — **已关闭**

**结论**：**不是纯渲染层能做的**，但也不是全缺。状态机 / 模型 / 选中 effort / 回合耗时 / 工具**名称**都能用现有 `RuntimeEvent` + renderer store 拼出来；**上下文占用 % 与 usage 行**（`usage.updated`）schema 里有但 **Pi worker 从不发**，且目录剥离了 `contextWindow`——这两块需 Pi runtime 补字段，**归 Pi-only 计划，不在 UI 计划改**。

**证据**：[topics/evidence-q04-runtime-fields.md](./topics/evidence-q04-runtime-fields.md)。

**边界**：U06 可分两半——渲染层能拼的先做（状态/模型/effort/耗时/工具名），占用 donut + usage 行留待 Pi runtime 补 `usage.updated` 后做（或作为 Pi 计划的 task）。

**关联**：roadmap U06。

## Q05 — 双栏模式下，Files / Git / Terminal 从哪进入？ — **已关闭**

**拍板**（[D02](./decisions/002-layout-cwd-and-evidence-scope.md) 决定一）：双栏 = 只承担 AI 对话与 AI 开发。Files / Git / Terminal 等**刻意不提供**长期入口，需要时**切回三栏**使用，不另设浮层/标签页/抽屉。

**关联**：roadmap U02、U03。

## Q06 — 思考强度换成 Pi 的 ThinkingLevel，已存的用户偏好怎么迁移？ — **已关闭**

**结论**：复制 pix 的**纯 mapper + read 时映射**模式，**不**复制双 key。因为 `EffortLevel` 与 `ThinkingLevel` 在 `low|medium|high|xhigh|max` 上重叠，这些值保留原样；只教 store 认识新词汇 `off`/`minimal`。未知/垃圾值 → `default` 哨兵（不是 `off`）。**不静默重写**已存偏好，等用户下次写入时落盘新值。

**证据**：[topics/evidence-q06-migration.md](./topics/evidence-q06-migration.md)。

**两个落点**：① per-agent template（`chatAgentDefaults.effort` / `sanitizeChatAgentDefaults`）；② per-session（`localStorage aiclient:chat:session-efforts`，在 `readSessionEffort` 映射，守卫放宽到新词汇）。

**关联**：roadmap U08-2。

## Q07 — 「利落简约」在组件层具体指哪些形态差异？ — **已关闭**

**结论**（[evidence-u09](./topics/evidence-u09-component-forms.md) 对照表）：逐件对照 6 件组件后，**我们已有的 Codex 简约形态大多正确**——模型 chip（24px 方 ghost）、助手输出（平铺+裸工具行）、用户气泡（80% + 锐右上角）、侧栏（28px 行）均**不搬** pix。「利落简约」的真实落点只有一处：**Composer 空会话时的顶部接合摘列**（project/local/branch 作为卡片顶盖）。不是大改，是一处几何微调。

**对 U09 的意义**：U09 从「产出对照表」收敛为「实施 #1 Composer 空态摘列」一个可执行切片。其余 5 项不动。

**关联**：roadmap U09。
