# F4 + F5 + F6 施工规格 rev.2 —— 阅读性 + Composer 批

> 来源：`docs/plans/2026-08-17-d48-t10-inspection-triage.md` 的 F4 / F5 / F6 三项发现，
> 与该档「拍板记录」第 5 条（2026-08-18 用户对 HTML 对比稿的拍板）。
> 对比稿：`docs/design/2026-08-18-f5-chat-readability-draft.html`。
> 状态：**规格 rev.2，已消化双轨评审（A 轨 Opus 4B+8M+12m / B 轨 Codex 1B+9M+2m），判语「可开工」**。本档只写规格，不改任何生产代码。
> 口径：每条裁定标注【实测】（本轮在本机核验，带 `file:line`）或【推测】（未实测的推断，须施工时验证）。
> 与对比稿工程标注冲突处一律显式写「【与对比稿冲突】」并给出实测依据。

| 项 | 值 |
|---|---|
| 日期 | 2026-08-18（rev.1 → rev.2 同日） |
| 分支 | `feat/openchamber-chat-refactor` |
| **锚点基线 HEAD** | **`d9281d0`** —— 本档全部 `file:line` 在此 commit 重取（rev.1 的时间线锚点停在 `c5cbd19` 之前，见 §0.7） |
| 上游批次边界 | F2 超时体系批，**权威档 = `docs/plans/2026-08-18-f2-watchdog-arbitration.md`（双轨仲裁 + §15 拍板 D1~D6）**；F2 rev.2 定稿并行产出中，本档对 F2 的一切引用**以 F2 rev.2 为准** —— 见 §0.4 |
| 用户拍板（不可讨论） | D1-b · D2-b · D3-c 与 D3-b **并用** · 无背景图 |
| **本规格内已决、不再复议** | ① `--tool-arg` **保留派生 + 混合比 85%**（§2.3，非「只改 muted-foreground」）；② `(up to Ns)` 从句**退役**（§7.2）；③ `stalled` 走**可辨措辞档**（§7.5，B-4 裁定方案 a） |
| 触碰的已冻结基线 | phase0a「助手：完全平铺，无容器」· D26 ④ · design-system「已知偏差」表 · F-C4「两档节拍」不变量 |
| 预计切片 | 4 片（token 层 / 时间线层 / composer 层 / 等待行层），依赖序见 §9.2 |

### rev.2 修订摘要（双轨评审逐条处置）

两轨共 36 条发现，**采纳 34 条、部分采纳 2 条、有据否决 0 条**。逐条对照见 **§0.0**。
六条改变施工前提的：

1. **全部时间线锚点重取**（A/B-1、B 轨②）：`MessageTimeline.tsx` 位移 +15~17 行，`chatTimelineLayout.ts` +15 行；高漂移文件改用「符号名 + 行号 + 关键原文」三元锚，锚点总表落 **§0.7**。
2. **D3-b 容器挂载点纠正**（A/B-2）：`:1209` 现指 **process 面板**，`answer` 段实在 **`:1224`**；照 rev.1 施工即等于落成 M-15 变异。
3. **与 F2 的「无文件级冲突」为假**（A/B-3）：按 F2 仲裁档 §11.1，两批共享 **5 份**生产文件 + **3 份**测试文件、**2 处同区冲突**（`ChatComposer.tsx` 的 `beginTurnSend` 实参表 · `MessageTimeline.tsx` 的 `deriveTurnStatus` 调用点）；§0.4 改写为**显式序约束**（F2 S2/S3 先落 → 本批 ② ④ rebase）。⚠️ rev.2 初稿曾把 `turnSendStatus.ts` 也判为同区，经 F2 rev.2 反驳 + 本档实读复核**已撤回**（§0.4 ⑤）。
4. **`stalled` 档改走可辨措辞**（A/B-4）：rev.1 的「文案与 slow 完全相同」按构造违反 F2 仲裁档 §8.3 刚立的 kind/copy 同源不变量；§7.5 改为阈值同源导入 + 两档措辞可辨，[TS-1] 承重半边扩到两档。
5. **Q1 不再是开放问题**（B 轨 blocker）：`--tool-arg` 85% 已由 §2.3 裁定，`§10.1 Q1` 的「待拍板」身份删除，候选 B 降为**仅历史存档**并补齐清单缺件（M-9）。
6. **[D3-6] 的 sticky 因果链证伪**（B 轨④）：answer 容器是 sticky band 的**后续兄弟的后代**，不是祖先；该断言与 M-14 的「会静默关掉置顶气泡」说法退役，换成诚实的形态锁。

---

## 目录

- §0.0 双轨评审逐条处置表（rev.2 新增）
- §0 本批边界、取证核对表与前置事实
- **§0.7 锚点总表（HEAD `d9281d0` 重取 · 高漂移文件三元锚 · 本档锚点的唯一权威）**
- §1 F5-D1-b 排版密度换档（散文层）
- §2 F5-D2-b 次要层 token 提档（全局 token 层）
- §3 F5-D3-c 用户气泡非对称（时间线角色层）
- §4 F5-D3-b 助手中性容器与**解嵌套裁定**
- §5 基线条款正式修订与归档纪律
- §6 F6 Composer 两行布局
- §7 F4 等待行
- §8 静态不变量、测试与变异计划
- §9 切片方案与影响面全清单
- §10 Open questions 与实现方否决权上报路径

---

## §0.0 双轨评审逐条处置表（rev.2 新增）

两轨存证：`docs/plans/2026-08-18-f456-reviews/trackA-opus.md` · `docs/plans/2026-08-18-f456-reviews/trackB-codex.md`。
处置口径：**采纳**＝rev.2 已按建议改；**部分采纳**＝纠错成立但结论保留，换理由；**否决**＝有据不改（本轮为零）。

### A 轨（Opus，双盲）

| 编号 | 主张 | 处置 | 落点 / 理由 |
|---|---|---|---|
| **B-1** | `MessageTimeline.tsx` 全部锚点停在 `c5cbd19` 前（+15~17 行） | **采纳** | §0.7 锚点总表按 HEAD `d9281d0` 重取；§0.5 C6 / §1.3 / §3.2 / §3.4 / §4.3 / §5.4 / §7.4 / §7.5 / §9.1 / §9.3 全部改三元锚 |
| **B-2** | 容器挂载点 `:1209` 现指 process 面板，answer 实在 `:1224` | **采纳** | §4.3 改锚 + 加「照 `:1209` 施工即 M-15 变异」的显式警告 |
| **B-3** | 「与 F2 无文件级冲突」为假（≥4 份共享；turnSendStatus 双槽、deriveTurnStatus 字面量两处同区冲突） | **采纳（其中 turnSendStatus 一项经实读复核后撤回）** | §0.4 整节重写为序约束表；§9.2 加跨批次 rebase 门。⚠️ 评审主张的「turnSendStatus 双槽同区」**不成立**：两批加在不同 interface、隔 64 行（§0.4 ⑤，F2 rev.2 同判） |
| **B-4** | `stalled` 与 `slow` 同文案违反 F2 §8.3 的 kind/copy 同源 | **采纳（走方案 a）** | §7.5 改为「阈值同源导入 + 措辞可辨」；§9.3 补 `turnStatus.ts` 源注重写；不可行时的退路 (b) 见 §7.5-c |
| **M-1** | 对 F10 产物（`userBubbleTextClass()` / `line-clamp-6`）无感知 | **采纳** | §3.2 加 clamp 容器行；§3.4 新增④；§8.5 G-3 重写 |
| **M-2** | `flex justify-end` + `max-w-[85%]` 被 `min-width:auto` 击穿（缺 `min-w-0` / `break-words`） | **采纳** | §3.2 类串补 `min-w-0`；正文 `<p>` 补 `break-words`；§8.2 [D3-1] 加断言 |
| **M-3** | §2.4-c 判定口径自相矛盾（滚动条 hover 已超 `border-border` 参照却判「零处豁免」） | **采纳** | §2.4-b/c 重写：改「常态对标 border、交互态显式豁免」，结论从「零处豁免」改「一处显式豁免」 |
| **M-4** | `/NN` alpha 被当 Oklab 混合算，应按 sRGB 合成 | **采纳** | §0.6 补合成口径；§2.4-b 表全部重算（数值有变，裁定方向不变） |
| **M-5** | `rounded-[21px]` 的 runaway 论证误读（33–37px 说的是 `rounded-full` 被 clamp） | **部分采纳** | 纠错成立、**结论保留**：退役理由换成「21 的推导链（`total/2`）在 74px 下失效；照链推得 37px 固定值，正落在 §5.3 点名的 runaway 弧段，且两行卡已无 pill 心智」。见 §6.7 |
| **M-6** | `F-A2` 的 `items-center` 断言必红 + `opts` 退役的编译中断漏列 | **采纳** | §8.3 F-A2 行补必红点（`middleColumnLayout.test.ts:255`）；§6.7 补 `opts` 退役的调用点/类型影响 |
| **M-7** | `[F6-4]` 在 `composerFormStatic.test.ts` 现有工法下不可实现 | **采纳** | 与 B 轨⑥合并处置：§8.3 F6-4~F6-6 改 JSX AST 断言并写明工法新增成本 |
| **M-8** | `leading-normal` 落点实为 **9** 处非 5 处 | **采纳** | §1.3 表补 `QuestionCard.tsx` ×3 与 `EnhancedInput.tsx` ×1（全部「不换」）；[INV-D1-1]③ 扩到全部不换点 |
| **M-9** | 候选 B 清单漏 `toolCard.ts:823` 与 `toolRowArg.test.ts:48` | **采纳** | §2.3 候选 B 清单补全（另补 `lib/utils.ts:19` 注释与 `lib/__tests__/utils.test.ts:30-31` 真断言），并标「仅历史存档」 |
| m-1 | 数值出处未给可复算命令 | **采纳** | §0.6 补命令 + HEAD |
| m-2 | F2 节号引错 | **采纳** | 全档改指仲裁档节号 |
| m-3 | 两处 F10 前行号仲裁档同日已订正（`:1372-1377` → `:1389`）而本档未取 | **采纳** | §7.5 / §0.7 已取订正值 |
| m-4 | agent picker 的 radio 实为**两枚**非三枚 | **采纳** | §6.6 ③ 订正（`AGENT_DISPLAY_NAMES` 只有 `claude-code` / `codex`） |
| m-5 | `text-warning` 是知情违反词表禁令，未上报 | **采纳** | §7.5 ③ 升格为**显式知情偏离**，进 D49 台账行与 §10.2 |
| m-6 | §7.1 六分支表与 §7.5 的 stalled 冲突 | **采纳** | §7.1 表补 `stalled` 行，六分支→七分支 |
| m-7 | 测试锚点小漂移 | **采纳** | §1.6 / §7.7 / §8.3 锚点逐条重取 |
| m-8 | `expectUnwired` 无范围机制 | **采纳** | 与 B 轨⑤合并：§8.2 改 AST 节点级定位 |
| m-9 | 文件头叙事变假（`MessageTimeline.tsx` 头注的 `--card` fill） | **采纳** | §5.4 重取锚点（`:699-711` 头注 + `:737-742` 内注） |
| m-10 | `composerRowsClass()` 挂载点未指定 | **采纳** | §6.3 指名挂载点 `ChatComposer.tsx:2605` |
| m-11 | `budgetMs` 退化后 `budgetSeconds` 成死局部 | **采纳** | §7.2 补：删局部变量、保留入参，否则 lint 必红 |
| m-12 | 路径与计数零碎错 | **采纳** | §2.4-c 计数改 845/154；§8.1(c) 测试份数改 9 |

### B 轨（Codex）

| 编号 | 主张 | 处置 | 落点 / 理由 |
|---|---|---|---|
| **B-1（blocker）** | Q1 施工入口矛盾：§2.3 已裁 85%，§10.1 又列待拍板 | **采纳（按「85% 已决」解）** | 删 Q1 的开放问题身份；候选 B 降为**仅历史存档**；文首「不可复议清单」逐字钉明 |
| M-2 | 大批 `file:line` 已漂移 | **采纳** | 同 A 轨 B-1，§0.7 |
| M-3 | 漏 `chatMarkdownRender.test.ts:300` 必红 | **采纳** | 进 §1.6 / §8.1(c) / §8.2 / §9.2 片② / §9.3；测试份数统一为 **9（8 改 + 1 新建）** |
| M-4 | `[D3-6]` / M-14 的 sticky 因果链错误，变异 inert | **采纳** | §8.2 退役 `[D3-6]` 的 sticky 论证，换 `[D3-6′]` 形态白名单锁；M-14 重标为形态漂移而非安全缺陷 |
| M-5 | D3 结构断言用全文件投影，挂错节点仍绿 | **采纳** | §8.2 全组改 TypeScript AST 节点级定位（`UserBubble` → `<article>` → bubble `<div>` → 附件 `<span>`；`answer.length > 0` 条件表达式的直接 JSX 节点） |
| M-6 | F6 结构测试与切片 ownership 不完整（空壳路径 + 漏 `ComposerAgentPicker.tsx`） | **采纳** | §8.3 F6-4~F6-6 改 AST；§9.2 片③独占文件表补 `ComposerAgentPicker.tsx` |
| M-7 | `promptChars` 漏 `PendingTurnHead` 第二消费者 | **采纳** | §7.4 补第二消费者 + pending-window 用例；§0.7 锚点 `MessageTimeline.tsx:1262-1271` |
| M-8 | F4 多条断言只证形态不证接线；F4-6 按指定文件不可执行 | **采纳** | §8.4 F4-1/F4-3/F4-4/F4-5 全部加具体数值映射与交错调用；`turnStatusToneClass` 抽为可测纯模块 |
| M-9 | 未覆盖 `line-clamp-6` × 多段 × 附件 × 85% 的真实结构；G-3 误写「三行」 | **采纳** | §3.4 ④ 新增结构合同裁定；§8.5 G-3 改「**六行** clamp」并拆四场景 |
| M-10 | 切片矩阵与 ownership 不完整，「真正零混面」表述不成立 | **采纳** | §9.1/§9.2 改「`① ∥ ② ∥ ③` → ④ rebase」，聚合文档指定唯一 owner，删「真正零混面」措辞 |
| m-1 | 845/154 计数口径 | **采纳** | §2.4-c 重算并附命令 |
| m-2 | `color-mix` 构建链表述应改 + 补 CDP 探针 | **采纳** | §2.1 写法纪律注 + §8.5 新增 G-11 computed-style 探针 |

---

## §0 本批边界、取证核对表与前置事实

### 0.1 本批做什么

三件互相独立、可并行的改造，共用一次 GUI 点验：

| 代号 | 内容 | 层 |
|---|---|---|
| **F5** | 聊天可读性三维度落地（密度 / 对比 / 角色区分） | globals.css token 层 + chatMarkdownPolicy 散文层 + MessageTimeline 角色层 |
| **F6** | Composer session 模式拆两行 | ChatComposer + middleColumnLayout |
| **F4** | 回合头等待行变富（俏皮动词 + ↑↓ 计数 + slow 色阶降级） | attachments.ts / turnStatus.ts / turnSendStatus.ts |

### 0.2 本批**不**做什么（显式越界声明）

- **超时阈值参数、看门狗行为、`SLOW_WAIT_HINT_SECONDS` 数值** —— 全部归 F2 批。本批**读**这些常量，**不改**其值。
  F2 仲裁档 **§8.2** 裁定 `SLOW_WAIT_HINT_SECONDS` **保持 45、不上调**；预算改由新建 `sendBudgets.ts` 的
  `SEND_SILENCE_CEILING_MS`（300s）供给，另有 D6 拍板的 `SEND_WAIT_LOOP_BOUND_MS`（30min，非判死权）。
  本批的等待行文案在 F2 落地前后都必须成立——即**不得把任何阈值数字写死进文案模块**。
  ⚠️ 上述引用取自 `docs/plans/2026-08-18-f2-watchdog-arbitration.md`（含 §15 拍板 D1~D6）；
  **F2 rev.2 定稿并行产出中，两者若有出入以 F2 rev.2 为准**，本批施工前须复取一次。
- **D1-c（行高 1.75）与 D1+16（正文 16px）** —— 用户拍的是 D1-b，两者均不落地，不新增 `--leading-*`、不动 D25 字号档位表。
- **D2-c 的容器边界可见化**（行内代码 chip 补边框 / 工具输出块补左导轨）—— 用户拍的是 D2-b。
  但 §4 的解嵌套裁定会**间接触及**同一批类串，届时按 §4.5 处理，不擅自把 D2-c 整包带进来。
- **背景图 / 阅读底票** —— 用户明示「无背景图，阅读底票不立」。`useBackgroundImage` 与 `--panel-bg-opacity` 一字不动；
  本批全部对比度数值按 `--panel-bg-opacity = 1` 计算，并在 §2.6 记录这个前提。
- **F1（单波浪线）、F3（Automatic 重钉）、F7（回退/分叉）、F8、F9** —— 各自独立批次。

### 0.3 F2 移交给本批的三件（继承项，必须处置）

F2 仲裁档 §8.4 / §11 明文移交，本批照单全收：

| 移交项 | F2 仲裁档位置 | 本批处置 |
|---|---|---|
| ① 等待行文案改造（俏皮动词、流量数字、`(up to Ns)` 从句去留） | 仲裁档 §8.4 | §7.1 ~ §7.4 |
| ② `slow` 的 `text-warning` 色阶降级 + 第二档阈值 | 仲裁档 §8.4（建议值 180s） | §7.5 |
| ③ 红卡文案中英混排订正 | 仲裁档 §10.3 / F2 §2 新发现⑤ | §7.6（降级为待拍板） |

**反向约束（F2 钉给本批的两把锁）**：

1. **`[TS-1]` 锁**【实测】：F2 §9 / §12.1 计划在 `turnStatus.test.ts` 新增 `[TS-1]`，断言
   `elapsedSeconds >= SLOW_WAIT_HINT_SECONDS && !hasBlocks` 时 `kind === 'slow'` 且文案**含 `Stop to abort.`**，
   其声明目的就是「防 F4 误删」。⇒ **§7 的文案重写不得移除任何等待档的 `Stop to abort.` 尾句**，
   俏皮动词只作用于 `awaiting`（< 阈值）分支。
2. **kind/copy 同源锁**（rev.1 遗漏，本轮补）【实测】：F2 仲裁档 §8.3 末段明令
   「`kind` 与 copy 必须继续同源（今天已是，两者都键在 `SLOW_WAIT_HINT_SECONDS` 上）——**立成回归断言，防本批顺手拆开**」。
   源注在 `turnStatus.ts:115-117`（关键原文：`` // The threshold is imported, never re-declared: `composerSendingLine` keys ``）。
   ⇒ **§7.5 新增的 `stalled` 档必须自带可辨措辞，且两档阈值由同一常量对同源导入**，
   否则「kind 在 180s 翻、copy 不翻」按构造违反该不变量。这是 rev.1 的实质错误，rev.2 已改（见 §7.5）。

### 0.4 施工顺序与 F2 的关系 —— **有 2 处同区冲突，必须序约束**（rev.2 整节重写）

rev.1 写的「与 F2 无文件级冲突、可并行、规格期不做序约束」**是错的**。
按 F2 仲裁档 **§11.1 切片表**逐份核对，两批共享 **5 份**生产文件、**3 份**测试文件：

| 共享文件 | F2 的改动（仲裁档 §11.1） | 本批的改动 | 冲突级别 |
|---|---|---|---|
| `stores/turnSendStatus.ts` | **S3**：`pendingReply` 第二槽加在 **`TurnSendStatusStore`**（`:116-135`，未导出）与 store 对象（`:143-165`） | **④**：`promptChars` 加在 **`TurnSendStatus`**（`:41-52`） | 🟢 **无冲突（并行安全）** —— rev.2 订正，见下方「⑤ turnSendStatus 复核」 |
| `MessageTimeline.tsx` | **S3**：回合头失表修复、`'pending'` 出路的消费点 | **②** 气泡/容器/行高 · **④** `deriveTurnStatus` 入参与色阶分档 | 🔴 **同区**（`deriveTurnStatus({…})` 调用点 `:1003-1020` 两批都改） |
| `ChatComposer.tsx` | **S2**（读侧 `budgetMs` 换源）+ **S3**（写侧 marker / 清理链） | **③** 两行结构 · **④** `beginTurnSend` 加 `promptChars` | 🔴 **同区**（`beginTurnSend({…})` 实参表 `:1117-1126`） |
| `middleColumnLayout.ts` | **S2**：散文样例 `(up to 45s)` → `300s`（`:608`） | **③** 六个类装配函数改形 | 🟡 同文件不同区（且本批 §7.2 退役该从句后，S2 的这处改动**自动作废**——需知会 F2） |
| `turnStatus.ts` | 仲裁档 §8.3 要求「kind/copy 同源立成回归断言」（断言落 `turnStatus.test.ts`，生产文件不改） | **④**：`TurnStatusKind` 加 `'stalled'`、`TurnStatusInput` 加 `promptChars`、`formatTokenCount` 下沉 | 🟡 生产侧本批独占，**测试侧同文件** |
| `attachments.ts` | 仲裁档 §8.4 声明改动为**零**（只从调用方换入参） | **④**：`composerSendingLine` 重写 + 三个新常量 | 🟢 本批独占 |
| `turnStatus.test.ts` / `attachments.test.ts` | F2 加 `[TS-1]` 与 §12.1 清单 | 本批加 §8.4 清单 | 🟡 按 describe 块分区追加，不重编号 |

**⇒ 序约束（rev.2 新立，强制）**：

```
F2 S0 → S1 ∥ S2 ∥ S5 → S3 ∥ S4        （F2 内部序，仲裁档 §11.1，S5 先于 S3 是红线）
                          │
本批 ① ∥ ② ∥ ③ ────────────┴──> ④ rebase 到「F2 S3 已合入」的结果之上
```

1. **本批片 ④（F4 等待行）必须在 F2 S2/S3 合入后 rebase 落地**——**两处**同区冲突全在 ④
   （`ChatComposer.tsx` 的 `beginTurnSend` 实参表、`MessageTimeline.tsx` 的 `deriveTurnStatus` 调用点）。
   ④ 施工前须复取这两处的实况。**`turnSendStatus.ts` 不再是序约束的依据**（见下方 ⑤）。
2. **本批片 ②（时间线层）与 F2 S3 同文件不同区**：② 可与 S3 并行，但**谁后合谁 rebase**；
   ② 的 owner 须在合入前 `git log --oneline -- src/renderer/components/chat/MessageTimeline.tsx` 复核。
3. **本批片 ③ 与 F2 S2 同文件不同区**：③ 若先落地并退役 `(up to Ns)`，须**同步知会 F2**
   把 S2 的「`middleColumnLayout.ts` 散文样例 45s→300s」一项改为「该样例整体退役」。
4. **`[TS-1]` 的分段化由后落地方执行**（§7.5-b 已写协调口径），先落地方不得因为「测试会红」放弃 `stalled` 或放弃 `[TS-1]`。

**⑤ `turnSendStatus.ts` 双槽复核 —— rev.2 撤回 🔴 判定**（F2 rev.2 §0.5 新发现⑥ / §11.4 反驳，本档实读复核后**采纳**）：

rev.2 初稿把两批对该文件的加法判为「同一 interface 的相邻加法 → 🔴 同区」。**该判定错误**，实读证据【HEAD `d9281d0`，
文件真实路径 `src/renderer/stores/turnSendStatus.ts`，**不在** `components/chat/` 下】：

| 批次 | 落点 | 行号 | 关键原文 |
|---|---|---|---|
| **F456 ④** | `TurnSendStatus`（**已导出**，快照数据形状） | `:41-52` | `export interface TurnSendStatus {`（`:41`）… `attachmentBytes: number;`（`:51`） |
| **F2 S3** | `TurnSendStatusStore`（**未导出**，store 的槽位与动作） | `:116-135` + store 对象 `:143-165` | `interface TurnSendStatusStore {`（`:116`）· `status:`（`:117`）· `baseline:`（`:119`） |

两者相隔 **约 64 行**、**不同 interface**、**不同导出可见性**，git 三方合并不会产生冲突块。
另核三条可能的隐藏耦合，**均不构成同区冲突**：

1. `update` 的签名（`:131`）确实**类型级引用**了 `TurnSendStatus`
   （`patch: Partial<Omit<TurnSendStatus, 'sessionId'>>`）—— 但 `promptChars` 是**加法**，
   `Partial<Omit<…>>` 自动变宽，**无需改这一行**；
2. `begin` 的实现（`:146-157`）用 `{ ...status, owner }` **整体展开**，不逐字段枚举 ⇒ 加字段零改动；
3. 下游两个消费者（`MessageTimeline.tsx:850` / `:1259` 的 `sendStatus: TurnSendStatus`）只引用类型名，不枚举字段。

**唯一保留的黄灯**：`src/renderer/stores/__tests__/turnSendStatus.test.ts` **两批都会加用例**
（F2 加 `pendingReply` 的槽位/清理语义，本批加 `promptChars` 的快照语义）⇒ 🟡 **同文件不同 describe 块**，
按既有纪律**分区追加、不重编号**，与 `turnStatus.test.ts` / `attachments.test.ts` 同一处置。
该测试文件须补进 §8.1(c) 与 §9.2 片④ 的文件表。

⇒ **序约束不因此撤销**：④ rebase 的依据从三条减为两条（`ChatComposer.tsx` 的 `beginTurnSend` 实参表是
**逐字同一个对象字面量**——F2 S2 改其中的 `budgetMs: timeoutMs`，本批加 `promptChars`，这一处无可回避）。

### 0.5 取证核对表 —— 与对比稿 / 分诊档的**八处冲突**

对比稿是设计稿，不是施工图。本轮逐条复核其工程标注，发现八处需要修正或补足。
**这张表是本规格最重要的一节**：不先纠正这八条，施工会按错误前提动工。

