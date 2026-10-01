Role: evidence

# P1-12 第 2 步 A：A 类权限用例迁到纯库的逐条映射（2026-10-01，基线 `13bc19f5`）

依据：[P1-12 施工方案](../topics/p1-12-retire-runtime.md) §2 第 2 步、§6 第 3 条；[P1-6 分片 04](../topics/p1-6-permissions/04-regression-baseline.md) §1（A 类清单）；[决策 041](../decisions/041-permissions-shared-pure-library.md) 第 3 条；实现取舍见[决策 147](../decisions/147-p1-12-retire-runtime.md) §二「第 2 步 A」。

本步只新增测试，不删也不改 `src/runtime`、`src/agent-host` 与任何产品代码。旧用例原地照跑、新用例在纯库上照跑，两边同时全绿，就说明迁移没有改变任何判定。

## 总数

计数口径：一个 `it(...)` 或一个 `it.each(...)` 算一例（`it.each` 的行数另注）；数的是基线 `13bc19f5` 的源码。分片 04 的约 115 例是 `d6e1c811` 的数，此后几个文件又加过用例，所以这里多一些。

| 原文件 | 原用例 | 迁入纯库 | 已有覆盖 | N/A |
|---|---|---|---|---|
| `src/runtime/__tests__/permissions.test.ts` | 6 | 6 | 0 | 0 |
| `src/runtime/__tests__/permissionGrants.test.ts` | 21 | 21 | 0 | 0 |
| `src/runtime/__tests__/permissionQueue.test.ts` | 14 | 14 | 0 | 0 |
| `src/runtime/__tests__/shellPolicy.test.ts` | 48 | 47 | 0 | 1 |
| `src/runtime/__tests__/subagentToolsPermissions.test.ts`（SA10 组） | 8 | 5 | 0 | 3 |
| `src/runtime/__tests__/tools.test.ts`（权限用例） | 15 | 11 | 1 | 3 |
| `src/runtime/__tests__/workerEndToEnd.test.ts`（权限用例） | 3 | 0 | 3 | 0 |
| `src/runtime/__tests__/nativeWorkerRuntime.test.ts`（权限用例） | 4 | 0 | 4 | 0 |
| `src/runtime/__tests__/skills.test.ts`（权限用例） | 4 | 4 | 0 | 0 |
| `src/runtime/__tests__/mcp.test.ts`（权限用例） | 3 | 0 | 0 | 3 |
| **合计** | **126** | **108** | **8** | **10** |

**判定差异：0 例。** 108 例迁过去后，期望值一条没改，在纯库上全部通过；没有用 `it.fails` 或 `it.skip`。

新文件（`S` = `src/shared/permissions/__tests__/`，`D` = `src/dsh-host/permissions/__tests__/`）：

| 新文件 | 用例 | vitest 实跑条数 | 来自 |
|---|---|---|---|
| `S/cardOutcomes.test.ts` | 6 | 9 | permissions |
| `S/sessionGrants.test.ts` | 20 | 27 | permissionGrants |
| `S/approvalQueue.test.ts` | 14 | 14 | permissionQueue |
| `S/delegateScope.test.ts` | 5 | 5 | SA10 |
| `S/gearsAndTools.test.ts` | 13 | 31 | tools 7、shellPolicy 2、skills 4 |
| `S/shellPathSpellings.test.ts` | 6 | 6 | shellPolicy |
| `D/bashGate.test.ts` | 39 | 66 | shellPolicy |
| `D/bashGateTools.test.ts` | 5 | 5 | tools 4、permissionGrants 1 |
| `S/gateHarness.ts`、`D/bashHarness.ts` | 夹具 | — | — |
| **合计** | **108** | **163** | |

## 迁移约定

