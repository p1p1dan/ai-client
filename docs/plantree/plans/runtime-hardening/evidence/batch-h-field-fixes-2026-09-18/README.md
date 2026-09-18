# 批次 H 落地证据 — T033 现场反馈修复（2026-09-18）

Role: evidence。记录批次 H（T077～T087 + 提级的 T053）的落地事实、验证方式、待上机验证清单与本轮新增的未决问题。任务身份与状态见 [roadmap.md](../../roadmap.md) 批次 H；来源与根因见 [topics/t033-field-day/07-findings.md](../../topics/t033-field-day/07-findings.md)；设计选择见[决策 023](../../decisions/023-bypass-permissions-tier.md)、[024](../../decisions/024-prompt-cache-ttl-split.md)、[025](../../decisions/025-search-tool-native-over-pi-fff.md)、[026](../../decisions/026-permission-grant-granularity.md)。

## 状态

**代码已分 13 个本地提交落地，均未推送**（分支 `feat/runtime-evolution`）。分批提交前的验证（全量 Vitest + 三套 typecheck）已做但未打包；**2026-09-18 开发机 CDP 点验进行中**，结果见 [pointcheck/README.md](pointcheck/README.md)。效果最终留给 T033 第二轮上机日现场确认。

## 提交

| 提交 | 内容 | 任务 |
|---|---|---|
| `8f39e3d3` | prompt cache TTL 主 1h / 子 5m 分离并暴露设置 | T077 |
| `c18d92dc` | 设置弹窗内下拉与嵌套弹窗层级 | T079 |
| `0a97e6d3` | 新增完全放行档 bypass | T078 |
| `6875fa47` | 回合进行中热切换档位，等待中的授权按新档重判 | T080 |
| `4721cede` | 授权记忆按目录与命令前缀记忆并随会话持久化 | T081 |
| `97c08b58` | 委托子代理期间上下文占用不再归零 | T053（仅现场反馈 #5 那半） |
| `8ba25048` | 搜索工具去逐项 realpath、缓存权限正则、支持 .gitignore；提示词禁止 bash 搜索 | T083 |
| `04984979` | 保管箱变更后同步重写 TUI 的 auth.json | T082 |
| `3d2c3cfd` | 上下文占用指标改为点击展开 | T084 |
| `b930b5b9` | TUI 新建会话在终端关闭时通知 | T086（第一版） |
| `6913c264` | 授权记忆文件类只记那一个文件，不再放大到目录（Q023） | T081 |
| `0a4f6f61` | 放宽档位后的自动放行不再单独标记（Q025） | T080 |
| `f3b658d4` | TUI 新建会话在终端关闭时登记进侧栏，并固定 /new 落点目录（Q026） | T086 |

验证方式：分批提交前跑过一次全量 Vitest（429 文件 / 6641 条全绿）；每个提交单独过三套 typecheck（根 / `src/runtime` / `src/agent-host`）；后三个修正提交（`6913c264` / `0a4f6f61` / `f3b658d4`）各自相关测试绿（352 / 267 项）。

## 落地明细

