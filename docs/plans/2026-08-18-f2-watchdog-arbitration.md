# F2 超时看门狗体系重设计 — 双轨仲裁档（rev.1）

- 日期：2026-08-18
- 分支：`feat/openchamber-chat-refactor`
- 输入 A 轨（Opus 盲稿）：`docs/plans/2026-08-18-f2-watchdog-redesign-spec-trackA.md`（§0~§10）
- 输入 B 轨（Codex 盲稿）：`docs/plans/2026-08-18-f2-watchdog-redesign-spec-trackB.md`（§0~§13）
- 取证基线：`docs/plans/2026-08-17-d48-t10-inspection-triage.md` §F2
- 仲裁基线 commit：`0271e01`（含快修批一 `a94b9a4` 与快修批二 `c5cbd19`/F10）
- 交付性质：仲裁档。本次只写文档，未改任何生产代码或测试代码。
- 标注：【仲裁实测】= 本仲裁亲自回代码核对；【双轨同判】= 两轨独立同结论直接采纳；【合取】= 互补反例合并；【纠错】= 某轨事实性错误。

## §0 双轨概览与质量评估

### 0.1 两轨的形状

两轨对**总方向**独立同判，且都与分诊方向 F 一致：Host 是唯一裁决者与唯一 abort 执行者，渲染端降级为展示层 + 一个高于 Host 的安全上限，现行 `attachmentLimits.ts:190-202` 的 INVARIANT 必须反转重写。这条是本批的地基，**双轨同判，无需再议**。

分歧集中在四个层面：

| 层面 | A 轨 | B 轨 |
|---|---|---|
| 到期后的渲染端状态 | 新增 `RunEntryOutcome` 成员 `'pending'` + store 第二槽 `pendingReply` | 新增判别联合 `WaitResult` + `detached-wait` 态 + detached tracker |
| TTFT 到期的再武装 | 保留 `rearm()` 无限轮询，每轮发 liveness note | 一次性降级（`ttftDegraded`），永久关表交给 stall |
| api_retry 封顶 | 计数 `>= 3` 作为 abort 证据 | 墙钟 `90s` cap + `attempt >= maxRetries` |
| 45s~上限窗口的文案 | 复用既有 `slow` 分支（`Still waiting …`） | 文本无附件路径不激活 slow，另设 detached 展示 |

### 0.2 质量评估

**A 轨强项**：五项新发现全部经【仲裁实测】成立（Host 进程退出对渲染端静默、三处 120s 陈旧注释、渲染端镜像无源文锁、到期后回合头失表、红卡中英混排）；对「为什么不新增第三个证据信号」「为什么不做 Recover 按钮」「为什么不上调 `SLOW_WAIT_HINT_SECONDS`」三处反直觉裁定给了可证伪的理由链；死文案逐项审读是用户明确要求的动作，A 做了、B 没做。变异计划 14 对逐对指名承重行，可直接施工。

**A 轨弱项**：三处事实性错误（§10 逐条），其中 `RunEntryOutcome` 加成员「TypeScript 会逐点报错」是**危险的**——实际会静默产出双发 affordance。line 引用全部停在 `a94b9a4`，未含 F10 后的 `MessageTimeline.tsx` 位移。

**B 轨强项**：三层活性词表（productive / interactive / transport）命名的是**代码已经在做的事**——Host 两只狗的 rearm 守卫就是 interactive，A 的两分法丢了这一层；`attempt`/`maxRetries` 走既有 `SessionRetryInfo` 字段而非拍脑袋常量；`RestoredDraftMarker` provenance 是分诊缺陷 3 残留半边的唯一正解；S0 串行 seam 的切片纪律比 A 的并行图更安全；对每一条【推测】与【实测】的标注纪律严格，自报双盲无污染。

**B 轨弱项**：`API_RETRY_LIVENESS_CAP_MS = 90_000` 自认无证据（其 OQ2）；`turnWatchdogPolicy.ts` 跨轴共享政策模块属过度抽象（两轴事件词表不相交，可共享的只有 deadline 算术）；§5.1 把 `committed → none` 写死，与用户「明确死亡才允许回显」的裁定存在解读冲突（见 §5）；未做死文案审读；未发现 A 的五项新发现中的四项。

### 0.3 仲裁自身的三项新发现（两轨都没写）

- **① 渲染端的等待窗口只覆盖「首个助手进度之前」**【仲裁实测】。`ChatComposer.tsx:1440-1485` 的主 `waitUntil` 谓词在 `sawAssistantProgress` 为真时立即释放，而 `classifyAssistantProgress`（`assistantProgress.ts:278-310`）把 `permission.requested` / `question.requested` / `tool.*` / `thinking.*` 全部判为 `'assistant'`；`:1475-1477` 还额外在 `waiting_permission` / `waiting_question` 状态下释放。**推论**：渲染端预算在语义上是一只 TTFT 表，永远不是 stall 表；「停在权限卡上的回合会把 300s 沉默表耗尽」（A §3.3 用来论证 liveness note 承重）**不可达**；「首 token 到了然后卡死」的形态从来就只归 Host stall 管，本批不必为它设计任何渲染端机制。
- **② 加 `'pending'` 到 `RunEntryOutcome` 不会产生任何编译错误，且默认值是错的**【仲裁实测】。五个消费点全是 `if (x === 'committed')` / `if (result === 'skipped' || result === 'rejected')` 形态，没有一处是穷尽 `switch`。加成员后 `shouldArmRetryable('pending','direct')` 静默返回 `true`、`decideFailureAffordance('pending', 任意 origin)` 静默返回 `'resend'`——正是本仓 A1 轮次专门修掉的一键双发。**这把 A §4.3 的逐点裁定从「TS 会提醒我们」升格为「不写就是 P0」**。
- **③ F10（`c5cbd19`）与本批的交界是良性的**【仲裁实测】。F10 只动了滚动跟随器（`messageTimelineScroll.ts` 新增纯函数 `nextFollowState`，规则 2：高度变化帧不武装跟随）与无条件 `line-clamp-6`。本批把回合头状态行的生命从「到期即消失」改成「持续存在」，属于**减少**高度突变；而 45s 文案切换若引起换行高度变化，恰好落进 `nextFollowState` 规则 2 的保护。**结论：无冲突，且 F10 是本批的前置保护**。唯一的操作性影响是两轨的 `MessageTimeline.tsx` 行号全部过期（§10 登记）。

### 0.4 仲裁结论一句话

**骨架取 A（形态更贴用户裁定、发现更完整、可直接施工），并入 B 的六件资产**：三层活性词表、`attempt >= maxRetries` 证据、`RestoredDraftMarker` provenance、S0 串行 seam、判别联合分支标签、Host 退出广播的去重与 open-session 台账要求。三处 A 轨事实纠错必须先落，否则 §4 的施工会带进双发缺陷。

---

## §1 题一：分工形态与跨程序不变量

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| Host 唯一裁决 + 唯一 abort | 采纳（§1.1 三条不对称论证） | 采纳（§1.1「Host 权威终止 + Renderer 权威展示」） | **一致** |
| 现行 INVARIANT 反转重写 | 采纳，写成有序链 | 采纳，写成两条独立不变量 | **一致（形式分歧）** |
| 渲染端到期**不** finalize / 不 unbind / 不写 error / 不回显 | 采纳 | 采纳 | **一致** |
| 渲染端上限命名与语义 | `SEND_SILENCE_CEILING_MS`（可被活性帧复位） | `RENDERER_WAIT_SAFETY_CEILING_MS`（不复位，纯硬上限） | **分歧** |
| 第二个上限（绝对封顶 30min） | 新增 `SEND_ABSOLUTE_CEILING_MS` | 无 | **分歧** |
| 字节缩放预算 `sendTimeoutMs` 去留 | 整体作废 | 保留函数但 hard ceiling 恒 300s，size 只留 metadata | **分歧** |
| 拆 `sendBudgets.ts` | 拆（自认不承重，给了原地保留的回退位） | 不拆（改写 `attachmentLimits.ts` 原地） | **分歧（非承重）** |

### 1.1 裁定：不变量取 A 的有序链，但**语义层要写成两段而不是一条链**

【仲裁实测】现行 INVARIANT 在 `attachmentLimits.ts:190-202`，pin 在 `attachmentLimits.test.ts:246-262`（`[T-06]` + `[a4]`）。两轨要反转它，一致。

采纳 A 的有序链数值形式：

```
HOST_TTFT_TIMEOUT_MS (32s) < HOST_STALL_TIMEOUT_MS (195s) < SEND_SILENCE_CEILING_MS (300s)
```

但必须并入 B 的分层注记，理由是仲裁新发现①：**渲染端预算在语义上是一只 TTFT 表**（`ChatComposer.tsx:1440-1485` 的谓词在首个 `'assistant'` 信号上就释放）。因此这条链不是「三只表比大小」，而是：

- 前两项（32s / 195s）是**同一条回合生命线上的两段**：TTFT 管首活性前，stall 管首活性后。
- 第三项（300s）与 stall **不在同一区间上竞争**——渲染端根本活不到 stall 的辖区。300s 之所以必须大于 195s，是因为 R9 形态（`system/init` 后永久静默）的**实际终结者是 stall 而不是 TTFT**，而那正是渲染端唯一还在等的区间。

这条订正很重要：A §1.1 第三条「复位不对称」用「渲染端的表复位得不比 Host 慢」来论证 195s < 300s 是真不变量。实际不需要这个论证——渲染端在 Host stall 的辖区里已经不在等了。**保留数值链，删掉这条论证，改用上面的区间论证**，否则 rev.2 会为一个不存在的耦合写测试。

### 1.2 裁定：复位语义取 A（可复位），命名取 B 的语义清晰度 —— **合取**

A 的「沉默天花板 + 活性帧复位」与 B 的「硬上限、不复位」是互补反例关系：

- A 的反例否掉 B 的硬上限半边：一个持续 `api_retry` 的回合（`session.status.retry` 每次到达都证明链路活着）在 B 的形态下 300s 硬到期，而 Host 的 stall 表在 `api_retry` 不复位的前提下**已经在 195s 开火过了**——所以 B 的硬上限在主路上永远不会先到，它唯一能先到的场景是 Host 两只狗被 env 关掉。B 的硬上限没有害处，但也没有承重。
- B 的反例否掉 A 的无限保活半边：活性帧复位意味着 stderr chatter / 连续 retry 可以把渲染端的等待循环永久续命（50ms 步进的 `while` 循环）。

**合取裁定**：保留 A 的可复位沉默表 **且** 保留 B 所要求的硬性终点，但把 A 的 `SEND_ABSOLUTE_CEILING_MS` **降格定性**：它不是「封顶判决」（判决权已经不在渲染端），而是**轮询循环的资源上界**。命名与注释按此改写，避免下一个读者以为它是第三只狗：

```
SEND_SILENCE_CEILING_MS  = 300_000     // 用户已拍板；活性帧复位；到期 = 停止本地等待
SEND_WAIT_LOOP_BOUND_MS  = 1_800_000   // 50ms 轮询循环的绝对上界；到期动作与沉默到期完全相同
```

两者到期走**同一个出口**（§4 的 `'pending'`），所以不存在两套语义。取 30min 对齐 `CODEX_TURN_START_TIMEOUT_MS`（A §2.3 的理由成立，保留）。

### 1.3 裁定：`sendTimeoutMs` 字节缩放 —— 取 A（整体作废），B 的保留方案被自身证据否掉

A §1.3 的论证【仲裁实测】成立：`normalizer.beginTurn` 在 `queryFn` 之前执行，用户回声在回合受理瞬间发出，与附件字节无关；而 `sendTimeoutMs` 的 30s/MB 缩放（`attachmentLimits.ts:206-210`）建立在「大附件让首个回应更晚」的假设上。改成可复位的沉默表后，回声恒在 t≈0 复位它，字节缩放**恒等于零作用**。

B §11.3 自己也写了「T-02~T-05 不再断言 75/105/180 timeout ⋯ hard ceiling 恒 300s」——即 B 也承认缩放不再影响预算，只想保留 size metadata。但【仲裁实测】`composerSendingLine`（`attachments.ts:354-357`）的 size 展示走的是 `attachmentCount`/`attachmentBytes` 两个**独立入参**，不经过 `sendTimeoutMs`；`largeAttachmentHint`（`attachmentLimits.ts:150-163`）也独立。**所以 B 想保留的 metadata 并不依赖这个函数**，保留它只会留下一个没有消费者的公式。