- **只换辅助函数**。原来的 `createRuntime` / `start` / `runtime` / `gate` / `engine` 换成 `S/gateHarness.ts` 的 `buildGate`：工作区取 realpath，`scopes` 按 `canonicalPath` 解析，`loadPermissionPolicy` 读随包策略加 agentDir 层（受信任时再加项目层），再 `new PermissionGate`。这四步与 runtime bootstrap、DSH bridge 的 `buildGate` 一致。文件工具（`read` / `write` / `edit` / `glob` / `grep`）走 `fileCall`，即 `authorizeTarget`。`bash` 走 `D/bashHarness.ts` 的 `bashCall`：先 `analyzeBash`（宿主的 `loadBashParser`）加 `checkShellPaths`，再 `authorizeTarget`，最后重新分析并比对。这与 runtime `bash` 工具和 DSH `requestBuilder` 的三步一致。
- **用例主体不变**：输入、期望判定、审批次数、事件与审计行的断言都照抄。
- **命令和工具不执行**。原用例里断言工具输出或写入内容的那半句（例如读回 `out.txt`、`note.txt`、`by-delegate.txt`，`pwd` 打印工作区）删掉，并在注释里写明。只有一处，后一条命令要用到前一条命令建的文件（`cat sub/*`），改由测试预先建好。
- **改了名的 4 例**都在表里注明。

## 1 `permissions.test.ts` → `S/cardOutcomes.test.ts`

| # | 原用例 | 去向 |
|---|---|---|
| 1 | records a countdown that ran out as a timeout, on the card and in the audit row | 同名 |
| 2 | records the value the gate matched on, not the path it was handed（`it.each` 4 行） | 同名 |
| 3 | still calls a cancelled request cancelled | 同名 |
| 4 | reads the reason off the signal even when the card is asked after it aborted | 同名 |
| 5 | sends an action id for each gated tool and no prose of its own | 同名 |
| 6 | sends no action at all for a tool it has no sentence for | 同名 |

## 2 `permissionGrants.test.ts` → `S/sessionGrants.test.ts`（另 1 例进 `D/bashGateTools.test.ts`）

| # | 原用例 | 去向 |
|---|---|---|
| 1 | a file grant… › covers the same file again, and stops at the file it named | 同名 |
| 2 | a file grant… › is per tool: allowing an edit to a file does not allow writing it | 同名 |
| 3 | a file grant… › refuses a secret file outright rather than asking about it | 同名 |
| 4 | a file grant… › keeps asking about a path the bundled rules mark `ask`, grant or no grant | 同名 |
| 5 | a bash grant… › covers the same prefix with different arguments, and nothing else | 同名 |
| 6 | a bash grant… › needs every segment of a chained command to be granted | 同名 |
| 7 | a bash grant… › still asks when a granted prefix reaches outside the workspace | 同名 |
| 8 | a bash grant… › covers a command whose operands the analysis could not read | 同名 |
| 9 | a bash grant… › remembers nothing for a command with no readable program name | 同名 |
| 10 | through the real shell analysis › reads the segments the analysis already split, rather than re-lexing | `D/bashGateTools.test.ts` › a bash grant, through the real shell analysis › 同名（要用语法树） |
| 11 | the prefix rule itself › %s is remembered as %s（`it.each` 8 行） | 同名 |
| 12 | the prefix rule itself › has no prefix for a segment that starts with a flag or is empty | 同名 |
| 13 | the prefix rule itself › gives up on the whole command when any one segment has no prefix | 同名 |
| 14 | grants survive a reopen… › restores what was allowed, and starts a new conversation empty | 同名。会话文件换成一个条目列表：`persistGrants` 往里追加与 runtime 同形的 custom 条目，重开时仍用 `restoredGrants` 读回 |
| 15 | grants survive a reopen… › forgets them on disk too when the permission posture changes | 同名，做法同上 |
| 16 | the stored format › stays off the wire, so a grant is not drawn as a system message | 同名。`INTERNAL_CUSTOM_ENTRIES` 改从 `src/shared/legacyPiSession/legacy.ts` 取 |
| 17 | the stored format › round-trips what it wrote | 同名 |
| 18 | the stored format › treats a version it does not know as no grants at all | 同名 |
| 19 | the stored format › drops the retired v1 records rather than reading them as file grants | 同名 |
| 20 | the stored format › keeps the last record, so an empty one really clears | 同名 |
| 21 | the stored format › drops a malformed member without losing the record around it | 同名 |

## 3 `permissionQueue.test.ts` → `S/approvalQueue.test.ts`

