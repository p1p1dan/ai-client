# 决策 131：插件工具行用插件自带的标题（`presentCall`）；分叉旧会话迁移后以新发的第一条消息命名——两个小任务的实现取舍

日期：2026-09-29。**状态：自主决定，待用户审批。**

依据：
- 用户裁决：[决策 130](130-user-rulings-2026-09-29-batch3.md)「120 第 27 条顺手做」「123 得区分，用用户新发送的内容做标题」；[090](090-user-rulings-2026-09-28.md)（默认跟随 DSH）；
- 已批准的决策：[073](073-tool-rows-and-present.md) 第 1 条（插件行优先用 `presentCall` 的标题与类别；标题是插件自己的英文，不翻译）、[099](099-p1-4d-scope-dsh-data-only.md)、[106](106-p1-4d1-live-mapping-choices.md) 第 2、3 条（直播与历史共用规则；bridge 包只能收 bridge / agent-host / shared 的源码）、[115](115-p1-10d-pilot-plugin-choices.md)（试点插件 `dsh-office-tools` 的 8 个工具）、[120](120-p1-7c-tool-rows-choices.md) 第 10、27 条、[122](122-p1-9d-migration-orchestration-choices.md) 第 8、9 条（`<逻辑 id>_pi`、`commitMigrated`）、[123](123-p1-9e-migration-renderer-choices.md) 第 13 条与「遗留」的分叉标题；
- 方案：[P1-7 分片 03](../topics/p1-7-renderer/03-panels.md) §2 的 `tool.started/updated.presentation` 行（`{card, title, kind?, description?}`，取自 `ctx.tools.get(name, agent).presentCall(args)`）、[分片 04](../topics/p1-7-renderer/04-tool-rows-windows.md) §5；
- DSH 源码（钉版本 0.1.7-rc.2，路径省略 `src/dsh-host/node_modules/@deepseek-ai/`）：`dsh-tools/lib/types/index.d.ts` 的 `presentCall`（「纯函数，UI 可以在直播和回放日志时调用，只依赖参数」）与 `get(name, scope)`（「Presenters pass the calling agent」）；`dsh-tools/lib/types/presentation.d.ts` 的三种卡片；`dsh-tools/README.md`「Host presentation descriptors」（给宿主侧消费者用，官方 Web 客户端不读）；`dsh-tools/lib/index.js` 的 `defineTool`（参数不合 schema 时 `presentCall` 答空）；`src/dsh-host/node_modules/dsh-office-tools/lib/index.js` 8 个工具的 `presentCall`（`Create <path>` / `Update <path>` 的类别 `edit`，`Read <path>` 的类别 `read`）。

改动留在工作区，由编排者复跑后提交。没有起 Electron、没有做 GUI 点验（本机硬规则），界面只由挂载测试验证。**第 7、15、17 条请重点审批。**

## 规则

### 一、插件工具行的标题（决策 120 第 27 条，用户裁决「顺手做」）

1. **字段形状照分片 03 §2**：`tool.started` / `tool.updated` 的 payload 加可选的 `presentation: {card, title, kind?, description?}`（`src/shared/dshToolPresentation.ts` 的 `ToolCallPresentation`）；历史的 `tool_call` 块加同名字段；渲染层 store 存为 `ChatBlock.toolPresentation`，行模型读 `ToolRun.presentation`。
   - 只保留卡片类型（`generic` / `terminal` / `diff`）、标题、`generic` 卡的类别、`terminal` 卡的一句说明；DSH 视图里的 `rawInput`、`content`、`locations` 与 `diff` 卡的 `diffs` 都丢掉（`diffs` 带着整份新文件内容，按事件发出去太重，行也用不上）；
   - 插件写的答复按不可信数据读（`narrowToolCallPresentation`）：不认识的卡片或没有标题就当没有；不认识的类别省掉；标题与说明压成一行、去首尾空白，超过 200 个字符（按码点）截断加「…」。
