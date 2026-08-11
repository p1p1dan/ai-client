# S3 切片 4 — Codex 权限投影 施工规格（rev.2）

> **2026-08-10 落库，动工前写；同日经双轨对抗评审后修订（rev.2）。**
> plan root：[multi-agent](../plantree/plans/multi-agent/README.md)。
> 权威链：[S2 设计档](./2026-08-06-s2-codex-integration-design.md) §3「切片 4」+ §1 C4/C9/C10/C11/C12 + §2 #6/#9/#10/#11/#16 + §2.1 + §5 ＞ 本档。
> 前片：[切片 3 规格](./2026-08-10-s3-slice3-question-bridge-spec.md)（`forget()` / `defaultReplyFor()` / G 守卫形状本片直接吃）。
>
> **评审编排**：两轨双盲同题 —— A 轨镜头「失败态与安全姿态」，B 轨（Codex）镜头「证据保真与协议正确性」。
> 两轨**独立收敛 3 条**（§0.1），单轨独有 3 blocker + 11 major + 4 minor，全部采纳或登记。
> rev.1 被推翻 13 处，逐条记在 §0.2 —— **不许把推翻当成"优化"抹掉**。
>
> 标注纪律沿用：`[实测]` = 有原始报文逐字为证；`[契约]` = codex 二进制自生成 schema 为证，无报文样本；
> `[读码]` = 本仓源码可证；`[推测]` = 仍是推测，不得升格。

---

## 0.1 两轨独立收敛（可当定论）

| # | 两轨各自独立得出的同一结论 | 落点 |
|---|---|---|
| 1 | **`description` / `reason` 字段错接**：rev.1 让 Host 写 `description: params.reason`，又让渲染端 reducer 读 `reason` —— 协议里这是两个独立字段（`runtimeEvents.ts:321` / `:339`），照两段各自实现，Codex 的审批理由必然静默丢失 | §2.2 + §3.1 定死键名 |
| 2 | **A6 不可能是"夹具驱动"**：file_change 审批帧（`codex-filechange-approval-turn.jsonl:10`）**连 JSON-RPC `id` 都没有**，command 审批帧的 `id:0` 是 README 自陈的推断值，两份夹具都**没有我方回帧的信封**。既有测试注释已承认 id 是回放时由测试注入的（`codexRuntime.test.ts:93`） | §4 A5/A6 重写 + 标注降级 |
| 3 | **§3.2「四处手写内联」清单错**：`AgentHostManager` 已透传共享 payload 类型（`AgentHostManager.ts:175`）**无需改**；真正没接的是 `QuestionCard → TurnItemView → ChatTurn → MessageTimeline` 那条 boolean-only 回调链 | §3.2 改为按类型流向的 8 处 |

## 0.2 rev.1 被推翻 / 被证伪的 13 处（不得静默改写）

| # | 原文（rev.1） | 推翻理由 | 现行 |
|---|---|---|---|
| 1 | §4 A6「审批先到时……**零延迟回帧**」 | 审批**必须**等用户裁决才回帧；照字面实现＝在用户点击前替他裁决。硬约束 7 的"绝不因等 diff 延迟"约束的是**发卡**，不是回帧 | A6 拆成三条不变量（§4） |
| 2 | §2.2 投影表未含 `grantRoot` | 契约逐字：`grantRoot` = "the agent is asking the user to allow **writes under this root for the remainder of the session**"。卡上只画补丁行，用户为"一个补丁"点 Allow，**实际授出的是会话级目录写权** | 进协议 + 进卡体 + 进验收（§0.3/§2.2/§3.4/A7） |
| 3 | §2.2 exec 只读 `command/cwd/reason/availableDecisions` | `additionalPermissions`（文件系统 + 网络追加权）与 `networkApprovalContext{host,protocol}` 被静默丢弃 → 一次网络出口审批渲染成**没有卡体的空卡** | 两键进 detail 与卡体（§2.2/§3.4/A8） |
| 4 | §2.1-2「输出至少含一个 deny 族（`deny` **或** `cancel`）」 | 唯一的实测 exec 帧 `availableDecisions=["accept",{...},"cancel"]` 按此规则产出 `['allow','cancel']` —— **卡上没有普通 Deny**，而 `decline`（拒绝但回合继续）是 [实测] 被服务端照收的。这与 §0.4 刚立的"availableDecisions 不是白名单"自相矛盾 | 改为**恒含 `deny`**；`cancel` 仅在服务端给出时追加（§2.1-2/A4） |
| 5 | §2.1-2「按固定序输出」 | 契约逐字：`availableDecisions` = "**Ordered** list of decisions the client may present" —— 重排会覆盖服务端有意的呈现次序 | 保留服务端序，仅补位（§2.1-2） |
| 6 | §2.1-2 `omitted = 原始项数 - 已识别项数` | 同时要求去重 → `["accept","accept","cancel"]` 会误报"还有 1 项本 build 不支持"。协议语义是 "how many offered decisions this build **did not model**"（`runtimeEvents.ts:341`） | omitted 只对**映射不了的项**递增（§2.1-2/A3） |
| 7 | §4 A11 的 autoReason 顺序 `session_closed/aborted/…` | 读码相反：`stop()` = `drain(...,'aborted')`（`codexRuntime.ts:1234`）、`close()` → `teardown(...,'session_closed')`（`:1247`）、`onExit` → `teardown(...,'aborted')`（`:1051`） | A11 改为 `aborted / session_closed / aborted / aborted` |
| 8 | §2.3-7 `allow` 由**入参** decision 派生 | step 5 已把不可映射的 decision 降级为 `deny`，step 7 却仍用入参 → 能画出"已批准"却发了 `decline` 的卡 | 用**降级后**的有效 decision（§2.3/A2） |
| 9 | 未覆盖：回合终止时仍挂在表里的审批 | `finishTurn` 不碰 `state.pending`（`codexRuntime.ts:1071-1089`），而渲染端 `session.completed/failed/stopped` **三个分支都无条件清 `pendingPermissions`**（`chatSessions.ts:573-597`）→ 队列没了、`block.resolved` 仍 false → **卡永远 Waiting，直到 close**。那条 reducer 注释里的"回合不可能在 canUseTool 挂着时结束"是 **Claude 专属不变量**，对 Codex 不成立 | `finishTurn` 内 drain（§2.6/A12） |
| 10 | 未覆盖：发出 `cancel` 后本地回合怎么办 | 契约：`cancel` = "the turn will also be **immediately interrupted**"。(a) 若随后 `turn/completed` 的 status ≠ completed，`codexNormalizer.ts:513` 判 failed → 用户主动的"Deny and stop"被画成 `session.failed` 并写 `lastError`；(b) 若服务端**不**发 `turn/completed`（[未测]），`state.turn` 永不清 → `send()` 恒 `session_busy` | 发 `cancel` 后走 stop 同款收尾（§2.7/A13） |
| 11 | §4 A12「整条审批路径 emit 数组里无 `session.status`」 | 两份夹具自带 `thread/status/changed`，runtime 回放必然经 `onStatusChanged` 发 `session.status`（`codexRuntime.ts:855-859`）→ 该断言**恒假红** | 改为条数守恒断言（§4 A14） |
| 12 | §2.1「新模块 `codexDecisions.ts` 导出 `DECISION_LABELS`（渲染端唯一文案源）」 | **程序边界违规**：`src/agent-host` 是渲染端不可导入的独立程序（`tsconfig.web.json` 的 include/别名；`attachmentLimits.ts:175` 已有同款注释） | 文案常量落渲染端（§3.3） |
| 13 | §2.2「替换 `codexRuntime.ts:996-1004`」+「三道守卫都在 register 之前」 | `register()` 在 `:986-995`，996-1004 只是占位日志；照字面替换会把守卫放到 register **之后** | 编辑范围改为 `:986-1004` 整段（§2.2） |

