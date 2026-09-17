# 批次 D4 九项修补（T060～T068）落地与复验证据

Role: evidence。日期：2026-09-17。仓库 `/home/ai/code/ai-client`，分支 `feat/runtime-evolution`，基线 HEAD `b3d751e3`。
**本批已提交**：代码 `d2bbbf13`、文档 `db8956a8`（2026-09-17）。任务身份与状态以 [roadmap](../../roadmap.md) 批次 D4 表为准，本目录只放事实与取证。

## 这一轮是怎么走完的

批次 D4 的九项修补来自 T032 开发机点验产出的 26 条疑似缺陷（台账 [defects-ledger.md](../batch-e-devbox-2026-09-17/defects-ledger.md)）。
落地之后走了「三组只读一审 → 回炉 → 二审 → 两轮真机复验」四道：

1. **落地**：九份实现记录在 [fixes/](fixes/)，每份都写了根因、方案取舍、改动文件与行、用例清单、反向验证（撤修判红、复原转绿）与「留给上机」的点。
2. **一审（三组，只读）**：
   - [reviews/group1.md](reviews/group1.md) —— T060 `pass-with-notes`、T061 `pass-with-notes`、**T064 `blocking`**；
   - [reviews/group2.md](reviews/group2.md) —— T062 `pass-with-notes`、T063 `pass-with-notes`、**T065 `blocking`**；
   - [reviews/group3.md](reviews/group3.md) —— T068 `pass`、T067 `pass-with-notes`、T066 `pass-with-notes`。
3. **回炉三轮**：**R-A**（T064 的 blocking + T062 真机判定的「半生效」）、**R-B**（T065 的 blocking + D17 重做 + 两条毛边）、**R-C**（T061 出网剥键、T066 三处脱敏与预算拒绝码、T067 接线用例）。
4. **二审（只读）**：[reviews/rework-1.md](reviews/rework-1.md) 判 R-A / R-B 均 `pass-with-notes`，两条 blocking 确认关闭；
   [reviews/rework-2.md](reviews/rework-2.md) 判 R-C 有**一条 blocking**（`CredentialVault.clearInternal()` 漏掉同一个明文回显），已按同法修好并补用例。
5. **真机复验两轮**（同一台 Linux 开发机，全程假网关）：
   - [reverify/round-1.md](reverify/round-1.md) —— 九项里 **7 项 ✅**、T062 半生效（码通了但中文卡没出、状态条是英文）、T065 的 D17 未生效（切回仍整屏空白）；
   - [reverify/round-2.md](reverify/round-2.md) —— 六项判据里 **5 项完全成立**，D17 从「稳定故障」变成「27 次切换里 1 次仍空白（约 4%）」。

截图与读数分别在 [reverify/dev-D4-reverify/](reverify/dev-D4-reverify/)（第一轮，带自己的 README）与 [reverify/dev-D4-reverify-2/](reverify/dev-D4-reverify-2/)（第二轮）。
两份复验正文里写的 `batch-e-devbox-2026-09-17/dev-D4-reverify…` 是这两个目录被搬进本目录之前的旧路径，实物以本目录为准。

**收口验证**（2026-09-17，Linux 开发机，Electron 全部退出后跑，存档 [closeout-verification.txt](closeout-verification.txt)）：三套 tsc（根 / runtime / agent-host）退出 0；Biome 检查 98 个改动与新增源文件无问题；全量 Vitest `pnpm test -- --no-file-parallelism` **420 文件 / 6434 条全部通过，退出码 0，209 s**（对比 D4 前 T032 收口 413 / 6271：+7 文件、+163 条，全部为 D4 新增用例）。

---

## T060 —— 临时根设置读不到 + 未绑定会话运行中消失

- **缺陷**：D13（high）、D6。实现记录 [fixes/T060.md](fixes/T060.md)。
- **根因一句**：`readSettings()` 返回的是 settings.json 的**顶层**，而用户在设置页改的每个字段都在下一层 `aiclient-settings.state` 里（渲染层用 zustand `persist` 落盘），两个服务恒读到 `undefined`；D6 是另一条根——`rebindSessionsToTree` 缺一条「未绑定会话」分支，而重启路径 `mergeSessionIndex` 有，于是跑过一轮的临时对话在工作区树一变就被当孤儿丢出 store。
- **改动要点**：解包收进 `src/main/ipc/settings.ts` 的 `readSettingsState()` / `readStringSetting()`，键名常量只写一处，Scratch 与 Temp 两个服务改用它；渲染层 `useSyncChatWorkspaceTree.ts` 在「孤儿」规则**之前**插一条未绑定分支。共 7 个文件。
- **用例 / 反向验证**：新建 `settingsTemporaryPath.test.ts` 5 条（第 1 条钉住**文件形状本身**）、`tempWorkspaceRecovery.test.ts` 把 mock 下沉一层让真实解包也跑、`treeSyncPatch.test.ts` +5 条（其中 2 条是反向臂）。反向验证 2 组：改回顶层读 → 8 条判红；删掉 D6 新分支 → 3 条判红。
- **一审**：`pass-with-notes`。notes——① `adoptTempWorkspace` 的「所选根的直接子目录」判据在 D13 修好后作用域放大，可能对用户真实项目执行 `git init`（转 [Q018](../../open-questions.md)）；② `!preferred` 早退在工作区树为空时仍会清空未绑定会话，同类不同路径；③ 没有畸形值用例；④「统一入口」目前只是意愿，另三处手写解包未迁移也没有守卫。
- **回炉**：无（未判 blocking）。
- **复验**：✅ 成立（[round-1 一](reverify/round-1.md)）。改设置后 1 分钟内新建的临时对话落在**新根**、旧根一个子目录都没有；重启后索引行 `workspacePath` 指向新根；移除一个仓库让工作区树签名变化后，16 条未绑定会话一条没少。

