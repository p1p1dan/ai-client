# D48 施工规格草案 B — Codex CLI 选择功能（阶段 3）

> 日期：2026-08-16  
> 性质：独立设计轨 B；施工规格草案，不是实现记录  
> 输入：本目录 `README.md`、调查 00～04、`05-design-brief.md`，以及本文引用的仓内代码实证

## 0. 结论先行

D48 应拆成 **3 个必做切片 + 1 个条件切片**，按 `S1 → S2 → S3 → S4（条件）` 串行：

1. **S1：聊天轴 agent picker 与零回合绑定。** 在 Composer 底栏新增聊天专用的两段式 segmented picker；选择只写现有 `ChatSession.agent?`，不引入 `BuiltinAgentId` 转换。首条发送通过全部 guard、抵达 `onSendStart()` 的同步提交点后立即锁定；Host 回包与 session-index 继续确认同一绑定。
2. **S2：模型目录改为代理真源，并补齐 Codex D40。** 新建 Main 侧目录服务，使用托管凭据直接查询 cch 双轴 `/v1/models`，Renderer 只收脱敏目录。目录按 agent 切换，模型/effort 偏好按 agent 保存；Codex `turn/start` 必须补发本回合 `model` / `effort`，不再维持“只在 thread/start 钉死”的旧裁定。
3. **S3：权限读侧闭环 + 新会话默认权限管理。** 先把已经存在的 `SessionPermissionPolicy` 接进 `sessionRuntimeFacts` 和 Context 面板；写侧只做“新会话/恢复时采用的默认权限”，放在独立的 Chat agent defaults 设置区并持久化到 app settings，不复用终端轴 `AgentSettings`，也不直接改用户 `~/.codex/config.toml`。
4. **S4：会话中途改权限，仅条件执行。** Claude `Query.setPermissionMode()` 和 Codex `thread/settings/update` 都必须先有真实探针与契约 fixture。任一探针不成立，就不实现该轴的实时 selector；D48 仍可凭 S1～S3 完成“可选择 agent、目录按 agent 适配、权限可读且可管理新会话默认值”的阶段目标。

核心裁定如下：

- agent picker **显示不可用项而不是隐藏**。`host.ready.capabilities.agents` 的类型注释已经写明 Renderer 对缺失 agent 应 disable，而非 hide；old Host 缺字段时按 legacy Claude-only 降级（`src/shared/types/runtimeEvents.ts:104-108`）。
- picker 的视觉形态采用 **两段式 segmented ghost pill**，但遵循本仓 Composer ghost chip 规则：24px 高、`rounded-sm`、静息无边框/阴影/固定最小宽度，hover 与 focus-visible 成对显壳（`docs/design-system.md:360-388`）。不照搬 codeg 的满圆大胶囊。
- 目录查询 **不塞进 `host.ready`**，也不把 key/base URL 发到 Renderer。`host.ready.capabilities` 只描述 Host build/process 能力，不承载 per-agent 服务目录（`src/shared/types/runtimeEvents.ts:85-115`）；目录使用独立 IPC invoke。
- `/v1/models` 是可用模型真源；失败时不得把旧静态表重新伪装成“可用目录”。回退顺序为：fresh → 进程内 stale cache → 当前会话已存选择（标记 unverified）→ `Automatic`（省略 model）+ Retry。
- Claude 存量短名 `sonnet/haiku/opus` **不自动猜成某个全长名**。短名代表可漂移的 CLI alias，目录没有“它今天解析到哪一条”的事实。存量会话保留为 `Legacy alias` 合成项；用户一旦改选，只能写代理目录返回的全长名或 `Automatic`。
- Codex D40 选择 **给 `buildTurnStartParams` 增加 `model` / `effort`**。调查 04 已消除旧注释的两个前提：cch 的目录可信，effort 五档为 `low/medium/high/xhigh/max`，`ultra` 明确报错（`04-cch-live-probe.md:21-39`）。`thread/start` 仍负责初始值；`turn/start` 负责本回合覆盖并按 Codex schema 的 sticky 语义成为后续默认。
- 权限写侧第一阶段只管理 **创建/恢复姿态**。Claude 暴露冻结的五值 `SessionPermissionMode`；Codex 暴露 `approvalPolicy` 三值 + `sandboxMode` 三值。`networkAccess` 先只读，因为现代码明确把它视为服务端回声而非 config/request 键（`src/agent-host/codexHome.ts:154-163`）。

## 1. 不可重开的约束与施工边界

### 1.1 已拍板约束

本文按以下约束施工，不再比较替代路线：

- 三块全做：agent 入口、模型/思考档按 agent 适配、权限模式管理面（`05-design-brief.md:6-11`）。
- agent 零回合可选，首条消息物化后锁定；换 agent 等于另开会话，不能迁移当前 runtime identity（`docs/plans/openchamber-chat-refactor-ledger.md:92`）。
- 继续 D45 直连，不引入 ACP/config_options（`docs/plans/openchamber-chat-refactor-ledger.md:89-92`）。
- 聊天轴只使用 `AgentWireName`；不改终端轴 `AgentPickerMenu`、`SessionBar`，不做 `AgentWireName ↔ BuiltinAgentId` 转换。
- `AICLIENT_AGENT_CODEX` 只控制 Host registry/capabilities 与运行时注册；Renderer/store 形状不得因 flag 分叉。
- `chatSessions.ts` 红线只做加法，不把目录、权限、临时请求状态继续塞入该 store。
- 每片按工程规范第 12/4/15 条：断言先行；断言过程与状态机而非只验观感；完成后登记任务/证据闭环。四门逐门串行：
  1. `pnpm typecheck`
  2. `pnpm typecheck:agent-host`
  3. `pnpm lint`
  4. `pnpm test`

