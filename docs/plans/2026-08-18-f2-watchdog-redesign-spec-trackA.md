# F2 超时看门狗体系重设计 — 施工规格 **A 轨盲稿**（rev.0-A）

> 来源批次：`docs/plans/2026-08-17-d48-t10-inspection-triage.md` §F2（六缺陷 + 修法方向 A~H）。
> 本稿为双轨双盲评审的 **A 轨**，独立成稿，未参考 B 轨。只写文档，未改任何生产代码。
> 基线 commit：`a94b9a4`（快修批已落：`formatRuntimeEvent` 打 role、红卡文案中性化）。
> 标注约定：【实测】= 本次亲自读码/跑命令核对；【推测】= 未验证的推断；【与分诊冲突】= 分诊表述与代码不符。

## 目录

- §0 取证核对结论（分诊逐条复核 + 五项新发现）
- §1 分工形态裁定：Host 双狗 + 渲染端沉默天花板（INVARIANT 反转）
- §2 活性谓词：`classifyTurnLiveness` 与 Host `PRODUCTIVE_EVENT_TYPES` 冻结
- §3 TTFT 证据门重设计与 R9 洞的处置
- §4 渲染端到期动作重构：`'pending'` 出路与待回watch
- §5 restore-draft 收窄与文本找回
- §6 确定死亡判据清单
- §7 Codex 轴：补同款双狗
- §8 文案与展示（SLOW_WAIT 死文案审读）
- §9 切片、门禁、flag 判断
- §10 影响面清单 / 测试合同变更 / 断言与变异计划 / open questions

---

## §0 取证核对结论

### 0.1 三句话

1. 现行三表体系的根本错误不是「阈值太小」，而是 **裁决权放错了地方**：渲染端拿一个纯挂钟猜测去写「回合失败」，而唯一看得见 `api_retry` / stderr / 子进程退出、唯一能诚实 abort 的 Host 反而被要求「让渲染端先说话」（`attachmentLimits.ts:191-202` 的 INVARIANT 明文如此）。
2. 本批把不变量 **反转**：Host 的两只狗（TTFT 32s 证据门、stall 195s 滚动）是唯一裁决者，渲染端只保留一个 **沉默天花板**（300s，被任意活性帧复位）+ 一个 **绝对上限**（30min），到期后 **不写 lastError、不 unbindHost、不回显草稿、不装 Retry**，只把回合头交给「仍在运行」态。
3. 反转之后，代码自注的 **R9 洞自动闭合**——`system/init` 后永久静默的形态本来就落给 195s stall 狗，而 195s < 300s 意味着 Host 的诚实失败现在**先于**渲染端的沉默天花板到达；R9 需要的不是「第三个证据信号」，而正是这次反转。

### 0.2 分诊六缺陷逐条复核

| # | 分诊结论 | 复核 | 证据 |
|---|---|---|---|
| 1 | 45s 预算不看活性，唯一复位条件是 `classifyAssistantProgress === 'assistant'` | **部分不成立，更严重**【与分诊冲突】 | `ChatComposer.tsx:260-271` `waitUntil` 是**固定截止时间**（`Date.now()-start < timeoutMs`），`predicate` 只决定是否提前 release，**根本没有任何复位机制**。分诊说「唯一复位条件」，实际是「零复位条件」。修法方向不变，但事实要写准 |
| 2 | 「停止等待」与「回合失败」混淆 | **成立** | `ChatComposer.tsx:1757` `unbindHost()` → `:1832` `lastError` → `:1806-1810` `decideRunEntryOutcome({fatalHostError:true,…})` → `'committed'` → `queueRelease.ts:250-256` `'restore-draft'` |
| 3 | 回显草稿不随迟到回复清理 | **成立** | `ChatComposer.tsx:1938-1955` `clearAbandonMarkerIfMatch` 只清 `lastError` 与 `retryable`，不碰 `updateValue` / `attachments` |
| 4 | 红卡文案指向不存在的按钮 | **已修**（快修批） | `MessageTimeline.tsx:534-541` 现为中性中文「已产内容保留。可从下方输入框重发上条消息。」；本批不再处理，但见 0.3-⑤ |
| 5 | TTFT R9 洞 | **成立，但定性要改** | `claudeRuntime.ts:755-773`。该形态确实永久 rearm，但 **并非「Host 全线失守」**：195s stall 狗仍会开火（`:679-706` 的 `onStall` 不被 `system` 事件复位，因为 `PRODUCTIVE_EVENT_TYPES`（`:794-800`）不含 `system`）。分诊「Host 全线失守」是过度描述——失守的是「Host 先于渲染端说话」这条不变量，不是 Host 本身 |
| 6 | Codex 轴无 Host 看门狗，仅 30 分钟 RPC ack | **成立** | `codexRuntime.ts:371-381` `CODEX_TURN_START_TIMEOUT_MS = 30 * 60_000`；全文无 stall/TTFT 计时器 |

### 0.3 五项新发现（分诊未列）

- **① Host 进程退出对渲染端完全静默**【实测】：`AgentHostManager.ts:472-496` 的 `exit` 处理只写 `this.state='stopped'` 与日志，**不发任何 RuntimeEvent**；`proc.on('error')`（`:462-470`）同理。Host 崩溃/被杀时，渲染端会话状态永久停在 `'running'`，没有任何终态。**这是「确定死亡」判据清单里最大的一个洞**（详见 §6）。
- **② 三处 stall 常量文档镜像陈旧**【实测】：常量是 `195_000`（`claudeRuntime.ts:95`），但 `claudeRuntime.ts:107-108`、`claudeRuntime.ts:758-761`、`ttftWatchdog.ts:9-10` 三处注释都写 `120s`。本批必须一并订正，否则新注释与旧注释互相打架。
- **③ 渲染端 Host 常量镜像没有任何锁**【实测】：`attachmentLimits.ts:176-188` 自称「locked by a unit test」，但 `attachmentLimits.test.ts` 全文只做 **镜像之间的数值比较**（`:248-261`），没有任何一处读 `claudeRuntime.ts` 的真值。镜像可以静默漂移。本批补 **源文扫描镜像锁**（同 `composerStopStatic.test.ts` 的静态断言工法）。
- **④ 到期后回合头会「失表」**【实测】：`MessageTimeline.tsx:935-946` 的 `turnActive = inFlight || streamStartedAt != null`，其中 `inFlight` 需要 `sendStatus != null`（`runSend` 的 `finally` 在 `:1865` 调 `endTurnSend` 清掉），`streamStartedAt` 需要存在 `firstAssistant`（admitted-but-no-reply 回合没有）。所以 **到期那一刻回合头的状态行直接消失**，用户只剩红横幅——这解释了为什么现场体感是「报错 + 什么都没有了」。§4 的「still running · Ns」必须解决这个失表问题，不能只改分支逻辑。
- **⑤ 红卡文案是中文，周边 UI 全英文**【实测】：`MessageTimeline.tsx:540`。快修批引入的语言不一致，记为 F4 批移交项，本批不动。

### 0.4 承重事实（本批所有裁定的地基）

| 事实 | 证据 | 用途 |
|---|---|---|
| `session.status(running)` 每回合只发一次 | `claudeRuntime.ts:642-647`，全文无第二处 running 发射 | Host 侧目前**没有任何心跳**；§3 的 liveness note 是第一个 |
| 用户回声由 `normalizer.beginTurn` 在 `queryFn` 之前发出 | `claudeRuntime.ts:640` 在 `:831` 之前 | 附件字节与「首帧到达时间」无关 → §1 判定字节缩放预算作废 |
| `stream_event` 属 productive，`system` 不属 | `claudeRuntime.ts:794-800` | `claudeRuntimePartialStall.test.ts:126-133` 明确钉住「只有控制面事件的同长区间**必须** stall」→ §2 判定 Host 侧词表**冻结** |
| `classifyAssistantProgress` 正确忽略 `role:'user'` 三连 | `assistantProgress.ts:283-291`（`role==='assistant'` 才算） | 分诊「不许放宽」成立；§2 用**新函数**而非扩宽返回联合 |
| `RunEntryOutcome` 的消费点共 5 处 | `queueRelease.ts:181/226/250/285/352` + `useQueueRelease.ts:79-83` + `ChatComposer.tsx:564` | §4 加 `'pending'` 成员后 TypeScript 会逐点报错，正是想要的「强制逐点复审」 |

---

## §1 分工形态裁定：Host 双狗 + 渲染端沉默天花板

### 1.1 裁定

**采纳分诊方向 F，并给出比分诊更强的形式。** 分工三句话：

1. **Host 是唯一裁决者**。Claude 轴保留两只狗（TTFT 32s 证据门 / stall 195s 滚动），Codex 轴补齐同款（§7）。只有它们能发 `session.failed`，只有它们能 `abort()`。
2. **渲染端不再有「判死」权**，只保留两个**流控**上限：`SEND_SILENCE_CEILING_MS = 300_000`（沉默天花板，被任意活性帧复位）与 `SEND_ABSOLUTE_CEILING_MS = 1_800_000`（绝对上限，防活性帧无限保活）。到期只表示「渲染端不再持有 in-flight 闩」，**不表示回合死亡**。
3. **反转后的不变量是一条有序链**，不是两条互不相干的比较：

