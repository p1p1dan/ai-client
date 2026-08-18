# F11 修法施工规格 — A 轨对抗性评审（deep-reasoner / opus）

- 日期：2026-08-18
- 评审对象：`docs/plans/2026-08-18-f11-merge-fix-spec.md`（669 行，施工定稿）
- 上游：`docs/plans/2026-08-18-f11-resend-dup-rca.md`（含 §6 勘误）
- 被改对象：`src/renderer/stores/historyReplayMerge.ts:1-265`、`src/renderer/stores/__tests__/historyReplayMerge.test.ts:1-427`
- 口径：**证伪优先**。所有「实查」均为本轮亲自读源/跑数据得出，不引用规格自述。
- 双盲声明：未读取、未查找任何其他评审轨产物。

---

## §0 总判

| 计数 | 值 |
|---|---|
| blocker | **0** |
| major | **5** |
| minor | **10** |

**结论：修订后开工。**
修法机制本身**我攻不破**——在三条我已实查为真的系统前提下，洞 A 的「起点下放 + 逐行准入」
是今天游标下界的**严格超集**，且新增部分与 bucket 中的运行时副本**一一配对**，构造不出丢失。
但规格的**证据链有虚构成分**（§3 的旗舰场景在真实系统里不可产生）、
**「无丢失」的真正证明义务从未写出**、**回滚计划的独立性主张有一半是错的**，
以及测试合同存在可数的算术/配对错误。这些必须在动工前修订，否则 as-built 的发射证据是假的。

---

## §1 先说正面：我实查为真的四条（可直接引用为施工依据）

### V1 — 既有用例是 **27 条**，在新规则下逐条推演**全绿**

我把 `mergeReplayedHistory` 的 22 条 + `resume snapshot registry` 的 5 条**逐条**按新规则走了一遍
（走位见 §5 表），结论与规格一致：**零改动全绿**。规格「26 条」的基数是错的（见 m1），但存亡结论对。

### V2 — 承重定理：3b 的准入集是今天游标下界的**超集**，且增量恰为 P-1 空洞（配对，无丢失）

**定理**：在 (i) JSONL 追加写、(ii) 行 id 稳定、(iii) bucket 只增不删 三条前提下，
`{ i : i > anchorIndex } ⊆ { i : historyMessages[i].id ∉ candidateIds }`。

证明：`anchorHistoryId` = 快照时 bucket 里**最后一条** `h:*`，而 bucket 的 `h:*` 集合恒等于
**上一次 replay 的行集合**（`[...mergedHistory, ...kept]`，`historyReplayMerge.ts:259-264`）。
追加写 ⇒ 上一次 replay 的行在本次 replay 中的下标均 ≤ `anchorIndex` ⇒
`i > anchorIndex` 的行不属于上一次 replay ⇒ 不在 bucket ⇒ ∉ `candidateIds`。∎

于是**今天能折的每一次折叠，新规则下依然能折**（准入更宽），风险只来自
「`i ≤ anchorIndex` 且该行 ∉ candidateIds」这一新增区域。该区域的唯一来源是
**replacement fold 自伤（P-1）**：上一轮 `historyReplacements.set(matchedAt, message)`（`:254`）
把该下标的 `h:*` id 从 bucket 挖走。而挖走它的那条运行时副本 **必然仍在 bucket 里**、
**必然仍是候选**、**身份纯函数不变**、且**在 runtime 数组里排在所有更晚候选之前**
（runtime 保 bucket 序，bucket 序 = 下标序，`:188`）⇒ 每个空洞被它自己的副本先行认领，
后来的候选够不到。归纳到多轮成立（空洞下标序 = 上一轮命中序 = runtime 序，游标严格递增保证）。

三条前提我都实查：
- (i) 追加写 + **只从头淘汰**：`historyReader.ts:745-756` 的 `pushMessage` 环形缓冲 `messages.shift()`；
  `openTailLines`（`:390-410`）也是尾窗 + 丢弃首个残行 ⇒ **行只会从头消失，永不在中段"变新"**。
- (ii) id 稳定：`h:${entry.uuid}`（`:905-908`），`synthetic-${totalLines}` 只在**无 uuid**时兜底。
  **实测本机 20 个 >100k 的真实 JSONL：3234 条 user/assistant 行，缺 uuid 者 0 条。**
- (iii) bucket 只增不删：`upsertMessage`（`chatSessions.ts:361-368`）只 upsert；
  全文件无任何删除消息的路径（已 grep `filter` / `splice` / 清空赋值，零命中）。

**⇒ 我构造不出丢失。规格「失败方向恒为重复而非丢失」的结论我背书；但它的论证不成立（见 M2）。**

### V3 — F2 边界主张实查成立

- `chatSessions.ts` 红线：F2 定稿 `:13` + **`:1015`**（规格 §0.2 写 `:1000`，见 m7）明文「红线文件，零改动 …… 若 S3 发现必须改，先停下来单独立项」。
- §11.1 切片表实查（`:1042-1049`）：S3 独占 `queueRelease.ts` / `useQueueRelease.ts` / `turnSendStatus.ts` /
  `ChatComposer.tsx`(写侧) / `MessageTimeline.tsx`；S2 独占 `sendBudgets.ts`(新) / `attachmentLimits.ts` /
  `assistantProgress.ts` / `middleColumnLayout.ts` / `ChatComposer.tsx`(读侧)；S0 独占 `runtimeEvents.ts`；
  S1/S4 只碰 `src/agent-host`；S5 只碰 `src/main`。
  **五片独占文件表与本批两文件零重叠 ⇒ §5.4「无同文件冲突、可并行」成立，§0.2 D-3 的降级理由成立。**

### V4 — 我试过但**不成立**的一条攻击（记录以免下一轮重复投入）

「replacement fold 把历史行换成运行时副本 ⇒ 该行的 `timestamp` 丢失 ⇒ 早期下标被替换会打乱日期分隔」——
**不成立**：`ChatMessage`（`chatSessions.ts:173-184`）**根本没有 timestamp 字段**，
`mapHistoryMessageToChatMessage`（`:459-478`）直接丢弃 `historyMessage.timestamp`。零暴露。

---

## §2 Major 发现（5 条）