| # | 对比稿 / 分诊档的说法 | 实测 | 后果 |
|---|---|---|---|
| **C1** | D3-c「**需撤销 D26 ④**（复议，需重新落决策）」（对比稿 §05 / §03） | 【实测】D26 ④ **早在 2026-08-13 就被 D31 推翻了**：`docs/plans/openchamber-chat-refactor-ledger.md:75` 决策 D31 明文「用户气泡**改回右对齐**（推翻 D26④ 满宽，**append-only 以本条为准**）」，并在 `docs/plantree/plans/openchamber-chat-refactor/implementation-status.md:47` 列为「渲染端小批」待排队项，至今**未施工** | 本批**不是复议，是执行一条已拍板未落地的裁定**。§5 的修订记录写法随之改变：不写「撤销 D26 ④」，写「兑现 D31 冲突项回摆①，D26 ④ 至此在代码侧同步作废」。少一次拍板、少一份决策档 |
| **C2** | D2-b「`--tool-arg` 退役并入 muted-foreground（3.61/3.11 → 7.20/6.70）」；用户拍板原文是「**text-tool-arg 修到过 AA**」 | 【实测】`--tool-arg` 是**派生值**不是独立色：`color-mix(in oklab, var(--muted-foreground) 78%, var(--background))`。本轮按 Oklab 混合 + WCAG 2.x 重算：**保留 78% 派生 + 新 muted-foreground → 亮 `#797874` = 4.34、暗 `#7E7C77` = 4.36**，两个都**仍不过 AA(4.5)** | 「修到过 AA」**不会**随 muted-foreground 提档自动实现。必须对 tool-arg 本身作一次显式裁定（退役 / 抬混合比），见 §2.3。这是本表中唯一会导致「以为改好了其实没过 AA」的坑 |
| **C3** | 任务书转述为「chat **之外** 104 处共享该 token」 | 【实测】104（本轮复核为 106）是**chat 目录内**计数，对比稿脚注原文写明「`src/renderer/components/chat/` 下非测试文件」。全仓真实用量见 §2.4 | 影响面被低估一个数量级。GUI 点验范围必须按 §2.4 的全仓分面重排 |
| **C4** | D3-b「代码块 / 表格自带边框，会出现**嵌套框**」（只给定性，未量化） | 【实测】比嵌套框严重：`CodeInline` 是 `bg-muted`（`ui/ident.tsx:31`），D3-b 容器也是 `bg-muted` → 两者对比度 **1.000（同色，芯片彻底消失）**；代码块 `bg-muted/50`（`chatMarkdownPolicy.ts:509`）合成在 `bg-muted` 底上等于 `bg-muted` 本身 → **1.000**，代码块退化成「只剩一圈边框的空框」；且 `border-border` 对 `muted` 只有 1.308/1.363，比对 `background` 的 1.402/1.441 **更弱** | D3-b 若照对比稿字面实作（`bg-muted + border-border`），会**同时**制造三层框和两处消失。§4 的解嵌套裁定因此不是「优化」，是**必须项** |
| **C5** | 分诊 F6「F4 落地后回合头等待行变富，composer 状态行**或可退役**」 | 【实测】T-31 §3.2 早已把等待文案迁出 composer：`middleColumnLayout.ts:607-619` 明文「`sending` no longer shows this line at all」，`shouldShowStatusLine`（:621-630）只看 `reading > 0 \|\| hasStatusError \|\| hasLargeHint`；session 模式再经 `resolveIdleStatusText`（:524-534）过滤掉全部错误正文 ⇒ 该槽**今天只可能显示两种东西**：附件读盘 spinner、大附件提示 | 该槽与 F4 **信息不同源**（草稿侧附件 I/O vs 回合侧等待），**不能因 F4 变富而退役**。§6.4 改判为「迁位不退役」 |
| **C6** | 对比稿 §05 D3-c 落地点写 `MessageTimeline.tsx:711-722` | 【实测 HEAD `d9281d0`】准确锚点是：D26 ④ 注释 `MessageTimeline.tsx:725-732`、`<article>` `:733`、外层类串 `'space-y-2 rounded-lg border px-4 py-2.5'` `:736`、角色类串 `'rounded-br-xs border-primary/8 bg-card'` `:743`（**rev.2 重取**；rev.1 写的 `:708/:716/:719/:726` 是 `c5cbd19` 前行号） | 施工按 **§0.7-a 锚点总表**，既不按对比稿行号、也不按 rev.1 行号 |
| **C7** | 对比稿 D3-a/D3-c 连带测试写「**若有**类串断言需同步」 | 【实测】**确有且按构造必红**：`__tests__/messageTimelineWiring.test.ts:449-456` 有一条专门的 pin —— `it('D26 ④: the user bubble is full width')`，内容是 `expectUnwired('max-w-[85%]')` + `expectUnwired('justify-end')`。且 `:226` 有一条元断言，明文要求字符串字面量 `rounded-br-xs` 必须存活于负向投影里 | §8 把这条 pin 的**退役换新**列为必改项（不是「同步」，是语义反转：从「禁止」改为「必须」） |
| **C8** | F2 §8.3 建议「slow 保持 muted，另设第二档阈值才转 warning」 | 【实测】问题比色阶疲劳更深：`--warning` 与 `--primary` **逐位同色**（`globals.css:176-177` 亮 `oklch(0.5665 0.1523 45.02)` = primary 亮值；`:223-224` 暗 `oklch(0.6576 0.1539 49.3)` = primary 暗值），`design-system.md` 自己就有「不要用 warning 代替 amber——与品牌橙撞」的警告 ⇒ 今天的 slow 态涂的其实是**品牌橙**，与链接色同色 | §7.5 的处置不能只是「延后变黄」，要连「变的是哪个颜色」一起裁 |

**核对通过（无冲突，记录以免复查）**：
① 对比稿列的 F-C4 断言行号 `:590`（`leading-normal` 钉）/ `:635`/`:638`（标题 20/10）/ `:643-656`（块级 mt ∈ {10,20}）—— 逐条实测吻合；
② `BLOCK_GAP = 'mt-2.5 first:mt-0'` / `SECTION_GAP = 'mt-5 first:mt-0'` 在 `chatMarkdownPolicy.ts:399-400`，两档节拍注记在 `:391-398` —— 吻合；
③ D2-b 两个提案色的对比度：本轮独立重算 **亮 `#575653` = 7.20、暗 `#9F9D96` = 6.70** —— 与对比稿逐位一致；
④ `bg-accent` 对 `background` = **1.161（亮）/ 1.292（暗）**、`text-foreground` on `bg-accent` = **16.17 / 8.81**、`border-input` 对 `bg-accent` = 1.350 / 1.322 —— 与对比稿一致，D3-c 的色学前提成立。

### 0.6 计算口径（供复核）

本档全部色值由 `globals.css` 的 OKLCH 字面量按标准矩阵转 sRGB、按 WCAG 2.x 相对亮度求比。
**两种混合必须用两套口径算，rev.1 混用了（A 轨 M-4）**：

| 形态 | 口径 | 用在哪 |
|---|---|---|
| `color-mix(in oklab, X N%, Y)` | **Oklab 线性插值**后转回 sRGB（与 Chromium 实绘一致） | `--tool-arg` 派生（§2.1 / §2.3） |
| `bg-*/NN` · `border-*/NN` 等 **alpha** | **sRGB（gamma 编码）空间的简单 alpha 合成** `out = fg·a + bg·(1−a)`——CSS 的 `rgb(… / a)` 就是这么合成的，**不走 Oklab** | §2.4-b 滚动条、§3.4 芯片底、§4.1 代码块底 |

rev.1 的 §2.4-b 把 alpha 当 Oklab 混合算，数值偏低 0.02~0.16；rev.2 已全部重算（**裁定方向不变**，见 §2.4-b）。

现值交叉验证：亮 `--muted-foreground` = `#686663` = 5.6165、暗 `#807E79` = 4.4849、派生 tool-arg 亮 `#878581` = 3.61 / 暗 `#676561` = 3.11
—— 与对比稿 §00-B 与 `design-system.md` 已记录值全部吻合，故计算链可信。
B 轨独立复算亦逐位吻合（新值 7.2019 / 6.7012、85% 派生 5.0893 / 5.0162）。

**用量扫描的可复算命令**（HEAD `d9281d0`，结果见 §2.4-c）：

```
rg -o --glob '!**/__tests__/**' --glob '!**/*.test.*' 'text-muted-foreground(?:/[0-9]+)?' src | wc -l   # 845
rg -l --glob '!**/__tests__/**' --glob '!**/*.test.*' 'text-muted-foreground(?:/[0-9]+)?' src | wc -l   # 154
rg -o --glob '!**/__tests__/**' --glob '!**/*.test.*' 'text-muted-foreground(?:/[0-9]+)?' src/renderer/components/chat | wc -l   # 106
rg -o --glob '!**/__tests__/**' --glob '!**/*.test.*' 'text-muted-foreground/[0-9]+' src | wc -l        # 36
```

⚠️ **「色学已复算成立」与「用量扫描已更新」是两种证据，不得互相背书**（B 轨 m-1）：
rev.1 的色值链正确但 inventory 错（844/156），rev.2 分开记录。

### 0.7 锚点总表（rev.2 新增 —— 全部按 HEAD `d9281d0` 重取）

**为什么要有这张表**：rev.1 的时间线锚点停在 `c5cbd19` 之前，`MessageTimeline.tsx` 整体位移 **+15~17 行**、
`chatTimelineLayout.ts` **+15 行**，两轨评审各自独立命中（A 轨 B-1 / B 轨第 2 条）。
其中最危险的一处是 **`:1209`**：rev.1 把它当 `answer` 段挂点，而它在 HEAD 上已经是 **process 面板**——
照 rev.1 施工等于**亲手落成 M-15 变异**（§8.4）。

**锚点纪律（本档此后一律照此写）**：

- **高漂移文件**（`MessageTimeline.tsx` / `ChatComposer.tsx` / `middleColumnLayout.ts`）一律用
  **三元锚 =「符号名 + 行号 + 关键原文片段」**，行号只是索引，**关键原文才是判据**；
  施工时若行号对不上，以符号名 + 原文重新定位，**不得按行号盲改**。
- **低漂移纯模块**（`chatMarkdownPolicy.ts` / `chatTimelineLayout.ts` / `globals.css` / 各测试）保留裸行号，
  但仍附关键原文以便自证。
- 本表是**唯一权威**：正文各节与本表冲突时以本表为准；施工前须跑一次
  `git log --oneline -1` 确认仍是 `d9281d0`，若已前移则**逐条复取**再动工。

#### 0.7-a `src/renderer/components/chat/MessageTimeline.tsx`（高漂移，三元锚）

| 符号 / 位置 | 行号 | 关键原文（判据） | 用于 |
|---|---|---|---|
| `UserBubble` 头注（A07 引用） | `:699-711` | `` * The bubble's own shape (A07 `:849-855` — 16/16/4/16 corners, `--card` fill, `` | §5.4 ①（`--card` 叙事在 D3-c 后变假，须重写） |
| `function UserBubble` | `:712` | `function UserBubble({ message }: { message: ChatMessage }) {` | §3.2 定位起点 |
| clamp 前的陈旧注释 | `:718` | `// state, which is what makes the pinned three-line clamp safe.` | **F10 后已是六行 clamp**，§3.4 ④ 要求顺手订正为 six-line |
| **D26 ④ 注释块** | `:725-732` | `// D26 ④: the bubble spans the reading column. The old 85% width cap and` | §3.5 整段重写（rev.1 写 `:708-715`） |
| 气泡 `<article>` | `:733` | `<article>`（无 className） | §3.2 加 `flex justify-end`（rev.1 写 `:716`） |
| 尺寸/形状类串 | `:736` | `'space-y-2 rounded-lg border px-4 py-2.5',` | §3.2 加 `max-w-[85%] min-w-0`（rev.1 写 `:719`） |
| T-30 P-09 内注 | `:737-742` | `// T-30 P-09: A07 `.fx-user-bubble` (`:849-855`) — 16/16/4/16 corners` | §5.4 ②（「assistant 需要 bg-accent」一句语义反转，须重写） |
| 角色类串 | `:743` | `'rounded-br-xs border-primary/8 bg-card'` | §3.2 换 `border-input bg-accent`（rev.1 写 `:726`） |
| 气泡 `title` | `:745` | `title={fullText \|\| undefined}` | §3.4 ④ 的可达性前提（clamp 之外的全文出口） |
| 附件芯片类串 | `:757` | `className="inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-xs border border-border bg-muted/50 px-1.5 text-meta text-foreground"` | §3.4 ③ 换 `border-input`（rev.1 写 `:740`） |
| clamp 容器（**F10 产物**） | `:778` | `<div className={userBubbleTextClass()}>` | §3.4 ④ 新增裁定（rev.1 完全无感知） |
| 用户气泡正文 `<p>` | `:782` | `className="whitespace-pre-wrap text-markdown leading-normal text-foreground"` | §1.3 换 `leading-relaxed` + §3.2 补 `break-words`（rev.1 写 `:765`） |
| `deriveTurnStatus` 调用①（attached） | `:1003-1020` | `const status = deriveTurnStatus({` … `outputTokensDisplay,`（`:1012`） | §7.4 加 `promptChars`（rev.1 写 `:986-1013`）；🔴 与 F2 S3 同区 |
| sticky band 挂点 | `:1168` | `<div className={turnBubbleBandClass()}>` | §3.4 ② / §8.2 `[D3-6′]` 的 DOM 事实基准 |
| 回合体 `turnBodyClass()` | `:1172` | `<div className={turnBodyClass()}>` | 同上；answer 容器是它的**后代**，band 是它的**前序兄弟** |
| **process 面板**（不是 answer！） | `:1209` | `className={cn(turnProcessPanelClass(), turnBodyClass())}` | ⚠️ rev.1 误把此处当 answer 挂点 |
| **answer 段真实挂点** | `:1224` | `{answer.length > 0 && <div className={turnBodyClass()}>{answer.map(renderItem)}</div>}` | §4.3 容器挂载（rev.1 写 `:1209`） |
| `DEFAULT_REPLY_BUDGET_MS` | `:1236` | `const DEFAULT_REPLY_BUDGET_MS = sendTimeoutMs(0);` | §7.2 `budgetMs` 退化后此常量仍被传入，不删 |
| `function PendingTurnHead` | `:1255` | `function PendingTurnHead({` | §7.4 **第二消费者**（rev.1 漏，B 轨第 7 条） |
| `deriveTurnStatus` 调用②（pending） | `:1262-1271` | `const status = deriveTurnStatus({` … `hasBlocks: false,` | §7.4 必须同样传 `promptChars` |
| tone 消费点 | `:1380` | `<span className={cn('min-w-0 truncate', turnStatusToneClass(status.kind))} title={text}>` | §7.5 |
| `turnStatusToneClass` 文档注 | `:1387` | `/** Warning past the slow-wait threshold, destructive on failure; muted otherwise (from `turnHeadClass`). */` | §7.5 须同步重写（否则注释变假话） |
| `turnStatusToneClass` 函数体 | `:1388-1392` | `if (kind === 'slow') return 'text-warning';`（`:1389`） | §7.5 分档（rev.1 写 `:1372-1377`；F2 仲裁档 §8.4 已订正为 `:1389`） |
| 流式期纯文本兜底 | `:1464` | `<p className="text-markdown leading-normal text-foreground whitespace-pre-wrap select-text">` | §1.3 换 `leading-relaxed`（rev.1 写 `:1449`） |
| 红卡中文串 | `:557` | `已产内容保留。可从下方输入框重发上条消息。` | §7.6（rev.1 写 `:540` / `:556-558`） |
| `AUTH_REQUIRED_ERROR_VIEW` 消费点 | `:528` / `:537` / `:822` / `:835` | `{AUTH_REQUIRED_ERROR_VIEW.message}` | §7.6 的「有意中文」证据（D47 S5 §3） |

#### 0.7-b `src/renderer/components/chat/chatTimelineLayout.ts`（+15 行位移）

| 符号 | 行号 | 关键原文 | 用于 |
|---|---|---|---|
| 文件头 F-B8 / F-B10 禁令 | `:6-15` | `` *  - the pinned bubble band and its containing block must never acquire `` | §8.2 `[D3-6′]` 的**范围界定**：禁令的对象是 band 与其 containing block，**answer 容器不在其内** |
| 间距算术头注 | `:17-32` | `* band py-2.5                = 10   top: completes the 20px turn-to-turn beat` | §1.5（a）被否决的依据 |
| `readingColumnSpacingClass()` | `:39-41` | `return 'space-y-2.5';` | §1.5 |
| `chatTurnClass()` | `:52-54` | `return 'flex flex-col';` | sticky containing block（真正承重的那个） |
| `turnBubbleBandClass()` | `:63-65` | `return 'sticky top-0 z-10 bg-background py-2.5';` | §3.4 ②（rev.1 写 `:63-65`，**未漂移**） |
| **`userBubbleTextClass()`（F10）** | `:84-86` | `return 'select-text space-y-2 line-clamp-6';` | §3.4 ④ / §8.5 G-3 —— **rev.1 完全无感知，A 轨 M-1** |
| `userBubbleTextClass()` 头注 | `:67-83` | `* spec's own pre-authorised fallback; adopted as-built by F10, 2026-08-18` | 同上；末句 `a user-owned expand toggle is F456-batch work` **点名本批** |
| `turnBodyClass()` | `:94-101` | `return 'flex flex-col gap-2.5 text-markdown leading-normal';`（`:100`） | §1.3 **不换**（rev.1 写 `:79`，实际函数在 `:94`、return 在 `:100`） |
| `turnBodyClass()` 内注 | `:95-99` | `` // `text-markdown leading-normal` comes from that same article and is not `` | §1.3 ❌不换 的理由原文 |
| `turnProcessShellClass()` | `:143-145` | `return 'flex flex-col gap-2.5';` | §4.3「过程段已有折叠壳」的证据 |
| `turnHeadClass()` | `:153-155` | `return 'flex min-w-0 items-center gap-1.5 text-meta tabular-nums text-muted-foreground';` | §7.5 ①（slow 降 muted 后落在这个 `text-muted-foreground`） |
| `turnFooterClass()` | `:158-160` | `return 'flex flex-wrap items-center justify-end gap-2 …';` | §8.2 `[D3-1]` 保留的那条 |
| **新增落点** `turnAnswerContainerClass()` | 追加在 `:169` 之后 | —— | §4.3 |

#### 0.7-c `src/renderer/components/chat/chatMarkdownPolicy.ts`（**未漂移**，两轨复核一致）

| 位置 | 行号 | 关键原文 | 用于 |
|---|---|---|---|
| 两档节拍注记 | `:391-398` | 「两档 = 回合骨架自有的两档，不发明第三档」 | §1.5 整段重写 |
| `BLOCK_GAP` | `:399` | `const BLOCK_GAP = 'mt-2.5 first:mt-0';` | §1.2 ① → `mt-3.5` |
| `SECTION_GAP` | `:400` | `const SECTION_GAP = 'mt-5 first:mt-0';` | §1.2 ② → `mt-6` |
| `chatMarkdownRootClass()` | `:425-426` | `return 'min-w-0 select-text break-words text-markdown leading-normal text-foreground';` | §1.2 ③ → `leading-relaxed` |
| 嵌套列表注 | `:451-461` | `` * `[&_ul]:mt-1` / `[&_ol]:mt-1` re-tighten NESTED lists ``（`:454`） | §1.4 ① |
| 列表项距 | `:473` | `'ml-5 list-outside space-y-1',` | §1.2 ④ → `space-y-1.5` |
| 嵌套列表再收紧 | `:475` | `'[&_ul]:mt-1 [&_ol]:mt-1',` | §1.2 ⑤ → `mt-1.5` |
| 代码块 | `:509` | `` return `${BLOCK_GAP} overflow-x-auto rounded-sm border border-border bg-muted/50 p-2.5 text-code leading-snug`; `` | §1.2 ⑥ → `p-3 … leading-normal` |
| 表格单元格 | `:523` / `:524` | `? 'border border-border bg-muted/50 px-2.5 py-1 text-left font-semibold'` / `: 'border border-border px-2.5 py-1';` | §1.2 ⑦ → `py-1.5` |


#### 0.7-d `src/renderer/components/chat/ChatComposer.tsx`（高漂移，三元锚）

| 符号 / 位置 | 行号 | 关键原文（判据） | 用于 |
|---|---|---|---|
| 提交点快照 | `:1038` | `const committed = { text: trimmed, drafts };` | §7.4 `promptChars` 的**取值来源**（`[...committed.text].length`） |
| 「取 committed 而非实时值」原注 | `:1090-1097` | `// and bytes are taken from `committed`-to-be `drafts`, NOT from the live` | §7.4 逐字同理由（rev.1 写 `:1091-1096`） |
| `beginTurnSend` 实参表 | `:1117-1126` | `const sendOwner = beginTurnSend(`（`:1117`）… `attachmentBytes: totalAttachmentBytes(drafts),`（`:1123`） | §7.4 写入点（rev.1 写 `:1117-1127`）；🔴 与 F2 S2/S3 同区 |
| `renderStatusLine` 定义 | `:2123` | `const renderStatusLine = (wrapperClassName: string) =>` | §6.4 迁位对象 |
| `hasComposerExtras` | `:2229` | `const hasComposerExtras = Boolean(` | §6.4 连带裁定 / §6.7 `opts` 退役后仍保留 |
| 卡片挂点（`opts` 唯一调用点） | `:2524` | `<div className={composerCardClass(mode, { hasExtras: hasComposerExtras })}>` | §6.7（Q7 已实测：**全仓仅此一处**） |
| `@` 提及弹层 | `:2530` | `mentionPopupPlacementClass(mode)` | §6.6 「—」行 |
| session 分支入口 | `:2604` | `{mode === 'session' ? (` | §8.3 `[F6-4]` 的 AST 定位起点 |
| **`composerRowsClass()` 挂点** | `:2605` | `<div className="flex min-w-0 flex-1 flex-col">` | §6.3 新增函数的落点（rev.1 未指定，A 轨 m-10） |
| extras 堆栈 | `:2606-2613` | `{hasComposerExtras && (` / `<div className="mb-1 flex flex-col gap-1">` | §6.4 状态行迁入处 |
| D48 S1 阅读序注 | `:2614-2621` | `{/* D48 S1 §3.2: the agent chip sits immediately left of the` | §6.3 拆两行后须重写（现注述的是**单行**阅读序） |
| session 单行七件套 | `:2622-2630` | `<div className={composerBarClass('session')}>`（`:2622`）… `{actionButtons}`（`:2629`） | §6.1 / §6.3 |
| empty 分支 | `:2631-2656` | `) : (` / `<>` | §6.5 **零改动** |
| T-30b2 阅读序注 | `:2639-2646` | `{/* T-30b2 §5.2: the bottom bar reads left-to-right as ⊕ → model →` | §6.5 逐字保留 |
| empty 底部条 | `:2647` | `<div className={composerBarClass('empty')}>` | §6.5 不动 |
| empty 状态行（内联类串） | `:2652` | `{renderStatusLine('flex min-w-0 flex-1 items-center gap-1.5')}` | §6.5 **留在底部条** |
| empty action group | `:2653` | `<div className={composerActionGroupClass()}>{actionButtons}</div>` | §8.3 `[F6-5]` 的**假阳性来源**（session 漏接也会绿，故必须 AST 分支定位） |

#### 0.7-e `src/renderer/components/chat/middleColumnLayout.ts`（中漂移，三元锚）

| 符号 | 行号 | 关键原文 | 用于 |
|---|---|---|---|
| pill / runaway 论证注 | `:137-149` | `* into the 33-37px arcs §5.3 names as the "runaway" shape` | §6.7（A 轨 M-5：这段说的是 **`rounded-full` 被 clamp**，不是固定值） |
| `composerCardClass()` | `:150` | `export function composerCardClass(mode: MiddleColumnMode, opts?: { hasExtras?: boolean }): string {` | §6.7（rev.1 引 `:435-464` 一带的旧号） |
| radius 三元 | `:173` | `const radius = opts?.hasExtras ? 'rounded-md' : 'rounded-[21px]';` | §6.7 `opts` 退役 |
| session 卡类串 | `:174` | `` return `relative ${radius} border border-border bg-card focus-within:border-input flex min-h-10.5 items-center gap-2 p-2`; `` | §6.7（`min-h-10.5` / `items-center` 两处都改） |
| `composerFollowHeightBreakdown()` | `:185-195` | `const border = 2; // 1px top + 1px bottom` | §6.7 加 `rows` / `rowGap` |
| round-5 `items-start` 裁定注 | `:205-221` | `` * Round-5 fix (diag:placeholder-align): `session` mode uses `items-start`, `` | §6.3 行 2 回到 `items-center` 的理由须改写 |
| `composerBarClass()` | `:223-228` | `return 'flex min-w-0 items-start gap-2';`（session 分支） | §6.3 |
| `composerActionGroupClass()` | `:241-243` | `return 'ms-auto flex shrink-0 items-center gap-1.5';` | §6.3 两模式共用 |
| `composerTextareaClass()` | `:418` | `export function composerTextareaClass(mode: MiddleColumnMode): string {` | §6.3（rev.1 写 `:435-464`） |
| session textarea 返回串 | `:464` | `return 'min-w-32 flex-[2] p-0 [&_textarea]:min-h-6 [&_textarea]:max-h-14 …';` | §6.3 撤 `min-w-32` / `flex-[2]` |
| 状态槽补丁注（42 行） | `:466-505` | `* Round-4 point-check fix (defect B, `shouldShowStatusLine`'s sibling in the` | §6.4 整套补丁退役的理由原文 |
| `sessionStatusLineWrapperClass()` | `:506-508` | `return 'flex h-6 min-w-0 flex-1 shrink basis-0 max-w-48 items-center gap-1.5';`（`:507`） | §6.3 / §6.4（rev.1 写 `:467-508`） |
| `resolveIdleStatusText()` | `:524` | `export function resolveIdleStatusText(input: {` | §6.4 依据链③（**本批不动**） |
| F-B11 `sending` 注 | `:607-620` | `` * T-31 §3.2 (F-B11): `sending` no longer shows this line at all. ``（`:607`） | §6.4 依据链①（rev.1 写 `:607-619`） |
| **F2 S2 的改动点** | `:608` | `` * copy it used to gate ("Waiting for Agent Host reply · 12s (up to 45s)") `` | §0.4 🟡：F2 S2 要把这句 `45s` 改 `300s`；本批 §7.2 退役该从句后**该改动自动作废** |
| `shouldShowStatusLine()` | `:621-630` | `return input.reading > 0 \|\| input.hasStatusError \|\| input.hasLargeHint;` | §6.4 依据链② |
| `mentionPopupPlacementClass()` | `:634-640` | `return 'bottom-full mb-1';` | §6.6 「—」行 |
| `composerPopupSide()` | `:651-653` | `return mode === 'empty' ? 'bottom' : 'top';` | §6.6 ①② |

#### 0.7-f 其余生产文件（低漂移）

