# S-2 五档权限（设计）

Role: topic（S-2 方案，2026-10-16）。上位：[README](../README.md) §1 裁决 6、12～15，§3，§4 S-2，§7.4 #2、#19。用户 2026-10-16 设定的工作方式：一般问题按推荐方案自行决定，所有自主决定列在 §1.2，供审阅。

## 0 范围

| 项 | 来源 | 本任务做什么 |
|---|---|---|
| 五档 | 裁决 6、14 | SDK 会话的权限菜单显示 Claude 的五档：手动审批、自动编辑、计划模式、自动模式、跳过权限确认，一一对应 CLI 的 `default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions` |
| 随时切换 | §3 | 会话中途（含回合进行中）经 `setPermissionMode` 生效，CLI 确认后才算切换成功 |
| 计划模式与审阅卡 | §4 S-2 | 模型交计划时出审阅卡；SDK 会话的审阅卡选"批准后用哪一档继续" |
| Auto 的安全检查 | §4 S-2、§6 | 实测 Auto 经网关发什么；假网关能模拟"放行""拦下""检查不可用"三种结果 |
| CLI 自己改档 | 新发现 | 模型进入计划模式、退出计划回到原档、切档被拒等，同步到 Main 与界面 |
| 现有缺陷 | 新发现 | 界面的"计划模式"存为 `{plan, auto}`，宿主对 `auto` 档一律放行，CLI 在计划模式里请示的写操作会被放行（S-0 起就有） |
| 禁止清单 | 裁决 13 | 不补；菜单文案不再说"明确拒绝的规则仍生效" |
| 换模型失败 | #19 剩余 | 见 §1.2 A-14 |

不做：key 隔离（裁决 12，单列一步，在 S-3 放开 hooks 之前做完，设计见 [S-3](s3-project-config.md)）；项目设置（S-3）；"始终允许"的规则跨重开保留（功能对等版）。

## 1 决定

### 1.1 用户裁决（README §1）

- 裁决 6：五档用 Claude 自己的；裁决 14：中文名；裁决 13：不补 DSH 的禁止清单；裁决 15：不加身份句。

### 1.2 自主决定（待审阅）