门禁权威见 `docs/plantree/baseline/test-and-release-gates.md:3-18` 与 `package.json:30-34`。

### 1.2 本阶段明确不做

- 多 agent 协同或同会话切 agent。
- 终端轴 picker/settings 改造。
- 阶段 4 的 2b 打包链。
- git surface 扩展、提问坞单槽。
- cch 服务端、供应商配置或模型重定向表改动。
- 猜测/模拟 `thread/settings/update` 或 SDK 实时权限协议。
- 将模型目录、凭据或权限写进 ACP config_options。

## 2. 总体数据流与所有权

```text
Managed credential / adopted runtime config (Main authority)
        │
        ├─ AgentCatalogService ── GET claude /v1/models (x-api-key)
        │                       └─ GET codex  /v1/models (Bearer)
        │                              │
        │                    sanitized AgentModelCatalog
        │                              │ IPC invoke
        ▼                              ▼
AgentHostManager                Renderer catalog query/cache view
        │                              │
        │ host.ready.capabilities      ├─ AgentPicker (agents availability)
        │ session.created policy       └─ ComposerModelTrigger (agent catalog)
        ▼
runtime event bus ── sessionRuntimeFacts ── Context Permission policy rows

Chat draft/session:
ChatSession.agent? ── first send snapshot ── session.create(agent, model, effort, permission)
                                             └─ session.send(model, effort)
```

所有权规则：

| 数据 | 真源 | 持久化 | Renderer 可见内容 |
|---|---|---|---|
| agent 可用性 | `hostStatus.capabilities.agents` | Host ready snapshot | agent slug 列表，不含失败原因/凭据 |
| 草稿/会话 agent 绑定 | `ChatSession.agent?` + session-index 回填 | 首条发送后由既有 index 链持久化 | `AgentWireName` |
| 模型可用目录 | cch 双轴 `/v1/models` | Main 进程内 TTL cache；不落 key | id/label/source/fetchedAt/stale/error |
| 当前会话 model/effort | 现有 per-session storage | localStorage；升级 schema | 该 session 的选择 |
| 新会话 per-agent 默认值 | 新 `chatAgentDefaults` settings | app settings store | agent/model/effort/创建期权限模板 |
| 已物化会话权限请求 | 首发时从默认模板复制出的 session snapshot | session-index 可选加法字段 | resume 使用的稳定 permission preference |
| 实际权限姿态 | Host `session.created/resumed.permissionPolicy` | adjacent runtime facts store | Context 只读行 |
| 会话中途权限 | 未成立 | 无 | S4 探针通过前无写控件 |

## 3. S1 — Agent picker 与零回合绑定

### 3.1 组件形态与落点

新增聊天轴组件，建议文件：

- `src/renderer/components/chat/ComposerAgentPicker.tsx`
- `src/renderer/components/chat/composerAgentPickerModel.ts`
- `src/renderer/components/chat/__tests__/composerAgentPickerModel.test.ts`

落点严格位于模型控件同级：

- session 模式：`attach → textarea → status → agent → model/effort → actions`，基于 `ChatComposer.tsx:2455-2461`。
- empty 模式：`attach → agent → model/effort → status → actions`，基于 `ChatComposer.tsx:2470-2479`。

两段固定为 `Claude Code` / `Codex`，值来自 `AGENT_WIRE_NAMES` / `AGENT_DISPLAY_NAMES`，不得复制字面联合。使用单选语义：`role=radiogroup` 或等价 `ToggleGroup type="single"`；每项有可访问名称，方向键切换，focus-visible 与 hover 同层显壳。

视觉约束：

- 总高 `h-6`，`rounded-sm`，`text-ui`；不得 `border*`、`shadow*`、`min-w-*`、`rounded-md+`。
- 当前项使用 `bg-selection text-foreground`；非当前项静息透明。
- 窄宽时隐藏非当前项的长 label，只留图标 + `sr-only` 名称；不得靠固定 min-width 抢 textarea。
- 不可用与锁定原因必须有 tooltip/title，不能只靠 opacity。

### 3.2 三态与降级矩阵

纯函数 `deriveComposerAgentOptions()` 接收：

- `capabilitiesAgents: readonly AgentWireName[] | undefined`
- `selectedAgent: AgentWireName`
- `locked: boolean`
- `hostState`

输出每项 `{agent, selected, available, disabled, reason}`。

| 输入状态 | Claude | Codex | UI 口径 |
|---|---|---|---|
| `agents=['claude-code','codex']`，未锁 | 可选 | 可选 | 正常 segmented picker |
| `agents=['claude-code']`，未锁 | 可选 | disabled | `Unavailable in the current Host`；不可声称一定是 flag-off，因为 capabilities 不带原因 |
| `agents===undefined`（old Host） | 可选 | disabled | `This Host predates agent capabilities; Claude Code is the compatibility fallback` |
| `agents=[]` 或 Host ready 但全被过滤 | disabled | disabled | 保留两项并显示 inline 空态 `No chat agent is available` + Restart/Retry Host 动作；不静默回退发送 |
| Host 非 ready | 当前选择只读占位 | 其余 disabled | 等 Host ready，不提前宣称可用 |
| 已锁定 | 当前项只读选中 | 其余 disabled | tooltip `Agent is fixed after the first send`；不显示可点击假控件 |

`hostStatus.ts` 已统一过滤未知 slug，并区分 `undefined` 与空数组（`src/renderer/components/chat/hostStatus.ts:42-52`）；picker 不再二次解析未知字符串。

### 3.3 选择值、默认值与锁定点

现有 `ChatSession.agent?` 已明确允许未发送 live-only session 保持 `undefined`，所有读取统一经过 `sessionAgent()`（`src/renderer/stores/chatSessions.ts:82-114`）。因此最小改造为：

