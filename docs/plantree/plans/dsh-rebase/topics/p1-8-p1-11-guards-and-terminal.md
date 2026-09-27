Role: topic

# P1-8 宿主防护与 P1-11 内嵌终端去留：方案与就绪检查

上位：[roadmap P1-8、P1-11](../roadmap.md)。P1-8：防空转、500 轮上限，长会话并发争用做成回归场景；P1-11：内嵌终端去留（[Q003](../open-questions.md)）。两项都是「pi 时代的机制在共享 DSH 宿主里怎么收口」，合并出方案。

依据：
- 决策：[001](../decisions/001-route-b-and-scope.md) 第 5 条（切换后放弃 pi TUI 互通）；[004](../decisions/004-branch-isolated-dsh-only.md)；[005](../decisions/005-legacy-pi-sessions-read-only-until-p1-9.md)；[038](../decisions/038-no-plaintext-key-scope.md) 第 3 条；[050](../decisions/050-migrate-on-first-continue.md)、[051](../decisions/051-migrated-row-keeps-logical-id.md)；[058](../decisions/058-plugins-preinstalled-no-pnpm.md)、[059](../decisions/059-allowlist-verification-and-audits.md)；[063](../decisions/063-drop-pi-extensions-with-notice.md)、[064](../decisions/064-accepted-behavior-differences-extensions.md)；runtime-hardening [决策 040](../../runtime-hardening/decisions/040-main-session-turn-ceiling-with-wrap-up.md)、[042](../../runtime-hardening/decisions/042-delegation-tool-loop-guard.md)。
- 证据与方案：[P0-2](../evidence/p0-2-goal-and-plugins-2026-09-25.md)（社区 TUI 包的准入结果）；[P0-6](../evidence/p0-6-shared-host-2026-09-26.md)（长会话争用、内存）；[P1-1](p1-1-engine-cutover.md) R6；[P1-3](p1-3-shared-host.md) §5 边界、§7 风险；[P1-4](p1-4-bridge-parity.md)（插话在 `step/end` 收尾）；[P1-6](p1-6-permissions.md)（`tools/pre-execute` 闸门）；[P1-9](p1-9-migration.md)；[P1-10 / P1-16](p1-10-p1-16-extensions.md)。

明细分片：[01 内嵌终端现状](p1-8-p1-11-guards-and-terminal/01-terminal-inventory.md) · [02 终端选项与联动](p1-8-p1-11-guards-and-terminal/02-terminal-options.md) · [03 防护：1.0.x 与 DSH 事实](p1-8-p1-11-guards-and-terminal/03-guards-facts.md) · [04 防护插件设计](p1-8-p1-11-guards-and-terminal/04-guards-design.md) · [05 争用回归、测试与改动](p1-8-p1-11-guards-and-terminal/05-regression-tests-changes.md)。

状态：
- 只读调研，基线 worktree HEAD `526ec2e5`（已合入 v1.0.3）。本文引用的文件与 `59758c2b` 逐字相同（`git diff --stat` 核过）。同一 worktree 里 P1-3a、P1-9a 在施工，本文不引用未提交的改动。
- 没有改代码，没有起宿主或 Electron，没有联网，没有调用模型，没有读开发机上的真实用户目录。
- **P1-11 需要用户拍板**（§2.4 的两个问题）。P1-8 的决策点（§4）按工作方式自主决定、待审批。

约定：我方路径省略 `src/`，行号取 `git show 526ec2e5:<路径>`；DSH 路径省略 `src/dsh-host/node_modules/@deepseek-ai/`，版本 `0.1.7-rc.2`。标「推断」的没有运行验证；标「未核实，需联网」的只有离线资料。

## 1 结论先行

