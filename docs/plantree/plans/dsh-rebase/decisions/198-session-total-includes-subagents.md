# 决策 198：DSH 引擎的「本会话累计」计入子代理用量

日期：2026-10-18（北京时间）。**状态：实现完成；标「自主」的是实现时的自主决定，待用户审批（第 6 节汇总）。** 分支 `claude/objective-khorana-07a747`，从 `claude/confident-newton-3ed6db` 的 `f004f530`（[决策 195](195-gpt-cache-chain-and-auxiliary-usage.md)）切出，本地提交，未推送。起因见决策 195 第 6 节第一条。

编号说明：194 已有两份重号。`claude/s6-feedback` 上 195 是 GPT 缓存链，出站代理改号为 196。197 已被另一个会话登记。这份用 198，已登记在会话组共享笔记的 `decision-number-claims.md`。

## 1 结论

- DSH 会话的本会话累计 = 主循环（token meter 的 `tokenUsage`）+ 辅助请求（决策 195）+ **子代理（本决策）**。
  - 子代理的用量从子代理自己的日志折叠出来。
  - `PiSessionUsage.toolResults` 填委派个数，`usage.updated.delegated` 填委派那一份。runtime-hardening [决策 005](../../runtime-hardening/decisions/005-subagent-usage-in-usage-updated.md) 定的就是这两个字段，渲染端一直有，DSH 宿主以前不填。
- 面板（实测）：
  - 步数一栏写「4 + 2 次委派」；
  - 「其中委派（本会话累计）」一行写「40.2k · 61%」；
  - 说明文字换成「本会话的数字是把每一次模型请求（包括子代理的请求）累加起来的结果……」。
- 这几处都是原有的文案和行，以前在 DSH 上从来出不来。
- 费用仍不显示：DSH 不计价，`costUsd` 恒为 0。
- 新开关 `AICLIENT_RUNTIME_DELEGATED_USAGE=0`：不读任何子代理日志，载荷回到以前的样子。

## 2 盘点：子代理的用量在哪、能不能重算

| 来源 | 里面有什么 | 宿主重启、会话重开后 | 用不用 |
|---|---|---|---|
| 父会话日志的 `subagent/catalog` | 直接子代理的 id、mode（one-shot / continuable）、label | 在日志里，能重算 | **用**：历史缓存折叠父日志时一并记下（`childSessions`） |
| DSH 的 `subagentCatalog` 投影 / `listChildren` | 同上，但不含 fork 继承来的条目 | 能 | 不用：要再读一次父日志，而历史缓存已经读过了 |
| 宿主事件 `subagent/start` / `subagent/end` | 一次运行的开始与结束、runId、停止原因 | 只在宿主这次运行内 | 不用于用量，只给泳道（`DshSubagentsTracker`） |
| `DshSubagentsTracker` 的 `child.tokens` | 泳道的进度数 | 内存，每次运行清零 | 不用 |
| 子会话日志：`assistant/message` 的 `usage`、`assistant/attempt` 流里的 `usage` 块、`llm/retry-started`、`compaction/summary` 的 `usage` | 子代理的每一次模型请求 | 在日志里，能重算 | **用** |
| 子会话的 token meter 投影 `tokenUsage` | DSH 自己的累计 | 能 | 不用：`subagent_fork` 的子会话开头是复制来的父会话前缀，`tokenUsage` 把这段也算进去了（见下） |
| 子会话日志里的 `subagent/catalog` | 孙代理 | 能 | **用**：递归跟进。DSH 默认 `maxDepth` 为 1，用户在 DSH 设置里改深了才会有孙代理 |

- **几种子代理都覆盖**：前台、后台、一次性、可续跑的子代理都是一个本地子会话，同一种读法。
  - 可续跑的子代理被 `send_message` 续跑后，新事件接着折叠。
  - 重开会话后，它的日志冷读一次。