## T061 —— 预算拒绝后 store 中毒 + 附件名不落盘

- **缺陷**：D1、D24（high）、D25。实现记录 [fixes/T061.md](fixes/T061.md)。
- **根因一句**：总预算只在写队列**内部**检查，一次拒绝让 `this.tail` 永远是那个已 reject 的 promise，同一个 store 从此只读；而 `execute()` 第一句 `await session.flush()` 正好撞上它当场抛，抛点在 `startRun` 之前，所以时间线连一条错误回合都不开——这就是真机看到的「点了没反应」。D25 则是落盘的 image block 只有 `{type,data,mimeType}`，文件名从不落盘。
- **改动要点**：总预算提到队列外预检、与单行网合并成共用的 `writeRefusal()`；`enqueue` 改成尺寸拒绝只回给调用方、`tail` 复位（真正的写失败照旧毒化队列）；新建 `src/shared/attachmentRider.ts`，在 image block 上挂带命名空间的 `aiclientName`，回放侧 `piSessionTimeline.ts` 读回。
- **用例 / 反向验证**：`sessionAttachmentFill.test.ts` 5 条（2 改 3 新，含「被拒后还能写」「预检不进队列」「拒绝确实作为 `session.failed` 回到渲染层」）。反向验证 **4 组**（A 只撤 `enqueue` 全绿、A+B 3 红、B 2 红、C 1 红），三种组合都跑了并存档在 [fixes/t061-evidence/](fixes/t061-evidence/)。
- **一审**：`pass-with-notes`。notes——① 记录里「每个 provider adapter 都会重建 block 丢掉未知键」被**证伪**：`pi-messages` 原样 `JSON.stringify` 发出，而本仓把它列为用户可选，rider 会随请求上线；② `enqueue` 那一半没有任何用例（deferred 载荷走的正是队列内拒绝那条路）。
- **回炉（R-C）**：把「上线看不见」从 adapter 的性质改成本仓自己保证的性质——新建 `src/shared/aiclientKeys.ts`（`isAiclientKey` + 结构共享的 `stripAiclientKeys`），在 `ModelAdapterPlugin.register()`（三条 provider 装配路径的唯一汇合点）用 Proxy 包住四个吃 `Context` 的调用；新建 `providerWireNamespace.test.ts` 7 条，用真 adapter + recordingFetch 读**请求体本身**；1 组反向验证只判红 `pi-messages` 那条。
- **二审**：[rework-2](reviews/rework-2.md) ① 判 R-C 这一项质量良好（包装点覆盖三条路、剥键不改落盘对象、性能在噪声里），只留一条措辞 note。
- **复验**：✅ 成立（两轮）。[round-1 二](reverify/round-1.md)：4 条顶到 31.958 MiB、第 5 条被拒后红块仍在，清掉附件发纯文本**成功**（网关计数 5→6、文件 +926 B），重开后 `big-5mib.png` ×4 / `small-1mib.png` ×4、`image/png` 出现 0 次。[round-2 五](reverify/round-2.md)：在 `pi-messages`（不替你丢键的那个 adapter）上取证——落盘 block 键集合含 `aiclientName`，295 KB 请求体里 `aiclient` 与文件名各出现 **0 次**。

## T062 —— 模型目录两侧口径 + 模型缺失中文覆盖层