| 文件 | 行号 | 关键原文 | 用于 |
|---|---|---|---|
| `styles/globals.css` | `:17` | `--color-muted-foreground: var(--muted-foreground);` | §2.1（`@theme` 桥接，不动） |
| 同上 | `:37` | `--color-tool-arg: var(--tool-arg);` | §2.1（不动） |
| 同上 | `:154` / `:206` | `--primary: oklch(0.5665 0.1523 45.02);` / `--primary: oklch(0.6576 0.1539 49.3);` | §0.5 C8 的「逐位同色」证据 |
| 同上 | `:159` | `--muted-foreground: oklch(0.5111 0.0053 78.28);` | §2.1 亮值换档 |
| 同上 | `:176` / `:223` | `--warning: oklch(0.5665 0.1523 45.02);` / `--warning: oklch(0.6576 0.1539 49.3);` | §7.5 ③ 知情偏离的证据 |
| 同上 | `:190-194` | `` * .dark's --muted-foreground/--background overrides are picked up `` | §8.2 `[D2-1]④`（「声明一次」设计意图） |
| 同上 | `:195` | `--tool-arg: color-mix(in oklab, var(--muted-foreground) 78%, var(--background));` | §2.1 / §2.3 混合比 78→85 |
| 同上 | `:211` | `--muted-foreground: oklch(0.5933 0.0079 88.68);` | §2.1 暗值换档 |
| 同上 | `:343` / `:347` | `@apply bg-muted-foreground/20 rounded-full;` / `@apply bg-muted-foreground/40;` | §2.4-b（第③类，sRGB 合成重算） |
| `turnStatus.ts` | `:1` | `import { composerSendingLine, type SendPhase, SLOW_WAIT_HINT_SECONDS } from './attachments';` | §7.4 循环依赖论证的前提 |
| 同上 | `:22` | `export type TurnStatusKind =` | §7.5 加 `'stalled'` |
| 同上 | `:44` | `export interface TurnStatusInput {` | §7.4 加 `promptChars` |
| 同上 | `:87` | `export function deriveTurnStatus(input: TurnStatusInput): TurnStatus \| null {` | §7.5-a；🔴 与 F2 同区 |
| 同上 | `:102` | `if (input.hasBlocks) {` | §7.5-a 自证③（streaming 优先级更高） |
| 同上 | **`:115-117`** | `` // The threshold is imported, never re-declared: `composerSendingLine` keys `` | §7.5-a **必须整段重写**（单数「the threshold」在两档后成假话） |
| 同上 | `:118` | `if (elapsed >= SLOW_WAIT_HINT_SECONDS) return { kind: 'slow', text };` | §7.5-a 新分支插在其**上方** |
| 同上 | `:152` | `export function formatTokenCount(count: number): string {` | §7.4 下沉 `countFormat.ts` + re-export |
| 同上 | `:144-151` | `* it must only ever be shown as a rough, in-flight indicator — never` | §7.4「单位词不对称」的理由原文 |
| `attachments.ts` | `:296-297` | `/** Seconds after which the status line turns warning and changes wording. */` / `export const SLOW_WAIT_HINT_SECONDS = 45;` | §7.5-a `STALLED_HINT_SECONDS` 同处定义；**该 doc 注也须重写**（「turns warning」在 §7.5 ① 后成假话） |
| 同上 | `:309-312` | `* Status line shown while a send is in flight. Deliberately never predicts a` | §7.2 理由 2 |
| 同上 | `:321` | `export function composerSendingLine(input: {` | §7.1~§7.5 |
| 同上 | `:340` | `const budgetSeconds = Math.round(input.budgetMs / 1000);` | §7.2：**此局部变量须删**（从句退役后成死变量，lint 必红） |
| 同上 | `:352` | `` return `Still waiting · ${elapsed}s${retrySuffix} — gateway latency varies. Stop to abort.`; `` | §7.5-a **逐字不动** |
| `stores/turnSendStatus.ts` | `:41-52` | `export interface TurnSendStatus {` … `attachmentBytes: number;`（`:51`） | §7.4 加 `promptChars`；🟢 与 F2 S3 的 `pendingReply` 槽（`TurnSendStatusStore` `:116-135` / store 对象 `:143-165`）**不同 interface、隔 64 行，无冲突**（§0.4 ⑤） |
| `ComposerAgentPicker.tsx` | `:224` | `<span className="flex min-w-0 shrink-0 items-center gap-1">` | §6.6 ③ 改 `min-w-0 shrink` |
| 同上 | `:225` / `:249` | `role="radiogroup"` / `role="radio"` | §6.6 ③（**两枚** radio：`AGENT_DISPLAY_NAMES` 只有 `claude-code` / `codex`，见 `shared/types/agentWire.ts:48-51`） |
| 同上 | `:258-272` | `{model.emptyStateNotice && (` … `Retry Host` | §6.6 ③ 挤压风险源 |
| 同上 | `:207-219` | `if (model.locked) { … role="radiogroup" … role="radio" … }` | §6.6 ③ 的**第二个 radiogroup**（locked 分支，单枚永选中），改 `shrink` 时**不涉及**它 |
| `ToolRows.tsx` | `:76` | `'group/row flex w-full items-baseline gap-1.5 text-left text-markdown leading-normal',` | §1.3 ❌不换 |
| 同上 | `:112` / `:304` | `text-tool-arg`（箭头 / 参数块） | §2.3 保留 |
| 同上 | `:230` `:233` `:262` `:285` `:304` | `leading-[1.55]` | §1.4 ③ 既存违规，**本批不修** |
| `toolCard.ts` | `:803` / `:823` | `: 'text-tool-arg'` | §2.3 候选 B 清单（仅历史存档） |
| `lib/utils.ts` | `:19` | `` * coincidence. `text-tool-arg` is a colour token (not a size), so it is `` | 同上 |
| `QuestionCard.tsx` | `:254` / `:371` / `:536` | `text-markdown leading-normal` | §1.3 ❌不换（A 轨 M-8 补出的三处） |
| `EnhancedInput.tsx` | `:826` | `text-sm leading-normal` | §1.3 ❌不换（同上，第四处） |

#### 0.7-g 测试文件

| 文件 | 行号 | 关键原文 | 用于 |
|---|---|---|---|
| `__tests__/chatMarkdownPolicy.test.ts` | `:503` | `function marginTopPx(classes: string): number {` | §1.6（正则接受小数，**辅助函数无需改**） |
| 同上 | `:587` / `:590` | `expect(cls).toContain('leading-normal');`（`:590`） | §1.6 改值 + 补负向 |
| 同上 | `:633-640` | `expect(marginTopPx(chatMarkdownHeadingClass(level)), `h${level}`).toBe(20);`（`:635`） | §1.6 改值 20/10 → 24/14 |
| 同上 | `:643-648` | `describe('F-C4: block rhythm reuses the turn layout’s two tiers, inventing none'` | §1.6 改值 + 改名 |
| 同上 | `:650-657` | `it('F-C4: the 10px tier is literally the turn body gap'`（`:652`） | §1.6 **退役换新** |
| 同上 | `:779-781` | `expect(marginTopPx(footnotes)).toBe(20);`（`:781`） | §1.6 改值 → 24 |
| 同上 | `:550-585` | `describe('F-C4: the markdown root cannot break the pinned bubble (sticky chain)'` | §8.2 `[D3-6′]`：注意该 describe 对「root 在 sticky 链上」的表述与 `:1224` 的 DOM 事实**同样宽泛**，本批不改它，但**不得据它复制那套因果**到 answer 容器 |
| `__tests__/chatMarkdownRender.test.ts` | **`:300`** | `expect(root).toContain('leading-normal');` | §1.6 **必红**（rev.1 完全漏列，B 轨第 3 条） |
| `__tests__/messageTimelineWiring.test.ts` | `:181` / `:189` / `:196` | `function expectCalled(token: string): void {` / `expectWired` / `expectUnwired` | §8.2：三者**均无范围参数**，故 D3 组必须改 AST 定位（A 轨 m-8 / B 轨第 5 条） |
| 同上 | `:226` | `'rounded-br-xs'`（元断言的字面量） | §8.2 **不改**，元断言继续成立 |
| 同上 | `:407` | `'className="text-markdown leading-normal text-foreground whitespace-pre-wrap select-text"'` | §1.6 改值（rev.1 写 `:404-406`） |
| 同上 | `:433-435` | `(SYNTAX.match(/whitespace-pre-wrap text-markdown/g) ?? []).length` / `.toBe(2)` | §1.6 **不改**（换 leading 后子串仍相邻） |
| 同上 | `:449-456` | `it('D26 ④: the user bubble is full width', () => {` | §8.2 **退役换新**（rev.1 写 `:443-451`） |
| `__tests__/middleColumnLayout.test.ts` | `:243-260` | `it('F-A2: rests the follow-up card at exactly 42px, …'` | §8.3 改值 42→74 |
| 同上 | **`:255`** | `expect(cls).toContain('items-center');` | §8.3 **必红**（§6.7 去掉卡片 `items-center`；rev.1 漏列，A 轨 M-6） |
| 同上 | `:290-307` | `it('F-A21: the resting follow-up card carries the fixed half-height radius, …'`（`:290`）/ `:301` | §8.3 **退役换新** |
| 同上 | `:308-331` | `it('F-A2b: extras present drop the follow-up card back to the 12px radius'`（`:308`）/ `:320` / `:326` | §8.3 退役换新 + 保留「从不用 rounded-lg」 |
| 同上 | `:332-368` | `:340` session gap / `:353` `items-start` / `:362` empty action group | §8.3 改值 |
| 同上 | `:369-438` | `:416` 128px 地板 / `:422` empty 不受影响 / `:432` `flex-[2]` 主导 | §8.3 `:416` `:432` 双双退役 |
| 同上 | `:439-486` | `:440` `basis-0` / `:445` shrink+min-w-0 / `:461` 非零 grow / `:466` `max-w-48` / `:480` `h-6` | §8.3 **整组退役** |
| 同上 | `:487-527` | `describe('resolveIdleStatusText (F5a, round-4 Codex NEEDS-FIX #4)'` | §8.3 **全部保留** |
| `__tests__/composerFormStatic.test.ts` | `:34-51` | `function readStripped(file: string): string {` / `function collectFiles(dir: string): string[] {` | §8.3：现工法**只有目录遍历 + 去注释 + 正则名称扫描，无 JSX AST / 分支 / sibling 模型** ⇒ `[F6-4]` 按 rev.1 写法**不可实现**（A 轨 M-7 / B 轨第 6 条） |
| 同上 | `:53-86` | `describe('F-A20: composer form static scan'` | §8.3 新断言的落点（须先扩工法） |
| `__tests__/attachments.test.ts` | `:324` | `describe('composerSendingLine (T-18 B2)', () => {` | §7.7（11 条用例） |
| 同上 | 11 条 `it` 的**当前**行号 | `:325` `:337` `:349` `:361` `:372` `:387` `:401` `:414` `:427` `:439` `:460` | §7.7 表按此重编（rev.1 的起止号有 1~4 行漂移） |
| 同上 | `:349-359` | `it('switches wording past the slow threshold and never predicts a finish time'` | §7.7 **逐字保留**（F2 仲裁档 §8.1 点名：这条是 slow 分支可达的证据，**不得当陈旧钉住退役**） |
| `__tests__/toolRowArg.test.ts` | `:48` | `expect(failedIdent).not.toContain('text-tool-arg');` | §2.3 候选 B 清单（仅历史存档） |
| `lib/__tests__/utils.test.ts` | `:30-31` | `expect(cn('text-muted-foreground', 'text-tool-arg')).toBe('text-tool-arg');` | 同上（**候选 B 一旦启用即必红**） |
| **新建** `styles/__tests__/tokenValues.test.ts` | —— | —— | §8.2 `[D2-1]` |


---

## §1 F5-D1-b 排版密度换档（散文层）

### 1.1 目标值（用户已拍板，不再讨论）

正文行高 **1.625**（`leading-relaxed`，Tailwind 内置档，零新增 token）、段距 **14px**、标题上距 **24px**、
列表项距 **6px**、代码块行高 **1.5** / 内距 **12px**、表格单元格 py **6px**。回合骨架（10 / 20px）**不动**。

### 1.2 改动点（全部在 `chatMarkdownPolicy.ts`）

| # | 位置 | 现值 | 新值 | 备注 |
|---|---|---|---|---|
| 1 | `:399` `BLOCK_GAP` | `mt-2.5 first:mt-0`（10px） | `mt-3.5 first:mt-0`（14px） | 3.5 × 4 = 14，整档非任意值 |
| 2 | `:400` `SECTION_GAP` | `mt-5 first:mt-0`（20px） | `mt-6 first:mt-0`（24px） | 6 × 4 = 24 |
| 3 | `:426` 根类 | `leading-normal` | `leading-relaxed` | 1.5 → 1.625 |
| 4 | `:473` 列表 | `space-y-1`（4px） | `space-y-1.5`（6px） | |
| 5 | `:475` 嵌套列表再收紧 | `[&_ul]:mt-1 [&_ol]:mt-1`（4px） | `[&_ul]:mt-1.5 [&_ol]:mt-1.5`（6px） | 见 §1.4 裁定① |
| 6 | `:509` 代码块 | `p-2.5 … leading-snug` | `p-3 … leading-normal` | 1.375 → 1.5、10 → 12px；`text-code` 不动 |
| 7 | `:523/:524` 表格单元格 | `px-2.5 py-1` | `px-2.5 py-1.5` | 横向内距不动（4px 表格里横向已够） |
| 8 | `:391-398` 两档节拍注记 | 「两档 = 回合骨架自有的两档，不发明第三档，这是 F-C4 钉的」 | **整段重写**，见 §1.5 | 不重写它，注释就变成假话 |

**不改**：`:493` 链接（无节拍）、`:528` 引用块 `pl-2.5`（横向导轨偏移，非纵向密度）、`:532` `hr`、
`:560` 脚注（继承 `SECTION_GAP`，自动跟随）、`:573` 图片占位芯片。

### 1.3 三个散文渲染点必须同步换档（本节最容易漏的一条）

【实测 HEAD `d9281d0`】`leading-normal` 在 chat 目录**非测试文件**里有 **9 个**语义不同的落点
（rev.1 只列了 5 个，A 轨 M-8 补出 4 个），D1-b 只该动其中 **3 个**：

```
rg -n --glob '!**/__tests__/**' 'leading-normal' src/renderer/components/chat   # 9 hits
```


| 落点 | 是否换 `leading-relaxed` | 理由 |
|---|---|---|
| `chatMarkdownPolicy.ts:426` 散文根 | ✅ **换** | 主目标 |
| `MessageTimeline.tsx:1464` 流式期纯文本兜底 | ✅ **换** | **不换就是缺陷**：F-C3 的流式门在 `message.completed` 时把同一段文本从纯文本切成 markdown，若两侧行高不同，这次切换会**额外多出一次整段重排**——F-C3 注释（`chatMarkdownPolicy.ts:317-325`）声明「一次重排是代价，闪烁不是」，漏改会亲手制造第二次 |
| `MessageTimeline.tsx:782` 用户气泡正文 | ✅ **换** | 用户抱怨的「太密集」不区分谁说的话；且 §3 会给气泡换底色，行高不同会让两侧字块节奏可见地不一致 |
| `chatTimelineLayout.ts:94-101` `turnBodyClass()` | ❌ **不换** | 它是**回合骨架的继承基线**，`turnBodyClass()` 注释（`:95-99`）明说它承载的是 `QuestionCard` 头行这类**没有自己字号的 UI 元素**；换了会把问答卡、工具组壳一起撑开，超出 D1-b 的授权范围 |
| `ToolRows.tsx:76` 工具行 | ❌ **不换** | 工具行是单行密集列表，不是散文。对比稿 §01 差异表也把工具行排除在密度轴外 |
| `QuestionCard.tsx:254` 问答对容器 | ❌ **不换** | rev.2 补（A 轨 M-8）。问答卡是 UI 元素不是散文；且它正是 `turnBodyClass()` 注释点名要保护的那个「没有自己字号的组件」，两处必须同档 |
| `QuestionCard.tsx:371` 选项说明 | ❌ **不换** | 同上 |
| `QuestionCard.tsx:536` 提示正文 | ❌ **不换** | 同上 |
| `EnhancedInput.tsx:826` 输入框 | ❌ **不换** | rev.2 补。它是 `<textarea>` 的行高，属输入控件不属散文；且与 `composerTextareaClass()` 的 `[&_textarea]:leading-6` 是同一族约束，动它会破 §6.7 的 24px 行高契约 |

⇒ **新增静态不变量 [INV-D1-1]**：三个散文点的行高类必须**逐字相同**，
且**六个不换点**（`turnBodyClass()` · `ToolRows.tsx:76` · `QuestionCard` ×3 · `EnhancedInput.tsx:826`）的行高必须**仍是** `leading-normal`
（解耦的正向证据，防「一把梭全改」）。
**断言形态改为计数式**（rev.2）：chat 目录非测试文件里 `leading-normal` 的总出现次数从 **9** 降为 **6**，
`leading-relaxed` 从 **0** 升为 **3**，两个数**同时**断言——单看任一个都抓不到「换了一个又新加了一个」。

### 1.4 三条裁定

**① 嵌套列表再收紧档 4px → 6px（与项距同值）**
`chatMarkdownPolicy.ts:451-461` 注释自陈：`first:mt-0` 在特异性上压过 `[&_ul]:mt-1`，所以**首个**子列表实测是 0px，
该 utility 真正承重的场景只有「列表项内先有正文、再挂子列表」。那一档在语义上就是**项与项之间的距离**，
应等于项距而非另立一个值。取 6px 后，散文层的纵向数值集合从 {4,6,10,14,20,24} 收敛为 **{6,14,24}** 三个。

**② 表格横向内距不动**
密度抱怨是纵向的（行高、段距）。表格 `px-2.5` 若同步放大，45rem 阅读栏内的宽表会更早触发横向滚动
（`chatMarkdownTableWrapClass()` 的 `overflow-x-auto`），属**负收益**。对比稿差异表也只列了 py。

**③ 代码块行高走内置档 `leading-normal`（1.5），不写 `leading-[1.5]`**
`design-system.md` 的 Token 分档纪律禁任意值；1.5 是内置档，直接用。
⚠️ 顺带记一条**既存违规**（本批不修，另立票）：`ToolRows.tsx:230/233/262/285/304` 五处写着 `leading-[1.55]` 任意值，
与该纪律冲突，且 `:304` 同时带 `text-tool-arg`（§2 会动这个 token）。本批只在 §2 改颜色类，**不顺手改 leading**，
避免把一个既存违规混进本批的变更面。

### 1.5 `:391-398` 注记重写口径（承重变更，不是文字润色）

现注释的主张是：**散文层的两档 = 回合骨架的两档（10 / 20），一个数都没新发明**。
D1-b 之后这句在字面上就是假的。两种改法：

- **（a）连回合骨架一起换档**（10→14 / 20→24）。**不采纳**：20px 回合节拍是 `readingColumnSpacingClass()` 的 `space-y-2.5`
  加 `turnBubbleBandClass()` 的 `py-2.5` **合成**出来的（`chatTimelineLayout.ts:17-32` 的算术注释），
  而 band 的 `py-2.5` 同时是置顶气泡的**不透明缓冲**——动它要重算 sticky 的遮盖，超出本批范围。
- **（b）显式解耦**（**采纳**）：散文层拥有自己的两档（14 / 24），与回合骨架（10 / 20）**解耦并留痕**。

重写后的注记必须讲清三件事，缺一不可：
1. 散文层现在有**自己**的两档，值是 14 / 24，来源是 D1-b 拍板（写明日期与对比稿路径）；
2. 它**不再**等于回合骨架的 10 / 20，且这是**有意的**——散文是长文阅读场景，回合骨架是界面结构节拍，
   两者的变更理由不同（同 `--text-meta` / `--text-code` 同为 13px 却必须是两个 token 的那条论证）；
3. **F-C4 真正钉的东西没变**：散文层仍然**只有两档**，没有第三档。换的是这两档绑定到谁，不是放弃「只有两档」。

### 1.6 断言重写清单（逐条，含退役换新）

`__tests__/chatMarkdownPolicy.test.ts`：

| 现位置 | 现断言 | 处置 |
|---|---|---|
| `:587-598` | 根类 `toContain('leading-normal')` | **改值** → `toContain('leading-relaxed')`，并**补一条负向** `not.toContain('leading-normal')`（防两个 leading 并存——根类是裸字符串不过 `cn()`，tailwind-merge 不会去重，后写的未必赢） |
| `:633-640` | h1–h3 = 20、h4–h6 = 10 | **改值** → 24 / 14；用例名里的 `(20px)` `(10px)` 一并改 |
| `:643-648`（describe 名 `…reuses the turn layout's two tiers…`） | 每个块级 `mt-*` ∈ {10, 20} | **改值 + 改名** → ∈ {14, 24}；describe 改为「散文层自有两档，且仍只有两档」 |
| `:650-657` `F-C4: the 10px tier is literally the turn body gap` | 断言 `turnBodyClass()` 的 gap = 10 **且** 段落 `mt` = 10（把两者绑死） | **退役换新**（解耦后按构造不成立；按变异纪律不许只改数字，必须换承重行）。换成两条见下 |
| `:781` | 脚注 `marginTopPx` = 20 | **改值** → 24 |

**新增两条（替代 `:650-657`）**：

- `[D1-1] 散文层的两档与回合骨架显式解耦`：断言 ① 段落 `mt` = 14；② `chatMarkdownHeadingClass(1)` 的 `mt` = 24；
  ③ `turnBodyClass()` 的 `gap-*` 解析后**仍是 10**（骨架未被误改）；④ **段落 `mt` ≠ 回合骨架 gap**。
  ④ 是解耦的**正向证据**：没有它，「把散文改回 10」这个变异测不出来。
- `[D1-2] 仍然只有两档，没有第三档`：`new Set(ALL_BLOCK_CLASSES.map(marginTopPx)).size === 2`。
  这条严格强于 `expect([14,24]).toContain(...)`——后者对「所有块都退化成 14」（集合塌成一档）**判绿**，前者判红。

【实测】测试辅助函数 `marginTopPx`（`:503-507`）的正则是 `mt-([0-9]+(?:\.[0-9]+)?)`，**接受小数**，
`mt-3.5` → 14、`mt-6` → 24 均可解析，**辅助函数无需改动**。

`__tests__/messageTimelineWiring.test.ts`：

| 现位置 | 现断言 | 处置 |
|---|---|---|
| `:407` | 逐字钉流式兜底类串 `"text-markdown leading-normal text-foreground whitespace-pre-wrap select-text"` | **改值**（`leading-normal` → `leading-relaxed`）。这是 D1-b 在本文件的唯一必红点 |
| `:433-435` | `whitespace-pre-wrap text-markdown` 子串出现 **2** 次 | **不改**：命中的两处是 `:782`（用户气泡）与 `:816`（NoticeMessage 体），子串在 `:782` 换档后仍相邻，计数不变 |

**新增 `[INV-D1-1] 三个散文点行高一致 + 骨架未被带跑`**（放 `messageTimelineWiring.test.ts` 的源文扫描区）：
断言 ① `MessageTimeline.tsx` 里出现 `leading-relaxed` 的次数 = **2**（`:782` 与 `:1464`）；
② `chatMarkdownRootClass()` 含 `leading-relaxed`；
③ `turnBodyClass()` 与 `ToolRows.tsx:76` 的行头类**仍含** `leading-normal`。
③ 是「一把梭全改」的反向闸门——它是本条唯一能抓到过度换档的半边。

**不动**：`MessageTimeline.tsx:816`（NoticeMessage 体）**本就没有任何 `leading-*` 类**，靠继承取值，
本批不给它加，也不改它——它是 `Alert` 体不是散文。

#### 1.6-b `__tests__/chatMarkdownRender.test.ts` —— **第三份必红测试**（rev.2 新增，rev.1 完全漏列）

【实测】B 轨第 3 条命中：`chatMarkdownRender.test.ts:300` 有一条**渲染后**（非类装配）的根节点断言：

| 位置 | 现断言 | 处置 |
|---|---|---|
| `:285` `it('F-C6: the markdown root carries its class, not merely the absence of banned ones')` | `:299` `expect(root).toContain('text-markdown');`<br>`:300` `expect(root).toContain('leading-normal');` | **改值** → `:300` 改 `toContain('leading-relaxed')`，并**补一条负向** `expect(root).not.toContain('leading-normal')` |

**为什么它必红而不是自动跟随**【实测】：`text-markdown` 只承担 **15px 字号**，行高是**独立显式类**——
`MessageTimeline.tsx:782`（用户正文）、`:1464`（流式兜底）、`chatTimelineLayout.ts:100`（回合骨架）三处各自写死 `leading-normal`，
**没有任何 token 传播链**。⇒ 改根类不会自动改到它们，它们也不会自动改到根类；
这份测试断的是「渲染产物里确实有这个类」，与 `chatMarkdownPolicy.test.ts:590` 断的「类装配函数返回值里有」是**两层证据**，
两条都得改。

⚠️ **连带修订**：`:297-298` 的注释原文是
`` // D25's 15px body tier and its line height, pinned explicitly rather than / // inherited — the same reason every heading spells `text-markdown`. ``
——「its line height」在 D1-b 后指向的是 1.625 而非 1.5，注释本身不假，但**须补一句写明这一档来自 D1-b**，
否则下一个读者会以为 15px 与 1.625 是同一份 D25 裁定。

---

## §2 F5-D2-b 次要层 token 提档（全局 token 层）

### 2.1 落点与新值

【实测】两处色值定义 + 一处派生 + 两条 `@theme` 桥接，全在 `src/renderer/styles/globals.css`：

| 位置 | 现值（原文） | 新值 | 实测对比度（对 `--background`） |
|---|---|---|---|
| `:159`（`:root`，亮） | `--muted-foreground: oklch(0.5111 0.0053 78.28);` | `--muted-foreground: oklch(0.4531 0.005 91.5);` ＝ `#575653` | 5.62 → **7.20**（AA → AAA） |
| `:211`（`.dark`，暗） | `--muted-foreground: oklch(0.5933 0.0079 88.68);` | `--muted-foreground: oklch(0.6956 0.0103 93.62);` ＝ `#9F9D96` | 4.48 → **6.70**（险过 → AA+） |
| `:195` `--tool-arg` 派生 | `color-mix(in oklab, var(--muted-foreground) 78%, var(--background))` | 混合比 **78% → 85%**（见 §2.3） | 3.61 / 3.11 → **5.09 / 5.02**（不过 AA → 稳过 AA） |
| `:17` / `:37` `@theme` 桥接 | `--color-muted-foreground` / `--color-tool-arg` | **不动**（两个 token 都已注册，无「死件」风险） | — |