**另有一处评审建议被否决（实现方否决权）**：A 轨主张在 `index.ts` 的 `permission.respond` 对未知 session 直接拒绝，
以堵住"Codex 会话 teardown 后点击回落到 Claude 运行时、被回声成 `allow:true`"的窗口。
**不采纳**：`runtimeForSession` 的 Claude 回落正是 `claudeRuntime.ts:950-1004`（F7/F8）为 **Host 重启后队列漂移**准备的解卡路径，
在共享分发层拒绝未知 session 会把那条既有恢复路径一起打死。
→ 改为**承认这条路径归 Claude 兜底**，把渲染端 R12「首次 resolve 获胜」写成本片的**显式依赖**并补断言（A20），
跨 agent 回声本身登记为 L9。

---

## 0.3 一手证据 —— 重生成契约（本机 codex 与夹具同版 `codex-cli 0.145.0`）

```
codex app-server generate-json-schema --experimental --out <dir>     # 45 个文件 + v1/ v2/ 两个子目录
```

摘录已落库：`src/agent-host/__tests__/fixtures/codex/codex-approval-schema.json`
（**`requestParams` 逐字保存，含 description** —— rev.1 那版把它归约成裸类型名，
`grantRoot` 的语义正是这样被藏起来的，见 §0.2-2。快照头部已写明"描述即安全语义，不许再归约"）。

### 决策方言表（[契约]；标 [实测] 者另有报文为证）

| 我方 `PermissionDecisionId` | v2 exec | v2 file_change | legacy `ReviewDecision` |
|---|---|---|---|
| `allow` | `"accept"` | `"accept"` | `"approved"` |
| `allow_session` | `"acceptForSession"` | `"acceptForSession"` | `"approved_for_session"` |
| `deny` | `"decline"` **[实测]** | `"decline"` | `{"denied":{"rejection":string}}` |
| `cancel` | `"cancel"` | `"cancel"` | `"abort"` |

1. **v2 exec 有 6 个变体不是 4 个**：另有 `{acceptWithExecpolicyAmendment:{execpolicy_amendment:string[]}}` 与
   `{applyNetworkPolicyAmendment:{network_policy_amendment:{action,host}}}` 两个对象变体（"批准并持久化一条规则"），本片不建模，计入 `omittedDecisionCount`。
2. **v2 file_change 只有 4 个字符串变体**，无对象变体 → **两套方言不同**，S2「same four」不成立。
3. **legacy deny 是对象** `{denied:{rejection}}`（`rejection` 必填），另有我方词表没有的 `timed_out`。
4. **`decline` 之谜结案**：`decline` 本就在响应 schema 的合法集合里，`availableDecisions` 只是**建议子集**
   （契约逐字 "Ordered list of decisions the client **may present**"），不是强校验白名单。

### 审批请求参数（[契约]；描述为逐字引用）

| 键 | 出现在 | 逐字描述（截断） | 对本片的意义 |
|---|---|---|---|
| `grantRoot` | file_change | "[UNSTABLE] …asking the user to allow writes under this root for the remainder of the session (unclear if this is honored today)" | **点 Allow 授出的不止这个补丁** → 必须上卡 |
| `additionalPermissions` | exec | "Optional additional permissions requested for this command."（`AdditionalPermissionProfile` = fileSystem + network 追加权） | 同上 |
| `networkApprovalContext` | exec | "Optional context for a managed-network approval prompt."（`{host, protocol}` 两键均必填） | 网络出口审批的**唯一**可读信息 |
| `command` | exec | 类型 `["string","null"]` | **可能为 null** → 卡体不能只靠它 |
| `availableDecisions` | exec | "**Ordered** list of decisions the client may present for this prompt." | 保序，别重排 |
| `approvalId` | exec | "…for zsh-exec-bridge subcommand approvals, **multiple callbacks can belong to one parent `itemId`**" | 一 item 多审批是被声明的形状 → 一回合多挂起可达 |
| required | exec / file_change | `["itemId","startedAtMs","threadId","turnId"]`（**`cwd` 不在内**） | 一律按可选读 |
| required | permissions | `["cwd","itemId","permissions","startedAtMs","threadId","turnId"]` | 本片不读（§2.5） |

