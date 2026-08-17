# D48 调查 06 — 开工前三探针批（P1 sticky / P2 Claude 中途改档 / P3 settings/update）

> 2026-08-16，阶段 3（D48）调查轮第 6 篇。**动工前置探针**，结论直接约束 S2/S4 施工形状。
> 免费半边 = codex 自带 schema 生成 + 仓内代码/类型核对；live 半边 = /tmp 下一次性脚本驱 `codex app-server` stdio JSON-RPC。
> **live 实际消耗 3 个最小回合**（prompt 均为 `hi`，预算 ≤8）。探针脚本写在 `/tmp/d48-probe/`，不入仓；`~/.claude` / `~/.codex` / dev.env 全程零写入（codex 自读凭据属正常使用）。
> 采集环境：`codex-cli 0.145.0`（与仓内夹具同版），`codexHome=/home/dan/.codex`，`modelProvider=<公司网关>`（脱敏）。

---

## 0. 免费半边：schema 采集与夹具比对

采集命令（夹具头注同款）：

```
codex app-server generate-json-schema --experimental --out <dir>   # 126 clientRequest
codex app-server generate-json-schema             --out <dir>   #  89 clientRequest（非 experimental 过滤后）
```

### 0.1 clientRequest 总数：夹具欠采 5 条，无一条消失

`src/agent-host/__tests__/fixtures/codex/codex-method-contract.json` 记 **121** 条，同版二进制实际 **126** 条。差集是**纯欠采**（夹具头注已自认 "clientRequest 126 vs 121"，本批坐实具体名单），方向单一：

| 差异 | 方法名 |
|---|---|
| 夹具缺、二进制有（+5） | `initialize`、`fuzzyFileSearch`、`thread/inject_items`、`thread/increment_elicitation`、`thread/decrement_elicitation` |
| 夹具有、二进制无 | **无**（0 条） |

其余家族同批复核：`serverRequest` 11（夹具已于 0810 修正为 11，一致）、`serverNotification` 70（夹具头注自认欠采，本批实测 70）、`clientNotification` 1。
→ **对施工无阻**：D48 要用的 `thread/settings/update` / `turn/start` / `thread/start` / `model/list` 四个方法夹具里都在，拼写无漂移。夹具补采可挂在 S2 的顺手活里，不构成前置。

### 0.2 P3 的形状：`ThreadSettingsUpdateParams` 完整字段表

`ClientRequest.json#/definitions/ThreadSettingsUpdateParams`，唯一必填 `threadId`，其余全部 `nullable` 可选（**省略=不变，显式 `null`=清除**，见 `serviceTier` 字段自述）：

| 字段 | 类型 | schema 原文（节选） |
|---|---|---|
| `threadId` | string | **required** |
| `model` | string\|null | "Override the model for subsequent turns." |
| `effort` | ReasoningEffort\|null | "Override the reasoning effort for subsequent turns." |
| `approvalPolicy` | AskForApproval\|null | "Override the approval policy for subsequent turns." |
| `sandboxPolicy` | SandboxPolicy\|null | "Override the sandbox policy for subsequent turns." |
| `permissions` | string\|null | 命名 profile id，"**Cannot be combined with `sandboxPolicy`**" |
| `approvalsReviewer` | ApprovalsReviewer\|null | `user` / `auto_review` / `guardian_subagent`(legacy) |
| `cwd` | string\|null | 后续回合工作目录 |
| `personality` / `summary` / `serviceTier` / `collaborationMode` | 各自枚举\|null | `collaborationMode` 标 EXPERIMENTAL |
| `multiAgentMode` | — | **@deprecated Ignored**，改用 `effort: "ultra"` |

枚举取值（S4 直接用）：

- `AskForApproval` = `"untrusted" | "on-request" | "never"` **或**对象 `{granular:{mcp_elicitations,rules,sandbox_approval, request_permissions?, skill_approval?}}`。
- `SandboxPolicy` = 判别联合 `{type:"readOnly"|"workspaceWrite"|"dangerFullAccess"|"externalSandbox", …}`（camelCase）。
  ⚠️ **与 `thread/start` 不同名不同形**：`thread/start` 用 `sandbox`（`SandboxMode` 字符串枚举 `read-only|workspace-write|danger-full-access`，kebab-case），`turn/start` 与 `thread/settings/update` 用 `sandboxPolicy`（对象）。三处不可互抄。

