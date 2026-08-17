# D48 施工规格草案（设计轨 A · Opus）— Codex CLI 选择功能（阶段 3）

> 2026-08-16。输入 = [05 设计任务书](./05-design-brief.md) + 调查 [00](./00-code-surface.md)~[04](./04-cch-live-probe.md)。
> 本文是**双轨双盲**的 A 轨独立作答，未见 Codex 轨内容。定稿由编排者合取后另立。
> 全部 `file:line` 为 2026-08-16 当前工作树亲验（调查引用已抽查，偏差在 §0.2 单列）。

---

## §0 结论先行

### 0.1 三句话

1. **切三片，依赖序 S1 → S2 → S3**：S1 = agent picker（纯渲染端 + `capabilities.agents` 首消费者，零协议改动）；
   S2 = 模型目录代理化 + D40 Codex 半边补齐（新增 Main 侧目录服务 + 一条 IPC + 协议加法）；
   S3 = 权限面（先补 Codex 读侧断链，再上写侧管理面，中途改档探针条件执行）。
2. **最重的一处裁定：D40 Codex 半边补齐路径 = 补 `buildTurnStartParams` 的 `effort`，但 `model` 维持 `thread/start` 钉死**
   （非对称裁定，理由见 §3.5）——这不是折中，是两个字段的失败面根本不同。
3. **最重的一处纠错：目录代理化必须走 Main，不能走 agent-host。** 调查 04 实证的两个端点是 **cch HTTP 端点**，
   而凭据（`VaultPayload.claude.baseUrl` / `codex.baseUrl` / token）只在 Main 的 CredentialVault 里
   （`CredentialVault.ts:52-56`），agent-host 子进程**只拿到 `AICLIENT_CODEX_API_KEY` 一个 key，拿不到任何 baseUrl**
   （`hostEnv.ts:64-75` 八键全列，无 claude token / 无 baseUrl）。把目录查询放进 agent-host 需要新增 env 键扩散凭据面，
   与 D47「凭据权威收敛到 app」直接冲突。**目录服务归 Main**，范式照抄 `UsageService.ts:102-131`（同款
   `resolveManagedCredentialsEnabled` → vault → `net.fetch`）。

### 0.2 调查引用抽查结果（承重结论复核）

| 调查断言 | 复核 | 备注 |
|---|---|---|
| `capabilities.agents` UI 零消费 | ✅ 成立 | 全 renderer `capabilities` 命中 8 处，唯一生产消费者 `ChatWorkspace.tsx:49` 读 `.thinking`（`thinkingCard.ts:49-50`）；`hostStatus.ts:38` 自述 "Today's only consumer is test assertions" |
| agent 物化点 = `sendMessage()` | ✅ 成立 | `chatSessions.ts:1030-1037`；`chatSessionActions.ts:30-38` 确无 agent 字段 |
| `buildTurnStartParams` 只发 `{threadId, input}` | ✅ 成立 | `codexRuntime.ts:259-265`；丢弃理由注释 `:246-256` |
| Codex 权限读侧断链 | ✅ 成立 | `contextSurfaceModel.ts:499-501` 只认 `payload.permissionMode`；`isSessionPermissionMode` 只查 5 值白名单（`:447-451`） |
| cch 双轴 `/v1/models` 可信 | ⏸ 未复跑 | 采信 04（当日实测）。**但 §3.2 的降级设计不依赖它长期为真** |

**调查未记载、本轨新发现的四条承重事实（改变了设计形状）**：

- **N1 · `capabilities.permissionPolicy` 类型已存在但 Host 从不发。** `runtimeEvents.ts:109-115` 定义了
  `permissionPolicy?: boolean`（注释："Absent = old Host, UI keeps the old `permissionMode`-only behaviour"），
  但 `agent-host/index.ts:363-373` 实际发出的 capabilities 只有四键 `{history, thinking, subagentActivity, agents}`
  ——**没有 `permissionPolicy`**。S2 设计时预留了这个开关、Host 侧忘了接。这是 S3 的现成降级闸门，白捡。
- **N2 · `HostAgentDetail.reason`（四道闸门的失败原因）不过 wire。** `agentSupport.ts:116-131` 的 `detail[]`
  只在 Host 进程内用于合成 `agent_unsupported` 错误文案（`index.ts:82-93`）；`capabilities.agents` 只是
  `detail.filter(available).map(agent)`（`:185-188`）。→ **渲染端只知道「codex 不在列表里」，永远不知道是
  flag_off 还是 credentials_missing 还是 entry_missing。** codeg 的「琥珀点 = 可用但未安装」三态在本仓
  **当前 wire 上不可表达**，只能二态。要三态必须扩 wire（S1 的可选加法，见 §2.4）。
- **N3 · 已有「物化」判定的现成单一真源，不要重造。** `useComposerTarget.ts:82-91` 的
  `computeEverHostBound(session, hostBoundSessionIds)` = `hostBoundSessionIds.includes(id) || runtimeIdentity != null`，
  文档明写第二个析取项是为了「从 session-index 恢复、Host 未启动」的会话也判为已绑定。
  **agent picker 的锁定判定必须复用它，不能写 `hostBoundSessionIds.includes(...)` 了事**——否则重启后
  picker 对一个已物化会话重新可点，用户改了 agent、下一条消息走 resume 分支把旧 Codex 线程恢复进 Claude 运行时。
- **N4 · `reduceSessionRuntimeFacts` 有一道「早退陷阱」，且代码里已有前车之鉴。**
  `contextSurfaceModel.ts:487-490` 是 `if (event.type !== 'session.created' && ... !== 'session.resumed') return prev;`，
  而 `:483-486` 的 D33 注释明写：三个 usage 相关分支必须放在这道守卫**之前**，否则「每一个都会静默 no-op 穿过去」。
  S3 加 `permissionPolicy` 的 reduce 恰好在 created/resumed 上，能过这道守卫；但 `:499-501` 之后还有一道
  `if (!isSessionPermissionMode(permissionMode)) return prev;` ——**Codex payload 没有 `permissionMode` 键，
  会在这里 return，`permissionPolicy` 永远读不到。** 断言点见 §4.3-A2。

---

## §1 切片划分与依赖序

| 片 | 名称 | 范围 | 依赖 | 协议改动 | 独立可回归 |
|---|---|---|---|---|---|
| **S1** | agent picker | Composer 新入口 + `capabilities.agents` 首消费者 + 锁定语义 + 空态降级 | 无 | 无（**可选加法** N2 扩 wire） | ✅ 四门 + off/on 双轮 |
| **S2** | 模型目录代理化 + D40 Codex 半边 | Main `ModelCatalogService` + 1 条 IPC + per-agent 目录 + 短名迁移 + `turn/start` 加 effort | S1（picker 决定 per-agent 目录切给谁） | 加法（`CodexTurnStartParams` 加可选 `effort`） | ✅ 四门 + 目录三级回落三轮 |
| **S3** | 权限面 | Codex 读侧补链 + `capabilities.permissionPolicy` 补发 + 写侧管理面（**只写线程默认，不做中途改档**） + 两条探针 | S1（写侧面板按 agent 分岔） | 加法（capabilities 补键 + create 命令加可选 policy） | ✅ 四门 + 双轴读侧对照 |

