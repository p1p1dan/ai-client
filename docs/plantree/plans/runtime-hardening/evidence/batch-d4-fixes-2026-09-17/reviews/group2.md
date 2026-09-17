# 批次 D4 只读审阅 —— 第 2 组（T062 / T063 / T065）

- 审阅人：审阅代理（只读；未改文件、未跑测试、未起 Electron）
- 仓库 `/home/ai/code/ai-client`，分支 `feat/runtime-evolution`，基线 HEAD `b3d751e3`，工作区含批次 D4 未提交修补
- 依据：`docs/agent-project-engineering.md`（§4 过程断言 / §7 事故回归 / §12 先定验证再改 / 附录 B1）、落地记录 `/tmp/t032/fixes/T062.md` `T063.md` `T065.md`、缺陷原文 `defects-ledger.md` D3 / D19 / D12 / D18 / D17
- 结论速览：**T062 = pass-with-notes** · **T063 = pass-with-notes** · **T065 = blocking（1 条，可一行修）**

---

## T062 —— 模型目录两侧口径（D3）+ 模型缺失覆盖层按码触发（D19）

**结论：pass-with-notes**

### ① 是否针对根因

是，两条都打在根因上。

- **D3**：台账认定的根因是「选择器读磁盘 `models.json`，worker 拿的是 Main 用凭据库现组的内存目录」，即**输入文档不同**。改法把 `readPiModelCatalog()` 的输入换成 `resolveNativeModelCatalog()`（`index.ts:229`），正是 `WorkerManager.ts:3147` 注入给 worker 的同一个装配器；拿不到时两侧同时回落读盘（`nativeCatalog.ts` 的三种 `undefined`）。这确实消灭了「磁盘有、凭据库没有」这一类分歧，也就是本机 `vllmproxy` 的形态。
- **D19**：根因定位准确且比台账建议更对。台账建议「把 `no model … in the catalog` 也纳入匹配」，那是继续匹配英文句子；落地改成**让码上路**——`RuntimeConfigError('model_not_in_catalog')` 的 `code` 本来就存在，只是 `AgentLoopPlugin.run()` 的 catch 只发 `error.message` 把它丢了。`thrownRunErrorText()` 按既有 `` `${code}: ${message}` `` 形状拼回去，渲染层加一个码常量即通。三个界面零改动即恢复，说明修的是缝而不是症状。

### ② 回归 / 安全洞（逐条回答你点名的疑点）

1. **「凭据库没 key 的 provider」在选择器里是否退化 —— 不退化。**
   `buildRuntimeConfig()`（`PiModelConfigService.ts:710`）决定 `models` 半边时，只跳过 `provider.enabled === false` 的用户服务；**key 为空并不影响它进 `models.providers`**，空 key 只落在 `auth` 半边。而新代码刻意只收 `models`（`RuntimeModelDocuments` 不含 `auth`），所以空钥 provider 照旧列得出。这也正是作者拒绝「把 `parsePiCatalog` 搬进 Main」的理由——那才会让这类 provider 从选择器里凭空消失。判断成立。
   **代价（残留，作者已明写）**：worker 侧 `parsePiCatalog` 的四条丢弃规则（`no_api_key` / `no_base_url` / `unknown_api` / `no_usable_model`）仍只在 runtime 执行，所以空钥 provider 依旧「列得出、发不出」。D3 只修掉了一半，另一半排在 T050 之后，理由充分但**必须在台账里留痕**，否则下一次点验会把同一现象当新缺陷再报一遍。
2. **回落读盘分支是否与 worker 一致 —— 目录一致，过滤不一致。**
   目录：`getActivePiAgentDir()` 直接 `return getAppPiAgentDir()`（`index.ts:119-121`），`resolveNativeModelCatalog` 也用 `getAppPiAgentDir()`，两侧同一个目录，不存在「选择器读 A 盘、worker 读 B 盘」。
   过滤：回落时选择器零过滤、worker 跑 `parsePiCatalog(dir)` 带四条丢弃规则；主分支（有文档）时 worker 同样对手上的文档再跑一次 `parsePiCatalog(dir:null)`。所以**两条分支都只做到「同一份输入」，没做到「同一套结论」**。与作者自述一致，不是隐瞒。
