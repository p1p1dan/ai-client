# 批次 D4 第三组只读审阅 — T066 / T067 / T068

- 仓库 `/home/ai/code/ai-client`，基线 HEAD `b3d751e3`，工作区含 D4 九项未提交修补
- 审阅方式：只读。未改任何文件、未跑测试、未起 Electron；结论全部来自 `git diff` / `git grep` / 源码阅读
- 已读：`docs/agent-project-engineering.md`（16 条 + 附录 A/B）、`/tmp/t032/fixes/T066.md`·`T067.md`·`T068.md`、`defects-ledger.md` 的 D4/D9/D10/D14/D16/D20/D21/D22/D23/D26 原文
- 其余在飞改动（D15 的 `removeUncommittedCreated`、D13 的 `readStringSetting`、D17 的 `#requestRepaint`、T065 的 i18n 条目等）不在本次范围，已逐处辨认后跳过

| 项 | 判定 |
|---|---|
| T066 可观测性 | **pass-with-notes**（一条须在提交前处理的安全注记） |
| T067 i18n 补漏 | **pass-with-notes** |
| T068 死代码删除 / header / 字重 | **pass** |

---

## T066 — 可观测性（D4 / D10 / D14 + 三条轻项）

### ① 是否针对根因：是，而且纠正了缺陷原文的错误归因

缺陷台账 D4 写的是「仓库注释称 electron-log 吞掉低于 error 的级别」。本次先把这条查伪了：`initLogger` 在 `log.initialize()` 之后执行 `Object.assign(console, log.functions)`，主进程的 `console.warn` 本身就是 `log.warn`，electron-log 什么都没吞——是本仓在日志开关关闭时把两个 transport 都钉成了 `error`，而这个开关**出厂默认是关的**（`src/main/index.ts:391` 与 `stores/settings/index.ts:207` 两侧默认 false）。

我核了三条独立链路，结论站得住：

1. 门槛确实是唯一原因（`src/main/utils/logger.ts` 改前 `file.level = 'error'` / `console.level = 'error'`）。
2. 第二个根因也真实存在：`ScratchWorkspaceService` 与 `WorkerManager` 的 `log` sink 生产单例都不注入，默认是 no-op，所以 D14 引用的 `[scratch] failed to remove` 在真机上连 electron-log 都到不了。本次把前者默认改成 `console.log`、把后者的两条改走 `console.error/warn`，方向正确。
3. 三条轻项（provider 重试、预算拒绝、pi TUI spawn/退出）都补在了 Main 侧唯一必经的那条缝上。

选 `file=info` / `console=warn` 两档不同，理由（文件是运维记录、终端是开发视图；不靠「把成功记成 warn」凑行数）我认可，没有更省事的替代。

### ② 回归与安全洞

**新增的 13 个日志点，脱敏 12 个到位、1 个有洞。** 逐条核过：索引修复行、导入失败行、scratch 释放/保留行、pi TUI spawn 行都过了 `redactStderrLine`；`session.failed` 行过了 `sanitizeStderrLine`；其余只打计数、会话 id、退出码，本就无敏感面。argv 摘要安全的论证也成立——初始 prompt 走 stdin 不进 argv，环境变量从不打印。

有洞的那一处：

```ts
// src/main/services/agent-host/ScratchWorkspaceService.ts:271
console.warn(`[scratch] Failed to remove ${redactStderrLine(target)}:`, error);
```

第一个参数脱敏了，**第二个参数 `error` 是原样的**。`rm` 抛出的 fs 错误其 `message` / `stack` 里带的就是未折叠的绝对路径（`EACCES: permission denied, rmdir '/home/<用户名>/...'`），electron-log 会把附加参数一并序列化写盘。等于绕过了刚刚做的那次脱敏。对应用例 `ScratchWorkspaceService.test.ts` 只断言 `warn.mock.calls[0][0]`（第一个参数），结构上抓不到第二个参数的泄漏，所以这条不是「测试没跑到」，是「测试断言的位置绕开了它」。

