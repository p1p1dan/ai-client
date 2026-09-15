# 批次 D 区域审查：渲染层工具词汇表全量比对（T029）

- 区域：chat-tool-vocab
- 任务：T029（批次 D 审计覆盖补全）· 对应批评者缺口 8（`cross-and-critic.md:71`，GAP [P4-5 / P6-3 第 4 条]）
- 判定节点：P4-5、P6-3 第 4 条、P5-2-6
- 基线 HEAD：`ebc82f16`
- 日期：2026-09-15
- 方式：只读。未构建、未跑测试、未起 Electron。全部结论来自源码阅读，外加一次纯字符串运算的 `node -e`（`mcpToolName` / `mcpToolLabel` 的往返）。

## 总评

T020（`60b250f3`）补的那一批是**真的补上了**：`glob`、`browser_preview`、`ask`、`skill`、`new_context`、`TaskWait` / `TaskList` / `TaskStop` 与 `mcp__*` 前缀，在**动词表**和**参数映射**这两个查表点上已经全部命中，主时间线与子代理面板共用同一个 `deriveToolRowView`，所以两面同时生效，`runtimeToolVocabulary.test.ts` 也把这两面都钉住了。批评者当时说的「这些工具行全显示成 Ran」在当前 HEAD 上不再成立。

但「全量比对」一做完，会发现 T020 补的是**两个**查表点，不是六个。剩下的四个里有三个仍在漂：

1. **命中列表**（`isHitListTool`）自 T-05 起一个字没动，只认大写 `Grep` / `Glob`。native 的 `grep` / `glob` 行因此没有悬停命中列表、也没有从命中列表点开文件的入口——而同一个窗口里**导入的 Claude 会话**的 `Grep` 行反而有。这是一处用户可见的功能缺失，且方向刚好和「自有 runtime 是主路径」相反。
2. **审批卡**对 `read` / `glob` / `grep` / `browser_preview` 这类只带 `path` 的门，**从不显示被批准的路径**。生产者把 `path` 放进了 `input`，还在注释里写「a read or a glob is fully described by its path」，消费者却只读 `content` / `command`。工作区外读一个文件时，卡上只有「read — 读取文件内容」和工作区名，用户是在盲批。
3. **参数文案的语言**。T020 为 `new_context` / `TaskWait` / `TaskList` 现写的四段 arg 文案是裸英文字面量，从不过 `t()`，在中文界面里拼成「已开新上下文 a fresh window」这种半中半英的行。守卫（`toolVocabulary.test.ts`）只查动词，查不到 arg。

另外两个次要面——子代理面板表头和右侧 Run 面板——直接把 wire 名打在屏幕上（`mcp__github__create_issue`），和它们下面/旁边那行的「调用中 github · create_issue」自相矛盾。

关于任务点名的另外三个小问：
- **(a) 大小写与前缀规则**：native 只注册小写名 + `Task*` 四个大写名 + `mcp__` 前缀；`Task` 与 Claude 期同名同义，共用一条分支，没问题。`mcp__` 的拆分规则在服务器名含 `__` / 结尾是 `_`、或全名超 64 字节被 `slice(0,64)` 截断时会错拆或截断（已实测字符串运算），只影响显示。
- **(b) 已删工具的死分支**：**没有**。大写 Claude 名（`Read` / `Bash` / `TodoWrite` / `Glob` …）今天仍有活生产者——`ClaudeSourceAdapter.ts:406` 把 `item.name` 原样写进导入条目，`piSessionTimeline.ts:190-210` 再把它还原成 `tool_call` 块；pi 的小写内置名（`find` / `ls` / `powershell`）则由 `plugins/session/legacy.ts:420-427` 的旧会话转换保留。把这两套词汇当死代码删会直接打坏导入与回放。唯一真正无消费者的是 `turnTiming.ts` 里那组回合摘要函数（连同它只认大写名的 `EDIT_TOOL_NAMES`），而 `MessageTimeline.tsx:118-121` 的注释还写着它们「仍被用」。
- **(c) 参数键改名后的旧会话回放**：查过 `plugins/tools/index.ts` 自 P5 以来的全部提交（`c4e2b2e4` / `1262e3b0` / `439ab922` / `5b305fdb`），**没有任何一次改过参数键**；T012 改的是 `details` 形状，`bash` 只是**新增** `timeoutSeconds`。渲染层对两套方言（`path`/`file_path`、`oldText`/`old_string`）本来就双读。这一项干净。
- **(d) 权限 surface 名与卡文案键的对应**：`permissionPrompt.ts:74-87` 的 `actionOf` 只给 `bash`/`write`/`edit`/`read` 四个句子，其余发 `undefined`——这是 `runtimeEvents.ts:348-358` 明文写下的取舍（「宁可少说，不要说错」），不立发现。真正的错位在活动行：`activity.ts:61` 用 `request.tool` 当 surface、`:50` 用 `command ?? path` 当 value，于是 MCP 那行把**工作区路径**当成「被评估的值」印出来，而策略作者写规则用的 `mcp` / `github:create_issue` 两个词一个都没出现。

