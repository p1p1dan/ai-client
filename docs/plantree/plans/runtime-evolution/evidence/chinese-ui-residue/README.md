# 中文界面英文残留（硬编码的那批）— 验证记录

Role: evidence。日期：2026-09-11。提交 `4f7dedf7`。对应[执行顺序](../../README.md#执行顺序)第 4 批「本地缺陷」。

这批和 2026-09-11 早些时候补的那批**不是同一件事**。上一批（`d0332939`）补的是
「代码里写了 `t('…')`、但词典里没有对应中文」的 57 处。这一批的字符串**根本没
经过 `t()`**：它们直接从模块里当普通字符串一路传到 DOM，所以 `i18nCoverage` 那个
扫描器看不见它们，中文界面里就一直显示英文。

## 改法：一句话

**纯函数模块继续吐英文，但那串英文从此是「词典的键」，不是给人看的字。**

时间线的每一行长成 `动词 + 参数` 两段，两段的处理方式不一样，这是整批改动的骨架：

- **动词**（`已运行` / `已编辑` / `已拒绝` / `已思考`）是封闭词表里的词，一路当键
  传下去，到 `ToolRows.tsx` 渲染那一行时统一 `t(view.verb)` 翻一次。一句代码覆盖
  工具行、思考行、聚合行、权限行四种形态，中间那些纯函数一个都不用拿翻译器。
- **参数**（`TODO（ai-client）`、`耗时 1m 6s`、`3 个文件, 1 次搜索`）要拼数字和
  路径，没法当键，所以在构造的时候就得翻好。这些函数因此多收一个 `t` 参数，
  默认值是 `englishTranslate`（就是英文本身）——**没接线的老调用点输出一个字节
  都不变**，所以「漏接一处」的后果是少一条翻译，不是产生一个坏字符串。

`englishTranslate` / `Translate` 定义在 `src/shared/i18n.ts`。

## 改了哪些面

| 面 | 文件 | 之前中文界面显示 |
|---|---|---|
| 工具行动词表 | `toolCard.ts` → `ToolRows.tsx` | Read / Reading / Edited / Editing / Ran / Grepped / Explored… |
| 思考行与回合统计 | `turnTiming.ts` | Thought、briefly、for 1m 6s、3 tool calls |
| 权限卡 | `questionCardModel.ts`、`QuestionCard.tsx` | Permission / Allow / Allow for session / Deny / Deny and stop / Content / High risk |
| 审批记录行 | `permissionActivityRow.ts` | Awaiting approval、Allowed read、policy allow、matched … |
| 子 Agent 面板 | `subagentActivityModel.ts` | Subagent / Said / Capped / From subagent / Awaiting permission |
| 输入框占位 | `middleColumnLayout.ts` | Message Pi… / Send follow-up… / Queued N — … |
| 回合进行中的状态行 | `attachments.ts`、`turnStatus.ts` | Starting Agent Host… / Still waiting · 45s — … / Pondering… / Failed |
| 排队条 | `QueuedMessageStrip.tsx` | 四个 aria-label |
| 侧栏 | `LeftNav.tsx` | New |
| 会话分支对话框 | `SessionTreeDialog.tsx` | 整个文件此前没接过 i18n |
| 模型按钮 | `ComposerModelTrigger.tsx` | aria-label 与 tooltip |

另外顺手修掉一类**词典自身的半吊子翻译**：`'Search sessions': '搜索 Session'`、
`'Collapse Repository': '折叠 Repository'` 这种中英混排的值，共 15 条，统一成
「会话」「仓库」——界面别处早就是这两个词，混着用本身就是同一个毛病。

## 守卫：两个测试，缺一不可

扫描器看不见 `t(view.verb)` 这种动态键，所以这批改动**必须**自带守卫，否则下次
加一个工具就会悄悄退回去。

1. **`toolVocabulary.test.ts`** — 直接断言三张词表（`TOOL_VERBS`、
   `AGGREGATE_VERB`、权限词）里每个词都有词条。往 `TOOL_VERBS` 里加工具却不加词条，
   在这里挂，而不是在用户面前。
2. **`chineseChatSurface.test.ts`** — 拿真的 `zh` 翻译器渲染真的组件，再把 DOM 读
   回来。这条问的是另一个问题：**屏幕上那个词是不是真从词典来的**。

两条都要。现场报告抓到的那屏 `Grepped src · Allowed`，每个词当时都有现成的中文可
用，只是渲染路径压根没去查——只验词表的测试会一路绿着。

**反向验过**：把 `ToolRows.tsx` 的 `{t(view.verb)}` 改回 `{view.verb}`，
`chineseChatSurface` 立刻挂 2 条；改回来就绿。不是空测试。

## 自动化结果

- 全量 **376 文件 / 5312 测试通过**。
- 根目录、`src/runtime`、`src/agent-host` 三套 `tsc --noEmit` 通过。
- Biome：本轮改动的文件全部干净（仓库里另有 4 处此前就存在的 lint 问题，
  与本批无关，`git stash` 后同样复现）。

顺带修了 6 处**因为这次改动而失效的旧断言**，其中两处值得单独说：
`questionCardInteraction` 和 `nativeStreamReplay` 把 `t` 打桩成 `(key) => key`，
原样返回键。卡片现在会传参（`{{seconds}}`），这种桩会把断言变成在检查一个用户
永远看不到的字符串——换成真的 `englishTranslate` 才有意义。

## 真机点验

`node scripts/run-batch4-language-probe.mjs`（开发机 Electron + CDP）。

不跑真实回合，直接往 store 里塞一段合成对话：因为要查的是「词翻没翻」，不是
「模型答得对不对」，而真实回合未必一次就把工具动词、思考行、审批记录、权限卡
四种形态都凑齐。这台机器 2 核 / 3.3 GB，少起一次 Electron 是实打实的。

截图：[batch4-transcript-zh.png](batch4-transcript-zh.png)，原始输出
[batch4-report.json](batch4-report.json)。

屏幕上读到的：

- 时间线：`已思考` / `已运行 pnpm test` / `已浏览 1 个文件, 1 次搜索` / `编辑 src/a.ts`
- 审批记录：`已拒绝 bash rm -rf /tmp/x`
- 权限卡：`权限` · `高风险` · `内容` · `项目：/repo` · `直接允许 / 本会话内允许 / 直接拒绝 / 拒绝并停止`
- 侧栏：`新建`、`搜索会话`
- 输入框占位：`继续输入…`
- 模型按钮 aria-label：`模型与思考强度：grok-4.6 Low —— 对下一轮生效`

**仍是英文、且应当如此的**：用户自己起的会话标题、仓库名与分支名
（`ai-client`、`feat/runtime-evolution`）、合成数据里的命令和路径
（`pnpm test`、`/repo`）、模型 ID、`GUI` / `TUI` / `Agent Host` 这类产品术语，
以及标题栏的应用名。探针把整屏的 ASCII 片段都列出来供人工核对，**不做自动判定**
——能自动判的那部分已经由上面两个测试守住了。

## 边界（没做什么）

- **Allow / Deny 复用权限设置页已有的「直接允许 / 直接拒绝」**。两处含义不同
  （设置页是"这类操作一律放行"，卡片是"这一次放行"），但一个键只能有一个值，
  而中文两边读起来都通顺。没有为此拆键，也没有去改设置页的英文。
- `List` 与 `Plan` 两条词条原值是「列表」「规划模式」——名词，用在工具行的动词位
  上不通。这两条**没有别的字面调用点**（`Plan` 只被 surface registry 当
  `labelKey` 动态用，改成「规划」两边都成立），所以直接改了值，没有拆键。
- 探针依赖开发机上已有的引导状态与迁移提示；它会自己点掉起始页、迁移对话框和
  启动公告，但没有覆盖「全新机器首启」那条路径。
