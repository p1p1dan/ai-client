# S2 直连 Codex 接入设计（合流仲裁后的单一施工档）

> **2026-08-06 落库。** plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。
> 前置：[S1 spike 报告](./2026-08-06-s1-acp-codex-spike-report.md)（裁定「不接 ACP，直连 `codex app-server`」）。
>
> 输入四路：S2-a（U1 提问实测，**花了 4 个真实回合**）/ S2-b（会话↔agent 绑定，**Opus + Codex 双轨双盲**）/
> S2-c（权限投影）/ S2-d（历史降级）→ 仲裁员合流 → **编排者复核与裁定（§0.5）**。
> 本档**取代**四份原档在冲突面上的表述；未被覆盖的细节仍以各自 notePath 为准。
>
> 标注纪律：`[实测]` = 有原始报文或源码证据且经复核；`[读码]` = 源码可证；`[推测]` = 仍是推测，不得升格。

---

## 0. 仲裁员新增的一手证据（三份设计都没看到，直接改判两条）

| 证据 | 落点 | 影响 |
|---|---|---|
| 仓内**已有两套 agent 词表**：`BuiltinAgentId = 'claude'\|'codex'\|'droid'\|'gemini'\|'auggie'\|'cursor'\|'opencode'`（终端 CLI 启动器）；`AIProvider = 'claude-code'\|'codex-cli'\|'cursor-cli'\|'gemini-cli'`（提交信息/代码评审等一次性助手） | `src/shared/types/cli.ts:1`、`src/shared/types/ai.ts:1` | 推翻 b 的「本仓无 agent 枚举、新枚举即唯一枚举」前提；改判 C1/C2 |
| 全仓已有 **24 处 `'claude-code'` 字面量**（全在 AIProvider 域） | `src/renderer/stores/settings/defaults.ts:180/190/224/235`、`AISettings.tsx` 8 处、`main/ipc/git.ts` 3 处等 | b 的静态扫描 ② 若按原文落地**第一次运行就红**；改判 C2 |
| `runtimeEvents.ts` 里 `agentId?: string` 已被占用，含义是 **Claude 子代理 id**（`task_started.task_id`） | `runtimeEvents.ts:250`、`:467` | b 的新类型若叫 `AgentId` 会与同文件同名字段语义相撞；改判 C1 类型名 |
| `recordCreated` 不接收 runtimeIdentity（只 `existing?.runtimeIdentity` 透传），`recordResumed` 才必填 | `SessionIndexService.ts:45-62/64-82` | 坐实 b 的「逐字段重建」坑，且**推出 d 的隐藏前置**：Codex threadId 只能靠 b 的 `applyRuntimeEvent` 改造落盘，见 C3 |
| flag 机制：本仓无通用 flag 层，但有 env 开关先例 `AICLIENT_HOST_SUBAGENT_ACTIVITY`（`claudeRuntime.ts:141-145`，默认开的 kill switch）与 `AICLIENT_AGENT_HOST_DRIVER`（`index.ts:20`）；Main 向 Host 注入 env 的位置 `AgentHostManager.ts:408` / `AgentHostProcess.ts:48` | — | §4 flag 方案照此形状，不新造机制 |
| `HostErrorEvent.payload.code` 是自由 `string`（无枚举） | `runtimeEvents.ts:97-103` | b 的 `unsupported_agent` 不构成协议改动，只是新值；见 C11 |

---

---

## 0.5 编排者裁定与双轨合并（2026-08-06）

四路产出**未直接采信**。本节记录：① 用户裁定 ② 编排者按先例就地裁定 ③ **S2-b 双轨（Opus + Codex 双盲同题）的收敛与分歧仲裁** ④ 复核中新发现的一项 ⑤ 其余未决项的默认取值。

### ① 用户裁定：wire 名 = `'claude-code'` / `'codex'`（不可逆，已追认）

用户 2026-08-06 追认。**追认前先澄清了一处理解偏差，一并记入**：

> 用户问「wire 名是给软件用的，还是会话传输中会用到？是 `claude-cli/2.1.223 (external, cli)` 这种东西吗？」

**不是。** wire 名**不出本机**，只活在两处：`session-index.json` 的落盘字段 + renderer↔main↔agent-host 的
NDJSON 进程间协议。它回答的是「这条会话交给哪个运行时跑、用哪个 reader 读历史」。
`claude-cli/2.1.223 (external, cli)` 是 **Anthropic 自己的 `cli.js` 发给 Anthropic API 的 User-Agent**，
我们既不设置也接触不到——全仓 grep 确认自有源码零处 user-agent 处理，命中全在 `node_modules`。[实测]

**取 `'claude-code'/'codex'` 的理由**：两者都是产品全名（Anthropic 的 CLI 产品名就是「Claude Code」；
OpenAI 的包名 `@openai/codex` 与二进制名都是 `codex`），并非凑不对称；且 `'claude'` 留空，
将来若加「直连 Anthropic API 而非走 CLI」的 agent 有位置放。
代价是与仓内 `BuiltinAgentId`（终端轴，值恰为 `'claude'/'codex'`）不同字——由 C2 第 3 条静态断言兜住。

### ② 编排者裁定：`isSecret` 渲染端补掩码（推翻原「本轮不做」）

原案是「只进协议、渲染端当普通文本」，理由是实测 10/10 恒 false（零样本）。**推翻，理由两条实证**：

1. **最近参照物做了掩码**：codeg 的问答卡有 `is_secret: bool`，注释原文
   「codex `request_user_input` marks API keys etc. with `_meta.codex.isSecret`: **the card masks the
   free-text input**」（`/home/dan/projects/codeg/src-tauri/src/acp/question.rs:89-93`）。[实测]
   注意它走 ACP 时这个位藏在 `_meta` 里要专门捞；**我们走直连，它是一等字段，接住反而更省事**。
   对照：ACP 官方 schema 全文只出现 1 次 "secret"，无一等支持——这个位是 codex 特有的。[实测]
2. **与本仓自有立场冲突**：T-35 刚落的 `stderrRedaction.ts` 是 Host 侧**摧毁式脱敏**
   （provider 裸 key 全形态 / Bearer/Basic / URL userinfo 全抹）。既已立「密钥不许进 UI」的规矩，
   再让用户手打的密钥明文躺在时间线里就是自相矛盾。

**零样本不等于不会发生，而密钥进会话历史不可撤销。** 成本 +20–30 行渲染代码，接受。

### ③ S2-b 双轨（Opus / Codex 双盲同题）合并

按用户既定的高风险规则，**唯一不可逆的一项**走双轨。两轨互不见对方答案。

**独立收敛 6 处（可当定论）**：