裁定：`SEND_BASE_TIMEOUT_MS` / `SEND_MS_PER_MB` / `SEND_TIMEOUT_CEILING_MS` / `sendTimeoutMs` **整组退役**，不留兼容别名。连带影响【仲裁实测】：`MessageTimeline.tsx:1236` 的 `DEFAULT_REPLY_BUDGET_MS = sendTimeoutMs(0)` 与 `ChatComposer.tsx:965` 的 `const timeoutMs = sendTimeoutMs(attachmentBytes)` 是仅有的两个生产消费点，均在本批改动范围内。

### 1.4 裁定：拆 `sendBudgets.ts` —— 取 A，但降为「建议」

两轨都承认这是可读性选择而非承重。A 给了原地保留的回退位。裁定：**拆**（`attachmentLimits.ts` 的文件头自述存在理由随缩放公式一起消失），若施工时 diff 过大可原地保留，其余裁定不受影响。**不进拍板清单**（成本极低、可逆）。

---

## §2 题二：活性谓词、api_retry 封顶、模块归属

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| 渲染端谓词形态 | **新增独立函数** `classifyTurnLiveness`，`AssistantProgressSignal` 保持两值 | **扩宽**为 `assistant \| liveness \| ignore` | **分歧** |
| 用户回声三连不许算 progress | 不许 | 不许 | **一致（最高优先级负控）** |
| Host `PRODUCTIVE_EVENT_TYPES` 是否同步扩 | **冻结，一个不加**，补恰等五值静态断言 | 保持不含 `system`（同判），另立三层分类 | **一致** |
| 活性分层数 | 两层（progress ⊆ liveness） | **三层**（productive / interactive / transport） | **分歧** |
| api_retry 封顶落点 | Host 侧靠 stall 不复位（承重）+ 渲染端绝对上限（兜底） | Host 侧 90s 墙钟 cap + `attempt >= maxRetries` | **分歧** |
| 跨轴共享政策模块 | 不建（各轴自持词表） | 新建 `turnWatchdogPolicy.ts` | **分歧** |

### 2.1 裁定：渲染端谓词取 A 的**两函数**形态 —— A 的反例直接否掉 B

【仲裁实测】`classifyAssistantProgress` 现在唯一的消费形态是 `=== 'assistant'`（`ChatComposer.tsx:1242`）。A 的论证成立且可证伪：给返回联合加第三个成员，等于在类型层邀请后来者写 `!== 'ignore'`，那正好把 liveness 误当 progress——即分诊「防错修」明令禁止的「放宽谓词让 `message.delta` 算进度」的复活路径（分诊 `:64-66`）。两值联合关不上这个门，两个函数能。

补一条 A 没写的加强理由【仲裁实测】：`classifyAssistantProgress` 的返回值还被**主等待谓词**间接消费（`:1242` → `sawAssistantProgress` → `:1464` 释放等待），并且 `sawAssistantProgress` 还是 `decideRunEntryOutcome` 的受理证据（`queueRelease.ts:183`）。**一次误宽会同时污染「等待释放」「受理判定」「Retry 装配」三条链**。这是全仓最不能放宽的谓词，独立函数是唯一安全形态。

裁定：新增 `export function classifyTurnLiveness(event, sessionId): 'liveness' | 'ignore'`，落在 `assistantProgress.ts`（同族谓词唯一之家），`classifyAssistantProgress` **一字不改**。

### 2.2 裁定：活性分层取 B 的**三层词表** —— B 命名的是代码已在做的事 —— **合取**

A 的两层（liveness ⊇ progress）与 B 的三层不是竞争关系，是**粒度关系**。B 的 `interactive` 层对应的是两只 Host 狗**已经写在代码里**的 rearm 守卫（stall 的 `permissions.hasPending || questions.hasPending || normalizer.hasOpenTools()`；TTFT 的同款判定）。A 的两层模型没有名字可以指称这条分支，于是 A 在 §3.3 只能把它编码成 liveness note 的 `reason` 枚举——**同一个事实被表达了两次**。

合取裁定：**采用 B 的三层作为跨两端的文档词表**，A 的两个渲染端函数作为它的投影：

| 层 | 含义 | Host 用途 | 渲染端投影 |
|---|---|---|---|
| `productive` | 模型/工具真实产出 | 满足 TTFT + 复位 stall（`PRODUCTIVE_EVENT_TYPES`，**冻结**） | `classifyAssistantProgress === 'assistant'` |
| `interactive` | 明确等待用户或本地工具 | **暂停**强杀（既有 rearm 守卫），不累计为失败 | 已并入 `'assistant'`（`permission.requested` / `question.requested`），**不改** |
| `transport` | 链路在说话但没有产出 | 既不满足 TTFT 也不复位 stall（`system` / stderr / api_retry） | `classifyTurnLiveness === 'liveness'` |

这张表让 A 的包含关系断言（`[L-1]`：progress ⊆ liveness）与 B 的负控（transport ≠ productive）**同时**可写，且把「渲染端把 transport 也算活性、Host 故意不算」这条两端刻意不同的语义写成了一句话而不是三段散文。A §2.4 的冻结裁定与恰等五值静态断言**原样保留**（`claudeRuntimePartialStall.test.ts` 是它的守门人，零改动）。

### 2.3 裁定：api_retry 封顶 —— 两轨的具体数值**全部退役**，取 B 的字段证据 + A 的 stall 兜底

这是本仲裁唯一「两轨皆驳回」的项，理由是本仓对无证据常量的既定纪律。

- A 的 `TTFT_API_RETRY_ABORT_ATTEMPTS = 3`：拍脑袋。SDK 退避是指数的，3 次重试的墙钟跨度可能是 6s 也可能是 200s，计数与「等了多久」脱钩。
- B 的 `API_RETRY_LIVENESS_CAP_MS = 90_000`：B 自己在 OQ2 承认「是设计裁定，不是当前代码/遥测事实」。
- 两者都在**给一个已经有正确兜底的路径再加一层**：【仲裁实测】`api_retry` 走 `system` 事件，不在 `PRODUCTIVE_EVENT_TYPES` 内，因此**不复位 stall 表**，195s 后 Host 必然开火。`claudeRuntimePartialStall.test.ts:126-133` 已经把这条钉死。**封顶今天就存在，且是正确的。**

裁定（三条）：

1. **abort 证据里的重试项改为 `attempt >= maxRetries`**——取 B。这是 `SessionRetryInfo` 已有的字段（`attempt` / `maxRetries` / `delayMs` / `errorStatus`），不引入任何新常量，语义精确到「SDK 自己已经放弃了」。字段缺失时**不猜**，直接不构成证据。
2. **删除 A 的计数阈值与 B 的 90s 墙钟 cap**，两个常量都不落地。理由：195s stall 是既有且经变异验证的兜底，再加一层只会多两个需要维护的数字和一组测试。
3. **A 的现行收紧仍然采纳**：单次 `sawApiRetry === true` 不再构成 abort 证据（现行 `claudeRuntime.ts` 证据门只要它为真就开火，会杀掉本来第 2 次就会成功的回合）。这条是本题的**真正修复**，且不需要任何新常量——`attempt >= maxRetries` 直接替换它。

> 若用户希望在 195s 之前拿到一条**更具体**的 retry 失败文案（而不是笼统的 stall 文案），那需要一个墙钟 cap，属于成本/收益取舍 → 进拍板清单 D3。

### 2.4 裁定：跨轴共享政策模块 —— 驳回 B 的 `turnWatchdogPolicy.ts`，取 A 的各轴自持

【仲裁实测】两轴的事件词表完全不相交：Claude 侧是 SDK 顶层类型（`assistant`/`user`/`result`/`tool_progress`/`stream_event`），Codex 侧是 JSON-RPC 方法名（`turn/started`、`item/agentMessage/delta` …）。可共享的只有 deadline 算术，而 deadline 算术已经在 `ttftWatchdog.ts` 里抽成了可注入 timer 的纯类。B 的 S0 模块会变成一个「两个 adapter + 一个几乎空的核心」的结构。

裁定：**不新建 `turnWatchdogPolicy.ts`**。改为：Claude 侧导出 `PRODUCTIVE_EVENT_TYPES`（A §2.4 已要求，为静态断言服务），Codex 侧在 `codexNormalizer.ts` 导出 productive 方法集（A §10.1 已要求，单一真源）。**共享的是 §2.2 那张三层表这份文档契约，不是一个运行时模块。**

但 B 的 S0 **串行 seam** 本身要保留（协议类型必须先落），见 §11。

---

## §3 题三：TTFT 证据门重设计、R9 洞、协议纪律

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| R9 洞的性质 | **不是 Host 全线失守**；stall 表本来就接管；由不变量反转直接闭合 | 同判「只能等更长 stall」，但要求把无限 rearm 改成一次性降级 | **一致（定性）+ 分歧（机制）** |
| 是否加第三个证据信号 | **明确拒绝**（子串嗅探是本仓栽过的坑） | 未加 | **一致** |
| TTFT 到期的再武装 | 保留 `rearm()`，每轮发 liveness note | 一次性 `ttftDegraded`，永久关表 | **分歧** |
| `!sawAnySdkEvent` 是否仍算证据 | **保留** | **删除** | **分歧（互补反例）** |
| 单次 `api_retry` 即 abort | 收紧（见 §2.3） | 收紧 | **一致** |
| 降级时向渲染端发一帧诊断 | `session.status.payload.liveness`（加法字段） | `session.status.payload.watchdog`（加法字段） | **一致（命名分歧）** |
| 协议版本 | 保持 `1` | 保持 `1` | **一致** |

### 3.1 裁定：R9 定性取 A，机制取 B 的一次性降级 —— **合取**

A 的定性【仲裁实测】成立：`claudeRuntime.ts:755-773` 的 R9 形态确实由 stall 表接管——`onStall` 的复位只来自 `PRODUCTIVE_EVENT_TYPES`（`:794-800`，不含 `system`），所以 `system/init` 到达后永久静默的回合，stall 计时器从 `armStallTimer()` 起算，195s 后必然开火。分诊「Host 全线失守」是过度描述。**这条纠正必须进 rev.2**，否则会有人去实现一个不需要的第三证据信号。

但 A 由此得出「保留 `rearm()` 无成本」是错的，B 的反例成立：`rearm()` 每 32s 重入**同一个必然为假的判断**，且 A 还要在每一轮发一帧 liveness note——那就是一条 32s 心跳流，而仲裁新发现①已证明**渲染端并不需要这条心跳**（渲染端在首个 progress 上就释放等待，「停在权限卡上耗尽沉默表」不可达；而在 R9 形态下渲染端确实在等，但它到期只是进入 `'pending'`，是良性的）。**心跳的唯一真实收益是诊断，不是判决**——为诊断付一条每 32s 的协议流量不划算。

**合取裁定**：

1. 取 B 的**一次性阶段迁移**：TTFT 首次到期且证据不足 → 发**一帧**降级诊断 → 标记 `ttftDegraded = true` → 永久满足/关闭 TTFT 表 → 此后只由 stall 表观察。【仲裁实测】`TtftWatchdog` 已有 `markProductive()` 可永久关表的能力，改动落在 `onTimeout` 的策略而非 watchdog 类本身。
2. 取 A 的 **`reason` 与代码分支一一对应**要求：`awaiting_user`（`permissions.hasPending || questions.hasPending`，`:748-750`）/ `tool_running`（`normalizer.hasOpenTools()`，同处拆开判定）/ `insufficient_evidence`（`:767` 证据门未过）。**注意**：前两者走的是 `:752` 的 rearm 分支，属于「合法暂停」，**不触发降级**（B §2.1 的 `interactive` 层语义），只发诊断帧且 TTFT 表继续武装；只有 `insufficient_evidence` 触发一次性降级。这条区分两轨都没写清，是本仲裁的补齐。
3. 取 A 的**注记改写与陈旧数值订正**：`:755-766` 的 R9 注记块改写为「本形态刻意交给 stall 表；渲染端沉默天花板高于 stall 预算，故 Host 恒先说话」，并删掉 `:760` 的 `120s`（真值 `195_000`，`claudeRuntime.ts:95`）。

### 3.2 裁定：`!sawAnySdkEvent` —— **保留**（驳回 B），但降级为「二次窗口证据」—— **合取**

B §3.2 要删除它，理由是「无帧也可能是健康的长首响应」。这条【仲裁实测】站不住：`!sawAnySdkEvent` 不是「32s 无产出」，是「32s 内连 `system/init` 都没有一帧」。`system/init` 是 SDK 会话初始化帧，它的缺席意味着子进程从未初始化——正是 `:722-723` 注释说的 dead spawn / auth failure。A 保留它是对的。

但 B 的反例指向一个真实场景：**冷启动**（首次 `npx` 拉包、慢盘、杀软扫描）下 CLI 子进程可能超过 32s 才吐第一帧，此时 abort 会杀掉一个只是启动慢的健康回合，而 Retry 会把它推进同一个超时——正是 `:718-719` F1 注记想避免的确定性失败环。