### M1 [major] §3.0 / §3.1 / §3.2 的「三场景复原」在真实系统里**不可产生**；T2 因此钉了一个虚构形状

**规格节号**：§3.0（「复原后的三场景首尾自洽 …… 可直接抄成 vitest 夹具」）、§3.1、§3.2、§4.1 T2、§4.0 正控③。

**反例（两处独立证伪）**：

1. **§3.1 的 `historyMessages = [h:u1, h:a1, h:a2, h:a3]` 不是 §3.2 文件的前缀。**
   §3.2 的文件是 `[h:u1,h:a1,h:u2,h:a2,h:u3,h:a3,h:u4,h:a4]`。§3.1 声称 replay#1 时
   `h:u2/h:u3` 尚未刷盘，却已经读到 `h:a2/h:a3`——而 `h:a2` 是 `h:u2` 的**回复**，
   追加写的 JSONL 不可能先有回复后有提问。规格自己在 §1.5 点破过这一点
   （「其字面时序在追加写的 JSONL 上不可能自然发生」），却在 §3.0 反过来宣称「首尾自洽」。
   读侧也堵死了另一种解释：`historyReader.ts:901` 的 `if (text || attachments.length > 0)`
   对图片消息**必然为真**（Carrier A `extractContentAttachments` 抓 image 块，`:619-648`），
   所以 `h:u2` 不会被读侧吞掉。

2. **§3.2 的 bucket 形状与它自己给的三个生产者互斥。**
   §3.2 要求「anchor = `h:a3`（下标 5）而 `h:u2`（下标 2）∉ candidateIds」。
   由 §1 的 V2 定理，追加写下这只可能来自 P-1（replacement fold 自伤）；
   但 P-1 的必然后果是**运行时副本坐在被挖走的那个下标上**，
   即 bucket 应为 `[h:u1, h:a1, user-s-1003, h:a2, user-s-1005, h:a3, h:u4, h:a4]`，
   而 §3.2 写的是 `[h:u1, h:a1, h:a2, h:a3, user-s-1003, user-s-1005]`（两条副本垫在尾部）。
   **§3.2 的入参在 P-1 下不可达，在 P-2/P-3 下也不可达（见 M3）。**

**真正可达的犯罪现场**（我推导并核对过，建议直接取代 T2 的夹具）：

```
bucket   = [h:u1, h:a1, E1003, h:a2, E1005, h:a3, h:u4, h:a4]   // 上一轮 fold 的产物
history  = [h:u1, h:a1, h:u2 , h:a2, h:u3 , h:a3, h:u4, h:a4]
snapshot = { candidateIds: 上面 8 个 bucket id, anchorHistoryId: 'h:a4' }
```
- **今天**：`anchorIndex = 7` ⇒ `cursor = 8` ⇒ 两条副本一条都折不到 ⇒
  输出 10 泡 `[8 行历史…, E1003, E1005]`——`h:u2/h:u3` 与两条副本各重一次，
  且两条副本被 `[...mergedHistory, ...kept]`（`:264`）垫在**最新输入正上方**：
  **与用户原述逐字吻合**（RCA §1 第 2 条）。
- **新规则**：`h:u2/h:u3` ∉ candidateIds ⇒ 折回下标 2/4 ⇒ 8 泡，幂等。

**影响**：§6.1 步骤 1 要求「T1/T2/T3/T7 按今天的代码必须全红」。T2 用虚构夹具**也会红**，
于是 as-built 会记下一份**红得毫无意义**的发射证据；真正的犯罪现场只被 T17 覆盖，
而 T17 的入参又是从 T2 的虚构输出推来的。整条证据链底座是假的。

**建议处置（必做）**：
1. 删掉 §3.0「三场景首尾自洽」的断言，或改写为「§3.1 是 RCA 探针的合成入参，不代表可产生的文件形状」。
2. **T2 换成上面这份 P-1 夹具**；T17 保持「T2 的输出再跑一轮」（此时才是真正的第三轮）。
3. 更强的做法：把 T2/T17 写成**自生成两轮链**——第一轮的 `merged` 与其 id 集合直接喂给第二轮的
   `bucket` / `snap(...)`，夹具由 `mergeReplayedHistory` 自己产出，**从结构上杜绝夹具虚构**。
   这一条同时把 INV-P3 变成机器可验证的不动点，而不是人写的两份数组。

---

### M2 [major] 「无丢失」的**真正证明义务从未写出**；§1.3 给的理由是错的

**规格节号**：§1.3（「顺序不可能倒置 …… 真出现倒置只会『找不到匹配 → kept → 重复』，失败方向仍在安全侧」）、
§1.6（INV-P1/P2/P3）、§7。

**攻击**：`cursor = 0` 之后，命中的是**第一条准入的同身份行**，不再是「真副本」。
所以「顺序倒置」的后果**不是**规格所说的「找不到匹配」，而是**匹配到错的那一条**：
若真副本缺席本次 replay（P1 反例的前提），而一条更早的准入行同身份，
候选就会被**普通 fold 删掉**（文本档无附件 ⇒ `isFoldable` 真 ⇒ `matchedAt !== -1` ⇒ 直接丢弃，`:249-256`）
——这正是 v1 的 P1 丢失，一字不差。规格用一句「只会 kept」把这个分支当作不存在。

**为什么最终仍然安全**：靠的是 §1 V2 里那条规格**从未写出**的不变量：

> **INV-P4（空洞配对）**：`i ≤ anchorIndex` 且 `historyMessages[i].id ∉ candidateIds` 的行，
> 必然是上一轮 replacement fold 挖出的空洞；挖它的那条运行时副本 (a) 仍在 bucket、
> (b) 仍是候选、(c) 身份不变、(d) 在 runtime 数组中排在所有更晚候选之前，
> 因而**先行认领自己的空洞**，游标随即越过，后来的候选够不到。

INV-P4 的四个分支各自依赖一条**外部模块的性质**，本模块无法自守：
(a)(b) 依赖 `chatSessions.ts` 的 bucket **只增不删**（`upsertMessage :361-368`，今天成立）；
(d) 依赖 `[...mergedHistory, ...kept]` 的拼接序 = 下标序（`:259-264`，本模块自守）。
**一旦将来有人给 bucket 加一条删除路径（删消息 / 编辑重发 / 错误回滚 / 内存上限裁剪），
INV-P4(a) 断裂，空洞就变成无主诱饵，3b 立刻退化为 v1 丢失。** 今天没有这条路径（已 grep 确认），
但规格没有把它登记成前置条件，也没有任何断言守着它。

