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
| [openchamber-chat-refactor](./plans/openchamber-chat-refactor/README.md) | In Progress | **开发线全部收口 → 真机点验期**（2026-08-06 第十二轮点验后；观感对齐批次任务 T-29 / T-12~T-15 / T-23 / T-32 / T-16 / T-33 / T-35 / T-34 全部 Done）。Phase 0A 整体仍 🟡（A02/A03/A04 未立项） | **2026-08-10 现场七问题修复批 `d759023` + 版本抬 `0.4.0-test.3`（`aa3ab33`）**，四门全绿 2990 例 0 红（白屏首帧 / 授权卡收敛工具行 / Stop 全链路 / Temp 可删 / 拖拽加固 / 历史附件回放 / git 判据纠偏；工作区归属权威 A/B 待拍板 open-q #28）。逐批明细见 [implementation-status](./plans/openchamber-chat-refactor/implementation-status.md) / [roadmap Done](./plans/openchamber-chat-refactor/roadmap.md) / [主线台账](../plans/ledger-claude-mainline.md)；2026-08-05 前活动状态原文见 [history 归档](./plans/openchamber-chat-refactor/history/) | ① **T-10/T-11 真机点验（当前主项）**：Windows 出包（[T-10 清单 M1~M4](../plans/t10-packaged-gui-checklist.md)）→ 测试机回归（[加密机测试方案](../plans/2026-08-06-encrypted-machine-test-plan.md)步骤 4b）→ 加密机现场 → CP2/CP5；② 开发线下一步待用户裁定（候选四路见 implementation-status Next Target）；并行残留：T-04 网关阻塞 · open-q #15/#22/#23 · T-21 截图 |
| [multi-agent](./plans/multi-agent/README.md) | In Progress | **S3 施工中——切片 0/1/2a/2c/3 已落地，下一件切片 4 权限投影**（2026-08-10 提问桥收口） | **2026-08-10 S3 切片 3 提问桥 `4b468f4`**（`codexQuestionBridge.ts` + `pending.forget()` 前置修复 + 渲染端 id 键与 `isSecret` 掩码；四门全绿 **vitest 146 文件 2914 例 0 红**）。动工前双轨对抗评审**在写代码之前推翻规格三处**，并抓出「设计档数字 ≠ 仓里证据」（夹具只有 2 条入向报文 / 5 颗问题，非 S2 写的 4 条 / 10 颗）。此前：切片 2c `8b0277f` · 2a `84ae4e1` · 0/1 `0314216`。逐批明细见 [roadmap](./plans/multi-agent/roadmap.md)；长叙事原文见 [history 归档](./plans/multi-agent/history/) | **切片 4 权限投影**：`decisions.ts`（4 id × 3 方言，未知 id 一律 deny）+ `approvalCorrelator.ts`（itemId→diff，**绝不因等 diff 延迟回复**）+ 卡层渲染。切片 3 已把 `forget()` / `defaultReplyFor()` 做成通用件可直接吃；审批侧「无回合守卫」有意留给切片 4 决定。细节见 [S2 设计档 §3](../plans/2026-08-06-s2-codex-integration-design.md) 与 [切片 3 规格 §5 遗留表](../plans/2026-08-10-s3-slice3-question-bridge-spec.md)。未决：#4 git 参照点 · #5 模型目录半边 · #7 capabilities · #8 idle sweep · **L1 提问坞单槽（agent 无关，另立）** |

## 遗留规划根（保留原位，不迁移不删除）

| 位置 | 角色 | 说明 |
|---|---|---|
| `docs/plans/2026-07-23-openchamber-chat-refactor-ard.md` | **架构权威** | 目标结构、决策立论；改架构先改它 |
| `docs/plans/2026-07-23-openchamber-chat-refactor-execution-plan.md` | 任务定义 | C-xx/T-xx 验收标准、协作规则、**测试凭证约定（§4）** |
| `docs/plans/openchamber-chat-refactor-ledger.md` | 决策 + 里程碑档案 | 已拍板决策 **D1~D27（含历史空号 D4/D5/D7/D13，以总台账决策表为准）**、检查点（CP-x）、Phase 总览；append-only |
| `docs/plans/ledger-claude-mainline.md` | 过程记录档案 | C-xx/T-xx 逐任务证据与提交 hash；append-only |
| `docs/plans/ledger-team-track.md` | 过程记录档案 | T-xx 早期证据；2026-07-24 起轨道移交主线 |
| `docs/plans/`（其余 2025/2026 早期文档） | 历史计划 | ai-sdk-migration / quick-terminal / status-line 等，与本计划无关 |

**权威顺序**：ARD ＞ 执行计划（任务定义）＞ 总台账（决策/检查点）＞ 本树（当前状态）。
冲突时依此序裁定；状态类信息以本树为准，本树不复制决策原文只链接。

**右栏骨架基线（D27 后现行）**：[`docs/design/a08-final-context-panel-baseline.html`](../design/a08-final-context-panel-baseline.html) —— 内容层三项豁免维持现状（terminal 不回 BottomDock · context 只放真实字段 · git 最小集），差异清单见 [T-12~15 规格 §7](../plans/2026-08-04-t12-15-surface-spec.md)。
**观感对齐基线**：[`docs/design/phase0a-openchamber-alignment.html`](../design/phase0a-openchamber-alignment.html) —— A01/A05/A06 统一产物（用户已验收）。视觉 token、三列 + 导轨骨架、工具行与问答卡形态的唯一基线，业务组件不得自行发明视觉值。
**GUI 启动口径（2026-07-29 变更）**：填好仓库根 `dev.env`（模板 `dev.env.example`）后一律 `node scripts/dev.js`，**勿用 `pnpm dev`**。详见 [baseline 门禁「GUI 联调环境」](./baseline/test-and-release-gates.md)。
**故障档案**：[`BUG-2026-07-29-no-window.md`](../design/BUG-2026-07-29-no-window.md)（「不出窗口」根因与方法论备忘）· [`BUG-2026-07-29-prompt-cache-rewrite.md`](../design/BUG-2026-07-29-prompt-cache-rewrite.md)（缓存全量重写，open-q #15）。
**参考版本已冻结**：全部 openchamber `file:line` 证据以 commit `a3519141` 为准（见 ARD §7）。

## 惯例

- 完成一个任务：先记台账档案（证据 + hash），再刷新 plan 的 `implementation-status.md` / `roadmap.md`。
- 里程碑（M1~M5）/ 确认点（CP-x）结果仍回填总台账检查点表。
- 低承诺想法进 [`ideas/inbox.md`](./ideas/inbox.md)，成熟后 promote 到 roadmap / open-questions。
- **归档纪律（2026-08-08 起）**：结项批次的逐批长摘要与点验清单原文移入各 plan `history/`（整文件快照式），活动文件只留一行摘要 + hash + 链接；注册表行不超过一段短叙事。