### 0.3 P1/S4 的形状：`turn/start` 的 sticky 字段清单

`TurnStartParams` 必填 `threadId` + `input`；下列覆盖字段的 schema description **逐条写着 "for this turn AND subsequent turns"**：

`model`、`effort`、`approvalPolicy`、`sandboxPolicy`、`approvalsReviewer`、`cwd`、`permissions`、`personality`、`serviceTier`、`summary`、`environments`、`runtimeWorkspaceRoots`。
（`collaborationMode` 只写 "Takes precedence over model / reasoning_effort / developer instructions"，未写 subsequent；`outputSchema`、`additionalContext`、`clientUserMessageId`、`responsesapiClientMetadata` 为纯本回合字段。）

→ 即 **schema 层面 codex 没有"仅本回合"的覆盖语义**；任何 `turn/start` 覆盖都是改线程默认。仓内 `codexRuntime.ts:244-257` 的头注已经写对了这一点（"the schema says each override applies for this turn AND SUBSEQUENT TURNS"），本批把它从"读码推断"升级为**实测**。

### 0.4 model 回声只有两条通道

| 通道 | 载荷 | 触发时机 |
|---|---|---|
| `thread/start` 响应（`ThreadStartResponse`） | `model` / `approvalPolicy` / `sandbox` / `reasoningEffort` / `modelProvider` / `activePermissionProfile` | 仅起线程一次 |
| `thread/settings/updated` 通知（`ThreadSettings`） | **全量** `model, modelProvider, effort, approvalPolicy, sandboxPolicy, approvalsReviewer, cwd, serviceTier, summary, personality, collaborationMode, activePermissionProfile` | 线程设置**每次变化** |

反例（避免施工时找错地方）：
- `turn/start` 响应 = `{turn:{id,items,itemsView,status,error,startedAt,…}}`，**无 model**。
- `turn/started` / `turn/completed` 通知载荷 = 同一个 `Turn` 对象，**无 model**。
- `thread/read` 响应的 `Thread` 对象属性表里**没有 model / settings**（只有 `modelProvider`）。
- `thread/settings/update` 响应 = `{}`（schema 就是空 object，实测返回 `null`/`{}`）。
→ **UI 的"当前模型/当前权限档"唯一权威回声 = `thread/settings/updated` 通知**。

---

## P1 — `turn/start` 的 model 覆盖是 **sticky（覆盖即新默认）**

**结论一句话：`turn/start` 带 `model` 不是"本回合临时换模型"，它把 thread 的常驻设置改掉了——下一回合不带 model 也继续跑被覆盖的那个模型；`sandboxPolicy` 同样 sticky。**

### 报文（脱敏摘录，`/tmp/d48-probe/out/wire.jsonl`）

起线程钉 A 档：

```json
-> {"id":3,"method":"thread/start","params":{"cwd":"/tmp/d48-probe/ws","model":"gpt-5.6-sol",
    "approvalPolicy":"on-request","sandbox":"workspace-write"}}
<- {"id":3,"result":{"model":"gpt-5.6-sol","approvalPolicy":"on-request",
    "sandbox":{"type":"workspaceWrite","networkAccess":true,…},"reasoningEffort":"medium",
    "modelProvider":"<公司网关>","thread":{"id":"01a00d95-8f63-…"}}}
```

第 1 发（live 回合 1/3）带 model 覆盖 + 顺带试 `sandboxPolicy` 覆盖：

```json
-> {"id":4,"method":"turn/start","params":{"threadId":"01a00d95-8f63-…","model":"gpt-5.5",
    "sandboxPolicy":{"type":"readOnly","networkAccess":false},"input":[{"type":"text","text":"hi"}]}}
<- {"id":4,"result":{"turn":{"id":"01a00d95-8f94-…","status":"inProgress"}}}      // 无 model 回声
<- {"method":"thread/settings/updated","params":{"threadSettings":{
     "model":"gpt-5.5","effort":"medium","approvalPolicy":"on-request",
     "sandboxPolicy":{"type":"readOnly","networkAccess":false},…}}}               // ← 覆盖写进了线程设置
```

第 2 发（live 回合 2/3）**不带任何覆盖**：

```json
-> {"id":5,"method":"turn/start","params":{"threadId":"01a00d95-8f63-…","input":[{"type":"text","text":"hi"}]}}
```

### 决定性证据：rollout 的逐回合 `turn_context`