3. **错误码是否破坏其它消费者 —— 不破坏，但有文案副作用。**
   查过全部文本匹配器：`isModelMissingError` / `isAuthRequiredError` / `historyError` 系列一律用 `text.includes(...)`，前缀不影响；`WorkerManager.logNotableEvent` 只打印；store 只存 `lastError`。没有任何 `startsWith` / 全等消费者。**形状确实沿用既有 `errorPayload` / `encodePiResumeError`，不是新发明。**
   副作用：`thrownRunErrorText` 对**所有**带字符串 `code` 的抛出错误生效，不只这一条。于是 `catalog_empty: 模型目录为空…`、`agent_dir_unset: …`、`models_json_shape: …` 这些也都多了英文码前缀；Node 系统错误（`code: 'ENOENT'`，message 本身又以 `ENOENT:` 开头）会出现 `ENOENT: ENOENT: …` 的双前缀。这些文本会原样出现在失败卡/状态条里。DOMException 的 `code` 是数字，被 `typeof code === 'string'` 挡住，abort 路径不受影响。属可接受取舍，但值得记一笔。
4. **日志与读盘的小浪费**：`catalogEntries()` 在 `readCatalog` 开头无条件调用，而 `bundled` / `unavailable` 两个分支根本不用 `entries`——这两种状态下仍会多读一次 `models.json`，并可能打出一条误导性的 `models.json holds providers no session can use`（此时菜单根本来自内置快照）。建议把 `catalogEntries()` 下移到真正用到它的那一段之前。
5. **legacy / pi CLI 侧的一个口径缺角**：磁盘 `models.json` 仍是 pi CLI / 内嵌 TUI 的唯一入口，手写进去的 provider 对 pi **是可用的**，但现在 GUI 选择器不再列它。「对 TUI 无害」这句对「文件读者」成立，对「用 GUI 选一个模型交给 legacy 后端」不完全成立。考虑到应用自身写入口永远不会产出这种 provider、且下次改设置就会被覆盖，影响很小，记录即可。
6. `getPiModelSyncState()` 仍走磁盘口径（作者刻意保留）。后果是设置页的「模型数 / 服务商数」与选择器可能对不上同一个数——这是本次新引入的一处**界面内不一致**，建议在 T050 一并收口。

### ③ 用例是否钉住行为、反向验证是否可信

可信。

- 用例 1 同时钉了两件事：菜单内容 == 交给 worker 的那份文档，且**菜单 provider 集合 === 文档 provider 集合**（这是「两侧结论一致」少有的可断言形态，比只断言 id 列表强）。第一段还钉住了「不传文档时两个都列、日志为空」的回落语义。
- 用例 3 用 `toMatch(/^model_not_in_catalog: no model "gw\/gone" in the catalog \(/)` 钉「码在前、原句在后」，并断言 `session.failed` **只有一条**（防重复发事件）。
- 用例 4 的真值表最有价值的是两条否定：**同一句话去掉码不认**（钉死「码是信号、句子不是」）、`catalog_empty:` 不认（防止吃掉别的补救路径）。MMW-16 再从反面扫三个界面不得出现 `in the catalog`。§4「过程断言优先」执行到位。
- 反向验证做法正确（撤改动→指定用例红→复原→全绿），两组都给了数字。
- **缺口（轻）**：没有一条用例钉「错误**没有** `code` 时文本不被改写」。这条现在靠 `runtimeEvents.test.ts` / `sessionAttachmentFill.test.ts` 的既有断言间接护着，属隐式契约，建议在 `agentLoop.test.ts` 补一行显式断言。
- 源码扫描用例（nativeCatalog 两条、MMW-14/15）是整串精确匹配，改一个空格就红。本仓既有风格如此，接受，但它们是「接线守卫」不是行为断言，这一点注释里已写明。

### ④ 范围

未越界。9 个文件与记录一致，都在授权清单内。
**一处与任务书表述的出入**：任务书提到「`src/shared/types/ipc.ts` / `agentHost.ts` 里的错误码」，实际 **T062 没有在共享类型里新增任何错误码**（走的是既有文本形状）。这两个文件的在飞改动分别属于 T065（`AppCloseRequestReason` 加 `'close-window'`）与 NodeRuntimeResolver 移除（`NodeRuntimeInfo` 等被删，另一任务），与 T062 无关，分组提交时不要归到 T062 名下。