- **缺陷**：D3、D19（medium）。实现记录 [fixes/T062.md](fixes/T062.md)。
- **根因一句**：D3 是选择器读磁盘 `models.json`、worker 拿的是 Main 用凭据库现组的内存目录，**输入文档就不是同一份**；D19 是 `isModelMissingError` 认的两个信号在会话路径上早已没有生产抛出点，而 `run()` 的 catch 发 `session.failed` 时只带 `error.message`、把现成的 `error.code` 丢了。
- **改动要点**：`readPiModelCatalog()` 改吃 `resolveNativeModelCatalog()`（worker 拿的同一个装配器），拿不到时两侧一起回落读盘，「磁盘有、运行时没有」的 provider 记一行诊断；runtime 侧 `thrownRunErrorText()` 按既有 `code: message` 形状把码拼进 `session.failed`；渲染层新增 `MODEL_NOT_IN_CATALOG_CODE_TOKEN` 并入判据。共 9 个文件。
- **用例 / 反向验证**：5 组用例（目录菜单 == 交给 worker 的那份文档、两条源码接线守卫、码在前原句在后、`isModelMissingError` 真值表 ±2、MMW-14/15/16）；反向验证 4 组。
- **一审**：`pass-with-notes`。notes——① 只统一了输入文档、没统一过滤规则，「列得出、发不出」的第二类分歧仍可能出现（残留挂 T050）；② `thrownRunErrorText` 对**所有**带字符串 `code` 的抛出生效，会出现 `ENOENT: ENOENT: …` 这种双前缀；③ `catalogEntries()` 在 bundled / unavailable 分支空跑并可能打误导日志；④ `getPiModelSyncState()` 仍是磁盘口径，与选择器可能对不上同一个数；⑤ 缺一条「没有 code 时文本不被改写」的显式断言。
- **回炉（R-A）**：真机判「半生效」后先查清三个渲染点各自差什么——时间线那张 `Session failed` 卡因为 `session.status: idle` 紧跟覆盖而**对所有失败类都活不过一次渲染**，错误气泡要求时间线里有 `role:'error'` 的消息，`HistoryErrorNotice` 只管历史读失败。发送失败这条路上唯一耐用的信号是 `lastError`，于是新建 `ModelMissingNotice.tsx`（四段全走 `t()`）挂在 composer 上方的 `'error-notice'` 位，状态条补 `t()`；新增 1 条**真渲染**用例（happy-dom + 真 zh 翻译器）与 MMW-17～20；3 组反向验证。
- **二审**：[rework-1 ③](reviews/rework-1.md) 逐条查了三个覆盖层的门，确认不会同时出现两张；note——WorkerManager 崩溃合成的 `session.failed` 没有 idle 补位，是今天唯一能让时间线那张卡活下来的路径；新卡按钮 `size="xs"` 与时间线同类卡 `size="sm"` 档位不一致。
- **复验**：⚠️ → ✅。[round-1 三](reverify/round-1.md)：D3 成立（选择器只剩 `probe-fake/fake-sonnet`，与 worker 报的「(1 available)」一致，诊断行落进按天日志），D19 半生效（码到了渲染层，但中文卡没出、状态条打印的是英文词典键）。[round-2 三](reverify/round-2.md)：✅ 完全成立——四段全中文、卡内保留 runtime 原始诊断、页面上只有这一张 alert、老的红色等宽框 0 次、按钮点了跳「设置 · Pi」；反向不削弱（bootstrap 超时那条路仍是原来的红框）。

## T063 —— 兼容根子代理定义「编辑后删不掉」

- **缺陷**：D12（medium）。实现记录 [fixes/T063.md](fixes/T063.md)，方案登记为[决策 017](../../decisions/017-subagent-definitions-edit-at-source-root.md)。
- **根因一句**：读按「主目录 > 兼容根 > 内置」合并，写却无条件落主目录——编辑等于复制一份副本再改，删除只删得到那份副本，兼容根原件按同一条合并规则带着**编辑前的旧内容**浮回来。
- **改动要点**：把「扫盘」与「成视图」拆开（`scanUserDocuments()` / `view()`），让写路径拿得到视图丢掉的东西（来源文件、被遮住的同名副本）；编辑写回来源文件、重命名留在原根、删除按名字清掉两个根里所有同名文档。`subagentCatalog.ts` +111/−29。
- **用例 / 反向验证**：8 条（1～5 是 D12 的判据、6～8 是「修复没有越界」的反向臂，含真实兼容根目录与文件）。反向验证 1 组：回滚到 HEAD 后 `5 failed | 3 passed`，与设计完全对应。
- **一审**：`pass-with-notes`。notes——① 新建定义时若兼容根已有同名的**解析失败**坏文件，新定义会被写进兼容根而不是落主目录；② 删除会动跨工具共享的 `~/.agents`，而确认框仍是单数文案；③ 超过大小上限或读不动的同名文件进不了扫描结果，删不到、行还会回来（改前就有的盲区）；④ 选 A 属决策而非实现细节，应登记 decision（已补决策 017）；⑤ 缺「同名坏文件一起删」「新建命中坏文件」两条用例。
- **回炉**：无。
- **复验**：✅ 成立，是这批里最干净的一项（[round-1 四](reverify/round-1.md)）。四个时点：t1 兼容根**原地改**（md5 变、内容 EDITED），主目录**始终不存在**同名文件（旧版本这里会多出 207 B 影子）；t2 点**一次**删除该行立即消失、目录空；t3 重启后没有回来。

## T064 —— worker bootstrap 失败后的用户输入与空壳索引行

