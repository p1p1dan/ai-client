# Runtime 自主化演进 — 架构需求文档（ARD）

> 文档日期：2026-09-08
> 文档状态：ARD 草案，待用户拍板
> 2026-09-08 现场修订：Windows 安装版 GUI 的执行载体按 [D20](../plantree/plans/pi-backend-migration/decisions/020-windows-bundled-node-worker.md) 改用随包 Node。原“Node/Electron 文件读写均正常”结论撤回，见[问题报告](../../Windows加密环境GUI异常分析.md)。
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
  → 平台 worker（Windows 安装版：随包 Node；其他：utilityProcess）→ pi-coding-agent
  → Pi AgentSession（黑盒：agent loop + tools + 权限 + 压缩 + prompt + 会话 全在里面）
  → 事件投影为 RuntimeEvent → Main 路由 → renderer reduce
```

**不可控**：agent loop、工具执行、权限体系、上下文压缩策略、系统提示词组装、会话存储格式。

### 2.2 目标

```text
Renderer → Preload → Main WorkerManager → WorkerSlot
  → 平台 worker（Windows 安装版：随包 Node；其他：utilityProcess）→ 自有 runtime（Cordis 插件图）
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

### D4 · 进程拓扑：不变

保持一槽一隔离进程。Windows 安装版按 D20 使用随包 Node + 原生 IPC，其余平台使用 utilityProcess + MessagePort。
新 runtime 在 worker 内初始化 Cordis 插件图，由 WorkerTransport 适配通信；WorkerManager/WorkerSlot ownership 不变。

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
| Rust 原生模块 | 当前路线不引入。现场的 PI-Desktop Rust host-core 直接读写失败，但不能据此断言所有 Rust 二进制均不可行；进程名、路径、签名和启动环境的规则仍待确认 |
| 第三方插件市场 | 内部产品，安全风险不匹配 |
| 改变进程拓扑 | 现有 WorkerManager/WorkerSlot 已稳定 |
| 改变凭据体系 | `~/.pilab/<profile>/` 已稳定，与 PI-Desktop 的 `~/.pi-desktop/` 同构 |
| 改变 renderer/UI | RuntimeEvent 接口兼容，UI 无感切换 |

## 7. 成功标准

1. 新 runtime 能完成完整多轮对话（含工具调用、权限审批、上下文压缩）。
2. 缓存命中率 ≥ 当前 pi-coding-agent 的水平。
3. `pi-coding-agent` 从 `package.json` 移除，`pi-agent-core` + `pi-ai` 成为仅有的两个 pi 系依赖。
4. 现有 GUI 功能无回归（时间线、Composer、权限卡、设置页）。
5. 旧会话文件仍可读取和 resume。

## 8. 加密机实测记录

| 日期 | 测试项 | 结果 |
|---|---|---|
| 2026-09-08 | PI-Desktop 在加密测试机启动运行 | 可运行，agent 对话可启动 |
| 2026-09-08 | PI-Desktop Rust host-core 直接文件读写 | **不可行**——无法直接读写，仅能通过 bash/powershell 工具间接操作 |
| 2026-09-08 | ai-client TUI（随包 node.exe）/编辑器（TSD-aware read） | 用户确认正常 |
| 2026-09-08 | ai-client Windows 安装版 GUI（utilityProcess） | 用户确认 Read 返回异常内容、bash 报 Bad file descriptor |
| 2026-09-08 | ai-client Windows 安装版 GUI（随包 Node，`45d43db8` / CI `34207032908`） | 用户安装新包后确认 GUI 可以读取内容；其他工具尚待确认 |

**修订结论**：兼容性应按实际进程载体和启动方式验收，不能按实现语言推断。
当前继续 Node/TS 路线，Windows GUI 使用随包 Node，读取恢复已获新包现场确认；bash/Edit/Write 与退出清理仍待现场复验。

## 9. 溯源

- PI-Desktop `packages/agent-runtime/`：agent loop + prompt + 压缩 + subagent（TS，9715 行）。
- PI-Desktop `crates/host-core/`：权限 + 工具 + 会话存储 + 密钥 + 插件（Rust，34019 行）。
- DSH `packages/core/agent-loop`：Cordis 插件式 agent loop（TS，未本地持有，从调研档引述）。
- 本项目 `src/agent-host/`：现有 pi-coding-agent 集成层（TS，8656 行）。
- Cordis：`cordis@4.0.0-rc.9`，MIT，69KB，[GitHub](https://github.com/cordiverse/cordis)。
