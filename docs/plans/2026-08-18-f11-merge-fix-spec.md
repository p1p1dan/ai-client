# F11 修法施工规格：重发后带图片的历史用户消息在时间线重复

- 版本：**rev.2**（rev.1 = 双轨评审前的施工定稿；本稿按仲裁 §3 的 R-1 ~ R-23 全量修订）
- 日期：2026-08-18
- 上游：`docs/plans/2026-08-18-f11-resend-dup-rca.md`（根因已定案，本稿不重做 RCA）
- 评审与仲裁：`docs/plans/2026-08-18-f11-reviews/trackA-opus.md`、`docs/plans/2026-08-18-f11-reviews/trackB-codex.md`、
  `docs/plans/2026-08-18-f11-arbitration.md`（总判「修订后开工」；三版台架 `/tmp/f11arb/{v0,v1,v2}.ts` + `drive2.ts`）
- 约束基线：`src/renderer/stores/historyReplayMerge.ts:1-63` 头注（v1 被双轨评审否决的两个反例 + 三 guard 合取语义）
- 现有合同：`src/renderer/stores/__tests__/historyReplayMerge.test.ts`（**27 用例** = `mergeReplayedHistory` 22 + `resume snapshot registry` 5；`grep -c "  it("` 实测）
- 交付性质：**施工定稿**。施工方读本文即可动工；每条裁定都附 `file:line` 证据与反例推演。
- 代码基线：`487b0c3`（分支 `feat/openchamber-chat-refactor`）
- **全文唯一计数口径**：收口门判定 **48 条**（既有 27 + 新增 21 = N1~N21）、变异 **15 对**（①~⑮）。
  rev.1 的 21/26/43 条用例与 9 对变异口径全文作废。

---

## rev.2 修订摘要（仲裁 R-1 ~ R-23 逐条落点）

> 本节是 rev.1 → rev.2 的差异索引。**R-1 ~ R-11 为承重改动**（不改则按 rev.1 施工必然出丢失或卡死），
> **R-12 ~ R-23 为证据链/合同订正**。凡 R 条目与 rev.1 文件实况冲突者，在「处置」列登记原委。

| R | 落点节号 | 处置 |
|---|---|---|
| **R-1** | §0.3 · §1.2 · §1.3 · §1.7 | 已执行：`id ∉ candidateIds` 由「锚点下界的替代机制」降级为 guard 3b **纵深防御**；锚点前的认领改由 3d 对齐探针 + 3e 定位空洞认领承担 |
| **R-2** | §1.7 · §1.3 | 已执行：`cursor` 初值退回 `anchorIndex + 1`（今天的语义），全文删除「起点下放到 0」口径 |
| **R-3** | §1.7 · §4.1 · §5.1 | 已执行：`ResumeSnapshot` 新增 `orderedIds`；生产者 `snapshotResumeCandidates :96-114` 与 `takeResumeSnapshot :121-131` 均在本文件内改；测试 `snap()` 助手 `:28-31` 加字段；`chatSessions.ts` 仍零改 |
| **R-4** | §1.3 · §1.7（guard 3d） | 已执行：对齐探针 `orderedIds.indexOf(anchorHistoryId) === anchorIndex` |
| **R-5** | §1.6 · §1.7（guard 3e） | 已执行：定位空洞认领五条件，空洞只能被挖它的那条回声认领 |
| **R-6** | §1.6 INV-P1 | 已执行：键唯一改由「已认领下标集合 + 两区不相交 + 游标单调」三重保证 |
| **R-7** | §1.3 · §1.4 | 已执行：guard 表拆成 3a/3b/3d/3e；两个 v1 反例推演按新机制重跑（结论不变，机制换人） |
| **R-8** | §2.2 · §2.4 | 已执行：附件档两条前置（锚点非空；只在锚点后新尾区或本回声自己的定位空洞里折） |
| **R-9** | §2.3 | 已执行：全节推翻重写，删掉「计数守恒 ⇒ 不会少气泡」「最坏只是 chip 名归属漂移」「四道闸门」三段结论 |
| **R-10** | §3.4 | 已执行：`anchor=null` 专项夹具改判为「不折」，另加锚点非空的洞 B 正控（N6/N7） |
| **R-11** | §2.2 · §2.4 | 已执行：附件档要求历史行 attachments **全部无 `name`**（Carrier-A 签名） |
| **R-12** | §1.5 | 已执行：P-1 提为唯一可达生产者；P-2 降为理论项（实测 0/101319 行缺 uuid、0/694 文件 >32MiB）；P-3 机制改写 |
| **R-13** | §1.6 | 已执行 + **冲突登记**：新增 INV-P4 并写明由 3e **强制**而非假设；但「本模块无丢失性依赖调用方 bucket 只增不删」这句在 rev.1 全文并不存在（§1.6 只有 INV-P1~P3），无从删除 ⇒ 改为在 INV-P4 正文里正面声明「不依赖该外部性质」 |
| **R-14** | §3.0~§3.3 · §3.5 · §4.1 | 已执行：§3.2 旗舰场景换成**可产生**的 P-1 犯罪现场夹具；rev.1 的 RCA 合成入参降级存档进 §3.5，标注「不可产生 · 在 rev.2 规则下不复现缺陷 · 不得抄成夹具」；rev.1 T2 → N1/N2 |
| **R-15** | §4.5 · §6.2 | 已执行：删「模块天然自带 off 位」与「off/on 双轮全量」，换成分步发射证据（只落洞 A → 全量 → 再落洞 B → 全绿） |
| **R-16** | §4.5 | 已执行：回滚改**有序**，只留两种合法安全态；加一次退洞 B 的回滚演练 |
| **R-17** | 文首 · §4.2 · §4.4 · §5.1 | 已执行：既有基线 27、收口门判定 48。N5/N13/N17 三条是就地补在既有块上的断言，块数与判定数的对账见 §4.2 脚注 |
| **R-18** | §4.1 | 已执行：rev.1 T4 空壳换成 N7（有存活 `h:*` 行的两轮夹具）；T6/T14 改为 N5/N17 就地补断言，不新开块 |
| **R-19** | §4.3 | 已执行：变异表重建为 15 对，删掉原⑤的 T13 臂，补齐新承重行 |
| **R-20** | §0.2 · §2.1 | 已执行 + **冲突登记**：R-20 把四处行号统挂在 §2.1，实况是 F2 红线 `:1000` 落在 §0.2 D-3（已就地订正为 `:1015`），其余三处在 §2.1 订正；`ChatMessageAttachment :167-171` 按裁定**保持原样**（A 轨 m7③ 是误报） |
| **R-21** | §5.2 · §2.4 · §6.1 | 已执行 + **口径登记**：新增残留 R5/R6/R7 与头注订正；R6 要求的 incident 层回归用例登记在 §5.2，按仲裁 §4 的 21 条口径**不计入收口门 48**（incident 层独立套件，随 F11-b 走） |
| **R-22** | §4.0 · §4.1 | 已执行：T1~T17 整表换成 N1~N21，每条标注「v0 应红 / 应绿」 |
| **R-23** | §2.4 · §6.1 步骤 5 | 已执行：头注要求由三 guard 改写为**五 guard**（1 / 2 / 3a / 3d / 3e，3b 降纵深），并写明附件档三前置与 R6/R7 残留 |

---

## §0 裁定结论（先读这一段）

### 0.1 一句话裁定

**a 单独闭环，本批全量施工；b 降级为另立票 `F11-b`，带前置探针门与 F2 解冻条件。**
形式上是**有序合取**（a now → b later），不是二选一，也不是同批合取。

### 0.2 为什么不是同批合取（三条硬理由，各带证据）

| # | 理由 | 证据 |
|---|---|---|
| D-1 | **b 不能取代 a**：codex 轴的历史行 id 是 `h:codex:<namespacedItemId>`，压根没有 JSONL uuid 这个东西，b 的「精确 id 等值」在 codex 轴无源可用 | `src/agent-host/codexHistoryReader.ts:43,253`；既有钉子 `historyReplayMerge.test.ts:116-118`（`h:codex:T:turn-1:item-1`） |
| D-2 | **b 今天不可规格化**：运行时用户回声的 id 是 Host 在**发送前**自铸的 `user-${sessionId}-${Date.now()}`，那一刻 SDK 还没写 JSONL、也没回过任何 uuid；而 `eventNormalizer` 的 `case 'user'` 分支今天**只抽 tool_result**，用户提示回声在那里不产出任何东西。「`SDKUserMessageReplay.uuid` 与 JSONL 行 `entry.uuid` 相等」是一条**未实证的信念**，本仓库无任何探针 | `src/agent-host/eventNormalizer.ts:441`（id 自铸）、`:1259-1266`（`case 'user'` 只走 tool_result / 子代理）；`src/agent-host/historyReader.ts:905-908`（行 id = `h:${entry.uuid}`）；`src/agent-host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:4595,4626-4629`（`uuid: UUID` / `isReplay: true`） |
| D-3 | **b 撞 F2 红线**：b 必须改 `chatSessions.ts`（存 canonical uuid 到 `ChatMessage`）与 `runtimeEvents.ts`（协议加法）。F2 定稿把 `chatSessions.ts` 列为**红线文件、零改动**，并明文「若发现必须改，先停下来单独立项」 | `docs/plans/2026-08-18-f2-watchdog-redesign-spec.md:13`、`:1015`（rev.2 按仲裁 R-20 订正，原稿 `:1000` 已漂移） |

### 0.3 a 单独闭环的证明义务（本稿逐条兑现）

a = 两处纯函数改动 + 一处快照字段加法（`ResumeSnapshot.orderedIds`，生产者与消费者都在本文件内），
**全部落在 `historyReplayMerge.ts` 一个叶子模块内**，零改 `chatSessions.ts`（合并层今天已经能读到两侧 attachments，见 §2.2）：

1. **洞 A**：`anchorHistoryId` **保留**其游标下界语义（`cursor = anchorIndex + 1`，与今天逐字相同），
   同时继续充当「id 连续性前置条件」；锚点**之前**的认领另开一条**精确**通道——
   **guard 3d 对齐探针** + **guard 3e 定位空洞认领**（只认「上一轮被自己这条回声挖出的那个下标」）。
   `id ∉ candidateIds` 不再承担下界职责，降级为 **guard 3b 纵深防御**（§1）。
2. **洞 B**：折叠身份分档——有文本走文本身份（原样不动），**无文本才回退到附件身份**；
   附件档另带三条前置（锚点非空 / 只在新尾区或自己的定位空洞里折 / 历史行 attachments 全部无 `name`）（§2）。

§3 用**可产生**的三轮场景逐条推演修法结果（收敛为单例且**跨 replay 幂等**）；
§4 给 21 条新增用例（收口门判定 **48 条**）+ **15 对**变异。

### 0.4 b 票（F11-b）立票要件（本批不做，写进 backlog）

- **前置探针门（不过不立项）**：实测一次「本 app 发送 → SDK 回流 → JSONL 落盘」的三元对照，回答两问：① 活发送时 SDK 是否回 `type:'user'` 且带 `uuid`；② 该 uuid 是否**逐字等于**该行 JSONL 的 `entry.uuid`。两问任一为否，b 直接作废。
- **解冻条件**：F2 收口、`chatSessions.ts` 红线解除。
- **b 的真实增益（不是重复劳动）**：只有 b 能杀掉 §5.2 的残留 R1/R3——「两张不同截图同附件身份」与「`stripSystemTags` 造成的文本漂移」（`historyReader.ts:471-480,896`）。这两条 a 只能压到「宁重复不丢失」的安全方向，杀不干净。

---

## §1 洞 A 修法：锚点保留下界 + 定位空洞认领（对齐探针把关）

### 1.1 先纠一条上游措辞，再纠 rev.1 自己的一条

RCA §4 候选 a 写着「watermark 已把候选限定为 resume 前消息，**回溯不违反 v1 反例的时间边界**」。
**这句话是错的，按字面实施会原地复活 v1 的 P1 反例。**

证据：P1 反例的受害者 `user-resend` **就在 watermark 里**——既有钉子 `historyReplayMerge.test.ts:85` 的快照写作
`snap(['h:old-1', 'h:old-2', 'user-resend'], 'h:old-2')`，`user-resend` 是候选集成员。
所以 guard 1（watermark）对 P1 **零防御能力**。

rev.1 由此得出「把游标下界整体换成逐行新鲜度准入（`id ∉ candidateIds`）」，**这一步已被仲裁 D1 推翻**：
该谓词是**全称的**，它把安全性挂在「行 id 永远稳定」这条外部信念上；
B 轨的漂移反例在台架 v1 上**实测吃掉了 `user-resend`**（3 泡 → 2 泡，真丢失）。
⇒ **下界不让位**（R-2）；准入谓词退到纵深位（R-1）；锚点前的认领另开精确通道（R-4/R-5）。