**合取裁定**：保留 `!sawAnySdkEvent` 作为 abort 证据，但**只在第二个 TTFT 窗口成立**。即 TTFT 首次到期时：若 `!sawAnySdkEvent` → **不 abort**，发降级诊断帧并**再武装一次**（这是唯一允许的一次 rearm）；第二次到期仍 `!sawAnySdkEvent` → abort。默认下判死时刻从 32s 后移到 64s，仍远小于 195s stall 与 300s 渲染端上限，链条不破。这样 A 的证据保住了，B 的冷启动反例也被吸收，且**不引入任何新常量**。

> 副作用登记：`claudeRuntimeOptions.test.ts` 中「零帧 50ms 直接 TTFT failed」的现有用例（B 定位在 `:578-602`）必须改为「两个窗口后才 failed」，而不是 B 主张的「永不 failed、交给 stall」。

### 3.3 裁定：诊断帧 —— 取 A 的形状与字段名，取 B 的兼容性举证要求

两轨独立同判「骑在 `session.status` 上做可选字段，不新建事件类型，协议版本保持 1」，先例是 `SessionRetryInfo`。**双轨同判，采纳。**

字段名取 A 的 `liveness`（`SessionLivenessNote`），因为 §2.2 已把「三层活性」立为跨端词表，`liveness` 与之同源；B 的 `watchdog` 描述的是发送者而非内容。

并入 B 的两条纪律：

- B §3.3 要求「若选新事件类型，必须先证明旧 Renderer reducer 对未知事件是 no-op，否则优先可选字段」。既然裁定就是可选字段，这条自动满足，但**要把它写进注记**作为后来者的护栏。
- B §9.4 的「env 覆盖是测试 seam 不是产品灰度」——采纳，见 §9。

**消费方（A §3.3 的「生产者缺席消费者」纪律，采纳并收紧）**：一次性降级后全回合最多两帧（`interactive` 暂停帧可多次），消费方只需两个：① `classifyTurnLiveness` 把 `session.status` 记为 liveness（复位沉默表）；② `formatRuntimeEvent`（`ChatComposer.tsx:151-187`，快修批已打 role）打印它，进 `rawEvents=` 诊断串。**施工时必须实测两者都跑到**，否则是空壳。

### 3.4 施工细节补齐（两轨都漏）

【仲裁实测】`PRODUCTIVE_EVENT_TYPES` 是 `send()` 闭包内的**局部 `const`**（`claudeRuntime.ts:794-800`），不是模块级导出。A §2.4 要求的「导出该集合供静态断言」需要先把它**提升到模块作用域**。这是一个真实的、两轨都没算进影响面的改动，需在 S1 切片里显式列出。

---

## §4 题四：渲染端到期动作重构与静态断言

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| 到期禁止四件事（不 unbind / 不写 lastError / 不 finalize 伪 fatal / 不回显） | 采纳 | 采纳 | **一致（本批核心）** |
| 等待循环可复位 | `waitUntil(pred, expired, step)` 注入到期谓词 + `createSendWaitBudget` 纯模块 | **无复位机制**（硬上限） | **A 独有** |
| 返回形态 | 布尔 + 出口按 `sawUserEcho` 分流 | 判别联合 `progress\|terminal\|cancelled\|safety-ceiling` | **分歧（互补）** |
| 到期后回合头 | store 加第二槽 `pendingReply`，`turnActive` 加第三项 | `finally` 对 detached 不 `endTurnSend`，所有权转移 | **分歧（互补）** |
| 队列第五道门（detached latch） | 无 | `canStartTurn` 新增 detached 门 | **分歧** |
| 到期不得用 `getHostStatus()` 投票判死 | 未明说（保留在 `'rejected'` 分支的诊断串里） | 明确禁止，只作诊断 | **B 独有，采纳** |

### 4.1 裁定：可复位预算 —— 取 A（B 无对应机制）

A 的 `createSendWaitBudget(startedAtMs, {silenceCeilingMs, loopBoundMs})` 纯函数模块（`markLiveness` / `isExpired` / `lastLivenessAtMs`）是 §1.2 可复位语义的唯一落地形式，且无定时器、无 store，node 环境可直测。采纳，含 A 的接线形态：

```
if (classifyTurnLiveness(event, sessionId) === 'liveness') budget.markLiveness(Date.now());
```

紧邻既有的 `classifyAssistantProgress` 那行（`ChatComposer.tsx:1242`）——两条并排即为「liveness 不等于 progress」的现场佐证，也是静态断言 `[S-6]` 的锚点。

`waitUntil` 换签名影响三个调用点，【仲裁实测】全部在同一文件内：`:1371`（create 握手 5000ms）、`:1440`（主等待）、`:1538`（resume 握手 5000ms）。两个握手点传固定截止谓词，语义不变。

### 4.2 裁定：分支形态 —— 取 B 的判别联合作为**分支标签**，取 A 的分流判据 —— **合取**

两者信息量相同（A 的 `sawUserEcho` 分流 = B 的 `safety-ceiling` vs `terminal`），但 B 的显式 `case` 标签有一个 A 没有的硬收益：【仲裁实测】本仓对 `.tsx` 不可测事实的既有工法是**源文静态断言**（`composerStopStatic.test.ts` 头注明文说 `.tsx` 闭包无法直接执行）。以 `case 'safety-ceiling':` 到 `case 'terminal':` 之间的源文切片作断言锚点，比 A 的「pending 分支体」锚点稳定得多——后者依赖变量命名不变，前者依赖分支标签不变。

**合取裁定**：`sendAndWait` 返回判别联合 `'progress' | 'terminal' | 'cancelled' | 'ceiling'`；到期出口在 `'ceiling'` case 内，**再**按 A 的 `decideAdmittedTimeoutOutcome({sawUserEcho, sawAssistantProgress})` 分流为 `'pending' | 'rejected'`。两层不冗余：第一层说「渲染端为什么停止等待」，第二层说「Host 到底受理了没有」。

并入 B 的两条约束：
- `finally` 需以标志区分：仍清 ticker / listener / `inFlightRef` / `sending`，其余按 §4.4 裁定。
- 到期**不得**用 `getHostStatus()` 投票判死；现行 `:1779` 的探针**只保留在 `'rejected'` 分支**的 `abandonError` 诊断串里（那条路径本来就是真失败），`'pending'` 分支**不调用它**（省掉一次 IPC 往返，也杜绝「`state !== ready` 就判死」的诱惑）。

### 4.3 裁定：`RunEntryOutcome` 加 `'pending'` —— 采纳 A，但**理由必须换掉**（P0 纠错）

A §4.3 写「加成员是刻意的——TypeScript 会在 5 个消费点逐点报错，强制复审」。**【仲裁实测】这是错的，且是危险的错**（仲裁新发现②）。五个消费点没有一处是穷尽 `switch`：

```
queueRelease.ts:227  if (outcome === 'committed') return false;  // 其余 return !(rejected && release)
queueRelease.ts:254  if (outcome === 'committed') return 'restore-draft';
queueRelease.ts:289  return outcome === 'rejected' && origin === 'release';
queueRelease.ts:353  return outcome === 'committed';
useQueueRelease.ts:84  if (result === 'skipped' || result === 'rejected') restoreHead(entry);
ChatComposer.tsx:563   if (outcome !== 'committed') return;   // maybeApplyFirstMessageTitle
```

加 `'pending'` 后**零编译错误**，静默默认值为：

| 消费点 | 加成员后的静默默认 | 是否正确 | 后果 |
|---|---|---|---|
| `shouldArmRetryable` | `true` | ❌ | **一键 Retry 装上 = 双发**（本仓 A1 轮次专门修掉的缺陷复活） |
| `decideFailureAffordance` | `'resend'` | ❌ | **同上**，且与用户裁定直接冲突 |
| `shouldPauseQueueOnRejection` | `false` | ✅ | 队列条目已花掉，无重放环 |
| `shouldClearRetryableOnOutcome` | `false` | ✅ | `'pending'` 不证明任何事 |
| `useQueueRelease` 回填 | 不回填 | ✅ | 结构性不会被回填重发 |
| `maybeApplyFirstMessageTitle` | 不改标题 | ⚠️ | 首条消息超时也已进 CLI transcript，A 主张应照常生成标题 |

**裁定**：A 的六条逐点裁定**全部采纳并升格为强制项**（不是「TS 会提醒」，是「不写就是 P0 双发」）；`decideFailureAffordance('pending', *) === 'none'` 是本批的**承重断言**（用户裁定的可执行形式）；新增 `isAdmittedOutcome(o) = o === 'committed' || o === 'pending'` 供 `useQueueRelease` 与 `maybeApplyFirstMessageTitle` 共用。变异计划里 M6/M7 因此从「回归保护」升格为「P0 咬合」。

### 4.4 裁定：回合头保活 —— 取 A 的 store 第二槽（B 的方案有冻表缺陷）

B §4.1 主张 `finally` 对 detached 不调 `endTurnSend(sendOwner)`，让既有 `sendStatus` 快照存活，从而 `inFlight = isLastTurn && sendStatus != null` 自然为真，无需改 `turnActive`。**【仲裁实测】这条有一个 B 没看到的缺陷**：驱动 `sendStatus.elapsedSeconds` 的是 `runSend` 里的 `ticker`，而 `finally` 的第一行就是 `window.clearInterval(ticker)`（`ChatComposer.tsx:1864`）。不 `endTurnSend` 只会得到一个**冻结在 300s 的秒表**，除非再造一个 ticker 所有者——那正是 B 的 "detached tracker" 要新增的机器。

A 的方案不需要新 ticker：`MessageTimeline` 自己有 `useSecondsTick`（`:287`）与 `nowMs`，从 `turnStartedAtMs` 现算即可。

**B 对 A 的反驳（元数据丢失）经核对不成立**【仲裁实测】：`sendStatus` 被清后丢的是 `phase` / `budgetMs` / `attachmentCount` / `attachmentBytes`，而到期后走的 `slow` 分支（`attachments.ts:351-353`）**这四项一个都不读**；最有价值的 `retry` 后缀走的是**另一条独立通道**（`MessageTimeline.tsx:1010` 从红线 store 读 `retry`，不经 `sendStatus`），**不受影响**。

裁定：取 A 的形态，行号按 F10 后现状订正：

```
// MessageTimeline.tsx:952-963（A 稿写的 :935-946 是 F10 前的行号）
const pendingReply = useTurnSendStatusStore(s =>
  s.pendingReply && s.pendingReply.sessionId === sessionId ? s.pendingReply : null);
const pendingActive = isLastTurn && pendingReply != null;
const turnActive = inFlight || streamStartedAt != null || pendingActive;   // ← 第三项
// elapsedSeconds 追加 pendingActive 分支，从 pendingReply.turnStartedAtMs 现算
```

配套三处【仲裁实测】全部成立：① `useSecondsTick(inFlightSession || sendStatus != null)`（`:287`）中 `inFlightSession = isTurnInFlight(status)`（`:272`），到期时会话状态仍是 `'running'`，秒表继续走；仍按 A 建议把 `pendingReply != null` or 进 enable 条件防状态先落地。② Stop 入口**已存在**，无需新按钮：`deriveActionButtons`（`queueRelease.ts:431`）在 `isRunningStatus(status) || sending` 时给 Stop，`'running'` 在集合内（`:405-409`）——这是保留 `'pending'` 态而不解绑 Host 的额外红利。③ `DEFAULT_REPLY_BUDGET_MS`（`MessageTimeline.tsx:1236`，A 稿写的 `:1221` 为 F10 前行号）换源为 `SEND_SILENCE_CEILING_MS`，`slow` 分支不打印 `(up to Ns)`，无矛盾。

store 落点取 A 的 `turnSendStatus.ts` 加第二槽（`baseline` 槽已有「刻意比 status 活得久」的先例），**只放展示事实不放 payload**（`committed` 含 base64 附件，留在组件 `pendingReplyRef`）。**驳回 B 的独立 `detachedTurn.ts` store**——多一个 store 就多一处 `MessageTimeline` selector 与 session 切换的竞态面，而 A 的方案复用已有的 owner/session 作用域纪律。

### 4.5 裁定：B 的「第五道门」—— **不新增生产状态，改立不变量断言**

B §4.1 要求 `canStartTurn` 增加 detached latch，防止 Host status flush 延迟时误放第二个 send。**【仲裁实测】今天已经堵住**，且是双保险：

