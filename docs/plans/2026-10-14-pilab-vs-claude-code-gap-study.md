# 调研：同源同模型下 PiLab 与 Claude Code 的表现差距（2026-10-14）

Role: study（事实来源，非决策）。基线 main `79f81cdb`（`1.1.1-test.1`，DSH `0.1.7-rc.2`，pi-ai `0.85.1`）；对照 Claude Code `2.1.295`。抓包、本机会话统计与真实网关实测见[证据目录](../plantree/plans/dsh-rebase/evidence/quality-gap-2026-10-14/README.md)。

用户问题（2026-10-14）：同一来源、同一模型、同一档位（如 Claude Opus 5.5 high），PiLab 在智商、能力和最终代码上都不如 Claude Code。根因是提示词、工具，还是别的？怎么优化？DSH 怎么处理，有没有新版、怎么升级？缺的功能怎么补？

## 0 结论

1. **最大的根因已实测证实，而且不在客户端代码里：网关上游改写了 PiLab 的请求（§4）。**
   - 用户提供的网关、同一个 key、同一模型和档位，各发 10 次同一句极小提示：
     - PiLab 每次被计费约 39,140 token，我们实际只发了约 9,000；
     - Claude Code 发的内容是 PiLab 的 2.6 倍，每次只计 24,428 token，与发送量相符。
   - 再问模型看到了什么，经 PiLab 发出的请求被上游改写了：
     - 系统提示词换成了「You are Claude Code…」，带着别人机器上的 macOS 环境（`/Users/jordan/…`、zsh）；
     - 混进了 14 个 PiLab 执行不了的 Claude Code / Claude 桌面版工具；
     - PiLab 自己的 23 个工具被改成 `mcp__luban__query_pws12` 这种没有意义的名字；
     - PiLab 的系统提示词被降成用户消息里的一条「提醒」。
   - Claude Code 的请求原样通过。
   - 所以「同源同模型」时，模型拿到的根本不是同一个任务环境：身份冲突、环境冲突、工具名失去语义，每步还多读约 3 万 token 的无关内容。本机历史会话的计费痕迹与 issue #2、#9、GW-16 的记录都与此吻合。
2. **改写问题解决之后，客户端自身仍有差距（§2、§3）。**
   - Windows 上只有 PowerShell，Claude Code 用 Git Bash。
   - 工具说明只有 Claude Code 的四分之一；grep 只有 3 个参数；没有网页工具。
   - 项目指令措辞弱，而且排在用户消息之后；没有 git 状态，也没有模型身份。
   - 进出计划模式会改系统提示词，之前的思考块随之失效。
3. **已排除（§9）**：思考档位、输出上限（托管模型）、思考回放、`display`、`context_management`、长上下文、编辑工具形状、读文件行号、0.1.7-rc.2 的思考回放缺陷（本机网关未触发）。
   - 档位：Opus 5.5 在 Claude Code 里的默认也是 medium，两边都选 high 时完全一致。
4. **DSH（§8）**：
   - 最新的是 `0.2.1-alpha.3`（10-14），`next` 标签是 `0.2.0-rc.2`（09-29）。三个版本的提示词与工具说明几乎没变，DSH 也不分模型做适配，**升级补不上主要差距**。
   - `0.2.0-rc.2` 修了一个思考回放缺陷（本机网关目前没触发），风险低，建议升级。
   - `0.2.1-alpha` 有 5 处破坏性改动，暂不跟。
5. **建议顺序（§6、§7）**：
   - **P0 网关**：找运营方给 PiLab 一个原样透传的通道，或换上游；不要让客户端伪装成 Claude Code。
   - **T2 评测**：同网关 A/B 评测，量化剩余差距。
   - **P1 客户端快改**：提示词与项目指令、工具说明、web_fetch、grep、DSH 升 `0.2.0-rc.2`、自定义模型默认输出上限。
   - **P2**：Windows Git Bash、web_search、计划模式改为追加式。
   - **P3**：视评测结果再考虑 Claude SDK 引擎。