`PermissionsRequestApprovalResponse` 把切片 2a 的一处自我怀疑扶正：`required:["permissions"]`、
`GrantedPermissionProfile` **无必填子成员**且两个成员都是**追加**权 → `{permissions:{}, scope:'turn'}`
不只是"schema 合法"，语义上就是"不追加任何权限"，是真正的 fail-safe 体。

## 0.4 仓内证据缺陷：`codex-method-contract.json` 的 serverRequest 列表是错的

同版重生成的 `ServerRequest.json` 是 **11 变体**的 `oneOf`，快照写了 10 条，两边不是包含关系：

| 差异 | 内容 | 性质 |
|---|---|---|
| 快照**多出** | `openai/form` | **假阳性**：它是 `McpServerElicitationRequestParams` 里 `mode` 字段的枚举值 |
| 快照**漏掉** | `applyPatchApproval` · `execCommandApproval` | **真方法**，且正好是本片的域（legacy 审批，走 `ReviewDecision`） |

连带 `codexWireContract.test.ts:103-114` 的 `expect(unhandled).toEqual([...])` 按错列表钉死 ——
那条测试的自我定位是"让未覆盖面显形"，**它显的形是假的**。同类欠采还波及另两族
（clientRequest 126 vs 121，缺 `initialize` 等；serverNotification 多出 `error`/`warning`/`configWarning`/
`deprecationNotice`/`guardianWarning`）—— 本片**只修 serverRequest 一族**，其余记 §6 遗留。
修正后正确的 `unhandled` 六项：`account/chatgptAuthTokens/refresh` · `attestation/generate` ·
`currentTime/read` · `item/tool/call` · `applyPatchApproval` · `execCommandApproval`
（**两个 legacy 方法不得为了让测试变绿而塞进 `SERVER_REQUEST_KINDS`**，见 §6 L5）。

## 0.5 切片 2c 已经把 correlator 造好了

[读码] `CodexNormalizer.getFileChangeDetail(itemId)`（`:256`）+ `rememberFileChange`（`:774`）+
`CODEX_FILE_CHANGE_CACHE_MAX = 64`（`:104`）+ `codexItemMapper.toPermissionFileChanges()`（含字节钳制与
`omittedFileCount`）。→ **不新建 `approvalCorrelator.ts`**：再造一张表就是第二个真相源，而 diff 的写入方只喂一张。
**缓存挂在回合上**（`normalizer` 是 `CodexTurnState` 字段，`codexRuntime.ts:400` "Fresh per turn"）——
这条事实同时决定了 §2.2 的 P1 守卫：没有回合就没有 normalizer，连关联都做不到。

---

## 1. 与 S2 的差异登记

| # | S2 原文 | 现行 | 依据 |
|---|---|---|---|
| 1 | 切片 4 含「`approvalCorrelator.ts`（新文件 ≈80 行）」 | **不新建** | §0.5 |
| 2 | 「4 id × 3 方言 = 12 例表驱动」 | **两条活方言 × 4 id = 8 例**；legacy 列不实现，只留契约钉子 | §0.3 + §6 L5 |
| 3 | 「v2 FileChange 与 CommandExecution same four」 | 两者方言**不同** | §0.3-①② |
| 4 | 未覆盖：未建模 kind 到达后怎么办（2c 登记后挂起等 drain） | **立即 `unsupported` 拒绝** | §2.5 |
| 5 | 未覆盖：审批的"无回合"姿态（切片 3 显式留给本片） | **P1 守卫** | §2.2 |
| 6 | 未覆盖：`grantRoot` / `additionalPermissions` / `networkApprovalContext` | 三者都进协议与卡体 | §0.2-2/3 |
| 7 | 「权限姿态在 Context surface 出一行」 | **本片不做**（渲染端无 `permissionPolicy` 消费者） | §6 L3 |

**协议加法（全部可选字段，版本仍为 1）**：`PermissionDetail` 两支各加几个可选键 ——
`exec` 的 `command` 由必填放宽为可选，新增 `network?: {host,protocol}` 与
`extraPermissions?: {fileSystemEntries:number; networkRequested:boolean}`；`file_change` 新增 `grantRoot?: string`。
放宽 `command` 是安全的：唯一生产者是本片新增的 Codex 路径，唯一消费者是本片新增的卡体。

---

## 2. Host 侧

### 2.1 新模块 `src/agent-host/codexDecisions.ts`（纯函数，零 IO）

```
toWireDecision(kind, id): unknown | null        // 我方 id -> 该 kind 的方言值；不可映射返回 null
readOfferedDecisions(kind, params): { decisions: PermissionDecisionId[]; omitted: number }
isPermissionDecisionId(v): v is PermissionDecisionId
```

**不导出 UI 文案**（§0.2-12：渲染端不能导入 `src/agent-host`）。

1. **`toWireDecision`**：`approval_exec` / `approval_file_change` 两张表（§0.3）。
   `approval_permissions` / `elicitation` **返回 null** —— 它们在本片不发卡（§2.5），
   走到这里就是调用方的 bug，返回 null 让上层落进 fail-safe deny，而不是编一个字段名。
2. **`readOfferedDecisions`**：
   - `availableDecisions` 缺席 / null / 非数组 → 回落 `['allow','deny']`、`omitted:0`。
     这不是"没有选项"而是"服务端没说"；file_change 请求**恒无此字段** [实测]，所以这是它的**常规路径**。
   - 有数组时：**保留服务端顺序**（契约称其为 ordered，§0.2-5），逐项映射，重复的已识别项只保留首次出现。
   - **`omitted` 只对映射不了的项递增**（未知字符串 + 未建模对象变体）；**已识别的重复项不得计入**（§0.2-6）。
   - **输出恒含 `deny`**（§0.2-4）：服务端没给就补。补位规则：有 `cancel` 时插在 `cancel` 之前，否则追加末尾
     —— "拒绝但继续"排在"拒绝并中断"之前，危险度递增。
   - `cancel` **只在服务端明确给出时**出现（file_change 的回落路径因此没有 cancel 按钮）。