- `decideQueueRelease`（`queueRelease.ts:119-133`）在 `input.status !== 'idle' && !== 'completed'` 时返回 `hold('not-idle')`；`'pending'` 期间 Host 未发终态，status 恒为 `'running'` → **队列不放行**。
- `canStartTurn` 的 `busy = isStoppable(status)`（`ChatComposer.tsx:439`，`:141` 定义）在 `'running'` 下为真 → 手动 Send 走 `'enqueue'` 而非新回合，且圆按钮此时呈现的是 Stop。

方向性也是安全的：这条依赖若失效，失效方向是「队列held 太久」（Host 崩溃场景，见 §6），**永远不会是「放行太早」**。

裁定：**不新增 latch**（避免在最敏感的发送门上加第五个条件），改为把 B 的契约立成**测试级不变量**：`[Q-1]` 对 `pendingReply != null` 的会话，`decideQueueRelease` 与 `canStartTurn` 必须同时为 hold/false（遍历九个 status，只有 `idle`/`completed` 放行，而这两个 status 与 pendingReply 共存本身就是矛盾态——用例断言该组合不可构造或必须先清 pendingReply）。

---

## §5 题五：restore-draft 收窄与迟到回复清理链

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| `'pending'`（猜测性超时）→ `'none'` | 采纳 | 采纳 | **一致（承重）** |
| `'committed'` + **确定死亡** → 是否回显 | **`'restore-draft'`**（用户裁定的直接实现） | **`'none'`**（只给 `rejected + direct\|retry`） | **分歧（产品取舍）** |
| 「Recover text」显式按钮 | **不做**，把 affordance 推迟到证据到达时刻 | 未提议 | **一致（不做）** |
| 自动回显的 provenance marker | 无 | `RestoredDraftMarker{sessionId,requestId,text,draftIds,valueRevision,attachmentRevision}` | **B 独有** |
| 迟到清理链顺序 | 保留既有两个 effect + `resolveAbandonProgress` 逐字不变 | 八步有序清理链，含撤销自动回显 | **分歧（互补）** |
| 用户已编辑后不得按值相等删除 | 未涉及 | 明确禁止 | **B 独有，采纳** |

### 5.1 裁定：`'pending'` → `'none'` —— **双轨同判，本批承重条**

猜测性超时既不报错也不回显。这是用户裁定「只有明确确定回合死亡才允许回显输入 + 红色报错」的直接实现，且 §4.3 已证明它必须**显式写出来**（否则静默默认是 `'resend'`）。双层保险：纯函数层 `[P-2]` + 源文层 `[S-3]`。

### 5.2 裁定：A §5.2 的架构论断**采纳并升格为本题的判据**

A 的核心论断经复核成立且值得抄进 rev.2 原文：**affordance 不是超时的函数，是死亡证据的函数**。用户裁定原文本身就规定了架构。由此：

- 「Recover text」按钮**不做**（A 与 B 一致）。加按钮等于承认超时时刻需要一个动作，那还是把猜测搬到了 UI 上。
- 文本没有丢：回合已受理 ⇒ 用户消息**已在时间线里**（`beginTurn` 的回声写成 user 气泡，`MessageTimeline.tsx` 的 `whitespace-pre-wrap` 可选中可复制）。
- `pendingReplyRef.current.committed` 一直在内存里等着；一旦确定死亡到达，用**同一个** `restoreDraftIfComposerEmpty`（含「composer 非空就不覆盖」的 F4 防覆写）把料放回去。因果顺序正确。
- 若来的是 `session.completed` / `stopped` / 迟到回复，ref 静默丢弃，输入框全程没被动过——分诊缺陷 3 的**主半边从源头消失**。

### 5.3 分歧：`'committed'` + 确定死亡是否回显 —— **上交拍板（D1）**

这是本仲裁**不替用户拍板**的第一项，因为它是对用户已下裁定的**解读分歧**，不是技术分歧：

- **A 读作充分条件**：确定死亡 ⇒ 允许回显。矩阵 `committed → 'restore-draft'`（保持今日行为，只是触发时机从超时后移到证据到达）。
- **B 读作必要条件**：确定死亡是允许回显的**前提之一**，还要加「从未被受理」。矩阵 `committed → 'none'`，只有 `rejected + direct|retry` 才回显。

双方各有真实理由。A：一个确定失败且零产出的已受理回合，用户十有八九要改一改重发，把料放回输入框省一次复制；`restoreDraftIfComposerEmpty` 已有防覆写。B：已受理意味着文本已在时间线，回显再点 Send 就是双发第二个回合，而红卡旁边同时出现一份可发的草稿，是在诱导这个动作。

**本仲裁倾向 A**，理由：`session.failed` 之后不可能再有迟到回复落到同一回合，所以双发风险是「用户主动决定重发」而非「误发」；且 B 的矩阵会让今天唯一合理的回显场景（握手致命错 / `ensureHost` 抛错但已有回声）也失去回显，属于把缺陷修过头。但这是产品取舍，**必须由用户决定**。

### 5.4 裁定：B 的 `RestoredDraftMarker` provenance —— **采纳（合取）**，但按 D1 结果定成本

B §5.2 指出的洞【仲裁实测】真实存在：`restoreDraftIfComposerEmpty`（`ChatComposer.tsx:1049-1058`）只比较 composer 是否为空，**没有 provenance**；而 `clearAbandonMarkerIfMatch`（`:1938-1955`）只清 `lastError`（对象值相等）与 `retryable`（对象同一性），**从不撤销已回显的文本/附件**——这正是分诊缺陷 3 的字面根因。

A 认为该状态在新形态下不可达。**仅对超时路径成立**；对 §5.3 若取 A 的矩阵，`committed + 确定死亡 → 回显` 这条路径仍会写入一份用户没打的草稿，而 Host 退出广播（§6.2）合成的 `session.failed` 是**可能与真实回合状态不同步**的（Host 重启后旧回合确实死了，但合成时机与真实终结之间有窗口）。所以残留半边仍需要 provenance。

裁定：
- 若 D1 取 A（committed 仍回显）→ **`RestoredDraftMarker` 必做**，含 B 的两条纪律：① 迟到事件只在 `text/draft revision 均未变` 时才撤销自动回显；② 用户一旦编辑，marker 失效但内容保留，**禁止按值相等删除用户的新输入**。落点复用既有的对象同一性写法先例（`:1944-1952`）。
- 若 D1 取 B（committed → none）→ 自动回显只剩 `rejected + direct|retry` 一条（Host 从未受理，不可能有迟到回复），provenance 降为**可选加固**。

### 5.5 裁定：迟到清理链 —— 取 A 的资产保留 + 取 B 的有序化 —— **合取**

A 要求既有两个 effect（`ChatComposer.tsx:1957-1973` 进度 effect、`:1984-1991` `session.completed` 订阅）与纯函数 `resolveAbandonProgress`（`assistantProgress.ts:266-276`，含向下重基线的 B2 修复）**逐字保留**。【仲裁实测】这条正确：那是专治「回放历史误清」的资产，B 的八步链没有覆盖 `resolveAbandonProgress` 解决的重基线问题（B 只写了「cursor 防 history replay」的引用，没写重基线）。

B 的有序化补的是 A 缺的一半：**清理必须先于 reducer 应用新事实**，否则清理后的旧状态覆盖新事实。以及 sessionId（有 requestId 时并验 requestId）的作用域前置。

合取后的链（A 的机制 + B 的顺序）：

1. 验 sessionId（协议带 requestId 时并验）——禁止跨回合清理；
2. 读取并冻结当前 `pendingReplyRef` / `RestoredDraftMarker`；
3. 走 `resolveAbandonProgress` 判 landed（保留向下重基线）；
4. 清 `pendingReply`（store + ref），回合头交回 streaming/terminal；
5. 仅在 `lastError === marker.error` 时清旧错误（既有写法保留）；
6. 仅在 `retryable === marker.committed` 时清旧 retryable（对象同一性，既有写法保留）；
7. 仅在 restored marker 仍有效且两个 revision 均未变时撤销自动回显（§5.4）；
8. marker 置空；最后让 reducer 应用新事实。

新增不变量断言（A `[D-4]` 的升级版）：`'pending'` 分支执行后，`valueRef.current` 与 `attachments.getLiveDraftCount()` 与分支执行前**逐字节相同**——把「不许回显」钉成可测事实，而不是靠人读代码确认少了一行。

---

## §6 题六：确定死亡判据清单

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| `session.failed` = 唯一红卡+回显触发 | 采纳 | 采纳 | **一致** |
| `session.stopped` / `completed` 静默结束 watch，不出红卡 | 采纳（对分诊 C 的收窄） | 采纳（completed 零块也是 clean） | **一致（对分诊的同向纠偏）** |
| Host 进程退出 / IPC 断连是判据清单的洞 | **新发现①**，要求 Main 侧补会话级终态广播 | §6.2 同判，要求合成 `host.disconnected` | **一致（本批最重要的合取）** |
| 清洁退出不广播 | `code===0 \|\| signal==='SIGTERM'` 不广播 | intentional shutdown 不发失败 | **一致** |
| 去重（error 无 exit / error+exit 双发） | 未涉及 | 明确要求 | **B 独有，采纳** |
| open-session 台账来源 | 「若成本过高则降级为 `host.error`」 | 列为 OQ5，未定 | **两轨皆未解，本仲裁补** |
| 纯时间、单次 `getHostStatus` 失败、长时间 `running` 均**不**是死亡 | 隐含 | 明确列负控清单 | **B 独有，采纳** |

### 6.1 裁定：判据表取两轨并集，**`session.failed` 是唯一红卡入口**

两轨表格合并后无冲突。承重条三条：① `session.failed`（`isSessionFailedForSend`）是唯一同时触发红卡与回显的判据；② `stopped` 是用户意图、`completed` 是正常终态（含零助手块的 clean completion），**都静默结束 watch，不出红卡**——这是两轨对分诊方向 C「completed 无产出也算死亡」的**同向纠偏**，采纳；③ 纯时间（32s/195s/300s）、普通 stderr、单次 `api_retry`、长时间不变的 `session.status(running)`、`getHostStatus()` 单次失败、渲染端背景节流——**一条都不是确定死亡**（B 的负控清单，采纳）。

### 6.2 裁定：Host 退出广播 —— **双轨同判，本批必做**，并补两轨都没解的台账来源

【仲裁实测】A 的新发现①成立：`AgentHostManager` 的进程 `exit` / `error` 处理只写 `this.state` 与日志，**不向渲染端广播任何 RuntimeEvent**；渲染端唯一的 Host 存活通道 `chat.getHostStatus()` 只在旧 abandon 分支被一次性调用。后果：Host 崩溃时所有活跃会话永久停在 `'running'`——Stop 在、点了没用、没有终态、`'pending'` watch 一直转秒，且 §4.5 的队列门会**永久 hold**。

**这是本批的红线前置**：不补它，新形态在崩溃场景下比旧形态更糟（旧形态至少 45s 后报个错）。A 的风险表把它列为**高**并要求 S5 先于 S3 合入——采纳。

裁定形态（A 的事件复用 + B 的去重与作用域）：

```
AgentHostProcess 'exit' / 'error'
  → 非清洁退出（排除 code===0 || signal==='SIGTERM'，即我方 shutdown()）
  → 对「本进程生命周期内仍开着的会话」逐个广播：
       session.status { status: 'disconnected' }     // 已有成员，零协议新增
       session.failed { error: 'Agent Host exited (code=… signal=…)' }
  → 去重：'error' 后紧跟 'exit' 只广播一次；'error' 后无 'exit' 也必须广播
```

`'disconnected'` 已是 `SessionRuntimeStatus` 合法成员并已被两轴 `close()` 使用，零协议新增。`session.failed` 让渲染端既有的 `isSessionFailedForSend` 通道直接接住 → 红卡 + 回显（§5.2 的正确因果）。

**两轨都没解的 open-session 台账来源，本仲裁给出推荐解**：`AgentHostManager` **已经**是每一条 RuntimeEvent 的转发点，可以在转发的同时维护一份 sessionId 台账，零新增管道——`session.created` / `session.resumed` 入账，`session.status(idle|failed|completed|disconnected)` / 会话关闭出账。这比 B 的 OQ5 两个候选（跟 `message.started(role:user)` 或跟 command lifecycle）都窄且不漏：它跟的是**会话**而不是**回合**，而广播的粒度本来就是会话级。B 要求的 crash-mid-turn fixture 证明「不漏、不误报 idle session」——采纳为该切片的收口条件。

**降级方案（A 提出，保留为最低可接受形态）**：只广播一条 `host.error { code:'host_exited', fatal:true }`（无 sessionId），渲染端 `runSend` 的 host.error 通道能接住在飞的那一条；代价是后台会话仍停在 `'running'`。