1. 给 store 增加窄 action，例如 `setDraftSessionAgent(sessionId, agent)`；只更新目标 session 的 `agent` 与 `updatedAt`。
2. action 必须拒绝已物化会话。不要让组件直接 `setState`，否则锁定不变量没有单点断言。
3. 新会话默认选择：优先 app settings 的 `lastChatAgent`，但必须与当前 capabilities 求交；不可用则 Claude；old Host 恒 Claude。只在创建草稿 session 时写入非 legacy/default 的显式选择，未设置时继续依赖 `sessionAgent(undefined) → claude-code`。
4. 用户主动切换时同时更新该草稿 `session.agent` 与 `lastChatAgent`；不得写 session-index。

锁定判据统一下沉 `isChatAgentBindingLocked()`：

```text
locked = sendAttempted || hostBound || runtimeIdentity != null || session came from index
```

其中本次 app run 的立即锁定使用既有 sticky `sendAttempted`：`ChatComposer.runSend()` 在所有 guard 通过、首个 await 之前调用 `onSendStart()`（`ChatComposer.tsx:902-920`）；`ChatWorkspace` 已持有该 latch 并用它决定 session mode（`ChatWorkspace.tsx:68-72,160-163`）。这保证用户按下 Send 后不会在 create IPC 飞行期间再改 agent。

首个 create 继续从同一 pre-IPC store snapshot 读取 agent（`ChatComposer.tsx:872-880`），并在 `createSession` payload 明确发送（`ChatComposer.tsx:1253-1260`）。Host 的 `session.created/resumed` 回填仍是持久化确认，不是第二次选择。

### 3.4 S1 Happy Path

1. old Host：打开新草稿 → Claude selected，Codex disabled → 首发成功 → picker 同帧锁定。
2. 新 Host、flag-off/不可用：capabilities 只有 Claude → Codex 可见但禁点、有原因 → Claude 首发。
3. 新 Host、Codex 可用：用户零回合切到 Codex → 草稿 `session.agent='codex'` → 首发 create payload 为 codex → Host 回填 codex → 侧栏 chip 与 picker 一致。
4. 用户切到 Codex 后再切回 Claude → 未发送前允许 → session-index 仍无新行。
5. Send guard 拒绝（无 cwd、in-flight、disabled）→ 不调用 `onSendStart`，picker 不锁。
6. 首发 create 失败 → 因 send 已 commit，picker 保持锁定；Retry 沿用原 agent，不生成跨 runtime 重试。

### 3.5 S1 确定性断言点

- 纯函数矩阵覆盖 available / unavailable / old Host / empty / locked 五类。
- `setDraftSessionAgent` 仅允许未锁 session，且只改目标对象；锁定输入返回原 state 或明确失败结果。
- old Host `agents===undefined` 只启用 Claude；`agents=[]` 不等价于 old Host。
- 未知 agent 已由 `filterAgentWireNames` 丢弃，picker model 不接受 `string[]`。
- Send guard 未通过时 `onSendStart` 调用 0 次；通过时恰好 1 次且早于首个 IPC。
- create payload 的 agent 等于提交点 snapshot；发送过程中后续 store 变化不能改写该 payload。
- `agentWireStatic.test.ts` 继续钉死 `AgentWireName` 与 `BuiltinAgentId` 无互转、无 inline legacy default。
- 未发送切换不创建 index 行；首发后 index binding 与 Host 回声一致。

### 3.6 S1 变异验证候选

- 将 old Host `undefined` 误当空数组，测试应红。
- 将不可用项隐藏，结构断言应红。
- 删除 sendAttempted 锁，模拟 create IPC 未返回时切 agent，流程断言应红。
- 把默认值写成 `'claude'` 或从 `BuiltinAgentId` 转换，静态断言应红。
- 将 picker action 允许修改 indexed/runtimeIdentity session，锁定测试应红。
- 把 model/picker 顺序放错，Composer 结构静态断言应红。

## 4. S2 — 代理模型目录、per-agent 偏好与 Codex D40

### 4.1 目录通道裁定

新建 Main 侧 `AgentCatalogService`，不让 Renderer、preload 或 Agent Host event 携带凭据。

建议类型：

```ts
type AgentModelCatalog = {
  agent: AgentWireName;
  models: Array<{ id: string; label: string }>;
  fetchedAt: number;
  source: 'proxy' | 'stale-cache';
  stale: boolean;
  error?: 'host-not-ready' | 'credentials-unavailable' | 'http' | 'invalid-response';
};
```

建议接线：

- `src/main/services/agentCatalog/AgentCatalogService.ts`
- `src/main/ipc/agentCatalog.ts`
- `src/shared/types/ipc.ts` 增加 `CHAT_LIST_AGENT_MODELS`
- `src/preload/index.ts` 暴露 `chat.listAgentModels({agent, force?})`
- Renderer 新 `useAgentModelCatalog(agent)`；不得放进 `chatSessions.ts`

查询规则：

| agent | URL | Auth | 响应解析 |
|---|---|---|---|
| `claude-code` | 规范化 base URL + `/v1/models` | `x-api-key` | Anthropic list，读取非空字符串 id |
| `codex` | 规范化 base URL + `/v1/models` | `Authorization: Bearer` | OpenAI list，读取 `data[].id` |

base URL 与 key 只从 D47 托管凭据/已收编配置的 Main authority 取；日志只记 agent、host、状态码、条数、耗时，不记 header、完整响应体或 URL userinfo。请求使用短超时和 AbortSignal；只接受 JSON object/array 的预期结构，去重并过滤空 id。