### 2.2 `codexRuntime.onServerRequest` 的审批分支

编辑范围是 `codexRuntime.ts:986-1004` **整段**（register 调用 + 占位日志），**守卫必须落在 `register()` 之前**（§0.2-13）。

| 守卫 | 条件 | 回帧 | 为什么 |
|---|---|---|---|
| **P1 回合守卫** | `state.turn === null` | `defaultReplyFor(kind,'aborted')` = `{decision:'cancel'}` | 与切片 3 G1 同一立论（`stop()` 不 teardown、`turn/interrupt` 效果 [未测]），**并且**没有回合就没有 `turn.normalizer`，diff 无从关联（§0.5） |
| **P2 未建模 kind** | `approval_permissions` / `elicitation` | `defaultReplyFor(kind,'unsupported')` | §2.5 |
| **P3 关联缺失** | —— | **不设** | 缺 diff **绝不**延迟发卡、也绝不提前回帧（§0.2-1）；降级为无 diff 的卡 |

通过守卫后：`register()` → 组装 detail → emit `permission.requested`：

```
permissionId : correlationId = `codex:<sessionId>:<idKey(reqId)>`
toolName     : exec -> 'Run command' ; file_change -> 'Apply patch'
reason       : params.reason（非空串才写）        // 协议新键，不是 description（§0.1-1）
kind         : 'exec' | 'file_change'
decisions / omittedDecisionCount : readOfferedDecisions(...)（omitted>0 才写）
detail(exec) : { kind:'exec',
                 command?      : params.command（非空串才写；可能为 null [契约]）,
                 cwd?          : params.cwd,
                 network?      : params.networkApprovalContext 的 {host,protocol}（两键齐全才写）,
                 extraPermissions? : params.additionalPermissions 非空时
                                     { fileSystemEntries: <entries/read/write 计数>, networkRequested: <network.enabled === true> } }
detail(file_change) : normalizer.getFileChangeDetail(itemId) ?? { kind:'file_change', changes: [] }
                      再叠加 grantRoot?（params.grantRoot 非空串才写）
input        : **不写**（协议里 input 是 Claude 的工具入参，此处无对应物）
```

- **`detail` 恒发**（哪怕只剩 `grantRoot` 或只剩 `network`）：卡体的存在性不能取决于 `command` 是否为 null（§0.2-3）。
- `extraPermissions` **只报计数与布尔，不逐条展开**：`AdditionalPermissionProfile` 是递归结构且零样本，
  展开就是编造；"有额外权限、几条、含不含网络"足以让用户知道这不是一次普通 exec。
- **被否决的做法**：`command === null` 时自动 `decline`。自动拒绝是替用户做决定，而
  `approvalId` 的描述说明 command 为 null 可能是**常规形状**（zsh-exec-bridge 子命令），
  按形状自动拒会让一整类审批不可用。改为卡上明写"codex 未报告命令内容"（§3.4）。
- **不 emit `session.status`**（C10 rule 3；`waitingOnApproval` 由 `codexStatus.ts` 单点派生）。

### 2.3 `respondPermission(input)`

现状是 `fail('not_implemented', …)`（`codexRuntime.ts:1415-1426`）。新实现：

1. 无 session / 无 permissionId → `host.error{invalid_payload}`。
   （注意：session 已 teardown 的点击**根本到不了这里**，`runtimeForSession` 会回落 Claude —— 见 §0.2 的否决说明与 L9。）
2. 扫 `state.pending.list()` 找 `correlationId === permissionId`（**不解析字符串**：sessionId 可能含 `:`）。
3. **找不到条目 → 不发 `host.error`**，改 log + 补发
   `permission.resolved{permissionId, allow:false, autoReason:'aborted'}`（幂等，能让卡与队列收敛）。
   理由同切片 3 §2.3-2：非 fatal 的 `host.error` 在渲染端就是静默（`hostStatus.ts:85-92`）。
   **有意不与 Claude 侧对齐**（那边回声 `allow: input.allow`）：Codex 侧请求已不在表里，
   回声 allow 会画出一张"已批准"却什么都没批准的卡。
4. kind 非 approval 族 / sessionId 不符 → `host.error{invalid_payload}`。
5. `effective = toWireDecision(entry.kind, decision) === null ? 'deny' : decision`（降级 + WARN）。
6. `settle(requestId, {reason:'answered', result:{decision: toWireDecision(entry.kind, effective)}})`。
7. emit `permission.resolved{permissionId, allow: effective==='allow'||effective==='allow_session', decision: effective}`
   —— **用降级后的 `effective`**（§0.2-8），不写 `autoReason`（人裁决过）。
8. `effective === 'cancel'` → 走 §2.7 的回合收尾。

### 2.4 `onSettled` 观察者：非 answered 的投影

```
entry.kind ∈ approval 族 && reason !== 'answered'
  -> permission.resolved{ permissionId: entry.correlationId, allow:false, autoReason: mapReason(reason) }
mapReason: 'session_closed'|'aborted'|'unsupported'|'timed_out' -> 原值 ; 'forgotten' -> 'aborted'
```

**`'forgotten' → 'aborted'` 是本片已知的诚实性缺口**（同切片 3 L4）：`PendingSettleReason` 5 值 vs 协议 4 值，
而 C10 明令不为 Host 内部概念加宽协议枚举。`'aborted'` 是最接近真相的现存词（服务端自行了结的已知主因就是回合被中断/自动放行），
真实原因写日志。**不许**改成"省略 autoReason" —— 那等于宣称有人裁决过。
⚠️ 唯一那份 file_change 实测样本很可能就走这条路（第 10 行请求与第 11 行 `serverRequest/resolved` **同毫秒**到达，
第 13 行 item 直接 `status:"declined"`）→ 对 file_change 这可能是**常规路径而非边角**，A16 单独钉它。

