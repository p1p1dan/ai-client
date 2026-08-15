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
| [openchamber-chat-refactor](./plans/openchamber-chat-refactor/README.md) | In Progress | **Phase 0 正式 Go + 0A 收口 → 意外发现小批已落地（`5dab201`）→ multi-agent 切片 5 主攻** | **2026-08-15 意外发现小批四件全修 `5dab201`**（button 嵌套 render prop / runtimeEvent 引用计数总线 / 六处延迟卸载 / dark: `@custom-variant`；vitest 3357 + 变异 7/7 + CDP 复验四查全过）；同日早前 **加密机现场 T-11 六项全过 → CP5，Phase 0 转正式 Go**（含 ⑥ TSD 白名单实证，open-q #7 关闭）；同日拍板批：开发线主攻 multi-agent 切片 5 · 三条意外发现即修小批 · **D36** Linux 包捆随包 node（转施工票）；此前同日 test.4 用户真机初验通过（安装版正常；portable 慢启动归档为已知限制）+ CI 出包跑通（run 31861599547，`0d4011c` 根治 Windows cpSync filter 失灵）；此前 2026-08-14 单日四批：流式 D32/D33（vitest 3268）→ D34 UI 反馈八提交（3329）→ D35 diff 四调（3339）。逐批明细见 [implementation-status](./plans/openchamber-chat-refactor/implementation-status.md) / [roadmap Done](./plans/openchamber-chat-refactor/roadmap.md) / [主线台账](../plans/ledger-claude-mainline.md)；2026-08-05 前活动状态原文见 [history 归档](./plans/openchamber-chat-refactor/history/) | ① **multi-agent S3 施工线已全落（切片 6 于 2026-08-15 收口）→ 下一件用户登录管理已立项 D47**（见该 plan 行）；② 用户线余量按用户节奏：CP2 = T-10 深度回归（现场操作单七项/全量 25 项/流式观感/D34-D35 逐项/包装器）+ GUI 点测批（T-03/06/07/18/20）+ T-21 目视；③ 拍板议程已全部出清（2026-08-15 四轮：D36~D44 + D31 建议序，见总台账检查点）；并行残留：T-04 网关阻塞 · open-q #15/#22/#23 |
| [multi-agent](./plans/multi-agent/README.md) | In Progress | **S3 施工线全落——切片 0/1/2a/2c/3/4/5/6 已落地（仅 2b 打包链既定后置），下一阶段 = 用户登录管理（D47，规格 rev.2 已拍板收口 → 施工）**（2026-08-15 切片 5+6 收口 + 同日立项/规格/拍板三连） | **2026-08-15 S3 切片 6 收口（规格 `e281435` + 施工 `81a130b`，off/on 双轮 vitest 3482 全绿）**——#7 HostAgentRegistry 全链 + #8 idle sweep 与回收后续聊（`session_revive_failed`）+ U8 三态截图判不挤 + G13 真机恢复 PASS；双轨双盲评审（Opus 4b+10M+5m / Codex 2b+4M+2m 合取）在写码前拦下 revive 失败码撞渲染端兜底、零回合无 rollout、registry 收敛断链三类返工，详见 [切片 6 spec](../plans/2026-08-15-s3-slice6-closure-spec.md) §9/§11。同日早前 **S3 切片 5 历史收口（5a `1aa68f2` + 5b `61bcd0d` + 收尾 `4d61730`/`ae3398e`，vitest 3418）**——U2-a 真实回合四推翻（id 判死 / 重投影丢 reasoning·exec / resume 从 config 重派生权限→H9 双层重申真机双臂实证）；规格 [切片 5 spec](../plans/2026-08-15-s3-slice5-history-spec.md) rev.2 双轨双盲合取 + as-built；P1 扇出砍 / P2 文案改（用户拍板）。此前 **2026-08-10 S3 切片 4 权限投影 `7f357c2`**（规格/夹具先行 `35b4594`/`1ae2abc`；四门全绿 **vitest 152 文件 3160 例 0 红**）——取证重生成契约在写规格前推翻 S2 三处、抓出 method-contract 快照一多一少两处错；双轨评审推翻 rev.1 十三处（含 `grantRoot` 会话级写权 blocker——被 rev.1 自己的夹具归约藏掉）；施工 16 处变异验证；复核 major（decision 发射链零覆盖）以三个接线 pin 收口；as-built 偏差见规格 §7。此前：**S3 切片 3 提问桥 `4b468f4`**（`codexQuestionBridge.ts` + `pending.forget()` 前置修复 + 渲染端 id 键与 `isSecret` 掩码；四门全绿 **vitest 146 文件 2914 例 0 红**）。动工前双轨对抗评审**在写代码之前推翻规格三处**，并抓出「设计档数字 ≠ 仓里证据」（夹具只有 2 条入向报文 / 5 颗问题，非 S2 写的 4 条 / 10 颗）。此前：切片 2c `8b0277f` · 2a `84ae4e1` · 0/1 `0314216`。逐批明细见 [roadmap](./plans/multi-agent/roadmap.md)；长叙事原文见 [history 归档](./plans/multi-agent/history/) | **用户登录管理施工（S0 五 spike → S1~S6）**（阶段 2，**D47**；[规格 rev.2](../plans/2026-08-15-login-management-design-spec.md) = 四路调查 + Opus/Codex 双盲双轨合取 + U1~U4 拍板收口；幂等假定经 onboard 服务源码 CONFIRMED，S7 删除）→ Codex CLI 选择功能（阶段 3，stage-3 picker 是 `capabilities.agents` 首个 UI 消费者）→ 2b 打包链（阶段 4，体积已拍板）。切片 5 遗留 L1~L7 中 G13 真机半边已随切片 6 了账；切片 6 新增 L8~L11 见[规格 §7](../plans/2026-08-15-s3-slice6-closure-spec.md)。未决：#4 git 参照点 · #5 模型目录半边 · **L1 提问坞单槽（agent 无关，另立）**（ACP 两裁定已升格 **D45/D46**，2026-08-15 拍板） |

## 遗留规划根（保留原位，不迁移不删除）

| 位置 | 角色 | 说明 |
|---|---|---|
| `docs/plans/2026-07-23-openchamber-chat-refactor-ard.md` | **架构权威** | 目标结构、决策立论；改架构先改它 |
| `docs/plans/2026-07-23-openchamber-chat-refactor-execution-plan.md` | 任务定义 | C-xx/T-xx 验收标准、协作规则、**测试凭证约定（§4）** |
| `docs/plans/openchamber-chat-refactor-ledger.md` | 决策 + 里程碑档案 | 已拍板决策 **D1~D29（含历史空号 D4/D5/D7/D13，以总台账决策表为准）**、检查点（CP-x）、Phase 总览；append-only |
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
