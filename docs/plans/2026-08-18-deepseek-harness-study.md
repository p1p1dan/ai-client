# DeepSeek Harness（dsh）调研档 — 对照与可借鉴项

> 日期：2026-08-18 · 触发：用户提出「一切皆插件的 harness 项目对我们有无启发」
> 取证方式：浅克隆全仓通读（`/tmp/dsh-probe`，81M），非只读 README。
> 参照版本：master HEAD（2026-08-18 拉取），Codex 证据 pin `codex-cli 0.147.0`。
> 拍板（2026-08-18，用户）：① 落库不动工 ② 做 Codex 线协议交叉比对 ③ 抄三条工程纪律进规范 ④ dsh 作为第三 backend 只记 ideas 不立项。

## 1. 定位：不在同一层

| | dsh | ai-client |
|---|---|---|
| 是什么 | agent 运行时框架**本体**（模型适配器 / 工具注册表 / 会话日志 / agent loop 全是插件） | 客户端外壳 + 多 agent 宿主（Electron 三进程，驱动 CC SDK 与 Codex app-server） |
| 内核 | vendored [Cordis](https://github.com/cordiverse/cordis)（Koishi 系 IoC/插件内核） | 无插件内核，直接分层 |
| 竞品关系 | 与 Claude Code / Codex 同层 | 消费 CC / Codex 的上层 |

**结论：不存在「引入 dsh 重构」这条路。** 它的价值是——我们正在手工造的每一件东西它都造过一遍并写成了文档。

反直觉事实：dsh 自带 `dsh-subagent-claude-code` 与 `dsh-subagent-codex`，看似与我们同工，实为 **one-shot 无人值守**——显式关掉 `AskUserQuestion`、不传 `canUseTool`、`persistSession: false`、审批一律 `cancel`/`decline`、`inheritsParentContext: false`。它把 CC/Codex 当一次性外包工具；我们做的恰是它明确声明不做的那半边（交互式会话 + 权限卡 + 提问 + resume）。

## 2. 架构速览

| 机制 | 内容 |
|---|---|
| 组装 | profile（web/headless）叠 bundle（`dsh-base`/`web-app`/`headless`）叠 `cordis.patch.yml`；`dsh --dump-config` 打印实际树，任何条目可被 patch 替换 |
| 能力 seam | 强制三角：Service Definition + Provider + Consumer。「单一角色不算 seam，加能力要三者一起设计」 |
| 事件三域 | 会话事件（持久可回放）／`agent/*`（活跃 agent 拦截）／能力事件（`fs/*`、`tools/*`）；瀑布式事件靠 `next()` 委托 |
| 会话日志 | 唯一真源，`deriveMessages()` 投影模型历史，原始 chunk 保 UI 保真 |
| Host↔Client | Typert：`@Remote` 装饰器 → 编译期生成严格 schema + Client 具体方法（不用 Proxy）；复杂对象经 `TypertLookupMap` 换 id 过 wire |
| Client 插件 | 包在 `package.json` 声明 `dsh.client`，host 扫出 `window.__DSH_BOOT__` 图，`/plugins/<id>/client.js` 供 bundle；UI = 40+ 个 `ui-*` 插件包 |
| 模型 | `ctx.llm` 适配器 seam，发了两个实现：`llm-deepseek`（官方直连）+ **`llm-pi-ai`（通用多 provider 适配器，背靠 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)）**。后者自带 openai / anthropic / deepseek 等路由目录，目录外的 provider（OpenAI 兼容网关、自托管服务、比目录新的 provider）**纯 YAML 声明即可，不需改代码**。「支持市面上大部分模型」基本成立 |

## 3. Codex 线协议交叉比对（第二实现对照）

比对对象：dsh `packages/subagent/subagent-codex/src/wire.ts`（374 行，pin 0.147.0） vs 我们 `src/agent-host/codexWire.ts` / `codexNormalizer.ts` / `codexItemMapper.ts` / `codexDecisions.ts`。

### 3.1 我们的缺口（两条真缺口 + 一条小口子）

**缺口 ① `agentMessage.phase` 完全未建模**（`codexItemMapper.ts:97-100`, `:513-525`）
我们把每个 `agentMessage` item 无条件映射为 assistant 文本（`mode: 'agent_message'`），从不读 `phase`。dsh 的独立实现把它分三档：