| 任务 | 状态 | 落地要点 |
|---|---|---|
| T077 缓存 TTL 主/子分离 | 已提交（`8f39e3d3`，本地未推送） | 新 `src/shared/types/promptCacheTtl.ts`（`'5m'` / `'1h'`，默认主档 1h、子代理档 5m）；通路 renderer 设置 store → main `promptCacheSettings.ts` → WorkerManager spawn → bootstrap payload（workerRpc 守卫拒非法值；`piWorkerRpcServer` 的 `sameBootstrap` 纳入该字段）→ `nativeWorkerRuntime` 译成 pi-ai 的 short/long → agent-loop 的 `cacheRetention`（在重试工厂之前注入）与 `subagent/run.ts`（必填，默认 short）。设置页：主档在 PiModelManagementSettings，子档在 PiSubagentsSettings。SDK 实跑验证：long → `cache_control.ttl:"1h"`；不需要 beta 头；模型定义 `supportsLongCacheRetention` 默认 true。可观测性零代码改动：pi 自身保留了 `cacheWrite1h` 这个分桶且已经进 `runs.jsonl`。Windows 验证配方：设 `AICLIENT_RUNTIME_TRACE_DIR` 启动应用，grep `runs.jsonl` 里的 `cacheWrite1h` 字段——开发机上该值恒为 0，说明中转把 1h 参数吞掉了（详见下方「待上机验证清单」与 [Q021](../../open-questions.md)）。改设置只对下一次启动的 runtime 生效，不影响正在跑的会话。一次性工具调用（`nativeUtility`）尚未接线，仍固定走 5m 档（已由[决策 024](../../decisions/024-prompt-cache-ttl-split.md)追加注记结案 Q024：维持固定 5m，不跟随主档）。 |
| T078 完全放行档（bypass） | 已提交（`0a97e6d3`，本地未推送） | `PermissionGear` 类型新增 `bypass`；`permissions/index.ts` 在 auto 判定之前加 `bypass → allow` 分支，`canTraverse` 改用 `skipsApproval()` 判断；子代理定义的类型层禁止显式声明 `bypass`（子代理继承父级时才能拿到）；`ComposerPermissionTrigger` 加二次确认面板，档位激活期间用 destructive 配色持续提示；`writeDefaultPermissions` 收到 `bypass` 时不落盘（读到旧存档里的 `bypass` 会降级为 `auto`）；无会话时该选项禁用。**bypass 档下仍然拒绝**的情形：`allowedTools` 白名单之外的工具、用户显式 deny 规则、内置路径黑名单（`*.env`、`~/.ssh/*`、`*.pem`、`*.key`、`id_rsa*`、`~/.aws/credentials`）、plan 模式裁剪、deny scope。**对原始现场结论的一处更正**：默认策略 `BASH_RULES = {'*': 'ask'}` 本身没有内置的 `rm` 拒绝规则，因此 bypass 档下 `rm -rf` 会直接执行，不经过任何拦截——这不是本任务引入的新洞，是默认策略原有的边界，只是在完全放行档下第一次变得可直接触发（已由[决策 023](../../decisions/023-bypass-permissions-tier.md)追加注记结案 Q022：不加破坏性命令黑名单）。顺手修了一个假绿测试：`subagentToolsPermissions` 里「auto 不能越过 deny」这条原本靠读 `.git/config` 触发 `ENOENT` 来间接满足断言，并非真的验证了 deny 生效。 |
| T079 设置弹窗内下拉层级 | 已提交（`c18d92dc`，本地未推送） | 11 个设置页文件、29 处 `SelectPopup` 调用点补齐 `DROPDOWN_IN_MODAL`；`ProviderSetupDialog` 补 `zIndexLevel="nested"` 且内部两处下拉改用 `DROPDOWN_IN_NESTED_MODAL`；`PermissionPolicySettings` / `PiSubagentsSettings` / `RemoteSettings` 三个 `AlertDialog` 补 `nested`；`TerminalAppearanceSettings` 的 `ComboboxPopup` 显式声明层级（组件本身已能自动探测，此处只是显式化）。Menu 类弹层目前未接入 `Z_INDEX` 令牌体系，但核实后确认它们目前没有一个出现在 Dialog 内部，暂不构成同类问题。 |
| T080 运行中切权限档 | 已提交（`6875fa47` + `0a4f6f61`，本地未推送） | 只放开「档位（gear）」，「模式（mode）」仍在运行中锁死：新增 RPC `worker.setPermissionGear`（payload 不带 `mode` 字段，避免误改模式）；permissions 插件新增 `setGear()`，切档不清空 `grants`、不递增 `epoch`；档位强弱顺序为 `ask < accept-edits < auto < bypass`。变宽时，正在排队等卡的请求按新档重新走一遍 `evaluate()`，能放行就撤卡；已发出但排在后面尚未发卡的请求醒来后重新判定，可连锁放行。变严只影响之后的新请求，不追溯已发出的卡。渲染层：发送期间档位（gear）仍可选，模式（mode）选择器灰掉。**Q025 已结案**：不区分「因放宽档位而放行」与用户主动点允许，wire 层新增枚举值 `gear_widened` 已删除，撤卡一律按普通 `allow` 结算（用户原话「不要区分」），修正提交 `0a4f6f61`。 |
| T081 授权记忆放宽 + 持久化 | 已提交（`4721cede` + `6913c264`，本地未推送） | 新文件 `permissions/grants.ts`。bash 记住 `[命令前缀, 工作区根]`：前缀取命令的第一个词，若是多子命令工具（`npm pnpm yarn npx git cargo dotnet go make cmake docker kubectl python python3 node`）则取前两个词；一条命令可能被切成多段（复用 `bash-analysis` 现成的 `commands` 拆分结果），必须全部分段都命中已授权前缀才放行；前缀已授权且 `unresolvedPaths`（静态分析解析不出的路径）非空时同样放行；命令涉及的路径超出工作区根仍会追问；内置路径黑名单（`.env`/`.ssh` 等）在这套放宽规则之外，始终追问。MCP 与技能调用仍要求精确匹配。持久化：写入会话 JSONL 的一条自定义（custom）条目 `aiclient.permissionGrants`（版本号 1，每次都是全量快照，重开会话时以最后一条为准；版本号不认识则当空处理）；`configure()` 清空授权记忆时也会写一条空记录，保持可回放。授权卡的副标题改为按 `sessionGrantScope`（新事件字段）动态说明「这次记住的是什么」，而不是固定文案。**Q023 已由[决策 026](../../decisions/026-permission-grant-granularity.md)结案**：文件类工具最初实现记的是 `[工具, 父目录]`（命中该父目录下的子路径即放行），当第一次批准的文件恰好在工作区根目录下时会把整个工作区都放行——用户拍板改为只记批准的那一个文件本身（对齐 Claude Code，不放大到父目录/工作区），跨工具仍不共享记忆；bash 前缀粒度维持不变（不额外收紧到两词）；存活期维持随会话持久化、不跨会话，修正提交 `6913c264`。 |
| T053 委托时上下文占用归零（提级并入批次 H） | 已提交（`97c08b58`，本地未推送） | `projector.ts` 新增缓存字段 `lastContextUsage`，子代理委托产生的 `delegated()` 事件复用这份缓存而不是把第二个参数硬写成 `undefined`（此前的根因就在这里，导致委托进行时上下文占用徽标显示归零）。两份 golden 录制 fixture 重新录制（差异只多出 `context` 与 `sessionGrantScope` 两个字段，无其他行为变化）。 |
| T082 TUI 凭据不同步 | 已提交（`04984979`，本地未推送） | **对现场根因排查的一处修正**：进一步核查发现，五个保管箱（vault）写入点其实都已经挂了 `auth.json` 重写的补救钩子，并非完全没有触发时机；但这些钩子全部是「不等待、不捕获失败」的异步调用（甚至有一处自建服务的调用连 `.catch` 都没有）。也就是说，现场复现的版本里这些钩子理论上都在，真正的缺口是一个时序竞态窗口——保管箱写入与 `auth.json` 重写之间没有可靠的先后保证，TUI 恰好在窗口内读到旧文件。修法：`CredentialVault` 新增 `onChange` 回调（`save` / `saveUserProviders` / `clear` 成功后触发，监听器自身抛错不影响这些方法原有的返回值）；`main/index.ts` 装配 `wireVaultAuthJsonResync`，把这个回调接到已有的 `writeUserProviderRuntimeConfig` 上做合并重写（不会因此发出任何额外的网络请求）。同时排除了一个备选病因：「TUI 读取的是另一个 `agentDir`」——核实两侧用的都是同一个 `getAppPiAgentDir()`，路径不是问题所在。claude provider 的凭据来自托管目录，走 `'onboarding'` 流程，本身跟随账号登录状态，不受本次改动影响。 |
| T083 工具提示词 + 搜索性能 | 已提交（`8ba25048`，本地未推送） | 在 tool-guidance 提示词里加了一条「搜索要用 glob/grep 工具，不要用 bash 跑 grep/find/rg」。性能优化：`walk()` 遍历从「逐个路径都调一次 `realpath`」改成「进入一个目录只调一次 + 用 `seen` 集合防止符号链接绕圈」；`policy.ts` 的正则表达式按 pattern 缓存，不再每次都重新编译；路径策略（pathPolicy）规则按 `(平台, home 目录)` 这个组合编译一次并复用；新文件 `tools/gitignore.ts` 实现目录级 `.gitignore` 识别（新增参数 `respectGitignore`，默认开启，只在搜索根以下的目录生效）。Linux 开发机基准测试（18,848 个文件的目录树）：glob 全量搜索从 9,877ms 降到 2,962ms（关闭 gitignore 识别）/ 1,241ms（开启 gitignore 识别，因为能提前跳过大量目录）；grep 从 16,551ms 降到 11,213ms / 4,667ms。CPU profile 显示优化前 `realpath` 调用累计耗时 4.4 秒、正则编译累计耗时 1.65 秒，这两处正是本次优化的目标。`readDirectory` 工具本身在同进程内直接调 `opendir`、不走 RPC，未改动。**Windows 环境下未实测**，性能数字是否同样成立留给上机日。 |
| T084 上下文浮层改点击 | 已提交（`3d2c3cfd`，本地未推送） | `ComposerUsageChip` 由悬停触发的 Tooltip 改为受控的 Popover 组件：点击展开/收起，切换会话时自动收起。`popover.tsx` 新增 `zIndex` 属性，把原来写死的 `z-50` 改成走 `Z_INDEX.DROPDOWN`（值为 40）——这个改动顺带影响了 `UserFooterPill` 账号卡片的层级，尚未点验是否有副作用。 |
| T085 子 agent 独立展示位 | 未开始，阻塞于 [Q019](../../open-questions.md) | 子代理独立展示位的具体形态（侧边抽屉 / 独立浮窗 / 可钉住面板）未拍板，本任务未动工。 |
| T086 TUI `new` 解绑提示 | 已提交（`b930b5b9` + `f3b658d4`，本地未推送） | 排查确认：pi 自身的 `/new` 命令没有任何可拦截的开关，且 TUI 模式下不会回调到本应用的新会话路径；执行后新会话落在 `dirname(sessionFile)` 这个目录下。第一版方案（`b930b5b9`）：打开终端时记录一次目录快照，终端停止时扫描 diff，一旦发现一个索引里不认识的新 `.jsonl` 文件，就用 Electron 系统通知报出这个文件路径（新文件 `terminal/piTuiStrandedSessions.ts`，接线在 `ipc/piTui.ts`），当时判断是「只提示、不自动登记」——因为这类会话是 pi 自己的格式，本应用的 runtime 打不开，自动登记进侧栏会让用户点开看到报错。**Q026 已结案（`f3b658d4`）**：进一步排查发现这个判断有误——pi `/new` 写出的会话文件与本应用格式只差首行头，runtime 打开时已有自动转换（`legacy.ts` 的 `prepareSessionConfig` 转成 `.native-v4.jsonl` 并 resume，主进程改绑索引的逻辑现成可用），登记进侧栏并不会变成点开报错。改为：终端关闭时读取新会话文件头，登记进索引并广播刷新侧栏，登记失败才退回弹系统通知；同时 spawn TUI 时显式传 `--session-dir dirname(sessionFile)`，堵住工作区 `.pi/settings.json` 可改落点的漏洞。局限：只在终端停止时才扫描比对，如果用户一直开着 TUI 不关闭，不会触发提示——这一点已直接记在本条落地说明里，不再作为独立待拍板问题跟踪。 |
| T087 网关 503 | 推迟，另行跟进 | 现场两段短测试里 claude provider 一次未成功、142 秒零输出，判断为独立问题，与「输出变慢」（现象 #8）无关，本批次不处理。 |