| # | 两轨独立得出的同一结论 |
|---|---|
| 1 | 绑定字段**只落 session 层**，workspace 不放（两轨给出同一反例：同 workspace 必须能并列 Claude 与 Codex 会话） |
| 2 | **不补 `schemaVersion`**（Opus 给出更硬的机制理由：顶层信封化 → 老版本 `for-of` 抛错 → catch 只 warn → 空表启动 → 下次 flush 写回 `[]` → **全部会话索引静默清零**） |
| 3 | **唯一回落点**纪律：`undefined → legacy` 全仓只许一处 |
| 4 | `runtimeIdentity` **不得兼任** agent 类型，保持不透明；禁止按字符串形状反推 agent |
| 5 | 侧栏**平行**加 agent chip，不改造现有 branch/kind chip |
| 6 | **`applyRuntimeEvent` 的早退守卫必须放宽** —— 两轨**各自独立命中同一处**（`SessionIndexService.ts:139-142` 的 `if (!runtimeIdentity) return`，而 `claudeRuntime.ts:308-310` 新建会话的 `session.created` 恰恰没有 runtimeIdentity）。互不见对方却指向同一行，**这条基本可当定论** |

**分歧 3 处，逐条仲裁**：

| 分歧 | Opus | Codex | 裁定与理由 |
|---|---|---|---|
| wire 值 | `'claude-code'/'codex'` | `'claude'/'codex'` | **上交用户**（不可逆）→ 已裁 `'claude-code'/'codex'`，见 ① |
| 字段名 | `agent` | `agentType` | **取 `agent`**（仲裁员判据成立：`runtimeEvents.ts:250/467` 的 `agentId?: string` 已被占用为「Claude 子代理 id」，`agentType` 与之同屏会持续误读）[实测] |
| **唯一回落点落在哪一层** | renderer 的 `mergeSessionIndex`（物化点） | Main 的 `ensureLoaded`（反序列化边界） | **取 Opus，但仲裁员给的理由不成立，理由由编排者补强**（见下） |

**回落点分歧的决定性证据（编排者复核新增）**：

Codex 主张在 `ensureLoaded` 规范化，论点是「Main 读完后内部世界不再存在 agent 未知」——架构上更彻底。
**但它与 Codex 自己的否决项打架**。核源码：

```ts
// SessionIndexService.ts:193-203
private async flush(): Promise<void> {
  const entries = [...this.entries.values()];   // ← 写的是整张表
  ...  await writeJsonAtomically(path, entries);
}
```

若在 `ensureLoaded` 把 `undefined → 'claude-code'` 灌进内存 Map，则**之后任何一次 flush**
（改一个标题 / 归档一条 / 来一个 `session.created`）都会把 `agent` **写回磁盘上每一条老会话行**。
这正是 Codex 在自己 §3 否决项里写明要避免的「**否决启动时批量重写旧 JSON：把兼容读取变成不可逆写迁移**」。
→ **落点定在 renderer 的 `mergeSessionIndex`（`SessionIndexEntry[] → ChatSession[]` 的唯一入口，
唯一调用者 `useSessionIndex.ts:53`）**，磁盘侧永远保持「老行就是没有这个字段」。[实测]

补充核实：`SessionIndexService` today 没有任何 Main 侧消费者按 agent 分派运行时
（公开面只有 `list/recordCreated/recordResumed/rename/setArchived`），
故 renderer 侧物化足够；将来若出现 Main 侧消费者，应调用共享的 `resolveAgentWireName`，**不得再normalize 一次**。[实测]

### ④ 复核新发现：还有一个「对外身份」要定，别与 wire 名混为一谈

S1 原始报文里拍到：

```
我们发 →  "clientInfo":{"name":"s1-codex-direct-probe","title":"S1 spike","version":"0.0.1"}
codex 回 →  "userAgent":"s1-codex-direct-probe/0.145.0 (Ubuntu 26.4.0; x86_64) VTE/8400 (...)"
```

**`codex app-server` 会把我们报的 `clientInfo.name` 揉进 User-Agent 发给 OpenAI。** [实测]
探针里填的是探针名；**生产环境必须换成应用自身标识**（拟 `jyw-ai-client` + `package.json` 的 version）。

这是**对外身份**，与 wire 名（对内归属）是两件事，切片 2 落地时一并定，**不得复用 `AgentWireName` 的值**。
（同理提醒：`initialize` 的 `title` 字段会不会外泄工作区信息，落地前看一眼。）

### ⑤ 其余未决项的默认取值（编排者拍板，用户可随时推翻）

| 项 | 取值 | 一句话理由 |
|---|---|---|
| U2 未知 agent slug 的行 | **隐藏该行**（entry 留磁盘，升级即回来） | 仅降级场景触发，属边缘；显示禁用行要新 UI（+20–40 行）不划算 |
| U3 默认 agent 落点 | **全局 settings**（已有 persist+migration） | per-workspace 是纯加法，将来要再补；现在做等于为假想需求先改形状 |
| U4 Codex 默认权限档 | **`on-request` + `workspace-write` + `networkAccess:false`** | 对齐 codex-acp 生态默认。**硬约束：绝不继承本机 `~/.codex/config.toml`**（实测写的是 `danger-full-access`，继承 = 静默关掉全部审批） |
| U6 历史部分失败表达 | **加 `errors?: Array<HistoryReadError & {agent}>`，单 `error` 只在全失败时填** | 取最严重者会丢信息；静默少列用户不知道少了什么 |
| U7 列历史时临时 spawn app-server | **临时 spawn + 超时静默不列** | 实测 initialize 仅 178–188ms，代价可接受 |
| U8 侧栏第二枚 badge 窄宽 | **并入 GUI 点验清单**，不在设计阶段猜 | 本仓教训：布局缺陷只在截图里显形 |
| U9 剩余 2 个真实回合 | **只花 1 个跑 d 的 U2-a**（实时 `item/completed` 的 item id 是否等于事后 `thread/read` 重投影），**另 1 个留存不预支** | U2-a 是档 C replay-merge 去重的地基，不等就得改按 `toolCallId`/文本去重；另两个候选（`autoResolutionMs` 客户端义务 / `rejected` 回包行为）都有可接受的降级路径，不值得现在花 |
| U10 diff 展示上限 | **暂取 20 文件 / 每 diff 64KB**，标为待真实大补丁样本校正 | c 拍的数，无样本；写成常量便于一处改 |
| U-补 清空历史后原地改绑 | **不做** | C13 已定「已绑定只能 fork」；多一条破坏性入口不值 |


## 1. 冲突清单与仲裁

### C1 【① 协议字段 / 类型所有权】三方各写了一套 agent 词表