- **读不到的**：ACP 等进程外 provider 没有本地子会话。我们的组合里没有这类 provider。
- **fork 的继承前缀**：`subagent_fork` 的子会话以父会话已完成的回合为种子。
  - 日志前 `inheritedEventCount` 条是父会话的事件，带着父会话那几步的用量。
  - token meter 的 `tokenUsage` 初始化时不看这个数，所以把它们也加进去了。
  - 父会话自己的总量里已经有这几步，再算一次就重复了。所以子代理的用量自己折叠，跳过继承部分。
  - DSH 的 `subagentCatalog` 投影也是这样跳过继承部分的。

## 3 做法

### 3.1 折叠一个子会话（`src/shared/dshDelegatedUsage.ts`）

- **主循环**：与 dsh-token-meter 的 `tokenUsage`（stateVersion 2）同一口径。
  - 取 `assistant/message` 的 `usage`；没有就取它流里最后一个 `usage` 块。失败的 `assistant/attempt` 也一样取。
  - 同一步后来的样本替换前一个；`llm/retry-started` 关掉替换位，重试另算一次。
  - 对照测试（`[D198-PARITY]`）直接用 dsh-token-meter 自己注册的投影单元，三段日志逐段对比，结果相等。只在装了 `src/dsh-host` 依赖时跑，做法照 `forkSeed.test.ts`。
- **压缩摘要**：子会话的压缩摘要（`compaction/summary.usage`）一并计入，用决策 195 的 `addAuxiliaryUsage`。
- **继承部分**：前 `inheritedEventCount` 条一律跳过，步骤、摘要、catalog 都不算。
- **孙代理**：子会话自己 catalog 里的子代理记下来，交给跟进那一层。

### 3.2 跟进子代理（`src/dsh-host/bridge/delegatedUsage.ts`）

- **父会话名下有哪些子代理**：看历史缓存从父日志折叠的 `childSessions`，**含继承部分**（自主）。
  - 父会话的 token meter 总量也含倒带种子里继承来的步骤；
  - 倒带后，切点之前委派的子代理照样算；
  - 被倒带丢掉的那段里委派的，不算。
- **什么时候开始跟进**：
  - 宿主读完历史时；
  - 父日志来一条 `subagent/catalog` 时（按事件里的 id，不依赖历史缓存当时的状态）；
  - 每一步结算时，补上历史缓存重读后才看到的子代理。
- **每个子代理怎么读**：
  - 先用 `observeSession(id, {projectionMode: 'none'})` 读一次整段日志。一次只读一个，排队读，重开一个子代理很多的会话时不会一起冷读。
  - 之后跟着 `session/event` 一条条折叠。读的过程中到的事件先存起来，读完再折叠。序号断了就重读，重读期间先保留已折叠的数。
  - 读失败的子代理不计，它下一条事件来时再试；连续 3 次失败就放弃。
  - 上限：每个会话跟进 256 个子代理，每个子代理读的过程中最多存 2,000 条事件，超了就整段重读。
- **结算时读到什么**：同步读当前已折叠的数。日志还没读完的子代理，这一步不含，下一步含。
- **不靠内存**：宿主重启、会话重开都从日志重算。这一点与决策 195 的审核用量不同：审核不写日志，只能在内存里累加。

### 3.3 发送与显示

- `liveEvents.ts` 的 `sessionOf`：
  - 输入、输出、缓存读写都加上委派那一份；
  - `toolResults` 写报过用量的子代理个数，孙代理也算；
  - `delegated` 写委派那一份，`costUsd` 为 0，只跟本会话累计一起发。
- 没有子代理报过用量时，载荷与以前一字不差，`toolResults` 照旧是 0。
- 「最后一步」那几行不变，仍是父会话这一步自己的账单。上下文占用也不含子代理（决策 005 的「父上下文占用不含子上下文」）。
- **面板**：
  - 步数与「其中委派」两行是原有的；
  - 说明文字新增两句：含子代理的请求；含子代理的请求以及压缩摘要等辅助请求；
  - 选哪一句挪到了 `runPanelModel.ts` 的 `formatSessionFiguresNote`，这样能单测。判据是收到了 `delegated`，而不是 `toolResults > 0`，原因见第 7 节第 2 条。