6. **GLM**：本机 GLM 会话直连智谱官方端点，不经这个网关，不受改写影响。它与 Claude Code 的差距只来自第 2 条里的客户端因素；思考配置（保留式思考、`reasoning_content` 回放）已经核对过，没问题。

## 1 方法

- **抓包**：PiLab 与 Claude Code 对同一个工作区（含 `CLAUDE.md` 的小 git 仓库）、同一模型 `claude-opus-5-5`、同一档位 `high` 各发一轮，请求打到本机假网关。只保留形状数据，见 [request-shapes.txt](../plantree/plans/dsh-rebase/evidence/quality-gap-2026-10-14/request-shapes.txt)。
- **本机真实会话**：6 个 DSH 会话日志，其中 3 个是 Claude Opus 5.5 经公司托管网关。只统计数字与错误类别，不读内容。
- **真实网关实测（T1）**：
  - 网关 URL 与 key 由用户在对话里单独提供，只放在测试进程的环境变量里；没有用本机任何账户信息。
  - 两边各发 10 次同一句极小提示，再各问一次「看到哪些工具 / 身份 / 环境」。
  - 测后确认临时目录里没有任何文件含该 key，临时目录已删除。
- **外部资料**：Anthropic 与智谱官方文档（访问日 2026-10-14）。
- **DSH 上游**：只读克隆 `deepseek-ai/deepseek-harness`，按 tag 定位三个版本：`0.1.7-rc.2` = `477b4f42`，`0.2.0-rc.2` = `639ed015`，`0.2.1-alpha.3` = `2fbf4359`。
- **仓库已有记录**：
  - [决策 146](../plantree/plans/dsh-rebase/decisions/146-real-gateway-followups.md)、[159](../plantree/plans/dsh-rebase/decisions/159-gw16-cache-control-temp-switch.md)：GW-16；
  - [决策 164](../plantree/plans/dsh-rebase/decisions/164-environment-context-and-shell-workdir-precheck.md)：issue #2；
  - [决策 173](../plantree/plans/dsh-rebase/decisions/173-prompt-cache-upstream-split.md)：issue #9；
  - [Claude SDK 引擎调研](2026-09-26-claude-sdk-engine-study.md)。
- **对以前判断的更正**：
  - 09-26 调研写「Claude Code 默认 `xhigh`」：对 Opus 5.5 不成立。官方文档与抓包都是 `medium`。
  - 09-26 调研写「read 不带行号」：针对的是旧的自有 runtime，DSH 的 read 带行号。
  - 决策 173 把两个上游对同一前缀计数不同（36,848 对 11,489）归为「计数口径」：本次实测说明，那多出来的部分是上游注入的内容。

## 2 请求逐项对照（客户端发出的原样，`claude-opus-5-5`，`high`）

