# 批次 D4 回炉二审（R-A / R-B）

- 审阅人：二审代理（**只读**；未改文件、未跑测试、未起 Electron）
- 仓库 `/home/ai/code/ai-client`，分支 `feat/runtime-evolution`，基线 HEAD `b3d751e3` + 未提交的批次 D4 工作区
- 依据：一审 `/tmp/t032/reviews/group1.md`（四、T064）与 `group2.md`（T062 / T065 节）；回炉记录 `/tmp/t032/fixes/T064.md` §回炉、`T062.md` §回炉、`T065.md` §回炉；`git diff` 与新增未跟踪文件
- **结论速览：R-A = `pass-with-notes` · R-B = `pass-with-notes`**（两条 blocking 都真正关闭；下面每条 note 都给了代码路径）

---

## R-A（T064 blocking + T062 半生效）

### ① 一审 blocking 是否真正关闭 —— 是

判据是「输入框非空 + `createSession` 失败 → 载荷不丢」。逐段读码走了一遍：

1. `ChatComposer.tsx` 的 create 分派 catch 写 `lastError` 后 `return 'fatal'`；
2. `'fatal'` / `'timeout'` 两个出口都带 `{ sessionNeverCreated: true }` 进 `finalizeOutcome`；
3. `decideRunEntryOutcome({fatalHostError:true, …})` 在没有 echo / 无进展时答 `'rejected'`；
4. `decideFailureAffordance('rejected','direct',{sessionNeverCreated:true})` → `'restore-draft'`；
5. `restoreDraftIfComposerEmpty` 现在**返回 boolean**，输入框非空时返回 `false`（`if (!composerIsEmpty) return false;`）；
6. `finalizeOutcome` 拿到 `restored === false` 后问 `decideDeclinedRestore(outcome, origin, context)`，答 `'resend'` → `setRetryable(committed)`。

落地到界面：`lastTurnFailed = retryable !== null`，`canRetry` 只要 `retryText || retryDrafts.length` 再加既有的 `hasSendTarget / !busy / !sending / reading===0`，失败后这几项都成立，所以 ↺ 会渲染，`retryTitle` 带附件计数。一审给的反例序列（协议版本改 2 → 发送 → 等待期间再打一个字 → 超时）在新代码上走到的是第 6 步，**载荷有去处**。

顺带核了一个一审没点到、但同属「restore 可能悄悄吃掉东西」的面：`useComposerAttachments.addDrafts` 是无条件 `[...prev, ...newDrafts]`，**没有容量裁剪**，所以输入框为空那一支的附件恢复不会部分丢失。这条如果有裁剪，`'restore-draft'` 返回 `true` 就会变成第二个静默损失点；现在没有。

权威唯一性也守住了：回落判断在 `queueRelease.ts` 的纯函数里，组件只负责问和执行；`decideDeclinedRestore` 对 `'committed'`（三个 origin，带不带 flag）、`'pending'`、`'skipped'`、`release`、无 flag 一律答 `'none'`，不会把 A1 删掉的双发放回来。

### ② D17 —— 不属于 R-A（见下 R-B ②）

### ③ `ModelMissingNotice` 与既有三个覆盖层：实际不会同时出现两张

逐条查了三个覆盖层各自的门：

- **时间线的 `Session failed` 卡**（`MessageTimeline.tsx:712`，模型缺失分支 `:742`）门是 `status === 'failed'`。`AgentLoopPlugin.run()` 的 catch 先发 `session.failed` 再**紧跟**一条 `session.status: idle`（`agent-loop/index.ts:155-168`），而 store 的 `upsertSessionStatus` 不粘滞。两条事件还走同一个 16ms 事件队列（`chatSessions.ts` 的 `queue` + `flush`），同批落地、中间不重绘，所以这张卡在原生发送路径上不成立。
- **错误气泡替换**（`MessageTimeline.tsx:1171` 的 `NoticeMessage`）要时间线里有 `role:'error'` 的**消息**。全仓只有一个写入点：`chatSessions.ts:1578-1590` 的 `sendMessage` catch。而 `sendMessage` **没有任何生产调用点**（grep 全仓，只剩注释与测试；ChatComposer 走自己的 `runSend`），所以这条路今天是死代码。
- **`HistoryErrorNotice`** 只管历史读失败，与发送无关。

