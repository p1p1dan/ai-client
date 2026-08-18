# F11 修法施工规格 B 轨对抗性评审

评审范围严格限于 `docs/plans/2026-08-18-f11-merge-fix-spec.md`、上游 RCA、`historyReplayMerge.ts` 及其测试，以及核验附件往返和 F2 §10.4 所必需的 `historyReader.ts`、`claudeRuntime.ts`、`eventNormalizer.ts`、共享类型和 `chatSessions.ts` 相关代码段。未查看、引用或参考任何其他评审产物。

## 发现

**Blocker — §2.3、§3.4、§5.2 R1：空文本同 MIME 图片的错误 replacement fold 会删除一条真实附件消息，不是规格所称的“只发生 chip 名归属漂移”。** 反例一：`bucket=[user-B]`，其中 `user-B` 是空文本截图 B，附件为 `{kind:'image', mediaType:'image/png', name:'b.png'}`；`history=[h:A]`，`h:A` 是更早且内容不同的截图 A，历史附件为 `{kind:'image', mediaType:'image/png'}`；快照为 `candidateIds={user-B}, anchor=null`，而 B 的真实历史副本尚未进入本次读窗。按 §2.2 的新规则，B 与 A 都得到 `mode='attachment'`、`key='[["image","image/png"]]'`；A 不在 `candidateIds`，通过 guard 3b；随后 replacement fold 把 `history[0]` 替换成 `user-B`。输出从两个真实回合 `[A,B]` 变成 `[B]`，截图 A 的整条历史消息消失。反例二正是规格 §3.4 的“读法②”：`history=[h:A,h:B]`，其中 `h:B` 才是 B 的真副本；扫描先命中 `h:A` 后输出 `[user-B,h:B]`，即 A 消失、B 重复，而非“顺序不变、唯一差异是 name 挂到前一泡”。这个误判之所以无法在合并层恢复，是因为运行时只回声元数据（`src/agent-host/eventNormalizer.ts:443-458`），图片写入 SDK prompt 时没有 `title/name`（`src/agent-host/claudeRuntime.ts:58-67`），历史回读也明确无法恢复图片名且从不读取图片数据（`src/agent-host/historyReader.ts:586-587,618-647`）；两张不同截图在合并层确实坍缩为同一身份。当前 replacement 的实际语义就是“用运行时对象覆盖命中历史下标”（`src/renderer/stores/historyReplayMerge.ts:253-262`），所以计数公式只有在“每次命中都是真副本”这一未经证明的前提下才成立。处置建议：不得把 `(kind, mediaType)` 作为可删除/可 replacement 的充分身份；在 canonical id 未打通前，image-only 的歧义匹配必须 fail-open 保留重复。若仍要折叠，必须引入能证明同一回合的稳定标识；“候选唯一”也不足以修复反例一，因为唯一的可匹配行仍可能是另一张图。

