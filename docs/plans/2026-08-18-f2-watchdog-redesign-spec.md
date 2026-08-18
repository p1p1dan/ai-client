# F2 超时看门狗体系重设计 — 施工定稿规格 **rev.2**

- 日期：2026-08-18
- 分支：`feat/openchamber-chat-refactor`
- 交付性质：**施工定稿**。本文件是 F2 批唯一的施工权威；施工方读本文，读不懂某条裁定的**理由**时回查仲裁档。
- 代码基线：`d9281d0`（含快修批一 `a94b9a4`、快修批二 `c5cbd19`/F10、F456 rev.1 与 F2 仲裁落账三条 docs-only 提交）。
  **全文 file:line 锚点按该基线亲自重取**，与两轨盲稿（基线 `a94b9a4`）和仲裁档（基线 `0271e01`）的行号不再一致的地方以本文为准。
- 权威序（冲突时上位者胜）：
  1. `docs/plans/2026-08-18-f2-watchdog-arbitration.md` **§15 用户拍板 D1~D6 终局** → §0~§14 裁定
  2. 本规格的【实测】重验结论（凡与仲裁的 file:line 冲突，以本规格为准；凡与仲裁的**裁定**冲突，本规格已在 §14.2 逐条登记并给出处置）
  3. A 轨盲稿 `…-spec-trackA.md` / B 轨盲稿 `…-spec-trackB.md`（仅按仲裁 §14.1 指定的骨架与并入章节取材；仲裁 §10 已登记的事实错误一律不得抄入）
- 标注：【实测】= 本规格在基线 `d9281d0` 上亲自读码核对；【仲裁】= 直接引自仲裁档的裁定；【拍板】= 用户 D1~D6 终局；【新发现】= 本规格重验时新增、两轨与仲裁均未写的事实。
- 越界纪律：本批**只改超时判决链路**。文案措辞、色阶、装饰面一律不动（§8）；`chatSessions.ts` 为红线文件，零改动（§10.4）。

## 目录

- §0 权威与拍板终局摘要 · 取证清单 · 本稿四项新发现
- §1 题一：分工形态与跨程序不变量（INVARIANT 反转）
- §2 题二：活性谓词、三层词表、api_retry 封顶、模块归属
- §3 题三：TTFT 证据门重设计、R9 洞、协议加法
- §4 题四：渲染端到期动作重构与静态断言（含 `'pending'` P0 逐点裁定）
- §5 题五：restore-draft 收窄、provenance marker、迟到清理链
- §6 题六：确定死亡判据清单与 Host 退出广播
- §7 题七：Codex 轴看门狗与 30 分钟 ack
- §8 题八：`SLOW_WAIT_HINT_SECONDS` 死路径的处置边界
- §9 题九：flag 裁定与行为破坏范围
- §10 影响面全清单（新建 / 修改 / 明确不改）
- §11 切片与门禁（S5 先于 S3 红线 · S0 串行 seam · F456 边界）
- §12 测试合同变更（逐文件逐用例 · 含 incident 回归夹具）
- §13 变异计划（**23 对** = 仲裁 21 对 + 本规格新增 M22/M23；M6/M7/M22/M23 为 P0）
- §14 as-built 预留与 open questions 清账（D1~D6 已决）

---

## §0 权威与拍板终局摘要 · 取证清单 · 本稿四项新发现

### 0.1 一句话形态

**Host 是唯一裁决者与唯一 abort 执行者；渲染端降级为展示层 + 一个高于 Host 的活性感知沉默上限。**
`attachmentLimits.ts:190-202` 的现行 INVARIANT（渲染端先说话）**反转重写**为「Host 恒先说话」；渲染端到期后既不判死、不解绑、不写错、也不回显，只把回合头交给一个持续的 `'pending'` 等待态，等 Host 给出真正的死亡证据。

### 0.2 用户拍板 D1~D6 终局（仲裁 §15，本规格全文按此执行，不再复议）

| 项 | 拍板 | 本规格落点 |
|---|---|---|
| **D1** | **自动放回**——确定死亡后 `'committed'` 仍 `restore-draft` | §5.1 矩阵；连带 **`RestoredDraftMarker` provenance 必做**（§5.3） |
| **D2** | **全量**崩溃广播（会话级 `disconnected` + `failed`） | §6.2；连带 **S5 先于 S3 = 强序红线**（§11.3） |
| **D3** | **不付无据常量** | §2.4：`TTFT_API_RETRY_ABORT_ATTEMPTS` 与 `API_RETRY_LIVENESS_CAP_MS` **两个都不落地**，只留 `attempt >= maxRetries` + 195s stall 兜底 |
| **D4** | **接受 Codex 残留**（turnId 未知时本地退休、远端可能续跑） | §7.4；登记为已知限制（§14.1） |
| **D5** | **接受规范 #6 偏离**（渲染端半边不加 flag） | §9.1；可回退性由常量 / 分片 revert / **incident 回归用例**三样提供 |
| **D6** | **要 30min 上界，降格定性** | §1.3：`SEND_WAIT_LOOP_BOUND_MS = 1_800_000`，**非判死权**，到期动作与 300s 沉默到期完全相同 |

### 0.3 取证清单（本规格重验的证据基线）

| # | 证据 | 位置【实测 @ `d9281d0`】 | 服务于 |
|---|---|---|---|
| E1 | 现行 INVARIANT 原文（渲染端先说话） | `attachmentLimits.ts:190-202`，常量 `SEND_TIMEOUT_CEILING_MS = 180_000` 在 `:203` | §1 |
| E2 | 字节缩放公式 | `attachmentLimits.ts:206-210` `sendTimeoutMs()`；两个生产消费点 `MessageTimeline.tsx:1236`、`ChatComposer.tsx:965` | §1.4 |
| E3 | 等待循环是**固定截止**，零复位 | `ChatComposer.tsx:260-271`：`const start = Date.now(); while (Date.now() - start < timeoutMs)` | §1.2 / §4.1 |
| E4 | 主等待谓词在**首个 assistant 信号**上就释放 | `ChatComposer.tsx:1440-1487`（`:1448` stopped/completed、`:1454` generation、`:1455` fatal、`:1456` `sawAssistantProgress`、`:1474-1476` waiting_permission/question） | 新发现①（仲裁 §0.3-①） |
| E5 | Host stall 表不被 `system` 复位 | `claudeRuntime.ts:794-800` `PRODUCTIVE_EVENT_TYPES`（局部 `const`，五值）；复位点 `:952-953` | §2 / §3 |
| E6 | R9 注记块与无限 rearm | `claudeRuntime.ts:755-773`（`:767` 证据门、`:771` `rearm()`） | §3.1 |
| E7 | TTFT 守卫分支（interactive 层） | `claudeRuntime.ts:747-753`：`permissions.hasPending \|\| questions.hasPending \|\| normalizer.hasOpenTools()` → `:752` `ttftWatchdog.rearm()` | §3.2 |
| E8 | Host 进程 exit / error **零广播** | `AgentHostManager.ts:462-470`（`error` 只写 `this.state='error'`）、`:472-496`（`exit` 只写日志与 `this.state='stopped'`，`clean` 判定在 `:483`） | §6.2 |
| E9 | Main 侧唯一广播口 | `src/main/ipc/chat.ts:174-183` `broadcastRuntimeEvent()`（自带 `isDestroyed()` 守卫） | §6.2 / S5 |
| E10 | `'disconnected'` 已是合法状态成员 | `runtimeEvents.ts:55`；已被 `claudeRuntime.ts:1342`、`codexRuntime.ts` 的 close 路径使用 | §6.2（零协议新增） |
| E11 | 可选字段加法先例 | `runtimeEvents.ts:130-142` 注释 + `:143-155` `SessionRetryInfo` + `:156-160` `SessionStatusEvent.payload` | §3.4 |
| E12 | `RunEntryOutcome` 五个消费点**全非穷尽 switch** | `queueRelease.ts:146` 类型定义；`:227` / `:254` / `:289` / `:353` + `useQueueRelease.ts:84` + `ChatComposer.tsx:564` | §4.3（P0） |
| E13 | 回合头失表 | `MessageTimeline.tsx:952` `inFlight`、`:953-956` `streamStartedAt`、**`:957` `turnActive`**、`:958-963` `elapsedSeconds` | §4.5 |
| E14 | 秒表所有者与 ticker 清除 | `MessageTimeline.tsx:128-136` `useSecondsTick`、`:272` `inFlightSession`、`:287` 启用条件；`ChatComposer.tsx:1864` `window.clearInterval(ticker)` 在 `finally` 第一行、`:1865` `endTurnSend` | §4.5（驳回 B 的冻表方案） |
| E15 | slow 分支今天**可达且被逐字钉住** | `attachments.ts:297` `SLOW_WAIT_HINT_SECONDS = 45`、`:351-353` slow 文案、`:356` 附件文案、`:358` 文本无附件文案；pin 在 `attachments.test.ts:357` / `:436` | §8.1 |
| E16 | kind 与 copy 同源的明文保证 | `turnStatus.ts:115-117` 注释「The threshold is imported, never re-declared … `kind` and copy can only ever flip together」+ `:118` 判定 | §8.3 |
| E17 | Codex 中断参数两个 id 必填 | `codexRuntime.ts:350-357` 类型、`:358-363` 头注（`[实测 codex-turn-schema.json]`）、`:364-369` `buildTurnInterruptParams` | §7.4 |
| E18 | Codex 只有 30min ack 兜底 | `codexRuntime.ts:381` `CODEX_TURN_START_TIMEOUT_MS = 30 * 60_000`；全文无 stall / TTFT 计时器 | §7.1 |
| E19 | Codex 「不渲染 ≠ 没产出」三条 | `codexNormalizer.ts:91-101` `CODEX_IGNORED_NOTIFICATIONS` 含 `turn/plan/updated`、`item/plan/delta`（注：`plan items are not rendered this round`）、`turn/diff/updated`（注：`cumulative turn diff; the per-item fileChange rows already carry every patch`） | §7.3 |
| E20 | 现场 incident 样本（下节） | 真机 0.4.0-test.5 双图，2026-08-18 | §12.4 |

### 0.4 现场 incident 样本登记（工程规范 #8 · D5 回退性依据）

**样本 I-1 — 「45s 放弃路径与重试横幅同屏自相矛盾」**（真机 0.4.0-test.5，2026-08-18，用户截图两张，Claude Opus 5 / Medium 显式选择）。同一屏三处互相矛盾：

| 屏上元素 | 逐字内容 | 生产来源【实测】 |
|---|---|---|
| 蓝色重试横幅 | `Upstream error 503 — retrying 3/10, the turn is still running · Next attempt in 2s · server_error 503` | `retryBanner.ts` ← `session.status.payload.retry` |
| 回合头等待行 | `Waiting for Agent Host reply · Retry 1/10 · 39s (up to 45s)` | `attachments.ts:358` 的 `retrySuffix` 分支（`Waiting for Agent Host reply${retrySuffix} · ${elapsed}s (up to ${budgetSeconds}s)`）；`budgetSeconds` 来自 `sendTimeoutMs(0) = 45_000` |
| 红色报错卡 | `Error: No assistant/tool progress after send (status may still show idle/stopped — Host did not emit failed; the SDK stream likely hung or errored without a result event). \| status=running \| rawEvents=[session.resumed ; session.history ; session.status(idle) ; message.started ; message.delta ; message.completed ; session.status(running) ; session.settingsEcho ; session.stderr ; session.status(running) ; session.status(running,retry 1/10) ; session.stat…]` | `ChatComposer.tsx:1823-1832` `abandonError`；`rawEvents` 由 `formatRuntimeEvent`（`:151-185`）渲染 |
| 输入框 | 用户原文「给我完整的函数」被回显 | `decideFailureAffordance('committed') === 'restore-draft'`（`queueRelease.ts:254`）→ `restoreDraftIfComposerEmpty`（`:1049-1058`） |

**为什么这是本批最强的正控**：rawEvents 串里**明明白白有 `session.status(running,retry 1/10)` 这一帧**——链路在说话、CLI 在重试、Host 从未发 failed——而 45s 固定截止预算（E3）对活性帧**零感知**，照样到期、照样写 `lastError`、照样回显。这一个样本同时证伪了三件事：① 渲染端预算「不看活性」（缺陷 1）；② 「停止等待」被当成「回合失败」（缺陷 2）；③ 回显草稿是猜测的产物（缺陷 3）。

**处置**：立为 **incident 档回归夹具 `[I-1]`**，写进 §12.4；断言方向见该节（正控：retry 帧必须复位新预算、绝不进判死/回显分支；负控：**重试横幅可见时不得出现 no-progress 报错**——「同屏矛盾」是不可能态）。

### 0.5 本稿重验时的四项新发现（两轨与仲裁均未写）

#### 新发现④ · **P0** — 一次性降级若不同时 `resetFired()`，195s stall 会打出 **TTFT 的文案**

【实测】`stallErrorMessage()`（`claudeRuntime.ts:781-789`）的分支键**完全押在 `ttftWatchdog.hasFired` 上**：

```
const stallErrorMessage = () =>
  ttftWatchdog.hasFired
    ? `Host TTFT watchdog: no first response within ${ttftTimeoutMs}ms after send …`
    : `Host stall watchdog: no model progress for ${stallTimeoutMs}ms …`;
```

而 `TtftWatchdog` 的包装器在调用 `onTimeout` **之前**就置 `this.firedFlag = true`（`ttftWatchdog.ts:62` 与 `:94`）。现行代码之所以没暴露这个坑，是因为**每一条不 abort 的分支都调了 `rearm()`**，而 `rearm()` 的第一件事就是 `this.firedFlag = false`（`ttftWatchdog.ts:87`）。

**仲裁 §3.1 裁定的「一次性降级 → 永久关表 → 此后只由 stall 表观察」把 `rearm()` 拿掉了，于是 `firedFlag` 会**停在 `true`**。后果：R9 形态（`system/init` 后永久静默）在 195s stall 真开火时，`normalizer.emitFailed(stallErrorMessage(), …)`（`claudeRuntime.ts:990`（abort 分支）与 `:1031`（catch 分支））会向用户打出 **「no first response within 32000ms」**——一个在 195 秒后出现、却声称 32 秒的句子，比现行行为更不诚实。

这条不是理论风险：`ttftWatchdog.ts:99-108` 的 `resetFired()` 头注**明文写过同一个坑**——「without this, that stale `true` would mislabel a later, genuine stall failure with the TTFT message (`stallErrorMessage()` picks its branch off `hasFired`)」——它是为 R7（Stop 竞态）加的，而本批的降级路径是**第二个**触发它的形态。

**施工强制项**：降级动作必须**同时**做到「永久关表」与「清 firedFlag」。定稿形态见 §3.2 的 `markDegraded()`（对 `TtftWatchdog` 的**纯加法**，不改任何既有方法），回退位是在 `onTimeout` 内连调 `markProductive(); resetFired();`（零类改动，状态终值等价，但 `markProductive` 在「什么产出都没有」的分支上是个命名谎言，不作首选）。**变异 M12 的必红半边因此从一条变两条**（见 §13）。

#### 新发现⑤ — 陈旧跨程序注释是 **6 处**，不是仲裁写的「三处 `120s`」

【实测】逐处点名（三处 `120s` 是**陈旧数值**，三处 `45s` 是**反转后失效的方向断言**，两类都必须在 S1 一并订正，否则新旧注释互相打架）：

| # | 位置 | 现文关键原文 | 性质 |
|---|---|---|---|
| 1 | `claudeRuntime.ts:108` | `deliberately far shorter than DEFAULT_STALL_TIMEOUT_MS (120s) above` | 陈旧数值（真值 `195_000`，`:95`） |
| 2 | `claudeRuntime.ts:108-109` | `MUST stay below the renderer's SEND_BASE_TIMEOUT_MS (45s, src/renderer/components/chat/attachmentLimits.ts)` | 反转后失效（新约束是「Host 恒先说话」） |
| 3 | `claudeRuntime.ts:760` | `left entirely to the much longer 120s stall watchdog (DEFAULT_STALL_TIMEOUT_MS)` | 陈旧数值 |
| 4 | `claudeRuntime.ts:762-763` | `Narrowing the doc invariant above (TTFT always beats the renderer's 45s budget)` | 反转后失效 |
| 5 | `ttftWatchdog.ts:7` | `tolerates up to DEFAULT_STALL_TIMEOUT_MS (120s) of silence BETWEEN them` | 陈旧数值 |
| 6 | `ttftWatchdog.ts:11-14` | `always below the renderer's SEND_BASE_TIMEOUT_MS of 45s — see attachmentLimits.ts's INVARIANT comment` | 反转后失效**且指向一个本批会删掉的注释块** |

第 6 条尤其要紧：它是一条**跨文件的注释引用**，指向 `attachmentLimits.ts` 的 INVARIANT 块——而本批要把那个块整体迁走（§1.5）。不订正就会留下一条指向不存在的段落的引用。

#### 新发现⑥ — F456 rev.1 与本批的两处**新**同区冲突（评审 B-3 已认的两处之外）

【实测】除已确认的 `turnSendStatus.ts` 双新增槽与 `deriveTurnStatus` 调用字面量之外，重验发现两条：

- **⑥-a 锚点漂移**：F456 rev.1 §9.2 影响面表把色阶分档写作 `MessageTimeline.tsx:1372-1377`——那是 **F10 前的行号**。实况：`turnStatusToneClass` 在 `:1387-1392`，`if (kind === 'slow') return 'text-warning';` 在 **`:1389`**。F2 §8.4 把色阶整条移交 F456，所以这条订正**属 F456 rev.2 的义务**，本规格只登记并知会。
- **⑥-b 语义冲突（会按构造打红 F2 的用例）**：F456 rev.1 `[F4-6]` 要求 `deriveTurnStatus` 把 slow 分成两档——`45..179 → 'slow'`、`>=180 → 'stalled'`。若 F2 的 `[TS-1]` 按仲裁 §12.1 的字面写成「`elapsed >= SLOW_WAIT_HINT_SECONDS && !hasBlocks` ⇒ `kind === 'slow'`」，则 F456 ④ 片一落地，`elapsed = 200` 的用例**按构造必红**，而那次红是**假红**（F2 真正想钉的命题没有被推翻）。
  **处置（本规格定稿）**：`[TS-1]` 的承重命题改写为「**kind 与 copy 同源**」而非「恒为 slow」，且断言点锚在 `[45, 180)` 区间内的具体秒数（取 **62s**，与 `attachments.test.ts:357` / `:436` 的既有逐字断言同源）。这样 F456 拆档后 `[TS-1]` 仍然绿，而 F456 自己的 `[F4-6]` 接手 `>=180` 半边——两批各钉各的，无重叠、无假红。F456 rev.1 `[F4-6]` 的描述里已经写了「F2 的 `[TS-1]` 承重半边被弄丢」这个变异靶，说明两批对这条是同向的，只差把 F2 侧的写法收窄。