- **刷新时机**（自主）：跟着父会话的每一步结算，不单独发一次。
  - 后台子代理在父会话某一步之后才结束的部分，要等父会话的下一步。子代理结束会唤醒父会话，通常紧接着就有这一步。
  - 不单发的理由与决策 195 第 3.2 节相同：单发的话，「最后一步」那几行会被当成子代理的数。

### 3.4 录制与假网关

- **录制**：`bridge-record.ts` 归一化时去掉 `usage.updated` 里的 `delegated`（自主），样本文件不变。
  - `sub-cont` 里，后台子代理与父会话并行。父会话某一步结算时子代理的用量到没到，要看时钟和读子代理日志的先后，这个字段时有时无。
  - Windows 上跑不完录制门禁，留给 CI 的 gate 验证。
- **假网关**：`fake-gateway.mjs` 的 `GPT-LOOP` 新增 `"tool": "subagent"` 和 `"tool": "subagent_fork"`。
  - 每一步委派一个子代理，子代理跑自己的 `GPT-LOOP`：`childSteps` 次 `read`，默认 2 次。
  - 父子请求都按各自的 `prompt_cache_key` 用模拟缓存计费，所以能与网关日志逐条相加对账。

## 4 开关（§6 要求新能力可关）

- `AICLIENT_RUNTIME_DELEGATED_USAGE=0`：`plugin.ts` 不开跟进，不读任何子代理日志，本会话累计只有父会话自己的。
- 这个变量加进了 Main 的 `FORWARDED_ENV`（`dshHostEnvironment.ts`），`DshHostProcess.test.ts` 核对名字。

## 5 验证

- 两套 tsc（`pnpm typecheck`、`pnpm typecheck:dsh-host`）都是 0 错，biome 无报错。
- **新增或改动的单测**：
  - `dshDelegatedUsage.test.ts` 5 条；
  - `delegatedUsage.test.ts` 8 条，含与 dsh-token-meter 的对照；
  - `historyCache.test.ts` 1 条；
  - `liveEvents.test.ts` 2 条；
  - `dshSessionRuntime.test.ts` 3 条：从日志读、实时、重开、断号后重读、开关；
  - `rewindFork.test.ts` 1 条：倒带后只算种子里的子代理；
  - `runPanelModel.test.ts` 1 条；
  - `DshHostProcess.test.ts` 1 条（改）。
- **整组回归**：shared、dsh-host、workspace-shell、Main agent-host 四组共 5,049 条，失败 23 条，分布在 10 个文件。这 10 个文件在基线（本分支起点，去掉改动）上也是同样的 23 条失败，都是这台 Windows 的环境问题：符号链接 EPERM、按 `/` 比路径、8.3 短名、只在 Linux 上有的 systemd。
- **去掉实现后单测会失败**：32 处实现逐一去掉，每处都有对应的测试失败。这 32 处包括：
  - 累计加委派、发 `delegated`、`toolResults`、零用量不发；
  - 跳过继承、替换位、重试、流里的样本、压缩摘要、catalog、零用量的子代理不计；
  - 读期间暂存、断号重读、读后跟进孙代理、实时跟进孙代理、重置后丢弃旧读取、失败计数、溢出重读、个数上限、不跟进自己；
  - 历史缓存读入与实时记 catalog；
  - 启动、实时 catalog、结算时三处跟进，转发子会话事件，开关；
  - 倒带重置、倒带后跟进；
  - 两句说明文字；Main 转发开关。

  有一处起初去掉后没有测试失败：旧会话的读取在重置之后才落地，会把它的孙代理带进新会话。补了测试之后会失败。
