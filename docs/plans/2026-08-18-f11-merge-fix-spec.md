# F11 修法施工规格：重发后带图片的历史用户消息在时间线重复

- 日期：2026-08-18
- 上游：`docs/plans/2026-08-18-f11-resend-dup-rca.md`（根因已定案，本稿不重做 RCA）
- 约束基线：`src/renderer/stores/historyReplayMerge.ts:1-63` 头注（v1 被双轨评审否决的两个反例 + 三 guard 合取语义）
- 现有合同：`src/renderer/stores/__tests__/historyReplayMerge.test.ts`（21 用例）
- 交付性质：**施工定稿**。施工方读本文即可动工；每条裁定都附 `file:line` 证据与反例推演。
- 代码基线：`487b0c3`（分支 `feat/openchamber-chat-refactor`）

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
| D-3 | **b 撞 F2 红线**：b 必须改 `chatSessions.ts`（存 canonical uuid 到 `ChatMessage`）与 `runtimeEvents.ts`（协议加法）。F2 定稿把 `chatSessions.ts` 列为**红线文件、零改动**，并明文「若发现必须改，先停下来单独立项」 | `docs/plans/2026-08-18-f2-watchdog-redesign-spec.md:13`、`:1000` |

### 0.3 a 单独闭环的证明义务（本稿逐条兑现）

a = 两处纯函数改动，**全部落在 `historyReplayMerge.ts` 一个叶子模块内**，零改 `chatSessions.ts`（合并层今天已经能读到两侧 attachments，见 §2.2）：

1. **洞 A**：`anchorHistoryId` 从「游标下界」降格为「id 连续性前置条件」，游标下界改由**逐行准入谓词**承担（§1）。
2. **洞 B**：折叠身份分档——有文本走文本身份（原样不动），**无文本才回退到附件身份**（§2）。

§3 逐条推演 RCA §2 的三个探针场景，全部收敛为单例且**跨 replay 幂等**；§4 给 17 条用例 + 9 对变异。

### 0.4 b 票（F11-b）立票要件（本批不做，写进 backlog）

- **前置探针门（不过不立项）**：实测一次「本 app 发送 → SDK 回流 → JSONL 落盘」的三元对照，回答两问：① 活发送时 SDK 是否回 `type:'user'` 且带 `uuid`；② 该 uuid 是否**逐字等于**该行 JSONL 的 `entry.uuid`。两问任一为否，b 直接作废。
- **解冻条件**：F2 收口、`chatSessions.ts` 红线解除。
- **b 的真实增益（不是重复劳动）**：只有 b 能杀掉 §5.2 的残留 R1/R3——「两张不同截图同附件身份」与「`stripSystemTags` 造成的文本漂移」（`historyReader.ts:471-480,896`）。这两条 a 只能压到「宁重复不丢失」的安全方向，杀不干净。

---

## §1 洞 A 修法：锚点降格 + 逐行准入

### 1.1 先纠一条上游措辞（重要）

RCA §4 候选 a 写着「watermark 已把候选限定为 resume 前消息，**回溯不违反 v1 反例的时间边界**」。
**这句话是错的，按字面实施会原地复活 v1 的 P1 反例。**

证据：P1 反例的受害者 `user-resend` **就在 watermark 里**——既有钉子 `historyReplayMerge.test.ts:85` 的快照写作
`snap(['h:old-1', 'h:old-2', 'user-resend'], 'h:old-2')`，`user-resend` 是候选集成员。
所以 guard 1（watermark）对 P1 **零防御能力**，P1 的唯一防线就是 guard 3 的游标下界。
「候选集内回溯」= 把唯一防线拆掉。**必须换一条判据。**

### 1.2 判据：不是「回溯」，是「起点下放 + 逐行准入」

先看两个场景的结构差异——这是全部修法的支点：

| | P1 反例（不能折） | 洞 A 现场（必须折） |
|---|---|---|
| 受害/目标行 | `h:old-1`（游标前的同文本行） | `h:u2`（游标前的真副本行） |
| 该行在**快照时的 bucket** 里吗 | **在**（`candidateIds` 含 `h:old-1`） | **不在**（本次 replay 新出现） |
| 该行代表的回合 | 一个**早已结算**的旧回合 | 回声**自己**的回合，只是刚落盘 |

判据即由此得出：

> **guard 3b（新）**：一条历史行只有在它**对本次 replay 是新的**（`id ∉ snapshot.candidateIds`）时，
> 才有资格吸收一条运行时回声。快照时就已经渲染在 bucket 里的历史行是**已结算历史**，
> 永远不得追溯性地吞掉一条当时没被折叠的回声。

同时 guard 3 的**锚点存在性检查原样保留**，降格为纯粹的「id 连续性证明」：

> **guard 3a（保留，一字不改语义）**：`anchorHistoryId` 非空却在本次 replay 里找不到
> （读窗口头部淘汰 / JSONL 被重写）⇒ **一行都不折**。
> 这是 round-6 verify blocker 的资产：id 连续性一断，`candidateIds` 的准入语义同时失效
> （所有行都会变成「新行」），准入退化为 v1 全域匹配——必须整体停摆。

### 1.3 合取语义的账（逐 guard 结算）

| guard | 修改前 | 修改后 | 是否破坏合取 |
|---|---|---|---|
| 1 watermark（候选集） | `candidateIds.has(message.id)` 才可折（`:227-230`） | **一字不改**，且**新增第二用途**：同一个集合当历史行准入的反向索引 | 否，且承重加倍 |
| 2 match-required | 找不到匹配行就 `kept`（`:249-250`） | **一字不改** | 否 |
| 3 tail anchor | 锚点存在性检查 + 游标下界 `anchor+1`（`:211-218`） | **拆成 3a（存在性，保留）+ 3b（逐行准入，替代游标下界）** | 否——见 §1.4 两个反例推演 |
| 前向单调游标 | `cursor = matchedAt + 1`（`:252`） | **一字不改** | 否 |