**建议处置（必做）**：
1. 把 INV-P4 写进 §1.6（与 INV-P1/P2/P3 并列）**和** `historyReplayMerge.ts` 头注，
   明文写出「本模块的无丢失性依赖调用方 bucket 只增不删」这条**跨模块前置条件**。
2. 订正 §1.3 的错误论证：改成「顺序倒置会命中错行；安全性由 INV-P4 保证，不由『找不到匹配』保证」。
3. 补一条测试钉 INV-P4 的**破坏面**（负控）：空洞存在但其运行时副本**不在 bucket**时，
   一条更晚的同文本候选**必须仍被 kept**——今天做不到（会被吃掉），所以这条只能写成
   **已知边界的显式登记**（新残留 R6），或者反过来钉「副本在场时空洞被正确认领」（T15 的加强版）。

---

### M3 [major] §1.5 的三个生产者，**两个被实测/结构证伪**；P-1 是唯一可达生产者，两个洞因此**不独立**

**规格节号**：§1.5 生产者表（P-1 / P-2 / P-3）、§1.5 结语「洞 A 不是洞 B 的兜底，对带附件消息而言它是必修项」。

**P-2（synthetic uuid 不稳定）—— 实测证伪**：
- 触发前提是**行没有 `uuid`**（`historyReader.ts:770-771`、`:905-906` 才走 `synthetic-${totalLines}`）。
  **实测本机 20 个 >100k 的真实 CLI 转录：3234 条 user/assistant 行，缺 uuid 者 0 条。**
- 即便有，`totalLines` 也只在**输入尾窗生效后**才会漂移，阈值
  `HISTORY_INPUT_TAIL_LIMIT_BYTES = 32 MiB`（`:195`）。本机最大转录
  `94a3769d-…jsonl`（正是 RCA 引用的那个会话）为 **26.7 MB，尚未越线**。
- ⇒ P-2 今天**零产出**。规格把它列为生产者且无任何取证。

**P-3（分支/侧链交错）—— 结构证伪**：
- 规格的机制表述是「读窗口滑动会让这些行成批『变新』」。这是错的：
  `pushMessage` 的环形缓冲**只从头淘汰**（`:750-755` 的 `messages.shift()`），
  `openTailLines` 也是尾窗（`:390-410`）。**两条淘汰路径都只会让行消失，不会让行在中段出现。**
- 兄弟分支行由 CLI **追加**在文件尾部，且带稳定 uuid ⇒ 它们「变新」的位置永远在锚点**之后**，
  今天的游标本来就够得到。⇒ P-3 不产生 §1.5 声明的「结构条件」。
- （P-3 真实的负面作用只是**扩大同身份行的密度**，即抬高 R1/R4 的概率——规格 §5.2 已正确登记为 R4。）

**推论（这才是要点）**：**P-1 是洞 A 的唯一可达生产者**，而 P-1 **只由 replacement fold 产生**，
replacement fold **只发生在带附件的消息上**（`isReplacementFoldable :171-179` 要求 `attachments.length > 0`）。
⇒ **洞 A 的暴露面被洞 B 的路径完全包住；两个洞在因果上是串联的，不是并列的两个 bug。**
这解释了用户为什么**只**看到带图消息重复（RCA §1），比规格 §1.5 的「第二半解释」更强。

**直接后果 —— §4.5 的回滚独立性主张有一半是错的**：

> §4.5 原文：「两个洞的修法**互相独立**，可单独回滚其一」。

- **回滚洞 B、保留洞 A**：安全。image-only 回到今天的「永不折叠」，图+文继续被修好。✔
- **回滚洞 A、保留洞 B**：**不安全，且是净负**。洞 B 让 image-only 消息第一次 replay 就折叠成功，
  于是**亲手制造一个 P-1 空洞**；没有洞 A，下一轮 resume 该空洞永远够不到 ⇒
  image-only 消息从「稳定重复」变成「折一次、然后永久重复且位置漂移」。
  （小夹具看不出来：整段历史被替换完时 `anchorHistoryId` 为 null，游标本来就是 0，会自愈。
  真实会话里必然有存活的 `h:*` 行 ⇒ 锚点非空 ⇒ 复现。）

**建议处置（必做）**：
1. §1.5 生产者表：P-2 标注「需无 uuid 行 + >32MiB 尾窗，本机实测 0/3234，登记为理论项」；
   P-3 的机制描述改写（它抬高的是 R1 概率，不产生结构条件）；把 P-1 提为**唯一**生产者。
2. §4.5 改写为**有序回滚**：「洞 B 可单独回滚；**洞 A 不得在洞 B 生效时单独回滚**」，
   并把这条写进 as-built 的回滚预案。§6.1 的施工序（先洞 A 再洞 B）恰好与之相容，无需改。
3. §0.3 的「a = 两处纯函数改动」措辞可保留，但要加一句因果说明：洞 A 是洞 B 的**必要伴随**。

---

### M4 [major] §4.5 / §6.2 的 flag 豁免代偿「off 位双轮全量」**不可执行**，且 off 位定义错误

**规格节号**：§4.5 第二条（「该模块天然自带 off 位：`snapshot === null` ⇒ 一行都不折」）、
§4.5 末句与 §6.2（「off 位（`snapshot: null`）与 on 位（正常快照）各跑一轮全量套件」）。

**攻击**：
1. **`snapshot === null` 不是「F11 的 off 位」，是「整个折叠合并的 off 位」。**
   它把 round-6 Bug B 的既有折叠一起关掉（`:196-201` 早退），跑出来的结果既不是 F11 前的形态，
   也不是 F11 后的形态，对「新能力 on/off 双跑」这条规范（工程规范 #6）**零信息量**。
2. **「各跑一轮全量套件」在物理上做不到**：`snapshot` 是 `mergeReplayedHistory` 的**入参**，
   由 27 条用例逐条显式构造（`ok(snap([...]))`），没有任何全局开关能把它统一置 null；
   真要置 null，至少 15 条用例会按定义变红。这条 as-built 要求若被认真执行，
   施工方只能伪造一份"结果"，或者把它跳过——两种都污染 as-built。