| 项 | PiLab | Claude Code 2.1.295 | 判断 |
|---|---|---|---|
| 模型、档位、输出上限 | `claude-opus-5-5`、`high`、128000 | 同 | 一致 |
| 思考 | adaptive，`display: summarized` | adaptive，`display: omitted` | 只影响能不能看到思考，与质量无关 |
| `context_management` | 不发 | `clear_thinking_20251015`，`keep: all` | Opus 5.5 默认就保留全部思考块，等同默认 |
| beta 头 | 无 | 11 个，其中有 `mid-conversation-system`、`mid-conversation-tool-changes`、`per-turn-control` | 按名称与官方文档推断，后几个让 Claude Code 能中途改指令、增减工具而不让思考失效（§3.3），我们没有 |
| 身份 | 「You are an AI agent powered by DeepSeek Harness.」 | Claude 代理身份，外加模型名、模型 ID、知识截止 | 影响小 |
| 系统提示词 | 1 块，2,273 字符：9 段工具用法 | 3 块 5,851 字符，外加会话内 system 消息 9,030 字符：协作与输出规范、安全、记忆、环境、子代理类型、技能清单、日期 | 中 |
| 工具 | 23 个，说明合计 7,021 字符 | 22 个，说明合计 28,961 字符 | 中高，见 §3.2 |
| 项目指令（CLAUDE.md / AGENTS.md） | 排在用户消息之后，单独一条，开头是「may be relevant… Use them as guidance when applicable… They do not override …」 | 排在用户消息之前，明确要求严格遵守，优先于默认行为 | 中：直接影响是否守项目规范 |
| 仓库状态 | 无 | 当前分支、主分支、status、最近提交 | 中低 |
| 环境 | 运行时上下文（决策 164）：OS，Shell 是 `pwsh`，工作目录，用户目录，日期 | 工作目录、是否 git 仓库、平台、OS 版本；Shell 是 `bash` | Shell 的差异见 §3.1 |
| 客户端标识 | `metadata.user_id`（仿 Claude Code 格式），UA 为 `claude-cli-pilab/<版本>` | `metadata.user_id`，UA 为 `claude-cli/2.1.295`，system 首块是计费头 | 网关据此区别对待（§4） |

补充两点：

- Claude Code 现在也按模型调整自己：对 Claude 5.x 用短系统提示和精简的工具说明，默认也不再给 Todo 工具（官方 env-vars、tools-reference 文档）。所以差距**不在「我们的提示词不够长」**，而在上面这些具体的东西。
- Claude 5.x 的训练大量使用 Claude Code 自己的工具集，模型熟悉这些工具的名字、语义、结果格式和失败文案。DSH 的参数形状已经对齐（`file_path`、`old_string`、`new_string`、`replace_all`、`offset`、`limit`），但工具名（小写、`pwsh`、`subagent`、`todo_write`）、结果格式和报错文案都不同，享受不到这份熟悉度（推断）。

## 3 执行过程的差异

### 3.1 Windows 上的 shell

- **PiLab**：
  - `dsh-base` 在 win32 上只挂 `pwsh`，`dsh-bash-local` 的 README 写明只支持 POSIX。环境段直接告诉模型「这个会话没有 bash 工具」。
  - `pwsh` 的工具说明有 1,663 字符，大半在讲沙箱（受限语言模式、命名管道 EPERM）。而我们的沙箱是关的（`danger-full-access`），这些都是无关内容。
- **Claude Code**：Bash 工具跑 Git Bash，说明里直接要求 Unix 语法。
- **本机日志**：
  - shell 是用得最多的工具，共 195 次，`read` 才 75 次。
  - 非零退出 12 次，输出里有乱码字符的 11 次，PowerShell 语法错误或命令不识别 3 次。
- 模型对 bash 远比对 PowerShell 熟，Windows 用户受影响最大。

### 3.2 工具能力

| 项 | PiLab | Claude Code |
|---|---|---|
| grep | 3 个参数：`pattern`、`path`、`include`；最多 250 条 | 15 个参数：输出模式（内容 / 文件 / 计数）、前后上下文行、忽略大小写、文件类型、多行、分页 |
| 网页 | 无。`bundle/cordis.patch.yml` 关掉了 web_search / web_fetch，注释写「P1 改走公司网关」，至今没做；DSH 官方默认是开的 | WebFetch、WebSearch |
| 说明长度 | read 56、edit 59、write 42、grep 206 字符 | Read 790、Edit 360、Write 240、Grep 477 字符 |
| 读文件 | 单次 50KB，只读文本；图片走 `read_image`；不读 PDF | 还能读图片、PDF、notebook |
| 子代理 | 通用 `subagent` / `subagent_fork` | 按类型分（只读探索、规划等），可单独指定模型与档位 |

