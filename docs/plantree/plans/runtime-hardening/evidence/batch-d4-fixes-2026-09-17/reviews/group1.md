# 批次 D4 第一组只读审阅（T060 / T061 / T064）

- 仓库 `/home/ai/code/ai-client`，分支 `feat/runtime-evolution`，基线 HEAD `b3d751e3`，工作区未提交
- 审阅方式：只读。未改任何文件、未跑测试、未起 Electron
- 依据：`docs/agent-project-engineering.md`（§2 结构化轨迹、§4 过程断言优先、§7/§8 回归资产、§12 先定验证再改码、A3 空壳要说明理由）
- 三项结论：**T060 = pass-with-notes** · **T061 = pass-with-notes** · **T064 = blocking**

> 术语约定：下文「预检」指写队列外的检查，「兜底」指队列内的精确检查；「rider」指挂在内容块上的附加键。

---

## 一、在飞文件的归属说明（先说清楚，避免误判越界）

任务书给的文件清单里有几个文件同时被别的任务改过，`git diff` 里混着别人的改动。已逐段区分：

| 文件 | 属于本组 | 属于别的任务 |
|---|---|---|
| `src/main/services/agent-host/ScratchWorkspaceService.ts` | D13 的读法改动（`settingsTemporaryPath`、import） | `log` 默认值从 no-op 改成 `console.log`、`release()` 两条日志、`removeQuietly` 改 `console.warn` —— 全部带 `T066 (D14)` 标记 |
| `src/main/ipc/chat.ts` | T064 的 create 失败回滚 | 归档分支两条 `console.log`（`T066 (D14)`） |
| `src/main/services/chat/SessionIndexService.ts` | `removeUncommittedCreated` | 修复日志里 `redactStderrLine` 那一行（`T066 (D4)`） |
| `src/main/services/agent-host/WorkerManager.ts` | **没有 T064 的改动** | 整段 `logNotableEvent` 属 T066 |
| `src/runtime/plugins/agent-loop/index.ts` | **没有 T061 的改动** | `thrownRunErrorText`（D19，属 T062） |
| `src/runtime/__tests__/agentLoop.test.ts` | 无 | T062 的 `model_not_in_catalog` 用例 |
| `src/renderer/components/chat/ChatComposer.tsx` | T064 的 create 分支 | 末尾 `largeAttachmentHint(..., t)` 一行属 i18n 那一族 |

三份落地记录对这一点都是诚实的（T060 §7、T061 §二、T064 §3 各自只认领自己那几行）。**跨任务交叉点已复核一处**：T062 给 `session.failed` 加了 `code:` 前缀，但只在 `run()` 的 catch 分支（`agent-loop/index.ts:158`）生效；T061 用例 5 走的是 `projector.finish`（`events/projector.ts:540`，用 `result.error.message` 原文），两者不冲突，用例 5 不会因为 T062 而判红。

---

## 二、T060 — 临时根设置 Main 侧读不到（D13）+ 未绑定会话运行中消失（D6）

### 结论：`pass-with-notes`

### ① 根因 vs 症状

两条都打在根因上。

**D13**：`readSettings()` 返回 settings.json 的顶层，而渲染层是用 zustand `persist` 落盘的，用户改的每个字段都在 `aiclient-settings.state` 一层里。两个服务都按顶层取键，于是恒得 `undefined`，各自的 `?? ''` 把它读成「用户没选过」。修法是把解包收进 `ipc/settings.ts` 的 `readSettingsState()` / `readStringSetting()`，键名常量也只写一处（`TEMPORARY_PATH_SETTING_KEY`）。这是结构性修复，不是把两处读法各自打补丁。

真正值钱的一笔在测试侧：`tempWorkspaceRecovery.test.ts` 原来 `vi.mock('../settings')` 直接返回扁平对象 `{ defaultTemporaryPath }` —— 一个磁盘上从不存在的形状，这正是 D13 长期测不出来的原因。这次把 mock 下沉一层到 `SharedSessionState`，让真实解包在这个文件里也跑。符合 §12「先定验证再改码」的精神。

