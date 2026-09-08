# Runtime 自主化演进 — 任务看板

> 决策口径见 [ARD](../../../plans/2026-09-08-runtime-evolution-ard.md)（2026-09-08 已拍板，D1–D14 生效）。
> 本文件只记录执行顺序与进度，不重复决策论证。

**当前阶段**：P0 · 骨架 ✅；P2-0 · 旧后端基线 ✅；P1 主动压缩配对已接通，剩余项全部卡在 Windows 载体与打包 GUI 现场验收；P2/P3 可接续
**最近落地**：`2ae6f209`（2026-09-08）P1-9 ∥ P2-8 成对落地主动压缩（`runtimeContext` 服务、工具注册、提醒措辞、轮次边界换窗）；此前 `27ff2020` 提交 P1 工具/权限实现与 D14 两轴传递链。P1 现场验收仍未完成，[P1 验证记录](evidence/p1/README.md)。P0/P2-0 的提交仍为 `8a71c843`，旧缓存基线 **95.01%**，[原始证据](evidence/p2-0/validation.md)。
**下一目标**：P1 只剩现场验收——Windows 随包 Node 与进程树、打包壳 GUI、真实项目策略；代码侧无待办。本机 [189 项 runtime 回归及两载体探针](evidence/p1/README.md) 已更新；P2 接着做 P2-4（持久化 compaction record）与 P2-5/P2-6（命中率），P3 可并行。
**2026-09-08 权限模型改向**：[ARD D14](../../../plans/2026-09-08-runtime-evolution-ard.md) 两轴分离：模式 `plan/agent` 管工具集，档位 `ask/accept-edits/auto` 管审批，accept-edits 放行工作区 bash。P1-1 裁剪与 P1-5 核心已更新；P1-6 renderer/偏好迁移/两轴传递链已更新，打包 GUI 待签收。
**2026-09-08 现场修订**：加密测试机实测 GUI/TUI 载体差异，[ARD D11](../../../plans/2026-09-08-runtime-evolution-ard.md) 把执行载体定为一等约束（[问题分析报告](../../../../Windows加密环境GUI异常分析.md)）。
影响本看板四处：P1-0（新增，P1 的第一件事）· P3-5（补 Main 侧读一致性）· P4-0/P4-3/P4-6（载体）· P6-3（现场清单）。

状态图例：`⬜ 未开始` · `🟡 进行中` · `✅ 已完成` · `⏸ 挂起` · `❌ 已放弃`

---

## 总览