| # | 原用例 | 去向 |
|---|---|---|
| 1 | raises one card at a time, however many calls arrive together | 同名 |
| 2 | serves the queue first come, first served | 同名 |
| 3 | starts a queued request's deadline when its card appears, not when it was made | 同名 |
| 4 | drops a request cancelled while it waited, with no card and no hold-up behind it | 同名 |
| 5 | hands the gate on when the approver itself throws | 同名 |
| 6 | never queues a call the policy decides on its own | 同名 |
| 7 | lets the next request up when a drain arrives without an abort | 同名。`drain` 是纯库 `createPermissionPrompt` 的 API，DSH 关会话时也先调它 |
| 8 | wakes everything queued when the graph is torn down | **改名** wakes everything queued when the gate is torn down。`runtime.dispose()` 换成 `gate.dispose()`：runtime 拆图时调的就是它，DSH 的 `dshSessionRuntime.dispose` 也调它 |
| 9 | tells each card where it sits in a queue that is still growing | 同名 |
| 10 | drops a queued request when the permission settings change under it | 同名 |
| 11 | a gear change… › answers the card on screen and the queue behind it | 同名 |
| 12 | a gear change… › keeps asking about the call the wider gear still stops for | 同名 |
| 13 | a gear change… › leaves a waiting card alone when the gear narrows | 同名 |
| 14 | a gear change… › keeps the session grants a `configure` would have cleared | 同名 |

## 4 `shellPolicy.test.ts` → `D/bashGate.test.ts`（另 8 例进 shared）