- **冲突**：b = 新模块 `shared/types/agentId.ts`，类型 `AgentId`，值 `'claude-code'|'codex'`，字段名 `agent`；c = 判别位写作 `'claude'|'codex'`（自述「跟随 b」）；d = 类型 `AgentWireName`，字段名 `agentType`，回落 `undefined→'claude'`。三个类型名、两个字段名、两个默认字面量。
- **裁定**：
  - 模块：`src/shared/types/agentWire.ts`（新建叶子，零 import）——采 b 的结构，改名以避开下条。
  - 类型名：**`AgentWireName`（采 d）**，否决 b 的 `AgentId`。理由是新证据：`runtimeEvents.ts:250/467` 的 `agentId?: string` 已经是「子代理 id」，而 b/c 要加的字段正落在同一批 payload 里；两者同屏会持续误读。
  - 值：`AGENT_WIRE_NAMES = ['claude-code','codex'] as const`（采 b，**用户 2026-08-06 已追认，见 §0.5-①**）。
  - 字段名：**统一 `agent`（采 b）**，否决 d 的 `agentType`。d 的三处消费点全部改名（见 §2 #18/#19）。
  - 导出面：`AGENT_WIRE_NAMES` / `AgentWireName` / `AGENT_DISPLAY_NAMES` / 模块私有 `LEGACY_AGENT = 'claude-code'` / `isAgentWireName` / `resolveAgentWireName(raw): AgentWireName|null` / `sessionAgent(s): AgentWireName`。
  - 文件头注释必须写明**三轴分离**：`AgentWireName`（聊天会话运行时绑定，持久化、不可改）≠ `BuiltinAgentId`（终端里能起哪个 CLI）≠ `AIProvider`（一次性助手供应商）。三者**互不转换、互不 as-cast**。
- **被否决方的合理内核**：d 的 `agentType` 语义（"哪一种 agent"）保留为注释表述；c 的「不另立枚举」纪律全盘保留并升格为静态断言（C2 第 3 条）。

### C2 【纪律可执行性】b 的静态扫描 ② 落地即红

- **冲突**：b 要求「`'claude-code'` 字面量全仓只许出现在 agentId.ts」；实际已有 24 处（AIProvider 域）。另外 c 的 `ClaudePermissionPolicy = { agent: 'claude-code'; … }` 判别联合**必须**在类型位写字面量。
- **裁定**：扫描规则重写为三条，全部可执行：
  1. **（绝对，不许豁免）** `/\.agent\s*(\?\?|\|\|)\s*['"]/` offenders 必须为 `[]` —— 禁止就地把 `.agent` 默认成字符串字面量（变量兜底合法）。
  2. 字面量扫描**带 allowlist**：`'claude-code'` 的**值位**只允许出现在 `shared/types/agentWire.ts`；`shared/types/runtimeEvents.ts` 的 type/interface 声明位豁免（c 的判别联合）；`shared/types/ai.ts` + AIProvider 消费点整体排除（另一条轴）。实现：先按文件路径过滤，再 `stripComments`。
  3. **新增**：断言 `AGENT_WIRE_NAMES`、`BuiltinAgentId`、`AIProvider` 三张表在源码里**互不引用**（无 import、无 `as` 互转），防止有人用 `session.agent as AIProvider` 串轴。
- **被否决方内核**：b 的「唯一回落点 + 唯一物化点（`mergeSessionIndex`）」原样保留，这是本轮最重要的纪律。

### C3 【④ runtimeIdentity 语义】b 弃权、d 裁定，且发现一条隐藏依赖

- **冲突**：b「不动它，Codex thread id 塞不塞同一字段归 d」；d「保留字段、重定义为 *agent 私有、对我方不透明的恢复句柄*，必须与 agent 配对才可解释，禁止按字符串形状分派」。
- **裁定**：**采 d 的重定义，全文照收**；b 无实质异议。注释落点从 d 的 3 处扩到 **4 处**：`sessionHistory.ts:62`、`agentHost.ts:65`、`sessionIndex.ts:5`、外加**新发现的** `chatSessions.ts:67`（现文「Claude runtime / resume identity when known」同样是错误来源）。静态断言用 d 的 G8。
- **隐藏依赖（本仓新发现，必须写进施工顺序）**：Codex 的 threadId 只在 `thread/start` 之后才存在，而 `recordCreated` 根本不收 runtimeIdentity（`SessionIndexService.ts:45-62` [读码]）→ **不做 b 的 `applyRuntimeEvent` 守卫放宽（`:136-146`），Codex threadId 永远进不了 `session-index.json`，d 的 `thread/resume` 在重启后必然拿不到句柄**。故 **d 的档 C 硬依赖 b 的切片 1**，不可并行合并。
- **相容性澄清**：d 的「历史相关字段一律不进 session-index.json」与上一条不矛盾——threadId 是**恢复句柄（runtimeIdentity）**，不是历史字段；索引里除 `agent` 外不新增任何键。

### C4 【③ 事件 payload】`SessionCreatedEvent.payload` 被 b 与 c 同时扩

- **冲突**：b 加 `agent?`，c 加 `permissionPolicy?`。同一对象两份 diff。
- **裁定**：**一次性合并成一处改动**（切片 0 落类型）：`agent?: AgentWireName` + `permissionPolicy?: SessionPermissionPolicy`。c 的判别位取值改用 `AgentWireName` 的字面量（`'claude-code'`，不是 `'claude'`）。c 冻结 `SessionPermissionMode` 的裁定[读码，三条硬约束我复核了 `contextSurfaceModel.ts:419-421/460-462`]全盘保留。
- 顺序契约：`session.created` 的 `agent` 由**运行时硬编码自己是谁**（b），`permissionPolicy` 由同一常量喂 `thread/start` 与回显（c 的单一真相测试）。两条不冲突。

### C5 【① 命令 payload】`SessionResumeCommand` 被 b 与 d 同时扩

- **冲突**：b `agent?: AgentId`，d `agentType?: AgentWireName` —— 同一字段两个名字，若各自落地就是**两个真相源**。
- **裁定**：合一为 `agent?: AgentWireName`；`SessionCreateCommand` 同。c 主动不加 setter 字段的取舍**保留**（v1 权限只读），因此这条命令本轮只多一个键。
- **被否决方内核**：d 的「Host 按此分派 reader」与 b 的「Host 按此分派 runtime」是同一次分派，写在同一个 switch 里，不许两处各判一次。

### C6 【③ capabilities 形状】b/c 都加位，且 b 自己标了「真正的形状冲突」