### 1.2 判据：不是「起点下放」，是「下界不动 + 精确认领上一轮自己挖的空洞」

先看三个场景的结构差异——这是全部修法的支点：

| | P1 反例（不能折） | 漂移反例（不能折） | 洞 A 现场（必须折） |
|---|---|---|---|
| 受害/目标行 | `h:old-1`（锚点前的同文本旧行） | 改号后的旧行（锚点前） | 上一轮 replacement fold 挖出的**空洞**下标 |
| 该行在快照时的 bucket 里吗 | **在**（`candidateIds` 含它） | **不在**（id 变了 ⇒ 伪装成新行） | **不在**（它的 id 已被换成运行时副本） |
| 它在 `orderedIds` 里的那一格是谁 | 是它自己（`h:old-1`） | 是**旧 id**（与本回声无关） | **正是这条回声自己的 id** |

⇒ 判据不是「这行新不新」，而是「**这一格上一轮是不是我自己**」：

> **guard 3e（新 · 定位空洞认领）**：下标 `i ≤ anchorIndex` 可被运行时回声 `X` 认领，当且仅当
> ① `orderedIds[i] === X.id`（这一格上一轮就是 `X` 自己 ⇒ 空洞是 `X` 挖的）；
> ② `historyMessages[i].id ∉ candidateIds`（该行对本次 replay 是新的，否则是已结算行）；
> ③ role 相等；④ 折叠身份相等（含 §2 的档位判定与附件档三前置）；⑤ 该下标未被认领过。
> 五条全中才认领；任一不中，一律退回「只走锚点后的前向扫描」。

这条谓词**不是全称的**：它只对「上一轮自己挖的那一格」开口，
因此不需要「行 id 永远稳定」这条外部信念——id 若真漂了，条件①当场不成立。

> **guard 3d（新 · 对齐探针）**：`orderedIds.indexOf(anchorHistoryId) === anchorIndex` 才允许任何定位认领。
> 快照里的 bucket 序 = 上一次合并的**输出序**，而输出序在锚点及其之前的区段就是历史行的文件序；
> 两侧下标一旦不等，就证明读窗右移 / 行改号 / JSONL 重写 / 中段插入了新行——
> 此时 `orderedIds[i]` 与 `historyMessages[i]` 不再指同一格，定位认领**整体关闭**。
> 一次比较同时封死 synthetic 漂移、头部淘汰、文件重写三种漂移源，且不需要认得 `synthetic-` 这个字符串。

锚点的两个旧职责**都原样保留**：

> **guard 3a（保留 · 一字不改语义）**：`anchorHistoryId` 非空却在本次 replay 里找不到
> （读窗口头部淘汰 / JSONL 被重写）⇒ **一行都不折**。这是 round-6 verify blocker 的资产：
> id 连续性一断，一切基于 id 的认领语义同时失效，必须整体停摆。
>
> **游标下界（保留 · R-2）**：`cursor = anchorIndex + 1`。前向扫描区**逐字退回今天的范围**，
> 锚点之前的行对前向扫描**不可达** ⇒ P1 反例与漂移反例的扫描面归零。

`id ∉ candidateIds` 仍留在匹配循环里，但职责换了：

> **guard 3b（保留 · 降级为纵深防御）**：已结算的历史行（快照时就在 bucket 里）不吸收任何回声。
> 它**不再承担任何独力防线**——P1 由下界挡、漂移由 3d 与 3e① 挡；
> 3b 的价值是「下界或对齐探针万一算错时，仍不会去动一条已经结算过的行」。

### 1.3 合取语义的账（逐 guard 结算）

| guard | 修改前 | 修改后 | 是否破坏合取 |
|---|---|---|---|
| 1 watermark（候选集） | `candidateIds.has(message.id)` 才可折（`:227-230`） | **一字不改**，新增第二用途：当历史行准入的反向索引（3b 与 3e②） | 否，承重加倍 |
| 2 match-required | 找不到匹配行就 `kept`（`:249-250`） | **一字不改** | 否 |
| 3a 锚点存在性 | `anchor < 0` ⇒ 整体停折（`:212-216`） | **一字不改** | 否 |
| 3 游标下界 | `cursor = anchor + 1`（`:217`） | **一字不改**（R-2：rev.1 的「下放到 0」作废） | 否 |
| 3b 逐行准入 | 无 | **新增**，纵深防御，不承重（R-1 降级） | 否，只增不减 |
| 3d 对齐探针 | 无 | **新增**，定位认领的总开关（R-4） | 否，只增不减 |
| 3e 定位空洞认领 | 无 | **新增**，唯一能触及锚点前下标的通道，五条件合取（R-5） | 否——见 §1.4 三个反例推演 |
| 前向单调游标 | `cursor = matchedAt + 1`（`:252`） | **一字不改**（只有前向扫描命中才推进；3e 认领不动游标） | 否 |

**关键澄清：本修法不引入任何「回溯扫描」。** 前向扫描的范围与今天**逐字相同**（自 `anchorIndex + 1` 起，
命中后 `cursor = matchedAt + 1`）。锚点之前只有**一条**通道进得去——3e，而它一次只开**一格**，
且那一格必须在 `orderedIds` 里写着这条回声自己的 id。因此：

- **下标碰撞不可能**：定位区（`i ≤ anchorIndex`）与扫描区（`i ≥ anchorIndex + 1`）**不相交**；
  扫描区内游标严格递增；3e 对下标是**单射**（`orderedIds` 里 id 唯一 ⇒ 一格至多一个认领者）。
  三条之上再加一张**已认领下标集合**兜底（§1.6 INV-P1，钉子 N18）。
- **顺序不可能倒置**：运行时回声按 bucket 序 = 发送序，历史行按文件序 = 发送序，两者同调；
  真出现倒置（F8 分支交错）只会「找不到匹配 → kept → 重复」，失败方向仍在安全侧。

### 1.4 三个反例在新规则下的推演（v1 两个 + 仲裁的漂移反例）

**反例 CE1（Codex blocker：同文本新消息被吃）** —— 现有用例 `:47-57`

- 输入：`bucket=[user-new('继续')]`，`history=[h-old('继续')]`，`snapshot={candidateIds: ∅, anchor: null}`
- 走位：`candidateIds.has('user-new')` 为假 → `:227-230` **直接 kept**，根本走不到匹配循环。
- 输出：`['h-old','user-new']`，**与今天逐字相同**。结论：CE1 由 guard 1 独力防御，本修法**没碰 guard 1**。

**反例 CE2 / P1（二次 replay 游标重置吃尾巴）** —— 现有用例 `:68-89`，钉子 N5

- 输入：`bucket=[h:old-1('你好'), h:old-2('[Request interrupted by user]'), user-resend('你好')]`，
  `history=[h:old-1, h:old-2]`，
  `snapshot={candidateIds:{h:old-1,h:old-2,user-resend}, orderedIds: 同序三项, anchor:'h:old-2'}`
- 走位：① guard 3a：`h:old-2` 在 replay 中（下标 1）→ 不 bail；
  ② guard 3d：`orderedIds.indexOf('h:old-2') === 1 === anchorIndex` → 对齐成立；
  ③ `cursor = 2` → **前向扫描区为空**；
  ④ guard 3e：`user-resend` 在 `orderedIds` 里的下标是 **2**，`2 > anchorIndex(1)` → 定位区上界拒绝；
  ⑤ `matchedAt = -1` → `kept`。
- 输出：`['h:old-1','h:old-2','user-resend']`，**与今天逐字相同**。失败方向 = 重复，不是丢失。
- 结论：P1 的防线**仍是游标下界**（R-2 保留）；3b 在此只是第三道冗余（`h:old-1` 确实 ∈ candidateIds）。
  rev.1「3b 独力挡住 P1、防御强度不降反升」的论断**作废**（仲裁 D1 实测证伪）。

**反例 CE3（仲裁 B-Blocker 2：synthetic 改号让旧行「变新」）** —— 新增钉子 N4

- 输入：`bucket/orderedIds=[h:old-1('你好'), h:old-2, user-resend('你好')]`，
  `history=[s-7('你好'), h:old-2]`——`h:old-1` 因读窗漂移改号为 `s-7`，对本次 replay 是「新行」，`anchor='h:old-2'`
- **rev.1 走位（台架 v1 实测）**：`cursor = 0` + 逐行准入 ⇒ `s-7 ∉ candidateIds` ⇒
  `user-resend` **被吃掉**（3 泡 → 2 泡，**真丢失**）。这正是 rev.1 必须修订的直接原因。
- rev.2 走位：`cursor = anchorIndex + 1 = 2` ⇒ 扫描区为空；3e 的定位下标 2 越过上界 ⇒ 不认领 ⇒ `kept`。
- 输出：`['s-7','h:old-2','user-resend']`（3 泡，重发留存）。台架 v2 实测一致。
- 结论：**漂移反例由 R-2 的下界直接归零**；若漂移同时造成**位移**（读窗右移的常见形态，
  行下标整体左移），guard 3d 会先一步把定位认领整体关闭 —— 两道独立防线。

### 1.5 洞 A 的真实产生机制（一个可达生产者 + 两个理论项）

RCA §2 的探针夹具是 esbuild 合成件，其字面时序（`h:a3` 已 hydrate 而 `h:u2` 尚未出现）在**追加写**的
JSONL 上不可能自然发生（两条证伪见 §3.5）。真正要修的结构条件只有一条：

> **结构条件**：存在一条历史行，它①对本次 replay 是新的，②在文件序上位于锚点行**之前**，
> ③且这一格在 `orderedIds` 里记着某条运行时回声的 id（= 上一轮正是这条回声把它换掉的）。
> 前两条是「够不到」，第三条是「有权认领」——**rev.2 只修同时满足三条的那一种**。

| 生产者 | 机制 | 可达性 | 证据 |
|---|---|---|---|
| **P-1 replacement fold 自伤** | 上一轮 replacement fold 把 `h:u2` 换成运行时副本（`:253-262`），该 id 从 bucket 消失；下一轮快照取「bucket 里最后一条 `h:*`」得到**更靠后**的行（`:102-108`），运行时副本从此永远位于锚点之前 | **唯一可达**。仲裁 §2.4 台架实测：v0 → 10 泡（两条回声垫在最尾）、v2 → 8 泡、再跑一轮为不动点 | `historyReplayMerge.ts:224,253-262` + `:102-108` |
| **P-2 synthetic uuid 不稳定** | 无 `uuid` 的 JSONL 行取 `synthetic-${totalLines}` 作 id（按行号派生）；读窗一变，同一条内容拿到不同 id | **理论项**：需「u/a 行缺 uuid」**且**「文件 > 32 MiB」两条合取。全量实测 `~/.claude/projects`：缺 uuid 的 user/assistant 行 **0 / 101319**、大于 32 MiB 的文件 **0 / 694**（最大 25.5 MiB） | `historyReader.ts:770-771`、`:905-906`、`:195`、`:700-704` |
| **P-3 分支/侧链交错（F8）** | `historyReader` 无视 `parentUuid` 平铺回放，兄弟分支行插在文件中段 | **理论项**：只抬高「同身份行密度」，**不产生锚点前的结构条件**（分支行只在锚点之后落盘，今天的游标本来就够得到） | `historyReader.ts:442-450`；`docs/plans/2026-08-17-d48-t10-inspection-triage.md:21,172` |

**两条纪律（仲裁 D6 的合取处置）**：
① 修法的必要性**只由 P-1 承担**，不得再拿 P-2/P-3 当理由——rev.1 一边拿 P-2/P-3 论证必要性、
一边拿「id 稳定」当安全性前提，逻辑自相矛盾；
② P-2 虽今天不可达，其**结构可达性**由 guard 3d 与 3e① 封住，
**不得**把「文件还没到 32 MiB」这条会过期的实测写进 as-built 当安全证据。

**P-1 是「为什么偏偏是带图的」的第二半解释**（RCA §3 洞 B 给了第一半）：
图+文消息一旦成功 replacement fold 一次，它就**把自己送进锚点盲区**，从下一次 resume 起永久重复。
所以洞 A 不是「洞 B 的兜底」，对带附件消息而言它是**必修项**。

### 1.6 replacement fold 的位置正确性与四条不变量

认领到下标后，`historyReplacements.set(matchedAt, message)`（`:254`）写入的是**历史行在文件序里的真实位置**，
渲染结果因此比今天**更**正确——今天未折叠的回声被 `[...mergedHistory, ...kept]`（`:264`）
整体垫在历史块之后，正是用户看到的「恒在最新输入正上方」。四条不变量：