- **缺陷**：D15（medium）。实现记录 [fixes/T064.md](fixes/T064.md)。
- **根因一句**：用户那条消息其实没丢，它在 ↺ 按钮的 `retryable` 快照里——输入框空、时间线空，看不出来而已，属可发现性缺陷；另一半是 `recordCreated` 在 `workerManager.createSession` **之前**执行且失败无回滚，留下一行 `title=""` 的空壳。
- **改动要点**：给 `decideFailureAffordance` 加一个只有 create 分支说得出口的事实 `sessionNeverCreated`，把这一类改判 `'restore-draft'`（载荷只搬家不复制）；create 的 dispatch 就地 `try/catch`；Main 侧新增 `removeUncommittedCreated()`，六条形状守卫 + 只删「这次调用之前索引里没有的那一行」。
- **用例 / 反向验证**：15 条（queueRelease 4、createFailureDraftWiring 3、SessionIndexService 4 含否决矩阵、chatPiWorkerRouting 4 含反向）；反向验证 5 组，复原后 `sha256sum -c` 四个源文件全 OK。
- **一审**：**`blocking`** —— `'restore-draft'` 只是一条指令：`restoreDraftIfComposerEmpty` 在输入框非空时按设计静默拒绝，而本次同时撤掉了这条路上的 ↺ 武装，于是拒绝之后文本与附件**在任何 store 里都不存在了**。发送期间输入框不禁用、bootstrap 窗口 60 秒，打一个字就复现。
- **回炉（R-A）**：让恢复函数返回它到底有没有生效，新增纯函数 `decideDeclinedRestore()`，拒绝时回落 `'resend'`（武装 ↺，载荷即原来那份快照），回落判断仍留在唯一权威里；+6 条用例（含「载荷必有去处」这条不变量）、2 组反向验证。
- **二审**：[rework-1 ①](reviews/rework-1.md) 逐段走码确认 blocking 关闭，并补查 `addDrafts` 无容量裁剪、另一半也不丢；note——「restore 拒绝 → ↺ 被武装」这条接缝没有可执行用例，上机正反两条**不能只做一条**。
- **复验**：✅ 成立（两轮，正反都做）。[round-1 五](reverify/round-1.md)：输入框里那句话与附件都回来了、右下角没有 ↺、索引行 177→177 不增。[round-2 四](reverify/round-2.md)：等待期间再打一个字 → 用户的字不被覆盖、↺ 出现且 `aria-label` 带附件计数，把常量改回后点 ↺ **端到端重发成功**（假网关落盘的请求体里原文与那张图都在）；反向那一半（全程不碰输入框）仍是原文回输入框、无 ↺。

## T065 —— 跨窗口同会话互斥 / 挂起恢复重绘 / 两条轻项

- **缺陷**：D18、D17（medium）+ 两条轻项（TUI 英文 toast、关第二个窗口弹整应用退出）。实现记录 [fixes/T065.md](fixes/T065.md)。
- **根因一句**：D18 是三件事叠加——`PiTuiExclusiveGuard` 从设计上就不拒绝任何人、真正持 PTY 的 controller 按 windowId 分家互相看不见、pi 从不拿 GUI worker 的 `writer.lock`，没人知道别的窗口在干什么；D17 是 `replayBuffer` 只累积挂起期间的输出而挂起的 pi 空闲不产出，渲染层新 xterm 缓冲又是空的，接缝上没人负责重绘。
- **改动要点**：新增 `PiTuiWindowSessionGuard`（按会话文件键记归属窗口）+ 一条咨询性 pre-flight，释放统一挂在 `onState` 的 `dead`（唯一所有停止路径都会经过的缝）；`PiTuiPty` 在 resume 时做尺寸抖动；两条 toast 与四条拒绝原因走 `t()`；关窗按「除自己以外还有没有活着的窗口」选 reason，文案抽成纯函数 `closeConfirmCopy.ts`。
- **用例 / 反向验证**：首轮约 25 条（guard 9、真 IPC handler 5、重绘 3、i18n 3、关窗 5），最有价值的是 `expect(open).not.toHaveBeenCalled()`——钉的是**没有 spawn**；反向验证 3 组 + 窄度。
- **一审**：**`blocking`** —— open 失败的回滚用了 `releaseTerminal`，它的语义是「这个终端死了」，会遍历该窗口名下每一个会话键，于是 terminal-03 那条路上会连带清掉**同一 terminalId 上此前已成立、pi 仍在跑**的那把认领，D18 原形态可复发。另一条顺手修：`getAllWindows()` 把预览窗也算进去，关窗文案会做出与事实相反的承诺。
- **回炉（R-B）**：新增 `releaseClaim()`（`normalizeSessionKey` 后只动这一个键、且归属窗口对得上才动），`releaseTerminal` 的跨键语义原样留给 `dead`；D17 的触发点重写——`#primeRepaint` 把 PTY **留在** `rows-1`，由渲染层 attach 完成后的 `confirmPiTuiSize` 补真实尺寸，让子进程可观测到两次真实跃迁而不是净变化为零；新增 `piTuiOpenError.ts` 通用剥壳把被拒绝的 open 走同一条中文 toast；新增纯函数 `closeRequestReason.ts` 排除预览窗。+20 条用例、4 组反向验证。
- **二审**：[rework-1 R-B](reviews/rework-1.md) 确认 blocking 关闭（并补查「`#spawn` 之后到 `#openExclusive` 返回之间没有任何 throw」这条前提）；notes——D17 是**时序概率**不是逻辑保证；Windows/ConPTY 上三次 resize 的 reflow 观感待跨平台点验；通用剥壳让内部错误串也开始以英文 toast 弹给用户。
- **复验**：⚠️ → 基本成立。[round-1 六](reverify/round-1.md)：D18 ✅（窗口二弹中文 toast、界面不切、`/proc` 里始终只有一个 pi），关窗文案 ✅，**D17 ✗ 未生效**（两个方向都整屏空白，`live` 之后只回流 10 字节）。[round-2 一 / 二](reverify/round-2.md)：D18 ✅ 全过（含「窗口二进来就是 TUI 模式点 Start Pi TUI」这条上一轮零提示的路、terminal-03 过度释放的反向验证、预览窗三种关窗文案）；D17 **27 次真实切换里 26 次整屏重绘（15 KB 量级、非空行 22、标记正确），剩 1 次仍只回 11 字节（约 4%）**——与回炉自己预告的概率边界同一形态，未能找到更细的触发条件。