### 2.5 未建模的两类：立即拒绝而不是挂起

`approval_permissions` 与 `elicitation` 在 2c 是登记后挂起等 drain。后果 [读码]：codex 停在
`waitingOnApproval`、用户看不到任何卡、**回合直到 Stop 才结束**。
本片改为 P2 守卫：不登记、立即 `defaultReplyFor(kind,'unsupported')`（空授予 / decline，§0.3 已证契约合法且语义 fail-safe）。
`item/permissions/requestApproval` 在本机 build **不可达** [实测 S2-a]，elicitation 只在接了 MCP server 时可能出现 ——
两者都罕见，但"罕见地挂死一个回合"比"罕见地拒绝一次"坏得多。

### 2.6 `finishTurn` 必须 drain（本片新增的硬修复）

[读码] `finishTurn`（`codexRuntime.ts:1071-1089`）不碰 `state.pending`，而渲染端
`session.completed/failed/stopped` 三个分支**都无条件清 `pendingPermissions`**（`chatSessions.ts:573-597`，
注释里那条"回合不可能在 canUseTool 挂着时结束"是 **Claude 专属不变量**）。
→ 回合终结时仍挂着的审批：队列项被清 → `canRespondToPermission` 恒 false → 卡渲染成 `waiting`
且 `block.resolved` 仍 false → **永远转圈到 close 为止**。
可达性有契约支撑：`approvalId` 声明"一个父 itemId 可有多个审批回调"，一回合多挂起是被声明的形状。
**修法**：`finishTurn` 内对本会话 `drain({sessionId}, 'aborted')`。
终端事件与 resolved 的先后不影响收敛（`permission.resolved` 的 reducer 只认 block、不依赖队列），A12 两序都钉。

### 2.7 发出 `cancel` 之后的本地收尾

契约：`cancel` = "the turn will also be immediately interrupted"。本地零处置有两条坏路（§0.2-10）。
**修法**：settle 之后按 `stop()` 的同款序列收尾 —— `drain({sessionId},'aborted')`（其余挂起项已无人可答）
→ emit `session.status`（registry 现值）→ `finishTurn(state,'stopped')`。**不再额外发 `turn/interrupt`**：
回帧本身就是中断信号，重复发一次是对一个正在自毁的回合喊第二遍。
代价 [推测]：若服务端并未真的中断，我方已本地关闭回合，后续帧被 `if (!turn) return` 丢弃 ——
与现有 Stop 的语义完全对称，故接受。

### 2.8 分发层 `index.ts` 的 `decision` 透传

`agent-host/index.ts:598-622` 现在只读 `allow`：

```
const decision = isPermissionDecisionId(cmd.payload?.decision) ? cmd.payload.decision : undefined;  // 未知值丢弃
const allow = Boolean(cmd.payload?.allow);
let effective = decision ?? (allow ? 'allow' : 'deny');
if ((effective === 'allow' || effective === 'allow_session') && !allow) effective = 'deny';          // 冲突取 deny + WARN
```

**Claude 侧影响为零**：`claudeRuntime.respondPermission` 入参不加 `decision`，`allow` 保持必填（S2 #10）。

---

## 3. 渲染端

### 3.1 红线文件 `chatSessions.ts` 的两处加法

- **`permission.requested`**（`:701-761`）：新建 block 时补写
  `permissionKind ← kind` · `permissionDetail ← detail` · `permissionDecisions ← decisions` ·
  `omittedDecisionCount ← omittedDecisionCount` ·
  **`toolDescription ← payload.reason ?? payload.description`**（§0.1-1：Codex 走新键 `reason`，
  Claude 继续走历史键 `description`，两边都不丢）。幂等守卫原样不动。
- **`permission.resolved`**（`:763-800`）：命中的 block 补记 `permissionDecision` / `permissionAutoReason`。
  R12「首次 resolve 获胜」与 R13 identity-preserving early return **原样保留**（R12 是 §0.2 否决项的显式依赖）。

### 3.2 `decision` 透传链（按类型流向，8 处；`AgentHostManager` **不改**）

1. `OptionRow.decision?: PermissionDecisionId`（`questionCardModel.ts:101-106`）
2. `QuestionCardProps.onRespondPermission`（`QuestionCard.tsx:61`）
3. `PermissionQaCard` 的 `onRespond` 与调用点（`:441` / `:488`）
4. `TurnItemViewProps.onRespondPermission`（`MessageTimeline.tsx:1299`）
5. `MessageTimeline.tsx:1373` 的内联 lambda
6. `ChatTurnProps.onRespondPermission`（`MessageTimeline.tsx:772`）
7. store `respondPermission(permissionId, allow, decision?)`（`chatSessions.ts:228` / `:1069`）
8. preload（`preload/index.ts:1420-1425`）与 Main IPC（`main/ipc/chat.ts:175-181`）的手写内联 payload

`allow` 由 decision 单向派生（`allow = id==='allow' || id==='allow_session'`），**不得由两条代码路径各算一次**。

### 3.3 卡层：决策行必须携带 id —— 本片最容易踩的一处

**现状是个陷阱** [读码]：`QuestionCard.tsx:488` 用 `option.label === PERMISSION_ALLOW` 判 allow/deny。
多出第三行「Allow for session」时它会被判 false 并**当作拒绝发出去**。
→ 行由 model 层带 `decision` 出，组件只做 `onRespond?.(option.decision)`。提问卡的 OptionRow 不带此字段，行为逐字节不变。

`derivePermissionCardView` 的 `pending + canRespond` 分支：
- 选项行 = `block.permissionDecisions ?? ['allow','deny']`，文案取**渲染端本地**的 `PERMISSION_DECISION_LABELS`
  （`questionCardModel.ts` 内，§0.2-12）：`Allow` / `Allow for session` / `Deny` / `Deny and stop`。
  最后一个必须让人看出它不是 Deny 的同义词（契约：拒绝**并中断回合**）。