- **INV-P1（键唯一）**：`historyReplacements` 这个 `Map<number, T>`（`:224`）不会有两个候选写同一个键。
  保证由三条几何性质加一张表构成：定位区（`i ≤ anchorIndex`）与扫描区（`i ≥ anchorIndex + 1`）**不相交**；
  扫描区内游标严格递增；3e 对下标**单射**（`orderedIds` 内 id 唯一 ⇒ 一格至多一个认领者）；
  此外两区**共用一张已认领下标集合**（R-6），使 INV-P1 不依赖上述任何一条单独成立。钉子 N18。
- **INV-P2（位置 = 历史序）**：替换只改 `historyMessages` 数组中该下标的**元素**，不改长度、不改顺序（`:261`）。钉子 N1/N16。
- **INV-P3（跨轮幂等）**：被换掉的历史行 id 下一轮仍不在 `candidateIds` 里，而那一格在 `orderedIds` 里记的
  正是同一条运行时副本 ⇒ 再次折进**同一位置**。钉子 N2/N7。
- **INV-P4（空洞配对）**：每个被认领的锚点前下标，与「挖出它的那条回声」**一一配对**。
  本稿用 3e 条件① **强制**该不变量，而不是假设它：认领资格由 `orderedIds[i] === X.id` 逐格检验；
  回声若已不在 bucket，认领自动不成立、退回不折。
  ⇒ **本模块的无丢失性不依赖调用方「bucket 只增不删」这类外部性质**——
  该性质今天确实成立（实查 `chatSessions.ts` 无任何消息删除路径，只有 `pendingPermissions.filter` 与块级 filter），
  但 rev.2 的正确性**不建立在它之上**。钉子 N20，变异③/④。

### 1.7 洞 A 施工 diff（`historyReplayMerge.ts`）

**(a) 快照类型与生产者加一个字段（R-3）**——生产者与消费者**都在本文件内**，`chatSessions.ts` **零改**：

```ts
export interface ResumeSnapshot {
  candidateIds: ReadonlySet<string>;
  /** Bucket ids IN ORDER at snapshot time = the PREVIOUS merge's output
   * order. Read only by the alignment probe (guard 3d) and the positional
   * hole claim (guard 3e); never used as a membership test. */
  orderedIds: readonly string[];
  anchorHistoryId: string | null;
}
```

- `snapshotResumeCandidates`（`:96-114`）：`resumeSnapshots.set` 时一并存 `orderedIds: [...orderedMessageIds]`。
  入参今天就是**按序**的 bucket ids（`chatSessions.ts:515-519` 已按序传入，实查），调用方无需改。
- `takeResumeSnapshot`（`:121-131`）：返回值一并带出 `orderedIds`。
- `:202` 解构改为 `const { candidateIds, anchorHistoryId, orderedIds } = snapshot;`。
- 测试助手 `snap()`（`historyReplayMerge.test.ts:28-31`）加同名参数，默认取 `candidateIds` 的原序（见 §4.1）。

**(b) 游标段（替换 `:204-218`，注释一并改写，英文）**：

```ts
  // Guard 3a: the anchor's PRESENCE proves `h:<jsonl-uuid>` id continuity
  // across re-reads. When the anchor row is GONE from this replay (head
  // eviction under the read caps — a protocol-legal success with
  // `truncated: true` — or a rewritten JSONL) every id is suspect. No
  // continuity proof → no folding at all. A snapshot that never had an
  // anchor (first resume) is exempt: nothing was hydrated, nothing drifted.
  const anchorIndex = anchorHistoryId
    ? historyMessages.findIndex((row) => row.id === anchorHistoryId)
    : -1;
  if (anchorHistoryId && anchorIndex < 0) {
    return [...historyMessages, ...runtime];
  }

  // Guard 3d (alignment probe): the snapshot's bucket order IS the previous
  // merge's output order, so up to the anchor it is also the history file
  // order. If the anchor sits at a different index on the two sides, the read
  // window moved, rows were renumbered, or the JSONL was rewritten — index
  // `i` no longer names the same row on both sides, so NO positional claim is
  // trustworthy. One comparison closes synthetic drift, head eviction and
  // file rewrites at once, without ever knowing the string `synthetic-`.
  const aligned =
    anchorHistoryId === null || orderedIds.indexOf(anchorHistoryId) === anchorIndex;

  // The forward cursor keeps TODAY's lower bound (R-2): rows before the
  // anchor stay unreachable to the scan, which is what stops v1's P1
  // counterexample AND the id-drift counterexample. The only way into the
  // pre-anchor region is guard 3e below, one exact index at a time.
  let cursor = anchorIndex + 1;
  const claimed = new Set<number>();
  // Attachment-tier precondition 1 (R-8), hoisted: an anchorless replay must
  // never fold the attachment tier. See §2.2 `MatchSite`.
  const tailSite: MatchSite = anchorHistoryId === null ? 'no-anchor' : 'tail';
```

**(c) 匹配循环（替换 `:236-256`）**：先试定位空洞认领，再走前向扫描；两条通道共用 `claimed`。

```ts
    const identity = foldIdentity(message);              // §2.2
    if (!identity) { kept.push(message); continue; }

    let matchedAt = -1;

    // Guard 3e: claim the hole THIS echo dug last round. `orderedIds[hole]`
    // is whoever occupied that slot in the previous output; requiring it to
    // be this very message id is what turns INV-P4 from an assumption into a
    // checked condition — an echo can only ever claim its own hole, and a
    // drifted row can never be mistaken for one.
    if (aligned) {
      const hole = orderedIds.indexOf(message.id);
      if (hole >= 0 && hole <= anchorIndex && !claimed.has(hole)) {
        const row = historyMessages[hole];
        if (
          row && row.role === message.role && !candidateIds.has(row.id)
          && identityMatches(identity, row, 'hole')
        ) {
          matchedAt = hole;
        }
      }
    }

    if (matchedAt < 0) {
      for (let i = cursor; i < historyMessages.length; i++) {
        const candidate = historyMessages[i];
        if (!candidate || candidate.role !== message.role) continue;
        if (claimed.has(i)) continue;
        // Guard 3b (defence in depth): a settled history row never absorbs an
        // echo. The bound that actually stops P1 is `cursor` above.
        if (candidateIds.has(candidate.id)) continue;
        if (!identityMatches(identity, candidate, tailSite)) continue;
        matchedAt = i;
        break;
      }
      if (matchedAt >= 0) cursor = matchedAt + 1;
    }

    if (matchedAt < 0) { kept.push(message); continue; }
    claimed.add(matchedAt);
    if (replaceFold) historyReplacements.set(matchedAt, message);
```

`identityMatches(identity, row, site)` 定义见 §2.2：role 由调用点先判，
`site` 参数承载附件档的前两条前置，三种取值——`'tail'`（锚点之后的新尾区）、
`'hole'`（本回声自己的定位空洞）、`'no-anchor'`（快照根本没有锚点）。文本档忽略 `site`。

## §2 洞 B 修法：附件感知身份（分档，不是合取）

### 2.1 两侧字段形状是否同构（实测取证）

**类型层：完全同构。** 三处定义逐字相同：

| 位置 | 定义 |
|---|---|
| 运行时线上形状 `MessageAttachmentMeta` | `src/shared/types/runtimeEvents.ts:208-212`（rev.2 按 R-20 订正；rev.1 写的 `:182-186` 已漂移）-> `{ kind: 'image' 或 'text'; mediaType: string; name?: string }` |
| 历史线上形状 `HistoryAttachment` | `src/shared/types/sessionHistory.ts:50-54` -> **同上三字段** |
| 渲染端落地形状 `ChatMessageAttachment` | `src/renderer/stores/chatSessions.ts:167-171` -> **同上三字段**（A 轨曾报此处行号漂移，仲裁实查为**误报**，原文正确，不动） |

两侧都真的到得了合并层：

- 运行时：`chatSessions.ts:658` 原样拷贝 `event.payload.attachments` 到 `ChatMessage`；
- 历史：`chatSessions.ts:469-471` 经 `mapHistoryAttachment`（`:446-452`）逐字段拷贝（不 spread）；
- 合并层：`ReplayMergeMessage.attachments`（`historyReplayMerge.ts:68-76`）——头注已写明「C-06 起历史行也带 attachments」，
  今天的实现只是**没读**（`isFoldable :157-159` 只把它当免折判定用）。**⇒ 零改 `chatSessions.ts` 即可拿到两侧附件。**

**历史侧有两个 carrier，必须分开算账（R-20，仲裁 A-m6 升级项）**：

| Carrier | 来源 | image 行有 `name` 吗 | 证据 |
|---|---|---|---|
| **Carrier A（本 app 自己写的）** | Anthropic content block（`image` / `document`）经 `extractContentAttachments` 回读 | **结构上没有**——image block 没有地方放文件名 | `historyReader.ts:635-638` 注释，push 在 `:641-645`（rev.2 按 R-20 订正；rev.1 写的 `:634-636`/`:637-647` 已漂移） |
| **Carrier B（外来控制行 / 工具行）** | `extractControlAttachment` 从 `name` / `filename` / `path` 任一字段取名 | **有**（取到什么就是什么） | `historyReader.ts:656-693`，取名点 `:685-687` |

⇒ **「image 行的 attachments 全部无 `name`」是「这一行是本 app 自己写的」的签名**（下称 **Carrier-A 签名**）。
rev.1 只论证到「name 必须排除在身份之外」；rev.2 进一步把这条事实当**守卫依据**用
（R-11，落在 §2.2 前置③）：带 `name` 的历史行一律不参与附件档匹配，
零成本收缩外来写入方的暴露面。

**值层：三字段里只有两个能往返，第三个必然不等。** 走一遍本 app 自己发图的全链：

| 阶段 | image 附件 | text/document 附件 |
|---|---|---|
| Composer -> `SessionAttachment` | `{kind:'image', mediaType:'image/png', name:'shot.png', data}`（`agentHost.ts:152-159`） | `{kind:'text', mediaType:'text/markdown', name:'notes.md', data}` |
| Host 回声 `beginTurn` | `{kind, mediaType, name?}` 逐字带上（`eventNormalizer.ts:443-453`）-> **name 在** | **name 在** |
| 写进 SDK prompt / JSONL | `{type:'image', source:{media_type: mediaType, data}}`——**没有 title 字段可写**（`claudeRuntime.ts:58-66`） | `{type:'document', source:{media_type}, title: name}`（`:68-77`）-> **name 在** |
| `historyReader` 回读（Carrier A） | `kind:'image'`、`mediaType = source.media_type`（逐字往返）、**`name` 缺席**（push `historyReader.ts:641-645`；`:635-638` 注释明写「Images get no name … the Anthropic image block has nowhere to put a filename」） | `kind:'text'`、`mediaType` 往返、`name = title` **相等** |

**结论（承重）**：`kind` 与 `mediaType` 在 image 路径上**逐字往返**；`name` 在 image 路径上**结构性不等**（一侧有一侧无）。
⇒ **附件身份 = 有序的 `(kind, mediaType)` 序列；`name` 必须排除。**
把 `name` 放进身份等价于「图片消息永不可折」——那正是本缺陷本身。
（`name` 排除在**身份**之外，与「历史行带 `name` 就不给折」这条**前置**并不矛盾：
前者说的是比什么，后者说的是准不准比。）

### 2.2 image-only 空文本消息以什么身份匹配

先钉死两侧的实况形状（这决定了「文本身份为什么必然失配」）：

- **运行时侧**：`beginTurn` 的 `message.delta` 是**无条件发的**，`text: userText` 可以是空串
  （`eventNormalizer.ts:461-466`；调用点 `claudeRuntime.ts:640` 直接透传 `input.text`；
  Composer 允许空文本带附件发送，`chatSessions.ts:1069`）。
  渲染端 `appendTextBlock` 照样建块 ⇒ 运行时消息 `blocks = [{type:'text', text:''}]`，`attachments` 非空。
- **历史侧**：`historyReader` 在无文本时给出 `blocks: []`，靠 `attachments.length > 0` 才发这一行
  （`historyReader.ts:901`、`:911-919`、`:920`）；`sessionHistory.ts:71-73` 明文「A user message may now carry
  attachments and ZERO blocks」。
- 两侧 `coverageText()`（`:144-150`）都是空串 ⇒ 今天在 `:237-239` 无条件 `kept` ⇒ **永久重复**（RCA §3 洞 B 第一条）。

**修法：折叠身份分档（tiered），而不是把附件并进文本身份（合取）；附件档另带三条前置。**