| # | 决定 | 理由 | 偏离 |
|---|---|---|---|
| A-1 | **存储不变**：仍用 `{mode, gear}` 这一对，五个位置一一对应：`ask`→`default`、`accept-edits`→`acceptEdits`、`{plan, *}`→`plan`、`auto`→`auto`、`bypass`→`bypassPermissions`。原型把 `auto` 映到 `acceptEdits`，改掉 | 五个预设本来就一一对应；IPC、校验、会话偏好存储、重开与崩溃重启的恢复路径都不用动 | 无 |
| A-2 | **宿主不再替 CLI 批准任何请求**：CLI 自己按档位决定哪些不用问；到达 `canUseTool` 的请求，计划模式下**改文件的工具与命令**（Write、Edit、MultiEdit、NotebookEdit、Bash、PowerShell）由宿主直接拒绝（不出卡，告诉模型先交计划），其余（工作区外的读取、网页抓取、MCP 工具等）与其他各档一样出审批卡（提问与交计划除外，它们有自己的卡） | 原来的"`auto`/`bypass` 档一律放行"在 Auto 档会吞掉分类器连拦三次后交给人的请求，在计划模式会放行写操作。实测 CLI 并不替计划模式拦写操作：`canUseTool` 放行，文件就真写了（§4.2），所以由宿主拒；只拒改动不拒读取，与菜单说明"只探索和阅读、不做改动"一致（审查后从"计划模式一律拒"收窄） | 原型行为 |
| A-3 | **切档不替已挂着的卡作答**（SDK 会话）。原来切到 `auto`/`bypass` 会把挂着的卡全部放行 | CLI 不会重新检查已挂起的请求；Auto 档放行挂着的卡等于绕过分类器。界面上有卡挂着时输入框（含权限菜单）本来就收起 | DSH 照旧 |
| A-4 | **SDK 会话回合进行中也能切档，含进出计划模式** | 裁决 §3"随时切换"；CLI 支持中途 `setPermissionMode` | 对 SDK 会话偏离决策 092 #7、166 #7（回合中不许改模式）；DSH 照旧 |
| A-5 | **切档以 CLI 确认为准**：宿主等 `setPermissionMode` 的结果，确认后才改自己记的档（切档途中到来的请求仍按旧档判断）；被拒或 8 秒没回应时，宿主以 `WORKER_PERMISSION_MODE_REFUSED`、消息为原因码抛出，Main 不改写，原样随 IPC 错误到渲染层，界面提示译好的原因并保持原档。不转发 CLI 的英文原句 | 原来是"发出去就算成功"，界面可能显示一个 CLI 根本没进的档 | 无 |
| A-6 | **CLI 自己改档时同步上来**：宿主读 `system/init`、`system/status` 的 `permissionMode`，与自己记的不一致时发 `session.permissions`（新原因 `engine`）；Main 只对 SDK 会话接受这个原因，更新自己记的档（崩溃重启用它），并像计划审阅批准一样记为"来自引擎"：窗口重开会话时交回这一档（`sync`），不拿窗口里旧的覆盖；窗口存的档被引擎拒绝时也交回当前档，打开不失败 | 模型调用 EnterPlanMode、ExitPlanMode 回到计划前的档、Auto 不可用时回退，原来都不会让界面知道 | 无 |
| A-7 | **SDK 会话的计划审阅卡**：选项为"批准，用自动编辑继续"（默认）、"批准，用手动审批继续"、"批准，用自动模式继续"、"批准，用跳过权限确认继续"（二次确认）、"继续规划"（必须写反馈），外加关闭。没有设目标的选项。可选项由宿主写在卡的载荷里，Main 只接受卡上有的选项，渲染层照单显示；DSH 的卡不变。**批准后先切到选中的档、CLI 确认了才放它离开计划模式**；选中的档被拒时改为手动审批并说明原因（`session.permissions` 带 `refusedReason`，界面出警告）；连手动审批也切不了时计划不执行、留在计划模式 | SDK 引擎没有目标；选项与 Claude Code 交计划时的选择一致。只放行不切档，CLI 会回到进计划前的档，可能是跳过权限确认（审查实测） | 对 SDK 会话偏离决策 169 的选项表 |
| A-8 | **SDK 会话不提供目标**：权限菜单里的"设定目标…"不显示，`/goal` 不切换权限 | SDK 引擎没有目标，原来默认选项必然得到"目标没设上"的警告 | 无 |
| A-9 | **新会话与重开会话在引擎确定之前显示哪套名字**：重开的会话按会话索引里 `runtimeIdentity` 的后缀（`.ccsdk.json`）认出 SDK；新会话按开关、所选模型的 `sdkRoute` 与这个构建能否起 SDK 宿主（Main 在模型目录里带 `claudeSdkHostAvailable`，与选引擎用同一个判断）预测；宿主起不来退回 DSH 时，`session.created` 到达后改回 DSH 的名字 | 不新增持久化字段；会话桩后缀本来就是重开时选引擎的依据；S-4 之前的安装包没有宿主，不能显示 SDK 的名字 | 偏离 S-1 时"不从 runtimeIdentity 猜引擎"的说明：只用于显示名字，选模型的路由过滤与 Main 的判断仍只认上报的引擎 |
| A-10 | **保护措施沿用**：自动模式与跳过权限确认都要二次确认；跳过权限确认不能存为新会话默认、开始页不能选、选中时芯片用警示色（决策 023、166），确认文案按 SDK 的实际行为写 | 用户此前对跳过权限确认的裁决（决策 023）不因引擎而变 | 无 |
| A-11 | **按 SDK 的说法选的 Auto、自动编辑，不原样带到 DSH**：新会话本来要走 SDK、宿主起不来退回 DSH 时，`auto` 与 `accept-edits` 改成 `ask` 并发 `session.permissions`（`sync`）；开始页按 SDK 的说法存下的新会话默认档（另存它是在哪个引擎下选的），用在不确定走 SDK 的新会话上时同样读作手动审批 | Claude 的自动模式有检查把关、自动编辑只放行文件编辑与简单文件命令；DSH 同一位置的全自动、自动编辑放行工作区内任何命令，原样带过去是放宽，而中文名一样，用户看不出 | 无 |
| A-12 | Auto 不可用时不隐藏菜单项：选了被 CLI 拒绝就提示原因 | 是否可用只有 CLI 知道（模型、设置、熔断），提前判断会与 CLI 不一致 | 无 |
| A-13 | **计划模式不走 Auto 的分类器**：flag 层钉 `useAutoModeDuringPlan: false` | CLI 缺省在计划模式里把改动类 Bash 交给分类器（§4.2）：分类器放行就在计划模式里执行，网关供不了分类器就一律拒，都绕过了 PiLab；钉住后这些请求到 `canUseTool`，按 A-2 拒绝 | 偏离 CLI 缺省（该项不在 SDK 的类型里，按实测传入） |
| A-14 | **#19 剩余（换模型被 CLI 拒绝时只记日志、回合仍用旧模型）留到 S-5** | 与权限无关；假网关答不了 CLI 的模型校验请求，要先给假网关加这一项才能验 | 无 |
| A-15 | **"本会话允许"沿用官方语义**：CLI 给的建议（含 `setMode acceptEdits`）原样按"仅本会话"生效；由此带来的切档按 A-6 同步到界面并提示"已切换到「自动编辑」" | 官方行为；用户看得到切档。只保留规则、去掉切档会让写文件的卡"本会话允许"等于"允许一次" | 无 |
| A-16 | **Auto 的请求按 SDK 官方的来**（裁决 11）：不关服务端检查（`safeguards` 字段会带本机用户名、主目录、git 远端等上下文），本地检查用 CLI 缺省的 `claude-sonnet-5`、出错退到会话模型、都不行就拒绝（不问人）；写进 README §5 已知限制 | 用户裁决 11；改这些等于改 SDK 的请求 | 无 |
| A-17 | **再钉 7 个仓库能改的变量**（flag 层钉成 `''`）：`ANTHROPIC_DEFAULT_SONNET_MODEL`（Auto 的检查模型与 `sonnet` 子代理，实测可改）、同族 `ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`，`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`（实测可砍掉请求的 beta 与 `context_management`），`CLAUDE_CODE_AUTO_MODE_SERVER`（实测可关服务端检查） | S-1 决定 6 的延续：仓库的 `.claude/settings.json` 今天就在读（`project`），S-3 再加 `local` | 无 |
| A-18 | **CLI 自己拒掉的调用，工具行用 PiLab 的话**：读 `system/permission_denied`，工具行写"Auto mode's safety check blocked this call: <原因>"或"…was not available…"，不用 CLI 的原句（含 Claude Code，§2 第 4 条） | 硬约束 4 | 无 |
| A-20 | **计划模式里，仓库声明更宽档位的子代理也不能改动**：宿主注册一个进程内的 PreToolUse 回调，子代理（`agent_id`）在会话处于计划模式、自身档位不是计划时调用改文件的工具或命令，回 `ask` 交给 `canUseTool`，按 A-2 拒绝；其他档位下仓库的声明照官方行为生效（裁决 5） | 审查实测：仓库 `.claude/agents/*.md` 写 `permissionMode: acceptEdits` 的子代理，在计划模式里不经卡就写了文件 | 无 |
| A-21 | **"本会话允许"只在 CLI 有规则可记时出现**：CLI 没给建议、或标了 `suppressAlwaysAllowRule`（安全检查、检查交给人的调用）时，卡上只有允许与拒绝 | 否则按钮与说明许诺了不会发生的事 | 无 |
| A-22 | **压缩对话进行中不切档**（SDK 会话，`session_busy`） | 压缩会占住宿主的请求队列，排在后面的切档可能在 Main 超时之后才生效，两边对不上（决策 178 对发送的同一条守卫） | 无 |
| A-19 | **假网关模拟 Auto 的检查**：认出检查请求（系统提示或停止符），按提示里的 `CC-CLS-BLOCK` / `CC-CLS-DOWN` 给出拦下 / 500，缺省放行；严重度格式（`claude-sonnet-5`）与 `<block>` 格式（其他模型）都答；新增 `CC-RUN` 让探针自己编排工具调用；`CC-ENV` 带上 beta 列表 | 让 §3.2 的每档探针可确定地复现 | 无 |