#### 新发现⑦ — `timeoutMs` / `budgetMs` 的**第二个消费点**被两轨与仲裁全数漏掉

两轨与仲裁在讨论「`sendTimeoutMs` 整组退役」时，只点了两个消费点（`ChatComposer.tsx:965` 的 `const timeoutMs = …` 与 `MessageTimeline.tsx:1236` 的 `DEFAULT_REPLY_BUDGET_MS`）。【实测】实际还有两处，**其中一处漏改会直接产出 `NaN`**：

| 位置【实测 @ `d9281d0`】 | 现文关键原文 | 性质 |
|---|---|---|
| **`ChatComposer.tsx:1122`**（实参表 `:1118-1125`） | `beginTurnSend({ sessionId, phase: 'handshake', elapsedSeconds: 0, budgetMs: timeoutMs, attachmentCount: …, attachmentBytes: … }, baselineMessageId)` | **必改**。`timeoutMs` 在 S2 被删除后，这里若不换源，`TurnSendStatus.budgetMs` 变 `undefined` → `composerSendingLine` 的 `Math.round(input.budgetMs / 1000)`（`attachments.ts:342`）打出 **`(up to NaNs)`** |
| **`MessageTimeline.tsx:1262-1271`** | `PendingTurnHead` 内的**第二个** `deriveTurnStatus({ …, budgetMs: sendStatus.budgetMs, …, hasBlocks: false })` | **F2 侧零改动**（换源经 `beginTurnSend` 自动流过），但必须登记：它是**握手期**回合头，`active: true` + `hasBlocks: false`，45s 后同样命中 slow 分支——属 §9.3 行为破坏 ④ 的一部分 |

**对施工的影响**：§1.3 的换源表与 §10.2 的 `ChatComposer.tsx` 行已补 `:1122`；§11.4 新增两行边界（`2b` / `2c`）。**不新增变异对**——`:1122` 的漏改是编译期/`NaN` 级的显性故障，由既有 typecheck 与 `[I-1d]` 的委托同源比较（`composerSendingLine` 对同一入参的返回值）直接接住，无需单独咬合。

**交叉印证**：并行成稿中的 F456 rev.2 独立登记了同一个 `beginTurnSend` 实参表同区点（其锚写作 `:1117-1126`）与 `PendingTurnHead` 第二消费者（其 `M-7`）。**但 F456 rev.2 在 `turnSendStatus.ts` 一项上判定有误**——它写「同一 interface 的相邻加法 → 🔴 同区」，而【实测】F2 的 `pendingReply` 落在 `TurnSendStatusStore`（`:116-135`）与 store 对象（`:143-165`），F456 的 `promptChars` 落在 `TurnSendStatus`（`:41-52`），**两者相隔约 70 行、不在同一 interface**，应为无冲突的两次加法（§11.4 行 1）。**知会 F456 rev.2 复核该行。**

### 0.6 行号与措辞订正表（相对仲裁档 / 两轨盲稿）

| 出处 | 原写 | 实况【实测 @ `d9281d0`】 |
|---|---|---|
| 仲裁 §4.3 消费点表 | `ChatComposer.tsx:563` | **`:564`**（`:562` 是 `useCallback(` 起始行，`:564` 才是 `if (outcome !== 'committed') return;`） |
| 仲裁 §4.4 / A §4.4 | `MessageTimeline.tsx:952-963` 三行改动 | 块范围对，但**具体承重行**是 `:957`（`const turnActive = inFlight \|\| streamStartedAt != null;`）；`elapsedSeconds` 在 `:958-963` |
| 仲裁 §6.2 / B §10.1 | `src/main/ipc/chat.ts:174-180` | **`:174-183`**（函数体到 `:183`） |
| A §10.2 / 仲裁 §12.1 | `composerStopStatic.test.ts` 文件头散文「45s abandon」**三处** | **五处**：`:14`、`:138`、`:235`（describe 标题）、`:240`、`:256` |
| A §10.2 | `abandonMarkerRef.current = {` 断言**一处**（`:251`） | **两处**：`:251`（`expect(stop).toBeLessThan(only(…))`）与 `:272`（`expect(body).not.toContain(…)`），改名时两处都要改 |
| A §0.4 承重事实表 | 「`session.status(running)` 每回合只发一次，全文无第二处 running 发射」 | **成立**【实测】：`claudeRuntime.ts` 的 8 处 `session.status` 发射中，只有 `:643` 发 `'running'`；其余是 `idle`(`:423`/`:532`)、`failed`(`:1063`)、补偿态(`:1147`)、回显态(`:1315`)、`stopping`(`:1325`)、`disconnected`(`:1342`)。但**推论要按仲裁 A-2 改写**：本批一次性降级后 Host 的诊断帧全回合最多两帧，是**诊断不是心跳**；渲染端也不需要心跳（新发现①） |
| A §0.3-④ | `MessageTimeline.tsx:935-946` / `:286` / `:1221` / `:1372-1377` / `:534-541` | `:952-963` / `:287` / `:1236` / `:1387-1392`（`text-warning` 在 `:1389`）/ 中性红卡文案在 **`:557`** |
| A §10.1 | `queueRelease.ts:181/226/250/285/352` | 这些是**函数声明行**；**判据行**是 `:227` / `:254` / `:289` / `:353`（`decideRunEntryOutcome` 声明在 `:181`） |
| B §0.1 / §10.1 | `attachmentLimits.ts:165-210` 为超时半边 | 精确：`:165-166` `SEND_BASE_TIMEOUT_MS`、`:168-173` `SEND_MS_PER_MB`、`:175-180` `HOST_STALL_TIMEOUT_MS`、`:182-188` `HOST_TTFT_TIMEOUT_MS`、`:190-203` INVARIANT + `SEND_TIMEOUT_CEILING_MS`、`:205-210` `sendTimeoutMs`；文件共 210 行 |

---

## §1 题一：分工形态与跨程序不变量

### 1.1 裁定原文化

【仲裁 §1.1】**Host 唯一裁决 + 唯一 abort；渲染端到期不 finalize / 不 unbind / 不写 error / 不回显。** 现行 INVARIANT 反转重写为有序链：

```
HOST_TTFT_TIMEOUT_MS (32s) < HOST_STALL_TIMEOUT_MS (195s) < SEND_SILENCE_CEILING_MS (300s)
                                                          <= SEND_WAIT_LOOP_BOUND_MS (30min)
```

但**这条链不是「三只表比大小」**，注释必须按下面的两段语义写，否则 rev.2 会为一个不存在的耦合写测试：

- 前两项（32s / 195s）是**同一条回合生命线上的两段**：TTFT 管首活性之前，stall 管首活性之后。
- 第三项（300s）与 stall **不在同一区间上竞争**——依据新发现①【实测 E4】，渲染端的主等待谓词在**首个 `'assistant'` 信号**上就释放（`ChatComposer.tsx:1456` 的 `if (sawAssistantProgress) return true;`，而 `classifyAssistantProgress`（`assistantProgress.ts:278-310`）把 `permission.requested` / `question.requested` / `tool.*` / `thinking.*` 全判为 `'assistant'`；`:1474-1476` 还额外在 `waiting_permission` / `waiting_question` 下释放）。**渲染端预算在语义上是一只 TTFT 表，永远不是 stall 表**，它根本活不到 stall 的辖区。300s 之所以必须大于 195s，是因为 R9 形态（`system/init` 后永久静默）的**实际终结者是 stall 而不是 TTFT**，而那正是渲染端唯一还在等的区间。

> **删除 A §1.1 第三条「复位不对称」论证。**【仲裁】它用「渲染端的表复位得不比 Host 慢」来论证 195s < 300s，而实际不需要——渲染端在 Host stall 的辖区里已经不在等了。数值链保留，论证换成上面的区间论证。

两条独立成立的不对称理由**保留原文**：

- **信息不对称**【实测】：`api_retry`（`claudeRuntime.ts:949-951`）、`[cli-stderr]`（`:865`）、子进程抛错（catch 分支 `:1031`）三类证据只存在于 Host 进程内；渲染端拿到的是 normalizer 过滤后的投影。让信息少的一方先裁决，结构性地保证裁决质量更差。
- **动作不对称**【实测】：渲染端到期时**故意不 stop**（`ChatComposer.tsx:1758-1769` 明文记录 a5 回退的理由：「the code must not press Stop FOR them: a5 could kill a turn that was about to succeed」），所以它的「失败」判决没有任何执行力——回合照跑，只是 UI 撒谎。Host 的 `abort()` 是真停。**一个不能执行判决的角色不该拥有判决权。**

### 1.2 施工细则：两个上限的语义与命名

【仲裁 §1.2 合取】A 的「可复位沉默表」与 B 的「硬性终点」是互补反例，两者都保留，但第二个上限**降格定性**——它不是第三只狗，是轮询循环的资源上界。**【拍板 D6】确认。**

```ts
/**
 * F2 (2026-08-18): the renderer's SILENCE ceiling — NOT a verdict.
 * Reset by ANY liveness frame for this session (see classifyTurnLiveness).
 * Expiry means only "this renderer stops waiting locally"; the turn is not
 * dead and nobody has said it is. User-locked value.
 */
export const SEND_SILENCE_CEILING_MS = 300_000;

/**
 * F2 (2026-08-18, decision D6): absolute upper bound of the 50ms polling
 * loop, so an endless liveness stream (stderr chatter / retry storm) cannot
 * keep it alive forever. NOT a third watchdog and NOT a verdict: expiry does
 * EXACTLY what a silence expiry does (the 'ceiling' branch, §4). Aligned with
 * CODEX_TURN_START_TIMEOUT_MS (codexRuntime.ts:381) so the two programs stop
 * disagreeing by 40x.
 */
export const SEND_WAIT_LOOP_BOUND_MS = 1_800_000;
```

两者到期走**同一个出口**（§4.2 的 `'ceiling'` 分支），因此不存在两套语义、不需要两套测试。

**反转后的 INVARIANT 注记块**（迁入 `sendBudgets.ts`，替换 `attachmentLimits.ts:190-202` 的现文）必须写清三件事：① 有序链的数值；② 前两项是「同一生命线的两段」、第三项「不与 stall 竞争同一区间」；③ 第三项之所以大于 stall，是为了让 R9 形态的实际终结者（stall）先说话。**禁止**保留任何「渲染端先说话」的措辞残片。

### 1.3 施工细则：`sendTimeoutMs` 字节缩放整组退役

【仲裁 §1.4】**取 A（整体作废），B 的保留方案被 B 自身证据否掉。** 论证链【实测】：

1. `normalizer.beginTurn`（`claudeRuntime.ts:640`）在 `queryFn(...)`（`:831`）**之前**执行 —— 用户回声在回合受理的那一刻发出，与附件字节无关。
2. `sendTimeoutMs` 的 30s/MB 缩放（`attachmentLimits.ts:206-210`）建立在「大附件让**首个回应**更晚」这个假设上。
3. 改成**可复位的沉默表**后，回声恒在 t≈0 到达并立即复位它 ⇒ 字节缩放对沉默表**恒等于零作用**。
4. B 想保留的 size metadata **不依赖这个函数**【实测】：`composerSendingLine` 的 size 展示走 `attachmentCount` / `attachmentBytes` 两个**独立入参**（`attachments.ts:354-357`），`largeAttachmentHint`（`attachmentLimits.ts:146-162`）也独立。保留只会留下一个没有消费者的公式。

**裁定**：`SEND_BASE_TIMEOUT_MS` / `SEND_MS_PER_MB` / `SEND_TIMEOUT_CEILING_MS` / `sendTimeoutMs` **整组退役，不留兼容别名**。

**连带的两个生产消费点**【实测】，均在本批范围内：

| 消费点 | 现文 | 改为 |
|---|---|---|
| `MessageTimeline.tsx:1236` | `const DEFAULT_REPLY_BUDGET_MS = sendTimeoutMs(0);` | `= SEND_SILENCE_CEILING_MS`（import 从 `./attachmentLimits` 换成 `./sendBudgets`） |
| `ChatComposer.tsx:965` | `const timeoutMs = sendTimeoutMs(attachmentBytes);` | **删除该行**；改为 `const budget = createSendWaitBudget(Date.now());`（§4.1） |
| `ChatComposer.tsx:1122`【实测·本稿新增锚点】 | `beginTurnSend({ …, budgetMs: timeoutMs, … })`（实参表 `:1118-1125`） | `budgetMs: SEND_SILENCE_CEILING_MS`。**这是 `timeoutMs` 的第二个消费点**，两轨与仲裁都只点了 `:965` 与 `:1440`；漏改会让 `TurnSendStatus.budgetMs` 变成 `undefined`，`(up to Ns)` 打出 `NaN` |
| `MessageTimeline.tsx:1262-1271`【实测·本稿新增锚点】 | `PendingTurnHead` 内的**第二个** `deriveTurnStatus` 调用，读 `sendStatus.budgetMs` | **F2 侧零改动**——换源经 `beginTurnSend` 自动流过来。登记在此只为让施工方与 F456 都知道它存在（握手期回合头，`hasBlocks: false` + `active: true`，45s 后同样会命中 slow 分支，属 §9.3 变化 ④ 的一部分） |

> **注**：`budgetMs` 仍是 `TurnSendStatus` 的字段（`turnSendStatus.ts:48`），只是换源。**不删该字段**——它是 `(up to Ns)` 从句的入参，而那条从句的去留已移交 F456（§8.4）。

### 1.4 施工细则：`SLOW_WAIT_HINT_SECONDS = 45` 保持不动

见 §8.2。此处只记录它与本节的关系：预算抬到 300s 而阈值留在 45s，正是让 `45s → 300s` 这段窗口成为**可见的「仍在等待」态**（§4.5 需要的那个态）的原因。**上调阈值会把这段窗口重新变成沉默。**

### 1.5 施工细则：拆 `sendBudgets.ts`

【仲裁 §1.4】**拆**，但**不进拍板清单**（成本极低、可逆）。

- 新建 `src/renderer/components/chat/sendBudgets.ts`，导出：`SEND_SILENCE_CEILING_MS`、`SEND_WAIT_LOOP_BOUND_MS`、`HOST_STALL_TIMEOUT_MS`（镜像）、`HOST_TTFT_TIMEOUT_MS`（镜像）、`createSendWaitBudget()`、反转后的 INVARIANT 注记块。
- `attachmentLimits.ts` 删 `:165-210` 全部超时半边，**只留附件限额半边**（`:1-164`）；文件头（`:1-12`）自述的存在理由（「限额检查与超时公式不能漂移」）随缩放公式一起改写。
- **回退位**：若施工时 diff 过大，全部新符号原地留在 `attachmentLimits.ts` 亦可，**其余裁定一条都不受影响**（拆文件是可读性选择，不承重）。
- **镜像源文锁必做**（补 A 新发现③的洞）【实测】：`attachmentLimits.ts:175-179` 自称「the invariant below is locked by a unit test」，但 `attachmentLimits.test.ts:248-262` 全文只做**镜像之间的数值比较**，**没有任何一处读 `claudeRuntime.ts` 的真值**——镜像可以静默漂移。`[C-03]` 补这个洞（§12.1）。

---

## §2 题二：活性谓词、三层词表、api_retry 封顶、模块归属

### 2.1 裁定原文化：渲染端谓词取**两函数**形态，`classifyAssistantProgress` 一字不改

【仲裁 §2.1】给 `AssistantProgressSignal` 加第三个成员，等于在类型层邀请后来者写 `!== 'ignore'`——那正好把 liveness 误当 progress，即分诊「防错修」明令禁止的「放宽谓词让 `message.delta` 算进度」的复活路径。**两值联合关不上这个门，两个函数能。**

仲裁补的加强理由【实测】：`classifyAssistantProgress` 的返回值被**三条链**同时消费——

1. `ChatComposer.tsx:1242` `=== 'assistant'` → `sawAssistantProgress`
2. `sawAssistantProgress` → `:1456` 主等待释放
3. `sawAssistantProgress` → `decideRunEntryOutcome`（`queueRelease.ts:181`）的受理证据 → Retry 装配

**一次误宽会同时污染「等待释放」「受理判定」「Retry 装配」三条链。这是全仓最不能放宽的谓词。**

### 2.2 施工细则：新增 `classifyTurnLiveness`

落点 `assistantProgress.ts`（同族谓词唯一之家：`isUserEchoForSend` / `isSessionFailedForSend` / `isSessionStoppedForSend` / `isSessionCompletedForSend` / `resolveAbandonProgress` 都在此）。**`classifyAssistantProgress`（`:278-310`）一个字符都不改。**

```ts
export type TurnLivenessSignal = 'liveness' | 'ignore';
/**
 * F2 (2026-08-18): "the Host is still talking ABOUT THIS SESSION" — strictly
 * WIDER than classifyAssistantProgress and deliberately a SEPARATE function.
 * Widening the progress union instead would invite `!== 'ignore'`, i.e. exactly
 * the "let message.delta count as progress" regression the triage forbids.
 * Consumers: the renderer's silence budget ONLY. Never an admission or a
 * Retry-arming signal.
 */
export function classifyTurnLiveness(event: ProgressEvent, sessionId: string): TurnLivenessSignal;
```

**会话作用域**：所有判定先过 `event.sessionId === sessionId`；无 sessionId 的事件（仅 `host.error` 的 `session_not_found` 一例）恒为 `'ignore'`。

