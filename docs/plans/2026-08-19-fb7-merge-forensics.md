# FB7 permission 行与 tool_call 行合并 —— 协议层取证与关联键设计

> 取证时点：2026-08-19 · HEAD `99dfd78` · 分支 `feat/openchamber-chat-refactor` · 工作树干净
> 上游拍板：D53 ②（`openchamber-chat-refactor-ledger.md:97`）· 分诊：`2026-08-19-usage-feedback-0820-triage.md:18`
> 取证期间未改任何生产代码。行号均为取证当次实读所得。

## 0. 证据成色声明

先说缺口，避免按满覆盖度推演：

- **实读闭环**：`permissionBridge.ts` 全文 / `toolCard.ts`(60-200) / `questionCardModel.ts`(300-430, 707-726) /
  `QuestionCard.tsx`(508-578) / `ToolRows.tsx`(62-112) / `MessageTimeline.tsx`(1560-1620) /
  `chatSessions.ts`(128-163, 702-850) / `runtimeEvents.ts`(260-416) / `codexRuntime.ts` 关键段 / codex schema fixture
- **未直读**：`chatTurn.ts` 源文件（仅从其测试反推 `splitTurnBody` / `hasUnresolvedPermission`）；
  `ToolRowView` 完整字段表（只读到 `toolCard.ts:194-199` 开头）
- **盘点不完整**：`questionCardModel.test.ts` 93 个 `it` 未逐条盘；`questionCardWiring.test.ts` 4 例未盘
- **未实测**：deny 后 run 是否 settle（见 §4-C，列为开放问题 + GUI 点验必查项）

---

## 1. 协议层取证

### 1.1 结论

**Claude 路径：`permissionId` 与 `toolCallId` 本就是同一个字符串**，不需要"打通"。
**Codex 路径：关联 id（`itemId`）在主进程存在但未透传**到渲染端。

D53② 写的「需打通 permissionId↔toolCallId 关联」与 triage:18「合并需 join，无纯模块做过」是分诊期的
保守假设，本取证推翻其 Claude 半边。

### 1.2 Claude 路径逐跳传递链

| # | 跳 | file:line | 事实 | id 幸存 |
|---|---|---|---|---|
| 1 | SDK→Bridge | `permissionBridge.ts:73` | `toolUseID: string;` —— canUseTool options，**必填非可选** | ✅ |
| 2 | Bridge 内传 | `permissionBridge.ts:96` | `toolUseId: options.toolUseID,` | ✅ |
| 3 | **id 生成** | `permissionBridge.ts:38-42` | `if (toolUseId && toolUseId.length > 0) return toolUseId;`（否则 `perm-${Date.now()}-${seq}`） | ✅ **相等在此确立** |
| 4 | 落 payload | `permissionBridge.ts:113`, `:189-203` | `const permissionId = nextPermissionId(input.toolUseId);` → emit `permission.requested` | ✅ |
| 5 | 运行时第二接线点 | `claudeRuntime.ts:731` | `toolUseId: options.toolUseID,`（非测试路径） | ✅ |
| 6 | tool 帧生产 | `eventNormalizer.ts:551-562` | `type:'tool.started'` … `toolCallId: tool.id,`（`tool.id` = assistant 消息 `tool_use` block id） | ✅ |
| 7 | store 落 tool 块 | `chatSessions.ts:713-715` | `id: event.payload.toolCallId,` / `type:'tool_call'` / `toolCallId:…` | ✅ |
| 8 | store 落 perm 块 | `chatSessions.ts:786-788` | `id: event.payload.permissionId,` / `type:'permission_request'` / `permissionId:…` | ✅ |

第 3 跳是地基：SDK `toolUseID` ≡ Anthropic `tool_use.id`，故第 7、8 跳产生的两个 block
**`id` 字符串完全相同**。

### 1.3 生产者缺席验证（写入点实证，非类型推断）

**证据 A —— 一次真实 P0 事故**。`chatSessions.ts:764-770`：

> `// Round-2 P0 fix: scoped to permission_request blocks only — the Host uses`
> `// the SDK toolUseID as the permissionId, which is the SAME id 'tool.started'`
> `// already used for that turn's tool_call block`

去重守卫对**每个真实** permission 请求都误判为重复并整块吞掉 —— 该 bug 仅在两 id 真相等时成立。
**事故本身即运行时相等的证明。**