**若整条另立票**：§4 的 `'pending'` watch 必须带兜底——进入 pending 后周期性轮询 `chat.getHostStatus()`，`state !== 'running'` 视为确定死亡。→ 拍板项 D2。

---

## §7 题七：Codex 轴看门狗与 30 分钟 ack

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| 补同款双狗（不接受渲染端权威） | 采纳 | 采纳 | **一致（分诊 H 二选一，两轨同选前者）** |
| TTFT 默认值 | `45_000`（ack 时机 [未测]，给余量） | `32_000`（与 Claude 对齐，避免 40 倍哲学错配） | **分歧** |
| stall 默认值 | `195_000` | `195_000` | **一致** |
| 30min ack 处置 | 保留不动，降级为连接层兜底 | 保留不动，与 watchdog 各管各的；**不得改成 195s** | **一致** |
| 「不渲染 ≠ 没产出」 | **A 独有的关键判据**：`turn/plan/updated` / `item/plan/delta` / `turn/diff/updated` 必须算 productive | 未列 | **A 独有，采纳** |
| connection 级 `lastActivityAt` 不可直接当活性 | 未涉及 | **B 独有的关键判据** | **B 独有，采纳** |
| turnId 未知时不得伪造 interrupt | 采纳（引 schema 注记） | 未涉及 | **A 独有，采纳** |

### 7.1 裁定：补双狗 —— **双轨同判**，A 的结构性论证采纳为理由原文

A 的论证【仲裁实测】成立且比 B 更硬：`runSend` 全程**不知道自己在跟哪个 agent 说话**（`turnAgent` 只用于选 model/effort/permission）。若 Codex 轴保留渲染端权威，就要么在最敏感的发送路径写一个 agent 分支，要么让 Codex 轴继续被沉默天花板误判——两者都不可接受。

现状风险【仲裁实测】确认：`codexRuntime.ts` 全文无 stall / TTFT 计时器，只有 `CODEX_TURN_START_TIMEOUT_MS = 30 * 60_000` 的 `turn/start` ack 兜底，且其头注自认 ack 时机 `[未测]`。一个 wedged 的 Codex 回合今天最长 30 分钟无裁决。

### 7.2 裁定：活性词表取两轨并集 —— A 的正向判据 + B 的负向判据 —— **合取**

两条判据互补，**各自否掉对方的一半盲区**，正是「互补反例合取」的教科书形态：

- **A 的正向判据（B 缺）**：`CODEX_IGNORED_NOTIFICATIONS` 是**渲染决策表，不是活性表**。【仲裁实测】其中 `turn/plan/updated`、`item/plan/delta`（注：`plan items are not rendered this round`）、`turn/diff/updated`（注：`cumulative turn diff; the per-item fileChange rows already carry every patch`）三条**确属模型产出**，只是我们选择不渲染。把这张表当活性表用，会让一个正在写 plan 的回合被判死。**必须算 productive。**
- **B 的负向判据（A 缺）**：不能直接拿 connection 级 `lastActivityAt` 当 watchdog 活性——该 hook 统计**双向**所有 frame，Host 自己发出的 request/response 或 rate-limit chatter 就能永久保活。watchdog adapter 必须在 connection-level activity 与 turn-level 活性之间分层。

合并后的 Codex 三层表（承 §2.2 词表）：