渲染端 liveness 词表（逐条给理由，A §2.2 原表 + 仲裁词表对齐）：

| 事件类型 | liveness？ | 理由 |
|---|---|---|
| `message.started` / `delta` / `completed`（**任意 role**） | 是 | Host 正在为**本会话**写字；user role 三连是「回合已受理」的证据，是活性，但按 §2.1 **不是** progress |
| `thinking.*` / `tool.*` / `permission.requested` / `question.requested` | 是 | 已是 progress，按包含关系必然成立 |
| `session.status`（**任意 status，含 `retry`、含新 `liveness` note**） | 是 | Host 进程活着且在谈论本会话。含 `retry` 时尤其重要：那是「CLI 正在重试」而非「卡死」——**incident `[I-1]` 的正控就在这一行** |
| `session.stderr` | 是 | CLI 子进程活着并在输出（`claudeRuntime.ts:812-827`） |
| `usage.updated` | 是 | D33 interim token tick，模型正在产出 |
| `subagent.activity` | 是 | 子代理在跑；主流可以长时间无帧（T-34 分流的直接后果） |
| `session.created` / `resumed` / `updated` / `settingsEcho` / `permissionUpdated` | 是 | 握手期与中途改档的帧，证明 Host 在响应 |
| `permission.resolved` / `question.resolved` | 是 | 用户答完，回合应当继续；不给活性会让「答完后模型思考很久」被误判 |
| `session.history` / `historyListed` | 否 | 回放/列表，与本回合无关 |
| `host.error` | 否 | 是裁决不是活性；它有自己的通道（`fatalHostError`） |
| `session.completed` / `failed` / `stopped` | 否 | 终态，结束等待而非延长等待 |

### 2.3 裁定原文化：三层活性词表是**跨两端的文档契约**

【仲裁 §2.2 合取】A 的两层与 B 的三层不是竞争关系，是**粒度关系**。B 的 `interactive` 层对应的是两只 Host 狗**已经写在代码里**的 rearm 守卫【实测 E7】；A 的两层模型没有名字可以指称这条分支，于是被迫编码成 liveness note 的 `reason` 枚举——同一个事实被表达了两次。

| 层 | 含义 | Host 用途 | 渲染端投影 |
|---|---|---|---|
| `productive` | 模型/工具真实产出 | 满足 TTFT + 复位 stall（`PRODUCTIVE_EVENT_TYPES`，**冻结**） | `classifyAssistantProgress === 'assistant'` |
| `interactive` | 明确等待用户或本地工具 | **暂停**强杀（既有 rearm 守卫，`claudeRuntime.ts:747-753` / `:688-695`），不累计为失败、**不触发降级** | 已并入 `'assistant'`（`permission.requested` / `question.requested`），**不改** |
| `transport` | 链路在说话但没有产出 | 既不满足 TTFT 也不复位 stall（`system` / stderr / `api_retry`） | `classifyTurnLiveness === 'liveness'` |

这张表让 A 的包含关系断言（`[L-1]`：progress ⊆ liveness）与 B 的负控（transport ≠ productive）**同时**可写，且把「渲染端把 transport 也算活性、Host 故意不算」这条两端刻意不同的语义写成了一句话。

**共享的是这份文档契约，不是一个运行时模块**——【仲裁 §2.4】**驳回 B 的 `turnWatchdogPolicy.ts`**：两轴的事件词表完全不相交【实测】（Claude 侧是 SDK 顶层类型 `assistant`/`user`/`result`/`tool_progress`/`stream_event`；Codex 侧是 JSON-RPC 方法名 `turn/started`、`item/agentMessage/delta` …），可共享的只有 deadline 算术，而它已经在 `ttftWatchdog.ts:39-126` 抽成了可注入 timer 的纯类。B 的 S0 模块会变成「两个 adapter + 一个几乎空的核心」。

### 2.4 施工细则：`PRODUCTIVE_EVENT_TYPES` 冻结 + 提升到模块作用域

【实测 E5】现集合恰为五值，且是 `send()` 闭包内的**局部 `const`**（`claudeRuntime.ts:794-800`）。

- **一个成员都不加**。加 `system` 会直接摧毁 C-14 检测器（无效模型 → 无穷 `api_retry` 流），`claudeRuntimePartialStall.test.ts:126` 的 `it('still stalls when the same span carries only control-plane events')` 会红，**而那条红是对的**。
- **必须先提升到模块作用域再导出**（A-5 登记的、两轨都没算进影响面的真实改动）：`export const PRODUCTIVE_EVENT_TYPES = new Set([...])` 移到模块级，`send()` 内改为直接引用。测试断言其成员**恰为**这五个（`toEqual(new Set([...]))`），任何增删都红。
- `claudeRuntimePartialStall.test.ts` **零改动**，它是这条冻结的守门人（S1 收口条件之一是它保持绿）。

### 2.5 裁定原文化：api_retry 封顶——**两轨的具体数值全部退役**【拍板 D3】

这是仲裁唯一「两轨皆驳回」的项。理由是本仓对无证据常量的既定纪律：

- A 的 `TTFT_API_RETRY_ABORT_ATTEMPTS = 3`：拍脑袋。SDK 退避是指数的，3 次重试的墙钟跨度可能是 6s 也可能是 200s，计数与「等了多久」脱钩。
- B 的 `API_RETRY_LIVENESS_CAP_MS = 90_000`：B 自己在 OQ2 承认「是设计裁定，不是当前代码/遥测事实」。
- 两者都在**给一个已经有正确兜底的路径再加一层**【实测】：`api_retry` 走 `system` 事件（`claudeRuntime.ts:949-951` 判定 `eventType === 'system' && subtype === 'api_retry'`），不在 `PRODUCTIVE_EVENT_TYPES` 内，因此**不复位 stall 表**，195s 后 Host 必然开火。`claudeRuntimePartialStall.test.ts:126-133` 已把这条钉死。**封顶今天就存在，且是正确的。**

**三条施工裁定：**

1. **abort 证据里的重试项改为 `attempt >= maxRetries`**——取 B 的字段证据。`SessionRetryInfo` 已有 `attempt` / `maxRetries` / `delayMs` / `errorStatus` / `error` 五个字段（`runtimeEvents.ts:143-155`），不引入任何新常量，语义精确到「SDK 自己已经放弃了」。**字段缺失时不猜，直接不构成证据。**
2. **删除 A 的计数阈值与 B 的 90s 墙钟 cap**，两个常量都不落地【拍板 D3：不付无据常量】。
3. **A 的现行收紧仍然采纳**：单次 `sawApiRetry === true` 不再构成 abort 证据（现行 `claudeRuntime.ts:767` 的证据门只要它为真就开火，会杀掉本来第 2 次就会成功的回合）。这是本题的**真正修复**，且不需要任何新常量——`attempt >= maxRetries` 直接替换它。

> **接线细节 + 一个必须避开的陷阱**【实测】：
>
> `claudeRuntime.ts:948-951` 拿到的是**原始 SDK 事件对象**，字段名是 snake_case（`attempt` / `max_retries` / `retry_delay_ms` / `error_status`，形状由 `eventNormalizer.ts:1042-1049` 的注释逐字记录）。施工时在 `:950` 那一行同时记录**最近一帧的 `attempt` / `maxRetries`**（两个 `number | null`，初值 `null`），证据门读它们；**任一为 `null` 时该项不成立**（不猜）。
>
> **陷阱（必须避开）**：`api_retry` 的**归一化 wire payload** 把缺失字段兜底成 **`0`**（`eventNormalizer.ts:1090-1091`：`typeof msg.attempt === 'number' ? msg.attempt : 0`，`max_retries` 同）。若图省事去读 `session.status.payload.retry` 而不是原始事件，一帧缺字段的 retry 会让证据门算出 `0 >= 0 === true` ——**第一次重试就 abort**，比现行行为还糟。**证据门必须键在原始 SDK 事件上**，`session.status.payload.retry` 只服务展示与诊断。

---

## §3 题三：TTFT 证据门重设计、R9 洞、协议加法

### 3.1 裁定原文化：R9 的定性纠正

【仲裁 §3.1 + 分诊纠错】分诊写「该形态下 Host 全线失守」是**过度描述**【实测】：`claudeRuntime.ts:755-773` 的 R9 形态（`system/init` 到达 → 此后永久静默 → 无 `api_retry` → 证据门 `!(sawApiRetry || !sawAnySdkEvent)` 恒为真 → 无限 `rearm()`）确实由 **stall 表接管**——`onStall` 的复位只来自 `PRODUCTIVE_EVENT_TYPES`（`:952-953`，不含 `system`），所以 stall 计时器从 `armStallTimer()`（`:912`）起算，195s 后必然开火 → `stalled = true` → `abort()` → `session.failed`（`:990`）。

**失守的是「Host 先于渲染端说话」这条不变量，不是 Host 本身。** 这条纠正必须落进注记，否则会有人去实现一个不需要的第三证据信号。

**明确拒绝再加第三个证据信号**（两轨一致）。可选项都不合格：对 stderr 做子串嗅探（auth failed / ENOENT / …）是本仓已经栽过的坑（`ChatComposer.tsx:1790-1794` 的 F12 注记明文记录：子串嗅探会误命中看门狗自己的失败文案——`"transport-layer retry loop"` 里也有 `retry` 这个词）；「init 到了但只有 system 事件且超时」就是 stall 表本身，再实现一遍是重复。

### 3.2 施工细则：TTFT 到期的三分处置（一次性降级）

【仲裁 §3.1 合取】取 B 的**一次性阶段迁移**替换 A 的无限 rearm：`rearm()` 每 32s 重入**同一个必然为假的判断**，而心跳的唯一真实收益是诊断、不是判决——为诊断付一条每 32s 的协议流量不划算（且新发现①已证明渲染端**不需要**这条心跳）。

`onTimeout` 改写为**三分**（现文 `claudeRuntime.ts:731-780`（`onTimeout` 体））：

| 分支 | 触发条件【实测锚】 | 动作 | `reason` |
|---|---|---|---|
| **A · 已 abort** | `abort.signal.aborted`（`:743`） | `ttftWatchdog.resetFired(); return;` —— **逐字保留，一个字不改**（R7/F14-m12 资产） | — |
| **B · interactive 暂停** | `permissions.hasPending \|\| questions.hasPending`（`:748-749`）→ `awaiting_user`；`normalizer.hasOpenTools()`（`:750`）→ `tool_running`。**必须拆成两个判定**，不能合并 | 发一帧诊断 → **`ttftWatchdog.rearm()`（保留）** → return。**不降级**：这是「合法暂停」（§2.3 的 `interactive` 层语义） | `awaiting_user` / `tool_running` |
| **C · 证据不足** | 证据门未过（现文 `:767`，新形态见下） | 发一帧诊断 → **一次性降级**（见下）→ return | `insufficient_evidence` |
| **D · 证据成立** | 见 §3.3 证据清单 | `stalled = true; log; abort.abort();` —— 结构保留，只换证据 | — |

> 分支 B 与 C 的区分**两轨都没写清**，是仲裁的补齐：`interactive` 暂停**不触发降级**，只有 `insufficient_evidence` 触发。

**一次性降级的具体动作（含新发现④的 P0 修正）：**

```ts
// 在 TtftWatchdog 上新增（纯加法，既有方法一个字不改）：
/**
 * F2 (2026-08-18): the TTFT phase ended WITHOUT evidence of failure. Close the
 * table permanently (like markProductive) AND clear firedFlag (like resetFired):
 * from here the rolling stall watchdog is the only observer, and when IT fires,
 * stallErrorMessage() must pick the STALL branch — a 195s failure must never be
 * reported with the TTFT watchdog's "no first response within 32000ms" wording.
 */
markDegraded(): void {
  this.satisfied = true;                 // permanently disarm (arm/rearm become no-ops)
  if (this.handle) { this.clearTimeoutFn(this.handle); this.handle = null; }
  this.firedFlag = false;                // <- new finding (4): without this, stallErrorMessage lies
}
```

- **为什么必须有 `firedFlag = false`**：见 §0.5 新发现④。`ttftWatchdog.ts:99-108` 的 `resetFired()` 头注已经把这个坑写死过一次。
- **回退位（零类改动）**：在 `onTimeout` 内连调 `ttftWatchdog.markProductive(); ttftWatchdog.resetFired();`——状态终值等价（`satisfied=true, firedFlag=false, handle=null`），但 `markProductive` 在「什么产出都没有」的分支上是命名谎言，**不作首选**。
- 降级后 `arm()`（`:56-58` 的 `if (this.satisfied || this.firedFlag || this.handle) return;`）与 `rearm()`（`:86` 的 `if (this.timeoutMs <= 0 || this.satisfied) return;`）都会静默 no-op，**表永久关闭**，符合裁定。

### 3.3 施工细则：证据清单与 `!sawAnySdkEvent` 的二次窗口

【仲裁 §3.2 合取】**保留 `!sawAnySdkEvent`（驳回 B），但降级为「二次窗口证据」。**

- B 要删除它的理由「无帧也可能是健康的长首响应」【实测】站不住：`!sawAnySdkEvent` 不是「32s 无产出」，是「32s 内连 `system/init` 都没有一帧」——`system/init` 是 SDK 会话初始化帧（`eventNormalizer.ts:1068-1074` 收到它就发 `session.status(running)`），它的缺席意味着子进程从未初始化，正是 `claudeRuntime.ts:722-724` 注释说的 dead spawn / auth failure。
- 但 B 指向一个真实场景：**冷启动**（首次 `npx` 拉包、慢盘、杀软扫描）下 CLI 子进程可能超过 32s 才吐第一帧，此时 abort 会杀掉一个只是启动慢的健康回合，而 Retry 会把它推进同一个超时——正是 `:713-725` F1 注记想避免的确定性失败环。

**合取裁定**：`!sawAnySdkEvent` 只在**第二个 TTFT 窗口**成立。

```
TTFT 首次到期 && !sawAnySdkEvent
  → 不 abort；发降级诊断帧（reason:'insufficient_evidence'）；ttftWatchdog.rearm()   ← 唯一允许的一次 rearm
TTFT 第二次到期 && !sawAnySdkEvent
  → abort（证据成立）
```

默认下判死时刻从 32s 后移到 **64s**，仍远小于 195s stall 与 300s 渲染端上限，链条不破，**且不引入任何新常量**。实现：一个 `let ttftWindowsElapsed = 0;` 局部计数（在 `onTimeout` 顶部 `+= 1`），不是新的可配置常量。

> **注意与 §3.2 的交互**：这条 rearm 是分支 C 的一个**子情形**——`!sawAnySdkEvent` 且是第一窗口时走 `rearm()` 而**不是** `markDegraded()`；`sawAnySdkEvent === true`（R9 形态）时第一窗口就 `markDegraded()`。两者都发 `reason:'insufficient_evidence'` 诊断帧。

**完整证据清单（含不走看门狗的路径）**：

| 证据 | 谁发现 | 走哪条路【实测】 |
|---|---|---|
| 子进程退出 / spawn 失败 / auth 失败抛出 | SDK 迭代器抛错 | `claudeRuntime.ts` catch 分支 → `:1031` `emitFailed` → `session.failed`。**不经看门狗**，本来就是最快最准的路径 |
| 流自然结束但无 `result` | 主循环退出 | `finishTurn` 合成终态（`:1005` 之后的分支） |
| **`attempt >= maxRetries`**（两字段均非 null） | TTFT 狗 | 新形态，替换现行的单次 `sawApiRetry` |
| **`!sawAnySdkEvent` 且已是第二窗口** | TTFT 狗 | 新形态，替换现行的首窗口即 abort |
| 195s 无 productive 事件 | stall 狗 | 既有，**不改** |
| 停在权限/问题/工具上 | 两只狗的守卫 | `rearm()` + 发 `interactive` 诊断帧，**不降级** |
| **Host 进程整体退出** | **无人** | **§6.2 的洞，本批必须补（S5）** |

**副作用登记**：`claudeRuntimeOptions.test.ts:578-602` 的「零帧 50ms 直接 TTFT failed」必须改为「**两个窗口后**才 failed」，而**不是** B 主张的「永不 failed、交给 stall」（§12.1）。

### 3.4 施工细则：协议加法 `SessionStatusEvent.payload.liveness`

【仲裁 §3.3】两轨独立同判「骑在 `session.status` 上做可选字段，不新建事件类型，`AGENT_HOST_PROTOCOL_VERSION` 保持 `1`」，先例是 `SessionRetryInfo`【实测 E11】。字段名取 A 的 `liveness`（与 §2.3 的三层词表同源）；B 的 `watchdog` 描述的是**发送者**而非**内容**。

```ts
/**
 * F2 (2026-08-18 watchdog redesign): one Host watchdog window elapsed and the
 * watchdog DECLINED to abort. Status stays 'running' — the turn is alive.
 *
 * Optional-field addition; AGENT_HOST_PROTOCOL_VERSION stays 1 (same precedent
 * as SessionRetryInfo above). GUARD FOR LATER READERS: if you are ever tempted
 * to promote this to its own RuntimeEventType, you must FIRST prove that the
 * old renderer reducer is a no-op on unknown event types — until that proof
 * exists, an optional field on an already-consumed event is the only shape
 * whose compatibility is established rather than assumed.
 */
export interface SessionLivenessNote {
  /** Which watchdog spoke. */
  source: 'ttft' | 'stall';
  /** The budget that elapsed with no qualifying progress, ms. */
  budgetMs: number;
  /** Why it declined to abort — never a guess, always the branch that ran. */
  reason: 'awaiting_user' | 'tool_running' | 'insufficient_evidence';
  /** Whether the TTFT table was permanently closed by this note (§3.2 markDegraded). */
  degraded: boolean;
}
// runtimeEvents.ts:159 payload 改为:
//   payload: { status: SessionRuntimeStatus; retry?: SessionRetryInfo; liveness?: SessionLivenessNote }
```

- **三个 `reason` 与代码分支一一对应，不是事后归类**（§3.2 的表已逐条给锚）。
- **不带 `retryCount`**（A 原稿的第四个字段）：【拍板 D3】既然不以计数为证据，就不该在协议上留一个没有判决用途的计数器。需要重试信息的消费方读**同一个 payload 上已有的 `retry`**（`SessionRetryInfo`），单一真源。
- **全回合最多两帧**：`interactive` 暂停帧可多次（每个 TTFT 窗口一帧），`insufficient_evidence` 降级帧全回合**恰一帧**。这不是心跳。

