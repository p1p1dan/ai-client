# 移交：过程组展开态与视觉层级重做（决策 033）

**移交日期**：2026-09-22
**决策依据**：[决策 033](../decisions/033-process-group-expanded-and-visual-hierarchy.md)（**先读它，本单只是施工索引**）
**任务号**：待排（未进 roadmap）
**状态**：✅ **已施工完成（2026-09-22）**，决策 033 顶部的「落地修订」块记录了与本单不符之处

> ## 施工结果与本单的差异（以决策 033 顶部修订块为准）
>
> | 本单条目 | 实际落地 |
> |---|---|
> | §2.3 / §2.4 头「`--accent` 底 + 边框 + 圆角 + 数量 badge」 | **只保留吸顶 + `bg-background`**，其余当日被用户否决；右侧调用数为纯文字 `turnWorkGroupCountClass()` |
> | §2.4 / §2.5 思考「显著背景行」 | **撤销**，思考折叠头与普通工具行完全一致；`thoughtFoldHeaderClass()` 直接删除 |
> | §2.3 「数量词条沿用既有 `{{count}} steps processed`」 | 该词条**早已不存在**，本次重新新增；同批退休失去调用方的 `{{count}} steps` |
> | §2.2 终稿判据 | 照字面「其后不再跟 process」会选错段落，实际实现是**先取最后一段 answer 再套判据**（见 `[WG-FWD-3]`） |
> | §4 `[HEAD-EN-1]` / `[HEAD-EN-2]` | **`1e33b7fe` 已提前退休**，本次只改 `[WG-WIRE-2]` 等 |
> | 未列入本单 | `countProcessGroupThinking` / `countProcessGroupExplanations` 与三条 chip 词条随 chip 一并成为孤儿，同批删除 |
>
> §5 的四个未决项：①思考正文上限取 `max-h-[46vh]`（与 Bash 输出窗同档）；②`subagent-detail` 分支无其它调用方，已同批清除；③`turnProgress.test.ts` 只退英文 chip 断言，`Worked for …` 与 Run panel 共享条目保留；④吸顶头与两个 dock 的窄视口层叠**仍需手动验证**（见 §6.8）。

---

## 1. 一句话

把过程组从「整轮一个大组 + 实时判终稿 + 默认折叠 + 英文头」改成 **「整轮一个大组 + 流式完毕一次性提取终稿 + 默认展开 + 语言跟随系统 + 头吸顶显著化 + 思考不吸顶改背景行」**，并修掉一个「长指令永久不可见」的真 bug。

---

## 2. 改动清单

### 2.1 `src/renderer/components/chat/turnProcessFold.ts`

| 项 | 现状 | 改成 |
|---|---|---|
| `turnWorkGroupOpen()` | `forcedOpen → userOpen → false` | 默认值 `false` → **`true`**（D2） |

- **只改默认值**，`forcedOpen` / `userOpen` 的优先级顺序不动。
- **必须保持纯派生、零 `useEffect`**（021/031 的共同要求，031 修订标记里已重申）。不要为了「默认展开」引入 state 或 effect。
- `turnWorkGroupAwaitsUser` 是**红线，一个字不改**。

### 2.2 `src/renderer/components/chat/turnProcessFold.ts` — `splitTurnWorkGroup()`

**新增**「流式完毕时提取终稿」的判定（D1）。现有实现是取 `lastAnswerIndex`（最后一段 answer），**这个判据要改**：

- 新判据：**「其后不再跟 process 段落」的最后一段 answer**，而不是「最后一段 answer」。
- 原因：`answer → 工具 → 结束` 这个形状下，尾随的旁白后面还跟着工具，它**不是**终稿，但按现判据会被提出来当终稿。
- ⚠️ **这是本次唯一需要前瞻的改动**。`splitTurnWorkGroup` 原本是纯顺序扫描（`chatTurn.ts` 头部注释记着 segmenter 的契约是「no reason to ever look ahead」），本改动破了这条契约的一角。**务必在注释里写明**，否则下一个人会以为是笔误。
- 流式期间（`!processSettled`）**不需要这个判据**——全部内容留在组内，见 D1。

### 2.3 `src/renderer/components/chat/TurnProgressHead`（在 `MessageTimeline.tsx`）

