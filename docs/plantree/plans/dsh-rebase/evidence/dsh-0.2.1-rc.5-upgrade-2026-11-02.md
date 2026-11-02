# 证据：DSH 0.2.0-rc.2 → 0.2.1-rc.5 升级前后对照（2026-11-02，Linux 开发机）

[决策 207](../decisions/207-dsh-0-2-1-rc-5-upgrade.md) 的证据。做法照[决策 189](../decisions/189-dsh-0-2-0-rc-2-upgrade.md)的证据。

- **方法**：同一台机器，两个工作目录。
  - 升级前：`/home/pi/code/ai-client-integrate`（`61347bd9`，DSH 0.2.0-rc.2）。
  - 升级后：`/home/pi/code/ai-client-dsh-upgrade`（分支 `feat/dsh-0.2.1-rc.5`，WIP 提交 `be840f56`，DSH 0.2.1-rc.5）。
  - 升级后的代码只有版本钉、锁文件和去掉 ralph 两处，**产品代码还没有为新版改动**。所以本文记的是「不改代码直接升」的影响，决策 207 的修复做完后要再跑一遍。
- **不涉及真实模型或真实账号**：模型回复全部来自本地假网关 `src/dsh-host/tools/fake-gateway.mjs`。
- **原始输出不入库**：留在本机 `/tmp/dsh020/`（升级前）、`/tmp/dsh021/`（升级后），以及当天早些时候的 `/home/pi/code/dsh-0.2.1-integration-2026-11-02.txt`、`dsh-0.2.1-record-check-2026-11-02.txt`。复跑用到的脚本在同名目录 [`scripts/`](dsh-0.2.1-rc.5-upgrade-2026-11-02/scripts/)。

## 环境

| 项 | 值 |
|---|---|
| 系统 | Debian（Linux 6.12），2 核，5.8 GB |
| Node | 随包钉的 `out-node-runtime/node` 24.20.0 |
| 根依赖 | 链接主检出 `/home/pi/code/ai-client/node_modules`（`pnpm-lock.yaml` 与升级分支逐字相同） |
| 宿主依赖 | 升级后：本目录自装的 0.2.1-rc.5（`@aiclient/dsh-app` 指本目录的 bundle）；升级前：整合目录逐项链接的 0.2.0-rc.2 |
| Claude 引擎依赖 | 链接主检出的 `src/claude-sdk-host/node_modules`（0.3.316，锁文件相同） |

## 1 上游变化（只有编译产物，逐包比 `lib/` 与 `package.json`）

- 包：删 5 个（`dsh-client-connection`、`dsh-invariants`、`dsh-skill-badge`、`dsh-subagent-in-process-driver`、`dsh-tool-ralph`），增 4 个（`dsh-api-remote-access`、`dsh-working-directory`、`dsh-tool-working-directory`、`dsh-web-deepseek-api`）。没有随包的升级指南或 CHANGELOG。
- dsh-base 行 94 → 96：删 `skill-badge`、`tool-ralph`（两行上游原本就关着），增 `remote-access`、`working-directory`、`tool-working-directory`、`web-deepseek-api`。我们补丁和宿主代码引用的行 id 全部还在。
- 逐字未变：`dsh-session` 的 `buildForkSeed` / `openTurnClosers` / `ToolCallRecovery`（只是行号后移 3 行）；`dsh-llm-pi-ai` 的 `COMPAT_GATES`；pi-ai 的 `detectCompat`。
- pi-ai 0.87.1 → 1.4.0（大版本），带动 `@anthropic-ai/sdk` 0.124 → 0.129、`openai` 6.40 → 7.19。
- 细节见决策 207 第 2 节。

## 2 静态检查与单测

| 检查 | 0.2.0-rc.2 | 0.2.1-rc.5（未改代码） |
|---|---|---|
| `tsc -p src/dsh-host` | 0 错（交接 §14.4） | 0 错 |
| 根 `tsc` | — | 1 错：`src/shared/__tests__/fixtures/pilabExperience.ts:25`。**主检出 `61347bd9` 上同样 1 错**，与升级无关 |
| 全量单测 | 796 文件通过（交接 §14.4） | 3 项失败（交接 §14.2，本次逐项复跑确认，见下） |
| biome（WIP 提交的 6 个文件） | — | 无问题 |

三项单测失败与原因：

| 测试 | 失败 | 原因 |
|---|---|---|
| `permissionsClassification` | 已装 DSH 有未分类的工具 `working_directory` | 新工具，要分类 |
| `dshToolVocabulary` | 工具表比分类表多一个 | 表里还有上游已删的 `ralph`，又少新工具 |
| `dsh-plugin-allowlist`（插件审计坏样本） | 报错文本是 `undefined` | `evaluatePluginCompatibility` 的结果字段 `peers` 改名 `requirements`，`scripts/dsh-host-build-lib.mjs:1104` 还读旧名 |