| # | 原用例 | 去向 |
|---|---|---|
| 1 | Bash AST permission enforcement › blocks denied operands in auto: %s（`it.each` 13 行） | `D/bashGate` 同名 |
| 2 | … › allows normal workspace commands and pipelines without approval | `D/bashGate` 同名。第一条命令本来会建 `sub/file`，这里由测试预先建好，供 `cat sub/*` 展开；删掉断言输出含 `amber` 的那半句 |
| 3 | … › tolerates a bash wildcard whose parent directory does not exist yet (tools-07) | `D/bashGate` 同名 |
| 4 | … › requires approval for variable and nested-shell external paths | `D/bashGate` 同名 |
| 5 | … › applies deny scopes to shell operands within the workspace | `D/bashGate` 同名 |
| 6 | … › checks symlink targets reached by wildcard expansion | `D/bashGate` 同名 |
| 7 | … › does not normalize away symlink traversal before checking its real target | `D/bashGate` 同名 |
| 8 | … › resolves a junction before applying `..` to it | `D/bashGate` 同名 |
| 9 | … › follows a junction to the workspace and counts `..` above it as outside | `D/bashGate` 同名 |
| 10 | … › re-resolves a link reached after `..` cancels a missing segment | `D/bashGate` 同名（bash 与 read 两半都在） |
| 11 | … › re-resolves a plain file symlink reached the same way | `D/bashGate` 同名 |
| 12 | … › counts a dangling link as the missing segment that `..` cancels | `D/bashGate` 同名 |
| 13 | … › does not let a workspace allow scope authorize external shell paths | `D/bashGate` 同名 |
| 14 | … › rechecks shell paths after approval before executing a retargeted symlink | `D/bashGate` 同名（`path_changed`） |
| 15 | … › does not load BASH_ENV even when the host environment supplies it | **N/A**：测的是 runtime `bash` 工具自己的执行环境（`--noprofile --norc`、清掉 `BASH_ENV`），不是权限判定。纯库不执行命令，DSH 的 shell 工具也不由我方提供 |
| 16 | … › rejects malformed shell instead of falling back to an empty permission analysis | `D/bashGate` 同名 |
| 17 | redirects… › blocks a denied name reached through a redirect in auto: %s（`it.each` 4 行） | `D/bashGate` 同名 |
| 18 | redirects… › asks before a leading redirect writes outside the workspace | `D/bashGate` 同名 |
| 19 | redirects… › leaves an in-workspace redirect and a plain here-string alone | `D/bashGate` 同名；删掉读回 `out.txt` 的那半句 |
| 20 | command-name normalization › keeps a bash deny rule on a wrapped or absolute spelling: %s（`it.each` 8 行） | `D/bashGate` 同名 |
| 21 | command-name normalization › does not extend that deny to other commands behind the same wrappers | `D/bashGate` 同名 |
| 22 | command-name normalization › judges the operands of a wrapped command, not the wrapper | `D/bashGate` 同名 |
| 23 | command-name normalization › asks for a wrapper whose inner command cannot be read | `D/bashGate` 同名 |
| 24 | interpreter payloads › requires approval for an unreadable interpreter payload: %s（`it.each` 5 行） | `D/bashGate` 同名 |
| 25 | interpreter payloads › still runs a -c payload the analysis could read, without approval | `D/bashGate` 同名；删掉读回 `note.txt` 的那半句 |
| 26 | unresolved operands under auto › asks in auto when an operand could not be resolved | `D/bashGate` 同名 |
| 27 | unresolved operands under auto › still runs a fully resolved command in auto without approval | `D/bashGate` 同名 |
| 28 | the bypass gear › runs an unresolved-operand command with no card at all | `D/bashGate` 同名 |
| 29 | the bypass gear › is not a way past the bundled path denies | `D/bashGate` 同名 |
| 30 | the bypass gear › is not a way past a configured bash or path deny rule | `D/bashGate` 同名 |
| 31 | the bypass gear › is not a way past a deny scope | `D/bashGate` 同名 |
| 32 | the bypass gear › is not a way past plan mode or the tool whitelist | `S/gearsAndTools.test.ts` › the bypass gear (from shellPolicy) › 同名（直接调 `evaluate`，不用语法树） |
| 33 | command substitution in the name position › judges the operands of the inner command: %s（`it.each` 2 行） | `D/bashGate` 同名 |
| 34 | command substitution in the name position › only asks when the inner command touches nothing denied | `D/bashGate` 同名 |
| 35 | option and key=value operands › registers a path glued to a short option | `D/bashGate` 同名 |
| 36 | option and key=value operands › registers the value of a key=value operand against the deny rules | `D/bashGate` 同名 |
| 37 | option and key=value operands › asks before a key=value operand targets a path outside the workspace | `D/bashGate` 同名 |
| 38 | option and key=value operands › does not turn plain switches or in-workspace operands into approvals | `D/bashGate` 同名 |
| 39 | shell path separator folding › keeps a wildcard its own segment when the command used the other separator | `S/shellPathSpellings.test.ts` 同名 |
| 40 | shell path separator folding › leaves a POSIX path alone, backslashes in names included | `S/shellPathSpellings.test.ts` 同名 |
| 41 | windows path spellings › folds MSYS, Cygwin and extended-length spellings onto the native one | `S/shellPathSpellings.test.ts` 同名 |
| 42 | windows path spellings › matches the uncoverable deny whatever spelling the shell used | `S/shellPathSpellings.test.ts` 同名 |
| 43 | windows path spellings › leaves the POSIX reading of the same strings alone | `S/shellPathSpellings.test.ts` 同名 |
| 44 | windows path spellings › registers a Git Bash operand under the spelling every gate compares | `S/shellPathSpellings.test.ts` 同名 |
| 45 | native permission policy loading › imports global deny rules and retains them in auto | `D/bashGate` 同名 |
| 46 | native permission policy loading › ignores project policy until the host explicitly trusts it | `D/bashGate` 同名 |
| 47 | native permission policy loading › reads legacy JSONC and overlays current global config without discarding table entries | `D/bashGate` 同名 |
| 48 | native permission policy loading › fails startup for invalid policy rather than losing a deny | `S/gearsAndTools.test.ts` › native permission policy loading (from shellPolicy) › 同名（不用语法树） |

## 5 `subagentToolsPermissions.test.ts` 的 SA10 组 → `S/delegateScope.test.ts`

同文件其余两组（capability gaps：grep 正则、bash 超时上限、browser_preview；SA11 写锁）不是权限用例，不在本表。

| # | 原用例 | 去向 |
|---|---|---|
| 1 | runs a delegate call under the definition gear without moving the session gear | **N/A**：委派定义声明的档位，属 C 类（分片 04 §3：DSH 的代理预设没有 `permission` 字段，D11） |
| 2 | puts the delegate on the approval card | 同名。DSH 下署名由请求自带的 `delegation` 给出，另有 `permissionHost.test.ts` › routes subagent and nested delegate calls to the root gate, naming the delegate |
| 3 | records the gear the call actually resolved under, not the session default | **N/A**：同 1，C 类 |
| 4 | keeps two concurrent delegates on their own gears | **N/A**：同 1，C 类 |
| 5 | does not let an explicit auto scope cross a deny | 同名 |
| 6 | lets an inheriting delegate run under the session bypass | 同名；删掉读回 `by-delegate.txt` 的那半句 |
| 7 | does not let a session on bypass cross a deny, for parent or delegate | 同名 |
| 8 | releases the scope even when the call throws | 同名。原用例里抛错的是 `read` 打开不存在的文件；这里在同一次放行之后用 `stat` 复现这次失败 |