**为什么是 3 片不是 2 片或 4 片**：

- S1 与 S2 不能合：S1 是**零协议、零 Main、纯渲染端**的一片，可以在 flag-off 下全绿收口并单独 GUI 点验；
  S2 一旦并入就把「新增 Main 服务 + 网络 IO + 缓存 + agent-host 协议加法」拖进同一次回归，
  失败面从「一个组件」扩到「四个进程边界」，红了分不清是谁。
- S2 与 S3 不能合：两者唯一的耦合点是「都要按 agent 分岔」，而那个分岔在 S1 就已建立。
  S3 的两条探针（§4.4）是**条件执行项**，把它压在 S2 后面意味着探针失败时目录改造不受牵连。
- 不切第 4 片：S2 内部的「目录查询」与「D40 半边」看似可分，但 D40 Codex 半边**依赖 S2 的 effort 词表口径**
  （补 effort 的前提就是词表已实证/已有目录来源），拆开会让 S2 落一个「查了目录但没人用」的半成品，
  违反工程规范第 6 条（每个能力都要能 on/off 双跑并各自有意义）。

**收口条件（每片一致）**：`pnpm typecheck` → `pnpm typecheck:agent-host` → `pnpm lint` → `pnpm test`
**逐门串行**（链式合跑曾 OOM），基线 = D47 收官态 **208 文件 3973 例 0 红**。
每片 as-built 记录实跑文件数/例数 + 变异逐对红灯输出。

---

## §2 S1 — agent picker

### 2.1 组件形态裁定：segmented pill，但**两项时才渲染**

**采纳 codeg 的 segmented pill**（调查 03 §1，用户认可形态），理由不是"抄"，是本仓约束下它恰好最省：
候选集恒为 ≤2 项（`AgentWireName` 是闭合两元，`agentWire.ts:43-45`），一个 Menu/Select 为两项开一层
popup 是纯负收益，而 pill 在 `h-6` 上就能容下两个图标。

**新增文件 `src/renderer/components/chat/ComposerAgentPicker.tsx`。**

- 底座 = 仓内已有的 `ToggleGroup` + `Toggle`（`components/ui/toggle-group.tsx:88` 导出
  `{ToggleGroup, Toggle, ToggleGroupItem, ToggleGroupSeparator}`，Base UI 底层）。
  **禁止手写 segmented control**（CLAUDE.md 组件优先条）。
- 尺寸 `h-6`（设计系统"小按钮 24px"，`docs/design-system.md:546`）；圆角**必须 `rounded-xs`/`rounded-sm`**
  ——`design-system.md:281-286` 记录过实测教训：Composer 的 Model/Effort 触发器写 `rounded-lg` 挂 `h-6` 渲染成满圆胶囊。
- 图标 Lucide；label 文本仅在选中项显示（codeg 的折叠动画不抄——本仓无该动画 token 分档，
  用 `truncate` + 固定图标 `shrink-0` 即可）。
- **`AGENT_DISPLAY_NAMES`（`agentWire.ts:48-51`）是 label 的唯一来源**，不新建第二张文案表。

**一项时不渲染**（区别于 codeg 的"全未启用才空态"）：`agents` 只有 `['claude-code']` 时，
一个只有单选项的选择器是"关于产品的谎言"——这是本仓 `composerModel.ts:91-101` 已经立过的规矩
（"a control for a capability we do not have is a lie about the product"）。此时整个 picker 不挂载。
→ **flag-off 下用户看不到任何新东西，off 轮的视觉基线 = 今天**（这也让 off 轮回归退化成纯静态断言）。

### 2.2 落点与组装

`ChatComposer.tsx` 两处底栏，插在 `modelEffortControls` **之前**（左侧）：

```
session 模式 :2455-2461  → [attachButton, agentPicker, textareaEl, statusLine, modelEffortControls, actionButtons]
empty  模式 :2474-2479  → [attachButton, agentPicker, modelEffortControls, statusLine, actionButtons]
```

**为什么在 model 左边**：`:2470-2472` 的注释把 empty 底栏的阅读序定义为 "⊕ → model → status → actions"，
理由是"两个开启一条消息的控件挨在左边"。agent 在语义上**先于** model（选了 agent 才知道有哪些 model，
S2 的 per-agent 目录就是这个依赖的物化），放右边会让阅读序与因果序相反。

定义处紧邻 `modelEffortControls`（`:2224-2231`）：

```tsx
const agentPicker = activeSessionId ? (
  <ComposerAgentPicker
    sessionId={activeSessionId}
    agents={hostStatus.capabilities?.agents}
    locked={agentLocked}
    disabled={disabled}
  />
) : null;
```

**闸门口径与 `modelEffortControls` 故意不同**：后者是 `disabled || busy || sending`（`:2229`），
因为 model 改了下一回合还能生效；agent 不是——它由 `locked` 单独接管（§2.3），
`disabled` 只保留"没地方放这个草稿"这层总闸。busy/sending **不额外传**：会话一旦 busy 必然已物化，
`locked` 已经为真，再叠一层是重复真源。

### 2.3 三态与锁定判定

| 态 | 触发条件 | 表达 |
|---|---|---|
| **可选** | 未物化 且 `agents.length >= 2` | 两项均可点，选中项高亮 |
| **锁定** | 已物化（`computeEverHostBound` 为真） | 整组 `disabled`，选中项保持高亮 + `title` 说明「会话已绑定，换 agent 请新建会话」 |
| **不可用/不渲染** | `agents` 为 `undefined`（old Host）或 `length < 2` | 整个组件不挂载 |

**锁定判定必须复用 `computeEverHostBound`（N3）。** 该函数现在是 `useComposerTarget.ts:82-91` 的模块私有函数
——**S1 的第一步是把它提取到一个纯模块**（建议 `src/renderer/components/chat/sessionBinding.ts`），
`useComposerTarget.ts` 改为 import，picker 也 import。

> **这是本片唯一的重构动作，且必须发生。** 不提取而在 picker 里重写一份，就制造了该函数注释
> （`useComposerTarget.ts:76-81`）明确警告的那种漂移：ComposerTargetBar 判"已绑定不许改 folder"，
> picker 判"未绑定可以改 agent"，两者对同一个恢复态会话给出相反答案。
> 新模块必须过 `pureModuleImports.test.ts` 的纯度扫描（禁 `from 'react'` / `from '@/stores'` 值导入，
> `pureModuleImports.test.ts:33-37`）——`computeEverHostBound` 只吃两个纯参数，天然满足；
> **把它加进 `TARGET_FILES`（`:38-45`）**，否则明天有人往里加个 store import 没人拦。

**选中值从哪来 / 写到哪去**：

- 读：`sessionAgent(session)`（`agentWire.ts:118-120`）——**绝不直读 `session.agent`**
  （`chatSessions.ts:105-113` 的长注释明确禁止：`session.agent ?? '…'` 就是它要防的第二默认值）。
