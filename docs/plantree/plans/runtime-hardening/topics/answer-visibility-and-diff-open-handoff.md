# Handoff — 批次 K（T107～T111）施工移交单

Role: handoff。建立：2026-09-21。**执行方**：另一个 agent（或人）。**验收方**：原分析方（做完后评审）。
任务身份与状态的权威是 [roadmap](../roadmap.md)；施工细节与红线是 [topic 胶囊](answer-visibility-and-diff-open.md)。本文件只回答「怎么干、干到什么程度算完、交付什么」。

---

## 0. 一句话

把聊天区改回「正文永远可见、只有思考与工具调用被折叠」，把过程行尾部的命令行去掉，把审阅面板改成点开就地看 diff、并能跳中列 diff 页。

四条任务 + 一条登记待取证。**用户已拍板的结论不可重新讨论**（见 topic 的 K1～K5）。

---

## 1. 开工前的硬前置（缺一不可）

| # | 前置 | 怎么判断满足 |
|---|---|---|
| P1 | 批次 J 线 B（T105 / T106）已收口 | `git log` 里 `765729da` 已在基线中，且工作区没有正在改 `MessageTimeline.tsx` / `ToolRows.tsx` / `src/shared/i18n.ts` 的未提交改动 |
| P2 | 工作区干净到只剩你要改的文件 | `git status --short` 里 src/ 下的改动**全部**出自你这次任务。**注意**：立项当天工作区有别人正在改的 `sessionFailure.ts` / `continueIntent.ts` / `chatSessions.ts` / `ChatComposer.tsx`（「停下后不知道发生了什么」那条线）——**那是别人的活，不要碰、不要提交、不要顺手改** |
| P3 | 已读 topic 胶囊的红线 R1～R6 | 六条逐条读过；特别是 R2（`turnWorkGroupAwaitsUser` 一字不改）、R4（正文绝不可因折叠消失）、R6（词条必须字面量） |
| P4 | 已定位所有行号 | topic 里的行号对应 `398a0f4c`，**施工前用当天的 HEAD 重新定位**，不要照抄 |

**串行约束（不许并行）**：T107 → T108；T109 → T110。理由：T107/T108 同时改 `MessageTimeline.tsx` 与 `i18n.ts`，该仓库 2026-09-19 已记录过这类踩踏；T109/T110 改同一个文件。

---

## 2. 每个任务的交付物

**统一要求**：每个任务落地后，(a) 对应单文件测试通过；(b) 三套 `tsc --noEmit` 退出 0；(c) 在下面「任务记录」里写一行「改了什么、跑了什么、结果如何」。

### T107 · 正文全露（折叠区只收 process 段）

- **改哪**：`src/renderer/components/chat/turnProcessFold.ts` 的 `splitTurnWorkGroup`；`src/renderer/components/chat/MessageTimeline.tsx` 的渲染调用点；`__tests__/turnProcessFold.test.ts` 重写。
- **改成什么**：`answer` 段一律在折叠区外、按发生顺序渲染；`process` 段进折叠组。返回形状从 `{leading, grouped, finalAnswer, trailing}` 改为**有序的分段列表**（建议 `{kind:'answer', segment}` / `{kind:'processGroup', segments}[]` 交替），因为一个回合现在可以有**多个**折叠组。
- **必须保住的三条**：
  1. 无 answer 的回合（只跑工具、或 error 收尾）：process 段进组，**notice 段留在组外**——否则整个回合塌成一行，把唯一的错误信息藏起来。这是 FB4 的既有裁定，`chatTurn.ts:42` 与 `turnProcessFold.ts:64` 两处注释都写着。
  2. 「没有 process 就没有组头」：一段单独的正文不该长出空壳折叠头。
  3. `turnWorkGroupAwaitsUser` **一个字节不改**。
- **交付时必须附的证据**：一个真实长回合（工具调用 ≥ 20 次）的屏幕截图或录像。**判据：屏幕上过程行数 ≈ 正文段数，而不是 ≈ 工具调用次数。** 这一条不能只靠静态页或单测判断——用户已明确说过要现场看。
- **必须如实报告的代价**：正文与计数行会交替出现（正文 → 计数行 → 正文 → 计数行 → 正文）。这是用户在三栏对比页上看过 A/B/C 之后选的 B 形态，**不是 bug**，但验收方要看真实长回合里的观感。

### T108 · 工具行去后缀

