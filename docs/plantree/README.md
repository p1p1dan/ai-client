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
| [openchamber-chat-refactor](./plans/openchamber-chat-refactor/README.md) | In Progress | **Phase 0A 基线部分补做（A01/A05/A06；整体仍 🟡，A02/A03/A04 未立项）→ 观感对齐改造**（2026-07-28 转向） | **2026-08-04 T-29 Markdown 渲染代码结项 `d320206`+`666c7c3`+`4507df3`**（前两 hash 曾漏记补登；双轨对抗复核闭环 27 findings / 3 证伪；三绿 1901 例 + 产物白名单验证；**待用户 GUI 点验 0-duodecies**）。**2026-08-03 第八轮 GUI 点验验收通过（「点验完毕，没啥问题」）——T-31 回复解剖 + 置顶气泡 `8109d45` 结项，T-22 / T-05 旧清单随轮收口，观感对齐批次二~八轮点验链全部闭环，GUI 点验债清零**（唯 0-nonies ⑪ 真机指标未采集）。同日更早批次：T-30 批2 `9e2736b` / 第五轮修复 `6ece6cb` / 第六轮修复 `fd55a26` / 第七轮验收。**2026-07-28 ~ 08-03 全部批次的逐条脉络见 [roadmap Done](./plans/openchamber-chat-refactor/roadmap.md) 与[主线台账](../plans/ledger-claude-mainline.md)；本行原有的逐批长摘要已随第八轮归档指针化（原文存 git 历史与 [history 归档](./plans/openchamber-chat-refactor/history/2026-0728-0803-archive.md)）** | 开发线 **T-29 Markdown 渲染（🟡 代码已结项 `d320206`+`666c7c3`+`4507df3`，2026-08-04 双轨复核闭环 + 三绿 1901 例；待用户 GUI 点验 0-duodecies + 拍板两项〔脚注 13px / 标题三档〕后转 Done，见主线台账 2026-08-04 T-29 行）** → **T-24 收尾**（S0 全新机器实测 + 补登）→ **T-12/T-13/T-14/T-15** 四 surface → **T-23** 存量违规清理；残留：0-nonies ⑪ 真机指标（Win10 必测字重）、open-q #22/#23、**T-04 网关阻塞**与 **#15 缓存复测裁定**并行；backlog：历史侧回合时长源 / `ran N command(s)` 聚合复议（需 A07 基线修订） |

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

**观感对齐基线（2026-07-28 新增）**：[`docs/design/phase0a-openchamber-alignment.html`](../design/phase0a-openchamber-alignment.html) —— A01 / A05 / A06 的统一产物（用户已验收）。视觉 token、三列 + 导轨骨架、工具行与问答卡形态的唯一基线，业务组件不得自行发明视觉值。
**GUI 启动口径（2026-07-29 变更）**：填好仓库根 `dev.env`（模板 `dev.env.example`）后一律 `node scripts/dev.js`，**勿用 `pnpm dev`**。凭证由 dev.js 启动期注入并剥离本机 `ANTHROPIC_*`，缺文件拒绝启动。详见 [baseline 门禁「GUI 联调环境」](./baseline/test-and-release-gates.md)。
**故障档案**：[`docs/design/BUG-2026-07-29-no-window.md`](../design/BUG-2026-07-29-no-window.md) —— 「不出窗口」的根因、修法与**原诊断错在哪**（`/proc/*/fd` 判断 socket 的方法论备忘）。
**参考版本已冻结**：全部 openchamber `file:line` 证据以 commit `a3519141`（`v1.17.0-6-ga3519141`，取证 2026-07-28）为准，跨版本核对前先 `git checkout a3519141`（见 ARD §7「参考版本冻结」）。

## 惯例

- 完成一个任务：先记台账档案（证据 + hash），再刷新 plan 的 `implementation-status.md` / `roadmap.md`。
- 里程碑（M1~M5）/ 确认点（CP-x）结果仍回填总台账检查点表。
- 低承诺想法进 [`ideas/inbox.md`](./ideas/inbox.md)，成熟后 promote 到 roadmap / open-questions。
