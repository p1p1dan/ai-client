# History Snapshot — 2026-09-07 精简前的根注册表

> 本文件是 `docs/plantree/README.md` 在 **2026-09-07 归档精简前**的完整原文快照。
>
> 精简的原因：根注册表的 `Last landed` 单元格已经长成整段叙事，八条计划里七条已经关闭，
> 但每条都还在根部占一整行长文，读入口变成了读全部历史。
> 这些叙事在各计划自己的 `implementation-status.md` / `roadmap.md` / `evidence/` 里都有权威副本，
> 根注册表里的那份是第二副本（违反「一个事实只保留一个当前权威」）。
>
> **本快照不是活动状态来源。** 当前活动状态看 [根注册表](../README.md)；
> 各计划的当前状态看该计划自己的 `implementation-status.md`。
> 保留它是为了不丢当时的措辞与推理链。

---

# Plantree — Project Planning Entry

> 本文件是仓库唯一活动规划入口。2026-08-31 前的长注册表已归档到 [history/2026-08-31-pre-pi-only-registry.md](./2026-08-31-pre-pi-only-registry.md)；旧 HTML dashboard 已归档到 [history/dashboard-2026-08-06.html](./dashboard-2026-08-06.html)，不再作为活动状态来源。

## Current direction

ai-client 正在收敛为 **Pi-only application**：

```text
Renderer → Preload → Electron Main WorkerManager
→ bounded WorkerSlot pool
→ one utilityProcess + one Pi AgentSession per slot
```

- Claude/Codex 不再作为可执行 conversation runtime。
- 原始 Claude/Codex 会话保持只读，通过原子、可去重的 import service 复制为 Pi session。
- Cycle 1/2 已完成产品行为和 evidence 保留；singleton host 和 multi-runtime transport 进入 adapt/replace/delete 路线。
- pi-app 是 WorkerManager/WorkerSlot/history/tree 主参考；pix 是 Pi TUI/PTY/CLI packaging 主参考。

## Resume reading order

1. 本文件。
2. [Baseline](../baseline/README.md)：module/runtime/storage/risk/gates。
3. [Pi-only realignment map](../indexes/pi-only-realignment-map.md)。
4. [Pi-only plan README](../plans/pi-backend-migration/README.md)。
5. [Decision index](../plans/pi-backend-migration/decisions/README.md) → [D14](../plans/pi-backend-migration/decisions/014-pi-only-product-and-conversation-import.md) → [D15](../plans/pi-backend-migration/decisions/015-main-owned-worker-manager.md)。
6. [Roadmap](../plans/pi-backend-migration/roadmap.md) → [Implementation status](../plans/pi-backend-migration/implementation-status.md)。
7. 只读当前任务直接链接的 topic/evidence/history。

## Authority order

1. 本 root registry：计划生命周期与唯一入口。
2. Pi plan README：当前产品范围和阅读路径。
3. Decision index + Active decisions：稳定方向和边界。
4. Pi roadmap：任务 ID、顺序、依赖和状态的唯一权威。
5. Pi implementation status：当前 phase、Next、blocker、last verified。
6. Active topics、baseline、evidence。
7. Historical/superseded plans、`docs/plans/` legacy sources 和 history snapshots。

旧文档中的 active wording 在被标记为 Historical/Superseded 后不覆盖以上权威。

## Plan registry