**D6**：定位准确且与 D13 明确切割（侧栏可见性只看 `session.unbound` 标记与 `workspaceId`，完全不看路径）。根因是两条「重建会话列表」的路径对「未绑定」的认知不一致：启动路径 `mergeSessionIndex` 有 `!workspaceId && unbound` 分支，运行中的 `rebindSessionsToTree` 没有，于是跑过一轮、带着 `runtimeIdentity` 的临时对话掉进「孤儿」规则被 `continue` 丢出 store。新分支插在孤儿规则**之前**，判据 `!session.workspaceId && (session.unbound != null || session.runtimeIdentity != null)`。

判据本身核过：渲染层 `ChatSession.unbound` 的类型是 `{ workspacePath: string } | undefined`（`stores/chatSessions.ts:153`），不是布尔，所以 `!= null` 不会把「显式 false」误吞——这一点我一开始怀疑过，查类型后排除。

### ② 回归与安全洞（含设置解包越界的对照检查）

**scratch 一侧：没有越界。** 对照 T037（`99db822c`，main-aux-01「越界删根外目录」）留下的守卫逐条看：

- `rootPath()` 永远是 `resolve(join(用户根, 'unbound-sessions'))`，固定追加一层目录名，所以即使用户把保存位置设成 `/`，`wipeAll` 的 `rm -rf` 目标也只是 `/unbound-sessions`；
- `isScratchPath` / `adopt` 用的是 T037 引入的 `workspaceContainment.isInsideDirectory`（resolve + relative），不是字符串前缀，`<root>/../x` 进不来；
- `knownRoots` 的注释明写「只收从设置算出来的根，绝不收索引行或导入文件给的路径」，这次没有破坏这条。

**跨重启不会把老会话变砖**（我原本担心的一条，已排除）：换根之后旧的 unbound 行路径落在老根、`isScratchPath` 答 false，但 `chat.ts:468-482` 有 T040 追加项 4 的 `else if (row.unbound)` 分支，会在当前根下重新分配并保持 `unbound`；`CHAT_ENSURE_SCRATCH_WORKSPACE`（`chat.ts:365-378`）同理回落 `ensure`。所以 T060 记录 §5 自己列的「二阶风险」在现有代码里已被 T040 挡住。

**临时工作区一侧：有一处真实的作用域放大，建议收窄（note 1）。** `isTempWorkspacePath` 的判据是「用户所选根的直接子目录」，这个判据在 D13 修好之前只能命中默认根，修好之后开始命中用户真正选的那个根。于是：

- 路径：`chat:createSession` → 非 scratch 分支 → `adoptTempWorkspace(payload.workspacePath)`（`chat.ts:296`）→ `isDirectChildOf(用户根, 路径)` 为真 → `mkdir` + 若无 `.git` 则 `new GitService(resolved).init()`（`TempWorkspaceService.ts:80-86`）。
- 可复现场景：用户把「保存位置」设成 `~/work`，同时有个**不是 git 仓库**的项目 `~/work/proj` 被当普通文件夹绑过一条对话。此后每次在这条对话里新建会话，Main 都会在 `~/work/proj` 里 `git init`，用户没做过这个动作也没有任何提示。
- 危害等级：不删文件、不越出用户自己选的目录，所以不判 blocking；但它把「app 自己创建的临时工作区」这条语义悄悄扩成了「所选根下任意直接子目录」。
- 建议的收窄（成本很低）：临时工作区的目录名是 `formatTimestamp` 产出的 `YYYYMMDD-HHMMSS[-n]`（`ipc/tempWorkspace.ts:123-140`），自愈时加一条名字形状判断，或要求索引行自己声明它是临时工作区，就能把「直接子目录」这条唯一判据补成两条。

**其他回归面**：

- `readSettingsState()` 只读 `aiclient-settings.state`，不碰 `MAIN_OWNED_SETTING_KEYS` 的顶层语义，渲染层无法借此影子覆盖 `credentialMode` 等 Main 自有键；类型不对一律回落 `{}` / `''`，不会把对象/数组当路径用。
- D6 新分支同时把 `bound.has(id) → nextBound.add(id)` 带上了，与「工作区命中」分支一致，不会让 store 忘记这条会话还连着 worker。
- D6 新分支只「保留」，不改 `workspaceId`、不改 `updatedAt`，不会污染排序。

