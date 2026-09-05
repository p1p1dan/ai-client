# Plan — pix/pi-app UI 对齐改造

> **状态**：In Progress（收尾）—— **批次 1–9 全部落地**（最后一批：U17–U20，三件用户报障 + 权限档欠项清理）。
> 剩余工作只有一次累计 GUI 点验，加上 Deferred 的 U10/U11。U06-b 已于 2026-09-05 随 Pi 计划 T38 同批落地，外部阻塞清零。
>
> **前置已满足**：[Pi-only 收敛计划](../pi-backend-migration/README.md) 的 T37 发版门禁已于 2026-09-03 收口
> （manual CI run `33714362901` 全绿），[D01](./decisions/001-style-depth-and-sequencing.md) 决定二的排期闸门解除。
>
> **当前状态与欠项**：[implementation-status.md](./implementation-status.md)。
> **执行形态**：[execution-plan](./topics/execution-plan.md) —— 批次顺序、逐片验收标准与门禁。
>
> **未决：无。** Q01–Q13 全部关闭。Q08/Q10 见 [D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md)；
> Q09 由取证关闭；Q11 布局尺寸维持现值；Q12 请求优先级不做（U08-3 已 Dropped）；
> Q13 免绑定会话跨重启可见性见 [D04](./decisions/004-unbound-session-index-visibility.md)（U13 已于 2026-09-04 落地）。
>
> **2026-09-04 追加决策**：
> [D05](./decisions/005-two-column-run-surface.md) —— 双栏 rail 由「只有 Context」扩到「Context + Run」，
> 细化 D02 决定一（那条线划的是「对话 vs 开发工具」，排除集合一件没变）；
> [D06](./decisions/006-plugin-inventory-source.md) —— 插件清单由 worker 上报「实际加载了什么」，
> 不在 Main 重实现 pi 的解析。

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
| [open-questions.md](./open-questions.md) | 未解决问题（不是任务）；**Q01–Q13 全部关闭**，保留结论与证据链接 |
| [topics/current-state-audit.md](./topics/current-state-audit.md) | 开工前实况核查：已有能力 vs 真实缺口，带 `file:line` 证据 |
| [topics/evidence-q02-q03.md](./topics/evidence-q02-q03.md) | Q02 模型分组键 / Q03 pix Resources 取证结论 |
| [topics/evidence-q04-runtime-fields.md](./topics/evidence-q04-runtime-fields.md) | Q04 Run 面板字段可用性：占用/usage 需 Pi runtime 补 |
| [topics/evidence-q06-migration.md](./topics/evidence-q06-migration.md) | Q06 思考强度迁移：复制 pix 纯 mapper + read 时映射 |
| [topics/evidence-u01-numeric-scale.md](./topics/evidence-u01-numeric-scale.md) | U01 数值档：可搬字号/行高/圆角/间距；灰阶不可照搬 Flexoki |
| [topics/evidence-u09-component-forms.md](./topics/evidence-u09-component-forms.md) | U09 组件对照表：6 件逐项「搬/不搬/改造后搬」，唯一值得改 #1 Composer 空态摘列 |
| [topics/evidence-q09-service-tier.md](./topics/evidence-q09-service-tier.md) | Q09 service_tier 透传取证：通道存在但挂在模型静态默认值层，两条路径各有代价 |
| [evidence/2026-09-03-u01-style-baseline.md](./evidence/2026-09-03-u01-style-baseline.md) | U01 落地记录：改了什么、没改什么、对比度实测数字、门禁结果 |
| [evidence/2026-09-03-u09-composer-form.md](./evidence/2026-09-03-u09-composer-form.md) | U09 Composer 形态落地记录 |
| [evidence/2026-09-03-u12-tier-spawn-drift-fix.md](./evidence/2026-09-03-u12-tier-spawn-drift-fix.md) | U12 权限档「显示≠实际」缺陷修复 |
| [evidence/2026-09-03-u02-u03a-column-mode.md](./evidence/2026-09-03-u02-u03a-column-mode.md) | U02+U03-a 布局模式落地记录 |
| [evidence/2026-09-03-u05-u03b-unbound-chat.md](./evidence/2026-09-03-u05-u03b-unbound-chat.md) | U05+U03-b 免绑定开聊落地记录（含两处计划偏差与欠项） |
| [evidence/2026-09-03-u08-2-thinking-levels.md](./evidence/2026-09-03-u08-2-thinking-levels.md) | U08-2 思考档七档落地记录（含边界处三份五词拷贝与 `off` 的路径不对称） |
| [evidence/2026-09-04-u12-rev2-cross-directory-and-terminal-rail.md](./evidence/2026-09-04-u12-rev2-cross-directory-and-terminal-rail.md) | U12 rev.2：跨目录门让 full access 放行（hands-off 不动）+ 终端入口下线；含 `user_configured` 路线下档位失效的未修缺口 |
| [evidence/2026-09-04-host-status-false-stop-and-tui-history-bug.md](./evidence/2026-09-04-host-status-false-stop-and-tui-history-bug.md) | Host 状态误报「已停止」修复（空池 ≠ 停止）+ **TUI↔GUI 历史分叉**：成因、pix 参考实现、施工清单、落地记录与变异验证（已修，待真机回合验证）|
| [decisions/001-style-depth-and-sequencing.md](./decisions/001-style-depth-and-sequencing.md) | 风格深度与排期拍板 |
| [decisions/002-layout-cwd-and-evidence-scope.md](./decisions/002-layout-cwd-and-evidence-scope.md) | 双栏语义（**决定一已被 D07 推翻**）、免绑定 cwd 边界、取证范围与时机 |
| [decisions/003-sidebar-density-and-runtime-field-ownership.md](./decisions/003-sidebar-density-and-runtime-field-ownership.md) | 侧栏保留 28px、runtime 补字段挂 Pi 计划 T38、service_tier 取证启动 |
| [decisions/004-unbound-session-index-visibility.md](./decisions/004-unbound-session-index-visibility.md) | 免绑定会话跨重启可见性：索引行加 `unbound` 标记，侧栏合成临时分组（落为 U13） |
| [decisions/007-two-column-is-two-columns-and-one-bar-per-column.md](./decisions/007-two-column-is-two-columns-and-one-bar-per-column.md) | **D07**：~~双栏就是两栏~~（决定一/三已被 D08 推翻）；**每栏一条横条**（决定二仍有效） |
| [decisions/008-vscode-dock-shell.md](./decisions/008-vscode-dock-shell.md) | **D08**：VSCode 式壳层——左栏是图标轨道 + 面板的导航容器，右栏只做文件，中栏一个会话一个 Tab，删掉双栏/三栏与上下文面板开关（决定三「关 Tab 只是收起 Tab」已被 D09 修正） |
| [decisions/011-retire-the-live-output-token-counter.md](./decisions/011-retire-the-live-output-token-counter.md) | **D11**：整条删除 D33 的实时 `↓` 输出 token 计数器——pi 只在 `turn_end` 报 usage，「实时」在 pi 后端下没有数据源，凑出来只能字符除以 4 |
| [decisions/010-user-configured-gate-explicit-degradation.md](./decisions/010-user-configured-gate-explicit-degradation.md) | **D10**：`user_configured` 路线下权限档明示降级——把 `permissionGate` 送到渲染层，控件说明档位不生效；只说降级、不教修法 |
| [decisions/009-tab-close-ends-conversation.md](./decisions/009-tab-close-ends-conversation.md) | **D09**：关中栏 Tab 就是结束对话——确认框 + 断开该会话的运行时，左栏那一行保留（与左栏 Close、Archive 是三个轻重不同的「关闭」） |
| [evidence/2026-09-04-u14-shell-chrome-realignment.md](./evidence/2026-09-04-u14-shell-chrome-realignment.md) | U14 壳层横条重排落地记录（含「为什么没对齐」的三层答案与四条变异验证）|
| [evidence/2026-09-05-retire-live-token-counter.md](./evidence/2026-09-05-retire-live-token-counter.md) | U21 下线实时 `↓` 计数器（[D11](./decisions/011-retire-the-live-output-token-counter.md)）：pi 事件里没有回合中的 usage、删了什么、哪三处刻意保留、加了什么反向守卫 |
| `docs/design/a11-vscode-shell-prototype.html` | **当前壳层的施工基准**（[D08](./decisions/008-vscode-dock-shell.md)，2026-09-05 用户拍板）：图标轨道 + 面板、会话 Tab、右栏只做文件、上下文页构成图。带原型控制条，可切换左栏形态与右栏三态 |
| `docs/design/a10-pix-ui-alignment-prototype.html` | 上一版原型（三栏/双栏/TUI × Run/Context；截图在 `refs/a10-shots/`）。壳层部分**已被 a11 取代**；Composer 底栏顺序等非壳层部分仍可参考 |

## 阅读顺序

1. 本文件。
2. [current-state-audit](./topics/current-state-audit.md) —— 先看清哪些「需求」其实已经有了。
3. [D01](./decisions/001-style-depth-and-sequencing.md) → [D02](./decisions/002-layout-cwd-and-evidence-scope.md)
   → [D03](./decisions/003-sidebar-density-and-runtime-field-ownership.md) → [D04](./decisions/004-unbound-session-index-visibility.md)。
4. [roadmap](./roadmap.md) —— 任务身份与状态。
5. [execution-plan](./topics/execution-plan.md) —— 要动手就读这份。
6. [open-questions](./open-questions.md) —— 已全部关闭，作为结论索引查阅。