1. **P1-11 推荐 A1：DSH 版不再提供 pi TUI，会话栏的 GUI / TUI 开关一起去掉，不另加普通终端入口；在 P1-11 里立即删，不等 P1-12。**
   - 对用户来说，1.0.x 的内嵌终端就是 pi TUI：通用 shell 面板的入口 2026-09-04 已按用户要求撤掉（`5fbc12b2`），只剩「建 worktree 后跑初始化脚本」还会打开它。
   - 本分支上 TUI 已经打不开任何 DSH 会话（P1-1 R6），只剩两种用途：续聊还没迁移的旧 pi 会话；在还没落盘的新会话上另起一个与它无关、也不会被登记的 pi 会话。
   - 留着它的代价分散在五处：P1-9 迁移要先做 TUI 交接；`auth.json` 要继续明文写（决策 038）；pi CLI（`resources/agent-host`）要带过 P1-12；pi 扩展与插件页的 pi CLI 装卸（用户机上联网跑包管理器）要保留（决策 063、058）；pi TUI 不经我方四档与审批卡。
   - 社区 `dsh-tui`（B）离线看不成立：`0.11.0` 要求 `dsh-ptc-runtime-node@0.1.7-rc.1` 和我们树里没有的 `dsh-agent-preset-registry`，P0-2 已按准入规则拒绝；推断它自带宿主，与「不许在我方 `DSH_HOME` 上另起宿主」冲突。版本、维护、与共享宿主的关系都**未核实，需联网**。
   - C（过渡期保留）：合入前删（C1）对用户等同于 A；合入后再删（C2）要先修订决策 001 第 5 条与 004，首个 DSH 版仍带 pi 引擎。
2. **P1-8 推荐新宿主插件 `aiclient-loop-guard`，不写成 bridge 逻辑。**
   - DSH 没有步数上限（`dsh-agent-loop/README.md:202`）。自带的 `repeat-tool-reminder` 只在工具执行之后提醒（第 3 / 5 / 8 次），挡不住「一条回复里几千个调用」；而一条回复里的调用会全部执行（`dsh-agent-loop/lib/index.js:1137-1140`）。
   - 流式阶段**能**中断：包住 `llm/stream` waterfall，发现退化就停止读取（llm-pi-ai 随即取消上游请求），再吐一个终结 `error`。这条回复落成 `assistant/attempt`，不进模型上下文、一个调用都不执行，效果与 1.0.x 的 `stopReason:'error'` 相同。
   - 500 轮上限按 DSH 的 step 计：`agent/pre-step` 计数并在触顶时换入收尾指令；`tools/pre-execute` 拒绝收尾步里的调用（排在 P1-6 的审批之前）；收尾步的 `step/end` 用 hook 取消收尾，与 P1-4 的插话同一机制。
   - 1.0.x 的形态 A（报告送不到造成的空转）根因在 DSH 里不存在（推断），不移植。
   - 1.0.x 的紧急开关 `AICLIENT_RUNTIME_LOOP_GUARD` 会被宿主环境剔除（`main/services/agent-host/DshHostProcess.ts:72`），要显式转发。
3. **长会话争用回归**：软门槛取 P0-6 × 1.3～1.5，只告警；硬门槛取「用户能感知的冻结」与「4 个 native worker 的内存」（ELD ≤ 1 s、RSS ≤ 600 MB）。观测用 pong 的 `eldMaxMs` / `rssMb`。与 P1-4e 共用 `dsh-bridge-gate.yml`，推分支前要用户确认。
4. **规模**：P1-11（A1）约 0.5～1 人周，删产品约 2.5k 行、测试约 2.7k 行；P1-8 约 1.5～2 人周（粗估），切成 P1-8a～d。

## 2 P1-11 内嵌终端（明细见分片 01、02）

### 2.1 1.0.x 的内嵌终端做了什么

