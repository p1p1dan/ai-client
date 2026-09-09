# Runtime 自主化演进 — 架构需求文档（ARD）

> 文档日期：2026-09-08
> 文档状态：**已拍板**（2026-09-08 用户确认 D1–D14；2026-09-09 追加 D15–D16）· 执行看板见 [plantree](../plantree/plans/runtime-evolution/README.md)
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

**P4-5 补充：「零改动」成立的前提是事件集合也一致，不只是形状一致。**
点验发现四处缺口，全部表现为**沉默**而非报错——renderer 的 reducer 对认不出的消息
一律返回 `{}`，所以缺字段既不抛错也不留日志：

- `permission.activity` native 侧完全不发。`policy_allow` 从不弹窗，这行记录是
  「这次调用被网关判过」的唯一证据，缺了它「权限系统没在跑」和「本来就不需要批准」
  在界面上完全一样。改为由 `plugin-permissions` 的 `onActivity` 投影（prompt + decision 两相）。
- 用户 `message.started` 缺 `attemptId`。composer 的乐观气泡靠它与权威回声配对退场，
  缺了就永远退不掉——用户自己的话在时间线上留两份。
- `worker.send` 的 `attachments` 被静默丢弃：模型收不到，界面也不报错。
- **内部记账条目不上线**：`aiclient.permissions` 这类条目该写进 JSONL（分支要记住自己跑在哪档
  权限下），但不该进时间线——renderer 把每个 `custom.entry` 渲染成可见的系统消息并单独开一轮，
  泄漏一条就在对话顶部多出一行裸 JSON 和一个空轮次。清单见 `INTERNAL_CUSTOM_ENTRIES`。

回归防线是一份**录制的事件流**（`src/shared/__tests__/fixtures/nativeGuiEventStream.json`）：
runtime 侧 `guiEventContract.test.ts` 用真实 RPC + 真实插件图录它，renderer 侧
`nativeStreamReplay.test.ts` 把它喂进真实 reducer 断言用户最终看到什么。
两侧跨不过各自的 typecheck 边界（`src/runtime` 没有 `@shared` 路径映射也没有 DOM lib），
所以用 JSON 文件而不是共享模块作为交界。

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

### D10 · Subagent 拓扑与生命周期：同进程后台任务，完整复刻后优化

**2026-09-09 修订**：用户明确要求整个复刻 PI-Desktop 的 subagent 工作体，再在完整基础上优化。
同进程、不占 WorkerSlot 的原拓扑保留；旧 ADR 0062/0119 的并发/终止/权限条款被本次现行基线替代。
[初始决策快照](../plantree/plans/runtime-evolution/history/d10-subagent-initial.md)保留旧理由；完整范围以 D17 和 [P5-2 契约](../plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md) 为准。

**拓扑**：每个用户会话仍占一个 worker；subagent 是该 worker 内独立 Agent，上下文和权限调用隔离，
共享 HostIo/Exec、会话 writer、规范路径写锁与审批出口。自建 `SubagentRunner` + 会话级 delegation registry，
不额外申请 WorkerSlot，不增加 singleton supervisor，不引入 Rust host。