另外发现、没有测试覆盖的：`scripts/dsh-host-build-lib.mjs:1215` 的打包必备清单要求 `dsh-skill-badge/assets/dsh-badge.md`，该包已删，真打包会失败（本机不跑整包，未实跑）。

## 3 真宿主集成测试（`AICLIENT_DSH_INTEGRATION=1`）

| | 0.2.0-rc.2 | 0.2.1-rc.5 |
|---|---|---|
| 7 个文件 56 项 | 全过（交接 §14.4 的「恢复后」记录） | 54 过 / 2 挂 |

- `[190-I-2]`（两个开关都关）：组合普查报 `web-deepseek-api: state 0`。这行依赖 `web` 服务，`AICLIENT_RUNTIME_WEB_FETCH=0` 关掉 `web` 后它起不来。它注册 `deepseek-search-api` / `deepseek-fetch-api` 两个提供方，调用 `https://api.deepseek.com/v1/tools`。
- `[PLN-3]`（关闭计划审阅）：断言工具结果是失败、带 "dismissed the plan review"。新版 `dsh-plan-mode` 在关闭时调 `exec.concludeTurn()`，返回成功，文字是 "The user dismissed the plan review to reply in their own words; plan mode remains active."，回合不再多走一步。

## 4 桥接录制（`bridge-record --check`，37 个场景）

- 升级前：37 个场景对金样本无差异（交接 §14.4）。
- 升级后：**69 个文件有差异**，复跑一次数目相同。
- 用 `scripts/classify-recordings.mjs` 把消息编号、日志序号、作业 id 这些整体后移的编号屏蔽后，只比应用收到的两类文件（`stream.*` 实时事件、`rpc.*` 历史与树），**只剩 3 个场景有实质差异**：

| 场景 | 差异 |
|---|---|
| `perm-search` | `glob` 失败：`Error: cannot get property "workingDirectory" without inject`。我们的 `aiclient-fs-search` 行复用上游的 `applyGlobTool`，它现在读 `ctx.workingDirectory`，我们的行没声明这个注入 |
| `perm-subagent` | 子代理调用立即返回 `started subagent <id>`；子代理的权限卡不再出现在父回合里（见第 6 节） |
| `plan-dismiss` | 关闭审阅后回合直接结束，模型不再回一句 |

- 其余三十几个场景的差异只在 DSH 内部日志（`log.*`）里：
  - 系统提示词上下文多了 `working-directory:current` 一节（`Current working directory: "<workspace>".`），其后各节顺移；
  - 工具表多了 `working_directory`；
  - 每次 `bash` 都在日志里记 `job/registered` 与 `job/settled`（前台命令也记），作业 id 从 `bash-1` 变成 `bash-<16 位十六进制>`；
  - 因此日志序号、消息编号整体后移。
- **会话开始时不会写 `working-directory/change`**（交接 §14.2 的说法不对）：DSH 只在投影状态为空时补写，我们的会话都有 `header.cwd`；全部录制日志里没有一条。

## 5 探针

| 探针 | 0.2.0-rc.2 | 0.2.1-rc.5 |
|---|---|---|
| `request-prefix-probe.ts`（S1～S4） | PASS 21/21 | **PASS 21/21**（前缀只追加、user_id、缓存链、重启后同一会话都过） |
| `loop-guard-smoke.ts` | 33/33 | 30/33：`g3FanOutRuns`、`g7ChildReplyCut`、`g7ChildCeiling` |
| `bridge-smoke.ts` | 72/72 | 71/72：`agentDirOverlaysReachedFirstRequest` |
| `goal-probe.ts` | 工具 24 个；目标完成 / 阻塞 / 轮数上限都到达；网关请求 41；被关的行 29 | 工具 25 个（多 `working_directory`）；三种结局相同；请求 41；被关的行 27（少的是上游已删的 `skill-badge`、`tool-ralph`） |