**消费方（「生产者缺席消费者」纪律，采纳并收紧）**——施工时**必须实测两者都跑到**，否则是空壳：

1. `classifyTurnLiveness` 把 `session.status` 记为 liveness（§2.2 词表已含）→ 复位沉默表。
2. `formatRuntimeEvent`（`ChatComposer.tsx:151-185`）打印它，进 `rawEvents=[…]` 诊断串。**现文的 `if (status)` 分支（`:178-181`）已经在拼 `retry` 后缀**，liveness 按同样形态追加：`session.status(running,retry 1/10,ttft-degraded)`。

### 3.5 施工细则：R9 注记块与陈旧注释订正

`claudeRuntime.ts:755-766` 的 R9 注记块**整段改写**，新文必须讲清三件事：① 本形态刻意交给 stall 表（不是失守）；② 渲染端沉默天花板高于 stall 预算，故 **Host 恒先说话**；③ 一次性降级后 TTFT 表永久关闭，`markDegraded()` 同时清了 `firedFlag` 所以 stall 的失败文案不会被冒名（新发现④）。

**六处陈旧注释全部订正**——逐处清单见 §0.5 新发现⑤，S1 一并处理，**漏一处即视为该片未收口**。

---

## §4 题四：渲染端到期动作重构与静态断言

### 4.1 施工细则：等待循环从「固定截止」改为「可复位预算」

【实测 E3】`ChatComposer.tsx:260-271` 的 `waitUntil(predicate, timeoutMs, stepMs)` 是**固定截止**，`predicate` 只决定是否提前 release，**零复位机制**（分诊缺陷 1 写「唯一复位条件是 `classifyAssistantProgress === 'assistant'`」是错的，实况是「零复位条件」——这条订正必须进正文，修法方向不变，事实要写准）。

**换签名（注入到期谓词）**：

```ts
async function waitUntil(
  predicate: () => boolean,
  expired: () => boolean,
  stepMs = 50
): Promise<boolean>
```

**三个调用点全在同一文件内**【实测】，两个握手点语义不变（传固定截止谓词）：

| 调用点 | 现文 | 改为 |
|---|---|---|
| `:1371` create 握手 | `waitUntil(() => sawSessionCreated \|\| Boolean(fatalHostError), 5000)` | `…, deadlineAt(5000))` |
| `:1440` 主等待 | `waitUntil(() => { …谓词体… }, timeoutMs)` | `…, () => budget.isExpired(Date.now()))` |
| `:1538` resume 握手 | `waitUntil(() => sawSessionResumed \|\| Boolean(fatalHostError), 5000)` | `…, deadlineAt(5000))` |

**预算对象是纯函数模块**（`sendBudgets.ts`，无定时器、无 store、无 React，node 环境可直测）：

```ts
export function createSendWaitBudget(startedAtMs: number, opts?: {
  silenceCeilingMs?: number;   // default SEND_SILENCE_CEILING_MS
  loopBoundMs?: number;        // default SEND_WAIT_LOOP_BOUND_MS
}): {
  markLiveness(nowMs: number): void;   // monotonic: never moves lastLiveness backwards
  isExpired(nowMs: number): boolean;
  lastLivenessAtMs(): number;
};
// isExpired(now) === (now - lastLiveness >= silenceCeiling) || (now - startedAt >= loopBound)
```

**监听器里一行接线**，紧邻既有的 `classifyAssistantProgress` 那行（`:1242`）：

```ts
if (classifyAssistantProgress(event, assistantMessageIds) === 'assistant') { … }   // 既有，不动
if (classifyTurnLiveness(event, sessionId) === 'liveness') budget.markLiveness(Date.now());  // 新增
```

两条并排即为「liveness 不等于 progress」的**现场佐证**，也是静态断言 `[S-6]` 的锚点。

### 4.2 施工细则：`sendAndWait` 返回判别联合 + 两层分流

【仲裁 §4.2 合取】取 B 的判别联合作为**分支标签**，取 A 的分流判据。两层不冗余：**第一层说「渲染端为什么停止等待」，第二层说「Host 到底受理了没有」。**

B 的显式 `case` 标签有一个 A 没有的硬收益【实测】：本仓对 `.tsx` 不可测事实的既有工法是**源文静态断言**（`composerStopStatic.test.ts:1-16` 头注明文说 `.tsx` 闭包无法直接执行）。以 `case 'ceiling':` 到 `case 'terminal':` 之间的源文切片作断言锚点，比 A 的「pending 分支体」锚点稳定得多——后者依赖**变量命名**不变，前者依赖**分支标签**不变。

```ts
type WaitResult = 'progress' | 'terminal' | 'cancelled' | 'ceiling';
```

到期出口在 `'ceiling'` case 内，**再**按 A 的纯函数分流：

```ts
/** F2: how the renderer classifies a turn it stopped waiting on. NOT a failure
 *  classifier — there is no error here. Kept separate from decideRunEntryOutcome's
 *  fatal-error path on purpose. */
export function decideAdmittedTimeoutOutcome(input: {
  sawUserEcho: boolean; sawAssistantProgress: boolean;
}): 'pending' | 'rejected' {
  return input.sawUserEcho || input.sawAssistantProgress ? 'pending' : 'rejected';
}
```

- **`'rejected'`（无回声）**：Host 从未受理 → 这**是**真失败。既有处置**全部保留、一个字不改**：`unbindHost()`（`:1757`）、`getHostStatus()` 探针（`:1779`）、`abandonError` 诊断串（`:1823-1832`，含 `rawEvents=` / `hostAfter=` / `sawNetworkRetry` 分支提示）、`finalizeOutcome`。它一直是对的，只是被无回声之外的场景蹭用了。
- **`'pending'`（有回声或有进度）**：新路径。**禁止四件事**：不 `unbindHost()`、不写 `lastError`、不构造 `abandonError`、不调 `restoreDraftIfComposerEmpty` / `setRetryable`。**做两件事**：`pendingReplyRef.current = { sessionId, committed, assistantCursor }`（组件内，承载「确定死亡后」的找回料）与 `armPendingReply({ sessionId, turnStartedAtMs })`（store，承载回合头）。

并入 B 的两条约束：

- **`'pending'` 分支不得调用 `getHostStatus()` 投票判死**【仲裁 §4.2】。现行 `:1779` 的探针**只保留在 `'rejected'` 分支**的 `abandonError` 诊断串里（那条路径本来就是真失败）；`'pending'` 分支**不调用它**——省掉一次 IPC 往返，也杜绝「`state !== ready` 就判死」的诱惑。
- **`finally` 需以标志区分**（`:1863-1870`）：仍清 ticker、local listener、`inFlightRef`、`sending`；`endTurnSend(sendOwner)` **仍照常调用**（见 §4.5 为什么 A 的方案不需要保留 sendStatus 快照）。

### 4.3 **P0** 施工细则：`RunEntryOutcome` 加 `'pending'` 的六条逐点裁定

> **A §4.3 的理由是错的，且是危险的错。** A 写「加成员是刻意的——TypeScript 会在 5 个消费点逐点报错，强制复审」。【实测】**零编译错误**：五个消费点没有一处是穷尽 `switch`，全是 `if (x === 'committed')` / `if (result === 'skipped' || result === 'rejected')` 形态：

```
queueRelease.ts:227    if (outcome === 'committed') return false;
                       return !(outcome === 'rejected' && origin === 'release');
queueRelease.ts:254    if (outcome === 'committed') return 'restore-draft';
queueRelease.ts:289    return outcome === 'rejected' && origin === 'release';
queueRelease.ts:353    return outcome === 'committed';
useQueueRelease.ts:84  if (result === 'skipped' || result === 'rejected') { …restoreHead… }
ChatComposer.tsx:564   if (outcome !== 'committed') return;    // maybeApplyFirstMessageTitle
```

加 `'pending'` 后的**静默默认值**：

| 消费点 | 静默默认 | 对否 | 后果 |
|---|---|---|---|
| `shouldArmRetryable('pending', *)` | `true` | 错 | **一键 Retry 装上 = 双发**（本仓 A1 轮次专门修掉的缺陷复活） |
| `decideFailureAffordance('pending', *)` | `'resend'` | 错 | **同上**，且与用户裁定直接冲突 |
| `shouldPauseQueueOnRejection('pending', *)` | `false` | 对 | 队列条目已花掉，无重放环 |
| `shouldClearRetryableOnOutcome('pending')` | `false` | 对 | `'pending'` 不证明任何事 |
| `useQueueRelease` 回填 | 不回填 | 对 | 结构性不会被回填重发 |
| `maybeApplyFirstMessageTitle` | 不改标题 | **需订正** | 首条消息超时也已进 CLI transcript，标题应照常生成 |

**裁定：六条逐点裁定全部采纳并升格为强制项**——不是「TS 会提醒我们」，是「**不写就是 P0 双发**」：

| # | 消费点 | 对 `'pending'` 的**必须显式写出**的裁定 | 理由 |
|---|---|---|---|
| 1 | `shouldArmRetryable`（`:226-229`） | `false` | 已受理，一键重发即双发 |
| 2 | `decideFailureAffordance`（`:250-256`） | **`'none'`（本批承重断言）** | 猜测性超时不得回显输入。这一条就是用户裁定的可执行形式 |
| 3 | `shouldPauseQueueOnRejection`（`:285-290`） | `false`（**显式写，不靠默认**） | 队列条目已花掉，无重放环可防 |
| 4 | `shouldClearRetryableOnOutcome`（`:352-354`） | `false`（**显式写**） | `'pending'` 不证明任何事；`runSend` 入口 `:988` 已清过 |
| 5 | `useQueueRelease.ts:84` | 改写为 `if (!isAdmittedOutcome(result)) restoreHead(entry);` | 今日行为等价，但 `'pending'` 从此**结构性**不会被回填重发 |
| 6 | `maybeApplyFirstMessageTitle`（`ChatComposer.tsx:564`） | 改用 `isAdmittedOutcome(outcome)` | 首条消息超时也已进 CLI transcript |

```ts
/** F2: the Host took this turn — 'committed' (finished) or 'pending' (still
 *  running, the renderer merely stopped waiting). Anything else means the turn
 *  never started, so the queue entry / draft is still the caller's to replay. */
export function isAdmittedOutcome(outcome: RunEntryOutcome): boolean {
  return outcome === 'committed' || outcome === 'pending';
}
```

**变异 M6/M7 因此从「回归保护」升格为「P0 咬合」**（§13）。

### 4.4 裁定原文化：不新增第五道发送门，改立不变量断言

【仲裁 §4.5】B 要求 `canStartTurn` 增加 detached latch。**【实测】今天已经双保险堵住**：

- `decideQueueRelease`（`queueRelease.ts:120-133`）在 `input.status !== 'idle' && !== 'completed'` 时返回 `hold('not-idle')`；`'pending'` 期间 Host 未发终态，status 恒为 `'running'` → **队列不放行**。
- `canStartTurn` 的 `busy = isStoppable(activeSession?.status)`（`ChatComposer.tsx:439`，`isStoppable` 定义在 `:141-143`，委托 `queueRelease.ts:405-409` 的 `isRunningStatus`）在 `'running'` 下为真 → 手动 Send 走 `'enqueue'` 而非新回合，且圆按钮此时呈现的是 Stop。

方向性也是安全的：这条依赖若失效，失效方向是「队列 hold 太久」（Host 崩溃场景 → 由 S5 补齐），**永远不会是「放行太早」**。

**裁定：不新增 latch**（避免在最敏感的发送门上加第五个条件），改把 B 的契约立成**测试级不变量** `[Q-1]`（§12.1）。

### 4.5 施工细则：回合头保活（`pendingReply` 第二槽）

【仲裁 §4.4】**取 A 的 store 第二槽，驳回 B 的 `finally` 不 `endTurnSend` 方案。**

B 的方案有一个 B 没看到的缺陷【实测 E14】：驱动 `sendStatus.elapsedSeconds` 的是 `runSend` 里的 `ticker`，而 `finally` 的**第一行**就是 `window.clearInterval(ticker)`（`ChatComposer.tsx:1864`），`endTurnSend` 在 `:1865`。不 `endTurnSend` 只会得到一个**冻结在 300s 的秒表**，除非再造一个 ticker 所有者——那正是 B 的 detached tracker 要新增的机器。

**A 的方案不需要新 ticker**：`MessageTimeline` 自己有 `useSecondsTick`（定义 `:128-136`，调用 `:287`）与 `nowMs`，从 `turnStartedAtMs` 现算即可。

**B 对 A 的「元数据丢失」反驳经核对不成立**【实测】：`sendStatus` 被清后丢的是 `phase` / `budgetMs` / `attachmentCount` / `attachmentBytes`，而到期后走的 `slow` 分支（`attachments.ts:351-353`）**这四项一个都不读**；最有价值的 `retry` 后缀走的是**另一条独立通道**（`MessageTimeline.tsx:1010` 从红线 store 读 `retry`，不经 `sendStatus`），**不受影响**。

**改动（行号按 `d9281d0` 重取）**：

```ts
// MessageTimeline.tsx —— 承重行是 :957
const pendingReply = useTurnSendStatusStore((s) =>
  s.pendingReply && s.pendingReply.sessionId === sessionId ? s.pendingReply : null);   // 新增，紧邻 :225 的 sendStatus selector
const pendingActive = isLastTurn && pendingReply != null;                              // 新增，:952 之后
const turnActive = inFlight || streamStartedAt != null || pendingActive;               // :957 加第三项
const elapsedSeconds =                                                                 // :958-963 加第三分支
  inFlight && sendStatus ? sendStatus.elapsedSeconds
  : streamStartedAt != null ? Math.max(0, Math.floor((nowMs - streamStartedAt) / 1000))
  : pendingActive ? Math.max(0, Math.floor((nowMs - pendingReply.turnStartedAtMs) / 1000))
  : 0;
// :287 tick enable 加项
const nowMs = useSecondsTick(inFlightSession || sendStatus != null || pendingReply != null);
```

**三处配套【实测】全部成立**：

1. **秒表继续走**：`useSecondsTick(inFlightSession || sendStatus != null)`（`:287`）中 `inFlightSession = isTurnInFlight(status)`（`:272`），到期时会话状态仍是 `'running'`，秒表继续走。**仍按 A 建议把 `pendingReply != null` or 进 enable 条件**，防状态先落地。
2. **Stop 入口已存在，无需新按钮**：`deriveActionButtons`（`queueRelease.ts:430-431`）在 `isRunningStatus(input.status) || input.sending` 时给 Stop，`'running'` 在集合内（`:405-409`）——**这是保留 `'pending'` 态而不解绑 Host 的额外红利**：绑定健康，Stop 真能到达（§8.3 的死文案审读依赖这一条）。
3. **`budgetMs` 换源**：`DEFAULT_REPLY_BUDGET_MS`（`:1236`）改为 `SEND_SILENCE_CEILING_MS`；`slow` 分支不打印 `(up to Ns)`，无矛盾。

**store 落点**：`turnSendStatus.ts` 加**第二槽**（`baseline` 槽已有「刻意比 `status` 活得久」的先例，头注在 `:88-109`）。**驳回 B 的独立 `detachedTurn.ts` store**——多一个 store 就多一处 `MessageTimeline` selector 与 session 切换的竞态面，而 A 的方案复用已有的 owner/session 作用域纪律。

```ts
/** F2: a turn the Host admitted and is still running, which THIS renderer has
 *  stopped waiting on. Display-only: it keeps the turn head (and its Stop)
 *  alive. Deliberately carries NO payload — see pendingReplyRef in ChatComposer. */
export interface PendingReplyWatch { sessionId: string; turnStartedAtMs: number; }
// TurnSendStatusStore 加: pendingReply: PendingReplyWatch | null
//                        armPendingReply(watch): void
//                        clearPendingReply(sessionId): void   // 按 sessionId 幂等清除
```

**只放展示事实，不放 payload**：`committed`（含 base64 附件）留在组件 `pendingReplyRef`，避免把用户数据搬进一个会被 devtools 序列化的 store，也让 store 保持可断言的小面。

> **F456 边界（§11.4）**：本槽是**在 `TurnSendStatusStore`（`:116-135`）与 store 对象（`:143-165`）上**加字段与两个 action；F456 ④ 片的 `promptChars` 是**在 `TurnSendStatus`（`:41-52`）接口上**加字段。**两处不重叠**，写成互不冲突的两次加法。

---

## §5 题五：restore-draft 收窄、provenance marker、迟到清理链

### 5.1 裁定原文化：affordance 不是超时的函数，是**死亡证据**的函数

【仲裁 §5.2 升格为本题判据】用户裁定原文（「只有明确确定回合死亡才允许回显输入 + 红色报错」）**本身就规定了架构**。由此：

- **「Recover text」按钮不做**（两轨一致）。加按钮等于承认超时时刻需要一个动作，那还是把猜测搬到了 UI 上。
- **文本没有丢**：回合已受理 ⇒ 用户消息**已在时间线里**（`beginTurn` 的回声写成 user 气泡；`MessageTimeline.tsx:816` 的 `select-text whitespace-pre-wrap` 可选中可复制）。这不是「用户无路可走」的处境。
- `pendingReplyRef.current.committed` 一直在内存里等着；一旦**确定死亡**到达，用**同一个** `restoreDraftIfComposerEmpty`（`ChatComposer.tsx:1049-1058`，含「composer 非空就不覆盖」的 F4 防覆写：读 `valueRef.current` 与 `attachments.getLiveDraftCount()` 两个 FRESH 镜像而非闭包快照）把料放回去。用户看到的是：等了很久 → Host 说失败了 → 红卡 + 输入框里回来了。**因果顺序正确。**
- 若来的是 `session.completed` / `stopped` / 迟到回复，ref 静默丢弃，输入框全程没被动过——**分诊缺陷 3 的主半边从源头消失**。

### 5.2 施工细则：收窄后的完整 affordance 矩阵【拍板 D1：自动放回】