- Anthropic 官方把「工具说明写得极其详细」列为对工具调用影响最大的一条：每个工具至少 3～4 句，说清做什么、何时用与不用、参数含义和局限（define-tools 文档）。
- 缺少上下文行时，模型只能多读整个文件；没有网页工具时，查文档、查报错只能靠记忆。

### 3.3 计划模式切换会改系统提示词

- DSH 把计划模式段放在系统提示词里，进出计划模式都会改系统提示词（`dsh-plan-mode` README：从第一方顺序 500 起改变）。
- Anthropic 对 Fable 5.1、Opus 5.5、Sonnet 5.5、Haiku 5.5 新增了思考前缀校验：思考块之前的 system、tools、messages 一旦变化，之后的旧思考块就失效。
  - 2026-08-31 之后新建的账号直接报 400；老账号丢弃这些思考块，让模型重新推理（preserved-thinking 文档）。
- 所以 PiLab 从「计划」切到「执行」之后，计划阶段的思考大概率被丢掉（推断，取决于上游账号）。Claude Code 用会话内 system 消息和中途增减工具避开了这个问题。

### 3.4 审批与无人值守

- 本机 19 次工具失败中，5 次是审批无人应答超时。模型只看到报错，于是改道或放弃。
- Claude Code 的 auto 模式由分类器放行安全操作（请求里的 `safeguards`）。
- 这属于使用方式的差异：对比测试时两边要统一成全自动档。

### 3.5 长上下文（不是差距）

- PiLab 对 1M 窗口的 Claude 在 800K 时自动压缩，Claude Code 约在 967K。
- 本机 PiLab 的 Claude 会话最长约 32 万 token。上下文太长会让模型变慢、变笨，这一点对两边都成立。

## 4 网关上游改写（已实测证实）

### 4.1 实测（T1，详见证据 §3）

| | PiLab | Claude Code |
|---|---|---|
| 实际发送 | 25,050 字符 | 66,289 字符 |
| 计费提示词（10 次） | 39,138～39,144 token | 每次 24,428 token |
| 首个请求的缓存读 | 33,547 token：全新环境里就命中别人写好的前缀 | 0 |
| 模型看到的系统提示词第一句 | 「You are Claude Code, Anthropic's official CLI for Claude.」 | 它自己的 |
| 模型看到的工具 | 14 个 Claude Code / Claude 桌面版工具，外加 23 个 `mcp__luban__<动词>_<缩写><编号>`。后者就是 PiLab 的 23 个工具，按字母序改了名 | 它自己声明的 22 个 |
| 模型看到的身份与环境 | 三处身份（Claude Code、DeepSeek Harness、Opus 5.5），两套环境：注入的 macOS / zsh / `/Users/jordan/…`，和我们的 Windows / pwsh / 真实工作区 | 一致 |

### 4.2 与历史记录对得上

- **本机 Claude 会话**：
  - 同一会话两步之间，内容只多 80 字符，计费却多出约 2.4 万 token；
  - 有两个跨会话复用、长度固定的缓存前缀：10,245 与 32,766。
- **决策 173（issue #9）**：同一前缀上游 α 计 36,848、β 计 11,489；α 的思考摘要全空，还会丢弃旧思考块；α 承接了 89 个请求中的 71 个。
- **issue #2（决策 164）**：模型看到错误的 macOS 环境和一组我们没有的工具。
- **GW-16（决策 146）**：我们只发 3 个 `cache_control`，上游却报「超过 4 个」，因为注入的模板自带断点。

### 4.3 对质量的影响

1. **工具名失去语义**：`query_pws12`、`render_rea13` 这种名字，模型只能靠很短的说明去猜用途。同时眼前还摆着一套它最熟悉、却执行不了的 `Bash`、`Read`、`Edit`。
2. **身份与环境冲突**：Claude Code 的系统提示词说是 macOS + zsh + 别人的目录，PiLab 的运行时上下文说是 Windows + pwsh。issue #2 正是因此把 workdir 设错。
3. **PiLab 的指令权威性被削弱**：PiLab 的系统提示词被降成用户消息里的提醒。
4. **成本与噪声**：每个请求多约 3 万 token 的无关内容；思考摘要被改为不返回；旧思考块会被丢弃。