## 2 契约

- `session.permissions` 的 `cause` 加 `engine`：引擎自己改了档，载荷是改后的 `{mode, gear}`，选中的档被拒时另带 `refusedReason`。只有 SDK 会话会发；Main 只对 SDK 会话接受。
- 计划审阅卡载荷 `review.choices?`：宿主声明可选项（缺省为 DSH 的四项）。新选项 `run:ask`、`run:accept-edits`、`run:bypass`，`run:auto` 沿用；`decodePlanReviewResponse(response, offered)` 只认卡上有的选项（缺省 DSH 的四项），DSH 的卡与录制夹具不变。
- 切档被拒：宿主抛 `WORKER_PERMISSION_MODE_REFUSED`，消息是原因码：CLI 自己的 `errorCode` 原样（`auto_mode_model`、`auto_mode_settings`、`auto_mode_circuit_breaker`、`auto_mode_fast_mode`、`auto_mode_unavailable`、`bypass_disabled`、`bypass_restricted`、`bypass_not_launched`、`invalid_mode`），加宿主自己的 `timeout` 与 `other`（`PERMISSION_MODE_REFUSAL_REASONS`）。Main 不改写，经 WorkerSlot 成为 `WORKER_RPC_REMOTE_ERROR`，文本 `WORKER_PERMISSION_MODE_REFUSED: <原因>` 随 IPC 错误到渲染层，由 `permissionModeRefusal.ts` 解析并给出译文。`worker_permission_not_applied` 只留给 `applied: false`（SDK 宿主不发）。
- 模型目录 `AgentModelCatalog.claudeSdkHostAvailable?`：这个构建能否起 SDK 宿主（缺省读作能）。
- 新会话默认档旁的 `aiclient:chat:default-permissions-engine`：默认档是在哪个引擎的说法下选的（缺省 DSH）。
- 渲染层新增字典键：五档名称与说明、确认文案、审阅卡的 SDK 选项、切档被拒的提示。