```ts
type FoldIdentity = { mode: 'text' | 'attachment'; key: string };

/** Where the candidate row sits relative to the anchor. `'no-anchor'` is a
 * replay whose snapshot never had an anchor at all (a first resume). */
type MatchSite = 'tail' | 'hole' | 'no-anchor';

/**
 * The identity a message is matched by. TEXT WINS whenever there is text: an
 * attachment-bearing message with prose keeps folding exactly as it does
 * today, and its history row does NOT have to have recovered any attachment
 * metadata (a foreign Host, a carrier this reader cannot see, an older JSONL
 * -- all still fold). Only a message with NO coverage text falls back to
 * attachment identity: the image-only turn that used to opt out of matching
 * entirely and duplicate forever. Null = opts out, unchanged.
 */
function foldIdentity(message: ReplayMergeMessage): FoldIdentity | null {
  const text = coverageText(message);
  if (text.length > 0) return { mode: 'text', key: text };
  const attachments = attachmentIdentity(message);
  if (attachments.length > 0) return { mode: 'attachment', key: attachments };
  return null;
}

/**
 * Ordered `(kind, mediaType)` pairs, JSON-encoded so no separator can ever be
 * forged by a media type. `name` is DELIBERATELY excluded: an Anthropic image
 * block has nowhere to put a filename, so the replayed copy of an image turn
 * never has a name while the runtime echo does. Including `name` would make
 * every image turn unmatchable -- the bug itself. Order and count ARE part of
 * the identity: two images and one image are not the same turn. Reads
 * defensively: `attachments` is `readonly unknown[]` here.
 */
function attachmentIdentity(message: ReplayMergeMessage): string {
  const attachments = message.attachments;
  if (!attachments || attachments.length === 0) return '';
  return JSON.stringify(
    attachments.map((raw) => {
      const meta = (raw ?? {}) as { kind?: unknown; mediaType?: unknown };
      return [
        typeof meta.kind === 'string' ? meta.kind : '',
        typeof meta.mediaType === 'string' ? meta.mediaType : '',
      ];
    })
  );
}

/**
 * Carrier-A signature (§2.1). `historyReader` writes this app's own image
 * rows through `extractContentAttachments`, where the image block has nowhere
 * to put a filename (`historyReader.ts:635-638`, push at `:641-645`), so such
 * a row NEVER has a name. A name can only come from Carrier B
 * (`extractControlAttachment :656-693`, naming at `:685-687`) -- a foreign
 * writer whose row must not absorb our echo.
 */
function attachmentsAreUnnamed(row: ReplayMergeMessage): boolean {
  const attachments = row.attachments;
  if (!attachments || attachments.length === 0) return false;
  return attachments.every((raw) => {
    const meta = (raw ?? {}) as { name?: unknown };
    return meta.name === undefined || meta.name === null || meta.name === '';
  });
}

/**
 * May `row` absorb an echo carrying `identity`? Role is checked by the caller.
 * TEXT tier: mode + key, exactly today's rule.
 * ATTACHMENT tier adds three preconditions, because `(kind, mediaType)` fully
 * COLLAPSES for the screenshots this app takes (every one is `image/png`), so
 * an unattributable hit must always yield (measured: without them a real turn
 * is deleted, 2 bubbles -> 1):
 *   1. the replay must HAVE an anchor (`site !== 'no-anchor'`);
 *   2. the row must be in the post-anchor fresh tail, or be this echo's own
 *      positional hole -- `site` carries exactly that distinction;
 *   3. the row's attachments must ALL be unnamed (Carrier-A signature).
 */
function identityMatches(
  identity: FoldIdentity,
  row: ReplayMergeMessage,
  site: MatchSite
): boolean {
  const rowIdentity = foldIdentity(row);
  if (!rowIdentity) return false;
  if (rowIdentity.mode !== identity.mode || rowIdentity.key !== identity.key) return false;
  if (identity.mode === 'text') return true;
  if (site === 'no-anchor') return false;
  return attachmentsAreUnnamed(row);
}
```

匹配判定（替换 `:236-248` 的文本比较）：候选与历史行必须
**role 相等 ∧ mode 相等 ∧ key 相等**，附件档再加**三条前置全中**。

**「分档」而不是「合取」是承重选择**，理由是一条**必须保住的既有合同**：
现有用例 `historyReplayMerge.test.ts:243-261`（M1）的历史行 `msg('h1','user','look at this')`
**根本没有 attachments**，运行时副本有。若把附件身份并进文本身份做合取，M1 当场变红，
「图+文」消息从「能折」退回「不能折」——等于用修 F11 的名义制造一个更大的 F11（钉子 N17，变异⑬）。
分档形态则是**纯粹的加法**：只有「空文本」这一条今天必然 `kept` 的路径改变行为，
任何今天能折的判定**逐位不变**。

**三条前置为什么只加在附件档**：文本身份的碰撞需要「两条消息逐字同文」，
而附件身份在本 app 的截图路径上**恒等坍缩**（都是 `image/png`、都无文本、历史侧都无 name、也没有图像数据）。
同一条守卫加在文本档是多余的，加在附件档是**保命的**——理由见 §2.3 的实测三行对照。

### 2.3 附件档误折会**删掉一个真实回合**（rev.1 本节结论全部推翻）

rev.1 本节的三段结论——「计数守恒 ⇒ 任何配对方式都不会少一个气泡」「最坏只是 chip 名归属漂移」
「四道闸门必须同时打开」——**全部推翻**（仲裁 D2/D3，台架 v1 实跑取证）。

**a) 计数守恒的算式自己就反证了它**

输出条数 = `|mergedHistory| + |kept|`。replacement fold 确实不改 `mergedHistory` 的长度，
但被折掉的运行时候选**不进 `kept`** ⇒ 实际是 `|history| + |runtime| - |folds|`。
当 `1 + 1 - 1 = 1` 时，**两个真实回合合成了一个气泡**——
rev.1 把「数组长度不变」错当成了「气泡数不变」。

**b) 三行实测对照（v0 = 今天 / v1 = rev.1 字面规则 / v2 = rev.2）**

| 反例 | 入参 | v0 | v1 | v2 |
|---|---|---|---|---|
| **CE-B1** | `history=[h:A(image/png, 无 name)]`，`bucket=[E_B(空文本, image/png, name=b.png)]`，`snap({E_B}, anchor=null)` | 2 泡 | **1 泡（真丢失）** | 2 泡（退回 v0） |
| **CE-B2** | `history=[h:A, h:B]`（`h:B` 才是真副本），`anchor=null` | 3 泡 | **2 泡：turn A 整条消失、B 出现两次** | 3 泡（退回 v0） |
| **CE-B3** | `history=[h:anchor, h:A]`，`bucket=[h:anchor, E_B]`，`anchor='h:anchor'`（诱饵行在锚点**之后**） | 3 泡 | **2 泡（真丢失）** | **2 泡（仍丢失 ⇒ 登记为残留 R7）** |

⇒ rev.1 §3.4「两种读法都是 2 泡、顺序不变、唯一差异是 name 挂到前一泡上」**与实测不符**；
「chip 名归属漂移」这个定级**作废**（R-9 / R-10）。

**c) rev.1 里有没有别的守卫兜得住？——没有。** 逐条查过：
guard 1（`candidateIds.has(message.id)`）只约束**候选**、不约束历史行；
guard 2（match-required）只在**找不到**匹配时生效；`isReplacementFoldable` 只看候选自身；
rev.1 全文**没有任何候选唯一性条款**。且「候选唯一」也修不好 CE-B1——唯一的可匹配行仍可能是另一张图。

**d) rev.2 的处置：不靠计数，靠归因（R-8 / R-11）**

`(kind, mediaType)` 对「本 app 自己发的截图」是**全坍缩**的（都是 `image/png`），
所以任何**无法归因**的命中都必须让路。三条前置：

| 前置 | 内容 | 挡住什么 | 代价 | 钉子 | 变异 |
|---|---|---|---|---|---|
| ① | `anchorHistoryId !== null` 才启用附件档（`site === 'no-anchor'` 一律 false） | CE-B1 / CE-B2：无锚点 ⇒ 游标从 0 起全文件扫描 + 身份坍缩 ⇒ 删掉真实回合 | 全新会话内**首次** resume 的 image-only 消息仍重复——**与今天完全一致，不是回归** | N8 / N9 | ⑨ |
| ② | 只在「锚点之后的新尾区」（`site='tail'`）或「本回声自己的定位空洞」（`site='hole'`）里折 | 锚点之前的一切旧行（含改号行、兄弟分支行、更早的同类截图） | 无：洞 B 要修的实况路径锚点必非空（§3.4） | N6（tail 臂）/ N7（hole 臂） | ①（下界）+ ⑤（上界） |
| ③ | 历史行 attachments **全部无 `name`**（Carrier-A 签名） | 外来写入方（Carrier B）命名过的 image 行 | 无：本 app 写的行结构上就没有 name（§2.1） | N11 | ⑩ |

> 前置②没有独立的 `if`，它由**几何**保证：扫描区恒 `≥ anchorIndex + 1`、定位区恒 `≤ anchorIndex`
> 且要求 `orderedIds[hole] === X.id`。因此它的两条边界分别由**变异①（拆下界）**与**变异⑤（拆上界）**咬住
> ——这也是为什么这两对变异虽属洞 A 面，却同时是附件档前置②的承重变异。

**e) 切完之后仍剩一个丢失口，登记而不是辩护（残留 R7）**

锚点**之后**新落盘的、同 `(kind, mediaType)` 的、**无 name 且无对应回声**的 image-only 行
（外来写入方，或 Carrier-B 泄漏造出的空文本行）仍会吸收我们的回声（实测 CE-B3：v2 仍是 2 泡）。裁定：

- 登记为 **§5.2 R7（丢失方向）**，**不得**再用「chip 名归属漂移」这种定级；
- 其暴露面与**今天文本档的同类暴露同级**（今天一条锚点后同文本的外来行同样会吃掉文本回声）
  ⇒ 满足「不新增今天没有的丢失类别」这条准入线；
- 根治属 F11-b（canonical uuid 等值）。**F11-b 的立票理由由此从「增益」升级为「残留收口」。**

### 2.4 洞 B 施工 diff（`historyReplayMerge.ts`）

- **新增** `FoldIdentity` / `MatchSite` / `foldIdentity()` / `attachmentIdentity()` /
  `attachmentsAreUnnamed()` / `identityMatches()`（§2.2 代码，插在 `coverageText`（`:144-150`）之后）。
- **删除** `:236-240` 的「空文本无条件 `kept`」早退，改为 `foldIdentity(message) === null` 才 `kept`
  （语义等价于「无文本**且**无附件」才免折）。
- **改写** `:241-248` 匹配循环为 §1.7(c) 的两通道形态：role 由调用点先判，
  身份比较统一走 `identityMatches(identity, row, site)`，`site` 由通道给定（`'hole'` 或 `tailSite`），
  附件档三条前置全部落在这一个函数里——**只有一处可改坏，也只有一处要变异**。
- **比较式的真 diff（补 rev.1 的 A-m9 缺口）**：历史行 `foldIdentity(row)` 返回 `null` 时
  （无文本**且**无附件）`identityMatches` **一律 false**——空身份历史行不吸收任何候选（钉子 N12）；
  两侧 `mode` 不等也一律 false——跨档不得伪造（钉子 N21，变异⑭）。
- `isFoldable`（`:153-161`）/ `isReplacementFoldable`（`:171-179`）/ `coverageText` **一字不改**。
  image-only 运行时消息的 blocks 是 `[{type:'text', text:''}]` 或 `[]`，两者都通过 `.every(FOLDABLE_BLOCK_TYPES.has)`，
  且带 attachments ⇒ 走 `isReplacementFoldable` 为真的 replacement 分支，附件元数据得以保留。
- **头注（`:1-63`）必须同步改写（R-23）**：三 guard 表述换成**五 guard**——
  1 watermark（双用途）/ 2 match-required / 3a 锚点存在性（id 连续性证明）/ 3d 对齐探针 /
  3e 定位空洞认领，另加 3b（已结算行不吸收，**纵深防御，不承重**）。并补三段：
  ① 身份分档（有文本走文本，无文本才回退附件档，`name` 排除在身份之外）；
  ② **附件档只在有锚点时启用，且「attachments 全部无 `name`」是 Carrier-A 签名**；
  ③ 两个已登记的残留丢失口 R6 / R7 —— 原头注 `:48-49`
  「residual fail direction is a duplicated bubble, never a lost one」**与实测不符**
  （R6 今天就存在，v0/v1/v2 三版同为丢失），必须改写为「除 R6 / R7 两个已登记口外」。
  头注是本模块的合同正文，评审基线就靠它——**不同步改写视为未完工**。

## §3 修法结果逐场景推演（可产生夹具优先）

