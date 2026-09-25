# DSH 二开迁移（B 路线）

Role: plan-entrypoint。建立日期：2026-09-25。状态：Planning → P0 待开工。

用户 2026-09-24 定方向：整个产品向 DeepSeek Harness（DSH）看齐、兼容其生态，同时保留登录、额度等自有功能。2026-09-25 批准调研推荐的 **B 路线**：DSH 宿主做 worker 引擎，外壳与渲染层保留，先做 P0 探针（[决策 001](decisions/001-route-b-and-scope.md)）。

## 范围

- 在现有 WorkerSlot 里用随包 `node.exe` 拉起「`dsh-base` + 我方 bundle」，由 bridge 插件把 DSH 会话事件翻成现有 RuntimeEvent；渲染层与 Main 基本不动。
- 兼容目标：L1（宿主插件能装能跑）+ L3（和官方 DSH 共用 profile 与会话格式）。L2（社区界面插件）不在本计划内，P2 之后再议。
- 分期 P0 探针 → P1 双引擎 → P2 默认切换；P3（L2）为可选，未立项。

不在范围内：1.0.x 的缺陷修复（继续在 [Runtime 加固与收口](../runtime-hardening/README.md) 做）；fork DSH 桌面端（A 路线）；在自有 runtime 里兼容加载 DSH 插件（C 路线）。

## 硬约束

1. **加密机**：读文件与执行工具必须跑在白名单载体（随包 `node.exe`）上，否则产品读到密文（ARD D11 / D13）。P0 上机不过即回到决策点。
2. **渐进**：1.0.x 已在内部使用，原生 runtime 保持默认引擎直到 P2；DSH 引擎放在开关后面。已装用户的会话与设置必须能迁移。
3. 1.0.x 维护期内，自有 runtime 不再开大投入（D3 / D4 等已暂停，改由 DSH jobs 提供）。

## 文件地图

- [roadmap.md](roadmap.md)：分期与任务，任务身份、状态、顺序的唯一权威。
- [decisions/](decisions/)：[001 B 路线与六点拍板](decisions/001-route-b-and-scope.md)。
- [open-questions.md](open-questions.md)：P0 实测后才能定的问题。
- 调研与依据：[DSH 二开可行性调研](../../../plans/2026-09-24-dsh-rebase-feasibility-study.md)（生态、许可、功能落点、方案对比、goal 对照、差距表）。

## 权威顺序

架构冲突以 [ARD](../../../plans/2026-09-08-runtime-evolution-ard.md) 为准，直到 P2 默认切换时回写 ARD；本计划的取舍以本目录决策为准；调研档是事实来源，DSH 处于 developer preview，引用前按调研档的取证方法重核。
