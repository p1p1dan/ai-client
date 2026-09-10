# 2026-09-10 状态收敛前快照

Role: historical-snapshot。以下是整理前原文，含当时未同步的状态，不用于当前进度判断。当前节点见[核心任务树](../README.md)。

迁移依据：用户要求核心维护加一份用户看板；保留既有计划根与 README 承担 roadmap 的命名习惯。旧 TODO/交接入口保留跳转，历史段落不删除。回溯可读下列原文或 Git 历史；需要恢复时仅针对对应文档，不覆盖产品源码。

## docs/plantree/README.md

````markdown
# Plantree — 规划入口

本 worktree（`feat/runtime-evolution`）的唯一规划入口。

## 权威顺序

1. **ARD**（架构与决策的最终口径）：[`docs/plans/2026-09-08-runtime-evolution-ard.md`](../plans/2026-09-08-runtime-evolution-ard.md)
2. **任务看板**（执行顺序与进度）：[`plans/runtime-evolution/README.md`](plans/runtime-evolution/README.md)
3. **未决问题**：[`plans/runtime-evolution/open-questions.md`](plans/runtime-evolution/open-questions.md)

ARD 与看板冲突时以 ARD 为准；看板只记录「做到哪了」，不重复决策论证。

## 活跃计划

| 计划 | 状态 | 当前阶段 | 最近落地 | 下一目标 |
|---|---|---|---|---|
| [Runtime 自主化演进](plans/runtime-evolution/README.md) | In Progress | P4-6 `.11` 已出 Windows 包，Windows/Linux CI 通过，现场待签收 | `b6aa0844` 对应 `.11`，含 native 补修与主线 GUI；[P4-6 交接与 CI 结果](plans/runtime-evolution/evidence/p4-6/README.md) | Windows/加密机累计签收；macOS CI 仍运行；[TODO](plans/runtime-evolution/TODO.md) |
| [Pi SDK GUI 问题与体验](plans/gui-sdk-experience/README.md) | In Progress | A～E 修复已引入；现场验收归 P4-6 同一测试包 | A～E 来源提交见 [状态](plans/gui-sdk-experience/implementation-status.md) | [TODO](plans/gui-sdk-experience/TODO.md) |

## 当前并行规划

P4-5 由 Claude 完成，2026-09-09 已交接 Codex 跟进 P4-6；P5-2 已按用户要求改为**完整复刻 PI-Desktop subagent 子系统，再在整体基础上优化**。
规划入口：[源码调研](plans/runtime-evolution/topics/p5-2-subagent-research.md) → [D10/D17 契约](plans/runtime-evolution/topics/p5-2-subagent-contracts.md) → [任务/验收](plans/runtime-evolution/topics/p5-2-subagent-tasks.md)。
研究和文档完成不等于 P5 实现完成，现有 P4 状态以看板为准。

## 基线

[`baseline/README.md`](baseline/README.md) — 指向本仓库既有的架构与术语文档，不复制内容。

构建必需交付文档：[测试版迁移](../pi-only-migration.md) · [回退说明](../pi-only-rollout-rollback.md) · [候选说明](../release-notes/unreleased.md)。这些文档不代表现场验收或公开发布完成。

## 想法池

[`ideas/inbox.md`](ideas/inbox.md) — 未承诺的想法，提升为任务前不进看板。
````

## docs/plantree/plans/runtime-evolution/README.md

````markdown
# Runtime 自主化演进 — 任务看板

> 决策口径见 [ARD](../../../plans/2026-09-08-runtime-evolution-ard.md)（2026-09-08 已拍板，D1–D17 生效，D10/D17 的 subagent 整体复刻于 2026-09-09 修订）。
> 本文件只记录执行顺序与进度，不重复决策论证。