## T066 —— 可观测性：按天日志里一行都没有

- **缺陷**：D4、D10、D14（low）+ 三条轻项（pi TUI spawn/退出、`provider_retry`、预算拒绝）。实现记录 [fixes/T066.md](fixes/T066.md)。
- **根因一句**：electron-log 没吞任何东西——是本仓在日志开关关闭时把两个 transport 都钉成了 `error`，而这个开关**出厂默认是关的**；另有两个可注入的 log sink 在生产单例里根本没接（默认 no-op）。顺带澄清：`main.log` 不是主日志，要看的是 `logs/aiclient-<date>.log`。
- **改动要点**：开关关闭时 file 档降到 `info`、console 留 `warn`（文件是运维记录、终端是开发视图）；补 13 个「一次一行」的日志点（索引修复、导入起止与每条失败、归档三步、provider 重试、turn failed、pi TUI spawn 与退出码），一律复用 T042 的脱敏。
- **用例 / 反向验证**：19 条覆盖 7 个文件，每组都带反向臂（含「普通 running/completed 一行不打」这种负向控制）；反向验证 5 组，判红方式各不相同。
- **一审**：`pass-with-notes`，但那条注记建议提交前处理——门槛下降把约 85 个既有 `console.warn` 与 22 个 info 一并**提拔**到落盘级别，而这批从来没过 T042 脱敏。点名三条路径：`CredentialVault.ts`（`JSON.parse` 的 `SyntaxError` 会回显文件原文片段，而保险库存在 `enc:'none'` 明文形态）、`src/main/index.ts` 的 `[local-image]`（每渲染一张图两行裸绝对路径）、`ScratchWorkspaceService.ts` 的失败行（第二个参数 `error` 原样，且对应用例只断言第一个参数，结构上抓不到）。
- **回炉（R-C）**：三处全改（`parseFailureNote` 只留错误类型 + 字节数 / `[local-image]` 降 `debug` / 失败行合成单参数并过 `describeError` + 脱敏，断言改成「参数个数必须为 1 + join 全部参数」）；另补一条真机逮到的毛边——预算拒绝那行没有码，于是让 `projector.finish()` 把 `errorCode` **并排**发出（不塞进正文），日志行有码且正文未以该码开头时才前缀。+7 条用例、2 组反向验证。
- **二审**：[rework-2 ②](reviews/rework-2.md) 判**一条 blocking（一行）**——`clearInternal()` 里同一个 `JSON.parse` 的 catch 仍原样打 `SyntaxError`，登出这条更常走的路会把明文碎片带进日志。已按同法改成单参数 `parseFailureNote` 并补一条走 `clear()` 的用例（`CredentialVault.test.ts` 31 passed）。
- **复验**：✅ 成立（两轮）。[round-1 七](reverify/round-1.md)：五类各拿到一行，全部落在按天日志里，同期 `main.log` 只多了启动那条（与设计一致）；毛边是预算拒绝那行当时**没带码**。[round-2 六](reverify/round-2.md)：带码那行成立（`turn failed: session_size_limit: …`，另一形态 `attachment_size_limit:` 不重复印码）；保险库解析错误只报 `SyntaxError, 44 bytes read`，整段日志 grep `sk-ant` / `SECRET` / `plaintext` = 0；scratch 删除失败行一条 warn、一个参数、路径全折成 `~`，grep `/home/ai` = 0。

## T067 —— i18n 补漏包