- 写：**S1 只写 renderer 本地偏好，不碰 store**。新增 `useSessionAgentDraft`（localStorage，
  key `aiclient:chat:session-agent-draft`，范式照 `useSessionModel.ts:12-14` 的 per-session map）。
  首条消息发出时，`ChatComposer.tsx:879` 的 `const agent = sessionAgent(preSession ?? {})` 改为
  读草稿优先：`resolveDraftAgent(getSessionAgentDraft, sessionId, preSession)`。

> **为什么不写 store：** `chatSessions.ts` 是红线 store，改动只走加法（约束 4）。而"加一个字段"这里恰恰**不需要**
> ——`session.agent` 的语义已经被 `chatSessions.ts:96-113` 钉死为「物化后的绑定」，往里写一个**未物化的草稿值**
> 会让该字段同时承载两种语义，`mergeSessionIndex` 的"唯一物化点"保证当场失效。
> 草稿是 renderer 的短命状态，localStorage 是它现成的家（model/effort 已是同款）。
> **物化时草稿→wire→回填 `session.agent`**（`chatSessions.ts:486-502` 的 Host 回填链已存在，无需改）。
> **草稿清理**：物化后由 `resolveDraftAgent` 自然失效（锁定态不再读草稿），无需主动删——
> 与 `useSessionModel` 同款「不清理」姿态，一致性优先。

**两条发送路径都要接**：`chatSessions.ts:1036`（store 的 `sendMessage`，简单路径）与
`ChatComposer.tsx:879→1258`（Composer 的 `runSend`，带 create/resume 序列的路径）。
**两处都读同一个 `resolveDraftAgent`**，否则走哪条路发第一条消息决定了 agent 是什么——一个必然发生的漂移。

### 2.4 三态 vs 二态：N2 的条件执行项

调查 03 记录 codeg 有「可用但未安装 → 琥珀点」。**本仓 wire 上不可表达（N2）。** 两个选项：

- **【推荐 · S1 基线】二态**：codex 不在 `agents` 里 = 不渲染第二项。用户看到的是"没有这个功能"，
  而不是"有但坏了"。诚实、零协议改动、off 轮零视觉变化。
- **【条件执行 C1】三态**：扩 `capabilities` 加 `agentDetail?: {agent, available, reason}[]`
  （`agentSupport.ts:116-131` 的 `HostAgentDetail` 直接过 wire，`index.ts:373` 补一行），
  渲染端把 `credentials_missing` / `entry_missing` / `home_prepare_failed` 显示为琥珀点 + tooltip，
  `flag_off` 仍然不渲染（flag 是构建期姿态，不是用户可修的东西）。

**C1 的执行条件**：仅当用户在 §6-Q2 拍板"要能看见 codex 为什么不可用"时执行。
**不得默认执行**——它把 Host 的内部诊断结构变成 wire 契约，`agentSupport.ts:227-237` 的四条 reason 文案
（那里有一条"pairwise 非包含"的纪律）会跟着变成对外承诺。

### 2.5 空态与降级

| 情形 | 行为 |
|---|---|
| `capabilities` 整个 undefined（old Main / Host 未 ready） | 不渲染。`hostStatus.ts:182-187` 的 prime 通道已保证"没有 key"与"key 为 null"都落到 `prev.capabilities` |
| `capabilities.agents` undefined（old Host） | 不渲染。`filterAgentWireNames`（`hostStatus.ts:49-52`）已把「没发列表」与「发了空列表」区分开，前者 undefined 后者 `[]` |
| `agents: []`（理论上不可能——`buildHostAgentRegistry:165` 恒先塞 claude-code） | 不渲染。**不写 fallback 到 claude-code**：一个 Host 声称自己一个 agent 都跑不了时，picker 谎称能跑 claude 会让下一次 create 撞 `agent_unsupported` |
| `agents` 含未知 slug（新 Host / 旧 renderer） | 已被 `filterAgentWireNames` 滤掉，picker 只见到已知项 |
| 草稿指向一个**已从 `agents` 消失**的 agent（flag 中途关掉后重启） | **回退到 `LEGACY_AGENT` 并清草稿**，且**不静默**——picker 上给一次性提示。对应 codeg 的 `onFallback` 语义（调查 03 §1：区分用户主动选择与组件自动回退）。断言点 §4.2-A4 |

---

## §3 S2 — 模型目录改造

### 3.1 通道设计：谁查、何时查、缓存哪、失败回退

**新增 `src/main/services/models/ModelCatalogService.ts`（Main，纯模块 + 懒工厂）。**

| 问题 | 裁定 | 依据 |
|---|---|---|
| **谁查** | Main。`net.fetch` 直打 cch `/v1/models` | 凭据只在 Main（`CredentialVault.ts:52-56`）；agent-host 只有一个 codex key 无 baseUrl（`hostEnv.ts:64-75`）。范式 = `UsageService.ts:102-131` |
| **何时查** | **惰性 + 单飞**：renderer 首次需要目录时经 IPC 拉，Main 侧 in-flight 去重。**不在启动时预热** | 启动期打网络会把「登录态未就绪」变成「目录空」的竞态；`UsageService` 也是按需 |
| **缓存哪** | Main 进程内存 + `<userData>/model-catalog.json` 磁盘缓存，**TTL 24h** | codeg 同款三级（调查 01 §1 `:133`：live→磁盘 cache TTL 24h→内置 snapshot）。磁盘缓存让冷启动离线也有目录 |
| **失败回退** | **三级**：live → 磁盘缓存（过期也用，标 `stale`）→ 编译内置 snapshot | 见下 |
| **凭据不可用** | 直接返回内置 snapshot + `source:'builtin'`，**不报错** | 未登录/flag-off 时目录仍须可用，否则 model 选择器整个瘫掉 |

**返回形状（判别式带来源，不是裸数组）**：

```ts
type ModelCatalogResult = {
  agent: AgentWireName;
  models: { id: string; label: string }[];
  source: 'live' | 'cache' | 'stale-cache' | 'builtin';
  fetchedAt: number | null;
};
```

> `source` 不是诊断糖：§3.3 的短名迁移与 §4.3 的断言都要读它。一个"目录回来了"的 boolean 分不清
> 「代理说只有这些」和「网断了用的内置表」——前者该信，后者不该拿来校验用户的存量选择。

**内置 snapshot 的内容 = 04 实测的两张表**（codex 10 条 / claude 15 条全长名），
落在 `src/shared/models/builtinCatalog.ts`，头注写明**出处 = 调查 04 实测 + 采集日期**，
并注明"这是回退底座不是真源，代理实况以 live 为准"。

**IPC**：新增一条 `MODELS_GET_CATALOG: 'models:getCatalog'`（`ipc.ts:347` USAGE 同级，
命名照 `usage:getStats` 的 `域:动作` 惯例），入参 `{agent: AgentWireName, refresh?: boolean}`。
**一条足够**：per-agent 用入参分岔，不开两条通道。

### 3.2 per-agent 目录切换与 `ComposerModelTrigger` 改造面