### 4.4 怎么处理

- **这件事要在网关 / 上游解决**：
  - 请网关运营方把 PiLab 的流量（可按 key 分组或按 UA `claude-cli-pilab/*` 识别）分到原样透传的上游，比如按 API key 计费的官方上游，或 Bedrock / Vertex；
  - 或者关掉对非 Claude Code 请求的「伪装」改写。
- **不建议客户端伪造 Claude Code 身份去绕开改写**：这等于绕过供应商的限制。从改写手法看，上游很可能在用 Claude 订阅账号转发，客户端伪装还会与 Anthropic 对订阅额度的使用条款冲突。
- 解决之前，§7 的客户端改进对经这个网关的 Claude 收益有限：工具名会被改掉，系统提示词会被降级。

## 5 根因排序

| # | 因素 | 影响面 | 置信度 | 依据 |
|---|---|---|---|---|
| 1 | 网关上游改写 PiLab 请求：换系统提示词、混入别的工具、工具改名、指令降级、丢旧思考 | 经该网关的全部 Claude 会话 | **已实测证实** | §4 |
| 2 | Windows 只有 PowerShell | Windows 用户的全部会话 | 高 | §3.1，本机日志 |
| 3 | 工具：说明薄、grep 弱、无网页工具、工具集与训练分布不同 | 全部会话 | 中高 | §2、§3.2，官方工具文档 |
| 4 | 项目指令措辞弱、位置靠后；无 git 状态与模型身份 | 有项目规范的仓库 | 中 | §2 |
| 5 | 计划模式切换使思考失效 | 用计划模式的会话 | 中（推断） | §3.3 |
| 6 | 审批超时打断 | 无人值守时 | 中（使用方式） | §3.4 |

外部参照：只改 harness、模型不变时，Terminal-Bench 这类评测的分差常见 5～15 个百分点（LangChain 固定 gpt-5.2-codex 只改 harness：52.8 → 66.5）。第 1 条的影响预计远大于这个量级，因为它连工具名和系统提示词都换掉了。

## 6 验证

### T1 网关改写探针：已完成

结果见 §4.1 与证据 §3。脚本 `scripts/t1-pilab-real-gateway.ts`、`scripts/t1-claude-code-real-gateway.sh` 可复跑，URL 和 key 只从环境变量 `T1_BASE_URL`、`T1_API_KEY` 读取。

### T2 同网关 A/B 评测：待做

- **任务**：6～10 个真实任务，最好来自你们的现场：修 bug 并补测试、跨文件的小功能、读代码回答问题、Windows 上的构建或脚本任务。
  - 每个任务固定仓库快照与提示词。
  - 验收分两层：能机判的（测试、构建、改动范围）+ LLM 评分（代码质量、守项目规范）。
- **跑法**：两个客户端都无头运行，用同一网关、同一 key、同一模型同一档位、全自动审批；每个任务每边跑 3 次。
  - PiLab 侧扩展证据目录的宿主脚本，Claude Code 侧用 `claude -p --output-format stream-json`。
- **分组**：至少两组。
  - 「改写通道」：现在的网关，量化第 1 条的损失；
  - 「透传通道」：运营方开出的通道，或官方 API key，量化剩下的客户端差距。
- **记录**：通过率、步数、各工具的调用与失败次数、计费 token、耗时、改动量、评分。
- 之后 §7 的每一项都按开关开与关各跑一遍（工程规范 §6）。

### T3 请网关运营方确认：待做

- 改写是哪一层做的（`mcp__luban__*` 的命名提示是一个叫 luban 的中转）。
- 按什么条件触发：UA、计费头，还是系统提示词。
- 能否给 PiLab 一个原样透传的分组。