## 优点

- 一套派生、两个surface：`subagentActivityModel.ts:756` 让面板子行走 `deriveToolRowView`，所以动词/参数表补一次两面都好，`runtimeToolVocabulary.test.ts:140-210` 明确把「同一个词到两个面」写成了用例。这是把上一次漂移（subagent-data-06）修对了的地方。
- `RUNTIME_TOOL_NAMES` 与 `PI_TOOL_NAMES` 分成两张表且各自写清出处（`piToolNames.ts:24-69`），没有把「SDK 的 find」和「我们的 glob」混成一张表。
- `mcpToolLabel` 用前缀而不是枚举来认 MCP 工具，是这一类「名字在运行期合成」的唯一正确解法。
- `toolDiff.ts:224-236` 对 `oldText`/`old_string` 两套方言双读，并且自己写了「只认小写会让这份宽容不可达」的理由——旧会话回放这条线是被认真想过的。
- `deriveToolRowView` 在 `review` 存在时短路掉行内 diff（`toolCard.ts:528-532`），把变更交给右侧审阅栏，不是漏改而是 `6be1d70a` 的有意设计。

## 弱点

- 查表点的清单从来没有被写下来过。T020 补了两个点就收工，剩下四个（命中列表、审批卡、活动行、面板表头）没人列过，所以也没人发现它们没补。`runtimeToolVocabulary.test.ts` 只断言「这几个名字有动词/有参数」，不断言「注册表里的每个名字在每个查表点都有着落」。
- 中文化的守卫只盖住动词（`toolVocabulary.test.ts:43-52`），arg 文案与审批卡的 `contentLabel` 都在盲区，两处都已经漏了字（`a fresh window`、`Skill`）。
- 三个surface（子代理面板表头、Run 面板、权限活动行）直接打印 wire 标识符，等于把协议词汇泄漏到界面上。

## 节点判定

| 节点 | 判定 | 理由 |
|---|---|---|
| P4-5 | complete-with-gaps | 主时间线的动词/参数已随 T020 补全并有用例（`runtimeToolVocabulary.test.ts`）；但命中列表（chat-tool-01）、审批卡路径（chat-tool-02）、arg 文案语言（chat-tool-03）三处仍是用户可见漂移，都落在「GUI 无回归」这条结论的覆盖面内。 |
| P6-3 第 4 条 | complete-with-gaps | 退役没有在词汇层留下死分支——大写 Claude 名与 pi 小写名都还有活生产者（导入与回放），这一点复核后可以结案；但退役后主路径（native）在命中列表与审批卡两处的表现弱于导入来的旧会话（chat-tool-01/02），第 4 条「GUI 无回归」在词汇维度上不能判完成。 |
| P5-2-6 | complete-with-gaps | 面板子行复用主时间线派生，T020 之后动词与参数都对（chat-tool-01/03 的影响与主时间线同源，不额外记在本节点）；本节点自有的缺口是表头直接显示原始工具名（chat-tool-05）。 |

## 发现

### 全量比对表

行=native 注册的工具（`plugins/tools/index.ts`、`subagent/index.ts:80-83`、`skills/index.ts:288`、`mcp/index.ts:149`），列=六个查表点。✓=命中，✗=漂移（括号内为发现编号），n/a=该工具与这个查表点无关，（设计）=经代码注释确认的有意取舍。

| 工具 | 动词表 | 参数映射 | details 读取 | 子代理面板 | 权限行 / 卡 | 命中列表 |
|---|---|---|---|---|---|---|
| `read` | ✓ | ✓ | ✓（文件链接 `deriveFileLink`） | ✓ | ✗ 卡有句子无路径（02） | n/a |
| `write` | ✓ | ✓ | ✓（`review` → 审阅栏） | ✓ | ✓ file_change 卡带路径 | n/a |
| `edit` | ✓ | ✓ | ✓（`review`；旧会话 `patch` 分支保留） | ✓ | ✓ | n/a |
| `bash` | ✓ | ✓（`timeoutSeconds` 不在 ARG_COVERED → 按设计展开输入体） | n/a | ✓ | ✓ exec 卡带命令 + cwd | n/a |
| `glob` | ✓ | ✓ | n/a | ✓ | ✗ 卡只有工具名（02） | ✗（01） |
| `grep` | ✓（与 `PI_TOOL_NAMES.grep` 同名命中） | ✓ | n/a | ✓ | ✗（02） | ✗（01） |
| `ask` | ✓ | ✓ | n/a | ✓ | 不过门（设计） | n/a |
| `browser_preview` | ✓ | ✓ | n/a | ✓ | ✗ 卡只有工具名（02） | n/a |
| `skill` | ✓ | ✓ | n/a | ✓ | ✓ 有正文，标签未翻译（04） | n/a |
| `new_context` | ✓ | ✗ 文案裸英文（03） | n/a | ✓ | 不过门（设计） | n/a |
| `Task` | ✓（沿用 Claude `Task` 分支） | ✓ | n/a | ✓ 挂面板 | 不过门（设计） | n/a |
| `TaskWait` | ✓ | ✗ 文案裸英文（03） | n/a | ✓ | 不过门 | n/a |
| `TaskList` | ✓ | ✗ 文案裸英文（03） | n/a | ✓ | 不过门 | n/a |
| `TaskStop` | ✓ | ✗ 文案裸英文（03） | n/a | ✓ | 不过门 | n/a |
| `mcp__*` | ✓（前缀） | ✓ `mcpToolLabel`（边界错拆/截断，09） | n/a | ✗ 表头打 wire 名（05） | ✗ 活动行 value 是 cwd（06）；卡无句子（设计） | n/a |