- `phase: 'final_answer'` → 最终答案（最新者胜）
- `phase: null` → 兼容回落答案（Codex 未发显式 final phase 时用）
- `phase: 'commentary'` → **永不顶替答案**
- 其他值 → 显式抛错（拒绝静默）

我们的夹具（`__tests__/fixtures/codex/codex-s5-history-turn.jsonl` 等 4 个文件）中 `phase` **全部是 `final_answer`**，所以既未被证伪也未被证实——属我们自己规格镜头「三类必查」里的**硬编码信念**型空白：字段在线上存在、我们的映射表对它零记载、零测试臂。风险面：commentary 阶段消息会以正式回答形态进时间线，且 `item/agentMessage/delta` 流同样不分 phase，会流进同一个气泡。

**缺口 ② `codexErrorInfo: 'contextWindowExceeded'` 未建模**（`codexNormalizer.ts:325-333`）
全仓 `contextWindowExceeded` 零命中。`classifyCodexTurnError` 目前只有一类 `codex_credentials_missing`；上下文超限会退化成通用 `session.failed` + codex 原文。dsh 把它单独映射为 `stopReason: 'max-tokens'`。对我们是**可操作性损失**：用户拿不到「该压缩上下文/开新会话」的定向提示。

**小口子 ③ 未知 `turn.status` 静默归并**（`codexNormalizer.ts:680`）
我们：`status !== 'completed'` → failed（宽容，不炸）。dsh：白名单 `{completed, interrupted, failed}`，越界显式抛错。客户端不该炸，我们的姿态是对的；但**未知 status 连一条日志都不留**，协议漂移时无声。建议补告警日志，不改判定。

### 3.2 我们更成熟的地方（无需动）

- **`error` 通知 + `willRetry` 过滤 + exactly-once 终态**（`codexNormalizer.ts:670-708`）：dsh 根本不监听 `error` 方法，只等 `turn/completed`，因此没遇到我们踩过的「error 帧先于 turn/completed 到达、二次 `session.failed`」问题。我们的 D47 S4a 三点修复是净领先。
- **`availableDecisions` 四条规则**（`codexDecisions.ts:146-198`）：顺序保服务端序、`omitted` 只计真未映射项、`deny` 恒供、`cancel` 绝不自造。dsh 只有 `cancel > decline > 抛错` 三行。
- **完整交互面**：权限卡 / 提问桥 / resume / 历史投影，dsh 的 provider 全无。

### 3.3 一处双向互证（非分歧）

`availableDecisions` 缺失时：我们回落 `['allow','deny']`（因 file_change 审批**正常就不带该字段**，`codexDecisions.ts:124-130` [契约+实测]）；dsh 回落 `'decline'`。两边前提不同（它无人值守必须拒，我们要弹卡），结论不冲突——但**「该字段可缺失」这一事实获得了第二个独立实现的佐证**，加固我们原有的 [契约+实测] 判定。

### 3.4 处置建议

| 项 | 建议 | 量级 |
|---|---|---|
| ① phase 建模 | 立小票：给 `CODEX_ITEM_RULES.agentMessage` 加 phase 分档 + commentary 处置拍板（我们是交互客户端，commentary 未必要丢，可能该进独立通道）+ 三臂测试 | S~M，需拍板 |
| ② contextWindowExceeded | 立小票：`classifyCodexTurnError` 加第二类 + UI 定向文案 | S |
| ③ 未知 status 日志 | 顺手补 | XS |

## 4. 可借鉴的工程纪律（已落规范，见 `agent-project-engineering.md` 附录）

- **`model-visible ⟺ logged`**：抵达模型请求的一切必须能从日志重建，并由运行时不变量断言。我们切片 5 的「重投影丢 reasoning·exec」正是这条没立住。
- **投影单元 `stateVersion`**：投影定义 = 三个纯同步函数（`init`/`apply`/`view`）+ 版本号；版本变更即丢弃旧持久缓存，而非把陈旧状态往前叠加。`apply` 对不关心的事件必须返回**同一引用**（`Object.is` 即零下游开销）。
- **空壳必须写理由 + 机械门禁**：每包必配 `./invariant` 插件，无可检查项时导出空安装器并以 `No runtime invariant:` 开头写明**该包为何没有**；`verify-package-invariants` 机械拒收无解释空壳。这是我们「同名空壳/生产者缺席」人工检查法的机械化版本。