**关键澄清：本修法不引入任何「回溯」。** 匹配下标 `matchedAt` 依旧**严格递增**（扫描恒从 `cursor` 起，
命中后 `cursor = matchedAt + 1`）。变的只有**起点**：从 `anchorIndex + 1` 下放到 `0`，
再由 3b 逐行把「已结算行」筛掉。因此：

- **下标碰撞不可能**：两个候选不可能命中同一个 `matchedAt`（游标严格越过），
  `historyReplacements` 这个 `Map<number, T>`（`:224`）天然无冲突键——§4 的 T15 钉这条。
- **顺序不可能倒置**：运行时回声按 bucket 序 = 发送序，历史行按文件序 = 发送序，两者同调；
  真出现倒置（F8 分支交错）只会「找不到匹配 → kept → 重复」，失败方向仍在安全侧。

### 1.4 v1 两个原始反例在新规则下的推演

**反例 CE1（Codex blocker：同文本新消息被吃）** —— 现有用例 `:47-57`

- 输入：`bucket=[user-new('继续')]`，`history=[h-old('继续')]`，`snapshot={candidateIds: ∅, anchor: null}`
- 新规则走位：`candidateIds.has('user-new')` 为假 → `:227-230` **直接 kept**，根本走不到匹配循环。
- 输出：`['h-old','user-new']`，**与今天逐字相同**。
- 失败方向：重复（用户刚发的消息保留在时间线上），**不是丢失**。
- 结论：CE1 由 guard 1 独力防御，本修法**没碰 guard 1**。

**反例 CE2 / P1（二次 replay 游标重置吃尾巴）** —— 现有用例 `:68-89`

- 输入：`bucket=[h:old-1('你好'), h:old-2('[Request interrupted by user]'), user-resend('你好')]`，
  `history=[h:old-1, h:old-2]`，`snapshot={candidateIds:{h:old-1,h:old-2,user-resend}, anchor:'h:old-2'}`
- 新规则走位：
  1. guard 3a：`h:old-2` 在 replay 中存在 → 不 bail；
  2. 游标 `cursor = 0`（下放）；
  3. `user-resend` ∈ candidateIds → 进入匹配循环，文本身份 `'你好'`；
  4. `i=0` → `h:old-1` role/文本都命中，**但 `candidateIds.has('h:old-1')` 为真 → guard 3b 拒绝，跳过**；
  5. `i=1` → `h:old-2` 文本不符；
  6. 扫完 → `matchedAt = -1` → `kept`。
- 输出：`['h:old-1','h:old-2','user-resend']`，**与今天逐字相同**。
- 失败方向：重发消息**留在**时间线上（重复），**不是被吃掉**（丢失）。
- 结论：P1 的防线从「游标下界」换成「逐行准入」，防御强度**不降反升**——
  即使锚点计算出错、`cursor` 被错误地设成 0，3b 仍然独立挡住。
  （今天的实现里这两件事是耦合的：锚点算错 = 防线消失。）

### 1.5 洞 A 的真实产生机制（三个可实现的生产者）

RCA §2 的探针夹具是 esbuild 合成件，其字面时序（`h:a3` 已 hydrate 而 `h:u2` 尚未出现）在**追加写**的
JSONL 上不可能自然发生。为免施工方按一个不可复现的夹具去理解修法，这里给出**结构条件**与**三个真实生产者**：

> **结构条件**：存在一条历史行，它①对本次 replay 是新的，②在文件序上位于锚点行**之前**。

| 生产者 | 机制 | 证据 |
|---|---|---|
| **P-1 replacement fold 自伤（最主要）** | 上一轮 replacement fold 把 `h:u2` 这一行**换成了运行时副本**（`:259-262`），于是 `h:u2` 这个 id 从 bucket 里消失；下一轮快照取「bucket 里最后一条 `h:*`」得到的是**更靠后**的行（`snapshotResumeCandidates` `:102-108`），运行时副本从此永远位于锚点之前 | `historyReplayMerge.ts:224,253-262` + `:102-108` |
| **P-2 synthetic uuid 不稳定** | 无 `uuid` 的 JSONL 行取 `synthetic-${totalLines}` 作 id——**按行号派生**。读窗口一变（行数变），同一条内容拿到**不同的 id** ⇒ 旧 id 消失、新 id 出现在文件中段 | `historyReader.ts:770-771`、`:905-906` |
| **P-3 分支/侧链交错（F8）** | `historyReader` 无视 `parentUuid` 平铺回放，兄弟分支行插在文件中段；读窗口滑动会让这些行成批「变新」 | `historyReader.ts:442-450`（`JsonlEntry` 无 `parentUuid`）；`docs/plans/2026-08-17-d48-t10-inspection-triage.md:21,172` |

**P-1 是「为什么偏偏是带图的」的第二半解释**（RCA §3 洞 B 给了第一半）：
图+文消息一旦成功 replacement fold 一次，它就**把自己送进锚点盲区**，从下一次 resume 起永久重复。
所以洞 A 不是「洞 B 的兜底」，对带附件消息而言它是**必修项**。

### 1.6 replacement fold 的位置正确性

命中下标下放后，`historyReplacements.set(matchedAt, message)`（`:254`）写入的是**历史行在文件序里的真实位置**，
渲染结果因此比今天**更**正确——今天未折叠的回声被 `[...mergedHistory, ...kept]`（`:264`）
整体垫在历史块之后，正是用户看到的「恒在最新输入正上方」。三条位置不变量：

- **INV-P1（键唯一）**：`matchedAt` 严格递增 ⇒ `historyReplacements` 不会有两个候选写同一个键。钉子 T15。
- **INV-P2（位置 = 历史序）**：替换只改 `historyMessages` 数组中该下标的**元素**，不改长度、不改顺序（`:261`）。钉子 T2/T9。
- **INV-P3（跨轮幂等）**：被换掉的历史行 id 下一轮不在 `candidateIds` 里 ⇒ 对下一轮是「新行」⇒ 再次被同一运行时副本折进**同一位置**。钉子 T17。