| 层 | Codex 信号 |
|---|---|
| `productive` | `turn/started`、`item/started`、`item/completed`、`item/agentMessage/delta`、reasoning 三条 delta、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`、`item/mcpToolCall/progress`、`thread/tokenUsage/updated`、`turn/completed`、**以及被刻意忽略但确属产出的 `turn/plan/updated` / `item/plan/delta` / `turn/diff/updated`** |
| `interactive` | pending server-request（question/approval）非空、`thread/status/changed` 的 waitingOnUserInput/Approval、有未 settle 的 `item/started`（命令执行中）→ **暂停强杀**，发诊断帧 `reason:'awaiting_user'` / `'tool_running'` |
| `transport` | `account/rateLimits/updated`（**Codex 轴的 api_retry 类比物，恰恰不能算活**）、`thread/status/changed` 的 running、`serverRequest/resolved`、`thread/settings/updated`、`thread/started`、任意 JSON-RPC response、connection 级 `lastActivityAt` |

### 7.3 裁定：TTFT 默认值取 B 的 `32_000` —— 分歧被证据消解

A 取 45s 的理由是「`turn/start` ack 时机 [未测]，给足余量」。**【仲裁实测】这个理由不成立**：Codex 的首个 productive 帧是 `turn/started` **通知**，与 `turn/start` **请求的 ack** 是两条独立通道；watchdog 键在通知上，ack 时机的不确定性与 TTFT 无关。

且两轨已同判「TTFT 到期本身不构成 abort，只在证据成立时才 abort」（§3.2 的规则同样适用于 Codex 轴）。既然裸到期永不判死，32 与 45 的差别只是**第一帧诊断何时发出**。取 32s：与 Claude 同值，一个常量族，分诊「40 倍哲学错配」在两端都收敛。

```
CODEX_STALL_TIMEOUT_MS = 195_000   env AICLIENT_CODEX_STALL_TIMEOUT_MS，<=0 禁用（= 今日行为）
CODEX_TTFT_TIMEOUT_MS  =  32_000   env AICLIENT_CODEX_TTFT_TIMEOUT_MS，<=0 禁用
```

### 7.4 裁定：abort 动作按阶段分叉 —— 取 A（B 未涉及）

【仲裁实测】`buildTurnInterruptParams`（`codexRuntime.ts:364-369`）与其头注确认：`TurnInterruptParams` **两个 id 都必填**，单 id interrupt 是 schema 错误——「一个从不中断的中断，而我们的日志声称发过」。

- **turnId 已知**：`turn/interrupt` + `finishTurn(state,'failed',msg)`。
- **turnId 未知**（TTFT 阶段，`turn/start` 尚未应答）：**不得伪造 interrupt**。改为 `finishTurn(state,'failed',msg)` + 退休本回合，此后迟到的 `turn/start` 响应由既有守卫静默吞掉。**残留**：codex 侧可能仍在跑那个回合 → 拍板项 D4。

### 7.5 裁定：30 分钟 ack —— **双轨同判，保留不动**

两轨都要求保留且都明确**不得缩短**（B 引 `[未测]` 注记：ack 可能合法地在 turn end 才回，缩短会把健康长回合误判失败）。分工：watchdog 管回合生命周期与活性，30min timer 管一个 outstanding JSON-RPC promise 的资源释放；任一方先到，另一方的清理路径都已存在（connection teardown reject pending / send catch 的 `finishTurn('failed')`）。B 的双向竞态用例要求采纳。

---

## §8 题八：`SLOW_WAIT_HINT_SECONDS` 死路径的处置边界

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| slow 分支是不是全局死代码 | 「文案从未被看见过」 | **不是**：附件路径预算 75/105/180s，62s 文案被逐字钉住 | **B 纠错成立** |
| `SLOW_WAIT_HINT_SECONDS` 是否上调 | **不上调**（对分诊 A 的改判） | 未主张上调 | **一致（不上调）** |
| 45s~上限窗口用什么文案 | **复用既有 `slow` 分支** | 文本路径**不激活** slow，另设 detached 展示 | **分歧** |
| 死文案审读 | **逐项做了**，结论逐字保留 | 未做 | **A 独有，采纳** |
| 本批不改文案措辞 | 采纳（§8.4 零改动） | 采纳（明确列为后续文案批） | **一致（越界纪律）** |
| `slow` 的 `text-warning` 色阶 | 移交 F4，建议第二档阈值 | 未涉及 | **A 独有，采纳** |

### 8.1 事实纠错：slow 分支**不是**全局死代码 —— B 正确

【仲裁实测】`composerSendingLine`（`attachments.ts:351-353`）与 `deriveTurnStatus`（`turnStatus.ts:118`）都在 `elapsed >= 45` 切换，而附件路径的预算是 75/105/180s（`sendTimeoutMs`），因此 45s→预算终点这段窗口**今天就在渲染 slow 文案**，且被逐字钉住两处：`attachments.test.ts:357`（`Still waiting · 62s — gateway latency varies. Stop to abort.`）与 `:436`（带 `Retry 7/10` 后缀）。

A 说的「巧合造成的遮蔽」**只对文本无附件路径成立**（`SEND_BASE_TIMEOUT_MS` 与 `SLOW_WAIT_HINT_SECONDS` 都是 45，到期与文案切换同一秒发生，且到期立刻 `endTurnSend` 清表 → 失表）。这条订正必须进 rev.2，否则会有人把 `attachments.test.ts` 的两条逐字断言当作陈旧钉住退役掉。

### 8.2 裁定：阈值 **保持 45，不上调** —— 取 A，但换掉理由

分诊 A 把 `SLOW_WAIT_HINT_SECONDS` 列进「联动上调」清单，两轨都不上调。采纳 A 的裁定与其核心论证：把预算抬到 300s 而阈值留在 45s，恰好让 45s→300s 这段窗口成为「仍在等待」的**可见态**——正是 §4.4 需要的那个态。上调阈值反而会把这段窗口重新变成沉默。

理由中「文案从未被看见过」一句按 §8.1 订正为「文本无附件路径从未被看见过；附件路径一直可见且已被钉住」。

### 8.3 裁定：45s~上限窗口的文案 —— 取 A（复用 slow），驳回 B 的「文本路径不激活」

B 主张文本路径始终走普通 awaiting/streaming 时钟，不因预算抬到 300s 自动启用旧 slow 分支，理由是「F2 不应顺手改变已可达 UI」。**驳回**，三条理由：

1. 反了：B 的方案才是改变——它要给 `deriveTurnStatus` 的 slow 判定加一个「是否有附件」的新条件，而 `turnStatus.ts:115-118` 的注释明文写着阈值**从不重新声明**、`kind` 与 copy「只能一起翻」。加附件条件会让 kind 与 copy 的同源关系断裂，正是 B 自己在 §8.2 要求避免的「kind/copy 分裂」。
2. 若文本路径不激活 slow，200s 时用户看到的是 `Waiting for Agent Host reply · 200s (up to 300s)`——一个**预测终点**的句子，而这个终点到了什么也不会发生（§4 的 `'pending'` 不是终点）。这比复活 slow 更不诚实。
3. A 的死文案审读【仲裁实测】逐项成立：「Still waiting」（此分支要求 `hasBlocks === false`，`turnStatus.ts:102` streaming 优先级更高，确实一个 token 都没到）、「gateway latency varies」（`attachmentLimits.ts:168-172` 记录同一负载跨日 ~8x 波动）、「Stop to abort.」（§4.4 已核 Stop 在 `'running'` 下确实呈现且 `'pending'` 不解绑 Host，真能到达）、Retry 后缀与 `session.status.retry` 同源非嗅探、语气中性不指认失败。**文案逐字保留，本批不改。**

并入 B 的一条要求：`kind` 与 copy 必须继续同源（今天已是，两者都键在 `SLOW_WAIT_HINT_SECONDS` 上）——立成回归断言，防本批顺手拆开。

### 8.4 裁定：色阶与 `(up to Ns)` 从句 —— **双轨同判移交 F4**

A §8.3 的观察成立：新形态下 `slow` 会成为「首 token 慢于 45s」的常态，持续数分钟的 `text-warning`（`MessageTimeline.tsx:1389`，A 稿写的 `:1372-1377` 为 F10 前行号）属告警疲劳。但改色阶属装饰/文案族 → **本批不动，记 F4 移交项**，建议形态：`slow` 保持 muted，另设第二档阈值（如 180s）才转 warning。

`(up to Ns)` 从句在新语义下是否还该存在，同样移交 F4。本批对 `attachments.ts:321-359` 的改动为**零**，只由调用方把 `budgetMs` 换源，属纯参数变化。

---

## §9 题九：切片、门禁、变异与灰度

| 项 | A 判 | B 判 | 状态 |
|---|---|---|---|
| 切片形态 | 五片，`S1∥S2∥S5 → S3∥S4` | 六片，S0 串行 seam 先合，S1~S5 文件互斥并行 | **分歧（互补）** |
| 渲染端半边加布尔 flag | **不加**，显式偏离规范 #6 并论证 | **不加**任何用户可见 flag，也不双轨运行 | **一致** |
| Host 新增能力的 flag | liveness note / Codex 双狗 / 重试阈值各有 env 位 | env 覆盖是**测试 seam**，不是产品灰度 | **一致（措辞分歧）** |
| 是否算行为破坏 | **算，且刻意**，列三条可观测变化 | 未显式判定 | **A 独有，采纳** |
| 变异纪律 | 逐对指名承重行、flip 前预检双唯一、零跳过 | 禁止改字面使其通过、禁止拿生产函数当自己的 oracle | **合取** |
| 时间测试 | 未明说 | fake clock / 20~100ms env override，真实 timer 只留一个 smoke | **B 独有，采纳** |

### 9.1 裁定：切片取 B 的 S0 seam + A 的依赖序与红线前置 —— **合取**

B 的 S0 论证成立：共享类型（`runtimeEvents.ts` 的 `SessionLivenessNote` 加法字段）若与各轴并行修改必冲突，必须先串行合入。A 的并行图声称「S2 只依赖 S1 敲定的数值」——不完全成立，`formatRuntimeEvent` 打印 liveness note 需要该类型。

A 的**红线前置**是 B 缺的、且更重要的一条：**S5（Host 退出广播）必须先于 S3（渲染端不判死）合入**，否则中间态在 Host 崩溃场景下比旧形态更糟（旧形态至少 45s 后报个错，新形态永远转秒）。这条进合并后的方案（§11）。

**驳回 B 的 `turnWatchdogPolicy.ts` 独占文件**（§2.4 已裁），S0 缩为纯类型 seam。

### 9.2 裁定：flag —— **双轨同判「渲染端半边不加布尔 flag」**，偏离规范 #6 需用户确认

两轨独立同判：不为「撤销一个错误裁决」做布尔开关。A 的论证采纳为原文：为它做 flag 意味着在产品里保留一个「我们已证明它会对活着的回合打红叉」的位置——那不是安全网，是把缺陷做成配置项。

可回退性由三样东西提供：(a) 两个天花板是常量，改数即回退量级；(b) 分片提交，S3 可单独 revert 而 S2 留存；(c) 回归三档里把本次现场样本（admitted-but-no-reply）立成 incident 用例。

A 与 B 在 Host 半边的措辞分歧是**表面的**：A 的 `AICLIENT_CODEX_*_TIMEOUT_MS = 0` / `AICLIENT_HOST_LIVENESS_NOTE='0'` 与 B 的「测试/诊断 env 覆盖」是同一个东西。统一措辞：**env 阈值与静音位是测试 seam 与运维旋钮，不是产品灰度；`0`/`'0'` 的语义必须精确等于今日行为。** 保留 A 为 liveness note 设的静音位（形态对齐 `resolveSubagentActivityEnabled` 先例），因为一次性降级后该帧全回合最多两帧，静音位主要服务于 wire 快照测试的确定性。

**对规范 #6 的显式偏离仍需用户确认** → 拍板项 D5。

### 9.3 裁定：行为破坏范围 —— 取 A 的三条，订正第三条

A §9.4 判「算，且是刻意的行为破坏」，三条可观测变化中前两条原样采纳：① 已受理但沉默超上限的回合不再出现红横幅/回显草稿/解绑 Host，改为回合头持续 `Still waiting · Ns`；② `session.failed` 到达时红卡与回显照旧，但时机后移到证据到达时刻。第三条按 §2.3 订正为：③ Host 端一次 `api_retry` 不再立即杀回合（需 `attempt >= maxRetries` 或等 195s stall）。

补第四条（A 遗漏，来自 §8.1）：④ 文本无附件路径在 45s 后开始显示 `Still waiting …` 文案（此前该窗口不可达）。

三条都是「把谎言换成沉默或换成延后的真话」，方向单一，不存在「原本成功现在失败」的方向。发布说明按 `fix:` 前缀写清 ① 与 ④。

### 9.4 裁定：变异与时间测试纪律 —— 取两轨并集

A：逐对指名**承重行**（非注释行、非 inert 分支），flip 前预检 old/new 串双唯一，跑完立即回滚，零跳过。
B：禁止以「更新快照/改字面使其通过」处理红灯；每个 mutant 必须由独立期望咬住，**不得拿生产函数输出当自己的 oracle**（`queueRelease.test.ts` 已记录 tautology 反例）；时间测试用 fake clock 或 20~100ms env override，真实 timer 只保留一个最小 smoke。
**全部采纳，无冲突。**

---

## §10 事实纠错清单

> 凡登记项，rev.2 必须逐条订正；带 **P0** 的若不订正会带进生产缺陷。

### 10.1 A 轨

| # | 位置 | A 稿表述 | 实况【仲裁实测】 | 影响 |
|---|---|---|---|---|
| **A-1 · P0** | §4.3 | 「`RunEntryOutcome` 加 `'pending'` 后 TypeScript 会在 5 个消费点逐点报错，强制复审」 | **零编译错误**。五点全是 `if (x === 'committed')` 形态，无穷尽 `switch`。静默默认里 `shouldArmRetryable('pending','direct') === true`、`decideFailureAffordance('pending', *) === 'resend'` | 若照 A 的理由施工而漏写分支，直接复活一键双发。逐点裁定必须显式落地 + 变异咬合 |
| **A-2** | §0.4 承重事实表 | 「`session.status(running)` 每回合只发一次，全文无第二处 running 发射」 | 需按 §3.3 的心跳论证重述：本批采一次性降级后，Host 的诊断帧全回合最多两帧，**不是心跳**。而渲染端也不需要心跳（新发现①） | A §3.3 「没有这帧 300s 沉默表会在权限卡上误到期」的论证**不可达**，须删除，否则会为不存在的耦合写测试 |
| **A-3** | §8.1 | 「`SLOW_WAIT_HINT_SECONDS` 与预算重合，Still waiting 文案从未被看见过」 | **仅对文本无附件路径成立**。附件路径预算 75/105/180s，slow 文案今天可见且被逐字钉住（`attachments.test.ts:357`、`:436`） | 若按 A 的描述把这两条断言当陈旧钉住退役，会丢掉唯一的正控 |
| **A-4** | §0.3-② | 陈旧 `120s` 注释在 `ttftWatchdog.ts:9-10` | 实际在 `ttftWatchdog.ts:7`（且 `:12` 另有「必须低于渲染端 `SEND_BASE_TIMEOUT_MS` 的 45s」，本批同样过期） | 订正行号并补第二处 |
| **A-5** | §2.4 / §10.1 | 「把 `PRODUCTIVE_EVENT_TYPES` 导出」 | 它是 `send()` 闭包内的**局部 `const`**（`claudeRuntime.ts:794-800`），导出前须先提升到模块作用域 | 影响面清单漏了这个改动 |
| **A-6** | §4.4 / §8.3 / §0.3-④ | `MessageTimeline.tsx:935-946` / `:286` / `:1221` / `:1372-1377` / `:534-541` | F10（`c5cbd19`）后位移为 `:952-963` / `:287` / `:1236` / `:1389`；中性红卡文案现在 `:557` | 全部行号需重取 |

### 10.2 B 轨

| # | 位置 | B 稿表述 | 实况【仲裁实测】 | 影响 |
|---|---|---|---|---|
| **B-1** | §4.1 | 「`finally` 对 detached 不 `endTurnSend`，turn-head 就不会在 300s 消失」 | 不够：驱动 `sendStatus.elapsedSeconds` 的 ticker 在 `finally` 第一行就被 `clearInterval`（`ChatComposer.tsx:1864`），只保留快照会得到**冻结在 300s 的秒表** | B 的方案必须额外造一个 ticker 所有者；§4.4 因此取 A 的方案 |
| **B-2** | §4.1 | 「`canStartTurn` 必须新增 detached latch，否则可能误放第二个 send」 | 今天已双保险堵住：`decideQueueRelease` 在 `status !== 'idle'/'completed'` 时 `hold('not-idle')`；`busy = isStoppable(status)` 在 `'running'` 下为真 | 不新增生产状态，改立不变量断言（§4.5） |
| **B-3** | §2.2 / OQ2 | `API_RETRY_LIVENESS_CAP_MS = 90_000` | B 自认无证据；且 `api_retry` 走 `system` 事件不复位 stall，195s 封顶**今天就存在且正确**（`claudeRuntimePartialStall.test.ts:126-133` 已钉） | 该常量不落地（§2.3） |
| **B-4** | §3.2 | 「删除 `!sawAnySdkEvent` 证据，因为无帧也可能是健康的长首响应」 | `!sawAnySdkEvent` 不是「无产出」，是「连 `system/init` 都没有一帧」= dead spawn / auth 失败（`claudeRuntime.ts:722-723`）。健康长首响应必然先有 init | 保留该证据，但按 §3.2 降为二次窗口证据以吸收冷启动反例 |
| **B-5** | §8.2 | 「文本无附件路径在 F2 中不激活 slow，`kind:'slow'` 不能只比较秒数」 | 会拆断 `turnStatus.ts:115-118` 明文保证的「kind 与 copy 只能一起翻」同源关系，正是 B 自己要避免的 kind/copy 分裂 | 驳回（§8.3） |
| **B-6** | §7.1 / §7.3 | Codex TTFT 需与 ack 时机 `[未测]` 挂钩考虑 | Codex 首个 productive 帧是 `turn/started` **通知**，与 `turn/start` 请求 ack 是独立通道；ack 不确定性与 TTFT 无关 | 结论（32s）不变，理由需订正 |
| **B-7** | §2.3 | 新建 `turnWatchdogPolicy.ts` 跨轴共享政策 | 两轴事件词表完全不相交（SDK 顶层类型 vs JSON-RPC 方法名），可共享的只有已抽出的 deadline 算术 | 驳回（§2.4），共享的是文档词表不是运行时模块 |

### 10.3 分诊自身的纠错（两轨共同发现，并入 rev.2）

- 分诊缺陷 1 写「45s 预算唯一复位条件是 `classifyAssistantProgress === 'assistant'`」——**实况是零复位条件**：`waitUntil`（`ChatComposer.tsx:260-271`）是固定截止时间，`predicate` 只决定是否提前 release。修法方向不变，事实要写准。（A 发现）
- 分诊缺陷 5 写「该形态下 Host 全线失守」——**过度描述**：195s stall 狗仍会开火（`system` 不在 `PRODUCTIVE_EVENT_TYPES` 内）。失守的是「Host 先于渲染端说话」这条不变量，不是 Host 本身。（A 发现）
- 分诊值表写 stall=195s 正确，但 `claudeRuntime.ts:760` 与 `ttftWatchdog.ts:7` 的历史注释仍写 `120s`。（两轨同判）
- 分诊缺陷 4（红卡指向不存在的按钮）在 `a94b9a4` 已修（现 `MessageTimeline.tsx:557`），本批不得重复设计或回滚。（两轨同判）
- 分诊方向 C 写「红横幅只在确定死亡（failed / stopped / completed 无产出）时出现」——**两轨同向收窄**：`stopped` 是用户意图、`completed` 是正常终态，都不出红卡；唯一红卡入口是 `session.failed`。

---

## §11 合取后的切片与门禁方案

### 11.1 切片图

```
S0 (串行 seam，必须先合)
   └─> S1 ∥ S2 ∥ S5
              └─> S3 ∥ S4          ※ S5 必须先于 S3 合入（红线，见 11.3）