## 7 优化与缺失功能补齐

所有提示词与说明文字由我们自己写。Claude Code 的提示词是 Anthropic 版权所有，不能照抄。

| 阶段 | # | 项 | 做法（DSH 接缝） | 量级 |
|---|---|---|---|---|
| P0 | 0 | 网关透传 | 运营方给 PiLab 原样透传的上游 / 分组（§4.4）；PiLab 侧只需换 key 或路由，不改代码 | 协调为主 |
| P1 | 1 | 提示词与指令包 | 新的宿主插件或 `system-prompt` 行配置：<br>• 用 `personaPrefix` 写我们自己的编码代理身份，带上模型名（DSH 身份句可保留，`includeHarnessIdentity` 按评测结果决定）；<br>• 加一段：项目指令（AGENTS.md / CLAUDE.md）是必须遵守的项目规则；<br>• 加做事方式：先读懂再改，改完用测试、类型检查、构建验证，贴合周边代码风格，最小改动，结论附 `文件:行`。<br>静态文本，不破坏缓存 | 2～3 人日 + 评测 |
| P1 | 2 | 仓库状态快照 | 会话第一轮把分支、主分支、status、最近 5 条提交写进运行时上下文；只写一次，避免每步追加 | 1 人日 |
| P1 | 3 | 工具说明扩写 | 在 `system-prompt/assemble` 瀑布里按工具名替换说明（read、edit、write、grep、glob、pwsh、subagent、todo_write），写清何时用、不用、限制、失败后怎么办；沙箱关闭时去掉 pwsh 说明里的沙箱段 | 2 人日 |
| P1 | 4 | web_fetch | 打开 `web`（`fetchProvider: http`）、`web-fetch-http`、`tool-web`（`search: false`）；权限归为网络访问、按档位审批；补工具行文案 | 2～3 人日 |
| P1 | 5 | grep 增强 | 写自有的同名工具插件（基于已有依赖 `@vscode/ripgrep`），补输出模式、上下文行、忽略大小写、类型、分页 | 2～3 人日 |
| P1 | 6 | DSH 升到 `0.2.0-rc.2` | 见 §8.3 | 1～2 人日 + CI |
| P1 | 7 | 自定义模型的默认输出上限 | 没声明 `maxTokens` 的模型现在回落到 8,192（`src/shared/dshModelPlan/tables.ts` 的 `DEFAULT_MAX_TOKENS`），思考与正文共用，长文件容易被截断。可以按协议给更高的默认值，或在添加服务时提示填写。托管目录声明了 128000，不受影响 | 0.5 人日 |
| P2 | 8 | Windows 上的 Git Bash | 自研 Windows bash 执行器插件（`dsh-bash-local` 不支持 Windows）；检测到 Git Bash 就挂 `bash` 工具，pwsh 保留为可选；同步改环境段、权限分析的 shell 判定，做打包与加密机验证 | 1.5～2.5 人周 |
| P2 | 9 | web_search | 自研 search provider 挂到 `ctx.web`。后端两种选法：经网关（Claude 路由可用 Anthropic 服务端的 web_search 工具，需透传通道），或接第三方搜索 API | 1 人周 |
| P2 | 10 | 计划模式不改系统提示词 | 把计划模式段改成会话内追加（需要上游支持，或用我们的插件替代），避免计划后的思考失效；先用 T2 量化 | 待评估 |
| P2 | 11 | pi-ai 流式补丁 | DSH 仓库自带 `patches/@earendil-works__pi-ai@0.85.1.patch`，但 npm 安装时不会应用。缺了它，大段工具参数（如写大文件）的流式解析是 O(n²)，会变慢。可以在宿主依赖里应用同一补丁，或随 DSH 升级换到已修的 pi-ai | 1 人日（先实测） |
| P3 | 12 | Claude SDK 引擎（视情况） | 前面都做完、T2 的透传组仍明显落后时，再按 09-26 调研给 Claude 模型加引擎（`systemPrompt: preset claude_code`）。Agent SDK 的商业条款允许用在自家产品里，但不能用 Claude Code 的品牌或 claude.ai 登录；体积与 Windows 加密机的约束见该调研。另一个更轻的选项是 DSH 的 `subagent-claude-code`（把任务一次性委派给真实的 Claude Code），但它是无人值守的单次委派，不适合当交互主引擎 | 5～7 人周 |