**Blocker — §1.2、§1.5 P-2/P-3、§3.2、§7：`id ∉ candidateIds` 只证明“这个字符串没在快照里”，不能证明“这是一条新落盘的候选副本”；synthetic id 漂移或分支平铺可重新制造 P1 的静默丢失。** 具体推演：快照时 bucket 为 `[h:synthetic-100('继续'), h:anchor, user-resend('继续')]`，`candidateIds` 含这三个 id，`anchorHistoryId='h:anchor'`；其中第一行是一个已结算旧回合，`user-resend` 是新的同文本重发。`historyReader` 在缺 uuid 时用当前读源的 `totalLines` 生成 `synthetic-${totalLines}`（`src/agent-host/historyReader.ts:767-774,873-908`），而读源在文件超过上限时从 tail 重新起读（`:699-704`），`totalLines` 又从 0 计数（`:706,813-817`）；读窗边界变化后，同一旧行可变成 `h:synthetic-99`，与此同时带真实 uuid 的 `h:anchor` 仍然存在。新规则 guard 3a 因 anchor 存在而放行，`cursor=0`；旧行的新 id 不在快照集合，guard 3b 把它误判为“新鲜”；其 role/text 与 `user-resend` 相同，于是重发被折掉。prefix replace 又会先移除 bucket 中旧的 `h:synthetic-100`（`src/renderer/stores/historyReplayMerge.ts:186-188`），最终输出只有改号后的旧历史行和 anchor，真实重发气泡消失。分支平铺有同样结构：`JsonlEntry` 根本不建模 `parentUuid`（`src/agent-host/historyReader.ts:439-450`），除显式 `isSidechain` 外不会按主链剪枝（`:859-867`）；一条本轮才进入结果集、但属于兄弟分支的同身份行同样能通过 3b，吸收主分支候选。规格 §1.5 已把 synthetic id 不稳定和分支混入列为“真实生产者”，却反向把这些“新 id”当作安全证据，逻辑自相矛盾。处置建议：guard 3b 必须建立在稳定、同源的历史身份或可靠的读代际/位置水位上；在 synthetic id、重写或分支集合不能证明连续性时应整体停折。至少新增三条必红负控：anchor 尚在但旧 synthetic 行改号、anchor 尚在但新兄弟分支同文本、`anchor=null` 且首个同身份历史行不是候选真副本。仅保留“anchor 缺失才停折”不足以守住丢失边界。

**Major — §0.3、§4.2、§4.4、§5.1：当前基线并非“26 条既有用例”，所以“26 + 17 = 43 条全绿”的收口门在真实仓库上无法成立。** 当前 `src/renderer/stores/__tests__/historyReplayMerge.test.ts` 有 27 个 `it(...)`：`mergeReplayedHistory` describe 为 22 条（`:36-381`），`resume snapshot registry` 为 5 条（`:389-426`）。直接执行 `./node_modules/.bin/vitest run src/renderer/stores/__tests__/historyReplayMerge.test.ts` 的真实结果是 `27 passed (27)`；因此若 T1~T17 都是新增用例，总数应为 44，而不是 43。规格开头还写“现有合同 21 用例”（`docs/plans/2026-08-18-f11-merge-fix-spec.md:6`），§4.2 又写 21+5=26（`:498-500`），均与当前文件不符。另有文字层矛盾：§4.2 宣称“全部零改动”，但同节要求修改 `:323` 的标题/注释（`:508`）；T6 又写“既有 :68-89 夹具逐字复用，标题改为……”（`:482`），若是修改原用例就不再是新增 17 条，若是复制新增则不应写成改原标题。处置建议：以当前 HEAD 重数并列出 27 条基线清单，明确 T5/T6/T14 是新增复制还是改写既有测试；随后把总数、收口命令预期和 as-built 模板统一改成一个可机械核验的数字。

**Major — §4.3 变异⑤：变异表声称 T13 会因“把 name 加回附件身份”而变红，但 T13 走文本档，根本不会读取附件身份；“每对必须恰好咬住表中用例”的纪律按现稿不可兑现。** §2.2 的 `foldIdentity` 明确规定只要 `coverageText` 非空就立即返回 `{mode:'text', key:text}`，只有无文本才调用 `attachmentIdentity`（`docs/plans/2026-08-18-f11-merge-fix-spec.md:245-262`）。T13 又明确复用 T2 的 `merged[2]/merged[4]`（`:489`），而 T2 两条候选分别有文本 `'B look at this'` / `'C and this'`（`:354,478`）；因此变异⑤仅把 `name` 加进 `attachmentIdentity` 时，T13 的匹配路径和 replacement 结果完全不变，T13 应保持绿。真正能杀死该变异的是 image-only 的 T3/T4；T13 只证明 replacement 后附件对象被保留，不能证明附件身份是否包含 name。其余八个变异按当前断言形状都存在实际杀手，但多组测试只是同根重复：T5/T6 与既有 watermark/P1、T14 与既有 M1、T15 与既有单历史双 echo 都不提供新的独立判别力。处置建议：把变异⑤的必红集合改为 T3 两臂 + T4，并删除 T13 的虚假归属；若要让 T13 承重，应另设“replacement 时丢失/改写附件元数据”的独立变异。变异执行记录应逐项区分“承重首杀”与“附带同红”，不能以测试名数量代替咬合证明。