⚠️ **写法纪律**：新值必须写成 **OKLCH 字面量**，与该文件其余 token 同形；
**不得**直接写 `#575653` 十六进制——`globals.css:147-232` 全域是 OKLCH，混写会让「同一色空间内比较/派生」的前提破裂
（`--tool-arg` 的 `color-mix(in oklab, …)` 正依赖此）。上表的 OKLCH 值是由目标 sRGB 反解得到的**等价值**，
本轮已做**双向回代验证**【实测】：`oklch(0.4531 0.005 91.5)` → `#575653`、`oklch(0.6956 0.0103 93.62)` → `#9F9D96`，
两者逐位精确；同一条转换链把**现值** `oklch(0.5111 0.0053 78.28)` / `oklch(0.5933 0.0079 88.68)`
分别还原为 `#686663` / `#807E79`（与 `design-system.md` 记录的现值逐位吻合），故转换链本身可信。

### 2.2 亮暗两主题**各自**的判定（不许用 `dark:` 表达差异）

`design-system.md:115-124` 明令「新代码不得用 `dark:` 表达关键可读性差异」。
本批**零处** `dark:`：两个值分别落在 `:root` 与 `.dark` 的同名变量上，靠语义 token 自身随 `.dark` 换值。

| 层 | 亮：现 → 新 | 暗：现 → 新 |
|---|---|---|
| `--muted-foreground` | `#686663` 5.62 → `#575653` **7.20** | `#807E79` 4.48 → `#9F9D96` **6.70** |
| `--tool-arg`（派生 85%） | `#878581` 3.61 → `#6E6D69` **5.09** | `#676561` 3.11 → `#888680` **5.02** |

两个提案色都是 **Flexoki 官方 base 色阶整档**（亮 = base-700、暗 = base-400），不是自创色，
符合 `design-system.md` 的「硬编码色禁令 / 不私自调色」纪律。

### 2.3 裁定：`--tool-arg` **保留派生，混合比 78% → 85%**（【与对比稿冲突】）

对比稿 D2-b 主张「`--tool-arg` **退役**并入 `muted-foreground`」。本规格**不采纳**，改判为「保留并抬比」。四条理由：

1. **用户拍板的用词是「修到过 AA」，不是「退役」。** 分诊档拍板记录第 5 条原文：
   「`--muted-foreground` 取 Flexoki 官方色阶亮 7.20/暗 6.70，**工具参数色修到过 AA**」。
   「修到」预设这个色**继续存在**；退役是设计员的建议，未被逐字采纳。
2. **【实测】退役会消灭一层真实的信息层级。** `ToolRows.tsx` 今天用两个灰表达两级信息：
   行头动词 = `text-muted-foreground`（`:76-77`），**参数与折叠箭头** = `text-tool-arg`（`:112` 箭头、`:304` 参数块）。
   退役后整条工具行变成单一颜色，「动词 / 参数」不再可分。对比稿把这条算成「净减少一个 token」的**收益**，
   实为**信息设计的净损失**。
3. **【实测】派生公式是自平衡的，扔掉可惜。** 同一个混合比在两套主题下产出几乎相同的对比度：
   p=0.78 → 4.34 / 4.36；p=0.80 → 4.54 / 4.54；**p=0.85 → 5.09 / 5.02**；p=1.00 → 7.20 / 6.70。
   这正是 `globals.css:190-194` 注释所述「声明一次，`.dark` 的覆盖自动被拾取」的设计意图，已被本轮数值验证为有效。
4. **为什么是 85% 而不是刚好过线的 80%。** 80% 落在 **4.54**，距 AA 阈 4.5 只有 0.04 余量——
   上游 Flexoki 任何一次微调都会把它推回不合格；85% 给出约 0.5 的余量，同时仍保留 7.20 vs 5.09 的可辨层级差。

**这条最关键的连带后果**：若按对比稿只改 `muted-foreground`、不动派生比，
【实测】tool-arg 只到 **4.34 / 4.36 —— 仍然不过 AA**，而拍板要求它「过 AA」。
⇒ **「只改两个色值就完事」是错的**，本条必须显式执行。

**本条已决，不再复议**（rev.2）：评审 B 轨曾指出 §2.3 与旧 §10.1 Q1 互相矛盾（一边裁定、一边又列待拍板），
执行者按前者直接施工、按后者必须停工询问。**按「85% 已决」解**：`--tool-arg` 保留派生、混合比 85%，
`§10.1` 的 Q1 开放问题身份**已删除**，下方候选 B **降为仅历史存档**，不得再以「评审拍板即可启用」的身份被引用。

**候选 B（❌ 不启用 · 仅历史存档 · 记录以免复议时重新调研）**：退役 `--tool-arg` 并入 `muted-foreground`（7.20 / 6.70）。
rev.1 的清单**漏了三处消费点**（A 轨 M-9 纠错），完整影响面如下【实测，HEAD `d9281d0`】：

| # | 位置 | 内容 | rev.1 是否列出 |
|---|---|---|---|
| 1 | `globals.css:195` | `--tool-arg: color-mix(in oklab, var(--muted-foreground) 78%, var(--background));` | ✅ |
| 2 | `globals.css:37` | `@theme` 桥接 `--color-tool-arg: var(--tool-arg);` | ✅ |
| 3 | `ToolRows.tsx:112` | 折叠箭头 `text-tool-arg` | ✅ |
| 4 | `ToolRows.tsx:304` | 参数块 `text-tool-arg` | ✅ |
| 5 | `toolCard.ts:823` | 纯函数返回 `'text-tool-arg'`（三元的一支） | ❌ **漏** |
| 6 | `toolCard.ts:803` | 注释逐字引用 `text-tool-arg` 作为「未注册 `text-<name>`」的示例 | ❌ **漏** |
| 7 | `__tests__/toolRowArg.test.ts:48` | `expect(failedIdent).not.toContain('text-tool-arg')` | ❌ **漏** |
| 8 | `lib/utils.ts:19` | `cn()` 头注逐字引用 `text-tool-arg` 解释「颜色 token 不是字号 token」 | ❌ **漏** |
| 9 | `lib/__tests__/utils.test.ts:30-31` | `expect(cn('text-muted-foreground', 'text-tool-arg')).toBe('text-tool-arg')` —— **真断言，退役即必红** | ❌ **漏** |

⇒ 候选 B 的真实代价不止 §2.3 理由 2 的层级损失，还包括**两份 chat 目录之外的测试改动**（第 7、9 行）与
**`cn()` 的 tailwind-merge 词表注释链**（第 8 行）——它把一次「聊天页配色」变更扩散到 `lib/` 的工具层。
这是本档不采纳它的第五条理由，**仅记录，本批不执行**。

### 2.4 影响面：这是一次**全局**提档，不是聊天页局部改动

`--muted-foreground` 是全仓语义 token。对比稿脚注里的「104 处」【与任务书转述冲突，见 C3】
是 **`src/renderer/components/chat/` 下非测试文件**的计数，**不是**「chat 之外的 104 处」。
真实影响面见 §2.4-b 分面表。

#### 2.4-a 判定规则：三类用法，只有第一类是纯收益

提档动的是**同一个值**，但这个值在仓里承担三种完全不同的角色，必须分开判：

| 类 | 用法形态 | 提档方向 | 判定 |
|---|---|---|---|
| **①「字」** | `text-muted-foreground`（无 alpha） | 亮变深 / 暗变浅，**远离底色** | ✅ **纯收益**，正是本批目标。全部放行 |
| **②「淡字」** | `text-muted-foreground/NN`（带 alpha，如 `/60` `/50`） | 同向变化，但被 alpha 稀释后**仍可能不过 AA** | ⚠️ **逐处审**：提档后仍不达标的，说明该处本就不该用 alpha 表达层级（`design-system.md` Alpha 纪律），列入另立票，本批不顺手改 |
| **③「面」** | `bg-/border-/fill-/stroke-/ring-muted-foreground`（含 `/NN`） | **这是把前景色当背景/线用**——提档会让这个**面/线变得更抢眼** | ⚠️ **需豁免判断**：方向未必是想要的 |

#### 2.4-b 已识别的第③类用法与豁免裁定

【实测】`src/renderer/styles/globals.css:343` 与 `:347`——**滚动条滑块**：

```css
::-webkit-scrollbar-thumb        { @apply bg-muted-foreground/20 rounded-full; }
::-webkit-scrollbar-thumb:hover  { @apply bg-muted-foreground/40; }
```

本轮实测其对 `--background` 的对比度变化。
**⚠️ rev.2 全表重算**：rev.1 把 `/NN` 当 Oklab 混合算（A 轨 M-4），而 CSS 的 alpha 是 **sRGB 空间简单合成**（§0.6）：

| 主题 | 滑块常态 `/20` | 悬停 `/40` |
|---|---|---|
| 亮 | `#E1DFD7` 1.312 → `#DDDCD4` **1.353** | `#C3C1BA` 1.775 → `#BCBAB4` **1.903** |
| 暗 | `#2C2A29` 1.274 → `#32302F` **1.389** | `#413F3D` 1.735 → `#4D4B49` **2.106** |

（rev.1 的错值：亮 1.335→1.385 / 1.831→1.983、暗 1.234→1.321 / 1.648→1.950。方向一致，量级偏低。）

**裁定：常态放行，悬停态记一条显式豁免。**

- **常态 `/20`**：1.353 / 1.389，仍**低于** `border-border` 对 `background` 的参照强度（1.402 / 1.441），不越位 → **放行**。
- **悬停 `/40`**：1.903 / 2.106，**高于**参照强度——但它**提档前就已经高于**（1.775 / 1.735），
  这是**既有的、有意的**交互态设计：一个 hover 反馈若不比分割线更显眼，就等于没有反馈。
  提档带来的增量是 +0.13 / +0.37，**没有改变它的角色档位** → **显式豁免，放行**。

⇒ 两个主题、两个状态全部朝「更可见」移动，与本批「对比太弱」的诉求同向。

#### 2.4-c 全仓扫描结果（本轮实测）

**总量**【实测 HEAD `d9281d0`，命令见 §0.6】：`text-muted-foreground(/N)` 在 `src/` **非测试文件**中出现 **845 处**，
分布在 **154 份文件**；其中 `components/chat/` 占 **106 处**（对比稿写 104，同量级，差异来自取证时点）。
⇒ **chat 只占全仓的 `106 / 845 = 12.54%`，另外 87.46% 在聊天页之外**。这是一次全应用改造。

（rev.1 写 844 / 156，两项均不可复现；B 轨 m-1 纠错，rev.2 已按可复算命令重取。
下方目录分面表按同一次扫描重生成，若施工时 HEAD 已前移须重跑。）

**按目录分面（非测试文件数）**：`chat` 25 · `ui` 24 · `settings` 23 · `source-control` 12 · `files` 11 ·
`layout` 8 · `git` 8 · `workspace-shell` 6 · `worktree` 5 · `group` 5 · `todo` 4 · `terminal` 4 ·
`sessions` 3 · `search` 3 · `repository` 2 · `onboarding` 2 · 其余各 1。

**第②类（带 alpha）36 处**，值域 `/40 /50 /60 /70 /72`。集中在 `source-control`（10）、`layout`（8）、
`todo`（6）、`ui`（4 处 `/72`，为 `input`/`tabs`/`menu`/`command` 的 placeholder 档）。
**裁定：本批不逐处改**——提档后它们全部同向改善，仍不达标的属**既存的 alpha 滥用**
（`design-system.md` Alpha 纪律的问题，不是本批引入的），另立票。

**第③类（非 `text-` 前缀）逐处清单与裁定**：

| 位置 | 用法 | 角色 | 裁定 |
|---|---|---|---|
| `globals.css:343 / :347` | `bg-muted-foreground/20` `/40` | 滚动条滑块 | ✅ 放行（§2.4-b 已量化） |
| `source-control/CodeReviewModal.tsx:125`、`files/MarkdownPreview.tsx:183` | `border-muted-foreground/30` | 引用块左导轨 | ✅ 放行——导轨变明显与本批目标同向 |
| `workspace-shell/surfaces/GitHistoryList.tsx:144` | `bg-muted-foreground` | commit graph 节点圆点 | ✅ 放行 |
| `onboarding/OnboardingView.tsx:864` | `bg-muted-foreground/40` | 分页圆点 | ✅ 放行 |
| `settings/GeneralSettings.tsx:923`、`AgentSettings.tsx:487/592/814`、`HapiSettings.tsx:552` | `border-muted-foreground/30` + `border-t-muted-foreground` | 5 处 spinner 轨 + 头 | ✅ 放行——转圈更可见 |
| `settings/prompts/PromptsSection.tsx:190` | `border-muted-foreground` | 单选圆圈描边 | ✅ 放行 |
| `chat/EnhancedInput.tsx:806` | `group-hover:bg-muted-foreground` | 拖拽把手 hover 态 | ✅ 放行 |
| `placeholder:text-muted-foreground(/N)` 约 15 处 | 输入框占位符 | 实为**字**（类①/②） | ✅ 放行 |

**判定口径（rev.2 重写 —— rev.1 的口径与结论自相矛盾，A 轨 M-3）**：

rev.1 写「只要提档后对相邻底色的对比度超过 `border-border` 参照强度（亮 1.402 / 暗 1.441）就必须豁免」，
然后又断言「零处需要豁免」——但滚动条**悬停态**提档后是 1.903 / 2.106，**按它自己的规则就该被拦下**。
两者不可能同时为真。rev.2 把口径拆成两条，各自可判：

| 口径 | 规则 | 依据 |
|---|---|---|
| **常态（resting）** | 提档后对相邻底色的对比度**不得超过** `border-border` 参照强度（1.402 / 1.441）——超过就意味着一个装饰性标记比全仓分割线还抢眼 | 分割线是界面里「结构性最弱的可见元素」，装饰标记不该越过它 |
| **交互态（hover / active / focus）** | 参照强度**不适用**——交互反馈按设计就该比分割线显眼。判据改为：**提档不得改变它的角色档位**，即提档前已高于参照强度的，提档后增量须在同一量级（本批阈值取 +0.5 以内） | 一个不比分割线更显眼的 hover 等于没有反馈 |

⇒ **结论（rev.2 订正）：一处显式豁免（滚动条悬停 `/40`，§2.4-b 已量化），其余全部放行。**
第③类其余用法（圆点 / 导轨 / spinner 轨 / 把手 / 滑块常态）都是**装饰性标记**，
提档在两个主题下都朝「更可见」移动、且幅度都在 `border-border` 参照强度以内，与本批诉求同向。
**「零处豁免」是 rev.1 的错误结论，不得再引用。**

**无自动化对比度/ token 快照测试**【实测】：`src/**/__tests__` 下不存在扫描 `globals.css` 色值或计算对比度的测试
（命中 `oklch`/`contrast` 关键字的 6 份测试全部是字体域 / markdown / dark-variant 扫描，与色值无关）。
⇒ **D2-b 的值改动没有任何单测会红**——这既是好消息（零测试返工）也是风险（改错了没人拦）。
§8.2 因此新增一条 **token 值静态断言**（`[D2-1]`）补这个洞。

### 2.5 基线修订：`design-system.md`「已知偏差」表

【实测】`design-system.md` 的「已知偏差（Flexoki 原值，刻意不私自调色）」表列了三条不满足 AA 的偏差，
其中一条正是 **`--muted-foreground` 暗色 4.49:1**，且表头明写「**改动需另立决策**」。

⇒ **本批就是那个决策。** 处置：
1. **删除**该表中 `--muted-foreground 暗色 4.49:1` 一行（该偏差已被消灭）；
2. 在该表下方**追加一条修订注记**（不静默删行），格式随 §5 的统一归档纪律：
   > 2026-08-18 · F5 批 D2-b：`--muted-foreground` 亮/暗双档提至 Flexoki base-700 / base-400（7.20 / 6.70），
   > 该行偏差消灭；`--tool-arg` 派生比 78%→85%（5.09 / 5.02）。**已刻意偏离上游 Flexoki 原值**，
   > 理由与实测见 `docs/plans/2026-08-18-f456-readability-composer-spec.md` §2。
3. 表头「刻意不私自调色」的措辞需同步放宽为「默认不私自调色；偏离须逐条留痕」——
   否则表头与新增的注记自相矛盾。
4. **另两条偏差（`--success` 亮 4.42、`--destructive` 暗 4.20）本批不动**，保持原状。

### 2.6 前提：背景图未开（对比稿 §02 的前置排查）

【实测】`globals.css:147/149/151/158` 四个面（`--background` / `--card` / `--popover` / `--muted`）
都乘了 `var(--panel-bg-opacity, 1)`，该系数由 `App/hooks/useBackgroundImage.ts:39` 写在 `documentElement` 上。
**一旦开启背景图，本节全部数值失效**（前景对比度改由壁纸决定）。

用户已拍板「**无背景图，阅读底票不立**」⇒ 本批全部数值按 `--panel-bg-opacity = 1` 计算，
`useBackgroundImage` 与 `--panel-bg-opacity` **一字不动**。
**但须在 §10 记一条 open question**：本仓仍保留背景图功能，开图后 D2-b 的收益会被稀释——
「开图时给聊天时间线一个不透明阅读底」是一张**独立的票**，本批不立、不做、只记录。

---

## §3 F5-D3-c 用户气泡非对称（时间线角色层）

### 3.1 定性：这不是「复议 D26 ④」，是兑现 D31

见 §0.5 C1。`docs/plans/openchamber-chat-refactor-ledger.md:75` 的 **D31**（2026-08-13 用户拍板）
已明文「用户气泡**改回右对齐**（推翻 D26④ 满宽，**append-only 以本条为准**）」，
并在 `implementation-status.md:47` 列为「渲染端小批」待排队项，**至今未施工**。
⇒ 本批**不需要新的拍板**，只需在代码与文档侧把这条已生效的裁定落实并留痕（§5）。

### 3.2 改动点（`MessageTimeline.tsx` `UserBubble`）

| 锚点【实测】 | 现状 | 新值 |
|---|---|---|
| `:725-732` D26 ④ 注释块 | 「满宽；85% 与右对齐都没了，因为满宽后没有 slack 可对齐」 | **整段重写**为 D31 兑现记录，见 §3.5 |
| `:733` `<article>` | 无 className | `<article className="flex justify-end">` |
| `:736` 尺寸/形状类串 | `'space-y-2 rounded-lg border px-4 py-2.5'` | `'min-w-0 max-w-[85%] space-y-2 rounded-lg border px-4 py-2.5'` ——**`min-w-0` 是必需的，见下方 ⚠** |
| `:782` 正文 `<p>` | `'whitespace-pre-wrap text-markdown leading-normal text-foreground'` | `'whitespace-pre-wrap break-words text-markdown leading-relaxed text-foreground'` ——`break-words` 同上，行高换档见 §1.3 |
| `:743` 角色类串 | `'rounded-br-xs border-primary/8 bg-card'` | `'rounded-br-xs border-input bg-accent'` |

⚠️ **`max-w-[85%]` 单独写会被 `min-width: auto` 击穿**（rev.2 新增，A 轨 M-2）：

`<article>` 变成 `flex justify-end` 后，气泡 `<div>` 就是**弹性项**。CSS 规定弹性项的
`min-width` 默认解析为 `auto`（= 内容的 min-content 宽度），而在宽度算式里 **`min-width` 优先级高于 `max-width`**。
⇒ 一条没有断行机会的长内容（超长 URL / 无空格长串 / 一个很长的单词）会把 min-content 宽度顶到 85% 以上，
`max-w-[85%]` **静默失效**，气泡重新变回满宽——而且只在特定内容下发生，日常点验看不见。

两半都要打：

1. **气泡 `<div>` 补 `min-w-0`** —— 解除 `min-width: auto`，让 `max-w-[85%]` 真正生效；
2. **正文 `<p>` 补 `break-words`** —— 给没有断行机会的长串一个断点，否则即使 `min-w-0` 让盒子收窄，
   内容也会横向溢出气泡边框。

**这不是新发明**：`chatMarkdownRootClass()` 早就同时带 `min-w-0` 和 `break-words`
（`chatMarkdownPolicy.ts:426`），其理由被 `chatMarkdownRender.test.ts:287-293` 逐字写明——
「a flex child's `min-width` is `auto`, so without it the item refuses to shrink below its content」。
用户气泡此前是**满宽块级盒**，不是弹性项，所以不需要；D3-c 把它变成弹性项，同一条约束就跟着适用。
⇒ `[D3-1]` 必须把 `min-w-0` 与 `break-words` 一起断言（§8.2）。

**`max-w-[85%]` 的任意值不违纪**：`design-system.md` 的禁任意值针对**设计 token 维度**
（颜色 / 圆角 / 阴影 / 字号 / 行高）；百分比宽度是布局比例，不在 token 词表内，Tailwind 也无对应内置档。
且 `max-w-[85%]` 正是被 `messageTimelineWiring.test.ts:451` 逐字点名的字符串，沿用同一拼法可让退役换新一一对应。

### 3.3 色学核对（本轮实测，全部达标）

| 项 | 亮 | 暗 |
|---|---|---|
| `bg-accent` 对 `bg-background`（气泡"面"是否看得见） | **1.161** | **1.292** |
| `border-input` 对 `bg-accent`（气泡"线"） | **1.350** | **1.322** |
| `text-foreground` on `bg-accent`（气泡正文） | **16.17** AAA | **8.81** AAA |
| `text-muted-foreground`(D2-b 新值) on `bg-accent` | **6.20** AAA | **5.19** AA+ | 

对照现状：`bg-card` 对 `background` 只有 1.027 / 1.049（不可辨）、`border-primary/8` 对 `card` 只有 1.111 / 1.102（近不可辨）
——**气泡今天等于没画出来**，这正是「无区分度」的精确解释。

**语义依据**（非自创）：`design-system.md:102` 明写「需要真正拉开的第三级底色时，用 `--accent` / `--selection`（交互层）
或 `--input`（填充层）」；`--input` 的词表定义就是「**填充语义**，兼作**输入框**描边」，
而用户气泡正是**用户输入的回显**——描边取 `--input` 是语义命中而非凑色。
用户气泡自身**没有 hover 态**，不会与 `--accent` 的交互语义打架【实测】`UserBubble` 全函数无 `hover:` 类。

### 3.4 三条连带核对（不做会留坑）

**① 右下角 `rounded-br-xs` 终于指向它被设计的那条边。**
`:737-742` 注释自陈这个 4px 尖角是「sharp bottom-right **"tail" toward the right-aligned edge**」——
它是为右对齐设计的，D26 ④ 把右对齐拿掉后这个尖角就成了没有指向的孤儿。D3-c 落地后语义自洽，**无需改动**。

**② 置顶气泡「85% 会漏缝」的旧论证已被 as-built 推翻**（【实测】重要）。
`docs/plans/2026-07-31-reply-anatomy-design.md:421` 曾主张「满宽正是置顶气泡的前提：85% 右对齐的气泡钉在顶端
会留下一条左侧透明缝，滚入内容会从缝里穿出 ⇒ D26 ④ 必须先落地」。
该论证与**同一份规格自己落地的 band** 冲突：不透明遮盖由 **band** 承担而非气泡——
`chatTimelineLayout.ts:63-65` `turnBubbleBandClass()` 返回 `'sticky top-0 z-10 bg-background py-2.5'`，
其头注（`:56-62`）明写「`bg-background` … plus `py-2.5` **is what makes the pinned state opaque**」，
且 band 是**满宽**的块级元素（`MessageTimeline.tsx:1168`）。
⇒ 85% 气泡左侧露出的是 band 的 `bg-background`，即时间线自身底色，**没有透明缝**。
**但**：本条属「布局缺陷只在截图里显形」的高危族，§8 要求 GUI 点验必须包含**滚动到置顶态的截图**，
不得只凭本推理放行。

**③ 气泡内附件芯片的底与线要跟着换。**
【实测】芯片类串在 `:757`：`'… rounded-xs border border-border bg-muted/50 px-1.5 text-meta text-foreground'`。
底色从 `bg-card` 换到 `bg-accent` 后本轮实测：

| 项 | 在 `bg-card` 上（现状） | 在 `bg-accent` 上（D3-c 后） |
|---|---|---|
| 芯片底 `bg-muted/50` 对所在底 | 1.022 / 1.004（不可辨） | 1.041 / **1.113**（略好，rev.2 按 sRGB 合成重算） |
| 芯片线 `border-border` 对所在底 | ≈1.36 / 1.37 | **1.208 / 1.115（暗色近不可辨）** |

⇒ **裁定**：芯片描边 `border-border` → **`border-input`**（对 accent 1.350 / 1.322），与气泡描边同族同强度。
底 `bg-muted/50` 保持不动（它本就不承担可辨性，芯片靠描边与图标成形）。

**④ 气泡内已经有一个 F10 落地的 `line-clamp-6` 容器，D3-c 必须与它对账**（rev.2 新增；rev.1 对 F10 产物零感知，A 轨 M-1 / B 轨第 9 条）。

【实测 HEAD `d9281d0`】`MessageTimeline.tsx:778` `<div className={userBubbleTextClass()}>`，
而 `chatTimelineLayout.ts:84-86` 返回 `'select-text space-y-2 line-clamp-6'` —— **六行**，不是三行。
它是 F10（2026-08-18，与本批同日）把 §5.6-A 的「置顶时才 clamp」换成「无条件 clamp」的 as-built 产物，
其头注（`:67-83`）明写换掉的理由是一条 **scroll-position → layout-height 振荡回路**，
末句还点名 `` a user-owned expand toggle is F456-batch work ``——**它认为展开开关归本批**。

**四条连带裁定**：

1. **本批不做展开开关。** F10 头注把它记在「F456 批」名下，但用户 2026-08-18 的四条拍板里没有这一项，
   §0.2 的越界纪律优先。⇒ 记入 §10.3 另立票，并在施工时**顺手把 F10 头注那句改成「归后续票」**，
   否则它会一直宣称一件本批没做的事。
2. **clamp 的高度预算会被 D3-c 显著改变。** 85% 宽 + `min-w-0` 之后同样的文本换行数上升，
   六行 clamp 的触发点前移；`space-y-2` 段距与附件芯片区**都在** clamp 容器之外
   （附件区在 `:752-773`，clamp 容器从 `:778` 才开始）⇒ **附件不吃正文的六行预算**，这是好消息，
   但**必须由 GUI 点验确认**（§8.5 G-3 四场景），单测只看类名看不出 `-webkit-box` 在多个块级 `<p>` 上的真实裁切行为。