`ComposerModelTrigger.tsx` 当前的目录来源是同步纯函数 `ensureModelOptions(hostDefaultModel)`（`:131`），
改造后变成**异步 + per-agent**。改动面：

1. **新增 props `agent: AgentWireName`**（由 `ChatComposer` 传 `resolveDraftAgent(...)` 的结果——
   与 picker 同一个值，单一真源）。
2. **新增 `useModelCatalog(agent)` hook**（`src/renderer/components/chat/useModelCatalog.ts`）：
   内部 `useState` + `useEffect` 调 IPC，按 agent 缓存在 renderer 侧 Map，返回 `{options, source, loading}`。
3. `:131` `const options = ensureModelOptions(hostDefaultModel)` → `const {options} = useModelCatalog(agent)`；
   `ensureModelOptions` 的「Host 默认不在表中就前插」逻辑**移进 hook**（保留行为，换输入源）。
4. **`composerModelMenuModel` 不动**（`composerModel.ts:103-171`）。它的「未知选择前插为独立行、
   不把勾移到 options[0]」逻辑（`:110-127` 的长注释）在目录变大后**更加重要**——存量短名就是靠这条不丢。
5. **`models.ts` 的 `CHAT_MODELS` 三短名表删除**，`defaultModelId` / `ensureModelOptions` 的职责移交 hook；
   `resolveResumeModel`（`:58-64`）**保留**但改为吃 hook 的解析结果。
   → **静态扫描断言**：`src/renderer/components/chat` 下不得再出现 `CHAT_MODELS` 标识符
   （范式 `composerFormStatic.test.ts:53-58` 的"资产删除靠文件系统扫描"）。

**effort 的 per-agent 处理**：**不改。** 04 实证双轴同为五档
（`low/medium/high/xhigh/max`，与 `efforts.ts:24-30` 完全一致），`CHAT_EFFORTS` 继续做双轴共用词表。
`model/list` 的 per-model `supportedReasoningEfforts` **本片不读**——读了要么做 per-model 过滤
（`composerModel.ts:94-96` 明确不做，且理由仍成立），要么读了不用（纯负担）。登记为 §6-未决 #5。

**加载态**：`loading` 时 trigger 显示**上一次的值**（不是 spinner，不是空）。
`ComposerModelTrigger` 的 model 状态本来就是 `useState` 自持（`:107-114`），已有的
「session 切换 / Host 默认迟到」reconciliation effect（`:118-125`）天然覆盖这个形状——目录迟到
与 hostDefault 迟到是同一类事件。**不新增 spinner**。

### 3.3 短名 → 全名迁移：存量 localStorage 怎么办

**现状**：`useSessionModel.ts:12` key `aiclient:chat:session-models`，值是 per-session 的裸字符串 map，
无版本字段。存量值大概率是 `'sonnet'` / `'haiku'` / `'opus'`（`models.ts:17-21`）。
**04 实证：cch 不认短名**（探测 B）。现链路能跑是靠 SDK/CLI 层翻译。

**裁定：不迁移、不改写、不删除存量值。行为靠"翻译层仍在"这个事实兜底 + UI 侧渐进替换。**

理由（三条，缺一不可）：

1. **短名今天仍然能跑通。** 04 探测 B 打的是 cch 的**裸 HTTP**；我们的 Claude 轴走 SDK
   （`claudeRuntime.ts:780-783` 把 model 作为 `query()` 顶层选项），SDK/CLI 自己做短名→全名翻译。
   D47 GUI 点验 Claude 回合 PASS 就是这条链在跑的实证。**"cch 不认短名"不等于"我们下发短名会坏"**
   ——中间隔着一层翻译。把这两件事划等号，就会为一个不存在的故障做一次有风险的写迁移。
2. **写迁移是不可逆的。** 一次性把 `'sonnet'` 改写成 `'claude-sonnet-5'` 需要一张短名→全名映射表，
   而那张表**没有权威出处**（`sonnet` 指向哪个具体版本由 SDK 的当期默认决定，会随 SDK 升级漂移）。
   猜错了就是把用户的会话静默钉在一个他没选过的模型上，且旧值已被覆盖无法回滚。
   `sessionIndex.ts:19-27` 已经为完全同类的问题立过规矩：「normalizing it on load 会让下一次 flush
   把值写进每一行，即把一次兼容的读变成一次不可逆的写迁移」。
3. **不迁移不留残疾。** `composerModelMenuModel`（`:110-127`）对"存量选择不在目录里"的处理是
   **前插为独立行并打勾**——用户看到自己的 `sonnet` 好好地在菜单顶上勾着，
   下一次他点任何一个全名，`setSessionModel` 自然覆盖。**迁移由用户的下一次点击完成**，零风险。

**唯一的主动动作**：新会话的默认值改为**全名**。`defaultModelId` 的回退常量
（`DEFAULT_CHAT_MODEL_ID = 'sonnet'`，`models.ts:23`）改为从目录的第一条取，
目录不可用时用内置 snapshot 的第一条。→ 存量短名自然衰减，无写操作。

### 3.4 Codex 侧目录的第二来源问题

Codex 有两个可能的目录源：cch `GET /v1/models`（10 条，04 实测）与 codex app-server `model/list`
（5 条，S1 spike）。**裁定：只用 cch，不接 `model/list`。**

- `model/list` 已在方法契约里（`codex-method-contract.json` clientRequest[53]），且 S1 spike 真实调用过——
  技术上可行。**但它答的是"codex 二进制内置目录"，不是"代理支持什么"**（调查 01 `:130` 实测）。
  04 探测 H 证明列表外模型打不通 → **代理列表才是决定能否跑通的那个**。
- 接了 `model/list` 就有两张 codex 目录要合并，而合并规则（交集？并集？谁优先？）没有任何证据支撑。
- 代价：`CODEX_METHOD`（`codexWire.ts:85-96`）不用加第十个方法，agent-host 不用加凭据面。

### 3.5 D40 Codex 半边补齐：**非对称裁定**

> **裁定：`buildTurnStartParams` 补 `effort`，不补 `model`。**

`codexRuntime.ts:246-256` 给出的丢弃理由是两条独立的：

| 字段 | 原丢弃理由（`:250-256`） | 04 之后是否仍成立 | 裁定 |
|---|---|---|---|
| `effort` | "per-model 词表，从未读过 `model/list`，盲映射会 fail turns" | ❌ **已消除**。04 探测 E/G 实证：cch 侧五档词表 = `low/medium/high/xhigh/max`，与 `CHAT_EFFORTS`（`efforts.ts:24-30`）逐值一致；越界是**显式报错非静默**（探测 G） | **补上** |
| `model` | "已在 `thread/start` 钉死（`buildThreadStartParams:211-224`），会话建立时生效一次" | ✅ **仍成立**，且与 effort 无关 | **不补** |

**为什么 model 不补（这是本轨最容易被质疑的一处，理由必须硬）**：