另有两条备选（未落，存念）：`type-equiv` 围栏（文档贴的签名/JSDoc 与源码逐字一致，`verify-type-equiv` 把门）、生成式目录（config/tool/persistence/module-graph 全生成 + 新鲜度校验）。

## 5. 不建议抄

Cordis 内核本体、Typert 编译期 RPC 生成、client 模块热挂载图。我们是 Electron 单机 IPC、两端同仓同构建；引入这套需付出 host/client 双 tsconfig aggregate + 两轮 tsdown + SRC 回退机制的构建复杂度，收益不成比例。

## 6. 战略：dsh 作为第三 backend（**只存念，不立项**）

### 6.1 两条接入口，各缺一半（决定性事实）

dsh 提供两个「把 harness 当子进程驱动」的标准口子。**没有一条能支撑我们现有的产品形态**，各缺的那一半恰好互补：

| | ACP server（`packages/acp`） | SDK JSON-RPC server（`packages/sdk/server`） |
|---|---|---|
| 事件保真 | ❌ 自述 **automation-only**：只发 committed message，**不发原始 delta**，不暴露 reasoning / plan / tool presentation / commands / modes | ✅ **`streams every durable fact as session.event`** + `session.status` 生命周期——全量会话事件，保真度够我们建时间线 |
| 权限审批回传 | ✅ 有 `session/request_permission`（one-shot allow/reject） | ❌ **server→client request 是 dead capability**——传输层支持，服务端从不发；README 明文 "for future approval flows" |
| 打断 / 取消 | ✅ `session/cancel` | ❌ **无 per-prompt cancel、无 per-session close**（SDK 创建的 agent 活到进程 shutdown，明列 Known Limitations） |
| 回合终态 | ✅ `stopReason` | ❌ 无 per-prompt result（`MessageId` 只标 inbox 受理），区间要客户端自定义 |

落到我们的 UI：**走 ACP 则时间线退化**（无流式、无思考块、无工具卡）；**走 SDK 则 Stop 按钮、权限卡、提问卡三个都落不了地**。补齐路径只有两条：等它实现（approval flow 已被官方列为 future work），或我们自己写 dsh 插件补上（等于成为 dsh 生态贡献者，并绑定其 developer preview 的破坏性变更节奏）。

### 6.2 计费模式不构成障碍（2026-08-18 用户更正，原判断作废）

> **原文错误**：本节曾写「我们当前价值是『你已有的 CC/Codex 订阅配个 GUI』，换 dsh = 用户自掏 API key 按 token 计费，是换商业模式」。**该前提不成立，已作废。**

实况：本项目本来就走 **URL 形式的 API 调用**计费，D47 登录托管做的是「员工登录后自动获取密钥下发」，替代员工手工配置那一步——**不是订阅额度模式**。因此换后端**不涉及计费模式变更**，商业障碍基本不存在。D47 那条链的资产是「密钥托管与下发」，它与后端是谁**部分解耦**（需评估的只是新后端的凭据注入口，pi-ai 的 `apiKeyEnv` 是按 route 的凭据*引用*，与我们的托管下发模型天然兼容）。

余下真实门槛只剩 §6.1 的接口面缺口，以及 §6.3 的 loop 归属问题。

### 6.3 pi-ai 与 dsh 的分层（实测澄清）

用户问：多模型能力来自 dsh 还是 pi-ai？pi-ai 自带 loop 吗？**实测答案：多模型来自 pi-ai；loop 来自 dsh；pi-ai 没有 loop。**

证据：

- npm registry 元数据（`@earendil-works/pi-ai@0.84.2`）自述 **`Unified LLM API with automatic model discovery and provider configuration`**，keywords `openai / anthropic / gemini / bedrock / unified / api`，依赖为各家官方 SDK（`openai`、`@anthropic-ai/sdk`、`@google/genai`、`@aws-sdk/client-bedrock-runtime`）。exports 为 `.` / `./api/*` / `./oauth` / `./compat` / `./providers/*` / `./bedrock-provider`——**无 agent / loop / tool-runner 导出**。
- dsh 侧只消费了四个运行时符号：`createModels`、`getSupportedThinkingLevels`、`Models.streamSimple(model, context, options)`、`isContextOverflow`（`packages/llm/llm-pi-ai/src/{adapter,provider,stream}.ts`），其余全是类型。`streamSimple` 是**单次模型调用**：喂 context（消息 + 工具定义）→ 流式吐 assistant events。
- 「拿到 `tool_call` → 执行工具 → 结果回灌 context → 再调一次」这一圈在 dsh 自己的 `core/agent-loop`（`ctx.agentLoop`，architecture.zh.md §核心包）。