- **冲突**：平铺可选布尔 vs 按 agent 分组 `Partial<Record<AgentWireName, {...}>>`。b 加 `agents?: AgentWireName[]`；c 加 `permissionPolicy?: boolean`；d **不加**（改用错误码 `history_unsupported`，反而消掉了第三个诉求）。
- **裁定**：**维持平铺**，加两位即可。同时把 doctrine 写进注释，防止下一轮又摇摆：
  > `capabilities.*` 描述的是 **Host 这个 build 会不会**（进程级），不是「某个 agent 支不支持」。per-agent 差异一律走 `capabilities.agents` 列表 + per-session 的 `session.created` facts。
- 依据：三方合并后**无人**真正需要 per-agent 粒度（d 用错误码、c 是 Host 级归一化器、b 只要一张支持表）。为假想需求先改结构才是净损失。

### C7 【① 命令 payload】listHistory 入参命名

- **裁定**：d 的 `agentTypes?: AgentWireName[]` 改为 **`agents?: AgentWireName[]`**，与 `capabilities.agents` 同名同义（都是"这些 agent"）。缺省 = 只列 claude，老行为逐字节不变[读码：该命令今日零 renderer 消费者，d 实测]。

### C8 【③ 事件 payload / ② store 语义】提问的 `q.id` 缺口（a 的 open issue，属仲裁范围，不上交用户）

- **裁定：采 A** —— `QuestionItem.id?: string`（可选字段追加，不升版，先例 T-14/T-20）。
  - `question.respond` / `question.resolved` 的 `answers` **key 规则改为「有 `id` 用 `id`，否则用问题原文」**；类型 `Record<string,string>` 不变。
  - `runtimeEvents.ts:~304` 现注释「question text (verbatim key)」必须改写为「不透明 key：`QuestionItem.id`（若有）否则问题原文」。
  - 渲染端 `questionCardModel.ts:157` 有 id 时按 id 出 React key。
- **否决 B（Host 自持原文→id 映射表）的决定性理由**：渲染端把答案折进 `Record<原文, string>`，**同回合重复原文在到达 Host 之前就已经被折叠掉了**，Host 侧映射表无从还原 —— 这不是 15 行成本问题，是**信息已丢失**。
- **对 d 的硬约束（跨 agent 历史混形）**：`chatSessions.ts:788` 的 `questionAnswers` 从此是**混合 key 空间**（Claude 旧记录=原文、Codex 新记录=id）。历史回放**必须把它当不透明 key**，不得反查问题文本。
- 老 Claude 影响：**零**（Claude 侧不发 id → 仍走原文分支）。

### C9 【卡层文件撞车】a 与 c 同改 `questionCardModel.ts` / `QuestionCard.tsx` / `ChatBlock`

- **裁定**：不并行，按 切片0（共享类型一次性）→ 切片3（提问卡）→ 切片4（权限卡）串行。`ChatBlock` 的加法**只有 c 的 6 个可选字段**（a 侧不需要新 ChatBlock 字段，`questions?: QuestionItem[]` 已在，id/isSecret 随 QuestionItem 进来）。
- 卡外壳位次：T-34 的 `originChip` 已占 head 下第一行；本轮 a 不加 footer，c 的 `omittedDecisionCount` 说明行固定在**卡底**。
- `isSecret`：**本轮只进协议、渲染端不做掩码**（a 的建议），需用户确认安全降级（见 U5）。

### C10 【Host 侧数据结构归属】a 的 pending 表 vs c 的 approvalCorrelator

- **澄清（不是同一张表，但必须一次定死归属，否则会各造一张）**：
  1. **`pendingServerRequests`**（JSON-RPC id → settle 回调）：提问 + 三类 v2 审批 + MCP elicitation **共用一张**；服务端请求走**自有 id 空间且从 0 起**[a 实测]，必须按 `(有 id 且有 method)` 判服务端请求，不与客户端自发 id 混用；`session.stop/close/host.shutdown` 必须**遍历回掉全部挂起请求**，否则 codex 回合永久卡在 `waitingOn*`。
  2. **`approvalCorrelator`**（itemId → diff 缓存，c 的新文件）：只服务 fileChange 的分帧关联，**不是** pending 表，不参与 JSON-RPC 生命周期。
  3. **单一 status mapper**：`thread/status/changed.activeFlags` 是数组，`waitingOnUserInput`(提问) 与 `waitingOnApproval`(审批) 是**同一条通知的两个标志**[a 实测]。→ `session.status` 的 `waiting_question` / `waiting_permission` / `running` **必须由同一个 mapper 从这一条通知派生**；提问桥与审批桥**都不得自行发 `session.status`**（Claude 侧 `questionBridge.ts:168-177` 的 `peerHasPending` 补丁正是没有 mapper 层的产物，Codex 侧不许重演）。
- c 的 `autoReason` 词表（`'unsupported'|'session_closed'|'aborted'|'timed_out'`）**复用为 pending 表清空理由**，不另立词表。

### C11 【错误码族】b 的 `unsupported_agent`、c 的 unmodeled、d 的 `history_unsupported`

- **裁定**：三者层级不同，**各自保留**，只统一命名式为 `<域>_unsupported`：
  - b 的 host.error code 由 `unsupported_agent` **改为 `agent_unsupported`**（`HostErrorEvent.payload.code` 是自由 string，无协议改动，`fatal:false`）。
  - d 的 `HistoryReadErrorCode += 'history_unsupported'`（唯一的枚举加法，renderer `toCode()` 对未知码回落 `'unknown'`，老 renderer 不崩[d 读码]）。
  - c 的 `PermissionUnmodeledReason[]` 是**会话内更细粒度**，不并入上面任何一个。
- d 的「`jsonl_not_found` wire 值不变、语义放宽、UI 文案去掉『（JSONL）』」保留。

### C12 【c 的 open issue 之一，可就地裁】`allow_session` 的作用域

- c 担心「我方会话 ≠ codex thread 时 `acceptForSession` 范围会撒谎」。合并后可裁：b 的绑定是 session↔agent 一对一，d 实测 `thread/resume {threadId}` 是会话唯一恢复句柄 → **我方会话 ≡ 一个 codex thread 成立**。
- **裁定**：`allow_session` **可以发**；同时登记硬约束——**本轮禁止使用 `thread/fork`**（一旦 fork，一个我方会话跨两个 threadId，该等价立刻破裂，且 d 的 `h:codex:<threadId>:<itemId>` id 空间也会分裂）。写成注释 + 代码里不实现 fork 分支即可。

### C13 【b 的 open issue 之一，可就地裁】切换已绑定会话的 agent

- **裁定**：**已绑定（已有首个回合）的会话不可原地改 agent，只能 fork 新会话**（复用 T-27 三档规则的 fork 档）。依据是 d 的实测而非取向：两侧 reader、id 空间、runtimeIdentity 物理含义全不同，历史无法搬运。
- 留给用户的只剩一个**可选加法**：是否额外提供「清空历史后原地改绑」（见 U-补）。