唯一还能让 `status` 停在 `'failed'` 的是 `WorkerManager.ts:2848` 的崩溃合成（后面**没有** idle 补位）。那条的文本是崩溃原因，命中不了三个 token，除非崩溃消息本身恰好含 `Pi model not found` / `WORKER_MODEL_NOT_FOUND` / `model_not_in_catalog`——概率极低，但那时确实会出现「时间线一张 + 输入框上方一张」。**记一笔，不判 blocking。** 另一个理论上的一帧同现：若 `session.failed` 与 `session.status idle` 因队列满（`RUNTIME_EVENT_MAX_QUEUE`）被拆到两次 flush，会闪一帧两张卡，纯观感。

**误触发面**：新卡只占用 `emptySurface === 'error-notice'` 这一格，触发条件与它替换掉的红框**完全相同**（`lastError` 非空 + `isModelMissingError` 命中），别的失败一个都没被吃掉（`MMW-18` 的反向断言 `{statusHint}` 钉住了这点）。其余写 `lastError` 的动作（`stopActiveSession` / `respondQuestion` / `ensureHost`）产生的文本不会命中三个 token。一审记过的 `thrownRunErrorText` 给所有带字符串 `code` 的抛出加前缀（`ENOENT: ENOENT: …`）这条本轮未变，仍是台账项。

### ④ 新增用例与反向验证

- `queueRelease.test.ts` 的 `decideDeclinedRestore` 4 条钉的是判据本身，其中「载荷必有去处」那条把 `decideFailureAffordance` 与 `decideDeclinedRestore` 的**答案对**写成不变量（空 → 草稿，非空 → ↺，两个都不是 `'none'`），这是本轮最有价值的一条。反向三组（`'committed'`/`'pending'`/`'skipped'`、无 flag、`release`）齐全。
- `createFailureDraftWiring.test.ts` 新增 2 条仍是**源码扫描**，且记录自己写明了等级。
- **缺口（note，不改结论）**：一审逮到的那条 bug 的精确形态——「restore 拒绝 → ↺ 被武装」——**没有任何一条用例执行过**。现在是「纯函数答案对」+「源码里那两行写在那儿」两半分别断言，中间的接缝仍靠论证。这正是一审说的「自动化只覆盖接线」的同一类盲区，只是这次盲区窄了一格。所以 `T064.md §5` 的真机两条（打字 / 不打字）在上机时**不能只做一条**。
- 反向验证按记录各判红对应用例（回落改恒 `'none'` → 2 红；`restored` 改恒 `true` → 1 红），形状可信；本轮只读，未复跑。

### ⑤ 范围与注释

- 范围克制：`decideFailureAffordance` 只加可选第三参、默认 `{}`；`decideDeclinedRestore` 是新函数不改旧行为；`ModelMissingNotice` 新建而不是把分支塞进 `MessageTimeline`；`fontDomainScan` 的闭合白名单按规矩登记并写了理由。
- **共栖提醒（与一审同口径）**：`ChatComposer.tsx` 同时含 T067 的 `largeAttachmentHint(attachments.drafts, undefined, t)`，分组提交要按 hunk 拆，不能整文件归 T062/T064。
- 注释全英文、密度合适，`decideDeclinedRestore` 的头注释把「`'committed'` 为什么必须是 `'none'`」写清楚了，是本次最关键的一段。
- 设计系统小瑕（观感）：新卡按钮是 `size="xs"` + `h-6`，时间线同类卡是 `size="sm"` + `h-6`，同一张语义卡两处档位不一致。

### 结论：`pass-with-notes`

落地前建议（都不阻断）：
1. 上机时 `T064.md §5` 的正反两条都做，因为接缝没有可执行用例。
2. 把「WorkerManager 崩溃合成的 `session.failed` 没有 idle 补位」记一条线索：它是今天唯一能让时间线那张卡活下来的路径。
3. `ChatComposer.tsx` 按 hunk 拆 T062 / T064 / T067。

---

## R-B（T065 blocking + D17 + 两条毛边）

### ① 一审 blocking 是否真正关闭 —— 是

判据是「会话 A 认领存活时，会话 B 的 open 失败不清 A」。

`PiTuiWindowSessionGuard.releaseClaim(sessionFile, windowId, terminalId)` 先 `normalizeSessionKey`，**只取这一个键**，并且只有 `owner.windowId === windowId` 才动；`releaseTerminal` 的跨键语义原样保留，只由 `onState` 的 `'dead'` 调用。`ipc/piTui.ts` 的 open catch 改调 `releaseClaim`。

terminal-03 路径复核：窗口 W / 终端 T 持有键 A → 同一 T 以 `sessionFile=B` 再 open → `claim(B,W,T)` 建键 B → `#openExclusive` 抛 `PI_TUI_SESSION_MISMATCH_REASON` → catch 只删键 B，键 A 完整。第二个窗口再开 A 仍被拒。