**建议处置（必做）**：把 §4.5 的第二条与 §6.2 的对应 as-built 项**删掉**，换成能真跑的两条：
- (a) **分步发射证据**：只落洞 A → 跑全量（T3/T4/T8~T12/T16 应仍红，其余全绿）；再落洞 B → 全绿。
  这一步天然构成 on/off 双跑，且顺带验证 M3 说的「洞 A 单独可用、洞 B 不可单独」。
- (b) **回滚演练**：按 M3 的有序回滚，实跑一次「回滚洞 B、保留洞 A」并记全量结果。

---

### M5 [major] T4 是 T3(a) 的**逐字重复**，钉不住它声称的 INV-P3

**规格节号**：§4.1 T4（「把 T3(a) 的输出当新 bucket 再跑 …… 咬住 image-only 折叠跨轮幂等（INV-P3）」）。

**反例**：T3(a) 的入参是 `bucket = [user-s-3001]`、`history = [attMsg('h:x1',…)]`、`snap(['user-s-3001'])`
（anchor 默认 null）。T3(a) 的输出是 `['user-s-3001']`，于是 T4 的入参是
`bucket = ['user-s-3001']`、`history = [h:x1]`、`snap(['user-s-3001'], null)`
——**与 T3(a) 逐字相同**。同一个纯函数、同一组入参 ⇒ T4 **永远不可能在 T3(a) 绿的时候红**。
它对变异 ⑤/⑦ 的"红灯"只是 T3(a) 红灯的复印件，对 INV-P3 的鉴别力为 **0**：
`anchorHistoryId` 是 null，guard 3a 与 3b **一次都没参与**（没有任何 `h:*` 行留在 bucket 里）。

**建议处置（必做）**：T4 的第二轮夹具必须**留下存活的 `h:*` 行**，锚点才非空、3a/3b 才上场：

```
round-1: bucket=[E3001(空文本+1图)],            history=[h:x1(image-only), h:a1(assistant '收到')]
         snap(['E3001'], null)                   → merged = ['E3001','h:a1']
round-2: bucket=merged,  history 不变,           snap(['E3001','h:a1'], 'h:a1')
         期望 ids 与 round-1 逐字相同（不动点）  ← h:x1 ∉ candidateIds ⇒ 再次折进下标 0
```
最好按 M1 建议 3 写成**自生成链**（round-2 的入参由 round-1 的返回值直接推出）。

---

## §3 Minor 发现（10 条）

| # | 严重度 | 规格节号 | 发现 / 证据 | 建议处置 |
|---|---|---|---|---|
| **m1** | minor | §0（「21 用例」）、§4.2、§4.4 门 3、§5.1 | **既有基数错了**。实数：`mergeReplayedHistory` describe **22** 条（`:36,47,59,68,91,133,151,174,188,206,215,225,234,243,263,280,298,314,323,340,349,369`）+ registry **5** 条 = **27**，非 26。§4.4 门 3 的「26 + 17 = **43 条全绿**」应为 **44**。这是**收口门的判定数**，写错等于门本身失真；而 §4.2 自称「逐条复核已做」——基数都不对，说明复核不是逐条 | 全文改 26→27、43→44；§4.2 补上被漏掉的那条的复核结论 |
| **m2** | minor | §4.3 变异 ⑤ | **配对不成立**。⑤ 是「`attachmentIdentity` 把 `name` 加回三元组」，预期变红含 **T13**。但 T13 取自 T2，T2 的两条候选**有文本**（`'B look at this'` / `'C and this'`）⇒ 走**文本档** ⇒ `attachmentIdentity` **根本不被调用** ⇒ T13 在 ⑤ 下**恒绿**。施工方按表实跑会得到「变异存活」的假信号，按 §4.3 纪律还得去"补断言"，白做工 | ⑤ 的预期变红改为 **T3 两臂 + T4(修正版)**；T13 移到 ⑨ 的预期里（⑨ 确实咬 T13） |
| **m3** | minor | §4.1 T1 / T2 | **夹具文本未钉死 ⇒ 变异 ② 可能存活**。T1 只写了 `history=[h:new('X'), h:old, h:tail]`，`h:old`/`h:tail` 的文本**未指定**；若 `h:tail` 也是 `'X'`，变异 ②（`cursor` 改回 `anchorIndex+1`=2）会命中 `h:tail` ⇒ 输出仍是 3 行 ⇒ **T1 变绿、②存活**。T2 的 `h:u4` 同理（②下 `cursor=6`，若 `h:u4` 文本与候选同则存活） | T1 显式写 `h:old('decoy-old')` / `h:tail('decoy-tail')`；T2 显式写 `h:u4('D unrelated')`。§4.1 的「T1 写法提示」要扩到 T2 |
| **m4** | minor | §2.2 `foldIdentity` / §4.3 | **`mode` 是跨档伪造的唯一防线，却没有变异对钉它**。文本档 key 是**裸文本**，附件档 key 是 **JSON 串**；若施工方只比 `key` 不比 `mode`，用户输入字面量 `[["image","image/png"]]` 就能与一条 image-only 历史行同 key ⇒ 该文本消息走**普通 fold 被删除**（无附件 ⇒ `isFoldable` 真）⇒ **丢失方向**。规格的注释只论证了「JSON 编码防 mediaType 伪造分隔符」，没论证跨档 | 补**第 10 对变异**：比较式去掉 `mode` 相等；配一条新用例（文本恰为 `[["image","image/png"]]` 的候选 + image-only 历史行，期望 kept）。或在 `attachmentIdentity` 前缀一个不可能出现在文本里的哨兵 |
| **m5** | minor | §4.1 T6 / T14 | **纯重复**。T6「既有 `:68` 夹具逐字复用」、T14「既有 M1（`:243`）夹具逐字复用」——两条新用例与既有用例入参完全相同，只多一句 `merged.length` / 注释。双份维护，且让「17 条新增」的数量虚高 | 改为**就地**给 `:68` / `:243` 补 `merged.length` 断言与新标题（§5.1 的「既有零改动」相应改为「两条补断言」），不新开用例 |
| **m6** | minor | §2.1 值层表 | **只覆盖 Carrier A，漏掉 Carrier B**。`historyReader.ts:656-693` 的 `extractControlAttachment`（独立 `attachment` 记录）对 image 行**会**产出 `name`（取 `att.name/filename/path` 走 `baseName`，`:684-687`），且无 `media_type` 时 `inferMediaType` 回落 `'image/*'`（`:612-616`）。⇒ 规格「`name` 在 image 路径上**结构性**不等」只对 Carrier A 成立；「`mediaType` 逐字往返」对 Carrier B 不成立。**结论（排除 name / 保留 mediaType）不变且仍安全**（更宽的匹配在附件档只会 replacement fold，见 m10），但论证不完整 | §2.1 补一行 Carrier B；并把「Carrier B 的 `image/*` 与运行时 `image/png` 失配 ⇒ 该类行修法不生效、持续重复」登记为**新残留 R5**（安全方向） |
| **m7** | minor | §2.1、§0.2 D-3、§2.1 表 | **行号引用漂移四处**：① `MessageAttachmentMeta` 实为 `runtimeEvents.ts:**208-212**`（规格写 `:182-186`，该处是 `SessionStatusEvent`）；② F2 红线实为 F2 定稿 `:**1015**`（规格写 `:1000`，该行是 `middleColumnLayout.ts` 的行）；③ `ChatMessageAttachment` 起于 `chatSessions.ts:**166**`（规格写 `:167-171`）；④ `historyReader` 图片无名注释在 `:**635-638**`、push 在 `:**641-645**`（规格写 `:634-636` / `:637-647`）。施工定稿的 `file:line` 是施工方唯一的取证入口 | 逐条订正 |
| **m8** | minor | §5.1 | **自相矛盾**：同一格里既写「既有 26 条**零改动**」又写「仅 `:323` 补标题与注释一句」。§4.2 也同时说「零改动保持绿」与「标题与注释需补一句」 | 统一表述为「既有 27 条**断言零改动**；`:323`（+m5 的 `:68`/`:243`）补标题/注释」 |
| **m9** | minor | §2.4 | **匹配循环的比较式没有给代码**。§1.7 给了 guard 3a/3b 的真 diff，§2.4 却只有散文「改写为 role + mode + key 三元等值」。关键未定：`foldIdentity(historyRow)` 返回 **null** 时（无文本无附件的历史行，如既有 `:333` 的 `h2('   ')`）如何比较？写成 `foldIdentity(c)?.key === identity.key` 靠 `undefined !== string` 隐式兜住，写成解构则会抛。T9 覆盖了这个行为但没有代码约束 | §2.4 补出与 §1.7 同等分辨率的真 diff，显式写出 `const other = foldIdentity(candidate); if (!other \|\| other.mode !== identity.mode \|\| other.key !== identity.key) continue;` |
| **m10** | minor | §2.3 第一层 | **「计数守恒」的真正证明被漏写，规格绕了远路**。事实上：附件档命中**必然是 replacement fold**——落进附件档 ⇒ `attachments.length > 0` ⇒ `isFoldable` 恒 **false**（`:157-159`）且 `isReplacementFoldable` 恒 **true**（`:175-178`）⇒ `historyReplacements.set(...)`（`:254`）⇒ **只换元素不改长度**。所以附件档**在任何配对方式下都不可能删除气泡**，比 §2.3 用「单射 + 不改条数」绕出来的论证强得多，也直接封死 m4 之外的一切丢失路径 | 把这条写进 §2.3 第一层与 `historyReplayMerge.ts` 头注：**「附件档 ⇒ 必为 replacement fold ⇒ 结构上不可丢失」** |

