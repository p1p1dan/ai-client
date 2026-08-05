# Plantree — 规划树入口（本仓唯一规划入口）

> 建立：2026-07-24（双轨合一后规整）。规划工作流遵循 plan-tree 规范：
> **当前活动状态**只看本树；历史证据与已拍板决策看台账档案（链接见下）。

> **可视化入口**：[`dashboard.html`](./dashboard.html) — Phase、关键线路、任务看板、人工点验、阻塞与未决问题的单页聚合视图。Dashboard 是导航快照，状态权威仍是本树 Markdown。

## 阅读顺序（resume 时）

1. 本文件（注册表）
2. [`baseline/`](./baseline/README.md)（项目全局事实：模块图 / 运行时流 / 存储 / 门禁 / 风险）
3. 目标计划的 `README.md` → `implementation-status.md` → `roadmap.md`
4. 需要时再进 `open-questions.md` 与台账档案

## 活动计划注册表

| Plan | Status | Current Phase | Last Landed | Next Target |
|---|---|---|---|---|
| [openchamber-chat-refactor](./plans/openchamber-chat-refactor/README.md) | In Progress | **Phase 0A 基线部分补做（A01/A05/A06；整体仍 🟡，A02/A03/A04 未立项）→ 观感对齐改造**（2026-07-28 转向） | **2026-08-05（最新）T-32 右栏骨架回归 A08 五切片 `fbb45fe`+`8df9341`+`4f4fb52`+`2f46fa6`**——editor 回中列（`chat ║ editor` + 比例拖拽，右栏 files tab 降纯树）· tab 条四项 · Rail 仅收起时渲染 · 顶栏贯通 · L0/L1/L2 降级梯与手动覆盖；A08 §7 逐条回标（回归 7 / 豁免 4）；三处有据偏离（内容行阈值 1300/964 · 不加 `panelOpen` 字段 · editor 保留多 tab）；R1 静态不变量钉死可见性单一合成点。三绿 768 文件 / 121 文件 2220 例。**同日更早 context surface 打开即崩修复 `42b692c`**——zustand v5 selector 引用不稳定致 `forceStoreRerender` 自激（`?? []` 每次新建），修为稳定切片 + 模块级 `EMPTY_MESSAGES`，并补 `storeSelectorStability` 静态不变量扫全 renderer selector；三绿 763 文件 / 119 文件 2182 例。**同日 D27 拍板**（右栏骨架回归 A08，三项豁免维持现状）→ 立项 T-32、新立 open-q #28。**2026-08-04 T-23 存量违规清理落地 `bfc087f`**——死按钮清零（Browser/Window/Menu/Help 删除）+ 72% 假环撤除 + 顶栏单行化（P-19/P-22，h-9 + 工作区 chip），双轨对抗复核 + Codex 终验闭环，三绿 118 文件 2180 例，**impl done 待 GUI 点验（0-quattuordecies）**，A06 矩阵已逐行结清。**同日更早 T-12~T-15 四 surface 八提交一次性落地 + A08 临时基线正式化**（S0 壳前置 → Opus+Codex 双轨设计合并 → 四路并发施工 → 双轨对抗复核 1 blocker+8 major+8 minor 全闭环，`f3183f1`..`45c3b63`；三绿 117 文件 2171 例）——**impl done 待 GUI 点验（0-tredecies）**，规格与 A08 对照表 `docs/plans/2026-08-04-t12-15-surface-spec.md`。**同日更早 T-24 收尾结项（S0）**——双链审计 CONFIRMED（HEAD `01be19c`）+ 用户 fresh-profile 模拟实测三条验收全过转 Done（**偏离：真机 Windows 项并入 T-10 清单第 8 项**）。**同日更早 T-29 Markdown 渲染结项（D26）**——`d320206`+`666c7c3`+`4507df3`+`b08f6ae` 四提交，双轨对抗复核闭环（27 findings / 3 证伪），**用户当日点验验收转 Done**（唯一缺陷内容不可选中当轮修复；拍板两项维持现状：脚注 13px / 标题三档）。**2026-08-03 第八轮 GUI 点验验收通过（「点验完毕，没啥问题」）——T-31 回复解剖 + 置顶气泡 `8109d45` 结项，T-22 / T-05 旧清单随轮收口，观感对齐批次二~八轮点验链全部闭环，GUI 点验债清零**（唯 0-nonies ⑪ 真机指标未采集）。同日更早批次：T-30 批2 `9e2736b` / 第五轮修复 `6ece6cb` / 第六轮修复 `fd55a26` / 第七轮验收。**2026-07-28 ~ 08-03 全部批次的逐条脉络见 [roadmap Done](./plans/openchamber-chat-refactor/roadmap.md) 与[主线台账](../plans/ledger-claude-mainline.md)；本行原有的逐批长摘要已随第八轮归档指针化（原文存 git 历史与 [history 归档](./plans/openchamber-chat-refactor/history/2026-0728-0803-archive.md)）** | **resume 两项优先项均已结清（2026-08-05）**：① 用户开题「决定软件走向的核心问题」= codeg 参照下的**多 agent 方向**，已另立 plan root [multi-agent](./plans/multi-agent/README.md)（并行推进）；② context surface 报错已定位修复 `42b692c`。**T-32 右栏骨架回归 A08 当日立项/裁定/施工完毕**（`fbb45fe`..`2f46fa6` 五切片）——editor 回中列 + tab 条四项 + Rail 联动收展 + 顶栏贯通 + 降级梯，**待 GUI 点验 0-quindecies**；**开发线下一项 = T-16**；**开发线现行顺序（用户 2026-08-05 裁定）= T-32 → T-16**（先定壳骨架再做开关，否则 T-32 落地后开关要重验）；原 T-16 行：新旧壳开关（前置均已具备；**T-23 已 2026-08-04 落地待 GUI 点验 0-quattuordecies；T-12~T-15 待 GUI 点验 0-tredecies + Ctrl+B 改绑追认**；T-24 真机 Windows 项并入 T-10 清单第 8 项）；残留：0-nonies ⑪ 真机指标（Win10 必测字重）、open-q #22/#23、**T-04 网关阻塞**与 **#15 缓存复测裁定**并行；backlog：历史侧回合时长源 / `ran N command(s)` 聚合复议（需 A07 基线修订） |
| [multi-agent](./plans/multi-agent/README.md) | **Planning · 暂缓** | **后置（用户 2026-08-05 同日改判：先把主线 Claude 客户端做到大致完成，再考虑 codex 支线）；S1 spike 不在当前排期** | **（无代码落地）** 2026-08-05 立项并补落 2026-08-04 会话的调研结论三篇 topic：[acp-decision](./plans/multi-agent/topics/acp-decision.md)（ACP 成本曲线：省的是解析器、从第 3 个 agent 起摊平；**Claude 线不走 ACP** 的证据链——`@agentclientprotocol/claude-agent-acp` 本质是我们 `src/agent-host` 的第三方版本，同一个 Claude Agent SDK）· [reuse-boundary](./plans/multi-agent/topics/reuse-boundary.md)（问答卡上层 agent 无关，**仅 `questionBridge.ts` 303 行 Claude 专属** = D2 红利）· [codeg-reference](./plans/multi-agent/topics/codeg-reference.md)（参照物在本机 `/home/dan/projects/codeg`；12 内置 agent 全经 ACP 适配器，pin `claude-agent-acp@0.64.1` / `codex-acp@1.1.9`） | **S1 spike**：`codex-acp` 能否拉起最小回合 · ACP 映射 vs 直连解析**两条路都要估** · Codex 提问形状（校正 reuse-boundary 初判表）· 模型目录 · 权限语义。出口 = 结 open-q **#1**（判据：三个月内加不加第 3 个 agent）→ 才谈并入主线。**当前不排期**，结论已落库随时可接续。**并行第二批（与 ACP 无关，可平移主线）**：重试横幅（数据已在 `chatSessions.ts:85`）→ 子 agent 实况（开 `forwardSubagentText`，`sdk.d.ts:1619`）→ stderr 进 UI。**Deferred**：多 agent 协同（用户明示先放一放） |