**分层结论**：pi-ai 负责 provider 差异、模型目录发现、流式、工具 *定义* 的跨家翻译、thinking level 映射、上下文溢出判定；**工具的执行与回灌、权限把关、会话日志、压缩、系统提示词组装、subagent 全部是 dsh 那一层。** 两者不可互相替代。

附带线索（未验证）：pi-ai 导出 `./oauth` 与 `./bun-oauth`，可能支持 provider 的 OAuth 登录而不止 API key——若属实，与「员工登录自动获取凭据」的现有模型可能有协同点，值得单独取证。

### 6.4 三条路径重估（B 的代价被上一版高估）

| 路径 | 做法 | 拿到什么 | 代价 |
|---|---|---|---|
| A 接 dsh | 外包整个 agent 层 | loop + 工具集 + 沙箱 + 压缩 + 多模型，全套 | 走 §6.1 那道窄门（无审批回传 / 无 cancel）；绑 developer preview 的破坏性变更节奏 |
| B pi-ai + 自研薄 loop | 只借模型层，loop 跑在我们自己进程内 | 多模型 + **完全掌控**；**现有 UI / 权限卡 / 提问卡 / 会话存储 / 流式管道 / 中断全部可直接复用**，无窄门问题 | 要自写 loop 内核：系统提示词组装、工具集、工具执行与回灌、沙箱、上下文压缩 |
| C 维持现状 | 继续做 CC/Codex 的 GUI | 零成本 | 模型面永远受限于两家 CLI |

> **上一版判断修正**：曾写「B 等于重造 CC/Codex 核心，当前人力下不现实」。这**高估了 B**：我们已经有了 loop 的全部*外围*（UI、权限/提问桥、会话存储与历史投影、流式批处理、看门狗与中断），缺的只是*内核*那一圈。B 的真实代价是「写一个 agent 内核」，属中等偏重，不是不现实；且它没有 A 的接口面窄门。
>
> B 的真实风险在别处：**工具集质量**（CC 的 Edit/Grep 等是多年打磨的）、**沙箱安全面**、**提示词工程**——想在编码能力上对齐 CC 基本不可能。
>
> 因此 B 的合理形态是**降档定位**：pi-ai + 薄 loop 只做「多模型通用对话 + 轻量工具」档，与 CC/Codex 的「重编码」档并列，而非取代。三条路径**可以共存**：CC / Codex / 第三档，由用户按任务选。

**本轮拍板：只讨论与调研，不做任何代码修改。A 与 B 均记入 ideas 不立项。**

### 6.5 路径 D：把 `pi` 当第三条 CLI 后端（本次调研的最优解候选）

**澄清一处混淆**（用户反馈「pi 我用过，配置好就能用」与 §6.3「pi-ai 无 loop」的矛盾）：**两者都对，指的不是同一个包。**

`earendil-works/pi` 是一个**完整的编码 agent CLI 产品**，内部分包：

| 包 | 角色 |
|---|---|
| `@earendil-works/pi-coding-agent` | **CLI 产品本体**，`bin: { pi: dist/cli.js }`，自述 *Coding agent CLI with read, bash, edit, write tools and session management* |
| `@earendil-works/pi-agent-core` | **agent 运行时**（loop + 工具调用 + 状态管理） |
| `@earendil-works/pi-ai` | 统一多 provider 模型层（§6.3 实测的那个，**确实无 loop**） |
| `@earendil-works/pi-protocol` | **协议独立成包**（意味着接入方可取到类型定义） |
| `pi-tui` / `pi-client` / `pi-telemetry` | 终端 UI / 客户端 / 遥测 |

所以「配置即用」用的是 CLI 产品（loop 在 `pi-agent-core`）；§6.3 对 `pi-ai` 的实测结论不变。用户「它是不是把市面上的 SDK 都收进来了」的判断也**成立**——`pi-ai` 的依赖正是 `openai` + `@anthropic-ai/sdk` + `@google/genai` + `@aws-sdk/client-bedrock-runtime`。