### 3.0 夹具口径（rev.2 重定，R-14）

rev.1 把 RCA §2 的探针入参「复原」成三场景，并写着「首尾自洽、可直接抄成 vitest 夹具」，
**这句话删除**。仲裁 D4 用两条性质证伪了那份入参可产生：

① **追加写的前缀性质**：`[h:u1,h:a1,h:a2,h:a3]` 不是 `[h:u1,h:a1,h:u2,h:a2,h:u3,h:a3,h:u4,h:a4]` 的前缀
——JSONL 不可能先有 `h:a2`（对 `h:u2` 的回复）后有 `h:u2`；读侧也堵死了「`h:u2` 被吞」这条出路
（`historyReader.ts:901` 的 `if (text || attachments.length > 0)` 对图片行**必然为真**）。
② **淘汰方向单一**：`pushMessage` 的 `messages.shift()`（`:750-755`）与 `openTailLines`（`:390-410`）
都只从**头部**去行，窗口起点单调右移 ⇒ 行只会从头消失，**不会在中段变新**。

因此本节改用三类夹具，且逐份标注：

| 类别 | 用途 | 纪律 |
|---|---|---|
| **可产生夹具**（§3.1~§3.4） | 正控与旗舰场景，**直接抄成 vitest 夹具**（N1/N2/N6/N7…） | 每一份都必须能说清「它是上一轮合并输出 + 追加写」怎么来的 |
| **构造夹具**（负控专用，§4.1 逐条标注） | 钉住「异常/漂移形状必须被拒绝」（N3/N4/N12/N20…） | 允许不可产生——那正是它们要挡的东西；但**不得**用作正控 |
| **存档件**（§3.5） | 只留作 rev.1 → rev.2 的差异说明 | **不得抄成任何夹具** |

术语：`h:u1 / h:a1 …` 是历史行（`h:` 前缀是合同，`sessionHistory.ts:57-58`）；
`E1003` / `E1005` 是本 app 发出的两条**图+文**运行时回声
（文本分别是 `'B look at this'` / `'C and this'`，各带 1 张 `image/png`）。

### 3.1 场景一：FIX-1 —— 首轮折对（今天就已正确，修法不改本轮）

| 入参 | 值 |
|---|---|
| `historyMessages` | `[h:u1, h:a1, h:u2, h:a2, h:u3, h:a3, h:u4, h:a4]`（两条回声已落盘为 `h:u2` / `h:u3`） |
| `bucket` / `orderedIds` | `[h:u1, h:a1, E1003, E1005]`（上一轮只 hydrate 了 u1/a1，两条回声还挂在尾部） |
| `snapshot.candidateIds` | 上面 4 个 bucket id |
| `snapshot.anchorHistoryId` | `'h:a1'`（bucket 里最后一条 `h:*`，`:102-108`） |

推演：3a 通过（`h:a1` 在下标 1）→ 3d：`orderedIds.indexOf('h:a1') === 1 === anchorIndex` ✔ → `cursor = 2`。
`E1003` 的定位下标是 2，`2 > anchorIndex(1)` ⇒ 3e 不开口；前向扫描 `i=2` 命中 `h:u2`
（∉ candidateIds ✔ role ✔ 文本档身份相等 ✔）⇒ `matchedAt = 2`，`cursor = 3`。
`E1005`：`i=3` 是 assistant，`i=4` 命中 `h:u3` ⇒ `matchedAt = 4`。

**预期输出**：`['h:u1','h:a1','E1003','h:a2','E1005','h:a3','h:u4','h:a4']`（8 泡）
——**与今天逐字相同**（今天的游标下界同样是 2，这一轮本来就折得对）。

**但这一轮同时挖出了两个空洞**：`h:u2` / `h:u3` 的 id 从 bucket 里消失了，
下一轮快照取「bucket 里最后一条 `h:*`」得到的是 **`h:a4`**（下标 7）——锚点一步跨到两个空洞之后。
这就是 §3.2 的入口，也是 P-1 生产者的全部机制。

### 3.2 场景二：FIX-2 —— 缺陷现场（旗舰场景，**可产生**）

| 入参 | 值 |
|---|---|
| `bucket` / `orderedIds` | `[h:u1, h:a1, E1003, h:a2, E1005, h:a3, h:u4, h:a4]`（= 场景一的输出） |
| `historyMessages` | `[h:u1, h:a1, h:u2, h:a2, h:u3, h:a3, h:u4, h:a4]`（不变） |
| `snapshot.candidateIds` | 上述 8 个 bucket id |
| `snapshot.anchorHistoryId` | `'h:a4'`（下标 7） |

三路对跑（仲裁 §2.4 台架实测，非纸面推演）：

```
v0 → h:u1|h:a1|h:u2|h:a2|h:u3|h:a3|h:u4|h:a4|E1003|E1005   (10 泡，两条回声垫在最尾)
v1 → h:u1|h:a1|E1003|h:a2|E1005|h:a3|h:u4|h:a4             (8 泡)
v2 → 同 v1，且再跑一轮为不动点                              (8 泡，幂等)
```

v0 的输出与 RCA §1 用户原述（「历史输入 a（图）→ 历史输入 b（图）→ 我的输入 n」、
「始终出现在最新消息之前」）**逐字吻合**——**这才是犯罪现场**。

rev.2 走位：3a 通过（`h:a4` 在下标 7）→ 3d：`orderedIds.indexOf('h:a4') === 7 === anchorIndex` ✔ →
`cursor = 8`（**前向扫描区为空——洞 A 就在这里**）。

1. `E1003`：定位下标 `orderedIds.indexOf('E1003') = 2 ≤ 7` ✔；`historyMessages[2] = h:u2`；
   `h:u2 ∉ candidateIds` ✔（上一轮正是被它自己换掉的）；role ✔；文本档身份相等 ✔；未被认领 ✔
   ⇒ 认领下标 2，`historyReplacements[2] = E1003`。
2. `E1005`：定位下标 4 ≤ 7 ✔；`historyMessages[4] = h:u3` ∉ candidateIds ✔ ⇒ 认领下标 4。
3. `kept` 为空 ⇒ 尾部无追加。

**预期输出**：`['h:u1','h:a1','E1003','h:a2','E1005','h:a3','h:u4','h:a4']`（8 泡）

- `'B look at this'` / `'C and this'` **各一次**（今天各两次）；
- 两条带图消息落在**文件序的真实位置**（今天被 `[...mergedHistory, ...kept]` 垫到最尾）；
- 运行时副本在位 ⇒ **附件 chips 保留**（history 侧 image 行无 name，运行时副本有）。

> **`h:u4` / `h:a4` 的来源不影响机制**：它们只负责把下一轮锚点推到两个空洞之后
> （另一窗口或 CLI 向同一会话追加、或某轮停折期间完成 hydration，都会造出这一段）。
> 去掉这两行，锚点退为 `h:a3`（下标 5，仍在两个空洞之后），推演逐字不变。
> 台架实测用的是这份八行形态，故 N1 按八行钉。

### 3.3 场景三：FIX-3 —— 幂等（结构是否自愈）

入参 = 把场景二的输出当作新 bucket 再跑一次，`historyMessages` 不变。
由于场景二的输出**逐字等于**它自己的输入 bucket，本轮入参与场景二完全相同 ⇒

**预期输出**：与场景二**逐字相同**（不动点）。关键一步：`h:u2` / `h:u3` **仍然不在 candidateIds 里**，
而 `orderedIds` 的下标 2 / 4 记的仍是 `E1003` / `E1005` 自己 ⇒ 两条副本再次折进同样的下标（INV-P3）。

对照今天：RCA §2 记「replay#3 结构不再自愈，重复恒在」。修后的性质反过来——
**第一次修好之后，之后每次 resume 都稳定重现同一结果**，不漂移也不再生重复。钉子 N2。

### 3.4 场景四：image-only 专项（洞 B 本体，R-10 重写）

**(a) 无锚点臂：不折**（rev.1 判「折」，已被实测推翻）

| 入参 | 值 |
|---|---|
| `bucket` / `orderedIds` | `[user-s-3001]`（空文本 + 1 张 `image/png`） |
| `historyMessages` | `[h:x1, h:x2]`（两行 image-only，`blocks: []`，各带 1 张**无 name** 的图） |
| `snapshot.candidateIds` | `{user-s-3001}` |
| `snapshot.anchorHistoryId` | `null`（首次 resume，无 hydration） |

推演：`foldIdentity(user-s-3001)` 落 attachment 档 ⇒ 前向扫描的 `site` 是 `'no-anchor'`
⇒ **前置① 不满足** ⇒ 一行不折。

**预期输出**：`['h:x1','h:x2','user-s-3001']`（3 泡，**与今天相同**）。

rev.1 在此判「折进 `h:x1`、输出 2 泡」，并把「`h:x2` 才是真副本」的读法定级为「chip 名归属漂移」——
实测那正是 CE-B2 的**丢失**形态（turn A 整条消失、B 出现两次）。rev.2 让路，失败方向回到「重复不丢失」。
钉子 N9（N8 是单行历史的同形态版）。

**(b) 有锚点臂：折**（洞 B 真正要修的实况路径，RCA §1 的第二段现象）

| 轮次 | `historyMessages` | `bucket` / `orderedIds` | 锚点 | 今天 | rev.2 |
|---|---|---|---|---|---|
| FIX-1 | `[h:p1, h:p2, h:new]` | `[h:p1, h:p2, E-img]` | `h:p2`（下标 1） | 4 泡：`h:p1 · h:p2 · h:new · E-img` | 3 泡：`h:p1 · h:p2 · E-img` |
| FIX-3 | `[h:p1, h:p2, h:new, h:r]` | `[h:p1, h:p2, E-img, h:r]` | `h:r`（下标 3） | 5 泡：`h:p1 · h:p2 · h:new · h:r · E-img`（**永远够不到**） | 4 泡：`h:p1 · h:p2 · E-img · h:r` |

- FIX-1 走前置②的**「锚点之后新尾区」**分支（`h:new` 在下标 2 > 锚点 1，`site='tail'`）；
- FIX-3 走前置②的**「本回声自己的定位空洞」**分支（`orderedIds[2] === 'E-img'`、`h:new ∉ candidateIds`、
  `site='hole'`）——注意锚点已推进到 `h:r`（下标 3），前向扫描区为空，今天在这里永久重复；
- 两轮都要求 `h:new` 的 attachments **全部无 name**（前置③）。
- 台架实测：FIX-1/2/3 三轮在 v2 下全部折成单例且幂等。钉子 N6 / N7 / N16。

**mediaType 不同则自动分开**：`image/png` vs `image/jpeg` 身份不等 ⇒ 永不互折（钉子 N10）
——这正是把 `mediaType` 留在身份里的收益（`name` 不能留，`mediaType` 必须留）。

**总账**：RCA 记载的 4 个重复气泡（`'B look at this'` ×1 冗余、`'C and this'` ×1 冗余、
image-only ×1 冗余、以及 replay#3 的恒久化）全部消除；
本批新增的丢失口只有一个且已登记（§2.3 e 的 R7），
另有一个**今天就存在、两轨都没提**的丢失口（R6）随本批一并登记（§5.2）。

### 3.5 存档：RCA §2 探针入参为何不可产生（rev.1 §3.1/§3.2 的夹具，**不得抄**）

rev.1 曾把下面这份入参当旗舰场景：

| 项 | 值 |
|---|---|
| replay#1 | `history=[h:u1,h:a1,h:a2,h:a3]`，`bucket=[h:u1,h:a1,user-s-1003,user-s-1005]`，锚点 `h:a1` |
| replay#2 | `history=[h:u1,h:a1,h:u2,h:a2,h:u3,h:a3,h:u4,h:a4]`，`bucket=` replay#1 的输出，锚点 `h:a3` |

三条判决：

1. **不可产生**：replay#1 的 history 不是 replay#2 的前缀，理由见 §3.0 的两条性质（仲裁 D4 实查）。
2. **在 rev.2 规则下不再复现缺陷**：replay#2 里 `h:a3` 在两侧的下标**不等**
   （`orderedIds` 里是 3、history 里是 5）⇒ **guard 3d 直接关闭定位认领**；
   `cursor = 6` 同样够不到 `h:u2`（下标 2）⇒ v2 输出 = v0 输出 = **10 泡**（仲裁实测）。
   ⇒ 若照 rev.1 把它抄成用例，该用例会**永远红且改不绿**，直接卡死施工。
   这就是 R-14 从「证据链质量问题」升级为「按原稿施工必然卡死」的原因。
3. 它仍是**理解 RCA 现象**的有用图示，故存档于此；但**任何用例不得使用它**。