---

### [chat-tool-01] medium correctness | P4-5 / P6-3 第 4 条 | src/renderer/components/chat/toolCard.ts:628 | 命中列表只认大写 `Grep` / `Glob`，native 的每一次搜索都没有命中列表

DESC：`isHitListTool` 自 T-05 首次写下（`340a59a7`）到今天一个字没改，只匹配 Claude 期的大写名。native 注册的是小写 `grep` 与 `glob`，于是 `deriveToolRowView` 的 `hitSource` 恒为 `undefined`，`ToolRows.tsx:309` 的 `HitListPopover` 分支永远不进——搜索行退化成一个普通的可展开行。T020 补了 `glob` 的动词与参数，但没有补这个查表点。反过来说，**导入的 Claude 会话**里的 `Grep` 行是有命中列表的（`ClaudeSourceAdapter.ts:406` 原样保留大写名，`piSessionTimeline.ts:190` 还原成 `tool_call`），所以同一个窗口里旧会话比主路径能力更强。

EVIDENCE：
```ts
// src/renderer/components/chat/toolCard.ts:627-629
function isHitListTool(toolName: string): boolean {
  return toolName === 'Grep' || toolName === 'Glob';
}
// src/renderer/components/chat/toolCard.ts:523
  const hitSource = isHitListTool(run.toolName) ? run.output : undefined;
```
```ts
// src/renderer/components/chat/ToolRows.tsx:309-315
  if (view.hitSource) {
    return (
      <HitListPopover
        source={view.hitSource}
        onOpenFile={onOpenFile ?? ((target) => openFileTarget(target, 'hit-list'))}
```
native 的输出形状与解析器是对得上的：`grep` 产出 `path:line:text`（`plugins/tools/index.ts` 的 `matches.push(...)`），命中 `toolHits.ts:66` 的 `CONTENT_LINE_RE`；`glob` 产出每行一个绝对路径，命中 `PATH_ONLY_RE`。也就是说这不是「解析不了」，是「根本没被调用」。

SCENARIO：用户让 agent 在仓库里搜 `TODO`。行显示「已搜索内容 TODO in ai-client」，鼠标悬停没有任何命中列表弹层，也无法从命中直接打开文件——只能展开行去读一整片纯文本输出。同一会话里若导入过一个 Claude 会话，那边的 `Grep` 行悬停就有列表。

FIX：把判定改成 `new Set(['Grep','Glob', PI_TOOL_NAMES.grep, PI_TOOL_NAMES.find, PI_TOOL_NAMES.ls, RUNTIME_TOOL_NAMES.glob])`（与 `SEARCH_TOOL_NAMES` 同源更好：让 `isHitListTool` 直接复用 `classifyTool(name) === 'search'` 去掉第二张表）。顺手把 `toolHits.ts:68` 的 `NOISE_RE` 加上 native `glob` 的空结果文案 `No files matched.`，否则零命中会被算进解析分母。用例：给 `deriveToolRowView` 补一条 `grep` / `glob` 的 `hitSource` 断言（现有 `toolCard.test.ts:631` 那条只覆盖大写名）。

---

### [chat-tool-02] medium contract-gap | P4-5 | src/renderer/components/chat/questionCardModel.ts:771 | 只带路径的审批卡（read / glob / grep / browser_preview）从不显示被批准的那个路径

DESC：`permissionPrompt.ts` 把 `path` 放进了 `permission.requested` 的 `input`，`ToolPermissionRequest.preview` 的注释还专门写了「a read or a glob is fully described by its path」——也就是生产者认为路径是这张卡的正文。但消费者两条路都不读它：`derivePermissionContent` 只看 `input.content` 和 `input.command`；`derivePermissionDetailView` 只在 `permissionDetail` 存在时才有正文，而 `detailOf` 对 `bash`/`write`/`edit` 之外的工具返回 `undefined`。`QuestionCard.tsx:663-690` 渲染的四块内容（prompt / content / detail / workspace）里没有一块会打印 `input.path`。结果：`read` 的卡有句子没对象，`glob` / `grep` / `browser_preview` 的卡连句子都没有（`actionOf` 返回 `undefined`，这一半是 `runtimeEvents.ts:354-357` 记过的取舍），只剩一个裸工具名。已决状态同样如此——`derivePermissionRowView:899` 的 arg 就是同一个 prompt。