**已知未修、记录在案**（note 2）：`useSyncChatWorkspaceTree.ts:108-110` 的 `!preferred` 早退在工作区树为空时返回 `sessions: []`，把未绑定会话一起清空。同一缺陷类、不同触发路径，T060 记录 §5 明确列为遗留并写进了真机复验表（DEV-6-d）。我同意不在本条里修，但建议单开线索，别只留在落地记录里。

### ③ 用例是否钉住行为

读了断言，不是数数：

- `settingsTemporaryPath.test.ts` 用例 1 先钉**文件形状本身**（`Object.keys(file).sort()` 只能是 `['aiclient-settings','credentialMode']`、顶层 `defaultTemporaryPath` 必须 `undefined`），再断言两个服务都落到用户选的根。形状一旦回迁到顶层，这条会立刻说话——这是这组用例里最有价值的一条。
- 用例 2 故意把旧根设成默认根，所以前半段带着缺陷也过，真正分辨的是后半段（新根命中、旧根不再被认作临时根）。这个设计写在注释里，诚实。
- 用例 3 走真实的 `SETTINGS_WRITE` handler 制造未落盘的排队载荷，覆盖 `readSettings()` 的第二条分支（500 ms 防抖窗口），并且在 `advanceTimersByTimeAsync(600)` 之后再断言一次，落盘前后都钉住了。
- 用例 4/5 是回落分支，注释里说明了它们**在缺陷下也会通过**，没有把它们冒充成判据。
- `treeSyncPatch.test.ts` 五条里有两条是反向的：未发送草稿仍被收养进首选工作区（U22 不得被削弱）、工作区消失的真孤儿仍被丢弃（旧规则不得被削弱）。这两条比三条正向用例更重要。

反向验证可信：D13 把两处读法改回顶层读 → 8 条判红（新文件 3 + `tempWorkspaceRecovery` 5），两条回落用例按预期保持绿并解释了原因；D6 删掉新分支 → 恰好 3 条判红，另两条反向用例保持绿。红的条目名逐条列了，不是只有汇总数字。

**用例缺口**（note 3，不影响结论）：

- 没有恶意/畸形值的用例（`defaultTemporaryPath: 42`、`aiclient-settings` 是字符串、`state` 是数组）。`readStringSetting` 的实现能兜住，但行为没被钉住。
- 没有任何机制阻止第四个读者再写一遍顶层读法。见 ④。

### ④ 范围

基本不越界，有一处**名不副实**需要点出（note 4）：记录把 `readSettingsState()` 称作「唯一的解包入口」，但仓库里另外三处手写解包（`main/index.ts:336-341`、`main/index.ts:378-386`、`main/utils/shell.ts:118-122`）本次都没迁移。我核了这三处，它们的解包是**对的**，所以不迁移不产生新缺陷；但「统一入口」目前只是意愿，不是事实——D13 的复发门禁并不存在。建议要么顺手迁移这三处，要么加一条静态守卫（禁止 `readSettings()?.[...]` 直接取渲染层键），否则这条经验会随记录一起过期。

渲染层 basePath 传参逻辑（`App.tsx` / `useComposerTarget.ts`）确实没动，符合验收要求。

### ⑤ 注释

全英文，说清了「为什么」而不是复述代码，符合仓库既有风格（同文件里的 F2-a / U13 / main-aux-01 注释就是这个密度）。`readSettingsState` 的头注释直接写明「每台机器上都读到 undefined，而且是静默的」，这是后来人最需要的一句。`TEMPORARY_PATH_SETTING_KEY` 的注释里出现中文「保存位置」，那是引用界面文案，不算违反英文注释规范。长度偏长但与本文件其余部分一致。

---

## 三、T061 — 会话预算拒绝后 store 中毒（D1/D24）+ 附件名不落盘（D25）

### 结论：`pass-with-notes`

### ① 根因 vs 症状

**D1/D24 打在根因上，而且是两处一起修**：