> 附带结论：3d 在这里表现出的「宁可不折」正是设计意图——
> 两侧下标不等意味着 `orderedIds[i]` 与 `historyMessages[i]` 已不指同一格，
> 此时任何定位认领都是猜测，而猜测的失败方向是**丢失**。

## §4 测试合同（RCA §4 底线五条展开）

### 4.0 底线五条 → 用例映射（N 编号）

| RCA 底线 | 本稿用例 |
|---|---|
| 正控① 图+文消息二次 replay 后单例 | N1、N2 |
| 正控② image-only 消息 resume 后单例 | N6、N7 |
| 正控③ 锚点前副本（= 上一轮自己挖的定位空洞）可折叠 | N1、N2 |
| 负控① resume 后新发的同文本消息不被误吃（v1 反例保持） | N4、N5 |
| 负控② replacement fold 后附件 chips 保留 | N16 |

### 4.1 新增用例逐条表（`src/renderer/stores/__tests__/historyReplayMerge.test.ts`）

夹具助手（`msg`（`:22-24`）之后新增；`snap`（`:28-31`）就地加第三个**带默认值**的参数）：

```ts
const att = (kind: string, mediaType: string, name?: string) =>
  name ? { kind, mediaType, name } : { kind, mediaType };

/** Runtime image-only echoes carry an EMPTY text block (`beginTurn` always
 * emits its delta); history rows carry no blocks at all. Both shapes must
 * match — the arms are tested separately, never averaged. */
function attMsg(
  id: string,
  role: string,
  attachments: readonly unknown[],
  blocks: readonly { type: string; text?: string }[] = []
): ReplayMergeMessage {
  return { id, role, blocks, attachments };
}

// `orderedIds` (R-3) defaults to the candidate ids in argument order, which is
// exactly what every existing case already means; only the drift cases
// (N3/N4) and the hole cases (N1/N2/N7/N18/N20) pass an explicit order.
const snap = (
  candidateIds: readonly string[],
  anchorHistoryId: string | null = null,
  orderedIds: readonly string[] = candidateIds
): ResumeSnapshot => ({ candidateIds: new Set(candidateIds), anchorHistoryId, orderedIds });
```

> **既有 27 条断言零改动**：`snap()` 加的是带默认值的第三参，所有既有调用点逐字不动；
> 5 条 registry 用例的断言只读 `candidateIds` / `anchorHistoryId`（实查 `:389-427`），加字段后仍全绿。

| # | 正/负控 | 夹具形状 | 断言 | 咬住的命题 | v0 |
|---|---|---|---|---|---|
| **N1** | 正控③（可产生） | §3.2 旗舰夹具：`history` 八行、`bucket=[h:u1,h:a1,E1003,h:a2,E1005,h:a3,h:u4,h:a4]`、`snap(bucket,'h:a4',bucket)`，两条回声带 `att('image','image/png','a.png')` | `merged.length === 8`；`merged[2].id === 'E1003'`、`merged[4].id === 'E1005'`；`merged[2].attachments` 深等值原附件 | 定位空洞被**自己的**回声认领 + INV-P2 | **红** |
| **N2** | 正控①③ | N1 的输出当新 bucket 再跑（入参与 N1 逐字相同） | `ids` 与 N1 **逐字相同**（不动点） | 跨轮幂等 INV-P3 | **红** |
| **N3** | 负控（构造） | N1 夹具 + `history` 头部插一行 `h:branch` ⇒ `orderedIds.indexOf('h:a4') = 7 ≠ anchorIndex = 8` | 无任何 replacement，两条回声退回尾部（9 行历史 + 2 泡） | 对齐探针失败 ⇒ 定位认领整体关闭 | 绿 |
| **N4** | 负控（构造，B-Blocker 2 逐字夹具） | `history=[s-7('你好'), h:old-2]`、`bucket/orderedIds=[h:old-1('你好'), h:old-2, user-resend('你好')]`、`anchor='h:old-2'` | `ids === ['s-7','h:old-2','user-resend']`；`merged.length === 3` | 改号行不得吃掉重发（游标下界 + 3e 上界） | 绿 |
| **N5** | 负控①（既有 `:68` **就地**补） | v1-CE2/P1 夹具逐字不动；标题改为「the cursor lower bound, not row eligibility, is what stops P1」 | 既有断言 + **追加** `merged.length === 3` | 游标下界仍是 P1 的防线（3b 只是纵深） | 绿 |
| **N6** | 正控②（可产生） | §3.4(b) FIX-1：`history=[h:p1,h:p2,h:new(image-only,无 name)]`、`bucket=[h:p1,h:p2,E-img]`、`anchor='h:p2'`；**两臂**：`E-img` 的 blocks 为 `[{type:'text',text:''}]` / `[]` | 两臂均 `ids === ['h:p1','h:p2','E-img']`；`merged[2].attachments` 带 `name:'a.png'` | 附件档折进锚点后新尾区（洞 B 本体）+ 两侧 blocks 形状差异都能匹配 | **红** |
| **N7** | 正控② | §3.4(b) FIX-3：`history=[h:p1,h:p2,h:new,h:r]`、`bucket/orderedIds=[h:p1,h:p2,E-img,h:r]`、`anchor='h:r'`（**存活 `h:*` 行排在空洞之后**） | `ids === ['h:p1','h:p2','E-img','h:r']`；`merged.length === 4` | 锚点跨过空洞后仍靠 3e 折回原位（替代 rev.1 的空壳 T4） | **红** |
| **N8** | 负控（丢失方向） | CE-B1：`history=[h:A(image/png,无 name)]`、`bucket=[E_B(空文本,image/png,name='b.png')]`、`anchor=null` | `ids === ['h:A','E_B']`；`merged.length === 2` | 附件档前置①：无锚点一律不折 | 绿（rev.1 **红**） |
| **N9** | 负控（丢失方向） | CE-B2 / §3.4(a)：`history=[h:x1,h:x2]`、`bucket=[user-s-3001]`、`anchor=null` | `ids === ['h:x1','h:x2','user-s-3001']` | 同上，两行同身份时的形态 | 绿（rev.1 **红**） |
| **N10** | 负控 | 锚点非空；运行时 `image/png`、历史行 `image/jpeg` | 不折，回声留在尾部 | `mediaType` 在身份内 | 绿 |
| **N11** | 负控 | 锚点非空；历史 image 行带 `name:'foreign.png'`（Carrier B 形状） | 不折，回声留在尾部 | 前置③ Carrier-A 签名 | 绿 |
| **N12** | 负控（构造） | 历史行无 attachments 且 `blocks: []`（协议防御，`historyReader` 不产此形） | 不折 | `foldIdentity` 为 null 的历史行不吸收任何候选 | 绿 |
| **N13** | 负控（既有 `:323` **就地**补） | 既有夹具不动；标题与注释补「…and no attachments」 | 既有断言 | 免折早退只被「无文本**且**无附件」触发 | 绿 |
| **N14** | 正控（守恒） | 锚点非空 + 两条同身份 image-only 候选 + 锚点后**两行**同身份历史 | 各折一次，`merged.length === 3`（含锚点行），`kept` 为空 | 计数守恒 · 游标严格递增 | **红** |
| **N15** | 负控（守恒） | 同 N14，但锚点后只有**一行** | 折一留一，`merged.length === 3` | 供不应求时**不丢泡**（match-required） | 绿 |
| **N16** | 负控② | N6 的 `merged[2]` | `attachments` 与运行时副本**深等值**（含 `name`），且 `merged[2].id` 是运行时 id | replacement fold 后 chips 保留 | **红**（随 N6） |
| **N17** | 负控（既有 `:243` M1 **就地**补） | 既有夹具不动；追加注释「history row has NO attachments on purpose」 | 既有断言 + 断言该历史行确无 attachments | 文本档**不比较附件**（分档 ≠ 合取） | 绿 |
| **N18** | 结构不变量（构造） | `history=[h:anchor, h:m('X'), h:k('X')]`、`bucket/orderedIds=[h:anchor, W('W'), E1('X'), E2('X')]`、`anchor='h:anchor'` | `merged[1].id === 'E1'`、`merged[2].id === 'E2'`、`W` 在尾部；两个 replacement 落在**不同键** | 定位区与扫描区不重叠 + 键唯一（INV-P1） | 绿 |
| **N19** | 负控 | 附件档候选 role `user`，历史 image-only 行 role `assistant` | 不折 | 附件档仍要求 role 相等 | 绿 |
| **N20** | 负控（构造） | `orderedIds[0]` 是回声自己的 id，但 `historyMessages[0]` **仍 ∈ candidateIds**（已结算行） | 不折，回声 kept | 3e 条件②：已结算行不得被认领（INV-P4 的代码化） | 绿 |
| **N21** | 负控（跨档） | 候选文本恰为 `[["image","image/png"]]`（走文本档），历史行是 image-only（走附件档） | 不折 | `mode` 必须相等，跨档不得伪造 | 绿 |

> **发射半边**：N1 / N2 / N6 / N7 / N14 / N16 六条按今天的代码必须**全红**
> （仲裁已在台架上验过其中 N1/N2/N6/N7 的 v0 分支确实不折）。不红即夹具没构造出盲区，重写夹具再来。
> **反向发射证据**：N8 / N9 在 v0 绿、在 **rev.1 字面规则下红**、在 rev.2 绿——
> 施工时**必须先按 rev.1 原稿跑一次让它们变红**，抄红灯原文进 as-built。
> 这是「B-Blocker 1 真实存在且已被本批堵住」的唯一机器证据。

> **N14 / N15 的口径登记**：仲裁 §4.2 这两行写的是「2 泡」，那是 rev.1 T11/T12（**无锚点**形态）的遗留数字；
> R-8 前置① 要求锚点非空，夹具必须多一行锚点行 ⇒ 实际断言为 **3 泡**。
> 两条咬住的命题（各折一次 / 折一留一，均不丢泡）不变。

### 4.2 既有 27 条用例的存亡结论

**基线实数：27 条** = `mergeReplayedHistory` **22** + `resume snapshot registry` **5**
（`grep -c "  it("` 亲跑。rev.1 文首写 21、§4.2 写 26、§4.4 写 43，三处全错，R-17 一并订正。）

**结论：27 条断言零改动保持绿**；另有三条**就地**补断言/标题（不新开 `it` 块），一处助手加带默认值的参数：

| 既有用例 | 复核 | 结论 |
|---|---|---|
| `:68` anchor P1 | `cursor = anchorIndex + 1 = 2` ⇒ 扫描区为空；`user-resend` 的定位下标 2 越过 3e 上界 ⇒ kept | 绿；**就地**补 `merged.length === 3` 与标题（= N5） |
| `:91` G14 codex 钉现行为 | `codex-user` 折进 item-1（∉ candidateIds 且在锚点之后）；`codex-asst` 含 `tool_call` ⇒ 不可折 ⇒ 追加在尾 | 绿（L6 现行为不被本批改动） |
| `:174` 锚点失踪停折 | guard 3a 一字不改 | 绿（同时是变异⑦的靶子） |
| `:188` 单史行半边 | 游标语义不变 ⇒ 行为不变 | 绿（变异⑥的附带杀手） |
| `:243` M1 replacement fold | 文本档，历史行无 attachments 也照折 | 绿；**就地**补注释与断言（= N17） |
| `:323` 无 coverage text 不参与匹配 | 两个夹具都**无 attachments** ⇒ `foldIdentity` 仍返回 `null` | 绿；**就地**补标题「…and no attachments」（= N13） |
| registry 5 条（`:389-427`） | 断言只读 `candidateIds` / `anchorHistoryId` | 绿；`snap()` 加**带默认值**的 `orderedIds` 后，调用点逐字不动 |

> **块数与判定数的对账（全文唯一一次，其余位置只用 48）**：
> N5 / N13 / N17 三条是**就地**补在既有 `:68` / `:323` / `:243` 三个块上的断言（R-18/R-21 要求不新开块），
> 因此 `vitest` 报出的 `it` 块总数将是 **45**（既有 27 + 新开 18），
> 而**收口门的判定条目数按仲裁 §4 口径恒为 48**（27 + 21 条命题）。
> 两个数说的不是同一件事；本稿其余位置一律只出现 **48**。

### 4.3 变异测试计划（15 对，逐对实跑记红灯，零跳过）

变异纪律沿用 D48 工法：**字节级替换**改被测源，scoped 跑 vitest，抄红灯原文，再字节还原并复绿。
每对必须**恰好**咬住表中的用例；**执行记录必须区分「承重首杀」与「附带同红」**（仲裁采纳 B 轨的加码要求），
不得以「变了几个测试名」代替咬合证明；变异存活即判该用例为空壳，**先补断言再继续**。