- **改哪（两处来源，都要改）**：
  1. `toolCard.ts` 的 `aggregateActionText` / `deriveAggregateRow`：聚合行只留计数（`3 次工具调用`），去掉 `· 最后编辑 App.tsx` 这类尾部。
  2. `MessageTimeline.tsx` 工作头的 `actionClause`：不再经 `formatToolArg` 取参数，只留状态词。`deriveTurnCurrentAction` 本身**保留**（决策 031 的「工具间隙不可返回 null」仍然成立，删除它会让头部在间隙里闪烁）。
- **连带清理（只清本次产生的孤儿）**：`ToolRowView.verbText` 若不再有生产者就**删字段**，别留着不用（同决策 031 §5 的判据）；`aggregateActionText` / `toolActionNoun()` 同理。`i18n.ts` 里失去消费者的词条（如 `Last {{action}}`）一并删。
- **明确不做（除非用户追加）**：**单条**（未聚合）工具行的主参数（`读取 example.ts` / `运行 npm test`）保持现状。K3 说的是「后缀」，主参数是这一行的主信息。
- **交付时必须附的证据**：一个含长命令行（≥ 100 字符）的真实回合截图，证明工作头与聚合行都**不出现**命令行文本。

### T109 · 审阅条目：面板内就地展开（A0）

- **改哪**：`src/renderer/components/workspace-shell/SessionReviewPanel.tsx`
- **改成什么**：
  - `defaultOpen` 一律 `false`（删掉 `index === entries.length - 1`），只认用户的点击。
  - 展开时渲染 **patch 的 hunk 头行号**：新增行用右列行号、删除行用左列行号；**取不到时留空，绝不编造**（这是该仓库的既有红线 A07「never fabricate」）。
  - 条目头补 hover 与键盘可达（现在只有 `CollapsibleTrigger`）。
- **现状可复用**：`entry.patch` 已是完整 unified patch，`+/-/@@` 着色与分行已在实现里，本任务只加行号与手势拆分。
- **测试影响**：`workspace-shell/__tests__/sessionReviewInteraction.test.ts` 里「最后一条默认展开」的断言会红，需改写为「一律折叠」。
- **交付时必须附的证据**：一个 ≥ 10 条记录的会话里打开审阅面板的截图（证明默认全部折叠、点哪条开哪条）。

### T110 · 审阅条目 → 中列 diff 页（A1）

- **改哪**：`SessionReviewPanel.tsx` 的「打开文件」按钮改调 `useEditorStore.getState().openDiffTab({kind:'workdir', path: entry.path, status: entry.status})`（形状见 `src/renderer/stores/diffTabTarget.ts`），**不再**调 `onShowFiles`；`WorkspaceShell.tsx` 的 `onShowFiles` / `filesOpen` 若失去最后一个消费者，删掉整条传递链。
- **明确不做**：A2（按 unified patch 渲染的独立视图）。仓库目前没有任何这类组件，成本最高、收益最小。
- **必须在交付说明里写明的一句**：这会让中列独占、聊天区让位（`centerLayoutModel.ts` 的 `diffTabActive` 既有行为，不是本任务引入）。
- **交付时必须附的证据**：点审阅条目右侧图标 → 中列出现 `git-diff://` 页签的截图或操作录像。

### T111 · 中断后正文消失（登记，**排在 T107 之后**）

- 用户当日拍板**先放一放**。**必须在 T107 落地之后**再取证：T107 改了折叠规则，这个现象很可能自然消失或变形，先修可能是在修一个已经不存在的现象。
- **已排除**（2026-09-21 只读分析）：`session.failed` / `session.stopped` 两个 reducer 只改 status；流式 append 路径（`message.delta` / `appendTextBlock`）不清理任何 blocks。
- **待取证的两条嫌疑**：`historyReplayMerge.ts` 的文本折叠匹配在**被截断文本**上的行为；`chatSessions.ts:707` 的 `historyMessage.incomplete && blocks.length === 0` 占位分支。
- **取证方式（最小代价）**：起一次 dev、复现一次中断，dump 那条消息的 blocks（类型 + 长度 + 首 40 字符）与是否走了 history 合并。**不装依赖、不跑全量**（本机资源受限，见仓库 CLAUDE.md）。
- 取证之后**先报告再动手**，不要直接改。

---

## 3. 验证与报告要求

**本机资源受限**（仓库 CLAUDE.md 明确的既有约定）：**不装依赖、不跑全量测试、不做整包构建**。验证方式是：