## 6 `tools.test.ts` 的权限用例 → `S/gearsAndTools.test.ts` 与 `D/bashGateTools.test.ts`

该文件共 63 例，其余 48 例测的是 runtime 工具本身（读写与 review、CRLF / BOM / 编码、分页、图片、搜索遍历与 gitignore、exec 与 Stop），不属于 A 类，不在本表。

| # | 原用例 | 去向 |
|---|---|---|
| 1 | evaluates agent / %s / %s as %s（`it.each` 16 行） | `S/gearsAndTools` 同名 |
| 2 | migrates %s into %s / %s（`it.each` 4 行） | `S/gearsAndTools` 同名（`toMatchObject` 改成取 `mode` / `gear` 两个 getter 再比较） |
| 3 | crops write tools in plan / %s, including cached plugin handles（`it.each` 4 行） | **N/A**：测的是 runtime 工具注册表在 plan 下裁剪工具表，以及缓存句柄报 `tool_unavailable_in_mode`，不是闸门的判定。DSH 下 plan 由闸门直接拒绝写，已有覆盖：`permissionBridge.test.ts` › [perm-seed-plan]、[setter-mode]，以及 `perm-plan` 录制 |
| 4 | allows workspace bash in accept-edits but asks for external directories | `D/bashGateTools` 同名；删掉断言输出含 `local` 的那半句 |
| 5 | allows only inspection bash in plan mode regardless of gear | `D/bashGateTools` 同名。`pwd` 的输出断言改成断言放行到工作区 |
| 6 | contributes D14 mode and gear to the fixed prompt slots | `S/gearsAndTools` **改名** contributes D14 mode and gear text to the prompt slots：槽位名和两段文字照旧断言。槽位的拼接顺序原由 runtime 的 `composeSystemPrompt` 决定（N/A）；DSH 按「mode 在前」拼进提示词上下文，已有覆盖：`permissionHost.test.ts` › tells each session its own mode and gear, a delegate its root's, and follows a change |
| 7 | requires approval for writes, denies secrets in auto, and crops plan mutation | `D/bashGateTools` **改名** …and refuses plan mutation。前面几句照旧；最后一句原来断言工具表里没有 `write`（runtime 注册表），改为断言闸门在 plan 下对 `write` 判 `deny` |
| 8 | gates symlink escape before writing a new child | `S/gearsAndTools` 同名；删掉「外部目录里没有生成文件」那半句（不执行就必然成立） |
| 9 | searches with bounded literal matching and skips secret files | **已有覆盖**：`permissionHost.test.ts` › search results (decision 048) › drops denied glob entries and keeps the list off the spill path、drops grep matches in denied files, nested program calls included；`perm-search` 录制。字面匹配与大小写属于 runtime grep 本身 |
| 10 | grants the approved file itself, and clears it on settings change | `S/gearsAndTools` 同名 |
| 11 | denies on approval timeout even when an external approver never settles | `S/gearsAndTools` 同名 |
| 12 | enforces tool whitelist and path deny scopes before grants | `D/bashGateTools` 同名 |
| 13 | executes a model tool call and continuation through the native registry | **N/A**：断言的是 runtime agent loop 与 trace 里的 `permission_decision` 步骤（mode / gear 记录），DSH 没有这份 trace |
| 14 | caps a write tool permission preview before it reaches the trace (permissions-12) | **N/A**：截断的是 runtime trace 监听器写进 trace 的预览，DSH 没有这份 trace；卡片本身照旧显示完整内容 |
| 15 | applies deny scopes inside recursive grep instead of only checking the root | `S/gearsAndTools` 同名。runtime 遍历时对每个条目问 `canTraverse`；DSH 的搜索过滤（决策 048）对每个结果问的也是它。这里断言根目录放行、被 deny scope 覆盖的文件 `canTraverse` 为假、旁边的文件为真 |