### C14 【b 的 open issue 之一，可就地裁】侧栏 chip 预算

- **裁定**：本轮 chip 上限 **2**（既有 branch chip + 新 agent chip）。c **不出**权限 chip —— 权限姿态只在 Context surface 出一行（c 自己的设计已经这么写）。b 的「Claude 行也显示 agent chip」保留（反隐式编码，与 D21-A 同调）。窄宽仍需一次截图确认（见 U8）。

### C15 【a 的 open issue 之一，可就地裁】是否把 `QuestionBridge` 抽成可插 settler 基类

- **裁定：本轮不抽，Codex 侧独立写**。a 自评净收益约 0；且合并后多出一条反对理由：a 实测 Codex 的 `{answers:{}}` 是干净取消，而 Claude 侧 `questionBridge.ts:246-252` 的「空 payload 拒收」防呆**必须不被继承**——过早抽基类正好会把这条相反语义焊进公共父类。

---

## 2. 合并后的协议增量总表

约定：落点行号以 HEAD 为准；「老 Claude 影响」列的判据是**代码路径**，不是承诺。

| # | 项 | 动作 | 可选性 | 默认/缺省语义 | 老 Claude 会话影响 | 落点 file:line |
|---|---|---|---|---|---|---|
| 1 | `AgentWireName` / `AGENT_WIRE_NAMES` / `resolveAgentWireName` / `sessionAgent` / `AGENT_DISPLAY_NAMES` | **新增模块** | — | `LEGACY_AGENT='claude-code'`（全仓唯一字面量） | 零 | `src/shared/types/agentWire.ts`（新建） |
| 2 | `ChatSession.agent?: AgentWireName` | 扩展 | 可选 | 由 `mergeSessionIndex` 物化，下游永不见 undefined | 零 | `renderer/stores/chatSessions.ts:85` 后 |
| 3 | `SessionIndexEntry.agent?: string`（磁盘侧宽松） | 扩展 | 可选 | `undefined→'claude-code'`；未知非空串→`null`→隐藏该行 | 零（顶层仍是裸数组） | `shared/types/sessionIndex.ts:11` 前 |
| 4 | `SessionCreateCommand.payload.agent?` / `SessionResumeCommand.payload.agent?` | 扩展 | 可选 | 缺省=claude-code | 零 | `shared/types/agentHost.ts:50-59` / `:61-76` |
| 5 | `SessionCreatedEvent.payload.agent?` | 扩展 | 可选 | 运行时硬编码自身身份；reducer `?? session.agent` | 零 | `shared/types/runtimeEvents.ts:330-334` |
| 6 | `SessionCreatedEvent.payload.permissionPolicy?` + 新类型 `SessionPermissionPolicy`（判别联合，判别位 `agent`） | 扩展 + 新类型 | 可选 | undefined → 走既有 `permissionMode` 行 | 零（`:460-462` 既有 `return prev` 即正确降级路径） | `runtimeEvents.ts:323` 后 / `:330-334` |
| 7 | `HostReadyEvent.payload.capabilities.agents?: AgentWireName[]` | 扩展 | 可选 | 缺席 = 只会 claude-code | 零 | `runtimeEvents.ts:83-92` |
| 8 | `...capabilities.permissionPolicy?: boolean` | 扩展 | 可选 | 缺席 = 老 Host，UI 保持旧行为 | 零 | 同上 |
| 9 | `PermissionRequestedEvent.payload` += `kind? / decisions? / detail? / reason? / omittedDecisionCount?` | 扩展 | 全可选 | `kind` 缺省 `'tool'`；`decisions` 缺省 Allow/Deny 两行 | 零（`derivePermissionCardView` 缺 decisions 恰好 2 行，有测试钉） | `runtimeEvents.ts:236-251` |
| 10 | `PermissionRespondCommand.payload.decision?`（`allow: boolean` **保持必填**） | 扩展 | 可选 | `decision ?? (allow?'allow':'deny')` | 零 | `agentHost.ts:132-139` + 4 处手写内联：`preload/index.ts:1397-1402`、`main/ipc/chat.ts:154`、`chatSessions.ts:178`、`:977` |
| 11 | `PermissionResolvedEvent.payload` += `decision? / autoReason?` | 扩展 | 可选 | undefined = 用户亲手裁决 | 零（顺手补既有诚实性缺口） | `runtimeEvents.ts:290-297` |
| 12 | `QuestionItem.id?: string` | 扩展 | 可选 | 无 id → answers key 用问题原文 | 零 | `runtimeEvents.ts:262-268` |
| 13 | `QuestionItem.isSecret?: boolean` | 扩展 | 可选 | false；**本轮渲染端不读** | 零 | 同上 |
| 14 | `QuestionRequestedEvent.payload.autoResolutionMs?: number\|null` | 扩展 | 可选 | null = 不自动放行；**本轮客户端不实现** | 零 | `runtimeEvents.ts:276-282` |
| 15 | `answers` 的 **key 语义**（`question.respond` / `question.resolved`） | 语义扩展（类型不变） | — | 有 `QuestionItem.id` 用 id，否则用原文 | 零（Claude 不发 id） | `agentHost.ts:141-162`、`runtimeEvents.ts:~300` 注释 |
| 16 | `ChatBlock` += `permissionKind? / permissionDetail? / permissionDecisions? / permissionDecision? / permissionAutoReason? / omittedDecisionCount?` | 扩展（红线加法） | 全可选 | undefined | 零 | `chatSessions.ts:87-105` |
| 17 | `HistoryReadErrorCode` += `'history_unsupported'` | 扩展并集 | — | — | 零（`toCode()` 未知回落 `'unknown'`） | `shared/types/sessionHistory.ts:46`、`renderer/components/chat/historyError.ts:41/69` |
| 18 | `SessionHistoryEvent.payload.agent?` / `HistorySessionSummary.agent?`（d 原名 `agentType`，已改名） | 扩展 | 可选 | 缺省 claude-code | 零 | `runtimeEvents.ts:352-366` / `sessionHistory.ts:60-73` |
| 19 | `SessionListHistoryCommand.payload.agents?: AgentWireName[]`（d 原名 `agentTypes`） | 扩展 | 可选 | 缺省 = 只扫 `~/.claude/projects` | 零（今日零 renderer 消费者） | `agentHost.ts:127-131` |
| 20 | host.error code 新值 `'agent_unsupported'`（`fatal:false`） | 新值（非协议改动） | — | — | 零 | `agent-host/index.ts:177-240` 分发处 |
| 21 | `SessionIndexService.recordCreated/recordResumed` 入参 += `agent?: string`，且**两个对象字面量都要写 `agent: input.agent ?? existing?.agent`** | 扩展 | 可选 | — | 零 | `SessionIndexService.ts:52-60` / `:72-80` |
| 22 | `applyRuntimeEvent` 守卫 `if (!runtimeIdentity) return` → `if (!runtimeIdentity && !agent) return` | 扩展 | — | — | 零（Claude created 无 runtimeIdentity，行为与今日一致） | `SessionIndexService.ts:136-146` |
| 23 | `SidebarChip.variant += 'agent'`、`SidebarSessionRow.agentChip: SidebarChip`（非可选） | 扩展 | 非可选 | 绑定总能解析出值 | **⚠ 非零（唯一一处）**：Claude 行也新增一枚 chip —— b 的有意裁定（反「无 chip 即 claude」隐式编码），**数据/协议层仍为零** | `sidebarTree.ts:23-41`、`:96-107`；`LeftNav.tsx:621` |
| 24 | `runtimeIdentity` | **不动**（仅 4 处注释中立化） | — | agent 私有不透明恢复句柄 | 零 | `sessionHistory.ts:62`、`agentHost.ts:65`、`sessionIndex.ts:5`、`chatSessions.ts:67` |
| 25 | `SessionPermissionMode` | **不动（冻结）** | — | — | 零 | `runtimeEvents.ts:323` |
| 26 | `HistoryBlock` 4 型 / `mapHistoryBlock` | **不动** | — | — | 零 | `sessionHistory.ts:11-30`、`chatSessions.ts:315` |
| 27 | `session-index.json` 顶层裸数组 | **不动（硬约束）** | — | — | 零 | `SessionIndexService.ts:172-188`（+ 回归断言） |
| 28 | `AGENT_HOST_PROTOCOL_VERSION` | **不动 = 1** | — | — | 零 | `agentHost.ts:6` |