### ⑤ 注释

全英文，密度合适。`readCatalog` / `catalogEntries` / `thrownRunErrorText` / `MODEL_NOT_IN_CATALOG_CODE_TOKEN` 四处都写清了「为什么」而不是「做了什么」，并点名了缺陷编号与日期，符合本仓惯例。无中文注释、无冗余。

---

## T063 —— 兼容根子代理定义按来源文件编辑 / 删除（D12）

**结论：pass-with-notes**

### ① 是否针对根因

是。根因读码正确：合并规则「主目录 > 兼容根 > 内置」（`catalog.ts:78-89`）决定读，写路径却无条件 `mkdir(this.directory())` + `pathFor(name)`，于是编辑 = 复制，删除 = 删副本，原件按同一条合并规则带着旧内容浮回来。四时点真机快照与读码吻合。
改法把「扫盘」与「成视图」拆开（`scanUserDocuments()` / `view()`），让写路径拿得到视图丢掉的东西（来源文件、被遮住的同名副本），然后写回来源、删按名字清两个根。这是对根因的直接修复，不是补丁。
`view()` 是原 `read()` 逻辑原样搬入，去重 / broken / builtin / staleDisabled 行为不变——这一点我逐行比对过，确实是纯搬家。

### ② 回归 / 安全洞（逐条回答你点名的疑点）

1. **会不会写到用户没打算改的目录 —— 正常路径不会，有一个边角会。**
   正常：新建与「自定义内置」仍走 `pathFor(name)` 落主目录（用例 6/7 钉住）；编辑与改名留在来源根；`mkdir(dirname(target))` 只会创建已经存在的那个根的父目录，不会凭空造出 `~/.agents/subagents`。
   **边角**：`claimants` 取的是「声称这个名字的所有扫描项」，**包含解析失败的文档**（其 `name` 取自文件 stem，`normalizeSubagentName` 会剥掉 `.md`）。于是「兼容根里有一个坏掉的 `foo.md`」+「用户新建一个叫 `foo` 的定义」= 新定义被写进**兼容根**覆盖那个坏文件，而不是落主目录。重名校验拦不住它（`replacesUser` 只看 `rows`，坏文档不在 `rows` 里）。这未必是错的（它确实消灭了一个抢同名的文件），但与用例 6 给人的印象「新定义总是落主目录」不符，用例 6 只覆盖了「兼容根有**别的**名字」的情形。建议要么在 `source` 选择时排除 `!definition` 的候选（新建场景），要么补一条用例把这个行为写成有意的。
2. **删除两个根所有同名文件，会不会误删内置或用户其它文件 —— 内置绝对安全，用户文件有一个跨工具风险。**
   内置是内存文档（`BUILTIN_SUBAGENT_DOCUMENTS`），根本不在扫描结果里，删不到；`listDocuments` 只列两个根的**直接子文件**且 `\.md$` 过滤、不递归，删除范围封闭。用例 8 正面钉了「删 helper 不碰 theirs」。
   **风险**：`~/.agents/subagents` 是跨工具共享目录（与 `~/.agents/skills` 同层，pi TUI 等也读）。删除「被主目录影子遮住的那份兼容根文件」时，本应用的理由成立——它在本应用里没有行、runtime 永远不会加载它；但**别的工具可能正按自己的规则在用它**。而删除确认框仍是单数「This removes the definition file.」，用户不会知道一次删了两个文件、其中一个在共享目录里。作者在记录 §2 里已经认下这个代价，我同意可接受，但**建议把确认文案改成列出将要删除的路径/条数**——这比改一句单复数更实在，也顺手把跨工具这层说清楚。
3. **重命名语义 —— 正确，且顺手堵了一个旧洞。**
   新文件先落（崩溃时留重复而不是留空），再删掉**所有**声称旧名的文件且跳过刚写的 target；重命名写 `dirname(来源)/<新名>.md`，即留在原根不搬家。旧代码只删「列表那一行」的文件，被遮住的旧定义会在刚被改名走的名字下重新出现——这个洞一并堵上了。`carryEnablement` 未动，开关跟随语义无回归。