- **缺陷**：D9、D20、D21、D26（low）。实现记录 [fixes/T067.md](fixes/T067.md)。
- **根因一句**：这四条的共同点不是措辞不好，而是这些界面**根本没问过词典**。
- **改动要点**：统一成「固定文案变词典键、渲染处过 `t()`、带数值用 `{{占位符}}`」。问答卡五个常量改键；重试横幅拆成**四个键**（次数在英文里卡句中、在中文里落句末，中文接不了「中间挖洞」的英文句）；导入失败由 Main 发 `errorCode` + `errorParams`、渲染层出中文并把 `67108864` 说成 `64 MiB`（只给两个可补救的码，其余失败继续走原文）；附件六句连同同一条折叠提示里的邻居句一起译（17 条词条）。
- **用例 / 反向验证**：约 23 条（真 DOM 渲染守卫 2、词典表侧守卫 1、重试 3、导入 7+2、附件 4+4）；反向验证的主形态是「不传 `t` 时逐字节英文不变」+ 旧的 126/15/21/27 条英文断言全绿未改。
- **一审**：`pass-with-notes`。逐条验过词典无重复键（2333 条键 2333 个唯一值）、占位符齐全、既有消费者不破。notes——① Main 侧 `failureFields()` 的 `instanceof` 接线**一条断言都没有**，它静默失效时 D9 会原样复发而全部现有用例仍绿；② `ChatComposer.tsx` 那一行接线全仓没有测试能覆盖（没有任何测试 import 该文件），只能靠真机复拍。
- **回炉（R-C）**：**只补用例、没改生产代码**——`LegacyImportService.test.ts` +4 条走 IPC handler 实际调用的那个方法，`ipc/legacyImport.test.ts` +1 条挡「日后有人给响应加 schema 校验剥掉未知字段」；1 组反向验证（删掉 `instanceof` 分支 → 2 条红，两条反向臂保持绿）。
- **二审**：[rework-2 ④](reviews/rework-2.md) 确认 IPC 那条真的过了主进程侧边界；note——preload → 渲染层那两跳仍无覆盖，记录措辞略高于实际覆盖。
- **复验**：✅ 成立（[round-1 八](reverify/round-1.md)）。问答卡整片中文、重试横幅「上游返回错误 503 · 正在重试 2/3 · 本回合仍在进行」+「详情」、导入失败两句含「64 MiB」与下一步、附件四句拒绝全中文，连原先列为「遗留」的附件总量提示也已是「附件合计 6.0 MB，发送可能会慢一些。」。英文原文仍完整落在日志里供排查。

## T068 —— 死代码删除 / header chip / 卡片字重

- **缺陷**：D16、D22、D23（low）。实现记录 [fixes/T068.md](fixes/T068.md)。
- **根因一句**：D16 的 Node 24 解析器自 `8dadf598` 起就零生产调用方，但 `dev.env` 与四处注释还在承诺它；D22 的 `QuestionItem.header` 声明了却全链路无人渲染；D23 的两张卡的标题层级全靠 `font-medium`(500)，而 Win10 的 Segoe UI 静态族没有 500 档、CSS 会降到 400。
- **改动要点**：删整文件 `NodeRuntimeResolver.ts` 及其单测、三个类型、渲染层一个函数与其用例，四处注释同步改成与代码相符；问答卡在问题正文正上方渲染 header chip（形制照抄同文件权限卡的风险徽标，不引入新档位）；五处字重改 `font-semibold` / 选项描述补 `font-normal`。
- **用例 / 反向验证**：1 条新用例（happy-dom，class 断言），四组断言 + **一条真正的负向控制**（选项按钮仍含 `font-medium` 且不含 `font-semibold`，挡「全局扫一遍字重」的过修）；反向验证 4 次改回各判红一条不同消息，复原后与备份逐字节一致。D16 是删除型修补，验收靠 `git grep` 残留为零 + 三套 tsc + 原用例仍绿。
- **一审**：**`pass`**（三项里唯一一个无 notes 的 pass）。审阅独立复核了「确无生产调用方」与「打包态 Windows 随包 node 路径不受影响」。两条可选加强：chip 没有长度兜底、没有「header 缺省时 chip 不渲染」的负向断言。
- **回炉**：无。
- **复验**：✅ 成立（[round-1 九](reverify/round-1.md)）。去掉 `AICLIENT_NODE24_PATH` 后三轮启动全部正常、日志零命中、无横幅；chip 出现在问题正文正上方（13px / 400）；`getComputedStyle` 实测两张卡的段头与标题均 **600**、正文与选项描述 **400**，E1 那轮「层级全靠 500」的系统性偏差消失。Win10 那半边的对拍仍等上机日。

---

## 审阅未修、留待后续

下面每条都在一审 / 二审 / 复验里被明确说成「不在本轮改」或「记录备查」，集中列出以免随记录过期。