```
HOST_TTFT_TIMEOUT_MS (32s)
  < HOST_STALL_TIMEOUT_MS (195s)
    < SEND_SILENCE_CEILING_MS (300s)
      <= SEND_ABSOLUTE_CEILING_MS (30min)
```

理由（三条，每条都能独立证伪现行形态）：

- **信息不对称**【实测】：`api_retry`（`claudeRuntime.ts:949-951`）、`[cli-stderr]`（`:864-867`）、子进程抛错（`:1021-1075`）三类证据只存在于 Host 进程内；渲染端拿到的是被 normalizer 过滤后的投影。让信息少的一方先裁决，结构性地保证了裁决质量更差。
- **动作不对称**【实测】：渲染端到期时**故意不 stop**（`ChatComposer.tsx:1757-1768` 明文写了 a5 回退的理由），所以它的「失败」判决没有任何执行力——回合照跑，只是 UI 撒谎。Host 的 `abort()` 是真停。一个不能执行判决的角色不该拥有判决权。
- **复位不对称**（这条是反转能成立的关键）：Host 的 stall 表被 productive 事件复位，渲染端的沉默表被 **liveness 帧**复位，而 liveness ⊋ progress（§2 会把这条做成可断言的包含关系）。因此**渲染端的表复位得不比 Host 慢**，195s < 300s 这条数值不变量才是真的、而不是碰巧的。

### 1.2 `attachmentLimits.ts` 的处置：拆文件，不是改注释

现行 `attachmentLimits.ts` 的文件头（`:1-12`）自述存在理由是「限额检查与超时公式不能漂移，所以放一个文件」。本批把**字节缩放的等待预算整体作废**（理由见 1.3），那条存在理由随之消失。

**裁定**：新建 `src/renderer/components/chat/sendBudgets.ts`，迁入并重写超时半边；`attachmentLimits.ts` 只留附件限额半边。

- 迁出：`SEND_BASE_TIMEOUT_MS`、`SEND_MS_PER_MB`、`SEND_TIMEOUT_CEILING_MS`、`sendTimeoutMs`、`HOST_STALL_TIMEOUT_MS`、`HOST_TTFT_TIMEOUT_MS`、INVARIANT 注记块（`:165-210`）。
- 新形态（`sendBudgets.ts` 导出）：`SEND_SILENCE_CEILING_MS`、`SEND_ABSOLUTE_CEILING_MS`、`HOST_STALL_TIMEOUT_MS`（镜像）、`HOST_TTFT_TIMEOUT_MS`（镜像）、`createSendWaitBudget()`、反转后的 INVARIANT 注记块。
- 作废（不重编号、不保留兼容别名）：`SEND_BASE_TIMEOUT_MS` / `SEND_MS_PER_MB` / `SEND_TIMEOUT_CEILING_MS` / `sendTimeoutMs`。
- 保守回退位：若评审否决拆文件，全部新符号原地留在 `attachmentLimits.ts` 亦可，**其余裁定不受影响**（拆文件是可读性选择，不承重）。

### 1.3 为什么字节缩放预算必须作废，而不是「把 45s 换成 300s」

【实测】`normalizer.beginTurn`（`claudeRuntime.ts:640`）在 `queryFn`（`:831`）**之前**执行，用户回声因此在回合受理的那一刻就发出，与附件字节数无关；而 `sendTimeoutMs` 的整套 30s/MB 缩放（`attachmentLimits.ts:206-210`）建立在「大附件让**首个回应**更晚」这个假设上。改成**沉默预算**之后，第一帧（回声）恒在 t≈0 到达并立即复位沉默表，字节缩放对沉默表**恒等于零作用**。保留它只会让 `(up to Ns)` 显示一个与任何真实行为都无关的数字。

因此 `attachmentLimits.test.ts` 的 `[T-01]`~`[T-05]` 是在钉一个**已经不存在的模型**，按「不重编号」原则整组退役（逐例理由见 §10.2），`[T-06]`/`[a4]` 反转重写。

### 1.4 `middleColumnLayout.ts` 的文档镜像

【实测】`middleColumnLayout.ts:607-611` 只是散文里引用了一句样例文案 `"Waiting for Agent Host reply · 12s (up to 45s)"`，不是常量镜像。本批把样例中的 `45s` 改为 `300s`，属注释同步，无测试影响。

---

## §2 活性谓词：新函数 `classifyTurnLiveness`，Host 词表冻结

### 2.1 裁定：新增独立函数，**不**扩宽 `AssistantProgressSignal`

分诊方向 B 写的是「`assistantProgress.ts` 增设第三信号 `'liveness'`」。**本稿改判为：同文件新增一个独立导出函数，返回自己的联合，`AssistantProgressSignal` 保持 `'assistant' | 'ignore'` 两值不变。**

理由：

- `classifyAssistantProgress` 现在**唯一**的消费方式是 `=== 'assistant'`（`ChatComposer.tsx:1242`）。给它加第三个成员，等于在类型上邀请后来者写 `!== 'ignore'`——那正好把 liveness 误当 progress，也就是分诊明令禁止的「放宽谓词让 `message.delta` 算进度」的复活路径。两值联合关不上这个门，两个函数能。
- 两个函数各有独立测试面，而「用户回声是 liveness 但**不是** progress」这条负向不变量，只有在两个函数并排时才写得出来（见 §10.3 的 `[L-2]`）。
- 落点仍在 `assistantProgress.ts`（不新建文件）：这个模块已经是「wire 谓词唯一之家」，`isUserEchoForSend` / `isSessionFailedForSend` 等同族谓词都在此；把正反两条断言放进同一个测试文件才形成咬合。

```ts
export type TurnLivenessSignal = 'liveness' | 'ignore';
export function classifyTurnLiveness(event: ProgressEvent, sessionId: string): TurnLivenessSignal;
```

### 2.2 渲染端 liveness 词表（逐条给理由）

| 事件类型 | liveness？ | 理由 |
|---|---|---|
| `message.started` / `delta` / `completed`（**任意 role**） | ✅ | Host 正在为**本会话**写字；user role 三连是「回合已受理」的证据，是活性，但依 §2.1 **不是** progress |
| `thinking.*` / `tool.*` / `permission.requested` / `question.requested` | ✅ | 已是 progress，liveness 按包含关系必然成立 |
| `session.status`（**任意 status，含 retry / 含新 liveness note**） | ✅ | Host 进程活着且在谈论本会话。含 `retry` 时尤其重要：那是「CLI 正在重试」而非「卡死」 |
| `session.stderr` | ✅ | CLI 子进程活着并在输出（`claudeRuntime.ts:812-827`） |
| `usage.updated` | ✅ | D33 interim token tick，模型正在产出 |
| `subagent.activity` | ✅ | 子代理在跑；主流可以长时间无帧（T-34 分流的直接后果） |
| `session.created` / `resumed` / `updated` / `settingsEcho` / `permissionUpdated` | ✅ | 握手期与中途改档的帧，证明 Host 在响应 |
| `session.history` / `historyListed` | ❌ | 回放/列表，与本回合无关 |
| `host.error` | ❌ | 是裁决不是活性；它有自己的通道（`fatalHostError`） |
| `session.completed` / `failed` / `stopped` | ❌ | 终态，结束等待而非延长等待 |
| `permission.resolved` / `question.resolved` | ✅ | 用户答完，回合应当继续；不给活性会让「答完后模型思考很久」被误判 |

**会话作用域**：所有判定先过 `event.sessionId === sessionId`；无 sessionId 的事件（仅 `host.error` 的 `session_not_found` 一例）恒为 `'ignore'`。

### 2.3 `api_retry` 无限保活的封顶（两道，分属两端）

- **Host 侧（承重）**：`api_retry` 走 `system` 事件，**不在** `PRODUCTIVE_EVENT_TYPES` 内，所以它**不复位 stall 表**——195s 后 Host 自己开火，这是既有且正确的行为，`claudeRuntimePartialStall.test.ts:126-133` 已钉死。这就是真正的封顶。
- **渲染端（兜底）**：`session.status(retry)` **算** liveness（会复位 300s 沉默表），所以渲染端确实可能被无限保活——`SEND_ABSOLUTE_CEILING_MS = 1_800_000` 是这条路径唯一的封顶。它只在「Host 的狗被 env 关掉（`0` disables）」或「Codex 轴未装狗」时才可能触发，属于兜底而非主路。取 30min 是刻意对齐 `CODEX_TURN_START_TIMEOUT_MS`（`codexRuntime.ts:381`），让分诊缺陷 6 说的「40 倍哲学错配」在数值上收敛为 1:1。

### 2.4 Host 侧 `PRODUCTIVE_EVENT_TYPES` **冻结**，并补静态断言

【实测】现集合为 `assistant | user | result | tool_progress | stream_event`（`claudeRuntime.ts:794-800`）。