1. **model 的覆盖是 sticky 的。** `codexRuntime.ts:246-249` 引用 schema 原文：`turn/start` 的
   `approvalPolicy`/`sandboxPolicy`/`cwd` 覆盖适用于"本回合**及后续回合**"，`:255-256` 说 model 同样 sticky。
   → 补 model 意味着**姿态有了第二个真源**，而 `thread/start` 那个真源还在。两处不一致时谁赢没有证据。
   effort 没有这个问题：`thread/start` 根本不发 effort（`buildThreadStartParams:216-223` 只有
   `cwd/approvalPolicy/sandbox/model?`），所以 `turn/start` 补 effort 是**唯一真源**，不是第二个。
2. **Codex 会话换 model 的正确做法是新会话。** 这与 D48 拍板 ② 的「agent 物化后锁定」同构——
   Codex 的 thread 与 model 在 `thread/start` 一起定型，中途换等于换了一个上下文的连续性假设。
3. **Claude 轴补了 model 是因为它每回合重开 CLI。** `agentHost.ts:91-96` 注释明写：
   "resumed session without an explicit model silently falls back to the CLI default" ——
   Claude 那边**必须**每回合带 model 否则会漂。Codex 是长驻 app-server + 持久 thread，没有这个漂移压力。
   **同一个 D40 票号，两轴的正确解本来就不同。**

**改动面（S2 内，加法）**：

```ts
// codexRuntime.ts:259-265
export function buildTurnStartParams(input: {
  threadId: string;
  text: string;
  effort?: SessionEffortLevel;   // 新增
}): CodexTurnStartParams
```
`CodexTurnStartParams`（`:232-235`）加 `effort?: string`。
`effort` 字段名与词表已由 `codex-turn-schema.json` 的 `TurnStartParams.propertyNames` 钉住（含 `effort`），
`codexWireContract.test.ts` 范式的契约测试**必须同步扩到断言这个字段名**——否则 codex 升级改名会变成
运行时 `-32602`。调用点 `:2393-2396` 把 `send()` 已经收到的 `effort`（`:2304-2311`）透传进去，
**删掉 `:250-256` 中已被证伪的那半段注释，保留 model 那半段并补上本裁定的理由**。

> **未决保留项**：`effort` 的 sticky 性。schema 对 `effort` 是否 sticky 未明说，`:246-249` 只对
> approvalPolicy/sandboxPolicy/cwd 引用了 sticky 措辞。若 effort 也 sticky，则"这一回合调高"会
> 意外延续到后续回合——**但这恰好是 Claude 轴的现有行为**（`claudeRuntime.ts:514-521` 明确把
> 新 model 写回 session 默认）。故即使 sticky，双轴行为一致，不构成阻断。登记 §6-未决 #6。

---

## §4 S3 — 权限面

### 4.1 分层：本片做什么、明确不做什么

| 层 | 本片 | 说明 |
|---|---|---|
| **L1 读侧补链** | ✅ 做 | Codex 会话的 Context 面板不再整行消失 |
| **L2 capabilities 补键** | ✅ 做 | `permissionPolicy: true`（N1，类型已存在 Host 忘发） |
| **L3 写侧：会话创建时选姿态** | ✅ 做 | 未物化会话可选权限档，随 create 下发；**物化后锁定**（与 agent 同语义） |
| **L4 写侧：会话中途改档** | ❌ **不做**，条件执行 | 两条协议半通道均未实证，探针先行（§4.4） |
| **L5 单次工具审批** | ❌ 不做 | `PermissionQaCard`（`QuestionCard.tsx:498`）已存在，是独立概念（调查 02 §4） |

> **L3 为什么进本阶段（回答调查 README 的裁定项"权限写侧要不要进本阶段首切片"）：**
> 不是"首切片"，是**第三片**。理由：L3 的下发时机与 agent/model 完全同构——都是
> "未物化时可选、随 create 一次性下发、物化后锁定"。三个控件共用一套锁定判定（§2.3 的
> `computeEverHostBound`）和一套 wire 时机，**分开做等于把同一个语义实现三遍**。
> 而 L4 与它们不同构（需要新协议 + 中途生效），所以被切出去。

### 4.2 L1：Codex 读侧补链（三处改动 + 一个陷阱）

1. **`ContextRuntimeFacts` 加字段**（`contextSurfaceModel.ts:75-99`）：
   加 `permissionPolicy?: SessionPermissionPolicy | null`，**与现有 `permissionMode` 并存不替换**。
   > 不替换的理由：`permissionMode`（`:98`）的三态语义（undefined 省略行 / null "not reported" / 值→文案）
   > 被 `buildRuntimeRows:221-227` 和一堆测试钉着，且 `SessionCreatedEvent.payload` 至今**同时**携带
   > 历史字段 `permissionMode?`（`runtimeEvents.ts:555`）与新字段 `permissionPolicy?`（`:567`，
   > 注释 "Absent = fall back to the permissionMode row"）。**wire 上就是并存的，模型层也并存**，
   > 是对齐不是冗余。
2. **reduce 加分支**（`reduceSessionRuntimeFacts`，`:472-509`）：在现有 `permissionMode` 守卫**之前**
   读 `payload.permissionPolicy`，用新守卫 `isSessionPermissionPolicy`（判别位 `agent`，
   `runtimeEvents.ts:540-550`）。
   > ⚠️ **N4 陷阱**：`:499-501` 的 `if (!isSessionPermissionMode(permissionMode)) return prev;`
   > 会让 Codex payload（无 `permissionMode` 键）在这里 return，后面加的任何 `permissionPolicy`
   > 处理都**静默 no-op**。这与 `:483-486` 的 D33 注释记载的事故是同一形状。
   > **必须放在它之前**，且必须有一条断言专门钉这个顺序（§4.3-A2）。
3. **`buildRuntimeRows` 行构建**（`:213-231`）：`permissionPolicy` 存在时渲染它，
   否则回落到现有 `permissionMode` 行（**wire 注释 `:567` 已经规定了这个优先序**，照抄即可）。
   Codex 姿态一行三值：`Approval: on-request · Sandbox: workspace-write · Network: off`。
   新增 `CODEX_APPROVAL_LABELS` / `CODEX_SANDBOX_LABELS`，与 `PERMISSION_MODE_LABELS`（`:171-177`）同级同风格。
4. **`isSessionPermissionPolicy` 守卫**：调查 02 §1 说"全仓零命中"，需**新建**。放 `runtimeEvents.ts` 旁
   还是 `contextSurfaceModel.ts` 内？→ **放 `contextSurfaceModel.ts`**，与既有 `isSessionPermissionMode`
   （`:449-451`）同处，保持"守卫跟着消费者走"。

**Host 侧同步（L2）**：`agent-host/index.ts:363-373` 的 capabilities 补 `permissionPolicy: true`；
`hostStatus.ts:38` 的 `HostStatus.capabilities` 加 `permissionPolicy?: boolean`，
reduce（`:90-98`）与 prime（`:182-187`）**两条通道都要加**——`hostStatus.ts:155-160` 的注释记录过
slice 6 的原始事故：只加一条通道，另一条静默丢字段。

### 4.3 L3：写侧管理面的最小形态与持久化