| 项 | 现状 | 改成 |
|---|---|---|
| 语言绑定（D5） | `const t = englishTranslate;` | **`const { t } = useI18n();`** |
| 头内容（D1） | chip：思考 / N 次工具调用 / N 段说明 | **只有数量**：`已处理 N 个步骤` |
| 视觉（D4） | 纯文字，无底色 | **吸顶 + `--accent` 底 + 边框 + 圆角 + 数量 badge** |

- 数量词条沿用既有 `{{count}} steps processed`（→「已处理 N 个步骤」）。
- 吸顶的**唯一前提**：高度不得随滚动状态变化（`chatTimelineLayout.ts` 记录的 F10 红线）。折叠头高度固定，满足。

### 2.4 `src/renderer/components/chat/chatTimelineLayout.ts`

- **删** `thoughtFoldHeaderClass()`（D3），连带 D3 记录的历史段落改写为「已退休 + 红线保留」。
- **改** `turnWorkGroupSummaryClass()`：转为吸顶 + 底色 + 边框 + 圆角。
- **新增** 思考折叠头的背景行 class（与上面的头**共用同一套视觉语言**）。
- ⚠️ F10 禁令（吸顶元素高度不得随滚动状态变化）**继续有效**，只是不再有吸顶的思考头依赖它。别顺手删掉这条注释。

### 2.5 `src/renderer/components/chat/ToolRows.tsx`

- `pinsHeader`（`view.body === 'thinking'`）不再附加 `thoughtFoldHeaderClass()`。
- 思考折叠头改用 2.4 新增的背景行 class。
- 思考正文加**高度上限 + 内部滚动**（D3，替代吸顶要解决的问题）。
- 高度上限取哪个值属**未决**，见 §5。

### 2.6 `src/renderer/components/chat/messageTimelineScroll.ts`

- **删** `stickyFoldScrollTarget()` 与 `scrollPinnedFoldHeaderIntoView()`（D3，配套回滚补偿）。
- ⚠️ `SCROLL_SURFACE_SELECTOR` 里还有 `[data-slot="subagent-detail"]` 分支。**先核查是否仍有其它调用方**再删；若孤立则同批清除，不留孤儿。
- 同批删除相应测试断言。

### 2.7 `src/renderer/components/chat/toolCard.ts`（D6，真 bug）

```diff
- Bash: ['description', 'command'],
+ Bash: ['description'],
```

- 原因：`command` 被声明为「已在一行摘要里覆盖」，导致 `deriveToolInputBody()` **不为 Bash 生成完整输入体**——**展开也看不到完整命令**。这是永久隐藏，不是截断。
- 行内 arg 允许换行显示完整命令作为轻量补充（`toolRowArgClass()` 的 `min-w-0 truncate` 需相应处理）。
- **不要用 `title` 当主解法**（触屏/键盘够不到）。
- 注意 `BashOutput` / `KillShell` 也列了 `command`，需一并判断是否同改。

### 2.8 文案

- `src/shared/i18n.ts`：新增/调整过程头词条。
- 语言跟随系统后，**中文条目必须有**（`i18nCoverage.test.ts` 会扫）。

---

## 3. 不要动的（红线）

| 项 | 原因 |
|---|---|
| `turnWorkGroupAwaitsUser` | 未应答授权强制展开。D2 之后它仍是**唯一**能自动展开组的规则 |
| 纯派生、零 `useEffect` | 021/031 共同要求。StrictMode 双跑与「重渲染关掉用户刚展开的组」在结构上不可达 |
| 原生 `<details>`，不用 `ui/collapsible.tsx` | 后者 panel 带 `overflow-hidden`，会创建 containing block 并静默破坏 `position: sticky` |
| 带授权记录的 run 不参与聚合 | 031 有意偏离，继续有效 |
| `groupTimeline` 遇 text/thinking 即 `flush()` | **已是正确行为**，连续同类聚合天然被旁白打断，不需要改（D7） |
| `turnIntermediateToneClass()` | 只改颜色不改字号，**D8 要的就是这个**，别给它降字号 |

---

## 4. 要同步退休的守卫测试

| 测试 | 位置 | 处置 |
|---|---|---|
| `[HEAD-EN-1]` | `messageTimelineWiring.test.ts:619` 附近 | **删除**，随 D7 退休 |
| `[HEAD-EN-2]` | `turnProgress.test.ts:300` 附近 | **部分删除**，见下 |
| `[WG-WIRE-2]` | `messageTimelineWiring.test.ts` | chip 断言改数量断言 |
| T096 吸顶组 | `chatTimelineLayout.test.ts` | 随 `thoughtFoldHeaderClass()` 一并删 |
| `stickyFoldScrollTarget` 相关 | `messageTimelineScroll` 套件 | 随之删 |