EVIDENCE：
```ts
// src/renderer/worker 侧生产者：src/runtime/worker/permissionPrompt.ts:166-173
            input: {
              ...(request.path ? { path: request.path } : {}),
              ...(request.command ? { command: request.command } : {}),
              ...(request.preview
                ? { content: request.preview.text, contentLabel: request.preview.label }
                : {}),
              workspace: options.cwd,
            },
```
```ts
// 消费者：src/renderer/components/chat/questionCardModel.ts:771-782
export function derivePermissionContent(block: ChatBlock): { label: string; text: string } | null {
  const content = readInputField(block.toolInput, 'content');
  if (content) { ... }
  if (block.permissionDetail?.kind === 'exec') return null;
  const command = readInputField(block.toolInput, 'command');
  return command ? { label: 'Command', text: command } : null;
}
```
```ts
// 同一张卡的 detail 半边为何也是空：src/runtime/worker/permissionPrompt.ts:104-115
  if (request.tool === 'write' || request.tool === 'edit') { ... }
  return undefined;
```
门确实会开：`plugins/permissions/index.ts:317-325` 在 `!containsPath(this.config.cwd, request.path)` 时先返回 `'ask'`，**早于**下面 `['read','grep','glob'].includes(request.tool)` 的放行分支。

SCENARIO：用户说「看一下 ~/.config/foo/settings.json 里写了什么」。审批卡显示：标题「需要你的批准」、正文一行「read — 读取文件内容」、底部「Project: /home/ai/code/ai-client」、倒计时。**卡上没有任何地方出现 `~/.config/foo/settings.json`**。用户要么盲批，要么退回去翻上一条消息猜模型要读哪个文件。`browser_preview` 更糟：正文只有 `browser_preview` 一个词。

FIX：两种改法，选一种即可。(a) 渲染层：`derivePermissionContent` 在没有 content/command 时回落到 `input.path`，标签用新词条 `'Path'`（与 `'Content'` / `'Command'` 同款，走 `t()`）；(b) 生产者：`detailOf` 对带路径的非 exec 工具返回一个轻量 detail（例如 `{kind:'file_change', changes:[{path, change:'read'}]}` 需要扩 union，成本更高）。推荐 (a)，一处改动覆盖 read/glob/grep/browser_preview 与将来任何只带路径的工具。用例：`questionCardModel.test.ts` 补一条「read 门的卡上出现路径」。

---

### [chat-tool-03] medium i18n | P4-5 / P5-2-6 | src/renderer/components/chat/toolCard.ts:1175 | T020 新写的四段 arg 文案是裸英文，中文界面出现半中半英的工具行

DESC：`ToolRowView.arg` 的契约是「离开这个模块时必须是成品文本」（`ToolCardOptions.t` 的注释），`ToolRows.tsx:138` 只对 `verb` 调 `t()`，对 arg 是 `{view.arg}` 直出。`formatToolArgDetail` 里只有 `inRepo()` 一处用了 `t`；T020 为 `new_context` / `TaskWait` / `TaskStop` / `TaskList` 现写的四段文案全是字面量，既没过 `t()`，`zhTranslations` 里也没有对应词条（已逐条 grep 确认）。守卫 `toolVocabulary.test.ts` 只扫动词表，`i18nCoverage.test.ts` 只扫字面量 `t('…')` 调用，两边都看不见它们。同类的 `'working directory'`（pi `ls`，回放旧会话时可达）是同一处遗留。

EVIDENCE：
```ts
// src/renderer/components/chat/toolCard.ts:1172-1192
    case RUNTIME_TOOL_NAMES.newContext:
      raw = 'a fresh window';
      break;
...
    case RUNTIME_TOOL_NAMES.taskWait:
    case RUNTIME_TOOL_NAMES.taskStop: {
      const ids = rec?.delegationIds;
      raw = Array.isArray(ids) && ids.length > 0 ? `${ids.length} delegation(s)` : 'all running';
      break;
    }
    case RUNTIME_TOOL_NAMES.taskList:
      raw = 'running subagents';
```
`zhTranslations` 里 `a fresh window` / `all running` / `running subagents` / `delegation(s)` 零命中（`src/shared/i18n.ts`，同一段里 `已开新上下文` 等动词都在：`i18n.ts:2427-2447`）。

SCENARIO：中文界面下模型压缩上下文并等待两个子代理，时间线读作：
- 「已开新上下文 a fresh window」
- 「已等待子 Agent 2 delegation(s)」
- 「已列出子 Agent running subagents」

动词是中文，宾语是英文，且 `(s)` 这种英文单复数写法在中文里没有意义。这正是 2026-09-11 现场报告抓过的那一类（当时是 Grepped / Ran / Edited）。

FIX：四处都改成 `t()`，其中计数那条按仓库既有惯例拆单复数两个键（参见 `deriveAggregateRow` 的 `'{{count}} file'` / `'{{count}} files'`），并补 `zhTranslations` 词条。守卫侧：把 `toolVocabulary.test.ts` 扩成也断言 arg 常量集合有词条，或把这四段文案提成导出常量再纳入现有断言。

---