### 1.7 洞 A 施工 diff（`historyReplayMerge.ts`）

替换 `:204-218` 整段（注释一并改写，英文）：

```ts
  // Guard 3a: the anchor's PRESENCE proves `h:<jsonl-uuid>` id continuity
  // across re-reads. When the anchor row is GONE from this replay (head
  // eviction under the read caps — a protocol-legal success with
  // `truncated: true` — or a rewritten JSONL) every id is suspect: the
  // freshness predicate below would classify EVERY row as new and degrade
  // into v1's full-range walk, which is loss. No continuity proof → no
  // folding at all. A snapshot that never had an anchor (first resume) is
  // exempt: nothing was hydrated, so nothing can have drifted.
  if (anchorHistoryId && !historyMessages.some((row) => row.id === anchorHistoryId)) {
    return [...historyMessages, ...runtime];
  }

  // Guard 3b REPLACES the old `cursor = anchorIndex + 1` lower bound (F11
  // hole A). A one-way cursor anchored at the previous hydration tail can
  // never reach a row that is new to THIS replay but sits before the anchor
  // — and a replacement fold creates exactly that shape by removing an `h:*`
  // id from the bucket, so an attachment-bearing turn that folded once was
  // condemned to duplicate forever afterwards. The bound is now per-row:
  // only a row that is NEW to this replay may absorb an echo. A row that was
  // already in the bucket at snapshot time is settled history; folding into
  // it would retroactively re-decide a question the previous merge already
  // answered — which is precisely v1's P1 counterexample (a fresh resend
  // eaten by an unrelated early same-text row; that decoy row is ALWAYS in
  // the candidate set). Matching itself stays strictly forward-only: only
  // the START moves from `anchorIndex + 1` to 0.
  let cursor = 0;
```

匹配循环 `:242-248` 增加一行准入判定（其余不动）：

```ts
    for (let i = cursor; i < historyMessages.length; i++) {
      const candidate = historyMessages[i];
      if (!candidate || candidate.role !== message.role) continue;
      // Guard 3b: settled history rows never absorb an echo.
      if (candidateIds.has(candidate.id)) continue;
      ...
    }
```

---

## §2 洞 B 修法：附件感知身份（分档，不是合取）

### 2.1 两侧字段形状是否同构（实测取证）

**类型层：完全同构。** 三处定义逐字相同：

| 位置 | 定义 |
|---|---|
| 运行时线上形状 `MessageAttachmentMeta` | `src/shared/types/runtimeEvents.ts:182-186` -> `{ kind: 'image' 或 'text'; mediaType: string; name?: string }` |
| 历史线上形状 `HistoryAttachment` | `src/shared/types/sessionHistory.ts:50-54` -> **同上三字段** |
| 渲染端落地形状 `ChatMessageAttachment` | `src/renderer/stores/chatSessions.ts:167-171` -> **同上三字段** |

两侧都真的到得了合并层：

- 运行时：`chatSessions.ts:658` 原样拷贝 `event.payload.attachments` 到 `ChatMessage`；
- 历史：`chatSessions.ts:469-471` 经 `mapHistoryAttachment`（`:446-452`）逐字段拷贝（不 spread）；
- 合并层：`ReplayMergeMessage.attachments`（`historyReplayMerge.ts:68-76`）——头注已写明「C-06 起历史行也带 attachments」，
  今天的实现只是**没读**（`isFoldable :157-159` 只把它当免折判定用）。**⇒ 零改 `chatSessions.ts` 即可拿到两侧附件。**

**值层：三字段里只有两个能往返，第三个必然不等。** 走一遍本 app 自己发图的全链：

| 阶段 | image 附件 | text/document 附件 |
|---|---|---|
| Composer -> `SessionAttachment` | `{kind:'image', mediaType:'image/png', name:'shot.png', data}`（`agentHost.ts:152-159`） | `{kind:'text', mediaType:'text/markdown', name:'notes.md', data}` |
| Host 回声 `beginTurn` | `{kind, mediaType, name?}` 逐字带上（`eventNormalizer.ts:443-453`）-> **name 在** | **name 在** |
| 写进 SDK prompt / JSONL | `{type:'image', source:{media_type: mediaType, data}}`——**没有 title 字段可写**（`claudeRuntime.ts:58-66`） | `{type:'document', source:{media_type}, title: name}`（`:68-77`）-> **name 在** |
| `historyReader` 回读 | `kind:'image'`、`mediaType = source.media_type`（逐字往返）、**`name` 缺席**（`historyReader.ts:637-647`；`:634-636` 注释明写「Images get no name … the Anthropic image block has nowhere to put a filename」） | `kind:'text'`、`mediaType` 往返、`name = title` **相等** |

**结论（承重）**：`kind` 与 `mediaType` 在 image 路径上**逐字往返**；`name` 在 image 路径上**结构性不等**（一侧有一侧无）。
⇒ **附件身份 = 有序的 `(kind, mediaType)` 序列；`name` 必须排除。**
把 `name` 放进身份等价于「图片消息永不可折」——那正是本缺陷本身。

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

**修法：折叠身份分档（tiered），而不是把附件并进文本身份（合取）。**

```ts
type FoldIdentity = { mode: 'text' | 'attachment'; key: string };

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
 * forged by a media type. `name` is DELIBERATELY excluded:
 * `buildPromptWithAttachments` writes a `title` on `document` blocks, but an
 * Anthropic image block has nowhere to put a filename, so the replayed copy
 * of an image turn never has a name while the runtime echo does. Including
 * `name` would make every image turn unmatchable -- the bug itself. Order and
 * count ARE part of the identity: two images and one image are not the same
 * turn. Reads defensively: `attachments` is `readonly unknown[]` here.
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
```

匹配判定（替换 `:236-248` 的文本比较）：候选与历史行必须 **role 相等 ∧ mode 相等 ∧ key 相等**。