| 项 | 现行决策 |
|---|---|
| 完整复制基线 | PI-Desktop `948ee676bdb7b31d496f6603aa03dd12eb95be35` 现行源码 + 测试；固定版本，不只按旧 ADR 摘取 |
| 编排 | Task 立即返回；TaskWait(all/any/minCompleted)、TaskList、TaskStop 全部具备；核心工具与主动委派提示词同步上线 |
| 父子寿命 | 父 loop idle 不结束逻辑 run、不取消子任务；runtime 等报告并交回父 Agent 继续；用户 Stop、TaskStop、dispose/实际宿主失败取消 |
| 限额 | 会话并发 10、已结束 registry 100、报告 12k/合并 50k；TaskWait 默认 600s/上限 900s，等待超时不取消任务 |
| 轮次/超时 | 不武装 idle/duration 杀子任务；兼容旧字段；maxTurns 显式生效、0/none/未声明可不设限，上限 80；工具/provider 自身超时独立存在 |
| 内置角色 | explorer/code-reviewer/test-runner/fixer 整套迁移，默认工具/提示词/轮数及必要工具适配均有对照证据 |
| 模式与权限 | plan 无 Task*；agent 中默认 inherit 父 gear，显式定义 gear 独立；工具能力来自定义，deny 与 D14 不被绕过；不临时改全局权限执行子工具 |
| 定义与管理 | 全局 `.agents/subagents`、user > builtin；管理库存 64、runtime 16、provider 8、32KiB；启停与文档分离，完整管理 UI 必交 |
| 记录/上下文 | 子行按 delegationId/parentToolCallId 归属、保存并可查历史，不进父模型过程上下文；终态和完整报告不受实时事件裁剪丢弃 |
| 计费 | 父 message usage 保持原始 provider 值，子 usage 单独结算并计入会话总量；重读/重开不重复累计 |
| 重试/恢复 | 与父 provider 重试共策略，失败请求恢复不重放工具；重启显示已落盘事实及中断状态，不承诺原子任务继续运行 |

**必要适配不等于裁剪**：D11 两载体/HostIo/Exec、D12 Pi 0.84.4、D14 两轴、现有 v4 JSONL/RuntimeEvent、
@coss/ui/资源入口保持本仓体系。BrowserPreview 与长命令接口是完整复制的宿主依赖，列入 P5-2，不能悄悄丢弃。
定义模型固定失败不得回落父模型；模型目录/凭据复用 D7/D15。明确不复制已由 ADR 0165 撤回的 Peer/A2A。

**资源约束**：10 是对标行为上限，非在低资源开发主机同时跑 10 个重任务的授权；用 fake Agent/闸门做并发验收。
宿主不可接单时明确资源错误。资源自适应调度的进一步优化在完整基线后另案记录。

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

**当初的反向风险已收口**（2026-09-08 Q5 现场坐实，见 D13）：载体换到白名单内之后，
Main 仍是 Electron，读用户工作区文件拿到的就是密文。已按 D13 统一改走 TSD-aware 读；
`SessionIndexService.ts:410` 读的是 Main 自写的索引 JSON，不在此列。

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

**2026-09-09 补一处漏项**：上面的清单只数了裸 `fs.readFile`，漏了
`src/main/services/git/encoding.ts` 的 `detectBinaryFile`——它把路径直接交给 `isbinaryfile`，
而密文容器里的 NUL 填充会让整个工作区的文本文件都被判成二进制，diff 面板连乱码都显示不出来。
判据不是「谁调了 readFile」，而是「谁按工作区文件的字节做判断」。已随实现改为先探头、
确认是容器才解密后按内容判定；普通文件仍走只读 512 字节的路径探测。

同批把 `tsdSafeRead` 的解密进程改为优先随包 `node.exe`（D11/D20 已在现场验证白名单的那一个），
PATH 里的 `node` 退为兜底，并留 `AICLIENT_TSD_NODE_PATH` 覆盖。

**归属**：P3-5 与 P4-5 验收此项；改动落在 Main 层，不进 `src/runtime/`。

### D14 · 权限与模式分成两根轴：模式管工具集，档位管打扰程度

**触发**（2026-09-08 用户拍板）：现有四档 `readonly / pragmatic / handsoff / fullopen`
（`src/agent-host/sessionTierAuthorizer.ts:15`）实测「十分鸡肋不好用」。原因不是档位太多，
而是这张表把两件事压在了一根轴上——`readonly` 靠拒工具实现只读，`handsoff` 靠放行判定减少打扰，
于是每一档都同时是半个模式和半个权限。PI-Desktop 把两者分开：`Mode`（plan/goal/agent）决定
**哪些工具存在**，`PermissionMode`（`ask` / `accept-edits` / `auto`）决定**在场的工具问不问**。

**决策：采纳两轴分离。**