| 节点 | 主任务 | 前置 | 状态 | 简要内容 |
|---|---|---|---|---|
| **P0** | 骨架 | — | ✅ | `src/runtime/` 落地，离线 + 在线冒烟均通过，风险 R1 关闭 |
| **P1** | 工具与权限 | P0 | 🟡 | plugin-tools（file/bash/search）+ plugin-permissions（scope 白名单 + 审批流） |
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
P4-4 之前要把 PI-Desktop 的 `provider-retry.ts` 搬过来。

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
| P1-7 单测 | ✅ | native runtime 全量 189 项通过，含 Bash/策略专项、D14 UI/存储/旧 worker/IPC/重启回归，以及本轮的配对与压缩执行用例；批次与计数见 [验证记录](evidence/p1/README.md)。载体探针另计，归 P1-8 |
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
| P2-1 提示词分段组装 | 🟡 | 装配机制与 P2-1 自有段已落地：`plugins/prompt/segments.ts`（固定槽位表 + 确定性装配 + `staticPrefixBytes` 供 D9/P2-7 用）、`baseSegments.ts`（identity / collaboration，适配自 PI-Desktop `mode-prompts.ts` 与 `runtime.ts:1330`），16 项单测。**未完**：注册为 Cordis service 需改 `contracts.ts`，该文件本轮归 P1-0，待其落地后补。D14 已改为 `mode` / `permission-gear` 两个 turn 槽位；P1 导出对应贡献函数，goal 本轮不做 |
| P2-2 项目指令注入 | 🟡 | 纯逻辑已落地：`plugins/prompt/projectInstructions.ts` —— 每目录一份（`AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` → `.claude/CLAUDE.md`，先命中先用）、root→leaf 走链使就近文件后出且优先、全局文件（managed + borrowed 两处）排在项目文件之前、32 KiB 预算全链共享且按字符边界截断、realpath 越界即跳过。20 项单测跑在内存源上，无 fixture 目录。**未完**：读盘走 `InstructionSource` 端口，待 P1-0 的 `runtimeHostIo` 提交后接上（约十行适配）；接上后本槽位从 `DEFERRED_SLOTS` 移除 |
| P2-3 压缩策略 | ✅ | 决策层 `plugins/context/budget.ts`（阈值全部由模型窗口推导、硬限触发、保留尾与用户消息上限的双端钳制、两级提醒各只发一次，17 项单测）＋执行层 `plugins/context/compaction.ts`（PI-Desktop 的 Codex 形状：三段合并为一段摘要范围，保留尾只在 turn 未结束时重建为最近一条用户消息并截断，因此不可能产生孤立 toolCall）＋服务 `plugins/context/index.ts`（`runtimeContext`，模型请求与硬限共用一条路径，`summary` 家族发一次模型请求，`fresh_window` 不发）。压缩只换请求上下文，`Agent.state.messages` 不截断。**持久化记录仍是 P2-4** |
| P2-4 compaction record | ⬜ | Rust `transcripts.rs` 的 compaction 读写用 TS 重写。范围已收窄：P2-3 的服务产出的字段就是 `CompactionEntry` 需要的那些（`summary` / `tokensBefore` / `retainedTail` / `usage` / `details`），本节点只负责落盘与跨 run/resume 复用，不改形状 |
| P2-5 缓存命中率达标 | ⬜ | 门禁是 provider 上报的 `cacheRead / (input + cacheRead)`（D9），公式与数据源都已存在，不新增埋点。**已知可优化点**：PI-Desktop 把预算提醒追加进 systemPrompt（`runtime.ts:4160`），那正是缓存前缀本身，一次追加即整段失效；P2-8 已改为尾部消息注入以保持前缀字节不变，本节点用真实命中率复核该选择 |
| P2-6 对比测试 | ⬜ | 新后端跑 P2-0 的同一批脚本会话，比压缩后表现与命中率；协议依赖 0.84.4 vs 基线 0.84.3 的 patch 差按 D12 记为已知偏差，不回退对齐 |
| P2-7 前缀稳定性度量 | ✅ | **可选加强项**，非门禁。`plugins/context/prefixStability.ts`：按块（system / tool / message）位置比对相邻两轮请求，给出公共前缀块数、字节数、占比与**首个冲突位置**——命中率只说miss，这里说 miss 在哪。**只落摘要哈希不落原文**，避免把会话内容写到日志旁。追加与收缩（压缩/回溯）都不算 divergence，用块计数区分形状。13 项单测 |
| P2-8 主动压缩提醒文案 | ✅ | `approachingReminder(remaining, { compactionTool })` 只有拿到已注册的工具名才追加那一句，不传就不提——配对规则因此是机械的，而不是靠人记得。at-limit 档不重复邀请（那时下一次请求必然压缩）。提醒**以尾部消息注入**而非追加 systemPrompt：systemPrompt 就是 D9 计命中率的缓存前缀，Codex 本身也把提醒写进对话历史；位置的实测复核仍归 P2-5 |

**P1-9 ∥ P2-8 为什么必须成对**（2026-09-08 已成对落地，下文保留论证）：默认压缩是被动的——token 越过硬限的那一刻就地压缩，而那一刻落在哪儿全看运气，很可能是多文件改到一半、或刚读完三个文件还没得出结论。模型自己看不到 token 计数，没有任何依据判断「还剩多少」。
PI-Desktop 因此把两件事配成一对：**预算提醒**告诉它还剩多少，**`new_context` 工具**让它选择什么时候承担这次压缩。收益是质量——在语义边界上生成的摘要，比在半步中间生成的丢得少。
任一边单独落地都是坏的：只有工具没有文案，等于没人告诉模型它能用；只有文案没有工具，模型会真的去调并拿到 unknown tool 错误，白费一轮且后续行为不可预测——与提示词槽位表推迟 `tool-protocol` / `tool-guidance` 是同一条理由（文案不能描述当前不存在的能力）。

---

## P3 · 会话与事件 ⬜