**「分档」而不是「合取」是承重选择**，理由是一条**必须保住的既有合同**：
现有用例 `historyReplayMerge.test.ts:243-261`（M1）的历史行 `msg('h1','user','look at this')`
**根本没有 attachments**，运行时副本有。若把附件身份并进文本身份做合取，M1 当场变红，
「图+文」消息从「能折」退回「不能折」——等于用修 F11 的名义制造一个更大的 F11。
分档形态则是**纯粹的加法**：只有「空文本」这一条今天必然 `kept` 的路径改变行为，
任何今天能折的判定**逐位不变**。

### 2.3 误折风险：两条不同截图、都无文本

这是本修法唯一真正新增的暴露面，逐层结算：

**风险构造**：截图 A、截图 B 都是 `image/png`、都无文本 ⇒ 附件身份**逐字相同**（`[["image","image/png"]]`）。

**第一层——计数守恒（可证，不靠经验）**
输出条数 = `|history| + |runtime| - |folds|`，而 `folds` 对历史下标是**单射**（§1.6 INV-P1），
且 replacement fold **不改条数**（只换该下标的元素，`:261`）。

- 「两条候选 + 两行历史」各折一次 ⇒ 输出 2 泡（用例 T11）；
- 「两条候选 + 一行历史」折一留一 ⇒ 输出 2 泡（用例 T12）。

**任何配对方式都不会少一个气泡**——这就是「宁重复不丢失」在附件路径上的形式化版本。

**第二层——最坏后果的量级**
真出现错配（A 的回声折进 B 的行），两行都是 image-only、历史侧**都没有 name**、也没有图像数据
（历史附件是纯元数据，`mapHistoryAttachment :446-452` 不带 data）⇒ 渲染上两者是**同一个 `image/png` chip**。
可见差异只有一处：运行时副本带 `name`（如 `shot.png`），所以「文件名挂到了相邻那一泡上」。
**归类：chip 名归属漂移，不是气泡丢失。** 登记为残留 R1（§5.2）。

**第三层——四道闸门必须同时打开才可能触发**
① 候选在 watermark 内；② 目标行对本次 replay 是新的（guard 3b）；③ 真副本行**恰好缺席**本次 replay；
④ 另一张同 mediaType 的图片行**恰好**排在游标之后。缺一不成立。

**第四层——不加更强守卫的理由**
任何「更强身份」（并入 `name`、并入 data hash）都会让 image 路径**重新失配**
（§2.1 值层实测：`name` 结构性不等；历史侧无 data），
即用一个无法生效的守卫换掉一个只会导致名字漂移的风险——不划算。
真正的杀法是 b 票的精确 id 等值（§0.4）。

### 2.4 洞 B 施工 diff（`historyReplayMerge.ts`）

- **新增** `attachmentIdentity()` / `foldIdentity()` / `FoldIdentity`（§2.2 代码，插在 `coverageText`（`:144-150`）之后）。
- **删除** `:236-240` 的「空文本无条件 `kept`」早退，改为 `foldIdentity(message) === null` 才 `kept`
  （语义等价于「无文本**且**无附件」才免折）。
- **改写** `:241-248` 匹配循环的比较式为 role + mode + key 三元等值（含 §1.7 的 guard 3b 一行）。
- `isFoldable`（`:153-161`）/ `isReplacementFoldable`（`:171-179`）/ `coverageText` **一字不改**。
  image-only 运行时消息的 blocks 是 `[{type:'text', text:''}]` 或 `[]`，两者都通过 `.every(FOLDABLE_BLOCK_TYPES.has)`，
  且带 attachments ⇒ 走 `isReplacementFoldable` 为真的 replacement 分支，附件元数据得以保留。
- **头注（`:1-63`）必须同步改写**：三 guard 的表述改成「1 watermark（双用途）/ 2 match-required /
  3a 锚点=id 连续性证明 + 3b 逐行新鲜度准入」，并补一段 F11 的身份分档说明。
  头注是本模块的合同正文，评审基线就靠它——**不同步改写视为未完工**。

---

## §3 探针三场景逐一推演（修完洞 A+B 后的预期输出）

### 3.0 夹具复原口径

RCA §2 的探针是 esbuild 合成件，只记了输出没记快照入参。这里把三场景的**完整入参**复原出来，
并标注复原依据；复原后的三场景**首尾自洽**（replay#1 的输出正好产生 replay#2 记载的锚点 `h:a3`），
可直接抄成 vitest 夹具。

- `h:u1/h:a1 …`：历史行（`h:` 前缀是合同，`sessionHistory.ts:57-58`）
- `user-s-1003` = 文本 `'B look at this'` + 1 张图；`user-s-1005` = 文本 `'C and this'` + 1 张图

### 3.1 场景一：replay#1（JSONL 尚未刷入两条实发用户行）

| 入参 | 值 |
|---|---|
| `bucket` | `[h:u1, h:a1, user-s-1003, user-s-1005]` |
| `historyMessages` | `[h:u1, h:a1, h:a2, h:a3]` |
| `snapshot.candidateIds` | `{h:u1, h:a1, user-s-1003, user-s-1005}` |
| `snapshot.anchorHistoryId` | `'h:a1'`（bucket 里最后一条 `h:*`，`:102-108`） |

推演：guard 3a 通过（`h:a1` 在 replay 中）→ `cursor = 0`。
`user-s-1003` 身份 = `text/'B look at this'`：`h:u1`/`h:a1` 在 candidateIds 内 → guard 3b 跳过；
`h:a2`/`h:a3` 是 assistant → role 不符。`matchedAt = -1` → `kept`。`user-s-1005` 同理。

**预期输出**：`['h:u1','h:a1','h:a2','h:a3','user-s-1003','user-s-1005']`
——**与今天逐字相同**（本轮无可折之物，修法不制造任何新折叠）。下一轮锚点因此推进到 `h:a3`，与 RCA §2 记载一致。