**更要紧的一条（这是我认为提交前必须处理的）：门槛下降把 ~85 个既有 `console.warn` 与 ~22 个 info 调用点一并「提拔」到了落盘级别，而这批既有日志从来没有过 T042 脱敏。** 本次只给自己新增的 13 个点做了脱敏，没有回头看被连带提拔的那 100 多行。落地记录里对这件事只算了「量」（数十 KB/天），没算「内容」。我抽查到的具体路径：

- `src/main/services/auth/CredentialVault.ts:636`
  ```ts
  console.warn('[CredentialVault] markInvalidated: existing vault is not valid JSON', error);
  ```
  这里的 `error` 是 `JSON.parse` 的 `SyntaxError`。Node 20+ 的 V8 会在错误信息里**回显出错位置附近约 30 个字符的原文**（`Unexpected token 'x', ..."<原文片段>"... is not valid JSON`）。而保险库存在明文形态：`enc: 'none'`（`CredentialVault.ts:115/525/575`，safeStorage 不可用时走这条）。三者叠加 = 明文凭据的片段有可能被写进 `logs/aiclient-<date>.log`——而在这次改动之前，这一行根本到不了磁盘。概率不高（需要「明文保险库」+「文件损坏」+「损坏位置落在 payload 附近」三件事同时成立），但路径是通的，且是本次改动新造出来的。
- `src/main/index.ts:525-526` `[local-image] Request URL / Parsed Path`——**每渲染一张图 2 行**，内容是未脱敏的绝对文件路径。这是唯一一处真正的准热路径，落地记录自己也点了名，但处理方式是「上机跑一天看文件有没有被撑爆，撑了再降 debug」，属于把验证推给了下一站。
- `src/main/ipc/worktree.ts:49` `log.info('[worktree:list] workdir=<绝对路径> …')`——每个仓库刷新一次，路径未脱敏。
- 我数了一下，85 个 warn 调用点里约 **49 个**带原始 `error` 对象或裸路径。

补充一条口径不一致（不影响安全，只是行为上有点怪）：开关**关闭**时 file 是 `info`，开关**打开**且用户选 `warn` 或 `error` 时 file 反而更保守。也就是「打开日志」可能比「关闭日志」记得更少。另外渲染层这一侧没跟着动（`src/renderer/utils/logging.ts:13` 关闭时仍是 `error`），主/渲染两侧现在不同档，这点落地记录没提。

**建议（都是小改，不必推翻方案）**：① `ScratchWorkspaceService.ts:271` 改成 `console.warn(\`... ${sanitizeStderrLine(describeError(error))}\`)` 之类的单参数形式，并把用例断言扩到全部参数；② `CredentialVault.ts:636/628` 这类会回显文件原文的点，改成只打错误名不打 error 对象；③ `src/main/index.ts:525-526` 直接降 debug，不要留到上机再判。

### ③ 用例是否钉住行为、反向验证是否可信

可信。19 条用例覆盖了 7 个文件，每组都带反向臂，而且反向臂选得对（不是「换个断言值」，是「删掉修复本身」）：

- `logger.test.ts` 显式写了 `expect(transports.file.level).not.toBe('error')`——直接钉死回归的那个具体值，而不只是钉正向值。
- `WorkerManager.test.ts` 的第三条「普通 running / completed 一行不打」是真正的负向控制：它挡住的是「把 `logNotableEvent` 写成无条件打一行」这种过修。
- `ScratchWorkspaceService.test.ts` 用「共用目录 → 打保留而不是已释放」把两个出口分开钉，这正是 D14 抱怨的「删对了和没删在日志上分不出来」。
- 落地记录列的 5 组反向验证（改回 `'error'`、去掉 `redactStderrLine`、关掉 retry 分支、关掉失败行、删掉成功行）判红方式各不相同，不是同一条断言的复述。

不足只有一条，即上面说的：scratch 失败路径的脱敏断言只覆盖第一个参数。