| 出路 | origin | affordance | 何时发生 |
|---|---|---|---|
| `'skipped'` | 任意 | `'resend'` | 提交前守卫失败，什么都没发出去 |
| `'rejected'` | `direct` / `retry` | `'resend'` | Host 从未受理（无回声），重发不会重复 |
| `'rejected'` | `release` | `'none'` | 队列自己回填（`shouldPauseQueueOnRejection`） |
| `'committed'` | 任意 | `'restore-draft'` | **真失败**：`session.failed` / 握手致命错 / `ensureHost` 抛错，且已有回声。**【拍板 D1】保持** |
| **`'pending'`** | 任意 | **`'none'`** | **本批新增：猜测性超时。既不报错也不回显** |

`'pending' → 'none'` 是**双轨同判 + 本批承重条**，且 §4.3 已证明它必须**显式写出来**（否则静默默认是 `'resend'`）。双层保险：纯函数层 `[P-2]` + 源文层 `[S-3]`。

**D1 取 A 的理由留档**（供后来者复查）：`session.failed` 之后同一回合不可能再有迟到回复，所以双发风险是「用户主动决定重发」而非「误发」；且 B 的矩阵会顺带砍掉今天唯一合理的回显场景（握手致命错 / `ensureHost` 抛错但已有回声）。

### 5.3 施工细则：`RestoredDraftMarker` provenance【拍板 D1 连带，必做】

B 指出的洞【实测】真实存在：`restoreDraftIfComposerEmpty`（`:1049-1058`）**只比较 composer 是否为空，没有 provenance**；而 `clearAbandonMarkerIfMatch`（`:1938-1955`）只清 `lastError`（对象值相等）与 `retryable`（`:1952` 的对象同一性 `current === marker.committed`），**从不撤销已回显的文本/附件**——这正是分诊缺陷 3 的字面根因。

A 认为该状态在新形态下不可达——**仅对超时路径成立**。D1 取 A 后，`committed + 确定死亡 → 回显` 这条路径仍会写入一份用户没打的草稿；而 Host 退出广播（§6.2）合成的 `session.failed` 与真实回合终结之间**存在时间窗**。**所以残留半边仍需要 provenance，D1 已拍板必做。**

```ts
/** F2 (D1): "this draft is OURS, not the user's." Written by every automatic
 *  restore; the ONLY thing a late event is ever allowed to remove. */
export interface RestoredDraftMarker {
  sessionId: string;
  requestId: string | null;
  text: string;
  draftIds: readonly string[];
  /** Composer revisions AT the moment of restore — any change invalidates the marker. */
  valueRevision: number;
  attachmentRevision: number;
}
```

**两条纪律（B 原文，采纳）**：

1. 迟到事件**只在 `text/draft revision 均未变`** 时才撤销自动回显；
2. **用户一旦编辑，marker 失效但内容保留**——**禁止按值相等删除用户的新输入**（即使新输入恰好与我们塞进去的那份逐字相同）。

落点复用既有的**对象同一性**写法先例（`:1944-1952`）。两个 revision 从既有的 `valueRef` 同步点与 attachments hook 取（施工时若无现成 revision 计数，就在这两处各加一个单调 `number`，**不引入新 store**）。

### 5.4 施工细则：迟到清理链（A 的资产 + B 的顺序）

【仲裁 §5.5 合取】A 要求既有两个 effect 与纯函数**逐字保留**【实测】：

- 进度 effect `ChatComposer.tsx:1957-1973`（读 `abandonMarkerRef` → `resolveAbandonProgress` → `clearAbandonMarkerIfMatch`）
- `session.completed` 订阅 `:1984-1991`
- 纯函数 `resolveAbandonProgress`（`assistantProgress.ts:266-276`（声明在 `:266`），**含向下重基线那条 B2 修复**）

这条正确：那是专治「回放历史误清」的资产，B 的八步链没有覆盖 `resolveAbandonProgress` 解决的**重基线**问题（B 只写了「cursor 防 history replay」的引用）。

B 的有序化补的是 A 缺的一半：**清理必须先于 reducer 应用新事实**，否则清理后的旧状态覆盖新事实；以及 sessionId（协议带 requestId 时并验 requestId）的作用域前置。

**合取后的八步链（施工按此顺序，顺序本身立成断言）**：

1. 验 `sessionId`（协议带 `requestId` 时并验）——**禁止跨回合清理**；
2. 读取并**冻结**当前 `pendingReplyRef` / `RestoredDraftMarker`；
3. 走 `resolveAbandonProgress` 判 landed（**保留向下重基线**）；
4. 清 `pendingReply`（store `clearPendingReply(sessionId)` + ref），回合头交回 streaming/terminal；
5. 仅在 `lastError === marker.error` 时清旧错误（**既有写法保留**）；
6. 仅在 `retryable === marker.committed` 时清旧 retryable（**对象同一性，既有写法保留**）；
7. 仅在 restored marker 仍有效**且两个 revision 均未变**时撤销自动回显（§5.3）；
8. marker 置空；**最后**让 reducer 应用新事实。

> 用户已编辑时只执行 1~6 与 8，**跳过第 7 步**。

**新增不变量断言（A `[D-4]` 的升级版）**：`'pending'` 分支执行后，`valueRef.current` 与 `attachments.getLiveDraftCount()` 与分支执行前**逐字节相同**——把「不许回显」钉成可测事实，而不是靠人读代码确认少了一行。

**命名迁移**：`abandonMarkerRef` → `pendingReplyRef`；`clearAbandonMarkerIfMatch` 保留名字与两条既有清除（`:1941-1952`）不变，只在其后追加第 7 步。**`abandonError` 变量名保留**（它现在只服务 `'rejected'` 分支，名副其实）。

---

## §6 题六：确定死亡判据清单与 Host 退出广播

### 6.1 裁定原文化：`session.failed` 是**唯一**红卡入口

| 判据 | 事件/来源【实测】 | 红卡 | 回显 | 说明 |
|---|---|---|---|---|
| `session.failed` | `isSessionFailedForSend`（`assistantProgress.ts:155`） | 是 | 按 §5.2 矩阵 | **唯一**同时触发红卡与回显的判据 |
| `session.stopped` | `isSessionStoppedForSend`（`:188`） | 否 | 否 | 用户自己按的 Stop；既有 Stop 出路（`ChatComposer.tsx:1704-1731`）已是干净结束，**逐字保留** |
| `session.completed` | `isSessionCompletedForSend`（`:172`） | 否 | 否 | Host 说回合正常结束；**零助手块也是 clean completion**，不伪装成失败 |
| `finishTurn` 合成终态 | `claudeRuntime.ts:1005` 之后 | 由其产出的 `failed`/`idle` 决定 | 同左 | 流无 `result` 就结束时补终态，已有 |
| 握手致命错 / `ensureHost` 抛错 | `fatalHostError` 通道 | 是 | 按 `sawUserEcho` | 既有，不改 |
| Codex `error{willRetry !== true}` | `codexNormalizer.ts:644-687` | 是 | 同上 | 立即 `session.failed`；随后重复 `turn/completed` 只关闭回合，不双报 |
| Codex app-server 退出且有 open turn | `codexRuntime.ts:2304` `finishTurn(state,'failed',error)` | 是 | 同上 | 既有 |
| **Agent Host 子进程 `error` / unexpected `exit`** | **今天无人广播（E8）** | — | — | **§6.2 的洞** |

**对分诊方向 C 的同向纠偏**（两轨同判）：分诊写「红横幅只在确定死亡（`failed` / `stopped` / `completed` 无产出）时出现」——**`stopped` 是用户意图、`completed` 是正常终态，都不出红卡**。给它们红卡等于把「猜测性失败」换个触发器复活。

**负控清单（B 独有，采纳）——以下一条都不是确定死亡**：纯时间（32s / 195s / 300s / 30min 任一数字本身）、普通 stderr、单次 `api_retry`、长时间不变的 `session.status(running)`、`getHostStatus()` 单次失败、渲染端背景节流（`ChatComposer.tsx:1693-1700` 已记录 store flush 可因背景窗口延迟）、「没有新 assistant block」。

### 6.2 施工细则：Host 退出广播（S5）【拍板 D2：全量】

**这是本批的红线前置。** 【实测 E8】`AgentHostManager` 的进程 `exit`（`:472-496`）/ `error`（`:462-470`）处理只写 `this.state` 与日志，**不向渲染端广播任何 RuntimeEvent**；渲染端唯一的 Host 存活通道 `chat.getHostStatus()` 只在旧 abandon 分支被一次性调用（`ChatComposer.tsx:1779`）。

后果：Host 崩溃时所有活跃会话**永久停在 `'running'`**——Stop 在、点了没用、没有终态、`'pending'` watch 一直转秒，且 §4.4 的队列门会**永久 hold**。**不补它，新形态在崩溃场景下比旧形态更糟**（旧形态至少 45s 后报个错）。

**裁定形态（A 的事件复用 + B 的去重与作用域）**：

```
AgentHostProcess 'exit' / 'error'
  → 非清洁退出（排除 code === 0 || signal === 'SIGTERM'，即我方 shutdown()；
     复用 AgentHostManager.ts:483 已有的 `clean` 判定）
  → 对「本进程生命周期内仍开着的会话」逐个广播：
       session.status { status: 'disconnected' }                              // 已有成员（runtimeEvents.ts:55），零协议新增
       session.failed { error: 'Agent Host exited (code=… signal=…)' }
  → 去重：'error' 后紧跟 'exit' 只广播一次；'error' 后无 'exit' 也必须广播
  → 只对 OPEN session 广播；idle / 已关闭 / intentional shutdown 一条都不发
```

- `'disconnected'` 已是 `SessionRuntimeStatus` 合法成员并已被两轴 `close()` 使用（`claudeRuntime.ts:1342`），**零协议新增**。
- `session.failed` 让渲染端既有的 `isSessionFailedForSend` 通道直接接住 → 红卡 + 回显（§5.1 的正确因果）。
- 广播口复用 `src/main/ipc/chat.ts:174-183` 的 `broadcastRuntimeEvent`（自带 `isDestroyed()` 守卫）。

**open-session 台账来源（两轨都没解，仲裁给出推荐解，本规格采纳为施工形态）**：`AgentHostManager` **已经**是每一条 RuntimeEvent 的转发点，可以在转发的同时维护一份 sessionId 台账，**零新增管道**：

| 动作 | 触发事件 |
|---|---|
| 入账 | `session.created` / `session.resumed` |
| 出账 | `session.status(idle \| failed \| completed \| disconnected)`、会话显式关闭 |

它跟的是**会话**而不是**回合**，而广播的粒度本来就是会话级——比 B 的 OQ5 两个候选（跟 `message.started(role:user)` 或跟 command lifecycle）都窄且不漏。**收口条件**：crash-mid-turn fixture 证明「不漏、不误报 idle session」（B 的要求，采纳）。

**降级方案（保留为最低可接受形态，仅在 S5 遇到不可预见阻塞时启用，且必须回本规格记 as-built）**：只广播一条 `host.error { code: 'host_exited', fatal: true }`（无 sessionId），渲染端 `runSend` 的 host.error 通道能接住「正在飞的那一条」；代价是后台会话仍停在 `'running'`。**D2 已拍板全量，降级不是默认路径。**

---

## §7 题七：Codex 轴看门狗与 30 分钟 ack

### 7.1 裁定原文化：补同款双狗（分诊 H 二选一，两轨同选）

【仲裁 §7.1】不能选「明确接受渲染端权威」的理由是**结构性**的【实测】：`runSend` 全程**不知道自己在跟哪个 agent 说话**（`turnAgent` 只在 `ChatComposer.tsx:927-959` 用于选 model / effort / permission）。若 Codex 轴保留渲染端权威，就要么在**最敏感的发送路径**写一个 agent 分支，要么让 Codex 轴继续被沉默天花板误判——两者都不可接受。

现状风险【实测 E18】：`codexRuntime.ts` 全文无 stall / TTFT 计时器，只有 `CODEX_TURN_START_TIMEOUT_MS = 30 * 60_000`（`:381`）的 `turn/start` ack 兜底，且其头注自认 ack 时机 `[未测]`。**一个 wedged 的 Codex 回合今天最长 30 分钟无裁决。**

### 7.2 施工细则：常量与 env（TTFT 取 32s）

【仲裁 §7.3】A 取 45s 的理由「`turn/start` ack 时机 [未测]，给余量」**不成立**【实测】：Codex 的首个 productive 帧是 `turn/started` **通知**（`codexNormalizer.ts:67` `turnStarted: 'turn/started'`），与 `turn/start` **请求的 ack** 是两条独立通道；watchdog 键在通知上，ack 时机的不确定性与 TTFT 无关。且两轨已同判「TTFT 裸到期本身不构成 abort」，所以 32 与 45 的差别只是**第一帧诊断何时发出**。

```
CODEX_STALL_TIMEOUT_MS = 195_000   env AICLIENT_CODEX_STALL_TIMEOUT_MS，<=0 禁用（= 今日行为）
CODEX_TTFT_TIMEOUT_MS  =  32_000   env AICLIENT_CODEX_TTFT_TIMEOUT_MS，<=0 禁用（= 今日行为）
```

与 Claude 同值 = 一个常量族，分诊「40 倍哲学错配」在两端都收敛。**env `0` 的语义必须精确等于今日行为**（§9.2）。

### 7.3 施工细则：Codex 三层词表（承 §2.3）

**两条互补判据合取，各自否掉对方的一半盲区：**

- **A 的正向判据（B 缺）**：`CODEX_IGNORED_NOTIFICATIONS` 是**渲染决策表，不是活性表**【实测 E19】。其中三条**确属模型产出**，只是我们选择不渲染——`turn/plan/updated`、`item/plan/delta`（注释原文 `plan items are not rendered this round`）、`turn/diff/updated`（注释原文 `cumulative turn diff; the per-item fileChange rows already carry every patch`）。**把这张表当活性表用，会让一个正在写 plan 的回合被判死。必须算 productive。**
- **B 的负向判据（A 缺）**：**不能直接拿 connection 级 `lastActivityAt` 当活性**【实测】——该 hook 统计**双向**所有 frame（`codexRuntime.ts:1387-1400` 的 `touchActivity`（声明在 `:1397`），头注明文说「it cannot be…」，`:1636` 挂在 `onActivity` 上），Host 自己发出的 request/response 或 rate-limit chatter 就能永久保活。watchdog adapter 必须在 connection-level activity 与 turn-level 活性之间**分层**。