| # | 项 | 为什么不在本轮改 | 来源 |
|---|---|---|---|
| 1 | `thrownRunErrorText` 对**所有**带字符串 `code` 的抛出加前缀，`catalog_empty:` / `agent_dir_unset:` 也会带上，Node 的 `ENOENT` 更会出现 `ENOENT: ENOENT: …` 双前缀 | 属可接受取舍，形状沿用既有 `errorPayload`，不破坏任何消费者 | [group2](reviews/group2.md) T062 ②-3；[rework-1](reviews/rework-1.md) ③ |
| 2 | 删除确认框仍是单数「This removes the definition file.」，而一次删除可能清掉两个根的同名文件 | 文案与行为的偏差判为可接受，不改渲染层可少动一处 i18n；审阅建议改成列出将删除的路径/条数 | [fixes/T063.md](fixes/T063.md) §2；[group2](reviews/group2.md) T063 ②-2；[决策 017](../../decisions/017-subagent-definitions-edit-at-source-root.md) |
| 3 | 新建定义时若兼容根已有同名的**解析失败**坏文件，新定义会被写进兼容根而不是落主目录 | 行为未必是错的（确实消灭了一个抢同名的文件），但与「新定义总是落主目录」的直觉不符，缺用例 | [group2](reviews/group2.md) T063 ②-1 |
| 4 | 通用剥壳让内部错误串也弹 toast：`Pi TUI capacity reached (2)` / `Pi TUI controller is disposed` / `terminalId and cwd are required` 在中文界面里是英文 | 「最坏退化成英文而不是空白」被判为可接受方向；建议补中文或给内部串一个静默名单 | [rework-1](reviews/rework-1.md) R-B ③ |
| 5 | ↺ 按钮的 `aria-label` / `title` 是英文 `Retry last message (1 file)` | 真机新观察，非回归 | [round-2](reverify/round-2.md) 「未生效 / 新观察」#2 |
| 6 | `AgentTerminal.tsx` 的模型缺失覆盖层四个字段同样没套 `t()`，中文界面下整张是英文 | 与 R-B 的工作面相邻，避免同时改同一片代码；成本是一行一处 | [fixes/T062.md](fixes/T062.md) 回炉 §6 遗留一；[round-2](reverify/round-2.md) #5 |
| 7 | D17 仍有约 **4%** 偶发空白（27 次里 1 次，`live` 之后只回 11 字节） | 回炉自己预告的时序概率边界，本轮未能定位更细的触发条件（`live` 事件间隔不是判别量） | [round-2 一](reverify/round-2.md) |
| 8 | 会话预算拒绝这条路上，**模型先被调用了一次**才在落盘那步被拒 | 与 round-1 记的「模型侧没被调用」是不同形态；不影响主判据，记下备查 | [round-2](reverify/round-2.md) #3 |
| 9 | 临时工作区认领只看「保存位置根的直接子目录」，可能对用户真实项目 `mkdir` + `git init` | 已转成待拍板问题 [Q018](../../open-questions.md)，不阻塞 D4 | [group1](reviews/group1.md) T060 note 1 |
| 10 | `!preferred` 早退在工作区树为空时仍会清空未绑定会话 | 同一缺陷类、不同触发路径，本轮证据里未观察到该触发条件 | [group1](reviews/group1.md) T060 note 2；[fixes/T060.md](fixes/T060.md) §5 遗留 1 |
| 11 | 「统一设置解包入口」目前只是意愿：另三处手写解包未迁移，也没有静态守卫禁止第四个读者再写一遍顶层读法 | 那三处解包是对的，不迁移不产生新缺陷，但 D13 的复发门禁并不存在 | [group1](reviews/group1.md) T060 note 4 |
| 12 | `enqueue` 复位那一半没有自己的用例（deferred 载荷走的正是队列内拒绝那条路） | 预检到位后该路径够不着，撤修不判红；两半是互为兜底关系 | [group1](reviews/group1.md) T061 note 2 |
| 13 | `attachmentRider.ts` 的「the wire never sees it」读起来像全局保证，实际只覆盖本仓 runtime 的出网——`pi --session` 交接给真 pi CLI 之后那条路够不着 | 不是本次引入的类别，增量小；建议补半句限定 | [rework-2](reviews/rework-2.md) ① |
| 14 | `MessageTimeline` 的会话级 `Session failed` 卡因 `session.status: idle` 紧跟覆盖，对所有失败类都活不过一次渲染 | 要真修得动 runtime 事件语义，面太大；本次是绕过它 | [fixes/T062.md](fixes/T062.md) 回炉 §6 遗留二；[rework-1](reviews/rework-1.md) ③ |
| 15 | `catalogEntries()` 在 bundled / unavailable 分支空跑一次读盘并可能打出误导性诊断行；`getPiModelSyncState()` 仍是磁盘口径 | 建议与 T050 一并收口 | [group2](reviews/group2.md) T062 ②-4 / ②-6 |
| 16 | 约 49 个带原始 `error` 对象或裸路径的既有 warn 调用点没有普查；渲染层 `utils/logging.ts` 与主进程门槛不同档；开关**打开**选 `warn`/`error` 反而比关着记得少 | 超出「三处 + 一条毛边」的回炉范围，明确留在原审阅账上 | [group3](reviews/group3.md) T066 ②；[fixes/T066.md](fixes/T066.md) R-C 末段 |
| 17 | `parseFailureNote` 传的是 `raw.length`（字符数）而文案写 `bytes`；抛出路径把码写进正文却不填 `errorCode`，结束路径反过来 | 二审判为不阻断 | [rework-2](reviews/rework-2.md) ②③ |
| 18 | 导入链路 preload → 渲染层那两跳仍无用例，也不经过真正的 structured-clone | 落地记录的措辞略高于实际覆盖，建议收一收 | [rework-2](reviews/rework-2.md) ④ |
| 19 | `ChatComposer.tsx` 里 `largeAttachmentHint(..., t)` 那一行接线无任何自动化覆盖（全仓没有测试 import 该文件） | 只能靠 DEV-33 真机复拍，已复拍为中文 | [fixes/T067.md](fixes/T067.md) 收尾接线节；[group3](reviews/group3.md) T067 ③ |
| 20 | `formatAttachmentSize` 仍输出 `MB/KB`（二进制除数、十进制单位） | 另一条账，不在 D26 范围 | [fixes/T067.md](fixes/T067.md) 真机复拍节；[round-1 八](reverify/round-1.md) |
| 21 | header chip 没有长度兜底（32 字符上限只存在于 ask schema 里）；没有「header 缺省时 chip 不渲染」的负向断言 | 两条可选加强，均不阻断 | [group3](reviews/group3.md) T068 ②③ |
| 22 | `usePresentationSwitch.ts` 另外三条 toast（`Wait for this turn to finish` / `Could not start the Pi TUI` / `Could not reload this chat`）与 `ChatComposer.tsx` 的 `` `Error: ${lastError}` `` 兜底仍是英文 | 后者拼的是 Host 原样错误文本、不是可翻译的固定串；两处建议另开条目 | [fixes/T065.md](fixes/T065.md) §6-5 与回炉 §6-6；[round-1](reverify/round-1.md) #5 |
| 23 | 本批次新增注释里的中文「回炉」散布 26 处、跨 23 个文件，与「代码注释全英文」有出入 | 二审判为不阻断，建议统一换成 `rework` / `R-C` | [rework-2](reviews/rework-2.md) ⑤ |
| 24 | Windows / ConPTY 上「一次 resume 三次 resize」的 reflow 观感、以及 D23 字重的 Win10 对拍 | 只有真机能判，排进下一次跨平台点验（T033 上机日） | [rework-1](reviews/rework-1.md) R-B 建议 3；[fixes/T068.md](fixes/T068.md) §6-1 |