**证据 B —— 回归测试钉死**。`chatSessionsCore.test.ts:534`
用例名：`appends a permission_request block even when a tool_call block already shares its id`
`toolCallId:'toolu_1'`(:544) 与 `permissionId:'toolu_1'`(:553) 同值，断言 `['tool_call','permission_request']` 并存(:562)。

**证据 C —— 顺序**。同用例 `tool.started` seq:1、`permission.requested` seq:2；`chatSessions.ts:767` 的
**"already"** 亦为顺序陈述。**工具行先于授权行存在。**

### 1.4 字段表

`PermissionRequestedEvent`（`runtimeEvents.ts:382-416`）

| 字段 | 类型 | 可选 | 备注 |
|---|---|---|---|
| `permissionId` | string | 必填 | = toolUseID = toolCallId（Claude） |
| `toolName` | string | 必填 | Codex 为 `APPROVAL_TOOL_NAME[kind]` 合成名 |
| `description` | string | 可选 | Claude 键 |
| `input` | unknown | 可选 | Codex **明确不写**（`codexRuntime.ts:2471`） |
| `agentId` | string | 可选 | T-34 subagent 来源；主 agent 时**键整个缺席** |
| `kind` | PermissionRequestKind | 可选 | 缺席 = `'tool'` |
| `decisions` | PermissionDecisionId[] | 可选 | 缺席 = `['allow','deny']` |
| `detail` | PermissionDetail | 可选 | exec 命令 / file_change diff |
| `reason` | string | 可选 | Codex 键（与 `description` 是两个字段） |
| `omittedDecisionCount` | number | 可选 | 未建模选项数 |

`ToolStartedEvent`（:263-272）：`messageId:string` / `toolCallId:string` / `name:string` / `input?:unknown`
`ToolCompletedEvent`（:274-284）：`messageId` / `toolCallId` / `ok:boolean` / `output?` / `error?`

### 1.5 Codex 路径 —— ②档「存在但未透传」

| 事实 | file:line | 原文 / 内容 |
|---|---|---|
| permissionId 不是 item id | `codexRuntime.ts:2433` | `const permissionId = this.correlationIdFor(sessionId, req.id);` |
| 它是 RPC 相关 id | `codexRuntime.ts:2505-2507` | ``return `codex:${sessionId}:${idKey(requestId)}`;`` |
| `itemId` 就在 params 且已被读 | `codexRuntime.ts:2452` | `…getFileChangeDetail(readText(params,'itemId') ?? '')` |
| 但 emit 未写入 payload | `codexRuntime.ts:2456-2476` | payload 仅 permissionId/toolName/kind/reason/decisions/omittedDecisionCount/detail |
| `itemId` 协议**必填** | `codex-approval-schema.json` | `CommandExecutionRequestApprovalParams.required=["itemId","startedAtMs","threadId","turnId"]`（FileChange 同） |
| itemId **就是** tool 行 id | `codexItemMapper.ts:210-211` | `/** Wire item.id … Doubles as the toolCallId for tool rows. */` |

schema 来自 codex 二进制自生成快照（codex-cli 0.145.0，捕获 2026-08-10），非我方信念。

**透传改动面**：`runtimeEvents.ts` 加可选字段 + `codexRuntime.ts` emit 一行 + store 一行。
属既有「可选字段追加、协议版本不变」先例（`agentId` 即如此，`permissionBridge.ts:198-201` 有成文规矩）。

### 1.6 Codex N:1 陷阱

`codex-approval-schema.json` → `CommandExecutionRequestApprovalParams.approvalId` 描述：

> "For zsh-exec-bridge subcommand approvals, **multiple callbacks can belong to one parent `itemId`**"

**一个工具行可能挂多个授权决议。** 合并设计必须容纳 N:1。

---

## 2. 渲染端取证

### 2.1 「两行」的产生链

| 层 | file:line | 事实 |
|---|---|---|
| 分组 | `toolCard.ts:172-178` | `tool_call` → 查 `runByBlockId`，`if (!run) break;`，进 `currentGroup`（聚合行） |
| 分组 | `toolCard.ts:164-167` | `permission_request` → **`flush()`** + 独立 `{kind:'permission'}` item |
| 渲染 | `MessageTimeline.tsx:1578-1598` | `case 'permission':` → `<QuestionCard variant="permission" block={item.block} …/>` |
| 渲染 | `QuestionCard.tsx:525-529` | `if (view.state === 'resolved') { const rowView = derivePermissionRowView(…); return <ToolRow view={rowView} />; }` |