| Plan | Lifecycle | Current phase | Last landed | Next target |
|---|---|---|---|---|
| [Pi-only application convergence](../plans/pi-backend-migration/README.md) | **Completed** | Phase H / T37 closed；Phase I / T38 已关闭（2026-09-05） | **T38 runtime 补字段**：`usage.updated` 生产者挂 `turn_end`（一回合一条、不累加）、目录带出 `contextWindow`、`tool.updated` 补状态行。取证改了做法——pi SDK 的 `getContextUsage()` 直接给 `{ tokens, contextWindow, percent }`，占用由 worker 报而非渲染层算。全仓 274 files / 4210 tests 全绿，[T38 evidence](../plans/pi-backend-migration/evidence/2026-09-05-t38-runtime-usage-fields.md)。T38 欠项 ②（`turnTokensDisplay` 死路）已于同日由 UI 计划 [D11](../plans/pix-ui-alignment/decisions/011-retire-the-live-output-token-counter.md) 关闭 | 无活动 runtime 任务；正式发布仍走 rollout/rollback runbook |
| [pix/pi-app UI 对齐改造](../plans/pix-ui-alignment/README.md) | **In Progress（收尾）** | 批次 13/14/15 全部落地，只剩一次累计 GUI 点验 | **U30 + U31（2026-09-06）**：第二轮点验的产出。权限菜单改受控、只在 `applyTier` 里关；模型触发器菜单改 `align="end"` 并给标签封顶截断（它右边缘被 `ms-auto` 钉住、左边缘随内容浮动，所以菜单一直在跳）；权限卡的「重叠」其实是 `Button` 焦点光环画在盒外 3px 而 `gap-1` 只有 4px。U31 左栏批量归档，`archiveMany` 只 refetch 一次。280 files / 4246 tests 全绿，[evidence](../plans/pix-ui-alignment/evidence/2026-09-06-u30-u31-chrome-and-bulk-archive.md)。**问答卡取证**：`AskUserQuestion` 本仓一处都没有、pi 也不内置，而渲染层有完整消费链——与 D11 的实时 token 计数器同构，接还是删见 [Q14](../plans/pix-ui-alignment/open-questions.md)。上一片是 **U29（2026-09-06）**：起始屏底栏不再是空的。先查 pix——它的 Composer 根本不接收 sessionId，模型/思考档写给 host 进程、权限档是全局偏好，**「没有会话」这个状态在 pix 里不存在**；它防空白靠 `snapshot?.model ?? lastComposerChromeRef.current.model`。我们多会话并发，抄的是规则不是结构：控件永不空白，无会话时用全局模板 `chatAgentDefaults` 顶上（那个位置早就存在且控件本来就在写它），权限档另加一个独立 key。占用 chip 刻意不动（实测量）。278 files / 4230 tests 全绿，[evidence](../plans/pix-ui-alignment/evidence/2026-09-06-u29-start-screen-bar.md)。上一片是 **U28（2026-09-06）**：起始屏改为「可用的输入框」（[D14](../plans/pix-ui-alignment/decisions/014-start-screen-is-a-live-composer.md)，基准是用户给的 pix 截图）。**推翻同日早些时候 U22 的落地形态**——U22 的取证对（`canSend` 要求会话、四个入口全死），但它加按钮去补入口而没拆闸，而那个按钮把 React 事件对象当成会话标题传下去，用户点第一下就崩。现在 `runSend` 用 `activeSessionId ?? createUnboundChatSession()`，发送即创建会话；「没有会话」不再判故障（那是**应用把自己的起始状态标成红色**）；起始屏收敛为标记 + 标题 + 一句话，没有任何控件，并扩大到每一次对话开始。278 files / 4228 tests 全绿，[evidence](../plans/pix-ui-alignment/evidence/2026-09-06-u28-start-screen.md)。上一片是 **U25 + U26 + U27（2026-09-06）**：批次 13 收尾。U26（[D13](../plans/pix-ui-alignment/decisions/013-editor-stays-available-in-tui.md)）TUI 下也能看文件——根因是**一条过期的决定**，U03-a 写 `!isTui && editorOpen` 时「收右栏」意思是把宽度让给终端，D08 把编辑器搬进右栏后同一行变成了「终端开着就不能看文件」。U27 轨道加 `h-9` 占位与标题行对齐。U25 方向由用户改定为限制窗口最小尺寸，`SHELL_MIN_WIDTH = 1244` 取左栏展开态最小宽。278 files / 4227 tests 全绿，[evidence](../plans/pix-ui-alignment/evidence/2026-09-06-u25-u26-u27-layout-fixes.md)。上一片是 **U24（2026-09-06）**：按 [D12](../plans/pix-ui-alignment/decisions/012-single-session-view-and-background-concurrency.md) 删中栏 Tab 条回到单会话视图、并发上限 4→10、容量回收时提示一次；取证结论是**后台继续执行本就成立**（`isSafeToEvict` 第二条就是「没有正在执行的回合」），Tab 从未参与判定。再上一片是 **U22 + U23（2026-09-06）**：点验反馈的头两条缺陷。U22——`canSend` 的最后一道硬闸是「有没有会话」，而全新状态下四个出口全关（`createChatSessionOnWorkspace` 返回 null、`handleNewSession` 空转、`+ New` 带 `disabled`、欢迎卡只给「选目录」），所以卡上「不选也能直接聊」那句话没有任何路径；新增 `createUnboundChatSession()`。U23——`useSessionExtensions` 只订 `session.created`，而点开已有会话发的是 `session.resumed`。275 files / 4210 tests 全绿，变异验证两条各自判红，[evidence](../plans/pix-ui-alignment/evidence/2026-09-06-u22-u23-unbound-entry-and-plugin-resume.md)。上一批是 **U21（2026-09-05）**：下线 D33 遗留的实时 `↓` 输出 token 计数器（[D11](../plans/pix-ui-alignment/decisions/011-retire-the-live-output-token-counter.md)）。取证结论是**这不是「生产者还没接」**——pi 的 11 种事件里只有 `turn_end` / `agent_end` 带 usage，流式的 `message_update` 没有 token 字段，凑「实时」只能字符除以 4。整条删除并加一条反向守卫；「估算不得记为账单」的两处守卫与 `↑ NNN chars` 保留。274 files / 4194 tests 全绿，[D11 evidence](../plans/pix-ui-alignment/evidence/2026-09-05-retire-live-token-counter.md)。同日稍早是 **U06-b（随 Pi 计划 T38 同批）**：Run 面板占用环 + used/free/window 图例 + usage 行（标「上一回合」），U09-2 预留的底栏 `usage` 槽由 `ComposerUsageChip` 填上，工具名下方接实时状态行。**环只有 used/free 两段、不按角色分色**——pi-app 的角色份额是字符除以 4 估的，混进同一个环会让读者分不清哪半是实测；按角色的图留在 Context 页，单位是字符。[T38/U06-b evidence](../plans/pi-backend-migration/evidence/2026-09-05-t38-runtime-usage-fields.md)。上一批是**批次 9（U17–U20）**：三件用户报障 + 关闭 `user_configured` 权限档欠项——`worker.bootstrap` 套用了给暖 RPC 的 10s 预算导致启动 resume 超时（改为单开 60s）；思考强度对无 `thinkingLevelMap` 的模型把七档全给，`minimal` 打到真实供应商 502（改为「没声明就只给 low/medium/high」）；关中栏 Tab 改为**结束对话**（[D09](../plans/pix-ui-alignment/decisions/009-tab-close-ends-conversation.md)：确认框 + 断开运行时，左栏那一行保留）。全仓 271 files / 4162 tests 全绿，[批次 9 evidence](../plans/pix-ui-alignment/evidence/2026-09-05-startup-timeout-thinking-levels-tab-close.md)。上一批是批次 8（U15+U16）**VSCode 式壳层重排**：左栏成为 `44px 图标轨道 + 面板` 的导航容器（聊天/Git/文件/上下文/运行），右栏只留文件与编辑器，中栏一个已启动会话一个 Tab，**双栏/三栏与「上下文面板」开关整组删除**（[D08](../plans/pix-ui-alignment/decisions/008-vscode-dock-shell.md) 推翻 D07 决定一与决定三，并使 U02 整片作废）；上下文页加角色构成环形图 + 折叠限条。全仓 267 files / 4134 tests 全绿，[U15/U16 evidence](../plans/pix-ui-alignment/evidence/2026-09-05-u15-u16-vscode-dock-shell.md) | **批次 13/14 的累计 GUI 点验**（七片全部只差真窗口确认，U28 含一条崩溃复现）；另有五笔欠账，最需要拍板的是 U28 的底栏控件在无会话时不渲染（pix 有） |
| [pi 资源接入与斜杠命令](../plans/pi-resources-and-commands/README.md) | **Completed** | R01–R04 全部关闭（2026-09-06） | **R04（2026-09-06）**：设置新增资源页，说明共享技能 / 个人 Pi / 本应用 managed Pi 三个安装位置，`~/.agents/skills/` 标为推荐位；「打开模板目录」由 Main 解析并创建当前模式真实使用的 prompts 目录，借用开关改走 Main-owned setting，托管模式切换会重载 worker。focused 5 files / 29 tests、两套 typecheck、971-file Biome 与 GUI CDP 点验全绿，[R04 evidence](../plans/pi-resources-and-commands/evidence/2026-09-06-r04-resource-settings.md)。上一片是 **R03（2026-09-06）**：问答与子代理两个插件随包，workspace-history 因 SDK peer 冲突留 Q-R5。再上一片是 **R02（2026-09-06）**：斜杠命令三段全通，[R02-a/b evidence](../plans/pi-resources-and-commands/evidence/2026-09-06-r02ab-command-inventory.md) / [R02-c evidence](../plans/pi-resources-and-commands/evidence/2026-09-06-r02c-slash-menu.md)。**执行链路本来就通**（`prompt()` 的 `expandPromptTemplates` 默认 true），缺的只是发现与客户端自己的命令。目录**不缓存**——RPC 是进程内消息，缓存只会让新装的技能一直藏着。`/` 与 `@` 触发条件不同：只在消息开头，且**不需要工作目录**（起始屏正是要打 `/new` 的地方）。承重的一行是解析前先查目录里这个名字属于谁——否则加一个内置命令会静默夺走同名插件的命令。内置四条 `/new` `/settings` `/archive` `/compact`（用户砍掉了 `/permission`：底栏已有控件）；只有 `/compact` 留痕，而它的显示端 `piSessionTimeline.ts:116` 早就有了。CDP 探针实测：打 `/` 出菜单、`/ne` 过滤到一条、`look in /tmp` 不触发，并抓出三条缺失的中文词条。284 files / 4304 tests 全绿，六处变异各判红。上一片是 **R01（2026-09-06）**：托管模式下借用用户 `~/.pi` 的技能与模板，[evidence](../plans/pi-resources-and-commands/evidence/2026-09-06-r01-borrow-user-pi-resources.md)。一个环境变量同时承担开关与目标（Main 决定借不借，只在借时发路径），**只借资源绝不进 `additionalExtensionPaths`**（用户那份权限系统 31.0.0 会顶掉我们打了补丁的 27.0.1）。`unbound` 不撤销借用——项目信任管的是克隆仓库能配置什么，借用管的是这个用户给自己装了什么。PTY 环境显式剔除该变量（真 pi CLI 不读它，留着等于宣称一个没发生的借用），代价是 TUI 下不生效。281 files / 4262 tests 全绿，三处变异各自判红，未改写任何既有断言。**计划背景**：托管模式下 `PI_CODING_AGENT_DIR` 指向 `~/.pilab/pi-agent` 且项目信任关闭（`piModelConfig/index.ts`，TUI 与 GUI 同一份环境），**用户装在 `~/.pi` 下的技能/模板/插件一律不生效且无提示**。探针顺带查出技能有第四个来源 `~/.agents/skills`（`package-manager.js:1976` 用 `getHomeDir()`，不受任何模式影响），以及**信任一个仓库等于允许它自动 npm install**。斜杠命令的执行链路**已经通了**（`prompt()` 的 `expandPromptTemplates` 默认 true 且我们没关），缺的只有补全菜单与客户端自己的命令 | 无活动任务；Q-R1/Q-R2/Q-R3/Q-R4/Q-R5 均为需求触发的候选，不恢复为当前 roadmap |
| [模型配置页迁入 onboard](../plans/model-catalog-admin/README.md) | **Completed** | M01–M05 全部落地（2026-09-05） | **M01–M05**：模型配置从本仓单文件脚本迁到 onboard——SQLite 存储 + 鉴权拉取端点（登录 key 做 Bearer，因为配置可能含管理员填的渠道密钥）、Vite+React 管理页（/admin，静态口令）、客户端契约适配。四个 open question 与三项施工中决定见 [D03](../plans/model-catalog-admin/decisions/003-empty-catalog-is-legal-drop-seed.md)–[D06](../plans/model-catalog-admin/decisions/006-explicit-pi-block-in-register-response.md)。**硬编码的三个 `gpt-5.6-*` 兜底删除**：有了管理端之后它只会把拉取失败伪装成成功，空目录改为合法状态并明说「管理员没有启用任何模型」。onboard 134 tests、本仓 274 files / 4202 tests 全绿，[evidence](../plans/model-catalog-admin/evidence/2026-09-05-m01-m05-model-catalog-admin.md) | 两仓分支均未推送、onboard 未部署；GUI 点验并入累计点验 |
| [Entry and environment](../plans/entry-and-environment/README.md) | Maintenance | 主体完成；只剩 Pi-only 可复用错误面/GUI 复验 | two-entry welcome、spawn gate、git notice、settings ownership | 并入 T37 或另立小维护任务 |
| [Unified credentials/app state](../plans/unified-credentials/README.md) | Completed foundation | No active work | `~/.pilab/<profile>`、vault、credential mode、Pi arm | Pi config/import/removal 由 active plan 接管 |
| [OpenChamber product baseline](../plans/openchamber-chat-refactor/README.md) | Completed baseline | No active work | shell/timeline/Composer/files/git/terminal 产品资产 | runtime-neutral assets 由 T31/T36 适配 |
| [Claude + Codex multi-agent](../plans/multi-agent/README.md) | **Superseded / Historical** | No active work | ACP/Codex runtime、protocol、packaging 历史证据 | T28/T34/T35 按需引用，不恢复 execution roadmap |

