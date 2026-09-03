# Open Questions — pix/pi-app UI 对齐改造

> 只放**未解决的问题**，不放任务。解决后移出本文件，把结论写进 decisions 或对应 topic。
> 这些问题是 2026-09-02 落库时识别出来的，用户表示在后续会话里重点讨论确定。

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