#### 为什么它可能是最优解

`pi` **完全符合我们现有的接入模式**，第三套是熟路：

| 能力 | pi 提供 | 我们已有的同构件 |
|---|---|---|
| 进程集成 | `--mode rpc`：**LF-delimited JSONL over stdin/stdout** | `src/agent-host/index.ts` 就是 stdin/stdout NDJSON 协议循环 |
| 事件流 | `--mode json`：全事件 JSON lines | `eventNormalizer.ts` / `codexNormalizer.ts` |
| 会话历史 | `~/.pi/agent/sessions/` **JSONL 按 cwd 组织 + 树结构** | `historyReader.ts`（CC JSONL）、`codexHistoryReader.ts` |
| resume / fork | `-c`、`-r`、`--session <path\|id>`、`--fork` | 现有 resume 链 |
| 配置管理 | `~/.pi/agent/settings.json` + 项目级 `.pi/settings.json`；`--provider` / `--model` / `--api-key` / `--thinking` | `claudeSettings.ts`、`codexHome.ts`、`codexSettingsUpdate.ts` |
| 内置工具 | `read, bash, edit, write, grep, find, ls` | 时间线工具卡直接可用 |
| 一次性运行 | `-p/--print`（支持管道 stdin） | headless 场景 |

**与 dsh 两条通道的对比**——pi 比它们都更接近可用：

| | dsh ACP | dsh SDK | **pi `--mode rpc`** |
|---|---|---|---|
| 事件保真 | ❌ 只发 committed message | ✅ 全量 | ✅ 全事件 JSONL |
| 权限审批 | ✅ | ❌ dead capability | ⚠️ **无内置**，但有扩展点（见下） |
| cancel / 会话管理 | ✅ / 弱 | ❌ 无 cancel、无 close | ✅ 会话树 + fork + resume |
| 多模型 | 靠 pi-ai | 靠 pi-ai | **靠 pi-ai（同一个库）** |

#### 唯一硬缺口：权限审批

pi 的原话是 **No built-in permission popups**，哲学是 *Run in a container, or build your own confirmation flow with extensions*。它给的是 `--tools` / `--exclude-tools` / `--no-builtin-tools` 白黑名单 + 容器隔离（Gondolin / Docker / OpenShell 三种方案），**不是逐次审批**。

对我们意味着：现有的权限卡与提问卡要么改由 pi extension 自建 confirmation flow 回传（**未验证：extension 能否在 `--mode rpc` 下把审批请求经协议通道传出**），要么该后端降档为「白名单 + 容器」的权限模型，与 CC/Codex 的逐次审批档并列但不同构。**这是接入前必须先取证的第一件事。**

#### 未验证项（立项前必须取证）

1. `--mode rpc` 的**具体协议形态**（帧格式、事件类型、是否有 server→client request 方向）——本档只依据 README 描述，未读源码/未实跑。
2. **extension 机制能否在 rpc 模式下回传审批**（决定权限卡能否保留）。
3. pi 对 **DeepSeek / GLM** 的实际覆盖——README 只列 OpenAI/Anthropic/Google/Bedrock，但 pi-ai 有 `./compat` 与自定义 provider 声明，OpenAI 兼容网关路径理论上可覆盖，需实测。
4. **项目成熟度与维护强度**（版本 0.84.2，与 pi-ai 同步版本号；无 ACP 支持）。
5. 凭据注入口与 D47 托管下发链的对接方式（`--api-key` flag / 环境变量 / `/login`）。

#### 路径重排

| 路径 | 评价 |
|---|---|
| **D 接 `pi` CLI 为第三后端** | **成本最低、与现有架构最同构**；缺口集中在权限审批一处，且有扩展点可探。**建议作为「支持 gemini/DeepSeek/GLM」需求的首选评估对象。** |
| A 接 dsh | 两条通道各缺一半，且绑 preview 变更节奏。次选。 |
| B pi-ai + 自研薄 loop | 完全掌控但要自写 loop 内核；只在 D 与 A 都被否掉时考虑。 |
| C 维持现状 | 满足不了「更多模型」的诉求。 |

### 6.4 与 D45/D46 的关系