## 7 `workerEndToEnd.test.ts` 的权限用例

| # | 原用例 | 去向 |
|---|---|---|
| 1 | routes a write through the approval gate and honours the answer | **已有覆盖**：`permissionBridge.test.ts` › [perm-card-allow]（卡片字段含 `toolName`、`kind: file_change`、`input.content`，允许后放行）；`perm-card` 录制 |
| 2 | a denied approval fails the tool without failing the session | **已有覆盖**：`permissionBridge.test.ts` › [perm-card-deny]、[perm-row-flags]；`perm-card` 录制（同一回合里两次写，先允许后拒绝，回合照常结束） |
| 3 | migrates a legacy tier onto the two D14 axes | **已有覆盖**：`permissionBridge.test.ts` › [setter-tier]、[perm-seed-tier] |

## 8 `nativeWorkerRuntime.test.ts` 的权限用例

| # | 原用例 | 去向 |
|---|---|---|
| 1 | carries the seeded permission axes and trust into the graph | **已有覆盖**：`permissionBridge.test.ts` › [perm-seed-plan]、[perm-seed-bypass]（mode / gear 播种）、[policy-project]（信任）、[perm-card-allow]（应答方接上） |
| 2 | stop aborts the run, which is what settles a parked permission gate | **已有覆盖**：`permissionBridge.test.ts` › [perm-stop]；`perm-stop` 录制 |
| 3 | applies a permission change and refuses one mid-turn | **已有覆盖**：`permissionBridge.test.ts` › [setter-mode]、[setter-busy-dsh-turn]、[setter-busy-running] |
| 4 | lets the gear alone move mid-turn, through its own door | **已有覆盖**：`permissionBridge.test.ts` › [setter-busy-dsh-turn]（回合中只动档位、授权保留）、[grants-gear]、[setter-gear-widen] |

## 9 `skills.test.ts` 的权限用例 → `S/gearsAndTools.test.ts` › the skill gate (from skills)

请求按 runtime `authorizeSkill` 的形状照抄：技能文件路径、`policyValue` 取技能名、`trustedPath`。DSH 的 `skill` 调用走的是同一套 policyValue / trustedPath 规则（`permissionHost.test.ts` › matches skills on their name at a trusted path）。

| # | 原用例 | 去向 |
|---|---|---|
| 1 | loads a skill outside the workspace through the tool without asking for approval | 同名（应答方 `neverAsked`，被问到即失败） |
| 2 | records a permission.activity row for the skill tool | 同名 |
| 3 | lets an explicit skill deny policy rule actually block the tool call | 同名 |
| 4 | lets an explicit skill deny policy rule block /skill:name expansion | **改名** lets an explicit per-name skill deny rule block the skill (the /skill:name request)。`/skill:name` 展开入口是 runtime 自己的（DSH 原生加载技能，决策 101），这里只迁它发给闸门的那次判定，id 照旧用 `skill-expand:pdf` |

## 10 `mcp.test.ts` 的权限用例

| # | 原用例 | 去向 |
|---|---|---|
| 1 | asks the permission gate before the call reaches the server | **N/A**：MCP 已搁置（决策 090），dsh-base 没有 MCP 服务器工具（分片 04 §3 C 类）。按 `policyValue` 匹配的规则由 skill 用例与 `cardOutcomes` 的审计值用例覆盖 |
| 2 | lets an mcp deny policy rule actually block a call under auto | **N/A**：同上 |
| 3 | matches an mcp policy rule by server:tool, the ecosystem's own shape | **N/A**：同上 |

## 验证（本机，2026-10-01）

| 命令 | 结果 |
|---|---|
| `npx vitest run src/shared/permissions src/dsh-host/permissions` | 16 个文件，538 条通过、1 条跳过（跳过的那条在原有的 `permissionHost.test.ts`，不是本次新增）；新增 8 个测试文件 163 条全过 |
| `npx vitest run src/runtime` | 70 个文件 1235 条全过（旧用例原地照跑） |
| `npx vitest run Static Scan Wiring` | 76 个文件 769 条全过 |
| `npx vitest run src/shared/__tests__` | 29 个文件 396 条全过 |
| 四套 tsc（根、agent-host、runtime、dsh-host） | 全部通过 |
| `npx biome check`（10 个新代码文件） | 无问题 |