**关键认知：`Allowed Bash — X` 那行本身已经是一个 `ToolRow`。** D28 的「复用 ToolRow」是落到实处的。
合并不是造新组件，而是**不要为它单独再生一行**。

**隐藏的第二重伤害**：`:164-167` 的 `flush()` **打断 D24 的工具聚合**（`Explored N files, M searches ▾`）。
每个授权把聚合切成两段。合并后不仅省一行，还能恢复聚合连续性 —— 分诊未抓到的收益。

### 2.2 item kind 联合类型（`toolCard.ts:114-123`）

```ts
export type TimelineItem =
  | { kind:'text'; block; blockIndex }
  | { kind:'question'; block; blockIndex }
  | { kind:'permission'; block; blockIndex }
  | { kind:'toolGroup'; entries: ToolGroupEntry[]; blockIndex };
export type ToolGroupEntry = { kind:'run'; run: ToolRun } | { kind:'thinking'; block; blockIndex };
```

### 2.3 承重结构 `ToolRun`（`toolCard.ts:60-75`，由 `pairToolBlocks` 产）

```ts
runs.push({ toolCallId: block.toolCallId, blockIndex, blockId: block.id,
  toolName: block.toolName ?? '', input: block.toolInput,
  status: !result ? 'running' : failed ? 'failed' : 'ok', output, errorText });
```

`:61` 已有 `if (block.type !== 'tool_call' || !block.toolCallId) return;` —— permission block 天然被排除，
扩展它不污染此处。

### 2.4 permission 卡 vs permission 行：**同一物的两态，非两物**

`QuestionCard` 单组件按 `view.state` 分叉：

- 未决 → QA 整卡（`:531-577`，Allow/Deny 按钮、`PermissionDetailBody` 展示 diff/命令、omittedNote 钉卡底）
- 已决 → 塌成 `ToolRow`（`:525-529`）

数据同为一个 `permission_request` block。**二者互斥，不同屏。**

`derivePermissionRowView`（`questionCardModel.ts:707-726`）：

```ts
if (block.resolved !== true) return null;
return { key: block.id, verb: derivePermissionVerb(block),
  arg: withAutoNote(originLabel ? `${prompt} · ${originLabel}` : prompt, block),
  argKind:'prose', running:false, failed: block.allowed === false, expandable:false };
```

### 2.5 已决态承载的信息（合并后不得丢）

- `questionCardModel.ts:312-315`：四档动词 `Allowed` / `Allowed for session` / `Denied` / `Denied, turn stopped`
  （`:311` 注释：`cancel` 的 `Deny and stop` "Deliberately not a synonym for Deny"）
- `:403-407` `derivePermissionVerb`：有 decision 用四档，否则回落 `allowed` 布尔
- `:416-424` `auto: <reason>` provenance —— 存在理由是「被 drain 的授权曾被画成普通 Denied，与真人拒绝无从分辨」
- `QuestionCard.tsx:514-517` subagent 来源 chip：走 `subagentActivity` store 的 `permissionOrigin` 索引，
  **不经 block**，且 resolved 即删 → **恒空**

### 2.6 `ToolRows.tsx` DOM 与宽度约束（`:74-99`）

```tsx
const rowClass = cn('group/row flex w-full items-baseline gap-1.5 text-left text-markdown leading-normal',
  view.failed ? 'text-destructive' : 'text-muted-foreground');
const verbClass = cn('shrink-0', !view.failed && 'group-hover/row:text-foreground');
const rowContent = (<><span className={verbClass}>{view.verb}</span><ToolRowArg view={view} …/></>);
```

现有槽位 = **verb(`shrink-0`) + arg(可截断)** 两个。
`:93-96` `subagentSlot`（`isDelegationTool` 时挂 `<SubagentActivity/>`）是「往这一行挂新东西」的既有先例。

### 2.7 `chatTurn.ts`【未直读源文件，以下从其测试反推】

- `splitTurnBody(items)` → `{ process, answer }` 两段
- `hasUnresolvedPermission(turn)` → 布尔
- 未决 permission item 落 **process** 段，按 block order 不提升

**施工前需直读确认。**

### 2.8 `ChatBlock`（`chatSessions.ts:128-163`）