**裁定：一个成员都不加。** 分诊问「是否同步扩」，答案是明确的否：

- 加 `system` 会直接摧毁 C-14 检测器（无效模型 → 无穷 `api_retry` 流），`claudeRuntimePartialStall.test.ts:126-133` 会红，而那条红是**对的**。
- Host 的 stall 表语义是「模型有没有在产出」，渲染端的沉默表语义是「Host 有没有在说话」。两者**故意不同**，同步扩会把它们合并成同一个更弱的谓词。
- 两端语义不同但方向一致（liveness ⊇ progress 的投影），正是 §1.1 第三条不对称成立的原因。

补一条静态断言：把该集合导出为 `export const PRODUCTIVE_EVENT_TYPES`，测试断言其成员**恰为**这五个（`toEqual(new Set([...]))`），任何增删都红。

---

## §3 TTFT 证据门重设计与 R9 洞的处置

### 3.1 R9 洞：**由不变量反转闭合，不加第三个证据信号**

【实测】`claudeRuntime.ts:755-773` 自注的 R9 形态是：`system/init` 到达（`sawAnySdkEvent = true`）→ 此后永久静默 → 无 `api_retry` → 证据门 `!(sawApiRetry || !sawAnySdkEvent)` 恒为真 → 无限 `rearm()`。

关键复核：**这个形态并没有「无人接管」**。`onStall`（`:679-706`）的复位只来自 `PRODUCTIVE_EVENT_TYPES`（`:952-955`），`system/init` 不在其中，所以 stall 计时器从 `armStallTimer()`（`:912`）起算，195s 后必然开火 → `stalled = true` → `abort()` → `session.failed`。代码自注写的「left entirely to the much longer stall watchdog」是准确的；**唯一的问题是那时渲染端已经在 45s 撒过谎了**。

因此：

- **R9 的「future work」由本批的不变量反转直接兑现**——195s < 300s 之后，Host 的诚实失败先到，渲染端不再有机会先说话。
- **明确拒绝**再加一个证据信号。可选项都不合格：对 stderr 做子串嗅探（auth failed / ENOENT / …）是本仓已经栽过的坑（`ChatComposer.tsx:1786-1794` 的 F12 注记，明文记录了子串嗅探误命中看门狗自己的失败文案）；「init 到了但只有 system 事件且超时」就是 stall 表本身，再实现一遍是重复。
- `claudeRuntime.ts:755-766` 的 R9 注记块**改写**为「本形态刻意交给 stall 表；渲染端沉默天花板高于 stall 预算，故 Host 恒先说话」，并删掉 `120s` 的陈旧数值（新发现②）。

### 3.2 证据门本身的两处改动

**改动 A（收紧，防误杀）：`api_retry` 单次不再构成 abort 证据。**

【实测】现行 `:767-773` 只要 `sawApiRetry` 为真就开火。SDK 自带 `max_retries: 10` 的指数退避（`runtimeEvents.ts:144-153` 记录了这个契约），第 1 次 529 重试在 32s 窗口撞上就把一个**本来会在第 2 次成功**的回合杀掉，而 Retry 会把同一条 prompt 再推进同一个超时——这正是 `:713-725` 的 F1 注记想避免、却没避干净的确定性失败环。

新形态：记 `apiRetryCount`（`system/api_retry` 每到一次 +1），证据成立条件改为

```
apiRetryCount >= TTFT_API_RETRY_ABORT_ATTEMPTS   // 默认 3
  || !sawAnySdkEvent                              // 总静默（死 spawn / auth 失败尚未抛出）
```

`TTFT_API_RETRY_ABORT_ATTEMPTS` 默认 `3`，env `AICLIENT_HOST_TTFT_RETRY_ATTEMPTS` 可调，`<= 0` 视为「不以重试次数为证据」。未达阈值仍走 `rearm()`；即使一路不达阈值，195s stall 表仍会兜底（`api_retry` 不复位它）。

**改动 B（补齐，防静默）：证据不足时发一帧「活性说明」，不再一声不吭。**

现行 `rearm()` 分支对渲染端**完全不可见**，Host 的看门狗审议过程没有任何 trace（违反工程规范 #2「每次运行发结构化 trace」）。新增一个**加法字段**，`AGENT_HOST_PROTOCOL_VERSION` 保持 `1`。

### 3.3 协议加法：`SessionStatusEvent.payload.liveness`

**形状裁定：骑在 `session.status` 上做可选字段，不新建事件类型。** 直接沿用 `SessionRetryInfo` 的先例，其头注（`runtimeEvents.ts:130-142`）已把理由写死：既有的 `session.status` 消费方（`chatSessions.ts` reducer、Composer 事件日志）零改动就能收到，而 status 合法地仍是 `'running'`——回合没停，狗只是看了一眼。

```ts
/**
 * F2 (2026-08-18 watchdog redesign): one Host watchdog window elapsed and the
 * watchdog DECLINED to abort. Status stays 'running' — the turn is alive.
 * Optional-field addition; AGENT_HOST_PROTOCOL_VERSION unchanged (same
 * precedent as SessionRetryInfo above and MessageStartedEvent.model).
 */
export interface SessionLivenessNote {
  /** Which watchdog spoke. */
  source: 'ttft' | 'stall';
  /** The budget that elapsed with no qualifying progress, ms. */
  budgetMs: number;
  /** Why it declined to abort — never a guess, always the branch that ran. */
  reason: 'awaiting_user' | 'tool_running' | 'insufficient_evidence';
  /** `system/api_retry` frames observed this turn so far. */
  retryCount: number;
}
// SessionStatusEvent.payload: { status; retry?; liveness?: SessionLivenessNote }
```

三个 `reason` 与代码分支**一一对应**，不是事后归类：`awaiting_user` ← `permissions.hasPending || questions.hasPending`（`:747-750`）；`tool_running` ← `normalizer.hasOpenTools()`（同处，拆开判定）；`insufficient_evidence` ← `:767` 的证据门未过。

**消费方（本批必须同时落，否则是「生产者缺席消费者」空壳）**：

1. `classifyTurnLiveness` 把 `session.status` 记为 liveness（§2.2 已含），于是这帧成为渲染端沉默表的**真心跳**——现行 Host 每回合只发一次 `session.status`（承重事实表），没有这帧，300s 沉默表在一个「停在权限卡上等用户」的回合上会误到期。
2. `formatRuntimeEvent`（`ChatComposer.tsx:151-187`）打印它，进 `rawEvents=[…]` 诊断串（延续快修批 F2-g 的诊断诚实方向）。

**flag**：`AICLIENT_HOST_LIVENESS_NOTE`，默认 on，`'0'` 为 QUIET 位（停发该帧，不改判决逻辑）。形态逐字对齐 `resolveSubagentActivityEnabled`（`claudeRuntime.ts:150-154`）——off 位「停止为没人消费的流量付费」，而不是回退到旧判决。

### 3.4 「只凭证据 abort」的完整证据清单（含**不**走看门狗的路径）

| 证据 | 谁发现 | 走哪条路 |
|---|---|---|
| 子进程退出 / spawn 失败 / auth 失败抛出 | SDK 迭代器抛错 | `claudeRuntime.ts:1021-1075` catch → `session.failed`。**不经看门狗**，本来就是最快最准的路径 |
| 流自然结束但无 `result` | 主循环退出 | `:1002-1020` `finishTurn` 合成终态 |
| 总静默（连 `system/init` 都没有） | TTFT 狗 | `!sawAnySdkEvent` → abort |
| `api_retry` 累计 ≥ 3 | TTFT 狗 | 改动 A |
| 195s 无 productive 事件 | stall 狗 | 既有，不改 |
| 停在权限/问题/工具上 | 两只狗的守卫 | `rearm()` + 发 liveness note（改动 B） |
| **Host 进程整体退出** | **无人** | **§6 的洞，本批必须补** |

---

## §4 渲染端到期动作重构

### 4.1 等待循环：固定截止 → 可复位预算

【实测】`ChatComposer.tsx:260-271` 的 `waitUntil(predicate, timeoutMs)` 是固定截止，无复位口。改为**注入到期谓词**（三个调用点全在同一文件内，`:1371` / `:1440` / `:1538`）：

```ts
async function waitUntil(predicate: () => boolean, expired: () => boolean, stepMs = 50): Promise<boolean>
// 握手两处：waitUntil(pred, deadlineAt(5000))
// 主等待：  waitUntil(pred, () => budget.isExpired(Date.now()))
```

预算对象是**纯函数模块**（`sendBudgets.ts`，无定时器、无 store，node 环境可直测）：

```ts
export function createSendWaitBudget(startedAtMs: number, opts?: {
  silenceCeilingMs?: number; absoluteCeilingMs?: number;
}): {
  markLiveness(nowMs: number): void;
  isExpired(nowMs: number): boolean;
  lastLivenessAtMs(): number;
};
// isExpired(now) = now - lastLiveness >= silenceCeiling || now - startedAt >= absoluteCeiling
```