## 指定攻击面的逐项结论

- **P1 重发同文本在候选集内**：对快照时已经存在、id 稳定不变的旧历史行，guard 3b 能挡住 §1.4 CE2；但它挡不住 Blocker 2 的“同一旧行改成新 id”或新分支诱饵，因此 P1 防线并未被证明等价替换。
- **二次 replay / replacement fold**：规格 §3.2 的理想夹具在“所有新行都是真副本”前提下会按预期折到下标 2/4，§3.3 也能形成数组不动点；但 Blocker 1 证明 replacement 命中错误同身份行时，不动点可以稳定地保存“旧附件丢失 + 新附件重复”的错误结果。
- **陈旧 replay 交错**：requestId 不匹配时 `takeResumeSnapshot` 返回 `null` 且不消费新快照（`src/renderer/stores/historyReplayMerge.ts:116-130`），合并层随后完全不折（`:196-200`）；这一支未发现丢失反例，只会 prefix replace 后保留全部 runtime，方向是重复。风险集中在“requestId 匹配但读到的行集合/id 已漂移”，已由 Blocker 2 覆盖。
- **截断读窗**：非空 anchor 消失时 guard 3a 整体停折，现有测试 `historyReplayMerge.test.ts:174-186` 能守住；但 anchor 仍在、synthetic 行改号的截断/读窗变化不触发该守卫，见 Blocker 2。`anchor=null` 的首次 resume 也没有任何 id 连续性证明，不能仅凭“此前无 hydration”推导读窗内第一条同身份行就是候选副本。
- **分支平铺行混入**：当前 reader 只跳过 `isSidechain===true`，没有 `parentUuid` 主链裁剪；新鲜度谓词无法区别“新落盘真副本”和“新进入结果集的兄弟分支行”，见 Blocker 2。
- **附件往返与“形状同构”**：类型结构层的三字段形状确实同构：`MessageAttachmentMeta` 与 `HistoryAttachment` 都是 `{kind, mediaType, name?}`（`src/shared/types/runtimeEvents.ts:203-212`；`src/shared/types/sessionHistory.ts:42-54`），`chatSessions.ts` 也分别从历史和实时事件把附件带到合并层（`src/renderer/stores/chatSessions.ts:439-471,645-659`）。但值层并不完全同构：image 的 name/data 都无法回读；规格对此事实本身判断正确，却错误地把由此产生的身份碰撞降级成仅视觉归属问题。
- **F2 §10.4 红线**：未发现冲突。F2 明确要求 `src/renderer/stores/chatSessions.ts` 零改（`docs/plans/2026-08-18-f2-watchdog-redesign-spec.md:1011-1023`）；F11 候选 a 的影响面只列 `historyReplayMerge.ts` 及其测试，并明确不改 `chatSessions.ts`（`docs/plans/2026-08-18-f11-merge-fix-spec.md:556-570`）。当前相关路径的 `git status`/`git diff` 也没有 `chatSessions.ts` 改动。候选 b 会触碰该红线，规格已正确降级为 F11-b 并要求另立票、等待解冻。

## 验证记录

- `pnpm vitest run src/renderer/stores/__tests__/historyReplayMerge.test.ts`：未进入测试，环境报错 `[ERROR] unable to open database file`。
- `./node_modules/.bin/vitest run src/renderer/stores/__tests__/historyReplayMerge.test.ts`：成功，`1 passed`，`27 tests passed`。
- 拟议 T1~T17 和生产修法尚未落地，因此无法实跑“44 条修后全绿”或九个源代码变异；本评审对变异咬合的结论来自规格给出的确切分支与断言路径推演。

总判：B=2 M=2 m=0 —— 推倒重来