## 环境交代

两轮复验都在同一台 Linux 开发机（2 核 / 3.3 GB），dev 模式跑的就是带九项未提交修补的工作区代码。

**第一轮**（[round-1.md](reverify/round-1.md)，逐条还原见 [reverify/dev-D4-reverify/env-teardown.txt](reverify/dev-D4-reverify/env-teardown.txt)）

- **三次起停**，每次启动前 `free -m`（available 1934 / 1815 / — MB），每次退出后确认进程全无、端口释放、无残留 `pi`。
- **全程本地假网关** `127.0.0.1:18080`，按需切 `text` / `ask-question` / `write-approval` / `retry-503-forever` 四个计划；**一句真模型都没发**，`maxapi` / `cx2` / `vllmproxy` 一次都没碰。
- 强杀只用从 `ps -eo pid,args` 精确取到的真实 pid，查残留遍历 `/proc/*/cmdline`；**全程没有用过 `kill -1`、`process.kill(-1)`、`pkill -f`**。
- **还原核对**：vault **1042 字节**且 sha256 一致；`models.json` / `auth.json` sha256 一致；`session-index.json` 从备份**逐字节还原**（170 行，sha256 `84d9a093…`）；`workerRpc.ts` sha256 `ea9ebf9e…`、第 50 行回到 `= 1 as const`；`settings.json` 的 `defaultTemporaryPath` 回到 `""`；`~/.agents/subagents/` 与 `~/JYWAI/temporary-d4new/` 整个删除；探针会话 JSONL 已删。产品代码一行未改，`dev.env` 没动。
- 有意留下的只有产品自己生成的 `session-index.json.corrupt-…`（T066 的现场证据）。`git status` 相对开始只多出一个未跟踪目录（100 → 101 条）。

**第二轮**（[round-2.md](reverify/round-2.md)，逐条还原见 [reverify/dev-D4-reverify-2/env-teardown.txt](reverify/dev-D4-reverify-2/env-teardown.txt)）

- **两次起停**，启动前 available 分别 1984 / 1953 MB；两次退出后进程全无、9333 / 5173 / 9444 端口全部释放、无残留 `pi`。
- **全程本地假网关**，并把 `pi-agent/models.json` / `auth.json` 临时改成**只有** probe-fake 一个 provider——私有 provider 在整轮里连配置里都不存在。强杀与查残留同第一轮口径，同样**没有用过 `kill -1` / `process.kill(-1)` / `pkill -f`**。
- **还原核对（sha256 全部校回本轮开始时的值）**：`vault.json` 1042 字节 `7200ffeb…`、`settings.json` `af758e00…`、`models.json` `35257b8d…`、`auth.json` `8d106c13…`、`session-index.json` `84d9a093…`（170 行）、`workerRpc.ts` `ea9ebf9e…`（第 50 行回到 `= 1 as const`）。本轮产生的 9 份会话 JSONL 与其 `.writer.lock`、vault 备份、只读陷阱目录、以及加进 localStorage 的那条模型钉子都已删除或写回原值。
- **产品代码一行未改**（`workerRpc.ts` 的常量是 T064 的制造手段，已还原），`dev.env` 没动，**没跑 vitest、没跑 build**。`git status` 相对开始只多出一个未跟踪目录（121 → 122 条）。

两轮复验都记下了三条对上机同样适用的环境事实：vault 里的自定义 AI 服务不带图片能力声明（用它验附件出网永远看不到 image block）、只改会话文件的 model 不足以制造「模型缺失」（还要 localStorage 的每会话模型钉子）、dev.js 收到 SIGTERM 的退出路径不跑 scratch 的 `wipeAll`。