---

## §4 洞 A 攻击场景逐条推演（旧代码 / 新规则 两份走位）

约定：`C` = `snapshot.candidateIds`，`A` = `anchorHistoryId`，「旧」= `historyReplayMerge.ts:211-218` 现状，
「新」= §1.7 的 `cursor = 0` + 循环内 `if (candidateIds.has(candidate.id)) continue;`。
判定口径：**丢失** = 某条运行时消息被 fold 掉而 replay 中没有它的真副本；**重复** = 泡数多一。

### A-1 P1（重发同文本消息在候选集内）—— 既有 `:68`

入参 `bucket=[h:old-1('你好'), h:old-2('[Request interrupted]'), user-resend('你好')]`，
`history=[h:old-1, h:old-2]`，`C={h:old-1,h:old-2,user-resend}`，`A='h:old-2'`。

- **旧**：`anchorIndex=1` ⇒ `cursor=2` ⇒ 循环不进入 ⇒ `matchedAt=-1` ⇒ kept。输出 3 泡。
- **新**：`cursor=0` ⇒ `i=0` `h:old-1` role/文本全中，**但 `C.has('h:old-1')` 真 ⇒ 跳** ⇒
  `i=1` 文本不符 ⇒ `matchedAt=-1` ⇒ kept。输出 3 泡，**逐字相同**。
- **判定：重复（安全）。防线换人成功。** 且 §1.4 的加强主张成立：把 `A` 改成 `null`（T7）新规则仍守住，旧代码会吃掉。

### A-2 P2（二次 replay 吃尾巴 / 整回合未刷盘）—— 既有 `:133`

`bucket=[h:t1u,h:t1a,user-t2('继续'),asst-t2('好的')]`，`history=[h:t1u('继续'),h:t1a('好的')]`，
`C=` 全 4 条，`A='h:t1a'`。

- **旧**：`cursor=2` ⇒ 两条候选都扫不到任何行 ⇒ 双 kept。
- **新**：`cursor=0`；`user-t2` 在 `i=0` 命中 `h:t1u` 的 role+文本，**`C.has('h:t1u')` 真 ⇒ 跳**；
  `i=1` role 不符 ⇒ kept。`asst-t2` 在 `i=1` 命中 `h:t1a`，**`C.has` 真 ⇒ 跳** ⇒ kept。
- **判定：重复（安全）。** 这是 3b 承重最直接的一例——**旧代码靠锚点、新代码靠准入，两者在这里独立等效**。

### A-3 陈旧 replay 交错