**当前阶段**：P0/P3 ✅；P1/P2 实现完成、余项等现场签收；**P4-0~P4-5 已落地**，native 后端可由 `AICLIENT_RUNTIME_BACKEND` 选中，本机端到端（多轮工具 + 审批 + 压缩 + 会话）与 GUI 四面点验通过；下一步 P4-6 打包载体验收。
**最近落地**：测试包源码 `b6dbfe65`（`1.0.0-test.12`）；在 `.11` 之上带 F1、旧会话 v3 resume、F4 重试层三项修复，来源映射见 [P4-6 记录](evidence/p4-6/README.md)。
**最新验证**：[CI 34354367890](https://github.com/p1p1dan/ai-client/actions/runs/34354367890) **全部 job success**（含上一轮未收尾的 macOS）；Windows 打包冒烟 legacy/native 两条 lane 通过，native 记录 `bundled-node` 载体。`.12` Windows installer/unpacked/portable 已上传，[原始报告与下载](evidence/p4-6/ci-34354367890/README.md)。该冒烟不等于真实安装应用的全链路验收。
**2026-09-09 Windows 现场进展**：`1.0.0-test.11` 上已执行 GUI A~E 与命令树清理五态并留证。五态清理全部无残留，P1 该项结清；GUI 大项通过但交回 7 组缺陷（F1~F7）与一项 v3 会话 resume 身份不匹配，逐条状态见 [执行 TODO](TODO.md#windows-交回缺陷2026-09-09linux-侧)。F2 已由 `dbead94b` 修复待复验。
**2026-09-09 Linux 侧本轮**：F1（网络设置面板渲染即抛 `FieldRootContext is missing`，非 Windows 特有）与旧会话 v3 resume 身份不匹配两项 🔴 已修并补测试；F3/F4/F5 三个决策点已定性，见 [GUI 缺陷决策](../../../plans/2026-09-09-gui-defect-decisions.md)。**F4 定性后已落地**：`plugins/agent-loop/providerRetry.ts` 补上自有重试层（429 与 5xx/网络各一条预算、`Retry-After` 优先、内层 `maxRetries: 0`），31 项测试。三项修复均待 Windows 现场复验。
**2026-09-09 Windows test.12 现场**：F1、F2 主流程、v3 会话 resume、P1-8 两载体六项探针、安装包 native worker 冒烟均通过；F3 再次复现；F4 因未自然触发 5xx/429 无法签收；新交回 TUI-1（🔴 native v4 进不了 Pi TUI）、EFFORT-1（已修）、PERM-1 与 F2-a/b/c，[逐项结果](TODO.md#windows-test12-现场复验结果2026-09-09)。
**2026-09-10 Linux 侧**：现场交回的六项已修并提交——EFFORT-1（档位没传进运行请求）、TUI-1（按方案 C 在入口拒绝并说明）、PERM-1（权限档按下即关）、F2-c（工作目录消失给出可操作说明）、F2-a（两处目录读同一份设置）、F7f（输入框放宽到八行）。三件仍需用户参与：默认思考强度取 off 还是 medium、F7b 第二处指示器的位置、F7a/F7c 的视觉口径。
**下一目标**：见上「待办」栏。两条 CI worker lane 不代签真实 Main/renderer 安装流程。P2-5/P2-6 真实缓存门槛仍为 95.01%，P5 尚未开工。
**2026-09-08 权限模型改向**：[ARD D14](../../../plans/2026-09-08-runtime-evolution-ard.md) 两轴分离：模式 `plan/agent` 管工具集，档位 `ask/accept-edits/auto` 管审批，accept-edits 放行工作区 bash。P1-1 裁剪与 P1-5 核心已更新；P1-6 renderer/偏好迁移/两轴传递链已更新，打包 GUI 待签收。
**2026-09-08 现场修订**：加密测试机实测 GUI/TUI 载体差异，[ARD D11](../../../plans/2026-09-08-runtime-evolution-ard.md) 把执行载体定为一等约束（[问题分析报告](../../../../Windows加密环境GUI异常分析.md)）。
影响本看板四处：P1-0（新增，P1 的第一件事）· P3-5（补 Main 侧读一致性）· P4-0/P4-3/P4-6（载体）· P6-3（现场清单）。

## 待办：当前步 + 下三步

只列眼下这一段的工作队列；完整节点树见下面的总览。每次更新看板时同步刷新本栏。

| # | 任务 | 状态 | 卡在哪 |
|---|---|---|---|
| **当前** | 出 test.13 复验本轮六项修复 | 🟡 | EFFORT-1 / TUI-1（方案 C）/ PERM-1 / F2-c / F2-a / F7f 已修并提交，[逐项与提交号](TODO.md#linux-侧本轮处理2026-09-10)；F2-b 待复现，F7b/F7a/F7c 需现场截图或设计判断 |
| 下一步 1 | 加密载体判定（R2/R3）与 F3 | ⬜ | 上一轮探针因目标文件无 TSD 头，无法区分明文与透明解密；需换受策略保护的样本重跑，F3 随之拍板 |
| 下一步 2 | 复现并修 F2-b | ⬜ | 删除 TEMP 分组中单条对话后整组不显示、其余对话错位、重启后消失；需要现场索引与会话文件的实际状态 |
| 下一步 3 | P2-5/P2-6 真实缓存对比 | ⬜ | P4-6 通过后按 P2-0 同套会话实测，provider 原始命中率不得低于 95.01% |

---

状态图例：`⬜ 未开始` · `🟡 进行中` · `✅ 已完成` · `⏸ 挂起` · `❌ 已放弃`

---

## 总览

| 节点 | 主任务 | 前置 | 状态 | 简要内容 |
|---|---|---|---|---|
| **P0** | 骨架 | — | ✅ | `src/runtime/` 落地，离线 + 在线冒烟均通过，风险 R1 关闭 |
| **P1** | 工具与权限 | P0 | 🟡 | plugin-tools（file/bash/search）+ plugin-permissions（scope 白名单 + 审批流） |
| **P2** | 上下文与提示词 | P0（P2-0 除外） | 🟡 | P2-0 基线完成；其余 plugin-context / plugin-prompt 任务可接续 |
| **P3** | 会话与事件 | P0 | ✅ | P3-1..P3-5 实现及 P3-6 本机往返矩阵通过；生产载体/GUI 接线归 P4 |
| **P4** | 集成 | P1+P2+P3 | 🟡 | P4-0~P4-5 已落地（载体同步、worker bootstrap、后端开关、RPC/载体接线、端到端、GUI 点验）；只剩 P4-6 打包载体验收（唯一一次上机窗口，同时签收 P1 积压的四条现场项）|
| **P5** | 扩展 | P4 | ⬜ | skills + subagent + MCP bridge + 会话导入适配 + 模型目录切源 |
| **P6** | 切换 | P5 | ⬜ | 默认新 runtime + 移除 pi-coding-agent + 达标验证 + 回退开关 |

**执行顺序**：`P0 → (P1 ∥ P2 ∥ P3) → P4 → P5 → P6`
P1/P2/P3 三个节点在 P0 落地后可由三个团队并行施工，文件归属见各节点下的「文件归属」。

---

## P0 · 骨架 ✅

前置：无 · 目标：单轮流式对话跑通，证明 D3 分层成立。
文件归属：`src/runtime/`（含独立 `package.json` / `node_modules`）· 目录说明见 [`src/runtime/README.md`](../../../../src/runtime/README.md)

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P0-1 依赖落地 | ✅ | `src/runtime/package.json` pin `cordis@4.0.0-rc.9` + `pi-agent-core@0.84.4` + `pi-ai@0.84.4`；P2-0 实测旧 SDK 嵌套依赖为 0.84.3，差异按 D12 记为已知偏差；根依赖未改，仅增加验证命令 |
| P0-2 目录与 bootstrap | ✅ | `bootstrap.ts`：Cordis Context 初始化 + 插件注册 + **服务存活断言** + dispose |
| P0-3 service 接口定义 | ✅ | `contracts.ts`：P0 三个 service 契约 + P1–P5 未实现服务的带原因声明（`DEFERRED_SERVICES`，工程规范 A3），由 `__tests__/contracts.test.ts` 机械把关 |
| P0-4 plugin-model-adapter | ✅ | `plugins/model-adapter/`：读 `models.json` + `auth.json`（D7 沿用现有凭据布局，不解 vault），展开 `$NAME` header 引用，绑定 pi-ai provider |
| P0-5 最小 agent loop | ✅ | `plugins/agent-loop/`：pi-agent-core `Agent` 单轮流式、无工具；`singleTurn` 为显式开关（工程规范 §6），P1 翻转 |
| P0-6 冒烟验证 | ✅ | 离线 lane（`pnpm smoke:runtime`，pi-ai `fauxProvider`，已进 CI 门禁，证据 [`evidence/p0/offline-smoke-trace.jsonl`](evidence/p0/offline-smoke-trace.jsonl)）+ 在线 lane（真实网关 6/7 model 通过，证据 [`evidence/p0/live-smoke.md`](evidence/p0/live-smoke.md)） |

**风险 R1：已关闭**（2026-09-08）。`anthropic-messages` / `openai-responses` /
`openai-completions` 三种 wire 协议各有至少两个 model 在真实网关上拿到完整流式回复，
ARD D3「保留 pi-agent-core」的分层成立。唯一失败项是网关侧上游 503，与 runtime 无关。

在线冒烟顺带产出两条要带进后续节点的事实（详见证据文件）：
**(1)** cch 网关按模型族分端点——Anthropic 系不带 `/v1`、OpenAI 系必须带 `/v1`，
配错的表现是 503「所有供应商暂时不可用」而不是 404，P5-5 切模型目录源时要确认托管端下发口径；
**(2)** pi-ai 的 OpenAI SDK 自带重试阶梯很慢（一次失败耗时 110s），P0 没有自有重试层，
P4-4 之前要把 PI-Desktop 的 `provider-retry.ts` 搬过来——**2026-09-09 已补**
（`plugins/agent-loop/providerRetry.ts`，内层固定 `maxRetries: 0`），起因是现场 F4。

**P0 顺带落地的工程规范最小清单**（`docs/agent-project-engineering.md`）：
非 UI 运行入口 §1（`smoke/runOnce.ts`）· 每次运行结构化 trace §2（`trace.ts`，含 D9 需要的原始 usage）·
Happy Path §3 与确定性断言 §4（`smoke/cases/` + `smoke/assertions.ts`）· 特性开关 §6（`flags.ts`）·
版本戳 §15（commit + 依赖 pin + flags）· 失败分类 §14（断言产出 tag）· 空壳门禁 A3。

---

## P1 · 工具与权限 🟡

前置：P0 · 文件归属：`src/runtime/plugins/tools/`、`src/runtime/plugins/permissions/`（P1-0 另含 `contracts.ts`）

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P1-0 IO/exec 出口收敛 | 🟡 | 两 service、TSD helper、P0 catalog/trace 迁移、carrier stamp 已实现且本机验证通过；保留进程树根身份的 Node runner 已实现，Linux 后代清理通过，Windows 分支仍待实测，[证据/边界](evidence/p1/README.md) |
| P1-1 工具注册表 | ✅ | 六工具发现、AgentTool schema、TypeBox 调用校验、重复注册拒绝；D14 plan 裁剪 Write/Edit 及默认写类插件，缓存工具引用也在执行边界拒绝；三档测试通过 |
| P1-2 文件工具 | ✅ | read/write/edit、规范路径、限额/截断、同路径写锁；Read 保持 1 起始行号及基线 2101/3 语义；本机验证通过，载体验收归 P1-8 |
| P1-3 bash 工具 | 🟡 | 配置 cwd/shell、时限/输出上限、Linux 进程组清理通过；Windows 清理边界见 P1-0，不宣称已跨平台签收 |
| P1-4 搜索工具 | ✅ | glob + 首版字面文本 grep，目录/文件/累计预算、symlink/拒绝 scope 跳过；未实现正则与 gitignore 引擎，行为明确写入工具 schema 描述 |
| P1-5 权限内核 | 🟡 | D14 两轴、旧值迁移、deny/scope/白名单/会话授权已实现；Bash AST 检查引号/变量/重定向/嵌套/通配符/真实路径，审批后复核；全局/可信项目/旧 JSONC 策略导入及 stamp 已实现。专项测试通过，仍需 P4 真实项目/重载签收；不承诺 OS 沙箱，见 [证据](evidence/p1/README.md) |
| P1-6 审批流对接 | 🟡 | Extension UI bridge + renderer 两模式/三档控件、旧值迁移；创建/resume/更新/复用/重启传递两轴，更新失败保留旧值；旧 worker D14 授权器/裁剪已适配。DOM 交互与 IPC/RPC/生命周期测试通过；打包 GUI 全链路仍待 P4 签收 |
| P1-7 单测 | ✅ | 本批 native runtime 20 文件 242 项分批通过，[P3 完成记录](evidence/p3/completion/README.md)；Main 索引 34 项另计，历史 D14 UI/worker 见 [P1 证据](evidence/p1/README.md)。载体探针归 P1-8 |
| P1-8 载体兼容矩阵 | 🟡 | Linux electron-utility 同批六项通过；standalone-node 另列通过；已提供 Windows bundled-node 入口，尚未运行，不代签加密机 |
| P1-9 `new_context` 工具 | ✅ | 与 P2-8 成对上线。`ContextPlugin` 构造时以 `read` 注册该工具，注册者即消费者：plan 模式可见、无普通审批、显式工具白名单仍可拒绝；compaction 关闭时不注册。无参数，描述照抄 Codex 原话「Start a new context window. Does not clear, reset, or otherwise affect environment state.」，回复按压缩家族分两种。调用只表达意图，实际换窗在 `prepareNextTurnWithContext` 边界发生 |

覆盖 ARD 缓解项：首版 5 个工具覆盖 90% 场景。
D11 提醒：白名单按进程算，所以「只把 Read 修好」不成立——P1-0 的两个出口是这条约束的落点。

---

## P2 · 上下文与提示词 🟡

前置：P0（P2-0 除外，可立即开工）· 文件归属：`src/runtime/plugins/context/`、`src/runtime/plugins/prompt/`

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P2-0 现状基线采集 | ✅ | 六个旧后端固定会话通过；28 次普通调用，D9 命中率 **95.01%**；原始会话、来源证明与复核结果已归档，[验收证据](evidence/p2-0/validation.md)（2026-09-08，提交 `8a71c843`） |
| P2-1 提示词分段组装 | ✅ | `runtimePrompt` Cordis service、存活断言、公共契约与运行入口已接通；固定槽位装配 base / tools / project / mode / permission-gear。未传 systemPrompt 自动组装，显式值（含空串）保持探针覆盖语义；trace 记录来源、槽位和 staticPrefixBytes。仅 skills 仍 deferred（P5），[本批证据](evidence/p2/README.md) |
| P2-2 项目指令注入 | ✅ | InstructionSource 已适配 runtimeHostIo：有界读取、UTF-8 边界截断，预期缺失/不可读跳过，TSD/载体错误向上传递。managed 全局 → 显式 borrowed 全局 → root→leaf；每目录首命中、32 KiB 共享预算和 realpath 越界跳过沿用。每 run 重载，targetPath 指定文件链；纯逻辑与真实请求集成测试通过，[本批证据](evidence/p2/README.md) |
| P2-3 压缩策略 | ✅ | 决策层 `plugins/context/budget.ts`（阈值全部由模型窗口推导、硬限触发、保留尾与用户消息上限的双端钳制、两级提醒各只发一次，17 项单测）＋执行层 `plugins/context/compaction.ts`（PI-Desktop 的 Codex 形状：三段合并为一段摘要范围，保留尾只在 turn 未结束时重建为最近一条用户消息并截断，因此不可能产生孤立 toolCall）＋服务 `plugins/context/index.ts`（`runtimeContext`，模型请求与硬限共用一条路径，`summary` 家族发一次模型请求，`fresh_window` 不发）。压缩只换模型请求上下文；完整历史由 session 日志保留，重建的 Agent 从最新 checkpoint 开始。首轮按输入 + systemPrompt + 工具定义估算预算，超限返回 context_too_large 且不调用 provider；内部容量提醒不参与用户消息保留。**P2-4 已接通可选 session 持久化** |
| P2-4 compaction record | ✅ | 配置 session 后，完整原始消息和独立 compaction Entry 通过 HostIo 追加；summary/retainedTail/tokensBefore/usage/details 原样保留，写成功后才切请求窗口。新 run/resume 恢复最新 checkpoint，第二次压缩使用 previous-summary；两种家族、跨进程续聊和写失败测试通过，[证据](evidence/p3/README.md)。旧格式迁移已由 P3-3 接通 |
| P2-5 缓存命中率达标 | ⬜ | 门禁是 provider 上报的 `cacheRead / (input + cacheRead)`（D9），公式与数据源都已存在，不新增埋点。**已知可优化点**：PI-Desktop 把预算提醒追加进 systemPrompt（`runtime.ts:4160`），那正是缓存前缀本身，一次追加即整段失效；P2-8 已改为尾部消息注入以保持前缀字节不变，本节点用真实命中率复核该选择 |
| P2-6 对比测试 | ⬜ | 新后端跑 P2-0 的同一批脚本会话，比压缩后表现与命中率；协议依赖 0.84.4 vs 基线 0.84.3 的 patch 差按 D12 记为已知偏差，不回退对齐 |
| P2-7 前缀稳定性度量 | ✅ | **可选加强项**，非门禁。`plugins/context/prefixStability.ts`：按块（system / tool / message）位置比对相邻两轮请求，给出公共前缀块数、字节数、占比与**首个冲突位置**——命中率只说miss，这里说 miss 在哪。**只落摘要哈希不落原文**，避免把会话内容写到日志旁。追加与收缩（压缩/回溯）都不算 divergence，用块计数区分形状。13 项单测 |
| P2-8 主动压缩提醒文案 | ✅ | `approachingReminder(remaining, { compactionTool })` 只有拿到已注册的工具名才追加那一句，不传就不提——配对规则因此是机械的，而不是靠人记得。at-limit 档不重复邀请（那时下一次请求必然压缩）。提醒**以内部 custom 消息在尾部注入**（仅 convertToLlm 时映射成 provider user 消息，不会取代压缩时保留的真实用户指令）而非追加 systemPrompt：systemPrompt 就是 D9 计命中率的缓存前缀，Codex 本身也把提醒写进对话历史；位置的实测复核仍归 P2-5 |

**P1-9 ∥ P2-8 为什么必须成对**（2026-09-08 已成对落地，下文保留论证）：默认压缩是被动的——token 越过硬限的那一刻就地压缩，而那一刻落在哪儿全看运气，很可能是多文件改到一半、或刚读完三个文件还没得出结论。模型自己看不到 token 计数，没有任何依据判断「还剩多少」。
PI-Desktop 因此把两件事配成一对：**预算提醒**告诉它还剩多少，**`new_context` 工具**让它选择什么时候承担这次压缩。收益是质量——在语义边界上生成的摘要，比在半步中间生成的丢得少。
任一边单独落地都是坏的：只有工具没有文案，等于没人告诉模型它能用；只有文案没有工具，模型会真的去调并拿到 unknown tool 错误，白费一轮且后续行为不可预测——与提示词槽位表推迟 `tool-protocol` / `tool-guidance` 是同一条理由（文案不能描述当前不存在的能力）。

---

## P3 · 会话与事件 ✅（实现与本机验证）

前置：P0 · 文件归属：`src/runtime/plugins/session/`、`src/runtime/events/`

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P3-1 JSONL 存储 | ✅ | 自有 plugin-session 读写当前 Pi v4；独占锁、顺序追加、文件限额、尾片恢复、写失败阻止后续追加。Pi 官方 reader/writer 双向互通。PI-Desktop schema 1 与 Pi v4 不是同一 wire 格式，本批适配 checkpoint 恢复语义；旧格式导入由 P3-3 接通，见 [兼容契约](topics/p3-1-session-contracts.md) / [证据](evidence/p3/README.md) |
| P3-2 分支与 resume | ✅ | main lane 导航/确认 rewind/独立 fork、完整树/历史与标签标题；选中分支恢复 checkpoint、模型/thinking/D14，fork 不修改源；运行期间拒绝导航，dispose 排空 fork，[证据](evidence/p3/completion/README.md) |
| P3-3 旧会话兼容 | ✅ | Pi v1/v2/v3 与 PI-Desktop schema 1 导入独立 v4；旧权限四值完整迁移，工具/compaction/custom 保留；重复 resume 校验来源并复用副本；六份原始 P2-0 JSONL 离线续聊及重开通过，原文件不变，[证据](evidence/p3/completion/README.md) |
| P3-4 RuntimeEvent 翻译层 | ✅ | native run 已接消息/思考/工具/usage/status/error/custom/compaction；复用现有 DTO/usage/pagination，累计 usage 跨 resume，Main 统一 host seq；生产 worker RPC 接线归 P4 |
| P3-5 对接 SessionIndexService | ✅ | **D13 的 Main 侧改造已落地** `de26eb5e`：`GitService` 两处 diff 工作区侧与 `WorktreeService` 冲突编码探测改走 `readWorkingTreeFile`；**并补上 ARD D13 清单漏掉的 `detectBinaryFile`**——密文容器的 NUL 填充会让整个工作区的文本文件被判成二进制；`tsdSafeRead` 的解密进程改为优先随包 `node.exe`，留 `AICLIENT_TSD_NODE_PATH` 覆盖。6 项测试覆盖容器→明文与二进制判定，驱动本身的解密无法在此复现，现场验收按 D16 归 P4-6。**本批接通**：NativeSessionIndexAdapter 对接现有索引格式；身份/leaf、分页、失败回滚和 fork 清理实际联调通过，并修复索引重命名写失败时的内存回滚；[本批证据](evidence/p3/completion/README.md)。生产 worker 接线归 P4；Q7 已由本分支 `b984b282` 修复判据与超时问题，[收口说明](open-questions.md)，加密机复测归 P4-6 |
| P3-6 往返测试 | ✅ | v4 官方互通、两种压缩与再次摘要、分支往返/fork 隔离、D14 四值与六份旧基线、Main 索引故障回滚及两个 Node 进程恢复通过；GUI/载体现场测试归 P4，[证据](evidence/p3/completion/README.md) |

---

## P4 · 集成 🟡

前置：P1 + P2 + P3

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P4-0 同步平台 worker 改动 | ✅ | main 的 `45d43db8`（D20 Windows 随包 Node worker）已取代码部分落地 `78168b4d`：worker 入口同时支持 Electron MessagePort 与 Node IPC，Windows 安装版走随包 `node.exe`，缺失即明确失败不回落（D11）；`WorkerTransport` 增 `createNodeProcessWorkerTransport` 并排空普通 stdout。文档部分在本 worktree 已分叉，未取（D11 已是调和后口径）。顺带取 main 的 `3690ef8f` 修 `piUsage.ts` 对 `piTurnRollup` 的无后缀值导入——否则 dev 路径的 `worker.ts` 在 `--experimental-strip-types` 下加载失败。**刻意不复用 `NodeRuntimeResolver`**：它会回落到 nvm/PATH，与 D11 相反。验证：agent-host 两个目录 36 文件 487 项、`tsc --noEmit`、biome 全通过；打包壳内两种 carrier 的实测仍归 P4-6 |
| P4-1 worker bootstrap | ✅ | `87cb8512`：`runtime/worker/nativeWorkerRuntime.ts` 把 Cordis 插件图接到既有 worker RPC 面。`PiWorkerRpcServer` 本就以工厂注入引擎，两个后端共用同一套相关性/generation/串行化，不分叉 dispatcher；适配器**不**引用 `piWorkerRpcServer`（会把 pi-coding-agent 拖进 native 路径），形状由 worker 入口那一处赋值把关。两种 carrier 共用同一入口。`compact`/`rewind`/`reload`/`fork`/`commands` 未实现，缺方法得到 `WORKER_*_UNAVAILABLE`，归 P4-4 |
| P4-2 后端开关 | ✅ | `87cb8512`：`AICLIENT_RUNTIME_BACKEND=native` 时才动态 import native 模块，legacy 完全不加载 cordis——未完成 runtime 的 import 期故障够不到用户会话。无法识别的取值按 legacy 读（D8）。入口改为先挂监听再排队：Node IPC 到达即派发、没有监听者就丢，动态 import 那段窗口必须有队列。两项测试用**真实 worker 进程**验证开关，不是只测 flag reader |
| P4-3 WorkerTransport 适配 | ✅ | 通道抹平在 `78168b4d`（P4-0）已落地；本节点补 `runtime/host/worker.ts` 按 D11 产出两种 carrier 的 host 配置。关键约束：electron-utility 下**不得**把 `process.execPath` 当 TSD helper——那正是现场证明会读到密文的 Electron 二进制；只认随包 node，没有就明说没有回落。事件出口沿用 `RuntimeEventDraft`，`seq`/`timestamp` 仍由 RPC server 盖（D5）|
| P4-4 端到端 | ✅ | `e1c557b7` + `8e4fee3d` + `7b280291`：P4-1 留下的 RPC 方法全部补完（`compact` / `commands` / `rewind` / `fork` / `discardFork` / `setPermissionTier` / `reload`），`PiWorkerRuntime` 上只剩 `commands` 返回空列表——斜杠命令来自 skills，归 P5-1。**修 P4-1 四处**：(1) `stop()` 原本 await 整个 turn，会把串行 RPC 链按 provider 注意到 abort 的时长卡住（含 dispose）；(2) 适配器漏传 `tools` 配置，bootstrap 据此把 loop 钉成 `singleTurn`——native worker 其实只能答一轮且没有工具；(3) `compact` 曾映射成 `requestNewWindow` 记意图，而那是 run 内语义、`beginRun` 每次开跑都清空，两次 run 之间的 /compact 直接被抹掉，返回 `{compacted:true}` 却什么都没做，改为立即压缩并接通此前硬写 `undefined` 的用户压缩指示；(4) `reload` 曾判为 pi 历史包袱而不实现——实为 `chat.ts:483` 的 CHAT_SEND 在释放 pi TUI 终端后必调，缺它会让 native 下的发送直接失败并把终端内容留在废弃分支（自有写锁是建议性的，TUI 不看）。端到端 11 项用真实 `PiWorkerRpcServer` + 真实 Cordis 图 + 真实工具/权限/JSONL，只替换 provider（fauxProvider）与消息端口。成功标准 1 本机达成，打包壳实测归 P4-6 |
| P4-5 GUI 点验 | ✅ | 时间线 / Composer / 权限卡 / 设置页四面无回归（成功标准 4）。**查出并修掉四处沉默缺口**（[D5 补充](../../../plans/2026-09-08-runtime-evolution-ard.md)）：(1) native 完全不发 `permission.activity`，`policy_allow` 那行本是「被网关判过」的唯一证据；(2) 用户 `message.started` 缺 `attemptId`，composer 的乐观气泡永远退不掉、用户的话留两份；(3) `worker.send` 的 `attachments` 被静默丢弃，模型收不到也不报错；(4) 内部记账条目 `aiclient.permissions` 漏上时间线，顶部多一行裸 JSON 和一个空轮次。四处都不抛错——reducer 对认不出的消息返回 `{}`。回归防线是**录制事件流**：runtime 侧 `guiEventContract.test.ts`（6 项，真实 RPC + 真实插件图）录，renderer 侧 `nativeStreamReplay.test.ts`（13 项）喂进真实 reducer 断言用户看到什么；两侧跨不过 typecheck 边界，故以 JSON 交界。顺带修好 D14 之后一直红着的三处权限控件静态用例（断言按行扫描，代码换行后失配，接线本身完好）。**D13 的 Main 侧读**：git/worktree 四处工作区读全部走 `readWorkingTreeFile`/`detectBinaryFile`，无遗漏直读；驱动本身的解密仍无法在此复现，按 [D16](../../../plans/2026-09-08-runtime-evolution-ard.md) 归 P4-6 上机 |
| P4-6 打包载体验收 | 🟡 | **准备中，未验收**：完整门禁/Windows/Linux 产物通过，`.11` 已出包，包含退出修复与 GUI A～E；安装/加密现场尚未签收，[交接与环境分工](evidence/p4-6/README.md)。在打包壳里用本地模型替身（HTTP SSE stub，不调线上模型）驱动真实 Read/bash，两种 carrier 各跑一遍；复用 runtime 离线 lane 的 `fauxProvider` 用例与 `scripts/packaged-worker-smoke.cjs` 的替身思路。**本节点同时是唯一一次上机窗口**（[D16](../../../plans/2026-09-08-runtime-evolution-ard.md)）：P1-0 的 runner + taskkill 命令树清理、P1-3 的 bash 跨平台、P1-8 的六项工具探针、P4-0 的随包 Node worker 载体，四条积压的现场项都在这里一次签收，按载体矩阵逐条走，不用「跑通一个会话」代签 |

---

## P5 · 扩展 ⬜

前置：P4

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P5-1 plugin-skills | ⬜ | 技能加载 + 模板，路径适配 `~/.pilab` + `~/.agents/` |
| P5-2 subagent 整体复刻 | ⬜（调研/契约已更新） | 按 D10/D17 完整复刻 PI-Desktop 当前子系统，含 Task* 后台编排、四角色、模型/权限/重试、管理/运行 UI、历史/usage/迁移和必要宿主能力；P5-2-0～7 全部签收后再优化。[任务矩阵](topics/p5-2-subagent-tasks.md) |
| P5-3 MCP bridge | ⬜ | MCP 工具接入自有工具注册表；stdio server 的进程启动走 P1-0 的 `runtimeExec`，不自建一套 spawn（D11） |
| P5-4 会话导入适配 | ⬜ | 现有 `LegacyImportService` 适配新 session 插件接口 |
| P5-5 模型目录切源 | ⬜ | 随包快照 + 离线回落从 pi-coding-agent 配置切到自有配置。**baseUrl 按 [D15](../../../plans/2026-09-08-runtime-evolution-ard.md) 由客户端按 wire 协议推导、每个 model 可显式覆盖**——cch 网关按模型族分端点（Anthropic 不带 `/v1`、OpenAI 带 `/v1`），配错表现是 503 而不是 404，所以这条推导要有单测钉住，不联网 |

**P5-2 范围修订（2026-09-09，用户要求整体复刻后优化）**：固定参考 `948ee676`，不再按旧 ADR 0062/0119 只搬基础 runner。
完整契约采用 Task/TaskWait/TaskList/TaskStop、10 并发、父 idle 不杀子任务与报告自动交回；定义管理和运行/历史 UI 同属必交范围。
本轮完成文档调研，**未实现子代理**；[调研与迁移地图](topics/p5-2-subagent-research.md) / [契约及 P4 接缝](topics/p5-2-subagent-contracts.md) / [8 批任务、22 项矩阵](topics/p5-2-subagent-tasks.md) / [参考验证证据](evidence/p5-subagent/README.md)。
P4-5 由 Claude 完成，P4-6 已交接 Codex；P5-2-0 核对 Pi 0.85.0→0.84.4 与宿主依赖，禁止未经决策升级 D12。用户确认仅内部测试，适合的源码直接搬用，本轮不新增版权、许可证或来源版本记录，不设许可证审批；部门内部实验不属于本计划的任务或验收条件。
既有 pendingPermissions 队列可复用，**不代表 subagent 管理与展示层无需实现/验收**。完整基线前不调低并发、削减角色或省略 UI。

---

## P6 · 切换 ⬜

前置：P5 + GUI 点验

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P6-1 默认切换 | ⬜ | 新 runtime 设为默认后端 |
| P6-2 摘除依赖 | ⬜ | `@earendil-works/pi-coding-agent` 移出 package.json（成功标准 3） |
| P6-3 达标验证 | ⬜ | 缓存命中率 ≥ 现有水平，**六条**成功标准逐条签收；第 6 条是加密机现场清单（GUI Read 明文 / `pwd·ls·echo` 正常 / Edit·Write 后 TUI 与编辑器一致 / 旧会话 resume / 退出无残留 worker），CI 绿不能替代 |
| P6-4 回退开关 | ⬜ | 旧路径保留一个版本周期，开关可回切 |
| P6-5 旧集成层退役 | ⬜ | 一个版本周期后移除 `src/agent-host/` 的 pi-coding-agent 路径 |

---

## 成功标准对照（ARD §7）

| # | 标准 | 验收节点 |
|---|---|---|
| 1 | 完整多轮对话（工具 + 权限 + 压缩） | P4-4 |
| 2 | 缓存命中率 ≥ 现状 | P2-0 采基线 → P2-6 对比 → P6-3 签收 |
| 3 | pi-coding-agent 移除，只剩 pi-agent-core + pi-ai | P6-2 |
| 4 | GUI 无回归 | P4-5 |
| 5 | 旧会话可读可 resume | P3-3 |
| 6 | 加密机现场验收（D11） | P4-6 跑门禁 → P6-3 现场签收 |

## 维护约定

每完成一个主任务节点（或用户主动触发）更新本文件：改状态图标、更新顶部「当前阶段 / 最近落地 / 下一目标」，落地证据填 commit 号与日期。子任务粒度的进度可随手更新，无需另开状态文件。
````

## docs/plantree/plans/runtime-evolution/TODO.md

````markdown
# Runtime 执行 TODO

2026-09-09 状态同步 · [看板](README.md) · [P4-6 交接与 CI 结果](evidence/p4-6/README.md)

当前阶段：P4-6 的 Windows 现场已执行 GUI A~E 与命令树清理五态，两者均留证；GUI 核心功能在 native 后端可用，交回的 7 组缺陷中 F1/F2/F4 与旧会话 resume 已修、F3/F5 已定性。企业加密机签收仍未开始。**当前测试包提交 `b6dbfe65`（`1.0.0-test.12`）**，[CI 34354367890 全绿含 macOS，证据/下载/现场清单](evidence/p4-6/ci-34354367890/README.md)；上一包 `.11` 的记录见 [ci-34308304362](evidence/p4-6/ci-34308304362/README.md)。

本轮授权：同步状态文档、推送任务分支并手动 CI 打包；测试包名称/版本可递增。不本地打包、不推 tag、不触发自动发布。用户已明确授权本轮代码/工作流修复，与 Windows AI 同步推进。

## 当前 TODO：P4-6

- [x] 接棒 `9edab07c`，推送 `feat/runtime-evolution`，手动触发并核对 [CI 34303440949](https://github.com/p1p1dan/ai-client/actions/runs/34303440949)；未出包。
- [x] 修复 helper 测试样本，补齐打包 job 的 runtime 依赖与双后端冒烟；另补 native shell 接线和 ESM bundle 的 CommonJS 支持。本机小批测试/runtime typecheck 通过，产物待 CI。
- [x] 手动 [CI 34308304362](https://github.com/p1p1dan/ai-client/actions/runs/34308304362) 生成 `.11` Windows installer/unpacked；包含主线 GUI A～E 与正常退出修复，Windows/Linux 双后端产物冒烟通过，原始报告已归档。macOS 同轮仍运行。
- [x] 2026-09-09 Windows 现场执行 GUI A~E 与命令树清理五态：[GUI 结果与缺陷清单](../../../../Windows-P4-6-evidence/gui-a-e-findings.md)、[五态清理证据](../../../../Windows-P4-6-evidence/tree-cleanup-five-states.md)。GUI 大项通过，交回 7 组缺陷。
- [ ] 六项工具探针与两种 carrier 分别留证仍未执行；[主线 GUI 清单](../gui-sdk-experience/现场验收清单.md)按组回填中，未全部签收。
- [ ] 企业加密机签收明文读写、Main diff/编码/二进制判定、GUI/TUI 一致性与退出无残留；逐项回填 P1/P4，不能代签。

历史代码提交：`27ff2020` + `2ae6f209`（2026-09-08，实现与证据归档；不代表完整验收）。

## 已完成批次：P3-2 / P3-3 / P3-4 / P3-5（代码与证据已归档）

- [x] P3-2：完整树、导航、确认 rewind、独立 fork、标签与历史恢复。
- [x] P3-3：Pi v1/v2/v3 / PI-Desktop schema 1 迁移、来源保护、D14 旧值与历史状态恢复。
- [x] P3-4：既有 RuntimeEvent 翻译并接入 native run。
- [x] P3-5：Main SessionIndexService adapter 实际联调与持久化。
- [x] 按 [收尾契约](topics/p3-completion-contracts.md) 逐项验收、回归和证据归档。

## 已完成批次：P3-1 → P2-4（代码与证据已归档）

- [x] 核对 Pi v4 / PI-Desktop schema 1 差异并写入 [存储契约](topics/p3-1-session-contracts.md)。
- [x] 自有 JSONL 存储、独占 writer、损坏尾行处理、官方 Pi 格式互通。
- [x] message_end 写入、同 runtime 多 run 串行边界、dispose 排空。
- [x] 压缩记录持久化、跨 run/resume 恢复及再次压缩。
- [x] 小批回归、类型检查、证据与看板同步。

## 已完成批次：审查补修 → P2 接线

- [x] 修复内部容量提醒被当作用户任务保留，覆盖提醒后主动换窗的真实工具循环。
- [x] 首轮模型请求前检查预算；超预算明确失败，不截断用户输入、不调用 provider。
- [x] P2-1：注册 runtimePrompt，接通固定槽位、工具贡献和 D14 两轴；显式 systemPrompt 保留固定探针入口。
- [x] P2-2：InstructionSource 适配 HostIo，接入全局与项目指令链并验证真实请求。
- [x] 小批串行回归、类型检查、离线冒烟；更新看板/交接/证据。P2-4 依赖 P3，P2-5/P2-6 按计划在 P3/P4 后真实验收。

该历史批次已提交 `fb7cb10b`（2026-09-09）；[P2 验证记录](evidence/p2/README.md)记录 15 文件 195 项、类型检查与冒烟。

## 已落地：P4-0～P4-5（打包现场验收另列）

- [x] P4-0/P4-3：随包 Node / utilityProcess 共用 worker RPC 与事件/取消语义，host 配置按载体生成。
- [x] P4-1/P4-2：worker bootstrap 切入 Cordis 图；环境变量选 native，默认 legacy。
- [x] P4-4：多轮工具、审批、压缩、会话 RPC 与 GUI/TUI reload 接线本机通过。
- [x] P4-5：四处事件缺口已修，真实事件录制 6 项 + renderer reducer 重放 13 项；D13 读路径静态复核完成，驱动解密归 P4-6。

## P5-2 并行调研与后续完整复刻

- [x] 2026-09-09 用户确认整体复刻后优化；固定参考源码、追踪 ADR 演进、核对本仓差异。
- [x] 更新 ARD D10/D17、[完整契约](topics/p5-2-subagent-contracts.md)和[任务/验收矩阵](topics/p5-2-subagent-tasks.md)；参考 3 文件 32 项轻量测试通过，非产品验收。
- [ ] P4 稳定后执行 P5-2-0 版本/宿主依赖门禁（不新增版权、许可证或来源版本记录，不设许可证审批），再按 P5-2-1～6 实现整个子系统。
- [ ] P5-2-7：22 项等价矩阵与 GUI/两载体全部签收；不能用 runner 完成代替整体完成。
- [ ] 完整基线后另案优化并发资源/报告成本/性能；未开工。

## P2 后续门禁

- [x] P3-1：Pi v4 自有存储、与 PI-Desktop 不同 wire 格式的兼容契约和官方互通测试完成。
- [x] P2-4：compaction record 已经 session 存储持久化，跨 run/resume/进程重开与再次摘要通过。
- [x] P3-2/P3-3：完整分支导航、Pi v1/v2/v3/PI-Desktop schema 1 导入及 D14 旧值迁移；P3-4/P3-5 事件和索引已接通。
- [ ] P2-5/P2-6：P3/P4 后以 P2-0 同套会话实测，原始 provider 命中率不得低于 95.01%；记录 0.84.4/0.84.3 偏差。

## 已落地：D14 返工

- [x] 重读 P1 交接、ARD D14 和当前代码；确认旧 69 项测试不能代签新权限模型。
- [x] P1-1：plan/agent 枚举、注册表按模式裁剪，执行边界也拒绝被裁掉的工具。
- [x] P1-5 核心：ask/accept-edits/auto、旧值迁移、deny 优先；accept-edits 放行工作区 bash。
- [x] P1-5：Bash AST（引号、变量、cd、重定向、嵌套 shell/替换、通配符与 symlink）及原生策略加载已接入；路径同时参与 deny/scope 判定，审批后复核，普通工作区管道自动放行。
- [x] P1-5：导入全局/可信项目及旧 JSONC 配置；保持表合并顺序，glob 映射旧 find，坏配置明确阻止启动；policy 哈希/来源/迁移提示进 stamp。
- [ ] P1-5/P4：在真实项目中验证复杂脚本兼容与策略更新后的 runtime 重载；动态程序仍不属于 OS 沙箱保证。
- [x] P1/P2 提示词接口：导出 modeSegment / permissionGearSegment，对齐新固定槽位。
- [x] P1-6：renderer 两模式/三档控件与偏好迁移；新 IPC/RPC 传递完整 permissions，旧 tier 仅保留兼容入口。
- [x] P1-6：创建/resume/存量 worker 复用、空闲时更新、崩溃重启传递 mode + gear；worker 拒绝时 UI 不落盘。
- [x] P1-6：旧 worker 适配 D14 工具裁剪/授权器，随包 bash 默认询问，accept-edits 由授权器放行；DOM 交互与真实策略加载回归通过。
- [ ] P1-6/P4：打包壳 GUI 全链路签收；用户自定义策略与复杂 shell 兼容仍按 P1-5 跟踪。
- [x] 更新新矩阵与载体证据：native runtime 共 109 项通过，Node 与 Linux Electron 六项探针通过；Windows 和 GUI 仍待验收。

## 新增 P1-9（与 P2-8 成对）—— 已成对落地

- [x] 阅读 PI-Desktop new_context 源码和测试，适配无参数工具、两种回复及只提交意图语义。
- [x] 导出 newContextTool({ family, request })；已由 ContextPlugin 默认按 read 注册，plan 可用，无普通审批，显式工具白名单仍生效。
- [x] `runtimeContext` 服务落地：注册工具、消费意图、执行换窗（`prepareNextTurnWithContext` 边界）。压缩只换请求上下文；完整历史保留在 session 日志。
- [x] 提醒按注册结果决定是否点名工具，配对规则写进代码而不是靠人记得；提醒以尾部消息注入，保持 D9 缓存前缀不变。
- [x] 13 项配对/压缩用例 + 2 项措辞用例；runtime 全量 189 项、两个载体探针、离线冒烟通过。
- [x] P2-4 已完成 v4 compaction record 持久化及跨 run/resume；真实命中率复核仍待 P2-5/P2-6。

## 已落地（旧口径历史，当时尚未提交）

- [x] 收口契约三项建议和 Q6。
- [x] HostIo/Exec、TSD helper；bootstrap/catalog/trace 异步迁移。
- [x] 六工具注册表、文件/bash/搜索实现、四档权限、scope/白名单、审批桥接。
- [x] 本机相关 69 项测试、类型检查、P0 离线冒烟、Node 与真实 Electron utilityProcess 探针。
- [x] P1 工具/权限提示词贡献函数供 P2 装配；保留 P2 的已提交实现。

## P1 剩余现场 TODO

- [x] 增加保留进程树根身份的 Node runner；Linux 验证命令先退出后的后代清理。
- [x] Windows 验证 runner + taskkill 的命令树清理：正常/超时/取消/父先退/应用退出五态实测无残留 `node.exe`，见[证据](../../../../Windows-P4-6-evidence/tree-cleanup-five-states.md)。P1-0 该项结清；P1-3 保持进行中。
- [ ] 用真实 Windows 随包 Node 跑 P1-8 六项工具探针与超时/退出检查。
- [ ] 在企业加密机签收工具读写明文、bash stdout 和残留进程检查。
- [x] 旧权限配置导入与两轴 worker RPC 本机回归；仍需 P4 的完整项目/打包链路签收。

## Windows 交回缺陷（2026-09-09，Linux 侧）

来源：[GUI A~E 现场结果](../../../../Windows-P4-6-evidence/gui-a-e-findings.md)。归属 Linux 侧修复或决策；未修完不视为 P4-6 通过。

| 编号 | 严重度 | 问题 | 状态 |
|---|---|---|---|
| F2 | 🔴 | 临时工作区目录消失后无法对话（cwd 缺失被误报为 `node.exe ENOENT`）且无法删除 | 已修复 `dbead94b`，待现场复验 |
| F1 | 🔴 | 设置 → 终端「网络」子项点击报错 | **已修复（本轮）**：`RemoteSettings` 的四处 Field 子部件在 `<Field.Root>` 之外，渲染即抛 `FieldRootContext is missing`，整个网络分类挂掉。非 Windows 特有，Linux 上同样复现。补 `networkPanelMount` 挂载回归测试，待现场复验 |
| F3 | 🟠 | GUI 起 git 子进程 stdout 丢失，分支列表/状态为空 | test.12 现场再次复现（[截图](../../../../Windows-P4-6-evidence/test12-f3-git-branch-error.png)）。**已定性**：载体问题，与 D1 同一个未知量（放行按进程名还是按进程树），[决策文档](../../../plans/2026-09-09-gui-defect-decisions.md#f3--gui-起的-git-子进程输出丢失)。先按现状收，等 D1 的 R2/R3 探针一起拍板 |
| F4 | 🟡 | 503 不重试直接失败（529/429 未触发） | **已定性并修复（本轮）**：native 此前没有自有重试层，跑的是 SDK 默认阶梯。已搬 `createProviderRetryStream` 与错误分类到 `plugins/agent-loop/`——429 一条预算（5 次）、5xx/网络/超时一条（4 次，1s→8s）、`Retry-After` 优先并封顶、内层固定 `maxRetries: 0`；只接管流开始前的失败。31 项测试，[决策文档](../../../plans/2026-09-09-gui-defect-decisions.md#f4--503-不重试直接失败)。待现场复测，F7d 一并复测 |
| F5 | 🟡 | native 会话无提问工具，QuestionCard/扩展问答无法弹卡 | **已定性**：能力缺口非回归——`question.requested` 全仓无生产者，legacy 同样弹不出；native 的扩展 UI 通道是通的（权限卡在用）。建议加 ask 工具但排进 P5-1 批，不阻塞 P4-6，[决策文档](../../../plans/2026-09-09-gui-defect-decisions.md#f5--无提问工具questioncard--扩展问答弹不出来) |
| F6 | 🟡 | 文件修改 diff 为单栏 patch，无左右双栏对比 | 待评估：属形态优化，非功能缺陷 |
| F7 | 🟡 | a 授权详情样式 / b「正在输出」重复显示 / c 卡片尺寸字体 / d GPT 渠道 effort 无效且耗时长 / e 上下文详情需发一句话才显示 / f 输入框增高有限 | 待排期；d 的耗时部分随本轮重试层现场复测，`reasoning_effort` 无效仍待单独排查 |

另有一项与 F 清单同批交回：[旧会话 resume 身份不匹配](../../../../Windows-P4-6-evidence/old-session-resume-error.md)——所有 `runtimeIdentity` 仍指向 v3 文件的会话（本机 20 条）resume 必失败。
**已修复（本轮）**：bootstrap 新增 `sessionSourceFile` 声明转换来源，Main 只在 worker 指名「打开的是所请求文件的转换副本」时接受重定向，随即把索引身份迁到副本上（`adoptRematerializedFile` + `bindRuntimeIdentity`）；来源不匹配或未声明仍报 `worker_resume_identity_mismatch`。三项 WorkerManager 用例 + 一项 runtime 上报用例，待现场复验。

## Windows test.12 现场复验结果（2026-09-09）

来源：[现场报告](../../../../Windows-P4-6-evidence/test12-reverify.md)（提交 `5375e1cd`，仅证据，无产品源码改动）。安装登记与 `app.asar` 均为 `1.0.0-test.12`（EXE FileVersion 元数据仍显示 test.11，原因未定，不据此判定安装失败）。

### 通过项

| 项 | 结果 |
|---|---|
| F1 网络设置面板 | 通过：代理设置与 SSH Profiles 均正常显示，无空白/报错 |
| F2 临时工作区主流程 | 通过：目录删除后可继续对话且目录重建；Close/归档后分组与会话正常，重启后仍在。当前界面无「删除」入口，未代签不存在的操作 |
| 旧 v3 会话 resume | 通过：首次打开后索引指向 v4，92 条消息与原 v3 逐条一致，原 v3 文件未改；重启后再次打开稳定指向同一 `.native-v4.jsonl`，无重复转换 |
| P1-8 六项工具探针 · bundled-node | 通过：read/edit/bash/glob/grep/trace 六项，`carrier=bundled-node`、`node_source=bundled`，node 为安装目录随包 node.exe |
| P1-8 六项工具探针 · electron-utility | 通过：六项，`backend=native`、`carrier=electron-utility`，Electron 39.3.0 / Node 22.21.1 |
| 安装包真实 native worker 冒烟 | 通过：用安装目录的 `resources/agent-host/worker.js` + 随包 Node，read/bash 成功、权限活动有记录、exitCode 0 |
| 加密文本的 GUI/agent 可用性 | 通过（用户现场确认）：文件被其他软件加密后，AiClient 仍可打开修改，agent 读取正常。**未做容器头差分**，不能据此判断是明文还是各进程都被透明解密 |

### 未能签收

| 项 | 原因 |
|---|---|
| F4 重试层现场 | 本轮未自然触发 429/5xx/网络断连，`provider_retry` 记录数为 0，不能签收自动恢复。GPT 单次 run 24.7s 正常完成；用户判断此前慢响应主要与服务器网络有关 |
| R2 / R3 加密载体判定 | 随包 Node 与改名后的 `bash-probe.exe` 都能读到目标文件，但该文件当前字节无 TSD 头，无法区分「文件是明文」与「读取进程都被透明解密」。**驱动按进程名/路径/签名/父进程放行仍未确定**，F3 与 D1 的选项因此都未拍板 |
| R4 无 Bash 探针 | 隔离 harness 没能真正让 shell resolver 进入 `shell_unconfigured`，命令仍可执行，该项无效；现场未移动或禁用系统 Git Bash |
| Main diff / 编码 / 二进制判定 | 桌面探针目录不是 Git 仓库，无 diff 基线；`bmo-m1` 的 Git 面板被 F3 阻断 |
| GUI/TUI 一致性 | 被 TUI-1 阻断 |

### 新交回缺陷

| 编号 | 严重度 | 问题 | 状态 |
|---|---|---|---|
| EFFORT-1 | 🟠 | UI 选 `medium`，平台显示 `none`，trace 里 `thinking_level=off` | **已修复（本轮）**：`nativeWorkerRuntime.startSend` 只传了 model，没传 effort，loop 因此回落到默认 `off`。现改为按 turn 的 effort 优先、bootstrap effort 兜底，两项用例。**另发现待决策**：不选档位时 native 默认 `off`，legacy 由 Pi 取自身默认（`medium`），两条路径不一致 |
| TUI-1 | 🔴 | native v4 会话点开 TUI 报 `Session file is not a valid pi session` | **根因已定（Linux 侧本地复现）**：`pi-coding-agent` 的 `loadEntriesFromFile` 在读完后校验首条 entry 必须是 `type === 'session'` 且 `id` 为字符串，否则返回空数组；我们的 v4 头是 `{kind:'header',version:4,...}`，于是 SessionManager 判为「非空文件但零条目」并抛该错。**不是加密问题**，纯格式边界。需决策，见下 |
| PERM-1 | 🟠 | 切到「自动编辑 / 全自动」后权限卡无法关闭，点击外部与 Esc 均无效 | 待复现（renderer 弹层焦点与关闭事件） |
| F2-a | 🟡 | 实际临时工作区路径与设置中「通用 → 临时工作区」显示的不一致 | 待补两处完整路径后定位 |
| F2-b | 🟠 | 删除 TEMP 分组中单条对话后整个分组不显示，其余对话落到其他工作区；重启后这些对话不再显示 | 待现场取证后定性。读码可知分组由 temp store 的条目驱动（目录没了条目就没了，分组随之消失），而「对话落到其他工作区」说明无主会话有回落归组，但**无法区分是目录被整个删掉、还是仅索引行的 workspacePath 失配**——两者的修法相反，不凭猜 |
| F2-c | 🟠 | 自建目录 `E:\e\test` 结束对话并删除后，resume 报 `Pi worker working directory is missing` | 与 `dbead94b` 修的 cwd 缺失重建**是两条路径**（该错误来自 Main 侧前置校验，不是 spawn ENOENT）；目录是否属于配置的临时根尚未确认 |

### Linux 侧本轮处理（2026-09-10）

| 编号 | 处理 | 提交 |
|---|---|---|
| EFFORT-1 | 已修：`startSend` 现按 turn 的 effort 优先、bootstrap effort 兜底传 `thinkingLevel` | `4145fa65` |
| TUI-1 | **按方案 C 落地**：只按会话文件头判定，确认是 v4 才在入口拒绝并说明原因；读不到/解析不出一律放行；Main 侧在取会话所有权之前同样拒绝 | `0644ba3d` |
| PERM-1 | 已修：权限档按下即关，不再等 worker 回执。D14 返工把 U30 rev.2 的 `closeOnClick` 口径改成了等 await，worker 慢/拒绝时弹层就留着不走 | `1e1e4469` |
| F2-c | 已修文案链路：新增 `workspace_missing` 错误码，给出「恢复原目录或归档会话」两条出路并保留路径。**目录本身不重建**——用户自建目录不该被悄悄重建 | `3bd3f547` |
| F2-a | 已修一类：两个目录种类此前读不同的设置副本（`readSharedSettings` vs `readSettings`），改用户刚改还没落盘时两者会给出不同的根 | `e817fc2a` |
| F7f | 已改：追问输入框上限从 56px（2.3 行）放宽到八行再滚动，用的仍是这条分支自己的 24px 行 | `87f3dc7d` |

### 仍需用户参与的三件事

1. ~~不选档位时的默认思考强度~~ —— **用户 2026-09-10 定为 `medium`，已落地**：`DEFAULT_AGENT_LOOP_CONFIG.defaultThinkingLevel` 从 `off` 改为 `medium`，与 legacy 口径一致（legacy 不传档位、由 Pi 用自身默认）。`off` 仍是调用方可显式要求的档位，只是不再是「未指定」的含义；两项用例分别钉住默认与显式 `off`。
2. **F7b「正在输出」重复显示**：composer 的状态行在 T-31 已不再显示发送时钟（`shouldShowStatusLine` 只看读附件/错误/大附件），所以第二处不在那里。需要现场截图指认第二处的位置才能修，不猜。
3. **F7a / F7c 卡片样式与尺寸**：属视觉口径，需要设计判断而不是代码判断。

### F2-b 下一轮需要采的证据（缺这些无法定性）

删除前后各采一次，顺序照下：

1. 删除**前**：`session-index.json` 中该 TEMP 分组下全部行的 `sessionId` / `workspacePath` / `runtimeIdentity`；该临时目录的 `Get-ChildItem`。
2. 执行删除：记清点的是**哪一级**入口（对话行的删除，还是临时工作区条目的删除——后者的确认文案明确写着会删目录及其内容）。
3. 删除**后**（不重启）：同样三列 + 目录是否还在；界面上「落到其他工作区」的那几条，记下它们在索引里的 `workspacePath` 是否变了。
4. **重启后**：同样三列。若索引行仍在而界面不显示，是渲染层归组问题；若索引行已消失，是主进程删除范围问题。

第 3 步和第 4 步的差异是分叉点：前者改渲染层的回落归组，后者改删除范围。两种修法相反，所以这组数据不能省。

### F7e 定性：预期行为，不是 native 回归

`usage.updated` 由两个后端各自在**轮次结束**时产生（legacy `piWorkerSession.ts:971`、native `projector.ts:289`），resume 本身不产生用量事件。所以重启后未发消息前上下文详情为空，legacy 同样如此。
**可选增强（未开工）**：resume 时按恢复出的消息估算上下文占用并补发一次快照。要点是事件顺序——它必须晚于渲染层认定会话激活，否则被丢弃；因此不是一行改动，单独排期。

### TUI-1 的决策口径（2026-09-10 已选 C）

我们的 v4 由 `pi-agent-core` 的 `JsonlSessionRepo` 读写，互通测试覆盖的也是它；而 GUI 打开 TUI 走的是 `piTuiSession.ts` 的 `pi --session <file>`，那条路径由 **pi-coding-agent 的 SessionManager** 解析，只认旧格式的 `type: 'session'` 头。三个方向：

1. **给 v4 头加 `type: 'session'` 兼容字段** —— 头能过校验，但后续 entry 形状是否被 TUI 正确渲染仍需逐条核对，可能只是把失败推后。
2. **TUI 打开前导出一份旧格式副本** —— 单向可读，TUI 里的写入回不到 GUI 会话，双向一致性做不到。
3. **native 会话暂不提供 TUI 入口**，按能力缺口如实提示 —— 代价是成功标准 6 现场清单里的 GUI/TUI 一致性这条永远签不掉。
4. ~~升级 pi CLI 到能读 v4 的版本~~ —— **已核实不成立，2026-09-10**。

**核实记录（方向 4 被否）**：npm 上最新为 `0.85.1`（我们 pin 0.84.4）。取 0.85.1 的
`dist/core/session-manager.js` 核对：`CURRENT_SESSION_VERSION` 仍是 **3**，头校验仍是
`entry.type !== 'session' || typeof entry.id !== 'string'` 就返回空数组；`dist/core/agent-session.js`
里也没有任何 v4/JsonlSessionRepo 路径。包边界很清楚：**v4 JSONL 属于 `pi-agent-core`
（`dist/harness/session/jsonl/codec.js`），而 `pi` CLI/TUI 属于 `pi-coding-agent`，两者各有一套会话格式**。
升级 CLI 不解决问题，D12 的 pin 也就没有为此松动的理由。

**方向 1 的额外风险（同日核实）**：CLI 看到 `version: 4` 会跳过迁移，所以**打开时不会重写我们的文件**；
但用户一旦在 TUI 里发言，CLI 会往同一文件追加**只有 `type`、没有 `kind` 的旧格式条目**，
而我们的 decoder 遇到未知 kind 直接抛 `unsupported JSONL kind` —— GUI 之后就打不开这个会话了。
所以方向 1 要成立，必须连我们的 reader 一起改成容忍两种条目形状，不是加一个字段那么小。

## 本轮重读确认的要求

- D11：Windows 安装版随包 Node；其他产品路径 electron-utility，独立 Node 探针另列。
- D12：Pi 保持 0.84.4；旧基线 0.84.3 的 patch 差记录为偏差，不回退、不补采。
- D13：Main 用户文件读取统一 TSD-aware，代码与静态复核已完成，驱动现场归 P4-6；Q7 已在本分支由 `b984b282` 修复，现场复测仍待 P4-6。
- D9：缓存门禁为 provider 原始 cacheRead / (input + cacheRead)，不低于旧基线 95.01%；属于 P2/P6，不用本轮 faux 测试代签。
- D14：旧 readonly 迁为 plan + ask，其余分别迁为 agent + ask/accept-edits/auto；goal 本轮不做。

## 验收边界

P1/P4 整体未完成。Linux/CI 不能代签 Windows 或企业加密机。远端 CI 已执行但测试门禁失败，尚未进入打包；P4-5 的事件/reducer 检查不代替真实打包 GUI 现场验收。
D13/Q7 代码已落地，现场复测归 P4-6。P2-5/P2-6 真实模型与缓存对比仍待后续执行。
````

## docs/plantree/plans/gui-sdk-experience/TODO.md

````markdown
# GUI 改进可见 TODO

完整验收前所有产品任务保持未勾选。批次 A → B → C → D，追加 E、F；状态：待调查 / 实施中 / 已实现待验收 / Done。

2026-09-09 Windows 现场执行了 A~E，末列按[现场结果](../../../../Windows-P4-6-evidence/gui-a-e-findings.md)回填。GUI 大项通过，但没有一项达到 Done——加密机未验收，且交回的 F 编号缺陷在 [runtime-evolution 看板](../runtime-evolution/TODO.md#windows-交回缺陷2026-09-09linux-侧)统一跟踪。

| 编号 | 批次 | 任务 | 实现 | 自动化 | GUI | Windows/加密机 |
|---|---|---|---|---|---|---|
| 1 | A | 左栏菜单鼠标与焦点生命周期 | 已实现待验收 | 通过（见 A 证据） | 真实 Electron 鼠标/焦点通过 | Windows 通过；加密机未验收 |
| 2 | A | 终端设置循环更新 | 已实现待验收 | 通过（见 A 证据） | 开发 React 控件通过；完整 GUI 待验 | Windows 部分：进入正常，「网络」子项报错（F1） |
| 7 | A | 文件点击与编辑器挂载/行号 | 已实现待验收 | 通过（见 A 证据） | 真实 React 链路通过；Monaco GUI 待验 | Windows 通过（多样路径 2c 无样本未测） |
| 10 | A | /new 保留目录 | 已实现待验收 | 通过（见 A 证据） | 动作测试通过；完整 GUI 待验 | Windows 部分：被 F2 阻断 |
| 4 | A | 临时目录复用/创建时间及绑定 | 已实现待验收 | 通过（见 A 证据） | 文件系统测试通过；完整 GUI 待验 | Windows 失败（F2）；已修 `dbead94b`，待现场复验 |
| 5 | B | 尾部重试/异常 | 已实现待验收 | 通过（见 B 证据） | 真实时间线 DOM 通过；GUI 待验 | Windows 未触发 529/429；503 直接失败待定性（F4） |
| 6 | B | 真实运行状态/计时/摘要 | 已实现待验收 | 通过（见 B 证据） | 真实状态 DOM 通过；GUI 待验 | Windows 通过；「正在输出」两处重复（F7b） |
| 3 | C | 权限展示降噪 | 已实现待验收 | 通过（见 C 证据） | 真实权限 DOM 通过；GUI 待验 | Windows 部分：无提问工具，授权详情不可展开（F5/F7a） |
| 8 | C | 问答卡布局与交互 | 已实现待验收 | 通过（见 C 证据） | 两种问答 Electron 通过 | Windows 未能测：会话无提问工具，弹不出卡（F5） |
| 11 | D | 原位置丰富上下文用量提示 | 已实现待验收 | 通过（见 D 证据） | Tooltip Electron 通过 | Windows 通过；重启后需发一句话才显示，待定性（F7e） |
| 12 | E | 底部跟随与快速输出滚动 | 已实现待验收 | 通过（见 E 证据） | Electron 真实滚轮/批量输出通过；完整 GUI 待验 | Windows 通过；输入框增高有限（F7f） |
| 9 | C | diff 设置与展开体验 | 已实现待验收 | 通过（见 C 证据） | SDK Edit/真实 DOM 通过；GUI 待验 | Windows 部分：仅单栏 patch，无双栏对比（F6） |

- [x] 读取规范、相关计划，核对起点及他人改动（仅未跟踪截图）。
- [x] A 实施、串行验证、[证据](evidence/batch-a.md)、独立提交（提交号见 git log）。
- [x] B 实施、串行验证、[证据](evidence/batch-b.md)、独立提交；含恢复后过期红框。
- [x] C 实施、串行验证、[证据](evidence/batch-c.md)、独立提交。
- [x] D 追加上下文详情、验证、[独立证据](evidence/batch-d-context.md)和提交。
- [x] E 追加底部跟随、串行验证、[证据](evidence/batch-e-scroll.md)，随最终修正提交。
- [x] 汇总十项及追加项状态与[最小现场验证清单](现场验收清单.md)。

## 追加 F：多工作目录可观察性与死代码清理（2026-09-09）

起因：用户提出「窗口可同时运行不同工作目录的会话」是否有副作用。查实后确认隔离本身没有功能缺陷，真正代价是**非 active 目录的变更完全不可见**——git 状态轮询与 rail 变更点都只跟 active session。顺带查出旧 shell 遗留的一批不可达代码。

| 编号 | 任务 | 实现 | 自动化 | GUI | Windows/加密机 |
|---|---|---|---|---|---|
| 13 | 侧栏目录行显示未提交变更量（复活旧 WorktreePanel 能力，展示按现行 design-system 重做） | 已实现待验收 `4081271f` | 通过（folderDiffStats 14 项） | 待验 | 未验收；加密机受 F3 影响将恒为空，降级为不渲染 |
| 14 | 清理旧 GitView 及其专属组件、全局 git 状态镜像、DiffViewer 永不触发的自动跳转、零引用 hook 与四条无调用方的 git IPC | 已实现待验收 `b75d3e7b` `31ce7705` `253faff1` `88aed3c0` | 通过（全量回归无回退） | 行为零变更，待验 | 未验收 |
| 15 | F2 修复：cwd 缺失校验、已消失目录可删除、临时工作区按原路重建 | 已实现待验收 `dbead94b` | 通过（tempWorkspaceRecovery 9 项 + PiWorkerProcess 5 项） | 待验 | 交回项，待现场复验 |

- [x] 13：数据走已有 `worktreeActivity.diffStats`，不新增 IPC；沿用旧版「只给有会话在跑的目录取、10 秒一次、失焦即停」的拉取策略，并补一次转空闲时的收尾读数。
- [x] 14：四批删除累计约 −1330 行，每批 tsc/vitest/biome 全绿后独立提交。
- [x] 15：三处根因分别修复，详见 [runtime-evolution 看板](../runtime-evolution/TODO.md#windows-交回缺陷2026-09-09linux-侧) F2 行。
- [ ] 13/14/15 的 GUI 与 Windows 现场验收；未验收前不标 Done。

## 提交与最终复查

- A：`8f4b72b0`；B：`7f114608`；C：`9c4ea0e2`；D：`20da96e4`。
- [最终复查](evidence/final-review.md) 随独立修正提交落地（提交号见 git log）。
- 所有产品任务：已实现、分批自动化通过；完整 GUI 与 Windows/加密机未验收，没有标 Done。
````

## docs/plantree/plans/gui-sdk-experience/implementation-status.md

````markdown
# 当前交接

- Current Phase：A/B/C/D/E 与最终复查已实现并提交；2026-09-09 Windows 现场已执行 A~E，结果按组回填 [TODO](TODO.md)。追加批次 F（13/14/15）已实现待验收。
- Next Target：修完 Windows 交回的 F1~F7，并在加密机上按 [现场验收清单](现场验收清单.md) 补齐未签收项。
- Last Landed：A `8f4b72b0`；B `7f114608`；C `9c4ea0e2`；D `20da96e4`；E 与最终修正见 git log。
- Active TODO：Windows 交回缺陷 F1~F7（F2 已修 `dbead94b`）；追加批次 F 的 13/14/15 待现场验收；加密机最小现场清单未开始。未将产品任务标 Done。
- Blocked By：加密机环境未验证；F3 使 GUI 起的 git 子进程丢输出，任务 13 的变更量在该机上恒为空（降级为不渲染）。
- Last Verified：[最终复查](evidence/final-review.md)；[A](evidence/batch-a.md) · [B](evidence/batch-b.md) · [C](evidence/batch-c.md) · [D](evidence/batch-d-context.md) · [E](evidence/batch-e-scroll.md)。
- 分支：当前开发主线 feat/model-catalog-admin，未改旧 main 指针，未推送/发布/触发打包。用户截图保持未跟踪。

2026-09-09 同步 runtime 分支：A～E 已全部引入 `feat/runtime-evolution`，打包候选升级为 `1.0.0-test.11`；提交映射、CI 和 native 接缝见 [P4-6 记录](../runtime-evolution/evidence/p4-6/README.md)。本文件上文描述来源分支历史，最终现场按新的安装包提交签收。

`.11` 已出包：`b6aa0844` / [CI 34308304362](https://github.com/p1p1dan/ai-client/actions/runs/34308304362)，完整门禁 350 文件/4987 项、Windows/Linux 双后端产物通过。Windows 现场从 [交付说明](../runtime-evolution/evidence/p4-6/ci-34308304362/README.md)开始，原现场清单仍未签收。
````

## docs/plantree/plans/runtime-evolution/open-questions.md

````markdown
# 未决问题 — Runtime 自主化演进

只放未解决的问题；解决后移入 ARD 决策并从这里删除。

**目前没有未决问题**（2026-09-09）。Q7 是最后一条，已随下表收口。
新问题按 `| 问题 | 当前证据 | 处理节点 |` 三列另起一张表登记。

已收口：

| 原问题 | 去向 |
|---|---|
| Q1 后端开关暴露在哪一层 | [ARD D8](../../../plans/2026-09-08-runtime-evolution-ard.md) — 仅 dev 环境变量 `AICLIENT_RUNTIME_BACKEND` |
| Q2 缓存命中率基线怎么采 | [ARD D9](../../../plans/2026-09-08-runtime-evolution-ard.md) — 沿用现有公式 + 固定脚本会话提前采基线 |
| Q3 subagent 进程内还是独立 WorkerSlot | [ARD D10](../../../plans/2026-09-08-runtime-evolution-ard.md) — 同进程第二个 Agent；2026-09-09 D10/D17 改为现行完整子系统复刻，旧并发/watchdog 边界已替代，见 [P5-2 契约](topics/p5-2-subagent-contracts.md) |
| Q5 Main 侧裸 `readFile` 读 worker 写的文件会得到什么 | [ARD D13](../../../plans/2026-09-08-runtime-evolution-ard.md) — 2026-09-08 现场坐实为**密文**：加密按文件策略生效，Main 及其派生进程读用户文件得到 `%TSD-Header-###%`。Main 侧统一改走 `readFileTsdSafe` |
| Q4 新旧后端对比用哪一版 Pi 协议依赖 | [ARD D12](../../../plans/2026-09-08-runtime-evolution-ard.md) — 用户拍板「版本影响不大，用新的」：新 runtime 保持 0.84.4，不回退对齐，版本差异在 P2-6 记为已知偏差 |
| Q6 P1-0 非 pipe stdio 范围 | 用户确认先交付 pipe + adapter 挂载点；不自动重跑命令，真实载体验收仍在 P1-8/P4-6，见 [契约](topics/p1-0-host-contracts.md) |
| Q7 `GitService` 在加密机上返回空结果 | 2026-09-09 用户拍板由本分支修，已落 `b984b282`。读码定位到的不是 spawn 参数而是三处判据：`getBranches` 拿 `symbolic-ref` 当「空仓库」判据（它在任何签出分支的仓库上都成功，所以造得出 `(no commits yet)`）、porcelain reader 把「0 退出码 + 没有 `# branch.*` 头」当成功、`truncated` 一个变量兼了条目上限与 15s 超时导致超时不 reject。三处都改为明确失败，`createGitEnv` / `withSafeDirectoryEnv` / `toGitPath` 未动——现场证据里 `getBranches` 那条路径上两条 git 命令都成功了，PATH 与 git.exe 不是原因。6 项测试中四项在修复前失败、修复后通过。**P4-5 的前置因此解除**；加密机上是否还有别的表现，按 [D16](../../../plans/2026-09-08-runtime-evolution-ard.md) 随 P4-6 一次上机复测 |
````