- **开发版实测**（Windows）：
  - 环境：`gui-probe.mjs` 隔离的 HOME 与 profile，只连本地假网关。openai-responses 服务 `gpt-fake-r`，权限「改动前确认」。
  - 每一轮都从渲染进程的状态读出精确数，与假网关日志逐条相加（输入 = 计费输入 − 命中）对账。
  - **第一轮** `GPT-LOOP {"tag":"p","steps":1,"tool":"subagent","childSteps":2}`：
    - 网关 5 次请求：父会话 2 次，子代理 3 次，子代理有自己的缓存键；
    - 面板「2 + 1 次委派」，输入 13.0k、输出 60、缓存读取 18.7k，「其中委派 19.2k · 61%」；
    - 精确数：本会话 12,959 / 60 / 18,688（合计 31,707），委派 6,635 / 36 / 12,544（合计 19,215），与网关逐条相加相同；
    - 「最后一步」仍是父会话自己的 138 / 12 / 6,144。
  - **第二轮** `subagent_fork`：
    - 分叉子代理的请求带着继承来的第一轮，第一次请求有 8 项输入；
    - 面板「4 + 2 次委派」，本会话 20,519 / 120 / 44,928（合计 65,567），委派 13,933 / 72 / 26,240（合计 40,245），与网关相同；
    - 继承部分没有重复计入：如果计入了，委派那一份会多出 6,324 输入、6,144 缓存读取、24 输出。
  - **宿主重启后**：杀掉 DSH 宿主进程，supervisor 拉起新进程，再发一轮只回一句的消息：
    - 本会话 20,632 / 132 / 51,328（合计 72,092），委派仍是 40,245、2 个子代理；
    - 新进程是从两个子代理的日志冷读重算的。
  - 应用日志里没有 `delegated usage` 的报错。
- **没验证的**：
  - 录制门禁（留给 CI）；
  - 面板排版：截图时窗口在后台不出帧，截到的是空白，只核对了文字与数值；
  - 后台可续跑子代理只有单测与录制场景的推理，开发版只跑了前台的 `subagent` 和 `subagent_fork`；
  - 孙代理只有单测，默认深度下不会出现；
  - 子代理压缩摘要计入只有单测；
  - Linux。

## 6 待用户审批（自主决定）

1. **委派计数按子代理（子会话）个数**，含孙代理，不按运行次数或请求次数（3.3）。
   - 一个可续跑的子代理被续跑两次仍算 1 次委派。
   - 这是从日志能稳定重算的数，也最接近 1.0.x T020「每个委派记一次」的意思。
   - 子代理自己发了多少次请求不单列，步数一栏只数父会话的步。
2. **委派那一份含子代理的压缩摘要**。全自动档审核子代理工具调用的请求，照旧记在父会话的「辅助请求」里：子代理的调用走的是父会话那一个权限闸门，审核用量本来就由父会话的 runtime 累加（决策 195 第 3.2 节），子代理日志不记审核，所以不会重复。
3. **倒带后**：切点之前委派的子代理仍算，被倒带丢掉的那段里委派的不算（3.2）。与 token meter 对继承步骤的算法一致。
4. **刷新时机跟着父会话每一步结算**，不为子代理单发（3.3）。
5. **录制归一化去掉 `delegated`**（3.4）。
6. **新开关 `AICLIENT_RUNTIME_DELEGATED_USAGE`**，由 Main 转发给宿主（第 4 节）。

## 7 顺带发现（没在本次处理）

1. 决策 195 的开关 `AICLIENT_RUNTIME_RESPONSES_CACHE_WATCH` 不在 Main 的 `FORWARDED_ENV` 里。Main 不把 `AICLIENT_` 前缀的变量传给宿主，所以在应用里设这个开关不起作用，只有直接起宿主的探针脚本能用。
2. SDK 引擎（`src/claude-sdk-host/sdkSessionRuntime.ts`）每收到一个工具结果就把 `session.toolResults` 加 1。面板的步数一栏因此会显示「N + M 次委派」，M 其实是工具调用次数，不是委派次数。本决策的说明文字按「收到 `delegated`」来判断，不受这个影响；步数那一栏仍会误报。
3. `claude/s6-feedback` 在 `f004f530` 之后改过 `dshSessionRuntime.ts`、`fake-gateway.mjs`、`i18n.ts`，合并时这三处可能有文本冲突。