关于工程规范：§12「先定验证再改代码」这一条在本任务是成立的（每个日志点都有对应用例），§2「结构化 trace」不受影响（本次只加人类可读日志，没动 trace）。

### ④ 范围

没有越界。三条「有意没做」的记账（不接 WorkerManager 的逐行 stderr sink、retry 记在 Main 侧而非在飞的 `src/runtime/plugins/agent-loop/index.ts`、预算拒绝同理）我都核过，`src/runtime/plugins/agent-loop/index.ts` 确实一行未动，`provider_retry` 的产生点 `onRetry` 每次重试只触发一次、`projector.ts:427` 的 `retry()` 也只发一个带 `payload.retry` 的 `session.status`，所以「每条消息打一行」的风险不存在。

`PiTuiPty.ts` / `SessionIndexService.ts` / `chat.ts` 三个文件同时带别的任务改动，本次是在其之上追加，没有覆盖。

### ⑤ 注释

英文、语法正确、事实准确。但**不简洁**：`logger.ts` 那一处是 31 行的块注释，`WorkerManager.logNotableEvent` 与 `ScratchWorkspaceService.release` 各约 8～18 行。CLAUDE.md 的要求是「简洁明了，避免冗余描述」。这批注释把「现场怎么发现的」「为什么不选另一个方案」都写进了源码，这些属于落地记录 / 决策记录的内容。考虑到本仓既有注释普遍偏长（是既定风格，不是本次引入），不构成阻断，但建议把 `logger.ts` 那 31 行压到 8～10 行，把方案取舍留在 `/tmp/t032/fixes/T066.md`。

---

## T067 — i18n 补漏包（D9 / D20 / D21 / D26）

### ① 是否针对根因：是

四条缺陷的共同点被识别对了：不是措辞问题，是这些界面**从来没问过词典**。修法统一成「固定文案变字典键 + 渲染处过 `t()` + 带数值的用 `{{占位符}}`」，与仓库既有机制（`src/shared/i18n.ts` 唯一词典、英文即键、`englishTranslate` 作默认值）一致，没有引入第二套机制。

尤其对的一处判断：D21 的重试横幅拆成**四个键**而不是两个带 `{{counts}}` 的模板。理由（次数在英文里卡句中、在中文里落句末，中文接不了一个「中间挖洞」的英文句）成立，`buildTitle` 的 2×2 写法是这个问题的正解。

D9 的分层也对：Main 进程没有 locale，所以它只发 code + 数值（`errorCode` / `errorParams`），把「说成中文」「67108864 说成 64 MiB」「补一句下一步」全部放在渲染层。只给两个可补救的 code、其余失败继续走原文 `error`，这个克制是对的——给「源文件没了 / 权限不足」编一句友好中文只会丢掉唯一有用的细节。

### ② 回归与安全洞

我按你点名的四项逐条查了：

**词典键冲突：零。** 我对 `zhTranslations` 全表做了键提取，2333 条键、2333 个唯一值，**没有重复键**（重复键在这种扁平 `Record` 里会静默后覆盖前，是这类补漏最常见的塌方方式，这里没有）。新增的通用词也没撞既有用法：`t('image')` / `t('text file')` 全仓只有 `attachmentLimits.ts:98` 一个调用点；`Continue`（`i18n.ts:1625`）与 `Details`（`:2664`）是既有条目，复用而非新增，语义一致。

**占位符齐全：齐。** 17 条附件键、5 条重试键、2 条导入键的 `{{…}}` 我逐条对了调用处的参数表，没有漏参。`translate()`（`i18n.ts:2919`）对缺参的行为是保留 `{{token}}` 原样而不是打印 `undefined`，这是个安全的降级；而且 `legacyImportFailure.ts:32` 还加了一道 `typeof limit === 'number'` 守卫，有 code 无 limit 时回落原文，不会印出「超过了 undefined 条」——这条对应的用例也在（`ignores a code whose parameter did not survive the trip`）。