3. **结构合同要写死**：`userBubbleTextClass()` 的 clamp 容器**只包正文 `<p>`**，
   附件芯片区必须留在它**外面**。这条要立成静态断言（§8.2 `[D3-8]`），否则「顺手把附件挪进去」
   会静默吃掉正文的可见行数。
4. **陈旧注释顺手订正**：`MessageTimeline.tsx:718` 仍写 `` // state, which is what makes the pinned three-line clamp safe. ``
   —— 「pinned」与「three-line」在 F10 之后**两个词都错**（现在是无条件 + 六行）。
   本批既然要改这一段，就把它一起订正为 `unconditional six-line clamp`。

### 3.5 `:725-732` 注释重写口径

现注释的主张是「D26 ④：气泡满宽，85% 与右对齐是死重量」。D3-c 之后它是**反向的假话**，必须整段重写，讲清四件事：
1. 现形态的出处是 **D31 冲突项回摆①**（2026-08-13 拍板）+ F5 D3-c（2026-08-18 拍板），写明两个日期；
2. **D26 ④ 至此在代码侧同步作废**，并给出台账锚点（`openchamber-chat-refactor-ledger.md:75`）；
3. 区分度来自**形状不对称**（右对齐 + 85%）而非新容器——这句是与 §4 助手容器的分工声明，缺了它下一个读者会以为两边都在做同一件事；
4. 复述本节的四个实测数（1.161 / 1.350 / 16.17 / 8.81）作为「为什么这次的气泡真的看得见」的证据，
   并点名旧值 1.027 / 1.111 是「为什么上次看不见」。

---

## §4 F5-D3-b 助手中性容器与**解嵌套裁定**

> 用户在设计员明示「三层嵌套框」反对意见后仍拍板 D3-c 与 D3-b **并用**，
> 并要求施工规格给出解嵌套方案、实现方保留否决权上报。本节即该方案。

### 4.1 先把问题量化（对比稿只给了定性）

若按对比稿字面实作（助手散文外层加 `bg-muted + border-border`），本轮实测三个后果：

| 后果 | 实测 | 严重度 |
|---|---|---|
| **行内代码芯片彻底消失** | `CodeInline` 是 `rounded-xs bg-muted px-1 …`（`ui/ident.tsx:31`），容器也是 `bg-muted` ⇒ 对比度 **1.000（同色）** | **致命** |
| **代码块退化成空框** | 代码块底是 `bg-muted/50`（`chatMarkdownPolicy.ts:509`），50% muted 合成在 muted 底上**等于 muted 本身** ⇒ 对容器 **1.000** | **致命** |
| **所有内层边框变弱** | `border-border` 对 `muted` = **1.308 / 1.363**，对 `background` = 1.402 / 1.441 | 中 |
| 容器自身几乎看不见 | `bg-muted` 对 `background` = **1.072 / 1.057**（低于可辨阈） | 高 |

外加一条**词表纪律冲突**：`design-system.md:93-101` 明令「**禁止**用 `bg-secondary` vs `bg-muted` 表达『两层面板』
…… 需要层次时**一律靠 `--border`**」。D3-b 的 `bg-muted` 容器正是「拿 muted 当第二层面」，
实测 1.072/1.057 也确实印证了那条纪律。

⇒ **「三层嵌套框」只是表象；真正的问题是「用一个看不见的面，换掉了两个看得见的面」。**

### 4.2 四个候选与裁定

| 候选 | 形态 | 判定 |
|---|---|---|
| **A · 只用底不用边** | `bg-muted rounded-sm p-3.5`，无 border | ❌ **淘汰**。少一层框线，但 §4.1 的两处 1.000 全数发生，且容器自己也看不见——**既没画出容器，又毁了内层** |
| **B · 只用边不用底** ★ | `rounded-sm border border-border p-3.5`，底保持 `--background` | ✅ **采纳**，理由见 §4.3 |
| **C · 内层首层块级元素边框降级** | 容器 `bg-muted border`，代码块/表格作为容器直接子元素时去边框 | ❌ **淘汰**。① 要给 `chatMarkdownCodeBlockClass()` 之流引入「上下文」参数，破坏 `chatMarkdownPolicy.ts:2-8` 立的模块纪律（无参纯函数、node 环境可真值表化）；② 若改走 CSS `[&>pre]:border-0`，只命中**直接子元素**——列表项内的代码块命中不到，同一份回答里出现两种代码块外观 |
| **D · 容器内距吃掉内层 margin** | 只调间距不调框线 | ⚠️ **部分采纳**：它解决的不是嵌套框（正交问题），但其内距口径并入 B，见 §4.3 |

### 4.3 采纳方案 B 的完整形态

**新增类装配函数**（放 `chatTimelineLayout.ts`，与其余回合级类装配同处，保证 node 环境可断言）：

```
turnAnswerContainerClass() -> 'rounded-sm border border-border p-3.5'
```

**挂载点**【实测 HEAD `d9281d0`】：`MessageTimeline.tsx:1224`
`{answer.length > 0 && <div className={turnBodyClass()}>{answer.map(renderItem)}</div>}`
→ `className={cn(turnBodyClass(), turnAnswerContainerClass())}`。

🔴 **施工红线（rev.2 新增，两轨同时命中）**：rev.1 把挂载点写成 `:1209`，
但 `:1209` 在 HEAD 上是 **process 面板**：`className={cn(turnProcessPanelClass(), turnBodyClass())}`。
**照 rev.1 的行号施工 = 亲手落成 M-15 变异**（把回答容器挂到过程段一侧，§8.4）。
⇒ 施工时**必须按上面那行原文定位**，不得按行号盲改；`turnBodyClass()` 在这段渲染逻辑里出现 **3 次**
（`:1172` 回合体 · `:1209` 过程面板 · `:1224` answer 段），三者字面几乎相同，是本批最容易改错的一处。

**DOM 事实（用于 §8.2 的断言设计）**【实测】：

```
<section class={chatTurnClass()}>              :1156   ← sticky containing block
  <div class={turnBubbleBandClass()}>          :1168   ← position: sticky 的那个元素
    <UserBubble/>
  </div>
  <div class={turnBodyClass()}>                :1172   ← band 的「后续兄弟」
    …process…                                  :1209
    <div class={cn(turnBodyClass(), turnAnswerContainerClass())}>   :1224  ← 本批新增的容器
  </div>
</section>
```

⇒ **answer 容器是 sticky 元素的「后续兄弟的后代」，不是它的祖先。**
这条事实推翻了 rev.1 `[D3-6]` 的整个论证（§8.2 已改）。

**为什么挂在 `answer` 段而不是每个 text item**：
【实测】`chatTurn.ts:159-175` `splitTurnBody` 的定义是「`answer` = **尾部连续的 `text` item**，其余归 `process`」，
且 `:29-32` 明文「一条 notice 会终止 answer 尾」。⇒ `answer` 段**按构造只含助手散文**，
永远不含工具组、权限卡、问答卡（那些都在 `process`）——**这正好就是"助手的回答"这个语义单位**，
一个回合最多一个容器，且容器里不可能出现 `.qa` 卡这类自带外壳的东西。
若改为逐 item 包裹，过程段里的中间散文也会各得一个盒子，而过程段本身已经有折叠壳
（`turnProcessShellClass()` + `CollapsibleContent`）——那才是真正的三层。

**`answer === []` 的回合不戴框**（尾部是工具调用或错误通知的回合）：这是有意的。
【实测】`chatTurn.ts:185/203-205` 在 `answerEmpty` 时会强制展开过程段，用户看到的是一个摊开的过程段——
它本来就不是「一个回答」，不给它戴回答的框是诚实的。

**内距取 14px（`p-3.5`）**：与 §1 的 `BLOCK_GAP` 同档，不发明第三个数。
语义：「容器边到首块的距离」与「块与块之间的距离」同档。
`first:mt-0` 已保证首块不再叠加自身上边距（`chatMarkdownPolicy.ts:399-400`），无需额外抵消——这是候选 D 的那一半。

**方案 B 落地后剩余的框层数**：外层容器边框（对底 1.402/1.441）+ 叶子边框（代码块/表格，对底同强度），
两层之间隔着 14px 内距，**不贴边、不同心、不共线**。行内代码芯片与代码块底色**全部保持今天的数值不变**
（芯片 1.072/1.057、代码块 1.035/1.027）——B 的核心价值就是「一个数都不动内层」。

### 4.4 与 D3-c 的分工声明（必须写进注释，否则下个读者会拆错）

- **用户侧**的区分度来自**形状**：右对齐 + 85% + 有色面（`bg-accent`）；
- **助手侧**的区分度来自**边界**：满宽 + 无色面 + 一圈 `--border`；
- 两侧**刻意不同构**。若哪天有人为了「统一」把助手也改成有色面、或把用户也改成满宽描边框，
  就回到了「一切都是卡片、两边反而更像」的失败态——那正是设计员反对 D3-b 的原始理由。
  这句话是本批留给未来的**反向闸门**，必须落在 `turnAnswerContainerClass()` 的头注里。

### 4.5 与 D2-c 的边界

D2-c（行内代码 chip 补 `border-border`、工具输出块补左导轨）**未被拍板，本批不做**。
方案 B 之所以不需要它：B 不动内层任何底色，行内芯片的可辨性问题**保持现状**（本就是既存问题），
不因本批而恶化。若评审希望连芯片一起修，那是**另开 D2-c 的票**，不得夹带进本批的变更面。

### 4.6 实现方否决权与上报路径（用户已明确保留）

**触发条件**（任一成立即触发，不需要全部）：
1. GUI 点验截图显示容器边框与内层叶子框在视觉上仍构成「框中框」的压迫感；
2. 满宽容器把 720px 阅读栏的实际字宽压到读起来更差（14×2 + 2px 边框 = 30px 净损失）；
3. 容器出现/消失的时机（流式期首个 text block 落地那一刻）造成可见跳动。

**上报路径**（三步，不得跳步）：
1. 施工方在**施工分支上**产出对照截图（有容器 / 无容器 × 亮暗 × 含代码块与表格的回合），
   走 `node scripts/dev.js` + CDP 工法，截图入 `docs/design/` 或规格同目录；
2. 在本规格追加 **§4.6-a「实作否决记录」**小节，写明触发条件编号、截图路径、实测数值；
3. 由**用户拍板**是否降级为「只留 D3-c、撤 D3-b」或改走候选 A/C。
   **施工方不得自行撤销 D3-b**——它是用户在知情（设计员已反对）情况下的拍板，
   只有用户能推翻自己的拍板。这条纪律与 D31「append-only 以本条为准」同源。

---

## §5 基线条款正式修订与归档纪律

### 5.1 重要更正：用户气泡的**结构**不需要修订基线，代码是**回归**基线

【实测】两份冻结基线**本来就写着右对齐 + 85%**：

| 基线 | 原文 |
|---|---|
| `docs/design/phase0a-openchamber-alignment.html:419-421` | `/* 用户气泡：右对齐, max-w 85%, 圆角 xl 但右下角收 sm */`<br>`.fx-user { display: flex; justify-content: flex-end; }`<br>`.fx-user-bubble { max-width: 85%; … }` |
| `docs/design/a07-cursor-composer-alignment.html:848-849` | 同上（同一份 CSS 的更早版本） |

⇒ **偏离基线的是 D26 ④（代码），不是 D3-c。** D3-c 落地后，代码**重新与两份基线一致**。
对比稿把 D3-c 标成「触碰基线」【与对比稿冲突】——它触碰的是**决策**（D26 ④），不是**基线文档**的结构条款。
基线文档在结构上**一个字都不用改**，只需改两个色值（见 5.2 第 ④ 条）。

### 5.2 需要正式修订的基线条款（五处，逐条给出处置）

| # | 条款 | 位置 | 触发者 | 处置 |
|---|---|---|---|---|
| ① | 「**助手：完全平铺，无容器**」 | `phase0a:431` 注释 + `:432` `.fx-assistant` | **D3-b** | **正式修订**：注释改为「助手：满宽中性容器（只描边不换底），无色面」；`.fx-assistant` 补 `border` + `border-radius` + `padding`。**必须留修订注记**，见 5.3 |
| ② | 助手正文行高 `1.5` | `phase0a:432`、`a07:858` | **D1-b** | 改 `1.625` |
| ③ | 助手段距（`phase0a:433` = `0.75rem`/12px；`a07:860` = `10px`——两份基线本就不一致【实测】） | 同上 | **D1-b** | 两份统一改 `14px`，并在修订注记里点明「两份基线原本就不一致，本次一并对齐」 |
| ④ | 用户气泡的**底与线**：`background: var(--s-elevated)`（≈`--card`）、`border: … p-base 5%` | `phase0a:424-425`、`a07:852-853` | **D3-c** | 改为 `--accent` 面 + `--input` 线；**结构行（`justify-end` / `max-width:85%`）不动** |
| ⑤ | 「已知偏差」表 `--muted-foreground` 暗色 4.49:1 | `docs/design-system.md`「已知偏差」节 | **D2-b** | 删行 + 追记，详见 §2.5 |

**不修订**：`--muted-foreground` / `--tool-arg` 在 `design-system.md` 语义 token 表里的**语义描述**不变
（还是「次要文字」与「工具行参数」），只有色值变——色值表若已内嵌 hex，需同步（施工时以文件实况为准）。

### 5.3 归档纪律：怎么改，才叫「不静默漂移」

三份文档三种纪律，不可混用：

**（a）设计基线 HTML（`phase0a` / `a07`）—— 就地改 + 修订注记块**
这两份是「观感对齐基线」，plantree 注册表明文「视觉 token、三列骨架、工具行与问答卡形态的**唯一基线**，
业务组件不得自行发明视觉值」。改法：
1. 在被改条款**原位**改值；
2. 在文件**顶部 masthead 区**追加一行修订记录（沿用该文件既有的 `masthead-meta` 形式），格式：
   > **修订 2026-08-18 · F5 批**：助手容器条款（`:431`）· 正文行高 1.5→1.625（`:432`）· 段距→14px（`:433`）·
   > 用户气泡面/线换 accent/input（`:424-425`）。依据 = D49（见台账）+ `docs/plans/2026-08-18-f456-readability-composer-spec.md`。
3. **被改掉的旧值必须在注记里出现**（写「1.5→1.625」而不是只写「1.625」）——
   否则下次有人对着代码复核基线时，无法判断差异是漂移还是裁定。

**（b）决策台账（`docs/plans/openchamber-chat-refactor-ledger.md`）—— append-only，新增 D49 行**
【实测】现有最高决策号是 **D48**，故本批立 **D49**。台账是 append-only，
**不得**回头改 D26 行或 D31 行。D49 行必须写清：
- 本批合并落地 **D1-b + D2-b + D3-c + D3-b**（四项 2026-08-18 用户拍板）；
- **D26 ④ 至此在代码与基线两侧同步作废**，其推翻本身发生在 **D31**（2026-08-13），D49 只是**执行与留痕**；
- 触碰的基线条款清单（= 5.2 的五行）与对应文档锚点；
- 与对比稿的**四处判定分歧**（本规格 §0.5 的 C2/C4/C5+ §2.3 的 tool-arg 裁定），
  写明「以本规格为准」——否则下一个读者会把对比稿当施工图。

**（c）plantree（`docs/plantree/plans/openchamber-chat-refactor/`）—— 只改状态不复制原文**
- `implementation-status.md:47` 的 D31 建议序里，「气泡改回右对齐（推翻 D26④）」一项标记为**已由 F5 批承载**并链到本规格；
- `roadmap.md` 增 F5/F6/F4 三行（或一行合并批次），Done 后回填 hash；
- 注册表行按「不超过一段短叙事」的归档纪律更新，**不复制决策原文，只链接**。

### 5.4 一条容易漏的：代码里的基线引用注释也要跟着改

【实测】代码注释里逐字引用基线行号的地方至少三处，改了基线不改它们就是新的漂移源：
- `MessageTimeline.tsx:699-711`「A07 `:849-855` — 16/16/4/16 corners, `--card` fill, primary-8% border … 是 P-09 落地的逐字节形态」→ `--card`/primary-8% 两处失效；
- `MessageTimeline.tsx:737-742` 同上（`T-30 P-09: A07 .fx-user-bubble (:849-855)`），其中「assistant 需要 bg-accent 来对抗 bg-card/50 的旧注」在 D3-c 后语义反转（**accent 现在归用户气泡**），必须重写；
- `chatMarkdownPolicy.ts:394-397`「`5` = 20px 是 A07 `:846` 的回合节拍」——§1.5 已要求重写。

---

## §6 F6 Composer 两行布局

### 6.1 现状与根因

【实测】`ChatComposer.tsx:2622-2630`，session 模式一行装七件：

```
<div className={composerBarClass('session')}>   // 'flex min-w-0 items-start gap-2'
  {attachButton} {textareaEl} {renderStatusLine(sessionStatusLineWrapperClass())}
  {agentPicker} {modelEffortControls} {permissionControl} {actionButtons}
</div>
```

根因不是「控件多」，而是**同一行里有两个弹性文本竞争者**（textarea 与状态行），
为此仓里长出了一整套补丁：`composerTextareaClass('session')` 的 `min-w-32 flex-[2]`
（`middleColumnLayout.ts:418-464`，三段共 30 行注释）、`sessionStatusLineWrapperClass()` 的
`flex-1 shrink basis-0 max-w-48 h-6`（`:466-508`，四段共 42 行注释）、以及父行的 `items-start`（`:205-221`）。
**拆两行之后这套补丁的前提全部消失**——这是本批最大的一笔复杂度净减。

### 6.2 目标形态

```
卡片
├─ [条件] extras 堆栈：notice · queueNotice · attachmentChips · mentionChips · 状态行(§6.4)
├─ 行 1：textarea 独占全宽
└─ 行 2：attach · agent · model · permission ····· actions(ms-auto 尾靠)
```

### 6.3 `middleColumnLayout.ts` 类装配拆分（保持可测）

| 函数 | 现状 | 新形态 |
|---|---|---|
| `composerBarClass(mode)` | `empty`→`mt-1.5 flex items-center gap-2`；`session`→`flex min-w-0 items-start gap-2` | **`session` 分支改为控件行**：`flex min-w-0 items-center gap-2`。`empty` 分支**一字不动** |
| **新增** `composerRowsClass()` | — | `flex min-w-0 flex-1 flex-col gap-2`（两行之间 8px，与行内 gap 同档，不发明新数）。**挂载点已指定**（rev.2 补，A 轨 m-10）：`ChatComposer.tsx:2605` 那个今天写死的 `className="flex min-w-0 flex-1 flex-col"` —— 该串**原样**搬进本函数并把 `gap-1`/无 gap 改为 `gap-2`，调用点改成 `<div className={composerRowsClass()}>`。⚠️ 不是新加一层 div，是**把既有的裸类串收编进类装配层**，否则 `[F6-4]` 无从断言 |
| `composerTextareaClass('session')` | `min-w-32 flex-[2] p-0 [&_textarea]:…` | `w-full p-0 [&_textarea]:…`（**撤 `min-w-32` 与 `flex-[2]`**；pierce-through 的四条 `[&_textarea]:` 一字不动） |
| `sessionStatusLineWrapperClass()` | `flex h-6 min-w-0 flex-1 shrink basis-0 max-w-48 items-center gap-1.5` | `flex min-w-0 items-center gap-1.5`（**撤 `flex-1 shrink basis-0 max-w-48 h-6` 五个补丁类**，见 §6.4） |
| `composerActionGroupClass()` | 仅 empty 模式用 | **两模式共用**：session 行 2 的尾靠也走它（`ms-auto flex shrink-0 items-center gap-1.5`） |

**行 2 可以回到 `items-center`**：`:205-221` 的 round-5 裁定之所以选 `items-start`，
是因为「textarea 是这一行里唯一高度不被钉死的孩子」。行 2 已经没有 textarea，
五个孩子全是 24px 精确盒 ⇒ `items-center` 与 `items-start` 对它们等价，取 `items-center` 更贴合语义。
**并连带撤掉** `sessionStatusLineWrapperClass()` 的 `h-6`（它存在的唯一理由就是补偿父行的 `items-start`，`:496-504`）。

### 6.4 `renderStatusLine` 槽位裁定：**迁位，不退役**（【与分诊冲突】）

分诊 F6 写「F4 落地后回合头等待行变富，composer 状态行**或可退役**；规格期定」。**本规格判定：不能退役。**

【实测】依据链：
1. `middleColumnLayout.ts:607-620`（T-31 §3.2 / F-B11）明文「`sending` **no longer shows this line at all**」——
   等待文案早在 T-31 就迁到回合头了，且 `sending` 字段刻意保留为**可选且被忽略**，专供 F-B11 断言「传了也没用」；
2. `shouldShowStatusLine`（`:621-630`）的返回条件只剩 `reading > 0 || hasStatusError || hasLargeHint`；
3. session 模式再经 `resolveIdleStatusText`（`:524-534`）过滤：`hasStatusError` 时只取 `largeHint`，
   **完整错误正文由卡片上方的红色横幅独占**（`ChatComposer.tsx:2494-2498`）。

⇒ 该槽在 session 模式**今天只可能显示两种东西**：**附件读盘 spinner** 与 **大附件提示**。
两者都是**草稿侧的附件 I/O 事实**，与 F4 的**回合侧等待事实**信息不同源、时机不重叠
（读盘发生在 send 之前）。**F4 再富也覆盖不了它**，退役即信息丢失。

**裁定：迁入卡片顶部的 extras 堆栈**（`ChatComposer.tsx:2606-2613` 那个 `mb-1 flex flex-col gap-1`），
与 `notice` / `queueNotice` / `attachmentChips` / `mentionChips` 并列。三条理由：
1. **同族**：这四件全是草稿侧的附件/队列事实，状态行是第五件，语义归位；
2. **零争宽**：行 2 从此没有任何弹性文本竞争者，F6 的核心诉求才算真正达成；
3. **补丁网络整体退役**：`basis-0` / `max-w-48` / `flex-[2]` / `min-w-32` / `items-start` / `h-6`
   这一整套（`middleColumnLayout.ts` 里 ~72 行注释所解释的 defect-B 与 F5b 两轮修复）**同时失去存在理由**。

**连带裁定**：extras 堆栈的渲染条件从 `hasComposerExtras` 扩为 `hasComposerExtras || statusRowVisible`。
`empty` 模式**不受影响**（它的状态行仍在底部控制条内，见 §6.5）。

### 6.5 empty 模式：确认复用不回归 T-30b2

【实测】empty 模式（`ChatComposer.tsx:2631-2656`）**本来就是两行**：textarea 在上，
`composerBarClass('empty')` 的底部条在下（`attach → agent → model → permission → status → actions`）。
本批对 empty 的改动**必须为零**：
- `composerBarClass('empty')` 分支不动（`mt-1.5 flex items-center gap-2`）；
- `composerTextareaClass('empty')` 不动；
- empty 的状态行**留在底部条内**（它在那一行里是唯一的弹性文本，`flex min-w-0 flex-1 items-center gap-1.5`，
  与 `composerActionGroupClass()` 的 `ms-auto` 配合正常，`:230-243` 注释已解释）——**不跟着 session 迁进 extras**；
- `composerCardClass('empty')` 不动（`rounded-md … p-2`）；
- T-30b2 §5.2 的「⊕ → agent → model → status → actions」阅读序注释（`:2639-2646`）**逐字保留**。

⇒ **两模式的状态行落点从此不同**（session 在 extras、empty 在底部条）。
这不是不一致，是两种卡片形态的必然：empty 卡是居中的大卡、底部条有富余宽度；
session 卡是贴底的窄卡、行 2 塞了五个控件。**必须在 `sessionStatusLineWrapperClass()` 头注里写明这条分工**，
否则下一个读者会「统一」掉它。

### 6.6 五个 leaf 控件的弹层定位逐个排查（分诊要求的施工前过一遍）

结论先行：**零个弹层依赖兄弟相对定位**，五个控件全部安全；但排查中发现**两处真实风险**（③ 与 ⑤）。

| # | 控件 | 弹层机制【实测】 | 迁到行 2 的影响 |
|---|---|---|---|
| ① | `ComposerAttachMenu` | Base UI `Positioner`，`align="start"` + `side={composerPopupSide(mode)}`（`ComposerAttachMenu.tsx:66-68`），锚点是**自身 trigger** | ✅ 无影响。session 恒 `side='top'`（`middleColumnLayout.ts:651-653`），行 2 位置更低，向上开更宽裕 |
| ② | `ComposerModelTrigger` | 同上（`:313-315`） | ✅ 无影响 |
| ③ | `ComposerAgentPicker` | **无弹层**——是内联分段单选（`role="radiogroup"` + **两枚** `role="radio"` 按钮，`ComposerAgentPicker.tsx:225-256`）。rev.1 写「三个」是错的（A 轨 m-4）：`AGENT_DISPLAY_NAMES` 是闭词表，只有 `claude-code` / `codex` 两项（`shared/types/agentWire.ts:48-51`）。另有一个 **locked 分支的第二个 radiogroup**（`:205-219`，单枚永选中），本批**不动它** | ⚠️ **有风险，见下** |
| ④ | `ComposerPermissionTrigger` | Base UI `Positioner`（`:310-312`） | ✅ 无影响 |
| ⑤ | `ComposerRoundButton`（actions） | 无弹层，纯按钮 | ✅ 无影响 |
| — | `@` 提及弹层（不在五件内，但同卡） | 绝对定位 `absolute left-2 w-72` + `mentionPopupPlacementClass(mode)`＝`bottom-full mb-1`（`ChatComposer.tsx:2526-2530`），锚点是**卡片**（`composerCardClass` 带 `relative`） | ✅ 语义不变（仍在整张卡上方开），但卡片变高后弹层的**绝对位置随之上移** —— 属预期，需 GUI 截图确认不越出滚动区 |

**③ 的两处真实风险**【实测】：
1. **`shrink-0` 与 `truncate` 自相矛盾**：外层是 `<span className="flex min-w-0 shrink-0 items-center gap-1">`（`:224`），
   内层空态提示是 `<span className="min-w-0 truncate text-meta text-muted-foreground">`（`:259-262`）。
   父级 `shrink-0` 意味着这个 span 永不收缩 ⇒ 子级的 `truncate` **永远不会触发**。
   今天被 textarea 的 `flex-[2]` 吸走了压力所以没暴露；行 2 五件并排后，
   `emptyStateNotice` + `Retry Host` 按钮会**把行 2 顶宽**，把 actions 挤出可视区。