**形态**：**不进 Composer 底栏**。三个 pill 挤在 `h-6` 的底栏里会撑爆 `@[30rem]` 的窄形态
（codeg 都要折叠成 Popover，调查 03 §4）。**落点 = Context 面板**（`ContextSurfaceView.tsx`），
把现在的只读 "Permission policy" 行在**未物化**时替换为可写控件。

> 这是本轨与 codeg 的一处刻意分歧。codeg 把权限实时档放在 composer 是因为它**能中途改**
> （ACP `session/set_mode`）；我们 L4 不做、只有创建时一次性下发，**放在一个每回合都看得见的
> 高频位置会暗示它随时可改**——那是关于产品的谎言（同 `composerModel.ts:91-93` 的规矩）。
> Context 面板是"这个会话的事实"面，一个"创建前可改、创建后变只读"的控件正属于那里。

- Claude 轴：5 值 RadioGroup（`SessionPermissionMode`，`runtimeEvents.ts:506-511`，**冻结类型不动**）。
  **不加 SDK 的第 6 值 `'auto'`**——调查 02 §6-4 明确其行为未实证，且可能需额外开关（类比
  `bypassPermissions` 需 `allowDangerouslySkipPermissions`）。登记 §6-未决 #7。
- Codex 轴：`approvalPolicy` 3 值 + `sandboxMode` 3 值 + `networkAccess` 开关。
  > ⚠️ `networkAccess` **不是 `thread/start` 的请求字段**（`codexRuntime.ts:122-132`，只在响应回声里，
  > `compareSandboxEcho:594-665` 校验）。它只能经 **config.toml 投影**生效
  > （`codexHome.ts:149-152/:173-178/:412`）。→ **本片 `networkAccess` 只读展示不给控件**，
  > 给了控件就要改 config.toml 写手，而 resume 姿态是从 config.toml 重派生的（`:2952-2954` H9），
  > 改它会波及 resume 回声校验。登记 §6-未决 #8。
- **`bypassPermissions` / `danger-full-access` 两个危险档**：**给控件但加二次确认**，
  且**不做默认值**。不给控件不行——不给就等于我们替用户决定他不能用（而 codeg 给了）。

**持久化位置裁定：localStorage（renderer），不进 session-index。**

| 候选 | 裁定 | 理由 |
|---|---|---|
| localStorage per-session map | ✅ **采纳** | 与 model（`useSessionModel.ts:12`）/effort（`sessionEffortStore.ts`）/agent 草稿（§2.3）**四者同构**，一套范式一套测试形状 |
| `session-index.json` | ❌ | `sessionIndex.ts:10-35` 的头注：该文件必须保持**裸 JSON 数组**，加字段只能是 optional per-entry；且它是 **Main 侧**存储，写它要新增 IPC。而权限是**创建前的草稿**，物化后就由 Host 的姿态接管（Codex 甚至从 config.toml 重派生），**根本不需要跨重启存活** |
| `HostSession`（`sessionRegistry.ts`） | ❌ | 调查 02 §2 已指出它连 permissionMode 字段都没有。加它是 Host 侧存储位，属于 L4 的地基不是 L3 的 |

**下发**：`SessionCreateCommand.payload`（`agentHost.ts:61-77`）加可选
`permissionPolicy?: SessionPermissionPolicy`（判别联合，agent 位自带）。
`claudeRuntime.ts:341` 与 `codexRuntime.ts:1547` 的常量默认改为「有则用、无则常量」——
`CHAT_PERMISSION_MODE`（`claudeRuntime.ts:215`）与 `CODEX_PERMISSION_DEFAULT`（`codexRuntime.ts:134-144`）
**保留为默认值，不删**（它们是 `:204-214` 自陈的"单一真源"，参数化的正确做法是给它一个覆盖入口，
不是把常量拆了）。

### 4.4 L4：两条未实证通道 —— 条件执行项

> **以下两项在探针出结果之前，一律不得进入施工范围。规格里写它们是为了钉住"探什么、什么算过"，
> 不是为了排期。**

**【条件执行 C2】SDK `Query.setPermissionMode()` 探针**

- **探什么**：纯文本 prompt（非 streaming input）下调用的真实失败模式——抛异常 / 静默无效 / 自动切换。
- **为什么必须探**：`claudeRuntime.ts:32-34` 把 `queryFn` 类型收窄成 `AsyncIterable & {close?}`，
  **类型上抹掉了 `setPermissionMode`**；且 prompt 只在有附件时才是 AsyncIterable（`:706-708` 三元），
  纯文本走字符串。→ 我们**大多数回合都不满足 SDK 文档写的 streaming-input 前提**。
- **过的判据**：纯文本场景下调用后，**下一个回合的实际权限行为**与新档一致（不是"没抛异常"就算过——
  静默无效恰恰不抛）。需要一个会触发权限询问的真实回合做对照臂。
- **不过怎么办**：L4 Claude 半边取消，或退到"改档需要重开会话"（与 Codex 半边对齐）。

**【条件执行 C3】codex `thread/settings/update` 探针**

- **探什么**：参数 schema、能否中途改 approvalPolicy/sandboxMode、对挂起 turn 的影响。
- **现有证据强度**：**仅方法名**。`codex-method-contract.json` clientRequest[110] 有它
  （已复核命中），`serverNotification` 有 `thread/settings/updated`，但**零 schema 样本零调用**；
  且 contract 头部自陈 L6 欠采（clientRequest 实录 121 vs 实际 126）。
  `CODEX_METHOD`（`codexWire.ts:85-96`）九方法不含它。
- **过的判据**：能拿到 schema（`codex app-server generate-json-schema` 是否输出它）**且**
  真实调用后 `thread/status/changed` 或后续 turn 行为反映新姿态。
- **竞品线索**：`turn/start` 的 sticky 覆盖是**第二条路**（`codexRuntime.ts:246-249`，
  schema 层已确认 approvalPolicy/sandboxPolicy 是合法字段）。若 C3 探不通，
  **sticky 覆盖是更可能成立的备选**——但它引入 §3.5 讨论过的"第二真源"问题，
  且比 model 的情况更糟（权限姿态还有 config.toml 这第三个载体，H9）。
  → **两条都不通时，L4 Codex 半边明确不做**，不硬上。

---

## §5 每片的 Happy Path · 确定性断言点 · 变异验证候选

> 规范 12 条：定义验证在先。断言**先钉过程**（哪个函数被调用、参数是什么、顺序如何），
> LLM-judge 一律不用（本批无模糊评分需求）。

### 5.1 S1（agent picker）

**Happy Path**：flag-on 冷启动 → Host ready 带 `agents:['claude-code','codex']` → 新建会话（未物化）
→ Composer 底栏出现两项 pill，选中 `Claude Code` → 点 `Codex` → 草稿落 localStorage
→ 发首条消息 → `chat.createSession` 收到 `agent:'codex'` → `session.created` 回填 `session.agent='codex'`
→ pill 转 disabled 且仍高亮 Codex → 重启 app → 会话从 index 恢复（`runtimeIdentity` 在）→ **pill 仍锁定**。