为何不走 Codex app-server `model/list`：该方法在契约中存在，但调查 01 已实证它返回 Codex 本地静态目录，不代表 cch 供应商配置；本阶段要解决的正是“代理真实可用面”。为何不塞 `host.ready`：capabilities 明确只描述 Host build，且当前协议注释要求 old/new Host 通过可选能力降级（`src/shared/types/runtimeEvents.ts:85-115`）。

### 4.2 查询时机与缓存

- Composer 首次拿到 `hostStatus.state==='ready'` 且有 active session 时，查询当前 agent。
- 零回合切 agent 时立即查询新 agent；同 agent 并发请求去重。
- 用户打开模型菜单时，若 cache 超过 10 分钟则后台 refresh；菜单先显示 stale 值并标 `Refreshing…`。
- `force=true` 只由 Retry/Refresh 操作触发。
- cache 在 Main 内存，key 为 `agent + credentialGeneration/baseHost`；TTL 10 分钟，失败保留最近成功值到本进程结束。凭据登录/登出/收编或 baseHost 变化必须清空对应 cache。
- 阶段 3 不落磁盘目录快照，避免把旧供应商配置跨重启冒充当前真源；若以后需要离线目录，另立有年龄与来源提示的设计。

失败回退：

1. 有 fresh cache：正常目录。
2. refresh 失败但有旧值：返回 `stale-cache`，菜单显示非阻断 warning + Retry。
3. 无 cache 但该 session 有已存 model：显示一条 `Stored selection · unverified`，允许保持，不把它扩成可选目录。
4. 完全无目录：只显示 `Automatic (agent default)` 与 Retry；发送时省略 model。不得回退 `CHAT_MODELS` 或 Codex debug models 的静态白名单。

### 4.3 目录与偏好存储

新增与终端轴隔离的 app settings 字段：

```ts
type ChatAgentDefaults = {
  lastAgent?: AgentWireName;
  byAgent?: Partial<Record<AgentWireName, {
    model?: string;        // absent = Automatic
    effort?: EffortSelection;
    permission?: ChatAgentPermissionPreference;
  }>>;
};
```

它负责“新草稿切到该 agent 时恢复什么”。当前会话仍保留 per-session model/effort，以保证两个 Claude 会话可以选不同模型。现有 model storage 升级为可测试的纯 storage module，schema 至少记录 `{agent, model}`；effort 同理或合并为一个 per-session generation settings blob。

选择行为：

- 零回合切 agent：优先该 session 对该 agent 的未物化临时选择；其次 `ChatAgentDefaults.byAgent[agent]`；否则 Automatic + Default effort。
- 用户改 model/effort：写当前 session storage，同时更新该 agent 的默认偏好。
- 已锁定会话：agent 不变，但 model/effort 仍允许在 idle 时改，下一回合生效；busy/sending 继续沿用现 gate（`ChatComposer.tsx:2220-2231`）。
- 模型必须属于当前 agent 的 fresh/stale catalog，或是该 session 的 legacy/unverified 既有值；不能把 Claude id 带到 Codex。

### 4.4 Claude 短名兼容与全名迁移

现状静态短名见 `src/renderer/components/chat/models.ts:17-23`，实测 cch 不接受短名见 `04-cch-live-probe.md:15-27`。迁移采用“保留但不猜测”：

- 读取旧 `aiclient:chat:session-models` 时，如值为 `sonnet|haiku|opus` 且 agent 为 Claude，生成 session-scoped legacy selection：`{id:'sonnet', label:'Sonnet (legacy alias)', verified:false}`。
- 不把 alias 自动映射到 `claude-sonnet-5`、dated id 或列表首项；这些映射都没有服务端 default/alias 证据。
- 旧值继续经 Claude SDK/CLI 兼容链发送，避免升级后改变既有会话模型语义。
- 用户选择任何代理目录全名或 Automatic 后，覆写旧值；之后不再显示 legacy alias。
- 新 session 的 UI 只提供 Automatic 与代理返回的全长名，不再提供三短名静态选项。

### 4.5 `ComposerModelTrigger` 改造面

现组件同时自行读取静态目录、session storage 和 Host default（`ComposerModelTrigger.tsx:98-148`）。改造后组件只负责展示/选择，目录与选择解析下沉纯 model：

- props 增加 `agent`, `catalog`, `catalogState`, `selectedModel`, `selectedEffort`, `onModelChange`, `onEffortChange`, `onRetryCatalog`。
- `models.ts` 从静态真源改成目录 normalization、Automatic/legacy 合成和合法性判定；不得保留 `ensureModelOptions()` 的“未知 Host default 前插即合法”语义。
- 菜单仍维持 Model 与 Reasoning effort 两个 `MenuRadioGroup`；catalog loading/error/stale 是非 RadioGroup status row。
- 模型列表当前最多 15 条，不引入搜索/虚拟化；若真实目录超过可用高度，先使用现有 popup scrolling。长列表搜索另按量级立项。
- effort 统一五档 + Default。Codex 五档有 cch 实证；Claude 仍由现 SDK 行为负责 per-model 降级。若未来目录响应提供 per-model effort，再扩类型，不在本片猜测。

### 4.6 D40 Codex 半边裁定

现状 `CodexTurnStartParams` 只有 `threadId/input`，`send()` 收到 model/effort 后在 `buildTurnStartParams` 调用处丢失（`src/agent-host/codexRuntime.ts:232-265,2304-2311,2393-2399`）。本片改为：

```ts
type CodexTurnStartParams = {
  threadId: string;
  input: CodexTextInput[];
  model?: string;
  effort?: SessionEffortLevel;
};
```

发送规则：