**英文回落：保留，且逐字节不变。** `englishTranslate` 作为所有纯模块 `t` 参数的默认值，未接线的调用点产出与改前完全相同。我手工对过重试横幅四种形态：改前 `counts` 是带前导空格的 `' 2/10'` 拼进 `Network retry${counts} — …`，改后是裸 `'2/10'` 填进键 `Network retry {{counts}} — the turn is still running`，输出同为 `Network retry 2/10 — the turn is still running`。其余三种同理。这正是那 15 条旧断言能全绿不改的原因。

**`ClaudeImportSourceError.failure` 形状：纯加法，不破坏既有消费者。** 新增的是一个可选只读字段 + 一个可选构造参数，既有的单参数 `new ClaudeImportSourceError(msg)` 调用点全部不受影响；`LegacyImportItemResult` 新增的 `errorCode` / `errorParams` 也是可选字段，IPC 这一路是 `src/main/ipc/legacyImport.ts:30 → preload/index.ts:919 → useLegacyImport.ts:45` 三跳纯透传，没有会把未知字段剥掉的 schema 校验。我另外查了循环依赖（`LegacyImportService` 现在**值导入**了 `ClaudeSourceAdapter` 的类，用于 `instanceof`）：`ClaudeSourceAdapter` 不反向导入 `LegacyImportService`，无环。

**React 侧的性能面：没有问题。** `useComposerAttachments` 往两个 `useCallback` 的依赖表里加了 `t`，`useI18n` 的 `t` 是 `React.useCallback(..., [locale])`（`src/renderer/i18n.ts:46`），只在语言切换时变身份，不会每帧重建回调。`MessageTimeline.tsx` 的两个 `deriveRetryBanner` 调用处 `t` 都在作用域内（`ChatTurn` / `PendingTurnHead` 各自有 `useI18n()`），我确认过。

**一个功能面的顺带确认**：`buildOptionRows` 现在翻译了「Other…」这一行的 `label`。这不会影响选择逻辑——判定用的是 `option.isOther` 布尔量（`QuestionCard.tsx:237/484/496/501/502/504`），`label` 只用于显示，没有任何地方把它当标识符比对。

### ③ 用例是否钉住行为、反向验证是否可信

总体可信，有**一处缺口**。

可信的部分：

- `chineseChatSurface.test.ts` 新增的两条是真 DOM 渲染守卫，而且带负向臂（`expect(text).not.toMatch(/Questions|Other…|Skip|Continue/)`）。落地记录指出问答卡英文了这么久没被发现，一半原因就是这个文件只守了权限卡，这个判断对。
- `toolVocabulary.test.ts` 的表侧守卫与上面那条**失败方式不同**（漏词条在这里红，渲染路径没问词典在那里红），不是互相替代的重复断言。这一点记录里说清楚了，我认可。
- `timelineRetryInteraction.test.ts` 把 `t` 的桩从 `(key) => key` 改成 `englishTranslate`——这是**加强**不是迁就：恒等桩只对无参键成立，带参键下它会把 `Upstream error {{status}}` 当成渲染结果收下。
- `messageTimelineWiring.test.ts:1059` 把接线 token 同步成 `deriveRetryBanner({...}, t)`，意味着「pending head 忘了传译器」会直接判红。这是这类接线缺陷唯一能自动化的守法。
- `legacyImportFailure.test.ts` 7 条里有 4 条是反向臂（未编码失败保留原文、`undefined` 入参、默认译器出英文句而非键回显、有 code 无参数时回落）。

缺口：**Main 侧 `failureFields()` 没有任何用例。** `ClaudeSourceAdapter.test.ts` 钉住了「throw 出来的错误带 code」，`legacyImportFailure.test.ts` 钉住了「拿到 code 就出中文」，但把两端接起来的那三行（`LegacyImportService.ts:38-52` 的 `failureFields` + `:277` 的 `...failureFields(error)`）没有任何断言。这一段恰好是 `instanceof` 判断——最容易在打包/分块变化下静默失效的那类代码（本仓在 vite 循环分块上吃过亏）。它一旦失效，表现是「悄悄回落到英文原文」，也就是 D9 原样复发，而且**全部现有用例都仍然绿**。记录里的理由是「该文件正被 T066 改」，可以理解，但这个缺口应当补一条，不宜留着。

