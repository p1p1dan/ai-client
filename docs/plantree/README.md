# Plantree — Project Planning Entry

> 本文件是仓库唯一活动规划入口，**只回答「现在还要做什么」**。
> 已关闭计划的完整叙事不留在这里——看该计划自己的 `implementation-status.md` / `roadmap.md` / `evidence/`。
>
> **历史快照**（均非活动状态来源）：
> [2026-09-07 精简前的根注册表](./history/2026-09-07-pre-cleanup-registry.md)（每条计划各带一大段落地叙事的版本）·
> [2026-08-31 Pi-only 重排前的长注册表](./history/2026-08-31-pre-pi-only-registry.md) ·
> [2026-08-06 旧 HTML dashboard](./history/dashboard-2026-08-06.html)。

## Current direction

ai-client 已收敛为 **Pi-only application**：

```text
Renderer → Preload → Electron Main WorkerManager
→ bounded WorkerSlot pool
→ one utilityProcess + one Pi AgentSession per slot
```

- Claude/Codex 不再作为可执行 conversation runtime。
- 原始 Claude/Codex 会话保持只读，通过原子、可去重的 import service 复制为 Pi session。
- pi-app 是 WorkerManager/WorkerSlot/history/tree 主参考；pix 是 Pi TUI/PTY/CLI packaging 主参考。

**runtime 侧没有活动施工任务**：Pi-only 收敛的 T28–T38 已于 2026-09-05 全部关闭，
正式发布走 [rollout/rollback runbook](../pi-only-rollout-rollback.md)。
当前三条活动计划里，两条在界面侧，第三条（现场反馈待办）另有 Pi provider header 与账户额度两块。

## Resume reading order

1. 本文件。
2. [Baseline](./baseline/README.md)：module/runtime/storage/risk/gates。
3. 活动计划 [pix/pi-app UI 对齐](./plans/pix-ui-alignment/README.md)
   → [implementation-status](./plans/pix-ui-alignment/implementation-status.md)
   → [roadmap](./plans/pix-ui-alignment/roadmap.md)。
4. 活动计划 [设置清单整理与旧壳删除](./plans/settings-cleanup/README.md)
   → [implementation-status](./plans/settings-cleanup/implementation-status.md)
   → [roadmap](./plans/settings-cleanup/roadmap.md)。
5. 活动计划 [现场反馈待办 6–11](./plans/field-followups/README.md)
   → [implementation-status](./plans/field-followups/implementation-status.md)
   → [roadmap](./plans/field-followups/roadmap.md)。
6. 需要架构边界时：[Pi-only plan](./plans/pi-backend-migration/README.md)
   → [decision index](./plans/pi-backend-migration/decisions/README.md)
   → [D14](./plans/pi-backend-migration/decisions/014-pi-only-product-and-conversation-import.md)
   / [D15](./plans/pi-backend-migration/decisions/015-main-owned-worker-manager.md)。
7. 只读当前任务直接链接的 topic/evidence/history。

## Authority order

1. 本 root registry：计划生命周期与唯一入口。
2. 活动计划的 `roadmap.md`：任务 ID、顺序、依赖和状态的唯一权威。
3. 活动计划的 `implementation-status.md`：当前 phase、Next、blocker、last verified。
4. Decision 索引与 Active decisions：稳定方向和边界（架构侧仍以 Pi 计划的 D14/D15/D16 为准）。
5. Baseline、active topics、evidence。
6. 已归档计划、`docs/plans/` legacy sources 和 history snapshots。

旧文档中的 active wording 在被标记为 Archived/Superseded 后不覆盖以上权威。

## Active plans

| Plan | Lifecycle | 现在在做什么 | 状态权威 |
|---|---|---|---|
| [pix/pi-app UI 对齐改造](./plans/pix-ui-alignment/README.md) | **In Progress（收尾）** | 批次 1–15（U01–U31）全部落地，**只剩一次累计 GUI 点验**；另有五笔欠账与六件待真机验证项，自动化全部已绿（280 files / 4246 tests） | [implementation-status](./plans/pix-ui-alignment/implementation-status.md) · [roadmap](./plans/pix-ui-alignment/roadmap.md) |
| [设置清单整理与旧壳删除](./plans/settings-cleanup/README.md) | **In Progress** | S01–S07 已实现；按本轮授权先保存补齐线提交，再完成旧壳删除和九类设置。renderer 分批回归与拆分类型检查通过，完整门禁、GUI/PTY 点验和主分支合入待完成 | [TODO](./plans/settings-cleanup/TODO.md) · [implementation-status](./plans/settings-cleanup/implementation-status.md) · [roadmap](./plans/settings-cleanup/roadmap.md) |

| [现场反馈待办 6–11](./plans/field-followups/README.md) | **In Progress** | 批次一（启动误报 `unverified`、`@` 弹层超框、流式 `↓` 字符数）、批次二（Pi User-Agent）与批次三（启动公告 + 铃铛 + 删除顶部「...」菜单）已实现且自动化全绿，GUI 点验、真实请求头与公告联调未验证；剩周限额金额 | [TODO](./plans/field-followups/TODO.md) · [implementation-status](./plans/field-followups/implementation-status.md) · [roadmap](./plans/field-followups/roadmap.md) |