## Current active task tree

任务身份看 [Pi roadmap T28–T38](../plans/pi-backend-migration/roadmap.md)：

```text
T28 replacement baseline
→ T29 single WorkerSlot
→ T30 bounded WorkerManager
→ T31 reattach Cycle 1/2 behavior
→ T32 history/resume
→ T33 tree/rewind/fork
├→ T34 legacy import → T35 remove legacy execution
└→ T36 pix-based Pi TUI
→ T37 release candidate
→ T38 runtime field completion
```

**T37 Pi-only release gates 已关闭，T38 runtime 补字段亦已关闭（2026-09-05）**。T28–T38 全部完成；Claude import、legacy execution final absence、Pi TUI 与 Windows/Linux/macOS 原生 packaged gates 均有 accepted evidence。Codex import仍等待真实本地格式证据，不恢复 legacy execution runtime。

当前没有活动施工 roadmap。[pi 资源接入与斜杠命令](../plans/pi-resources-and-commands/README.md)
已在 R04 关闭；后续候选只从它的 [open questions](../plans/pi-resources-and-commands/open-questions.md)
按真实需求重新 promote。

[pix/pi-app UI 对齐计划](../plans/pix-ui-alignment/README.md) 只剩一次累计 GUI 点验，不是活动施工入口。