另一处已知且记录在案的缺口：`ChatComposer.tsx:2623` 那一行接线**没有任何测试能覆盖**（全仓没有测试 import `ChatComposer.tsx`），只能靠 DEV-33 真机复拍。记录自己写明了，处理得诚实。

### ④ 范围

基本守住，有一处**主动记账的越界**，我认为判断正确：

- D26 的缺陷行只点了 `attachmentLimits.ts` 里六句，本次额外译了 `pickedAttachments.ts` 自己的三句和 `attachments.ts:549` 的 `formatSkipNotice` 外壳（+4 词条）。理由是它们进同一条折叠提示，不一起译就会出现「中文清单套英文外壳」——那是同一个缺陷换了一层。这个越界是对的，而且记了账。
- `ChatComposer.tsx` 只改了 `:2623` 一行，我用 `git diff` 逐 hunk 确认过：该文件另有四段改动（`FailureAffordanceContext`、`finalizeOutcome` 的 `context` 参数、`createSession` 的 try/catch 等）全部属于 D15，本次没碰也没依赖。
- 明确留在界外的：`formatAttachmentSize` 仍输出 `MB/KB`（二进制除数、十进制单位）——这是另一条账，没动，对。
- `src/shared/i18n.ts` 的 diff 里还有 T065 的两个区块（`Pi TUI closed` 一带、`Close this window` 一带），属另一任务在飞，不计入本项。

### ⑤ 注释

英文、准确。同样偏长（`legacyImportFailure.ts` 顶部 23 行、`legacyImport.ts` 类型块 14 行），并且和 T066 一样把「现场是怎么拍到的」写进了源码。不构成阻断。有一处小瑕疵：词典里的说明性注释混用了中文（`// D20 — …一个 Chinese user 看到 「权限」 和 「Questions」…`），与「所有代码注释必须使用英文」有轻微出入——不过那几个中文字符是被引用的**界面原文**，属于「引用原文」豁免范围，可以放过。

---

## T068 — Node 24 死代码删除 / `QuestionItem.header` / 卡片字重（D16 / D22 / D23）

### ① 是否针对根因：是，三条都取到了根

**D16 选「删」而不是「接回去」——理由经得起推敲。** 我独立复核了它给的取舍依据：

- 在基线 `b3d751e3` 上跑 `git grep -nI 'resolveNode24Runtime|isNode24ResolutionFailure' -- src scripts`，命中只有三类：定义自身（`NodeRuntimeResolver.ts:50`、`hostStatus.ts:264`）、桶文件 re-export（`agent-host/index.ts:9`）、单测。**零生产调用方**，落地记录的说法属实。
- 「接回去」会与 D11 的既定行为相冲突：产品路径现在是「随包 node 缺失即明确失败、不回落」，而解析器整套行为是「到处找 Node 24」。接回去等于把 D11 反过来。这条判断我认可。

**D22 选「渲染」而不是「删字段」**：`runtimeEvents.ts:536` 的契约注释、`ask.ts:80` 的 schema、`ask.ts:130` 的原样透传三者都在，删字段要动 runtime 与类型两侧，渲染只需一处。选择合理。

**D23 的依据是硬的**：`docs/design-system.md` §Font Weight 明写「500 不得作为任何层级区分的唯一载体」，理由是 Win10 的 Segoe UI 静态族没有 500、CSS Fonts 4 §5.2 会降到 400。本机 Linux 看不出来，下一站 Windows 加密机上两张卡的标题会和正文逐像素相同。这不是观感偏好，是平台事实。

### ② 回归与安全洞

**删除 Node 24 解析器：真无生产调用方，我自己复核过，结论一致。**

