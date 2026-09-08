# Runtime 自主化演进 — 任务看板

> 决策口径见 [ARD](../../../plans/2026-09-08-runtime-evolution-ard.md)（2026-09-08 已拍板，D1–D10 生效）。
> 本文件只记录执行顺序与进度，不重复决策论证。

**当前阶段**：P0 · 骨架 ✅；P2-0 · 旧后端基线 ✅；P1 ∥ P2-1 起 ∥ P3 可开工
**最近落地**：`8a71c843`（2026-09-08）已提交 P0 骨架与 P2-0 六场景基线，缓存命中率 **95.01%**，[验收与证据](evidence/p2-0/validation.md)；P0 的 R1 关闭证据见 [在线冒烟](evidence/p0/live-smoke.md)
**下一目标**：[P1 开工交接](topics/p1-handoff.md)；P2-1 起及 P3 可并行，P2-6 前处理 [Q4 协议依赖版本对齐](open-questions.md)

状态图例：`⬜ 未开始` · `🟡 进行中` · `✅ 已完成` · `⏸ 挂起` · `❌ 已放弃`

---

## 总览

| 节点 | 主任务 | 前置 | 状态 | 简要内容 |
|---|---|---|---|---|
| **P0** | 骨架 | — | ✅ | `src/runtime/` 落地，离线 + 在线冒烟均通过，风险 R1 关闭 |
| **P1** | 工具与权限 | P0 | ⬜ | plugin-tools（file/bash/search）+ plugin-permissions（scope 白名单 + 审批流） |
| **P2** | 上下文与提示词 | P0（P2-0 除外） | 🟡 | P2-0 基线完成；其余 plugin-context / plugin-prompt 任务可接续 |
| **P3** | 会话与事件 | P0 | ⬜ | plugin-session（JSONL + 分支 + resume）+ RuntimeEvent 翻译层 |
| **P4** | 集成 | P1+P2+P3 | ⬜ | worker bootstrap + WorkerSlot 后端开关 + 端到端 + GUI 点验 |
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
| P0-1 依赖落地 | ✅ | `src/runtime/package.json` pin `cordis@4.0.0-rc.9` + `pi-agent-core@0.84.4` + `pi-ai@0.84.4`；P2-0 实测旧 SDK 嵌套依赖为 0.84.3，差异由 Q4 跟踪；根依赖未改，仅增加验证命令 |
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
P4-4 之前要把 PI-Desktop 的 `provider-retry.ts` 搬过来。

**P0 顺带落地的工程规范最小清单**（`docs/agent-project-engineering.md`）：
非 UI 运行入口 §1（`smoke/runOnce.ts`）· 每次运行结构化 trace §2（`trace.ts`，含 D9 需要的原始 usage）·
Happy Path §3 与确定性断言 §4（`smoke/cases/` + `smoke/assertions.ts`）· 特性开关 §6（`flags.ts`）·
版本戳 §15（commit + 依赖 pin + flags）· 失败分类 §14（断言产出 tag）· 空壳门禁 A3。

---

## P1 · 工具与权限 ⬜

前置：P0 · 文件归属：`src/runtime/plugins/tools/`、`src/runtime/plugins/permissions/`

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P1-1 工具注册表 | ⬜ | 工具注册/发现/JSON schema，复用 pi-agent-core `AgentTool` 定义 |
| P1-2 文件工具 | ⬜ | read / write / edit，含路径规范化与大文件截断 |
| P1-3 bash 工具 | ⬜ | cwd、超时、输出截断、进程清理 |
| P1-4 搜索工具 | ⬜ | grep / glob（PI-Desktop Rust `tools/` → TS 重写） |
| P1-5 权限内核 | ⬜ | scope 匹配 + 白名单（`permissions.rs` + ADR 0057/0100 → TS） |
| P1-6 审批流对接 | ⬜ | 复用现有 Extension UI bridge / inline dock 的审批 UI，不改 renderer |
| P1-7 单测 | ⬜ | 工具行为 + scope 匹配矩阵 + 拒绝路径 |

覆盖 ARD 缓解项：首版 5 个工具覆盖 90% 场景。

---

## P2 · 上下文与提示词 🟡