## Stable evidence and history

- [Cycle 1 evidence](../plans/pi-backend-migration/evidence/2026-08-30-cycle1-execution.md)
- [Cycle 2 evidence](../plans/pi-backend-migration/evidence/2026-08-31-cycle2-execution.md)
- [Cycle 2 screenshots](../plans/pi-backend-migration/evidence/cycle2-screenshots/)
- [T30 WorkerManager evidence](../plans/pi-backend-migration/evidence/2026-08-31-t30-worker-manager.md)
- [T31-a streaming reattachment evidence](../plans/pi-backend-migration/evidence/2026-08-31-t31a-runtime-event-reattachment.md)
- [T31 behavior reattachment closure](../plans/pi-backend-migration/evidence/2026-09-01-t31-behavior-reattachment.md)
- [T32 history and real resume closure](../plans/pi-backend-migration/evidence/2026-09-01-t32-history-real-resume.md)
- [T33 tree, rewind and fork closure](../plans/pi-backend-migration/evidence/2026-09-01-t33-tree-rewind-fork.md)
- [T34 Claude legacy import closure](../plans/pi-backend-migration/evidence/2026-09-01-t34-legacy-import.md)
- [T35 Pi-only absence closure](../plans/pi-backend-migration/evidence/2026-09-02-t35-absence-audit.md)
- [T36 Pi TUI closure](../plans/pi-backend-migration/evidence/2026-09-02-t36-pi-tui.md)
- [T37-b resource and longevity gate](../plans/pi-backend-migration/evidence/2026-09-02-t37b-resource-longevity.md)
- [T37-c GUI and real-account point-check](../plans/pi-backend-migration/evidence/2026-09-02-t37c-gui-packaged.md)
- [T37-d session-brick defect fix](../plans/pi-backend-migration/evidence/2026-09-02-t37d-session-brick-fix.md)
- [T37-d release closure](../plans/pi-backend-migration/evidence/2026-09-03-t37d-release-closure.md)
- [T38 runtime usage fields + U06-b](../plans/pi-backend-migration/evidence/2026-09-05-t38-runtime-usage-fields.md)
- [Pre-Pi-only Pi plan snapshot](../plans/pi-backend-migration/history/2026-08-31-pre-pi-only-realignment/)
- [Pre-Pi-only baseline snapshot](./2026-08-31-pre-pi-only-baseline/)
- [Pre-Pi-only root registry](./2026-08-31-pre-pi-only-registry.md)

History/evidence 保留事实和推理，但不维护新的 Active TODO。

## Legacy planning roots

`docs/plans/` 保存旧 ARD、执行计划、台账、spike、GUI 清单和 incident records。它们不批量迁移或删除；需要时由当前 plan/evidence 精确链接。旧 OpenChamber/Claude/Codex authority 不能覆盖 Pi-only D14/D15 和当前 roadmap。

## Maintenance rules

- 一个事实只保留一个当前权威；不要在 status/topic/history 复制第二份任务状态。
- `roadmap.md` 拥有活动 task ID/status/order；`implementation-status.md` 最多五项 Active TODO。
- 重大重排先更新 [realignment map](../indexes/pi-only-realignment-map.md)。
- 决策 append-only：被替代时保留原理由并从 [decision index](../plans/pi-backend-migration/decisions/README.md) 指向替代者。
- Evidence 记录实际命令、日期和环境；不能沿抄旧“全绿”数字。
- 旧计划优先降权/归档，不删除推理链；实现代码删除必须经过 T28 map。
- 低承诺想法进入 [ideas/inbox.md](../ideas/inbox.md)，成熟后再 promote。