## 3 验证（先定断言，再改代码）

### 3.1 单测

宿主（`src/claude-sdk-host/__tests__/`）：
1. 映射：五个位置各对应一个 CLI 档；`{plan, auto}` → `plan`。
2. `canUseTool`：计划模式（任何 gear）下改文件的工具与命令被拒、不出卡，工作区外的读取与网页抓取出卡；其他各档（含 auto、bypass）都出卡，不直接放行；AskUserQuestion、ExitPlanMode 各走自己的卡；计划模式里仓库声明更宽档位的子代理被送回拒绝（A-20）。
3. 切档：`setPermissionMode` 被等待；成功后才更新，切档途中到来的写操作仍按计划模式拒绝；被拒时 RPC 抛出带错误码的错误，档位不变；挂着的卡不被作答。
4. CLI 改档：`system/status` 报的档与宿主记的不同 → 发 `session.permissions`（`engine`），映射回 `{mode, gear}`；切档请求进行中收到的状态不误报。
5. 审阅卡：SDK 卡载荷带五个选项；批准先切档、CLI 确认后才放行 ExitPlanMode；被拒时切到手动审批并发一条带原因的 `engine`，不出现过时的计划模式；连手动审批也切不了时拒绝 ExitPlanMode。
5a. CLI 自己拒掉的调用（`permission_denied`、只有原句、检查不可用）工具行用 PiLab 的话；重开会话的历史也一样；安全检查原因里的产品名改写通顺；没有可记的规则时卡上不出"本会话允许"。