2. **只问不是 DSH 自带的工具**：DSH 自带工具的清单（`DSH_BUILTIN_TOOL_NAMES`）就是闸门 `DSH_TOOL_CLASSES` 的键，在 shared 里留一份副本，测试钉住两者相等、且与白名单插件的工具不重名。
   - 副本的理由同决策 106 第 3 条：bridge 包不能引用 `permissions` 行的源码；
   - DSH 自带工具的行维持 P1-7c 的词条，渲染层也再挡一次（即使收到 `presentation` 也不用）；
   - 结果：录制的 28 个场景没有插件工具，金样本一个字节不变（见「测试与录制」）。
3. **只在参数齐了时问**：流式块结束时（行已开则发 `tool.updated`，没开则 `tool.started`）和开出这一行的持久 `tool/call` 上带；参数流式期间的大小摘要不带（`presentCall` 要校验完整参数，半截 JSON 问不出东西）。同一调用只带一次，持久 `tool/call` 在流已结束时照旧不重发。
4. **问谁、经谁问**：注册表经 `ctx.get('tools')` 取，不加进 bridge 行的 `inject`（行的启动不必等它，构建库测试钉住的注入清单不变）。
   - 直播与会话自己的历史缓存经会话的 agent 问（`ctx.tools.get(name, agent)`，DSH 注明「Presenters pass the calling agent」）；
   - Main 的预览（`readPage`）没有打开任何 agent，用注册表的全局视图。白名单插件的工具注册在全局层，两种问法答案相同。
5. **历史同样带上**：DSH 日志不记呈现，但 `presentCall` 按 DSH 的约定是只依赖参数的纯函数，所以历史投影在回放时问同一个 presenter（`DshHistoryFoldOptions.presentCall`），重开会话看到的就是直播看到的（106 第 2 条）。
   - 会话树（`lineage`）、金样本的投影测试不传 presenter，照旧没有这个字段；
   - 代价：插件后来被关掉，或者在没有这个插件的宿主里预览，重开的行就没有标题，退回词条或兜底（见第 10 条）。
6. **插件出错不伤行**：查注册表抛错、`presentCall` 抛错、答复不合形状，都只是这一行没有标题，行照常出现、参数照常更新。
7. **行上用标题替换「动词 + 参数」，不是「动词 + 标题」**（请重点审批）。行读作「图标 + 插件自己的标题」，例如 `✏ Create report.docx`、`📄 Read report.docx`，标题原文不翻译（073 第 1 条）。
   - 分片 04 §5 原写「图标与动词按类别，参数摘要显示标题」。但插件的标题本身以动词开头，那样中文界面读作「编辑 Create report.docx」「读取 Read report.docx」，英文界面读作「Edited Create report.docx」「Read Read report.docx」，每行都把同一件事说两遍；
   - DSH 自己的卡片也是「类别图标 + 标题」作卡头（090 默认跟随 DSH）；
   - 行模型仍算出动词（`ToolRowView.verb`），供不画行、只报动作的地方用（回合头「工作中 · 编辑」）；
   - 备选（若不同意）：删掉 `ToolRowView.title`、在 `deriveToolRowView` 里把标题放进 `arg`，即退回分片 04 §5 的「按类别的动词 + 标题」，约 20 行改动。
