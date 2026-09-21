# Handoff — 批次 K 续（T112～T114）工作区形态

Role: handoff。建立：2026-09-21。**执行方**：另一个 agent（或人）。**验收方**：原分析方。
任务身份与状态的权威是 [roadmap](../roadmap.md) 的「批次 K 续」一节；本文件只回答「怎么干、干到什么程度算完、交付什么」。

---

## 0. 一句话

折叠头一律只报自己的步骤数；单条过程段不再套折叠壳；回合级信息（时长 / 完成时间 / 调用次数 / 思考时长）独立成一行，钉在回合末尾，运行中转圈、结束后一行汇总。

三条任务，**必须串行**：T112 → T113 → T114。

**用户已拍板的结论不可重新讨论**，见 §2 每条的「改成什么」。演示页：[工作区钉末尾](../evidence/batch-k-answer-visibility-2026-09-21/aiclient-preview-workzone-at-end.html)（左栏现状 / 右栏目标，开关可切运行中与结束后）。

---

## 1. 开工前的硬前置

| # | 前置 | 怎么判断满足 |
|---|---|---|
| P1 | 批次 K（T107～T110）已在基线中 | `git log` 里 `1133b1de` 已是祖先 |
| P2 | 工作区干净 | `git status --short` 里 src/ 下没有别人的在途改动。**立项时工作区是干净的**，如果你开工时不是，先搞清楚那是谁的活 |
| P3 | 已看过演示页 | 左右两栏的差别能用一句话说清：折叠头的信息作用域统一了，回合级信息单独一行 |
| P4 | 行号重新定位 | 本文件与 roadmap 里的行号对应 `1133b1de`，施工前用当天 HEAD 重新定位 |

**为什么必须串行**：三条都改 `MessageTimeline.tsx`，该仓库 2026-09-19 已记录过并行改同一文件的踩踏。

---

## 2. 每个任务的交付物

**统一要求**：每条落地后 (a) 对应单文件测试通过；(b) 三套 `tsc --noEmit` 退出 0；(c) 在 §6 写一条记录。

### T112 · 单条过程段不折叠

- **改哪**：`src/renderer/components/chat/turnProcessFold.ts`（判断在哪一层做，自己定）与 `MessageTimeline.tsx` 的 `workSections.map` 渲染分支。
- **改成什么**：一个 `processGroup` **恰好 1 项**时，不渲染折叠头、不渲染箭头，直接就地渲染该项（工具行带它的主参数，思考行带时长）。**≥ 2 项**仍然合并成「N 个步骤」折叠块，维持现状。
- **这一半已经是现状，别重复造**：工具行层面早就是这个规则 —— `toolCard.ts:733` 的 `deriveToolGroupRows` 原文写着「恰好 1 条不聚合（sign-off ②/A07 :2348）」。本任务补的是**外面那层**。先读那段注释，确认你要加的判断和它不冲突。
- **必须保住**：`turnWorkGroupAwaitsUser` 的强制展开对单项组**同样生效**。如果这一项恰好是未应答的授权/问题卡，「不折叠」必须让它更可达而不是更不可达 —— 红线是「授权界面永远不能被藏起来」，方向只能是多显示。
- **必须保住**：「N 个步骤」这个词条在 1 的时候不再出现在屏幕上。顺手确认 `{{count}} step` 的单数词条是否还有别的消费者，没有就按仓库惯例退役。
- **交付证据**：一个真实回合的截图，里面**同时**有单条过程段（直接显示）和多条过程段（折叠成「N 个步骤」）。

### T113 · 工作区行钉在回合末尾

- **改哪**：`MessageTimeline.tsx`（组头的 props、末尾行的新渲染点）、`turnProcessFold.ts` 的 `deriveTurnWorkGroupLabel` 及其调用方。
- **改成什么（两件事，都要做）**：
  1. **折叠头一律只报步骤数**。删掉 `lastGroup ? workedMs : null` 那组三元 —— `workedMs` / `elapsedSeconds` / `tokens` / `thinkingMs` 不再下发给组头。组头从此只有一种形态。
  2. **回合级信息独立成一行，钉在回合末尾**（最后一段正文**之后**），两态：
     - **运行中**：转圈 + 「✻ 工作中 N 秒」。决策 031 的「工具间隙不可返回 `null`」**仍然成立**，`deriveTurnCurrentAction` 继续用，不要因为这次重排就让它在间隙里闪断。
     - **已结束**：一行汇总 `✻ 已工作 54 秒 · 完成于 17:05 · 8 次工具调用 · 思考 12 秒`。**四项都是用户点名的，不多不少 —— 不要自作主张加 token 用量。**