这是「ACP 正被厂商当作 agent 互操作层采纳」的一个新证据点，可作 ACP 裁定的输入，但不改变现有排期（阶段 4 = 2b 打包链）。同时 §6.1 给出一条**反向证据**：ACP 的 automation-only 定位使其不适合承载高保真交互 UI——这对 D45/D46 的裁定方向有直接影响。

## 7. `pi` 深度探查结果（2026-08-18，用户授权后执行）

取证方式：浅克隆 `earendil-works/pi`（`/tmp/pi-probe`，27M）读源码与 `packages/coding-agent/docs/` 全套文档（31 篇）。

### 7.1 五个未验证项的结论

| # | 项 | 结论 |
|---|---|---|
| 1 | `--mode rpc` 协议形态 | ✅ **证实**：JSON 命令逐行进 stdin，事件逐行出 stdout；命令带可选 `id` 做请求/响应关联；**严格 JSONL，LF (`\n`) 是唯一记录分隔符** |
| 2 | extension 能否回传审批 | ✅ **证实且是活通路**（详见 §7.2） |
| 3 | DeepSeek / GLM 覆盖 | ✅ **全部内置**（详见 §7.3） |
| 4 | 成熟度 | 0.84.2；文档 31 篇、协议独立成包（`@earendil-works/pi-protocol`，含 cbor/codec/framing/schemas）、会话格式已演进到 v3 且自动迁移。**无 ACP 支持** |
| 5 | 凭据注入口 | `--api-key` flag / 各家环境变量 / `~/.pi/agent/auth.json` / `/login` OAuth；auth.json 自动刷新 |

### 7.2 权限审批：dsh 缺的那一半，pi 有

**这是 D 路线最后一个硬缺口，现已解除。**

- extension 可**拦截并阻断工具调用**：`on("tool_call")` 明列能力为 *Block or modify tool calls*，官方示例文件就叫 `permission-gate.ts`（用途 *Block dangerous commands*，机制 `on("tool_call")` + `ui.confirm`）。
- **RPC 模式下有完整的双向 UI 子协议**：`ctx.ui.select()` / `confirm()` / `input()` / `editor()` 会向 stdout 发 `extension_ui_request` 并**阻塞**，直到客户端从 stdin 回 `extension_ui_response`（id 匹配）。文档原文示例即：

```json
{"type":"extension_ui_request","id":"uuid-1","method":"select",
 "title":"Allow dangerous command?","options":["Allow","Block"],"timeout":10000}
{"type":"extension_ui_response","id":"uuid-1","value":"Allow"}
```

- 另有 fire-and-forget 档（`notify`/`setStatus`/`setWidget`/`setTitle`），可喂我们的状态行。
- 带 `timeout` 的对话框由 agent 侧自动兜底解析，**客户端不必自己追超时**。
- RPC 模式下 `ctx.hasUI === true`、`ctx.mode === 'rpc'`；退化的只有真 TUI 专属项（`custom()`、`setFooter()` 等）。

**对我们的意义**：现有权限卡 / 提问卡可保留，接法是写一个 pi extension 做 permission gate，把审批经 `extension_ui_request` → 我们的 UI → `extension_ui_response` 回灌。这与我们现有的 `permissionBridge` / `questionBridge`「停靠 pending + 单次 settle」模型完全同构。

> 对比：dsh SDK 通道的 server→client request 是 dead capability（明文 for future approval flows），dsh ACP 有审批但无 delta。**pi 是三者中唯一两头都有的。**

### 7.3 模型覆盖：用户诉求全中

**API key 档（内置，环境变量或 `auth.json`）**：Anthropic、OpenAI、**DeepSeek（`DEEPSEEK_API_KEY`）**、**Google Gemini（`GEMINI_API_KEY`）**、**ZAI Coding Plan 即智谱 GLM（`ZAI_API_KEY`，另有 China route `ZAI_CODING_CN_API_KEY`）**、Mistral、Groq、Cerebras、xAI、NVIDIA NIM、Amazon Bedrock、Azure OpenAI、Cloudflare AI Gateway / Workers AI、OpenRouter、Vercel AI Gateway、OpenCode Zen/Go、Ant Ling 等。

**订阅 OAuth 档**：ChatGPT Plus/Pro (Codex)、Claude Pro/Max、GitHub Copilot、xAI、OpenRouter(PKCE 铸 key)、Radius。token 存 `~/.pi/agent/auth.json` 并自动刷新。