1. `enqueue`（`store.ts:395-411`）原来 `this.tail = work.then(() => {})`，`work` 一 reject，`tail` 就永远是那个已 reject 的 promise，此后每次 `tail.then(operation)` 都不执行 operation、只带同一个错误 reject —— 同一个 store 实例从此只读。现在改成 `work.then(() => {}, error => { if (!isWriteRefusal(error)) throw error })`：尺寸拒绝只回给调用方，`tail` 复位成 resolved；真正的写失败（磁盘满、句柄失效）仍然毒化队列，session-06 的原意保住了。
2. 总预算从「只在队列内检查」提到队列外预检（`store.ts:351-364`），与单行网合并成一个 `writeRefusal(bytes)`，队列内外共用同一个函数——预检与精确检查按同样的理由拒同样的写。

「静默」那一半的排查尤其值得肯定：记录推翻了原判（「错误被吞在 appendMessage 的调用方」），实际链路是 `execute()` 第一句 `await session?.flush()` 撞上已 reject 的 `tail` 当场抛，抛点在 `startRun` 之前，所以没有 `message.started` 用户回声、时间线不开新回合；而错误文案与上一次逐字相同，肉眼无法与「红块一直挂在那儿」区分。我核了 `flush()` 就是 `return this.tail`（`store.ts:702-704`），修完之后它会 resolve，这一句正是 D24 的解锁点。这是查清了症状的成因、而不是绕开它。

**D25 也在根因上**：写入侧（`agent-loop/attachments.ts`）与回放侧（`agent-host/piSessionTimeline.ts`）各补一半，渲染层早就准备好了 `HistoryAttachment.name`。写点一个、读点一个，`JsonlSessionStore.history()` 就是 `projectPiSessionHistory(this.projection())`（`store.ts:489-491`），读者唯一，没有第二处要同步。

### ② 回归与安全洞

**预检与队列内兜底的竞态：没有危险竞态。** 预检读的 `this.bytes` 是队列已落盘的字节数，排队中未落盘的写还没计入，所以预检只会**更宽松**（漏放行），不会误拒；漏放行的那条到了队列里被精确检查拦下，而拦下之后队列不再中毒——两半正好互补。反方向（预检比队列严）不存在，因为 `this.bytes` 单调增，且 `ENTRY_OVERHEAD_BYTES = 256` 的注释已经把「宁可高估」写成了取舍。

**`writeFailure` / `close()` 语义**：拒绝不再进 `this.failure`，`close()` 与 `session-06` 的注释同步更新了。仓库里 `writeFailure` 的消费者只有测试（`session.test.ts:443` 钉的是 'disk full' 仍然毒化），没有生产代码依赖「尺寸拒绝会被latch」。

**`aiclientName` 是否漏到 provider wire：会漏，但只在一条 API 上，而且同类先例已存在。** 这一条是本次审阅里唯一被证伪的事实性论断，必须写下来：

- 记录与 `attachmentRider.ts` 的头注释都断言「pi-ai 的**每一个** provider adapter 都是重建 image block，未知键在边界上被丢掉」。这一条对 anthropic / openai-completions / openai-responses-shared / google-shared / bedrock / mistral / openrouter-images 成立（都按 `mimeType` + `data` 重建）。
- 但 `pi-messages` 这条 API 不重建：`node_modules/@earendil-works/pi-ai/dist/api/pi-messages.js:248-272` 直接 `payload = { model, context, options }` 然后 `JSON.stringify(payload)` 发出去，`context` 里的 message content 原样上线。本仓把它接成了一等公民：`src/runtime/plugins/model-adapter/binding.ts:70` 映射 `'pi-messages' → piMessagesApi`，`model-adapter/catalog.ts:66` 与 `src/shared/userProviders.ts:36` 都把它列为用户可选的 API。所以只要用户配了一个 `api: 'pi-messages'` 的 provider（Radius / 自建 pi 网关就是这个形状），附件文件名会随请求上线。
- 缓解事实（所以不判 blocking）：同目录既有先例 `internalMessage.ts` 的 `aiclientInternal` 挂在 message 上，走的是同一条路，今天已经在往 pi-messages 网关上发了——这不是本次引入的新风险类别，而是本次把它扩大到了 block 层。数据本身是用户自己的文件名，与它标注的那张图同行上线，隐私增量很小。
- 需要做的两件事（note 1）：① 把 `attachmentRider.ts` 那段「永远到不了 provider」的断言改成「除 `pi-messages` 外都不会」，否则这段注释会把下一个人骗过去，而它正是这个设计选择的全部理由；② 真机上用一个 `pi-messages` provider 发一张图，确认网关对 content block 里的未知键是忽略而不是 400——若是 400，这就从注释问题升级成「该 provider 下发图全挂」。这条在 T061 §七的真机复验表里没有。