app-server 的通知流不逐回合播 model，所以取证走 codex 自己的 rollout（**只读**，`~/.codex/sessions/2026/08/16/rollout-…-01a00d95-8f63-….jsonl`）：

```
  7 turn_context {'model': 'gpt-5.5', 'effort': 'medium', 'approval_policy': 'on-request',
                  'sandbox_policy': {'type': 'read-only'}}      ← 第 1 发（显式带了 gpt-5.5）
  8 message user 'hi'
 16 event   task_started                                        ← 第 2 发开始
 18 turn_context {'model': 'gpt-5.5', 'effort': 'medium', 'approval_policy': 'on-request',
                  'sandbox_policy': {'type': 'read-only'}}      ← 第 2 发（什么都没带，仍是 gpt-5.5 + read-only）
 19 message user 'hi'
```

第 2 发既没有回到 `thread/start` 钉的 `gpt-5.6-sol`，也没有回到 `workspace-write`。**sticky 成立**，`model` 与 `sandboxPolicy` 双双成立。

### 顺带零成本观察（原任务第 5 条）

- `turn/start` 覆盖 `sandboxPolicy` **不被 schema 拒绝**，正常执行且 sticky（上文实测）。`approvalPolicy` 同族同措辞，schema 层同样接受（本批未单独 live 打，因 P3 已用同一策略枚举打通）。
- 严格性（`thread/settings/update` 上零成本试，见 `/tmp/d48-probe/out2/`）：
  - 坏枚举 → **拒**：`{"code":-32600,"message":"Invalid request: unknown variant \`bogus-policy\`, expected one of \`untrusted\`, \`on-request\`, \`granular\`, \`never\`"}`
  - 缺必填 → **拒**：`{"code":-32600,"message":"Invalid request: missing field \`threadId\`"}`
  - **未知字段 → 静默接受**（返回 `{}`，无通知、无副作用）。⚠️ 施工含义：拼错字段名不会报错，只会**悄无声息地不生效**；S2/S4 的参数构造必须由类型/单测兜住，不能指望服务端报错。

### 对 S2/S4 的直接指示

1. **模型回写语义 = 线程级，不是回合级。** UI 上"这条消息用 X 模型发"这种 per-message 语义在 Codex 轴**不存在**；选了 X 就是整条线程改成 X，直到下次再改。S2 的模型选择器在 Codex 轴必须按"线程当前模型"呈现（与 Claude 轴的 per-turn 语义不同轴，见 P2），不要复制 Claude 轴的 per-turn 心智。
2. **回写来源只认 `thread/settings/updated`。** 不要用"我发了什么就显示什么"的乐观更新做终态（发出去的值可能被 `allowProviderModelFallback` 之类改写）；以通知里的 `threadSettings.model` 为准，`thread/start` 响应只用于建线程时的初值。
3. **两条改档通道等价、择一即可**：`turn/start.model`（改档 + 发消息一次往返，回合边界生效）与 `thread/settings/update`（**零回合**，空闲时也能改，见 P3）。推荐：**用户在 composer 里改档 → `thread/settings/update` 立即下发**（拿到通知即刷 UI，不用等用户发消息）；改档并同时发消息 → 允许合并进 `turn/start` 省一次往返。
4. **现状缺口**：`codexRuntime.ts:258 buildTurnStartParams()` 目前只产 `{threadId, input}`，`send()`（`codexRuntime.ts:2304-2313`）虽然收 `model?`/`effort?` 但**原样丢弃**（:2393 处只传 `{threadId, text}`）。S2 要么给 `buildTurnStartParams` 加 model 参数，要么走新的 settings/update 通道；:244-257 那段"故意不发"的头注需要随之改写（它的理由"会悄悄超出本回合"依然成立，只是 D48 之后这正是我们想要的语义）。

---

## P2 — Claude 轴中途改权限档 = **per-turn options 下发**，无需 `setPermissionMode`、无 streaming-input 前提

**结论一句话：Claude 轴每发一条消息都新开一个 `query()`，`permissionMode` 是 `query()` 的 options 字段，所以中途改档与 D40 的 model 完全同形状——下一发 send 带上新档即可；`setPermissionMode` 那条"仅 streaming input 可用"的路根本不需要走。**

### 证据（file:line，全部实测）

**(a) 每次 send 都新开一个 query**

