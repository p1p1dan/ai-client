# D03 — 侧栏密度取舍、runtime 补字段归属、service_tier 取证启动

- **日期**：2026-09-03
- **状态**：Active
- **拍板人**：用户（对 [execution-plan](../topics/execution-plan.md) 提出的 Q08/Q09/Q10 三项建议全部采纳）

## 背景

制定执行计划时对代码做锚点复核，暴露出三个此前没被发现的问题：两份取证在侧栏行高上给了相反判定；
两个 UI 任务卡在同一处 Pi runtime 数据缺口；请求优先级的注入通道从未被证实存在。
三者都会改变切片范围，因此在 U01 开工前一并拍板。

## 决定一：侧栏行高保留 28px（解 Q08）

**采纳**：侧栏行高维持本仓现有的 **28px**，不改为 pix 的 32px。U01-c 的间距档改动**不包含**侧栏行高。

**冲突的两份取证**：

- [evidence-u01](../topics/evidence-u01-numeric-scale.md) 把 sidebar row `28 → 32` 列入「数值档可搬」。
- [evidence-u09](../topics/evidence-u09-component-forms.md) #6 判定侧栏「不搬」，明确要求「保留 28px 密度与我们的 IA，不要取 pix 32px 行」。

**理由**：同一个数字横跨两层——它既是 U01 管的间距档，也是 U09 管的组件密度。[D01](./001-style-depth-and-sequencing.md)
决定一只授权了样式 token 层，组件形态需逐件对照后单独拍板，而 U09 正是那次逐件对照，结论更晚也更具体。
在授权边界内，U09 的判定优先。

**未采纳**：改为 32px（会同时放大侧栏视觉体量，与「利落简约」的密度诉求相反，且 U09 已判定本仓侧栏形态正确）。

**影响**：U01-c 的验收标准不含侧栏行高；`docs/design-system.md:546` 的 `h-7` 分档保持不变。

## 决定二：Pi runtime 补字段挂 Pi-only 计划 T38（解 Q10）

**采纳**：在 [Pi-only 收敛计划](../../pi-backend-migration/README.md) 下新开 **T38**，承载 UI 计划需要但属于
Pi runtime 数据契约的补字段工作。本 UI 计划不改 runtime。

**T38 的范围**（来自 [evidence-q04](../topics/evidence-q04-runtime-fields.md)）：

1. Pi worker 从 `turn_end` / `agent_end` 的 `message.usage` 取值并发出 `usage.updated`——事件类型
   （`runtimeEvents.ts:613`）早已存在，缺的是生产者（`piWorkerSession.ts:672` 当前直接丢弃 usage）。
2. 在 `AgentModelOption` 上暴露 `contextWindow`——Main 侧已持有，被 `piModelOption` 剥离（`piModelConfig.ts:109`）。
3. 可选：`tool.updated` 转发 output/partialResult，用于活动工具状态行。

**理由**：这批字段是**既有契约的补全**，不是新方向——schema 早就定义了 `usage.updated`，只是从来没有生产者。
挂在 Pi 计划下语义最准，也不必为此新增计划根。

**未采纳的两个方案**：

- *另立 runtime 增强计划根*。范围太小，会违反「不为每个任务新建计划根」的治理规则。
- *暂不做，U06 只交付渲染层部分*。会让 Run 面板长期缺少它最核心的一块（上下文占用），且 U09-2 的
  底栏占用 chip 也一并无限期挂起。

**后果**：Pi-only 计划的生命周期从 `Completed` 变为 `Completed core / T38 active`。T38 **不重开** T37 发版门禁，
也不恢复任何 legacy execution 路径；它只增加事件生产者与目录字段。

## 决定三：service_tier 注入点现在取证（Q09 保持开放）

**采纳**：立即派子代理取证 Pi runtime 有没有可透传的请求参数通道。U08-3（请求优先级）在结论回来前保持挂起。

**已核事实**：全仓源码对 `serviceTier` 零命中，唯一命中在 `pi-coding-agent` 自带的 OpenAI SDK 类型里；
我方 `piModelConfig.ts:53-54` 声明了 `samplingParams` / `compat` 两个透传口，但 `piWorkerSession.ts` 不消费它们。

**理由**：这是可证伪的事实问题，不是偏好问题，不该靠猜。取证读的是依赖包与本仓代码，不依赖 U01 的改动，
可与样式地基并行，不抢基线。

**分支**：若取证证实存在注入通道，U08-3 转为可执行切片；若不存在，U08-3 并入决定二的 T38 一起处理，
或按用户判断放弃——**不做「只改本地偏好、不影响实际请求」的空壳实现**。