- **位置红线**：`PendingTurnHead`（`MessageTimeline.tsx:758`）与这一行是**接力不是并存**。`statusOwnedByPendingHead` 就是管这个交接的，**不得出现两个同时走秒的行**。这条要在测试里钉住。
- **必须改写的旧注释（不许留旧说法）**：T12-b（2026-08-29 用户拍板「跟 pi-app 一致，删掉」）删掉了回合头的结束态（原文 `Worked for Ns · 2 tools`）并把墙上时间挪进悬停条。本任务把这两样装回来，所以 `chatTimelineLayout.ts:371`、`turnHead.ts:289`、`messageMetadata.ts:199`、`MessageTimeline.tsx:90` 与 `:138` 这几处都要**改写成新规则并写明为什么推翻**。按仓库惯例保留历史脉络，**不要直接删注释**。
- **顺手更正一处过期注释**：`turnProcessFold.ts` 里 2026-09-18 写的「The composer row keeps its own count; the two are derived from different origins」**是错的** —— 那行在 T-31 §3 已搬进回合（`ChatComposer.tsx:419`，三个状态值移入 `stores/turnSendStatus.ts`）。评审时曾被这段注释误导过一次，改掉它。
- **交付证据**：同一个真实长回合的**两张**截图 —— 运行中（转圈那行在末尾）与结束后（四项汇总那行）。

### T114 · 撤掉悬停条上的时间戳

- **排在 T113 之后**，先有末尾行才谈得上重复。
- **改哪**：`MessageTimeline.tsx` 悬停动作条里的 `formatAbsoluteTime(metadata.completedAt)`。
- **改成什么**：撤掉该时间戳，悬停条只留复制按钮。`formatAbsoluteTime` 若失去最后一个消费者，按仓库惯例一并退役（不留无人消费的导出）。
- **注意**：悬停条的**高度预留**行为（2026-08-30 用户推翻过一次的那条：只淡入淡出、不推挤下方内容）**不受本任务影响**，别顺手改。
- **交付证据**：悬停一个已结束回合的截图 —— 条上只有复制按钮，时间只在末尾行。

---

## 3. 验证与报告要求

**本机资源受限**（仓库 CLAUDE.md 既有约定）：**不装依赖、不跑全量测试、不做整包构建**。

```
./node_modules/.bin/vitest run <相关单文件> --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit -p src/runtime/tsconfig.json
./node_modules/.bin/tsc --noEmit -p src/agent-host/tsconfig.json
```

全量门禁以 CI 为准，报告里写明「本机未跑」。**不要为了绕过这条去装依赖。**

**怎么起 dev 取现场证据**（这条上一轮卡了很久，写下来省你一轮）：

```
AICLIENT_MANAGED_CREDENTIALS=1 node scripts/dev.js --allow-local-credentials
```

- 仓库没有 `dev.env`；不带 `--allow-local-credentials` 会直接拒绝启动。
- **`AICLIENT_MANAGED_CREDENTIALS=1` 不能省**：省了它托管凭据会被解成关闭（`scripts/dev.js:130` 只认显式 `'1'`），登录能过但建会话会报 `auth_required: Sign-in required`。
- 首次启动需要在窗口里登录一次，凭据会写进 `~/.config/jyw-ai-client-dev/credentials/vault.json`。
- Linux 首次启动会下载 ~48MB 的 Node 运行时打包（`dist/remote-runtime/`）。**下载可能中途断**，断了单独重跑 `node scripts/build-remote-runtime-bundle.mjs --arch=x64`，成功后 dev 会命中缓存。
- 日志里 `vaapi` / `GpuControl` 两行报错是这台机器 X 环境的固有噪声，不是故障。

**报告格式**（贴在 §6）：

```
T11X
- 改了什么：（文件 + 一句话）
- 偏离：（有就写，没有写「无」，任何偏离都要写理由）
- 跑了什么：（命令 + 结果数字）
- 证据：（截图 / 录像路径）
- 不确定的：（拿不准的地方，不要藏）
```

**不许做的事**：
- 不许为了让测试变绿而放宽判据（可以改断言形状，但要在报告里说明改了什么、为什么）。
- 不许顺手「改进」相邻代码、注释或格式（仓库 CLAUDE.md §3）。
- 不许删既有注释 —— 要改就**改写并说明为什么推翻**。
- 不许用「设计值 / 推算值」充当现场证据。
- 不许给末尾行加用户没点名的字段。

---

## 4. 验收怎么判