### 3.2 场景二：replay#2（完整历史已含两条实发消息的副本）— 缺陷现场

| 入参 | 值 |
|---|---|
| `bucket` | `[h:u1, h:a1, h:a2, h:a3, user-s-1003, user-s-1005]`（= 场景一输出） |
| `historyMessages` | `[h:u1, h:a1, h:u2, h:a2, h:u3, h:a3, h:u4, h:a4]` |
| `snapshot.candidateIds` | `{h:u1, h:a1, h:a2, h:a3, user-s-1003, user-s-1005}` |
| `snapshot.anchorHistoryId` | `'h:a3'`（RCA §2 明载） |

推演（新规则）：guard 3a 通过（`h:a3` 在 index 5）→ `cursor = 0`（**今天是 6，盲区就在这里**）。

1. `user-s-1003`：∈ candidateIds ✔；有附件 + 全 text 块 ⇒ `isReplacementFoldable` 真；身份 `text/'B look at this'`。
   - `i=0` `h:u1` ∈ candidateIds → 跳；`i=1` `h:a1` ∈ candidateIds → 跳；
   - `i=2` `h:u2`：**∉ candidateIds（新行）** ✔ role `user` ✔ 文本等值 ✔ ⇒ `matchedAt = 2`，`cursor = 3`，`historyReplacements[2] = user-s-1003`
2. `user-s-1005`：身份 `text/'C and this'`。`i=3` `h:a2` ∈ candidateIds → 跳；
   `i=4` `h:u3` 新行 + role + 文本全中 ⇒ `matchedAt = 4`，`cursor = 5`，`historyReplacements[4] = user-s-1005`
3. `kept` 为空 ⇒ 尾部无追加。

**预期输出**：`['h:u1','h:a1','user-s-1003','h:a2','user-s-1005','h:a3','h:u4','h:a4']`

- 条数 **8**（今天 10）；`'B look at this'` / `'C and this'` **各一次**（今天各两次）；
- 两条带图消息落在**文件序的真实位置**（今天被 `[...history, ...kept]` 垫到最尾，即用户所见「恒在最新输入正上方」）；
- 运行时副本在位 ⇒ **附件 chips 保留**（history 侧 image 行无 name，运行时副本有）。

### 3.3 场景三：replay#3（结构是否自愈 / 是否幂等）

入参 = 把场景二的输出当作新 bucket 再跑一次；`historyMessages` 不变。

| 入参 | 值 |
|---|---|
| `bucket` | `['h:u1','h:a1','user-s-1003','h:a2','user-s-1005','h:a3','h:u4','h:a4']` |
| `snapshot.candidateIds` | 上述 8 个 id |
| `snapshot.anchorHistoryId` | `'h:a4'` |

推演：guard 3a 通过 → `cursor = 0`。
关键一步：`h:u2` / `h:u3` **仍然不在 candidateIds 里**——它们上一轮被 replacement fold 换掉，
id 已从 bucket 消失（§1.6 INV-P3）。于是两条运行时副本**再次折进同样的下标 2 / 4**。

**预期输出**：与场景二**逐字相同**（不动点，幂等）。

对照今天：RCA §2 记「replay#3 结构不再自愈，重复恒在」。修后的性质反过来——
**第一次修好之后，之后每次 resume 都稳定重现同一结果**，不会漂移也不会再生重复。

### 3.4 场景四：image-only 独立探针（洞 B 专项）

| 入参 | 值 |
|---|---|
| `bucket` | `[user-s-3001]`（空文本 + 1 张 `image/png`） |
| `historyMessages` | `[h:x1, h:x2]`（两行 image-only，`blocks: []`，各带 1 张图） |
| `snapshot.candidateIds` | `{user-s-3001}` |
| `snapshot.anchorHistoryId` | `null`（首次 resume，无 hydration） |

推演：`foldIdentity(user-s-3001)` 文本为空 ⇒ 落 attachment 档，key = `[["image","image/png"]]`。
`h:x1` ∉ candidateIds ✔、role `user` ✔、`coverageText` 空 ✔、附件身份相同 ✔ ⇒ `matchedAt = 0` ⇒ replacement fold。

**预期输出**：`['user-s-3001','h:x2']`（今天：`['h:x1','h:x2','user-s-3001']`）。

两种读法都要交代清楚：

- **读法①（`h:x1` 就是真副本）**：结果完全正确，2 泡、位置正确、chip 带 name。
- **读法②（`h:x2` 才是真副本，`h:x1` 是更早的另一张图）**：折进了 `h:x1` ⇒ 残留 R1。
  但输出**仍是 2 泡、顺序不变**，唯一差异是 name 挂到了前一泡上（§2.3 第二层）。
- **两张图 mediaType 不同时读法②自动消失**：`image/png` vs `image/jpeg` 身份不等 ⇒ `h:x1` 被跳过、
  `h:x2` 命中 ⇒ 完全正确。这正是把 `mediaType` 留在身份里的收益（`name` 不能留，`mediaType` 必须留）。

**三场景 + 专项的总账**：RCA 记载的 4 个重复气泡（`'B look at this'` ×1 冗余、`'C and this'` ×1 冗余、
image-only ×1 冗余、以及 replay#3 的恒久化）全部消除，且无任何一个气泡被删除。

---

## §4 测试合同（RCA §4 底线五条展开）

### 4.0 底线五条 → 用例映射

| RCA 底线 | 本稿用例 |
|---|---|
| 正控① 图+文消息二次 replay 后单例 | T2、T17 |
| 正控② image-only 消息 resume 后单例 | T3、T4 |
| 正控③ 锚点前副本（replay#2 场景）可折叠 | T1、T2 |
| 负控① resume 后新发的同文本消息不被误吃（v1 反例保持） | T5、T6、T7 |
| 负控② replacement fold 后附件 chips 保留 | T13 |

### 4.1 新增用例逐条表（`src/renderer/stores/__tests__/historyReplayMerge.test.ts`）

