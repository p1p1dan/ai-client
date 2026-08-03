# Plantree — 规划树入口（本仓唯一规划入口）

> 建立：2026-07-24（双轨合一后规整）。规划工作流遵循 plan-tree 规范：
> **当前活动状态**只看本树；历史证据与已拍板决策看台账档案（链接见下）。

## 阅读顺序（resume 时）

1. 本文件（注册表）
2. [`baseline/`](./baseline/README.md)（项目全局事实：模块图 / 运行时流 / 存储 / 门禁 / 风险）
3. 目标计划的 `README.md` → `implementation-status.md` → `roadmap.md`
4. 需要时再进 `open-questions.md` 与台账档案

## 活动计划注册表

| Plan | Status | Current Phase | Last Landed | Next Target |
|---|---|---|---|---|
| [openchamber-chat-refactor](./plans/openchamber-chat-refactor/README.md) | In Progress | **Phase 0A 基线部分补做（A01/A05/A06；整体仍 🟡，A02/A03/A04 未立项）→ 观感对齐改造**（2026-07-28 转向） | 文档：2026-07-28 A01 / A05 / A06 基线补登交付（产物 [`docs/design/phase0a-openchamber-alignment.html`](../design/phase0a-openchamber-alignment.html)，用户已验收）+ D18 / D19 / D20 落库；代码：2026-07-28 GUI 首测暴露链五连修 `eea2f25` `0bd70d5` `da9a5da` `9331d51` `576f3bd`（51 文件 590 例，Linux 三绿口径）；**2026-07-29** 「不出窗口」故障闭环 `d68d3c6` + dev 态凭证隔离 `b18ccac` + T-21 Flexoki 主题 `b38017b` + **缓存全量重写双根因闭环** `3622c19`（主因网关无亲和 open-q #15）+ **侧栏两层化/Composer 目标栏合并设计落库**（[设计文档](../plans/2026-07-29-sidebar-composer-target-bar-design.md)，T-24 账实不符已更正） + **T-26 侧栏两层化落地 `dd23b01`**（flat+全量分支 chip+Recent 段；对抗复核 blocker「sync 桥签名缺 branch 致冷启动 chip 全灭」已修；GUI 点验待用户） + **T-22 壳结构改造落地 `95a5c04`**（三列 + 44px 导轨 + surface 注册表，删 BottomDock/RightDock，纯函数 +79 例；Codex 对抗复核采纳 5 项已修、驳回 4 项有据；GUI 点验待用户） + **T-27 Composer 目标栏落地 `e8fb36a`**（文件夹/分支双下拉 + 运行位置指示器，D22；Codex 复核 8 项全采纳已修；GUI 点验待用户） + **T-28 中列状态化布局落地 `4c1e4d7`**（空态居中 Composer / 会话态 40px follow-up 沉底，D23；Codex 复核 blocker 卡高 42→40 已修；GUI 点验待用户）；**2026-07-30** **T-05 工具行/问答卡重做落地 `340a59a`**（Cursor 动词灰阶单行 + 问答卡四态，D24；Codex 复核 8 项全采纳已修；GUI 点验待用户 + **T-19 消息队列落地 `1b350ff`**（运行中解禁输入 + FIFO 排队；三批施工 + 对抗复核（Codex 两次容量满载改派 deep-reasoner）1 blocker/6 major/17 minor 全处理；GUI 点验待用户） + **T-30 批1 观感快赢落地 `3dcd2dc`**（12 项快赢中 10 项落地，D25/D26 快赢部分；P-19/P-22 让给 T-23） + **第二轮 GUI 点验反馈闭环 `b159e4a`**（51 文件 +4721/-184；授权卡不渲染/排队消息丢失/模型直通/附件回显四项根治 + 网络重试可见性五项 + 视觉六项；Codex+Opus 双轨独立对抗复核，三轮修复迭代全 pass；测试 1148→1240），见[主线台账](../plans/ledger-claude-mainline.md) 07-29/07-30 各行 + **第三轮 GUI 点验 1-5 全过、6（失败路径）顺延，快赢批落地 `514560c`**（下拉分域/首句凝练标题/居中残留修正；测试 1240→1290；Codex 对抗复核六条 NEEDS-FIX 全闭环）+ **T-30 批2 双规格齐备**（D25 分域字体规格抢救复原入库 [`docs/plans/2026-07-30-d25-font-domain-design.md`](../plans/2026-07-30-d25-font-domain-design.md) + composer 形态对齐 Cursor 规格 [`docs/plans/2026-07-31-t30b2-composer-form-design.md`](../plans/2026-07-31-t30b2-composer-form-design.md)，待用户三拍板后开工），见主线台账 2026-07-30 各行 + **2026-07-31 第四轮 GUI 点验结果 + 重试双发根治落地 `cb2d8d7`**（14 文件 +1178/−119，测试 1290→1345；Opus+Codex 双轨独立诊断同判核心根因，采 Opus 渲染层 `sawUserEcho` 幂等权威，红线零改动；T-30 批2 三拍板全落定，open-q #25 结项） + **T-30 批2 施工依据补齐**（[`2026-07-31-t30b2-composer-form-addendum-round4.md`](../plans/2026-07-31-t30b2-composer-form-addendum-round4.md)，量级 5.6~6.1d） + **T-31 立项建议**（回复解剖 + 置顶气泡设计 [`2026-07-31-reply-anatomy-design.md`](../plans/2026-07-31-reply-anatomy-design.md)，≈3.6d，排 T-30 批2 后、T-29 前），见主线台账 2026-07-31 各行；**2026-08-03** **T-30 批2 落地 `9e2736b`**（70 文件 +4202/−603，测试 1345→1415：D25 分域字体全量——分域两栈/argKind/域映射清零/45rem + Composer 形态三拍板——合并 `Sonnet High ⌄`/42px 静息半高 pill/24px 近黑圆钮/⊕ 文件引用；cn 吞类根治；Opus+Codex 双轨对抗复核 2+4 major 全闭环；A07 v4 追记一~十一节 + a09 凭证页；GUI 点验待用户），见主线台账 2026-08-03 行 | **T-24 收尾**（代码已随 `b38017b` 落库，剩 GUI 实测+补登）→ **T-12/T-13/T-14/T-15** 四 surface（均依赖 T-22 已清）→ **T-23** 存量违规清理；**A07 已定稿(2026-07-29 用户验收,v3)**，T-27/T-28/T-19/T-30批1 第二轮 GUI 点验九条反馈已修复落库 `b159e4a`（授权卡不渲染/排队消息丢失/模型直通/附件回显四项根治 + 网络重试可见性 + 视觉六项；Codex+Opus 双轨对抗复核三轮迭代全 pass），第三轮 GUI 点验 1-5 全过、6（失败路径）顺延补测；**T-30 批2 已落地 `9e2736b`（2026-08-03），待第五轮 GUI 点验（清单 0-nonies）**（open-q **#25** 已结项：①合并一体式 `Sonnet High ⌄`／②follow-up 卡满圆 pill／③圆钮 24px+发送键近黑）；**T-31 立项建议**（回复解剖 + 置顶气泡设计，≈3.6d，排 T-30 批2 后、T-29 前）；**第四轮 GUI 点验 2/3 过，1 新缺陷（重试双发/报错占用输入框）已根治 `cb2d8d7`，待第五轮复验**；GUI 点测（含多轮上下文）与 T-04 网关阻塞、#15 缓存复测裁定并行。**D21~D23 已拍板落总台账（2026-07-29），Cursor 参照截图入库 `docs/design/refs/cursor-20260729/`** |

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