**codec / `pi --session` 读者**：核过。`codec.ts` 的 `cliEntry` 对 message 是 `{ ...carried }` 原样带过（`codec.ts:310-318`），`message()` 校验只看 `role` / `timestamp` / `content` 是不是数组，不检查 block 内部形状，所以未知键既不被丢也不会让文件被判损坏。`attachmentNameOf` 对任何非字符串/空值回落 `undefined`，pi 自己写的 block 与 T061 之前写的 block 都会安静地退回「只有 media type」。这一条成立。

**长度/注入面**：`attachment.name` 来自渲染层 IPC，理论上可以很长，但它进的是同一条 JSON 行，预检按整行字节量，超了就是一次普通的 `session_entry_size_limit` 拒绝（而且现在拒绝不再中毒），不会造成损坏；渲染处是 React 文本节点，不存在注入面。

### ③ 用例是否钉住行为

这一组是三项里最扎实的：

- 用例 1 把「拒完还能写」钉成了四句：短消息 `resolves` **且文件确实变长**、该拒的第二次仍报同一个 `session_size_limit`、拒完还能再写、`writeFailure` 为 undefined 且 `flush()` resolve。「不是把预算拿掉，而是不再中毒」这层区分被写死了。
- 用例 3 是真正的预检用例：把 `io.appendFile` 卡住，并发发一条小的（排队）和一条只超总预算、不超单行网的 3 KB，断言 50 ms 内就拿到 `session_size_limit`，且 `appendFile` 只被调用 1 次。它还记录了调参过程——原来用 16 KB 会先被单行网拦住、隔离度不够，改成先写满 5 KB 再发 3 KB 才报出真正想看的失败。这是 §4「过程断言」的正确用法。
- 用例 5 走完整 `createRuntime` + `events.subscribe`，同时钉住三件事：被拒那次 `text` 为空（请求从没发给 provider）、事件流里恰好一条 `session.failed`、以及**只给 faux 一条响应**，所以「被拒的那次 provider 从没被调用」是被消耗计数反向证明的。随后第二次 run 成功、无 `session.failed`、`snapshot().messages` 正好 `['user','assistant']`。
- 用例 4（D25）断言的是 `[{kind,mediaType,name:'big-5mib.png'}, {…,'holiday.jpg'}]` 全等，顺带钉住实时侧 `preparePrompt().metadata` 一直是对的（那一半从没坏过），避免把没坏的那半当成修好的。

反向验证可信且诚实：A（只撤 `enqueue`）**全绿**，A+B 3 条红，B 2 条红，C 1 条红，三种组合都跑了并存档在 `/tmp/t032/fixes/t061-evidence/`，还按 `diff -u` 逐字复原。

**用例缺口（note 2）**：A 单独撤不判红这件事，记录解释成「预检到位后中毒代码够不着」，这个解释是对的，但它同时意味着 **`enqueue` 这一半没有任何用例覆盖**。而队列内拒绝在生产里仍然够得着：`appendCompaction` 走的是 deferred payload（函数形式），预检**按设计跳过**（`store.ts:353-360` 注释自己写明了），一旦将来某个 deferred 写入方的载荷不再受上游 256 KiB 的约束，走的就是「队列内拒绝」这条路。建议补一条用例：用 deferred 载荷触发队列内的 `session_size_limit`，再断言同一 store 仍可写。这条补上，两半才各有各的判据。

### ④ 范围