## 遗留规划根（保留原位，不迁移不删除）

| 位置 | 角色 | 说明 |
|---|---|---|
| `docs/plans/2026-07-23-openchamber-chat-refactor-ard.md` | **架构权威** | 目标结构、决策立论；改架构先改它 |
| `docs/plans/2026-07-23-openchamber-chat-refactor-execution-plan.md` | 任务定义 | C-xx/T-xx 验收标准、协作规则、**测试凭证约定（§4）** |
| `docs/plans/openchamber-chat-refactor-ledger.md` | 决策 + 里程碑档案 | 已拍板决策 **D1~D20（含历史空号 D4/D5/D7/D13，实为 16 行，以总台账决策表为准）**（2026-07-28 新增 D18/D19/D20，其中 D18 撤销 D6、D19 撤销 D15）、检查点（CP-x）、Phase 总览；append-only |
| `docs/plans/ledger-claude-mainline.md` | 过程记录档案 | C-xx 逐任务证据与提交 hash；append-only |
| `docs/plans/ledger-team-track.md` | 过程记录档案 | T-xx 逐任务证据；2026-07-24 起轨道移交主线 |
| `docs/plans/`（其余 2025/2026 早期文档） | 历史计划 | ai-sdk-migration / quick-terminal / status-line 等，与本计划无关 |