| 功能 | 做法 | 依据 |
|---|---|---|
| 入口 | 会话栏 GUI / TUI 分段按钮（有目录或是临时会话才显示）；TUI 模式下聊天列换成终端；`presentationMode` 是全局设置 | `renderer/components/workspace-shell/SessionBar.tsx:67-72,191-205`；`renderer/components/chat/ChatWorkspace.tsx:256-279` |
| 普通 shell | `PtyManager` + `TerminalPanel`，与 pi TUI 完全独立；顶栏按钮、Ctrl/Cmd+`、rail 入口 09-04 已撤 | `renderer/components/workspace-shell/surfaceRegistry.ts:144-161`；`renderer/hooks/useWorktree.ts:170` |
| pi TUI | 随包 pi CLI（`pi-coding-agent@0.84.3`）在 node-pty 里跑，打包态用随包 node | `agent-host/package.json:12-15`；`main/services/terminal/PiTuiPty.ts:131-201` |
| 模型与凭据 | `PI_CODING_AGENT_DIR` 指向 `<agentDir>`，pi 读 `models.json` 与明文 `auth.json`（0600）；保管箱一变就为 TUI 重写 `auth.json` | `PiTuiPty.ts:163-184`；`main/services/piModelConfig/index.ts:356-397`；`PiModelConfigService.ts:674-675`；`auth/managedCredentialsStartup.ts:92-96,145` |
| 续聊与交接 | `pi --session <file>` 续同一个 JSONL；进程级与跨窗口两把锁、在飞回合检查；GUI 发送 / 重试 / 压缩 / 回退前先 `handOverFromTui`，必要时 worker `reload` | `terminal/piTuiSession.ts:60-131,167-268`；`main/ipc/piTui.ts:365-461,538-563`；`main/ipc/chat.ts:180-229` |
| `/new` 会话 | 终端退出后扫目录，把 pi 新建的会话登记成 `agent: pi` 行 | `main/ipc/piTui.ts:187-263` |
| pi 扩展 | 只有 TUI 加载；插件页的装 / 卸 / 列也跑 pi CLI，`install` 访问 npm | `main/services/piPlugins/index.ts:19-29,111-141`；`PiPluginService.ts:231-265` |
| 权限 | 不经四档与审批卡；没声明权限扩展时按 pi 自己的默认执行（推断：不逐次审批） | `shared/piPlugins.ts:36-50` |

- 这是 1.0.x 的高维护面：runtime-hardening 的 T003（交叉写入后会话永久打不开）、T048、T065（两窗口静默分叉、切回白屏）、T082、T086 都在修它。
- 本分支：`.dsh.json` 一律拒绝（`piTuiSession.ts:295-316`，GUI 点验见 [p1-1-gui](../evidence/p1-1-gui-2026-09-26.md) 第 4 项）。

### 2.2 选项与代价（逐项联动见分片 02）

| | A 只当普通终端，去掉 pi TUI | B 接入社区 `dsh-tui` | C 过渡期保留 pi TUI，只开未迁移旧会话 |
|---|---|---|---|
| 对 1.0.x 用户 | 失去 TUI 与终端里的 pi 扩展；旧会话在 GUI 继续（首次继续时迁移）；回装 1.0.x 全部回来 | 换一套界面与命令；pi 扩展同样失效；旧会话推断要先迁移才能打开 | 旧会话可在 TUI 续聊到迁移为止；新会话点 TUI 被拒，按钮时灵时不灵；C2 以后还要再移除一次 |
| P1-9（050、051） | 迁移不用做 TUI 交接 | dsh-tui 若在我方宿主之外写会话，要新的交接协议 | 迁移前先让 TUI 交出文件；TUI 续聊会让逻辑会话进入「有新内容」的分叉态（051 第 2 条） |
| P1-12 | pi CLI 随 `resources/agent-host` 整体删 | pi CLI 照删；dsh-tui 及依赖进包，计入 128 MiB | 要留 pi CLI 产物与相关测试，P1-12 的「删 pi TUI 互通」要改写 |
| 决策 038 | P1-15 之后即可停写 `auth.json`、`models.json` | 自带宿主时要另给凭据（推断） | 明文 `auth.json` 留到删 TUI 为止 |
| 决策 063 | 按现文：不再加载，只读列出 | 同 A | 改为 B：TUI 里照常加载，插件页保留联网装卸 |
| 工作量 | 约 0.5～1 人周，以删除为主 | 推断 3～5 人周以上，外加上游不可控 | 现在近 0；P1-9d 交接约 0.5 天、P1-12 拆 pi CLI 产物约 1～2 天（推断）；日后再删同 A |
| 安全 / 白名单 | 去掉一条不经白名单、不经审批的执行路径 | 第三方非官方 scope，按决策 059 全审；同类包带红线；与宿主同进程则同权 | 保留 npm 任意 pi 扩展、pi 默认权限、明文 key |

### 2.3 推荐与理由

- **推荐 A1**：去掉 pi TUI 与 GUI / TUI 开关，不加新的终端入口。A2 是把开关改成「在会话目录开普通 shell」，约多 1 天；用户 09-04 刚撤掉顶栏终端按钮，所以不推荐。
- 理由：
  - 与已批准的方向一致：决策 001 第 5 条「切换后放弃 pi TUI 互通」，决策 004「合入后只有一个引擎」，roadmap P1-12「删 pi TUI 互通」。
  - 本分支上 TUI 剩下的价值只覆盖「迁移之前的旧会话」，而 P1-9 的「首次继续时迁移」正好接住这批会话。
  - 早删能让 P1-9d、P1-5e、P1-10c 都不做 TUI 特判，「key 不以明文落盘」也能真正闭环。
  - B 的前提（兼容 rc.2、共享宿主、审查通过）现在一个都不满足，记入想法池，合入后与 L2 / P3 一起再议。
- 代价：用 TUI 的用户（人数未知，没有遥测）会失去它；分支上旧会话在 P1-9 之前完全不能续聊（只影响自测，决策 005）；发版说明加一条行为差异，接在决策 064 的清单后面；回装 1.0.x 可退回。
- 落地（退出判据「用户拍板并落地」）：P1-11a～c 合入；静态守卫证明产品里没有 pi TUI；老设置 `presentationMode: 'tui'` 读出为 GUI；GUI 点验看不到开关。

### 2.4 转给用户的问题（原文）

> 1. DSH 版里，内嵌终端的 pi 助手（TUI）去掉，会话栏的 GUI / TUI 切换一起去掉，可以吗？旧会话在 GUI 里继续（第一次继续时自动转成 DSH 格式）；还想用 pi 的，可以回装 1.0.x 或自己装 pi。
> 2. 去掉之后，原来 TUI 按钮的位置要不要换成一个普通命令行终端（在该会话的目录里开 shell）？您 9 月 4 日让撤掉过顶栏的终端按钮，所以我建议不加。

## 3 P1-8 宿主防护（明细见分片 03、04、05）

### 3.1 1.0.x 与 DSH 的对照

| 项 | 1.0.x | DSH `0.1.7-rc.2` | 处理 |
|---|---|---|---|
| 轮数上限 | 一次发送最多 500 个 assistant 轮，子代理回报的续跑计入同一计数；触顶后等子代理回报，给一轮禁用工具的收尾，结局是完成（`stopCause:'turn_limit'`）（`runtime/plugins/agent-loop/index.ts:212-305,827-877,1334-1336`） | 没有回合 / 步数预算（`dsh-agent-loop/README.md:202`）；goal 另有 256 轮上限 | 规则 C 补上 |
| 单条回复内退化（形态 B） | 包在 `streamFn` 外，子代理工具族同一调用第 3 次或族内超过 16 个即掐断，回复以 error 结束、不执行、不进上下文（`agent-loop/delegationLoopGuard.ts:50-86,209-310`） | `repeat-tool-reminder` 只在执行之后提醒（`dsh-repeat-tool-reminder/README.md:12,74-87`）；一条回复的调用全部执行 | 规则 B 挂 `llm/stream` |
| 跨回复空转（形态 A） | 连续 2 条回复全是空调用就收尾（`delegationLoopGuard.ts:73-83`） | 完成通知主动推送，`job_output` 结束后首读带回结果（`dsh-tool-jobs/README.md:32,40`） | 不移植（推断根因不在），提醒与规则 C 兜底 |
| 唤醒链 | 回报续跑计入同一计数 | jobs 的唤醒默认无上限（`dsh-tool-jobs/README.md:42`） | 计数不因唤醒清零 |
| 紧急开关 | `AICLIENT_RUNTIME_LOOP_GUARD=0` 只关拦截（`runtime/flags.ts:82,113-115`） | 无；宿主环境剔除 `AICLIENT_*` | 显式转发 |

触发事件：glm-5.2 一条回复 5709 个调用，流了约 19 分钟，零执行，usage 记 0（决策 042 背景；T125 未修）。

### 3.2 流式阶段能否中断（DSH 源码事实）

- `llm/stream` 是 waterfall，插件能包住整条 chunk 流（`dsh-llm/lib/index.js:2365-2372`）；loop 发的请求可用 `isAgentLoopRequest` 认出（`:377-388`）；`block-end` 带完整的 `tool-call` 块（`dsh-llm/lib/types/types.d.ts:85-92,409-447`）。
- 停止读取时 llm-pi-ai 调 `consumer.abort()` 取消上游请求（`dsh-llm-pi-ai/lib/index.js:1897-1911`）。
- 包装层吐终结 `error`：loop 落 `assistant/attempt` → `agent/request-error` → 没人要求重试就 `turn/end error`，一个调用都不执行（`dsh-agent-loop/lib/index.js:1101-1120`）。
- 对照 `agent.cancel()`：已流出的正文作为 `interrupted` 消息进上下文、工具调用被丢、整个回合结束（`:1066-1090`；`dsh-agent/README.md:178`），不适合掐退化回复。

### 3.3 方案要点（明细见分片 04）

- **形态**：宿主插件行 `aiclient-loop-guard`，bridge 硬依赖，启动期审计列为必须启用。子代理、goal 回合、job 唤醒都不经 bridge RPC；共享宿主里一个失控会话会拖累全部（P1-3 方案 §5）。bridge 只做结果映射（P1-4d）。
- **规则 B（流式掐断）**：只管 loop 请求，主会话与子代理都管；在 `block-end` 判 `tool-call`，阈值与规范化照搬 1.0.x，工具族换成 DSH 名（`subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`、`job_output`、`job_list`、`job_kill`，加决策 062 的委派工具）。触发后停止读取、吐终结 error（码 `tool_call_repetition`），并在 `agent/request-error` 上拦下这个码，防止 always 重试。界面沿用 1.0.x 的失败卡。
- **规则 C（500 轮上限）**：
  - 计什么：DSH 的 step（一次模型请求加它的工具批），等于 1.0.x 的一个 assistant 轮；同一步里的重试不另算。每个 agent 一个计数器，子代理也用 500 兜底，定义里的 `maxTurns` 归 P1-16d。
  - 何时清零：claim 到来源为 `user` 的消息（发送、插话）、我方的重试续跑（决策 028）或 goal 回合消息；job 完成通知不清零。
  - 触顶：第 501 步的 `agent/pre-step` 返回 `enter`，消息为「claim 到的消息 + 1.0.x 原文的收尾指令」（来源 `aiclient-loop-guard`，投影时隐藏）；收尾步里的调用在 `tools/pre-execute` 被拒且不出卡；收尾步的 `step/end` 上 `cancel({kind:'hook', reason:'aiclient-turn-ceiling'}, {keepInbox:true})`；bridge 映射成 `session.completed {stopCause:'turn_limit'}`，界面沿用 `TurnCeilingNotice`。
  - 触顶后、下一条用户消息前，job 通知开的新回合直接按收尾步处理，额外请求数不超过触顶时仍在跑的后台任务数（推断）。1.0.x 是等全部回报后合成一次收尾，这是一条行为差异。
- **与 P1-6 的关系**：P1-6 的 pre-execute 判断「这一个调用能否执行」，发生在整条回复流完之后，那时 token 已付、`tool/call` 已落盘，所以退化回复只能在流阶段掐。收尾拒绝必须先于审批：推荐 P1-6b 的 `aiclient-permissions` 在调 `gate.authorize()`（`shared/permissions/gate.ts:646`）之前先问守卫服务，不靠监听者注册顺序。
- **开关**：`AICLIENT_RUNTIME_LOOP_GUARD=0` 只关规则 B；`DshHostProcess` 像开发网关变量那样显式转发它（`:86,196-201`）。

### 3.4 长会话争用回归（明细见分片 05）

- 基线（P0-6，Linux 开发机 2 核 / 3.3 GB，ELD 已减 10 ms）：空闲 RSS 约 180 MB；8 个普通会话错开开跑，ELD 单次最大 21 ms、RSS 峰值 199 MB；4 个 2000 条会话同时请求，ELD 最大 192～291 ms、RSS 峰值 341 MB。
- 观测：pong 的 `eldMaxMs`（上次 pong 以来的最坏值）与 `rssMb`（`shared/types/dshHostProtocol.ts:110-119`）；supervisor 在 ELD 超 200 ms、pong 往返超 2 s 时告警（`main/services/agent-host/DshHostSupervisor.ts:76-79,644-671`）。宿主侧 pong 由 P1-3a 实现，落地时核对 ELD 是否也扣掉 10 ms。
- 场景：LC-0 空闲；LC-1 8 个普通会话；LC-2 4 个 2000 条会话（关压缩，最坏）同时请求，另有 1 个流式会话当受害者；LC-3 同 LC-2 开压缩；LC-4 10 个长会话的容量与 `MALLOC_ARENA_MAX` 对照。历史用 `seedSession` 合成，不真跑 500 轮。
- 门槛：硬门槛失败即红（LC-2：ELD ≤ 1 s、受害者最大 delta 间隔 ≤ ELD + 150 ms、RSS ≤ 600 MB、没有判卡死）；软门槛只写进步骤摘要，跑满 5 次后收紧。
- 进 CI：LC-0～LC-2 与防护场景每次推送都跑，LC-3、LC-4 手动触发。

## 4 需要拍板的决策点

| # | 决策 | 选项 | 推荐 | 理由 | 代价 |
|---|---|---|---|---|---|
| **D1** | **内嵌终端去留（用户拍板）** | A 去掉 pi TUI；B 社区 dsh-tui；C1 保留到合入前；C2 保留到合入后 | A | §2.3 | TUI 用户失去它；回装可退 |
| **D2** | **去掉后的入口（用户拍板）** | A1 去掉开关、不加入口；A2 开关改成普通 shell | A1 | 用户 09-04 撤掉过终端按钮 | 想在会话目录开终端的用户没有入口 |
| D3 | 删除时点 | 在 P1-11 立即删；等 P1-12 | 立即删 | P1-9d、P1-5e、P1-10c 不做 TUI 特判 | 分支上旧会话在 P1-9 前完全不能续聊 |
| D4 | 防护放哪 | A 宿主插件；B bridge 逻辑；C 并入 `aiclient-permissions` | A | 覆盖子代理、goal、唤醒；可单测 | 多一行 bundle，启动审计加一项 |
| D5 | 流式掐断挂点 | A 包 `llm/stream`；B 听 `agent/assistant-stream` 再 `agent.cancel()`；C 只在 pre-execute 拒绝 | A | 不执行、不进上下文、上游取消，与 1.0.x 等价 | 依赖 chunk 协议，靠钉版本与场景兜住。B 把已流出正文带进上下文并结束整个回合；C 要付整条回复的 token，且 `tool/call` 已落盘 |
| D6 | 掐断范围 | A 沿用决策 042，只管子代理 / job 工具族；B 另加通用总量闸（任何工具单条回复超过 64 个即掐） | A，B 可选 | 042 为控制误报限定了范围 | B 超出用户 09-24 拍板的范围，要用户点头 |
| D7 | 500 轮怎么计 | A 按 step、按 agent，用户消息 / 重试续跑 / goal 回合开新纪元，唤醒不清零；B 按 DSH turn；C 按会话生命周期 | A | 对齐 1.0.x「一次发送」「回报续跑计入同一计数」；堵住唤醒链 | B 让唤醒链绕过上限；C 长会话迟早撞顶 |
| D8 | 触顶怎么收 | A 收尾步 + 拒工具 + `step/end` hook 取消；B `pre-step` reject；C 直接取消、不收尾 | A | 沿用决策 040；与 P1-4 插话同一机制；不丢收件箱 | 触顶后每个 job 通知多一次无工具回复。B 丢 claim 的消息、`blocked` 含义含糊；C 回到旧 64 轮上限「页面停在工具行」的问题 |
| D9 | 形态 A | A 不移植；B 移植到 `job_*` / `list_agents` | A | 根因不在（推断），有提醒与规则 C 兜底 | 现场若出现要再补 |
| D10 | 回归门槛 | A 硬门槛每次推送、软门槛只告警、LC-3 / LC-4 手动；B 全部硬门槛；C 只手动跑 | A | CI runner 规格未核实，时间类指标会抖 | 软门槛发现的退化要人看摘要 |

D1、D2 转给用户；D3～D10 按工作方式各写一份决策，标「自主决定，待用户审批」（编号由编排器分配）。D6 若选 B、D8 的行为差异若用户不接受，要单独确认。

## 5 改动清单与切分（逐文件见分片 05 §8）

| 子任务 | 内容 | 产品 / 测试（行，粗估） | 依赖 |
|---|---|---|---|
| P1-11a Main | 删 TUI 服务、IPC、交接与 `reload` 入口；登出 / 关窗 / 退出路径去掉 TUI | 删约 1.9k，改约 60 | D1、D2 |
| P1-11b 渲染层 | 删开关与 TUI 视图；`presentationMode` 迁成 gui；文案 | 删约 600，改约 80 | a |
| P1-11c 测试与说明 | 删 TUI 测试；更新静态测试；新守卫；发版说明 | 删约 2.7k，新增约 200 | a、b |
| P1-8a 流式掐断与开关 | 纯函数跟踪器、`llm/stream` 包装、`request-error` 拦截、开关转发、共享常量 `shared/runGuards.ts` | 350 / 450 | 纯函数现在就能做；接线在 P1-3a 之后 |
| P1-8b 500 轮上限 | 计数纪元、收尾步、pre-execute 拒绝、`step/end` 收尾；与 P1-6b、P1-4d 的接口 | 300 / 500 | P1-4c 的 `step/end` 实验、P1-6b、P1-4d |
| P1-8c 争用回归与 CI | 驱动脚本、P8 假网关场景、门槛、CI 步骤 | 450 / 50 | P1-3a 的 pong；P1-4e 的 CI 骨架 |
| P1-8d（可选）内存与上游 | `MALLOC_ARENA_MAX`、堆参数对照；同步 spawn 的上游问题草稿（提交与否由用户定） | 约 20 | c |

- 顺序：P1-11 在 P1-9d 之前；之后 P1-5e 停写 `auth.json` / `models.json`（还要等 P1-15），P1-10c 插件页改为只读列出，P1-12 整体删 `resources/agent-host`。P1-8a 的纯函数可与 P1-11 马上并行；跑测试的并行代理不超过 2 个。
- 边界：P1-4d 负责 `turn/end` 映射与历史投影；P1-6b 负责审批前置查询；P1-7 不需要新界面；P1-16d 负责子代理定义里的 `maxTurns`。

## 6 测试方案（明细见分片 05）

- **单测（根 vitest，假 ctx，不装 DSH）**：1.0.x `subagentLoopGuard.test.ts` 的规则用例换成 DSH 工具名照搬；`llm/stream` 包装吃合成 chunk，断言触发时关了下游、只吐一个 finish；计数纪元、收尾步、pre-execute 拒绝、`request-error` 拦截、开关；静态守卫：宿主环境转发开关、bundle 有 `aiclient-loop-guard` 行且必须启用。
- **真宿主场景（假网关，Linux CI）**：G1 退化回复被掐；G2 族内超 16 个；G3 10 个不同任务的扇出不掐；G4 小上限下的收尾；G5 计数纪元；G6 开关；G7 子代理里的退化；加 LC-0～LC-2。
- **P1-11**：新静态守卫（产品代码里没有 `piTui` IPC、`PiTuiPty`、pi CLI 路径）；设置迁移用例；改写登出顺序用例；GUI 点验看不到开关、老设置落在 GUI。
- **GUI 点验**（功能完成之后）：开发态用小上限看提示条与「继续」；退化回复的失败卡。

## 7 风险与未覆盖

- **开工前实验**（明细见分片 04 §7）：E1 终结 error 落 attempt、不执行、两种重试模式下都不重试；E2 上游真的被断开；E3 子代理请求经过同一 `llm/stream` 与 `pre-step`；E4 `step/end` 同步取消（与 P1-4c 合做）；E5 收尾拒绝不出审批卡（与 P1-6b 合做）；E6 触顶后 job 通知的额外请求有界、claim 的通知不丢；E7 `seedSession` 合成 4 个 2000 条会话的耗时。
- **dsh-tui 全部未核实，需联网**：当前版本、维护者与发版节奏、是否自带宿主、会话能否与 GUI 互通、审查结论。本文只用了 P0-2 的离线目录数据。
- **DSH 升级**：chunk 协议、钩子名、`isAgentLoopRequest` 的语义都可能变；靠钉版本、G 场景与升级时重跑兜住。
- **CI 抖动**：runner 规格未核实（仓库公开时 4 核 16 GB、私有时 2 核 7 GB，推断），时间类门槛先记录再收紧；推分支要用户确认。
- **行为差异**（发版说明）：内嵌 pi 终端移除；触顶后每个后台完成通知各得一次无工具回复，而不是合成一次收尾；跨回复空转不再单独拦截；宿主重启后计数清零；goal 每个回合各自 500 步。
- **没能确认**：pi CLI 默认是否完全不审批（推断，没跑）；TUI 与 pi 扩展的实际用户量（没有遥测，没读真实用户目录）；开着自动压缩时长会话争用的实际大小；10 个长会话时的内存上限与 OOM 连坐（LC-4 补）。
- **本文没有改** roadmap、看板、决策与 README 的文件地图，需要编排器登记本方案并按 §4 写决策。
