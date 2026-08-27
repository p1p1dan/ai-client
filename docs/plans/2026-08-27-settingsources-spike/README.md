# 取证 — `settingSources: []` 的代价，与能不能拿掉

> [unified-credentials open-q #6](../../plantree/plans/unified-credentials/open-questions.md) 的取证 ·
> [entry-and-environment E1](../../plantree/plans/entry-and-environment/roadmap.md)（「使用本机已有配置」按钮的真探测）的前置。
> 只做实验，**未改动 `src/` 下任何产品代码**。
> 离线成立：所有请求打到本机 `127.0.0.1` 的假 Messages 端点（`mockapi.mjs`），它一定回一个
> `tool_use`，于是「工具调用有没有过 `canUseTool`」变成确定性的、可观测的事实。

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

---

## 对设计的含义

**可以拿掉 `settingSources: []`，代价是一条待拍板。**

推荐形态：

```ts
settingSources: ['user', 'project'],          // 用户与项目的 CLAUDE.md、env、hooks 回来
managedSettings: { permissions: { ask: ['*'] } },  // 每次工具调用都回到我们的权限卡
```

**待拍板 #1 —— 权限卡的粒度**：`ask:['*']` 让每个工具都弹卡（比今天更严，E 组）。
接受？还是收窄到 `['Bash','Write','Edit']` 这种「有副作用的才弹」？

**待拍板 #2 —— 要不要连 `'local'` 一起开**：`.claude/settings.local.json` 是本机未提交的文件，
理论上比 `project` 更可信；但它也不在仓库评审范围内。本轮没测它的独立行为。

⚠️ **顺带要知道的两件事**：
- 打开 `project` 会一并载入**仓库提交的 `hooks`**（A③ 实测）—— 那是会执行的命令，来自 git。
  `defaultMode` 有 SDK 的信任过滤兜着，**`hooks` 没有**。本轮**未测** hooks 是否真的会被执行，
  这是开工前该补的一发。
- SDK 文档说 `managedSettings` 会 restrictive-only 过滤掉 `permissions.allow`，
  但 `resolveSettings` 显示**没有过滤**（A⑥）。文档同时声明 `resolveSettings`「报告的是原始层叠、不是安全判定」，
  所以两者不一定矛盾 —— 但**在把 `managedSettings` 当安全边界用之前，这条必须单独测一次执行期行为**。