Main（`WorkerManagerClaudeSdk.test.ts`）：
6. SDK 会话回合中改模式：不报 `session_busy`，发 `worker.setPermissions`；DSH 会话照旧（原测试不改）。
7. `engine` 原因：SDK 会话接受并转发、更新记下的档；DSH 会话丢弃。
8. 退回 DSH：`auto`、`accept-edits` 改 `ask`，并发 `sync`；手动审批、计划模式、跳过权限确认照旧。
9. 切档被拒：`WORKER_PERMISSION_MODE_REFUSED: <原因>` 原样到渲染层；窗口重开时交回引擎报过的档，存的档被拒也照样打开；压缩进行中切档报 `session_busy`。
9a. 桥（`bridgeRpcServer.test.ts`）：异步的设置在完成前不回 `applied: true`；被拒时回错误。

共享与渲染层：
10. `decodePlanReviewResponse` 认新选项；DSH 的四项与夹具不变。
11. 权限菜单（挂真实中文翻译）：SDK 会话显示五个中文名、顺序同裁决 6；回合中不锁；没有"设定目标"；确认文案是 SDK 的；DSH 会话的断言原样通过。
12. 审阅卡按载荷的选项显示；跳过权限确认选项要二次确认。
13. 切档被拒的提示是译好的中文，不含 CLI 原句。
14. 引擎预测：重开会话按 `runtimeIdentity` 后缀；新会话按开关、模型 `sdkRoute` 与宿主是否可用。
15. 说明文案逐档与实测一致（菜单与审阅卡同一份）；按 SDK 说法存的新会话默认档用在别的引擎上读作手动审批。
16. 钉值：A-17 的 7 个变量逐一断言为 `''`。

### 3.2 探针（`host-probe.ts`，只用本机假网关）

每档一个场景，断言看 CLI 实际所处的档（宿主转出的 `system/status`）与卡/工具结果，而不只看卡：

| 场景 | 档位（用界面实际发的那一对） | 断言 |
|---|---|---|
| `mode-manual` | `{agent, ask}` | 写文件出卡；改动类 Bash 出卡 |
| `mode-edits` | `{agent, accept-edits}` | 工作区内写文件、`mkdir` 不出卡；其他改动类 Bash 出卡 |
| `mode-plan` | `{plan, auto}` | 读工作区外的文件出卡（只有这一张）；交计划前的写文件与改动类 Bash 被拒（不出卡，文件不存在）；交计划出 SDK 审阅卡（五个选项）；批准"自动编辑"后下一次写文件不出卡（CLI 确实切了档） |
| `mode-plan-refused`（单独一个工作区跑） | `{plan, auto}` | 工作区设置禁用跳过权限确认；批准"跳过权限确认"后改为手动审批，`engine` 带 `refusedReason: bypass_disabled`；下一次写文件出卡 |
| `mode-auto` | `{agent, auto}` | 检查放行：不出卡、执行；检查连拦三次：前两次不出卡不执行，第三次交给 PiLab 出卡；检查不可用：不出卡不执行；被拒的工具行是 PiLab 的话，不含 Claude Code。要放在最后跑（假网关的检查结果按会话里出现过的标记决定） |
| `mode-bypass` | `{agent, bypass}` | 不出卡，都执行 |
| `mode-switch` | 回合中 | 卡挂着时切到"自动编辑"：切档成功；挂着的卡仍由用户答（用户作答前没有被结算，作答被接受）；同一回合下一个写操作不出卡 |
| `mode-enterplan` | `{agent, ask}` | 模型调用 EnterPlanMode 后，PiLab 收到 `session.permissions`（`engine`，计划模式） |
| `repoenv`（扩展） | — | 仓库设的 A-17 变量不生效：请求的 beta 列表完整；自动模式下的检查不发给仓库指定的模型（假网关对 `repo-model` 回 401，检查失败调用就不执行） |

原有场景（流程 34 条、errors、repoenv）照常全过。

### 3.3 DSH 不受影响

`pnpm typecheck:dsh-host`、`bridge-smoke.ts`；DSH 的回合中锁定测试、审阅卡夹具 `stream.plan-review.json` 不变；`bridge-record.ts --check` 是 Linux 工具，本机跑不了，记入 README §7.4 #20 的合并前手动门禁。

### 3.4 GUI 点验（补充，不作为主要判据）

SDK 会话菜单五档与中文名；回合中切档；交计划出 SDK 审阅卡；DSH 会话菜单不变。