- 工作区态：`git grep -nI -E 'AICLIENT_NODE24_PATH|resolveNode24Runtime|REQUIRED_NODE_MAJOR|NodeRuntimeResolver|NodeRuntimeInfo|NodeRuntimeSource|NodeRuntimeResolveResult|isNode24ResolutionFailure' -- src scripts electron.vite.config.ts package.json` → **零命中**。
- 我另外用不带 `-I` 的 `grep -rn`（规避「含裸 NUL 的 .ts 被静默跳过」那个坑）把 `node24|Node24|NODE24` 在全仓非 `node_modules`、非 `docs/` 范围扫了一遍 → 零命中，剩余全在 `docs/` 的存证与规划文件里。
- 桶文件 `src/shared/types/index.ts:2` 是 `export * from './agentHost'`，删掉三个类型不会留下悬空的具名 re-export。

**打包态 Windows 随包 node 路径：不受影响。** 两条产品路径都不经解析器，我直接读了源码确认：

- `PiWorkerProcess.ts:79-83`：`app.isPackaged && win32` 时直接 `path.join(process.resourcesPath, 'node-runtime', 'node.exe')`，缺失即 `throw new Error('Pi Node runtime is missing: <路径>')`；其余平台走 `utilityProcess.fork`。
- `PiTuiPty.ts:155-157`：`useElectronNode = !layout.isPackaged`，打包态同样是 `resources/node-runtime/node[.exe]`，同一句失败文案。

删掉的那套「explicit → `AICLIENT_NODE24_PATH` → nvm/fnm/volta → PATH」候选链从未参与这两条路。同时也确认了 `isNode24ResolutionFailure` 在渲染层确实不可达：`describeHostStatus` 四个分支里一处都没调它。

**字重改动没有越出两张卡。** `QaHead` 全仓只有两个调用点，都在 `QuestionCard.tsx`（`:336` 冻结卡、`:419` 交互卡）；权限卡的段头是它自己的 `<span>`（`:672`），标题行是自己的 `<p>`（`:686`）。5 处改动全部落在 `QuestionCard.tsx` 内，**没有动任何共用基类**——选项按钮仍从 `Button` 基类继承 `font-medium`，这一点还被一条负向断言钉住了。chip 也没引入新档位，形制照抄同文件的 `PERMISSION_RISK_CHIP.medium`（`bg-muted text-muted-foreground` + `rounded-sm` + `px-1.5 py-0.5` + `text-meta`），我对过，一致。

两处小提醒（都不阻断）：

1. `item.header` 在渲染处**没有长度兜底**，32 字符上限只存在于 `ask.ts:81` 的 schema 里。`QuestionItem` 是 shared 类型，`src/runtime/worker/questionPrompt.ts:60` 也会转发这个字段；如果将来出现一个不经 ask schema 的生产者，chip 的 `inline-block` 没有 `truncate` 会被撑开。加一个 `max-w-[…] truncate` 或在渲染前 slice 一下更稳。
2. `dev.env` 的改动是本机 gitignored 文件，不会随提交走。`dev.env.example` 里本来就没有这个变量（我确认过），所以不需要同步；但**其他开发机上的 `dev.env` 仍可能留着这一行**——无害（已无人读），只是别在上机日再拿它做判据。备份 `/tmp/t032/dev.env.bak-T068` 存在。

### ③ 用例是否钉住行为、反向验证是否可信

可信，而且这一项的负向控制做得最好。

新增的那一条用例（`questionCardInteraction.test.ts`）用 class 断言而非 `getComputedStyle`——理由正确（happy-dom 不加载 Tailwind 样式表，class 列表是唯一可观测量），四组断言覆盖 chip、四处标题、选项描述，**外加一条真正的负向控制**：

```ts
expect(radio?.className).toContain('font-medium');
expect(radio?.className).not.toContain('font-semibold');
```

这条挡的是「全局把 `font-medium` 扫成 `font-semibold`」的过修——如果有人图省事全局替换，这条会红。这是整组三项里最标准的一条反向臂。