另外补了一项一审没展开、但决定这条修法安全性的检查：**`#spawn` 之后到 `#openExclusive` 返回之间没有任何 `throw`**（该文件的 throw 在 240 / 252 / 263 / 288 / 446，全在 spawn 之前或别的方法里）。也就是说「open 失败」永远意味着 pi 没起来，`releaseClaim` 不会撤掉一个真在跑的 pi 的认领——这条如果不成立，新修法会换一种方式复发 D18。

用例这次是真行为断言：`piTuiHandover.test.ts` 用真 IPC handler + 真 guard，`open.mockRejectedValueOnce` 制造 terminal-03 拒绝后断言「第二个窗口开 A 仍被拒」，反向那条断言「这次失败针对的 B 确实自由了」。反向验证（改回 `releaseTerminal` → 只有那一条红）形状可信。

### ② D17 新修法：推理成立，但它是**时序概率**而不是逻辑保证

**推理本身成立。** 老修法在同一个同步 tick 里 `rows+1` 再 `rows`，两次 `ioctl(TIOCSWINSZ)` 之间子进程不可能被调度，标准信号又不排队，pi 醒来读到的 winsize 与自己持有的一模一样——净变化为零与没变化不可区分。这与真机读数（`live` 之后只回流 10 字节、手工 `resize(70,20)` 立刻整屏）一致。新修法把 PTY **留在** `rows-1`，由前端 attach 完成后的 `confirmPiTuiSize` 补真实尺寸，中间隔一整个 Main→渲染层→Main 的 IPC 往返，于是子进程可观测到**两次真实跃迁**；并且第二次由 attach 触发，整屏重绘不可能早于能显示它的 xterm。逻辑链完整。

**风险 1（记录已自承，我确认并补一点）**：若 pi 在整个往返期间一次都没被调度（2 核满载），它只会读到最终的真实尺寸，退化回老样子。补充观察：`useXterm` 的 `handleResize` 挂在 window resize / `ResizeObserver` / `IntersectionObserver`（可见时触发，50ms 防抖）上，并且是**无条件**发当前 `cols/rows`。这既是一条额外的自愈路径，也是一个额外的竞争者——防抖 50ms，实践中会落在 `confirmPiTuiSize` 之后，但在极端负载下它同样可能参与「压平中间态」。上机第 2 条（高负载下重复切换）必须做。

**风险 2（Windows / ConPTY）**：`#primeRepaint` 的头注释论证用的是 Linux `tty_do_resize` 的「尺寸真变才发 SIGWINCH」。Windows 上 node-pty 的 `resize` 走 `ResizePseudoConsole`，不受这条规则约束，ConPTY 通常对任何 resize 都会 reflow——也就是说**前提在 Windows 上不适用，但结论偏安全**（更容易被观测到）。代价是：一次 resume 现在是「目标 → 目标-1 →（往返）→ 目标」三次 resize，ConPTY 的 reflow 比 Linux 明显，中间还多了一个肉眼可能看见的「矮一行」的帧。这是观感风险，只有真机能判，记录已列入复验第 1 条 ①②。

**风险 3（打包态）**：结构上无差别——同一条 IPC 路径，打包只影响机器速度，也就只影响风险 1 的概率边界。没有打包特有的失效面。

**风险 4（不 attach 时 `rows-1` 会不会永久留一行差）**：会留，但**有界且只是观感**。全仓 `piTui.open` 只有两个调用点（`useXterm.ts:806` 的 initTerminal 与 revive effect），两处都已补 confirm；`confirmPiTuiSize` 自己 `.catch(() => {})`，所以只有「confirm 的 resize IPC 失败」且「之后没有任何 resize 事件」两件事同时发生，PTY 才会停在 `rows-1`。后果是 pi 少画一行、xterm 底部空一行、输入框位置高一行，**不影响功能**，且任何一次窗口/容器尺寸变化都会自愈（`handleResize` 无条件重发）。选 `rows-1` 而不是 `rows+1`（避免顶行滚进回滚缓冲）以及下限 5 时改向上，都读过代码确认与 `boundedDimension` 一致，且用例把 `[100,6]` 钉住了。

### ③ 两条毛边

- **拒绝走 toast**：`piTuiOpenRefusalKey` 通用剥壳（正则去掉 `Error invoking remote method '…': [XxxError: ]`）而不是维护句子清单，方向对；认不出的原样返回，`translate` 回落成 key 自己。两条新补的中文词条（terminal-03 / concurrency-07）是必需的——它们以前从不显示，现在会显示。
  **note（新增面）**：剥壳是通用的，于是**内部错误也开始弹 toast**了：`Pi TUI capacity reached (2)`、`Pi TUI controller is disposed`、`terminalId and cwd are required` 这类从来不是给用户读的字符串，会以英文出现在中文界面里。记录把「最坏退化成英文」当作可接受取舍，我同意方向，但建议要么给容量那条补中文，要么给这三条内部串一个静默名单。