监听器里一行接线：`if (classifyTurnLiveness(event, sessionId) === 'liveness') budget.markLiveness(Date.now());`，紧邻既有的 `classifyAssistantProgress` 那行（`:1242`），两条并排即为「liveness 不等于 progress」的现场佐证。

### 4.2 到期分支一分为二

到期时按 `sawUserEcho` 分流，**不再统一走 `decideRunEntryOutcome({fatalHostError:true,…})` 这个善意的谎**（那里根本没有 fatal error）。新纯函数落在 `queueRelease.ts`：

```ts
/** 渲染端停止等待时的分类。与 fatal-error 分类彻底分开——这里没有错误。 */
export function decideAdmittedTimeoutOutcome(input: { sawUserEcho: boolean; sawAssistantProgress: boolean }):
  'pending' | 'rejected' {
  return input.sawUserEcho || input.sawAssistantProgress ? 'pending' : 'rejected';
}
```

- **`'rejected'`（无回声）**：Host 从未受理 → 这**是**真失败。既有处置**全部保留**：`unbindHost()`、`abandonError` 诊断串（含 `rawEvents=` / `hostAfter=` / `sawNetworkRetry` 分支提示，`:1795-1831`）、`finalizeOutcome` 装 Retry 或让队列复位。一个字都不改——它一直是对的，只是被无回声之外的场景蹭用了。
- **`'pending'`（有回声）**：新路径。**禁止四件事**：不 `unbindHost()`、不写 `lastError`、不构造 `abandonError`、不调 `restoreDraftIfComposerEmpty` / `setRetryable`。**做两件事**：`pendingReplyRef.current = { sessionId, committed, assistantCursor }`（组件内，承载「确定死亡后」的找回料）与 `armPendingReply({ sessionId, turnStartedAtMs })`（store，承载回合头）。

### 4.3 `RunEntryOutcome` 新增 `'pending'` 成员

语义：**Host 已受理本回合且回合仍在运行；渲染端只是不再等了。** 加成员是刻意的——TypeScript 会在 5 个消费点逐点报错，强制复审（承重事实表已列点位）。逐点裁定：

| 消费点 | 对 `'pending'` 的裁定 | 理由 |
|---|---|---|
| `shouldArmRetryable` (`queueRelease.ts:226`) | `false` | 已受理，一键重发即双发 |
| `decideFailureAffordance` (`:250`) | `'none'`（**承重**） | 猜测性超时不得回显输入。这一条就是用户裁定的落点 |
| `shouldPauseQueueOnRejection` (`:285`) | `false` | 队列条目已花掉，无重放环可防 |
| `shouldClearRetryableOnOutcome` (`:352`) | `false` | 'pending' 不证明任何事；且 `runSend` 入口 `:988` 已清过 |
| `useQueueRelease.ts:79-83` 回填判据 | **改写为** `if (!isAdmittedOutcome(result)) restoreHead(entry)` | 新增 `isAdmittedOutcome(o) = o==='committed' \|\| o==='pending'`。今日行为等价，但 `'pending'` 从此结构性地不会被回填重发 |
| `maybeApplyFirstMessageTitle` (`ChatComposer.tsx:564`) | 改用 `isAdmittedOutcome` | 首条消息超时也已进 CLI transcript，标题该照常生成 |

### 4.4 回合头「still running · Ns」：解决新发现④的失表

**不新增 `TurnStatusKind`。** `turnStatus.ts` 已有的 `slow` 分支（`:118`）产出的正是目标文案：`Still waiting · 62s — gateway latency varies. Stop to abort.`（`attachments.ts:351-353`）。缺的只是「到期后回合头还活着」。

`MessageTimeline.tsx:935-946` 三行改动：

```ts
const pendingReply = useTurnSendStatusStore(s =>
  s.pendingReply && s.pendingReply.sessionId === sessionId ? s.pendingReply : null);
const pendingActive = isLastTurn && pendingReply != null;
const turnActive = inFlight || streamStartedAt != null || pendingActive;   // ← 加第三项
const elapsedSeconds = inFlight && sendStatus ? sendStatus.elapsedSeconds
  : streamStartedAt != null ? Math.max(0, Math.floor((nowMs - streamStartedAt) / 1000))
  : pendingActive ? Math.max(0, Math.floor((nowMs - pendingReply.turnStartedAtMs) / 1000))
  : 0;
```

三处配套【实测】：

- 秒表继续走：`useSecondsTick(inFlightSession || sendStatus != null)`（`:286`）中 `inFlightSession = isTurnInFlight(status)`（`turnHead.ts:44-51`），而到期时会话状态仍是 `'running'`（Host 没发终态），故 `nowMs` 仍在跳。仅需把 `pendingReply != null` 一并 or 进 enable 条件以防状态先落地。
- Stop 入口**已经存在**，无需新按钮：`deriveActionButtons`（`queueRelease.ts:430-437`）在 `isRunningStatus(status)` 时给 Stop；`'running'` 在集合内。这是保留 `pending` 态而不清 Host 绑定的额外红利——绑定健康，Stop 可用。
- `budgetMs` 走 `DEFAULT_REPLY_BUDGET_MS`（`MessageTimeline.tsx:1221`），本批改为 `SEND_SILENCE_CEILING_MS`；`slow` 分支不打印 `(up to Ns)`，无矛盾。

### 4.5 store 落点：`turnSendStatus.ts` 加第二槽

放这里而非组件 ref：回合头在 `MessageTimeline`，它读不到 `ChatComposer` 的 ref；而该 store 本就是「Composer 写、Timeline 读」的唯一通道，`baseline` 槽已有「刻意比 `status` 活得久」的先例（`turnSendStatus.ts` 的 `TurnSendBaseline` 头注）。

```ts
export interface PendingReplyWatch { sessionId: string; turnStartedAtMs: number; }
// store: pendingReply: PendingReplyWatch | null
// armPendingReply(watch) / clearPendingReply(sessionId)   ← 按 sessionId 幂等清除
```

**只放展示事实，不放 payload**：`committed`（含 base64 附件）留在组件 ref，避免把用户数据搬进一个会被 devtools 序列化的 store，也让 store 保持可断言的小面。

### 4.6 abandon marker 保留多少

**机制整体保留并升格**，不是删除：`abandonMarkerRef` → `pendingReplyRef`，两个既有 effect（`ChatComposer.tsx:1957-1973` 的进度 effect、`:1984-1991` 的 `session.completed` 订阅）与纯函数 `resolveAbandonProgress`（`assistantProgress.ts:266-276`，含向下重基线那条 B2 修复）**逐字保留**——那是被 4 轮评审打磨过的、专治「回放历史误清」的资产，删掉是浪费。

变的只有两处：
1. 清除动作里不再需要「清 `lastError`」（本来就没写过），改为 `clearPendingReply(sessionId)` + 清 ref；`setRetryable(current === marker.committed ? null : current)` 的身份保持写法（`:1944-1952`）保留，作为「若上一轮真失败装了 Retry，本轮迟到回复应清掉它」的防线。
2. 新增 `session.failed` 订阅分支 → §6 的确定死亡处置。

---

## §5 restore-draft 收窄与文本找回

### 5.1 收窄裁定

`decideFailureAffordance` 的 `'restore-draft'` **只保留给「从未被受理」以外的既有 `'committed'` 场景**，`'pending'` 一律 `'none'`（§4.3）。收窄后的完整映射：

| 出路 | origin | affordance | 何时发生 |
|---|---|---|---|
| `'skipped'` | 任意 | `'resend'` | 提交前守卫失败，什么都没发出去 |
| `'rejected'` | `direct`/`retry` | `'resend'` | Host 从未受理（无回声），重发不会重复 |
| `'rejected'` | `release` | `'none'` | 队列自己回填（`shouldPauseQueueOnRejection`） |
| `'committed'` | 任意 | `'restore-draft'` | **真失败**：`session.failed` / 握手致命错 / `ensureHost` 抛错，且已有回声 |
| **`'pending'`** | 任意 | **`'none'`** | **本批新增：猜测性超时。既不报错也不回显** |

### 5.2 「recover text」：**不做新按钮，改为延后到确定死亡再决定**

分诊问的是「显式按钮 vs 别的形状」。裁定：**别的形状——把 affordance 决定权从「猜测时刻」推迟到「证据到达时刻」**。

理由链：

- 用户裁定原文是「只有明确确定回合死亡才允许回显输入 + 红色报错」。**这句话本身就规定了正确的架构**：affordance 不是超时的函数，是死亡证据的函数。加一个「找回文本」按钮等于承认超时时刻需要一个动作，那还是把猜测搬到了 UI 上。
- 文本并没有丢：回合已受理 ⇒ 用户消息**已在时间线里**（`beginTurn` 的回声写成了 user 气泡），`whitespace-pre-wrap` 可选中可复制（`MessageTimeline.tsx:690-711`）。这不是「用户无路可走」的处境。
- `pendingReplyRef.current.committed` 一直在内存里等着。一旦 `session.failed` 到达（§6），走 `decideFailureAffordance('committed', origin)` = `'restore-draft'`，用**同一个** `restoreDraftIfComposerEmpty`（`ChatComposer.tsx:1049-1058`，含「composer 非空就不覆盖」的 F4 防覆写）把料放回去。用户看到的是：等了很久 → Host 说失败了 → 红卡 + 输入框里回来了。**因果顺序正确**。
- 若最终来的是 `session.completed` / `stopped` / 迟到回复，则 ref 静默丢弃，输入框从头到尾没被动过——这正是现场抱怨的那份「等着被误发的复制稿」再也不会出现。