扁平共用结构。permission 相关键：`permissionId?` `toolDescription?` `resolved?` `allowed?`
`permissionKind?` `permissionDetail?` `permissionDecisions?` `permissionDecision?`
`permissionAutoReason?` `omittedDecisionCount?`

**`toolCallId?` 存在于类型，但 permission_request block 从不写入它**（见 §6 空壳自查）。

---

## 3. 测试影响清单

| file:line | 用例名 | 断言 | 判定 |
|---|---|---|---|
| `toolCard.test.ts:166` | `lets a permission block break the tool group` | `['toolGroup','permission']`；块为 `{id:'p1',type:'permission_request',toolName:'Bash'}`，**无 `resolved`、无 `permissionId`** | **不受影响**（未决+配不上→回落原路） |
| `chatTurn.test.ts:187` | `F-B2: an unresolved permission stays in the process segment (block order, not promoted)` | 未决 permission 留 process 段 | **不受影响** |
| `chatTurn.test.ts:264` | `F-B4: an unanswered permission_request is unresolved` | `hasUnresolvedPermission` 语义 | **不受影响** |
| `chatTurn.test.ts:273` | `F-B4: a turn with no permission block at all is false` | 同上 | **不受影响** |
| `chatSessionsCore.test.ts:534` | `appends a permission_request block even when a tool_call block already shares its id` | 两块并存 + id 同值 | **不受影响**，且是本片**地基测试，必须保留** |
| `questionCardModel.test.ts` | 93 例，含 `derivePermissionRowView` 组 | 行视图形状 | **部分退役换新**（该函数改产徽记）—— 具体条目**未盘，缺口** |
| `questionCardWiring.test.ts` | 4 例 | 未盘 | **缺口** |

**现有测试与「只合并已决」裁定天然兼容** —— 切片可行性的关键信号：钉住 permission 独立成行的用例，
钉的都是**未决**态。

---

## 4. 裁定 A~F

### A. 关联键 —— ①与②并存，按 agent 分轨

- **Claude：①协议层已有可用 id，零协议改动。** join 键 = `permission_request.block.id === tool_call.block.id`
- **Codex：②id 存在但未透传，建议做透传**（3 处）而非启发式。理由：`itemId` 是协议必填，透传是确定性的；
  且 Codex 的 `permission.requested` 里 `toolName` 是合成常量、**没有 `input`**，可供启发式配对的信息极度贫乏。

**不走③启发式**。①②既成立，引入模糊配对是自找风险。

### B. 配对算法与安全回落

```
对每个 permission_request block P：
  若 P.resolved !== true          → 不合并（保持 QA 整卡，用户要能点）
  否则 找同 message 内 tool_call block T 使 T.id === P.id
    找到  → 折进 T 的行；P 不产生独立 item、不 flush
    找不到 → 完全按现状产生独立 permission item（字节不变）
```

**必须回落的实证场景（非推测）**：T-34 下 subagent 的工具调用被转成 `subagent.activity`
（`eventNormalizer.ts:822-830`），**主时间线不存在对应 tool_call block**，而该 subagent 的 permission
仍走主时间线 store。join 必然落空 → 必须回落，否则**授权记录直接消失**。

**N:1（Codex zsh-exec-bridge）**：行上按到达顺序渲染多个徽记；超过 2 个折叠为 `N 项授权 ▾`，
明细进该行可展开体。**绝不静默丢弃第 2 个及以后的决议。**

**「同一回合内两次相同命令」不构成冲突**：join 键是 `tool_use.id`，两次调用是两个不同 id、两个 block、
两行。这正是不走启发式的收益 —— 按「工具名+命令串」配对才会在此翻车。

**跨 message 风险**：`permission.requested` handler(`chatSessions.ts:747-754`) 取「bucket 里最后一个
非 history 的 assistant message」，而 `tool.started`(:704) 用 `payload.messageId` 精确定位。二者通常同一
message 但**不保证**。建议 join 先在同 message 内找，找不到即回落（不要跨 message 找，会引入错配）。

### C. Denied 形态

**有实读证据**：

- 被拒的调用**仍有 `Ran X` 行**，且**先于**授权行出现（证据 C）。`tool.started` 由 assistant 消息的
  `tool_use` block 触发（`eventNormalizer.ts:1143-1147`），发生在 SDK 回调 `canUseTool` 之前。