2. **`emptyStateNotice` 是不定长文本**，是行 2 唯一的弹性文本源。

**裁定**：把 `ComposerAgentPicker` 的外层 `shrink-0` 改为 `min-w-0 shrink`（让 truncate 真的可用），
并在行 2 的 DOM 序上把它放在 attach 之后、model 之前（与分诊给的顺序一致）。
**若评审认为空态提示不该抢行 2 的宽**，备选方案是把 `emptyStateNotice` + `Retry Host` 一并迁入 extras 堆栈
（与 §6.4 同一去处），行 2 只留三段单选芯片。**本规格取前者**（改 `shrink`），理由：空态是 Host 不可用的罕见态，
此时 actions 本就不可用，被挤压的代价可接受；迁入 extras 会让「Host 挂了」这条提示离控件太远。

### 6.7 必然连带：42px 静息高度契约与 pill 圆角**双双失效**（分诊未点名的一项）

这是本节最容易被漏、且**会让一整组断言按构造必红**的连锁反应。

【实测】`composerCardClass('session')` 今天返回
`relative rounded-[21px] border border-border bg-card focus-within:border-input flex min-h-10.5 items-center gap-2 p-2`，
其中：
- `min-h-10.5` = **42px**，由 `composerFollowHeightBreakdown()`（`:185-195`）作为**算术**给出：
  border 2 + padding 16 + content 24 = 42，并有断言交叉核对类串与算术（`middleColumnLayout.test.ts:243-289`）；
- `rounded-[21px]` = **42 / 2**，注释（`:166-172`）明说「21 === `composerFollowHeightBreakdown().total / 2`，
  在 42px 静息高度下与 pill 像素等同」，且有断言核对 `21 × 2 === 静息高度`（`:290-307`）。

两行形态下静息高度变为：**border 2 + padding 16 + 行1 24 + 行间 gap 8 + 行2 24 = 74px**。
于是：
- `min-h-10.5` 与 `composerFollowHeightBreakdown()` **必须重算**（新增 `rows` / `rowGap` 两个字段，
  保持「算术可断言」而非「类串里有某个字符串」的既有工法）；
- `rounded-[21px]` **必须退役**。**理由 rev.2 已换**（A 轨 M-5 纠错成立，结论保留）：
  - ❌ rev.1 的说法「`:137-149` 写明 33–37px 是 runaway，而 74/2 = 37px 正落在那个区间」**误读了原注**。
    原注说的是 **`rounded-full` 会被 CSS clamp 到 h/2，从而随 textarea 长高一路滑进 33–37px 弧**；
    仓里选固定 `21px` 恰恰是**为了不发生这件事**。固定值不会随高度走，所以「37px 落在 runaway 区间」这句
    对一个固定值来说不成立。
  - ✅ **真正的理由是推导链断了**：`:170-172` 的注释把 21 定义为
    `` 21 === composerFollowHeightBreakdown().total / 2 ``，并有断言交叉核对（`middleColumnLayout.test.ts:290-307`）。
    静息高度变 74px 后，照这条链推出的值是 **`rounded-[37px]`** —— 而 37px 是**手写的固定任意值**，
    既不是 token 分档（`design-system.md` 禁任意值），也不再对应任何「pill」心智：
    一张两行高的卡不是药丸形，半高圆角只会让它读起来像一个被拉长的胶囊。
  - ⇒ **不是「把 21 改成 37」，是整条 pill 推导链退役**：session 卡改 **`rounded-md`**（12px），与 empty 卡一致。
    `[F6-1]` 因此要断言类串**不含** `rounded-[`（任意值圆角彻底离场），而不是断言某个新数字。

**连带简化**：`composerCardClass(mode, opts?: { hasExtras?: boolean })` 的 `opts` 参数**唯一用途**就是切 radius
（`:173` `const radius = opts?.hasExtras ? 'rounded-md' : 'rounded-[21px]'`）。
radius 恒为 `rounded-md` 后，**`opts` 参数整个退役**，调用点 `ChatComposer.tsx:2524` 随之简化。
`hasComposerExtras` 变量本身仍需保留（它还要决定 extras 堆栈渲不渲染，§6.4）。

**另一处连带**：卡片类串里的 `items-center` 应改为**去掉**（默认 `stretch`）——
两行形态下卡内唯一在流子元素是一整列（`ChatComposer.tsx:2605` 的 `flex min-w-0 flex-1 flex-col`），
纵向居中它没有意义，且 extras 出现时会产生歧义对齐。
⚠️ **这会让 `middleColumnLayout.test.ts:255` 的 `expect(cls).toContain('items-center');` 按构造必红**
（rev.1 漏列，A 轨 M-6）——它就在 F-A2 那条用例**内部**，不是独立一条，
所以 §8.3 里 F-A2 的处置是「改值 **+ 删一行断言**」，不是单纯改数字。

**`opts` 退役的编译期影响面（rev.2 补，A 轨 M-6）**：`composerCardClass` 的签名从
`(mode: MiddleColumnMode, opts?: { hasExtras?: boolean })` 收为 `(mode: MiddleColumnMode)`，
连带三处：① 唯一调用点 `ChatComposer.tsx:2524` 的第二实参必须删（**留着就是 TS2554 参数过多，编译中断**）；
② `middleColumnLayout.test.ts:308-331` 的 F-A2b 组传第二实参的调用全部失效（§8.3 已列退役）；
③ 函数体内 `:173` 的 `const radius = …` 三元删除、`:174` 模板串里的 `${radius}` 换成字面 `rounded-md`。
⇒ 这三处**必须同一次提交内完成**，否则 `pnpm typecheck` 门直接不过。

⚠️ 这一组变更会让 `middleColumnLayout.test.ts` 的 **F-A2 / F-A2b / F-A21 三组共约 5 条断言按构造必红**，
处置见 §8.3——其中 F-A21 两条必须**退役换新**而不是改数字（它们钉的是「pill 的推导链」，这条链本身不再成立）。

---

## §7 F4 等待行

### 7.1 文案形态总表（**七个**分支，两个改动：`awaiting` 换词、`stalled` 新增）

| 分支 | 判据 | 新文案 | 相对现状 |
|---|---|---|---|
| `handshake` | `phase === 'handshake'` | `Starting Agent Host… · {N}s` | **逐字不动** |
| `awaiting` 常态 | `< SLOW`，无附件 | `{Verb}… · ↑ {chars} chars{ · ↓ {tok}} · {N}s` | **换词 + 加计数 + 撤 `(up to Ns)`** |
| `awaiting` 带附件 | `< SLOW`，有附件 | `{Verb}… · ↑ {chars} chars{ · ↓ {tok}} · Sent {size} · {N}s` | 同上 |
| `retrying` | 任一 awaiting 分支 + `retry` | 上述 + ` · Retry {a}/{m}` | 后缀位置不动 |
| `slow` | `SLOW <= elapsed < STALLED` | `Still waiting · {N}s{retry} — gateway latency varies. Stop to abort.` | **逐字不动**（F2 仲裁档 §8.3 已逐句审读通过；判据由「>= SLOW」收窄为区间） |
| **`stalled`** | `>= STALLED_HINT_SECONDS` | `Still waiting · {N}s{retry} — past the usual range; no reply and no error yet. Stop to abort.` | **新增档**（rev.2；rev.1 写「与 slow 文案完全相同」，按构造违反 kind/copy 同源，见 §7.5-a） |
| `streaming` | `hasBlocks` | `✽ {clock} · ↓ {tok}` | **不动**（D33 形态，`✽` 由 `.tsx` 加） |

**为什么俏皮动词只进 `awaiting` 一个分支**：
- `handshake` 分支的语义是「还没传输」，换成拟人动词会重新引入 `:299-306` 注释专门防的那条谎
  （「Sent 152 KB」在握手期就是假话，同理「Pondering」在没连上时也是）；
- `slow` 分支的文案已被 F2 §8.2 逐句审读并裁定「逐字保留」，且 F2 计划用 `[TS-1]` 钉住它含 `Stop to abort.`
  （声明目的就是**防 F4 误删**）——本规格照办；
- `streaming` 分支已经有真事实（时钟 + token 数），不需要装饰。

### 7.2 裁定：`(up to Ns)` 从句**退役**（F2 仲裁档 §8.4 移交本批判断；**已决，非开放问题**）

F2 把预算源换成 `SEND_SILENCE_CEILING_MS`（300s 量级），于是文案会从 `(up to 45s)` 变成 `(up to 300s)`。
**本规格判定：整个从句退役，不显示任何预算数字。** 三条理由：
1. **语义已经变了**：F2 之后这个数字不再是「回复预算」，而是「静默上限，**到期也不杀回合**」（F2 §4.4）。
   英文 `up to N` 读作「最多等这么久就会有结果」——正是 F2 明确不再承诺的事。
2. **与既有纪律冲突**：`attachments.ts:309-312` 明写「Deliberately **never predicts a finish time**：
   实测延迟与负载无关且跨日波动约 8 倍，假数字比没有更糟」。`(up to 300s)` 就是一个软性的完成时间预测。
3. **信息未丢失**：「还要等多久」由 45s 的分支转档（措辞切到 `Still waiting`）与常驻的 Stop 按钮承载，
   两者都是**可执行**的信息，比一个不再兑现的数字有用。

⇒ `composerSendingLine` 的 `budgetMs` **入参**退化为未使用。**不删该参数**：保留并标注为「接受但忽略」，
沿用 `shouldShowStatusLine` 对 `sending` 的同款处理（`middleColumnLayout.ts:617-620`：
「删掉它，这条断言所守的回归就变得不可表达」）——留着才能断言「传了预算也不会出现在文案里」。

⚠️ **但函数体内的局部变量必须删**（rev.2 补，A 轨 m-11）：`attachments.ts:340`
`const budgetSeconds = Math.round(input.budgetMs / 1000);` 在两条 `(up to ${budgetSeconds}s)` 退役后
成为**未使用局部变量** ⇒ `pnpm lint` 的 `no-unused-vars` 必红。
**「保留入参」与「删局部」是两件事，不可混为一谈**：入参是断言 `[F4-4]` 的载体，局部变量只是它的旧消费者。
入参的 TS 侧不会报 unused（对象字面量属性不受该规则约束），所以只需删 `:340` 这一行。

### 7.3 俏皮动词词表与轮换规则

**词表（12 个，全英文，与周边 UI 一致）**：

```
Pondering · Percolating · Ruminating · Noodling · Mulling · Simmering
Marinating · Cogitating · Deliberating · Brewing · Puzzling · Contemplating
```

**选词纪律（四条，评审按此逐词核）**：
1. **不得声称对端在做什么具体的事**（禁 `Reading your files` / `Searching` 之类——那是工具行的职责，
   而且在 `awaiting` 分支按定义还没有任何 block 到达，说什么都是猜）；
2. **不得暗示进度或剩余时间**（禁 `Almost there` / `Nearly done`）；
3. **不得带负面或指责语气**（禁 `Still nothing…`）；
4. 全部是**不及物、进行时**的中性动词——它们描述的是「有事情在发生」这个可验证的事实
   （请求确已在途：`sawUserEcho` 与 F2 的活性帧都能证明），不是对端的心理活动。

**轮换规则（纯函数，零随机、零状态）**：

```
VERB_ROTATION_SECONDS = 6
index = Math.floor(max(0, floor(elapsedSeconds)) / VERB_ROTATION_SECONDS) % VERBS.length
```

- **纯 `elapsedSeconds` 的函数** ⇒ `composerSendingLine` 保持纯函数，同参同出，可逐秒真值表化；
  **禁止** `Math.random()` / `Date.now()`（§8 有源文扫描断言）。
- **6 秒一换**：够读完，又不至于让一次等待里只见一个词。
- **不重复不变量**：该分支的生命周期是 `[0, SLOW_WAIT_HINT_SECONDS)` = `[0, 45)`，
  最多出现 `ceil(45 / 6) = 8` 个词 < 12 ⇒ **一次等待里动词永不重复**。
  这条要写成**跨模块断言** `Math.ceil(SLOW_WAIT_HINT_SECONDS / VERB_ROTATION_SECONDS) <= VERBS.length`
  ——如果 F2 之后有人上调阈值，这条会**立刻变红**，把「动词开始重复」这个静默退化变成显式失败。

### 7.4 ↑ 与 ↓ 两个计数的接线

**↓ 输出 token（接入 `awaiting`）**：数据已经在渲染端。
【实测】链路：Host `usage.updated{interim}` → `contextSurfaceModel.ts:808-825` `foldInterimTokensDisplay`
→ `turnTokensDisplay` → `MessageTimeline.tsx:246-248` 的窄选择器 → `ChatTurn` 的 `outputTokensDisplay` prop
→ `deriveTurnStatus`（`:1012`）。今天 `turnStatus.ts:101-112` **只在 `hasBlocks` 的 streaming 分支消费它**。
改法：把 `outputTokensDisplay` 透传进 `composerSendingLine`，由后者在 awaiting 分支追加 ` · ↓ {tok}`。
**清理时机不用改**：`clearTurnTokensDisplay`（`contextSurfaceModel.ts:843-860`）已在 `session.status(idle/failed)`
与 `message.completed` 两处清零，awaiting 分支自动跟随。

**↑ 发送字符数（新字段，纯渲染端）**：
- `src/renderer/stores/turnSendStatus.ts` 的 `TurnSendStatus` 接口（`:41-52`）加 `promptChars: number`；
- 写入点 `ChatComposer.tsx:1117-1126` 的 `beginTurnSend({...})`，取值 **`[...committed.text].length`**
  （**码点**而非 `.length` 的 UTF-16 码元：CJK 在 BMP 内两者相同，但 emoji 会被 `.length` 数成 2，
  给用户看的计数不该有这种偏差。与 `CHAT_HIGHLIGHT_MAX_CHARS` 刻意用码元的理由**相反**且不矛盾——
  那里量的是分词器成本，这里量的是「我打了多少字」）；
- 取值必须来自 **`committed`**（提交点快照）而非实时 `value`——与同处 `attachmentCount`/`attachmentBytes`
  取 `drafts` 而非实时状态的理由逐字相同（`:1090-1097` 注释）；
- 读出点 **有两个，不是一个**（rev.2 补，B 轨第 7 条；rev.1 只列了第一个）：

| # | 消费者 | 锚点【实测 `d9281d0`】 | 传法 | 漏了会怎样 |
|---|---|---|---|---|
| ① | `ChatTurn` 的 attached 回合 | `MessageTimeline.tsx:1003-1020` `const status = deriveTurnStatus({` | `promptChars: sendStatus?.promptChars ?? 0` | —— |
| ② | **`PendingTurnHead`** | `MessageTimeline.tsx:1262-1271`（函数 `:1255`），已持有完整 `sendStatus` | `promptChars: sendStatus.promptChars`（**非可选**，此处 `sendStatus` 类型即 `TurnSendStatus`） | **最早可见的那个窗口没有 `↑`**——用户 echo 回来之前的整段等待都缺计数；若接口改为必填则**直接类型报错**，属编译期中断 |

  **`?? 0` 且 0 时不显示 ↑**（仅①）——「会话已在运行但本窗口没有快照」的既有降级路径（`:1000-1002` 注释）
  不能因此多出一个假的 `↑ 0`。②**不需要** `?? 0`：`PendingTurnHead` 的 `sendStatus` 是必填 prop
  （`:1259` `sendStatus: TurnSendStatus;`），挂载点 `:504` `<PendingTurnHead sendStatus={pendingSendStatus} retry={sessionRetry} />`
  只在 `pendingSendStatus != null` 时渲染。

  ⚠️ **为什么 ② 是「最早可见窗口」**：`PendingTurnHead` 的存在条件就是「send 已发出、用户 echo 尚未回来」
  （`:1250-1254` 头注：`Head slot for a send whose turn has not been echoed back yet (§3.3)`）。
  `↑ {chars}` 描述的正是**刚发出去的那条 prompt**——它在这个窗口里信息密度最高，而 ① 的窗口里用户已经能看见自己的气泡了。
  ⇒ **只接 ① 就等于把这个字段接在了它最没用的地方。**

**单位词的不对称是有意的**：`↑ 428 chars` 带单位、`↓ 1.8k` 不带。
理由：`turnStatus.ts:144-151` 明令 ↓ 是 Host 从流式增量估出来的**估算峰值**，
「只能作为粗略的进行中指示，**绝不可呈现为权威 token 数**」——给它补一个 `tokens` 单位词会**抬高它的权威观感**，与该纪律相悖；
↑ 是渲染端自己数出来的精确值，标单位零风险，且正好把两个箭头区分开。**这句话必须写进注释**。

**格式化函数下沉（防循环依赖）**：
`formatTokenCount` 今天在 `turnStatus.ts:152-155`，而 `turnStatus.ts:1` 已经 `import … from './attachments'`。
让 `attachments.ts` 反向 import 它就是**循环依赖**。
⇒ 新建 `src/renderer/components/chat/countFormat.ts`，放 `formatTokenCount` 与新的 `formatCharCount`；
`attachments.ts` 与 `turnStatus.ts` 各自从它 import；`turnStatus.ts` **保留 re-export**
（`export { formatTokenCount } from './countFormat';`）以免动既有 import 与 `turnStatus.test.ts:6` 的引用。
`formatCharCount` 与 `formatTokenCount` 同形（`<1000` 原样，`>=1000` 取 `x.xk`），共用同一实现。

### 7.5 `slow` 色阶处置（F2 移交②）——两个问题，不是一个

【实测 HEAD `d9281d0`】`turnStatusToneClass`：`MessageTimeline.tsx:1388-1392`
（rev.1 写的 `:1372-1377` 是 F10 前行号；**F2 仲裁档 §8.4 同日已订正为 `:1389`**，rev.1 未取该订正）：

```
// MessageTimeline.tsx:1387  /** Warning past the slow-wait threshold, destructive on failure; muted otherwise (from `turnHeadClass`). */
// :1388  function turnStatusToneClass(kind: TurnStatus['kind']): string | false {
// :1389    if (kind === 'slow') return 'text-warning';
// :1390    if (kind === 'failed') return 'text-destructive';
// :1391    return false;   // 其余走 turnHeadClass() 自带的 text-muted-foreground
// :1392  }
```

唯一调用点：`MessageTimeline.tsx:1380` `<span className={cn('min-w-0 truncate', turnStatusToneClass(status.kind))} title={text}>`。

F2 仲裁档 §8.4 指出的问题是**告警疲劳**：预算抬到 300s 后，「首 token 慢于 45s」会成为长 prompt / 长 thinking 的**常态**，
一个持续数分钟的警告色等于没有警告。本轮补出**第二个、更根本的问题**（【与 F2 建议的差异】，见 §0.5 C8）：

> `--warning` 与 `--primary` **逐位同色**【实测】：亮 `globals.css:176` `oklch(0.5665 0.1523 45.02)` = `--primary` 亮值；
> 暗 `:223` `oklch(0.6576 0.1539 49.3)` = `--primary` 暗值。`design-system.md` 自己就写着
> 「**不要用 `warning` 代替 amber**——Flexoki 的 `status.warning` 与 `primary.base` 逐位同色，用了会跟品牌橙撞」。
> ⇒ 今天的 slow 态涂的其实是**品牌橙**。

**裁定（三条）**：
1. **`slow`（>= 45s）降级为 muted**：`turnStatusToneClass('slow')` 返回 `false`，走 `turnHeadClass()` 自带的
   `text-muted-foreground`。D2-b 提档后它是 7.20 / 6.70，**读得清清楚楚，不需要靠颜色喊**——
   这正是 F5 与 F4 合批的红利：可读性上去了，就不必再用颜色补偿。
2. **新增第二档 `stalled`**：阈值 `STALLED_HINT_SECONDS = 180`，`TurnStatusKind` 加 `'stalled'` 成员，
   **并自带一档可辨措辞**（见 §7.5-a）。
3. **`stalled` 的色**：仍取 `text-warning`。承认它 ≡ 品牌橙，并在注释里写明**为什么此处可接受**：
   回合头内没有任何链接（`text-primary` 的唯一常规用途），且这是整条时间线上唯一需要抢眼的时刻。
   **不为它新增 token**——新增语义色要走 `@theme` 双写（`design-system.md` 的「新增 token 的强制动作」），
   本批不值得为一个色阶开这个口子。
   ⚠️ **这是一次知情的词表偏离**（rev.2 补，评审 A 轨 m-5）：`design-system.md` 明写「不要用 `warning` 代替 amber」，
   本批**知情仍用**。⇒ 必须**上报而非默认**：① 写进 D49 台账行的「知情偏离」栏；② 在 `turnStatusToneClass` 头注
   逐字写明「已知它 ≡ `--primary`，此处可接受的三条前提（回合头无链接 / 唯一需抢眼时刻 / 不值得开新 token）」；
   ③ 进 §10.2 Q8 供评审复核。**不得只在本规格里说一句就算完**——词表禁令的违反必须在代码与台账两侧都有痕。

#### 7.5-a `stalled` 的措辞档（rev.2 整段重写 —— rev.1「文案与 slow 完全相同」按构造违规）

**rev.1 的错误**：写「文案与 `slow` 完全相同（只换语气载体，不换措辞）」。
【实测】这**按构造违反** F2 仲裁档 §8.3 末段刚立的不变量与 `turnStatus.ts:115-117` 的既有源注：

> `` // The threshold is imported, never re-declared: `composerSendingLine` keys ``
> `` // its own wording switch off the same constant, so `kind` and copy can only ``
> `// ever flip together.`

同源的定义是「kind 与 copy **只能一起翻**」。rev.1 的形态是 **kind 在 180s 翻、copy 不翻** —— 同源关系断裂，
而这正是 F2 仲裁档驳回 B 轨「给 slow 判定加附件条件」时用的同一条理由。**不能自己犯同一个错。**

**裁定：取方案 (a) —— `stalled` 有自己的措辞档，两档阈值同源导入。**

`attachments.ts` 的 `composerSendingLine` 在 `handshake` 分支之后、`slow` 分支之前插入一个新分支：

| 档 | 判据 | 文案 | 相对现状 |
|---|---|---|---|
| `stalled` | `elapsed >= STALLED_HINT_SECONDS` | `Still waiting · {N}s{retry} — past the usual range; no reply and no error yet. Stop to abort.` | **新增** |
| `slow` | `SLOW <= elapsed < STALLED` | `Still waiting · {N}s{retry} — gateway latency varies. Stop to abort.` | **逐字不动** |

`turnStatus.ts` 的 `deriveTurnStatus` 对称地插一行（**同两个常量、同一顺序**）：

```
if (elapsed >= STALLED_HINT_SECONDS) return { kind: 'stalled', text };
if (elapsed >= SLOW_WAIT_HINT_SECONDS) return { kind: 'slow',    text };
```

⇒ **同源不变量不但保住，还被加强**：从「一个常量对一处措辞开关」变成「两个常量对两处措辞开关，两侧同序」。
`turnStatus.ts:115-117` 的源注必须**整段重写**为复数形态（见 §9.3 的文件行，改动理由：单数「the threshold」已成假话）。

**`stalled` 措辞的四条自证**（沿用 F2 仲裁档 §8.3 的死文案逐句审读工法，评审按此逐句核）：
1. `Still waiting` —— 与 `slow` 同首语，是**同一件事的更深一档**而非另一件事，用户不会以为状态跳变；
2. `past the usual range` —— 不预测完成时间（`attachments.ts:309-312` 纪律），只陈述「已越过常见区间」这个可由阈值定义的事实；
   **不写具体秒数**（否则 §0.2 的「不得把阈值数字写死进文案模块」被破）；
3. `no reply and no error yet` —— 两条都是**可验证事实**：本分支要求 `hasBlocks === false`（`turnStatus.ts:102` streaming 优先级更高），
   且 `failed` 是更高优先级的独立 kind，走到这里就意味着没有 `session.failed`。它替下了 `gateway latency varies`
   ——那句在 180s 时已不再解释任何东西；
4. `Stop to abort.` —— **逐字保留**，`[TS-1]` 的承重半边（F2 §9 的声明目的就是防 F4 误删）。

**逐字文案以评审审读结论为准**：上表是本规格的提案，若评审对措辞有异议，可改词但**不得改结构**
（首语 `Still waiting`、无秒数预测、尾句 `Stop to abort.` 三者是不变量）。

**阈值常量归属**：`STALLED_HINT_SECONDS` 定义在 `attachments.ts`，与 `SLOW_WAIT_HINT_SECONDS`（`attachments.ts:297`，
关键原文 `export const SLOW_WAIT_HINT_SECONDS = 45;`）**同处**。
它**不是超时阈值**（不触发任何 abort / unbind / 状态变更），只是**展示阈值**，故不越 §0.2 的 F2 边界。
配一条本地不变量：`SLOW_WAIT_HINT_SECONDS < STALLED_HINT_SECONDS`。

#### 7.5-b `[TS-1]` 的分段化（跨批次协调）

F2 §9 / §12.1 计划新增的 `[TS-1]` 断言原文是
「`elapsedSeconds >= SLOW_WAIT_HINT_SECONDS && !hasBlocks` 时 `kind === 'slow'`」。
本批引入 `stalled` 后，**该断言在 elapsed >= 180 时按构造为假**。
处置：**把 `[TS-1]` 修订为分段式**——
`SLOW <= elapsed < STALLED → 'slow'`、`elapsed >= STALLED → 'stalled'`，
并把它真正承重的那半（**两种 kind 的文案都必须含 `Stop to abort.`**）**扩到两个分支**，一个字都不能少。
再补一条 `[TS-1b] kind/copy 同源`：对 `44 / 45 / 179 / 180` 四个秒点，
断言 `deriveTurnStatus(...).kind` 与 `composerSendingLine(...)` 的措辞**在同一个秒点一起翻**
（kind 变的那一秒，copy 必须也变；kind 不变的秒点，copy 必须也不变）——这是 F2 仲裁档 §8.3 点名要立的那条回归断言。

按 §0.4 的序约束，**本批片 ④ 排在 F2 S3 之后**，故这次修订由**本批执行**；
若序被打乱由 F2 先落地并已写入 `[TS-1]`，则先落地方**不得因为「测试会红」而放弃 `stalled` 或放弃 `[TS-1]`**，
改由后落地方按本节修订。

#### 7.5-c 退路 (b)（仅在 (a) 被证伪时启用，须登记 as-built 偏差）

