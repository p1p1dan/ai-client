# P1-7 分片 04 · 工具行映射全表与 Windows 文案

Role: detail shard。上位：[P1-7 方案](../p1-7-renderer.md)。回答调研问题 3。工具名与参数出处见[分片 02 §7](02-dsh-facts.md)；我方现状见[分片 01 §4](01-current-state.md)。

## 1 约定

- **动词**：`TOOL_VERBS` 的英文键是词典主键，中文沿用决策 034 的「图标 + 两字类型」风格（`i18n.ts:2609-2666`）。三态依次为 完成 / 进行中 / 被拒（从未执行）。新键都要进 `zhTranslations`，并由新增的 `dshToolVocabulary.test.ts` 逐个枚举校验。
- **图标**：`toolIconKind()` 只返回类别，`ToolRows.tsx:137-148` 把类别映射成 Lucide 图标。新增类别：`image`（`Image`）、`todo`（`ListChecks`）、`goal`（`Target`）、`job`（`Layers`）、`workflow`（`Workflow`）、`mcp`（`Plug`）、`deliver`（`FileOutput`）。
- **参数摘要**：单行；路径、命令、id 用 ident（等宽、截断），自然语言用 prose。`ARG_COVERED_FIELDS` 列出摘要已经说过的字段，其余字段进展开体。
- **DSH 用 `file_path`**：小写 `read` / `edit` / `write` 的摘要改为 `file_path ?? path`；`path` 仍然兼容（HEAD bridge 的别名与旧会话都在用）。

## 2 DSH 内置工具（我方组合里挂载的）

| 工具 | 图标 | 动词键 → 中文 | 参数摘要 | 展开体 | 备注 |
|---|---|---|---|---|---|
| `read` | read | Read → 读取 | `shortPath(file_path)`，带 `offset` / `limit` 时加 `L10-60` | 输出 | 文件名可点开（`deriveFileLink` 已认 `file_path`） |
| `read_image` | image | Viewed image → 看图 | `shortPath(file_path)` | `(image)`；文件可点开预览 | 新动词；要求路由声明图片输入（P1-5） |
| `write` | edit | Edited → 编辑 | `shortPath(file_path)`，流式时加「已收到 N 行」 | 由 `content` 生成的整文件差异 | `toolDiff.ts` 已兼容 `file_path` |
| `edit` | edit | Edited → 编辑 | 同上 | `old_string` / `new_string` 差异；结果里 fs `meta` 的上下文差异优先（P1-4d 转 `review`） | — |
| `glob` | search | Searched files → 搜索 | `pattern（仓库名）` | 命中列表浮层 | — |
| `grep` | search | Grepped → 搜索 | 同上；`path`、`include` 进展开体 | 命中列表浮层 | — |
| `bash` | terminal | Ran → 终端 | 命令摘要（去掉 `cd … &&`，截 40 字） | 命令全文、`description` 作说明、运行中实时尾部、结束后的输出与退出码 | 见 §4 |
| `pwsh` | terminal | Ran → 终端 | 命令摘要（再去掉 `Set-Location …;` 等，§4） | 同上 | Windows 专有 |
| `job_output` | job | Read job output → 后台输出 | `bash-3 · npm test`（标签从后台任务 store 查，查不到只显示 id） | 输出 | `wait: true` 时运行中显示「等待中」 |
| `job_list` | job | Listed jobs → 后台列表 | 「全部后台任务」 | 列表 | — |
| `job_kill` | job | Stopped job → 停止后台 | `bash-3 · npm test` | 结果 | — |
| `subagent` | delegate | Delegated → 已委派 | `description` | 子代理泳道（分片 03 §5） | 缺省后台可续 |
| `subagent_fork` | delegate | Delegated → 已委派 | 「分叉 · 」+ `description` | 子代理泳道 | one-shot |
| `send_message` | delegate | Messaged subagent → 发消息 | `→ <子代理标签>`（按 `agent_id` 查泳道） | 消息全文 | 活动落回原泳道 |
| `interrupt_agent` | delegate | Interrupted subagent → 打断 | `<子代理标签>` | 结果 | — |
| `list_agents` | delegate | Listed subagents → 已列出子 Agent | 「直接子代理」或「全部后代」 | 列表 | 复用现有词条 |
| `todo_write` | todo | Planned → 已规划 | 「3/7 已完成」 | 清单（与待办卡同一组件） | 不再显示参数 JSON |
| `get_goal` | goal | Checked goal → 查看目标 | 目标文本（截断） | 结果 | — |
| `create_goal` | goal | Set goal → 设定目标 | 目标文本 | 结果 | — |
| `update_goal` | goal | 按 `action` 选词：complete → 完成目标；blocked → 目标受阻；pause → 暂停目标；resume → 继续目标；edit → 修改目标 | 阻塞原因或新目标 | 结果 | `toolVerb` 需要读输入（小改动） |
| `exit_plan_mode` | plan（同 Claude 时代的 `ExitPlanMode`） | Planned → 已规划 | 计划的第一个标题 | Markdown 计划 | 我方组合里基本不触发（分片 02 §2） |
| `skill` | tool（维持现状） | Loaded skill → 已加载技能 | 技能名 | 结果 | 复用现有词条 |
| `workflow` | workflow | Ran workflow → 工作流 | `meta.name` | 脚本说明、阶段 | 后台运行时进后台任务条 |
| `list_mcp_resources` / `list_mcp_resource_templates` | mcp | Listed resources → 列资源 | `server` | 列表 | 资源工具来自 `dsh-mcp-resources` |
| `read_mcp_resource` | mcp | Read → 读取 | `server · uri` | 内容 | — |