- 已决拒绝行现状：verb=`Denied`/`Denied, turn stopped`，`failed: block.allowed === false`
  (`questionCardModel.ts:723`) → `ToolRows.tsx:77` 整行 `text-destructive`。

**⚠️ 效力状态**：D28 的「Denied 复用工具行 failed/destructive 色语义（不发明新状态色）」在
`ledger.md:72` 原文里标注为**「编排者代拍，待追认」**，**不是用户拍板**。合并会重新暴露这个视觉决策 ——
建议顺路补追认，不要默认它已生效。

**【推测 · 未证实】**：拒绝后 SDK 是否回灌 `tool_result(is_error)` 从而产生 `tool.completed`、把 run 从
`running` 推到 `failed`。仓库内无直接证据（`claudeRuntime.ts` 无相关断言，smoke spike 无 deny 场景）。

**风险**：若 deny 后无 `tool.completed`，合并行会**永远停在 running 态却显示 Denied**，自相矛盾。

**验证方法**：`spikes/phase2-permission-smoke.ts` 加 `allow:false` 分支记录后续是否出现
`tool.completed(ok:false)`；或 `claudeRuntimePermission.test.ts` 假流复现。**列为 GUI 点验必查项 + 开放问题。**

### D. D28「决议单行」语义保留

`ledger.md:72` D28 原文：

> **已决 Permission 从 QA 整卡收敛为工具行单行**（Allowed/Denied + 描述，复用 ToolRow）。依据：用户现场
> 反馈原话「选择后不需要保留，或者跟tool调用一样显示」

**原始意图是「已决态不该继续占据消息流」，"单行"是当时能想到的最小形态，不是目的本身。**
FB7 证明单行仍在铺屏 —— 合并是 D28 意图的**贯彻而非推翻**。

**等价表达**：已决 Permission 不再占据任何独立行，收敛为所属工具行上的授权徽记；未决 Permission 仍为
可答 QA 整卡。分界线仍是 `resolved`，与 `derivePermissionRowView:711` 现有守卫完全一致 —— 这也是现有
测试不必大改的原因。

D28 同时收窄了 D20：「D20『保留就地冻结』范围收窄为仅 Question 卡」，故本片不触 Question。

### E. 合并行信息形态与截断纪律

**槽位**（左→右）：`verb(shrink-0)` + `arg(min-w-0 flex-1 truncate)` + **`授权徽记(shrink-0)`** + 展开箭头

1. **徽记必须是灰阶纯文本** —— `ledger.md:68` D24 原文「动词开头、**无图标、无边框**的灰阶单行」，
   `ledger.md:75` D31 复核「工具行**维持 Cursor 口径**（D24 不动）」。做成图标 / 彩色 chip / 带背景标签
   = 直接回滚 D24。三级灰（`--foreground` ＞ 动词 `--muted-foreground` ＞ 参数 `--tool-arg`）中徽记落
   **动词档或参数档**，具体档位 GUI 点验定。
2. **徽记 `shrink-0` 不参与截断** —— 授权决议是安全语义，绝不能被 truncate 吃掉。让位顺序照
   `design-system.md:572` 既有纪律（可截断者让位，闭集标签不动）。
3. **只承载决议动词**（四档）。permission 的 `description`/`prompt` 与工具行 `arg` 高度重复（同一个命令）
   —— **删重复，保决议**。
4. **`auto:` provenance 不得丢**，跟在徽记后（`questionCardModel.ts:409-414` 存在理由：区分 drain 与真人拒绝）。
5. **色**：Denied 时徽记取 destructive；整行是否转 destructive 取决于裁定 C 的验证结果（若 deny 后 run
   真 failed，整行本就 destructive，无需额外处理）。
6. 零自造值，圆角/字号/字重/动画时长走 design-system Token 分档。

**必须 GUI 点验**（本仓有「布局缺陷只在截图里显形」既往教训，不可省）：

- 长命令 + 徽记同行的截断表现（`design-system.md:731` ③「工具行中文动词 + 拉丁路径同行」是既有 CJK 混排点验项）
- 窄栏（默认宽）下徽记是否被挤掉
- Denied 行色语义（并顺带追认 D28 代拍条）
- **合并后聚合行 `Explored N files…` 是否真的恢复连续**
- N:1 多徽记的折叠态
- **deny 后合并行的终态是否自洽**（裁定 C 的未证实项）

### F. 切片规模 —— 可单片完成，建议不再拆