## 8 DSH 怎么处理、最新版本与升级

### 8.1 DSH 怎么处理

- **不分模型**：`core/system-prompt`、`core/tools`、`core/agent-loop` 里都没有针对 Claude 或 GLM 的分支；`llm-pi-ai` 只做协议兼容。
- **系统提示词极简**：身份一句，加上各工具插件注册的一两句用法，约 2.2KB、550 token。
  - 人设由部署方提供，有三种方式：`system-prompt` 行的 `personaPrefix` / `personaSuffix`、agent 作用域的 `deployment:persona-prefix`、`system-prompt/assemble` 瀑布改写段落与工具说明（设计记录 `.agents/notes/implemented/architecture/2026-07-05-prompt-variables-and-tool-guidance-ownership.md`）。
  - `dsh-base` 默认 `personaPrefix: ''`，PiLab 从没配置过；DSH 自己的 Web 标准预设也只有一句人设。
- **工具**：参数仿 Claude Code，名字是小写；Windows 只挂 pwsh；可选的 `str_replace_editor` 要手动挂。
- **注入方式**：运行时上下文与项目指令以 user 消息注入，环境信息靠 `DSH_*` 环境变量。
- **评测**：没有模型质量评测。`benchmarks/` 是性能基准；各包 README 的「Model Experience」一节只记录模型看到什么、token 与 KV 缓存的影响。
- **与 Claude Code 相关的**：
  - `subagent-claude-code`：一次性无人值守委派；
  - `0.2.1-alpha.1` 的实验性 Claude Code Mods：hooks 桥，不改模型看到的工具名。

### 8.2 版本

| 版本 | 发布 | npm 标签 | 与我们相关的变化 |
|---|---|---|---|
| `0.1.7-rc.2`（`477b4f42`） | 09-24 | — | 当前在用 |
| `0.2.0-rc.1` / `rc.2`（`639ed015`） | 09-28 / 09-29 | `next` | • 工具调度失败后可以继续；<br>• bash / pwsh 删除或移动前要核对解析后的路径；<br>• 实验性异步问答；<br>• pi-ai 升到 0.87.1；<br>• **修复**（`6ed596f7`）：响应里的模型名与请求不同（别名、网关改写）时，带签名的思考被当成普通文本回放、redacted 思考被丢弃 |
| `0.2.1-alpha.1`～`alpha.3`（`2fbf4359`） | 10-03～10-14 | `alpha` | • 新增 working_directory 工具；<br>• 子代理统一为「立即返回 id、完成后通知」（去掉 `run_in_background`、加 `cwd`），可选 Agent Preset；<br>• 删掉 invariant 导出和 `both` 工具模式；<br>• 新增 `DSH_AGENTS_HOME`；<br>• 跨协议历史修复；<br>• pi-ai 升到 1.0.2、1.1.0；<br>• 会话内系统 / 工具更新：只对 pi-ai 目录里带标志的模型生效，我们手写的路由用不上；<br>• 提示词小改：read 段补了 sed / head / tail，subagent 段加了「只剩等待时结束回合」 |