`takeResumeSnapshot`（`:121-131`）要求 `requestId` 相等，陈旧 replay 拿到 `null` ⇒ 走 `:197-201` 早退
（`[...historyMessages, ...runtime]`，只做前缀替换，一行不折）。它会把 bucket 的 `h:*` 集合整批换成自己的行，
于是**当前渲染中的 `h:*` 行可能不在 `C` 里**（`C` 冻结于快照时刻）。

- **旧**：随后的正牌 replay 用冻结的 `A`；只要 `A` 还在文件里，`cursor=anchorIndex+1`。
- **新**：那些「陈旧 replay 引入、不在 `C` 里」的行被判为**新行**，可吸收回声。
- **是否新增丢失面**：**否**。由 V2 定理，陈旧 replay 读的是同一个 JSONL（同一 sessionId），
  行 id 稳定（实测 0/3234 缺 uuid）⇒ 它引入的行要么与 `C` 重合，要么位于 `A` **之后**（追加尾部）
  ⇒ 旧规则本来就够得到。**两条规则在此处等价。**
- **判定：无差异。** 头注 `:36-40` 冻结锚点的理由（防陈旧 replay 把未折回声推到 `h:*` 之后）**在新规则下依然需要**，
  因为 `C` 与 `A` 是同一次冻结的两半——规格 §1.3 说「guard 1 一字不改且承重加倍」是对的。

### A-4 截断读窗（`truncated: true` 的协议合法成功）—— 既有 `:174`

- **旧**：`A` 在 replay 中缺席 ⇒ `:213-216` 整体 bail，一行不折 ⇒ 候选保留。
- **新**：§1.7 保留同一段（降格为 3a）⇒ 行为逐字不变。
- **必须保留的理由（我复核并加强了规格的说法）**：`A` 消失的场景里 id 连续性已断，
  此时 `C` 里的 id 与 replay 里的 id 不再同源 ⇒ **每一行都会被判为「新行」** ⇒ 3b 全面失效 ⇒ 退化为 v1 全域游走。
  **3a 是 3b 的前提条件，不是冗余守卫。** 变异 ③ 咬这条，配对成立。
- **实查补强**：本仓库的淘汰只发生在**头部**（`pushMessage :750-755` 的 `shift`；`openTailLines :390-410` 尾窗），
  所以 `A`（bucket 里最后一条 `h:*`）被淘汰需要一次**极端的窗口跃迁**——低频但确实可达（JSONL 被重写、会话被 compact）。

### A-5 replacement fold × 新鲜度准入（P-1 正面场景，本修法的目标）

`bucket=[h:u1,h:a1,E1003,h:a2,E1005,h:a3,h:u4,h:a4]`（上一轮 fold 的产物），
`history=` 8 条 `h:*`，`C=` 上述 8 个 bucket id，`A='h:a4'`。

- **旧**：`anchorIndex=7` ⇒ `cursor=8` ⇒ `E1003`/`E1005` 均 `matchedAt=-1` ⇒ 双 kept ⇒
  输出 `[8 行历史…, E1003, E1005]` = **10 泡**，两条文本各出现两次，且两条副本被垫在最新输入正上方
  ——**与用户原述逐字吻合**。
- **新**：`cursor=0`；`E1003` 跳过 `h:u1/h:a1`（∈`C`），命中 `h:u2`（∉`C`，新行）⇒ `matchedAt=2`、`cursor=3`、
  `historyReplacements[2]=E1003`；`E1005` 跳过 `h:a2`（∈`C`），命中 `h:u3` ⇒ `matchedAt=4`。
  输出 `['h:u1','h:a1',E1003,'h:a2',E1005,'h:a3','h:u4','h:a4']` = **8 泡**，附件 chips 在位。
- **判定：修复成立。** 再跑一轮（`C` 变为这 8 个 id，`A='h:a4'`）⇒ `h:u2/h:u3` 仍 ∉`C` ⇒ 折回同下标 ⇒ **不动点**。

### A-6 F8 兄弟分支平铺行混入

`historyReader` 的 `JsonlEntry`（`:441-451`）**无 `parentUuid`**，废弃分支与保留分支被平铺进同一条 replay，
且「中断后重发同一句」正是分支的典型成因 ⇒ **两条同文本 user 行必然相邻出现**。

- **两行都已 hydrate**（常态）：两行都 ∈`C` ⇒ 新规则**双跳过** ⇒ 候选 kept ⇒ 重复（安全）；
  旧规则若锚点在两行之后也 kept。**等价。**
- **两行首次出现**（分支刚落盘）：两行都在 `A` 之后 ⇒ 旧规则同样够得到 ⇒
  **两条规则都会命中"文件序在前"的那条（废弃分支）**，把回声折进废弃分支行。
  若回声带附件 ⇒ replacement fold ⇒ 泡数守恒、位置偏一格；若不带附件 ⇒ 回声被删、保留分支行仍在 ⇒ 泡数 −1 但内容同文本。
  **这是今天就存在的行为，本修法未加剧。**
- **判定：无新增暴露。** 规格 §5.3「F8 是 F11 的增强，不是前置」成立；
  §5.3 关于「F8 剪枝后若锚点被剪掉 ⇒ 3a bail ⇒ 短暂退回重复态」的推演我复核**成立**（剪枝只删行、不造新行，
  不会制造新的准入面）。

---

## §5 变异 9 对逐对评估（承重行 / 必红用例 是否真咬合）