1. `input.model` trim 后非空才发；必须来自 Renderer 当前 agent 的选择。
2. `input.effort` 经现有 `SessionEffortLevel` 五值守卫后才发。
3. 两者只在显式选择时出现；Automatic/Default 都省略。
4. `turn/start` 成功接受后，将显式 model/effort 写回 Host registry session default，使 idle sweep revive、后续 resume 与 Renderer 的“本回合后成为默认”一致；请求失败则不提交默认值。
5. `thread/start` 保留初始 model 与权限姿态，不删除。
6. 不把 approval/sandbox 顺手加入 `turn/start`；它们属于 S4 条件项。

理由：Codex schema 已说明 model/effort 是合法 sticky override；代理模型与五档 effort 已线上实证。继续丢弃会让同一 UI 在 Claude 生效、Codex 无效，构成确定性错误，而非安全降级。

### 4.7 S2 Happy Path

1. Claude 可用：查询 15 条全名 → 选择 `claude-sonnet-5` → create/send 下发全名 → 重开 app 后该 agent 默认恢复。
2. Codex 可用：查询 10 条 → 目录不出现 `gpt-5.2` → 选择 `gpt-5.6-sol + low` → `turn/start` 同时携带 model/effort。
3. agent 从 Claude 切 Codex：菜单目录和 per-agent 偏好整体切换，Claude model 不泄漏到 Codex。
4. refresh 失败但有 cache：仍能选旧值，UI 明示 stale；Retry 成功后原地刷新。
5. 首次查询失败：Automatic 可发送，wire 省略 model；没有伪造静态目录。
6. 存量 Claude `sonnet`：显示 legacy alias；不自动变成某个全长名；用户改选后完成单 session 迁移。
7. Codex 本回合改 model/effort，成功后下一次 send 即使 Renderer 省略也继承 Host/Codex sticky 默认。

### 4.8 S2 确定性断言点

- 双轴请求 URL、auth header 名称、响应 parser 分开钉；日志结构不含 secret/response body。
- cache key 含 agent 与凭据/baseHost generation；凭据变化清 cache；同 key 并发只发一次请求。
- 列表去重、空 id/错误 shape 拒绝；HTTP 非 2xx 不覆盖 last success。
- `/v1/models` 列表外项不会成为 verified option；Codex 目录不含 `gpt-5.2` fixture。
- Claude legacy alias 不自动映射；新 session options 不含 `sonnet/haiku/opus`。
- agent 切换后 model options 与 selection 都来自目标 agent；不存在跨 agent selection。
- Automatic/Default 分别使 model/effort key 从 create/send payload 省略。
- `buildTurnStartParams` 对 model trim、五档 effort、空值省略做表驱动测试。
- Codex `turn/start` 成功后 registry 默认更新；失败不更新。
- `ultra` 在 shared type、storage normalization、菜单和 Host wire 四层均被拒绝。

### 4.9 S2 变异验证候选

- 把静态 `CHAT_MODELS` 当失败 fallback，目录真源测试应红。
- Claude 请求误用 Bearer、Codex 请求误用 x-api-key，request contract 应红。
- cache 不按 agent 分 key，切轴测试应红。
- legacy `sonnet` 自动映射列表第一条，迁移测试应红。
- Codex `buildTurnStartParams` 再次丢 model/effort，D40 流程断言应红。
- 接受 `ultra` 或目录外 `gpt-5.2` 为 verified，边界测试应红。
- turn/start 失败仍写 registry 默认，事务断言应红。

## 5. S3 — 权限读侧与新会话默认权限管理

### 5.1 读侧先闭环

shared 已有判别联合：Claude 为 `permissionMode`，Codex 为 `approvalPolicy + sandboxMode + networkAccess`（`src/shared/types/runtimeEvents.ts:506-567`）。Host 已发 Codex policy，但 Renderer adjacent store 只折叠旧 `permissionMode`（`src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts:447-508`）。

最小补链：

- `SessionRuntimeFacts` 增加 `permissionPolicy?: SessionPermissionPolicy`；保留 `permissionMode?` 作为 old Host/Claude legacy fallback。
- 新纯守卫 `isSessionPermissionPolicy()`：严格按 `agent` 判别并验证各字段，不接受 widened string。
- reducer 对 `session.created/resumed` 同时读取 `permissionPolicy` 与 `permissionMode`：合法新 policy 优先；缺失/非法不覆盖旧真值；两个 session 隔离。
- `ContextRuntimeFacts` 增加 `permissionPolicy: SessionPermissionPolicy | null | undefined`；`ContextSurfaceView` 从 adjacent store 选择并传入。当前唯一 wiring 在 `ContextSurfaceView.tsx:106-108,156-205`。
- `buildRuntimeRows`：
  - Claude：`Permission policy = <mode label>`。
  - Codex：一行摘要 `On request · Workspace write · Network off`；不把三维压成 Claude 枚举。
  - old Host 只有 `permissionMode`：沿用现行行。
  - session 存在但两字段都没报：显示 `Permission policy not reported`，不猜 default。

### 5.2 写侧最小形态

设置入口放在 `AISettings` 下新增 **Chat agent defaults** 区，而不是 `AgentSettings.tsx`：后者管理的是终端/CLI `BuiltinAgentId`、custom/hapi/happy agent，复用会破坏三轴隔离（现有 provider/模型静态面可见 `AISettings.tsx:26-66`，本片同时不得误把其中 provider id 当 `AgentWireName`）。

设置区按 agent 两张小卡：

**Claude Code**

- Permission mode：`default / acceptEdits / dontAsk / bypassPermissions / plan`。
- 危险值 `bypassPermissions` 选择时显示现有设计语言的 warning 文案；不新增第六值 `auto`，因为 shared 冻结类型没有它且行为未实证。

**Codex**