- 缺 `decisions` 时**恰好两行 A/B 且文案不变**。
- `omittedDecisionCount > 0` → 卡底一行说明（C9：位次固定卡底）。

`resolved` 分支与 `derivePermissionRowView`：verb 由 `permissionDecision` 决定
（allow→Allowed · allow_session→Allowed for session · deny→Denied · cancel→Denied, turn stopped），
无 decision 时回落现有 `allowed` 布尔（Claude 侧逐字不变）；`permissionAutoReason` 存在时尾部追 `· auto: <reason>`
（补 S2 #11 点名的既有诚实性缺口：现状是"没人裁决也画成 Denied"）。

### 3.4 卡体：摘要 + **权限外延必须显形**

- `exec`：一行等宽命令（`truncate`，全值走 `title`）；`cwd` meta 行；
  **`network` 存在 → 一行 `Network: <protocol>://<host>`**；
  **`extraPermissions` 存在 → 一行警示**「此命令还申请了额外权限（文件系统 N 项 / 网络 是·否）」；
  `command` 缺席 → 一行「codex 未报告命令内容」（而不是空卡，§2.2）。
- `file_change`：逐文件一行（变更类型徽标 + `min-w-0 flex-1 truncate` 路径 + 由 diff 现算的 `+a/-b`）；
  `omittedFileCount>0` 追说明行；`truncated` 标注 "diff clamped"；
  **`grantRoot` 存在 → 一行醒目声明**「同时允许在 `<root>` 下写入，本会话有效」。
  这一行不是装饰：不写它，用户为一个补丁点的 Allow 会**静默授出会话级目录写权**（§0.2-2）。
- **不渲染 diff 正文**：仓内唯一 diff 件 `source-control/DiffViewer.tsx` 是 Monaco `DiffEditor` + `useFileDiff` + git store 的重组件，
  吃的是 git 路径而非 unified diff 串，既不可复用也违反"组件优先"。做新 diff 视图是独立任务（§6 L1）。
- 视觉值一律取 `docs/design-system.md` 分档与既有 token。

---

## 4. 验收（先写死，实现不许改测试去迁就自己）

| # | 断言 | 形式 |
|---|---|---|
| A1 | 8 例表驱动：`toWireDecision` 对两条活方言 × 4 id 逐字命中 §0.3 表 | 表驱动 |
| A2 | `toWireDecision` 返回 null → 发出的 wire 值是 deny 方言，**且 `permission.resolved.allow === false`、`decision === 'deny'`**（钉 §0.2-8） | 单元 |
| A3 | `readOfferedDecisions` 六例：缺席 / null / 非数组 / 全对象项 / 混合项 / **`["accept","accept","cancel"]` 负控（`omitted` 必须为 0）** | 表驱动 |
| A4 | **不变量：输出恒含 `deny`**；且服务端给出的相对顺序被保留；`cancel` 仅在服务端给出时出现 | 属性/穷举 |
| A5 | 真实 params 回放（`codex-command-approval.jsonl` 第 3 行，**JSON-RPC id 由测试注入并注明**）→ `permission.requested` 的 kind/detail.command/detail.cwd/decisions/omittedDecisionCount 命中；该帧对象项计入 `omitted=1`，**且 decisions 含 `deny`**（钉 §0.2-4） | 夹具 params + [构造] id |
| A6 | 拆三条：**(a)** 真实时序回放（`item/started` 第 8 行 → 审批第 10 行，同 itemId）→ detail.changes 命中；**(b)** 合成反序（测试自行交换两帧顺序，标 [构造]）→ **卡照发、detail 省略**；**(c)** 用户裁决前**零 wire 回帧且条目仍在表内**，调用 `respondPermission` 后才恰好一条 | 夹具 + [构造] |
| A7 | `grantRoot` 非空 → 进 `detail.grantRoot` 且卡体出声明行；为 null/缺席时**不出该行** | 单元 + model |
| A8 | exec 的 `networkApprovalContext` / `additionalPermissions` 各一条：进 detail 且出对应卡体行；**`command:null` 时卡体非空**（不得退化为空卡，也不得自动拒绝） | 单元 + model |
| A9 | `respondPermission` 正常路径：表 size 减 1、**恰好一条 wire 帧**、恰好一条带 `decision` 且不带 `autoReason` 的 `permission.resolved` | 单元 |
| A10 | 找不到条目 → 零 `host.error` + 一条 `permission.resolved{allow:false, autoReason:'aborted'}` | 单元 |
| A11 | 四路 drain 的 autoReason 逐条：**stop→`aborted` · close→`session_closed` · exit→`aborted` · forget→`aborted`**（钉 §0.2-7），每条挂起审批恰好一条 resolved；`reason==='answered'` 时**不重复投影** | 单元 |
| A12 | **回合终结即收敛**：回合内挂着一条审批 → `turn/completed` 到达 → 表 size 归零、该审批恰好一条 `permission.resolved{allow:false}`；**且终端事件与 resolved 的两种先后次序下 block 都变 resolved** | 单元 |
| A13 | 用户选 `cancel` → 发出 `{decision:'cancel'}` + 本会话其余挂起项被 drain + `state.turn === null`；**随后 `send()` 不再 `session_busy`**（钉 §0.2-10(b)） | 单元 |
| A14 | `session.status` **条数守恒**：整条审批回放中 `session.status` 的条数 == 喂进去的 `thread/status/changed` 条数（桥自身零发；**不写"一条都没有"**，夹具自带状态帧，§0.2-11） | 结构性 |
| A15 | `permission.requested` 的**键名**逐字断言：Codex 侧写的是 `reason` 而非 `description`；store 侧 `toolDescription` 取到该值；Claude 侧仍从 `description` 取到（钉 §0.1-1） | 单元 ×2 |
| A16 | 请求后 1ms 到达 `serverRequest/resolved` → 恰好一条 `permission.resolved{allow:false, autoReason:'aborted'}`，卡文案不得声称有人裁决过（§2.4 的常规路径） | 单元 |
| A17 | P1：无回合的审批 → 不登记 + 立即 `{decision:'cancel'}` + 无 `permission.requested` + 无 `permission.resolved` | 单元 |
| A18 | P2：permissions / elicitation → 不登记 + 空授予 / decline，表 size 不变 | 单元 |
| A19 | 卡层：`['allow','allow_session','deny']` → 三行；点第二行发出 `allow_session` 且 `allow===true`；点第三行 `allow===false`（钉 §3.3 的 label 陷阱） | model/组件 |
| A20 | teardown 之后的迟到点击：`permission.resolved{allow:true}` 不得把已 resolved 的 block 翻成 Allowed（R12 的显式依赖断言，§0.2 否决项） | store 单元 |
| A21 | 卡层回归：`decisions` 缺席 → 恰好 A/B 两行、**文案**逐字不变；`omittedDecisionCount` 0/缺席不出说明行、>0 出且在卡底 | model |
| A22 | resolved 态：四个 decision 各自的 ToolRow verb；无 decision 时回落 `allowed` 布尔；`autoReason` 出现在尾部 | model |
| A23 | 契约钉子（双向）：两张活方言表的每个 wire 值都出现在 `codex-approval-schema.json` 对应 `*Decision.oneOf` 里；契约里每个**字符串**变体在表内有 id 或被显式列为"本片不建模" | 快照驱动 |
| A24 | `codex-method-contract.json` 修正后含两个 legacy 方法、不含 `openai/form`；`codexWireContract.test.ts` 的 `unhandled` 同步为 §0.4 的六项 | 契约 |