| 任务 | 通过判据 |
|---|---|
| T112 | 单条过程段屏幕上直接可见、无箭头；多条仍折叠成「N 个步骤」；单项若是未应答授权仍强制可见 |
| T113 | 所有折叠头只报步骤数（截图里找不到第二种形态的头）；末尾行运行中转圈、结束后是那四项；`PendingTurnHead` 与末尾行不同时走秒；T12-b 那几处注释已改写 |
| T114 | 悬停已结束回合，条上只有复制按钮；`formatAbsoluteTime` 无孤儿 |

**评审方会重点查的三件事**：① 有没有偷偷扩大改动面；② 有没有为了过测试而放宽判据；③ 现场截图在不在（T113 的两态不可用单测替代）。

---

## 5. 已知的坑

1. **`MessageTimeline.tsx` 2600+ 行**，测试靠源码 AST 扫描锁字面量。改它之前先读模块注释。
2. **折叠头保持英文**（决策 031 D7），`messageTimelineWiring.test.ts` 与 `turnProgress.test.ts` 有 `HEAD-EN` 守卫钉着。末尾行是新增的，它的语言归属要先想清楚再写，别让守卫红了才回头改。
3. **`turnProcessFold.ts` 住在 `.ts` 而不是组件里**，为的是能被 node 环境 vitest 直接 import。新形状同样留在这儿。
4. **`i18nCoverage.test.ts` 只扫单引号字面量**，末尾行的新词条必须是字面量，别拼出来。
5. **`fontDomainScan.test.ts` 禁任意字号**，末尾行只能用既有 token（过程行是 `--text-chat-process`）。

---

## 6. 任务记录（施工方填写）

2026-09-21 用户拍板：单条不折叠；折叠头只报步骤数；末尾行两态；结束态四项为「时长 · 完成时间 · 调用次数 · 思考时长」，不挂 token 用量。悬停条时间戳撤除为评审方建议、用户未反对。

---

### T112

- **改了什么**：`turnProcessFold.ts` 新增纯判据 `turnProcessGroupFolds`（步骤数 > 1 才折叠）；`MessageTimeline.tsx` 的 `workSections.map` 在构造组头之前提前返回，把单步组的段落就地渲染成 `<Fragment>`；`{{count}} step` 单数词条随其最后一个消费者退役（`i18n.ts`、`toolVocabulary.test.ts` 同步）。
- **偏离**：无。判据放在 `turnProcessFold.ts` 而不是 `splitTurnWorkGroup` 里，是为了不动分段形状（`splitTurnWorkGroup` 的 12 条既有用例逐字保持）；阈值用**步骤数**而不是 item 数，因为折叠头打印的就是步骤数，两者必须同源，否则会出现「头说 4 个步骤、判据说只有 1 项」。`turnWorkGroupAwaitsUser` 一个字节未改。
- **跑了什么**：`vitest run turnProcessFold messageTimelineWiring toolVocabulary --maxWorkers=1 --no-file-parallelism` → 104 通过（其中新增 4 条 `[WG-ONE-*]` + 1 条 `[WG-WIRE-4b]`）；`vitest run i18nCoverage chineseChatSurface turnProgress` → 36 通过。三套 `tsc --noEmit`（根 / runtime / agent-host）退出 0。改动 6 个文件 Biome `check` 通过。**本机未跑全量 Vitest / Biome / 打包，CI 是权威，本轮未触发 CI。**
- **证据**：[t112-single-step-inline-vs-folded.png](../evidence/batch-k-answer-visibility-2026-09-21/t112-single-step-inline-vs-folded.png) —— 真实会话（`读一下 …turnProcessFold.ts 和 MessageTimeline.tsx`，58 分钟前的真实回合）在当前源码 dev 实例里的样子：同一个回合里，单条过程段的 `已思考` 直接显示在正文之前，再往下是多条合并成的 `10 steps processed ›` 折叠块。同一时刻的 DOM 取证：第一段的外层元素 `hasSummary: false`（没有折叠头），折叠块是 `<details open=false>` 且 `summary` 带 chevron。
- **不确定的**：
  1. 截图里那条「单条过程段」是**思考行**，不是工具行 —— 这是该真实回合恰好的形态。它自带的 `⌄` 是思考卡自己的展开箭头（`ToolRows` 的 thought fold header），不是本任务撤掉的那层折叠头；改动前这里会是「`1 steps processed ›` 里套着 `已思考 ⌄`」两层。没有另造一个真实回合去凑「单条工具行」的形态。
  2. 该会话是**恢复的历史回合**（无回放计时），所以折叠头走的是步骤数分支。运行中的回合同样只可能出现 ≥2 步的折叠头，但这条是推理，不是这张截图直接证明的。