8. **图标先看卡片、再看类别**：`terminal` → 终端；`diff` → 编辑；`generic` 的类别 read → 文件、edit / delete / move → 编辑、search → 搜索、execute → 终端、fetch → 网页；`other` 或没写类别时用这个工具原来的图标（office 工具是它们的词条图标，其余是扳手）。
9. **插件的命令（`terminal` 卡）按 shell 行读**（分片 04 §5）：「终端 + 命令摘要」（与 bash 同样剥 `cd … &&` 前缀、截 40 字），不用标题替换；卡片的说明不上行（与 073 第 2 条一致），展开体仍是原始参数。
10. **标题压过插件自己的词条**：office 工具有「读取 / 编辑」词条（决策 120 第 10 条），有标题时仍用标题（用户要的就是插件自带标题）；没有标题的调用（插件关着的宿主里读的历史、本决策之前的直播）照旧读作「读取 / 编辑 + 短路径」。未登记的插件工具没有标题时仍是「工具 + 工具名」兜底。
11. **标题的样式**：与动词同色（行的语气，悬停变亮）、单行截断（插件写的文字，里面可能有长路径），无衬线字体（`toolRowTitleClass`）。不改展开体：office 写入仍展开出要写的内容，读行仍不给文件链接（编辑器打不开 docx / xlsx / pptx）。
12. **回合头的动作短语不改**：回合进行中「工作中 · …」用的是按工具名的动词（`deriveTurnCurrentAction`），office 工具读作「编辑 / 读取」，未登记的插件工具读作「工具」。不为它另接标题：那一行只放一个两字动作。

### 二、分叉旧会话继续后的标题（决策 123 待定项，用户裁决「用新发送的内容做标题」）

13. **做在哪一层**：迁移提交时由 Main 在同一次原子写里给新会话一个过渡标题并记下「等第一条消息命名」（`SessionIndexEntry.forkTitlePending`）；渲染层在这个会话第一条被接收的消息之后改名。
    - 理由：与迁移同一次写入，不会出现「迁移了但没标记」；标记落盘，重启、以及不经发送触发的迁移（打开会话分支、`/compact`、卡片「重试」，决策 123 第 9 条）之后都还在；
    - 迁移提交后恢复失败、答复没回来的情形（123 第 12 条），渲染层下次合并索引时照样拿到过渡标题与标记。
14. **怎样认出分叉**：被迁移的这一行的键，被另一条 `dsh` 行的 `migratedFrom.legacySessionId` 指着（也就是它是某个已迁移会话留下的旧行，1.0.x 回装后又续写过）。
    - 不看这一行自己的 `migratedTo`：1.0.x 的索引按字段重建行，可能丢掉它；`listForDisplay` 判定分叉用的也是 `dsh` 行这一侧的指针。
15. **过渡标题：原标题 + 「（1.0.x 分支）」**（请重点审批）。键 `'{{title}} (1.0.x branch)'`，中文 `'{{title}}（1.0.x 分支）'`（`LEGACY_FORK_TITLE_KEY`）。
    - 由 Main 按当时的界面语言（`getCurrentLocale`）写成字符串存进索引，之后切换语言不改写它：它就是这个会话的名字，与用户改过的标题同等对待；
    - 原会话没有标题时不加后缀、标题留空（侧栏按 id 尾巴显示「Session …」，两个会话的 id 尾巴本来就不同），仍然记下「等第一条消息命名」。
16. **原会话不改名**；这次迁移新留下的旧行（`<id>_pi_pi`）也保留原标题，回装 1.0.x 时看到的还是它自己的名字。
17. **第一条消息的取标题规则与新会话相同**（请重点审批）：`deriveSessionTitleFromFirstMessage`，第一句、去掉 Markdown 前缀、压空白、60 个码点截断。
    - 只算迁移后第一条被接收的消息（与新会话「只看第一条」一致）：不论它能不能取出标题，发出后都结束等待；
    - 取不出（只有图片、只有符号）时保留过渡标题，并把它原样写回一次，用来在 Main 里清掉标记；
    - 不看「历史里有没有用户消息」（分叉会话一定有），每次被接收的发送都调用 `applyForkSessionTitle`，不在等待中的会话直接不做事。
18. **任何改名都结束等待**：Main 的 `rename` 清掉 `forkTitlePending`，所以用户在发第一条消息之前手动改的名字不会再被覆盖；`recordCreated` 重新登记时保留标记。
    - 渲染层在改名返回后重读 store，用户同时手动改过名（索引刷新已清掉标记）就不再覆盖本地显示；
    - 已知残留与 `applyAutoSessionTitle` 相同：两次改名 IPC 在 Main 里没有比较后写入，毫秒级窗口内以后到者为准。
    - 改名失败时标记还在，下一条消息再试。