### 验算：加完之后协议版本还能不升吗 → **能，仍为 1**

逐条核对四条会强制升版的情形：
1. **有没有新增必填字段？** 没有。#1–#23 全是可选字段/新值/新独立模块；唯一非可选的 #23 在 renderer 内部（`SidebarSessionRow`），不过协议线。
2. **有没有新增命令型或事件型？** 没有。`AgentHostCommandType` 10 型不变，`RuntimeEventType` 不变（d 的档 A 复用既有 `session.history`）。
3. **老 Host + 新 renderer 会不会静默跑错？** 这是唯一真实风险（老 Host 忽略 `payload.agent`、照起 Claude）。用 **`capabilities.agents` 前置禁用** 解决，而不是升版打死老 Host。
4. **新 Host + 老 renderer？** 多几个不读的 key，`isSessionPermissionMode` 对 Codex 会话返回 false → `return prev`，权限行不显示且不乱写[c 读码]。
5. **枚举并集扩宽（#17）算不算破坏？** 不算：`toCode()` 对未知码回落 `'unknown'`（severity error / retryable true），老 renderer 不崩[d 读码]。
- **结论：不升版。** 并把「本轮任何一方都不许升版」写成断言（`expect(AGENT_HOST_PROTOCOL_VERSION).toBe(1)`）——混合状态（一方升一方不升）会让 `protocol_mismatch` 语义失真。

---

## 3. 施工顺序（先落验证，再落逻辑）

依赖图（→ 表示硬前置）：**切片0 → 切片1 → {切片2 → {切片3 → 切片4}, 切片5}**；切片5 同时依赖切片2（复用 app-server 连接）。

### 切片 0 — 类型与断言骨架（**无任何逻辑**）
- 内容：`agentWire.ts` 全部导出；§2 表 #1–#19 的**全部类型加法一次性落完**（含 c 的 `SessionPermissionPolicy` / `PermissionDecisionId` / `PermissionDetail`、a 的 `QuestionItem.id/isSecret`、d 的 `history_unsupported`）；C2 三条扫描 + d 的 G8/G9 扫描 + `PROTOCOL_VERSION===1` + 索引顶层数组断言 + `questionCardModel` 既有 4 例回归钉。
- 验收：`tsc` 全绿；新断言全绿；**既有测试一行未改且全绿**；`git diff` 中无任何 `.ts` 逻辑分支变化。
- 为什么先：本仓纪律「定义验证先于改代码」，且这一片把三方的 payload 撞车一次性消掉，后面四片不再互相冲突。

### 切片 1 — 绑定回流链（b，**全局串行前置**）
- 内容：b 的 18 跳 + `SessionIndexService` 两处逐字段重建 + `applyRuntimeEvent` 守卫放宽（#22）+ `mergeSessionIndex` 唯一物化 + 侧栏 agent chip。Claude 侧回声硬编码 `'claude-code'`。
- 验收：merge 三态（无 agent→claude-code / codex→codex / 未知→隐藏且不覆盖 live 行）；re-record 不抹字段（带 codex 再不带 agent 调一次仍是 codex）；索引顶层仍是数组；**Claude 端到端行为零变化**（除 #23 视觉）。
- 为什么必须最先：#22 是 Codex threadId 落盘的唯一通道（C3），切片 5 的重启后 resume 完全依赖它。

### 切片 2 — Codex 客户端骨架（c/a 共用）
- 内容：JSON-RPC 客户端（服务端请求 id 空间从 0 的分流判据）+ **单一** `pendingServerRequests` 表 + 生命周期回收 + **单一 status mapper**（C10）+ `codexRuntime.ts` 的 `CODEX_PERMISSION_DEFAULT` 常量与显式下发 + 隔离 `CODEX_HOME`（a 实测：不隔离必踩 `developer_instructions` 坑）。
- 验收：`thread/start` 参数 == `session.created` 回显（仿 `claudeRuntimeOptions.test.ts:152` 的单一真相测试）；`session.close` 后 pending 表 size===0 且每条挂起请求都收到过 settle；status mapper 单元测试覆盖 `activeFlags` 的 4 种组合（空/仅 question/仅 approval/两者并发）。
- 可与切片 1 **并行开发**，但**合并在 1 之后**。

### 切片 3 — 提问桥（a）
- 内容：接请求→`question.requested`+`waiting_question`+登记 pending；`respond()` 翻译（`', '` 拆回数组、key 换 id）；`cancel:true → {answers:{}}`；**不套用** Claude 的空 payload 拒收防呆。
- 验收：用 a 抓到的 4 条真实报文做夹具回放，逐字段比对 `question.requested`；cancel 路径产出 `{answers:{}}` 并观察到 `serverRequest/resolved`；`isOther/isSecret/autoResolutionMs` 三个常量字段有显式「本轮忽略」测试而不是漏掉。