范围克制，且把没做的都写明了：D2 的两个 8 MiB 口径（归 T058）一个字没动、用例 2 把这条接缝继续钉在原处；会话级 `Session failed` 卡片被随后的 `session.status: idle` 覆盖这件事查清了但明确记为超范围；渲染层「一条消息最多 5 个附件」两侧无校验也只记不改。`agent-loop/index.ts` 的改动不属于本任务（见第一节表格）。

`src/shared/attachmentRider.ts` 放在 `src/shared` 的理由（生产者在 `src/runtime`、消费者在 `src/agent-host`，反向依赖会成环）成立，且照抄了同目录先例 `internalMessage.ts` 的形状。

### ⑤ 注释

全英文。`attachmentRider.ts` 的头注释按「这个洞是什么 / 为什么挂在 block 上 / 为什么对既有读者无害 / 代价 / 与决策 015 的关系」分节，是本组里写得最好的一份——**但它的第三节现在有一句是错的**（见 ②），必须改。`store.ts` 里被改写的四处注释（`ENTRY_OVERHEAD_BYTES`、`enqueue`、`writeFailure`、`close`）都把「旧说法为什么不再成立」写了进去，没有留下自相矛盾的旧注释，这一点做得对。

---

## 四、T064 — worker 启动失败时的用户输入与空壳索引行（D15）

### 结论：`blocking`（一条数据丢失回归；其余部分质量良好）

### ① 根因 vs 症状

两条都找对了根因，而且把原判做了修正：

- ①「消息被吞」其实**没丢**，它在 ↺ 按钮的 `retryable` 快照里，只是输入框空、时间线空，看不出来。记录据此把问题重新定性为**可发现性缺陷**而不是数据丢失，并指出握手失败这一类（模型不对、网关死了）恰恰最需要「改一下再发」而不是原样重放。这个判断我认同。
- ②「空壳索引行」的根因是 `recordCreated` 在 `workerManager.createSession` 之前执行且失败无回滚。记录还查清了**为什么不能推迟写行**：`commitIdentityIfMaterialized → bindRuntimeIdentity` 对没有索引行的会话 `throw`（`SessionIndexService.ts:391` 一带），`applyRuntimeEvent` 对没有行的会话直接 `return`。这是读码得出的结论，不是偏好，所以选「失败时删掉」是对的。

### ② 回归与安全洞

**索引行删除守卫：没有误删面，三层收窄。** 逐条核过：

1. 调用层：只有 `!indexedBefore`（这次调用之前索引里没有这一行）才删。`assertPiCompatibleIndexRow` 顺手把已经读到的行返回，不多读一次盘——这是个干净的改法。
2. 服务层六条形状守卫：`runtimeIdentity` / `piLeaf` / `legacyImport` / `archived` / 非空 `title` / `workspacePath` 已改，任一条都否决。
3. fork 行（T040）天然有 `runtimeIdentity` + 非空 `title`，且它是 `createForked` 先写的，所以调用层的 `indexedBefore` 也拦得住——双重覆盖。归档行、可 resume 的行同理。
4. 写盘沿用 T038 的 `flush()` + 失败回滚内存；`health.status === 'unreadable'` 时 `flush` 抛错 → 回滚 → 由调用点的 `.catch()` 只 warn，不覆盖用户在等的 spawn 错误。

**晚到的 `bindRuntimeIdentity` 不会撞上已删的行**：`WorkerManager.createSession` 的 catch 里 `retireAndDispose(entry, 'slot-dispose')` 先把 worker 收了（`WorkerManager.ts:985-989`），所以删行之后不会再有那个 worker 的身份提交。若身份**已经**提交成功后才抛，行上就有 `runtimeIdentity`，守卫否决。两个方向都封住了。

**`sessionNeverCreated` 的误触发面：不会漏到别的失败路径，但名字比事实强。**