```
# 每个任务改完后
./node_modules/.bin/vitest run <该任务相关的单文件> --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit -p src/runtime/tsconfig.json
./node_modules/.bin/tsc --noEmit -p src/agent-host/tsconfig.json
```

全量门禁（Biome / 完整 vitest / 打包）**以 CI 为准**，在报告里写明「本机未跑，CI 是权威」。**不要为了绕过这条说明去装依赖。**

**每个任务的报告格式**（交付时贴在下面「任务记录」）：

```
T10X
- 改了什么：（文件 + 一句话）
- 偏离：（有就写，没有写「无」。任何偏离都要写理由）
- 跑了什么：（命令 + 结果数字）
- 证据：（截图 / 录像 / dump 的路径）
- 不确定的：（你拿不准的地方，不要藏）
```

**不许做的事**（每条都是这个仓库已经踩过的坑）：
- 不许为了让测试变绿而改测试的判据（可以改断言形状，但要在报告里说明改了什么、为什么）。
- 不许顺手「改进」相邻代码、注释或格式（仓库 CLAUDE.md §3 手术式改动）。
- 不许删既有的注释——那些注释里写着过去的裁定，删掉等于把教训扔掉。**要改就改写并说明为什么推翻。**
- 不许用「设计值 / 推算值」充当点验证据。
- 不许碰 P2 里点名的别人的在途改动。

---

## 4. 验收怎么判（评审方按这个查）

| 任务 | 通过判据 |
|---|---|
| T107 | 单测覆盖「多 answer 段 + 多工具段」的回合；真实长回合截图里过程行数 ≈ 正文段数；无 answer 的报错回合里错误信息仍可见 |
| T108 | 长命令行回合的截图里，工作头与聚合行都没有命令行文本；`verbText` 的孤儿已清干净 |
| T109 | ≥ 10 条记录的会话打开审阅后**全部折叠**；展开的条目有行号且与实际 patch 对得上 |
| T110 | 点右侧图标后中列出现 `git-diff://` 页签；`onShowFiles` 链若已无消费者则确已删除 |
| T111 | 只交取证报告，不动代码 |

**评审方会重点查的三件事**：① 有没有偷偷扩大改动面；② 有没有为了过测试而放宽判据；③ 真实长回合的证据在不在（T107 这一条不可用单测替代）。

---

## 5. 已知的坑（施工方提前知道能省一轮）

1. **`MessageTimeline.tsx` 有 2600+ 行**，测试只能靠源码 AST 扫描锁字面量。改它之前先读它的模块注释，里面写着每一条布局禁令的来由。
2. **折叠头保持英文**（决策 031 D7），`messageTimelineWiring.test.ts` 与 `turnProgress.test.ts` 有 `HEAD-EN` 守卫钉着。T108 只改内容不改语言。
3. **`turnProcessFold.ts` 住在 `.ts` 里而不是组件里**，正是为了能被 node 环境的 vitest 直接 import。T107 的新形状同样要留在这儿，别搬进 `MessageTimeline.tsx`。
4. **`i18nCoverage.test.ts` 只扫单引号字面量**。聚合行现在靠 `verbText` 绕开了这个扫描——T108 正好是还这笔债的机会，顺带核对聚合行的词条确实有中文。
5. **演示页在 `/tmp`**（`aiclient-preview-answer-fold-and-diff-open.html`、`aiclient-preview-answer-visible-3ways.html`）。收口时如果还在，移进 `evidence/`；不在了就从 topic 里读形态描述。

---

## 6. 任务记录（施工方填写）

执行进度与验证证据：[批次 K 记录](../evidence/batch-k-answer-visibility-2026-09-21/README.md)。

2026-09-21 用户确认：T107～T110 串行实施、每任务单独提交；过程组默认折叠，单条工具行主参数保留。


T107
- 改了什么：`turnProcessFold.ts`、`MessageTimeline.tsx` 与对应测试；正文全露、过程组独立折叠。
- 偏离：按用户再次确认替代 `ef26ca5f` 的默认展开；旧裁定注释按新规则改写，保留 FB4、纯派生与授权红线理由。
- 跑了什么：分段/接线/进度测试 114 通过，三套 tsc 均退出 0，改动文件 Biome 通过；新判据在旧实现下 12 条失败。
- 证据：[执行记录](../evidence/batch-k-answer-visibility-2026-09-21/README.md)。
- 不确定的：真实长回合观感待验收，当前 dev 缺少可用模型凭据与历史会话；T111 无法复现，不作根因结论。