### 切片 4 — 权限投影（c）
- 内容：`decisions.ts`（4id × 3 方言）+ `approvalCorrelator.ts` + 卡层渲染（在切片 3 之后动同一批卡文件）。
- 验收：12 例表驱动 + 未知 id→**deny**（fail-safe）；correlator 四例，其中「无 diff 的审批必须在同一 tick 发卡」用**不推进 mock clock** 的结构性断言（这是唯一会挂死回合的改动方向）；`derivePermissionCardView` 缺 `decisions` 时恰好 2 行 A/B。

### 切片 5 — 历史（d）：先档 A，再档 C
- 5a 档 A（0.5–1 天）：`history_unsupported` 全链路 + UI warning alert + 输入框可用。**落地后永不删**，档 C 上线后它是 default 分支。
- 5b 档 C：`codexItemMapper.ts`（18 变体，与实时链路**共用同一函数**）+ `codexHistoryReader.ts`（`thread/resume` 不传 `excludeTurns`）+ `h:codex:<threadId>:<itemId>`。
- 验收：G1–G12 全部（d 已给出可执行形式）；额外补 G13：**重启后**（走 `session-index.json` 恢复）Codex 会话仍能 resume —— 直接检验切片 1 的 #22。

### 切片 6 — 收口
- flag on/off 双跑门禁（§4）+ 侧栏窄宽截图（C14/U8）+ 台账落库。
- **门禁纪律**：逐门串行跑（本机内存有限，链式合跑曾 OOM）。

---

## 4. Feature flag 方案

本仓无通用 flag 层；照抄既有 env 开关形状（`AICLIENT_HOST_SUBAGENT_ACTIVITY` / `AICLIENT_AGENT_HOST_DRIVER`），**只加一个**：

- **flag 名**：`AICLIENT_AGENT_CODEX`（`'1'` = on；缺省/`''`/其它 = **off**）。与既有 kill-switch 相反，新能力默认关。
- **读取点**：Host 启动时读一次（`agent-host/index.ts`，`host.initialize` 之前），Main 经 `AgentHostManager.ts:408` / `AgentHostProcess.ts:48` 注入。
- **flag 只控制两件事**：① `host.ready.capabilities.agents` 是否包含 `'codex'`；② Codex runtime / reader 是否注册。
- **flag 不控制**：协议字段、store 形状、渲染端条件分支 —— 否则会长出两套形状（本轮最想避免的）。
- **off 态行为（必须逐条可断言）**：
  1. `capabilities.agents === ['claude-code']`；renderer 据此**禁用**（不是隐藏）Codex 选项，tooltip 说明。
  2. `session.create/resume` 带 `agent:'codex'` → Host 回 `host.error{code:'agent_unsupported', fatal:false}`，会话不进入 busy。
  3. `session.listHistory` 不向 codex 扇出；已存在的 Codex 行（磁盘里 `agent:'codex'`）→ 走 `resolveAgentWireName` 已知值分支 → 行仍显示，resume 时得到 #2 的非致命错误（**不是**隐藏，隐藏只留给未知 slug）。
  4. Claude 全链路逐字节不变。
- **on/off 都要跑**：门禁两轮 —— off 轮跑既有全套回归（证明零影响）；on 轮加跑 codex 套件（切片 2–5 的验收项）。off 轮是「老 Claude 影响必须全零」这条的可执行证据。

---

## 5. U1 实测对 c（权限/问答适配估算）的影响

1. **关联成本不对称已从[推测]变[实测]**：提问是自包含报文（`params.itemId` 形如 `call_XXX`，整回合 13 个 item 里一次都没出现）→ 提问桥**不需要**任何 item 关联表；而 fileChange 的 diff 必须按 itemId 关联另一条 item。→ **c 的 `approvalCorrelator.ts`（≈80 行）不得被「提问那么薄」的直觉砍掉**，它是审批侧独有的必需成本。
2. **c 的「§5④ v2 Permissions 自动拒绝 + 冻结卡」风险等级下调**：a 零额度取得的工具表实测显示，5 个变体下工具表恒为 `[exec, wait, request_user_input, collaboration]`，`request_permissions` **从不出现**（`--enable request_permissions_tool` / `exec_permission_approvals` 均无效）→ 本机 build/模型上该请求**不可达**，c 原本「赌它罕见」的假设变成「本机根本触发不了」。**同时明确写下限制**：这只对本机 build 成立，换 build/模型可能变；`decisions.ts` 的映射表里 v2 Permissions 那一列本轮**不实现**，default 分支必须走自动拒绝而不是崩。
3. **c 的审批桥必须并入 a 发现的骨架**：服务端→客户端请求走**自有 id 空间且从 0 起**、以 `serverRequest/resolved {threadId, requestId}` 收尾 —— 提问与三类审批**共用一张 pending 表**（C10）。c 原设计没有覆盖这一层，属净增内容而非冲突。
4. **状态位同源**：`waitingOnApproval`（S1 实测，c 依赖）与 `waitingOnUserInput`（a 实测）是**同一条 `thread/status/changed` 的两个 flag** → c 的审批桥不得自己发 `session.status`（C10 第 3 条）。
5. **Claude 的两条防呆不得照搬到 Codex**：a 实测 `{answers:{}}` 是干净取消（模型不重问、回合正常收尾），与 `questionBridge.ts:8-10` 记录的 Claude 坑**行为相反** → 也因此**否决**了「抽公共 settler 基类」（C15）。
6. **成本口径校正**：提问侧 S1 的「40–80 行」偏乐观约 2 倍，合并后取 a 的估算：Host 侧 100–150 行 + 共享类型 ~12 行 + 渲染端 0 行（`isOther` 我方渲染端**已无条件追加 Other 行**，零改动即满足）。**另加一次性骨架成本**（pending 表 + status mapper + 生命周期回收 ≈ 60–80 行[推测]），记在**切片 2** 而不是分摊进提问/审批任一侧。
7. **注释口径差异**：Codex 工具描述限「1–3 questions / header ≤12 字符 / options 2–3」，我方 `QuestionItem` 注释写的是 1–4（Claude SDK 口径）→ 注释里注明两 agent 不同，**渲染端不加校验**（加了就会在另一侧误判）。
8. **对 c 无影响但要记**：`request_user_input` 在 `codex exec` 模式下不支持、且**只有 root thread 能用**（子代理不会提问）→ 提问侧**不需要**为 agentId 消歧（与 T-34 的 permission agentId 相反）。

---

## 6. 未决清单（真正需要用户裁定）

> 已被我就地裁掉、不再上交的：q.id 方案（C8）、allow_session 作用域（C12）、切换已绑定会话的 agent（C13）、chip 数量上限（C14）、是否抽 settler 基类（C15）、capabilities 平铺 vs 分组（C6）。