### [chat-tool-04] low i18n | P4-5 | src/runtime/plugins/skills/index.ts:401 | 技能审批卡的正文标签 `Skill` 没有中文词条

DESC：T023 定的规矩是 runtime 发英文键、渲染层查词典（`questionCardModel.ts:776-780` 的注释把 `contentLabel` 明确定义为 catalog key）。`skill` 门发的 `preview.label` 是 `'Skill'`，卡里用 `t(view.content.label)` 渲染，但 `zhTranslations` 只有复数的 `'Skills': '技能'`，没有单数 `'Skill'`。`i18nCoverage.test.ts` 扫的是字面量 `t('…')`，这里是 `t(view.content.label)`，扫不到；`toolVocabulary.test.ts` 的四组断言里也没有 contentLabel 这一组。

EVIDENCE：
```ts
// 生产者 src/runtime/plugins/skills/index.ts:394-402
        tool: 'skill',
        ...
        preview: { label: 'Skill', text: skill.name },
```
```tsx
// 消费者 src/renderer/components/chat/QuestionCard.tsx:669-673
        {view.content && (
          <div className="px-1">
            <p className="pb-1 text-meta text-muted-foreground">{t(view.content.label)}</p>
```
`grep -n "Skill" src/shared/i18n.ts` 只有一行：`574:  Skills: '技能',`。对照组：`Content`（1471）、`Arguments`（1823）、`Command`（281）都有词条。

SCENARIO：中文界面下模型加载一个需要审批的技能，卡片正文标签显示英文 `Skill`，下面是技能名，四周其它文案（标题、按钮、倒计时）都是中文。

FIX：`src/shared/i18n.ts` 加 `'Skill': '技能'`；并把 contentLabel 的闭集合（`Content` / `Command` / `Arguments` / `Skill`）加进 `toolVocabulary.test.ts` 的断言，避免下一个带 preview 的工具重演。

---

### [chat-tool-05] low contract-gap | P5-2-6 | src/renderer/components/chat/subagentActivityModel.ts:794 | 子代理面板表头与 Run 面板直接显示原始工具名（含 `mcp__` 前缀）

DESC：面板的**子行**走 `deriveToolRowView`，所以词汇是对的；但**表头**的 arg 有两条分支直接用 wire 名：等待审批时用 `lane.pendingPermission.toolName`，运行中用 `lane.progress.lastToolName`（生产者 `plugins/subagent/registry.ts:290` 原样转发 `event.toolName`）。右侧 Run 面板是同一个毛病：`runPanelModel.ts:240` 取 `block.toolName`，`RunSurfaceView.tsx:235` 原样打印。现有用例用的是 `'Bash'` / `'Read'`（`subagentActivityModel.test.ts:176/416`）这类 Claude 期名字，看上去很正常，掩盖了真实数据是 `bash` / `mcp__github__create_issue`。

EVIDENCE：
```ts
// src/renderer/components/chat/subagentActivityModel.ts:793-800
  if (lane.pendingPermission) {
    arg = t('Awaiting permission · {{tool}}', { tool: lane.pendingPermission.toolName });
  } else if (live) {
    arg =
      lane.progress?.description ??
      lane.progress?.lastToolName ??
```
```tsx
// src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx:234-236
              <div className="truncate text-meta" title={view.tools.activeTool}>
                {view.tools.activeTool}
              </div>
```

SCENARIO：一个子代理正在调用 MCP 工具。面板表头写「子 Agent mcp__github__create_issue」，它展开后的子行同一时刻写「调用中 github · create_issue」；右侧 Run 面板的工具芯片也写 `mcp__github__create_issue`。同一个动作在一屏里有两种名字，其中一种是协议标识符。

FIX：两处都改为经 `mcpToolLabel(name) ?? name` 取显示名，动词侧可复用 `toolVerb(name,'running')`；表头文案 `'Awaiting permission · {{tool}}'` 的插值同样走这条。用例：把 `runtimeToolVocabulary.test.ts` 的「同一个词到两个面」扩到表头与 Run 面板模型。

---

### [chat-tool-06] low correctness | P4-5 | src/runtime/plugins/permissions/activity.ts:50 | 权限活动行对 MCP / skill 把路径当成「被评估的值」，surface 也不是策略词汇

DESC：`permissionActivityRow.ts:43-46` 声明 `surface` 是「`bash`、`read`、`mcp`、`skill`、`external_directory`」这一类策略面名，`value` 是「被评估的命令 / 路径 / 工具名」。native 生产者两条都不按这个口径发：`surface` 直接用 `request.tool`（MCP 是 `mcp__<server>__<tool>` 这一长串 wire 名，`mcp` 这个策略面名永远不出现，`external_directory` 也从来不是 `tool`，所以永远不出现）；`value` 用 `command ?? path`，而 MCP 调用的 `path` 是 `this.cwd`（`plugins/mcp/index.ts:411`），于是行里印出的是工作区路径——真正被策略匹配的值 `github:create_issue` 在 `policyValue` 里，没人读。`skill` 同理：行里是技能文件的绝对路径，策略作者写规则用的是技能名。