- 只在 `preamble.action === 'create'` 的两个出口出现，`resume` / `ensureHost` 抛 / `chat.send` 被拒都不认领，wiring 用例还把「全文件恰好 2 次」钉死了。
- 但 `runCreateSequence` 的 `'fatal'` 有两个来源：新加的 dispatch catch（确实从未创建），以及等 `session.created` 期间 `fatalHostError` 命中（`ChatComposer.tsx:1770`）；`'timeout'` 则是 5 秒内没等到 `session.created`。后两种情况下 Main 侧**可能已经把会话建好了**，这个标志名义上就说了谎。
- 后果评估：即便说了谎也不会双发——这两个出口都在 `sendAndWait` 之前，`chat.send` 从未派发，所以「把载荷还回 composer」在语义上仍然安全。属于命名不精确，不属于安全洞。若要较真，改名为 `turnNeverDispatched` 更贴事实。

**blocking：`'restore-draft'` 在输入框非空时会把用户的文本和附件彻底丢掉。**

这是本次改动引入的**数据丢失回归**，路径明确、可复现：

1. `finalizeOutcome`（`ChatComposer.tsx:1431-1444`）拿到 `'restore-draft'` 后只调 `restoreDraftIfComposerEmpty(sessionId, committed)`，**不**调 `setRetryable(committed)`；
2. `restoreDraftIfComposerEmpty`（`ChatComposer.tsx:672-690`）第一件事是
   `if (valueRef.current.trim().length !== 0 || attachments.getLiveDraftCount() !== 0) return;`
   —— 输入框非空就**静默什么都不做**，连 provenance 标记都不写；
3. 于是这次失败之后：`retryable` 仍是 null（提交点 `setRetryable(null)` 清过，新分支不再武装），`canRetry` 为 false（`ChatComposer.tsx:1135-1137` 要求 `retryText || retryDrafts.length`），↺ 按钮不渲染；`origin` 是 `'direct'` / `'retry'` 时队列里没有 entry；`pendingAttemptId` 已被 `finalizeOutcome` 第一句清掉。**这份文本 + 附件在任何地方都不存在了。**

可复现的反例（DEV-4 原样重做，只多一步）：

> 起应用 → 把 `workerRpc.ts` 的协议版本改成 2 制造 bootstrap 失败 → 新建对话，输入一句话并挂一张图，点发送（输入框被清空）→ **在等待的 60 秒里在输入框里再打任意一个字**（哪怕一个「?」）→ 等超时。
> 期望（改动前）：↺ 按钮亮起，原文与附件都可一键恢复。
> 实际（改动后）：错误卡出现，↺ 不出现，原文与那张图都找不回来。

触发概率不低：输入框在发送期间**不禁用**（`disabled` 只透传父组件的 prop，与 `sending` 无关），而 bootstrap 超时窗口是 60 秒——现场点验代理当时就是「以为消息没了、重新打了一遍」，那正是这条路径的输入条件。

修法很小，且不破坏「唯一决策权威」这条不变量：让 `restoreDraftIfComposerEmpty` 返回它是否真的恢复了，`finalizeOutcome` 在它返回 false 时回落 `setRetryable(committed)`。这样「可见优先、不可见时也不丢」两个目标同时成立。顺带说一句，`'committed'` 那一支有同样的早退，但那条路径上文本已经作为用户气泡留在时间线里（注释里也是这么论证的），所以只有新增的这一支是净损失。

**其余回归面**：失败后 scratch 目录不随之 `release`（记录明确列为超范围，由启动扫描收尾）、`claimSessionForSender` 的认领也没释放——两者都是既有形态，不是本次引入。

### ③ 用例是否钉住行为