4. **「一次删除就是一次删除」有一处缝**：`listDocuments` 会**跳过**超过 `MAX_SUBAGENT_DOCUMENT_BYTES` 的文件和读取失败的文件（`continue` / `catch`）。这类同名文件不会进 `scanned`，因此删不到，行还会回来。改前也有这个盲区，不算新增回归，但「一次删除」这个承诺在这里不成立，值得在契约注释第 5 条里补半句。
5. 并发：`save()` / `remove()` 各自只扫一次盘再取视图，比改前少一次全量 `read()`；`concurrency-06`（保存不让重扫的 worker 看到半份文档）依赖的是 `writeDocument` 的原子写，未被触碰。

### ③ 用例是否钉住行为、反向验证是否可信

很扎实，是这一组里回归资产做得最好的一项。

- 用例 2 是 **DEV-3 原序列**（放 → 编辑 → 删一次 → 重扫），并且额外断言了 `broken` 为空与兼容根目录为空——把「行没了但文件还在」这种假绿挡掉了。符合 §7「任何修好的缺陷都变成永久回归用例」。
- 用例 3 直接模拟「已装过旧版本的用户磁盘上已有影子对」，这是真实升级路径，不是理想输入（§8）。
- 用例 5（文件 stem 与 frontmatter name 不一致仍写回原文件）钉的是本缺陷的一般形态，而不只是兼容根这一个实例。
- 反向三条（6/7/8）明确标注「改前改后都必须过」，用来证明修复没有越界——这正是越界检测该有的形态。
- 反向验证实跑记录可信：回滚到 HEAD 后 `5 failed | 3 passed`，1～5 全红、6～8 两侧都过，与「1～5 是判据、6～8 是窄度」的设计完全对应。
- **缺口（轻）**：没有用例覆盖「同名的**坏文件**是否被一起删」（记录里明确宣称了这个行为）；也没有覆盖上面 ②-1 的新建覆盖兼容根坏文件。两条都建议补，成本很低。

### ④ 范围

未越界，只动了 `subagentCatalog.ts` 与其测试两个文件。`src/main/ipc/piSubagents.ts` 只是转发、签名未变，确实无需改。
**流程提醒**：台账 D12 的处置栏写的是「需要产品决策再定修法（A/B/C 三选一）」。本次自行选了 A 并给出了有分量的论证（兼容根不是只读约束、`~/.agents/skills` 已被当写入目标、`roots()` 原注释本来就说「用户应当看到定义在哪」）。论证我认可，但这属于**决策而非实现细节**，应当在 plantree 里登记成一条 decision 并结掉 D12 的「待定」，否则下一任接手者读台账仍会以为没定。

### ⑤ 注释

全英文，模块头契约第 5 条写得准确（「An edit writes back to the file it came from」+ 删除按名字清两个根），`ScannedDocument`、`claimants` / `source` / `target` 三段核心注释都解释了「为什么不能只用视图」。无冗余。

---

## T065 —— TUI 双窗口互斥（D18）/ 恢复重绘（D17）/ 文案 i18n / 关窗确认文案

**结论：blocking**（仅 1 条，见下 ②-1；D17、i18n、关窗文案三部分本身通过）

### ① 是否针对根因

三条都对得上根因。

- **D18**：根因是「`PiTuiExclusiveGuard` 是进程级单例但 `transferTo` 无条件转移」+「真正持 PTY 的 controller 按 windowId 分家，互相看不见」+「`writer.lock` 是 GUI worker 的，pi 不拿」。新增 `PiTuiWindowSessionGuard`（按会话文件键、记归属窗口）是**唯一能回答这个问题的位置**，并且刻意不去改 `transferTo` 的「总是转移」——那条是被事故写进注释的既有决策。同窗口不拦、只拦跨窗口的取舍也正确（同窗口错配已有 terminal-03 兜底，严格互斥会误伤正常的终端重铸）。
- **D17**：根因是「`replayBuffer` 只累积挂起期间的输出，而挂起的 pi 空闲不产出」+「渲染层重建 xterm 回滚缓冲区为空」，接缝上没人负责重绘。修法在 resume 路径上发一次 `rows+1 → rows` 的抖动。**关键判断正确**：TTY 只在尺寸真的变化时才发 SIGWINCH，所以原有那句同尺寸 `#resizeNow` 是彻底的空操作——这正是缺陷能存在的原因。不自己发 SIGWINCH 也正确，符合附录 B1（不在生产路径新增 `process.kill`）且 Windows 没有 SIGWINCH。
- **轻项二**：协议里 `AppCloseRequestReason` 本来就有，只是 Main 恒发 `'quit-app'`、渲染层从不读。改法是「选一个 + 读一下」，方向对。