**门禁**：lint / typecheck / typecheck:agent-host / vitest **逐门串行**（本机内存有限，链式合跑曾 OOM）。

---

## 5. 既有测试合同迁移（必须显式改写，不是"顺手修红"）

| 落点 | 现状 | 本片必须怎么改 |
|---|---|---|
| `questionCardModel.test.ts:390-420` | `expect(view.options).toEqual([{letter,label,isOther}])` 整对象相等 | 补 `decision:'allow'/'deny'`；**保留 label 与 A/B 顺序断言**。"文案不变"≠"旧对象断言不用改" |
| `codexRuntime.test.ts:880` | 断言 `permission.respond` 仍回 `['not_implemented']` | **改写为正常桥测试**，不许直接删（删掉等于丢了这条路径的唯一覆盖） |
| `codexRuntime.test.ts:743` 一带（close/stop/exit drain） | 只钉回帧体与部分日志 | 补 `permission.resolved` 的恰好一次与 `autoReason`（否则漏投影事件仍会绿） |
| `codexWireContract.test.ts:103-114` | `unhandled` 按错列表 toEqual | 按 §0.4 六项更新 |

---

## 6. 本片不做 / 已登记的遗留

**本片不做**：历史（切片 5）· 打包链（2b）· flag on/off 双跑与侧栏截图（切片 6）· `thread/fork`（C12 硬约束）。

| # | 项 | 归属 |
|---|---|---|
| L1 | 审批卡不渲染 diff 正文（只出文件行与 +/- 计数） | 独立任务（需设计） |
| L2 | 两个"批准并持久化规则"变体（execpolicy / networkPolicy amendment）不建模：无 UI 承载、无撤销入口，计入 `omittedDecisionCount` | 待设计 |
| L3 | `SessionPermissionPolicy` 渲染端零消费者（`sessionRuntimeFacts` 只认 `permissionMode`）→ Codex 会话上下文面板无权限姿态行；Host 侧已发（`codexRuntime.ts:703`） | 切片 6 或另立 |
| L4 | `'forgotten' → autoReason:'aborted'` 是词表不足下的近似（§2.4） | 已知缺陷 |
| L5 | legacy `applyPatchApproval` / `execCommandApproval` 不注册（仍回 `method_not_found`，不会挂起）。方言表第三列的事实已备齐，缺的是注册 + 参数投影（`callId`/`conversationId`/`fileChanges`/`parsedCmd` 与 v2 完全不同）。**判据**：现场抓到一帧即补 | 登记，等样本 |
| L6 | 快照另两族欠采（clientRequest 缺 5、serverNotification 缺 5，含 `error`/`warning` 两条**至今无处理分支**的通知） | 证据卫生，另立 |
| L7 | `toPermissionFileChanges` 的字节钳制用 `subarray().toString()`，可能把多字节字符切半 | backlog |
| L8 | `approvalId`（zsh-exec-bridge 子命令审批，一个 itemId 多回调）不做路由消歧：本片按 JSON-RPC id 一一对应，够用；真出现同 item 多审批时卡片标题会重复 | 观察项 |
| L9 | **跨 agent 回声**：Codex 会话 teardown 后的迟到点击经 `runtimeForSession` 回落 Claude 运行时，被回声成 `allow: input.allow` 并把状态推回 idle。本片靠渲染端 R12 兜住（A20），根治要么给命令带 agent、要么让 registry 保留墓碑 | 登记（§0.2 否决项） |
| L10 | `grantRoot` 自带 `[UNSTABLE] (unclear if this is honored today)`：我们照它渲染警示行，但**服务端是否真的据此放宽写权未经证实**；若后来证明不生效，警示行会变成虚惊 | 观察项 |


---

## 7. as-built 施工偏差登记（2026-08-10 施工批，规格拍板后追加）

> 施工按「实现方否决权」原则执行：与规格冲突处取更安全读法落地并在此留痕，不静默改写上文。
> 编排：串行三段（Foundation → Host → Renderer，各自变异验证）+ fresh-eyes 复核（1 major + 5 minor，全部闭环）+ 修复段。

### 7.1 对规格点名内容的范围变更（最重要的两条）