- Approval policy：`untrusted / on-request / never`。
- Sandbox mode：`read-only / workspace-write / danger-full-access`。
- Network：只读 `Reported by runtime`，本片不提供开关。代码已明确 `networkAccess` 不是 config key，只记录服务端默认（`src/agent-host/codexHome.ts:154-163`）。
- `never` 或 `danger-full-access` 使用 warning 说明，但不阻止用户选择已建模的合法值。

该设置是 **新会话默认模板**，文案必须写明：`Applies to new chat sessions. Existing and active sessions keep the permission posture captured when they were first sent.` 不与消息流中的单次 PermissionQaCard 混淆。

### 5.3 持久化与创建/恢复通道

权限持久化分两层，不能只存全局默认：

1. `ChatAgentDefaults.byAgent[agent].permission` 由 app settings persistence 保存，作为新草稿的模板。
2. 首条发送 commit 时，把该草稿采用的 permission preference 与 agent 一起物化为 session snapshot；session-index 增加可选 `permissionPreference` 字段。以后 resume 使用该 session snapshot，不重新读取可能已经变化的全局默认。

这样 Settings 改动不会在应用重启后静默改变旧会话的安全姿态；同时 old index 没有字段时仍可回退对应 runtime 的安全默认。session-index 字段必须是可选加法，历史行无需迁移重写。

不得写：

- 终端轴 `AgentConfig`（其 key 是松散 terminal agent id）。
- `chatSessions.ts` 的 runtime facts（实际姿态由 adjacent runtime facts 承载；会话索引只保存“请求偏好”，不冒充实际回声）。
- 用户真实 `~/.codex/config.toml`（现 Host 使用隔离生成文件，并声明用户 posture 不继承，`src/agent-host/codexHome.ts:123-140`）。

shared create/resume payload 增加可选判别字段，例如：

```ts
permissionPreference?: SessionPermissionPreference
```

约束：payload 的 preference agent 必须等于 `sessionAgent(session)`；不匹配在 Main/Host dispatch 前拒绝，不能让 runtime 自己猜。首发 create 使用草稿 snapshot；resume 使用 session-index snapshot；只有两者都缺失时才用 runtime 安全默认。

运行时：

- Claude：将当前常量 `CHAT_PERMISSION_MODE` 改为默认 fallback；create/resume 接收 Claude policy，写入 Host session，`query()` options 使用 session 值，`session.created/resumed` 回声同一值。
- Codex：将 `CODEX_PERMISSION_DEFAULT` 改为 fallback；create/resume 接收 Codex policy，`state.policy` 与 `buildThreadStartParams` 使用它。隔离 `config.toml` 继续写 approval/sandbox，以保证 resume 重派生和回声校验一致。
- Host `SessionRegistry` 增加可选/判别的 policy 存储位，create/resume 合并规则与 model/effort 同类，但 agent 不可变。
- `networkAccess` 不由 Renderer 偏好提供；Host 继续记录/回声实际值。若 shared create policy 要复用 `SessionPermissionPolicy`，Codex 输入必须忽略/拒绝用户伪造 networkAccess，而不是把它假装已控制。更干净的实现是另设 `SessionPermissionPreference`（Codex 仅 approval/sandbox）与 runtime `SessionPermissionPolicy`（含 networkAccess），两者不要混用。

推荐采用最后一种双类型：**Preference 是请求，Policy 是事实回声**。这样类型层不会声称 UI 能控制 networkAccess。

### 5.4 S3 Happy Path

1. 打开旧 Claude 会话：只有 legacy `permissionMode` → Context 行继续正确显示。
2. 新 Claude 会话选择 `plan` 默认 → create/query 使用 plan → Host 回声 policy → Context 显 Plan。
3. 新 Codex 会话选择 `untrusted + read-only` → thread/start 与隔离 config 同值 → Context 显三维事实。
4. Codex resume：不依赖旧 event 猜值；从隔离 config 重派生并经现 H9 校验，随后 Renderer 得到可展示 policy（若 resume 当前不发，需在校验成功后补发）。
5. old Host 不发 `permissionPolicy`：Renderer 保留 legacy 行，不崩溃、不显示 Codex 假值。
6. 用户修改 Settings 中默认权限：当前 active session与所有已物化 session 不变；只有之后首次发送的新草稿采用新值。
7. 单次 PermissionQaCard Allow/Deny 不改默认权限，也不改 Context policy。

### 5.5 S3 确定性断言点

- `isSessionPermissionPolicy` 覆盖两判别分支、未知 enum、缺字段、额外 agent slug。
- reducer 优先合法 policy；缺失/非法不覆盖旧值；session A 不影响 B。
- Context Claude/Codex/legacy/not-reported 四种输出分别钉死。
- preference 与 runtime policy 类型不相等：Codex preference 结构中不存在 networkAccess。
- 首发将 permission preference 恰好物化一次；session-index 已有值时 resume 不读取后来修改的全局默认。
- create/resume 的 preference agent 必须匹配 session agent；错配在 dispatch 前失败。
- Claude query option、session 回声和 registry 值来自同一 session preference。
- Codex thread/start、isolated config、state.policy、Context 回声四处 approval/sandbox 同值。
- Settings 更新不调用任何 active-session mutation IPC。
- PermissionQaCard response 不写 chat defaults。
- old Host payload 不含新字段时仍走现 compatibility path。

### 5.6 S3 变异验证候选

- Renderer 忽略 Codex policy，Context 行消失，projection 测试应红。
- 把 Codex 三维压成 Claude `permissionMode`，类型/label 测试应红。
- Settings 修改立即篡改 active Context，事实/偏好隔离测试应红。
- 把 networkAccess 暴露为可写开关，结构断言应红。
- 将 chat permission 存进 terminal `agentSettings`，轴隔离静态断言应红。
- Codex config 与 thread/start 使用不同 policy，H9 一致性测试应红。
- bypassPermissions 无 warning 或被无条件默认，设置模型测试应红。