### ② 回归 / 安全洞

1. **【blocking】open 失败回滚是「过度释放」，会在 pi 仍活着时清掉真正的认领 —— D18 可复发。**

   代码路径（`src/main/ipc/piTui.ts`，open handler）：
   ```
   if (request.sessionFile) { transferTo(...); claim(sessionFile, windowId, terminalId); ... }
   try { return await controller.open(request); }
   catch (error) { if (request.sessionFile) windowSessionGuard.releaseTerminal(controller.windowId, request.terminalId); throw error; }
   ```
   而 `releaseTerminal(windowId, terminalId)`（`piTuiSession.ts`）的语义是**「这个终端死了」**：它遍历该窗口名下的**每一个**会话键，把该 terminalId 从每个键里摘掉，摘空就删键。用它来回滚一次「认领刚建立但 open 失败」的操作，就会连带摘掉同一个 terminalId **此前已经成立、且 PTY 仍然活着**的那份认领。

   具体触发：窗口 W 的终端 T 已在会话 A 上开着（键 A = {T}）。此后对同一个 terminalId T 发来一次 `sessionFile = B` 的 open —— 即 `#openExclusive` 的 terminal-03 分支，`requestedKey && requestedKey !== current.sessionKey` → `throw PI_TUI_SESSION_MISMATCH_REASON`。此时 claim 已把 T 记进键 B，catch 里的 `releaseTerminal(W, T)` 把 T 从键 A **和**键 B 一起摘掉：**会话 A 的认领消失，而 A 上的 `pi --session` 还在跑**。另一个窗口这时开 A 就不会被拒 —— 正是 D18 的原形态（一份 JSONL 两个 pi、静默分叉）。
   一个 chat 的 `runtimeIdentity` 在其 TUI 存活期间发生变化就会走到这条（本仓已知「pi 会话文件是懒写的、创建时给的路径只是预留」，以及 fork / 续聊换文件），terminal-03 本身就是因为真机上发生过才存在的守卫。

   修法（一行量级）：给 guard 加一个**按会话键定向**的释放，回滚只撤刚才那一次认领，例如
   `releaseClaim(sessionFile, windowId, terminalId)`（`normalizeSessionKey` 后只动这一个键），open 的 catch 改调它；`releaseTerminal` 保持现有的跨键语义，继续专供 `dead` 事件使用。
   另请补一条用例：**「一个终端在 A 上开着，同一 terminalId 以 B 再开被拒后，另一窗口仍然开不了 A」**——现有 9 + 5 条用例没有覆盖这条缝。

2. **认领 / 释放在其余退出路径上是成对的（这部分通过，逐条验过）。**
   - 自然退出：`pty.onExit` → `#emitState(…, 'dead')`（`PiTuiPty.ts:348`）。
   - 显式 dispose：`#disposeAndConfirm` **先摘 `#live` 再 emit `'dead'`**（:459），所以 `onExit` 的 early-return 不影响释放。
   - 容量淘汰 / `disposeAllSync`：都走 `#killNow` → `'dead'`（:471）。
   - 窗口关闭 / 崩溃：`MainWindow.ts` 的 `win.on('closed')` 调 `disposePiTuiWindow(win.id)`，而该函数把 `releaseWindow` 放在 early-return **之前**——这一点很关键，因为认领按窗口记而不是按 controller 记，作者注释里也写明了。
   - 另有 `PI_TUI_DISPOSE_ALL` → `releaseWindow`、`releaseSessionForHostPrompt` → `releaseSession`、应用退出 → `releaseAll`。
   「挂在 `onState` 的 `dead` 而不是 `onExit`」这个自查结论是对的，也是这条修复里最见功力的一处。
   测试替身同步做了对应处理（假 controller 的 `dispose` 也发 `dead`），避免了「认领泄漏从替身的缝里漏过去」。