夹具助手（加在 `msg`（`:22-24`）之后）：

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
```

| # | 正/负控 | 夹具形状 | 断言 | 咬住的命题 |
|---|---|---|---|---|
| **T1** | 正控③ | `bucket=[h:old, user-e('X')]`；`history=[h:new('X'), h:old, h:tail]`——`h:new` 排在锚点行 `h:old` **之前**；`snap(['h:old','user-e'], 'h:old')` | `ids === ['h:new','h:old','h:tail']`；`merged.length === 3`（尾部无 `user-e`） | 锚点前的**新行**可折（洞 A 核心，纯文本臂；`user-e` 无附件走普通 fold，不产生 replacement） |
| **T2** | 正控①③ | 场景二完整夹具（§3.2 四行入参，两条候选带 `attachments:[att('image','image/png','a.png')]`） | `ids === ['h:u1','h:a1','user-s-1003','h:a2','user-s-1005','h:a3','h:u4','h:a4']`；`merged.length === 8`；`merged[2].attachments` 深等值原附件 | 洞 A + replacement 位置正确性（INV-P2） |
| **T3** | 正控② | 两臂：**(a)** 运行时 `attMsg('user-s-3001','user',[att('image','image/png','a.png')], [{type:'text',text:''}])`；**(b)** 同上但 `blocks: []`。`history=[attMsg('h:x1','user',[att('image','image/png')])]`；`snap(['user-s-3001'])` | 两臂均 `ids === ['user-s-3001']`；`merged[0].attachments` 带 `name:'a.png'` | 附件身份 + 两侧 blocks 形状差异（空 text 块 vs 无块）都能匹配 |
| **T4** | 正控② | 把 T3(a) 的**输出**当新 bucket 再跑：`bucket=['user-s-3001']`，`history=[h:x1]`，`snap(['user-s-3001'], null)` | `ids === ['user-s-3001']`（不动点） | image-only 折叠跨轮幂等（INV-P3） |
| **T5** | 负控① | v1-CE1：`bucket=[msg('user-new','user','继续')]`，`history=[msg('h-old','user','继续')]`，`snap([])` | `ids === ['h-old','user-new']` | guard 1 未被本修法削弱（既有 `:47` 的显式重述） |
| **T6** | 负控① | v1-CE2/P1：既有 `:68-89` 夹具**逐字复用**，标题改为「eligibility, not the cursor, is what stops P1」 | `ids === ['h:old-1','h:old-2','user-resend']`；**追加**：`merged.length === 3` | guard 3b 独力挡住 P1（承重反例） |
| **T7** | 负控① | P1 变体：把 T6 的 `anchorHistoryId` 改成 `null`（模拟锚点计算失效） | 仍 `ids === ['h:old-1','h:old-2','user-resend']` | 证明防线**不依赖锚点**——今天这条会红（今天 anchor=null ⇒ cursor=0 ⇒ 吃掉 resend） |
| **T8** | 负控 | image-only 但 mediaType 不同：运行时 `image/png`，历史 `image/jpeg` | `ids === ['h:x1','user-s-3001']` | `mediaType` 在身份内（宁重复不丢失） |
| **T9** | 负控 | 运行时 image-only 有附件，历史行**无** attachments 且 `blocks:[]`（协议防御，`historyReader` 不产此形） | `ids === ['h:empty','user-s-3001']` | 空身份历史行不吸收任何候选 |
| **T10** | 负控 | 空文本**且**无附件（既有 `:323` 的 `user-empty` 半边独立成例） | `ids === ['h1','user-empty']` | 免折早退只被「无文本无附件」触发 |
| **T11** | 正控（守恒） | 两条 image-only 同身份 + 两行同身份历史，`snap` 两候选 | `ids === ['user-a','user-b']`；`merged.length === 2` | 计数守恒 · 各折一次（§2.3 第一层） |
| **T12** | 负控（守恒） | 两条 image-only 同身份 + **一行**历史 | `ids === ['user-a','user-b']`（一条替换在位、一条 kept）；`merged.length === 2` | 供不应求时**不丢泡** |
| **T13** | 负控② | T2 的 `merged[2]`/`merged[4]` | `attachments` 与运行时副本**深等值**（含 `name`），且 `merged[2].id` 是运行时 id | replacement fold 后 chips 保留 |
| **T14** | 负控（防回归） | 既有 M1（`:243-261`）夹具**逐字复用**，追加注释「history row has NO attachments on purpose」 | `ids === ['user-att']` | 文本档**不比较附件**（分档 ≠ 合取） |
| **T15** | 结构不变量 | 两条同文本候选 + 两行同文本历史，两条都带附件 | 断言两个 replacement 落在**不同下标**：`merged[0].id==='echo-1' && merged[1].id==='echo-2'`；且 `merged.length === 2` | INV-P1 键唯一 / 游标严格递增 |
| **T16** | 负控 | image-only 候选 role `user`，历史 image-only 行 role `assistant` | `ids === ['h:x1','user-s-3001']` | 附件档仍要求 role 相等 |
| **T17** | 正控①（幂等） | 场景三（§3.3）：T2 的输出当 bucket 再跑 | `ids` 与 T2 **逐字相同** | 「修好之后不再漂移」（对照 RCA replay#3） |

> **T1 写法提示**：`h:new` 必须排在锚点行之前才咬得住洞 A；若写成锚点之后，今天的实现也绿，该用例就是空壳。
> 施工时**先按今天的代码跑一遍 T1/T2/T3/T7**，四条必须**全红**——不红说明夹具没构造出盲区，需重写。

### 4.2 既有 26 条用例的存亡结论

**结论：26 条（`mergeReplayedHistory` 21 条 + `resume snapshot registry` 5 条）全部零改动保持绿。**
逐条复核已做，只列会被误认为要改的四条：

| 既有用例 | 复核 | 结论 |
|---|---|---|
| `:68` anchor P1 | 新规则下 `h:old-1`/`h:old-2` 都 ∈ candidateIds ⇒ guard 3b 拒绝 ⇒ 仍 kept | 绿（防线换人，结果不变） |
| `:91` G14 codex 钉现行为 | `codex-user` 折进 item-1（item-1 ∉ candidateIds）；`codex-asst` 含 `tool_call` ⇒ 不可折 ⇒ 追加在尾 | 绿（L6 现行为不被本批改动） |
| `:243` M1 replacement fold | 文本档，历史行无 attachments 也照折 | 绿（正是分档形态要保的） |
| `:323` 无 coverage text 不参与匹配 | 两个夹具都**无 attachments** ⇒ `foldIdentity` 仍返回 `null` | 绿；**但标题与注释需补一句**「…and no attachments」，否则合同陈述与实现不符（空壳风险） |

### 4.3 变异测试计划（9 对，逐对实跑记红灯，零跳过）

变异纪律沿用 D48 工法：**字节级替换**改被测源，scoped 跑 vitest，抄红灯原文，再字节还原并复绿。
每对必须**恰好**咬住表中的用例；若变异存活，说明该用例是空壳，**先补断言再继续**。

| # | 变异（对 `historyReplayMerge.ts` 的字节改动） | 预期变红 | 承重命题 |
|---|---|---|---|
| **①** | 删掉 guard 3b 整行 `if (candidateIds.has(candidate.id)) continue;` | **T6 + T7 + 既有 `:68`** | 逐行准入是 P1 的唯一防线（不补这对，v1 反例可无声复活） |
| **②** | `let cursor = 0;` 改回 `let cursor = anchorIndex + 1;`（并恢复 `findIndex`） | **T1 + T2 + T17** | 起点下放是洞 A 的修法本体 |
| **③** | 删掉 guard 3a 的 `if (anchorHistoryId && !historyMessages.some(...)) return [...]` 整块 | **既有 `:174`** | id 连续性证明不可省（round-6 verify blocker 资产） |
| **④** | `attachmentIdentity` 只编码 `kind`，丢掉 `mediaType` | **T8** | mediaType 在身份内 |
| **⑤** | `attachmentIdentity` 把 `name` 加回三元组 | **T3 两臂 + T4 + T13** | name 必须排除（image 路径两侧结构性不等） |
| **⑥** | `foldIdentity` 文本档改成合取：`key = text + attachmentIdentity(message)` | **既有 M1 `:243` + T14** | 分档 ≠ 合取（防「修 F11 制造更大 F11」） |
| **⑦** | 在匹配前恢复 `if (coverageText(message).length === 0) { kept.push(message); continue; }` | **T3 两臂 + T4 + T11 + T12** | 附件档必须真的可达（洞 B 修法本体） |
| **⑧** | `cursor = matchedAt + 1` 改为 `cursor = matchedAt` | **T15 + 既有 `:188` 的单史行半边** | 前向严格递增 ⇒ 下标键唯一（INV-P1） |
| **⑨** | `historyReplacements.set(matchedAt, message)` 改为 `set(historyMessages.length - 1, message)` | **T2 + T13** | replacement 落在**匹配下标**而非尾部（INV-P2，正是本缺陷的可见形态） |

**发射半边纪律**：②、⑦ 是「修法本体」变异——施工前先按今天的代码跑 T1/T2/T3/T7，
四条必须全红；施工后复绿。这一红一绿构成本批的**发射证据**，写进 as-built。

### 4.4 收口门（逐门串行跑，禁链式合跑）

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm vitest run src/renderer/stores/__tests__/historyReplayMerge.test.ts`（26 + 17 = **43 条全绿**）
4. `pnpm test`（全量；本批不应改变任何其他套件的结果）
5. 9 对变异逐对实跑，抄红灯原文
6. `git diff --stat` 与 §5.1 影响面表逐文件核对（**只应有 2 个文件**）