EVIDENCE：
```ts
// src/runtime/plugins/permissions/activity.ts:50,61
  const detail = request.command ?? request.path;
...
      surface: request.tool,
      ...(detail ? { value: detail } : {}),
```
```ts
// 真正的策略面与值在这里：src/runtime/plugins/mcp/index.ts:414-417
            policySurface: 'mcp',
            policyValue: `${connection.server.name}:${tool.name}`,
```

SCENARIO：用户展开一个回合的「审批详情」，MCP 那行读作「Allowed mcp__github__create_issue /home/ai/code/ai-client」——后半截是工作区路径，看起来像是「批准了对这个目录的操作」，而它其实只是 MCP 桥传给门的占位路径。被拒时同一行会直接出现在时间线上（`toolCard.ts:204` 只静默 allow 行）。

FIX：`value` 改成 `request.policyValue ?? request.command ?? request.path`；surface 若要保持具体工具名，则把策略面另发一个字段（如 `policySurface`）供行尾注释使用，同时更新 `permissionActivityRow.ts:43-46` 的注释，使文档与生产者一致。

---

### [chat-tool-07] low dead-code | P4-5 | src/renderer/components/chat/turnTiming.ts:192 | 回合摘要三函数在生产里无消费者，注释却说它们仍在用；其中的编辑工具表还是只认大写名

DESC：`deriveTurnStats` / `formatWorkedForRow` / `turnHasThinkingOnlyProcess` 在 `src/` 里的引用只剩注释和它们自己的测试（全仓 grep 确认）；回合头的统计行在 T12-b 随 meta 行退役（`messageTimelineWiring.test.ts:484-491` 明说「F1 的降级链与它的 compact `deriveTurnStats` 参数一起退役了」）。但 `MessageTimeline.tsx:118-121` 的注释写的是「They stay exported … because the per-tool-row and subagent surfaces still use them」——这句话对 `THOUGHT_VERB` 成立，对另外三个不成立。副作用是 `EDIT_TOOL_NAMES` 至今只列大写 Claude 名，看起来像一处「native 的 edit/write 没被算进回合摘要」的漏补。

EVIDENCE：
```ts
// src/renderer/components/chat/turnTiming.ts:192
const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
```
```ts
// src/renderer/components/chat/MessageTimeline.tsx:118-121
// T12-b: `deriveTurnStats` / `formatWorkedForRow` / `THOUGHT_VERB` /
// `turnHasThinkingOnlyProcess` all fed the retired meta row's completed state.
// They stay exported from `turnTiming.ts` because the per-tool-row and subagent
// surfaces still use them; only this file stopped asking.
```

SCENARIO：不影响用户。影响的是下一个做词汇补全的人：按「查表点全量比对」的做法会在 `EDIT_TOOL_NAMES` 里补上 `edit`/`write`，于是给一段没有消费者的代码写用例、并在证据里记一条不存在的修复。

FIX：删掉这三个函数与它们的测试（`turnTiming.test.ts:186-350` 的相应块），或者退一步只改 `MessageTimeline.tsx:118-121` 的注释，点名「仅 `THOUGHT_VERB` / `formatThoughtRow` 仍被 `toolCard.ts` 与 `subagentActivityModel.ts` 使用，其余三个已无消费者」。二选一，别两者都不做。

---

### [chat-tool-08] low test-gap | P4-5 | src/renderer/components/chat/__tests__/runtimeToolVocabulary.test.ts:55 | 没有一条测试拿 runtime 注册表去对账渲染层的查表点

DESC：现有守卫是「点名式」的：列出八个工具名，断言它们有动词、有参数。它不能回答「注册表里新增了一个工具，渲染层是不是漏了」，也不覆盖动词/参数以外的四个查表点（命中列表、文件链接、输出高度、审批卡）。chat-tool-01 能从 T-05 一路活到今天，正是因为没有这类穷尽性断言。

EVIDENCE：
```ts
// src/renderer/components/chat/__tests__/runtimeToolVocabulary.test.ts:56-64
  it.each([
    [RUNTIME_TOOL_NAMES.glob, 'Searched files', 'Searching files'],
    [RUNTIME_TOOL_NAMES.browserPreview, 'Previewed', 'Previewing'],
    ...
```
`RUNTIME_TOOL_NAMES` 有 14 个键，用例点名 8 个 + `task` 一条，`read`/`write`/`edit`/`bash`/`grep` 靠与 `PI_TOOL_NAMES` 同名的巧合命中，没有任何断言说明这一点。

SCENARIO：下一个批次给 runtime 加一个工具（比如 `web_fetch`），注册表、提示词、权限策略都补了，渲染层三张表一个没补——测试全绿，用户看到「Ran https://…」。

FIX：加一条 `it('every registered tool has a verb, an arg branch and a class')`：遍历 `Object.values(RUNTIME_TOOL_NAMES)`，断言 `toolVerb(name,'done') !== UNKNOWN_TOOL_VERB.done`、`formatToolArg` 对该工具的典型参数不落回 `default:` 的 `run.toolName`、`zhTranslations` 有三个动词的词条。注册表这一侧因为 `src/runtime` 是独立子包不能直接 import，可用 `RUNTIME_TOOL_NAMES` 当唯一事实来源，另在 runtime 侧加一条反向用例断言注册表名字集合等于该常量的取值集合。

