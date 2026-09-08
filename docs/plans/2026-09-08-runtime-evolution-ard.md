# Runtime 自主化演进 — 架构需求文档（ARD）

> 文档日期：2026-09-08
> 文档状态：**已拍板**（2026-09-08 用户确认，D1–D13 生效）· 执行看板见 [plantree](../plantree/plans/runtime-evolution/README.md)
> 2026-09-08 现场修订：加密测试机实测推翻「按实现语言判断兼容性」的旧结论，
> 执行载体上升为一等约束（新增 [D11](#d11--执行载体按进程身份区分不按实现语言推断)，
> 同时改写 D4、§6、§8）。取证见[问题分析报告](../../Windows加密环境GUI异常分析.md)。
> 触发：用户确定产品进化路线 ai-client → PI-Desktop 形态 → DSH 形态，
> 核心诉求「内部产品，除协议适配层外其余尽可能可控、方便修改和插入」。
> 前序调研：[PI-Desktop 调研档](./2026-09-08-pi-desktop-study.md) ·
> [DSH 调研档](./2026-08-18-deepseek-harness-study.md)

## 1. 一句话定义

将当前对 `pi-coding-agent` 整包依赖替换为**自有 runtime**：
以 Cordis 为插件内核、`pi-ai` 为唯一外部协议层，
自建 agent loop / 工具注册执行 / 权限 / 上下文压缩 / prompt 组装 / 会话存储，
以插件形式组织各能力模块，在现有 Electron 壳和 WorkerManager 拓扑上运行。

## 2. 当前架构 vs 目标架构

### 2.1 当前

```text
Renderer → Preload → Main WorkerManager → WorkerSlot
  → 平台 worker（Windows 安装版：随包 Node；其余：utilityProcess）→ 整包加载 pi-coding-agent
  → Pi AgentSession（黑盒：agent loop + tools + 权限 + 压缩 + prompt + 会话 全在里面）
  → 事件投影为 RuntimeEvent → Main 路由 → renderer reduce
```

**不可控**：agent loop、工具执行、权限体系、上下文压缩策略、系统提示词组装、会话存储格式。

### 2.2 目标

```text
Renderer → Preload → Main WorkerManager → WorkerSlot
  → 平台 worker（Windows 安装版：随包 Node；其余：utilityProcess）→ 自有 runtime（Cordis 插件图）
    ├─ plugin-model-adapter    ← pi-ai（唯一外部依赖，协议适配）
    ├─ plugin-agent-loop       ← 自建，tool→model→tool 循环
    ├─ plugin-tools            ← 自建，文件/shell/搜索/MCP bridge
    ├─ plugin-permissions      ← 自建，scope 白名单 + 审批流
    ├─ plugin-context          ← 自建，压缩策略 + 缓存命中率优化
    ├─ plugin-prompt           ← 自建，系统提示词分段组装
    ├─ plugin-session          ← 自建，JSONL 存储 + 分支 + 导入
    ├─ plugin-skills           ← 自建，技能加载 + 模板
    └─ plugin-subagent         ← 自建，子代理生命周期
  → 事件投影为 RuntimeEvent（接口不变）→ Main 路由 → renderer reduce
```

**关键约束**：renderer 和 Main 层基本不动，新 runtime 只替换 WorkerSlot 内部的引擎。
对外暴露的 RuntimeEvent 接口保持兼容，UI 无感切换。

## 3. 技术决策

### D1 · 插件内核：采用 Cordis

MIT 协议，69KB，两个依赖。DSH 已验证可承载完整 agent runtime。
作为完整框架使用，不预先排除任何能力——依赖图解析、生命周期管理、service 注入是基础；
热插拔在开发调试阶段有价值（改工具定义不用重启 app）；Fork/Isolate 上下文自动执行
插件间 service 接口隔离纪律；响应式属性用于 worker 内插件间状态传播（如权限配置变更
→ 工具注册表更新）；动态 scope 为后续场景（测试 mock、按会话差异化策略）保留空间。

### D2 · 协议层：只保留 pi-ai

`@earendil-works/pi-ai` 负责 provider 差异抹平、模型目录发现、流式响应统一、
工具定义格式翻译、上下文溢出判定。
**移除 `pi-coding-agent` 整包依赖。**

### D3 · agent loop 原语：保留 pi-agent-core（选项 A）

三个 pi 包（`pi-ai` / `pi-agent-core` / `pi-coding-agent`）同一作者（Mario Zechner）、
同一仓库 `earendil-works/pi`、全 MIT。层级：

```text
pi-ai          → 协议适配（provider 差异抹平、模型目录、流式）
pi-agent-core  → agent 原语（循环 runner、状态管理、传输抽象、token 估算、消息类型）
pi-coding-agent→ 完整 coding agent CLI（工具 + 权限 + prompt + 会话 + skills + 压缩）
```

**决策：保留 `pi-agent-core`，移除 `pi-coding-agent`。** 与 PI-Desktop 同构。

理由：
1. `pi-agent-core` 提供的是**机械件**（`Agent` 循环 runner、`AgentEvent/AgentTool` 类型、
   `convertToLlm` 消息转换、`estimateTokens` token 估算、`createCompactionSummaryMessage`
   压缩辅助）——不含策略，不限制可控性。
2. PI-Desktop 已验证此分层：用 `pi-agent-core` 的 `Agent` 类跑 loop，
   工具/权限/压缩/prompt/会话全部自建，完全可控。
3. 减少自建量：token 估算、消息格式转换、事件类型定义不值得从零写。
4. 退出成本低：后续若 `pi-agent-core` breaking change 频繁，替换循环驱动是局部改动
   （此时自有 runtime 已完整运行，只是换一个 loop runner）。

依赖链最终态：`pi-agent-core`（循环原语 + 类型）+ `pi-ai`（协议适配），其余全部自建。

### D4 · 进程拓扑：一槽一隔离进程不变，载体按平台分两种

保持「一个 WorkerSlot = 一个隔离进程 = 一个 AgentSession」，WorkerManager/WorkerSlot 的
ownership、generation、崩溃隔离逻辑不动。**但载体不再固定是 `utilityProcess`**：
Windows 安装版使用随包 Node + 原生 IPC，其余平台与开发模式使用 utilityProcess + MessagePort，
由 `WorkerTransport` 适配同一套 RPC 协议。新 runtime 在 worker 进程内初始化 Cordis 插件图，
对载体无感——具体约束见 D11。

### D5 · 事件接口：保持 RuntimeEvent 兼容

新 runtime 内部事件格式自定，但出口处翻译为现有 `RuntimeEvent`，
renderer 的 Zustand store 和时间线渲染零改动。后续可逐步扩展 RuntimeEvent 字段。

### D6 · 会话存储：自有 JSONL + 现有 session-index

沿用 JSONL 格式（与 pi/PI-Desktop 兼容），但由自有 `plugin-session` 读写。
`SessionIndexService` 保持在 Main 层不动。
旧 pi-coding-agent 产生的会话文件通过兼容读取保持可访问。

### D7 · 凭据：复用现有 ~/.pilab/<profile>/

凭据体系不动。`plugin-model-adapter` 从现有 credential vault 读取 API key，
通过 pi-ai 的 `ModelAuth` 接口注入。

### D8 · 后端开关：仅 dev 环境变量

`AICLIENT_RUNTIME_BACKEND=legacy|native`，与现有 `AICLIENT_PI_WORKER_CAPACITY`
（`src/main/services/agent-host/WorkerManager.ts:271`）同族命名，启动时读取。
**不进设置页**：切换完成后这个开关就没有用户价值，P6-1 默认切到 native 后连开关一起删除，
只保留一个版本周期的回退窗口。

### D9 · 缓存命中率：沿用现有公式，用固定脚本会话采基线

**公式不变**：`cacheRead / (input + cacheRead)`，cacheWrite 不进分母。
我们 `src/shared/piUsage.ts:163` 与 PI-Desktop `apps/desktop/src/lib/context-usage.ts:250`
的 `calculateCacheRate` 已经是同一个式子——`input` 是未命中的 prompt 部分，
`cacheRead` 是从缓存取的部分，写缓存的开销不属于这个比值。两边同式意味着迁移前后的数字天然可比。

**数据源不需要新埋点**：`src/shared/piTurnRollup.ts` 的 `PiTurnRollup` 已逐轮累计
`input / cacheRead / cacheWrite`，且都是 pi 原样上报、不做二次推导。

**基线采集**：5–8 条固定脚本会话（纯对话 / 多轮工具 / 触发压缩 / resume 续聊 / 长文件读），
同模型同参数，在**旧后端仍然可用时**跑完并存档——成功标准 2 要求「≥ 当前 pi-coding-agent 水平」，
而 P6-2 会摘掉旧后端，基线不提前采就没有对照物。不用真实用户会话做 A/B：模型不确定导致
工具调用序列、轮数和上下文长度都不同，两边数字不可比。

**参考实现的边界**：PI-Desktop 只**展示**命中率（`changelog.ts:506`「Show context cache hit
rate in chat transcript header」），`agent-runtime` 内没有任何缓存优化策略，ADR 也无相关条目。
所以「请求前缀稳定性的离线度量」没有可搬运的参考实现，属于我们自建，列为 P2 的**可选加强项**
而非门禁；门禁仍是上面这个 provider 上报的在线比值。

### D10 · Subagent 拓扑：同进程内的第二个 Agent，不占 WorkerSlot

**决策**：subagent 在同一 worker 进程内跑第二个 `Agent`（Cordis fork/isolate 上下文做 service 隔离），
不为每个 subagent 分配 WorkerSlot。

依据：
1. PI-Desktop ADR 0062 已稳定运行验证此拓扑——「A `SubagentRun` is a second pi `Agent` in the
   same sidecar process」，并把「A separate process per delegate」明确列为 **Rejected**：
   真隔离的收益抵不上重复一份 host 连接、provider 设置和事件管道的代价。
2. 我方额外理由：WorkerSlot 是被内存分档硬限的稀缺资源（≤4GiB 机器只有 3 个槽，
   `WorkerManager.ts:250-268`），超限直接 `worker_capacity_reached` 而不是排队。
   subagent 占槽会挤掉真实用户会话。
3. subagent 负载是 IO-bound（模型流式 + 文件读 + shell），事件循环不是瓶颈；
   真正 CPU 密集的 shell 本来就已 fork 出去。

**照搬 ADR 0062 / 0119 的边界**（这些数字是他们跑出来的，不重新拍）：

| 项 | 口径 |
|---|---|
| 并发上限 | 4，信号量控制（`MAX_SUBAGENT_CONCURRENCY`） |
| 报告上限 | 12k 字符（`MAX_SUBAGENT_REPORT_CHARS`），超出截断 |
| 工具白名单 | 默认 `Read/Glob/Grep`；可声明 `Bash/Edit/Write`；禁止 plugin/skill/mode 工具与嵌套 Task |
| 权限继承 | 不继承父会话写权限，写能力只来自定义自身声明 |
| 并行写序 | 按规范化路径的 PathMutex 串行化写操作，不同路径互不等待 |
| 上下文隔离 | 子行带 `parentToolCallId` + `agentName`，持久化但**重建模型上下文时跳过** |
| 超时 | 事件驱动的 idle + 总时长看门狗，产出 `timed_out` 结果（ADR 0119） |
| 终止 | 子代理终止收敛为 Task 工具结果，不触达主进程的 turn 处理 |
| 定义来源 | `~/.agents/subagents/<name>.md`，上限 16 条，坏文档降级为启动诊断 |

**不照搬的一条**：ADR 0062 花了篇幅把渲染层「每会话一个 pending permission」改成队列——
我们 `src/renderer/stores/chatSessions.ts:250` 的 `pendingPermissions` 本来就是数组且带去重，
这块渲染层不用动。

**留后路**：执行入口抽成 `SubagentRunner` service（`run(def, prompt, signal): AsyncIterable<Event>`），
进程内实现是默认 provider；将来真出现 CPU 密集场景，换一个实现即可，调用方不动。

### D11 · 执行载体：按进程身份区分，不按实现语言推断

**触发**：2026-09-08 加密测试机现场发现——同一 Windows 安装包、同一机器、同一仓库，
GUI（Electron `utilityProcess` 内的 worker）Read 返回异常内容、`pwd/ls/echo` 报
`Bad file descriptor`；而 TUI（随包 `resources/node-runtime/node.exe`）与编辑器
（识别 `%TSD-Header-###%` 头后交由白名单内的 node 读取）均正常。
完整取证与不确定性边界见[问题分析报告](../../Windows加密环境GUI异常分析.md)。

**机制**：企业加密驱动（TEC OCular Agent）按**进程**放行明文，打包出的 Electron exe
不在白名单里，因此读到的是密文；`src/main/utils/tsdSafeRead.ts` 已按此机制实现编辑器的
兼容读取。所以兼容性是**执行载体**的属性，不是实现语言的属性。

**决策**：

1. 一槽仍是一个隔离进程、一个 AgentSession；载体分两种，由平台与打包状态决定：

| carrier | 适用 | 通信 |
|---|---|---|
| `bundled-node` | Windows 安装版 | 随包 `node.exe` + Node 原生 IPC |
| `electron-utility` | 其余平台与开发模式 | `utilityProcess` + MessagePort |

2. 随包 Node 缺失时明确失败，不回落到 Electron，也不回落到 PATH 里不确定的 node。
3. runtime 内部**不得**直接触碰 `process.parentPort` / `process.send`，一律经 worker 入口
   与 `WorkerTransport` 适配；插件层对载体无感。
4. runtime 内所有 fs 与子进程调用收敛到两个 service 出口（P1 前置，见看板 P1-0）。
   载体兼容是这两个出口的职责，**不是逐个工具打补丁**。受影响面：file read/write/edit、
   bash、grep/glob、skills 与项目指令加载、session JSONL 写、trace 落盘、MCP stdio bridge、subagent。
5. 子进程的普通 stdout 必须排空，RPC 走独立通道，避免工具日志写满管道；
   bash 类工具不得假设管道 stdio 一定可用。
6. **验收按载体矩阵签收**：普通 CI runner 通过不等于加密机通过，两者在看板上是两个状态位。

**本条同时撤回旧版 §6 与 §8 的语言级结论**。路线继续走全栈 Node/TS，
但理由从「Node 不受影响」换成「随包 node.exe 是现场已验证、且由我们控制的载体」。

**待现场确认的反向风险**：载体从白名单外换到白名单内后，worker 新写的文件
（会话 JSONL、compaction record、Write/Edit 产物）在盘上的形态可能随之改变，而 Main 仍是
Electron——`SessionIndexService.ts:410`、`GitService.ts:670` / `:1364`、`WorktreeService.ts:648`
都是裸 `readFile`，全仓只有 `previewFileRead` 与 legacy import 三处是 TSD-aware。
这是推断而非已证事实，跟踪见看板 [Q5](../plantree/plans/runtime-evolution/open-questions.md)。

### D12 · 协议依赖版本：pin 新版，不为对比回退

`pi-ai` / `pi-agent-core` 保持 `0.84.4`。P2-0 的旧后端基线实际由 `pi-coding-agent@0.84.3`
的嵌套依赖跑出（0.84.3），两边差一个 patch。

**决策（2026-09-08 用户拍板）**：「版本影响不大，用新的」——不把新 runtime 回退到 0.84.3
去凑对照，也不为此补采一轮基线。P2-6 做新旧对比时，把这个 patch 差记为**已知偏差**写进结论，
不声称两边协议层完全同构。若对比结果出现无法解释的大幅偏离，再回头把版本作为变量单独排查。

### D13 · Main 侧读用户文件一律走 TSD-aware 读

**依据**（2026-09-08 加密机现场，Q5 收口）：加密按**文件策略**生效，不按写入进程——
agent 用 Write 工具写的 `tracked.txt` 与 git.exe 写的 `.git/HEAD` 都出自白名单内进程，
但只有前者在盘上是密文（`%TSD-Header-###%`，`stat` 报 8192 字节的容器大小）。
Main 进程及其派生的子进程不在白名单内，读用户文件得到的就是密文；
`git status` 一类只读 `.git` 元数据的操作不受影响。

**决策**：Main 侧凡是读**用户工作区文件内容**的地方，统一走 `src/main/utils/tsdSafeRead.ts`
的 `readFileTsdSafe` / `readFileTsdSafeBounded`，不允许新增裸 `fs.readFile`。
现存待改点：`GitService.ts:670`、`GitService.ts:1364`（diff 的工作区一侧，读到密文不报错，
`decodeBuffer` 会静默出乱码）、`WorktreeService.ts:648`。
已合规的有 `previewFileRead`（编辑器）与 legacy import 的三处。

**不受此约束的**：`SessionIndexService.ts:410` 读的是 Main 自己写的索引 JSON，
以及 runtime worker 内部的读写——worker 跑在白名单内的随包 node.exe 上，看到的就是明文（D11）。

**归属**：P3-5 与 P4-5 验收此项；改动落在 Main 层，不进 `src/runtime/`。

## 4. 模块分类：搬运适配 vs 自建

### 4.1 直接依赖（零自建）

| 模块 | 来源 | 说明 |
|---|---|---|
| 插件内核 | Cordis npm 包 | 直接 `npm install cordis`，pin 版本 |
| 协议适配 | `@earendil-works/pi-ai` | 已有依赖，只是不再经 pi-coding-agent 间接引用 |

### 4.2 工程搬运 + 适配（有完整参考实现）

| 模块 | 参考来源 | 参考量级 | 适配工作 |
|---|---|---|---|
| **Agent loop** | PI-Desktop `runtime.ts`（5511 行）+ DSH `agent-loop` 插件 | 核心循环 ~800 行，其余是工具/prompt/压缩 | 剥离 PI-Desktop 特有逻辑（Rust RPC、插件工具注册），适配我们的 tool/permission 插件接口 |
| **Provider binding** | PI-Desktop `provider-binding.ts` | ~500 行 | 适配我们的凭据系统（`~/.pilab` vault → pi-ai `ModelAuth`） |
| **Prompt 组装** | PI-Desktop `prompt-templates.ts` + `project-instructions-prompt.ts` + `plugin-skills-prompt.ts` + `mode-prompts.ts` | 4 文件共 ~1500 行 | 替换 PI-Desktop 的 host-core RPC 为本地读取；融入我们的 CLAUDE.md / resource 体系 |
| **上下文压缩** | PI-Desktop `session-context.ts` + `runtime.ts` 压缩段 + Rust `transcripts.rs` compaction | TS ~600 行 + 策略逻辑 | 用 TS 实现 compaction record 读写（PI-Desktop 用 Rust）；缓存命中率优化策略直接搬 |
| **Subagent** | PI-Desktop `subagent.ts` + `subagent-definitions.ts` | ~800 行 | 适配我们的事件投影和 WorkerSlot 模型 |
| **Skills 加载** | PI-Desktop `plugin-skills.ts` + `plugin-skills-prompt.ts` | ~400 行 | 适配我们的资源路径（`~/.pilab` + `~/.agents/`） |
| **会话存储** | PI-Desktop Rust `transcripts.rs`（JSONL 读写 + compaction + layout index）+ 我们现有 `SessionIndexService` | Rust 668 行 → TS 重写 | 格式兼容，逻辑用 TS 重写；分支管理从 PI-Desktop 的 session-context 搬 |
| **会话导入** | 我们现有 `LegacyImportService`（已经比 PI-Desktop 更成熟） | 保持 | 只需适配新的 session 插件接口 |
| **模型目录** | 我们 A3 已有随包快照 + 离线回落 | 保持 | 只需从 pi-coding-agent 的配置切到自有配置 |

### 4.3 有参考的自建（参考在 Rust 或需拼装适配）

| 模块 | 参考来源 | 适配说明 | 量级估算 |
|---|---|---|---|
| **Cordis 插件定义与服务接口** | DSH 整个 runtime 即 Cordis 插件组织，接口模式可直接参考 | 我们的模块划分不同，需自定义 `provides/requires` 和 service 类型 | M · ~500 行接口 + ~300 行 bootstrap |
| **工具注册与执行** | PI-Desktop Rust `tools/`（grep/shell）+ spec `03-tools-and-permissions.md`；工具 JSON schema 从 `pi-agent-core` 的 `AgentTool` 定义可直接复用 | Rust → TS 重写；工具执行逻辑（读文件、跑 shell）本身直接 | L · 预估 2000-3000 行 |
| **权限系统** | PI-Desktop `permissions.rs` + spec + ADR 0057/0100；我们已有 Extension UI bridge 做审批 UI | Rust → TS 重写 scope 匹配逻辑；审批 UI 层复用现有 inline dock | M · 预估 800-1200 行 |
| **RuntimeEvent 翻译层** | **我们现有 `piWorkerSession.ts` 就是干这个的**——从 pi 事件翻译成 RuntimeEvent | 翻译目标（RuntimeEvent）不变，只是换了数据源格式 | M · 预估 600-800 行 |
| **Worker 进程 bootstrap** | 现有 `agent-host/worker.js` 的启动模式 | 替换 pi-coding-agent 初始化为 Cordis 插件图初始化 | S · ~200 行 |

### 4.4 量级汇总

**所有模块均有参考实现**（直接依赖 / 同语言搬运 / 跨语言重写 / 现有代码适配），无零参考的绿地开发。

| 分类 | 预估行数 | 说明 |
|---|---|---|
| 直接依赖（Cordis + pi-agent-core + pi-ai） | 0（npm install） | 三个 MIT 包 |
| 同语言搬运适配（PI-Desktop TS → 我们 TS） | ~5000-6000 行 | agent loop、provider binding、prompt、压缩、subagent、skills、会话导入、模型目录 |
| 跨语言重写 + 现有代码适配 | ~4000-5000 行 | 工具（Rust→TS）、权限（Rust→TS）、RuntimeEvent 翻译（改数据源）、Cordis 接口（参考 DSH）、bootstrap |
| **总计** | ~9000-11000 行 | |

对照：我们现有 `src/agent-host/`（非测试）约 8656 行。
PI-Desktop 的 agent-runtime（TS 部分）约 9715 行 + Rust host-core 34019 行。

## 5. 执行策略

### 5.1 并行开发，渐进切换

1. 在 `src/runtime/` 下新建插件图，与现有 `src/agent-host/` 共存。
2. WorkerSlot 通过配置开关选择后端（`pi-coding-agent` 或 `自有 runtime`）。
3. 新 runtime 能跑通完整对话后，默认切换；旧路径保留一个版本周期作回退。

### 5.2 建议施工顺序

| 阶段 | 内容 | 前置 |
|---|---|---|
| **P0 · 骨架** | Cordis bootstrap + plugin-model-adapter（pi-ai 直连）+ 最小 agent loop（单轮对话，无工具） | 无 |
| **P1 · 工具** | plugin-tools（file/bash/search）+ plugin-permissions（基础白名单） | P0 |
| **P2 · 上下文** | plugin-context（压缩）+ plugin-prompt（系统提示词组装）+ 缓存命中率 | P0 |
| **P3 · 会话** | plugin-session（JSONL 存储 + 分支 + resume）+ RuntimeEvent 翻译层 | P0 |
| **P4 · 集成** | Worker bootstrap + WorkerSlot 后端切换 + 端到端测试 | P1 + P2 + P3 |
| **P5 · 扩展** | plugin-skills + plugin-subagent + MCP bridge + 导入适配 | P4 |
| **P6 · 切换** | 默认使用新 runtime + 移除 pi-coding-agent 依赖 | P5 + GUI 点验 |

P1/P2/P3 可并行施工（三个 agent 团队各领一块）。

### 5.3 风险与缓解

| 风险 | 缓解 |
|---|---|
| pi-agent-core 的 Agent 类行为不透明 | PI-Desktop 已验证该分层；P0 阶段即验证：pi-agent-core `Agent` + pi-ai 能否完成完整流式对话 |
| 压缩策略迁移后模型表现下降 | 先原样搬运 PI-Desktop 的策略，跑对比测试，再调优 |
| 现有 RuntimeEvent 接口不够表达新 runtime 的能力 | D5 约束第一版兼容；后续版本可扩展字段，renderer 按需适配 |
| Cordis rc 阶段 API 变更 | pin 版本；Cordis 核心 API（Context/Service/Plugin）已稳定，rc 变更集中在边缘功能 |
| 工具集不完整导致模型能力退化 | P1 先实现最常用的 5 个工具（file read/write/edit、bash、search），覆盖 90% 场景 |

## 6. 不做的事

| 项 | 理由 |
|---|---|
| Rust 原生模块 | 当前路线不引入。现场的 PI-Desktop Rust host-core 直接读写失败，但**不能据此断言所有 Rust 二进制均不可行**——加密驱动按进程名、路径、签名还是父进程放行仍未确认（D11）。不引入的实际理由是：随包 node.exe 是现场已验证且由我们控制的载体，再加一种载体等于再加一份未验证的兼容风险 |
| 第三方插件市场 | 内部产品，安全风险不匹配 |
| 改变 WorkerSlot 拓扑 | 一槽一隔离进程一 AgentSession 已稳定；D11 改的是载体，不是拓扑 |
| 改变凭据体系 | `~/.pilab/<profile>/` 已稳定，与 PI-Desktop 的 `~/.pi-desktop/` 同构 |
| 改变 renderer/UI | RuntimeEvent 接口兼容，UI 无感切换 |

## 7. 成功标准

1. 新 runtime 能完成完整多轮对话（含工具调用、权限审批、上下文压缩）。
2. 缓存命中率 ≥ 当前 pi-coding-agent 的水平。
3. `pi-coding-agent` 从 `package.json` 移除，`pi-agent-core` + `pi-ai` 成为仅有的两个 pi 系依赖。
4. 现有 GUI 功能无回归（时间线、Composer、权限卡、设置页）。
5. 旧会话文件仍可读取和 resume。
6. **加密机现场验收通过**（D11）：同一文件 GUI Read 返回明文、shell 命令输出正常、
   Edit/Write 后 TUI 与编辑器看到的内容一致、旧会话可 resume、退出无残留 worker。
   普通 CI runner 通过不计入本条。

## 8. 加密机实测记录

| 日期 | 测试项 | 结果 |
|---|---|---|
| 2026-09-08 | PI-Desktop 在加密测试机启动运行 | 可运行，agent 对话可启动 |
| 2026-09-08 | PI-Desktop Rust host-core 直接文件读写 | **不可行**——无法直接读写，仅能通过 bash/powershell 工具间接操作 |
| 2026-09-08 | ai-client TUI（随包 node.exe）与编辑器（TSD-aware read） | 用户确认正常 |
| 2026-09-08 | ai-client Windows 安装版 GUI（Electron utilityProcess） | 用户确认 Read 返回异常内容、`pwd/ls/echo` 报 `Bad file descriptor` |
| 2026-09-08 | ai-client Windows 安装版 GUI（随包 Node worker，D11/D20 后） | 用户确认：Read 得到明文 · `pwd/ls/echo` 正常无 `Bad file descriptor` · Write/Edit 后编辑器显示正常 · 会话标题与 resume 正常 · 退出无残留 `node.exe` |
| 2026-09-08 | 同上：agent 产物在盘上的加密状态 | 用户在文件管理器确认**两个产物文件均为已加密状态**——白名单内进程看到的明文来自透明解密，不代表文件未加密。Main 侧裸读的后果另行验证（[Q5](../plantree/plans/runtime-evolution/open-questions.md)） |
| 2026-09-08 | Main 进程派生子进程 + 管道读输出 | **正常**——git 面板报错时 `git.exe` 由 Main 派生、stderr 经管道读回并透传到渲染层（`fatal: not a git repository`）。据此把 GUI bash 的 `Bad file descriptor` 收窄为 **utilityProcess 载体特有**，不能推广到所有 Electron 进程 |
| 2026-09-08 | 左栏 git 面板全空 | **两件事**：指向 `E:\testaaa`（非仓库）时报错正确、属正常；但指向真仓库 `git-probe-once` 时 `getStatus` 返回 `current: null` + 空改动、`getBranches` 返回 `(no commits yet)`，而同一 Main 血统下的 PowerShell 里 `git status` 完全正常——是 `GitService` 自身 spawn 参数的主线缺陷，与加密无关（[Q7](../plantree/plans/runtime-evolution/open-questions.md)） |
| 2026-09-08 | Main 派生 PowerShell 读 `.git\HEAD` 与 `git status` | **正常**——`ref: refs/heads/master`、分支/改动/commit hash 全部正确。`.git` 元数据不在加密策略内 |
| 2026-09-08 | Main 派生 PowerShell 读 `tracked.txt`（agent 写的工作区文件） | **密文**——`%TSD-Header-###%` 开头；`file.list` 报告 size 为 8192（加密容器块大小），真实内容仅二十余字节。**Q5 由此坐实** |

**修订结论**（撤回旧版「Rust 不可行、Node 不受影响」）：兼容性按**实际执行载体与启动方式**验收，
不能按实现语言推断。同一份 Node/TS 代码在 Electron 载体里失败、在随包 node.exe 载体里正常，
这条差异就是证据。当前继续 Node/TS 路线，Windows GUI 用现场已正常的随包 Node（D11）；
其 Read / bash / Edit / Write 仍需新安装包在现场复验，未验收前不写成已解决。
PI-Desktop 的 Rust host-core 代码仅作 TS 重写参考，不直接使用。

## 9. 溯源

- PI-Desktop `packages/agent-runtime/`：agent loop + prompt + 压缩 + subagent（TS，9715 行）。
- PI-Desktop `crates/host-core/`：权限 + 工具 + 会话存储 + 密钥 + 插件（Rust，34019 行）。
- DSH `packages/core/agent-loop`：Cordis 插件式 agent loop（TS，未本地持有，从调研档引述）。
- 本项目 `src/agent-host/`：现有 pi-coding-agent 集成层（TS，8656 行）。
- Cordis：`cordis@4.0.0-rc.9`，MIT，69KB，[GitHub](https://github.com/cordiverse/cordis)。