**轴一 · 模式**

| 模式 | 工具集 | 说明 |
|---|---|---|
| `plan` | 不含 Write / Edit 及任何写类插件工具；bash 在当前档位下可用，仅用于勘察 | 产出实现计划交用户批准。取代旧 `readonly`——同样是「只看不动」，但 bash 可用于勘察，而且有产出 |
| `agent` | 完整工具集 | 批准后的正常执行 |

`goal`（目标契约：结果 + 可验证的验收标准 + 边界，批准后自主执行）**本轮不做**，
但模式是枚举而非布尔，将来加它不改结构。

**轴二 · 权限档位**（标识符用英文，UI 用中文）

| 档位 | UI | 语义 |
|---|---|---|
| `ask` | 每次询问 | 写 / 改 / shell 逐条询问 |
| `accept-edits` | 自动接受编辑 | 工作区内的写、改、**bash 一并放行**；工作区外路径与外部目录仍询问 |
| `auto` | 全自动 | 全部放行 |

**`accept-edits` 放行 bash 是本次修复的核心**（用户拍板）：旧 `handsoff` 放行了写/改却仍逐条问 bash，
而 agent 干活几乎每步都要 shell，于是「为了少被打扰而选的档位照样一直打扰」——这就是鸡肋的实感来源。

**三档都不影响 deny 规则**：`permissionPolicy.mjs` 的密钥文件等拒绝在链路更早处生效，`auto` 也不例外
（与旧四档同口径，不变）。

**旧值映射**（P3-3 旧会话与设置迁移必须走这张表，不能丢弃）：
`pragmatic → ask` · `handsoff → accept-edits` · `fullopen → auto` · `readonly → plan 模式 + ask`。

**归属**：P1-5 按本条实现，不再实现四档矩阵；P1-6 的审批 UI 与 renderer 档位控件按三档改；
模式的工具集裁剪在 P1-1 的注册表上做；提示词侧新增 `mode` 段与 `permission-gear` 段（P2-1 已留槽位）。

### D15 · 模型目录的 baseUrl：客户端按 wire 协议推导，允许每个 model 显式覆盖

**触发**（2026-09-09 用户拍板）：P0 在线冒烟发现 cch 网关**按模型族分端点**——
Anthropic 系不带 `/v1`、OpenAI 系必须带 `/v1`。配错的表现是 503「所有供应商暂时不可用」
而不是 404，所以配错和网关真的挂了在客户端看起来一模一样，排查成本很高。

**决策**：P5-5 切到自有模型目录后，`baseUrl` 由客户端按 wire 协议
（`anthropic-messages` / `openai-responses` / `openai-completions`）推导默认后缀，
同时允许目录里每个 model 显式写死 `baseUrl` 覆盖推导结果。

理由：托管端的下发口径不由我们控制，一旦它变了，「原样使用下发值」会让整片模型直接 503；
而 503 不像 404 那样一眼能看出是配置问题。把推导放在客户端，等于把这条容易误判的失败
变成我们自己可测的逻辑；显式覆盖则保留了托管端出现例外端点时的逃生口。

代价是多一处推导逻辑要维护——用单测钉住「每种 wire 协议推导出的后缀」即可，不需要联网。

**归属**：P5-5 实现并加单测；P0 在线冒烟证据里的两条端点事实是本条的输入。

### D16 · Windows / 加密机现场验收：攒到 P4-6 一次上机，不分批

**触发**（2026-09-09 用户拍板）：P1-0 的 runner + taskkill 命令树清理、P1-3 的 bash 跨平台、
P1-8 的六项工具探针、P4-0 刚落地的随包 Node worker 载体，四条都只能上机签收，
问题是现在就发一版测试包，还是攒到 P4-6。

**决策**：攒到 P4-6 一次做。上机机会稀缺，分批上机每次都要重新走一遍装包与现场协调。