---

### [chat-tool-09] low correctness | P4-5 | src/renderer/components/chat/piToolNames.ts:82 | `mcp__` 拆分在服务器名含 `__` / 结尾为 `_` 或全名被截断时给出错误标签

DESC：`mcpToolName` 用 `[^A-Za-z0-9_-] → _` 归一后拼 `mcp__<server>__<tool>` 并 `slice(0, 64)`；`mcpToolLabel` 反过来按第一个 `__` 拆。两者在两种边界上对不齐：服务器名本身以 `_` 结尾或含 `__` 时分隔符变成三个及以上下划线，拆分把多出来的下划线算进工具名；全名超 64 字节时工具名被截断，标签显示一个截半的名字。已用纯字符串运算复算确认（只做 `node -e` 的字符串变换，未加载任何模块）。

EVIDENCE：
```ts
// src/renderer/components/chat/piToolNames.ts:80-85
export function mcpToolLabel(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const [server, ...rest] = toolName.slice(MCP_TOOL_PREFIX.length).split('__');
  if (!server) return undefined;
  return rest.length > 0 ? `${server} · ${rest.join('__')}` : server;
}
```
```ts
// src/runtime/plugins/mcp/index.ts:147-150
export function mcpToolName(server: string, tool: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
}
```
复算结果：`("a_","b") -> mcp__a___b -> "a · _b"`；`("atlassian-remote","getConfluencePageDescendantsWithBodyAndLabels") -> mcp__atlassian-remote__getConfluencePageDescendantsWithBodyAndLa -> "atlassian-remote · getConfluencePageDescendantsWithBodyAndLa"`。

SCENARIO：用户在 MCP 配置里把服务器命名为 `jira_`（或任何以下划线结尾的名字），时间线上该服务器的每一行都读作「调用中 jira · _createIssue」；工具名很长的服务器（Atlassian / Notion 这类真实存在的长方法名）则显示为被截断的名字。仅影响显示，调用本身用的是同一个字符串，不会错调。

FIX：`mcpToolLabel` 改成只按**第一个** `__` 分割一次（`const i = rest.indexOf('__')` 或 `split(/__(.+)/s)`），并对下划线前缀做一次 `replace(/^_+/,'')`；截断这一半更彻底的解法是 `mcpToolName` 在超长时改成「服务器名 + 工具名哈希后缀」而不是裸截，代价是要同步 `mcp` 插件自己的注册去重逻辑，可留作记录。

## 测试缺口

1. 没有「注册表 × 查表点」的穷尽性用例（chat-tool-08）；现有 `runtimeToolVocabulary.test.ts` 是点名式的。
2. 命中列表在 native 词汇上零覆盖：`toolCard.test.ts:631` 只断言大写 `Grep`/`Glob` 的 `hitSource`。
3. 审批卡没有「只带路径的门」的用例；`questionCardModel.test.ts` 覆盖的是 exec / file_change 两种有 detail 的形态。
4. arg 文案与 `contentLabel` 不在任何 i18n 守卫的扫描范围里（`toolVocabulary.test.ts` 只查动词，`i18nCoverage.test.ts` 只查字面量 `t('…')`）。
5. 子代理面板与 Run 面板的表头用例用的是 Claude 期名字（`subagentActivityModel.test.ts:176/416` 的 `'Bash'` / `'Read'`），与生产者真实发出的小写名 / `mcp__` 名不一致，掩盖了 chat-tool-05。
6. 没有用例覆盖「导入的 Claude 会话与 native 会话在同一窗口里工具行表现一致」——这正是 chat-tool-01 这类「主路径弱于旧路径」缺陷的唯一自然捕捉点。

## 未经执行验证的声明

- 本报告全部结论来自源码静态阅读；未跑 vitest、未起 Electron、未做真实模型回合，因此所有「用户看到 X」都是从纯函数的返回值与组件 JSX 推出来的，没有截图佐证。
- chat-tool-02 的触发依赖「模型请求工作区外的路径」，我是顺着 `plugins/permissions/index.ts:317-325` 的分支顺序推断该门必然开；没有实跑一次真实回合确认策略合并后的最终动作。
- chat-tool-03 / chat-tool-04 的「中文界面显示英文」是从 `zhTranslations` 缺键 + `t()` 的回落语义（缺键返回原文）推出的，没有在中文界面里实际截图。
- chat-tool-09 的两个边界都能用字符串运算复算，但「真实存在名字以 `_` 结尾或超 64 字节的 MCP 服务器」这一前提没有现场数据支撑。
- Windows 上 native 仍只注册 `bash`（`host/shell.ts` 找的是 Git Bash 的 `bash.exe`），因此 `PI_TOOL_NAMES.powershell` 在 native 下没有生产者——这条是静态推断，没有在 Windows 上验证过。

## 上机检查单（批次 E）