活动计划三条。从归档表恢复任何一条计划都需要真实需求触发，并在本表重新登记。

## Archived plans

已关闭的计划**目录原地保留、不删除**（`./plans/<name>/`，既有外部链接继续有效），只是不再占用活动注册表。
每条的完整叙事与证据在它自己的 `implementation-status.md` / `roadmap.md` / `evidence/` 里。

| Plan | Lifecycle | 关闭时的结论 |
|---|---|---|
| [Pi-only application convergence](./plans/pi-backend-migration/README.md) | **Completed**（2026-09-05） | T28–T38 全部关闭：Pi-only runtime、Claude import、legacy execution absence、Pi TUI 与 Windows/Linux/macOS packaged gate 均有 accepted evidence。**仍是架构边界权威**（D14/D15/D16）。Codex import 等真实本地格式证据，不恢复 legacy execution runtime |
| [pi 资源接入与斜杠命令](./plans/pi-resources-and-commands/README.md) | **Completed**（2026-09-06） | R01–R04 全部关闭：托管模式借用用户 `~/.pi` 的技能与模板、斜杠命令补全与内置四条、两个插件随包、资源设置页。Q-R1–Q-R5 是需求触发的候选，不恢复为 roadmap |
| [模型配置页迁入 onboard](./plans/model-catalog-admin/README.md) | **Completed**（2026-09-05） | M01–M05 全部落地：SQLite 存储 + 鉴权拉取端点、`/admin` 管理页、客户端契约适配；硬编码模型兜底删除，空目录改为合法状态。**两仓分支均未推送、onboard 未部署**，GUI 点验并入累计点验 |
| [Entry and environment](./plans/entry-and-environment/README.md) | Maintenance（无活动任务） | two-entry welcome、spawn gate、git notice、settings ownership 均已完成；剩余的 credential rejection 分类与 welcome/git-notice GUI 复验是候选项，需要时另立小任务 |
| [Unified credentials/app state](./plans/unified-credentials/README.md) | Completed foundation（2026-08-28） | `~/.pilab/<profile>`、credential vault、credential mode、Pi arm 落地；Pi config/import/removal 已由 Pi 计划接管 |
| [OpenChamber product baseline](./plans/openchamber-chat-refactor/README.md) | Completed baseline | shell/timeline/Composer/files/git/terminal 等 runtime-neutral 产品资产的来源，属 retain/adapt，不随 Claude/Codex runtime 一起删除 |
| [Claude + Codex multi-agent](./plans/multi-agent/README.md) | **Superseded / Historical**（2026-08-31） | 被 Pi-only D14/D15 取代；ACP/Codex runtime、protocol、packaging 历史证据按需引用，**不恢复 execution roadmap** |

## Stable evidence and history

- Pi-only 收敛的逐任务证据（Cycle 1/2、T30–T38）：[evidence 目录](./plans/pi-backend-migration/evidence/)，
  索引与逐条状态见该计划的 [roadmap](./plans/pi-backend-migration/roadmap.md)。
- UI 对齐的逐片证据（U01–U31）：[evidence 目录](./plans/pix-ui-alignment/evidence/)，
  逐批叙事见 [landed log](./plans/pix-ui-alignment/history/2026-09-07-landed-log.md)。
- 重排前快照：[Pi 计划](./plans/pi-backend-migration/history/2026-08-31-pre-pi-only-realignment/) ·
  [baseline](./history/2026-08-31-pre-pi-only-baseline/) ·
  [根注册表](./history/2026-08-31-pre-pi-only-registry.md)。
- [Pi-only 重排映射](./indexes/pi-only-realignment-map.md)：哪一块从哪来、去了哪。

History/evidence 保留事实和推理，但不维护新的 Active TODO。

## Legacy planning roots

`docs/plans/` 保存旧 ARD、执行计划、台账、spike、GUI 清单和 incident records。它们不批量迁移或删除；需要时由当前 plan/evidence 精确链接。旧 OpenChamber/Claude/Codex authority 不能覆盖 Pi-only D14/D15 和当前 roadmap。

## Maintenance rules

- 一个事实只保留一个当前权威；不要在 status/topic/history 复制第二份任务状态。
- **根注册表每条计划最多一两句**：活动计划写「现在在做什么」，归档计划写「关闭时的结论」。
  逐批叙事归该计划的 `implementation-status.md`；超出当前一批的历史叙事归该计划的 `history/`。
- 计划关闭时，同一次提交里把它从 Active 表移到 Archived 表并改写它自己 README 的状态行；
  **目录原地保留**，避免打断已有的外部链接。
- `roadmap.md` 拥有活动 task ID/status/order；`implementation-status.md` 最多五项 Active TODO。
- 重大重排先更新 [realignment map](./indexes/pi-only-realignment-map.md)。
- 决策 append-only：被替代时保留原理由并从 [decision index](./plans/pi-backend-migration/decisions/README.md) 指向替代者。
- Evidence 记录实际命令、日期和环境；不能沿抄旧“全绿”数字。
- 旧计划优先降权/归档，不删除推理链；实现代码删除必须经过 T28 map。
- 低承诺想法进入 [ideas/inbox.md](./ideas/inbox.md)，成熟后再 promote。