**保守替代（若评审坚持要显式入口）**：在回合头 `slow` 行右侧加一个 ghost 小按钮「Recover text」，只在 `pendingReply != null && composer 为空` 时出现。代价是它属文案/装饰族，与 §8 的越界纪律打架，故列为备选而非主案。

### 5.3 迟到回复清理链连带草稿的处理

分诊缺陷 3 的根因是「清了横幅没清草稿」。本批**从源头消灭该状态**：`'pending'` 路径从不回显草稿，所以「迟到回复到达时草稿里躺着复制稿」这个状态**不可达**。

但清理链仍需覆盖另一半——上一轮真失败留下的 `retryable` / `lastError`：`clearAbandonMarkerIfMatch` 的两条清除（`:1941-1952`）逐字保留。另加一条**新的**不变量断言（§10.3 `[D-4]`）：`'pending'` 分支执行后，`valueRef.current` 与 `attachments.getLiveDraftCount()` 与分支执行前**逐字节相同**——把「不许回显」钉成可测事实，而不是靠人读代码确认少了一行。

---

## §6 确定死亡的判据清单

### 6.1 判据表（含分诊的一处收窄）

| 判据 | 事件/来源 | 红色报错 | 回显输入 | 说明 |
|---|---|---|---|---|
| `session.failed` | `isSessionFailedForSend`（`assistantProgress.ts:155-157`） | ✅ | ✅ | **唯一**触发红卡+回显的判据 |
| `session.stopped` | `isSessionStoppedForSend`（`:188-190`） | ❌ | ❌ | 用户自己按的 Stop；既有 Stop 出路（`ChatComposer.tsx:1707-1732`）已是干净结束，逐字保留 |
| `session.completed` | `isSessionCompletedForSend`（`:172-174`） | ❌ | ❌ | Host 说回合正常结束；无产出也不是失败（可能是纯副作用回合） |
| `finishTurn` 合成终态 | `claudeRuntime.ts:1011-1019` | 由其产出的 `failed`/`idle` 决定 | 同左 | 流无 `result` 就结束时补终态，已有 |
| 握手致命错 / `ensureHost` 抛错 | `fatalHostError` 通道 | ✅ | 按 `sawUserEcho` 决定 | 既有，不改 |

【与分诊冲突】分诊方向 C 写「红横幅只在确定死亡（`session.failed` / `stopped` / `completed` 无产出）时出现」。本稿把该表**当作上界而非充要条件**并进一步收窄：`stopped`/`completed` 静默结束 watch，不出红卡。理由：`stopped` 是用户意图，`completed` 是正常终态，给它们红卡等于把「猜测性失败」换个触发器复活。

### 6.2 遗漏项：Host 进程崩溃 / IPC 断连（新发现①）

**这是清单里唯一真正的洞**，分诊未列。【实测】`AgentHostManager.ts:472-496`：Host 子进程 exit 只写日志与 `this.state='stopped'`，`proc.on('error')`（`:462-470`）只写 `this.state='error'`，**两者都不向渲染端广播任何东西**。渲染端唯一的 Host 存活通道是 `chat.getHostStatus()`（`preload/index.ts:1390-1396`，返回 `{state, pid, …}`），而它只在旧 abandon 分支里被**一次性**调用（`ChatComposer.tsx:1779`）。

后果：Host 崩溃时所有活跃会话永久停在 `'running'`——Stop 按钮在、点了没用、没有终态、`'pending'` watch 会一直转秒。**这是本批必须补的**，否则新形态在这个场景下比旧形态更糟（旧形态至少 45s 后报个错）。

**裁定：Main 侧补一条会话级终态广播**（改动最小、语义最诚实、不需要新事件类型）：

```
AgentHostProcess 'exit' / 'error'
  → AgentHostManager 对「本进程生命周期内已知的全部活跃会话」逐个广播
      session.status { status: 'disconnected' }   // 已有状态成员，runtimeEvents.ts:55
      session.failed { error: 'Agent Host exited (code=… signal=…)' }
```

- `'disconnected'` 已是 `SessionRuntimeStatus` 合法成员并已被 Claude/Codex 的 `close()` 使用（`claudeRuntime.ts:1341-1346`、`codexRuntime.ts:2796`），零协议新增。
- `session.failed` 让渲染端既有的 `isSessionFailedForSend` 通道直接接住 → 红卡 + 回显（§5.2 的正确因果）。
- 清洁退出（`code===0 || signal==='SIGTERM'`，即我们自己的 `shutdown()`）**不广播**，沿用 `:483` 已有的 `clean` 判定，避免应用退出时刷一屏假失败。
- 「本进程生命周期内已知的活跃会话」从哪来：`AgentHostManager` 需要一份 sessionId 台账。若评审认为该台账成本过高，**降级方案**：只广播一条 `host.error { code: 'host_exited', fatal: true }`（无 sessionId），渲染端 `runSend` 的 host.error 通道已能接住**在飞的那一条**；代价是后台会话仍停在 `'running'`。降级方案是本批最低可接受形态。
- 若评审认为整条属于「另立票」，则 §4 的 `'pending'` watch 必须加一条**兜底**：进入 pending 后每 30s 轮询 `chat.getHostStatus()`，`state !== 'running'` 即视为确定死亡。**记为 open question Q3，不能默认忽略**。

---

## §7 Codex 轴：补同款双狗（不接受渲染端权威）

### 7.1 裁定与理由

分诊 H 要求「二选一，不能含糊」。**裁定：给 Codex 轴补同款双狗。**

不能选「明确接受渲染端权威」的理由是结构性的：本批刚刚把渲染端的判死权拿掉（§1）。若 Codex 轴保留渲染端权威，就等于同一份 `runSend` 代码要按 agent 分叉出两套裁决语义——而 `runSend` 全程**不知道自己在跟哪个 agent 说话**（`turnAgent` 只用于选 model/effort/permission，`ChatComposer.tsx:927`）。那意味着要么写一个 agent 分支进最敏感的发送路径，要么让 Codex 轴继续被 300s 沉默天花板误判——两者都不可接受。

现状风险实测：`codexRuntime.ts:371-381` 只有 `turn/start` 的 RPC ack 30min 兜底，且其头注自认「codex 在回合开始还是结束应答此请求是 [未测]」。一个 wedged 的 Codex 回合今天**最长 30 分钟没有任何裁决**。

### 7.2 活性帧词表（按 codex 事件流映射）

【实测】`codexNormalizer.ts:66-80` 的 `CODEX_NORMALIZER_METHODS` + `:91-101` 的 `CODEX_IGNORED_NOTIFICATIONS` 是全量通知面。映射：

**productive（复位 Codex stall 表 / 满足 TTFT）**