19. **渲染层怎么马上知道**：恢复答复的 `migration` 摘要多一个 `fork: {title}`（只在分叉迁移时出现），渲染层据此立刻把本地这一行改成过渡标题并标记等待，侧栏不必等下一次刷新索引就能区分两个会话；重启后由合并索引按行上的 `forkTitlePending` 重算（与 `legacyDiverged` 同一种做法）。

## 取舍

- **标题替换动词还是跟在动词后（第 7 条）**：替换让每行只说一遍，代价是插件行没有两字中文类型，与左右的「图标 + 两字类型」行形状不同（120 第 27 条当时也写了「英文标题与中文类型行混排」这一代价）。
- **过渡标题由 Main 写还是渲染层显示时拼（第 15 条）**：显示时拼要在侧栏、标签、搜索、窗口标题等每个显示标题的地方加判断；存进索引只有一处，代价是语言切换后不跟着变。
- **分叉会话第一条消息取不出标题时（第 17 条）**：备选是一直等到有一条能取出标题的消息。那与新会话的规则不一致，也会让过渡标题在用户已经聊了很多轮之后突然变掉。

## 测试与录制

- **bridge**：`toolPresentation.test.ts`（新：清单与闸门表相等、窄化规则、只问非 DSH 工具、经会话 agent 问、查询或插件抛错不伤行）；`liveEvents.test.ts` 加 `[D131-LIVE-1～4]`（流式只在块结束时带、持久 `tool/call` 开行时带且与历史相同、DSH 工具与无 presenter 不带、presenter 抛错行照常）；`historyCache.test.ts` 加 `[D131-CACHE]`；`readPage.test.ts` 加 `[D131-PREVIEW]`（预览与缓存逐页相同，无 presenter 不带）。
- **投影**：`projection.test.ts` 加 `[D131-HIST-1～3]`。
- **渲染层**：`pluginToolTitle.test.ts`（新：行模型 10 例表驱动，含 office 有无标题、未登记插件、类别图标、`terminal` / `diff` 卡、DSH 工具被挡；运行中 / 被拒 / 未执行各态；展开体不变；store 的 `tool.started` / `tool.updated` / 历史回放；挂载后 DOM 只画标题）；`legacyMigration.test.ts` 加 `[D131-FORK-1～4]`；`agentBindingMerge.test.ts` 加 `[D131-MERGE]`；`chatSessionActions.test.ts` 加 `[D131-TITLE-1～5]`（取新消息做标题、取不出保留后缀、不在等待的不改、改名失败下次再试、用户改名优先）。
- **Main**：`SessionIndexService.test.ts` 加 `[D131-INDEX]`、`[D131-INDEX-UNTITLED]`（分叉提交写过渡标题与标记、原会话与新旧行不变、重新登记保留、改名清除、未命名分叉）；`LegacyMigrationService.test.ts` 加 `[D131-SUMMARY]`、`[D131-WORDING]`，原有的提交参数断言补上 `forkTitle`。
- **冒烟**：bridge-smoke 宿主 I 新判据 `pilotRowsTitled`：`word_create` 行带 `Create p0-report.docx`（类别 edit）、`word_read` 行带 `Read p0-report.docx`（类别 read），`worker.history` 的两行相同，其余宿主的任何行都不带。
- **录制**：`bridge-record.ts --check` 28 个场景无差异，没有重录，也没有写 `src/shared/__tests__/fixtures/`。

## 影响与遗留

- **GUI 点验没做**：插件行的标题样式（深浅两套主题下与动词同色、截断）、分叉会话在侧栏的过渡标题与改名，留给 P1-7d 一起看。
- **子代理泳道**：插件工具注册在全局层，子代理也能调用；泳道里这类行不带标题（`subagent.activity` 这条路没有接），读作词条或「工具 + 工具名」，与主时间线不一致。本任务不做。
- **修订注记**：决策 073（第 1 条前半已落地）、120（第 27 条已做）、123（分叉标题已定）。