四次「改回去 → 确认判红 → 复原」的记录，每次的判红消息都不同（`expected undefined to be defined` / 三种不同的 class 断言失败），不是同一条断言的复述；复原后还与备份 `/tmp/t032/QuestionCard.T068.keep` 做了逐字节比对。

D16 没有新增用例，验收靠「`git grep` 残留为零 + 三套 tsc + 原有 `hostStatus.test.ts` 22 条仍绿」——对删除型修补这是合适的口径，符合工程规范 §12 的精神（删除的「验证」就是「没有任何东西还需要它」）。

唯一可补的一条：**没有断言「`header` 缺省时 chip 不渲染」**。现在靠同文件其他不带 header 的用例间接覆盖，但那是巧合覆盖，不是显式契约。加一行 `expect(spansWith('Storage')).toHaveLength(0)` 式的负向臂会更稳。

### ④ 范围

守得很干净，而且有两处主动的「刻意不做」，判断都对：

- 桶文件 `src/main/services/agent-host/index.ts` 本身零导入者，是另一条发现（main-host-06），**保留未动**——没有顺手扩大战果。
- 选项**标题**（`role="radio"` 按钮）保留基类 500 未改：分档表把 `button / label / 导航项` 判给 `font-medium`，它不承载标题层级。`tracking-[0.01em]` 与两处 10px 的轻微偏差同样留在界外。
- `queueRelease.ts:450` 注释里那句「Node 24 missing catch path」措辞漂移，因文件在飞而没碰，只在记录里点名建议由属主顺手改——处理得对。
- 计划文档（`checklist-e.md`、`p1-0-host-contracts.md:282`、`README.md` 的 D16 行）需要回写的四处，本次没碰，列在记录里交给计划属主——符合「不碰在飞文件」的约束。

改动路径共 10 个（+ gitignored 的 `dev.env`），与记录列出的完全一致，我逐个核过。

### ⑤ 注释

英文，准确，**这一项是三项里最简洁的**。删除型改动的注释是「减法」（`HostStatusBanner.tsx:8-12` 删掉不再兑现的承诺、`useHostStatus.ts:13/15/105` 三处措辞改成与代码相符），没有新增长篇。新增的两处 JSX 内注释（chip 的 D22 说明、选项描述的 `font-normal` 理由）各 3～4 行，长度合适。

一个语法上的确认：两处注释都写在 `{cond && (` 之后的括号表达式里，是 JS 表达式上下文而非 JSX 文本上下文，`//` 行注释在这里合法，不会被渲染成文本。Biome 也是干净的。

---

## 收口

- **T068：pass。** 三条缺陷都取到根，删除的死代码我独立复核过确无生产调用方，打包态 Windows 路径不受影响，字重改动没有越出两张卡，负向控制做得最好。两条可选加强（chip 长度兜底、header 缺省的负向断言），都不阻断。
- **T067：pass-with-notes。** 机制选择、键设计、英文回落、类型加法全部正确，我逐条验过词典无重复键、占位符齐全、既有消费者不破。**一个应当补的缺口**：Main 侧 `failureFields()` 的 `instanceof` 接线无任何用例，它静默失效时 D9 会原样复发而全部现有用例仍绿。`ChatComposer.tsx:2623` 那一行无法自动化覆盖，已如实记录，靠真机复拍。
- **T066：pass-with-notes，但那条注记建议在提交前处理。** 根因查得比缺陷原文更准，13 个日志点的脱敏 12 个到位，用例与反向验证扎实。问题不在新增的点，而在**门槛下降把 ~85 个既有 warn 与 ~22 个 info 一并提拔到落盘，这批既有日志从来没过 T042 脱敏**，落地记录只算了量没算内容。最具体的三条路径：`CredentialVault.ts:636`（`JSON.parse` 的 `SyntaxError` 会回显文件原文片段，而保险库存在 `enc:'none'` 明文形态）、`src/main/index.ts:525-526`（每张图 2 行未脱敏绝对路径）、`ScratchWorkspaceService.ts:271`（第二参数 `error` 原样，且对应用例只断言第一参数，结构上抓不到）。三处都是小改。