- 三个版本的系统提示词分别是 2,181、2,181、2,348 字节。read 的输出格式与上限不变：`N: 文本`、2000 行、行宽 2000、50KB。
- agent loop 仍然没有步数上限；compaction-basic 没改；压缩后会补回运行时上下文。
- 没有 CHANGELOG。有中英双语的 GitHub Release（`https://github.com/deepseek-ai/deepseek-harness/releases/tag/<tag>`），以及 `docs/upgrade-guide/v<版本>/`，写从该版本升到下一版要做什么。

### 8.3 升级建议

- **升到 `0.2.0-rc.2`：风险低，建议做。**
  - 兼容性：cordis 仍是 4.0.4；app-boot、`tools/pre-execute` 等钩子、summarize、`systemPrompt.context` / `variable`、fs 抽象接口都没变；我们补丁用到的行 id 全部还在。
  - 收益：主要是上面那个思考回放修复。本机网关目前返回的模型名与请求一致，没触发；换网关或用别名时会触发。
  - 流程按[决策 003](../plantree/plans/dsh-rebase/decisions/003-p0-closeout-enter-p1.md) 第 2 条：改 `src/dsh-host/package.json` 的版本与 `overrides` → 重跑 P0 回归（`bridge-smoke.ts`、`goal-probe.ts`、`p0-6-probe.ts`、`bridge-record --check`、Windows CI）→ 复核白名单插件 `dsh-office-tools` 的 peer → 合入。
- **`0.2.1-alpha.x` 暂不跟**，有 5 处破坏点：
  1. 委派结果改成 `{kind: 'activation'}`，而 `bridge/subagents.ts`、`jobs.ts`、loopGuard 仍按 continuable / foreground / background 解析；
  2. agent-instructions 删掉了 `dshHome`，而且静默忽略（`25f16720`），`lib/hostProfile.ts` 指向的全局 AGENTS.md 会悄悄失效；
  3. working_directory 工具能改当前目录，而我们的环境与权限上下文读的是 `header.cwd`，需要禁用这个工具或做适配（推断）；
  4. 删除了 `./invariant` 导出（`f028f256`）；
  5. 依赖 cordis `4.0.5-alpha.2` 等预发布包，`dsh-office-tools` 的 `overrides` 也要同步。
- **升级补不上主要差距**：提示词与工具说明基本没变。主要杠杆在 §4（网关）和 §7（我们自己的配置与插件）。

## 9 已排除

| 项 | 依据 |
|---|---|
| 思考档位 | Opus 5.5 在 Claude Code 里的默认是 medium（官方 model-config 文档，抓包一致）；两边都选 high 时请求相同 |
| 输出上限（托管模型） | 两边都是 128000；自定义模型的 8,192 回落见 §7 第 7 项 |
| 思考回放 | 本机日志：Claude 的思考块带签名（852～2,116 字符）原样回放；GLM 回放 `reasoning_content` |
| 0.1.7-rc.2 的思考回放缺陷 | 本机日志与 T1 中，响应模型名都与请求一致，未触发 |
| `display` | 只影响能不能看到思考；计费和签名相同（官方 thinking 文档） |
| `context_management` | Opus 5.5 默认就保留全部历史思考（官方 thinking 文档） |
| 长上下文 | Claude Code 对 1M 窗口约在 967K 压缩，比 PiLab 的 800K 更晚 |
| 编辑工具形状、读文件行号 | DSH 已经与 Claude Code 一致 |
| 压缩摘要质量 | DSH 的压缩检查点是结构化的：意图、文件、错误、待办、当前工作、下一步、关键上下文 |

## 10 待拍板

1. 由谁去找网关运营方（T3）？目标是给 PiLab 一个原样透传的分组或上游。
2. T2 的任务从哪里来？最好由你给 3～5 个现场例子。预算多少？「透传通道」用什么？
3. DSH 是否升到 `0.2.0-rc.2`？
4. P1 的各项是否都做（提示词包、git 状态、工具说明、web_fetch、grep、默认输出上限）？
5. Windows 上是否改为默认用 Git Bash（pwsh 保留）？
6. web_search 用哪个搜索后端？