## 4 实测（2026-10-16，假网关，claude.exe 2.1.300）

六组实验各用独立端口与临时目录，脚本留在本机临时目录，不入库。只用本机假网关。

### 4.1 切档

- `setPermissionMode` 成功时 1～2 ms 内返回，随后发一条 `system/status{permissionMode}`；再设同一档不发。每回合开头的 `system/init` 都带当时的档。
- 被拒时抛普通 `Error`，带稳定的 `errorCode`（`auto_mode_settings`、`auto_mode_model`、`bypass_disabled`、`bypass_not_launched`、`invalid_mode`），消息里没有这个码；不发 status，档位不变。
- 启动时的回退不报告：`bypassPermissions` 遇上禁用跳过权限确认的设置会落到 `auto`，只体现在下一次 `init`。
- 回合中切档：已挂起的卡不会被 CLI 作答、取消或重问，新档从下一次权限检查起生效（同一回合内）。
- Auto 的可用性：本地无 GrowthBook 缓存时缺省可用；实测的模型 id 里只有 `claude-haiku-4-5` 被拒（`auto_mode_model`），`claude-opus-5-5`、GLM、DeepSeek 等都算可用。

### 4.2 计划模式

- 写文件请求到 `canUseTool`（`decisionReasonType: 'mode'`）；放行就真写，CLI 不拦。宿主因此在计划模式里拒绝（A-2）。工作区外的读取、Grep、网页抓取，以及不在 CLI 只读名单上的命令也会到 `canUseTool`（审查实测）：读取类出卡，命令按改动拒绝。
- 仓库声明 `permissionMode: acceptEdits` 的子代理在计划模式里写文件不经 `canUseTool`（审查实测，A-20）；进程内回调 hook 的输入带子代理的 `permission_mode` 与 `agent_id`。
- 选中的档被拒时，只放行 ExitPlanMode 会让 CLI 回到进计划前的档（审查实测从跳过权限确认进计划的情形），所以批准要等切档结果（A-7）。
- 缺省（`useAutoModeDuringPlan` 为真）时，改动类 Bash 不到 `canUseTool`，交给 Auto 的分类器；钉成 false 后到 `canUseTool`（A-13）。
- 计划文件写在 `<CLAUDE_CONFIG_DIR>/plans/<slug>.md`（应用私有目录），CLI 自己放行；ExitPlanMode 的 `canUseTool` 输入里带 `plan` 与 `planFilePath`。
- 批准时先 `setPermissionMode(选中的档)` 再放行：两次实测都直接从 `plan` 到选中的档；只放行则回到进计划前的档。选 Auto 而 Auto 被拒时，回到进计划前的档（宿主据 status 纠正，A-6）。
- 模型调用 EnterPlanMode 时 CLI 自己放行，只发 status；"本会话允许"带的 `setMode acceptEdits` 会把整个会话切到自动编辑（A-15）。

### 4.3 Auto

- 主请求带 beta `dangerous-tool-use-2026-09-03`、`afk-mode-2026-01-31` 与 `safeguards` 字段（`classifier_context` 含本机用户名、主目录、cwd、git 分支与远端）。网关的回复不带 `safeguard_results` 时，CLI 本会话改用本地检查，并发一条提到网关地址的 informational 消息（宿主不转发）。
- 本地检查是非流式的额外请求：模型缺省 `claude-sonnet-5`，两段式"严重度"格式（`<severity>N`）；首次请求遇到非 401 错误会把检查模型降为会话模型，此后用 `<block>` 格式。检查不可用时拒绝，不问人，也不计入连拦次数。
- 工作区内的写文件与 `mkdir` 等走"自动编辑"的快路，不经检查；解释器执行（`node -e`）、工作区外的写会经检查。
- 连拦 3 次（或累计 20 次）后，CLI 把下一次调用交给 `canUseTool`（`decisionReasonType: 'classifier'`）；放行不重置计数。
- 拒绝以 `system/permission_denied` 报告，消息原句提到 Claude Code（A-18）。

### 4.4 仓库能改的变量（S-3 的实验里一并测）