若施工中发现 (a) 不可行（例如评审判定 `stalled` 措辞无论怎么写都会与 F2 审读结论冲突），
退路是：**放弃 `stalled` 档，只保留 `slow` 的色阶降级**（`turnStatusToneClass('slow')` → falsy），
`TurnStatusKind` 不加成员、`STALLED_HINT_SECONDS` 不引入。
代价：告警疲劳的另一半（「180s 之后需要一个更强信号」）本批不解，转另立票。
**启用条件**：必须在本规格追加 §7.5-d「stalled 否决记录」写明证据，并登记为 **as-built 偏差候选**，
同步删除 `[F4-6]` 的 `stalled` 半边与 M-26 变异。**不得静默降级**。

### 7.6 红卡中英混排（F2 移交③）——**降级为待拍板，本批不擅改**

【实测】F2 §2 新发现⑤ 引的位置有行漂移，实际中文串在 `MessageTimeline.tsx:557`：
`已产内容保留。可从下方输入框重发上条消息。`

但本轮发现这**不是一处孤立的错字**：`authRequiredError.ts:57-60` 的 `AUTH_REQUIRED_ERROR_VIEW`
（`title: '需要重新登录'` / `message: '登录状态已失效，请重新登录后再试。'` / `actionLabel: '重新登录'`）
是 **D47 S5 §3 有意引入的中文用户可见文案**，`MessageTimeline.tsx:519-529` 的注释明确说明了这个设计意图。

⇒ 本仓**同时**存在「控件/状态文案全英文」与「错误说明有意中文」两套口径，而**全局 UI 语言口径从未被裁定**。
**裁定：本批不擅自改语言。** 处置：
1. 记入 §10 open questions，作为需要用户拍板的一条（全英 / 全中 / 英控件 + 中错误说明）；
2. 本批**只守内部一致性**：§7.3 的动词表用英文（与它所在的那条状态行其余部分一致），**不新增任何中文文案**；
3. F2 移交③ 状态改为「**已定性、待全局语言口径拍板后统一执行**」，不在本批闭环。

### 7.7 `attachments.test.ts` 逐字文案断言重写清单

【实测 HEAD `d9281d0`】`__tests__/attachments.test.ts` 的 `describe('composerSendingLine (T-18 B2)')`（`:324`）共 **11 条**。
**行号 rev.2 重取**（rev.1 各行有 1~4 行漂移，A 轨 m-7）——下表列的是**每条 `it(` 的当前起始行**：

| `it(` 行 | 用例 | 处置 |
|---|---|---|
| `:325` | text-only：`'Waiting for Agent Host reply · 12s (up to 45s)'` | **退役换新** → 断言形态而非整句：含 `↑`、含 `· 12s`、**不含** `up to`、且首词 ∈ `VERBS` |
| `:337` | 带附件：`'Sent 152.0 KB · waiting for reply · 31s (up to 75s)'` | **退役换新** → 含 `Sent 152.0 KB`、含 `↑`、不含 `up to` |
| `:349` | slow：`'Still waiting · 62s — gateway latency varies. Stop to abort.'` | **逐字保留，一字不改**。⚠️ F2 仲裁档 §8.1 点名：**这条是 slow 分支今天可达的证据**（附件路径预算 75/105/180s），**不得当陈旧钉住退役**；62s < 180 ⇒ 新增 `stalled` 档后它仍落在 slow 区间，**不受影响** |
| `:361` | 「永不说 Uploading」 | **保留**，并**扩为对全词表的属性断言**：12 个动词逐个跑一遍，无一含 `upload` |
| `:372` | 握手不谎称已送达 | **保留**（`'Starting Agent Host… · 3s'` 逐字不动） |
| `:387` | 握手过阈值仍是握手措辞 | **保留**。⚠️ 若该用例用的 elapsed >= 180，须复核它仍走 handshake 分支（handshake 判据在最前，不受新档影响） |
| `:401` | retry 后缀不吞基础文案 | **改值**（基础文案换词），断言重点改为「retry 后缀存在 **且** 首词仍是动词」 |
| `:414` | 带附件行也追加 retry | **改值**，同上 |
| `:427` | 过阈值仍追加 retry | **逐字保留**（该用例的 elapsed 在 slow 区间内，须施工时复核 < 180；若 >= 180 则改为断言 stalled 措辞 + retry 后缀） |
| `:439` | 无 retry 时无后缀，且两种写法等价 | **保留**（与措辞无关的纯结构断言） |
| `:460` | 握手期不显示 retry | **保留** |

**新增 6 条**（详见 §8.4 的编号清单）：动词轮换的确定性、不重复不变量、`↑`/`↓` 的出现与省略条件、
`budgetMs` 被忽略、无随机源。

---

## §8 静态不变量、测试与变异计划

### 8.1 总原则

**（a）「布局缺陷只在截图里显形」的教训要在本批兑现。**
本批有三处纯视觉改动（气泡对齐 / 助手容器 / composer 两行），单测看不见渲染结果。
应对不是「多截图」，而是把**能静态表达的结构承诺全部静态断言掉**，
让截图只用于验证**静态断言表达不了的那部分**（真实换行、真实遮盖、真实弹层位置）。
每条新增断言都必须能指出「它抓的是哪个具体退化」，抓不出退化的断言不写。

**（b）退役换新 > 改数字。** 凡是断言的**承重命题本身**不再成立的（F-C4 两档绑定、pill 推导链、D26 ④ 满宽），
一律退役并写新的承重行；只有命题成立、只是取值变了的（20→24、`leading-normal`→`leading-relaxed`）才改数字。
按变异纪律，改数字的断言在变异验证里咬合力不变，退役换新的必须重新验证咬合。

**（c）本批共触及 9 份测试文件（8 份改 + 1 份新建）** —— rev.2 订正，rev.1 在「7 份 / 8 份」之间自相矛盾且**漏了一份必红**：

| # | 文件 | 片 | 性质 |
|---|---|---|---|
| 1 | `__tests__/chatMarkdownPolicy.test.ts` | ② | 改值 4 组 + 退役换新 1 组 + 新增 2 条 |
| 2 | **`__tests__/chatMarkdownRender.test.ts`** | ② | **改值 1 条（`:300`）** —— rev.1 完全漏列（B 轨第 3 条），不改则全量门禁必挂 |
| 3 | `__tests__/messageTimelineWiring.test.ts` | ② | 改值 1 条 + 退役换新 1 条 + 新增 4 条（含 AST 工法扩建） |
| 4 | `__tests__/chatTimelineLayout.test.ts` | ② | 新增 1 组 |
| 5 | `__tests__/middleColumnLayout.test.ts` | ③ | 改值 2 组 + 退役换新 3 组 |
| 6 | `__tests__/composerFormStatic.test.ts` | ③ | **工法扩建**（现只有目录扫描，需加 JSX AST）+ 新增 3 条 |
| 7 | `__tests__/attachments.test.ts` | ④ | 退役换新 2 条 + 改值 2 条 + 新增 6 条 |
| 8 | `__tests__/turnStatus.test.ts` | ④ | 新增 1 组（分档）+ 与 F2 的 `[TS-1]` 分区共存 |
| 9 | **新建** `styles/__tests__/tokenValues.test.ts` | ① | `[D2-1]` 四条 |

（若候选 B 被启用还要再动 `__tests__/toolRowArg.test.ts` 与 `lib/__tests__/utils.test.ts` —— 但它已降为仅历史存档，见 §2.3。）

### 8.2 F5 层：测试合同变更

**D1-b（散文层）** —— 详表见 §1.6。摘要：`chatMarkdownPolicy.test.ts` 改值 4 组、退役换新 1 组（`:650-657`）、
新增 2 条（`[D1-1]` 解耦正向证据 / `[D1-2]` 仍只有两档）；`messageTimelineWiring.test.ts` 改值 1 条（`:407`）、
新增 1 条（`[INV-D1-1]` 三散文点一致 + 骨架未被带跑）。

**D2-b（token 层）** —— 【实测】**现有测试零红**（§2.4-c：仓里没有任何色值/对比度扫描测试）。
⇒ 必须**新增**一条，否则这次改动完全无网：

- `[D2-1] globals.css 的四个次要层数值锁`（建议落 `src/renderer/styles/__tests__/tokenValues.test.ts`，新建）：
  读 `globals.css` 源文，正则取 `:root` 与 `.dark` 的 `--muted-foreground` 字面量、以及 `--tool-arg` 的
  `color-mix(in oklab, var(--muted-foreground) N%, var(--background))` 中的 `N`，断言：
  ① 两个 OKLCH 值逐字等于本规格 §2.1 表中的目标值；② `N === 85`；
  ③ `--tool-arg` 的定义**仍然是对 `--muted-foreground` 的派生**（正则里必须出现 `var(--muted-foreground)`）——
  这条抓的是「有人把 tool-arg 改成独立字面量，从此两个色不再联动」的静默漂移；
  ④ `.dark` 里**没有**第二条 `--tool-arg` 声明（`globals.css:190-194` 的「声明一次」设计意图）。
  **不在测试里做 sRGB/WCAG 计算**：那会把一份色彩科学实现搬进测试并需要自证，性价比不对；
  数值论证留在本规格 §2，测试只锁「文件里写的确实是被论证过的那个值」。

**D3-c（用户气泡）** —— `messageTimelineWiring.test.ts`。

⚠️ **工法必须先升级：现有投影 helper 证明不了「类挂在哪个节点上」**（rev.2 重写，两轨同时命中：A 轨 m-8 / B 轨第 5 条）。

【实测】`expectCalled`（`:181`）只检查 token 是否出现在**整份** `MessageTimeline.tsx` 的 call/JSX-attribute 投影里；
`expectUnwired`（`:196`）只检查 token 是否在**整份**可执行源文里彻底消失。**两者都没有「范围」参数**。后果：

- `expectCalled('flex justify-end')` / `'max-w-[85%]'` / `'bg-accent'` —— 把它们放到**文件里任意其他 JSX 元素**上都能通过，
  证明不了它们属于 `UserBubble`；
- rev.1 写的「在 `UserBubble` 范围内 `expectUnwired('bg-card')`」**语法上不存在**——直接用会要求
  整份 `MessageTimeline.tsx` 都没有 `bg-card`，与所述合同不是一回事（`bg-card` 在本文件别处也可能出现）；
- 附件芯片断言同样只证明串存在，不证明它在附件 `<span>` 上。

⇒ **新增 AST 节点级定位工法**（本批的工法投资，落 `messageTimelineWiring.test.ts` 的 helper 区，与既有投影并存）：

```
nodeClassName(fnName, path) -> string
   1. 用 TypeScript AST 定位顶层函数声明 `fnName`（如 `UserBubble`）
   2. 沿 path 下钻到具体 JSX 元素（如 ['article'] / ['article','div'] / ['article','div','span']）
   3. 返回该元素 className 属性的**字面量文本**（非字面量则抛错，防「藏进变量里躲检查」）
```

在此工法上，D3-c 组改写为：

| 处置 | 内容 |
|---|---|
| **退役换新** `:449-456` `it('D26 ④: the user bubble is full width')` | 语义反转为 `[D3-1] 用户气泡右对齐收窄`。断言全部走**节点级**：① `nodeClassName('UserBubble', ['article'])` **逐字等于** `'flex justify-end'`；② 内层 bubble `<div>` 的 `cn()` 首实参**含** `min-w-0` 与 `max-w-[85%]`；③ 第二实参**逐字等于** `'rounded-br-xs border-input bg-accent'`；④ 正文 `<p>` 的 className **含** `break-words` 与 `leading-relaxed`。并**保留原有的** `expectCalled('turnFooterClass()')`（它证明 footer 的右对齐是另一个元素，没被这次改动吞掉） |
| **不改** `:226` 元断言 | 它要求字符串字面量 `rounded-br-xs` 存活于负向投影——该串本批仍在，元断言继续成立 |
| **新增** `[D3-2] 气泡不再坐在 card 上` | **`UserBubble` 函数体范围内**（AST 子树，不是全文件）不出现 `bg-card`——抓「改了对齐忘了改底色」。这条**必须**用新工法，全文件 `expectUnwired('bg-card')` 会误伤别处 |
| **新增** `[D3-3] 附件芯片描边跟随` | `nodeClassName('UserBubble', ['article','div','div','span'])` **含** `border border-input`、**不含** `border-border`（§3.4 ③） |
| **新增** `[D3-8] clamp 容器只包正文** | §3.4 ④ 的结构合同：`userBubbleTextClass()` 所在 `<div>` 的**兄弟顺序**是「附件区在前、clamp 容器在后」，且 clamp 容器的 JSX 子元素**只有** `textBlocks.map` 一处。抓「顺手把附件挪进 clamp」——那会静默吃掉正文的可见行数 |

**工法成本诚实记账**：新增 `nodeClassName` 约 40~60 行 helper（TypeScript compiler API 已是本文件既有依赖）。
这笔投资**同时**服务 `[D3-7]` 与 §8.3 的 `[F6-4]~[F6-6]`，不是只为一条断言付的。

**D3-b（助手容器）** —— `chatTimelineLayout.test.ts` 新增一组：

- `[D3-4] turnAnswerContainerClass 只描边不换底`：断言返回串**含** `border border-border`、
  **不含** `bg-`（任何底色类）。这条是 §4 整个解嵌套裁定的**唯一静态守卫**——
  它把「哪天有人顺手补个 `bg-muted` 让容器'看得见一点'」直接变成红。
- `[D3-5] 容器内距与散文段距同档`：`p-3.5` 解析出的 14 === `marginTopPx(chatMarkdownParagraphClass())`。
  跨模块相等，抓「只改了一边」。
- ~~`[D3-6] 容器不上 sticky 禁忌属性`~~ **—— rev.2 退役该条的论证，换 `[D3-6′]`**（B 轨第 4 条，实读复核成立）。

  **rev.1 错在哪**：它写「容器是新加在 sticky 链上的**祖先**元素，任何一个都会静默关掉置顶气泡」。
  【实测 DOM，见 §4.3 的结构图】sticky 元素是 `MessageTimeline.tsx:1168` 的 band；
  answer 容器挂在 `:1224`，位于 band 的**后续兄弟**（`:1172` 的 `turnBodyClass()` div）**内部**。
  ⇒ 容器是 **sticky 元素的兄弟的后代**，不是它的祖先，**改不了它的 containing block**。
  给容器加 `overflow-hidden` **不会**关掉置顶气泡。原论证与 M-14 的「真实缺陷」标注**双双失效**。
  （旁注：`chatTimelineLayout.ts:6-15` 的 F-B8/F-B10 禁令，其对象逐字写的是
  「the pinned bubble band **and its containing block**」——answer 容器不在这个范围内，
  不得把那套因果复制过来。）

- **`[D3-6′] 容器是「一圈边框 + 一个内距」的最小集**（替代条，诚实定性为**形态锁**而非安全断言）：
  断言 `turnAnswerContainerClass()` 按空白切分后的 token 集合**逐字等于** `{rounded-sm, border, border-border, p-3.5}`。
  它把 `[D3-4]`（无 `bg-`）与「无 `overflow-`/`transform`/`filter`/`contain`」一并覆盖，
  白名单形态还额外挡住「顺手加个 `shadow-xs`/`ring-1`」这类未被穷举的漂移。
  **它守的是「这个容器的全部职责只有一圈线和一层内距，任何加法都必须回到本规格重新论证」**，
  不是「加了会有 bug」——这条区别必须写进用例注释，否则下一个读者会以为它是安全断言。
  `[D3-4]` **保留不动**：它点名的具体退化（有人补 `bg-muted` 让容器「看得见一点」）是 M-12 的靶子，
  白名单虽然也会红，但用例名说不出那个故事。

- `messageTimelineWiring.test.ts` 新增 `[D3-7] 容器挂在 answer 段而非逐 item`（**改 AST 节点级**，rev.2）：
  ~~`expectCalled('cn(turnBodyClass(), turnAnswerContainerClass())')` 且只出现一次~~ —— 出现次数不证明位置：
  把唯一那次调用挂到 `process.map` 一侧或任何无关节点，「只出现一次」照样成立（B 轨第 5 条）。
  改为：**定位 `answer.length > 0` 这个条件表达式**，取其 `&&` 右侧的**直接 JSX 元素**，
  断言该元素的 `className` 就是 `cn(turnBodyClass(), turnAnswerContainerClass())`；
  再断言 `turnAnswerContainerClass` 这个标识符在**整份文件**里只出现这一次（防复制）。
  两条合起来才同时挡住「挂错位置」与「挂了两处」。

### 8.3 F6 层：测试合同变更（`middleColumnLayout.test.ts`）

| 现位置 | 处置 |
|---|---|
| `:243-260` F-A2 静息高度（42px，类串 × 算术交叉核对） | **改值 + 扩形 + 删一行**：74px，`composerFollowHeightBreakdown()` 增 `rows`/`rowGap` 字段，交叉核对保持不变（承重命题「高度是算出来的不是抄的」仍成立，故改值不退役）。⚠️ **`:255` 的 `expect(cls).toContain('items-center');` 必须删**——§6.7 已把卡片的 `items-center` 去掉（rev.1 漏列，A 轨 M-6）；`:271-278` 的 F-A2「无 variant 前缀」一条**不动** |
| `:290-307` F-A21 两条（pill 半高圆角 · `21 × 2 === 静息高度`） | **退役换新**：pill 推导链不再成立（§6.7）。换为 `[F6-1] session 卡与 empty 卡同用 rounded-md`，并断言类串**不含** `rounded-[`（任意值圆角彻底离场） |
| `:308-331` F-A2b（extras 时降到 `rounded-md`）+「从不用 rounded-lg」 | **退役换新**：`opts.hasExtras` 参数退役后该分支消失。「从不用 `rounded-lg`」一条**保留** |
| `:332-368` `composerBarClass`/`composerActionGroupClass` 组 | `empty` 三条**不动**；`:340-361` session 两条（8px gap 无上偏移 · `items-start` 顶边对齐）**改值**为 `items-center`，并把 round-5 的理由注释改写为「行 2 已无 textarea」 |
| `:369-438` `composerTextareaClass` 组 | `empty` 四条不动；`:416-421`（128px 宽度地板）与 `:432-438`（`flex-[2]` 主导权重）**双双退役**——两者都是单行争宽的补丁。换为 `[F6-2] session textarea 独占整行`：含 `w-full`、**不含** `flex-`、**不含** `min-w-` |
| `:439-486` `sessionStatusLineWrapperClass` 组 5 条（`basis-0` · `shrink`+`min-w-0` · 非零 grow · `max-w-48` · `h-6`） | **整组退役**（§6.4：该槽迁出争宽行）。换为 `[F6-3] 状态槽是整行槽`：含 `min-w-0`、**不含** `flex-1`/`basis-`/`max-w-`/`h-6` |
| `:487-527` `resolveIdleStatusText` 组 6 条 | **全部保留**——该函数的选词逻辑与位置无关，本批不动它 |

**新增结构断言（rev.2 整段重写：现有工法不支持 rev.1 的写法）**

⚠️ 【实测】`composerFormStatic.test.ts` 今天**只有三样东西**：目录遍历（`collectFiles`，`:38-51`）、
去注释（`readStripped`，`:34-36`，走共享的 parser-backed `stripComments`）、正则名称扫描（`:53-86`）。
**没有 JSX AST、没有分支模型、没有 sibling 模型。** ⇒ rev.1 的 `[F6-4]`（「断言 `composerBarClass('session')`
的**兄弟**里不含 `textareaEl`」）在这套工法下**不可实现**；`[F6-5]` 若只做全文件 presence 检查更是**必然假绿**——
`composerActionGroupClass()` 今天就出现在 empty 分支（`ChatComposer.tsx:2653`），
session 行 2 **完全漏接**它也照样通过（A 轨 M-7 / B 轨第 6 条同判）。

⇒ **三条全部改 JSX AST 断言**，复用 §8.2 为 D3 组建的同一套节点定位工法（这也是那笔投资值得的原因）：

| 编号 | 断言（AST 形态） | 抓什么 |
|---|---|---|
| `[F6-4]` | 定位 `ChatComposer` 中 `mode === 'session'` 的**条件表达式真值分支**；断言：① 该分支的根 JSX 元素 `className` 是 `composerRowsClass()`；② 它恰有 **2 个** direct-child JSX 元素（extras 堆栈条件渲染除外）；③ 第一个 direct child 的子树里**含** `textareaEl`；④ 第二个 direct child 的 `className` 是 `composerBarClass('session')` 且其子树里**不含** `textareaEl` | 「加了外层 flex-col 但七件套还在同一个内层 div」的半吊子落地 |
| `[F6-5]` | 在 `[F6-4]` ④ 定位到的**那个** direct child 内部，断言存在一个 `className={composerActionGroupClass()}` 的元素，且它是该行的**最后一个** child | session 行 2 漏接尾靠组（全文件 presence 检查会假绿） |
| `[F6-6]` | 定位 `mode === 'session'` 的**假值分支**（empty），按 direct-child **顺序**比较：`textareaEl` → notice → queueNotice → attachmentChips → mentionChips → `composerBarClass('empty')` 行；再在该行内按顺序比较 attach → agent → model → permission → status → actions | T-30b2 §5.2 阅读序不回归的唯一静态守卫；顺序断言，不是集合断言 |

**落点选择**：三条放 `composerFormStatic.test.ts`（它已经是「composer 结构的静态证据」这一职责的归属地），
但**必须先扩工法**——把 `readStripped` 之外再加一个 `parseTsx(file) -> SourceFile` 与 §8.2 同源的节点定位器。
这笔工法扩建**计入片③ 的工作量**，不得当成「顺手加三条断言」。

### 8.4 F4 层：新增断言与**变异编号清单**

**新增 8 条断言**（`attachments.test.ts` 承 F4-1~F4-5、F4-8；`turnStatus.test.ts` 承 F4-6；
`composerFormStatic.test.ts` 承 F4-7）：

| 编号 | 断言 | 抓什么 |
|---|---|---|
| `[F4-1]` | 动词是 `elapsedSeconds` 的**确定性**函数。**rev.2 加强**（B 轨第 8 条）：「同参两次相等」排除不了「全局可变状态恰好两次同值」⇒ 改为 **`A → B → A` 交错调用**（`elapsed=0` → `elapsed=7` → `elapsed=0`，第三次必须等于第一次），再加 `0..44` 逐秒枚举得到**固定序列**，并断言模块无导出的可变状态 | 随机化 / 引入状态 / 缓存漂移 |
| `[F4-2]` | **一次等待内不重复**：`ceil(SLOW_WAIT_HINT_SECONDS / VERB_ROTATION_SECONDS) <= VERBS.length`，且 `0..SLOW-1` 枚举出的动词集合大小恰为 `ceil(SLOW/ROTATION)` | 周期调小 / 词表删短 / F2 上调阈值 |
| `[F4-3]` | `↑`/`↓` 的出现与省略 **+ 具体数值映射**（rev.2 加强，B 轨第 8 条：只断言「出现/省略/顺序」的话，一个恒定输出 `↑ 1 chars · ↓ 1k` 的错误实现也能通过）：① `promptChars === 0` 时无 `↑`；② `outputTokensDisplay == null` 时无 `↓`；③ **`promptChars = 428` ⇒ 输出含 `↑ 428 chars`**；④ **`outputTokensDisplay = 1800` ⇒ 输出含 `↓ 1.8k`**；⑤ **`outputTokensDisplay = 850` ⇒ 含 `↓ 850`**（跨 1000 边界的两侧都要）；⑥ 两者都给时 `↑` 在 `↓` 前 | 计数漏接、**接了但没接对**、顺序漂移、`↑ 0` 假值 |
| `[F4-4]` | `budgetMs` 被忽略 **+ 正向内容仍在**（rev.2 加强：只证「某内容消失」的话，一个完全忽略 elapsed/附件/prompt/token 的常量文案也满足）：① 仅 `budgetMs` 不同的两次调用输出**逐字相等**；② 输出不含 `up to`；③ **同一次断言里**再确认动词、`· {N}s`、`Sent {size}`、`Retry a/m`、`↑`、`↓` **六项都还在** | `(up to Ns)` 复活 · 「顺手把整行简化成常量」 |
| `[F4-5]` | 无随机源 **+ 逃逸口封堵**（rev.2 加强，B 轨第 8 条：只扫 `attachments.ts` 的话，把随机挪进 `countFormat.ts` 或任一被 import 的 helper 即可逃逸）：源文扫描范围扩到 **`attachments.ts` 与它 import 的本目录模块闭包**（含新建 `countFormat.ts`），全部不含 `Math.random` / `Date.now` / `performance.now` / `crypto.getRandomValues` | 纯函数性被破坏（含挪窝规避） |
| `[F4-6]` | 分档 + 色阶：`deriveTurnStatus` 在 `45..179` 给 `'slow'`、`>=180` 给 `'stalled'`，**两者文案都含 `Stop to abort.`**；`turnStatusToneClass('slow')` 为 falsy、`('stalled')` 为 `'text-warning'`。⚠️ **落点 rev.2 订正**（B 轨第 8 条）：`turnStatusToneClass` 是 `MessageTimeline.tsx:1388` 的**未导出私有函数**，`turnStatus.test.ts` **无法直接 import**——rev.1 把它分配给该文件是不可执行的。**处置：把 `turnStatusToneClass` 抽到 `chatTimelineLayout.ts`**（它本来就是「回合级类装配」的职责，与 `turnHeadClass()` 同族，且该文件已是 node 环境可断言的纯模块），`MessageTimeline.tsx` 改为 import。⇒ 前半（分档）落 `turnStatus.test.ts`，后半（色阶）落 `chatTimelineLayout.test.ts` | `stalled` 没接线 / slow 色阶没降 / F2 的 `[TS-1]` 承重半边被弄丢 |
| `[F4-7]` | `promptChars` 取提交点快照：`ChatComposer.tsx` 源文含 `[...committed.text].length`，且 `beginTurnSend(` 的实参里出现 `promptChars` | 取了实时 `value`（会数成用户下一条正在打的字） |
| **`[F4-9]`** | **pending 窗口也消费该字段**（rev.2 新增，B 轨第 7 条）：构造「用户 echo 尚未建立 turn、`sendStatus.promptChars = 428`」的场景，断言 `PendingTurnHead` 渲染出的等待行**含 `↑ 428 chars`**。没有这条，`[F4-7]` 只证明 producer 写了字段，**不证明最早可见的那个窗口消费了它** | 只接了 attached 回合、漏接 pending 头 |
| `[F4-8]` | 词表纪律：12 个动词全部匹配 `/^[A-Z][a-z]+$/`；无一含 `upload`/`almost`/`nearly`/`still`（§7.3 四条选词纪律的可断言部分）。⚠️ **范围限定**：该禁词表**只作用于 `VERBS` 数组**，不作用于整行文案——`slow`/`stalled` 的首语就是 `Still waiting`，把禁令误扩到整行会把它们判红 | 有人往词表塞了带承诺或带指责的词 |

