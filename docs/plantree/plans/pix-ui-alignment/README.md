# Plan — pix/pi-app UI 对齐改造

> **状态**：In Progress —— 批次 4 / U05+U03-b **已落地**（免绑定开聊 + TUI 解除目录强绑定），下一步批次 5（U08-2 思考档七档）
>
> **前置已满足**：[Pi-only 收敛计划](../pi-backend-migration/README.md) 的 T37 发版门禁已于 2026-09-03 收口
> （manual CI run `33714362901` 全绿），[D01](./decisions/001-style-depth-and-sequencing.md) 决定二的排期闸门解除。
>
> **当前状态与欠项**：[implementation-status.md](./implementation-status.md)。
> **执行形态**：[execution-plan](./topics/execution-plan.md) —— 批次顺序、逐片验收标准与门禁。
>
> **未决：无。** Q01–Q12 全部关闭。Q08/Q10 见 [D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md)；
> Q09 由取证关闭；Q11 布局尺寸维持现值；Q12 请求优先级不做（U08-3 已 Dropped）。

## 目标

把 ai-client 的界面向两个参考实现靠拢，同时保留本仓已有的产品能力：

- **pix** —— 视觉密度、布局形态、内容展示、输入框与小控件、输出渲染。用户原话是「功能齐全，同时保证利落简约」，风格基调为「类 Codex」。
- **pi-app** —— 右侧栏的 **Run**（运行态指标）与 **Context**（上下文预览）两块面板。

## 参考版本冻结

对照与取证以下面两个提交为准，避免参考仓漂移后结论失效：

| 参考仓 | 路径 | 冻结提交 | 日期 |
|---|---|---|---|
| pix | `~/code/pix` | `da01b3e`（v0.7.7） | 2026-08-28 |
| pi-app | `~/code/pi-app` | `c5ad2f4` | 2026-08-14 |

## 已拍板边界

来自 2026-09-02 用户拍板，完整理由见 [D01](./decisions/001-style-depth-and-sequencing.md)：

1. **样式层只对齐密度与字体**。字号档、行高、间距档、圆角档、中性灰阶向 pix 靠拢；**不**整套替换语义 token（`--color-primary` / `--color-accent` 这类变量名与主题机制保持不变），也**不**新增可切换皮肤。
2. **排期在 T37 之后**。先把 Pi-only 发版门禁（license notices、migration/release notes、CI packaged 触发）收口、打出可发布基线，再动大面积 UI。
3. **消息操作只要复制**。「回退」与「在新会话中继续」用户明确列为非最高优先级，进 Deferred。

## 2026-09-03 追加拍板（[D02](./decisions/002-layout-cwd-and-evidence-scope.md)）

1. **双栏模式 = 只做 AI 对话与 AI 开发**。Files / Git / Terminal 在双栏下刻意不提供，需用时切回三栏（解 Q05）。
2. **免绑定会话 cwd = 隔离临时目录，默认不信任**、逐次授权、写路径默认拒绝（解 Q01）。
3. **取证现在启动**：Q02 / Q03 / Q04 / Q06 由主会话列出清单、派 grok-4.6 子代理执行，结论写回。

## 与现有计划的关系

- 本计划只管**界面呈现与交互形态**；进程模型、WorkerManager、会话文件与 Pi runtime 语义仍归 [Pi-only 收敛计划](../pi-backend-migration/README.md)。
- 触到 Pi 侧数据契约的项（Run 面板要的运行态指标、思考强度词汇、请求优先级）需要 Pi runtime 补字段时，走 Pi 计划的 task，不在本计划里改 runtime。
- UI 规范文件 `docs/design-system.md` 是本计划的**产出物之一**：样式层改动落地后必须同步更新其 Token 分档，否则 CLAUDE.md 的强制规范会与实现脱节。

## 文件地图

| 文件 | 角色 |
|---|---|
| [roadmap.md](./roadmap.md) | 任务 ID、状态与顺序的唯一权威 |
| [topics/execution-plan.md](./topics/execution-plan.md) | **开工入口**：切片、批次顺序、逐片验收标准、门禁、风险、锚点复核 |
| [open-questions.md](./open-questions.md) | 未解决问题（不是任务）；Q01–Q07 已闭，**Q08–Q10 待拍板** |
| [topics/current-state-audit.md](./topics/current-state-audit.md) | 开工前实况核查：已有能力 vs 真实缺口，带 `file:line` 证据 |
| [topics/evidence-q02-q03.md](./topics/evidence-q02-q03.md) | Q02 模型分组键 / Q03 pix Resources 取证结论 |
| [topics/evidence-q04-runtime-fields.md](./topics/evidence-q04-runtime-fields.md) | Q04 Run 面板字段可用性：占用/usage 需 Pi runtime 补 |
| [topics/evidence-q06-migration.md](./topics/evidence-q06-migration.md) | Q06 思考强度迁移：复制 pix 纯 mapper + read 时映射 |
| [topics/evidence-u01-numeric-scale.md](./topics/evidence-u01-numeric-scale.md) | U01 数值档：可搬字号/行高/圆角/间距；灰阶不可照搬 Flexoki |
| [topics/evidence-u09-component-forms.md](./topics/evidence-u09-component-forms.md) | U09 组件对照表：6 件逐项「搬/不搬/改造后搬」，唯一值得改 #1 Composer 空态摘列 |
| [topics/evidence-q09-service-tier.md](./topics/evidence-q09-service-tier.md) | Q09 service_tier 透传取证：通道存在但挂在模型静态默认值层，两条路径各有代价 |
| [evidence/2026-09-03-u01-style-baseline.md](./evidence/2026-09-03-u01-style-baseline.md) | U01 落地记录：改了什么、没改什么、对比度实测数字、门禁结果 |
| [decisions/001-style-depth-and-sequencing.md](./decisions/001-style-depth-and-sequencing.md) | 风格深度与排期拍板 |
| [decisions/002-layout-cwd-and-evidence-scope.md](./decisions/002-layout-cwd-and-evidence-scope.md) | 双栏语义、免绑定 cwd 边界、取证范围与时机 |
| [decisions/003-sidebar-density-and-runtime-field-ownership.md](./decisions/003-sidebar-density-and-runtime-field-ownership.md) | 侧栏保留 28px、runtime 补字段挂 Pi 计划 T38、service_tier 取证启动 |
| `docs/design/a10-pix-ui-alignment-prototype.html` | 已拍板项的可视化原型（三栏/双栏/TUI × Run/Context；截图在 `refs/a10-shots/`）。原型画面，非施工依据 |

## 阅读顺序

1. 本文件。
2. [current-state-audit](./topics/current-state-audit.md) —— 先看清哪些「需求」其实已经有了。
3. [D01](./decisions/001-style-depth-and-sequencing.md) → [D02](./decisions/002-layout-cwd-and-evidence-scope.md)。
4. [roadmap](./roadmap.md) —— 任务身份与状态。
5. [execution-plan](./topics/execution-plan.md) —— 要动手就读这份。
6. [open-questions](./open-questions.md) —— Q08–Q10 待拍板。