| # | 变异 | 规格声明的必红 | 我的实推 | 裁定 |
|---|---|---|---|---|
| **①** | 删 `if (candidateIds.has(candidate.id)) continue;` | T6 + T7 + 既有 `:68` | 既有 `:68`：`cursor=0` + 无准入 ⇒ `user-resend` 在 `i=0` 命中 `h:old-1` ⇒ 输出 `['h:old-1','h:old-2']` ≠ 期望 ⇒ **红** ✔。T7（`A=null`）同理 **红** ✔。T6 = `:68` 的复本（m5） | **咬合**。承重行确实是 3b 那一行；这是全批最重要的一对 |
| **②** | `cursor = 0` 改回 `anchorIndex + 1`（并恢复 `findIndex`） | T1 + T2 + T17 | 三条都依赖「诱饵行文本 ≠ 候选文本」——**T1 的 `h:old`/`h:tail`、T2 的 `h:u4` 文本未指定**（m3）。若同文则变异存活 | **条件咬合**。必须先钉死夹具文本，否则是空壳 |
| **③** | 删 guard 3a 整块 | 既有 `:174` | 删后 `cursor` 恒 0；`user-t1` 在 `i=0` 命中 `h:new`（∉`C`）⇒ 输出 `['h:new']` ≠ `['h:new','user-t1']` ⇒ **红** ✔ | **咬合** |
| **④** | `attachmentIdentity` 丢掉 `mediaType` | T8 | key 两侧同为 `[["image"]]` ⇒ 误折 ⇒ 输出 `['user-s-3001']` ≠ `['h:x1','user-s-3001']` ⇒ **红** ✔ | **咬合** |
| **⑤** | `attachmentIdentity` 加回 `name` | T3 两臂 + T4 + **T13** | T3/T4：运行时有 `name:'a.png'`、历史无 ⇒ key 不等 ⇒ 不折 ⇒ **红** ✔。**T13 恒绿**——T13 源自 T2，T2 走文本档，`attachmentIdentity` 不被调用（m2）。且 T4 是 T3(a) 复本，鉴别力 0（M5） | **半咬合**：T3 臂成立；T13 臂**不成立**，T4 臂**无效** |
| **⑥** | 文本档改合取 `key = text + attachmentIdentity(m)` | 既有 M1 `:243` + T14 | M1 运行时 `attachments:[{kind:'image'}]`（**无 mediaType**）⇒ key = `'look at this'+'[["image",""]]'`；历史 `h1` 无附件 ⇒ key = `'look at this'` ⇒ 不等 ⇒ 不折 ⇒ **红** ✔ | **咬合**。T14 是 M1 复本（m5） |
| **⑦** | 恢复 `if (coverageText(message).length === 0) { kept; continue; }` | T3 两臂 + T4 + T11 + T12 | 四条都是 image-only 候选 ⇒ 全部提前 kept ⇒ 全 **红** ✔（T4 为复本，实际鉴别力落在 T3/T11/T12） | **咬合** |
| **⑧** | `cursor = matchedAt + 1` → `= matchedAt` | T15 + 既有 `:188` 单史行半边 | `:188` 单史行：`echo-1` 命中 `h1`、`cursor=0`；`echo-2` 再次命中 `h1` ⇒ 输出 `['h1']` ≠ `['h1','echo-2']` ⇒ **红** ✔。T15：两条候选都写 `historyReplacements[0]`，后者覆盖前者 ⇒ `merged[0].id==='echo-2'` ≠ `'echo-1'` ⇒ **红** ✔（注意 T15 的 `merged.length===2` 断言**不会**变红，承重的是 id 断言——规格要写明） | **咬合**，但 T15 的承重断言需在规格里点名 |
| **⑨** | `set(matchedAt, …)` → `set(historyMessages.length - 1, …)` | T2 + T13 | 两条候选都写下标 7，后者覆盖 ⇒ `merged` = `[h:u1,h:a1,h:u2,h:a2,h:u3,h:a3,h:u4,E1005]` ⇒ ids/attachments 双红 ✔ | **咬合** |
| **⑩（缺）** | — | — | **缺一对**：比较式去掉 `mode` 相等（m4）。这是文本档消息被**删除**的唯一漏点，今天无任何用例守 | **必须补** |

**变异总账**：9 对中 **7 对真咬合**、**1 对条件咬合（②，需先钉夹具文本）**、**1 对半咬合（⑤，T13 臂错、T4 臂无效）**，
另**缺 1 对（mode）**。空壳用例 **1 条（T4）**、纯重复用例 **2 条（T6、T14）**。

---

## §6 既有 27 条在新规则下的逐条存亡复核（我亲自走位，非引用）

| 用例（行号） | 新规则关键走位 | 结论 |
|---|---|---|
| `:36` crime scene | `A=null`；`h1` ∉`C` ⇒ 准入 ⇒ 折 | 绿 |
| `:47` watermark 新消息 | `C=∅` ⇒ `:227-230` 直接 kept，不进循环 | 绿 |
| `:59` null snapshot | `:197-201` 早退 | 绿 |
| `:68` P1 | `h:old-1` ∈`C` ⇒ 3b 跳；`h:old-2` 文本不符 ⇒ kept | 绿（防线换人） |
| `:91` G14 codex | `codex-user` 折进 `item-1`（∉`C`）；`codex-asst` 含 `tool_call` ⇒ 不可折 ⇒ 尾部 | 绿（L6 现行为不变） |
| `:133` P2 | `h:t1u`/`h:t1a` 均 ∈`C` ⇒ 双跳 ⇒ 双 kept | 绿 |
| `:151` 尾回合入 replay | `h:t2u`/`h:t2a` ∉`C` ⇒ 分别折 | 绿 |
| `:174` 锚点失踪 | 3a bail | 绿 |
| `:188` 计数守恒（双臂） | 双史行臂：`h1`(0)→`h3`(2)；单史行臂：`echo-2` 扫不到 ⇒ kept | 绿 |
| `:206` match-required | `echo-b` 无匹配 ⇒ kept | 绿 |
| `:215` 前向单调 | `echo-b`→`h-b`(1)，`echo-a` 从 2 起扫不到 | 绿 |
| `:225` 读失败 | `:192-194` 早退 | 绿 |
| `:234` 空历史 | 同上 | 绿 |
| `:243` M1 replacement | 文本档；`h1` 无 attachments 也照折（**分档 ≠ 合取的承重用例**） | 绿 |
| `:263` 无匹配保留 | 文本不符 ⇒ kept | 绿 |
| `:280` 附件 + tool_call | `isFoldable`/`isReplacementFoldable` 双假 ⇒ `:232-235` kept | 绿 |
| `:298` M2 permission_request | 同上 | 绿 |
| `:314` role=error | `isFoldable` 假 | 绿 |
| `:323` 无 coverage text | `user-tool`（tool_call 块）在 `:232-235` 就 kept；`user-empty` 走新 `foldIdentity` ⇒ 无文本**且**无附件 ⇒ `null` ⇒ kept | 绿（标题需补「and no attachments」，否则合同陈述与实现不符——规格 §4.2 已识别，保留） |
| `:340` role 相等 | role 不符 | 绿 |
| `:349` 拼接文本块 | `coverageText(h1)='答'` ⇒ 文本档命中 | 绿 |
| `:369` 纯函数性 | 无写入 | 绿 |
| `:389`/`:399`/`:404`/`:412`/`:423` registry 5 条 | `snapshotResumeCandidates`/`takeResumeSnapshot` **一字不改** | 绿 ×5 |