**变异编号清单（rev.2：28 → 33 发，逐发标注发射半边）**

| # | 变异 | 应红的断言（发射半边） |
|---|---|---|
| M-01 | `BLOCK_GAP` 退回 `mt-2.5` | `[D1-1]①` —— **注意 `[D1-2]` 不会红**（集合仍是两档），这就是为什么 `[D1-1]` 必须存在 |
| M-02 | `SECTION_GAP` 退回 `mt-5` | `[D1-1]②` |
| M-03 | 根类退回 `leading-normal` | `chatMarkdownPolicy.test.ts:590`（改值后） |
| M-04 | 只改根类，漏改 `MessageTimeline.tsx:1464` | `[INV-D1-1]①`（计数 2） |
| M-05 | 顺手把 `turnBodyClass()` 也换成 `leading-relaxed` | `[INV-D1-1]③` |
| M-06 | `--muted-foreground` 亮值退回旧值 | `[D2-1]①` |
| M-07 | `--tool-arg` 混合比 85 → 78 | `[D2-1]②` |
| M-08 | `--tool-arg` 改成独立字面量（断开派生） | `[D2-1]③` |
| M-09 | `.dark` 里补第二条 `--tool-arg` | `[D2-1]④` |
| M-10 | 用户气泡只加 `max-w-[85%]`，漏 `justify-end` | `[D3-1]` |
| M-11 | 用户气泡保留 `bg-card` | `[D3-2]` |
| M-12 | 助手容器补 `bg-muted`（"让它看得见一点"） | `[D3-4]` —— 本批**最重要的一发**，它守住 §4 的整个解嵌套裁定 |
| M-13 | 容器内距改 `p-3` | `[D3-5]` |
| M-14 | 容器加 `overflow-hidden` | `[D3-6′]` —— ⚠️ **rev.2 重标**：这是**形态漂移**，不是安全缺陷。rev.1 标的「会静默关掉置顶气泡」已被 DOM 实测证伪（§4.3 结构图 / §8.2）。变异保留，因为白名单锁确实该守住；但**不得再宣称它抓的是 sticky bug** |
| M-15 | 容器挂到 `process.map` 一侧 | `[D3-7]`（唯一出现次数） |
| M-16 | session 卡 radius 退回 `rounded-[21px]` | `[F6-1]` |
| M-17 | textarea 保留 `flex-[2]` | `[F6-2]` |
| M-18 | 状态槽保留 `max-w-48` | `[F6-3]` |
| M-19 | 行 2 漏 `ms-auto` 尾靠 | `[F6-5]` |
| M-20 | empty 分支控件顺序被"顺手统一" | `[F6-6]` |
| M-21 | 轮换周期 6 → 3 | `[F4-2]`（`ceil(45/3)=15 > 12`） |
| M-22 | 词表删到 6 个 | `[F4-2]`（`ceil(45/6)=8 > 6`） |
| M-23 | 改用 `Math.random()` 选词 | `[F4-5]` + `[F4-1]` |
| M-24 | `(up to Ns)` 复活 | `[F4-4]` |
| M-25 | slow 分支也换成俏皮动词 | `attachments.test.ts:348-358`（逐字保留的那条） |
| M-26 | `stalled` 没接线，`slow` 仍上 `text-warning` | `[F4-6]` |
| M-27 | `promptChars` 取实时 `value` | `[F4-7]` |
| M-28 | `↓` 只接 streaming，漏接 awaiting | `[F4-3]②` |
| **M-29** | 气泡只加 `max-w-[85%]`，漏 `min-w-0` | `[D3-1]②` —— 抓 A 轨 M-2 的 `min-width:auto` 击穿 |
| **M-30** | 把附件芯片区挪进 `userBubbleTextClass()` 的 clamp 容器 | `[D3-8]` —— 抓「静默吃掉正文可见行数」 |
| **M-31** | `promptChars` 只接 attached 回合，漏 `PendingTurnHead` | `[F4-9]` —— 抓 B 轨第 7 条的最早可见窗口 |
| **M-32** | 换行高时顺手把 `QuestionCard.tsx:254` 也改成 `leading-relaxed` | `[INV-D1-1]` 的计数半边（`leading-normal` 应剩 6，变成 5） |
| **M-33** | 只改 `chatMarkdownPolicy.ts` 的根类装配，漏改 `chatMarkdownRender.test.ts:300` 的渲染断言 | 该断言自身**必红**（B 轨第 3 条）——这一发验的是「测试清单没漏文件」，跑法是**只改生产码不改测试**，确认 9 份里恰好这一份也会红 |

**零跳过纪律**：33 发全部实跑，不得以"显然会红"跳过。
按既有工法，**先跑变异确认红、再回退确认绿**；任一发出现存活，说明对应断言是空壳，必须换承重行而不是加一条同义断言。

### 8.5 GUI 点验清单（静态断言表达不了的那一半）

走 `node scripts/dev.js` + CDP 工法。**每项都要亮暗双主题截图**：

| # | 场景 | 验什么（静态断言看不见的部分） |
|---|---|---|
| G-1 | 一屏三个以上回合，含代码块 + 表格 + 列表 | D1-b 的真实呼吸感；D3-b 容器与内层叶子框的**视觉压迫感**（§4.6 否决权触发条件①） |
| G-2 | **滚动到置顶气泡态** | §3.4 ② 的核心：85% 气泡左侧露出的是否确为 band 的 `bg-background`，**有无透明缝** |
| G-3 | **六行 clamp 的四场景**（rev.2 重写：rev.1 写「三行」，实测 `chatTimelineLayout.ts:85` 返回 `line-clamp-6`；B 轨第 9 条） | ① 无附件·超长单段；② **多段落**（多个 `<p>` + `space-y-2` 段距，`-webkit-box` 在多个块级子元素上的裁切行为不确定，单测看不见）；③ 含空行/强制换行；④ **含附件后接长正文**（验证附件区确在 clamp 容器外、不吃六行预算，§3.4 ④ 结构合同）。每场景核：省略号是否出现、`title` 全文是否可达、实际高度、置顶态是否稳定 |
| G-4 | 带附件的用户消息 | §3.4 ③ 芯片在 `bg-accent` 上的可辨性 |
| G-5 | Composer 两行 · 静息态 | 74px 高度是否与设计一致；`rounded-md` 观感；行 2 五控件不拥挤 |
| G-6 | Composer 两行 · 五个弹层逐个打开 | §6.6 的排查结论证实（尤其 `@` 提及弹层是否越出滚动区） |
| G-7 | Composer · Host 空态（agent picker 显示 `emptyStateNotice` + Retry Host） | §6.6 ③ 的挤压风险 |
| G-8 | Composer · 读盘中 + 大附件提示 | §6.4 状态行迁入 extras 后的观感与卡片高度跳变 |
| G-9 | 等待行 0→45→180→300s 全程 | 动词轮换观感、`↑`/`↓` 计数、`slow`→`stalled` 的色阶转换时机 |
| G-10 | **聊天页之外**：设置页 / 侧栏 / source-control / todo 看板 / onboarding | §2.4-c 的 87.46% ——D2-b 是全应用改造，不能只验聊天页 |
| **G-11** | **token 解析探针**（rev.2 新增，B 轨 m-2）：真实 renderer build 后，CDP 取 `getComputedStyle(document.documentElement).getPropertyValue('--tool-arg')`，亮暗双主题各一次 | `[D2-1]` 只锁 `globals.css` 里的**字面量**，不证明 `color-mix(in oklab, …)` 在打包产物里**被解析出非空值**。这是唯一能把「写对了」和「跑通了」分开的一步。⚠️ 不为此切换 CSS minifier（见 §2.1 写法纪律注） |

### 8.6 跨批次待补断言（依赖 F2 落地）

| 项 | 内容 | 谁执行 |
|---|---|---|
| ① | `[TS-1]` 修订为分段式（`slow` / `stalled`），承重半边扩到两个分支 | **后落地的一方**（§7.5 已写协调口径） |
| ② | 链式不变量 `SLOW_WAIT_HINT_SECONDS < STALLED_HINT_SECONDS < SEND_SILENCE_CEILING_MS / 1000` | F2 落地后补；本批先只断言前半 |
| ③ | `composerSendingLine` 的 `budgetMs` 在 F2 换源后仍被忽略（`[F4-4]` 的跨批次复验） | 后落地方跑一次 |

---

## §9 切片方案与影响面全清单

### 9.1 混面分析（先说清哪里不能并行）

分诊问的是「token 层 / 时间线层 / composer 层可否并行零混面」。**逐层查完的答案是「不完全能」**：

- 【实测】`MessageTimeline.tsx` 被**三件事**同时触及：D1-b 的两处行高（`:782` / `:1464`）、
  D3-c/D3-b 的气泡与容器（`:725-757` / `:1224`）、F4 的等待行接线（`:1003-1020` / `:1388-1392`）;
- 【实测】`messageTimelineWiring.test.ts` 同理被 D1-b 与 D3-c 同时触及；
- 【实测】`ChatComposer.tsx` 被 F6（`:2524` / `:2604-2656`）与 F4（`:1117-1126`）同时触及。

⇒ 「按 D1/D2/D3/F6/F4 五件事各切一片」会制造三处文件级冲突。**按文件簇重切为四片**。

⚠️ **不得称之为「真正零混面」**（rev.2 订正，B 轨第 10 条）：本方案自己就承认片④ 会再次改动片②③ 的文件。
准确表述是 **「①②③ 三片零文件重叠、可并行；④ 是后置片，必须 rebase 到 ②③ 合入结果之上」**。
另有两份**聚合文档**（`openchamber-chat-refactor-ledger.md` 的 D49 行、plantree 两份状态文件）
与**本规格的 as-built 回填**，若四个施工者各自回填同样会冲突 ⇒ §9.2 已指定**唯一集成者**。

### 9.2 四切片（依赖序：`① ∥ ② ∥ ③ → ④ rebase`；跨批次序见 §0.4）

| 片 | 内容 | 独占文件 | 与谁并行 |
|---|---|---|---|
| **① token 层** | D2-b（`--muted-foreground` 双档 + `--tool-arg` 混合比） | `styles/globals.css` · `docs/design-system.md` · **新建** `styles/__tests__/tokenValues.test.ts` | **与全部片并行**，零文件重叠、零现存测试依赖 |
| **② 时间线层** | D1-b + D3-c + D3-b | `chatMarkdownPolicy.ts` · `chatTimelineLayout.ts` · `MessageTimeline.tsx` · `chatMarkdownPolicy.test.ts` · **`chatMarkdownRender.test.ts`**（rev.2 补，B 轨第 3 条）· `chatTimelineLayout.test.ts` · `messageTimelineWiring.test.ts`（含 AST 工法扩建）· 两份基线 HTML | 与 ① ③ 并行；与 F2 S3 同文件不同区，谁后合谁 rebase（§0.4 ②） |
| **③ composer 层** | F6 两行布局 | `ChatComposer.tsx` · `middleColumnLayout.ts` · **`ComposerAgentPicker.tsx`**（rev.2 补，B 轨第 6 条：rev.1 的独占文件表漏列，却又在 §9.3 影响面表里把它归③，自相矛盾）· `middleColumnLayout.test.ts` · `composerFormStatic.test.ts`（含 JSX AST 工法扩建） | 与 ① ② 并行；与 F2 S2 同文件不同区（§0.4 ③） |
| **④ 等待行** | F4 | `attachments.ts` · `turnStatus.ts` · `stores/turnSendStatus.ts` · **新建** `countFormat.ts` · `attachments.test.ts` · `turnStatus.test.ts` · `stores/__tests__/turnSendStatus.test.ts` ＋ **轻触** `MessageTimeline.tsx`(3 处：`:782`/`:1003-1020`/`:1262-1271`+`:1388-1392`) 与 `ChatComposer.tsx`(1 处：`:1117-1126`) | **排最后**——它是唯一同时轻触 ② ③ 文件、且与 F2 有两处同区冲突的片（§0.4） |

**为什么 D1-b 与 D3 必须同片（不拆）**：两者都改 `MessageTimeline.tsx` 与 `messageTimelineWiring.test.ts`，
且 D3-b 的容器挂点（`:1224` 的 `answer` 段）与 D1-b 的散文类串是同一段渲染逻辑的两面——
拆开会让第二个人在一份刚被改过的 AST 投影断言上重新对账，成本高于合并。

**为什么 ① 值得单独一片**：它是**唯一一个影响面越出聊天页**的改动（§2.4-c：87.46% 在 chat 之外），
它的验收标准（G-10 全应用点验 + G-11 探针）与其余三片完全不同；单独成片才能单独回滚。

**聚合文档的唯一 owner（rev.2 新增，B 轨第 10 条）**：
`openchamber-chat-refactor-ledger.md`（D49 行）· `docs/plantree/plans/openchamber-chat-refactor/{implementation-status,roadmap}.md`
· 本规格的 as-built 回填 —— **四份全部归「集成者」一人**，在四片合并后一次性写入。
任何单片施工者**不得**顺手改这四份。（`design-system.md` 与两份基线 HTML 归片① / 片②，见上表。）

⚠️ **D49 号位有竞争**：现有最高决策号是 D48（`openchamber-chat-refactor-ledger.md`），
但 F2 批若先合入并新增一行，本批就该是 D50。**施工时以合入时点的台账实况为准，复取最大号后再写**，
不得按本规格写死的 D49 落笔。

### 9.3 影响面全清单

**生产代码（12 份）**

| 文件 | 改动 | 片 |
|---|---|---|
| `src/renderer/styles/globals.css` | `:159` / `:211` 色值 · `:195` 混合比 | ① |
| `src/renderer/components/chat/chatMarkdownPolicy.ts` | `:391-400` 注记 + 两常量 · `:426` 行高 · `:473/:475` 列表 · `:509` 代码块 · `:523-524` 表格 | ② |
| `src/renderer/components/chat/chatTimelineLayout.ts` | **新增** `turnAnswerContainerClass()`（②）· **迁入** `turnStatusToneClass()`（④，从 `MessageTimeline.tsx:1388` 抽出，理由见 §8.4 `[F4-6]`） | ② + ④ |
| `src/renderer/components/chat/MessageTimeline.tsx` | `:725-743` 气泡 · `:757` 芯片描边 · `:782` / `:1464` 行高 · `:1224` 容器挂载 · `:1003-1020` promptChars 读出 · `:1388-1392` 色阶分档 | ② + ④ |
| `src/renderer/components/chat/ChatComposer.tsx` | `:2524` 卡片参数 · `:2604-2656` 两行结构 + 状态行迁位 · `:1117-1126` promptChars 写入 | ③ + ④ |
| `src/renderer/components/chat/middleColumnLayout.ts` | `composerCardClass`（radius/opts/items）· `composerFollowHeightBreakdown` · `composerBarClass('session')` · **新增** `composerRowsClass` · `composerTextareaClass('session')` · `sessionStatusLineWrapperClass` | ③ |
| `src/renderer/components/chat/ComposerAgentPicker.tsx` | `:224` `shrink-0` → `min-w-0 shrink` | ③ |
| `src/renderer/components/chat/attachments.ts` | `composerSendingLine` 重写 · **新增** `VERBS` / `VERB_ROTATION_SECONDS` / `STALLED_HINT_SECONDS` | ④ |
| `src/renderer/components/chat/turnStatus.ts` | `TurnStatusKind` 加 `'stalled'` · `TurnStatusInput` 加 `promptChars` · `formatTokenCount` 下沉 + re-export | ④ |
| `src/renderer/components/chat/countFormat.ts` | **新建** | ④ |
| `src/renderer/stores/turnSendStatus.ts` | `TurnSendStatus`（`:41-52`）加 `promptChars` —— 与 F2 的 `TurnSendStatusStore` 加法互不接触（§0.4 ⑤） | ④ |
| `src/renderer/components/chat/ToolRows.tsx` | **零改动**（`text-tool-arg` 保留，见 §2.3；`leading-[1.55]` 既存违规不在本批） | — |

**测试（rev.2：9 份 = 8 改 + 1 新建；逐份职责见 §8.1(c)）**：`chatMarkdownPolicy.test.ts` ·
**`chatMarkdownRender.test.ts`**（rev.1 漏列） · `chatTimelineLayout.test.ts` · `messageTimelineWiring.test.ts` ·
`middleColumnLayout.test.ts` · `composerFormStatic.test.ts` · `attachments.test.ts` · `turnStatus.test.ts` ·
**新建** `styles/__tests__/tokenValues.test.ts`。
（片④ 另会向 `stores/__tests__/turnSendStatus.test.ts` 分区追加，与 F2 共用该文件，见 §0.4 ⑤。）

**文档（6 份）**：`docs/design-system.md`（§2.5）· `docs/design/phase0a-openchamber-alignment.html`（§5.2 ①②③④）·
`docs/design/a07-cursor-composer-alignment.html`（§5.2 ②③④）· `docs/plans/openchamber-chat-refactor-ledger.md`（新增 **D49** 行）·
`docs/plantree/plans/openchamber-chat-refactor/{implementation-status,roadmap}.md` · 本规格（as-built 回填）。

⚠️ **规划文档改动纪律**：`docs/plans` 与 `docs/plantree` 的表格行含全角标点，
**跳过 Edit 工具，直接用 python 做字节级替换**（本仓已在此处栽过三次）。

### 9.4 门禁

服务器内存有限，**逐门串行跑**，不得链式合跑（曾 OOM `exit 137`）。
每片独立跑一次全量 vitest；四片合并后再跑一次；GUI 点验（§8.5 十项）在四片全落之后一次性做。
变异验证按片跑自己那一段（① = M-06~M-09；② = M-01~M-05、M-10~M-15、M-29、M-30、M-32、M-33；③ = M-16~M-20；④ = M-21~M-28、M-31）。

---

## §10 Open questions 与实现方否决权上报路径

### 10.1 需要**用户拍板**才能施工的（**一条**，rev.2 从三条收敛）

| # | 问题 | 本规格的建议答案 | 为什么必须问 |
|---|---|---|---|
| **Q3** | 全局 UI 语言口径：全英 / 全中 / 英控件 + 中错误说明？ | **不建议**（无技术最优解，纯产品口径） | §7.6：仓里同时存在 D47 有意引入的中文错误文案与全英文控件文案，口径从未裁定；F2 移交③ 卡在这里 |

**已从本表移除的两条（rev.2，评审 B 轨 blocker + A 轨 m-list）**：

- ~~**Q1** `--tool-arg` 抬比 85% vs 退役~~ —— **已决：保留派生 + 85%**。
  §2.3 已给出完整裁定与数值链，同一份规格不得既裁定又列待拍板（执行者会在「直接施工」与「停工询问」之间没有唯一解）。
  候选 B 降为**仅历史存档**（§2.3 表）。**这条不是被跳过，是被判定为已决**。
- ~~**Q2** `(up to Ns)` 从句退役 vs 保留 300s~~ —— **已决：退役**。
  §7.2 三条理由 + F2 仲裁档 §8.4 明文把该判断**移交本批**（移交 = 授权本批裁定，不是转发给用户）。
  文首「不可复议清单」已逐字钉明。

### 10.2 需要**评审确认**的（**七条**，技术判断，不必惊动用户；rev.2 从四条增至七条）

| # | 问题 | 本规格的判断 |
|---|---|---|
| Q4 | Composer 静息高度 42px → **74px**（§6.7），时间线可视区少 32px——可接受吗？ | 可接受：两行是用户明确要的形态，32px 是它的必然代价；且 empty 模式本就更高 |
| Q5 | session 与 empty 的状态行落点从此不同（extras vs 底部条，§6.5）——算不算不一致？ | 不算：两种卡形态不同，且已在 `sessionStatusLineWrapperClass()` 头注写明分工 |
| Q6 | `STALLED_HINT_SECONDS = 180` 这个数值（§7.5） | F2 §8.3 的建议值，本规格照用；无实测依据，属可调参数 |
| Q7 | `composerCardClass` 的 `opts` 参数退役（§6.7）——施工前须 grep 确认无第二个消费者 | 【本轮实测】仅 `ChatComposer.tsx:2524` 一个调用点，退役安全；施工时复验 |
| **Q8** | `stalled` 用 `text-warning` 是**知情违反** `design-system.md` 的「不要用 warning 代替 amber」词表禁令（§7.5 ③），接受吗？ | **接受，但必须留三处痕**：D49 台账行的「知情偏离」栏 · `turnStatusToneClass` 头注 · 本表。理由：回合头内无链接（`text-primary` 的唯一常规用途），且这是时间线上唯一需要抢眼的时刻；为一个色阶开 `@theme` 双写的新 token 不划算。**若评审否决，退路是 `stalled` 也走 muted，只靠措辞区分**——此时 §7.5-a 的措辞档就是唯一载体，更不能退役 |
| **Q9** | `[D3-6′]` 从「安全断言」降级为「形态锁」（§8.2），M-14 随之重标——接受这次降级吗？ | **接受**：rev.1 的 sticky 因果链已被 DOM 实测证伪，继续宣称它是安全断言就是把风格偏好包装成安全承诺。白名单锁本身仍有价值（挡未穷举的加法），但用例注释必须诚实写明它守的是「职责边界」不是「bug」 |
| **Q10** | 本批新建的 **JSX AST 节点定位工法**（§8.2 / §8.3 共用）是一笔跨两片的工法投资，值得吗？ | **值得**：它是 `[D3-1]/[D3-2]/[D3-3]/[D3-7]/[D3-8]/[F6-4]/[F6-5]/[F6-6]` **八条**断言的共同前提；不建它，这八条要么不可实现、要么按构造假绿（两轨各自独立得出同一结论）。成本约 40~60 行 helper，`typescript` 已是既有依赖 |

### 10.3 明确**另立票**、本批不做（**七条**，rev.2 从五条增至七条）

1. **背景图开启时的聊天阅读底**（§2.6）：开图后 D2-b 的收益被壁纸稀释，正解是给时间线一个不透明底，属独立设计决策。
2. **`text-muted-foreground/NN` 的 36 处 alpha 滥用**（§2.4-c）：提档后仍有不达标的，属 Alpha 纪律的既存问题。
3. **`ToolRows.tsx:230/233/262/285/304` 五处 `leading-[1.55]` 任意值**（§1.4 ③）：与 Token 分档纪律冲突的既存违规。
4. **D2-c 容器边界可见化**（行内代码 chip 补边框 / 工具输出块补左导轨，§4.5）：未拍板。
5. **F1 / F3 / F7 / F8 / F9**：分诊档已各自分批。
6. **用户气泡的展开开关**（§3.4 ④）：`chatTimelineLayout.ts:82` 的 F10 头注写着
   `` a user-owned expand toggle is F456-batch work `` —— 但用户 2026-08-18 的四条拍板里没有这一项，
   §0.2 的越界纪律优先。本批**不做**，但施工时**顺手把那句头注改成「归后续票」**，
   否则它会一直宣称一件本批没做的事。
7. **`chatMarkdownPolicy.test.ts:550-585` 的 sticky-chain describe 用词过宽**（§8.2 旁注）：
   它声称 markdown root 「sits inside」band —— 按 §4.3 的 DOM 实测，root 在 band 的**兄弟**里。
   该 describe 的**断言本身仍成立**（禁 overflow 是对的），只是**理由叙述**与 DOM 不符。
   本批**不改它**（不在变更面内），但记一张订正票，免得下一个人照抄那套因果。

### 10.4 实现方否决权上报路径（用户已明确保留，见 §4.6）

**唯一适用对象是 D3-b（助手中性容器）**——它是用户在设计员明示反对后仍作出的拍板。

- **触发条件**：§4.6 的三条（视觉压迫感 / 阅读宽度净损 / 出现消失跳动），任一成立即触发；
- **上报动作**：施工分支产出对照截图 → 在本规格追加 §4.6-a「实作否决记录」→ **由用户拍板降级方案**；
- **禁止动作**：施工方**不得自行撤销 D3-b**，也不得"折中"成 `bg-muted` 版（那是 §4.2 已淘汰的候选 A，
  且会触发 M-12 变异所守的 `[D3-4]` 断言）。

**其余四项（D1-b / D2-b / D3-c / F6）不适用否决权**：它们要么是纯数值换档、要么是执行既有裁定（D31），
争议已在本规格内用实测消解；如有异议应在**评审阶段**提出，不留到施工期。

---

## 附：本规格与既有档案的关系

- **上游**：`docs/plans/2026-08-17-d48-t10-inspection-triage.md`（F4/F5/F6 三节 + 拍板记录第 5 条）；
  `docs/design/2026-08-18-f5-chat-readability-draft.html`（对比稿，**设计稿而非施工图**，八处需修正见 §0.5）。
- **平行**：**`docs/plans/2026-08-18-f2-watchdog-arbitration.md`（双轨仲裁 + §15 拍板 D1~D6，本批引用 F2 的权威档）**
  与其 rev.2 定稿 `docs/plans/2026-08-18-f2-watchdog-redesign-spec.md`（并行产出，**本档一切 F2 引用以它为准**）；
  两轨原稿 `…-spec-trackA.md` / `…-spec-trackB.md` 仅供溯源。边界见 §0.2~§0.4，协调项见 §7.5-b / §8.6。
- **评审**：`docs/plans/2026-08-18-f456-reviews/trackA-opus.md`（A 轨 Opus 双盲）·
  `docs/plans/2026-08-18-f456-reviews/trackB-codex.md`（B 轨 Codex）—— 逐条处置见 §0.0，两轨总判语均为「修订后开工」。
- **下游**：本批落地后须回填 **D49（号位待复取，见 §9.2）** 决策行、两份基线 HTML 的修订注记、`design-system.md`「已知偏差」表、
  plantree 三处状态（§5.3）。
- **权威顺序**（plantree 注册表所定）：ARD ＞ 执行计划 ＞ 总台账（决策）＞ plantree（状态）。
  本规格属**批次施工规格**，其内的裁定在与对比稿冲突时以本规格为准，在与总台账决策冲突时以总台账为准
  ——本规格已逐条核对，**无一处与总台账冲突**（D31 是支持而非冲突，见 §3.1）。