### 4.5 flag 问题的显式处置

工程规范 #6 要求新能力带 flag 双跑。本批**不加运行时 flag**，理由与代偿如下：

- 本改动是**纯叶子函数**、零 I/O、零 store 依赖（`historyReplayMerge.ts:59-63` 的 leaf-module 铁律），
  加 flag 会把 43 条用例的矩阵翻倍，去守一个本身就 fail-open 的折叠判定；
- 该模块**天然自带 off 位**：`snapshot === null` ⇒ 一行都不折（`:196-201`），
  incident 层要复现旧形态直接喂 `null` 快照即可，不需要新开关；
- **回滚代价已量化**：撤回 = 还原两处字节（`cursor` 初值 + guard 3b 一行）+ 删三个新函数，
  两个洞的修法**互相独立**，可单独回滚其一。

as-built 必须记：off 位（`snapshot: null`）与 on 位（正常快照）各跑一轮全量套件。

---

## §5 边界、残留与序关系

### 5.1 影响面全清单

| 文件 | 动作 |
|---|---|
| `src/renderer/stores/historyReplayMerge.ts` | 头注三 guard 表述改写（`:1-63`）；新增 `FoldIdentity` / `foldIdentity` / `attachmentIdentity`；`:204-218` 换成 guard 3a 存在性检查 + `cursor = 0`；`:236-248` 换成三元等值 + guard 3b 一行。`coverageText` / `isFoldable` / `isReplacementFoldable` / 快照注册表四件**一字不改** |
| `src/renderer/stores/__tests__/historyReplayMerge.test.ts` | 新增 T1~T17；既有 26 条零改动（仅 `:323` 补标题与注释一句） |

**明确不改（红线）**

| 文件/对象 | 理由 |
|---|---|
| `src/renderer/stores/chatSessions.ts` | **零改动**。两侧 attachments 今天已经流到合并层（§2.1），本修法无需触碰。同时这是 F2 的红线文件（F2 §10.4） |
| `src/agent-host/historyReader.ts` | 分支盲归 F8；本批不碰读侧 |
| `src/agent-host/eventNormalizer.ts` / `src/shared/types/runtimeEvents.ts` | uuid 透传归 F11-b；本批不碰协议面 |
| `resumeSnapshots` 注册表与 `snapshotResumeCandidates` / `takeResumeSnapshot` | 快照语义不变；`candidateIds` 只是**多了一个读者**，产出侧一字不改 |