## 3 暂不可见、但保留映射的工具

| 工具 | 为什么现在看不到 | 映射 |
|---|---|---|
| `web_search` / `web_fetch` | 我方 bundle 关着，P1-5 可能经网关重开 | web · Searched → 搜索 / Fetched → 获取；`query` / `url` |
| `present` | dsh-base 不挂 | deliver · Presented → 交付；文件名列表 |
| `run_code` | 只在 PTC 模式 | terminal · Ran code → 代码 |
| `list_subagent_models` | 只在开启模型选择设置时 | delegate · Listed models → 列模型 |
| `ralph` | dsh-base 关 | 走 §5 的兜底 |
| `ask_user_question` | 包不在树里 | 复用现有 `ask` 的词条与问答卡 |
| 决策 062 的委派工具（P1-16d） | 待 U4 拍板 | delegate · Delegated → 已委派；摘要 `<代理名> · <description>` |
| `mcp__<server>__<tool>`（P1-16b） | MCP 桥待移植 | mcp · Called → 调用；摘要 `server · tool`（现有 `mcpToolLabel`） |

## 4 shell 行细则（bash / pwsh）

- **摘要**：`commandSummary` 现在只剥 `cd <路径> &&`（`toolCard.ts:1302`）。pwsh 另剥这些前缀（不区分大小写，可连续多个）：`cd <路径>;`、`Set-Location [-Path] <路径>;`、`Push-Location <路径>;`、`pushd <路径>;`，以及 pwsh 7 的 `… &&`。只影响显示，展开体仍是原命令。
- **description**：DSH 要求每次写 5～10 个词的说明，并期望显示在界面上（`dsh-tool-bash/lib/index.js:499`）。行上仍然显示命令摘要，延续 2026-09-22 用户「限制长度显示调用了什么，具体内容在展开栏里」的裁定；说明放在展开体第一行。模型常用英文写说明，放在行上会让中文界面混出整句英文。
- **运行中行尾**：DSH 的缺省时限 120 s、上限 600 s，到时限**转后台而不是被杀**。行尾从「12s / 2m」改成「12s · 2 分钟后转后台」；`run_in_background: true` 的调用立即结束，结局写「已在后台启动 · bash-5」。
- **实时输出**：见分片 03 §4.1。
- **退出码**：按 DSH 的 `[exit code: N]` 标记解析（`dsh-shell/lib/types/render.d.ts:27-39`），非 0 显示中性的「退出码 N」小标，不标红；这与 DSH、1.0.x「非零退出码由模型判断」一致。
- **已停止**：Stop 中止的命令在持久结果里是 `error.code: 'ABORTED'`（分片 02 §6）。bash / pwsh 遇到这个码显示「终端 npm test · 已停止」（T130 的 `stopped` 结局）。Windows 上被强杀的进程是 exit 1、没有信号，但因为走的是 `ABORTED`，不会被读成「退出码 1」。DSH 在这条路径上不返回已产生的输出，可以把最后一次实时尾部留作展开体（可选）。
- **转后台**：直播时 bridge 从执行期值 `{kind:'promoted', jobId}` 得到结构化结局「已转后台 · bash-3」；历史里执行期值不落盘，只显示原始结果文本，不做文字匹配。
- **编码**：DSH 给 pwsh 固定了 UTF-8 输出（`dsh-pwsh-local/README.md:60`），渲染层不需要 1.0.x 的 OEM 代码页解码。

## 5 插件工具与未知工具

- 兜底动词不再用 `Ran`（中文「终端」）。优先级：
  1. 有 `presentation`（bridge 从工具定义的 `presentCall` 取，分片 02 §6）：图标按 `kind`（read → 读取，edit / delete / move → 编辑，search → 搜索，execute → 执行，fetch → 获取，other → 工具）；参数摘要显示 `title` 原文（插件自己的文字，照 T023 的规则不翻译）。
  2. 名字以 `mcp__` 开头：维持「调用 + server · tool」。
  3. 其余：新词条 Used tool → 工具；参数摘要沿用现有 `default:` 分支的字段探测。