3. **`transferTo` 已转移但 claim 被拒时不回滚**：拒绝发生在 `transferTo` 之后，于是进程级 `sessionGuard` 的 owner key 会停在一个从未 spawn 的会话上。后果有限（`releaseSessionForHostPrompt` 在 GUI 下一次写盘前会清），且 `controller.open` 抛错时改前也有同样形态，不算新增回归，但属同一类「先记账后可能失败」的脆弱点，建议与第 1 条一起收拾。
4. **`sessionSupport` 预检**：**没有**改变原有拒绝语义。它只在 `usePresentationSwitch` 切换入口被调用一次，`supported:false` 的唯一后果是弹一条 toast 并 `return`（不切界面），既不隐藏也不禁用 TUI 入口；原有「旧原生格式不可开」的返回形状 `{supported:false, reason}` 被原样复用。`ownerId()` 取不到窗口时 fail-open（返回原 support），对咨询性预检是正确方向。键也对得上：预检传的 `runtimeIdentity` 与 `ChatWorkspace.tsx:221` 给 open 的 `sessionFile` 同源，且两侧都过 `normalizeSessionKey`。
5. **resize 抖动在 Windows / 打包态**：`boundedDimension(value, minimum, fallback)` **没有上限**（`Math.max(minimum, floor(value))`），所以 `rows+1` 不会被夹回原值，抖动在任何尺寸下都真实成立——这是这条修复能否生效的关键，成立。`#resizeNow` 自带 try/catch，对已死 PTY 不会抛。`resize` 是 node-pty 跨平台 API（Windows 走 ConPTY 的 ResizePseudoConsole），不依赖 SIGWINCH。**残留风险是观感**：一次 resume 会连发三次 resize（原有一次 + 抖动两次），Windows/ConPTY 上的 reflow 比 Linux 明显，pi 的输入框位置、是否可见跳行，只有真机能判——作者已列入复验第 3 条，保留。
6. **关窗文案有一个方向相反的新错**：`BrowserWindow.getAllWindows()` 把 `browser_preview` 预览窗也算进去（`PreviewWindowManager` 建的是普通 BrowserWindow，`MainWindow.ts:532-544` 的注释本身就在讲这件事）。于是「一个主窗 + 一个预览窗」时关主窗会算出 `otherWindowsStayOpen = true`，弹「关闭这个窗口 / 应用会在你其他的窗口里继续运行」，可紧接着 `closed` 处理器发现剩下的全是预览窗就 `disposeAll()`，`window-all-closed` → `app.quit()`，**应用其实退了**。建议把判断改成「除自己以外还有没有**非预览**窗口」（可复用 `previewWindowManager.openCount`：`remaining.length > previewWindowManager.openCount`）。这条不做 blocking：净效果仍优于改前（改前 100% 说错），但它是本次改动引入的新错误分支，落地前顺手修掉成本极低。

### ③ 用例是否钉住行为、反向验证是否可信

- **D18**：`piTuiSession.test.ts` 9 条（含 `/private/var` 漂移、同窗口多终端不提前释放、跨窗口释放无效）+ `piTuiHandover.test.ts` 5 条走真 IPC handler。最有价值的是 `expect(open).not.toHaveBeenCalled()` —— 钉的是**没有 spawn**，而不只是「返回了错误」，这正是 §4 要的过程断言（判据问的就是「能否出现两个 `pi --session` 同一文件的进程」）。窄度三条（同窗口重复开 / 同窗口换 terminalId / 第二窗口开另一会话）都在。
  反向验证可信：拆掉 `if (!claimed.ok) throw` 后只有那一条红、其余全过，说明用例钉的是拦截本身。
  **缺口**：见 ②-1，缺「拒绝之后不得误伤已有认领」这一条；另外窗口 `closed` → `disposePiTuiWindow` 的释放只有代码没有用例（记录里也承认「真机没验过」）。