`turn/started`、`item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/summaryPartAdded`、`item/reasoning/summaryTextDelta`、`item/reasoning/textDelta`、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`、`item/mcpToolCall/progress`、`thread/tokenUsage/updated`、`turn/completed`、以及 **被我们刻意忽略但确属模型产出的三条**：`turn/plan/updated`、`item/plan/delta`、`turn/diff/updated`。

> 关键判据：**「我们不渲染」不等于「模型没在产出」**。`CODEX_IGNORED_NOTIFICATIONS` 是渲染决策表，不是活性表。把它当活性表用，会让一个正在写 plan 的回合被判死。

**非 productive（不复位）**

`thread/status/changed`（控制面，`codexStatus.ts` 独占）、`serverRequest/resolved`（结算请求，非内容）、`thread/settings/updated`（设置回写）、`thread/started`（生命周期）、`account/rateLimits/updated`（账户面，与本回合无关——这条是 Codex 轴的 `api_retry` 类比物，恰恰不能算活）。

**守卫（等价 Claude 的 `hasPending`/`hasOpenTools`）**：Codex 的 pending server-request 表非空时 `rearm()` 并发 `liveness note{reason:'awaiting_user'}`；有未 settle 的 `item/started`（命令执行中）时 `reason:'tool_running'`。

### 7.3 常量与 abort 动作

```
CODEX_STALL_TIMEOUT_MS = 195_000   env AICLIENT_CODEX_STALL_TIMEOUT_MS，<=0 禁用（= 今日行为）
CODEX_TTFT_TIMEOUT_MS  =  45_000   env AICLIENT_CODEX_TTFT_TIMEOUT_MS，<=0 禁用
```

TTFT 取 45s 而非 32s：`turn/start` 的应答时机 [未测]（`codexRuntime.ts:376-379` 自注），首帧顺序不确定，给足余量。仍远小于 195s，链条不破。

**abort 动作按阶段分叉**（这是 Codex 与 Claude 唯一的真实差异）：

- **turnId 已知**：`turn/interrupt`（`buildTurnInterruptParams`，`:364-369`）+ `finishTurn(state,'failed',msg)`。
- **turnId 未知**（TTFT 场景，`turn/start` 尚未应答）：**不得伪造 interrupt**——`:355-363` 明文记录「单 id interrupt 是 schema 错误，等于日志声称发了实则没发」。改为：`finishTurn(state,'failed',msg)` + `state.turn = undefined` 退休本回合，此后迟到的 `turn/start` 响应由既有守卫 `if (state.turn !== turn)`（`:2939-2944`）静默吞掉。**残留**：codex 侧可能仍在跑那个回合。记为 open question Q4（是否需要 connection reset）。

### 7.4 与 30 分钟 RPC ack 的关系

`CODEX_TURN_START_TIMEOUT_MS` **保留不动**，降级为**连接层最后兜底**：新的 45s/195s 狗在任何正常场景下都先开火，30min 只在「连接彻底哑了、连通知都不来、且我们的狗被 env 关掉」时才生效。同时它现在与渲染端 `SEND_ABSOLUTE_CEILING_MS` 数值相等（§2.3），两端不再有 40 倍错配。

---

## §8 文案与展示

### 8.1 `SLOW_WAIT_HINT_SECONDS` **保持 45，不上调**

这是本节最反直觉、也最关键的一条。分诊 A 把它列进「联动上调」清单，**本稿改判为不动**【与分诊冲突】。

理由：`SEND_BASE_TIMEOUT_MS` 与 `SLOW_WAIT_HINT_SECONDS` 今天数值重合（都是 45），是**巧合造成的遮蔽**——到期与文案切换同一秒发生，且到期立刻 `endTurnSend` 清表（新发现④），所以 slow 文案从未被看见。把预算抬到 300s 而阈值留在 45s，恰好让 45s→300s 这段窗口成为「仍在等待」的可见态，**正是 §4.4 需要的那个态**。上调阈值反而会把这段窗口重新变成沉默。

### 8.2 死文案审读（用户要求的首次可见前审读）

```
Still waiting · 62s — gateway latency varies. Stop to abort.
Still waiting · 62s · Retry 7/10 — gateway latency varies. Stop to abort.
```

逐项核：

| 项 | 判定 |
|---|---|
| 「Still waiting」 | ✅ 事实。此分支要求 `hasBlocks === false`（`turnStatus.ts:102-113` streaming 优先级更高），确实一个 token 都没到 |
| 「gateway latency varies」 | ✅ 有实测支撑（`attachmentLimits.ts:6-9` 记录同一负载跨日 ~8x 波动） |
| 「Stop to abort.」 | ✅ 可执行。§4.4 已核 Stop 按钮在 `'running'` 下确实呈现，且 `'pending'` 态不解绑 Host，Stop 真能到达 |
| Retry 计数后缀 | ✅ 与 `session.status.retry` 同源，非嗅探 |
| 语气 | ✅ 中性，不指认失败 |

**结论：文案逐字保留，本批不改。**

### 8.3 装饰面：`slow` 的 `text-warning` 色阶 → 移交 F4

【实测】`MessageTimeline.tsx:1372-1377` 把 `slow` 涂 `text-warning`。新形态下 `slow` 会成为「首 token 慢于 45s」的**常态**（长 prompt、长 thinking 都会命中），持续数分钟的警告色属告警疲劳。但改色阶属装饰/文案族 → **本批不动，记 F4 移交项**，并给 F4 一个建议形态：`slow` 保持 muted，另设第二档阈值（如 180s）才转 warning。

### 8.4 等待行只动阈值参数，不动文案形态

严格遵守越界纪律。本批对 `attachments.ts:321-359` 的改动为 **零**；`composerSendingLine` 的入参 `budgetMs` 由调用方从 `SEND_SILENCE_CEILING_MS` 传入，于是首 45 秒的文案从 `(up to 45s)` 变为 `(up to 300s)`——**纯参数变化，措辞未动**。`(up to Ns)` 这个从句在新语义下是否还该存在，属 F4 的判断，本稿只记录移交，不擅改。

---

## §9 切片、门禁、flag 判断

### 9.1 切片划分与依赖序

| 片 | 范围 | 程序 | 依赖 | 可并行 |
|---|---|---|---|---|
| **S1** | Host Claude 轴：TTFT 证据门改动 A/B、liveness note 发射、`PRODUCTIVE_EVENT_TYPES` 冻结断言、三处陈旧 `120s` 注释订正、R9 注记改写 | `src/agent-host` + `src/shared` | 无 | 与 S2 并行 |
| **S2** | 渲染端读侧：`sendBudgets.ts` 新建、常量与反转 INVARIANT、`classifyTurnLiveness`、`createSendWaitBudget`、`waitUntil` 换到期谓词、`formatRuntimeEvent` 打 liveness、镜像源文锁 | `src/renderer` | 只依赖 S1 敲定的**数值**（本规格已钉死） | 与 S1 并行 |
| **S3** | 渲染端写侧：`'pending'` 出路、`decideAdmittedTimeoutOutcome`、`isAdmittedOutcome`、pendingReply watch（store+ref）、回合头失表修复、abandon marker 升格、确定死亡 affordance | `src/renderer` | **必须在 S2 之后**（同改 `ChatComposer.tsx` / `queueRelease.ts`） | 与 S4 并行 |
| **S4** | Codex 轴双狗 + Codex liveness note | `src/agent-host` | 依赖 S1 的协议类型 | 与 S3 并行 |
| **S5** | Main 侧 Host 退出广播（§6.2） | `src/main` | 无 | 全程可并行 |

**零混面核对**：S1/S4 只碰 `src/agent-host`（S1 碰 `claudeRuntime.ts`/`ttftWatchdog.ts`，S4 碰 `codexRuntime.ts`/`codexNormalizer.ts`，无重叠文件）；S2/S3 串行同一批渲染端文件；S5 只碰 `src/main`。**S1∥S2∥S5 → S3∥S4**。

### 9.2 每片收口条件（一致口径）

每片必须同时给出：① 四门全绿（`pnpm typecheck` / `pnpm typecheck:agent-host` / `pnpm lint` / 该片相关 vitest 套件，**逐门串行跑**，禁链式合跑——本机曾 OOM exit 137）；② 该片确定性断言点逐条实跑记录；③ 该片变异对逐对实跑记红灯（零跳过）；④ 影响面清单与实际 `git diff --stat` 逐文件核对。

### 9.3 flag 判断：**分裂裁决，不是一刀切**

| 改动 | 要不要 flag | 理由 |
|---|---|---|
| liveness note 帧（S1/S4） | ✅ `AICLIENT_HOST_LIVENESS_NOTE`，默认 on，`'0'` = QUIET | 新增协议流量，有真实 off 位（停发即回到今日 wire），逐字对齐 `AICLIENT_HOST_SUBAGENT_ACTIVITY` 先例 |
| Codex 双狗（S4） | ✅ 以 env 阈值承载：`AICLIENT_CODEX_*_TIMEOUT_MS = 0` 即禁用 = 今日行为 | 新增能力，off 位是真的今日行为 |
| TTFT 重试阈值（S1 改动 A） | ✅ `AICLIENT_HOST_TTFT_RETRY_ATTEMPTS`，`1` 即恢复今日语义 | 数值 flag，回退位精确 |
| Host 退出广播（S5） | ⚠️ 建议无 flag | 补的是「本来就该有的终态」，off 位是一个已知缺陷 |
| **渲染端 300s + 不判死（S2/S3）** | ❌ **不加布尔 flag** | 见下 |

**对工程规范 #6 的显式偏离与论证**：规范要求「每个新能力藏在 flag 后，双位置都跑」。渲染端这半边**不是新能力，是撤销一个错误裁决**。为它做 flag 意味着在产品里保留一个「我们已证明它会对活着的回合打红叉」的位置——那不是安全网，是把缺陷做成配置项。可回退性由三样东西提供而非 flag：(a) `SEND_SILENCE_CEILING_MS` / `SEND_ABSOLUTE_CEILING_MS` 是常量，改数即回退量级；(b) 分片提交，S3 可单独 revert 而 S2 留存；(c) 回归三档（smoke/main/incident）里把本次现场样本（admitted-but-no-reply）立成 incident 用例。**本条属需要用户/评审确认的偏离，列为 open question Q1。**

### 9.4 「是否算行为破坏」判断

**算，且是刻意的行为破坏**，范围明确为三条可观测变化：

1. 一个已受理但 300s 内无任何 Host 帧的回合，**不再**出现红横幅、**不再**回显草稿、**不再**解绑 Host；改为回合头持续显示 `Still waiting · Ns`。
2. `session.failed` 到达时的红卡与回显**照旧**，但时机后移到证据到达时刻。
3. Host 端一次 `api_retry` 不再立即杀回合（需累计 3 次或等 195s stall）。

三条都是「把谎言换成沉默或换成延后的真话」，方向单一；不存在「原本成功现在失败」的方向。发布说明需按 `fix:` 前缀写清第 1 条，因为它改变用户已习惯的可见行为。

### 9.5 每片测试与变异验证策略

- **S1**：`claudeRuntimeOptions.test.ts` 的 TTFT describe 块（`:567-818`）扩写；`claudeRuntimePartialStall.test.ts` **不改**（它是冻结词表的守门人，必须保持绿）；`ttftWatchdog.test.ts` **不改**（一次性状态机形状未变——改的是 `onTimeout` 里的策略，不是 watchdog 类）。
- **S2**：新 `sendBudgets.test.ts`（纯函数，node 环境安全）；`assistantProgress.test.ts` 加 liveness 组；`attachmentLimits.test.ts` 拆分退役。
- **S3**：`queueRelease.test.ts` 加 `'pending'` 全表；`composerStopStatic.test.ts` 新增 pending 分支静态断言组。
- **S4**：新 `codexWatchdog.test.ts`（词表与守卫为纯函数，抽出来测，不起真连接）。
- **S5**：`AgentHostManager` 的 exit 广播用既有的假 proc 事件驱动测。
- **变异验证纪律**：每对变异必须指名一个**承重行**（不是注释行、不是 inert 分支），flip 前预检 old/new 串在文件内双唯一，跑完立即回滚。逐对清单见 §10.4。

---

## §10 影响面 / 测试合同 / 断言与变异 / open questions

### 10.1 影响面清单（改动文件全列）

**新建**

| 文件 | 片 | 内容 |
|---|---|---|
| `src/renderer/components/chat/sendBudgets.ts` | S2 | 两个天花板常量、两个 Host 镜像、`createSendWaitBudget`、反转 INVARIANT 注记 |
| `src/renderer/components/chat/__tests__/sendBudgets.test.ts` | S2 | 预算纯函数 + 有序链不变量 + 源文镜像锁 |
| `src/agent-host/__tests__/codexWatchdog.test.ts` | S4 | Codex 词表/守卫纯函数 |

**修改**

| 文件 | 片 | 改动要点 |
|---|---|---|
| `src/shared/types/runtimeEvents.ts` | S1 | `SessionLivenessNote` 新类型；`SessionStatusEvent.payload.liveness?` 加法字段；协议版本不动 |
| `src/agent-host/claudeRuntime.ts` | S1 | `:105-115` 注释订正 `120s`→`195s`；新增 `TTFT_API_RETRY_ABORT_ATTEMPTS` + resolver；`:726-780` 证据门改动 A/B（`apiRetryCount`、三分 reason、发 liveness note）；`:755-766` R9 注记改写；`:794-800` 导出 `PRODUCTIVE_EVENT_TYPES`；`:949-951` 计数改累加 |
| `src/agent-host/ttftWatchdog.ts` | S1 | `:9-14` 头注订正（120s→195s；「必须低于渲染端 45s」→「Host 先于渲染端沉默天花板」） |
| `src/agent-host/codexRuntime.ts` | S4 | 两个新常量 + resolver；send 路径装双狗；abort 按 turnId 分叉；发 liveness note |
| `src/agent-host/codexNormalizer.ts` | S4 | 导出 productive 方法集（供狗与测试共用，单一真源） |
| `src/main/services/agent-host/AgentHostManager.ts` | S5 | exit/error 广播会话级终态（或降级 `host.error{host_exited}`） |
| `src/renderer/components/chat/attachmentLimits.ts` | S2 | 迁出超时半边，只留附件限额；删 `:165-210` |
| `src/renderer/components/chat/assistantProgress.ts` | S2 | 新增 `classifyTurnLiveness` + `TurnLivenessSignal`；`classifyAssistantProgress` **一字不改** |
| `src/renderer/components/chat/queueRelease.ts` | S3 | `RunEntryOutcome` 加 `'pending'`；新增 `decideAdmittedTimeoutOutcome`、`isAdmittedOutcome`；四个既有决策函数补 `'pending'` 分支 |
| `src/renderer/components/chat/useQueueRelease.ts` | S3 | 回填判据改 `!isAdmittedOutcome(result)` |
| `src/renderer/stores/turnSendStatus.ts` | S3 | 新槽 `pendingReply` + `armPendingReply`/`clearPendingReply` |
| `src/renderer/components/chat/ChatComposer.tsx` | S2+S3 | `waitUntil` 换签名（3 调用点）；接 `budget.markLiveness`；`formatRuntimeEvent` 打 liveness；到期分支一分为二；`abandonMarkerRef`→`pendingReplyRef`；两个 effect 改清除动作 + 加 `session.failed` 分支；`maybeApplyFirstMessageTitle` 改判据 |
| `src/renderer/components/chat/MessageTimeline.tsx` | S3 | `:935-946` `turnActive`/`elapsedSeconds` 加 pendingReply 项；`:286` tick enable 加项；`:1221` `DEFAULT_REPLY_BUDGET_MS` 换源 |
| `src/renderer/components/chat/middleColumnLayout.ts` | S2 | `:607-611` 散文样例 `45s`→`300s` |

**明确不改**：`attachments.ts`（文案，§8.4）、`turnStatus.ts`（分支结构未变）、`chatSessions.ts`（红线文件，零改动）、`ttftWatchdog` 类本体逻辑、`claudeRuntimePartialStall.test.ts`。

### 10.2 测试合同变更清单（逐文件逐用例）

**`__tests__/attachmentLimits.test.ts`（S2）**

| 用例 | 处置 | 理由 |
|---|---|---|
| `[T-01]` `sendTimeoutMs(0)===45_000` | **退役** | 所钉公式整体作废（§1.3），非重编号 |
| `[T-02]`~`[T-04]` 字节缩放三例 | **退役** | 同上；缩放模型对沉默预算恒等零作用 |
| `[T-05]` 钳制与单调 | **退役** | 无公式即无单调性可言 |
| `[T-06]` `CEILING < HOST_STALL` | **反转重写**→ 迁入 `sendBudgets.test.ts` `[C-02]` | 不变量方向翻转，重编号会掩盖语义反转 |
| `[a4]` `TTFT < SEND_BASE` | **反转重写**→ `[C-01]` 有序链 | 同上 |
| `[A-01]`~`[A-10]`、`MAX_ATTACHMENT_READ_BYTES mirror`、`planImageAttachment`、`largeAttachmentHint` | **原样保留** | 与超时无关 |

**新 `__tests__/sendBudgets.test.ts`（S2）**

`[C-01]` 有序链 `TTFT < STALL < SILENCE <= ABSOLUTE`；`[C-02]` `HOST_STALL_TIMEOUT_MS < SEND_SILENCE_CEILING_MS`（反转后的 T-06）；`[C-03]` 源文镜像锁：读 `src/agent-host/claudeRuntime.ts`，正则取 `DEFAULT_STALL_TIMEOUT_MS`/`DEFAULT_TTFT_TIMEOUT_MS` 字面量，与两个镜像常量逐一相等（**新发现③ 的补洞**）；`[C-04]` `createSendWaitBudget`：无活性帧恰在 silence 边界到期、活性帧复位后重新计满、绝对上限在持续活性下仍到期、`markLiveness` 传入过去时刻不倒退。

**`__tests__/assistantProgress.test.ts`（S2）**

`[L-1]` 包含关系：遍历全部 `RuntimeEventType` 字面量，凡 `classifyAssistantProgress===‘assistant’` 者 `classifyTurnLiveness` 必为 `'liveness'`；`[L-2]` 负向咬合：`message.started{role:'user'}` → progress `'ignore'` 且 liveness `'liveness'`（分诊「不许放宽」的可执行形式）；`[L-3]` `session.status`（含 retry、含 liveness note）、`session.stderr`、`usage.updated`、`subagent.activity` 四类均为 liveness；`[L-4]` 三个终态与 `host.error` 均非 liveness；`[L-5]` 跨会话事件恒 `'ignore'`。

**`__tests__/queueRelease.test.ts`（S3）**

`[P-1]` `decideAdmittedTimeoutOutcome` 真值表（有回声→`'pending'`，无回声无进度→`'rejected'`）；`[P-2]` `decideFailureAffordance('pending', 三种 origin)` 全为 `'none'`（**承重**）；`[P-3]` `shouldArmRetryable('pending', *)` 全 `false`；`[P-4]` `shouldPauseQueueOnRejection('pending', *)` 全 `false`；`[P-5]` `isAdmittedOutcome` 四值全表；`[P-6]` 既有 `'committed'`/`'rejected'`/`'skipped'` 全表**逐字不变**（回归保护）。

**`__tests__/composerStopStatic.test.ts`（S3）**

既有 6 组断言中，`:245-252` 那组按构造必红——`only('abandonMarkerRef.current = {')` 与 `only('const abandonError = [')` 在改名/搬移后抛错。改法：
- `abandonError` 仍存在（只服务 `'rejected'` 分支），故 `:250` 的断言**保留**，仅确认其仍在 Stop 出路之后；
- `:251` 改为 `only('pendingReplyRef.current = {')`；
- 新增第 7 组 `describe('admitted-timeout 分支既不判死也不回显 (F2)')`：`[S-1]` `pendingBranchBody()` 不含 `unbindHost()`；`[S-2]` 不含 `lastError:`；`[S-3]` 不含 `restoreDraftIfComposerEmpty` 与 `setRetryable(`；`[S-4]` 含 `armPendingReply(`；`[S-5]` `decideAdmittedTimeoutOutcome(` 在文件中恰一次且位于 Stop 出路之后、`abandonError` 之前；`[S-6]` `budget.markLiveness(` 与 `classifyAssistantProgress(` 同在监听器内且互不替代（各恰一次）。
- 文件头散文里的「45s abandon budget」三处（`:14-15`、`:139-141`、`:235`）同步订正为「沉默天花板」。

**`__tests__/turnStatus.test.ts`（S3）**：`base.budgetMs: 45_000` 是 fixture 而非常量主张，**不改**；新增 `[TS-1]`：`elapsedSeconds >= SLOW_WAIT_HINT_SECONDS && !hasBlocks` 时 `kind==='slow'` 且文案含 `Stop to abort.`（把「still running 态复用 slow」这个复用关系钉住，防 F4 误删）。

**`claudeRuntimeOptions.test.ts`（S1）**：既有 6 例中，`F1: fires once sawApiRetry evidence lands`（`:695-717`）**必须改**——单次 `api_retry` 不再开火。改为：该 fixture 连发 3 次 `api_retry` 后仍 `session.failed`；**新增** `[E-1]` 单次 `api_retry` 后静默 → TTFT 不开火、由 stall 兜底（用短 stall env 断言消息含 `stall watchdog`）；`[E-2]` liveness note：停在权限上时至少发出一帧 `session.status` 带 `liveness.reason==='awaiting_user'`；`[E-3]` `AICLIENT_HOST_LIVENESS_NOTE='0'` 时一帧不发且判决不变。其余 5 例保持绿。

**`claudeRuntimePartialStall.test.ts`**：**零改动**，作为词表冻结守门人（S1 收口条件之一是它保持绿）。

**新 `codexWatchdog.test.ts`（S4）**：`[X-1]` productive 方法集包含三条「不渲染但属产出」的 plan/diff 方法；`[X-2]` `account/rateLimits/updated` 与 `thread/status/changed` 不在集内；`[X-3]` 集合与 `CODEX_NORMALIZER_METHODS ∪ CODEX_IGNORED_NOTIFICATIONS` 的差集为空（防上游新增通知被静默漏判）；`[X-4]` turnId 未知时 abort 路径不构造 interrupt 参数。

### 10.3 关键断言（Happy Path 之外的承重不变量）

1. **有序链**：`TTFT < STALL < SILENCE <= ABSOLUTE`（`[C-01]`）——反转不变量的数值半边。
2. **包含关系**：progress ⊆ liveness（`[L-1]`）——反转不变量的语义半边，二者合起来才证明「Host 恒先说话」。
3. **负向咬合**：用户回声是 liveness 不是 progress（`[L-2]`）。
4. **不回显**：`decideFailureAffordance('pending', *) === 'none'`（`[P-2]`）+ 源文层 `[S-3]`——用户裁定的可执行形式，双层保险。
5. **镜像锁**：渲染端镜像 ≡ Host 真值（`[C-03]`）。
6. **词表冻结**：`PRODUCTIVE_EVENT_TYPES` 恰为五值 + `claudeRuntimePartialStall` 保持绿。

### 10.4 变异计划（逐对，承重行，实跑记红灯）

| # | 承重行（片） | 变异 | 必红用例 |
|---|---|---|---|
| M1 | `sendBudgets.ts` `SEND_SILENCE_CEILING_MS = 300_000` → `150_000` | 破坏有序链 | `[C-01]` `[C-02]` |
| M2 | `createSendWaitBudget` 的 `markLiveness` 体改为空函数 | 复位失效 | `[C-04]` 第二例 |
| M3 | `createSendWaitBudget` 去掉 absolute 分支 | 封顶失效 | `[C-04]` 第三例 |
| M4 | `classifyTurnLiveness` 的 `session.status` 分支返回 `'ignore'` | 心跳失效 | `[L-3]` |
| M5 | `classifyAssistantProgress` 的 `role === 'assistant'` 改 `role !== ''` | 放宽谓词（禁忌） | `[L-2]` 且 `[L-1]` 保持绿（证明两函数确实分离） |
| M6 | `decideFailureAffordance` 的 `'pending'` 分支返回 `'restore-draft'` | 回显复活 | `[P-2]` |
| M7 | `isAdmittedOutcome` 去掉 `'pending'` | 队列重发 | `[P-5]` |
| M8 | `ChatComposer` pending 分支加回 `unbindHost();` | 解绑复活 | `[S-1]` |
| M9 | `claudeRuntime` 证据门阈值常量 `3` → `1` | 误杀复活 | `[E-1]` |
| M10 | `PRODUCTIVE_EVENT_TYPES` 加 `'system'` | 词表松动 | 冻结断言 + `claudeRuntimePartialStall` 第二例 |
| M11 | `MessageTimeline` `turnActive` 去掉 `pendingActive` 项 | 失表复活 | 新增 `[TS-2]`（回合头 pending 态渲染，见下） |
| M12 | Codex productive 集去掉 `turn/plan/updated` | 写 plan 被判死 | `[X-1]` |
| M13 | Host exit 广播去掉 `session.failed` | 崩溃静默复活 | S5 用例 |
| M14 | liveness note 的 `reason` 恒返回 `'insufficient_evidence'` | reason 与分支脱钩 | `[E-2]` |

> `[TS-2]` 补充说明：`MessageTimeline.tsx` 是 `.tsx`，本仓 vitest 只收 `*.test.ts` 且 node 环境不渲染组件，故 M11 的必红用例落在**源文静态断言**（并入 `composerStopStatic` 同族的新文件 `messageTimelinePendingStatic.test.ts`），断言 `turnActive` 赋值行同时包含 `inFlight`、`streamStartedAt`、`pendingActive` 三个标识符。这是本仓对 `.tsx` 不可测事实的既有工法（`composerStopStatic.test.ts` 头注明文）。

### 10.5 风险表

| 风险 | 等级 | 缓解 |
|---|---|---|
| Host 崩溃场景在 S5 落地前比旧形态更糟（无 45s 兜底报错） | **高** | S5 与 S1/S2 并行、**先于 S3 合入**；若 S5 被否，S3 必须带 Q3 的轮询兜底 |
| liveness note 若被 F4 之外无人渲染，构成半个空壳 | 中 | 本批已给两个真消费方（沉默表复位 + `formatRuntimeEvent`），施工时必须实测两者都跑到 |
| `waitUntil` 换签名触及最敏感的发送路径 | 中 | 三调用点同文件；`composerStopStatic` 既有 6 组断言全程保持绿即为回归证据 |
| Codex TTFT 45s 基于 [未测] 的首帧顺序 | 中 | env 可调 + `0` 禁用；S4 收口前用 rollout 法借真回合验一次首帧顺序 |
| 拆 `sendBudgets.ts` 扩大 diff | 低 | 已给「原地保留」的保守回退位，不承重 |
| 300s 期间用户以为卡死而反复点 Stop | 低 | Stop 幂等（`stop()` 只 abort 一次）；回合头文案已含 `Stop to abort.` |

### 10.6 Open questions（需拍板）

| # | 问题 | 本稿建议 | 阻塞谁 |
|---|---|---|---|
| **Q1** | 渲染端半边不加布尔 flag，是对工程规范 #6 的显式偏离，是否接受？ | 接受（§9.3 已论证：flag 化等于把缺陷做成配置项） | S3 合入 |
| **Q2** | `SEND_ABSOLUTE_CEILING_MS = 30min` 是在用户裁定的 300s 之外**新增**的第二个上限，是否认可？ | 认可（它是活性帧无限保活的唯一封顶，且对齐 Codex 的 30min） | S2 |
| **Q3** | Host 退出广播（S5）本批做、降级做（只发 `host.error`）、还是另立票？ | 本批做全量；最低可接受为降级版；**另立票则 S3 必须带轮询兜底** | S3/S5 |
| **Q4** | Codex TTFT 在 turnId 未知时只本地判死、不重置连接，残留的 codex 侧回合是否可接受？ | 本批接受并记为遗留 | S4 |
| **Q5** | 拆 `sendBudgets.ts` vs 原地留在 `attachmentLimits.ts` | 拆 | S2 |
| **Q6** | `TTFT_API_RETRY_ABORT_ATTEMPTS` 默认 3 是否合适（SDK 上限 10） | 3 | S1 |

### 10.7 本批明确不做

- 等待行文案改造（俏皮动词、流量数字、`(up to Ns)` 从句去留）→ F4 批。
- `slow` 色阶降级与第二档阈值 → F4 批。
- 红卡中英混排订正（新发现⑤）→ F4 批。
- `formatRuntimeEvent` 之外的诊断面重构、`rawEvents` 环形缓冲策略。
- 任何对 `chatSessions.ts`（红线文件）的改动。
- `historyReader` 分支盲（F8，另立票）。