## 6. S4 — 中途权限改档（条件执行）

S4 不得作为 S1～S3 的暗含前提。先落探针提交，只包含 fixture/测试工具与报告；结论成立后另提实现提交。

### 6.1 条件 A：Claude SDK

**探针必须回答：**

- 纯文本字符串 prompt 下 `Query.setPermissionMode()` 是抛错、无效还是可用。
- 将 prompt 固定改为 streaming-input 后，首回合/空闲期调用是否生效。
- active turn 调用的时序与失败模式。
- `auto` 是否真实可用、是否需要额外 flag；未闭合前仍不进 shared union。

**成立条件：** 有真实 SDK 回声或行为 fixture，能证明 idle session 修改后下一次工具权限按新档执行，且错误可确定性归类。

**成立后的最小实现：** Composer model menu 旁增加 Claude permission selector；只在 idle 时启用；调用专用 `chat:setPermissionPreference`/runtime command；成功事件更新事实 store，失败不改 Context。若必须把所有 prompt 改成 streaming-input，这属于额外架构成本，需单独用户拍板，不能在 S4 自动扩权。

### 6.2 条件 B：Codex app-server

**探针必须回答：**

- `thread/settings/update` 完整 request schema、response、notification fixture。
- 能否更新 approvalPolicy、sandboxMode；是否支持 network。
- 对下一 turn/当前 pending approval 的作用边界。
- 与 `turn/start` sticky 字段冲突时谁优先。
- 当前 method-contract 欠采是否需要升级 Codex CLI/fixture。

**成立条件：** binary-generated schema + 至少一个真实 thread 的 before/after 回声，且 resume 后姿态规则可解释。

**成立后的最小实现：** 扩 `CODEX_METHOD` 前先提交 contract fixture；仅开放 schema 明示、实测成功的字段；idle-only；成功 notification 后更新 `state.policy` 与 runtime facts。若只有 `turn/start` sticky 可用而 `thread/settings/update` 不成立，应回到用户拍板：是否接受“下一回合及后续回合”的 selector，不能自行把它包装成即时设置。

### 6.3 S4 Happy Path 与断言

- 探针不支持：产品 UI 无 active-session selector；Settings 新会话默认仍可用；报告明确 NOT-SUPPORTED。
- 探针支持：idle 改档 → protocol success → 下一回合采用新档 → Host 事实事件 → Context 更新；任一步失败均保持旧事实。
- active turn：控件 disabled 或明确排队策略；本规格推荐 disabled，不引入权限 mutation queue。
- 变异候选：先乐观改 Context、忽略 protocol error、把 Settings default 当 active fact、无 fixture 就扩 `CODEX_METHOD`。

## 7. 切片依赖、提交边界与回归收口

| 切片 | 依赖 | 必须完成 | 明确不夹带 | 收口证据 |
|---|---|---|---|---|
| S1 picker | 无 | picker、draft agent action、锁定 helper、old Host/空态 | 目录 HTTP、权限写入、terminal picker | Happy Path 测试 + 四门 + GUI 两轴首发 |
| S2 catalog/D40 | S1 agent selection | Main catalog IPC、cache、storage migration、Composer model 改造、Codex turn override | 权限 mutation、搜索/虚拟化、disk catalog | 双轴 fixture + D40 payload + 四门 + cch 点验 |
| S3 permission | S1；可与 S2 代码上少交叉但施工串行 | Codex read projection、Settings defaults、create/resume preference | active mutation、network 写开关、terminal settings | policy matrix + H9 + 四门 + 两轴 Context 点验 |
| S4 conditional | S3 + 对应探针 PASS | 仅实证支持轴的 idle mutation | 猜 schema、streaming 架构扩张 | committed fixture + probe report + 四门 + GUI |

每片施工纪律：

1. 先提交/落下会红的纯函数、协议结构或 fixture 断言。
2. 实现只补到本片 Happy Path 通过，不顺手跨片。
3. 四门必须逐门运行，不能链式并发；任何门未启动不得写“通过”。
4. GUI 点验只补自动化覆盖不了的 focus/tooltip/菜单切换/cch 实链。
5. 收口时更新 D48 台账、plantree 状态与证据链接；这是规范第 15 条的一部分，但应由实际施工票执行，不由本设计草案预改其他文件。

## 8. 风险表