**自定义档**：`custom-provider.md`（777 行）+ `models.json` 声明；OpenAI 兼容网关 / 自托管 / llama.cpp 均为配置项。模型目录可刷新并缓存到 `~/.pi/agent/models-store.json` 供离线用。

**结论：用户提出的 gemini / DeepSeek / GLM 三者全部内置，无需自定义配置。**

### 7.4 可借鉴项（回答「参考 pi 优化我们的设计」）

| pi 的做法 | 我们的现状 | 借鉴价值 |
|---|---|---|
| **会话文件树结构**：JSONL 单文件内以 `id`/`parentId` 成树，**原地分支不新建文件**；`/tree` 可跳到任意历史点续跑并切分支，`/fork` `/clone` 分别派生 | 我们是线性消息桶 + `h:*` 前缀历史灌入，无分支概念 | **高**。分支/回溯是产品级能力，且它证明了单文件内建树可行，不必拆文件 |
| **会话格式版本 + 自动迁移**：v1 线性 → v2 树 → v3 角色改名，载入时自动迁移到当前版本 | 我们无格式版本位 | **高**，与附录 A2 的 `stateVersion` 同源思想 |
| **会话路径按 cwd 编码**：`~/.pi/agent/sessions/--<path 用 - 替 />--/<timestamp>_<uuid>.jsonl` | 我们有 SessionIndexService 索引 | 中，可对照索引策略 |
| **配置两层 + 项目信任**：`~/.pi/agent/settings.json`（全局）← `.pi/settings.json`（项目）覆盖；**加载项目配置前要过 trust 门**（`trust.json` 记决定，含父目录继承），**非交互模式不弹信任框**，改由 `defaultProjectTrust`（`ask`/`always`/`never`）决定，可用 `--approve`/`--no-approve` 单次覆盖 | 我们有 claudeSettings / codexHome，无项目级信任模型 | **高**。项目级配置=可执行代码入口（扩展/技能），信任门是必要的安全设计，我们做 D48 权限面时缺这一层 |
| **thinking 七档** `off/minimal/low/medium/high/xhigh/max` + `thinkingBudgets` 按档配 token 预算 | 我们思考档按 agent 适配（D48） | 中，档位划分可参照 |
| **协议独立成包** `pi-protocol`（cbor/codec/framing/schemas） | 我们 `src/shared/types/` 是协议汇合点 | 中，独立成包便于第三方接入 |

### 7.5 ⚠️ 反向收获：查出我们自己一个真 bug（U+2028 丢帧）

pi 的 `rpc.md` 明确警告：

> Node `readline` **is not protocol-compliant** for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

**我们三处在用 `node:readline`**（第三处经用户追问「文件读取」后补查发现，风险最高）：

| # | 位置 | 影响面 | 风险 |
|---|---|---|---|
| 1 | `src/main/services/agent-host/AgentHostProcess.ts:60` | Main 读 Host stdout —— **全部 Runtime Event，CC 与 Codex 两条线都过这里** | 高 |
| 2 | `src/agent-host/index.ts:976` | Host 读 Main stdin —— **全部命令，含用户消息** | 高 |
| 3 | `src/agent-host/historyReader.ts:369` | 读 **CC 会话 JSONL 文件**（`createReadStream` + `createInterface`） | **最高**：历史文件内容全是自然语言，含 U+2028 的概率远高于控制帧；且**宽容解析会静默跳过坏行**——用户只看到历史少一条消息，不报错 |

**同仓已存在正确写法作对照**：`historyReader.ts:1089` 的 `buffer.toString('utf-8').split('\n')` 是 LF-only 切分。一仓两法并存，坐实这是疏忽而非设计选择。

**不受影响**：`codexHistoryReader.ts` 是纯投影函数（从 app-server `thread/*` 响应投影），不读文件。Codex 历史走协议通道。

**实测坐实**（Node v24.18.0，即我们随包版本）：一条 JSON 字符串值中含 U+2028 的帧，被 readline 切成两半，**两半都 `JSON.parse` 失败，整帧丢失**；LF-only 切分则正确解析为 1 条。

```
readline  -> lines=2 parsed=0 failed=2
LF-split  -> lines=1 parsed=1
```