- `src/agent-host/claudeRuntime.ts:453` — `async send(input: {...}): Promise<void>` 入口。
- `src/agent-host/claudeRuntime.ts:513` — `const queryFn = await this.ensureSdk();`（`ensureSdk` :299-311 只缓存**函数引用**，不缓存会话/流）。
- `src/agent-host/claudeRuntime.ts:735` — `stream = queryFn({ prompt, options: { … } })`，**在 send() 函数体内**，每次调用新建。
- `src/agent-host/claudeRuntime.ts:952-967`（finally）— `stream?.close?.()`，本回合流用完即关；跨回合的连续性靠 `options.resume: session.runtimeIdentity`（:784）重挂，不是靠复用同一个 query 对象。
- `prompt` 传的是**字符串**（不是 `AsyncIterable<SDKUserMessage>`），即当前根本不在 streaming-input 模式。

**(b) `permissionMode` 是 query 级选项**

- `src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2568` — `export declare function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;`
- 同文件 `:1303` — `export declare type Options = {`；`:1720` — `permissionMode?: PermissionMode;`（落在 Options 体内，下一个顶层类型声明在 :2641）。取值注释：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'`；`bypassPermissions` 另需 `allowDangerouslySkipPermissions: true`（:1729）。
- 对照组：`:2260 export declare interface Query`，`:2281 setPermissionMode(mode: PermissionMode): Promise<void>` 注释明写 **"Only available in streaming input mode."** — 这条路我们不需要。
- SDK 版本：`@anthropic-ai/claude-agent-sdk 0.3.218`。

**(c) 与 D40 model 完全同形状**

- `claudeRuntime.ts:520-522` — `const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : session.model; if (model) session.model = model;`（per-turn 覆盖 + **回钉到 registry**，头注 :465-472 自述"a LATER send that omits it keeps this explicit choice"）。
- `claudeRuntime.ts:780` — `...(model ? { model } : {}),` 与 `:754` `permissionMode: CHAT_PERMISSION_MODE,` **在同一个 options 字面量里，相隔 26 行**。model 能做的，permissionMode 逐字能做。

### 对 S4 的直接指示

1. **实时权限控件走"下一发 send 的 options"这条通道**，不引入 `setPermissionMode`、不改 streaming-input、不动 `canUseTool` 桥。改造量 = 把常量换成会话态。
2. **动的是 `claudeRuntime.ts:215` 的 `CHAT_PERMISSION_MODE` 常量**（`const CHAT_PERMISSION_MODE: SessionPermissionMode = 'default'`）。它的头注（:204-214）明写 "Change this constant, not either call site"，因为它同时喂**三处**：`:754` query options、`:341` `session.created`、`:391` `session.resumed`。S4 把它升成 `session.permissionMode`（默认值仍取该常量）时，**三处必须一起改**，否则 Context 面板报的档位会和真正下发给 SDK 的档位漂移——这正是那段头注在防的事故。
3. **生效时机 = 下一个回合边界**，与 Codex 轴（P1/P3 都是 "subsequent turns"）**天然一致**。UI 文案统一按"下一条消息起生效"写，不要给 Claude 轴承诺"立即生效"。回合进行中的实时管控仍由既有 `canUseTool` 权限卡承担（:563-574），两者不冲突、不重叠。
4. **`bypassPermissions` 档若要进 UI，必须同时下发 `allowDangerouslySkipPermissions: true`**（sdk.d.ts:1729），否则 SDK 直接拒。建议 D48 首版权限档位收敛到 `default` / `acceptEdits` / `plan` / `dontAsk`，把 bypass 留到有二次确认设计时再开。

---

## P3 — `thread/settings/update` **存在、可用、零回合成本**，且真作用于后续回合

**结论一句话：方法真实存在（不是 method not found），响应体是空的但会立刻广播一条全量 `thread/settings/updated`；实测在**没有任何 turn 的情况下**改掉 model+effort+approvalPolicy，随后那一回合的 `turn_context` 三项全部按新值执行——这就是 S4 实时权限控件该走的通道。**

### 报文（脱敏摘录）