| 文件 | 改动 | 量 |
|---|---|---|
| `toolCard.ts` | `pairToolBlocks` 配 permission；`ToolRun`/`ToolRowView` 加字段；`groupTimeline:164-167` 加分支 | 中 |
| `questionCardModel.ts` | `derivePermissionRowView` 改产徽记；保留独立行分支供回落 | 中 |
| `QuestionCard.tsx` | `:525-529` 已决分支调整 | 小 |
| `ToolRows.tsx` | 徽记槽位 | 小 |
| `MessageTimeline.tsx` | `case 'permission'` 保留（回落 + 未决） | 极小 |
| `runtimeEvents.ts` + `codexRuntime.ts` + `chatSessions.ts` | Codex `itemId` 透传 | 小，3 处 |

**预估新增断言 45~60**：纯模块（配对/回落/N:1/未决不合并/auto note 保留/跨 message 不错配）35~45，
Codex 透传 6~10，静态不变量（截断类串、灰阶无图标）4~6。退役换新 5~8。

**不建议再拆**：join 键、回落规则、渲染槽三者强耦合，拆开会产生「配上了但没地方画」或「画了但配不上」
的中间态。

**但 Codex 透传可作独立前置小片先落** —— 它自成闭环，且能让主片一次覆盖两个 agent。

---

## 5. 开放问题

1. **【须在真机验】deny 后 run 是否 settle**（裁定 C）—— 唯一能推翻布局设计的未知量。
2. **Codex `itemId` 透传是否本片做**：做 → 两 agent 一致，+3 处；不做 → Codex 侧永远回落成独立行
   （不违红线，但 FB7 在 Codex 上不算修好）。建议做。**待拍板。**
3. **Denied 色彩语义是否借这次补追认**（D28 代拍条，至今未经用户确认）。**待拍板。**
4. **subagent permission 的归属**：主时间线无对应 tool 行，永远回落。是否改挂 subagent 活动面板？
   **超出 FB7，建议另立。**
5. **N:1 折叠阈值**（≤2 平铺 / >2 折叠）无先例，编排者拟定，**待追认**。
6. `chatTurn.ts` 未直读，施工前需确认分组接线。

## 6. 空壳风险自查

| 风险 | 判定 | 依据 |
|---|---|---|
| `toolUseID` 类型必填但运行时不填（**本片最大风险**） | ❌ 不存在 | 三条运行时实证：真实 P0 事故 + 回归测试 + 顺序注释。**事故是最强证据——只有真相等才会触发那个 bug** |
| Codex `itemId` 声明了却不发 | ❌ 不存在 | codex 二进制自生成 schema 的 `required`；且 `codexRuntime.ts:2452` 已在实际读取 |
| `ChatBlock.toolCallId` 在 permission block 上从不填 | ⚠️ **确认为真**（类型有、从不写） | `chatSessions.ts:786-801` 写入清单无此键。是**可利用的空位**而非缺陷；填它需注意 `pairToolBlocks:61` 已按 type 过滤，不污染 |
| `permission.requested.agentId` 到 block 的链**断裂** | ⚠️ **确认为真** | 协议有(`runtimeEvents.ts:396`)、bridge 发(`permissionBridge.ts:201`)、store **不写进 block**。实际走 `subagentActivity` 旁路(`QuestionCard.tsx:514-516`)且 resolved 即删 → **恒空**。D28 原文亦自陈「几乎恒空，非回归」。**别为它写会永假的断言** |
| `derivePermissionRowView` 同名空壳 | ❌ 不存在 | `QuestionCard.tsx:526` 唯一且真实调用点，`:528` 渲染 `<ToolRow>` |
| 「permission 行是独立组件」的硬编码信念 | ❌ **该信念是错的，已纠正** | 它本就是 `ToolRow`(`QuestionCard.tsx:528`)。合并是「少生一行」，不是「造新行」 |

验证方法均为**找写入点**，非只读类型声明。

---

## 7. 与上游台账的对账（建议回写）

D53②（`ledger.md:97`）与 triage:18 都把「打通 permissionId↔toolCallId」当作待解难题。实况是
**Claude 路径本就相等**，且已被一次 P0 事故与一条回归测试双重锚定；真正需要打通的只有 Codex 的
`itemId` 透传（3 处）。

这消掉了 L 档的大半不确定性，也解释了分诊所说的「无纯模块做过」—— 因为不需要模糊配对模块，
只需一次 join + 一条回落。