| # | 议题 | 选项与后果 |
|---|---|---|
| ~~U1~~ **已定** | ~~wire 值~~ → **用户 2026-08-06 裁定 `'claude-code'` / `'codex'`**，见 §0.5-①。原选项存档： | **A `'claude-code'/'codex'`**（b 推荐）：产品名钉死、`'claude-*'` 命名空间留给将来「直连 Anthropic API agent」；与既有 `AIProvider`（`'claude-code'`）半对齐，但与 `AIProvider` 的 `'codex-cli'` 不齐。**B `'claude'/'codex'`**：与既有 `BuiltinAgentId`（`cli.ts:1`，值就是 `'claude'/'codex'`）**完全对齐**，磁盘可读性最好；代价是模型家族名被 CLI 占用，将来第二个 Anthropic agent 无处安放。**C 直接复用 `BuiltinAgentId`**：零新枚举；但它含 5 个我们不支持的值（droid/gemini/auggie/cursor/opencode），且会把「终端能起哪个 CLI」与「聊天会话绑定谁」两条轴焊死——**我不推荐 C**。三份原档都没看到 A/B 与仓内既有两张表的关系，请据此再拍一次。 |
| **U2** | 未知 agent slug 的行（用户降级后读到新版本写的值） | **A 隐藏该行**（b 设计，entry 留在磁盘、升级即回来）：行凭空消失。**B 显示为禁用行 + unsupported 标记**：需新 UI（约 20–40 行[推测]）。纯 UX 取向。 |
| **U3** | 「新建聊天默认用哪个 agent」的落点 | **A 全局 settings**（b 推荐，已有 persist+migration）。**B 追加 per-workspace 默认**（「这个仓库默认 Codex」）：settings 形状必须**一次定对**（path→AgentWireName 表），事后补是纯加法但形状要现在拍。 |
| **U4** | Codex 默认权限档 | **A `on-request + workspace-write + networkAccess:false`**（对齐 codex-acp 生态默认；S1 有「审批诱发踩空 3 次」的少问嫌疑，样本仅 3 不足定论）。**B `untrusted + workspace-write`**：问得更多、控得更细、首轮体验更吵。两者都不能继承本机 `~/.codex/config.toml`（实测写的是 `danger-full-access`，继承 = 静默关掉全部审批）。 |
| ~~U5~~ **已定** | ~~`isSecret` 的安全降级~~ → **编排者按先例裁定：渲染端补掩码**，见 §0.5-②。原选项存档： | **A 本轮只进协议、渲染端按普通文本渲染**（实测 10/10 恒 false，0 样本）：一旦真出现，密钥会明文显示在时间线里。**B 渲染端补掩码输入**（+20–30 行）。**C 带 `isSecret` 的问题整条降级为「请在别处提供」**。需要用户明确接受 A 的风险，否则走 B。 |
| **U6** | `session.historyListed` 的**部分失败**表达（Claude 成功 / Codex 失败） | **A 取最严重者**（丢信息）。**B 加 `errors?: Array<HistoryReadError & {agent}>`，单 `error` 只在全失败时填**（d 倾向；两个字段并存有两个真相源的隐患）。**C 静默少列该 agent 的行**（用户不知道少了什么）。 |
| **U7** | Codex 历史列表是否为此**临时 spawn** 一个 app-server（当前工作区无活跃 Codex 会话时） | **A 临时 spawn + 超时静默不列**（d 倾向；实测 initialize 178–188ms）。**B 干脆不列 Codex 行**（列表不完整但零额外进程）。产品口径。 |
| **U8** | 侧栏第二枚 badge 的窄宽预算（rail 常驻 + 面板压缩之后） | 未验证。需一次窄侧栏截图确认；若挤，退路是 agent chip 只显示图标（Badge 内放 Lucide icon + `title`）。本仓教训：布局缺陷只在截图里显形。 |
| **U9** | 剩余 **2 个真实回合**怎么花（上限 6，a 已用 4） | 三个候选，只能选 2：**(a) d 的 U2-a**——实时 `item/completed` 的 `item-N` 是否等于事后 `thread/read` 重投影的 `item-N`。**我推荐排第一**：若不等，档 C 的 replay-merge 去重要改成按 `toolCallId`/文本，是整个历史地基。**(b) a 的 `autoResolutionMs` 客户端义务**（超时后谁 resolve）——不测则按「不实现、当普通提问」降级，可接受。**(c) a 的 `question.resolved.outcome:'rejected'`**（Codex wire 上只有「给答案」和「空答案」，JSON-RPC error 回包行为未测）——不测则把 `rejected` 降级成 `cancelled`，可接受。→ 建议 (a) + 用户在 (b)/(c) 里挑一个；若两条降级都接受，第二个回合可留给 U4 的审批频次观测。 |
| **U10** | file-change 卡的 diff 展示上限（现拟 **20 文件 / 每 diff 64KB**） | c 拍的数，无真实大补丁样本。上限太小 → 常见重构就被截断；太大 → `ChatBlock` 永不回收，超大 diff 进红线 state 是内存风险。若用户有典型规模认知，直接替换。 |
| **U-补** | 是否额外提供「清空历史后原地改绑 agent」 | C13 已裁定「已绑定只能 fork」。此项是**可选加法**：提供 = 多一条会话级破坏性操作入口（需二次确认 UI）；不提供 = 用户只能新建会话。默认不做。 |

---

## 附：三方共同硬约束（任何一片都不许违反）

1. `session-index.json` 顶层**必须是裸 JSON 数组** —— 任何 schemaVersion / 信封 / 元数据段都会触发「老版本 `for-of` 抛错 → catch 只 warn → 空表启动 → 下次 flush 写回 `[]` → 全部会话索引静默清零」[b 读码，我复核 `SessionIndexService.ts:172-204`]。要版本标记只能做成 per-entry 可选字段。
2. `AGENT_HOST_PROTOCOL_VERSION` **保持 1**，只加可选字段。
3. 默认 agent 字面量**全仓只有一处**（`agentWire.ts` 的 `LEGACY_AGENT`），物化**只有一处**（`mergeSessionIndex`）。
4. 任何新持久化字段**必须同时写进** `recordCreated` / `recordResumed` 的对象字面量（逐字段重建，漏写 = 每次首发消息抹一次）。
5. 不得按 `runtimeIdentity` 的**字符串形状**分派任何行为；它只有与 `agent` 配对才可解释。
6. `session.status` 的等待态只能由**唯一 status mapper** 从 `thread/status/changed` 派生。
7. Codex 侧**不得**因等待 diff 帧而延迟回复审批（会把回合挂死在 `waitingOnApproval`）。
8. 本轮**不使用 `thread/fork`**（会破坏「我方会话 ≡ 一个 codex thread」的等价，C12）。