## 顺带修复

排查过程中发现两条因今天的改动而挂死的渲染层测试，一并修复：

- `subagentPanelMount` 与 `SettingsContent` 两个测试文件都用了 zustand 的 `persist` 中间件，它在模块被 import 的瞬间就会触发 rehydrate；`electronAPI.settings` 这个桩必须放在 `vi.hoisted` 里才能在 rehydrate 发生之前生效，否则会读到 `undefined` 报错。
- `SettingsContent` 测试里对各设置面板的 mock 清单本身已经比源码落后 4 项（源码已经新增了 4 个面板，测试的 mock 列表没有同步），一并补齐。

## 验证

**全量 Vitest**（Linux 开发机，单 worker）：**429 文件 / 6641 条用例全部通过**。对比 T032 收口的 413 / 6271、批次 G 收口的 425 / 6535，本次 +4 文件 / +106 条，净增部分为批次 H 十项任务的新增与调整用例（含 T077 的 promptCacheTtl 链路、T078 的 bypass 档与黑名单、T080 的 gear_widened 撤卡、T081 的 grants 匹配与持久化、T083 的 walk/policy 性能与 gitignore、T053 的 projector 缓存等，以及顺带修复的两个渲染层测试文件）。

**门禁**：根 `tsc --noEmit`、`src/runtime` 子包 `tsc --noEmit`、`src/agent-host` 子包 `tsc --noEmit` 三套全部通过。