- **`g3FanOutRuns`**：一次发出 10 个子代理，2 个报错。新版每棵会话树最多同时 8 个子代理（`maxActiveSubagents`，超出报 `ACTIVATION_LIMIT_REACHED`，不排队），10 − 8 = 2 对得上。报错原文没有抓到，属推断。
- **`g7ChildReplyCut` / `g7ChildCeiling`**：子代理现在在后台跑，探针在父回合结束后就收集，子代理还没开始（`attempts 0`、`turnEnds []`）。回路守卫在子代理上的行为**这次没测到**，探针要改成等子代理结束再收集。
- **`agentDirOverlaysReachedFirstRequest`**：`<agentDir>/AGENTS.md` 没送到模型（项目 `CLAUDE.md` 与技能正文送到了）。原因：`dsh-agent-instructions` 的行配置去掉了 `dshHome`（注释写明「行不能把说明加载指向别的根目录」），我们 `agentDirOverlays()` 传的 `dshHome: <agentDir>` 被静默丢掉，用户级说明改从 `$DSH_HOME/AGENTS.md` 读。同时新增第二个用户级根 `$DSH_AGENTS_HOME` 或 `~/.agents`，即**用户真实的 `~/.agents/AGENTS.md` 会被读入**。`~/.agents/skills` 在 0.2.0 就已经会读，不是新变化。

## 6 子代理的回合外权限卡（实验，`scripts/late-card-experiment.md`）

`perm-subagent` 场景在父回合结束后再等 45 秒、对出现的卡答「允许」。应用收到的事件顺序（摘要）：

1. 父回合 `turn-PERM-SUB`：`subagent` 调用 → `subagent.activity started / running` → `tool.completed "started subagent <id>"` → 模型回一句 → `session.completed` → `session.status idle`。
2. **会话已空闲**，子代理开始干活：`subagent.activity progress / tool.started bash`（没有 requestId）→ **`permission.requested`（kind exec，工具 bash，带 agentId，没有 requestId）** → 答「允许」→ `permission.resolved` → 子代理的工具完成、回复文字。
3. 子代理结束后 DSH **自己开了一个回合** `dsh-turn-…-2`：`subagent.activity completed / report` → 一条**用户角色**消息 "Background subagent <id> finished and will do no further work unless you send it more." → 模型继续。

假网关在唤醒回合里按脚本又跑了一次 bash，这是假网关脚本的问题，不代表真实模型。子代理没有用 `send_message` 汇报（假网关的子代理脚本不调它），所以「汇报一次 + 结束通知一次」的两次唤醒没有测到。

渲染端 `chatSessions.ts:2307` 把没有回合的权限卡挂到最近一条实时助手消息上并放进待审队列，按代码应能显示和操作；**界面上没有实查**（要等测试全过后在隔离环境里看）。

## 7 思考回放（决策 189 第 5 节的 A/B，Linux 上复跑）

`request-prefix-probe.ts --only S1 --keep`，假网关分别用请求的模型名和 `fake-1-20260929` 作答（`scripts/model-id-shim.mjs` 改假网关的 `--model-id`），用决策 189 证据目录的 `thinking-replay-check.mjs` 计数。

| 版本 | 名字一致 | 名字不同 |
|---|---|---|
| 0.2.0-rc.2（决策 189，Windows，全量） | 50 / 43 / 29 全部原样 | 50 / 43 / 29 全部原样 |
| 0.2.1-rc.5（本机，全量 19 个请求） | 50 / 43 / 29 全部原样 | 50 / 43 / 29 全部原样 |

（三个数依次是：有文本带签名的思考、空文本带签名的思考、redacted 思考。）

## 8 自定义服务的方言与 User-Agent

- pi-ai 1.4.0 的 `detectCompat` 与 0.87.1 逐字相同，`src/shared/userProviders.ts` 的四家预设照旧成立。
- `openai-completions` 适配器的变化：User-Agent 改由 `getIdentityHeaders` 给；推理内容在正文之前处理；采样参数合并改由 `resolveSamplingParams`；历史中段的工具增减按 `"additions"` 处理。集成测试里自定义 User-Agent 的三项（`[UA-1..3]`）都过。

## 9 没跑的

- 修复后的整轮复跑（决策 207 实现完成后做）。
- 整包构建与打包冒烟（本机不跑整包；打包清单问题见第 2 节）。
- Windows 与加密机。
- 子代理用 `send_message` 汇报的路径、`~/.agents/AGENTS.md` 实际被读入的情况（推断自代码，未用探针证实）。
- 真实界面。

## 10 实现后的整轮复跑（2026-11-02，第 5 阶段，提交 `51ec4baf` 之后）

同一台 Linux 机器，测试小批串行。

