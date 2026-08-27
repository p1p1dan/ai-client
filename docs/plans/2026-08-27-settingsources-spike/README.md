# 取证 — `settingSources: []` 的代价，与能不能拿掉

> [unified-credentials open-q #6](../../plantree/plans/unified-credentials/open-questions.md) 的取证 ·
> [entry-and-environment E1](../../plantree/plans/entry-and-environment/roadmap.md)（「使用本机已有配置」按钮的真探测）的前置。
> 只做实验，**未改动 `src/` 下任何产品代码**。
> 离线成立：所有请求打到本机 `127.0.0.1` 的假 Messages 端点（`mockapi.mjs`），它一定回一个
> `tool_use`，于是「工具调用有没有过 `canUseTool`」变成确定性的、可观测的事实。

## 拍板（2026-08-27，用户当场问答）

- **权限卡**：只问有副作用的 —— 读文件、找文件、搜内容照旧自动放行。
- **配置文件**：`~/.claude` 与项目里的**都读**，并**完全照它写的办**（原话「完全照配置办」）。
  一度实现过一层覆盖（`managedSettings: { permissions: { ask: ['*'] } }`），
  经用户指出后**去掉了** —— 见 §H/§甲乙丙。

- **三层都读**（追加拍板，见 §L）：用户级 · 项目级 · **本机级**。

**最终形态**：`settingSources: ['user', 'project', 'local']`，**不加任何覆盖**。

## 结论（≤10 行）

1. **`settingSources: []` 当初设它的理由是对的，而且今天仍然成立。**
   仓库里提交的 `.claude/settings.json` 中一条 `permissions.allow`，**确实会整个跳过 `canUseTool`** —— 工具直接执行，权限卡从不出现（C3/D0 实测）。
2. **代价也确实是真的**：`[]` 之下**什么都不载入** —— 用户与项目的 `CLAUDE.md` 都不进模型上下文，用户 `settings.json` 里的 `env`、`hooks`、`model` 也全不生效（A① / B1 实测）。
3. **有一个可用的替代品，而且只要一行**：`managedSettings: { permissions: { ask: ['*'] } }`。
   它让 `settingSources` 可以打开，同时把被 `allow` 跳过的工具**摁回 `canUseTool`**（D2/D3/D4 实测，通配 `'*'` 就够，不必枚举）。
4. **但它有一个必须先拍板的副作用**：`ask:['*']` 会让**今天自动放行的琐碎工具也开始弹权限卡**
   （E 组：`echo` 今天 0 次卡，候选方案下 1 次）。这是 UX 取舍，不是 bug。
5. `managedSettings` 的 **`deny`** 也能挡住，但方式是**硬拒**，`canUseTool` 根本不被调用（D1）——
   保住了安全，丢掉了权限卡，不是我们要的。
6. ⚠️ **SDK 文档与实测不一致一处**：文档称 `managedSettings` 被「restrictive-only」过滤、
   `permissions.allow` 会被丢弃；`resolveSettings` 里**并没有被丢弃**（A⑥）。见 §5。

## 环境 / 版本

- SDK：随包 `@anthropic-ai/claude-agent-sdk` **0.3.218**
- CLI：随包 `@cometix/claude-code` **2.1.212**（Agent SDK 的 `pathToClaudeCodeExecutable`）
- Node：**24.18.0**（`out-node-runtime/node`）

⚠️ **必须用 Node 24 跑**。第一版探针用系统 Node 22，五个用例全部 `exit 1`，报错是压缩源码里的
`SyntaxError: Unexpected identifier 'n'` —— cli.js 用了 `using` 声明（显式资源管理），Node 22 不认。
这正是本仓给 Agent Host 钉 Node 24 运行时的原因，探针必须照做。

⚠️ **必须设 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`**（生产也设）。不设的话，CLI 的第一发请求
会被一个后台调用吃掉，真正的回合落到第二发 —— 假端点按「第几发」决定回什么，于是回合拿到的是文本而不是
`tool_use`，整组结果看起来像「工具从没被请求过」。

---

## A 组 — 设置层叠（零 spawn、零网络）

用 SDK 自己的 `resolveSettings()` 量，不启动任何进程。夹具：用户 `~/.claude/settings.json`
（含 `env` 凭据 + 一条 allow + 一个 hook + `model`）· 仓库 `.claude/settings.json`
（一条 allow + `defaultMode: bypassPermissions` + 一个 hook）· `.claude/settings.local.json`（一条 allow）。

| # | `settingSources` | 载入的层 | `permissions.allow` | `env` | `hooks` | `model` |
|---|---|---|---|---|---|---|
| ① | `[]`（**今天的生产配置**） | 无 | 无 | 无 | 无 | 无 |
| ② | `['user']` | user | 用户那条 | ✅ 两个键 | ✅ | ✅ |
| ③ | `['project']` | project | 仓库那条 | 无 | ✅ | 无 |
| ④ | `['user','project','local']`（CLI 默认） | 三层 | 三条并集 | ✅ | ✅ | ✅ |

**① 是本条 open-q 的全部实证**：打开的东西一样都不进来。

**一处正面发现**：仓库 `.claude/settings.json` 里的 `defaultMode: bypassPermissions`，
经 `filterEscalatingDefaultMode()` 后**被丢弃**（③/④ 实测）。SDK 自己就防着「仓库提交的文件把权限档位抬高」这一路。

---

## B 组 — 第一次读错，留痕

用真 SDK + 真 cli.js 跑回合，工具设成 `rm -f ./probe-target.txt`，仓库里放 `Bash(rm:*)`。
结果是「有 allow 和没 allow 一样，`canUseTool` 照样被调用」，**看起来像是「当初的理由不成立」**。

**这个读法是错的。** 报文里写的是 `Claude requested permissions to **edit** …/probe-target.txt` ——
`rm` 被归类成**文件编辑权限**（按路径），根本没走 `Bash(...)` 模式匹配。
也就是说那条 allow 从头到尾没参与过，B 组证明不了任何事。

留在这里是因为它是本轮最容易犯的错：**用一条根本没匹配上的规则，去证明「规则不起作用」。**

---

## C 组 — 决定性对照

换成无歧义的 Bash 命令。中途还废掉一个候选：`echo` 被内置安全清单自动放行，
**没有 allow 也会跑**（无法用来分辨）。最终用 `curl --version | head -1`。

| # | 仓库里的 allow | 传 `canUseTool` 吗 | `canUseTool` 被调用 | 工具真的执行 | 说明 |
|---|---|---|---|---|---|
| C1 | `Bash(curl:*)` | 否 | 0 | ✅ **跑了** | **allow 规则确实有效** |
| C2 | 无 | 否 | 0 | ❌ 被拦（`requires approval: curl`） | 对照，证明 C1 不是自动放行 |
| **C3** | `Bash(curl:*)` | **是** | **0** | ✅ 跑了 | **⇒ allow 跳过了 `canUseTool`** |

C1 与 C2 成对，证明规则本身能生效；C3 才是答案：**规则生效时，我们的权限卡整个不出现。**

---

## D 组 — 有没有别的手段

同样的仓库 allow（C3 那种），加上 `managedSettings`：

| # | `managedSettings` | `canUseTool` 被调用 | 工具执行 | 判定 |
|---|---|---|---|---|
| D0 | 无 | 0 | ✅ | C3 复现 |
| D1 | `deny: ['Bash(curl:*)']` | **0** | ❌ 被拒 | 挡住了，但**权限卡也没了** —— 硬拒，不是我们要的 |
| D2 | `ask: ['Bash(curl:*)']` | **1** | ✅（我们放行的） | ✅ **权限卡回来了** |
| D3 | `ask: ['Bash']` | **1** | ✅ | ✅ 整个工具粒度也行 |
| **D4** | **`ask: ['*']`** | **1** | ✅ | ✅ **通配就够，不必枚举** |

⇒ open-q #6 里那个「候选：`managedSettings` 的 restrictive 策略层」的猜想 —— **成立，且比预想便宜**：
一条 `ask: ['*']` 就够，不需要读用户配置去枚举规则名。

---

## E 组 — 副作用：卡会变多吗

| 工具 | 今天 `settingSources: []` | 候选 `['user','project']` + `ask:['*']` |
|---|---|---|
| `echo HELLO`（内置安全清单里的） | **0 次卡** | **1 次卡** |
| `curl --version`（需要审批的） | 1 次卡 | 1 次卡 |

⇒ `ask:['*']` **比今天更严**：今天连我们自己也让内置安全清单自动放行一部分工具，
候选方案下**每一次工具调用都会过我们的权限卡**。

**这是取舍不是缺陷**：更严 = 更可控，但用户会明显感到卡变多了（`Read` / `echo` 这类也要点）。
是否接受、或者是否收窄成 `ask: ['Bash', 'Write', 'Edit']` 之类的粒度，**是一条待拍板**。

---

## 复现

```bash
cd docs/plans/2026-08-27-settingsources-spike
N=<仓库根>/out-node-runtime/node            # 必须 Node 24
PROBE_ROOT=$PWD $N probeA.mjs   # 设置层叠（零 spawn）
PROBE_ROOT=$PWD $N probeC.mjs   # 决定性对照：allow 会不会跳过 canUseTool
PROBE_ROOT=$PWD $N probeD.mjs   # managedSettings 能不能摁回权限卡
PROBE_ROOT=$PWD $N probeE.mjs   # 卡的频次对比
```

`probeB.mjs` 已删除 —— 它测的是那条没匹配上的规则，留着只会误导；教训写在 §B 组。

⚠️ **这些脚本被 `biome.json` 排除在 lint 之外**（`!docs/plans/**/*.mjs`，与既有的 `!docs/design` 同类）。
它们是**冻结的实验存档**：改动之后就不再对应本档记录的那些数字，所以不该被格式化规则推着改。
要重新验证就照上面的命令跑，要改就当成写一个新探针。

---

---

## F 组 — 仓库里的 hooks 会不会真的被执行

「hooks」= 配置文件里写的「AI 每次动手之前，先替我跑一遍这条命令」。命令内容任意。
关键在于项目那份配置**跟着 git 走** —— 是仓库作者写的，不是用户写的。

夹具：项目 `.claude/settings.json` 里放一条 `PreToolUse` hook，命令是 `touch <哨兵文件>`。

| 配置 | hook 被执行 |
|---|---|
| 今天 `settingSources: []` | ❌ 不会 |
| 打开 `['user','project']` | ✅ **会** |

⇒ **确认：这是真风险，不是理论风险。** 对照：同一份文件若试图把 `defaultMode` 调成
`bypassPermissions`，SDK **会拒绝**（A③ 实测的信任过滤）—— 但对 hooks **没有这道防线**。
**已由用户拍板接受**（「两个都读，接受这个风险」）。

---

## G / H 组 — 「只问有副作用的」如果做成工具名单，会漏

拿到工具全集（G 组，`system.init` 回显）：**29 个** ——
`Task · AskUserQuestion · Bash · CronCreate · CronDelete · CronList · Edit · EnterPlanMode ·
ExitPlanMode · EnterWorktree · ExitWorktree · Glob · Grep · NotebookEdit · Read · ReportFindings ·
ScheduleWakeup · SendMessage · Skill · TaskCreate · TaskGet · TaskList · TaskOutput · TaskStop ·
TaskUpdate · WebFetch · WebSearch · Workflow · Write`。

最初随口举的 `['Bash','Write','Edit']` 三个名单，H 组实测**会漏**：

| 场景 | 权限卡 |
|---|---|
| 访问网页 · 无免问规则 · 名单只含那三个 | 1 张 ✅ |
| 访问网页 · **有免问规则** · 名单只含那三个 | **0 张** ❌ **漏了** |
| 访问网页 · 有免问规则 · 名单里加上它 | 1 张 ✅ |

⇒ **手工维护的工具名单会腐烂**：命令行工具下次升级新增一个，它不在名单里就**静默失效**，
而且失效方向是**放行**。这条是后来放弃名单方案的直接原因。

---

## I 组 — 今天到底哪些工具会弹卡

名单要想「保持今天手感」，就得先知道今天是什么样。`settingSources: []` 下逐个实测：

| 自动放行 | 弹卡 |
|---|---|
| `Read` · `Glob` · `Grep` | `Bash` · `Write` · `Edit` · `WebFetch` · `WebSearch` |

（`NotebookEdit` / `Task` 在本轮夹具下也显示自动放行，但**未能排除「参数不合法、在权限检查之前就失败」**
这一可能 —— 与 §B 组同类的陷阱。结论不采信，需要时另测。）

---

## Z 组 — 最终形态端到端复核

`settingSources: ['user','project']`，**不加任何覆盖**：

| 场景 | 权限卡 | 用户 CLAUDE.md | 项目 CLAUDE.md |
|---|---|---|---|
| 读文件 | 0 张 ✅ | ✅ 在 | ✅ 在 |
| 跑命令 | 1 张 ✅ | ✅ 在 | ✅ 在 |
| 跑命令 + 配置里有免问规则 | **0 张** | ✅ 在 | ✅ 在 |
| 访问网页 + 配置里有免问规则 | **0 张** | ✅ 在 | ✅ 在 |

后两行是**已接受的代价**，作为事实记在这里，不是缺陷。

---

## 甲乙丙 — 为什么最后没有加那层覆盖

实现过一版 `managedSettings: { permissions: { ask: ['*'] } }`，用户当场指出问题：
**「配置文件里那份是什么就是什么样，我们为什么要去干涉它？」**

这个反问是对的，而且指出了那版实现的真缺陷：**它分不清两个来源**。

| 文件 | 谁写的 | 覆盖它意味着 |
|---|---|---|
| `~/.claude/settings.json` | **用户自己** | 推翻用户自己写的「别问我」—— 与 D60/D61「用户环境原样生效」直接冲突 |
| `<项目>/.claude/settings.json` | **仓库作者**（跟 git 来） | 才是真正要防的那个 |

三个落法摆给用户：**甲** 完全照配置办 · **乙** 保留覆盖 · **丙** 用 `resolveSettings` 的
provenance（每条规则来自哪一层）只挡仓库那份。**拍板取甲。**

支撑甲的关键一条：用户在同一轮已经接受了**更大**的风险 —— 仓库的 hooks 能跑任意命令，
连工具调用都不需要（§F）。为了**更小**的那个去覆盖用户自己的文件，逻辑上站不住。

**净效果**：权限卡的行为与官方 Claude Code 命令行**完全一致**。我们不再比自己内嵌的工具更严。

---

---

## L 组 — 第三层 `settings.local.json` 的独立行为

前面几轮只测过「三层一起开」的合并结果，没单独验证过第三层。它是
`<项目>/.claude/settings.local.json`，**归属与用户级相同**：命令行工具自己的 `.gitignore`
把它挡在版本控制外，所以**只可能是用户自己写的**，是一个人在某个项目里攒「以后别问我这条」的地方。
它也是三层里**暴露面最小**的 —— 项目级会跟着 clone 来，这一层不会。

夹具：只有本机级那份有内容（免问规则 + env + model），用户级与项目级刻意留空，
让效果只可能来自它。

| `settingSources` | 载入的层 | 免问清单 | env | model |
|---|---|---|---|---|
| `['user','project']` | **无** | 无 | 无 | 无 |
| `['user','project','local']` | local | ✅ 读到 | ✅ 读到 | ✅ 读到 |
| `['local']` 单开 | local | ✅ 读到 | ✅ 读到 | ✅ 读到 |

真跑一回合（免问规则**只**写在本机级那份里）：

| `settingSources` | 权限卡 | 含义 |
|---|---|---|
| `['user','project']` | **1 张** | 没读到那条规则 |
| `['user','project','local']` | **0 张** | 读到了，并照办 |

**M 组 · 本仓真实文件复核**：本仓 `.claude/settings.local.json` 里写的是 `{"outputStyle":"Concise"}`
（用户自己设的，被 `.gitignore:38` 挡着不进 git）。改之前 `outputStyle` **读不到**，
改之后读到 `Concise` —— 前后对照干净。

⇒ **拍板加上**（用户 2026-08-27「开吧，测完就改」）。理由与 `'user'` 同一条：
**同样是用户自己写的东西，不该因为放在项目目录里就不算数。**

---

## 对设计的含义

**已落地形态**：

```ts
settingSources: ['user', 'project', 'local'],   // 两份 CLAUDE.md、env、hooks、model 全部回来
// 不加任何覆盖 —— 见上方「甲乙丙」
```

**留下的未决**：

- **SDK 文档与实测不一致一处**：文档称 `managedSettings` 被 restrictive-only 过滤、
  `permissions.allow` 会被丢弃；`resolveSettings` 显示**没有被丢弃**（A⑥）。
  本批最终没用 `managedSettings`，所以不阻塞 —— 但**将来若要把它当安全边界用，这条必须先单独测执行期行为**。
- **`NotebookEdit` / `Task` 今天是不是真的自动放行** —— I 组未能排除「参数不合法提前失败」，结论不采信。