**未做的验证**：未打包、未在真实 Windows 环境实测。本轮改动**已分 13 个本地提交落地，均未推送**（见上方「提交」表）。

## 本地点验

2026-09-18 开发机 CDP 点验进行中，结果见 [pointcheck/README.md](pointcheck/README.md)。

## 待上机验证清单（T033 第二轮）

以下各项在开发机上无法验证或只做了部分验证，需要在 Windows 测试机上用打包版本现场确认：

1. **T077 缓存 TTL**：设 `AICLIENT_RUNTIME_TRACE_DIR` 后跑一段真实对话，检查 `runs.jsonl` 里 `cacheWrite1h` 分桶是否真的被触发过——开发机上该值恒为 0，需要确认是应用没发对参数，还是中转/网关把 `ttl: '1h'` 吞掉或改写了（结果记入 [Q021](../../open-questions.md)）。
2. **T083 glob 性能**：在 Windows 的大目录树下复测 glob/grep 优化前后的耗时对比，确认 Linux 开发机测得的降幅（glob 9,877ms → 1,241ms、grep 16,551ms → 4,667ms）在 Windows 上是否同样成立。
3. **T078 bypass 档**：二次确认弹窗的实际交互体验、激活期间持续可见提示的观感，以及 `rm -rf` 等破坏性命令在该档下确实不经拦截直接执行的行为是否符合预期。
4. **T080 运行中切档撤卡**：实际操作「运行中把档位调宽，排队中的授权卡自动撤销并放行」这条连锁反应，确认界面上撤卡的观感与时机是否顺畅。
5. **T086 TUI 通知与登记**：验证终端关闭后新会话确实登记进侧栏索引且刷新可见；登记失败时系统通知在 Windows 上确实弹出且文案可读。
6. **T079 下拉层级**：在弹窗内实际点开「添加 AI 服务」下拉和其余 28 处修复点，确认层级问题彻底消失、无新的遮挡组合。