**触发路径（现实）**：U+2028/U+2029 是合法 Unicode 字符，可经①用户粘贴网页文本（我们有粘贴通路 T-18/C-13）②模型输出③**读文件类工具的结果回传**（源码文件含 U+2028 在 JS 生态是真实存在的历史坑）进入协议帧。

**后果**：该帧被静默切碎 → 解析失败 → 事件丢失或流中断。`crlfDelay: Infinity` 只处理 CRLF，**不解决此问题**。

**修法**：改为自建 buffer 累积器，只按 `\n` 切分并容忍尾部 `\r`（即 pi 文档给客户端的三条规则）。量级 S，三处对称改，需补 U+2028/U+2029 变异臂。

**pi 自身在这一点上没有可借鉴的实现**：查其 `packages/coding-agent/src/core/session-manager.ts` —— `:697` 读 session 文件同样用 `createInterface`，`:301` 处才是正确的 `content.trim().split("\n")`。它只在给**客户端**的 `rpc.md` 里写明了这条规则，自己读文件时同样中招。**可借鉴的是那条规则本身，不是它的代码。**

**与加密设备（TSD）的关系：正交，不是同一个问题。** TSD（TEC Solutions OCular Agent）加密 Node.js 进程写出的文件，导致 Host 进程读回原始加密字节——那是文件**能否读到明文**的问题，我们的处置是探测 `TSD_MAGIC` 并报 `encrypted_unreadable`（`historyReader.ts:80-89`、`:146-156`，镜像 `src/main/utils/tsdSafeRead.ts`），这套处置合理且与本 bug 无关。本 bug 是文件**已读到明文之后怎么切行**。pi 作为通用开源产品不涉及 TSD 这类特定企业加密方案，此处无可借鉴项。

**已记入 ideas，本轮按拍板不动代码。**

## 8. 溯源

- 仓库 <https://github.com/deepseek-ai/deepseek-harness> · [README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md) · 官网 <https://deepseek.com/harness/en/>
- 关键文档：`docs/architecture.zh.md`、`docs/capability-seams.zh.md`、`docs/api-gateway.zh.md`、`docs/subsystems/{session-projection,invariants,permission-presets,user-questions,subagent,client-modules}.zh.md`
- 关键源码：`packages/subagent/subagent-codex/src/{wire,run}.ts`、`packages/subagent/subagent-claude-code/README.md`、`packages/acp/acp/README.md`
- 状态提醒：dsh 处于 developer preview，明示会有破坏性变更；上述判定随时可能失效，引用前须重新取证。

## 9. 拍板记录（2026-08-18，当场问答收口）

| # | 议题 | 拍板 |
|---|---|---|
| 1 | 线协议完整性小批（§3.4 ①②③ + §7.5 三处 readline） | **立即立项，排阶段 4 打包链之前**；F8 historyReader 分支盲**不并批**，维持分诊「另立票」原判 |
| 2 | commentary 去向（§3.1 缺口①） | **O1 取证先行**：借 rollout 免额度法抓 commentary 实帧 + 查 Codex 自家 TUI 渲染先例；有清晰先例直接照做不再回问，查无先例再回来从 O2/O3 挑 |
| 3 | pi 第三后端评估 spike（§6.5/§7） | **立为 multi-agent 阶段 5 候选，打包链收口后启动**；spike 范围 = `--mode rpc` 实跑 + permission-gate 扩展回环验证 + DeepSeek/GLM 实测 + 凭据注入对接 D47 评估 |

附带（无需拍板，已执行）：F7（回退/分叉会话）规格阶段须引用本档 §7.4 会话树设计——ideas 对应条目已升格标注。

**协议小批的施工范围（下会话 pickup 即可动工）**：
1. U+2028/U+2029 丢帧三处对称修（`AgentHostProcess.ts:60` / `agent-host/index.ts:976` / `historyReader.ts:369`）——LF-only 累积器 + 容忍尾部 `\r` + U+2028/U+2029 变异臂；
2. `classifyCodexTurnError` 增 `contextWindowExceeded` 分类 + UI 定向文案；
3. 未知 `turn.status` 告警日志（`codexNormalizer.ts:680`，不改判定）；
4. `CODEX_ITEM_RULES.agentMessage` phase 机械建模（读字段、透传、未知值日志不炸）；
5. commentary 取证 spike（拍板 2 的 O1 半边），取证结果决定渲染侧是否随批落地。