- `terminal` 卡（`presentation.card === 'terminal'`）的插件命令按 shell 行处理。
- 白名单插件（P1-10）可以在 `dshToolVocabulary` 里补专门的中文词条，例如 `word_create` → 「写文档」；不补也能读。

## 6 审批卡文案（pwsh 与 Windows）

| 项 | 做法 |
|---|---|
| 标题里的工具名 | `toolDisplayName` 加一张显示名表：`pwsh` → PowerShell、`bash` → Bash。卡片读作「PowerShell — 在工作区运行命令」 |
| 风险 | `derivePermissionRisk` 把 `pwsh` 与 `bash` 同列为高风险（今天只认 bash / write / edit，`questionCardModel.ts:894-899`）；P1-6 发的 `kind: 'exec'` 本来也会判高 |
| 命令正文 | 原样等宽显示（现有 exec 详情） |
| 「本会话允许」的范围 | 显示 P1-6d 归一化后的前缀；前缀是 cmdlet（含 `-`）时加一句「PowerShell 别名（如 ls、dir、gci）按同一条命令记忆」 |
| 为什么要问（可选） | 需要 P1-6b 在请求里带原因 id（如 `askReason: 'unresolved'`）。有了就写「这条命令含变量、脚本块或调用符，无法静态判断会碰哪些文件，所以需要你确认」，缓解决策 046 说的「auto 档下 Windows 更常问」 |
| `escalate_sandbox` | 动作文案 Run with wider sandbox access → 「以更宽的沙箱权限执行」；详情一行「当前：工作区可写 → 申请：完全访问」（`read-only` 只读、`workspace-write` 工作区可写、`danger-full-access` 完全访问）；`reason` 原样显示模型写的理由（DSH 要求用用户当前的语言）；只有允许 / 拒绝；范围句写「只对这一次调用有效」。只在沙箱开关打开后出现（决策 044、045） |
| Windows 路径 | 文件卡、命令卡里的路径保留反斜杠原样；行上的短路径沿用 `shortPath`（已把反斜杠当分隔符） |

## 7 失败卡与收尾文案

- `tool_call_repetition`：现文写「同一个子代理工具调用」（`sessionFailure.ts:124-130`）。DSH 下防空转的工具族还包括 `job_*` 与 `send_message` 等（P1-8 §3.3），改成「同一个子代理或后台任务工具调用」。
- `turn_limit`：沿用 `TurnCeilingNotice`，P1-8 已确认不需要新界面。
- 目标用完轮数（`round-limit`）是目标条上的状态，不是失败卡；那一轮本身正常结束。
- DSH 的 `LlmFailure.code` 到失败卡的映射由 P1-5 定表；P1-7 只负责给新出现的码补文案。

## 8 Windows 实测清单（P1-7 的退出判据之一）

在 Windows CI（管理员、标准用户两路）上跑自动化部分；界面部分在测试版上人工核对。推送分支与出测试版都要先征得用户同意（P1-14）。

| 编号 | 场景 | 期望 |
|---|---|---|
| W1 | 模型执行 `Get-ChildItem`、`cd src; npm test`、`Set-Location C:\repo; git status` | 行显示「终端」+ 去掉前缀的摘要；展开能看到原命令与说明 |
| W2 | 输出含中文（如 `Write-Output 你好`） | 行内、展开体、后台尾部都不乱码 |
| W3 | 每秒打一行、持续 30 s 的命令，展开运行中的行 | 逐行出现；行尾时钟与「转后台」提示正确 |
| W4 | 运行中点 Stop | 行显示「已停止」，不显示「退出码 1」，不标红 |
| W5 | 超过 120 s 的命令 | 到时转后台：行结局「已转后台 · pwsh-N」，后台任务条出现该项，能停止 |
| W6 | 后台任务条「停止」一个 `npm run dev` | 任务管理器里整棵进程树消失 |
| W7 | 只装 Windows PowerShell 5.1、没有 pwsh 7 的机器 | 命令照常运行，行与卡片文案不变 |
| W8 | auto 档下执行含 `$env:`、脚本块的命令 | 出卡，标题 PowerShell，范围与原因句正确；bypass 档不出卡 |
| W9 | 「本会话允许」后再跑 `ls` / `dir` / `Get-ChildItem` | 按同一前缀放行；卡片上的别名说明正确 |
| W10 | 中文路径、带空格路径、长路径下读写文件 | 行上短路径正确，文件链接能打开 |
| W11 | 目标运行中点目标条「暂停」，当时正在跑一个 pwsh 命令 | 命令被中止，目标显示已暂停；「继续」后下一轮开始 |
| W12 | 宿主被杀（任务管理器结束 node.exe） | 后台任务条把运行项标为「引擎重启，任务已结束」，泳道标为中断 |