| 检查 | 升级、未改代码时（第 3、5 节） | 实现后 |
|---|---|---|
| 宿主 tsc | 0 错 | 0 错 |
| 根 tsc | 1 错（main 原有） | 1 错，仍是 main 原有的 `pilabExperience.ts`，未处理 |
| 单元测试 | 3 项失败 | 全过：渲染端 436 个文件（2086 + 3777 + 790）、共享库 2232、主进程 2413、桥接 627、宿主其余 667、Claude 引擎宿主 225、打包脚本 276 |
| 真宿主集成 | 54/56 | 57/57（7 个文件；多出的一项是 `[207-CD-1]`） |
| 桥接录制 37 场景 | 69 个文件有差异 | `--check` 0 处差异 |
| 桥接冒烟 | 71/72 | 73/73（`agentDirOverlaysReachedFirstRequest` 核对第一个请求里有 `<agentDir>/AGENTS.md` 的标记、没有 `~/.agents/AGENTS.md` 的标记；新增「`~/.agents/skills` 的技能仍在清单里」；`panelsAnswerCurrentValues` 按决策 207 第 14 节 D 补一行后改成六个键，见下） |
| 回路守卫冒烟 | 30/33 | 34/34（G7 等后台子代理结束再收集，子代理的回复截断与步数上限都过；新增 G3b「第 9 个撞上限」） |
| 请求前缀探针 | 21/21 | 21/21 |
| 目标探针 | 25 个工具、三种结局、请求 41、被关的行 27 | 25 个工具、三种结局、请求 41、被关的行 28（多 `web-deepseek-api`） |
| 思考回放 A/B | 50 / 43 / 29 原样 | 名字一致、名字不同都是 50 / 43 / 29 原样（各 21 个请求） |

- 桥接冒烟 `panelsAnswerCurrentValues` 第一次跑是 false：`worker.panels` 多答了 `workingDirectory`（第 3 阶段有意加的），冒烟写死五个键。第 3 阶段没跑冒烟，所以当时没发现。先在决策 207 第 14 节 D 补一行，再改冒烟，复跑 73/73。
- 冒烟脚本的退出码不看判定（有一项 false 时仍退出 0），判定要读输出文件的 `verdict`。

### 真实界面（隔离环境 `/tmp/pilab-r0` + 假网关，测试全过之后）

隔离环境上次留在 Claude 引擎上（假网关的 DSH 工具名在那边不存在），先在隔离环境的设置里关掉 Claude 引擎、重启再查。截图在 `dsh-0.2.1-rc.5-upgrade-2026-11-02/shots/`（只含 `/tmp` 下的路径）。

| 场景 | 看到的 |
|---|---|
| 回合外的子代理权限卡（`P1-PERM-SUB`，手动审批） | 主回合结束、会话空闲后卡片出现：「来自子代理 · Permission probe child · 主对话空闲中，批准后这个子代理继续」；右栏「子代理」卡头「1 等你确认」，行写「等你确认：bash」；左侧会话列表这个对话有待处理标记、顶栏计数 1（`s5-207-late-card.png`） |
| 批准之后 | 子代理完成，DSH 自己开回合（「子代理已完成，自动继续」）；卡片折成「已结束 1」，点开是「已完成 · 用时 0:24 · 63 tokens · 1 次工具调用」，只有「查看对话」；点开是子对话页（`s5-207-card-ended-dialog.png`） |
| 运行中的子代理（`P1-SUBSTOP secs=20`） | 卡头「1 运行中」，行写「运行中 sleep 20; …」与时长；点行出「查看对话」「打断」；右栏没有「运行中」卡片，子代理不重复（`s5-207-card-running.png`）。点「打断」后行变「已打断」，主回合照常继续 |
| 换到子目录（`P1-CD packages/web`） | 不出卡；工具行「切换目录 packages/web」「搜索 *（workspace/packages/web）」；输入框下出现「packages/web」标签（`s5-207-cd-inside.png`） |
| 换到工作区外 | 换目录不出卡；之后的搜索出一张卡、路径是那个目录；批准后输入框下是黄色「工作区外 /tmp/pilab-r0/outside-build」，工具行写完整路径（`s5-207-cd-outside.png`） |

观察（没改）：

- 自动继续那一行在「子代理已完成，自动继续」后面接着 DSH 给模型的英文通知原文（点开能看全）。这是原有做法（这一行一直带 DSH 的说明），预览 v3 的说明里写了「英文通知不展示」，决策 207 第 8 节没列，这次没改。
- 运行中子代理的第三层以「运行中」开头（命令行的进行时读法），和右边的状态字「运行中」重复。
- 等确认时第三层写工具原名「bash」，预览里是「运行命令 …」。
- 「运行中」卡片只列命令这一条，界面上没造出后台命令来看，靠单元测试覆盖。

### 仍没跑的

- 子代理用 `send_message` 向主对话汇报、因而一个子代理唤醒两次的顺序（决策 207 第 8 节第 5 项要补假网关脚本，没补）。
- 整包构建与打包冒烟、Windows、加密机。