```

| 片 | 责任 | 独占文件 | 依赖 |
|---|---|---|---|
| **S0** | 协议加法：`SessionLivenessNote` + `SessionStatusEvent.payload.liveness?`；`AGENT_HOST_PROTOCOL_VERSION` 保持 `1` 的静态断言复核 | `src/shared/types/runtimeEvents.ts` + 其 wire 静态测试 | 无 |
| **S1** | Claude Host：TTFT 一次性降级 + `!sawAnySdkEvent` 二次窗口 + `attempt >= maxRetries` 证据 + 三分 `reason` 诊断帧 + `PRODUCTIVE_EVENT_TYPES` 提升到模块级并导出 + 冻结断言 + 三处 `120s` 注释订正 + R9 注记改写 | `src/agent-host/claudeRuntime.ts`、`src/agent-host/ttftWatchdog.ts` 及其三个测试 | S0 |
| **S2** | 渲染端读侧：新建 `sendBudgets.ts`（两个上限 + 两个 Host 镜像 + `createSendWaitBudget` + 反转 INVARIANT + **源文镜像锁**）；`classifyTurnLiveness`；`waitUntil` 换签名；`formatRuntimeEvent` 打 liveness；`attachmentLimits.ts` 退役超时半边；`middleColumnLayout.ts` 散文样例 `45s`→`300s` | `sendBudgets.ts`(新)、`attachmentLimits.ts`、`assistantProgress.ts`、`middleColumnLayout.ts` + `ChatComposer.tsx`(读侧) | S0 |
| **S3** | 渲染端写侧：`'ceiling'` 判别联合分支 + `'pending'` 出路 + `decideAdmittedTimeoutOutcome` / `isAdmittedOutcome` + 六个消费点逐点裁定 + `pendingReply` 槽 + 回合头失表修复 + marker 升格 + `RestoredDraftMarker`(按 D1) + 清理链有序化 | `queueRelease.ts`、`useQueueRelease.ts`、`turnSendStatus.ts`、`ChatComposer.tsx`(写侧)、`MessageTimeline.tsx` | S2 + **S5** |
| **S4** | Codex 轴双狗：三层词表（含三条 plan/diff productive）、connection-activity 与 turn-activity 分层、按 turnId 分叉 abort、诊断帧 | `codexRuntime.ts`、`codexNormalizer.ts`（导出 productive 集） | S0、S1 的类型 |
| **S5** | Main 侧 Host 退出广播：open-session 台账（复用既有事件转发点）、非清洁退出判定、error/exit 去重、会话级 `disconnected` + `failed` 广播 | `AgentHostManager.ts`、`src/main/ipc/chat.ts` 及其测试 | 无 |

**零混面核对**：S1/S4 只碰 `src/agent-host`（文件不重叠）；S2/S3 串行同一批渲染端文件；S5 只碰 `src/main`；S0 只碰 `src/shared`。若 S3 需改 `chatSessions.ts`（红线文件），**先停下来单独立项**——两轨都主张零改动，本仲裁维持。

### 11.2 每片收口条件（一致口径）

每片必须同时给出：① 四门全绿（`pnpm typecheck` / `pnpm typecheck:agent-host` / `pnpm lint` / 该片相关 vitest 套件）——**逐门串行跑，禁链式合跑**（本机曾 OOM exit 137）；② 该片确定性断言点逐条实跑记录；③ 该片变异对逐对实跑记红灯（**零跳过**）；④ 影响面清单与实际 `git diff --stat` 逐文件核对。

时间相关用例一律 fake clock 或 20~100ms env override，**不等待真实 300s**；真实 timer 只保留一个最小 smoke。

### 11.3 红线前置（本方案唯一的强序约束）

**S5 必须先于 S3 合入。** 依据：§6.2 的洞在 S3 落地后会让 Host 崩溃场景**比旧形态更糟**——旧形态 45s 后至少报个错，新形态会永远显示 `Still waiting · Ns` 且队列永久 hold。若 S5 被否或另立票，S3 **必须**带 D2 的轮询兜底，不得裸合。

---

## §12 测试合同与变异计划（两轨合并）

### 12.1 测试合同变更（逐文件）

| 文件 | 片 | 处置 |
|---|---|---|
| `attachmentLimits.test.ts` | S2 | `[T-01]`~`[T-05]` 字节缩放五例**整组退役**（所钉公式作废，非重编号）；`[T-06]`/`[a4]` **反转重写**并迁入 `sendBudgets.test.ts`（重编号会掩盖语义反转）；`[A-01]`~`[A-10]` 与附件限额族**原样保留** |
| `sendBudgets.test.ts`（新） | S2 | `[C-01]` 有序链 `TTFT < STALL < SILENCE`；`[C-02]` 反转后的 T-06；`[C-03]` **源文镜像锁**（读 `claudeRuntime.ts` 正则取两个默认常量字面量与镜像逐一相等——补 A 新发现③的洞）；`[C-04]` `createSendWaitBudget` 四例（边界到期 / 复位后重新计满 / 循环上界仍到期 / `markLiveness` 传过去时刻不倒退） |
| `assistantProgress.test.ts` | S2 | `[L-1]` 包含关系（遍历全部 `RuntimeEventType`，progress ⊆ liveness）；`[L-2]` **负向咬合**：`message.started{role:'user'}` → progress `'ignore'` 且 liveness `'liveness'`；`[L-3]` status/stderr/usage/subagent 四类为 liveness；`[L-4]` 三终态 + `host.error` 非 liveness；`[L-5]` 跨会话恒 `'ignore'`；既有用户三连 ignore 断言**逐字保留** |
| `queueRelease.test.ts` | S3 | `[P-1]` `decideAdmittedTimeoutOutcome` 真值表；`[P-2]` **承重**：`decideFailureAffordance('pending', 三 origin)` 全 `'none'`；`[P-3]` `shouldArmRetryable('pending', *)` 全 `false`；`[P-4]` `shouldPauseQueueOnRejection('pending', *)` 全 `false`；`[P-5]` `isAdmittedOutcome` 四值全表；`[P-6]` 既有三值全表逐字不变；`[Q-1]` pendingReply 期间发送门/队列门必 hold（§4.5）。**硬编码矩阵，禁止用被测函数互相证明** |
| `composerStopStatic.test.ts` | S3 | 既有 6 组保持绿（`waitUntil` 换签名的回归证据）；`:251` 的 `abandonMarkerRef.current = {` 改为 `pendingReplyRef.current = {`；文件头散文三处「45s abandon」订正；**新增第 7 组**：`[S-1]` ceiling 分支体不含 `unbindHost()`；`[S-2]` 不含 `lastError`；`[S-3]` 不含 `restoreDraftIfComposerEmpty` / `setRetryable(`；`[S-4]` 含 `armPendingReply(`；`[S-5]` 不含 `finalizeOutcome(`；`[S-6]` `budget.markLiveness(` 与 `classifyAssistantProgress(` 同在监听器内且各恰一次。**锚点用 B 的 `case 'ceiling':` 源文切片**（比变量名稳定） |
| `messageTimelinePendingStatic.test.ts`（新） | S3 | `[TS-2]` `turnActive` 赋值行同时含 `inFlight` / `streamStartedAt` / `pendingActive` 三标识符（`.tsx` 不可测事实的既有工法） |
| `turnStatus.test.ts` | S3 | `base.budgetMs: 45_000` 是 fixture 非常量主张，**不改**；新增 `[TS-1]` kind 与 copy 同源（`elapsed >= SLOW_WAIT_HINT_SECONDS && !hasBlocks` → `kind==='slow'` 且文案含 `Stop to abort.`），防本批或 F4 拆开 |
| `attachments.test.ts` | — | **零改动**。`:357` / `:436` 两条 62s 逐字断言是 slow 分支唯一的正控（§8.1 纠错），必须保持绿 |
| `claudeRuntimeOptions.test.ts` | S1 | 「零帧 50ms 直接 TTFT failed」改为**两个窗口后**才 failed（§3.2）；`F1: fires once sawApiRetry evidence lands` 改为 `attempt >= maxRetries` 才开火；新增 `[E-1]` 单次 `api_retry` 后静默 → TTFT 不开火、stall 兜底；`[E-2]` 停在权限上发出 `liveness.reason==='awaiting_user'` 且 TTFT 表**不降级**；`[E-3]` 静音位下一帧不发且判决不变；`[E-4]` R9 init-silent → 一次降级 → stall 必失败；保留 permission parked 与 Stop-not-relabeled 两例 |
| `ttftWatchdog.test.ts` | S1 | 保留 disabled / idempotent / mark / dispose / Stop race；**`rearm` 政策断言**按一次性降级重写（B 的方向），但 watchdog 类本体不变——改的是 `onTimeout` 策略 |
| `claudeRuntimePartialStall.test.ts` | S1 | **零改动**，词表冻结守门人（S1 收口条件之一是它保持绿） |
| `codexWatchdog.test.ts`（新） | S4 | `[X-1]` productive 集含三条 plan/diff 方法；`[X-2]` `account/rateLimits/updated` 与 `thread/status/changed` 不在集内；`[X-3]` 集合与 `CODEX_NORMALIZER_METHODS ∪ CODEX_IGNORED_NOTIFICATIONS` 差集为空（防上游新增通知被静默漏判）；`[X-4]` turnId 未知时 abort 路径不构造 interrupt 参数；`[X-5]` 只有 outbound connection activity 时仍 stall（B 的负控） |
| `AgentHostManager*.test.ts` / `chat*.test.ts` | S5 | unexpected exit 广播一次并覆盖全部 open session；`error` 无后续 `exit` 也广播；`error`+`exit` 去重；`code===0`/`SIGTERM` 的 intentional shutdown 不发失败；open-session 台账在 crash-mid-turn fixture 下不漏不误报 idle session |
| `detachedTurn` / 清理链 | S3 | 迟到清理链有序性：清理先于 reducer 应用新事实；`RestoredDraftMarker` 仅在两个 revision 未变时撤销回显；**用户编辑后绝不按值相等删除**（按 D1 决定是否必做） |

### 12.2 变异计划（逐对，指名承重行，实跑记红灯）

| # | 承重行（片） | 变异 | 必红用例 |
|---|---|---|---|
| M1 | `sendBudgets.ts` `SEND_SILENCE_CEILING_MS = 300_000` → `150_000` | 破坏有序链 | `[C-01]` `[C-02]` |
| M2 | `createSendWaitBudget` 的 `markLiveness` 体改空 | 复位失效 | `[C-04]` 第二例 |
| M3 | `createSendWaitBudget` 去掉循环上界分支 | 上界失效 | `[C-04]` 第三例 |
| M4 | `classifyTurnLiveness` 的 `session.status` 分支返回 `'ignore'` | 活性失效 | `[L-3]` |
| M5 | `classifyAssistantProgress` 的 `role === 'assistant'` 改 `role !== ''` | **放宽谓词（最高优先级禁忌）** | `[L-2]` 红，且 `[L-1]` 保持绿（证明两函数确实分离） |
| **M6** | `decideFailureAffordance` 的 `'pending'` 分支删除（回落静默默认） | **回显+双发复活（P0，§10 A-1）** | `[P-2]` `[P-3]` |
| **M7** | `shouldArmRetryable` 的 `'pending'` 分支删除 | **一键双发复活（P0）** | `[P-3]` |
| M8 | `isAdmittedOutcome` 去掉 `'pending'` | 队列重发 | `[P-5]` |
| M9 | `ChatComposer` ceiling 分支加回 `unbindHost();` | 解绑复活 | `[S-1]` |
| M10 | `claudeRuntime` 证据门 `attempt >= maxRetries` 改 `attempt > maxRetries` | 边界误放 | `[E-1]` 的边界例 |
| M11 | `!sawAnySdkEvent` 恢复为首窗口即 abort | 冷启动误杀复活 | 两窗口用例 |
| M12 | TTFT 降级后继续 `rearm()` 而不交给 stall | R9 无限重入复活 | `[E-4]` |
| M13 | `PRODUCTIVE_EVENT_TYPES` 加 `'system'` | 词表松动 | 冻结断言 + `claudeRuntimePartialStall` 第二例 |
| M14 | `MessageTimeline` `turnActive` 去掉 `pendingActive` | 失表复活 | `[TS-2]` |
| M15 | Codex productive 集去掉 `turn/plan/updated` | 写 plan 被判死 | `[X-1]` |
| M16 | Codex watchdog 直接用 connection `lastActivityAt` 复位 stall | 出站流量永久保活 | `[X-5]` |
| M17 | Host exit 广播去掉 `session.failed` | 崩溃静默复活 | S5 用例 |
| M18 | Host exit 广播对所有会话（含 idle / intentional close）写 failed | 误报 | S5 的 intentional-close 负控 |
| M19 | 诊断帧 `reason` 恒返回 `'insufficient_evidence'` | reason 与分支脱钩 | `[E-2]` |
| M20 | text-only 45s 重新切回 `awaiting` copy（拆开 kind/copy 同源） | §8.3 裁定被推翻 | `[TS-1]` + `attachments.test.ts:357` 仍绿 |
| M21 | 迟到清理按文本相等删除草稿（不看 revision/provenance） | 删掉用户新输入 | 清理链用例（按 D1） |

**纪律**：每对变异指名一个**承重行**（不是注释行、不是 inert 分支）；flip 前预检 old/new 串在文件内**双唯一**；跑完立即回滚；**零跳过**；禁止改字面使其通过；禁止拿被测生产函数当自己的 oracle。

---

## §13 待用户拍板清单

> 编号 D1~D6，供当场问。每项给：背景（这东西是干嘛的）+ 两轨立场 + 本仲裁倾向。
> **另需知会（不是选择题）**：本批是刻意的行为破坏，四条可观测变化见 §9.3——其中第 ④ 条「文本无附件路径在 45s 后开始显示 `Still waiting · Ns — gateway latency varies. Stop to abort.`」是最常见路径上的新可见文案（该文案今天只在带附件的发送上出现过）。文案已逐项审读并判定逐字保留（§8.3）。

### D1 — 回合确定死亡后，已受理的那条消息要不要自动放回输入框？

**背景**：今天渲染端一超时就把用户刚发的文本+附件悄悄塞回输入框（`decideFailureAffordance('committed') === 'restore-draft'`），这是「等了很久 → 红报错 → 输入框里多出一份复制稿」的来源，也是现场抱怨的一半。本批已一致裁定：**猜测性超时绝不回显**。剩下的问题是——当 Host **确实**说了 `session.failed`（真死了、零产出）时，还要不要自动放回去。注意此时用户的原文**仍在时间线里**（作为 user 气泡，可选中可复制），并不是「无路可走」。

- **A 轨**：要。用户裁定「只有明确死亡才允许回显」读作充分条件；死了且零产出的回合，用户十有八九要改一改重发，省一次复制；`restoreDraftIfComposerEmpty` 已有「composer 非空就不覆盖」的防覆写。
- **B 轨**：不要。读作必要条件——还要再加「从未被受理」。已受理意味着文本已在时间线，红卡旁边同时摆一份可发的草稿，是在诱导第二个回合。

**本仲裁倾向 A**：`session.failed` 之后同一回合不可能再有迟到回复，双发风险是「用户主动决定重发」而非「误发」；B 的矩阵还会顺带砍掉今天唯一合理的回显场景（握手致命错但已有回声）。**但这是产品取舍，不替您拍板。**
**连带成本**：若取 A，B 的 `RestoredDraftMarker` provenance（记录「这份草稿是我们塞的」，用户一编辑就失效，迟到事件绝不按值相等删用户新输入）**必做**，约 +1 个纯模块 + 一组用例；若取 B，它降为可选。

### D2 — Agent Host 进程崩溃时的会话终态广播，本批做到哪一档？

**背景**：**这是本批发现的最大的洞**。今天 Host 子进程崩溃/被杀时，Main 只写日志和内部 state，**不向界面广播任何东西**。结果是所有会话永久停在「运行中」：Stop 按钮在、点了没用、没有终态。旧形态至少 45s 后会报个错；本批把那个（错误的）报错拿掉之后，**不补这个洞就是纯退步**。

- **A 轨**：本批做全量（Main 侧对崩溃时仍开着的会话逐个广播 `session.status(disconnected)` + `session.failed`），并给了降级位（只广播一条无 sessionId 的 `host.error`）与另立票位。
- **B 轨**：同判必须做，另加去重要求（`error` 后无 `exit` 也要广播；`error`+`exit` 只广播一次）与「不得由 `getHostStatus` 超时猜测」的负控。

**双轨同判「必须做」，只是范围有三档**：
1. **全量**（推荐）——需要 Main 侧维护一份会话台账；本仲裁已给出零新增管道的实现路径（复用既有的 RuntimeEvent 转发点入账/出账）。
2. **降级**——只发一条无 sessionId 的 `host.error`，能接住「正在飞的那一条」，后台会话仍停在运行中。
3. **另立票**——则 §4 的 pending 态**必须**带轮询兜底（进入 pending 后周期性 `getHostStatus()`，非 running 即判死），且该切片不得裸合。

**本仲裁倾向 1（全量）**，并把「S5 先于 S3 合入」列为本方案唯一的强序红线。

### D3 — 要不要为「CLI 一直在重试」单独做一条比 195s 更早、更具体的失败文案？

**背景**：模型名写错、网关抽风时，CLI 会进入无穷 `api_retry` 循环。今天的兜底是 195s 的 stall 看门狗（`api_retry` 不复位它，所以必然开火），文案是笼统的「Host stall watchdog: no model progress for 195000ms」。两轨都想更早、更具体地报，但用的都是**没有证据支撑的数字**（A：重试满 3 次；B：从首次重试起 90 秒墙钟——B 自己在 OQ2 里承认这是拍的）。

- **A 轨**：`TTFT_API_RETRY_ABORT_ATTEMPTS = 3`。
- **B 轨**：`API_RETRY_LIVENESS_CAP_MS = 90_000` + `attempt >= maxRetries`。

**本仲裁已裁掉两个数字**，只保留 B 的 `attempt >= maxRetries`（用 SDK 自己报的字段，零新常量，语义是「SDK 自己已经放弃了」），其余交给既有的 195s。
**上交的是**：您是否愿意为「更早 + 更具体的重试失败文案」付一个无证据常量的代价？**本仲裁建议不付**——先按现方案发，若真机上 195s 的笼统文案确实困扰，届时带着实测的重试时长分布再定这个数。

### D4 — Codex 轴：判死时若 turnId 还不知道，允许「本地退休、远端可能还在跑」吗？

**背景**：Codex 的 `turn/interrupt` 协议要求 threadId + turnId **两个都填**（少一个是 schema 错误，等于「日志说发了中断、实际没中断」）。TTFT 阶段判死时 `turn/start` 可能还没应答，turnId 未知，无法发合法的中断。

- **A 轨**：本地 `finishTurn('failed')` 退休本回合，迟到的 `turn/start` 响应由既有守卫静默吞掉；残留（codex 侧可能仍在跑）记为遗留，A 自己列为 open question。
- **B 轨**：未涉及这个分叉。

**本仲裁倾向接受该残留**（另一条路是重置整条连接，代价是打断同一 app-server 上的其他会话，明显更差）。上交是因为它是一个**明确的功能性残留**，不该由施工方自己吞掉。

### D5 — 渲染端这半边不加 feature flag，是对工程规范 #6 的显式偏离，接受吗？

**背景**：本仓规范第 6 条要求「每个新能力藏在 flag 后，on/off 双位置都跑」。本批渲染端这半边（不再判死、不再红叉、不再回显）**不是新能力，是撤销一个错误裁决**——为它做 flag 意味着在产品里保留一个「我们已经证明它会对活着的回合打红叉」的开关位置。

- **A 轨**：不加，并把这条显式列为需要确认的偏离。
- **B 轨**：不加任何用户可见 flag，也拒绝旧/新双轨运行（理由更强：只切一端会造成跨进程语义错配，灰度反而保证不了一致性）。

**双轨同判「不加」，本仲裁同意**。可回退性由三样东西提供：两个天花板是常量（改数即回退量级）、分片提交（S3 可单独 revert 而 S2 留存）、把本次现场样本立成 incident 回归用例。Host 半边的 env 阈值与静音位保留，但定性为**测试 seam 与运维旋钮，不是产品灰度**。**上交的只是这条偏离本身要您认可。**

### D6 — 除了您拍板的 300s，还要不要一个 30 分钟的绝对上界？

**背景**：新的 300s 天花板是**可被活性帧复位**的（Host 每说一句话就重新计时），这是它比旧的 45s 死表更诚实的原因。但复位意味着一个持续吐 stderr 或持续重试的回合可以把渲染端那个 50ms 步进的等待循环**无限续命**。

- **A 轨**：新增第二个上限 `SEND_ABSOLUTE_CEILING_MS = 1_800_000`，刻意对齐 Codex 的 30 分钟 ack，让分诊说的「40 倍哲学错配」在数值上收敛为 1:1。
- **B 轨**：不设，硬上限一条到底（但 B 的 300s 本来就不复位）。

**本仲裁倾向要，但降格定性**：它不是第三只看门狗、不做任何判决，到期动作与 300s 沉默到期**完全相同**（都进 pending），本质是「轮询循环的资源上界」。因此建议改名 `SEND_WAIT_LOOP_BOUND_MS` 并如此写注释，避免下一个读者以为渲染端又长出了一个判死权。**上交是因为它在您拍板的 300s 之外新增了第二个数字。**

---

## §14 rev.2 成稿路径

### 14.1 骨架与并入

**以 A 轨为骨架**（章节结构、裁定粒度、变异计划形态、死文案审读、五项新发现直接沿用），按下表并入 B 轨章节与本仲裁的裁定：

| rev.2 章节 | 骨架来源 | 并入 |
|---|---|---|
| §0 取证核对 | A §0 全文 | 本仲裁 §0.3 三项新发现；A-2/A-3/A-4 三处订正；分诊纠错并入 B §0.3 的同判项 |
| §1 分工形态 | A §1 | 本仲裁 §1.1 的区间论证（替换 A 的「复位不对称」第三条）；§1.2 的双上限合取与改名；A §1.3 论证保留，补 B §11.3 承认缩放失效的交叉印证 |
| §2 活性谓词 | A §2.1（两函数） | **B §2.1 的三层词表整节并入**为跨端文档契约；A §2.3 的 api_retry 封顶改写为本仲裁 §2.3；A §2.4 冻结裁定原样保留 + §3.4 的模块级提升 |
| §3 TTFT / R9 | A §3.1 定性 + A §3.3 协议形状 | **B §3.1 的一次性降级机制替换 A 的无限 rearm**；本仲裁 §3.2 的二次窗口折中替换两轨的 `!sawAnySdkEvent` 分歧；A §3.4 证据清单保留 |
| §4 渲染端到期 | A §4 全节 | **B §4.1 的判别联合作为分支标签**；本仲裁 §4.3 的 P0 纠错表**替换** A §4.3 的理由段；§4.4 行号订正 + B-1 冻表反驳；§4.5 替换 B 的第五道门 |
| §5 restore-draft | A §5 | **B §5.2 的 `RestoredDraftMarker` provenance**（按 D1 定必做/可选）；**B §5.3 的八步清理顺序**与 A 的既有资产合并为本仲裁 §5.5 的八步链；§5.3 分歧保留为 D1 占位，待拍板后落一个矩阵 |
| §6 确定死亡 | A §6 判据表 | B §6.1 表的 Codex 行与 Main 行并入；B §6.3 负控清单整段并入；本仲裁 §6.2 的台账来源推荐解与去重要求 |
| §7 Codex | A §7 | **B §7.2 的 connection-activity 分层负控**并入；TTFT 值改 32s 并换理由（本仲裁 §7.3）；A 的 plan/diff 三条 productive 判据升为本节承重条 |
| §8 文案 | A §8（含死文案审读） | **B §8.1 的可达性纠错整段并入**（附件路径 slow 今天可见且已钉）；B §8.2 的「文本路径不激活」被驳回，保留驳回理由；kind/copy 同源立成断言 |
| §9 切片门禁 | 本仲裁 §11 | B 的 S0 seam + A 的依赖序 + 红线前置 |
| §10 影响面/测试/变异 | 本仲裁 §12 | A 的逐文件表 + B 的 Main/Codex 补充 + 合并后的 21 对变异 |
| §11 open questions | 本仲裁 §13 | D1~D6，拍板后转为「已拍板约束」并回填对应章节 |

### 14.2 成稿前的强制动作

1. **先落 §10 的六条 A 轨纠错与七条 B 轨纠错**，再动章节——尤其 A-1（`'pending'` 无编译保护）必须在 §4 成稿前订正，否则施工会带进双发缺陷。
2. **全文 line 引用重取一遍**：两轨的行号基线分别是 `a94b9a4`，而当前基线是 `0271e01`（含 F10 `c5cbd19`）。`MessageTimeline.tsx` 的引用全部位移。
3. **D1~D6 当场问**，拍板结果直接回填 §5 矩阵 / §6.2 范围 / §2.3 常量 / §7.4 残留 / §9.2 flag / §1.2 第二上限，**不留 open question 到施工期**。
4. rev.2 落库后按 plantree 权威链登记（注册表 + roadmap + 主线台账），本仲裁档作为 rev.0-A / rev.0-B 到 rev.2 之间的裁定留痕，**不删两轨盲稿**（双盲过程本身是资产）。

### 14.3 本仲裁档的定位

本档**不是施工规格**，是裁定留痕。施工方读 rev.2，rev.2 读不明白某条裁定的理由时回查本档对应节。两轨盲稿在 rev.2 落库后转为归档状态，仅作为「同一问题两个独立视角」的样本保留。

---

## §15 拍板记录（2026-08-18 用户当场拍板，D1~D6 全落）

| 项 | 拍板 | 连带 |
|---|---|---|
| D1 | **自动放回**（确定死亡后 restore-draft 保留） | B 的 RestoredDraftMarker provenance **必做**（系统塞入标记、用户一编辑即失效、迟到事件绝不按值相等删用户新输入） |
| D2 | **全量**崩溃广播 | 零新增管道实现路径（复用 RuntimeEvent 转发点入账/出账）；**S5 先于 S3 合入 = 强序红线** |
| D3 | **不付无据常量** | 只留 attempt>=maxRetries + 195s 兜底；真机若困扰再带实测分布定数 |
| D4 | **接受残留**（本地退休、远端可能续跑） | 登记为已知限制，迟到应答由既有守卫静默吞 |
| D5 | **接受规范 #6 偏离**（渲染端半边不加 flag） | Host env 阈值定性为测试 seam 与运维旋钮；偏离记台账 |
| D6 | **要 30min 上界，降格定性** | 改名 SEND_WAIT_LOOP_BOUND_MS，非判死权，到期动作与 300s 沉默到期相同 |

另知会已达（行为破坏四条可观测变化，含文本路径 45s 起现 slow 文案）。rev.2 按 §14 成稿路径 + 本表执行。