**确定性断言（A1~A6）**

| # | 断言 | 形状 |
|---|---|---|
| A1 | `agents` 为 `undefined` / `['claude-code']` / `[]` 三种输入下，picker 视图模型判 `render:false`；`['claude-code','codex']` 判 `true` | 纯函数真值表（视图模型抽成纯模块 `agentPickerModel.ts`，node-env 直跑） |
| A2 | `computeEverHostBound` 提取后，`useComposerTarget` 与 picker **import 同一个符号**；且 `hostBoundSessionIds=[]` + `runtimeIdentity='x'` 输入下判 `true` | 真值表 + 静态扫描（新模块名在两处 import 行出现） |
| A3 | 首条消息发出时 `chat.createSession` 的 `agent` 参数 === 草稿值；**两条发送路径**（`chatSessions.sendMessage` / `ChatComposer.runSend`）各一例 | spy on `window.electronAPI.chat.createSession`，断参数对象 |
| A4 | 草稿指向已消失的 agent → 解析结果 = `LEGACY_AGENT` **且** 返回 `fellBack:true`（不是静默） | 纯函数，`resolveDraftAgent` 返回判别式 |
| A5 | 已物化会话（`locked:true`）时，picker 视图模型的两项均 `disabled:true`，且选中项仍是 `sessionAgent(session)` | 真值表 |
| A6 | `agentPickerModel.ts` 与 `sessionBinding.ts` 过 `pureModuleImports` 扫描（已加入 `TARGET_FILES`） | 静态扫描 |

**变异候选（4 对，逐对实跑记红灯）**

① `computeEverHostBound` 删掉 `|| runtimeIdentity != null` 析取项 → A2 红
② picker 在 `agents.length===1` 时也渲染 → A1 红
③ `resolveDraftAgent` 回退时不置 `fellBack` → A4 红
④ 两条发送路径之一改回直读 `sessionAgent(preSession)` 忽略草稿 → A3 的对应一例红
（**④ 是"发射半边 pin"**：两条路径必须各有一例，只钉一条会让另一条的漂移无人看守）

### 5.2 S2（模型目录 + D40 半边）

**Happy Path**：登录态就绪 → 打开 Composer → `useModelCatalog('claude-code')` 首次触发 IPC
→ Main 单飞 `net.fetch(claudeBaseUrl + '/v1/models')` → 15 条全名入内存 + 落磁盘缓存
→ 菜单显示全名，存量 `sonnet` 前插为独立行且打勾 → 用户点 `claude-sonnet-5` → 覆盖 localStorage
→ 切 picker 到 Codex → `useModelCatalog('codex')` 拉 10 条 → 选 `gpt-5.6-sol` + effort `high`
→ 发消息 → `turn/start` params 含 `effort:'high'`。

**确定性断言（B1~B7）**

| # | 断言 | 形状 |
|---|---|---|
| B1 | 三级回落真值表：live 成功→`source:'live'`；live 失败+缓存新鲜→`'cache'`；live 失败+缓存过期→`'stale-cache'`；live 失败+无缓存→`'builtin'`；**凭据不可用→`'builtin'` 且 `net.fetch` 调用数 0** | 纯模块 + fake fetch + mkdtemp |
| B2 | 单飞：同一 agent 并发 3 次请求 → `net.fetch` 恰 1 次 | spy 调用计数 |
| B3 | per-agent 隔离：拉 `claude-code` 不污染 `codex` 的缓存条目，反之亦然 | 两 agent 交叉真值表 |
| B4 | 存量短名 `'sonnet'` + 全名目录 → `composerModelMenuModel` 前插一行 `id:'sonnet'` 且 `selected:true`，**且不改 localStorage**（读后 storage 字节不变） | 已有测试扩例 + storage 快照对比 |
| B5 | `buildTurnStartParams({threadId,text,effort:'high'})` → `{threadId, input, effort:'high'}`；不传 effort → **无 `effort` 键**（不是 `undefined` 值） | 纯函数，`toEqual` + `'effort' in params` |
| B6 | `buildTurnStartParams` **不含 `model` 键**，无论 send 传不传 model | 负控断言（钉 §3.5 裁定） |
| B7 | 契约测试扩到断言 `effort` ∈ `codex-turn-schema.json` 的 `TurnStartParams.propertyNames` | 读 fixture 比对 |
| B8 | `src/renderer/components/chat` 下 `CHAT_MODELS` 标识符零命中（`stripComments` 后扫描） | 静态扫描（资产删除） |

**变异候选（5 对）**

① 缓存 TTL 判定反向（过期当新鲜）→ B1 红
② 单飞去重删掉 → B2 红
③ `composerModelMenuModel` 的未知项前插改为"勾移到 options[0]" → B4 红
④ `buildTurnStartParams` 顺手把 `model` 也加上 → **B6 红**（这一对是 §3.5 裁定的承重变异）
⑤ 凭据不可用时改为 throw → B1 的 builtin 臂红

### 5.3 S3（权限面）

**Happy Path**：Codex 会话建立 → `session.created` 带 `permissionPolicy:{agent:'codex',...}`
→ Context 面板出现 "Permission policy" 行显示三值（**今天这行整个消失**）
→ 新建未物化会话 → 该行变可写控件 → 选 `approvalPolicy:'never'` → 草稿落 localStorage
→ 发首条消息 → `session.create` 命令携带该 policy → Host 用它而非常量默认 → 物化后该行转只读。

**确定性断言（C1~C6）**

| # | 断言 | 形状 |
|---|---|---|
| C1 | Codex `session.created` payload（有 `permissionPolicy` 无 `permissionMode`）经 `reduceSessionRuntimeFacts` → facts 里 `permissionPolicy` 已写入 | reduce 真值表 |
| **C2** | **顺序钉子（N4）**：同一 payload，若把 `permissionPolicy` 分支放在 `isSessionPermissionMode` 守卫**之后**，C1 必须红 | 变异对 ①（见下） |
| C3 | Claude `session.created`（有 `permissionMode` 无 `permissionPolicy`）→ 行仍走旧文案，与今天逐字一致 | 回归对照（**不许改现有输出**） |
| C4 | 两者都有时 → `permissionPolicy` 优先（钉 `runtimeEvents.ts:567` 的 wire 规定） | 真值表 |
| C5 | `capabilities.permissionPolicy` 缺失（old Host）→ 面板行为退回今天（`permissionMode`-only），不报错不空行 | 降级真值表 |
| C6 | `capabilities.permissionPolicy` 在 reduce 与 prime **两条通道**都能到达 `HostStatus`（各一例） | 双通道 pin（照 `hostStatus.ts:155-160` 的事故形状） |
| C7 | 未物化时控件可写、`locked` 时只读；且复用 §2.3 同一 `computeEverHostBound` | 真值表 + 共用符号扫描 |
| C8 | `networkAccess` **无写控件**（负控：面板视图模型里该字段 `writable:false`） | 负控断言（钉 §4.3 裁定） |

**变异候选（4 对）**