```json
-> {"id":6,"method":"thread/settings/update","params":{"threadId":"01a00d97-78c5-…",
    "approvalPolicy":"never","model":"gpt-5.5","effort":"low"}}
<- {"id":6,"result":null}                                        // 空响应，不带任何回声
<- {"method":"thread/settings/updated","params":{"threadSettings":{
     "cwd":"/tmp/d48-probe/ws2","approvalPolicy":"never","approvalsReviewer":"user",
     "sandboxPolicy":{"type":"workspaceWrite","networkAccess":true,…},
     "activePermissionProfile":null,"model":"gpt-5.5","modelProvider":"<公司网关>",
     "serviceTier":"priority","effort":"low","summary":"detailed",
     "collaborationMode":{"mode":"default","settings":{"model":"gpt-5.5","reasoning_effort":"low",…}},
     "multiAgentMode":"explicitRequestOnly","personality":"pragmatic"}}}
```

注意：只发了 3 个字段，通知回的是**全量 13 项设置**（未提及项保持原值：`sandboxPolicy` 仍是 `thread/start` 钉的 workspaceWrite）。**省略即不变**已实测。

### 决定性证据：更新后那一回合真的按新档跑

线程 `01a00d97-78c5-…`：`thread/start(model=gpt-5.6-sol, approvalPolicy=on-request, sandbox=workspace-write)` → `thread/settings/update(model=gpt-5.5, approvalPolicy=never, effort=low)` → **唯一一发 `turn/start` 不带任何覆盖**（live 回合 3/3）。rollout：

```
  7 turn_context {'model': 'gpt-5.5', 'effort': 'low', 'approval_policy': 'never',
                  'sandbox_policy': {'type': 'workspace-write', 'network_access': True, …}}
  8 message user 'hi'
 13 event   task_complete
```

三项改的全中，没改的 `sandbox_policy` 原样保留。回合期间 `thread/settings/updated` 触发次数 = 0（不带覆盖的 turn 不产生设置变更事件）。

### 对 S4 的直接指示

1. **实时权限控件（Codex 轴）走 `thread/settings/update`**，不要为了改档去凑一个 `turn/start`。它**不消耗模型回合**、线程空闲时可调、失败会以 JSON-RPC error 明确报回（坏枚举/缺 threadId 实测均 -32600）。
2. **UI 状态刷新只订阅 `thread/settings/updated`**：一条通知带全量 13 项，Host 侧一次映射即可同时刷新模型标签与权限档标签，无需为两个控件各写一条回声路径。
3. **`permissions` 与 `sandboxPolicy` 互斥**（schema 自述 "Cannot be combined with `sandboxPolicy`"）。D48 若引入命名权限 profile，需在参数构造处做二选一守卫——服务端对未知/冲突字段是**静默吞**的（见 P1 严格性观察），不会替我们报错。
4. **`thread/start` 的 `sandbox`（字符串枚举 kebab-case）≠ `settings/update` 的 `sandboxPolicy`（对象 camelCase）**。仓内现有 `CODEX_PERMISSION_DEFAULT`（`codexRuntime.ts:134`，`on-request` + `workspace-write` 组合，见 :109 头注）是 `thread/start` 形状，**不能直接喂给 settings/update**，需要一层映射并配静态断言。
5. **不要在 `turn/start` 刚发出后立刻打 settings/update**：本批第一次跑就撞上了这个竞态（两者相隔 1ms，第 2 发回合的 `turn_context` 已定型，更新落在了它后面），实测表现为"改了但这一回合没生效"。S4 的下发时机应约束在**空闲态**，或明确接受"下一回合起生效"。

---

## 附：预算与产物

| 项 | 值 |
|---|---|
| live 回合消耗 | **3**（预算 ≤8）：P1 两发 `hi`（含 sticky 对照）、P3 一发 `hi`（验证 update 真生效） |
| 零成本取得的结论 | P3 方法存在性/参数表/严格性、P1 的 schema 语义、model 目录（`model/list` 5 条：gpt-5.6-sol / -terra / -luna / gpt-5.5 / gpt-5.2）、P2 全部 |
| 脚本 | `/tmp/d48-probe/probe.mjs`（P1）、`/tmp/d48-probe/probe2.mjs`（P3）— **不入仓** |
| 原始报文 | `/tmp/d48-probe/out/wire.jsonl`、`/tmp/d48-probe/out2/wire.jsonl`；schema `/tmp/d48schema/exp/` |
| 本地配置写入 | **零**（`~/.claude` / `~/.codex` / dev.env 全程只读；rollout 仅读取） |

> ⚠️ 复现提示：`generate-json-schema` 需 `--out <DIR>`（0.145.0 起必填），不加 `--experimental` 会少 37 条 clientRequest（89 vs 126），`thread/settings/update` 在两版里都在。