| 风险 | 等级 | 触发条件 | 影响 | 缓解/断言 |
|---|---|---|---|---|
| capabilities 只能给可用列表，不能区分 flag-off/缺凭据/probe 失败 | major | Codex 不在列表 | UI 原因可能过度承诺 | 使用 generic `Unavailable in current Host`；old Host 单独可判 |
| 首发 IPC 飞行期仍可切 agent | blocker | 只以 runtimeIdentity/index 判锁 | create 与 UI 选择分裂 | `sendAttempted` 同步锁 + snapshot payload 断言 |
| 目录查询泄露 key/响应体 | blocker | Renderer fetch 或日志打印 header/body | 凭据泄露 | Main-only service、脱敏结构、日志 secret scan |
| `/v1/models` 无默认模型语义 | major | 新 session 无偏好 | 猜列表首项导致行为漂移 | Automatic sentinel，省略 model |
| legacy Claude alias 自动映射错误 | major | 把 sonnet 映射某个全名 | 升级后静默换模型 | legacy synthetic option，不自动映射 |
| stale cache 被误标 fresh | major | refresh 失败仍覆盖时间 | 用户选择已下线模型 | source/stale/fetchedAt 明示，失败不更新时间 |
| Codex turn override 与 registry 默认不同步 | major | wire 生效但 resume 仍旧值 | 下一回合/恢复漂移 | 成功后事务式提交 registry，失败不提交 |
| per-agent 与 per-session 偏好互相覆盖 | major | 单一 map 没有两层语义 | 切 agent 或切 session 串值 | 明确优先级、key 含 agent、切轴测试 |
| 权限 preference 被当作 runtime fact | blocker | Settings 乐观写 Context | UI 谎报实际姿态 | Preference/Policy 双类型；Context 只读 Host 回声 |
| 全局权限默认在 resume 时覆盖旧会话 | blocker | session 未保存权限 snapshot | 重启后安全姿态静默变化 | 首发物化进 session-index；resume 优先 session snapshot |
| Codex networkAccess 被假装可控 | blocker | UI 写布尔但 wire/config 不接 | 安全边界错误 | S3 只读；结构断言 preference 无 networkAccess |
| resume 不发 Codex policy | major | Context 打开恢复会话 | 权限行再次消失 | H9 验证后补事实事件；resume regression |
| S4 先实现后探针 | blocker | 猜 `thread/settings/update`/SDK 行为 | 错协议或静默无效 | fixture/probe 是硬 gate，条件项独立提交 |
| Settings `AgentSettings` 复用造成轴混淆 | major | 把 chat slug 塞 terminal id map | 违反三轴隔离 | 独立 `ChatAgentDefaults` + 静态扫描 |

## 9. 需要用户拍板的未决项

以下不是本文可凭工程事实自行扩权的决定。推荐案已给出，施工前应在 D48 票据中逐项拍板。

| # | 未决项 | 方案 | 推荐 | 理由 |
|---|---|---|---|---|
| U1 | 新 session 没有模型偏好且 `/v1/models` 不提供 default 时显示什么 | A 列表首项；B 继续 legacy short name；C `Automatic` 省略 model | **C** | 不猜服务端顺序，不重新依赖 cch 不接受的短名；两 runtime 都支持省略初始 model |
| U2 | 目录缓存是否跨 app 重启落盘 | A Main 内存 only；B appData 磁盘 snapshot | **A（阶段 3）** | 供应商配置会漂移；无来源/年龄 UI 前不应把昨日目录冒充当前真源 |
| U3 | 存量 Claude short alias 是否自动迁移 | A 按 family 选最高版本；B 选列表首项；C 保留 legacy 直到用户改选 | **C** | 目录没有 alias→具体 id 的证据，自动映射会静默换模型 |
| U4 | 权限设置入口 | A Composer 实时 selector；B Settings 新会话默认；C 两者同时 | **B 先行** | 两轴中途协议未实证；B 已构成真实写侧且不谎称即时生效 |
| U5 | Codex networkAccess 是否进入写侧 | A 现在加开关；B 只读，等 schema/配置实证 | **B** | 当前代码明示它只是服务端回声，不是 request/config key |
| U6 | Claude 为支持 `setPermissionMode` 是否允许统一改 streaming-input | A 若探针要求则改；B 本阶段不改，另立任务 | **B** | 这是 query 输入架构改造，超出一个权限控件的局部实现，需成本/回归单独评估 |
| U7 | 若 Codex 只有 `turn/start` sticky 可改权限，是否把它作为“下一回合权限”开放 | A 开放；B 等 `thread/settings/update` | **B 默认** | sticky 对当前及后续回合的语义强，且与 config/resume 关系未闭合；若要 A 需用户明确接受该语义 |

## 10. 最终验收清单

### 10.1 功能验收

- [ ] 新会话在 Composer 可见 Claude/Codex 两段 picker；终端轴 UI/类型零改动。
- [ ] old Host、Codex unavailable、无 agent、Host not ready、locked 五态均有确定表达。
- [ ] 首发 commit 同步锁 agent；create/resume/index/侧栏展示同一绑定。
- [ ] 双轴模型目录来自 cch `/v1/models`；Renderer 无 key；静态表不再作为 verified fallback。
- [ ] Claude 新选择为全长名；存量短名按 legacy 兼容，不自动映射。
- [ ] model/effort 随 agent 切换偏好，且 session 之间不串值。
- [ ] Codex `turn/start` 实际收到 model/effort，五档生效，`ultra` 不可进入 wire。
- [ ] Codex `permissionPolicy` 在 Context 可见；Claude legacy 展示不回归。
- [ ] Settings 可保存两轴新会话默认权限；active Context 只显示 Host 实际回声。
- [ ] networkAccess 无假写控件；单次审批与会话默认权限互不污染。
- [ ] S4 未有探针 PASS 时，产品中不存在中途权限 selector。

### 10.2 工程验收

- [ ] `AgentWireName` / `BuiltinAgentId` 静态隔离断言保持绿色。
- [ ] `chatSessions.ts` 只有 draft agent action 等必要加法；目录/权限 facts 使用 adjacent store/service。
- [ ] IPC/shared 字段均为兼容性可选加法；old Host/old snapshot 有回归。
- [ ] secret scan 证明 catalog 日志与 Renderer payload 不含 key/token/full auth URL。
- [ ] 每片 Happy Path、确定性过程断言、变异候选均落测试或明确 GUI 证据。
- [ ] 每片分别逐门通过 `typecheck → typecheck:agent-host → lint → test`。
- [ ] 实际施工完成后按规范第 15 条更新 D48 台账、plantree 与证据链接。

---

本草案的最小安全交付线是 **S1 + S2 + S3**。它已经完成 D48 三块范围：用户能在零回合选 agent；模型/effort 由代理真实目录驱动且 Codex 下一回合生效；权限既能如实展示，也能管理新会话默认值。S4 只在协议实证成立后增加实时改档，不得反向阻塞前三片，也不得把未成立能力写进 UI。