⚠️ **`turnProgress.test.ts` 有个坑**：那个 describe 块同时断言了两类东西——`Worked for …` 系列的英文 helper 覆盖，**以及**被 `turnWorkZoneRow` 与 Run panel 共享的中文条目。**后者不能删**（`Run panel` 仍在用）。退休时只删 `{{count}} steps processed` 相关的英文断言，保留其余。

---

## 5. 留给施工者判定的未决项

1. **思考正文高度上限取哪个值**——需在 design-system 档位内选，别与既有 `--output-max-height`（240px）/ `max-h-72` 一类值冲突或重复。
2. **`subagent-detail` 分支**在 `pinsHeader` 移除后是否仍有调用方。
3. **`turnProgress.test.ts` 的拆分边界**（见 §4 的警告）。
4. **吸顶折叠头 vs 两个 dock**（`PendingQuestionDock` / `PendingPermissionDock`，浮在 composer 上方）在窄视口下的层叠关系，**需实测**。

---

## 6. 验证

⚠️ **本机资源受限**（约 3.3 GiB RAM / 根分区约 30 GiB）。按 `AGENTS.md` 的 RESOURCE SAFETY 执行：

- 重任务前 `free -h`、`df -h . /tmp`；确认无遗留 `vite`/`vitest`/`tsc`/`esbuild` 进程。
- **禁止并行跑重任务**；测试**必须小批次**：单文件或少量相关测试，强制 `--maxWorkers=1 --no-file-parallelism`。
- **禁止本机整套生产构建**（`pnpm build` / `dist:prereq`）；确需证据时拆阶段，单阶段 `NODE_OPTIONS=--max-old-space-size=1536`。
- 每批次后复查并清理。

**建议的验证顺序**（逐项串行）：

| # | 命令 | 验什么 |
|---|---|---|
| 1 | 单文件跑 `turnProcessFold.test.ts` | 默认展开 + 终稿提取判据 |
| 2 | 单文件跑 `messageTimelineWiring.test.ts` | 头的接线与语言绑定 |
| 3 | 单文件跑 `turnProgress.test.ts` | 词条覆盖（注意 §4 警告） |
| 4 | 单文件跑 `chatTimelineLayout.test.ts` | class 断言 + T096 组已删 |
| 5 | 单文件跑 `toolCard` 相关 | Bash `command` 进输入体 |
| 6 | `pnpm typecheck`（**单独一轮，不与上面并行**） | 类型 |
| 7 | `pnpm lint` | Biome |
| 8 | 手动 `pnpm dev` | 吸顶行为、思考背景行、dock 层叠（§5.4） |

**人工验收要点**（对着决策 033 的 D1–D8 逐条看）：

- 流式中：组展开、头只报数量、**没有任何东西被提前点亮**；
- 流式完毕：**整个回合只发生一次**结构变化（组不收起 + 分隔线出现 + 终稿移出）；
- 结束后组**保持展开**；
- 滚动长过程组时头**始终可见**；
- 长命令**能看全**；
- 切换系统语言，头文案**跟着变**。

---

## 7. 参考预览（非交付物）

设计阶段做的四个 HTML 预览，仅供施工时对表，**不进仓库正式资产**（放在 `docs/examples/`，未提交）：

| 文件 | 内容 |
|---|---|
| `process-fold-preview.html` | 最早版：节拍分档对比（含一个「头一直在动」的演示 bug，已被后续版本修正，**不要参考那个行为**） |
| `process-fold-variants.html` | A/B/C 三形态对照（A=现状、B=每段一块、C=大组+可分跳），用于说明最终为何选单组 |
| `process-fold-zcode.html` | zcode 结构首版（单头 + 完成后提取） |
| `process-fold-final.html` | **最新，最接近本决策**：含缩进节拍、长指令换行、吸顶头、思考背景行 |

---

## 8. 一句话提醒

**施工前先读决策 033 的 D1 与 D3**：D1 的「终稿判据要从前瞻角度重写」是唯一会碰到 `chatTurn.ts` 契约的地方；D3 的「退休要连带测试一起删」是最容易留孤儿的地方。其余都是局部改动。