**权威顺序**：ARD ＞ 执行计划（任务定义）＞ 总台账（决策/检查点）＞ 本树（当前状态）。
冲突时依此序裁定；状态类信息以本树为准，本树不复制决策原文只链接。

**右栏骨架基线（2026-08-05 D27 后现行）**：[`docs/design/a08-final-context-panel-baseline.html`](../design/a08-final-context-panel-baseline.html) —— D27 拍板回归 A08 骨架，该原件**地位回升为右栏骨架基线**（不再是 T-12~T-15 规格 §7 所称的「历史证据」）；**但内容层三项豁免维持现状**（terminal 维持 surface 不回 BottomDock · context 只放真实字段 · git 维持最小集），差异清单见[T-12~T-15 规格 §7](../plans/2026-08-04-t12-15-surface-spec.md)。落地任务 **T-32**（3d 级；open-q #28 已于 2026-08-05 裁定关闭——**editor 回中列**、右栏 tab 扩四项、Rail 仅收起时渲染）。
**观感对齐基线（2026-07-28 新增）**：[`docs/design/phase0a-openchamber-alignment.html`](../design/phase0a-openchamber-alignment.html) —— A01 / A05 / A06 的统一产物（用户已验收）。视觉 token、三列 + 导轨骨架、工具行与问答卡形态的唯一基线，业务组件不得自行发明视觉值。
**GUI 启动口径（2026-07-29 变更）**：填好仓库根 `dev.env`（模板 `dev.env.example`）后一律 `node scripts/dev.js`，**勿用 `pnpm dev`**。凭证由 dev.js 启动期注入并剥离本机 `ANTHROPIC_*`，缺文件拒绝启动。详见 [baseline 门禁「GUI 联调环境」](./baseline/test-and-release-gates.md)。
**故障档案**：[`docs/design/BUG-2026-07-29-no-window.md`](../design/BUG-2026-07-29-no-window.md) —— 「不出窗口」的根因、修法与**原诊断错在哪**（`/proc/*/fd` 判断 socket 的方法论备忘）。
**参考版本已冻结**：全部 openchamber `file:line` 证据以 commit `a3519141`（`v1.17.0-6-ga3519141`，取证 2026-07-28）为准，跨版本核对前先 `git checkout a3519141`（见 ARD §7「参考版本冻结」）。

## 惯例

- 完成一个任务：先记台账档案（证据 + hash），再刷新 plan 的 `implementation-status.md` / `roadmap.md`。
- 里程碑（M1~M5）/ 确认点（CP-x）结果仍回填总台账检查点表。
- 低承诺想法进 [`ideas/inbox.md`](./ideas/inbox.md)，成熟后 promote 到 roadmap / open-questions。