- `queueRelease.test.ts` 四条读下来是有效的：正向两条（direct / retry + flag → `'restore-draft'`）、**反向三条**（不带 flag、`flag: false`、以及 `release + flag` 仍是 `'none'`，即不产生第二份载荷）、再加一条「不得越过 `rejected`」的三出口矩阵。这四条钉的是判据本身，不是数量。
- `SessionIndexService.test.ts` 的否决矩阵是这一组里最有价值的：有 identity / 有 title / 已归档 / fork 行各一，全部 `false` **且断言四行都还在**；另加未知 sessionId、工作区已搬家、写盘失败时内存回滚（T038）。**缺口**：标题写的是「identity, leaf, title, archive, import」，但 `piLeaf` 与 `legacyImport` 两条守卫实际上没有用例走到（用 fork 行顶了「import」那格）。守卫方向是保守的（多否决而非多删除），所以不改结论，但标题与断言不符，建议要么补两行、要么改标题。
- `chatPiWorkerRouting.test.ts` 四条包含一条反向（spawn 成功 → 不删任何东西）和一条「清理自己失败也不掩盖 spawn 错误」，这两条正是 D15 修复的边界。
- `createFailureDraftWiring.test.ts` 是源码扫描而非行为断言，记录自己说明了原因（本仓 vitest 是 node env、只收 `*.test.ts`，`.tsx` 渲染不了），并沿用了既有范式 `forceTakeoverWiring.test.ts`。可接受，但要认清它的等级：它能证明「这行代码写在那儿」，不能证明「按下去会怎样」。**恰恰是本节 ② 那条 blocking，属于这类测试照不到的盲区**——`sessionNeverCreated: true` 确实出现两次、`restoreDraftIfComposerEmpty` 确实被调用，三条 wiring 用例全绿，而载荷仍然会丢。按 §16「手动点验只是补充」的反面读，这里恰好是「自动化只覆盖了接线、没覆盖行为」的样本。

反向验证可信：五组变异各判红一条具体断言（含行号与实际收到的值），复原后 `sha256sum -c` 四个源文件全 OK。途中还逮到一条真回归——最初用 `.catch()` 链式写法被 Biome 折行，把 `piModelWiring.test.ts` 靠 `indexOf('window.electronAPI.chat.createSession({')` 定位载荷的兄弟用例读成空串，改用 `try/catch` 后恢复，且没有去改别人的用例。这条处理得对。

### ④ 范围

范围克制：`decideFailureAffordance` 只加可选第三参数、默认 `{}`，旧调用零变化；没有全面改判 `'rejected' + 'direct'`（那会连 `session_busy` 耗尽、resume 失败、`chat.send` 被拒一起改掉）；`chat:createSession` 的错误没有像 `chat:send` 那样加 `withWorkerErrorCode` 前缀（不改错误形状）。明确未做的两条（失败时顺带 `scratchWorkspaceService.release`、历史遗留的那一行空壳）都写在记录里。

### ⑤ 注释

全英文，密度与文件其余部分一致。`queueRelease.ts` 里 `FailureAffordanceContext` 的头注释把「`'resend'` 不算错、只是看不见」这层区分写清楚了，是理解这次改判的关键。`chat.ts` catch 里那段「为什么行不能推迟写、为什么只删自己刚写的那一行」是后来人最需要的两句。`finalizeOutcome` 新参数上的一行注释（「the only extra fact any branch may state about its own death」）守住了「唯一决策权威」这条不变量的可读性。无冗余复述代码的注释。

---

## 五、落地前建议的动作（按优先级）

1. **T064（blocking）**：让 `restoreDraftIfComposerEmpty` 返回是否真的恢复，`finalizeOutcome` 在 false 时回落 `setRetryable(committed)`；补一条 `queueRelease` 级别或 store 级别的用例把「输入框非空时载荷仍有去处」钉住。
2. **T061（note 1）**：改正 `attachmentRider.ts` 头注释里「每一个 adapter 都重建」的断言（`pi-messages` 不重建，`api/pi-messages.js:248-272`），并在真机复验表里加一条：用 `pi-messages` provider 发一张带名字的图，确认网关不因未知键报错。
3. **T060（note 1）**：给 `adoptTempWorkspace` 的「直接子目录」判据补第二条（目录名形状 `YYYYMMDD-HHMMSS[-n]`，或要求索引行自陈），避免用户把保存位置设在项目父目录时对无 `.git` 的真实项目执行 `git init`。
4. **T061（note 2）**：补一条 deferred 载荷（`appendCompaction` 形式）触发队列内拒绝、随后仍可写的用例，给 `enqueue` 那一半自己的判据。
5. **T060（note 4）/ T064（用例缺口）**：迁移或守卫剩余三处手写解包；`removeUncommittedCreated` 的否决矩阵补 `piLeaf` / `legacyImport` 两行（或修正用例标题）。
6. **T060（note 2）**：把 `!preferred` 早退清空未绑定会话单列成线索条目，别只留在落地记录的「遗留」一节里。