### 5.2 残留风险登记（本批不修，写进 backlog）

| # | 残留 | 触发条件 | 后果量级 | 归属 |
|---|---|---|---|---|
| **R1** | 两条同 `(kind, mediaType)` 的 image-only 消息错配 | 真副本行缺席 + 另一张同类型图片行在游标之后（四闸门同时开，§2.3 第三层） | **气泡数不变**，仅 chip 的 `name` 归属漂移一泡 | F11-b（精确 id 等值可根治） |
| **R2** | 折叠停摆期间产生的重复无法回头修 | 读失败 / 空快照 / 锚点失踪期间历史行完成 hydration，此后该行永远是「已结算行」 | 重复气泡持续到**应用重启**为止——bucket 是内存态，`useChatSessionsStore`（`chatSessions.ts:1000`）**无 `persist` 中间件**，重启即清空运行时回声 | 已知边界，接受 |
| **R3** | 文本漂移导致的失配 | `historyReader` 存的是 `stripSystemTags(raw)` 的**剥离后**文本（`:471-480`、`:896`），运行时回声是原始文本；另有 64KB 截断（`:197`、`:902-903`） | 该消息永不折叠 ⇒ 重复（安全方向） | F11-b |
| **R4** | 分支行扩大失配面 | `historyReader` 无 `parentUuid`，废弃分支行平铺进 replay（`:442-450`） | 抬高 R1 的四闸门同时开的概率 | F8 |

### 5.3 与 F8（historyReader 分支盲）的关系

- **同文件冲突：无。** F8 独占 `src/agent-host/historyReader.ts` + 其测试；本批独占
  `src/renderer/stores/historyReplayMerge.ts` + 其测试。**可完全并行。**
- **顺序依赖：无。** 本批不依赖 F8 的任何产出；F8 也不需要本批先落。
- **语义耦合（两条，必须写进 F8 的回归清单）**：
  1. F8 按 `parentUuid` 剪掉废弃分支后，`historyMessages` 会**变短且行集合改变**。
     若被剪掉的恰是已 hydrate 的锚点行 ⇒ 触发既有 guard 3a 的 bail（**一行不折**）——
     方向安全（重复而非丢失），但会让「修好的时间线在 F8 落地那一轮短暂退回重复态」，属预期行为。
  2. F8 剪枝会**降低** R1 与 R4 的暴露面 ⇒ **F8 是 F11 的增强，不是前置**。
- **建议序**：F11 先落（不等 F8）；F8 落地后**回归跑 T7 / T11 / T12 / 既有 `:174`** 四条。

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
| **F8** | 增强（非前置） | ✅ | ❌ 无 | F8 落地后回归跑 T7/T11/T12/`:174` |
| **F456** | 无关 | ✅ | ❌ 无 | — |
| **F11-b** | 本批的后续增强 | ❌ | ✅ 有（`chatSessions.ts`） | 需 F2 收口解冻 + 前置探针门（§0.4） |

---

## §6 施工顺序与收口

### 6.1 建议施工序（单片，无需切片）

1. **先落会红的测试**（规范 #12「先定验证再改代码」）：加 T1 / T2 / T3 / T7，按今天的代码跑，
   **四条必须全红**——抄红灯原文进 as-built。不红即夹具没构造出盲区，重写夹具再来。
2. 落洞 A（§1.7 两处 diff）→ 跑 T1 / T2 / T7 转绿，26 条既有用例保持绿。
3. 落洞 B（§2.4 三个新函数 + 两处改写）→ 跑 T3 / T4 / T8~T16 转绿。
4. 补 T5 / T6 / T17 与 `:323` 的标题订正。
5. 改写头注（`:1-63`）——**这是合同正文，不改视为未完工**。
6. 跑 §4.4 六道门 + §4.3 九对变异。

### 6.2 as-built 必须记的项

- git commit；四门逐门实跑输出；
- 步骤 1 的**四条红灯原文**（发射证据的红半边）与步骤 2/3 后的绿半边；
- 9 对变异逐对红灯原文，**零跳过**；
- off 位（`snapshot: null`）/ on 位双轮全量结果；
- `git diff --stat` 与 §5.1 影响面表逐文件核对（**只应有 2 个文件**）；
- 与本规格的偏差条目（若有）。

### 6.3 真机点验建议（补充，非收口条件）

复现 RCA §1 用户原述的两段路径各一次：

1. 发一条「图 + 文」→ 等回复 → 侧栏切走再切回（走 resume）→ 再切一次；
   **预期**：该消息始终**只有一条**，chip 在位；重复不再随 resume 次数增长。
2. 发一条**纯图片无文字** → 应用重启 → 打开该会话；
   **预期**：单例，chip 在位。

---

## §7 一句话收束

F11 的两个洞都在渲染端合并层，都可以在**一个叶子模块内**修完：
洞 A 把锚点从「游标下界」降格为「id 连续性证明」，改由**逐行新鲜度准入**兜住 v1 的 P1 反例
（准入比游标更强——它不依赖锚点算得对）；
洞 B 把折叠身份**分档**——有文本仍走文本（既有能折的一位不变），无文本才回退到
有序 `(kind, mediaType)` 附件身份（`name` 因 image 路径两侧结构性不等而必须排除）。
两者都是**纯粹的加法**：今天能折的判定逐位不变，只有今天必然重复的路径改变了结果，
失败方向仍然恒为「重复而非丢失」。
uuid 改道（候选 b）是更彻底的正解，但它 codex 轴无源、活发送时 uuid 未实证、且必须动 F2 的红线文件——
降级为 F11-b，带前置探针门与解冻条件。