前置：P0 · 文件归属：`src/runtime/plugins/session/`、`src/runtime/events/`

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P3-1 JSONL 存储 | ⬜ | 格式与 pi / PI-Desktop 兼容的读写（D6） |
| P3-2 分支与 resume | ⬜ | 分支管理从 PI-Desktop session-context 搬运 |
| P3-3 旧会话兼容 | ⬜ | pi-coding-agent 产生的会话文件仍可读、可 resume（成功标准 5）；旧 tier 值按 [D14](../../../plans/2026-09-08-runtime-evolution-ard.md) 映射迁移（`pragmatic→ask`、`handsoff→accept-edits`、`fullopen→auto`、`readonly→plan+ask`），不得丢弃 |
| P3-4 RuntimeEvent 翻译层 | ⬜ | 参考现有 `piWorkerSession.ts`，翻译目标不变、只换数据源（D5） |
| P3-5 对接 SessionIndexService | ⬜ | Main 层不动，只适配调用面。**跨载体读一致性已定论**（[ARD D13](../../../plans/2026-09-08-runtime-evolution-ard.md)）：加密按文件策略生效，Main 读用户文件得到密文，但会话索引是 Main 自写的 JSON、worker 在白名单内读写会话 JSONL，两者都不受影响；要改的是 `GitService.ts:670` / `:1364` 与 `WorktreeService.ts:648` 的裸读 |
| P3-6 往返测试 | ⬜ | 写入→读取→resume 快照一致性 |

---

## P4 · 集成 ⬜

前置：P1 + P2 + P3

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P4-0 同步平台 worker 改动 | ⬜ | **P4 前置**：把 main 的 `45d43db8`（D20 Windows 随包 Node worker）cherry-pick 进本分支——`PiWorkerProcess.ts` / `WorkerTransport.ts` / `agent-host/worker.ts` + 两个测试 + `packaged-worker-smoke.cjs` / `verify-packaged-app.mjs`。本分支从 `d8b1f521` 分出，不含该提交，当前 worker 代码仍是纯 utilityProcess。ARD 两边分叉编辑，冲突段手工调和（本文件的 D11 已是调和后口径） |
| P4-1 worker bootstrap | ⬜ | `agent-host/worker.js` 的启动模式改为 Cordis 插件图初始化；两种 carrier 共用同一入口 |
| P4-2 后端开关 | ⬜ | dev 环境变量 `AICLIENT_RUNTIME_BACKEND=legacy\|native`（D8），不进设置页；双后端共存 |
| P4-3 WorkerTransport 适配 | ⬜ | 沿用现有 RPC 协议，MessagePort 与 Node IPC 两条通道由 `WorkerTransport` 抹平（D11）；事件出口翻译为 RuntimeEvent |
| P4-4 端到端 | ⬜ | 多轮对话 + 工具调用 + 权限审批 + 压缩全链路（成功标准 1） |
| P4-5 GUI 点验 | ⬜ | 时间线 / Composer / 权限卡 / 设置页无回归（成功标准 4）；另验 D13 的 Main 侧读改造。**前置**：[Q7](open-questions.md) 的 `GitService` 主线缺陷需先修复或明确豁免，否则 git 面板在加密机上本就是空的，点验无从判断 |
| P4-6 打包载体验收 | ⬜ | 在打包壳里用本地模型替身（HTTP SSE stub，不调线上模型）驱动真实 Read/bash，两种 carrier 各跑一遍；复用 runtime 离线 lane 的 `fauxProvider` 用例与 `scripts/packaged-worker-smoke.cjs` 的替身思路 |

---

## P5 · 扩展 ⬜

前置：P4

| 子任务 | 状态 | 简要内容 |
|---|---|---|
| P5-1 plugin-skills | ⬜ | 技能加载 + 模板，路径适配 `~/.pilab` + `~/.agents/` |
| P5-2 plugin-subagent | ⬜ | 同进程第二个 Agent，不占 WorkerSlot（D10）；照搬 ADR 0062/0119 的并发、超时与隔离边界 |
| P5-3 MCP bridge | ⬜ | MCP 工具接入自有工具注册表；stdio server 的进程启动走 P1-0 的 `runtimeExec`，不自建一套 spawn（D11） |
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