- **关窗文案排除预览窗**：`closeRequestReason(remaining)` 纯函数只认「未销毁且非预览」，`isPreviewWindow` 用 entries 里的窗口对象**按身份判定**（比一审建议的 `remaining.length > openCount` 算术更稳，避免预览窗已销毁但仍计数）。`MainWindow.ts` 显式排除 `win` 自己（`close` 期间它仍在 `getAllWindows()` 里）。三条 copy 的中文词条齐全，且 `closeConfirmCopy.test.ts` 有一条守卫钉住（这些 key 走变量、`i18nCoverage` 看不见）。
  小 nit：`useAppLifecycle` 里的 state 变量也叫 `closeRequestReason`，与 Main 侧同名函数重名——跨进程不冲突，只是读起来会愣一下。

### ④ 新增用例与反向验证

- D18 回炉 3+2 条：`piTuiSession.test.ts` 那条「只撤失败的那一个键、同一 terminalId 在别的会话上的认领必须还在」是把缺陷写成断言；反向两条（撤掉的会话确实自由、窗口对不上/空路径/没认领过都不生效）齐全。handover 的两条走真 handler，最有价值的是「拒绝之后第二个窗口仍被拒」。
- D17 的 5 条钉的是**resize 序列**，包括「结尾不等于目标尺寸」（老修法恰好死在这条）、「渲染层补一次后收在目标尺寸」、下限向上、回放顺序、以及反向的「首次 spawn 不预置」。它证明不了 pi 的观感，记录写明了。渲染层那半是源码扫描（`XTERM` 已 `stripComments`，正则不会被注释打断）。
- 关窗 3 条纯函数 + 源码扫描更新；拒绝 toast 4 条含两条反向（不认识的错误原样透出）。
- 四组反向变异按记录各判红一条、窄度条目照旧过，形状可信；本轮只读，未复跑。

### ⑤ 范围与注释

- 本轮改动 7 改 + 3 新增 + 6 测试，与记录一致，未越界；未触碰 R-A 的在飞文件（核对过 `queueRelease.ts` / `ChatComposer.tsx` 的 diff 里没有 TUI 相关改动）。
- **共栖提醒（沿用一审）**：`PiTuiPty.ts` 与其测试同时含 T066 的 spawn/exit 日志；`src/shared/i18n.ts` 同时含 T067 的四组词条。分组提交按 hunk 拆。
- 沿用未修、仍是既有形态：`transferTo` 已转移但 claim 被拒时不回滚（一审 ②-3）；`usePresentationSwitch` 另外三条英文 toast 与 `ChatComposer.tsx:776` 的 `` `Error: ${lastError}` ``。
- 注释全英文、简洁，「为什么不这么做」几处尤其到位：`#primeRepaint` 写清了 SIGWINCH 只在尺寸真变时才发、为什么不自己发信号（点名附录 B1）、为什么选 `rows-1`；`releaseClaim` 写清了它与 `releaseTerminal` 的语义差别和这次是怎么被逮到的；`closeRequestReason.ts` 写清了为什么做成纯函数。无中文注释。

### 结论：`pass-with-notes`

落地前建议（都不阻断）：
1. D17 上机第 1、2 条必做，尤其「`live` 之后回流字节数应为数 KB 而非 10 字节」这条硬判据，以及高负载下的重复验证。
2. 给内部 open 失败（capacity / disposed / 参数缺失）一个静默名单或中文词条，别让实现细节以英文弹到用户脸上。
3. Windows 上的三次 resize reflow 观感，排进下一次跨平台点验。

---

## 两条 blocking 的收口状态

| 一审判定 | 本轮 | 依据 |
|---|---|---|
| T064：`'restore-draft'` 在输入框非空时丢载荷 | **已关闭** | `restoreDraftIfComposerEmpty` 返 boolean + `decideDeclinedRestore` 回落 `setRetryable(committed)`；`addDrafts` 无裁剪，另一半也不丢 |
| T065：open 失败用 `releaseTerminal` 过度释放 | **已关闭** | `releaseClaim` 按会话键定向 + 归属窗口校验；`#spawn` 之后无 throw，所以回滚不会撤掉活着的 pi；真 handler 用例执行了缺陷形态 |