**结论：27 条全绿，与规格的存亡判断一致（只是基数写错了，m1）。**

---

## §7 洞 B 专项：我攻过但**没打穿**的三条（记录以固化结论）

1. **「两条不同截图皆空文本时的误折方向」**——规格 §2.3 的答案是对的，但论证绕远了。
   直证：落进附件档 ⇒ `attachments.length > 0` ⇒ `isFoldable` 恒 false（`:157-159`）
   且 `isReplacementFoldable` 恒 true（`:175-178`）⇒ **必然走 `historyReplacements.set`（`:254`）**
   ⇒ 只换元素不改数组长度（`:261`）⇒ **附件档在结构上不可能删除气泡**，最坏只是 `name` 挂错泡。
   R1 的定级（chip 名归属漂移，非气泡丢失）**成立**。见 m10。
2. **「attachments 两侧形状同构」**——类型层实查成立：
   `MessageAttachmentMeta`（`runtimeEvents.ts:208-212`）/ `HistoryAttachment`（`sessionHistory.ts:50-54`）/
   `ChatMessageAttachment`（`chatSessions.ts:166-171`）三处**同三字段**。
   到达合并层也实查成立：运行时 `chatSessions.ts:658`（`...(event.payload.attachments ? {attachments} : {})`）；
   历史 `:469-471` 经 `mapHistoryAttachment`（`:446-452`）逐字段拷贝。
   **⇒「零改 `chatSessions.ts` 即可拿到两侧附件」成立。** 值层的 Carrier B 缺口见 m6。
3. **「运行时 image-only 消息的 blocks 形状」**——实查成立且比规格更确定：
   `beginTurn` 无条件发 `message.delta`（`eventNormalizer.ts:461-466`），
   `appendTextBlock`（`chatSessions.ts:475-496`）**无条件 push** 一个块（不因空串跳过）
   ⇒ 运行时 image-only 消息的 blocks **恒为** `[{type:'text', text:''}]`。
   T3 的 (b) 臂（`blocks: []`）在本 app 内**无生产者**，属协议防御，保留无害但应在注释里标明。

---

## §8 施工前必做处置清单（按优先级）

| 优先级 | 项 | 对应发现 |
|---|---|---|
| 1 | **T2 换成可产生的 P-1 夹具**（§2 M1 给了完整入参）；删除或降格 §3.0 的「首尾自洽」断言 | M1 |
| 2 | **写出 INV-P4（空洞配对）**，进 §1.6 + 模块头注；订正 §1.3 关于顺序倒置的错误论证；明文登记「本模块无丢失性依赖 bucket 只增不删」这条跨模块前置 | M2 |
| 3 | **订正 §1.5 生产者表**（P-2 实测 0/3234 无 uuid 行 + 需 >32MiB 尾窗；P-3 结构不产生该条件）；**§4.5 回滚改为有序**：洞 B 可单退，洞 A 不可在洞 B 生效时单退 | M3 |
| 4 | **删掉 §4.5/§6.2 的「snapshot:null 双轮全量」**，换成「只落洞 A → 全量（部分红）→ 再落洞 B → 全绿」的分步发射证据 + 一次回滚演练 | M4 |
| 5 | **T4 换成留有存活 `h:*` 行的两轮夹具**（§2 M5 给了形状）；最好把 T2/T4/T17 写成自生成两轮链 | M5、M1 |
| 6 | **钉死 T1/T2 夹具里所有诱饵行的文本**；扩写 §4.1 的「写法提示」到 T2 | m3 |
| 7 | **补第 10 对变异（去掉 `mode` 相等）+ 配套用例**；或给 `attachmentIdentity` 加哨兵前缀 | m4 |
| 8 | **订正变异 ⑤ 的必红集**（去 T13，T13 归 ⑨）；点名 T15 的承重断言是 id 而非 length | m2、m8(⑧) |
| 9 | **基数订正 26→27、43→44**，并补做被漏掉那条的复核 | m1 |
| 10 | **§2.4 补出与 §1.7 同分辨率的比较式真 diff**（含 `foldIdentity` 返回 null 的显式分支） | m9 |
| 11 | **§2.1 补 Carrier B**（`historyReader.ts:656-693`），登记新残留 **R5**（Carrier-B image 行 `image/*` 失配 ⇒ 修法不生效，安全方向） | m6 |
| 12 | **把「附件档 ⇒ 必为 replacement fold ⇒ 结构上不可丢失」写进头注与 §2.3** | m10 |
| 13 | 行号引用四处订正；§5.1 的「零改动 / 补一句」自相矛盾统一；T6/T14 改为就地补断言 | m7、m8、m5 |

---

## §9 一句话收束

**修法本体我攻不破，规格的证据链我攻破了。**
洞 A 的「起点下放 + 逐行准入」在三条已实查为真的系统前提（追加写只从头淘汰、行 id 全带 uuid、bucket 只增不删）下，
是今天游标下界的**严格超集**，新增部分恰为 replacement fold 挖出的空洞、且与 bucket 中的运行时副本**一一配对且序同调**——
构造不出丢失；洞 B 的分档在附件档必然走 replacement fold，**结构上不可能删泡**。
但规格的旗舰场景 §3.1/§3.2 在真实系统里**不可产生**（追加写的前缀性质 + 读侧只从头淘汰双重证伪），
三个生产者里**两个被实测/结构证伪**，「无丢失」的真正证明（INV-P4）**从未写出**，
回滚独立性主张**有一半是反的**（洞 B 单独生效会亲手制造 P-1 空洞），
flag 豁免的代偿方案**不可执行**，测试合同里有 **1 条空壳、2 条纯重复、1 对错配变异、1 处夹具欠钉、1 对缺失变异**。

**裁定：修订后开工。** §8 的前 5 项属于「不改则 as-built 的发射证据是假的」，必须在动工前落定；
第 6~13 项可与施工同批修订，但要进 as-built 的偏差条目。