前置：P0（P2-0 除外，可立即开工）· 文件归属：`src/runtime/plugins/context/`、`src/runtime/plugins/prompt/`

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P2-0 现状基线采集 | ✅ | 六个旧后端固定会话通过；28 次普通调用，D9 命中率 **95.01%**；原始会话、来源证明与复核结果已归档，[验收证据](evidence/p2-0/validation.md)（2026-09-08，提交 `8a71c843`） |
| P2-1 提示词分段组装 | ⬜ | 搬运 PI-Desktop `prompt-templates.ts` + `mode-prompts.ts`，去掉 host-core RPC |
| P2-2 项目指令注入 | ⬜ | 本地读取 CLAUDE.md / AGENTS.md 与自有 resource 体系 |
| P2-3 压缩策略 | ⬜ | 原样搬运 PI-Desktop `session-context.ts` + runtime 压缩段策略 |
| P2-4 compaction record | ⬜ | Rust `transcripts.rs` 的 compaction 读写用 TS 重写 |
| P2-5 缓存命中率达标 | ⬜ | 门禁是 provider 上报的 `cacheRead / (input + cacheRead)`（D9），公式与数据源都已存在，不新增埋点 |
| P2-6 对比测试 | ⬜ | 新后端跑 P2-0 的同一批脚本会话，比压缩后表现与命中率 |
| P2-7 前缀稳定性度量 | ⬜ | **可选加强项**，非门禁：落盘每轮请求前缀、比相邻两轮公共前缀占比。PI-Desktop 只展示不优化命中率，此项无参考实现，属自建 |

---

## P3 · 会话与事件 ⬜

前置：P0 · 文件归属：`src/runtime/plugins/session/`、`src/runtime/events/`

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P3-1 JSONL 存储 | ⬜ | 格式与 pi / PI-Desktop 兼容的读写（D6） |
| P3-2 分支与 resume | ⬜ | 分支管理从 PI-Desktop session-context 搬运 |
| P3-3 旧会话兼容 | ⬜ | pi-coding-agent 产生的会话文件仍可读、可 resume（成功标准 5） |
| P3-4 RuntimeEvent 翻译层 | ⬜ | 参考现有 `piWorkerSession.ts`，翻译目标不变、只换数据源（D5） |
| P3-5 对接 SessionIndexService | ⬜ | Main 层不动，只适配调用面 |
| P3-6 往返测试 | ⬜ | 写入→读取→resume 快照一致性 |

---

## P4 · 集成 ⬜

前置：P1 + P2 + P3

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P4-1 worker bootstrap | ⬜ | `agent-host/worker.js` 的启动模式改为 Cordis 插件图初始化 |
| P4-2 后端开关 | ⬜ | dev 环境变量 `AICLIENT_RUNTIME_BACKEND=legacy\|native`（D8），不进设置页；双后端共存 |
| P4-3 MessagePort 通道 | ⬜ | 沿用现有通道，事件出口翻译为 RuntimeEvent |
| P4-4 端到端 | ⬜ | 多轮对话 + 工具调用 + 权限审批 + 压缩全链路（成功标准 1） |
| P4-5 GUI 点验 | ⬜ | 时间线 / Composer / 权限卡 / 设置页无回归（成功标准 4） |

---

## P5 · 扩展 ⬜

前置：P4

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P5-1 plugin-skills | ⬜ | 技能加载 + 模板，路径适配 `~/.pilab` + `~/.agents/` |
| P5-2 plugin-subagent | ⬜ | 同进程第二个 Agent，不占 WorkerSlot（D10）；照搬 ADR 0062/0119 的并发、超时与隔离边界 |
| P5-3 MCP bridge | ⬜ | MCP 工具接入自有工具注册表 |
| P5-4 会话导入适配 | ⬜ | 现有 `LegacyImportService` 适配新 session 插件接口 |
| P5-5 模型目录切源 | ⬜ | 随包快照 + 离线回落从 pi-coding-agent 配置切到自有配置 |

P5-2 的照搬清单（数字取自 PI-Desktop ADR 0062 / 0119，不重新拍）：并发上限 4（信号量）·
报告上限 12k 字符 · 工具白名单默认 `Read/Glob/Grep` 且禁止嵌套 Task · 不继承父会话写权限 ·
按路径 PathMutex 串行化写 · 子行带 `parentToolCallId` 且重建上下文时跳过 · idle + 总时长看门狗 ·
终止收敛为 Task 工具结果。执行入口抽成 `SubagentRunner` service 留进程隔离的后路。
渲染层不用动：`chatSessions.ts:250` 的 `pendingPermissions` 已是带去重的队列。

---

## P6 · 切换 ⬜

前置：P5 + GUI 点验

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P6-1 默认切换 | ⬜ | 新 runtime 设为默认后端 |
| P6-2 摘除依赖 | ⬜ | `@earendil-works/pi-coding-agent` 移出 package.json（成功标准 3） |
| P6-3 达标验证 | ⬜ | 缓存命中率 ≥ 现有水平，五条成功标准逐条签收 |
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

## 维护约定

每完成一个主任务节点（或用户主动触发）更新本文件：改状态图标、更新顶部「当前阶段 / 最近落地 / 下一目标」，落地证据填 commit 号与日期。子任务粒度的进度可随手更新，无需另开状态文件。