| # | 变异（对 `historyReplayMerge.ts` 的字节改动） | 预期变红 | 承重命题 | 来源 |
|---|---|---|---|---|
| **①** | `let cursor = anchorIndex + 1` 改为 `= 0` | **N4** | 下界是 P1 与漂移行的防线 | 新（R-2） |
| **②** | 删掉对齐探针（`aligned` 恒 true） | **N3** | 漂移检测不可省 | 新（R-4） |
| **③** | 3e 条件①改为「`orderedIds[hole]` 只要不是 `h:` 前缀即可」（不比 id） | **N20 + N4** | 空洞必须由**自己的**回声认领 | 新（R-5） |
| **④** | 3e 去掉条件②（`!candidateIds.has(row.id)`） | **N20** | 已结算行不得被认领 | 新（R-5） |
| **⑤** | 3e 去掉 `hole <= anchorIndex` 上界 | **N18** | 定位区与扫描区不得重叠 | 新（R-6） |
| **⑥** | 删掉已认领下标集合 `claimed` | **N18** | `Map<number,T>` 键唯一 | 新（R-6） |
| **⑦** | 删 guard 3a（锚点存在性整块） | **既有 `:174`** | id 连续性证明（round-6 verify blocker 资产） | rev.1 ③ |
| **⑧** | 删 guard 3b（`candidateIds.has(candidate.id) continue`） | **N5 + 既有 `:68`** | 已结算行纵深防御 | rev.1 ① |
| **⑨** | 附件档去掉 `site === 'no-anchor'` 前置 | **N8 + N9** | B-Blocker 1 的封堵本体 | 新（R-8） |
| **⑩** | 附件档去掉 `attachmentsAreUnnamed(row)` 要求 | **N11** | Carrier-A 签名 | 新（R-11） |
| **⑪** | `attachmentIdentity` 只编码 `kind`，丢掉 `mediaType` | **N10** | mediaType 在身份内 | rev.1 ④ |
| **⑫** | `attachmentIdentity` 把 `name` 加回三元组 | **N6 + N7**（**不含 N16**） | `name` 必须排除在身份之外 | rev.1 ⑤（订正必红集） |
| **⑬** | `foldIdentity` 文本档改成合取 `key = text + attachmentIdentity(message)` | **既有 `:243` + N17** | 分档 ≠ 合取 | rev.1 ⑥ |
| **⑭** | `identityMatches` 去掉 `mode` 相等 | **N21** | 跨档伪造 ⇒ 文本消息被**删除** | 新（A-m4） |
| **⑮** | `historyReplacements.set(matchedAt, …)` 改为 `set(historyMessages.length - 1, …)` | **N1 + N16** | replacement 落在匹配下标（INV-P2） | rev.1 ⑨ |

**被删掉的 rev.1 变异**：原②（`cursor` 下放）与原⑦（恢复空文本早退）被 ① / ⑨ 取代；
原⑧（`cursor = matchedAt`）并入 ⑥ 的键唯一命题——既有 `:188` 单史行半边仍是它的附带杀手，
按纪律在执行记录里标注为「**附带同红**」而非「承重首杀」。
rev.1 原⑤把 T13（取自 T2、两条候选**有文本**）列进必红集是配错档：文本档在 `foldIdentity` 提前返回，
`attachmentIdentity` 根本不被调用（两轨同判）⇒ ⑫ 的必红集已订正为 N6 + N7。

> **超定风险预告（修订员静态推演，未上台架；施工时以实测为准）**：
> INV-P1 由「两区不相交 + 游标单调 + 3e 单射 + `claimed` 表」四重保证，彼此**互为冗余**，
> 因此 ⑤ / ⑥ **单独施加时 N18 有可能仍绿**。执行纪律：先单独施加并如实记录；
> 若存活，改为**联合变异（⑤ + ⑥ 同时施加）**复跑并记「联合首杀」。
> **不得**因存活就删掉 N18 或跳过该对——as-built 里把「单独存活 / 联合首杀」逐字记清。