| # | 规格原文 | as-built | 理由 |
|---|---|---|---|
| 1 | §2.6「`finishTurn` 内 drain({sessionId},'aborted')」（全表） | **收窄为仅审批族**（`APPROVAL_CARD_KINDS`）；为此给 `codexPending.drain` 加了可选 `kinds` 过滤（缺省全表，既有调用点行为不变） | 照字面会连提问一起 drain：打红切片 3 既有测试（不在 §5 迁移清单内），且渲染端终端分支只清 `pendingPermissions`——提问在回合末**并不搁浅**，替用户 reject 一张他仍能作答的卡是新增伤害。两处代码注释已写明「规格说全表、此处有意收窄」 |
| 2 | §2.1-2 只列「缺席/null/非数组」回落 `['allow','deny']` | **空数组不回落**：产出 `['deny']`、omitted=0（deny-only 卡）。渲染端对称：`permissionDecisions` 全不可识别 → `['deny']`，不产出零按钮卡 | 空数组是数组；回落等于替服务端凭空造一个 Allow 按钮。恒含 deny 的不变量（§0.2-4）仍满足 |

### 7.2 其余实现取舍（逐条）

- **`toWireDecision` 签名 `string | null` 非 `unknown | null`**：TS 里 `unknown | null` 塌缩成 `unknown`，抹掉 §2.3-5 依赖的 null 判据；legacy 对象变体（L5）落地时再加宽。
- **A6(b) 两半的落地**：Host 侧 detail 恒发（`{kind:'file_change',changes:[]}`，§2.2 优先于 A6(b) 措辞）；渲染端 `derivePermissionDetailView` 在一行都渲染不出时返回 null——屏幕效果即「卡照发、detail 省略」，避免空 flex 占位盒（本仓已有该类缺陷记录）；`changes:[]` 但有 `grantRoot` 时卡体仍出。
- **A2 的 allow 半边当前不可观测**：两条活方言 4 id 全可映射，唯一触发降级的是词表外 id，两种派生给同样的 `allow:false`。可观测的 `decision` 字段已被钉死（变异验证）；`allow` 按 §0.2-8 用降级后值实现，作为防御不变量保留。
- **§2.8（index.ts 分发）零自动化覆盖**：index.ts 顶层起 readline 监听 stdin，vitest(node) import 即挂死（仓内已有同类事故）。6 行逻辑按规格内联，靠评审保证——**登记为覆盖缺口**。派生块移到 sessionId/permissionId 校验之后（对合法载荷零差异）。
- **method-contract 修正的追加序**：两个 legacy 方法**追加在数组末尾**而非字母序——`unhandled` 断言是保序 filter，只有末尾追加能逐字等于 §0.4 的六项。A24 另加固：两份快照 codexVersion 必须一致、serverRequest 集合必须等于 `codex-approval-schema.json` 的 11 项、legacy 方法**不得**进 `SERVER_REQUEST_KINDS`（把"为绿而注册"的捷径钉死）。
- **卡层细节**：autoReason 尾注在 frozen answer 里是字符串尾部、在 ToolRow 里追 arg 末尾（verb 保持纯动词槽位）；file 行 React key 用 `${index}:${path}`（防 rename 同路径撞 key）；`OptionRow.decision` 为 undefined 时 early return（不回落 allow/deny——"认不出就当 allow/deny"正是本片拆掉的 bug）；识别判定用 `Object.hasOwn`（防 wire 载荷 `'constructor'` 原型链投毒，有负面断言）；`permissionKind` 当前是只写字段（卡体分派走 `detail.kind`），登记以防误认有活消费者。
- **`respondPermission` 的 requestId 口径**：成功路径带、补发路径不带——对齐切片 3 `respondQuestion` 先例（规格未规定）。

### 7.3 复核发现与修复（1 major + 5 minor，全闭环）

| 严重级 | 发现 | 修复 |
|---|---|---|
| major | **A19 发射半边零覆盖**：decision 从按钮到 IPC 整条链没有一跳被钉住，去掉透传全套件仍绿，"Deny and stop"静默退化成普通 deny | `messageTimelineWiring.test.ts` 加 S3-4 源码 pin（含 `expectUnwired` 钉死被替换的 boolean 调用）；`chatSessionsRespond.test.ts` 补 3 参/2 参 payload 断言（键集合断言，区分"缺席"与"undefined"）；**hop 1** 另立 `questionCardWiring.test.ts` 钉 `onRespond?.(decision)` 与 not.toContain 旧 label 比对 |
| minor | A12 store 半边缺失（未来给 resolved reducer 加队列前置即复活 §2.6 缺陷） | `chatSessionsCore.test.ts` 补 4 行：终端 × resolved 双序，block 都 resolved 且新字段记上（变异验证：注入队列前置 → 恰好终端先行两行转红） |
| minor | codexRuntime G1 注释仍写"审批不发卡、留给切片 4" | 改写为 P1 共享姿态现状 |
| minor | QuestionCard 注释把旧陷阱方向写反（旧代码是 fail-closed DENY 不是 ALLOW） | 如实改写：方向 fail-closed、语义错误（Allow for session 会被当拒绝发出） |
| minor | §7.1-1 收窄在代码侧无"规格说全表"的自白 | 两处注释补上 |
| minor | `countDiffStat` 的 `+++/---` 前缀跳过吞正文行（删除 `--foo` 产生 `---foo`） | hunk 感知：`@@` 前才跳文件头，`diff ` 行复位（防多文件补丁回归）；**已声明残留**：无头部的裸 `-`/`+` 行内容仍按旧行为计数（有既有冻结测试依赖） |

### 7.4 覆盖缺口与待裁清单（本批遗留，不混入 §6）

- index.ts 分发 6 行零自动化覆盖（§7.2，成因结构性 = open-q #27 同族）。
- **UI 中英混排待用户裁**：按钮文案英文（既有 `PERMISSION_ALLOW` 词表沿用），§3.4 卡体新行按规格字面是中文——同卡混排。统一只需改 `questionCardModel.ts` 几个字符串常量，测试断的是计数/路径/非空不会打红。