| 项 | 判据 | 取证方式 | 目标环境 |
|---|---|---|---|
| native `grep` / `glob` 行的命中列表 | 修复 chat-tool-01 后，悬停搜索行出现命中列表，点击命中能打开对应文件并跳到行号 | 起 Electron，真实回合跑一次 `grep`，悬停截图 + 点击后编辑器定位截图 | 真实模型回合（Electron） |
| 工作区外 `read` 的审批卡 | 卡上出现被读取文件的完整路径 | 真实回合让模型读一个工作区外文件，截审批卡 | 真实模型回合（Electron） |
| 中文界面的工具行文案 | `new_context` / `TaskWait` / `TaskList` 三种行全中文，无 `a fresh window` / `delegation(s)` / `running subagents` | 语言切中文，跑一次含压缩与子代理等待的回合，截时间线 | 真实模型回合（Electron） |
| 技能审批卡标签 | 中文界面下正文标签为「技能」而非 `Skill` | 中文界面触发一次需审批的技能加载，截卡 | 真实模型回合（Electron） |
| MCP 行的三处名字一致 | 时间线、子代理面板表头、Run 面板芯片都显示 `server · tool`，无 `mcp__` wire 名 | 接一个真实 MCP 服务器跑一次调用，一屏内同时截三处 | 真实模型回合（Electron） |
| 导入会话与 native 会话并列 | 同一窗口里导入的 Claude 会话与 native 会话的搜索行表现一致 | 导入一个真实 Claude 会话，与一个 native 会话并排截图 | 真实模型回合（Electron） |
| Windows 上的 shell 工具名 | Windows 下工具行仍是 `bash`（不是 `powershell`），动词表命中 | Windows 机跑一次命令回合，截时间线 | windows |

## 读过的文件

生产者侧：
- src/runtime/plugins/tools/index.ts
- src/runtime/plugins/tools/ask.ts
- src/runtime/plugins/tools/browserPreview.ts
- src/runtime/plugins/tools/new-context.ts
- src/runtime/plugins/tools/file-change.ts
- src/runtime/plugins/tools/prompt.ts
- src/runtime/plugins/subagent/index.ts
- src/runtime/plugins/skills/index.ts
- src/runtime/plugins/mcp/index.ts
- src/runtime/plugins/permissions/index.ts
- src/runtime/plugins/permissions/activity.ts
- src/runtime/plugins/permissions/policy.ts
- src/runtime/plugins/session/legacy.ts
- src/runtime/worker/permissionPrompt.ts
- src/runtime/host/shell.ts
- src/runtime/events/projector.ts
- src/agent-host/permissionPolicy.mjs
- src/agent-host/piSessionTimeline.ts
- src/agent-host/codexItemMapper.ts
- src/main/services/legacyImport/ClaudeSourceAdapter.ts
- src/main/services/legacyImport/CodexSourceAdapter.ts
- src/main/services/legacyImport/CodexRollout.ts
- src/runtime/worker/nativeImport.ts

消费者侧：
- src/renderer/components/chat/toolCard.ts
- src/renderer/components/chat/piToolNames.ts
- src/renderer/components/chat/ToolRows.tsx
- src/renderer/components/chat/toolDiff.ts
- src/renderer/components/chat/toolHits.ts
- src/renderer/components/chat/subagentActivityModel.ts
- src/renderer/components/chat/permissionActivityRow.ts
- src/renderer/components/chat/PermissionActivityRows.tsx
- src/renderer/components/chat/questionCardModel.ts
- src/renderer/components/chat/QuestionCard.tsx
- src/renderer/components/chat/turnTiming.ts
- src/renderer/components/chat/turnHead.ts
- src/renderer/components/chat/chatTurn.ts
- src/renderer/components/chat/MessageTimeline.tsx
- src/renderer/components/chat/useTurnTiming.ts
- src/renderer/stores/chatSessions.ts
- src/renderer/components/workspace-shell/sessionReview.ts
- src/renderer/components/workspace-shell/surfaces/runPanelModel.ts
- src/renderer/components/workspace-shell/surfaces/RunSurfaceView.tsx
- src/shared/sessionFileChange.ts
- src/shared/subagentDefinition.ts
- src/shared/subagentMigration.ts
- src/shared/i18n.ts
- src/shared/types/runtimeEvents.ts（权限段）

测试：
- src/renderer/components/chat/__tests__/toolVocabulary.test.ts
- src/renderer/components/chat/__tests__/runtimeToolVocabulary.test.ts
- src/renderer/components/chat/__tests__/messageTimelineWiring.test.ts（F1 退役段）
- src/renderer/components/chat/__tests__/toolCard.test.ts（hitSource 一条）
- src/renderer/components/chat/__tests__/subagentActivityModel.test.ts（progress 段）

文档：
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/README.md（第二、五、八节）
- docs/plantree/plans/runtime-evolution/evidence/runtime-audit-2026-09-14/cross-and-critic.md（缺口 8 及上下文）
- docs/plantree/plans/runtime-hardening/roadmap.md（Done 段与 T029 行）