### 4.4 收口门（逐门串行跑，禁链式合跑）

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm vitest run src/renderer/stores/__tests__/historyReplayMerge.test.ts`
   （**48 条判定全绿** = 既有 27 + 新增 21；`it` 块计数与判定数的对账见 §4.2 的注）
4. `pnpm test`（全量；本批不应改变任何其他套件的结果）
5. **15 对**变异逐对实跑，抄红灯原文，逐对区分「承重首杀 / 附带同红」
6. `git diff --stat` 与 §5.1 影响面表逐文件核对（**只应有 2 个文件**）

### 4.5 flag 问题的显式处置

工程规范 #6 要求新能力带 flag 双跑。本批**不加运行时 flag**，理由与代偿如下：

- 本改动是**纯叶子函数**、零 I/O、零 store 依赖（`historyReplayMerge.ts:59-63` 的 leaf-module 铁律），
  加 flag 会把 48 条判定的矩阵翻倍，去守一个本身就 fail-open 的折叠判定；
- **代偿改为分步发射证据（R-15）**。rev.1 写的「模块天然自带 off 位（`snapshot: null`）」与
  「off/on 双轮全量」**作废**：`snapshot` 是逐用例构造的入参（`ok(snap([...]))`），没有任何全局开关；
  且 `snapshot === null` 关掉的是**整个折叠**（`:196-201`），对 F11 的 on/off **零信息量**。
  代之以四步可复核的分步证据（每步的输出都抄进 as-built）：

| 步 | 动作 | 预期 |
|---|---|---|
| **S-0** | 按今天的代码跑新增用例 | N1/N2/N6/N7/N14/N16 **全红**；N8/N9 绿 |
| **S-0'** | 按 **rev.1 字面规则**（游标下放 0 + 逐行准入 + 无附件档前置）跑一次 | N8/N9 **变红**——反向发射证据，抄红灯原文 |
| **S-1** | 只落洞 A（§1.7 三处 diff） | N1/N2 转绿；**附件档面用例（N6/N7/N14/N15/N16 等）应仍红** |
| **S-2** | 再落洞 B（§2.4） | **48 条全绿** |

- **回滚改为有序（R-16）**。rev.1 写的「两个洞的修法互相独立，可单独回滚其一」**作废**——
  一半是反的。合法的安全态只有两种：

| 回退分支 | 判定 | 依据 |
|---|---|---|
| **{两洞全退}**（回到 `487b0c3`） | ✅ 安全态 | 今天的形态：重复但不丢失（除 §5.2 的 R6 既有口） |
| **{洞 A 在位、洞 B 退}** | ✅ 安全态 | image-only 回到「永不折叠」；图+文继续走文本档修好。洞 A 的定位空洞认领**不依赖**附件身份 |
| {洞 A 退、洞 B 在位} | ❌ **禁止**，且是净负 | 洞 B 让 image-only 第一次折叠成功 ⇒ 亲手挖出一个 P-1 空洞；该回合的 assistant 回复行排在空洞之后 ⇒ 下一轮锚点必然跨过空洞 ⇒ 从「稳定重复」退化为「**重复 + 位置漂移**」（台架 FIX-2/FIX-3 实测：v0 在锚点推进到 `h:r` 之后永远够不到 `h:new`） |
| 只退「附件档的锚点前置」 | ❌ 禁止 | 等于把 B-Blocker 1 放回来（实测丢泡，§2.3 b 的 CE-B1/CE-B2） |

  ⇒ **「洞 A 不得在洞 B 生效时单独回滚」**必须写进 §6.2 的 as-built 回滚预案。
  施工序（先洞 A 再洞 B）恰好与之相容，无需改序。
- **回滚演练（收口必做一次）**：退洞 B 后跑全量，确认落在 {洞 A 在位、洞 B 退} 这个安全态——
  洞 A 面用例（N1/N2/N4/N5/N18）仍全绿、附件档面用例转红（这正是「洞 B 已退出」的机器证据），
  演练后立即恢复并复跑门 3。
- **回滚代价已量化**：撤回 = 还原三处字节（游标段 `:204-218`、匹配循环 `:236-256`、
  `ResumeSnapshot` 字段与两个快照函数）+ 删五个新函数
  （`foldIdentity` / `attachmentIdentity` / `attachmentsAreUnnamed` / `identityMatches` + 类型 `FoldIdentity`/`MatchSite`）。

---

## §5 边界、残留与序关系

### 5.1 影响面全清单

| 文件 | 动作 |
|---|---|
| `src/renderer/stores/historyReplayMerge.ts` | 头注五 guard 改写（`:1-63`，R-23）；`ResumeSnapshot` 加 `orderedIds`（`:78-86`）；`snapshotResumeCandidates`（`:96-114`）与 `takeResumeSnapshot`（`:121-131`）各带一次该字段；新增 `FoldIdentity` / `MatchSite` / `foldIdentity` / `attachmentIdentity` / `attachmentsAreUnnamed` / `identityMatches`；`:204-218` 换成 guard 3a + 3d 对齐探针 + `cursor = anchorIndex + 1` + `claimed`；`:236-256` 换成「3e 定位认领 → 前向扫描」两通道。`coverageText` / `isFoldable` / `isReplacementFoldable` **一字不改** |
| `src/renderer/stores/__tests__/historyReplayMerge.test.ts` | 新增 18 个 `it` 块（N1~N21 中除 N5/N13/N17 外的命题）；`snap()` 加带默认值的 `orderedIds` 参数；既有 27 条断言零改动，其中 `:68` / `:243` / `:323` 三条**就地**补断言与标题 |

**明确不改（红线）**

| 文件/对象 | 理由 |
|---|---|
| `src/renderer/stores/chatSessions.ts` | **零改动**。两侧 attachments 今天已经流到合并层（§2.1）；`orderedIds` 的入参 `orderedMessageIds` 今天就是按序传入的（`:515-519` 实查），生产者 `snapshotResumeCandidates` 在合并模块内 ⇒ **不必碰调用方**。同时这是 F2 的红线文件（F2 §10.4） |
| `src/agent-host/historyReader.ts` | 分支盲归 F8；本批不碰读侧 |
| `src/agent-host/eventNormalizer.ts` / `src/shared/types/runtimeEvents.ts` | uuid 透传归 F11-b；本批不碰协议面 |
| `resumeSnapshots` 注册表的**语义** | 快照的取值时机、requestId 匹配、消费即删三条语义**一字不改**；本批只在同一个结构里**多存一个已经拿在手里的数组**（bucket 的按序 id），`candidateIds` / `anchorHistoryId` 的产出逻辑逐字不动 |

### 5.2 残留风险登记（本批不修，写进 backlog）

| # | 残留 | 触发条件 | 后果量级 | 归属 |
|---|---|---|---|---|
| **R1** | 锚点后新尾区内两条同 `(kind, mediaType)` 的 image-only 消息**互相**错配 | 两行都在锚点之后、都无 `name`、且**各自都有回声**（供需相等） | **气泡数不变**（各折一次），仅 chip 的 `name` 归属漂移一泡。**注意这不是最坏情况**——最坏情况是下面的 R7（丢失） | F11-b（精确 id 等值可根治） |
| **R2** | 折叠停摆期间产生的重复无法回头修 | 读失败 / 空快照 / 锚点失踪 / **对齐探针不通过**期间历史行完成 hydration，此后该行永远是「已结算行」 | 重复气泡持续到**应用重启**为止——bucket 是内存态，`useChatSessionsStore`（`chatSessions.ts:1000`）**无 `persist` 中间件**，重启即清空运行时回声 | 已知边界，接受 |
| **R3** | 文本漂移导致的失配 | `historyReader` 存的是 `stripSystemTags(raw)` 的**剥离后**文本（`:471-480`、`:896`），运行时回声是原始文本；另有 64KB 截断（`:197`、`:902-903`） | 该消息永不折叠 ⇒ 重复（安全方向） | F11-b |
| **R4** | 分支行扩大失配面 | `historyReader` 无 `parentUuid`，废弃分支行平铺进 replay（`:442-450`） | 抬高 R1/R7 的触发概率；另会让对齐探针更常不通过 ⇒ 退回今天的行为（安全方向） | F8 |
| **R5** | Carrier-B image 行的 `mediaType` 被 `inferMediaType` 回落 ⇒ 附件档失配 | 外来写入方的 image 行走 Carrier B（`historyReader.ts:656-693`），`mediaType` 与本 app 的 `image/png` 不等 | 该消息**持续重复**（安全方向） | F11-b |
| **R6** | **今天就存在**：`anchor = null` 且历史行 ∉ candidateIds 时，文本档回声被**更早的**同文本行吃掉 | 首次 resume（无锚点）⇒ 游标从 0 起全文件扫描；历史里存在更早的同文本行 | **丢失一个气泡**。台架 v0/v1/v2 三版**同为丢失** ⇒ **不是本批引入**，但本批必须登记 | F11-b + incident 层用例（见下注） |
| **R7** | 锚点**之后**、无 `name`、无对应回声的同 `(kind, mediaType)` 行吸收我们的回声 | 外来写入方或 Carrier-B 泄漏造出的空文本 image 行落在锚点之后 | **丢失一个气泡**（实测 CE-B3：v2 仍 2 泡）。与今天文本档的同类暴露**同级** ⇒ 不新增今天没有的丢失**类别** | F11-b（**立票理由由此从「增益」升级为「残留收口」**） |

> **R6 的 incident 层回归用例（R-21）**：夹具 = `bucket=[user-resend('继续')]`、
> `history=[h:old('继续'), h:oldA]`、`snap(['user-resend'], null)` ⇒ 今天输出 `['h:old','h:oldA']`，
> 重发气泡消失。该用例**钉的是今天就有的缺陷**、不属本批修法范围，
> 因此按仲裁 §4 的 21 条口径**不计入收口门 48**，落在 incident 层独立套件
> （工程规范 #7 三层回归的第三层），随 F11-b 转绿。
> 它同时证伪了模块头注 `:48-49`「residual fail direction is a duplicated bubble, never a lost one」
> 这句**合同正文**——头注必须同步订正为「除 R6 / R7 两个已登记口外」（R-23）。

### 5.3 与 F8（historyReader 分支盲）的关系

- **同文件冲突：无。** F8 独占 `src/agent-host/historyReader.ts` + 其测试；本批独占
  `src/renderer/stores/historyReplayMerge.ts` + 其测试。**可完全并行。**
- **顺序依赖：无。** 本批不依赖 F8 的任何产出；F8 也不需要本批先落。
- **语义耦合（两条，必须写进 F8 的回归清单）**：
  1. F8 按 `parentUuid` 剪掉废弃分支后，`historyMessages` 会**变短且行集合改变**。
     若被剪掉的恰是已 hydrate 的锚点行 ⇒ 触发既有 guard 3a 的 bail（**一行不折**）；
     若只是行集合变了而锚点还在 ⇒ 触发 guard 3d 对齐探针不通过（**定位认领关闭，前向扫描照旧**）——
     方向安全（重复而非丢失），但会让「修好的时间线在 F8 落地那一轮短暂退回重复态」，属预期行为。
  2. F8 剪枝会**降低** R1 与 R4 的暴露面 ⇒ **F8 是 F11 的增强，不是前置**。
- **建议序**：F11 先落（不等 F8）；F8 落地后**回归跑 N3 / N4 / N14 / N15 / 既有 `:174`** 五条
  （前两条钉漂移与对齐探针，后三条钉守恒与停折）。

### 5.4 与 F2（超时看门狗重设计）的关系

- **同文件冲突：无。实查 F2 定稿 §11.1 切片表**：S3 的独占文件为
  `queueRelease.ts` / `useQueueRelease.ts` / `turnSendStatus.ts` / `ChatComposer.tsx`(写侧) / `MessageTimeline.tsx`，
  **不含 `chatSessions.ts`**；S2 为 `sendBudgets.ts`(新) / `attachmentLimits.ts` / `assistantProgress.ts` /
  `middleColumnLayout.ts` / `ChatComposer.tsx`(读侧)。F2 五片的独占文件表里**没有任何一个**与本批的两个文件重叠。
- **`chatSessions.ts` 的地位**：F2 §10.4 明文「红线文件，零改动 …… 若 S3 发现必须改，先停下来单独立项」，
  F2 §13 亦重申。**本批（候选 a）恰好零改该文件 ⇒ 不与红线相撞**；
  而**候选 b 必须改该文件 ⇒ 与红线正面相撞**，这是 §0.2 D-3 把 b 降级另立票的直接依据。
- **顺序依赖：无，可并行。** F2 删 unbind-on-timeout 只是**降低 resume 频率**（RCA §3「触发器（非根因）」），
  不改变合并语义；本批也不改变任何超时判决。
- **并发施工纪律**：两批若共享工作树，本批与 F2 任一片**可同时在飞**（零同区）；
  但仍按本机纪律**逐门串行跑测试**（曾 OOM exit 137）。

### 5.5 与 L6 / G14 / F456 的关系

- **L6（merge 重排口径改造，agent 无关）**：登记在 `docs/plans/2026-08-15-s3-slice5-history-spec.md`，本批**不做**。
  本批只把「可折叠的运行时副本」放回正确位置，**不改**「不可折叠消息一律追加到历史之后」这条口径。
- **G14（`historyReplayMerge.test.ts:91-131`）**：钉的是 codex 实时链整回合单条 assistant 消息不可折 + 重排的**现行行为**。
  §4.2 已复核：本批下 G14 **保持绿**，现行为不被改动。
- **F456（可读性/Composer）**：独占 `MessageTimeline.tsx` / `attachments.ts` / `turnStatus.ts` 等渲染组件面，
  与本批的 store 叶子模块**零同区**。

### 5.6 序关系总表

| 票 | 与本批的关系 | 可并行 | 同文件冲突 | 备注 |
|---|---|---|---|---|
| **F2** | 无依赖（只降低触发频率） | ✅ | ❌ 无 | 本批零改 `chatSessions.ts`，不碰 F2 红线 |
| **F8** | 增强（非前置） | ✅ | ❌ 无 | F8 落地后回归跑 N3/N4/N14/N15/`:174` |
| **F456** | 无关 | ✅ | ❌ 无 | — |
| **F11-b** | 本批的后续增强 | ❌ | ✅ 有（`chatSessions.ts`） | 需 F2 收口解冻 + 前置探针门（§0.4） |

---

## §6 施工顺序与收口

### 6.1 建议施工序（单片，无需切片）

1. **先落会红的测试**（规范 #12「先定验证再改代码」）：加 N1 / N2 / N6 / N7 / N14 / N16，
   按今天的代码跑，**六条必须全红**——抄红灯原文进 as-built。
   不红即夹具没构造出盲区（多半是把行写在了锚点之后），重写夹具再来。
2. **反向发射证据**：把洞 B 按 **rev.1 字面规则**临时实现一次（游标下放 0 + 逐行准入 + 附件档无前置），
   跑 N8 / N9，**两条必须变红**，抄红灯原文，随即回退这次临时实现。
   这是「B-Blocker 1 真实存在且已被本批堵住」的**唯一机器证据**（§4.1 脚注、§4.5 的 S-0'）。
3. **落洞 A**（§1.7 三处 diff：快照字段 / 游标段 / 匹配循环两通道）
   → N1 / N2 转绿；既有 27 条保持绿；**附件档面用例应仍红**。
4. **落洞 B**（§2.4 的五个新函数 + 两处改写）→ N6 / N7 / N8 ~ N16 / N19 ~ N21 转绿。
5. **补齐**其余新增用例（N3 / N4 / N18）与三条**就地**补断言：
   N5 = 既有 `:68`、N13 = 既有 `:323`、N17 = 既有 `:243`。
6. **改写头注**（`:1-63`）：五 guard 表述 + 身份分档 + 附件档三前置 + R6/R7 两个残留
   ——**这是合同正文，不改视为未完工**（R-23）。
7. 跑 §4.4 的六道门 + §4.3 的 **15 对**变异；另做一次 §4.5 的**回滚演练**。

### 6.2 as-built 必须记的项

- git commit；六道门逐门实跑输出；
- 步骤 1 的**六条红灯原文**（发射证据的红半边）与步骤 3/4 之后的绿半边；
- 步骤 2 的 **N8 / N9 反向红灯原文**（rev.1 字面规则下的丢失证据）；
- **15 对**变异逐对红灯原文，**零跳过**，逐对标注「**承重首杀** / **附带同红**」；
  若 ⑤ / ⑥ 单独施加时存活，须记「单独存活 → 联合（⑤+⑥）首杀」的完整过程（§4.3 的超定风险预告）；
- §4.5 分步发射证据表 **S-0 / S-0' / S-1 / S-2** 四段各自的结果；
- **回滚演练**结果，以及「**洞 A 不得在洞 B 生效时单独回滚**」这条写进预案的原文（R-16）；
- `git diff --stat` 与 §5.1 影响面表逐文件核对（**只应有 2 个文件**）；
- 与本规格的偏差条目（若有）。

> **两条禁写项**：① **不得**把「JSONL 文件还没到 32 MiB」这类会过期的实测写进安全证据（§1.5 纪律②）；
> ② **不得**再出现「off 位 = `snapshot: null`」「off/on 双轮全量」的表述（§4.5 已作废，R-15）。

### 6.3 真机点验建议（补充，非收口条件）

复现 RCA §1 用户原述的两段路径各一次：

1. 发一条「图 + 文」→ 等回复 → 侧栏切走再切回（走 resume）→ 再切一次；
   **预期**：该消息始终**只有一条**，chip 在位；重复不再随 resume 次数增长。
2. 发一条**纯图片无文字** → 应用重启 → 打开该会话；
   **预期**：单例，chip 在位。

---

## §7 一句话收束

F11 的两个洞都在渲染端合并层，都可以在**一个叶子模块内**修完：

- **洞 A**：锚点**保住**它的游标下界（v1 的 P1 反例与 id 漂移反例都靠它挡住），
  锚点之前只开一条精确通道——**定位空洞认领**：一次只认「上一轮在 `orderedIds` 里写着自己 id」的那一格，
  且要先由**对齐探针**证明两侧下标仍指同一格。「逐行新鲜度准入」退居纵深防御，不再承重。
- **洞 B**：折叠身份**分档**——有文本仍走文本（既有能折的一位不变），无文本才回退到
  有序 `(kind, mediaType)` 附件身份（`name` 因 image 路径两侧结构性不等而必须排除在**身份**之外）；
  但附件身份在本 app 的截图路径上恒等坍缩，所以附件档另带**三条归因前置**：
  锚点非空、只在新尾区或自己的定位空洞里折、历史行 attachments 全部无 `name`（Carrier-A 签名）。

与 rev.1 最重要的差别：**「不会丢失」不再靠计数守恒论证，而靠归因与定位逐格检验**。
计数守恒那条论证已被实测证伪（附件档误折**会删掉一个真实回合**，2 泡 → 1 泡）；
INV-P4（空洞与副本一一配对）也从「假设」变成了代码里被检验的条件
——因此本模块的无丢失性**不依赖任何跨模块信念**。

代价是两个必须登记的残留丢失口：**R7**（锚点后无 `name`、无对应回声的同身份行仍会吸收回声，
本批引入，但与今天文本档的同类暴露同级）与 **R6**（`anchor = null` 时文本档回声被更早的同文本行吃掉，
**今天就有**）。两者都归 F11-b ⇒ **F11-b 的立票理由从「增益」升级为「残留收口」**。

uuid 改道（候选 b）仍是更彻底的正解，但它 codex 轴无源、活发送时 uuid 未实证、且必须动 F2 的红线文件——
降级为 F11-b，带前置探针门与解冻条件。

---

## §6 as-built 实录（2026-08-18 施工收口回填）

- **commit**：`bc732f8`，2 文件 +748/−71（`historyReplayMerge.ts` / 其测试）；`chatSessions.ts` 零改动
  （R-3 的同文件裁定实况成立，调用点 `:515` 未加参数）。
- **四门**（逐门串行）：typecheck ✓ / typecheck:agent-host ✓ / lint ✓（978 文件）/
  scoped vitest stores 19 文件 277 例 ✓ + 下游 `turnHead.test.ts` 46 例 ✓。全量门由 F456 ④ 片收官终跑代承。
- **判定**：48 条全绿（45 it = 既有 27 + 新 18；N5/N13/N17 就地补）。v0 应红集 N1/N2/N6/N7/N14/N16 全中；
  N15/N20 v0 红为登记偏离（①②，断言按构造必红/第二臂加钉，命题数不变）。
- **变异**：15 对零跳过零存活；⑥ 单独存活（§4.3 超定风险预告命中）→ ⑤+⑥ 联合首杀；
  ③⑦⑧⑫⑮ 必红集与规格差异逐条记 as-built ③~⑦；删除型变异改非空标记串工法（偏离⑪）。
- **发射证据**：S-0（8 红 37 绿）→ S-0'（rev.1 字面规则实锤丢失：N8 2 泡→1 泡 / N9 turn A 整条消失）→
  S-1（洞 A 单独：附件面仍红）→ S-2（48 全绿）→ 回滚演练（{洞 A 在位、洞 B 退} 安全态机器证据 + 还原复跑绿）。
- **F11-b（uuid 改道）**：维持另立票 backlog（§0.4），解冻条件不变。