**因此本文档与看板的写法必须保持**：这四条在签收前一律记为「进行中 / 未验收」，
Linux 与 CI 的绿色不得代签（D11 第 6 条）。**风险是明知的**：到 P4-6 时一次要验证的
未验证代码面很大，出问题不好定位到层。缓解办法是 P4-6 按载体矩阵逐条签收、
而不是「跑通一个会话就算过」，并且保留 P1-8 已有的六项工具探针作为最小定位单元。

测试包用手动 `workflow_dispatch` 出，不推 tag。

### D17 · Subagent 整体复刻与分阶段验收（2026-09-09）

**用户要求**：subagent 是完整庞大的工作体，整体复刻 PI-Desktop，再在整体基础上优化。
这取代前序调研“本轮不做”和仅参考 ADR 0062/0119 的简化实施范围；P4 由并行执行者继续推进。

**决策**：P5-2 扩为一个完整交付包，包含定义/四角色/模型选择/提示词、Task* 后台编排、权限与重试、
持久化/计费/取消/退出、管理 UI、运行与历史 UI、旧插件与定义迁移，以及 BrowserPreview/长命令等必要宿主能力。
第一阶段必须完成现行行为等价矩阵；施工拆批不等于交付裁剪。全部能力签收后再讨论并发、成本和性能优化。

**权威链**：本 ARD → [完整契约](../plantree/plans/runtime-evolution/topics/p5-2-subagent-contracts.md) →
[P5-2-0～7 任务/SA01～22 验收](../plantree/plans/runtime-evolution/topics/p5-2-subagent-tasks.md)；
[源码调研](../plantree/plans/runtime-evolution/topics/p5-2-subagent-research.md)和[固定证据](../plantree/plans/runtime-evolution/evidence/p5-subagent/README.md)说明来源与实测强度。

**适配原则**：TS 纯逻辑/提示词/测试向量保留行为语义；Rust 管理/持久化适配为 TS，IO 经 D11 出口，
UI 适配现有组件体系。**用户补充用途（2026-09-09）**：仅在组织内部测试使用，不对外分发；适合搬用的源码、提示词和测试直接复用，不为重写而重写。
**执行约束（2026-09-09）**：执行过程中不新增版权、许可证或来源版本记录，不设置许可证审批或阻塞门禁。部门内部实验由用户自行组织，不属于本计划的任务或验收条件。

**P4 衔接**：不要求 Claude 提前实现 P5 或放空服务；P5 基于 P4 的 runtime.run/Stop/dispose/事件与索引边界接入。
外层 run 才决定会话完成，内部父 Agent idle 可继续；等待子任务时 RPC Stop 必须可达，写入与索引在最终收敛后完成。
细项见契约 §6；P4 验收不代签 P5 新增任务生命周期，两种 carrier/GUI 要补 subagent 专项。

**版本与完成条件**：上游 Pi 0.85.0 与本仓 0.84.4 做差异探针，不未经决策升级 D12；先过 P5-2-0 再实现。
每个矩阵项须有行为要求、适配说明和测试证据；缺管理 UI、BrowserPreview、历史恢复或取消路径时不能标 P5-2 Done。
P5-2 对依赖能力做必要适配，不借此移植 PI-Desktop 整个插件市场、CDP、goal 模式或独立 A2A 系统。

---

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
| **Subagent** | PI-Desktop subagent/definitions + runtime Task* 编排 + Rust 管理/会话 + renderer + tests | 完整子系统，旧 ~800 行估算已失效 | 按 D10/D17 整体复刻，跨层任务/能力清单见 P5-2 文档；完成后再优化 |
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
上述行数为初始估算；2026-09-09 D17 扩展后的 subagent 工作量覆盖 runtime/管理/renderer/测试，不再用单个 ~800 行模块估算。
PI-Desktop 的 agent-runtime（TS 部分）约 9715 行 + Rust host-core 34019 行（初始快照）。

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
| **P5 · 扩展** | plugin-skills + 完整 subagent 工作体（D17 / P5-2-0～7）+ MCP bridge + 导入适配 | P4；subagent 调研可并行 |
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