仓库 `.claude/settings.json` 与 `settings.local.json` 的 `env` 能改 `ANTHROPIC_DEFAULT_SONNET_MODEL`、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`、`CLAUDE_CODE_AUTO_MODE_SERVER`；flag 层钉成 `''` 后钉值赢（A-17）。仓库设的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 被 CLI 忽略；`CLAUDE_CODE_AUTO_MODE_MODEL`、`CLAUDE_CODE_BG_CLASSIFIER_MODEL` 在 2.1.300 里无可见效果。

## 5 实现记录（2026-10-16）

### 5.1 落在哪里

- 宿主 `sdkSessionRuntime.ts`：模式映射与反向映射、`canUseTool`（计划模式拒改动）、子代理守卫 hook、切档等待与原因码、CLI 改档同步（`noteCliMode`/`reconcileCliMode`）、`leavePlanMode`、`permission_denied` 改写（实时与历史）、"本会话允许"的条件；`cliEnvironment.ts` 再钉 7 个变量。
- 桥 `bridgeRpcServer.ts`：三个设置接口可返回 promise，等完再回 `applied: true`，被拒回错误；DSH 仍同步。
- Main `WorkerManager.ts`：SDK 会话回合中可切档、压缩中不切；`engine` 原因只收 SDK 会话并记为"来自引擎"；审阅卡只认卡上的选项；退回 DSH 收窄；窗口重开遇到被拒的档交回当前档。`claudeSdkHostAvailability.ts` 一个可用性判断，选引擎与模型目录共用。
- 渲染层：权限菜单按引擎显示两套名字与说明（`sdkModeCopy.ts` 一份文案、`chatEngineView.ts` 引擎预测）、切档被拒的提示（`permissionModeRefusal.ts`）、审阅卡按载荷的选项、工具行的审阅结论、新会话默认档带引擎。
- 共享：`planReview.ts` 的 SDK 选项与按卡解码、`runtimeEvents.ts` 的 `engine` 与 `refusedReason`、`runtimePermission.ts` 的 SDK 名字、`claudeSdkEngine.ts` 的拒绝原因。
- 假网关 `CC-RUN`、自动模式检查的模拟、`CC-ENV` 的 beta 列表、`repo-model` 回 401；探针 8 个新场景。

### 5.2 与初稿不同之处

- A-2：初稿"计划模式到 `canUseTool` 的一律拒绝"，审查实测工作区外的读取与网页抓取也会到这里，收窄为只拒改动。
- A-5、§2：拒绝的错误码不是新造的 `permission_mode_unavailable`，而是宿主的 `WORKER_PERMISSION_MODE_REFUSED` 原样透传（Main 不包装远端错误，渲染层本来就解析 IPC 错误文本）。
- A-7：初稿"先发切档请求、立即放行，被拒靠 CLI 自己的报告纠正"；审查实测被拒时 CLI 会回到进计划前的档（可能是跳过权限确认），改为等切档结果。
- A-11：初稿只收窄自动模式；审查指出 DSH 的自动编辑也比 SDK 的宽，一并收窄，并扩到开始页的默认档。
- 新增 A-20～A-22（子代理守卫、"本会话允许"的条件、压缩中不切档）。

### 5.3 验证结果

- 三套 tsc 0 错误；biome 无问题。
- 单测：宿主 sdkSessionRuntime 40 条与 cliEnvironment 20 条、Main 的 SDK 用例 39 条与 DSH 的 WorkerManager 用例、桥 36 条、渲染层新增 3 个文件，全过；全量 vitest 的失败文件与环境基线一致（Windows 未开开发者模式时建符号链接 EPERM 等），无新增。
- 关键修复逐一做变异检查：去掉修复或恢复旧行为时对应用例失败（宿主 11 处、Main 4 处、探针 2 处：模型别名钉值、挂着的卡由用户答）。
- 探针（本机假网关，claude.exe 2.1.300）：流程 35、各档 28、`mode-plan-refused` 3、`errors`+`repoenv` 33，全过。
- 未做：真实网关上的自动模式回合（README §9.2 #32，待用户）；Linux；GUI 点验（§3.4，留到 S-3 之后与 S-3 一起点）。