① `permissionPolicy` 分支移到 `isSessionPermissionMode` 守卫之后 → C1/C2 红（**承重行变异**）
② `buildRuntimeRows` 优先序反过来（permissionMode 赢） → C4 红
③ prime 通道漏掉 `permissionPolicy` 键 → C6 的 prime 臂红
④ 给 `networkAccess` 加上写控件 → C8 红

### 5.4 每片共有的版本戳（规范 15 条）

每片 as-built 段落必须记：git commit · 四门逐门实跑输出（文件数/例数）· 变异逐对红灯原文 ·
flag off/on 双轮结果 · 本片新增/改动文件清单 · 规格偏差条目。

---

## §6 风险与未决表

### 6.1 需要用户拍板（不自行扩权，含推荐案）

| # | 问题 | 背景（这东西是干嘛的 / 别人怎么做） | 选项 | **推荐** |
|---|---|---|---|---|
| **Q1** | **S3 的写侧权限控件落在 Context 面板还是 Composer 底栏？** | 权限档决定 agent 动手前问不问你。codeg 放 composer（因为它**能中途改**）；我们 L4 不做，只有创建时下发一次。放 composer 会暗示随时可改 | (a) Context 面板（未物化可写、物化只读）(b) Composer 底栏第三个 pill (c) 全局 Settings 页 | **(a)**。见 §4.3 的完整理由 |
| **Q2** | **要不要让用户看见"codex 为什么不可用"？** | 今天 wire 上只有"能跑的 agent 列表"，Host 内部知道四种失败原因（flag 没开 / 缺凭据 / 没装 codex / 家目录建不了）但不外发。codeg 会显示琥珀点 + "Not installed" | (a) 二态：不可用就不显示 (b) 三态 C1：扩 wire 发诊断原因 + 琥珀点 | **(a)**。(b) 把 Host 内部诊断变成对外契约，收益仅在"用户自己装了 codex 但没生效"这一窄场景。若用户认为该场景高频，改选 (b) |
| **Q3** | **`bypassPermissions` / `danger-full-access` 两个危险档给不给控件？** | 这俩是"agent 干什么都不问你"。Claude 侧 SDK 另有 `allowDangerouslySkipPermissions` 开关；codeg 全给了 | (a) 给 + 二次确认 (b) 给 + 藏在 Settings 高级区 (c) 不给 | **(a)**。不给等于替用户决定；但**默认值绝不能是它们** |
| **Q4** | **S3 的 L4（会话中途改权限档）要不要现在探针？** | 两条通道（SDK `setPermissionMode` / codex `thread/settings/update`）都只有"名字存在"级证据，探一次约需一轮真机 | (a) 本阶段探（C2+C3）(b) 押后到阶段 4 (c) 明确不做 | **(b)**。S1~S3 的价值不依赖它；探针要真机轮，与 test.4 补测批合跑更省 |

### 6.2 未决登记（不阻塞施工）

| # | 项 | 处置 |
|---|---|---|
| 5 | `model/list` 的 per-model `supportedReasoningEfforts` 从未读取 | §3.2 裁定本片不读（读了要么做过滤要么白读）。若将来出现"某模型不支持 xhigh"的真实故障再开 |
| 6 | `turn/start` 的 `effort` 是否 sticky（schema 未明说） | §3.5 已论证即使 sticky 也与 Claude 轴现有行为一致，不阻断。S2 GUI 点验时顺手观察 |
| 7 | SDK `PermissionMode` 第 6 值 `'auto'` 行为未实证 | §4.3 决定不加进冻结类型。随 Q4 的探针一并处理 |
| 8 | `networkAccess` 只能经 config.toml 生效，且 resume 从 config.toml 重派生（H9） | §4.3 决定本片只读不写。要写需连带改 `codexHome.ts` 写手 + resume 回声校验，独立成票 |
| 9 | cch `/v1/models` 的长期可信度 | 04 是单日快照。§3.1 的三级回落使设计不依赖它长期为真；但内置 snapshot 会随时间过期，需登记"每次发布前对一次" |
| 10 | 存量短名的自然衰减速度 | §3.3 的迁移靠用户下次点击。若半年后仍有大量短名残留且 SDK 翻译层变了，届时才需要写迁移（那时会有真实映射证据） |

### 6.3 风险（本轨认为最重的三条）

**R1 · `computeEverHostBound` 不提取，锁定语义在三个控件间漂移。**
D48 拍板 ② 的"物化后锁定"要被 agent picker（S1）、权限控件（S3）和已有的 ComposerTargetBar 三处共同遵守。
今天这个判定是 `useComposerTarget.ts:82-91` 的**模块私有函数**，其注释（`:76-81`）已经记录过一次
「判错会把旧会话 resume 进新 cwd」的事故形状。三处各写一份的后果不是 UI 不一致，是
**一个从 session-index 恢复的 Codex 会话被判为"未物化"、用户改成 Claude、下一条消息拿着 Codex 的
threadId 走 Claude 运行时的 resume 分支**。提取是 S1 的第一个动作，不是 nice-to-have。

**R2 · 目录代理化把一次网络故障变成"模型选不了"。**
今天 `ensureModelOptions` 是同步纯函数，永不失败。改造后它成了一条跨 Main / net.fetch / 磁盘缓存的链路，
而它服务的是**发消息前的必经控件**。§3.1 的三级回落 + §3.2 的"loading 时显示上一次的值"是针对性设计，
但真正的风险在**凭据态**：`resolveManagedCredentialsEnabled` 为 on 而 vault 是 `locked`
（safeStorage 未解锁，D47 S1 §2.1 记录过窗前死锁 E6）时，目录服务必须走 builtin 而不是卡住——
B1 的"凭据不可用→builtin 且 fetch 计数 0"就是这条的断言，**它是本片最重要的一条断言，不是边缘用例**。

**R3 · D40 Codex 半边的非对称裁定（补 effort 不补 model）会被后来者"顺手补全"。**
§3.5 的理由链依赖两个不对称事实：`thread/start` 发 model 但不发 effort；schema 说覆盖是 sticky。
这两条都写在注释里，而注释不阻止代码。一个觉得"D40 就该两个都补"的后来者加上 model，
就制造了 `thread/start` 与 `turn/start` 两个 model 真源——**而且不会有任何测试变红**，因为
两处都发同一个值时行为一致，只有在"用户中途改 model"这条路径上才会分叉，而那条路径今天没人测。
→ 缓解 = B6 的**负控断言**（`buildTurnStartParams` 不含 `model` 键）+ 变异对 ④。
这是本规格里唯一一条"为了防止未来的正确性错误而写的负控"，**不能在评审时被当作冗余删掉**。

---

## §7 边界重申（本阶段不做）

多 agent 协同 · 终端轴 `AgentPickerMenu`/`SessionBar` 任何改动 · 2b 打包链 · git surface 扩展（open-q #4）
· 提问坞单槽（open-q #10）· cch 服务端改动 · ACP 通道（D45 已定直连）
· 会话中途改权限档（L4，条件执行）· `networkAccess` 写侧 · SDK `'auto'` 权限档。