| 层 | Codex 信号 |
|---|---|
| `productive` | `turn/started`、`item/started`、`item/completed`、`item/agentMessage/delta`、reasoning 三条 delta（`summaryPartAdded` / `summaryTextDelta` / `textDelta`）、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`、`item/mcpToolCall/progress`、`thread/tokenUsage/updated`、`turn/completed`，**以及被刻意忽略但确属产出的 `turn/plan/updated` / `item/plan/delta` / `turn/diff/updated`** |
| `interactive` | pending server-request（question / approval）非空、`thread/status/changed` 的 waitingOnUserInput / waitingOnApproval、有未 settle 的 `item/started`（命令执行中）→ **暂停强杀**，发诊断帧 `reason:'awaiting_user'` / `'tool_running'` |
| `transport` | `account/rateLimits/updated`（**Codex 轴的 `api_retry` 类比物，恰恰不能算活**）、`thread/status/changed` 的 running、`serverRequest/resolved`、`thread/settings/updated`、`thread/started`、任意 JSON-RPC response、connection 级 `lastActivityAt` |

**单一真源**：productive 方法集由 `codexNormalizer.ts` **导出**（供 watchdog 与测试共用），不在 `codexRuntime.ts` 里手抄第二份。`[X-3]` 断言该集合与 `CODEX_NORMALIZER_METHODS ∪ CODEX_IGNORED_NOTIFICATIONS` 的差集为空——**防上游新增通知被静默漏判**。

### 7.4 施工细则：abort 动作按阶段分叉【拍板 D4：接受残留】

【实测 E17】`buildTurnInterruptParams`（`codexRuntime.ts:364-369`）与其头注（`:358-363`，标注 `[实测 codex-turn-schema.json: TurnInterruptParams]`）确认：**两个 id 都必填**，单 id interrupt 是 schema 错误——「一个从不中断的中断，而我们的日志声称发过」。

| 阶段 | turnId | 动作 |
|---|---|---|
| stall（回合已启动） | 已知 | `turn/interrupt` + `finishTurn(state, 'failed', msg)` |
| TTFT（`turn/start` 尚未应答） | **未知** | **不得伪造 interrupt**。改为 `finishTurn(state, 'failed', msg)` + 退休本回合；此后迟到的 `turn/start` 响应由既有守卫 `if (state.turn !== turn)`（`:2939` / `:2949`）**静默吞掉** |

**【拍板 D4】接受残留**：codex 侧可能仍在跑那个回合。另一条路是重置整条连接，代价是打断同一 app-server 上的其他会话，明显更差。**登记为已知限制**（§14.1），不由施工方自行吞掉。

### 7.5 裁定原文化：30 分钟 ack —— 保留不动，**不得缩短**

【双轨同判】分工：

- **watchdog** 管回合生命周期与活性；
- **30min timer** 管一个 outstanding JSON-RPC promise 的资源释放。

任一方先到，另一方的清理路径都已存在（connection teardown reject pending / send catch 的 `finishTurn(state, 'failed', …)`，`codexRuntime.ts:2961`（`finishTurn(state, 'failed', \`session.send: ${message}\`)`））。

**不得改成 195s**：注释明确 ack 何时返回仍 `[未测]`（`:374-379`），可能合法地在 turn end 才回，缩短会把健康长回合误判失败。**B 的双向竞态用例要求采纳**（`[X-6]`，§12.1）。

---

## §8 题八：`SLOW_WAIT_HINT_SECONDS` 死路径的处置边界

### 8.1 事实纠错：slow 分支**不是**全局死代码（B 正确）

【实测 E15】`composerSendingLine`（`attachments.ts:351-353`）与 `deriveTurnStatus`（`turnStatus.ts:118`）都在 `elapsed >= SLOW_WAIT_HINT_SECONDS`（=45）切换，而**附件路径的预算是 75/105/180s**（`sendTimeoutMs`），因此 `45s → 预算终点` 这段窗口**今天就在渲染 slow 文案**，且被逐字钉住两处：

```
attachments.test.ts:357  'Still waiting · 62s — gateway latency varies. Stop to abort.'
attachments.test.ts:436  'Still waiting · 62s · Retry 7/10 — gateway latency varies. Stop to abort.'
```

A 说的「巧合造成的遮蔽」**只对文本无附件路径成立**（`SEND_BASE_TIMEOUT_MS` 与 `SLOW_WAIT_HINT_SECONDS` 都是 45，到期与文案切换同一秒发生，且到期立刻 `endTurnSend` 清表 → 失表）。

**这条订正必须在正文写死**，否则会有人把 `attachments.test.ts` 的两条逐字断言当作陈旧钉住退役掉——**它们是 slow 分支唯一的正控**（`attachments.test.ts` 本批**零改动**）。

### 8.2 裁定原文化：阈值**保持 45，不上调**

分诊 A 把 `SLOW_WAIT_HINT_SECONDS` 列进「联动上调」清单，**两轨都不上调**。采纳 A 的裁定与核心论证：把预算抬到 300s 而阈值留在 45s，恰好让 `45s → 300s` 这段窗口成为「仍在等待」的**可见态**——正是 §4.5 需要的那个态。**上调阈值反而会把这段窗口重新变成沉默。**

理由中「文案从未被看见过」一句按 §8.1 订正为：「**文本无附件路径**从未被看见过；**附件路径**一直可见且已被钉住」。

### 8.3 裁定原文化：45s~上限窗口复用既有 slow 分支（驳回 B 的「文本路径不激活」）

B 主张文本路径始终走普通 awaiting/streaming 时钟，理由是「F2 不应顺手改变已可达 UI」。**驳回，三条理由**：

1. **反了**：B 的方案才是改变——它要给 `deriveTurnStatus` 的 slow 判定加一个「是否有附件」的新条件，而 `turnStatus.ts:115-117` 的注释**明文写着**：「The threshold is imported, never re-declared: `composerSendingLine` keys its own wording switch off the same constant, so `kind` and copy can only ever flip together.」加附件条件会让 kind 与 copy 的同源关系断裂——**正是 B 自己在 §8.2 要求避免的 kind/copy 分裂**。
2. 若文本路径不激活 slow，200s 时用户看到的是 `Waiting for Agent Host reply · 200s (up to 300s)`——一个**预测终点**的句子，而这个终点到了什么也不会发生（§4 的 `'pending'` 不是终点）。**这比复活 slow 更不诚实。**
3. A 的死文案审读【实测】逐项成立（见 §8.4）。

**并入 B 的一条要求**：`kind` 与 copy 必须继续同源（今天已是，两者都键在 `SLOW_WAIT_HINT_SECONDS` 上）——立成回归断言 `[TS-1]`，防本批或 F456 顺手拆开。**`[TS-1]` 的写法见 §0.5 新发现⑥-b（必须锚在 `[45,180)` 内的具体秒数，取 62s）。**

### 8.4 死文案审读（用户要求的「首次可见前审读」，逐项核完保留）

```
Still waiting · 62s — gateway latency varies. Stop to abort.
Still waiting · 62s · Retry 7/10 — gateway latency varies. Stop to abort.
```

| 项 | 判定【实测】 |
|---|---|
| 「Still waiting」 | 成立。此分支要求 `hasBlocks === false`（`turnStatus.ts:102` 的 streaming 分支优先级更高），确实**一个 token 都没到** |
| 「gateway latency varies」 | 有实测支撑（`attachmentLimits.ts:168-172` 记录同一负载跨日 ~8x 波动） |
| 「Stop to abort.」 | **可执行**。§4.5 已核：Stop 在 `'running'` 下确实呈现（`queueRelease.ts:430-431`），且 `'pending'` 态**不解绑 Host**，Stop 真能到达 |
| Retry 计数后缀 | 与 `session.status.payload.retry` 同源，**非嗅探**（`attachments.ts:348-350` 的 `retrySuffix`） |
| 语气 | 中性，不指认失败 |

**结论：文案逐字保留，本批不改。** 本批对 `attachments.ts:295-360` 的改动为**零**，只由调用方把 `budgetMs` 换源（§1.3），属**纯参数变化**。

### 8.5 移交 F456（本批不动，仅登记）

| 项 | 现状锚点【实测】 | 移交理由 |
|---|---|---|
| `slow` 的 `text-warning` 色阶 | `MessageTimeline.tsx:1389`（`turnStatusToneClass` 在 `:1387-1392`） | 新形态下 `slow` 会成为「首 token 慢于 45s」的常态，持续数分钟的警告色属告警疲劳。**建议形态**：`slow` 保持 muted，另设第二档阈值（180s）才转 warning——**F456 rev.1 `[F4-6]` 已按此设计（`'stalled'` kind）** |
| `(up to Ns)` 从句在新语义下的去留 | `attachments.ts:356` / `:358` | 属文案族 |
| 红卡中英混排 | `MessageTimeline.tsx:557`（中文）周边全英文 | 属文案族。**本批不得回滚 `a94b9a4` 的中性化快修** |

> **知会 F456**：其 rev.1 §9.2 把色阶锚点写作 `:1372-1377`（F10 前行号），实况 `:1387-1392` —— 见 §0.5 新发现⑥-a。

---

## §9 题九：flag 裁定与行为破坏范围

### 9.1 裁定原文化：渲染端半边**不加布尔 flag**【拍板 D5：接受偏离】

**两轨独立同判**：不为「撤销一个错误裁决」做布尔开关。A 的论证采纳为原文：

> 渲染端这半边**不是新能力，是撤销一个错误裁决**。为它做 flag 意味着在产品里保留一个「我们已经证明它会对活着的回合打红叉」的位置——**那不是安全网，是把缺陷做成配置项**。

B 的补充理由更强：只切一端会造成**跨进程语义错配**，灰度反而保证不了一致性。

**可回退性由三样东西提供（非 flag）**：

| 手段 | 具体 |
|---|---|
| (a) 常量即量级 | `SEND_SILENCE_CEILING_MS` / `SEND_WAIT_LOOP_BOUND_MS` 是常量，改数即回退量级 |
| (b) 分片提交 | S3 可单独 revert 而 S2 留存（§11.1 的文件互斥保证了这一点） |
| (c) **incident 回归用例** | 把本次现场样本 `[I-1]`（§0.4）立成 incident 档用例——**这是 D5 拍板时明确的回退性依据** |

**规范 #6 偏离已获用户认可【拍板 D5】**，记入台账（§14.3）。

### 9.2 施工细则：Host 半边的 env 位是**测试 seam 与运维旋钮，不是产品灰度**

A 的 `AICLIENT_CODEX_*_TIMEOUT_MS = 0` / `AICLIENT_HOST_LIVENESS_NOTE='0'` 与 B 的「测试/诊断 env 覆盖」是同一个东西。统一措辞：

> **env 阈值与静音位是测试 seam 与运维旋钮，不是产品灰度；`0` / `'0'` 的语义必须精确等于今日行为。**

| env | 默认 | `0`/`'0'` 的语义 |
|---|---|---|
| `AICLIENT_HOST_STALL_TIMEOUT_MS` | 195_000 | 禁用（既有，`claudeRuntime.ts:97-103`） |
| `AICLIENT_HOST_TTFT_TIMEOUT_MS` | 32_000 | 禁用（既有，`:117-123`） |
| `AICLIENT_CODEX_STALL_TIMEOUT_MS` | 195_000 | 禁用 = **今日行为**（S4 新增） |
| `AICLIENT_CODEX_TTFT_TIMEOUT_MS` | 32_000 | 禁用 = **今日行为**（S4 新增） |
| `AICLIENT_HOST_LIVENESS_NOTE` | on | QUIET 位：**停发该帧，不改判决逻辑**。形态逐字对齐 `resolveSubagentActivityEnabled`（`claudeRuntime.ts:150-154`）——off 位「停止为没人消费的流量付费」，而不是回退到旧判决 |

> 保留 liveness note 静音位的实际用途：一次性降级后该帧全回合最多两帧，静音位主要服务于 **wire 快照测试的确定性**。

**Host 退出广播（S5）无 flag**：它补的是「本来就该有的终态」，off 位是一个已知缺陷。

### 9.3 裁定原文化：行为破坏范围——**算，且是刻意的**，四条可观测变化

| # | 变化 | 方向 |
|---|---|---|
| ① | 一个已受理但沉默超上限的回合，**不再**出现红横幅 / **不再**回显草稿 / **不再**解绑 Host；改为回合头持续显示 `Still waiting · Ns` | 谎言 → 沉默 |
| ② | `session.failed` 到达时红卡与回显**照旧**，但时机**后移到证据到达时刻** | 谎言 → 延后的真话 |
| ③ | Host 端一次 `api_retry` 不再立即杀回合（需 `attempt >= maxRetries` 或等 195s stall） | 误杀 → 不杀 |
| ④ | **文本无附件路径在 45s 后开始显示 `Still waiting · Ns — gateway latency varies. Stop to abort.`**（此前该窗口不可达，该文案只在带附件的发送上出现过） | 沉默 → 可见 |

四条都是「把谎言换成沉默或换成延后的真话」，**方向单一**；不存在「原本成功现在失败」的方向。

**发布说明按 `fix:` 前缀写清 ① 与 ④**（两条改变用户已习惯的可见行为）。**知会已达**（仲裁 §15 末行）。

### 9.4 施工细则：变异与时间测试纪律（两轨并集）

- **变异**：每对指名一个**承重行**（不是注释行、不是 inert 分支）；flip 前**预检 old/new 串在文件内双唯一**；跑完**立即回滚**；**零跳过**；**禁止改字面使其通过**；**禁止拿被测生产函数当自己的 oracle**（`queueRelease.test.ts:718-722` 已记录 tautology 反例）。
- **时间测试**：一律 fake clock 或 20~100ms env override，**不等待真实 300s**；真实 timer 只保留一个最小 smoke。既有 TTFT 套件已用 message discriminator 避免墙钟竞态（`claudeRuntimeOptions.test.ts:595-601` / `:712-716`），沿用同一工法。

---

## §10 影响面全清单

### 10.1 新建（4 个）

| 文件 | 片 | 内容 |
|---|---|---|
| `src/renderer/components/chat/sendBudgets.ts` | S2 | 两个上限常量、两个 Host 镜像、`createSendWaitBudget`、**反转后的 INVARIANT 注记块** |
| `src/renderer/components/chat/__tests__/sendBudgets.test.ts` | S2 | 有序链 + 反转 T-06 + **源文镜像锁** + 预算纯函数四例 |
| `src/renderer/components/chat/__tests__/messageTimelinePendingStatic.test.ts` | S3 | `.tsx` 不可测事实的源文静态断言（`[TS-2]`） |
| `src/agent-host/__tests__/codexWatchdog.test.ts` | S4 | Codex 词表 / 守卫 / abort 分叉（纯函数，不起真连接） |

### 10.2 修改（生产代码 15 个）

| 文件 | 片 | 改动要点（行号 @ `d9281d0`） |
|---|---|---|
| `src/shared/types/runtimeEvents.ts` | **S0** | 新增 `SessionLivenessNote`（含「不得升格为新事件类型」的护栏注记）；`SessionStatusEvent.payload`（`:159`）加 `liveness?`；`AGENT_HOST_PROTOCOL_VERSION` **保持 `1`** 的静态断言复核 |
| `src/agent-host/ttftWatchdog.ts` | S1 | **新增 `markDegraded()`**（§3.2，纯加法）；头注 `:7` / `:11-14` 两处陈旧订正；既有方法**一个字不改** |
| `src/agent-host/claudeRuntime.ts` | S1 | `:108-109` / `:760` / `:762-763` 四处陈旧注释订正；`:731-780` `onTimeout` 三分改写（含二次窗口计数、`markDegraded()`、三分 `reason` 诊断帧）；`:755-766` R9 注记整段改写；`:794-800` `PRODUCTIVE_EVENT_TYPES` **提升到模块作用域并导出**；`:948-951` 改记 `attempt`/`maxRetries`（**读原始 SDK 事件，非归一化 payload**） |
| `src/agent-host/codexRuntime.ts` | S4 | 两个新常量 + resolver；send 路径装双狗；turn-activity 与 connection-activity 分层；abort 按 turnId 分叉；发诊断帧；**`CODEX_TURN_START_TIMEOUT_MS` 与 `buildTurnInterruptParams` 一个字不改** |
| `src/agent-host/codexNormalizer.ts` | S4 | **导出 productive 方法集**（单一真源，供 watchdog 与 `[X-1]`~`[X-3]` 共用）；`CODEX_NORMALIZER_METHODS` / `CODEX_IGNORED_NOTIFICATIONS` 本身**不改** |
| `src/main/services/agent-host/AgentHostManager.ts` | **S5** | open-session 台账（复用既有 RuntimeEvent 转发点入账/出账）；`:462-470` `error` 与 `:472-496` `exit` 补会话级终态广播；`error`/`exit` **去重**；复用 `:483` 的 `clean` 判定 |
| `src/main/ipc/chat.ts` | **S5** | 广播 Main 合成的会话级终态（复用 `:174-183` `broadcastRuntimeEvent`） |
| `src/renderer/components/chat/attachmentLimits.ts` | S2 | 删 `:165-210` 全部超时半边（迁入 `sendBudgets.ts`）；文件头 `:1-12` 存在理由改写；`:1-164` 附件限额半边**逐字保留** |
| `src/renderer/components/chat/assistantProgress.ts` | S2 | 新增 `classifyTurnLiveness` + `TurnLivenessSignal`；`classifyAssistantProgress`（`:278-310`）与 `resolveAbandonProgress`（`:266-276`）**一字不改** |
| `src/renderer/components/chat/middleColumnLayout.ts` | S2 | `:608` 散文样例 `"Waiting for Agent Host reply · 12s (up to 45s)"` 的 `45s` → `300s`（纯注释同步，无测试影响） |
| `src/renderer/components/chat/queueRelease.ts` | S3 | `RunEntryOutcome`（`:146`）加 `'pending'`；新增 `decideAdmittedTimeoutOutcome` / `isAdmittedOutcome`；**四个既有决策函数各补一条显式 `'pending'` 分支**（`:227` / `:254` / `:289` / `:353`）；`decideQueueRelease`（`:120-133`）与 `deriveActionButtons`（`:430-431`）**不改** |
| `src/renderer/components/chat/useQueueRelease.ts` | S3 | `:84` 回填判据改 `if (!isAdmittedOutcome(result))` |
| `src/renderer/stores/turnSendStatus.ts` | S3 | **在 `TurnSendStatusStore`（`:116-135`）与 store 对象（`:143-165`）上**加 `pendingReply` 槽 + `armPendingReply` / `clearPendingReply`；**`TurnSendStatus` 接口（`:41-52`）不碰**（F456 边界） |
| `src/renderer/components/chat/ChatComposer.tsx` | S2+S3 | S2：`waitUntil` 换签名（`:260-271` 定义 + `:1371` / `:1440` / `:1538` 三调用点）、`:1242` 旁接 `budget.markLiveness`、`:151-185` `formatRuntimeEvent` 打 liveness、删 `:965` `sendTimeoutMs`、**`:1122` `beginTurnSend` 的 `budgetMs` 换源**。S3：`:1757-1851` 到期分支一分为二（`'ceiling'` 判别联合 + `'pending'` 出路）、`abandonMarkerRef` → `pendingReplyRef`（`:348` / `:997` / `:1844` / `:1939-1940` / `:1958` / `:1986`）、`:564` 改 `isAdmittedOutcome`、`:1938-1955` 清理链追加第 7 步、新增 `session.failed` 订阅分支 |
| `src/renderer/components/chat/MessageTimeline.tsx` | S3 | `:225` 旁加 `pendingReply` selector；`:287` tick enable 加项；`:952` 后加 `pendingActive`；**`:957` `turnActive` 加第三项**；`:958-963` `elapsedSeconds` 加分支；`:1236` `DEFAULT_REPLY_BUDGET_MS` 换源 |

### 10.3 修改（测试代码）

见 §12.1 逐文件表。

### 10.4 明确不改（红线）

| 文件/对象 | 理由 |
|---|---|
| `src/renderer/stores/chatSessions.ts` | **红线文件，零改动**。两轨都主张零改动，仲裁维持。**若 S3 发现必须改，先停下来单独立项** |
| `src/renderer/components/chat/attachments.ts` | 文案唯一来源，本批零改动（§8.4） |
| `src/renderer/components/chat/turnStatus.ts` | 分支结构未变（§8.3）；`'stalled'` 分档属 F456 ④ 片 |
| `src/agent-host/__tests__/claudeRuntimePartialStall.test.ts` | 词表冻结守门人，**零改动、必须保持绿**（S1 收口条件） |
| `src/renderer/components/chat/__tests__/attachments.test.ts` | `:357` / `:436` 两条 62s 逐字断言是 slow 分支唯一正控，**零改动、必须保持绿** |
| `TtftWatchdog` 既有方法（`arm` / `markProductive` / `rearm` / `resetFired` / `dispose` / `hasFired`） | 只加 `markDegraded()`，既有一个字不改 |
| `codexRuntime.ts` 的 `CODEX_TURN_START_TIMEOUT_MS` / `buildTurnInterruptParams` | §7.4 / §7.5 |
| `MessageTimeline.tsx:550-558` 中性红卡文案 | `a94b9a4` 快修资产，**不得重复设计或回滚** |
| `src/agent-host/codexConnection.ts` | 只复用其既有 `onActivity` / `handleExit` / pending rejection，**不改协议与 transport 行为** |

### 10.5 本批明确不做（移交）

- 等待行文案改造（俏皮动词、↑↓ 计数、`(up to Ns)` 从句去留）、`slow` 色阶降级与第二档阈值 → **F456 ④ 片**（已在 F456 rev.1 落为 `[F4-3]` / `[F4-6]`）。
- 红卡中英混排订正 → F456 文案族。
- `formatRuntimeEvent` 之外的诊断面重构、`rawEvents` 环形缓冲策略。
- `historyReader` 分支盲（F8，另立票）。

---

## §11 切片与门禁

### 11.1 切片图（B 的 S0 seam + A 的依赖序 + 红线前置）

```
S0 (串行 seam，必须先合)
   └─> S1 ∥ S2 ∥ S5
              └─> S3 ∥ S4          ※ S5 必须先于 S3 合入（红线，见 11.3）
```

| 片 | 责任 | 独占文件 | 依赖 |
|---|---|---|---|
| **S0** | 协议加法：`SessionLivenessNote` + `SessionStatusEvent.payload.liveness?`；`AGENT_HOST_PROTOCOL_VERSION` 保持 `1` 的静态断言复核 | `src/shared/types/runtimeEvents.ts` + 其 wire 静态测试 | 无 |
| **S1** | Claude Host：`onTimeout` 三分改写 + 一次性降级（`markDegraded()`）+ `!sawAnySdkEvent` 二次窗口 + `attempt >= maxRetries` 证据 + 三分 `reason` 诊断帧 + `PRODUCTIVE_EVENT_TYPES` 提升并导出 + 冻结断言 + **六处陈旧注释订正** + R9 注记改写 | `src/agent-host/claudeRuntime.ts`、`src/agent-host/ttftWatchdog.ts` 及其三个测试 | S0 |
| **S2** | 渲染端读侧：新建 `sendBudgets.ts`（两个上限 + 两个 Host 镜像 + `createSendWaitBudget` + 反转 INVARIANT + **源文镜像锁**）；`classifyTurnLiveness`；`waitUntil` 换签名；`formatRuntimeEvent` 打 liveness；`attachmentLimits.ts` 退役超时半边；`middleColumnLayout.ts:608` 散文 `45s`→`300s` | `sendBudgets.ts`(新)、`attachmentLimits.ts`、`assistantProgress.ts`、`middleColumnLayout.ts` + `ChatComposer.tsx`(读侧) | S0 |
| **S3** | 渲染端写侧：`'ceiling'` 判别联合 + `'pending'` 出路 + `decideAdmittedTimeoutOutcome` / `isAdmittedOutcome` + **六个消费点逐点裁定** + `pendingReply` 槽 + 回合头失表修复 + marker 升格 + `RestoredDraftMarker` + 清理链八步有序化 | `queueRelease.ts`、`useQueueRelease.ts`、`turnSendStatus.ts`、`ChatComposer.tsx`(写侧)、`MessageTimeline.tsx` | S2 + **S5** |
| **S4** | Codex 轴双狗：三层词表（含三条 plan/diff productive）、connection-activity 与 turn-activity 分层、按 turnId 分叉 abort、诊断帧 | `codexRuntime.ts`、`codexNormalizer.ts`（导出 productive 集） | S0、S1 的类型 |
| **S5** | Main 侧 Host 退出广播：open-session 台账、非清洁退出判定、error/exit 去重、会话级 `disconnected` + `failed` 广播 | `AgentHostManager.ts`、`src/main/ipc/chat.ts` 及其测试 | 无 |

**零混面核对**：S1/S4 只碰 `src/agent-host`（文件不重叠）；S2/S3 **串行**同一批渲染端文件；S5 只碰 `src/main`；S0 只碰 `src/shared`。

### 11.2 每片收口条件（一致口径，缺一不算收口）

1. **四门全绿**：`pnpm typecheck` / `pnpm typecheck:agent-host` / `pnpm lint` / 该片相关 vitest 套件——**逐门串行跑，禁链式合跑**（本机曾 OOM exit 137）。
2. 该片**确定性断言点逐条实跑记录**（用例 id + 实际输出）。
3. 该片**变异对逐对实跑记红灯**，**零跳过**。
4. **影响面清单与实际 `git diff --stat` 逐文件核对**（多出或少掉任一文件都要解释）。

时间相关用例一律 fake clock 或 20~100ms env override，**不等待真实 300s**；真实 timer 只保留一个最小 smoke。

### 11.3 红线前置（本方案唯一的强序约束）【拍板 D2 连带】

> **S5 必须先于 S3 合入。**

依据：§6.2 的洞在 S3 落地后会让 Host 崩溃场景**比旧形态更糟**——旧形态 45s 后至少报个错，新形态会永远显示 `Still waiting · Ns` 且队列永久 hold。

**若 S5 因不可预见原因被推迟**，S3 **不得裸合**，必须带轮询兜底（进入 `'pending'` 后周期性 `chat.getHostStatus()`，`state !== 'running'` 视为确定死亡），并在本规格 §14.3 记 as-built 偏离。

### 11.4 与 F456 批的边界（本批显式声明）

F456 rev.2 将并行修订；其评审 B-3 已确认两处同区冲突，本规格再登记两处（§0.5 新发现⑥）。**统一处置：F2 S3 先落，F456 ④ 片 rebase。**

| # | 同区点 | F2 的动作 | F456 ④ 的动作 | 冲突消解 |
|---|---|---|---|---|
| 1 | `stores/turnSendStatus.ts` **双新增槽** | 在 `TurnSendStatusStore`（`:116-135`）与 store 对象（`:143-165`）加 `pendingReply` + 两个 action | 在 `TurnSendStatus` 接口（`:41-52`）加 `promptChars: number` | **两处不重叠**，写成互不冲突的两次加法。F2 **不碰** `TurnSendStatus`；F456 **不碰** store 根对象的 `pendingReply` 半边。rebase 时应为纯文本无冲突合并 |
| 2 | `deriveTurnStatus` **调用字面量**（`MessageTimeline.tsx:1003-1018`） | 改 `:1007` 的 `budgetMs` 换源（`DEFAULT_REPLY_BUDGET_MS` 定义在 `:1236`） | 加 `promptChars: sendStatus?.promptChars ?? 0` 一行 | 同一个对象字面量，**必然文本冲突**。F2 先落 → F456 ④ 在 rebase 时把新行插入 `:1007` 之后，**不得顺手改回 `sendTimeoutMs(0)`** |
| 2b | **`ChatComposer.tsx` `beginTurnSend` 实参表**（`:1118-1125`）【本稿新增】 | 改 `:1122` `budgetMs: timeoutMs` → `SEND_SILENCE_CEILING_MS` | F456 ④ 在同一实参表加 `promptChars`（其 rev.2 已自行登记该同区点，锚 `:1117-1126`） | 同一实参对象，**必然文本冲突**。F2 S2 先落 → F456 ④ rebase 时把 `promptChars` 插入，**不得顺手把 `budgetMs` 改回 `timeoutMs`**（那个变量届时已不存在，会是编译错） |
| 2c | **`MessageTimeline.tsx:1262-1271`（`PendingTurnHead` 的第二个 `deriveTurnStatus`）**【本稿新增】 | **零改动**（读 `sendStatus.budgetMs`，换源自动流过） | F456 ④ 必须**同样传 `promptChars`**（其 rev.2 的 M-7 已登记） | 无冲突。仅登记：F2 不碰这里，F456 独占 |
| 3 | **色阶锚点漂移**（新发现⑥-a） | 不动色阶（§8.5 移交） | F456 rev.1 §9.2 写 `MessageTimeline.tsx:1372-1377`，实况 `:1387-1392`（`text-warning` 在 `:1389`） | **F456 rev.2 的义务**：重取锚点。F2 只登记知会 |
| 4 | **slow 分档语义**（新发现⑥-b） | `[TS-1]` 钉「kind 与 copy 同源」，断言点锚在 62s（`[45,180)` 内） | `[F4-6]` 把 `>=180` 拆给 `'stalled'` | 两批**各钉各的区间**，无重叠、无假红。若 F2 的 `[TS-1]` 按仲裁 §12.1 的字面写成「`>=45` 恒 slow」，F456 ④ 一落地就会**按构造假红** |

**并发施工纪律**：两批若共享工作树，**S3 与 F456 ④ 不得同时在飞**。

---

## §12 测试合同变更

### 12.1 逐文件逐用例

**`src/shared/types/__tests__/agentWireStatic.test.ts`（S0）**
- 复核 `AGENT_HOST_PROTOCOL_VERSION === 1` 的既有断言**保持绿**（加法字段不动版本）。
- 新增 `[W-1]`：`SessionStatusEvent.payload` 的可选字段集恰为 `{retry, liveness}`——防后来者往同一个 payload 上继续堆。

**`src/agent-host/__tests__/ttftWatchdog.test.ts`（S1）**
- 保留 disabled / idempotent / markProductive / dispose / Stop-race 全部既有用例。
- **`rearm` 政策断言按一次性降级重写**（B 的方向）：把「`onTimeout` 内 rearm 后第二次 fire」的**政策**断言迁到 `claudeRuntimeOptions.test.ts`（政策属 runtime，不属 watchdog 类）；watchdog 侧只保留「`rearm()` 能再次调度」这条**机制**断言。
- **新增 `[TW-1]`（新发现④ 的咬合）**：`markDegraded()` 之后 —— ① `hasFired === false`；② 后续 `arm()` 与 `rearm()` 都是 no-op（注入 timer 计数为 0）；③ 注入 timer 的 clear 恰被调用一次。**这条是 M12 的必红用例之一。**

**`src/agent-host/__tests__/claudeRuntimeOptions.test.ts`（S1）**

| 用例 | 处置 |
|---|---|
| `:578-602` 零帧 50ms 直接 TTFT failed | **改**：改为**两个窗口后**才 failed（§3.3），**不是** B 主张的「永不 failed」 |
| `:604-643` 产出后不再 fire | **保留** |
| `:644-694` F1 健康慢首帧不失败 | **保留** |
| `:695-750` `F1: fires once sawApiRetry evidence lands` | **改**：改为 `attempt >= maxRetries` 才开火 |
| `:751-782` permission parked | **保留** |
| `:783-817` Stop 不被 relabel | **保留** |
| — | **新增 `[E-1]`**：单次 `api_retry`（`attempt=1, max_retries=10`）后静默 → TTFT **不**开火；短 stall env 下由 stall 兜底，消息含 `stall watchdog`。**含边界例**：`attempt=10, max_retries=10` 必须开火 |
| — | **新增 `[E-1b]`（新发现②的陷阱咬合）**：`api_retry` 帧**缺 `attempt` / `max_retries` 字段**时，证据门**不成立**（不得因归一化兜底 `0 >= 0` 而开火） |
| — | **新增 `[E-2]`**：停在权限上 → 发出 `session.status` 带 `liveness.reason === 'awaiting_user'` 且 `liveness.degraded === false`，TTFT 表**不降级**（后续窗口仍能再发） |
| — | **新增 `[E-3]`**：`AICLIENT_HOST_LIVENESS_NOTE='0'` 时一帧不发且**判决不变** |
| — | **新增 `[E-4]`（R9 回归）**：`system/init` → 永久静默 → TTFT **恰一帧**降级诊断（`reason:'insufficient_evidence'`, `degraded:true`）→ 短 stall env 下**必**以 `session.failed` 结束，**且错误文案是 stall 版本、不含 `no first response within`**（新发现④ 的端到端咬合） |
| — | **新增 `[E-5]`**：`PRODUCTIVE_EVENT_TYPES` 恰为五值的静态断言（`toEqual(new Set([...]))`） |

**`src/agent-host/__tests__/claudeRuntimePartialStall.test.ts`（S1）**：**零改动**，词表冻结守门人（S1 收口条件之一是它保持绿）。

**`src/renderer/components/chat/__tests__/attachmentLimits.test.ts`（S2）**

| 用例 | 处置 | 理由 |
|---|---|---|
| `[T-01]`~`[T-05]`（`:216-246`） | **整组退役** | 所钉公式作废（§1.3），**非重编号** |
| `[T-06]`（`:248-256`） | **反转重写** → 迁入 `sendBudgets.test.ts` `[C-02]` | 不变量方向翻转，**重编号会掩盖语义反转** |
| `[a4]`（`:258-261`） | **反转重写** → `[C-01]` 有序链 | 同上 |
| `[A-01]`~`[A-10]`、`MAX_ATTACHMENT_READ_BYTES mirror`、`planImageAttachment`、`largeAttachmentHint` | **原样保留** | 与超时无关 |

**`src/renderer/components/chat/__tests__/sendBudgets.test.ts`（S2，新）**
- `[C-01]` 有序链 `HOST_TTFT < HOST_STALL < SEND_SILENCE_CEILING <= SEND_WAIT_LOOP_BOUND`。
- `[C-02]` 反转后的 T-06：`HOST_STALL_TIMEOUT_MS < SEND_SILENCE_CEILING_MS`。
- `[C-03]` **源文镜像锁**（补 A 新发现③的洞）：读 `src/agent-host/claudeRuntime.ts` 源文，正则取 `DEFAULT_STALL_TIMEOUT_MS` / `DEFAULT_TTFT_TIMEOUT_MS` 的字面量，与两个渲染端镜像**逐一相等**。
- `[C-04]` `createSendWaitBudget` 四例：① 无活性帧恰在 silence 边界到期；② 活性帧复位后**重新计满**；③ 持续活性下**循环上界仍到期**；④ `markLiveness` 传入**过去时刻不倒退**。

**`src/renderer/components/chat/__tests__/assistantProgress.test.ts`（S2）**
- `[L-1]` **包含关系**：遍历全部 `RuntimeEventType` 字面量，凡 `classifyAssistantProgress === 'assistant'` 者 `classifyTurnLiveness` 必为 `'liveness'`。
- `[L-2]` **负向咬合**：`message.started{role:'user'}` → progress `'ignore'` **且** liveness `'liveness'`。
- `[L-3]` `session.status`（裸 / 带 `retry` / 带 `liveness`）、`session.stderr`、`usage.updated`、`subagent.activity` 四类均为 liveness。
- `[L-4]` 三终态（`completed`/`failed`/`stopped`）+ `host.error` 均**非** liveness。
- `[L-5]` 跨会话事件恒 `'ignore'`。
- 既有用户三连 ignore 断言（`:24-40`）与 out-of-order delta ignore **逐字保留**。

**`src/renderer/components/chat/__tests__/queueRelease.test.ts`（S3）**
- `[P-1]` `decideAdmittedTimeoutOutcome` 真值表（四组）。
- `[P-2]` **承重**：`decideFailureAffordance('pending', 三 origin)` 全 `'none'`。
- `[P-3]` `shouldArmRetryable('pending', 三 origin)` 全 `false`。
- `[P-4]` `shouldPauseQueueOnRejection('pending', 三 origin)` 全 `false`。
- `[P-5]` `isAdmittedOutcome` 四值全表。
- `[P-6]` 既有 `'committed'` / `'rejected'` / `'skipped'` 全表**逐字不变**（回归保护）。
- `[Q-1]`（§4.4 的不变量替代）：对 `pendingReply != null` 的会话，遍历九个 `SessionRuntimeStatus` —— `decideQueueRelease` 与 `canStartTurn` 必须**同时** hold/false；只有 `idle`/`completed` 会放行，而这两个 status 与 `pendingReply` 共存本身是矛盾态，用例断言该组合**不可构造**（或必须先清 `pendingReply`）。
- **纪律**：全部**硬编码矩阵**，禁止用被测函数互相证明（`queueRelease.test.ts:718-722` 已记录 tautology 反例）。

**`src/renderer/components/chat/__tests__/composerStopStatic.test.ts`（S3）**
- 既有 6 组**保持绿**（`waitUntil` 换签名的回归证据）。
- **改名连带两处**（新发现，A 只写了一处）：`:251` `expect(stop).toBeLessThan(only('abandonMarkerRef.current = {'))` 与 `:272` `expect(body).not.toContain('abandonMarkerRef.current = {')` **都**改为 `pendingReplyRef.current = {`。
- **文件头散文「45s abandon」五处订正**（新发现，A 只写了三处）：`:14`、`:138`、`:235`、`:240`、`:256` → 「沉默天花板 / safety ceiling」。
- **新增第 7 组** `describe('admitted-timeout 分支既不判死也不回显 (F2)')`，锚点取 **`case 'ceiling':` 到 `case 'terminal':` 的源文切片**（比变量名稳定）：
  - `[S-1]` ceiling 分支体不含 `unbindHost()`
  - `[S-2]` 不含 `lastError`
  - `[S-3]` 不含 `restoreDraftIfComposerEmpty` / `setRetryable(`
  - `[S-4]` 含 `armPendingReply(`
  - `[S-5]` 不含 `finalizeOutcome(`；且 `decideAdmittedTimeoutOutcome(` 在文件中**恰一次**且位于 Stop 出路之后
  - `[S-6]` `budget.markLiveness(` 与 `classifyAssistantProgress(` **同在监听器内且各恰一次**（证明两函数确实分离）
  - `[S-7]` ceiling 分支体不含 `getHostStatus(`（§4.2 的负控）

**`src/renderer/components/chat/__tests__/messageTimelinePendingStatic.test.ts`（S3，新）**
- `[TS-2]`：`turnActive` 赋值行**同时**含 `inFlight` / `streamStartedAt` / `pendingActive` 三个标识符（`.tsx` 不可测事实的既有工法，头注引 `composerStopStatic.test.ts:1-16`）。
- `[TS-3]`：`useSecondsTick(` 的实参串含 `pendingReply`（防秒表在 `'pending'` 态停摆）。

**`src/renderer/components/chat/__tests__/turnStatus.test.ts`（S3）**
- `base.budgetMs: 45_000` 是 **fixture 而非常量主张，不改**。
- **新增 `[TS-1]`（写法按新发现⑥-b 收窄）**：`elapsedSeconds = 62`（`[45,180)` 内，与 `attachments.test.ts:357` 同源）且 `hasBlocks === false` 时 —— ① `kind === 'slow'`；② `text` **恰等于** `composerSendingLine` 对**同一入参**的返回值（委托同源，而非逐字硬钉）；③ `text` 含 `Stop to abort.`。
  > **命题是「kind 与 copy 同源」，不是「>=45 恒 slow」**——后者会在 F456 ④ 片把 `>=180` 拆给 `'stalled'` 时按构造假红。

**`src/renderer/components/chat/__tests__/attachments.test.ts`**：**零改动**。`:357` / `:436` 两条 62s 逐字断言是 slow 分支唯一的正控（§8.1），必须保持绿。

**`src/agent-host/__tests__/codexWatchdog.test.ts`（S4，新）**
- `[X-1]` productive 集**含**三条 plan/diff 方法（`turn/plan/updated` / `item/plan/delta` / `turn/diff/updated`）。
- `[X-2]` `account/rateLimits/updated` 与 `thread/status/changed` **不在**集内。
- `[X-3]` 集合与 `CODEX_NORMALIZER_METHODS ∪ CODEX_IGNORED_NOTIFICATIONS` 的**差集为空**（防上游新增通知被静默漏判）。
- `[X-4]` turnId 未知时 abort 路径**不构造** interrupt 参数。
- `[X-5]` 只有 outbound connection activity（持续写、零 inbound productive）时**仍 stall**（B 的负控）。
- `[X-6]` 30min ack timeout 与 195s watchdog **任一先到都只有一个 terminal**（双向竞态）。

**`src/main/services/agent-host/__tests__/AgentHostManager*.test.ts` / `src/main/ipc/__tests__/chat*.test.ts`（S5）**
- unexpected exit **广播一次**并覆盖**全部 open session**。
- `error` 后无 `exit` **也**广播；`error` + `exit` **去重**（恰一次）。
- `code === 0` / `SIGTERM` 的 intentional shutdown **不发失败**。
- open-session 台账在 **crash-mid-turn fixture** 下**不漏、不误报 idle session**（D2 的收口条件）。
- 合成事件送达所有未销毁窗口；窗口在 guard 后销毁时 catch 不影响其它窗口（复用 `chat.ts:174-183` 已有守卫）。

**清理链（S3）**
- `[D-1]` 八步顺序：清理**先于** reducer 应用新事实。
- `[D-2]` `RestoredDraftMarker` **仅在两个 revision 均未变**时撤销回显。
- `[D-3]` **用户编辑后绝不按值相等删除**（即使新输入与我们塞的那份逐字相同）。
- `[D-4]`（A 的升级版）：`'pending'` 分支执行后，`valueRef.current` 与 `attachments.getLiveDraftCount()` 与分支执行前**逐字节相同**。

### 12.2 关键断言（承重不变量六条）

1. **有序链**：`TTFT < STALL < SILENCE <= LOOP_BOUND`（`[C-01]`）——反转不变量的**数值半边**。
2. **包含关系**：progress ⊆ liveness（`[L-1]`）——反转不变量的**语义半边**。1+2 合起来才证明「Host 恒先说话」。
3. **负向咬合**：用户回声是 liveness 不是 progress（`[L-2]`）。
4. **不回显**：`decideFailureAffordance('pending', *) === 'none'`（`[P-2]`）+ 源文层 `[S-3]`——用户裁定的可执行形式，**双层保险**。
5. **镜像锁**：渲染端镜像 ≡ Host 真值（`[C-03]`）。
6. **词表冻结**：`PRODUCTIVE_EVENT_TYPES` 恰为五值（`[E-5]`）+ `claudeRuntimePartialStall` 保持绿。

### 12.3 回归三档归属

| 档 | 内容 |
|---|---|
| **smoke** | `[C-01]` `[C-02]` `[P-2]` `[E-5]` + 一个真实 timer 的最小 TTFT smoke |
| **main** | §12.1 全部用例 |
| **incident** | `[I-1]`（§12.4）+ 后续真机样本 |

### 12.4 incident 回归夹具 `[I-1]`（工程规范 #8 · D5 回退性依据）

**样本来源**：真机 0.4.0-test.5，2026-08-18，用户截图两张（Claude Opus 5 / Medium 显式选择）。原始现场三元证据见 §0.4。

**夹具事件序列**（按截图 `rawEvents` 逐帧还原，全部 scoped 到同一 `sessionId`）：

```
session.resumed
session.history
session.status(idle)
message.started{role:'user'}      ← 用户回声三连
message.delta{role:'user'}
message.completed{role:'user'}
session.status(running)           ← normalizer 对 system/init 的投影
session.settingsEcho
session.stderr
session.status(running)
session.status(running, retry{attempt:1, maxRetries:10, errorStatus:'503', error:'server_error'})
…（此后长时间静默，无任何 assistant 帧）
```

**四条断言**：

| # | 断言 | 咬住什么 |
|---|---|---|
| `[I-1a]` **正控·复位** | 按上述序列逐帧喂给 `classifyTurnLiveness` + `createSendWaitBudget`：**每一帧**（含用户回声三连、`session.stderr`、三帧 `session.status`）都把 `lastLivenessAtMs` 推到该帧时刻；在最后一帧之后的 `45s`、`299s` 两个取样点 `isExpired()` 均为 `false` | 缺陷 1（预算不看活性）；**这是新旧形态的分水岭**——旧的固定截止在 45s 必到期 |
| `[I-1b]` **正控·不判死** | 最后一帧之后 `300s+1ms` 取样点 `isExpired()` 为 `true`，且 `decideAdmittedTimeoutOutcome({sawUserEcho:true, sawAssistantProgress:false}) === 'pending'`，`decideFailureAffordance('pending', *) === 'none'`，`shouldArmRetryable('pending', *) === false` | 缺陷 2（停止等待 ≠ 回合失败）+ 缺陷 3（不回显） |
| `[I-1c]` **负控·同屏矛盾不可能态** | 该序列下**不得**产生 `lastError`：源文层由 `[S-2]` 保证 ceiling 分支不写 `lastError`；纯函数层断言 `deriveRetryBanner` 判定横幅可见（`retry != null && inFlight`）与 `deriveTurnStatus` 的 `kind === 'failed'` **不可同时成立**——「重试横幅可见 + no-progress 报错」是不可能态 | **现场标本的核心矛盾**；防任何未来改动把两者重新拼回同一屏 |
| `[I-1d]` **文案窗口** | 该序列在 `elapsed = 62s` 处，回合头文案为 `Still waiting · 62s · Retry 1/10 — gateway latency varies. Stop to abort.`（委托 `composerSendingLine` 同源比较，非逐字硬钉） | §9.3 行为破坏 ④ 的正控：文本无附件路径 45s 后**开始**可见 slow 文案，且 Retry 后缀仍在 |

**落点**：`src/renderer/components/chat/__tests__/f2IncidentTest5.test.ts`（新，S3），文件头**逐字记录**样本出处（日期 / build / 双图 / 三元证据），使其成为可被下一个 Agent 独立复核的档案。

---

## §13 变异计划

> **纪律（两轨并集，逐条强制）**：每对指名一个**承重行**（不是注释行、不是 inert 分支）；flip 前**预检 old/new 串在文件内双唯一**；跑完**立即回滚**；**零跳过**；**禁止改字面使其通过**；**禁止拿被测生产函数当自己的 oracle**。
>
> **计数说明**：M1~M21 沿用仲裁 §12.2 的编号与顺序（保持可追溯）；**M22 / M23 是本规格新增**，分别源自**新发现④**（`hasFired` 冒名，§0.5）与 **§2.5 的归一化兜底陷阱**（`attempt`/`maxRetries` 缺字段被兜底成 `0`）——两者都是「不做就带进生产缺陷」的类别，不加就没有咬合。**合计 23 对。**

| # | 承重行（片） | 变异 | 必红用例 |
|---|---|---|---|
| M1 | `sendBudgets.ts` `SEND_SILENCE_CEILING_MS = 300_000` → `150_000`（S2） | 破坏有序链 | `[C-01]` `[C-02]` |
| M2 | `createSendWaitBudget` 的 `markLiveness` 函数体改空（S2） | 复位失效 | `[C-04]` ② · `[I-1a]` |
| M3 | `createSendWaitBudget` 的 `isExpired` 去掉 `now - startedAt >= loopBound` 半边（S2） | 循环上界失效 | `[C-04]` ③ |
| M4 | `classifyTurnLiveness` 的 `session.status` 分支返回 `'ignore'`（S2） | 活性失效 | `[L-3]` · **`[I-1a]`** |
| M5 | `classifyAssistantProgress` 的 `role === 'assistant'` 改 `role !== ''`（S2） | **放宽谓词（最高优先级禁忌）** | `[L-2]` 红，**且 `[L-1]` 保持绿**（证明两函数确实分离） |
| **M6** | `decideFailureAffordance` 的 `'pending'` 分支**删除**（回落静默默认 `'resend'`）（S3） | **回显 + 双发复活（P0，§4.3）** | `[P-2]` `[P-3]` · `[I-1b]` |
| **M7** | `shouldArmRetryable` 的 `'pending'` 分支**删除**（回落静默默认 `true`）（S3） | **一键双发复活（P0）** | `[P-3]` · `[I-1b]` |
| M8 | `isAdmittedOutcome` 去掉 `'pending'`（S3） | 队列重发 | `[P-5]` |
| M9 | `ChatComposer` ceiling 分支加回 `unbindHost();`（S3） | 解绑复活 | `[S-1]` |
| M10 | `claudeRuntime` 证据门 `attempt >= maxRetries` 改 `attempt > maxRetries`（S1） | 边界误放 | `[E-1]` 的边界例（`attempt=10, max=10`） |
| M11 | `!sawAnySdkEvent` 恢复为**首窗口即 abort**（S1） | 冷启动误杀复活 | 改写后的 `:578-602` 两窗口用例 |
| M12 | TTFT 降级后继续 `rearm()` 而不 `markDegraded()`（S1） | R9 无限重入复活 | `[E-4]` · `[TW-1]` ② |
| M13 | `PRODUCTIVE_EVENT_TYPES` 加 `'system'`（S1） | 词表松动 | `[E-5]` + `claudeRuntimePartialStall.test.ts:126` 第二例 |
| M14 | `MessageTimeline` `turnActive` 去掉 `pendingActive`（S3） | 失表复活 | `[TS-2]` |
| M15 | Codex productive 集去掉 `turn/plan/updated`（S4） | 写 plan 被判死 | `[X-1]` |
| M16 | Codex watchdog 直接用 connection `lastActivityAt` 复位 stall（S4） | 出站流量永久保活 | `[X-5]` |
| M17 | Host exit 广播去掉 `session.failed`（S5） | 崩溃静默复活 | S5「广播一次覆盖全部 open session」 |
| M18 | Host exit 广播对**所有**会话（含 idle / intentional close）写 failed（S5） | 误报 | S5 intentional-close 负控 + 台账 fixture |
| M19 | 诊断帧 `reason` 恒返回 `'insufficient_evidence'`（S1） | reason 与分支脱钩 | `[E-2]` |
| M20 | text-only 45s 重新切回 `awaiting` copy（拆开 kind/copy 同源）（S3/S2） | §8.3 裁定被推翻 | `[TS-1]` 红，**且 `attachments.test.ts:357` 仍绿** · `[I-1d]` |
| M21 | 迟到清理**按文本相等**删除草稿（不看 revision/provenance）（S3） | 删掉用户新输入 | `[D-3]` |
| **M22** | `markDegraded()` 去掉 `this.firedFlag = false;` 那一行（S1）**【本规格新增，新发现④】** | **195s stall 冒用 TTFT 文案（诚实性 P0）** | `[TW-1]` ① · **`[E-4]` 的「错误文案不含 `no first response within`」半边** |
| **M23** | 证据门改读归一化 payload `session.status.payload.retry` 而非原始 SDK 事件（S1）**【本规格新增，§2.5 陷阱】** | **缺字段被兜底成 `0` → `0 >= 0` → 第一次重试就 abort** | `[E-1b]` |

**变异与切片的对应**：S1 → M10~M13 / M19 / M22 / M23；S2 → M1~M5；S3 → M6~M9 / M14 / M20 / M21；S4 → M15 / M16；S5 → M17 / M18。**每片收口时只跑本片的变异对**，合并门禁不重跑（§11.2）。

---

## §14 as-built 预留与 open questions 清账

### 14.1 open questions 清账（D1~D6 全决，无遗留待拍板项）

| # | 问题 | 决议【拍板 2026-08-18】 | 已回填章节 |
|---|---|---|---|
| **D1** | 确定死亡后已受理的消息要不要自动放回输入框？ | **自动放回**（取 A 的解读：确定死亡是**充分条件**） | §5.2 矩阵；**连带 `RestoredDraftMarker` provenance 必做** → §5.3 |
| **D2** | Host 崩溃时的会话终态广播做到哪一档？ | **全量**（会话级 `disconnected` + `failed`，零新增管道台账） | §6.2；**连带 S5 先于 S3 = 强序红线** → §11.3 |
| **D3** | 要不要为「CLI 一直在重试」付一个无证据常量？ | **不付**。只留 `attempt >= maxRetries` + 195s stall 兜底 | §2.5；`TTFT_API_RETRY_ABORT_ATTEMPTS` 与 `API_RETRY_LIVENESS_CAP_MS` **两个都不落地** |
| **D4** | Codex turnId 未知时允许「本地退休、远端可能还在跑」吗？ | **接受残留** | §7.4；登记为**已知限制**（下表） |
| **D5** | 渲染端半边不加 flag，是对规范 #6 的显式偏离，接受吗？ | **接受偏离** | §9.1；Host env 位定性为测试 seam；偏离记台账（§14.3） |
| **D6** | 300s 之外还要不要 30 分钟绝对上界？ | **要，但降格定性** | §1.2；改名 `SEND_WAIT_LOOP_BOUND_MS`，**非判死权** |

**本规格施工期零待拍板项。** 若施工中出现新的产品取舍，**停下来当场问**，不得由施工方自行吞掉（这是 D4 上交的先例）。

### 14.2 与仲裁档的差异登记（本规格的自主收窄，均为**加严**）

| # | 仲裁原文 | 本规格 | 性质 |
|---|---|---|---|
| 1 | §3.1「`TtftWatchdog` 已有 `markProductive()` 可永久关表的能力，改动落在 `onTimeout` 的策略而非 watchdog 类本身」 | 新增 `markDegraded()`（**类的纯加法**），因为只 `markProductive()` 会让 `hasFired` 停在 `true` → stall 冒用 TTFT 文案 | **P0 修补**（新发现④）。回退位（连调 `markProductive(); resetFired();`）零类改动，终值等价 |
| 2 | §3.3 `SessionLivenessNote` 含 `retryCount: number` | **删除该字段**，改指向同 payload 上已有的 `retry: SessionRetryInfo` | 与 D3「不以计数为证据」一致；单一真源 |
| 3 | §12.1「`turnStatus.test.ts` 新增 `[TS-1]`：`elapsed >= SLOW_WAIT_HINT_SECONDS && !hasBlocks` → `kind==='slow'`」 | `[TS-1]` 收窄为「**kind 与 copy 同源**」，断言点锚在 62s（`[45,180)`） | 防 F456 ④ 落地后**按构造假红**（新发现⑥-b） |
| 4 | §12.2 变异 21 对 | **23 对**（+M22 / +M23） | 新发现④与 §2.5 的归一化兜底陷阱各需一条独立咬合 |
| 5 | §12.1「`ttftWatchdog.test.ts` … watchdog 类本体不变」 | 类本体既有方法不变，**但新增 `markDegraded()` 与 `[TW-1]`**；`rearm` 的**政策**断言迁往 `claudeRuntimeOptions.test.ts`，watchdog 只留**机制**断言 | 政策/机制分层，与「改的是 `onTimeout` 策略」同向 |
| 6 | §12.1 `composerStopStatic.test.ts`「`:251` 改名 + 文件头三处订正」 | 改名**两处**（`:251` / `:272`），文件头**五处**（`:14` / `:138` / `:235` / `:240` / `:256`） | 行号重取的结果 |

### 14.3 as-built 预留（施工方回填，**不得留空**）

| 项 | 施工时必须回填 |
|---|---|
| **各片实际 commit 与 `git diff --stat`** | 与 §10 影响面清单**逐文件核对**的结果；多出或少掉任一文件都要在此写明理由 |
| **四门实跑记录** | 每片 4 行（typecheck / typecheck:agent-host / lint / vitest），**串行跑**，含耗时 |
| **断言点实跑记录** | §12.1 逐用例 id + 实际输出 |
| **变异 23 对实跑红灯记录** | 逐对：承重行原文 / 变异后原文 / 必红用例实际红 / 回滚确认。**零跳过**，跳过任一对即视为该片未收口 |
| **S5 先于 S3 的合入顺序证据** | 两片 commit 的先后（`git log --oneline`）。若被迫倒序，必须记 D2 轮询兜底的落地证据 |
| **拆 `sendBudgets.ts` 的实际选择** | 拆 / 原地保留（§1.5 的回退位），以及 diff 规模 |
| **`markDegraded()` vs 连调回退位** | 实际选了哪个形态（§3.2） |
| **F456 rebase 结果** | §11.4 四条同区点的实际消解方式；`turnSendStatus.ts` 是否真的无文本冲突 |
| **已知限制登记** | ① D4：Codex TTFT 阶段判死时远端回合可能续跑；② D5：渲染端半边对规范 #6 的显式偏离；③ 降级方案若启用（§6.2）：后台会话仍停在 `'running'` |
| **incident `[I-1]` 的实际落库路径** | 文件名 + 用例 id + 首次实跑绿的记录 |

### 14.4 落库与登记

1. 本规格落库后按 plantree 权威链登记：**注册表 + roadmap + 主线台账**（`docs/plantree/README.md` 为唯一入口）。
2. 仲裁档 `2026-08-18-f2-watchdog-arbitration.md` 作为 rev.0-A / rev.0-B → rev.2 的**裁定留痕**保留；**两轨盲稿不删**（双盲过程本身是资产），转归档状态。
3. 施工方读**本文**；读不明白某条裁定的**理由**时回查仲裁档对应节；两轨盲稿只作为「同一问题两个独立视角」的样本。
4. **发布说明**按 `fix:` 前缀写清 §9.3 的 ① 与 ④ 两条可观测变化。

---

> **施工方的第一件事**：把 §12 的验证定义写完（Happy Path → 断言 → 用例 → 变异对），**再动生产代码**（工程规范 #12「定义验证先，改代码后」）。§0.4 的 incident 样本 `[I-1]` 已经给出了本批最强的那条 Happy Path 反例，先让它红，再让它绿。