- **D17**：三条用例的形态选得很准——**以同尺寸挂起再恢复**（缺陷的精确形态，旧代码在这里必然是空操作），断言 PTY 收到 `[100,30] → [100,31] → [100,30]` 的精确序列；有回放内容时断言最后一次 resize 在回放之后（钉住顺序而不只是「调用过」）；反向那条（首次 spawn 不抖动，`resizes` 为空数组）在有无修复时都过，确实是窄度而不是自证。
  作者也诚实写明单测只能证明 resize 被调了两次，证明不了 pi 的观感。
- **i18n**：`piTuiSession.test.ts` 里那条词典守卫是本次最有方法论价值的一条——渲染层查的是**变量** key（`t(support.reason)`），仓库既有的 `i18nCoverage.test.ts` 只扫 `t('字面量')` 看不见它。删掉词条后守卫红、`i18nCoverage` 仍全过的实跑记录，正好证明了这条守卫非加不可。
- **关窗文案**：`closeConfirmCopy.test.ts` 把缺陷写成了断言（`expect(copy.description).not.toMatch(/exit the app/i)`），反向钉住最后一个窗口仍用退出文案、`replace-window` 与之相同，外加两条源码扫描（App.tsx 读了 `closeCopy`、MainWindow 按窗口数选 reason）。纯函数放 `.ts` 而不是写进 `App.tsx` 的三元，理由（本仓 vitest 只收 `.ts`）成立。
  **缺口**：没有任何用例覆盖 ②-6 的预览窗口情形——因为 `otherWindowsStayOpen` 的计算写在 `MainWindow.ts` 的闭包里、只能源码扫描。若采纳 ②-6 的修法，建议顺手把这段判断提成一个可测的纯函数。

### ④ 范围

T065 自身未越界（13 改 + 2 新增，与记录一致），但**三个文件是与别的任务共栖的**，分组提交时不能按文件名整块归属：
- `src/main/services/terminal/PiTuiPty.ts` 与 `__tests__/PiTuiPty.test.ts`：同时含 **T066** 的 spawn/exit 日志（`redactStderrLine` import、两处 console、`describe('PiTuiPtyController logging (T066)')`）。
- `src/shared/i18n.ts`：同时含 **T067** 的 D20/D21/D26/D9 四组词条。
- 记录 §5 已经点名 `chatPiWorkerRouting.test.ts` / `createFailureDraftWiring.test.ts` 属 T064，这一点做得对；上面三个文件建议按 hunk 拆。

### ⑤ 注释

全英文、简洁，且几处「为什么不这么做」写得尤其到位：`#requestRepaint` 解释了 SIGWINCH 只在尺寸真变时才发、以及为何不自己发信号（并点名附录 B1）；`windowSessionGuard` 解释了为什么不改 `PiTuiExclusiveGuard`；`onState` 那段解释了为什么释放挂在 `dead` 而不是 `onExit`。`closeConfirmCopy.ts` 解释了为什么单独开文件。无中文注释、无冗余。

---

## 收口建议（按优先级）

1. **T065 blocking**：把 open 失败的回滚改成按会话键定向释放，并补「拒绝之后不得误伤已有认领」的用例。
2. **T065 顺手修**：关窗 reason 排除预览窗口（`remaining.length > previewWindowManager.openCount` 或等价判断），并把判断提成可测纯函数。
3. **T063 流程**：把「选 A：按来源文件编辑 / 删除」登记为一条 decision 并结掉 D12 的「待定」；删除确认文案建议改为列出将删除的路径/条数。
4. **T063 用例**：补「同名坏文件一起删」与「新建时命中兼容根坏文件」两条。
5. **T062 台账**：把「只统一输入文档、未统一过滤规则」的残留显式挂到 T050 之后；`catalogEntries()` 下移以免在 bundled/unavailable 分支空跑并打误导日志。
6. 三项的真机复验清单（记录各自 §4 / §6 / §6）在上机前不要跳过，尤其 D19 的 GUI 中文覆盖层、D12 的 DEV-3 原序列、D18 的两窗口 argv 抓取与 D17 的抖动观感。