## 本轮新增未决问题（编号接 Q021 之后）

| ID | 问题 | 当前状态 |
|---|---|---|
| Q022 | bypass 档下没有内置的 `rm` 拒绝规则，`rm -rf` 直接执行——这个风险可以接受，还是要给 bypass 档单独加一份最小的破坏性命令黑名单？ | 已结案（2026-09-18），见[决策 023](../../decisions/023-bypass-permissions-tier.md)追加注记：不加黑名单，保留的硬拒绝只剩 allowedTools 白名单 / 用户自配 deny 规则 / 内置路径黑名单 / plan 模式裁剪 / deny scope 五道系统性防线 |
| Q023 | 授权记忆：当父目录恰好等于工作区根时（比如第一次批准的就是根目录下的 `README.md`），当前规则会让这条授权记忆覆盖整个工作区——是否应该降级为精确路径匹配？以及 `rm`/`mv`/`dd` 这类单词命令的前缀匹配粒度是否也要收紧到取前两个词？ | 已结案（2026-09-18），见[决策 026](../../decisions/026-permission-grant-granularity.md)：文件类降级为只记那一个文件（对齐 Claude Code），bash 前缀粒度维持不变（不收紧到两词），存活期维持随会话持久化不跨会话 |
| Q024 | 默认把主对话缓存 TTL 定为 1 小时，会抬高写入成本（约 1.25 倍单价，且落在更贵的 1 小时档），对短会话是净亏——默认值是否应该保持 1 小时？一次性工具调用（如 compact 摘要）当前固定走 5 分钟档，是否也应该跟随主档？ | 已结案（2026-09-18），见[决策 024](../../decisions/024-prompt-cache-ttl-split.md)追加注记：TTL 由设置项控制、用户自行设定，默认维持主 1h / 子 5m；nativeUtility 仍固定 5m |
| Q025 | T080 新增了 wire 层枚举值 `gear_widened`——是接受这处协议契约变更，还是退回去复用已有的 `allow` 结果、不带这个新的 `autoReason`？ | 已结案（2026-09-18，记入 T080 落地注记，未另立决策）：不区分，`gear_widened` 已删除，改按普通 `allow` 结算 |
| Q026 | T086 只在终端停止时才扫描比对，常驻不关闭的 TUI 不会触发提示；系统通知如果被用户关闭，就只剩日志可查——是否要改成应用内 toast（需要新增一条 IPC 通道）？ | 已结案（2026-09-18，记入 T086 落地注记，未另立决策）：改为登记进索引并广播刷新侧栏而非单纯提示；「常驻不关闭不触发」的局限已直接记在落地说明里，不再单独跟踪 |

## 相关文件

- 来源与根因：[topics/t033-field-day/07-findings.md](../../topics/t033-field-day/07-findings.md)
- 任务身份与验收标准：[roadmap.md](../../roadmap.md) 批次 H
- 决策：[023](../../decisions/023-bypass-permissions-tier.md)（完全放行档）· [024](../../decisions/024-prompt-cache-ttl-split.md)（缓存 TTL 分离）· [025](../../decisions/025-search-tool-native-over-pi-fff.md)（搜索工具自建）· [026](../../decisions/026-permission-grant-granularity.md)（授权记忆粒度）
- 未决问题：[open-questions.md](../../open-questions.md) Q019～Q021 仍待拍板 / 待验证；Q022～Q026 均已结案
